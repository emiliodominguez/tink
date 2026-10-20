import { assertFunction, assertInteger, assertNumber, describe, MAX_TIMEOUT } from '../utils/assert.js';
import { AssertionError, isDate, isMatching, isPlainObject, type PatternType } from '../guards/index.js';
import type { AnyFunction, Primitive } from '../utils/index.js';

/**
 * A function whose `this` and arguments are all `unknown`. Used internally to invoke user callbacks after their public types have been checked.
 */
type UnknownFunction = (this: unknown, ...args: unknown[]) => unknown;

/**
 * A timer handle as returned by the host's `setTimeout`. Kept internal so that Node timer types never leak into public signatures.
 */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Starts a timer, clamping `delay` to `MAX_TIMEOUT` (hosts fire larger delays after ~1 ms). Callers must re-check the elapsed time when it fires.
 * @param {() => void} callback - The timer callback
 * @param {number} delay - The requested delay in milliseconds
 * @returns {TimerHandle} The timer handle
 */
function startTimer(callback: () => void, delay: number): TimerHandle {
	return setTimeout(callback, Math.min(delay, MAX_TIMEOUT));
}

/**
 * Strings that the default memoize key serialiser uses as markers for values JSON cannot represent (bigints, `NaN`, `±Infinity`,
 * `-0`, `undefined`, dates and the identity of other objects), optionally preceded by backslashes. Real strings of this shape get one
 * extra leading backslash.
 */
const SPECIAL_KEY_TOKEN = /^\\*(?:-?\d+n|NaN|-?Infinity|-0|undefined|#\d+|Date\((?:-?\d+|NaN)\))$/;

/**
 * The identity numbers of the functions, symbols and non-plain objects met by the default memoize key (see {@link defaultMemoizeKey}).
 * Weak, so they never keep a value alive. Symbols that cannot be weak keys (registered ones, or every symbol on engines older than
 * ES2023) go to {@link SYMBOL_IDENTITIES} instead.
 */
const IDENTITIES = new WeakMap<object, number>();

/**
 * The identity numbers of the symbols that cannot be `WeakMap` keys (see {@link IDENTITIES}).
 */
const SYMBOL_IDENTITIES = new Map<unknown, number>();

/**
 * The last identity number handed out.
 */
let lastIdentity = 0;

/**
 * Throws unless `value` is a finite number `>= 0` (a wait time in milliseconds; longer waits than `setTimeout` allows are split).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {number} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is `NaN`, infinite or negative
 */
function assertWait(caller: string, name: string, value: number): void {
	assertNumber(caller, name, value, value >= 0 && value < Infinity, 'a finite number >= 0');
}

/**
 * Throws a `TypeError` unless every element of `fns` is a function.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<unknown>} fns - The values to validate
 * @returns {void}
 * @throws {TypeError} when an element is not a function
 */
function assertFunctions(caller: string, fns: ReadonlyArray<unknown>, name = 'fns'): void {
	// The parameter name is only formatted for an invalid element.
	for (let i = 0; i < fns.length; i++) if (typeof fns[i] !== 'function') assertFunction(caller, `${name}[${i}]`, fns[i]);
}

/**
 * Concatenates two argument lists into a new array (several times faster than `Array#concat` or spreading both).
 * @param {ReadonlyArray<unknown>} head - The first list
 * @param {ReadonlyArray<unknown>} tail - The second list
 * @returns {unknown[]} A new array holding the elements of `head`, then those of `tail`
 */
function append(head: ReadonlyArray<unknown>, tail: ReadonlyArray<unknown>): unknown[] {
	const all = new Array<unknown>(head.length + tail.length);

	for (let i = 0; i < all.length; i++) all[i] = i < head.length ? head[i] : tail[i - head.length];

	return all;
}

/**
 * Calls `fn` with `thisArg` and the elements of `args`. One or two arguments are passed with `call`, which V8 optimises much better
 * than `apply` (it can inline `fn` and drop the argument array).
 * @param {UnknownFunction} fn - The function to call
 * @param {unknown} thisArg - The `this` value
 * @param {unknown[]} args - The arguments (an array without holes)
 * @returns {unknown} What `fn` returns
 */
function forward(fn: UnknownFunction, thisArg: unknown, args: unknown[]): unknown {
	return args.length === 1 ? fn.call(thisArg, args[0]) : args.length === 2 ? fn.call(thisArg, args[0], args[1]) : fn.apply(thisArg, args);
}

// ---------------------------------------------------------------------------------------------------------------------
// bind / partial / curry
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Creates a function that always invokes `fn` with `thisArg` as `this`, regardless of how it is called.
 * @template T - The `this` type expected by `fn`
 * @template A - The parameter types of `fn`
 * @template R - The return type of `fn`
 * @param {(this: T, ...args: A) => R} fn - The function to bind
 * @param {T} thisArg - The value used as `this` on every call
 * @returns {(...args: A) => R} A new function forwarding its arguments to `fn` with `this` fixed to `thisArg`
 * @throws {TypeError} when `fn` is not a function
 * @example
 * const user = { name: 'Ada' };
 * function greet(this: { name: string }, greeting: string): string { return `${greeting}, ${this.name}`; }
 * bind(greet, user)('Hi'); // => 'Hi, Ada'
 */
export function bind<T, A extends unknown[], R>(fn: (this: T, ...args: A) => R, thisArg: T): (...args: A) => R {
	assertFunction('bind', 'fn', fn);

	return function bound(...args: A): R {
		return fn.apply(thisArg, args);
	};
}

/**
 * Creates a function that invokes `fn` with `args` prepended to the arguments it receives. `this` is forwarded.
 * @template A - The types of the pre-applied arguments
 * @template B - The types of the remaining arguments
 * @template R - The return type of `fn`
 * @param {(...args: [...A, ...B]) => R} fn - The function to partially apply
 * @param {...A} args - The leading arguments to pre-apply
 * @returns {(...rest: B) => R} A function accepting the remaining arguments
 * @throws {TypeError} when `fn` is not a function
 * @example
 * function add(a: number, b: number): number { return a + b; }
 * partial(add, 1)(2); // => 3
 */
export function partial<A extends unknown[], B extends unknown[], R>(fn: (...args: [...A, ...B]) => R, ...args: A): (...rest: B) => R {
	assertFunction('partial', 'fn', fn);

	return function partiallyApplied(this: unknown, ...rest: B): R {
		return forward(fn as unknown as UnknownFunction, this, append(args, rest)) as R;
	};
}

/**
 * Every suffix of the tuple `A` (including `A` itself and `[]`); a non-tuple array (rest parameters) contributes itself and `[]`.
 * @example
 * type S = Suffixes<[number, string]>; // [number, string] | [string] | []
 */
type Suffixes<A extends unknown[]> = A extends [unknown, ...infer Tail] ? A | Suffixes<Tail> : A | [];

/**
 * Removes as many trailing elements from `A` as `S` has. A non-tuple `A` (rest parameters) is returned unchanged.
 * @example
 * type D = DropSuffix<[number, string, boolean], [boolean]>; // [number, string]
 */
type DropSuffix<A extends unknown[], S extends unknown[]> = number extends A['length']
	? A
	: S extends [unknown, ...infer STail]
		? A extends [...infer Init, unknown]
			? DropSuffix<Init, STail>
			: []
		: A;

/**
 * Creates a function that invokes `fn` with `args` appended to the arguments it receives (`partialRight(fn, c)(a, b)` calls
 * `fn(a, b, c)`). `this` is forwarded. As with lodash, the bound arguments always come last, so a call with fewer arguments than
 * expected shifts them left: bind trailing arguments of functions whose leading arguments are required. Optional parameters of `fn` are
 * treated as required in the returned function's type.
 * @template F - The type of the function to partially apply
 * @template B - The types of the trailing arguments to pre-apply (a suffix of `fn`'s parameters)
 * @param {F} fn - The function to partially apply
 * @param {...B} args - The trailing arguments to pre-apply
 * @returns {(...rest: DropSuffix<Required<Parameters<F>>, B>) => ReturnType<F>} A function accepting the leading arguments
 * @throws {TypeError} when `fn` is not a function
 * @example
 * function greet(greeting: string, name: string): string { return `${greeting}, ${name}!`; }
 * const greetAda = partialRight(greet, 'Ada');
 * greetAda('Hello'); // => 'Hello, Ada!'
 * @example
 * const toHex = partialRight(Number.parseInt, 16);
 * toHex('ff'); // => 255
 */
export function partialRight<F extends (...args: never[]) => unknown, B extends Suffixes<Required<Parameters<F>>>>(
	fn: F,
	...args: B
): (...rest: DropSuffix<Required<Parameters<F>>, B>) => ReturnType<F> {
	assertFunction('partialRight', 'fn', fn);

	return function partiallyAppliedRight(this: unknown, ...rest: unknown[]): unknown {
		return forward(fn as unknown as UnknownFunction, this, append(rest, args));
	} as (...rest: DropSuffix<Required<Parameters<F>>, B>) => ReturnType<F>;
}

/**
 * The non-empty prefixes of the tuple `A`.
 * @example
 * type P = NonEmptyPrefix<[number, string]>; // [number] | [number, string]
 */
type NonEmptyPrefix<A extends unknown[]> = A extends [infer Head, ...infer Tail] ? [Head] | [Head, ...NonEmptyPrefix<Tail>] : never;

/**
 * Removes as many leading elements from `A` as `P` has.
 * @example
 * type D = DropPrefix<[number, string, boolean], [number]>; // [string, boolean]
 */
type DropPrefix<A extends unknown[], P extends unknown[]> = P extends [unknown, ...infer PTail] ? (A extends [unknown, ...infer ATail] ? DropPrefix<ATail, PTail> : []) : A;

/**
 * The type returned once the arguments `P` have been supplied to a {@link Curried} function expecting `A`.
 */
type CurryStep<A extends unknown[], R> = [] extends A ? R : Curried<A, R>;

/**
 * The type of a curried function produced by {@link curry}: it accepts any non-empty prefix of the remaining arguments and returns
 * either another curried function or, once every argument has been supplied, the result.
 * For non-tuple parameter lists (rest parameters) the precise shape is unknown, so the call returns `unknown`.
 * @template A - The (tuple) parameter types still expected
 * @template R - The final return type
 * @example
 * const add3: Curried<[number, number, number], number> = curry(function (a: number, b: number, c: number): number { return a + b + c; });
 * add3(1)(2)(3); // => 6 // typed as number
 * add3(1, 2)(3); // => 6 // typed as number
 */
export type Curried<A extends unknown[], R> = number extends A['length']
	? (...args: A) => unknown
	: A extends []
		? () => R
		: <P extends NonEmptyPrefix<A>>(...args: P) => CurryStep<DropPrefix<A, P>, R>;

/**
 * Curries `fn`: the returned function collects arguments (one or several at a time) until `arity` of them have been supplied, then
 * invokes `fn` with all of them and the `this` of the final call. Extra arguments in the final call are forwarded too.
 *
 * `fn.length` does not count rest parameters or parameters with default values, so pass `arity` explicitly for such functions
 * (and an explicit tuple type argument if you want precise types). TypeScript types optional parameters (`b?: number`, counted by
 * `fn.length`) like defaulted ones (`b = 0`, not counted), so for either kind the inferred {@link Curried} type cannot know the arity:
 * pass the tuple of the parameters you will collect (`curry<[number, number], number>(fn, 2)`).
 * @template A - The parameter types of `fn`
 * @template R - The return type of `fn`
 * @param {(...args: A) => R} fn - The function to curry
 * @param {number} [arity=fn.length] - Number of arguments to collect before invoking `fn`
 * @returns {Curried<A, R>} The curried function
 * @throws {TypeError} when `fn` is not a function, or `arity` is not a number
 * @throws {RangeError} when `arity` is negative or not an integer
 * @example
 * const add3 = curry(function (a: number, b: number, c: number): number { return a + b + c; });
 * add3(1)(2)(3); // => 6
 * add3(1, 2)(3); // => 6
 * const sum = function (...nums: number[]): number { return nums.reduce(function (a, b) { return a + b; }, 0); };
 * curry<[number, number], number>(sum, 2)(1)(2); // => 3
 */
export function curry<A extends unknown[], R>(fn: (...args: A) => R, arity: number = fn.length): Curried<A, R> {
	assertFunction('curry', 'fn', fn);
	assertInteger('curry', 'arity', arity);

	const call = fn as unknown as UnknownFunction;

	/**
	 * Accumulates `collected` arguments and invokes `fn` once `arity` of them are available.
	 * @param {unknown[]} collected - The arguments supplied so far
	 * @returns {UnknownFunction} The next curried step
	 */
	function step(collected: unknown[]): UnknownFunction {
		return function curried(this: unknown, ...args: unknown[]): unknown {
			// `args` is a fresh rest array: with nothing collected yet, it can be used as is.
			const all = collected.length === 0 ? args : append(collected, args);

			return all.length >= arity ? call.apply(this, all) : step(all);
		};
	}

	return step([]) as unknown as Curried<A, R>;
}

// ---------------------------------------------------------------------------------------------------------------------
// compose / pipe
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Composes functions from right to left: `compose(f, g, h)(...args)` is `f(g(h(...args)))`.
 * The rightmost function may take any number of arguments; the others receive a single value. `this` is forwarded to every function.
 * With no functions, the result is the identity function (returns its first argument).
 * @template A - The parameter types of the rightmost function
 * @template R - The return type of the composition
 * @param {...Function} fns - The functions to compose
 * @returns {Function} The composed function
 * @throws {TypeError} when one of `fns` is not a function
 * @example
 * function inc(x: number): number { return x + 1; }
 * function double(x: number): number { return x * 2; }
 * compose(double, inc)(3); // => 8
 * compose()(5); // => 5
 */
export function compose(): <T>(value: T) => T;
export function compose<A extends unknown[], R>(f1: (...args: A) => R): (...args: A) => R;
export function compose<A extends unknown[], R1, R>(f2: (value: R1) => R, f1: (...args: A) => R1): (...args: A) => R;
export function compose<A extends unknown[], R1, R2, R>(f3: (value: R2) => R, f2: (value: R1) => R2, f1: (...args: A) => R1): (...args: A) => R;
export function compose<A extends unknown[], R1, R2, R3, R>(f4: (value: R3) => R, f3: (value: R2) => R3, f2: (value: R1) => R2, f1: (...args: A) => R1): (...args: A) => R;
export function compose<A extends unknown[], R1, R2, R3, R4, R>(
	f5: (value: R4) => R,
	f4: (value: R3) => R4,
	f3: (value: R2) => R3,
	f2: (value: R1) => R2,
	f1: (...args: A) => R1
): (...args: A) => R;
export function compose<A extends unknown[], R1, R2, R3, R4, R5, R>(
	f6: (value: R5) => R,
	f5: (value: R4) => R5,
	f4: (value: R3) => R4,
	f3: (value: R2) => R3,
	f2: (value: R1) => R2,
	f1: (...args: A) => R1
): (...args: A) => R;
export function compose<R = unknown, F extends AnyFunction[] = AnyFunction[]>(...fns: UncheckedChain<F>): (...args: unknown[]) => R;
/**
 * Implementation of {@link compose} (see the first overload for the full documentation).
 * @param {...AnyFunction} fns - The functions to compose, applied right to left
 * @returns {(...args: unknown[]) => unknown} The composed function
 */
export function compose(...fns: AnyFunction[]): (...args: unknown[]) => unknown {
	assertFunctions('compose', fns);
	// `fns` is a fresh rest array, so it can be reversed in place.
	return chain(fns.reverse() as unknown as UnknownFunction[]);
}

/**
 * The functions accepted by the untyped overloads of {@link pipe} and {@link compose}: a spread array, or more functions than the typed
 * overloads cover. Up to six functions listed one by one, only the typed overloads apply, so that a step whose input does not match
 * the previous output is a compile error instead of falling back to an untyped chain.
 * @template F - The functions
 */
type UncheckedChain<F extends AnyFunction[]> = number extends F['length'] ? F : F['length'] extends 0 | 1 | 2 | 3 | 4 | 5 | 6 ? never : F;

/**
 * Composes functions from left to right: `pipe(f, g, h)(...args)` is `h(g(f(...args)))`.
 * The first function may take any number of arguments; the others receive a single value. `this` is forwarded to every function.
 * With no functions, the result is the identity function (returns its first argument).
 * @template A - The parameter types of the first function
 * @template R - The return type of the pipeline
 * @param {...Function} fns - The functions to chain
 * @returns {Function} The piped function
 * @throws {TypeError} when one of `fns` is not a function
 * @example
 * function inc(x: number): number { return x + 1; }
 * function double(x: number): number { return x * 2; }
 * pipe(double, inc)(3); // => 7
 */
export function pipe(): <T>(value: T) => T;
export function pipe<A extends unknown[], R>(f1: (...args: A) => R): (...args: A) => R;
export function pipe<A extends unknown[], R1, R>(f1: (...args: A) => R1, f2: (value: R1) => R): (...args: A) => R;
export function pipe<A extends unknown[], R1, R2, R>(f1: (...args: A) => R1, f2: (value: R1) => R2, f3: (value: R2) => R): (...args: A) => R;
export function pipe<A extends unknown[], R1, R2, R3, R>(f1: (...args: A) => R1, f2: (value: R1) => R2, f3: (value: R2) => R3, f4: (value: R3) => R): (...args: A) => R;
export function pipe<A extends unknown[], R1, R2, R3, R4, R>(
	f1: (...args: A) => R1,
	f2: (value: R1) => R2,
	f3: (value: R2) => R3,
	f4: (value: R3) => R4,
	f5: (value: R4) => R
): (...args: A) => R;
export function pipe<A extends unknown[], R1, R2, R3, R4, R5, R>(
	f1: (...args: A) => R1,
	f2: (value: R1) => R2,
	f3: (value: R2) => R3,
	f4: (value: R3) => R4,
	f5: (value: R4) => R5,
	f6: (value: R5) => R
): (...args: A) => R;
export function pipe<R = unknown, F extends AnyFunction[] = AnyFunction[]>(...fns: UncheckedChain<F>): (...args: unknown[]) => R;
/**
 * Implementation of {@link pipe} (see the first overload for the full documentation).
 * @param {...AnyFunction} fns - The functions to chain, applied left to right
 * @returns {(...args: unknown[]) => unknown} The piped function
 * @throws {TypeError} when one of `fns` is not a function
 */
export function pipe(...fns: AnyFunction[]): (...args: unknown[]) => unknown {
	assertFunctions('pipe', fns);

	// `fns` is a fresh rest array: no one else can change it.
	return chain(fns as unknown as UnknownFunction[]);
}

/**
 * Creates the function that calls each of `fns` in order with the previous result (see {@link pipe}).
 * @param {UnknownFunction[]} fns - The validated functions, owned by the returned function
 * @returns {(...args: unknown[]) => unknown} The chained function
 */
function chain(fns: UnknownFunction[]): (...args: unknown[]) => unknown {
	return function piped(this: unknown, ...args: unknown[]): unknown {
		if (fns.length === 0) return args[0];

		let result = fns[0].apply(this, args);

		for (let i = 1; i < fns.length; i++) {
			result = fns[i].call(this, result);
		}

		return result;
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// memoize
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The subset of the `Map` API used by {@link memoize} as a cache. A `Map`, or the LRU cache from the `cache` module, satisfies it.
 * @template K - The cache key type
 * @template V - The cached value type
 */
export interface MemoizeCache<K, V> {
	has(key: K): boolean;
	get(key: K): V | undefined;
	set(key: K, value: V): unknown;
	delete(key: K): boolean;
	clear(): void;
}

/**
 * Options accepted by {@link memoize}.
 * @template F - The memoized function type
 * @template C - The cache type
 */
export interface MemoizeOptions<F extends AnyFunction, C extends MemoizeCache<unknown, unknown> = Map<unknown, ReturnType<F>>> {
	/** Computes the cache key from the call arguments (`this` is forwarded). Defaults to {@link defaultMemoizeKey}. */
	resolver?: (...args: Parameters<F>) => unknown;
	/** The cache to use. Defaults to a new `Map`. */
	cache?: C;
}

/**
 * A memoized function as returned by {@link memoize}: callable like `F`, plus access to its cache.
 * @template F - The original function type
 * @template C - The cache type (a `Map` unless a custom cache was supplied)
 */
export type Memoized<F extends AnyFunction, C extends MemoizeCache<unknown, unknown> = Map<unknown, ReturnType<F>>> = F & {
	/** The underlying cache, keyed by the resolver's result. */
	readonly cache: C;
	/** Empties the cache. */
	clear(): void;
};

/**
 * The default cache-key resolver used by {@link memoize} (and the `memoize` decorator). Keys of distinct primitives, and of values of
 * different kinds, never collide; plain data is compared by value and everything else by identity:
 *
 * - A single argument that is a primitive (other than `-0` and strings starting with `[`, which could equal a serialised key), a function,
 *   or an object other than a plain object, an array or a `Date` is used as the key itself, so `1` and `'1'`, `undefined` and `null`,
 *   `NaN`, or two different class instances are all distinct keys.
 * - Anything else (zero or several arguments, a plain object, an array, a `Date`, `-0`, or a string starting with `[`) is serialised like
 *   `JSON.stringify(args)`,
 *   except that every value JSON cannot represent gets a distinct marker string: bigints become `'<n>n'`; `NaN`, `Infinity`, `-Infinity`,
 *   `-0` and `undefined` (also nested, so `[undefined]` differs from `[null]` and `{ a: undefined }` from `{}`) become those words; a `Date`
 *   becomes `'Date(<time value>)'`; and functions, symbols and objects other than plain objects and arrays (class instances, errors,
 *   `Map`, `Set`, `RegExp`, typed arrays, ...) become `'#<identity number>'`, the same number for the same value for the program's
 *   lifetime (held weakly, except for symbols that cannot be `WeakMap` keys, such as `Symbol.for` ones). Strings shaped like a marker
 *   are escaped with a leading backslash. `toJSON` methods are ignored.
 *
 * Limitations: plain objects and arrays are compared structurally by their own enumerable string keys (key order matters; symbol keys
 * and non-enumerable properties are ignored; getters are invoked), holes in arrays count as `undefined`, and circular plain structures
 * throw. Two class instances with the same fields are different keys. Supply a custom `resolver` for anything else.
 * @param {...unknown} args - The call arguments
 * @returns {unknown} The cache key
 * @throws {TypeError} when the arguments contain a circular structure of plain objects or arrays
 * @example
 * defaultMemoizeKey(1); // => 1
 * defaultMemoizeKey('a', 2); // => '["a",2]'
 * defaultMemoizeKey(NaN, 2); // => '["NaN",2]'
 * defaultMemoizeKey({ at: new Date(0) }); // => '[{"at":"Date(0)"}]'
 * defaultMemoizeKey('Date(0)', [undefined]); // => '["\\\\Date(0)",["undefined"]]'
 * const error = new Error('boom');
 * defaultMemoizeKey(error) === error; // => true
 */
export function defaultMemoizeKey(...args: unknown[]): unknown {
	return memoizeKey(args);
}

/**
 * Whether an object is compared by value by {@link defaultMemoizeKey}: an array, a `Date`, or a plain object (whose prototype is
 * `Object.prototype` or `null`).
 * @param {object} value - Any object
 * @returns {boolean} `true` for plain data
 */
function isPlainData(value: object): boolean {
	return isPlainObject(value) || isArray(value) || isDate(value);
}

/**
 * `Array.isArray`, returning `false` for a revoked proxy instead of throwing (such a value is then keyed by identity).
 * @param {object} value - Any object
 * @returns {boolean} `true` for an array
 */
function isArray(value: object): value is unknown[] {
	try {
		return Array.isArray(value);
	} catch {
		return false;
	}
}

/**
 * Whether a lone argument can be its own cache key: anything except `-0` (which `Map` would merge with `0`), strings starting with '['
 * (which could clash with a serialised argument list) and plain data (compared by value).
 * @param {unknown} value - The argument
 * @returns {boolean} `true` when `value` is used as the key as is
 */
function isDirectKey(value: unknown): boolean {
	return typeof value === 'object' ? value === null || !isPlainData(value) : typeof value === 'string' ? value[0] !== '[' : !Object.is(value, -0);
}

/**
 * Computes the {@link defaultMemoizeKey} of an argument list.
 * @param {unknown[]} args - The call arguments
 * @returns {unknown} The cache key
 * @throws {TypeError} when the arguments contain a circular structure
 */
function memoizeKey(args: unknown[]): unknown {
	if (args.length === 1 && isDirectKey(args[0])) return args[0];

	// Fast path: a list of strings and finite numbers is serialised by hand, exactly as serializeKey would
	// (`String` formats finite numbers like JSON does). Any other argument falls back to the general serialiser.
	let key = '[';

	for (let i = 0; i < args.length; i++) {
		const value = args[i];
		let part: string;

		if (typeof value === 'string') part = JSON.stringify(escapeKeyString(value));
		else if (Number.isFinite(value) && !Object.is(value, -0)) part = String(value);
		else return serializeKey(args, []);

		key += i === 0 ? part : `,${part}`;
	}

	return `${key}]`;
}

/**
 * Escapes a string that looks like a key marker (see {@link defaultMemoizeKey}).
 * @param {string} value - A string argument or nested string
 * @returns {string} The string to serialise
 */
function escapeKeyString(value: string): string {
	return SPECIAL_KEY_TOKEN.test(value) ? `\\${value}` : value;
}

/**
 * The identity number of a function, symbol or non-plain object (see {@link defaultMemoizeKey}).
 * @param {unknown} value - The value
 * @returns {number} Its identity number
 */
function identityOf(value: unknown): number {
	const weak = IDENTITIES as WeakMap<never, number>;
	let id = weak.get(value as never) ?? SYMBOL_IDENTITIES.get(value);

	if (id === undefined) {
		id = ++lastIdentity;

		try {
			weak.set(value as never, id);
		} catch {
			// A symbol that cannot be held weakly (see IDENTITIES).
			SYMBOL_IDENTITIES.set(value, id);
		}
	}

	return id;
}

/**
 * Serialises a value for {@link defaultMemoizeKey}: like `JSON.stringify` (without `toJSON`), but with a marker string for every value
 * JSON cannot represent or would confuse.
 * @param {unknown} value - The value
 * @param {object[]} parents - The arrays and plain objects being serialised around `value`, to detect cycles
 * @returns {string} The serialised value
 * @throws {TypeError} when `value` contains a circular structure of plain objects or arrays
 */
function serializeKey(value: unknown, parents: object[]): string {
	switch (typeof value) {
		case 'string':
			return JSON.stringify(escapeKeyString(value));
		case 'number':
			if (Object.is(value, -0)) return '"-0"';
			return Number.isFinite(value) ? String(value) : `"${value}"`;
		case 'boolean':
			return String(value);
		case 'bigint':
			return `"${value}n"`;
		case 'undefined':
			return '"undefined"';
		case 'object': {
			if (value === null) return 'null';
			// `isDate` brand-checks (dates of other realms too, not a proxy of one), and the intrinsic `getTime` reads the time value itself.
			if (isDate(value)) return `"Date(${Date.prototype.getTime.call(value)})"`;
			if (!isPlainData(value)) break;
			if (parents.includes(value)) throw new TypeError('defaultMemoizeKey: `args` must not contain circular structures');

			parents.push(value);

			let key = '';

			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) key += (i === 0 ? '' : ',') + serializeKey(value[i], parents);
				key = `[${key}]`;
			} else {
				const names = Object.keys(value);

				for (let i = 0; i < names.length; i++)
					key += `${i === 0 ? '' : ','}${JSON.stringify(names[i])}:${serializeKey((value as Record<string, unknown>)[names[i]], parents)}`;
				key = `{${key}}`;
			}

			parents.pop();

			return key;
		}
	}

	// Functions, symbols and non-plain objects.
	return `"#${identityOf(value)}"`;
}

/**
 * Creates a function that caches the results of `fn` by key (see {@link defaultMemoizeKey}). Falsy results (`0`, `''`, `false`, `null`,
 * `undefined`) are cached like any other value. `this` is forwarded to `fn` and to the resolver, but it is NOT part of the default key.
 * @template F - The type of the function to memoize
 * @template C - The cache type (defaults to `Map`)
 * @param {F} fn - The function to memoize
 * @param {MemoizeOptions<F, C>} [options] - Optional `resolver` (custom key function) and `cache` (Map-like store)
 * @returns {Memoized<F, C>} The memoized function, exposing `.cache` and `.clear()`
 * @throws {TypeError} when `fn` or `options.resolver` is not a function, or `options.cache` is not a cache
 * @example
 * const square = memoize(function (n: number): number { return n * n; });
 * square(3); // => 9 // computed
 * square(3); // => 9 // cached
 * square.cache.size; // => 1
 * square.clear();
 */
export function memoize<F extends AnyFunction, C extends MemoizeCache<unknown, unknown> = Map<unknown, ReturnType<F>>>(
	fn: F,
	options: MemoizeOptions<F, C> = {}
): Memoized<F, C> {
	assertFunction('memoize', 'fn', fn);

	const resolver = (options.resolver ?? defaultMemoizeKey) as UnknownFunction;
	assertFunction('memoize', 'options.resolver', resolver);
	// The default resolver ignores `this`, so it can be applied to the argument list directly.
	const defaultKey = resolver === defaultMemoizeKey;

	// Only `memoize` writes to the cache, so every stored value is a `ReturnType<F>` whatever the cache's declared value type.
	const cache = (options.cache ?? new Map<unknown, ReturnType<F>>()) as MemoizeCache<unknown, ReturnType<F>>;
	const methods = cache as unknown as Partial<Record<keyof MemoizeCache<unknown, unknown>, unknown>>;

	if (
		// (`null` gave the default cache above.)
		typeof cache !== 'object' ||
		typeof methods.get !== 'function' ||
		typeof methods.set !== 'function' ||
		typeof methods.has !== 'function' ||
		typeof methods.clear !== 'function'
	) {
		throw new TypeError(`memoize: \`options.cache\` must have get, set, has and clear methods, got ${describe(cache)}`);
	}
	const call = fn as unknown as UnknownFunction;

	/**
	 * The memoized wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {unknown} The cached or freshly computed result
	 */
	function memoized(this: unknown): unknown {
		// A single argument (the common case) is handled without building an argument list (copying `arguments` by hand is also several
		// times faster than a rest parameter here).
		const single = arguments.length === 1;
		// eslint-disable-next-line prefer-rest-params -- see above
		const first: unknown = arguments[0];
		// Only read when there are several arguments.
		let args!: unknown[];
		if (!single) {
			args = new Array<unknown>(arguments.length);
			// eslint-disable-next-line prefer-rest-params -- see above
			for (let i = 0; i < args.length; i++) args[i] = arguments[i];
		}
		const key = defaultKey
			? single && isDirectKey(first)
				? first
				: memoizeKey(single ? [first] : args)
			: single
				? resolver.call(this, first)
				: resolver.apply(this, args);

		// Read once, then fall back to `has` only for a cached `undefined`: an expiring cache (e.g. an LRU with a TTL) could
		// otherwise drop the entry between a `has` and a `get` and make the wrapper return `undefined`.
		const cached = cache.get(key);
		if (cached !== undefined || cache.has(key)) return cached;

		const result = (single ? call.call(this, first) : call.apply(this, args)) as ReturnType<F>;
		cache.set(key, result);

		return result;
	}

	Object.defineProperties(memoized, {
		cache: { value: cache, enumerable: true },
		clear: {
			value: function clear(): void {
				cache.clear();
			}
		}
	});

	return memoized as unknown as Memoized<F, C>;
}

// ---------------------------------------------------------------------------------------------------------------------
// throttle / debounce
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link throttle}.
 */
