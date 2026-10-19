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
