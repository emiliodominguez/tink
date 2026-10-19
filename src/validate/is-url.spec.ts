import { isUrl } from '.';

/**
 * The full check of `isUrl`: an explicit `protocols` list (the same as the default) skips the plain-URL fast path.
 * @param {string} value - The candidate URL
 * @param {boolean} requireTld - Whether a top-level domain is required
 * @returns {boolean} What the full check says
 */
function fullCheck(value: string, requireTld: boolean): boolean {
	return isUrl(value, { protocols: ['http', 'https'], requireTld });
}

describe('isUrl fast path', function () {
	// Every branch of the plain-URL recogniser, accepted or handed to the full check.
	const cases = [
		'http://example.com',
		'HTTPS://EXAMPLE.COM',
		'hTTp://a',
		'https://sub.example.co.uk/a/b?c=d#e',
		'https://example.com:8080',
		'https://example.com:65535/x',
		'https://example.com:65536',
		'https://example.com:00080',
		'https://example.com:000080',
		'https://example.com:',
		'https://example.com:80x',
		'https://example.com?q',
		'https://example.com#f',
		'https://example.com/ünïcode',
		'https://example.com/a b',
		'https://example.com/\u007f',
		'https://example.com/"<>`{}|\\^',
		'https://-leading-.example',
		'https://a..b',
		'https://.example.com',
		'https://example.com.',
		'https://',
		'http:///example.com',
		'https://xn--mnchen-3ya.de',
		'https://XN--mnchen-3ya.de',
		'https://xn--zz.example.com',
		'https://xn-a.com',
		'https://xn',
		'https://127.0.0.1',
		'https://127.1',
		'https://2130706433',
		'https://0x7f.1',
		'https://0X7F',
		'https://0xg',
		'https://1.2.3.example',
		'https://localhost',
		'https://user@example.com',
		'https://user:pass@example.com',
		'https://ex_ample.com',
		'https://exa%mple.com',
		'https://ex\\ample.com',
		'https://[::1]',
		'https://münchen.de',
		'ftp://example.com',
		'httpx://example.com',
		'https:example.com',
		'https:/example.com',
		'http',
		'',
		'https://a.b.c.d.e.f.g.h',
		`https://${'a'.repeat(100)}.com`
	];

	it.each(cases)('should agree with the full check on %j', function (value) {
		expect(isUrl(value)).toBe(fullCheck(value, false));
		expect(isUrl(value, { requireTld: true })).toBe(fullCheck(value, true));
	});

	it('should only take the fast path with the runtime URL parser', function () {
		const original = globalThis.URL;

		/** A URL parser stub that rejects everything. */
		class RejectingUrl {
			/**
			 * Rejects every URL.
			 * @returns {never} Never returns
			 */
			constructor() {
				throw new TypeError('rejected');
			}
		}

		globalThis.URL = RejectingUrl as unknown as typeof URL;
		try {
			expect(isUrl('https://example.com')).toBe(false);
		} finally {
			globalThis.URL = original;
		}
		expect(isUrl('https://example.com')).toBe(true);
	});
});
