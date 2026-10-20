import { assertFunction, assertNumber, readOption, describe as typeName } from '../utils/assert.js';
import type { AnyFunction, NonEmptyArray, Primitive, UnionToIntersection } from '../utils/index.js';
import { generate } from '../utils/jit.js';
import { hold, isTooDeep, PENDING, release, scope } from '../utils/memo.js';
import { guardScore, scored } from '../utils/score.js';

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
	try {
		if (value instanceof Promise) return true;
		if (!isObject(value) && !isFunction(value)) return false;
		return typeof (value as { then?: unknown }).then === 'function';
	} catch {
		// A revoked proxy throws on `instanceof` and on property reads.
		return false;
	}
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
 * Uses `instanceof`, falling back to a brand check for objects of other realms and objects with a `null` prototype, so errors from other
 * realms are recognised: `Error.isError` where the runtime has it (ES2026), else `Object.prototype.toString` (`'[object Error]'`). Other
 * objects of this realm are rejected by the cheap `instanceof` test, like the built-in guards do (so a same-realm object faking
 * `Symbol.toStringTag = 'Error'` is rejected, and so is a genuine error whose prototype was swapped for an unrelated one). Without
 * `Error.isError`, a cross-realm or null-prototype object faking `Symbol.toStringTag = 'Error'` passes the fallback.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an error
 * @example
 * isError(new TypeError('x')); // => true
 * isError({ message: 'x' }); // => false
 * isError({ [Symbol.toStringTag]: 'Error' }); // => false
 */
export function isError(value: unknown): value is Error {
	try {
		return value instanceof Error || (isForeign(value) && isErrorBranded(value as object));
	} catch {
		// A revoked proxy throws on `instanceof`.
		return false;
	}
}

/**
 * The brand check of errors for {@link isError}: `Error.isError` (which checks the internal `[[ErrorData]]` slot, so a fake
 * `Symbol.toStringTag` cannot pass it), or the `'[object Error]'` tag in runtimes without it.
 * @param {object} value - An object of another realm or with a `null` prototype
 * @returns {boolean} Whether it is an error
 */
function isErrorBranded(value: object): boolean {
	const brand = (Error as { isError?: unknown }).isError;

	return typeof brand === 'function' ? (brand as (value: unknown) => boolean)(value) === true : getTag(value) === '[object Error]';
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
 * The values with a falsy static type. `NaN` is falsy too but has no literal type: see {@link FalsyPart}.
 */
export type Falsy = false | 0 | 0n | '' | null | undefined;

declare const falsyNumber: unique symbol;

/**
 * A `number` that {@link isFalsy} found falsy (`0`, `-0` or `NaN`: only `0` has a literal type). The brand only exists in the type
 * system and keeps it a subtype of `number`, so that the `false` branch of `isFalsy` still holds the other numbers.
 */
export type FalsyNumber = number & { readonly [falsyNumber]: true };

/**
 * The part of `T` that can be falsy, used by {@link isFalsy}: the {@link Falsy} members of `T`, plus {@link FalsyNumber} for a wide
 * `number`, `''` for a wide `string` and `0n` for a wide `bigint`.
 * @template T - The type to narrow
 */
export type FalsyPart<T> =
	NonNullable<unknown> extends T
		? T & (Falsy | number)
		: T extends Falsy
			? T
			: T extends number
				? number extends T
					? T & FalsyNumber
					: never
				: T extends string
					? string extends T
						? T & ''
						: never
					: T extends bigint
						? bigint extends T
							? T & 0n
							: never
						: never;

/**
 * Checks whether a value is truthy, narrowing it to `Exclude<T, Falsy>`: unlike `array.filter(Boolean)`, `array.filter(isTruthy)`
 * narrows the element type. Falsy values are `false`, `0`, `-0`, `0n`, `''`, `null`, `undefined` and `NaN`.
 *
 * As with every type predicate, the `false` branch removes whole non-literal types: after `if (!isTruthy(count))` a `count: number`
 * is narrowed to `never`, so test {@link isFalsy} for that branch instead.
 * @template T - The type of the value
 * @param {T} value - The value to check
 * @returns {boolean} Whether the value is truthy
 * @example
 * [1, 0, 'a', '', null, undefined, NaN, 0n, false].filter(isTruthy); // => [1, 'a']
 * const names: (string | undefined)[] = ['ada', undefined];
 * names.filter(isTruthy); // => ['ada'] // typed string[]
 */
export function isTruthy<T>(value: T): value is Exclude<T, Falsy> {
	return !!value;
}

/**
 * Checks whether a value is falsy (`false`, `0`, `-0`, `0n`, `''`, `null`, `undefined` or `NaN`), narrowing it to
 * {@link FalsyPart}: `string | undefined` becomes `'' | undefined`, and a wide `number` stays a `number` (it may be `NaN`). The `false`
 * branch keeps every non-literal type: after `if (!isFalsy(count))`, a `count: number | string` is still `number | string`.
 * @template T - The type of the value
 * @param {T} value - The value to check
 * @returns {boolean} Whether the value is falsy
 * @example
 * isFalsy(NaN); // => true
 * isFalsy('0'); // => false
 * isFalsy([]); // => false
 * [0, 1, '', 'a', null].filter(isFalsy); // => [0, '', null]
 */
export function isFalsy<T>(value: T): value is FalsyPart<T> {
	return !value;
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
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || prototype === Object.prototype;
	} catch {
		// A revoked proxy throws on `Object.getPrototypeOf`.
		return false;
	}
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
	try {
		return value != null && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
	} catch {
		// A throwing getter or a revoked proxy.
		return false;
	}
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
	try {
		return value != null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
	} catch {
		// A throwing getter or a revoked proxy.
		return false;
	}
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
 * Checks whether a value is a finite number greater than zero. `NaN`, `±Infinity`, `0` and `-0` are rejected. Like every guard,
 * it composes with {@link isShape}; wrap it in {@link withMessage} for a custom issue message.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a positive finite number
 * @example
 * isPositiveNumber(0.5); // => true
 * isPositiveNumber(0); // => false
 * isPositiveNumber(-0); // => false
 * isPositiveNumber(Infinity); // => false
 */
export function isPositiveNumber(value: unknown): value is number {
	return Number.isFinite(value) && (value as number) > 0;
}

/**
 * Checks whether a value is a finite number greater than or equal to zero. `-0` counts as zero (it compares equal to `0` and
 * `JSON.stringify` writes it as `0`); `NaN` and `±Infinity` are rejected.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-negative finite number
 * @example
 * isNonNegativeNumber(0); // => true
 * isNonNegativeNumber(-0); // => true
 * isNonNegativeNumber(-0.1); // => false
 * isNonNegativeNumber(Infinity); // => false
 */
export function isNonNegativeNumber(value: unknown): value is number {
	return Number.isFinite(value) && (value as number) >= 0;
}

/**
 * Checks whether a value is an integer greater than zero (`1`, `2`, …; `1e21` too: use {@link isSafeInteger} to bound it).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a positive integer
 * @example
 * isPositiveInteger(3); // => true
 * isPositiveInteger(0); // => false
 * isPositiveInteger(1.5); // => false
 * isPositiveInteger(3n); // => false
 */
export function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

/**
 * Checks whether a value is an integer greater than or equal to zero (an index or a count). `-0` counts as zero.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a non-negative integer
 * @example
 * isNonNegativeInteger(0); // => true
 * isNonNegativeInteger(-0); // => true
 * isNonNegativeInteger(-1); // => false
 * isNonNegativeInteger(0.5); // => false
 */
export function isNonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Checks whether a value is a safe integer: an integer in `[-(2^53 - 1), 2^53 - 1]`, the range where every integer is exactly
 * representable (so `n + 1 !== n`).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a safe integer
 * @example
 * isSafeInteger(2 ** 53 - 1); // => true
 * isSafeInteger(2 ** 53); // => false
 * isSafeInteger(1.5); // => false
 */
export function isSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

/**
 * A `Float16Array` (ES2025) when the `lib` of the compilation declares it, `never` otherwise.
 */
type Float16ArrayType = typeof globalThis extends { Float16Array: { prototype: infer F } } ? F : never;

/**
 * Any built-in typed array: the eleven `TypedArray` constructors of ES2022, and `Float16Array` (ES2025) when the `lib` of the compilation
 * declares it. `DataView` is not a typed array.
 */
export type TypedArray =
	| Float16ArrayType
	| Int8Array
	| Uint8Array
	| Uint8ClampedArray
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| Float32Array
	| Float64Array
	| BigInt64Array
	| BigUint64Array;

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
	'Float16Array',
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
 * Checks whether a (mutable) array has at least one element, narrowing it to a `NonEmptyArray<T>` (`[T, ...T[]]`) so that
 * `value[0]` is typed `T` (not `T | undefined` under `noUncheckedIndexedAccess`). `null`/`undefined` give `false`.
 * Sparse arrays count by `length`, like `Array#length`.
 * @template T - The element type
 * @param {T[] | null | undefined} value - The array to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * const list: number[] = [1, 2];
 * if (isNonEmptyArray(list)) list[0].toFixed(); // list: [number, ...number[]]
 */
export function isNonEmptyArray<T>(value: T[] | null | undefined): value is NonEmptyArray<T>;
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
/**
 * Checks whether an array of a union of array types (`string[] | number[]`) has at least one element, narrowing it to that type with a
 * first element.
 * @template A - The array type
 * @param {A | null | undefined} value - The array to check
 * @returns {boolean} Whether the value is a non-empty array
 * @example
 * const list = [1] as string[] | number[];
 * if (isNonEmptyArray(list)) list[0]; // string | number
 */
export function isNonEmptyArray<A extends ReadonlyArray<unknown>>(value: A | null | undefined): value is A & readonly [A[number], ...A[number][]];
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
 * The values that name the property key `K`: the key itself and, for a number or the canonical string of one, its other form (`0` and
 * `'0'` name the same property, and either may have been passed to {@link isKeyOf}).
 * @template K - A property key
 */
type KeyForms<K> = K extends number ? K | `${K}` : K extends `${infer N extends number}` ? K | N : K;

/**
 * Checks whether `key` is an OWN property key of `object` (string, number or symbol; enumerable or not), narrowing
 * `key` to `keyof T` (with its other form for a numeric key: `isKeyOf({ 0: 'a' }, key)` narrows `key` to `0 | '0'`). Inherited keys
 * such as `'toString'` or `'__proto__'` are rejected, which makes it safe to use before indexing with untrusted keys. Like every type predicate, the `false` branch removes the keys of `T` from the type of `key`,
 * although optional keys that are absent and inherited ones (class methods) also return `false`: test `typeof key` there instead.
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
export function isKeyOf<T extends object>(object: T, key: unknown): key is T extends unknown ? KeyForms<keyof T> : never {
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

	const count = values.length;
	const allowed = new Set<unknown>();

	// A hole allows `undefined`, not an element planted on a polluted `Array.prototype` or `Object.prototype` (which iterating would read).
	for (let index = 0; index < count; index++) allowed.add(hasOwn.call(values, index) ? values[index] : undefined);

	return explainable(
		function isOneOfValues(value: unknown): value is T[number] {
			return allowed.has(value);
		},
		function explainOneOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (allowed.has(value)) return true;

			issues.push({ message: `Expected one of ${count} allowed values (got ${typeName(value)})`, path: path.slice() });

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

			const direct = !isArrayPrototypePolluted();

			for (let index = 0; index < value.length; index++) {
				if (!guard(direct || hasOwn.call(value, index) ? value[index] : undefined)) return false;
			}

			return true;
		},
		function explainArrayOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!Array.isArray(value)) {
				issues.push({ message: `Expected an array (got ${typeName(value)})`, path: path.slice() });

				return false;
			}

			const direct = !isArrayPrototypePolluted();
			let passed = true;

			for (let index = 0; index < value.length; index++) {
				passed = collectChild(guard, direct || hasOwn.call(value, index) ? value[index] : undefined, index, path, issues) && passed;
			}

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

			// Both lists are taken before any getter or guard runs. `Object.keys` only lists enumerable keys; symbols need the check.
			const keys = Object.keys(value);
			const symbols = Object.getOwnPropertySymbols(value);

			for (let index = 0; index < keys.length; index++) if (!guard(value[keys[index]])) return false;
			for (let index = 0; index < symbols.length; index++) if (propertyIsEnumerable.call(value, symbols[index]) && !guard(value[symbols[index]])) return false;

			return true;
		},
		function explainRecordOf(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!isPlainObject(value)) {
				issues.push({ message: `Expected a plain object (got ${typeName(value)})`, path: path.slice() });

				return false;
			}

			let passed = true;
			const symbols = Object.getOwnPropertySymbols(value);

			for (const key of Object.keys(value)) passed = collectChild(guard, value[key], key, path, issues) && passed;
			for (const key of symbols) if (propertyIsEnumerable.call(value, key)) passed = collectChild(guard, value[key], key, path, issues) && passed;

			return passed;
		}
	);
}

/**
 * Checks whether a value is one of the built-in typed arrays (`Uint8Array`, `Float64Array`, `BigInt64Array`…, and `Float16Array` where
 * the runtime has it), including subclasses and instances from other realms. `DataView`, `ArrayBuffer` and plain arrays are not typed arrays.
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
 * The kind of a function, told by the `Symbol.toStringTag` that its PROTOTYPE owns: `%AsyncFunction.prototype%`,
 * `%GeneratorFunction.prototype%` and `%AsyncGeneratorFunction.prototype%` own one (in every realm), so a plain function cannot fake
 * its kind by defining the tag on itself; it would have to swap its prototype.
 * @param {AnyFunction} value - The function
 * @returns {'function' | 'asyncfunction' | 'generatorfunction' | 'asyncgeneratorfunction'} Its kind
 */
function functionKind(value: AnyFunction): 'function' | 'asyncfunction' | 'generatorfunction' | 'asyncgeneratorfunction' {
	try {
		const prototype: object | null = Object.getPrototypeOf(value);
		const tag: unknown = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)?.value;
		return tag === 'AsyncFunction'
			? 'asyncfunction'
			: tag === 'GeneratorFunction'
				? 'generatorfunction'
				: tag === 'AsyncGeneratorFunction'
					? 'asyncgeneratorfunction'
					: 'function';
	} catch {
		// A revoked proxy.
		return 'function';
	}
}

