import { retry, withTimeout, type RetryOptions } from '../async/index.js';
import {
	debounce,
	memoize as memoizeFunction,
	noop,
	once as onceFunction,
	throttle,
	type DebounceOptions,
	type MemoizeCache,
	type ThrottleOptions
} from '../functions/index.js';
import { assertDelay, assertFunction, describe } from '../utils/assert.js';
import type { AnyFunction, RandomGenerator } from '../utils/index.js';

/**
 * Supported decorator flavours, detected from the arguments a decorator receives:
 *
 * - **TypeScript legacy** (`experimentalDecorators: true`): methods get `(target, key, descriptor)`, fields get `(target, key)`
 *   (TypeScript's helper passes `undefined` as a third argument).
 * - **Babel legacy** (`@babel/plugin-proposal-decorators` with `legacy: true`): like TypeScript, but fields receive a descriptor
 *   with an `initializer` function.
 * - **TC39 standard** (TypeScript 5+ without `experimentalDecorators`, Babel `2023-05`+): methods get `(value, context)` with
 *   `context.kind === 'method'`, fields get `(undefined, context)` with `context.kind === 'field'`.
 */

/**
 * A method with unknown `this` and arguments, used internally once public types have been checked.
 */
type UnknownMethod = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wraps a decorated method. Called once per decorated method (not per instance).
 */
type MethodWrapper = (method: UnknownMethod, name: string) => UnknownMethod;

/**
 * The parts of a TC39 standard decorator context used by this module.
 */
interface StandardContext {
	readonly kind: string;
	readonly name: string | symbol;
	readonly private?: boolean;
	readonly static?: boolean;
	addInitializer?(initializer: (this: unknown) => void): void;
}

/**
 * A field descriptor as passed by Babel's legacy decorators transform (it carries the field `initializer`).
 */
export interface BabelFieldDescriptor extends PropertyDescriptor {
	initializer?: (() => unknown) | null;
}

/**
 * The context of a TC39 standard decorator applied to a method of type `T` of a `This` class. Both are inferred from the decorated
 * method, so that methods declaring a `this` parameter (`m(this: C)`) are accepted, which the default `ClassMethodDecoratorContext`
 * (with `This = unknown`) rejects.
 * @template This - The class (instance or constructor) type
 * @template T - The method type
 */
export type MethodContext<This, T extends AnyFunction> = ClassMethodDecoratorContext<This, T & ((this: This, ...args: Parameters<T>) => ReturnType<T>)>;

/**
 * A method decorator usable both with TypeScript's `experimentalDecorators` (and Babel legacy) and with TC39 standard decorators.
 * Returned by the decorator factories of this module ({@link debounced}, {@link throttled}, {@link deprecated}).
 */
export interface UniversalMethodDecorator {
	<T extends AnyFunction>(target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
	<This, T extends AnyFunction>(value: T, context: MethodContext<This, T>): T;
}

/**
 * A method decorator for methods returning a promise, usable both with TypeScript's `experimentalDecorators` (and Babel legacy) and
 * with TC39 standard decorators. Returned by {@link retryable} and {@link timeout}.
 */
export interface AsyncMethodDecorator {
	<T extends (...args: never[]) => PromiseLike<unknown>>(target: object, propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
	<This, T extends (...args: never[]) => PromiseLike<unknown>>(value: T, context: MethodContext<This, T>): T;
}

/**
 * Key used by {@link debounced} and {@link throttled} for the state of calls whose `this` is not an object (detached calls).
 */
const NO_INSTANCE: object = {};

/**
 * Whether `value` looks like a TC39 standard decorator context object.
 * @param {unknown} value - The second decorator argument
 * @returns {boolean} `true` for a standard decorator context
 */
function isStandardContext(value: unknown): value is StandardContext {
	// Legacy decorators receive a property key (a string or symbol, whose `kind` is undefined) instead.
	return typeof (value as { kind?: unknown } | null | undefined)?.kind === 'string';
}

/**
 * Whether `value` is an object or a function (i.e. can own properties and be a `WeakMap` key).
 * @param {unknown} value - Any value
 * @returns {boolean} `true` for objects and functions
 */
function isObjectLike(value: unknown): value is object {
	return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Whether `value` is a class prototype (an object whose own `constructor` points back to it).
 * @param {object} value - Any object
 * @returns {boolean} `true` for prototype objects
 */
function isPrototypeObject(value: object): boolean {
	const ctor = Object.prototype.hasOwnProperty.call(value, 'constructor') ? (value as { constructor: unknown }).constructor : undefined;

	return typeof ctor === 'function' && ctor.prototype === value;
}

/**
 * Creates a method that gives each instance (each object or function `this`) its own wrapper of the original method, created on its
 * first call and garbage-collected with the instance. Calls whose `this` is not an object either call `detached` directly, without any
 * state, or, when `detached` is omitted, all share one wrapper.
 * @param {() => UnknownMethod} wrap - Creates the wrapper for a new instance
 * @param {UnknownMethod} [detached] - What calls without an instance run
 * @returns {UnknownMethod} The method dispatching to the instance's wrapper
 */
function perInstance(wrap: () => UnknownMethod, detached?: UnknownMethod): UnknownMethod {
	const wrappers = new WeakMap<object, UnknownMethod>();

	return function perInstanceMethod(this: unknown, ...args: unknown[]): unknown {
		if (detached && !isObjectLike(this)) return detached.apply(this, args);

		const owner = isObjectLike(this) ? this : NO_INSTANCE;
		let wrapped = wrappers.get(owner);

		if (wrapped === undefined) {
			wrapped = wrap();
			wrappers.set(owner, wrapped);
		}

		return wrapped.apply(this, args);
	};
}

/**
 * Finds the property descriptor that a lookup of `key` on `obj` resolves to (walking the prototype chain).
 * @param {object} obj - The object to start from
 * @param {string | symbol} key - The property key
 * @returns {PropertyDescriptor | undefined} The first descriptor found, if any
 */
function resolveDescriptor(obj: object, key: string | symbol): PropertyDescriptor | undefined {
	for (let current: object | null = obj; current !== null; current = Object.getPrototypeOf(current) as object | null) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);

		if (descriptor) return descriptor;
	}

