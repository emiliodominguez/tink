import { assertFunction, describe as typeName } from '../utils/assert.js';
import type { AnyFunction, Primitive } from '../utils/index.js';

/**
 * Returns the internal `[object Tag]` string of a value (as produced by `Object.prototype.toString`).
 * @param {unknown} value - The value to inspect
 * @returns {string} The tag string, e.g. `'[object Date]'`
 */
function getTag(value: unknown): string {
	return Object.prototype.toString.call(value);
}

/**
 * Whether `value` is an object that does not inherit from this realm's `Object.prototype`: an object from another realm (iframe, `vm`
 * context) or with a `null` prototype.
 *
 * The built-in guards below run their brand check (a built-in method that throws when the receiver lacks the right internal slot) only
 * on such objects and on objects inheriting from the constructor's prototype (`value instanceof Constructor`). Unlike `instanceof`
 * alone (or `Object.prototype.toString` tags) this cannot be fooled by `Object.create(Map.prototype)`, proxies or a fake
 * `Symbol.toStringTag`, and it recognises instances from other realms as well as subclass instances. Any other object of this realm is
 * rejected without the brand check, whose exception costs microseconds; the price is that a genuine instance whose prototype was
 * swapped for an unrelated one of this realm (`Object.setPrototypeOf(new Map(), Object.prototype)`) is rejected too.
 *
 * Each guard spells the pattern out (instead of sharing a helper taking the constructor) so that V8 keeps every `instanceof` and brand
 * call monomorphic: these guards run in hot loops (deep clone/equality walks). `instanceof` throws for a revoked proxy, hence the
 * `try` in each guard.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` for objects of another realm and objects with a `null` prototype
 */
function isForeign(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !(value instanceof Object);
}

// Brand checks, called with the candidate as `this`: each throws for an object without the matching internal slot. The `source` getter
// returns '(?:)' for `RegExp.prototype` itself instead of throwing, but `isRegExp` never calls it on it (an object of this realm that does
// not inherit from itself). `has` checks the receiver before the key, so `undefined` avoids allocating a key object.
const dateGetTime = Date.prototype.getTime;
const regExpSourceGetter = (Object.getOwnPropertyDescriptor(RegExp.prototype, 'source') as PropertyDescriptor).get as (this: RegExp) => string;
const mapSizeGetter = (Object.getOwnPropertyDescriptor(Map.prototype, 'size') as PropertyDescriptor).get as (this: Map<unknown, unknown>) => number;
const setSizeGetter = (Object.getOwnPropertyDescriptor(Set.prototype, 'size') as PropertyDescriptor).get as (this: Set<unknown>) => number;
const weakMapHas = WeakMap.prototype.has as (this: WeakMap<object, unknown>, key: unknown) => boolean;
const weakSetHas = WeakSet.prototype.has as (this: WeakSet<object>, key: unknown) => boolean;

/**
 * Checks whether a value is a non-null object (`typeof value === 'object'`).
 * Functions are NOT considered objects by this guard (use {@link isFunction} for them).
 * Note: at the type level `object` also includes functions, so a narrowed `object` may still be callable in TypeScript's eyes.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-null, non-function object
 * @example
 * isObject({}); // => true
 * isObject([]); // => true
 * isObject(null); // => false
 * isObject(function () {}); // => false
 */
export function isObject(value: unknown): value is object {
	return value !== null && typeof value === 'object';
}

/**
 * Checks whether a value is an array (works across realms, uses `Array.isArray`).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an array
 * @example
 * isArray([1, 2]); // => true
 * isArray('ab'); // => false
 */
export function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/**
 * Checks whether a value is callable (functions, arrow functions, classes, async and generator functions).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a function
 * @example
 * isFunction(Math.max); // => true
 * isFunction({}); // => false
 */
export function isFunction(value: unknown): value is AnyFunction {
	return typeof value === 'function';
}

/**
 * Checks whether a value is a primitive string (boxed `String` objects are not strings here).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a string
 * @example
 * isString('hello'); // => true
 * isString(new String('hello')); // => false
 */
export function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/**
 * Checks whether a value is a primitive number. `NaN` and `±Infinity` ARE numbers for this guard
 * (use {@link isFiniteNumber} to exclude them).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a number
 * @example
 * isNumber(42); // => true
 * isNumber(NaN); // => true
 * isNumber('42'); // => false
 */
export function isNumber(value: unknown): value is number {
	return typeof value === 'number';
}

/**
 * Checks whether a value is a primitive boolean.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is `true` or `false`
 * @example
 * isBoolean(false); // => true
 * isBoolean(0); // => false
 */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

/**
 * Checks whether a value is `undefined`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is `undefined`
 * @example
 * isUndefined(undefined); // => true
 * isUndefined(null); // => false
 */
export function isUndefined(value: unknown): value is undefined {
	return value === undefined;
}

/**
 * Checks whether a value is `null`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is `null`
 * @example
 * isNull(null); // => true
 * isNull(undefined); // => false
 */
export function isNull(value: unknown): value is null {
	return value === null;
}

/**
 * Checks whether a value is a symbol.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a symbol
 * @example
 * isSymbol(Symbol.iterator); // => true
 * isSymbol('symbol'); // => false
 */
export function isSymbol(value: unknown): value is symbol {
	return typeof value === 'symbol';
}

/**
 * Checks whether a value is a bigint.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a bigint
 * @example
 * isBigInt(10n); // => true
 * isBigInt(10); // => false
 */
export function isBigInt(value: unknown): value is bigint {
	return typeof value === 'bigint';
}

/**
 * Checks whether a value is promise-like: a native `Promise` OR any thenable
 * (an object or function with a callable `then` property), which is what `await` accepts.
 * Note that the `then` property is read, so getters on it will run.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a promise or thenable
 * @example
 * isPromise(Promise.resolve(1)); // => true
 * isPromise({ then: function () {} }); // => true
 * isPromise({ then: 1 }); // => false
 */
