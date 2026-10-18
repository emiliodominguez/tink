// Compiled against the BUILT declarations by scripts/check-types.mjs: proves the published .d.ts files are valid for a
// consumer with no DOM or Node types (skipLibCheck off), resolve through the exports map, and stay cheap to type-check.
import { getFromObjectByKeys, setInObjectByKeys, deepMerge, merge, pick, omit } from '@emiliodominguez/js-helpers/objects';
import { curry, pipe, compose } from '@emiliodominguez/js-helpers/functions';
import type { NestedKeyOf, PathValue } from '@emiliodominguez/js-helpers/utils';
import { isShape, isString, isInteger, isOptional, isArrayOf, isUnion, isNullable, isTuple, toStandardSchema } from '@emiliodominguez/js-helpers/guards';
import type { Infer } from '@emiliodominguez/js-helpers/guards';
import type { StandardSchemaV1 } from '@standard-schema/spec';
// The root entry pulls in every module's declarations.
import * as everything from '@emiliodominguez/js-helpers';

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
const a = getFromObjectByKeys(org, 'owner.address.geo.meta.source');
const b = getFromObjectByKeys(org, 'billing.invoices.0.lines.3.qty');
const c = getFromObjectByKeys(org, 'members.2.posts.1.comments.0.author.address.city', 'n/a');
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
setInObjectByKeys(org, 'owner.name', 'Ada');

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
export { a, b, c, keys, v, m, dm, p, o, r, f, g, everything, spec, output, wrong };
