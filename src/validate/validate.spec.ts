import { isIntegerInRange, isLiteral, isNumber, isOneOf, isString, ValidationError, withMessage } from '../guards/index.js';
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
	it('ignores options inherited from a polluted Object.prototype', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		polluted.protocols = ['javascript', 'data'];
		polluted.requireTld = true;
		try {
			expect(helpers.isUrl('javascript:alert(1)')).toBe(false);
			expect(helpers.isUrl('javascript:alert(1)', {})).toBe(false);
			expect(helpers.isUrl('data:text/html,<script>alert(1)</script>', {})).toBe(false);
			expect(helpers.isUrl('http://localhost:3000')).toBe(true);
			expect(helpers.isUrl('http://localhost:3000', {})).toBe(true);
			// Own options still apply.
			expect(helpers.isUrl('javascript:alert(1)', { protocols: ['javascript'] })).toBe(true);
			expect(helpers.isUrl('http://localhost:3000', { requireTld: true })).toBe(false);
			expect(helpers.isUrl('http://localhost:3000', { requireTld: false })).toBe(true);
		} finally {
			delete polluted.protocols;
			delete polluted.requireTld;
		}
	});

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

	it('ignores an alpha option inherited from a polluted Object.prototype', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		polluted.alpha = false;
		try {
			expect(helpers.isHexColor('#ff800080', {})).toBe(true);
			expect(helpers.isHexColor('#ff800080', { alpha: true })).toBe(true);
			expect(helpers.isHexColor('#ff800080', { alpha: false })).toBe(false);
		} finally {
			delete polluted.alpha;
		}
		// An option inherited from another prototype counts.
		expect(helpers.isHexColor('#ff800080', Object.create({ alpha: false }) as helpers.IsHexColorOptions)).toBe(false);
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
	it('reads its options as own properties only', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		polluted.urlSafe = true;
		polluted.padding = 'forbidden';
		try {
			expect(helpers.isBase64('AA==')).toBe(true);
			expect(helpers.isBase64('-_8')).toBe(false);
			expect(helpers.isBase64('AA==', {})).toBe(true);
		} finally {
			delete polluted.urlSafe;
			delete polluted.padding;
		}
	});

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

describe('isUrl IDNA mapping', function () {
	const original = globalThis.URL;

	afterEach(function () {
		globalThis.URL = original;
	});

	it('rejects a non-ASCII label that IDNA maps to plain ASCII', function () {
		// UTS #46 before 15.1 (older ICU) case-folds `ẞ` to `ss`; newer versions keep `ß`, so the mapping is stubbed.
		(globalThis as any).URL = function (this: any, input: string) {
			this.hostname = input === 'https://ẞa.com' ? 'ssa.com' : new original(input).hostname;
		};
		expect(helpers.isUrl('https://ẞa.com')).toBe(false);
		expect(helpers.isUrl('https://münchen.de')).toBe(true);
	});

	it('follows the runtime IDNA mapping of `ẞ`', function () {
		expect(helpers.isUrl('https://ẞa.com')).toBe(new original('https://ẞa.com').hostname.startsWith('xn--'));
	});
});

