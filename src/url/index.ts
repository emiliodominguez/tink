import { isDate, isRegExp } from '../guards/index.js';
import { assertFunction, assertNumber, describe, readOption, show } from '../utils/assert.js';

/**
 * A single query-string value. Dates are serialized with `toISOString()`, everything else with `String()`.
 */
export type QueryValue = string | number | boolean | bigint | Date;

/**
 * The value of a key of {@link QueryParams}: a single value or a list of values. `undefined` values are always skipped; `null` values
 * depend on the `skipNull` option.
 */
export type QueryParamValue = QueryValue | ReadonlyArray<QueryValue | undefined | null> | undefined | null;

/**
 * The parameters accepted by {@link buildQueryString} and {@link withQuery}: a single value or a list of values per key.
 * `undefined` values are always skipped; `null` values depend on the `skipNull` option.
 */
export type QueryParams = Readonly<Record<string, QueryParamValue>>;

/**
 * The parameter objects accepted by {@link buildQueryString} and {@link withQuery}: like {@link QueryParams}, but checked key by key, so
 * that an `interface` (which has no index signature) is accepted too.
 * @template P - The parameters type
 */
export type QueryParamsOf<P> = { readonly [K in keyof P]: QueryParamValue };

/**
 * `unknown` for parameter objects, `never` for arrays (whose indexes would become keys: `0=x&1=y`).
 * @template P - The parameters type
 */
type NotAnArray<P> = P extends ReadonlyArray<unknown> ? never : unknown;

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
 * Percent-encodes text with `encodeURIComponent` (or `encodeURI`). Lone surrogates, which both reject, are replaced with U+FFFD first
 * (like `URLSearchParams` does).
 * @param {string} value - The text to encode
 * @param {(value: string) => string} [encode=encodeURIComponent] - The encoder
 * @returns {string} The encoded text
 */
function encodeComponent(value: string, encode: (value: string) => string = encodeURIComponent): string {
	try {
		return encode(value);
	} catch {
		// Only a lone surrogate (a `Cs` code point in a `u` regular expression, unlike a valid pair) makes the encoders throw.
		return encode(value.replace(LONE_SURROGATES, '\ufffd'));
	}
}

/** Lone UTF-16 surrogates (with the `u` flag, paired ones form a single code point), which URL encoding writes as U+FFFD. */
const LONE_SURROGATES = /\p{Cs}/gu;

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
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} key - The key, for error messages
 * @param {unknown} value - The value to serialize
 * @returns {string} The serialized (not yet encoded) value
 * @throws {RangeError} when `value` is an invalid `Date`
 * @throws {TypeError} when `value` is not a string, number, boolean, bigint or `Date`
 */
function serializeValue(caller: string, key: string, value: unknown): string {
	if (typeof value === 'string') return value;

	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);

	// `isDate` also recognizes dates of other realms; the intrinsics read the time value itself (not an overridden `getTime`).
	if (isDate(value)) {
		if (Number.isNaN(Date.prototype.getTime.call(value))) throw new RangeError(`${caller}: \`params.${key}\` must be a valid Date, got Invalid Date`);

		return Date.prototype.toISOString.call(value);
	}

	throw new TypeError(`${caller}: \`params.${key}\` must be a string, number, boolean, bigint or Date, got ${describe(value)}`);
}

/**
 * Builds a query string (WITHOUT the leading `?`) from a record of parameters. Keys and values are percent-encoded with
 * `encodeURIComponent` (spaces become `%20`; lone surrogates become U+FFFD), so encoded values never contain a raw `&`, `=`, `,` or `#`.
 *
 * - `undefined` values (and `undefined`/`null` items inside arrays) are skipped.
 * - `null` values are skipped by default; with `skipNull: false` they are written as a bare key (`a`).
 * - Numbers, booleans and bigints use `String()`; dates use `toISOString()`.
 * - Arrays follow `arrayFormat`; an empty array writes nothing.
 * - Only own enumerable string keys are read, in object order unless `sort` is set. Only the own properties of `options` are read.
 * @param {QueryParamsOf<P>} input - The parameters
 * @param {BuildQueryStringOptions} [options={}] - `arrayFormat` (default `'repeat'`), `skipNull` (default `true`) and `sort` (default `false`)
 * @returns {string} The query string, `''` when nothing is written
 * @throws {RangeError} when `arrayFormat` is unknown or a `Date` is invalid
 * @throws {TypeError} when a value is not a string, number, boolean, bigint, `Date`, array of those, `null` or `undefined`, or `options`
 *   is not an object
 * @example
 * buildQueryString({ q: 'hello world', page: 2, tags: ['a', 'b'] }); // => 'q=hello%20world&page=2&tags=a&tags=b'
 * buildQueryString({ tags: ['a', 'b'] }, { arrayFormat: 'brackets' }); // => 'tags[]=a&tags[]=b'
 * buildQueryString({ tags: ['a', 'b,c'] }, { arrayFormat: 'comma' }); // => 'tags=a,b%2Cc'
 * buildQueryString({ b: 1, a: null, c: undefined }, { skipNull: false, sort: true }); // => 'a&b=1'
 */
export function buildQueryString<P extends QueryParamsOf<P>>(input: P & NotAnArray<P>, options: BuildQueryStringOptions = {}): string {
	return buildFromEntries('buildQueryString', entriesOf(input as QueryParams), options);
}

/**
 * Reads the own enumerable string keys of `params` and their values, once each (so that a getter or a `Proxy` cannot report one value
 * to the checks and another to the query).
 * @param {QueryParams} params - The parameters
 * @returns {Array<[string, QueryParamValue]>} The entries, in key order
 */
function entriesOf(params: QueryParams): Array<[string, QueryParamValue]> {
	return Object.keys(params).map(function (key: string): [string, QueryParamValue] {
		return [key, params[key]];
	});
}

/**
 * {@link buildQueryString} from already read entries.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {Array<[string, QueryParamValue]>} entries - The parameters, as `[key, value]` pairs
 * @param {BuildQueryStringOptions} options - The options
 * @returns {string} The query string
 */
