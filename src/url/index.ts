import { describe } from '../utils/assert.js';

/**
 * A single query-string value. Dates are serialized with `toISOString()`, everything else with `String()`.
 */
export type QueryValue = string | number | boolean | bigint | Date;

/**
 * The parameters accepted by {@link buildQueryString} and {@link withQuery}: a single value or a list of values per key.
 * `undefined` values are always skipped; `null` values depend on the `skipNull` option.
 */
export type QueryParams = Readonly<Record<string, QueryValue | ReadonlyArray<QueryValue> | undefined | null>>;

/**
 * How {@link buildQueryString} serializes arrays:
 * - `'repeat'`: `a=1&a=2`
 * - `'comma'`: `a=1,2` (commas inside values are percent-encoded, so the split is unambiguous)
 * - `'brackets'`: `a[]=1&a[]=2`
 */
export type ArrayFormat = 'repeat' | 'comma' | 'brackets';

/**
 * Options accepted by {@link buildQueryString} and {@link withQuery}.
 */
export interface BuildQueryStringOptions {
	/** How arrays are serialized. Defaults to `'repeat'`. */
	readonly arrayFormat?: ArrayFormat;
	/** Skip keys whose value is `null`. When `false`, they are written as a bare key without `=` (`a`). Defaults to `true`. */
	readonly skipNull?: boolean;
	/** Sort the keys (by UTF-16 code units) instead of keeping the object's key order. The order of the values of a key is kept. Defaults to `false`. */
	readonly sort?: boolean;
}

/**
 * The result of {@link parseQueryString}: a key maps to a string, or to an array when it appears several times or uses brackets (`a[]=`).
 * The object has a `null` prototype, so keys such as `__proto__` or `constructor` are ordinary own keys.
 */
export type ParsedQuery = Record<string, string | string[]>;

/**
 * The array formats supported by {@link buildQueryString}.
 */
const ARRAY_FORMATS: ReadonlySet<string> = new Set<ArrayFormat>(['repeat', 'comma', 'brackets']);

/**
 * Percent-encodes a query-string component with `encodeURIComponent`. Lone surrogates, which `encodeURIComponent` rejects, are
 * replaced with U+FFFD first (like `URLSearchParams` does).
 * @param {string} value - The text to encode
 * @returns {string} The encoded text
 */
function encodeComponent(value: string): string {
	try {
		return encodeURIComponent(value);
	} catch {
		// Only a lone surrogate (a `Cs` code point in a `u` regular expression, unlike a valid pair) makes `encodeURIComponent` throw.
		return encodeURIComponent(value.replace(/\p{Cs}/gu, '\ufffd'));
	}
}

/**
 * Decodes a query-string component the way {@link parseQueryString} does: `+` is a space and malformed percent sequences never throw.
 * @param {string} value - The raw component (without `&`, `=` or `#`)
 * @returns {string} The decoded text
 */
function decodeComponent(value: string): string {
	return new URLSearchParams(`k=${value}`).get('k') as string;
}

/**
 * Serializes a single value.
 * @param {string} key - The key, for error messages
 * @param {unknown} value - The value to serialize
 * @returns {string} The serialized (not yet encoded) value
 * @throws {RangeError} when `value` is an invalid `Date`
 * @throws {TypeError} when `value` is not a string, number, boolean, bigint or `Date`
 */
function serializeValue(key: string, value: unknown): string {
	if (typeof value === 'string') return value;

	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);

	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new RangeError(`buildQueryString: \`params.${key}\` must be a valid Date, got Invalid Date`);

		return value.toISOString();
	}

	throw new TypeError(`buildQueryString: \`params.${key}\` must be a string, number, boolean, bigint or Date, got ${describe(value)}`);
}

