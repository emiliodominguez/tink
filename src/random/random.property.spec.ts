import fc from 'fast-check';
import * as helpers from '.';

const seed = fc.oneof(fc.string({ unit: 'binary' }), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }));
const safeInt = fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });

function take(rng: () => number, count: number): number[] {
	return Array.from({ length: count }, function () {
		return rng();
	});
}

/**
 * Reference unbiased sampler of an integer in [0, range) from raw 32-bit outputs (rejection sampling, as documented).
 */
function referenceBelow(next: () => number, range: number): number {
	if (range <= 2 ** 32) {
		const limit = 2 ** 32 - (2 ** 32 % range);
		for (;;) {
			const value = next();
			if (value < limit) return value % range;
		}
	}
	const limit = 2 ** 53 - (2 ** 53 % range);
	for (;;) {
		const value = Math.floor(next() / 2 ** 11) * 2 ** 32 + next();
		if (value < limit) return value % range;
	}
}

describe('Random helpers (property-based)', function () {
	describe('SeededRandom.int', function () {
		it('should equal a reference rejection sampler over the raw 32-bit stream, for every range size', function () {
			// Ranges just below / at / above powers of two maximize the rejection rate; 2 ** 32 and beyond use two outputs.
			const range = fc.oneof(
				fc.integer({ min: 1, max: 2 ** 32 }),
				fc.integer({ min: 0, max: 32 }).map(function (k) {
					return Math.min(2 ** 32, Math.floor(1.5 * 2 ** k));
				}),
				fc.constantFrom(2 ** 32, 2 ** 32 + 1, 3 * 2 ** 50, 2 ** 53),
				fc.integer({ min: 2 ** 32 + 1, max: 2 ** 53 })
			);
			fc.assert(
				fc.property(seed, range, fc.integer({ min: -(2 ** 40), max: 0 }), function (s, size, low) {
					const rng = helpers.createRandom(s);
					const reference = helpers.createRandom(s);
					function raw(): number {
						return reference() * 2 ** 32;
					}
					for (let i = 0; i < 5; i++) {
						expect(rng.int(low, low + size - 1)).toBe(low + referenceBelow(raw, size));
					}
					expect(rng.state()).toEqual(reference.state());
				})
			);
		});
	});

	describe('createRandom', function () {
		it('should always produce floats in [0, 1)', function () {
			fc.assert(
				fc.property(seed, function (s) {
					for (const value of take(helpers.createRandom(s), 50)) {
						expect(value).toBeGreaterThanOrEqual(0);
						expect(value).toBeLessThan(1);
					}
				})
			);
		});

		it('should produce the same sequence for the same seed', function () {
			fc.assert(
				fc.property(seed, function (s) {
					expect(take(helpers.createRandom(s), 20)).toEqual(take(helpers.createRandom(s), 20));
				})
			);
		});

		it('should produce different sequences for different seeds', function () {
			fc.assert(
				fc.property(fc.string(), fc.string(), function (a, b) {
					fc.pre(a !== b);
					expect(take(helpers.createRandom(a), 4)).not.toEqual(take(helpers.createRandom(b), 4));
				})
			);
		});

		it('should keep int(min, max) within the inclusive integer bounds for arbitrary ranges', function () {
			fc.assert(
				fc.property(seed, safeInt, safeInt, function (s, x, y) {
					const low = Math.min(x, y);
					const high = Math.max(x, y);
					fc.pre(high - low <= Number.MAX_SAFE_INTEGER);
					const rng = helpers.createRandom(s);
					for (let i = 0; i < 10; i++) {
						const value = rng.int(low, high);
						expect(Number.isInteger(value)).toBe(true);
						expect(value).toBeGreaterThanOrEqual(low);
						expect(value).toBeLessThanOrEqual(high);
					}
				})
			);
		});

		it('should hit every value of a small range', function () {
			fc.assert(
				fc.property(seed, fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 7 }), function (s, low, width) {
					const rng = helpers.createRandom(s);
					const seen = new Set<number>();
					for (let i = 0; i < 400; i++) seen.add(rng.int(low, low + width));
					expect(seen.size).toBe(width + 1);
				})
			);
		});

		it('should shuffle into a permutation of the input', function () {
			fc.assert(
				fc.property(seed, fc.array(fc.integer()), function (s, array) {
					const shuffled = helpers.createRandom(s).shuffle(array);
					function byValue(a: number, b: number): number {
						return a - b;
					}
					expect([...shuffled].sort(byValue)).toEqual([...array].sort(byValue));
				})
			);
		});

		it('should fork child streams that differ from the parent and replay deterministically', function () {
			fc.assert(
				fc.property(seed, function (s) {
					const parent = helpers.createRandom(s);
					const child = parent.fork();
					const childValues = take(child, 8);
					expect(childValues).not.toEqual(take(parent, 8));
					expect(take(helpers.createRandom(s).fork(), 8)).toEqual(childValues);
				})
			);
		});

		it('should round-trip state() through restore()', function () {
			fc.assert(
				fc.property(seed, fc.nat({ max: 50 }), function (s, skip) {
					const rng = helpers.createRandom(s);
					take(rng, skip);
					const snapshot = rng.state();
					const expected = take(rng, 10);
					const other = helpers.createRandom('unrelated');
					other.restore(snapshot);
					expect(take(other, 10)).toEqual(expected);
				})
			);
		});
	});

	describe('weightedRandom', function () {
		it('should never return a zero-weight item', function () {
			const weighted = fc.array(fc.oneof(fc.constant(0), fc.double({ min: 0, max: 1e6, noNaN: true })), { minLength: 1, maxLength: 20 });
			fc.assert(
				fc.property(weighted, fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), function (weights, r) {
					fc.pre(
						weights.some(function (w) {
							return w > 0;
						})
					);
					const items = weights.map(function (_, i) {
						return i;
					});
					const index = helpers.weightedRandom(items, weights, function () {
						return r;
					});
					expect(weights[index]).toBeGreaterThan(0);
				})
			);
		});

		it('should be monotone in the uniform draw (larger draws never pick earlier items)', function () {
			fc.assert(
				fc.property(
					fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 20 }),
					fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
					fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
					function (weights, a, b) {
						fc.pre(
							weights.some(function (w) {
								return w > 0;
							})
						);
						const items = weights.map(function (_, i) {
							return i;
						});
						function pick(r: number): number {
							return helpers.weightedRandom(items, weights, function () {
								return r;
							});
						}
						expect(pick(Math.min(a, b))).toBeLessThanOrEqual(pick(Math.max(a, b)));
					}
				)
			);
		});
	});

	describe('randomBoolean / randomGaussian', function () {
		it('should return true exactly when the draw is below the probability', function () {
			const unit = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });
			fc.assert(
				fc.property(fc.double({ min: 0, max: 1, noNaN: true }), unit, function (p, r) {
					expect(
						helpers.randomBoolean(p, function () {
							return r;
						})
					).toBe(r < p);
				})
			);
		});

		it('should scale and shift a standard normal sample', function () {
			fc.assert(
				fc.property(seed, fc.double({ min: -1e3, max: 1e3, noNaN: true }), fc.double({ min: 0, max: 1e3, noNaN: true }), function (s, mean, stdDev) {
					const z = helpers.randomGaussian(0, 1, helpers.createRandom(s));
					const x = helpers.randomGaussian(mean, stdDev, helpers.createRandom(s));
					expect(Number.isFinite(x)).toBe(true);
					expect(x).toBeCloseTo(mean + stdDev * z, 6);
				})
			);
		});
	});

	describe('randomId', function () {
		it('should have the requested length and only use characters of the alphabet', function () {
			const alphabet = fc.uniqueArray(fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }), { minLength: 2, maxLength: 95 });
			fc.assert(
				fc.property(alphabet, fc.nat({ max: 64 }), function (chars, size) {
					const id = helpers.randomId(size, chars.join(''));
					const allowed = new Set(chars);
					expect(Array.from(id)).toHaveLength(size);
					for (const char of id) expect(allowed.has(char)).toBe(true);
				})
			);
		});

		it('should support arbitrary code-point alphabets up to 256 characters', function () {
			const alphabet = fc.uniqueArray(fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }), { minLength: 2, maxLength: 256 });
			fc.assert(
				fc.property(alphabet, fc.nat({ max: 32 }), function (chars, size) {
					// Adjacent lone surrogates could merge into a single code point once joined.
					fc.pre(Array.from(chars.join('')).length === chars.length);
					const id = helpers.randomId(size, chars.join(''));
					const codePoints = Array.from(id);
					expect(codePoints).toHaveLength(size);
					for (const char of codePoints) expect(chars).toContain(char);
				})
			);
		});
	});

	describe('randomBytes', function () {
		it('should return exactly the requested number of bytes', function () {
			fc.assert(
				fc.property(fc.nat({ max: 70_000 }), function (length) {
					expect(helpers.randomBytes(length)).toHaveLength(length);
				}),
				{ numRuns: 30 }
			);
		});
	});
});

