import {
	buildQueryString,
	cleanDoubleSlashes,
	getQueryParam,
	isAbsoluteUrl,
	isSafeUrl,
	joinUrl,
	matchPath,
	parseQueryString,
	safeDecodeURIComponent,
	withBase,
	withFragment,
	withLeadingSlash,
	withoutBase,
	withoutFragment,
	withoutLeadingSlash,
	withoutQuery,
	withoutTrailingSlash,
	withQuery,
	withTrailingSlash
} from 'tinkit/url';
import * as ufo from 'ufo';

// Competitors: what users naturally write with the platform's URLSearchParams / URL (no library in this category is installed).
const query = '?q=hello+world&page=2&sort=desc&tag=a&tag=b&ids[]=1&ids[]=2&empty&utm_source=newsletter&ref=%C3%A9t%C3%A9';
const smallQuery = 'q=shoes&page=2&sort=price';
const bigQuery = Array.from({ length: 100 }, function (_, index) {
	return `key${index}=value%20${index}${index % 10 === 0 ? `&key${index}=dup` : ''}`;
}).join('&');
const unicodeQuery = 'q=%E6%97%A5%E6%9C%AC%E8%AA%9E&city=S%C3%A3o+Paulo&emoji=%F0%9F%91%8D%F0%9F%8F%BD&name=Cr%C3%A8me+br%C3%BBl%C3%A9e';
const params = { q: 'hello world', page: 2, sort: 'desc', tags: ['a', 'b', 'c'], active: true, since: new Date(Date.UTC(2024, 0, 1)), skip: undefined, none: null };
const smallParams = { q: 'shoes', page: 2, sort: 'price' };
const bigParams = Object.fromEntries(
	Array.from({ length: 100 }, function (_, index) {
		return [`key${index}`, index % 10 === 0 ? [`value ${index}`, 'dup'] : `value ${index}`];
	})
);
const unicodeParams = { q: '日本語', city: 'São Paulo', emoji: '👍🏽', name: 'Crème brûlée' };
const url = 'https://example.com/search?q=old&page=2&sort=asc#results';
const update = { q: 'new value', page: null, lang: 'en' };

/**
 * The usual hand-written parser: URLSearchParams, collecting repeated keys into arrays.
 * @param {string} search - The query string
 * @returns {Record<string, string | string[]>} The parsed query
 */