/**
 * Builds a query string (WITHOUT the leading `?`) from a record of parameters. Keys and values are percent-encoded with
 * `encodeURIComponent` (spaces become `%20`; lone surrogates become U+FFFD), so encoded values never contain a raw `&`, `=`, `,` or `#`.
 *
 * - `undefined` values (and `undefined`/`null` items inside arrays) are skipped.
 * - `null` values are skipped by default; with `skipNull: false` they are written as a bare key (`a`).
 * - Numbers, booleans and bigints use `String()`; dates use `toISOString()`.
 * - Arrays follow `arrayFormat`; an empty array writes nothing.
 * - Only own enumerable string keys are read, in object order unless `sort` is set.
 * @param {QueryParams} params - The parameters
 * @param {BuildQueryStringOptions} [options={}] - `arrayFormat` (default `'repeat'`), `skipNull` (default `true`) and `sort` (default `false`)
 * @returns {string} The query string, `''` when nothing is written
 * @throws {RangeError} when `arrayFormat` is unknown or a `Date` is invalid
 * @throws {TypeError} when a value is not a string, number, boolean, bigint, `Date`, array of those, `null` or `undefined`
 * @example
 * buildQueryString({ q: 'hello world', page: 2, tags: ['a', 'b'] }); // => 'q=hello%20world&page=2&tags=a&tags=b'
 * buildQueryString({ tags: ['a', 'b'] }, { arrayFormat: 'brackets' }); // => 'tags[]=a&tags[]=b'
 * buildQueryString({ tags: ['a', 'b,c'] }, { arrayFormat: 'comma' }); // => 'tags=a,b%2Cc'
 * buildQueryString({ b: 1, a: null, c: undefined }, { skipNull: false, sort: true }); // => 'a&b=1'
 */
export function buildQueryString(params: QueryParams, options: BuildQueryStringOptions = {}): string {
	const { arrayFormat = 'repeat', skipNull = true, sort = false } = options;

	if (!ARRAY_FORMATS.has(arrayFormat)) throw new RangeError(`buildQueryString: \`arrayFormat\` must be 'repeat', 'comma' or 'brackets', got ${String(arrayFormat)}`);

	const keys = Object.keys(params);

	if (sort) keys.sort();

	// Built by concatenation (no intermediate arrays): this runs once per key and value. A pair or an item can be empty, so the
	// separators are tracked rather than inferred from the text built so far.
	let query = '';
	let separator = '';

	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		const value = params[key];

		if (value === undefined) continue;

		const name = encodeComponent(key);

		if (value === null) {
			if (!skipNull) {
				query += separator + name;
				separator = '&';
			}
			continue;
		}

		if (!Array.isArray(value)) {
			query += separator + name + '=' + encodeComponent(serializeValue(key, value));
			separator = '&';
			continue;
		}

		const list = value as ReadonlyArray<unknown>;
		const prefix = name + (arrayFormat === 'brackets' ? '[]=' : '=');
		const itemSeparator = arrayFormat === 'comma' ? ',' : '&' + prefix;
		let written = false;

		for (const item of list) {
			if (item == null) continue;

			// The first item opens the key's pair; the next ones are appended with `,` or as pairs of their own.
			query += (written ? itemSeparator : separator + prefix) + encodeComponent(serializeValue(key, item));
			written = true;
		}

		if (written) separator = '&';
	}

	return query;
}

/**
 * Parses a query string into a record. Parsing follows `URLSearchParams`: an optional leading `?` is ignored, pairs are separated by `&`,
 * `+` decodes to a space, malformed percent-escapes never throw (invalid UTF-8 becomes U+FFFD) and a key without `=` gets `''`.
 * Anything after a `#` is ignored (it is a fragment, not part of the query).
 *
 * A key that appears several times maps to an array of its values, in order. A key ending in `[]` (`a[]=1`, also when percent-encoded)
 * is stored without the brackets and always maps to an array, even with a single value. Comma-separated values are NOT split.
 *
 * The result has a `null` prototype, so it is safe against prototype pollution (`__proto__=x` creates an own `__proto__` key);
 * use `Object.keys`, `in` or `Object.hasOwn` on it rather than `result.hasOwnProperty`.
 * @param {string} query - The query string, with or without the leading `?`
 * @returns {ParsedQuery} The parsed parameters
 * @example
 * parseQueryString('?q=hello+world&tag=a&tag=b&empty'); // => { q: 'hello world', tag: ['a', 'b'], empty: '' }
 * parseQueryString('ids[]=1'); // => { ids: ['1'] }
 */
