import * as helpers from '.';

const NON_STRINGS: unknown[] = [undefined, null, 0, 1, NaN, true, {}, [], Symbol('x'), 1n, new String('a'), function () {}];

const STRING_VALIDATORS: Record<string, (value: unknown) => boolean> = {
	isEmail: helpers.isEmail,
	isUrl: function (value) {
		return helpers.isUrl(value);
	},
	isUuid: function (value) {
		return helpers.isUuid(value);
	},
	isIPv4: helpers.isIPv4,
	isIPv6: helpers.isIPv6,
	isIP: helpers.isIP,
	isHexColor: function (value) {
		return helpers.isHexColor(value);
	},
	isSemver: helpers.isSemver,
	isIsoDateString: helpers.isIsoDateString,
	isIsoDateTimeString: helpers.isIsoDateTimeString,
	isCreditCardNumber: helpers.isCreditCardNumber,
	isJsonString: helpers.isJsonString,
	isBase64: function (value) {
		return helpers.isBase64(value);
	},
	isSlug: helpers.isSlug,
	isNumericString: helpers.isNumericString,
	luhnCheck: function (value) {
		return helpers.luhnCheck(value as string);
	}
};

describe('every validator', function () {
	it.each(Object.keys(STRING_VALIDATORS))('%s returns false (and never throws) for non-strings', function (name) {
		for (const value of NON_STRINGS) expect(STRING_VALIDATORS[name](value)).toBe(false);
	});

	it('narrows unknown values to string', function () {
		const value: unknown = 'a@b.co';
		if (helpers.isEmail(value)) {
			const narrowed: string = value;
			expect(narrowed.length).toBe(6);
		}
		expect.assertions(1);
	});

	describe('ReDoS resistance', function () {
		const n = 50000;
		const digits = '1'.repeat(n);
		const letters = 'a'.repeat(n);
		const pathological: string[] = [
			digits + '!',
			letters + '!',
			'0'.repeat(n) + '!',
			'-'.repeat(n) + '!',
			'.'.repeat(n),
			':'.repeat(n),
			'1:'.repeat(n / 2) + '!',
			'1.'.repeat(n / 2) + '!',
			'a.'.repeat(n / 2) + '!',
			'a-'.repeat(n / 2) + '!',
			'a@' + letters + '!',
			letters + '@' + 'a.'.repeat(n / 2),
			'http://' + letters + '.com:' + digits,
			'1.0.0-' + digits + '!',
			'1.0.0-' + '0'.repeat(n) + '!',
			'1.0.0-' + 'a.'.repeat(n / 2) + '!',
			'1.0.0+' + 'a.'.repeat(n / 2) + '!',
			digits + '.' + digits + 'e' + digits + '!',
			'+' + digits + '.' + 'e1'.repeat(n / 2),
			'1 '.repeat(n / 2) + '!',
			'1-'.repeat(n / 2) + '!',
			'A'.repeat(n) + '=!',
			'#' + 'f'.repeat(n),
			'2024-01-01T00:00:00.' + digits + '!',
			'['.repeat(n),
			'{"a":'.repeat(n / 5),
			'0000-'.repeat(n / 5) + '!'
		];

		it.each(Object.keys(STRING_VALIDATORS))('%s handles 50k-character adversarial inputs in linear time', function (name) {
			const validate = STRING_VALIDATORS[name];
			for (const input of pathological) {
				const start = performance.now();
				expect({ input: input.slice(0, 20), valid: validate(input) }).toEqual({ input: input.slice(0, 20), valid: false });
				expect(performance.now() - start).toBeLessThan(200);
			}
		});
	});
});

describe('isEmail', function () {
	it.each([
		'simple@example.com',
		'very.common@example.com',
		'x@example.com',
		'long.email-address-with-hyphens@and.subdomains.example.com',
		'user.name+tag+sorting@example.com',
		"!#$%&'*+/=?^_`{|}~-@example.org",
		'user@localhost',
		'user@123.123.123.123',
		'.dots..anywhere.@example.com',
		'a@' + 'b'.repeat(63) + '.com',
		'a'.repeat(64) + '@example.com',
		'a@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(60)].join('.') // 254 characters
	])('accepts %s', function (email) {
		expect(helpers.isEmail(email)).toBe(true);
	});

	it.each([
		'',
		'plainaddress',
		'@example.com',
		'user@',
		'a@b@c.com',
		'"quoted local"@example.com',
		'user@[127.0.0.1]',
		'user name@example.com',
		' user@example.com',
		'user@example.com ',
		'user@-example.com',
		'user@example-.com',
		'user@example..com',
		'user@.example.com',
		'user@example.com.',
		'user@exa_mple.com',
		'josé@example.com',
		'user@exämple.com',
		'a@' + 'b'.repeat(64) + '.com',
		'a'.repeat(65) + '@example.com',
		'a@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63), 'e'.repeat(61)].join('.') // 255 characters
	])('rejects %s', function (email) {
		expect(helpers.isEmail(email)).toBe(false);
	});
});

