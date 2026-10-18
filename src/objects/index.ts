import {
	isArray,
	isBoolean,
	isDate,
	isArrayBuffer,
	isError,
	isFunction,
	isMap,
	isNull,
	isNumber,
	isObject,
	isPlainObject,
	isPromise,
	isRegExp,
	isSet,
	isString,
	isSymbol,
	isUndefined,
	isWeakMap,
	isWeakSet
} from '../guards/index.js';
import { assertFunction, assertInteger, describe } from '../utils/assert.js';
import type { AnyFunction, DeepReadonly, NestedKeyOf, PathValue, Primitive, UnionToIntersection } from '../utils/index.js';

// Backward compatibility: these type guards MOVED to the `guards` module (where they are real type predicates).
// They are re-exported here so existing `objects` imports keep working; prefer importing them from `guards`.
export { isObject, isArray, isFunction, isString, isNumber, isBoolean, isUndefined, isNull, isSymbol, isPromise, isRegExp, isError, isMap, isSet, isWeakMap, isWeakSet };

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The empty object type `{}` (spelled so that it passes the `ban-types` lint rule).
 */
type EmptyObject = Record<never, never>;

/**
 * Flattens an intersection of object types into a single object type (purely cosmetic, improves editor tooltips).
 */
export type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * The keys of `T` that are declared optional.
 */
export type OptionalKeysOf<T> = { [K in keyof T]-?: EmptyObject extends Pick<T, K> ? K : never }[keyof T];

/**
 * The type produced by spreading `B` over `A` (`{ ...a, ...b }`): keys of `B` override keys of `A`.
 * When a key is optional in `B` but present in `A`, the result is `A[K] | B[K]` (B may or may not provide it).
 * @example
 * type M = Merge<{ a: number; b: string }, { b: boolean; c?: number }>; // { a: number; b: boolean; c?: number }
 */
export type Merge<A, B> = Simplify<
	{ [K in keyof A as K extends keyof B ? never : K]: A[K] } & { [K in keyof B as K extends keyof A ? (K extends OptionalKeysOf<B> ? never : K) : K]: B[K] } & {
		[K in keyof A as K extends OptionalKeysOf<B> ? K : never]: A[K] | B[K & keyof B];
	}
>;

/**
 * Left-to-right {@link Merge} of a target with a tuple of sources (later sources win).
 * For non-tuple arrays of sources (unknown length) every source key becomes optional.
 * @example
 * type M = MergeAll<{ a: 1 }, [{ b: 2 }, { a: 'x' }]>; // { a: 'x'; b: 2 }
 */
export type MergeAll<T, S extends readonly unknown[]> = S extends readonly [infer Head, ...infer Tail]
	? MergeAll<Merge<T, Head>, Tail>
	: S extends readonly []
		? T
		: Merge<T, Partial<UnionToIntersection<S[number]>>>;

/**
 * Values that {@link deepMerge} never merges recursively (they replace the previous value instead).
 */
type NonMergeable =
	| Primitive
	| AnyFunction
	| ReadonlyArray<unknown>
	| Date
	| RegExp
	| Map<unknown, unknown>
	| Set<unknown>
	| WeakMap<object, unknown>
	| WeakSet<object>
	| PromiseLike<unknown>
	| Error
	| ArrayBuffer
	| ArrayBufferView;

/**
 * Whether `T` is a (non-union) object type that {@link deepMerge} merges recursively.
 */
type IsMergeable<T> = [T] extends [NonMergeable] ? false : [T] extends [object] ? true : false;

/**
 * Result of merging the value `B` over the value `A` in {@link DeepMerge}.
 */
type DeepMergeValue<A, B> = IsMergeable<A> extends true ? (IsMergeable<B> extends true ? DeepMerge<A, B> : B) : B;

/**
 * The type produced by {@link deepMerge}: like {@link Merge}, but keys holding objects on both sides are merged recursively.
 * @example
 * type M = DeepMerge<{ a: { x: number; y: string } }, { a: { x: boolean } }>; // { a: { x: boolean; y: string } }
 */
export type DeepMerge<A, B> = Simplify<
	{ [K in keyof A as K extends keyof B ? never : K]: A[K] } & {
		[K in keyof B as K extends keyof A ? (K extends OptionalKeysOf<B> ? never : K) : K]: K extends keyof A ? DeepMergeValue<A[K], B[K]> : B[K];
	} & { [K in keyof A as K extends OptionalKeysOf<B> ? K : never]: A[K] | DeepMergeValue<A[K], Exclude<B[K & keyof B], undefined>> }
>;

/**
 * Left-to-right {@link DeepMerge} of a target with a tuple of sources (later sources win).
 */
export type DeepMergeAll<T, S extends readonly unknown[]> = S extends readonly [infer Head, ...infer Tail]
	? DeepMergeAll<DeepMerge<T, Head>, Tail>
	: S extends readonly []
		? T
		: DeepMerge<T, Partial<UnionToIntersection<S[number]>>>;

/**
 * Any object, seen as a record of properties (for reading and writing arbitrary keys).
 */
type Properties = Record<PropertyKey, unknown>;

/**
 * The type produced by {@link invert}: values become keys and keys become (string) values.
 * @example
 * type I = Invert<{ a: 'x'; b: 'y' }>; // { x: 'a'; y: 'b' }
 */
export type Invert<T> = { -readonly [K in keyof T as T[K] & PropertyKey]: K extends number ? `${K}` : K };

// ---------------------------------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Keys that must never be written or deleted through a user-controlled path (prototype pollution). */
const UNSAFE_KEYS: ReadonlySet<PropertyKey> = new Set<PropertyKey>(['__proto__', 'constructor', 'prototype']);

/**
 * Whether `object` has an own property named `key`.
 * @param {object} object - The object to inspect
 * @param {PropertyKey} key - The key to look for
 * @returns {boolean} Whether the property is an own property
 */