function nativeParse(search) {
	const result = {};
	for (const [key, value] of new URLSearchParams(search)) {
		const existing = result[key];
		if (existing === undefined) result[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}
	return result;
}

/**
 * The usual hand-written serializer: URLSearchParams with `append` for arrays, skipping null/undefined.
 * @param {Record<string, unknown>} values - The parameters
 * @returns {string} The query string
 */
function nativeBuild(values) {
	const search = new URLSearchParams();
	for (const key of Object.keys(values)) {
		const value = values[key];
		if (value == null) continue;
		if (Array.isArray(value)) for (const item of value) search.append(key, String(item));
		else search.append(key, value instanceof Date ? value.toISOString() : String(value));
	}
	return search.toString();
}

/**
 * The usual hand-written `withQuery`: parse with URL, set/delete, serialize.
 * @param {string} href - An absolute URL
 * @param {Record<string, unknown>} values - The parameters to set (`null` deletes)
 * @returns {string} The new URL
 */
function nativeWithQuery(href, values) {
	const target = new URL(href);
	for (const key of Object.keys(values)) {
		const value = values[key];
		if (value === undefined) continue;
		if (value === null) target.searchParams.delete(key);
		else target.searchParams.set(key, String(value));
	}
	return target.toString();
}

/**
 * Builds a case comparing our parser with URLSearchParams.
 * @param {string} name - The case name
 * @param {string} search - The query string
 * @returns {object} The case
 */
function parseCase(name, search) {
	return {
		name: `parseQueryString (${name})`,
		fn: function () {
			return parseQueryString(search);
		},
		competitors: {
			'URLSearchParams loop': function () {
				return nativeParse(search);
			},
			'Object.fromEntries(URLSearchParams)': function () {
				return Object.fromEntries(new URLSearchParams(search));
			}
		}
	};
}

/**
 * Builds a case comparing our serializer with URLSearchParams.
 * @param {string} name - The case name
 * @param {object} values - The parameters
 * @returns {object} The case
 */
function buildCase(name, values) {
	return {
		name: `buildQueryString (${name})`,
		fn: function () {
			return buildQueryString(values);
		},
		competitors: {
			'URLSearchParams append': function () {
				return nativeBuild(values);
			}
		}
	};
}

const links = [
	'https://example.com/a?b=1#c',
	'/relative/path',
	'mailto:someone@example.com',
	'javascript:alert(1)',
	' java\tscript:alert(1)',
	'data:text/html,<script>alert(1)</script>',
	'HTTPS://EXAMPLE.COM',
	'#top'
];
const allowed = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const paths = ['/docs', '/docs/', '/search?q=a/b#top', '/a/b/c/', 'https://example.com', 'https://example.com/x/?y=1', '', '/'];
const dirty = ['https://example.com//a///b?u=http://x//y', '/a//b//c', '//cdn.example.com//lib.js', 'file:///etc//hosts', '/clean/path', '/a/b?x=//y'];
const mounted = ['/users?page=2', '/app/users', 'users', '/application', '/', '/items/42#details'];
const encoded = ['caf%C3%A9%20au%20lait', 'plain-text', '100%25%20off', '%E6%97%A5%E6%9C%AC%E8%AA%9E', 'Jos%E9%20Garc%C3%ADa', '%E0%A4%A'];
const fragmented = ['/docs?v=2#old', '/docs', 'https://x.com/a?b#c', '/page#section?x'];
const routes = ['/users/:id', '/users/:id/posts/:postId?', '/files/*path', '/about'];
const routePatterns =
	typeof URLPattern === 'function'
		? ['/users/:id', '/users/:id/posts{/:postId}?', '/files/:path+', '/about'].map(function (pathname) {
				return new URLPattern({ pathname });
			})
		: [];

/**
 * Maps a function over a list.
 * @param {(value: string) => unknown} fn - The function
 * @param {string[]} list - The inputs
 * @returns {unknown[]} The results
 */
function each(fn, list) {
	const out = [];
	for (let i = 0; i < list.length; i++) out.push(fn(list[i]));
	return out;
}

/**
 * Builds a case mapping our helper and ufo's over a list of inputs.
 * @param {string} name - The case name
 * @param {string[]} list - The inputs
 * @param {(value: string) => unknown} ours - Our call
 * @param {(value: string) => unknown} theirs - ufo's call
 * @returns {object} The case
 */
function ufoCase(name, list, ours, theirs) {
	return {
		name: `${name} (${list.length} URLs)`,
		fn: function () {
			return each(ours, list);
		},
		competitors: {
			ufo: function () {
				return each(theirs, list);
			}
		}
	};
}

export default [
	{
		name: 'isSafeUrl (8 links)',
		fn: function () {
			return each(isSafeUrl, links);
		},
		competitors: {
			// Loose: ufo only answers "is this a script protocol" (a denylist) for a protocol the caller extracts.
			'ufo !isScriptProtocol(parseURL)': function () {
				return each(function (link) {
					return !ufo.isScriptProtocol(ufo.parseURL(link).protocol);
				}, links);
			},
			'URL.parse + allowlist': function () {
				return each(function (link) {
					const parsed = URL.parse(link, 'https://base.example/');
					return parsed !== null && allowed.has(parsed.protocol);
				}, links);
			}
		}
	},
	ufoCase('withTrailingSlash', paths, withTrailingSlash, function (path) {
		return ufo.withTrailingSlash(path, true);
	}),
	ufoCase('withoutTrailingSlash', paths, withoutTrailingSlash, function (path) {
		return ufo.withoutTrailingSlash(path, true);
	}),
	ufoCase('withLeadingSlash', paths, withLeadingSlash, ufo.withLeadingSlash),
	ufoCase('withoutLeadingSlash', paths, withoutLeadingSlash, ufo.withoutLeadingSlash),
	ufoCase('cleanDoubleSlashes', dirty, cleanDoubleSlashes, ufo.cleanDoubleSlashes),
	ufoCase(
		'withBase',
		mounted,
		function (path) {
			return withBase(path, '/app');
		},
		function (path) {
			return ufo.withBase(path, '/app');
		}
	),
	ufoCase(
		'withoutBase',
		mounted,
		function (path) {
			return withoutBase(path, '/app');
		},
		function (path) {
			return ufo.withoutBase(path, '/app');
		}
	),
	{
		name: 'safeDecodeURIComponent (6 strings, 2 malformed)',
		fn: function () {
			return each(safeDecodeURIComponent, encoded);
		},
		competitors: {
			// Loose: ufo returns a malformed string unchanged instead of decoding its valid escapes.
			ufo: function () {
				return each(ufo.decode, encoded);
			}
		}
	},
	ufoCase(
		'withFragment',
		fragmented,
		function (url) {
			return withFragment(url, 'section 2');
		},
		function (url) {
			return ufo.withFragment(url, 'section 2');
		}
	),
	ufoCase('withoutFragment', fragmented, withoutFragment, ufo.withoutFragment),
	{
		name: 'withoutQuery (4 URLs)',
		fn: function () {
			return each(withoutQuery, fragmented);
		}
	},
	parseCase('3 pairs', smallQuery),
	parseCase('10 pairs, brackets', query),
	parseCase('110 pairs', bigQuery),
	parseCase('4 unicode pairs', unicodeQuery),
	buildCase('3 keys', smallParams),
	buildCase('8 keys', params),
	buildCase('100 keys', bigParams),
	buildCase('4 unicode keys', unicodeParams),
	{
		name: 'buildQueryString (brackets, sorted)',
		fn: function () {
			return buildQueryString(params, { arrayFormat: 'brackets', sort: true });
		}
	},
	{
		name: 'withQuery (replace 2, add 1)',
		fn: function () {
			return withQuery(url, update);
		},
		competitors: {
			'URL + searchParams': function () {
				return nativeWithQuery(url, update);
			}
		}
	},
	{
		name: 'withQuery (110-pair URL, set 1)',
		fn: function () {
			return withQuery(`https://example.com/?${bigQuery}`, { page: 3 });
		},
		competitors: {
			'URL + searchParams': function () {
				return nativeWithQuery(`https://example.com/?${bigQuery}`, { page: 3 });
			}
		}
	},
	{
		name: 'getQueryParam',
		fn: function () {
			return getQueryParam(url, 'page');
		},
		competitors: {
			'new URL().searchParams.get': function () {
				return new URL(url).searchParams.get('page');
			}
		}
	},
	{
		name: 'getQueryParam (110-pair URL)',
		fn: function () {
			return getQueryParam(`https://example.com/?${bigQuery}`, 'key50');
		},
		competitors: {
			'new URL().searchParams.get': function () {
				return new URL(`https://example.com/?${bigQuery}`).searchParams.get('key50');
			}
		}
	},
	{
		name: 'matchPath (4 routes)',
		fn: function () {
			return each(function (route) {
				return matchPath(route, '/users/42/posts/7');
			}, routes);
		},
		competitors:
			routePatterns.length === 0
				? {}
				: {
						// Loose: URLPattern compiles each pattern to a regular expression once, and neither decodes nor checks dot segments.
						'URLPattern.exec (compiled)': function () {
							return routePatterns.map(function (pattern) {
								return pattern.exec({ pathname: '/users/42/posts/7' });
							});
						}
					}
	},
	{
		name: 'joinUrl (4 parts)',
		fn: function () {
			return joinUrl('https://api.example.com/', '/v1/', 'users', '42?expand=true');
		},
		competitors: {
			// Loose: the naive join, which also collapses the `//` after the scheme unless guarded like this.
			'join + replace': function () {
				return ['https://api.example.com/', '/v1/', 'users', '42?expand=true'].join('/').replace(/([^:]\/)\/+/g, '$1');
			}
		}
	},
	{
		name: 'isAbsoluteUrl (4 inputs)',
		fn: function () {
			return isAbsoluteUrl(url) && isAbsoluteUrl('//cdn.example.com/x.js') && !isAbsoluteUrl('/relative') && !isAbsoluteUrl('mailto:a@b.c');
		},
		competitors: {
			'URL.canParse': function () {
				return URL.canParse(url) && URL.canParse('//cdn.example.com/x.js') === false && !URL.canParse('/relative') && URL.canParse('mailto:a@b.c');
			}
		}
	}
];
