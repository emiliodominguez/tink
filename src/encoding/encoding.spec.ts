import { createHash, createHmac } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { crc32 } from 'node:zlib';
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

/**
 * Runs `fn` with `target[key]` replaced by `value`, restoring the original property afterwards.
 */
function replacing<T>(target: object, key: PropertyKey, value: unknown, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { value, configurable: true, writable: true });
	try {
		return fn();
	} finally {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else delete (target as Record<PropertyKey, unknown>)[key];
	}
}

/** Runs `fn` twice: with the native fast path named by `key` on `target`, then without it. */
function bothPaths(target: object, key: PropertyKey, fn: () => void): void {
	fn();
	without(target, key, fn);
}

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

function text(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'latin1'));
}

const RFC_4648 = [
	['', '', ''],
	['f', 'Zg==', '66'],
	['fo', 'Zm8=', '666f'],
	['foo', 'Zm9v', '666f6f'],
	['foob', 'Zm9vYg==', '666f6f62'],
	['fooba', 'Zm9vYmE=', '666f6f6261'],
	['foobar', 'Zm9vYmFy', '666f6f626172']
] as const;

describe('encoding', function () {
	describe('toBase64', function () {
		it('should encode the RFC 4648 test vectors, with and without padding', function () {
			bothPaths(Uint8Array.prototype, 'toBase64', function () {
				for (const [input, base64] of RFC_4648) {
					expect(helpers.toBase64(text(input))).toBe(base64);
					expect(helpers.toBase64(text(input), { padding: false })).toBe(base64.replace(/=+$/, ''));
					expect(helpers.toBase64(text(input), { urlSafe: true })).toBe(base64.replace(/=+$/, ''));
					expect(helpers.toBase64(text(input), { urlSafe: true, padding: true })).toBe(base64);
				}
			});
		});

		it('should use the URL-safe alphabet on request', function () {
			bothPaths(Uint8Array.prototype, 'toBase64', function () {
				const all = new Uint8Array([0xfb, 0xff, 0xbf, 0xfb, 0xef]);
				expect(helpers.toBase64(all)).toBe('+/+/++8=');
				expect(helpers.toBase64(all, { urlSafe: true })).toBe('-_-_--8');
			});
		});

		it('should encode strings as UTF-8, unlike btoa', function () {
			bothPaths(Uint8Array.prototype, 'toBase64', function () {
				expect(helpers.toBase64('hello')).toBe('aGVsbG8=');
				expect(helpers.toBase64('€😀')).toBe(Buffer.from('€😀').toString('base64'));
				expect(helpers.toBase64('\uD800')).toBe('77+9');
			});
		});

		it('should encode large inputs (several conversion chunks) like Buffer', function () {
			const large = new Uint8Array(50_000);
			for (let i = 0; i < large.length; i++) large[i] = (i * 7919) % 256;
			bothPaths(Uint8Array.prototype, 'toBase64', function () {
				expect(helpers.toBase64(large)).toBe(Buffer.from(large).toString('base64'));
				expect(helpers.toBase64(large.subarray(1), { urlSafe: true })).toBe(Buffer.from(large.subarray(1)).toString('base64url'));
			});
		});

		it('should read only the bytes a view covers, whatever its type', function () {
			const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
			expect(helpers.toBase64(new Uint8Array(buffer, 2, 3))).toBe(Buffer.from([3, 4, 5]).toString('base64'));
			expect(helpers.toBase64(new DataView(buffer, 1, 2))).toBe(Buffer.from([2, 3]).toString('base64'));
			expect(helpers.toHex(new Uint16Array(buffer, 2, 2))).toBe('03040506');
			expect(helpers.toHex(new Float64Array(buffer))).toBe('0102030405060708');
			expect(helpers.toHex(buffer)).toBe('0102030405060708');
			expect(helpers.toHex(Buffer.from([9, 10]))).toBe('090a');
			expect(helpers.toHex(new BigInt64Array(1))).toBe('0000000000000000');
		});

		it('should accept views and buffers from another realm', function () {
			const foreign = runInNewContext('new Uint8Array([1, 2, 255])') as Uint8Array;
			expect(helpers.toBase64(foreign)).toBe('AQL/');
			expect(helpers.toHex(runInNewContext('new Uint8Array([1, 2]).buffer') as ArrayBuffer)).toBe('0102');
			expect(helpers.toHex(runInNewContext('new DataView(new Uint8Array([1, 2, 3]).buffer, 1)') as DataView)).toBe('0203');
		});

		it('should ignore own properties planted on a view', function () {
			const view = new Uint8Array([1, 2, 3]);
			Object.defineProperty(view, 'length', { value: 1000 });
			Object.defineProperty(view, 'byteLength', { value: 1000 });
			Object.defineProperty(view, 'byteOffset', { value: 2 });
			Object.defineProperty(view, 'buffer', { value: new ArrayBuffer(1000) });
			bothPaths(Uint8Array.prototype, 'toBase64', function () {
				expect(helpers.toBase64(view)).toBe('AQID');
			});
			expect(helpers.toHex(view)).toBe('010203');
			expect(helpers.sha256Hex(view)).toBe(helpers.sha256Hex(new Uint8Array([1, 2, 3])));
		});

		it('should treat detached and out-of-bounds views as empty', function () {
			const buffer = new ArrayBuffer(8);
			const view = new Uint8Array(buffer, 4);
			const dataView = new DataView(buffer);
			structuredClone(buffer, { transfer: [buffer] }); // detaches it (ArrayBuffer#transfer needs Node 21)
			expect(helpers.toBase64(view)).toBe('');
			expect(helpers.toBase64(dataView)).toBe('');
			expect(helpers.toBase64(buffer)).toBe('');
			expect(helpers.decodeUtf8(view)).toBe('');

			const resizable = new (ArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => ArrayBuffer & { resize(n: number): void })(8, {
				maxByteLength: 16
			});
			const tail = new Uint8Array(resizable, 4, 4);
			const tracking = new Uint8Array(resizable);
			resizable.resize(2);
			expect(helpers.toHex(tail)).toBe('');
			expect(helpers.toHex(tracking)).toBe('0000');
		});

		it('should accept views over shared memory', function () {
			const shared = new Uint8Array(new SharedArrayBuffer(3));
			shared.set([104, 105, 33]);
			expect(helpers.toBase64(shared)).toBe('aGkh');
			expect(helpers.decodeUtf8(shared)).toBe('hi!');
			expect(helpers.sha256Hex(shared)).toBe(helpers.sha256Hex('hi!'));
		});

		it('should reject anything that is not a string or binary data', function () {
			for (const value of [null, undefined, 1, [1, 2], { length: 1, 0: 1 }, new SharedArrayBuffer(1), Object.create(ArrayBuffer.prototype)]) {
				expect(function () {
					helpers.toBase64(value as never);
				}).toThrow(TypeError);
			}
			expect(function () {
				helpers.toBase64([1, 2] as never);
			}).toThrow(new TypeError('toBase64: `data` must be a string, an ArrayBuffer or an ArrayBuffer view, got object'));
			expect(function () {
				helpers.toHex(null as never);
			}).toThrow(new TypeError('toHex: `data` must be a string, an ArrayBuffer or an ArrayBuffer view, got null'));
			expect(function () {
				helpers.sha256(5 as never);
			}).toThrow(new TypeError('sha256: `data` must be a string, an ArrayBuffer or an ArrayBuffer view, got number'));
		});
	});

	describe('fromBase64', function () {
		it('should decode the RFC 4648 test vectors, padded or not', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				for (const [input, base64] of RFC_4648) {
					expect(helpers.fromBase64(base64)).toEqual(text(input));
					expect(helpers.fromBase64(base64.replace(/=+$/, ''))).toEqual(text(input));
					expect(helpers.fromBase64(base64.replace(/=+$/, ''), { urlSafe: true, padding: 'forbidden' })).toEqual(text(input));
					expect(helpers.fromBase64(base64, { padding: 'required' })).toEqual(text(input));
				}
			});
		});

		it('should decode each alphabet only with its own option', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				expect(helpers.fromBase64('+/+/++8=')).toEqual(bytes(0xfb, 0xff, 0xbf, 0xfb, 0xef));
				expect(helpers.fromBase64('-_-_--8', { urlSafe: true })).toEqual(bytes(0xfb, 0xff, 0xbf, 0xfb, 0xef));
				expect(function () {
					helpers.fromBase64('-_-_--8');
				}).toThrow(new SyntaxError('fromBase64: `text` must contain only base64 characters, got "-" at index 0'));
				expect(function () {
					helpers.fromBase64('+/+/', { urlSafe: true });
				}).toThrow(new SyntaxError('fromBase64: `text` must contain only base64url characters, got "+" at index 0'));
			});
		});

		it('should report the first invalid character, a whole code point, and its index', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				const cases: [string, string, number][] = [
					['aGVs bG8=', '" "', 4],
					['aGVsbG8=\n', '"="', 7],
					['aGVsbG8\n', '"\\n"', 7],
					['aGVsb\tG8', '"\\t"', 5],
					['aGVsbG😀', '"😀"', 6],
					['aGé=', '"é"', 2],
					['aGVsbG\uD83D', '"\\ud83d"', 6],
					['YQ==YQ==', '"="', 2],
					['YQ=a', '"="', 2],
					['Y===', '"="', 1],
					['aGk!', '"!"', 3],
					['aGkĀ', '"Ā"', 3],
					['ab\u0000c', '"\\u0000"', 2]
				];
				for (const [input, character, index] of cases) {
					expect(function () {
						helpers.fromBase64(input);
					}).toThrow(new SyntaxError(`fromBase64: \`text\` must contain only base64 characters, got ${character} at index ${index}`));
				}
			});
		});

		it('should enforce the padding option', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				expect(function () {
					helpers.fromBase64('aGk', { padding: 'required' });
				}).toThrow(new SyntaxError('fromBase64: `text` must be padded to a multiple of 4 characters, got 3'));
				expect(function () {
					helpers.fromBase64('aGk=', { padding: 'forbidden' });
				}).toThrow(new SyntaxError('fromBase64: `text` must not be padded, got "=" at index 3'));
				expect(function () {
					helpers.fromBase64('YQ=');
				}).toThrow(new SyntaxError('fromBase64: `text` must be padded to a multiple of 4 characters, got 3'));
				expect(function () {
					helpers.fromBase64('YWJj=');
				}).toThrow(new SyntaxError('fromBase64: `text` must be padded to a multiple of 4 characters, got 5'));
				expect(function () {
					helpers.fromBase64('=');
				}).toThrow(new SyntaxError('fromBase64: `text` must be padded to a multiple of 4 characters, got 1'));
				expect(function () {
					helpers.fromBase64('==');
				}).toThrow(SyntaxError);
				expect(helpers.fromBase64('YWJj', { padding: 'required' })).toEqual(text('abc'));
				expect(helpers.fromBase64('', { padding: 'required' })).toEqual(new Uint8Array(0));
				expect(helpers.fromBase64('', { padding: 'forbidden' })).toEqual(new Uint8Array(0));
			});
		});

		it('should reject a dangling final character', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				for (const input of ['a', 'aGVsb', 'aGVsb===', 'a===']) {
					expect(function () {
						helpers.fromBase64(input);
					}).toThrow(SyntaxError);
				}
				expect(function () {
					helpers.fromBase64('aGVsb');
				}).toThrow(new SyntaxError('fromBase64: `text` must not end with a lone character (it would encode no whole byte), got 5 data characters'));
				// Padding could not fix a lone character: that is the error, whatever the padding option.
				for (const [input, options] of [
					['A=', {}],
					['A==', {}],
					['A', { padding: 'required' }],
					['A=', { padding: 'forbidden' }]
				] as const) {
					expect(function () {
						helpers.fromBase64(input, options);
					}).toThrow(new SyntaxError('fromBase64: `text` must not end with a lone character (it would encode no whole byte), got 1 data characters'));
				}
			});
		});

		it('should reject non-canonical encodings (non-zero unused bits)', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				expect(function () {
					helpers.fromBase64('YR==');
				}).toThrow(new SyntaxError('fromBase64: `text` must be canonical (the unused bits of its last character must be 0), got "R" at index 1'));
				expect(function () {
					helpers.fromBase64('YWK');
				}).toThrow(new SyntaxError('fromBase64: `text` must be canonical (the unused bits of its last character must be 0), got "K" at index 2'));
				expect(function () {
					helpers.fromBase64('YW_', { urlSafe: true });
				}).toThrow(SyntaxError);
				expect(helpers.fromBase64('YQ==')).toEqual(text('a'));
				expect(helpers.fromBase64('YWI')).toEqual(text('ab'));
			});
		});

		it('should report an invalid last character before its unused bits', function () {
			bothPaths(Uint8Array, 'fromBase64', function () {
				expect(function () {
					helpers.fromBase64('Yÿ');
				}).toThrow(new SyntaxError('fromBase64: `text` must contain only base64 characters, got "ÿ" at index 1'));
				expect(function () {
					helpers.fromBase64('YW*');
				}).toThrow(new SyntaxError('fromBase64: `text` must contain only base64 characters, got "*" at index 2'));
			});
		});

		it('should decode large inputs like Buffer', function () {
			const large = new Uint8Array(30_001);
			for (let i = 0; i < large.length; i++) large[i] = (i * 31) % 256;
			const encoded = Buffer.from(large).toString('base64');
			bothPaths(Uint8Array, 'fromBase64', function () {
				expect(helpers.fromBase64(encoded)).toEqual(large);
			});
		});

		it('should return a fresh array', function () {
			const a = helpers.fromBase64('AAAA');
			a[0] = 1;
			expect(helpers.fromBase64('AAAA')).toEqual(bytes(0, 0, 0));
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.fromBase64(1 as never);
			}).toThrow(new TypeError('fromBase64: `text` must be a string, got number'));
			expect(function () {
				helpers.fromBase64(new String('AAAA') as never);
			}).toThrow(TypeError);
			expect(function () {
				helpers.fromBase64('AAAA', { padding: 'yes' as never });
			}).toThrow(new RangeError("fromBase64: `padding` must be 'optional', 'required' or 'forbidden', got yes"));
			expect(function () {
				helpers.fromBase64('AAAA', { padding: {} as never });
			}).toThrow(new RangeError("fromBase64: `padding` must be 'optional', 'required' or 'forbidden', got object"));
		});

		it('should read each option once', function () {
			let reads = 0;
			const options = {
				get urlSafe(): boolean {
					reads++;
					return reads === 1;
				}
			};
			expect(helpers.fromBase64('-_8', options)).toEqual(bytes(251, 255));
			expect(reads).toBe(1);
		});
	});

	describe('toHex / fromHex', function () {
		it('should encode lowercase hex', function () {
			bothPaths(Uint8Array.prototype, 'toHex', function () {
				for (const [input, , hex] of RFC_4648) expect(helpers.toHex(text(input))).toBe(hex);
				expect(helpers.toHex(bytes(0, 1, 15, 16, 127, 128, 254, 255))).toBe('00010f107f80feff');
				expect(helpers.toHex('é')).toBe('c3a9');
			});
		});

		it('should decode hex in either letter case', function () {
			bothPaths(Uint8Array, 'fromHex', function () {
				for (const [input, , hex] of RFC_4648) {
					expect(helpers.fromHex(hex)).toEqual(text(input));
					expect(helpers.fromHex(hex.toUpperCase())).toEqual(text(input));
				}
				expect(helpers.fromHex('0123456789abcdefABCDEF')).toEqual(bytes(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef));
			});
		});

		it('should reject odd lengths and non-digits, naming the first offending character', function () {
			bothPaths(Uint8Array, 'fromHex', function () {
				expect(function () {
					helpers.fromHex('abc');
				}).toThrow(new SyntaxError('fromHex: `text` must have an even number of hex digits, got 3'));
				const cases: [string, string, number][] = [
					['0x12', '"x"', 1],
					['ag', '"g"', 1],
					['G0', '"G"', 0],
					['12 3', '" "', 2],
					['12:3', '":"', 2],
					['/0', '"/"', 0],
					['@0', '"@"', 0],
					['`0', '"`"', 0],
					['00😀', '"😀"', 2],
					['０１', '"０"', 0]
				];
				for (const [input, character, index] of cases) {
					expect(function () {
						helpers.fromHex(input);
					}).toThrow(new SyntaxError(`fromHex: \`text\` must contain only hex digits, got ${character} at index ${index}`));
				}
			});
		});

		it('should validate its argument', function () {
			expect(function () {
				helpers.fromHex(12 as never);
			}).toThrow(new TypeError('fromHex: `text` must be a string, got number'));
		});
	});

	describe('encodeUtf8', function () {
		const cases: [string, number[]][] = [
			['', []],
			['a\u0000\u007f', [0x61, 0x00, 0x7f]],
			['\u0080߿', [0xc2, 0x80, 0xdf, 0xbf]],
			['ࠀ￿', [0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf]],
			['퟿', [0xed, 0x9f, 0xbf, 0xee, 0x80, 0x80]],
			['😀', [0xf0, 0x9f, 0x98, 0x80]],
			['\u{10000}\u{10FFFF}', [0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf]],
			['\uD800', [0xef, 0xbf, 0xbd]],
			['\uDC00', [0xef, 0xbf, 0xbd]],
			['\uDBFFa', [0xef, 0xbf, 0xbd, 0x61]],
			['\uDC00\uD800', [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]],
			['\uD800𐀀', [0xef, 0xbf, 0xbd, 0xf0, 0x90, 0x80, 0x80]],
			['﻿', [0xef, 0xbb, 0xbf]]
		];

		it('should encode like TextEncoder, natively or not', function () {
			bothPaths(globalThis, 'TextEncoder', function () {
				for (const [input, expected] of cases) expect(Array.from(helpers.encodeUtf8(input))).toEqual(expected);
			});
		});

		it('should throw on lone surrogates with fatal', function () {
			bothPaths(globalThis, 'TextEncoder', function () {
				expect(function () {
					helpers.encodeUtf8('ab\uD800', { fatal: true });
				}).toThrow(new TypeError('encodeUtf8: `text` must be well-formed UTF-16, got a lone surrogate "\\ud800" at index 2'));
				expect(function () {
					helpers.encodeUtf8('😀\uDC00', { fatal: true });
				}).toThrow(new TypeError('encodeUtf8: `text` must be well-formed UTF-16, got a lone surrogate "\\udc00" at index 2'));
				expect(Array.from(helpers.encodeUtf8('😀', { fatal: true }))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
			});
		});

		it('should find lone surrogates without the native isWellFormed too', function () {
			without(String.prototype, 'isWellFormed', function () {
				expect(function () {
					helpers.encodeUtf8('ab\uD800', { fatal: true });
				}).toThrow(new TypeError('encodeUtf8: `text` must be well-formed UTF-16, got a lone surrogate "\\ud800" at index 2'));
				expect(Array.from(helpers.encodeUtf8('😀', { fatal: true }))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
			});
		});

		it('should create a new encoder when the global TextEncoder changes', function () {
			const Native = globalThis.TextEncoder;
			let created = 0;
			class Counting extends Native {
				constructor() {
					super();
					created++;
				}
			}
			replacing(globalThis, 'TextEncoder', Counting, function () {
				helpers.encodeUtf8('a');
				helpers.encodeUtf8('b');
			});
			expect(created).toBe(1);
			expect(Array.from(helpers.encodeUtf8('c'))).toEqual([0x63]);
		});

		it('should validate its argument', function () {
			expect(function () {
				helpers.encodeUtf8(1 as never);
			}).toThrow(new TypeError('encodeUtf8: `text` must be a string, got number'));
			expect(function () {
				helpers.encodeUtf8(null as never, { fatal: true });
			}).toThrow(new TypeError('encodeUtf8: `text` must be a string, got null'));
		});
	});

	describe('decodeUtf8', function () {
		const replacement = 0xfffd;
		// Bytes, then the code points the WHATWG decoder produces (one U+FFFD per maximal invalid subpart).
		const cases: [number[], number[]][] = [
			[[], []],
			[
				[0x61, 0x00, 0x7f],
				[0x61, 0x00, 0x7f]
			],
			[
				[0xc2, 0x80, 0xdf, 0xbf],
				[0x80, 0x7ff]
			],
			[
				[0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf],
				[0x800, 0xffff]
			],
			[
				[0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf],
				[0x10000, 0x10ffff]
			],
			[[0x80], [replacement]],
			[
				[0xbf, 0x61],
				[replacement, 0x61]
			],
			[
				[0xc0, 0x80],
				[replacement, replacement]
			],
			[
				[0xc1, 0xbf],
				[replacement, replacement]
			],
			[
				[0xe0, 0x80, 0x80],
				[replacement, replacement, replacement]
			],
			[
				[0xe0, 0x9f, 0xbf],
				[replacement, replacement, replacement]
			],
			[
				[0xed, 0xa0, 0x80],
				[replacement, replacement, replacement]
			],
			[[0xed, 0x9f, 0xbf], [0xd7ff]],
			[
				[0xf0, 0x80, 0x80, 0x80],
				[replacement, replacement, replacement, replacement]
			],
			[
				[0xf0, 0x8f, 0xbf, 0xbf],
				[replacement, replacement, replacement, replacement]
			],
			[
				[0xf4, 0x90, 0x80, 0x80],
				[replacement, replacement, replacement, replacement]
			],
			[
				[0xf5, 0x80],
				[replacement, replacement]
			],
			[
				[0xff, 0xfe],
				[replacement, replacement]
			],
			[[0xe2, 0x82], [replacement]],
			[
				[0xe2, 0x82, 0x61],
				[replacement, 0x61]
			],
			[[0xf0, 0x9f, 0x98], [replacement]],
			[
				[0xf0, 0x9f, 0x98, 0xc3, 0xa9],
				[replacement, 0xe9]
			],
			[[0xc3], [replacement]],
			[
				[0x61, 0xc3, 0xc3, 0xa9],
				[0x61, replacement, 0xe9]
			],
			[
				[0xef, 0xbb, 0xbf, 0x61],
				[0xfeff, 0x61]
			]
		];

		it('should decode like the WHATWG decoder (TextDecoder), natively or not', function () {
			bothPaths(globalThis, 'TextDecoder', function () {
				for (const [input, expected] of cases) {
					expect(helpers.decodeUtf8(new Uint8Array(input))).toBe(String.fromCodePoint(...expected));
				}
			});
		});

		it('should throw on malformed input with fatal, naming the byte', function () {
			bothPaths(globalThis, 'TextDecoder', function () {
				for (const [input, expected] of cases) {
					if (expected.includes(replacement)) {
						expect(function () {
							helpers.decodeUtf8(new Uint8Array(input), { fatal: true });
						}).toThrow(TypeError);
					} else {
						expect(helpers.decodeUtf8(new Uint8Array(input), { fatal: true })).toBe(String.fromCodePoint(...expected));
					}
				}
				expect(function () {
					helpers.decodeUtf8(bytes(0x61, 0x62, 0xe2, 0x82), { fatal: true });
				}).toThrow(new TypeError('decodeUtf8: `bytes` must be valid UTF-8, got a malformed sequence at byte 2'));
			});
		});

		it('should keep a byte order mark unless stripBom is set', function () {
			bothPaths(globalThis, 'TextDecoder', function () {
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a');
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61), { stripBom: true })).toBe('a');
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf), { stripBom: true })).toBe('﻿');
				expect(helpers.decodeUtf8(bytes(0x61, 0xef, 0xbb, 0xbf), { stripBom: true })).toBe('a﻿');
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb), { stripBom: true })).toBe('�');
				expect(helpers.decodeUtf8(bytes(), { stripBom: true })).toBe('');
			});
		});

		it('should decode long inputs (several conversion chunks)', function () {
			const source = 'aé€😀'.repeat(5000);
			const encoded = new Uint8Array(Buffer.from(source));
			bothPaths(globalThis, 'TextDecoder', function () {
				expect(helpers.decodeUtf8(encoded)).toBe(source);
				expect(helpers.decodeUtf8(encoded.subarray(1))).toBe(Buffer.from(encoded.subarray(1)).toString());
			});
		});

		it('should accept any binary data', function () {
			expect(helpers.decodeUtf8(new Uint8Array([104, 105]).buffer)).toBe('hi');
			expect(helpers.decodeUtf8(new DataView(new Uint8Array([0, 104, 105]).buffer, 1))).toBe('hi');
			expect(helpers.decodeUtf8(Buffer.from('héllo'))).toBe('héllo');
		});

		it('should fall back to the portable decoder when the native one refuses the input', function () {
			class Refusing {
				decode(): string {
					throw new TypeError('refused');
				}
			}
			replacing(globalThis, 'TextDecoder', Refusing, function () {
				expect(helpers.decodeUtf8(bytes(0x68, 0xc3, 0xa9))).toBe('hé');
				expect(function () {
					helpers.decodeUtf8(bytes(0x68, 0xc3), { fatal: true });
				}).toThrow(new TypeError('decodeUtf8: `bytes` must be valid UTF-8, got a malformed sequence at byte 1'));
			});
		});

		it('should create new decoders when the global TextDecoder changes, and reuse them otherwise', function () {
			const Native = globalThis.TextDecoder;
			const created: unknown[] = [];
			class Counting extends Native {
				constructor(label: string, options: { fatal: boolean; ignoreBOM: boolean }) {
					super(label, options);
					created.push(options);
				}
			}
			replacing(globalThis, 'TextDecoder', Counting, function () {
				helpers.decodeUtf8(bytes(0x61));
				helpers.decodeUtf8(bytes(0x61));
				helpers.decodeUtf8(bytes(0x61), { fatal: true });
				helpers.decodeUtf8(bytes(0x61), { fatal: true });
			});
			expect(created).toEqual([
				{ fatal: false, ignoreBOM: true },
				{ fatal: true, ignoreBOM: true }
			]);
			expect(helpers.decodeUtf8(bytes(0x62))).toBe('b');
		});

		it('should validate its argument', function () {
			expect(function () {
				helpers.decodeUtf8('abc' as never);
			}).toThrow(new TypeError('decodeUtf8: `bytes` must be an ArrayBuffer or an ArrayBuffer view, got string'));
			expect(function () {
				helpers.decodeUtf8([0x61] as never);
			}).toThrow(new TypeError('decodeUtf8: `bytes` must be an ArrayBuffer or an ArrayBuffer view, got object'));
		});
	});

	describe('sha256 / sha256Hex', function () {
		it('should hash the FIPS 180-4 / NIST test vectors', function () {
			expect(helpers.sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
			expect(helpers.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
			expect(helpers.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
			expect(helpers.sha256Hex('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')).toBe(
				'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
			);
			expect(helpers.sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
		});

		it('should match node:crypto around the block and padding boundaries', function () {
			for (let length = 0; length <= 200; length++) {
				const data = new Uint8Array(length);
				for (let i = 0; i < length; i++) data[i] = (i * 151 + length) % 256;
				expect(helpers.sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
			}
		});

		it('should return 32 fresh bytes', function () {
			const digest = helpers.sha256('abc');
			expect(digest).toBeInstanceOf(Uint8Array);
			expect(digest.length).toBe(32);
			digest[0] = 0;
			expect(helpers.sha256('abc')[0]).toBe(0xba);
		});

		it('should hash strings as UTF-8, lone surrogates as U+FFFD (like node:crypto)', function () {
			for (const value of ['é', '😀', '\uD800', 'a\uDC00b']) {
				expect(helpers.sha256Hex(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
			}
			without(globalThis, 'TextEncoder', function () {
				expect(helpers.sha256Hex('\uD800')).toBe(createHash('sha256').update('\uD800', 'utf8').digest('hex'));
			});
		});

		it('should hash the bytes of any view', function () {
			const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
			expect(helpers.sha256Hex(new DataView(buffer, 1, 2))).toBe(
				createHash('sha256')
					.update(Buffer.from([2, 3]))
					.digest('hex')
			);
			expect(helpers.sha256Hex(buffer)).toBe(
				createHash('sha256')
					.update(Buffer.from([1, 2, 3, 4]))
					.digest('hex')
			);
		});
	});

	describe('options', function () {
		/** Runs `fn` with `values` defined on `Object.prototype` (as a prototype-pollution attack would), removing them afterwards. */
		function polluted<T>(values: Record<string, unknown>, fn: () => T): T {
			for (const [key, value] of Object.entries(values)) {
				Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
			}
			try {
				return fn();
			} finally {
				for (const key of Object.keys(values)) delete (Object.prototype as Record<string, unknown>)[key];
			}
		}

		it('should ignore options inherited from a polluted Object.prototype (regression)', function () {
			polluted({ urlSafe: true, padding: false, fatal: true, stripBom: true }, function () {
				bothPaths(Uint8Array.prototype, 'toBase64', function () {
					expect(helpers.toBase64(bytes(0xfb, 0xff))).toBe('+/8=');
					expect(helpers.toBase64(bytes(0xfb, 0xff), {})).toBe('+/8=');
				});
				bothPaths(Uint8Array, 'fromBase64', function () {
					expect(helpers.fromBase64('+/8=', {})).toEqual(bytes(0xfb, 0xff));
				});
				expect(Array.from(helpers.encodeUtf8('\uD800', {}))).toEqual([0xef, 0xbf, 0xbd]);
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0xff))).toBe('\uFEFF\uFFFD');
				expect(helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0xff), {})).toBe('\uFEFF\uFFFD');
			});
		});

		it('should never use a decoding table or decoder planted on Object.prototype before first use (regression)', function () {
			// A fresh copy of the module, whose lazily built tables do not exist yet.
			let fresh: typeof helpers | undefined;
			jest.isolateModules(function () {
				fresh = jest.requireActual<typeof helpers>('./index');
			});
			const isolated = fresh as typeof helpers;
			const zeros = new Array<number>(128).fill(0);
			const decoder = {
				decode(): string {
					return 'planted';
				}
			};
			polluted({ 0: zeros, 1: decoder, 2: zeros }, function () {
				without(Uint8Array, 'fromBase64', function () {
					expect(isolated.fromBase64('aGk=')).toEqual(bytes(104, 105));
					expect(isolated.fromBase64('-_8', { urlSafe: true })).toEqual(bytes(0xfb, 0xff));
				});
				expect(isolated.fromBase32('MZXW6===')).toEqual(bytes(102, 111, 111));
				expect(isolated.fromBase32('0000', { alphabet: 'crockford' })).toEqual(bytes(0, 0));
				expect(isolated.decodeUtf8(bytes(104, 105), { fatal: true })).toBe('hi');
				expect(isolated.decodeJwt('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.').payload).toEqual({ sub: 'x' });
			});
		});

		it('should still read own options, including getters and options objects without a prototype', function () {
			const options = Object.create(null) as { urlSafe: boolean };
			options.urlSafe = true;
			expect(helpers.toBase64(bytes(0xfb, 0xff), options)).toBe('-_8');
			let reads = 0;
			expect(
				helpers.decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61), {
					get stripBom(): boolean {
						reads++;
						return true;
					}
				})
			).toBe('a');
			expect(reads).toBe(1);
			expect(helpers.toBase64(bytes(0xfb, 0xff), { urlSafe: undefined, padding: undefined })).toBe('+/8=');
		});

		it('should reject an options argument that is not an object', function () {
			for (const [name, call] of [
				[
					'toBase64',
					function (options: never): unknown {
						return helpers.toBase64('a', options);
					}
				],
				[
					'fromBase64',
					function (options: never): unknown {
						return helpers.fromBase64('YQ==', options);
					}
				],
				[
					'encodeUtf8',
					function (options: never): unknown {
						return helpers.encodeUtf8('a', options);
					}
				],
				[
					'decodeUtf8',
					function (options: never): unknown {
						return helpers.decodeUtf8(bytes(0x61), options);
					}
				]
			] as const) {
				expect(function () {
					call(null as never);
				}).toThrow(new TypeError(`${name}: \`options\` must be an object, got null`));
				expect(function () {
					call(true as never);
				}).toThrow(new TypeError(`${name}: \`options\` must be an object, got boolean`));
				expect(function () {
					call('url' as never);
				}).toThrow(TypeError);
			}
		});

		it('should reject boolean options that are not booleans (regression: truthy strings switched modes)', function () {
			expect(function () {
				helpers.toBase64('a', { padding: 'forbidden' as never });
			}).toThrow(new TypeError('toBase64: `padding` must be a boolean, got string'));
			expect(function () {
				helpers.toBase64('a', { padding: 'false' as never });
			}).toThrow(new TypeError('toBase64: `padding` must be a boolean, got string'));
			expect(function () {
				helpers.toBase64('a', { urlSafe: 'false' as never });
			}).toThrow(new TypeError('toBase64: `urlSafe` must be a boolean, got string'));
			expect(function () {
				helpers.toBase64('a', { padding: null as never });
			}).toThrow(new TypeError('toBase64: `padding` must be a boolean, got null'));
			expect(function () {
				helpers.fromBase64('YQ', { urlSafe: 1 as never });
			}).toThrow(new TypeError('fromBase64: `urlSafe` must be a boolean, got number'));
			expect(function () {
				helpers.encodeUtf8('a', { fatal: 'yes' as never });
			}).toThrow(new TypeError('encodeUtf8: `fatal` must be a boolean, got string'));
			expect(function () {
				helpers.decodeUtf8(bytes(0x61), { fatal: 0 as never });
			}).toThrow(new TypeError('decodeUtf8: `fatal` must be a boolean, got number'));
			expect(function () {
				helpers.decodeUtf8(bytes(0x61), { stripBom: {} as never });
			}).toThrow(new TypeError('decodeUtf8: `stripBom` must be a boolean, got object'));
		});
	});

	describe('portable toHex', function () {
		it('should encode large inputs (several conversion chunks) like Buffer', function () {
			const large = new Uint8Array(20_001);
			for (let i = 0; i < large.length; i++) large[i] = (i * 7919) % 256;
			without(Uint8Array.prototype, 'toHex', function () {
				expect(helpers.toHex(large)).toBe(Buffer.from(large).toString('hex'));
				expect(helpers.toHex(new Uint8Array(0))).toBe('');
			});
		});
	});

	describe('return types', function () {
		it('should return Uint8Arrays over their own (non-shared) ArrayBuffer', function () {
			const shared = new Uint8Array(new SharedArrayBuffer(2));
			for (const result of [helpers.fromBase64('AAA='), helpers.fromHex('0000'), helpers.encodeUtf8('é'), helpers.sha256(shared)]) {
				expect(Object.prototype.toString.call(result.buffer)).toBe('[object ArrayBuffer]');
				expect(result.byteOffset).toBe(0);
				expect(result.byteLength).toBe(result.buffer.byteLength);
			}
		});
	});
});