export function parseQueryString(query: string): ParsedQuery {
	const hashIndex = query.indexOf('#');
	const search = hashIndex === -1 ? query : query.slice(0, hashIndex);
	const result = Object.create(null) as ParsedQuery;

	for (const [rawKey, value] of new URLSearchParams(search)) {
		const key = withoutBrackets(rawKey);
		const isBracket = key !== rawKey;
		const existing = result[key];

		if (existing === undefined) result[key] = isBracket ? [value] : value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}

	return result;
}

/**
 * Removes the `[]` suffix of a bracket key (`a[]` becomes `a`).
 * @param {string} key - A decoded query-string key
 * @returns {string} The key without its brackets
 */
function withoutBrackets(key: string): string {
	return key.endsWith('[]') ? key.slice(0, -2) : key;
}

/**
 * Splits a URL string into the part before the query, the raw query (without `?`) and the fragment (with `#`).
 * @param {string} url - The URL
 * @returns {{ base: string, query: string, hash: string }} The three parts (`query` and `hash` may be empty)
 */
function splitUrl(url: string): { base: string; query: string; hash: string } {
	const hashIndex = url.indexOf('#');
	const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
	const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
	const queryIndex = beforeHash.indexOf('?');

	if (queryIndex === -1) return { base: beforeHash, query: '', hash };

	return { base: beforeHash.slice(0, queryIndex), query: beforeHash.slice(queryIndex + 1), hash };
}

/**
 * Adds parameters to a URL string that may already have a query and/or a `#fragment`.
 *
 * Existing pairs whose key (decoded, with `[]` removed) is not in `params` (with `[]` removed) are kept verbatim, in place. Every key of
 * `params` whose value is not `undefined` replaces all existing occurrences of that key, in both its plain and its bracket form (`a` and
 * `a[]`), so a parameter can never be smuggled in twice; its new pairs are appended at the end, serialized by {@link buildQueryString}
 * with `options` (which apply to the appended pairs only). A `null` value therefore removes the key (with the default `skipNull: true`).
 * The fragment is preserved at the end; a dangling `?` is dropped when no pair remains.
 * @param {string} url - The URL (absolute or relative)
 * @param {QueryParams} params - The parameters to set
 * @param {BuildQueryStringOptions} [options={}] - Serialization options for the new parameters
 * @returns {string} The URL with the merged query
 * @throws {RangeError} see {@link buildQueryString}
 * @throws {TypeError} see {@link buildQueryString}
 * @example
 * withQuery('https://x.com/search?q=old&page=2#results', { q: 'new value', lang: 'en' }); // => 'https://x.com/search?page=2&q=new%20value&lang=en#results'
 * withQuery('/list?page=2&sort=asc', { page: null }); // => '/list?sort=asc'
 * withQuery('/list', {}); // => '/list'
 * withQuery('/list?id[]=1&id=2', { 'id[]': [3] }); // => '/list?id%5B%5D=3'
 */
export function withQuery(url: string, params: QueryParams, options: BuildQueryStringOptions = {}): string {
	const { base, query, hash } = splitUrl(url);
	// Keys are compared without their `[]` suffix on both sides, so `a` and `a[]` replace each other.
	const replaced = new Set<string>();

	for (const key of Object.keys(params)) {
		if (params[key] !== undefined) replaced.add(withoutBrackets(key));
	}

	const pairs = query.split('&').filter(function (pair: string): boolean {
		if (pair === '') return false;

		const equalsIndex = pair.indexOf('=');

		return !replaced.has(withoutBrackets(decodeComponent(equalsIndex === -1 ? pair : pair.slice(0, equalsIndex))));
	});
	const added = buildQueryString(params, options);

	if (added !== '') pairs.push(added);

	return base + (pairs.length === 0 ? '' : `?${pairs.join('&')}`) + hash;
}

