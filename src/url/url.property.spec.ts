import fc from 'fast-check';

import * as helpers from '.';

/** Keys made of URL-safe-ish characters, excluding the `[]` suffix that parseQueryString collapses. */
const key = fc.stringMatching(/^[a-zA-Z0-9_.~ -]{1,8}$/).filter(function (value) {
	return !value.endsWith('[]');
});
/** Arbitrary unicode values (including lone surrogates, `&`, `=`, `+`, `#`, `%`...). */
const value = fc.oneof(fc.string({ unit: 'binary' }), fc.string({ unit: fc.constantFrom('&', '=', '+', '#', '%', '?', ' ', ',', '[', ']', 'a', 'é') }));
/** A well-formed value (no lone surrogate), which round-trips exactly. */
const wellFormedValue = value.filter(function (text) {
	return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
});
const segment = fc.stringMatching(/^[a-z0-9]{1,6}$/);

describe('URL helpers (properties)', function () {
	describe('buildQueryString / parseQueryString', function () {
		it('round-trips string values and repeated arrays (single-item arrays come back as strings)', function () {
			fc.assert(
				fc.property(fc.dictionary(key, fc.oneof(wellFormedValue, fc.array(wellFormedValue, { maxLength: 3 }))), function (params) {
					const expected: Record<string, string | string[]> = {};
					for (const [name, item] of Object.entries(params)) {
						if (!Array.isArray(item)) expected[name] = item;
						else if (item.length === 1) expected[name] = item[0];
						else if (item.length > 1) expected[name] = item;
					}
					expect({ ...helpers.parseQueryString(helpers.buildQueryString(params)) }).toEqual(expected);
					expect({ ...helpers.parseQueryString('?' + helpers.buildQueryString(params)) }).toEqual(expected);
				})
			);
		});

		it('round-trips arrays of any length with the brackets format', function () {
			fc.assert(
				fc.property(fc.dictionary(key, fc.array(wellFormedValue, { minLength: 1, maxLength: 3 })), function (params) {
					expect({ ...helpers.parseQueryString(helpers.buildQueryString(params, { arrayFormat: 'brackets' })) }).toEqual(params);
				})
			);
		});

		it('round-trips stringified numbers, booleans and bigints', function () {
			fc.assert(
				fc.property(fc.dictionary(key, fc.oneof(fc.double(), fc.boolean(), fc.bigInt())), function (params) {
					const expected: Record<string, string> = {};
					for (const [name, item] of Object.entries(params)) expected[name] = String(item);
					expect({ ...helpers.parseQueryString(helpers.buildQueryString(params)) }).toEqual(expected);
				})
			);
		});

		it('never leaves a raw &, =, #, + or , inside encoded keys and values', function () {
			fc.assert(
				fc.property(
					fc.dictionary(fc.oneof(key, value), fc.oneof(value, fc.array(value, { maxLength: 3 }))),
					fc.constantFrom<helpers.ArrayFormat>('repeat', 'comma', 'brackets'),
					function (params, arrayFormat) {
						const query = helpers.buildQueryString(params, { arrayFormat });
						if (query === '') return;
						for (const pair of query.split('&')) {
							const [name, ...rest] = pair.split('=');
							expect(rest.length).toBeLessThanOrEqual(1);
							expect(name).not.toMatch(/[#+,]/);
							const encoded = rest.join('');
							if (arrayFormat === 'comma') {
								encoded.split(',').forEach(function (item) {
									expect(item).not.toMatch(/[&=#+,]/);
								});
							} else expect(encoded).not.toMatch(/[&=#+,]/);
						}
					}
				)
			);
		});

		it('sort orders the keys without changing the parsed result', function () {
			fc.assert(
				fc.property(fc.dictionary(key, wellFormedValue), function (params) {
					const sorted = helpers.buildQueryString(params, { sort: true });
					const keys =
						sorted === ''
							? []
							: sorted.split('&').map(function (pair) {
									return decodeURIComponent(pair.split('=')[0]);
								});
					expect(keys).toEqual([...keys].sort());
					expect({ ...helpers.parseQueryString(sorted) }).toEqual({ ...helpers.parseQueryString(helpers.buildQueryString(params)) });
				})
			);
		});
	});

	describe('parseQueryString', function () {
		it('never throws and never touches Object.prototype', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('a', '=', '&', '%', '2', 'F', '+', '[', ']', '_', 'p', 'r', 'o', 't', '?', '#') }), function (query) {
					const result = helpers.parseQueryString('__proto__[]=x&' + query);
					expect(Object.getPrototypeOf(result)).toBeNull();
					expect(Object.prototype).not.toHaveProperty('x');
					for (const item of Object.values(result)) {
						if (Array.isArray(item)) expect(item.length).toBeGreaterThanOrEqual(1);
						else expect(typeof item).toBe('string');
					}
				})
			);
		});
	});

	describe('withQuery', function () {
		const path = fc.array(segment, { maxLength: 3 }).map(function (parts) {
			return '/' + parts.join('/');
		});
		const hash = fc.oneof(
			fc.constant(''),
			segment.map(function (text) {
				return '#' + text;
			})
		);

		it('preserves the path and the hash, and the new values win', function () {
			fc.assert(
				fc.property(path, fc.dictionary(key, wellFormedValue), hash, fc.dictionary(key, wellFormedValue), function (base, existing, fragment, params) {
					const existingQuery = helpers.buildQueryString(existing);
					const url = base + (existingQuery === '' ? '' : '?' + existingQuery) + fragment;
					const result = helpers.withQuery(url, params);
					expect(result.startsWith(base)).toBe(true);
					expect(result.endsWith(fragment)).toBe(true);
					expect({ ...helpers.parseQueryString(result.slice(base.length)) }).toEqual({ ...existing, ...params });
					for (const name of Object.keys(params)) expect(helpers.getQueryParam(result, name)).toBe(params[name]);
				})
			);
		});

		it('is a no-op on the parsed query when no parameter is given', function () {
			fc.assert(
				fc.property(path, fc.dictionary(key, wellFormedValue), hash, function (base, existing, fragment) {
					const query = helpers.buildQueryString(existing);
					const url = base + (query === '' ? '' : '?' + query) + fragment;
					expect(helpers.withQuery(url, {})).toBe(url);
				})
			);
		});
	});

	describe('joinUrl', function () {
		const part = fc.string({ unit: fc.constantFrom('a', 'b', '/', '/', '.'), maxLength: 6 });

		it('never produces // outside the scheme and keeps every segment in order', function () {
			fc.assert(
				fc.property(fc.constantFrom('', '/', '//', 'https://', 'http://host', '//host'), fc.array(part, { maxLength: 5 }), function (start, parts) {
					const joined = helpers.joinUrl(start, ...parts);
					const all = [start, ...parts];
					// The only legitimate '//' is the scheme's or a protocol-relative '//host' at the very start of the FIRST argument.
					const prefix = start.includes('://') ? start.slice(0, start.indexOf('://') + 3) : /^\/\/[^/]/.test(start) ? '//' : '';
					expect(joined.startsWith(prefix)).toBe(true);
					expect(joined.slice(prefix.length)).not.toContain('//');
					const segments = all
						.join('/')
						.slice(all.join('/').indexOf(prefix) + prefix.length)
						.split('/')
						.filter(Boolean);
					expect(joined.slice(prefix.length).split('/').filter(Boolean)).toEqual(segments);
				})
			);
		});

		it('ends with / iff the last non-empty part does (and something was joined)', function () {
			fc.assert(
				fc.property(fc.array(part, { minLength: 1, maxLength: 5 }), function (parts) {
					const nonEmpty = parts.filter(Boolean);
					const joined = helpers.joinUrl(...parts);
					if (/[a.]/.test(joined)) expect(joined.endsWith('/')).toBe(nonEmpty[nonEmpty.length - 1].endsWith('/'));
					if (nonEmpty.length > 0) expect(joined.startsWith('/')).toBe(nonEmpty[0].startsWith('/'));
				})
			);
		});

		it('is associative for simple segments, including a trailing query', function () {
			const query = fc.oneof(
				fc.constant(''),
				segment.map(function (text) {
					return '?q=' + text;
				})
			);
			fc.assert(
				fc.property(segment, segment, segment, query, fc.boolean(), function (a, b, c, search, leading) {
					const first = leading ? '/' + a : a;
					const lastPart = c + search;
					const flat = helpers.joinUrl(first, b, lastPart);
					expect(helpers.joinUrl(first, helpers.joinUrl(b, lastPart))).toBe(flat);
					expect(helpers.joinUrl(helpers.joinUrl(first, b), lastPart)).toBe(flat);
					expect(flat).toBe(`${leading ? '/' : ''}${a}/${b}/${c}${search}`);
				})
			);
		});

		it('is idempotent on its own output', function () {
			fc.assert(
				fc.property(fc.array(part, { maxLength: 5 }), function (parts) {
					const joined = helpers.joinUrl(...parts);
					expect(helpers.joinUrl(joined)).toBe(joined);
				})
			);
		});
	});

	describe('security (cross-checked against the WHATWG URL parser)', function () {
		const token = fc.constantFrom(
			'/',
			'/',
			'\\',
			'\\',
			' ',
			'\t',
			'\n',
			'\r',
			'\u0000',
			'\u001f',
			':',
			'a',
			'.',
			'@',
			'%2F',
			'javascript',
			'data',
			'https',
			'http',
			'ftp',
			'file',
			'wss',
			'x',
			'evil.com'
		);
		const url = fc.array(token, { maxLength: 8 }).map(function (tokens) {
			return tokens.join('');
		});
		const special = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);
		const bases = ['https://example.com/app/', 'http://example.com/app/'];

		/**
		 * Resolves `input` like a browser, or returns `undefined` when browsers reject it.
		 * @param {string} input - The URL
		 * @param {string} base - The base URL
		 * @returns {URL | undefined} The resolved URL
		 */
		function resolve(input: string, base: string): URL | undefined {
			try {
				return new URL(input, base);
			} catch {
				return undefined;
			}
		}

		it('isAbsoluteUrl is true whenever a browser would leave the origin for an http(s)/ws/ftp/file URL', function () {
			fc.assert(
				fc.property(url, function (input) {
					for (const base of bases) {
						const resolved = resolve(input, base);
						if (resolved !== undefined && special.has(resolved.protocol) && resolved.origin !== new URL(base).origin) {
							expect(helpers.isAbsoluteUrl(input)).toBe(true);
						}
					}
				}),
				{ numRuns: 2000 }
			);
		});

		it('isAbsoluteUrl is false for javascript:/data: URLs and for every input a browser keeps on the same origin path-wise', function () {
			fc.assert(
				fc.property(url, function (input) {
					const resolved = resolve(input, bases[0]);
					if (resolved !== undefined && (resolved.protocol === 'javascript:' || resolved.protocol === 'data:')) expect(helpers.isAbsoluteUrl(input)).toBe(false);
					// Without any ':' the only way out is a protocol-relative form, which browsers resolve to another host.
					if (!input.includes(':') && resolved !== undefined && resolved.host === 'example.com') expect(helpers.isAbsoluteUrl(input)).toBe(false);
				}),
				{ numRuns: 2000 }
			);
		});

		it('joinUrl results stay on the origin unless the first argument is itself absolute', function () {
			fc.assert(
				fc.property(fc.constantFrom('', '/', '/app', 'app', '/app/'), fc.array(url, { maxLength: 4 }), function (first, rest) {
					const joined = helpers.joinUrl(first, ...rest);
					expect(helpers.isAbsoluteUrl(joined)).toBe(false);
					for (const base of bases) {
						const resolved = resolve(joined, base);
						if (resolved !== undefined) expect(resolved.origin).toBe(new URL(base).origin);
					}
				}),
				{ numRuns: 2000 }
			);
		});

		it('joinUrl keeps the host of an absolute first argument', function () {
			fc.assert(
				fc.property(fc.constantFrom('https://example.com', '//example.com', 'https://example.com/v1/'), fc.array(url, { maxLength: 4 }), function (first, rest) {
					const resolved = resolve(helpers.joinUrl(first, ...rest), bases[0]);
					if (resolved !== undefined) expect(resolved.host).toBe('example.com');
				}),
				{ numRuns: 1000 }
			);
		});
	});

	describe('isAbsoluteUrl', function () {
		it('recognizes joinUrl results built on an absolute base and rejects relative paths', function () {
			fc.assert(
				fc.property(fc.constantFrom('https://host', 'ftp://h', '//cdn'), fc.array(segment, { maxLength: 3 }), function (base, parts) {
					expect(helpers.isAbsoluteUrl(helpers.joinUrl(base, ...parts))).toBe(true);
					expect(helpers.isAbsoluteUrl(helpers.joinUrl('/', ...parts))).toBe(false);
				})
			);
		});
	});
});

