import {
	type JsonValue,
	isDate,
	isArrayBuffer,
	isError,
	isFunction,
	isMap,
	isObject,
	isPlainObject,
	isPromise,
	isRegExp,
	isSet,
	isWeakMap,
	isWeakSet
} from '../guards/index.js';
import { toCamelCase, toKebabCase, toSnakeCase } from '../strings/index.js';
import { assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';
import type { AnyFunction, DeepReadonly, NestedKeyOf, PathValue, Primitive, UnionToIntersection } from '../utils/index.js';
import { MAX_JSON_DEPTH, toJsonValue, type JsonWalk } from '../utils/json.js';

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
 * The item type of an array type (`never` for other types).
 */
type ItemOf<T> = T extends ReadonlyArray<infer U> ? U : never;

/**
 * The array type built when two arrays are combined (`'concat'`/`'union'`): when `C` is `true` and both `A` and `B` are arrays, an
 * array of the items of both; `Otherwise` otherwise.
 */
type CombinedArray<A, B, C extends boolean, Otherwise> = C extends true
	? [A] extends [ReadonlyArray<unknown>]
		? [B] extends [ReadonlyArray<unknown>]
			? Array<ItemOf<A> | ItemOf<B>>
			: Otherwise
		: Otherwise
	: Otherwise;

/**
 * Result of merging the value `B` over the value `A` in {@link DeepMerge} (`C`: whether two arrays are combined).
 */
type DeepMergeValue<A, B, C extends boolean> = IsMergeable<A> extends true ? (IsMergeable<B> extends true ? DeepMerge<A, B, C> : B) : CombinedArray<A, B, C, B>;

/**
 * The type produced by {@link deepMerge}: like {@link Merge}, but keys holding objects on both sides are merged recursively.
 * `C` (default `false`) is `true` when two arrays at the same key are combined ({@link deepMergeWith} with `'concat'` or `'union'`).
 * An optional key of a source is assumed absent when it is not set, as with `exactOptionalPropertyTypes`: the type keeps the earlier
 * value (or merges into it), while at runtime a key present with the value `undefined` wins.
 * @example
 * type M = DeepMerge<{ a: { x: number; y: string } }, { a: { x: boolean } }>; // { a: { x: boolean; y: string } }
 */
export type DeepMerge<A, B, C extends boolean = false> = Simplify<
	{ [K in keyof A as K extends keyof B ? never : K]: A[K] } & {
		[K in keyof B as K extends keyof A ? (K extends OptionalKeysOf<B> ? never : K) : K]: K extends keyof A ? DeepMergeValue<A[K], B[K], C> : B[K];
	} & { [K in keyof A as K extends OptionalKeysOf<B> ? K : never]: A[K] | DeepMergeValue<A[K], Exclude<B[K & keyof B], undefined>, C> }
>;

/**
 * Left-to-right {@link DeepMerge} of a target with a tuple of sources (later sources win).
 */
export type DeepMergeAll<T, S extends readonly unknown[], C extends boolean = false> = S extends readonly [infer Head, ...infer Tail]
	? DeepMergeAll<DeepMerge<T, Head, C>, Tail, C>
	: S extends readonly []
		? T
		: DeepMerge<T, Partial<UnionToIntersection<S[number]>>, C>;

/**
 * The value of a key present in both `A` (the value so far, which wins) and `B` (a default) in {@link Defaults}: `A`, plus `B` when
 * `A` may be `undefined`; for the deep variant (`D`), plain objects on both sides are filled recursively.
 */
type DefaultValue<A, B, D extends boolean, C extends boolean> = D extends true
	? IsMergeable<A> extends true
		? IsMergeable<B> extends true
			? Defaults<A, B, D, C>
			: A
		: undefined extends A
			? Exclude<A, undefined> | B
			: CombinedArray<A, B, C, A>
	: undefined extends A
		? Exclude<A, undefined> | B
		: CombinedArray<A, B, C, A>;

/**
 * The type produced by {@link defaults} (and, with `D = true`, {@link defaultsDeep}): the keys of `T` keep their type unless it may be
 * `undefined`, in which case the type of the default is added; keys only in `S` are added. `C` (default `false`) is `true` when two
 * arrays at the same key are combined. (With `missing: 'nullish'`, `null` stays in the type although it is replaced too.)
 * @example
 * type D = Defaults<{ a: number; b?: string }, { b: string; c: boolean }>; // { a: number; b: string; c: boolean }
 */
export type Defaults<T, S, D extends boolean = false, C extends boolean = false> = Simplify<
	{ [K in keyof T as K extends keyof S ? never : K]: T[K] } & { [K in keyof S as K extends keyof T ? never : K]: S[K] } & {
		[K in keyof T & keyof S as K extends OptionalKeysOf<T> ? (K extends OptionalKeysOf<S> ? never : K) : K]: DefaultValue<T[K], S[K], D, C>;
	} & { [K in keyof T & keyof S as K extends OptionalKeysOf<T> ? (K extends OptionalKeysOf<S> ? K : never) : never]?: DefaultValue<T[K], S[K], D, C> }
>;

/**
 * Left-to-right {@link Defaults} of a target with a tuple of sources (earlier values win).
 */
export type DefaultsAll<T, S extends readonly unknown[], D extends boolean = false, C extends boolean = false> = S extends readonly [infer Head, ...infer Tail]
	? DefaultsAll<Defaults<T, Head, D, C>, Tail, D, C>
	: S extends readonly []
		? T
		: Defaults<T, Partial<UnionToIntersection<S[number]>>, D, C>;

/**
 * Any object, seen as a record of properties (for reading and writing arbitrary keys).
 */
type Properties = Record<PropertyKey, unknown>;

/**
 * The type produced by {@link invert}: values become keys and keys become (string) values.
 * @example
 * type I = Invert<{ a: 'x'; b: 'y' }>; // { x: 'a'; y: 'b' }
 */
export type Invert<T> = { -readonly [K in keyof T as K extends symbol ? never : T[K] & PropertyKey]: K extends number ? `${K}` : K };

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
	return appendSymbols(object, Object.keys(object));
}

/**
 * Appends the own enumerable symbol keys of an object to a list of keys.
 * @param {object} object - The object to inspect
 * @param {PropertyKey[]} keys - The list to extend (mutated)
 * @returns {PropertyKey[]} `keys`
 */