export interface ThrottleOptions {
	/** Invoke on the leading edge of the window. Defaults to `true`. */
	leading?: boolean;
	/** Invoke on the trailing edge of the window with the latest arguments, if the function was called during the window. Defaults to `false`. */
	trailing?: boolean;
}

/**
 * A throttled function as returned by {@link throttle}.
 * @template F - The original function type
 */
export interface Throttled<F extends AnyFunction> {
	(this: ThisParameterType<F>, ...args: Parameters<F>): ReturnType<F> | undefined;
	/** Cancels a pending trailing invocation and resets the throttle window. */
	cancel(): void;
}

/**
 * Creates a throttled function that invokes `fn` at most once per `wait` milliseconds.
 * By default (`leading: true, trailing: false`) the first call of a window invokes `fn` immediately and later calls in the same window are ignored.
 * With `trailing: true`, the latest call made during a window is invoked (with its own `this` and arguments) when the window ends.
 * Each call returns the result of the most recent invocation of `fn` (`undefined` before the first one).
 * @template F - The type of the function to throttle
 * @param {F} fn - The function to throttle
 * @param {number} wait - The window length in milliseconds
 * @param {ThrottleOptions} [options] - `leading` (default `true`) and `trailing` (default `false`)
 * @returns {Throttled<F>} The throttled function, with a `.cancel()` method
 * @throws {TypeError} when `fn` is not a function, or `wait` is not a number
 * @throws {RangeError} when `wait` is negative, `NaN` or infinite, or when both `leading` and `trailing` are `false`
 * @example
 * import { sleep } from 'tinkit/async';
 * const positions: number[] = [];
 * const onScroll = throttle(function (y: number): void { positions.push(y); }, 20, { trailing: true });
 * onScroll(10); // leading edge: runs now
 * onScroll(20);
 * onScroll(30);
 * positions; // => [10]
 * await sleep(50);
 * positions; // => [10, 30] // trailing edge: runs with the latest arguments
 * // In a browser: window.addEventListener('scroll', function () { onScroll(window.scrollY); });
 */
export function throttle<F extends AnyFunction>(fn: F, wait: number, options: ThrottleOptions = {}): Throttled<F> {
	assertFunction('throttle', 'fn', fn);
	assertWait('throttle', 'wait', wait);

	const leading = options.leading ?? true;
	const trailing = options.trailing ?? false;

	if (!leading && !trailing) throw new RangeError('throttle: at least one of `leading` or `trailing` must be true');

	const call = fn as unknown as UnknownFunction;
	// Start of the current window (`NaN`, which fails every comparison, when there is none).
	let windowStart = NaN;
	let timer: TimerHandle | undefined;
	let pendingThis: unknown;
	let pendingArgs: unknown[] | undefined;
	let result: unknown;

	/**
	 * Whether `now` falls inside the current window (a clock that went backwards ends it).
	 * @param {number} now - The current timestamp
	 * @returns {boolean} `true` inside the window
	 */
	function inWindow(now: number): boolean {
		return now >= windowStart && now - windowStart < wait;
	}

	/**
	 * Invokes `fn` and starts a new window at `time`.
	 * @param {unknown} thisArg - The `this` to use
	 * @param {unknown[]} args - The arguments to use
	 * @param {number} time - The current timestamp
	 * @returns {unknown} The result of `fn`
	 */
	function invoke(thisArg: unknown, args: unknown[], time: number): unknown {
		windowStart = time;
		pendingThis = undefined;
		pendingArgs = undefined;
		result = call.apply(thisArg, args);

		return result;
	}

	/**
	 * Fires at the end of a window and performs the pending trailing invocation, if any.
	 * @returns {void}
	 */
	function onWindowEnd(): void {
		// The timer only runs while a trailing call is pending (a leading invocation or cancel() clears it first).
		timer = undefined;

		const now = Date.now();

		// A long window is covered by several clamped timers; re-arm until it really ends.
		if (inWindow(now)) {
			schedule(windowStart + wait - now);
			return;
		}

		invoke(pendingThis, pendingArgs as unknown[], now);
	}

	/**
	 * Schedules the trailing invocation for the end of the current window.
	 * @param {number} delay - Milliseconds until the window ends
	 * @returns {void}
	 */
	function schedule(delay: number): void {
		if (timer === undefined) timer = startTimer(onWindowEnd, delay);
	}

	/**
	 * The throttled wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {unknown} The result of the latest invocation
	 */
	function throttled(this: unknown, ...args: unknown[]): unknown {
		const now = Date.now();

		if (!inWindow(now)) {
			// A late timer, if any: the newer call supersedes the pending one.
			clearTimeout(timer);
			timer = undefined;

			if (leading) return invoke(this, args, now);

			windowStart = now;
		}

		if (trailing) {
			// eslint-disable-next-line @typescript-eslint/no-this-alias -- the trailing invocation needs the latest call's `this`
			pendingThis = this;
			pendingArgs = args;
			schedule(windowStart + wait - now);
		}

		return result;
	}

	Object.defineProperty(throttled, 'cancel', {
		value: function cancel(): void {
			clearTimeout(timer);
			timer = undefined;
			windowStart = NaN;
			pendingThis = undefined;
			pendingArgs = undefined;
		}
	});

	return throttled as unknown as Throttled<F>;
}

/**
 * Options accepted by {@link debounce}.
 */
export interface DebounceOptions {
	/** Invoke on the leading edge of a burst of calls. Defaults to `false`. */
	leading?: boolean;
	/** Invoke on the trailing edge (after `wait` ms without calls) with the latest arguments. Defaults to `true`. */
	trailing?: boolean;
	/** The maximum time `fn` may be delayed before it is invoked (clamped to at least `wait`). */
	maxWait?: number;
}

/**
 * A debounced function as returned by {@link debounce}.
 * @template F - The original function type
 */
export interface Debounced<F extends AnyFunction> {
	(this: ThisParameterType<F>, ...args: Parameters<F>): ReturnType<F> | undefined;
	/** Cancels the pending invocation, if any. */
	cancel(): void;
	/** Immediately performs the pending invocation, if any, and returns the latest result. */
	flush(): ReturnType<F> | undefined;
	/** Whether a trailing invocation is pending. */
	pending(): boolean;
}

/**
 * Creates a debounced function that delays invoking `fn` until `wait` milliseconds have elapsed since the last call.
 * The trailing invocation uses the `this` and arguments of the latest call. With `leading: true`, the first call of a burst is invoked
 * immediately; with `maxWait`, `fn` is guaranteed to be invoked at least every `maxWait` ms during a continuous burst.
 * Each call returns the result of the most recent invocation of `fn` (`undefined` before the first one).
 * @template F - The type of the function to debounce
 * @param {F} fn - The function to debounce
 * @param {number} wait - The quiet period in milliseconds
 * @param {DebounceOptions} [options] - `leading` (default `false`), `trailing` (default `true`) and `maxWait`
 * @returns {Debounced<F>} The debounced function, with `.cancel()`, `.flush()` and `.pending()` methods
 * @throws {TypeError} when `fn` is not a function, or `wait` or `maxWait` is not a number
 * @throws {RangeError} when `wait` or `maxWait` is negative, `NaN` or infinite, or when both `leading` and `trailing` are `false`
 * @example
 * import { sleep } from 'tinkit/async';
 * const saved: string[] = [];
 * const save = debounce(function (text: string): void { saved.push(text); }, 20);
 * save('h');
 * save('he');
 * save('hey');
 * saved; // => []
 * await sleep(50);
 * saved; // => ['hey'] // one call, with the latest arguments
 * save('bye');
 * save.flush(); // runs the pending call now (e.g. on 'beforeunload')
 * saved; // => ['hey', 'bye']
 */