/**
 * Checks whether a value is an `async` function (an `async function`, async arrow or async method, bound or not). Async GENERATOR
 * functions are not: they return async iterators, not promises. Neither is a plain function returning a promise, nor an async function
 * transpiled to a generator or a state machine (it is a plain function by then): the check cannot call the function to find out.
 * The tag of the function's prototype is checked, so async functions of other realms are recognised while a plain function defining
 * `Symbol.toStringTag = 'AsyncFunction'` on itself is rejected.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an async function
 * @example
 * isAsyncFunction(async function () {}); // => true
 * isAsyncFunction(function () { return Promise.resolve(); }); // => false
 * isAsyncFunction(async function* () {}); // => false
 */
export function isAsyncFunction(value: unknown): value is (...args: never[]) => Promise<unknown> {
	return typeof value === 'function' && functionKind(value as AnyFunction) === 'asyncfunction';
}

/**
 * Checks whether a value is a generator function (`function*`, bound or not). Async generator functions (`async function*`) are not.
 * Recognised like {@link isAsyncFunction}, by the tag of the function's prototype (so in any realm).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a generator function
 * @example
 * isGeneratorFunction(function* () {}); // => true
 * isGeneratorFunction(function () {}); // => false
 * isGeneratorFunction(async function* () {}); // => false
 */
export function isGeneratorFunction(value: unknown): value is (...args: never[]) => Generator<unknown, unknown, unknown> {
	return typeof value === 'function' && functionKind(value as AnyFunction) === 'generatorfunction';
}

/**
 * Checks whether a value can be used as a property key as it is: a string, a number or a symbol (other values would be converted to
 * strings first).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a string, a number or a symbol
 * @example
 * isPropertyKey('id'); // => true
 * isPropertyKey(0); // => true
 * isPropertyKey(Symbol.iterator); // => true
 * isPropertyKey(null); // => false
 */
export function isPropertyKey(value: unknown): value is PropertyKey {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'symbol';
}

/**
 * Checks whether a value is array-like, as lodash's `isArrayLike`: not `null`, `undefined` or a function, with a `length` that is an
 * integer in `[0, Number.MAX_SAFE_INTEGER]`. Strings, arrays, typed arrays, `arguments` and `NodeList`s are; so is any object with such a
 * `length` (`{ length: 0 }`). The `length` is read once; a getter that throws, or a revoked proxy, gives `false`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is array-like
 * @example
 * isArrayLike([1, 2]); // => true
 * isArrayLike('abc'); // => true
 * isArrayLike({ length: 2, 0: 'a', 1: 'b' }); // => true
 * isArrayLike({ length: -1 }); // => false
 * isArrayLike(function (a: number) { return a; }); // => false
 */
export function isArrayLike(value: unknown): value is ArrayLike<unknown> {
	if (value == null || typeof value === 'function') return false;
	try {
		const length = (value as { length?: unknown }).length;
		return Number.isSafeInteger(length) && (length as number) >= 0;
	} catch {
		return false;
	}
}

/**
 * The `Blob` type of the environment: the DOM's (or Node's) `Blob` when those types are loaded, otherwise its structural core, so that
 * the declarations compile without them.
 */
export type BlobLike = typeof globalThis extends { Blob: { prototype: infer B } }
	? B
	: {
			readonly size: number;
			readonly type: string;
			arrayBuffer(): Promise<ArrayBuffer>;
			text(): Promise<string>;
			slice(start?: number, end?: number, contentType?: string): BlobLike;
		};

/**
 * Checks whether a value is a `Blob` (a `File` too), with a brand check: blobs of other realms pass, while objects that merely inherit
 * from `Blob.prototype` or fake its properties fail. `false` in runtimes without `Blob`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a Blob
 * @example
 * isBlob(new Blob(['text'])); // => true
 * isBlob({ size: 4, type: '' }); // => false
 */
export function isBlob(value: unknown): value is BlobLike {
	try {
		const BlobConstructor = (globalThis as { Blob?: unknown }).Blob;
		if (typeof BlobConstructor !== 'function' || !(value instanceof BlobConstructor || isForeign(value))) return false;
		// The `size` getter throws for anything without the Blob internal slot.
		const sizeGetter = (Object.getOwnPropertyDescriptor(BlobConstructor.prototype, 'size') as PropertyDescriptor).get as (this: unknown) => number;
		return (sizeGetter.call(value), true);
	} catch {
		return false;
	}
}

/**
 * The type names returned by {@link getType}: the `typeof` names of the primitives (`null` apart), the kinds of functions, and the
 * built-in object types told apart by brand checks; `'object'` for any other object.
 */
export type TypeName =
	| 'undefined'
	| 'null'
	| 'boolean'
	| 'number'
	| 'bigint'
	| 'string'
	| 'symbol'
	| 'function'
	| 'asyncfunction'
	| 'generatorfunction'
	| 'asyncgeneratorfunction'
	| 'array'
	| 'date'
	| 'regexp'
	| 'error'
	| 'map'
	| 'set'
	| 'weakmap'
	| 'weakset'
	| 'promise'
	| 'arraybuffer'
	| 'dataview'
	| 'int8array'
	| 'uint8array'
	| 'uint8clampedarray'
	| 'int16array'
	| 'uint16array'
	| 'int32array'
	| 'uint32array'
	| 'float16array'
	| 'float32array'
	| 'float64array'
	| 'bigint64array'
	| 'biguint64array'
	| 'object';

/**
 * Returns a precise, lowercase name for the type of any value, as a {@link TypeName}:
 * - primitives: `'undefined'`, `'null'` (not `'object'`), `'boolean'`, `'number'` (`NaN` too), `'bigint'`, `'string'`, `'symbol'`;
 * - functions: `'asyncfunction'`, `'generatorfunction'`, `'asyncgeneratorfunction'`, else `'function'` (classes and bound functions too);
 * - objects: `'array'`, `'date'`, `'regexp'`, `'error'`, `'map'`, `'set'`, `'weakmap'`, `'weakset'`, `'promise'`, `'arraybuffer'`,
 *   `'dataview'` and the typed arrays (`'uint8array'`, `'float64array'`, …, `'float16array'` where the runtime has it), else
 *   `'object'`: plain and null-prototype objects, class instances, boxed primitives (`new Number(1)`), `SharedArrayBuffer`s, iterators.
 *
 * It is not fooled by `Symbol.toStringTag`: arrays, dates, regexps, maps, sets, weak collections, buffers and typed arrays are told
 * apart by brand checks (as the guards of this module do, so values of other realms are recognised), functions by the tag their
 * prototype owns (see {@link isAsyncFunction}). Errors
 * and promises are recognised by `instanceof`, and values of other realms (or with a `null` prototype) by `Error.isError` (see
 * {@link isError}) or their tag, so only such a value faking the tag of a promise (or of an error, without `Error.isError`) can be
 * misnamed. A thenable that is not a native promise is an `'object'`; a proxy is
 * named after its target when that is an array or a function, and `'object'` otherwise.
 * @param {unknown} value - The value to inspect
 * @returns {TypeName} Its type name
 * @example
 * getType(null); // => 'null'
 * getType([]); // => 'array'
 * getType(new Date()); // => 'date'
 * getType(new Uint8Array(1)); // => 'uint8array'
 * getType(async function () {}); // => 'asyncfunction'
 * getType({ [Symbol.toStringTag]: 'Date' }); // => 'object'
 * getType(new Number(1)); // => 'object'
 */
export function getType(value: unknown): TypeName {
	if (value === null) return 'null';
	const type = typeof value;
	if (type === 'function') return functionKind(value as AnyFunction);
	if (type !== 'object') return type as TypeName;
	try {
		if (Array.isArray(value)) return 'array';
	} catch {
		// A revoked proxy.
		return 'object';
	}
	if (ArrayBuffer.isView(value)) return ((typedArrayTagGetter.call(value) ?? 'DataView') as string).toLowerCase() as TypeName;
	return isDate(value)
		? 'date'
		: isRegExp(value)
			? 'regexp'
			: isMap(value)
				? 'map'
				: isSet(value)
					? 'set'
					: isWeakMap(value)
						? 'weakmap'
						: isWeakSet(value)
							? 'weakset'
							: isArrayBuffer(value)
								? 'arraybuffer'
								: isError(value)
									? 'error'
									: isNativePromise(value)
										? 'promise'
										: 'object';
}

