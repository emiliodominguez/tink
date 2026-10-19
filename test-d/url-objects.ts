import { compilePath, matchPath } from 'tinkit/url';
import type { PathParams, PathBuilder, MatchPathOptions } from 'tinkit/url';
import { applyPatch, createPatch, JsonPatchError, replaceEqualDeep } from 'tinkit/objects';
import type { JsonPatchOperation } from 'tinkit/objects';

const route = matchPath('/users/:id/posts/:postId?/*rest', '/users/1/posts/2/a/b', { strict: true } satisfies MatchPathOptions);
if (route !== null) {
	const routeId: string = route.id;
	const routeRest: string = route.rest;
	const routePostId: string | undefined = route.postId;
	// @ts-expect-error `postId` is optional
	const requiredPostId: string = route.postId;
	// @ts-expect-error not a parameter of the pattern
	void route.missing;
	void [routeId, routeRest, routePostId, requiredPostId];
}
const unnamedSplat: PathParams<'/files/*'> = { '*': 'a/b' };
const userPath = compilePath('/users/:id/:tab?');
const builtPath: string = userPath({ id: 42, tab: 'posts' });
// @ts-expect-error `id` is required
userPath({ tab: 'posts' });
// @ts-expect-error parameters are strings or numbers
userPath({ id: true });
const aboutBuilder: PathBuilder<'/about'> = compilePath('/about');
const aboutPath: string = aboutBuilder();
const dynamicParam: string | undefined = matchPath('/x/:y' as string, '/x/1')?.y;

const sharedPatch: { a: number[] } = replaceEqualDeep({ a: [1] } as unknown, { a: [1, 2] });
const patch: JsonPatchOperation[] = createPatch({ a: 1 }, { a: 2 });
const patched: { a: number } = applyPatch({ a: 1 }, [...patch, { op: 'test', path: '/a', value: 2 }, { op: 'move', from: '/a', path: '/b' }]);
// @ts-expect-error a move needs `from`
applyPatch({ a: 1 }, [{ op: 'move', path: '/b' }]);
// @ts-expect-error unknown operation
applyPatch({ a: 1 }, [{ op: 'delete', path: '/a' }]);
const patchFailureIndex: number = new JsonPatchError('x', 0, { op: 'remove', path: '/a' }).index;
void [unnamedSplat, builtPath, aboutPath, dynamicParam, sharedPatch, patched, patchFailureIndex];

const either = '/a/:x' as '/a/:x' | '/b/:y';
const unionParams = matchPath(either, '/a/1');
if (unionParams !== null && 'x' in unionParams) {
	const unionX: string = unionParams.x;
	void unionX;
}
compilePath(either)({ x: 1 });
const templated: PathParams<`/users/${string}`> = { anything: 'x' };
// @ts-expect-error a parameter name cannot start with a digit (the runtime throws)
const badName: PathParams<'/:1abc'> = {};
// @ts-expect-error two parameters in one segment (the runtime throws)
const twoParams: PathParams<'/:a-:b'> = {};
// @ts-expect-error `options` must be an object
matchPath('/a', '/a', null);
void [templated, badName, twoParams];
