// The type-fest style utilities, compiled from the published declarations (exhaustive tests live in src/utils/types.spec.ts).
import type {
	Arrayable,
	Except,
	IsEqual,
	Jsonify,
	LiteralUnion,
	NonEmptyArray,
	PartialDeep,
	RequireExactlyOne,
	SetOptional,
	Tagged,
	UnwrapTagged,
	WritableDeep
} from 'tinkit/utils';
import type { EmptyObject as RootEmptyObject, IsNever } from 'tinkit';
import { isNonEmptyArray } from 'tinkit/guards';

interface Settings {
	readonly theme: { mode: 'light' | 'dark'; at: Date };
	readonly tags: readonly string[];
	retries?: number;
}

const patch: PartialDeep<Settings> = { theme: { mode: 'dark' } };
// @ts-expect-error mode is still constrained
const badPatch: PartialDeep<Settings> = { theme: { mode: 'blue' } };
const draft: WritableDeep<Settings> = { theme: { mode: 'light', at: new Date(0) }, tags: [] };
draft.tags.push('a');
const optional: SetOptional<Settings, 'theme'> = { tags: [] };
const pet: LiteralUnion<'dog' | 'cat', string> = 'hamster';
type UserId = Tagged<string, 'UserId'>;
// @ts-expect-error a plain string is not a UserId
const badId: UserId = 'u_1';
const raw: UnwrapTagged<UserId> = 'u_1';
const source: RequireExactlyOne<{ url?: string; file?: string }> = { url: '/a' };
// @ts-expect-error not both
const badSource: RequireExactlyOne<{ url?: string; file?: string }> = { url: '/a', file: 'a' };
const json: Jsonify<Settings> = { theme: { mode: 'dark', at: '1970-01-01T00:00:00.000Z' }, tags: [] };
// @ts-expect-error a key of Settings
type BadExcept = Except<Settings, 'missing'>;
const items: NonEmptyArray<number> = [1];
const list: number[] = [1];
const first: number | undefined = isNonEmptyArray(list) ? list[0] : undefined;
const names: Arrayable<string> = ['a'];
const empty: RootEmptyObject = {};
const checks: [IsEqual<Except<Settings, 'retries'>, Pick<Settings, 'theme' | 'tags'>>, IsNever<never>] = [true, true];
void [patch, badPatch, draft, optional, pet, badId, raw, source, badSource, json, items, first, names, empty, checks];
export type { BadExcept };