function appendSymbols(object: object, keys: PropertyKey[]): PropertyKey[] {
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

/** Above this length, arrays are walked through their own keys: a sparse array of length `2 ** 32 - 1` may hold only a few items. */
const SPARSE_SCAN = 65536;

/**
 * The indexes of the own elements of an array, in order: what `forEach` visits, but never read through a (polluted) prototype, and
 * without walking every hole of a huge sparse array.
 * @param {ArrayLike<unknown>} array - The array
 * @returns {number[]} The indexes of its own elements
 */
function presentIndexes(array: ArrayLike<unknown>): number[] {
	const indexes: number[] = [];
	if (array.length <= SPARSE_SCAN) {
		for (let index = 0; index < array.length; index++) if (hasOwn(array, index)) indexes.push(index);
		return indexes;
	}
	// Own integer keys are listed first, in ascending order.
	for (const key of Object.keys(array)) {
		const index = Number(key);
		if (!(String(index) === key && index < array.length)) break;
		indexes.push(index);
	}
	return indexes;
}

/** The longest prototype chain the read rule walks: a `Proxy` can report itself as its own prototype, forever. */
const MAX_PROTOTYPE_DEPTH = 10_000;

/**
 * Whether `value` is the `Object.prototype` of another realm (an iframe, a `vm` context): an object without a prototype that owns the
 * `__proto__` accessor.
 * @param {unknown} value - A prototype chain member
 * @returns {boolean} `true` for a foreign `Object.prototype`
 */
function isForeignObjectPrototype(value: unknown): boolean {
	return (
		typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null && typeof Object.getOwnPropertyDescriptor(value, '__proto__')?.get === 'function'
	);
}

/**
 * Whether reading `key` from `object` must NOT resolve, which is the read rule shared by {@link getPath},
 * {@link getProperty}, {@link hasPath} and {@link pick}: `__proto__`, `constructor` and `prototype` never resolve (not even
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
	for (let current = object, depth = 0; current !== null; current = Object.getPrototypeOf(current), depth++) {
		// An `Object.prototype` (of this realm or another one) holds the key; an endless chain (a lying `Proxy`) counts as unreadable.
		if (current === Object.prototype || depth > MAX_PROTOTYPE_DEPTH || isForeignObjectPrototype(current)) return true;
		if (hasOwn(current as object, key)) return false;
	}
	return false;
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
 * A genuine error object (with the internal slot that `Object.prototype.toString` and `Error.isError` check) with the prototype of
 * `original` and no own properties yet, to copy the properties of `original` onto.
 * @param {object} original - The error being copied
 * @returns {object} The empty copy
 */
function errorShell(original: object): object {
	const shell = adoptPrototype(new Error(), original) as unknown as Properties;
	for (const key of Reflect.ownKeys(shell)) delete shell[key];
	return shell;
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
	if (!ArrayBuffer.isView(value)) {
		const { resizable, growable, maxByteLength } = value as ArrayBuffer & { resizable?: boolean; growable?: boolean; maxByteLength?: number };
		// `slice` returns a fixed-length buffer: a resizable (or growable shared) one is rebuilt with its maximum length.
		if (!resizable && !growable) return adoptPrototype(value.slice(0), value);
		const Buffer = (growable ? SharedArrayBuffer : ArrayBuffer) as unknown as new (length: number, options: { maxByteLength?: number }) => ArrayBuffer;
		const copy = new Buffer(value.byteLength, { maxByteLength });
		new Uint8Array(copy).set(new Uint8Array(value));
		return adoptPrototype(copy, value);
	}

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
 * prototype is `Object.prototype` or `null` (or `Array.prototype`, for a genuine array), it is not a thenable, and its tag is the
 * default one. With such a prototype every `instanceof`-based brand check fails, and boxed primitives, errors, dates, regular
 * expressions and binary data can only be told apart by their tag (or `ArrayBuffer.isView`), so these few checks are equivalent to the
 * full list. With a `null` prototype the guards' brand checks would run, each throwing (microseconds per object), to find at most a
 * `Map`, `Set`, `WeakMap`, `WeakSet` or buffer whose prototype was set to `null`: one that lost every method of its kind, treated as
 * the record it now looks like.
 * @param {object} value - The object to inspect
 * @param {unknown} prototype - Its prototype
 * @returns {boolean} Whether `value` can be copied as a plain object or array
 */
function isOrdinary(value: object, prototype: unknown): boolean {
	if (prototype === Object.prototype || prototype === null) return !isPromise(value) && getTag(value) === '[object Object]' && !ArrayBuffer.isView(value);
	return prototype === Array.prototype && Array.isArray(value) && !isPromise(value) && getTag(value) === '[object Array]';
}

/**
 * Whether an object is a record for the collection checks of {@link isEmpty} and {@link deepFreeze}: it has no prototype (a collection
 * that lost its prototype lost its methods too), or the `Object.prototype` of another realm. Only these objects (and the other objects
 * of other realms) fail `instanceof Object`, the cheap test that spares every other object the lookups; for them, the brand checks of
 * `isMap` and `isSet` throw, which costs microseconds.
 * @param {object} value - The object to inspect
 * @returns {boolean} Whether `value` is such a record
 */
function isBareRecord(value: object): boolean {
	if (value instanceof Object) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || isForeignObjectPrototype(prototype);
}

/**
 * Whether an object that {@link isOrdinary} rejects still has no internal state besides its members, so that the clone and equality
 * functions can skip the brand checks of the other built-ins: an array (of another realm, of a subclass, or with holes or extra keys), or
 * an object of another realm (an iframe, a `vm` context, such as the parsed body of a `fetch` response under Jest) whose prototype is
 * that realm's `Object.prototype` and whose tag is the default one. Thenables excluded. For an object of another realm, each brand check
 * of the guards fails by throwing, which costs microseconds.
 * @param {object} value - The object to inspect
 * @param {unknown} prototype - Its prototype
 * @returns {boolean} Whether `value` holds nothing but its members
 */
function holdsOnlyMembers(value: object, prototype: unknown): boolean {
	return (Array.isArray(value) || (isForeignObjectPrototype(prototype) && getTag(value) === '[object Object]' && !ArrayBuffer.isView(value))) && !isPromise(value);
}

/**
 * Shallow copy of an object without a prototype: a new one with the same own enumerable (string and symbol) properties. Assignments to
 * it define own data properties (there is no inherited setter to call, for `__proto__` neither), and are more than twice as fast as
 * `Object.assign` onto it.
 * @param {object} value - The object to copy
 * @returns {Properties} The copy, without a prototype
 */
function copyBare(value: object): Properties {
	const copy: Properties = Object.create(null);
	for (const key of ownEnumerableKeys(value)) copy[key] = (value as Properties)[key];
	return copy;
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
 * - `WeakMap`, `WeakSet` and promises (any object with a `then` method) cannot be copied and are returned by reference.
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
	if (isObject(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (isOrdinary(value, prototype)) {
			if (prototype === null) return copyBare(value) as T;
			if (!Array.isArray(value)) return { ...value };
			// A dense array without extra keys is copied by `Array.from` (built-in fast path) with the same result as the generic copy.
			if (isSimpleArray(value)) return Array.from(value) as T;
		}
	}
	return copyWith(value) as T;
}

/**
 * Determines whether an object has an OWN property with the given key (inherited properties such as `toString` do not count).
 * Acts as a type guard for keys `T` does not declare: on success `object` is narrowed to `T & Record<K, unknown>`. A key `T` declares
 * narrows nothing (it may be inherited, so the `false` branch must keep `T`).
 * @template T - The object type
 * @template K - The key type
 * @param {T} object - The object to check
 * @param {K} property - The property key to look for
 * @returns {boolean} Whether the object has that own property
 * @example
 * hasProperty({ a: 1 }, 'a'); // => true
 * hasProperty({}, 'toString'); // => false // inherited
 */
export function hasProperty<T extends object, K extends keyof T>(object: T, property: K): boolean;
/**
 * Checks whether `object` has `property` as an OWN property (see the first overload), narrowing `object` to have it.
 * @template T - The object type
 * @template K - The property key type
 * @param {T} object - The object to inspect
 * @param {K} property - The property key
 * @returns {boolean} Whether the property is an own property
 */
export function hasProperty<T extends object, K extends PropertyKey>(object: T, property: K): object is T & Record<K, unknown>;
/**
 * Implementation of {@link hasProperty}.
 * @param {object} object - The object to inspect
 * @param {PropertyKey} property - The property key
 * @returns {boolean} Whether the property is an own property
 */
export function hasProperty(object: object, property: PropertyKey): boolean {
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
	// Of the primitives, only a non-empty string has (index) keys: answered without boxing it and enumerating its indices.
	if (typeof value === 'string') return value.length === 0;
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (!isBareRecord(value) && (isMap(value) || isSet(value))) return value.size === 0;
	// `for...in` lists the own enumerable string keys first, so the first own key found (if any) settles it without collecting all the keys.
	for (const key in value) if (hasOwn(value, key)) return false;
	for (const symbol of Object.getOwnPropertySymbols(value)) if (Object.prototype.propertyIsEnumerable.call(value, symbol)) return false;
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
		if (value === undefined && !(key in object)) continue;
		// `isUnreadable` and `definePlain` inlined, to look the key up on `Object.prototype` once for both.
		const shared = key in Object.prototype;
		if (key === 'prototype' || (shared && isObjectPrototypeKey(object, key))) continue;
		if (shared) defineOwn(result, key, value);
		else result[key] = value;
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
		const newKey: unknown = fn(value, key as keyof T, object);
		// Like `mapEntries`: a key that is not one (an object, `undefined`) is an error, not silently `'[object Object]'`.
		if (typeof newKey !== 'string' && typeof newKey !== 'number' && typeof newKey !== 'symbol') {
			throw new TypeError(`mapKeys: \`fn\` must return a string, number or symbol, got ${describe(newKey)} for ${String(key)}`);
		}
		definePlain(result, newKey, value);
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
 * {@link setPath} and {@link unflattenObject}.
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
		} else if (owned !== undefined && Array.isArray(next) && (Number(segments[index + 1]) > arrayLimit || !CANONICAL_INDEX.test(segments[index + 1]))) {
			// An array created by an earlier key would grow past the limit, or get a key that is not an index (`length`, which arrays own,
			// or a name): it becomes a plain object (its keys are path segments, never `__proto__`, so assigning them is safe), still
			// owned. `current` owns `segment` as a data property: plain assignment.
			next = Object.assign({}, next);
			owned.add(next as object);
			current[segment] = next;
		}

		current = next as Record<string, unknown>;
	}

	if (owned !== undefined && hasOwn(current, segments[last])) {
		throw new TypeError(`${caller}: cannot set "${path}": "${segments.join(separator)}" already holds values set by other keys`);
	}
	// A container created here (every container of `unflattenObject`) gets an own data property even for an inherited key: an
	// inherited setter would take the value, and a frozen `Object.prototype` (`toString`) would make the assignment throw.
	if (fresh || owned !== undefined) definePlain(current, segments[last], value);
	else current[segments[last]] = value;
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
 * getPath({ a: { b: [{ id: 1 }] } }, 'a.b.0.id'); // => 1
 * getPath({ a: {} as { x?: { y: number } } }, 'a.x.y'); // => undefined
 * getPath({ name: 'Ada' }, 'name.length' as never); // => 3 // inherited properties resolve, beyond the paths the types offer
 * getPath({ viewer: { read: true } } as Record<string, object>, 'viewer.constructor' as never, false); // => false
 */
export function getPath<T extends object, P extends NestedKeyOf<T>>(target: T, keys: P): PathValue<T, P>;
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
 * getPath({ a: {} as { x?: number } }, 'a.x', 0); // => 0
 */
export function getPath<T extends object, P extends NestedKeyOf<T>, D>(target: T, keys: P, defaultValue: D): Exclude<PathValue<T, P>, undefined> | D;
/**
 * Implementation of {@link getPath}.
 * @param {object} target - The object to read from
 * @param {string} keys - The dot-separated path
 * @param {unknown} [defaultValue] - The fallback value
 * @returns {unknown} The resolved value
 */
export function getPath(target: object, keys: string, defaultValue?: unknown): unknown {
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
 * setPath({}, 'a.list.0.id', 7); // => { a: { list: [{ id: 7 }] } }
 * setPath({}, 'a.5000', 1); // => { a: { 5000: 1 } }
 */
export function setPath<T extends object>(target: T, path: string, value: unknown): T {
	assignPath(target, parseWritablePath('setPath', '`path`', path, '.'), value, path, '.', 'setPath', ARRAY_LIMIT);
	return target;
}

/**
 * The value type at `P` in `T` when `P` is one of the known paths of `T` ({@link NestedKeyOf}), `unknown` for any other path (and
 * for a path whose type is only `undefined`, such as a path through an `unknown` value).
 */
export type PathUpdateValue<T, P extends string> = [P] extends [NestedKeyOf<T>] ? ([PathValue<T, P>] extends [undefined] ? unknown : PathValue<T, P>) : unknown;

/**
 * The type produced by {@link omitPath}: `T` without the property at the dot-separated path `P` (an array element becomes a
 * hole, so the item type gains `undefined`; a nested path makes the items of an array `Item | ItemWithoutIt`).
 * @example
 * type O = OmitAtPath<{ a: { b: number; c: string } }, 'a.b'>; // { a: { c: string } }
 */
export type OmitAtPath<T, P extends string> =
	T extends ReadonlyArray<infer Item>
		? P extends `${number}.${infer Rest}`
			? Array<Item | OmitAtPath<Item, Rest>>
			: P extends `${number}`
				? Array<Item | undefined>
				: T
		: T extends object
			? P extends `${infer Head}.${infer Rest}`
				? Simplify<{ [K in keyof T]: K extends string | number ? (`${K}` extends Head ? OmitAtPath<T[K], Rest> : T[K]) : T[K] }>
				: Simplify<{ [K in keyof T as K extends string | number ? (`${K}` extends P ? never : K) : K]: T[K] }>
			: T;

/**
 * Shallow copy of a container (a plain object or an array), keeping its prototype: the same result as {@link clone}, without its
 * checks for the other kinds of objects.
 * @param {object} container - The plain object or array
 * @returns {object} The copy
 */
function copyContainer(container: object): object {
	if (Array.isArray(container)) return clone(container);
	return Object.getPrototypeOf(container) === null ? copyBare(container) : { ...container };
}

/**
 * Copies a container (plain object or array) on the path of {@link updatePath}/{@link omitPath} with `key` set to
 * `value` (or deleted, when `remove` is set).
 * @param {object} container - The plain object or array to copy
 * @param {string} key - The key to change
 * @param {unknown} value - The new value
 * @param {boolean} remove - Whether the key is deleted instead (an array element becomes a hole)
 * @returns {object} The copy (same prototype)
 */
function withKey(container: object, key: string, value: unknown, remove: boolean): object {
	const copy = copyContainer(container);
	if (remove) Reflect.deleteProperty(copy, key);
	else defineValue(copy, key, value);
	return copy;
}

/**
 * Recursive worker of {@link updatePath} and {@link omitPath}: rebuilds the containers on the path, sharing
 * everything else, and returns `node` itself when nothing changes.
 * @param {string} caller - Name of the public function, for error messages
 * @param {string} path - The original path, for error messages
 * @param {object} node - The container at `segments[index]`'s level (a plain object or an array)
 * @param {ReadonlyArray<string>} segments - The validated path segments
 * @param {number} index - The current segment
 * @param {((current: unknown) => unknown) | undefined} update - Computes the new value from the current one; `undefined` to delete
 * @returns {object} The new container, or `node` when unchanged
 * @throws {TypeError} when an intermediate value cannot be traversed
 */
function rewritePath(caller: string, path: string, node: object, segments: ReadonlyArray<string>, index: number, update: ((current: unknown) => unknown) | undefined): object {
	const key = segments[index];
	// Only OWN properties are followed: an inherited value is shadowed by a new own container, never written through.
	const exists = hasOwn(node, key);
	const current = exists ? (node as Properties)[key] : undefined;

	if (index === segments.length - 1) {
		if (update === undefined) return exists ? withKey(node, key, undefined, true) : node;
		const value = update(current);
		return exists && Object.is(value, current) ? node : withKey(node, key, value, false);
	}

	let child: object;
	if (isContainer(current)) child = current;
	else if (current == null || (update === undefined && !isObject(current) && !isFunction(current))) {
		// Nothing to delete below a missing or primitive value; a missing container is created for an update (see `setPath`).
		if (update === undefined) return node;
		const nextIndex = parseIndex(segments[index + 1]);
		child = nextIndex !== -1 && nextIndex <= ARRAY_LIMIT ? [] : {};
	} else {
		const kind = isObject(current) || isFunction(current) ? 'an object that is neither a plain object nor an array' : `a ${typeof current}`;
		throw new TypeError(`${caller}: cannot update "${path}": "${segments.slice(0, index + 1).join('.')}" is ${kind}`);
	}

	const next = rewritePath(caller, path, child, segments, index + 1, update);
	return next === current ? node : withKey(node, key, next, false);
}

/**
 * Validates the arguments of {@link updatePath}/{@link omitPath} and runs {@link rewritePath}.
 * @param {string} caller - Name of the public function
 * @param {unknown} target - The root
 * @param {string} path - The dot-separated path
 * @param {((current: unknown) => unknown) | undefined} update - The update, or `undefined` to delete
 * @returns {object} The new root, or `target` when unchanged
 * @throws {TypeError} when `target` is not a plain object or an array
 * @throws {RangeError} when the path has an empty or unsafe segment
 */
function rewriteRoot(caller: string, target: unknown, path: string, update: ((current: unknown) => unknown) | undefined): object {
	assertContainer(caller, 'target', target);
	return rewritePath(caller, path, target, parseWritablePath(caller, '`path`', path, '.'), 0, update);
}

/**
 * IMMUTABLE counterpart of {@link setPath}: returns a NEW root in which the value at the dot-separated path is replaced by
 * `valueOrUpdater` (or, when it is a function, by `valueOrUpdater(currentValue)`). Inputs are never mutated: only the plain objects and
 * arrays ON THE PATH are copied (keeping their prototype, arrays stay arrays); everything else is shared with the input (structural
 * sharing). When the new value is `Object.is`-equal to the current own value, `target` itself is returned (handy for memoized UIs).
 * - Same path rules as {@link setPath}: `__proto__`, `constructor`, `prototype` and empty segments are rejected; only own
 *   properties are followed; a missing (or `null`/`undefined`) intermediate is created as an array when the next segment is a canonical
 *   index up to 1000, as a plain object otherwise.
 * - Containers that cannot be copied faithfully (class instances, maps, dates...) are not traversed: a `TypeError` is thrown.
 * - To store a function, wrap it: `updatePath(o, 'onClick', function () { return handler; })`.
 * @template T - The object type
 * @template P - The path
 * @param {T} target - The root (a plain object or an array)
 * @param {P} path - The dot-separated path, e.g. `'a.list.0.done'`
 * @param {PathUpdateValue<T, P> | ((current: PathUpdateValue<T, P>) => PathUpdateValue<T, P>)} valueOrUpdater - The new value, or a function computing it from the current one
 * @returns {T} The new root (or `target` when nothing changes)
 * @throws {TypeError} when `target` is not a plain object or an array
 * @throws {RangeError} when the path has an empty segment, or a `__proto__`, `constructor` or `prototype` segment, or so many segments
 *   (thousands) that the copy, which recurses once per segment, overflows the stack
 * @throws {TypeError} when an intermediate value is a primitive or an object that is neither a plain object nor an array
 * @example
 * const state = { user: { name: 'Ada', visits: 1 }, todos: [{ done: false }] };
 * const next = updatePath(state, 'user.visits', function (n) { return n + 1; });
 * next; // => { user: { name: 'Ada', visits: 2 }, todos: [{ done: false }] }
 * state.user.visits; // => 1
 * next.todos === state.todos; // => true
 * updatePath(state, 'user.name', 'Ada') === state; // => true
 * updatePath({}, 'a.list.0', 'x' as never); // => { a: { list: ['x'] } }
 */
export function updatePath<T extends object, P extends string>(
	target: T,
	path: P,
	valueOrUpdater: PathUpdateValue<T, P> | ((current: PathUpdateValue<T, P>) => PathUpdateValue<T, P>)
): T {
	const update =
		typeof valueOrUpdater === 'function'
			? (valueOrUpdater as (current: unknown) => unknown)
			: function (): unknown {
					return valueOrUpdater;
				};
	return rewriteRoot('updatePath', target, path, update) as T;
}

/**
 * IMMUTABLE counterpart of {@link deletePath}: returns a NEW root without the own property at the dot-separated path,
 * copying only the plain objects and arrays on the path (structural sharing). Deleting an array element leaves a hole (the length is
 * unchanged), like {@link deletePath}. When the path does not exist, `target` itself is returned. Same path rules as
 * {@link updatePath}.
 * @template T - The object type
 * @template P - The path
 * @param {T} target - The root (a plain object or an array)
 * @param {P} path - The dot-separated path, e.g. `'a.b'`
 * @returns {OmitAtPath<T, P>} The new root (or `target` when the path does not exist)
 * @throws {TypeError} when `target` is not a plain object or an array
 * @throws {RangeError} when the path has an empty segment, or a `__proto__`, `constructor` or `prototype` segment, or so many segments
 *   (thousands) that the copy, which recurses once per segment, overflows the stack
 * @throws {TypeError} when an intermediate object on the path is neither a plain object nor an array
 * @example
 * const config = { a: { b: 1, c: 2 }, d: { e: 3 } };
 * const next = omitPath(config, 'a.b');
 * next; // => { a: { c: 2 }, d: { e: 3 } }
 * next.d === config.d; // => true
 * omitPath(config, 'a.x' as never) === config; // => true
 */
export function omitPath<T extends object, P extends string>(target: T, path: P): OmitAtPath<T, P> {
	return rewriteRoot('omitPath', target, path, undefined) as OmitAtPath<T, P>;
}

/**
 * Throws the `RangeError` of {@link toPath}.
 * @param {string} path - The parsed path
 * @param {number} index - Where the problem is
 * @param {string} problem - What is wrong
 * @returns {never} Never returns
 * @throws {RangeError} always
 */
function invalidPath(path: string, index: number, problem: string): never {
	throw new RangeError(`toPath: \`path\` ${problem} at index ${index}, got ${JSON.stringify(path)}`);
}

/**
 * Parses a property path written in JavaScript accessor syntax into its segments: dot-separated names (`a.b`) and brackets holding a
 * canonical array index (`[0]`) or a quoted key (`['b.c']`, `["x"]`, with `\\`, `\'` and `\"` as the only escapes). The parser is
 * STRICT: anything else (empty names, `a..b`, a trailing `.`, `a.[0]`, `[]`, `[-1]`, `[01]`, an unquoted name in brackets, a missing
 * `]`, an unterminated quote, text right after `]`) is rejected rather than half-parsed, and so are `__proto__`, `constructor` and
 * `prototype` segments. The `...Path` helpers (`getPath`, `setPath`…) keep their plain dot syntax: join the segments with `'.'` when none contains one.
 * @param {string} path - The path, e.g. `"a[0]['b.c'].d"`
 * @returns {string[]} The segments (indices as strings), e.g. `['a', '0', 'b.c', 'd']`
 * @throws {TypeError} when `path` is not a string
 * @throws {RangeError} when `path` is malformed or has a `__proto__`, `constructor` or `prototype` segment
 * @example
 * toPath("users[0]['first.name']"); // => ['users', '0', 'first.name']
 * toPath(String.raw`a.b[12]['it\'s']`); // => ['a', 'b', '12', "it's"]
 * toPath('a..b'); // throws RangeError
 * toPath("a['__proto__']"); // throws RangeError
 */
export function toPath(path: string): string[] {
	if (typeof path !== 'string') throw new TypeError(`toPath: \`path\` must be a string, got ${describe(path)}`);
	const segments: string[] = [];
	let index = 0;
	let afterDot = false;

	for (;;) {
		const start = index;
		let segment = '';
		if (path[index] === '[' && !afterDot) {
			const quote = path[++index];
			if (quote === '"' || quote === "'") {
				for (let char = path[++index]; char !== quote; char = path[++index]) {
					if (char === undefined) invalidPath(path, start, 'has an unterminated quoted key');
					if (char === '\\') {
						char = path[++index];
						if (char !== '\\' && char !== '"' && char !== "'") invalidPath(path, index - 1, 'has an invalid escape');
					}
					segment += char;
				}
				index++;
			} else {
				const end = path.indexOf(']', index);
				segment = path.slice(index, end === -1 ? index : end);
				if (!CANONICAL_INDEX.test(segment)) invalidPath(path, start, 'must hold a canonical index or a quoted key in brackets');
				index = end;
			}
			if (path[index] !== ']') invalidPath(path, index, "is missing ']'");
			index++;
		} else {
			while (index < path.length && path[index] !== '.' && path[index] !== '[' && path[index] !== ']') index++;
			if (index === start) invalidPath(path, start, 'has an empty segment');
			segment = path.slice(start, index);
		}
		if (UNSAFE_KEYS.has(segment)) invalidPath(path, start, `has the unsafe segment "${segment}"`);
		segments.push(segment);

		if (index === path.length) return segments;
		afterDot = path[index] === '.';
		if (afterDot) index++;
		else if (path[index] !== '[') invalidPath(path, index, `has an unexpected ${JSON.stringify(path[index])}`);
	}
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
	const prototype = Object.getPrototypeOf(value);
	if (isOrdinary(value, prototype)) {
		if (!Array.isArray(value)) {
			if (prototype === null) {
				// Assignments to an object without a prototype define own data properties (no setter to run, `__proto__` included).
				const bare: Properties = Object.create(null);
				seen?.set(value, bare);
				for (const key of ownEnumerableKeys(value)) bare[key] = copyChild((value as Properties)[key], seen);
				return bare;
			}
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

	// Arrays and records of other realms have nothing but their members to copy: no brand check (for objects of another realm, each one
	// fails by throwing, which costs microseconds).
	if (!holdsOnlyMembers(value, prototype)) {
		if (isUncloneable(value)) return value;

		const [isBoxed, primitive] = unbox(value);
		// Recorded in `seen` too, so that shared references to them stay shared in a deep copy.
		if (isBoxed) return remember(seen, value, adoptPrototype(Object(primitive), value));
		if (isDate(value)) return remember(seen, value, adoptPrototype(new Date(value.getTime()), value));
		if (isRegExp(value)) return remember(seen, value, copyRegExp(value));
		if (isBinary(value)) return remember(seen, value, seen !== undefined && ArrayBuffer.isView(value) ? copyViewOver(value, seen) : copyBinary(value));

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
	}

	const error = isError(value);
	const copy: object = error ? errorShell(value) : Array.isArray(value) ? adoptPrototype(new Array(value.length), value) : Object.create(prototype);
	seen?.set(value, copy);
	// Errors keep all their own properties (`message` and `stack` are not enumerable), as they are defined (getters included).
	for (const key of error ? Reflect.ownKeys(value) : ownEnumerableKeys(value)) {
		if (error) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			// A getter copied earlier may have deleted this property.
			if (descriptor === undefined) continue;
			if ('value' in descriptor) descriptor.value = copyChild(descriptor.value, seen);
			// V8 defines `stack` as an own accessor reading an internal slot of the original, which the copy lacks: copy its value.
			else if (key === 'stack') {
				Object.defineProperty(copy, key, { value: (value as Error).stack, writable: true, configurable: true, enumerable: descriptor.enumerable === true });
				continue;
			}
			Object.defineProperty(copy, key, descriptor);
		} else defineValue(copy, key, copyChild((value as Properties)[key], seen));
	}
	return copy;
}

/**
 * Records `copy` as the copy of `value` in a deep copy's `seen` map (a shallow copy has none).
 * @param {Map<object, unknown> | undefined} seen - The objects already copied
 * @param {object} value - The original
 * @param {T} copy - Its copy
 * @returns {T} `copy`
 */
function remember<T>(seen: Map<object, unknown> | undefined, value: object, copy: T): T {
	seen?.set(value, copy);
	return copy;
}

/**
 * Copies a typed array or a `DataView` for a deep copy: a view of the same type, offset and length over the COPY of its buffer (copied
 * whole, once), so that views sharing a buffer still share one, as with `structuredClone`. Over a resizable buffer, a view that reaches
 * its end tracks its length.
 * @param {ArrayBufferView} value - The view
 * @param {Map<object, unknown>} seen - The objects already copied
 * @returns {ArrayBufferView} The copy
 */
function copyViewOver(value: ArrayBufferView, seen: Map<object, unknown>): ArrayBufferView {
	const buffer = copyWith(value.buffer, seen) as ArrayBufferLike & { resizable?: boolean; growable?: boolean };
	const name = (typedArrayTag.call(value) as string | undefined) ?? 'DataView';
	const View = (globalThis as unknown as Record<string, new (buffer: ArrayBufferLike, byteOffset: number, length?: number) => ArrayBufferView>)[name];
	// Whether a view tracks the length of its buffer cannot be read: a view of a resizable (or growable) buffer that reaches its end is
	// copied as length-tracking, which is how such views are made (`new Uint8Array(buffer)`), so that it grows with the copied buffer.
	if ((buffer.resizable === true || buffer.growable === true) && value.byteOffset + value.byteLength === buffer.byteLength) {
		return adoptPrototype(new View(buffer, value.byteOffset), value);
	}
	const length = name === 'DataView' ? value.byteLength : (value as unknown as { length: number }).length;
	return adoptPrototype(new View(buffer, value.byteOffset, length), value);
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
 *   Resizable buffers stay resizable, and a view that reaches the end of one tracks its length (whether the original did cannot be read).
 * - Errors keep their prototype and all own properties (`message`, `stack`, `cause`, ...).
 * - `WeakMap`, `WeakSet` and promises (any object with a `then` method) cannot be copied and are returned by reference.
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
 * How {@link deepMergeWith} and {@link defaultsWith} combine two arrays found at the same key:
 * - `'replace'`: the array of the winning side is used alone, by reference (the later source for {@link deepMergeWith}, the earlier
 *   value for the defaults helpers);
 * - `'concat'`: a new array with the items of the earlier value followed by those of the later one;
 * - `'union'`: like `'concat'`, without repeated items (SameValueZero, so objects are compared by reference).
 */
export type ArrayMergeStrategy = 'replace' | 'concat' | 'union';

/**
 * Third argument of a {@link MergeCustomizer}.
 */
export interface MergeCustomizerContext {
	/** The key being merged. */
	key: PropertyKey;
	/** The keys leading from the root of the result to this key (a fresh array; `key` is its last item). */
	path: PropertyKey[];
}

/**
 * Decides the merged value of one key for {@link deepMergeWith}: receives the value merged so far (`undefined` when the key is not set
 * yet) and the value of the source, and returns the value to store, or `undefined` to apply the default rules.
 */
export type MergeCustomizer = (targetValue: unknown, sourceValue: unknown, context: MergeCustomizerContext) => unknown;

/**
 * Options of {@link deepMergeWith}.
 */
export interface DeepMergeOptions {
	/** How two arrays at the same key are combined (default `'replace'`, like {@link deepMerge}). */
	arrays?: ArrayMergeStrategy;
	/** Called for every merged key of every source (not for the copy of the target); see {@link MergeCustomizer}. */
	customizer?: MergeCustomizer;
}

/**
 * Options of {@link defaultsWith}.
 */
export interface DefaultsOptions {
	/** Whether nested plain objects are filled recursively (like {@link defaultsDeep}) instead of being kept whole (default `false`). */
	deep?: boolean;
	/** Which values of the result count as missing: `'undefined'` (default: absent or `undefined`) or `'nullish'` (also `null`). */
	missing?: 'undefined' | 'nullish';
	/** How an array of the result and an array of a source at the same key are combined (default `'replace'`: the result's is kept). */
	arrays?: ArrayMergeStrategy;
}

/**
 * The resolved settings of the merge engine shared by {@link deepMerge}, {@link deepMergeWith} and the defaults helpers.
 */
interface MergeSettings {
	/** Name of the public function, used in error messages. */
	caller: string;
	/** Whether plain objects found on both sides are merged recursively. */
	deep: boolean;
	/** Defaults mode: a key keeps its value unless that value is missing (otherwise later sources win). */
	fill: boolean;
	/** In defaults mode, whether `null` counts as missing too. */
	nullish: boolean;
	/** How two arrays at the same key are combined. */
	arrays: ArrayMergeStrategy;
	/** The customizer of {@link deepMergeWith}, if any. */
	customizer: MergeCustomizer | undefined;
	/**
	 * With a customizer, the plain objects created by the current merge, the only ones merged into in place (set by {@link mergeAll}).
	 * Without one, every plain object of the result is created by the merge (incoming plain objects are always merged into a new
	 * object, never stored as they are), so none needs to be recorded.
	 */
	created?: WeakSet<object>;
}

/**
 * Combines two arrays met at the same key ({@link ArrayMergeStrategy} `'concat'` or `'union'`).
 * @param {ReadonlyArray<unknown>} earlier - The array merged so far
 * @param {ReadonlyArray<unknown>} later - The array of the source
 * @param {boolean} union - Whether repeated items are dropped
 * @returns {unknown[]} A new array
 */
function combineArrays(earlier: ReadonlyArray<unknown>, later: ReadonlyArray<unknown>, union: boolean): unknown[] {
	// Called on a fresh plain array, `concat` never consults the species of a user's array subclass.
	const combined: unknown[] = [].concat(earlier as never, later as never);
	return union ? Array.from(new Set(combined)) : combined;
}

/**
 * Creates an empty object with the prototype of a plain object (`Object.prototype` or `null`).
 * @param {object} like - The plain object
 * @returns {object} The new empty object
 */
function emptyLike(like: object): object {
	return Object.getPrototypeOf(like) === null ? Object.create(null) : {};
}

/**
 * Recursively merges the own enumerable keys of `source` into the (freshly created, owned) object `result`, following `settings`.
 * @param {object} result - The object being built (mutated)
 * @param {object} source - The plain object to merge in
 * @param {object[]} ancestors - Source objects currently being merged (cycle detection; a short list, cheaper to scan than to hash into)
 * @param {MergeSettings} settings - The merge rules
 * @param {PropertyKey[]} path - The keys leading to `result` (for the customizer; restored before returning)
 * @returns {object} `result`
 * @throws {TypeError} when `source` contains a circular reference
 */
function mergeInto(result: object, source: object, ancestors: object[], settings: MergeSettings, path: PropertyKey[]): object {
	if (ancestors.includes(source)) throw new TypeError(`${settings.caller}: cannot merge objects with circular references`);
	ancestors.push(source);
	const { customizer, fill, arrays } = settings;
	// Without a customizer, the defaults mode or an array strategy, the value merged so far only matters below a plain object.
	const simple = customizer === undefined && !fill && arrays === 'replace';

	for (const key of ownEnumerableKeys(source)) {
		if (UNSAFE_KEYS.has(key)) continue;
		const incoming = (source as Properties)[key];
		const plain = settings.deep && isPlainObject(incoming);
		let value = incoming;

		if (plain || !simple) {
			// Only an OWN value of `result` (always a fresh object built here) is merged into: never an inherited one such as
			// `Object.prototype` through `__proto__`, or `Object` through `constructor`.
			const current = hasOwn(result, key) ? (result as Properties)[key] : undefined;
			value = customizer === undefined ? undefined : customizer(current, incoming, { key, path: [...path, key] });
			if (value === undefined) {
				// In defaults mode a present value is kept (only plain objects and arrays may still be combined with the incoming one).
				const kept = fill && current !== undefined && !(settings.nullish && current === null);
				if (plain && (isPlainObject(current) || !kept)) {
					path.push(key);
					value = mergeInto(mergeBase(current, incoming as object, ancestors, settings, path), incoming as object, ancestors, settings, path);
					path.pop();
				} else if (arrays !== 'replace' && Array.isArray(current) && Array.isArray(incoming)) {
					value = combineArrays(current, incoming, arrays === 'union');
				} else if (kept) continue;
				else value = incoming;
			}
		}
		definePlain(result, key, value);
	}

	ancestors.pop();
	return result;
}

/**
 * The object a plain `incoming` value is merged into: the value merged so far when the merge created it, a copy of it when it comes
 * from elsewhere (a customizer may return an input, which must not be mutated), or a new empty object.
 * @param {unknown} current - The value merged so far
 * @param {object} incoming - The plain object being merged
 * @param {object[]} ancestors - Sources being merged around this one (to detect cycles)
 * @param {MergeSettings} settings - The merge rules
 * @param {PropertyKey[]} path - The keys leading to the merged value
 * @returns {object} The object to merge `incoming` into
 */
function mergeBase(current: unknown, incoming: object, ancestors: object[], settings: MergeSettings, path: PropertyKey[]): object {
	const created = settings.created;
	if (isPlainObject(current) && (created === undefined || created.has(current))) return current;
	const base = emptyLike(isPlainObject(current) ? current : incoming);
	created?.add(base);
	return isPlainObject(current) ? mergeInto(base, current, ancestors, { ...settings, customizer: undefined }, path) : base;
}

/**
 * Merges `sources` over a copy of `target` with the merge engine (the entry point of the merge-style helpers).
 * @param {MergeSettings} settings - The merge rules
 * @param {object} target - The base plain object
 * @param {ReadonlyArray<unknown>} sources - The sources (`null`/`undefined` ones are skipped)
 * @returns {object} The new, merged object
 * @throws {TypeError} when the target or a source is not a plain object, or an input contains a circular reference
 */
function mergeAll(settings: MergeSettings, target: object, sources: ReadonlyArray<unknown>): object {
	if (!isPlainObject(target)) throw new TypeError(`${settings.caller}: \`target\` must be a plain object, got ${describe(target)}`);

	const ancestors: object[] = [];
	const run: MergeSettings = settings.customizer === undefined ? settings : { ...settings, created: new WeakSet<object>() };
	// The target is copied (into an empty object, so the mode and the array strategy make no difference) without the customizer.
	const copy = run.customizer === undefined ? run : { ...run, customizer: undefined };
	const result = emptyLike(target);
	run.created?.add(result);
	mergeInto(result, target, ancestors, copy, []);

	for (let index = 0; index < sources.length; index++) {
		const source = sources[index];
		if (source == null) continue;
		if (!isPlainObject(source)) throw new TypeError(`${settings.caller}: \`sources[${index}]\` must be a plain object, got ${describe(source)}`);
		mergeInto(result, source, ancestors, run, []);
	}

	return result;
}

/**
 * Builds the settings of a merge-style helper, validating the user options.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} options - The options object
 * @param {boolean} fill - Whether the helper is a defaults helper
 * @returns {MergeSettings} The settings
 * @throws {TypeError} when `options` is not an object, or `customizer` is not a function
 * @throws {RangeError} when `arrays` or `missing` is not one of the accepted values
 */
function mergeSettings(caller: string, options: unknown, fill: boolean): MergeSettings {
	if (!isObject(options)) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);
	const settings = options as DeepMergeOptions & DefaultsOptions;
	const arrays = readOption(settings, 'arrays', 'replace');
	const customizer = readOption(settings, 'customizer');
	const missing = readOption(settings, 'missing', 'undefined');
	const deep = readOption(settings, 'deep');
	if (arrays !== 'replace' && arrays !== 'concat' && arrays !== 'union') {
		throw new RangeError(`${caller}: \`arrays\` must be 'replace', 'concat' or 'union', got ${JSON.stringify(arrays)}`);
	}
	if (missing !== 'undefined' && missing !== 'nullish') throw new RangeError(`${caller}: \`missing\` must be 'undefined' or 'nullish', got ${JSON.stringify(missing)}`);
	if (customizer !== undefined) assertFunction(caller, 'customizer', customizer);
	return { caller, deep: !fill || deep === true, fill, nullish: missing === 'nullish', arrays, customizer };
}

/** Settings of {@link deepMerge}. */
const DEEP_MERGE: MergeSettings = { caller: 'deepMerge', deep: true, fill: false, nullish: false, arrays: 'replace', customizer: undefined };

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
 *
 * {@link deepMergeWith} adds array strategies and a customizer.
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
	return mergeAll(DEEP_MERGE, target, sources) as DeepMergeAll<T, S>;
}

/**
 * The type produced by {@link deepMergeWith}: {@link DeepMergeAll} (with combined array item types for `'concat'`/`'union'`), or a
 * plain record when a customizer can return anything.
 */
export type DeepMergeWithResult<O extends DeepMergeOptions, T, S extends readonly unknown[]> = 'customizer' extends keyof O
	? O['customizer'] extends undefined
		? DeepMergeAll<T, S, O['arrays'] extends 'concat' | 'union' ? true : false>
		: Record<PropertyKey, unknown>
	: DeepMergeAll<T, S, O['arrays'] extends 'concat' | 'union' ? true : false>;

/**
 * {@link deepMerge} with options: an array strategy and a customizer. Same guarantees as {@link deepMerge}: a NEW object (inputs
 * are never mutated), only plain objects merged recursively, `__proto__`/`constructor`/`prototype` keys dropped at every level,
 * circular inputs rejected.
 * - `arrays`: `'replace'` (default: the later array wins, by reference), `'concat'` (a new array: earlier items, then later ones) or
 *   `'union'` (`'concat'` without repeated items, SameValueZero). Unlike lodash `mergeWith`, arrays are never merged index by index.
 * - `customizer(targetValue, sourceValue, { key, path })`: called for every key of every source (not for the copy of the target); its
 *   result is stored as is, unless it is `undefined`, which applies the default rules. `path` lists the keys from the root.
 * @template O - The options type
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {O} options - `arrays` and `customizer`
 * @param {T} target - The base plain object
 * @param {...S} sources - Plain objects merged over the base, in order
 * @returns {DeepMergeWithResult<O, T, S>} A new, deeply merged object
 * @throws {TypeError} when `options` is not an object or `customizer` is not a function
 * @throws {RangeError} when `arrays` is not `'replace'`, `'concat'` or `'union'`
 * @throws {TypeError} when the target or a source is not a plain object, or an input contains a circular reference
 * @example
 * deepMergeWith({ arrays: 'concat' }, { tags: ['a'], a: { list: [1] } }, { tags: ['b'], a: { list: [1, 2] } }); // => { tags: ['a', 'b'], a: { list: [1, 1, 2] } }
 * deepMergeWith({ arrays: 'union' }, { list: [1, 2] }, { list: [2, 3] }); // => { list: [1, 2, 3] }
 * function sum(a: unknown, b: unknown) { return typeof a === 'number' && typeof b === 'number' ? a + b : undefined; }
 * deepMergeWith({ customizer: sum }, { hits: 1, name: 'a' }, { hits: 2, name: 'b' }); // => { hits: 3, name: 'b' }
 */
export function deepMergeWith<O extends DeepMergeOptions, T extends object, S extends object[]>(options: O, target: T, ...sources: S): DeepMergeWithResult<O, T, S> {
	return mergeAll(mergeSettings('deepMergeWith', options, false), target, sources) as DeepMergeWithResult<O, T, S>;
}

/** Settings of {@link defaults}. */
const DEFAULTS: MergeSettings = { caller: 'defaults', deep: false, fill: true, nullish: false, arrays: 'replace', customizer: undefined };

/** Settings of {@link defaultsDeep}. */
const DEFAULTS_DEEP: MergeSettings = { caller: 'defaultsDeep', deep: true, fill: true, nullish: false, arrays: 'replace', customizer: undefined };

/**
 * Fills the MISSING keys of a copy of `target` from `sources`: a key keeps the first value that is not `undefined`, looking at the
 * target first, then each source in order (lodash `defaults`, without mutating anything). Returns a NEW object.
 * - Only `undefined` (or an absent key) counts as missing: `null`, `0`, `''` and `false` are kept (see {@link defaultsWith} for `'nullish'`).
 * - Values are taken by reference (nested objects are not filled: see {@link defaultsDeep}).
 * - Keys `__proto__`, `constructor` and `prototype` are DROPPED (from the target too), like {@link deepMerge}: defaults are the classic
 *   sink for untrusted configuration.
 * - `null`/`undefined` sources are skipped.
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {T} target - The plain object whose present values win
 * @param {...S} sources - Plain objects providing the defaults, in priority order
 * @returns {DefaultsAll<T, S>} A new object
 * @throws {TypeError} when the target or a source is not a plain object
 * @example
 * defaults({ a: 1, b: undefined, c: null }, { a: 9, b: 2, c: 3, d: 4 }); // => { a: 1, b: 2, c: null, d: 4 }
 * defaults({}, { a: 1 }, { a: 2, b: 2 }); // => { a: 1, b: 2 }
 */
export function defaults<T extends object, S extends object[]>(target: T, ...sources: S): DefaultsAll<T, S> {
	return mergeAll(DEFAULTS, target, sources) as DefaultsAll<T, S>;
}

/**
 * {@link defaults} that also fills nested plain objects recursively: a plain object of the target and a plain object of a source at
 * the same key are filled key by key; any other present value (arrays included) is kept as is. Returns a NEW object: every plain object
 * of the result is a fresh copy, so filling never writes into an input. Keys `__proto__`, `constructor` and `prototype` are DROPPED at
 * every level; circular inputs throw.
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {T} target - The plain object whose present values win
 * @param {...S} sources - Plain objects providing the defaults, in priority order
 * @returns {DefaultsAll<T, S, true>} A new object
 * @throws {TypeError} when the target or a source is not a plain object, or an input contains a circular reference
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * defaultsDeep({ server: { port: 8080 } }, { server: { host: 'localhost', port: 80 }, debug: false }); // => { server: { port: 8080, host: 'localhost' }, debug: false }
 * defaultsDeep({ list: [1] }, { list: [2, 3] }); // => { list: [1] }
 */
export function defaultsDeep<T extends object, S extends object[]>(target: T, ...sources: S): DefaultsAll<T, S, true> {
	return mergeAll(DEFAULTS_DEEP, target, sources) as DefaultsAll<T, S, true>;
}

/**
 * The type produced by {@link defaultsWith}: {@link DefaultsAll}, deep when `options.deep` is `true`, with combined array item types
 * for `'concat'`/`'union'`.
 */
export type DefaultsWithResult<O extends DefaultsOptions, T, S extends readonly unknown[]> = DefaultsAll<
	T,
	S,
	O['deep'] extends true ? true : false,
	O['arrays'] extends 'concat' | 'union' ? true : false
>;

/**
 * {@link defaults} / {@link defaultsDeep} with options, making explicit the choices the popular libraries disagree on:
 * - `deep` (default `false`): fill nested plain objects recursively;
 * - `missing` (default `'undefined'`, like lodash): `'nullish'` also replaces `null` values (like defu);
 * - `arrays` (default `'replace'`: the earlier array is kept, like lodash): `'concat'` appends the items of the default (like defu),
 *   `'union'` does the same without repeated items.
 *
 * Same guarantees: a NEW object, inputs never mutated, `__proto__`/`constructor`/`prototype` keys dropped, circular inputs rejected.
 * @template O - The options type
 * @template T - The target type
 * @template S - The tuple of source types
 * @param {O} options - `deep`, `missing` and `arrays`
 * @param {T} target - The plain object whose present values win
 * @param {...S} sources - Plain objects providing the defaults, in priority order
 * @returns {DefaultsWithResult<O, T, S>} A new object
 * @throws {TypeError} when `options` is not an object
 * @throws {RangeError} when `missing` or `arrays` is not one of the accepted values
 * @throws {TypeError} when the target or a source is not a plain object, or an input contains a circular reference
 * @example
 * defaultsWith({ missing: 'nullish' }, { a: null, b: 0 }, { a: 1, b: 1 }); // => { a: 1, b: 0 }
 * defaultsWith({ deep: true, arrays: 'concat' }, { a: { list: [1] } }, { a: { list: [2], x: 1 } }); // => { a: { list: [1, 2], x: 1 } }
 */
export function defaultsWith<O extends DefaultsOptions, T extends object, S extends object[]>(options: O, target: T, ...sources: S): DefaultsWithResult<O, T, S> {
	return mergeAll(mergeSettings('defaultsWith', options, true), target, sources) as DefaultsWithResult<O, T, S>;
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
 * Third argument of an {@link EqualityCustomizer}.
 */
export interface EqualityContext {
	/** The key of the compared values in their parents: a property key, a `Map` key, or `undefined` (the roots, `Set` members, `Map` keys). */
	key: unknown;
	/** The keys leading from the roots to the compared values (a fresh array, empty for the roots). */
	path: unknown[];
	/** The object holding the first value (`undefined` for the roots). */
	parentA: unknown;
	/** The object holding the second value (`undefined` for the roots). */
	parentB: unknown;
	/** Compares two values with the same customizer and the same cycle detection (for customizers that recurse themselves). */
	equals: (a: unknown, b: unknown) => boolean;
}

/**
 * Decides whether two values are equal for {@link isEqualWith}: `true`/`false` settle the comparison of this pair, `undefined` applies
 * the default rules of {@link isEqual} (any other result is converted to a boolean).
 */
export type EqualityCustomizer = (a: unknown, b: unknown, context: EqualityContext) => boolean | undefined;

/**
 * Pairs of objects currently being compared by {@link isEqual} (used to detect cycles), with the key under which each pair was
 * reached; {@link isEqualWith} attaches its customizer (and the matching `equals` function) to it.
 */
type ComparisonStack = Array<[object, object, unknown?]> & {
	customizer?: EqualityCustomizer;
	equals?: (a: unknown, b: unknown) => boolean;
	/** The number of object pairs compared so far (see `proven`). */
	compared?: number;
	/** How many times a pair under comparison was assumed equal (a cycle): results reached meanwhile only hold under that assumption. */
	assumed?: number;
	/** Pairs with a large subtree proven equal without assumptions: a subtree shared by several paths is then compared once. */
	proven?: WeakMap<object, object>;
	/** For {@link isMatch}: the results of pairs with a large subtree, settled without assumptions. */
	settled?: WeakMap<object, WeakMap<object, boolean>>;
	/** For the `test` operation of {@link applyPatch}: plain objects compare their members whatever their prototype (`null` or not). */
	json?: boolean;
	/** For {@link applyPatch} and {@link createPatch}: a member of a plain object whose value is `undefined` counts as absent (as in JSON). */
	absentUndefined?: boolean;
};

/** How many nested object pairs an equal pair must have needed for {@link isEqual} to remember it (small subtrees are cheaper to redo). */
const PROVEN_SUBTREE = 64;

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
	// Collected when first needed: maps keyed by primitives (the usual ones) never need it.
	let objectEntriesB: Array<[unknown, unknown]> | undefined;
	const matched: boolean[] = [];

	for (const [keyA, valueA] of a) {
		if (!isObject(keyA)) {
			if (!b.has(keyA) || !equalWith(valueA, b.get(keyA), stack, keyA)) return false;
			continue;
		}
		objectEntriesB ??= Array.from(b).filter(function ([key]) {
			return isObject(key);
		});
		const index = objectEntriesB.findIndex(function ([keyB, valueB], candidate) {
			return !matched[candidate] && equalWith(keyA, keyB, stack) && equalWith(valueA, valueB, stack, keyA);
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
	// Collected when first needed: sets of primitives (the usual ones) never need it.
	let objectMembersB: unknown[] | undefined;
	const matched: boolean[] = [];

	for (const memberA of a) {
		if (!isObject(memberA)) {
			if (!b.has(memberA)) return false;
			continue;
		}
		objectMembersB ??= Array.from(b).filter(isObject);
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
		// `b` has the tag of `a`: an `ArrayBuffer` and a `SharedArrayBuffer` never pair (a view could, with a forged prototype).
		if (ArrayBuffer.isView(b)) return false;
		left = new Uint8Array(a);
		right = new Uint8Array(b as ArrayBuffer);
	} else {
		// The built-in tag getter reads the internal name (`undefined` for a `DataView`): a forged tag or prototype cannot pair two kinds.
		const name = typedArrayTag.call(a);
		if (!ArrayBuffer.isView(b) || typedArrayTag.call(b) !== name) return false;
		if (name === undefined) {
			const view = b as ArrayBufferView;
			left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
			right = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
		}
	}
	const length = left.length;
	if (length !== right.length) return false;
	// A plain loop (not `every` with a callback): typed arrays are often large. Inlined SameValueZero, for bigints and floats alike.
	for (let index = 0; index < length; index++) {
		const x = left[index];
		const y = right[index];
		if (x !== y && (x === x || y === y)) return false;
	}
	return true;
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
		if (!equalWith((a as Properties)[key], (b as Properties)[key], stack, key)) return false;
	}
	return true;
}

/**
 * Compares the own enumerable string-keyed properties of two plain objects, ignoring those whose value is `undefined` (as JSON does,
 * and as {@link createPatch}, which diffs string keys only). Each value is read once.
 * @param {object} a - First object
 * @param {object} b - Second object
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether both have the same keys with a defined value, and deeply equal values for them
 */
function definedMembersEqual(a: object, b: object, stack: ComparisonStack): boolean {
	const defined = new Map<PropertyKey, unknown>();
	for (const key of Object.keys(b)) {
		const value = (b as Properties)[key];
		if (value !== undefined) defined.set(key, value);
	}
	let count = 0;
	for (const key of Object.keys(a)) {
		const value = (a as Properties)[key];
		if (value === undefined) continue;
		if (!defined.has(key) || !equalWith(value, defined.get(key), stack, key)) return false;
		count++;
	}
	return count === defined.size;
}

/**
 * Compares two objects of the same prototype and tag according to their kind.
 * @param {object} a - First object
 * @param {object} b - Second object
 * @param {ComparisonStack} stack - Cycle detection stack
 * @returns {boolean} Whether they are deeply equal
 */
function objectsEqual(a: object, b: object, stack: ComparisonStack): boolean {
	if (stack.absentUndefined === true && isJsonObject(a) && isJsonObject(b)) return definedMembersEqual(a, b, stack);
	const prototype = Object.getPrototypeOf(a);
	if (isOrdinary(a, prototype) || holdsOnlyMembers(a, prototype)) return (!Array.isArray(a) || (Array.isArray(b) && a.length === b.length)) && propertiesEqual(a, b, stack);
	if (isUncloneable(a)) return false;
	// `b` has the prototype and the tag of `a`, yet only one of them may be a genuine built-in (the other a proxy of one, such as a
	// framework's reactive `Map`, or an object with a forged tag): the brands must match, in both directions.
	if (isDate(a)) return isDate(b) && sameValueZero(a.getTime(), b.getTime());
	if (isRegExp(a)) return isRegExp(b) && a.source === b.source && a.flags === b.flags;
	if (isMap(a)) return isMap(b) && mapsEqual(a, b, stack);
	if (isSet(a)) return isSet(b) && setsEqual(a, b, stack);
	if (isBinary(a)) return isBinary(b) && binaryEqual(a, b);
	// With the default tag (class instances), `b` is no built-in either: its prototype would provide the built-in's tag, and boxed
	// primitives are told by their tag. (A thenable `b` has a `then` member that `a` lacks.)
	if (getTag(a) !== '[object Object]') {
		if (isWeakMap(b) || isWeakSet(b) || isDate(b) || isRegExp(b) || isMap(b) || isSet(b) || isBinary(b)) return false;
		const [isBoxedA, primitiveA] = unbox(a);
		const [isBoxedB, primitiveB] = unbox(b);
		if (isBoxedA !== isBoxedB || !sameValueZero(primitiveA, primitiveB)) return false;
	}
	if (isError(a) && (a.name !== (b as Error).name || a.message !== (b as Error).message)) return false;
	return propertiesEqual(a, b, stack);
}

/**
 * Whether two objects have the same prototype and the same `Object.prototype.toString` tag (a precondition of their equality).
 * @param {object} a - First object
 * @param {object} b - Second object
 * @returns {boolean} Whether they are of the same kind
 */
function sameKind(a: object, b: object): boolean {
	return Object.getPrototypeOf(a) === Object.getPrototypeOf(b) && getTag(a) === getTag(b);
}

/**
 * Whether an object is a JSON object for the `test` operation of {@link applyPatch}: a plain object with an `Object.prototype` or
 * `null` prototype (not a thenable).
 * @param {object} value - The object
 * @returns {boolean} Whether it is a plain object
 */
function isJsonObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return (prototype === null || prototype === Object.prototype) && isTree(value, prototype);
}

/**
 * Whether the pair `(a, b)` is already being compared further up (a cycle: it is then assumed equal).
 * @param {ComparisonStack} stack - The pairs being compared
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @returns {boolean} Whether the pair is on the stack
 */
function isComparing(stack: ComparisonStack, a: unknown, b: unknown): boolean {
	for (const [left, right] of stack) {
		if (left === a && right === b) return true;
	}
	return false;
}

/**
 * Recursive worker of {@link isEqual} and {@link isEqualWith}.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @param {ComparisonStack} stack - Pairs currently being compared (cycle detection), with the customizer of {@link isEqualWith}
 * @param {unknown} [key] - The key of the values in their parents (for the customizer)
 * @returns {boolean} Whether the values are deeply equal
 */
function equalWith(a: unknown, b: unknown, stack: ComparisonStack, key?: unknown): boolean {
	if (stack.customizer !== undefined) return customEqual(a, b, stack, key, stack.customizer);
	if (sameValueZero(a, b)) return true;
	if (!isObject(a) || !isObject(b) || !(sameKind(a, b) || (stack.json === true && isJsonObject(a) && isJsonObject(b)))) return false;
	if (isComparing(stack, a, b)) {
		stack.assumed = (stack.assumed ?? 0) + 1;
		return true;
	}
	if (stack.proven?.get(a) === b) return true;

	const assumed = stack.assumed ?? 0;
	const compared = (stack.compared = (stack.compared ?? 0) + 1);

	stack.push([a, b]);
	const result = objectsEqual(a, b, stack);
	stack.pop();
	// A value reached through several paths (`{ l: node, r: node }` at every level) would otherwise be compared once per path: an
	// exponential number of times. An equality that assumed no pair equal holds anywhere, so the pairs with large subtrees are remembered.
	if (result && (stack.compared as number) - compared > PROVEN_SUBTREE && (stack.assumed ?? 0) === assumed) (stack.proven ??= new WeakMap()).set(a, b);
	return result;
}

/**
 * {@link equalWith} for {@link isEqualWith}: asks the customizer first, then applies the default rules. An object pair is pushed on the
 * stack BEFORE the customizer runs, so a customizer that recurses through `context.equals` still terminates on cycles.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @param {ComparisonStack} stack - Pairs currently being compared
 * @param {unknown} key - The key of the values in their parents
 * @param {EqualityCustomizer} customizer - The customizer
 * @returns {boolean} Whether the values are equal
 */
function customEqual(a: unknown, b: unknown, stack: ComparisonStack, key: unknown, customizer: EqualityCustomizer): boolean {
	if (Object.is(a, b)) return true;
	const objects = isObject(a) && isObject(b);
	if (objects && isComparing(stack, a, b)) return true;

	const depth = stack.length;
	const path: unknown[] = [];
	for (let index = 1; index < depth; index++) path.push(stack[index][2]);
	if (depth > 0) path.push(key);
	const parent = stack[depth - 1] as [object, object] | undefined;

	if (objects) stack.push([a, b, key]);
	let result: unknown = customizer(a, b, { key, path, parentA: parent?.[0], parentB: parent?.[1], equals: stack.equals as (a: unknown, b: unknown) => boolean });
	if (result === undefined) result = sameValueZero(a, b) || (objects && sameKind(a, b) && objectsEqual(a, b, stack));
	if (objects) stack.pop();
	return Boolean(result);
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
 * - `WeakMap`, `WeakSet` and promises (any object with a `then` method) are only equal to themselves.
 * - Built-ins are recognized by their internal slots, not their prototype or tag: a genuine `Map` never equals a `Proxy` of one (such
 *   as a framework's reactive `Map`, whose entries the slots do not reveal) or an object posing as one, in either order.
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
 * {@link isEqual} with a customizer consulted for every compared pair of non-identical values (`Object.is`: identical values are
 * always equal, so `0` and `-0` do reach it), the roots included, before the default rules:
 * `customizer(a, b, { key, path, parentA, parentB, equals })` returns `true` or `false` to settle that pair, or `undefined` to fall back
 * to {@link isEqual}'s rules (whose nested comparisons consult the customizer again). `context.equals(x, y)` compares with the same
 * customizer and the same cycle detection, so a customizer that recurses into cyclic data still terminates.
 * Not consulted for: primitive `Map` keys and `Set` members (looked up with SameValueZero) and typed array elements.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @param {EqualityCustomizer} customizer - Decides pairs, or returns `undefined`
 * @returns {boolean} Whether the values are equal
 * @throws {TypeError} when `customizer` is not a function
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * function caseless(a: unknown, b: unknown) { return typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : undefined; }
 * isEqualWith({ name: 'ADA', tags: ['X'] }, { name: 'ada', tags: ['x'] }, caseless); // => true
 * function ignoreIds(_a: unknown, _b: unknown, context: { key: unknown }) { return context.key === 'id' ? true : undefined; }
 * isEqualWith({ id: 1, v: 2 }, { id: 9, v: 2 }, ignoreIds); // => true
 */
export function isEqualWith(a: unknown, b: unknown, customizer: EqualityCustomizer): boolean {
	assertFunction('isEqualWith', 'customizer', customizer);
	const stack: ComparisonStack = [];
	stack.customizer = customizer;
	stack.equals = function (x: unknown, y: unknown): boolean {
		return equalWith(x, y, stack);
	};
	return equalWith(a, b, stack);
}

/**
 * Options of {@link isMatch}.
 */
export interface IsMatchOptions {
	/**
	 * How an array of the pattern matches: `'exact'` (default: an array of the same length whose items match one by one) or
	 * `'subset'` (an array in which every item of the pattern matches some item, in any order, like lodash `isMatch`).
	 */
	arrays?: 'exact' | 'subset';
}

/**
 * Recursive worker of {@link isMatch}.
 * @param {unknown} value - The value tested
 * @param {unknown} pattern - The pattern it must match
 * @param {boolean} subset - Whether arrays of the pattern match as subsets
 * @param {ComparisonStack} stack - Pairs currently being matched (cycle detection)
 * @returns {boolean} Whether `value` matches `pattern`
 */
function matchWith(value: unknown, pattern: unknown, subset: boolean, stack: ComparisonStack): boolean {
	if (sameValueZero(value, pattern)) return true;
	const plain = isPlainObject(pattern);
	if (!plain && !Array.isArray(pattern)) return isObject(pattern) && equalWith(value, pattern, []);
	if (!(isObject(value) || isFunction(value)) || (!plain && !Array.isArray(value))) return false;
	if (isComparing(stack, value, pattern)) {
		stack.assumed = (stack.assumed ?? 0) + 1;
		return true;
	}
	const settled = stack.settled?.get(value)?.get(pattern);
	if (settled !== undefined) return settled;

	const assumed = stack.assumed ?? 0;
	const compared = (stack.compared = (stack.compared ?? 0) + 1);
	stack.push([value, pattern]);
	let result: boolean;
	if (plain) {
		result = ownEnumerableKeys(pattern).every(function (key) {
			const expected = (pattern as Properties)[key];
			const actual = readKey(value, key);
			// A key of the pattern holding `undefined` must be present in the value (and hold `undefined`).
			return expected === undefined ? actual === undefined && key in value && !isUnreadable(value, key) : matchWith(actual, expected, subset, stack);
		});
	} else {
		const items = value as unknown[];
		result = subset
			? (pattern as unknown[]).every(function (expected) {
					return presentIndexes(items).some(function (index: number) {
						return matchWith(items[index], expected, subset, stack);
					});
				})
			: items.length === (pattern as unknown[]).length &&
				(pattern as unknown[]).every(function (expected, index) {
					return matchWith(items[index], expected, subset, stack);
				});
	}
	stack.pop();
	// A pair reached through several paths would otherwise be matched once per path: an exponential number of times. A mismatch holds
	// anywhere (assuming the pairs on the stack match only made matching easier), a match only when it assumed nothing.
	if ((stack.compared as number) - compared > PROVEN_SUBTREE && (!result || (stack.assumed ?? 0) === assumed)) {
		const settledPairs = (stack.settled ??= new WeakMap());
		let pairs = settledPairs.get(value);
		if (pairs === undefined) settledPairs.set(value, (pairs = new WeakMap()));
		pairs.set(pattern, result);
	}
	return result;
}

/**
 * Deep PARTIAL match: whether `value` has every key of `pattern` with a matching value, recursively for plain objects.
 * - A plain-object pattern matches any object (or function) that has each of its own enumerable string and symbol keys (own or inherited,
 *   read with the rule of {@link getProperty}, so `constructor`, `__proto__` and `Object.prototype` members never match) with a matching value.
 *   `{}` matches every object. A key of the pattern holding `undefined` must be present (and `undefined`).
 * - An array pattern matches an array: item by item with the same length (default), or as a subset with `{ arrays: 'subset' }`.
 * - Every other pattern value is a leaf compared with {@link isEqual} (SameValueZero for primitives; `Date`, `Map`, `Set`, class
 *   instances... must be deeply equal, not partially).
 * - Circular patterns and values are supported.
 * @param {unknown} value - The value tested
 * @param {unknown} pattern - The pattern
 * @param {IsMatchOptions} [options={}] - `arrays` (`'exact'` or `'subset'`)
 * @returns {boolean} Whether `value` matches `pattern`
 * @throws {RangeError} when `arrays` is not `'exact'` or `'subset'`
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * isMatch({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 1 } }); // => true
 * isMatch({ tags: ['x', 'y'] }, { tags: ['y'] }); // => false
 * isMatch({ tags: ['x', 'y'] }, { tags: ['y'] }, { arrays: 'subset' }); // => true
 * isMatch({ users: [{ id: 1, name: 'Ada' }] }, { users: [{ id: 1 }] }); // => true
 * isMatch({ when: new Date(0) }, { when: new Date(0) }); // => true
 */
export function isMatch(value: unknown, pattern: unknown, options: IsMatchOptions = {}): boolean {
	const arrays = readOption(options, 'arrays') ?? 'exact';
	if (arrays !== 'exact' && arrays !== 'subset') throw new RangeError(`isMatch: \`arrays\` must be 'exact' or 'subset', got ${JSON.stringify(arrays)}`);
	return matchWith(value, pattern, arrays === 'subset', []);
}

/**
 * One-level equality: `true` when the values are SameValueZero-equal, or are objects of the same prototype and kind whose own
 * members are SameValueZero-equal (no deep comparison, O(n)):
 * - arrays: same length and same items (a hole only equals a hole); an array never equals an array-like object;
 * - `Map`: same size and the same value for every key; `Set`: same members; `Date`: same time value;
 * - other objects (plain or class instances): the same own enumerable string and symbol keys with the same values;
 * - objects with other internal state (`RegExp`, `Error`, typed arrays, boxed primitives, promises...) only equal themselves.
 *
 * SameValueZero means `NaN` equals `NaN` and `0` equals `-0`, like {@link isEqual}.
 * @param {unknown} a - First value
 * @param {unknown} b - Second value
 * @returns {boolean} Whether the values are shallowly equal
 * @example
 * shallowEqual({ a: 1, b: NaN }, { b: NaN, a: 1 }); // => true
 * shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }); // => false // different nested objects
 * shallowEqual([1, 2], { 0: 1, 1: 2, length: 2 }); // => false
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
	if (sameValueZero(a, b)) return true;
	if (!isObject(a) || !isObject(b)) return false;
	const prototype = Object.getPrototypeOf(a);
	if (prototype !== Object.getPrototypeOf(b)) return false;

	// Plain objects (the usual props and state records) need no further checks.
	if (prototype !== Object.prototype && prototype !== null) {
		const tag = getTag(a);
		if (tag !== getTag(b)) return false;
		if (Array.isArray(a)) {
			if (!Array.isArray(b) || a.length !== b.length) return false;
			if (a.length > SPARSE_SCAN) {
				// Huge (usually sparse) arrays: the same own elements, holes included.
				const left = presentIndexes(a);
				const right = presentIndexes(b);
				return (
					left.length === right.length &&
					left.every(function (index: number, position: number): boolean {
						return right[position] === index && sameValueZero(a[index], b[index]);
					})
				);
			}
			for (let index = 0; index < a.length; index++) {
				const item = a[index];
				if (!sameValueZero(item, b[index]) || (item === undefined && index in a !== index in b)) return false;
			}
			return true;
		}
		if (isMap(a)) {
			const other = b as Map<unknown, unknown>;
			if (!isMap(b) || a.size !== other.size) return false;
			for (const [key, value] of a) if (!other.has(key) || !sameValueZero(value, other.get(key))) return false;
			return true;
		}
		if (isSet(a)) {
			const other = b as Set<unknown>;
			if (!isSet(b) || a.size !== other.size) return false;
			for (const member of a) if (!other.has(member)) return false;
			return true;
		}
		if (isDate(a)) return isDate(b) && sameValueZero(a.getTime(), b.getTime());
		if (tag !== '[object Object]' || isPromise(a)) return false;
	}
	return sameMembers(a, b, Object.keys(a), Object.keys(b)) && sameMembers(a, b, appendSymbols(a, []), appendSymbols(b, []));
}

/**
 * Whether two objects have the same given own enumerable keys with SameValueZero-equal values (for {@link shallowEqual}).
 * @param {object} a - First object
 * @param {object} b - Second object
 * @param {PropertyKey[]} keysA - Own enumerable keys of `a` (of one kind: strings or symbols)
 * @param {PropertyKey[]} keysB - Own enumerable keys of `b` (of the same kind)
 * @returns {boolean} Whether the members are equal
 */
function sameMembers(a: object, b: object, keysA: PropertyKey[], keysB: PropertyKey[]): boolean {
	if (keysA.length !== keysB.length) return false;
	for (let index = 0; index < keysA.length; index++) {
		const key = keysA[index];
		// Objects built alike list their keys in the same order: a key found at the same index is an own enumerable key of `b`
		// without the (slower) lookup. With as many keys on both sides, every key of `a` being one of `b` makes the key sets equal.
		if ((key !== keysB[index] && !Object.prototype.propertyIsEnumerable.call(b, key)) || !sameValueZero((a as Properties)[key], (b as Properties)[key])) return false;
	}
	return true;
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

		// Arrays and records are walked through their properties alone.
		const record = Array.isArray(value) || isBareRecord(value);
		if (!record && isMap(value)) {
			value.forEach(function (entryValue, entryKey) {
				pending.push(entryKey, entryValue);
			});
		} else if (!record && isSet(value)) {
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
	for (const entry of entries) {
		// Like `Object.fromEntries`: an entry must be an object (`'ab'` would otherwise give `{ a: 'b' }`).
		if (typeof entry !== 'object' || entry === null) throw new TypeError(`typedFromEntries: every entry must be a [key, value] array, got ${describe(entry)}`);
		const [key, value] = entry;
		definePlain(result, key, value);
	}
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
	const separator = readOption(options, 'separator') ?? '.';
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
 * Throws a `TypeError` unless `value` is a plain object or an array.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is neither a plain object nor an array
 */
function assertContainer(caller: string, name: string, value: unknown): asserts value is object {
	if (!isContainer(value)) throw new TypeError(`${caller}: \`${name}\` must be a plain object or an array, got ${describe(value)}`);
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
	assertContainer('flattenObject', 'object', object);
	const result: Record<string, unknown> = {};
	flattenInto(object, Object.keys(object), '', separator, result, []);
	return result;
}

/**
 * Rebuilds a nested object from a flat record of paths (the inverse of {@link flattenObject}). Keys are processed in `Object.keys` order;
 * each one is split on `separator` and its value written like {@link setPath} does: a missing container is created as an array
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
	const arrayLimit = readOption(options, 'arrayLimit') ?? ARRAY_LIMIT;
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
 * Checks whether a dot-separated path exists in an object: it is `true` exactly when {@link getPath} resolves the path
 * to a property (whose value may be `undefined`) rather than falling back to the default value. Segments follow the same rule: own
 * and inherited properties count (class getters, a string's `length` and indices, `Object.create(proto)` parents), but a
 * `__proto__`, `constructor` or `prototype` segment never does, nor does an `Object.prototype` member the object does not own
 * (`toString`, keys added by prototype pollution...). Array elements are addressed with numeric segments (`'list.0'`).
 * @param {object} target - The object to inspect
 * @param {string} path - The dot-separated path, e.g. `'a.b.0'`
 * @returns {boolean} Whether every segment of the path resolves
 * @example
 * hasPath({ a: { b: [undefined] } }, 'a.b.0'); // => true
 * hasPath({ a: {} }, 'a.toString'); // => false // an Object.prototype member
 * hasPath({ a: {} }, 'a.constructor'); // => false
 * hasPath({ name: 'Ada' }, 'name.length'); // => true
 */
export function hasPath(target: object, path: string): boolean {
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
 * Like {@link setPath}, the path may not contain `__proto__`, `constructor` or `prototype` segments, so it cannot remove
 * a method shared by every instance of a class (`'Service.prototype.run'`).
 * @param {object} target - The object to modify
 * @param {string} path - The dot-separated path, e.g. `'a.b.0'`
 * @returns {boolean} `true` when an own property was found and deleted; `false` when the path does not exist or the property is non-configurable
 * @throws {RangeError} when the path has an empty segment (`''`, `'a..b'`, `'a.'`)
 * @throws {RangeError} when a segment is `__proto__`, `constructor` or `prototype`
 * @example
 * const config = { a: { b: 1, c: 2 } };
 * deletePath(config, 'a.b'); // => true
 * config; // => { a: { c: 2 } }
 * deletePath(config, 'a.x'); // => false
 * deletePath({ C: class {} }, 'C.prototype.m'); // throws RangeError
 */
export function deletePath(target: object, path: string): boolean {
	const segments = parseWritablePath('deletePath', '`path`', path, '.');
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
 * @param {DiffState} state - The containers on the current path, and the pairs already found identical
 * @returns {void}
 * @throws {TypeError} when a tree contains a circular reference
 */
function diffWalk(a: object, b: object, prefix: string, missing: string[], changed: string[] | undefined, state: DiffState): void {
	const { ancestors } = state;
	if (ancestors.has(a)) throw new TypeError('diff: cannot diff circular structures');
	if (state.same.get(a)?.has(b) === true) return;
	ancestors.add(a);
	const found = missing.length + (changed?.length ?? 0);
	const walked = ++state.walked;

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
			diffWalk(left, right, path + '.', missing, changed, state);
		} else if (changed !== undefined && !isEqual(left, right)) {
			changed.push(path);
		}
	}

	ancestors.delete(a);
	// A pair of containers shared by several paths (`{ l: node, r: node }` at every level) would otherwise be walked once per path: an
	// exponential number of times. A pair with no difference has none under any path, so the pairs with large subtrees are remembered.
	if (state.walked - walked > PROVEN_SUBTREE && missing.length + (changed?.length ?? 0) === found) {
		let pairs = state.same.get(a);
		if (pairs === undefined) state.same.set(a, (pairs = new WeakSet()));
		pairs.add(b);
	}
}

/** The state of one walk of {@link diffWalk}. */
interface DiffState {
	/** Containers of `a`'s tree on the current path (cycle detection: only `a`'s tree is checked, as the walk stops where `b` ends and
	 * {@link diff} walks each tree in turn). */
	readonly ancestors: Set<object>;
	/** Pairs of containers with a large subtree found identical. */
	readonly same: WeakMap<object, WeakSet<object>>;
	/** The number of container pairs walked so far. */
	walked: number;
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
	diffWalk(a, b, '', result.removed, result.changed, { ancestors: new Set(), same: new WeakMap(), walked: 0 });
	diffWalk(b, a, '', result.added, undefined, { ancestors: new Set(), same: new WeakMap(), walked: 0 });
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Structural sharing and JSON Patch
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether an object is a container that {@link replaceEqualDeep} and {@link createPatch} walk: a plain object (`Object.prototype` or
 * `null` prototype, not a thenable) or a dense array without other own keys.
 * @param {object} value - The object
 * @param {unknown} prototype - Its prototype
 * @returns {boolean} Whether its members are walked
 */
function isTree(value: object, prototype: unknown): boolean {
	if (prototype === null) return !isPromise(value) && getTag(value) === '[object Object]';
	return isOrdinary(value, prototype) && (!Array.isArray(value) || isSimpleArray(value));
}

/** The state of one {@link replaceEqualDeep} call. */
interface SharingState {
	/** The containers of `next` on the current path: meeting one again is a cycle. */
	readonly ancestors: Set<object>;
	/** The results of pairs with a large subtree, by `next` then `prev` container. */
	done: WeakMap<object, WeakMap<object, object>> | undefined;
	/** The number of container pairs walked so far. */
	visited: number;
}

/**
 * Recursive worker of {@link replaceEqualDeep}.
 * @param {unknown} prev - The previous value
 * @param {unknown} next - The new value
 * @param {SharingState} state - The state of the call
 * @returns {unknown} `next`, with its parts equal to those of `prev` replaced by them (`prev` itself when all are)
 */
function shareWith(prev: unknown, next: unknown, state: SharingState): unknown {
	if (Object.is(prev, next)) return prev;
	if (!isObject(prev) || !isObject(next)) return next;
	const prototype = Object.getPrototypeOf(next);
	if (Object.getPrototypeOf(prev) !== prototype) return next;
	if (!isTree(next, prototype) || !isTree(prev, prototype)) return isEqual(prev, next) ? prev : next;
	// A reference back to a container being processed (a cycle) is kept from `next`: its copy is not finished yet.
	if (state.ancestors.has(next)) return next;
	const known = state.done?.get(next)?.get(prev);
	if (known !== undefined) return known;

	const visited = ++state.visited;
	state.ancestors.add(next);
	const result = Array.isArray(next) ? shareItems(prev as unknown[], next, state) : shareMembers(prev, next, prototype, state);
	state.ancestors.delete(next);
	// A container shared by several paths (`{ l: node, r: node }` at every level) would otherwise be processed once per path: an
	// exponential number of times. Results are remembered for the pairs with large subtrees (every result is valid wherever its pair is).
	if (state.visited - visited > PROVEN_SUBTREE) {
		const done = (state.done ??= new WeakMap());
		let pairs = done.get(next);
		if (pairs === undefined) done.set(next, (pairs = new WeakMap()));
		pairs.set(prev, result);
	}
	return result;
}

/**
 * {@link shareWith} for two dense arrays.
 * @param {unknown[]} prev - The previous array
 * @param {unknown[]} next - The new array
 * @param {SharingState} state - The state of the call
 * @returns {unknown[]} `prev` when every item is shared, else a new array
 */
function shareItems(prev: unknown[], next: unknown[], state: SharingState): unknown[] {
	const length = next.length;
	const previousLength = prev.length;
	const items = new Array<unknown>(length);
	let same = length === previousLength;
	for (let index = 0; index < length; index++) {
		const before = index < previousLength ? prev[index] : undefined;
		const item = shareWith(before, next[index], state);
		items[index] = item;
		if (!Object.is(item, before)) same = false;
	}
	return same ? prev : items;
}

/**
 * {@link shareWith} for two plain objects with the same prototype.
 * @param {object} prev - The previous object
 * @param {object} next - The new object
 * @param {object | null} prototype - Their prototype (`Object.prototype` or `null`)
 * @param {SharingState} state - The state of the call
 * @returns {object} `prev` when it has the same keys and every value is shared, else a new object
 */
function shareMembers(prev: object, next: object, prototype: object | null, state: SharingState): object {
	const keys = ownEnumerableKeys(next);
	const values: unknown[] = [];
	// With as many keys on both sides, every key of `next` being one of `prev` makes the key sets equal.
	let same = keys.length === ownEnumerableKeys(prev).length;
	for (const key of keys) {
		const own = Object.prototype.propertyIsEnumerable.call(prev, key);
		const before = own ? (prev as Properties)[key] : undefined;
		const value = shareWith(before, (next as Properties)[key], state);
		values.push(value);
		if (!own || !Object.is(value, before)) same = false;
	}
	if (same) return prev;
	const result: object = prototype === null ? Object.create(null) : {};
	for (let index = 0; index < keys.length; index++) definePlain(result, keys[index], values[index]);
	return result;
}

/**
 * Structural sharing, as TanStack Query applies it to refetched data: returns `next`, except that every part of it deeply equal
 * ({@link isEqual}) to the part of `prev` at the same place is replaced by that part of `prev`, and `prev` itself is returned when
 * everything is equal (unless `next` is circular: see below). References to unchanged data therefore stay the same across updates, so
 * `React.memo`, `useMemo` dependencies and selectors only see what really changed.
 * - Plain objects (`Object.prototype` or `null` prototype) and dense arrays without extra keys are walked: a container is rebuilt (same
 *   prototype, `next`'s key order) when anything inside it changed, and is `prev`'s when nothing did (whatever the key order). Own
 *   enumerable string and symbol keys are compared; `next`'s values are read once (getters run once) and stored as data properties.
 * - Any other value (`Date`, `Map`, `Set`, class instance, sparse array...) is a leaf: `prev`'s when {@link isEqual}, else `next`'s.
 *   Primitives are compared with `Object.is` (`-0` stays `-0`).
 * - Inputs are never mutated. Keys are defined, never assigned, so a `'__proto__'` key stays an own property.
 * - Linear in the size of the plain objects and arrays of `next`, plus what {@link isEqual} costs on the leaves (`Map` and `Set`
 *   leaves holding objects compare in quadratic time): a part shared by several paths is processed once per pair of parts. A circular
 *   `next` is supported: a reference back to an enclosing container is kept from `next` as is, so the containers on the cycle are
 *   rebuilt and the result is not `prev` even when both are deeply equal.
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`.
 * @template T - The type of the new value
 * @param {unknown} prev - The previous value
 * @param {T} next - The new value
 * @returns {T} A value deeply equal to `next`, sharing every unchanged part with `prev`
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * const prev = { user: { name: 'Ada', tags: ['x'] }, count: 1 };
 * const next = replaceEqualDeep(prev, { user: { name: 'Ada', tags: ['x'] }, count: 2 });
 * next; // => { user: { name: 'Ada', tags: ['x'] }, count: 2 }
 * next.user === prev.user; // => true
 * replaceEqualDeep(prev, { count: 1, user: { tags: ['x'], name: 'Ada' } }) === prev; // => true
 * replaceEqualDeep([new Date(0), 1], [new Date(0), 2])[0]; // => new Date(0) // the Date of `prev`
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
	return shareWith(prev, next, { ancestors: new Set(), done: undefined, visited: 0 }) as T;
}

/**
 * A JSON Patch operation (RFC 6902). `path` and `from` are JSON Pointers (RFC 6901): `''` for the whole document, otherwise `/`
 * followed by the keys (or array indices) separated by `/`, with `~` written `~0` and `/` written `~1` inside a key.
 */
export type JsonPatchOperation =
	| { readonly op: 'add'; readonly path: string; readonly value: unknown }
	| { readonly op: 'remove'; readonly path: string }
	| { readonly op: 'replace'; readonly path: string; readonly value: unknown }
	| { readonly op: 'move'; readonly from: string; readonly path: string }
	| { readonly op: 'copy'; readonly from: string; readonly path: string }
	| { readonly op: 'test'; readonly path: string; readonly value: unknown };

/**
 * Error thrown by {@link applyPatch} when a well-formed operation cannot be applied to the document: a location that does not exist,
 * an array index out of bounds, a value that cannot be walked into, a failed `test`, a `move` into its own child, or a `remove` of the
 * whole document. A malformed operation throws a `TypeError` or a `RangeError` instead.
 * @example
 * try {
 *   applyPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]);
 * } catch (error) {
 *   error instanceof JsonPatchError; // => true
 *   (error as JsonPatchError).index; // => 0
 * }
 */
export class JsonPatchError extends Error {
	override name = 'JsonPatchError';
	/** The position of the failed operation in the patch. */
	readonly index: number;
	/** The failed operation. */
	readonly operation: JsonPatchOperation;

	/**
	 * @param {string} message - The error message
	 * @param {number} index - The position of the failed operation in the patch
	 * @param {JsonPatchOperation} operation - The failed operation
	 */
	constructor(message: string, index: number, operation: JsonPatchOperation) {
		super(message);
		this.index = index;
		this.operation = operation;
	}
}

/**
 * Escapes a key for a JSON Pointer: `~` becomes `~0` and `/` becomes `~1`.
 * @param {string} key - The key
 * @returns {string} The pointer segment
 */
function escapePointer(key: string): string {
	return key.includes('~') || key.includes('/') ? key.replace(/~/g, '~0').replace(/\//g, '~1') : key;
}

/** The state of one {@link createPatch} walk. */
interface PatchWalk {
	/** The containers of `a` and of `b` on the current path (cycle detection). */
	readonly ancestorsA: Set<object>;
	readonly ancestorsB: Set<object>;
	/** Pairs of containers with a large subtree found identical. */
	readonly same: WeakMap<object, WeakSet<object>>;
	/** The structural hashes computed so far (see {@link treeHash}). */
	readonly hashes: WeakMap<object, number>;
	/** The number of container pairs walked so far. */
	walked: number;
}

/**
 * Mixes a 32-bit value into a running hash (a multiply-xorshift step).
 * @param {number} running - The hash so far
 * @param {number} value - The value to mix in
 * @returns {number} The new hash
 */
function mixHash(running: number, value: number): number {
	const mixed = Math.imul(running ^ value, 0x9e3779b1);
	return mixed ^ (mixed >>> 15);
}

/**
 * Hashes a text (FNV-1a over its UTF-16 code units).
 * @param {string} text - The text
 * @param {number} seed - Tells kinds of values apart
 * @returns {number} The hash
 */
function textHash(text: string, seed: number): number {
	let code = 0x811c9dc5 ^ seed;
	for (let index = 0; index < text.length; index++) code = Math.imul(code ^ text.charCodeAt(index), 0x01000193);
	return code;
}

/**
 * A structural hash for {@link patchItems}: values that {@link isEqual} finds equal get equal hashes (so different hashes prove a
 * difference), and each object is hashed once per call, so comparing array items costs linear time overall. Plain objects and dense
 * arrays hash their members (object keys in any order, `undefined` members left out); any other object hashes its tag only, and an
 * object met again inside itself hashes as `0`. Equal hashes are confirmed with {@link patchEqual}.
 * @param {unknown} value - The value
 * @param {PatchWalk} state - The state of the walk (holds the hashes)
 * @returns {number} The hash
 */
function treeHash(value: unknown, state: PatchWalk): number {
	if (typeof value !== 'object' || value === null) {
		// `String` gives `0` for `-0` and `NaN` for every NaN, as `isEqual` compares them; a symbol or a function only hashes its type
		// (`String` would run a function's own `toString`). The seed tells the types apart (`'1'` from `1`).
		const type = typeof value;
		return textHash(type === 'symbol' || type === 'function' ? '' : String(value), type.length * 31 + type.charCodeAt(0));
	}
	const known = state.hashes.get(value);
	if (known !== undefined) return known;
	state.hashes.set(value, 0);
	const prototype = Object.getPrototypeOf(value);
	let code: number;
	if (!isTree(value, prototype)) code = textHash(getTag(value), 1);
	else if (Array.isArray(value)) {
		code = 2;
		for (let index = 0; index < value.length; index++) code = mixHash(code, treeHash(value[index], state));
	} else {
		// Members are summed, so that the order of the keys does not matter; an `undefined` member counts as absent (see `patchEqual`).
		let members = 0;
		for (const key of Object.keys(value)) {
			const member = (value as Properties)[key];
			if (member !== undefined) members = (members + mixHash(textHash(key, 3), treeHash(member, state))) | 0;
		}
		code = mixHash(prototype === null ? 4 : 5, members);
	}
	state.hashes.set(value, code);
	return code;
}

/**
 * The equality of {@link createPatch}: {@link isEqual}, except that a member of a plain object whose value is `undefined` counts as
 * absent, as in {@link patchMembers} (so that the patch is empty exactly when the values are equal).
 * @param {unknown} a - The old value
 * @param {unknown} b - The new value
 * @returns {boolean} Whether they are equal
 */
function patchEqual(a: unknown, b: unknown): boolean {
	const stack: ComparisonStack = [];
	stack.absentUndefined = true;
	return equalWith(a, b, stack);
}

/**
 * Whether two array items are deeply equal, for the trimming of {@link patchItems}.
 * @param {unknown} a - The old item
 * @param {unknown} b - The new item
 * @param {PatchWalk} state - The state of the walk
 * @returns {boolean} Whether they are equal
 */
function sameItem(a: unknown, b: unknown, state: PatchWalk): boolean {
	return a === b || (treeHash(a, state) === treeHash(b, state) && patchEqual(a, b));
}

/**
 * Recursive worker of {@link createPatch}: appends the operations turning `a` into `b`, at `path`.
 * @param {unknown} a - The old value
 * @param {unknown} b - The new value
 * @param {string} path - Their JSON Pointer
 * @param {JsonPatchOperation[]} operations - The patch being built (mutated)
 * @param {PatchWalk} state - The state of the walk
 * @returns {void}
 * @throws {TypeError} when a value contains a circular reference
 */
function patchWalk(a: unknown, b: unknown, path: string, operations: JsonPatchOperation[], state: PatchWalk): void {
	if (a === b) return;
	if (isObject(a) && isObject(b)) {
		const prototype = Object.getPrototypeOf(a);
		if (prototype === Object.getPrototypeOf(b) && isTree(a, prototype) && isTree(b, prototype)) {
			const { ancestorsA, ancestorsB } = state;
			if (ancestorsA.has(a) || ancestorsB.has(b)) throw new TypeError('createPatch: cannot diff circular structures');
			if (state.same.get(a)?.has(b) === true) return;
			ancestorsA.add(a);
			ancestorsB.add(b);
			const found = operations.length;
			const walked = ++state.walked;
			if (Array.isArray(a)) patchItems(a, b as unknown[], path, operations, state);
			else patchMembers(a, b, path, operations, state);
			ancestorsA.delete(a);
			ancestorsB.delete(b);
			// A pair shared by several paths would otherwise be walked once per path (see `diff`): equal pairs with large subtrees are remembered.
			if (state.walked - walked > PROVEN_SUBTREE && operations.length === found) {
				let pairs = state.same.get(a);
				if (pairs === undefined) state.same.set(a, (pairs = new WeakSet()));
				pairs.add(b);
			}
			return;
		}
	}
	if (!patchEqual(a, b)) operations.push({ op: 'replace', path, value: b });
}

/**
 * {@link patchWalk} for two plain objects: removals and changes in the key order of `a`, then additions in the key order of `b`. A
 * member whose value is `undefined` counts as absent, as in JSON. Each value is read once.
 * @param {object} a - The old object
 * @param {object} b - The new object
 * @param {string} path - Their JSON Pointer
 * @param {JsonPatchOperation[]} operations - The patch being built (mutated)
 * @param {PatchWalk} state - The state of the walk
 * @returns {void}
 */
function patchMembers(a: object, b: object, path: string, operations: JsonPatchOperation[], state: PatchWalk): void {
	// The keys with a value on `a`'s side: `b`'s value was read (and handled) with them.
	const present = new Set<string>();
	for (const key of Object.keys(a)) {
		const before = (a as Properties)[key];
		if (before === undefined) continue;
		present.add(key);
		const location = path + '/' + escapePointer(key);
		const after = Object.prototype.propertyIsEnumerable.call(b, key) ? (b as Properties)[key] : undefined;
		if (after === undefined) operations.push({ op: 'remove', path: location });
		else patchWalk(before, after, location, operations, state);
	}
	for (const key of Object.keys(b)) {
		if (present.has(key)) continue;
		const value = (b as Properties)[key];
		if (value !== undefined) operations.push({ op: 'add', path: path + '/' + escapePointer(key), value });
	}
}

/**
 * {@link patchWalk} for two dense arrays. When their lengths differ, the common prefix and suffix (deeply equal items, told apart by
 * their {@link treeHash} first) are skipped, so inserting or removing items anywhere in one run gives just those `add` or `remove`
 * operations; the items in between are diffed by index, then the extra items of `a` are removed (from the last) or those of `b` added.
 * With equal lengths, trimming would give the same operations as diffing every index.
 * @param {unknown[]} a - The old array
 * @param {unknown[]} b - The new array
 * @param {string} path - Their JSON Pointer
 * @param {JsonPatchOperation[]} operations - The patch being built (mutated)
 * @param {PatchWalk} state - The state of the walk
 * @returns {void}
 */
function patchItems(a: unknown[], b: unknown[], path: string, operations: JsonPatchOperation[], state: PatchWalk): void {
	let start = 0;
	let endA = a.length;
	let endB = b.length;
	if (endA !== endB) {
		while (start < endA && start < endB && sameItem(a[start], b[start], state)) start++;
		while (endA > start && endB > start && sameItem(a[endA - 1], b[endB - 1], state)) {
			endA--;
			endB--;
		}
	}
	const common = Math.min(endA, endB);
	for (let index = start; index < common; index++) patchWalk(a[index], b[index], path + '/' + index, operations, state);
	for (let index = endA - 1; index >= common; index--) operations.push({ op: 'remove', path: path + '/' + index });
	for (let index = common; index < endB; index++) operations.push({ op: 'add', path: path + '/' + index, value: b[index] });
}

/**
 * Computes a JSON Patch (RFC 6902) that turns `a` into `b`: `applyPatch(a, createPatch(a, b))` is deeply equal to `b` for JSON values
 * (up to `undefined` object members, see below).
 * - Plain objects and dense arrays are walked like {@link replaceEqualDeep} does: object members are removed (in `a`'s key order),
 *   diffed, then added (in `b`'s key order). Arrays skip their common prefix and suffix, so inserting or removing ONE run of items
 *   (at the end, at the start or in between) gives one operation per item instead of rewriting every shifted index; the other items
 *   are diffed by index (finding the fewest operations for any edit needs quadratic time). Every other change is a `replace`.
 * - Values are compared with {@link isEqual} (but see `undefined` members below); other values than plain objects and dense arrays
 *   (dates, maps, class instances, sparse arrays...) are leaves, replaced whole. Only own enumerable string keys are diffed (JSON has no symbol keys).
 * - An object member whose value is `undefined` counts as absent, as `JSON.stringify` drops it: one becoming `undefined` is removed,
 *   and one added or kept as `undefined` gives no operation (in array items and in leaves too: `[{ id: 1, note: undefined }]` and
 *   `[{ id: 1 }]` are equal, so inserting an item before it still gives one `add`). An `undefined` array item is kept as it is: its operation has an
 *   `undefined` `value`, which `JSON.stringify` drops (it writes `null` for the item of an array), so serialize such data as JSON first.
 * - Only `add`, `remove` and `replace` are emitted: detecting `move` and `copy` would cost quadratic time for rarely shorter patches.
 * - The `value` of an operation is the value in `b`, NOT a copy: clone it before mutating either.
 * - Linear in the size of the plain objects and arrays, plus what {@link isEqual} costs on the leaves (`Map` and `Set` leaves holding
 *   objects compare in quadratic time): array items are told apart by structural hashes computed once per object. A shared part is
 *   walked once per pair of parts when it has no changes, but a changed part reached through several paths appears in the patch once
 *   per path (a patch has no references).
 *
 * Recursion depth is bounded by the call stack (~thousands of levels): deeper input throws a `RangeError`.
 * @param {unknown} a - The old value
 * @param {unknown} b - The new value
 * @returns {JsonPatchOperation[]} The operations (empty when the values are equal)
 * @throws {TypeError} when a walked container is circular
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * createPatch({ a: 1, b: { c: 2 } }, { b: { c: 3 }, d: [1] }); // => [{ op: 'remove', path: '/a' }, { op: 'replace', path: '/b/c', value: 3 }, { op: 'add', path: '/d', value: [1] }]
 * createPatch([1, 2, 3], [0, 1, 2, 3]); // => [{ op: 'add', path: '/0', value: 0 }]
 * createPatch(['a', 'b', 'c', 'd'], ['a', 'd']); // => [{ op: 'remove', path: '/2' }, { op: 'remove', path: '/1' }]
 * createPatch({ 'a/b': 1 }, { 'a/b': 2 }); // => [{ op: 'replace', path: '/a~1b', value: 2 }]
 * createPatch(1, 'x'); // => [{ op: 'replace', path: '', value: 'x' }]
 */
export function createPatch(a: unknown, b: unknown): JsonPatchOperation[] {
	const operations: JsonPatchOperation[] = [];
	patchWalk(a, b, '', operations, { ancestorsA: new Set(), ancestorsB: new Set(), same: new WeakMap(), hashes: new WeakMap(), walked: 0 });
	return operations;
}

/** The operations {@link applyPatch} supports. */
const PATCH_OPERATIONS: ReadonlySet<unknown> = new Set(['add', 'remove', 'replace', 'move', 'copy', 'test']);

/** The state of one {@link applyPatch} call. */
interface PatchState {
	/** The document so far. */
	root: unknown;
	/** The containers this call created (copies of the document's), which it may modify in place: each is reachable through one path. */
	owned: Set<object>;
	/** The position of the current operation. */
	index: number;
	/** The current operation. */
	operation: JsonPatchOperation;
	/** Its `op` and `path`, as read once, for error messages. */
	op: string;
	pointer: string;
}

/**
 * Throws the {@link JsonPatchError} of the current operation.
 * @param {PatchState} state - The state of the call
 * @param {string} problem - What went wrong
 * @returns {never} Never returns
 * @throws {JsonPatchError} always
 */
function patchFailure(state: PatchState, problem: string): never {
	throw new JsonPatchError(
		`applyPatch: \`operations[${state.index}]\` (${state.op} ${JSON.stringify(state.pointer)}) cannot be applied: ${problem}`,
		state.index,
		state.operation
	);
}

/**
 * Whether a path starts with another one (or is the same).
 * @param {ReadonlyArray<string>} prefix - The shorter path
 * @param {ReadonlyArray<string>} path - The path
 * @returns {boolean} Whether every segment of `prefix` starts `path`
 */
function startsWithPath(prefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every(function (segment: string, position: number): boolean {
			return segment === path[position];
		})
	);
}

/**
 * The JSON Pointer of the first `count` segments, for error messages.
 * @param {ReadonlyArray<string>} segments - The segments
 * @param {number} count - How many to keep
 * @returns {string} The pointer, quoted
 */
function pointerTo(segments: ReadonlyArray<string>, count: number): string {
	return JSON.stringify(
		segments
			.slice(0, count)
			.map(function (segment: string): string {
				return '/' + escapePointer(segment);
			})
			.join('')
	);
}

/**
 * Parses a JSON Pointer of an operation.
 * @param {number} index - The position of the operation, for error messages
 * @param {string} field - `'path'` or `'from'`, for error messages
 * @param {unknown} pointer - The pointer
 * @returns {string[]} The unescaped segments (`[]` for the whole document)
 * @throws {TypeError} when the pointer is not a string
 * @throws {RangeError} when it does not start with `/` (and is not empty), or has a `~` not followed by `0` or `1`
 */
function parsePointer(index: number, field: string, pointer: unknown): string[] {
	if (typeof pointer !== 'string') throw new TypeError(`applyPatch: \`operations[${index}].${field}\` must be a string, got ${describe(pointer)}`);
	if (pointer === '') return [];
	if (pointer[0] !== '/' || /~(?![01])/.test(pointer)) {
		throw new RangeError(
			`applyPatch: \`operations[${index}].${field}\` must be a JSON Pointer ('' or '/' followed by keys, with '~' escaped as '~0' and '/' as '~1'), got ${JSON.stringify(pointer)}`
		);
	}
	const segments = pointer.slice(1).split('/');
	// `~1` first: `~01` is the key `~1`, not `/`.
	if (pointer.includes('~')) for (let position = 0; position < segments.length; position++) segments[position] = segments[position].replace(/~1/g, '/').replace(/~0/g, '~');
	return segments;
}

/**
 * The array index a segment designates.
 * @param {PatchState} state - The state of the call
 * @param {unknown[]} array - The array
 * @param {ReadonlyArray<string>} segments - The path
 * @param {number} position - The position of the segment in the path
 * @param {boolean} insert - Whether the index is an insertion point (`-` and the length are then valid)
 * @returns {number} The index
 * @throws {JsonPatchError} when the segment is not a canonical index, or is out of bounds
 */
function arrayIndex(state: PatchState, array: unknown[], segments: ReadonlyArray<string>, position: number, insert: boolean): number {
	const segment = segments[position];
	const length = array.length;
	if (segment === '-' && insert) return length;
	if (!CANONICAL_INDEX.test(segment)) patchFailure(state, `${pointerTo(segments, position + 1)} is not an array index`);
	const index = Number(segment);
	if (index > length || (index === length && !insert)) patchFailure(state, `${pointerTo(segments, position + 1)} is out of bounds (length ${length})`);
	return index;
}

/**
 * Reads the member of a container designated by a segment, which must exist.
 * @param {PatchState} state - The state of the call
 * @param {unknown} container - The value at the first `position` segments
 * @param {ReadonlyArray<string>} segments - The path
 * @param {number} position - The position of the segment in the path
 * @returns {unknown} The member
 * @throws {JsonPatchError} when `container` is not a plain object or an array, or has no such member
 */
function memberOf(state: PatchState, container: unknown, segments: ReadonlyArray<string>, position: number): unknown {
	if (Array.isArray(container)) {
		const index = arrayIndex(state, container, segments, position, false);
		// Own elements only: a hole must not read a value from a polluted `Array.prototype`.
		return hasOwn(container, index) ? container[index] : undefined;
	}
	if (!isPlainObject(container)) patchFailure(state, `${pointerTo(segments, position)} is not an object or an array`);
	// Own members only: `__proto__`, `constructor` or `toString` never reach a prototype.
	if (!hasOwn(container, segments[position])) patchFailure(state, `${pointerTo(segments, position + 1)} does not exist`);
	return container[segments[position]];
}

/**
 * Reads the value at a path, which must exist.
 * @param {PatchState} state - The state of the call
 * @param {ReadonlyArray<string>} segments - The path
 * @returns {unknown} The value
 * @throws {JsonPatchError} when the path does not exist
 */
function valueAt(state: PatchState, segments: ReadonlyArray<string>): unknown {
	let current = state.root;
	for (let position = 0; position < segments.length; position++) current = memberOf(state, current, segments, position);
	return current;
}

/**
 * Returns a container this call may modify in place: `value` itself when the call created it, else a shallow copy (same prototype).
 * @param {PatchState} state - The state of the call
 * @param {unknown} value - The value at the first `count` segments
 * @param {ReadonlyArray<string>} segments - The path
 * @param {number} count - How many segments lead to `value`
 * @returns {object} The modifiable container
 * @throws {JsonPatchError} when `value` is not a plain object or an array
 */
function ownContainer(state: PatchState, value: unknown, segments: ReadonlyArray<string>, count: number): object {
	if (!isContainer(value)) patchFailure(state, `${pointerTo(segments, count)} is not an object or an array`);
	if (state.owned.has(value)) return value;
	const copy = copyContainer(value);
	// Holes become `undefined` (JSON has none): shifting items over a hole would read it through `Array.prototype`, maybe polluted.
	if (Array.isArray(copy)) for (let index = 0; index < copy.length; index++) if (!hasOwn(copy, index)) defineOwn(copy, index, undefined);
	state.owned.add(copy);
	return copy;
}

/**
 * Returns the parent of the location at a (non-empty) path, made modifiable: the containers on the way are copied (once per call), so
 * the document itself is never modified.
 * @param {PatchState} state - The state of the call
 * @param {ReadonlyArray<string>} segments - The path
 * @returns {object} The modifiable parent
 * @throws {JsonPatchError} when the parent does not exist or is not a plain object or an array
 */
function writableParent(state: PatchState, segments: ReadonlyArray<string>): object {
	let container = (state.root = ownContainer(state, state.root, segments, 0));
	for (let position = 0; position < segments.length - 1; position++) {
		const member = memberOf(state, container, segments, position);
		const copy = ownContainer(state, member, segments, position + 1);
		// The container is a copy made by this call: its key is an own, writable data property.
		if (copy !== member) (container as Properties)[segments[position]] = copy;
		container = copy;
	}
	return container;
}

/**
 * Applies `add`: inserts into an array (shifting the next items), or sets an object member (replacing it).
 * @param {PatchState} state - The state of the call
 * @param {ReadonlyArray<string>} segments - The path
 * @param {unknown} value - The value
 * @returns {void}
 * @throws {JsonPatchError} when the parent does not exist, or the index is out of bounds
 */
function addAt(state: PatchState, segments: ReadonlyArray<string>, value: unknown): void {
	if (segments.length === 0) {
		state.root = value;
		return;
	}
	const parent = writableParent(state, segments);
	const last = segments.length - 1;
	if (Array.isArray(parent)) {
		const index = arrayIndex(state, parent, segments, last, true);
		const items = parent as unknown[];
		// A plain loop shifts the items in place, without `splice`'s call to a subclass constructor (`Symbol.species`) nor a method a
		// subclass overrides: the array has no holes (see `ownContainer`) and the new last slot is defined first, so every slot read or
		// assigned is an own writable data property, and nothing goes through the prototype (no setter, no polluted index).
		defineOwn(items, items.length, undefined);
		for (let slot = items.length - 1; slot > index; slot--) items[slot] = items[slot - 1];
		defineOwn(items, index, value);
	} else defineOwn(parent, segments[last], value);
}

/**
 * Applies `remove`, or `replace` when `value` is given: the location must exist.
 * @param {PatchState} state - The state of the call
 * @param {ReadonlyArray<string>} segments - The path
 * @param {[unknown]} [replacement] - The new value, for `replace`
 * @returns {void}
 * @throws {JsonPatchError} when the location does not exist (or, for `remove`, is the whole document)
 */
function changeAt(state: PatchState, segments: ReadonlyArray<string>, replacement?: [unknown]): void {
	if (segments.length === 0) {
		if (replacement === undefined) patchFailure(state, 'the whole document cannot be removed');
		state.root = replacement[0];
		return;
	}
	const parent = writableParent(state, segments);
	const last = segments.length - 1;
	// Checks that the location exists, whatever the container.
	memberOf(state, parent, segments, last);
	const key = Array.isArray(parent) ? Number(segments[last]) : segments[last];
	if (replacement !== undefined) defineOwn(parent, key, replacement[0]);
	else if (typeof key === 'number') {
		// Every slot is an own writable data property (see `addAt`).
		const items = parent as unknown[];
		const end = items.length - 1;
		for (let slot = key; slot < end; slot++) items[slot] = items[slot + 1];
		items.length = end;
	} else delete (parent as Properties)[key];
}

/**
 * Reads a field of a patch operation, which must be an own property (`undefined` otherwise).
 * @param {object} operation - The operation
 * @param {string} field - The field
 * @returns {unknown} Its value
 */
function ownField(operation: object, field: string): unknown {
	return hasOwn(operation, field) ? (operation as Properties)[field] : undefined;
}

/**
 * The comparison of the `test` operation: {@link isEqual}, except that a `null`-prototype plain object equals an `Object.prototype`
 * one with the same members, and a member whose value is `undefined` counts as absent (RFC 6902 compares JSON values, which have no
 * prototype and no `undefined`).
 * @param {unknown} a - The value in the document
 * @param {unknown} b - The expected value
 * @returns {boolean} Whether they are equal
 */
function jsonEqual(a: unknown, b: unknown): boolean {
	const stack: ComparisonStack = [];
	stack.json = true;
	stack.absentUndefined = true;
	return equalWith(a, b, stack);
}

/**
 * Applies a JSON Patch (RFC 6902) to a document and returns the NEW document: the input is never modified, and the parts of it that the
 * patch does not touch are shared with the result (only the plain objects and arrays on the changed paths are copied, once per call).
 * - All or nothing: when an operation fails, an error is thrown and no document is returned (the input is left as it was anyway).
 * - Supports `add` (an array index inserts, `-` appends; an object member is set), `remove`, `replace`, `move` (the location must not
 *   be inside `from`), `copy` and `test` (deep equality, {@link isEqual}, except that plain objects compare their members as JSON does:
 *   whatever their prototype, `null` or `Object.prototype`, and leaving out those whose value is `undefined`, so that `{ x: 1, y:
 *   undefined }` passes a test for `{ x: 1 }`, as {@link createPatch} finds them equal). Operations apply in order, each to the result
 *   of the previous.
 * - The operations and their fields (`op`, `path`, `from`, `value`) are read as own properties only, never through a prototype: a
 *   hole in `operations` is not an object, and an inherited `value` is a missing one.
 * - JSON Pointers follow RFC 6901: `''` is the whole document, `~1` is `/` and `~0` is `~` inside a key; array indices are canonical
 *   (`0`, `12`, not `01` or `+1`) and within bounds.
 * - Only plain objects and arrays are walked, through their OWN members: `__proto__`, `constructor` and `prototype` are ordinary member
 *   names (defined, never assigned), and never reach a prototype.
 * - Values are inserted as given (not copied): a later operation writing inside one copies it first, as it does the document's parts.
 *   `copy` shares the copied value between both locations the same way. In an array an operation modifies, holes become `undefined`
 *   (JSON has no holes, and they would otherwise be read through `Array.prototype`).
 * @template T - The document type (the patch is assumed to keep it)
 * @param {T} document - The document
 * @param {ReadonlyArray<JsonPatchOperation>} operations - The patch
 * @returns {T} The patched document
 * @throws {TypeError} when `operations` is not an array, an operation is not an object, `path` or `from` is not a string, or `value` is
 *   missing from an `add`, `replace` or `test`
 * @throws {RangeError} when `op` is unknown, or a pointer is malformed
 * @throws {JsonPatchError} when an operation cannot be applied (see {@link JsonPatchError})
 * @example
 * const doc = { user: { name: 'Ada' }, tags: ['a'], meta: { v: 1 } };
 * const next = applyPatch(doc, [
 *   { op: 'replace', path: '/user/name', value: 'Grace' },
 *   { op: 'add', path: '/tags/-', value: 'b' }
 * ]);
 * next; // => { user: { name: 'Grace' }, tags: ['a', 'b'], meta: { v: 1 } }
 * doc.user.name; // => 'Ada'
 * next.meta === doc.meta; // => true
 * applyPatch(doc, [{ op: 'move', from: '/tags/0', path: '/first' }]); // => { user: { name: 'Ada' }, tags: [], meta: { v: 1 }, first: 'a' }
 * applyPatch(doc, [{ op: 'test', path: '/meta/v', value: 2 }]); // throws JsonPatchError
 * applyPatch(doc, [{ op: 'remove', path: '/tags/01' }]); // throws JsonPatchError
 */
export function applyPatch<T>(document: T, operations: ReadonlyArray<JsonPatchOperation>): T {
	if (!Array.isArray(operations)) throw new TypeError(`applyPatch: \`operations\` must be an array, got ${describe(operations)}`);
	const length = operations.length;
	const state: PatchState = { root: document, owned: new Set(), index: 0, operation: undefined as unknown as JsonPatchOperation, op: '', pointer: '' };

	for (let index = 0; index < length; index++) {
		// Own items and fields only: a hole or a missing field must not be read from a polluted `Array.prototype` or `Object.prototype`.
		const operation: unknown = hasOwn(operations, index) ? operations[index] : undefined;
		if (typeof operation !== 'object' || operation === null) throw new TypeError(`applyPatch: \`operations[${index}]\` must be an object, got ${describe(operation)}`);
		// Each field is read once (a getter could change its answer).
		const op = ownField(operation, 'op');
		const pointer = ownField(operation, 'path');
		if (!PATCH_OPERATIONS.has(op)) {
			if (typeof op !== 'string') throw new TypeError(`applyPatch: \`operations[${index}].op\` must be a string, got ${describe(op)}`);
			throw new RangeError(`applyPatch: \`operations[${index}].op\` must be 'add', 'remove', 'replace', 'move', 'copy' or 'test', got ${JSON.stringify(op)}`);
		}
		const path = parsePointer(index, 'path', pointer);
		state.index = index;
		state.operation = operation as JsonPatchOperation;
		state.op = op as string;
		state.pointer = pointer as string;

		if (op === 'move' || op === 'copy') {
			const from = parsePointer(index, 'from', ownField(operation, 'from'));
			const value = valueAt(state, from);
			if (op === 'copy') {
				// The copied container is about to have two locations (one of them maybe inside itself): none of the containers this call
				// created may be modified in place any more.
				if (state.owned.has(value as object)) state.owned = new Set();
				addAt(state, path, value);
			} else if (!(from.length === path.length && startsWithPath(from, path))) {
				if (startsWithPath(from, path)) patchFailure(state, `${pointerTo(from, from.length)} cannot be moved inside itself`);
				changeAt(state, from);
				addAt(state, path, value);
			}
			continue;
		}

		if (op === 'remove') {
			changeAt(state, path);
			continue;
		}

		if (!hasOwn(operation, 'value')) throw new TypeError(`applyPatch: \`operations[${index}]\` must have a \`value\` for '${op as string}'`);
		const value = (operation as Properties).value;
		if (op === 'add') addAt(state, path, value);
		else if (op === 'replace') changeAt(state, path, [value]);
		else if (!jsonEqual(valueAt(state, path), value)) patchFailure(state, 'the value is not equal to the expected one');
	}

	return state.root as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Key and entry helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The keys of `T` whose value type can be `S` (for the narrowing overloads of {@link findKey} and {@link findEntry}).
 */
type KeysMatching<T, S> = StringKeyOf<{ [K in keyof T as [S & T[K]] extends [never] ? never : K]: T[K] }>;

/**
 * Returns the first own enumerable string key (in `Object.keys` order) whose value satisfies `predicate`. With a type-guard predicate,
 * the result is narrowed to the keys whose value type can match.
 * @template T - The object type
 * @template S - The type the predicate narrows to
 * @param {T} object - The object to search
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => value is S} predicate - The type guard
 * @returns {KeysMatching<T, S> | undefined} The first matching key, or `undefined`
 * @example
 * findKey({ a: 'x', b: 2 } as { a: string; b: number }, function (value): value is number { return typeof value === 'number'; }); // => 'b' // typed as 'b' | undefined
 */
export function findKey<T extends object, S extends T[keyof T]>(
	object: T,
	predicate: (value: T[keyof T], key: StringKeyOf<T>, object: T) => value is S
): KeysMatching<T, S> | undefined;
/**
 * Returns the first own enumerable string key (in `Object.keys` order: integer-like keys first, then insertion order) whose value
 * satisfies `predicate`. Symbol keys and inherited properties are not searched.
 * @template T - The object type
 * @param {T} object - The object to search
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => unknown} predicate - Called with each value, its key and the object
 * @returns {StringKeyOf<T> | undefined} The first matching key, or `undefined`
 * @example
 * findKey({ ada: { age: 36 }, alan: { age: 41 } }, function (user) { return user.age > 40; }); // => 'alan'
 * findKey({ a: 1 }, function (value) { return value > 5; }); // => undefined
 */
export function findKey<T extends object>(object: T, predicate: (value: T[keyof T], key: StringKeyOf<T>, object: T) => unknown): StringKeyOf<T> | undefined;
/**
 * Implementation of {@link findKey}.
 * @param {object} object - The object to search
 * @param {Function} predicate - The test
 * @returns {string | undefined} The first matching key
 * @throws {TypeError} when `predicate` is not a function
 */
export function findKey(object: object, predicate: (value: unknown, key: string, object: object) => unknown): string | undefined {
	return findEntryWith('findKey', object, predicate)?.[0];
}

/**
 * Returns the first `[key, value]` own enumerable string-keyed entry whose value satisfies a type-guard `predicate`, narrowed.
 * @template T - The object type
 * @template S - The type the predicate narrows to
 * @param {T} object - The object to search
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => value is S} predicate - The type guard
 * @returns {[KeysMatching<T, S>, S] | undefined} The first matching entry, or `undefined`
 * @example
 * findEntry({ a: 'x', b: 2 } as { a: string; b: number }, function (value): value is number { return typeof value === 'number'; }); // => ['b', 2]
 */
export function findEntry<T extends object, S extends T[keyof T]>(
	object: T,
	predicate: (value: T[keyof T], key: StringKeyOf<T>, object: T) => value is S
): [KeysMatching<T, S>, S] | undefined;
/**
 * Returns the first `[key, value]` entry (own enumerable string keys, in `Object.keys` order) whose value satisfies `predicate`.
 * @template T - The object type
 * @param {T} object - The object to search
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => unknown} predicate - Called with each value, its key and the object
 * @returns {EntryOf<T> | undefined} The first matching entry, or `undefined`
 * @example
 * findEntry({ a: 1, b: 2, c: 3 }, function (value) { return value > 1; }); // => ['b', 2]
 */
export function findEntry<T extends object>(object: T, predicate: (value: T[keyof T], key: StringKeyOf<T>, object: T) => unknown): EntryOf<T> | undefined;
/**
 * Implementation of {@link findEntry}.
 * @param {object} object - The object to search
 * @param {Function} predicate - The test
 * @returns {[string, unknown] | undefined} The first matching entry
 * @throws {TypeError} when `predicate` is not a function
 */
export function findEntry(object: object, predicate: (value: unknown, key: string, object: object) => unknown): [string, unknown] | undefined {
	return findEntryWith('findEntry', object, predicate);
}

/**
 * Shared body of {@link findKey} and {@link findEntry}.
 * @param {string} caller - Name of the public function, for error messages
 * @param {object} object - The object to search
 * @param {Function} predicate - The test
 * @returns {[string, unknown] | undefined} The first matching entry
 * @throws {TypeError} when `predicate` is not a function
 */
function findEntryWith(caller: string, object: object, predicate: (value: unknown, key: string, object: object) => unknown): [string, unknown] | undefined {
	assertFunction(caller, 'predicate', predicate);
	for (const key of Object.keys(object)) {
		const value = (object as Properties)[key];
		if (predicate(value, key, object)) return [key, value];
	}
	return undefined;
}

/**
 * Creates a new object by mapping every own enumerable string-keyed entry (in `Object.keys` order) to a new `[key, value]` pair.
 * When two entries produce the same key, the last one wins. Keys are DEFINED, never assigned: a `'__proto__'` key becomes a plain own
 * property (no prototype change).
 * @template T - The object type
 * @template K - The new key type
 * @template V - The new value type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => readonly [K, V]} fn - Returns the new `[key, value]` pair
 * @returns {Record<K, V>} A new object
 * @example
 * mapEntries({ a: 1, b: 2 }, function (value, key) { return [key.toUpperCase(), value * 10]; }); // => { A: 10, B: 20 }
 */
export function mapEntries<T extends object, K extends PropertyKey, V>(object: T, fn: (value: T[keyof T], key: StringKeyOf<T>, object: T) => readonly [K, V]): Record<K, V>;
/**
 * Creates a new object by mapping every own enumerable string-keyed entry (in `Object.keys` order) to a new `[key, value]` pair, or
 * dropping it when `fn` returns `undefined`; same rules as the first overload.
 * @template T - The object type
 * @template K - The new key type
 * @template V - The new value type
 * @param {T} object - The source object
 * @param {(value: T[keyof T], key: StringKeyOf<T>, object: T) => readonly [K, V] | undefined} fn - Returns the new `[key, value]` pair, or `undefined` to drop the entry
 * @returns {Partial<Record<K, V>>} A new object
 * @example
 * mapEntries({ a: 1, b: -1 }, function (value, key) { return value > 0 ? [key, value] : undefined; }); // => { a: 1 }
 */
export function mapEntries<T extends object, K extends PropertyKey, V>(
	object: T,
	fn: (value: T[keyof T], key: StringKeyOf<T>, object: T) => readonly [K, V] | undefined
): Partial<Record<K, V>>;
/**
 * Implementation of {@link mapEntries}.
 * @param {object} object - The source object
 * @param {Function} fn - Maps an entry
 * @returns {object} The new object
 * @throws {TypeError} when `fn` is not a function, or returns something other than `undefined` or a `[key, value]` array whose key is a string, number or symbol
 */
export function mapEntries(object: object, fn: (value: unknown, key: string, object: object) => unknown): object {
	assertFunction('mapEntries', 'fn', fn);
	const result = {};
	for (const key of Object.keys(object)) {
		const entry = fn((object as Properties)[key], key, object);
		if (entry === undefined) continue;
		const newKey: unknown = Array.isArray(entry) ? entry[0] : undefined;
		if (typeof newKey !== 'string' && typeof newKey !== 'number' && typeof newKey !== 'symbol') {
			throw new TypeError(`mapEntries: \`fn\` must return undefined or a [key, value] array with a string, number or symbol key, got ${describe(entry)} for "${key}"`);
		}
		definePlain(result, newKey, (entry as unknown[])[1]);
	}
	return result;
}

/**
 * Options of {@link sortKeys}.
 */
export interface SortKeysOptions {
	/** Whether nested plain objects (also inside arrays) are sorted too (default `false`). */
	deep?: boolean;
	/** Orders two string keys (like an `Array.prototype.sort` comparator). Defaults to UTF-16 code unit order. */
	compare?: (a: string, b: string) => number;
}

/**
 * Recursive worker of {@link sortKeys}.
 * @param {unknown} value - The value to copy
 * @param {((a: string, b: string) => number) | undefined} compare - The key comparator
 * @param {object[] | undefined} ancestors - For a deep sort, the containers on the current path (cycle detection); `undefined` for a shallow one
 * @returns {unknown} The copy with sorted keys (other values as they are)
 * @throws {TypeError} when a deep sort meets a circular reference
 */
function sortKeysWith(value: unknown, compare: ((a: string, b: string) => number) | undefined, ancestors: object[] | undefined): unknown {
	if (!isContainer(value)) return value;
	if (ancestors?.includes(value)) throw new TypeError('sortKeys: cannot sort a circular structure');
	ancestors?.push(value);
	let result: object;
	if (Array.isArray(value)) {
		const copy = new Array<unknown>(value.length);
		for (const index of presentIndexes(value)) copy[index] = ancestors ? sortKeysWith(value[index], compare, ancestors) : value[index];
		result = copy;
	} else {
		result = emptyLike(value);
		for (const key of appendSymbols(value, Object.keys(value).sort(compare))) {
			const child = (value as Properties)[key];
			definePlain(result, key, ancestors ? sortKeysWith(child, compare, ancestors) : child);
		}
	}
	ancestors?.pop();
	return result;
}

/**
 * Returns a copy of a plain object (or an array) whose own enumerable string keys are inserted in sorted order, for stable output and
 * readable diffs. Symbol keys follow, in their original order. With `deep`, plain objects nested in plain objects and arrays are sorted
 * too (other objects, such as dates, maps and class instances, are kept by reference); array items keep their order.
 * - JavaScript always enumerates INTEGER-LIKE keys (`'0'`, `'42'`, up to 2³² - 2) first, in ascending numeric order, whatever the
 *   insertion order: no comparator can move them after other keys (`sortKeys({ b: 1, 2: 1, a: 1, 10: 1 })` lists `2, 10, a, b`).
 * - Keys are DEFINED, never assigned: a `'__proto__'` key stays a plain own property. Plain objects keep their prototype (`null` too).
 * @template T - The object type
 * @param {T} object - The plain object or array to copy
 * @param {SortKeysOptions} [options={}] - `deep` (default `false`) and `compare` (default: UTF-16 code unit order)
 * @returns {T} The sorted copy
 * @throws {TypeError} when `object` is not a plain object or an array, or `compare` is not a function
 * @throws {TypeError} when a deep sort meets a circular reference
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * Object.keys(sortKeys({ b: 1, c: 2, a: 3 })); // => ['a', 'b', 'c']
 * JSON.stringify(sortKeys({ b: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }, { deep: true })); // => '{"a":[{"c":2,"d":1}],"b":{"x":2,"y":1}}'
 * Object.keys(sortKeys({ a: 1, b: 2 }, { compare: function (x, y) { return y.localeCompare(x); } })); // => ['b', 'a']
 */
export function sortKeys<T extends object>(object: T, options: SortKeysOptions = {}): T {
	assertContainer('sortKeys', 'object', object);
	const compare = readOption(options, 'compare');
	const deep = readOption(options, 'deep');
	if (compare !== undefined) assertFunction('sortKeys', 'compare', compare);
	return sortKeysWith(object, compare, deep === true ? [] : undefined) as T;
}

/**
 * The transforms accepted by {@link evolve} for `T`: for any key, a function of its value, or (for an object value) nested transforms.
 */
export type Evolver<T> = {
	[K in keyof T]?: ((value: T[K]) => unknown) | (NonNullable<T[K]> extends NonMergeable ? never : Evolver<NonNullable<T[K]>>);
};

/**
 * The type produced by {@link evolve}: keys with a function take its return type, keys with nested transforms are evolved recursively.
 */
export type Evolved<T, E> = T extends object
	? Simplify<{
			[K in keyof T]: K extends keyof E ? (E[K] extends (value: never) => infer R ? R : E[K] extends object ? Evolved<T[K], E[K]> : T[K]) : T[K];
		}>
	: T;

/**
 * Recursive worker of {@link evolve}.
 * @param {object} value - The plain object or array to copy
 * @param {object} transforms - The transforms for its keys
 * @param {object[]} ancestors - Transform objects on the current path (cycle detection)
 * @returns {object} The evolved copy
 * @throws {TypeError} when a transform is neither a function nor a plain object, or the transforms are circular
 */
function evolveWith(value: object, transforms: object, ancestors: object[]): object {
	if (ancestors.includes(transforms)) throw new TypeError('evolve: `transforms` must not be circular');
	ancestors.push(transforms);
	const result = copyContainer(value) as Properties;
	for (const key of ownEnumerableKeys(transforms)) {
		const transform = (transforms as Properties)[key];
		const nested = isPlainObject(transform);
		if (!nested && typeof transform !== 'function') {
			throw new TypeError(`evolve: \`transforms.${String(key)}\` must be a function or a plain object, got ${describe(transform)}`);
		}
		// Only OWN keys of the value are transformed: transforms never create keys.
		if (!hasOwn(value, key)) continue;
		const current = (value as Properties)[key];
		// `key` is an own data property of the copy, so plain assignment updates it (an own `'__proto__'` key included).
		if (!nested) result[key] = (transform as (value: unknown) => unknown)(current);
		else if (isContainer(current)) result[key] = evolveWith(current, transform, ancestors);
	}
	ancestors.pop();
	return result;
}

/**
 * Returns a copy of a plain object (or an array) in which the values of the keys named in `transforms` are replaced: a function receives
 * the current value and returns the new one; a nested plain object of transforms applies recursively to a nested plain object or array.
 * Keys missing from the value are skipped (transforms never create keys), and so are nested transforms facing a value that is not a
 * plain object or an array. Only the objects on transformed paths are copied; everything else is shared with the input, which is never
 * mutated.
 * @template T - The object type
 * @template E - The transforms type
 * @param {T} object - The plain object or array to evolve
 * @param {E} transforms - Functions (or nested transforms) by key
 * @returns {Evolved<T, E>} The evolved copy
 * @throws {TypeError} when `object` is not a plain object or an array, or `transforms` is not a plain object
 * @throws {TypeError} when a transform is neither a function nor a plain object, or `transforms` is circular
 * @example
 * evolve({ name: ' Ada ', stats: { visits: 1, likes: 2 }, id: 7 }, { name: function (s) { return s.trim(); }, stats: { visits: function (n) { return n + 1; } } }); // => { name: 'Ada', stats: { visits: 2, likes: 2 }, id: 7 }
 * evolve({ a: 1 } as { a: number; b?: number }, { b: function (n) { return n === undefined ? 0 : n + 1; } }); // => { a: 1 }
 */
export function evolve<T extends object, E extends Evolver<T>>(object: T, transforms: E): Evolved<T, E> {
	assertContainer('evolve', 'object', object);
	if (!isPlainObject(transforms)) throw new TypeError(`evolve: \`transforms\` must be a plain object, got ${describe(transforms)}`);
	return evolveWith(object, transforms, []) as Evolved<T, E>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Deep key transforms
// ---------------------------------------------------------------------------------------------------------------------

/** ASCII upper-case letters. */
type UpperLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

/** ASCII lower-case letters. */
type LowerLetter = Lowercase<UpperLetter>;

/** ASCII digits. */
type DigitChar = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** ASCII characters that separate words (every printable non-alphanumeric one but the apostrophe, which is removed, plus tab and line breaks). */
type SeparatorChar =
	| ' '
	| '\t'
	| '\n'
	| '\r'
	| '!'
	| '"'
	| '#'
	| '$'
	| '%'
	| '&'
	| '('
	| ')'
	| '*'
	| '+'
	| ','
	| '-'
	| '.'
	| '/'
	| ':'
	| ';'
	| '<'
	| '='
	| '>'
	| '?'
	| '@'
	| '['
	| '\\'
	| ']'
	| '^'
	| '_'
	| '`'
	| '{'
	| '|'
	| '}'
	| '~';

/**
 * The runs of ASCII letters and digits of `S` (apostrophes removed), or `never` when `S` has a character the type-level splitter does
 * not classify (non-ASCII text, control characters).
 */
type WordTokens<S extends string, Current extends string = '', Done extends string[] = []> = S extends `${infer Char}${infer Rest}`
	? Char extends UpperLetter | LowerLetter | DigitChar
		? WordTokens<Rest, `${Current}${Char}`, Done>
		: Char extends "'" | '’'
			? WordTokens<Rest, Current, Done>
			: Char extends SeparatorChar
				? WordTokens<Rest, '', Current extends '' ? Done : [...Done, Current]>
				: never
	: Current extends ''
		? Done
		: [...Done, Current];

/** Splits `S` into its leading run of capitals and the rest: `[run, rest]`. */
type CapitalRun<S extends string, Run extends string = ''> = S extends `${infer Char}${infer Rest}`
	? Char extends UpperLetter
		? CapitalRun<Rest, `${Run}${Char}`>
		: [Run, S]
	: [Run, S];

/** Splits `S` into its leading run of lower-case letters and digits and the rest: `[run, rest]`. */
type LowerRun<S extends string, Run extends string = ''> = S extends `${infer Char}${infer Rest}`
	? Char extends LowerLetter | DigitChar
		? LowerRun<Rest, `${Run}${Char}`>
		: [Run, S]
	: [Run, S];

/** Splits a non-empty `S` into everything but its last character, and its last character: `[init, last]`. */
type SplitLast<S extends string, Init extends string = ''> = S extends `${infer Char}${infer Rest}`
	? Rest extends ''
		? [Init, Char]
		: SplitLast<Rest, `${Init}${Char}`>
	: [Init, ''];

/**
 * The words of a run of letters and digits that has a lower-case letter, with the rules of the strings module's splitter: capitals
 * before the last one of a run followed by a lower-case letter (`XML` in `XMLHttp`), capitals followed by lower-case letters and digits
 * (`Http`, `version2`), or trailing capitals (`DOG` in `lazyDOG`).
 */
type TokenWords<S extends string, Done extends string[] = []> = S extends ''
	? Done
	: CapitalRun<S> extends [infer Caps extends string, infer After extends string]
		? After extends `${infer Next}${string}`
			? [Next, Caps] extends [LowerLetter, `${UpperLetter}${UpperLetter}${string}`]
				? SplitLast<Caps> extends [infer Init extends string, infer Last extends string]
					? TokenWords<`${Last}${After}`, [...Done, Init]>
					: never
				: LowerRun<After> extends [infer Run extends string, infer Rest extends string]
					? TokenWords<Rest, [...Done, `${Caps}${Run}`]>
					: never
			: [...Done, Caps]
		: never;

/** The words of a list of runs: a run without lower-case letters is a single word (`HTTP2`, the parts of `CONSTANT_CASE`). */
type TokensToWords<Tokens extends string[], Done extends string[] = []> = Tokens extends [infer Token extends string, ...infer Rest extends string[]]
	? TokensToWords<Rest, Token extends `${string}${LowerLetter}${string}` ? TokenWords<Token, Done> : [...Done, Token]>
	: Done;

/** Joins words in camel case. */
type JoinCamel<Words extends string[], Done extends string = ''> = Words extends [infer Word extends string, ...infer Rest extends string[]]
	? JoinCamel<Rest, Done extends '' ? Lowercase<Word> : `${Done}${Capitalize<Lowercase<Word>>}`>
	: Done;

/** Joins words in lower case with a separator. */
type JoinLower<Words extends string[], Separator extends string, Done extends string = ''> = Words extends [infer Word extends string, ...infer Rest extends string[]]
	? JoinLower<Rest, Separator, Done extends '' ? Lowercase<Word> : `${Done}${Separator}${Lowercase<Word>}`>
	: Done;

/** The key cases of the deep key transforms. */
type KeyCase = 'camel' | 'snake' | 'kebab';

/**
 * Type-level counterpart of the strings module's case functions for a string literal `S`, mirroring their word splitter for ASCII
 * text; `string` for non-literal strings and for text the type-level splitter does not handle (non-ASCII letters, control characters).
 */
type CaseOf<S extends string, C extends KeyCase> = string extends S
	? string
	: [WordTokens<S>] extends [infer Tokens extends string[]]
		? [Tokens] extends [never]
			? string
			: C extends 'camel'
				? JoinCamel<TokensToWords<Tokens>>
				: JoinLower<TokensToWords<Tokens>, C extends 'snake' ? '_' : '-'>
		: string;

/**
 * The camelCase form of a string literal, as computed by `strings/toCamelCase` (exact for ASCII text, `string` otherwise).
 * @example
 * type C = CamelCase<'XMLHttpRequest_id'>; // 'xmlHttpRequestId'
 */
export type CamelCase<S extends string> = CaseOf<S, 'camel'>;

/**
 * The snake_case form of a string literal, as computed by `strings/toSnakeCase` (exact for ASCII text, `string` otherwise).
 * @example
 * type S = SnakeCase<'userID2Code'>; // 'user_id2_code'
 */
export type SnakeCase<S extends string> = CaseOf<S, 'snake'>;

/**
 * The kebab-case form of a string literal, as computed by `strings/toKebabCase` (exact for ASCII text, `string` otherwise).
 * @example
 * type K = KebabCase<'getHTTPResponse'>; // 'get-http-response'
 */
export type KebabCase<S extends string> = CaseOf<S, 'kebab'>;

/** Deep key renaming at the type level, for {@link toCamelCaseKeys} and its siblings (`'__proto__'` is kept as is). */
type CaseKeysDeep<T, C extends KeyCase> =
	T extends ReadonlyArray<infer Item>
		? Array<CaseKeysDeep<Item, C>>
		: T extends NonMergeable
			? T
			: { [K in keyof T as K extends string | number ? (`${K}` extends '__proto__' ? K : CaseOf<`${K}`, C>) : K]: CaseKeysDeep<T[K], C> };

/**
 * The type produced by {@link toCamelCaseKeys}: the string keys of nested plain objects (also inside arrays) in camel case.
 * @example
 * type K = CamelCaseKeys<{ user_id: number; home_address: { zip_code: string }[] }>; // { userId: number; homeAddress: { zipCode: string }[] }
 */
export type CamelCaseKeys<T> = CaseKeysDeep<T, 'camel'>;

/**
 * The type produced by {@link toSnakeCaseKeys}: the string keys of nested plain objects (also inside arrays) in snake case.
 */
export type SnakeCaseKeys<T> = CaseKeysDeep<T, 'snake'>;

/**
 * The type produced by {@link toKebabCaseKeys}: the string keys of nested plain objects (also inside arrays) in kebab case.
 */
export type KebabCaseKeys<T> = CaseKeysDeep<T, 'kebab'>;

/**
 * The type produced by {@link transformKeysDeep}: nested plain objects (also inside arrays) become string-keyed records.
 */
export type TransformKeysDeep<T> =
	T extends ReadonlyArray<infer Item>
		? Array<TransformKeysDeep<Item>>
		: T extends NonMergeable
			? T
			: { [K in keyof T as K extends symbol ? K : string]: TransformKeysDeep<T[K]> };

/**
 * Recursive worker of {@link transformKeysDeep} and the case helpers.
 * @param {string} caller - Name of the public function, for error messages
 * @param {unknown} value - The value to copy
 * @param {(key: string) => string} rename - Computes the new key of a string key
 * @param {object[]} ancestors - Containers on the current path (cycle detection)
 * @returns {unknown} The copy with renamed keys (other values as they are)
 * @throws {TypeError} when `rename` returns a non-string, or the value is circular
 * @throws {RangeError} when two keys of an object get the same new key
 */
function renameKeys(caller: string, value: unknown, rename: (key: string) => string, ancestors: object[]): unknown {
	if (!isContainer(value)) return value;
	if (ancestors.includes(value)) throw new TypeError(`${caller}: cannot transform a circular structure`);
	ancestors.push(value);
	let result: object;
	if (Array.isArray(value)) {
		const copy = new Array<unknown>(value.length);
		for (const index of presentIndexes(value)) copy[index] = renameKeys(caller, value[index], rename, ancestors);
		result = copy;
	} else {
		result = emptyLike(value);
		const keys = ownEnumerableKeys(value);
		const renamed: PropertyKey[] = [];
		for (const key of keys) {
			const newKey = typeof key === 'string' ? rename(key) : key;
			// Symbol keys are kept as they are; a renamed string key must stay a string.
			if (typeof key === 'string' && typeof newKey !== 'string')
				throw new TypeError(`${caller}: \`fn\` must return a string, got ${describe(newKey)} for "${String(key)}"`);
			if (hasOwn(result, newKey)) {
				throw new RangeError(`${caller}: keys "${String(keys[renamed.indexOf(newKey)])}" and "${String(key)}" both become "${String(newKey)}"`);
			}
			renamed.push(newKey);
			definePlain(result, newKey, renameKeys(caller, (value as Properties)[key], rename, ancestors));
		}
	}
	ancestors.pop();
	return result;
}

/**
 * Returns a deep copy of the plain objects and arrays of `value` in which every own enumerable STRING key of every plain object is
 * renamed by `fn` (symbol keys are kept). Arrays are copied item by item (holes kept); every other value (dates, maps, class instances,
 * primitives) is kept by reference and never recursed into.
 * - Keys are DEFINED, never assigned: a key renamed to `'__proto__'` becomes a plain own property (no prototype change).
 * - Two keys of one object renamed to the same key throw a `RangeError` (instead of one value silently overwriting the other).
 * - Circular structures throw a `TypeError`.
 * @template T - The value type
 * @param {T} value - The value to copy
 * @param {(key: string) => string} fn - Computes the new name of a key
 * @returns {TransformKeysDeep<T>} The copy with renamed keys
 * @throws {TypeError} when `fn` is not a function or returns a non-string
 * @throws {RangeError} when two keys of the same object are renamed to the same key
 * @throws {TypeError} when `value` contains a circular reference
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * transformKeysDeep({ a: { b: 1 }, list: [{ c: 2 }] }, function (key) { return key.toUpperCase(); }); // => { A: { B: 1 }, LIST: [{ C: 2 }] }
 * transformKeysDeep({ a: 1, A: 2 }, function (key) { return key.toLowerCase(); }); // throws RangeError
 */
export function transformKeysDeep<T>(value: T, fn: (key: string) => string): TransformKeysDeep<T> {
	assertFunction('transformKeysDeep', 'fn', fn);
	return renameKeys('transformKeysDeep', value, fn, []) as TransformKeysDeep<T>;
}

/**
 * Shared body of the case helpers: renames keys with a strings-module case function, memoized per call (payloads repeat their keys),
 * keeping `'__proto__'` as is.
 * @param {string} caller - Name of the public function
 * @param {unknown} value - The value to copy
 * @param {(key: string) => string} convert - The case function
 * @returns {unknown} The copy with renamed keys
 */
function caseKeys(caller: string, value: unknown, convert: (key: string) => string): unknown {
	const cache = new Map<string, string>();
	return renameKeys(
		caller,
		value,
		function (key) {
			let renamed = cache.get(key);
			if (renamed === undefined) {
				// The splitter would turn `'__proto__'` into `'proto'`, silently changing what the key means: it is kept as is.
				renamed = key === '__proto__' ? key : convert(key);
				cache.set(key, renamed);
			}
			return renamed;
		},
		[]
	);
}

/**
 * Deeply renames the keys of plain objects (also inside arrays) to camelCase with `strings/toCamelCase`, the same word splitter as
 * every case function of tink (acronyms: `XMLHttpRequest` → `xmlHttpRequest`; digits stay attached: `version2`), so the result TYPE
 * ({@link CamelCaseKeys}) matches the runtime keys exactly for ASCII keys. See {@link transformKeysDeep} for the copy rules: dates, maps
 * and class instances are kept as they are, colliding keys (`{ user_id: 1, userId: 2 }`) throw a `RangeError`, and the `'__proto__'` key
 * is kept unchanged as a plain own property.
 * @template T - The value type
 * @param {T} value - The value to copy
 * @returns {CamelCaseKeys<T>} The copy with camelCase keys
 * @throws {RangeError} when two keys of the same object have the same camelCase form
 * @throws {TypeError} when `value` contains a circular reference
 * @example
 * toCamelCaseKeys({ user_id: 1, 'home-address': { zip_code: '1000' }, created_at: new Date(0) }); // => { userId: 1, homeAddress: { zipCode: '1000' }, createdAt: new Date(0) }
 * toCamelCaseKeys({ user_id: 1, userId: 2 }); // throws RangeError
 */
export function toCamelCaseKeys<T>(value: T): CamelCaseKeys<T> {
	return caseKeys('toCamelCaseKeys', value, toCamelCase) as CamelCaseKeys<T>;
}

/**
 * Deeply renames the keys of plain objects (also inside arrays) to snake_case with `strings/toSnakeCase`; same rules as
 * {@link toCamelCaseKeys}.
 * @template T - The value type
 * @param {T} value - The value to copy
 * @returns {SnakeCaseKeys<T>} The copy with snake_case keys
 * @throws {RangeError} when two keys of the same object have the same snake_case form
 * @throws {TypeError} when `value` contains a circular reference
 * @example
 * toSnakeCaseKeys({ userId: 1, items: [{ unitPrice: 2, XMLData: 3 }] }); // => { user_id: 1, items: [{ unit_price: 2, xml_data: 3 }] }
 */
export function toSnakeCaseKeys<T>(value: T): SnakeCaseKeys<T> {
	return caseKeys('toSnakeCaseKeys', value, toSnakeCase) as SnakeCaseKeys<T>;
}

/**
 * Deeply renames the keys of plain objects (also inside arrays) to kebab-case with `strings/toKebabCase`; same rules as
 * {@link toCamelCaseKeys}.
 * @template T - The value type
 * @param {T} value - The value to copy
 * @returns {KebabCaseKeys<T>} The copy with kebab-case keys
 * @throws {RangeError} when two keys of the same object have the same kebab-case form
 * @throws {TypeError} when `value` contains a circular reference
 * @example
 * toKebabCaseKeys({ fontSize: 12, borderTop: { lineWidth: 1 } }); // => { 'font-size': 12, 'border-top': { 'line-width': 1 } }
 */
export function toKebabCaseKeys<T>(value: T): KebabCaseKeys<T> {
	return caseKeys('toKebabCaseKeys', value, toKebabCase) as KebabCaseKeys<T>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Serialization and hashing
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Encodes the members of an object's own enumerable STRING keys, sorted by UTF-16 code units, as `"key":value` pairs.
 * @param {object} object - The object to encode
 * @param {object[]} ancestors - Objects on the current path (cycle detection)
 * @returns {string} The `{...}` encoding
 */
function encodeMembers(object: object, ancestors: object[]): string {
	const keys = Object.keys(object).sort();
	let text = '{';
	for (let index = 0; index < keys.length; index++) {
		text += (index === 0 ? '' : ',') + JSON.stringify(keys[index]) + ':' + encodeValue((object as Properties)[keys[index]], ancestors);
	}
	return text + '}';
}

/**
 * Encodes the items of an array-like value (holes of a genuine array are encoded as nothing, like in an array literal).
 * @param {ArrayLike<unknown>} items - The items
 * @param {object[]} ancestors - Objects on the current path (cycle detection)
 * @returns {string} The `[...]` encoding
 */
function encodeItems(items: ArrayLike<unknown>, ancestors: object[]): string {
	let text = '[';
	for (let index = 0; index < items.length; index++) {
		if (index > 0) text += ',';
		// Own elements only: a hole must not read a value from a polluted `Array.prototype`.
		if (hasOwn(items, index)) text += encodeValue(items[index], ancestors);
	}
	// As in array literals, a trailing hole needs one more comma: otherwise `new Array(1)` would encode like `[]`.
	if (items.length > 0 && !hasOwn(items, items.length - 1)) text += ',';
	return text + ']';
}

/**
 * Encodes a list of values in a canonical order (the sorted encodings), for `Set` members and `Map` entries.
 * @param {Iterable<unknown>} values - The values
 * @param {object[]} ancestors - Objects on the current path (cycle detection)
 * @returns {string} The `[...]` encoding
 */
function encodeUnordered(values: Iterable<unknown>, ancestors: object[]): string {
	const encoded: string[] = [];
	for (const value of values) encoded.push(encodeValue(value, ancestors));
	return '[' + encoded.sort().join(',') + ']';
}

/**
 * Encodes an object that is not a plain object or an array (see {@link stableStringify}).
 * @param {object} value - The object
 * @param {object[]} ancestors - Objects on the current path (cycle detection)
 * @returns {string} The encoding
 * @throws {TypeError} for a `WeakMap`, a `WeakSet` or a promise
 */
function encodeSpecial(value: object, ancestors: object[]): string {
	if (isUncloneable(value)) throw new TypeError(`stableStringify: cannot serialize a ${getTag(value).slice(8, -1)}`);
	if (isDate(value)) return `Date(${encodeValue(value.getTime(), ancestors)})`;
	if (isRegExp(value)) return `RegExp(${JSON.stringify(String(value))})`;
	if (isMap(value)) return `Map(${encodeUnordered(value, ancestors)})`;
	if (isSet(value)) return `Set(${encodeUnordered(value, ancestors)})`;
	if (isBinary(value)) {
		if (!ArrayBuffer.isView(value)) return `${getTag(value).slice(8, -1)}(${encodeItems(new Uint8Array(value), ancestors)})`;
		const name = typedArrayTag.call(value) as string | undefined;
		// A typed array encodes its elements (numbers or bigints), a `DataView` its bytes.
		const items = name === undefined ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : (value as unknown as ArrayLike<unknown>);
		return `${name ?? 'DataView'}(${encodeItems(items, ancestors)})`;
	}
	const [isBoxed, primitive] = unbox(value);
	if (isBoxed) return `${getTag(value).slice(8, -1)}(${encodeValue(primitive, ancestors)})`;
	const constructor = (Object.getPrototypeOf(value) as { constructor?: unknown } | null)?.constructor;
	const name = typeof constructor === 'function' && constructor.name !== '' ? constructor.name : '?';
	// A name that is not an identifier (a computed class name such as `'1,"z":'`) is quoted: written as is, it could read as other data.
	return (name === '?' || IDENTIFIER.test(name) ? name : JSON.stringify(name)) + encodeMembers(value, ancestors);
}

/** A JavaScript identifier (ASCII or not): how class names are written in {@link stableStringify}'s output. */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/**
 * Recursive worker of {@link stableStringify}.
 * @param {unknown} value - The value to encode
 * @param {object[]} ancestors - Objects on the current path (cycle detection)
 * @returns {string} The encoding
 * @throws {TypeError} for functions, symbols, `WeakMap`s, `WeakSet`s, promises and circular references
 */
function encodeValue(value: unknown, ancestors: object[]): string {
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'number':
			// `String` gives the JSON form of finite numbers, and `NaN`, `Infinity`, `-Infinity` for the others; only `-0` needs a sign.
			return value === 0 && 1 / value < 0 ? '-0' : String(value);
		case 'boolean':
		case 'undefined':
			return String(value);
		case 'bigint':
			return `${value}n`;
		case 'object':
			if (value === null) return 'null';
			break;
		default:
			throw new TypeError(`stableStringify: cannot serialize a ${typeof value}`);
	}
	if (ancestors.includes(value)) throw new TypeError('stableStringify: cannot serialize a circular structure');
	ancestors.push(value);
	const text = isPlainObject(value) ? encodeMembers(value, ancestors) : Array.isArray(value) ? encodeItems(value, ancestors) : encodeSpecial(value, ancestors);
	ancestors.pop();
	return text;
}

/**
 * Serializes a value into a DETERMINISTIC string: two values give the same string exactly when they hold the same data, whatever the
 * insertion order of their keys or `Map`/`Set` entries, which makes the result usable as a cache key, a memoization key or the input
 * of {@link hash}. Encoding version 1 (it only changes in a major release):
 * - JSON values encode exactly like `JSON.stringify` with keys sorted (by UTF-16 code units): `{"a":[1,"x"],"b":null}`. Plain objects
 *   (`Object.prototype` or `null` prototype) encode their own enumerable string keys; symbol keys are ignored. Arrays encode their
 *   items; a hole encodes as nothing (`[1,,3]`), and a trailing one
 *   adds a comma, as in array literals (`[1,,]` for `[1, <hole>]`).
 * - Values JSON cannot represent get a distinct encoding: `undefined` (also as an object value: `{"a":undefined}`), `NaN`, `Infinity`,
 *   `-Infinity`, `-0`, bigints (`12n`), `Date(ms)`, `RegExp("/a/g")`, `Map([[k,v],...])` and `Set([...])` (entries sorted by encoding),
 *   typed arrays, `DataView`s and `ArrayBuffer`s (`Uint8Array([1,2])`, bytes for the last two), boxed primitives (`Number(1)`), and other
 *   objects (class instances, errors...) as `ClassName{...}` with their own enumerable string keys.
 * - Functions, symbols, `WeakMap`s, `WeakSet`s, promises (any object with a `then` method) and circular references throw a
 *   `TypeError` (shared references are fine).
 *
 * Getters are invoked; `toJSON` methods are NOT. Distinct classes sharing a name encode alike.
 * @param {unknown} value - The value to serialize
 * @returns {string} The deterministic encoding
 * @throws {TypeError} when the value contains a function, a symbol, a `WeakMap`, a `WeakSet`, a promise or a circular reference
 * @throws {RangeError} when the nesting is deeper than the call stack allows
 * @example
 * stableStringify({ b: 1, a: [true, 'x'] }); // => '{"a":[true,"x"],"b":1}'
 * stableStringify({ a: 1, b: 2 }) === stableStringify({ b: 2, a: 1 }); // => true
 * stableStringify({ n: NaN, z: -0, big: 10n, u: undefined }); // => '{"big":10n,"n":NaN,"u":undefined,"z":-0}'
 * stableStringify(new Map([['y', 1], ['x', new Set([2, 1])]])); // => 'Map([["x",Set([1,2])],["y",1]])'
 * stableStringify({ when: new Date(0), bytes: new Uint8Array([1, 2]) }); // => '{"bytes":Uint8Array([1,2]),"when":Date(0)}'
 */
export function stableStringify(value: unknown): string {
	return encodeValue(value, []);
}

/**
 * Hashes a value: the 53-bit cyrb53 hash of its {@link stableStringify} encoding, so equal data gives equal hashes whatever the key
 * order. Synchronous, fast and platform-neutral (no WebCrypto, no Node APIs); the result is a non-negative safe integer (render it with
 * `.toString(36)` for a compact key).
 *
 * NOT CRYPTOGRAPHIC: collisions can be crafted, so never use it for passwords, signatures, or as the only defence of a cache shared
 * with untrusted parties. Same encoding rules and errors as {@link stableStringify}.
 * @param {unknown} value - The value to hash
 * @param {number} [seed=0] - An integer in `[0, 2³² - 1]` selecting another, independent hash function
 * @returns {number} An integer in `[0, 2⁵³ - 1]`
 * @throws {TypeError} when `seed` is not a number
 * @throws {RangeError} when `seed` is not an integer in `[0, 2³² - 1]`
 * @throws {TypeError} when the value contains a function, a symbol, a `WeakMap`, a `WeakSet`, a promise or a circular reference
 * @example
 * hash({ a: 1, b: [1, 2] }) === hash({ b: [1, 2], a: 1 }); // => true
 * hash({ a: 1 }) === hash({ a: 2 }); // => false
 * Number.isSafeInteger(hash('anything', 42)); // => true
 */
export function hash(value: unknown, seed: number = 0): number {
	assertNumber('hash', 'seed', seed, Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'an integer between 0 and 4294967295');
	const text = stableStringify(value);
	// cyrb53 (public domain): two 32-bit multiply-xorshift lanes over the UTF-16 code units, mixed into 53 bits.
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Options of {@link safeStringify}.
 */
export interface SafeStringifyOptions {
	/**
	 * As `JSON.stringify`'s: a function called as `replacer.call(holder, key, value)` for every value (after its `toJSON`, before any
	 * conversion, so it sees bigints, maps and errors as they are), or the list of the keys to write for objects (strings and numbers;
	 * own properties only).
	 */
	replacer?: ((this: unknown, key: string, value: unknown) => unknown) | ReadonlyArray<string | number>;
	/** As `JSON.stringify`'s: the number of spaces to indent with (capped at 10), or the indentation string (its first 10 characters). */
	space?: number | string;
	/**
	 * Whether object keys are written in sorted order (default `false`), by UTF-16 code units as in {@link stableStringify}, integer-like
	 * keys included (`"10"` before `"2"`), for deterministic output; arrays (and the entries of maps and sets) keep their order.
	 */
	sortKeys?: boolean;
	/**
	 * Objects nested deeper than this (the value itself is at depth 0) become `"[Object]"` (`"[Array]"` for arrays). An integer >= 0 or
	 * `Infinity` (the default); values above 1000 are clamped to 1000, the hard cap that keeps the text writable, so the default is
	 * effectively 1000.
	 */
	maxDepth?: number;
}

/** How {@link writeJson} lays the text out. */
interface JsonLayout {
	/** One level of indentation (`''` for compact output). */
	readonly gap: string;
	/** The keys to write, in order, when a replacer list was given (objects have no other keys then). */
	readonly keys: ReadonlyArray<string> | undefined;
	/** Whether the keys of objects are sorted. */
	readonly sort: boolean;
}

/**
 * Writes a tree of JSON values as text, indented as `JSON.stringify` does. Never looks a `toJSON` up, so a polluted prototype cannot
 * change the output. The keys are written in the order of the replacer list, or sorted, or in the objects' own order: an object cannot
 * hold integer-like keys in another order than ascending.
 * @param {JsonValue} value - The value
 * @param {string} indent - The indentation of the current line
 * @param {JsonLayout} layout - The gap and key order
 * @returns {string} The JSON text
 */
function writeJson(value: JsonValue, indent: string, layout: JsonLayout): string {
	if (typeof value !== 'object' || value === null) return typeof value === 'string' ? JSON.stringify(value) : String(value);
	const isArray = Array.isArray(value);
	const gap = layout.gap;
	const inner = indent + gap;
	let text = '';
	if (isArray) {
		for (let index = 0; index < value.length; index++) text += (index === 0 ? '' : ',') + (gap === '' ? '' : '\n' + inner) + writeJson(value[index], inner, layout);
	} else {
		const keys = layout.keys ?? (layout.sort ? Object.keys(value).sort() : Object.keys(value));
		for (const key of keys) {
			if (!hasOwn(value, key)) continue;
			text += (text === '' ? '' : ',') + (gap === '' ? '' : '\n' + inner) + JSON.stringify(key) + (gap === '' ? ':' : ': ') + writeJson(value[key], inner, layout);
		}
	}
	if (text === '') return isArray ? '[]' : '{}';
	return (isArray ? '[' : '{') + text + (gap === '' ? '' : '\n' + indent) + (isArray ? ']' : '}');
}

/**
 * `JSON.stringify` that never throws on the value: it gives the same text for everything `JSON.stringify` handles (same `toJSON`,
 * replacer and `space` semantics), and a useful one where `JSON.stringify` throws or loses data:
 * - A circular reference becomes `"[Circular]"`; only true ancestors count, so an object referenced twice (siblings, a DAG) is written
 *   twice.
 * - A bigint becomes its decimal string (`10n` → `"10"`); a replacer sees it first, to write it otherwise.
 * - An error (of any realm) becomes `{"name","message","stack",…}` with its own `code`, its `cause`, an `AggregateError`'s `errors` and
 *   its other own enumerable properties, as `serializeError` (`errors` module) writes it; a `toJSON` method of the error wins.
 * - A `Map` becomes the array of its `[key, value]` entries (so `new Map(JSON.parse(text))` restores it), a `Set` the array of its values.
 * - A getter, `toJSON` method, replacer or proxy trap that throws writes `"[Throws: <message>]"` in place of the value, and an object
 *   deeper than `maxDepth` `"[Object]"` (`"[Array]"`). Nesting is capped at 1000 levels whatever `maxDepth` asks for (deeper objects
 *   become these markers too), so a hostile, deeply nested value can never make the call, or the writing of its text, overflow the
 *   stack. A call made with little stack left gets a shallower text instead (the value is then walked again, half as deep, until its
 *   text can be written), with the markers where it was cut.
 *
 * Only own properties are read: an array hole is `null` even when `Array.prototype` has an element there, and a key of a `replacer` list
 * that an object only inherits is left out; a `toJSON` method inherited from a polluted `Object.prototype` is ignored. Boxed primitives are written as their primitive. The cost is linear in the size of the
 * value; an array costs its `length`, holes included.
 *
 * The `errors` module is not imported for this: both modules share a private converter, which `serializeError` also uses.
 * @param {unknown} value - The value to serialize
 * @param {SafeStringifyOptions} [options={}] - `replacer`, `space`, `sortKeys` (default `false`) and `maxDepth` (default `Infinity`,
 * clamped to 1000)
 * @returns {string | undefined} The JSON text, or `undefined` where `JSON.stringify` returns it (the value, after `toJSON` and the
 * replacer, is `undefined`, a function or a symbol)
 * @throws {TypeError} when `replacer` is not a function or an array, `space` is not a number or a string, or `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`, or the text would exceed the engine's maximum string length
 * @example
 * const node: Record<string, unknown> = { id: 1 };
 * node.self = node;
 * safeStringify(node); // => '{"id":1,"self":"[Circular]"}'
 * const shared = { x: 1 };
 * safeStringify([shared, shared]); // => '[{"x":1},{"x":1}]'
 * safeStringify({ big: 10n, tags: new Set(['a']), meta: new Map([['k', 1]]) }); // => '{"big":"10","tags":["a"],"meta":[["k",1]]}'
 * safeStringify({ b: 1, a: { d: 1, c: 2 } }, { sortKeys: true }); // => '{"a":{"c":2,"d":1},"b":1}'
 * safeStringify({ get boom() { throw new Error('nope'); } }); // => '{"boom":"[Throws: nope]"}'
 * safeStringify(new TypeError('Bad'), { replacer: ['name', 'message'] }); // => '{"name":"TypeError","message":"Bad"}'
 * safeStringify({ a: [1] }, { space: 2 }); // => '{\n  "a": [\n    1\n  ]\n}'
 * safeStringify(undefined); // => undefined
 */
export function safeStringify(value: unknown, options: SafeStringifyOptions = {}): string | undefined {
	const replacer = readOption(options, 'replacer');
	const space = readOption(options, 'space');
	const maxDepth = readOption(options, 'maxDepth', Infinity);
	if (replacer !== undefined && typeof replacer !== 'function' && !Array.isArray(replacer)) {
		throw new TypeError(`safeStringify: \`replacer\` must be a function or an array, got ${describe(replacer)}`);
	}
	if (space !== undefined && typeof space !== 'number' && typeof space !== 'string') {
		throw new TypeError(`safeStringify: \`space\` must be a number or a string, got ${describe(space)}`);
	}
	assertInteger('safeStringify', 'maxDepth', maxDepth, 0, true);
	const sort = readOption(options, 'sortKeys') === true;
	let keys: string[] | undefined;
	if (Array.isArray(replacer)) {
		const listed = new Set<string>();
		for (const key of replacer as ReadonlyArray<unknown>) if (typeof key === 'string' || typeof key === 'number') listed.add(String(key));
		keys = sort ? [...listed].sort() : [...listed];
	}
	// As `JSON.stringify`: at most 10 spaces (none for 0, a negative number or `NaN`), or the first 10 characters of a string.
	const gap = typeof space === 'number' ? ' '.repeat(Math.min(10, Math.max(0, Math.trunc(space) || 0))) : (space ?? '').slice(0, 10);
	let depth = Math.min(maxDepth, MAX_JSON_DEPTH);
	for (;;) {
		const walk: JsonWalk = { replacer: typeof replacer === 'function' ? replacer : undefined, keys, stack: true, maxDepth: depth, ancestors: [], onPath: new Set() };
		const tree = toJsonValue({ '': value }, '', walk);
		if (tree === undefined) return undefined;
		try {
			// The tree holds plain objects and arrays only: `JSON.stringify` writes it faster, unless a `toJSON` was planted on their
			// prototypes or the keys must be written in another order than the tree's.
			return keys === undefined && !sort && !('toJSON' in Array.prototype) ? JSON.stringify(tree, undefined, gap) : writeJson(tree, '', { gap, keys, sort });
		} catch (error) {
			// Called with little stack left, writing a deep tree can overflow it: the value is walked again, half as deep. Any other failure
			// (a text longer than the engine's maximum string length) is thrown, as documented.
			if (depth === 0 || !isStackOverflow(error)) throw error;
			depth >>= 1;
		}
	}
}

/**
 * Whether an error is the engine running out of call stack: a `RangeError` "Maximum call stack size exceeded" (V8, JavaScriptCore) or
 * an `InternalError` "too much recursion" (SpiderMonkey).
 * @param {unknown} error - The error
 * @returns {boolean} Whether it reports a stack overflow
 */
function isStackOverflow(error: unknown): boolean {
	return (error instanceof RangeError || (error instanceof Error && error.name === 'InternalError')) && /call stack|recursion/i.test(error.message);
}
