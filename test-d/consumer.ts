// Compiled against the BUILT declarations by scripts/check-types.mjs: proves the published .d.ts files are valid for a
// consumer with no DOM or Node types (skipLibCheck off), resolve through the exports map, and stay cheap to type-check.
import { getPath, setPath, deepMerge, merge, pick, omit, toCamelCaseKeys } from 'tinkit/objects';
import { curry, pipe, compose } from 'tinkit/functions';
import { bound, debounced, log, memoize, once, retryable } from 'tinkit/decorators';
import type { NestedKeyOf, PathValue } from 'tinkit/utils';
import {
	isShape,
	isString,
	isInteger,
	isOptional,
	isArrayOf,
	isUnion,
	isNullable,
	isTuple,
	toStandardSchema,
	isDiscriminatedUnion,
	isFiniteNumber,
	isIntegerInRange,
	isOneOf,
	issuesByPath
} from 'tinkit/guards';
import type { Infer } from 'tinkit/guards';
import {
	arrayOf,
	asArray,
	asBigInt,
	asBoolean,
	asDate,
	asInteger,
	asJson,
	asList,
	asNumber,
	chain,
	check,
	discriminatedUnion,
	exact,
	isUrl,
	lazy,
	optional,
	parse,
	partial,
	recordOf,
	safeParse,
	toParser,
	transform,
	tuple,
	union,
	withDefault,
	withError,
	withFallback
} from 'tinkit/validate';
import type { Parser, Schema, SchemaOutput } from 'tinkit/validate';
import type { StandardSchemaV1 } from '@standard-schema/spec';
// The root entry pulls in every module's declarations.
import * as everything from 'tinkit';

interface Address {
	street: string;
	city: string;
	geo: { lat: number; lng: number; meta: { source: string; accuracy: number } };
}
interface Post {
	id: number;
	title: string;
	tags: string[];
	comments: Array<{ id: number; author: User; body: string }>;
}
interface User {
	id: number;
	name: string;
	email: string;
	address: Address;
	posts: Post[];
	friends: User[];
	settings: Record<string, { enabled: boolean; value: string }>;
}
interface Org {
	id: string;
	owner: User;
	members: User[];
	billing: { plan: string; seats: number; invoices: Array<{ id: string; amount: number; lines: Array<{ sku: string; qty: number }> }> };
}

declare const org: Org;
const a = getPath(org, 'owner.address.geo.meta.source');
const b = getPath(org, 'billing.invoices.0.lines.3.qty');
const c = getPath(org, 'members.2.posts.1.comments.0.author.address.city', 'n/a');
type K = NestedKeyOf<Org>;
const keys: K[] = ['owner', 'billing.plan'];
type V = PathValue<Org, 'owner.friends.0.posts.0.comments.0.author.name'>;
const v: V = 'x';
const m = merge({ a: 1 }, { b: 'x' }, { c: true }, { d: [1] }, { e: { f: 1 } });
const dm = deepMerge(org, { billing: { seats: 3 } });
const p = pick(org, ['id', 'owner']);
const o = omit(org, ['members']);
const add3 = curry(function (x: number, y: number, z: number): number {
	return x + y + z;
});
const r = add3(1)(2)(3);
const f = pipe(
	function (x: number) {
		return x + 1;
	},
	String,
	function (s: string) {
		return s.length;
	},
	function (n: number) {
		return n > 1;
	}
);
const g = compose(String, function (x: number) {
	return x * 2;
});
setPath(org, 'owner.name', 'Ada');

// Guards double as Standard Schema validators: assignable to the official spec type, with the inferred output.
const isAccount = isShape({
	id: isUnion(isString, isInteger),
	email: isOptional(isString),
	tags: isArrayOf(isString),
	manager: isNullable(isShape({ id: isInteger })),
	position: isTuple(isInteger, isInteger)
});
type Account = Infer<typeof isAccount>;
const account: Account = { id: 1, tags: [], manager: null, position: [0, 0] };
account.tags.push('mutable');
const spec: StandardSchemaV1<unknown, Account> = toStandardSchema(isAccount);
type SpecOutput = StandardSchemaV1.InferOutput<typeof spec>;
const output: SpecOutput = { id: 'a', email: 'x', tags: ['t'], manager: { id: 2 }, position: [1, 2] };
// @ts-expect-error `id` must be a string or a number
const wrong: Account = { id: true, tags: [], manager: null, position: [0, 0] };

// Discriminated unions add the tag to each variant's type.
const isFigure = isDiscriminatedUnion('type', { circle: isShape({ radius: isFiniteNumber }), square: isShape({ side: isFiniteNumber }) });
type Figure = Infer<typeof isFigure>;
const figure: Figure = { type: 'circle', radius: 1 };
// @ts-expect-error a square has a side, not a radius
const badFigure: Figure = { type: 'square', radius: 1 };