describe('validate (helper review regressions)', function () {
	it('lazy schemas wrapped by nullable, union and transform resolve on the first parse, not when wrapped', function () {
		type List = { v: number; next: List | null };
		const list: helpers.Parser<List> = helpers.lazy(function () {
			return { v: isNumber, next: helpers.nullable(list) };
		});
		expect(helpers.parse(list, { v: 1, next: { v: 2, next: null } })).toEqual({ v: 1, next: { v: 2, next: null } });
		const nested: helpers.Parser<number> = helpers.lazy(function () {
			return helpers.union(isNumber, nested);
		});
		expect(helpers.parse(nested, 1)).toBe(1);
		let calls = 0;
		const counted = helpers.lazy(function () {
			calls++;
			return { x: helpers.asInteger };
		});
		const wrapped = helpers.transform(helpers.nullable(helpers.blankAsUndefined(helpers.chain(counted, counted))), function (value) {
			return value;
		});
		expect(calls).toBe(0);
		expect(helpers.parse(wrapped, { x: '3' })).toEqual({ x: 3 });
		expect(calls).toBe(1);
	});

	it('partial and optional leave blank fields out when their schema treats blanks as missing', function () {
		const form = { name: helpers.blankAsUndefined(isString), age: helpers.blankAsUndefined(helpers.asInteger) };
		expect(helpers.parse(helpers.partial(form), { name: '', age: ' ' })).toEqual({});
		expect(helpers.parse(helpers.partial(form), { name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 });
		expect(helpers.parse(helpers.optional(helpers.blankAsUndefined(isString)), '')).toBeUndefined();
		expect(helpers.safeParse(form, { name: '', age: '1' })[0]?.issues).toEqual([{ message: 'Missing required property', path: ['name'] }]);
	});
});

describe('parseEnv', function () {
	const { parseEnv, asInteger, asBoolean, asList, asJson, withDefault, optional, chain, withError, blankAsUndefined, isUrl } = helpers;

	/** Runs `fn` and returns the error it throws. */
	function thrown(fn: () => unknown): ValidationError {
		try {
			fn();
		} catch (error) {
			return error as ValidationError;
		}
		throw new Error('expected a throw');
	}

	it('parses the declared variables, typed, and leaves the others out', function () {
		const env = parseEnv(
			{
				DATABASE_URL: isUrl,
				PORT: withDefault(asInteger, 3000),
				DEBUG: withDefault(asBoolean, false),
				ORIGINS: asList(isUrl),
				MODE: isOneOf(['dev', 'prod'])
			},
			{ DATABASE_URL: 'https://db.example.com', PORT: ' 8080 ', ORIGINS: 'https://a.com, https://b.com', MODE: 'prod', HOME: '/root' }
		);
		expect(env).toEqual({ DATABASE_URL: 'https://db.example.com', PORT: 8080, DEBUG: false, ORIGINS: ['https://a.com', 'https://b.com'], MODE: 'prod' });
		const typed: { PORT: number; DEBUG: boolean; ORIGINS: string[]; MODE: 'dev' | 'prod' } = env;
		expect(typed.PORT).toBe(8080);
	});

	it('leaves optional variables that are not set out of the output', function () {
		const env = parseEnv({ SENTRY_DSN: optional(isUrl), PORT: optional(asInteger) }, { PORT: '1' });
		expect(env).toEqual({ PORT: 1 });
		expect(Object.keys(env)).toEqual(['PORT']);
	});

	it('parses values that are not strings as they are (Vite booleans, Worker bindings)', function () {
		const binding = { get: function () {} };
		function isObject(value: unknown): value is object {
			return typeof value === 'object';
		}
		expect(parseEnv({ DEV: asBoolean, KV: isObject }, { DEV: true, KV: binding })).toEqual({ DEV: true, KV: binding });
	});

	it('reports every problem at once, one variable per line, in schema order', function () {
		const error = thrown(function () {
			return parseEnv(
				{ DATABASE_URL: isUrl, PORT: asInteger, API_KEY: isString, ORIGINS: asList(isUrl), LIMITS: asJson({ rpm: asInteger }), OK: isString },
				{ PORT: 'eighty', API_KEY: '', ORIGINS: 'https://a.com,nope', LIMITS: '{}', OK: 'fine' }
			);
		});
		expect(error).toBeInstanceOf(ValidationError);
		expect(error.name).toBe('ValidationError');
		expect(error.message).toBe(
			[
				'Invalid environment variables:',
				'  DATABASE_URL: Missing required variable',
				'  PORT: Expected an integer or an integer string (got string)',
				'  API_KEY: Missing required variable (set but blank)',
				'  ORIGINS.1: Invalid value (got string)',
				'  LIMITS: Missing required property'
			].join('\n')
		);
		expect(error.issues).toEqual([
			{ message: 'Missing required variable', path: ['DATABASE_URL'] },
			{ message: 'Expected an integer or an integer string (got string)', path: ['PORT'] },
			{ message: 'Missing required variable (set but blank)', path: ['API_KEY'] },
			{ message: 'Invalid value (got string)', path: ['ORIGINS', 1] },
			// Object keys are dropped from paths: they may come from the value.
			{ message: 'Missing required property', path: ['LIMITS'] }
		]);
		expect(error.stack?.startsWith('ValidationError: Invalid environment variables:\n  DATABASE_URL')).toBe(true);
	});

	describe('no part of a value reaches the error (review regressions)', function () {
		/** Everything an error exposes (its stack without the frames, whose line numbers would match digits). */
		function dump(error: ValidationError): string {
			const header = String(error.stack).split('\n    at ')[0];

			return [String(error), error.message, JSON.stringify(error.issues), header, String((error as Error & { cause?: unknown }).cause)].join('\n');
		}

		it('keeps only the type in `(got …)`, and drops the bounds of range messages (they may hold a normalised value)', function () {
			const { transform } = helpers;
			const error = thrown(function () {
				return parseEnv(
					{
						A: chain(asInteger, isIntegerInRange(0, 9999)),
						B: chain(asInteger, isIntegerInRange(0, 9999)),
						C: chain(helpers.asNumber, helpers.toParser(isOneOf([1, 2]))),
						D: isLiteral(1),
						E: chain(asInteger, isLiteral(1)),
						PIN: isString,
						F: asJson({ pin: isIntegerInRange(0, 9) }),
						G: chain(
							transform(isString, function (text: string) {
								return text.length;
							}),
							isIntegerInRange(0, 3)
						)
					},
					{ A: '0012345', B: '+48213', C: '4821.50', D: '00042', E: '00042', PIN: 123456, F: '{"pin": 48213}', G: '8765432' }
				);
			});
			expect(error.issues).toEqual([
				{ message: 'Expected an integer in the allowed range', path: ['A'] },
				{ message: 'Expected an integer in the allowed range', path: ['B'] },
				{ message: 'Expected one of the allowed values (got number)', path: ['C'] },
				{ message: 'Invalid value (got string)', path: ['D'] },
				{ message: 'Invalid value', path: ['E'] },
				{ message: 'Invalid value (got number)', path: ['PIN'] },
				{ message: 'Expected an integer in the allowed range', path: ['F'] },
				{ message: 'Expected an integer in the allowed range', path: ['G'] }
			]);
			for (const leak of ['12345', '48213', '4821', '42', '123456', '8765432']) expect(dump(error)).not.toContain(leak);
		});

		it('never copies messages of other validators or custom messages, which may quote the value or part of it', function () {
			const secret = 'sk_live_51HxQ_super-secret';
			const foreign = {
				'~standard': {
					version: 1 as const,
					vendor: 'zod',
					validate: function (value: unknown) {
						return { issues: [{ message: "Invalid enum value, received '" + String(value) + "'", path: [{ key: String(value) }, 3] }] };
					}
				}
			};
			const error = thrown(function () {
				return parseEnv(
					{
						A: withError(isUrl, function (value) {
							return 'Not a URL: ' + JSON.stringify(value);
						}),
						B: foreign,
						C: asList(foreign),
						D: asJson({ token: foreign }),
						E: helpers.check(
							isString,
							function () {
								return false;
							},
							'Must be at least 64 characters'
						),
						F: withMessage(isUrl, function (value) {
							return String(value).toUpperCase() + ' (got string)';
						}),
						G: {
							'~standard': {
								version: 1 as const,
								vendor: 'other',
								validate: function () {
									return { issues: [{ message: 42 as unknown as string }] };
								}
							}
						}
					},
					{ A: secret, B: secret, C: 'sk_live_one,sk_live_two', D: JSON.stringify({ token: secret }), E: secret, F: secret, G: secret }
				);
			});
			expect(error.issues).toEqual([
				{ message: 'Invalid value', path: ['A'] },
				{ message: 'Invalid value', path: ['B'] },
				{ message: 'Invalid value', path: ['C', 0] },
				{ message: 'Invalid value', path: ['C', 1] },
				{ message: 'Invalid value', path: ['D'] },
				{ message: 'Invalid value', path: ['E'] },
				{ message: 'Invalid value (got string)', path: ['F'] },
				{ message: 'Invalid value', path: ['G'] }
			]);
			for (const leak of ['sk_live', 'super', 'SK_LIVE', '51HxQ']) expect(dump(error)).not.toContain(leak);
		});

		it('drops object keys from paths: they may come from the value (JSON objects, records, unknown properties)', function () {
			const { recordOf, exact } = helpers;
			const error = thrown(function () {
				return parseEnv(
					{ CFG: asJson(recordOf(asInteger)), STRICT: asJson(exact({ a: asInteger })), LIST: asJson(helpers.arrayOf({ n: asInteger })) },
					{ CFG: '{"sk_live_secretkey": "x"}', STRICT: '{"a": 1, "sk_live_other": 2}', LIST: '[{"n": 1}, {"n": "x"}]' }
				);
			});
			expect(error.issues).toEqual([
				{ message: 'Expected an integer or an integer string (got string)', path: ['CFG'] },
				{ message: 'Unknown property', path: ['STRICT'] },
				{ message: 'Expected an integer or an integer string (got string)', path: ['LIST', 1] }
			]);
			expect(dump(error)).not.toContain('sk_live');
		});

		it('reports each problem once when dropped details make issues identical', function () {
			const error = thrown(function () {
				return parseEnv({ LIMITS: asJson({ rpm: asInteger, burst: asInteger }) }, { LIMITS: '{}' });
			});
			expect(error.issues).toEqual([{ message: 'Missing required property', path: ['LIMITS'] }]);
		});

		it('keeps its own messages intact whatever the value (no redaction pass garbling them)', function () {
			const error = thrown(function () {
				return parseEnv({ N: asInteger, M: asInteger, B: asBoolean }, { N: 'string', M: 'integer', B: 'boolean' });
			});
			expect(error.issues).toEqual([
				{ message: 'Expected an integer or an integer string (got string)', path: ['N'] },
				{ message: 'Expected an integer or an integer string (got string)', path: ['M'] },
				{ message: 'Expected a boolean or a boolean string such as "true" or "false" (got string)', path: ['B'] }
			]);
		});

		it('reports a schema that throws by the name of a built-in error only, and still checks the other variables', function () {
			const { transform } = helpers;
			const secret = 'sk_live_{not json';
			class SecretError extends Error {
				override name = 'sk_live_name';
			}
			const named = {
				get name(): string {
					throw new Error('sk_live_getter');
				}
			};
			const error = thrown(function () {
				return parseEnv(
					{
						JSON_CHECK: helpers.check(isString, function (text: string) {
							return JSON.parse(text) !== null;
						}),
						URL: transform(isString, function (text: string) {
							return new URL(text);
						}),
						CUSTOM: transform(isString, function (text: string): never {
							throw new SecretError(text);
						}),
						STRING: transform(isString, function (text: string): never {
							throw text;
						}),
						GETTER: transform(isString, function (): never {
							throw named;
						}),
						NULL: transform(isString, function (): never {
							throw null;
						}),
						PORT: asInteger
					},
					{ JSON_CHECK: secret, URL: secret, CUSTOM: secret, STRING: secret, GETTER: secret, NULL: secret, PORT: 'x' }
				);
			});
			expect(error.issues).toEqual([
				{ message: 'Invalid value (the schema threw SyntaxError)', path: ['JSON_CHECK'] },
				{ message: 'Invalid value (the schema threw TypeError)', path: ['URL'] },
				{ message: 'Invalid value (the schema threw an exception)', path: ['CUSTOM'] },
				{ message: 'Invalid value (the schema threw an exception)', path: ['STRING'] },
				{ message: 'Invalid value (the schema threw an exception)', path: ['GETTER'] },
				{ message: 'Invalid value (the schema threw an exception)', path: ['NULL'] },
				{ message: 'Expected an integer or an integer string (got string)', path: ['PORT'] }
			]);
			expect(dump(error)).not.toContain('sk_live');
		});
	});

	describe('options and environment (review regressions)', function () {
		it('reads only own options, and only own variables into a null-prototype output', function () {
			const polluted = Object.prototype as Record<string, unknown>;
			polluted.prefix = 'EVIL_';
			polluted.strict = true;
			polluted.blankAsMissing = false;
			polluted.ADMIN_TOKEN = 'attacker';
			try {
				const env = parseEnv({ PORT: withDefault(asInteger, 1), ADMIN_TOKEN: optional(isString) }, { PORT: '', EVIL_PORT: '666' });
				expect(env).toEqual({ PORT: 1 });
				expect(env.ADMIN_TOKEN).toBeUndefined();
				expect(Object.getPrototypeOf(env)).toBeNull();
			} finally {
				delete polluted.prefix;
				delete polluted.strict;
				delete polluted.blankAsMissing;
				delete polluted.ADMIN_TOKEN;
			}
		});

		it('requires boolean flags and an options object', function () {
			expect(function () {
				parseEnv({}, {}, { strict: 'false' as unknown as boolean, prefix: 'APP_' });
			}).toThrow(new TypeError('parseEnv: `strict` must be a boolean, got string'));
			expect(function () {
				parseEnv({}, {}, { blankAsMissing: 0 as unknown as boolean });
			}).toThrow(new TypeError('parseEnv: `blankAsMissing` must be a boolean, got number'));
			expect(function () {
				parseEnv({}, {}, null as unknown as object);
			}).toThrow(new TypeError('parseEnv: `options` must be an object, got null'));
			expect(parseEnv({}, {}, { prefix: undefined, strict: undefined, blankAsMissing: undefined })).toEqual({});
		});

		it('rejects a Map and Deno.env-like objects, whose variables would all look unset', function () {
			expect(function () {
				parseEnv({ PORT: asInteger }, new Map([['PORT', '1']]));
			}).toThrow(new TypeError('parseEnv: `env` must be an object of variables, got Map (pass `Object.fromEntries(map)`)'));
			class DenoEnv {
				get(_name: string): string | undefined {
					return '1';
				}
				toObject(): Record<string, string> {
					return { PORT: '1' };
				}
			}
			expect(function () {
				parseEnv({ PORT: asInteger }, new DenoEnv());
			}).toThrow(new TypeError('parseEnv: `env` must be an object of variables, got an object with `get` and `toObject` methods (pass `Deno.env.toObject()`)'));
			expect(parseEnv({ PORT: asInteger }, new DenoEnv().toObject())).toEqual({ PORT: 1 });
			// Variables named like the methods are fine, and so is an empty environment.
			expect(parseEnv({ get: optional(isString) }, { get: 'x', toObject: 'y' })).toEqual({ get: 'x' });
			expect(parseEnv({ A: optional(isString) }, {})).toEqual({});
			expect(parseEnv({ A: optional(isString) }, { get: function () {} })).toEqual({});
			// The real `Deno.env` is an object literal of five methods (ext/os/30_os.js), and is recognized by identity too.
			const store: Record<string, string> = { PORT: '1' };
			const literal = {
				get(key: string): string | undefined {
					return store[key];
				},
				toObject(): Record<string, string> {
					return { ...store };
				},
				set(key: string, value: string): void {
					store[key] = value;
				},
				has(key: string): boolean {
					return store[key] !== undefined;
				},
				delete(key: string): void {
					delete store[key];
				}
			};
			expect(function () {
				parseEnv({ PORT: asInteger }, literal);
			}).toThrow('pass `Deno.env.toObject()`');
			// Variables next to such methods: an environment after all.
			expect(parseEnv({ PORT: asInteger }, { ...literal, PORT: '1' })).toEqual({ PORT: 1 });
			const global = globalThis as { Deno?: unknown };
			global.Deno = { env: new Map() };
			try {
				expect(function () {
					parseEnv({ PORT: asInteger }, (global.Deno as { env: object }).env);
				}).toThrow(TypeError);
				global.Deno = { env: Object.freeze({ toObject: 1 }) };
				expect(function () {
					parseEnv({ PORT: optional(isString) }, (global.Deno as { env: object }).env);
				}).toThrow('pass `Deno.env.toObject()`');
				expect(parseEnv({ PORT: optional(isString) }, { PORT: 'x' })).toEqual({ PORT: 'x' });
				global.Deno = null;
				expect(parseEnv({ PORT: optional(isString) }, {})).toEqual({});
			} finally {
				delete global.Deno;
			}
			// A polluted `Object.prototype` does not make a plain object look like `Deno.env`.
			const polluted = Object.prototype as Record<string, unknown>;
			polluted.get = function () {};
			polluted.toObject = function () {};
			try {
				expect(parseEnv({ A: optional(isString) }, {})).toEqual({});
			} finally {
				delete polluted.get;
				delete polluted.toObject;
			}
		});
	});

	describe('blank values', function () {
		it('count as unset by default: required ones fail as missing, defaults apply', function () {
			expect(parseEnv({ PORT: withDefault(asInteger, 3000), NAME: optional(isString) }, { PORT: '', NAME: ' \t\n' })).toEqual({ PORT: 3000 });
			expect(
				thrown(function () {
					return parseEnv({ TOKEN: isString }, { TOKEN: '   ' });
				}).issues
			).toEqual([{ message: 'Missing required variable (set but blank)', path: ['TOKEN'] }]);
		});

		it('are passed to the schema with blankAsMissing: false', function () {
			expect(parseEnv({ PREFIX: withDefault(isString, '/api') }, { PREFIX: '' }, { blankAsMissing: false })).toEqual({ PREFIX: '' });
			expect(
				thrown(function () {
					return parseEnv({ PORT: withDefault(asInteger, 3000) }, { PORT: '' }, { blankAsMissing: false });
				}).issues
			).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['PORT'] }]);
			// The schema's own blank handling still counts a blank value as missing.
			expect(
				thrown(function () {
					return parseEnv({ PORT: blankAsUndefined(asInteger) }, { PORT: ' ' }, { blankAsMissing: false });
				}).issues
			).toEqual([{ message: 'Missing required variable (set but blank)', path: ['PORT'] }]);
			expect(parseEnv({ PORT: blankAsUndefined(optional(asInteger)) }, { PORT: ' ' }, { blankAsMissing: false })).toEqual({});
		});

		it('reports the real problem of a default that fails a later check', function () {
			const port = chain(withDefault(asInteger, 0), isIntegerInRange(1, 65535));
			expect(
				thrown(function () {
					return parseEnv({ PORT: port }, {});
				}).issues
			).toEqual([{ message: 'Expected an integer in the allowed range', path: ['PORT'] }]);
		});
	});

	describe('prefix and strict', function () {
		it('reads prefixed names, returns unprefixed keys and reports full names', function () {
			const schema = { API_URL: isUrl, DEBUG: withDefault(asBoolean, false) };
			expect(parseEnv(schema, { VITE_API_URL: 'https://api.example.com', VITE_DEBUG: 'on', API_URL: 'nope' }, { prefix: 'VITE_' })).toEqual({
				API_URL: 'https://api.example.com',
				DEBUG: true
			});
			expect(
				thrown(function () {
					return parseEnv(schema, { API_URL: 'https://api.example.com', VITE_DEBUG: 'maybe' }, { prefix: 'VITE_' });
				}).issues
			).toEqual([
				{ message: 'Missing required variable', path: ['VITE_API_URL'] },
				{ message: 'Expected a boolean or a boolean string such as "true" or "false" (got string)', path: ['VITE_DEBUG'] }
			]);
		});

		it('reports unknown prefixed variables with strict, sorted by name, after the other problems', function () {
			const env = { APP_PORT: 'x', APP_PROT: '80', APP_A: '', HOME: '/root', PORT: '1' };
			expect(
				thrown(function () {
					return parseEnv({ PORT: asInteger }, env, { prefix: 'APP_', strict: true });
				}).issues
			).toEqual([
				{ message: 'Expected an integer or an integer string (got string)', path: ['APP_PORT'] },
				{ message: 'Unknown variable', path: ['APP_A'] },
				{ message: 'Unknown variable', path: ['APP_PROT'] }
			]);
			expect(parseEnv({ PORT: asInteger }, { APP_PORT: '1', HOME: '/root' }, { prefix: 'APP_', strict: true })).toEqual({ PORT: 1 });
		});

		it('rejects strict without a prefix, and a prefix that is not a string', function () {
			expect(function () {
				parseEnv({}, {}, { strict: true });
			}).toThrow(new RangeError('parseEnv: `prefix` must be a non-empty string with `strict`, got empty string'));
			expect(function () {
				parseEnv({}, {}, { prefix: 1 as unknown as string });
			}).toThrow(new TypeError('parseEnv: `prefix` must be a string, got number'));
		});
	});

	describe('the environment', function () {
		it('defaults to process.env', function () {
			process.env.TINKIT_PARSE_ENV_TEST = '42';
			try {
				expect(parseEnv({ TINKIT_PARSE_ENV_TEST: asInteger })).toEqual({ TINKIT_PARSE_ENV_TEST: 42 });
				expect(parseEnv({ TEST: asInteger }, undefined, { prefix: 'TINKIT_PARSE_ENV_' })).toEqual({ TEST: 42 });
			} finally {
				delete process.env.TINKIT_PARSE_ENV_TEST;
			}
		});

		it('throws a clear error when there is no process.env', function () {
			const original = Object.getOwnPropertyDescriptor(globalThis, 'process') as PropertyDescriptor;
			const message =
				'parseEnv: `env` was not given and `process.env` is not available in this environment; pass the variables, e.g. `parseEnv(schema, import.meta.env)`';
			for (const value of [undefined, {}, { env: null }, { env: 'A=1' }]) {
				Object.defineProperty(globalThis, 'process', { value, configurable: true, writable: true });
				try {
					expect(function () {
						parseEnv({ A: optional(isString) });
					}).toThrow(new Error(message));
				} finally {
					Object.defineProperty(globalThis, 'process', original);
				}
			}
		});

		it('rejects an env that is not an object', function () {
			for (const [value, got] of [
				[null, 'null'],
				['A=1', 'string'],
				[1, 'number']
			] as const) {
				expect(function () {
					parseEnv({}, value as unknown as object);
				}).toThrow(new TypeError('parseEnv: `env` must be an object, got ' + got));
			}
		});

		it('reads each declared variable once, as an own property only', function () {
			const reads: PropertyKey[] = [];
			const env = new Proxy({ PORT: '1', OTHER: 'x' } as Record<string, string>, {
				get(target, property, receiver) {
					reads.push(property);
					return Reflect.get(target, property, receiver);
				}
			});
			expect(parseEnv({ PORT: asInteger, MISSING: optional(isString) }, env)).toEqual({ PORT: 1 });
			expect(reads).toEqual(['PORT']);
			const inherited = Object.create({ PORT: '1' }) as object;
			expect(
				thrown(function () {
					return parseEnv({ PORT: asInteger }, inherited);
				}).issues
			).toEqual([{ message: 'Missing required variable', path: ['PORT'] }]);
		});

		it('ignores a polluted Object.prototype and handles keys such as __proto__', function () {
			(Object.prototype as Record<string, unknown>).TINKIT_POLLUTED = 'https://evil.example.com';
			try {
				expect(
					thrown(function () {
						return parseEnv({ TINKIT_POLLUTED: isUrl }, {});
					}).issues
				).toEqual([{ message: 'Missing required variable', path: ['TINKIT_POLLUTED'] }]);
			} finally {
				delete (Object.prototype as Record<string, unknown>).TINKIT_POLLUTED;
			}
			const schema: Record<string, unknown> = {};
			Object.defineProperty(schema, '__proto__', { value: optional(asInteger), enumerable: true, writable: true, configurable: true });
			schema['constructor'] = optional(isString);
			const env = JSON.parse('{"__proto__": "7", "constructor": "x"}') as object;
			const output = parseEnv(schema as Record<string, typeof isString>, env) as Record<string, unknown>;
			expect(Object.getPrototypeOf(output)).toBeNull();
			expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toBe(7);
			expect(output['constructor']).toBe('x');
		});
	});

	describe('schema errors', function () {
		it('rejects schemas that are not plain objects of schemas, before reading the environment', function () {
			const env = new Proxy(
				{},
				{
					get(): never {
						throw new Error('read');
					},
					getOwnPropertyDescriptor(): never {
						throw new Error('read');
					}
				}
			);
			expect(function () {
				parseEnv(isString as unknown as Record<string, typeof isString>, env);
			}).toThrow(new TypeError('parseEnv: `schema` must be a plain object of schemas, got function'));
			expect(function () {
				parseEnv([isString] as unknown as Record<string, typeof isString>, env);
			}).toThrow(new TypeError('parseEnv: `schema` must be a plain object of schemas, got array'));
			expect(function () {
				parseEnv(asInteger as unknown as Record<string, typeof isString>, env);
			}).toThrow(TypeError);
			expect(function () {
				parseEnv({ PORT: 3000 } as unknown as Record<string, typeof isString>, env);
			}).toThrow(new TypeError('parseEnv: `schema.PORT` must be a guard, a parser or a plain object of schemas, got number'));
			const circular: Record<string, unknown> = {};
			circular.SELF = circular;
			expect(function () {
				parseEnv(circular as Record<string, typeof isString>, env);
			}).toThrow(new TypeError('parseEnv: `schema.SELF` must be acyclic, got a circular reference'));
		});

		it('reports a nested object schema against a string as an invalid value', function () {
			expect(
				thrown(function () {
					return parseEnv({ DB: { HOST: isString } }, { DB: 'localhost' });
				}).issues
			).toEqual([{ message: 'Expected an object (got string)', path: ['DB'] }]);
			expect(parseEnv({ N: withMessage(isNumber, 'x') }, { N: 1 })).toEqual({ N: 1 });
		});
	});
});

