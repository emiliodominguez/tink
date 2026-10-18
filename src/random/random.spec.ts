import * as helpers from '.';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Temporarily replaces `globalThis.crypto` for the duration of `fn`, restoring the original property afterwards.
 */
function withCrypto<T>(value: unknown, fn: () => T): T {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true, enumerable: false });
	try {
		return fn();
	} finally {
		if (original) Object.defineProperty(globalThis, 'crypto', original);
		else delete (globalThis as any).crypto;
	}
}

/**
 * A fake crypto whose `getRandomValues` fills buffers from successive `batches` (each batch fills one call).
 */
function scriptedCrypto(batches: number[][]): { getRandomValues: jest.Mock } {
	let call = 0;
	return {
		getRandomValues: jest.fn(function (array: Uint8Array) {
			const batch = batches[call++] ?? [];
			for (let i = 0; i < array.length; i++) array[i] = batch[i] ?? 0;
			return array;
		})
	};
}

function constant(value: number): () => number {
	return function () {
		return value;
	};
}

describe('random', function () {
	describe('createRandom', function () {
		it('should reproduce the reference sfc32/cyrb128 sequence for a string seed', function () {
			const rng = helpers.createRandom('js-helpers');
			const values = [rng(), rng(), rng(), rng(), rng()];
			expect(values).toEqual([0.07175572402775288, 0.3699936708435416, 0.01671538082882762, 0.5509338909760118, 0.4222039554733783]);
		});

		it('should reproduce the reference sequence for a numeric seed (hashed as its string form)', function () {
			const rng = helpers.createRandom(42);
			expect([rng(), rng(), rng(), rng(), rng()]).toEqual([0.5258469053078443, 0.18668818706646562, 0.4050233217421919, 0.8641218249686062, 0.4309007697738707]);
			const fromString = helpers.createRandom('42');
			expect(fromString()).toBe(0.5258469053078443);
			expect(helpers.createRandom(42).state()).toEqual([3917207958, 1691418813, 2659351410, 944835786]);
		});

		it('should produce reproducible derived values', function () {
			const dice = helpers.createRandom('dice');
			expect(
				Array.from({ length: 10 }, function () {
					return dice.int(1, 6);
				})
			).toEqual([6, 5, 3, 6, 2, 3, 5, 3, 5, 1]);
			expect(helpers.createRandom('shuffle').shuffle([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([3, 4, 2, 1, 8, 5, 7, 6]);
			const big = helpers.createRandom('big');
			expect(big.int(0, Number.MAX_SAFE_INTEGER)).toBe(572415390030419);
			expect(big.int(-Number.MAX_SAFE_INTEGER, 0)).toBe(-8631897986744781);
		});

		it('should accept the empty string, unicode strings, zero and negative seeds', function () {
			expect(helpers.createRandom('').state()).toEqual([228195672, 929963046, 124707130, 1262568331]);
			expect(helpers.createRandom('🎲')()).not.toBe(helpers.createRandom('🎰')());
			expect(helpers.createRandom(-1)()).not.toBe(helpers.createRandom(1)());
			expect(helpers.createRandom(-0)()).toBe(helpers.createRandom(0)());
		});

		it('should be usable wherever a RandomGenerator is expected', function () {
			const rng = helpers.createRandom('gen');
			const value = helpers.randomBoolean(0.5, rng);
			expect(typeof value).toBe('boolean');
			expect(typeof rng).toBe('function');
			expect(Object.isFrozen(rng)).toBe(true);
		});

		it('should reject invalid seeds', function () {
			expect(function () {
				helpers.createRandom(NaN);
			}).toThrow(new RangeError('createRandom: `seed` must be a finite number or a string, got NaN'));
			expect(function () {
				helpers.createRandom(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.createRandom(undefined as any);
			}).toThrow(new TypeError('createRandom: `seed` must be a finite number or a string, got undefined'));
			expect(function () {
				helpers.createRandom({} as any);
			}).toThrow(TypeError);
		});

		it('should distribute int() uniformly (chi-square on 10k samples)', function () {
			const rng = helpers.createRandom('uniformity');
			const counts = new Array(10).fill(0);
			const samples = 10_000;
			for (let i = 0; i < samples; i++) counts[rng.int(0, 9)]++;
			const expected = samples / 10;
			const chiSquare = counts.reduce(function (total: number, observed: number) {
				return total + (observed - expected) ** 2 / expected;
			}, 0);
			// 9 degrees of freedom: p = 0.001 critical value is ~27.9.
			expect(chiSquare).toBeLessThan(27.9);
		});

		it('should have a mean close to 0.5 for raw floats', function () {
			const rng = helpers.createRandom('mean');
			let total = 0;
			for (let i = 0; i < 10_000; i++) total += rng();
			expect(Math.abs(total / 10_000 - 0.5)).toBeLessThan(0.02);
		});

		describe('int', function () {
			it('should handle degenerate, fractional and negative ranges', function () {
				const rng = helpers.createRandom('int');
				expect(rng.int(5, 5)).toBe(5);
				expect([2, 3]).toContain(rng.int(1.2, 3.8));
				const value = rng.int(-10, -5);
				expect(value).toBeGreaterThanOrEqual(-10);
				expect(value).toBeLessThanOrEqual(-5);
				expect(Object.is(rng.int(-0.5, 0), 0)).toBe(true);
			});

			it('should stay in bounds on ranges that need rejection sampling', function () {
				const rng = helpers.createRandom('rejection');
				for (let i = 0; i < 200; i++) {
					const small = rng.int(0, 2 ** 31);
					expect(small).toBeGreaterThanOrEqual(0);
					expect(small).toBeLessThanOrEqual(2 ** 31);
					const large = rng.int(0, 2 ** 52);
					expect(Number.isSafeInteger(large)).toBe(true);
					expect(large).toBeLessThanOrEqual(2 ** 52);
				}
			});

			it('should reject an output exactly equal to the rejection limit (unbiasedness)', function () {
				// sfc32 outputs a + b + d: these states make the next output(s) land exactly on the rejection limit.
				const rng = helpers.createRandom('limit');
				const reference = helpers.createRandom('limit');
				function raw(): number {
					return reference() * 2 ** 32;
				}
				// One 32-bit output: range 3 * 2 ** 30 rejects outputs >= 3 * 2 ** 30; the next output is 1.
				rng.restore([3 * 2 ** 30, 0, 0, 0]);
				expect(rng.int(0, 3 * 2 ** 30 - 1)).toBe(1);
				// Two outputs (53 bits): range 3 * 2 ** 51 rejects values >= 3 * 2 ** 51 = (3 * 2 ** 30 >>> 11) * 2 ** 32 + 0.
				const state = [3 * 2 ** 30 + 1, 0, 0, 2 ** 32 - 1] as const;
				rng.restore(state);
				reference.restore(state);
				expect(raw()).toBe(3 * 2 ** 30);
				expect(raw()).toBe(0);
				// The following pairs are rejected while they are >= the limit (here the limit equals the range).
				let expected: number;
				do expected = Math.floor(raw() / 2 ** 11) * 2 ** 32 + raw();
				while (expected >= 3 * 2 ** 51);
				expect(rng.int(0, 3 * 2 ** 51 - 1)).toBe(expected);
			});

			it('should throw on invalid ranges', function () {
				const rng = helpers.createRandom('int');
				expect(function () {
					rng.int(NaN, 1);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(0, Infinity);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(2, 1);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(1.2, 1.8);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(0, 2 ** 53);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
				}).toThrow(RangeError);
				// A small span is not enough: both bounds must be safe integers.
				expect(function () {
					rng.int(2 ** 53, 2 ** 53 + 2);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(2 ** 53 - 2, 2 ** 53);
				}).toThrow(RangeError);
				expect(function () {
					rng.int(-(2 ** 53), -(2 ** 53) + 2);
				}).toThrow(RangeError);
			});

			it('should name the method and the parameter in error messages', function () {
				const rng = helpers.createRandom('int');
				const cases: Array<[() => unknown, Error]> = [
					[
						function () {
							return rng.int(NaN, 1);
						},
						new RangeError('SeededRandom.int: `min` must be a finite number, got NaN')
					],
					[
						function () {
							return rng.int(0, '1' as any);
						},
						new TypeError('SeededRandom.int: `max` must be a finite number, got string')
					],
					[
						function () {
							return rng.int(1.2, 1.8);
						},
						new RangeError('SeededRandom.int: no integer exists in [1.2, 1.8]')
					],
					[
						function () {
							return rng.int(0, 2 ** 53);
						},
						new RangeError(`SeededRandom.int: [0, ${2 ** 53}] must lie within safe integers and span at most 2 ** 53 values`)
					]
				];
				for (const [fn, error] of cases) expect(fn).toThrow(error);
			});
		});

		describe('float / bool / pick / shuffle', function () {
			it('should delegate float to a half-open range', function () {
				const rng = helpers.createRandom('float');
				const value = rng.float(10, 20);
				expect(value).toBeGreaterThanOrEqual(10);
				expect(value).toBeLessThan(20);
				expect(rng.float(3, 3)).toBe(3);
				expect(function () {
					rng.float(2, 1);
				}).toThrow(RangeError);
			});

			it('should honour bool probabilities', function () {
				const rng = helpers.createRandom('bool');
				expect(rng.bool(0)).toBe(false);
				expect(rng.bool(1)).toBe(true);
				let trues = 0;
				for (let i = 0; i < 10_000; i++) if (rng.bool()) trues++;
				expect(trues).toBeGreaterThan(4_700);
				expect(trues).toBeLessThan(5_300);
				expect(function () {
					rng.bool(1.5);
				}).toThrow(RangeError);
			});

			it('should pick items and return undefined for empty arrays without advancing', function () {
				const rng = helpers.createRandom('pick');
				expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
				const before = rng.state();
				expect(rng.pick([])).toBeUndefined();
				expect(rng.state()).toEqual(before);
			});

			it('should shuffle without mutating the input', function () {
				const rng = helpers.createRandom('shuffle-copy');
				const input = Object.freeze([1, 2, 3, 4, 5]);
				const result = rng.shuffle(input);
				expect(result).not.toBe(input);
				expect([...result].sort()).toEqual([1, 2, 3, 4, 5]);
				expect(rng.shuffle([])).toEqual([]);
			});
		});

		describe('fork / state / restore', function () {
			it('should create a deterministic child stream that differs from the parent', function () {
				const parent = helpers.createRandom('fork');
				const child = parent.fork();
				const again = helpers.createRandom('fork').fork();
				const childValues = [child(), child(), child()];
				expect([again(), again(), again()]).toEqual(childValues);
				expect([parent(), parent(), parent()]).not.toEqual(childValues);
			});

			it('should advance the parent by four draws when forking', function () {
				const forked = helpers.createRandom('advance');
				forked.fork();
				const reference = helpers.createRandom('advance');
				for (let i = 0; i < 4; i++) reference();
				expect(forked()).toBe(reference());
			});

			it('should replay a stream from a snapshot', function () {
				const rng = helpers.createRandom('replay');
				rng();
				const snapshot = rng.state();
				expect(Object.isFrozen(snapshot)).toBe(true);
				const first = [rng(), rng(), rng()];
				rng.restore(snapshot);
				expect([rng(), rng(), rng()]).toEqual(first);
				const other = helpers.createRandom('other');
				other.restore(snapshot);
				expect(other()).toBe(first[0]);
			});

			it('should reject sparse snapshots instead of reading holes as 0 (regression)', function () {
				const rng = helpers.createRandom('restore');
				const before = rng.state();
				for (const snapshot of [new Array(4), Object.assign(new Array(4), { 0: 1, 2: 2, 3: 3 })]) {
					expect(function () {
						rng.restore(snapshot as any);
					}).toThrow(TypeError);
				}
				expect(rng.state()).toEqual(before);
			});

			it('should reject malformed snapshots', function () {
				const rng = helpers.createRandom('restore');
				const invalid: unknown[] = [null, 'abcd', [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, -1], [1, 2, 3, 2 ** 32], [1, 2, 3, 0.5], [1, 2, 3, '4']];
				for (const snapshot of invalid) {
					expect(function () {
						rng.restore(snapshot as any);
					}).toThrow(new TypeError('SeededRandom.restore: `snapshot` must be an array of four unsigned 32-bit integers'));
				}
			});

			it('should accept the extreme words 0 and 2 ** 32 - 1', function () {
				const rng = helpers.createRandom('restore');
				rng.restore([0, 0, 0, 0]);
				expect(rng.state()).toEqual([0, 0, 0, 0]);
				expect(rng()).toBe(0);
				rng.restore([2 ** 32 - 1, 0, 2 ** 32 - 1, 0]);
				expect(rng.state()).toEqual([2 ** 32 - 1, 0, 2 ** 32 - 1, 0]);
			});
		});
	});

	describe('randomBytes', function () {
		it('should return the requested number of bytes', function () {
			expect(helpers.randomBytes(0)).toEqual(new Uint8Array(0));
			const bytes = helpers.randomBytes(32);
			expect(bytes).toBeInstanceOf(Uint8Array);
			expect(bytes.length).toBe(32);
		});

		it('should fill requests larger than the 65536-byte WebCrypto quota in chunks', function () {
			const large = helpers.randomBytes(200_000);
			expect(large.length).toBe(200_000);
			// The tail must have been filled too (all-zero 1000 bytes is astronomically unlikely).
			expect(large.subarray(199_000).some(Boolean)).toBe(true);

			const fake = scriptedCrypto([]);
			withCrypto(fake, function () {
				helpers.randomBytes(65_536 * 2 + 5);
			});
			const lengths = fake.getRandomValues.mock.calls.map(function (call: any[]) {
				return call[0].length;
			});
			expect(lengths).toEqual([65_536, 65_536, 5]);

			// Exact multiples of the quota need no extra (empty) request, and zero bytes need none at all.
			const exact = scriptedCrypto([]);
			withCrypto(exact, function () {
				helpers.randomBytes(65_536 * 2);
				helpers.randomBytes(0);
			});
			expect(
				exact.getRandomValues.mock.calls.map(function (call: any[]) {
					return call[0].length;
				})
			).toEqual([65_536, 65_536]);
		});

		it('should reject invalid lengths', function () {
			for (const length of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
				expect(function () {
					helpers.randomBytes(length);
				}).toThrow(new RangeError(`randomBytes: \`length\` must be a safe integer >= 0, got ${length}`));
			}
		});
	});

	describe('randomUUID', function () {
		it('should return a version 4, RFC 4122 variant UUID', function () {
			const uuid = helpers.randomUUID();
			expect(uuid).toMatch(UUID_V4);
			expect(helpers.randomUUID()).not.toBe(uuid);
		});

		it('should prefer crypto.randomUUID when available (called as a method)', function () {
			const fake = {
				getRandomValues: jest.fn(),
				randomUUID: jest.fn(function (this: unknown) {
					expect(this).toBe(fake);
					return '11111111-1111-4111-8111-111111111111';
				})
			};
			expect(
				withCrypto(fake, function () {
					return helpers.randomUUID();
				})
			).toBe('11111111-1111-4111-8111-111111111111');
			expect(fake.getRandomValues).not.toHaveBeenCalled();
		});

		it('should build a UUID from getRandomValues when randomUUID is missing', function () {
			const real = globalThis.crypto;
			const uuid = withCrypto(
				{
					getRandomValues: function (array: Uint8Array<ArrayBuffer>) {
						return real.getRandomValues(array);
					}
				},
				function () {
					return helpers.randomUUID();
				}
			);
			expect(uuid).toMatch(UUID_V4);
		});

		it('should not rely on the return value of getRandomValues (regression: polyfills returning undefined crashed)', function () {
			const uuid = withCrypto(
				{
					getRandomValues: function (array: Uint8Array): void {
						array.fill(0xff);
					}
				},
				function () {
					return helpers.randomUUID();
				}
			);
			expect(uuid).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
		});

		it('should set the version and variant bits regardless of the random bytes', function () {
			expect(
				withCrypto(scriptedCrypto([new Array(16).fill(0xff)]), function () {
					return helpers.randomUUID();
				})
			).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
			expect(
				withCrypto(scriptedCrypto([new Array(16).fill(0)]), function () {
					return helpers.randomUUID();
				})
			).toBe('00000000-0000-4000-8000-000000000000');
			expect(
				withCrypto(scriptedCrypto([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]]), function () {
					return helpers.randomUUID();
				})
			).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
		});
	});

	describe('randomId', function () {
		it('should default to 21 URL-safe characters', function () {
			const id = helpers.randomId();
			expect(id).toHaveLength(21);
			expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
			expect(helpers.URL_ALPHABET).toHaveLength(64);
			expect(new Set(helpers.URL_ALPHABET).size).toBe(64);
		});

		it('should honour size and alphabet, including astral characters', function () {
			expect(helpers.randomId(0)).toBe('');
			expect(helpers.randomId(50, 'ab')).toMatch(/^[ab]{50}$/);
			const emoji = helpers.randomId(10, '🍎🍌🍒');
			expect(Array.from(emoji)).toHaveLength(10);
			for (const char of emoji) expect(['🍎', '🍌', '🍒']).toContain(char);
			const full = Array.from({ length: 256 }, function (_, i) {
				return String.fromCharCode(0x100 + i);
			}).join('');
			expect(Array.from(helpers.randomId(100, full))).toHaveLength(100);
		});

		it('should reject out-of-range mask values (rejection sampling) and request more bytes when needed', function () {
			// Alphabet of 10 => mask 15: values 10..15 must be skipped, not wrapped around.
			const fake = scriptedCrypto([[10, 3, 15, 7, 26, 255, 9]]);
			const id = withCrypto(fake, function () {
				return helpers.randomId(4, '0123456789');
			});
			// 10 rejected, 3, 15 rejected, 7, 26 & 15 = 10 rejected, 255 & 15 = 15 rejected, 9 then 0 (filler bytes).
			expect(id).toBe('3790');

			// Alphabet of 3 => mask 3: an all-rejected first batch forces a second request.
			const retry = scriptedCrypto([
				[3, 3],
				[2, 3]
			]);
			expect(
				withCrypto(retry, function () {
					return helpers.randomId(1, 'xyz');
				})
			).toBe('z');
			expect(retry.getRandomValues).toHaveBeenCalledTimes(2);
		});

		it('should serve consecutive calls from one buffered batch, handing out every character once', function () {
			let next = 0;
			const counting = {
				getRandomValues: jest.fn(function (array: Uint8Array) {
					for (let i = 0; i < array.length; i++) array[i] = next++ & 255;
					return array;
				})
			};
			const ids = withCrypto(counting, function () {
				return [helpers.randomId(5), helpers.randomId(5), helpers.randomId(5), helpers.randomId(70), helpers.randomId(1)];
			});
			// The first batch is exactly the requested size; the next one is 16 times larger and serves the next three calls.
			expect(ids).toEqual(['ABCDE', 'FGHIJ', 'KLMNO', helpers.URL_ALPHABET.slice(15) + helpers.URL_ALPHABET.slice(0, 21), 'V']);
			expect(
				counting.getRandomValues.mock.calls.map(function (call: any[]) {
					return call[0].length;
				})
			).toEqual([5, 80, 1280]);
		});

		it('should only use the characters of non-ASCII alphabets (regression: code points were truncated to bytes)', function () {
			// U+0100.. would wrap to control characters and U+0080.. are not single UTF-8 bytes: neither may be decoded as ASCII.
			for (const alphabet of ['ĀāĂ', 'àéîõü\u0080', 'aĀ', 'ab\u0080']) {
				const id = helpers.randomId(200, alphabet);
				expect(Array.from(id)).toHaveLength(200);
				for (const char of id) expect(alphabet).toContain(char);
			}
		});

		it('should build ids without TextDecoder too', function () {
			let next = 0;
			const counting = {
				getRandomValues: function (array: Uint8Array): Uint8Array {
					for (let i = 0; i < array.length; i++) array[i] = next++ & 255;
					return array;
				}
			};
			const original = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder') as PropertyDescriptor;
			Object.defineProperty(globalThis, 'TextDecoder', { value: undefined, configurable: true, writable: true });
			try {
				expect(
					withCrypto(counting, function () {
						return helpers.randomId(10);
					})
				).toBe('ABCDEFGHIJ');
			} finally {
				Object.defineProperty(globalThis, 'TextDecoder', original);
			}
			expect(helpers.randomId(30)).toMatch(/^[A-Za-z0-9_-]{30}$/);
		});

		it('should use the alphabet of each call when alternating alphabets, and keep validating them', function () {
			for (let i = 0; i < 20; i++) {
				expect(helpers.randomId(30, 'ab')).toMatch(/^[ab]{30}$/);
				expect(helpers.randomId(30, 'xyz')).toMatch(/^[xyz]{30}$/);
				expect(helpers.randomId(30)).toMatch(/^[A-Za-z0-9_-]{30}$/);
				expect(function () {
					helpers.randomId(5, 'aa');
				}).toThrow(RangeError);
			}
		});

		it('should reject invalid sizes and alphabets', function () {
			for (const size of [-1, 1.5, NaN, Infinity]) {
				expect(function () {
					helpers.randomId(size);
				}).toThrow(new RangeError(`randomId: \`size\` must be a safe integer >= 0, got ${size}`));
			}
			const tooLong = Array.from({ length: 257 }, function (_, i) {
				return String.fromCharCode(0x100 + i);
			}).join('');
			for (const alphabet of ['', 'a', 'abca', '🍎🍎', tooLong]) {
				expect(function () {
					helpers.randomId(5, alphabet);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.randomId(5, tooLong);
			}).toThrow(new RangeError('randomId: `alphabet` must contain between 2 and 256 characters, got 257'));
			expect(function () {
				helpers.randomId(5, 'abca');
			}).toThrow(new RangeError('randomId: `alphabet` must not contain duplicate characters'));
		});
	});

	describe('when no CSPRNG is available', function () {
		it.each([
			['undefined', undefined],
			['null', null],
			['an object without getRandomValues', {}]
		])('should throw instead of falling back to Math.random (crypto is %s)', function (_label, value) {
			const mathRandom = jest.spyOn(Math, 'random');
			withCrypto(value, function () {
				expect(function () {
					helpers.randomUUID();
				}).toThrow(/^randomUUID: no cryptographically secure/);
				expect(function () {
					helpers.randomBytes(8);
				}).toThrow(/^randomBytes: no cryptographically secure/);
				expect(function () {
					helpers.randomId();
				}).toThrow(/^randomId: no cryptographically secure/);
				expect(function () {
					helpers.randomId(0);
				}).toThrow(Error);
			});
			expect(mathRandom).not.toHaveBeenCalled();
		});

		it('should restore the real crypto afterwards', function () {
			expect(typeof globalThis.crypto.getRandomValues).toBe('function');
			expect(helpers.randomUUID()).toMatch(UUID_V4);
		});
	});

	describe('weightedRandom', function () {
		it('should reject numeric strings instead of concatenating them (e.g. weights read from a query string)', function () {
			expect(function () {
				helpers.weightedRandom(['a', 'b'], ['5', '3'] as never);
			}).toThrow(new TypeError('weightedRandom: `weights[0]` must be a finite number >= 0, got string'));
		});

		it('should map the uniform draw onto cumulative weights', function () {
			const items = ['a', 'b', 'c'];
			const weights = [1, 2, 1];
			expect(helpers.weightedRandom(items, weights, constant(0))).toBe('a');
			expect(helpers.weightedRandom(items, weights, constant(0.24))).toBe('a');
			expect(helpers.weightedRandom(items, weights, constant(0.25))).toBe('b');
			expect(helpers.weightedRandom(items, weights, constant(0.74))).toBe('b');
			expect(helpers.weightedRandom(items, weights, constant(0.75))).toBe('c');
			expect(helpers.weightedRandom(items, weights, constant(1 - Number.EPSILON / 2))).toBe('c');
		});

		it('should never return zero-weight items, even at the extremes', function () {
			expect(helpers.weightedRandom(['a', 'b', 'c'], [0, 1, 0], constant(0))).toBe('b');
			expect(helpers.weightedRandom(['a', 'b', 'c'], [0, 1, 0], constant(1 - Number.EPSILON / 2))).toBe('b');
			expect(helpers.weightedRandom(['a', 'b', 'c'], [1, 0, -0], constant(0.999))).toBe('a');
			// The draw times a subnormal total rounds up to the total itself: the trailing zero-weight item must still not be picked.
			expect(helpers.weightedRandom(['a', 'b'], [Number.MIN_VALUE, 0], constant(1 - Number.EPSILON / 2))).toBe('a');
			expect(helpers.weightedRandom(['only'], [3])).toBe('only');
		});

		it('should follow the weights statistically', function () {
			const rng = helpers.createRandom('weighted');
			const counts: Record<string, number> = { common: 0, rare: 0, never: 0 };
			for (let i = 0; i < 10_000; i++) counts[helpers.weightedRandom(['common', 'rare', 'never'], [9, 1, 0], rng)]++;
			expect(counts.never).toBe(0);
			expect(counts.rare).toBeGreaterThan(800);
			expect(counts.rare).toBeLessThan(1_200);
		});

		it('should throw on invalid input', function () {
			const cases: [unknown[], number[]][] = [
				[['a'], [1, 2]],
				[[], []],
				[
					['a', 'b'],
					[0, 0]
				],
				[
					['a', 'b'],
					[1, -1]
				],
				[
					['a', 'b'],
					[1, NaN]
				],
				[
					['a', 'b'],
					[1, Infinity]
				],
				[
					['a', 'b'],
					[1e308, 1e308]
				]
			];
			for (const [items, weights] of cases) {
				expect(function () {
					helpers.weightedRandom(items, weights);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.weightedRandom(['a'], [1], constant(1));
			}).toThrow(new RangeError('weightedRandom: `random()` must return a number in [0, 1), got 1'));
		});

		it('should validate every weight, even when the total looks valid, and name the offending one', function () {
			const cases: Array<[unknown, Error]> = [
				[-1, new RangeError('weightedRandom: `weights[1]` must be a finite number >= 0, got -1')],
				[Infinity, new RangeError('weightedRandom: `weights[1]` must be a finite number >= 0, got Infinity')],
				[NaN, new RangeError('weightedRandom: `weights[1]` must be a finite number >= 0, got NaN')],
				['x', new TypeError('weightedRandom: `weights[1]` must be a finite number >= 0, got string')]
			];
			for (const [weight, error] of cases) {
				expect(function () {
					helpers.weightedRandom(['a', 'b'], [2, weight as number], constant(0));
				}).toThrow(error);
			}
			expect(function () {
				helpers.weightedRandom(['a'], [1, 2]);
			}).toThrow(new RangeError('weightedRandom: `items` and `weights` must have the same length, got 1 and 2'));
			expect(function () {
				helpers.weightedRandom(['a', 'b'], [0, 0]);
			}).toThrow(new RangeError('weightedRandom: the total weight must be positive and finite, got 0'));
		});
	});

	describe('randomGaussian', function () {
		it('should guard against log(0) when random() returns 0', function () {
			expect(helpers.randomGaussian(5, 2, constant(0))).toBe(5);
			expect(Number.isFinite(helpers.randomGaussian(0, 1, constant(1 - Number.EPSILON / 2)))).toBe(true);
		});

		it('should apply the Box–Muller transform to the two draws', function () {
			const draws = [0.5, 0];
			// u1 = 1 - 0.5, u2 = 0: mean + stdDev * sqrt(-2 ln 0.5) * cos(0).
			expect(
				helpers.randomGaussian(10, 2, function () {
					return draws.shift() as number;
				})
			).toBeCloseTo(10 + 2 * Math.sqrt(2 * Math.LN2), 12);
		});

		it('should return the mean when stdDev is 0', function () {
			expect(helpers.randomGaussian(3, 0)).toBe(3);
		});

		it('should approximate the requested mean and standard deviation', function () {
			const rng = helpers.createRandom('gauss');
			const samples = Array.from({ length: 10_000 }, function () {
				return helpers.randomGaussian(100, 15, rng);
			});
			const mean =
				samples.reduce(function (a, b) {
					return a + b;
				}, 0) / samples.length;
			const variance =
				samples.reduce(function (a, b) {
					return a + (b - mean) ** 2;
				}, 0) / samples.length;
			expect(Math.abs(mean - 100)).toBeLessThan(0.5);
			expect(Math.abs(Math.sqrt(variance) - 15)).toBeLessThan(0.5);
			expect(Number.isFinite(helpers.randomGaussian())).toBe(true);
		});

		it('should throw on invalid parameters', function () {
			for (const [mean, stdDev] of [
				[NaN, 1],
				[Infinity, 1],
				[0, -1],
				[0, NaN],
				[0, Infinity]
			]) {
				expect(function () {
					helpers.randomGaussian(mean, stdDev);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.randomGaussian(0, 1, constant(-0.1));
			}).toThrow(new RangeError('randomGaussian: `random()` must return a number in [0, 1), got -0.1'));
			const secondDrawInvalid = [0.5, 1];
			expect(function () {
				helpers.randomGaussian(0, 1, function () {
					return secondDrawInvalid.shift() as number;
				});
			}).toThrow(new RangeError('randomGaussian: `random()` must return a number in [0, 1), got 1'));
			expect(function () {
				helpers.randomGaussian(NaN);
			}).toThrow(new RangeError('randomGaussian: `mean` must be a finite number, got NaN'));
			expect(function () {
				helpers.randomGaussian(0, -1);
			}).toThrow(new RangeError('randomGaussian: `stdDev` must be a finite number >= 0, got -1'));
		});
	});

	describe('randomBoolean', function () {
		it('should compare the draw against the probability', function () {
			expect(helpers.randomBoolean(0.5, constant(0.49))).toBe(true);
			expect(helpers.randomBoolean(0.5, constant(0.5))).toBe(false);
			expect(helpers.randomBoolean(0, constant(0))).toBe(false);
			expect(helpers.randomBoolean(1, constant(1 - Number.EPSILON / 2))).toBe(true);
			expect(typeof helpers.randomBoolean()).toBe('boolean');
		});

		it('should throw on invalid probabilities or generators', function () {
			for (const probability of [-0.1, 1.1, NaN]) {
				expect(function () {
					helpers.randomBoolean(probability);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.randomBoolean(0.5, constant(NaN));
			}).toThrow(new RangeError('randomBoolean: `random()` must return a number in [0, 1), got NaN'));
			expect(function () {
				helpers.randomBoolean(1.1);
			}).toThrow(new RangeError('randomBoolean: `probability` must be a number in [0, 1], got 1.1'));
		});
	});
	describe('secureRandom', function () {
		it('should return 53-bit floats in [0, 1) built from two crypto words', function () {
			// Every byte equal: the words are the same whatever the platform's endianness.
			expect(
				withCrypto(scriptedCrypto([new Array(1024).fill(0)]), function () {
					return helpers.secureRandom();
				})
			).toBe(0);
			expect(
				withCrypto(scriptedCrypto([new Array(1024).fill(0xff)]), function () {
					return helpers.secureRandom();
				})
			).toBe(1 - 2 ** -53);
			expect(
				withCrypto(scriptedCrypto([new Array(1024).fill(0x80)]), function () {
					return helpers.secureRandom();
				})
			).toBe(((0x80808080 >>> 5) * 2 ** 26 + (0x80808080 >>> 6)) / 2 ** 53);
		});

		it('should serve 128 values per crypto call, and refill when the buffer is exhausted or the crypto object changes', function () {
			const crypto = scriptedCrypto([new Array(1024).fill(1), new Array(1024).fill(2), new Array(1024).fill(3)]);
			withCrypto(crypto, function () {
				const first = helpers.secureRandom();
				for (let i = 1; i < 128; i++) expect(helpers.secureRandom()).toBe(first);
				expect(crypto.getRandomValues).toHaveBeenCalledTimes(1);
				expect(helpers.secureRandom()).not.toBe(first);
				expect(crypto.getRandomValues).toHaveBeenCalledTimes(2);
			});
			const other = scriptedCrypto([new Array(1024).fill(0)]);
			expect(
				withCrypto(other, function () {
					return helpers.secureRandom();
				})
			).toBe(0);
			expect(other.getRandomValues).toHaveBeenCalledTimes(1);
		});

		it('should use all 53 bits and be roughly uniform', function () {
			const values = Array.from({ length: 4000 }, helpers.secureRandom);
			for (const value of values) {
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThan(1);
			}
			expect(
				values.some(function (value) {
					return (value * 2 ** 53) % 2 === 1;
				})
			).toBe(true);
			const mean =
				values.reduce(function (total, value) {
					return total + value;
				}, 0) / values.length;
			expect(Math.abs(mean - 0.5)).toBeLessThan(0.05);
		});

		it('should be usable wherever a RandomGenerator is accepted', function () {
			expect(helpers.randomBoolean(1, helpers.secureRandom)).toBe(true);
			expect(helpers.weightedRandom(['a', 'b'], [0, 1], helpers.secureRandom)).toBe('b');
			expect(Number.isFinite(helpers.randomGaussian(0, 1, helpers.secureRandom))).toBe(true);
		});

		it('should throw when no cryptographically secure source is available, never falling back to Math.random', function () {
			for (const value of [undefined, null, {}]) {
				expect(function () {
					withCrypto(value, helpers.secureRandom);
				}).toThrow(new Error('secureRandom: no cryptographically secure random source is available (globalThis.crypto.getRandomValues is missing)'));
			}
		});
	});
});
