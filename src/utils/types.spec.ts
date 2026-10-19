import type {
	AnyFunction,
	Arrayable,
	AsyncReturnType,
	ConditionalKeys,
	ConditionalPick,
	DistributedOmit,
	DistributedPick,
	EmptyObject,
	Except,
	IsAny,
	IsEqual,
	IsNever,
	IsUnknown,
	IterableElement,
	Jsonify,
	KeysOfUnion,
	LiteralUnion,
	MergeExclusive,
	NestedKeyOf,
	NonEmptyArray,
	PartialDeep,
	PathValue,
	Promisable,
	RequireAllOrNone,
	RequireAtLeastOne,
	RequiredDeep,
	RequireExactlyOne,
	SetNonNullable,
	SetOptional,
	SetRequired,
	Tagged,
	UnknownRecord,
	UnwrapTagged,
	ValueOf,
	Writable,
	WritableDeep
} from './index.js';
import { isNonEmptyArray } from '../guards/index.js';

interface Sample {
	a: { b: { c: string } };
	list: { id: number }[];
	opt?: { deep: boolean };
	when: Date;
}

/**
 * Compile-time equality (independent of the `IsEqual` under test): modifiers, `any` and intersections are told apart.
 */
type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Fails to compile unless its type argument is `true`.
 */
function assertType<T extends true>(): T | undefined {
	return undefined;
}

/**
 * Accepts a value of type `T`: pair it with `@ts-expect-error` to prove that a value is rejected.
 */
function accept<T>(value: T): T {
	return value;
}

