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
		expect(helpers.toCsv([[''], [null], ['', ''], []])).toBe('""\r\n""\r\n,\r\n');
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
		expect(helpers.toCsv([[''], []], { formulaEscape: true })).toBe('""\r\n');
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
