/**
 * Any JavaScript primitive value.
 */
export type Primitive = string | number | bigint | boolean | symbol | null | undefined;

/**
 * Any callable value. Parameters are typed as `never[]` so that every function type is assignable to it.
 */
export type AnyFunction = (...args: never[]) => unknown;

/**
 * Converts a union type into an intersection type.
 * @example
 * type R = UnionToIntersection<{ a: 1 } | { b: 2 }>; // { a: 1 } & { b: 2 }
 */
export type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/**
 * Recursively marks every property of `T` as `readonly`.
 */
export type DeepReadonly<T> = T extends Primitive | AnyFunction
	? T
	: T extends ReadonlyArray<infer U>
		? ReadonlyArray<DeepReadonly<U>>
		: T extends ReadonlyMap<infer K, infer V>
			? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
			: T extends ReadonlySet<infer U>
				? ReadonlySet<DeepReadonly<U>>
				: { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * Values that terminate path recursion in {@link NestedKeyOf}.
 */
type PathLeaf = Primitive | AnyFunction | Date | RegExp | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object> | Promise<unknown>;

/**
 * Recursion budget used to keep {@link NestedKeyOf} from exploding on deep or recursive types.
 */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Every dot-separated path that can be used to reach a property of `T`, up to 8 levels deep.
 * Array elements are addressed with numeric segments (`'items.0.name'`).
 * @example
 * type K = NestedKeyOf<{ a: { b: string }; list: { id: number }[] }>;
 * // 'a' | 'a.b' | 'list' | `list.${number}` | `list.${number}.id`
 */
export type NestedKeyOf<T, D extends number = 8> = [D] extends [never]
	? never
	: T extends PathLeaf
		? never
		: T extends ReadonlyArray<infer U>
			? `${number}` | (NestedKeyOf<U, Depth[D]> extends infer Sub extends string ? (Sub extends never ? never : `${number}.${Sub}`) : never)
			: T extends object
				? {
						[K in keyof T & (string | number)]: NonNullable<T[K]> extends PathLeaf
							? `${K}`
							: `${K}` | (NestedKeyOf<NonNullable<T[K]>, Depth[D]> extends infer Sub extends string ? `${K}.${Sub}` : never);
					}[keyof T & (string | number)]
				: never;

/**
 * Resolves a single path segment `K` against `T`, propagating `undefined` for nullable parents and unknown keys.
 */
type PathSegmentValue<T, K extends string> = K extends keyof NonNullable<T>
	? NonNullable<T>[K] | (T extends null | undefined ? undefined : never)
	: NonNullable<T> extends ReadonlyArray<infer U>
		? K extends `${number}`
			? U | undefined
			: undefined
		: // A numeric key (`{ 1: string }`) is a number in `keyof`, while the path segment is its string.
			K extends `${infer N extends number}`
			? N extends keyof NonNullable<T>
				? NonNullable<T>[N] | (T extends null | undefined ? undefined : never)
				: undefined
			: undefined;

/**
 * The type of the value found at the dot-separated path `P` inside `T`.
 * @example
 * type V = PathValue<{ a: { b: string } }, 'a.b'>; // string
 */
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}` ? PathValue<PathSegmentValue<T, K>, Rest> : PathSegmentValue<T, P>;

/**
 * Structural subset of the standard `AbortSignal`, so the library works without the DOM or Node type libraries.
 */
export interface AbortSignalLike {
	readonly aborted: boolean;
	readonly reason?: unknown;
	addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * A pseudo-random number generator returning floats in `[0, 1)`, compatible with `Math.random`.
 */
export type RandomGenerator = () => number;

/**
 * Flattens an intersection into a single object type, keeping `readonly` and `?` modifiers (purely cosmetic: better tooltips).
 */
type Expand<T> = { [K in keyof T]: T[K] };

/**
 * Objects the deep mapped types ({@link PartialDeep}, {@link RequiredDeep}, {@link WritableDeep}) leave untouched. They are tested
 * after `Map` and `Set`, which a `WeakMap` / `WeakSet` check would otherwise catch structurally.
 */
type DeepLeaf = AnyFunction | Date | RegExp | Promise<unknown> | WeakMap<object, unknown> | WeakSet<object> | ArrayBufferLike | ArrayBufferView;

/**
 * Recursively makes every property of `T` optional, through nested objects, arrays, tuples, `Map`s and `Set`s.
 * Tuple elements become optional; array elements keep their type (made deeply partial), without gaining `undefined`.
 * Primitives, `unknown`, functions, `Date`, `RegExp`, promises, `WeakMap`, `WeakSet`, typed arrays and buffers are left as they are.
 * @template T - The type to make deeply partial
 * @example
 * type Settings = { theme: { mode: 'light' | 'dark'; accent: string }; tags: [string, number] };
 * type Patch = PartialDeep<Settings>; // { theme?: { mode?: 'light' | 'dark'; accent?: string }; tags?: [string?, number?] }
 */
export type PartialDeep<T> =
	T extends ReadonlyMap<infer K, infer V>
		? T extends Map<K, V>
			? Map<PartialDeep<K>, PartialDeep<V>>
			: ReadonlyMap<PartialDeep<K>, PartialDeep<V>>
		: T extends ReadonlySet<infer U>
			? T extends Set<U>
				? Set<PartialDeep<U>>
				: ReadonlySet<PartialDeep<U>>
			: T extends DeepLeaf
				? T
				: T extends ReadonlyArray<unknown>
					? number extends T['length']
						? { [K in keyof T]: PartialDeep<T[K]> }
						: { [K in keyof T]?: PartialDeep<T[K]> }
					: T extends object
						? { [K in keyof T]?: PartialDeep<T[K]> }
						: T;

/**
 * Recursively makes every property of `T` required, through nested objects, arrays, tuples, `Map`s and `Set`s. Like the built-in
 * `Required`, removing `?` also removes the `undefined` it implied, and array and tuple elements lose `undefined`; an explicit
 * `| undefined` on a required object property stays. Primitives, `unknown`, functions, `Date`, `RegExp`, promises, `WeakMap`,
 * `WeakSet`, typed arrays and buffers are left as they are.
 * @template T - The type to make deeply required
 * @example
 * type Config = { server?: { port?: number; host?: string } };
 * type Full = RequiredDeep<Config>; // { server: { port: number; host: string } }
 */
export type RequiredDeep<T> =
	T extends ReadonlyMap<infer K, infer V>
		? T extends Map<K, V>
			? Map<RequiredDeep<K>, RequiredDeep<V>>
			: ReadonlyMap<RequiredDeep<K>, RequiredDeep<V>>
		: T extends ReadonlySet<infer U>
			? T extends Set<U>
				? Set<RequiredDeep<U>>
				: ReadonlySet<RequiredDeep<U>>
			: T extends DeepLeaf
				? T
				: T extends object
					? { [K in keyof T]-?: RequiredDeep<T[K]> }
					: T;

/**
 * `T` with `readonly` removed from every property; a type parameter of its own so that arrays and tuples map to arrays and tuples.
 */
type WritableAll<T> = { -readonly [P in keyof T]: T[P] };

/**
 * Removes `readonly` from every property of `T` (or only from the keys `K`), turning readonly arrays and tuples into mutable ones.
 * The opposite of the built-in `Readonly`.
 * @template T - The type to make writable
 * @template K - The keys to make writable (all of them by default)
 * @example
 * type Point = { readonly x: number; readonly y: number };
 * type Mutable = Writable<Point>; // { x: number; y: number }
 * type OnlyX = Writable<Point, 'x'>; // { x: number; readonly y: number }
 */
export type Writable<T, K extends keyof T = keyof T> = [keyof T] extends [K]
	? WritableAll<T>
	: Expand<{ -readonly [P in keyof T as P extends K ? P : never]: T[P] } & { [P in keyof T as P extends K ? never : P]: T[P] }>;

/**
 * Recursively removes `readonly` from `T`: nested objects, readonly arrays and tuples, `ReadonlyMap` (to `Map`) and `ReadonlySet`
 * (to `Set`). Primitives, `unknown`, functions, `Date`, `RegExp`, promises, `WeakMap`, `WeakSet`, typed arrays and buffers are left as
 * they are.
 * @template T - The type to make deeply writable
 * @example
 * type State = { readonly user: { readonly tags: readonly string[] } };
 * type Draft = WritableDeep<State>; // { user: { tags: string[] } }
 */
export type WritableDeep<T> =
	T extends ReadonlyMap<infer K, infer V>
		? Map<WritableDeep<K>, WritableDeep<V>>
		: T extends ReadonlySet<infer U>
			? Set<WritableDeep<U>>
			: T extends DeepLeaf
				? T
				: T extends object
					? { -readonly [K in keyof T]: WritableDeep<T[K]> }
					: T;

/**
 * Makes the keys `K` of `T` optional, keeping the other properties (and every `readonly` modifier) as they are.
 * Distributes over unions.
 * @template T - The object type
 * @template K - The keys to make optional
 * @example
 * type User = { id: number; name: string; email: string };
 * type NewUser = SetOptional<User, 'id'>; // { name: string; email: string; id?: number }
 */
export type SetOptional<T, K extends keyof T> = T extends unknown
	? Expand<{ [P in keyof T as P extends K ? never : P]: T[P] } & { [P in keyof T as P extends K ? P : never]?: T[P] }>
	: never;

/**
 * Makes the keys `K` of `T` required, keeping the other properties (and every `readonly` modifier) as they are.
 * Distributes over unions.
 * @template T - The object type
 * @template K - The keys to make required
 * @example
 * type Options = { timeout?: number; retries?: number };
 * type WithTimeout = SetRequired<Options, 'timeout'>; // { retries?: number; timeout: number }
 */
export type SetRequired<T, K extends keyof T> = T extends unknown
	? Expand<{ [P in keyof T as P extends K ? never : P]: T[P] } & { [P in keyof T as P extends K ? P : never]-?: T[P] }>
	: never;

/**
 * Removes `null` and `undefined` from the types of the keys `K` of `T` (all keys by default). Optional keys stay optional.
 * @template T - The object type
 * @template K - The keys whose types lose `null` and `undefined`
 * @example
 * type Row = { id: number | null; note: string | null };
 * type Saved = SetNonNullable<Row, 'id'>; // { id: number; note: string | null }
 */
export type SetNonNullable<T, K extends keyof T = keyof T> = { [P in keyof T]: P extends K ? NonNullable<T[P]> : T[P] };

/**
 * A union of literal types `L` that still accepts any other value of the primitive type `Base`, without losing editor
 * autocompletion for the literals (a plain `'a' | 'b' | string` collapses to `string`).
 * @template L - The suggested literal values
 * @template Base - The primitive type of the accepted values
 * @example
 * type Pet = LiteralUnion<'dog' | 'cat', string>;
 * const pet: Pet = 'hamster'; // allowed, while 'dog' and 'cat' are still suggested
 */
export type LiteralUnion<L extends Base, Base extends Primitive> = L | (Base & Record<never, never>);

declare const tagSymbol: unique symbol;

/**
 * The type-level container that carries the tags of a {@link Tagged} type.
 */
interface TagContainer<Tags> {
	readonly [tagSymbol]: Tags;
}

/**
 * A nominal ("branded") version of `T`: a `Tagged<string, 'UserId'>` is still a string, but a plain string (or another tag) is not
 * assignable to it. Tags stack: `Tagged<Tagged<string, 'Email'>, 'Trimmed'>` is assignable to both tagged types. The optional
 * `Meta` attaches type-level metadata to the tag. The tag only exists in the type system.
 * @template T - The underlying type
 * @template Tag - The tag name
 * @template Meta - Metadata stored with the tag
 * @example
 * type UserId = Tagged<string, 'UserId'>;
 * const id = 'u_1' as UserId;
 * const raw: string = id; // fine: a UserId is a string
 * // const wrong: UserId = 'u_2'; // error: a plain string is not a UserId
 */
export type Tagged<T, Tag extends PropertyKey, Meta = never> = T & TagContainer<{ [K in Tag]: Meta }>;

/**
 * Removes every tag from a {@link Tagged} type: `UnwrapTagged<Tagged<Tagged<string, 'A'>, 'B'>>` is `string`.
 * @template T - The tagged type
 * @example
 * type UserId = Tagged<string, 'UserId'>;
 * type Raw = UnwrapTagged<UserId>; // string
 */
export type UnwrapTagged<T extends TagContainer<unknown>> = RemoveTags<T>;

/**
 * Strips the tags of `T` one at a time (the implementation of {@link UnwrapTagged}).
 */
type RemoveTags<T> = T extends TagContainer<infer Tags> ? { [K in keyof Tags]: T extends Tagged<infer U, K, Tags[K]> ? RemoveTags<U> : never }[keyof Tags] : T;

/**
 * The union of the value types of `T` (optionally only of the keys `K`): `keyof` for values.
 * @template T - The object type
 * @template K - The keys whose values to take (all of them by default)
 * @example
 * type Status = ValueOf<{ ok: 200; created: 201 }>; // 200 | 201
 */
export type ValueOf<T, K extends keyof T = keyof T> = T[K];

/**
 * `T` with the keys `K` removed, like `Omit`, except that `K` must be keys of `T`: a typo or a renamed property is a compile error
 * instead of a silent no-op. Keeps the `readonly` and `?` modifiers.
 * @template T - The object type
 * @template K - The keys to remove
 * @example
 * type User = { id: number; name: string; password: string };
 * type Public = Except<User, 'password'>; // { id: number; name: string }
 * // type Typo = Except<User, 'pasword'>; // error, while Omit<User, 'pasword'> silently keeps password
 */
export type Except<T, K extends keyof T> = { [P in keyof T as P extends K ? never : P]: T[P] };

/**
 * `T` where at least one of the keys `K` (all keys by default) must be present.
 * @template T - The object type
 * @template K - The keys of which at least one is required
 * @example
 * type Contact = RequireAtLeastOne<{ email?: string; phone?: string; name: string }, 'email' | 'phone'>;
 * const contact: Contact = { name: 'Ada', phone: '555' }; // ok; { name: 'Ada' } alone is an error
 */
export type RequireAtLeastOne<T, K extends keyof T = keyof T> = {
	[P in K]-?: Expand<Except<T, K> & { [Q in keyof T as Q extends P ? Q : never]-?: T[Q] } & { [Q in keyof T as Q extends Exclude<K, P> ? Q : never]?: T[Q] }>;
}[K];

/**
 * `T` where exactly one of the keys `K` (all keys by default) must be present: providing two of them, or none, is an error.
 * @template T - The object type
 * @template K - The mutually exclusive keys
 * @example
 * type Source = RequireExactlyOne<{ url?: string; file?: string; label: string }, 'url' | 'file'>;
 * const source: Source = { label: 'logo', url: '/logo.svg' }; // ok; both url and file (or neither) is an error
 */
export type RequireExactlyOne<T, K extends keyof T = keyof T> = {
	[P in K]-?: Expand<Except<T, K> & { [Q in keyof T as Q extends P ? Q : never]-?: T[Q] } & { [Q in Exclude<K, P>]?: never }>;
}[K];

/**
 * `T` where the keys `K` (all keys by default) must be either all present or all absent.
 * @template T - The object type
 * @template K - The keys that go together
 * @example
 * type Auth = RequireAllOrNone<{ user?: string; password?: string; anonymous: boolean }, 'user' | 'password'>;
 * const guest: Auth = { anonymous: true }; // ok; a user without a password is an error
 */
export type RequireAllOrNone<T, K extends keyof T = keyof T> =
	| Expand<Except<T, K> & { [P in keyof T as P extends K ? P : never]-?: T[P] }>
	| Expand<Except<T, K> & { [P in K]?: never }>;

/**
 * Every key of every member of the union `T` (`keyof` on a union only keeps the keys that all members share).
 * @template T - The union of object types
 * @example
 * type Keys = KeysOfUnion<{ a: 1 } | { b: 2 }>; // 'a' | 'b' (keyof would give never)
 */
export type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * `Omit` applied to each member of the union `T` separately, so that a discriminated union stays discriminated. `K` may be any key
 * of any member. Keeps the `readonly` and `?` modifiers.
 * @template T - The union of object types
 * @template K - The keys to remove
 * @example
 * type Shape = { kind: 'circle'; radius: number; id: string } | { kind: 'square'; side: number; id: string };
 * type NewShape = DistributedOmit<Shape, 'id'>; // { kind: 'circle'; radius: number } | { kind: 'square'; side: number }
 */
export type DistributedOmit<T, K extends KeysOfUnion<T>> = T extends unknown ? { [P in keyof T as P extends K ? never : P]: T[P] } : never;

/**
 * `Pick` applied to each member of the union `T` separately, so that a discriminated union stays discriminated. `K` may be any key
 * of any member. Keeps the `readonly` and `?` modifiers.
 * @template T - The union of object types
 * @template K - The keys to keep
 * @example
 * type Shape = { kind: 'circle'; radius: number; id: string } | { kind: 'square'; side: number; id: string };
 * type Sizes = DistributedPick<Shape, 'kind' | 'radius' | 'side'>; // { kind: 'circle'; radius: number } | { kind: 'square'; side: number }
 */
export type DistributedPick<T, K extends KeysOfUnion<T>> = T extends unknown ? { [P in keyof T as P extends K ? P : never]: T[P] } : never;

/**
 * An array with at least one element, so that `array[0]` is a `T` rather than `T | undefined` (what `isNonEmptyArray` narrows a
 * mutable array to).
 * @template T - The element type
 * @example
 * function first<T>(items: NonEmptyArray<T>): T {
 * 	return items[0];
 * }
 * first([1, 2]); // ok; first([]) is an error
 */
export type NonEmptyArray<T> = [T, ...T[]];

/**
 * A value or a promise (any thenable) of it: the type of a callback that may be synchronous or asynchronous.
 * @template T - The value type
 * @example
 * type SaveHandler = () => Promisable<void>; // may return nothing or a promise
 */
export type Promisable<T> = T | PromiseLike<T>;

/**
 * A single value or a (readonly) array of values: the type of an argument that accepts both.
 * @template T - The value type
 * @example
 * type ClassNames = Arrayable<string>; // 'btn' and ['btn', 'primary'] are both accepted
 */
export type Arrayable<T> = T | readonly T[];

/**
 * `true` when `A` and `B` are exactly the same type (so `any`, `unknown` and `never` only equal themselves, and `readonly` or `?`
 * modifiers count), otherwise `false`. An intersection such as `{ a: 1 } & { b: 2 }` is not identical to the flattened `{ a: 1; b: 2 }`.
 * @template A - The first type
 * @template B - The second type
 * @example
 * type Yes = IsEqual<{ a: 1 }, { a: 1 }>; // true
 * type No = IsEqual<{ a: 1 }, { readonly a: 1 }>; // false
 */
export type IsEqual<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/**
 * `true` when `T` is `any`, otherwise `false`.
 * @template T - The type to test
 * @example
 * type Yes = IsAny<any>; // true
 * type No = IsAny<unknown>; // false
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * `true` when `T` is `never`, otherwise `false` (a naive `T extends never` distributes and gives `never` instead).
 * @template T - The type to test
 * @example
 * type Yes = IsNever<never>; // true
 * type No = IsNever<undefined>; // false
 */
export type IsNever<T> = [T] extends [never] ? true : false;

/**
 * `true` when `T` is `unknown`, otherwise `false` (`any` and `{} | null | undefined` are not `unknown`).
 * @template T - The type to test
 * @example
 * type Yes = IsUnknown<unknown>; // true
 * type No = IsUnknown<any>; // false
 */
export type IsUnknown<T> = IsEqual<T, unknown>;

/**
 * An object with unknown values under any key: the safe alternative to `Record<string, any>` for "some object".
 * @example
 * type Payload = UnknownRecord; // values must be narrowed before use
 */
export type UnknownRecord = Record<PropertyKey, unknown>;

declare const emptyObjectSymbol: unique symbol;

/**
 * An object with no properties: `{}` is accepted, while objects with properties, arrays and primitives are not (unlike the
 * `{}` type, which accepts anything but `null` and `undefined`).
 * @example
 * const empty: EmptyObject = {}; // ok
 * // const full: EmptyObject = { a: 1 }; // error
 */
export type EmptyObject = { [emptyObjectSymbol]?: never };

/**
 * The element type of an iterable, an async iterable, an array or a generator.
 * @template T - The (async) iterable type
 * @example
 * type Item = IterableElement<Set<'a' | 'b'>>; // 'a' | 'b'
 * type Chunk = IterableElement<AsyncGenerator<Uint8Array>>; // Uint8Array
 */
export type IterableElement<T> = T extends Iterable<infer U> ? U : T extends AsyncIterable<infer U> ? U : never;

/**
 * The resolved return type of an async function (or of any function returning a thenable).
 * @template F - The async function type
 * @example
 * declare function loadUser(): Promise<{ id: number }>;
 * type User = AsyncReturnType<typeof loadUser>; // { id: number }
 */
export type AsyncReturnType<F extends (...args: never[]) => PromiseLike<unknown>> = Awaited<ReturnType<F>>;

/**
 * Values that `JSON.stringify` drops from objects and turns into `null` in arrays.
 */
type NotJsonable = undefined | symbol | AnyFunction;

/**
 * {@link Jsonify} for one member of an array: what `JSON.stringify` drops from objects becomes `null`.
 */
type JsonifyElement<T> = unknown extends T ? T : T extends NotJsonable ? null : Jsonify<T>;

/**
 * {@link Jsonify} for a plain object: symbol keys and keys that can only hold dropped values disappear, keys that may hold a dropped
 * value become optional.
 */
type JsonifyObject<T> = Expand<
	{ [K in keyof T as K extends symbol ? never : [Extract<T[K], NotJsonable>] extends [never] ? K : never]: Jsonify<T[K]> } & {
		[K in keyof T as K extends symbol ? never : [Exclude<T[K], NotJsonable>] extends [never] ? never : [Extract<T[K], NotJsonable>] extends [never] ? never : K]?: Jsonify<
			Exclude<T[K], NotJsonable>
		>;
	}
>;

/**
 * The type of `JSON.parse(JSON.stringify(value))` for a `value` of type `T`: `toJSON()` is honoured (a `Date` becomes a `string`),
 * properties holding `undefined`, functions or symbols are dropped (or become optional when they only may), such array elements
 * become `null`, `Map`, `Set` and `RegExp` become empty objects, symbol keys disappear and `bigint` (which throws) becomes
 * `never`. `unknown` and `any` are returned as they are. Class instances are approximated by their declared non-function properties.
 * @template T - The type of the value passed to `JSON.stringify`
 * @example
 * type Post = { title: string; published: Date; draft?: boolean; render: () => string; tags: Set<string> };
 * type PostJson = Jsonify<Post>; // { title: string; published: string; draft?: boolean; tags: EmptyObject }
 */
export type Jsonify<T> = unknown extends T
	? T
	: T extends string | number | boolean | null
		? T
		: T extends { toJSON(): infer J }
			? Jsonify<J>
			: T extends NotJsonable | bigint
				? never
				: T extends ReadonlyArray<unknown>
					? { [K in keyof T]: JsonifyElement<T[K]> }
					: T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<object, unknown> | WeakSet<object> | RegExp
						? EmptyObject
						: JsonifyObject<T>;

/**
 * Either `A` or `B`, but not a mix of both: the keys that belong to only one side cannot appear together.
 * @template A - The first object type
 * @template B - The second object type
 * @example
 * type Paging = MergeExclusive<{ page: number }, { cursor: string }>;
 * const byPage: Paging = { page: 2 }; // ok; { page: 2, cursor: 'x' } is an error
 */
export type MergeExclusive<A, B> = [A | B] extends [object]
	? Expand<{ [K in Exclude<keyof A, keyof B>]?: never } & B> | Expand<{ [K in Exclude<keyof B, keyof A>]?: never } & A>
	: A | B;

/**
 * The keys of `T` whose value type is assignable to `C`. An optional property's type includes `undefined`, so it only matches a
 * condition that accepts `undefined`.
 * @template T - The object type
 * @template C - The condition the value types must satisfy
 * @example
 * type Handlers = ConditionalKeys<{ id: number; onClick: () => void; onHover: () => void }, AnyFunction>; // 'onClick' | 'onHover'
 */
export type ConditionalKeys<T, C> = { [K in keyof T]-?: T[K] extends C ? K : never }[keyof T];

/**
 * The properties of `T` whose value type is assignable to `C` (see {@link ConditionalKeys}), with their modifiers.
 * @template T - The object type
 * @template C - The condition the value types must satisfy
 * @example
 * type Strings = ConditionalPick<{ id: number; name: string; email: string }, string>; // { name: string; email: string }
 */
export type ConditionalPick<T, C> = Pick<T, ConditionalKeys<T, C>>;