describe('utility types', function () {
	it('should compute nested keys and path values at compile time', function () {
		const keys: Array<NestedKeyOf<Sample>> = ['a', 'a.b', 'a.b.c', 'list', 'list.0', 'list.1.id', 'opt', 'opt.deep', 'when'];
		const checks: [
			Equals<PathValue<Sample, 'a.b.c'>, string>,
			Equals<PathValue<Sample, 'list.0.id'>, number | undefined>,
			Equals<PathValue<Sample, 'opt.deep'>, boolean | undefined>
		] = [true, true, true];

		expect(keys).toHaveLength(9);
		expect(checks).toEqual([true, true, true]);
	});

	describe('PartialDeep', function () {
		interface Settings {
			readonly theme: { mode: 'light' | 'dark'; accent: string };
			tags: [string, number];
			list: { id: number; name: string }[];
			frozen: ReadonlyArray<{ id: number }>;
			lookup: Map<string, { a: number }>;
			view: ReadonlyMap<string, { a: number }>;
			ids: Set<{ id: number }>;
			roIds: ReadonlySet<{ id: number }>;
			when: Date;
			pattern: RegExp;
			onChange: (value: string) => void;
			bytes: Uint8Array;
			pending: Promise<{ a: number }>;
			maybe: { x: number } | null;
		}

		it('should recurse through objects, arrays, tuples, maps and sets', function () {
			type P = PartialDeep<Settings>;
			assertType<Equals<P['theme'], { mode?: 'light' | 'dark'; accent?: string } | undefined>>();
			assertType<Equals<P['tags'], [string?, number?] | undefined>>();
			assertType<Equals<P['list'], { id?: number; name?: string }[] | undefined>>();
			assertType<Equals<P['frozen'], ReadonlyArray<{ id?: number }> | undefined>>();
			assertType<Equals<P['lookup'], Map<string, { a?: number }> | undefined>>();
			assertType<Equals<P['view'], ReadonlyMap<string, { a?: number }> | undefined>>();
			assertType<Equals<P['ids'], Set<{ id?: number }> | undefined>>();
			assertType<Equals<P['roIds'], ReadonlySet<{ id?: number }> | undefined>>();
			assertType<Equals<P['maybe'], { x?: number } | null | undefined>>();
			assertType<Equals<keyof P, keyof Settings>>();
			// The readonly modifier is kept.
			// @ts-expect-error -- theme stays readonly
			accept<P>({}).theme = {};
		});

		it('should leave primitives, functions, dates, regexps, typed arrays and promises alone', function () {
			type P = PartialDeep<Settings>;
			assertType<Equals<P['when'], Date | undefined>>();
			assertType<Equals<P['pattern'], RegExp | undefined>>();
			assertType<Equals<P['onChange'], ((value: string) => void) | undefined>>();
			assertType<Equals<P['bytes'], Uint8Array | undefined>>();
			assertType<Equals<P['pending'], Promise<{ a: number }> | undefined>>();
			assertType<Equals<PartialDeep<string>, string>>();
			assertType<Equals<PartialDeep<'a' | 1 | null | undefined>, 'a' | 1 | null | undefined>>();
			assertType<Equals<PartialDeep<unknown>, unknown>>();
			assertType<Equals<PartialDeep<string[]>, string[]>>();
			assertType<Equals<PartialDeep<WeakMap<object, { a: 1 }>>, WeakMap<object, { a: 1 }>>>();
		});

		it('should recurse into objects that structurally resemble leaves', function () {
			// A Set of objects is structurally a WeakSet, and an object with name and message is structurally an Error.
			assertType<Equals<PartialDeep<Set<{ a: 1 }>>, Set<{ a?: 1 }>>>();
			assertType<Equals<PartialDeep<Map<object, { a: 1 }>>, Map<object, { a?: 1 }>>>();
			assertType<Equals<PartialDeep<{ name: string; message: string; data: { a: 1 } }>, { name?: string; message?: string; data?: { a?: 1 } }>>();
			assertType<Equals<WritableDeep<Set<{ readonly a: 1 }>>, Set<{ a: 1 }>>>();
			assertType<Equals<RequiredDeep<Set<{ a?: 1 }>>, Set<{ a: 1 }>>>();
		});

		it('should accept partial values and reject wrong types', function () {
			accept<PartialDeep<Settings>>({});
			accept<PartialDeep<Settings>>({ theme: { mode: 'dark' }, tags: ['x'], list: [{ id: 1 }, {}] });
			// @ts-expect-error -- mode is still constrained
			accept<PartialDeep<Settings>>({ theme: { mode: 'blue' } });
			// @ts-expect-error -- unknown nested property
			accept<PartialDeep<Settings>>({ theme: { size: 1 } });
			// @ts-expect-error -- the tuple keeps its length
			accept<PartialDeep<Settings>>({ tags: ['x', 1, 2] });
		});
	});

	describe('RequiredDeep', function () {
		interface Config {
			server?: { port?: number; host?: string | undefined; readonly tls?: { cert?: string } };
			explicit: string | undefined;
			tuple?: [string?, number?];
			list?: ({ id?: number } | undefined)[];
			map?: Map<string, { a?: number }>;
			roMap?: ReadonlyMap<string, { a?: number }>;
			set?: Set<{ a?: number }>;
			roSet?: ReadonlySet<{ a?: number }>;
			when?: Date;
			fn?: () => void;
		}

		it('should make every nested property required', function () {
			type R = RequiredDeep<Config>;
			assertType<Equals<R['server'], { port: number; host: string; readonly tls: { cert: string } }>>();
			assertType<Equals<R['tuple'], [string, number]>>();
			// Like the built-in Required, array elements lose undefined.
			assertType<Equals<R['list'], { id: number }[]>>();
			assertType<Equals<R['map'], Map<string, { a: number }>>>();
			assertType<Equals<R['roMap'], ReadonlyMap<string, { a: number }>>>();
			assertType<Equals<R['set'], Set<{ a: number }>>>();
			assertType<Equals<R['roSet'], ReadonlySet<{ a: number }>>>();
			assertType<Equals<R['when'], Date>>();
			assertType<Equals<R['fn'], () => void>>();
		});

		it('should keep an explicit undefined on a required property', function () {
			assertType<Equals<RequiredDeep<Config>['explicit'], string | undefined>>();
			assertType<Equals<RequiredDeep<number | null>, number | null>>();
			assertType<Equals<RequiredDeep<unknown>, unknown>>();
			assertType<Equals<WritableDeep<unknown>, unknown>>();
			assertType<Equals<WritableDeep<string | null>, string | null>>();
		});

		it('should reject values missing nested properties', function () {
			accept<RequiredDeep<{ a?: { b?: number } }>>({ a: { b: 1 } });
			// @ts-expect-error -- b is now required
			accept<RequiredDeep<{ a?: { b?: number } }>>({ a: {} });
			// @ts-expect-error -- a is now required
			accept<RequiredDeep<{ a?: { b?: number } }>>({});
		});
	});

	describe('Writable and WritableDeep', function () {
		interface Point {
			readonly x: number;
			readonly y?: number;
			z: number;
		}

		it('should remove readonly from all keys or the selected ones', function () {
			assertType<Equals<Writable<Point>, { x: number; y?: number; z: number }>>();
			assertType<Equals<Writable<Point, 'x'>, { x: number; readonly y?: number; z: number }>>();
			assertType<Equals<Writable<readonly string[]>, string[]>>();
			assertType<Equals<Writable<readonly [1, 2]>, [1, 2]>>();
			const point = accept<Writable<Point, 'x'>>({ x: 1, z: 2 });
			point.x = 3;
			// @ts-expect-error -- y stays readonly
			point.y = 3;
			// @ts-expect-error -- only keys of Point
			accept<Writable<Point, 'w'>>({ x: 1, z: 2 });
		});

		it('should remove readonly recursively', function () {
			interface State {
				readonly user: { readonly tags: readonly string[]; readonly pair: readonly [number, { readonly a: 1 }] };
				readonly index: ReadonlyMap<string, { readonly n: number }>;
				readonly seen: ReadonlySet<{ readonly n: number }>;
				readonly when: Date;
			}
			type W = WritableDeep<State>;
			assertType<Equals<W['user'], { tags: string[]; pair: [number, { a: 1 }] }>>();
			assertType<Equals<W['index'], Map<string, { n: number }>>>();
			assertType<Equals<W['seen'], Set<{ n: number }>>>();
			assertType<Equals<W['when'], Date>>();
			const state = accept<W>({ user: { tags: [], pair: [1, { a: 1 }] }, index: new Map(), seen: new Set(), when: new Date(0) });
			state.user.tags.push('a');
			state.user.pair[1].a = 1;
			expect(state.user.tags).toEqual(['a']);
		});
	});

	describe('SetOptional, SetRequired and SetNonNullable', function () {
		interface User {
			readonly id: number;
			name: string;
			email?: string;
			note: string | null;
		}

		it('should change only the selected keys', function () {
			assertType<Equals<SetOptional<User, 'id' | 'name'>, { readonly id?: number; name?: string; email?: string; note: string | null }>>();
			assertType<Equals<SetRequired<User, 'email'>, { readonly id: number; name: string; email: string; note: string | null }>>();
			assertType<Equals<SetNonNullable<User, 'note'>, { readonly id: number; name: string; email?: string; note: string }>>();
			assertType<Equals<SetNonNullable<User>, { readonly id: number; name: string; email?: string; note: string }>>();
		});

		it('should distribute over unions', function () {
			type Shape = { kind: 'a'; size?: number } | { kind: 'b'; size?: number; label: string };
			assertType<Equals<SetRequired<Shape, 'size'>, { kind: 'a'; size: number } | { kind: 'b'; size: number; label: string }>>();
		});

		it('should reject unknown keys and missing required keys', function () {
			accept<SetOptional<User, 'id'>>({ name: 'a', note: null });
			// @ts-expect-error -- email is now required
			accept<SetRequired<User, 'email'>>({ id: 1, name: 'a', note: null });
			// @ts-expect-error -- note can no longer be null
			accept<SetNonNullable<User, 'note'>>({ id: 1, name: 'a', note: null });
			// @ts-expect-error -- not a key of User
			accept<SetOptional<User, 'missing'>>({ id: 1, name: 'a', note: null });
		});
	});

	describe('LiteralUnion', function () {
		it('should accept the literals and any other value of the base type', function () {
			type Pet = LiteralUnion<'dog' | 'cat', string>;
			accept<Pet>('dog');
			accept<Pet>('hamster');
			accept<LiteralUnion<1 | 2, number>>(3);
			// @ts-expect-error -- not a string
			accept<Pet>(1);
			// The literals are kept in the type (that is what keeps autocompletion), unlike `'dog' | 'cat' | string`.
			assertType<Equals<Extract<Pet, 'dog'>, 'dog'>>();
		});
	});

	describe('Tagged and UnwrapTagged', function () {
		type UserId = Tagged<string, 'UserId'>;
		type OrderId = Tagged<string, 'OrderId'>;
		type Email = Tagged<Tagged<string, 'Email'>, 'Trimmed'>;
		type Meters = Tagged<number, 'Unit', { unit: 'm' }>;

		it('should keep the underlying type usable', function () {
			const id = 'u_1' as UserId;
			const raw: string = id;
			const length: number = (5 as Meters) + 1;
			expect(raw.toUpperCase()).toBe('U_1');
			expect(length).toBe(6);
		});

		it('should reject untagged values and other tags', function () {
			// @ts-expect-error -- a plain string is not a UserId
			accept<UserId>('u_1');
			// @ts-expect-error -- an OrderId is not a UserId
			accept<UserId>('o_1' as OrderId);
			// @ts-expect-error -- a different metadata is a different tag
			accept<Meters>(1 as Tagged<number, 'Unit', { unit: 'ft' }>);
		});

		it('should stack tags', function () {
			const email = 'a@b.c' as Email;
			accept<Tagged<string, 'Email'>>(email);
			accept<Tagged<string, 'Trimmed'>>(email);
			// @ts-expect-error -- a single tag is not both
			accept<Email>('a@b.c' as Tagged<string, 'Email'>);
		});

		it('should unwrap every tag', function () {
			assertType<Equals<UnwrapTagged<UserId>, string>>();
			assertType<Equals<UnwrapTagged<Email>, string>>();
			assertType<Equals<UnwrapTagged<Meters>, number>>();
			assertType<Equals<UnwrapTagged<Tagged<{ a: 1 }, 'A'>>, { a: 1 }>>();
			// @ts-expect-error -- only tagged types
			accept<UnwrapTagged<string> | undefined>(undefined);
		});
	});

	describe('ValueOf and KeysOfUnion', function () {
		it('should compute value and key unions', function () {
			assertType<Equals<ValueOf<{ ok: 200; created: 201 }>, 200 | 201>>();
			assertType<Equals<ValueOf<{ ok: 200; created: 201; gone: 410 }, 'ok' | 'gone'>, 200 | 410>>();
			assertType<Equals<ValueOf<readonly ['a', 'b'], number>, 'a' | 'b'>>();
			assertType<Equals<KeysOfUnion<{ a: 1 } | { b: 2; c: 3 }>, 'a' | 'b' | 'c'>>();
			assertType<Equals<KeysOfUnion<never>, never>>();
			// @ts-expect-error -- not a key
			accept<ValueOf<{ ok: 200 }, 'missing'> | undefined>(undefined);
		});
	});

	describe('Except, DistributedOmit and DistributedPick', function () {
		interface Account {
			readonly id: number;
			name?: string;
			password: string;
		}
		type Shape = { kind: 'circle'; radius: number; id: string } | { kind: 'square'; side: number; readonly id: string };

		it('should omit known keys and keep modifiers', function () {
			assertType<Equals<Except<Account, 'password'>, { readonly id: number; name?: string }>>();
			assertType<Equals<Except<{ [key: string]: number; a: 1 }, 'a'>, { [key: string]: number }>>();
			// @ts-expect-error -- a typo is an error, unlike with Omit
			accept<Except<Account, 'pasword'> | undefined>(undefined);
		});

		it('should omit and pick member by member', function () {
			assertType<Equals<DistributedOmit<Shape, 'id'>, { kind: 'circle'; radius: number } | { kind: 'square'; side: number }>>();
			assertType<Equals<DistributedOmit<Shape, 'radius'>, { kind: 'circle'; id: string } | { kind: 'square'; side: number; readonly id: string }>>();
			assertType<Equals<DistributedPick<Shape, 'kind' | 'radius'>, { kind: 'circle'; radius: number } | { kind: 'square' }>>();
			// Plain Omit collapses the union.
			assertType<Equals<keyof Omit<Shape, 'id'>, 'kind'>>();
			// @ts-expect-error -- not a key of any member
			accept<DistributedOmit<Shape, 'missing'> | undefined>(undefined);
			// @ts-expect-error -- the union stays discriminated: a circle has no side
			accept<DistributedOmit<Shape, 'id'>>({ kind: 'circle', side: 1 });
		});
	});

	describe('RequireAtLeastOne, RequireExactlyOne and RequireAllOrNone', function () {
		interface Contact {
			email?: string;
			phone?: string;
			readonly name: string;
		}

		it('should require at least one of the keys', function () {
			type C = RequireAtLeastOne<Contact, 'email' | 'phone'>;
			assertType<Equals<C, { readonly name: string; email: string; phone?: string } | { readonly name: string; phone: string; email?: string }>>();
			accept<C>({ name: 'a', email: 'e' });
			accept<C>({ name: 'a', phone: 'p' });
			accept<C>({ name: 'a', email: 'e', phone: 'p' });
			// @ts-expect-error -- neither key
			accept<C>({ name: 'a' });
			// @ts-expect-error -- every key by default
			accept<RequireAtLeastOne<{ a?: 1; b?: 2 }>>({});
			accept<RequireAtLeastOne<{ a?: 1; b?: 2 }>>({ b: 2 });
		});

		it('should require exactly one of the keys', function () {
			type C = RequireExactlyOne<Contact, 'email' | 'phone'>;
			accept<C>({ name: 'a', email: 'e' });
			accept<C>({ name: 'a', phone: 'p' });
			// @ts-expect-error -- both keys
			accept<C>({ name: 'a', email: 'e', phone: 'p' });
			// @ts-expect-error -- neither key
			accept<C>({ name: 'a' });
			// @ts-expect-error -- the other keys are still required
			accept<C>({ email: 'e' });
		});

		it('should require all or none of the keys', function () {
			type C = RequireAllOrNone<Contact, 'email' | 'phone'>;
			accept<C>({ name: 'a' });
			accept<C>({ name: 'a', email: 'e', phone: 'p' });
			// @ts-expect-error -- only one of them
			accept<C>({ name: 'a', email: 'e' });
			// @ts-expect-error -- only keys of Contact
			accept<RequireAllOrNone<Contact, 'missing'>>({ name: 'a' });
		});
	});

	describe('NonEmptyArray, Promisable and Arrayable', function () {
		it('should be what isNonEmptyArray narrows a mutable array to', function () {
			const list: number[] = [1];
			if (!isNonEmptyArray(list)) throw new Error('unreachable');
			assertType<Equals<typeof list, NonEmptyArray<number>>>();
			assertType<Equals<NonEmptyArray<number>, [number, ...number[]]>>();
			expect(list[0].toFixed()).toBe('1');
		});

		it('should type the first element of a non-empty array', function () {
			const items: NonEmptyArray<number> = [1, 2];
			const first: number = items[0];
			// @ts-expect-error -- an empty array is rejected
			accept<NonEmptyArray<number>>([]);
			expect(first).toBe(1);
		});

		it('should accept a value or a thenable / a value or an array', function () {
			accept<Promisable<number>>(1);
			accept<Promisable<number>>(Promise.resolve(1));
			// @ts-expect-error -- wrong value type
			accept<Promisable<number>>(Promise.resolve('1'));
			accept<Arrayable<string>>('a');
			accept<Arrayable<string>>(['a', 'b'] as const);
			// @ts-expect-error -- wrong element type
			accept<Arrayable<string>>([1]);
		});
	});

	describe('IsEqual, IsAny, IsNever and IsUnknown', function () {
		it('should compare types exactly', function () {
			assertType<IsEqual<{ a: 1; b: 2 }, { a: 1; b: 2 }>>();
			assertType<Equals<IsEqual<{ a: 1 } & { b: 2 }, { a: 1; b: 2 }>, false>>();
			assertType<IsEqual<string, string>>();
			assertType<IsEqual<never, never>>();
			assertType<IsEqual<any, any>>();
			assertType<Equals<IsEqual<string, any>, false>>();
			assertType<Equals<IsEqual<unknown, any>, false>>();
			assertType<Equals<IsEqual<{ a: 1 }, { readonly a: 1 }>, false>>();
			assertType<Equals<IsEqual<{ a?: 1 }, { a: 1 | undefined }>, false>>();
			assertType<Equals<IsEqual<1 | 2, 1>, false>>();
			assertType<Equals<IsEqual<never, undefined>, false>>();
			// @ts-expect-error -- not equal
			assertType<IsEqual<string, 'a'>>();
		});

		it('should detect any, never and unknown', function () {
			assertType<IsAny<any>>();
			assertType<Equals<IsAny<unknown>, false>>();
			assertType<Equals<IsAny<never>, false>>();
			assertType<Equals<IsAny<string>, false>>();
			assertType<IsNever<never>>();
			assertType<Equals<IsNever<undefined>, false>>();
			assertType<Equals<IsNever<any>, false>>();
			assertType<IsUnknown<unknown>>();
			assertType<Equals<IsUnknown<any>, false>>();
			assertType<Equals<IsUnknown<object | null | undefined>, false>>();
			assertType<Equals<IsUnknown<never>, false>>();
		});
	});

	describe('UnknownRecord and EmptyObject', function () {
		it('should accept any object as an UnknownRecord', function () {
			accept<UnknownRecord>({ a: 1, [Symbol.iterator]: 2 });
			// @ts-expect-error -- not an object
			accept<UnknownRecord>('a');
			// @ts-expect-error -- values are unknown
			accept<number>(accept<UnknownRecord>({}).a);
		});

		it('should only accept an empty object as an EmptyObject', function () {
			accept<EmptyObject>({});
			const full = { a: 1 };
			// @ts-expect-error -- has a property
			accept<EmptyObject>({ a: 1 });
			// @ts-expect-error -- has a property (not a fresh literal)
			accept<EmptyObject>(full);
			// @ts-expect-error -- an array
			accept<EmptyObject>([]);
			// @ts-expect-error -- a primitive
			accept<EmptyObject>(1);
			// @ts-expect-error -- null
			accept<EmptyObject>(null);
		});
	});

	describe('IterableElement and AsyncReturnType', function () {
		it('should extract element and resolved types', function () {
			assertType<Equals<IterableElement<Set<'a' | 'b'>>, 'a' | 'b'>>();
			assertType<Equals<IterableElement<readonly number[]>, number>>();
			assertType<Equals<IterableElement<Map<string, number>>, [string, number]>>();
			assertType<Equals<IterableElement<string>, string>>();
			assertType<Equals<IterableElement<Generator<1, void>>, 1>>();
			assertType<Equals<IterableElement<AsyncGenerator<Uint8Array>>, Uint8Array>>();
			assertType<Equals<IterableElement<AsyncIterable<{ a: 1 }>>, { a: 1 }>>();
			assertType<Equals<IterableElement<number>, never>>();
			assertType<Equals<AsyncReturnType<() => Promise<{ id: number }>>, { id: number }>>();
			assertType<Equals<AsyncReturnType<(a: string) => PromiseLike<Promise<1>>>, 1>>();
			// @ts-expect-error -- not an async function
			accept<AsyncReturnType<() => number> | undefined>(undefined);
		});
	});

	describe('Jsonify', function () {
		class Money {
			constructor(
				readonly amount: number,
				readonly currency: string
			) {}

			toJSON(): { amount: string; currency: string } {
				return { amount: String(this.amount), currency: this.currency };
			}
		}

		interface Post {
			title: string;
			published: Date;
			draft?: boolean;
			views: number | undefined;
			render: () => string;
			maybe: string | (() => string);
			[Symbol.iterator]: number;
			tags: Set<string>;
			meta: Map<string, number>;
			pattern: RegExp;
			price: Money;
			items: [Date, undefined, () => void, symbol | number];
			list: (string | undefined)[];
			nested: { at: Date; skip: undefined };
			readonly flags: readonly boolean[];
			anything: unknown;
		}

		it('should model JSON.stringify output', function () {
			type J = Jsonify<Post>;
			assertType<Equals<J['title'], string>>();
			assertType<Equals<J['published'], string>>();
			assertType<Equals<J['draft'], boolean | undefined>>();
			assertType<Equals<J['views'], number | undefined>>();
			assertType<Equals<J['maybe'], string | undefined>>();
			assertType<Equals<J['tags'], EmptyObject>>();
			assertType<Equals<J['meta'], EmptyObject>>();
			assertType<Equals<J['pattern'], EmptyObject>>();
			assertType<Equals<J['price'], { amount: string; currency: string }>>();
			assertType<Equals<J['items'], [string, null, null, number | null]>>();
			assertType<Equals<J['list'], (string | null)[]>>();
			assertType<Equals<J['nested'], { at: string }>>();
			assertType<Equals<J['flags'], readonly boolean[]>>();
			assertType<Equals<J['anything'], unknown>>();
			assertType<Equals<keyof J, Exclude<keyof Post, 'render' | typeof Symbol.iterator>>>();
			// Optional and possibly-dropped keys become optional.
			accept<J['nested']>({ at: '' });
			accept<Pick<J, 'draft' | 'views' | 'maybe'>>({});
		});

		it('should handle top-level values', function () {
			assertType<Equals<Jsonify<'a' | 1 | true | null>, 'a' | 1 | true | null>>();
			assertType<Equals<Jsonify<Date>, string>>();
			assertType<Equals<Jsonify<bigint>, never>>();
			assertType<Equals<Jsonify<undefined>, never>>();
			assertType<Equals<Jsonify<() => void>, never>>();
			assertType<Equals<Jsonify<string | undefined>, string>>();
			assertType<Equals<Jsonify<unknown>, unknown>>();
			assertType<IsAny<Jsonify<any>>>();
			assertType<Equals<Jsonify<{ a: bigint }>, { a: never }>>();
			assertType<Equals<Jsonify<WeakMap<object, 1>>, EmptyObject>>();
		});

		it('should match a real JSON round trip', function () {
			const post = {
				title: 't',
				at: new Date(0),
				skip: undefined,
				fn(): number {
					return 1;
				},
				list: [1, undefined]
			};
			const json: Jsonify<typeof post> = JSON.parse(JSON.stringify(post));
			const at: string = json.at;
			const list: (number | null)[] = json.list;
			// @ts-expect-error -- functions are dropped
			expect(json.fn).toBeUndefined();
			expect(json).toEqual({ title: 't', at: '1970-01-01T00:00:00.000Z', list: [1, null] });
			expect([at, list]).toEqual(['1970-01-01T00:00:00.000Z', [1, null]]);
		});
	});

	describe('MergeExclusive', function () {
		it('should accept either side but not both', function () {
			type Paging = MergeExclusive<{ page: number; size?: number }, { cursor: string; size?: number }>;
			accept<Paging>({ page: 1 });
			accept<Paging>({ cursor: 'x', size: 2 });
			// @ts-expect-error -- both sides
			accept<Paging>({ page: 1, cursor: 'x' });
			// @ts-expect-error -- neither side
			accept<Paging>({ size: 1 });
			assertType<Equals<MergeExclusive<string, number>, string | number>>();
		});
	});

	describe('ConditionalKeys and ConditionalPick', function () {
		interface Widget {
			readonly id: number;
			name: string;
			label?: string;
			onClick: () => void;
			onHover?: () => void;
		}

		it('should select keys by value type', function () {
			assertType<Equals<ConditionalKeys<Widget, string>, 'name'>>();
			assertType<Equals<ConditionalKeys<Widget, string | undefined>, 'name' | 'label'>>();
			assertType<Equals<ConditionalKeys<Widget, AnyFunction>, 'onClick'>>();
			assertType<Equals<ConditionalKeys<Widget, boolean>, never>>();
			assertType<Equals<ConditionalPick<Widget, number | string>, { readonly id: number; name: string }>>();
			assertType<Equals<ConditionalPick<Widget, AnyFunction | undefined>, { onClick: () => void; onHover?: () => void }>>();
		});
	});
});