describe('isUrl', function () {
	it.each([
		'http://example.com',
		'https://example.com/path/to?query=1&x=y#frag',
		'HTTPS://EXAMPLE.COM',
		'http://localhost:3000',
		'http://127.0.0.1:8080/x',
		'http://[::1]/',
		'https://user:pass@example.com',
		'https://münchen.de',
		'https://example.com/%20'
	])('accepts %s', function (url) {
		expect(helpers.isUrl(url)).toBe(true);
	});

	it.each([
		'',
		'example.com',
		'//example.com',
		'/relative/path',
		'http://',
		'http:example.com',
		'http:/example.com',
		'http:///example.com',
		'http:\\\\example.com',
		'https://exa mple.com',
		' https://example.com',
		'https://example.com ',
		'https://example.com/a\tb',
		'https://example.com/a\nb',
		'http://exa\u0000mple.com',
		'ftp://example.com',
		'mailto:user@example.com',
		'javascript:alert(1)',
		'http://[::1',
		'https://example.com:99999'
	])('rejects %s', function (url) {
		expect(helpers.isUrl(url)).toBe(false);
	});

	it('honours the protocols whitelist, case-insensitively and with or without the colon', function () {
		expect(helpers.isUrl('ftp://files.example.com', { protocols: ['ftp'] })).toBe(true);
		expect(helpers.isUrl('ftp://files.example.com', { protocols: ['FTP:'] })).toBe(true);
		expect(helpers.isUrl('https://example.com', { protocols: ['ftp'] })).toBe(false);
		expect(helpers.isUrl('mailto:user@example.com', { protocols: ['mailto'] })).toBe(true);
		expect(helpers.isUrl('ws://socket.example.com', { protocols: ['ws', 'wss'] })).toBe(true);
		expect(helpers.isUrl('ws:socket.example.com', { protocols: ['ws'] })).toBe(false);
		expect(helpers.isUrl('file:///etc/hosts', { protocols: ['file'] })).toBe(true);
		expect(helpers.isUrl('file:/etc/hosts', { protocols: ['file'] })).toBe(false);
		expect(helpers.isUrl('custom+app://open?id=1', { protocols: ['custom+app'] })).toBe(true);
		expect(helpers.isUrl('https://example.com', { protocols: [] })).toBe(false);
		expect(helpers.isUrl('https://example.com', { protocols: [1 as any, 'https'] })).toBe(true);
	});

	it('requireTld requires a domain name ending in an alphabetic or punycode TLD', function () {
		const options = { requireTld: true };
		expect(helpers.isUrl('https://example.com', options)).toBe(true);
		expect(helpers.isUrl('https://sub.example.co.uk/x', options)).toBe(true);
		expect(helpers.isUrl('https://example.com.', options)).toBe(true);
		expect(helpers.isUrl('https://münchen.de', options)).toBe(true);
		expect(helpers.isUrl('https://example.xn--p1ai', options)).toBe(true);
		expect(helpers.isUrl('https://localhost', options)).toBe(false);
		expect(helpers.isUrl('https://127.0.0.1', options)).toBe(false);
		expect(helpers.isUrl('https://[::1]', options)).toBe(false);
		expect(helpers.isUrl('https://example.c', options)).toBe(false);
		expect(helpers.isUrl('https://example.123', options)).toBe(false);
		expect(helpers.isUrl('https://.com', options)).toBe(false);
		expect(helpers.isUrl('mailto:user@example.com', { protocols: ['mailto'], requireTld: true })).toBe(false);
	});

	it('requireTld rejects host names with empty labels', function () {
		const options = { requireTld: true };
		expect(helpers.isUrl('https://a..com', options)).toBe(false);
		expect(helpers.isUrl('https://..com', options)).toBe(false);
		expect(helpers.isUrl('https://example.com..', options)).toBe(false);
		expect(helpers.isUrl('https://a..com')).toBe(false);
	});

	it('requireTld accepts the mixed-case host names of non-special schemes, which the URL parser does not lower-case', function () {
		const options = { protocols: ['ssh', 'redis'], requireTld: true };
		expect(helpers.isUrl('ssh://git@Host.Example.ORG:22/repo', options)).toBe(true);
		expect(helpers.isUrl('redis://Cache.Example.Com', options)).toBe(true);
		expect(helpers.isUrl('redis://Cache.EXAMPLE.C0M', options)).toBe(false);
	});

	describe('security: the fetched host is the written host', function () {
		it.each([
			['soft hyphen U+00AD', 'https://ev\u00adil.com/'],
			['zero-width space U+200B', 'https://ev\u200bil.com/'],
			['combining grapheme joiner U+034F', 'https://e\u034fvil.com/'],
			['variation selector U+FE0F', 'https://e\ufe0fvil.com/'],
			['word joiner U+2060', 'https://ex\u2060ample.com'],
			['bidi override U+202E', 'https://example.com/\u202e'],
			['fullwidth letter', 'https://\uff45vil.com/'],
			['fullwidth host', 'https://\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45.com'],
			['circled letter', 'https://\u24d4vil.com/'],
			['ideographic full stop', 'https://evil\u3002com/'],
			['halfwidth ideographic full stop', 'https://evil\uff61com/'],
			['fullwidth full stop', 'https://evil\uff0ecom/'],
			['decomposed accent (NFKC composes it)', 'https://mu\u0308nchen.de'],
			['percent-encoded host', 'https://%65vil.com/'],
			['percent-encoded NUL', 'https://exa%00mple.com'],
			['backslash before @', 'http://evil.com\\@good.com/'],
			['backslash after //', 'https://\\evil.com'],
			['backslash in a non-special authority', 'foo://evil.com\\@good.com'],
			['empty host label', 'https://a..b'],
			['dot-only host', 'https://.'],
			['dots-only host', 'https://..'],
			['leading dot', 'https://.example.com'],
			['two trailing dots', 'https://example.com..'],
			['hex IPv4', 'https://0x7f.1'],
			['hex IPv4 label', 'https://0x7f.0.0.1'],
			['integer IPv4', 'http://2130706433'],
			['shorthand IPv4', 'http://127.1'],
			['octal-looking IPv4', 'http://0177.0.0.1'],
			['IPv4 with trailing dot', 'http://127.0.0.1.'],
			['bare 0x', 'http://a.0x']
		])('rejects %s', function (_label, url) {
			expect(helpers.isUrl(url, { protocols: ['http', 'https', 'foo'] })).toBe(false);
		});

		it.each([
			'https://münchen.de',
			'https://MÜNCHEN.de/x',
			'https://例え.jp',
			'https://xn--mnchen-3ya.de',
			'https://user:p%40ss@example.com:8080/a%20b?q=%41#%42',
			'https://example.com./',
			'http://127.0.0.1:8080',
			'http://[::ffff:127.0.0.1]/',
			'https://0x.example.com',
			'https://1.example.com',
			'https://example.com/\\path',
			'https://example.com/?q=\u00e9'
		])('accepts %s', function (url) {
			expect(helpers.isUrl(url)).toBe(true);
		});

		it('checks hosts behind credentials and before the port, and the authority of non-special schemes', function () {
			expect(helpers.isUrl('https://good.com@ev\u00adil.com')).toBe(false);
			expect(helpers.isUrl('https://good.com@%65vil.com')).toBe(false);
			expect(helpers.isUrl('https://a..b:443')).toBe(false);
			expect(helpers.isUrl('ssh://git@a..b/x', { protocols: ['ssh'] })).toBe(false);
			expect(helpers.isUrl('ssh://git@host/x', { protocols: ['ssh'] })).toBe(true);
			expect(helpers.isUrl('file:///etc/hosts', { protocols: ['file'] })).toBe(true);
			expect(helpers.isUrl('mailto:a@%65vil.com', { protocols: ['mailto'] })).toBe(true);
		});
	});

	it('throws a TypeError when protocols is not an array', function () {
		expect(function () {
			helpers.isUrl('https://example.com', { protocols: 'https' as any });
		}).toThrow(TypeError);
	});

	describe('platform URL', function () {
		const original = globalThis.URL;

		afterEach(function () {
			globalThis.URL = original;
		});

		it('throws a clear Error when globalThis.URL is unavailable', function () {
			delete (globalThis as any).URL;
			expect(function () {
				helpers.isUrl('https://example.com');
			}).toThrow(/globalThis\.URL is not available/);
			// Non-strings are rejected before the platform is consulted.
			expect(helpers.isUrl(42)).toBe(false);
		});

		it('validates with URL.canParse when available, unless the host must be inspected', function () {
			const parsed: string[] = [];
			(globalThis as any).URL = class {
				constructor() {
					throw new TypeError('Invalid URL');
				}

				static canParse(input: string): boolean {
					parsed.push(input);
					return true;
				}
			};
			expect(helpers.isUrl('https://x')).toBe(true);
			expect(parsed).toEqual(['https://x']);
			// requireTld needs the parsed host, so the URL is constructed (and fails here).
			expect(helpers.isUrl('https://x.com', { requireTld: true })).toBe(false);
		});

		it('constructs the URL when URL.canParse is unavailable', function () {
			(globalThis as any).URL = function (input: string) {
				return new original(input);
			};
			expect(helpers.isUrl('https://example.com/path')).toBe(true);
			expect(helpers.isUrl('https://[::1')).toBe(false);
		});

		it('rejects http(s) URLs whose parsed host is empty', function () {
			(globalThis as any).URL = function (this: any) {
				this.hostname = '';
			};
			expect(helpers.isUrl('https://x')).toBe(false);
			expect(helpers.isUrl('http://x')).toBe(false);
			// Other schemes may have an empty host.
			expect(helpers.isUrl('ws://x', { protocols: ['ws'] })).toBe(true);
		});
	});
});