function hasOwn(object: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Own enumerable keys of an object, string keys first (in `Object.keys` order) followed by symbol keys.
 * @param {object} object - The object to inspect
 * @returns {PropertyKey[]} The own enumerable string and symbol keys
 */
function ownEnumerableKeys(object: object): PropertyKey[] {
	const keys: PropertyKey[] = Object.keys(object);
	for (const symbol of Object.getOwnPropertySymbols(object)) {
		if (Object.prototype.propertyIsEnumerable.call(object, symbol)) keys.push(symbol);
	}
	return keys;
}

/**
 * Defines an own, enumerable, writable, configurable data property. Unlike assignment it never triggers
 * setters (notably `Object.prototype.__proto__`), so a `'__proto__'` key becomes a harmless own property.
 * @param {object} object - The object to write to
 * @param {PropertyKey} key - The property key
 * @param {unknown} value - The value to store
 * @returns {void}
 */
function defineOwn(object: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Same effect as {@link defineOwn}, for objects CREATED BY THIS MODULE, whose own properties are all writable, enumerable and
 * configurable data properties (a user object could have other ones, or be a proxy observing the difference). Plain assignment then
 * has exactly that effect, several times faster, unless the key is only inherited: an inherited setter or read-only property would
 * intercept it.
 * @param {object} object - The object to write to
 * @param {PropertyKey} key - The property key
 * @param {unknown} value - The value to store
 * @returns {void}
 */
function defineValue(object: object, key: PropertyKey, value: unknown): void {
	if (key in object && !hasOwn(object, key)) defineOwn(object, key, value);
	else (object as Properties)[key] = value;
}

/**
 * Same effect as {@link defineOwn}, for objects CREATED BY THIS MODULE whose prototype is `Object.prototype` (or `null`): only a key
 * that `Object.prototype` has can be intercepted (by an inherited setter or read-only property), so every other key is simply
 * assigned. Cheaper than {@link defineValue}, which also has to look the key up on the object itself.
 * @param {object} object - The object to write to
 * @param {PropertyKey} key - The property key
 * @param {unknown} value - The value to store
 * @returns {void}
 */
function definePlain(object: object, key: PropertyKey, value: unknown): void {
	if (key in Object.prototype) defineOwn(object, key, value);
	else (object as Properties)[key] = value;
}

/**
 * Whether reading `key` from `object` must NOT resolve, which is the read rule shared by {@link getFromObjectByKeys},
 * {@link getProperty}, {@link hasInObjectByKeys} and {@link pick}: `__proto__`, `constructor` and `prototype` never resolve (not even
 * as own data keys), and neither does a key that is not own and comes from `Object.prototype` (`toString`, `hasOwnProperty`... and
 * anything a pollution added there). Own properties and properties inherited from any other prototype (class getters, `Array` and
 * `String` methods, `Object.create(proto)` parents) are readable; so are primitives' own properties (a string's `length` and indices).
 * @param {unknown} object - The (non-nullish) value the key is read from
 * @param {PropertyKey} key - The key
 * @returns {boolean} Whether the key must be treated as missing
 */
function isUnreadable(object: unknown, key: PropertyKey): boolean {
	// Only the few keys `Object.prototype` has (`__proto__` and `constructor` among them) need more work: one lookup for the usual
	// ones (the rest is kept out of line, so that this check stays small enough to be inlined into the readers).
	return key === 'prototype' || (key in Object.prototype && isObjectPrototypeKey(object, key));
}

/**
 * The slow part of {@link isUnreadable}, for a key that `Object.prototype` has: whether it is `__proto__` or `constructor`, or
 * comes from `Object.prototype` when read from `object` (no object of the chain before it has the key as an own property).
 * @param {unknown} object - The (non-nullish) value the key is read from
 * @param {PropertyKey} key - A key of `Object.prototype`
 * @returns {boolean} Whether the key must be treated as missing
 */
function isObjectPrototypeKey(object: unknown, key: PropertyKey): boolean {
	if (key === '__proto__' || key === 'constructor') return true;
	for (let current = object; current !== Object.prototype; current = Object.getPrototypeOf(current)) {
		if (current === null || hasOwn(current as object, key)) return false;
	}
	return true;
}

/**
 * Reads `key` from `object` following the rule of {@link isUnreadable}.
 * @param {unknown} object - The (non-nullish) value to read from
 * @param {PropertyKey} key - The key
 * @returns {unknown} The value, or `undefined` when the key is missing or unreadable
 */
function readKey(object: unknown, key: PropertyKey): unknown {
	const value = (object as Properties)[key];
	// A missing key reads as `undefined` anyway, so the rule only needs to be checked for the other values.
	return value === undefined || !isUnreadable(object, key) ? value : undefined;
}

/**
 * Returns `Object.prototype.toString` tag of a value.
 * @param {unknown} value - The value to inspect
 * @returns {string} The tag, e.g. `'[object Uint8Array]'`
 */
function getTag(value: unknown): string {
	return Object.prototype.toString.call(value);
}

/**
 * Gives `copy` the same prototype as `original` when they differ (keeps subclasses of built-ins and cross-realm prototypes).
 * @template T
 * @param {T} copy - The freshly created object
 * @param {object} original - The object it was copied from
 * @returns {T} `copy`
 */
function adoptPrototype<T extends object>(copy: T, original: object): T {
	return Object.setPrototypeOf(copy, Object.getPrototypeOf(original)) as T;
}

/**
 * The built-in `%TypedArray%.prototype[Symbol.toStringTag]` getter: a typed array's real constructor name, `undefined` otherwise.
 */
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get as () => unknown;

/**
 * The built-in `SharedArrayBuffer.prototype.byteLength` getter (absent where `SharedArrayBuffer` is unavailable); it throws for anything
 * that is not a real `SharedArrayBuffer`.
 */
const sharedByteLength: (() => unknown) | undefined =
	typeof SharedArrayBuffer === 'function' ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get : undefined;

/**
 * Copies an `ArrayBuffer`, a typed array or a `DataView` (the underlying bytes are duplicated).
 * @param {ArrayBuffer | ArrayBufferView} value - The buffer or view to copy
 * @returns {ArrayBuffer | ArrayBufferView} An independent copy with the same prototype
 */
function copyBinary(value: ArrayBuffer | ArrayBufferView): ArrayBuffer | ArrayBufferView {
	if (!ArrayBuffer.isView(value)) return adoptPrototype(value.slice(0), value);

	const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
	// The built-in tag getter reads the typed array's internal name, so a subclass overriding `Symbol.toStringTag` can't mislead it;
	// it returns `undefined` for a `DataView`.
	const name = (typedArrayTag.call(value) as string | undefined) ?? 'DataView';
	const View = (globalThis as unknown as Record<string, new (buffer: ArrayBufferLike) => ArrayBufferView>)[name];
	return adoptPrototype(new View(bytes), value);
}

/**
 * Whether a value is an `ArrayBuffer` (incl. `SharedArrayBuffer`) or an `ArrayBuffer` view.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is binary data
 */
function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
	if (ArrayBuffer.isView(value)) return true;
	// The tag is only a cheap pre-filter: anything can claim it, so the internal slot is checked too.
	const tag = getTag(value);
	if (tag === '[object ArrayBuffer]') return isArrayBuffer(value);
	if (tag !== '[object SharedArrayBuffer]') return false;
	try {
		return sharedByteLength?.call(value) !== undefined;
	} catch {
		return false;
	}
}

/**
 * Values that cannot be meaningfully copied and are therefore returned by reference by the clone functions.
 * @param {object} value - The value to check
 * @returns {boolean} Whether the value is a WeakMap, WeakSet or promise-like
 */
function isUncloneable(value: object): boolean {
	return isWeakMap(value) || isWeakSet(value) || isPromise(value);
}

/** `valueOf` implementations that brand-check boxed primitives (they throw for anything else). */
const BOXED_VALUE_OF: ReadonlyMap<string, (this: unknown) => unknown> = new Map<string, (this: unknown) => unknown>([
	['[object Number]', Number.prototype.valueOf],
	['[object String]', String.prototype.valueOf],
	['[object Boolean]', Boolean.prototype.valueOf],
	['[object BigInt]', BigInt.prototype.valueOf],
	['[object Symbol]', Symbol.prototype.valueOf]
]);

/**
 * Unwraps a boxed primitive (`new Number(1)`, `Object('a')`, `Object(1n)`, ...).
 * @param {object} value - The object to inspect
 * @returns {[boolean, unknown]} `[true, primitive]` for genuine boxed primitives, `[false, undefined]` otherwise
 */
function unbox(value: object): [boolean, unknown] {
	const valueOf = BOXED_VALUE_OF.get(getTag(value));
	if (valueOf === undefined) return [false, undefined];
	try {
		return [true, valueOf.call(value)];
	} catch {
		return [false, undefined];
	}
}

/**
 * Creates a fresh `RegExp` with the same source, flags and `lastIndex`.
 * @param {RegExp} value - The regexp to copy
 * @returns {RegExp} The copy
 */
function copyRegExp(value: RegExp): RegExp {
	const copy = new RegExp(value.source, value.flags);
	copy.lastIndex = value.lastIndex;
	return adoptPrototype(copy, value);
}

/**
 * Whether `value` is a plain object or a plain array that none of the special cases of the clone functions applies to: its
 * prototype is `Object.prototype` (or `Array.prototype`, for a genuine array), it is not a thenable, and its tag is the default one.
 * With such a prototype every `instanceof`-based brand check fails, and boxed primitives, errors and binary data can only be told
 * apart by their tag (or `ArrayBuffer.isView`), so these few checks are equivalent to the full list.
 * @param {object} value - The object to inspect
 * @param {unknown} prototype - Its prototype
 * @returns {boolean} Whether `value` can be copied as a plain object or array
 */
function isOrdinary(value: object, prototype: unknown): boolean {
	if (prototype === Object.prototype) return !isPromise(value) && getTag(value) === '[object Object]' && !ArrayBuffer.isView(value);
	return prototype === Array.prototype && Array.isArray(value) && !isPromise(value) && getTag(value) === '[object Array]';
}

/**
 * Whether an array has exactly the own enumerable keys `'0'` to `'length - 1'`: no holes, no extra string keys, no symbol keys.
 * Such an array can be copied index by index (`Object.keys` lists the present indices first, in ascending order, then the other keys).
 * @param {ReadonlyArray<unknown>} array - The array to inspect
 * @returns {boolean} Whether the array is dense and has no other own keys
 */
function isSimpleArray(array: ReadonlyArray<unknown>): boolean {
	const length = array.length;
	const keys = Object.keys(array);
	return keys.length === length && (length === 0 || keys[length - 1] === String(length - 1)) && Object.getOwnPropertySymbols(array).length === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shallow helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Shallowly merges one or more source objects into a NEW object, left to right (later keys win, like `{ ...target, ...a, ...b }`).
 * Inputs are never mutated. Own enumerable string and symbol keys are copied as own data properties (defined, never assigned): a
 * `'__proto__'` key becomes a plain own property (no prototype change), and `constructor`/`prototype` keys are copied like any other.
 * `null`/`undefined` sources are ignored.
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {T} target - The base object
 * @param {...S} sources - The objects whose properties override the base, in order
 * @returns {MergeAll<T, S>} A new object with the merged properties
 * @example
 * merge({ a: 1, b: 2 }, { b: 'x' }, { c: true }); // => { a: 1, b: 'x', c: true }
 */
export function merge<T extends object, S extends object[]>(target: T, ...sources: S): MergeAll<T, S> {
	// Object spread copies exactly the own enumerable string and symbol keys, defining them as own data properties (no setter
	// runs, so `'__proto__'` stays a plain key), skips `null`/`undefined`, and is much faster than a key-by-key copy.
	if (sources.length === 1) return { ...target, ...sources[0] } as MergeAll<T, S>;
	let result: object = { ...target };
	for (const source of sources) result = { ...result, ...source };
	return result as MergeAll<T, S>;
}

/**
 * Creates a shallow copy of a value.
 * - Primitives and functions are returned as-is.
 * - Arrays stay arrays (holes preserved); class instances keep their prototype and own enumerable (string and symbol) properties.
 * - `Date`, `RegExp` (incl. `lastIndex`), `Map`, `Set`, `ArrayBuffer`, typed arrays/`DataView` and boxed primitives get a new instance with the same contents.
 * - Errors keep `message`, `stack` and other own (even non-enumerable) properties.
 * - `WeakMap`, `WeakSet` and promises cannot be copied and are returned by reference.
 * - Keys are defined, never assigned: a `'__proto__'` key stays an own data property (no prototype change); `constructor` and
 *   `prototype` keys are copied like any other own data key.
 * @template T - The type of the value
 * @param {T} value - The value to copy
 * @returns {T} The shallow copy
 * @example
 * clone([1, 2]); // => [1, 2] // a new array
 * clone(new Map([['a', 1]])); // => new Map([['a', 1]]) // a new Map with the same entries
 */
export function clone<T>(value: T): T {
	// The most common cases (plain objects and dense arrays) are handled here, without the call to the generic worker.
	if (isObject(value) && isOrdinary(value, Object.getPrototypeOf(value))) {
		if (!Array.isArray(value)) return { ...value };
		// A dense array without extra keys is copied by `Array.from` (built-in fast path) with the same result as the generic copy.
		if (isSimpleArray(value)) return Array.from(value) as T;
	}
	return copyWith(value) as T;
}

/**
 * Determines whether an object has an OWN property with the given key (inherited properties such as `toString` do not count).
 * Acts as a type guard: on success `object` is narrowed to `T & Record<K, unknown>`.
 * @template T - The object type
 * @template K - The key type
 * @param {T} object - The object to check
 * @param {K} property - The property key to look for
 * @returns {boolean} Whether the object has that own property
 * @example
 * hasProperty({ a: 1 }, 'a'); // => true
 * hasProperty({}, 'toString'); // => false // inherited
 */
export function hasProperty<T extends object, K extends PropertyKey>(object: T, property: K): object is T & Record<K, unknown> {
	return hasOwn(object, property);
}

/**
 * Gets the value of a property of an object (own or inherited, e.g. a class getter, or a string's `length`).
 * For safety, `__proto__`, `constructor` and `prototype` never resolve (not even as own keys), and neither do members of
 * `Object.prototype` that the object does not have as own properties (`toString`, `hasOwnProperty`, keys added by prototype
 * pollution...): they all read as `undefined`, so a user-controlled key cannot reach the prototype, `Object` or `Function`.
 * @template T - The object type
 * @template K - The key type
 * @param {T} object - The object to read from
 * @param {K} property - The property key
 * @returns {T[K]} The property value (`undefined` for a missing or blocked key)
 * @throws {TypeError} when `object` is `null` or `undefined`
 * @example
 * getProperty({ a: 1 }, 'a'); // => 1
 * getProperty('abc', 'length'); // => 3
 * getProperty({} as { constructor?: unknown }, 'constructor'); // => undefined
 */
export function getProperty<T, K extends keyof T>(object: T, property: K): T[K] {
	return readKey(object, property) as T[K];
}

/**
 * Sets the value of a property of an object. MUTATES `object` (plain assignment, so setters run).
 * The key `'__proto__'` is refused: assigning it would replace the object's prototype (e.g. with one carrying `isAdmin: true`).
 * `constructor` and `prototype` are allowed: assigning them creates (or updates) a property of `object` itself.
 * @template T - The object type
 * @template K - The key type
 * @template V - The value type
 * @param {T} object - The object to modify
 * @param {K} property - The property key
 * @param {V} value - The value to assign
 * @returns {void}
 * @throws {RangeError} when `property` is `'__proto__'`
 * @example
 * const target = {};
 * setProperty(target, 'a', 1);
 * target; // => { a: 1 }
 * setProperty({}, '__proto__', { isAdmin: true }); // throws RangeError
 */
export function setProperty<T extends object, K extends PropertyKey, V>(object: T, property: K, value: V): void {
	if (property === '__proto__') throw new RangeError('setProperty: `property` must not be the unsafe key "__proto__"');
	(object as Record<K, V>)[property] = value;
}

/**
 * Deletes a property from an object. MUTATES `object`.
 * @template T - The object type
 * @template K - The key type
 * @param {T} object - The object to modify
 * @param {K} property - The property key to delete
 * @returns {void}
 * @example
 * const target = { a: 1, b: 2 };
 * deleteProperty(target, 'a');
 * target; // => { b: 2 }
 */
export function deleteProperty<T, K extends keyof T>(object: T, property: K): void {
	delete object[property];
}

/**
 * Gets the names of ALL own string-keyed properties of an object (`Object.getOwnPropertyNames`), including NON-enumerable ones
 * (e.g. arrays include `'length'`). Symbol keys and inherited properties are not included.
 * @template T - The object type
 * @param {T} object - The object to inspect
 * @returns {Array<keyof T>} The own property names
 * @example
 * getPropertyNames({ a: 1, b: 2 }); // => ['a', 'b']
 * getPropertyNames([1]); // => ['0', 'length']
 */
export function getPropertyNames<T>(object: T): Array<keyof T> {
	return Object.getOwnPropertyNames(object) as Array<keyof T>;
}

/**
 * Determines whether a value is empty:
 * - `null`/`undefined` → `true`;
 * - strings and arrays → `length === 0`;
 * - `Map`/`Set` → `size === 0`;
 * - other objects (and functions) → no own enumerable string or symbol keys;
 * - other primitives (numbers, booleans, bigints, symbols) → `true` (they have no keys).
 * @template T - The type of the value
 * @param {T} value - The value to check
 * @returns {boolean} Whether the value is empty
 * @example
 * isEmpty({}); // => true
 * isEmpty([]); // => true
 * isEmpty(new Map([[1, 1]])); // => false
 * isEmpty('a'); // => false
 */
export function isEmpty<T>(value: T): boolean {
	if (Array.isArray(value)) return value.length === 0;
	if (isMap(value) || isSet(value)) return value.size === 0;
	// `Object(...)` turns `null`/`undefined` into `{}` and other primitives into wrappers: only a non-empty string has (index) keys.
	const object: object = Object(value);
	// `for...in` lists the own enumerable string keys first, so the first own key found (if any) settles it without collecting all the keys.
	for (const key in object) if (hasOwn(object, key)) return false;
	for (const symbol of Object.getOwnPropertySymbols(object)) if (Object.prototype.propertyIsEnumerable.call(object, symbol)) return false;
	return true;
}

/**
 * Creates a new object with only the given keys. A key is copied when it exists on the object (own OR inherited, e.g. class getters);
 * missing keys are skipped. The input is not mutated. Keys are read with the rule of {@link getProperty}: `__proto__`, `constructor`,
 * `prototype` and `Object.prototype` members the object does not own (`toString`...) are skipped too.
 * @template T - The object type
 * @template K - The picked keys
 * @param {T} object - The source object
 * @param {ReadonlyArray<K>} keys - The keys to keep
 * @returns {Pick<T, K>} A new object with only those keys
 * @example
 * pick({ a: 1, b: 2, c: 3 }, ['a', 'c']); // => { a: 1, c: 3 }
 * pick({ a: 1 } as { a: number; constructor?: unknown }, ['a', 'constructor']); // => { a: 1 }
 */
export function pick<T extends object, K extends keyof T>(object: T, keys: ReadonlyArray<K>): Pick<T, K> {
	const result = {} as Pick<T, K>;
	for (const key of keys) {
		const value = object[key];
		// Only an `undefined` value can come from a missing key, so the `in` lookup is skipped for every other value.
		if ((value !== undefined || key in object) && !isUnreadable(object, key)) definePlain(result, key, value);
	}
	return result;
}

/**
 * Creates a new object with every own enumerable (string and symbol) property except the given keys. The input is not mutated.
 * Numeric keys match their string form (`omit({ 1: 'a' }, [1])` drops the key `'1'`).
 * @template T - The object type
 * @template K - The omitted keys
 * @param {T} object - The source object
 * @param {ReadonlyArray<K>} keys - The keys to drop
 * @returns {Omit<T, K>} A new object without those keys
 * @example
 * omit({ a: 1, b: 2, c: 3 }, ['b']); // => { a: 1, c: 3 }
 * omit({ 1: 'a', 2: 'b' }, [1]); // => { 2: 'b' }
 */
export function omit<T extends object, K extends keyof T>(object: T, keys: ReadonlyArray<K>): Omit<T, K> {
	// Property keys are strings or symbols at runtime: numeric keys (`omit(o, [1])`) must match the string key `'1'`.
	const excluded = new Set<PropertyKey>();
	for (const key of keys) excluded.add(typeof key === 'number' ? String(key) : key);
	const result = {} as Omit<T, K>;
	for (const key of ownEnumerableKeys(object)) {
		if (!excluded.has(key)) definePlain(result, key, (object as Properties)[key]);
	}
	return result;
}

/**
 * Creates a new object with the same own enumerable (string and symbol) keys, whose values are the results of `fn`.
 * An array input gives an array of the same length (holes stay holes; keys are passed to `fn` as strings, e.g. `'0'`), matching the return type.
 * @template T - The object type
 * @template R - The mapped value type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: keyof T, object: T) => R} fn - Maps each value (receives the value, its key and the object)
 * @returns {{ [K in keyof T]: R }} A new object with mapped values
 * @throws {TypeError} when `fn` is not a function
 * @example
 * mapValues({ a: 1, b: 2 }, function (n) { return n * 10; }); // => { a: 10, b: 20 }
 */
export function mapValues<T extends object, R>(object: T, fn: (value: T[keyof T], key: keyof T, object: T) => R): { [K in keyof T]: R } {
	assertFunction('mapValues', 'fn', fn);
	// For array types the mapped return type is an array type, so the runtime result must be an array too.
	const arrayInput = Array.isArray(object);
	const result = (arrayInput ? new Array<R>(object.length) : {}) as { [K in keyof T]: R };
	for (const key of ownEnumerableKeys(object)) {
		const value = fn((object as Properties)[key] as T[keyof T], key as keyof T, object);
		if (arrayInput) defineValue(result, key, value);
		else definePlain(result, key, value);
	}
	return result;
}

/**
 * Creates a new object with the same values, whose keys are the results of `fn`. When two keys map to the same new key, the last one wins.
 * @template T - The object type
 * @template K - The new key type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: keyof T, object: T) => K} fn - Computes the new key (receives the value, its key and the object)
 * @returns {Record<K, T[keyof T]>} A new object with mapped keys
 * @throws {TypeError} when `fn` is not a function
 * @example
 * mapKeys({ a: 1, b: 2 }, function (_v, k) { return String(k).toUpperCase(); }); // => { A: 1, B: 2 }
 */
export function mapKeys<T extends object, K extends PropertyKey>(object: T, fn: (value: T[keyof T], key: keyof T, object: T) => K): Record<K, T[keyof T]> {
	assertFunction('mapKeys', 'fn', fn);
	const result = {} as Record<K, T[keyof T]>;
	for (const key of ownEnumerableKeys(object)) {
		const value = (object as Properties)[key] as T[keyof T];
		definePlain(result, fn(value, key as keyof T, object), value);
	}
	return result;
}

/**
 * Creates a new object whose keys are the values of `object` and whose values are the (string) keys.
 * Only own enumerable string keys are considered. When several keys share a value, the last one wins.
 * @template T - The object type
 * @param {T} object - The object to invert
 * @returns {Invert<T>} The inverted object
 * @throws {TypeError} when a value is not a string, number or symbol
 * @example
 * invert({ a: 'x', b: 'y' }); // => { x: 'a', y: 'b' }
 */
export function invert<T extends Record<PropertyKey, PropertyKey>>(object: T): Invert<T> {
	const result = {} as Invert<T>;
	for (const key of Object.keys(object)) {
		const value: unknown = object[key];
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'symbol') {
			throw new TypeError(`invert: \`object.${key}\` must be a string, number or symbol, got ${describe(value)}`);
		}
		definePlain(result, value, key);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

/** Largest length a JavaScript array can have (array indices are integers in `[0, MAX_ARRAY_LENGTH)`). */
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

/** Canonical decimal form of a non-negative integer (no sign, no leading zeros). */
const CANONICAL_INDEX = /^(?:0|[1-9]\d*)$/;

/** Largest index for which the path setters create a missing container as an array (see {@link UnflattenOptions.arrayLimit}). */
const ARRAY_LIMIT = 1000;

/**
 * The number a path segment stands for when it is in canonical decimal form (`'0'`, `'12'`, but not `'01'`, `'-1'` or `'1.5'`).
 * @param {string} segment - The path segment
 * @returns {number} The index, or `-1` when the segment is not a canonical non-negative integer
 */
function parseIndex(segment: string): number {
	return CANONICAL_INDEX.test(segment) ? Number(segment) : -1;
}

/**
 * Splits a path on `separator` and validates its segments for writing.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} label - What the path is, used in error messages (e.g. ``'`path`'``)
 * @param {string} path - The path, e.g. `'a.b.0.c'`
 * @param {string} separator - The segment separator
 * @returns {string[]} The segments
 * @throws {RangeError} when a segment is empty (e.g. `''`, `'a..b'`, `'a.'`), or is `__proto__`, `constructor` or `prototype`
 */
function parseWritablePath(caller: string, label: string, path: string, separator: string): string[] {
	const segments = path.split(separator);
	for (const segment of segments) {
		if (segment === '' || UNSAFE_KEYS.has(segment)) {
			throw new RangeError(`${caller}: ${label} must not contain ${segment === '' ? 'empty segments' : `the unsafe segment "${segment}"`}, got ${JSON.stringify(path)}`);
		}
	}
	return segments;
}

/**
 * Writes `value` at the (already validated) `segments` inside `target`, creating missing containers. Shared by
 * {@link setInObjectByKeys} and {@link unflattenObject}.
 * Only OWN properties are traversed: an inherited value (e.g. `Object.prototype.toString`) is never written through; it is shadowed
 * by a new own container instead, so shared prototypes and built-ins cannot be modified.
 * @param {object} target - The object to modify
 * @param {ReadonlyArray<string>} segments - The validated path segments
 * @param {unknown} value - The value to store
 * @param {string} path - The original path, for error messages
 * @param {string} separator - The separator, for error messages
 * @param {string} caller - Name of the public function, for error messages
 * @param {number} arrayLimit - Largest index for which a missing container is created as an array (at most `MAX_ARRAY_LENGTH - 1`);
 * a larger canonical index creates a plain object instead
 * @param {WeakSet<object>} [owned] - Strict mode used by {@link unflattenObject}: the containers created so far. When given, every
 * created container is added to it, only those containers may be traversed, and an existing property is never overwritten
 * (any of these is a conflict between two keys). A created array about to receive an index above `arrayLimit` is replaced by a
 * plain object with the same entries
 * @returns {void}
 * @throws {TypeError} when an existing intermediate value is a primitive
 * @throws {TypeError} in strict mode, when the path conflicts with a previously written one
 */
function assignPath(
	target: object,
	segments: ReadonlyArray<string>,
	value: unknown,
	path: string,
	separator: string,
	caller: string,
	arrayLimit: number,
	owned?: WeakSet<object>
): void {
	let current = target as Record<string, unknown>;
	const last = segments.length - 1;
	// Whether `current` was created by this call: it then has no own property yet, so nothing needs to be looked up.
	let fresh = false;

	for (let index = 0; index < last; index++) {
		const segment = segments[index];
		const exists = !fresh && hasOwn(current, segment);
		let next = exists ? current[segment] : undefined;

		if (owned !== undefined && exists && !owned.has(next as object)) {
			throw new TypeError(`${caller}: cannot set "${path}": "${segments.slice(0, index + 1).join(separator)}" is already set by another key`);
		}
		if (next == null) {
			const nextIndex = parseIndex(segments[index + 1]);
			const container: object = nextIndex !== -1 && nextIndex <= arrayLimit ? [] : {};
			// A fresh container has no own keys, so only an inherited key can intercept a plain assignment.
			if (fresh && !(segment in current)) current[segment] = container;
			else defineOwn(current, segment, container);
			owned?.add(container);
			fresh = true;
			next = container;
		} else if (!isObject(next) && !isFunction(next)) {
			throw new TypeError(`${caller}: cannot set "${path}": "${segments.slice(0, index + 1).join(separator)}" is a ${typeof next}, not an object`);
		} else if (owned !== undefined && Number(segments[index + 1]) > arrayLimit && CANONICAL_INDEX.test(segments[index + 1]) && Array.isArray(next)) {
			// An array created by an earlier key would grow past the limit: it becomes a plain object (its keys are path segments,
			// never `__proto__`, so assigning them is safe), still owned. `current` owns `segment` as a data property: plain assignment.
			// (The numeric comparison comes first: it is cheap, and false for the usual segments, names and small indices.)
			next = Object.assign({}, next);
			owned.add(next as object);
			current[segment] = next;
		}

		current = next as Record<string, unknown>;
	}

	if (owned !== undefined && hasOwn(current, segments[last])) {
		throw new TypeError(`${caller}: cannot set "${path}": "${segments.join(separator)}" already holds values set by other keys`);
	}
	current[segments[last]] = value;
}

/**
 * Safely reads a nested value through a dot-separated path (array elements are addressed with numeric segments: `'list.0.id'`).
 * Never throws for missing intermediates: if any step is `null`/`undefined` the result is `undefined`.
 * When `defaultValue` is provided, it is returned whenever the resolved value is `undefined`.
 * Each segment reads own and inherited properties (class getters, a string's `length`...), EXCEPT that, so that a user-controlled path
 * cannot reach prototypes, `Object` or `Function` (e.g. a truthy `'viewer.constructor'` permission check), a `__proto__`,
 * `constructor` or `prototype` segment never resolves (not even as an own key), and neither does an `Object.prototype` member the
 * object does not own (`toString`, `hasOwnProperty`, keys added by prototype pollution...): the result is then `defaultValue`.
 * @template T - The object type
 * @template P - The path (inferred from the literal, checked against the object's shape)
 * @param {T} target - The object to read from
 * @param {P} keys - The dot-separated path
 * @returns {PathValue<T, P>} The value found at the path (or `undefined`)
 * @example
 * getFromObjectByKeys({ a: { b: [{ id: 1 }] } }, 'a.b.0.id'); // => 1
 * getFromObjectByKeys({ a: {} as { x?: { y: number } } }, 'a.x.y'); // => undefined
 * getFromObjectByKeys({ name: 'Ada' }, 'name.length'); // => 3
 * getFromObjectByKeys({ viewer: { read: true } } as Record<string, object>, 'viewer.constructor' as never, false); // => false
 */
export function getFromObjectByKeys<T extends object, P extends NestedKeyOf<T>>(target: T, keys: P): PathValue<T, P>;
/**
 * Safely reads a nested value through a dot-separated path, returning `defaultValue` when the resolved value is `undefined`.
 * @template T - The object type
 * @template P - The path (inferred from the literal, checked against the object's shape)
 * @template D - The default value type
 * @param {T} target - The object to read from
 * @param {P} keys - The dot-separated path
 * @param {D} defaultValue - The value returned when the path resolves to `undefined`
 * @returns {Exclude<PathValue<T, P>, undefined> | D} The value found at the path, or `defaultValue`
 * @example
 * getFromObjectByKeys({ a: {} as { x?: number } }, 'a.x', 0); // => 0
 */
export function getFromObjectByKeys<T extends object, P extends NestedKeyOf<T>, D>(target: T, keys: P, defaultValue: D): Exclude<PathValue<T, P>, undefined> | D;
/**
 * Implementation of {@link getFromObjectByKeys}.
 * @param {object} target - The object to read from
 * @param {string} keys - The dot-separated path
 * @param {unknown} [defaultValue] - The fallback value
 * @returns {unknown} The resolved value
 */
export function getFromObjectByKeys(target: object, keys: string, defaultValue?: unknown): unknown {
	let current: unknown = target;
	// A single segment (the most common path) is read directly, without splitting.
	if (keys.indexOf('.') === -1) current = current == null ? undefined : readKey(current, keys);
	else {
		for (const segment of keys.split('.')) {
			if (current == null) return defaultValue;
			current = readKey(current, segment);
		}
	}
	return current === undefined ? defaultValue : current;
}

/**
 * Sets a nested value through a dot-separated path. MUTATES `target` and returns it.
 * Missing (or `null`/`undefined`) intermediates are created: an array when the next segment is a canonical array index up to 1000
 * (`'list.0'`, `'list.12'`; not `'01'`), a plain object otherwise (so `'list.4294967294'` cannot create a 4-billion-element sparse
 * array). Writing any index into an EXISTING array is unchanged.
 * Only OWN properties are traversed: an inherited intermediate (such as `toString` from `Object.prototype`, or a getter defined on a class)
 * is shadowed by a new own container, so prototypes and built-ins are never modified. The final property is set by plain assignment.
 * @template T - The object type
 * @param {T} target - The object to modify
 * @param {string} path - The dot-separated path, e.g. `'a.b.0.c'`
 * @param {unknown} value - The value to store
 * @returns {T} `target`
 * @throws {RangeError} when the path has an empty segment (`''`, `'a..b'`, `'a.'`)
 * @throws {RangeError} when a segment is `__proto__`, `constructor` or `prototype` (prototype pollution guard)
 * @throws {TypeError} when an existing intermediate value is a primitive (it would have to be overwritten)
 * @example
 * setInObjectByKeys({}, 'a.list.0.id', 7); // => { a: { list: [{ id: 7 }] } }
 * setInObjectByKeys({}, 'a.5000', 1); // => { a: { 5000: 1 } }
 */
export function setInObjectByKeys<T extends object>(target: T, path: string, value: unknown): T {
	assignPath(target, parseWritablePath('setInObjectByKeys', '`path`', path, '.'), value, path, '.', 'setInObjectByKeys', ARRAY_LIMIT);
	return target;
}

// ---------------------------------------------------------------------------------------------------------------------
// Deep helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Worker of {@link clone} (`seen` is omitted: children are kept as they are) and of {@link deepClone} (children are copied too).
 * @param {unknown} value - The value to copy
 * @param {Map<object, unknown>} [seen] - For a deep copy: the already-copied objects (handles shared and circular references)
 * @returns {unknown} The copy
 */
function copyWith(value: unknown, seen?: Map<object, unknown>): unknown {
	if (!isObject(value)) return value;
	// Copies are objects, so `undefined` means "not copied yet".
	const known = seen?.get(value);
	if (known !== undefined) return known;

	// Fast paths for the usual plain objects and dense arrays (same result as the generic copy at the end).
	if (isOrdinary(value, Object.getPrototypeOf(value))) {
		if (!Array.isArray(value)) {
			// Spread defines the same own data properties as the generic copy; a deep copy then replaces each (own, writable) one by its
			// copy. (`clone` copies plain objects itself, with its own spread: a spread site fed with every nested shape goes megamorphic.)
			const copy: Properties = { ...value };
			seen?.set(value, copy);
			for (const key of ownEnumerableKeys(copy)) copy[key] = copyChild(copy[key], seen);
			return copy;
		}
		if (isSimpleArray(value)) {
			const copy = new Array<unknown>(value.length);
			seen?.set(value, copy);
			for (let i = 0; i < value.length; i++) copy[i] = copyChild(value[i], seen);
			return copy;
		}
	}

	if (isUncloneable(value)) return value;

	const [isBoxed, primitive] = unbox(value);
	if (isBoxed) return adoptPrototype(Object(primitive), value);
	if (isDate(value)) return adoptPrototype(new Date(value.getTime()), value);
	if (isRegExp(value)) return copyRegExp(value);
	if (isBinary(value)) return copyBinary(value);

	if (isMap(value)) {
		if (seen === undefined) return adoptPrototype(new Map(value), value);
		const copy = adoptPrototype(new Map<unknown, unknown>(), value);
		seen.set(value, copy);
		value.forEach(function (entryValue, entryKey) {
			copy.set(copyWith(entryKey, seen), copyWith(entryValue, seen));
		});
		return copy;
	}

	if (isSet(value)) {
		if (seen === undefined) return adoptPrototype(new Set(value), value);
		const copy = adoptPrototype(new Set<unknown>(), value);
		seen.set(value, copy);
		value.forEach(function (member) {
			copy.add(copyWith(member, seen));
		});
		return copy;
	}

	const error = isError(value);
	const copy: object = !error && Array.isArray(value) ? adoptPrototype(new Array(value.length), value) : Object.create(Object.getPrototypeOf(value));
	seen?.set(value, copy);
	// Errors keep all their own properties (`message` and `stack` are not enumerable), as they are defined (getters included).
	for (const key of error ? Reflect.ownKeys(value) : ownEnumerableKeys(value)) {
		if (error) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
			if ('value' in descriptor) descriptor.value = copyChild(descriptor.value, seen);
			Object.defineProperty(copy, key, descriptor);
		} else defineValue(copy, key, copyChild((value as Properties)[key], seen));
	}
	return copy;
}

/**
 * Copies a child of a value being copied by {@link copyWith}: deeply when `seen` is given, otherwise it is kept as it is.
 * @param {unknown} value - The child value
 * @param {Map<object, unknown>} [seen] - The objects already copied by a deep copy
 * @returns {unknown} The child to store in the copy
 */
function copyChild(value: unknown, seen?: Map<object, unknown>): unknown {
	return seen === undefined ? value : copyWith(value, seen);
}

/**
 * Creates a deep copy of a value without using `structuredClone`.
 * - Primitives are returned as-is; functions are copied BY REFERENCE.
 * - Arrays, plain objects and class instances are copied recursively (prototype preserved; own enumerable string AND symbol keys copied,
 *   getters are read and stored as data properties).
 * - `Date`, `RegExp` (incl. `lastIndex`), `Map` (keys and values cloned), `Set`, `ArrayBuffer`, typed arrays, `DataView` and boxed primitives get new instances.
 * - Errors keep their prototype and all own properties (`message`, `stack`, `cause`, ...).
 * - `WeakMap`, `WeakSet` and promises cannot be copied and are returned by reference.
 * - Shared and CIRCULAR references are preserved (the copy has the same reference graph).
 * - Extra own properties attached to built-ins (Date, Map, Set, RegExp, typed arrays) are not copied.
 * - Keys are defined, never assigned: a `'__proto__'` key stays an own data property (no prototype change); `constructor` and
 *   `prototype` keys are copied like any other own data key.
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`
 * (`Maximum call stack size exceeded`); validate the depth of untrusted input.
 * @template T - The type of the value
 * @param {T} value - The value to copy
 * @returns {T} An independent deep copy
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * const original = { a: [1, { b: 2 }], when: new Date(0) };
 * const copy = deepClone(original);
 * copy.a !== original.a; // => true
 * isEqual(copy, original); // => true
 */
export function deepClone<T>(value: T): T {
	return copyWith(value, new Map()) as T;
}

/**
 * Recursively merges the own enumerable keys of `source` into the (freshly created, owned) object `result`.
 * @param {object} result - The object being built (mutated)
 * @param {object} source - The plain object to merge in
 * @param {Set<object>} ancestors - Source objects currently being merged (cycle detection)
 * @returns {object} `result`
 * @throws {TypeError} when `source` contains a circular reference
 */
function deepMergeInto(result: object, source: object, ancestors: Set<object>): object {
	if (ancestors.has(source)) throw new TypeError('deepMerge: cannot merge objects with circular references');
	ancestors.add(source);

	for (const key of ownEnumerableKeys(source)) {
		if (UNSAFE_KEYS.has(key)) continue;
		const sourceValue = (source as Properties)[key];

		if (isPlainObject(sourceValue)) {
			// Only an OWN value of `result` (always a fresh object built here) is merged into: never an inherited one such as
			// `Object.prototype` through `__proto__`, or `Object` through `constructor`.
			const current = hasOwn(result, key) ? (result as Properties)[key] : undefined;
			const base = isPlainObject(current) ? current : Object.create(Object.getPrototypeOf(sourceValue));
			definePlain(result, key, deepMergeInto(base, sourceValue, ancestors));
		} else {
			definePlain(result, key, sourceValue);
		}
	}

	ancestors.delete(source);
	return result;
}

/**
 * Deeply merges plain objects into a NEW object, left to right (later sources win). Inputs are never mutated.
 * - Only PLAIN objects are merged recursively (every merged plain object in the result is a fresh object).
 * - Arrays, dates, maps, class instances and all other values REPLACE the previous value and are assigned by reference.
 * - A key present in a source always wins, even when its value is `undefined`.
 * - Keys `__proto__`, `constructor` and `prototype` are DROPPED at every level: deepMerge is the classic sink for untrusted
 *   input (user settings over defaults), so the result never carries a key that a later `Object.assign`, `for...in` copy or
 *   path lookup could turn into a prototype change. (Faithful copies that keep such keys as own data: {@link clone},
 *   {@link deepClone}, {@link merge}.) Only own values of the fresh result objects are ever merged into.
 * - `null`/`undefined` sources are skipped.
 * - Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`
 *   (`Maximum call stack size exceeded`); validate the depth of untrusted input.
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {T} target - The base plain object
 * @param {...S} sources - Plain objects merged over the base, in order
 * @returns {DeepMergeAll<T, S>} A new, deeply merged object
 * @throws {TypeError} when the target or a source is not a plain object
 * @throws {TypeError} when an input contains a circular reference through plain objects
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] }); // => { a: { x: 1, y: 3 }, list: [9] }
 * deepMerge({ theme: 'light' }, JSON.parse('{"__proto__": {"isAdmin": true}, "constructor": 1}')); // => { theme: 'light' }
 */
export function deepMerge<T extends object, S extends object[]>(target: T, ...sources: S): DeepMergeAll<T, S> {
	if (!isPlainObject(target)) throw new TypeError(`deepMerge: \`target\` must be a plain object, got ${describe(target)}`);

	const ancestors = new Set<object>();
	const result = deepMergeInto(Object.create(Object.getPrototypeOf(target)), target, ancestors);

	sources.forEach(function (source, index) {
		if (source == null) return;
		if (!isPlainObject(source)) throw new TypeError(`deepMerge: \`sources[${index}]\` must be a plain object, got ${describe(source)}`);
		deepMergeInto(result, source, ancestors);
	});

	return result as DeepMergeAll<T, S>;
}

/**
 * SameValueZero comparison (like `===` but `NaN` equals `NaN`).
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @returns {boolean} Whether the values are SameValueZero-equal
 */
function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (a !== a && b !== b);
}

/**
 * Pairs of objects currently being compared by {@link isEqual} (used to detect cycles).
 */
type ComparisonStack = Array<[object, object]>;

/**
 * Compares two `Map`s: same size and every entry of `a` matches a distinct entry of `b` (keys and values deeply equal).
 * Primitive keys are looked up directly (O(1)); only object keys need the O(n²) pairwise matching.
 * @param {Map<unknown, unknown>} a - First map
 * @param {Map<unknown, unknown>} b - Second map
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether the maps are deeply equal
 */
function mapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>, stack: ComparisonStack): boolean {
	if (a.size !== b.size) return false;
	const objectEntriesB = Array.from(b).filter(function ([key]) {
		return isObject(key);
	});
	const matched: boolean[] = [];

	for (const [keyA, valueA] of a) {
		if (!isObject(keyA)) {
			if (!b.has(keyA) || !equalWith(valueA, b.get(keyA), stack)) return false;
			continue;
		}
		const index = objectEntriesB.findIndex(function ([keyB, valueB], candidate) {
			return !matched[candidate] && equalWith(keyA, keyB, stack) && equalWith(valueA, valueB, stack);
		});
		if (index === -1) return false;
		matched[index] = true;
	}
	return true;
}