/**
 * Whether a value is a native promise (of any realm), as opposed to any thenable: `instanceof Promise`, or the `'[object Promise]'` tag
 * for objects of other realms and with a `null` prototype.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a native promise
 */
function isNativePromise(value: unknown): boolean {
	try {
		return value instanceof Promise || (isForeign(value) && getTag(value) === '[object Promise]');
	} catch {
		// A revoked proxy, or a throwing `Symbol.toStringTag` getter.
		return false;
	}
}

/**
 * Reads a property of a global object without throwing.
 * @param {string} name - The global's name, e.g. `'process'`
 * @returns {unknown} Its value, `undefined` when it is missing or reading it throws
 */
function readGlobal(name: string): unknown {
	try {
		return (globalThis as Record<string, unknown>)[name];
	} catch {
		return undefined;
	}
}

/**
 * Reads `process.versions[name]` without throwing.
 * @param {string} name - The version key, e.g. `'node'`
 * @returns {unknown} Its value, `undefined` when anything on the way is missing or throws
 */
function processVersion(name: string): unknown {
	try {
		return (readGlobal('process') as { versions?: Record<string, unknown> } | undefined)?.versions?.[name];
	} catch {
		return undefined;
	}
}

/**
 * Checks whether the code runs in Node.js: `process.versions.node` is a string, and the runtime is neither Bun nor Deno (both also set
 * it). The browser shims of `process` that bundlers inject (`process/browser`, webpack 4, browserify) have no `versions.node`, so they
 * do not count. A test environment that simulates a DOM in Node (jsdom, happy-dom) is still Node. Never throws, even for a hostile
 * `process` global.
 * @returns {boolean} Whether the runtime is Node.js
 * @example
 * // doctest: skip
 * isNode(); // true in Node.js, false in browsers, Deno and Bun
 */
export function isNode(): boolean {
	return typeof processVersion('node') === 'string' && !isBun() && !isDeno();
}

/**
 * Checks whether the code runs in Deno: the global `Deno` is an object whose `version.deno` is a string. Never throws.
 * @returns {boolean} Whether the runtime is Deno
 * @example
 * // doctest: skip
 * isDeno(); // true in Deno (and its workers)
 */
export function isDeno(): boolean {
	try {
		return typeof (readGlobal('Deno') as { version?: { deno?: unknown } } | undefined)?.version?.deno === 'string';
	} catch {
		return false;
	}
}

/**
 * Checks whether the code runs in Bun: `process.versions.bun` is a string. Never throws.
 * @returns {boolean} Whether the runtime is Bun
 * @example
 * // doctest: skip
 * isBun(); // true in Bun
 */
export function isBun(): boolean {
	return typeof processVersion('bun') === 'string';
}

/**
 * Checks whether the code runs on the main thread of a browser: `window` is the global object, `document` is an object, and the runtime
 * is not a server runtime (`process.versions.node` is not a string and there is no `Deno`). So jsdom or happy-dom simulating a DOM in
 * Node, Bun or Deno is NOT a browser, nor is an Electron renderer with Node integration; a browser page with a bundler's `process` shim
 * is. Web workers are not (see {@link isWebWorker}). Never throws.
 * @returns {boolean} Whether the runtime is a browser's main thread
 * @example
 * // doctest: skip
 * isBrowser(); // true in a browser tab, false in Node (even with jsdom), Deno, Bun and web workers
 */
export function isBrowser(): boolean {
	const document = readGlobal('document');
	return readGlobal('window') === globalThis && typeof document === 'object' && document !== null && typeof processVersion('node') !== 'string' && !isDeno();
}

/**
 * Checks whether the code runs in a web worker: the global object is an instance of `WorkerGlobalScope`, which covers dedicated, shared
 * and service workers (Deno's workers too). Node's `worker_threads` are not web workers. Never throws.
 * @returns {boolean} Whether the runtime is a web worker
 * @example
 * // doctest: skip
 * isWebWorker(); // true inside a dedicated, shared or service worker
 */
export function isWebWorker(): boolean {
	try {
		const WorkerGlobalScope = readGlobal('WorkerGlobalScope');
		return typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope;
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
export type Infer<G> = G extends ((value: unknown) => value is infer T) ? T : never;

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
	// The JSON guards are plain function declarations (a top-level factory call would defeat tree-shaking), so they are not in the registry.
	if (guard === isJsonValue || guard === isJsonObject || guard === isJsonArray) return explainJson(guard, value, path, issues);
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
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

/**
 * Whether `Array.prototype` (or `Object.prototype`, which it inherits from) has an enumerable property: what prototype pollution adds,
 * and what the holes of a sparse array would then read. Array guards read elements without an own-property check otherwise, which keeps
 * that check (2.5 times the cost of reading an element) off the common path.
 * @returns {boolean} Whether array elements must be read as own properties
 */
function isArrayPrototypePolluted(): boolean {
	for (const key in Array.prototype) return typeof key === 'string';

	return false;
}

/**
 * Creates a guard for objects with the given property guards: the TypeScript-only, zero-dependency equivalent of `z.object()`.
 * Each guard receives the OWN property value, or `undefined` when the property is missing or only inherited (so `toString` or a
 * polluted `Object.prototype` can never satisfy a shape). Properties whose guard accepts `undefined` (see {@link isOptional}) are
 * optional in the inferred type. Arrays and `null` are rejected. The shape is copied, so later mutations do not affect the guard.
 * Combine with {@link explain}, {@link ensure} or {@link toStandardSchema} for path-aware error reports. The check compiles to specialized
 * code where `new Function` is allowed (a loop otherwise); like any reflective check, it trusts the traps of a `Proxy`, which is code, not data.
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

	// Own enumerable symbol keys too: the inferred type includes them.
	const keys: PropertyKey[] = [
		...Object.keys(shape),
		...Object.getOwnPropertySymbols(shape).filter(function (key: symbol): boolean {
			return Object.prototype.propertyIsEnumerable.call(shape, key);
		})
	];
	const guards = keys.map(function (key: PropertyKey): Guard<unknown> {
		const guard = (shape as Record<PropertyKey, Guard<unknown>>)[key];

		assertFunction('isShape', `shape.${String(key)}`, guard);

		return guard;
	});

	// Read as an option: `{}` is not exact under a polluted `Object.prototype.exact`.
	return shapeGuard(keys, guards, undefined, options != null && readOption(options, 'exact') === true ? new Set<PropertyKey>(keys) : undefined) as (
		value: unknown
	) => value is ShapeType<S>;
}

/**
 * While {@link isDiscriminatedUnion} runs a variant guard: the object being checked and its discriminant key. Exact shapes accept that key
 * on that very object (only), since the union checks it and variants do not repeat it.
 */
let discriminated: { readonly object: object; readonly key: string; readonly previous: typeof discriminated } | undefined;

/**
 * Whether `key` of `value` is the discriminant of the object a discriminated union is checking (see {@link discriminated}).
 * @param {object} value - The object an exact shape checks
 * @param {string} key - An own enumerable key of `value`
 * @returns {boolean} `true` for the discriminant of the discriminated object
 */
function isDiscriminant(value: object, key: string): boolean {
	// Every enclosing union counts (two-level tagging of one object: `{ type, sub, … }`).
	for (let entry = discriminated; entry !== undefined; entry = entry.previous) if (entry.object === value && entry.key === key) return true;

	return false;
}

/**
 * Generates the check of a shape with string keys: one named property read and one direct guard call per key (see `utils/jit.ts`).
 * Objects that inherit from `Object.prototype` (or nothing) are read directly once `Object.prototype` is known to hold none of the keys,
 * since every defined value is then an own property and a missing key reads as `undefined`, which is what the loop checks it as; other
 * objects, and a polluted `Object.prototype`, take `loop`.
 * @param {ReadonlyArray<string>} keys - The checked keys
 * @param {ReadonlyArray<Guard<unknown>>} guards - The guard of each key
 * @param {ReadonlyArray<boolean> | undefined} required - Per key, whether it must be an own property
 * @param {((value: object) => boolean) | undefined} hasUnknownKey - For exact shapes, whether an object has a key the shape does not know
 * @param {Guard<unknown>} loop - The key-by-key check to fall back to
 * @returns {Guard<unknown> | undefined} The generated check, or `undefined` when code generation is disallowed
 */
function generateShape(
	keys: ReadonlyArray<string>,
	guards: ReadonlyArray<Guard<unknown>>,
	required: ReadonlyArray<boolean> | undefined,
	hasUnknownKey: ((value: object) => boolean) | undefined,
	loop: Guard<unknown>
): Guard<unknown> | undefined {
	const literals = keys.map(function (key: string): string {
		return JSON.stringify(key);
	});
	// The generated code ships as written, so its names are short: `v` the value, `x` a property value, `g0`… the guards; the parameters
	// are listed in the `generate` call below.
	const source = [
		...literals.map(function (_: string, index: number): string {
			return `const g${index} = G[${index}];`;
		}),
		'return function isShaped(v) {',
		"if (typeof v !== 'object' || v === null || A(v)) return false;",
		'const p = P(v);',
		`if ((p !== O && p !== null)${literals
			.map(function (key: string): string {
				return ` || ${key} in O`;
			})
			.join('')}) return L(v);`,
		'let x;',
		...literals.map(function (key: string, index: number): string {
			return required !== undefined && required[index]
				? `x = v[${key}]; if (!g${index}(x) || (x === undefined && !H.call(v, ${key}))) return false;`
				: `if (!g${index}(v[${key}])) return false;`;
		}),
		hasUnknownKey === undefined ? 'return true;' : 'return !U(v);',
		'};'
	].join('\n');

	return generate(['O', 'A', 'P', 'H', 'L', 'G', 'U'], source, [Object.prototype, Array.isArray, Object.getPrototypeOf, hasOwn, loop, guards, hasUnknownKey]) as
		| Guard<unknown>
		| undefined;
}

/**
 * Builds the guard behind {@link isShape} and the object patterns of {@link isMatching}.
 * @param {ReadonlyArray<PropertyKey>} keys - The checked keys
 * @param {ReadonlyArray<Guard<unknown>>} guards - The guard of each key
 * @param {ReadonlyArray<boolean> | undefined} required - Per key, whether it must be an own property (otherwise a missing key is checked as `undefined`)
 * @param {ReadonlySet<PropertyKey> | undefined} known - For exact shapes, the allowed own enumerable string keys
 * @returns {Guard<unknown>} The guard
 */
function shapeGuard(
	keys: ReadonlyArray<PropertyKey>,
	guards: ReadonlyArray<Guard<unknown>>,
	required: ReadonlyArray<boolean> | undefined,
	known: ReadonlySet<PropertyKey> | undefined
): Guard<unknown> {
	/**
	 * Whether a missing key fails the check.
	 * @param {number} index - The key's index
	 * @returns {boolean} `true` when the key is required, or its guard rejects `undefined`
	 */
	function missingFails(index: number): boolean {
		return (required !== undefined && required[index]) || !guards[index](undefined);
	}

	/**
	 * Whether an exact shape meets an own enumerable string key it does not know.
	 * @param {object} value - The checked object
	 * @returns {boolean} `true` when `value` has an unknown key
	 */
	function hasUnknownKey(value: object): boolean {
		for (const key in value) if (hasOwn.call(value, key) && !(known as ReadonlySet<PropertyKey>).has(key) && !isDiscriminant(value, key)) return true;

		return false;
	}

	/**
	 * Checks an object key by key, reading own properties only.
	 * @param {unknown} value - The value to check
	 * @returns {boolean} Whether `value` matches the shape
	 */
	function isShapedLoop(value: unknown): value is object {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];

			if (hasOwn.call(value, key) ? !guards[index]((value as Record<PropertyKey, unknown>)[key]) : missingFails(index)) return false;
		}

		return known === undefined || !hasUnknownKey(value);
	}

	const shaped = explainable(
		(keys.every(function (key: PropertyKey): boolean {
			return typeof key === 'string';
		}) &&
			generateShape(keys as ReadonlyArray<string>, guards, required, known === undefined ? undefined : hasUnknownKey, isShapedLoop)) ||
			isShapedLoop,
		function explainShape(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				issues.push({ message: `Expected an object (got ${Array.isArray(value) ? 'array' : typeName(value)})`, path: path.slice() });

				return false;
			}

			let passed = true;

			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];

				if (hasOwn.call(value, key)) {
					passed = collectChild(guards[index], (value as Record<PropertyKey, unknown>)[key], key, path, issues) && passed;
				} else if (missingFails(index)) {
					issues.push({ message: 'Missing required property', path: [...path, key] });
					passed = false;
				}
			}

			if (known !== undefined) {
				for (const key in value) {
					if (hasOwn.call(value, key) && !known.has(key) && !isDiscriminant(value, key)) {
						issues.push({ message: 'Unknown property', path: [...path, key] });
						passed = false;
					}
				}
			}

			return passed;
		}
	);

	scored(shaped, function scoreShape(value: unknown): number {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return 2;

		let failed = 0;

		for (let index = 0; index < keys.length; index++) {
			const own = hasOwn.call(value, keys[index]);
			const raw = own ? (value as Record<PropertyKey, unknown>)[keys[index]] : undefined;

			// Nested objects are not checked: that would walk their whole subtree, and nested unions would make scoring exponential.
			if (typeof raw === 'object' && raw !== null) continue;
			if (own ? !guards[index](raw) : missingFails(index)) failed++;
		}

		return failed / (keys.length + 1);
	});

	return shaped;
}