/** Characters that matter to URL parsing: scheme characters, slashes, separators, ignored and control characters. */
const urlish = fc.string({
	unit: fc.constantFrom(
		'a',
		'j',
		'S',
		'h',
		't',
		'p',
		's',
		'1',
		'+',
		'.',
		'-',
		':',
		'/',
		'\\',
		'?',
		'#',
		'%',
		'&',
		';',
		' ',
		'\t',
		'\n',
		'\r',
		'\x00',
		'\x01',
		'\x1f',
		'é',
		'@'
	),
	maxLength: 16
});
const scheme = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9+.-]{0,5}$/);
/** URL-like strings that start with a scheme (possibly disguised with ignored characters). */
const schemeUrl = fc.tuple(fc.constantFrom('', ' ', '\x01', '\t', ' \x00'), scheme, fc.constantFrom('', '\t', '\n'), urlish).map(function ([prefix, name, noise, rest]) {
	return `${prefix}${name.slice(0, 1)}${noise}${name.slice(1)}:${rest}`;
});
const anyUrl = fc.oneof(urlish, schemeUrl);
const pathSegment = fc.stringMatching(/^[a-z0-9.%-]{0,4}$/);
const path = fc.array(fc.oneof(pathSegment, fc.constant('')), { maxLength: 5 }).map(function (segments) {
	return segments.join('/');
});
const suffix = fc.tuple(fc.option(fc.stringMatching(/^[a-z/=&?]{0,6}$/)), fc.option(fc.stringMatching(/^[a-z/?#]{0,6}$/))).map(function ([query, hash]) {
	return (query === null ? '' : `?${query}`) + (hash === null ? '' : `#${hash}`);
});
const prefix = fc.constantFrom('', '/', '//host', 'https://example.com', 'file://', 'mailto:');

/** Splits a URL string into its path and the rest (query and fragment). */
function splitPath(url: string): [string, string] {
	const index = url.search(/[?#]/);
	return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
}

describe('URL helpers (round 11 properties)', function () {
	describe('isSafeUrl', function () {
		it('reads the same scheme as the WHATWG URL parser', function () {
			fc.assert(
				fc.property(anyUrl, function (url) {
					const parsed = URL.parse(url);
					if (parsed === null) return;
					expect(helpers.isSafeUrl(url, { protocols: [parsed.protocol], allowRelative: false })).toBe(true);
					expect(helpers.isSafeUrl(url, { protocols: ['zz-not-it:'], allowRelative: true })).toBe(false);
				})
			);
		});

		it('only accepts URLs that browsers resolve to an allowed scheme (or that do not parse at all)', function () {
			fc.assert(
				fc.property(anyUrl, fc.boolean(), function (url, allowRelative) {
					const resolved = URL.parse(url, 'https://base.example/dir/');
					const safe = helpers.isSafeUrl(url, { protocols: ['http:', 'mailto:'], allowRelative });
					if (resolved === null) return;
					const absolute = URL.canParse(url);
					if (safe) expect(absolute ? ['http:', 'mailto:'] : ['https:']).toContain(resolved.protocol);
					else if (absolute) expect(['http:', 'mailto:']).not.toContain(resolved.protocol);
					else expect(allowRelative).toBe(false);
				})
			);
		});

		it('never accepts a javascript: URL, however it is disguised', function () {
			fc.assert(
				fc.property(
					fc.constantFrom('', ' ', '\x01', '\t\n'),
					fc.array(fc.constantFrom('', '\t', '\n', '\r'), { minLength: 10, maxLength: 10 }),
					fc.boolean(),
					urlish,
					function (lead, noise, upper, rest) {
						const name = 'javascript'.split('').map(function (letter, index) {
							return (upper && index % 2 === 0 ? letter.toUpperCase() : letter) + noise[index];
						});
						const url = `${lead}${name.join('')}:${rest}`;
						// Some disguises do not even parse (`javascript://\\`); those must be rejected too.
						const parsed = URL.parse(url);
						if (parsed !== null) expect(parsed.protocol).toBe('javascript:');
						expect(helpers.isSafeUrl(url)).toBe(false);
						expect(helpers.sanitizeUrl(url)).toBe('about:blank');
					}
				)
			);
		});
	});

	describe('slash helpers', function () {
		const url = fc.tuple(prefix, path, suffix).map(function ([start, middle, end]) {
			return start + middle + end;
		});

		it('only change the path, and are idempotent', function () {
			fc.assert(
				fc.property(fc.oneof(url, urlish), function (input) {
					const [, rest] = splitPath(input);
					for (const fn of [helpers.withTrailingSlash, helpers.withoutTrailingSlash, helpers.cleanDoubleSlashes]) {
						const result = fn(input);
						expect(splitPath(result)[1]).toBe(rest);
						expect(fn(result)).toBe(result);
					}
					expect(helpers.withLeadingSlash(helpers.withLeadingSlash(input))).toBe(helpers.withLeadingSlash(input));
					expect(helpers.withoutLeadingSlash(helpers.withoutLeadingSlash(input))).toBe(helpers.withoutLeadingSlash(input));
				})
			);
		});

		it('add or remove only slashes', function () {
			fc.assert(
				fc.property(url, function (input) {
					const bare = input.replace(/\//g, '');
					expect(helpers.withTrailingSlash(input).replace(/\//g, '')).toBe(bare);
					expect(helpers.withoutTrailingSlash(input).replace(/\//g, '')).toBe(bare);
					expect(helpers.cleanDoubleSlashes(input).replace(/\//g, '')).toBe(bare);
					expect(helpers.withLeadingSlash(input).replace(/\//g, '')).toBe(bare);
				})
			);
		});

		it('produce the documented shapes', function () {
			fc.assert(
				fc.property(url, function (input) {
					expect(splitPath(helpers.withTrailingSlash(input))[0].endsWith('/')).toBe(true);
					expect(helpers.withLeadingSlash(input)).toMatch(/^\/(?![/\\])/);
					expect(helpers.withoutLeadingSlash(input)).not.toMatch(/^\//);
					const keep = /^(?:[a-z][a-z\d+.-]*:)?\/*/i.exec(input)![0];
					const cleaned = splitPath(helpers.cleanDoubleSlashes(input))[0];
					expect(cleaned.startsWith(keep)).toBe(true);
					expect(cleaned.slice(keep.length)).not.toContain('//');
					const trimmed = splitPath(helpers.withoutTrailingSlash(input))[0];
					expect(trimmed === '' || !trimmed.endsWith('/') || trimmed === keep).toBe(true);
				})
			);
		});

		it('agree with the WHATWG URL parser on the resolved path, except for the collapsed slashes', function () {
			fc.assert(
				fc.property(path, suffix, function (middle, end) {
					// Dot segments are resolved against the empty segments a double slash creates (`/a//..` is `/a/`), so collapsing first
					// legitimately changes their target: cleanDoubleSlashes is a syntactic edit (documented), checked here without them.
					fc.pre(!/(?:^|[/\\])\.{1,2}(?:[/\\?#]|$)/.test(`${middle}${end}`));
					const input = `https://example.com/${middle}${end}`;
					const original = new URL(input);
					const cleaned = new URL(helpers.cleanDoubleSlashes(input));
					expect(cleaned.search).toBe(original.search);
					expect(cleaned.hash).toBe(original.hash);
					expect(cleaned.host).toBe(original.host);
					expect(cleaned.pathname).toBe(original.pathname.replace(/\/\/+/g, '/'));
				})
			);
		});
	});

	describe('withBase / withoutBase', function () {
		const base = fc.array(fc.stringMatching(/^[a-z]{1,3}$/), { minLength: 1, maxLength: 3 }).map(function (segments) {
			return '/' + segments.join('/');
		});
		const relative = fc.tuple(fc.constantFrom('/', ''), path, suffix).map(function ([start, middle, end]) {
			return start + middle + end;
		});

		it('round-trip a path that starts with / and is not already under the base', function () {
			fc.assert(
				fc.property(base, fc.constantFrom('', '/', '//'), path, suffix, function (root, trailing, middle, end) {
					const input = `/${middle.replace(/^\/+/, '')}${end}`;
					const [pathname] = splitPath(input);
					fc.pre(pathname !== root && !pathname.startsWith(root + '/'));
					const mounted = helpers.withBase(input, root + trailing);
					expect(mounted.startsWith(root + '/') || mounted === root).toBe(true);
					expect(helpers.withoutBase(mounted, root + trailing)).toBe(input);
					expect(helpers.withBase(mounted, root)).toBe(mounted);
				})
			);
		});

		it('never produce a protocol-relative URL from a relative input', function () {
			fc.assert(
				fc.property(base, fc.oneof(relative, urlish), function (root, input) {
					const mounted = helpers.withBase(input, root);
					const unmounted = helpers.withoutBase(input, root);
					if (mounted !== input) expect(mounted).not.toMatch(/^[/\\]{2}/);
					if (unmounted !== input) expect(unmounted).toMatch(/^\/(?![/\\\t\n\r])/);
				})
			);
		});

		it('is segment-aware', function () {
			fc.assert(
				fc.property(base, fc.stringMatching(/^[a-z]{1,3}$/), function (root, extra) {
					expect(helpers.withoutBase(root + extra, root)).toBe(root + extra);
					expect(helpers.withBase(root + extra, root)).toBe(`${root}/${root.slice(1)}${extra}`);
				})
			);
		});
	});

	describe('safeDecodeURIComponent', function () {
		it('equals decodeURIComponent whenever that does not throw, and never throws', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('%', '2', '5', 'E', '9', 'C', '3', 'A', 'F', '8', '0', 'B', 'x', '+') }), function (text) {
					let expected: string | undefined;
					try {
						expected = decodeURIComponent(text);
					} catch {
						expected = undefined;
					}
					const decoded = helpers.safeDecodeURIComponent(text);
					if (expected !== undefined) expect(decoded).toBe(expected);
				})
			);
		});

		it('inverts encodeURIComponent, also when surrounded by malformed escapes', function () {
			fc.assert(
				fc.property(wellFormedValue, fc.constantFrom('', '%', '%E0%A4', '%ZZ', '%C3'), function (text, junk) {
					expect(helpers.safeDecodeURIComponent(encodeURIComponent(text))).toBe(text);
					// Junk at the end of a run cannot swallow the valid escapes before it.
					expect(helpers.safeDecodeURIComponent(encodeURIComponent(text) + junk)).toBe(text + junk);
				})
			);
		});

		it('matches a reference that decodes the longest valid UTF-8 escape sequence at each position', function () {
			function reference(text: string): string {
				let out = '';
				for (let index = 0; index < text.length;) {
					let taken = false;
					for (let bytes = 1; bytes <= 4 && !taken; bytes++) {
						const candidate = text.slice(index, index + 3 * bytes);
						if (!new RegExp(`^(?:%[0-9a-fA-F]{2}){${bytes}}$`).test(candidate)) break;
						try {
							out += decodeURIComponent(candidate);
							index += candidate.length;
							taken = true;
						} catch {
							// Try a longer sequence.
						}
					}
					if (!taken) out += text[index++];
				}
				return out;
			}

			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('%', '%C3', '%A9', '%E0', '%A4', '%F0', '%9F', '%91', '%8D', '%80', '%FF', '%2', '%25', 'x', '9') }),
					function (text) {
						expect(helpers.safeDecodeURIComponent(text)).toBe(reference(text));
					}
				)
			);
		});
	});

	describe('withFragment / withoutFragment / withoutQuery', function () {
		const base = fc.tuple(prefix, path, suffix).map(function ([start, middle, end]) {
			return start + middle + end;
		});

		it('round-trips the fragment text', function () {
			fc.assert(
				fc.property(base, value, function (url, fragment) {
					const result = helpers.withFragment(url, fragment);
					const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
					expect(result.startsWith(helpers.withoutFragment(url))).toBe(true);
					if (text === '') {
						expect(result).toBe(helpers.withoutFragment(url));
					} else {
						const hash = result.slice(helpers.withoutFragment(url).length);
						expect(hash.indexOf('#', 1)).toBe(-1);
						expect(helpers.safeDecodeURIComponent(hash.slice(1))).toBe(text.replace(/\p{Cs}/gu, '�'));
						const parsed = URL.parse(result, 'https://x.example/');
						if (parsed !== null) expect(parsed.hash).toBe(hash);
					}
				})
			);
		});

		it('removes the fragment and the query independently', function () {
			fc.assert(
				fc.property(base, function (url) {
					const parsed = URL.parse(url, 'https://x.example/');
					fc.pre(parsed !== null && !url.startsWith('mailto:') && !url.startsWith('file:') && !url.startsWith('//'));
					expect(new URL(helpers.withoutFragment(url), 'https://x.example/').hash).toBe('');
					expect(new URL(helpers.withoutFragment(url), 'https://x.example/').search).toBe(parsed!.search);
					expect(new URL(helpers.withoutQuery(url), 'https://x.example/').search).toBe('');
					expect(new URL(helpers.withoutQuery(url), 'https://x.example/').hash).toBe(parsed!.hash);
					expect(helpers.withoutQuery(helpers.withoutFragment(url))).toBe(helpers.withoutFragment(helpers.withoutQuery(url)));
				})
			);
		});
	});
});

/** A segment of a generated route pattern. */
interface Piece {
	/** The parameter name, or `undefined` for static text. */
	name: string | undefined;
	prefix: string;
	suffix: string;
	optional: boolean;
}

/** A generated route pattern: its segments and an optional final splat. */
interface Route {
	pieces: Piece[];
	splat: { name: string; optional: boolean } | undefined;
	trailing: boolean;
}

/** Static text: no dot segment, no character with a meaning in patterns. */
const staticText = fc.stringMatching(/^[a-zA-Z0-9é~.-]{1,3}$/).filter(function (text) {
	return text !== '.' && text !== '..';
});
/** Text after a parameter: it cannot start with a character of a name. */
const suffixText = fc.oneof(fc.constant(''), fc.stringMatching(/^[.~-][a-z.~-]{0,2}$/));

/**
 * Generates route patterns (parameters are named `p0`, `p1`... so names are unique).
 * @param {boolean} allowTrailing - Whether the pattern may end with `/`
 */
function route(allowTrailing: boolean): fc.Arbitrary<Route> {
	const piece = fc.record({
		param: fc.boolean(),
		prefix: fc.oneof(fc.constant(''), staticText),
		suffix: suffixText,
		optional: fc.boolean()
	});
	return fc
		.record({
			pieces: fc.array(piece, { maxLength: 5 }),
			splat: fc.option(fc.record({ named: fc.boolean(), optional: fc.boolean() }), { nil: undefined }),
			trailing: fc.boolean()
		})
		.map(function ({ pieces, splat, trailing }): Route {
			return {
				pieces: pieces.map(function (item, index): Piece {
					return item.param
						? { name: `p${index}`, prefix: item.prefix, suffix: item.suffix, optional: item.optional }
						: { name: undefined, prefix: item.prefix === '' ? 's' : item.prefix, suffix: '', optional: item.optional };
				}),
				splat: splat === undefined ? undefined : { name: splat.named ? 'rest' : '*', optional: splat.optional },
				trailing: allowTrailing && splat === undefined && trailing && pieces.length > 0
			};
		});
}

/**
 * Writes a generated route as a pattern.
 * @param {Route} spec - The route
 */
function patternOf(spec: Route): string {
	let pattern = '';
	for (const piece of spec.pieces) pattern += '/' + piece.prefix + (piece.name === undefined ? '' : ':' + piece.name + piece.suffix) + (piece.optional ? '?' : '');
	if (spec.splat !== undefined) pattern += '/*' + (spec.splat.name === '*' ? '' : spec.splat.name) + (spec.splat.optional ? '?' : '');
	return (pattern || '/') + (spec.trailing ? '/' : '');
}

/**
 * A reference matcher (case-sensitive, strict, decoded-identity segments): tries every way to skip optional segments, preferring to
 * take the earliest ones, which is what "filled from the left" means.
 * @param {Route} spec - The route
 * @param {string[]} segments - The pathname segments
 */
function naiveMatch(spec: Route, segments: string[]): Record<string, string> | null {
	const optional = spec.pieces.filter(function (piece) {
		return piece.optional;
	});
	for (let mask = 2 ** optional.length - 1; mask >= 0; mask--) {
		const chosen = spec.pieces.filter(function (piece) {
			return !piece.optional || (mask & (2 ** (optional.length - 1 - optional.indexOf(piece)))) !== 0;
		});
		if (chosen.length > segments.length || (spec.splat === undefined && chosen.length !== segments.length)) continue;
		const params: Record<string, string> = {};
		const fits = chosen.every(function (piece, index) {
			const text = segments[index];
			if (piece.name === undefined) return text === piece.prefix;
			if (text.length <= piece.prefix.length + piece.suffix.length || !text.startsWith(piece.prefix) || !text.endsWith(piece.suffix)) return false;
			params[piece.name] = text.slice(piece.prefix.length, text.length - piece.suffix.length);
			return true;
		});
		if (!fits) continue;
		const rest = segments.slice(chosen.length).join('/');
		if (spec.splat !== undefined) {
			// A splat never starts with an empty segment (a leading separator).
			if (chosen.length < segments.length && segments[chosen.length] === '') continue;
			if (chosen.length === segments.length && !spec.splat.optional) continue;
			if (rest !== '') params[spec.splat.name] = rest;
		}
		return params;
	}
	return null;
}

/** A parameter value that round-trips: well-formed, non-empty, without a `.` or `..` part between `/` or `\` separators. */
const paramValue = fc.oneof(fc.string({ unit: 'binary', minLength: 1, maxLength: 6 }), fc.stringMatching(/^[./\\a]{1,5}$/)).filter(function (text) {
	return !/(?:^|[/\\])\.\.?(?=$|[/\\])/.test(text) && !/\p{Cs}/u.test(text);
});
/** A splat value: segments that are not dot segments (possibly empty), not empty overall. */
const splatValue = fc
	.array(
		paramValue.filter(function (text) {
			return !text.includes('/') && !text.startsWith('\\');
		}),
		{ minLength: 1, maxLength: 4 }
	)
	.chain(function (parts) {
		return fc.constantFrom(parts.join('/'), parts.join('//'));
	});

describe('route patterns (properties)', function () {
	it('matches what compilePath builds back to the same parameters when every segment is present', function () {
		fc.assert(
			fc.property(route(true), fc.array(paramValue, { minLength: 6, maxLength: 6 }), splatValue, function (spec, values, rest) {
				const pattern = patternOf(spec);
				const params: Record<string, string> = {};
				spec.pieces.forEach(function (piece, index) {
					if (piece.name !== undefined) params[piece.name] = values[index];
				});
				// Static text around a value can make a dot part (`\\` then `.`): the builder rightly refuses those.
				fc.pre(
					spec.pieces.every(function (piece, index) {
						return piece.name === undefined || !/(?:^|[/\\])\.\.?(?=$|[/\\])/.test(piece.prefix + values[index] + piece.suffix);
					})
				);
				if (spec.splat !== undefined) params[spec.splat.name] = rest;
				const built = (helpers.compilePath(pattern) as (params: object) => string)(params);
				expect({ ...helpers.matchPath(pattern, built, { strict: true }) }).toEqual(params);
				expect({ ...helpers.matchPath(pattern, built) }).toEqual(params);
				expect({ ...helpers.matchPath(pattern, built, { caseSensitive: true }) }).toEqual(params);
			})
		);
	});

	it('builds pathnames that match back to the same parameters, or throws a RangeError', function () {
		fc.assert(
			fc.property(route(true), fc.array(fc.option(paramValue, { nil: undefined }), { minLength: 7, maxLength: 7 }), function (spec, values) {
				const pattern = patternOf(spec);
				const params: Record<string, string | undefined> = {};
				spec.pieces.forEach(function (piece, index) {
					if (piece.name !== undefined) params[piece.name] = piece.optional ? values[index] : (values[index] ?? 'v');
				});
				if (spec.splat !== undefined) params[spec.splat.name] = spec.splat.optional ? values[6] : (values[6] ?? 'v');
				let built: string;
				try {
					built = (helpers.compilePath(pattern) as (params: object) => string)(params);
				} catch (error) {
					// Only an ambiguous combination of optional segments, a dot segment or a splat starting with a separator may be refused.
					expect(error).toBeInstanceOf(RangeError);
					expect((error as Error).message).toMatch(/must match back to themselves|must not make a dot segment|must not start with a separator/);
					return;
				}
				const given = Object.fromEntries(
					Object.entries(params).filter(function (entry) {
						return entry[1] !== undefined;
					})
				);
				expect({ ...helpers.matchPath(pattern, built, { strict: true }) }).toEqual(given);
			})
		);
	});

	it('agrees with a reference matcher that tries every combination of optional segments', function () {
		fc.assert(
			fc.property(
				route(false),
				fc.array(fc.oneof(staticText, fc.constantFrom('s', 'a', 'b', '', 'a.x', 'b-', 's~', '~'), fc.stringMatching(/^[a-z~.-]{1,4}$/)), { maxLength: 7 }),
				function (spec, raw) {
					const pattern = patternOf(spec);
					const built = '/' + raw.join('/');
					const segments = built === '/' ? [] : built.slice(1).split('/');
					fc.pre(
						!segments.some(function (part) {
							return part === '.' || part === '..';
						})
					);
					const matched = helpers.matchPath(pattern, built, { strict: true, caseSensitive: true });
					const expected = naiveMatch(spec, segments);
					expect(matched === null ? null : { ...matched }).toEqual(expected);
				}
			)
		);
	});

	it('never throws on any pathname, and only captures non-empty decoded text', function () {
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), fc.constantFrom('/:a', '/:a/*b?', '/x-:a?/*', '/:a?/:b?'), fc.boolean(), function (pathname, pattern, strict) {
				const matched = helpers.matchPath(pattern, pathname, { strict });
				if (matched === null) return;
				for (const captured of Object.values(matched)) expect(captured).not.toBe('');
				expect(pathname.startsWith('/')).toBe(true);
				if (pattern === '/:a')
					expect(matched.a).toBe(
						helpers.safeDecodeURIComponent(
							pathname
								.slice(1)
								.replace(/[?#].*$/s, '')
								.replace(/\/$/, '')
						)
					);
			})
		);
	});
});
