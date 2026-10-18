import { assertFunction, assertInteger, assertNumber, describe, MAX_TIMEOUT } from '../utils/assert.js';
import { AssertionError, isPlainObject } from '../guards/index.js';
import type { AnyFunction } from '../utils/index.js';

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
 * (and an explicit tuple type argument if you want precise types).
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
export function compose<R = unknown>(...fns: AnyFunction[]): (...args: unknown[]) => R;
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
export function pipe<R = unknown>(...fns: AnyFunction[]): (...args: unknown[]) => R;
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
 * - A single argument that is a primitive (other than `-0`), a function, or an object other than a plain object, an array or a `Date`
 *   is used as the key itself, so `1` and `'1'`, `undefined` and `null`, `NaN`, or two different class instances are all distinct keys.
 * - Anything else (zero or several arguments, a plain object, an array, a `Date`, or `-0`) is serialised like `JSON.stringify(args)`,
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
	return isPlainObject(value) || Array.isArray(value) || value instanceof Date;
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
			if (value instanceof Date) return `"Date(${value.getTime()})"`;
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
 * @throws {TypeError} when `fn` or `options.resolver` is not a function
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
 * import { sleep } from '@emiliodominguez/tink/async';
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
 * import { sleep } from '@emiliodominguez/tink/async';
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
	const maxing = options.maxWait !== undefined;

	if (maxing) assertWait('debounce', 'maxWait', options.maxWait as number);
	if (!leading && !trailing) throw new RangeError('debounce: at least one of `leading` or `trailing` must be true');

	const maxWait = Math.max(options.maxWait ?? 0, wait);
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

		return sinceCall >= wait || sinceCall < 0 || (maxing && time - lastInvokeTime >= maxWait);
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
 * The intersection of the first-parameter types of a tuple of predicates: what every one of them accepts.
 */
type PredicatesInput<P extends readonly unknown[]> = P extends readonly [infer Head, ...infer Tail]
	? (Head extends (value: infer V, ...rest: never[]) => unknown ? V : never) & PredicatesInput<Tail>
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

	const list = predicates.slice();

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
 * The input type is the intersection of the predicates' parameter types.
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
	if (typeof value !== 'object' || value === null) throw new TypeError(`match: \`value\` must be an object, got ${describe(value)}`);

	const tag = String(value[key]);
	const handler = (Object.hasOwn(handlers, tag) ? handlers[tag as keyof H] : Object.hasOwn(handlers, '_') ? handlers['_' as keyof H] : undefined) as unknown;

	// The tag may come from untrusted data: quote at most 100 characters of it, so that the message stays safe to log.
	if (handler === undefined) throw new AssertionError(`match: no handler for \`${String(key)}\` ${JSON.stringify(tag.slice(0, 100))}`);
	assertFunction('match', `handlers.${tag}`, handler);

	return (handler as (value: T) => unknown)(value) as MatchResult<H>;
}