/**
 * Creates a guard that passes when ANY of `guards` passes, narrowing to the union of their types (`z.union()`). Guards run in order
 * and stop at the first match. {@link explain} reports the member closest to the value (for tagged objects, the matching variant).
 * For objects tagged by a field, {@link isDiscriminatedUnion} looks the variant up instead.
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

	/**
	 * Returns the member closest to matching `value` (see `utils/score.ts`), the first one on a tie.
	 * @param {unknown} value - A value every member rejects
	 * @returns {Guard<unknown>} The closest member
	 */
	function closestOf(value: unknown): Guard<unknown> {
		let closest = members[0];
		let best = guardScore(closest, value);

		for (let index = 1; index < members.length && best > 0; index++) {
			const score = guardScore(members[index], value);

			if (score < best) {
				closest = members[index];
				best = score;
			}
		}

		return closest;
	}

	const union = explainable(
		function isUnionMember(value: unknown): value is Infer<G[number]> {
			for (let index = 0; index < members.length; index++) if (members[index](value)) return true;

			return false;
		},
		function explainUnion(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			// Explainers also run on the valid children of an explained object.
			for (let index = 0; index < members.length; index++) if (members[index](value)) return true;

			// Report the member that came closest: for tagged objects that is the matching variant. Explaining every member, at every level
			// of a recursive union, would take exponential time on invalid input.
			return collect(closestOf(value), value, path, issues);
		}
	);

	return scored(union, function scoreUnion(value: unknown): number {
		return guardScore(closestOf(value), value);
	});
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

	return scored(
		explainable(
			function isOptionalValue(value: unknown): value is T | undefined {
				return value === undefined || guard(value);
			},
			function explainOptional(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
				return value === undefined || collect(guard, value, path, issues);
			}
		),
		function scoreOptional(value: unknown): number {
			// Only asked about values the guard rejects, which are never `undefined`.
			return guardScore(guard, value);
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

	return scored(
		explainable(
			function isNullableValue(value: unknown): value is T | null {
				return value === null || guard(value);
			},
			function explainNullable(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
				return value === null || collect(guard, value, path, issues);
			}
		),
		function scoreNullable(value: unknown): number {
			// Only asked about values the guard rejects, which are never `null`.
			return guardScore(guard, value);
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

			const direct = !isArrayPrototypePolluted();

			for (let index = 0; index < elements.length; index++) if (!elements[index](direct || hasOwn.call(value, index) ? value[index] : undefined)) return false;

			return true;
		},
		function explainTuple(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			if (!Array.isArray(value) || value.length !== elements.length) {
				const got = Array.isArray(value) ? `${value.length} elements` : typeName(value);

				issues.push({ message: `Expected a tuple of ${elements.length} elements (got ${got})`, path: path.slice() });

				return false;
			}

			let passed = true;

			const direct = !isArrayPrototypePolluted();

			for (let index = 0; index < elements.length; index++) {
				passed = collectChild(elements[index], direct || hasOwn.call(value, index) ? value[index] : undefined, index, path, issues) && passed;
			}

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

	return scored(
		failing(
			function isLabelled(value: unknown): value is T {
				return guard(value);
			},
			function (value: unknown): string {
				return typeof message === 'string' ? message : String(message(value));
			}
		),
		function scoreLabelled(value: unknown): number {
			return guardScore(guard, value);
		}
	);
}

/**
 * Registers an explainer that reports one issue, built by `message`, when `guard` fails.
 * @template G - The guard type
 * @param {G} guard - A guard created by the caller (it must not be shared, since a guard has one explainer)
 * @param {(value: unknown) => string} message - Builds the message from the rejected value
 * @returns {G} The guard itself
 */
function failing<G extends Guard<unknown>>(guard: G, message: (value: unknown) => string): G {
	return explainable(guard, function explainFailure(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
		if (guard(value)) return true;

		issues.push({ message: message(value), path: path.slice() });

		return false;
	});
}

/**
 * Registers an explainer reporting `Expected <expected> (got <value>)` when `guard` fails (numbers are shown, other values by type).
 * @template G - The guard type
 * @param {G} guard - A guard created by the caller
 * @param {string} expected - What the guard accepts
 * @returns {G} The guard itself
 */
function expecting<G extends Guard<unknown>>(guard: G, expected: string): G {
	return failing(guard, function (value: unknown): string {
		return `Expected ${expected} (got ${typeof value === 'number' ? value : typeName(value)})`;
	});
}

/**
 * SameValueZero equality (`Array#includes` semantics): `NaN` equals `NaN` and `0` equals `-0`.
 * @param {unknown} a - A value
 * @param {unknown} b - Another value
 * @returns {boolean} Whether they are equal
 */
function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (a !== a && b !== b);
}

/**
 * Builds a guard accepting exactly `expected` (SameValueZero).
 * @template T - The literal type
 * @param {T} expected - The accepted value
 * @returns {Guard<T>} The guard
 */
function literal<T>(expected: T): Guard<T> {
	return expecting(function isLiteralValue(value: unknown): value is T {
		return sameValueZero(value, expected);
	}, describe(expected));
}

/**
 * Creates a guard accepting exactly one primitive value (`z.literal()`), compared with SameValueZero: `isLiteral(NaN)` accepts `NaN`
 * and `isLiteral(0)` accepts `-0`. {@link explain} reports `Expected <value>`. For a set of values use {@link isOneOf}; for objects,
 * {@link isMatching}.
 * @template T - The literal type
 * @param {T} value - The accepted primitive
 * @returns {(value: unknown) => boolean} A guard narrowing to `T`
 * @throws {TypeError} when `value` is an object or a function
 * @example
 * const isAdmin = isLiteral('admin');
 * isAdmin('admin'); // => true
 * isAdmin('Admin'); // => false
 * explain(isShape({ role: isAdmin }), { role: 'user' }); // => [{ message: 'Expected "admin" (got string)', path: ['role'] }]
 */
export function isLiteral<const T extends Primitive>(value: T): (value: unknown) => value is T {
	if (!isPrimitive(value)) throw new TypeError(`isLiteral: \`value\` must be a primitive, got ${typeName(value)}`);

	return literal(value);
}

/**
 * Creates a guard accepting finite numbers between `min` and `max`, both inclusive. `NaN` and `±Infinity` are always rejected, even
 * with infinite bounds (`isNumberInRange(0, Infinity)` is "finite and non-negative"). {@link explain} reports the range.
 * @param {number} min - The smallest accepted number
 * @param {number} max - The largest accepted number
 * @returns {(value: unknown) => boolean} A guard narrowing to `number`
 * @throws {TypeError} when `min` or `max` is not a number
 * @throws {RangeError} when `min` is `NaN`, or `max` is `NaN` or smaller than `min`
 * @example
 * const isPercent = isNumberInRange(0, 100);
 * isPercent(42.5); // => true
 * isPercent(101); // => false
 * explain(isPercent, -1); // => [{ message: 'Expected a number between 0 and 100 (got -1)', path: [] }]
 * isNumberInRange(10, 0); // throws RangeError
 */
export function isNumberInRange(min: number, max: number): (value: unknown) => value is number {
	assertNumber('isNumberInRange', 'min', min, min === min, 'a number');
	assertNumber('isNumberInRange', 'max', max, max >= min, `a number >= min (${min})`);

	return expecting(function isInRange(value: unknown): value is number {
		return Number.isFinite(value) && (value as number) >= min && (value as number) <= max;
	}, `a number between ${min} and ${max}`);
}

/**
 * Creates a guard accepting safe integers between `min` and `max`, both inclusive (`z.number().int().min().max()`): ports, ages, page
 * numbers. The bounds may be fractional or infinite (`isIntegerInRange(1, Infinity)` is "a positive safe integer"); integers beyond
 * `Number.MAX_SAFE_INTEGER` are rejected, since they cannot be told apart from their neighbours. {@link explain} reports the range.
 * @param {number} min - The smallest accepted integer
 * @param {number} max - The largest accepted integer
 * @returns {(value: unknown) => boolean} A guard narrowing to `number`
 * @throws {TypeError} when `min` or `max` is not a number
 * @throws {RangeError} when `min` is `NaN`, or `max` is `NaN` or smaller than `min`
 * @example
 * const isPort = isIntegerInRange(1, 65535);
 * isPort(8080); // => true
 * isPort(80.5); // => false
 * isPort(0); // => false
 * explain(isPort, 70000); // => [{ message: 'Expected an integer between 1 and 65535 (got 70000)', path: [] }]
 */
export function isIntegerInRange(min: number, max: number): (value: unknown) => value is number {
	assertNumber('isIntegerInRange', 'min', min, min === min, 'a number');
	assertNumber('isIntegerInRange', 'max', max, max >= min, `a number >= min (${min})`);

	return expecting(function isIntegerInBounds(value: unknown): value is number {
		return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
	}, `an integer between ${min} and ${max}`);
}

/**
 * Creates a guard accepting strings whose length (in UTF-16 code units, like `String#length` and zod) is between `min` and `max`,
 * both inclusive: `isStringOfLength(1, 50)` is `z.string().min(1).max(50)`. Pass `Infinity` as `max` for a minimum only, the same
 * number twice for an exact length. {@link explain} reports the expected length and the actual one, never the string itself (it may
 * be a password).
 * @param {number} min - The smallest accepted length, an integer >= 0
 * @param {number} max - The largest accepted length, an integer >= `min` or `Infinity`
 * @returns {(value: unknown) => boolean} A guard narrowing to `string`
 * @throws {TypeError} when `min` or `max` is not a number
 * @throws {RangeError} when `min` is not an integer >= 0, or `max` is neither an integer >= `min` nor `Infinity`
 * @example
 * const isUsername = isStringOfLength(3, 20);
 * isUsername('ada'); // => true
 * isUsername('al'); // => false
 * isStringOfLength(1, Infinity)(''); // => false
 * explain(isUsername, 'al'); // => [{ message: 'Expected a string of 3 to 20 characters (got 2)', path: [] }]
 * explain(isUsername, 42); // => [{ message: 'Expected a string of 3 to 20 characters (got number)', path: [] }]
 */
export function isStringOfLength(min: number, max: number): (value: unknown) => value is string {
	assertNumber('isStringOfLength', 'min', min, Number.isInteger(min) && min >= 0, 'an integer >= 0');
	assertNumber('isStringOfLength', 'max', max, (Number.isInteger(max) && max >= min) || max === Infinity, `an integer >= min (${min}) or Infinity`);

	const expected = `Expected a string of ${min === max ? `exactly ${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`} characters`;

	return failing(
		function isStringWithLength(value: unknown): value is string {
			return typeof value === 'string' && value.length >= min && value.length <= max;
		},
		function (value: unknown): string {
			return `${expected} (got ${typeof value === 'string' ? value.length : typeName(value)})`;
		}
	);
}

/**
 * Creates a guard accepting strings that match `pattern` (`z.string().regex()`). The pattern is copied without its `g` and `y` flags,
 * so the guard is stateless: `RegExp#test` with those flags advances `lastIndex`, which makes a shared global regex alternate between
 * `true` and `false` on the same input. Linear-time matching is up to the pattern: avoid nested quantifiers on untrusted input.
 * {@link explain} reports the pattern, never the string itself.
 * @param {RegExp} pattern - The pattern the whole string must satisfy (anchor it with `^…$` to match the whole string)
 * @returns {(value: unknown) => boolean} A guard narrowing to `string`
 * @throws {TypeError} when `pattern` is not a regular expression
 * @example
 * const isHandle = isStringMatching(/^@[a-z0-9_]+$/);
 * isHandle('@ada_l'); // => true
 * isHandle('ada'); // => false
 * const isWord = isStringMatching(/^\w+$/g);
 * [isWord('abc'), isWord('abc')]; // => [true, true] // a plain `/^\w+$/g.test` alternates true, false
 * explain(isHandle, 'ada'); // => [{ message: 'Expected a string matching /^@[a-z0-9_]+$/ (got string)', path: [] }]
 */
export function isStringMatching(pattern: RegExp): (value: unknown) => value is string {
	if (!isRegExp(pattern)) throw new TypeError(`isStringMatching: \`pattern\` must be a RegExp, got ${typeName(pattern)}`);

	const regex = new RegExp(pattern, pattern.flags.replace(/[gy]/g, ''));

	return expecting(
		function isMatchingString(value: unknown): value is string {
			return typeof value === 'string' && regex.test(value);
		},
		`a string matching ${String(regex)}`
	);
}

/**
 * The type a {@link isDiscriminatedUnion} guard narrows to: for each variant, its guard's type with the discriminant set to the variant name.
 * @template K - The discriminant key
 * @template V - The variant guards, by discriminant value
 */
export type DiscriminatedUnionType<K extends string, V extends ShapeGuards> = {
	[T in keyof V & (string | number)]: { [P in K]: `${T}` } & Infer<V[T]> extends infer O ? { [P in keyof O]: O[P] } : never;
}[keyof V & (string | number)];

/**
 * Creates a guard for a discriminated (tagged) union (`z.discriminatedUnion()`): objects whose OWN string property `key` names one of
 * the `variants`, and that pass that variant's guard. Each variant guard checks the rest of the object; the discriminant is checked
 * once, and added to the narrowed type, so variants do not repeat it (an `{ exact: true }` variant shape accepts it as a known key).
 * Tags that look like numbers (`{ 200: …, 404: … }`) are the strings `'200'` and `'404'`. Unlike {@link isUnion}, which tries every member in turn, the
 * variant is looked up directly: checking stays fast with many variants, and {@link explain} reports the issues of the right variant
 * (or the allowed tags, when the discriminant is wrong). Tags are strings; inherited keys (`toString`, `__proto__`) never match.
 * @template K - The discriminant key
 * @template V - The variant guards, by discriminant value
 * @param {K} key - The discriminant property, e.g. `'type'` or `'kind'`
 * @param {V} variants - A plain object mapping each discriminant value to the guard of its variant (at least one)
 * @returns {(value: unknown) => boolean} A guard narrowing to {@link DiscriminatedUnionType}
 * @throws {TypeError} when `key` is not a string, or `variants` is not a plain object of functions
 * @throws {RangeError} when `variants` is empty
 * @example
 * const isShapeEvent = isDiscriminatedUnion('type', {
 *   circle: isShape({ radius: isFiniteNumber }),
 *   square: isShape({ side: isFiniteNumber })
 * });
 * isShapeEvent({ type: 'circle', radius: 2 }); // => true // narrows to { type: 'circle'; radius: number } | { type: 'square'; side: number }
 * isShapeEvent({ type: 'square', radius: 2 }); // => false
 * explain(isShapeEvent, { type: 'square', side: '2' }); // => [{ message: 'Invalid value (got string)', path: ['side'] }]
 * explain(isShapeEvent, { type: 'hexagon' }); // => [{ message: 'Expected "circle" or "square" (got string)', path: ['type'] }]
 */
export function isDiscriminatedUnion<const K extends string, const V extends ShapeGuards>(key: K, variants: V): (value: unknown) => value is DiscriminatedUnionType<K, V> {
	if (typeof key !== 'string') throw new TypeError(`isDiscriminatedUnion: \`key\` must be a string, got ${typeName(key)}`);
	if (!isPlainObject(variants)) throw new TypeError(`isDiscriminatedUnion: \`variants\` must be a plain object, got ${typeName(variants)}`);

	const tags = Object.keys(variants);

	if (tags.length === 0) throw new RangeError('isDiscriminatedUnion: `variants` must have at least one variant, got 0');

	const lookup = new Map<unknown, Guard<unknown>>();

	for (const tag of tags) {
		// Read once: a getter could return a function when checked, then something else.
		const variant: unknown = variants[tag];

		assertFunction('isDiscriminatedUnion', `variants.${tag}`, variant);
		lookup.set(tag, variant as Guard<unknown>);
	}

	const quoted = tags.map(function (tag: string): string {
		return describe(tag);
	});
	const expected = `Expected ${quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`}`;

	/**
	 * Returns the guard of the variant named by `value[key]`.
	 * @param {object} value - A non-null object
	 * @returns {Guard<unknown> | undefined} The variant guard, or `undefined` when the discriminant is missing or unknown
	 */
	function variantOf(value: object): Guard<unknown> | undefined {
		return hasOwn.call(value, key) ? lookup.get((value as Record<string, unknown>)[key]) : undefined;
	}

	/**
	 * Runs `check` on the object with its discriminant allowed in exact shapes (see {@link discriminated}).
	 * @param {object} value - The object
	 * @param {() => boolean} check - The variant check
	 * @returns {boolean} The result of `check`
	 */
	function withDiscriminant(value: object, check: () => boolean): boolean {
		const previous = discriminated;
		discriminated = { object: value, key, previous };
		try {
			return check();
		} finally {
			discriminated = previous;
		}
	}

	return scored(
		explainable(
			function isVariant(value: unknown): value is DiscriminatedUnionType<K, V> {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

				const guard = variantOf(value);

				return (
					guard !== undefined &&
					withDiscriminant(value, function (): boolean {
						return guard(value);
					})
				);
			},
			function explainVariant(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) {
					issues.push({ message: `Expected an object (got ${Array.isArray(value) ? 'array' : typeName(value)})`, path: path.slice() });

					return false;
				}

				const guard = variantOf(value);

				if (guard !== undefined) {
					return withDiscriminant(value, function (): boolean {
						return collect(guard, value, path, issues);
					});
				}
				issues.push(
					hasOwn.call(value, key)
						? { message: `${expected} (got ${typeName((value as Record<string, unknown>)[key])})`, path: [...path, key] }
						: { message: 'Missing required property', path: [...path, key] }
				);

				return false;
			}
		),
		function scoreVariant(value: unknown): number {
			const guard = typeof value === 'object' && value !== null && !Array.isArray(value) ? variantOf(value) : undefined;

			if (guard !== undefined) return guardScore(guard, value);

			// A wrong or missing tag: further than any failure of the right variant (below 1), closer than a value that is not an object.
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? 1 : 2;
		}
	);
}

/**
 * The type an {@link isIntersection} guard narrows to: the intersection of the member types, taken member by member (going through their
 * union would first simplify `number | 1` to `number`, or `{ a: string } | unknown` to `unknown`).
 * @template G - The member guards
 */
export type IntersectionType<G extends ReadonlyArray<Guard<unknown>>> = G extends readonly [infer Head, ...infer Tail extends ReadonlyArray<Guard<unknown>>]
	? Infer<Head> & IntersectionType<Tail>
	: G extends readonly []
		? unknown
		: UnionToIntersection<Infer<G[number]>>;

/**
 * Creates a guard that passes when EVERY one of `guards` passes, narrowing to the intersection of their types (`z.intersection()`).
 * The guards run in order and stop at the first failure; {@link explain} reports the issues of every failing member (duplicates
 * removed). Shapes built with `{ exact: true }` reject each other's keys, so intersect non-exact shapes.
 * @template G - The member guards
 * @param {...G} guards - The member guards (at least one)
 * @returns {(value: unknown) => boolean} A guard narrowing to the intersection of the members' types
 * @throws {TypeError} when a member is not a function
 * @throws {RangeError} when no guard is given
 * @example
 * const isNamed = isShape({ name: isString });
 * const isAged = isShape({ age: isInteger });
 * const isPerson = isIntersection(isNamed, isAged); // { name: string } & { age: number }
 * isPerson({ name: 'Ada', age: 36 }); // => true
 * isPerson({ name: 'Ada' }); // => false
 * explain(isPerson, 1); // => [{ message: 'Expected an object (got number)', path: [] }]
 */
export function isIntersection<const G extends ReadonlyArray<Guard<unknown>>>(...guards: G): (value: unknown) => value is IntersectionType<G> {
	if (guards.length === 0) throw new RangeError('isIntersection: expected at least one guard, got 0');
	assertGuards('isIntersection', guards);

	const members = guards.slice();

	return scored(
		explainable(
			function isIntersectionMember(value: unknown): value is IntersectionType<G> {
				for (let index = 0; index < members.length; index++) if (!members[index](value)) return false;

				return true;
			},
			function explainIntersection(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
				// The issues kept, by message and path as text: two paths can give the same text (symbols of the same description, or a key
				// holding `\0`), so the paths are then compared.
				const seen = new Map<string, SchemaIssue[]>();
				let passed = true;

				for (let index = 0; index < members.length; index++) {
					const found: SchemaIssue[] = [];

					if (collect(members[index], value, path, found)) continue;
					passed = false;
					for (const issue of found) {
						const id = `${issue.path.map(String).join('\0')}\u0001${issue.message}`;
						const same = seen.get(id) ?? [];

						if (
							!same.some(function (other: SchemaIssue): boolean {
								return samePath(other.path, issue.path);
							})
						) {
							seen.set(id, same);
							same.push(issue);
							issues.push(issue);
						}
					}
				}

				return passed;
			}
		),
		function scoreIntersection(value: unknown): number {
			let worst = 0;

			for (let index = 0; index < members.length; index++) if (!members[index](value)) worst = Math.max(worst, guardScore(members[index], value));

			return worst;
		}
	);
}

/**
 * Creates a guard that passes when `guard` passes AND `predicate` accepts the (narrowed) value (`.refine()` in zod). A type-guard
 * predicate narrows further. {@link explain} reports the issues of `guard` when it fails, else one issue with `message`: this is how
 * `isEmail`, `isUuid` and other validators get custom messages and paths.
 * @template T - The type checked by `guard`
 * @template U - The type narrowed by `predicate`
 * @param {Guard<T>} guard - The base guard
 * @param {(value: T) => value is U} predicate - The extra check, only called with values that passed `guard`
 * @param {string | ((value: T) => string)} [message='Invalid value (got <type>)'] - The issue message, or a function building it
 * @returns {(value: unknown) => boolean} A guard narrowing to `U`
 * @throws {TypeError} when `guard` or `predicate` is not a function, or `message` is neither a string, a function nor `undefined`
 * @example
 * const isEven = refine(isInteger, function (n) { return n % 2 === 0; }, 'Expected an even number');
 * isEven(4); // => true
 * isEven(3); // => false
 * explain(isShape({ n: isEven }), { n: 3 }); // => [{ message: 'Expected an even number', path: ['n'] }]
 * explain(isShape({ n: isEven }), { n: 'x' }); // => [{ message: 'Invalid value (got string)', path: ['n'] }]
 */
export function refine<T, U extends T>(guard: Guard<T>, predicate: (value: T) => value is U, message?: string | ((value: T) => string)): (value: unknown) => value is U;
/**
 * Creates a guard that passes when `guard` passes AND `predicate` returns `true` for the (narrowed) value.
 * @template T - The type checked by `guard`
 * @param {Guard<T>} guard - The base guard
 * @param {(value: T) => boolean} predicate - The extra check, only called with values that passed `guard`
 * @param {string | ((value: T) => string)} [message='Invalid value (got <type>)'] - The issue message, or a function building it
 * @returns {(value: unknown) => boolean} A guard narrowing to `T`
 * @throws {TypeError} when `guard` or `predicate` is not a function, or `message` is neither a string, a function nor `undefined`
 * @example
 * const isShortString = refine(isString, function (s) { return s.length <= 3; });
 * isShortString('abc'); // => true
 * isShortString('abcd'); // => false
 */
export function refine<T>(guard: Guard<T>, predicate: (value: T) => boolean, message?: string | ((value: T) => string)): (value: unknown) => value is T;
/**
 * Implementation of the overloads above.
 * @template T - The type checked by `guard`
 * @param {Guard<T>} guard - The base guard
 * @param {(value: T) => boolean} predicate - The extra check
 * @param {string | ((value: T) => string)} [message] - The issue message
 * @returns {(value: unknown) => boolean} The refined guard
 * @example
 * refine(isFiniteNumber, function (n) { return n > 0; })(1); // => true
 */
export function refine<T>(guard: Guard<T>, predicate: (value: T) => boolean, message?: string | ((value: T) => string)): (value: unknown) => value is T {
	assertFunction('refine', 'guard', guard);
	assertFunction('refine', 'predicate', predicate);
	if (message !== undefined && typeof message !== 'string' && typeof message !== 'function') {
		throw new TypeError(`refine: \`message\` must be a string or a function, got ${typeName(message)}`);
	}

	return scored(
		explainable(
			function isRefined(value: unknown): value is T {
				return guard(value) && predicate(value);
			},
			function explainRefined(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
				if (!collect(guard, value, path, issues)) return false;
				if (predicate(value as T)) return true;

				issues.push({
					message: message === undefined ? `Invalid value (got ${typeName(value)})` : typeof message === 'string' ? message : String(message(value as T)),
					path: path.slice()
				});

				return false;
			}
		),
		function scoreRefined(value: unknown): number {
			// A value the base guard accepts only failed the predicate: as close as a rejected value gets.
			return guard(value) ? 0 : guardScore(guard, value);
		}
	);
}