describe('Time-ordered ids (property-based)', function () {
	const time = fc.integer({ min: 0, max: 2 ** 48 - 1 });
	/** Clock readings: arbitrary jumps (backwards included) and runs of identical milliseconds. */
	const readings = fc.array(fc.oneof(time, fc.integer({ min: 1_700_000_000_000, max: 1_700_000_000_005 })), { minLength: 1, maxLength: 30 });
	const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

	function clockOf(times: number[]): () => number {
		let call = 0;
		return function () {
			return times[call++];
		};
	}

	/** Reference ULID decoder: the 26 base32 digits as one 130-bit integer. */
	function ulidValue(id: string): bigint {
		let value = 0n;
		for (const character of id) value = value * 32n + BigInt(CROCKFORD.indexOf(character.toUpperCase()));
		return value;
	}

	/** The 42-bit counter of a version 7 UUID (rand_a, then the top 30 bits of rand_b). */
	function counterOf(id: string): number {
		const hex = id.replace(/-/g, '');
		return (parseInt(hex.slice(13, 16), 16) & 0xfff) * 2 ** 30 + (parseInt(hex.slice(16, 24), 16) & 0x3fffffff);
	}

	it('uuidv7: strictly increasing, embedding the running maximum of the clock, the counter stepping by one within a millisecond', function () {
		fc.assert(
			fc.property(readings, seed, function (times, s) {
				const next = helpers.createUuidv7({ now: clockOf(times), random: helpers.createRandom(s) });
				let maximum = -1;
				let previous = '';
				for (const reading of times) {
					const id = next();
					expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
					expect(id > previous).toBe(true);
					const stamp = helpers.uuidv7Timestamp(id);
					// A 42-bit counter seeded at random practically never rolls over in 30 ids.
					if (reading <= maximum) {
						expect(stamp).toBe(maximum);
						expect(counterOf(id)).toBe(counterOf(previous) + 1);
					}
					maximum = Math.max(maximum, reading);
					expect(stamp).toBe(maximum);
					previous = id;
				}
			})
		);
	});

	it('ulid: strictly increasing, embedding the running maximum of the clock, the random part stepping by one within a millisecond', function () {
		fc.assert(
			fc.property(readings, seed, function (times, s) {
				const next = helpers.createUlid({ now: clockOf(times), random: helpers.createRandom(s) });
				let maximum = -1;
				let previous = '';
				for (const reading of times) {
					const id = next();
					expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
					expect(id > previous).toBe(true);
					if (reading <= maximum) expect(ulidValue(id)).toBe(ulidValue(previous) + 1n);
					maximum = Math.max(maximum, reading);
					expect(helpers.ulidTimestamp(id)).toBe(maximum);
					expect(ulidValue(id) >> 80n).toBe(BigInt(maximum));
					previous = id;
				}
			})
		);
	});

	it('should be reproducible: the same clock and seed give the same ids', function () {
		fc.assert(
			fc.property(readings, seed, function (times, s) {
				const a = helpers.createUlid({ now: clockOf(times), random: helpers.createRandom(s) });
				const b = helpers.createUlid({ now: clockOf(times), random: helpers.createRandom(s) });
				const c = helpers.createUuidv7({ now: clockOf(times), random: helpers.createRandom(s) });
				const d = helpers.createUuidv7({ now: clockOf(times), random: helpers.createRandom(s) });
				for (let i = 0; i < times.length; i++) {
					expect(a()).toBe(b());
					expect(c()).toBe(d());
				}
			})
		);
	});

	it('uuidv7Timestamp and ulidTimestamp should read any valid id like a reference decoder, in either letter case', function () {
		const hex = fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 32, maxLength: 32 });
		fc.assert(
			fc.property(hex, fc.constantFrom('8', '9', 'a', 'b'), fc.boolean(), function (digits, variant, upper) {
				const id = `${digits.slice(0, 8)}-${digits.slice(8, 12)}-7${digits.slice(13, 16)}-${variant}${digits.slice(17, 20)}-${digits.slice(20)}`;
				expect(helpers.uuidv7Timestamp(upper ? id.toUpperCase() : id)).toBe(Number(BigInt(`0x${digits.slice(0, 12)}`)));
			})
		);
		const base32 = fc.string({ unit: fc.constantFrom(...CROCKFORD), minLength: 25, maxLength: 25 });
		fc.assert(
			fc.property(fc.constantFrom(...'01234567'), base32, fc.boolean(), function (first, rest, lower) {
				const id = first + rest;
				expect(helpers.ulidTimestamp(lower ? id.toLowerCase() : id)).toBe(Number(ulidValue(id) >> 80n));
			})
		);
	});
});