/** The parts of node-semver (the reference implementation, a development dependency used only by the tests) that the tests call. */
interface NodeSemver {
	satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
	validRange(range: string, options?: { includePrerelease?: boolean }): string | null;
	inc(version: string, release: string, options: undefined, identifier?: string, identifierBase?: '0' | '1' | false): string | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeSemver = require('semver') as NodeSemver;

/** node-semver's `range-include` fixtures that do not need `loose`: [range, version, includePrerelease]. */
const RANGE_INCLUDE: [string, string, boolean?][] = [
	['1.0.0 - 2.0.0', '1.2.3'],
	['^1.2.3+build', '1.2.3'],
	['^1.2.3+build', '1.3.0'],
	['1.2.3-pre+asdf - 2.4.3-pre+asdf', '1.2.3'],
	['1.2.3-pre+asdf - 2.4.3-pre+asdf', '1.2.3-pre.2'],
	['1.2.3-pre+asdf - 2.4.3-pre+asdf', '2.4.3-alpha'],
	['1.2.3+asdf - 2.4.3+asdf', '1.2.3'],
	['1.0.0', '1.0.0'],
	['>=*', '0.2.4'],
	['', '1.0.0'],
	['*', '1.2.3'],
	['*', 'v1.2.3'],
	['>=1.0.0', '1.0.0'],
	['>=1.0.0', '1.0.1'],
	['>=1.0.0', '1.1.0'],
	['>1.0.0', '1.0.1'],
	['>1.0.0', '1.1.0'],
	['<=2.0.0', '2.0.0'],
	['<=2.0.0', '1.9999.9999'],
	['<=2.0.0', '0.2.9'],
	['<2.0.0', '1.9999.9999'],
	['<2.0.0', '0.2.9'],
	['>= 1.0.0', '1.0.0'],
	['>=  1.0.0', '1.0.1'],
	['>=   1.0.0', '1.1.0'],
	['> 1.0.0', '1.0.1'],
	['>  1.0.0', '1.1.0'],
	['<=   2.0.0', '2.0.0'],
	['<= 2.0.0', '1.9999.9999'],
	['<=  2.0.0', '0.2.9'],
	['<    2.0.0', '1.9999.9999'],
	['<\t2.0.0', '0.2.9'],
	['>=0.1.97', 'v0.1.97'],
	['>=0.1.97', '0.1.97'],
	['0.1.20 || 1.2.4', '1.2.4'],
	['>=0.2.3 || <0.0.1', '0.0.0'],
	['>=0.2.3 || <0.0.1', '0.2.3'],
	['>=0.2.3 || <0.0.1', '0.2.4'],
	['||', '1.3.4'],
	['2.x.x', '2.1.3'],
	['1.2.x', '1.2.3'],
	['1.2.x || 2.x', '2.1.3'],
	['1.2.x || 2.x', '1.2.3'],
	['x', '1.2.3'],
	['2.*.*', '2.1.3'],
	['1.2.*', '1.2.3'],
	['1.2.* || 2.*', '2.1.3'],
	['1.2.* || 2.*', '1.2.3'],
	['2', '2.1.2'],
	['2.3', '2.3.1'],
	['~0.0.1', '0.0.1'],
	['~0.0.1', '0.0.2'],
	['~x', '0.0.9'],
	['~2', '2.0.9'],
	['~2.4', '2.4.0'],
	['~2.4', '2.4.5'],
	['~>3.2.1', '3.2.2'],
	['~1', '1.2.3'],
	['~>1', '1.2.3'],
	['~> 1', '1.2.3'],
	['~1.0', '1.0.2'],
	['~ 1.0', '1.0.2'],
	['~ 1.0.3', '1.0.12'],
	['>=1', '1.0.0'],
	['>= 1', '1.0.0'],
	['<1.2', '1.1.1'],
	['< 1.2', '1.1.1'],
	['~v0.5.4-pre', '0.5.5'],
	['~v0.5.4-pre', '0.5.4'],
	['=0.7.x', '0.7.2'],
	['<=0.7.x', '0.7.2'],
	['>=0.7.x', '0.7.2'],
	['<=0.7.x', '0.6.2'],
	['~1.2.1 >=1.2.3', '1.2.3'],
	['~1.2.1 =1.2.3', '1.2.3'],
	['~1.2.1 1.2.3', '1.2.3'],
	['~1.2.1 >=1.2.3 1.2.3', '1.2.3'],
	['~1.2.1 1.2.3 >=1.2.3', '1.2.3'],
	['>=1.2.1 1.2.3', '1.2.3'],
	['1.2.3 >=1.2.1', '1.2.3'],
	['>=1.2.3 >=1.2.1', '1.2.3'],
	['>=1.2.1 >=1.2.3', '1.2.3'],
	['>=1.2', '1.2.8'],
	['^1.2.3', '1.8.1'],
	['^0.1.2', '0.1.2'],
	['^0.1', '0.1.2'],
	['^0.0.1', '0.0.1'],
	['^1.2', '1.4.2'],
	['^1.2 ^1', '1.4.2'],
	['^1.2.3-alpha', '1.2.3-pre'],
	['^1.2.0-alpha', '1.2.0-pre'],
	['^0.0.1-alpha', '0.0.1-beta'],
	['^0.0.1-alpha', '0.0.1'],
	['^0.1.1-alpha', '0.1.1-beta'],
	['^x', '1.2.3'],
	['x - 1.0.0', '0.9.7'],
	['x - 1.x', '0.9.7'],
	['1.0.0 - x', '1.9.7'],
	['1.x - x', '1.9.7'],
	['<=7.x', '7.9.9'],
	['2.x', '2.0.0-pre.0', true],
	['2.x', '2.1.0-pre.0', true],
	['1.1.x', '1.1.0-a', true],
	['1.1.x', '1.1.1-a', true],
	['*', '1.0.0-rc1', true],
	['^1.0.0-0', '1.0.1-rc1', true],
	['^1.0.0-rc2', '1.0.1-rc1', true],
	['^1.0.0', '1.0.1-rc1', true],
	['^1.0.0', '1.1.0-rc1', true],
	['1 - 2', '2.0.0-pre', true],
	['1 - 2', '1.0.0-pre', true],
	['1.0 - 2', '1.0.0-pre', true],
	['=0.7.x', '0.7.0-asdf', true],
	['>=0.7.x', '0.7.0-asdf', true],
	['<=0.7.x', '0.7.0-asdf', true],
	['>=1.0.0 <=1.1.0', '1.1.0-pre', true]
];

/** node-semver's `range-exclude` fixtures that do not need `loose`: [range, version, includePrerelease]. */
const RANGE_EXCLUDE: [string, string, boolean?][] = [
	['1.0.0 - 2.0.0', '2.2.3'],
	['1.2.3+asdf - 2.4.3+asdf', '1.2.3-pre.2'],
	['1.2.3+asdf - 2.4.3+asdf', '2.4.3-alpha'],
	['^1.2.3+build', '2.0.0'],
	['^1.2.3+build', '1.2.0'],
	['^1.2.3', '1.2.3-pre'],
	['^1.2', '1.2.0-pre'],
	['>1.2', '1.3.0-beta'],
	['<=1.2.3', '1.2.3-beta'],
	['^1.2.3', '1.2.3-beta'],
	['=0.7.x', '0.7.0-asdf'],
	['>=0.7.x', '0.7.0-asdf'],
	['<=0.7.x', '0.7.0-asdf'],
	['1.0.0', '1.0.1'],
	['>=1.0.0', '0.0.0'],
	['>=1.0.0', '0.0.1'],
	['>=1.0.0', '0.1.0'],
	['>1.0.0', '0.0.1'],
	['>1.0.0', '0.1.0'],
	['<=2.0.0', '3.0.0'],
	['<=2.0.0', '2.9999.9999'],
	['<=2.0.0', '2.2.9'],
	['<2.0.0', '2.9999.9999'],
	['<2.0.0', '2.2.9'],
	['>=0.1.97', 'v0.1.93'],
	['>=0.1.97', '0.1.93'],
	['0.1.20 || 1.2.4', '1.2.3'],
	['>=0.2.3 || <0.0.1', '0.0.3'],
	['>=0.2.3 || <0.0.1', '0.2.2'],
	['2.x.x', '1.1.3'],
	['2.x.x', '3.1.3'],
	['1.2.x', '1.3.3'],
	['1.2.x || 2.x', '3.1.3'],
	['1.2.x || 2.x', '1.1.3'],
	['2.*.*', '1.1.3'],
	['2.*.*', '3.1.3'],
	['1.2.*', '1.3.3'],
	['1.2.* || 2.*', '3.1.3'],
	['1.2.* || 2.*', '1.1.3'],
	['2', '1.1.2'],
	['2.3', '2.4.1'],
	['~0.0.1', '0.1.0-alpha'],
	['~0.0.1', '0.1.0'],
	['~2.4', '2.5.0'],
	['~2.4', '2.3.9'],
	['~>3.2.1', '3.3.2'],
	['~>3.2.1', '3.2.0'],
	['~1', '0.2.3'],
	['~>1', '2.2.3'],
	['~1.0', '1.1.0'],
	['<1', '1.0.0'],
	['>=1.2', '1.1.1'],
	['~v0.5.4-beta', '0.5.4-alpha'],
	['=0.7.x', '0.8.2'],
	['>=0.7.x', '0.6.2'],
	['<0.7.x', '0.7.2'],
	['<1.2.3', '1.2.3-beta'],
	['=1.2.3', '1.2.3-beta'],
	['>1.2', '1.2.8'],
	['^0.0.1', '0.0.2-alpha'],
	['^0.0.1', '0.0.2'],
	['^1.2.3', '2.0.0-alpha'],
	['^1.2.3', '1.2.2'],
	['^1.2', '1.1.9'],
	['*', 'v1.2.3-foo'],
	['*', 'not a version'],
	['>=2', 'glorp'],
	['2.x', '3.0.0-pre.0', true],
	['^1.0.0', '1.0.0-rc1', true],
	['^1.0.0', '2.0.0-rc1', true],
	['^1.2.3-rc2', '2.0.0', true],
	['^1.0.0', '2.0.0-rc1'],
	['1 - 2', '3.0.0-pre', true],
	['1 - 2', '2.0.0-pre'],
	['1 - 2', '1.0.0-pre'],
	['1.0 - 2', '1.0.0-pre'],
	['1.1.x', '1.0.0-a'],
	['1.1.x', '1.1.0-a'],
	['1.1.x', '1.2.0-a'],
	['1.1.x', '1.2.0-a', true],
	['1.1.x', '1.0.0-a', true],
	['1.x', '1.0.0-a'],
	['1.x', '1.1.0-a'],
	['1.x', '1.2.0-a'],
	['1.x', '0.0.0-a', true],
	['1.x', '2.0.0-a', true],
	['>=1.0.0 <1.1.0', '1.1.0'],
	['>=1.0.0 <1.1.0', '1.1.0', true],
	['>=1.0.0 <1.1.0', '1.1.0-pre'],
	['>=1.0.0 <1.1.0-pre', '1.1.0-pre']
];

/**
 * Asserts that both implementations give `expected` for a version and a range.
 * @param {string} range - The range
 * @param {string} version - The version
 * @param {boolean} includePrerelease - The option
 * @param {boolean} expected - The expected answer
 */
function expectSatisfies(range: string, version: string, includePrerelease: boolean, expected: boolean): void {
	const options = { includePrerelease };
	expect([range, version, nodeSemver.satisfies(version, range, options), helpers.satisfiesSemver(version, range, options)]).toEqual([range, version, expected, expected]);
	const valid = helpers.isSemverRange(range, options);
	expect([range, valid]).toEqual([range, nodeSemver.validRange(range, options) !== null]);
	if (valid) expect(helpers.compileSemverRange(range, options)(version)).toBe(expected);
}

describe('satisfiesSemver', function () {
	it.each(RANGE_INCLUDE)('%j includes %j (includePrerelease: %j), as in node-semver', function (range, version, includePrerelease = false) {
		expectSatisfies(range, version, includePrerelease, true);
	});

	it.each(RANGE_EXCLUDE)('%j excludes %j (includePrerelease: %j), as in node-semver', function (range, version, includePrerelease = false) {
		expectSatisfies(range, version, includePrerelease, false);
	});

	it('desugars carets, tildes, X-ranges and hyphen ranges like node-semver', function () {
		const cases: [string, string[], string[]][] = [
			['^1.2.3', ['1.2.3', '1.9.9'], ['1.2.2', '2.0.0', '2.0.0-0']],
			['^0.2.3', ['0.2.3', '0.2.9'], ['0.3.0', '0.2.2']],
			['^0.0.3', ['0.0.3'], ['0.0.4', '0.0.2']],
			['^0.0', ['0.0.0', '0.0.9'], ['0.1.0']],
			['^0.x', ['0.0.0', '0.9.9'], ['1.0.0']],
			['^1.x.3', ['1.0.0', '1.9.9'], ['2.0.0']],
			['~1.2.3', ['1.2.3', '1.2.9'], ['1.3.0', '1.2.2']],
			['~1.x.3', ['1.0.0', '1.9.9'], ['2.0.0']],
			['~0', ['0.0.0', '0.9.9'], ['1.0.0']],
			['1.2.3 - 2.3.4', ['1.2.3', '2.3.4'], ['1.2.2', '2.3.5']],
			['1.2 - 2.3', ['1.2.0', '2.3.9'], ['1.1.9', '2.4.0']],
			['1.x.5 - 2', ['1.0.0', '2.9.9'], ['0.9.9', '3.0.0']],
			['1 - 1.2.0', ['1.0.0', '1.2.0'], ['1.2.1', '1.3.0']],
			['0.5.0 - 1', ['0.5.0', '1.9.9'], ['0.1.0', '2.0.0']],
			['0 - 0.5', ['0.0.0', '0.5.9'], ['0.6.0']],
			['1 - 0.0.0', [], ['0.0.1', '1.0.0']],
			['1.0.0 - 1.0', ['1.0.0', '1.0.9'], ['1.1.0']],
			['>1', ['2.0.0'], ['1.9.9']],
			['>1.2', ['1.3.0'], ['1.2.9']],
			['<=1', ['1.9.9'], ['2.0.0']],
			['>=1.x', ['1.0.0'], ['0.9.9']],
			['<1.x', ['0.9.9'], ['1.0.0']],
			['>x', [], ['0.0.0', '1.0.0']],
			['<*', [], ['0.0.0']],
			['<=*', ['0.0.0', '9.9.9'], []],
			['=1.x', ['1.5.0'], ['2.0.0']],
			['>1.0', ['1.1.0', '1.5.0'], ['1.0.9']],
			['<=1.0', ['1.0.9'], ['1.1.0']],
			['^0.0.0', ['0.0.0'], ['0.0.1', '0.0.5']],
			['1.0.5-beta - 2', ['1.0.5-gamma'], ['1.0.4']],
			['1.2.0-beta - 2', ['1.2.0-gamma'], ['1.1.9']],
			['==1.x', ['1.5.0'], ['2.0.0']],
			['v=1.2.x', ['1.2.5'], ['1.3.0']]
		];
		for (const [range, inside, outside] of cases) {
			for (const version of inside) expectSatisfies(range, version, false, true);
			for (const version of outside) expectSatisfies(range, version, false, false);
		}
	});

	it('only lets pre-releases through comparators on the same major.minor.patch, unless includePrerelease is set', function () {
		expectSatisfies('>=1.2.3-beta.1', '1.2.3-beta.2', false, true);
		expectSatisfies('>=1.2.3-beta.1', '1.2.4-beta', false, false);
		expectSatisfies('>=1.2.3-beta.1', '1.2.4-beta', true, true);
		expectSatisfies('>1.0.0-alpha <2.0.0', '1.5.0-beta', false, false);
		expectSatisfies('>1.0.0-alpha <2.0.0 || 1.5.0-alpha', '1.5.0-beta', false, false);
		expectSatisfies('>1.0.0-alpha <2.0.0 || >=1.5.0-alpha', '1.5.0-beta', false, true);
		expectSatisfies('1.2.3-beta', '1.2.3-beta', false, true);
		expectSatisfies('<1.2.3-beta', '1.2.3-alpha', false, true);
		expectSatisfies('<1.2.3-beta', '1.2.3-gamma', false, false);
		// The range has a pre-release, but the comparator that allows it belongs to another alternative.
		expectSatisfies('^1.2.3-beta || ^2.0.0', '2.0.0-beta', false, false);
		// `>=0.0.0` is dropped like `*`, but `>=0.0.0-0` keeps 0.0.0 pre-releases.
		expectSatisfies('>=0.0.0', '0.0.0-0', false, false);
		expectSatisfies('>=0.0.0-0', '0.0.0-0', false, true);
		expectSatisfies('>=0.0.0', '0.0.0-0', true, false);
		expectSatisfies('>=0.0.0-0', '0.0.0-0', true, true);
		expectSatisfies('>=v0.0.0', '0.0.1', false, true);
		expectSatisfies('^0.0.0-alpha', '0.0.0-beta', false, true);
		// The `-0` of a desugared upper bound still matters when another comparator lets pre-releases of that version through.
		expectSatisfies('>=1.2.0-alpha <1.2', '1.2.0-beta', false, false);
		expectSatisfies('>=1.3.0-alpha <=1.2', '1.3.0-beta', false, false);
		expectSatisfies('<1.2.x >=1.2.0-alpha', '1.2.0-beta', false, false);
		expectSatisfies('>=1.2.0-alpha <1.2.0', '1.2.0-beta', false, true);
		// Only `>=0.0.0` allows any release: other comparators on 0.0.0 are kept.
		expectSatisfies('0.0.0', '1.0.0', false, false);
		expectSatisfies('=0.0.0', '0.0.1', false, false);
		expectSatisfies('<0.0.0', '0.0.1', false, false);
		expectSatisfies('<=0.0.0', '0.0.1', false, false);
		expectSatisfies('>0.0.0', '0.0.0', false, false);
		expectSatisfies('<0.0.0 || 1.2.3-beta', '1.2.3-beta', false, true);
	});

	it('reduces a range with an alternative allowing any version to any release, as node-semver does', function () {
		expectSatisfies('* || 1.2.3-beta', '1.2.3-beta', false, false);
		expectSatisfies('1.2.3-beta || *', '1.2.3-beta', false, false);
		expectSatisfies('1.2.3-beta || >=0.0.0', '1.2.3-beta', false, false);
		expectSatisfies('1.2.3-beta || x', '1.2.3-beta', false, false);
		expectSatisfies('1.2.3-beta || <0.0.0-0', '1.2.3-beta', false, true);
		expectSatisfies('1.2.3-beta ||', '1.2.3-beta', false, false);
		expectSatisfies('* || 1.2.3-beta', '1.2.3-beta', true, true);
		expectSatisfies('<0.0.0-0 || <0.0.0-0', '0.0.0-0', true, false);
		// Only `>=0.0.0` written exactly so, or desugared to it, counts as any version.
		expectSatisfies('>=v0.0.0 || 1.2.3-beta', '1.2.3-beta', false, true);
		expectSatisfies('>=0.x || 1.2.3-beta', '1.2.3-beta', false, false);
	});

	it('ignores build metadata wherever node-semver drops it', function () {
		expectSatisfies('1.2.3+build', '1.2.3+other', false, true);
		expectSatisfies('>=1.2.3+build.5 <2', '1.9.0', false, true);
		expectSatisfies('1+2.3.4', '1.5.0', false, true);
		expectSatisfies('^1.2+build', '1.3.0', false, true);
		expectSatisfies('=1.2.3+*b', '1.2.3', false, true);
		expectSatisfies('1.2.3+', '1.2.3', false, false);
	});

	it('reads versions like node-semver: a leading v and surrounding white space, at most 256 characters', function () {
		expectSatisfies('1.2.3', 'v1.2.3', false, true);
		expectSatisfies('1.2.3', ' \t1.2.3\n ', false, true);
		expectSatisfies('1.2.3', ' 1.2.3﻿', false, true);
		expectSatisfies('1.2.3', '=1.2.3', false, false);
		expectSatisfies('1.2.3', 'V1.2.3', false, false);
		expectSatisfies('1.2.3', 'vv1.2.3', false, false);
		expectSatisfies('*', '1.2', false, false);
		expectSatisfies('*', '01.2.3', false, false);
		expectSatisfies('*', '1.02.3', false, false);
		expectSatisfies('*', '1.2.03', false, false);
		expectSatisfies('*', '1.2.3-01', false, false);
		// The pre-release is read from after the `-`: the patch's digits do not turn `01` into an alphanumeric identifier.
		expectSatisfies('*', '1.2.3-01', true, false);
		expectSatisfies('*', '2.2.2-01', true, false);
		expectSatisfies('*', '2.2.2-0', true, true);
		expectSatisfies('*', '1.2.3-', false, false);
		expectSatisfies('*', '1.2.3-a.', false, false);
		expectSatisfies('*', '1.2.3+', false, false);
		expectSatisfies('*', '1.2.3+a.', false, false);
		expectSatisfies('*', '1.2.3+a+b', false, false);
		expectSatisfies('*', '1.x.3', false, false);
		expectSatisfies('*', 'x.2.3', false, false);
		expectSatisfies('*', '1.2.x', false, false);
		expectSatisfies('*', '1a2.3', false, false);
		expectSatisfies('*', '1.2a3', false, false);
		for (const identifier of ['A', 'Z', 'a', 'z', '0Az-9']) {
			expectSatisfies('*', `1.2.3-${identifier}`, true, true);
			expectSatisfies('*', `1.2.3+${identifier}`, false, true);
		}
		for (const character of ['@', '[', '_', '`', '{', '|', '~', '/', ':']) {
			expectSatisfies('*', `1.2.3-a${character}`, true, false);
			expectSatisfies('*', `1.2.3+a${character}`, false, false);
		}
		expectSatisfies('*', '', false, false);
		expectSatisfies('*', '9007199254740991.9007199254740991.9007199254740991', false, true);
		expectSatisfies('*', '9007199254740992.0.0', false, false);
		expectSatisfies('*', '0.9007199254740992.0', false, false);
		expectSatisfies('*', '0.0.9007199254740992', false, false);
		const longest = `1.2.3+${'b'.repeat(250)}`;
		expectSatisfies('*', longest, false, true);
		expectSatisfies('*', `${longest}b`, false, false);
		expectSatisfies('*', ` ${longest}`, false, false);
		expect(helpers.satisfiesSemver(123 as any, '*')).toBe(false);
		expect(helpers.satisfiesSemver(null as any, '*')).toBe(false);
	});

	it('compares numeric pre-release identifiers exactly, beyond Number.MAX_SAFE_INTEGER', function () {
		expect(helpers.satisfiesSemver('1.0.0-9007199254740993', '>1.0.0-9007199254740992')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-9007199254740993', '>1.0.0-9007199254740993')).toBe(false);
		expect(helpers.satisfiesSemver('1.0.0-9007199254740993', '>1.0.0-9007199254740990')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-9007199254740990', '<1.0.0-9007199254740993')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-9007199254740993', '<1.0.0-a')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-a', '>1.0.0-99999999999999999999')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-alpha.10', '>1.0.0-alpha.9')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-alpha', '<1.0.0-alpha.0')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-alpha.0', '<1.0.0-alpha')).toBe(false);
		expect(helpers.satisfiesSemver('1.0.0-alpha.0', '>1.0.0-alpha')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-alpha.0', '<=1.0.0-alpha')).toBe(false);
		expect(helpers.satisfiesSemver('1.0.0-alpha', '>=1.0.0-alpha.0')).toBe(false);
		expect(helpers.satisfiesSemver('1.0.0-B', '<1.0.0-a')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-1', '<1.0.0-2')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-2', '<1.0.0-10')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-10', '>1.0.0-9')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-1', '<1.0.0-a')).toBe(true);
		expect(helpers.satisfiesSemver('1.0.0-a', '>1.0.0-1')).toBe(true);
		// node-semver rounds both to 2^53 and calls them equal.
		expect(nodeSemver.satisfies('1.0.0-9007199254740993', '>1.0.0-9007199254740992')).toBe(false);
	});

	it('allows white space between an operator, a tilde or a caret and its version, with node-semver quirks', function () {
		const cases: [string, string, boolean][] = [
			['>= 1.2.3', '1.2.3', true],
			['>=\t1.2.3', '1.2.3', true],
			['^ 1.2.3', '1.9.0', true],
			['~ 1.2.3', '1.2.9', true],
			['~> 1.2.3', '1.2.9', true],
			['~ > 1.2', '1.2.9', true],
			['> =1.2.3', '1.2.3', true],
			['= 1.2.3', '1.2.3', true],
			['< v1.2.3', '1.2.2', true],
			['1.2.3 - 2', '2.9.0', true],
			['1.2.3 -  2', '2.9.0', true],
			['v1.2.3 - v2.0.0', '2.0.0', true],
			[' 1.2.3 - 2 ', '1.5.0', true],
			['1 - v = 2', '2.5.0', true],
			['1.2.3-v = 1', '1.2.3-v', true],
			['1.2.3-dev >= 1.2.3-dev', '1.2.3-dev', true],
			// Not ranges: the operator is cut from its version.
			['> = 1.2.3', '1.2.3', false],
			['>= = 1.2.3', '1.2.3', false],
			['>= v 1.2.3', '1.2.3', false],
			['v 1.2.3 - 2', '1.5.0', false],
			['=1.2.3 - 2', '1.5.0', false],
			['1.2.3  - 2', '1.5.0', true],
			['1.2.3 - 2 +b', '1.5.0', true],
			['1.2.3 - 2 +b +c', '1.5.0', false],
			['> +b 1.2.3', '1.2.4', false],
			['^ +b 1.2.3', '1.2.4', true],
			['+a +b +c 1.2.3 - 2', '1.5.0', false],
			['~ +b > 1', '1.5.0', false],
			['+a 1.2.3 - 2', '1.5.0', true],
			['+a +b 1.2.3 - 2', '1.5.0', true],
			['+a +b v1.2.3 - 2', '1.5.0', true],
			['+a +b v 1.2.3 - 2', '1.5.0', false],
			['~> > 1', '1.5.0', true],
			['~  > 1', '1.5.0', true],
			['1.2.3 > = 1', '1.2.3', false],
			['>=1.2.3*', '1.2.3', true],
			['*1.2.3', '1.2.3', true],
			['>*1.2.3', '1.2.3', true],
			['1.x*', '1.2.3', false],
			['1.2.3<*', '1.2.3', true],
			['1.2.3>=*', '1.2.3', true],
			['1.2.3=*', '1.2.3', true],
			['1<*', '1.2.3', false],
			['1.', '1.2.3', false],
			['1.2.', '1.2.3', false],
			['1.a', '1.2.3', false],
			['^1.', '1.2.3', false],
			['**', '1.2.3', false],
			['^**', '1.2.3', false],
			['~*.1', '1.2.3', true],
			['x.1', '1.2.3', false],
			['*.1', '1.2.3', false],
			['>=*.1', '1.2.3', false],
			['1.*.3', '1.2.3', false],
			['==1.2.3', '1.2.3', false],
			['vv1.2.3', '1.2.3', false],
			['=v1.2.3', '1.2.3', true],
			['=v1.2.x', '1.2.3', true],
			['<==1.x', '1.2.3', true],
			['1.2.3 ||| 2', '1.2.3', false],
			['|| 1.2.3', '1.0.0', true],
			['1.2.3 - 2 - 3', '1.5.0', false],
			['1.2.3.4', '1.2.3', false],
			['^1.2.3-', '1.2.3', false],
			['~', '1.2.3', false],
			['^', '1.2.3', false],
			['>', '1.2.3', false],
			['-', '1.2.3', false],
			['1.2-3', '1.2.3', false],
			['1.2a3', '1.2.3', false],
			['>= 1.2. 1', '1.2.3', false],
			// A partial version ending in a dot, where a space is dropped before it.
			['> 1.', '1.2.3', false],
			['>= 1.2.', '1.2.3', false],
			['^ 1.', '1.2.3', false],
			['> x', '1.2.3', false],
			['>= X', '1.2.3', true],
			['< *', '1.2.3', false],
			['^>1.2.3', '1.2.3', false],
			['+a - 1', '1.0.0', false],
			['1a - 2', '1.0.0', false],
			['1 - 2x', '1.0.0', false],
			// Build metadata is dropped first, which can leave a hyphen range, a space to drop, or two spaces.
			['1.2.3 -+b 2', '2.5.0', true],
			['>+b 1.2.3', '1.2.4', true],
			['1 +b < 1', '0.5.0', false],
			['1 +b+cv > 0', '1.5.0', true],
			['x+b\ufeff+bv > 0', '1.0.0', true],
			['<1.2.3 +b   < x ', '1.0.0', false],
			['1 || +a +b 1.2.3 - 2', '2.5.0', true],
			['1.2.3 - 2 +a || 5', '2.5.0', true],
			['1.2.3 >=1.2.3*', '1.2.3', true],
			['*v1.2.3', '1.2.3', true],
			['*0.1.2', '0.1.2', true],
			['*1.0.2', '1.0.2', true],
			['*1.2.0', '1.2.0', true],
			['x.1.2*', '1.2.3', false],
			['1.2.x*', '1.2.3', false],
			['>=1.2.3*', '1.2.4', true],
			['<=1.2.3*', '1.2.4', false],
			['>1.2.3*', '1.2.4', true],
			['<1.2.3*', '1.2.2', true],
			['>= 1.2.3- 1', '1.2.3', false],
			['*1.2.3x', '1.2.3', false],
			['*1.x.3', '1.2.3', false],
			['x.0', '1.2.3', false],
			['1.x.0', '1.2.3', false],
			['v 1.2.3', '1.2.3', false],
			['> 1 v 1.2.3', '1.2.3', false],
			['= = 1', '1.2.3', false]
		];
		for (const [range, version, expected] of cases) expectSatisfies(range, version, false, expected);
	});

	it('collapses white space of every kind before reading the range, as node-semver does', function () {
		const cases: [string, string, boolean][] = [
			['3.3.2  -  3.4.3', '3.4.0', true],
			['1.2.3\t-\t2', '1.5.0', true],
			['^=v3.2.2\n<=X', '3.5.0', true],
			['2\u3000>=0.2', '2.5.0', true],
			['>=\u00a01.2.3', '1.2.3', true],
			['1.2.3\u2028||\ufeff2.0.0', '2.0.0', true],
			[' \t||\t ', '1.0.0', true],
			['\v\f1.2.3\r\n', '1.2.3', true],
			['>\t\t1.2.3', '1.2.4', true],
			['~\n1.2', '1.2.5', true],
			// A single white space character other than a space is enough to need collapsing.
			['\t', '1.0.0', true],
			['1.2.3\r', '1.2.3', true],
			['1.2.3\n', '1.2.3', true],
			['\u00a0', '1.0.0', true],
			['1.2.3\u0085', '1.2.3', false],
			['1.2.3 \u200b', '1.2.3', false]
		];
		for (const [range, version, expected] of cases) {
			expectSatisfies(range, version, false, expected);
			expectSatisfies(range, version, true, expected);
		}
	});

	it('desugars like node-semver with includePrerelease', function () {
		const cases: [string, string, boolean][] = [
			['^1.0.0', '2.0.0-0', false],
			['<x', '0.0.0-0', false],
			['>=1.x', '1.0.0-0', true],
			['<1.x', '1.0.0-0', false],
			['1.1.x', '1.1.0-0', true],
			['~1.2', '1.2.0-0', true],
			['1.2.3-beta - 2', '1.2.3-beta', true],
			['1.2.3 - 2', '1.2.3-0', true],
			['1 - 1.2.3-beta', '1.2.3-gamma', false]
		];
		for (const [range, version, expected] of cases) expectSatisfies(range, version, true, expected);
	});

	it('applies node-semver limits: safe integers, 256-character comparators and the lengths its grammar reads', function () {
		const cases: [string, boolean][] = [
			['^9007199254740991.0.0', false],
			['^9007199254740990.0.0', true],
			['~0.9007199254740991.0', false],
			['^0.0.9007199254740991', false],
			['>1.9007199254740991', false],
			['<=1.9007199254740990', true],
			['1 - 1.9007199254740991', false],
			['1 - 9007199254740991', false],
			['1 - 1.2.9007199254740991', true],
			['1.2.9007199254740992', false],
			['>=99999999999999999999', false],
			['^1.x.99999999999999999999', true],
			['~1.x.99999999999999999999', true],
			['1.x.99999999999999999999 - 2', true],
			[`^1.x.${'9'.repeat(257)}`, true],
			[`^1.x.${'9'.repeat(258)}`, false],
			[`^1.2.x-${'a'.repeat(251)}`, true],
			[`^1.2.x-${'a'.repeat(252)}`, false],
			[`^1.2.x-${'1'.repeat(256)}a`, true],
			[`^1.2.x-${'1'.repeat(257)}a`, false],
			[`^1.2.x-${'1'.repeat(257)}`, true],
			[`^1.2.x-${'1'.repeat(258)}`, false],
			[`1.2.3-${'a'.repeat(250)}`, true],
			[`1.2.3-${'a'.repeat(251)}`, false],
			[`v1.2.3-${'a'.repeat(250)}`, false],
			[`^1.2.3-${'a'.repeat(250)}`, true],
			[`^1.2.3-${'a'.repeat(251)}`, false],
			[`1.2.3-${'a'.repeat(240)} - 2`, true],
			[`1.2.3-${'a'.repeat(250)} - 2`, true],
			[`1.2.3-${'a'.repeat(251)} - 2`, false],
			[`=1.2.3+${'b'.repeat(250)}*`, true],
			[`=1.2.3+*${'b'.repeat(250)}`, true],
			[`=1.2.3+*${'b'.repeat(251)}`, false]
		];
		for (const [range, valid] of cases) {
			expect([range, nodeSemver.validRange(range) !== null]).toEqual([range, valid]);
			expect([range, helpers.isSemverRange(range)]).toEqual([range, valid]);
		}
		// With includePrerelease, a hyphen range ending in a full version becomes `<x.y.(z+1)-0`.
		expect(nodeSemver.validRange('1 - 1.2.9007199254740991', { includePrerelease: true })).toBeNull();
		expect(helpers.isSemverRange('1 - 1.2.9007199254740991', { includePrerelease: true })).toBe(false);
		expectSatisfies('^9007199254740990.1.2', '9007199254740990.5.0', false, true);
	});

	it('returns false for an invalid range or a non-string', function () {
		expect(helpers.satisfiesSemver('1.2.3', 'not a range')).toBe(false);
		expect(helpers.satisfiesSemver('1.2.3', '>=1.2.3.4')).toBe(false);
		expect(helpers.satisfiesSemver('1.2.3', undefined as any)).toBe(false);
		expect(helpers.satisfiesSemver('1.2.3', 123 as any)).toBe(false);
	});

	it('validates its options', function () {
		expect(helpers.satisfiesSemver('1.2.3', '^1.0.0', {})).toBe(true);
		expect(helpers.satisfiesSemver('1.2.3', '^1.0.0', { includePrerelease: undefined })).toBe(true);
		expect(function () {
			helpers.satisfiesSemver('1.2.3', '^1.0.0', null as any);
		}).toThrow(new TypeError('satisfiesSemver: `options` must be an object, got null'));
		expect(function () {
			helpers.satisfiesSemver('1.2.3', '^1.0.0', 'yes' as any);
		}).toThrow(new TypeError('satisfiesSemver: `options` must be an object, got string'));
		expect(function () {
			helpers.satisfiesSemver('1.2.3', '^1.0.0', { includePrerelease: 1 as any });
		}).toThrow(new TypeError('satisfiesSemver: `includePrerelease` must be a boolean, got number'));
		// Security: an option inherited from a polluted Object.prototype is ignored.
		const prototype = Object.prototype as Record<string, unknown>;
		prototype.includePrerelease = true;
		try {
			expect(helpers.satisfiesSemver('1.3.0-beta', '^1.2.0', {})).toBe(false);
		} finally {
			delete prototype.includePrerelease;
		}
	});

	it('runs in linear time on hostile ranges', function () {
		const hostile = [
			'= '.repeat(50_000) + '1',
			'v'.repeat(100_000),
			'v='.repeat(50_000) + 'x',
			'> '.repeat(50_000) + '1',
			'~ '.repeat(50_000) + '1',
			'^ '.repeat(50_000) + '1',
			'1.2.3 '.repeat(20_000),
			'1.2.3 - 2 ||'.repeat(10_000),
			'+a'.repeat(50_000) + ' 1',
			'<'.repeat(100_000) + '1',
			'1.'.repeat(50_000),
			'1.2.3-' + 'a.'.repeat(50_000),
			'x '.repeat(50_000) + '- 1',
			'*'.repeat(100_000),
			'1.2.3-' + '1'.repeat(100_000),
			'x.x.x-' + '0'.repeat(100_000),
			' >'.repeat(50_000) + '1',
			'> v = '.repeat(20_000) + '1.2.3',
			'1||'.repeat(30_000),
			'\t'.repeat(100_000) + '1'
		];
		const start = performance.now();
		for (const range of hostile) {
			helpers.isSemverRange(range);
			helpers.isSemverRange(range, { includePrerelease: true });
		}
		// About 0.1 s; a quadratic scan would take minutes. Mutation testing instruments the code, so the bound only holds outside it.
		expect(performance.now() - start).toBeLessThan('__stryker__' in globalThis ? Infinity : 2000);
		expect(helpers.satisfiesSemver('1.2.3', '1.2.3 '.repeat(20_000))).toBe(true);
		expect(helpers.isSemverRange('1.2.3 - 2 ||'.repeat(10_000))).toBe(true);
	});
});