export function debounce<F extends AnyFunction>(fn: F, wait: number, options: DebounceOptions = {}): Debounced<F> {
	assertFunction('debounce', 'fn', fn);
	assertWait('debounce', 'wait', wait);

	const leading = options.leading ?? false;
	const trailing = options.trailing ?? true;
	// Read once: a getter returning another value later must not replace the validated one.
	const requestedMaxWait = options.maxWait;
	const maxing = requestedMaxWait !== undefined;

	if (maxing) assertWait('debounce', 'maxWait', requestedMaxWait);
	if (!leading && !trailing) throw new RangeError('debounce: at least one of `leading` or `trailing` must be true');

	const maxWait = Math.max(requestedMaxWait ?? 0, wait);
	const call = fn as unknown as UnknownFunction;
	let timer: TimerHandle | undefined;
	let lastArgs: unknown[] | undefined;
	let lastThis: unknown;
	let lastCallTime: number | undefined;
	let lastInvokeTime = 0;
	let result: unknown;

	/**
	 * Invokes `fn` with the latest `this` and arguments.
	 * @param {number} time - The current timestamp
	 * @returns {unknown} The result of `fn`
	 */
	function invoke(time: number): unknown {
		const args = lastArgs as unknown[];
		const thisArg = lastThis;

		lastArgs = undefined;
		lastThis = undefined;
		lastInvokeTime = time;
		result = call.apply(thisArg, args);

		return result;
	}

	/**
	 * Whether enough time has elapsed for an invocation at `time`.
	 * @param {number} time - The current timestamp
	 * @returns {boolean} `true` when `fn` should be invoked
	 */
	function shouldInvoke(time: number): boolean {
		if (lastCallTime === undefined) return true;

		const sinceCall = time - lastCallTime;

		// Negated comparisons: a clock returning `NaN` (or `±Infinity`) must invoke, not re-arm a timer forever.
		return !(sinceCall < wait) || sinceCall < 0 || (maxing && !(time - lastInvokeTime < maxWait));
	}

	/**
	 * Milliseconds until the next possible invocation.
	 * @param {number} time - The current timestamp
	 * @returns {number} The remaining delay
	 */
	function remainingWait(time: number): number {
		const remaining = wait - (time - (lastCallTime as number));

		return maxing ? Math.min(remaining, maxWait - (time - lastInvokeTime)) : remaining;
	}

	/**
	 * Ends a burst: performs the trailing invocation if one is due.
	 * @param {number} time - The current timestamp
	 * @returns {unknown} The latest result
	 */
	function trailingEdge(time: number): unknown {
		timer = undefined;

		if (trailing && lastArgs !== undefined) return invoke(time);

		lastArgs = undefined;
		lastThis = undefined;

		return result;
	}

	/**
	 * Timer callback: either ends the burst or re-arms the timer.
	 * @returns {void}
	 */
	function onTimer(): void {
		const time = Date.now();

		if (shouldInvoke(time)) {
			trailingEdge(time);
		} else {
			timer = startTimer(onTimer, remainingWait(time));
		}
	}

	/**
	 * The debounced wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {unknown} The result of the latest invocation
	 */
	function debounced(this: unknown, ...args: unknown[]): unknown {
		const time = Date.now();
		const isInvoking = shouldInvoke(time);

		lastArgs = args;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the deferred invocation needs the latest call's `this`
		lastThis = this;
		lastCallTime = time;

		if (isInvoking) {
			if (timer === undefined) {
				// Leading edge of a new burst.
				lastInvokeTime = time;
				timer = startTimer(onTimer, wait);

				return leading ? invoke(time) : result;
			}

			if (maxing) {
				clearTimeout(timer);
				timer = startTimer(onTimer, wait);

				return invoke(time);
			}
		}

		if (timer === undefined) timer = startTimer(onTimer, wait);

		return result;
	}

	Object.defineProperties(debounced, {
		cancel: {
			value: function cancel(): void {
				clearTimeout(timer);
				timer = undefined;
				lastArgs = undefined;
				lastThis = undefined;
				lastCallTime = undefined;
				lastInvokeTime = 0;
			}
		},
		flush: {
			value: function flush(): unknown {
				// Without a timer nothing is pending, and `trailingEdge` just returns the latest result. The invocation time is only read with
				// `maxWait`, so the clock is not read otherwise.
				clearTimeout(timer);

				return trailingEdge(maxing ? Date.now() : 0);
			}
		},
		pending: {
			value: function pending(): boolean {
				// Pending arguments always come with a running timer.
				return trailing && lastArgs !== undefined;
			}
		}
	});

	return debounced as unknown as Debounced<F>;
}

// ---------------------------------------------------------------------------------------------------------------------
// once / before / after / negate / identity / noop
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Creates a function that invokes `fn` only on its first call and returns that first result on every later call.
 * If the first call throws, every later call rethrows the same error. `this` is forwarded to the single invocation.
 * A re-entrant call (made by `fn` itself, before its first invocation has returned) does not invoke `fn` again and returns `undefined`.
 * @template F - The type of the function
 * @param {F} fn - The function to restrict
 * @returns {F} A function that invokes `fn` at most once
 * @throws {TypeError} when `fn` is not a function
 * @example
 * let runs = 0;
 * const init = once(function (): number { runs++; return 42; });
 * init(); // => 42
 * init(); // => 42 // the first result, without running the function again
 * runs; // => 1
 */
export function once<F extends AnyFunction>(fn: F): F {
	assertFunction('once', 'fn', fn);

	const call = fn as unknown as UnknownFunction;
	// 0: not called yet, 1: running, 2: done, 3: failed.
	let status = 0;
	// The result, or the error once `status` is 3 (failed).
	let outcome: unknown;

	return function onceWrapper(this: unknown, ...args: unknown[]): unknown {
		if (status === 2) return outcome;

		if (status === 0) {
			status = 1;

			try {
				outcome = call.apply(this, args);
				status = 2;
			} catch (error) {
				outcome = error;
				status = 3;
			}
		}

		if (status === 3) throw outcome;

		// Done, or a re-entrant call while running (whose `outcome` is still `undefined`).
		return outcome;
	} as unknown as F;
}

/**
 * Creates a function that invokes `fn` only while it has been called fewer than `n` times; later calls return the last result.
 * `this` is forwarded.
 * @template F - The type of the function
 * @param {number} n - The number of calls after which `fn` is no longer invoked (`before(3, fn)` invokes `fn` on the first two calls)
 * @param {F} fn - The function to restrict
 * @returns {(this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined} The restricted function
 * @throws {TypeError} when `fn` is not a function, or `n` is not a number
 * @throws {RangeError} when `n` is not a non-negative integer
 * @example
 * const f = before(3, function (x: number): number { return x * 2; });
 * [f(1), f(2), f(3)]; // => [2, 4, 4]
 */