	return undefined;
}

/**
 * Applies `wrap` to a method, whatever the decorator flavour (see the module notes).
 * @param {string} decoratorName - Name used in error messages
 * @param {MethodWrapper} wrap - Produces the replacement method
 * @param {unknown} targetOrValue - Legacy: the prototype/constructor; standard: the method
 * @param {unknown} keyOrContext - Legacy: the property key; standard: the context object
 * @param {unknown} descriptor - Legacy: the property descriptor
 * @returns {unknown} Legacy: a new descriptor; standard: the replacement method
 * @throws {TypeError} when the decorated member is not a method
 */
function decorateMethod(decoratorName: string, wrap: MethodWrapper, targetOrValue: unknown, keyOrContext: unknown, descriptor: unknown): unknown {
	if (isStandardContext(keyOrContext)) {
		if (keyOrContext.kind !== 'method' || typeof targetOrValue !== 'function') {
			throw new TypeError(`@${decoratorName} can only decorate methods, not ${kindsOf(keyOrContext.kind)}`);
		}

		return wrap(targetOrValue as UnknownMethod, String(keyOrContext.name));
	}

	const legacy = descriptor as PropertyDescriptor | undefined;

	if (legacy === undefined || typeof legacy.value !== 'function') {
		throw new TypeError(`@${decoratorName} can only decorate methods (${String(keyOrContext)} is not a method)`);
	}

	return { ...legacy, value: wrap(legacy.value as UnknownMethod, String(keyOrContext)) };
}

/**
 * Builds a {@link UniversalMethodDecorator} from a method wrapper.
 * @param {string} decoratorName - Name used in error messages
 * @param {MethodWrapper} wrap - Produces the replacement method
 * @returns {UniversalMethodDecorator} The decorator
 */
function createMethodDecorator(decoratorName: string, wrap: MethodWrapper): UniversalMethodDecorator {
	return function decorator(targetOrValue: unknown, keyOrContext: unknown, descriptor?: unknown): unknown {
		return decorateMethod(decoratorName, wrap, targetOrValue, keyOrContext, descriptor);
	} as UniversalMethodDecorator;
}

// ---------------------------------------------------------------------------------------------------------------------
// readonly
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Makes a class field write-once: the value assigned by the field initializer (or the first assignment) is kept, and the
 * instance gets an enumerable, non-writable, non-configurable own property. Later assignments throw a `TypeError` in strict mode
 * (and are silently ignored in sloppy mode). Each instance has its own value.
 *
 * - TypeScript `experimentalDecorators`: defines an accessor on the prototype whose setter, on first assignment, defines the
 *   read-only own property on the instance (before that, reading returns `undefined`). This relies on fields being initialised by
 *   assignment (`useDefineForClassFields: false`, TypeScript's default for targets below ES2022); with `[[Define]]` semantics the
 *   instance field shadows the accessor and the decorator has no effect. On a static field, the existing value is made non-writable.
 * - Babel legacy: returns the field descriptor with `writable: false`. On a method, the method becomes non-writable.
 * - TC39 standard decorators: registers an initializer that locks the own property once the field has been defined; a field still
 *   `undefined` then (no initializer, e.g. assigned in the constructor) is locked by its first assignment instead. Runtimes that
 *   run field `addInitializer` callbacks before the field is defined (pre-2023 drafts) are not supported: the field stays writable.
 *   Private (`#field`) fields are rejected.
 * @param {object | undefined} targetOrValue - Legacy: the prototype (or constructor); standard: `undefined`
 * @param {string | symbol | ClassFieldDecoratorContext} keyOrContext - Legacy: the field name; standard: the decorator context
 * @param {BabelFieldDescriptor} [descriptor] - Babel legacy: the field descriptor
 * @returns {void | BabelFieldDescriptor} Babel legacy: the read-only descriptor; otherwise nothing
 * @throws {TypeError} when applied to an accessor, a private field, or (standard) anything other than a field
 * @example
 * ```ts
 * class Config {
 *   @readonly
 *   url: string = 'https://example.com';
 * }
 * const config = new Config();
 * config.url; // => 'https://example.com'
 * config.url = 'x'; // throws TypeError (in strict mode: cannot assign to read only property 'url')
 * ```
 */
export function readonly(targetOrValue: object, keyOrContext: string | symbol, descriptor?: undefined): void;
export function readonly<D extends BabelFieldDescriptor>(targetOrValue: object, keyOrContext: string | symbol, descriptor: D): D;
export function readonly(targetOrValue: undefined, keyOrContext: ClassFieldDecoratorContext): void;
/**
 * Implementation of {@link readonly} (see the first overload for the full documentation).
 * @param {unknown} targetOrValue - Legacy: the prototype (or constructor); standard: `undefined`
 * @param {unknown} keyOrContext - Legacy: the field name; standard: the decorator context
 * @param {BabelFieldDescriptor} [descriptor] - Babel legacy: the field descriptor
 * @returns {void | BabelFieldDescriptor} Babel legacy: the read-only descriptor; otherwise nothing
 * @throws {TypeError} when applied to an unsupported member
 */
export function readonly(targetOrValue: unknown, keyOrContext: unknown, descriptor?: BabelFieldDescriptor): BabelFieldDescriptor | void {
	if (isStandardContext(keyOrContext)) {
		const context = keyOrContext;

		if (context.kind !== 'field' || context.private || typeof context.addInitializer !== 'function') {
			throw new TypeError(
				`@readonly can only decorate public fields when used as a standard decorator, not ${context.private ? 'private ' : ''}${kindsOf(context.kind)}`
			);
		}

		context.addInitializer(function lockField(this: unknown): void {
			const owner = this as Record<PropertyKey, unknown>;
			const name = context.name;
			const field = Object.getOwnPropertyDescriptor(owner, name);

			if (field === undefined) return;
			if (owner[name] !== undefined) {
				Object.defineProperty(owner, name, { writable: false, configurable: false });
				return;
			}
			// No value yet (a field without initializer, assigned in the constructor): the first assignment defines the read-only property.
			Object.defineProperty(owner, name, {
				configurable: true,
				enumerable: field.enumerable,
				get: function (): undefined {
					return undefined;
				},
				// On the object assigned to (like the legacy setter), not `owner`: an assignment through a subclass or an object inheriting
				// from `owner` must not lock `owner`.
				set: function (this: object, value: unknown): void {
					Object.defineProperty(this, name, { value, writable: false, configurable: false, enumerable: field.enumerable });
				}
			});
		});

		return;
	}

	const key = keyOrContext as string | symbol;

	if (descriptor !== undefined) {
		if (descriptor.get !== undefined || descriptor.set !== undefined) {
			throw new TypeError(`@readonly cannot decorate the accessor ${String(key)}`);
		}

		// Babel legacy field (with `initializer`) or legacy method: just make it non-writable.
		return { ...descriptor, writable: false };
	}

	const target = targetOrValue as object;
	const existing = Object.getOwnPropertyDescriptor(target, key);

	if (existing !== undefined && 'value' in existing) {
		// A static field already initialised by assignment before the decorator ran.
		Object.defineProperty(target, key, { writable: false });
		return;
	}

	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: false,
		get: noop,
		set: function (this: unknown, value: unknown): void {
			Object.defineProperty(this as object, key, { value, writable: false, enumerable: true, configurable: false });
		}
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The plural of a decorator context kind, for error messages (`'classes'`, `'getters'`, …).
 * @param {string} kind - The context kind
 * @returns {string} Its plural
 */
function kindsOf(kind: string): string {
	return kind === 'class' ? 'classes' : `${kind}s`;
}

/**
 * Logs with `console.log`, ignoring a failure: logging must not change what the method does (a value whose inspection throws).
 * @param {string} message - The message
 * @param {unknown} value - The logged value
 * @returns {void}
 */
function safeLog(message: string, value: unknown): void {
	try {
		// eslint-disable-next-line no-console
		console.log(message, value);
	} catch {
		// See above.
	}
}

/**
 * Whether a method result is a promise, from this realm or another one (but not any thenable: calling `then` can start work).
 * @param {unknown} value - The result
 * @returns {boolean} `true` for a promise
 */
function isNativePromise(value: unknown): value is Promise<unknown> {
	try {
		return (
			value instanceof Promise ||
			(typeof value === 'object' &&
				value !== null &&
				Object.prototype.toString.call(value) === '[object Promise]' &&
				typeof (value as Promise<unknown>).then === 'function')
		);
	} catch {
		// A revoked proxy, or a trap that throws.
		return false;
	}
}

/**
 * Wraps a method so that its calls and results are logged.
 * @param {UnknownMethod} method - The original method
 * @param {string} name - The method name
 * @returns {UnknownMethod} The logging method
 */
function wrapLog(method: UnknownMethod, name: string): UnknownMethod {
	return function logged(this: unknown, ...args: unknown[]): unknown {
		safeLog(`${name} method called with arguments:`, args);

		let result: unknown;

		try {
			result = method.apply(this, args);
		} catch (error) {
			safeLog(`${name} method threw:`, error);
			throw error;
		}

		// A promise is logged through a promise chained on it, which is returned: handlers attached to the original instead would mark
		// a rejection nobody handles as handled. Other thenables are left alone, since calling `then` can start their work (query builders).
		if (isNativePromise(result)) {
			return result.then(
				function (value: unknown): unknown {
					safeLog(`${name} method resolved:`, value);
					return value;
				},
				function (error: unknown): never {
					safeLog(`${name} method rejected:`, error);
					throw error;
				}
			);
		}

		safeLog(`${name} method returned:`, result);

		return result;
	};
}

/**
 * Logs every call of the decorated method with `console.log`: `"<name> method called with arguments:" args`, then
 * `"<name> method returned:" result`. When the method returns a promise, `"<name> method resolved:" value` or
 * `"<name> method rejected:" error` is logged once it settles, and a promise settling the same way is returned (so a rejection
 * nobody handles still surfaces as an unhandled rejection). Other thenables are returned untouched and logged as returned, since
 * calling their `then` could start their work. A synchronous exception is logged as `"<name> method threw:" error` and rethrown.
 * `this` is preserved.
 * Security: arguments, results and errors are logged verbatim (nothing is redacted), so do not use it on methods that receive or return
 * secrets or personal data (passwords, tokens, ...) outside development.
 * Works with TypeScript/Babel legacy decorators and with TC39 standard decorators.
 * @template T - The method type
 * @param {object | T} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {string | symbol | ClassMethodDecoratorContext} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {TypedPropertyDescriptor<T>} [descriptor] - Legacy: the method descriptor
 * @returns {TypedPropertyDescriptor<T> | T} Legacy: the new descriptor; standard: the wrapped method
 * @throws {TypeError} when applied to something other than a method
 * @example
 * ```ts
 * class Calculator {
 *   @log
 *   double(n: number): number { return n * 2; }
 * }
 * new Calculator().double(21); // => 42
 * // logs "double method called with arguments: [ 21 ]", then "double method returned: 42"
 * ```
 */
export function log<T extends AnyFunction>(targetOrValue: object, keyOrContext: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
export function log<This, T extends AnyFunction>(targetOrValue: T, keyOrContext: MethodContext<This, T>): T;
/**
 * Implementation of {@link log} (see the first overload for the full documentation).
 * @param {unknown} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {unknown} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {unknown} [descriptor] - Legacy: the method descriptor
 * @returns {unknown} Legacy: the new descriptor; standard: the wrapped method
 * @throws {TypeError} when applied to something other than a method
 */
export function log(targetOrValue: unknown, keyOrContext: unknown, descriptor?: unknown): unknown {
	return decorateMethod('log', wrapLog, targetOrValue, keyOrContext, descriptor);
}

// ---------------------------------------------------------------------------------------------------------------------
// memoize
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by the {@link memoize} decorator factory (`@memoize({ ... })`).
 */
export interface MemoizeMethodOptions {
	/** Computes the cache key from the call arguments, with the instance as `this`. Defaults to `defaultMemoizeKey` from the `functions` module. */
	readonly resolver?: (...args: never[]) => unknown;
	/**
	 * Creates the cache of an instance, on its first call (one cache per instance, never shared). Defaults to a new, unbounded `Map`.
	 * Return a bounded cache, such as `createLRUCache({ max: 100 })` from the `cache` module, to limit memory use.
	 */
	readonly createCache?: () => MemoizeCache<unknown, unknown>;
}

/**
 * Creates the method wrapper of the {@link memoize} decorator.
 * @param {MemoizeMethodOptions} options - The validated options
 * @returns {MethodWrapper} The wrapper
 */
function memoizeWrapper(options: MemoizeMethodOptions): MethodWrapper {
	const { resolver, createCache } = options;

	return function (method: UnknownMethod): UnknownMethod {
		return perInstance(function (): UnknownMethod {
			// The resolver's public type only constrains what callers may pass; it is called with the method's arguments.
			return memoizeFunction(method, { resolver: resolver as UnknownMethod | undefined, cache: createCache?.() });
		}, method);
	};
}

/**
 * Caches the results of the decorated method, separately for every instance (per class for static methods): instances never see each
 * other's results, and caches are garbage-collected with their instance. Calls without an instance (a detached call, whose `this` is
 * `undefined`, or a primitive `this`) are not cached at all. Keys are computed with `defaultMemoizeKey` from the `functions` module (see
 * its rules: plain data is compared by value, other objects by identity).
 *
 * Use it bare (`@memoize`, an unbounded `Map` per instance) or as a factory with {@link MemoizeMethodOptions}
 * (`@memoize({ resolver, createCache })`) to choose the key or bound each instance's cache.
 * Works with TypeScript/Babel legacy decorators and with TC39 standard decorators.
 * @template T - The method type
 * @param {object | T | MemoizeMethodOptions} targetOrValue - Legacy: the prototype (or constructor); standard: the method; factory: the options
 * @param {string | symbol | ClassMethodDecoratorContext} [keyOrContext] - Legacy: the method name; standard: the decorator context
 * @param {TypedPropertyDescriptor<T>} [descriptor] - Legacy: the method descriptor
 * @returns {TypedPropertyDescriptor<T> | T | UniversalMethodDecorator} Legacy: the new descriptor; standard: the wrapped method; factory: the decorator
 * @throws {TypeError} when applied to something other than a method, or (factory) when `options` is not an object or `resolver` or
 * `createCache` is not a function
 * @example
 * ```ts
 * class Calculator {
 *   calls = 0;
 *   @memoize
 *   fibonacci(n: number): number { this.calls++; return n < 2 ? n : this.fibonacci(n - 1) + this.fibonacci(n - 2); }
 * }
 * const calculator = new Calculator();
 * calculator.fibonacci(40); // => 102334155
 * calculator.calls; // => 41 // each n computed once
 * ```
 * @example
 * ```ts
 * import { createLRUCache } from 'tinkit/cache';
 * class Users {
 *   loads = 0;
 *   @memoize({ createCache: function () { return createLRUCache({ max: 2 }); } })
 *   load(id: number): string { this.loads++; return `user ${id}`; }
 * }
 * const users = new Users();
 * users.load(1); users.load(2); users.load(3); // 1 is evicted
 * users.load(1); // => 'user 1'
 * users.loads; // => 4
 * ```
 */
export function memoize<T extends AnyFunction>(targetOrValue: object, keyOrContext: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
export function memoize<This, T extends AnyFunction>(targetOrValue: T, keyOrContext: MethodContext<This, T>): T;
export function memoize(options: MemoizeMethodOptions): UniversalMethodDecorator;
/**
 * Implementation of {@link memoize} (see the first overload for the full documentation).
 * @param {unknown} targetOrValue - Legacy: the prototype (or constructor); standard: the method; factory: the options
 * @param {unknown} [keyOrContext] - Legacy: the method name; standard: the decorator context
 * @param {unknown} [descriptor] - Legacy: the method descriptor
 * @returns {unknown} Legacy: the new descriptor; standard: the wrapped method; factory: the decorator
 * @throws {TypeError} when applied to something other than a method, or when the options are invalid
 */
export function memoize(targetOrValue: unknown, keyOrContext?: unknown, descriptor?: unknown): unknown {
	// Decorators always receive a key or a context: a lone argument is the options of the factory form.
	if (keyOrContext !== undefined) return decorateMethod('memoize', (wrapMemoizeDefault ??= memoizeWrapper({})), targetOrValue, keyOrContext, descriptor);

	if (typeof targetOrValue !== 'object' || targetOrValue === null) throw new TypeError(`@memoize: \`options\` must be an object, got ${describe(targetOrValue)}`);

	const { resolver, createCache } = targetOrValue as MemoizeMethodOptions;

	if (resolver !== undefined) assertFunction('@memoize', 'options.resolver', resolver);
	if (createCache !== undefined) assertFunction('@memoize', 'options.createCache', createCache);

	return createMethodDecorator('memoize', memoizeWrapper({ resolver, createCache }));
}

/**
 * The method wrapper of the bare `@memoize` decorator, created on first use (a module-level call would defeat tree-shaking).
 */
let wrapMemoizeDefault: MethodWrapper | undefined;

// ---------------------------------------------------------------------------------------------------------------------
// bound
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Auto-binds the decorated method to its instance, so it can be passed around as a callback (`button.onclick = obj.method`).
 *
 * - Legacy decorators: the method is replaced by a lazy getter that, on first access through an instance, binds the method and caches
 *   it as a (non-enumerable, writable) own property of that instance. Accessing it through the prototype returns the unbound method,
 *   and `super.method` accesses from an overriding subclass bind without caching (so the override is not shadowed). On non-extensible
 *   (e.g. frozen) instances, a freshly bound method is returned on every access. Read through a `Proxy` (a reactive store), it is
 *   bound to the proxy, which is what the getter receives, and cached on the target through it.
 * - Standard decorators: an initializer binds the method on each new instance (unless a subclass overrides it); static methods get the
 *   lazy getter above, so a subclass inheriting one binds it to the subclass. Private methods are rejected.
 *   When combining decorators, put `@bound` first (outermost), so that it sees the final method.
 * @template T - The method type
 * @param {object | T} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {string | symbol | ClassMethodDecoratorContext} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {TypedPropertyDescriptor<T>} [descriptor] - Legacy: the method descriptor
 * @returns {TypedPropertyDescriptor<T> | void} Legacy: the accessor descriptor; standard: nothing
 * @throws {TypeError} when applied to something other than a (public) method
 * @example
 * ```ts
 * class Counter {
 *   count = 0;
 *   @bound
 *   increment(): void { this.count++; }
 * }
 * const counter = new Counter();
 * const { increment } = counter;
 * increment(); // `this` is still `counter`
 * counter.count; // => 1
 * ```
 */
export function bound<T extends AnyFunction>(targetOrValue: object, keyOrContext: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
export function bound<This, T extends AnyFunction>(targetOrValue: T, keyOrContext: MethodContext<This, T>): void;
/**
 * Implementation of {@link bound} (see the first overload for the full documentation).
 * @param {unknown} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {unknown} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {PropertyDescriptor} [descriptor] - Legacy: the method descriptor
 * @returns {PropertyDescriptor | void} Legacy: the accessor descriptor; standard: nothing
 * @throws {TypeError} when applied to something other than a (public) method
 */
export function bound(targetOrValue: unknown, keyOrContext: unknown, descriptor?: PropertyDescriptor): PropertyDescriptor | void {
	if (isStandardContext(keyOrContext)) {
		const context = keyOrContext;

		if (context.kind !== 'method' || context.private || typeof targetOrValue !== 'function' || typeof context.addInitializer !== 'function') {
			throw new TypeError(`@bound can only decorate public methods, not ${context.private ? 'private ' : ''}${kindsOf(context.kind)}`);
		}

		const method = targetOrValue as UnknownMethod;

		context.addInitializer(function bindMethod(this: unknown): void {
			const owner = this as Record<string | symbol, unknown>;

			// A static method is bound lazily, like legacy ones: binding it to the class now would give subclasses the base class.
			if (context.static) Object.defineProperty(owner, context.name, bindingAccessor(method, context.name, false));
			// Skip when a subclass overrides the method: binding ours would shadow the override.
			else if (owner[context.name] === method) {
				Object.defineProperty(owner, context.name, { value: method.bind(owner), configurable: true, writable: true, enumerable: false });
			}
		});

		return;
	}

	const key = keyOrContext as string | symbol;

	if (descriptor === undefined || typeof descriptor.value !== 'function') {
		throw new TypeError(`@bound can only decorate methods (${String(key)} is not a method)`);
	}

	return bindingAccessor(descriptor.value as UnknownMethod, key, descriptor.enumerable);
}

/**
 * Creates the accessor of a `@bound` method: a lazy getter that binds the method to the object it is read from and caches it there.
 * @param {UnknownMethod} method - The method
 * @param {string | symbol} key - The property key
 * @param {boolean | undefined} enumerable - Whether the accessor is enumerable
 * @returns {PropertyDescriptor} The accessor descriptor
 */
function bindingAccessor(method: UnknownMethod, key: string | symbol, enumerable: boolean | undefined): PropertyDescriptor {
	// Bound methods of the objects that hold the accessor themselves (a class, for a static method).
	const owners = new WeakMap<object, UnknownMethod>();

	/**
	 * Lazily binds the method to the instance it is read from.
	 * @returns {UnknownMethod} The bound (or, through a prototype, the original) method
	 */
	function get(this: unknown): UnknownMethod {
		if (!isObjectLike(this) || isPrototypeObject(this)) return method;

		// The object that holds this accessor (a class, for a static method) keeps it: an own copy would be inherited by subclasses,
		// which must bind the method to themselves.
		if (Object.getOwnPropertyDescriptor(this, key)?.get === get) {
			let ownerBound = owners.get(this);
			if (ownerBound === undefined) {
				ownerBound = method.bind(this) as UnknownMethod;
				owners.set(this, ownerBound);
			}
			return ownerBound;
		}

		const boundMethod = method.bind(this) as UnknownMethod;

		// Cache only on extensible instances that still resolve to this getter (frozen/sealed instances get a fresh bound method).
		if (Object.isExtensible(this) && resolveDescriptor(this, key)?.get === get) {
			Object.defineProperty(this, key, { value: boundMethod, configurable: true, writable: true, enumerable: false });
		}

		return boundMethod;
	}

	return {
		configurable: true,
		enumerable,
		get,
		set: function (this: unknown, value: unknown): void {
			Object.defineProperty(this as object, key, { value, configurable: true, writable: true, enumerable: true });
		}
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// debounced / throttled / deprecated
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Creates a method decorator that debounces the method with {@link debounce}, with separate timers for every instance. Calls without
 * an instance (a detached call, whose `this` is `undefined`, or a primitive `this`) all share one timer per decorated method.
 * The decorated method returns the result of the latest invocation (or `undefined`), like a debounced function.
 * @param {number} wait - The quiet period in milliseconds
 * @param {DebounceOptions} [options] - `leading`, `trailing` and `maxWait`, as for {@link debounce}
 * @returns {UniversalMethodDecorator} The decorator (legacy and standard)
 * @throws {RangeError} when `wait` or `options.maxWait` is negative, `NaN` or infinite, or when both `leading` and `trailing` are `false`
 * @throws {TypeError} when `wait` or `options.maxWait` is not a number, or when applied to something other than a method
 * @example
 * ```ts
 * import { sleep } from 'tinkit/async';
 * class Search {
 *   queries: string[] = [];
 *   @debounced(20)
 *   query(text: string): void { this.queries.push(text); }
 * }
 * const search = new Search();
 * search.query('a');
 * search.query('ab');
 * await sleep(50);
 * search.queries; // => ['ab']
 * ```
 */
export function debounced(wait: number, options?: DebounceOptions): UniversalMethodDecorator {
	// Validate eagerly, at class definition time, a copy that every instance then uses (later changes to `options` have no effect).
	const settings = copyOptions(options);
	debounce(noop, wait, settings);

	return createMethodDecorator('debounced', function (method: UnknownMethod): UnknownMethod {
		return perInstance(function (): UnknownMethod {
			return debounce(method, wait, settings);
		});
	});
}

/**
 * Creates a method decorator that throttles the method with {@link throttle}, with separate windows for every instance. Calls without
 * an instance (a detached call, whose `this` is `undefined`, or a primitive `this`) all share one window per decorated method, and so
 * may get the result of another such call.
 * The decorated method returns the result of the latest invocation (or `undefined`), like a throttled function.
 * @param {number} wait - The window length in milliseconds
 * @param {ThrottleOptions} [options] - `leading` and `trailing`, as for {@link throttle}
 * @returns {UniversalMethodDecorator} The decorator (legacy and standard)
 * @throws {RangeError} when `wait` is negative, `NaN` or infinite, or when both `leading` and `trailing` are `false`
 * @throws {TypeError} when `wait` is not a number, or when applied to something other than a method
 * @example
 * ```ts
 * import { sleep } from 'tinkit/async';
 * class Tracker {
 *   positions: number[] = [];
 *   @throttled(20, { trailing: true })
 *   onScroll(y: number): void { this.positions.push(y); }
 * }
 * const tracker = new Tracker();
 * tracker.onScroll(1); // leading edge: runs now
 * tracker.onScroll(2);
 * tracker.onScroll(3);
 * tracker.positions; // => [1]
 * await sleep(50);
 * tracker.positions; // => [1, 3] // trailing edge: runs with the latest arguments
 * ```
 */
export function throttled(wait: number, options?: ThrottleOptions): UniversalMethodDecorator {
	// Validate eagerly, at class definition time, a copy that every instance then uses (later changes to `options` have no effect).
	const settings = copyOptions(options);
	throttle(noop, wait, settings);

	return createMethodDecorator('throttled', function (method: UnknownMethod): UnknownMethod {
		return perInstance(function (): UnknownMethod {
			return throttle(method, wait, settings);
		});
	});
}

/**
 * A shallow copy of a decorator's options object, taken when the decorator is created (anything else is passed on unchanged, for the
 * wrapped helper to validate).
 * @template O - The options type
 * @param {O} options - The options
 * @returns {O} The copy
 */
function copyOptions<O>(options: O): O {
	if (typeof options !== 'object' || options === null) return options;

	// Every enumerable key, inherited ones included: the wrapped helpers read options by plain property access.
	const copy: Record<string, unknown> = {};

	for (const key in options) copy[key] = (options as Record<string, unknown>)[key];

	return copy as O;
}

/**
 * Creates a method decorator that emits a deprecation warning with `console.warn` the first time the method is called
 * (once per decorated method, not once per call or per instance). `this` is preserved.
 * @param {string} [message] - The warning; defaults to `"<name> is deprecated."`
 * @returns {UniversalMethodDecorator} The decorator (legacy and standard)
 * @throws {TypeError} when applied to something other than a method
 * @example
 * ```ts
 * class Client {
 *   list(): string[] { return ['a', 'b']; }
 *   @deprecated('Client.fetchAll is deprecated, use Client.list instead.')
 *   fetchAll(): string[] { return this.list(); }
 * }
 * const client = new Client();
 * client.fetchAll(); // => ['a', 'b'] // and warns once with console.warn
 * client.fetchAll(); // => ['a', 'b'] // no second warning
 * ```
 */
export function deprecated(message?: string): UniversalMethodDecorator {
	return createMethodDecorator('deprecated', function (method: UnknownMethod, name: string): UnknownMethod {
		let warned = false;

		return function deprecatedMethod(this: unknown, ...args: unknown[]): unknown {
			if (!warned) {
				warned = true;
				// eslint-disable-next-line no-console
				console.warn(message ?? `${name} is deprecated.`);
			}

			return method.apply(this, args);
		};
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// once / retryable / timeout
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Wraps a method so that it runs at most once per instance.
 * @param {UnknownMethod} method - The original method
 * @returns {UnknownMethod} The restricted method
 */
function wrapOnce(method: UnknownMethod): UnknownMethod {
	return perInstance(function (): UnknownMethod {
		return onceFunction(method);
	}, method);
}

/**
 * Makes the decorated method run at most once per instance (per class for static methods), like `once` from the functions module:
 * later calls on the same instance return the first result (or rethrow the first error) without running the method again, and a
 * re-entrant call made by the method itself returns `undefined`. Each instance has its own state, garbage-collected with it. Calls
 * without an instance (a detached call, whose `this` is `undefined`, or a primitive `this`) are not restricted: they always run the
 * method, since there is no instance to remember the first result for (previously they all shared one state).
 * Works with TypeScript/Babel legacy decorators and with TC39 standard decorators.
 * @template T - The method type
 * @param {object | T} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {string | symbol | ClassMethodDecoratorContext} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {TypedPropertyDescriptor<T>} [descriptor] - Legacy: the method descriptor
 * @returns {TypedPropertyDescriptor<T> | T} Legacy: the new descriptor; standard: the wrapped method
 * @throws {TypeError} when applied to something other than a method
 * @example
 * ```ts
 * class Connection {
 *   opened = 0;
 *   @once
 *   connect(): number { return ++this.opened; }
 * }
 * const connection = new Connection();
 * connection.connect(); // => 1
 * connection.connect(); // => 1 // the first result, without running the method again
 * connection.opened; // => 1
 * ```
 */
export function once<T extends AnyFunction>(targetOrValue: object, keyOrContext: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
export function once<This, T extends AnyFunction>(targetOrValue: T, keyOrContext: MethodContext<This, T>): T;
/**
 * Implementation of {@link once} (see the first overload for the full documentation).
 * @param {unknown} targetOrValue - Legacy: the prototype (or constructor); standard: the method
 * @param {unknown} keyOrContext - Legacy: the method name; standard: the decorator context
 * @param {unknown} [descriptor] - Legacy: the method descriptor
 * @returns {unknown} Legacy: the new descriptor; standard: the wrapped method
 * @throws {TypeError} when applied to something other than a method
 */
export function once(targetOrValue: unknown, keyOrContext: unknown, descriptor?: unknown): unknown {
	return decorateMethod('once', wrapOnce, targetOrValue, keyOrContext, descriptor);
}

/**
 * Creates a decorator for async methods that retries failed calls with {@link retry} (exponential backoff, optional jitter,
 * `shouldRetry`, `onRetry`, `signal`). Every attempt calls the original method with the same `this` and arguments. The decorated method
 * always returns a native promise. Invalid options are reported when the method is called (as a rejection), like `retry` does.
 * @param {RetryOptions} [options] - Options forwarded to {@link retry}
 * @param {RandomGenerator} [random=Math.random] - Random source used for jitter
 * @returns {AsyncMethodDecorator} The decorator (legacy and standard)
 * @throws {TypeError} when applied to something other than a method
 * @example
 * ```ts
 * class Api {
 *   attempts = 0;
 *   @retryable({ retries: 3, delay: 10, jitter: true })
 *   async getUser(id: string): Promise<string> {
 *     this.attempts++;
 *     if (this.attempts < 3) throw new Error('flaky network');
 *     return `user ${id}`;
 *   }
 * }
 * const api = new Api();
 * await api.getUser('42'); // => 'user 42'
 * api.attempts; // => 3
 * ```
 */
export function retryable(options: RetryOptions = {}, random: RandomGenerator = Math.random): AsyncMethodDecorator {
	const snapshot: RetryOptions = copyOptions(options);

	return createMethodDecorator('retryable', function (method: UnknownMethod): UnknownMethod {
		return function retryableMethod(this: unknown, ...args: unknown[]): Promise<unknown> {
			// eslint-disable-next-line @typescript-eslint/no-this-alias -- every attempt needs the caller's `this`
			const self = this;

			return retry(
				function (): unknown {
					return method.apply(self, args);
				},
				snapshot,
				random
			);
		};
	}) as unknown as AsyncMethodDecorator;
}

/**
 * Creates a decorator for async methods that rejects with a {@link async!TimeoutError | `TimeoutError`} when the returned promise does not settle within
 * `ms` milliseconds (using {@link withTimeout}; the timer is always cleared, but the underlying operation is not cancelled).
 * A synchronous throw of the method becomes a rejection. `this` is preserved.
 * @param {number} ms - The time limit in milliseconds (`0` to `2^31 - 1`)
 * @param {string} [message] - Message of the `TimeoutError` (defaults to `Operation timed out after <ms> ms`)
 * @returns {AsyncMethodDecorator} The decorator (legacy and standard)
 * @throws {RangeError} when `ms` is negative, `NaN` or larger than `2^31 - 1`
 * @throws {TypeError} when `ms` is not a number, or when applied to something other than a method
 * @example
 * ```ts
 * class Api {
 *   @timeout(20)
 *   fetchReport(): Promise<string> { return new Promise(function () {}); }
 * }
 * await new Api().fetchReport(); // throws TimeoutError
 * ```
 */
export function timeout(ms: number, message?: string): AsyncMethodDecorator {
	assertDelay('@timeout', 'ms', ms);

	return createMethodDecorator('timeout', function (method: UnknownMethod): UnknownMethod {
		return function timeoutMethod(this: unknown, ...args: unknown[]): Promise<unknown> {
			let result: unknown;

			try {
				result = method.apply(this, args);
			} catch (error) {
				return Promise.reject(error);
			}

			return withTimeout(result, ms, message);
		};
	}) as unknown as AsyncMethodDecorator;
}
