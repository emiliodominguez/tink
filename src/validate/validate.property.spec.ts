import fc from 'fast-check';

import { parseHex, toHex } from '../color/index.js';
import { randomUUID } from '../random/index.js';
import { isIntegerInRange, isLiteral, isNumberInRange, isString } from '../guards/index.js';
import { toSlug } from '../strings/index.js';
import * as helpers from '.';

/** Pre-release identifiers mixing numeric and alphanumeric ones, with a few near-collisions. */
const identifierArb = fc.oneof(fc.nat(12).map(String), fc.constantFrom('alpha', 'beta', 'rc', 'a', 'b', 'B', 'x-1', '0a', '1a', '-'));

/** Random semantic versions over a small domain, so equal parts are common. */
const semverArb = fc
	.record({
		major: fc.nat(2),
		minor: fc.nat(2),
		patch: fc.nat(2),
		prerelease: fc.option(fc.array(identifierArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
		build: fc.option(fc.array(fc.constantFrom('001', 'sha', 'x-y'), { minLength: 1, maxLength: 2 }), { nil: undefined })
	})
	.map(function (v) {
		return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? '-' + v.prerelease.join('.') : ''}${v.build ? '+' + v.build.join('.') : ''}`;
	});

/** Appends the Luhn check digit to a string of digits. */
function withCheckDigit(payload: string): string {
	for (let digit = 0; digit <= 9; digit++) {
		if (helpers.luhnCheck(payload + digit)) return payload + digit;
	}
	throw new Error('unreachable');
}

describe('compareSemver (properties)', function () {
	it('is reflexive and antisymmetric', function () {
		fc.assert(
			fc.property(semverArb, semverArb, function (a, b) {
				expect(helpers.compareSemver(a, a)).toBe(0);
				expect(helpers.compareSemver(a, b)).toBe(-helpers.compareSemver(b, a) + 0);
			})
		);
	});

	it('is transitive', function () {
		fc.assert(
			fc.property(semverArb, semverArb, semverArb, function (a, b, c) {
				if (helpers.compareSemver(a, b) <= 0 && helpers.compareSemver(b, c) <= 0) {
					expect(helpers.compareSemver(a, c)).toBeLessThanOrEqual(0);
				}
				if (helpers.compareSemver(a, b) === 0 && helpers.compareSemver(b, c) === 0) {
					expect(helpers.compareSemver(a, c)).toBe(0);
				}
			})
		);
	});

	it('sorts consistently: every adjacent pair of a sorted list is in order', function () {
		fc.assert(
			fc.property(fc.array(semverArb, { maxLength: 20 }), function (versions) {
				const sorted = [...versions].sort(helpers.compareSemver);
				for (let i = 1; i < sorted.length; i++) expect(helpers.compareSemver(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
			})
		);
	});

	it('agrees with the semver.org precedence example list', function () {
		const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
		fc.assert(
			fc.property(fc.nat(ordered.length - 1), fc.nat(ordered.length - 1), function (i, j) {
				expect(helpers.compareSemver(ordered[i], ordered[j])).toBe(Math.sign(i - j) + 0);
			})
		);
		fc.assert(
			fc.property(fc.shuffledSubarray(ordered, { minLength: ordered.length }), function (shuffled) {
				expect(shuffled.sort(helpers.compareSemver)).toEqual(ordered);
			})
		);
	});

	it('ignores build metadata', function () {
		fc.assert(
			fc.property(semverArb, fc.stringMatching(/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/), function (version, build) {
				const release = version.split('+')[0];
				expect(helpers.compareSemver(version, `${release}+${build}`)).toBe(0);
			})
		);
	});

	it('every generated version is valid and round-trips through parseSemver', function () {
		fc.assert(
			fc.property(semverArb, function (version) {
				expect(helpers.isSemver(version)).toBe(true);
				const parsed = helpers.parseSemver(version)!;
				const rebuilt = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? '-' + parsed.prerelease.join('.') : ''}${parsed.build.length ? '+' + parsed.build.join('.') : ''}`;
				expect(rebuilt).toBe(version);
			})
		);
	});
});

