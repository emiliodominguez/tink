import { createHash, createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import fc from 'fast-check';
import { isBase64 } from '../validate';
import * as helpers from '.';

/**
 * Runs `fn` with `key` removed from `target`, restoring the original property afterwards.
 */
function without<T>(target: object, key: PropertyKey, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	delete (target as Record<PropertyKey, unknown>)[key];
	try {
		return fn();
	} finally {
		if (descriptor) Object.defineProperty(target, key, descriptor);
	}
}

/** The outcome of a call: its value, or the name and message of the error it threw. */
function outcome<T>(fn: () => T): { value: T } | { error: string } {
	try {
		return { value: fn() };
	} catch (error) {
		return { error: `${(error as Error).name}: ${(error as Error).message}` };
	}
}

const bytes = fc.uint8Array({ maxLength: 300 });
const padding = fc.constantFrom('optional' as const, 'required' as const, 'forbidden' as const);

/** Strings close to base64: mostly alphabet characters, with padding, white space, the other alphabet and non-ASCII sprinkled in. */
const base64ish = fc.oneof(
	fc.string({ unit: fc.constantFrom(...'AQgwYZaz09+/-_=', ' ', '\n', 'é', '\uD83D', '😀'), maxLength: 14 }),
	bytes.map(function (data) {
		return Buffer.from(data).toString('base64');
	}),
	fc.tuple(bytes, fc.boolean()).map(function ([data, url]) {
		return Buffer.from(data)
			.toString(url ? 'base64url' : 'base64')
			.replace(/=+$/, '');
	}),
	fc.tuple(bytes, fc.nat(), fc.constantFrom('=', ' ', '*', 'A', '-', '/', '')).map(function ([data, at, insert]) {
		const encoded = Buffer.from(data).toString('base64');
		const index = at % (encoded.length + 1);
		return encoded.slice(0, index) + insert + encoded.slice(index + (insert === '' ? 1 : 0));
	})
);

/** Byte arrays that are mostly UTF-8, with every kind of malformation mixed in. */
const utf8ish = fc
	.array(
		fc.oneof(
			fc.string({ unit: 'binary', maxLength: 4 }).map(function (value) {
				return Array.from(Buffer.from(value));
			}),
			fc.array(fc.integer({ min: 0x80, max: 0xff }), { maxLength: 4 }),
			fc.constantFrom([0xe0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x8f], [0xf4, 0x90], [0xc0, 0xaf], [0xef, 0xbb, 0xbf], [0xf0, 0x9f, 0x98])
		),
		{ maxLength: 20 }
	)
	.map(function (parts) {
		return new Uint8Array(parts.flat());
	});

describe('Encoding helpers (property-based)', function () {
	describe('toBase64', function () {
		it('should equal Buffer base64 / base64url, natively or not, with any padding', function () {
			fc.assert(
				fc.property(bytes, fc.boolean(), fc.boolean(), function (data, urlSafe, pad) {
					const expected = Buffer.from(data)
						.toString(urlSafe ? 'base64url' : 'base64')
						.replace(/=+$/, '');
					const padded = expected + '='.repeat((4 - (expected.length % 4)) % 4);
					const options = { urlSafe, padding: pad };
					expect(helpers.toBase64(data, options)).toBe(pad ? padded : expected);
					expect(
						without(Uint8Array.prototype, 'toBase64', function () {
							return helpers.toBase64(data, options);
						})
					).toBe(pad ? padded : expected);
				})
			);
		});

		it('should encode the bytes a view covers, like a copy of them', function () {
			fc.assert(
				fc.property(bytes, fc.nat(), fc.nat(), function (data, a, b) {
					const start = a % (data.length + 1);
					const end = start + (b % (data.length - start + 1));
					const copy = data.slice(start, end);
					expect(helpers.toBase64(new DataView(data.buffer, start, end - start))).toBe(helpers.toBase64(copy));
					expect(helpers.toHex(data.subarray(start, end))).toBe(helpers.toHex(copy));
				})
			);
		});
	});

	describe('fromBase64', function () {
		it('should round-trip toBase64 for every option combination', function () {
			fc.assert(
				fc.property(bytes, fc.boolean(), fc.boolean(), function (data, urlSafe, pad) {
					const encoded = helpers.toBase64(data, { urlSafe, padding: pad });
					const decodeOptions = { urlSafe, padding: pad ? ('required' as const) : ('optional' as const) };
					expect(helpers.fromBase64(encoded, decodeOptions)).toEqual(data);
					expect(
						without(Uint8Array, 'fromBase64', function () {
							return helpers.fromBase64(encoded, decodeOptions);
						})
					).toEqual(data);
				})
			);
		});

		it('should accept exactly what isBase64 accepts, decode it like Buffer, and behave identically with or without the native decoder', function () {
			fc.assert(
				fc.property(base64ish, fc.boolean(), padding, function (text, urlSafe, pad) {
					const options = { urlSafe, padding: pad };
					const native = outcome(function () {
						return helpers.fromBase64(text, options);
					});
					const portable = outcome(function () {
						return without(Uint8Array, 'fromBase64', function () {
							return helpers.fromBase64(text, options);
						});
					});
					expect(portable).toEqual(native);
					expect('value' in native).toBe(isBase64(text, options));
					if ('value' in native) {
						expect(native.value).toEqual(new Uint8Array(Buffer.from(text, urlSafe ? 'base64url' : 'base64')));
						// Canonical: re-encoding gives the same text back (up to padding).
						expect(helpers.toBase64(native.value, { urlSafe, padding: false })).toBe(text.replace(/=+$/, ''));
					} else {
						expect(native.error).toMatch(/^SyntaxError: fromBase64: `text` must /);
					}
				})
			);
		});
	});

	describe('toHex / fromHex', function () {
		it('should equal Buffer hex and round-trip in either letter case', function () {
			fc.assert(
				fc.property(bytes, function (data) {
					const hex = Buffer.from(data).toString('hex');
					expect(helpers.toHex(data)).toBe(hex);
					expect(
						without(Uint8Array.prototype, 'toHex', function () {
							return helpers.toHex(data);
						})
					).toBe(hex);
					expect(helpers.fromHex(hex)).toEqual(data);
					expect(helpers.fromHex(hex.toUpperCase())).toEqual(data);
				})
			);
		});

		it('should accept exactly the strings of hex digit pairs, identically with or without the native decoder', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom(...'09afAFgG x', '😀'), maxLength: 10 }), function (text) {
					const native = outcome(function () {
						return helpers.fromHex(text);
					});
					const portable = outcome(function () {
						return without(Uint8Array, 'fromHex', function () {
							return helpers.fromHex(text);
						});
					});
					expect(portable).toEqual(native);
					expect('value' in native).toBe(/^(?:[0-9a-f]{2})*$/i.test(text));
					if ('value' in native) expect(native.value).toEqual(new Uint8Array(Buffer.from(text, 'hex')));
				})
			);
		});
	});

	describe('encodeUtf8 / decodeUtf8', function () {
		it('should encode any string (lone surrogates included) like Buffer, natively or not', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (text) {
					const expected = new Uint8Array(Buffer.from(text, 'utf8'));
					expect(helpers.encodeUtf8(text)).toEqual(expected);
					expect(
						without(globalThis, 'TextEncoder', function () {
							return helpers.encodeUtf8(text);
						})
					).toEqual(expected);
				})
			);
		});

		it('should throw with fatal exactly for strings that are not well-formed', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary', maxLength: 8 }), function (text) {
					const wellFormed = (text as string & { isWellFormed(): boolean }).isWellFormed();
					const result = outcome(function () {
						return helpers.encodeUtf8(text, { fatal: true });
					});
					expect('value' in result).toBe(wellFormed);
				})
			);
		});

		it('should decode any bytes like TextDecoder (replacement and fatal modes), natively or not', function () {
			const replacing = new TextDecoder('utf-8', { ignoreBOM: true });
			const fatal = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
			fc.assert(
				fc.property(utf8ish, function (data) {
					const expected = replacing.decode(data);
					const valid = outcome(function () {
						return fatal.decode(data);
					});
					expect(helpers.decodeUtf8(data)).toBe(expected);
					without(globalThis, 'TextDecoder', function () {
						expect(helpers.decodeUtf8(data)).toBe(expected);
						expect('value' in outcome(helpers.decodeUtf8.bind(null, data, { fatal: true }))).toBe('value' in valid);
					});
					expect('value' in outcome(helpers.decodeUtf8.bind(null, data, { fatal: true }))).toBe('value' in valid);
				})
			);
		});

		it('should be inverses on well-formed text, a leading BOM included', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), fc.boolean(), function (text, bom) {
					const source = (bom ? '﻿' : '') + text;
					expect(helpers.decodeUtf8(helpers.encodeUtf8(source), { fatal: true })).toBe(source);
					expect(helpers.decodeUtf8(helpers.encodeUtf8(source), { stripBom: true })).toBe(bom ? text : source.replace(/^﻿/, ''));
				})
			);
		});
	});

	describe('sha256', function () {
		it('should equal node:crypto for any bytes and any string', function () {
			fc.assert(
				fc.property(fc.uint8Array({ maxLength: 600 }), fc.string({ unit: 'binary' }), function (data, text) {
					expect(helpers.sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
					expect(helpers.sha256(text)).toEqual(new Uint8Array(createHash('sha256').update(text, 'utf8').digest()));
				})
			);
		});

		it('should equal node:crypto for views at any offset, over several blocks', function () {
			fc.assert(
				fc.property(fc.uint8Array({ minLength: 1, maxLength: 1200 }), fc.nat(), fc.nat(), function (data, at, size) {
					const start = at % data.length;
					const view = data.subarray(start, start + (size % (data.length - start + 1)));
					const expected = createHash('sha256').update(view).digest('hex');
					expect(helpers.sha256Hex(view)).toBe(expected);
					expect(helpers.sha256Hex(new DataView(view.buffer, view.byteOffset, view.byteLength))).toBe(expected);
				})
			);
		});
	});

	describe('timingSafeEqual', function () {
		it('should agree with Buffer#equals', function () {
			fc.assert(
				fc.property(fc.uint8Array({ maxLength: 8 }), fc.uint8Array({ maxLength: 8 }), fc.boolean(), function (a, b, same) {
					const other = same ? a.slice() : b;
					expect(helpers.timingSafeEqual(a, other)).toBe(Buffer.from(a).equals(Buffer.from(other)));
				})
			);
		});
	});

	describe('base32', function () {
		const ALPHABETS = {
			rfc4648: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
			hex: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
			crockford: '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
		} as const;
		const alphabet = fc.constantFrom('rfc4648' as const, 'hex' as const, 'crockford' as const);

		/** A naive reference encoder: the bits as a string of 0s and 1s, cut into groups of 5. */
		function reference(data: Uint8Array, name: keyof typeof ALPHABETS, pad: boolean): string {
			const bits = Array.from(data, function (byte) {
				return byte.toString(2).padStart(8, '0');
			}).join('');
			let text = '';
			for (let i = 0; i < bits.length; i += 5) text += ALPHABETS[name][parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
			return pad ? text.padEnd(Math.ceil(text.length / 8) * 8, '=') : text;
		}

		it('should equal the reference encoding and round-trip, in either letter case', function () {
			fc.assert(
				fc.property(bytes, alphabet, fc.boolean(), function (data, name, pad) {
					const encoded = helpers.toBase32(data, { alphabet: name, padding: pad });
					expect(encoded).toBe(reference(data, name, pad));
					expect(helpers.fromBase32(encoded, { alphabet: name, padding: pad ? 'required' : 'optional' })).toEqual(data);
					expect(helpers.fromBase32(encoded.toLowerCase(), { alphabet: name })).toEqual(data);
				})
			);
		});

		it('should accept only canonical text, which re-encodes to itself up to case and Crockford substitutions', function () {
			const base32ish = fc.oneof(
				fc.string({ unit: fc.constantFrom(...'AZaz27019ILOUilou=-', ' ', 'é'), maxLength: 18 }),
				fc.tuple(bytes, alphabet, fc.boolean(), fc.nat()).map(function ([data, name, pad, cut]) {
					const encoded = reference(data, name, pad);
					return encoded.slice(0, encoded.length - (cut % 3));
				})
			);
			fc.assert(
				fc.property(base32ish, alphabet, padding, function (text, name, pad) {
					const result = outcome(function () {
						return helpers.fromBase32(text, { alphabet: name, padding: pad });
					});
					if ('value' in result) {
						let expected = text.toUpperCase();
						if (name === 'crockford') expected = expected.replace(/[IL]/g, '1').replace(/O/g, '0');
						expect(helpers.toBase32(result.value, { alphabet: name, padding: text.includes('=') })).toBe(expected);
						expect(pad === 'required' ? text.length % 8 === 0 : pad === 'forbidden' ? !text.includes('=') : true).toBe(true);
					} else {
						expect(result.error).toMatch(/^SyntaxError: fromBase32: `text` must /);
					}
				})
			);
		});
	});

	describe('decodeJwt', function () {
		/** JSON objects whose text holds no prototype-pollution key (those are removed, see the unit tests). */
		const claims = fc.dictionary(fc.string(), fc.jsonValue()).filter(function (value) {
			return !/__proto__|constructor/.test(JSON.stringify(value));
		});

		it('should decode what was encoded', function () {
			fc.assert(
				fc.property(claims, claims, fc.uint8Array({ maxLength: 70 }), function (header, payload, signature) {
					const token = [JSON.stringify(header), JSON.stringify(payload)]
						.map(function (part) {
							return Buffer.from(part).toString('base64url');
						})
						.concat(Buffer.from(signature).toString('base64url'))
						.join('.');
					const decoded = helpers.decodeJwt(token);
					expect(decoded.header).toEqual(JSON.parse(JSON.stringify(header)));
					expect(decoded.payload).toEqual(JSON.parse(JSON.stringify(payload)));
					expect(decoded.signature).toEqual(signature);
				})
			);
		});

		it('should tell expiry exactly as now >= exp + leeway', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 4e9 }), fc.integer({ min: 0, max: 4e12 }), fc.nat({ max: 600 }), function (exp, now, leeway) {
					const token = `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.`;
					expect(helpers.isJwtExpired(token, { now, leeway })).toBe(now >= (exp + leeway) * 1000);
					expect(helpers.getJwtExpiration(token)).toEqual(new Date(exp * 1000));
				})
			);
		});

		it('should only stop being expired as the leeway grows, over the whole range of numbers', function () {
			const leeway = fc.double({ min: 0, noNaN: true, noDefaultInfinity: true });
			fc.assert(
				fc.property(fc.integer({ min: -8.64e12, max: 8.64e12 }), fc.double({ noNaN: true, noDefaultInfinity: true }), leeway, leeway, function (exp, now, a, b) {
					const token = `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.`;
					const [small, large] = a <= b ? [a, b] : [b, a];
					if (helpers.isJwtExpired(token, { now, leeway: large })) expect(helpers.isJwtExpired(token, { now, leeway: small })).toBe(true);
					// A leeway beyond any time span never expires the token.
					if (large > Number.MAX_VALUE / 500) expect(helpers.isJwtExpired(token, { now, leeway: large })).toBe(false);
				})
			);
		});
	});

	describe('parseCsv / toCsv', function () {
		/** Cells full of the characters that need quoting. */
		const cell = fc.oneof(fc.string({ unit: fc.constantFrom(',', ';', '\t', '"', '\r', '\n', '﻿', 'a', ' ', '=') }), fc.string({ unit: 'binary' }));
		const csvOptions = fc.record({
			delimiter: fc.constantFrom(',', ';', '\t', '|'),
			newline: fc.constantFrom('\r\n' as const, '\n' as const),
			quote: fc.constantFrom('needed' as const, 'all' as const)
		});

		it('should read back exactly the rows it wrote', function () {
			fc.assert(
				fc.property(fc.array(fc.array(cell, { minLength: 1, maxLength: 5 }), { maxLength: 6 }), csvOptions, function (rows, options) {
					const text = helpers.toCsv(rows, options);
					expect(helpers.parseCsv(text, { delimiter: options.delimiter, strict: false })).toEqual(rows);
				})
			);
		});

		it('should read back exactly the records it wrote', function () {
			fc.assert(
				fc.property(
					fc.uniqueArray(cell, { minLength: 1, maxLength: 4 }),
					fc.array(fc.array(cell, { minLength: 4, maxLength: 4 }), { maxLength: 5 }),
					csvOptions,
					function (names, values, options) {
						const records = values.map(function (row) {
							return Object.fromEntries(
								names.map(function (name, index) {
									return [name, row[index]];
								})
							);
						});
						const text = helpers.toCsv(records, { ...options, columns: names });
						expect(helpers.parseCsv(text, { delimiter: options.delimiter, header: true, strict: true })).toEqual(records);
					}
				)
			);
		});

		it('should split quote-free text on delimiters and line breaks, like a naive reference', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('a', 'b', ',', '\r', '\n', ' ') }), function (text) {
					const expected =
						text === ''
							? []
							: text
									.replace(/(?:\r\n|\r|\n)$/, '')
									.split(/\r\n|\r|\n/)
									.map(function (line) {
										return line.split(',');
									});
					expect(helpers.parseCsv(text)).toEqual(expected);
				})
			);
		});

		it('should only throw SyntaxErrors on arbitrary text, and write back what it reads to text that reads the same', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('"', ',', '\n', '\r', 'a') }), fc.boolean(), fc.boolean(), function (text, header, strict) {
					const result = outcome(function () {
						return helpers.parseCsv(text, { header, strict });
					});
					if ('error' in result) expect(result.error).toMatch(/^SyntaxError: parseCsv: /);
					else if (!header) expect(helpers.parseCsv(helpers.toCsv(result.value as string[][]))).toEqual(result.value);
				})
			);
		});

		it('should give each record the fields of its row only, so records hold no more keys than the text has fields', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('a', 'b', 'c', ',', '\n', '""') }), function (text) {
					const result = outcome(function () {
						return helpers.parseCsv(text, { header: true });
					});
					if ('error' in result) {
						expect(result.error).toMatch(/^SyntaxError: parseCsv: /);
						return;
					}
					const [names = [], ...rows] = helpers.parseCsv(text);
					expect(result.value).toHaveLength(rows.length);
					let keys = 0;
					let fields = 0;
					result.value.forEach(function (record, index) {
						const row = rows[index];
						const kept = row.slice(0, names.length);
						expect(Object.entries(record)).toEqual(
							kept.map(function (field, column) {
								return [names[column], field];
							})
						);
						keys += Object.keys(record).length;
						fields += row.length;
					});
					expect(keys).toBeLessThanOrEqual(fields);
				})
			);
		});

		it('should prefix every cell a spreadsheet could run as a formula and quote every field, with formulaEscape', function () {
			const risky = fc.string({
				unit: fc.constantFrom(
					' ',
					'\t',
					'\r',
					'\n',
					String.fromCharCode(0xa0),
					String.fromCharCode(0x3000),
					String.fromCharCode(0xfeff),
					'=',
					'+',
					'-',
					'@',
					'＝',
					'＋',
					'－',
					'＠',
					'a',
					';',
					',',
					'"',
					"'"
				),
				maxLength: 6
			});
			/**
			 * A naive reference: does the cell start with a tab or a carriage return, or with a formula sign after white space?
			 */
			function dangerous(text: string): boolean {
				if (text.startsWith('\t') || text.startsWith('\r')) return true;
				let index = 0;
				while (index < text.length && /\s/.test(text[index])) index++;
				return '=+-@＝＋－＠'.includes(text[index] ?? 'x');
			}
			fc.assert(
				fc.property(fc.array(fc.array(fc.oneof(risky, fc.integer()), { minLength: 1, maxLength: 4 }), { maxLength: 4 }), csvOptions, function (rows, options) {
					const escaped = rows.map(function (row) {
						return row.map(function (value) {
							return typeof value === 'string' && dangerous(value) ? `'${value}` : value;
						});
					});
					const text = helpers.toCsv(rows, { ...options, formulaEscape: true });
					expect(text).toBe(helpers.toCsv(escaped, { ...options, quote: 'all' }));
					expect(helpers.parseCsv(text, { delimiter: options.delimiter })).toEqual(
						escaped.map(function (row) {
							return row.map(String);
						})
					);
				})
			);
		});
	});
});