// Parsers: the output type follows coercions, defaults, transforms and nesting; guards mix in.
const envSchema = {
	PORT: withDefault(chain(asInteger, isIntegerInRange(1, 65535)), 3000),
	DEBUG: withDefault(asBoolean, false),
	DATABASE_URL: isUrl,
	STARTED: optional(asDate),
	TAGS: withDefault(arrayOf(isString), function (): string[] {
		return [];
	}),
	NAME_LENGTH: transform(isString, function (name) {
		return name.length;
	}),
	owner: { id: asInteger, email: isOptional(isString) }
};
type Env = SchemaOutput<typeof envSchema>;
type ExpectedEnv = {
	PORT: number;
	DEBUG: boolean;
	DATABASE_URL: string;
	STARTED?: Date | undefined;
	TAGS: string[];
	NAME_LENGTH: number;
	owner: { id: number; email?: string | undefined };
};
const env: ExpectedEnv = parse(envSchema, {});
const envBack: Env = env;
// @ts-expect-error PORT is parsed to a number
const envWrong: Env = { ...env, PORT: '80' };
const [envError, parsedEnv] = safeParse(envSchema, {});
const port: number | undefined = envError === undefined ? parsedEnv.PORT : undefined;
const envSpec: StandardSchemaV1<unknown, Env> = toParser(envSchema);
// @ts-expect-error the default must match the schema's output
const badDefault = withDefault(asInteger, 'x');

// Unions, records, tuples and recursion keep precise output types.
const event = discriminatedUnion('type', { click: { x: asInteger }, key: { code: isString }, 1: { legacy: asBoolean } });
type Event = SchemaOutput<typeof event>;
const click: Event = { type: 'click', x: 1 };
const legacy: Event = { type: '1', legacy: true };
// @ts-expect-error a key event has a code, not coordinates
const badEvent: Event = { type: 'key', x: 1 };
const shapes = { id: union(asInteger, isString), point: tuple(asNumber, asNumber), scores: recordOf(asInteger), tags: asArray(isString), meta: asJson({ v: asInteger }) };
const parsedShapes: { id: number | string; point: [number, number]; scores: Record<string, number>; tags: string[]; meta: { v: number } } = parse(shapes, {});
const locales: Partial<Record<'en' | 'fr', string>> = parse(recordOf(isString, isOneOf(['en', 'fr'])), {});
type Category = { name: string; children: Category[] };
const category: Parser<Category> = lazy(function () {
	return { name: isString, children: arrayOf(category) };
});
const patch: { name?: string | undefined; age?: number | undefined } = parse(partial({ name: isString, age: asInteger }), {});
const strict: { x: number } = parse(exact({ x: asNumber }), {});
const fieldErrors: Record<string, string[]> = issuesByPath([]);
// The helpers for forms, query strings and environment variables keep the output type of their schema.
const signUp = check({ password: isString, confirm: isString }, function (form) {
	return form.password === form.confirm;
});
const formTypes: { password: string; confirm: string } = parse(signUp, {});
const extras: { page: number; ids: bigint[]; origins: string[]; age: number } = parse(
	{ page: withFallback(asInteger, 1), ids: asList(asBigInt), origins: asList(isUrl), age: withError(asInteger, 'Enter your age') },
	{}
);
// @ts-expect-error the fallback must match the schema's output
const badFallback = withFallback(asInteger, 'x');
// A schema only known as a `Schema` outputs `unknown`, never `any`.
declare const someSchema: Schema;
// @ts-expect-error the output must be narrowed before use
const unknownOutput: number = parse(someSchema, 1).length;

// README tour: key transforms keep their value types.
const camel: { userId: number; createdAt: string } = toCamelCaseKeys({ user_id: 1, created_at: '2024-01-01' });
// @ts-expect-error the snake_case key no longer exists
const snake = camel.user_id;
// Standard (TC39) method decorators accept methods that declare their `this` type, and still reject getters.
class Counter {
	count = 1;
	@log @memoize @once @debounced(10) add(this: Counter, n: number): number {
		return this.count + n;
	}
	@bound read(this: Counter): number {
		return this.count;
	}
	@retryable() async load(this: Counter): Promise<number> {
		return this.count;
	}
	// @ts-expect-error a getter is not a method
	@log get value(): number {
		return this.count;
	}
}
export { a, b, c, keys, v, m, dm, p, o, r, f, g, everything, spec, output, wrong, camel, snake, Counter };
export { figure, badFigure, envBack, envWrong, port, envSpec, badDefault };
export { click, legacy, badEvent, parsedShapes, locales, category, patch, strict, fieldErrors, formTypes, extras, badFallback, unknownOutput };