describe('isUuid', function () {
	const v4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
	const byVersion: Record<number, string> = {
		1: 'c232ab00-9414-11ec-b3c8-9f6bdeced846',
		2: '000003e8-cbb9-21ea-b201-00045a86c8a1',
		3: '5df41881-3aed-3515-88a7-2f4a814cf09e',
		4: '919108f7-52d1-4320-9bac-f847db4148a8',
		5: '2ed6657d-e927-568b-95e1-2665a8aea6a2',
		6: '1ec9414c-232a-6b00-b3c8-9f6bdeced846',
		7: '017f22e2-79b0-7cc3-98c4-dc0c0c07398f',
		8: '2489e9ad-2ee2-8e00-8ec9-32d5f69181c0'
	};

	it.each(Object.entries(byVersion))('accepts the RFC 9562 example for version %s, only for that version', function (version, uuid) {
		expect(helpers.isUuid(uuid)).toBe(true);
		expect(helpers.isUuid(uuid.toUpperCase())).toBe(true);
		for (let other = 1; other <= 8; other++) {
			expect(helpers.isUuid(uuid, other as helpers.UuidVersion)).toBe(String(other) === version);
		}
		expect(helpers.isUuid(uuid, 'nil')).toBe(false);
		expect(helpers.isUuid(uuid, 'max')).toBe(false);
	});

	it('accepts the nil and max UUIDs', function () {
		const nil = '00000000-0000-0000-0000-000000000000';
		const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
		expect(helpers.isUuid(nil)).toBe(true);
		expect(helpers.isUuid(max)).toBe(true);
		expect(helpers.isUuid(max.toUpperCase())).toBe(true);
		expect(helpers.isUuid(nil, 'nil')).toBe(true);
		expect(helpers.isUuid(max, 'max')).toBe(true);
		expect(helpers.isUuid(max.toUpperCase(), 'max')).toBe(true);
		expect(helpers.isUuid(nil, 'max')).toBe(false);
		expect(helpers.isUuid(max, 'nil')).toBe(false);
		expect(helpers.isUuid(nil, 4)).toBe(false);
		expect(helpers.isUuid(max, 4)).toBe(false);
	});

	it.each([
		'',
		'f47ac10b58cc4372a5670e02b2c3d479',
		'{f47ac10b-58cc-4372-a567-0e02b2c3d479}',
		'urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479',
		'f47ac10b-58cc-4372-a567-0e02b2c3d47',
		'f47ac10b-58cc-4372-a567-0e02b2c3d4799',
		'g47ac10b-58cc-4372-a567-0e02b2c3d479',
		'f47ac10b-58cc-0372-a567-0e02b2c3d479', // version 0
		'f47ac10b-58cc-9372-a567-0e02b2c3d479', // version 9
		'f47ac10b-58cc-f372-a567-0e02b2c3d479', // version 15
		'f47ac10b-58cc-4372-c567-0e02b2c3d479', // Microsoft variant
		'f47ac10b-58cc-4372-7567-0e02b2c3d479', // NCS variant
		' f47ac10b-58cc-4372-a567-0e02b2c3d479',
		'00000000-0000-0000-0000-000000000001'
	])('rejects %s', function (uuid) {
		expect(helpers.isUuid(uuid)).toBe(false);
	});

	it('accepts uppercase variant digits', function () {
		expect(helpers.isUuid(v4.replace('a567', 'B567'), 4)).toBe(true);
	});

	it('throws a RangeError for an unknown version', function () {
		expect(function () {
			helpers.isUuid(v4, 9 as any);
		}).toThrow(RangeError);
		expect(function () {
			helpers.isUuid(v4, '4' as any);
		}).toThrow(RangeError);
		expect(function () {
			helpers.isUuid(42, 0 as any);
		}).toThrow(RangeError);
		for (const version of [1.5, NaN, -1, Infinity, null]) {
			expect(function () {
				helpers.isUuid(v4, version as any);
			}).toThrow(RangeError);
		}
	});
});

