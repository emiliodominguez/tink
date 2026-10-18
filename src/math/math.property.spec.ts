import fc from 'fast-check';
import * as helpers from '.';

const smallInt = fc.integer({ min: -1_000_000, max: 1_000_000 });
const intArray = fc.array(smallInt, { maxLength: 100 });
const finiteDouble = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
const finiteArray = fc.array(finiteDouble, { minLength: 1, maxLength: 50 });
const unit = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

function naiveIsPrime(n: number): boolean {
	if (n < 2) return false;
	for (let i = 2; i < n; i++) {
		if (n % i === 0) return false;
	}
	return true;
}

/** The previous `isPrime`: 6k ± 1 trial division up to √n (slow near 2 ** 53, exact everywhere). */
function trialDivisionIsPrime(n: number): boolean {
	if (!Number.isInteger(n) || n < 2) return false;
	if (n < 4) return true;
	if (n % 2 === 0 || n % 3 === 0) return false;
	for (let i = 5; i * i <= n; i += 6) {
		if (n % i === 0 || n % (i + 2) === 0) return false;
	}
	return true;
}

describe('Math helpers (property-based)', function () {
	describe('sum', function () {
		it('should equal the naive reduce on integer arrays', function () {
			fc.assert(
				fc.property(intArray, function (numbers) {
					const reference = numbers.reduce(function (a, b) {
						return a + b;
					}, 0);
					expect(helpers.sum(numbers)).toBe(reference);
				})
			);
		});

		it('should be invariant under permutation of integer arrays', function () {
			fc.assert(
				fc.property(
					intArray.chain(function (numbers) {
						return fc.tuple(fc.constant(numbers), fc.shuffledSubarray(numbers, { minLength: numbers.length, maxLength: numbers.length }));
					}),
					function ([numbers, shuffled]) {
						expect(helpers.sum(shuffled)).toBe(helpers.sum(numbers));
					}
				)
			);
		});
	});

	describe('round', function () {
		const decimals = fc.integer({ min: 0, max: 6 });

		it('should be idempotent (result has at most `decimals` fractional digits)', function () {
			fc.assert(
				fc.property(finiteDouble, decimals, function (x, d) {
					const once = helpers.round(x, d);
					expect(helpers.round(once, d)).toBe(once);
				})
			);
		});

		it('should stay within half a unit of the last kept decimal', function () {
			fc.assert(
				fc.property(finiteDouble, decimals, function (x, d) {
					const tolerance = 0.5 * 10 ** -d + 4 * Number.EPSILON * Math.max(1, Math.abs(x));
					expect(Math.abs(helpers.round(x, d) - x)).toBeLessThanOrEqual(tolerance);
				})
			);
		});

		it('should equal the decimal-string reference algorithm, ties and binary-inexact decimals included', function () {
			// Reference: shift the decimal point in the string representation, round, shift back (no binary multiplication).
			function shift(value: number, exponent: number): number {
				const [mantissa, current = '0'] = String(value).split('e');
				return Number(`${mantissa}e${Number(current) + exponent}`);
			}
			function reference(x: number, d: number): number {
				const shifted = shift(Math.abs(x), d);
				if (!Number.isFinite(shifted)) return x;
				const rounded = shift(Math.round(shifted), -d);
				return x < 0 || Object.is(x, -0) ? -rounded : rounded;
			}
			// Decimal literals such as 1.005 or 2.675 (k * 10^-e), half-way values, and arbitrary doubles of every magnitude.
			const decimalLiteral = fc.tuple(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 0, max: 12 })).map(function ([k, e]) {
				return Number(`${k}e-${e}`);
			});
			const anyDouble = fc.double({ noNaN: true, noDefaultInfinity: true });
			fc.assert(
				fc.property(fc.oneof(decimalLiteral, anyDouble, finiteDouble), fc.integer({ min: -25, max: 25 }), function (x, d) {
					expect(helpers.round(x, d)).toBe(reference(x, d));
					const tie = x + 5 * 10 ** -(d + 1);
					expect(helpers.round(tie, d)).toBe(reference(tie, d));
				}),
				{ numRuns: 2000 }
			);
		});

		it('should be symmetric: round(-x, d) === -round(x, d)', function () {
			fc.assert(
				fc.property(finiteDouble, fc.integer({ min: -3, max: 6 }), function (x, d) {
					expect(helpers.round(-x, d)).toBe(-helpers.round(x, d));
				})
			);
		});
	});

	describe('max / min', function () {
		it('should be bounds of the input and contained in it', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					const largest = helpers.max(numbers);
					const smallest = helpers.min(numbers);
					for (const value of numbers) {
						expect(largest).toBeGreaterThanOrEqual(value);
						expect(smallest).toBeLessThanOrEqual(value);
					}
					expect(numbers).toContain(largest);
					expect(numbers).toContain(smallest);
				})
			);
		});

		it('should agree with Math.max / Math.min', function () {
			fc.assert(
				fc.property(fc.array(fc.double()), function (numbers) {
					expect(helpers.max(numbers)).toBe(Math.max(...numbers));
					expect(helpers.min(numbers)).toBe(Math.min(...numbers));
				})
			);
		});
	});

	describe('factorial', function () {
		it('should satisfy (n + 1)! === (n + 1) * n!', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 20 }), function (n) {
					expect(helpers.factorial(n + 1)).toBe((n + 1) * helpers.factorial(n));
				})
			);
		});
	});

	describe('modulo', function () {
		const positiveDivisor = fc.integer({ min: 1, max: 1000 });
		const nonZeroDivisor = fc.integer({ min: -1000, max: 1000 }).filter(function (d) {
			return d !== 0;
		});

		it('should return a result in [0, d) for a positive divisor', function () {
			fc.assert(
				fc.property(smallInt, positiveDivisor, function (a, d) {
					const result = helpers.modulo(a, d);
					expect(result).toBeGreaterThanOrEqual(0);
					expect(result).toBeLessThan(d);
				})
			);
		});

		it('should be congruent to the dividend and carry the sign of the divisor', function () {
			fc.assert(
				fc.property(smallInt, nonZeroDivisor, function (a, d) {
					const result = helpers.modulo(a, d);
					expect((a - result) % d === 0).toBe(true);
					expect(Math.abs(result)).toBeLessThan(Math.abs(d));
					expect(result === 0 || Math.sign(result) === Math.sign(d)).toBe(true);
				})
			);
		});
	});

	describe('randomBetween / randomIntBetween', function () {
		it('randomIntBetween should return an integer in [ceil(min), floor(max)]', function () {
			fc.assert(
				fc.property(finiteDouble, fc.double({ min: 0, max: 1000, noNaN: true }), unit, function (start, width, r) {
					const end = start + width;
					fc.pre(Math.ceil(start) <= Math.floor(end));
					const value = helpers.randomIntBetween(start, end, function () {
						return r;
					});
					expect(Number.isInteger(value)).toBe(true);
					expect(value).toBeGreaterThanOrEqual(Math.ceil(start));
					expect(value).toBeLessThanOrEqual(Math.floor(end));
				})
			);
		});

		it('randomBetween should return a number in [min, max)', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, unit, function (a, b, r) {
					fc.pre(a !== b);
					const low = Math.min(a, b);
					const high = Math.max(a, b);
					const value = helpers.randomBetween(low, high, function () {
						return r;
					});
					expect(value).toBeGreaterThanOrEqual(low);
					expect(value).toBeLessThan(high);
				})
			);
		});
	});

	describe('clamp', function () {
		it('should be within bounds and idempotent', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, finiteDouble, function (value, a, b) {
					const low = Math.min(a, b);
					const high = Math.max(a, b);
					const once = helpers.clamp(value, low, high);
					expect(once).toBeGreaterThanOrEqual(low);
					expect(once).toBeLessThanOrEqual(high);
					expect(helpers.clamp(once, low, high)).toBe(once);
					if (value >= low && value <= high) expect(once).toBe(value);
				})
			);
		});
	});

	describe('lerp / inverseLerp', function () {
		it('should hit the endpoints exactly for integers', function () {
			fc.assert(
				fc.property(smallInt, smallInt, function (a, b) {
					expect(helpers.lerp(a, b, 0)).toBe(a);
					expect(helpers.lerp(a, b, 1)).toBe(b);
				})
			);
		});

		it('inverseLerp should invert lerp', function () {
			fc.assert(
				fc.property(smallInt, smallInt, fc.double({ min: 0, max: 1, noNaN: true }), function (a, b, t) {
					fc.pre(a !== b);
					expect(Math.abs(helpers.inverseLerp(a, b, helpers.lerp(a, b, t)) - t)).toBeLessThan(1e-6);
				})
			);
		});
	});

	describe('gcd / lcm', function () {
		const mediumInt = fc.integer({ min: -100_000, max: 100_000 });

		it('gcd should divide both arguments and be commutative', function () {
			fc.assert(
				fc.property(mediumInt, mediumInt, function (a, b) {
					const divisor = helpers.gcd(a, b);
					expect(divisor).toBeGreaterThanOrEqual(0);
					expect(helpers.gcd(b, a)).toBe(divisor);
					if (divisor !== 0) {
						expect(Math.abs(a % divisor)).toBe(0);
						expect(Math.abs(b % divisor)).toBe(0);
					} else {
						expect(a).toBe(0);
						expect(b).toBe(0);
					}
				})
			);
		});

		it('gcd(a, b) * lcm(a, b) should equal |a * b|', function () {
			const tinyInt = fc.integer({ min: -10_000, max: 10_000 });
			fc.assert(
				fc.property(tinyInt, tinyInt, function (a, b) {
					expect(helpers.gcd(a, b) * helpers.lcm(a, b)).toBe(Math.abs(a * b));
				})
			);
		});
	});

	describe('median', function () {
		it('should lie between min and max and not mutate the input', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					const copy = numbers.slice();
					const middle = helpers.median(numbers);
					expect(middle).toBeGreaterThanOrEqual(helpers.min(numbers));
					expect(middle).toBeLessThanOrEqual(helpers.max(numbers));
					expect(numbers).toEqual(copy);
				})
			);
		});
	});

	describe('median / quantile with signed zeros', function () {
		it('should not depend on the input order, even for the sign of a zero result', function () {
			const signedArray = fc.array(fc.constantFrom(0, -0, 1, -1), { minLength: 1, maxLength: 9 });
			fc.assert(
				fc.property(
					signedArray.chain(function (numbers) {
						return fc.tuple(fc.constant(numbers), fc.shuffledSubarray(numbers, { minLength: numbers.length, maxLength: numbers.length }));
					}),
					function ([numbers, shuffled]) {
						expect(Object.is(helpers.median(shuffled), helpers.median(numbers))).toBe(true);
						expect(Object.is(helpers.quantile(shuffled, 0.25), helpers.quantile(numbers, 0.25))).toBe(true);
					}
				)
			);
		});
	});

	describe('quantile interpolation', function () {
		it('should equal the type-7 formula x[j] + g * (x[j + 1] - x[j]) for finite inputs', function () {
			fc.assert(
				fc.property(finiteArray, unit, function (numbers, q) {
					const sorted = numbers.slice().sort(function (a, b) {
						return a - b;
					});
					const h = (sorted.length - 1) * q;
					const j = Math.floor(h);
					const low = sorted[j];
					const high = sorted[Math.min(j + 1, sorted.length - 1)];
					const expected = h === j || low === high ? low : Math.min(low + (h - j) * (high - low), high);
					// `===`: the sign of a zero result is covered separately (the reference sort leaves -0 and 0 in input order).
					expect(helpers.quantile(numbers, q) === expected).toBe(true);
				})
			);
		});

		it('should return the smallest value, with its sign, at q = 0', function () {
			expect(helpers.quantile([-0, 1], 0)).toBe(-0);
			expect(helpers.quantile([1, -0, 2], 0)).toBe(-0);
		});
	});

	describe('log / nthRoot special cases', function () {
		const positive = fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true });

		it('log should use Math.log10 / Math.log2 / Math.log for bases 10, 2 and e', function () {
			fc.assert(
				fc.property(positive, function (x) {
					expect(helpers.log(x, 10)).toBe(Math.log10(x));
					expect(helpers.log(x, 2)).toBe(Math.log2(x));
					expect(helpers.log(x, Math.E)).toBe(Math.log(x));
				})
			);
		});

		it('nthRoot should use Math.sqrt / Math.cbrt for n = 2 / n = 3', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true }), function (x) {
					expect(helpers.nthRoot(x, 2)).toBe(Math.sqrt(x));
					expect(helpers.nthRoot(x, 3)).toBe(Math.cbrt(x));
				})
			);
		});
	});

	describe('mode', function () {
		it('should return sorted values that all occur with the highest frequency', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 40 }), function (numbers) {
					const result = helpers.mode(numbers);
					function count(value: number) {
						return numbers.filter(function (n) {
							return n === value;
						}).length;
					}
					const highest = Math.max(0, ...numbers.map(count));
					const expected = Array.from(new Set(numbers))
						.filter(function (value) {
							return count(value) === highest;
						})
						.sort(function (a, b) {
							return a - b;
						});
					expect(result).toEqual(expected);
				})
			);
		});
	});

	describe('variance', function () {
		it('should be non-negative', function () {
			fc.assert(
				fc.property(finiteArray, fc.boolean(), function (numbers, sample) {
					fc.pre(!sample || numbers.length > 1);
					expect(helpers.variance(numbers, { sample })).toBeGreaterThanOrEqual(0);
				})
			);
		});

		it('should be 0 for a constant array', function () {
			fc.assert(
				fc.property(finiteDouble, fc.integer({ min: 1, max: 50 }), function (value, length) {
					expect(helpers.variance(new Array(length).fill(value))).toBe(0);
					expect(helpers.standardDeviation(new Array(length).fill(value))).toBe(0);
				})
			);
		});
	});

	describe('isPrime', function () {
		it('should agree with a naive reference below 10 000', function () {
			fc.assert(
				fc.property(fc.integer({ min: -10, max: 9_999 }), function (n) {
					expect(helpers.isPrime(n)).toBe(naiveIsPrime(n));
				})
			);
		});

		it('should agree with a naive reference on every n < 2000', function () {
			for (let n = 0; n < 2000; n++) {
				expect(helpers.isPrime(n)).toBe(naiveIsPrime(n));
			}
		});

		it('should agree with 6k ± 1 trial division on random integers below 2 ** 42', function () {
			fc.assert(
				fc.property(fc.bigInt({ min: 0n, max: 2n ** 42n }), function (big) {
					const n = Number(big);
					expect(helpers.isPrime(n)).toBe(trialDivisionIsPrime(n));
				}),
				{ numRuns: 2000 }
			);
		});

		it('should agree with 6k ± 1 trial division on odd integers just past the trial-division cut-off', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1_050_000 / 2, max: 2 ** 29 }), function (half) {
					const n = 2 * half + 1;
					expect(helpers.isPrime(n)).toBe(trialDivisionIsPrime(n));
				}),
				{ numRuns: 2000 }
			);
		});

		it('should never call a product of two integers >= 2 a prime, up to 2 ** 53', function () {
			const factor = fc.integer({ min: 2, max: 94_906_265 });
			fc.assert(
				fc.property(factor, factor, function (a, b) {
					expect(helpers.isPrime(a * b)).toBe(false);
				}),
				{ numRuns: 2000 }
			);
		});
	});

	describe('isEven / isOdd', function () {
		it('should be exclusive for integers', function () {
			fc.assert(
				fc.property(fc.integer(), function (n) {
					expect(helpers.isEven(n) !== helpers.isOdd(n)).toBe(true);
				})
			);
		});

		it('should both be false for non-integers', function () {
			fc.assert(
				fc.property(
					fc.double().filter(function (x) {
						return !Number.isInteger(x);
					}),
					function (x) {
						expect(helpers.isEven(x) || helpers.isOdd(x)).toBe(false);
					}
				)
			);
		});
	});

	describe('regressions (round 2 bug hunt)', function () {
		it('modulo should stay in [0, d) for any finite double dividend', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer({ min: 1, max: 1000 }), function (a, d) {
					const result = helpers.modulo(a, d);
					expect(result).toBeGreaterThanOrEqual(0);
					expect(result).toBeLessThan(d);
				})
			);
		});

		it('lerp(a, a, t) should be a for any finite t', function () {
			fc.assert(
				fc.property(finiteDouble, fc.double({ noNaN: true, noDefaultInfinity: true }), function (a, t) {
					expect(helpers.lerp(a, a, t)).toBe(a);
				})
			);
		});

		it('median of a constant array should be that constant', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true }), fc.integer({ min: 1, max: 10 }), function (value, length) {
					expect(helpers.median(new Array(length).fill(value))).toBe(value === 0 ? helpers.median([value]) : value);
				})
			);
		});

		it('variance of finite numbers should never be negative or NaN', function () {
			fc.assert(
				fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 20 }), function (numbers) {
					expect(helpers.variance(numbers)).toBeGreaterThanOrEqual(0);
				})
			);
		});

		it('log should return exactly k for base ** k', function () {
			fc.assert(
				fc.property(fc.integer({ min: 2, max: 20 }), fc.integer({ min: -10, max: 10 }), function (base, k) {
					const value = base ** k;
					fc.pre(Math.pow(base, k) === value);
					expect(helpers.log(value, base)).toBe(k);
				})
			);
		});
	});

	describe('quantile / percentile', function () {
		const q = fc.double({ min: 0, max: 1, noNaN: true });

		it('should be monotonic in q', function () {
			fc.assert(
				fc.property(finiteArray, q, q, function (numbers, q1, q2) {
					const [low, high] = q1 <= q2 ? [q1, q2] : [q2, q1];
					expect(helpers.quantile(numbers, low)).toBeLessThanOrEqual(helpers.quantile(numbers, high));
				})
			);
		});

		it('should give min at q = 0, max at q = 1 and stay within [min, max]', function () {
			fc.assert(
				fc.property(finiteArray, q, function (numbers, value) {
					const result = helpers.quantile(numbers, value);
					expect(helpers.quantile(numbers, 0)).toBe(helpers.min(numbers));
					expect(helpers.quantile(numbers, 1)).toBe(helpers.max(numbers));
					expect(result).toBeGreaterThanOrEqual(helpers.min(numbers));
					expect(result).toBeLessThanOrEqual(helpers.max(numbers));
				})
			);
		});

		it('should equal median at q = 0.5 (within rounding)', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					expect(helpers.quantile(numbers, 0.5)).toBeCloseTo(helpers.median(numbers), 6);
				})
			);
		});

		it('should be order-independent', function () {
			fc.assert(
				fc.property(
					finiteArray.chain(function (numbers) {
						return fc.tuple(fc.constant(numbers), fc.shuffledSubarray(numbers, { minLength: numbers.length, maxLength: numbers.length }), q);
					}),
					function ([numbers, shuffled, value]) {
						expect(helpers.quantile(shuffled, value)).toBe(helpers.quantile(numbers, value));
					}
				)
			);
		});

		it('percentile(p) should equal quantile(p / 100)', function () {
			fc.assert(
				fc.property(finiteArray, fc.double({ min: 0, max: 100, noNaN: true }), function (numbers, p) {
					expect(helpers.percentile(numbers, p)).toBe(helpers.quantile(numbers, p / 100));
				})
			);
		});
	});

	describe('cumulativeSum', function () {
		it('should preserve length and end with sum', function () {
			fc.assert(
				fc.property(fc.array(finiteDouble, { maxLength: 50 }), function (numbers) {
					const result = helpers.cumulativeSum(numbers);
					expect(result).toHaveLength(numbers.length);
					if (numbers.length > 0) expect(result[result.length - 1]).toBe(helpers.sum(numbers));
				})
			);
		});

		it('should equal the sum of each prefix', function () {
			fc.assert(
				fc.property(intArray, function (numbers) {
					const result = helpers.cumulativeSum(numbers);
					result.forEach(function (value, index) {
						expect(value).toBe(helpers.sum(numbers.slice(0, index + 1)));
					});
				})
			);
		});
	});

	describe('approximatelyEqual', function () {
		const anyDouble = fc.double();
		const tolerance = fc.double({ min: 0, max: 1, noNaN: true });

		it('should be reflexive for non-NaN values and never true for NaN', function () {
			fc.assert(
				fc.property(anyDouble, function (value) {
					expect(helpers.approximatelyEqual(value, value)).toBe(!Number.isNaN(value));
				})
			);
		});

		it('should be symmetric', function () {
			fc.assert(
				fc.property(anyDouble, anyDouble, tolerance, tolerance, function (a, b, relative, absolute) {
					expect(helpers.approximatelyEqual(a, b, { relative, absolute })).toBe(helpers.approximatelyEqual(b, a, { relative, absolute }));
				})
			);
		});

		it('should match the math.isclose reference formula for finite values', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, tolerance, tolerance, function (a, b, relative, absolute) {
					const reference = Math.abs(a - b) <= Math.max(relative * Math.max(Math.abs(a), Math.abs(b)), absolute);
					expect(helpers.approximatelyEqual(a, b, { relative, absolute })).toBe(reference);
				})
			);
		});
	});

	describe('weightedAverage', function () {
		it('should equal average with equal weights', function () {
			fc.assert(
				fc.property(fc.array(smallInt, { minLength: 1, maxLength: 50 }), fc.integer({ min: 1, max: 1000 }), function (values, weight) {
					const weights = values.map(function () {
						return weight;
					});
					expect(helpers.weightedAverage(values, weights)).toBe(helpers.average(values));
				})
			);
		});

		it('should lie between the smallest and largest value with positive weight', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(finiteDouble, fc.double({ min: 0, max: 100, noNaN: true })), { minLength: 1, maxLength: 30 }), function (pairs) {
					const values = pairs.map(function (pair) {
						return pair[0];
					});
					const weights = pairs.map(function (pair) {
						return pair[1];
					});
					const used = values.filter(function (_value, index) {
						return weights[index] > 0;
					});
					fc.pre(used.length > 0);
					const result = helpers.weightedAverage(values, weights);
					const slack = 1e-9 * Math.max(1, Math.abs(helpers.max(used)), Math.abs(helpers.min(used)));
					expect(result).toBeGreaterThanOrEqual(helpers.min(used) - slack);
					expect(result).toBeLessThanOrEqual(helpers.max(used) + slack);
				})
			);
		});
	});

	describe('normalize', function () {
		it('should output values in [0, 1] with the extremes at 0 and 1, preserving order', function () {
			fc.assert(
				fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 30 }), function (numbers) {
					const result = helpers.normalize(numbers);
					expect(result).toHaveLength(numbers.length);
					const allEqual = helpers.min(numbers) === helpers.max(numbers);
					for (let i = 0; i < numbers.length; i++) {
						expect(result[i]).toBeGreaterThanOrEqual(0);
						expect(result[i]).toBeLessThanOrEqual(1);
						if (!allEqual && numbers[i] === helpers.min(numbers)) expect(result[i]).toBe(0);
						if (!allEqual && numbers[i] === helpers.max(numbers)) expect(result[i]).toBe(1);
						for (let j = 0; j < numbers.length; j++) {
							if (numbers[i] < numbers[j]) expect(result[i]).toBeLessThanOrEqual(result[j]);
						}
					}
				})
			);
		});
	});

	describe('formatBytes', function () {
		it('should use a mantissa below the base (except in the largest unit) and keep the sign', function () {
			fc.assert(
				fc.property(
					fc.double({ min: -1e20, max: 1e20, noNaN: true }),
					fc.constantFrom<1000 | 1024>(1000, 1024),
					fc.integer({ min: 0, max: 4 }),
					function (bytes, base, decimals) {
						const text = helpers.formatBytes(bytes, { base, decimals });
						const match = /^(-?\d+(?:\.\d+)?) ([kKMGTPEZY]?i?B)$/.exec(text);
						expect(match).not.toBeNull();
						const mantissa = Number((match as RegExpExecArray)[1]);
						expect(Math.abs(mantissa)).toBeLessThan(base);
						expect(((match as RegExpExecArray)[1].split('.')[1] ?? '').length).toBeLessThanOrEqual(decimals);
						if (mantissa !== 0) expect(Math.sign(mantissa)).toBe(Math.sign(bytes));
					}
				)
			);
		});

		it('should be within rounding of the input when parsed back', function () {
			const factors: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, EB: 1e18 };
			fc.assert(
				fc.property(fc.double({ min: 1, max: 1e18, noNaN: true }), function (bytes) {
					const [mantissa, unitName] = helpers.formatBytes(bytes, { decimals: 3 }).split(' ');
					const parsed = Number(mantissa) * factors[unitName];
					expect(Math.abs(parsed - bytes)).toBeLessThanOrEqual(0.0005 * factors[unitName] * (1 + 1e-9));
				})
			);
		});
	});

	describe('ordinal', function () {
		function referenceSuffix(n: number): string {
			const abs = Math.abs(n);
			if (abs % 100 >= 11 && abs % 100 <= 13) return 'th';
			return ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][abs % 10];
		}

		it('should match the reference suffix rule and keep the digits', function () {
			fc.assert(
				fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), function (n) {
					expect(helpers.ordinal(n)).toBe(`${n}${referenceSuffix(n)}`);
				})
			);
		});
	});

	describe('nthRoot', function () {
		it('nthRoot(x, n) ** n should approximate x', function () {
			fc.assert(
				fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.integer({ min: 1, max: 12 }), function (x, n) {
					const root = helpers.nthRoot(x, n);
					if (x < 0 && n % 2 === 0) {
						expect(root).toBeNaN();
					} else {
						expect(Math.abs(root ** n - x)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(x)) * n);
						expect(Math.sign(root)).toBe(Math.sign(x));
					}
				})
			);
		});

		it('should be exact for perfect integer powers', function () {
			fc.assert(
				fc.property(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 1, max: 9 }), function (k, n) {
					fc.pre(k >= 0 || n % 2 === 1);
					fc.pre(Number.isSafeInteger(k ** n));
					expect(helpers.nthRoot(k ** n, n)).toBe(k);
				})
			);
		});
	});

	describe('roundToStep', function () {
		const step = fc.constantFrom(0.01, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 1 / 3, 0.125);

		it('should return a multiple of step within step / 2 of the input', function () {
			fc.assert(
				fc.property(finiteDouble, step, function (value, size) {
					const result = helpers.roundToStep(value, size);
					const multiple = result / size;
					expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(1e-6);
					expect(Math.abs(result - value)).toBeLessThanOrEqual(size / 2 + 1e-9);
				})
			);
		});

		it('should be idempotent', function () {
			fc.assert(
				fc.property(finiteDouble, step, function (value, size) {
					const once = helpers.roundToStep(value, size);
					expect(helpers.roundToStep(once, size)).toBe(once);
				})
			);
		});

		it('should agree with round() for decimal steps', function () {
			fc.assert(
				fc.property(finiteDouble, fc.integer({ min: 0, max: 4 }), function (value, decimals) {
					expect(helpers.roundToStep(value, Number(`1e-${decimals}`))).toBe(helpers.round(value, decimals));
				})
			);
		});

		it('should leave decimal multiples of a power-of-ten step unchanged, including steps written in exponent notation', function () {
			fc.assert(
				fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: 0, max: 15 }), function (k, decimals) {
					const multiple = Number(`${k}e-${decimals}`);
					expect(helpers.roundToStep(multiple, Number(`1e-${decimals}`))).toBe(multiple);
				})
			);
		});
	});

	describe('round 8 fast paths', function () {
		const anyDouble = fc.oneof(fc.double(), fc.constantFrom(0, -0, NaN, Infinity, -Infinity, 1, -1), smallInt);

		/**
		 * Sorts numbers the way the implementation used to for every input length: a typed-array sort (numeric, `-0`
		 * before `0`, `NaN` last).
		 * @param {number[]} numbers - The numbers
		 * @returns {number[]} A sorted copy
		 */
		function typedSorted(numbers: number[]): number[] {
			return Array.from(Float64Array.from(numbers).sort());
		}

		it('median and mode should follow the typed-array order on both sides of the short-input threshold', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(anyDouble, fc.constantFrom(0, -0, 0.5)), { maxLength: 70 }), function (numbers) {
					const sorted = typedSorted(numbers);
					const n = sorted.length;
					let expected = NaN;
					if (n > 0 && !Number.isNaN(sorted[n - 1])) {
						const low = sorted[(n - 1) >> 1];
						const high = sorted[n >> 1];
						expected = n % 2 === 1 ? low : Number.isFinite(low + high) ? (low + high) / 2 : low / 2 + high / 2;
					}
					expect(Object.is(helpers.median(numbers), expected)).toBe(true);
					const mode = helpers.mode(numbers);
					expect(mode).toEqual(typedSorted(mode));
					expect(mode).toEqual(helpers.mode(numbers.slice().reverse()));
				})
			);
		});

		it('quantile should pick the order statistics of a typed-array sort', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(anyDouble, fc.constant(NaN)), { minLength: 1, maxLength: 70 }), function (numbers) {
					const sorted = typedSorted(numbers);
					// q = 0 and q = 1 return the extreme order statistics themselves (NaN when any element is NaN).
					const hasNaN = numbers.some(Number.isNaN);
					expect(Object.is(helpers.quantile(numbers, 0), hasNaN ? NaN : sorted[0])).toBe(true);
					expect(Object.is(helpers.quantile(numbers, 1), hasNaN ? NaN : sorted[sorted.length - 1])).toBe(true);
				})
			);
		});

		/**
		 * Reference Neumaier summation (no fast path).
		 * @param {number[]} numbers - The numbers to add up
		 * @returns {number} The compensated sum
		 */
		function neumaier(numbers: number[]): number {
			let total = 0;
			let compensation = 0;
			for (const value of numbers) {
				const next = total + value;
				compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
				total = next;
			}
			return Number.isFinite(total) ? total + compensation : total;
		}

		it('sum should equal plain Neumaier summation, also after a run of int32 values', function () {
			const int32 = fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 });
			fc.assert(
				fc.property(fc.array(int32, { maxLength: 40 }), fc.array(anyDouble, { maxLength: 40 }), function (integers, rest) {
					const numbers = integers.concat(rest);
					expect(Object.is(helpers.sum(numbers), neumaier(numbers))).toBe(true);
					expect(Object.is(helpers.sum(integers), neumaier(integers))).toBe(true);
				})
			);
		});

		it('sum should be exact on int32 arrays (BigInt reference)', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), { maxLength: 200 }), function (integers) {
					const exact = integers.reduce(function (total, value) {
						return total + BigInt(value);
					}, BigInt(0));
					expect(helpers.sum(integers)).toBe(Number(exact));
				})
			);
		});
	});
});
