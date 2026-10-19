import { createHash } from 'node:crypto';
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
	});
});