describe('semver helpers and non-string input', function () {
	it('never reads a semantic version out of an object that stringifies to one', function () {
		const version: any = {
			toString(): string {
				return '1.2.3';
			}
		};
		expect(helpers.isSemver(version)).toBe(false);
		expect(helpers.parseSemver(version)).toBeUndefined();
		expect(function () {
			helpers.compareSemver(version, '1.2.3');
		}).toThrow(TypeError);
	});
});

describe('isUrl default protocols', function () {
	it('accepts http and https only, case-insensitively, when protocols is omitted', function () {
		expect(helpers.isUrl('HTTP://example.com')).toBe(true);
		expect(helpers.isUrl('https://example.com')).toBe(true);
		expect(helpers.isUrl('ws://example.com')).toBe(false);
		expect(helpers.isUrl('https://example.com', {})).toBe(true);
		expect(function () {
			helpers.isUrl('https://example.com', { protocols: null as any });
		}).toThrow(new TypeError('isUrl: `protocols` must be an array of strings, got object'));
	});
});

describe('isIPv6 (scanner edge cases)', function () {
	it.each(['::', '1::', '1:2:3:4:5:6:7::', '::1:2:3:4:5:6:7', '1:2:3:4:5:6:1.2.3.4', '::1.2.3.4', '1::1.2.3.4'])('accepts %s', function (address) {
		expect(helpers.isIPv6(address)).toBe(true);
	});

	it.each([
		':::',
		'1:::2',
		':1::2',
		'1:2:3:4:5:6:7:8:9',
		'1::2:3:4:5:6:7:8',
		'1:2:3:4::5:6:7:8',
		'1:2:3:4:5:1.2.3.4',
		'1.2.3.4::',
		'1.2.3.4',
		'::1.2.3.4:1',
		'::ffff:1.2.3.04',
		'12345::',
		'fffff::1',
		'1:2:3:4:5:6:7:',
		'1:2:3:4:5:6:7:8:',
		'::1:',
		'fe80::1%eth0',
		'1-2::3',
		'g::1'
	])('rejects %s', function (address) {
		expect(helpers.isIPv6(address)).toBe(false);
	});
});

describe('isIPv4', function () {
	it.each(['0.0.0.0', '1.2.3.4', '127.0.0.1', '192.168.1.255', '255.255.255.255', '10.20.30.40', '199.249.100.9'])('accepts %s', function (ip) {
		expect(helpers.isIPv4(ip)).toBe(true);
	});

	it.each([
		'',
		'1.2.3',
		'1.2.3.4.5',
		'256.1.1.1',
		'1.1.1.300',
		'01.1.1.1',
		'1.1.1.00',
		'1.1.1.010',
		'127.1',
		'0x7f.0.0.1',
		'1.2.3.4 ',
		' 1.2.3.4',
		'1..3.4',
		'1.2.3.',
		'-1.2.3.4',
		'1.2.3.4/24',
		'١.٢.٣.٤'
	])('rejects %s', function (ip) {
		expect(helpers.isIPv4(ip)).toBe(false);
	});
});

describe('isIPv6', function () {
	it.each([
		'2001:0db8:0000:0000:0000:ff00:0042:8329',
		'2001:db8:0:0:0:ff00:42:8329',
		'2001:db8::ff00:42:8329',
		'2001:DB8::FF00:42:8329',
		'::',
		'::1',
		'1::',
		'fe80::',
		'1:2:3:4:5:6:7::',
		'::2:3:4:5:6:7:8',
		'1::8',
		'1:2:3:4:5:6::8',
		'::ffff:192.0.2.128',
		'::192.0.2.128',
		'64:ff9b::192.0.2.33',
		'1:2:3:4:5:6:1.2.3.4',
		'1:2:3:4:5::1.2.3.4',
		'0000:0000:0000:0000:0000:0000:255.255.255.255'
	])('accepts %s', function (ip) {
		expect(helpers.isIPv6(ip)).toBe(true);
	});

	it.each([
		'',
		':',
		':::',
		'1',
		'1:2:3:4:5:6:7',
		'1:2:3:4:5:6:7:8:9',
		'1:2:3:4:5:6:7:8::',
		'::1:2:3:4:5:6:7:8',
		'1::2::3',
		'1:::2',
		':1:2:3:4:5:6:7',
		'1:2:3:4:5:6:7:',
		'12345::',
		'g::1',
		'fe80::1%eth0',
		'fe80::1%25eth0',
		'[::1]',
		' ::1',
		'1.2.3.4',
		'::1.2.3',
		'::256.0.0.1',
		'::01.2.3.4',
		'1.2.3.4::',
		'::1.2.3.4:1',
		'1:2:3:4:5:6:7:1.2.3.4',
		'1:2:3:4:5:6::1.2.3.4',
		'0000:0000:0000:0000:0000:0000:0000:255.255.255.255'
	])('rejects %s', function (ip) {
		expect(helpers.isIPv6(ip)).toBe(false);
	});
});