/**
 * Whether two issue paths are the same.
 * @param {ReadonlyArray<PropertyKey>} a - A path
 * @param {ReadonlyArray<PropertyKey>} b - Another path
 * @returns {boolean} `true` when they have the same segments
 */
function samePath(a: ReadonlyArray<PropertyKey>, b: ReadonlyArray<PropertyKey>): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;

	return true;
}

/**
 * Where {@link isLazy} explained an object that failed: the path it reported it at, the {@link explain} call that did (`run`), and the
 * outermost `explain` call around that one (`root`).
 */
interface LazyReport {
	readonly path: PropertyKey[];
	readonly run: object;
	readonly root: object;
}

/**
 * The {@link explain} call running right now (a fresh object per call, `undefined` outside one), and the outermost one running
 * (`explainRoot`, whose report is the one its caller sees). The root report gives an object that {@link isLazy} reported during another
 * call (a guard or predicate calling `explain` itself, whose issues may have been dropped, or another root call, as the validate module
 * makes several in one parse) in full; a nested call gives a pointer issue for any object already reported during the same root call, so
 * that a guard explaining at each level of a recursive value cannot make the report exponential. A call made while a lazy guard checks
 * a value outside `explain` (`lazyChecks` of them running) is nested too, in the check (`checkRoot`, shared by the calls made during the
 * outermost check): a guard or predicate there explaining each level once the levels below were checked (and explained) would otherwise
 * report them all again at each level.
 */