/**
 * Joins URL parts with exactly one `/` between them.
 *
 * - Empty parts are ignored; runs of slashes inside or between parts collapse into one.
 * - Like browsers, every `\` of the path counts as a `/` and ASCII tabs and line breaks are removed (before the query of the last part).
 * - Only the FIRST argument can be a base. Its beginning is preserved: a scheme with its slashes (`https://`, `file:///`), a protocol-relative
 *   `//host`, or a leading `/` (also for a first part made only of slashes, or starting with three or more: there is no host to make it
 *   protocol-relative). When the first argument is empty, the result is a path: it may start with one `/`, never with `//` or a scheme.
 * - The other parts can never add a host or a scheme: their leading slashes are dropped, and a result without a base whose first
 *   segment holds a `:` (`https:`, `javascript:alert(1)`) is prefixed with `./`, as RFC 3986 requires for such relative paths.
 * - The result ends with `/` only when the last part (ignoring its query/fragment) does.
 * - The query (`?...`) and fragment (`#...`) of the last part are kept as they are.
 *
 * Security: apart from the above, parts are joined verbatim, NOT encoded. A `?` or `#` in an earlier part does not end the path for
 * `joinUrl` (slashes after it are still collapsed), but it still starts the query or fragment of the resulting URL, and `.`/`..` segments
 * are resolved by browsers and servers. Encode every untrusted segment with `encodeURIComponent` (which escapes `/`, `\`, `?` and `#`)
 * and reject `.` and `..`.
 * @param {...string} parts - The URL parts
 * @returns {string} The joined URL (`''` when every part is empty)
 * @throws {TypeError} when a part is not a string
 * @example
 * joinUrl('https://api.example.com/', '/v1/', 'users', '42'); // => 'https://api.example.com/v1/users/42'
 * joinUrl('/api', 'items/', '?page=2'); // => '/api/items?page=2'
 * joinUrl('a', 'b/'); // => 'a/b/'
 * joinUrl('//cdn.example.com', 'lib.js'); // => '//cdn.example.com/lib.js'
 * joinUrl('/', '\\\\evil.example'); // => '/evil.example'
 * joinUrl('', 'https://evil.example'); // => './https:/evil.example'
 * joinUrl('/users', encodeURIComponent('a/../b?x')); // => '/users/a%2F..%2Fb%3Fx'
 */