describe('isIP', function () {
	it('accepts either family and nothing else', function () {
		expect(helpers.isIP('8.8.8.8')).toBe(true);
		expect(helpers.isIP('2001:4860:4860::8888')).toBe(true);
		expect(helpers.isIP('8.8.8')).toBe(false);
		expect(helpers.isIP('localhost')).toBe(false);
	});
});

describe('isHexColor', function () {
	it.each(['#fff', '#FFF', '#ffff', '#ff8000', '#FF8000', '#ff800080', '#AbCdEf', '#000'])('accepts %s', function (color) {
		expect(helpers.isHexColor(color)).toBe(true);
		expect(helpers.isHexColor(color, { alpha: true })).toBe(true);
	});

	it.each(['', '#', 'fff', 'ff8000', '#ff', '#fffff', '#fffffff', '#fffffffff', '#ggg', '# fff', '#fff ', 'rgb(0,0,0)', '##fff'])('rejects %s', function (color) {
		expect(helpers.isHexColor(color)).toBe(false);
	});

	it('rejects the alpha forms when alpha is false', function () {
		expect(helpers.isHexColor('#fff', { alpha: false })).toBe(true);
		expect(helpers.isHexColor('#ff8000', { alpha: false })).toBe(true);
		expect(helpers.isHexColor('#ffff', { alpha: false })).toBe(false);
		expect(helpers.isHexColor('#ff800080', { alpha: false })).toBe(false);
	});
});

describe('isSemver', function () {
	it.each([
		'0.0.4',
		'1.2.3',
		'10.20.30',
		'1.1.2-prerelease+meta',
		'1.1.2+meta',
		'1.1.2+meta-valid',
		'1.0.0-alpha',
		'1.0.0-beta',
		'1.0.0-alpha.beta',
		'1.0.0-alpha.beta.1',
		'1.0.0-alpha.1',
		'1.0.0-alpha0.valid',
		'1.0.0-alpha.0valid',
		'1.0.0-alpha-a.b-c-somethinglong+build.1-aef.1-its-okay',
		'1.0.0-rc.1+build.1',
		'2.0.0-rc.1+build.123',
		'1.2.3-beta',
		'10.2.3-DEV-SNAPSHOT',
		'1.2.3-SNAPSHOT-123',
		'1.0.0',
		'2.0.0+build.1848',
		'2.0.1-alpha.1227',
		'1.0.0-alpha+beta',
		'1.2.3----RC-SNAPSHOT.12.9.1--.12+788',
		'1.2.3----R-S.12.9.1--.12+meta',
		'1.2.3----RC-SNAPSHOT.12.9.1--.12',
		'1.0.0+0.build.1-rc.10000aaa-kk-0.1',
		'99999999999999999999999.999999999999999999.99999999999999999',
		'1.0.0-0A.is.legal'
	])('accepts %s', function (version) {
		expect(helpers.isSemver(version)).toBe(true);
	});

	it.each([
		'1',
		'1.2',
		'1.2.3-0123',
		'1.2.3-0123.0123',
		'1.1.2+.123',
		'+invalid',
		'-invalid',
		'-invalid+invalid',
		'-invalid.01',
		'alpha',
		'alpha.beta',
		'alpha.beta.1',
		'alpha.1',
		'alpha+beta',
		'alpha_beta',
		'alpha.',
		'alpha..',
		'beta',
		'1.0.0-alpha_beta',
		'-alpha.',
		'1.0.0-alpha..',
		'1.0.0-alpha..1',
		'1.0.0-alpha...1',
		'1.0.0-alpha....1',
		'1.0.0-alpha.....1',
		'1.0.0-alpha......1',
		'1.0.0-alpha.......1',
		'01.1.1',
		'1.01.1',
		'1.1.01',
		'1.2',
		'1.2.3.DEV',
		'1.2-SNAPSHOT',
		'1.2.31.2.3----RC-SNAPSHOT.12.09.1--..12+788',
		'1.2-RC-SNAPSHOT',
		'-1.0.3-gamma+b7718',
		'+justmeta',
		'9.8.7+meta+meta',
		'9.8.7-whatever+meta+meta',
		'v1.2.3',
		' 1.2.3',
		'1.2.3 ',
		''
	])('rejects %s', function (version) {
		expect(helpers.isSemver(version)).toBe(false);
	});
});