export function before<F extends AnyFunction>(n: number, fn: F): (this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined {
	assertInteger('before', 'n', n);
	assertFunction('before', 'fn', fn);

	const call = fn as unknown as UnknownFunction;
	let calls = 0;
	let result: unknown;

	return function beforeWrapper(this: unknown, ...args: unknown[]): unknown {
		calls += 1;

		if (calls < n) result = call.apply(this, args);

		return result;
	} as unknown as (this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined;
}

/**
 * Creates a function that invokes `fn` only once it has been called at least `n` times (from the `n`-th call on); earlier calls return `undefined`.
 * `this` is forwarded.
 * @template F - The type of the function
 * @param {number} n - The number of calls before `fn` starts being invoked
 * @param {F} fn - The function to restrict
 * @returns {(this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined} The restricted function
 * @throws {TypeError} when `fn` is not a function, or `n` is not a number
 * @throws {RangeError} when `n` is not a non-negative integer
 * @example
 * const done = after(2, function (): string { return 'all loaded'; });
 * done(); // => undefined
 * done(); // => 'all loaded'
 */
export function after<F extends AnyFunction>(n: number, fn: F): (this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined {
	assertInteger('after', 'n', n);
	assertFunction('after', 'fn', fn);

	const call = fn as unknown as UnknownFunction;

	return function afterWrapper(this: unknown, ...args: unknown[]): unknown {
		// `n` counts down the calls left before the first invocation (it is an integer).
		return --n < 1 ? call.apply(this, args) : undefined;
	} as unknown as (this: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F> | undefined;
}

/**
 * Creates a predicate that returns the boolean negation of `predicate`. `this` is forwarded.
 * @template A - The parameter types of the predicate
 * @template T - The `this` type of the predicate
 * @param {(this: T, ...args: A) => unknown} predicate - The predicate to negate
 * @returns {(this: T, ...args: A) => boolean} The negated predicate
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * const isOdd = negate(function (n: number): boolean { return n % 2 === 0; });
 * [1, 2, 3].filter(isOdd); // => [1, 3]
 */
export function negate<A extends unknown[], T = unknown>(predicate: (this: T, ...args: A) => unknown): (this: T, ...args: A) => boolean {
	assertFunction('negate', 'predicate', predicate);

	return function negated(this: T, ...args: A): boolean {
		return !predicate.apply(this, args);
	};
}

/**
 * Any predicate: a function whose first parameter is the tested value (further arguments, such as an index, are forwarded).
 */
type Predicate = (value: never, ...rest: never[]) => unknown;

/**
 * The type a predicate narrows its first argument to: `S` for a type guard `(value) => value is S`, `unknown` for any other predicate.
 * (Matched through a method signature, whose bivariant parameters accept guards over any input type.)
 * @example
 * type G = GuardedType<(value: unknown) => value is string>; // string
 */
type GuardedType<P> = P extends { guard(value: unknown, ...rest: never[]): value is infer S }['guard'] ? S : unknown;

/**
 * The input type of a left-to-right, short-circuiting combination of predicates: the first-parameter type of each predicate, except that
 * a later predicate's requirement is dropped when an earlier type guard already guarantees it (`allPass(isString, isShort)` accepts
 * `unknown`: `isShort` only ever sees strings). Otherwise the requirements intersect.
 */
type PredicatesInput<P extends readonly unknown[]> = P extends readonly [infer Head, ...infer Tail]
	? (Head extends (value: infer V, ...rest: never[]) => unknown ? V : never) & (GuardedType<Head> extends PredicatesInput<Tail> ? unknown : PredicatesInput<Tail>)
	: unknown;

/**
 * The intersection of the types narrowed by a tuple of predicates (`unknown` contributes nothing).
 */
type AllGuarded<P extends readonly unknown[]> = P extends readonly [infer Head, ...infer Tail] ? GuardedType<Head> & AllGuarded<Tail> : unknown;

/**
 * The union of the types narrowed by a tuple of predicates; `unknown` (no narrowing) as soon as one of them is not a type guard.
 */
type AnyGuarded<P extends readonly unknown[]> = P extends readonly [infer Head, ...infer Tail] ? GuardedType<Head> | AnyGuarded<Tail> : never;

/**
 * Builds the {@link allPass}/{@link anyPass} combinator.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<UnknownFunction>} predicates - The predicates
 * @param {boolean} all - `true` for `allPass` (stop at the first failure), `false` for `anyPass` (stop at the first success)
 * @returns {UnknownFunction} The combined predicate
 * @throws {TypeError} when a predicate is not a function
 */
function combinePredicates(caller: string, predicates: ReadonlyArray<UnknownFunction>, all: boolean): UnknownFunction {
	assertFunctions(caller, predicates, 'predicates');

	// The rest array of `allPass`/`anyPass`: fresh, and never seen by the caller, so it needs no copy.
	const list = predicates;

	// Up to three arguments (an `Array.prototype.filter` callback gets three) are passed with `call`, which V8 optimises much better than
	// `apply` with an argument list.
	return function combined(this: unknown, a?: unknown, b?: unknown, c?: unknown): boolean {
		const count = arguments.length;

		for (let i = 0; i < list.length; i++) {
			const passed =
				count === 1
					? list[i].call(this, a)
					: count === 3
						? list[i].call(this, a, b, c)
						: count === 2
							? list[i].call(this, a, b)
							: // eslint-disable-next-line prefer-rest-params -- see above
								list[i].apply(this, arguments as unknown as unknown[]);

			if (!passed === all) return !all;
		}

		return all;
	};
}

/**
 * Creates a predicate that is `true` when every one of `predicates` returns a truthy value for the same arguments (`true` for no
 * predicates). Evaluation is left to right and stops at the first falsy result. `this` and every argument are forwarded, so it works as
 * an `Array.prototype.filter` callback.
 *
 * Type guards keep narrowing: combining `(v) => v is A` and `(v) => v is B` gives a guard for `A & B` (plain predicates add nothing).
 * The input type is the intersection of the predicates' parameter types, except what an earlier type guard already guarantees: since
 * evaluation stops at the first failure, `allPass(isString, isShort)` accepts `unknown` although `isShort` takes a `string`.
 * Like every type predicate, the `false` branch removes the guarded type: when a guard is combined with plain predicates, a value of that
 * type that only failed a plain predicate also takes it (`if (!allPass(isString, isShort)(x))` leaves `x: number` for a long string), so
 * test the guard alone there.
 * @template P - The tuple of predicate types
 * @param {...P} predicates - The predicates to combine
 * @returns {(value: PredicatesInput<P>, ...rest: unknown[]) => value is PredicatesInput<P> & AllGuarded<P>} The combined predicate
 * @throws {TypeError} when a predicate is not a function
 * @example
 * function isString(value: unknown): value is string { return typeof value === 'string'; }
 * function isShort(value: string): boolean { return value.length <= 3; }
 * ['ab', 7, 'abcd', 'xyz'].filter(allPass(isString, isShort)); // => ['ab', 'xyz'] // typed as string[]
 * allPass()(42); // => true
 */
export function allPass<P extends Predicate[]>(...predicates: P): (value: PredicatesInput<P>, ...rest: unknown[]) => value is PredicatesInput<P> & AllGuarded<P> {
	return combinePredicates('allPass', predicates as unknown as UnknownFunction[], true) as unknown as (
		value: PredicatesInput<P>,
		...rest: unknown[]
	) => value is PredicatesInput<P> & AllGuarded<P>;
}

/**
 * Creates a predicate that is `true` when at least one of `predicates` returns a truthy value for the same arguments (`false` for no
 * predicates). Evaluation is left to right and stops at the first truthy result. `this` and every argument are forwarded.
 *
 * Type guards keep narrowing: when every predicate is a type guard, `(v) => v is A` and `(v) => v is B` give a guard for `A | B`; with
 * any plain predicate among them, nothing is narrowed (a `true` result no longer proves any of the guards).
 * @template P - The tuple of predicate types
 * @param {...P} predicates - The predicates to combine
 * @returns {(value: PredicatesInput<P>, ...rest: unknown[]) => value is PredicatesInput<P> & AnyGuarded<P>} The combined predicate
 * @throws {TypeError} when a predicate is not a function
 * @example
 * function isString(value: unknown): value is string { return typeof value === 'string'; }
 * function isNumber(value: unknown): value is number { return typeof value === 'number'; }
 * [1, 'a', null, true].filter(anyPass(isString, isNumber)); // => [1, 'a'] // typed as (string | number)[]
 * anyPass()(42); // => false
 */
export function anyPass<P extends Predicate[]>(...predicates: P): (value: PredicatesInput<P>, ...rest: unknown[]) => value is PredicatesInput<P> & AnyGuarded<P> {
	return combinePredicates('anyPass', predicates as unknown as UnknownFunction[], false) as unknown as (
		value: PredicatesInput<P>,
		...rest: unknown[]
	) => value is PredicatesInput<P> & AnyGuarded<P>;
}

/**
 * Returns its argument unchanged.
 * @template T - The value type
 * @param {T} value - Any value
 * @returns {T} `value`
 * @example
 * [1, 0, 2].filter(identity); // => [1, 2]
 */
export function identity<T>(value: T): T {
	return value;
}

/**
 * Does nothing and returns `undefined`, whatever the arguments. Handy as a default callback.
 * @param {...unknown} _args - Ignored
 * @returns {void}
 * @example
 * const promise = Promise.reject(new Error('ignored'));
 * promise.catch(noop); // swallows the rejection
 * noop(1, 2, 3); // => undefined
 */
export function noop(..._args: unknown[]): void {
	// Intentionally empty.
}

// ---------------------------------------------------------------------------------------------------------------------
// attempt / times / flip / unary / constant / memoizeLast
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A Go-style result tuple: `[error, undefined]` when the operation failed, `[undefined, value]` when it succeeded.
 * Check `error !== undefined` (or use the value directly when your function cannot return `undefined`). Note that `throw undefined`
 * produces `[undefined, undefined]`, which is indistinguishable from a successful `undefined` result.
 * @template T - The success value type
 * @example
 * const [error, data]: Result<{ ok: boolean }> = attempt(JSON.parse, '{"ok":true}');
 * error; // => undefined
 * data; // => { ok: true }
 */
export type Result<T> = [error: unknown, result: undefined] | [error: undefined, result: T];

/**
 * Calls `fn(...args)` and captures its outcome as a {@link Result} tuple instead of throwing. Never throws: if `fn` is not a function,
 * the `TypeError` is returned as the error. `fn` is called with an `undefined` `this`. For async functions use `attemptAsync`
 * (from the async module): here a returned promise is just the success value.
 * @template A - The parameter types of `fn`
 * @template R - The return type of `fn`
 * @param {(...args: A) => R} fn - The function to call
 * @param {...A} args - The arguments to call it with
 * @returns {Result<R>} `[undefined, result]` on success, `[error, undefined]` when `fn` threw
 * @example
 * attempt(JSON.parse, '{"a":1}'); // => [undefined, { a: 1 }]
 * const [error, value] = attempt(JSON.parse, '{');
 * error instanceof SyntaxError; // => true
 * value; // => undefined
 */
export function attempt<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Result<R> {
	try {
		assertFunction('attempt', 'fn', fn);

		return [undefined, fn(...args)];
	} catch (error) {
		return [error, undefined];
	}
}

/**
 * Throws a `TypeError` unless `result` is a {@link Result} tuple (an array of length 2).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} result - The value to validate
 * @returns {void}
 * @throws {TypeError} when `result` is not an array of length 2
 */
function assertResult(caller: string, result: unknown): asserts result is Result<unknown> {
	if (!Array.isArray(result) || result.length !== 2) {
		throw new TypeError(`${caller}: \`result\` must be an [error, result] tuple, got ${Array.isArray(result) ? `an array of length ${result.length}` : describe(result)}`);
	}
}

/**
 * Creates a successful {@link Result}: `[undefined, value]`, the tuple {@link attempt} returns when the call returned `value`.
 * @template T - The value type
 * @param {T} value - The value
 * @returns {[error: undefined, result: T]} The tuple
 * @example
 * ok(42); // => [undefined, 42]
 * isOk(ok('x')); // => true
 */
export function ok<T>(value: T): [error: undefined, result: T] {
	return [undefined, value];
}

/**
 * Creates a failed {@link Result}: `[error, undefined]`, the tuple {@link attempt} returns when the call threw `error`. The error must not
 * be `undefined`, since `[undefined, undefined]` reads as a success (see {@link Result}).
 * @template E - The error type
 * @param {E} error - The error
 * @returns {[error: E, result: undefined]} The tuple
 * @throws {TypeError} when `error` is `undefined`
 * @example
 * const failed = err(new RangeError('Too big'));
 * failed[0] instanceof RangeError; // => true
 * isErr(failed); // => true
 * err(undefined); // throws TypeError
 */
export function err<E>(error: E): [error: E, result: undefined] {
	if (error === undefined) throw new TypeError('err: `error` must not be undefined (an undefined error reads as a success), got undefined');
	return [error, undefined];
}

/**
 * Checks whether a {@link Result} is a success, narrowing it to `[undefined, T]`. A result is a success when its error is `undefined`,
 * as {@link attempt} produces it, so `throw undefined` (captured as `[undefined, undefined]`) counts as a successful `undefined` result.
 * @template T - The success value type
 * @param {Result<T>} result - The result
 * @returns {boolean} `true` when `result[0]` is `undefined`
 * @throws {TypeError} when `result` is not an array of length 2
 * @example
 * const result: Result<number> = attempt(Math.sqrt, 16);
 * const value = isOk(result) ? result[1] : 0; // => 4 // typed as number
 * isOk(attempt(JSON.parse, '{')); // => false
 */
export function isOk<T>(result: Result<T>): result is [error: undefined, result: T] {
	assertResult('isOk', result);
	return result[0] === undefined;
}

/**
 * Checks whether a {@link Result} is a failure, narrowing it to `[error, undefined]`: the negation of {@link isOk} (its error is not
 * `undefined`).
 * @template T - The success value type
 * @param {Result<T>} result - The result
 * @returns {boolean} `true` when `result[0]` is not `undefined`
 * @throws {TypeError} when `result` is not an array of length 2
 * @example
 * const result = attempt(JSON.parse, '{');
 * isErr(result) && result[0] instanceof SyntaxError; // => true
 * isErr(ok(1)); // => false
 */
export function isErr<T>(result: Result<T>): result is [error: unknown, result: undefined] {
	assertResult('isErr', result);
	return result[0] !== undefined;
}

/**
 * Transforms the value of a successful {@link Result} with `fn`; a failed result is returned as it is (the same tuple), without calling
 * `fn`. An exception thrown by `fn` is not captured: wrap it with {@link attempt} for that.
 * @template T - The success value type
 * @template U - The transformed value type
 * @param {Result<T>} result - The result
 * @param {(value: T) => U} fn - Transforms the value
 * @returns {Result<U>} `[undefined, fn(value)]`, or `result` itself when it failed
 * @throws {TypeError} when `result` is not an array of length 2 or `fn` is not a function
 * @example
 * mapResult(ok(2), function (n: number) { return n * 10; }); // => [undefined, 20]
 * const failed = attempt(JSON.parse, '{');
 * mapResult(failed, function () { return 'never called'; }) === failed; // => true
 */
export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
	assertResult('mapResult', result);
	assertFunction('mapResult', 'fn', fn);
	return result[0] === undefined ? [undefined, fn(result[1] as T)] : (result as [error: unknown, result: undefined]);
}

/**
 * Returns the value of a successful {@link Result}, or throws its error, as it is (the very value the function given to {@link attempt}
 * threw, not wrapped), so `unwrap(attempt(fn, ...args))` behaves like `fn(...args)`.
 * @template T - The success value type
 * @param {Result<T>} result - The result
 * @returns {T} The value
 * @throws {unknown} the result's error, when it failed
 * @throws {TypeError} when `result` is not an array of length 2
 * @example
 * unwrap(attempt(JSON.parse, '[1]')); // => [1]
 * unwrap(attempt(JSON.parse, '{')); // throws SyntaxError
 */
export function unwrap<T>(result: Result<T>): T {
	assertResult('unwrap', result);
	if (result[0] !== undefined) throw result[0];
	return result[1] as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// when / unless / cond
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Builds {@link when} (`negated: false`) or {@link unless} (`negated: true`).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {UnknownFunction} predicate - The predicate
 * @param {UnknownFunction} fn - The transform
 * @param {boolean} negated - Whether `fn` runs when the predicate fails
 * @returns {(value: unknown) => unknown} The conditional function
 * @throws {TypeError} when `predicate` or `fn` is not a function
 */
function conditional(caller: string, predicate: UnknownFunction, fn: UnknownFunction, negated: boolean): (value: unknown) => unknown {
	assertFunction(caller, 'predicate', predicate);
	assertFunction(caller, 'fn', fn);
	return function transformIf(this: unknown, value: unknown): unknown {
		return !predicate.call(this, value) === negated ? fn.call(this, value) : value;
	};
}

/**
 * Creates a function that applies `fn` to its argument when `predicate` returns a truthy value for it, and returns the argument unchanged
 * otherwise: `value => predicate(value) ? fn(value) : value` (Ramda's `when`). Only the first argument is passed on; `this` is forwarded.
 * With a type guard, `fn` receives the narrowed type, and the result type is `fn`'s result or the input minus the guarded type.
 * @template T - The input type of the predicate
 * @template S - The type the predicate guards
 * @template R - The return type of `fn`
 * @param {(value: T) => value is S} predicate - Decides whether `fn` runs
 * @param {(value: S) => R} fn - Transforms the values that pass
 * @returns {<V extends T>(value: V) => R | Exclude<V, S>} The conditional function
 * @throws {TypeError} when `predicate` or `fn` is not a function
 * @example
 * const clampNegative = when(function (n: number) { return n < 0; }, constant(0));
 * [3, -2, 5].map(clampNegative); // => [3, 0, 5]
 * function isString(value: unknown): value is string { return typeof value === 'string'; }
 * const trimStrings = when(isString, function (text) { return text.trim(); });
 * [' a ', 1, null].map(trimStrings); // => ['a', 1, null]
 */
export function when<T, S extends T, R>(predicate: (value: T) => value is S, fn: (value: S) => R): <V extends T>(value: V) => R | Exclude<V, S>;
export function when<T, R>(predicate: (value: T) => unknown, fn: (value: T) => R): <V extends T>(value: V) => V | R;
/**
 * Implementation of {@link when} (see the first overload for the full documentation).
 * @param {AnyFunction} predicate - Decides whether `fn` runs
 * @param {AnyFunction} fn - Transforms the values that pass
 * @returns {(value: unknown) => unknown} The conditional function
 * @throws {TypeError} when `predicate` or `fn` is not a function
 */
export function when(predicate: AnyFunction, fn: AnyFunction): (value: unknown) => unknown {
	return conditional('when', predicate as UnknownFunction, fn as UnknownFunction, false);
}

/**
 * Creates a function that applies `fn` to its argument when `predicate` returns a falsy value for it, and returns the argument unchanged
 * otherwise: `value => predicate(value) ? value : fn(value)` (Ramda's `unless`). Only the first argument is passed on; `this` is
 * forwarded. With a type guard, `fn` receives the input minus the guarded type, and the values that pass keep the guarded type.
 * @template T - The input type of the predicate
 * @template S - The type the predicate guards
 * @template R - The return type of `fn`
 * @param {(value: T) => value is S} predicate - Decides whether the value is kept as it is
 * @param {(value: Exclude<T, S>) => R} fn - Transforms the values that fail
 * @returns {<V extends T>(value: V) => (V & S) | R} The conditional function
 * @throws {TypeError} when `predicate` or `fn` is not a function
 * @example
 * const toArray = unless(Array.isArray, function (value: unknown) { return [value]; });
 * toArray([1, 2]); // => [1, 2]
 * toArray(3); // => [3]
 */
export function unless<T, S extends T, R>(predicate: (value: T) => value is S, fn: (value: Exclude<T, S>) => R): <V extends T>(value: V) => (V & S) | R;
export function unless<T, R>(predicate: (value: T) => unknown, fn: (value: T) => R): <V extends T>(value: V) => V | R;
/**
 * Implementation of {@link unless} (see the first overload for the full documentation).
 * @param {AnyFunction} predicate - Decides whether the value is kept as it is
 * @param {AnyFunction} fn - Transforms the values that fail
 * @returns {(value: unknown) => unknown} The conditional function
 * @throws {TypeError} when `predicate` or `fn` is not a function
 */
export function unless(predicate: AnyFunction, fn: AnyFunction): (value: unknown) => unknown {
	return conditional('unless', predicate as UnknownFunction, fn as UnknownFunction, true);
}

/**
 * A `[predicate, transform]` pair of {@link cond}.
 * @template A - The argument types
 * @template R - The transform's result type
 */
export type CondPair<A extends unknown[], R> = readonly [predicate: (...args: A) => unknown, transform: (...args: A) => R];

/**
 * Creates a function that tries each `[predicate, transform]` pair in order and returns `transform(...args)` for the first predicate that
 * returns a truthy value for the same arguments, or `undefined` when none does (Ramda's `cond`, lodash's `cond`). Later predicates are
 * not called once one matches. Every argument and `this` are passed to both functions. The pairs are copied (and validated) when the
 * function is created, so changing the array afterwards has no effect. End with a catch-all pair (`[constant(true), …]`) for a default.
 * Typed per pair for up to six pairs (the result is the union of the transforms' results, and `undefined`); longer lists, or arrays,
 * need transforms of one result type.
 * @template A - The argument types
 * @template R1 - The result type of the (first) transform
 * @param {readonly [CondPair<A, R1>]} pairs - The `[predicate, transform]` pairs
 * @returns {(...args: A) => R1 | undefined} The function
 * @throws {TypeError} when `pairs` is not an array, or one of its items is not an array of two functions
 * @example
 * const sign = cond([
 *   [function (n: number) { return n < 0; }, function () { return 'negative'; }],
 *   [function (n: number) { return n === 0; }, function () { return 'zero'; }],
 *   [constant(true), function (n: number) { return `positive (${n})`; }]
 * ]);
 * sign(-5); // => 'negative'
 * sign(0); // => 'zero'
 * sign(7); // => 'positive (7)'
 * const fizz = cond([[function (n: number, by: number) { return n % by === 0; }, function (n: number, by: number) { return n / by; }]]);
 * fizz(9, 3); // => 3
 * fizz(10, 3); // => undefined
 */
export function cond<A extends unknown[], R1>(pairs: readonly [CondPair<A, R1>]): (...args: A) => R1 | undefined;
export function cond<A extends unknown[], R1, R2>(pairs: readonly [CondPair<A, R1>, CondPair<A, R2>]): (...args: A) => R1 | R2 | undefined;
export function cond<A extends unknown[], R1, R2, R3>(pairs: readonly [CondPair<A, R1>, CondPair<A, R2>, CondPair<A, R3>]): (...args: A) => R1 | R2 | R3 | undefined;
export function cond<A extends unknown[], R1, R2, R3, R4>(
	pairs: readonly [CondPair<A, R1>, CondPair<A, R2>, CondPair<A, R3>, CondPair<A, R4>]
): (...args: A) => R1 | R2 | R3 | R4 | undefined;
export function cond<A extends unknown[], R1, R2, R3, R4, R5>(
	pairs: readonly [CondPair<A, R1>, CondPair<A, R2>, CondPair<A, R3>, CondPair<A, R4>, CondPair<A, R5>]
): (...args: A) => R1 | R2 | R3 | R4 | R5 | undefined;
export function cond<A extends unknown[], R1, R2, R3, R4, R5, R6>(
	pairs: readonly [CondPair<A, R1>, CondPair<A, R2>, CondPair<A, R3>, CondPair<A, R4>, CondPair<A, R5>, CondPair<A, R6>]
): (...args: A) => R1 | R2 | R3 | R4 | R5 | R6 | undefined;
export function cond(pairs: readonly []): (...args: unknown[]) => undefined;
export function cond<A extends unknown[], R>(pairs: ReadonlyArray<CondPair<A, R>>): (...args: A) => R | undefined;
/**
 * Implementation of {@link cond} (see the first overload for the full documentation).
 * @param {ReadonlyArray<readonly [AnyFunction, AnyFunction]>} pairs - The `[predicate, transform]` pairs
 * @returns {(...args: unknown[]) => unknown} The function
 * @throws {TypeError} when `pairs` is not an array, or one of its items is not an array of two functions
 */
export function cond(pairs: ReadonlyArray<readonly [AnyFunction, AnyFunction]>): (...args: unknown[]) => unknown {
	if (!Array.isArray(pairs)) throw new TypeError(`cond: \`pairs\` must be an array, got ${describe(pairs)}`);
	// Two flat arrays of functions: monomorphic, and immune to later changes of `pairs`.
	const predicates: UnknownFunction[] = [];
	const transforms: UnknownFunction[] = [];
	for (let index = 0; index < pairs.length; index++) {
		const pair: unknown = pairs[index];
		if (!Array.isArray(pair)) throw new TypeError(`cond: \`pairs[${index}]\` must be a [predicate, transform] pair, got ${describe(pair)}`);
		// Each read once: a getter could give another value the second time.
		const predicate: unknown = pair[0];
		const transform: unknown = pair[1];
		assertFunction('cond', `pairs[${index}][0]`, predicate);
		assertFunction('cond', `pairs[${index}][1]`, transform);
		predicates.push(predicate as UnknownFunction);
		transforms.push(transform as UnknownFunction);
	}
	const count = predicates.length;
	// Up to three arguments (an `Array.prototype.map` callback gets three) are passed with `call`, which V8 optimises much better than
	// `apply` with an argument list.
	return function condition(this: unknown, a?: unknown, b?: unknown, c?: unknown): unknown {
		const length = arguments.length;
		for (let index = 0; index < count; index++) {
			if (length === 1) {
				if (predicates[index].call(this, a)) return transforms[index].call(this, a);
			} else if (length === 3) {
				if (predicates[index].call(this, a, b, c)) return transforms[index].call(this, a, b, c);
			} else if (length === 2) {
				if (predicates[index].call(this, a, b)) return transforms[index].call(this, a, b);
			} else {
				// eslint-disable-next-line prefer-rest-params -- see above
				const args = arguments as unknown as unknown[];
				if (predicates[index].apply(this, args)) return transforms[index].apply(this, args);
			}
		}
		return undefined;
	};
}

/**
 * Calls `fn` `n` times with the indexes `0` to `n - 1` and collects the results in a new array.
 * @template R - The return type of `fn`
 * @param {number} n - Number of calls (an integer between `0` and `2^32 - 1`)
 * @param {(index: number) => R} fn - Called with each index
 * @returns {R[]} The results, in index order
 * @throws {TypeError} when `fn` is not a function, or `n` is not a number
 * @throws {RangeError} when `n` is not an integer between `0` and `2^32 - 1`
 * @example
 * times(3, function (i) { return i * i; }); // => [0, 1, 4]
 * times(0, Math.random); // => []
 */
export function times<R>(n: number, fn: (index: number) => R): R[] {
	// 2^32 - 1, the largest array length (written out so that the message is a constant).
	assertNumber('times', 'n', n, Number.isInteger(n) && n >= 0 && n <= 4294967295, 'an integer between 0 and 4294967295');
	assertFunction('times', 'fn', fn);

	// Preallocated (about 3x faster than growing with `push`); every slot is filled before the array is returned.
	const result = new Array<R>(n);

	for (let i = 0; i < n; i++) result[i] = fn(i);

	return result;
}

/**
 * Reverses a tuple type. Non-tuple arrays (rest parameters) are returned unchanged, and optional trailing elements are dropped.
 * @template T - The tuple to reverse
 * @example
 * type R = Reverse<[number, string, boolean]>; // [boolean, string, number]
 */
export type Reverse<T extends unknown[]> = number extends T['length'] ? T : T extends [infer Head, ...infer Tail] ? [...Reverse<Tail>, Head] : [];

/**
 * Creates a function that invokes `fn` with the arguments it receives in reverse order. `this` is forwarded.
 * Only the arguments actually passed are reversed, so `flip(f)(a, b)` calls `f(b, a)` whatever `f.length` is. `flip(flip(f))` behaves like `f`.
 * @template A - The parameter types of `fn`
 * @template R - The return type of `fn`
 * @param {(...args: A) => R} fn - The function whose arguments should be flipped
 * @returns {(...args: Reverse<A>) => R} The flipped function
 * @throws {TypeError} when `fn` is not a function
 * @example
 * function divide(a: number, b: number): number { return a / b; }
 * flip(divide)(2, 10); // => 5
 */
export function flip<A extends unknown[], R>(fn: (...args: A) => R): (...args: Reverse<A>) => R {
	assertFunction('flip', 'fn', fn);

	const call = fn as unknown as UnknownFunction;

	return function flipped(this: unknown, ...args: unknown[]): unknown {
		return forward(call, this, args.reverse());
	} as unknown as (...args: Reverse<A>) => R;
}

/**
 * Creates a function that invokes `fn` with only its first argument, ignoring the others. `this` is forwarded.
 * Useful with callbacks that receive extra arguments, such as `Array.prototype.map`'s index.
 * @template T - The type of the first argument
 * @template R - The return type of `fn`
 * @param {(arg: T) => R} fn - The function to restrict
 * @returns {(arg: T) => R} A function accepting (and forwarding) a single argument
 * @throws {TypeError} when `fn` is not a function
 * @example
 * ['1', '2', '3'].map(unary(parseInt)); // => [1, 2, 3] // instead of [1, NaN, NaN]
 */
export function unary<T, R>(fn: (arg: T) => R): (arg: T) => R {
	assertFunction('unary', 'fn', fn);

	return function unaryWrapper(this: unknown, arg: T): R {
		return (fn as (this: unknown, arg: T) => R).call(this, arg);
	};
}

/**
 * Creates a function that ignores its arguments and always returns `value` (the same reference every time).
 * @template T - The value type
 * @param {T} value - The value to return
 * @returns {(...args: unknown[]) => T} A function returning `value`
 * @example
 * const zero = constant(0);
 * [1, 2].map(zero); // => [0, 0]
 */
export function constant<T>(value: T): (..._args: unknown[]) => T {
	return function constantValue(): T {
		return value;
	};
}

/**
 * Compares two argument lists element-wise with SameValueZero (`===`, except that `NaN` equals `NaN`). Lists of different lengths differ.
 * @param {ReadonlyArray<unknown>} next - The new arguments
 * @param {ReadonlyArray<unknown>} previous - The cached arguments
 * @returns {boolean} `true` when both lists hold the same values
 * @example
 * shallowEqualArgs([1, NaN], [1, NaN]); // => true
 */
export function shallowEqualArgs(next: ReadonlyArray<unknown>, previous: ReadonlyArray<unknown>): boolean {
	if (next.length !== previous.length) return false;

	for (let i = 0; i < next.length; i++) {
		if (!sameValueZero(next[i], previous[i])) return false;
	}

	return true;
}

/**
 * SameValueZero equality: like `===`, but `NaN` equals `NaN`.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @returns {boolean} Whether the values are SameValueZero-equal
 */
function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (a !== a && b !== b);
}

/**
 * A function memoized with {@link memoizeLast}.
 * @template F - The original function type
 */
export type MemoizedLast<F extends AnyFunction> = F & {
	/** Forgets the cached call, so the next call invokes the function. */
	clear(): void;
};

/**
 * Creates a function that remembers only its latest call: when called again with equal arguments (and the same `this`), it returns the
 * cached result without invoking `fn`; otherwise it invokes `fn` and replaces the cache. Unlike {@link memoize}, memory use is constant.
 * Arguments are compared with `isEqual` (default: same length and SameValueZero element by element, see {@link shallowEqualArgs});
 * `this` is compared with SameValueZero. If `fn` throws, nothing is cached and the previous cache entry is kept.
 * @template F - The type of the function to memoize
 * @param {F} fn - The function to memoize
 * @param {(next: Parameters<F>, previous: Parameters<F>) => boolean} [isEqual=shallowEqualArgs] - Decides whether two argument lists are equal
 * @returns {MemoizedLast<F>} The memoized function, with a `.clear()` method
 * @throws {TypeError} when `fn` or `isEqual` is not a function
 * @example
 * const area = memoizeLast(function (w: number, h: number): number { return w * h; });
 * area(2, 3); // => 6 // computed
 * area(2, 3); // => 6 // cached
 * area(3, 3); // => 9 // computed, replaces the cache
 */
export function memoizeLast<F extends AnyFunction>(fn: F, isEqual: (next: Parameters<F>, previous: Parameters<F>) => boolean = shallowEqualArgs): MemoizedLast<F> {
	assertFunction('memoizeLast', 'fn', fn);
	assertFunction('memoizeLast', 'isEqual', isEqual);

	const call = fn as unknown as UnknownFunction;
	const equal = isEqual as unknown as (next: unknown[], previous: unknown[]) => boolean;
	let cache: { thisArg: unknown; args: unknown[]; result: unknown } | undefined;

	/**
	 * The memoized wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {unknown} The cached or freshly computed result
	 */
	function memoizedLast(this: unknown, ...args: unknown[]): unknown {
		if (cache !== undefined && sameValueZero(cache.thisArg, this) && equal(args, cache.args)) return cache.result;

		const result = call.apply(this, args);
		cache = { thisArg: this, args, result };

		return result;
	}

	Object.defineProperty(memoizedLast, 'clear', {
		value: function clear(): void {
			cache = undefined;
		}
	});

	return memoizedLast as unknown as MemoizedLast<F>;
}

// ---------------------------------------------------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The values a discriminant ("tag") property may hold to be matched by {@link match}: they are looked up as handler names with `String`.
 */
type MatchTag = string | number | boolean | bigint | null | undefined;

/**
 * One handler per member of the union `T`, keyed by the member's `K` tag, each receiving the narrowed member.
 * @template T - The discriminated union
 * @template K - The discriminant key
 */
export type MatchCases<T, K extends keyof T> = { [V in T[K] & MatchTag as `${V}`]: (value: Extract<T, { readonly [P in K]: V }>) => unknown };

/**
 * The handlers accepted by {@link match}: either one per tag (exhaustive), or any subset of them plus a `_` fallback receiving the other members.
 * @template T - The discriminated union
 * @template K - The discriminant key
 */
export type MatchHandlers<T, K extends keyof T> = MatchCases<T, K> | (Partial<MatchCases<T, K>> & { _: (value: T) => unknown });

/**
 * The union of the return types of a set of handlers.
 * @template H - The handlers object
 */
export type MatchResult<H> = { [P in keyof H]-?: H[P] extends (...args: never[]) => infer R ? R : never }[keyof H];

/**
 * Exhaustive pattern matching on a discriminated union: calls the handler named after `value[key]` (the "tag") with `value`, and returns
 * its result. Each handler's argument is narrowed to the matching union member, the result is the union of the handlers' return types,
 * and leaving out a tag is a compile error unless a `_` handler catches the remaining ones (a tag literally named `'_'` is handled by `_`).
 * Boolean, number, `null` and `undefined` tags are matched by their string form (`true`, `404`, `null`).
 *
 * At runtime only own properties of `handlers` count (a tag such as `'toString'` or `'__proto__'` never reaches `Object.prototype`). A
 * tag without a handler and no `_` (data that does not match its type, e.g. from an API) throws an `AssertionError` naming the key and
 * the tag, like `assertNever`.
 * @template T - The discriminated union
 * @template K - The discriminant key
 * @template H - The handlers object
 * @param {T} value - The value to match (an object)
 * @param {K} key - The discriminant property
 * @param {H} handlers - The handlers, by tag, optionally with a `_` fallback
 * @returns {MatchResult<H>} The result of the matching handler
 * @throws {TypeError} when `value` is not an object, or the matching handler is not a function
 * @throws {AssertionError} when no handler matches the tag and there is no `_` fallback
 * @example
 * type Shape = { kind: 'circle'; radius: number } | { kind: 'rect'; width: number; height: number };
 * function area(shape: Shape): number {
 *   return match(shape, 'kind', {
 *     circle: function (circle) { return Math.round(Math.PI * circle.radius ** 2); },
 *     rect: function (rect) { return rect.width * rect.height; }
 *   });
 * }
 * area({ kind: 'rect', width: 2, height: 3 }); // => 6
 * area({ kind: 'circle', radius: 1 }); // => 3
 * area({ kind: 'hexagon' } as unknown as Shape); // throws AssertionError
 * @example
 * type Result = { ok: true; value: number } | { ok: false; error: string };
 * const result: Result = { ok: false, error: 'offline' };
 * match(result, 'ok', { true: function (success) { return success.value; }, _: function () { return 0; } }); // => 0
 */
export function match<T extends object, K extends keyof T, H extends MatchHandlers<T, K>>(value: T, key: K, handlers: H): MatchResult<H> {
	// Functions too: `T extends object` accepts callable members (a function with a `kind` property).
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) throw new TypeError(`match: \`value\` must be an object, got ${describe(value)}`);

	const tag = String(value[key]);
	// A key present with an `undefined` value (allowed by the `Partial` handler types) counts as absent, so `_` handles that member.
	const own = (Object.hasOwn(handlers, tag) ? handlers[tag as keyof H] : undefined) as unknown;
	const handler = own === undefined && Object.hasOwn(handlers, '_') ? (handlers['_' as keyof H] as unknown) : own;

	// The tag may come from untrusted data: quote at most 100 characters of it, so that the message stays safe to log.
	if (handler === undefined) throw new AssertionError(`match: no handler for \`${String(key)}\` ${JSON.stringify(tag.slice(0, 100))}`);
	// A tag without its own handler fell back to `_` (and may be untrusted): name the handler actually used.
	assertFunction('match', `handlers.${own === undefined ? '_' : tag}`, handler);

	return (handler as (value: T) => unknown)(value) as MatchResult<H>;
}

// ---------------------------------------------------------------------------------------------------------------------
// matchWith / matcher: patterns
// ---------------------------------------------------------------------------------------------------------------------

/** The brand carrying a pattern helper's kind and type arguments, for the types below only: it never exists at runtime. */
declare const patternHelper: unique symbol;

/**
 * The type-level description of a pattern helper ({@link capture}, {@link active}, {@link anyOf}, {@link cons}).
 * @template K - The helper's kind and type arguments
 */
interface PatternHelper<K> {
	/** The helper's kind and type arguments. */
	readonly [patternHelper]: K;
}

/**
 * A pattern created by {@link capture} or {@link captureAs}: it matches what `P` matches, and binds the matched value (or, when `P` is an
 * {@link active} pattern, the value it extracted) to `Name`, or anonymously when `Name` is `undefined`. Called directly, it tests a value
 * as {@link isMatching} would test `P` (outside {@link matchWith} and {@link matcher}, a capture binds nothing).
 *
 * The pattern types are intersections, not interfaces: TypeScript skips an argument holding a call to a generic function that returns a
 * plain function type while it infers a call's type parameters (to infer higher-order functions), which would lose a case's pattern type
 * when its handler is not an inline function.
 * @template Name - The capture's name, `undefined` for an anonymous capture
 * @template P - The captured pattern
 */
export type CapturePattern<Name extends string | undefined, P> = PatternHelper<['capture', Name, P]> & ((value: unknown) => value is PatternType<P>);

/**
 * A pattern created by {@link active}: it matches the values for which its function returns something other than `undefined`, and binds
 * that result. It narrows nothing (the handler receives the value as typed at the pattern's position) and never counts toward
 * exhaustiveness; in {@link matchWith} and {@link matcher}, every value its position may hold must be assignable to `A` (a compile error
 * otherwise, since the function is called with whatever is there).
 * @template A - The parameter type of the function
 * @template R - The return type of the function (`undefined` for no match)
 */
export type ActivePattern<A, R> = PatternHelper<['active', A, R]> & ((value: unknown) => value is unknown);

/**
 * A pattern created by {@link anyOf}: it matches what any of the patterns `P` matches (the first that does binds its captures).
 * @template P - The alternative patterns
 */
export type AnyOfPattern<P extends readonly unknown[]> = PatternHelper<['anyOf', P]> & ((value: unknown) => value is PatternType<P[number]>);

/**
 * A pattern created by {@link cons}: it matches non-empty arrays whose first element matches `H` and whose other elements, as a new
 * array, match `T`.
 * @template H - The pattern of the first element
 * @template T - The pattern of the array of the other elements
 */
export type ConsPattern<H, T> = PatternHelper<['cons', H, T]> &
	((value: unknown) => value is [PatternType<H>, ...(PatternType<T> extends readonly unknown[] ? PatternType<T> : unknown[])]);

/** The kind of a {@link capture} or {@link captureAs} pattern. */
const CAPTURE = 0;
/** The kind of an {@link active} pattern. */
const ACTIVE = 1;
/** The kind of an {@link anyOf} pattern. */
const ANY_OF = 2;
/** The kind of a {@link cons} pattern. */
const CONS = 3;

/** A pattern helper, as the matcher sees it. */
interface PatternRecord {
	/** {@link CAPTURE}, {@link ACTIVE}, {@link ANY_OF} or {@link CONS}. */
	readonly kind: number;
	/** The nested patterns: the captured pattern, the alternatives, or the head and tail patterns (none for an active pattern). */
	readonly patterns: ReadonlyArray<unknown>;
	/** The name of a capture (`undefined` when anonymous). */
	readonly name?: string;
	/** Whether a capture binds the value its active pattern extracts, instead of the value it matches. */
	readonly absorbs?: boolean;
	/** The function of an active pattern. */
	readonly extract?: (value: unknown) => unknown;
}

/** The key under which the function standing for a pattern helper holds its record (private: no other code can create helpers). */
const HELPER = Symbol('pattern helper');

/**
 * The record of a pattern helper.
 * @param {unknown} pattern - A pattern
 * @returns {PatternRecord | undefined} Its record, when it is a pattern helper
 */
function helperOf(pattern: unknown): PatternRecord | undefined {
	return typeof pattern === 'function' ? (pattern as { [HELPER]?: PatternRecord })[HELPER] : undefined;
}

/** The selection of a case whose pattern captures nothing: its handler receives the matched value only. */
const NO_SELECTION = {};

/** `Object.prototype.hasOwnProperty`, captured before any user code runs. */
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Whether `Array.prototype` (or `Object.prototype`) has an enumerable property, which the holes of an array would then read: array
 * elements are then read as own properties only, like {@link isMatching} does.
 * @returns {boolean} Whether array elements must be read as own properties
 */
function isArrayPrototypePolluted(): boolean {
	for (const key in Array.prototype) return typeof key === 'string';

	return false;
}

/**
 * Reads an element of an array as a pattern of {@link isMatching} does: a hole reads `undefined`, even when a polluted prototype defines it.
 * @param {unknown[]} array - The array
 * @param {number} index - The index
 * @param {boolean} direct - Whether the prototypes are known to be clean (see {@link isArrayPrototypePolluted})
 * @returns {unknown} The element
 */
function elementOf(array: unknown[], index: number, direct: boolean): unknown {
	return direct || hasOwn.call(array, index) ? array[index] : undefined;
}

/**
 * Reads the prototype of an object.
 * @param {object} value - The object
 * @returns {object | null | undefined} Its prototype, or `undefined` for a revoked proxy (which is not a plain object)
 */
function prototypeOf(value: object): object | null | undefined {
	try {
		return Object.getPrototypeOf(value) as object | null;
	} catch {
		return undefined;
	}
}

/**
 * The own enumerable keys of a plain-object pattern, strings then symbols, which {@link isMatching} checks.
 * @param {object} pattern - The pattern
 * @returns {PropertyKey[]} The keys
 */
function patternKeys(pattern: object): PropertyKey[] {
	const keys: PropertyKey[] = Object.keys(pattern);

	for (const symbol of Object.getOwnPropertySymbols(pattern)) if (Object.prototype.propertyIsEnumerable.call(pattern, symbol)) keys.push(symbol);

	return keys;
}

/**
 * Throws the error of a pattern that contains itself.
 * @param {string} caller - Name of the public function, used in the error message
 * @returns {never} Never returns
 * @throws {TypeError} always
 */
function circularPattern(caller: string): never {
	throw new TypeError(`${caller}: \`pattern\` must be acyclic, got a circular reference`);
}

/**
 * Creates the function standing for a pattern helper in patterns. Called directly (as a guard, e.g. by {@link isMatching} or inside
 * another guard), it tests a value and binds nothing.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {PatternRecord} record - The helper
 * @returns {AnyFunction} The pattern
 */
function register(caller: string, record: PatternRecord): AnyFunction {
	/**
	 * Tests a value against the helper.
	 * @param {unknown} value - The value
	 * @returns {boolean} Whether it matches
	 */
	function pattern(value: unknown): boolean {
		return testHelper(caller, record, value, undefined, 0);
	}

	(pattern as { [HELPER]?: PatternRecord })[HELPER] = record;

	return pattern;
}

/**
 * How deep {@link test} goes into a pattern before checking that it is acyclic: only a cycle (matched against an equally deep value)
 * makes a pattern this deep, and checking at that depth only keeps acyclic patterns free of the cost.
 */
const CYCLE_CHECK_DEPTH = 64;

/**
 * Tests a value against a pattern, with the semantics of {@link isMatching} but without compiling it (see {@link matchWith}), and records
 * what its helpers capture in `log`.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} pattern - The pattern
 * @param {unknown} value - The value
 * @param {unknown[] | undefined} log - The captures so far, as pairs of a name (`undefined` when anonymous) and a value; `undefined` to bind nothing
 * @param {number} depth - How many objects and arrays of the pattern enclose this one
 * @returns {boolean} Whether `value` matches
 * @throws {TypeError} when the test follows a cycle of the pattern
 */
function test(caller: string, pattern: unknown, value: unknown, log: unknown[] | undefined, depth: number): boolean {
	if (typeof pattern === 'function') {
		const record = helperOf(pattern);

		return record === undefined ? Boolean(pattern(value)) : testHelper(caller, record, value, log, depth);
	}
	if (typeof pattern !== 'object' || pattern === null) return sameValueZero(value, pattern);

	const array = Array.isArray(pattern);

	// The checks of `isMatching` (`isDate`, then `isPlainObject`), with one prototype read for the usual object literal, which is neither
	// a date nor anything but plain (only an object without prototype, or of another realm, can be a date without inheriting from `Date`).
	if (!array) {
		const prototype = prototypeOf(pattern);

		if (prototype !== Object.prototype) {
			if (isDate(pattern)) return isDate(value) && sameValueZero(Date.prototype.getTime.call(value), Date.prototype.getTime.call(pattern));
			// Other objects (maps, class instances…) are compared by identity.
			if (prototype !== null) return value === pattern;
		}
	}
	if (array ? !Array.isArray(value) || value.length !== pattern.length : typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	if (depth === CYCLE_CHECK_DEPTH) scan(caller, pattern, [], [], new Map());
	if (array) {
		const direct = !isArrayPrototypePolluted();

		for (let index = 0; index < pattern.length; index++) if (!test(caller, pattern[index], elementOf(value as unknown[], index, direct), log, depth + 1)) return false;

		return true;
	}
	// `for…in` visits the own enumerable string keys in the order of `Object.keys` (and inherited ones, skipped), without allocating them.
	for (const key in pattern) if (hasOwn.call(pattern, key) && !testProperty(caller, pattern, key, value as object, log, depth)) return false;
	const symbols = Object.getOwnPropertySymbols(pattern);

	for (let index = 0; index < symbols.length; index++) {
		if (Object.prototype.propertyIsEnumerable.call(pattern, symbols[index]) && !testProperty(caller, pattern, symbols[index], value as object, log, depth)) return false;
	}

	return true;
}

/**
 * Tests a property of an object against the pattern of that key (see {@link test}).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {object} pattern - The object pattern
 * @param {PropertyKey} key - The key
 * @param {object} value - The object
 * @param {unknown[] | undefined} log - The captures so far, or `undefined` to bind nothing
 * @param {number} depth - The depth of the object pattern
 * @returns {boolean} Whether the property matches
 */
function testProperty(caller: string, pattern: object, key: PropertyKey, value: object, log: unknown[] | undefined, depth: number): boolean {
	const inner = (pattern as Record<PropertyKey, unknown>)[key];

	// A missing (or inherited) property fails, except for a function pattern, which is called with `undefined`.
	return hasOwn.call(value, key)
		? test(caller, inner, (value as Record<PropertyKey, unknown>)[key], log, depth + 1)
		: typeof inner === 'function' && test(caller, inner, undefined, log, depth + 1);
}

/**
 * Tests a value against a pattern helper (see {@link test}).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {PatternRecord} record - The helper
 * @param {unknown} value - The value
 * @param {unknown[] | undefined} log - The captures so far, or `undefined` to bind nothing
 * @param {number} depth - How many objects and arrays of the pattern enclose this one
 * @returns {boolean} Whether `value` matches
 */
function testHelper(caller: string, record: PatternRecord, value: unknown, log: unknown[] | undefined, depth: number): boolean {
	const patterns = record.patterns;

	if (record.kind === ACTIVE) {
		// Called once: its result is both the test and the captured value.
		const result = (record.extract as (value: unknown) => unknown)(value);

		if (result === undefined) return false;
		log?.push(undefined, result);

		return true;
	}
	if (record.kind === ANY_OF) {
		const mark = log?.length;

		for (let index = 0; index < patterns.length; index++) {
			if (test(caller, patterns[index], value, log, depth)) return true;
			// Forget what a failed alternative captured before failing.
			if (log !== undefined) log.length = mark as number;
		}

		return false;
	}
	if (record.kind === CONS) {
		if (!Array.isArray(value) || value.length === 0) return false;

		const direct = !isArrayPrototypePolluted();

		if (!test(caller, patterns[0], elementOf(value, 0, direct), log, depth)) return false;
		if (patterns[1] === _) return true;

		// A new dense array, as a pattern of `isMatching` reads the elements.
		const tail = new Array<unknown>(value.length - 1);

		for (let index = 1; index < value.length; index++) tail[index - 1] = elementOf(value, index, direct);

		return test(caller, patterns[1], tail, log, depth);
	}

	if (!test(caller, patterns[0], value, log, depth)) return false;
	// A capture of an active pattern names the value that pattern extracted (its entry is the last one), instead of the matched value.
	if (log !== undefined) {
		if (record.absorbs) log[log.length - 2] = record.name;
		else log.push(record.name, value);
	}

	return true;
}

/**
 * Lists what a pattern captures, in `log` (pairs of a name and `undefined`), as {@link test} would on a match, and checks that it is acyclic.
 * Each object, array and helper is scanned once per `memo`, so a pattern that shares sub-patterns (`anyOf([x, 1], [x, 2])`, nested)
 * costs time linear in its distinct parts, not in its expanded size.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} pattern - The pattern
 * @param {unknown[]} log - Receives the captures
 * @param {unknown[]} ancestors - The object patterns around this one
 * @param {Map<unknown, unknown[] | false>} memo - The parts already scanned: what each captures, or `false` when it holds no helper
 * @returns {boolean} Whether the pattern contains a pattern helper
 * @throws {TypeError} when the pattern contains itself
 */
function scan(caller: string, pattern: unknown, log: unknown[], ancestors: unknown[], memo: Map<unknown, unknown[] | false>): boolean {
	const record = helperOf(pattern);
	const array = Array.isArray(pattern);

	if (record === undefined && !array && !isPlainObject(pattern)) return false;

	const known = memo.get(pattern);

	if (known !== undefined) {
		if (known === false) return false;
		for (let index = 0; index < known.length; index++) log.push(known[index]);

		return true;
	}

	const start = log.length;
	let found = record !== undefined;

	if (record !== undefined) {
		if (record.kind === ACTIVE) log.push(undefined, undefined);
		// The alternatives of `anyOf` capture the same names, so only the first one's are listed (the others are still checked for cycles).
		for (let index = 0; index < record.patterns.length; index++) scan(caller, record.patterns[index], record.kind === ANY_OF && index > 0 ? [] : log, ancestors, memo);
		if (record.absorbs) log[log.length - 2] = record.name;
		else if (record.kind === CAPTURE) log.push(record.name, undefined);
	} else {
		// A part being scanned is not in `memo` yet: meeting it again is a cycle.
		if (ancestors.includes(pattern)) circularPattern(caller);
		ancestors.push(pattern);
		if (array) for (let index = 0; index < pattern.length; index++) found = scan(caller, pattern[index], log, ancestors, memo) || found;
		else for (const key of patternKeys(pattern as object)) found = scan(caller, (pattern as Record<PropertyKey, unknown>)[key], log, ancestors, memo) || found;
		ancestors.pop();
	}
	memo.set(pattern, found && log.slice(start));

	return found;
}

/**
 * Builds the selection a handler receives from the captures of a match: nothing, the value of the anonymous capture, or an object (with
 * no prototype) of the named ones.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown[]} log - The captures, as pairs of a name (`undefined` when anonymous) and a value
 * @returns {unknown} The selection, or {@link NO_SELECTION}
 * @throws {TypeError} when the captures mix anonymous and named ones, or repeat one
 */
function select(caller: string, log: unknown[]): unknown {
	if (log.length === 0) return NO_SELECTION;
	if (log[0] === undefined) {
		if (log.length > 2) {
			throw new TypeError(
				`${caller}: \`pattern\` must capture ${log[2] === undefined ? 'at most one anonymous value, got several' : 'either one anonymous value or named values, got both'}`
			);
		}

		return log[1];
	}

	const selection: Record<string, unknown> = Object.create(null);

	for (let index = 0; index < log.length; index += 2) {
		const name = log[index] as string | undefined;

		if (name === undefined) throw new TypeError(`${caller}: \`pattern\` must capture either one anonymous value or named values, got both`);
		if (hasOwn.call(selection, name)) throw new TypeError(`${caller}: \`pattern\` must capture each name once, got ${JSON.stringify(name)} twice`);
		selection[name] = log[index + 1];
	}

	return selection;
}

/**
 * Calls a handler (or `when` guard) of a case with its selection, if any, and the matched value.
 * @param {unknown} fn - The handler
 * @param {unknown} selection - The selection, or {@link NO_SELECTION}
 * @param {unknown} value - The matched value
 * @returns {unknown} What the handler returns
 */
function callCase(fn: unknown, selection: unknown, value: unknown): unknown {
	return selection === NO_SELECTION ? (fn as UnknownFunction)(value) : (fn as UnknownFunction)(selection, value);
}

/**
 * The wildcard pattern: matches any value, including `undefined` for a property that is missing (like every function in a pattern of
 * {@link isMatching}). A case whose pattern is `_` handles every remaining value, so it ends an exhaustive {@link matchWith}.
 * @param {unknown} _value - The value
 * @returns {boolean} Always `true`
 * @example
 * import { isMatching } from 'tinkit/guards';
 * _(undefined); // => true
 * isMatching({ id: _ })({}); // => true // the property may be missing
 * isMatching([_, 'end'])(['anything', 'end']); // => true
 */
export function _(_value: unknown): _value is unknown {
	return true;
}

/**
 * Creates a pattern that matches what `pattern` matches (anything, by default) and passes the matched value to the handler, F#'s `as`:
 * a case whose pattern holds an anonymous capture calls its handler (and `when` guard) with the captured value first and the whole
 * matched value second. Use {@link captureAs} to name captures. A capture of an {@link active} pattern binds the value it extracted.
 *
 * Captures bind when they are part of a case's pattern (in its objects and arrays, or in {@link anyOf}, {@link cons} and other captures);
 * inside another guard (`isArrayOf(capture())`) or {@link isMatching}, a capture only tests its pattern. A pattern captures either one
 * anonymous value or named values: mixing them is a compile error; capturing several anonymous values, or a name twice, type-checks (the
 * types merge them) but, like mixing, throws a `TypeError` when the case matches ({@link matcher}: when the case is added).
 * @template P - The captured pattern
 * @param {P} [pattern] - The pattern to capture (a value, a guard, or plain objects and arrays of those); omitted, it matches anything
 * @returns {CapturePattern<undefined, P>} The pattern
 * @example
 * type Event = { type: 'move'; to: { x: number; y: number } } | { type: 'quit' };
 * function describeEvent(event: Event): string {
 *   return matchWith(event)
 *     .with({ type: 'move', to: capture() }, function (to) { return `move to ${to.x},${to.y}`; })
 *     .with({ type: 'quit' }, function () { return 'quit'; })
 *     .exhaustive();
 * }
 * describeEvent({ type: 'move', to: { x: 1, y: 2 } }); // => 'move to 1,2'
 */
export function capture(): CapturePattern<undefined, typeof _>;
export function capture<const P>(pattern: P): CapturePattern<undefined, P>;
/**
 * Implementation of {@link capture} (see the first overload for the full documentation).
 * @param {...unknown} pattern - The captured pattern, if any
 * @returns {AnyFunction} The pattern
 */
export function capture(...pattern: unknown[]): AnyFunction {
	return capturing('capture', undefined, pattern);
}

/**
 * Creates a pattern that matches what `pattern` matches (anything, by default) and passes the matched value to the handler under `name`:
 * a case whose pattern holds named captures calls its handler (and `when` guard) with an object of the captured values (without a
 * prototype, so any name is safe) first and the whole matched value second. See {@link capture} for where captures bind, and for which
 * mistakes are compile errors (mixing with anonymous captures) and which only throw (a name captured twice).
 * @template N - The name
 * @template P - The captured pattern
 * @param {N} name - The name of the captured value
 * @param {P} [pattern] - The pattern to capture; omitted, it matches anything
 * @returns {CapturePattern<N, P>} The pattern
 * @throws {TypeError} when `name` is not a string
 * @example
 * type Line = { from: { x: number; y: number }; to: { x: number; y: number } };
 * const length = matcher<Line>()
 *   .with({ from: captureAs('a'), to: captureAs('b') }, function ({ a, b }) { return Math.hypot(b.x - a.x, b.y - a.y); })
 *   .exhaustive();
 * length({ from: { x: 0, y: 0 }, to: { x: 3, y: 4 } }); // => 5
 */
export function captureAs<const N extends string>(name: N): CapturePattern<N, typeof _>;
export function captureAs<const N extends string, const P>(name: N, pattern: P): CapturePattern<N, P>;
/**
 * Implementation of {@link captureAs} (see the first overload for the full documentation).
 * @param {string} name - The name of the captured value
 * @param {...unknown} pattern - The captured pattern, if any
 * @returns {AnyFunction} The pattern
 * @throws {TypeError} when `name` is not a string
 */
export function captureAs(name: string, ...pattern: unknown[]): AnyFunction {
	if (typeof name !== 'string') throw new TypeError(`captureAs: \`name\` must be a string, got ${describe(name)}`);

	return capturing('captureAs', name, pattern);
}

/**
 * Creates a capture pattern (see {@link capture}).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string | undefined} name - The capture's name, `undefined` when anonymous
 * @param {unknown[]} pattern - The captured pattern, or nothing for the wildcard
 * @returns {AnyFunction} The pattern
 */
function capturing(caller: string, name: string | undefined, pattern: unknown[]): AnyFunction {
	const inner = pattern.length === 0 ? _ : pattern[0];

	return register(caller, { kind: CAPTURE, patterns: [inner], name, absorbs: helperOf(inner)?.kind === ACTIVE });
}

/**
 * Creates an active pattern, F#'s `| Int n ->`: it matches the values for which `extract` returns something other than `undefined`, and
 * binds that result like an anonymous {@link capture} (wrap it in {@link captureAs} to name it). `extract` is called once per test, so
 * testing and extracting never compute twice. An active pattern is partial: it never makes a {@link matchWith} exhaustive. It narrows
 * nothing: in {@link matchWith} and {@link matcher}, `extract` must accept every value its position may hold while the case is tested
 * (a compile error otherwise), whatever the parts of the pattern tested after it would say.
 * @template A - The parameter type of `extract`
 * @template R - The return type of `extract` (`undefined` meaning no match)
 * @param {(value: A) => R} extract - Called with the value at the pattern's position (`undefined` for a missing property)
 * @returns {ActivePattern<A, R>} The pattern
 * @throws {TypeError} when `extract` is not a function
 * @example
 * function toInteger(text: string): number | undefined {
 *   return /^-?\d+$/.test(text) ? Number(text) : undefined;
 * }
 * function parse(input: string): number | string {
 *   return matchWith(input)
 *     .with(active(toInteger), function (n) { return n * 2; })
 *     .otherwise(function (text) { return text.toUpperCase(); });
 * }
 * parse('21'); // => 42
 * parse('abc'); // => 'ABC'
 */
export function active<A, R>(extract: (value: A) => R): ActivePattern<A, R> {
	assertFunction('active', 'extract', extract);

	return register('active', { kind: ACTIVE, patterns: [], extract: extract as (value: unknown) => unknown }) as unknown as ActivePattern<A, R>;
}

/**
 * Creates an or-pattern, F#'s `| A | B ->`: it matches what any of `patterns` matches, trying them in order, and narrows to the union of
 * their types. Like F#, every alternative must capture the same names (or all one anonymous value, or nothing): the alternative that
 * matched binds them. Named after JSON Schema's `anyOf`; unlike `isOneOf` (a set of values) and `isUnion` (guards), it takes any patterns.
 * @template P - The alternative patterns
 * @param {...P} patterns - The alternatives (at least one)
 * @returns {AnyOfPattern<P>} The pattern
 * @throws {RangeError} when no pattern is given
 * @throws {TypeError} when the alternatives capture different names, or one contains itself
 * @example
 * import { isMatching } from 'tinkit/guards';
 * const isCopy = isMatching(anyOf({ key: 'c', ctrl: true }, { key: 'Insert', ctrl: true }));
 * isCopy({ key: 'Insert', ctrl: true }); // => true
 * matchWith('b' as 'a' | 'b' | 'c').with(anyOf('a', 'b'), function () { return 1; }).with('c', function () { return 2; }).exhaustive(); // => 1
 */
export function anyOf<const P extends readonly unknown[]>(...patterns: P): AnyOfPattern<P> {
	if (patterns.length === 0) throw new RangeError('anyOf: expected at least one pattern, got 0');

	let expected = '';
	const memo = new Map<unknown, unknown[] | false>();

	for (let index = 0; index < patterns.length; index++) {
		const log: unknown[] = [];

		scan('anyOf', patterns[index], log, [], memo);

		const names: string[] = [];

		for (let entry = 0; entry < log.length; entry += 2) names.push(log[entry] === undefined ? 'an anonymous value' : JSON.stringify(log[entry]));

		const captured = names.length === 0 ? 'nothing' : names.sort().join(', ');

		if (index === 0) expected = captured;
		else if (captured !== expected) throw new TypeError(`anyOf: \`patterns[${index}]\` must capture what \`patterns[0]\` captures (${expected}), got ${captured}`);
	}

	return register('anyOf', { kind: ANY_OF, patterns }) as unknown as AnyOfPattern<P>;
}

/**
 * Creates a list pattern, F#'s `head :: tail`: it matches non-empty arrays whose first element matches `head` and whose other elements,
 * as a new array, match `tail` (anything, by default). Combine with `[]` (the empty array) for exhaustive recursion over arrays. The tail
 * is a copy, so matching it costs O(n): for long arrays, prefer index loops.
 * @template H - The pattern of the first element
 * @template T - The pattern of the other elements
 * @param {H} head - The pattern of the first element
 * @param {T} [tail] - The pattern of the array of the other elements; omitted (or `undefined`), it matches any array
 * @returns {ConsPattern<H, T>} The pattern
 * @example
 * const sum: (list: number[]) => number = matcher<number[]>()
 *   .with([], function () { return 0; })
 *   .with(cons(captureAs('head'), captureAs('tail')), function ({ head, tail }) { return head + sum(tail); })
 *   .exhaustive();
 * sum([1, 2, 3]); // => 6
 * matchWith(['cmd', '--help']).with(cons('cmd'), function () { return 'command'; }).otherwise(function () { return 'other'; }); // => 'command'
 */
export function cons<const H>(head: H): ConsPattern<H, typeof _>;
export function cons<const H, const T>(head: H, tail: T): ConsPattern<H, T>;
/**
 * Implementation of {@link cons} (see the first overload for the full documentation).
 * @param {unknown} head - The pattern of the first element
 * @param {unknown} [tail] - The pattern of the other elements
 * @returns {AnyFunction} The pattern
 */
export function cons(head: unknown, tail?: unknown): AnyFunction {
	// The tail is always an array, so `undefined` (which no array matches) means "any tail".
	return register('cons', { kind: CONS, patterns: [head, tail === undefined ? _ : tail] });
}

// ---------------------------------------------------------------------------------------------------------------------
// matchWith / matcher: types
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The members of `V` narrowed to those a value of type `T` may be: each member assignable to `T` is kept, an array narrowed by a tuple
 * becomes a tuple of its elements, the others are intersected with `T` (members with a conflicting discriminant reduce to `never`).
 * @template V - The values
 * @template T - The type of the pattern
 */
type Narrow<V, T> = V extends unknown
	? V extends T
		? V
		: V extends readonly unknown[]
			? T extends readonly unknown[]
				? number extends V['length']
					? { [K in keyof T]: Narrow<V[number], T[K]> }
					: V & T
				: V & T
			: V & T
	: never;

/**
 * The value of each member of `V` at key `K`, as a pattern reads it: `undefined` when an object lacks the key (or may, for an index
 * signature); an element, for an array.
 * @template V - The values
 * @template K - The key
 */
type PartOf<V, K> = V extends readonly unknown[]
	? K extends keyof V
		? V[K]
		: V[number]
	: V extends unknown
		? K extends keyof V
			? V[K] | (string extends keyof V ? undefined : number extends keyof V ? undefined : never)
			: undefined
		: never;

/**
 * Whether a value of type `M` always has the property `K` (not optional, not from an index signature).
 * @template M - The value type
 * @template K - The key
 */
type IsPresent<M, K> = M extends Record<K & PropertyKey, unknown> ? true : false;

/**
 * `M` with the property `K` (an element, for a tuple) of type `X`.
 * @template M - The object or tuple type
 * @template K - The key
 * @template X - The new property type
 */
type Replace<M, K, X> = { [I in keyof M]: I extends K ? X : M[I] };

/**
 * Whether a primitive pattern type is a single value (a literal, `null`, `undefined`, a `unique symbol`) rather than a set of values
 * (`string`, `` `id-${string}` ``, `Uppercase<string>`, `` `${number}` ``, `bigint`…), of which a value equal to the pattern covers one.
 * @template P - The pattern type (not a union)
 */
type IsUnit<P> = P extends string | number ? (Record<never, never> extends Record<P, 1> ? false : true) : bigint extends P ? false : symbol extends P ? false : true;

/** The values that an object type may admit but an object pattern never matches (it only matches non-array objects). */
type NonPlain = unknown[] | AnyFunction | string | number | boolean | bigint | symbol;

/**
 * `true` for each member of `T` assignable to `M` (so `true extends Admits<M, T>` when one is).
 * @template M - The type
 * @template T - The candidate values
 */
type Admits<M, T> = T extends M ? true : never;

/**
 * The values of `M` that a case with pattern `P` may leave unhandled: the members that `P` matches entirely are removed (and products,
 * objects and tuples, lose the part `P` matches entirely); every other member is kept, so the result is never too small. An `any` member
 * is only removed by a pattern that matches anything.
 * @template M - The remaining values
 * @template P - The pattern
 */
type Subtract<M, P> = M extends unknown ? (0 extends 1 & M ? ([SubtractMember<unknown, P>] extends [never] ? never : M) : SubtractMember<M, P>) : never;

/**
 * {@link Subtract} for one member `M` (`P` is distributed: a union-typed pattern is one of its members, so only what all of them cover goes).
 * A pattern typed `unknown` or `any` removes nothing, nor does an object pattern that may not be plain (typed `object` or `{}`: it may be
 * a map or a class instance, compared by identity) or a member that may not be a plain object (`{ length: number }` admits arrays and
 * strings, which object patterns never match).
 * @template M - A remaining member
 * @template P - The pattern
 */
type SubtractMember<M, P> = unknown extends P
	? M
	: P extends PatternHelper<infer K>
		? SubtractHelper<M, K>
		: P extends ((value: unknown) => value is infer T)
			? [M] extends [T]
				? never
				: M
			: P extends AnyFunction | Date
				? M
				: P extends readonly unknown[]
					? SubtractTuple<M, P>
					: P extends object
						? [object] extends [P]
							? M
							: M extends AnyFunction | readonly unknown[]
								? M
								: M extends object
									? true extends Admits<M, NonPlain>
										? M
										: // A member the pattern cannot match (a conflicting discriminant) is kept as is, cheaply.
											[M & PatternType<P>] extends [never]
											? M
											: SubtractShape<M, P>
									: M
						: [M] extends [P]
							? IsUnit<P> extends true
								? never
								: M
							: M;

/**
 * {@link Subtract} for a pattern helper: a capture removes what its pattern removes, `anyOf` what its alternatives remove, an active pattern nothing.
 * @template M - A remaining member
 * @template K - The helper's kind and type arguments
 */
type SubtractHelper<M, K> = K extends ['capture', unknown, infer Q]
	? Subtract<M, Q>
	: K extends ['anyOf', infer Ps]
		? SubtractAll<M, Ps>
		: K extends ['cons', infer H, infer T]
			? SubtractCons<M, H, T>
			: M;

/**
 * {@link Subtract} for each pattern of `Ps`, in turn.
 * @template M - The remaining values
 * @template Ps - The patterns
 */
type SubtractAll<M, Ps> = Ps extends readonly [infer A, ...infer Rest] ? SubtractAll<Subtract<M, A>, Rest> : M;

/**
 * The part of an object `M` that a plain-object pattern `P` leaves: `M` itself when a key of `P` removes nothing from `M` (the pattern then
 * covers no whole slice of `M`), otherwise the union, over the keys, of `M` with that key restricted to what the pattern leaves of it.
 * @template M - A remaining object member
 * @template P - The pattern
 * @template X - What the pattern leaves of each key
 */
type SubtractShape<M, P, X = { [K in keyof P]-?: SubtractKey<M, K, P[K]> }> = true extends { [K in keyof X]-?: [PartOf<M, K>] extends [X[K]] ? true : never }[keyof X]
	? M
	: { [K in keyof X]-?: [X[K]] extends [never] ? never : Replace<M, K, X[K]> }[keyof X];

/**
 * What the pattern `Q` of key `K` leaves of `M[K]`: a function pattern sees `undefined` for a missing key, any other pattern needs the
 * key, so it removes nothing from an optional one.
 * @template M - A remaining object member
 * @template K - The key
 * @template Q - The pattern of the key
 */
type SubtractKey<M, K, Q> = Q extends AnyFunction ? Subtract<PartOf<M, K>, Q> : IsPresent<M, K> extends true ? Subtract<M[K & keyof M], Q> : PartOf<M, K>;

/**
 * The part of an array `M` that a tuple pattern `P` leaves: the empty tuple removes the empty array from `T[]` (leaving `[T, ...T[]]`);
 * tuples of the same length are subtracted element by element, like objects.
 * @template M - A remaining member
 * @template P - The tuple pattern
 */
type SubtractTuple<M, P extends readonly unknown[]> = M extends readonly unknown[]
	? number extends M['length']
		? P extends readonly []
			? [] extends M
				? [M[number], ...M]
				: M
			: M
		: number extends P['length']
			? M
			: M['length'] extends P['length']
				? SubtractElements<M, P>
				: M
	: M;

/**
 * {@link SubtractShape} for the elements of a tuple.
 * @template M - A remaining tuple member
 * @template P - The tuple pattern, of the same length
 * @template X - What the pattern leaves of each element
 */
type SubtractElements<
	M extends readonly unknown[],
	P extends readonly unknown[],
	X extends readonly unknown[] = { [K in keyof P]: Subtract<M[K & keyof M], P[K]> }
> = true extends { [K in keyof X]: [M[K & keyof M]] extends [X[K]] ? true : never }[number]
	? M
	: { [K in keyof X]: [X[K]] extends [never] ? never : Replace<M, K, X[K]> }[number];

/**
 * The part of an array `M` that a {@link cons} pattern leaves: a non-empty array loses the arrays whose head and tail it matches, `T[]`
 * keeps the empty array when it matches every head and tail.
 * @template M - A remaining member
 * @template H - The head pattern
 * @template T - The tail pattern
 */
type SubtractCons<M, H, T> = M extends readonly [infer A, ...infer Rest extends readonly unknown[]]
	? ConsBranches<M, A, Rest, Subtract<A, H>, Subtract<Rest, T>>
	: M extends readonly unknown[]
		? number extends M['length']
			? [Subtract<M[number], H> | Subtract<M[number][], T>] extends [never]
				? [] extends M
					? []
					: never
				: M
			: M
		: M;

/**
 * {@link SubtractShape} for the head and tail of a non-empty array.
 * @template M - The array
 * @template A - Its head
 * @template Rest - Its tail
 * @template XA - What the head pattern leaves of `A`
 * @template XR - What the tail pattern leaves of `Rest`
 */
type ConsBranches<M, A, Rest extends readonly unknown[], XA, XR> = [A] extends [XA]
	? M
	: [Rest] extends [XR]
		? M
		: ([XA] extends [never] ? never : [XA, ...Rest]) | (XR extends readonly unknown[] ? [A, ...XR] : never);

/**
 * The members of `W` whose properties a plain-object pattern `P` reads: non-array objects, a member without known keys (such as `object`,
 * `{}` or `unknown`) as an object of unknown values at the keys of `P` (`any` stays `any`).
 * @template W - The values at the pattern's position
 * @template P - The object pattern
 */
type ObjectsIn<W, P> = unknown extends W
	? 0 extends 1 & W
		? W
		: { [K in keyof P]: unknown }
	: W extends AnyFunction | readonly unknown[]
		? never
		: W extends object
			? [keyof W] extends [never]
				? { [K in keyof P]: unknown }
				: W
			: never;

/**
 * The members of `W` whose elements an array or {@link cons} pattern reads: arrays (a member that may be any array as `unknown[]`).
 * @template W - The values at the pattern's position
 */
type ArraysIn<W> = W extends readonly unknown[] ? W : unknown[] extends W ? unknown[] : never;

/**
 * The first element of each array of `V` (that {@link cons} reads).
 * @template V - The arrays
 */
type HeadOf<V> = V extends readonly [infer A, ...unknown[]] ? A : V extends readonly (infer E)[] ? E : never;

/**
 * The other elements of each array of `V`, as an array (that {@link cons} reads).
 * @template V - The arrays
 */
type TailOf<V> = V extends readonly [unknown, ...infer R] ? R : V extends readonly (infer E)[] ? E[] : never;

/**
 * What a pattern `P` captures from values of type `V`: a union of `[name, type]` pairs, the name `undefined` for anonymous captures.
 * @template P - The pattern
 * @template V - The matched values
 */
type Entries<P, V> = 0 extends 1 & P
	? never
	: P extends PatternHelper<infer K>
		? HelperEntries<K, V>
		: P extends AnyFunction | Date
			? never
			: P extends readonly unknown[]
				? { [I in keyof P]: P[I] extends Primitive ? never : Entries<P[I], PartOf<V, I>> }[number]
				: P extends object
					? { [K in keyof P]-?: P[K] extends Primitive ? never : Entries<P[K], PartOf<V, K>> }[keyof P]
					: never;

/**
 * {@link Entries} of a pattern helper.
 * @template K - The helper's kind and type arguments
 * @template V - The matched values
 */
type HelperEntries<K, V> = K extends ['capture', infer N, infer Q]
	? Q extends PatternHelper<['active', unknown, infer R]>
		? [N, Exclude<R, undefined>]
		: [N, Narrow<V, PatternType<Q>>] | Entries<Q, Narrow<V, PatternType<Q>>>
	: K extends ['active', unknown, infer R]
		? [undefined, Exclude<R, undefined>]
		: K extends ['anyOf', infer Ps extends readonly unknown[]]
			? AlternativeEntries<Ps[number], V>
			: K extends ['cons', infer H, infer T]
				? Entries<H, HeadOf<V>> | Entries<T, TailOf<V>>
				: never;

/**
 * {@link Entries} of each alternative `A` of an `anyOf`, matched against the values it narrows to.
 * @template A - The alternatives
 * @template V - The matched values
 */
type AlternativeEntries<A, V> = A extends unknown ? Entries<A, Narrow<V, PatternType<A>>> : never;

/**
 * An {@link ActiveParameterError} for each {@link active} pattern of `P` whose function does not accept every value it may be called with,
 * when `P` is tested against values of type `W`. Unlike {@link Entries}, `W` is not narrowed by the pattern: the function is called while
 * testing, whatever the parts of the pattern tested after it (or the alternatives of an {@link anyOf} tried before it) would say.
 * @template P - The pattern
 * @template W - The values the pattern is tested against
 */
type ActiveErrors<P, W> = 0 extends 1 & P
	? never
	: P extends PatternHelper<infer K>
		? HelperActiveErrors<K, W>
		: P extends AnyFunction | Date
			? never
			: P extends readonly unknown[]
				? { [I in keyof P]: P[I] extends Primitive ? never : ActiveErrors<P[I], PartOf<ArraysIn<W>, I>> }[number]
				: P extends object
					? { [K in keyof P]-?: P[K] extends Primitive ? never : ActiveErrors<P[K], PartOf<ObjectsIn<W, P>, K>> }[keyof P]
					: never;

/**
 * {@link ActiveErrors} of a pattern helper.
 * @template K - The helper's kind and type arguments
 * @template W - The values the helper is tested against
 */
type HelperActiveErrors<K, W> = K extends ['active', infer A, unknown]
	? [W] extends [A]
		? never
		: ActiveParameterError<A, W>
	: K extends ['capture', unknown, infer Q]
		? ActiveErrors<Q, W>
		: K extends ['anyOf', infer Ps extends readonly unknown[]]
			? ActiveErrors<Ps[number], W>
			: K extends ['cons', infer H, infer T]
				? ActiveErrors<H, HeadOf<ArraysIn<W>>> | ActiveErrors<T, TailOf<ArraysIn<W>>>
				: never;

/**
 * The type a handler (or `when` guard) must have for the captures `E` and the matched values `V`.
 * @template E - The captures (see {@link Entries})
 * @template V - The matched values
 */
type Handler<E, V> = [E] extends [never]
	? (value: V) => unknown
	: [E] extends [[undefined, infer S]]
		? (selection: S, value: V) => unknown
		: [E] extends [[string, unknown]]
			? (selections: Selections<E>, value: V) => unknown
			: MixedCapturesError;

/**
 * The object of named captures a handler receives.
 * @template E - The captures (see {@link Entries}), all named
 */
type Selections<E> = { [N in E extends [infer Name extends string, unknown] ? Name : never]: E extends [N, infer T] ? T : never };

/**
 * The type a handler (or `when` guard) of a case with pattern `P` must have while the values `Remaining` are unhandled (a pattern typed
 * `any` captures nothing), or {@link ActiveParameterError} when an active pattern's function does not accept its values. Handlers are
 * typed by a constraint, not inferred into: TypeScript would explore every branch of these conditional types while inferring (and the
 * error is not part of {@link Handler}, whose constraint TypeScript would then expand through every level of {@link Entries}).
 * @template P - The pattern
 * @template Remaining - The unhandled values
 */
type CaseHandler<P, Remaining> = 0 extends 1 & P
	? (value: Remaining) => unknown
	: [ActiveErrors<P, Remaining>] extends [never]
		? Handler<Entries<P, Narrow<Remaining, PatternType<P>>>, Narrow<Remaining, PatternType<P>>>
		: ActiveErrors<P, Remaining>;

/**
 * The return type of a handler.
 * @template H - The handler
 */
type ResultOf<H> = H extends (...args: never[]) => infer R ? R : never;

/**
 * The values left unhandled after a case with pattern `P` (see {@link Subtract}); a pattern typed `any` removes nothing.
 * @template Remaining - The unhandled values
 * @template P - The pattern
 */
type Remove<Remaining, P> = 0 extends 1 & P ? Remaining : Subtract<Remaining, P>;

/** The (impossible) handler type of a pattern that captures both an anonymous value and named values. */
interface MixedCapturesError {
	/** Explains the error. */
	readonly 'a pattern must capture either one anonymous value or named values': never;
}

/**
 * The (impossible) handler type of a pattern holding an {@link active} pattern whose function does not accept every value it may be
 * called with.
 * @template A - The parameter type of the function
 * @template W - The values at the active pattern's position
 */
interface ActiveParameterError<A, W> {
	/** Explains the error. */
	readonly 'the function of an active pattern must accept every value at its position': { readonly parameter: A; readonly values: W };
}

/**
 * The type of `exhaustive` when some values are unhandled: calling it is a compile error naming them.
 * @template Remaining - The unhandled values
 */
export interface NonExhaustiveError<Remaining> {
	/** The values no case handles. */
	readonly unhandled: Remaining;
}

/**
 * The builder returned by {@link matchWith}.
 * @template Remaining - The values no case handles yet
 * @template Out - The union of the handlers' return types
 */
export interface MatchBuilder<Remaining, Out> {
	/**
	 * Adds a case: when the value matches `pattern` (as {@link isMatching} defines it) and no earlier case matched, `handler` is called
	 * with the value (preceded by the captures, if `pattern` has any).
	 * @template P - The pattern
	 * @template H - The handler (its type is checked against the pattern: see `CaseHandler`)
	 * @param {P} pattern - The pattern
	 * @param {Function} handler - Receives the captures (if any) and the value narrowed to the pattern
	 * @returns {MatchBuilder} The builder, with the values `pattern` handles entirely removed from `Remaining`
	 */
	with<const P, H extends CaseHandler<P, Remaining>>(pattern: P, handler: H): MatchBuilder<Remove<Remaining, P>, Out | ResultOf<H>>;
	/**
	 * Adds a guarded case, F#'s `when`: the case only matches when `when`, called like the handler, returns a truthy value. A guarded case
	 * removes nothing from `Remaining`.
	 * @template P - The pattern
	 * @template H - The handler (its type is checked against the pattern: see `CaseHandler`)
	 * @param {P} pattern - The pattern
	 * @param {Function} when - The guard, receiving what the handler receives
	 * @param {Function} handler - Receives the captures (if any) and the value narrowed to the pattern
	 * @returns {MatchBuilder} The builder
	 */
	with<const P, H extends CaseHandler<P, Remaining>>(pattern: P, when: NoInfer<CaseHandler<P, Remaining>>, handler: H): MatchBuilder<Remaining, Out | ResultOf<H>>;
	/**
	 * Ends the match with a fallback for the values no case matched.
	 * @template R - The fallback's return type
	 * @param {(value: Remaining) => R} handler - Receives the unmatched value
	 * @returns {Out | R} The result of the matching case's handler, or of `handler`
	 */
	otherwise<R>(handler: (value: Remaining) => R): Out | R;
	/**
	 * Ends a match that handles every value of its type (a compile error, {@link NonExhaustiveError}, names the unhandled values otherwise).
	 * Throws an `AssertionError` when no case matched at runtime (data that does not match its type).
	 */
	readonly exhaustive: [Remaining] extends [never] ? () => Out : NonExhaustiveError<Remaining>;
}

/**
 * The builder returned by {@link matcher}: like {@link MatchBuilder}, but its terminals return the matching function.
 * @template In - The type of the matched values
 * @template Remaining - The values no case handles yet
 * @template Out - The union of the handlers' return types
 */
export interface MatcherBuilder<In, Remaining, Out> {
	/**
	 * Adds a case (see {@link MatchBuilder}): `pattern` is compiled now.
	 * @template P - The pattern
	 * @template H - The handler (its type is checked against the pattern: see `CaseHandler`)
	 * @param {P} pattern - The pattern
	 * @param {Function} handler - Receives the captures (if any) and the value narrowed to the pattern
	 * @returns {MatcherBuilder} A new builder, with the values `pattern` handles entirely removed from `Remaining`
	 */
	with<const P, H extends CaseHandler<P, Remaining>>(pattern: P, handler: H): MatcherBuilder<In, Remove<Remaining, P>, Out | ResultOf<H>>;
	/**
	 * Adds a guarded case (see {@link MatchBuilder}).
	 * @template P - The pattern
	 * @template H - The handler (its type is checked against the pattern: see `CaseHandler`)
	 * @param {P} pattern - The pattern
	 * @param {Function} when - The guard, receiving what the handler receives
	 * @param {Function} handler - Receives the captures (if any) and the value narrowed to the pattern
	 * @returns {MatcherBuilder} A new builder
	 */
	with<const P, H extends CaseHandler<P, Remaining>>(pattern: P, when: NoInfer<CaseHandler<P, Remaining>>, handler: H): MatcherBuilder<In, Remaining, Out | ResultOf<H>>;
	/**
	 * Ends the cases with a fallback for the values no case matches.
	 * @template R - The fallback's return type
	 * @param {(value: Remaining) => R} handler - Receives the unmatched value
	 * @returns {(value: In) => Out | R} The matching function
	 */
	otherwise<R>(handler: (value: Remaining) => R): (value: In) => Out | R;
	/** Ends cases that handle every value of `In` (see {@link MatchBuilder}); the returned function throws an `AssertionError` when no case matches. */
	readonly exhaustive: [Remaining] extends [never] ? () => (value: In) => Out : NonExhaustiveError<Remaining>;
}

// ---------------------------------------------------------------------------------------------------------------------
// matchWith / matcher
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Validates the functions of a case and returns its handler and `when` guard.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown[]} functions - The functions after the pattern: the handler, or the `when` guard and the handler
 * @returns {AnyFunction | undefined} The `when` guard, if any (the handler is the last function)
 * @throws {TypeError} when one of them is not a function
 */
function caseGuard(caller: string, functions: unknown[]): AnyFunction | undefined {
	const guarded = functions.length > 1;

	if (guarded) assertFunction(caller, 'when', functions[0]);
	assertFunction(caller, 'handler', caseHandler(functions));

	return guarded ? (functions[0] as AnyFunction) : undefined;
}

/**
 * The handler among the functions of a case: the first, or the second after a `when` guard.
 * @param {unknown[]} functions - The functions after the pattern
 * @returns {unknown} The handler
 */
function caseHandler(functions: unknown[]): unknown {
	return functions[functions.length > 1 ? 1 : 0];
}

/**
 * The state of a {@link matchWith} expression. Never changes: until a case matches, `with` returns the same state; the match returns a
 * new, matched state.
 */
class MatchState {
	/** The matched value. */
	readonly value: unknown;
	/** The handler of the case that matched, if any. */
	readonly handler: AnyFunction | undefined;
	/** The selection of the case that matched. */
	readonly selection: unknown;
	/** Scratch space for the captures of each case, created on the first test (and `undefined` while a test uses it). */
	log: unknown[] | undefined;

	/**
	 * Creates a state.
	 * @param {unknown} value - The matched value
	 * @param {AnyFunction} [handler] - The handler of the case that matched
	 * @param {unknown} [selection] - Its selection
	 */
	constructor(value: unknown, handler?: AnyFunction, selection?: unknown) {
		this.value = value;
		this.handler = handler;
		this.selection = selection;
		// Assigned here, so that creating the log later does not change the object's shape.
		this.log = undefined;
	}

	/**
	 * Adds a case (see {@link MatchBuilder}).
	 * @param {unknown} pattern - The pattern
	 * @param {...unknown} functions - The handler, or the `when` guard and the handler
	 * @returns {MatchState} The state after the case
	 */
	with(pattern: unknown, ...functions: unknown[]): MatchState {
		const guard = caseGuard('matchWith', functions);

		// Once a case matched, later patterns are neither tested nor read.
		if (this.handler !== undefined) return this;

		const log = this.log ?? [];

		// Taken while in use: a guard of the pattern that calls `with` on this state again (re-entrantly) gets a log of its own.
		this.log = undefined;
		// Only truncated when needed: setting `length` costs more than the rest of a simple test.
		if (log.length !== 0) log.length = 0;

		const matched = test('matchWith', pattern, this.value, log, 0);

		this.log = log;
		if (!matched) return this;

		const selection = select('matchWith', log);

		return guard !== undefined && !callCase(guard, selection, this.value) ? this : new MatchState(this.value, caseHandler(functions) as AnyFunction, selection);
	}

	/**
	 * Ends the match with a fallback (see {@link MatchBuilder}).
	 * @param {unknown} handler - The fallback
	 * @returns {unknown} The result of the matching case's handler, or of `handler`
	 * @throws {TypeError} when `handler` is not a function
	 */
	otherwise(handler: unknown): unknown {
		assertFunction('matchWith', 'handler', handler);

		return this.handler === undefined ? (handler as UnknownFunction)(this.value) : callCase(this.handler, this.selection, this.value);
	}

	/**
	 * Ends an exhaustive match (see {@link MatchBuilder}).
	 * @returns {unknown} The result of the matching case's handler
	 * @throws {AssertionError} when no case matched
	 */
	exhaustive(): unknown {
		if (this.handler === undefined) throw new AssertionError(`matchWith: no pattern matched the value (got ${describe(this.value)})`);

		return callCase(this.handler, this.selection, this.value);
	}
}

/**
 * Pattern matching in the style of F# and ts-pattern, with the patterns of {@link isMatching}: `matchWith(value).with(pattern, handler)…`
 * tries the cases in order and calls the handler of the first one whose pattern matches. Patterns mean what they mean for `isMatching`:
 * plain objects match partially, by own properties; arrays are tuples of the same length; functions are guards (so any guard of the
 * guards module works); dates match by time; other values by SameValueZero. {@link _} matches anything, {@link capture} and
 * {@link captureAs} pass parts of the value to the handler, {@link active} extracts values, {@link anyOf} gives alternatives and
 * {@link cons} splits arrays into head and tail. A third argument makes a guarded case, F#'s `when`: `with(pattern, when, handler)`.
 *
 * Each handler receives the value narrowed to its pattern. `exhaustive()` ends the match and is a compile error, naming the unhandled
 * values ({@link NonExhaustiveError}), until the cases handle every value of the input type (rules below); at runtime it throws an
 * `AssertionError` (with the value's type only, never its content) when no case matched. `otherwise(handler)` ends the match with a fallback.
 *
 * The value is tested eagerly, as the cases are added, without compiling the patterns (for reuse, {@link matcher} compiles them once);
 * once a case matched, the later ones are not tested. The handler runs when `exhaustive` or `otherwise` is called.
 *
 * Exhaustiveness rules: a case removes from the remaining type what its pattern matches entirely: union members (`boolean` is
 * `true | false`) equal to a literal (a single value, unlike `` `id-${string}` `` or `Uppercase<string>`), assignable to a guard's type
 * predicate (guards are trusted, like TypeScript trusts them), or matched by `_`; for objects and tuples, the part matched key by key,
 * recursively, splitting a member into what each key leaves (so `[true, _]` and `[false, _]` handle `[boolean, boolean]`, and
 * `{ kind: 'a', payload: { type: 'x' } }` one variant of a nested union). Guarded cases, {@link active} patterns, guards without a type
 * predicate, dates, and patterns of a wide type remove nothing: a `string` variable, a pattern typed `unknown` or `any`, and one typed
 * `object` or `{}` (it may be a map, compared by identity), so the empty pattern `{}` too (use `_`). Object patterns only match non-array
 * objects, so they remove no member that arrays, strings, numbers or functions satisfy (`{ length: number }`, `{ name: string }`,
 * `object`); an `any` value is only handled by a pattern that matches anything (`_`). `[]` and `cons(_, _)` together handle arrays. The
 * remaining type only ever errs on the large side: a match it cannot prove exhaustive needs `otherwise` (or a final `_` case).
 *
 * Limits: exhaustiveness assumes values and object patterns are plain data: own enumerable properties, as from JSON or object literals,
 * and no keys that their type does not declare (a pattern reads such a key as `undefined`). A discriminant that is a class getter or method
 * never matches a key pattern, and a class instance used as a pattern is compared by identity (while its type is structural): match
 * classes with `isInstanceOf(Class)` instead. Proxies are trusted: `matchWith` checks that a property is own before reading it, while
 * compiled patterns ({@link isMatching}, and the parts of {@link matcher} patterns without helpers) may read it first, so a proxy whose
 * traps disagree (`get` without `getOwnPropertyDescriptor`) may match differently in each. Captures: mixing anonymous and named captures is
 * a compile error; several anonymous captures, or a name captured twice, only throw (see {@link capture}).
 * @template T - The type of the value
 * @param {T} value - The value to match
 * @returns {MatchBuilder<T, never>} The builder
 * @throws {AssertionError} from `exhaustive()`, when no case matched
 * @throws {TypeError} from `with` and `otherwise`, when a handler or guard is not a function, or the captures of the matching case mix
 * anonymous and named captures (or capture several anonymous values, or a name twice); from `with`, when the test reaches a cycle of the
 * pattern
 * @example
 * import { isString } from 'tinkit/guards';
 * type Event = { type: 'click'; x: number; button: number } | { type: 'key'; key: string };
 * function label(event: Event): string {
 *   return matchWith(event)
 *     .with({ type: 'click', button: 0 }, function () { return 'left click'; })
 *     .with({ type: 'click' }, function (click) { return click.x > 100; }, function () { return 'click on the right'; })
 *     .with({ type: 'click' }, function (click) { return `click at ${click.x}`; })
 *     .with({ type: 'key', key: isString }, function (key) { return `key ${key.key}`; })
 *     .exhaustive();
 * }
 * label({ type: 'click', x: 10, button: 0 }); // => 'left click'
 * label({ type: 'click', x: 200, button: 2 }); // => 'click on the right'
 * label({ type: 'click', x: 10, button: 2 }); // => 'click at 10'
 * label({ type: 'key', key: 'Enter' }); // => 'key Enter'
 * label({ type: 'scroll' } as unknown as Event); // throws AssertionError
 * @example
 * function both(flags: [boolean, boolean]): string {
 *   return matchWith(flags)
 *     .with([true, true], function () { return 'both'; })
 *     .with([false, _], function () { return 'not the first'; })
 *     .with([_, false], function () { return 'only the first'; })
 *     .exhaustive();
 * }
 * both([true, false]); // => 'only the first'
 */
export function matchWith<T>(value: T): MatchBuilder<T, never> {
	return new MatchState(value) as unknown as MatchBuilder<T, never>;
}

/** A case of a {@link matcher}, compiled. */
interface MatcherCase {
	/** The compiled pattern, when it holds no pattern helper. */
	readonly guard: ((value: unknown) => boolean) | undefined;
	/** Otherwise, the pattern, with its parts without helpers compiled. */
	readonly pattern: unknown;
	/** Whether the pattern captures something. */
	readonly captures: boolean;
	/** The `when` guard, if any. */
	readonly when: AnyFunction | undefined;
	/** The handler. */
	readonly handler: AnyFunction;
}

/**
 * Compiles the parts of a pattern that hold no pattern helper with {@link isMatching}, so that only the structure leading to helpers is
 * interpreted. The result is a copy: later changes to the pattern do not affect it. A part the pattern holds several times is prepared
 * once (and shared by the copy), so the cost is linear in the distinct parts.
 * @param {unknown} pattern - An acyclic pattern
 * @param {Map<unknown, unknown[] | false>} scanned - The memo of {@link scan} for this pattern
 * @param {Map<unknown, unknown>} prepared - The parts already prepared, and their copies
 * @returns {unknown} The prepared pattern
 */
function prepare(pattern: unknown, scanned: Map<unknown, unknown[] | false>, prepared: Map<unknown, unknown>): unknown {
	let copy = prepared.get(pattern);

	if (copy !== undefined) return copy;

	const record = helperOf(pattern);

	if (record !== undefined) {
		const patterns: unknown[] = [];

		for (let index = 0; index < record.patterns.length; index++) patterns.push(prepare(record.patterns[index], scanned, prepared));
		copy = record.kind === ACTIVE ? pattern : register('matcher', { ...record, patterns });
	} else if (!scan('matcher', pattern, [], [], scanned)) {
		copy = isDate(pattern) || Array.isArray(pattern) || isPlainObject(pattern) ? isMatching(pattern) : pattern;
	} else if (Array.isArray(pattern)) {
		copy = [];
		for (let index = 0; index < pattern.length; index++) (copy as unknown[]).push(prepare(pattern[index], scanned, prepared));
	} else {
		copy = {};
		// Defined, so that a `__proto__` key is copied as a key (a copy without prototype would make `isDate` take its slow path).
		for (const key of patternKeys(pattern as object)) {
			Object.defineProperty(copy, key, {
				value: prepare((pattern as Record<PropertyKey, unknown>)[key], scanned, prepared),
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
	}
	prepared.set(pattern, copy);

	return copy;
}

/**
 * The state of a {@link matcher}: its compiled cases. Never changes: `with` returns a new state.
 */
class MatcherState {
	/** The cases, in order. */
	readonly cases: ReadonlyArray<MatcherCase>;

	/**
	 * Creates a state.
	 * @param {ReadonlyArray<MatcherCase>} cases - The cases
	 */
	constructor(cases: ReadonlyArray<MatcherCase>) {
		this.cases = cases;
	}

	/**
	 * Adds a case, compiling its pattern (see {@link MatcherBuilder}).
	 * @param {unknown} pattern - The pattern
	 * @param {...unknown} functions - The handler, or the `when` guard and the handler
	 * @returns {MatcherState} The new state
	 * @throws {TypeError} when a function is not one, or the pattern is circular or captures both anonymous and named values (or a name twice)
	 */
	with(pattern: unknown, ...functions: unknown[]): MatcherState {
		const guard = caseGuard('matcher', functions);
		const log: unknown[] = [];
		const scanned = new Map<unknown, unknown[] | false>();
		const helpers = scan('matcher', pattern, log, [], scanned);

		// Fails as matching would, but now.
		select('matcher', log);

		return new MatcherState([
			...this.cases,
			{
				guard: helpers ? undefined : (isMatching(pattern) as (value: unknown) => boolean),
				pattern: helpers ? prepare(pattern, scanned, new Map()) : undefined,
				captures: log.length > 0,
				when: guard,
				handler: caseHandler(functions) as AnyFunction
			}
		]);
	}

	/**
	 * Ends the cases with a fallback (see {@link MatcherBuilder}).
	 * @param {unknown} handler - The fallback
	 * @returns {(value: unknown) => unknown} The matching function
	 * @throws {TypeError} when `handler` is not a function
	 */
	otherwise(handler: unknown): (value: unknown) => unknown {
		assertFunction('matcher', 'handler', handler);

		return matching(this.cases, handler as UnknownFunction);
	}

	/**
	 * Ends exhaustive cases (see {@link MatcherBuilder}).
	 * @returns {(value: unknown) => unknown} The matching function
	 */
	exhaustive(): (value: unknown) => unknown {
		return matching(this.cases, undefined);
	}
}

/**
 * Creates the function that runs the cases of a {@link matcher}.
 * @param {ReadonlyArray<MatcherCase>} cases - The cases
 * @param {UnknownFunction | undefined} fallback - The `otherwise` handler, if any
 * @returns {(value: unknown) => unknown} The matching function
 */
function matching(cases: ReadonlyArray<MatcherCase>, fallback: UnknownFunction | undefined): (value: unknown) => unknown {
	return function matched(value: unknown): unknown {
		for (let index = 0; index < cases.length; index++) {
			const current = cases[index];
			const log = current.captures ? [] : undefined;

			if (current.guard === undefined ? test('matcher', current.pattern, value, log, 0) : current.guard(value)) {
				const selection = log === undefined ? NO_SELECTION : select('matcher', log);

				if (current.when === undefined || callCase(current.when, selection, value)) return callCase(current.handler, selection, value);
			}
		}
		if (fallback === undefined) throw new AssertionError(`matcher: no pattern matched the value (got ${describe(value)})`);

		return fallback(value);
	};
}

/**
 * Builds a reusable matching function, F#'s `function` keyword: the cases of {@link matchWith}, whose patterns are compiled once (with
 * {@link isMatching}, so later changes to them do not matter), ending with `exhaustive()` or `otherwise(handler)`, which return a function
 * of the value. Errors in the cases (a handler that is not a function, a circular pattern, captures mixing anonymous and named ones) throw
 * as the cases are added. Each `with` returns a new builder, so a common prefix of cases can be shared.
 * @template T - The type of the matched values
 * @returns {MatcherBuilder<T, T, never>} The builder
 * @example
 * type Shape = { kind: 'circle'; radius: number } | { kind: 'rect'; width: number; height: number };
 * const area = matcher<Shape>()
 *   .with({ kind: 'circle' }, function (circle) { return Math.round(Math.PI * circle.radius ** 2); })
 *   .with({ kind: 'rect' }, function (rect) { return rect.width * rect.height; })
 *   .exhaustive();
 * area({ kind: 'rect', width: 2, height: 3 }); // => 6
 * [{ kind: 'circle', radius: 1 } as Shape].map(area); // => [3]
 * @example
 * const sign = matcher<number>()
 *   .with(0, function () { return 'zero'; })
 *   .with(isFinite, function (n) { return n > 0; }, function () { return 'positive'; })
 *   .otherwise(function () { return 'negative or NaN'; });
 * sign(5); // => 'positive'
 * sign(-5); // => 'negative or NaN'
 */
export function matcher<T>(): MatcherBuilder<T, T, never> {
	return new MatcherState([]) as unknown as MatcherBuilder<T, T, never>;
}

// ---------------------------------------------------------------------------------------------------------------------
// pipeAsync / composeAsync
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Composes functions from left to right like {@link pipe}, but any step may return a promise (or another thenable): each step
 * receives the AWAITED result of the previous one, the steps run one after the other, and the composed function always returns a
 * promise, which rejects when a step throws or rejects (later steps are then not called). The first function may take any number of
 * arguments; the others receive a single value. `this` is forwarded to every function. With no functions, the result resolves to its
 * first argument (awaited).
 * @template A - The parameter types of the first function
 * @template R - The awaited return type of the pipeline
 * @param {...Function} fns - The functions to chain
 * @returns {Function} The piped function, returning a promise
 * @throws {TypeError} when one of `fns` is not a function
 * @example
 * async function fetchUser(id: number): Promise<{ id: number; name: string }> { return { id, name: 'Ada' }; }
 * function greet(user: { name: string }): string { return `Hello, ${user.name}`; }
 * await pipeAsync(fetchUser, greet)(1); // => 'Hello, Ada'
 * await pipeAsync()(Promise.resolve(5)); // => 5
 */
export function pipeAsync(): <T>(value: T) => Promise<Awaited<T>>;
export function pipeAsync<A extends unknown[], R>(f1: (...args: A) => R): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<A extends unknown[], R1, R>(f1: (...args: A) => R1, f2: (value: Awaited<R1>) => R): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<A extends unknown[], R1, R2, R>(
	f1: (...args: A) => R1,
	f2: (value: Awaited<R1>) => R2,
	f3: (value: Awaited<R2>) => R
): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<A extends unknown[], R1, R2, R3, R>(
	f1: (...args: A) => R1,
	f2: (value: Awaited<R1>) => R2,
	f3: (value: Awaited<R2>) => R3,
	f4: (value: Awaited<R3>) => R
): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<A extends unknown[], R1, R2, R3, R4, R>(
	f1: (...args: A) => R1,
	f2: (value: Awaited<R1>) => R2,
	f3: (value: Awaited<R2>) => R3,
	f4: (value: Awaited<R3>) => R4,
	f5: (value: Awaited<R4>) => R
): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<A extends unknown[], R1, R2, R3, R4, R5, R>(
	f1: (...args: A) => R1,
	f2: (value: Awaited<R1>) => R2,
	f3: (value: Awaited<R2>) => R3,
	f4: (value: Awaited<R3>) => R4,
	f5: (value: Awaited<R4>) => R5,
	f6: (value: Awaited<R5>) => R
): (...args: A) => Promise<Awaited<R>>;
export function pipeAsync<R = unknown, F extends AnyFunction[] = AnyFunction[]>(...fns: UncheckedChain<F>): (...args: unknown[]) => Promise<R>;
/**
 * Implementation of {@link pipeAsync} (see the first overload for the full documentation).
 * @param {...AnyFunction} fns - The functions to chain, applied left to right
 * @returns {(...args: unknown[]) => Promise<unknown>} The piped function
 * @throws {TypeError} when one of `fns` is not a function
 */
export function pipeAsync(...fns: AnyFunction[]): (...args: unknown[]) => Promise<unknown> {
	assertFunctions('pipeAsync', fns);
	// `fns` is a fresh rest array: no one else can change it.
	return chainAsync(fns as unknown as UnknownFunction[]);
}

/**
 * Composes functions from right to left like {@link compose}, but any step may return a promise (or another thenable):
 * `composeAsync(f, g, h)(...args)` awaits `h(...args)`, passes the value to `g`, awaits the result, and so on, always returning a
 * promise (see {@link pipeAsync}). The rightmost function may take any number of arguments; the others receive a single value.
 * `this` is forwarded to every function. With no functions, the result resolves to its first argument (awaited).
 * @template A - The parameter types of the rightmost function
 * @template R - The awaited return type of the composition
 * @param {...Function} fns - The functions to compose
 * @returns {Function} The composed function, returning a promise
 * @throws {TypeError} when one of `fns` is not a function
 * @example
 * async function double(x: number): Promise<number> { return x * 2; }
 * function inc(x: number): number { return x + 1; }
 * await composeAsync(double, inc)(3); // => 8
 */
export function composeAsync(): <T>(value: T) => Promise<Awaited<T>>;
export function composeAsync<A extends unknown[], R>(f1: (...args: A) => R): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<A extends unknown[], R1, R>(f2: (value: Awaited<R1>) => R, f1: (...args: A) => R1): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<A extends unknown[], R1, R2, R>(
	f3: (value: Awaited<R2>) => R,
	f2: (value: Awaited<R1>) => R2,
	f1: (...args: A) => R1
): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<A extends unknown[], R1, R2, R3, R>(
	f4: (value: Awaited<R3>) => R,
	f3: (value: Awaited<R2>) => R3,
	f2: (value: Awaited<R1>) => R2,
	f1: (...args: A) => R1
): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<A extends unknown[], R1, R2, R3, R4, R>(
	f5: (value: Awaited<R4>) => R,
	f4: (value: Awaited<R3>) => R4,
	f3: (value: Awaited<R2>) => R3,
	f2: (value: Awaited<R1>) => R2,
	f1: (...args: A) => R1
): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<A extends unknown[], R1, R2, R3, R4, R5, R>(
	f6: (value: Awaited<R5>) => R,
	f5: (value: Awaited<R4>) => R5,
	f4: (value: Awaited<R3>) => R4,
	f3: (value: Awaited<R2>) => R3,
	f2: (value: Awaited<R1>) => R2,
	f1: (...args: A) => R1
): (...args: A) => Promise<Awaited<R>>;
export function composeAsync<R = unknown, F extends AnyFunction[] = AnyFunction[]>(...fns: UncheckedChain<F>): (...args: unknown[]) => Promise<R>;
/**
 * Implementation of {@link composeAsync} (see the first overload for the full documentation).
 * @param {...AnyFunction} fns - The functions to compose, applied right to left
 * @returns {(...args: unknown[]) => Promise<unknown>} The composed function
 * @throws {TypeError} when one of `fns` is not a function
 */
export function composeAsync(...fns: AnyFunction[]): (...args: unknown[]) => Promise<unknown> {
	assertFunctions('composeAsync', fns);
	// `fns` is a fresh rest array, so it can be reversed in place.
	return chainAsync(fns.reverse() as unknown as UnknownFunction[]);
}

/**
 * Creates the function that calls each of `fns` in order with the awaited previous result (see {@link pipeAsync}).
 * @param {UnknownFunction[]} fns - The validated functions, owned by the returned function
 * @returns {(...args: unknown[]) => Promise<unknown>} The chained function
 */
function chainAsync(fns: UnknownFunction[]): (...args: unknown[]) => Promise<unknown> {
	// An async function: a step that throws synchronously rejects the returned promise instead of throwing.
	return async function piped(this: unknown, ...args: unknown[]): Promise<unknown> {
		if (fns.length === 0) return args[0];

		let result = await fns[0].apply(this, args);

		for (let i = 1; i < fns.length; i++) {
			result = await fns[i].call(this, result);
		}

		return result;
	};
}