describe('compileSemverRange', function () {
	it('returns a predicate testing versions against the range', function () {
		const test = helpers.compileSemverRange('^1.2.0 || ~2.0.1');
		expect(['1.1.9', '1.2.0', '1.9.9', '2.0.0', '2.0.1', '2.0.9', '2.1.0'].filter(test)).toEqual(['1.2.0', '1.9.9', '2.0.1', '2.0.9']);
		expect(test('not a version')).toBe(false);
		expect(test(undefined as any)).toBe(false);
		expect(helpers.compileSemverRange('^1.2.0', { includePrerelease: true })('1.3.0-beta')).toBe(true);
		expect(helpers.compileSemverRange('*')('1.0.0')).toBe(true);
		expect(helpers.compileSemverRange('')('1.0.0-beta')).toBe(false);
	});

	it('throws a TypeError for an invalid range', function () {
		expect(function () {
			helpers.compileSemverRange('>=1.2.3.4');
		}).toThrow(new TypeError('compileSemverRange: ">=1.2.3.4" is not a valid semver range'));
		expect(function () {
			helpers.compileSemverRange('^'.repeat(1000));
		}).toThrow(new TypeError(`compileSemverRange: "${'^'.repeat(50)}…" is not a valid semver range`));
		expect(function () {
			helpers.compileSemverRange(undefined as any);
		}).toThrow(new TypeError('compileSemverRange: `range` must be a string, got undefined'));
		expect(function () {
			helpers.compileSemverRange('*', { includePrerelease: 'no' as any });
		}).toThrow(new TypeError('compileSemverRange: `includePrerelease` must be a boolean, got string'));
	});
});

