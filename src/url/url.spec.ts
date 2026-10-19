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