let explainRun: object | undefined;
let explainRoot: object | undefined;
let lazyChecks = 0;
let checkRoot: object | undefined;

/**
 * Returns the table of a lazy guard's results for `value` while a discriminated union checks it (`discriminated.object === value`; the
 * lazy guard uses its plain table otherwise): one table per set of discriminant keys, created on first use, since an exact shape accepts
 * those keys on `value` there and nowhere else. Only the innermost run of entries for `value` counts: deeper ones belong to an ancestor
 * check, which only a cycle (always rejected) meets again.
 * @param {object} value - The object checked
 * @param {Map<string, Map<object, unknown>>} contextual - The tables by discriminant keys
 * @returns {Map<object, unknown>} The table
 */
function tableOf(value: object, contextual: Map<string, Map<object, unknown>>): Map<object, unknown> {
	const keys: string[] = [];

	for (let entry = discriminated; entry !== undefined && entry.object === value; entry = entry.previous) if (!keys.includes(entry.key)) keys.push(entry.key);

	// Sorted and length-prefixed: the same set of keys always gives the same context.
	const context = keys
		.sort()
		.map(function (key: string): string {
			return `${key.length}:${key}`;
		})
		.join('');
	let table = contextual.get(context);

	if (table === undefined) {
		table = new Map<object, unknown>();
		contextual.set(context, table);
	}

	return table;
}

/**
 * Whether a lazy guard is explaining `value` in any of its tables: meeting it again, in whatever discriminant context, means a cycle.
 * @param {object} value - The object met
 * @param {Map<object, unknown>} plain - The table outside discriminated unions
 * @param {Map<string, Map<object, unknown>>} contextual - The tables by discriminant keys
 * @returns {boolean} `true` when `value` is `PENDING` in one of them
 */
function isPending(value: object, plain: Map<object, unknown>, contextual: Map<string, Map<object, unknown>>): boolean {
	if (plain.get(value) === PENDING) return true;
	for (const table of contextual.values()) if (table.get(value) === PENDING) return true;

	return false;
}

/**
 * Creates a guard that defers to the guard returned by `getter`, called once on first use: the way to write recursive schemas
 * (`z.lazy()`), whose guard must refer to itself before it exists. Annotate the result (`const isTree: Guard<Tree> = ...`), since
 * TypeScript cannot infer a recursive type.
 *
 * Cycle-safe: a value that reaches itself through the same lazy guard (`node.children = [node]`) is rejected, and {@link explain}
 * reports `Circular reference` where the lazy guard meets the value again, instead of overflowing the stack. Shared (non-circular) sub-values are fine.
 * Rejecting cycles also guarantees that recursive code consuming the narrowed value terminates. Each object is checked once per check
 * by each lazy guard, which keeps a recursive {@link isUnion} linear in the size of the value however its members differ, and a value
 * nested so deeply that checking it would overflow the stack is rejected (explained as `Value is nested too deeply`). {@link explain}
 * reports an invalid object the value holds in several places at the first place only, the others getting one `Invalid value (same
 * object as reported at another path)` issue, so that a value sharing objects cannot make the report (or its cost) grow exponentially.
 * The outermost `explain` call reports in full an object that an `explain` call made inside it (by a guard or a predicate) reported
 * first. Such an inner call, or one made by a guard or a predicate while a lazy guard checks a value (also through {@link ensure} or a
 * parse of the validate module), gives the pointer issue for an object already reported during the outermost check or `explain`, so that
 * explaining at each level of a recursive value stays linear: its report tells whether the value passes, not always why. Inside an
 * {@link isDiscriminatedUnion}, where an exact shape accepts the discriminant, an object is checked apart from its uses elsewhere.
 * @template T - The guarded type
 * @param {() => Guard<T>} getter - Returns the guard (called once, on the first check)
 * @returns {(value: unknown) => boolean} A guard narrowing to `T`
 * @throws {TypeError} when `getter` is not a function, and on first use when it does not return a function
 * @example
 * type Tree = { value: number; children: Tree[] };
 * const isTree: Guard<Tree> = isShape({ value: isFiniteNumber, children: isArrayOf(isLazy(function () { return isTree; })) });
 * isTree({ value: 1, children: [{ value: 2, children: [] }] }); // => true
 * explain(isTree, { value: 1, children: [{ value: '2', children: [] }] }); // => [{ message: 'Invalid value (got string)', path: ['children', 0, 'value'] }]
 * const loop: Tree = { value: 1, children: [] };
 * loop.children.push(loop);
 * isTree(loop); // => false
 * explain(isTree, loop); // => [{ message: 'Circular reference', path: ['children', 0, 'children', 0] }]
 */