function buildFromEntries(caller: string, entries: Array<[string, QueryParamValue]>, options: BuildQueryStringOptions): string {
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);

	// Own options only (read once each): a polluted `Object.prototype.arrayFormat` or `sort` must not change the query string.
	const { arrayFormat = 'repeat', skipNull = true, sort = false } = Object.assign(Object.create(null) as object, options) as BuildQueryStringOptions;

	if (!ARRAY_FORMATS.has(arrayFormat)) throw new RangeError(`${caller}: \`arrayFormat\` must be 'repeat', 'comma' or 'brackets', got ${show(arrayFormat)}`);

	if (sort) {
		entries = entries.slice().sort(function (a: [string, QueryParamValue], b: [string, QueryParamValue]): number {
			// Keys are distinct: never equal.
			return a[0] < b[0] ? -1 : 1;
		});
	}

	// Built by concatenation (no intermediate arrays): this runs once per key and value. A pair or an item can be empty, so the
	// separators are tracked rather than inferred from the text built so far.
	let query = '';
	let separator = '';

	for (let index = 0; index < entries.length; index++) {
		const [key, value] = entries[index];

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
			query += separator + name + '=' + encodeComponent(serializeValue(caller, key, value));
			separator = '&';
			continue;
		}

		const list = value as ReadonlyArray<unknown>;
		const prefix = name + (arrayFormat === 'brackets' ? '[]=' : '=');
		const itemSeparator = arrayFormat === 'comma' ? ',' : '&' + prefix;
		let written = false;

		for (let position = 0; position < list.length; position++) {
			// Holes are skipped, also when a polluted prototype would fill them in.
			const item = Object.hasOwn(list, position) ? list[position] : undefined;

			if (item == null) continue;

			// The first item opens the key's pair; the next ones are appended with `,` or as pairs of their own.
			query += (written ? itemSeparator : separator + prefix) + encodeComponent(serializeValue(caller, key, item));
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
 * Turns form entries into a record the way {@link parseQueryString} reads a query string: a key sent several times (checkboxes, a
 * multiple select) maps to an array of its values, in order, and a key ending in `[]` always maps to an array. Takes a `FormData`
 * (files stay `File` objects), a `URLSearchParams`, or any iterable of `[key, value]` pairs; `Object.fromEntries(new FormData(form))`
 * would keep only the last value of a repeated key. The result has a `null` prototype, so a `__proto__` field is an own key; hand it to
 * the validate module's `parse` to check and coerce it.
 * @template V - The value type (`FormDataEntryValue` for a `FormData`)
 * @param {Iterable<readonly [string, V]>} entries - The form entries
 * @returns {Record<string, V | V[]>} The fields
 * @throws {TypeError} when `entries` is not iterable, or an entry is not a `[key, value]` pair
 * @example
 * const data = new FormData();
 * data.append('name', 'Ada');
 * data.append('topic', 'ts');
 * data.append('topic', 'js');
 * data.append('ids[]', '1');
 * parseFormData(data); // => { name: 'Ada', topic: ['ts', 'js'], ids: ['1'] }
 * parseFormData(new URLSearchParams('a=1&a=2')); // => { a: ['1', '2'] }
 */
export function parseFormData<V>(entries: Iterable<readonly [string, V]>): Record<string, V | V[]> {
	if (entries == null || typeof (entries as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function') {
		throw new TypeError(`parseFormData: \`entries\` must be iterable (a FormData, URLSearchParams or [key, value] pairs), got ${describe(entries)}`);
	}

	const result = Object.create(null) as Record<string, V | V[]>;
	// The keys whose value is an array this function made: a value that is itself an array is never pushed into.
	const collected = new Set<string>();

	for (const entry of entries) {
		// Like `Object.fromEntries`: an entry must be an object (`'ab'` would otherwise give `{ a: 'b' }`), and iterable.
		if (typeof entry !== 'object' || entry === null || typeof (entry as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function') {
			throw new TypeError(`parseFormData: every entry must be a [key, value] pair, got ${describe(entry)}`);
		}

		const [name, value] = entry;
		const rawKey = String(name);
		const key = withoutBrackets(rawKey);

		if (collected.has(key)) {
			(result[key] as V[]).push(value);
		} else if (key in result || key !== rawKey) {
			result[key] = key in result ? [result[key] as V, value] : [value];
			collected.add(key);
		} else {
			result[key] = value;
		}
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
 * @param {QueryParamsOf<P>} input - The parameters to set
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
export function withQuery<P extends QueryParamsOf<P>>(url: string, input: P & NotAnArray<P>, options: BuildQueryStringOptions = {}): string {
	// Read once: the keys that replace existing pairs are exactly the keys written.
	const entries = entriesOf(input as QueryParams);
	const { base, query, hash } = splitUrl(url);
	// Keys are compared without their `[]` suffix on both sides, so `a` and `a[]` replace each other.
	const replaced = new Set<string>();

	// Lone surrogates are written as U+FFFD (see `encodeComponent`), so both sides are compared in that form: otherwise a key with one
	// would not replace its existing occurrences, and could be smuggled in twice.
	for (const [key, value] of entries) {
		if (value !== undefined) replaced.add(withoutBrackets(key.replace(LONE_SURROGATES, '\ufffd')));
	}

	const pairs = query.split('&').filter(function (pair: string): boolean {
		if (pair === '') return false;

		const equalsIndex = pair.indexOf('=');
		const key = decodeComponent(equalsIndex === -1 ? pair : pair.slice(0, equalsIndex)).replace(LONE_SURROGATES, '\ufffd');

		return !replaced.has(withoutBrackets(key));
	});
	const added = buildFromEntries('withQuery', entries, options);

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

/**
 * A scheme at the start of a URL, as the WHATWG URL parser reads it: an ASCII letter, then ASCII letters, digits, `+`, `-` or `.`, then `:`.
 */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * What the WHATWG URL parser ignores before reading the scheme: leading C0 control characters and spaces, and every ASCII tab or line break.
 */
const IGNORED = /^[\0- ]+|[\t\n\r]/g;

/**
 * The protocols {@link isSafeUrl} allows by default.
 */
const SAFE_PROTOCOLS: ReadonlyArray<string> = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * Options accepted by {@link isSafeUrl} and {@link sanitizeUrl}.
 */
export interface IsSafeUrlOptions {
	/** The allowed schemes, each ending with `:` and compared case-insensitively. Defaults to `['http:', 'https:', 'mailto:', 'tel:']`. */
	readonly protocols?: ReadonlyArray<string>;
	/**
	 * Whether a URL without a scheme (`/path`, `page.html`, `?q=1`, `#top`, `//host/path`) is allowed. Such a URL is resolved against the
	 * page, so it inherits the page's own (normally `http:` or `https:`) scheme. Defaults to `true`.
	 */
	readonly allowRelative?: boolean;
}

/**
 * Checks that a user-supplied URL is safe to put in an `href` or `src`, with an ALLOWLIST of schemes rather than a denylist of dangerous
 * ones (`javascript:`, `vbscript:`, `data:`... and any scheme invented later are rejected unless listed).
 *
 * The scheme is read exactly as browsers (the WHATWG URL parser) read it: leading spaces and C0 control characters are skipped, ASCII tabs
 * and line breaks are ignored anywhere, and case does not matter, so `' java\tscript:alert(1)'`, `'\x01javascript:x'` and `'JaVaScRiPt:x'`
 * are all `javascript:` URLs. A string whose scheme is not followed by a valid URL (`https://exa mple.com`) is accepted when its scheme is
 * allowed: browsers do not navigate to it.
 *
 * Relative URLs (no scheme) are allowed by default, since they keep the page's scheme; set `allowRelative: false` to require an absolute
 * URL. Note that a protocol-relative URL (`//other.example`) is relative too: this function checks the SCHEME, not the destination. To
 * keep a redirect on the same site, compare origins instead (see `isAbsoluteUrl`).
 *
 * HTML entities are NOT decoded: the check applies to the URL the browser receives, so set the value through the DOM (`a.href = url`,
 * `setAttribute`) or HTML-escape it (e.g. with `escapeHtml` from the strings module, which turns `javascript&colon;` into harmless text);
 * never concatenate it unescaped into markup. Only the own properties of `options` are read.
 * @param {string} url - The URL to check (any other value is unsafe)
 * @param {IsSafeUrlOptions} [options={}] - `protocols` (default `['http:', 'https:', 'mailto:', 'tel:']`) and `allowRelative` (default `true`)
 * @returns {boolean} Whether the URL has an allowed scheme, or no scheme and relative URLs are allowed
 * @throws {TypeError} when `options` is not an object, or `options.protocols` is not an array of strings
 * @throws {RangeError} when an entry of `options.protocols` is not a scheme followed by `:` (`'https'` instead of `'https:'`)
 * @example
 * isSafeUrl('https://example.com/a?b#c'); // => true
 * isSafeUrl('/relative/path'); // => true
 * isSafeUrl(' java\tscript:alert(1)'); // => false
 * isSafeUrl('data:text/html,<script>alert(1)</script>'); // => false
 * isSafeUrl('/relative/path', { allowRelative: false }); // => false
 * isSafeUrl('ftp://files.example.com', { protocols: ['https:', 'FTP:'] }); // => true
 */
export function isSafeUrl(url: string, options: IsSafeUrlOptions = {}): boolean {
	if (typeof options !== 'object' || options === null) throw new TypeError(`isSafeUrl: \`options\` must be an object, got ${describe(options)}`);

	// Own options only (read once each): a polluted `Object.prototype.protocols` must not let `javascript:` through.
	const { protocols = SAFE_PROTOCOLS, allowRelative = true } = Object.assign(Object.create(null) as object, options) as IsSafeUrlOptions;

	if (!Array.isArray(protocols)) throw new TypeError(`isSafeUrl: \`options.protocols\` must be an array of strings, got ${describe(protocols)}`);

	// The options are validated whatever `url` is.
	for (const entry of protocols as ReadonlyArray<unknown>) {
		if (typeof entry !== 'string') throw new TypeError(`isSafeUrl: \`options.protocols\` must be an array of strings, got ${describe(entry)} in it`);

		if (!(SCHEME.test(entry) && entry.indexOf(':') === entry.length - 1))
			throw new RangeError(`isSafeUrl: \`options.protocols\` entries must be schemes ending with ':' (such as 'https:'), got ${JSON.stringify(entry)}`);
	}

	if (typeof url !== 'string') return false;

	// A scheme found in the string as it is contains no ignored character, so removing them could not change it.
	const scheme = SCHEME.exec(url) ?? SCHEME.exec(url.replace(IGNORED, ''));
	const protocol = scheme === null ? '' : scheme[0].toLowerCase();

	return (
		(scheme === null && allowRelative) ||
		(protocols as ReadonlyArray<string>).some(function (entry: string): boolean {
			return entry.toLowerCase() === protocol;
		})
	);
}

/**
 * Returns the URL when {@link isSafeUrl} accepts it, else the fallback. A safe URL is returned unchanged: still set it through the DOM or
 * HTML-escape it when building markup (see {@link isSafeUrl}). Any other `fallback` is returned as is (the second overload).
 * @param {string} url - The user-supplied URL
 * @param {undefined} [fallback] - Omitted or `undefined`: an unsafe URL becomes `'about:blank'` (pass `null` to omit the attribute)
 * @param {IsSafeUrlOptions} [options={}] - See {@link isSafeUrl}
 * @returns {string} `url` or `'about:blank'`
 * @throws {TypeError} see {@link isSafeUrl}
 * @throws {RangeError} see {@link isSafeUrl}
 * @example
 * sanitizeUrl('https://example.com'); // => 'https://example.com'
 * sanitizeUrl('javascript:alert(1)'); // => 'about:blank'
 * sanitizeUrl('JAVASCRIPT:alert(1)', '#'); // => '#'
 * sanitizeUrl('vbscript:x', null); // => null
 */
export function sanitizeUrl(url: string, fallback?: undefined, options?: IsSafeUrlOptions): string;
/**
 * Returns the URL when {@link isSafeUrl} accepts it, else `fallback` (see the first overload).
 * @template F - The type of the fallback
 * @param {string} url - The user-supplied URL
 * @param {F} fallback - What to return instead of an unsafe URL
 * @param {IsSafeUrlOptions} [options={}] - See {@link isSafeUrl}
 * @returns {string | Exclude<F, undefined>} `url` or `fallback` (`'about:blank'` for an `undefined` fallback)
 */
export function sanitizeUrl<F>(url: string, fallback: F, options?: IsSafeUrlOptions): string | Exclude<F, undefined>;
/**
 * Implementation of {@link sanitizeUrl}.
 * @param {string} url - The user-supplied URL
 * @param {unknown} [fallback='about:blank'] - What to return instead of an unsafe URL
 * @param {IsSafeUrlOptions} [options={}] - See {@link isSafeUrl}
 * @returns {unknown} `url` or `fallback`
 */
export function sanitizeUrl(url: string, fallback: unknown = 'about:blank', options: IsSafeUrlOptions = {}): unknown {
	return isSafeUrl(url, options) ? url : fallback;
}

/**
 * Returns the index where the path of a URL string ends: its first `?` or `#`, or its length.
 * @param {string} url - The URL
 * @returns {number} The end of the part before the query and fragment
 */
function pathEnd(url: string): number {
	const query = url.indexOf('?');
	const hash = url.indexOf('#');

	return query === -1 ? (hash === -1 ? url.length : hash) : hash === -1 || query < hash ? query : hash;
}

/**
 * The part of a URL that the slash helpers never change: an optional scheme followed by its run of slashes (`https://`, `file:///`), or
 * the leading run of slashes of a relative URL (`/`, or `//` before the host of a protocol-relative URL).
 */
const SLASH_PREFIX = /^(?:[a-z][a-z\d+.-]*:)?\/*/i;

/**
 * Returns the length of the leading run of `/` and `\` (which browsers read as `/`) of a path, with the tabs and line breaks they ignore.
 * @param {string} path - The path
 * @returns {number} The index of the first other character
 */
function leadingSlashesEnd(path: string): number {
	let index = 0;

	for (let code = path.charCodeAt(0); code === 47 || code === 92 || code === 9 || code === 10 || code === 13; code = path.charCodeAt(++index));

	return index;
}

/**
 * Makes the path of a URL end with `/`. The query and fragment are kept after it (`/a?x=1` → `/a/?x=1`).
 * @param {string} url - The URL or path
 * @returns {string} The URL whose path ends with `/` (`''` becomes `'/'`)
 * @example
 * withTrailingSlash('/docs'); // => '/docs/'
 * withTrailingSlash('/search?q=a/b#top'); // => '/search/?q=a/b#top'
 * withTrailingSlash('https://example.com'); // => 'https://example.com/'
 */
export function withTrailingSlash(url: string): string {
	const end = pathEnd(url);

	return url[end - 1] === '/' ? url : url.slice(0, end) + '/' + url.slice(end);
}

/**
 * Removes every trailing `/` from the path of a URL, keeping the query and fragment. The slashes after a scheme (`https://`) and the root
 * `/` of a relative path are never removed.
 * @param {string} url - The URL or path
 * @returns {string} The URL whose path does not end with `/` (unless it is a root)
 * @example
 * withoutTrailingSlash('/docs//?page=2'); // => '/docs?page=2'
 * withoutTrailingSlash('https://example.com/'); // => 'https://example.com'
 * withoutTrailingSlash('/'); // => '/'
 */
export function withoutTrailingSlash(url: string): string {
	const end = pathEnd(url);

	if (url[end - 1] !== '/') return url;

	const keep = (SLASH_PREFIX.exec(url) as RegExpExecArray)[0].length;
	let index = end;

	while (index > keep && url[index - 1] === '/') index--;

	return url.slice(0, index) + url.slice(end);
}

/**
 * Makes a path start with exactly one `/`. A leading run of slashes collapses into one, so the result is never protocol-relative
 * (`//evil.example` becomes `/evil.example`); like browsers, `\` counts as `/` and tabs and line breaks in that run are dropped. Meant for
 * paths: a URL with a scheme is not special-cased (`https://a` becomes `/https://a`).
 * @param {string} path - The path (may hold a query and fragment)
 * @returns {string} The path starting with a single `/`
 * @example
 * withLeadingSlash('docs/intro'); // => '/docs/intro'
 * withLeadingSlash('?q=1'); // => '/?q=1'
 * withLeadingSlash('//evil.example/x'); // => '/evil.example/x'
 */
export function withLeadingSlash(path: string): string {
	const end = leadingSlashesEnd(path);

	return end === 1 && path[0] === '/' ? path : '/' + path.slice(end);
}

/**
 * Removes the leading run of slashes of a path (`\`, tabs and line breaks in that run too, as for {@link withLeadingSlash}).
 * @param {string} path - The path
 * @returns {string} The path without leading slashes
 * @example
 * withoutLeadingSlash('/docs/intro'); // => 'docs/intro'
 * withoutLeadingSlash('///a'); // => 'a'
 */
export function withoutLeadingSlash(path: string): string {
	return path.slice(leadingSlashesEnd(path));
}

/**
 * Collapses every run of `/` in the path of a URL into a single `/`. The query and fragment are left untouched (`?next=https://a//b`
 * keeps its slashes), and so is the run of slashes after a scheme (`https://`, `file:///`) or at the start of a relative URL (so a
 * protocol-relative `//host` stays one). It is a purely syntactic edit: `.` and `..` segments are not resolved, and since a browser
 * resolves `..` against the empty segment a double slash creates, `'/a//..'` (which resolves to `/a/`) becomes `'/a/..'` (which resolves to
 * `/`). Resolve dot segments first (`new URL(url, base)`) when that matters.
 * @param {string} url - The URL or path
 * @returns {string} The URL without repeated slashes in its path
 * @example
 * cleanDoubleSlashes('https://example.com//a///b?u=http://x//y'); // => 'https://example.com/a/b?u=http://x//y'
 * cleanDoubleSlashes('file:///etc//hosts'); // => 'file:///etc/hosts'
 * cleanDoubleSlashes('//cdn.example.com//lib.js'); // => '//cdn.example.com/lib.js'
 * cleanDoubleSlashes('/a//..'); // => '/a/..'
 */
export function cleanDoubleSlashes(url: string): string {
	const end = pathEnd(url);
	const keep = (SLASH_PREFIX.exec(url) as RegExpExecArray)[0].length;

	return url.slice(0, keep) + url.slice(keep, end).replace(/\/\/+/g, '/') + url.slice(end);
}

/**
 * Removes the trailing slashes of a base path.
 * @param {string} base - The base path
 * @returns {string} The base without its trailing slashes
 */
function trimBase(base: string): string {
	let end = base.length;

	while (base[end - 1] === '/') end--;

	return base.slice(0, end);
}

/**
 * Tells whether a URL lies inside a base path, segment by segment: it is the base, or the base followed by `/`, `?` or `#` (`/app/x` and
 * `/app?x` are inside `/app`, `/application` is not).
 * @param {string} url - The URL or path
 * @param {string} root - The base path without trailing slashes (nor query or fragment)
 * @returns {boolean} Whether `url` is inside the base
 */
function isInside(url: string, root: string): boolean {
	// Past the end, `charAt` gives `''`, which `includes` finds: the base itself is inside.
	// `\` counts as `/`, as browsers read it.
	return url.startsWith(root) && '/\\?#'.includes(url.charAt(root.length));
}

/**
 * Mounts a path under a base path (an app served under `/app`): `'/users'` becomes `'/app/users'`. Matching is segment-aware and the
 * function is idempotent: a path that already is the base or lies under it (`/app`, `/app/users`, but not `/application`) is returned
 * unchanged. The query and fragment are kept, leading slashes of the path collapse into the one after the base (so the result never
 * becomes protocol-relative), and a URL with a scheme (`https:`, `mailto:`...) is returned unchanged. An empty or `/` base changes nothing.
 * @param {string} url - The path (may hold a query and fragment)
 * @param {string} base - The base path, with or without a trailing slash (or an absolute URL without query or fragment)
 * @returns {string} The mounted path
 * @example
 * withBase('/users?page=2', '/app'); // => '/app/users?page=2'
 * withBase('users', '/app/'); // => '/app/users'
 * withBase('/app/users', '/app'); // => '/app/users'
 * withBase('/application', '/app'); // => '/app/application'
 * withBase('/v1/items', 'https://api.example.com'); // => 'https://api.example.com/v1/items'
 */
export function withBase(url: string, base: string): string {
	const root = trimBase(base);

	if (root === '' || isInside(url, root) || SCHEME.test(url)) return url;

	// An empty URL, or one that starts with its query or fragment, has no path to join (`charAt(0)` is `''` for the empty URL).
	return root + ('?#'.includes(url.charAt(0)) ? url : withLeadingSlash(url));
}

/**
 * Unmounts a base path: `'/app/users'` becomes `'/users'`, and the base itself becomes `'/'`. Matching is segment-aware: a path outside
 * the base (`/application` for `/app`) is returned unchanged, and so is any URL when the base is empty or `/`. The query and fragment are
 * kept, and the leading slashes of the result collapse into one, so `'/app//evil.example'` gives `'/evil.example'`, never a
 * protocol-relative URL.
 * @param {string} url - The URL or path
 * @param {string} base - The base path, with or without a trailing slash (or an absolute URL without query or fragment)
 * @returns {string} The path relative to the base, starting with `/`
 * @example
 * withoutBase('/app/users?page=2', '/app'); // => '/users?page=2'
 * withoutBase('/app', '/app/'); // => '/'
 * withoutBase('/application', '/app'); // => '/application'
 * withoutBase('https://example.com/docs/intro', 'https://example.com/docs'); // => '/intro'
 */
export function withoutBase(url: string, base: string): string {
	const root = trimBase(base);

	return root !== '' && isInside(url, root) ? withLeadingSlash(url.slice(root.length)) : url;
}

/**
 * A well-formed UTF-8 sequence of percent-escapes (Unicode Table 3-7: no overlong form, surrogate or code point past U+10FFFF), which
 * `decodeURIComponent` always accepts. Each `%[89ab][\da-f]` is a continuation byte (`80`–`BF`). A literal, not `new RegExp(...)`:
 * bundlers keep a module-level constructor call (it could throw), even in bundles that never decode.
 */
const UTF8_ESCAPES =
	/%(?:[0-7][\da-f]|(?:c[2-9a-f]|d[\da-f])%[89ab][\da-f]|(?:e0%[ab][\da-f]|e[1-9a-cef]%[89ab][\da-f]|ed%[89][\da-f])%[89ab][\da-f]|(?:f0%[9ab][\da-f]|f[1-3]%[89ab][\da-f]|f4%8[\da-f])%[89ab][\da-f]%[89ab][\da-f])/gi;

/**
 * Decodes a percent-encoded URL component like `decodeURIComponent`, but never throws: every well-formed escape (a valid UTF-8 sequence)
 * is decoded, and malformed ones (`%E0%A4%A`, a lone `%`, `%ZZ`, invalid UTF-8 such as the Latin-1 `%E9`) are kept as they are, so a
 * single bad escape in user-supplied text does not lose the rest. A string that `decodeURIComponent` accepts gives exactly its result.
 *
 * `+` is NOT decoded to a space (it is component decoding, as in paths and fragments). Query strings, where `+` means a space, are decoded
 * by `parseQueryString` and `getQueryParam`.
 * @param {string} string - The encoded text
 * @returns {string} The decoded text
 * @example
 * safeDecodeURIComponent('caf%C3%A9%20au%20lait'); // => 'café au lait'
 * safeDecodeURIComponent('100%25%20off%'); // => '100% off%'
 * safeDecodeURIComponent('%E0%A4%A'); // => '%E0%A4%A'
 * safeDecodeURIComponent('Jos%E9%20Garc%C3%ADa'); // => 'Jos%E9 García'
 * safeDecodeURIComponent('a+b'); // => 'a+b'
 */
export function safeDecodeURIComponent(string: string): string {
	if (!string.includes('%')) return string;

	try {
		return decodeURIComponent(string);
	} catch {
		return string.replace(UTF8_ESCAPES, decodeURIComponent);
	}
}

/**
 * Sets the fragment of a URL string, replacing any existing one and keeping the query before it. Like the `URL.hash` setter, one leading
 * `#` of `fragment` is ignored and an empty fragment removes it. The fragment is text: it is percent-encoded where needed (spaces, `%`,
 * `#`, non-ASCII...) while `/`, `?`, `:`, `=`, `&`... stay readable for hash routers, so `safeDecodeURIComponent` gives it back.
 * @param {string} url - The URL (absolute or relative)
 * @param {string} fragment - The new fragment, with or without its `#`
 * @returns {string} The URL with the new fragment
 * @example
 * withFragment('/docs?v=2#old', 'install'); // => '/docs?v=2#install'
 * withFragment('/app', '#/users/42?tab=info'); // => '/app#/users/42?tab=info'
 * withFragment('/a', 'section 2 #b'); // => '/a#section%202%20%23b'
 * withFragment('/a#b', ''); // => '/a'
 */
export function withFragment(url: string, fragment: string): string {
	const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
	const base = withoutFragment(url);

	return text === '' ? base : `${base}#${encodeComponent(text, encodeURI).replace(/#/g, '%23')}`;
}

/**
 * Removes the fragment (`#...`) of a URL string.
 * @param {string} url - The URL (absolute or relative)
 * @returns {string} The URL without its fragment
 * @example
 * withoutFragment('/docs?v=2#install'); // => '/docs?v=2'
 */
export function withoutFragment(url: string): string {
	const index = url.indexOf('#');

	return index === -1 ? url : url.slice(0, index);
}

/**
 * Removes the query (`?...`) of a URL string and keeps its fragment (a `?` inside the fragment is not a query).
 * @param {string} url - The URL (absolute or relative)
 * @returns {string} The URL without its query
 * @example
 * withoutQuery('/search?q=a#results'); // => '/search#results'
 * withoutQuery('/page#section?not-a-query'); // => '/page#section?not-a-query'
 */
export function withoutQuery(url: string): string {
	const { base, hash } = splitUrl(url);

	return base + hash;
}

/** An upper-case ASCII letter. */
type UpperLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

/** A decimal digit. */
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** A character of a route parameter name (see {@link matchPath}): an ASCII letter, a digit, `_` or `$`. */
type NameChar = UpperLetter | Lowercase<UpperLetter> | Digit | '_' | '$';

/**
 * The parameter name at the start of `S` (what follows a `:`): its leading run of name characters.
 * @template S - The text after the `:`
 * @template Name - The name read so far
 */
type TakeName<S extends string, Name extends string = ''> = S extends `${infer Char}${infer Rest}` ? (Char extends NameChar ? TakeName<Rest, `${Name}${Char}`> : Name) : Name;

/**
 * Whether `N` is a valid parameter name: name characters only, not starting with a digit.
 * @template N - The name
 */
type IsName<N extends string> = N extends '' | `${Digit}${string}` ? false : [TakeName<N>] extends [N] ? true : false;

/** A `.` as a pattern may write it. */
type Dot = '.' | '%2e' | '%2E';

/**
 * Whether a pattern segment (without its final `?`) is one {@link matchPath} rejects: an empty one, a misplaced `?` or `*`, a
 * parameter without a valid name, two parameters, an invalid splat name, or a static `.` or `..` (also percent-encoded).
 * @template S - The segment
 */
type InvalidSegment<S extends string> = S extends '' | `${string}?${string}`
	? true
	: S extends `*${infer Name}`
		? Name extends ''
			? false
			: IsName<Name> extends true
				? false
				: true
		: S extends `${string}*${string}`
			? true
			: S extends `${string}:${infer Rest}`
				? Rest extends `${string}:${string}`
					? true
					: IsName<TakeName<Rest>> extends true
						? false
						: true
				: S extends Dot | `${Dot}${Dot}`
					? true
					: false;

/**
 * A pattern segment without its final `?`.
 * @template S - The segment
 */
type WithoutMark<S extends string> = S extends `${infer Body}?` ? Body : S;

/**
 * The `/`-separated segments of a route pattern, as a union (tail-recursive, so that long patterns stay within the compiler's limits).
 * @template P - The pattern
 * @template Done - The segments read so far
 */
type PatternSegments<P extends string, Done extends string = never> = P extends `${infer Head}/${infer Rest}` ? PatternSegments<Rest, Done | Head> : Done | P;

/**
 * Whether a parameter name appears twice in the `/`-separated segments of a route pattern (in order, without the leading `/`).
 * @template S - The rest of the pattern
 * @template Seen - The names met so far
 */
type HasRepeatedName<S extends string, Seen extends string = never> = S extends `${infer Head}/${infer Rest}`
	? [SegmentName<WithoutMark<Head>> & Seen] extends [never]
		? HasRepeatedName<Rest, Seen | SegmentName<WithoutMark<Head>>>
		: true
	: [SegmentName<WithoutMark<S>> & Seen] extends [never]
		? false
		: true;

/**
 * Whether a route pattern, without its leading `/`, is one {@link matchPath} accepts (see {@link ParamsOf} for what is checked).
 * @template R - The pattern without its leading `/`
 */
type IsValidPattern<R extends string> = R extends '' // The root `/`.
	? true
	: R extends `${string}#${string}` | `/${string}` | `${string}//${string}` | `*${string}/${string}` | `${string}/*${string}/${string}`
		? false
		: R extends `${infer Body}/` // A trailing slash.
			? IsValidBody<Body>
			: IsValidBody<R>;

/**
 * Whether the segments of a route pattern (without its leading and trailing `/`) are valid, with distinct names.
 * @template B - The segments
 */
type IsValidBody<B extends string> = true extends InvalidSegment<WithoutMark<PatternSegments<B>>> ? false : HasRepeatedName<B> extends true ? false : true;

/**
 * The parameter a pattern segment (without its `?`) captures: the name of a splat (`'*'` for an unnamed one) or of a `:name`, `never`
 * for a static segment.
 * @template S - The segment
 */
type SegmentName<S extends string> = S extends `*${infer Name}` ? (Name extends '' ? '*' : Name) : S extends `${string}:${infer Rest}` ? TakeName<Rest> : never;

/**
 * The parameters of the required segments of a union of pattern segments.
 * @template S - The segments
 */
type RequiredNames<S extends string> = S extends `${string}?` ? never : SegmentName<S>;

/**
 * The parameters of the optional (`?`) segments of a union of pattern segments.
 * @template S - The segments
 */
type OptionalNames<S extends string> = S extends `${infer Body}?` ? SegmentName<Body> : never;

/**
 * Flattens an intersection of object types (cosmetic: editor tooltips show a single object type).
 * @template T - The type
 */
type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * The parameters of a route pattern, each mapped to `V`: required for required segments, optional for `?` segments. A union of
 * patterns gives the union of their parameters; a pattern that is not fully known (`string`, `` `/users/${string}` ``) gives a record
 * of optional values. A pattern gives `never` when {@link matchPath} rejects it for: no leading `/`, a `#`, an empty segment, a
 * misplaced `?` or `*`, a parameter or splat without a valid name, two parameters in a segment, a repeated name, a splat that is not
 * the last segment, or a static `.` or `..` segment (also written `%2E`). Only the runtime catches a dot part behind an encoded
 * separator or a `\` (`/a%2F..`) and more than 256 segments.
 * @template P - The pattern
 * @template V - The value type
 * @template O - The extra type of an optional parameter (`undefined` for inputs, so that `exactOptionalPropertyTypes` accepts it)
 */
type ParamsOf<P extends string, V, O = never> = P extends unknown
	? // A key type with a `string` hole makes an index signature, which `{}` satisfies.
		Record<never, never> extends Record<P, 1>
		? Record<string, V | undefined>
		: P extends `/${infer Rest}`
			? IsValidPattern<Rest> extends true
				? Flatten<{ [K in RequiredNames<PatternSegments<P>>]: V } & { [K in OptionalNames<PatternSegments<P>>]?: V | O }>
				: never
			: never
	: never;

/**
 * The parameters {@link matchPath} captures from a route pattern, typed from the pattern itself: a `:name` or a splat is a required
 * `string`, and an optional one (in a segment ending with `?`) an optional `string`. An unnamed splat (`*`) is captured as `'*'`. A union
 * of patterns gives a union of parameter types, a pattern that is not fully known a record of optional strings, and a malformed pattern
 * (a parameter name starting with a digit, a repeated name, an empty segment...) `never`: {@link matchPath}'s result is then typed
 * `null`, and the builder of {@link compilePath} cannot be called. The types catch every malformed pattern the runtime rejects, except a
 * dot part behind an encoded separator or a `\` (`'/a%2F..'`) and a pattern of more than 256 segments.
 * @template P - The pattern
 * @example
 * type A = PathParams<'/users/:id/posts/:postId?'>; // { id: string; postId?: string }
 * type B = PathParams<'/files/*path'>; // { path: string }
 */
export type PathParams<P extends string> = ParamsOf<P, string>;

/**
 * The parameters accepted by the builder of {@link compilePath}: the keys of {@link PathParams}, with a string or a finite number each
 * (an object without keys for a pattern without parameters, so that a primitive is rejected).
 * @template P - The pattern
 */
export type PathParamsInput<P extends string> = P extends unknown ? WithoutKeys<ParamsOf<P, string | number, undefined>> : never;

/**
 * `T`, or an object type accepting no keys (nor a primitive, unlike `{}`) when `T` has none.
 * @template T - An object type
 */
type WithoutKeys<T> = [keyof T] extends [never] ? NoParams : T;

/** The parameters of a pattern without any: an object without keys. */
type NoParams = Readonly<Record<string, never>>;

/**
 * The function {@link compilePath} returns: it builds a pathname from parameters (which may be omitted when the pattern requires none).
 * For a pattern without parameters, it is overloaded: called without arguments it still fits any builder type that takes optional
 * parameters (`(params?: Record<string, string>) => string`, `PathBuilder<string>`), while a direct call with a primitive or a key is
 * rejected.
 * @template P - The pattern
 */
export type PathBuilder<P extends string> = [PathParamsInput<P>] extends [never]
	? (params: never) => string
	: [PathParamsInput<P>] extends [NoParams]
		? { (): string; (params?: NoParams): string }
		: Record<never, never> extends PathParamsInput<P>
			? (params?: PathParamsInput<P>) => string
			: (params: PathParamsInput<P>) => string;

/**
 * Options accepted by {@link matchPath}.
 */
export interface MatchPathOptions {
	/**
	 * Whether static text must match with the same case (`/Users` vs `/users`). Without it, only ASCII letters are folded (unlike the
	 * `i` flag of path-to-regexp's regular expressions, which also folds `é` and `É`): `/café` does not match `/CAFÉ`, and `/admin` does
	 * not match `/admın`. Parameters always keep their case. Defaults to `false`.
	 */
	readonly caseSensitive?: boolean;
	/**
	 * Whether the pathname must end with `/` exactly when the pattern does (the root `/` matches either way). Defaults to `false`: a
	 * single trailing slash is ignored on both sides.
	 */
	readonly strict?: boolean;
}

/** A segment of a parsed route pattern. */
interface RouteToken {
	/** The parameter name, `'*'` for an unnamed splat, `undefined` for a static segment. */
	readonly name: string | undefined;
	/** Whether the segment ends with `?`. */
	readonly optional: boolean;
	/** The decoded static text: the whole segment for a static segment, the text before the parameter otherwise. */
	readonly prefix: string;
	/** The decoded static text after the parameter. */
	readonly suffix: string;
	/** `prefix` with its ASCII letters lower-cased, for case-insensitive matching. */
	readonly foldedPrefix: string;
	/** `suffix` with its ASCII letters lower-cased, for case-insensitive matching. */
	readonly foldedSuffix: string;
	/** `prefix` as written in the pattern, for building. */
	readonly rawPrefix: string;
	/** `suffix` as written in the pattern, for building. */
	readonly rawSuffix: string;
}

/** A parsed route pattern. */
interface RoutePattern {
	/** The segments, without the splat. */
	readonly tokens: ReadonlyArray<RouteToken>;
	/** The final splat, if any. */
	readonly splat: RouteToken | undefined;
	/** Whether the pattern ends with `/`. */
	readonly trailing: boolean;
	/** How many segments are required (the splat aside). */
	readonly required: number;
}

/** A parameter or splat name: an ASCII letter, `_` or `$`, then ASCII letters, digits, `_` or `$`. */
const PARAM_NAME = /^[A-Za-z_$][\w$]*/;

/** The parsed route patterns, by pattern, least recently used first (that one is dropped beyond {@link PATTERN_CACHE_SIZE}). */
const PATTERNS = new Map<string, RoutePattern>();

/** How many parsed route patterns are kept. */
const PATTERN_CACHE_SIZE = 500;

/** The most segments a route pattern may have: matching takes time quadratic in the number of optional segments, and recurses once per segment. */
const MAX_PATTERN_SEGMENTS = 256;

/** A `.` or `..` part of decoded text, between `/` or `\` separators (which browsers and servers read as `/`). */
const DOT_PART = /(?:^|[/\\])\.\.?(?=$|[/\\])/;

/**
 * Throws the `RangeError` of a malformed route pattern.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} pattern - The pattern
 * @param {string} problem - What is wrong
 * @returns {never} Never returns
 * @throws {RangeError} always
 */
function invalidPattern(caller: string, pattern: string, problem: string): never {
	throw new RangeError(`${caller}: \`pattern\` ${problem}, got ${JSON.stringify(pattern)}`);
}

/**
 * Whether decoded text holds a dot segment, which browsers and servers resolve (`/a/../b` is `/b`): `.` or `..` alone, or as a part
 * between `/` or `\` separators (`..%2F..%2Fetc` decodes to `../../etc`, which a file system resolves just the same).
 * @param {string} text - The decoded text
 * @returns {boolean} Whether it has a `.` or `..` part
 */
function hasDotPart(text: string): boolean {
	return DOT_PART.test(text);
}

/**
 * Lower-cases the ASCII letters of a text, and only them: the length never changes, and no other letter folds into an ASCII one (as
 * `ı`, `ſ` or the Kelvin sign would with full Unicode case mapping).
 * @param {string} text - The text
 * @returns {string} The folded text
 */
function foldCase(text: string): string {
	return text.replace(/[A-Z]+/g, function (letters: string): string {
		return letters.toLowerCase();
	});
}

/**
 * Builds a segment of a parsed route pattern.
 * @param {string | undefined} name - The parameter name, or `undefined` for a static segment
 * @param {boolean} optional - Whether the segment is optional
 * @param {string} rawPrefix - The static text before the parameter (the whole static segment), as written
 * @param {string} rawSuffix - The static text after the parameter, as written
 * @returns {RouteToken} The segment
 */
function routeToken(name: string | undefined, optional: boolean, rawPrefix: string, rawSuffix: string): RouteToken {
	const prefix = safeDecodeURIComponent(rawPrefix);
	const suffix = safeDecodeURIComponent(rawSuffix);

	return { name, optional, prefix, suffix, foldedPrefix: foldCase(prefix), foldedSuffix: foldCase(suffix), rawPrefix, rawSuffix };
}

/**
 * Parses (or finds in the cache) a route pattern.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} pattern - The pattern
 * @returns {RoutePattern} The parsed pattern
 * @throws {TypeError} when `pattern` is not a string
 * @throws {RangeError} when `pattern` is malformed
 */
function parsePattern(caller: string, pattern: string): RoutePattern {
	if (typeof pattern !== 'string') throw new TypeError(`${caller}: \`pattern\` must be a string, got ${describe(pattern)}`);

	const cached = PATTERNS.get(pattern);

	if (cached !== undefined) {
		// The pattern becomes the most recently used one.
		PATTERNS.delete(pattern);
		PATTERNS.set(pattern, cached);

		return cached;
	}

	if (pattern[0] !== '/') invalidPattern(caller, pattern, "must start with '/'");

	if (pattern.includes('#')) invalidPattern(caller, pattern, "must not contain '#'");

	const trailing = pattern.length > 1 && pattern.endsWith('/');
	const body = pattern.slice(1, trailing ? -1 : pattern.length);

	if (trailing && body === '') invalidPattern(caller, pattern, 'has an empty segment');

	const parts = body === '' ? [] : body.split('/');

	if (parts.length > MAX_PATTERN_SEGMENTS) invalidPattern(caller, pattern, `must have at most ${MAX_PATTERN_SEGMENTS} segments`);

	const tokens: RouteToken[] = [];
	const names = new Set<string>();
	let splat: RouteToken | undefined;
	let required = 0;

	for (const segment of parts) {
		const optional = segment.endsWith('?');
		const text = optional ? segment.slice(0, -1) : segment;
		let token: RouteToken;

		if (splat !== undefined) invalidPattern(caller, pattern, 'must end with its splat');

		if (text === '') invalidPattern(caller, pattern, 'has an empty segment');

		if (text.includes('?')) invalidPattern(caller, pattern, "can only have a '?' at the end of a segment");

		if (text[0] === '*') {
			const name = text.slice(1);

			if (name !== '' && PARAM_NAME.exec(name)?.[0] !== name) invalidPattern(caller, pattern, `has an invalid splat name ${JSON.stringify(name)}`);

			token = splat = routeToken(name || '*', optional, '', '');
		} else {
			const colon = text.indexOf(':');

			if (text.includes('*')) invalidPattern(caller, pattern, "can only have a '*' at the start of a segment");

			if (colon === -1) {
				token = routeToken(undefined, optional, text, '');

				if (hasDotPart(token.prefix)) invalidPattern(caller, pattern, 'has a dot segment');
			} else {
				const name = PARAM_NAME.exec(text.slice(colon + 1))?.[0];

				if (name === undefined) invalidPattern(caller, pattern, 'has a parameter without a valid name');

				const rawSuffix = text.slice(colon + 1 + name.length);

				if (rawSuffix.includes(':')) invalidPattern(caller, pattern, 'has two parameters in one segment');

				token = routeToken(name, optional, text.slice(0, colon), rawSuffix);
			}
		}

		if (token.name !== undefined) {
			if (names.has(token.name)) invalidPattern(caller, pattern, `has the parameter ${JSON.stringify(token.name)} twice`);

			names.add(token.name);
		}

		if (token !== splat) {
			tokens.push(token);

			if (!optional) required++;
		}
	}

	if (trailing && splat !== undefined) invalidPattern(caller, pattern, 'must end with its splat');

	const parsed: RoutePattern = { tokens, splat, trailing, required };

	// The least recently used pattern makes room: an app uses a bounded set of patterns, so this only matters for patterns built from data.
	if (PATTERNS.size >= PATTERN_CACHE_SIZE) PATTERNS.delete(PATTERNS.keys().next().value as string);

	PATTERNS.set(pattern, parsed);

	return parsed;
}

/**
 * Whether a decoded pathname segment matches a (non-splat) segment of a pattern. A parameter never matches empty text.
 * @param {RouteToken} token - The pattern segment
 * @param {string} segment - The decoded pathname segment
 * @param {boolean} caseSensitive - Whether static text is compared with its case
 * @returns {boolean} Whether it matches
 */
function fitsSegment(token: RouteToken, segment: string, caseSensitive: boolean): boolean {
	const { prefix, suffix } = token;

	if (token.name === undefined) return caseSensitive ? segment === prefix : foldCase(segment) === token.foldedPrefix;

	if (segment.length <= prefix.length + suffix.length) return false;

	return caseSensitive
		? segment.startsWith(prefix) && segment.endsWith(suffix)
		: foldCase(segment.slice(0, prefix.length)) === token.foldedPrefix && foldCase(segment.slice(segment.length - suffix.length)) === token.foldedSuffix;
}

/**
 * Whether the rest of a pathname can start a splat: it is not empty, and does not start with a separator (`/files//etc` must not give
 * the absolute `/etc`).
 * @param {string | undefined} first - Its first decoded segment (`undefined` when there is none)
 * @returns {boolean} Whether a splat can capture it
 */
function startsSplat(first: string | undefined): boolean {
	return first !== undefined && first !== '' && first[0] !== '/' && first[0] !== '\\';
}

/**
 * Matches decoded pathname segments against a parsed pattern. Optional segments are filled from the left: each one takes the next
 * segment when the rest of the pattern can still match the rest of the pathname. Whether it can is memoized for each pair of
 * positions, and a pattern segment consumes at most one pathname segment, so the work is O(pattern segments² + pattern segments ×
 * pathname length) however the optional segments combine (no backtracking).
 * @param {RoutePattern} parsed - The pattern
 * @param {ReadonlyArray<string>} segments - The decoded pathname segments
 * @param {boolean} caseSensitive - Whether static text is compared with its case
 * @returns {Record<string, string> | null} The parameters (null prototype), or `null` when the pathname does not match
 */
function matchSegments(parsed: RoutePattern, segments: ReadonlyArray<string>, caseSensitive: boolean): Record<string, string> | null {
	const { tokens, splat } = parsed;
	const count = tokens.length;
	const length = segments.length;
	// `fits(index, position)`, for `position <= index` (each pattern segment consumes at most one pathname segment): 0 when not known
	// yet, 1 when false, 2 when true. A typed array: a missing slot of a plain one would be read from a polluted `Object.prototype[0]`.
	const memo = new Uint8Array((count + 1) * (count + 1));

	/**
	 * Whether the pattern segments from `index` on match the pathname segments from `position` on.
	 * @param {number} index - The first pattern segment
	 * @param {number} position - The first pathname segment
	 * @returns {boolean} Whether they match
	 */
	function fits(index: number, position: number): boolean {
		// The rest of the pathname goes to the splat (which needs some text unless it is optional), or there must be none left.
		if (index === count) return splat === undefined ? position === length : position === length ? splat.optional : startsSplat(segments[position]);

		const slot = index * (count + 1) + position;

		if (memo[slot] === 0) {
			const token = tokens[index];

			memo[slot] =
				(position < length && fitsSegment(token, segments[position], caseSensitive) && fits(index + 1, position + 1)) || (token.optional && fits(index + 1, position))
					? 2
					: 1;
		}

		return memo[slot] === 2;
	}

	if (!fits(0, 0)) return null;

	const params = Object.create(null) as Record<string, string>;
	let position = 0;

	for (let index = 0; index < count; index++) {
		const token = tokens[index];
		const segment = segments[position];

		// Otherwise the segment is optional and skipped: `fits(index, position)` holds, so `fits(index + 1, position)` does.
		if (position < length && fitsSegment(token, segment, caseSensitive) && fits(index + 1, position + 1)) {
			if (token.name !== undefined) params[token.name] = segment.slice(token.prefix.length, segment.length - token.suffix.length);

			position++;
		}
	}

	if (splat !== undefined && position < length) params[splat.name as string] = segments.slice(position).join('/');

	return params;
}

/**
 * Matches a pathname against a route pattern and returns the parameters it captures, or `null` when it does not match.
 *
 * Pattern syntax (the pattern starts with `/`; its segments are separated by `/`):
 * - `:name` captures a whole segment, or the part of a segment between static text (`/@:handle`, `/:file.json`, `/v:major`); at most
 *   one parameter per segment. A name is an ASCII letter, `_` or `$`, followed by ASCII letters, digits, `_` or `$`.
 * - `*name` (or `*`, captured as `'*'`) is a splat: the last segment, capturing the rest of the pathname (one or more segments, `/`
 *   included).
 * - A `?` at the end of a segment makes it optional, static or not (`/:lang?/docs`, `/docs?`, `/files/*path?`). Optional segments are
 *   filled from the left.
 * - Anything else is static text. Write a literal `:`, `*` or `?` percent-encoded (`%3A`, `%2A`, `%3F`).
 *
 * Matching works segment by segment, without building a regular expression, so nothing can make it backtrack: for a given pattern it
 * takes time linear in the length of the pathname (and at worst quadratic in the number of optional segments of the pattern, which has at
 * most 256 segments):
 * - The query and fragment of `pathname` are ignored, and it must start with `/` (pass `url.pathname`, not a full URL).
 * - Each pathname segment is percent-decoded with {@link safeDecodeURIComponent} (malformed escapes are kept as they are) before it is
 *   compared, static text included (`/caf%C3%A9` matches `/café`); `%2F` inside a segment stays inside it (`/users/a%2Fb` gives `a/b`).
 * - A parameter never matches an empty segment, so `/users//42` does not match `/users/:id`.
 * - A pathname with a `.` or `..` segment never matches, also percent-encoded, and also as a part of a decoded segment between `/` or `\`
 *   (`..%2F..%2Fetc`): it is not normalized, and a parameter holding `..` is a path traversal waiting to happen. Normalize it first
 *   (`new URL(path, 'http://x').pathname`). A splat never starts with a separator (`/files//etc` does not give the absolute `/etc`).
 * - Static text is compared without case by default, folding ASCII letters only; parameters keep their case.
 * - A single trailing slash is ignored unless `strict` is set; a splat then gets no trailing slash, while with `strict` it keeps it.
 *
 * The result has a `null` prototype, so a parameter named `__proto__` or `constructor` is an ordinary own key. Optional parameters that
 * matched nothing are absent. Only the own properties of `options` are read. Parsed patterns are cached (the 500 most recently used), and
 * malformed ones throw rather than never matching.
 * @template P - The pattern
 * @param {P} pattern - The route pattern, e.g. `'/users/:id'`
 * @param {string} pathname - The pathname to match (a query and a fragment are ignored)
 * @param {MatchPathOptions} [options={}] - `caseSensitive` (default `false`) and `strict` (default `false`)
 * @returns {PathParams<P> | null} The captured parameters, or `null`
 * @throws {TypeError} when `pattern` or `pathname` is not a string, or `options` is not an object
 * @throws {RangeError} when `pattern` is malformed (no leading `/`, an empty segment, a misplaced `*` or `?`, a parameter without a name,
 *   two parameters in a segment, a repeated name, a dot segment, a `#`, or more than 256 segments)
 * @example
 * matchPath('/users/:id', '/users/42'); // => { id: '42' }
 * matchPath('/users/:id/posts/:postId?', '/users/42/posts'); // => { id: '42' }
 * matchPath('/files/*path', '/files/a/b%20c.txt?download=1'); // => { path: 'a/b c.txt' }
 * matchPath('/@:handle/:file.json', '/@ada/notes.json'); // => { handle: 'ada', file: 'notes' }
 * matchPath('/:lang?/docs', '/DOCS/'); // => {}
 * matchPath('/users/:id', '/users/42/', { strict: true }); // => null
 * matchPath('/files/*path', '/files/../etc/passwd'); // => null
 * matchPath('/files/:name', '/files/..%2F..%2Fetc%2Fpasswd'); // => null
 * matchPath('/users/:id', 'users/42'); // => null
 * matchPath('/users/:id:x', '/users/1'); // throws RangeError
 */
export function matchPath<P extends string>(pattern: P, pathname: string, options: MatchPathOptions = {}): PathParams<P> | null {
	const parsed = parsePattern('matchPath', pattern);

	if (typeof pathname !== 'string') throw new TypeError(`matchPath: \`pathname\` must be a string, got ${describe(pathname)}`);

	if (typeof options !== 'object' || options === null) throw new TypeError(`matchPath: \`options\` must be an object, got ${describe(options)}`);

	// Own options only (read once each): a polluted `Object.prototype.strict` must not change how paths match.
	const { caseSensitive, strict: strictOption } = Object.assign(Object.create(null) as object, options) as MatchPathOptions;
	const strict = strictOption === true;
	let path = pathname.slice(0, pathEnd(pathname));

	if (path[0] !== '/') return null;

	const trailing = path.length > 1 && path.endsWith('/');

	// In strict mode, a trailing slash must match the pattern's (the root `/` matches either way), or belongs to a splat's text.
	// Otherwise it is dropped.
	if (strict && parsed.splat === undefined && trailing !== parsed.trailing && path !== '/') return null;

	if (trailing && !(strict && parsed.splat !== undefined)) path = path.slice(0, -1);

	const raw = path === '/' ? [] : path.slice(1).split('/');

	// Too few or (without a splat) too many segments: nothing to decode.
	if (raw.length < parsed.required || (parsed.splat === undefined && raw.length > parsed.tokens.length)) return null;

	const segments: string[] = [];

	for (let index = 0; index < raw.length; index++) {
		const segment = safeDecodeURIComponent(raw[index]);

		if (hasDotPart(segment)) return null;

		segments.push(segment);
	}

	return matchSegments(parsed, segments, caseSensitive === true) as PathParams<P> | null;
}

/**
 * Reads and checks a parameter value for the builder of {@link compilePath}.
 * @param {object} params - The parameters
 * @param {RouteToken} token - The pattern segment of the parameter
 * @returns {string | undefined} The value as text, or `undefined` for an omitted optional parameter
 * @throws {TypeError} when a required parameter is missing, or a value is not a string or a number
 * @throws {RangeError} when a value is empty or not finite
 */
function paramText(params: object, token: RouteToken): string | undefined {
	const name = token.name as string;
	// Own properties only: a parameter named `constructor` or `toString` must not read `Object.prototype`.
	const value: unknown = Object.hasOwn(params, name) ? (params as Record<string, unknown>)[name] : undefined;

	if (value === undefined && token.optional) return undefined;

	if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`compilePath: \`params.${name}\` must be a string or a number, got ${describe(value)}`);

	if (value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
		throw new RangeError(`compilePath: \`params.${name}\` must be a non-empty string or a finite number, got ${JSON.stringify(String(value))}`);
	}

	return String(value);
}

/**
 * Percent-encodes a parameter for the builder of {@link compilePath}, with the static text around it.
 * @param {RouteToken} token - The pattern segment of the parameter
 * @param {string} text - The parameter text
 * @returns {string} The segment
 * @throws {RangeError} when the segment would hold a dot segment
 */
function encodeSegment(token: RouteToken, text: string): string {
	// Browsers and servers resolve `.` and `..` even percent-encoded (`%2e%2e`), and `matchPath` rejects them inside a decoded segment.
	if (hasDotPart(token.prefix + text + token.suffix)) {
		throw new RangeError(`compilePath: \`params.${token.name as string}\` must not make a dot segment ('.' or '..'), got ${JSON.stringify(text)}`);
	}

	return token.rawPrefix + encodeComponent(text) + token.rawSuffix;
}

/**
 * Compiles a route pattern (see {@link matchPath} for the syntax) into a function that builds pathnames from parameters, the inverse of
 * {@link matchPath}:
 * - Parameter values are strings or finite numbers, percent-encoded with `encodeURIComponent` (`/` becomes `%2F`, lone surrogates
 *   U+FFFD); a splat's value is a sub-path: its `/` are kept and each of its segments is encoded.
 * - A missing required parameter throws; an optional one (`undefined` or absent) leaves its whole segment out. Unknown keys are ignored,
 *   and only own properties are read.
 * - An empty value throws, and so does a value making a dot segment, or a `.` or `..` part between `/` or `\` (`../etc`), and a splat
 *   starting with `/` or `\`: {@link matchPath} would never match them.
 * - Static text (optional or not) is written as it appears in the pattern, and so is the pattern's trailing slash.
 * - The pathname must match back to the same parameters (static text compared without case, as {@link matchPath} does by default),
 *   or the builder throws: adjacent optional segments can take each other's text (`'/:a?/:b?'` with only `b`, `'/:a?/docs?'` with no `a`).
 *
 * So `matchPath(pattern, build(params))` always gives the parameters back as strings (lone surrogates as U+FFFD), except that a splat
 * ending with `/` loses it unless `strict` is set. The pattern is parsed once, here: a malformed pattern throws at once.
 * @template P - The pattern
 * @param {P} pattern - The route pattern, e.g. `'/users/:id'`
 * @returns {PathBuilder<P>} The pathname builder
 * @throws {TypeError} when `pattern` is not a string; the builder: when `params` is not an object, a required parameter is missing, or a
 *   value is not a string or a number
 * @throws {RangeError} when `pattern` is malformed (see {@link matchPath}); the builder: when a value is empty or not finite, makes a
 *   dot segment, starts a splat with a separator, or the pathname would match back to other parameters
 * @example
 * const userPath = compilePath('/users/:id/posts/:postId?');
 * userPath({ id: 42 }); // => '/users/42/posts'
 * userPath({ id: 'a/b', postId: 'x y' }); // => '/users/a%2Fb/posts/x%20y'
 * compilePath('/files/*path')({ path: 'docs/read me.md' }); // => '/files/docs/read%20me.md'
 * compilePath('/about')(); // => '/about'
 * compilePath('/users/:id')({ id: '..' }); // throws RangeError
 * compilePath('/users/:id')({} as never); // throws TypeError
 * compilePath('/:a?/:b?')({ b: 'x' }); // throws RangeError // '/x' would match back as { a: 'x' }
 */
export function compilePath<P extends string>(pattern: P): PathBuilder<P> {
	const parsed = parsePattern('compilePath', pattern);
	const { tokens, splat, trailing } = parsed;

	return function (params?: object): string {
		if (params === undefined) params = {};
		else if (typeof params !== 'object' || params === null) throw new TypeError(`compilePath: \`params\` must be an object, got ${describe(params)}`);

		let path = '';
		// The segments as `matchPath` decodes them, and the parameters it must read from them.
		const segments: string[] = [];
		const expected = Object.create(null) as Record<string, string>;

		/**
		 * Appends a built segment.
		 * @param {string} segment - The segment, encoded
		 * @returns {void}
		 */
		function append(segment: string): void {
			path += '/' + segment;
			segments.push(safeDecodeURIComponent(segment));
		}

		for (const token of tokens) {
			const text = token.name === undefined ? '' : paramText(params, token);

			if (text === undefined) continue;

			append(token.name === undefined ? token.rawPrefix : encodeSegment(token, text));

			if (token.name !== undefined) expected[token.name] = text.replace(LONE_SURROGATES, '\ufffd');
		}

		const rest = splat === undefined ? undefined : paramText(params, splat);

		if (rest !== undefined) {
			const name = (splat as RouteToken).name as string;

			if (!startsSplat(rest)) throw new RangeError(`compilePath: \`params.${name}\` must not start with a separator, got ${JSON.stringify(rest)}`);

			for (const part of rest.split('/')) append(encodeSegment(splat as RouteToken, part));

			expected[name] = rest.replace(LONE_SURROGATES, '\ufffd');
		}

		const matched = matchSegments(parsed, segments, false);
		const keys = Object.keys(expected);

		if (
			matched === null ||
			Object.keys(matched).length !== keys.length ||
			keys.some(function (key: string): boolean {
				return matched[key] !== expected[key];
			})
		) {
			throw new RangeError(
				`compilePath: \`params\` must match back to themselves, but ${JSON.stringify(pattern)} reads ${JSON.stringify(path)} as ${JSON.stringify(matched)}`
			);
		}

		return trailing ? path + '/' : path || '/';
	} as PathBuilder<P>;
}

/**
 * The `SameSite` attribute of a cookie: `'strict'` (never sent on cross-site requests), `'lax'` (sent on top-level cross-site
 * navigations only, the browsers' default) or `'none'` (always sent; requires `secure`).
 */
export type CookieSameSite = 'strict' | 'lax' | 'none';

/** The `Priority` attribute of a cookie (a Chromium extension): which cookies are evicted first when a domain has too many. */
export type CookiePriority = 'low' | 'medium' | 'high';

/**
 * Options accepted by {@link serializeCookie}: the cookie's attributes (RFC 6265 and its successor drafts), and how to encode its value.
 */
export interface SerializeCookieOptions {
	/** `Max-Age`: the lifetime in seconds, an integer (`0` or less deletes the cookie). Browsers prefer it to `expires`. */
	readonly maxAge?: number;
	/** `Expires`: the expiry date. Without `maxAge` or `expires`, the cookie lasts for the browser session. */
	readonly expires?: Date;
	/** `Domain`: the host whose subdomains also receive the cookie. Without it, only the exact host that set it does. */
	readonly domain?: string;
	/** `Path`: the path prefix the cookie is sent for. Without it, the directory of the request that set it. */
	readonly path?: string;
	/** `Secure`: send the cookie over HTTPS only. Defaults to `false`. */
	readonly secure?: boolean;
	/** `HttpOnly`: hide the cookie from `document.cookie`. Defaults to `false`. */
	readonly httpOnly?: boolean;
	/** `SameSite`: whether the cookie is sent on cross-site requests. Browsers default to `'lax'`. */
	readonly sameSite?: CookieSameSite;
	/** `Partitioned` (CHIPS): keep a separate cookie jar per top-level site. Requires `secure`. Defaults to `false`. */
	readonly partitioned?: boolean;
	/** `Priority`. */
	readonly priority?: CookiePriority;
	/**
	 * Encodes the value. Defaults to `encodeURIComponent` (lone surrogates become U+FFFD), which {@link parseCookie} undoes; its result
	 * must be a valid cookie value.
	 */
	readonly encode?: (value: string) => string;
}

/**
 * Removes the spaces and tabs around a slice of text.
 * @param {string} text - The text
 * @param {number} start - Index of the slice's first character
 * @param {number} end - Index after the slice's last character
 * @returns {string} The trimmed slice
 */
function trimSpaces(text: string, start: number, end: number): string {
	while (start < end && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;

	while (end > start && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;

	return text.slice(start, end);
}

/**
 * Parses a `Cookie` request header (`'a=1; b=2'`) into a record of cookie values, like the `cookie` package's `parse`: names and values
 * are trimmed of spaces and tabs, a value wrapped in double quotes loses them, and values are decoded with
 * {@link safeDecodeURIComponent} (so a malformed escape is kept as it is, where `cookie` keeps the whole value undecoded). The first
 * occurrence of a name wins (browsers send the most specific cookie first). Malformed pairs (without `=`) are skipped: it never throws
 * on a string. Runs in linear time.
 *
 * The result has a `null` prototype, so a `__proto__` or `constructor` cookie is an ordinary own key; use `Object.hasOwn` or `in` on it.
 * @param {string} header - The value of a `Cookie` header (`document.cookie` has the same format)
 * @returns {Record<string, string>} The cookies, by name
 * @throws {TypeError} when `header` is not a string
 * @example
 * parseCookie('theme=dark; lang=en'); // => { theme: 'dark', lang: 'en' }
 * parseCookie('a=1; a=2; b="quoted"; c=caf%C3%A9; d=100%'); // => { a: '1', b: 'quoted', c: 'café', d: '100%' }
 * parseCookie('broken; ok=1'); // => { ok: '1' }
 */
export function parseCookie(header: string): Record<string, string> {
	if (typeof header !== 'string') throw new TypeError(`parseCookie: \`header\` must be a string, got ${describe(header)}`);

	const cookies = Object.create(null) as Record<string, string>;
	let index = 0;

	while (index < header.length) {
		const equals = header.indexOf('=', index);

		if (equals === -1) break;

		const semicolon = header.indexOf(';', index);
		const end = semicolon === -1 ? header.length : semicolon;

		if (equals > end) {
			// The pairs without `=` are skipped at once, up to the pair holding that `=` (rescanning them one by one would be quadratic).
			index = header.lastIndexOf(';', equals) + 1;
			continue;
		}

		const name = trimSpaces(header, index, equals);

		if (!(name in cookies)) {
			let value = trimSpaces(header, equals + 1, end);

			if (value.length > 1 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) value = value.slice(1, -1);

			cookies[name] = safeDecodeURIComponent(value);
		}

		index = end + 1;
	}

	return cookies;
}

/** A cookie name: an RFC 7230 token, as RFC 6265 requires (no control character, space or separator such as `;`, `=`, `,` or `"`). */
const COOKIE_NAME = /^[\w!#$%&'*+.^`|~-]+$/;

/** A cookie value (RFC 6265 §4.1.1): printable ASCII except space, `"`, `,`, `;` and `\`, optionally wrapped in double quotes. */
const COOKIE_VALUE = /^("?)[!#-+\--:<-[\]-~]*\1$/;

/** A `Domain` attribute: labels of letters, digits and inner hyphens, up to 63 characters each, with an optional leading dot. */
const COOKIE_DOMAIN = /^\.?[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;

/** A `Path` attribute (RFC 6265 §4.1.1): printable ASCII except `;`. */
const COOKIE_PATH = /^[ -:<-~]*$/;

/**
 * Reads a boolean option.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {object} options - The options
 * @param {string} key - The option name
 * @returns {boolean} Its value, `false` when absent
 * @throws {TypeError} when the option is neither absent nor a boolean
 */
function flagOption(caller: string, options: object, key: string): boolean {
	const value = readOption(options as Record<string, unknown>, key, false);

	if (typeof value !== 'boolean') throw new TypeError(`${caller}: \`${key}\` must be a boolean, got ${describe(value)}`);

	return value;
}

/**
 * Reads an option of {@link serializeCookie} that must be one of a few names, and capitalizes it for the attribute.
 * @param {SerializeCookieOptions} options - The options
 * @param {'sameSite' | 'priority'} key - The option name
 * @param {ReadonlyArray<string>} names - The accepted names
 * @returns {string | undefined} The capitalized name, `undefined` when absent
 * @throws {RangeError} when the option is not one of `names`
 */
function cookieChoice(options: SerializeCookieOptions, key: 'sameSite' | 'priority', names: ReadonlyArray<string>): string | undefined {
	const value: unknown = readOption(options, key);

	if (value === undefined) return undefined;

	if (!names.includes(value as string)) {
		throw new RangeError(`serializeCookie: \`${key}\` must be '${names.slice(0, -1).join("', '")}' or '${names[names.length - 1]}', got ${show(value)}`);
	}

	return (value as string)[0].toUpperCase() + (value as string).slice(1);
}

/**
 * Throws the error for a part of {@link serializeCookie}'s output that would break the header's syntax.
 * @param {string} key - The parameter or option name
 * @param {unknown} value - Its value
 * @param {string} expected - What it must be
 * @returns {never} Never returns
 * @throws {TypeError} always
 */
function invalidCookiePart(key: string, value: unknown, expected: string): never {
	throw new TypeError(`serializeCookie: \`${key}\` must be ${expected}, got ${typeof value === 'string' ? JSON.stringify(value) : describe(value)}`);
}

/**
 * Builds a `Set-Cookie` header value (`'name=value; Path=/; HttpOnly'`) like the `cookie` package's `serialize`, with the attributes
 * in the same order.
 *
 * Header injection is impossible: the name must be an RFC 7230 token, the encoded value an RFC 6265 cookie value, the domain a host name
 * and the path printable ASCII without `;`; anything else (a `;`, a line break, a space in the name…) throws a `TypeError` instead of
 * slipping in another attribute or header. The value is encoded with `encodeURIComponent` by default, so any string is accepted.
 *
 * Unlike `cookie`, it also rejects the combinations that browsers silently drop: `sameSite: 'none'`, `partitioned`, or a `__Secure-` or
 * `__Host-` name without `secure`, and a `__Host-` cookie with a `domain` or a `path` other than `'/'`. Its name grammar is RFC 6265's
 * (stricter than `cookie` 1.x, which also accepts separators such as `(`, `@` or `/`), and `sameSite` and `priority` must be lowercase.
 * @param {string} name - The cookie name
 * @param {string} value - The cookie value (encoded with `options.encode`)
 * @param {SerializeCookieOptions} [options={}] - The attributes, and `encode`
 * @returns {string} The `Set-Cookie` header value
 * @throws {TypeError} when `name`, the encoded `value`, `domain` or `path` is invalid, or an option has the wrong type
 * @throws {RangeError} when `maxAge` is not an integer, `expires` is an invalid date, `sameSite` or `priority` is unknown, or the
 * attributes form a combination that browsers reject
 * @example
 * serializeCookie('theme', 'dark'); // => 'theme=dark'
 * serializeCookie('sid', 'a b;c', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 3600 }); // => 'sid=a%20b%3Bc; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax'
 * serializeCookie('id', '1', { expires: new Date(Date.UTC(2030, 0, 1)) }); // => 'id=1; Expires=Tue, 01 Jan 2030 00:00:00 GMT'
 * serializeCookie('bad;name', 'x'); // throws TypeError
 * serializeCookie('id', '1', { path: '/\r\nSet-Cookie: admin=1' }); // throws TypeError
 * serializeCookie('id', '1', { sameSite: 'none' }); // throws RangeError // browsers require Secure with SameSite=None
 */
export function serializeCookie(name: string, value: string, options: SerializeCookieOptions = {}): string {
	if (typeof options !== 'object' || options === null) throw new TypeError(`serializeCookie: \`options\` must be an object, got ${describe(options)}`);

	if (typeof name !== 'string' || !COOKIE_NAME.test(name)) invalidCookiePart('name', name, "a cookie name (letters, digits and !#$%&'*+-.^_`|~)");

	if (typeof value !== 'string') throw new TypeError(`serializeCookie: \`value\` must be a string, got ${describe(value)}`);

	const encode: unknown = readOption(options, 'encode');

	if (encode !== undefined) assertFunction('serializeCookie', 'encode', encode);

	const encoded: unknown = encode === undefined ? encodeComponent(value) : (encode as (value: string) => unknown)(value);

	if (typeof encoded !== 'string' || !COOKIE_VALUE.test(encoded)) {
		invalidCookiePart('value', encoded, "a cookie value once encoded (printable ASCII except spaces and '\"', ',', ';' or '\\')");
	}

	let cookie = `${name}=${encoded}`;
	const maxAge: unknown = readOption(options, 'maxAge');

	if (maxAge !== undefined) {
		assertNumber('serializeCookie', 'maxAge', maxAge, Number.isSafeInteger(maxAge), 'an integer (seconds)');
		cookie += `; Max-Age=${maxAge}`;
	}

	const domain: unknown = readOption(options, 'domain');

	if (domain !== undefined) {
		if (typeof domain !== 'string' || !COOKIE_DOMAIN.test(domain)) invalidCookiePart('domain', domain, 'a host name (ASCII letters, digits, hyphens and dots)');

		cookie += `; Domain=${domain}`;
	}

	const path: unknown = readOption(options, 'path');

	if (path !== undefined) {
		if (typeof path !== 'string' || !COOKIE_PATH.test(path)) invalidCookiePart('path', path, "printable ASCII without ';'");

		cookie += `; Path=${path}`;
	}

	const expires: unknown = readOption(options, 'expires');

	if (expires !== undefined) {
		if (!isDate(expires)) throw new TypeError(`serializeCookie: \`expires\` must be a Date, got ${describe(expires)}`);

		if (Number.isNaN(Date.prototype.getTime.call(expires))) throw new RangeError('serializeCookie: `expires` must be a valid Date, got Invalid Date');

		cookie += `; Expires=${Date.prototype.toUTCString.call(expires)}`;
	}

	const httpOnly = flagOption('serializeCookie', options, 'httpOnly');
	const secure = flagOption('serializeCookie', options, 'secure');
	const partitioned = flagOption('serializeCookie', options, 'partitioned');

	if (httpOnly) cookie += '; HttpOnly';

	if (secure) cookie += '; Secure';

	if (partitioned) cookie += '; Partitioned';

	const priority = cookieChoice(options, 'priority', ['low', 'medium', 'high']);

	if (priority !== undefined) cookie += `; Priority=${priority}`;

	const sameSite = cookieChoice(options, 'sameSite', ['strict', 'lax', 'none']);

	if (sameSite !== undefined) cookie += `; SameSite=${sameSite}`;

	// The rules under which browsers silently drop a cookie (RFC 6265bis cookie prefixes and SameSite=None, CHIPS).
	const prefix = /^__(?:secure|host)-/i.exec(name);
	const insecure = sameSite === 'None' ? "`sameSite` is 'none'" : partitioned ? '`partitioned` is set' : prefix !== null ? `the name starts with "${prefix[0]}"` : '';

	if (!secure && insecure !== '') throw new RangeError(`serializeCookie: \`secure\` must be true when ${insecure} (browsers reject the cookie otherwise)`);

	if (prefix !== null && prefix[0].length === 7 && (domain !== undefined || path !== '/')) {
		throw new RangeError(`serializeCookie: a "${prefix[0]}" cookie must have \`path: '/'\` and no \`domain\` (browsers reject it otherwise)`);
	}

	return cookie;
}

/**
 * The main members of a WHATWG `URL`, for type environments without one (plain ES2022 has no DOM or Node types).
 */
interface UrlLike {
	href: string;
	readonly origin: string;
	protocol: string;
	username: string;
	password: string;
	host: string;
	hostname: string;
	port: string;
	pathname: string;
	search: string;
	readonly searchParams: Iterable<[string, string]> & { get(name: string): string | null };
	hash: string;
	toString(): string;
	toJSON(): string;
}

/**
 * A WHATWG `URL` instance: the global `URL` type when the type environment declares one (the DOM library or `@types/node`), else
 * `UrlLike`.
 */
export type UrlObject = typeof globalThis extends { URL: abstract new (...args: never[]) => infer U } ? U : UrlLike;

/**
 * Options accepted by {@link normalizeUrl}. They all default to `false` (or `[]`): without options, only the changes that keep the
 * URL's meaning are made.
 */
export interface NormalizeUrlOptions {
	/** Remove the fragment (`#…`). */
	readonly stripHash?: boolean;
	/** Remove a leading `www.` from the host (`www.example.com` → `example.com`; `www.com` and `www.www.example.com` are kept). */
	readonly stripWww?: boolean;
	/** Sort the query parameters by name (stably, by UTF-16 code units). Re-encodes the query as `URLSearchParams` does (`a` → `a=`). */
	readonly sortQuery?: boolean;
	/** Remove the trailing slashes of the path (`/docs/` → `/docs`), except the root path `/`. */
	readonly removeTrailingSlash?: boolean;
	/**
	 * Remove the query parameters whose name equals one of these strings or matches one of these regular expressions (e.g. `[/^utm_/i]`).
	 * When one is removed, the query is re-encoded as `URLSearchParams` does.
	 */
	readonly removeQueryParams?: ReadonlyArray<string | RegExp>;
	/** Turn `http:` into `https:` (an explicit `:443` port then disappears as the default one). */
	readonly forceHttps?: boolean;
}

/** A percent-escape. */
const ESCAPE = /%[\da-f]{2}/gi;

/** A character that RFC 3986 calls unreserved: it never needs encoding, so decoding its escape does not change the URL. */
const UNRESERVED = /[\w.~-]/;

/**
 * Normalizes the percent-escapes of URL text (RFC 3986 §6.2.2): an escape of an unreserved character is decoded, any other gets
 * uppercase hex digits.
 * @param {string} text - The URL text
 * @returns {string} The text with normalized escapes
 */
function normalizeEscapes(text: string): string {
	return text.replace(ESCAPE, function (escape: string): string {
		const char = String.fromCharCode(parseInt(escape.slice(1), 16));

		return UNRESERVED.test(char) ? char : escape.toUpperCase();
	});
}

/**
 * Normalizes an absolute URL so that equivalent spellings compare equal (for cache keys, deduplication or canonical links), like
 * `normalize-url` and ufo's `normalizeURL`. Built on the WHATWG URL parser, so it reads URLs exactly as browsers do.
 *
 * Always done (these keep the URL's meaning, RFC 3986 §6.2.2): the scheme and host are lowercased (an internationalized host becomes
 * punycode), a default port (`:80` for `http:`, `:443` for `https:`…) is removed, `.` and `..` path segments are resolved, escapes of
 * unreserved characters are decoded (`%7E` → `~`, `%41` → `A`) and the other escapes get uppercase hex digits (`%2f` → `%2F`), and an
 * empty query or fragment (a bare `?` or `#`) is removed. The other changes are opt-in, since they can change what the URL points to.
 *
 * The result is a fixed point: `normalizeUrl(normalizeUrl(url, options), options) === normalizeUrl(url, options)`.
 * @param {string | UrlObject} url - An absolute URL
 * @param {NormalizeUrlOptions} [options={}] - `stripHash`, `stripWww`, `sortQuery`, `removeTrailingSlash`, `removeQueryParams` and
 * `forceHttps`, all off by default
 * @returns {string} The normalized URL
 * @throws {TypeError} when `url` is not an absolute URL (or a `URL`), or one whose serialization the runtime cannot parse back (some
 *   internationalized hosts in Node 26), `options` is not an object, or an option has the wrong type
 * @example
 * normalizeUrl('HTTP://Example.COM:80/a/./b/../c?q=%7e%2f'); // => 'http://example.com/a/c?q=~%2F'
 * normalizeUrl('http://www.example.com/docs/?utm_source=x&b=2&a=1#top', {
 * 	forceHttps: true,
 * 	stripWww: true,
 * 	removeTrailingSlash: true,
 * 	removeQueryParams: [/^utm_/],
 * 	sortQuery: true,
 * 	stripHash: true
 * }); // => 'https://example.com/docs?a=1&b=2'
 * normalizeUrl('/relative'); // throws TypeError
 */
export function normalizeUrl(url: string | UrlObject, options: NormalizeUrlOptions = {}): string {
	if (typeof options !== 'object' || options === null) throw new TypeError(`normalizeUrl: \`options\` must be an object, got ${describe(options)}`);

	const [stripHash, stripWww, sortQuery, removeTrailingSlash, forceHttps] = ['stripHash', 'stripWww', 'sortQuery', 'removeTrailingSlash', 'forceHttps'].map(function (
		key: string
	): boolean {
		return flagOption('normalizeUrl', options, key);
	});
	const removed: unknown = readOption(options, 'removeQueryParams', []);

	if (
		!Array.isArray(removed) ||
		!removed.every(function (pattern: unknown): boolean {
			return typeof pattern === 'string' || isRegExp(pattern);
		})
	) {
		throw new TypeError(`normalizeUrl: \`removeQueryParams\` must be an array of strings and regular expressions, got ${describe(removed)}`);
	}

	if (typeof url !== 'string' && !(url instanceof URL)) throw new TypeError(`normalizeUrl: \`url\` must be a string or a URL, got ${describe(url)}`);

	// A URL the runtime cannot read back (see `tryParseUrl`), on which a setter would abort the process, is rejected like an invalid one.
	const parsed = tryParseUrl(url);

	if (parsed === undefined) throw new TypeError(`normalizeUrl: \`url\` must be an absolute URL, got ${JSON.stringify(url)}`);

	// The parser only lowercases the hosts of special schemes (http, https, ws, wss, ftp, file). Escapes are decoded first, so that `%41`
	// becomes `a`, not an `A` that the next normalization would lowercase.
	const host = normalizeEscapes(parsed.hostname).toLowerCase();

	if (host !== parsed.hostname) parsed.hostname = host;

	if (forceHttps && parsed.protocol === 'http:') parsed.protocol = 'https:';

	const rest = parsed.hostname.slice(4);

	// `www.www.example.com` is kept whole: stripping one `www.` would leave another one for the next normalization.
	if (stripWww && parsed.hostname.startsWith('www.') && rest.includes('.') && !rest.startsWith('www.')) parsed.hostname = rest;

	if (removed.length > 0) {
		const params = parsed.searchParams;

		for (const key of new Set(params.keys())) {
			if (
				removed.some(function (pattern: string | RegExp): boolean {
					// `search` ignores (and keeps) the `lastIndex` of a global or sticky expression.
					return typeof pattern === 'string' ? pattern === key : key.search(pattern) !== -1;
				})
			) {
				params.delete(key);
			}
		}
	}

	if (sortQuery) parsed.searchParams.sort();

	if (stripHash || parsed.hash === '') parsed.hash = '';

	if (parsed.search === '') parsed.search = '';

	const path = parsed.pathname;
	let end = path.length;

	while (removeTrailingSlash && end > 1 && path.charCodeAt(end - 1) === 47) end--;

	// An opaque path (`mailto:a/`) does not start with `/`, and cannot be changed.
	if (end < path.length && path.startsWith('/')) parsed.pathname = path.slice(0, end);

	return normalizeEscapes(parsed.href);
}

/**
 * Parses a URL, returning `undefined` instead of throwing when it is invalid: the `URL.parse` of newer runtimes (Node 22, 2024
 * browsers), which it uses when available, for every runtime this library supports.
 * @param {string | UrlObject} input - The URL, absolute or relative to `base`
 * @param {string | UrlObject} [base] - The base URL for a relative `input`
 * Also `undefined` for a URL whose serialization the runtime cannot parse back: Node 26 turns `http://éxn--a/` into
 * `http://xn--xn--a-9ra/`, an invalid host, and aborts the whole process on the first setter called on it.
 * @returns {UrlObject | undefined} A new `URL`, or `undefined` when `input` (or `base`) is not a valid URL
 * @example
 * tryParseUrl('https://example.com/a?b=1')?.searchParams.get('b'); // => '1'
 * tryParseUrl('../c', 'https://example.com/a/b')?.href; // => 'https://example.com/c'
 * tryParseUrl('/relative'); // => undefined
 * tryParseUrl('https://exa mple.com'); // => undefined
 */
export function tryParseUrl(input: string | UrlObject, base?: string | UrlObject): UrlObject | undefined {
	const url = parseUrl(input, base);

	// Only a host the parser wrote in punycode can fail to read back: other URLs are not parsed twice.
	return url === undefined || !url.hostname.includes('xn--') || parseUrl(url.href) !== undefined ? url : undefined;
}

/**
 * Parses a URL with `URL.parse` when the runtime has it, else with the constructor.
 * @param {string | UrlObject} input - The URL, absolute or relative to `base`
 * @param {string | UrlObject} [base] - The base URL for a relative `input`
 * @returns {UrlObject | undefined} A new `URL`, or `undefined` when `input` (or `base`) is not a valid URL
 */
function parseUrl(input: string | UrlObject, base?: string | UrlObject): UrlObject | undefined {
	const Native = URL as { parse?: (input: string | URL, base?: string | URL) => URL | null };

	if (typeof Native.parse === 'function') return Native.parse(input, base) ?? undefined;

	try {
		return new URL(input, base);
	} catch {
		return undefined;
	}
}
