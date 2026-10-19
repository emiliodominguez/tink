import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
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