export function isLazy<T>(getter: () => Guard<T>): (value: unknown) => value is T {
	assertFunction('isLazy', 'getter', getter);

	let resolved: Guard<T> | undefined;
	// The result for each object checked by this guard during the current check (see `utils/memo.ts`), and for each object explained during
	// the current `explain`: `PENDING` while it is being explained (meeting it again means a cycle), then `true` when it passed, or where
	// it was reported (a `LazyReport`). Inside a discriminated union's check of the object, other tables, by discriminant keys (see `tableOf`).
	const plainMemo = new Map<object, unknown>();
	const plainReported = new Map<object, unknown>();
	const discriminatedMemos = new Map<string, Map<object, unknown>>();
	const discriminatedReports = new Map<string, Map<object, unknown>>();
	// The values being scored: a union that reaches this guard again on the same value (`isLazy(() => isUnion(a, isNullable(self)))`)
	// would score it forever.
	const scoring = new Set<unknown>();

	/**
	 * Returns the guard, calling `getter` on first use.
	 * @returns {Guard<T>} The guard
	 */
	function resolve(): Guard<T> {
		if (resolved === undefined) {
			const guard = getter();

			if (typeof guard !== 'function') throw new TypeError(`isLazy: \`getter\` must return a function, got ${typeName(guard)}`);
			resolved = guard;
		}

		return resolved;
	}

	const lazyGuard = explainable(
		function isLazyValue(value: unknown): value is T {
			const guard = resolve();

			if (typeof value !== 'object' || value === null) return guard(value);

			// Inline test of the usual case: not inside a discriminated union's check of this object (see `tableOf`). A cycle met in another
			// discriminant context than the one it started in is caught one turn later, in the same context: the result is `false` either way.
			const memo = discriminated === undefined || discriminated.object !== value ? plainMemo : tableOf(value, discriminatedMemos);
			const known = memo.get(value);

			if (known === PENDING) {
				scope.cycles++;

				return false;
			}
			if (known !== undefined) return known === true;
			hold(memo).set(value, PENDING);

			const cycles = scope.cycles;

			scope.depth++;
			lazyChecks++;
			try {
				const passed = guard(value);

				// A result that met a cycle depends on the path that led here (which objects were being checked): it is not remembered.
				if (scope.cycles === cycles) memo.set(value, Boolean(passed));
				else memo.delete(value);

				return passed;
			} catch (error) {
				// Recorded inline, without a call, since a call can overflow again: the first lazy schema to see the error is the deepest.
				if (scope.thrown !== error) {
					scope.thrown = error;
					scope.thrownAt = scope.depth;
				}
				// The outermost check rejects a value too deep to check; inside `explain`, or another lazy guard, the error goes on up.
				if (scope.depth === 1 && isTooDeep(error)) return false;
				memo.delete(value);
				throw error;
			} finally {
				if (--lazyChecks === 0) checkRoot = undefined;
				if (--scope.depth === 0) release();
			}
		},
		function explainLazy(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
			const guard = resolve();

			if (typeof value !== 'object' || value === null) return collect(guard, value, path, issues);

			const reported = discriminated === undefined || discriminated.object !== value ? plainReported : tableOf(value, discriminatedReports);
			const state = reported.get(value);

			if (state === true) return true;
			// A cycle is reported where it closes, whatever the discriminant context it started in.
			if (state === PENDING || (state === undefined && discriminatedReports.size !== 0 && isPending(value, plainReported, discriminatedReports))) {
				issues.push({ message: 'Circular reference', path: path.slice() });

				return false;
			}
			// Reported by this `explain` call (whose issues all reach its result), or, in a nested call, during the same root call: one
			// pointer issue, or none when this call meets it again at the same path (the members of an intersection), where its issues are
			// already (the path of another call's report is another value's). In the root call, an object reported by another call is
			// explained again in full (see `explainRoot`).
			if (state !== undefined && (explainRun === explainRoot ? (state as LazyReport).run === explainRun : (state as LazyReport).root === explainRoot)) {
				if ((state as LazyReport).run !== explainRun || !samePath((state as LazyReport).path, path)) {
					issues.push({ message: 'Invalid value (same object as reported at another path)', path: path.slice() });
				}

				return false;
			}
			// Explainers only run inside `explain` (or a parse of the validate module), whose scope keeps `reported` until it ends: the
			// depth counts the nesting (see `isTooDeep`), and never drops to 0 here.
			hold(reported).set(value, PENDING);
			scope.depth++;

			const before = issues.length;
			let passed = false;

			try {
				passed = collect(guard, value, path, issues);

				return passed;
			} catch (error) {
				// Recorded inline, without a call, since a call can overflow again: the first lazy schema to see the error is the deepest.
				if (scope.thrown !== error) {
					scope.thrown = error;
					scope.thrownAt = scope.depth;
				}
				throw error;
			} finally {
				// The verdict is kept for the other paths to the same object: a value sharing objects (each held twice by the next) is then
				// explained in linear time, with one issue per extra path, instead of once per path (exponential in the depth). A
				// failure that reported nothing (a guard that is not deterministic), or threw, is explained again when met again.
				if (issues.length > before) reported.set(value, { path: path.slice(), run: explainRun, root: explainRoot } as LazyReport);
				else if (passed) reported.set(value, true);
				else reported.delete(value);
				scope.depth--;
			}
		}
	);

	scored(lazyGuard, function scoreLazy(value: unknown): number {
		if (scoring.has(value)) return 1;
		scoring.add(value);
		try {
			return guardScore(resolve(), value);
		} finally {
			scoring.delete(value);
		}
	});

	return lazyGuard;
}

/**
 * The type a pattern of {@link isMatching} narrows to: guards give their type, plain objects and arrays are mapped recursively,
 * dates give `Date`, other functions `unknown`, and any other value its own (literal) type.
 * @template P - The pattern
 */
export type PatternType<P> = P extends ((value: unknown) => value is infer T)
	? T
	: P extends AnyFunction
		? unknown
		: P extends Date
			? Date
			: P extends IdentityPattern
				? P
				: P extends object
					? { -readonly [K in keyof P]: PatternType<P[K]> }
					: P;

/**
 * Built-in objects that a pattern of {@link isMatching} compares by identity, and whose type {@link PatternType} keeps as is. A class
 * instance is compared by identity too, but its type cannot be told apart from a plain object pattern's: it narrows structurally (its
 * methods to `unknown`), so annotate the result or use {@link isInstanceOf} for those.
 */
type IdentityPattern = RegExp | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> | Promise<unknown> | Error | ArrayBuffer | ArrayBufferView;

/**
 * Creates a guard checking that a value deeply matches a partial structural pattern, like ts-pattern's `isMatching`:
 * - a plain-object pattern matches any non-array object having, as OWN properties (inherited ones never count), every own enumerable
 *   key of the pattern (strings and symbols) with a matching value; other keys are ignored. Nested patterns are matched recursively.
 * - an array pattern matches arrays of exactly the same length, element by element (a tuple, not lodash's unordered subset).
 * - a function in the pattern is called as a guard with the property value (`undefined` when the property is missing, so
 *   {@link isOptional} makes a key optional), which mixes literals with any guard of this module.
 * - a `Date` matches dates with the same time; any other value (primitives, maps, class instances…) is compared with SameValueZero
 *   (`NaN` matches `NaN`, `0` matches `-0`, objects by identity).
 *
 * The pattern is compiled once (later mutations do not affect the guard). {@link explain} reports `Missing required property`,
 * `Expected <literal>` and the issues of nested guards with their paths.
 * @template P - The pattern
 * @param {P} pattern - The pattern (a value, a guard, or plain objects and arrays of those)
 * @returns {(value: unknown) => boolean} A guard narrowing to {@link PatternType}
 * @throws {TypeError} when the pattern contains itself (a circular reference)
 * @example
 * const isAdminEvent = isMatching({ type: 'login', user: { role: 'admin', id: isInteger } });
 * isAdminEvent({ type: 'login', at: 1, user: { role: 'admin', id: 7, name: 'Ada' } }); // => true
 * isAdminEvent({ type: 'login', user: { role: 'guest', id: 7 } }); // => false
 * isMatching({ point: [0, isFiniteNumber] })({ point: [-0, 2] }); // => true
 * explain(isAdminEvent, { type: 'login', user: { id: 'x' } }); // => [{ message: 'Missing required property', path: ['user', 'role'] }, { message: 'Invalid value (got string)', path: ['user', 'id'] }]
 */
export function isMatching<const P>(pattern: P): (value: unknown) => value is PatternType<P> {
	return compilePattern(pattern, []) as (value: unknown) => value is PatternType<P>;
}

/**
 * Compiles a pattern of {@link isMatching} into a guard.
 * @param {unknown} pattern - The pattern
 * @param {unknown[]} ancestors - The patterns being compiled around this one (to detect cycles)
 * @returns {Guard<unknown>} The guard
 */
function compilePattern(pattern: unknown, ancestors: unknown[]): Guard<unknown> {
	if (typeof pattern === 'function') return pattern as Guard<unknown>;
	if (isDate(pattern)) {
		const time = dateGetTime.call(pattern);

		return expecting(function isSameDate(value: unknown): value is Date {
			return isDate(value) && sameValueZero(dateGetTime.call(value), time);
		}, `a date with time ${time}`);
	}

	const array = Array.isArray(pattern);

	if (!array && !isPlainObject(pattern)) return literal(pattern);
	if (ancestors.includes(pattern)) throw new TypeError('isMatching: `pattern` must be acyclic, got a circular reference');
	ancestors.push(pattern);

	const source = pattern as Record<PropertyKey, unknown>;
	const keys: PropertyKey[] = array
		? []
		: [
				...Object.keys(source),
				...Object.getOwnPropertySymbols(source).filter(function (key: symbol): boolean {
					return Object.prototype.propertyIsEnumerable.call(source, key);
				})
			];
	const guards: Guard<unknown>[] = [];
	const required: boolean[] = [];

	// A hole is `undefined`, not an element planted on a polluted `Array.prototype` or `Object.prototype` (the tuple checks values that way).
	if (array)
		for (let index = 0; index < (pattern as unknown[]).length; index++) guards.push(compilePattern(hasOwn.call(source, index) ? source[index] : undefined, ancestors));
	for (const key of keys) {
		// Read once: a getter could return a guard, then a literal.
		const value = source[key];

		guards.push(compilePattern(value, ancestors));
		required.push(typeof value !== 'function');
	}
	ancestors.pop();

	return array ? isTuple(...guards) : shapeGuard(keys, guards, required, undefined);
}