describe('isIPv4 / isIPv6 (properties)', function () {
	const octets = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255));

	it('accepts any four formatted octets, also embedded in IPv6', function () {
		fc.assert(
			fc.property(octets, function (parts) {
				const ip = parts.join('.');
				expect(helpers.isIPv4(ip)).toBe(true);
				expect(helpers.isIP(ip)).toBe(true);
				expect(helpers.isIPv6(`::ffff:${ip}`)).toBe(true);
			})
		);
	});

	it('rejects leading-zero variants', function () {
		fc.assert(
			fc.property(octets, fc.nat(3), fc.constantFrom('0', '00'), function (parts, index, zeros) {
				const padded = parts.map(String);
				padded[index] = zeros + padded[index];
				fc.pre(padded[index].length <= 3);
				expect(helpers.isIPv4(padded.join('.'))).toBe(false);
			})
		);
	});

	it('rejects octets above 255', function () {
		fc.assert(
			fc.property(octets, fc.nat(3), fc.integer({ min: 256, max: 999 }), function (parts, index, big) {
				const values: number[] = [...parts];
				values[index] = big;
				expect(helpers.isIPv4(values.join('.'))).toBe(false);
			})
		);
	});

	it('accepts every full and compressed form of random IPv6 addresses', function () {
		fc.assert(
			fc.property(fc.array(fc.nat(0xffff), { minLength: 8, maxLength: 8 }), fc.nat(7), fc.integer({ min: 1, max: 8 }), function (groups, start, length) {
				const hex = groups.map(function (group) {
					return group.toString(16);
				});
				expect(helpers.isIPv6(hex.join(':'))).toBe(true);
				fc.pre(start + length <= 8);
				const compressed = hex.slice(0, start).join(':') + '::' + hex.slice(start + length).join(':');
				expect(helpers.isIPv6(compressed)).toBe(true);
				expect(helpers.isIPv6(compressed.toUpperCase())).toBe(true);
			})
		);
	});
});

describe('isUuid (properties)', function () {
	it('accepts crypto-generated v4 UUIDs, in either case, only as version 4', function () {
		for (let i = 0; i < 200; i++) {
			const uuid = randomUUID();
			expect(helpers.isUuid(uuid)).toBe(true);
			expect(helpers.isUuid(uuid, 4)).toBe(true);
			expect(helpers.isUuid(uuid.toUpperCase(), 4)).toBe(true);
			expect(helpers.isUuid(uuid, 7)).toBe(false);
		}
	});

	const versionedUuidArb = fc.integer({ min: 1, max: 8 }).chain(function (version) {
		return fc.tuple(fc.constant(version), fc.uuid({ version: version as 1 }));
	});

	it('accepts RFC 9562 UUIDs of every version exactly for their own version', function () {
		fc.assert(
			fc.property(versionedUuidArb, fc.integer({ min: 1, max: 8 }), function ([version, uuid], other) {
				expect(helpers.isUuid(uuid)).toBe(true);
				expect(helpers.isUuid(uuid, other as helpers.UuidVersion)).toBe(version === other);
			})
		);
	});
});

describe('luhnCheck / isCreditCardNumber (properties)', function () {
	const payloadArb = fc.stringMatching(/^[0-9]{11,18}$/);

	it('changing any single digit of a valid number makes it invalid', function () {
		fc.assert(
			fc.property(payloadArb, fc.nat(), fc.integer({ min: 1, max: 9 }), function (payload, rawIndex, delta) {
				const valid = withCheckDigit(payload);
				expect(helpers.luhnCheck(valid)).toBe(true);
				expect(helpers.isCreditCardNumber(valid)).toBe(true);
				const index = rawIndex % valid.length;
				const changed = valid.slice(0, index) + ((Number(valid[index]) + delta) % 10) + valid.slice(index + 1);
				expect(helpers.luhnCheck(changed)).toBe(false);
				expect(helpers.isCreditCardNumber(changed)).toBe(false);
			})
		);
	});

	it('separators between digit groups do not change the verdict', function () {
		fc.assert(
			fc.property(payloadArb, fc.constantFrom(' ', '-'), function (payload, separator) {
				const valid = withCheckDigit(payload);
				const grouped = valid.match(/.{1,4}/g)!.join(separator);
				expect(helpers.isCreditCardNumber(grouped)).toBe(true);
			})
		);
	});
});

