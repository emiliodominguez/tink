import { compilePath, matchPath, normalizeUrl, parseCookie, serializeCookie, tryParseUrl } from 'tinkit/url';
import type { PathParams, PathBuilder, MatchPathOptions, NormalizeUrlOptions, SerializeCookieOptions, UrlObject } from 'tinkit/url';
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
aboutBuilder({});
// @ts-expect-error a pattern without parameters takes no primitive (the runtime throws)
aboutBuilder(42);
// @ts-expect-error nor a string
aboutBuilder('x');
// @ts-expect-error nor unknown parameters
aboutBuilder({ id: 1 });
// @ts-expect-error an optional parameter does not make a primitive acceptable either
compilePath('/:lang?')(42);
// Builders without required parameters fit a route table of optional-parameter builders, and `PathBuilder<string>`.
const routeTable = { home: compilePath('/'), about: compilePath('/about'), docs: compilePath('/docs/:page?') } satisfies Record<
	string,
	(params?: Record<string, string>) => string
>;
const anyBuilder: PathBuilder<string> = compilePath('/about');
const linkTo: (params?: Record<string, string>) => string = compilePath('/about');
const unionBuilder: PathBuilder<'/a/:x?' | '/about'> = compilePath('/about');
// @ts-expect-error a builder that requires parameters does not fit a builder type with optional ones
const requiredLink: (params?: Record<string, string>) => string = compilePath('/users/:id');
void [routeTable, anyBuilder, linkTo, unionBuilder, requiredLink];
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
// @ts-expect-error a repeated name (the runtime throws)
compilePath('/:id/:id')({ id: 1 });
// @ts-expect-error a splat and a parameter with the same name
compilePath('/:id/*id')({ id: 1 });
// @ts-expect-error a splat must be the last segment
compilePath('/files/*path/raw')({ path: 'a' });
// @ts-expect-error not even a trailing slash follows a splat
compilePath('/files/*path/')({ path: 'a' });
// @ts-expect-error an empty segment
void matchPath('/a//:b', '/a/b')?.b;
// @ts-expect-error an empty pattern segment at the end
void matchPath('/:a//', '/a')?.a;
// @ts-expect-error a `#`
void matchPath('/a#:b', '/a')?.b;
// @ts-expect-error a dot segment
void matchPath('/:a/..', '/a')?.a;
// @ts-expect-error a percent-encoded dot segment
void matchPath('/:a/%2E?', '/a')?.a;
const distinctNames: PathParams<'/:a/:ab/*b'> = { a: '1', ab: '2', b: '3' };
const dotted: PathParams<'/.well-known/:file.json'> = { file: 'x' };
void [templated, badName, twoParams, distinctNames, dotted];
// A builder without parameters keeps an optional parameter for Parameters<> and inference.
const noArguments: Parameters<PathBuilder<'/about'>> = [];
declare const routes: { home: PathBuilder<'/'>; user: PathBuilder<'/users/:id'> };
declare function routeLink<K extends keyof typeof routes>(name: K, ...params: Parameters<(typeof routes)[K]>): string;
const homeLink: string = routeLink('home');
const userLink: string = routeLink('user', { id: 1 });
declare const maybePage: string | undefined;
const pageLink: string = compilePath('/docs/:page?')({ page: maybePage });
void [noArguments, homeLink, userLink, pageLink];

// Cookies, normalizeUrl and tryParseUrl in a type environment without a global `URL` (UrlObject falls back to a structural type).
const cookies: Record<string, string> = parseCookie('a=1');
const setCookie: string = serializeCookie('a', 'b', { sameSite: 'lax', priority: 'high', maxAge: 60, expires: new Date(0) } satisfies SerializeCookieOptions);
// @ts-expect-error sameSite is lowercase
serializeCookie('a', 'b', { sameSite: 'Lax' });
const normalized: string = normalizeUrl('https://x/', { removeQueryParams: ['a', /^utm_/] } satisfies NormalizeUrlOptions);
const parsedUrl: UrlObject | undefined = tryParseUrl('https://x/', 'https://y/');
const parsedPath: string | undefined = parsedUrl?.pathname;
const reparsed: string = normalizeUrl(parsedUrl as UrlObject) + String(tryParseUrl(parsedUrl as UrlObject)?.searchParams.get('q'));
void [cookies, setCookie, normalized, parsedPath, reparsed];
