import * as vm from 'vm';
import * as helpers from '.';

describe('URL helpers', function () {
	describe('buildQueryString', function () {
		it('accepts parameters declared with an interface', function () {
			interface Filters {
				q: string;
				page?: number;
				tags: readonly string[];
			}
			const filters: Filters = { q: 'a b', tags: ['x', 'y'] };
			expect(helpers.buildQueryString(filters)).toBe('q=a%20b&tags=x&tags=y');
			expect(helpers.withQuery('/s', filters)).toBe('/s?q=a%20b&tags=x&tags=y');
			expect(function () {
				// @ts-expect-error a nested object is not a query value
				helpers.buildQueryString({ nested: { a: 1 } });
			}).toThrow(TypeError);
		});

		it('should encode keys and values without a leading ?', function () {
			expect(helpers.buildQueryString({ q: 'hello world', page: 2 })).toBe('q=hello%20world&page=2');
			expect(helpers.buildQueryString({ 'a&b': 'c=d', e: '#?/+' })).toBe('a%26b=c%3Dd&e=%23%3F%2F%2B');
			expect(helpers.buildQueryString({ city: 'São Paulo', emoji: '😀' })).toBe('city=S%C3%A3o%20Paulo&emoji=%F0%9F%98%80');
			expect(helpers.buildQueryString({})).toBe('');
			expect(helpers.buildQueryString({ empty: '' })).toBe('empty=');
		});

		it('should serialize numbers, booleans, bigints and dates', function () {
			expect(helpers.buildQueryString({ n: 1.5, z: -0, t: true, f: false, big: 10n, nan: NaN })).toBe('n=1.5&z=0&t=true&f=false&big=10&nan=NaN');
			expect(helpers.buildQueryString({ d: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) })).toBe('d=2024-01-02T03%3A04%3A05.000Z');
		});

		it('should skip undefined, and null unless skipNull is false', function () {
			expect(helpers.buildQueryString({ a: undefined, b: null, c: 1 })).toBe('c=1');
			expect(helpers.buildQueryString({ a: undefined, b: null, c: 1 }, { skipNull: false })).toBe('b&c=1');
		});

		it('should support the three array formats', function () {
			const params = { tags: ['a', 'b c', 'd,e'], one: 1 };
			expect(helpers.buildQueryString(params)).toBe('tags=a&tags=b%20c&tags=d%2Ce&one=1');
			expect(helpers.buildQueryString(params, { arrayFormat: 'repeat' })).toBe('tags=a&tags=b%20c&tags=d%2Ce&one=1');
			expect(helpers.buildQueryString(params, { arrayFormat: 'brackets' })).toBe('tags[]=a&tags[]=b%20c&tags[]=d%2Ce&one=1');
			expect(helpers.buildQueryString(params, { arrayFormat: 'comma' })).toBe('tags=a,b%20c,d%2Ce&one=1');
		});

		it('should keep empty keys and empty values as pairs of their own', function () {
			expect(helpers.buildQueryString({ '': null, b: 1 }, { skipNull: false })).toBe('&b=1');
			expect(helpers.buildQueryString({ undefined: 1 })).toBe('undefined=1');
			expect(helpers.buildQueryString({ a: '', b: [''] })).toBe('a=&b=');
			expect(helpers.buildQueryString({ a: ['', 'x', ''] }, { arrayFormat: 'comma' })).toBe('a=,x,');
			expect(helpers.buildQueryString({ a: [null as any, ''], b: 1 }, { arrayFormat: 'brackets' })).toBe('a[]=&b=1');
		});

		it('should skip empty arrays and nullish array items', function () {
			const items = [null, 1, undefined, 2] as any;
			expect(helpers.buildQueryString({ a: [], b: items })).toBe('b=1&b=2');
			expect(helpers.buildQueryString({ a: [], b: items }, { arrayFormat: 'comma' })).toBe('b=1,2');
			expect(helpers.buildQueryString({ a: [null] as any }, { skipNull: false })).toBe('');
		});

		it('should sort keys when asked, keeping the value order', function () {
			expect(helpers.buildQueryString({ b: 1, a: [3, 2], c: 0 }, { sort: true })).toBe('a=3&a=2&b=1&c=0');
		});

		it('should only read own enumerable keys', function () {
			const params = Object.create({ inherited: 'x' });
			params.own = 'y';
			expect(helpers.buildQueryString(params)).toBe('own=y');
		});

		it('should replace lone surrogates with U+FFFD instead of throwing', function () {
			expect(helpers.buildQueryString({ a: '\uD800', b: 'x\uDC00y', '\uD83D': '😀' })).toBe('a=%EF%BF%BD&b=x%EF%BF%BDy&%EF%BF%BD=%F0%9F%98%80');
			// Valid pairs next to a lone surrogate are kept.
			expect(helpers.buildQueryString({ c: '😀\uDC00😀' })).toBe('c=%F0%9F%98%80%EF%BF%BD%F0%9F%98%80');
		});

		it('should throw for invalid dates, unsupported values and unknown array formats', function () {
			expect(function () {
				helpers.buildQueryString({ d: new Date(NaN) });
			}).toThrow(RangeError);
			expect(function () {
				helpers.buildQueryString({ o: { nested: true } as any });
			}).toThrow(TypeError);
			expect(function () {
				helpers.buildQueryString({ s: [Symbol('x')] as any });
			}).toThrow(TypeError);
			expect(function () {
				helpers.buildQueryString({ a: 1 }, { arrayFormat: 'json' as any });
			}).toThrow(RangeError);
		});
	});

	describe('parseFormData', function () {
		it('should collect repeated keys and bracket keys into arrays, keeping files', function () {
			const data = new FormData();
			const avatar = new Blob(['x']);

			data.append('name', 'Ada');
			data.append('topic', 'ts');
			data.append('topic', 'js');
			data.append('topic', 'go');
			data.append('ids[]', '1');
			data.append('avatar', avatar);

			const fields = helpers.parseFormData(data);

			expect(fields).toEqual({ name: 'Ada', topic: ['ts', 'js', 'go'], ids: ['1'], avatar: expect.any(Blob) });
			expect(Object.getPrototypeOf(fields)).toBeNull();
		});

		it('should take any iterable of pairs, never pushing into a value that is an array', function () {
			const first = ['a'];

			expect(helpers.parseFormData(new URLSearchParams('a=1&a=2&b[]=3&b=4'))).toEqual({ a: ['1', '2'], b: ['3', '4'] });
			expect(helpers.parseFormData(new Map([['list', first]]))).toEqual({ list: ['a'] });
			expect(helpers.parseFormData([['list', first] as const, ['list', ['b']] as const])).toEqual({ list: [['a'], ['b']] });
			expect(first).toEqual(['a']);
			expect(helpers.parseFormData([['__proto__', 'x']])).toEqual(Object.assign(Object.create(null), { ['__proto__']: 'x' }));
			expect(helpers.parseFormData([[1 as unknown as string, 'one']])).toEqual({ 1: 'one' });
		});

		it('should reject what is not iterable', function () {
			expect(function () {
				helpers.parseFormData({} as Iterable<[string, string]>);
			}).toThrow('parseFormData: `entries` must be iterable (a FormData, URLSearchParams or [key, value] pairs), got object');
			expect(function () {
				helpers.parseFormData(null as unknown as Iterable<[string, string]>);
			}).toThrow(TypeError);
		});

		it('should reject entries that are not pairs', function () {
			expect(function () {
				helpers.parseFormData(['ab'] as unknown as Iterable<[string, string]>);
			}).toThrow('parseFormData: every entry must be a [key, value] pair, got string');
			expect(function () {
				helpers.parseFormData([null] as unknown as Iterable<[string, string]>);
			}).toThrow(TypeError);
			// An array-like object is not a pair either (like `Object.fromEntries`, which throws on it too).
			expect(function () {
				helpers.parseFormData([{ 0: 'a', 1: 'b' }] as unknown as Iterable<[string, string]>);
			}).toThrow(new TypeError('parseFormData: every entry must be a [key, value] pair, got object'));
			// Any iterable entry is read as a pair.
			expect(helpers.parseFormData([new Set(['a', 'b'])] as unknown as Iterable<[string, string]>)).toEqual({ a: 'b' });
		});
	});

	describe('parseQueryString', function () {
		it('should parse pairs, with or without a leading ?', function () {
			expect(helpers.parseQueryString('?a=1&b=two')).toEqual({ a: '1', b: 'two' });
			expect(helpers.parseQueryString('a=1&b=two')).toEqual({ a: '1', b: 'two' });
			expect(helpers.parseQueryString('')).toEqual({});
			expect(helpers.parseQueryString('?')).toEqual({});
		});

		it('should decode percent-escapes and + as a space', function () {
			expect(helpers.parseQueryString('q=hello+world&r=a%20b%2Bc&e=%F0%9F%98%80')).toEqual({ q: 'hello world', r: 'a b+c', e: '😀' });
			expect(helpers.parseQueryString('a%26b=c%3Dd')).toEqual({ 'a&b': 'c=d' });
		});

		it('should not throw on malformed escapes', function () {
			expect(helpers.parseQueryString('a=%zz&b=%E0%A4%A&c=100%')).toEqual({ a: '%zz', b: '\uFFFD%A', c: '100%' });
		});

		it('should handle missing values, empty keys and empty pairs', function () {
			expect(helpers.parseQueryString('flag&x=&&=v&a=b=c')).toEqual({ flag: '', x: '', '': 'v', a: 'b=c' });
		});

		it('should collect repeated keys into arrays', function () {
			expect(helpers.parseQueryString('a=1&b=2&a=3&a=4')).toEqual({ a: ['1', '3', '4'], b: '2' });
		});

		it('should collapse bracket keys into arrays, even with one value', function () {
			expect(helpers.parseQueryString('ids[]=1&ids[]=2')).toEqual({ ids: ['1', '2'] });
			expect(helpers.parseQueryString('ids[]=1')).toEqual({ ids: ['1'] });
			expect(helpers.parseQueryString('ids%5B%5D=1&ids=2')).toEqual({ ids: ['1', '2'] });
			expect(helpers.parseQueryString('ids=0&ids[]=1')).toEqual({ ids: ['0', '1'] });
		});

		it('should not split comma-separated values', function () {
			expect(helpers.parseQueryString('a=1,2')).toEqual({ a: '1,2' });
		});

		it('should ignore the fragment', function () {
			expect(helpers.parseQueryString('?a=1#b=2')).toEqual({ a: '1' });
			expect(helpers.parseQueryString('#a=1')).toEqual({});
		});

		it('should be safe against prototype pollution', function () {
			const result = helpers.parseQueryString('__proto__=polluted&constructor=x&toString=y&__proto__[]=z');
			expect(Object.getPrototypeOf(result)).toBeNull();
			expect(Object.keys(result)).toEqual(['__proto__', 'constructor', 'toString']);
			expect(result.__proto__).toEqual(['polluted', 'z']);
			expect(result.constructor).toBe('x');
			expect(({} as any).polluted).toBeUndefined();
			expect(Object.prototype).not.toHaveProperty('polluted');
		});
	});

	describe('withQuery', function () {
		it('should add a query to a URL without one', function () {
			expect(helpers.withQuery('https://x.com/path', { a: 1, b: 'c d' })).toBe('https://x.com/path?a=1&b=c%20d');
			expect(helpers.withQuery('/path', {})).toBe('/path');
			expect(helpers.withQuery('', { a: 1 })).toBe('?a=1');
		});

		it('should merge with an existing query, overwriting existing keys', function () {
			expect(helpers.withQuery('https://x.com/search?q=old&page=2#results', { q: 'new value', lang: 'en' })).toBe(
				'https://x.com/search?page=2&q=new%20value&lang=en#results'
			);
			expect(helpers.withQuery('/a?x=1&x=2&y=3', { x: [4, 5] })).toBe('/a?y=3&x=4&x=5');
			expect(helpers.withQuery('/a?t[]=1&t%5B%5D=2&u=1', { t: 3 })).toBe('/a?u=1&t=3');
			expect(helpers.withQuery('/a?hello+world=1&hello%20world=2&b', { 'hello world': 'x' })).toBe('/a?b&hello%20world=x');
		});

		it('should keep the untouched pairs verbatim', function () {
			expect(helpers.withQuery('/a?raw=a+b%2c&bad=%zz', { c: 1 })).toBe('/a?raw=a+b%2c&bad=%zz&c=1');
		});

		it('should ignore undefined values and remove keys set to null', function () {
			expect(helpers.withQuery('/a?x=1&y=2', { x: undefined, y: null })).toBe('/a?x=1');
			expect(helpers.withQuery('/a?y=2', { y: null })).toBe('/a');
			expect(helpers.withQuery('/a?y=2', { y: null }, { skipNull: false })).toBe('/a?y');
			expect(helpers.withQuery('/a?y=2', { y: [] })).toBe('/a');
		});

		it('should preserve the fragment and drop a dangling ?', function () {
			expect(helpers.withQuery('/a#frag?not=query', { b: 1 })).toBe('/a?b=1#frag?not=query');
			expect(helpers.withQuery('/a?#top', {})).toBe('/a#top');
			expect(helpers.withQuery('/a?&&', {})).toBe('/a');
		});

		it('should apply the options to the new parameters', function () {
			expect(helpers.withQuery('/a?z=1', { c: [1, 2], b: 0 }, { arrayFormat: 'brackets', sort: true })).toBe('/a?z=1&b=0&c[]=1&c[]=2');
		});
	});

	describe('joinUrl / withQuery edge cases', function () {
		it('withQuery should replace bare keys (without =) too', function () {
			expect(helpers.withQuery('/p?flag&x=1', { flag: 'on' })).toBe('/p?x=1&flag=on');
		});

		it('joinUrl should only treat a leading scheme (letters, digits, +, -, .) as a scheme', function () {
			expect(helpers.joinUrl('s3://bucket/', '/key')).toBe('s3://bucket/key');
			expect(helpers.joinUrl('files/a:b', 'c')).toBe('files/a:b/c');
			expect(helpers.joinUrl('/a:b//', 'c')).toBe('/a:b/c');
		});
	});

	describe('joinUrl', function () {
		it('should join parts with exactly one slash', function () {
			expect(helpers.joinUrl('https://api.example.com/', '/v1/', 'users', '42')).toBe('https://api.example.com/v1/users/42');
			expect(helpers.joinUrl('a', 'b', 'c')).toBe('a/b/c');
			expect(helpers.joinUrl('a//b', '//c//')).toBe('a/b/c/');
		});

		it('should preserve the scheme, a protocol-relative prefix or a leading slash', function () {
			expect(helpers.joinUrl('http://localhost:3000', 'api')).toBe('http://localhost:3000/api');
			expect(helpers.joinUrl('file:///etc', 'hosts')).toBe('file:///etc/hosts');
			expect(helpers.joinUrl('//cdn.example.com', 'lib.js')).toBe('//cdn.example.com/lib.js');
			expect(helpers.joinUrl('///cdn', 'lib.js')).toBe('/cdn/lib.js');
			expect(helpers.joinUrl('//', 'a')).toBe('/a');
			expect(helpers.joinUrl('//')).toBe('/');
			expect(helpers.joinUrl('/api', 'items')).toBe('/api/items');
			expect(helpers.joinUrl('https://', 'example.com', 'a')).toBe('https://example.com/a');
			expect(helpers.joinUrl('https://')).toBe('https://');
		});

		it('should keep a trailing slash only when the last part has one', function () {
			expect(helpers.joinUrl('a', 'b/')).toBe('a/b/');
			expect(helpers.joinUrl('a/', 'b')).toBe('a/b');
			expect(helpers.joinUrl('a', '/')).toBe('a/');
			expect(helpers.joinUrl('/')).toBe('/');
			expect(helpers.joinUrl('/', '/')).toBe('/');
			expect(helpers.joinUrl('https://x.com/')).toBe('https://x.com/');
		});

		it('should ignore empty parts', function () {
			expect(helpers.joinUrl('a', '', 'b')).toBe('a/b');
			expect(helpers.joinUrl('', '/a')).toBe('/a');
			expect(helpers.joinUrl()).toBe('');
			expect(helpers.joinUrl('', '')).toBe('');
		});

		it('should keep the query and fragment of the last part', function () {
			expect(helpers.joinUrl('/api', 'items/', '?page=2')).toBe('/api/items?page=2');
			expect(helpers.joinUrl('/api', 'items/?page=2')).toBe('/api/items/?page=2');
			expect(helpers.joinUrl('a', 'b#x//y')).toBe('a/b#x//y');
			expect(helpers.joinUrl('a?x//y')).toBe('a?x//y');
			expect(helpers.joinUrl('?q')).toBe('?q');
		});

		it('should throw a TypeError for non-string parts', function () {
			expect(function () {
				helpers.joinUrl('a', 1 as any);
			}).toThrow(TypeError);
		});
	});

	describe('getQueryParam', function () {
		it('should match bracket keys, the first occurrence winning', function () {
			expect(helpers.getQueryParam('/p?a[]=1&a=2', 'a')).toBe('1');
			expect(helpers.getQueryParam('/p?a=2&a[]=1', 'a')).toBe('2');
			expect(helpers.getQueryParam('/p?a%5B%5D=3', 'a')).toBe('3');
			// `a[]` is the stored key of the raw key `a[][]` only (parseQueryString removes one pair of brackets).
			expect(helpers.getQueryParam('/p?a[]=1', 'a[]')).toBeUndefined();
			expect(helpers.getQueryParam('/p?a[][]=1', 'a[]')).toBe('1');
		});

		it('should never match a key holding a lone surrogate (parsed keys hold U+FFFD instead)', function () {
			expect(helpers.getQueryParam('/p?%ED%A0%80=1', '\ud800')).toBeUndefined();
			expect(helpers.getQueryParam('/p?\ud800=1', '\ufffd')).toBe('1');
		});

		it('should return the first value of a parameter', function () {
			expect(helpers.getQueryParam('https://x.com/?q=hello+world&q=2#top', 'q')).toBe('hello world');
			expect(helpers.getQueryParam('/p?ids[]=7&ids[]=8', 'ids')).toBe('7');
			expect(helpers.getQueryParam('/path?flag', 'flag')).toBe('');
		});

		it('should return undefined for missing parameters', function () {
			expect(helpers.getQueryParam('/path', 'q')).toBeUndefined();
			expect(helpers.getQueryParam('q=1', 'q')).toBeUndefined();
			expect(helpers.getQueryParam('/p?a=1', 'b')).toBeUndefined();
			expect(helpers.getQueryParam('/p#?q=1', 'q')).toBeUndefined();
		});

		it('should not see inherited properties', function () {
			expect(helpers.getQueryParam('/p?a=1', 'constructor')).toBeUndefined();
			expect(helpers.getQueryParam('/p?a=1', '__proto__')).toBeUndefined();
			expect(helpers.getQueryParam('/p?__proto__=1', '__proto__')).toBe('1');
		});
	});

	describe('isAbsoluteUrl', function () {
		it('should accept scheme:// and protocol-relative URLs', function () {
			expect(helpers.isAbsoluteUrl('https://example.com')).toBe(true);
			expect(helpers.isAbsoluteUrl('HTTP://EXAMPLE.COM')).toBe(true);
			expect(helpers.isAbsoluteUrl('ftp://host/file')).toBe(true);
			expect(helpers.isAbsoluteUrl('custom+app.v2-x://open')).toBe(true);
			expect(helpers.isAbsoluteUrl('//cdn.example.com/lib.js')).toBe(true);
		});

		it('should reject relative URLs and schemes without //', function () {
			expect(helpers.isAbsoluteUrl('/relative/path')).toBe(false);
			expect(helpers.isAbsoluteUrl('relative/path')).toBe(false);
			expect(helpers.isAbsoluteUrl('mailto:someone@example.com')).toBe(false);
			expect(helpers.isAbsoluteUrl('1http://x')).toBe(false);
			expect(helpers.isAbsoluteUrl('./a://b')).toBe(false);
			expect(helpers.isAbsoluteUrl('')).toBe(false);
		});
	});

	describe('security', function () {
		/**
		 * Resolves `url` against `base` like a browser does (`location.href = url`, `<a href>`, a `Location` header).
		 * @param {string} url - The URL
		 * @param {string} [base='https://good.com'] - The base URL
		 * @returns {string} The resolved URL
		 */
		function resolve(url: string, base: string = 'https://good.com'): string {
			return new URL(url, base).href;
		}

		it('isAbsoluteUrl should see the browser-normalised forms of protocol-relative URLs (open redirect)', function () {
			for (const url of [
				'/\\evil.com',
				'\\\\evil.com',
				'\\/evil.com',
				' //evil.com',
				'\u0000\u001f //evil.com',
				'/\t/evil.com',
				'/\n/evil.com',
				'\r//evil.com',
				'///evil.com'
			]) {
				expect(resolve(url)).toBe('https://evil.com/');
				expect(helpers.isAbsoluteUrl(url)).toBe(true);
			}
		});

		it('isAbsoluteUrl should treat a special scheme as absolute even without // (browsers add them)', function () {
			for (const url of ['https:\\\\evil.com', 'https:/evil.com', 'https:evil.com', 'HTTPS:evil.com', 'ht\ttps://evil.com', ' https://evil.com']) {
				expect(resolve(url, 'http://good.com')).toBe('https://evil.com/');
				expect(helpers.isAbsoluteUrl(url)).toBe(true);
			}
			expect(helpers.isAbsoluteUrl('http:x')).toBe(true);
			expect(helpers.isAbsoluteUrl('wss:x')).toBe(true);
			expect(helpers.isAbsoluteUrl('ftp:x')).toBe(true);
			expect(helpers.isAbsoluteUrl('file:x')).toBe(true);
		});

		it('isAbsoluteUrl should never call javascript:, data: or vbscript: URLs absolute, even with //', function () {
			for (const url of ['javascript://%0aalert(1)', 'JavaScript://x', 'java\tscript://x', ' javascript://x', 'data://text/html,x', 'vbscript://x']) {
				expect(helpers.isAbsoluteUrl(url)).toBe(false);
			}
			// Other non-special schemes still need `//` (browsers do not add it, and `\` is not a slash for them).
			expect(helpers.isAbsoluteUrl('custom:\\\\host')).toBe(false);
			expect(helpers.isAbsoluteUrl('custom:/host')).toBe(false);
			expect(helpers.isAbsoluteUrl('custom://host')).toBe(true);
			expect(helpers.isAbsoluteUrl('javascripts://host')).toBe(true);
			// Characters browsers do not strip keep the string relative.
			expect(helpers.isAbsoluteUrl('\u00a0//evil.com')).toBe(false);
			expect(helpers.isAbsoluteUrl('/%2F/evil.com')).toBe(false);
			expect(helpers.isAbsoluteUrl('./\\evil.com')).toBe(false);
			expect(helpers.isAbsoluteUrl(' \t')).toBe(false);
		});

		it('joinUrl should never let a part other than the first one start the result with // or a backslash', function () {
			expect(helpers.joinUrl('/', '\\evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('/', '/\\evil.com/x')).toBe('/evil.com/x');
			expect(helpers.joinUrl('/', '\\\\evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('/', '\t/evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('/', '/\n/evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('', '//evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('', '\\\\evil.com')).toBe('/evil.com');
			expect(helpers.joinUrl('', '', '//evil.com', 'x')).toBe('/evil.com/x');
			for (const joined of [helpers.joinUrl('/', '\\evil.com'), helpers.joinUrl('', '//evil.com'), helpers.joinUrl('/', '\t/evil.com')]) {
				expect(helpers.isAbsoluteUrl(joined)).toBe(false);
				expect(resolve(joined)).toBe('https://good.com/evil.com');
			}
		});

		it('joinUrl should never let a part other than the first one add a scheme', function () {
			expect(helpers.joinUrl('', 'https://evil.com')).toBe('./https:/evil.com');
			expect(helpers.joinUrl('', 'https:', 'evil.com')).toBe('./https:/evil.com');
			expect(helpers.joinUrl('', ' https:', 'evil.com')).toBe('./ https:/evil.com');
			expect(helpers.joinUrl('', 'javascript:alert(1)')).toBe('./javascript:alert(1)');
			expect(resolve(helpers.joinUrl('', 'https://evil.com'), 'http://good.com/')).toBe('http://good.com/https:/evil.com');
			// Without a scheme-shaped first segment, nothing is added.
			expect(helpers.joinUrl('', 'a', 'b:c')).toBe('a/b:c');
			expect(helpers.joinUrl('', '/https://evil.com')).toBe('/https:/evil.com');
		});

		it('joinUrl should still take a scheme or a protocol-relative host from the first part', function () {
			expect(helpers.joinUrl('https:\\\\api.example.com\\v1', 'users')).toBe('https://api.example.com/v1/users');
			expect(helpers.joinUrl('\\\\cdn.example.com', 'lib.js')).toBe('//cdn.example.com/lib.js');
			expect(helpers.joinUrl('/\t/cdn.example.com', 'lib.js')).toBe('//cdn.example.com/lib.js');
			expect(helpers.joinUrl('1a:b', 'c')).toBe('./1a:b/c');
		});

		it('joinUrl should keep backslashes and tabs of the query and fragment of the last part', function () {
			expect(helpers.joinUrl('/a', 'b?x=\\\t#\\')).toBe('/a/b?x=\\\t#\\');
		});

		it('joinUrl joins the other parts verbatim: untrusted segments must be encoded by the caller', function () {
			// Documented caveats: `?`, `#` and dot segments are not encoded...
			expect(new URL(helpers.joinUrl('https://api.x.com/users', 'a?admin=1#', 'profile')).search).toBe('?admin=1');
			expect(new URL(helpers.joinUrl('https://api.x.com/v1/users', '..', '..', 'admin')).pathname).toBe('/admin');
			// ...but encodeURIComponent on each segment keeps them inside one path segment.
			expect(new URL(helpers.joinUrl('https://api.x.com/users', encodeURIComponent('a?admin=1#'), 'profile')).search).toBe('');
		});

		it('withQuery should replace both key and key[] when params use the bracket form (parameter pollution)', function () {
			expect(helpers.withQuery('/x?a[]=1', { 'a[]': '2' })).toBe('/x?a%5B%5D=2');
			expect(helpers.withQuery('/x?a=1&a[]=2&b=3', { 'a[]': ['4', '5'] })).toBe('/x?b=3&a%5B%5D=4&a%5B%5D=5');
			expect(helpers.withQuery('/x?a%5B%5D=1&b=2', { a: '3' })).toBe('/x?b=2&a=3');
			expect(helpers.withQuery('/x?a[]=1&b=2', { 'a[]': null })).toBe('/x?b=2');
			expect(helpers.parseQueryString(helpers.withQuery('/x?a[]=1', { 'a[]': '2' }).slice(2))).toEqual(Object.assign(Object.create(null), { a: ['2'] }));
		});
	});

	describe('argument validation', function () {
		it('uses the library-wide message format', function () {
			expect(function () {
				helpers.buildQueryString({ a: {} as any });
			}).toThrow(new TypeError('buildQueryString: `params.a` must be a string, number, boolean, bigint or Date, got object'));
			expect(function () {
				helpers.buildQueryString({ when: new Date(NaN) });
			}).toThrow(new RangeError('buildQueryString: `params.when` must be a valid Date, got Invalid Date'));
			expect(function () {
				helpers.buildQueryString({}, { arrayFormat: 'x' as any });
			}).toThrow(new RangeError("buildQueryString: `arrayFormat` must be 'repeat', 'comma' or 'brackets', got x"));
			expect(function () {
				helpers.joinUrl('a', null as any);
			}).toThrow(new TypeError('joinUrl: `parts` must only contain strings, got null'));
		});
	});
});

describe('URL helpers (round 11)', function () {
	describe('isSafeUrl / sanitizeUrl', function () {
		it('types an explicit undefined fallback as the default, a string', function () {
			const url: string = helpers.sanitizeUrl('javascript:x', undefined, { protocols: ['https:'] });
			const maybe: string | null = helpers.sanitizeUrl('javascript:x', null);
			expect([url, maybe]).toEqual(['about:blank', null]);
		});

		it('should allow the default schemes, in any case', function () {
			for (const url of ['https://example.com', 'http://x', 'HTTPS://X', 'mailto:a@b.c', 'tel:+123', 'Https:host']) expect(helpers.isSafeUrl(url)).toBe(true);
		});

		it('should reject other schemes, however they are disguised', function () {
			const unsafe = [
				'javascript:alert(1)',
				'JaVaScRiPt:alert(1)',
				' java\tscript:alert(1)',
				'\x01javascript:x',
				'\x00 \x1fjavascript:x',
				'java\nscript:x',
				'jav\r\nascript:x',
				'\tjavascript:x',
				'data:text/html,<script>alert(1)</script>',
				'vbscript:msgbox',
				'file:///etc/passwd',
				'blob:https://x/uuid',
				'custom+app://open',
				'c:/windows'
			];
			for (const url of unsafe) expect(helpers.isSafeUrl(url)).toBe(false);
		});

		it('should treat strings without a scheme as relative', function () {
			for (const url of [
				'/path',
				'page.html',
				'?q=1',
				'#top',
				'',
				'//cdn.example.com/x.js',
				'javascript',
				'java script:x',
				'\x01java\x01script:x',
				'javascript&colon;x',
				'1http:x'
			]) {
				expect(helpers.isSafeUrl(url)).toBe(true);
				expect(helpers.isSafeUrl(url, { allowRelative: false })).toBe(false);
			}
		});

		it('should use a custom allowlist', function () {
			expect(helpers.isSafeUrl('ftp://files.example.com', { protocols: ['https:', 'FTP:'] })).toBe(true);
			expect(helpers.isSafeUrl('https://x', { protocols: ['ftp:'] })).toBe(false);
			expect(helpers.isSafeUrl('/x', { protocols: [] })).toBe(true);
			expect(helpers.isSafeUrl('https://x', { protocols: [] })).toBe(false);
			expect(helpers.isSafeUrl('web+app:x', { protocols: ['web+app:'] })).toBe(true);
		});

		it('should treat non-strings as unsafe', function () {
			expect(helpers.isSafeUrl(undefined as any)).toBe(false);
			expect(
				helpers.isSafeUrl({
					toString: function () {
						return 'https://x';
					}
				} as any)
			).toBe(false);
			expect(helpers.sanitizeUrl(42 as any)).toBe('about:blank');
		});

		it('should validate the allowlist', function () {
			expect(function () {
				helpers.isSafeUrl('https://x', { protocols: 'https:' as any });
			}).toThrow(new TypeError('isSafeUrl: `options.protocols` must be an array of strings, got string'));
			expect(function () {
				helpers.isSafeUrl('https://x', { protocols: ['https:', 1] as any });
			}).toThrow(new TypeError('isSafeUrl: `options.protocols` must be an array of strings, got number in it'));
			for (const entry of ['https', 'https://', ':', '1a:', '']) {
				expect(function () {
					helpers.isSafeUrl('/x', { protocols: [entry] });
				}).toThrow(new RangeError(`isSafeUrl: \`options.protocols\` entries must be schemes ending with ':' (such as 'https:'), got ${JSON.stringify(entry)}`));
			}
		});

		it('should sanitize with a fallback', function () {
			expect(helpers.sanitizeUrl('https://example.com')).toBe('https://example.com');
			expect(helpers.sanitizeUrl(' https://example.com ')).toBe(' https://example.com ');
			expect(helpers.sanitizeUrl('javascript:alert(1)')).toBe('about:blank');
			expect(helpers.sanitizeUrl('javascript:alert(1)', '#')).toBe('#');
			expect(helpers.sanitizeUrl('vbscript:x', null)).toBeNull();
			expect(helpers.sanitizeUrl('/x', '#', { allowRelative: false })).toBe('#');
			expect(helpers.sanitizeUrl('ftp://x', '#', { protocols: ['ftp:'] })).toBe('ftp://x');
		});
	});

	describe('slash helpers', function () {
		it('withTrailingSlash should respect the query and fragment', function () {
			expect(helpers.withTrailingSlash('/a?x=1')).toBe('/a/?x=1');
			expect(helpers.withTrailingSlash('/a/?x=1')).toBe('/a/?x=1');
			expect(helpers.withTrailingSlash('/a#b/c')).toBe('/a/#b/c');
			expect(helpers.withTrailingSlash('')).toBe('/');
			expect(helpers.withTrailingSlash('?q')).toBe('/?q');
			expect(helpers.withTrailingSlash('https://x.com')).toBe('https://x.com/');
		});

		it('withoutTrailingSlash should keep roots and scheme slashes', function () {
			expect(helpers.withoutTrailingSlash('/a/')).toBe('/a');
			expect(helpers.withoutTrailingSlash('/a///?x=/#/')).toBe('/a?x=/#/');
			expect(helpers.withoutTrailingSlash('/')).toBe('/');
			expect(helpers.withoutTrailingSlash('/?x')).toBe('/?x');
			expect(helpers.withoutTrailingSlash('')).toBe('');
			expect(helpers.withoutTrailingSlash('a//')).toBe('a');
			expect(helpers.withoutTrailingSlash('https://x.com/')).toBe('https://x.com');
			expect(helpers.withoutTrailingSlash('https://')).toBe('https://');
			expect(helpers.withoutTrailingSlash('file:///')).toBe('file:///');
			expect(helpers.withoutTrailingSlash('//host/')).toBe('//host');
		});

		it('withLeadingSlash should give exactly one leading slash', function () {
			expect(helpers.withLeadingSlash('a')).toBe('/a');
			expect(helpers.withLeadingSlash('/a')).toBe('/a');
			expect(helpers.withLeadingSlash('')).toBe('/');
			expect(helpers.withLeadingSlash('//evil.example')).toBe('/evil.example');
			expect(helpers.withLeadingSlash('/\\evil.example')).toBe('/evil.example');
			expect(helpers.withLeadingSlash('/\t/evil.example')).toBe('/evil.example');
			expect(helpers.withLeadingSlash('#x')).toBe('/#x');
		});

		it('withoutLeadingSlash should remove the leading slashes', function () {
			expect(helpers.withoutLeadingSlash('/a/b/')).toBe('a/b/');
			expect(helpers.withoutLeadingSlash('///a')).toBe('a');
			expect(helpers.withoutLeadingSlash('a')).toBe('a');
			expect(helpers.withoutLeadingSlash('\\\\a')).toBe('a');
		});

		it('cleanDoubleSlashes should only touch the path', function () {
			expect(helpers.cleanDoubleSlashes('https://example.com//a///b?u=http://x//y#//z')).toBe('https://example.com/a/b?u=http://x//y#//z');
			expect(helpers.cleanDoubleSlashes('file:///etc//hosts')).toBe('file:///etc/hosts');
			expect(helpers.cleanDoubleSlashes('//cdn.example.com//lib.js')).toBe('//cdn.example.com/lib.js');
			expect(helpers.cleanDoubleSlashes('/a//b//')).toBe('/a/b/');
			expect(helpers.cleanDoubleSlashes('a//b')).toBe('a/b');
			expect(helpers.cleanDoubleSlashes('')).toBe('');
		});
	});

	describe('withBase / withoutBase', function () {
		it('should mount a path under a base, segment by segment', function () {
			expect(helpers.withBase('/users?page=2#top', '/app')).toBe('/app/users?page=2#top');
			expect(helpers.withBase('users', '/app/')).toBe('/app/users');
			expect(helpers.withBase('/', '/app')).toBe('/app/');
			expect(helpers.withBase('', '/app')).toBe('/app');
			expect(helpers.withBase('?q', '/app')).toBe('/app?q');
			expect(helpers.withBase('/app', '/app')).toBe('/app');
			expect(helpers.withBase('/app/users', '/app/')).toBe('/app/users');
			expect(helpers.withBase('/app?x', '/app')).toBe('/app?x');
			expect(helpers.withBase('/application', '/app')).toBe('/app/application');
			expect(helpers.withBase('//evil.example', '/app')).toBe('/app/evil.example');
			expect(helpers.withBase('/v1', 'https://api.example.com/')).toBe('https://api.example.com/v1');
		});

		it('should leave URLs with a scheme and empty bases alone', function () {
			expect(helpers.withBase('https://x.com/a', '/app')).toBe('https://x.com/a');
			expect(helpers.withBase('javascript:alert(1)', '/app')).toBe('javascript:alert(1)');
			expect(helpers.withBase('users', '/')).toBe('users');
			expect(helpers.withBase('users', '')).toBe('users');
		});

		it('should unmount a base path, segment by segment', function () {
			expect(helpers.withoutBase('/app/users?page=2#top', '/app')).toBe('/users?page=2#top');
			expect(helpers.withoutBase('/app', '/app/')).toBe('/');
			expect(helpers.withoutBase('/app?x', '/app')).toBe('/?x');
			expect(helpers.withoutBase('/app/', '/app')).toBe('/');
			expect(helpers.withoutBase('/application', '/app')).toBe('/application');
			expect(helpers.withoutBase('/other', '/app')).toBe('/other');
			expect(helpers.withoutBase('/app//evil.example', '/app')).toBe('/evil.example');
			expect(helpers.withoutBase('/users', '/')).toBe('/users');
			expect(helpers.withoutBase('https://example.com/docs/intro', 'https://example.com/docs')).toBe('/intro');
		});
	});

	describe('safeDecodeURIComponent', function () {
		it('should decode like decodeURIComponent when it can', function () {
			expect(helpers.safeDecodeURIComponent('caf%C3%A9%20au%20lait')).toBe('café au lait');
			expect(helpers.safeDecodeURIComponent('%F0%9F%91%8D')).toBe('👍');
			expect(helpers.safeDecodeURIComponent('plain')).toBe('plain');
			expect(helpers.safeDecodeURIComponent('a+b%2B')).toBe('a+b+');
			expect(helpers.safeDecodeURIComponent('')).toBe('');
		});

		it('should keep malformed escapes and decode the valid ones', function () {
			expect(helpers.safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
			expect(helpers.safeDecodeURIComponent('100%25%20off%')).toBe('100% off%');
			expect(helpers.safeDecodeURIComponent('%ZZ%41')).toBe('%ZZA');
			expect(helpers.safeDecodeURIComponent('Jos%E9%20Garc%C3%ADa')).toBe('Jos%E9 García');
			expect(helpers.safeDecodeURIComponent('%E0%A4%41')).toBe('%E0%A4A');
			expect(helpers.safeDecodeURIComponent('%80%C3%A9%C3')).toBe('%80é%C3');
			expect(helpers.safeDecodeURIComponent('%ED%A0%80')).toBe('%ED%A0%80');
			expect(helpers.safeDecodeURIComponent('%F8%88%80%80%80')).toBe('%F8%88%80%80%80');
			expect(helpers.safeDecodeURIComponent('%C0%AF')).toBe('%C0%AF');
		});
	});

	describe('withFragment / withoutFragment / withoutQuery', function () {
		it('should set, replace and remove the fragment', function () {
			expect(helpers.withFragment('/docs?v=2#old', 'install')).toBe('/docs?v=2#install');
			expect(helpers.withFragment('/docs', '#install')).toBe('/docs#install');
			expect(helpers.withFragment('/docs', '##x')).toBe('/docs#%23x');
			expect(helpers.withFragment('/a#b', '')).toBe('/a');
			expect(helpers.withFragment('/a#b', '#')).toBe('/a');
			expect(helpers.withFragment('/app', '/users/42?tab=info&x=1')).toBe('/app#/users/42?tab=info&x=1');
			expect(helpers.withFragment('/a', 'section 2 #b 100%')).toBe('/a#section%202%20%23b%20100%25');
			expect(helpers.withFragment('/a', 'é\ud800')).toBe('/a#%C3%A9%EF%BF%BD');
		});

		it('should remove the fragment', function () {
			expect(helpers.withoutFragment('/docs?v=2#install')).toBe('/docs?v=2');
			expect(helpers.withoutFragment('/docs')).toBe('/docs');
			expect(helpers.withoutFragment('#a#b')).toBe('');
		});

		it('should remove the query and keep the fragment', function () {
			expect(helpers.withoutQuery('/search?q=a#results')).toBe('/search#results');
			expect(helpers.withoutQuery('/page#section?not-a-query')).toBe('/page#section?not-a-query');
			expect(helpers.withoutQuery('/page')).toBe('/page');
			expect(helpers.withoutQuery('?a?b')).toBe('');
		});
	});
});

describe('fragment before a question mark', function () {
	it('treats a ? inside the fragment as part of the fragment', function () {
		expect(helpers.withTrailingSlash('/a#x?y')).toBe('/a/#x?y');
		expect(helpers.withoutQuery('/a#x?y')).toBe('/a#x?y');
	});
});

describe('url (helper review regressions)', function () {
	it('withQuery replaces keys holding lone surrogates, which are written as U+FFFD', function () {
		expect(helpers.withQuery('/a?\ud800=1', { '\ud800': '2' })).toBe('/a?%EF%BF%BD=2');
		expect(helpers.withQuery('/a?x%EF%BF%BD=evil&y=1', { 'x\udfff': 'safe' })).toBe('/a?y=1&x%EF%BF%BD=safe');
	});

	it('accepts null and undefined array items in the parameter types, and skips them', function () {
		const ids: Array<string | undefined> = ['a', undefined];
		expect(helpers.buildQueryString({ a: [1, null], b: ids })).toBe('a=1&b=a');
		expect(helpers.withQuery('/x', { a: [null, 'b'] })).toBe('/x?a=b');
	});

	it('isSafeUrl validates its protocols whatever the url is', function () {
		expect(function () {
			helpers.isSafeUrl(123 as never, { protocols: [1 as never] });
		}).toThrow(TypeError);
		expect(function () {
			helpers.isSafeUrl(123 as never, { protocols: ['https'] });
		}).toThrow(RangeError);
		expect(helpers.isSafeUrl(123 as never, { protocols: ['https:'] })).toBe(false);
	});
});

describe('URL helpers (hostile inputs)', function () {
	it('withQuery reads every parameter once, so a getter cannot add a key twice', function () {
		let reads = 0;
		const params = {
			get next(): string | undefined {
				return reads++ === 0 ? undefined : '/evil';
			}
		};
		// Read once (as undefined): the existing pair stays and no second one is added.
		expect(helpers.withQuery('/login?next=/home', params)).toBe('/login?next=/home');
	});

	it('serializes dates of other realms and ignores an overridden getTime', function () {
		const OtherDate = vm.runInNewContext('Date') as DateConstructor;
		expect(helpers.buildQueryString({ d: new OtherDate(0) })).toBe('d=1970-01-01T00%3A00%3A00.000Z');
		class Lying extends Date {
			override getTime(): number {
				return 0;
			}
		}
		expect(function () {
			helpers.buildQueryString({ d: new Lying(NaN) });
		}).toThrow(new RangeError('buildQueryString: `params.d` must be a valid Date, got Invalid Date'));
	});

	it('skips array holes even under a polluted prototype', function () {
		const proto = Object.prototype as Record<number, unknown>;
		proto[1] = 'polluted';
		try {
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.buildQueryString({ ids: [1, , 3] })).toBe('ids=1&ids=3');
		} finally {
			delete proto[1];
		}
	});

	it('rejects arrays as parameter objects at the type level', function () {
		// @ts-expect-error indexes would become keys
		expect(helpers.buildQueryString(['x', 'y'])).toBe('0=x&1=y');
	});

	it('treats a backslash after the base as a slash', function () {
		expect(helpers.withBase('/app\\users', '/app')).toBe('/app\\users');
		expect(helpers.withoutBase('/app\\users', '/app')).toBe('/users');
	});

	it('never types sanitizeUrl as possibly undefined', function () {
		const fallback = undefined as string | undefined;
		const url: string = helpers.sanitizeUrl('javascript:x', fallback);
		expect(url).toBe('about:blank');
	});
});

type Equals<X, Y> = (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false;

function assertType<T extends true>(_value: T): void {}

describe('route patterns', function () {
	describe('matchPath', function () {
		it('does not read its memo from a polluted Object.prototype', function () {
			const proto = Object.prototype as Record<string, unknown>;
			for (const planted of [true, false]) {
				for (let slot = 0; slot < 16; slot++) proto[slot] = planted;
				try {
					expect(helpers.matchPath('/admin', '/public')).toBeNull();
					expect(helpers.matchPath('/users/:id', '/x/y')).toBeNull();
					expect(helpers.matchPath('/a/:b?/c', '/a/c')).toEqual({});
					expect(helpers.compilePath('/:a?/:b?')({ a: 'x', b: 'y' })).toBe('/x/y');
				} finally {
					for (let slot = 0; slot < 16; slot++) delete proto[slot];
				}
			}
		});

		it('captures named parameters in a null-prototype object', function () {
			const params = helpers.matchPath('/users/:id/posts/:postId', '/users/42/posts/7');
			expect(params).toEqual({ id: '42', postId: '7' });
			expect(Object.getPrototypeOf(params)).toBeNull();
			const none = helpers.matchPath('/about', '/about');
			expect(none).toEqual({});
			expect(Object.getPrototypeOf(none)).toBeNull();
		});

		it('returns null when the pathname does not match', function () {
			expect(helpers.matchPath('/users/:id', '/users')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/1/2')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/posts/1')).toBeNull();
			expect(helpers.matchPath('/', '/x')).toBeNull();
			expect(helpers.matchPath('/x', '/')).toBeNull();
		});

		it('needs a pathname starting with a slash', function () {
			expect(helpers.matchPath('/users/:id', 'users/42')).toBeNull();
			expect(helpers.matchPath('/', '')).toBeNull();
			expect(helpers.matchPath('/users/:id', 'https://x.example/users/42')).toBeNull();
		});

		it('ignores the query and the fragment', function () {
			expect(helpers.matchPath('/users/:id', '/users/42?tab=a/b#top')).toEqual({ id: '42' });
			expect(helpers.matchPath('/users/:id', '/users/42#frag?x')).toEqual({ id: '42' });
			expect(helpers.matchPath('/', '/?q')).toEqual({});
		});

		it('fills optional segments from the left, without losing a match', function () {
			expect(helpers.matchPath('/:a?/:b?/c', '/x/y/c')).toEqual({ a: 'x', b: 'y' });
			expect(helpers.matchPath('/:a?/:b?/c', '/x/c')).toEqual({ a: 'x' });
			expect(helpers.matchPath('/:a?/:b?/c', '/c')).toEqual({});
			expect(helpers.matchPath('/:a?/x/:b?', '/x/x')).toEqual({ a: 'x' });
			expect(helpers.matchPath('/:a?/x/:b?', '/x')).toEqual({});
			expect(helpers.matchPath('/:a?/x/:b?', '/y/x/z')).toEqual({ a: 'y', b: 'z' });
			expect(helpers.matchPath('/:a?/:b', '/v')).toEqual({ b: 'v' });
			expect(helpers.matchPath('/:a?/:b?/c', '/x/y/z/c')).toBeNull();
			const params = helpers.matchPath('/users/:id/:tab?', '/users/1') as Record<string, string>;
			expect('tab' in params).toBe(false);
		});

		it('supports optional static segments', function () {
			expect(helpers.matchPath('/docs?', '/')).toEqual({});
			expect(helpers.matchPath('/docs?', '/docs')).toEqual({});
			expect(helpers.matchPath('/docs?', '/doc')).toBeNull();
			expect(helpers.matchPath('/project/task?/:id', '/project/task/1')).toEqual({ id: '1' });
			expect(helpers.matchPath('/project/task?/:id', '/project/1')).toEqual({ id: '1' });
			expect(helpers.matchPath('/project/task?/:id', '/project/task')).toEqual({ id: 'task' });
		});

		it('captures a parameter between static text in a segment', function () {
			expect(helpers.matchPath('/@:handle', '/@ada')).toEqual({ handle: 'ada' });
			expect(helpers.matchPath('/:file.json', '/notes.json')).toEqual({ file: 'notes' });
			expect(helpers.matchPath('/v:major/api', '/v2/api')).toEqual({ major: '2' });
			expect(helpers.matchPath('/a-:id-b', '/a-x-y-b')).toEqual({ id: 'x-y' });
			expect(helpers.matchPath('/:name$x', '/ab')).toEqual({ name$x: 'ab' });
			expect(helpers.matchPath('/:_1~x', '/ab~x')).toEqual({ _1: 'ab' });
			expect(helpers.matchPath('/:id.json?', '/')).toEqual({});
			expect(helpers.matchPath('/:id.json?', '/1.json')).toEqual({ id: '1' });
		});

		it('never captures empty text', function () {
			expect(helpers.matchPath('/@:handle', '/@')).toBeNull();
			expect(helpers.matchPath('/:file.json', '/.json')).toBeNull();
			expect(helpers.matchPath('/a-:id-a', '/a-a')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/')).toBeNull();
			expect(helpers.matchPath('/users/:id/x', '/users//x')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/42//')).toBeNull();
			expect(helpers.matchPath('/a/b', '/a//b')).toBeNull();
		});

		it('captures the rest of the pathname with a splat', function () {
			expect(helpers.matchPath('/files/*path', '/files/a/b/c.txt')).toEqual({ path: 'a/b/c.txt' });
			expect(helpers.matchPath('/files/*path', '/files/x')).toEqual({ path: 'x' });
			expect(helpers.matchPath('/files/*path', '/files')).toBeNull();
			expect(helpers.matchPath('/files/*path', '/files/')).toBeNull();
			expect(helpers.matchPath('/files/*path', '/files/a//b')).toEqual({ path: 'a//b' });
			expect(helpers.matchPath('/files/*path', '/files//')).toBeNull();
			expect(helpers.matchPath('/*', '/a/b')).toEqual({ '*': 'a/b' });
			expect(helpers.matchPath('/*', '/')).toBeNull();
			expect(helpers.matchPath('/:a/*rest', '/x/y')).toEqual({ a: 'x', rest: 'y' });
			expect(helpers.matchPath('/:a?/*rest', '/x')).toEqual({ rest: 'x' });
			expect(helpers.matchPath('/:a?/*rest', '/x/y')).toEqual({ a: 'x', rest: 'y' });
		});

		it('supports optional splats', function () {
			expect(helpers.matchPath('/files/*path?', '/files')).toEqual({});
			expect(helpers.matchPath('/files/*path?', '/files/')).toEqual({});
			expect(helpers.matchPath('/files/*path?', '/files/a/b')).toEqual({ path: 'a/b' });
			expect(helpers.matchPath('/*?', '/')).toEqual({});
			expect(helpers.matchPath('/files/*path?', '/files/', { strict: true })).toBeNull();
		});

		it('decodes each segment before comparing it, static text included', function () {
			expect(helpers.matchPath('/café/:x', '/caf%C3%A9/a%20b')).toEqual({ x: 'a b' });
			expect(helpers.matchPath('/caf%C3%A9', '/café')).toEqual({});
			expect(helpers.matchPath('/a%3Ab', '/a:b')).toEqual({});
			expect(helpers.matchPath('/users/:id', '/users/a%2Fb')).toEqual({ id: 'a/b' });
			expect(helpers.matchPath('/users/:id', '/users/%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
			expect(helpers.matchPath('/users/:id', '/users/100%')).toEqual({ id: '100%' });
			expect(helpers.matchPath('/files/*p', '/files/a%2Fb/c%20d')).toEqual({ p: 'a/b/c d' });
			expect(helpers.matchPath('/a', '/%61')).toEqual({});
		});

		it('never matches a pathname with a dot segment', function () {
			expect(helpers.matchPath('/files/*path', '/files/../etc/passwd')).toBeNull();
			expect(helpers.matchPath('/files/*path', '/files/a/./b')).toBeNull();
			expect(helpers.matchPath('/files/*path', '/files/%2e%2E/x')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/..')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/%2e')).toBeNull();
			expect(helpers.matchPath('/users/:id', '/users/...')).toEqual({ id: '...' });
			expect(helpers.matchPath('/users/:id', '/users/.x')).toEqual({ id: '.x' });
		});

		it('compares static text without case unless caseSensitive is set', function () {
			expect(helpers.matchPath('/Users/:id', '/uSERS/AbC')).toEqual({ id: 'AbC' });
			expect(helpers.matchPath('/Users/:id', '/uSERS/AbC', { caseSensitive: true })).toBeNull();
			expect(helpers.matchPath('/Users/:id', '/Users/AbC', { caseSensitive: true })).toEqual({ id: 'AbC' });
			expect(helpers.matchPath('/V:major.JSON', '/v1.json')).toEqual({ major: '1' });
			expect(helpers.matchPath('/V:major.JSON', '/v1.json', { caseSensitive: true })).toBeNull();
			expect(helpers.matchPath('/V:major.JSON', '/V1.JSON', { caseSensitive: true })).toEqual({ major: '1' });
		});

		it('folds the case of ASCII letters only, keeping lengths', function () {
			expect(helpers.matchPath('/ΟΔΟΣ', '/οδος')).toBeNull();
			expect(helpers.matchPath('/ΟΔΟΣ', '/ΟΔΟΣ')).toEqual({});
			expect(helpers.matchPath('/straße', '/STRASSE')).toBeNull();
			expect(helpers.matchPath('/straße:x', '/STRASSEx')).toBeNull();
			expect(helpers.matchPath('/straße', '/STRAßE')).toEqual({});
		});

		it('ignores one trailing slash unless strict is set', function () {
			expect(helpers.matchPath('/users/:id', '/users/42/')).toEqual({ id: '42' });
			expect(helpers.matchPath('/users/:id/', '/users/42')).toEqual({ id: '42' });
			expect(helpers.matchPath('/users/:id/', '/users/42/')).toEqual({ id: '42' });
			expect(helpers.matchPath('/', '//')).toEqual({});
			expect(helpers.matchPath('/users/:id', '/users/42/', { strict: true })).toBeNull();
			expect(helpers.matchPath('/users/:id/', '/users/42', { strict: true })).toBeNull();
			expect(helpers.matchPath('/users/:id/', '/users/42/', { strict: true })).toEqual({ id: '42' });
			expect(helpers.matchPath('/', '//', { strict: true })).toBeNull();
			expect(helpers.matchPath('/', '/', { strict: true })).toEqual({});
			expect(helpers.matchPath('/:id?/', '/', { strict: true })).toEqual({});
			expect(helpers.matchPath('/:id?/', '/x', { strict: true })).toBeNull();
		});

		it('keeps the trailing slash in a splat in strict mode', function () {
			expect(helpers.matchPath('/files/*p', '/files/a/', { strict: true })).toEqual({ p: 'a/' });
			expect(helpers.matchPath('/files/*p', '/files/a/')).toEqual({ p: 'a' });
			expect(helpers.matchPath('/files/*p', '/files/', { strict: true })).toBeNull();
			expect(helpers.matchPath('/files/*p', '/files/a', { strict: true })).toEqual({ p: 'a' });
		});

		it('stores parameters named after Object.prototype members as own keys', function () {
			const params = helpers.matchPath('/:__proto__/:constructor/:toString', '/a/b/c') as Record<string, string>;
			expect(Object.keys(params)).toEqual(['__proto__', 'constructor', 'toString']);
			expect(params.__proto__).toBe('a');
			expect(Object.getPrototypeOf(params)).toBeNull();
			expect(({} as Record<string, unknown>).a).toBeUndefined();
		});

		it('reads the options once', function () {
			let reads = 0;
			const options = {
				get strict() {
					reads++;
					return true;
				}
			};
			expect(helpers.matchPath('/a', '/a', options)).toEqual({});
			expect(reads).toBe(1);
		});

		it('keeps matching correctly when more patterns than the cache holds are used', function () {
			for (let index = 0; index < 600; index++) expect(helpers.matchPath(`/p${index}/:x`, `/p${index}/v`)).toEqual({ x: 'v' });
			expect(helpers.matchPath('/p0/:x', '/p0/w')).toEqual({ x: 'w' });
			expect(helpers.matchPath('/p599/:x', '/p599/w')).toEqual({ x: 'w' });
		});

		it('runs in linear time on adversarial input', function () {
			const optional = Array.from({ length: 40 }, function (_value, index) {
				return `/:p${index}?`;
			}).join('');
			const start = Date.now();
			// Every optional parameter could take each segment: a backtracking matcher would try 2^40 combinations.
			expect(helpers.matchPath(`${optional}/end`, '/x'.repeat(40) + '/nope')).toBeNull();
			expect(helpers.matchPath(`${optional}/end`, '/x'.repeat(39) + '/end')).toEqual(
				Object.fromEntries(
					Array.from({ length: 39 }, function (_value, index) {
						return [`p${index}`, 'x'];
					})
				)
			);
			const long = '/a'.repeat(200_000);
			expect(helpers.matchPath('/a/*rest', long)).toEqual({ rest: long.slice(3) });
			expect(helpers.matchPath('/:a/:b', long)).toBeNull();
			expect(helpers.matchPath('/a/*rest', '/a/' + '%'.repeat(500_000))).toEqual({ rest: '%'.repeat(500_000) });
			expect(helpers.matchPath('/:a-', '/' + '-'.repeat(500_000))).toEqual({ a: '-'.repeat(499_999) });
			expect(Date.now() - start).toBeLessThan(2000);
		});

		it('rejects malformed patterns', function () {
			const cases: Array<[string, string]> = [
				['users', "must start with '/'"],
				['', "must start with '/'"],
				['/a//b', 'has an empty segment'],
				['//', 'has an empty segment'],
				['/a/?', 'has an empty segment'],
				['/a/*/b', 'must end with its splat'],
				['/a/*x/', 'must end with its splat'],
				['/a/b*', "can only have a '*' at the start of a segment"],
				['/:a*', "can only have a '*' at the start of a segment"],
				['/:', 'has a parameter without a valid name'],
				['/:1', 'has a parameter without a valid name'],
				['/a:-', 'has a parameter without a valid name'],
				['/:a:b', 'has two parameters in one segment'],
				['/:a/:a', 'has the parameter "a" twice'],
				['/:a/*a', 'has the parameter "a" twice'],
				['/a/./b', 'has a dot segment'],
				['/a/%2E%2E', 'has a dot segment'],
				['/a#b', "must not contain '#'"],
				['/a?b', "can only have a '?' at the end of a segment"],
				['/a??', "can only have a '?' at the end of a segment"],
				['/*1', 'has an invalid splat name "1"'],
				['/*a-b', 'has an invalid splat name "a-b"']
			];
			for (const [pattern, problem] of cases) {
				expect(function () {
					helpers.matchPath(pattern, '/');
				}).toThrow(new RangeError(`matchPath: \`pattern\` ${problem}, got ${JSON.stringify(pattern)}`));
			}
		});

		it('rejects arguments of the wrong type', function () {
			expect(function () {
				helpers.matchPath(1 as never, '/');
			}).toThrow(new TypeError('matchPath: `pattern` must be a string, got number'));
			expect(function () {
				helpers.matchPath('/', null as never);
			}).toThrow(new TypeError('matchPath: `pathname` must be a string, got null'));
		});

		it('types the parameters from the pattern', function () {
			const params = helpers.matchPath('/users/:id/posts/:postId?/*rest', '/users/1/posts/x');
			assertType<Equals<typeof params, { id: string; rest: string; postId?: string } | null>>(true);
			assertType<Equals<helpers.PathParams<'/@:handle/:file.json'>, { handle: string; file: string }>>(true);
			assertType<Equals<helpers.PathParams<'/*'>, { '*': string }>>(true);
			assertType<Equals<helpers.PathParams<'/files/*?'>, { '*'?: string }>>(true);
			assertType<Equals<keyof helpers.PathParams<'/about'>, never>>(true);
			assertType<Equals<helpers.PathParams<string>, Record<string, string | undefined>>>(true);
			assertType<Equals<helpers.PathParamsInput<'/:id'>, { id: string | number }>>(true);
			expect(params).toEqual({ id: '1', rest: 'x' });
		});
	});

	describe('compilePath', function () {
		it('builds pathnames, percent-encoding the parameters', function () {
			const build = helpers.compilePath('/users/:id/posts/:postId?');
			expect(build({ id: 42 })).toBe('/users/42/posts');
			expect(build({ id: 'a/b', postId: 'x y' })).toBe('/users/a%2Fb/posts/x%20y');
			expect(build({ id: '?#%&é', postId: undefined })).toBe('/users/%3F%23%25%26%C3%A9/posts');
			expect(build({ id: '\ud800' })).toBe('/users/%EF%BF%BD/posts');
			expect(build({ id: -0 })).toBe('/users/0/posts');
			expect(build({ id: 1e21 })).toBe('/users/1e%2B21/posts');
		});

		it('writes static text, optional or not, and the trailing slash as in the pattern', function () {
			expect(helpers.compilePath('/@:handle/:file.json')({ handle: 'ada', file: 'a b' })).toBe('/@ada/a%20b.json');
			expect(helpers.compilePath('/docs?/:x?/')({})).toBe('/docs/');
			expect(helpers.compilePath('/caf%C3%A9/café')()).toBe('/caf%C3%A9/café');
			expect(helpers.compilePath('/')()).toBe('/');
			expect(helpers.compilePath('/:a?')({})).toBe('/');
			expect(helpers.compilePath('/:a?/')()).toBe('/');
			expect(helpers.compilePath('/users/')()).toBe('/users/');
		});

		it('builds splats as sub-paths', function () {
			const build = helpers.compilePath('/files/*path');
			expect(build({ path: 'docs/read me.md' })).toBe('/files/docs/read%20me.md');
			expect(build({ path: 'a//b' })).toBe('/files/a//b');
			expect(build({ path: 'a%2Fb' })).toBe('/files/a%252Fb');
			expect(build({ path: 7 })).toBe('/files/7');
			expect(helpers.compilePath('/*')({ '*': 'x/y' })).toBe('/x/y');
			expect(helpers.compilePath('/files/*path?')({})).toBe('/files');
			expect(function () {
				build({ path: 'a/../b' });
			}).toThrow(new RangeError("compilePath: `params.path` must not make a dot segment ('.' or '..'), got \"..\""));
			expect(function () {
				build({ path: '' });
			}).toThrow(RangeError);
		});

		it('rejects missing, empty and dot-segment values', function () {
			const build = helpers.compilePath('/users/:id');
			expect(function () {
				build({} as never);
			}).toThrow(new TypeError('compilePath: `params.id` must be a string or a number, got undefined'));
			expect(function () {
				(build as (params?: object) => string)();
			}).toThrow(new TypeError('compilePath: `params.id` must be a string or a number, got undefined'));
			expect(function () {
				build({ id: null } as never);
			}).toThrow(new TypeError('compilePath: `params.id` must be a string or a number, got null'));
			expect(function () {
				build({ id: true } as never);
			}).toThrow(new TypeError('compilePath: `params.id` must be a string or a number, got boolean'));
			expect(function () {
				build({ id: '' });
			}).toThrow(new RangeError('compilePath: `params.id` must be a non-empty string or a finite number, got ""'));
			expect(function () {
				build({ id: NaN });
			}).toThrow(new RangeError('compilePath: `params.id` must be a non-empty string or a finite number, got "NaN"'));
			expect(function () {
				build({ id: -Infinity });
			}).toThrow(RangeError);
			expect(function () {
				build({ id: '.' });
			}).toThrow(new RangeError("compilePath: `params.id` must not make a dot segment ('.' or '..'), got \".\""));
			expect(function () {
				helpers.compilePath('/:x?')({ x: '' });
			}).toThrow(RangeError);
			expect(build({ id: '...' })).toBe('/users/...');
			// The whole segment counts: static text around the value can make (or prevent) a dot segment.
			expect(helpers.compilePath('/:x-')({ x: '.' })).toBe('/.-');
			expect(function () {
				helpers.compilePath('/.:x')({ x: '.' });
			}).toThrow(new RangeError("compilePath: `params.x` must not make a dot segment ('.' or '..'), got \".\""));
		});

		it('reads own parameters only and ignores unknown keys', function () {
			expect(function () {
				helpers.compilePath('/:constructor')({} as never);
			}).toThrow(new TypeError('compilePath: `params.constructor` must be a string or a number, got undefined'));
			const inherited = Object.create({ id: 'x' }) as { id: string };
			expect(function () {
				helpers.compilePath('/:id')(inherited);
			}).toThrow(TypeError);
			expect(helpers.compilePath('/:__proto__')(JSON.parse('{"__proto__":"p"}'))).toBe('/p');
			expect(helpers.compilePath('/:id')({ id: 1, extra: 2 } as never)).toBe('/1');
		});

		it('rejects params that are not an object', function () {
			expect(function () {
				helpers.compilePath('/a')(null as never);
			}).toThrow(new TypeError('compilePath: `params` must be an object, got null'));
			expect(function () {
				helpers.compilePath('/a')('x' as never);
			}).toThrow(new TypeError('compilePath: `params` must be an object, got string'));
		});

		it('rejects malformed patterns at once', function () {
			expect(function () {
				helpers.compilePath('/a//b');
			}).toThrow(new RangeError('compilePath: `pattern` has an empty segment, got "/a//b"'));
			expect(function () {
				helpers.compilePath(null as never);
			}).toThrow(new TypeError('compilePath: `pattern` must be a string, got null'));
		});

		it('builds pathnames that match back to the same parameters', function () {
			const pattern = '/@:user/:lang?/files/*path';
			const params = { user: 'a/b c', path: 'x/é y/z' };
			expect(helpers.matchPath(pattern, helpers.compilePath(pattern)(params))).toEqual(params);
		});

		it('types the builder from the pattern', function () {
			const build = helpers.compilePath('/users/:id/:tab?');
			assertType<Equals<Parameters<typeof build>, [params: { id: string | number; tab?: string | number }]>>(true);
			const about = helpers.compilePath('/about');
			expect(function () {
				// @ts-expect-error `id` is required
				build({ tab: 'x' });
			}).toThrow(TypeError);
			expect(function () {
				// @ts-expect-error the parameters are required
				build();
			}).toThrow(TypeError);
			expect(about()).toBe('/about');
		});
	});
});

describe('route patterns (review regressions)', function () {
	it('never matches traversal hidden behind encoded separators', function () {
		expect(helpers.matchPath('/files/:name', '/files/..%2F..%2Fetc%2Fpasswd')).toBeNull();
		expect(helpers.matchPath('/files/*path', '/files/a%2F..%2F..%2Fetc')).toBeNull();
		expect(helpers.matchPath('/files/:name', '/files/..%5C..%5Cwin.ini')).toBeNull();
		expect(helpers.matchPath('/files/:name', '/files/a%2F.')).toBeNull();
		expect(helpers.matchPath('/files/:name', '/files/a\\..\\b')).toBeNull();
		// Legitimate encoded slashes (which compilePath writes) still match.
		expect(helpers.matchPath('/users/:id', '/users/a%2Fb')).toEqual({ id: 'a/b' });
		expect(helpers.matchPath('/users/:id', '/users/a%2F.b%2F...')).toEqual({ id: 'a/.b/...' });
		expect(helpers.matchPath('/users/:id', '/users/%2Fx')).toEqual({ id: '/x' });
	});

	it('never gives a splat a leading separator (an absolute path)', function () {
		expect(helpers.matchPath('/files/*path', '/files//etc/passwd')).toBeNull();
		expect(helpers.matchPath('/files/*path', '/files/%2Fetc/passwd')).toBeNull();
		expect(helpers.matchPath('/files/*path', '/files/%5Cetc')).toBeNull();
		expect(helpers.matchPath('/files/*path', '/files///')).toBeNull();
		expect(helpers.matchPath('/files/*path?', '/files//x')).toBeNull();
		expect(helpers.matchPath('/files/*path', '/files/a//b')).toEqual({ path: 'a//b' });
	});

	it('refuses to build what matchPath would refuse', function () {
		expect(function () {
			helpers.compilePath('/files/:name')({ name: '../etc' });
		}).toThrow(new RangeError("compilePath: `params.name` must not make a dot segment ('.' or '..'), got \"../etc\""));
		expect(function () {
			helpers.compilePath('/files/:name')({ name: 'a\\..' });
		}).toThrow(RangeError);
		expect(function () {
			helpers.compilePath('/files/*path')({ path: '/etc' });
		}).toThrow(new RangeError('compilePath: `params.path` must not start with a separator, got "/etc"'));
		expect(function () {
			helpers.compilePath('/files/*path')({ path: '\\etc' });
		}).toThrow(RangeError);
		expect(helpers.compilePath('/users/:id')({ id: '/x' })).toBe('/users/%2Fx');
		expect(function () {
			helpers.matchPath('/a%2F..', '/');
		}).toThrow(new RangeError('matchPath: `pattern` has a dot segment, got "/a%2F.."'));
	});

	it('folds the case of ASCII letters only', function () {
		expect(helpers.matchPath('/admin', '/admın')).toBeNull();
		expect(helpers.matchPath('/settings', '/ſettings')).toBeNull();
		expect(helpers.matchPath('/K:x', '/Ky')).toBeNull();
		expect(helpers.matchPath('/x-:id-s', '/x-1-ſ')).toBeNull();
		expect(helpers.matchPath('/ADMIN/:x', '/admin/Y')).toEqual({ x: 'Y' });
		expect(helpers.matchPath('/café', '/CAFé')).toEqual({});
		expect(helpers.matchPath('/café', '/CAFÉ')).toBeNull();
	});

	it('refuses to build a pathname that would match back to other parameters', function () {
		expect(function () {
			helpers.compilePath('/:a?/:b?')({ b: 'x' });
		}).toThrow(new RangeError('compilePath: `params` must match back to themselves, but "/:a?/:b?" reads "/x" as {"a":"x"}'));
		expect(function () {
			helpers.compilePath('/:a?/docs?')({});
		}).toThrow(RangeError);
		expect(function () {
			helpers.compilePath('/:a?/Docs')({ a: 'DOCS' });
		}).not.toThrow();
		expect(helpers.compilePath('/:a?/:b?')({ a: 'x' })).toBe('/x');
		expect(helpers.compilePath('/:a?/:b?')({ a: 'x', b: 'y' })).toBe('/x/y');
		expect(helpers.compilePath('/:a?/docs?')({ a: 'x' })).toBe('/x/docs');
		// Static text that decodes together with the encoded value.
		expect(function () {
			helpers.compilePath('/%:x')({ x: '41' });
		}).toThrow(new RangeError('compilePath: `params` must match back to themselves, but "/%:x" reads "/%41" as null'));
		expect(helpers.compilePath('/%:x')({ x: 'z' })).toBe('/%z');
	});

	it('reads own options only, and checks them', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.strict = true;
		proto.caseSensitive = true;
		try {
			expect(helpers.matchPath('/A', '/a/')).toEqual({});
		} finally {
			delete proto.strict;
			delete proto.caseSensitive;
		}
		expect(function () {
			helpers.matchPath('/a', '/a', null as never);
		}).toThrow(new TypeError('matchPath: `options` must be an object, got null'));
		expect(function () {
			helpers.matchPath('/a', '/a', 'strict' as never);
		}).toThrow(new TypeError('matchPath: `options` must be an object, got string'));
	});

	it('bounds the number of pattern segments', function () {
		const huge = '/a'.repeat(20_000);
		expect(function () {
			helpers.matchPath(huge, huge);
		}).toThrow(new RangeError(`matchPath: \`pattern\` must have at most 256 segments, got ${JSON.stringify(huge)}`));
		const largest = Array.from({ length: 256 }, function (_value, index) {
			return `/:p${index}?`;
		}).join('');
		expect(helpers.matchPath(largest, '/x')).toEqual({ p0: 'x' });
		expect(function () {
			helpers.matchPath(largest + '/x', '/x');
		}).toThrow(RangeError);
	});

	it('keeps the most recently used patterns in its cache', function () {
		for (let index = 0; index < 500; index++) helpers.matchPath(`/lru${index}/:x`, '/x');
		helpers.matchPath('/lru0/:x', '/x');
		const remove = jest.spyOn(Map.prototype, 'delete');
		try {
			helpers.matchPath('/lru500/:x', '/x');
			expect(remove).toHaveBeenCalledWith('/lru1/:x');
			expect(remove).not.toHaveBeenCalledWith('/lru0/:x');
		} finally {
			remove.mockRestore();
		}
	});

	it('types union and template patterns', function () {
		const pattern = '/a/:x' as '/a/:x' | '/b/:y';
		const params = helpers.matchPath(pattern, '/a/1');
		assertType<Equals<typeof params, { x: string } | { y: string } | null>>(true);
		expect(helpers.compilePath(pattern)({ x: 1 })).toBe('/a/1');
		assertType<Equals<helpers.PathParams<`/users/${string}`>, Record<string, string | undefined>>>(true);
		assertType<Equals<helpers.PathParams<'/:a-:b'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/:1abc'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/:'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/*1'>, never>>(true);
		assertType<Equals<helpers.PathParams<'users/:id'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/a?b/:id'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/a*/:id'>, never>>(true);
		assertType<Equals<helpers.PathParams<'/:a_1$/:b?'>, { a_1$: string; b?: string }>>(true);
	});

	it('types every malformed pattern the runtime rejects as never', function () {
		const rejected = ['/:id/:id', '/:id/*id', '/*p/x', '/*p/', '/a//b', '//', '//a', '/a//', '/a/?', '/a#b', '/..', '/a/.?', '/%2E%2e'] as const;
		for (const pattern of rejected) {
			expect(function () {
				helpers.matchPath(pattern as string, '/');
			}).toThrow(RangeError);
		}
		assertType<Equals<helpers.PathParams<(typeof rejected)[number]>, never>>(true);
		assertType<Equals<helpers.PathParams<'/:a?/'>, { a?: string }>>(true);
		assertType<Equals<helpers.PathParams<'/.well-known/:a/:ab/*b'>, { a: string; ab: string; b: string }>>(true);
		assertType<Equals<helpers.PathParamsInput<'/about'>, Readonly<Record<string, never>>>>(true);
		assertType<Equals<helpers.PathParamsInput<'/a/:x' | '/about'>, { x: string | number } | Readonly<Record<string, never>>>>(true);
		// A builder without required parameters fits a route table of builders with optional ones.
		const routes = { home: helpers.compilePath('/'), about: helpers.compilePath('/about'), docs: helpers.compilePath('/docs/:page?') } satisfies Record<
			string,
			(params?: Record<string, string>) => string
		>;
		const any: helpers.PathBuilder<string> = routes.about;
		expect([routes.home(), routes.about({}), routes.docs({ page: 'x' }), any()]).toEqual(['/', '/about', '/docs/x', '/about']);
		expect(function () {
			// @ts-expect-error a primitive is still rejected by a direct call
			routes.about(42);
		}).toThrow(TypeError);
		// Long patterns stay within the compiler's recursion limits.
		type LongP = '/:p1/:p2/:p3/:p4/:p5/:p6/:p7/:p8/:p9/:p10/:p11/:p12/:p13/:p14/:p15/:p16/:p17/:p18/:p19/:p20/:p21/:p22/:p23/:p24/:p25/:p26/:p27/:p28/:p29/:p30';
		type LongQ = '/:q1/:q2/:q3/:q4/:q5/:q6/:q7/:q8/:q9/:q10/:q11/:q12/:q13/:q14/:q15/:q16/:q17/:q18/:q19/:q20/:q21/:q22/:q23/:q24/:q25/:q26/:q27/:q28/:q29/:q30';
		type LongR = '/:r1/:r2/:r3/:r4/:r5/:r6/:r7/:r8/:r9/:r10/:r11/:r12/:r13/:r14/:r15/:r16/:r17/:r18/:r19/:r20/:r21/:r22/:r23/:r24/:r25/:r26/:r27/:r28/:r29/:r30';
		assertType<Equals<helpers.PathParams<`${LongP}${LongQ}${LongR}`>['p1' | 'q15' | 'r30'], string>>(true);
		assertType<Equals<helpers.PathParams<`${LongP}${LongQ}${LongP}`>, never>>(true);
	});

	it('reads only the own properties of the query and safe-URL options', function () {
		const proto = Object.prototype as unknown as Record<string, unknown>;
		let results: unknown[];
		proto.arrayFormat = 'comma';
		proto.skipNull = false;
		proto.sort = true;
		proto.protocols = ['javascript:'];
		proto.allowRelative = false;
		try {
			results = [
				helpers.buildQueryString({ b: [1, 2], a: null }),
				helpers.withQuery('/x', { b: [1, 2], a: null }),
				helpers.isSafeUrl('javascript:alert(1)'),
				helpers.isSafeUrl('https://example.com'),
				helpers.isSafeUrl('/relative'),
				helpers.sanitizeUrl('javascript:alert(1)')
			];
		} finally {
			delete proto.arrayFormat;
			delete proto.skipNull;
			delete proto.sort;
			delete proto.protocols;
			delete proto.allowRelative;
		}
		expect(results).toEqual(['b=1&b=2', '/x?b=1&b=2', false, true, true, 'about:blank']);
		// Own options still apply, getters included (read once).
		let reads = 0;
		const options = {
			get arrayFormat(): 'brackets' {
				reads++;
				return 'brackets';
			}
		};
		expect(helpers.buildQueryString({ a: [1] }, options)).toBe('a[]=1');
		expect(reads).toBe(1);
		expect(helpers.isSafeUrl('ftp://x', Object.assign(Object.create(null) as object, { protocols: ['ftp:'] }))).toBe(true);
		// withQuery reports its own name.
		expect(function () {
			helpers.withQuery('/x', { a: 1 }, null as never);
		}).toThrow(new TypeError('withQuery: `options` must be an object, got null'));
		expect(function () {
			helpers.withQuery('/x', { a: 1 }, { arrayFormat: 'x' as never });
		}).toThrow(new RangeError("withQuery: `arrayFormat` must be 'repeat', 'comma' or 'brackets', got x"));
		expect(function () {
			helpers.withQuery('/x', { a: [new Date(NaN)] });
		}).toThrow(new RangeError('withQuery: `params.a` must be a valid Date, got Invalid Date'));
		expect(function () {
			helpers.withQuery('/x', { a: {} as never });
		}).toThrow(new TypeError('withQuery: `params.a` must be a string, number, boolean, bigint or Date, got object'));
		for (const bad of [null, 'comma']) {
			expect(function () {
				helpers.buildQueryString({ a: 1 }, bad as never);
			}).toThrow(new TypeError(`buildQueryString: \`options\` must be an object, got ${bad === null ? 'null' : 'string'}`));
			expect(function () {
				helpers.isSafeUrl('https://x', bad as never);
			}).toThrow(new TypeError(`isSafeUrl: \`options\` must be an object, got ${bad === null ? 'null' : 'string'}`));
		}
	});
});

describe('parseCookie', function () {
	it('should read name-value pairs, trimming spaces and tabs', function () {
		expect(helpers.parseCookie('a=1; b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
		expect(helpers.parseCookie(' \ta = 1 \t;\tb=\t')).toEqual({ a: '1', b: '' });
		expect(helpers.parseCookie('a=\u00a01')).toEqual({ a: '\u00a01' });
		expect(helpers.parseCookie('a=b=c')).toEqual({ a: 'b=c' });
		expect(helpers.parseCookie('=x; y=')).toEqual({ '': 'x', y: '' });
		expect(helpers.parseCookie('')).toEqual({});
	});

	it('should keep the first occurrence of a name', function () {
		expect(helpers.parseCookie('a=1; a=2; b=3; a=4')).toEqual({ a: '1', b: '3' });
		expect(helpers.parseCookie('a=%ZZ; a=2')).toEqual({ a: '%ZZ' });
	});

	it('should remove surrounding double quotes only when both are there', function () {
		expect(helpers.parseCookie('a="x y"; b=""; c="; d=x"; e="x')).toEqual({ a: 'x y', b: '', c: '"', d: 'x"', e: '"x' });
	});

	it('should decode values without ever throwing, and leave + alone', function () {
		expect(helpers.parseCookie('a=caf%C3%A9; b=100%; c=%E9t%C3%A9; d=a+b; e%20f=1')).toEqual({ a: 'café', b: '100%', c: '%E9té', d: 'a+b', 'e%20f': '1' });
	});

	it('should skip malformed pairs', function () {
		expect(helpers.parseCookie('a; b=1;; c ;d=2')).toEqual({ b: '1', d: '2' });
		expect(helpers.parseCookie('a;b;c')).toEqual({});
		expect(helpers.parseCookie('a=1;b')).toEqual({ a: '1' });
	});

	it('should return a null-prototype record, safe from hostile names', function () {
		const cookies = helpers.parseCookie('__proto__=x; constructor=y; toString=z');
		expect(Object.getPrototypeOf(cookies)).toBeNull();
		expect(Object.keys(cookies)).toEqual(['__proto__', 'constructor', 'toString']);
		expect(cookies['__proto__']).toBe('x');
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});

	it('should run in linear time on hostile headers', function () {
		expect(helpers.parseCookie('a;'.repeat(200_000) + 'b=1')).toEqual({ b: '1' });
		expect(Object.keys(helpers.parseCookie('a=1;'.repeat(200_000))).length).toBe(1);
	});

	it('should reject anything but a string', function () {
		expect(function () {
			helpers.parseCookie(undefined as never);
		}).toThrow(new TypeError('parseCookie: `header` must be a string, got undefined'));
	});
});

describe('serializeCookie', function () {
	it('should encode the value with encodeURIComponent', function () {
		expect(helpers.serializeCookie('a', 'b')).toBe('a=b');
		expect(helpers.serializeCookie('a', '')).toBe('a=');
		expect(helpers.serializeCookie('a', 'x y;z,"é\\')).toBe('a=x%20y%3Bz%2C%22%C3%A9%5C');
		expect(helpers.serializeCookie('a', '\ud800')).toBe('a=%EF%BF%BD');
		expect(helpers.parseCookie(helpers.serializeCookie('a', 'x y;z,"é\\'))).toEqual({ a: 'x y;z,"é\\' });
	});

	it('should write every attribute, in the cookie package order', function () {
		expect(
			helpers.serializeCookie('a', 'b', {
				sameSite: 'none',
				priority: 'medium',
				partitioned: true,
				secure: true,
				httpOnly: true,
				expires: new Date(0),
				path: '/',
				domain: '.example.com',
				maxAge: 0
			})
		).toBe('a=b; Max-Age=0; Domain=.example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; Partitioned; Priority=Medium; SameSite=None');
		expect(helpers.serializeCookie('a', 'b', { sameSite: 'strict', priority: 'low', maxAge: -1 })).toBe('a=b; Max-Age=-1; Priority=Low; SameSite=Strict');
		expect(helpers.serializeCookie('a', 'b', { priority: 'high', sameSite: 'lax', secure: false, httpOnly: false })).toBe('a=b; Priority=High; SameSite=Lax');
		expect(helpers.serializeCookie('a', 'b', { expires: vm.runInNewContext('new Date(86400000)') as Date })).toBe('a=b; Expires=Fri, 02 Jan 1970 00:00:00 GMT');
	});

	it('should accept RFC 6265 names, domains and paths', function () {
		expect(helpers.serializeCookie("!#$%&'*+-.^_`|~09AZaz", 'x')).toBe("!#$%&'*+-.^_`|~09AZaz=x");
		for (const domain of ['localhost', 'example.com', '.sub.ex-ample.co.uk', '127.0.0.1', 'A1.B2', `${'a'.repeat(63)}.com`]) {
			expect(helpers.serializeCookie('a', 'b', { domain })).toBe(`a=b; Domain=${domain}`);
		}
		for (const path of ['', '/', '/a b/c=d?e#f', '/~!']) expect(helpers.serializeCookie('a', 'b', { path })).toBe(`a=b; Path=${path}`);
	});

	it('should reject names, values, domains and paths that would break the header', function () {
		for (const name of ['', 'a b', 'a;b', 'a=b', 'a,b', 'a"b', 'a\r\nb', 'é', 'a(b', 'a/b', 'a@b', 'a\tb']) {
			expect(function () {
				helpers.serializeCookie(name, 'x');
			}).toThrow(new TypeError(`serializeCookie: \`name\` must be a cookie name (letters, digits and !#$%&'*+-.^_\`|~), got ${JSON.stringify(name)}`));
		}
		expect(function () {
			helpers.serializeCookie(1 as never, 'x');
		}).toThrow(new TypeError("serializeCookie: `name` must be a cookie name (letters, digits and !#$%&'*+-.^_`|~), got number"));
		for (const domain of ['', 'exa mple.com', 'a;b', '-a.com', 'a-.com', 'a..com', 'a.com.', '..a', `${'a'.repeat(64)}.com`, 'a.com\r\nX: y', 'é.com']) {
			expect(function () {
				helpers.serializeCookie('a', 'b', { domain });
			}).toThrow(new TypeError(`serializeCookie: \`domain\` must be a host name (ASCII letters, digits, hyphens and dots), got ${JSON.stringify(domain)}`));
		}
		expect(function () {
			helpers.serializeCookie('a', 'b', { domain: null as never });
		}).toThrow(new TypeError('serializeCookie: `domain` must be a host name (ASCII letters, digits, hyphens and dots), got null'));
		for (const path of ['/a;b', '/\r\nSet-Cookie: x=1', '/\x7f', '/é', '/\0']) {
			expect(function () {
				helpers.serializeCookie('a', 'b', { path });
			}).toThrow(new TypeError(`serializeCookie: \`path\` must be printable ASCII without ';', got ${JSON.stringify(path)}`));
		}
		expect(function () {
			helpers.serializeCookie('a', 'b', { path: 1 as never });
		}).toThrow(new TypeError("serializeCookie: `path` must be printable ASCII without ';', got number"));
		expect(function () {
			helpers.serializeCookie('a', 1 as never);
		}).toThrow(new TypeError('serializeCookie: `value` must be a string, got number'));
	});

	it('should use a custom encoder, and check what it returns', function () {
		function raw(value: string): string {
			return value;
		}
		expect(helpers.serializeCookie('a', '"b"', { encode: raw })).toBe('a="b"');
		expect(helpers.serializeCookie('a', '{x:1}', { encode: raw })).toBe('a={x:1}');
		const expected = "a cookie value once encoded (printable ASCII except spaces and '\"', ',', ';' or '\\')";
		for (const value of ['a b', 'a;b', 'a,b', 'a\\b', '"a', 'a"b', '"a"b"', 'é', '\r\n']) {
			expect(function () {
				helpers.serializeCookie('a', value, { encode: raw });
			}).toThrow(new TypeError(`serializeCookie: \`value\` must be ${expected}, got ${JSON.stringify(value)}`));
		}
		expect(function () {
			helpers.serializeCookie('a', 'b', {
				encode: function () {
					return 1 as never;
				}
			});
		}).toThrow(new TypeError(`serializeCookie: \`value\` must be ${expected}, got number`));
		expect(function () {
			helpers.serializeCookie('a', 'b', { encode: 'raw' as never });
		}).toThrow(new TypeError('serializeCookie: `encode` must be a function, got string'));
	});

	it('should validate the other options', function () {
		expect(function () {
			helpers.serializeCookie('a', 'b', { maxAge: 1.5 });
		}).toThrow(new RangeError('serializeCookie: `maxAge` must be an integer (seconds), got 1.5'));
		expect(function () {
			helpers.serializeCookie('a', 'b', { maxAge: 2 ** 53 });
		}).toThrow(RangeError);
		expect(function () {
			helpers.serializeCookie('a', 'b', { maxAge: '60' as never });
		}).toThrow(new TypeError('serializeCookie: `maxAge` must be an integer (seconds), got string'));
		expect(function () {
			helpers.serializeCookie('a', 'b', { expires: new Date(NaN) });
		}).toThrow(new RangeError('serializeCookie: `expires` must be a valid Date, got Invalid Date'));
		expect(function () {
			helpers.serializeCookie('a', 'b', { expires: 0 as never });
		}).toThrow(new TypeError('serializeCookie: `expires` must be a Date, got number'));
		expect(function () {
			helpers.serializeCookie('a', 'b', { sameSite: 'Strict' as never });
		}).toThrow(new RangeError("serializeCookie: `sameSite` must be 'strict', 'lax' or 'none', got Strict"));
		expect(function () {
			helpers.serializeCookie('a', 'b', { sameSite: true as never });
		}).toThrow(new RangeError("serializeCookie: `sameSite` must be 'strict', 'lax' or 'none', got true"));
		expect(function () {
			helpers.serializeCookie('a', 'b', { priority: 'urgent' as never });
		}).toThrow(new RangeError("serializeCookie: `priority` must be 'low', 'medium' or 'high', got urgent"));
		for (const key of ['secure', 'httpOnly', 'partitioned'] as const) {
			expect(function () {
				helpers.serializeCookie('a', 'b', { [key]: 'yes' });
			}).toThrow(new TypeError(`serializeCookie: \`${key}\` must be a boolean, got string`));
		}
		expect(function () {
			helpers.serializeCookie('a', 'b', null as never);
		}).toThrow(new TypeError('serializeCookie: `options` must be an object, got null'));
	});

	it('should reject the combinations that browsers drop', function () {
		expect(function () {
			helpers.serializeCookie('a', 'b', { sameSite: 'none' });
		}).toThrow(new RangeError("serializeCookie: `secure` must be true when `sameSite` is 'none' (browsers reject the cookie otherwise)"));
		expect(function () {
			helpers.serializeCookie('a', 'b', { partitioned: true });
		}).toThrow(new RangeError('serializeCookie: `secure` must be true when `partitioned` is set (browsers reject the cookie otherwise)'));
		for (const name of ['__Secure-id', '__secure-id', '__Host-id', '__HOST-id']) {
			expect(function () {
				helpers.serializeCookie(name, 'b', { path: '/' });
			}).toThrow(new RangeError(`serializeCookie: \`secure\` must be true when the name starts with "${name.slice(0, -2)}" (browsers reject the cookie otherwise)`));
		}
		expect(helpers.serializeCookie('__Secure-id', 'b', { secure: true, domain: 'example.com' })).toBe('__Secure-id=b; Domain=example.com; Secure');
		expect(helpers.serializeCookie('__Host-id', 'b', { secure: true, path: '/' })).toBe('__Host-id=b; Path=/; Secure');
		for (const options of [{ secure: true }, { secure: true, path: '/a' }, { secure: true, path: '/', domain: 'example.com' }]) {
			expect(function () {
				helpers.serializeCookie('__Host-id', 'b', options);
			}).toThrow(new RangeError(`serializeCookie: a "__Host-" cookie must have \`path: '/'\` and no \`domain\` (browsers reject it otherwise)`));
		}
		expect(helpers.serializeCookie('__Hostess', 'b')).toBe('__Hostess=b');
		expect(helpers.serializeCookie('__Secure_id', 'b')).toBe('__Secure_id=b');
	});

	it('should ignore options inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.domain = 'evil.example';
		proto.encode = function (value: string): string {
			return value;
		};
		proto.secure = 'yes';
		try {
			expect(helpers.serializeCookie('a', 'b c', {})).toBe('a=b%20c');
		} finally {
			delete proto.domain;
			delete proto.encode;
			delete proto.secure;
		}
	});
});

describe('normalizeUrl', function () {
	it('should make the changes that keep the meaning', function () {
		expect(helpers.normalizeUrl('HTTP://User@Example.COM:80/a/./b/../c?q=%7e%2f#%7e')).toBe('http://User@example.com/a/c?q=~%2F#~');
		expect(helpers.normalizeUrl('https://example.com:443')).toBe('https://example.com/');
		expect(helpers.normalizeUrl('https://example.com:8443/')).toBe('https://example.com:8443/');
		expect(helpers.normalizeUrl('http://münchen.de/ä')).toBe('http://xn--mnchen-3ya.de/%C3%A4');
		expect(helpers.normalizeUrl('http://x/%7euser/%2fa%2F/%c3%a9/%41%2D%5F%2E%30/%2e%2E/z')).toBe('http://x/~user/%2Fa%2F/%C3%A9/z');
		expect(helpers.normalizeUrl('http://x/a%2e/%zz')).toBe('http://x/a./%zz');
		expect(helpers.normalizeUrl('http://%75ser:p%61ss@x/')).toBe('http://user:pass@x/');
		expect(helpers.normalizeUrl('http://x/?#')).toBe('http://x/');
		expect(helpers.normalizeUrl('http://x/path/?a=1&a=1')).toBe('http://x/path/?a=1&a=1');
		expect(helpers.normalizeUrl('FOO://%41B.Com:80/%7e/x/?#')).toBe('foo://ab.com:80/~/x/');
		expect(helpers.normalizeUrl('mailto:Someone@Example.com?subject=%7e')).toBe('mailto:Someone@Example.com?subject=~');
		expect(helpers.normalizeUrl(new URL('HTTP://X'))).toBe('http://x/');
	});

	it('should strip the hash and www., force https, and remove trailing slashes on demand', function () {
		expect(helpers.normalizeUrl('http://x/a#b', { stripHash: true })).toBe('http://x/a');
		expect(helpers.normalizeUrl('http://www.example.com/', { stripWww: true })).toBe('http://example.com/');
		for (const kept of ['http://www.com/', 'http://www.www.example.com/', 'http://wwwx.example.com/', 'http://a.www.example.com/']) {
			expect(helpers.normalizeUrl(kept, { stripWww: true })).toBe(kept);
		}
		expect(helpers.normalizeUrl('http://x:443/', { forceHttps: true })).toBe('https://x/');
		expect(helpers.normalizeUrl('http://x:8080/', { forceHttps: true })).toBe('https://x:8080/');
		expect(helpers.normalizeUrl('ws://x/', { forceHttps: true })).toBe('ws://x/');
		expect(helpers.normalizeUrl('http://x/a//?q#h', { removeTrailingSlash: true })).toBe('http://x/a?q#h');
		expect(helpers.normalizeUrl('http://x//', { removeTrailingSlash: true })).toBe('http://x/');
		expect(helpers.normalizeUrl('http://x/', { removeTrailingSlash: true })).toBe('http://x/');
		expect(helpers.normalizeUrl('foo://x/a/', { removeTrailingSlash: true })).toBe('foo://x/a');
		expect(helpers.normalizeUrl('mailto:a/', { removeTrailingSlash: true })).toBe('mailto:a/');
		expect(helpers.normalizeUrl('http://x/a/')).toBe('http://x/a/');
	});

	it('should sort and filter query parameters on demand', function () {
		expect(helpers.normalizeUrl('http://x/?b=2&a=1&c&a=0', { sortQuery: true })).toBe('http://x/?a=1&a=0&b=2&c=');
		expect(helpers.normalizeUrl('http://x/?q=a%20b~', { sortQuery: true })).toBe('http://x/?q=a+b~');
		expect(helpers.normalizeUrl('http://x/?', { sortQuery: true })).toBe('http://x/');
		const removeQueryParams = ['ref', /^utm_/i, /x/g];
		expect(helpers.normalizeUrl('http://x/?utm_source=a&UTM_medium=b&ref=c&reference=d&q=1&ax=2', { removeQueryParams })).toBe('http://x/?reference=d&q=1');
		expect((removeQueryParams[2] as RegExp).lastIndex).toBe(0);
		expect(helpers.normalizeUrl('http://x/?utm_source=a#h', { removeQueryParams })).toBe('http://x/#h');
		expect(helpers.normalizeUrl('http://x/?q=a%20b', { removeQueryParams: ['z'] })).toBe('http://x/?q=a%20b');
		expect(helpers.normalizeUrl('http://x/?q=1', { removeQueryParams: [vm.runInNewContext('/q/') as RegExp] })).toBe('http://x/');
	});

	it('should be idempotent', function () {
		const options = { stripHash: true, stripWww: true, sortQuery: true, removeTrailingSlash: true, removeQueryParams: [/^utm_/], forceHttps: true };
		for (const url of ['HTTP://WWW.www.Example.com:80/a/%7e//?utm_x=1&b=%7e&a', 'foo://%41/%2e/', 'http://x/a/..%2F', 'file:///C:/a/../b/']) {
			for (const opts of [{}, options]) {
				const once = helpers.normalizeUrl(url, opts);
				expect(helpers.normalizeUrl(once, opts)).toBe(once);
			}
		}
	});

	it('tryParseUrl returns undefined for a URL the runtime cannot parse back, and keeps every other punycode host', function () {
		const url = helpers.tryParseUrl('http://éxn--a/');
		// Runtimes that read the serialization back are not affected.
		if (url !== undefined) expect(URL.canParse(url.href)).toBe(true);
		expect(helpers.tryParseUrl('http://münchen.de/')?.hostname).toBe('xn--mnchen-3ya.de');
		expect(helpers.tryParseUrl('http://xn--mnchen-3ya.de/')?.href).toBe('http://xn--mnchen-3ya.de/');
	});

	it('should not abort the process on a URL that the runtime cannot parse back', function () {
		// Node 26 parses these to `http://xn--xn--a-9ra/`, which it then rejects, and aborts on the first setter called on them: they are
		// rejected as invalid there. Runtimes that read the serialization back normalize it.
		for (const url of ['http://éxn--a/', 'https://www.éxn--a.com/?b=1#h']) {
			for (const options of [{}, { stripWww: true, forceHttps: true, sortQuery: true }]) {
				const reparsed = helpers.tryParseUrl(helpers.tryParseUrl(url)?.href ?? '');
				if (reparsed === undefined) {
					expect(function () {
						helpers.normalizeUrl(url, options);
					}).toThrow(new TypeError(`normalizeUrl: \`url\` must be an absolute URL, got ${JSON.stringify(url)}`));
				} else {
					expect(helpers.normalizeUrl(url, options)).toMatch(/^https?:\/\/xn--xn--a-9ra(?:\.com)?\//);
				}
			}
		}
	});

	it('should reject relative or invalid URLs and invalid options', function () {
		for (const url of ['/relative', 'example.com', 'http://exa mple.com', '']) {
			expect(function () {
				helpers.normalizeUrl(url);
			}).toThrow(new TypeError(`normalizeUrl: \`url\` must be an absolute URL, got ${JSON.stringify(url)}`));
		}
		expect(function () {
			helpers.normalizeUrl(1 as never);
		}).toThrow(new TypeError('normalizeUrl: `url` must be a string or a URL, got number'));
		expect(function () {
			helpers.normalizeUrl('http://x/', 'strip' as never);
		}).toThrow(new TypeError('normalizeUrl: `options` must be an object, got string'));
		for (const key of ['stripHash', 'stripWww', 'sortQuery', 'removeTrailingSlash', 'forceHttps']) {
			expect(function () {
				helpers.normalizeUrl('http://x/', { [key]: 1 });
			}).toThrow(new TypeError(`normalizeUrl: \`${key}\` must be a boolean, got number`));
		}
		for (const removeQueryParams of ['utm', ['a', 1], [null]]) {
			expect(function () {
				helpers.normalizeUrl('http://x/', { removeQueryParams: removeQueryParams as never });
			}).toThrow(
				new TypeError(
					`normalizeUrl: \`removeQueryParams\` must be an array of strings and regular expressions, got ${typeof removeQueryParams === 'string' ? 'string' : 'object'}`
				)
			);
		}
	});
});

describe('tryParseUrl', function () {
	it('should parse like new URL, returning undefined instead of throwing, with or without URL.parse', function () {
		const native = Object.getOwnPropertyDescriptor(URL, 'parse');
		try {
			for (const withParse of [true, false]) {
				if (!withParse) delete (URL as { parse?: unknown }).parse;
				expect(helpers.tryParseUrl('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1');
				expect(helpers.tryParseUrl('../c', 'https://example.com/a/b')?.href).toBe('https://example.com/c');
				expect(helpers.tryParseUrl('c', new URL('https://example.com/a/'))?.href).toBe('https://example.com/a/c');
				const url = new URL('https://example.com/');
				const copy = helpers.tryParseUrl(url);
				expect(copy).toBeInstanceOf(URL);
				expect(copy).not.toBe(url);
				expect(helpers.tryParseUrl('/relative')).toBeUndefined();
				expect(helpers.tryParseUrl('a', 'not a base')).toBeUndefined();
				expect(helpers.tryParseUrl('http://exa mple.com')).toBeUndefined();
			}
		} finally {
			if (native) Object.defineProperty(URL, 'parse', native);
		}
		expect(typeof (URL as { parse?: unknown }).parse).toBe('function');
	});
});
