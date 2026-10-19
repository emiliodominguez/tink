import fc from 'fast-check';
import { isUrl } from '.';

/**
 * Picks `common` most of the time and `rare` otherwise.
 * @template T - The value type
 * @param {fc.Arbitrary<T>} common - The usual values
 * @param {fc.Arbitrary<T>} rare - The unusual values
 * @returns {fc.Arbitrary<T>} The mix
 */
function mostly<T>(common: fc.Arbitrary<T>, rare: fc.Arbitrary<T>): fc.Arbitrary<T> {
	return fc.oneof({ arbitrary: common, weight: 6 }, { arbitrary: rare, weight: 1 });
}

/** Plain web URLs, the fast path's territory, with every kind of near miss mixed in at a lower rate. */
export const webUrl = fc
	.record({
		scheme: mostly(fc.constantFrom('http', 'https', 'HTTP', 'hTtPs'), fc.constantFrom('httpx', 'ftp', 'http:', 'htt', '')),
		slashes: mostly(fc.constant('://'), fc.constantFrom(':/', ':', ':///', '//')),
		user: mostly(fc.constant(''), fc.constantFrom('u@', 'u:p@', '@')),
		host: fc
			.array(
				mostly(
					fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,6}$/),
					fc.oneof(
						fc.constantFrom('', 'xn--mnchen-3ya', 'XN--zz', '127', '0x7f', '0X', '0xg', 'localhost', 'münchen', 'a_b', 'a%b', 'a\\b', '[::1]'),
						fc.stringMatching(/^[0-9]{1,4}$/)
					)
				),
				{ minLength: 1, maxLength: 4 }
			)
			.map(function (labels) {
				return labels.join('.');
			}),
		trailingDot: mostly(fc.constant(''), fc.constant('.')),
		port: fc.oneof(
			fc.constant(''),
			fc
				.nat(70000)
				.map(String)
				.map(function (port) {
					return `:${port}`;
				}),
			fc.constantFrom(':', ':000080', ':00080', ':8x')
		),
		rest: mostly(fc.stringMatching(/^(?:[/?#][\x21-\x7e]{0,8})?$/), fc.stringMatching(/^[/?#x ][a-z/?#%"\\ \x7f\té​~]{0,6}$/))
	})
	.map(function (parts) {
		return `${parts.scheme}${parts.slashes}${parts.user}${parts.host}${parts.trailingDot}${parts.port}${parts.rest}`;
	});

describe('isUrl fast path (properties)', function () {
	it('agrees with the full check (an explicit protocols list skips the fast path), with and without requireTld', function () {
		fc.assert(
			fc.property(fc.oneof(webUrl, fc.string({ maxLength: 30 })), function (value) {
				expect(isUrl(value)).toBe(isUrl(value, { protocols: ['http', 'https'] }));
				expect(isUrl(value, { requireTld: true })).toBe(isUrl(value, { protocols: ['http', 'https'], requireTld: true }));
			})
		);
	});
});