describe('parseSemver', function () {
	it('splits a version into its parts', function () {
		expect(helpers.parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
		expect(helpers.parseSemver('1.0.0-alpha.1.x-y+build.001.sha')).toEqual({
			major: 1,
			minor: 0,
			patch: 0,
			prerelease: ['alpha', 1, 'x-y'],
			build: ['build', '001', 'sha']
		});
		expect(helpers.parseSemver('0.0.0-0')).toEqual({ major: 0, minor: 0, patch: 0, prerelease: [0], build: [] });
		expect(helpers.parseSemver('1.0.0-0A')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['0A'], build: [] });
	});

	it('keeps numeric pre-release identifiers above MAX_SAFE_INTEGER as strings', function () {
		expect(helpers.parseSemver('1.0.0-9007199254740991.9007199254740993')!.prerelease).toEqual([9007199254740991, '9007199254740993']);
	});

	it('returns undefined for invalid versions and unsafe major/minor/patch numbers', function () {
		expect(helpers.parseSemver('1.2')).toBeUndefined();
		expect(helpers.parseSemver(123)).toBeUndefined();
		expect(helpers.parseSemver('9007199254740991.0.0')).toEqual({ major: 9007199254740991, minor: 0, patch: 0, prerelease: [], build: [] });
		expect(helpers.parseSemver('9007199254740992.0.0')).toBeUndefined();
		expect(helpers.parseSemver('0.9007199254740992.0')).toBeUndefined();
		expect(helpers.parseSemver('0.0.9007199254740992')).toBeUndefined();
	});
});

describe('compareSemver', function () {
	it('follows the semver.org §11 precedence examples', function () {
		const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '2.0.0', '2.1.0', '2.1.1'];
		for (let i = 0; i < ordered.length; i++) {
			for (let j = 0; j < ordered.length; j++) {
				expect(helpers.compareSemver(ordered[i], ordered[j])).toBe(Math.sign(i - j) + 0);
			}
		}
		expect([...ordered].reverse().sort(helpers.compareSemver)).toEqual(ordered);
	});

	it('compares numbers numerically, at any size', function () {
		expect(helpers.compareSemver('1.2.3', '1.10.0')).toBe(-1);
		expect(helpers.compareSemver('10.0.0', '9.99.99')).toBe(1);
		expect(helpers.compareSemver('1.0.10', '1.0.9')).toBe(1);
		expect(helpers.compareSemver('99999999999999999999.0.0', '99999999999999999998.0.0')).toBe(1);
		expect(helpers.compareSemver('1.0.0-9007199254740993', '1.0.0-9007199254740992')).toBe(1);
	});

	it('orders numeric identifiers before alphanumeric ones and alphanumerics in ASCII order', function () {
		expect(helpers.compareSemver('1.0.0-1', '1.0.0-a')).toBe(-1);
		expect(helpers.compareSemver('1.0.0-a', '1.0.0-1')).toBe(1);
		expect(helpers.compareSemver('1.0.0-Z', '1.0.0-a')).toBe(-1);
		expect(helpers.compareSemver('1.0.0-a-b', '1.0.0-a')).toBe(1);
		expect(helpers.compareSemver('1.0.0-0A', '1.0.0-1')).toBe(1);
	});

	it('ignores build metadata', function () {
		expect(helpers.compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
		expect(helpers.compareSemver('1.0.0-rc.1+x', '1.0.0-rc.1')).toBe(0);
		expect(helpers.compareSemver('1.0.0', '1.0.0')).toBe(0);
	});

	it('throws a TypeError for invalid input', function () {
		expect(function () {
			helpers.compareSemver('1.0', '1.0.0');
		}).toThrow(new TypeError('compareSemver: "1.0" is not a valid semantic version'));
		// Security: at most 50 characters of a rejected string are quoted.
		expect(function () {
			helpers.compareSemver('1.0.0', 'x'.repeat(10_000));
		}).toThrow(new TypeError(`compareSemver: "${'x'.repeat(50)}…" is not a valid semantic version`));
		expect(function () {
			helpers.compareSemver('1.0.0', 'x'.repeat(50));
		}).toThrow(new TypeError(`compareSemver: "${'x'.repeat(50)}" is not a valid semantic version`));
		expect(function () {
			helpers.compareSemver('1.0.0', 'v1.0.0');
		}).toThrow(TypeError);
		expect(function () {
			helpers.compareSemver(1 as any, '1.0.0');
		}).toThrow(new TypeError('compareSemver: number is not a valid semantic version'));
		expect(function () {
			helpers.compareSemver('1.0.0', null as any);
		}).toThrow(TypeError);
	});
});

describe('isIsoDateString', function () {
	it.each(['2024-02-29', '2000-02-29', '2023-12-31', '0000-01-01', '9999-12-31', '2024-04-30'])('accepts %s', function (date) {
		expect(helpers.isIsoDateString(date)).toBe(true);
	});

	it.each([
		'',
		'2023-02-29',
		'1900-02-29',
		'2024-04-31',
		'2024-13-01',
		'2024-00-10',
		'2024-01-00',
		'2024-1-05',
		'24-01-05',
		'2024/01/05',
		'2024-01-05T00:00:00Z',
		' 2024-01-05',
		'+2024-01-05'
	])('rejects %s', function (date) {
		expect(helpers.isIsoDateString(date)).toBe(false);
	});
});