describe('isSlug (properties)', function () {
	it('accepts every non-empty toSlug output, which toSlug leaves unchanged', function () {
		fc.assert(
			fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), function (text) {
				const slug = toSlug(text);
				fc.pre(slug !== '');
				expect(helpers.isSlug(slug)).toBe(true);
			})
		);
	});

	it('every slug is a fixed point of toSlug', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('a', 'z', '0', '9', '-', 'A', '_', ' '), maxLength: 12 }), function (text) {
				if (helpers.isSlug(text)) expect(toSlug(text)).toBe(text);
			})
		);
	});
});

describe('isBase64 (properties)', function () {
	it('accepts btoa output of random bytes, with or without padding, in both alphabets', function () {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 64 }), function (bytes) {
				const encoded = btoa(String.fromCharCode(...bytes));
				const unpadded = encoded.replace(/=+$/, '');
				const urlSafe = unpadded.replace(/\+/g, '-').replace(/\//g, '_');
				expect(helpers.isBase64(encoded)).toBe(true);
				expect(helpers.isBase64(encoded, { padding: 'required' })).toBe(true);
				expect(helpers.isBase64(unpadded)).toBe(true);
				expect(helpers.isBase64(unpadded, { padding: 'forbidden' })).toBe(true);
				expect(helpers.isBase64(urlSafe, { urlSafe: true })).toBe(true);
				expect(helpers.isBase64(encoded, { padding: 'forbidden' })).toBe(encoded === unpadded);
				expect(helpers.isBase64(unpadded, { padding: 'required' })).toBe(encoded === unpadded);
			})
		);
	});

	it('agrees with atob: whatever isBase64 accepts (padded) decodes', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('A', 'z', '0', '+', '/', '='), maxLength: 12 }), function (text) {
				if (helpers.isBase64(text, { padding: 'required' })) {
					expect(function () {
						atob(text);
					}).not.toThrow();
				}
			})
		);
	});
});

describe('isBase64 canonical encodings (properties)', function () {
	it('accepts a padded string exactly when it is the btoa encoding of what atob decodes it to', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('A', 'B', 'Q', 'R', 'g', 'h', 'w', 'z', '0', '8', '9', '+', '/', '='), maxLength: 12 }), function (text) {
				let canonical: boolean;
				try {
					canonical = btoa(atob(text)) === text;
				} catch {
					canonical = false;
				}
				expect(helpers.isBase64(text, { padding: 'required' })).toBe(canonical);
			}),
			{ numRuns: 3000 }
		);
	});
});

describe('isNumericString (properties)', function () {
	it('accepts String(n) for every finite double', function () {
		fc.assert(
			fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), function (n) {
				expect(helpers.isNumericString(String(n))).toBe(true);
			})
		);
	});

	it('anything it accepts converts to a finite number', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('0', '1', '9', '.', '+', '-', 'e', 'E', 'x', ' '), maxLength: 10 }), function (text) {
				if (helpers.isNumericString(text)) expect(Number.isFinite(Number(text))).toBe(true);
			})
		);
	});
});

describe('isHexColor (properties)', function () {
	const channel = fc.nat(255);

	it('accepts toHex output of random colours', function () {
		fc.assert(
			fc.property(channel, channel, channel, fc.double({ min: 0, max: 1, noNaN: true }), function (r, g, b, a) {
				expect(helpers.isHexColor(toHex({ r, g, b }))).toBe(true);
				expect(helpers.isHexColor(toHex({ r, g, b }), { alpha: false })).toBe(true);
				expect(helpers.isHexColor(toHex({ r, g, b, a }, { alpha: true }))).toBe(true);
				expect(helpers.isHexColor(toHex({ r, g, b, a }, { alpha: true }), { alpha: false })).toBe(false);
			})
		);
	});

	it('is consistent with parseHex: accepted exactly when it has a # and parseHex succeeds', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('#', 'a', 'F', '0', '9', 'g'), maxLength: 10 }), function (text) {
				let parses = true;
				try {
					parseHex(text);
				} catch {
					parses = false;
				}
				expect(helpers.isHexColor(text)).toBe(text.startsWith('#') && parses);
			})
		);
	});
});