/**
 * Lists why `value` fails `guard`, with the path of every offending value; an empty array means it passes. Guards built with
 * {@link isShape}, {@link isMatching}, {@link isArrayOf}, {@link isRecordOf}, {@link isTuple}, {@link isUnion}, {@link isDiscriminatedUnion},
 * {@link isIntersection}, {@link isOptional}, {@link isNullable}, {@link isLazy}, {@link refine}, {@link isOneOf}, {@link isLiteral},
 * {@link isNumberInRange}, {@link isIntegerInRange}, {@link isStringOfLength}, {@link isStringMatching} and {@link withMessage}, and the
 * JSON guards ({@link isJsonValue}…), report precise nested issues; any other guard is reported as one issue at its path. Reports are
 * recursive (unlike {@link isJsonValue}'s check): a value nested more than about a thousand levels deep in a recursive schema
 * ({@link isLazy}) can overflow the stack (a `RangeError`) where the guard alone still answers.
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
	const previousRun = explainRun;
	const previousRoot = explainRoot;

	// The memos of the lazy guards (see `utils/memo.ts`) live until the end, so explaining reuses what checking found.
	explainRun = {};
	if (previousRun === undefined) explainRoot = lazyChecks === 0 ? explainRun : (checkRoot ??= {});
	scope.depth++;
	try {
		// Guards never consult the explainers, so valid values take the fast path and allocate nothing beyond the result.
		if (!guard(value)) {
			collect(guard, value, [], issues);
			// The report re-evaluates: a stateful guard (a global regex) or a getter returning another value may pass then. The value was
			// still rejected, so it is reported (and `ensure` never returns it).
			if (issues.length === 0) issues.push({ message: `Invalid value (got ${typeName(value)})`, path: [] });
		}
	} catch (error) {
		if (scope.depth !== 1 || !isTooDeep(error)) throw error;
		issues.length = 0;
		issues.push({ message: 'Value is nested too deeply', path: [] });
	} finally {
		explainRun = previousRun;
		explainRoot = previousRoot;
		if (--scope.depth === 0) release();
	}

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
 * Groups issues by path, for showing errors next to form fields: each key is a path joined with dots (`'address.city'`, `'tags.1'`,
 * `''` for the root or a missing path), each value the messages at that path, in order. Works with {@link explain}'s result, a
 * {@link ValidationError}'s `issues` and Standard Schema issues from any library (whose path segments may be `{ key }` objects). Keys
 * that contain dots make paths ambiguous (`['a.b']` and `['a', 'b']` both give `'a.b'`). The result has a `null` prototype, so a
 * `__proto__` path is an ordinary key.
 * @param {ReadonlyArray<StandardSchemaIssue>} issues - The issues
 * @returns {Record<string, string[]>} The messages by path
 * @throws {TypeError} when `issues` is not an array
 * @example
 * const isSignup = isShape({ email: isString, age: isIntegerInRange(13, 130), tags: isArrayOf(isString) });
 * issuesByPath(explain(isSignup, { age: 7, tags: ['a', 1] })); // => { email: ['Missing required property'], age: ['Expected an integer between 13 and 130 (got 7)'], 'tags.1': ['Invalid value (got number)'] }
 * issuesByPath(explain(isString, 1)); // => { '': ['Invalid value (got number)'] }
 * issuesByPath([{ message: 'Too short', path: [{ key: 'name' }] }, { message: 'Invalid form' }]); // => { name: ['Too short'], '': ['Invalid form'] }
 */
export function issuesByPath(issues: ReadonlyArray<StandardSchemaIssue>): Record<string, string[]> {
	if (!Array.isArray(issues)) throw new TypeError(`issuesByPath: \`issues\` must be an array, got ${typeName(issues)}`);

	const grouped: Record<string, string[]> = Object.create(null);

	for (let index = 0; index < issues.length; index++) {
		// A hole is `undefined` (rejected as such), not an issue planted on a polluted `Array.prototype` or `Object.prototype`.
		const issue = hasOwn.call(issues, index) ? issues[index] : (undefined as never);
		// An own `path` only: a root issue of another library may have none, and must not take one planted on `Object.prototype`.
		const key = (readOption(issue, 'path') ?? [])
			.map(function (segment: PropertyKey | { readonly key: PropertyKey }): string {
				return String(typeof segment === 'object' && segment !== null ? segment.key : segment);
			})
			.join('.');

		(grouped[key] ??= []).push(issue.message);
	}

	return grouped;
}

/**
 * An issue as any [Standard Schema](https://standardschema.dev) validator reports it: the {@link SchemaIssue}s of this module, or those
 * of zod, valibot and the rest, whose path is optional and may hold `{ key }` segments.
 */
export interface StandardSchemaIssue {
	/** What is wrong. */
	readonly message: string;
	/** Where it is wrong, from the root; missing for the root itself. */
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
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

/**
 * A JSON array: what `JSON.parse` returns for `[...]` text.
 */
export type JsonArray = JsonValue[];

/**
 * A JSON object: what `JSON.parse` returns for `{...}` text.
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Any value that `JSON.stringify` writes and `JSON.parse` reads back unchanged: `null`, booleans, finite numbers, strings, and plain
 * objects and arrays of those.
 */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;

/**
 * Whether `JSON.stringify` would call a `toJSON` method of `value` that walking it does not reach: a non-enumerable or inherited one, or
 * any `toJSON` of an array (whose walk only visits the indexes). An own enumerable `toJSON` of a plain object is reported by the walk
 * itself, as a function.
 * @param {object} value - An array or a plain object
 * @returns {boolean} `true` when such a method would replace `value` in the JSON text
 */
function hasHiddenToJSON(value: object): boolean {
	return typeof (value as { toJSON?: unknown }).toJSON === 'function' && (Array.isArray(value) || !Object.prototype.propertyIsEnumerable.call(value, 'toJSON'));
}

/** Marks, on the stack of {@link walkJson}, the end of a container's children: a container it records, and one it does not. */
const EXIT = {};
const LEAF_EXIT = {};

/**
 * Checks that `root` is a JSON value without recursion (so arbitrarily deep values cannot overflow the stack), rejecting cycles.
 * In reporting mode (`issues` given) every problem is recorded with its path; otherwise the walk stops at the first one.
 * @param {unknown} root - The value to check
 * @param {PropertyKey[] | undefined} path - The path of `root` (reporting mode; restored before returning)
 * @param {SchemaIssue[] | undefined} issues - Where issues are pushed (reporting mode)
 * @returns {boolean} Whether `root` is a JSON value
 */
function walkJson(root: unknown, path: PropertyKey[] | undefined, issues: SchemaIssue[] | undefined): boolean {
	// Pairs of (key, value), and (container, EXIT) once a container's children are pushed. The root pair is the only one popped from
	// an otherwise empty stack, and the root's EXIT pair is popped last.
	const stack: unknown[] = [undefined, root];
	// Each container holding containers, once met: the number of issues before its walk while it is walked (meeting it again then means a
	// cycle), then whether it passed. Such a container held in several places is walked once, so a value sharing containers (each held
	// twice by the next, as YAML aliases build) is checked in linear time instead of once per path, exponential in its depth. Small
	// containers of primitives only (most of them) are not recorded: they cannot be part of a cycle, and walking one again costs no more
	// than the reference to it did; a large one is recorded, or a list holding it many times would walk it once per place (quadratic).
	const walked = new Map<unknown, number | boolean>();
	let passed = true;

	while (stack.length > 0) {
		const value = stack.pop();
		const key = stack.pop() as PropertyKey;
		const isRoot = stack.length === 0;
		let message: string;

		if (value === EXIT || value === LEAF_EXIT) {
			if (value === EXIT) walked.set(key, issues === undefined || issues.length === walked.get(key));
			if (path !== undefined && !isRoot) path.pop();
			continue;
		}
		if (typeof value === 'object' && value !== null) {
			const state = walked.get(value);

			if (state === true) continue;
			if (state === false) {
				message = 'Invalid value (same object as reported at another path)';
			} else if (state !== undefined) {
				message = 'Circular reference';
			} else if ((Array.isArray(value) || isPlainObject(value)) && !hasHiddenToJSON(value)) {
				const exit = stack.length + 1;
				let nested = false;

				if (path !== undefined && !isRoot) path.push(key);
				stack.push(value, LEAF_EXIT);
				if (Array.isArray(value)) {
					// Holes read as `undefined` (also under a polluted `Array.prototype`), which is rejected: `JSON.stringify` writes them as `null`.
					const polluted = isArrayPrototypePolluted();

					for (let index = value.length - 1; index >= 0; index--) {
						const child = polluted && !hasOwn.call(value, index) ? undefined : value[index];

						if (typeof child === 'object' && child !== null) nested = true;
						stack.push(index, child);
					}
				} else {
					const keys = Object.keys(value);

					for (let index = keys.length - 1; index >= 0; index--) {
						const child = value[keys[index]];

						if (typeof child === 'object' && child !== null) nested = true;
						stack.push(keys[index], child);
					}
				}
				// More than 15 children: a large container.
				if (nested || stack.length > exit + 31) {
					walked.set(value, issues === undefined ? 0 : issues.length);
					stack[exit] = EXIT;
				}
				continue;
			} else {
				message = `Expected a JSON value (got ${describe(value)})`;
			}
		} else if (typeof value === 'number') {
			if (Number.isFinite(value)) continue;
			message = `Expected a finite number (got ${value})`;
		} else if (value === null || typeof value === 'string' || typeof value === 'boolean') {
			continue;
		} else {
			message = `Expected a JSON value (got ${typeName(value)})`;
		}
		if (issues === undefined) return false;
		issues.push({ message, path: isRoot ? (path as PropertyKey[]).slice() : [...(path as PropertyKey[]), key] });
		passed = false;
	}

	return passed;
}

/**
 * Reports the issues of a value checked by one of the JSON guards.
 * @param {Guard<unknown>} guard - {@link isJsonValue}, {@link isJsonObject} or {@link isJsonArray}
 * @param {unknown} value - The value to check
 * @param {PropertyKey[]} path - The path of `value`
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {boolean} Whether `value` passed
 */
function explainJson(guard: Guard<unknown>, value: unknown, path: PropertyKey[], issues: SchemaIssue[]): boolean {
	if (guard === isJsonObject ? isPlainObject(value) : guard === isJsonArray ? Array.isArray(value) : true) return walkJson(value, path, issues);
	issues.push({ message: `Expected ${guard === isJsonObject ? 'a plain object' : 'an array'} (got ${typeName(value)})`, path: path.slice() });

	return false;
}

/**
 * Checks that a value survives a JSON round trip unchanged: `null`, booleans, strings, finite numbers (`-0` is accepted, although
 * JSON writes it as `0`), and plain objects and arrays of those, at any depth. Rejected: `NaN` and `±Infinity` (written as `null`),
 * `undefined`, functions, symbols and bigints (dropped, or throwing), sparse arrays (holes become `null`), dates, maps, class instances
 * and other non-plain objects (including those with a `toJSON` method), and circular references (which make `JSON.stringify` throw).
 * Symbol keys are ignored, as `JSON.stringify` does. The walk is iterative, so arbitrarily deep values cannot overflow the stack, and
 * {@link explain} reports the path of every offending value. A container held in several places is walked once, so the cost is linear in
 * the size of the value even when it shares containers (YAML aliases), where `JSON.stringify` is exponential; {@link explain} reports
 * an invalid one at its first path and gives one `Invalid value (same object as reported at another path)` issue at each other path
 * (a container of fewer than 16 primitives is cheap enough to be checked, and reported, again at each path).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a JsonValue
 * @example
 * isJsonValue({ a: [1, 'x', null, { b: true }] }); // => true
 * isJsonValue({ a: undefined }); // => false
 * isJsonValue([1, NaN]); // => false
 * isJsonValue({ at: new Date(0) }); // => false
 * explain(isJsonValue, { a: [1, Infinity] }); // => [{ message: 'Expected a finite number (got Infinity)', path: ['a', 1] }]
 */
export function isJsonValue(value: unknown): value is JsonValue {
	return walkJson(value, undefined, undefined);
}

/**
 * Checks that a value is a plain object that survives a JSON round trip (see {@link isJsonValue}).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a JsonObject
 * @example
 * isJsonObject({ a: 1 }); // => true
 * isJsonObject([1]); // => false
 * isJsonObject({ a: 1n }); // => false
 */
export function isJsonObject(value: unknown): value is JsonObject {
	return isPlainObject(value) && walkJson(value, undefined, undefined);
}

/**
 * Checks that a value is an array that survives a JSON round trip (see {@link isJsonValue}).
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is a JsonArray
 * @example
 * isJsonArray([1, 'a', { b: null }]); // => true
 * isJsonArray([1, , 3]); // => false
 * isJsonArray({ 0: 1 }); // => false
 */
export function isJsonArray(value: unknown): value is JsonArray {
	return Array.isArray(value) && walkJson(value, undefined, undefined);
}