describe('isIsoDateTimeString', function () {
	it.each([
		'1985-04-12T23:20:50.52Z',
		'1996-12-19T16:39:57-08:00',
		'1990-12-31T15:59:59-08:00',
		'1937-01-01T12:00:27.87+00:20',
		'2024-02-29T00:00:00Z',
		'2024-02-29t00:00:00z',
		'2024-01-01T23:59:59.123456789+23:59',
		'2024-01-01T00:00:00-00:00',
		'1970-01-01T00:00:00.000Z',
		'2024-01-01T20:19:09+14:45',
		'2024-01-01T10:00:00-20:00'
	])('accepts %s', function (dateTime) {
		expect(helpers.isIsoDateTimeString(dateTime)).toBe(true);
	});

	it.each([
		'',
		'2024-01-01',
		'2024-01-01T00:00Z',
		'2024-01-01T00:00:00',
		'2024-01-01 00:00:00Z',
		'2023-02-29T00:00:00Z',
		'2024-02-30T00:00:00Z',
		'2024-13-01T00:00:00Z',
		'2024-01-01T24:00:00Z',
		'2024-01-01T23:60:00Z',
		'2024-01-01T23:59:60Z',
		'1990-12-31T23:59:60Z',
		'2024-01-01T00:00:00+24:00',
		'2024-01-01T00:00:00+05:60',
		'2024-01-01T00:00:00+0530',
		'2024-01-01T00:00:00.Z',
		'2024-01-01T00:00:00,5Z',
		'2024-01-01T1:00:00Z',
		'2024-01-01T00:00:00Z ',
		' 2024-01-01T00:00:00Z',
		'+002024-01-01T00:00:00Z',
		'2024-01-01T30:00:00Z',
		'2024-01-01T00:00:00-30:00'
	])('rejects %s', function (dateTime) {
		expect(helpers.isIsoDateTimeString(dateTime)).toBe(false);
	});
});

describe('luhnCheck', function () {
	it('validates the Luhn checksum', function () {
		expect(helpers.luhnCheck('79927398713')).toBe(true);
		expect(helpers.luhnCheck('4111111111111111')).toBe(true);
		expect(helpers.luhnCheck('0')).toBe(true);
		expect(helpers.luhnCheck('18')).toBe(true);
		expect(helpers.luhnCheck('79927398710')).toBe(false);
		expect(helpers.luhnCheck('4111111111111112')).toBe(false);
	});

	it('returns false for anything that is not a non-empty string of ASCII digits', function () {
		expect(helpers.luhnCheck('')).toBe(false);
		expect(helpers.luhnCheck('7992 7398 713')).toBe(false);
		expect(helpers.luhnCheck('-79927398713')).toBe(false);
		expect(helpers.luhnCheck('７９９２７３９８７１３')).toBe(false);
	});
});

describe('isCreditCardNumber', function () {
	it.each([
		'4111111111111111',
		'4111 1111 1111 1111',
		'4111-1111-1111-1111',
		'4111 1111-1111 1111',
		'378282246310005', // Amex
		'3782 822463 10005',
		'5555555555554444', // Mastercard
		'6011111111111117', // Discover
		'30569309025904', // Diners
		'4222222222222', // 13-digit Visa
		'6304000000000000', // Maestro
		'6799990100000000019', // 19 digits
		'000000000034' // 12 digits, leading zeros
	])('accepts %s', function (card) {
		expect(helpers.isCreditCardNumber(card)).toBe(true);
	});

	it.each([
		'',
		'4111111111111112',
		'4111  1111 1111 1111',
		'4111--1111-1111-1111',
		' 4111111111111111',
		'4111111111111111 ',
		'-4111111111111111',
		'4111.1111.1111.1111',
		'00000000000', // 11 digits
		'00000000000000000000', // 20 digits
		'abcd',
		// Luhn-valid, but all zeros (security: placeholder numbers must not pass)
		'000000000000',
		'0000 0000 0000',
		'0000-0000-0000-0000-000'
	])('rejects %s', function (card) {
		expect(helpers.isCreditCardNumber(card)).toBe(false);
	});
});

describe('isJsonString', function () {
	it.each(['{}', '[]', '{"a":[1,2,{"b":null}]}', '1', '-1.5e3', '"text"', 'null', 'true', ' { } '])('accepts %s', function (json) {
		expect(helpers.isJsonString(json)).toBe(true);
	});

	it.each(['', ' ', '{a:1}', "{'a':1}", '[1,]', 'undefined', 'NaN', '{"a":1', '"unterminated', '01'])('rejects %s', function (json) {
		expect(helpers.isJsonString(json)).toBe(false);
	});
});

describe('isBase64', function () {
	it.each(['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg==', 'Zm9vYmE=', 'Zm9vYmFy', 'Zg', 'Zm8', '+/+/', 'AAAA'])('accepts %s by default', function (b64) {
		expect(helpers.isBase64(b64)).toBe(true);
	});

	it.each(['=', '==', 'Z', 'Z===', 'Zg=', 'Zm9=v', 'Zm9v Zm9v', 'Zm9v\n', 'Zg==Zg==', 'Zm9v-_', 'Zm9v!', 'Zm=8', 'Zm9vZ'])('rejects %s by default', function (b64) {
		expect(helpers.isBase64(b64)).toBe(false);
	});

	it('applies the padding modes', function () {
		expect(helpers.isBase64('Zg==', { padding: 'required' })).toBe(true);
		expect(helpers.isBase64('Zm9v', { padding: 'required' })).toBe(true);
		expect(helpers.isBase64('', { padding: 'required' })).toBe(true);
		expect(helpers.isBase64('Zg', { padding: 'required' })).toBe(false);
		expect(helpers.isBase64('Zm8', { padding: 'required' })).toBe(false);
		expect(helpers.isBase64('Zg', { padding: 'forbidden' })).toBe(true);
		expect(helpers.isBase64('Zm9v', { padding: 'forbidden' })).toBe(true);
		expect(helpers.isBase64('Zg==', { padding: 'forbidden' })).toBe(false);
		expect(helpers.isBase64('Zm8=', { padding: 'forbidden' })).toBe(false);
	});

	it('switches alphabets with urlSafe', function () {
		expect(helpers.isBase64('-_-_', { urlSafe: true })).toBe(true);
		expect(helpers.isBase64('-_8', { urlSafe: true, padding: 'forbidden' })).toBe(true);
		expect(helpers.isBase64('-_8=', { urlSafe: true })).toBe(true);
		expect(helpers.isBase64('+/+/', { urlSafe: true })).toBe(false);
		expect(helpers.isBase64('-_-_')).toBe(false);
	});

	it('security: only accepts canonical encodings (unused bits of the last character are zero)', function () {
		// 'YQ==', 'YR==', 'YS==' and 'YT==' all decode to 'a': only the first is canonical.
		for (const text of ['YR==', 'YS==', 'YT==', 'YR', 'Zh==', 'Zm9=', 'Zm+', 'Zm/', 'Zm-', 'Zm_', 'Z/==', 'Z_']) {
			expect({ text, valid: helpers.isBase64(text) || helpers.isBase64(text, { urlSafe: true }) }).toEqual({ text, valid: false });
		}
		for (const text of ['YQ==', 'YQ', 'YWI=', 'YWI', 'Zm8', 'Zw==', 'ZA', 'Zm0', 'Zm4=']) expect(helpers.isBase64(text)).toBe(true);
		expect(helpers.isBase64('-_8', { urlSafe: true })).toBe(true);
		expect(helpers.isBase64('-_9', { urlSafe: true })).toBe(false);
		expect(helpers.isBase64('-w', { urlSafe: true })).toBe(true);
		expect(helpers.isBase64('-x', { urlSafe: true })).toBe(false);
	});

	it('throws a RangeError for an unknown padding mode', function () {
		expect(function () {
			helpers.isBase64('Zg==', { padding: 'yes' as any });
		}).toThrow(RangeError);
	});
});