describe('timingSafeEqual', function () {
	it('should compare bytes and UTF-8 strings', function () {
		expect(helpers.timingSafeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
		expect(helpers.timingSafeEqual(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false);
		expect(helpers.timingSafeEqual(bytes(128), bytes(0))).toBe(false);
		expect(helpers.timingSafeEqual(bytes(), new ArrayBuffer(0))).toBe(true);
		expect(helpers.timingSafeEqual('é', bytes(0xc3, 0xa9))).toBe(true);
		expect(helpers.timingSafeEqual(new DataView(new Uint8Array([7, 8]).buffer, 1), bytes(8))).toBe(true);
		expect(helpers.timingSafeEqual('abc', 'abcd')).toBe(false);
		expect(helpers.timingSafeEqual('abcd', 'abc')).toBe(false);
	});

	it('should reject anything but strings and binary data, naming the parameter', function () {
		expect(function () {
			helpers.timingSafeEqual(1 as never, 'a');
		}).toThrow(new TypeError('timingSafeEqual: `a` must be a string, an ArrayBuffer or an ArrayBuffer view, got number'));
		expect(function () {
			helpers.timingSafeEqual('a', null as never);
		}).toThrow(new TypeError('timingSafeEqual: `b` must be a string, an ArrayBuffer or an ArrayBuffer view, got null'));
	});
});

describe('base32', function () {
	const VECTORS = [
		['', '', ''],
		['f', 'MY======', 'CO======'],
		['fo', 'MZXQ====', 'CPNG===='],
		['foo', 'MZXW6===', 'CPNMU==='],
		['foob', 'MZXW6YQ=', 'CPNMUOG='],
		['fooba', 'MZXW6YTB', 'CPNMUOJ1'],
		['foobar', 'MZXW6YTBOI======', 'CPNMUOJ1E8======']
	] as const;

	it('should encode and decode the RFC 4648 test vectors, padded or not', function () {
		for (const [input, base32, hex] of VECTORS) {
			expect(helpers.toBase32(input)).toBe(base32);
			expect(helpers.toBase32(input, { padding: false })).toBe(base32.replace(/=+$/, ''));
			expect(helpers.toBase32(input, { alphabet: 'hex' })).toBe(hex);
			expect(helpers.toBase32(input, { alphabet: 'rfc4648', padding: true })).toBe(base32);
			expect(helpers.fromBase32(base32)).toEqual(text(input));
			expect(helpers.fromBase32(base32.replace(/=+$/, ''))).toEqual(text(input));
			expect(helpers.fromBase32(hex, { alphabet: 'hex' })).toEqual(text(input));
			expect(helpers.fromBase32(base32.toLowerCase(), { padding: 'required' })).toEqual(text(input));
		}
	});

	it('should use Crockford base32 without padding, folding case, I, L and O', function () {
		expect(helpers.toBase32(bytes(0, 1, 2, 3, 4, 255, 254), { alphabet: 'crockford' })).toBe('000G40R4ZZZ0');
		expect(helpers.toBase32(bytes(255), { alphabet: 'crockford', padding: true })).toBe('ZW======');
		expect(helpers.fromBase32('000G40R4ZZZ0', { alphabet: 'crockford' })).toEqual(bytes(0, 1, 2, 3, 4, 255, 254));
		expect(helpers.fromBase32('oOoG4OR4zzzO', { alphabet: 'crockford' })).toEqual(bytes(0, 1, 2, 3, 4, 255, 254));
		expect(helpers.fromBase32('ILilOo00', { alphabet: 'crockford' })).toEqual(helpers.fromBase32('11110000', { alphabet: 'crockford' }));
		expect(function () {
			helpers.fromBase32('ZU', { alphabet: 'crockford' });
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only Crockford base32 characters, got "U" at index 1'));
		expect(function () {
			helpers.fromBase32('ZW-00', { alphabet: 'crockford' });
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only Crockford base32 characters, got "-" at index 2'));
		// The letters that Crockford leaves out are valid in the other alphabets.
		expect(helpers.fromBase32('IE======')).toEqual(bytes(0x41));
	});

	it('should encode large inputs (several conversion chunks) and strings as UTF-8', function () {
		const large = new Uint8Array(20_003);
		for (let i = 0; i < large.length; i++) large[i] = (i * 7919) % 256;
		const encoded = helpers.toBase32(large);
		expect(encoded.length).toBe(Math.ceil(large.length / 5) * 8);
		expect(helpers.fromBase32(encoded)).toEqual(large);
		expect(helpers.toBase32('é')).toBe(helpers.toBase32(bytes(0xc3, 0xa9)));
	});

	it('should reject characters outside the alphabet, before padding problems', function () {
		expect(function () {
			helpers.fromBase32('MZ1W====');
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got "1" at index 2'));
		expect(function () {
			helpers.fromBase32('MZXW', { alphabet: 'hex' });
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32hex characters, got "Z" at index 1'));
		expect(function () {
			helpers.fromBase32('M Y=====', { padding: 'forbidden' });
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got " " at index 1'));
		expect(function () {
			helpers.fromBase32('MY=A');
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got "=" at index 2'));
		expect(function () {
			helpers.fromBase32('MY😀');
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got "😀" at index 2'));
		expect(function () {
			helpers.fromBase32('MYé');
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got "é" at index 2'));
		expect(function () {
			helpers.fromBase32('MY=======');
		}).toThrow(new SyntaxError('fromBase32: `text` must contain only base32 characters, got "=" at index 2'));
	});

	it('should reject impossible lengths, wrong padding and non-canonical text', function () {
		for (const [input, remainder] of [
			['M', 1],
			['MZX', 3],
			['MZXW6Y', 6],
			['MZXW6YTBM', 1]
		] as const) {
			expect(function () {
				helpers.fromBase32(input);
			}).toThrow(
				new SyntaxError(`fromBase32: \`text\` must not end with a group of ${remainder} characters (no bytes encode to it), got ${input.length} data characters`)
			);
		}
		expect(function () {
			helpers.fromBase32('MY', { padding: 'required' });
		}).toThrow(new SyntaxError('fromBase32: `text` must be padded to a multiple of 8 characters, got 2'));
		expect(helpers.fromBase32('MZXW6YTB', { padding: 'required' })).toEqual(text('fooba'));
		expect(function () {
			helpers.fromBase32('MY======', { padding: 'forbidden' });
		}).toThrow(new SyntaxError('fromBase32: `text` must not be padded, got "=" at index 2'));
		expect(helpers.fromBase32('MY', { padding: 'forbidden' })).toEqual(text('f'));
		expect(function () {
			helpers.fromBase32('MY===');
		}).toThrow(new SyntaxError('fromBase32: `text` must be padded to a multiple of 8 characters, got 5'));
		expect(function () {
			helpers.fromBase32('======');
		}).toThrow(new SyntaxError('fromBase32: `text` must be padded to a multiple of 8 characters, got 6'));
		expect(function () {
			helpers.fromBase32('MZ======');
		}).toThrow(new SyntaxError('fromBase32: `text` must be canonical (the unused bits of its last character must be 0), got "Z" at index 1'));
		for (const canonical of ['MY', 'MZXQ', 'MZXW6', 'MZXW6YQ']) {
			const last = canonical.length - 1;
			const altered = canonical.slice(0, last) + String.fromCharCode(canonical.charCodeAt(last) + 1);
			expect(function () {
				helpers.fromBase32(altered);
			}).toThrow(SyntaxError);
		}
	});

	it('should validate its arguments and options', function () {
		expect(function () {
			helpers.toBase32(1 as never);
		}).toThrow(new TypeError('toBase32: `data` must be a string, an ArrayBuffer or an ArrayBuffer view, got number'));
		expect(function () {
			helpers.toBase32('', { alphabet: 'base32' as never });
		}).toThrow(new RangeError("toBase32: `alphabet` must be 'rfc4648', 'hex' or 'crockford', got base32"));
		expect(function () {
			helpers.toBase32('', { padding: 'yes' as never });
		}).toThrow(new TypeError('toBase32: `padding` must be a boolean, got string'));
		expect(function () {
			helpers.toBase32('', null as never);
		}).toThrow(new TypeError('toBase32: `options` must be an object, got null'));
		expect(function () {
			helpers.fromBase32(null as never);
		}).toThrow(new TypeError('fromBase32: `text` must be a string, got null'));
		expect(function () {
			helpers.fromBase32('', { alphabet: {} as never });
		}).toThrow(new RangeError("fromBase32: `alphabet` must be 'rfc4648', 'hex' or 'crockford', got object"));
		expect(function () {
			helpers.fromBase32('', { padding: true as never });
		}).toThrow(new RangeError("fromBase32: `padding` must be 'optional', 'required' or 'forbidden', got true"));
	});

	it('should ignore options inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.alphabet = 'crockford';
		proto.padding = 'forbidden';
		try {
			expect(helpers.toBase32('f', {})).toBe('MY======');
			expect(helpers.fromBase32('MY======', {})).toEqual(text('f'));
		} finally {
			delete proto.alphabet;
			delete proto.padding;
		}
	});
});

describe('decodeJwt', function () {
	/** Builds an unsigned token from JSON texts. */
	function token(header: string, payload: string, signature = ''): string {
		return `${Buffer.from(header).toString('base64url')}.${Buffer.from(payload).toString('base64url')}.${signature}`;
	}

	const JWT_IO =
		'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

	it('should decode the header, the payload and the signature bytes', function () {
		const decoded = helpers.decodeJwt(JWT_IO);
		expect(decoded.header).toEqual({ alg: 'HS256', typ: 'JWT' });
		expect(decoded.payload).toEqual({ sub: '1234567890', name: 'John Doe', iat: 1516239022 });
		expect(decoded.signature).toEqual(new Uint8Array(Buffer.from('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'base64url')));
		expect(helpers.decodeJwt(token('{"alg":"none"}', '{}')).signature).toEqual(new Uint8Array(0));
		expect(helpers.decodeJwt(token('{"alg":"none"}', '{"name":"Zoë 😀"}')).payload).toEqual({ name: 'Zoë 😀' });
	});

	it('should type the payload and the header with the type arguments', function () {
		interface Claims {
			sub: string;
			roles: string[];
		}
		const { payload, header } = helpers.decodeJwt<Claims, { alg: 'none' }>(token('{"alg":"none"}', '{"sub":"a","roles":["x"]}'));
		const roles: string[] = payload.roles;
		const alg: 'none' = header.alg;
		expect([roles, alg]).toEqual([['x'], 'none']);
		const exp: number | undefined = helpers.decodeJwt(JWT_IO).payload.exp;
		expect(exp).toBeUndefined();
	});

	it('should drop prototype-pollution keys, at any depth', function () {
		const { header, payload } = helpers.decodeJwt(
			token(
				'{"alg":"none","__proto__":{"admin":true}}',
				'{"a":{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"b":[{"__proto__":1}]},"constructor":"kept","c":{"constructor":{"x":1}}}'
			)
		);
		expect(Object.keys(header)).toEqual(['alg']);
		expect(payload).toEqual({ a: { b: [{}] }, constructor: 'kept', c: { constructor: { x: 1 } } });
		expect(Object.getPrototypeOf(payload.a)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).admin).toBeUndefined();
		// Hidden behind an escape too.
		expect(helpers.decodeJwt(token('{}', '{"\\u005f_proto__":{"admin":true}}')).payload).toEqual({});
		expect(helpers.decodeJwt(token('{}', '{"\\u0063onstructor":{"prototype":{"admin":true}},"a":1}')).payload).toEqual({ a: 1 });
		// A `constructor` key without any `__proto__` text.
		expect(helpers.decodeJwt(token('{}', '{"constructor":{"prototype":{"admin":true}},"a":1}')).payload).toEqual({ a: 1 });
		// An escape that spells another key leaves it as it is.
		expect(helpers.decodeJwt(token('{}', '{"\\u0061":"\\n"}')).payload).toEqual({ a: '\n' });
	});

	it('should reject tokens that are not three base64url parts', function () {
		for (const [input, parts] of [
			['', 1],
			['abc', 1],
			['a.b', 2],
			['a.b.c.d.e', 5]
		] as const) {
			expect(function () {
				helpers.decodeJwt(input);
			}).toThrow(new SyntaxError(`decodeJwt: \`token\` must have 3 parts separated by dots, got ${parts}`));
		}
		// The parts are counted, never split into an array (regression: a token of a hundred million dots ran the process out of memory).
		const split = jest.spyOn(String.prototype, 'split');
		try {
			expect(function () {
				helpers.decodeJwt('.'.repeat(100_000));
			}).toThrow(new SyntaxError('decodeJwt: `token` must have 3 parts separated by dots, got 100001'));
			expect(split).not.toHaveBeenCalled();
		} finally {
			split.mockRestore();
		}
		const valid = JWT_IO.split('.');
		for (const [index, name] of [
			[0, 'header'],
			[1, 'payload'],
			[2, 'signature']
		] as const) {
			for (const corrupt of [valid[index] + '=', valid[index].replace(/^./, '+'), valid[index] + '*']) {
				const parts = [...valid];
				parts[index] = corrupt;
				let error: unknown;
				try {
					helpers.decodeJwt(parts.join('.'));
				} catch (caught) {
					error = caught;
				}
				expect(error).toEqual(new SyntaxError(`decodeJwt: the ${name} of \`token\` must be base64url text without padding`));
				expect((error as Error).cause).toBeInstanceOf(SyntaxError);
			}
		}
	});

	it('should reject a header or payload that is not a UTF-8 JSON object', function () {
		const header = Buffer.from('{}').toString('base64url');
		let error: unknown;
		try {
			helpers.decodeJwt(`${header}.${Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url')}.`);
		} catch (caught) {
			error = caught;
		}
		expect(error).toEqual(new SyntaxError('decodeJwt: the payload of `token` must be UTF-8 JSON'));
		expect((error as Error).cause).toBeInstanceOf(TypeError);
		for (const input of [token('{"alg":', '{}'), '.e30.']) {
			expect(function () {
				helpers.decodeJwt(input);
			}).toThrow(expect.objectContaining({ name: 'SyntaxError', message: 'decodeJwt: the header of `token` must be UTF-8 JSON' }));
		}
		for (const [json, got] of [
			['[1]', 'array'],
			['null', 'null'],
			['"x"', 'string'],
			['1', 'number']
		] as const) {
			expect(function () {
				helpers.decodeJwt(token('{}', json));
			}).toThrow(new SyntaxError(`decodeJwt: the payload of \`token\` must be a JSON object, got ${got}`));
		}
		expect(function () {
			helpers.decodeJwt(123 as never);
		}).toThrow(new TypeError('decodeJwt: `token` must be a string, got number'));
	});

	describe('getJwtExpiration / isJwtExpired', function () {
		const EXPIRING = token('{"alg":"none"}', '{"exp":1700000000}');
		const ETERNAL = token('{"alg":"none"}', '{"sub":"a"}');

		it('should read the exp claim', function () {
			expect(helpers.getJwtExpiration(EXPIRING)).toEqual(new Date(1_700_000_000_000));
			expect(helpers.getJwtExpiration(token('{}', '{"exp":1.5}'))).toEqual(new Date(1500));
			expect(helpers.getJwtExpiration(ETERNAL)).toBeUndefined();
		});

		it('should ignore an exp claim inherited from a polluted Object.prototype (regression)', function () {
			Object.defineProperty(Object.prototype, 'exp', { value: 1, configurable: true, writable: true });
			try {
				expect(helpers.getJwtExpiration(ETERNAL)).toBeUndefined();
				expect(helpers.isJwtExpired(ETERNAL, { now: 1_700_000_000_000 })).toBe(false);
				expect(helpers.getJwtExpiration(EXPIRING)).toEqual(new Date(1_700_000_000_000));
			} finally {
				delete (Object.prototype as Record<string, unknown>).exp;
			}
		});

		it('should reject an exp claim that is not a time', function () {
			for (const [exp, got] of [
				['"1700000000"', 'string'],
				['null', 'null'],
				['1e300', '1e+300'],
				['{}', 'object']
			] as const) {
				expect(function () {
					helpers.getJwtExpiration(token('{}', `{"exp":${exp}}`));
				}).toThrow(new SyntaxError(`getJwtExpiration: the \`exp\` claim of \`token\` must be a time in seconds since the epoch, got ${got}`));
			}
			expect(function () {
				helpers.isJwtExpired(token('{}', '{"exp":"soon"}'));
			}).toThrow(new SyntaxError('isJwtExpired: the `exp` claim of `token` must be a time in seconds since the epoch, got string'));
			expect(function () {
				helpers.getJwtExpiration('x');
			}).toThrow(new SyntaxError('getJwtExpiration: `token` must have 3 parts separated by dots, got 1'));
		});

		it('should be expired from the exp time on, with the leeway', function () {
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_699_999_999_999 })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_700_000_000_000 })).toBe(true);
			expect(helpers.isJwtExpired(EXPIRING, { now: new Date(1_700_000_000_000) })).toBe(true);
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_700_000_029_999, leeway: 30 })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_700_000_030_000, leeway: 30 })).toBe(true);
			expect(helpers.isJwtExpired(ETERNAL, { now: Number.MAX_SAFE_INTEGER })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_700_000_000_000, leeway: 0.0005 })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: 1_700_000_000_001, leeway: 0.0005 })).toBe(true);
		});

		it('should compare a huge leeway without overflowing', function () {
			// `leeway * 1000` would overflow past 1.8e305 seconds; the comparison is made in seconds instead.
			const OLDEST = token('{}', '{"exp":-8640000000000}');
			expect(helpers.isJwtExpired(EXPIRING, { now: Number.MAX_VALUE, leeway: 1e305 })).toBe(true);
			expect(helpers.isJwtExpired(EXPIRING, { now: Number.MAX_VALUE, leeway: 1.797e305 })).toBe(true);
			expect(helpers.isJwtExpired(EXPIRING, { now: Number.MAX_VALUE, leeway: 1.798e305 })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: Number.MAX_VALUE, leeway: 1e306 })).toBe(false);
			expect(helpers.isJwtExpired(EXPIRING, { now: Number.MAX_VALUE, leeway: Number.MAX_VALUE })).toBe(false);
			expect(helpers.isJwtExpired(OLDEST, { now: Number.MAX_VALUE, leeway: 1.797e305 })).toBe(true);
			expect(helpers.isJwtExpired(OLDEST, { now: -Number.MAX_VALUE })).toBe(false);
		});

		it('should default to the current time', function () {
			const now = jest.spyOn(Date, 'now');
			now.mockReturnValue(1_700_000_000_000);
			expect(helpers.isJwtExpired(EXPIRING)).toBe(true);
			expect(helpers.isJwtExpired(EXPIRING, {})).toBe(true);
			now.mockReturnValue(1_699_999_999_000);
			expect(helpers.isJwtExpired(EXPIRING)).toBe(false);
		});

		it('should validate its options', function () {
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { now: '2024' as never });
			}).toThrow(new TypeError('isJwtExpired: `now` must be a valid Date or a finite number of milliseconds, got string'));
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { now: new Date(NaN) });
			}).toThrow(new RangeError('isJwtExpired: `now` must be a valid Date or a finite number of milliseconds, got NaN'));
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { now: Infinity });
			}).toThrow(RangeError);
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { leeway: -1 });
			}).toThrow(new RangeError('isJwtExpired: `leeway` must be a finite number of seconds >= 0, got -1'));
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { leeway: Infinity });
			}).toThrow(RangeError);
			expect(function () {
				helpers.isJwtExpired(EXPIRING, { leeway: '5' as never });
			}).toThrow(new TypeError('isJwtExpired: `leeway` must be a finite number of seconds >= 0, got string'));
			expect(function () {
				helpers.isJwtExpired(EXPIRING, 0 as never);
			}).toThrow(new TypeError('isJwtExpired: `options` must be an object, got number'));
			expect(function () {
				helpers.isJwtExpired(null as never, { now: 0 });
			}).toThrow(new TypeError('isJwtExpired: `token` must be a string, got null'));
		});
	});
});