export function isPromise(value: unknown): value is PromiseLike<unknown> {
	if (value instanceof Promise) return true;
	if (!isObject(value) && !isFunction(value)) return false;
	return typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Checks whether a value is a genuine `RegExp` (it has the internal regexp slots).
 * Uses a brand check, so regexps from other realms (iframes, `vm` contexts) and subclass instances are recognised,
 * while objects that only inherit from `RegExp.prototype`, proxies, or objects faking `Symbol.toStringTag` are rejected.
 * Non-regexps of this realm are rejected by a cheap `instanceof` test (so a regexp whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a regular expression
 * @example
 * isRegExp(/a/g); // => true
 * isRegExp('/a/'); // => false
 */
export function isRegExp(value: unknown): value is RegExp {
	try {
		return (value instanceof RegExp || isForeign(value)) && (regExpSourceGetter.call(value as RegExp), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is an `Error` (including subclasses such as `TypeError`).
 * Uses `instanceof`, falling back to `Object.prototype.toString` (`'[object Error]'`) for objects of other realms and objects with a
 * `null` prototype, so errors from other realms are recognised. Other objects of this realm are rejected by the cheap `instanceof`
 * test, like the built-in guards do (so a same-realm object faking `Symbol.toStringTag = 'Error'` is rejected, and so is a genuine
 * error whose prototype was swapped for an unrelated one). There is no brand-check method for errors, so a cross-realm or
 * null-prototype object faking `Symbol.toStringTag = 'Error'` passes the fallback.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an error
 * @example
 * isError(new TypeError('x')); // => true
 * isError({ message: 'x' }); // => false
 * isError({ [Symbol.toStringTag]: 'Error' }); // => false
 */
export function isError(value: unknown): value is Error {
	return value instanceof Error || (isForeign(value) && getTag(value) === '[object Error]');
}

/**
 * Checks whether a value is a `Date` instance. It does NOT check validity: `new Date('nope')` is still a `Date`
 * (check `Number.isNaN(date.getTime())` for that).
 * Uses a brand check: cross-realm dates and subclass instances are recognised; objects that merely inherit from
 * `Date.prototype` (whose methods would throw) and proxies are rejected. Non-dates of this realm are rejected by a cheap `instanceof`
 * test (so a date whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a Date
 * @example
 * isDate(new Date()); // => true
 * isDate(new Date('invalid')); // => true
 * isDate(Date.now()); // => false
 */
export function isDate(value: unknown): value is Date {
	try {
		return (value instanceof Date || isForeign(value)) && (dateGetTime.call(value as Date), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is a genuine `Map` (brand check: cross-realm and subclass instances pass; objects that merely
 * inherit from `Map.prototype`, and proxies, fail).
 * Non-instances of this realm are rejected by a cheap `instanceof` test (so an instance whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a Map
 * @example
 * isMap(new Map()); // => true
 * isMap(new WeakMap()); // => false
 */
export function isMap(value: unknown): value is Map<unknown, unknown> {
	try {
		return (value instanceof Map || isForeign(value)) && (mapSizeGetter.call(value as Map<unknown, unknown>), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is a genuine `Set` (brand check: cross-realm and subclass instances pass; objects that merely
 * inherit from `Set.prototype`, and proxies, fail).
 * Non-instances of this realm are rejected by a cheap `instanceof` test (so an instance whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a Set
 * @example
 * isSet(new Set()); // => true
 * isSet([]); // => false
 */
export function isSet(value: unknown): value is Set<unknown> {
	try {
		return (value instanceof Set || isForeign(value)) && (setSizeGetter.call(value as Set<unknown>), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is a genuine `WeakMap` (brand check: cross-realm and subclass instances pass; objects that
 * merely inherit from `WeakMap.prototype`, and proxies, fail).
 * Non-instances of this realm are rejected by a cheap `instanceof` test (so an instance whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a WeakMap
 * @example
 * isWeakMap(new WeakMap()); // => true
 * isWeakMap(new Map()); // => false
 */
export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
	try {
		return (value instanceof WeakMap || isForeign(value)) && (weakMapHas.call(value as WeakMap<object, unknown>, undefined), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is a genuine `WeakSet` (brand check: cross-realm and subclass instances pass; objects that
 * merely inherit from `WeakSet.prototype`, and proxies, fail).
 * Non-instances of this realm are rejected by a cheap `instanceof` test (so an instance whose prototype was swapped for an unrelated one is too).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a WeakSet
 * @example
 * isWeakSet(new WeakSet()); // => true
 * isWeakSet(new Set()); // => false
 */
export function isWeakSet(value: unknown): value is WeakSet<object> {
	try {
		return (value instanceof WeakSet || isForeign(value)) && (weakSetHas.call(value as WeakSet<object>, undefined), true);
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is `null` or `undefined`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is nullish
 * @example
 * isNil(null); // => true
 * isNil(undefined); // => true
 * isNil(0); // => false
 */
export function isNil(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

/**
 * Checks whether a value is neither `null` nor `undefined`, narrowing `T` to `NonNullable<T>`.
 * Handy as an array filter: `list.filter(isDefined)`.
 * @template T - The type of the value
 * @param {T} value - The value to check
 * @returns {boolean} Whether the value is not nullish
 * @example
 * [1, null, 2, undefined].filter(isDefined); // => [1, 2] // typed as number[]
 */
export function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== null && value !== undefined;
}

/**
 * Checks whether a value is a plain object: an object whose prototype is exactly `Object.prototype` or `null`
 * (object literals, `Object.create(null)`, `JSON.parse` output). Arrays, class instances, dates, maps, etc. are not plain.
 * Plain objects coming from another realm have a different `Object.prototype` and are therefore NOT considered plain.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a plain object
 * @example
 * isPlainObject({ a: 1 }); // => true
 * isPlainObject(Object.create(null)); // => true
 * isPlainObject(new Date()); // => false
 * isPlainObject([]); // => false
 */
export function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
	if (!isObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

/**
 * Checks whether a value is a primitive (`string`, `number`, `bigint`, `boolean`, `symbol`, `null` or `undefined`).
 * Equivalent to `!(isObject(value) || isFunction(value))`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a primitive
 * @example
 * isPrimitive('a'); // => true
 * isPrimitive(null); // => true
 * isPrimitive({}); // => false
 */
export function isPrimitive(value: unknown): value is Primitive {
	return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * Checks whether a value implements the iterable protocol (`value[Symbol.iterator]` is a function).
 * Primitive strings ARE iterable.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is iterable
 * @example
 * isIterable([1]); // => true
 * isIterable('abc'); // => true
 * isIterable(new Map()); // => true
 * isIterable({}); // => false
 */
export function isIterable(value: unknown): value is Iterable<unknown> {
	return value != null && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/**
 * Checks whether a value implements the async iterable protocol (`value[Symbol.asyncIterator]` is a function).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is async iterable
 * @example
 * isAsyncIterable((async function* () {})()); // => true
 * isAsyncIterable([1]); // => false
 */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return value != null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/**
 * Checks whether a value is a finite number (excludes `NaN` and `±Infinity`).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a finite number
 * @example
 * isFiniteNumber(1.5); // => true
 * isFiniteNumber(Infinity); // => false
 * isFiniteNumber('1'); // => false
 */
export function isFiniteNumber(value: unknown): value is number {
	return Number.isFinite(value);
}

/**
 * Checks whether a value is an integer number (finite, no fractional part). `-0` and `1e21` count as integers.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an integer
 * @example
 * isInteger(3); // => true
 * isInteger(3.5); // => false
 * isInteger(3n); // => false // bigints are not numbers
 */
export function isInteger(value: unknown): value is number {
	return Number.isInteger(value);
}

/**
 * Any built-in typed array (the eleven `TypedArray` constructors of ES2022). `DataView` is not a typed array.
 */
export type TypedArray =
	Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

/**
 * A type-guard function, as accepted by {@link isArrayOf} and {@link isRecordOf}.
 * @template T - The type the guard narrows to
 */
export type Guard<T> = (value: unknown) => value is T;

const TYPED_ARRAY_NAMES: ReadonlySet<unknown> = new Set([
	'Int8Array',
	'Uint8Array',
	'Uint8ClampedArray',
	'Int16Array',
	'Uint16Array',
	'Int32Array',
	'Uint32Array',
	'Float32Array',
	'Float64Array',
	'BigInt64Array',
	'BigUint64Array'
]);

/**
 * `%TypedArray%.prototype[Symbol.toStringTag]` getter: returns the constructor name for genuine typed arrays (of any realm)
 * and `undefined` for everything else, without ever throwing.
 */
const typedArrayTagGetter = (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Int8Array.prototype), Symbol.toStringTag) as PropertyDescriptor).get as (
	this: unknown
) => string | undefined;

// Brand check for `ArrayBuffer` (`SharedArrayBuffer`s fail it too).
const arrayBufferByteLengthGetter = (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength') as PropertyDescriptor).get as (this: ArrayBuffer) => number;

/**
 * Builds a short, never-throwing description of an arbitrary value for error messages, which typically end up in logs: at most
 * 100 characters (longer descriptions are cut and end with `…`), primitives as literals (strings JSON-quoted, so control characters
 * are escaped) and objects by their type tag only (`[object Object]`, `[object Array]`, …). Object contents (a request body may hold
 * secrets, or megabytes of data) are never included, and no `toJSON` method runs.
 * @param {unknown} value - The value to describe
 * @returns {string} The description
 */
function describe(value: unknown): string {
	let description: string;
	try {
		description =
			typeof value === 'string'
				? JSON.stringify(value.slice(0, 100))
				: typeof value === 'bigint'
					? `${value}n`
					: typeof value === 'object' && value !== null
						? getTag(value)
						: // Symbols, functions and the other primitives.
							String(value);
	} catch {
		// A revoked proxy, or a throwing `Symbol.toStringTag` getter or `toString` method.
		description = typeof value;
	}
	if (description.length <= 100) return description;
	// Do not cut a surrogate pair in half.
	const code = description.charCodeAt(98);
	return `${description.slice(0, code >= 0xd800 && code < 0xdc00 ? 98 : 99)}…`;
}

/**
 * Checks whether a value is a primitive string with at least one UTF-16 code unit. Whitespace-only strings are
 * NOT empty (trim first if that matters).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-empty string
 * @example
 * isNonEmptyString('a'); // => true
 * isNonEmptyString(' '); // => true
 * isNonEmptyString(''); // => false
 * isNonEmptyString(new String('a')); // => false
 */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/**
 * Checks whether a (mutable) array has at least one element, narrowing it to a non-empty tuple `[T, ...T[]]` so that
 * `value[0]` is typed `T` (not `T | undefined` under `noUncheckedIndexedAccess`). `null`/`undefined` give `false`.
 * Sparse arrays count by `length`, like `Array#length`.
 * @template T - The element type
 * @param {T[] | null | undefined} value - The array to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * const list: number[] = [1, 2];
 * if (isNonEmptyArray(list)) list[0].toFixed(); // list: [number, ...number[]]
 */
export function isNonEmptyArray<T>(value: T[] | null | undefined): value is [T, ...T[]];
/**
 * Checks whether a readonly array has at least one element, narrowing it to `readonly [T, ...T[]]`.
 * @template T - The element type
 * @param {ReadonlyArray<T> | null | undefined} value - The array to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * const list: ReadonlyArray<string> = ['a'];
 * if (isNonEmptyArray(list)) list[0].toUpperCase(); // list: readonly [string, ...string[]]
 */
export function isNonEmptyArray<T>(value: ReadonlyArray<T> | null | undefined): value is readonly [T, ...T[]];
/**
 * Checks whether an unknown value is an array with at least one element, narrowing it to `[unknown, ...unknown[]]`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * isNonEmptyArray([1]); // => true
 * isNonEmptyArray([]); // => false
 * isNonEmptyArray('a'); // => false
 */
export function isNonEmptyArray(value: unknown): value is [unknown, ...unknown[]];
/**
 * Checks whether a value is an array with at least one element (implementation of the overloads above).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * isNonEmptyArray([0]); // => true
 */
export function isNonEmptyArray(value: unknown): value is [unknown, ...unknown[]] {
	return Array.isArray(value) && value.length > 0;
}

/**
 * Checks whether `key` is an OWN property key of `object` (string, number or symbol; enumerable or not), narrowing
 * `key` to `keyof T`. Inherited keys such as `'toString'` or `'__proto__'` are rejected, which makes it safe to use
 * before indexing with untrusted keys.
 * @template T - The object type
 * @param {T} object - The object whose keys are checked
 * @param {unknown} key - The candidate key
 * @returns {boolean} Whether `key` is an own key of `object`
 * @throws {TypeError} when `object` is `null` or `undefined`
 * @example
 * const colors = { red: '#f00', blue: '#00f' };
 * isKeyOf(colors, 'red'); // => true // narrows the key to 'red' | 'blue'
 * isKeyOf(colors, 'toString'); // => false // inherited
 * isKeyOf(colors, 42); // => false
 */
export function isKeyOf<T extends object>(object: T, key: unknown): key is keyof T {
	if (object === null || object === undefined) throw new TypeError(`isKeyOf: \`object\` must not be null or undefined, got ${object}`);
	if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'symbol') return false;

	return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Creates a guard that checks membership in a fixed list of values (compared with SameValueZero, like `Array#includes`,
 * so `NaN` matches `NaN` and `0` matches `-0`), narrowing to the union of the list's element types. Pass the list
 * as a literal (or `as const`) to get literal types. The list is copied, so later mutations do not affect the guard.
 * @template T - The readonly tuple of allowed values
 * @param {T} values - The allowed values
 * @returns {(value: unknown) => boolean} A guard narrowing to `T[number]`
 * @throws {TypeError} when `values` is not an array
 * @example
 * const isDirection = isOneOf(['up', 'down']);
 * isDirection('up'); // => true // narrows to 'up' | 'down'
 * isDirection('left'); // => false
 */
export function isOneOf<const T extends ReadonlyArray<unknown>>(values: T): (value: unknown) => value is T[number] {
	if (!Array.isArray(values)) throw new TypeError(`isOneOf: \`values\` must be an array, got ${typeName(values)}`);

	const allowed = new Set<unknown>(values);

	return explainable(
		function isOneOfValues(value: unknown): value is T[number] {
			return allowed.has(value);
		},
		function explainOneOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (allowed.has(value)) return true;

			issues.push({ message: `Expected one of ${values.length} allowed values (got ${typeName(value)})`, path: path.slice() });

			return false;
		}
	);
}

/**
 * Creates a guard that checks `value instanceof constructor` (so it honours `Symbol.hasInstance` and the prototype
 * chain; it does not recognise instances from other realms).
 * @template T - The instance type
 * @param {abstract new (...args: never[]) => T} constructor - The class (or constructor function) to check against
 * @returns {(value: unknown) => boolean} A guard narrowing to `T`
 * @throws {TypeError} when `constructor` cannot be used as the right-hand side of `instanceof`
 * @example
 * class User {}
 * const isUser = isInstanceOf(User);
 * isUser(new User()); // => true
 * isUser({}); // => false
 */
export function isInstanceOf<T>(constructor: abstract new (...args: never[]) => T): (value: unknown) => value is T {
	assertFunction('isInstanceOf', 'constructor', constructor);
	try {
		// Arrow functions and methods have no `prototype` object, which makes every `instanceof` against them throw.
		void ({} instanceof constructor);
	} catch {
		throw new TypeError('isInstanceOf: `constructor` must be a valid instanceof target, got a function without a prototype');
	}

	return function isInstance(value: unknown): value is T {
		return value instanceof constructor;
	};
}

/**
 * Creates a guard that checks that a value is an array whose every element passes `guard`. Every index from `0` to
 * `length - 1` is checked, so the holes of a sparse array are tested as `undefined` (unlike `Array#every`, which skips
 * them). The element guard is called with the element only.
 * @template T - The element type
 * @param {Guard<T>} guard - The element guard
 * @returns {(value: unknown) => boolean} A guard narrowing to `T[]`
 * @throws {TypeError} when `guard` is not a function
 * @example
 * const isStringArray = isArrayOf(isString);
 * isStringArray(['a', 'b']); // => true
 * isStringArray(['a', 1]); // => false
 * isStringArray([]); // => true
 */
export function isArrayOf<T>(guard: Guard<T>): (value: unknown) => value is T[] {
	assertFunction('isArrayOf', 'guard', guard);

	return explainable(
		function isArrayOfGuarded(value: unknown): value is T[] {
			if (!Array.isArray(value)) return false;

			for (let index = 0; index < value.length; index++) {
				if (!guard(value[index])) return false;
			}

			return true;
		},
		function explainArrayOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!Array.isArray(value)) {
				issues.push({ message: `Expected an array (got ${typeName(value)})`, path: path.slice() });

				return false;
			}

			let passed = true;

			for (let index = 0; index < value.length; index++) passed = collectChild(guard, value[index], index, path, issues) && passed;

			return passed;
		}
	);
}

/**
 * Creates a guard that checks that a value is a plain object (see {@link isPlainObject}) whose own enumerable
 * property values (string AND symbol keys) all pass `guard`. Property values are read, so getters run.
 * The element guard is called with the value only.
 * @template T - The value type
 * @param {Guard<T>} guard - The value guard
 * @returns {(value: unknown) => boolean} A guard narrowing to `Record<PropertyKey, T>`
 * @throws {TypeError} when `guard` is not a function
 * @example
 * const isScores = isRecordOf(isFiniteNumber);
 * isScores({ alice: 3, bob: 5 }); // => true
 * isScores({ alice: '3' }); // => false
 * isScores(new Map()); // => false // not a plain object
 */
export function isRecordOf<T>(guard: Guard<T>): (value: unknown) => value is Record<PropertyKey, T> {
	assertFunction('isRecordOf', 'guard', guard);

	return explainable(
		function isRecordOfGuarded(value: unknown): value is Record<PropertyKey, T> {
			if (!isPlainObject(value)) return false;

			const keys: PropertyKey[] = [...Object.keys(value), ...Object.getOwnPropertySymbols(value)];

			return keys.every(function (key: PropertyKey): boolean {
				return !Object.prototype.propertyIsEnumerable.call(value, key) || guard(value[key]);
			});
		},
		function explainRecordOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!isPlainObject(value)) {
				issues.push({ message: `Expected a plain object (got ${typeName(value)})`, path: path.slice() });

				return false;
			}

			let passed = true;

			for (const key of [...Object.keys(value), ...Object.getOwnPropertySymbols(value)]) {
				if (Object.prototype.propertyIsEnumerable.call(value, key)) passed = collectChild(guard, value[key], key, path, issues) && passed;
			}

			return passed;
		}
	);
}

/**
 * Checks whether a value is one of the eleven built-in typed arrays (`Uint8Array`, `Float64Array`, `BigInt64Array`…),
 * including subclasses and instances from other realms. `DataView`, `ArrayBuffer` and plain arrays are not typed arrays.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a typed array
 * @example
 * isTypedArray(new Uint8Array(2)); // => true
 * isTypedArray(new DataView(new ArrayBuffer(2))); // => false
 * isTypedArray([1, 2]); // => false
 */
export function isTypedArray(value: unknown): value is TypedArray {
	// `ArrayBuffer.isView` (true for typed arrays and data views of any realm) quickly rejects everything else.
	return ArrayBuffer.isView(value) && TYPED_ARRAY_NAMES.has(typedArrayTagGetter.call(value));
}

/**
 * Checks whether a value is a genuine `ArrayBuffer` (brand check: cross-realm instances and detached buffers pass;
 * `SharedArrayBuffer`, typed arrays and objects that merely inherit from `ArrayBuffer.prototype` fail).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an ArrayBuffer
 * @example
 * isArrayBuffer(new ArrayBuffer(8)); // => true
 * isArrayBuffer(new Uint8Array(8)); // => false
 * isArrayBuffer(new Uint8Array(8).buffer); // => true
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
	// No `instanceof` fast path: some hosts (e.g. Jest's node environment) expose another realm's `ArrayBuffer` as the global one.
	try {
		return typeof value === 'object' && value !== null && (arrayBufferByteLengthGetter.call(value as ArrayBuffer), true);
	} catch {
		return false;
	}
}

/**
 * Error thrown by {@link assert}, {@link assertDefined} and {@link assertNever}.
 * @example
 * try {
 *   assert(false, 'boom');
 * } catch (error) {
 *   error instanceof AssertionError; // => true
 * }
 */
export class AssertionError extends Error {
	/**
	 * Creates an assertion error.
	 * @param {string} [message='Assertion failed'] - The error message
	 */
	constructor(message = 'Assertion failed') {
		super(message);
		this.name = 'AssertionError';
	}
}

/**
 * Asserts that a condition is truthy; TypeScript then narrows `condition` (and anything derived from it) after the call.
 * @param {unknown} condition - The condition to check
 * @param {string} [message='Assertion failed'] - The error message
 * @returns {void}
 * @throws {AssertionError} when `condition` is falsy
 * @example
 * function divide(a: number, b: number): number {
 *   assert(b !== 0, 'Division by zero');
 *   return a / b;
 * }
 * divide(6, 3); // => 2
 * divide(1, 0); // throws AssertionError
 */
export function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) throw new AssertionError(message);
}

/**
 * Asserts that a value is neither `null` nor `undefined`, narrowing it to `NonNullable<T>` after the call.
 * @template T - The type of the value
 * @param {T} value - The value to check
 * @param {string} [message='Expected value to be defined, received <null|undefined>'] - The error message
 * @returns {void}
 * @throws {AssertionError} when `value` is `null` or `undefined`
 * @example
 * const users = new Map([['ada', { name: 'Ada' }]]);
 * const user = users.get('ada'); // { name: string } | undefined
 * assertDefined(user, 'ada is missing');
 * user.name; // => 'Ada' // user is now { name: string }
 * assertDefined(users.get('bob'), 'bob is missing'); // throws AssertionError
 */
export function assertDefined<T>(value: T, message?: string): asserts value is NonNullable<T> {
	if (value === null || value === undefined) throw new AssertionError(message ?? `Expected value to be defined, received ${String(value)}`);
}

/**
 * Marks a code path that must be unreachable, typically the `default` branch of an exhaustive `switch`: the call only
 * type-checks when `value` has been narrowed to `never`, so adding a new union member becomes a compile error.
 * At runtime (e.g. with unexpected data) it always throws. The default message is safe to log: it describes the value in at most
 * 100 characters, objects by their type tag only (`[object Object]`), so the contents of a request body never leak into it.
 * @param {never} value - The value that should be impossible
 * @param {string} [message='Unexpected value: <value>'] - The error message
 * @returns {never} Never returns
 * @throws {AssertionError} always
 * @example
 * type Shape = { kind: 'circle'; r: number } | { kind: 'square'; size: number };
 * function area(shape: Shape): number {
 *   switch (shape.kind) {
 *     case 'circle': return Math.PI * shape.r ** 2;
 *     case 'square': return shape.size ** 2;
 *     default: return assertNever(shape);
 *   }
 * }
 * area({ kind: 'square', size: 3 }); // => 9
 * area(JSON.parse('{ "kind": "triangle" }')); // throws AssertionError (data the types did not anticipate)
 */
export function assertNever(value: never, message?: string): never {
	throw new AssertionError(message ?? `Unexpected value: ${describe(value)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema combinators, issue reporting and Standard Schema interop
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The type a guard narrows to: `Infer<typeof isUser>` turns a guard built with {@link isShape} into the object type it checks.
 * @template G - A guard function
 * @example
 * const isPoint = isShape({ x: isFiniteNumber, y: isFiniteNumber });
 * type Point = Infer<typeof isPoint>; // { x: number; y: number }
 */
export type Infer<G> = G extends (value: unknown) => value is infer T ? T : never;

/**
 * A validation problem found by {@link explain}: a human-readable `message` and the `path` (property keys and array indexes) of the
 * offending value, empty for the root. Compatible with Standard Schema issues.
 */
export interface SchemaIssue {
	/** What is wrong, e.g. `'Missing required property'`. */
	readonly message: string;
	/** Where it is wrong, from the root: `['users', 2, 'email']`. */
	readonly path: ReadonlyArray<PropertyKey>;
}

/**
 * The result of a Standard Schema `validate` call: the value on success, the issues on failure.
 * @template Output - The validated type
 */
export type StandardSchemaResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: ReadonlyArray<SchemaIssue> };

/**
 * The `~standard` property of a {@link StandardSchemaV1} validator.
 * @template Input - The accepted input type
 * @template Output - The validated output type
 */
export interface StandardSchemaProps<Input = unknown, Output = Input> {
	/** The Standard Schema version (always `1`). */
	readonly version: 1;
	/** The library that created the schema (`'tink'`). */
	readonly vendor: string;
	/** Validates an unknown value; never throws for invalid data. */
	readonly validate: (value: unknown) => StandardSchemaResult<Output>;
	/** Type-only carrier of the input and output types (always `undefined` at runtime). */
	readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/**
 * A validator implementing the [Standard Schema](https://standardschema.dev) v1 interface, accepted by tRPC, TanStack Form,
 * React Hook Form, Hono, Elysia and every other library that speaks Standard Schema. Declared structurally, so no
 * dependency on `@standard-schema/spec` is needed.
 * @template Input - The accepted input type
 * @template Output - The validated output type
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	/** The Standard Schema properties. */
	readonly '~standard': StandardSchemaProps<Input, Output>;
}

/**
 * Error thrown by {@link ensure}: an {@link AssertionError} carrying every {@link SchemaIssue} found.
 * @example
 * try {
 *   ensure(isShape({ id: isInteger }), { id: 'x' });
 * } catch (error) {
 *   error instanceof ValidationError; // => true
 *   (error as ValidationError).issues[0].path; // => ['id']
 * }
 */
export class ValidationError extends AssertionError {
	/** Every problem found, in traversal order. */
	readonly issues: ReadonlyArray<SchemaIssue>;

	/**
	 * Creates a validation error.
	 * @param {ReadonlyArray<SchemaIssue>} issues - The problems found (at least one)
	 */
	constructor(issues: ReadonlyArray<SchemaIssue>) {
		super(
			issues
				.map(function (issue: SchemaIssue): string {
					return issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`;
				})
				.join('; ')
		);
		this.name = 'ValidationError';
		this.issues = issues;
	}
}

/**
 * Collects the issues of `value` against a guard, pushing them into `issues`, and returns whether it passed.
 */
type Explainer = (value: unknown, path: PropertyKey[], issues: SchemaIssue[]) => boolean;

// Guards built by the combinators of this module know how to describe their failures (with paths). Any other guard is a black box
// reported as a single issue at its path. Lookups only happen in `explain`; the guards themselves never touch this map.
const explainers = new WeakMap<AnyFunction, Explainer>();

/**
 * Registers how a combinator-built guard reports its failures.
 * @template G - The guard type
 * @param {G} guard - The guard
 * @param {Explainer} explainer - Its issue collector
 * @returns {G} The guard itself
 */
function explainable<G extends AnyFunction>(guard: G, explainer: Explainer): G {
	explainers.set(guard, explainer);

	return guard;
}

/**
 * Runs `guard` on `value` in reporting mode.
 * @param {Guard<unknown>} guard - The guard
 * @param {unknown} value - The value to check
 * @param {PropertyKey[]} path - The path of `value` (reused: copied when an issue is recorded)
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {boolean} Whether `value` passed
 */
function collect(guard: Guard<unknown>, value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
	const explainer = explainers.get(guard);

	if (explainer !== undefined) return explainer(value, path, issues);
	if (guard(value)) return true;

	issues.push({ message: `Invalid value (got ${typeName(value)})`, path: path.slice() });

	return false;
}

/**
 * Checks `value[key]` in reporting mode, extending the path for the duration of the call.
 * @param {Guard<unknown>} guard - The guard for the child
 * @param {unknown} value - The child value
 * @param {PropertyKey} key - The child's key or index
 * @param {PropertyKey[]} path - The parent path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {boolean} Whether the child passed
 */
function collectChild(guard: Guard<unknown>, value: unknown, key: PropertyKey, path: PropertyKey[], issues: SchemaIssue[]): boolean {
	path.push(key);
	const passed = collect(guard, value, path, issues);
	path.pop();

	return passed;
}

/**
 * Throws a `TypeError` unless every element of `guards` is a function.
 * @param {string} caller - The public function name
 * @param {ReadonlyArray<unknown>} guards - The guards to validate
 * @returns {void}
 */
function assertGuards(caller: string, guards: ReadonlyArray<unknown>): void {
	for (let index = 0; index < guards.length; index++) assertFunction(caller, `guards[${index}]`, guards[index]);
}

/**
 * The guards of an object shape: one guard per property.
 */
export type ShapeGuards = { readonly [key: string]: Guard<unknown> };

/**
 * The object type described by a {@link ShapeGuards} map: properties whose guard accepts `undefined` become optional.
 * @template S - The shape
 */
export type ShapeType<S extends ShapeGuards> = {
	-readonly [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]>;
} & {
	-readonly [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
} extends infer O
	? { [K in keyof O]: O[K] }
	: never;

/**
 * Options of {@link isShape}.
 */
export interface IsShapeOptions {
	/** When `true`, own enumerable string keys that are not in the shape make the check fail. Defaults to `false` (extra keys allowed). */
	readonly exact?: boolean;
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Creates a guard for objects with the given property guards: the TypeScript-only, zero-dependency equivalent of `z.object()`.
 * Each guard receives the OWN property value, or `undefined` when the property is missing or only inherited (so `toString` or a
 * polluted `Object.prototype` can never satisfy a shape). Properties whose guard accepts `undefined` (see {@link isOptional}) are
 * optional in the inferred type. Arrays and `null` are rejected. The shape is copied, so later mutations do not affect the guard.
 * Combine with {@link explain}, {@link ensure} or {@link toStandardSchema} for path-aware error reports.
 * @template S - The property guards
 * @param {S} shape - A plain object mapping each property name to its guard
 * @param {IsShapeOptions} [options] - `exact` rejects unknown keys
 * @returns {(value: unknown) => boolean} A guard narrowing to {@link ShapeType}
 * @throws {TypeError} when `shape` is not a plain object of functions
 * @example
 * const isUser = isShape({ id: isInteger, name: isString, email: isOptional(isString) });
 * isUser({ id: 1, name: 'Ada' }); // => true
 * isUser({ id: '1', name: 'Ada' }); // => false
 * isUser(Object.create({ id: 1, name: 'Ada' })); // => false // inherited properties do not count
 * isShape({ id: isInteger }, { exact: true })({ id: 1, admin: true }); // => false
 */
export function isShape<S extends ShapeGuards>(shape: S, options?: IsShapeOptions): (value: unknown) => value is ShapeType<S> {
	if (!isPlainObject(shape)) throw new TypeError(`isShape: \`shape\` must be a plain object, got ${typeName(shape)}`);

	const keys = Object.keys(shape);
	const guards = keys.map(function (key: string): Guard<unknown> {
		const guard = shape[key];

		assertFunction('isShape', `shape.${key}`, guard);

		return guard;
	});
	const exact = options?.exact === true;
	const known = new Set<string>(keys);

	/**
	 * Whether `value` has a key the shape does not know.
	 * @param {object} value - The object to inspect
	 * @returns {boolean} `true` when an unknown own enumerable string key exists
	 */
	function hasUnknownKey(value: object): boolean {
		for (const key in value) if (hasOwn.call(value, key) && !known.has(key)) return true;

		return false;
	}

	return explainable(
		function isShaped(value: unknown): value is ShapeType<S> {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];

				if (!guards[index](hasOwn.call(value, key) ? (value as Record<string, unknown>)[key] : undefined)) return false;
			}

			return !exact || !hasUnknownKey(value);
		},
		function explainShape(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				issues.push({ message: `Expected an object (got ${Array.isArray(value) ? 'array' : typeName(value)})`, path: path.slice() });

				return false;
			}

			let passed = true;

			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];

				if (hasOwn.call(value, key)) {
					passed = collectChild(guards[index], (value as Record<string, unknown>)[key], key, path, issues) && passed;
				} else if (!guards[index](undefined)) {
					issues.push({ message: 'Missing required property', path: [...path, key] });
					passed = false;
				}
			}

			if (exact) {
				for (const key in value) {
					if (hasOwn.call(value, key) && !known.has(key)) {
						issues.push({ message: 'Unknown property', path: [...path, key] });
						passed = false;
					}
				}
			}

			return passed;
		}
	);
}

/**
 * Creates a guard that passes when ANY of `guards` passes, narrowing to the union of their types (`z.union()`). Guards run in order
 * and stop at the first match.
 * @template G - The member guards
 * @param {...G} guards - The member guards (at least one)
 * @returns {(value: unknown) => boolean} A guard narrowing to the union of the members' types
 * @throws {TypeError} when a member is not a function
 * @throws {RangeError} when no guard is given
 * @example
 * const isId = isUnion(isString, isInteger);
 * isId('a1'); // => true
 * isId(7); // => true
 * isId(7.5); // => false
 */
export function isUnion<const G extends ReadonlyArray<Guard<unknown>>>(...guards: G): (value: unknown) => value is Infer<G[number]> {
	if (guards.length === 0) throw new RangeError('isUnion: expected at least one guard, got 0');
	assertGuards('isUnion', guards);

	const members = guards.slice();

	return explainable(
		function isUnionMember(value: unknown): value is Infer<G[number]> {
			for (let index = 0; index < members.length; index++) if (members[index](value)) return true;

			return false;
		},
		function explainUnion(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			// Report the member that came closest (fewest issues): for discriminated unions that is the matching variant.
			let best: SchemaIssue[] | undefined;

			for (let index = 0; index < members.length; index++) {
				const attempt: SchemaIssue[] = [];

				if (collect(members[index], value, path, attempt)) return true;
				if (best === undefined || attempt.length < best.length) best = attempt;
			}

			issues.push(...(best as SchemaIssue[]));

			return false;
		}
	);
}

/**
 * Creates a guard that also accepts `undefined`; in an {@link isShape} the property becomes optional (`z.optional()`).
 * @template T - The guarded type
 * @param {Guard<T>} guard - The guard for defined values
 * @returns {(value: unknown) => boolean} A guard narrowing to `T | undefined`
 * @throws {TypeError} when `guard` is not a function
 * @example
 * isOptional(isString)(undefined); // => true
 * isOptional(isString)(null); // => false
 */
export function isOptional<T>(guard: Guard<T>): (value: unknown) => value is T | undefined {
	assertFunction('isOptional', 'guard', guard);

	return explainable(
		function isOptionalValue(value: unknown): value is T | undefined {
			return value === undefined || guard(value);
		},
		function explainOptional(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			return value === undefined || collect(guard, value, path, issues);
		}
	);
}

/**
 * Creates a guard that also accepts `null` (`z.nullable()`).
 * @template T - The guarded type
 * @param {Guard<T>} guard - The guard for non-null values
 * @returns {(value: unknown) => boolean} A guard narrowing to `T | null`
 * @throws {TypeError} when `guard` is not a function
 * @example
 * isNullable(isString)(null); // => true
 * isNullable(isString)(undefined); // => false
 */
export function isNullable<T>(guard: Guard<T>): (value: unknown) => value is T | null {
	assertFunction('isNullable', 'guard', guard);

	return explainable(
		function isNullableValue(value: unknown): value is T | null {
			return value === null || guard(value);
		},
		function explainNullable(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			return value === null || collect(guard, value, path, issues);
		}
	);
}

/**
 * Creates a guard for arrays of exactly `guards.length` elements, each checked by the guard at the same index (`z.tuple()`).
 * @template G - The element guards
 * @param {...G} guards - One guard per position
 * @returns {(value: unknown) => boolean} A guard narrowing to the tuple type
 * @throws {TypeError} when an element guard is not a function
 * @example
 * const isEntry = isTuple(isString, isFiniteNumber);
 * isEntry(['a', 1]); // => true
 * isEntry(['a', 1, 2]); // => false
 * isEntry([1, 'a']); // => false
 */
export function isTuple<const G extends ReadonlyArray<Guard<unknown>>>(...guards: G): (value: unknown) => value is { -readonly [K in keyof G]: Infer<G[K]> } {
	assertGuards('isTuple', guards);

	const elements = guards.slice();

	return explainable(
		function isTupleValue(value: unknown): value is { -readonly [K in keyof G]: Infer<G[K]> } {
			if (!Array.isArray(value) || value.length !== elements.length) return false;

			for (let index = 0; index < elements.length; index++) if (!elements[index](value[index])) return false;

			return true;
		},
		function explainTuple(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!Array.isArray(value) || value.length !== elements.length) {
				const got = Array.isArray(value) ? `${value.length} elements` : typeName(value);

				issues.push({ message: `Expected a tuple of ${elements.length} elements (got ${got})`, path: path.slice() });

				return false;
			}

			let passed = true;

			for (let index = 0; index < elements.length; index++) passed = collectChild(elements[index], value[index], index, path, issues) && passed;

			return passed;
		}
	);
}

/**
 * Wraps a guard so that {@link explain} (and {@link ensure}, {@link toStandardSchema}) reports `message` instead of the inner issues
 * when it fails. The returned guard behaves exactly like `guard`.
 * @template T - The guarded type
 * @param {Guard<T>} guard - The guard to label
 * @param {string | ((value: unknown) => string)} message - The message, or a function building it from the rejected value
 * @returns {(value: unknown) => boolean} The labelled guard
 * @throws {TypeError} when `guard` is not a function, or `message` is neither a string nor a function
 * @example
 * const isAge = withMessage(isInteger, 'Age must be a whole number');
 * explain(isShape({ age: isAge }), { age: 1.5 }); // => [{ message: 'Age must be a whole number', path: ['age'] }]
 */
export function withMessage<T>(guard: Guard<T>, message: string | ((value: unknown) => string)): (value: unknown) => value is T {
	assertFunction('withMessage', 'guard', guard);
	if (typeof message !== 'string' && typeof message !== 'function') {
		throw new TypeError(`withMessage: \`message\` must be a string or a function, got ${typeName(message)}`);
	}

	return explainable(
		function isLabelled(value: unknown): value is T {
			return guard(value);
		},
		function explainLabelled(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (guard(value)) return true;

			issues.push({ message: typeof message === 'string' ? message : String(message(value)), path: path.slice() });

			return false;
		}
	);
}

/**
 * Lists why `value` fails `guard`, with the path of every offending value; an empty array means it passes. Guards built with
 * {@link isShape}, {@link isArrayOf}, {@link isRecordOf}, {@link isTuple}, {@link isUnion}, {@link isOptional}, {@link isNullable},
 * {@link isOneOf} and {@link withMessage} report precise nested issues; any other guard is reported as one issue at its path.
 * @param {Guard<unknown>} guard - The guard to check against
 * @param {unknown} value - The value to check
 * @returns {SchemaIssue[]} The issues, in traversal order (empty when `value` passes)
 * @throws {TypeError} when `guard` is not a function
 * @example
 * const isUser = isShape({ id: isInteger, tags: isArrayOf(isString) });
 * explain(isUser, { id: 1, tags: ['a'] }); // => []
 * explain(isUser, { tags: ['a', 2] }); // => [{ message: 'Missing required property', path: ['id'] }, { message: 'Invalid value (got number)', path: ['tags', 1] }]
 */
export function explain(guard: Guard<unknown>, value: unknown): SchemaIssue[] {
	assertFunction('explain', 'guard', guard);

	const issues: SchemaIssue[] = [];

	// Guards never consult the explainers, so valid values take the fast path and allocate nothing beyond the result.
	if (!guard(value)) collect(guard, value, [], issues);

	return issues;
}

/**
 * Returns `value` typed as `T` when it passes `guard`, and throws a {@link ValidationError} listing every issue otherwise. The
 * one-liner for parsing untrusted JSON, environment variables or API responses.
 * @template T - The guarded type
 * @param {Guard<T>} guard - The guard to check against
 * @param {unknown} value - The value to check
 * @returns {T} `value`, narrowed
 * @throws {ValidationError} when `value` fails `guard`
 * @throws {TypeError} when `guard` is not a function
 * @example
 * const config = ensure(isShape({ port: isInteger }), JSON.parse('{"port":8080}'));
 * config.port; // => 8080
 * ensure(isShape({ port: isInteger }), { port: '80' }); // throws ValidationError
 */
export function ensure<T>(guard: Guard<T>, value: unknown): T {
	const issues = explain(guard, value);

	if (issues.length > 0) throw new ValidationError(issues);

	return value as T;
}

/**
 * Turns any guard into a [Standard Schema](https://standardschema.dev) v1 validator, so the guards of this module plug straight into
 * tRPC, TanStack Form, React Hook Form, Hono, Elysia and the rest of the ecosystem (issues carry paths, see {@link explain}).
 * Validation is synchronous and never throws for invalid data.
 * @template T - The guarded type
 * @param {Guard<T>} guard - The guard to adapt
 * @returns {StandardSchemaV1<unknown, T>} A Standard Schema validator
 * @throws {TypeError} when `guard` is not a function
 * @example
 * const schema = toStandardSchema(isShape({ email: isString }));
 * schema['~standard'].validate({ email: 'ada@example.com' }); // => { value: { email: 'ada@example.com' } }
 * schema['~standard'].validate({}); // => { issues: [{ message: 'Missing required property', path: ['email'] }] }
 */
export function toStandardSchema<T>(guard: Guard<T>): StandardSchemaV1<unknown, T> {
	assertFunction('toStandardSchema', 'guard', guard);

	return {
		'~standard': {
			version: 1,
			vendor: 'tink',
			validate: function validate(value: unknown): StandardSchemaResult<T> {
				const issues = explain(guard, value);

				return issues.length === 0 ? { value: value as T } : { issues };
			}
		}
	};
}