describe('isIsoDateString / isIsoDateTimeString (properties)', function () {
	const dateArb = fc.date({ min: new Date('0000-01-01T00:00:00.000Z'), max: new Date('9999-12-31T23:59:59.999Z'), noInvalidDate: true });

	it('accepts toISOString output and its date part', function () {
		fc.assert(
			fc.property(dateArb, function (date) {
				const iso = date.toISOString();
				expect(helpers.isIsoDateTimeString(iso)).toBe(true);
				expect(helpers.isIsoDateString(iso.slice(0, 10))).toBe(true);
			})
		);
	});

	it('accepts a day exactly when it exists in the calendar', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 }), function (year, month, day) {
				const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
				const probe = new Date(Date.UTC(2000, month - 1, day));
				probe.setUTCFullYear(year);
				const exists = probe.getUTCMonth() === month - 1;
				expect(helpers.isIsoDateString(text)).toBe(exists);
				expect(helpers.isIsoDateTimeString(`${text}T12:00:00Z`)).toBe(exists);
			})
		);
	});
});

describe('isEmail (properties)', function () {
	it('accepts generated RFC addresses that fit the length limits', function () {
		fc.assert(
			fc.property(fc.emailAddress(), function (email) {
				fc.pre(email.length <= 254 && email.indexOf('@') <= 64);
				expect(helpers.isEmail(email)).toBe(true);
			})
		);
	});
});