describe('parseCsv', function () {
	it('should parse fields, rows and every kind of line break', function () {
		expect(helpers.parseCsv('a,b\r\nc,d\ne,f\rg,h')).toEqual([
			['a', 'b'],
			['c', 'd'],
			['e', 'f'],
			['g', 'h']
		]);
		expect(helpers.parseCsv('a,b\n')).toEqual([['a', 'b']]);
		expect(helpers.parseCsv('a,b\r\n')).toEqual([['a', 'b']]);
		expect(helpers.parseCsv('a,b\r')).toEqual([['a', 'b']]);
		expect(helpers.parseCsv('')).toEqual([]);
		expect(helpers.parseCsv('﻿')).toEqual([]);
		expect(helpers.parseCsv('﻿a')).toEqual([['a']]);
		expect(helpers.parseCsv('a﻿')).toEqual([['a﻿']]);
		expect(helpers.parseCsv('\n')).toEqual([['']]);
		expect(helpers.parseCsv('a\n\nb\n\n')).toEqual([['a'], [''], ['b'], ['']]);
	});

	it('should read empty fields, including at the ends of a row', function () {
		expect(helpers.parseCsv(',')).toEqual([['', '']]);
		expect(helpers.parseCsv('a,\n,b\n,')).toEqual([
			['a', ''],
			['', 'b'],
			['', '']
		]);
		expect(helpers.parseCsv('a,,b')).toEqual([['a', '', 'b']]);
	});

	it('should read quoted fields', function () {
		expect(helpers.parseCsv('"a,b","c""d",""\n"x\r\ny\rz",""""')).toEqual([
			['a,b', 'c"d', ''],
			['x\r\ny\rz', '"']
		]);
		expect(helpers.parseCsv('""')).toEqual([['']]);
		expect(helpers.parseCsv('"a"\r\n"b"')).toEqual([['a'], ['b']]);
		expect(helpers.parseCsv('"a",')).toEqual([['a', '']]);
		// A quote inside an unquoted field is literal, and spaces before a quote make the field unquoted.
		expect(helpers.parseCsv('a"b, "c" ,d""')).toEqual([['a"b', ' "c" ', 'd""']]);
	});

	it('should report malformed quotes with their position', function () {
		expect(function () {
			helpers.parseCsv('"ab"c');
		}).toThrow(new SyntaxError('parseCsv: `text` must have a delimiter or a line break after a closing quote, got "c" at line 1, column 5'));
		expect(function () {
			helpers.parseCsv('a\r\n"b\r\nc"\r\n"d" ');
		}).toThrow(new SyntaxError('parseCsv: `text` must have a delimiter or a line break after a closing quote, got " " at line 4, column 4'));
		expect(function () {
			helpers.parseCsv('﻿a\rb,"c');
		}).toThrow(new SyntaxError('parseCsv: `text` must close every quoted field, got one opened at line 2, column 3'));
		expect(function () {
			helpers.parseCsv('﻿"c""');
		}).toThrow(new SyntaxError('parseCsv: `text` must close every quoted field, got one opened at line 1, column 1'));
		expect(function () {
			helpers.parseCsv('"a"😀');
		}).toThrow(new SyntaxError('parseCsv: `text` must have a delimiter or a line break after a closing quote, got "😀" at line 1, column 4'));
	});

	it('should use a custom delimiter', function () {
		expect(helpers.parseCsv('a;b,c;"d;e"', { delimiter: ';' })).toEqual([['a', 'b,c', 'd;e']]);
		expect(helpers.parseCsv('a\tb\n1\t2', { delimiter: '\t' })).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});

	it('should keep ragged rows, or reject them with strict', function () {
		expect(helpers.parseCsv('a,b\nc\nd,e,f')).toEqual([['a', 'b'], ['c'], ['d', 'e', 'f']]);
		expect(function () {
			helpers.parseCsv('a,b\nc,d\n"e\nf"', { strict: true });
		}).toThrow(new SyntaxError('parseCsv: `text` must have 2 fields in every row, like the first one, got 1 in row 3 (line 3, column 1)'));
		expect(function () {
			helpers.parseCsv('a\n"b\n",c', { strict: true });
		}).toThrow(new SyntaxError('parseCsv: `text` must have 1 fields in every row, like the first one, got 2 in row 2 (line 2, column 1)'));
		expect(helpers.parseCsv('a,b\nc,d\n', { strict: true })).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(function () {
			helpers.parseCsv('a,b\n\nc,d', { strict: true });
		}).toThrow(SyntaxError);
		expect(helpers.parseCsv('a,b\n\nc,d\r\n\r\n', { strict: true, skipEmptyLines: true })).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
	});

	it('should skip empty lines with skipEmptyLines, but not a line holding ""', function () {
		expect(helpers.parseCsv('\n\na\r\n\r\n""\r\rb\n', { skipEmptyLines: true })).toEqual([['a'], [''], ['b']]);
		expect(helpers.parseCsv('\n', { skipEmptyLines: true })).toEqual([]);
		expect(helpers.parseCsv('a,\n,', { skipEmptyLines: true })).toEqual([
			['a', ''],
			['', '']
		]);
	});

	it('should read records with header, with a null prototype', function () {
		const records = helpers.parseCsv<'name' | 'age'>('name,age\nAda,36\r\nAlan,41\n', { header: true });
		expect(records).toEqual([
			{ name: 'Ada', age: '36' },
			{ name: 'Alan', age: '41' }
		]);
		const age: string | undefined = records[0].age;
		expect(age).toBe('36');
		// With strict, every record has every column.
		const complete = helpers.parseCsv<'name' | 'age'>('name,age\nAda,36', { header: true, strict: true });
		const strictAge: string = complete[0].age;
		expect(strictAge).toBe('36');
		expect(Object.getPrototypeOf(records[0])).toBeNull();
		const hostile = helpers.parseCsv('__proto__,constructor,\n{},x,y', { header: true });
		expect(Object.keys(hostile[0])).toEqual(['__proto__', 'constructor', '']);
		expect(hostile[0]['__proto__']).toBe('{}');
		expect(hostile[0]['']).toBe('y');
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});

	it('should leave missing fields absent and drop extra ones with header, unless strict', function () {
		const records = helpers.parseCsv('a,b,c\n1\n1,2,3,4\n\n,', { header: true });
		expect(records).toEqual([{ a: '1' }, { a: '1', b: '2', c: '3' }, { a: '' }, { a: '', b: '' }]);
		expect(Object.keys(records[0])).toEqual(['a']);
		expect('b' in records[0]).toBe(false);
		expect(function () {
			helpers.parseCsv('a,b,c\n1', { header: true, strict: true });
		}).toThrow(SyntaxError);
		expect(helpers.parseCsv('a,b', { header: true })).toEqual([]);
		expect(helpers.parseCsv('', { header: true })).toEqual([]);
	});

	it('should reject a header that repeats a column name', function () {
		expect(function () {
			helpers.parseCsv('id,name,id\n1,2,3', { header: true });
		}).toThrow(new SyntaxError('parseCsv: the header of `text` must not repeat a column name, got "id" again in column 3'));
		expect(function () {
			helpers.parseCsv(',\n1,2', { header: true });
		}).toThrow(new SyntaxError('parseCsv: the header of `text` must not repeat a column name, got "" again in column 2'));
		expect(helpers.parseCsv('id,name,id\n1,2,3')).toEqual([
			['id', 'name', 'id'],
			['1', '2', '3']
		]);
	});

	it('should validate its arguments and options', function () {
		expect(function () {
			helpers.parseCsv(null as never);
		}).toThrow(new TypeError('parseCsv: `text` must be a string, got null'));
		expect(function () {
			helpers.parseCsv('', 'header' as never);
		}).toThrow(new TypeError('parseCsv: `options` must be an object, got string'));
		for (const delimiter of ['', ';;', '"', '\n', '\r']) {
			expect(function () {
				helpers.parseCsv('', { delimiter });
			}).toThrow(new RangeError(`parseCsv: \`delimiter\` must be a single character other than '"', '\\r' and '\\n', got ${JSON.stringify(delimiter)}`));
		}
		expect(function () {
			helpers.parseCsv('', { delimiter: 44 as never });
		}).toThrow(new TypeError('parseCsv: `delimiter` must be a string, got number'));
		for (const key of ['header', 'strict', 'skipEmptyLines'] as const) {
			expect(function () {
				helpers.parseCsv('', { [key]: 1 } as never);
			}).toThrow(new TypeError(`parseCsv: \`${key}\` must be a boolean, got number`));
		}
	});

	it('should run in linear time on hostile input', function () {
		const quotes = '"'.repeat(200_001);
		expect(function () {
			helpers.parseCsv(quotes);
		}).toThrow(SyntaxError);
		expect(helpers.parseCsv('"' + '""'.repeat(100_000) + '"')[0][0].length).toBe(100_000);
		expect(helpers.parseCsv(',\n'.repeat(100_000)).length).toBe(100_000);
	});

	it('should take memory in proportion to the text with header, whatever the number of columns', function () {
		// Regression: every record used to get every column, so this 41 KB text made 36 million keys (2.4 GB), and with 20,000 columns,
		// 149 KB ran Node out of memory.
		const start = performance.now();
		const records = helpers.parseCsv(
			Array.from({ length: 6000 }, function (_, index) {
				return `c${index}`;
			}).join(',') + '\n'.repeat(6000),
			{ header: true }
		);
		expect(records).toHaveLength(5999);
		let keys = 0;
		for (const record of records) keys += Object.keys(record).length;
		// Each empty line is a row of one empty field.
		expect(keys).toBe(5999);
		expect(records[5998]).toEqual({ c0: '' });
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it('should return a separate array of the exact size for every row', function () {
		const rows = helpers.parseCsv('a,b,c\nd\ne,f');
		expect(rows).toEqual([['a', 'b', 'c'], ['d'], ['e', 'f']]);
		rows[0].push('x');
		expect(rows[1]).toEqual(['d']);
		expect(new Set(rows).size).toBe(3);
	});
});

describe('toCsv', function () {
	it('should write rows of cells, quoting only when needed', function () {
		expect(helpers.toCsv([['a', 'b,c', 'd"e', 'f\ng', 'h\ri', ' j ']])).toBe('a,"b,c","d""e","f\ng","h\ri", j ');
		expect(helpers.toCsv([[1, -2.5, 3n, true, false, null, undefined, NaN]])).toBe('1,-2.5,3,true,false,,,NaN');
		expect(
			helpers.toCsv([
				['a', 'b'],
				['c', 'd']
			])
		).toBe('a,b\r\nc,d');
		expect(helpers.toCsv([])).toBe('');
	});

	it('should keep rows that would otherwise read back differently', function () {
		expect(helpers.toCsv([[''], [null], ['', ''], []])).toBe('""\r\n""\r\n,\r\n""');
		expect(helpers.toCsv([['﻿a', 'b﻿']])).toBe('"﻿a",b﻿');
	});

	it('should honour the delimiter, newline and quote options', function () {
		expect(helpers.toCsv([['a;b', 'c,d']], { delimiter: ';' })).toBe('"a;b";c,d');
		expect(helpers.toCsv([['a\tb', 'c']], { delimiter: '\t' })).toBe('"a\tb"\tc');
		expect(helpers.toCsv([['a'], ['b']], { newline: '\n' })).toBe('a\nb');
		expect(helpers.toCsv([['a', 1, null, 'x"y']], { quote: 'all' })).toBe('"a","1","","x""y"');
	});

	it('should write records, with a header row from the keys first seen or from columns', function () {
		const people = [{ name: 'Ada', age: 36 }, { name: 'Alan', city: 'Wilmslow' }, {}];
		expect(helpers.toCsv(people)).toBe('name,age,city\r\nAda,36,\r\nAlan,,Wilmslow\r\n,,');
		expect(helpers.toCsv(people, { columns: ['city', 'name'], newline: '\n' })).toBe('city,name\n,Ada\nWilmslow,Alan\n,');
		expect(helpers.toCsv(people, { header: false, columns: ['name'] })).toBe('Ada\r\nAlan\r\n""');
		expect(helpers.toCsv([] as { a: string }[], { columns: ['a'] })).toBe('a');
		expect(helpers.toCsv([[1, 2]], { columns: ['x', 'y'] })).toBe('x,y\r\n1,2');
		expect(helpers.toCsv([[1, 2]], { columns: ['x', 'y'], header: false })).toBe('1,2');
		expect(helpers.toCsv([{ 'a,b': 1 }])).toBe('"a,b"\r\n1');
	});

	it('should read own properties of records only', function () {
		const inherited = Object.create({ a: 'inherited' }) as Record<string, string>;
		inherited.b = 'own';
		expect(helpers.toCsv([inherited], { columns: ['a', 'b'] })).toBe('a,b\r\n,own');
		const hostile = Object.create(null) as Record<string, string>;
		hostile['__proto__'] = 'p';
		expect(helpers.toCsv([hostile, { constructor: 'c' }])).toBe('__proto__,constructor\r\np,\r\n,c');
		expect(helpers.parseCsv(helpers.toCsv([hostile]), { header: true })).toEqual([hostile]);
	});

	it('should prefix formula-like strings and quote every field with formulaEscape', function () {
		const cells = ['=1+2', '+1', '-1', '@SUM(A1)', '\tx', '\rx', 'a=b', ' =x', '', "'=x"];
		expect(helpers.toCsv([cells], { formulaEscape: true })).toBe(`"'=1+2","'+1","'-1","'@SUM(A1)","'\tx","'\rx","a=b","' =x","","'=x"`);
		expect(helpers.toCsv([[-1, -1n, '-1', true, null]], { formulaEscape: true })).toBe(`"-1","-1","'-1","true",""`);
		expect(helpers.toCsv([{ '=a': '=b' }], { formulaEscape: true })).toBe(`"'=a"\r\n"'=b"`);
		expect(helpers.toCsv([[''], []], { formulaEscape: true })).toBe('""\r\n""');
		expect(helpers.toCsv([cells])).toBe('=1+2,+1,-1,@SUM(A1),\tx,"\rx",a=b, =x,,\'=x');
	});

	it('should not let a cell be split off where a spreadsheet uses another separator, with formulaEscape', function () {
		// Regression: only the first character was checked, and the field was quoted only for the configured delimiter, so Excel in a
		// locale whose separator is `;` read `safe;=1+2,b` as a cell `safe` and a formula `=1+2,b`.
		expect(helpers.toCsv([['safe;=1+2', 'b']], { formulaEscape: true })).toBe('"safe;=1+2","b"');
		expect(helpers.toCsv([['safe\t=1+2', 'b|@x']], { formulaEscape: true, delimiter: ';' })).toBe('"safe\t=1+2";"b|@x"');
	});

	it('should look past leading white space and read full-width signs, with formulaEscape', function () {
		const [NBSP, IDEOGRAPHIC_SPACE, BOM, LINE_SEPARATOR] = [0xa0, 0x3000, 0xfeff, 0x2028].map(function (code) {
			return String.fromCharCode(code);
		});
		const dangerous = [
			' =1',
			'  +1',
			`${NBSP}-1`,
			`${IDEOGRAPHIC_SPACE}@x`,
			`${BOM}=1`,
			'\n=1',
			' \t\r\n=1',
			`${LINE_SEPARATOR}=1`,
			'＝1+2',
			'＋1',
			'－1',
			'＠x',
			` ${NBSP}＝1`,
			'\t',
			'\r'
		];
		const safe = ['a =1', `${NBSP}x`, ' ', '\n', '1-2', 'x@y', "'=1"];
		expect(helpers.parseCsv(helpers.toCsv([dangerous, safe], { formulaEscape: true }))).toEqual([
			dangerous.map(function (cell) {
				return `'${cell}`;
			}),
			safe
		]);
	});

	it('should reject cells it cannot write faithfully', function () {
		for (const [value, got] of [
			[{}, 'object'],
			[new Date(0), 'object'],
			[Symbol('s'), 'symbol'],
			[function () {}, 'function']
		] as const) {
			expect(function () {
				helpers.toCsv([['ok', value as never]]);
			}).toThrow(new TypeError(`toCsv: \`rows[0][1]\` must be a string, number, bigint, boolean, null or undefined, got ${got}`));
		}
		expect(function () {
			helpers.toCsv([{ a: 1 }, { 'b"': [] as never }]);
		}).toThrow(new TypeError('toCsv: `rows[1]["b\\""]` must be a string, number, bigint, boolean, null or undefined, got object'));
	});

	it('should write a hole as an empty field, never a value of a polluted Array.prototype (regression)', function () {
		// oxlint-disable-next-line no-sparse-arrays
		expect(helpers.toCsv([['a', , 'b'], [,], ['c']])).toBe('a,,b\r\n""\r\nc');
		expect(helpers.toCsv([new Array(1)])).toBe('""');
		expect(helpers.parseCsv(helpers.toCsv([new Array(1), ['c']]), { skipEmptyLines: true })).toEqual([[''], ['c']]);
		Object.defineProperty(Array.prototype, 1, { value: '=HYPERLINK("x")', configurable: true, writable: true });
		try {
			// oxlint-disable-next-line no-sparse-arrays
			expect(helpers.toCsv([['a', , 'b']])).toBe('a,,b');
		} finally {
			delete (Array.prototype as unknown as Record<number, unknown>)[1];
		}
	});

	it('should write the holes of a huge sparse row by runs, failing fast when the text cannot exist (regression)', function () {
		// Regression: every index was written as a field, so a row of length 2 ** 32 - 1 with one cell ran the process out of memory.
		const huge = new Array(2 ** 32 - 1) as unknown[];
		huge[0] = 'a';
		huge[2 ** 31] = 'b';
		let reads = 0;
		const counted = new Proxy(huge, {
			getOwnPropertyDescriptor(target, key) {
				reads++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			}
		});
		expect(function () {
			helpers.toCsv([counted] as never);
		}).toThrow(RangeError);
		expect(reads).toBeLessThan(70_000);
		// The same text as the dense row, with the cells of the sparse part checked in order.
		const sparse = new Array(70_000) as unknown[];
		for (const [index, value] of [
			[0, 'a'],
			[65_535, 1],
			[65_537, 'x,y'],
			[69_998, null]
		] as const) {
			sparse[index] = value;
		}
		const dense = Array.from(sparse, function (value) {
			return value;
		});
		expect(helpers.toCsv([sparse as never[], ['z']], { delimiter: ';' })).toBe(helpers.toCsv([dense as never[], ['z']], { delimiter: ';' }));
		expect(helpers.toCsv([sparse as never[]])).toMatch(/^a,{65535}1,,"x,y",{4462}$/);
		sparse[69_999] = {};
		expect(function () {
			helpers.toCsv([sparse as never[]]);
		}).toThrow(new TypeError('toCsv: `rows[0][69999]` must be a string, number, bigint, boolean, null or undefined, got object'));
	});

	it('should write the holes of a long sparse row as the dense row would be written, whatever its keys and quoting (regression)', function () {
		// A row with more holes than are read one by one, so that its own keys are listed.
		const sparse = new Array(140_000) as unknown[];
		for (const [index, value] of [
			[0, 'a'],
			[70_000, 'b'],
			[100_000, '=c'],
			[130_000, 'd']
		] as const) {
			sparse[index] = value;
		}
		const dense = Array.from(sparse, function (value) {
			return value;
		});
		// Regression: with every field quoted, the holes past the first 65,536 columns were written as unquoted empty fields.
		for (const options of [{ quote: 'all' }, { formulaEscape: true }] as const) {
			const written = helpers.toCsv([sparse as never[]], options);
			expect(written).toBe(helpers.toCsv([dense as never[]], options));
			expect(written).toMatch(/^"a"(,""){69999},"b"(,""){29999},"'?=c"(,""){29999},"d"(,""){9999}$/);
		}
		// Regression: the keys of a Proxy were taken in the order it lists them, so that a cell listed after a later one was dropped, and a
		// key past the length threw a RangeError (a negative count of holes left to write).
		const lying = new Proxy(sparse, {
			ownKeys() {
				return ['130000', '100000', '1.5', '200000', '70000', '0', 'length'];
			}
		});
		expect(helpers.toCsv([lying as never[]])).toBe(helpers.toCsv([dense as never[]]));
		// A cell deleted by the getter of an earlier one is a hole, never read from a polluted `Array.prototype`.
		const deleting = sparse.slice();
		Object.defineProperty(deleting, 70_000, {
			get() {
				delete deleting[100_000];
				return 'b';
			},
			enumerable: true,
			configurable: true
		});
		Object.defineProperty(Array.prototype, 100_000, { value: 'planted', configurable: true, writable: true });
		try {
			dense[100_000] = undefined;
			expect(helpers.toCsv([deleting as never[]])).toBe(helpers.toCsv([dense as never[]]));
		} finally {
			delete (Array.prototype as unknown[])[100_000];
		}
	});

	it('should read a long row with few holes cell by cell, without listing its keys (regression)', function () {
		// Regression: a hole past the first 65,536 columns made the whole row be walked through its keys, which takes several times as long.
		const row = Array.from({ length: 70_000 }, function (_, i) {
			return i;
		});
		delete row[66_000];
		const listed = jest.spyOn(Object, 'getOwnPropertyNames');
		try {
			expect(helpers.toCsv([row])).toBe(
				Array.from(row, function (value) {
					return value === undefined ? '' : String(value);
				}).join(',')
			);
			expect(listed).not.toHaveBeenCalled();
		} finally {
			listed.mockRestore();
		}
	});

	it('should write a last row without cells as one empty field, which a final line break would lose (regression)', function () {
		// Regression: the row was written as an empty line, so the text ended with a line break, which `parseCsv` reads as the end of the
		// previous row: the row was lost.
		expect(helpers.toCsv([['a'], []])).toBe('a\r\n""');
		expect(helpers.parseCsv(helpers.toCsv([['a'], []]))).toEqual([['a'], ['']]);
		expect(helpers.toCsv([[]])).toBe('""');
		expect(helpers.parseCsv(helpers.toCsv([[], []], { newline: '\n' }))).toEqual([[''], ['']]);
		expect(helpers.toCsv([], { columns: [] })).toBe('""');
		// An empty line elsewhere still reads back as one empty field.
		expect(helpers.toCsv([['a'], [], ['b']])).toBe('a\r\n\r\nb');
	});

	it('should reject an invalid record row without first walking the rest of a huge sparse array (regression)', function () {
		// Regression: the column names were collected from every index first, so `[{ a: 1 }, <4294967294 holes>]` ran for about a
		// minute before the TypeError for `rows[1]`.
		const rows = new Array(2 ** 32 - 1) as unknown[];
		rows[0] = { a: 1 };
		let reads = 0;
		const counted = new Proxy(rows, {
			getOwnPropertyDescriptor(target, key) {
				reads++;
				return Reflect.getOwnPropertyDescriptor(target, key);
			}
		});
		expect(function () {
			helpers.toCsv(counted as never);
		}).toThrow(new TypeError('toCsv: `rows[1]` must be a record (a non-array object) like the first row, got undefined'));
		expect(reads).toBeLessThan(10);
		// A record row after an array row: still the error for the array row, with the columns of the rows before it.
		expect(function () {
			helpers.toCsv([{ a: 1 }, ['x'], { b: 2 }] as never);
		}).toThrow(new TypeError('toCsv: `rows[1]` must be a record (a non-array object) like the first row, got array'));
		expect(function () {
			helpers.toCsv([{ a: 1 }, { b: {} }, 5] as never);
		}).toThrow(new TypeError('toCsv: `rows[1]["b"]` must be a string, number, bigint, boolean, null or undefined, got object'));
	});

	it('should read only own rows and column names, never ones planted on a polluted Object.prototype (regression)', function () {
		// oxlint-disable-next-line no-sparse-arrays
		const sparse = [['a'], , ['b']] as string[][];
		// oxlint-disable-next-line no-sparse-arrays
		const columns = ['a', , 'c'] as string[];
		const proto = Object.prototype as Record<number, unknown>;
		proto[0] = { planted: 'yes' };
		proto[1] = ['planted'];
		try {
			expect(function () {
				helpers.toCsv(sparse);
			}).toThrow(new TypeError('toCsv: `rows[1]` must be an array like the first row, got undefined'));
			expect(function () {
				// oxlint-disable-next-line no-sparse-arrays
				helpers.toCsv([, { a: 1 }] as never);
			}).toThrow(new TypeError('toCsv: `rows[0]` must be a record (a non-array object) like the first row, got undefined'));
			expect(function () {
				helpers.toCsv([{ a: 1 }], { columns: columns as never });
			}).toThrow(new TypeError('toCsv: `columns` must be an array of strings, got undefined at index 1'));
		} finally {
			delete proto[0];
			delete proto[1];
		}
	});

	it('should quote an empty first field before a U+FEFF delimiter, which parseCsv would drop as a byte order mark (regression)', function () {
		const delimiter = '﻿';
		expect(
			helpers.toCsv(
				[
					['', 'a'],
					['', 'b']
				],
				{ delimiter }
			)
		).toBe('""﻿a\r\n﻿b');
		expect(
			helpers.parseCsv(
				helpers.toCsv(
					[
						['', 'a'],
						['', 'b']
					],
					{ delimiter }
				),
				{ delimiter }
			)
		).toEqual([
			['', 'a'],
			['', 'b']
		]);
		expect(helpers.parseCsv(helpers.toCsv([{ '': 'x', y: 'z' }], { delimiter }), { delimiter, header: true })).toEqual([{ '': 'x', y: 'z' }]);
		expect(helpers.toCsv([[null, 1]], { delimiter, quote: 'all' })).toBe('""﻿"1"');
		expect(helpers.toCsv([['﻿', 1]], { delimiter })).toBe('"﻿"﻿1');
	});

	it('should reject rows that are not all arrays or all records', function () {
		expect(function () {
			helpers.toCsv([['a'], { a: 1 }] as never);
		}).toThrow(new TypeError('toCsv: `rows[1]` must be an array like the first row, got object'));
		expect(function () {
			helpers.toCsv([{ a: 1 }, ['a']] as never);
		}).toThrow(new TypeError('toCsv: `rows[1]` must be a record (a non-array object) like the first row, got array'));
		expect(function () {
			helpers.toCsv([{ a: 1 }, null] as never);
		}).toThrow(new TypeError('toCsv: `rows[1]` must be a record (a non-array object) like the first row, got null'));
		expect(function () {
			helpers.toCsv(['a,b'] as never);
		}).toThrow(new TypeError('toCsv: `rows[0]` must be a record (a non-array object) like the first row, got string'));
		expect(function () {
			helpers.toCsv('a,b' as never);
		}).toThrow(new TypeError('toCsv: `rows` must be an array, got string'));
	});

	it('should validate its options', function () {
		expect(function () {
			helpers.toCsv([], { newline: '\r' as never });
		}).toThrow(new RangeError(`toCsv: \`newline\` must be '\\r\\n' or '\\n', got "\\r"`));
		expect(function () {
			helpers.toCsv([], { newline: 10 as never });
		}).toThrow(new RangeError(`toCsv: \`newline\` must be '\\r\\n' or '\\n', got 10`));
		expect(function () {
			helpers.toCsv([], { quote: 'always' as never });
		}).toThrow(new RangeError("toCsv: `quote` must be 'needed' or 'all', got always"));
		expect(function () {
			helpers.toCsv([], { columns: 'a' as never });
		}).toThrow(new TypeError('toCsv: `columns` must be an array of strings, got string'));
		expect(function () {
			helpers.toCsv([], { columns: ['a', 1] as never });
		}).toThrow(new TypeError('toCsv: `columns` must be an array of strings, got number at index 1'));
		expect(function () {
			helpers.toCsv([], { header: 1 as never });
		}).toThrow(new TypeError('toCsv: `header` must be a boolean, got number'));
		expect(function () {
			helpers.toCsv([], { formulaEscape: 'yes' as never });
		}).toThrow(new TypeError('toCsv: `formulaEscape` must be a boolean, got string'));
		expect(function () {
			helpers.toCsv([], { delimiter: '"' });
		}).toThrow(RangeError);
		expect(function () {
			helpers.toCsv([], null as never);
		}).toThrow(new TypeError('toCsv: `options` must be an object, got null'));
	});

	it('should ignore options inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.formulaEscape = true;
		proto.delimiter = ';';
		proto.header = true;
		try {
			expect(helpers.toCsv([['=a', 'b']], {})).toBe('=a,b');
			expect(helpers.parseCsv('a,b', {})).toEqual([['a', 'b']]);
		} finally {
			delete proto.formulaEscape;
			delete proto.delimiter;
			delete proto.header;
		}
	});
});

describe('hmacSha256 / hmacSha256Hex', function () {
	/** The reference: Node's HMAC. */
	function nodeHmac(key: string | Uint8Array, message: string | Uint8Array): string {
		return createHmac('sha256', key).update(message).digest('hex');
	}

	it('should compute the RFC 4231 test vectors', function () {
		function hex(digits: string): Uint8Array {
			return new Uint8Array(Buffer.from(digits, 'hex'));
		}
		const cases: [Uint8Array | string, Uint8Array | string, string][] = [
			[new Uint8Array(20).fill(0x0b), 'Hi There', 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
			['Jefe', 'what do ya want for nothing?', '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
			[new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
			[hex('0102030405060708090a0b0c0d0e0f10111213141516171819'), new Uint8Array(50).fill(0xcd), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
			[new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First', '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
			[
				new Uint8Array(131).fill(0xaa),
				'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
				'9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'
			]
		];
		for (const [key, message, expected] of cases) {
			expect(helpers.hmacSha256Hex(key, message)).toBe(expected);
			expect(helpers.hmacSha256(key, message)).toEqual(hex(expected));
		}
		// Test case 5 is truncated to 128 bits.
		expect(helpers.hmacSha256Hex(new Uint8Array(20).fill(0x0c), 'Test With Truncation').slice(0, 32)).toBe('a3b6167473100ee06e0c796c2955552b');
	});

	it('should match node:crypto around the key-block and message-padding boundaries', function () {
		for (const keyLength of [0, 1, 31, 32, 63, 64, 65, 128, 129, 200]) {
			const key = new Uint8Array(keyLength);
			for (let i = 0; i < keyLength; i++) key[i] = (i * 37 + keyLength) % 256;
			for (let length = 0; length <= 140; length++) {
				const message = new Uint8Array(length);
				for (let i = 0; i < length; i++) message[i] = (i * 151 + length) % 256;
				expect(helpers.hmacSha256Hex(key, message)).toBe(nodeHmac(key, message));
			}
		}
	});

	it('should write message lengths past 2 MiB into the padding (all four low bytes of the bit count)', function () {
		const message = new Uint8Array(3 * 1024 * 1024 + 5).fill(0x61);
		expect(helpers.hmacSha256Hex('k', message)).toBe(nodeHmac('k', message));
		expect(helpers.sha256Hex(message)).toBe(createHash('sha256').update(message).digest('hex'));
	});

	it('should hash a key longer than a block first, and zero-pad a shorter one', function () {
		const long = new Uint8Array(65).fill(7);
		expect(helpers.hmacSha256Hex(long, 'm')).toBe(helpers.hmacSha256Hex(helpers.sha256(long), 'm'));
		expect(helpers.hmacSha256Hex(new Uint8Array(64).fill(7), 'm')).not.toBe(helpers.hmacSha256Hex(helpers.sha256(new Uint8Array(64).fill(7)), 'm'));
		expect(helpers.hmacSha256Hex('k', 'm')).toBe(helpers.hmacSha256Hex(new Uint8Array([107, 0, 0]), 'm'));
	});

	it('should take strings as UTF-8 (lone surrogates as U+FFFD) and any binary data', function () {
		for (const value of ['é', '😀', '\uD800', 'key with spaces']) {
			expect(helpers.hmacSha256Hex(value, value)).toBe(createHmac('sha256', Buffer.from(value, 'utf8')).update(value, 'utf8').digest('hex'));
		}
		const buffer = new Uint8Array([1, 2, 3, 4, 5]).buffer;
		expect(helpers.hmacSha256Hex(new DataView(buffer, 1, 3), new Uint16Array(buffer, 0, 2))).toBe(nodeHmac(new Uint8Array([2, 3, 4]), new Uint8Array([1, 2, 3, 4])));
		expect(helpers.hmacSha256Hex(buffer, new Uint8Array(new SharedArrayBuffer(3)))).toBe(nodeHmac(new Uint8Array(buffer), new Uint8Array(3)));
	});

	it('should return 32 fresh bytes over their own buffer and leave the inputs alone', function () {
		const key = new Uint8Array(80).fill(1);
		const message = new Uint8Array(100).fill(2);
		const mac = helpers.hmacSha256(key, message);
		expect(mac.length).toBe(32);
		expect(mac.byteLength).toBe(mac.buffer.byteLength);
		expect(key).toEqual(new Uint8Array(80).fill(1));
		expect(message).toEqual(new Uint8Array(100).fill(2));
		mac[0] ^= 1;
		expect(helpers.hmacSha256(key, message)[0]).toBe(mac[0] ^ 1);
	});

	it('should reject anything but strings and binary data, naming the parameter', function () {
		expect(function () {
			helpers.hmacSha256(1 as never, 'm');
		}).toThrow(new TypeError('hmacSha256: `key` must be a string, an ArrayBuffer or an ArrayBuffer view, got number'));
		expect(function () {
			helpers.hmacSha256Hex('k', null as never);
		}).toThrow(new TypeError('hmacSha256: `message` must be a string, an ArrayBuffer or an ArrayBuffer view, got null'));
	});
});

describe('crc32', function () {
	it('should compute the standard check value and known checksums', function () {
		expect(helpers.crc32('123456789')).toBe(0xcbf43926);
		expect(helpers.crc32('')).toBe(0);
		expect(helpers.crc32(new Uint8Array([0]))).toBe(0xd202ef8d);
		expect(helpers.crc32(new Uint8Array(32).fill(0xff))).toBe(0xff6cab0b);
		expect(helpers.crc32('The quick brown fox jumps over the lazy dog')).toBe(0x414fa339);
	});

	it('should match node:zlib for every tail length and many initial values', function () {
		for (let length = 0; length <= 70; length++) {
			const data = new Uint8Array(length);
			for (let i = 0; i < length; i++) data[i] = (i * 151 + length) % 256;
			for (const initial of [0, 1, 0x7fffffff, 0x80000000, 0xcbf43926, 0xffffffff]) {
				expect(helpers.crc32(data, initial)).toBe(crc32(data, initial));
			}
		}
	});

	it('should continue a checksum, chunk by chunk', function () {
		const sentence = 'The quick brown fox jumps over the lazy dog';
		for (let cut = 0; cut <= sentence.length; cut++) {
			expect(helpers.crc32(sentence.slice(cut), helpers.crc32(sentence.slice(0, cut)))).toBe(helpers.crc32(sentence));
		}
		expect(helpers.crc32('', 0xdeadbeef)).toBe(0xdeadbeef);
	});

	it('should take strings as UTF-8 and any binary data', function () {
		expect(helpers.crc32('é😀\uD800')).toBe(crc32(Buffer.from('é😀\uD800', 'utf8')));
		const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer;
		expect(helpers.crc32(new DataView(buffer, 1, 9))).toBe(crc32(new Uint8Array(buffer, 1, 9)));
		expect(helpers.crc32(new Uint32Array(buffer, 4, 1))).toBe(crc32(new Uint8Array([5, 6, 7, 8])));
		expect(helpers.crc32(buffer)).toBe(crc32(new Uint8Array(buffer)));
	});

	it('should reject an invalid initial value or data', function () {
		for (const initial of [-1, 2 ** 32, 1.5, NaN, Infinity]) {
			expect(function () {
				helpers.crc32('x', initial);
			}).toThrow(new RangeError(`crc32: \`initial\` must be an integer between 0 and 4294967295, got ${initial}`));
		}
		expect(function () {
			helpers.crc32('x', '1' as never);
		}).toThrow(new TypeError('crc32: `initial` must be an integer between 0 and 4294967295, got string'));
		expect(function () {
			helpers.crc32([1, 2] as never);
		}).toThrow(new TypeError('crc32: `data` must be a string, an ArrayBuffer or an ArrayBuffer view, got object'));
		expect(helpers.crc32('x', undefined)).toBe(helpers.crc32('x'));
	});
});

describe('signJwt / verifyJwt', function () {
	const SECRET = 'a-string-secret-at-least-256-bits-long';
	const NOW = 1_700_000_000_000;

	/** Builds a token from JSON texts, signed with the HMAC of node:crypto (or with the given signature). */
	function token(header: string, payload: string, secret: string | Uint8Array = SECRET, signature?: string): string {
		const input = `${Buffer.from(header).toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
		return `${input}.${signature ?? createHmac('sha256', secret).update(input).digest('base64url')}`;
	}

	/** The error `fn` throws. */
	function thrown(fn: () => unknown): Error {
		try {
			fn();
		} catch (error) {
			return error as Error;
		}
		throw new Error('did not throw');
	}

	/** Expects `verifyJwt(input, secret, options)` to throw a JwtVerificationError with this code and message. */
	function rejects(input: string, code: helpers.JwtVerificationErrorCode, message: string, options?: helpers.VerifyJwtOptions, secret: string = SECRET): void {
		const error = thrown(function () {
			helpers.verifyJwt(input, secret, options);
		});
		expect(error).toBeInstanceOf(helpers.JwtVerificationError);
		expect(error).toEqual(expect.objectContaining({ name: 'JwtVerificationError', code, message: `verifyJwt: ${message}` }));
	}

	const HS256 = '{"alg":"HS256","typ":"JWT"}';

	/** Runs `fn` with `values` defined on `Object.prototype` (as a prototype-pollution attack would), removing them afterwards. */
	function polluted(values: Record<string, unknown>, fn: () => void): void {
		for (const [key, value] of Object.entries(values)) Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
		try {
			fn();
		} finally {
			for (const key of Object.keys(values)) delete (Object.prototype as Record<string, unknown>)[key];
		}
	}

	describe('signJwt', function () {
		it('should sign the jwt.io example exactly', function () {
			expect(helpers.signJwt({ sub: '1234567890', name: 'John Doe', iat: 1516239022 }, 'your-256-bit-secret')).toBe(
				'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
			);
		});

		it('should write the header and claims as JSON, signed with the HMAC of node:crypto', function () {
			const signed = helpers.signJwt({ sub: 'ada', name: 'Zoë 😀', nested: { a: [1, null] }, skip: undefined }, SECRET, { now: NOW, expiresIn: 60, notBefore: -5 });
			expect(signed).toBe(token(HS256, '{"sub":"ada","name":"Zoë 😀","nested":{"a":[1,null]},"iat":1700000000,"nbf":1699999995,"exp":1700000060}'));
		});

		it('should add iat from now (a Date, a number, or Date.now()), in whole seconds, unless present or disabled', function () {
			expect(helpers.decodeJwt(helpers.signJwt({}, SECRET, { now: new Date(NOW + 999) })).payload).toEqual({ iat: 1700000000 });
			expect(helpers.decodeJwt(helpers.signJwt({}, SECRET, { now: -1500 })).payload).toEqual({ iat: -2 });
			jest.spyOn(Date, 'now').mockReturnValue(NOW + 1000);
			expect(helpers.decodeJwt(helpers.signJwt({ a: 1 }, SECRET)).payload).toEqual({ a: 1, iat: 1700000001 });
			expect(helpers.decodeJwt(helpers.signJwt({ iat: 5 }, SECRET)).payload).toEqual({ iat: 5 });
			expect(helpers.decodeJwt(helpers.signJwt({ iat: undefined }, SECRET)).payload).toEqual({ iat: 1700000001 });
			expect(helpers.decodeJwt(helpers.signJwt({ a: 1 }, SECRET, { timestamp: false, expiresIn: 1.5 })).payload).toEqual({ a: 1, exp: 1700000002.5 });
			expect(helpers.decodeJwt(helpers.signJwt({ a: 1 }, SECRET, { timestamp: true })).payload).toEqual({ a: 1, iat: 1700000001 });
		});

		it('should refuse expiresIn or notBefore when the payload has that claim', function () {
			expect(function () {
				helpers.signJwt({ exp: 1 }, SECRET, { expiresIn: 60 });
			}).toThrow(new TypeError('signJwt: `expiresIn` must be left out when `payload` has an `exp` claim'));
			expect(function () {
				helpers.signJwt({ nbf: 1 }, SECRET, { notBefore: 0 });
			}).toThrow(new TypeError('signJwt: `notBefore` must be left out when `payload` has an `nbf` claim'));
			expect(helpers.decodeJwt(helpers.signJwt({ exp: 1, nbf: 2 }, SECRET, { now: NOW })).payload).toEqual({ exp: 1, nbf: 2, iat: 1700000000 });
		});

		it('should add extra header parameters after alg and typ, which can be replaced or removed, but never alg', function () {
			expect(helpers.decodeJwt(helpers.signJwt({}, SECRET, { header: { kid: 'k1', typ: 'at+jwt', alg: 'HS256' } })).header).toEqual({
				alg: 'HS256',
				typ: 'at+jwt',
				kid: 'k1'
			});
			const untyped = helpers.signJwt({}, SECRET, { header: { typ: undefined }, timestamp: false });
			expect(untyped).toBe(token('{"alg":"HS256"}', '{}'));
			expect(helpers.signJwt({ 1: 'one', a: 'b' }, SECRET, { header: { 2: 'two' }, timestamp: false })).toBe(
				token('{"2":"two","alg":"HS256","typ":"JWT"}', '{"1":"one","a":"b"}')
			);
			for (const alg of ['none', 'RS256', 'hs256', undefined, 1]) {
				expect(function () {
					helpers.signJwt({}, SECRET, { header: { alg } as never });
				}).toThrow(new RangeError(`signJwt: \`header.alg\` must be 'HS256' (the only algorithm signJwt supports), got ${String(alg)}`));
			}
		});

		it('should refuse a crit header parameter, which verifyJwt would reject', function () {
			for (const crit of [[], ['exp'], 'b64', null]) {
				expect(function () {
					helpers.signJwt({}, SECRET, { header: { crit } });
				}).toThrow(new RangeError('signJwt: `header` must not have a `crit` parameter (no extension is supported)'));
			}
			// An undefined parameter is not written (as with `typ: undefined`), so the token stays verifiable.
			const signed = helpers.signJwt({ sub: 'a' }, SECRET, { header: { crit: undefined } });
			expect(helpers.verifyJwt(signed, SECRET).header).toEqual({ alg: 'HS256', typ: 'JWT' });
		});

		it('should copy only own enumerable properties, ignoring a polluted Object.prototype', function () {
			polluted({ exp: 1, iat: 2, nbf: 3, alg: 'none', typ: 'x', crit: ['exp'], expiresIn: -1000, timestamp: false }, function () {
				const payload = Object.create({ inherited: true }) as Record<string, unknown>;
				payload.own = 1;
				Object.defineProperty(payload, 'hidden', { value: 2, enumerable: false });
				expect(helpers.signJwt(payload, SECRET, { now: NOW })).toBe(token(HS256, '{"own":1,"iat":1700000000}'));
				expect(helpers.signJwt({}, SECRET, { now: NOW, expiresIn: 1, notBefore: 0 })).toBe(token(HS256, '{"iat":1700000000,"nbf":1700000000,"exp":1700000001}'));
			});
			// A polluted toJSON would replace the claims: refused rather than signed.
			polluted({ toJSON: function () {} }, function () {
				expect(function () {
					helpers.signJwt({}, SECRET);
				}).toThrow(new TypeError('signJwt: `header` must not have a toJSON method, which would replace it'));
				// Even for null-prototype arguments: their plain-object copies would inherit it.
				expect(function () {
					helpers.signJwt(Object.create(null) as object, SECRET, { header: Object.create(null) as Record<string, unknown> });
				}).toThrow(new TypeError('signJwt: `header` must not have a toJSON method, which would replace it'));
			});
			// An own __proto__ key is copied as a plain key (which decodeJwt and verifyJwt drop), not as the prototype of the copy.
			const proto = JSON.parse('{"__proto__":{"admin":true},"a":1}') as object;
			expect(helpers.signJwt(proto, SECRET, { timestamp: false })).toBe(token(HS256, '{"__proto__":{"admin":true},"a":1}'));
		});

		it('should write values with JSON.stringify, and throw for what it cannot write', function () {
			expect(helpers.decodeJwt(helpers.signJwt({ at: new Date(0), fn: function () {} }, SECRET, { timestamp: false })).payload).toEqual({
				at: '1970-01-01T00:00:00.000Z'
			});
			expect(function () {
				helpers.signJwt({ big: 1n }, SECRET);
			}).toThrow(TypeError);
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			expect(function () {
				helpers.signJwt(cyclic, SECRET);
			}).toThrow(TypeError);
		});

		it('should validate its arguments', function () {
			for (const [payload, got] of [
				[null, 'null'],
				[[1], 'array'],
				['{}', 'string'],
				[undefined, 'undefined']
			] as const) {
				expect(function () {
					helpers.signJwt(payload as never, SECRET);
				}).toThrow(new TypeError(`signJwt: \`payload\` must be an object, got ${got}`));
			}
			expect(function () {
				helpers.signJwt({ toJSON: function () {} }, SECRET);
			}).toThrow(new TypeError('signJwt: `payload` must not have a toJSON method, which would replace it'));
			expect(function () {
				helpers.signJwt({}, SECRET, { header: { toJSON: function () {} } });
			}).toThrow(new TypeError('signJwt: `header` must not have a toJSON method, which would replace it'));
			expect(helpers.signJwt({ toJSON: 'not a method' }, SECRET, { timestamp: false })).toBe(token(HS256, '{"toJSON":"not a method"}'));
			// An inherited toJSON (a class's, a Date's) would replace the object in JSON.stringify just as well: refused, not dropped.
			class Claims {
				sub = 'own';

				/** Replaces the claims in JSON. */
				toJSON(): object {
					return { sub: 'replaced' };
				}
			}
			for (const payload of [new Claims(), new Date(0)]) {
				expect(function () {
					helpers.signJwt(payload, SECRET);
				}).toThrow(new TypeError('signJwt: `payload` must not have a toJSON method, which would replace it'));
			}
			for (const [header, got] of [
				[null, 'null'],
				[[], 'array'],
				['kid', 'string']
			] as const) {
				expect(function () {
					helpers.signJwt({}, SECRET, { header: header as never });
				}).toThrow(new TypeError(`signJwt: \`header\` must be an object, got ${got}`));
			}
			expect(function () {
				helpers.signJwt({}, '');
			}).toThrow(new RangeError('signJwt: `secret` must not be empty, got 0 bytes'));
			expect(function () {
				helpers.signJwt({}, new ArrayBuffer(0));
			}).toThrow(new RangeError('signJwt: `secret` must not be empty, got 0 bytes'));
			expect(function () {
				helpers.signJwt({}, 5 as never);
			}).toThrow(new TypeError('signJwt: `secret` must be a string, an ArrayBuffer or an ArrayBuffer view, got number'));
			expect(function () {
				helpers.signJwt({}, SECRET, 'x' as never);
			}).toThrow(new TypeError('signJwt: `options` must be an object, got string'));
			expect(function () {
				helpers.signJwt({}, SECRET, { timestamp: 1 as never });
			}).toThrow(new TypeError('signJwt: `timestamp` must be a boolean, got number'));
			expect(function () {
				helpers.signJwt({}, SECRET, { now: new Date(NaN) });
			}).toThrow(new RangeError('signJwt: `now` must be a valid Date or a finite number of milliseconds, got NaN'));
			for (const name of ['expiresIn', 'notBefore']) {
				expect(function () {
					helpers.signJwt({}, SECRET, { [name]: Infinity } as never);
				}).toThrow(new RangeError(`signJwt: \`${name}\` must be a finite number of seconds, got Infinity`));
				expect(function () {
					helpers.signJwt({}, SECRET, { [name]: '60' } as never);
				}).toThrow(new TypeError(`signJwt: \`${name}\` must be a finite number of seconds, got string`));
			}
		});

		it('should sign with binary secrets', function () {
			const secret = new Uint8Array(32).fill(9);
			expect(helpers.signJwt({}, secret, { timestamp: false })).toBe(token(HS256, '{}', secret));
			expect(helpers.signJwt({}, secret.buffer, { timestamp: false })).toBe(token(HS256, '{}', secret));
		});
	});

	describe('verifyJwt', function () {
		const VALID = token(HS256, '{"sub":"ada","iss":"https://issuer.example","aud":["api","admin"],"iat":1700000000,"nbf":1700000000,"exp":1700000060}');

		it('should return the header and the payload of an authentic token', function () {
			const verified = helpers.verifyJwt(VALID, SECRET, { now: NOW });
			expect(verified).toEqual({
				header: { alg: 'HS256', typ: 'JWT' },
				payload: { sub: 'ada', iss: 'https://issuer.example', aud: ['api', 'admin'], iat: 1700000000, nbf: 1700000000, exp: 1700000060 }
			});
			expect(Object.keys(verified)).toEqual(['header', 'payload']);
			expect(helpers.verifyJwt(token('{"alg":"HS256"}', '{}'), SECRET)).toEqual({ header: { alg: 'HS256' }, payload: {} });
			const secret = new Uint8Array([1, 2, 3]);
			expect(helpers.verifyJwt(token('{"alg":"HS256"}', '{"a":1}', secret), new DataView(secret.buffer)).payload).toEqual({ a: 1 });
		});

		it('should verify what signJwt signs', function () {
			const signed = helpers.signJwt({ sub: 'ada', roles: ['x'] }, SECRET, { now: NOW, expiresIn: 60, header: { kid: 'k' } });
			expect(helpers.verifyJwt<{ sub: string; roles: string[] }>(signed, SECRET, { now: NOW + 59_999 }).payload.roles).toEqual(['x']);
		});

		it('should reject every algorithm but HS256, before the signature (alg none and algorithm confusion)', function () {
			const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"admin":true}').toString('base64url')}.`;
			rejects(unsigned, 'invalid_algorithm', "the `alg` header parameter of `token` must be 'HS256'");
			for (const header of ['{"alg":"none"}', '{"alg":"RS256"}', '{"alg":"hs256"}', '{"alg":"HS256 "}', '{"alg":["HS256"]}', '{"typ":"JWT"}', '{"alg":"HS384"}']) {
				// Correctly HMAC-signed with the secret, yet rejected: the header must say HS256.
				rejects(token(header, '{}'), 'invalid_algorithm', "the `alg` header parameter of `token` must be 'HS256'");
			}
			polluted({ alg: 'HS256' }, function () {
				rejects(token('{}', '{}'), 'invalid_algorithm', "the `alg` header parameter of `token` must be 'HS256'");
			});
		});

		it('should reject a crit header, and check typ only when asked', function () {
			rejects(
				token('{"alg":"HS256","crit":["b64"],"b64":false}', '{}'),
				'invalid_header',
				'the header of `token` must not have a `crit` parameter (no extension is supported)'
			);
			for (const typ of ['JWT', 'jwt', 'application/JWT', 'Application/jwt']) {
				expect(helpers.verifyJwt(token(`{"alg":"HS256","typ":"${typ}"}`, '{}'), SECRET, { typ: 'jwt' }).header.typ).toBe(typ);
				expect(helpers.verifyJwt(token('{"alg":"HS256","typ":"jwt"}', '{}'), SECRET, { typ }).header.typ).toBe('jwt');
			}
			for (const header of ['{"alg":"HS256"}', '{"alg":"HS256","typ":"at+jwt"}', '{"alg":"HS256","typ":1}', '{"alg":"HS256","typ":"application/"}']) {
				rejects(token(header, '{}'), 'invalid_header', 'the `typ` header parameter of `token` must be "JWT"', { typ: 'JWT' });
			}
			expect(helpers.verifyJwt(token('{"alg":"HS256","typ":"anything"}', '{}'), SECRET).header.typ).toBe('anything');
		});

		it('should reject a token not signed with the secret', function () {
			const message = 'the signature of `token` must match `secret`';
			rejects(VALID, 'invalid_signature', message, { now: NOW }, 'another secret');
			const [header, payload, signature] = VALID.split('.');
			const forged = Buffer.from('{"sub":"admin","iat":1700000000,"exp":1700000060}').toString('base64url');
			rejects(`${header}.${forged}.${signature}`, 'invalid_signature', message, { now: NOW });
			rejects(`${header}.${payload}.`, 'invalid_signature', message, { now: NOW });
			rejects(`${header}.${payload}.${Buffer.from(Buffer.from(signature, 'base64url').subarray(0, 31)).toString('base64url')}`, 'invalid_signature', message, {
				now: NOW
			});
			rejects(`${header}.${payload}.${signature}AAAA`, 'invalid_signature', message, { now: NOW });
			const flipped = Buffer.from(signature, 'base64url');
			flipped[31] ^= 1;
			rejects(`${header}.${payload}.${flipped.toString('base64url')}`, 'invalid_signature', message, { now: NOW });
		});

		it('should reject malformed tokens as strictly as decodeJwt, without quoting them', function () {
			const [header, payload, signature] = VALID.split('.');
			const cases: [string, string][] = [
				['', '`token` must have 3 parts separated by dots, got 1'],
				[`${header}.${payload}`, '`token` must have 3 parts separated by dots, got 2'],
				[`${VALID}.x`, '`token` must have 3 parts separated by dots, got 4'],
				[`${header}=.${payload}.${signature}`, 'the header of `token` must be base64url text without padding'],
				[`${header}.${payload}.${signature}=`, 'the signature of `token` must be base64url text without padding'],
				[`${header}.${payload.slice(0, -1)}+.${signature}`, 'the payload of `token` must be base64url text without padding'],
				[`${header}. ${payload}.${signature}`, 'the payload of `token` must be base64url text without padding'],
				[`${Buffer.from('{"alg":').toString('base64url')}.${payload}.${signature}`, 'the header of `token` must be UTF-8 JSON'],
				[`${Buffer.from('["HS256"]').toString('base64url')}.${payload}.${signature}`, 'the header of `token` must be a JSON object, got array']
			];
			for (const [input, message] of cases) rejects(input, 'malformed', message);
			// A payload that is not a JSON object, correctly signed: rejected after the signature check.
			rejects(token('{"alg":"HS256"}', '{"exp":'), 'malformed', 'the payload of `token` must be UTF-8 JSON');
			rejects(token('{"alg":"HS256"}', '"text"'), 'malformed', 'the payload of `token` must be a JSON object, got string');
			const input = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url')}`;
			rejects(`${input}.${createHmac('sha256', SECRET).update(input).digest('base64url')}`, 'malformed', 'the payload of `token` must be UTF-8 JSON');
			// Not authentic, and malformed: the signature check comes first, so the payload is never parsed.
			rejects(token('{"alg":"HS256"}', '{"exp":', 'other'), 'invalid_signature', 'the signature of `token` must match `secret`');
			expect(
				thrown(function () {
					helpers.verifyJwt(`${Buffer.from('{"alg":"secret-looking"').toString('base64url')}.e30.`, SECRET);
				}).message
			).not.toContain('secret-looking');
		});

		it('should require exp, nbf and iat to be finite numbers', function () {
			for (const claim of ['exp', 'nbf', 'iat']) {
				for (const value of ['"1700000000"', 'null', '1e400', '-1e400', 'true', '[1]']) {
					rejects(token(HS256, `{"${claim}":${value}}`), 'invalid_claim', `the \`${claim}\` claim of \`token\` must be a finite number of seconds since the epoch`, {
						now: NOW
					});
				}
			}
		});

		it('should reject an expired token from its exp time on, with the tolerance', function () {
			const expiring = token(HS256, '{"exp":1700000000}');
			const message = '`token` has expired (its `exp` time has passed)';
			expect(helpers.verifyJwt(expiring, SECRET, { now: NOW - 1 }).payload.exp).toBe(1700000000);
			rejects(expiring, 'expired', message, { now: NOW });
			rejects(expiring, 'expired', message, { now: new Date(NOW) });
			expect(helpers.verifyJwt(expiring, SECRET, { now: NOW + 29_999, clockTolerance: 30 }).payload).toEqual({ exp: 1700000000 });
			rejects(expiring, 'expired', message, { now: NOW + 30_000, clockTolerance: 30 });
			expect(helpers.verifyJwt(token(HS256, '{"exp":1.7e308}'), SECRET, { now: Number.MAX_VALUE }).payload).toEqual({ exp: 1.7e308 });
			rejects(token(HS256, '{"exp":-1.7e308}'), 'expired', message, { now: -Number.MAX_VALUE });
			jest.spyOn(Date, 'now').mockReturnValue(NOW);
			rejects(expiring, 'expired', message);
			expect(helpers.verifyJwt(token(HS256, '{}'), SECRET, { now: Number.MAX_VALUE }).payload).toEqual({});
		});

		it('should reject a token before its nbf time, with the tolerance', function () {
			const early = token(HS256, '{"nbf":1700000000}');
			const message = '`token` is not valid yet (its `nbf` time has not come)';
			expect(helpers.verifyJwt(early, SECRET, { now: NOW }).payload).toEqual({ nbf: 1700000000 });
			rejects(early, 'not_before', message, { now: NOW - 1 });
			expect(helpers.verifyJwt(early, SECRET, { now: NOW - 30_000, clockTolerance: 30 }).payload).toEqual({ nbf: 1700000000 });
			rejects(early, 'not_before', message, { now: NOW - 30_001, clockTolerance: 30 });
			rejects(token(HS256, '{"nbf":1.7e308}'), 'not_before', message, { now: Number.MAX_VALUE });
			expect(helpers.verifyJwt(token(HS256, '{"nbf":-1.7e308}'), SECRET, { now: -Number.MAX_VALUE }).payload).toEqual({ nbf: -1.7e308 });
		});

		it('should check maxAge against iat, with the tolerance', function () {
			const issued = token(HS256, '{"iat":1700000000}');
			// The age is counted in whole seconds, like jose (`iat` itself is truncated to the second): 60.999 s is 60 s.
			expect(helpers.verifyJwt(issued, SECRET, { now: NOW + 60_999, maxAge: 60 }).payload).toEqual({ iat: 1700000000 });
			rejects(issued, 'too_old', '`token` must have been issued at most `maxAge` seconds ago (its `iat` claim)', { now: NOW + 61_000, maxAge: 60 });
			expect(helpers.verifyJwt(issued, SECRET, { now: NOW + 65_999, maxAge: 60, clockTolerance: 5 }).payload).toEqual({ iat: 1700000000 });
			rejects(issued, 'too_old', '`token` must have been issued at most `maxAge` seconds ago (its `iat` claim)', { now: NOW + 66_000, maxAge: 60, clockTolerance: 5 });
			expect(helpers.verifyJwt(issued, SECRET, { now: NOW, maxAge: 0 }).payload).toEqual({ iat: 1700000000 });
			// A token signed at this very instant is not too old, whatever the milliseconds of `now`.
			const fresh = helpers.signJwt({}, SECRET, { now: NOW + 999 });
			expect(helpers.verifyJwt(fresh, SECRET, { now: NOW + 999, maxAge: 0 }).payload).toEqual({ iat: 1700000000 });
			expect(helpers.verifyJwt(issued, SECRET, { now: NOW - 5000, maxAge: 0, clockTolerance: 5 }).payload).toEqual({ iat: 1700000000 });
			rejects(issued, 'invalid_claim', 'the `iat` claim of `token` must not be in the future', { now: NOW - 5001, maxAge: 0, clockTolerance: 5 });
			rejects(issued, 'invalid_claim', 'the `iat` claim of `token` must not be in the future', { now: NOW - 1, maxAge: 100 });
			rejects(token(HS256, '{}'), 'invalid_claim', 'the `iat` claim of `token` must be present to check `maxAge`', { now: NOW, maxAge: 60 });
			rejects(token(HS256, '{"iat":-1.7e308}'), 'too_old', '`token` must have been issued at most `maxAge` seconds ago (its `iat` claim)', { now: 0, maxAge: 1e300 });
			// Without maxAge, iat is only type-checked: a future iat is accepted, like jose.
			expect(helpers.verifyJwt(issued, SECRET, { now: 0 }).payload).toEqual({ iat: 1700000000 });
		});

		it('should check the issuer, the subject and the audience when asked', function () {
			function verify(payload: string, options: helpers.VerifyJwtOptions): unknown {
				return helpers.verifyJwt(token(HS256, payload), SECRET, options).payload;
			}
			expect(verify('{"iss":"a"}', { issuer: 'a' })).toEqual({ iss: 'a' });
			expect(verify('{"iss":"b"}', { issuer: ['a', 'b'] })).toEqual({ iss: 'b' });
			for (const payload of ['{}', '{"iss":"c"}', '{"iss":["a"]}', '{"iss":null}']) {
				rejects(token(HS256, payload), 'invalid_issuer', 'the `iss` claim of `token` must be an accepted `issuer`', { issuer: ['a', 'b'] });
			}
			expect(verify('{"sub":"ada"}', { subject: 'ada' })).toEqual({ sub: 'ada' });
			for (const payload of ['{}', '{"sub":"bob"}', '{"sub":["ada"]}']) {
				rejects(token(HS256, payload), 'invalid_subject', 'the `sub` claim of `token` must be `subject`', { subject: 'ada' });
			}
			expect(verify('{"aud":"api"}', { audience: 'api' })).toEqual({ aud: 'api' });
			expect(verify('{"aud":["web",1,"api"]}', { audience: 'api' })).toEqual({ aud: ['web', 1, 'api'] });
			expect(verify('{"aud":"api"}', { audience: ['web', 'api'] })).toEqual({ aud: 'api' });
			expect(verify('{"aud":["x","web"]}', { audience: ['web', 'api'] })).toEqual({ aud: ['x', 'web'] });
			for (const payload of ['{}', '{"aud":"web"}', '{"aud":["web"]}', '{"aud":[]}', '{"aud":1}', '{"aud":{"api":true}}', '{"aud":[["api"]]}']) {
				rejects(token(HS256, payload), 'invalid_audience', 'the `aud` claim of `token` must hold an accepted `audience`', { audience: 'api' });
			}
			// Unchecked when not asked.
			expect(verify('{"iss":1,"sub":2,"aud":3}', {})).toEqual({ iss: 1, sub: 2, aud: 3 });
		});

		it('should match the audience in time linear in the lengths of the claim and the option (regression)', function () {
			// Regression: each value of the `aud` claim was looked up with `includes`, so the work was the product of both lengths.
			const aud = Array.from({ length: 200 }, function (_, i) {
				return `aud-${i}`;
			});
			let reads = 0;
			const audience = new Proxy(['web', ...aud.slice(150)].reverse(), {
				get(target, key) {
					reads++;
					return Reflect.get(target, key);
				}
			});
			expect(helpers.verifyJwt(token(HS256, JSON.stringify({ aud })), SECRET, { audience }).payload).toEqual({ aud });
			expect(reads).toBeLessThan(500);
			rejects(token(HS256, JSON.stringify({ aud: aud.slice(0, 150) })), 'invalid_audience', 'the `aud` claim of `token` must hold an accepted `audience`', { audience });
		});

		it('should read only own claims and options, ignoring a polluted Object.prototype', function () {
			const values = { exp: 1, nbf: 1e300, iat: 'x', crit: ['x'], typ: 'other', issuer: 'x', audience: 'x', subject: 'x', maxAge: 0, clockTolerance: -1, now: NaN };
			polluted(values, function () {
				expect(helpers.verifyJwt(token(HS256, '{}'), SECRET, {}).payload).toEqual({});
				expect(helpers.verifyJwt(token(HS256, '{"iss":"i"}'), SECRET, { issuer: 'i' }).payload).toEqual({ iss: 'i' });
				expect(helpers.verifyJwt(token(HS256, '{"__proto__":{"admin":true}}'), SECRET).payload).toEqual({});
			});
		});

		it('should validate its arguments', function () {
			const invalid: [helpers.VerifyJwtOptions, Error][] = [
				[{ now: new Date(NaN) }, new RangeError('verifyJwt: `now` must be a valid Date or a finite number of milliseconds, got NaN')],
				[{ now: '1' as never }, new TypeError('verifyJwt: `now` must be a valid Date or a finite number of milliseconds, got string')],
				[{ clockTolerance: -1 }, new RangeError('verifyJwt: `clockTolerance` must be a finite number of seconds >= 0, got -1')],
				[{ clockTolerance: Infinity }, new RangeError('verifyJwt: `clockTolerance` must be a finite number of seconds >= 0, got Infinity')],
				[{ clockTolerance: '5' as never }, new TypeError('verifyJwt: `clockTolerance` must be a finite number of seconds >= 0, got string')],
				[{ maxAge: -1 }, new RangeError('verifyJwt: `maxAge` must be a finite number of seconds >= 0, got -1')],
				[{ maxAge: NaN }, new RangeError('verifyJwt: `maxAge` must be a finite number of seconds >= 0, got NaN')],
				[{ issuer: [] }, new RangeError('verifyJwt: `issuer` must not be an empty array')],
				[{ issuer: ['a', 1] as never }, new TypeError('verifyJwt: `issuer` must be a string or an array of strings, got object')],
				[{ issuer: 1 as never }, new TypeError('verifyJwt: `issuer` must be a string or an array of strings, got number')],
				[{ audience: [] }, new RangeError('verifyJwt: `audience` must not be an empty array')],
				[{ audience: null as never }, new TypeError('verifyJwt: `audience` must be a string or an array of strings, got null')],
				// A hole is not a string: skipping it would accept a token without the claim (regression).
				// oxlint-disable-next-line no-sparse-arrays
				[{ audience: [, 'api'] as never }, new TypeError('verifyJwt: `audience` must be a string or an array of strings, got object')],
				[{ audience: new Array(1) }, new TypeError('verifyJwt: `audience` must be a string or an array of strings, got object')],
				// oxlint-disable-next-line no-sparse-arrays
				[{ issuer: ['a', ,] as never }, new TypeError('verifyJwt: `issuer` must be a string or an array of strings, got object')],
				[{ subject: 1 as never }, new TypeError('verifyJwt: `subject` must be a string, got number')],
				[{ typ: 1 as never }, new TypeError('verifyJwt: `typ` must be a string, got number')]
			];
			for (const [options, error] of invalid) {
				expect(function () {
					helpers.verifyJwt(VALID, SECRET, options);
				}).toThrow(error);
			}
			expect(function () {
				helpers.verifyJwt(VALID, SECRET, null as never);
			}).toThrow(new TypeError('verifyJwt: `options` must be an object, got null'));
			expect(function () {
				helpers.verifyJwt(VALID, '');
			}).toThrow(new RangeError('verifyJwt: `secret` must not be empty, got 0 bytes'));
			expect(function () {
				helpers.verifyJwt(VALID, undefined as never);
			}).toThrow(new TypeError('verifyJwt: `secret` must be a string, an ArrayBuffer or an ArrayBuffer view, got undefined'));
			expect(function () {
				helpers.verifyJwt(undefined as never, SECRET);
			}).toThrow(new TypeError('verifyJwt: `token` must be a string, got undefined'));
		});

		it('should throw a JwtVerificationError that never quotes the token or the secret', function () {
			const error = new helpers.JwtVerificationError('verifyJwt: x', 'expired');
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe('JwtVerificationError');
			expect(error.code).toBe('expired');
			expect(error.message).toBe('verifyJwt: x');
			const secretPayload = token(HS256, '{"sub":"s3cr3t-subject"}');
			const rejected = thrown(function () {
				helpers.verifyJwt(secretPayload, SECRET, { subject: 'other' });
			});
			expect(rejected.message).not.toContain('s3cr3t');
			expect(rejected.message).not.toContain(SECRET);
			expect(rejected.cause).toBeUndefined();
		});
	});
});