/**
 * Compares two `Set`s: same size and every member of `a` matches a distinct, deeply equal member of `b`.
 * Primitive members are looked up directly (O(1)); only object members need the O(n²) pairwise matching.
 * @param {Set<unknown>} a - First set
 * @param {Set<unknown>} b - Second set
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether the sets are deeply equal
 */
function setsEqual(a: Set<unknown>, b: Set<unknown>, stack: ComparisonStack): boolean {
	if (a.size !== b.size) return false;
	const objectMembersB = Array.from(b).filter(isObject);
	const matched: boolean[] = [];

	for (const memberA of a) {
		if (!isObject(memberA)) {
			if (!b.has(memberA)) return false;
			continue;
		}
		const index = objectMembersB.findIndex(function (memberB, candidate) {
			return !matched[candidate] && equalWith(memberA, memberB, stack);
		});
		if (index === -1) return false;
		matched[index] = true;
	}
	return true;
}

/**
 * Compares the bytes of two buffers / the elements of two typed arrays.
 * @param {ArrayBuffer | ArrayBufferView} a - First buffer or view
 * @param {ArrayBuffer | ArrayBufferView} b - Second buffer or view (same tag as `a`)
 * @returns {boolean} Whether the contents are equal
 */
function binaryEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean {
	let left = a as unknown as ArrayLike<unknown>;
	let right = b as unknown as ArrayLike<unknown>;
	if (!ArrayBuffer.isView(a)) {
		left = new Uint8Array(a);
		right = new Uint8Array(b as ArrayBuffer);
	} else if (getTag(a) === '[object DataView]') {
		const view = b as ArrayBufferView;
		left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
		right = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	return (
		left.length === right.length &&
		Array.prototype.every.call(left, function (value: unknown, index: number): boolean {
			return sameValueZero(value, right[index]);
		})
	);
}

/**
 * Compares the own enumerable (string and symbol) properties of two objects.
 * @param {object} a - First object
 * @param {object} b - Second object
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether both have the same keys with deeply equal values
 */
function propertiesEqual(a: object, b: object, stack: ComparisonStack): boolean {
	const keysA = ownEnumerableKeys(a);
	const keysB = ownEnumerableKeys(b);
	if (keysA.length !== keysB.length) return false;

	for (const key of keysA) {
		if (!Object.prototype.propertyIsEnumerable.call(b, key)) return false;
		if (!equalWith((a as Properties)[key], (b as Properties)[key], stack)) return false;
	}
	return true;
}

/**
 * Compares two objects of the same prototype and tag according to their kind.
 * @param {object} a - First object
 * @param {object} b - Second object
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether they are deeply equal
 */
function objectsEqual(a: object, b: object, stack: ComparisonStack): boolean {
	if (isOrdinary(a, Object.getPrototypeOf(a))) return (!Array.isArray(a) || a.length === (b as unknown[]).length) && propertiesEqual(a, b, stack);
	if (isUncloneable(a)) return false;
	if (isDate(a)) return sameValueZero(a.getTime(), (b as Date).getTime());
	if (isRegExp(a)) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;
	if (isMap(a)) return mapsEqual(a, b as Map<unknown, unknown>, stack);
	if (isSet(a)) return setsEqual(a, b as Set<unknown>, stack);
	if (isBinary(a)) return binaryEqual(a, b as ArrayBuffer | ArrayBufferView);
	const [isBoxedA, primitiveA] = unbox(a);
	if (isBoxedA) {
		const [isBoxedB, primitiveB] = unbox(b);
		if (!isBoxedB || !sameValueZero(primitiveA, primitiveB)) return false;
	}
	if (isError(a) && (a.name !== (b as Error).name || a.message !== (b as Error).message)) return false;
	if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
	return propertiesEqual(a, b, stack);
}

/**
 * Recursive worker of {@link isEqual}.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @param {ComparisonStack} stack - Pairs currently being compared (cycle detection)
 * @returns {boolean} Whether the values are deeply equal
 */
function equalWith(a: unknown, b: unknown, stack: ComparisonStack): boolean {
	if (sameValueZero(a, b)) return true;
	if (!isObject(a) || !isObject(b)) return false;
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

	if (getTag(a) !== getTag(b)) return false;

	for (const [left, right] of stack) {
		if (left === a && right === b) return true;
	}

	stack.push([a, b]);
	const result = objectsEqual(a, b, stack);
	stack.pop();
	return result;
}

/**
 * Deep structural equality.
 * - Primitives use SameValueZero: `NaN` equals `NaN` and `+0` equals `-0`. Functions are compared by reference.
 * - Objects must have the SAME prototype (so `{}` and `Object.create(null)`, or two different classes, are never equal) and the same kind.
 * - Arrays and objects: same own enumerable string AND symbol keys with deeply equal values (holes are not equal to `undefined`).
 * - `Date`: same time value (two invalid dates are equal). `RegExp`: same `source` and `flags` (`lastIndex` ignored).
 * - `Map`/`Set`: same size and a one-to-one matching of deeply equal entries/members. Primitive keys/members are matched in O(1);
 *   object keys/members are matched pairwise, which is O(n²) in the worst case.
 * - Typed arrays (element-wise), `DataView`/`ArrayBuffer` (byte-wise), boxed primitives (by value), errors (`name` + `message` + own enumerable props).
 * - `WeakMap`, `WeakSet` and promises are only equal to themselves.
 * - Circular structures are supported (pairs already under comparison are assumed equal).
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`
 * (`Maximum call stack size exceeded`); validate the depth of untrusted input.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @returns {boolean} Whether the values are deeply equal
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * isEqual({ a: [1, { b: NaN }] }, { a: [1, { b: NaN }] }); // => true
 * isEqual(new Set([1, 2]), new Set([2, 1])); // => true
 * isEqual([1], { 0: 1 }); // => false
 */
export function isEqual(a: unknown, b: unknown): boolean {
	return equalWith(a, b, []);
}

/**
 * Recursively freezes an object and every object reachable through its own (string and symbol) data properties,
 * as well as `Map` keys/values and `Set` members. Circular references are handled.
 * Functions and prototypes are NOT frozen; getters are not invoked. Typed arrays/`DataView`s cannot be frozen and are skipped,
 * and `Map`/`Set` instances are frozen as objects but their contents remain mutable at runtime (the type is read-only).
 * MUTATES (freezes) the input and returns it.
 * @template T - The type of the value
 * @param {T} object - The value to freeze
 * @returns {DeepReadonly<T>} The same value, typed as deeply read-only
 * @example
 * const config = deepFreeze({ server: { port: 80 } });
 * Object.isFrozen(config.server); // => true
 */
export function deepFreeze<T>(object: T): DeepReadonly<T> {
	const visited = new WeakSet<object>();
	const pending: unknown[] = [object];

	while (pending.length > 0) {
		const value = pending.pop();
		if (!isObject(value) || visited.has(value) || ArrayBuffer.isView(value)) continue;
		visited.add(value);

		if (isMap(value)) {
			value.forEach(function (entryValue, entryKey) {
				pending.push(entryKey, entryValue);
			});
		} else if (isSet(value)) {
			value.forEach(function (member) {
				pending.push(member);
			});
		}

		for (const key of Reflect.ownKeys(value)) {
			// Accessor descriptors have no `value` (getters are not invoked): pushing `undefined` is harmless.
			pending.push((Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor).value);
		}

		Object.freeze(value);
	}

	return object as DeepReadonly<T>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Typed key/entry wrappers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The own enumerable STRING keys `Object.keys` can return for `T`: symbol keys are excluded and numeric keys become strings.
 * @example
 * type K = StringKeyOf<{ a: 1; 2: 'x'; [s]: true }>; // 'a' | '2'
 */
export type StringKeyOf<T> = `${Exclude<keyof T, symbol>}`;

/**
 * The `[key, value]` pairs `Object.entries` can return for `T` (string keys only).
 * @example
 * type E = EntryOf<{ a: number; b?: string }>; // ['a', number] | ['b', string | undefined]
 */
export type EntryOf<T> = { [K in Exclude<keyof T, symbol>]: [`${K}`, T[K]] }[Exclude<keyof T, symbol>];

/**
 * The object type built by {@link typedFromEntries} from a union of `[key, value]` entry types.
 * @example
 * type O = FromEntries<['a', number] | ['b', string]>; // { a: number; b: string }
 */
export type FromEntries<E extends readonly [PropertyKey, unknown]> = Simplify<{ [Entry in E as Entry[0]]: Entry[1] }>;

/**
 * `Object.keys` with a precise return type: the OWN ENUMERABLE STRING keys of an object (symbol keys and inherited keys are excluded,
 * numeric keys are returned as strings). TypeScript object types are open (a value may carry more keys than its type declares),
 * so the type is only exact for objects that have no keys beyond their type.
 * @template T - The object type
 * @param {T} object - The object to inspect
 * @returns {Array<StringKeyOf<T>>} The own enumerable string keys, in `Object.keys` order
 * @example
 * typedKeys({ a: 1, b: 2 }); // => ['a', 'b'] // typed as ('a' | 'b')[]
 */
export function typedKeys<T extends object>(object: T): Array<StringKeyOf<T>> {
	return Object.keys(object) as Array<StringKeyOf<T>>;
}

/**
 * `Object.entries` with a precise return type: `[key, value]` pairs for the OWN ENUMERABLE STRING keys of an object
 * (symbol keys and inherited keys are excluded). Like {@link typedKeys}, the type assumes no keys beyond the declared ones.
 * @template T - The object type
 * @param {T} object - The object to inspect
 * @returns {Array<EntryOf<T>>} The entries, in `Object.keys` order
 * @example
 * typedEntries({ a: 1, b: 'x' }); // => [['a', 1], ['b', 'x']] // typed as (['a', number] | ['b', string])[]
 */
export function typedEntries<T extends object>(object: T): Array<EntryOf<T>> {
	return Object.entries(object) as Array<EntryOf<T>>;
}

/**
 * `Object.fromEntries` with a precise return type: builds a new object from `[key, value]` pairs (later duplicates win).
 * A `'__proto__'` key becomes a plain own property (no prototype change). The type assumes every key of the entry type occurs,
 * which holds for round-trips such as `typedFromEntries(typedEntries(object))`.
 * @template E - The entry type
 * @param {Iterable<E>} entries - The `[key, value]` pairs
 * @returns {FromEntries<E>} A new object
 * @example
 * typedFromEntries([['a', 1], ['b', 'x']] as Array<['a', number] | ['b', string]>); // => { a: 1, b: 'x' } // typed as { a: number; b: string }
 */
export function typedFromEntries<E extends readonly [PropertyKey, unknown]>(entries: Iterable<E>): FromEntries<E> {
	const result = {};
	for (const [key, value] of entries) definePlain(result, key, value);
	return result as FromEntries<E>;
}

/**
 * Creates a new object with the own enumerable (string and symbol) properties for which `predicate` returns true. The input is not mutated.
 * @template T - The object type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: keyof T, object: T) => boolean} predicate - Decides whether a property is kept
 * @returns {Partial<T>} A new object with the selected properties
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * pickBy({ a: 1, b: null, c: 3 }, function (value) { return value !== null; }); // => { a: 1, c: 3 }
 */
export function pickBy<T extends object>(object: T, predicate: (value: T[keyof T], key: keyof T, object: T) => boolean): Partial<T> {
	assertFunction('pickBy', 'predicate', predicate);
	const result: Partial<T> = {};
	for (const key of ownEnumerableKeys(object)) {
		const value = (object as Properties)[key] as T[keyof T];
		if (predicate(value, key as keyof T, object)) definePlain(result, key, value);
	}
	return result;
}

/**
 * Creates a new object without the own enumerable (string and symbol) properties for which `predicate` returns true
 * (the complement of {@link pickBy}). The input is not mutated.
 * @template T - The object type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: keyof T, object: T) => boolean} predicate - Decides whether a property is dropped
 * @returns {Partial<T>} A new object with the remaining properties
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * omitBy({ a: 1, _b: 2 }, function (_value, key) { return String(key).startsWith('_'); }); // => { a: 1 }
 */
export function omitBy<T extends object>(object: T, predicate: (value: T[keyof T], key: keyof T, object: T) => boolean): Partial<T> {
	assertFunction('omitBy', 'predicate', predicate);
	return pickBy(object, function (value, key, source) {
		return !predicate(value, key, source);
	});
}

/**
 * The type produced by {@link compactObject}: keys that may hold `undefined` become optional and lose `undefined` from their type.
 * @example
 * type C = CompactObject<{ a: number; b: string | undefined; c?: boolean }>; // { a: number; b?: string; c?: boolean }
 */
export type CompactObject<T> = Simplify<
	{ [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> }
>;

/**
 * Creates a SHALLOW copy of an object without the own properties whose value is `undefined`. Only `undefined` is removed:
 * `null`, `0`, `''`, `false` and `NaN` are kept. Own enumerable string and symbol keys are considered. The input is not mutated.
 * @template T - The object type
 * @param {T} object - The source object
 * @returns {CompactObject<T>} A new object without `undefined` values
 * @example
 * compactObject({ a: 1, b: undefined, c: null }); // => { a: 1, c: null }
 */
export function compactObject<T extends object>(object: T): CompactObject<T> {
	return pickBy(object, function (value) {
		return value !== undefined;
	}) as CompactObject<T>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options of {@link flattenObject} and {@link unflattenObject}.
 */
export interface FlattenOptions {
	/** The string joining path segments (non-empty). Defaults to `'.'`. */
	separator?: string;
}

/**
 * Options of {@link unflattenObject}.
 */
export interface UnflattenOptions extends FlattenOptions {
	/**
	 * Largest array index for which a missing container is created as an array (an integer `>= 0`, or `Infinity`). Defaults to `1000`.
	 * A key with a larger index creates (or turns the array built so far into) a plain object instead, so that a short key such as
	 * `'tags.4294967294'` cannot build a 4-billion-element sparse array.
	 */
	arrayLimit?: number;
}

/**
 * Validates and returns the separator of {@link FlattenOptions}.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {FlattenOptions} options - The options
 * @returns {string} The separator
 * @throws {TypeError} when the separator is not a string
 * @throws {RangeError} when the separator is empty
 */
function readSeparator(caller: string, options: FlattenOptions): string {
	const separator = options.separator ?? '.';
	if (typeof separator !== 'string') throw new TypeError(`${caller}: \`separator\` must be a string, got ${describe(separator)}`);
	if (separator === '') throw new RangeError(`${caller}: \`separator\` must not be empty`);
	return separator;
}

/**
 * Whether a value is a container that the path helpers recurse into: an array or a plain object.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an array or a plain object
 */
function isContainer(value: unknown): value is object {
	return Array.isArray(value) || isPlainObject(value);
}

/**
 * Recursive worker of {@link flattenObject}.
 * @param {object} source - The container being flattened
 * @param {ReadonlyArray<string>} keys - Its own enumerable string keys (`Object.keys(source)`)
 * @param {string} prefix - The path of `source` followed by the separator (empty at the root)
 * @param {string} separator - The segment separator
 * @param {Record<string, unknown>} result - The flat record being built (mutated)
 * @param {object[]} ancestors - Containers on the current path (cycle detection)
 * @returns {void}
 * @throws {TypeError} when `source` contains a circular reference
 */
function flattenInto(source: object, keys: ReadonlyArray<string>, prefix: string, separator: string, result: Record<string, unknown>, ancestors: object[]): void {
	// A list rather than a Set: it only holds the current path, which is short and cheaper to scan than to hash into (the
	// recursion, bounded by the call stack, keeps the worst case of the scans small).
	if (ancestors.includes(source)) throw new TypeError('flattenObject: cannot flatten a circular structure');
	ancestors.push(source);
	for (const key of keys) {
		const value = (source as Properties)[key];
		const path = prefix + key;
		const nested = isContainer(value) ? Object.keys(value) : undefined;
		if (nested !== undefined && nested.length > 0) flattenInto(value as object, nested, path + separator, separator, result, ancestors);
		else definePlain(result, path, value);
	}
	ancestors.pop();
}

/**
 * Flattens nested plain objects and arrays into a single-level record mapping each LEAF path to its value.
 * - Paths join own enumerable string keys with `separator`; array elements use numeric segments (`'list.0.id'`). Symbol keys and holes are skipped.
 * - Leaves are every value that is not a plain object or array (dates, maps, class instances... are leaves, stored by reference),
 *   plus EMPTY plain objects and arrays (so they survive {@link unflattenObject}).
 * - The result is a fresh object whose keys are defined, never assigned: a `'__proto__'` key (or path) is stored as a plain own
 *   property, and `constructor`/`prototype` keys are flattened like any other own data key ({@link unflattenObject} rejects them).
 *
 * Round-trip caveats (`unflattenObject(flattenObject(x))` equals `x` only when none apply): keys containing the separator or empty keys,
 * numeric-looking keys of plain objects (they come back as arrays), sparse arrays, unsafe keys (`__proto__`...), a root array
 * (it comes back as an object), null-prototype objects (they come back with `Object.prototype`).
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`
 * (`Maximum call stack size exceeded`); validate the depth of untrusted input.
 * @param {object} object - The plain object (or array) to flatten
 * @param {FlattenOptions} [options={}] - `separator` (default `'.'`)
 * @returns {Record<string, unknown>} A new flat record of leaf paths
 * @throws {TypeError} when `object` is not a plain object or an array, or contains a circular reference
 * @throws {TypeError} when `separator` is not a string
 * @throws {RangeError} when `separator` is empty
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * flattenObject({ a: { b: 1, c: [2, { d: 3 }] }, e: {} }); // => { 'a.b': 1, 'a.c.0': 2, 'a.c.1.d': 3, e: {} }
 * flattenObject({ a: { b: 1 } }, { separator: '/' }); // => { 'a/b': 1 }
 */
export function flattenObject(object: object, options: FlattenOptions = {}): Record<string, unknown> {
	const separator = readSeparator('flattenObject', options);
	if (!isContainer(object)) throw new TypeError(`flattenObject: \`object\` must be a plain object or an array, got ${describe(object)}`);
	const result: Record<string, unknown> = {};
	flattenInto(object, Object.keys(object), '', separator, result, []);
	return result;
}

/**
 * Rebuilds a nested object from a flat record of paths (the inverse of {@link flattenObject}). Keys are processed in `Object.keys` order;
 * each one is split on `separator` and its value written like {@link setInObjectByKeys} does: a missing container is created as an array
 * when the next segment is a canonical array index (`'0'`, `'12'`) no larger than `arrayLimit` (default 1000), as a plain object
 * otherwise; an array built by earlier keys becomes a plain object (same entries) as soon as a key gives it an index above the limit.
 * So input such as a parsed query string `tags.4294967294=x` cannot build a 4-billion-element sparse array. The root is always a plain object.
 * The nesting depth of the result is the number of segments of the longest key: a key with thousands of segments builds an object
 * that the recursive helpers ({@link deepClone}, {@link isEqual}, `JSON.stringify`...) cannot process, so bound the key length (or
 * segment count) of untrusted input.
 * Keys that CONFLICT (one is a prefix path of another, such as `'a'` and `'a.b'`) throw a `TypeError` whatever their order, so values
 * are never written into a leaf value of the input: the input is not mutated (leaf values are reused by reference).
 * @param {Readonly<Record<string, unknown>>} record - The flat record
 * @param {UnflattenOptions} [options={}] - `separator` (default `'.'`) and `arrayLimit` (default `1000`)
 * @returns {Record<string, unknown>} A new nested object
 * @throws {RangeError} when a segment is `__proto__`, `constructor` or `prototype` (prototype pollution guard)
 * @throws {RangeError} when a key has an empty segment (`''`, `'a..b'`)
 * @throws {TypeError} when two keys conflict (`{ a: 1, 'a.b': 2 }`)
 * @throws {TypeError} when `separator` is not a string
 * @throws {RangeError} when `separator` is empty
 * @throws {TypeError} when `arrayLimit` is not a number
 * @throws {RangeError} when `arrayLimit` is not an integer `>= 0` or `Infinity`
 * @example
 * unflattenObject({ 'a.b': 1, 'a.c.0': 2, 'a.c.1.d': 3 }); // => { a: { b: 1, c: [2, { d: 3 }] } }
 * unflattenObject({ 'a/b': 1 }, { separator: '/' }); // => { a: { b: 1 } }
 * unflattenObject({ 'tags.0': 'a', 'tags.4294967294': 'b' }); // => { tags: { 0: 'a', 4294967294: 'b' } }
 * unflattenObject({ 'a.0': 1, 'a.1': 2 }, { arrayLimit: 0 }); // => { a: { 0: 1, 1: 2 } }
 */
export function unflattenObject(record: Readonly<Record<string, unknown>>, options: UnflattenOptions = {}): Record<string, unknown> {
	const separator = readSeparator('unflattenObject', options);
	const arrayLimit = options.arrayLimit ?? ARRAY_LIMIT;
	assertInteger('unflattenObject', 'arrayLimit', arrayLimit, 0, true);
	// Larger canonical integers are not array indices: they never create arrays.
	const limit = Math.min(arrayLimit, MAX_ARRAY_LENGTH - 1);
	const result: Record<string, unknown> = {};
	const owned = new WeakSet<object>();
	for (const key of Object.keys(record)) {
		assignPath(result, parseWritablePath('unflattenObject', '`record` keys', key, separator), record[key], key, separator, 'unflattenObject', limit, owned);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Path queries
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Checks whether a dot-separated path exists in an object: it is `true` exactly when {@link getFromObjectByKeys} resolves the path
 * to a property (whose value may be `undefined`) rather than falling back to the default value. Segments follow the same rule: own
 * and inherited properties count (class getters, a string's `length` and indices, `Object.create(proto)` parents), but a
 * `__proto__`, `constructor` or `prototype` segment never does, nor does an `Object.prototype` member the object does not own
 * (`toString`, keys added by prototype pollution...). Array elements are addressed with numeric segments (`'list.0'`).
 * @param {object} target - The object to inspect
 * @param {string} path - The dot-separated path, e.g. `'a.b.0'`
 * @returns {boolean} Whether every segment of the path resolves
 * @example
 * hasInObjectByKeys({ a: { b: [undefined] } }, 'a.b.0'); // => true
 * hasInObjectByKeys({ a: {} }, 'a.toString'); // => false // an Object.prototype member
 * hasInObjectByKeys({ a: {} }, 'a.constructor'); // => false
 * hasInObjectByKeys({ name: 'Ada' }, 'name.length'); // => true
 */
export function hasInObjectByKeys(target: object, path: string): boolean {
	const segments = path.split('.');
	const last = segments.length - 1;
	let current: unknown = target;
	for (let index = 0; index < last && current != null; index++) current = readKey(current, segments[index]);
	if (current == null) return false;
	const key = segments[last];
	// `in` needs an object: a primitive is boxed (its own properties, such as a string's indices, are then visible).
	return key in Object(current) && !isUnreadable(current, key);
}

/**
 * Deletes the property at a dot-separated path. MUTATES `target`. Only OWN properties are followed and deleted
 * (an inherited property is never removed from a prototype). Deleting an array element leaves a hole (the length is unchanged).
 * Like {@link setInObjectByKeys}, the path may not contain `__proto__`, `constructor` or `prototype` segments, so it cannot remove
 * a method shared by every instance of a class (`'Service.prototype.run'`).
 * @param {object} target - The object to modify
 * @param {string} path - The dot-separated path, e.g. `'a.b.0'`
 * @returns {boolean} `true` when an own property was found and deleted; `false` when the path does not exist or the property is non-configurable
 * @throws {RangeError} when the path has an empty segment (`''`, `'a..b'`, `'a.'`)
 * @throws {RangeError} when a segment is `__proto__`, `constructor` or `prototype`
 * @example
 * const config = { a: { b: 1, c: 2 } };
 * deleteFromObjectByKeys(config, 'a.b'); // => true
 * config; // => { a: { c: 2 } }
 * deleteFromObjectByKeys(config, 'a.x'); // => false
 * deleteFromObjectByKeys({ C: class {} }, 'C.prototype.m'); // throws RangeError
 */
export function deleteFromObjectByKeys(target: object, path: string): boolean {
	const segments = parseWritablePath('deleteFromObjectByKeys', '`path`', path, '.');
	const last = segments.length - 1;
	let current: unknown = target;
	for (let index = 0; index < last; index++) {
		if (!(isObject(current) || isFunction(current)) || !hasOwn(current, segments[index])) return false;
		current = (current as Properties)[segments[index]];
	}
	const key = segments[last];
	return (isObject(current) || isFunction(current)) && hasOwn(current, key) && Reflect.deleteProperty(current, key);
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Result of {@link diff}: dot-separated paths. `removed` and `changed` follow the depth-first key order of `a`, `added` that of `b`.
 */
export interface ObjectDiff {
	/** Paths present in `b` but not in `a`. */
	added: string[];
	/** Paths present in `a` but not in `b`. */
	removed: string[];
	/** Paths present in both whose values differ (and are not both plain objects / both arrays). */
	changed: string[];
}

/**
 * Recursive worker of {@link diff}: walks `a` depth-first and records the paths missing from `b` and, optionally, the changed leaves.
 * @param {object} a - The container being walked
 * @param {object} b - The container it is compared with (same kind as `a`)
 * @param {string} prefix - The path of the containers followed by `'.'` (empty at the root)
 * @param {string[]} missing - Receives the paths of `a` that `b` lacks (mutated)
 * @param {string[] | undefined} changed - Receives the paths of differing leaves (mutated); `undefined` to skip leaf comparisons
 * @param {Set<object>} ancestors - Containers of `a`'s tree on the current path (cycle detection: only `a`'s tree is checked, as the
 * walk stops where `b` ends and {@link diff} walks each tree in turn)
 * @returns {void}
 * @throws {TypeError} when a tree contains a circular reference
 */
function diffWalk(a: object, b: object, prefix: string, missing: string[], changed: string[] | undefined, ancestors: Set<object>): void {
	if (ancestors.has(a)) throw new TypeError('diff: cannot diff circular structures');
	ancestors.add(a);

	for (const key of Object.keys(a)) {
		const path = prefix + key;
		if (!Object.prototype.propertyIsEnumerable.call(b, key)) {
			missing.push(path);
			continue;
		}
		const left = (a as Properties)[key];
		const right = (b as Properties)[key];
		if (left === right) continue;
		if ((Array.isArray(left) && Array.isArray(right)) || (isPlainObject(left) && isPlainObject(right))) {
			diffWalk(left, right, path + '.', missing, changed, ancestors);
		} else if (changed !== undefined && !isEqual(left, right)) {
			changed.push(path);
		}
	}

	ancestors.delete(a);
}

/**
 * Computes the structural differences between two trees of plain objects and arrays, as dot-separated paths
 * (array elements use numeric segments: `'list.0'`).
 * - Recurses wherever BOTH sides are plain objects, or BOTH are arrays (array elements are compared by index; holes count as missing).
 * - Other values (incl. a plain object versus an array) are leaves compared with {@link isEqual}.
 * - Only own enumerable string keys are considered; prototypes of plain objects are not compared.
 * - Identical references (including `a === b`) are equal by definition and are not walked.
 * - `removed` and `changed` are listed in the depth-first key order of `a`, `added` in that of `b`, so `diff(a, b).added`
 *   is exactly `diff(b, a).removed`. Keys containing `'.'` make paths ambiguous.
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`
 * (`Maximum call stack size exceeded`); validate the depth of untrusted input.
 * @param {object} a - The old tree (a plain object or an array)
 * @param {object} b - The new tree (the same kind as `a`)
 * @returns {ObjectDiff} The `added`, `removed` and `changed` paths
 * @throws {TypeError} when `a` and `b` are not both plain objects or both arrays
 * @throws {TypeError} when a tree contains a circular reference
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * diff({ a: 1, b: { c: 2, d: [1] } }, { b: { c: 3, d: [1, 2] }, e: 0 }); // => { added: ['b.d.1', 'e'], removed: ['a'], changed: ['b.c'] }
 */
export function diff(a: object, b: object): ObjectDiff {
	if (!((Array.isArray(a) && Array.isArray(b)) || (isPlainObject(a) && isPlainObject(b)))) {
		throw new TypeError('diff: `a` and `b` must both be plain objects or both be arrays');
	}
	const result: ObjectDiff = { added: [], removed: [], changed: [] };
	diffWalk(a, b, '', result.removed, result.changed, new Set());
	diffWalk(b, a, '', result.added, undefined, new Set());
	return result;
}