export function joinUrl(...parts: string[]): string {
	// The non-empty parts, in a fresh array whose items are then replaced by their path text.
	const paths: string[] = [];

	for (let index = 0; index < parts.length; index++) {
		const part: unknown = parts[index];

		if (typeof part !== 'string') throw new TypeError(`joinUrl: \`parts\` must only contain strings, got ${describe(part)}`);

		if (part !== '') paths.push(part);
	}

	if (paths.length === 0) return '';

	const lastIndex = paths.length - 1;
	const last = paths[lastIndex];
	const suffixIndex = last.search(/[?#]/);
	let suffix = '';

	if (suffixIndex !== -1) {
		suffix = last.slice(suffixIndex);
		paths[lastIndex] = last.slice(0, suffixIndex);
	}

	// What browsers ignore in a URL or read as a `/` (rare: tested first so that the common case does not allocate).
	for (let index = 0; index < paths.length; index++) {
		if (/[\\\t\n\r]/.test(paths[index])) paths[index] = paths[index].replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
	}

	return joinPaths(paths, parts[0] !== '') + suffix;
}

/**
 * Joins the path parts of {@link joinUrl} (the last one without its query and fragment).
 * @param {ReadonlyArray<string>} paths - The non-empty parts
 * @param {boolean} base - Whether the first of them is the first argument, and so may hold a scheme or a protocol-relative host
 * @returns {string} The joined path
 */
function joinPaths(paths: ReadonlyArray<string>, base: boolean): string {
	const first = paths[0];
	// The first argument is the base: a scheme with its slashes, else `//` before a host, else a single `/` (or nothing: the last
	// alternative always matches). Any other first part only contributes a single leading `/`.
	let prefix = base ? (/^[a-z][a-z\d+.-]*:\/*|^\/\/(?=[^/])|^\/?/i.exec(first) as RegExpExecArray)[0] : first[0] === '/' ? '/' : '';
	// The non-empty slash-free segments, separated by exactly one `/`: each part without its leading and trailing slashes, and the runs
	// of slashes inside a part (rare) collapsed afterwards.
	let body = '';

	for (let index = 0; index < paths.length; index++) {
		const path = paths[index];
		let start = index === 0 ? prefix.length : 0;
		let end = path.length;

		while (path[start] === '/') start++;

		// A part made only of slashes ends up with `end < start` (skipped below).
		while (path[end - 1] === '/') end--;

		if (end > start) body += (body === '' ? '' : '/') + path.slice(start, end);
	}

	if (body.includes('//')) body = body.replace(/\/\/+/g, '/');

	// A relative path whose first segment holds a `:` would be read as a scheme.
	if (prefix === '' && /^[^/]*:/.test(body)) prefix = './';

	return prefix + body + (paths[paths.length - 1].endsWith('/') && body !== '' ? '/' : '');
}

/**
 * Reads the first value of a query parameter from a URL string (see {@link parseQueryString} for the decoding rules).
 * Only the part between the first `?` and the `#fragment` is searched, so a string without `?` has no parameters.
 * @param {string} url - The URL (absolute or relative)
 * @param {string} key - The parameter name (`a` also matches `a[]`)
 * @returns {string | undefined} The first value, or `undefined` when the parameter is absent
 * @example
 * getQueryParam('https://x.com/?q=hello+world&q=2#top', 'q'); // => 'hello world'
 * getQueryParam('/path?flag', 'flag'); // => ''
 * getQueryParam('/path', 'q'); // => undefined
 */
export function getQueryParam(url: string, key: string): string | undefined {
	// Stops at the first match instead of building the whole parsed record (whose keys have `[]` removed, see parseQueryString).
	for (const [rawKey, value] of new URLSearchParams(splitUrl(url).query)) {
		if (withoutBrackets(rawKey) === key) return value;
	}

	return undefined;
}

/**
 * The beginning of an absolute URL (see {@link isAbsoluteUrl}), once the characters browsers ignore have been removed.
 */
const ABSOLUTE_URL = /^(?:[\\/]{2}|(?:https?|wss?|ftp|file):|(?!(?:javascript|data|vbscript):)[a-z][a-z\d+.-]*:\/\/)/i;

/**
 * Checks whether a string is an absolute URL, i.e. one that names its own host (or file) instead of being resolved against the current
 * page. The string is first normalised the way browsers (the WHATWG URL parser) do it: leading spaces and C0 control characters are
 * ignored, tabs and line breaks are removed anywhere, and `\` counts as `/`. It is then absolute when it:
 *
 * - is protocol-relative: starts with two slashes (`//host`, `\\host`, `/\host`, `/\t/host`, `///host` ...);
 * - starts with a special scheme (`http:`, `https:`, `ws:`, `wss:`, `ftp:`, `file:`), with or without slashes: browsers read `https:host`
 *   and `https:/host` as `https://host` whenever the page's own scheme differs (so they are reported as absolute even though, on a page of
 *   the same scheme, they resolve as paths);
 * - or starts with another scheme followed by `//` (`custom+app://open`), except `javascript:`, `data:` and `vbscript:`, which never name
 *   a host.
 *
 * Schemes without `//` (`mailto:`, `tel:`, `javascript:alert(1)`, `data:text/html,...`) are not absolute either.
 *
 * Security: `false` only means "no host of its own"; it does NOT mean "a safe same-origin path" (`javascript:alert(1)` is not absolute).
 * To validate a redirect target such as a `?next=` parameter, resolve it and compare origins instead:
 * `new URL(next, location.origin).origin === location.origin` (which also rejects `javascript:` and `data:` URLs).
 * @param {string} string - The string to check
 * @returns {boolean} Whether the string is an absolute URL
 * @example
 * isAbsoluteUrl('https://example.com'); // => true
 * isAbsoluteUrl('//cdn.example.com/lib.js'); // => true
 * isAbsoluteUrl('/\\evil.example'); // => true // browsers read it as //evil.example
 * isAbsoluteUrl(' https:evil.example'); // => true
 * isAbsoluteUrl('/relative/path'); // => false
 * isAbsoluteUrl('mailto:someone@example.com'); // => false
 * isAbsoluteUrl('javascript://%0aalert(1)'); // => false
 */
export function isAbsoluteUrl(string: string): boolean {
	// Most strings hold nothing that browsers ignore, so they are tested as they are first: a match never contains an ignored character,
	// so removing them cannot undo it. Otherwise the leading spaces and C0 controls (`[^!-\uffff]`: below `!`), and the tabs and line
	// breaks, are removed as browsers do, and the string is tested again.
	return ABSOLUTE_URL.test(string) || (/^[^!-\uffff]|[\t\n\r]/.test(string) && ABSOLUTE_URL.test(string.replace(/^[^!-\uffff]+|[\t\n\r]/g, '')));
}