describe('isSemverRange', function () {
	it('accepts what node-semver accepts', function () {
		for (const range of ['^1.2.3', '1.2.3 - 2.3.4', '>= 1.2.3 < 2', '', '*', '||', 'x || 1', '1.2.3+build', '~>1']) {
			expect([range, helpers.isSemverRange(range), nodeSemver.validRange(range) !== null]).toEqual([range, true, true]);
		}
		for (const range of ['1.2.3.4', 'a', '> = 1', '^1.2.3 ||| 2', '>=x.2', '1.2.3-', '<>1']) {
			expect([range, helpers.isSemverRange(range), nodeSemver.validRange(range) !== null]).toEqual([range, false, false]);
		}
		expect(helpers.isSemverRange(1)).toBe(false);
		expect(helpers.isSemverRange(null)).toBe(false);
		expect(function () {
			helpers.isSemverRange('1', [] as any);
		}).not.toThrow();
		expect(function () {
			helpers.isSemverRange('1', 1 as any);
		}).toThrow(new TypeError('isSemverRange: `options` must be an object, got number'));
	});
});

describe('maxSatisfyingSemver and minSatisfyingSemver', function () {
	const versions = ['1.2.3', '1.2.4', '1.3.0-beta', '2.0.0', '1.2.4+build', 'v1.2.5', 'junk', '0.9.0'];

	it('find the highest and lowest satisfying version, as given', function () {
		expect(helpers.maxSatisfyingSemver(versions, '^1.2.3')).toBe('v1.2.5');
		expect(helpers.minSatisfyingSemver(versions, '^1.2.3')).toBe('1.2.3');
		expect(helpers.maxSatisfyingSemver(versions, '~1.2.4 <1.2.5')).toBe('1.2.4');
		expect(helpers.minSatisfyingSemver(['1.2.4+b', '1.2.4+a'], '1.2.4')).toBe('1.2.4+b');
		expect(helpers.maxSatisfyingSemver(versions, '^1.3.0-0')).toBe('1.3.0-beta');
		expect(helpers.maxSatisfyingSemver(versions, '>1.2.5 <2', { includePrerelease: true })).toBe('1.3.0-beta');
		expect(helpers.maxSatisfyingSemver(versions, '>1.2.5 <2')).toBeUndefined();
		expect(helpers.maxSatisfyingSemver(versions, 'not a range')).toBeUndefined();
		expect(helpers.minSatisfyingSemver(versions, 42 as any)).toBeUndefined();
		expect(helpers.maxSatisfyingSemver([], '*')).toBeUndefined();
		expect(helpers.maxSatisfyingSemver(new Set(['1.0.0', '3.0.0', '2.0.0']), '*')).toBe('3.0.0');
		expect(
			helpers.minSatisfyingSemver(
				(function* (): Generator<string> {
					yield '2.0.0';
					yield '1.0.0';
				})(),
				'*'
			)
		).toBe('1.0.0');
		expect(helpers.maxSatisfyingSemver([1 as any, '1.0.0'], '*')).toBe('1.0.0');
	});

	it('throw a TypeError when versions is not an iterable', function () {
		expect(function () {
			helpers.maxSatisfyingSemver('1.2.3' as any, '*');
		}).toThrow(new TypeError('maxSatisfyingSemver: `versions` must be an iterable of strings, got string'));
		expect(function () {
			helpers.minSatisfyingSemver(null as any, '*');
		}).toThrow(new TypeError('minSatisfyingSemver: `versions` must be an iterable of strings, got null'));
		expect(function () {
			helpers.minSatisfyingSemver({} as any, '*');
		}).toThrow(TypeError);
		expect(function () {
			helpers.minSatisfyingSemver([], '*', { includePrerelease: null as any });
		}).toThrow(new TypeError('minSatisfyingSemver: `includePrerelease` must be a boolean, got null'));
	});
});