describe('HMAC, CRC-32 and signed JWTs (property-based)', function () {
	const data = fc.oneof(fc.uint8Array({ maxLength: 300 }), fc.string({ unit: 'binary', maxLength: 100 }));

	describe('hmacSha256', function () {
		it('should equal the HMAC of node:crypto for any key and message', function () {
			fc.assert(
				fc.property(data, data, function (key, message) {
					const keyBytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
					expect(helpers.hmacSha256Hex(key, message)).toBe(createHmac('sha256', keyBytes).update(message).digest('hex'));
				})
			);
		});

		it('should treat a key longer than a block as its digest', function () {
			fc.assert(
				fc.property(fc.uint8Array({ minLength: 65, maxLength: 300 }), fc.uint8Array({ maxLength: 100 }), function (key, message) {
					expect(helpers.hmacSha256(key, message)).toEqual(helpers.hmacSha256(helpers.sha256(key), message));
				})
			);
		});
	});

	describe('crc32', function () {
		const initial = fc.integer({ min: 0, max: 0xffffffff });

		it('should equal zlib.crc32 for any data and initial value', function () {
			fc.assert(
				fc.property(data, initial, function (value, start) {
					expect(helpers.crc32(value, start)).toBe(crc32(value, start));
				})
			);
		});

		it('should continue a checksum: crc32(b, crc32(a)) === crc32(a + b)', function () {
			fc.assert(
				fc.property(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), initial, function (a, b, start) {
					const whole = new Uint8Array(a.length + b.length);
					whole.set(a);
					whole.set(b, a.length);
					expect(helpers.crc32(b, helpers.crc32(a, start))).toBe(helpers.crc32(whole, start));
				})
			);
		});

		it('should detect every single-bit error', function () {
			fc.assert(
				fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), fc.nat(), function (value, at) {
					const corrupted = value.slice();
					const bit = at % (value.length * 8);
					corrupted[bit >> 3] ^= 1 << (bit & 7);
					expect(helpers.crc32(corrupted)).not.toBe(helpers.crc32(value));
				})
			);
		});
	});

	describe('signJwt / verifyJwt', function () {
		/** JSON objects without prototype-pollution keys (removed on decoding) nor registered time claims (checked on verification). */
		const claims = fc.dictionary(fc.string(), fc.jsonValue()).filter(function (value) {
			return !/__proto__|constructor|"(exp|nbf|iat)"/.test(JSON.stringify(value));
		});
		const secret = fc.oneof(fc.string({ minLength: 1, maxLength: 80 }), fc.uint8Array({ minLength: 1, maxLength: 100 }));

		it('should sign tokens that node:crypto verifies and verifyJwt returns as signed', function () {
			fc.assert(
				fc.property(claims, secret, fc.integer({ min: 0, max: 4e12 }), function (payload, key, now) {
					const token = helpers.signJwt(payload, key, { now });
					const [header, body, signature] = token.split('.');
					const keyBytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
					expect(signature).toBe(createHmac('sha256', keyBytes).update(`${header}.${body}`).digest('base64url'));
					expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
					const expected = { ...JSON.parse(JSON.stringify(payload)), iat: Math.floor(now / 1000) };
					expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual(expected);
					expect(helpers.verifyJwt(token, key, { now, maxAge: 1 })).toEqual({ header: { alg: 'HS256', typ: 'JWT' }, payload: expected });
				})
			);
		});

		it('should reject any change to a signed token', function () {
			fc.assert(
				fc.property(claims, fc.nat(), fc.constantFrom(...'ABCabc019-_.=+/ é'), function (payload, at, character) {
					const token = helpers.signJwt(payload, 'secret', { timestamp: false });
					const index = at % token.length;
					fc.pre(token[index] !== character);
					const changed = token.slice(0, index) + character + token.slice(index + 1);
					expect(function () {
						helpers.verifyJwt(changed, 'secret');
					}).toThrow(helpers.JwtVerificationError);
					expect(function () {
						helpers.verifyJwt(token, 'secret!');
					}).toThrow(expect.objectContaining({ code: 'invalid_signature' }));
				})
			);
		});

		it('should accept a token exactly while nbf - tolerance <= now < exp + tolerance', function () {
			fc.assert(
				fc.property(
					fc.integer({ min: 0, max: 4e9 }),
					fc.integer({ min: 0, max: 600 }),
					fc.integer({ min: -4e12, max: 8e12 }),
					fc.nat({ max: 120 }),
					function (nbf, lifetime, now, tolerance) {
						const token = helpers.signJwt({ nbf, exp: nbf + lifetime }, 'secret', { timestamp: false });
						let code: string | undefined;
						try {
							helpers.verifyJwt(token, 'secret', { now, clockTolerance: tolerance });
						} catch (error) {
							code = (error as helpers.JwtVerificationError).code;
						}
						const expired = now >= (nbf + lifetime + tolerance) * 1000;
						expect(code).toBe(expired ? 'expired' : now < (nbf - tolerance) * 1000 ? 'not_before' : undefined);
					}
				)
			);
		});

		it('should accept a token with maxAge exactly while iat - tolerance <= now < iat + maxAge + tolerance + 1 second', function () {
			fc.assert(
				fc.property(
					fc.integer({ min: 0, max: 4e9 }),
					fc.integer({ min: 0, max: 600 }),
					fc.nat({ max: 120 }),
					// Near either boundary (iat - tolerance or iat + maxAge + tolerance), to the millisecond.
					fc.boolean(),
					fc.integer({ min: -2000, max: 2000 }),
					function (iat, maxAge, tolerance, upper, offset) {
						const now = (upper ? iat + maxAge + tolerance : iat - tolerance) * 1000 + offset;
						const token = helpers.signJwt({ iat }, 'secret');
						let code: string | undefined;
						try {
							helpers.verifyJwt(token, 'secret', { now, maxAge, clockTolerance: tolerance });
						} catch (error) {
							code = (error as helpers.JwtVerificationError).code;
						}
						const future = now < (iat - tolerance) * 1000;
						expect(code).toBe(future ? 'invalid_claim' : now >= (iat + maxAge + tolerance + 1) * 1000 ? 'too_old' : undefined);
					}
				)
			);
		});

		it('should never quote the token or the secret in its errors', function () {
			const marker = fc.string({ minLength: 12, maxLength: 20, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz') });
			fc.assert(
				fc.property(marker, marker, fc.integer({ min: 0, max: 6 }), function (key, claim, variant) {
					const valid = helpers.signJwt({ sub: claim, iss: claim, aud: claim, exp: 1000, nbf: 0, iat: 0 }, key, { timestamp: false });
					const [header, body] = valid.split('.');
					const tokens = [
						valid,
						`${header}.${body}.`,
						`${Buffer.from(`{"alg":"${claim}"}`).toString('base64url')}.${body}.`,
						`${Buffer.from(`{"alg":"HS256","x":${claim}}`).toString('base64url')}.${body}.`,
						`${header}.${Buffer.from(`{"sub":${claim}}`).toString('base64url')}.`,
						`${claim}.${claim}.${claim}`,
						claim
					];
					const options = [{ now: 2e6 }, { now: 0, issuer: 'x' }, { now: 0, audience: 'x' }, { now: 0, subject: 'x' }, { now: 1e9, maxAge: 1 }];
					for (const option of options) {
						try {
							helpers.verifyJwt(tokens[variant], key, option);
						} catch (error) {
							expect((error as Error).message).not.toContain(claim);
							expect((error as Error).message).not.toContain(key);
						}
					}
				})
			);
		});
	});
});