describe('isSlug', function () {
	it.each(['a', 'hello', 'hello-world', 'a-b-c', '2024-recap', 'x1-y2'])('accepts %s', function (slug) {
		expect(helpers.isSlug(slug)).toBe(true);
	});

	it.each(['', '-', 'Hello', 'hello world', 'hello_world', 'hello--world', '-hello', 'hello-', 'café', 'a.b'])('rejects %s', function (slug) {
		expect(helpers.isSlug(slug)).toBe(false);
	});
});

describe('isNumericString', function () {
	it.each(['0', '-0', '+1', '42', '3.14', '-3.14', '1.', '.5', '-.5', '1e3', '1E3', '1e+3', '1e-7', '2.5E+10', '5e-324', '1.7976931348623157e308', '0001', '00.5'])(
		'accepts %s',
		function (number) {
			expect(helpers.isNumericString(number)).toBe(true);
		}
	);

	it.each([
		'',
		' ',
		'.',
		'-',
		'+',
		'e5',
		'1e',
		'1e+',
		'1.2.3',
		'--1',
		'+-1',
		' 1',
		'1 ',
		'0x1f',
		'0b101',
		'0o17',
		'1_000',
		'1,000',
		'Infinity',
		'-Infinity',
		'NaN',
		'1e400',
		'-1e400',
		'١٢٣'
	])('rejects %s', function (number) {
		expect(helpers.isNumericString(number)).toBe(false);
	});
});

describe('edge cases', function () {
	it('isUrl: names the problem when protocols is not an array', function () {
		expect(function () {
			helpers.isUrl('https://example.com', { protocols: 'https' as any });
		}).toThrow(new TypeError('isUrl: `protocols` must be an array of strings, got string'));
	});

	it('isUrl: only ignores a trailing colon in protocols', function () {
		expect(helpers.isUrl('ab://example.com', { protocols: ['a:b'] })).toBe(false);
		expect(helpers.isUrl('ab://example.com', { protocols: ['AB:'] })).toBe(true);
	});

	it('isUrl: requires exactly two slashes after every special scheme', function () {
		expect(helpers.isUrl('https:example.com')).toBe(false);
		expect(helpers.isUrl('wss:example.com', { protocols: ['wss'] })).toBe(false);
		expect(helpers.isUrl('ftp:example.com', { protocols: ['ftp'] })).toBe(false);
		expect(helpers.isUrl('http://\\example.com')).toBe(false);
		expect(helpers.isUrl('http:///example.com')).toBe(false);
	});

	it('isUrl: requireTld rejects empty labels and TLDs that are not only letters', function () {
		const options = { requireTld: true };
		expect(helpers.isUrl('http://.example.com', options)).toBe(false);
		expect(helpers.isUrl('http://example.1com', options)).toBe(false);
		expect(helpers.isUrl('http://example.com1', options)).toBe(false);
		expect(helpers.isUrl('http://example.com..', options)).toBe(false);
	});

	it('isUuid and isBase64: name the invalid option', function () {
		expect(function () {
			helpers.isUuid('x', 9 as any);
		}).toThrow(new RangeError("isUuid: `version` must be 1-8, 'nil' or 'max', got 9"));
		expect(function () {
			helpers.isBase64('x', { padding: 'none' as any });
		}).toThrow(new RangeError("isBase64: `padding` must be 'optional', 'required' or 'forbidden', got none"));
	});

	it('isIPv6: rejects a second :: even after eight full groups', function () {
		expect(helpers.isIPv6('1:2:3:4:5:6:7:8::a::b')).toBe(false);
		expect(helpers.isIPv6('a')).toBe(false);
		expect(helpers.isIPv6('')).toBe(false);
	});

	it('compareSemver: numeric pre-release identifiers sort before alphanumeric ones whatever their length', function () {
		expect(helpers.compareSemver('1.0.0-123', '1.0.0-a')).toBe(-1);
		expect(helpers.compareSemver('1.0.0-a', '1.0.0-123')).toBe(1);
	});

	it('isHexColor: anchors the opaque pattern', function () {
		expect(helpers.isHexColor('x#ffffff', { alpha: false })).toBe(false);
	});

	it('isNumericString: accepts bare fractions with several digits', function () {
		expect(helpers.isNumericString('.25')).toBe(true);
		expect(helpers.isNumericString('-.125e2')).toBe(true);
	});
});