describe('isUrl (properties)', function () {
	/** Host characters: plain ones and the invisible, compatibility, full-stop, escape and delimiter characters that the URL parser rewrites. */
	const hostChar = fc.constantFrom(
		...['a', 'b', 'e', 'x', 'K', '0', '1', '7', 'f', '-', '.', '.', '.', ':', '@', '%', '6', '5', '\\', '/', '[', ']'],
		...['ü', 'Ü', '例', 'é', 'ß', 'ẞ', 'İ', 'ς', 'ſ', 'K', '­', '​', '͏', '️', '⁠', '̈', 'ｅ', 'ⓔ', '。', '｡', '．', '⒈']
	);
	const urlArb = fc
		.record({
			scheme: fc.constantFrom('http', 'https', 'HTTPS'),
			user: fc.option(fc.constantFrom('user', 'u:p', 'good.com'), { nil: undefined }),
			host: fc.array(hostChar, { minLength: 1, maxLength: 12 }).map(function (chars) {
				return chars.join('');
			}),
			port: fc.option(fc.constantFrom('80', '8080'), { nil: undefined }),
			path: fc.constantFrom('', '/', '/x?y#z', '?q', '#f')
		})
		.map(function (v) {
			return `${v.scheme}://${v.user === undefined ? '' : v.user + '@'}${v.host}${v.port === undefined ? '' : ':' + v.port}${v.path}`;
		});

	/**
	 * The host as a reader (or an RFC 3986 parser, regex of its appendix B) sees it: the authority after the last `@`, before the port.
	 * @param url - The URL text
	 * @returns The host text
	 */
	function writtenHost(url: string): string {
		const authority = (/^[^:/?#]+:\/\/([^/?#]*)/.exec(url) as RegExpExecArray)[1];
		const host = authority.slice(authority.lastIndexOf('@') + 1);
		return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
	}

	it('the parsed hostname is the written host, lower-cased, with non-ASCII labels in punycode', function () {
		fc.assert(
			fc.property(urlArb, function (url) {
				fc.pre(helpers.isUrl(url));
				const host = writtenHost(url);
				const hostname = new URL(url).hostname;
				const written = host.split('.');
				const parsed = hostname.split('.');
				expect(parsed.length).toBe(written.length);
				written.forEach(function (label: string, index: number) {
					// eslint-disable-next-line no-control-regex
					if (/^[\x00-\x7f]*$/.test(label)) expect(parsed[index]).toBe(label.toLowerCase());
					else {
						expect(parsed[index].startsWith('xn--')).toBe(true);
						expect(parsed[index]).toBe(new URL(`http://${label}`).hostname);
					}
				});
			}),
			{ numRuns: 3000 }
		);
	});

	it('the parsed hostname equals new URL("http://" + host).hostname for accepted URLs', function () {
		fc.assert(
			fc.property(urlArb, function (url) {
				fc.pre(helpers.isUrl(url));
				const host = writtenHost(url);
				expect([host.toLowerCase(), new URL(`http://${host}`).hostname]).toContain(new URL(url).hostname);
			}),
			{ numRuns: 1000 }
		);
	});
});

describe('parseEnv (properties)', function () {
	const schema = { A: helpers.asInteger, B: helpers.withDefault(helpers.asInteger, 7), C: helpers.optional(helpers.asBoolean), D: helpers.asList(helpers.asInteger) };
	const value = fc.option(
		fc.oneof(
			fc.constantFrom('', ' ', '\t', 'true', 'off', '0', 'secret-value', '1,2', '1,x'),
			fc.integer({ min: -1000, max: 1000 }).map(String),
			fc.string({ maxLength: 12 })
		),
		{ nil: undefined }
	);
	const environment = fc.record({ A: value, B: value, C: value, D: value, EXTRA: value }, { requiredKeys: [] });

	/** The distinct variable names of a list of issues, in order. */
	function variables(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey> }>): string[] {
		return Array.from(
			new Set(
				issues.map(function (issue) {
					return String(issue.path[0]);
				})
			)
		);
	}

	/** Runs `fn`, returning `['ok', output]` or `['error', error]`. */
	function outcome(fn: () => unknown): ['ok' | 'error', unknown] {
		try {
			return ['ok', fn()];
		} catch (error) {
			return ['error', error];
		}
	}

	it('matches safeParse on the environment without its blank values, reporting the same variables, never quoting their values', function () {
		fc.assert(
			fc.property(environment, function (env) {
				const present: Record<string, unknown> = {};
				for (const [name, text] of Object.entries(env)) if (text !== undefined && text.trim() !== '') present[name] = text;
				const [error, expected] = helpers.safeParse(schema, present);
				const [status, result] = outcome(function () {
					return helpers.parseEnv(schema, env);
				});

				if (error === undefined) {
					expect([status, result]).toEqual(['ok', expected]);
					return;
				}
				expect(status).toBe('error');
				const { issues } = result as typeof error;
				expect(variables(issues)).toEqual(variables(error.issues));
				const message = (result as Error).message;
				expect(message.split('\n')).toHaveLength(issues.length + 1);
				// No issue quotes the value of its variable (values shorter than 4 characters are not redacted).
				for (const issue of issues) {
					const text = (env as Record<string, string | undefined>)[String(issue.path[0])]?.trim() ?? '';
					if (text.length >= 4) expect(issue.message).not.toContain(text);
				}
			})
		);
	});

	it('reads PREFIX + key and reports full names: the same outcome as without a prefix', function () {
		fc.assert(
			fc.property(environment, fc.constantFrom('APP_', 'VITE_', 'x'), function (env, prefix) {
				const prefixed: Record<string, unknown> = { A: '1', B: 'not a number' };
				for (const [name, text] of Object.entries(env)) prefixed[prefix + name] = text;
				const plain = outcome(function () {
					return helpers.parseEnv(schema, env);
				});
				const withPrefix = outcome(function () {
					return helpers.parseEnv(schema, prefixed, { prefix });
				});

				expect(withPrefix[0]).toBe(plain[0]);
				if (plain[0] === 'ok') {
					expect(withPrefix[1]).toEqual(plain[1]);
				} else {
					expect((withPrefix[1] as Error).message).toBe((plain[1] as Error).message.replace(/^ {2}/gm, '  ' + prefix));
				}
			})
		);
	});
});

describe('parseEnv (non-interference)', function () {
	const { asInteger, asJson, asList, asNumber, chain, parseEnv, recordOf, transform, withError } = helpers;

	/** A validator from another library whose messages and paths quote the value, as zod's and valibot's can. */
	const quoting = {
		'~standard': {
			version: 1 as const,
			vendor: 'other',
			validate: function (value: unknown) {
				return { issues: [{ message: "Invalid enum value, received '" + String(value) + "'", path: [{ key: String(value) }] }] };
			}
		}
	};
	const textSchema = {
		INT: asInteger,
		ECHO: withError(isUrlLike, function (value) {
			return 'Not a URL: ' + JSON.stringify(value);
		}),
		QUOTING: quoting,
		LIST: asList(quoting),
		JSON_LEAF: asJson({ token: asInteger }),
		JSON_KEYS: asJson(recordOf(asInteger)),
		THROWS: transform(isString, function (text: string): never {
			throw new Error(text);
		}),
		UPPER: chain(
			transform(isString, function (text: string) {
				return text.toUpperCase();
			}),
			withError(isUrlLike, function (value) {
				return String(value);
			})
		)
	};
	const numberSchema = {
		RANGE: chain(asInteger, isIntegerInRange(0, 9999)),
		SIGNED: chain(asInteger, isIntegerInRange(0, 9999)),
		DECIMAL: chain(asNumber, isNumberInRange(0, 1)),
		LITERAL: chain(asInteger, isLiteral(1)),
		RAW: isString,
		JSON_NUMBER: asJson({ pin: isIntegerInRange(0, 9) })
	};

	/** Whether a value is an `https:` URL (rejects every generated secret). */
	function isUrlLike(value: unknown): value is string {
		return typeof value === 'string' && value.startsWith('https://');
	}

	/** Everything the error of `parseEnv(schema, env)` exposes, but the frames of its stack. */
	function exposed(schema: helpers.ObjectSchema, env: object): string {
		try {
			parseEnv(schema, env);
		} catch (error) {
			const { stack, message, issues, cause } = error as Error & { issues?: unknown; cause?: unknown };
			return JSON.stringify([String(error), message, issues, String(stack).split('\n    at ')[0], String(cause)]);
		}
		throw new Error('expected a throw');
	}

	it('gives the same error for any two secrets (strings), so no part of them can be in it', function () {
		fc.assert(
			fc.property(fc.stringMatching(/^sk_[A-Za-z0-9]{8,24}$/), fc.stringMatching(/^sk_[A-Za-z0-9]{8,24}$/), function (a, b) {
				function env(secret: string): object {
					return {
						INT: secret,
						ECHO: secret,
						QUOTING: secret,
						LIST: `${secret},${secret}x`,
						JSON_LEAF: JSON.stringify({ token: secret }),
						JSON_KEYS: JSON.stringify({ [secret]: secret }),
						THROWS: secret,
						UPPER: secret
					};
				}
				const first = exposed(textSchema, env(a));
				expect(exposed(textSchema, env(b))).toBe(first);
				expect(first).not.toContain(a.slice(3));
				expect(first).not.toContain(a.slice(3).toUpperCase());
			})
		);
	});

	it('gives the same error for any two secrets (numbers, normalised by the parsers), so no digit of them can be in it', function () {
		fc.assert(
			fc.property(fc.integer({ min: 10_000, max: 2 ** 40 }), fc.integer({ min: 10_000, max: 2 ** 40 }), function (a, b) {
				function env(secret: number): object {
					return {
						RANGE: `00${secret}`,
						SIGNED: `+${secret}`,
						DECIMAL: `${secret}.50`,
						LITERAL: `000${secret}`,
						RAW: secret,
						JSON_NUMBER: `{"pin": ${secret}}`
					};
				}
				const first = exposed(numberSchema, env(a));
				expect(exposed(numberSchema, env(b))).toBe(first);
				expect(first).not.toMatch(/\d/);
			})
		);
	});
});