/** node-semver's `increments` fixtures: [version, release, result (`null` when node-semver fails), identifier, identifierBase]. */
const INCREMENTS: [string, string, string | null, string?, ('0' | '1' | false)?][] = [
	['1.2.3', 'major', '2.0.0'],
	['1.2.3', 'minor', '1.3.0'],
	['1.2.3', 'patch', '1.2.4'],
	['1.2.3-tag', 'major', '2.0.0'],
	['1.2.0-0', 'patch', '1.2.0'],
	['1.2.3-4', 'major', '2.0.0'],
	['1.2.3-4', 'minor', '1.3.0'],
	['1.2.3-4', 'patch', '1.2.3'],
	['1.2.3-alpha.0.beta', 'major', '2.0.0'],
	['1.2.3-alpha.0.beta', 'minor', '1.3.0'],
	['1.2.3-alpha.0.beta', 'patch', '1.2.3'],
	['1.2.4', 'prerelease', '1.2.5-0'],
	['1.2.3-0', 'prerelease', '1.2.3-1'],
	['1.2.3-alpha.0', 'prerelease', '1.2.3-alpha.1'],
	['1.2.3-alpha.1', 'prerelease', '1.2.3-alpha.2'],
	['1.2.3-alpha.0.beta', 'prerelease', '1.2.3-alpha.1.beta'],
	['1.2.3-alpha.10.0.beta', 'prerelease', '1.2.3-alpha.10.1.beta'],
	['1.2.3-alpha.10.beta.0', 'prerelease', '1.2.3-alpha.10.beta.1'],
	['1.2.3-alpha.9.beta', 'prerelease', '1.2.3-alpha.10.beta'],
	['1.2.0', 'prepatch', '1.2.1-0'],
	['1.2.0-1', 'prepatch', '1.2.1-0'],
	['1.2.0', 'preminor', '1.3.0-0'],
	['1.2.3-1', 'preminor', '1.3.0-0'],
	['1.2.0', 'premajor', '2.0.0-0'],
	['1.2.3-1', 'premajor', '2.0.0-0'],
	['1.2.0-1', 'minor', '1.2.0'],
	['1.0.0-1', 'major', '1.0.0'],
	['1.2.3', 'major', '2.0.0', 'dev'],
	['1.2.4', 'prerelease', '1.2.5-dev.0', 'dev'],
	['1.2.3-0', 'prerelease', '1.2.3-dev.0', 'dev'],
	['1.2.3-alpha.0', 'prerelease', '1.2.3-dev.0', 'dev'],
	['1.2.3-alpha.0', 'prerelease', '1.2.3-alpha.1', 'alpha'],
	['1.2.3-alpha.0.beta', 'prerelease', '1.2.3-alpha.1.beta', 'alpha'],
	['1.2.3-alpha.10.0.beta', 'prerelease', '1.2.3-alpha.10.1.beta', 'alpha'],
	['1.2.3-alpha.9.beta', 'prerelease', '1.2.3-alpha.10.beta', 'alpha'],
	['1.2.0', 'prepatch', '1.2.1-dev.0', 'dev'],
	['1.2.3-1', 'premajor', '2.0.0-dev.0', 'dev'],
	['1.2.3-1', 'premajor', '2.0.0-dev.1', 'dev', '1'],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev.0', 'dev'],
	['1.2.3-0', 'prerelease', '1.2.3-1.0', '1'],
	['1.2.3-1.0', 'prerelease', '1.2.3-1.1', '1'],
	['1.2.3-1.1', 'prerelease', '1.2.3-2.0', '2'],
	['1.2.0-1', 'prerelease', '1.2.0-alpha.1', 'alpha', '1'],
	['1.2.1', 'prerelease', '1.2.2-alpha.1', 'alpha', '1'],
	['1.2.0', 'prepatch', '1.2.1-dev.1', 'dev', '1'],
	['1.2.0', 'premajor', '2.0.0-dev.0', 'dev', '0'],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev.1', 'dev', '1'],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev.bar.0', '', '0'],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev.bar.1', '', '1'],
	['1.2.0', 'prerelease', '1.2.1-1', '', '1'],
	['1.2.0-1', 'prerelease', '1.2.0-alpha', 'alpha', false],
	['1.2.1', 'prerelease', '1.2.2-alpha', 'alpha', false],
	['1.2.0', 'premajor', '2.0.0-dev', 'dev', false],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev', 'dev', false],
	['1.2.3-dev.bar', 'prerelease', '1.2.3-dev.baz', 'dev.baz', false],
	['1.2.0-dev', 'premajor', '2.0.0-dev', 'dev', false],
	['1.2.0-dev', 'preminor', '1.3.0-beta', 'beta', false],
	['1.2.0-dev', 'prepatch', '1.2.1-dev', 'dev', false],
	['1.2.3-dev', 'prerelease', null, 'dev', false],
	['1.2.0', 'prerelease', null, '', false],
	['1.0.0-rc.1', 'release', '1.0.0'],
	['1.0.0-rc.1+build.4', 'release', '1.0.0'],
	['1.0.0', 'release', null],
	['1.2.3', 'fake', null],
	['fake', 'major', null],
	['1.2.3', 'prerelease', null, 'invalid/preid'],
	['1.2.3', 'prerelease', null, '01'],
	['v1.2.3', 'patch', '1.2.4'],
	['1.2.3-1e5', 'prerelease', '1.2.3-1e5.0'],
	['1.2.3-beta.1e5', 'prerelease', '1.2.3-beta.1e5.0', 'beta'],
	['1.2.3-beta.x', 'prerelease', '1.2.3-beta.0', 'beta'],
	['1.2.3-9007199254740990', 'prerelease', '1.2.3-9007199254740991'],
	['1.2.3-9007199254740991', 'prerelease', '1.2.3-9007199254740991.0'],
	['1.2.3-dev', 'prerelease', '1.2.3-dev.0', 'dev'],
	['1.2.3-a.b', 'prerelease', '1.2.3-a.b.0', 'a.b'],
	['1.2.3-a.b', 'prerelease', null, 'a.b', false]
];

describe('incrementSemver', function () {
	// Rows padded to five cells: Jest passes a `done` callback in place of missing arguments.
	const rows = INCREMENTS.map(function ([version, release, result, identifier, identifierBase]) {
		return [version, release, result, identifier, identifierBase] as const;
	});

	it.each(rows)('%j %s gives %j (identifier %j, base %j), as in node-semver', function (version, release, result, identifier, identifierBase) {
		expect(nodeSemver.inc(version, release, undefined, identifier, identifierBase)).toBe(result);
		function run(): string {
			return helpers.incrementSemver(version, release as helpers.SemverRelease, { identifier, identifierBase });
		}
		if (result === null) expect(run).toThrow();
		else expect(run()).toBe(result);
	});

	it('throws where node-semver returns null, with the reason', function () {
		expect(function () {
			helpers.incrementSemver('1.2', 'patch');
		}).toThrow(new TypeError('incrementSemver: "1.2" is not a valid semantic version'));
		expect(function () {
			helpers.incrementSemver(123 as any, 'patch');
		}).toThrow(new TypeError('incrementSemver: number is not a valid semantic version'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 7 as any);
		}).toThrow(new TypeError('incrementSemver: `releaseType` must be a string, got number'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'pre' as any);
		}).toThrow(
			new RangeError("incrementSemver: `releaseType` must be 'major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease' or 'release', got \"pre\"")
		);
		expect(function () {
			helpers.incrementSemver('1.2.3', 'release');
		}).toThrow(new RangeError('incrementSemver: "1.2.3" is not a pre-release'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifierBase: false });
		}).toThrow(new RangeError('incrementSemver: `identifierBase: false` needs an `identifier`'));
		expect(function () {
			helpers.incrementSemver('1.2.3-dev', 'prerelease', { identifier: 'dev', identifierBase: false });
		}).toThrow(new RangeError('incrementSemver: the pre-release is already "dev"'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifier: 'a..b' });
		}).toThrow(new RangeError('incrementSemver: `identifier` must be dot-separated pre-release identifiers, got "a..b"'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifier: 5 as any });
		}).toThrow(new TypeError('incrementSemver: `identifier` must be a string, got number'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifierBase: '2' as any });
		}).toThrow(new RangeError("incrementSemver: `identifierBase` must be '0', '1' or false, got \"2\""));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifierBase: 1 as any });
		}).toThrow(new TypeError("incrementSemver: `identifierBase` must be '0', '1' or false, got number"));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', null as any);
		}).toThrow(new TypeError('incrementSemver: `options` must be an object, got null'));
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', 'beta' as any);
		}).toThrow(new TypeError('incrementSemver: `options` must be an object, got string'));
	});

	it('validates identifier for every release kind and never exceeds Number.MAX_SAFE_INTEGER', function () {
		// node-semver ignores the identifier of a `major` increment, and returns numbers it cannot read back.
		expect(nodeSemver.inc('1.2.3', 'major', undefined, 'not valid!')).toBe('2.0.0');
		expect(function () {
			helpers.incrementSemver('1.2.3', 'major', { identifier: 'not valid!' });
		}).toThrow(RangeError);
		expect(nodeSemver.inc('9007199254740991.0.0', 'major', undefined)).toBe('9007199254740992.0.0');
		expect(function () {
			helpers.incrementSemver('9007199254740991.0.0', 'major');
		}).toThrow(new RangeError('incrementSemver: incrementing "9007199254740991.0.0" exceeds Number.MAX_SAFE_INTEGER'));
		expect(function () {
			helpers.incrementSemver('0.0.9007199254740991', 'prepatch');
		}).toThrow(RangeError);
		expect(helpers.incrementSemver('9007199254740990.9007199254740991.0', 'major')).toBe('9007199254740991.0.0');
		expect(helpers.incrementSemver(' 1.2.3+build ', 'minor', {})).toBe('1.3.0');
		expect(helpers.incrementSemver('1.2.3', 'prerelease', { identifier: 'a'.repeat(251) })).toBe(`1.2.4-${'a'.repeat(251)}.0`);
		expect(function () {
			helpers.incrementSemver('1.2.3', 'prerelease', { identifier: 'a'.repeat(252) });
		}).toThrow(RangeError);
	});
});
