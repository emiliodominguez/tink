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
			function reference(x: number, d: number): number {
				// Exact decimal arithmetic on the number as written: `|x| = digits / 10 ** f` (`f` negative for large numbers), so with
				// `F = max(f, 0)`, `|x| = n / 10 ** F` for the integer `n = digits * 10 ** (F - f)`, rounded half away from zero by division.
				const [mantissa, exponent = '0'] = String(Math.abs(x)).split('e');
				const f = (mantissa.split('.')[1] ?? '').length - Number(exponent);
				// A number written with at most `d` decimals is already rounded.
				if (f <= d) return x;
				const scale = Math.max(f, 0);
				const n = BigInt(mantissa.replace('.', '')) * 10n ** BigInt(scale - f);
				const divisor = 10n ** BigInt(scale - d);
				const quotient = n / divisor + (2n * (n % divisor) >= divisor ? 1n : 0n);
				const rounded = Number(`${quotient}e${-d}`);
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

		it('should equal CSS clamp(MIN, VAL, MAX) = max(MIN, min(VAL, MAX)) for any bounds, crossed ones included', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, finiteDouble, function (value, minimum, maximum) {
					// `+ 0` compares -0 and 0 as equal: clamp keeps an in-range -0, Math.max/Math.min may not.
					expect(helpers.clamp(value, minimum, maximum) + 0).toBe(Math.max(minimum, Math.min(value, maximum)) + 0);
					if (minimum > maximum) expect(helpers.clamp(value, minimum, maximum)).toBe(minimum);
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

	describe('ceil / floor with decimals', function () {
		// Decimal reference on exact integers: x = k * 10^-e, rounded at d decimals with BigInt arithmetic.
		const literal = fc.tuple(fc.integer({ min: -1e12, max: 1e12 }), fc.integer({ min: 0, max: 10 })).map(function ([k, e]) {
			return { k, e, x: Number(`${k}e-${e}`) };
		});

		it('should match exact decimal arithmetic on numbers written with few digits', function () {
			fc.assert(
				fc.property(literal, fc.integer({ min: -4, max: 12 }), function ({ k, e, x }, d) {
					// x * 10^d = k * 10^(d - e): as an exact fraction num / den.
					const num = BigInt(k) * 10n ** BigInt(Math.max(0, d - e));
					const den = 10n ** BigInt(Math.max(0, e - d));
					const down = num >= 0n || num % den === 0n ? num / den : num / den - 1n;
					const up = num % den === 0n ? num / den : down + 1n;
					expect(helpers.floor(x, d)).toBe(Number(`${down}e${-d}`) + 0 || (num < 0n && down === 0n ? -0 : 0));
					expect(helpers.ceil(x, d)).toBe(Number(`${up}e${-d}`) + 0 || (num < 0n && up === 0n ? -0 : 0));
				}),
				{ numRuns: 2000 }
			);
		});

		it('should bracket the number: floor(x, d) <= x <= ceil(x, d), less than one unit apart', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer({ min: -20, max: 20 }), function (x, d) {
					const down = helpers.floor(x, d);
					const up = helpers.ceil(x, d);
					expect(down).toBeLessThanOrEqual(x);
					expect(up).toBeGreaterThanOrEqual(x);
					expect(up - down).toBeLessThanOrEqual(10 ** -d * (1 + 1e-9) + 4 * Number.EPSILON * Math.abs(x));
					// Idempotent, and equal to Math.ceil / Math.floor without decimals.
					expect(helpers.ceil(up, d)).toBe(up);
					expect(helpers.floor(down, d)).toBe(down);
					expect(helpers.ceil(x)).toBe(Math.ceil(x));
					expect(helpers.floor(x)).toBe(Math.floor(x));
				}),
				{ numRuns: 1000 }
			);
		});

		it('should be the identity for numbers already written with at most d decimals', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), function (x) {
					const [mantissa, exponent = '0'] = String(x).split('e');
					const places = (mantissa.split('.')[1] ?? '').length - Number(exponent);
					for (const d of [places, places + 1, places + 5]) {
						expect(helpers.ceil(x, d)).toBe(x);
						expect(helpers.floor(x, d)).toBe(x);
						expect(helpers.round(x, d)).toBe(x);
					}
				})
			);
		});
	});

	describe('parseBytes', function () {
		it('should invert formatBytes: format(parse(format(n))) === format(n)', function () {
			// Up to 1e30 bytes (a million YB) the text has at most 13 significant digits; beyond 15, formatBytes' binary division is the limit.
			fc.assert(
				fc.property(
					fc.double({ min: -1e30, max: 1e30, noNaN: true }),
					fc.constantFrom(1000 as const, 1024 as const),
					fc.integer({ min: 0, max: 6 }),
					function (bytes, base, decimals) {
						const text = helpers.formatBytes(bytes, { base, decimals });
						expect(helpers.formatBytes(helpers.parseBytes(text, { base }), { base, decimals })).toBe(text);
					}
				),
				{ numRuns: 1000 }
			);
		});

		it('should give back the exact byte count when formatBytes keeps every digit', function () {
			fc.assert(
				fc.property(fc.integer({ min: -1e15, max: 1e15 }), fc.constantFrom(1000 as const, 1024 as const), function (bytes, base) {
					const text = helpers.formatBytes(bytes, { base, decimals: 30 });
					expect(helpers.parseBytes(text, { base })).toBe(bytes);
					expect(helpers.parseBytes(` ${text.replace(' ', '')} `, { base })).toBe(bytes);
				}),
				{ numRuns: 1000 }
			);
		});

		it('should scale exactly: n units of k-th power is n * base^k', function () {
			const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 8 }), function (digits, places, k) {
					const text = `${(digits / 10 ** places).toFixed(places)} ${units[k]}`;
					expect(helpers.parseBytes(text)).toBe(Number(`${digits}e${3 * k - places}`));
					expect(helpers.parseBytes(text, { base: 1024 })).toBe((digits / 10 ** places) * 1024 ** k);
				})
			);
		});

		it('should reject (never half-parse) anything that is not a number followed by a known unit', function () {
			fc.assert(
				fc.property(fc.string({ maxLength: 12 }), function (text) {
					let parsed: number | undefined;
					try {
						parsed = helpers.parseBytes(text);
					} catch (error) {
						expect(error).toBeInstanceOf(RangeError);
						return;
					}
					expect(text.trim()).toMatch(/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\s*(?:B|[kKMGTPEZY]B|[KMGTPEZY]iB)?$/);
					expect(Number.isFinite(parsed)).toBe(true);
				}),
				{ numRuns: 2000 }
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

/** The exact value of a double, as an integer multiple of 2 ** -1074 (the smallest subnormal). */
function scaledExact(value: number): bigint {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value);
	const bits = view.getBigUint64(0);
	const exponent = Number((bits >> 52n) & 0x7ffn);
	const fraction = bits & ((1n << 52n) - 1n);
	const magnitude = exponent === 0 ? fraction : (fraction | (1n << 52n)) << BigInt(exponent - 1);
	return bits >> 63n === 1n ? -magnitude : magnitude;
}

/** The double nearest to `scaled * 2 ** -1074` (ties to even), `±Infinity` beyond the doubles. */
function nearestDouble(scaled: bigint): number {
	if (scaled === 0n) return 0;
	const sign = scaled < 0n ? -1 : 1;
	const magnitude = scaled < 0n ? -scaled : scaled;
	const length = magnitude.toString(2).length;
	if (length <= 53) return sign * Number(magnitude) * 2 ** -1074;
	const shift = BigInt(length - 53);
	let kept = magnitude >> shift;
	const rest = magnitude - (kept << shift);
	const half = 1n << (shift - 1n);
	if (rest > half || (rest === half && (kept & 1n) === 1n)) kept++;
	const exponent = length - 53 - 1074;
	// Two scalings, each exact, so that neither the factor nor an intermediate result leaves the doubles before the final one.
	return sign * Number(kept) * 2 ** Math.min(exponent, 1000) * 2 ** Math.max(exponent - 1000, 0);
}

/** Rational reference for `sumPrecise`: the exact sum of finite doubles, rounded once. */
function exactSum(values: ReadonlyArray<number>): number {
	return nearestDouble(
		values.reduce(function (total, value) {
			return total + scaledExact(value);
		}, 0n)
	);
}

/** Doubles of every magnitude, with the extremes and powers of two around the overflow and subnormal boundaries well represented. */
const anyFiniteDouble = fc.oneof(
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.double({ min: -1e6, max: 1e6, noNaN: true }),
	fc.constantFrom(Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** 1023, -(2 ** 1023), 2 ** 970, -(2 ** 970), 2 ** 971, 5e-324, -5e-324, 1, -1, 0, -0, 0.1, 1e308),
	fc.integer({ min: -1074, max: 1023 }).map(function (exponent) {
		return 2 ** exponent;
	})
);

/** The significant digits of the shortest decimal form of a positive number, without leading or trailing zeros. */
function significantDigits(value: number): string {
	return String(value)
		.split('e')[0]
		.replace('.', '')
		.replace(/^0+|0+$/g, '');
}

/** Rational reference for `toSignificant`: the decimal `String(x)` rounded half away from zero to `digits` digits, as BigInts. */
function significantReference(x: number, digits: number): number {
	if (x === 0 || !Number.isFinite(x)) return x;
	const [mantissa, exponent = '0'] = String(Math.abs(x)).split('e');
	const [whole, fraction = ''] = mantissa.split('.');
	// |x| = coefficient * 10 ** power, the coefficient without leading zeros.
	const coefficient = BigInt(whole + fraction);
	const power = Number(exponent) - fraction.length;
	const length = coefficient.toString().length;
	if (length <= digits) return x;
	const dropped = 10n ** BigInt(length - digits);
	const rounded = coefficient / dropped + ((coefficient % dropped) * 2n >= dropped ? 1n : 0n);
	return Math.sign(x) * Number(`${rounded}e${power + length - digits}`);
}

describe('Math helpers (property-based, new aggregates)', function () {
	describe('sumPrecise', function () {
		it('should equal the exact sum rounded once (BigInt rational reference)', function () {
			fc.assert(
				fc.property(fc.array(anyFiniteDouble, { minLength: 1, maxLength: 30 }), function (values) {
					const expected = exactSum(values);
					const actual = helpers.sumPrecise(values);
					// Zero sums: -0 only when every value is -0.
					if (expected === 0) {
						expect(actual).toBe(
							values.every(function (value) {
								return Object.is(value, -0);
							})
								? -0
								: 0
						);
					} else {
						expect(actual).toBe(expected);
					}
				})
			);
		});

		it('should not depend on the order of the numbers', function () {
			fc.assert(
				fc.property(fc.array(anyFiniteDouble, { maxLength: 30 }), fc.integer(), function (values, seed) {
					const shuffled = values.slice().sort(function (a, b) {
						return ((Math.abs(a) * 7 + seed) % 3) - ((Math.abs(b) * 7 + seed) % 3) || 0;
					});
					expect(helpers.sumPrecise(shuffled)).toBe(helpers.sumPrecise(values));
					expect(helpers.sumPrecise(values.slice().reverse())).toBe(helpers.sumPrecise(values));
				})
			);
		});

		it('should agree with sum on integers, where both are exact', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), { minLength: 1, maxLength: 100 }), function (integers) {
					expect(helpers.sumPrecise(integers)).toBe(helpers.sum(integers));
				})
			);
		});

		it('should follow the non-finite rules of Math.sumPrecise', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(anyFiniteDouble, fc.constantFrom(NaN, Infinity, -Infinity)), { maxLength: 20 }), function (values) {
					const hasNaN = values.some(Number.isNaN);
					const positive = values.includes(Infinity);
					const negative = values.includes(-Infinity);
					const actual = helpers.sumPrecise(values);
					if (hasNaN || (positive && negative)) expect(actual).toBeNaN();
					else if (positive) expect(actual).toBe(Infinity);
					else if (negative) expect(actual).toBe(-Infinity);
					else expect(Number.isNaN(actual)).toBe(false);
				})
			);
		});
	});

	describe('average', function () {
		it('should stay finite and between the extremes when the sum overflows', function () {
			const huge = fc.double({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE, noNaN: true }).filter(function (value) {
				return Math.abs(value) > 1e300;
			});
			fc.assert(
				fc.property(fc.array(fc.oneof(huge, fc.constant(Number.MAX_VALUE), fc.constant(-Number.MAX_VALUE)), { minLength: 1, maxLength: 20 }), function (values) {
					const mean = helpers.average(values);
					expect(mean).toBeGreaterThanOrEqual(Math.min(...values));
					expect(mean).toBeLessThanOrEqual(Math.max(...values));
				})
			);
		});
	});

	describe('movingAverage', function () {
		it('should equal sumPrecise of each window divided by the window, whenever that sum is finite', function () {
			fc.assert(
				fc.property(
					fc.array(fc.oneof(anyFiniteDouble, fc.constantFrom(NaN, Infinity, -Infinity, -0)), { maxLength: 40 }),
					fc.integer({ min: 1, max: 8 }),
					function (values, window) {
						const averages = helpers.movingAverage(values, window);
						expect(averages).toHaveLength(Math.max(0, values.length - window + 1));
						averages.forEach(function (average, index) {
							const slice = values.slice(index, index + window);
							const total = helpers.sumPrecise(slice);
							if (Number.isFinite(total) || !slice.every(Number.isFinite)) {
								expect(average).toBe(total / window);
							} else {
								// The sum overflows, the mean does not: rounded twice like the other windows, so within an ulp of the
								// exact mean (BigInt reference).
								const exact = nearestDouble(
									slice.reduce(function (sum, value) {
										return sum + scaledExact(value);
									}, 0n) / BigInt(window)
								);
								expect(Number.isFinite(average)).toBe(true);
								expect(Math.abs(average - exact)).toBeLessThanOrEqual(Math.abs(exact) * Number.EPSILON);
							}
						});
					}
				)
			);
		});

		it('should be close to the naive recomputation of every window', function () {
			fc.assert(
				fc.property(fc.array(finiteDouble, { maxLength: 60 }), fc.integer({ min: 1, max: 10 }), function (values, window) {
					helpers.movingAverage(values, window).forEach(function (average, index) {
						const slice = values.slice(index, index + window);
						const naive =
							slice.reduce(function (total, value) {
								return total + value;
							}, 0) / window;
						const scale = slice.reduce(function (total, value) {
							return total + Math.abs(value);
						}, 0);
						expect(Math.abs(average - naive)).toBeLessThanOrEqual(scale * window * Number.EPSILON);
					});
				})
			);
		});
	});

	describe('toSignificant', function () {
		it('should round the decimal form half away from zero (BigInt reference)', function () {
			fc.assert(
				fc.property(anyFiniteDouble, fc.integer({ min: 1, max: 20 }), function (x, digits) {
					expect(helpers.toSignificant(x, digits)).toBe(significantReference(x, digits));
				})
			);
		});

		it('should keep at most `digits` significant digits, keep the sign, and be idempotent', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e300, max: 1e300 }), fc.integer({ min: 1, max: 17 }), function (x, digits) {
					const rounded = helpers.toSignificant(x, digits);
					if (x !== 0) {
						expect(significantDigits(Math.abs(rounded)).length).toBeLessThanOrEqual(digits);
						expect(Math.sign(rounded)).toBe(Math.sign(x));
					}
					expect(helpers.toSignificant(rounded, digits)).toBe(rounded);
					expect(helpers.toSignificant(x, 17)).toBe(x);
				})
			);
		});

		it('should take the fast path only where it agrees with the decimal reference (ties, powers of ten, short decimals)', function () {
			// Short decimals, ties as written (…5 and …5 plus a tiny bit), powers of ten and their neighbours.
			const decimalish = fc.oneof(
				fc.tuple(fc.integer({ min: 1, max: 999_999 }), fc.integer({ min: -30, max: 30 })).map(function ([coefficient, exponent]) {
					return Number(`${coefficient}e${exponent}`);
				}),
				fc.tuple(fc.integer({ min: 0, max: 99_999 }), fc.integer({ min: -25, max: 25 })).map(function ([coefficient, exponent]) {
					return Number(`${coefficient}5e${exponent}`);
				}),
				fc.tuple(fc.integer({ min: -300, max: 300 }), fc.integer({ min: -2, max: 2 })).map(function ([exponent, ulps]) {
					const power = Number(`1e${exponent}`);
					return power + ulps * power * Number.EPSILON;
				})
			);
			fc.assert(
				fc.property(decimalish, fc.integer({ min: 1, max: 17 }), fc.boolean(), function (x, digits, negative) {
					const value = negative ? -x : x;
					expect(helpers.toSignificant(value, digits)).toBe(significantReference(value, digits));
				})
			);
		});

		it('should agree with toPrecision away from decimal ties', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e300, max: 1e300 }), fc.integer({ min: 1, max: 15 }), function (x, digits) {
					const digitString = significantDigits(Math.abs(x));
					// The first dropped digit of the shortest form is not a 5 followed by nothing: not a tie as written.
					fc.pre(digitString.length <= digits || !/^5$/.test(digitString.slice(digits)));
					// (`toPrecision` writes -0 as '0'.)
					expect(helpers.toSignificant(x, digits)).toBe(x === 0 ? x : Number(x.toPrecision(digits)));
				})
			);
		});
	});

	describe('histogram', function () {
		const value = fc.double({ min: -1000, max: 1000, noNaN: true });

		it('should count every value in the domain exactly once, in the bin whose range holds it', function () {
			fc.assert(
				fc.property(
					fc.array(value, { maxLength: 60 }),
					fc.oneof(
						fc.record({ bins: fc.integer({ min: 1, max: 12 }) }),
						fc.record({
							thresholds: fc.uniqueArray(value, { maxLength: 6, comparator: 'SameValueZero' }).map(function (list) {
								return list.sort(function (a, b) {
									return a - b;
								});
							})
						})
					),
					fc.option(fc.tuple(value, value), { nil: undefined }),
					function (values, binning, range) {
						const domain = range === undefined ? undefined : ([Math.min(...range), Math.max(...range)] as [number, number]);
						const bins = helpers.histogram(values, { ...binning, domain } as never);
						const inDomain = values.filter(function (v) {
							return domain === undefined || (v >= domain[0] && v <= domain[1]);
						});
						if (domain === undefined && values.length === 0) {
							expect(bins).toEqual([]);
							return;
						}
						// Edge to edge, from the lower to the upper bound, in order.
						const low = domain?.[0] ?? Math.min(...values);
						const high = domain?.[1] ?? Math.max(...values);
						expect(bins[0].x0).toBe(low);
						expect(bins[bins.length - 1].x1).toBe(high);
						bins.forEach(function (bin, index) {
							expect(bin.x0).toBeLessThanOrEqual(bin.x1);
							if (index > 0) expect(bin.x0).toBe(bins[index - 1].x1);
						});
						if ('bins' in binning && low < high) expect(bins).toHaveLength(binning.bins);
						// Brute-force placement: the last bin whose lower edge is at most the value.
						const counts = bins.map(function () {
							return 0;
						});
						for (const v of inDomain) {
							let index = 0;
							for (let i = 1; i < bins.length; i++) if (bins[i].x0 <= v) index = i;
							counts[index]++;
						}
						expect(
							bins.map(function (bin) {
								return bin.count;
							})
						).toEqual(counts);
					}
				)
			);
		});
	});
});

describe('New math helpers (property-based)', function () {
	describe('extent', function () {
		it('should equal [min, max] on non-empty arrays (signed zeros and NaN included)', function () {
			const element = fc.oneof(fc.double(), fc.constantFrom(0, -0, NaN, Infinity, -Infinity));
			fc.assert(
				fc.property(fc.array(element, { minLength: 1, maxLength: 30 }), function (numbers) {
					expect(helpers.extent(numbers)).toEqual([helpers.min(numbers), helpers.max(numbers)]);
					const [low, high] = helpers.extent(numbers) as [number, number];
					expect(Object.is(low, helpers.min(numbers)) && Object.is(high, helpers.max(numbers))).toBe(true);
				})
			);
		});
	});

	describe('wrap', function () {
		const bound = fc.integer({ min: -1000, max: 1000 });

		it('should equal the naive Euclidean wrap on integers', function () {
			fc.assert(
				fc.property(fc.integer({ min: -1e9, max: 1e9 }), bound, bound, function (value, a, b) {
					fc.pre(a !== b);
					const [low, high] = a < b ? [a, b] : [b, a];
					const span = high - low;
					expect(helpers.wrap(value, low, high)).toBe(low + ((((value - low) % span) + span) % span));
				})
			);
		});

		it('should land in [minimum, maximum), be idempotent, and keep in-range values', function () {
			const real = fc.double({ min: -1e12, max: 1e12, noNaN: true });
			fc.assert(
				fc.property(real, real, real, function (value, a, b) {
					fc.pre(a !== b);
					const [low, high] = a < b ? [a, b] : [b, a];
					const wrapped = helpers.wrap(value, low, high);
					expect(wrapped >= low && wrapped < high).toBe(true);
					expect(helpers.wrap(wrapped, low, high)).toBe(wrapped);
					if (value >= low && value < high) expect(wrapped).toBe(value);
				})
			);
		});

		it('should be periodic: shifting the value by whole spans does not change the result (exact for integers)', function () {
			fc.assert(
				fc.property(
					fc.integer({ min: -1e6, max: 1e6 }),
					bound,
					fc.integer({ min: 1, max: 1000 }),
					fc.integer({ min: -1000, max: 1000 }),
					function (value, low, span, turns) {
						expect(helpers.wrap(value + turns * span, low, low + span)).toBe(helpers.wrap(value, low, low + span));
					}
				)
			);
		});
	});

	describe('allocate', function () {
		const ratios = fc.array(fc.nat({ max: 1000 }), { minLength: 1, maxLength: 12 }).filter(function (list) {
			return list.some(function (ratio) {
				return ratio > 0;
			});
		});
		const total = fc.integer({ min: -1_000_000, max: 1_000_000 });

		/**
		 * The largest remainder method on integer ratios, in exact rational arithmetic (a reference).
		 * @param {number} amount - The total
		 * @param {number[]} weights - Integer ratios
		 * @returns {number[]} The shares
		 */
		function hamilton(amount: number, weights: number[]): number[] {
			const sign = amount < 0 ? -1n : 1n;
			const magnitude = BigInt(Math.abs(amount));
			const denominator = weights.reduce(function (sum, weight) {
				return sum + BigInt(weight);
			}, 0n);
			const shares = weights.map(function (weight) {
				return (magnitude * BigInt(weight)) / denominator;
			});
			let left =
				magnitude -
				shares.reduce(function (sum, share) {
					return sum + share;
				}, 0n);
			const order = weights
				.map(function (weight, index) {
					return { index, remainder: (magnitude * BigInt(weight)) % denominator };
				})
				.sort(function (a, b) {
					return a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1;
				});
			for (const { index } of order) {
				if (left === 0n) break;
				shares[index] += 1n;
				left--;
			}
			return shares.map(function (share) {
				return Number(sign * share) + 0;
			});
		}

		it('should add up to the total exactly, each share within 1 of its exact quota', function () {
			fc.assert(
				fc.property(total, ratios, function (amount, weights) {
					const shares = helpers.allocate(amount, weights);
					const denominator = BigInt(
						weights.reduce(function (a, b) {
							return a + b;
						}, 0)
					);
					expect(shares.length).toBe(weights.length);
					expect(helpers.sum(shares)).toBe(amount);
					shares.forEach(function (share, i) {
						// |share - amount * weight / denominator| < 1, in exact integers.
						const difference = BigInt(share) * denominator - BigInt(amount) * BigInt(weights[i]);
						expect(difference < denominator && difference > -denominator).toBe(true);
						if (weights[i] === 0) expect(share).toBe(0);
					});
				})
			);
		});

		it('should match a reference implementation of the largest remainder method', function () {
			fc.assert(
				fc.property(total, ratios, function (amount, weights) {
					expect(helpers.allocate(amount, weights)).toEqual(hamilton(amount, weights));
				})
			);
		});

		it('should be symmetric in the sign of the total, agree with bigint totals, and depend only on the proportions', function () {
			fc.assert(
				fc.property(total, ratios, fc.constantFrom(0.5, 2, 3, 0.125, 1e-10), function (amount, weights, factor) {
					const shares = helpers.allocate(amount, weights);
					expect(helpers.allocate(-amount, weights)).toEqual(
						shares.map(function (share) {
							return -share + 0;
						})
					);
					expect(helpers.allocate(BigInt(amount), weights)).toEqual(shares.map(BigInt));
					expect(helpers.allocate(amount, weights.map(BigInt))).toEqual(shares);
					// Scaling by a power of two is exact, so the shares cannot change.
					if (factor === 0.5 || factor === 2 || factor === 0.125) {
						expect(
							helpers.allocate(
								amount,
								weights.map(function (weight) {
									return weight * factor;
								})
							)
						).toEqual(shares);
					}
				})
			);
		});

		it('should add up to the total for any finite double ratios', function () {
			const anyRatios = fc.array(fc.double({ min: 0, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 8 }).filter(function (list) {
				return list.some(function (ratio) {
					return ratio > 0;
				});
			});
			fc.assert(
				fc.property(fc.maxSafeInteger(), anyRatios, function (amount, weights) {
					const shares = helpers.allocate(amount, weights);
					expect(helpers.sumPrecise(shares)).toBe(amount);
				})
			);
		});
	});

	describe('covariance, correlation and linearRegression', function () {
		const pairs = fc.array(fc.tuple(finiteDouble, finiteDouble), { minLength: 2, maxLength: 40 });
		// Sixteenths: values for which the textbook formulas neither underflow nor overflow.
		const sixteenth = fc.integer({ min: -1e6, max: 1e6 }).map(function (n) {
			return n / 16;
		});
		const moderatePairs = fc.array(fc.tuple(sixteenth, sixteenth), { minLength: 2, maxLength: 40 });

		function first(pair: [number, number]): number {
			return pair[0];
		}

		function second(pair: [number, number]): number {
			return pair[1];
		}

		/**
		 * The textbook two-pass formulas (simple-statistics), as a reference.
		 * @param {number[]} xs - The first sample
		 * @param {number[]} ys - The second sample
		 * @returns {{ covariance: number, correlation: number, slope: number }} The reference statistics
		 */
		function reference(xs: number[], ys: number[]): { covariance: number; correlation: number; slope: number } {
			const n = xs.length;
			const meanX = helpers.sumPrecise(xs) / n;
			const meanY = helpers.sumPrecise(ys) / n;
			let sxy = 0;
			let sxx = 0;
			let syy = 0;
			for (let i = 0; i < n; i++) {
				sxy += (xs[i] - meanX) * (ys[i] - meanY);
				sxx += (xs[i] - meanX) ** 2;
				syy += (ys[i] - meanY) ** 2;
			}
			return { covariance: sxy / n, correlation: sxy / Math.sqrt(sxx * syy), slope: sxy / sxx };
		}

		it('should match the textbook formulas on moderate data', function () {
			fc.assert(
				fc.property(moderatePairs, function (list) {
					const xs = list.map(first);
					const ys = list.map(second);
					const expected = reference(xs, ys);
					const scale = Math.max(1, Math.abs(expected.covariance));
					expect(Math.abs(helpers.covariance(xs, ys) - expected.covariance)).toBeLessThanOrEqual(scale * 1e-9);
					fc.pre(Number.isFinite(expected.correlation) && Math.abs(expected.slope) < 1e9);
					expect(helpers.correlation(xs, ys)).toBeCloseTo(expected.correlation, 9);
					const line = helpers.linearRegression(xs, ys);
					expect(Math.abs(line.slope - expected.slope)).toBeLessThanOrEqual(Math.max(1, Math.abs(expected.slope)) * 1e-9);
					expect(line.r2).toBeCloseTo(expected.correlation ** 2, 9);
				})
			);
		});

		it('should keep the correlation in [-1, 1] and r2 in [0, 1], symmetric, with r2 the square of the correlation', function () {
			fc.assert(
				fc.property(pairs, function (list) {
					const xs = list.map(first);
					const ys = list.map(second);
					const r = helpers.correlation(xs, ys);
					fc.pre(!Number.isNaN(r));
					expect(r >= -1 && r <= 1).toBe(true);
					expect(helpers.correlation(ys, xs)).toBe(r);
					expect(helpers.covariance(xs, ys)).toBe(helpers.covariance(ys, xs));
					const { r2 } = helpers.linearRegression(xs, ys);
					expect(r2 >= 0 && r2 <= 1).toBe(true);
					expect(r2).toBeCloseTo(r * r, 12);
				})
			);
		});

		it('should recover an exact integer line, whatever the offset of the xs', function () {
			fc.assert(
				fc.property(
					fc.uniqueArray(fc.integer({ min: -1000, max: 1000 }), { minLength: 2, maxLength: 20 }),
					fc.integer({ min: -100, max: 100 }),
					fc.integer({ min: -1000, max: 1000 }),
					fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
					function (offsets, slope, intercept, origin) {
						const xs = offsets.map(function (offset) {
							return origin + offset;
						});
						const ys = xs.map(function (x) {
							return slope * (x - origin) + intercept;
						});
						const line = helpers.linearRegression(xs, ys);
						// Exact when the means are (dyadic); otherwise the slope is within a few ulps, and a prediction within the rounding of the
						// mean of the xs (an ulp of the origin), however far the xs are from zero.
						expect(Math.abs(line.slope - slope)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(slope)));
						expect(Math.abs(line.predict(origin) - intercept)).toBeLessThanOrEqual((1 + Math.abs(slope)) * Math.abs(origin) * 2 ** -51 + 1e-9);
						if (slope === 0) {
							expect(line.r2).toBe(1);
							expect(helpers.correlation(xs, ys)).toBeNaN();
						} else {
							expect(Math.abs(line.r2 - 1)).toBeLessThanOrEqual(1e-12);
							expect(Math.abs(helpers.correlation(xs, ys) - Math.sign(slope))).toBeLessThanOrEqual(1e-12);
						}
					}
				)
			);
		});

		it('should be invariant under positive affine changes of either sample (correlation)', function () {
			fc.assert(
				fc.property(moderatePairs, fc.integer({ min: 1, max: 1000 }), fc.integer({ min: -1000, max: 1000 }), function (list, scale, shift) {
					const xs = list.map(first);
					const ys = list.map(second);
					const r = helpers.correlation(xs, ys);
					fc.pre(Number.isFinite(r));
					const moved = xs.map(function (x) {
						return x * scale + shift;
					});
					expect(helpers.correlation(moved, ys)).toBeCloseTo(r, 8);
				})
			);
		});
	});

	describe('interquartileRange', function () {
		it('should equal quantile(0.75) - quantile(0.25)', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					expect(helpers.interquartileRange(numbers)).toBe(helpers.quantile(numbers, 0.75) - helpers.quantile(numbers, 0.25));
				})
			);
		});
	});

	describe('primeFactors', function () {
		const safe = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

		it('should give ascending primes whose product is n', function () {
			fc.assert(
				fc.property(safe, function (n) {
					const factors = helpers.primeFactors(n);
					expect(
						factors.every(function (factor, index) {
							return helpers.isPrime(factor) && (index === 0 || factors[index - 1] <= factor);
						})
					).toBe(true);
					expect(
						factors.reduce(function (product, factor) {
							return product * BigInt(factor);
						}, 1n)
					).toBe(BigInt(n));
				})
			);
		});

		it('should split products of two large primes', function () {
			const large = fc.integer({ min: 1031, max: 94_906_000 }).map(helpers.nextPrime);
			fc.assert(
				fc.property(large, large, function (p, q) {
					fc.pre(p * q <= Number.MAX_SAFE_INTEGER);
					expect(helpers.primeFactors(p * q)).toEqual([Math.min(p, q), Math.max(p, q)]);
				})
			);
		});
	});

	describe('divisors', function () {
		it('should equal the naive list of divisors', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 100_000 }), function (n) {
					const naive: number[] = [];
					for (let d = 1; d <= n; d++) if (n % d === 0) naive.push(d);
					expect(helpers.divisors(n)).toEqual(naive);
				})
			);
		});

		it('should be symmetric: d divides n exactly when n / d does', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), function (n) {
					const result = helpers.divisors(n);
					expect(result[0]).toBe(1);
					expect(result[result.length - 1]).toBe(n);
					result.forEach(function (d, index) {
						expect(n % d).toBe(0);
						expect(result[result.length - 1 - index]).toBe(n / d);
					});
				})
			);
		});
	});

	describe('primesUpTo', function () {
		it('should list exactly the numbers isPrime accepts', function () {
			fc.assert(
				fc.property(fc.double({ min: -10, max: 5000, noNaN: true }), function (limit) {
					const expected: number[] = [];
					for (let n = 2; n <= limit; n++) if (helpers.isPrime(n)) expected.push(n);
					expect(helpers.primesUpTo(limit)).toEqual(expected);
				})
			);
		});
	});

	describe('nextPrime and previousPrime', function () {
		it('should find the nearest prime, with no prime in between', function () {
			fc.assert(
				fc.property(fc.double({ min: -100, max: 1e7, noNaN: true }), function (n) {
					const next = helpers.nextPrime(n);
					expect(next > n && helpers.isPrime(next)).toBe(true);
					for (let m = Math.max(2, Math.floor(n) + 1); m < next; m++) expect(helpers.isPrime(m)).toBe(false);
					fc.pre(n > 2);
					const previous = helpers.previousPrime(n);
					expect(previous < n && helpers.isPrime(previous)).toBe(true);
					for (let m = previous + 1; m < n; m++) expect(helpers.isPrime(m)).toBe(false);
				})
			);
		});

		it('should be inverse walks over the primes', function () {
			fc.assert(
				fc.property(fc.integer({ min: 3, max: Number.MAX_SAFE_INTEGER - 1000 }), function (n) {
					const prime = helpers.nextPrime(n);
					expect(helpers.previousPrime(helpers.nextPrime(prime))).toBe(prime);
					expect(helpers.nextPrime(helpers.previousPrime(prime))).toBe(prime);
				})
			);
		});
	});

	describe('binomial', function () {
		it('should equal the correctly rounded BigInt value', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 1200 }), fc.integer({ min: -5, max: 1205 }), function (n, k) {
					let exact = 0n;
					if (k >= 0 && k <= n) {
						exact = 1n;
						for (let i = 1; i <= k; i++) exact = (exact * BigInt(n - k + i)) / BigInt(i);
					}
					expect(helpers.binomial(n, k)).toBe(Number(exact));
				})
			);
		});

		it("should satisfy Pascal's rule and the symmetry exactly below 2 ** 53", function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 1, max: 10_000 }), function (n, k) {
					const value = helpers.binomial(n, k);
					fc.pre(value <= Number.MAX_SAFE_INTEGER);
					expect(helpers.binomial(n - 1, k - 1) + helpers.binomial(n - 1, k)).toBe(value);
					expect(helpers.binomial(n, n - k)).toBe(value);
				})
			);
		});
	});

	describe('extendedGcd', function () {
		const safeInteger = fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });

		it('should give the gcd and small Bézout coefficients', function () {
			fc.assert(
				fc.property(safeInteger, safeInteger, function (a, b) {
					const { gcd, x, y } = helpers.extendedGcd(a, b);
					expect(gcd).toBe(helpers.gcd(a, b));
					expect(BigInt(a) * BigInt(x) + BigInt(b) * BigInt(y)).toBe(BigInt(gcd));
					if (gcd > 0) {
						expect(Math.abs(x)).toBeLessThanOrEqual(Math.max(1, Math.abs(b) / gcd));
						expect(Math.abs(y)).toBeLessThanOrEqual(Math.max(1, Math.abs(a) / gcd));
					}
				})
			);
		});
	});

	describe('modInverse', function () {
		it('should give the x in [0, m) with a * x ≡ 1 (mod m)', function () {
			fc.assert(
				fc.property(
					fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
					fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER }),
					function (a, modulus) {
						if (helpers.gcd(a, modulus) !== 1) {
							expect(function () {
								helpers.modInverse(a, modulus);
							}).toThrow(RangeError);
							return;
						}
						const inverse = helpers.modInverse(a, modulus);
						expect(inverse >= 0 && inverse < modulus).toBe(true);
						expect((((BigInt(a) * BigInt(inverse)) % BigInt(modulus)) + BigInt(modulus)) % BigInt(modulus)).toBe(1n);
					}
				)
			);
		});
	});

	describe('modPow', function () {
		/** `base ** exponent mod modulus` (floored) in BigInt arithmetic, for a non-negative exponent. */
		function reference(base: number, exponent: number, modulus: number): number {
			const m = BigInt(modulus);
			let result = 1n % m;
			let power = ((BigInt(base) % m) + m) % m;
			for (let rest = BigInt(exponent); rest > 0n; rest >>= 1n, power = (power * power) % m) {
				if ((rest & 1n) === 1n) result = (result * power) % m;
			}
			return Number(result);
		}
		const base = fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
		const exponent = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

		it('should equal the BigInt reference, for small and large moduli', function () {
			fc.assert(
				fc.property(base, exponent, fc.oneof(fc.integer({ min: 1, max: 94_906_265 }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })), function (b, e, m) {
					expect(helpers.modPow(b, e, m)).toBe(reference(b, e, m));
				})
			);
		});

		it('should raise the inverse for negative exponents', function () {
			fc.assert(
				fc.property(base, fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 2, max: Number.MAX_SAFE_INTEGER }), function (b, e, m) {
					fc.pre(helpers.gcd(b, m) === 1);
					const result = helpers.modPow(b, -e, m);
					// `b ** -e * b ** e ≡ 1`.
					expect((BigInt(result) * BigInt(helpers.modPow(b, e, m))) % BigInt(m)).toBe(1n);
				})
			);
		});
	});

	describe('integerSqrt', function () {
		it('should give the r with r * r <= n < (r + 1) ** 2, for numbers and bigints alike', function () {
			fc.assert(
				fc.property(
					fc.oneof(
						fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
						fc.integer({ min: 94_000_000, max: 94_906_265 }).map(function (r) {
							return r * r - 1;
						})
					),
					function (n) {
						const root = helpers.integerSqrt(n);
						const big = BigInt(root);
						expect(big * big <= BigInt(n) && (big + 1n) * (big + 1n) > BigInt(n)).toBe(true);
						expect(helpers.integerSqrt(BigInt(n))).toBe(big);
					}
				)
			);
		});

		it('should handle bigints of any size', function () {
			fc.assert(
				fc.property(fc.bigInt({ min: 0n, max: 2n ** 2000n }), function (n) {
					const root = helpers.integerSqrt(n);
					expect(root * root <= n && (root + 1n) * (root + 1n) > n).toBe(true);
				})
			);
		});
	});

	describe('isPerfectSquare', function () {
		it('should accept squares and reject their neighbours', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 94_906_265 }), function (r) {
					expect(helpers.isPerfectSquare(r * r)).toBe(true);
					expect(helpers.isPerfectSquare(r * r + 1)).toBe(false);
					expect(helpers.isPerfectSquare(r * r - 1)).toBe(r === 1);
				})
			);
		});

		it('should agree with integerSqrt on safe integers', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), function (n) {
					const root = helpers.integerSqrt(n);
					expect(helpers.isPerfectSquare(n)).toBe(root * root === n);
				})
			);
		});
	});

	describe('isPowerOfTwo and nextPowerOfTwo', function () {
		it('should recognize every power of two', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 1023 }), function (k) {
					expect(helpers.isPowerOfTwo(2 ** k)).toBe(true);
					expect(helpers.nextPowerOfTwo(2 ** k)).toBe(2 ** k);
					if (k > 1) expect(helpers.isPowerOfTwo(2 ** k + 2 ** (k - 1))).toBe(false);
				})
			);
		});

		it('should round up to the smallest power of two above', function () {
			fc.assert(
				fc.property(fc.double({ min: 1, max: 2 ** 1023, noNaN: true }), function (n) {
					const power = helpers.nextPowerOfTwo(n);
					expect(helpers.isPowerOfTwo(power)).toBe(true);
					expect(power >= n && (power === 1 || power / 2 < n)).toBe(true);
				})
			);
		});
	});

	describe('smoothstep and smootherstep', function () {
		const edges = fc.tuple(finiteDouble, finiteDouble).filter(function ([a, b]) {
			return a !== b;
		});
		const anyDouble = fc.double({ noNaN: true });

		it('should stay in [0, 1] and be monotonic in x', function () {
			fc.assert(
				fc.property(edges, anyDouble, anyDouble, function ([a, b], x, y) {
					const low = Math.min(a, b);
					const high = Math.max(a, b);
					const [first, second] = x <= y ? [x, y] : [y, x];
					for (const fn of [helpers.smoothstep, helpers.smootherstep]) {
						const value = fn(low, high, first);
						expect(value).toBeGreaterThanOrEqual(0);
						expect(value).toBeLessThanOrEqual(1);
						expect(value).toBeLessThanOrEqual(fn(low, high, second) + 1e-14);
					}
				})
			);
		});

		it('should be symmetric about the middle of the edges, and mirrored by reversing them', function () {
			fc.assert(
				fc.property(smallInt, smallInt, smallInt, function (a, b, x) {
					fc.pre(a !== b);
					for (const fn of [helpers.smoothstep, helpers.smootherstep]) {
						expect(fn(a, b, x) + fn(a, b, a + b - x)).toBeCloseTo(1, 14);
						expect(fn(b, a, x)).toBeCloseTo(1 - fn(a, b, x), 14);
					}
				})
			);
		});
	});

	describe('damp', function () {
		const rate = fc.double({ min: 0, max: 100, noNaN: true });
		const time = fc.double({ min: 0, max: 10, noNaN: true });

		it('should move towards the target without overshooting it', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, rate, time, function (current, target, lambda, deltaTime) {
					const result = helpers.damp(current, target, lambda, deltaTime);
					expect(result).toBeGreaterThanOrEqual(Math.min(current, target));
					expect(result).toBeLessThanOrEqual(Math.max(current, target));
					expect(Math.abs(target - result)).toBeLessThanOrEqual(Math.abs(target - current));
				})
			);
		});

		it('should not depend on how a time span is split into steps', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, rate, time, function (current, target, lambda, deltaTime) {
					const once = helpers.damp(current, target, lambda, deltaTime);
					const twice = helpers.damp(helpers.damp(current, target, lambda, deltaTime / 2), target, lambda, deltaTime / 2);
					// Up to rounding, and to the ulp a step too small to change the value moves it by.
					const ulps = 4 * Number.EPSILON * Math.max(Math.abs(current), Math.abs(target)) + 2 * Number.MIN_VALUE;
					expect(Math.abs(twice - once)).toBeLessThanOrEqual(1e-12 * Math.abs(target - current) + ulps);
				})
			);
		});

		it('should reach the target exactly after enough steps', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, fc.double({ min: 10, max: 100, noNaN: true }), function (current, target, lambda) {
					let value = current;
					let steps = 0;
					while (value !== target && steps < 20_000) {
						value = helpers.damp(value, target, lambda, 1 / 60);
						steps++;
					}
					expect(value === target).toBe(true);
				})
			);
		});
	});

	describe('angleDifference and lerpAngle', function () {
		it('should give the congruent rotation in (-180, 180] (exactly, for integer angles)', function () {
			fc.assert(
				fc.property(smallInt, smallInt, function (from, to) {
					const difference = helpers.angleDifference(from, to);
					expect(difference).toBeGreaterThan(-180);
					expect(difference).toBeLessThanOrEqual(180);
					expect(helpers.modulo(from + difference - to, 360)).toBe(0);
					if (difference !== 180) expect(helpers.angleDifference(to, from)).toBe(-difference + 0);
				})
			);
		});

		it('should give a rotation in (-π, π] congruent up to rounding, in radians', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, function (from, to) {
					const difference = helpers.angleDifference(from, to, 2 * Math.PI);
					expect(difference).toBeGreaterThan(-Math.PI);
					expect(difference).toBeLessThanOrEqual(Math.PI);
					expect(Math.abs(helpers.angleDifference(from + difference, to, 2 * Math.PI))).toBeLessThan(1e-9);
				})
			);
		});

		it('should start at start, end at an angle congruent to end, and never go more than a half turn away', function () {
			fc.assert(
				fc.property(smallInt, smallInt, unit, function (start, end, t) {
					expect(helpers.lerpAngle(start, end, 0)).toBe(start);
					expect(helpers.modulo(helpers.lerpAngle(start, end, 1) - end, 360)).toBe(0);
					expect(Math.abs(helpers.lerpAngle(start, end, t) - start)).toBeLessThanOrEqual(180);
				})
			);
		});
	});

	describe('pingPong', function () {
		const length = fc.integer({ min: 1, max: 1000 });

		it('should equal the triangle wave for integers, and be even and periodic', function () {
			fc.assert(
				fc.property(smallInt, length, function (value, top) {
					const result = helpers.pingPong(value, top);
					expect(result).toBe(top - Math.abs(helpers.modulo(value, 2 * top) - top));
					expect(helpers.pingPong(-value, top)).toBe(result);
					expect(helpers.pingPong(value + 2 * top, top)).toBe(result);
				})
			);
		});

		it('should stay in [0, length]', function () {
			fc.assert(
				fc.property(
					fc.double({ noNaN: true, noDefaultInfinity: true }),
					fc.double({ min: Number.MIN_VALUE, max: Number.MAX_VALUE, noNaN: true }),
					function (value, top) {
						const result = helpers.pingPong(value, top);
						expect(result).toBeGreaterThanOrEqual(0);
						expect(result).toBeLessThanOrEqual(top);
					}
				)
			);
		});
	});

	describe('linspace', function () {
		const anyFinite = fc.double({ noNaN: true, noDefaultInfinity: true });
		const count = fc.integer({ min: 0, max: 200 });

		it('should have exact endpoints and monotonic values within the bounds', function () {
			fc.assert(
				fc.property(anyFinite, anyFinite, count, fc.boolean(), function (start, end, n, endpoint) {
					const values = helpers.linspace(start, end, n, { endpoint });
					expect(values).toHaveLength(n);
					if (n === 0) return;
					expect(values[0]).toBe(start);
					if (endpoint && n > 1) expect(values[n - 1]).toBe(end);
					const direction = start <= end ? 1 : -1;
					for (let i = 0; i < n; i++) {
						expect(values[i]).toBeGreaterThanOrEqual(Math.min(start, end));
						expect(values[i]).toBeLessThanOrEqual(Math.max(start, end));
						if (i > 0) expect((values[i] - values[i - 1]) * direction).toBeGreaterThanOrEqual(0);
					}
				})
			);
		});

		it('should exclude the endpoint like the first n values of n + 1', function () {
			fc.assert(
				fc.property(anyFinite, anyFinite, fc.integer({ min: 1, max: 100 }), function (start, end, n) {
					expect(helpers.linspace(start, end, n, { endpoint: false })).toEqual(helpers.linspace(start, end, n + 1).slice(0, n));
				})
			);
		});

		it('should be evenly spaced up to rounding', function () {
			fc.assert(
				fc.property(finiteDouble, finiteDouble, fc.integer({ min: 2, max: 100 }), function (start, end, n) {
					const values = helpers.linspace(start, end, n);
					for (let i = 0; i < n; i++) {
						expect(Math.abs(values[i] - (start + ((end - start) * i) / (n - 1)))).toBeLessThanOrEqual(4 * Number.EPSILON * (Math.abs(start) + Math.abs(end)));
					}
				})
			);
		});
	});

	describe('ticks and niceDomain', function () {
		/** d3-array 3.2's `ticks` (ISC license), the reference. */
		function d3Ticks(start: number, stop: number, count: number): number[] {
			const e10 = Math.sqrt(50);
			const e5 = Math.sqrt(10);
			const e2 = Math.sqrt(2);
			function tickSpec(low: number, high: number, n: number): [number, number, number] {
				const step = (high - low) / Math.max(0, n);
				const power = Math.floor(Math.log10(step));
				const error = step / Math.pow(10, power);
				const factor = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1;
				let i1: number;
				let i2: number;
				let inc: number;
				if (power < 0) {
					inc = Math.pow(10, -power) / factor;
					i1 = Math.round(low * inc);
					i2 = Math.round(high * inc);
					if (i1 / inc < low) ++i1;
					if (i2 / inc > high) --i2;
					inc = -inc;
				} else {
					inc = Math.pow(10, power) * factor;
					i1 = Math.round(low / inc);
					i2 = Math.round(high / inc);
					if (i1 * inc < low) ++i1;
					if (i2 * inc > high) --i2;
				}
				if (i2 < i1 && 0.5 <= n && n < 2) return tickSpec(low, high, n * 2);
				return [i1, i2, inc];
			}
			if (start === stop) return [start];
			const reverse = stop < start;
			const [i1, i2, inc] = reverse ? tickSpec(stop, start, count) : tickSpec(start, stop, count);
			if (!(i2 >= i1)) return [];
			const n = i2 - i1 + 1;
			const result = new Array<number>(n);
			if (reverse) {
				if (inc < 0) for (let i = 0; i < n; ++i) result[i] = (i2 - i) / -inc;
				else for (let i = 0; i < n; ++i) result[i] = (i2 - i) * inc;
			} else {
				if (inc < 0) for (let i = 0; i < n; ++i) result[i] = (i1 + i) / -inc;
				else for (let i = 0; i < n; ++i) result[i] = (i1 + i) * inc;
			}
			return result.map(function (tick) {
				return tick + 0;
			});
		}

		/** A domain whose width is not negligible next to its bounds (where d3's ticks are not distinct). */
		const domain = fc
			.tuple(fc.double({ min: -1e9, max: 1e9, noNaN: true }), fc.double({ min: -1e9, max: 1e9, noNaN: true }), fc.integer({ min: 1, max: 60 }))
			.filter(function ([a, b]) {
				return Math.abs(b - a) > 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-300);
			});

		it('should match d3-array', function () {
			fc.assert(
				fc.property(domain, function ([start, stop, count]) {
					expect(helpers.ticks(start, stop, count)).toEqual(d3Ticks(start, stop, count));
				})
			);
		});

		it('should give evenly spaced, strictly monotonic ticks inside the domain, about count of them', function () {
			fc.assert(
				fc.property(domain, function ([start, stop, count]) {
					const values = helpers.ticks(start, stop, count);
					const direction = start <= stop ? 1 : -1;
					expect(values.length).toBeLessThanOrEqual(1.6 * count + 1);
					expect(values.length).toBeGreaterThanOrEqual(count / 1.6 - 1);
					for (let i = 0; i < values.length; i++) {
						expect(values[i]).toBeGreaterThanOrEqual(Math.min(start, stop));
						expect(values[i]).toBeLessThanOrEqual(Math.max(start, stop));
						if (i > 0) expect((values[i] - values[i - 1]) * direction).toBeGreaterThan(0);
						if (i > 1) expect(values[i] - values[i - 1]).toBeCloseTo(values[1] - values[0], 6);
					}
				})
			);
		});

		it('should stay inside any finite domain, strictly monotonic', function () {
			const anyFinite = fc.double({ noNaN: true, noDefaultInfinity: true });
			fc.assert(
				fc.property(anyFinite, anyFinite, fc.double({ min: 0.1, max: 2000, noNaN: true }), function (start, stop, count) {
					const values = helpers.ticks(start, stop, count);
					// A step capped at 1e308 gives up to 4 ticks over the whole range of doubles.
					expect(values.length).toBeLessThanOrEqual(Math.max(1.6 * count + 2, 4));
					for (let i = 0; i < values.length; i++) {
						expect(values[i]).toBeGreaterThanOrEqual(Math.min(start, stop));
						expect(values[i]).toBeLessThanOrEqual(Math.max(start, stop));
						if (i > 0) expect(start <= stop ? values[i] > values[i - 1] : values[i] < values[i - 1]).toBe(true);
					}
				})
			);
		});

		it('should contain the domain, keep its direction, and be idempotent', function () {
			const anyFinite = fc.double({ noNaN: true, noDefaultInfinity: true });
			fc.assert(
				fc.property(anyFinite, anyFinite, fc.integer({ min: 1, max: 60 }), function (start, stop, count) {
					const [niceStart, niceStop] = helpers.niceDomain(start, stop, count);
					expect(Math.min(niceStart, niceStop)).toBeLessThanOrEqual(Math.min(start, stop));
					expect(Math.max(niceStart, niceStop)).toBeGreaterThanOrEqual(Math.max(start, stop));
					expect(niceStart <= niceStop).toBe(start <= stop);
					expect(helpers.niceDomain(stop, start, count)).toEqual([niceStop, niceStart]);
				})
			);
		});

		it('should give bounds that are the first and last ticks (for 2 ticks or more)', function () {
			fc.assert(
				fc.property(domain, function ([start, stop, count]) {
					// With fewer, the nice bounds widen the domain enough to double the step, every round (as in d3).
					fc.pre(count >= 2);
					const [niceStart, niceStop] = helpers.niceDomain(start, stop, count);
					const values = helpers.ticks(niceStart, niceStop, count);
					expect(values[0]).toBe(niceStart);
					expect(values[values.length - 1]).toBe(niceStop);
					expect(helpers.niceDomain(niceStart, niceStop, count)).toEqual([niceStart, niceStop]);
				})
			);
		});
	});

	describe('dot, norm, distance and cosineSimilarity', function () {
		function first(pair: [number, number]): number {
			return pair[0];
		}

		function second(pair: [number, number]): number {
			return pair[1];
		}

		/** Doubles with at most 50 significant bits after the binary point of 2 ** -20: their products are exact rationals over 2 ** 40. */
		const fixed = fc.integer({ min: -(2 ** 30), max: 2 ** 30 }).map(function (n) {
			return n / 2 ** 20;
		});
		const pairs = fc.array(fc.tuple(fixed, fixed), { maxLength: 20 });

		it('should be as accurate as twice the precision of doubles (against an exact BigInt reference)', function () {
			fc.assert(
				fc.property(pairs, function (list) {
					const xs = list.map(first);
					const ys = list.map(second);
					let numerator = 0n;
					let absolute = 0;
					for (const [x, y] of list) {
						numerator += BigInt(x * 2 ** 20) * BigInt(y * 2 ** 20);
						absolute += Math.abs(x * y);
					}
					const exact = Number(numerator) / 2 ** 40;
					expect(Math.abs(helpers.dot(xs, ys) - exact)).toBeLessThanOrEqual(Math.abs(exact) * Number.EPSILON + absolute * 2 ** -95);
				})
			);
		});

		it('should cancel exactly where the plain loop loses everything', function () {
			fc.assert(
				fc.property(fixed, fc.integer({ min: 30, max: 300 }), function (small, power) {
					const big = 2 ** power;
					expect(helpers.dot([big, small, -big], [1, 1, 1])).toBe(small);
					expect(helpers.dot([big, small, big], [big, 1, -big])).toBe(small);
				})
			);
		});

		it('should be symmetric, odd and scale exactly by powers of two', function () {
			fc.assert(
				fc.property(pairs, fc.integer({ min: -20, max: 20 }), function (list, power) {
					const xs = list.map(first);
					const ys = list.map(second);
					const product = helpers.dot(xs, ys);
					expect(helpers.dot(ys, xs)).toBe(product);
					expect(
						helpers.dot(
							xs.map(function (x) {
								return -x;
							}),
							ys
						)
					).toBe(-product + 0);
					expect(
						helpers.dot(
							xs.map(function (x) {
								return x * 2 ** power;
							}),
							ys
						)
					).toBe(product * 2 ** power);
				})
			);
		});

		const vector = fc.array(finiteDouble, { minLength: 1, maxLength: 20 });

		it('should give the length of Math.hypot (within an ulp), scaled exactly by powers of two', function () {
			fc.assert(
				fc.property(vector, fc.integer({ min: -900, max: 900 }), function (xs, power) {
					const length = helpers.norm(xs);
					expect(Math.abs(length - Math.hypot(...xs))).toBeLessThanOrEqual(2 * Number.EPSILON * length);
					// Subnormal lengths are rounded more coarsely than their doubled or halved counterparts.
					fc.pre(length > 1e-290 && length * 2 ** power > 1e-290);
					expect(
						helpers.norm(
							xs.map(function (x) {
								return x * 2 ** power;
							})
						)
					).toBe(length * 2 ** power);
				})
			);
		});

		it('should give a symmetric distance, the length of the difference, with the triangle inequality', function () {
			const points = fc.integer({ min: 1, max: 10 }).chain(function (n) {
				const point = fc.array(finiteDouble, { minLength: n, maxLength: n });
				return fc.tuple(point, point, point);
			});
			fc.assert(
				fc.property(points, function ([a, b, c]) {
					const ab = helpers.distance(a, b);
					expect(helpers.distance(b, a)).toBe(ab);
					expect(ab).toBe(
						helpers.norm(
							a.map(function (value, i) {
								return value - b[i];
							})
						)
					);
					expect(helpers.distance(a, c)).toBeLessThanOrEqual((ab + helpers.distance(b, c)) * (1 + 4 * Number.EPSILON));
				})
			);
		});

		it('should give a symmetric, odd, scale-invariant cosine in [-1, 1]', function () {
			fc.assert(
				fc.property(pairs, fc.integer({ min: -500, max: 500 }), fc.double({ min: 1e-3, max: 1e3, noNaN: true }), function (list, power, factor) {
					const xs = list.map(first);
					const ys = list.map(second);
					const cosine = helpers.cosineSimilarity(xs, ys);
					fc.pre(!Number.isNaN(cosine));
					expect(cosine).toBeGreaterThanOrEqual(-1);
					expect(cosine).toBeLessThanOrEqual(1);
					expect(helpers.cosineSimilarity(ys, xs)).toBe(cosine);
					const negated = ys.map(function (y) {
						return -y;
					});
					expect(helpers.cosineSimilarity(xs, negated)).toBe(-cosine + 0);
					const scaled = xs.map(function (x) {
						return x * 2 ** power;
					});
					expect(helpers.cosineSimilarity(scaled, ys)).toBe(cosine);
					const stretched = xs.map(function (x) {
						return x * factor;
					});
					expect(helpers.cosineSimilarity(stretched, ys)).toBeCloseTo(cosine, 12);
					expect(helpers.cosineSimilarity(xs, xs)).toBeCloseTo(1, 15);
				})
			);
		});
	});
});

describe('Statistics helpers (property-based)', function () {
	const positive = fc.double({ min: 1e-3, max: 1e6, noNaN: true });
	const positiveArray = fc.array(positive, { minLength: 1, maxLength: 40 });
	const anyNumber = fc.oneof(fc.double(), fc.constantFrom(0, -0, NaN, Infinity, -Infinity));
	const nonConstantInts = fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 4, maxLength: 40 }).filter(function (numbers) {
		return numbers.some(function (value) {
			return value !== numbers[0];
		});
	});

	/**
	 * Whether `a <= b`, up to a relative tolerance for rounding.
	 * @param {number} a - The smaller value
	 * @param {number} b - The larger value
	 * @returns {boolean} `a <= b * (1 + 1e-12)`
	 */
	function atMost(a: number, b: number): boolean {
		return a <= b * (1 + 1e-12);
	}

	describe('harmonicMean, geometricMean, average and rootMeanSquare', function () {
		it('should be ordered HM <= GM <= AM <= RMS, within the range of the values', function () {
			fc.assert(
				fc.property(positiveArray, function (numbers) {
					const hm = helpers.harmonicMean(numbers);
					const gm = helpers.geometricMean(numbers);
					const am = helpers.average(numbers);
					const rms = helpers.rootMeanSquare(numbers);
					expect(atMost(hm, gm) && atMost(gm, am) && atMost(am, rms)).toBe(true);
					expect(atMost(helpers.min(numbers), hm) && atMost(rms, helpers.max(numbers))).toBe(true);
				})
			);
		});

		it('should give back a repeated value (exactly for the harmonic mean)', function () {
			fc.assert(
				fc.property(fc.double({ min: 5e-324, max: Number.MAX_VALUE, noNaN: true }), fc.integer({ min: 1, max: 20 }), function (value, count) {
					const numbers = new Array<number>(count).fill(value);
					expect(helpers.harmonicMean(numbers)).toBe(value);
					expect(helpers.geometricMean(numbers) / value).toBeCloseTo(1, 13);
					expect(helpers.rootMeanSquare(numbers) / value).toBeCloseTo(1, 14);
				})
			);
		});
	});

	describe('geometricMean', function () {
		it('should be exact for powers of two whose exponents average to an integer', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -300, max: 300 }), { maxLength: 7 }), fc.integer({ min: -300, max: 300 }), function (exponents, mean) {
					const last = mean * (exponents.length + 1) - helpers.sum(exponents);
					fc.pre(last >= -1074 && last <= 1023);
					const numbers = exponents.concat(last).map(function (exponent) {
						return 2 ** exponent;
					});
					expect(helpers.geometricMean(numbers)).toBe(2 ** mean);
				})
			);
		});

		it('should equal exp(mean(log x)) up to rounding', function () {
			fc.assert(
				fc.property(positiveArray, function (numbers) {
					const reference = Math.exp(
						helpers.average(
							numbers.map(function (value) {
								return Math.log(value);
							})
						)
					);
					expect(helpers.geometricMean(numbers) / reference).toBeCloseTo(1, 12);
				})
			);
		});
	});

	describe('rootMeanSquare', function () {
		it('should equal the naive formula and ignore signs', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					const naive = Math.sqrt(
						helpers.average(
							numbers.map(function (value) {
								return value * value;
							})
						)
					);
					const rms = helpers.rootMeanSquare(numbers);
					// The naive squares of the tiniest values underflow.
					expect(Math.abs(rms - naive)).toBeLessThanOrEqual(naive * 1e-14 + 1e-150);
					expect(
						helpers.rootMeanSquare(
							numbers.map(function (value) {
								return -value;
							})
						)
					).toBe(rms);
				})
			);
		});
	});

	describe('skewness and kurtosis', function () {
		it('should flip the sign of the skewness under negation and keep the kurtosis', function () {
			fc.assert(
				fc.property(fc.array(finiteDouble, { minLength: 4, maxLength: 40 }), fc.boolean(), function (numbers, sample) {
					const negated = numbers.map(function (value) {
						return -value;
					});
					expect(helpers.skewness(negated, { sample }) + 0).toBe(-helpers.skewness(numbers, { sample }) + 0);
					expect(Object.is(helpers.kurtosis(negated, { sample }), helpers.kurtosis(numbers, { sample }))).toBe(true);
				})
			);
		});

		it('should not change when every value is scaled by a power of two', function () {
			// Away from the subnormals, where scaling would round.
			const moderate = fc.oneof(fc.constant(0), fc.double({ min: 1e-6, max: 1e6, noNaN: true }), fc.double({ min: -1e6, max: -1e-6, noNaN: true }));
			fc.assert(
				fc.property(fc.array(moderate, { minLength: 4, maxLength: 40 }), fc.integer({ min: -900, max: 900 }), function (numbers, exponent) {
					const scaled = numbers.map(function (value) {
						return value * 2 ** exponent;
					});
					expect(Object.is(helpers.skewness(scaled), helpers.skewness(numbers))).toBe(true);
					expect(Object.is(helpers.kurtosis(scaled), helpers.kurtosis(numbers))).toBe(true);
				})
			);
		});

		it('should be invariant under positive affine maps (the skewness changes sign with a negative factor)', function () {
			fc.assert(
				fc.property(
					nonConstantInts,
					fc.integer({ min: -100, max: 100 }).filter(function (factor) {
						return factor !== 0;
					}),
					fc.integer({ min: -1e6, max: 1e6 }),
					function (numbers, factor, shift) {
						const mapped = numbers.map(function (value) {
							return factor * value + shift;
						});
						expect(helpers.skewness(mapped)).toBeCloseTo(Math.sign(factor) * helpers.skewness(numbers), 9);
						expect(helpers.kurtosis(mapped)).toBeCloseTo(helpers.kurtosis(numbers), 9);
						expect(helpers.kurtosis(mapped, { sample: true })).toBeCloseTo(helpers.kurtosis(numbers, { sample: true }), 9);
					}
				)
			);
		});

		it('should match the textbook formulas, and the kurtosis be at least -2', function () {
			fc.assert(
				fc.property(nonConstantInts, function (numbers) {
					const n = numbers.length;
					const mean = helpers.average(numbers);
					/**
					 * The `k`-th central moment, naively.
					 * @param {number} k - The order
					 * @returns {number} `Σ(x - mean)^k / n`
					 */
					function moment(k: number): number {
						return (
							helpers.sum(
								numbers.map(function (value) {
									return (value - mean) ** k;
								})
							) / n
						);
					}
					const g1 = moment(3) / moment(2) ** 1.5;
					const g2 = moment(4) / moment(2) ** 2 - 3;
					expect(helpers.skewness(numbers)).toBeCloseTo(g1, 9);
					expect(helpers.skewness(numbers, { sample: true })).toBeCloseTo((g1 * Math.sqrt(n * (n - 1))) / (n - 2), 9);
					expect(helpers.kurtosis(numbers)).toBeCloseTo(g2, 9);
					expect(helpers.kurtosis(numbers)).toBeGreaterThanOrEqual(-2 - 1e-12);
				})
			);
		});
	});

	describe('ranks', function () {
		it('should equal the naive fractional ranking, adding up to n(n + 1) / 2', function () {
			const element = fc.oneof(fc.integer({ min: -5, max: 5 }), fc.constantFrom(0, -0, NaN, Infinity, -Infinity));
			fc.assert(
				fc.property(fc.array(element, { maxLength: 40 }), function (numbers) {
					const result = helpers.ranks(numbers);
					const ranked = numbers.filter(function (value) {
						return value === value;
					});
					numbers.forEach(function (value, index) {
						if (value !== value) {
							expect(result[index]).toBeNaN();
							return;
						}
						const below = ranked.filter(function (other) {
							return other < value;
						}).length;
						const equal = ranked.filter(function (other) {
							return other === value;
						}).length;
						expect(result[index]).toBe(below + (equal + 1) / 2);
					});
					const total = helpers.sum(
						result.filter(function (rank) {
							return rank === rank;
						})
					);
					expect(total).toBe((ranked.length * (ranked.length + 1)) / 2);
				})
			);
		});
	});

	describe('spearmanCorrelation', function () {
		it('should not change under strictly increasing maps, and be in [-1, 1]', function () {
			fc.assert(
				fc.property(
					fc.array(fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 })), { minLength: 2, maxLength: 30 }),
					function (pairs) {
						const xs = pairs.map(function (pair) {
							return pair[0];
						});
						const ys = pairs.map(function (pair) {
							return pair[1];
						});
						const cubes = xs.map(function (value) {
							return value * value * value;
						});
						const rho = helpers.spearmanCorrelation(xs, ys);
						expect(Object.is(helpers.spearmanCorrelation(cubes, ys), rho)).toBe(true);
						expect(Object.is(rho, helpers.correlation(helpers.ranks(xs), helpers.ranks(ys)))).toBe(true);
						if (rho === rho) expect(Math.abs(rho)).toBeLessThanOrEqual(1);
					}
				)
			);
		});
	});

	describe('standardize', function () {
		it('should give scores with mean 0 and standard deviation 1', function () {
			fc.assert(
				fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 40 }), fc.boolean(), function (numbers, sample) {
					fc.pre(
						numbers.some(function (value) {
							return value !== numbers[0];
						})
					);
					const scores = helpers.standardize(numbers, { sample });
					expect(Math.abs(helpers.average(scores))).toBeLessThan(1e-9);
					expect(helpers.standardDeviation(scores, { sample })).toBeCloseTo(1, 9);
				})
			);
		});

		it('should preserve the order of the values', function () {
			fc.assert(
				fc.property(finiteArray, function (numbers) {
					const scores = helpers.standardize(numbers);
					for (let i = 1; i < numbers.length; i++) {
						if (numbers[i - 1] < numbers[i]) expect(scores[i - 1]).toBeLessThanOrEqual(scores[i]);
					}
				})
			);
		});
	});

	describe('softmax', function () {
		it('should give weights in [0, 1] that add up to 1, in the order of the scores', function () {
			fc.assert(
				fc.property(fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 40 }), function (numbers) {
					const weights = helpers.softmax(numbers);
					expect(helpers.sum(weights)).toBeCloseTo(1, 12);
					for (let i = 0; i < numbers.length; i++) {
						expect(weights[i] >= 0 && weights[i] <= 1).toBe(true);
						if (i > 0 && numbers[i - 1] < numbers[i]) expect(weights[i - 1]).toBeLessThanOrEqual(weights[i]);
					}
				})
			);
		});

		it('should be invariant under shifts', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 40 }), fc.integer({ min: -1e6, max: 1e6 }), function (numbers, shift) {
					const shifted = numbers.map(function (value) {
						return value + shift;
					});
					expect(helpers.softmax(shifted)).toEqual(helpers.softmax(numbers));
				})
			);
		});
	});

	describe('exponentialMovingAverage', function () {
		it('should follow the recurrence α·x + (1 - α)·previous', function () {
			fc.assert(
				fc.property(finiteArray, fc.double({ min: 0, max: 1, minExcluded: true, noNaN: true }), function (numbers, alpha) {
					const result = helpers.exponentialMovingAverage(numbers, alpha);
					let previous = numbers[0];
					expect(result[0]).toBe(previous);
					for (let i = 1; i < numbers.length; i++) {
						previous = alpha * numbers[i] + (1 - alpha) * previous;
						expect(Math.abs(result[i] - previous)).toBeLessThanOrEqual(1e-6);
					}
				})
			);
		});

		it('should skip NaN values, as if they were not there', function () {
			fc.assert(
				fc.property(
					fc.array(fc.oneof(finiteDouble, fc.constant(NaN)), { maxLength: 40 }),
					fc.double({ min: 0, max: 1, minExcluded: true, noNaN: true }),
					function (numbers, alpha) {
						const result = helpers.exponentialMovingAverage(numbers, alpha);
						const present = numbers.filter(function (value) {
							return value === value;
						});
						const compact = helpers.exponentialMovingAverage(present, alpha);
						let seen = -1;
						numbers.forEach(function (value, index) {
							if (value === value) seen++;
							if (seen < 0) expect(result[index]).toBeNaN();
							else expect(result[index]).toBe(compact[seen]);
						});
					}
				)
			);
		});
	});

	describe('summarize', function () {
		it('should equal the individual helpers on any input', function () {
			fc.assert(
				fc.property(fc.array(anyNumber, { maxLength: 40 }), function (numbers) {
					const summary = helpers.summarize(numbers);
					expect(summary.count).toBe(numbers.length);
					expect(Object.is(summary.min, helpers.min(numbers))).toBe(true);
					expect(Object.is(summary.max, helpers.max(numbers))).toBe(true);
					expect(Object.is(summary.sum, helpers.sum(numbers))).toBe(true);
					expect(Object.is(summary.mean, helpers.average(numbers))).toBe(true);
					expect(Object.is(summary.median, helpers.median(numbers))).toBe(true);
					expect(Object.is(summary.q1, helpers.quantile(numbers, 0.25))).toBe(true);
					expect(Object.is(summary.q3, helpers.quantile(numbers, 0.75))).toBe(true);
					expect(Object.is(summary.variance, helpers.variance(numbers))).toBe(true);
					expect(Object.is(summary.standardDeviation, helpers.standardDeviation(numbers))).toBe(true);
				})
			);
		});
	});

	describe('trimmedMean', function () {
		it('should equal the average of the naively trimmed sorted values', function () {
			fc.assert(
				fc.property(intArray, fc.double({ min: 0, max: 0.5, maxExcluded: true, noNaN: true }), function (numbers, proportion) {
					const sorted = numbers.slice().sort(function (a, b) {
						return a - b;
					});
					const cut = Math.floor(numbers.length * proportion);
					expect(helpers.trimmedMean(numbers, proportion)).toBe(helpers.average(sorted.slice(cut, numbers.length - cut)));
					expect(helpers.trimmedMean(numbers, 0)).toBe(helpers.average(numbers));
				})
			);
		});
	});

	describe('medianAbsoluteDeviation', function () {
		it('should not change under shifts and negation', function () {
			fc.assert(
				fc.property(intArray, fc.integer({ min: -1e6, max: 1e6 }), function (numbers, shift) {
					const mad = helpers.medianAbsoluteDeviation(numbers);
					const shifted = numbers.map(function (value) {
						return value + shift;
					});
					const negated = numbers.map(function (value) {
						return -value;
					});
					expect(helpers.medianAbsoluteDeviation(shifted)).toBe(mad);
					expect(helpers.medianAbsoluteDeviation(negated)).toBe(mad);
				})
			);
		});
	});
});

/**
 * The position of a double in the order of the doubles, `0` and `-0` both at `0` (adjacent doubles are `1` apart).
 * @param {number} value - A number that is not NaN
 * @returns {bigint} Its position
 */
function orderOf(value: number): bigint {
	const bits = new BigInt64Array(new Float64Array([value]).buffer)[0];
	return bits < 0n ? -(bits + (1n << 63n)) : bits;
}

/**
 * The exact value of a finite double as a fraction of BigInts.
 * @param {number} value - A finite number
 * @returns {[bigint, bigint]} `[numerator, denominator]`, the denominator a power of two
 */
function exactFraction(value: number): [bigint, bigint] {
	let mantissa = value;
	let exponent = 0n;
	for (; !Number.isInteger(mantissa); exponent++) mantissa *= 2;
	return [BigInt(mantissa), 1n << exponent];
}

/**
 * Rounds the shortest decimal representation of a number to `decimals` places, ties to even, in exact BigInt arithmetic: a reference for
 * `roundHalfEven` written independently of it.
 * @param {number} value - A finite number
 * @param {number} decimals - The decimal places to keep, `>= 0`
 * @returns {number} The rounded number
 */
function referenceHalfEven(value: number, decimals: number): number {
	const [mantissa, exponent = '0'] = String(Math.abs(value)).split('e');
	const [whole, fraction = ''] = mantissa.split('.');
	// |value| = digits * 10 ** power.
	const digits = BigInt(whole + fraction);
	const power = Number(exponent) - fraction.length;
	const shift = power + decimals;
	let rounded: bigint;
	if (shift >= 0) {
		rounded = digits * 10n ** BigInt(shift);
	} else {
		const divisor = 10n ** BigInt(-shift);
		const quotient = digits / divisor;
		const twice = 2n * (digits % divisor);
		rounded = twice > divisor || (twice === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient;
	}
	const result = Number(`${rounded}e-${decimals}`);
	return 1 / value < 0 ? -result : result;
}

describe('Rounding and floating-point helpers (property-based)', function () {
	const decimals = fc.integer({ min: 0, max: 6 });
	// Values with up to 8 decimals, half of them ties (a last digit of 5).
	const decimalValue = fc.tuple(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 0, max: 8 }), fc.boolean()).map(function ([digits, places, tie]) {
		return Number(`${digits}${tie ? '5' : ''}e-${places + (tie ? 1 : 0)}`);
	});

	describe('roundHalfEven', function () {
		it('should equal an exact decimal reference', function () {
			fc.assert(
				fc.property(fc.oneof(decimalValue, finiteDouble), decimals, function (value, places) {
					expect(helpers.roundHalfEven(value, places)).toBe(referenceHalfEven(value, places));
				})
			);
		});

		it('should only differ from round on ties, by going to the even neighbour', function () {
			fc.assert(
				fc.property(fc.oneof(decimalValue, finiteDouble), decimals, function (value, places) {
					const even = helpers.roundHalfEven(value, places);
					const away = helpers.round(value, places);
					if (even !== away) {
						expect(helpers.decimalPlaces(value)).toBe(places + 1);
						expect(String(value).endsWith('5')).toBe(true);
						expect(Math.abs(even)).toBeLessThan(Math.abs(away));
						expect(BigInt(helpers.round(Math.abs(even) * 10 ** places)) % 2n).toBe(0n);
					}
				})
			);
		});

		it('should be idempotent and odd-symmetric', function () {
			fc.assert(
				fc.property(fc.oneof(decimalValue, finiteDouble), fc.integer({ min: -3, max: 6 }), function (value, places) {
					const rounded = helpers.roundHalfEven(value, places);
					expect(helpers.roundHalfEven(rounded, places)).toBe(rounded);
					expect(helpers.roundHalfEven(-value, places)).toBe(-rounded);
				})
			);
		});
	});

	describe('trunc', function () {
		it('should be floor for positive numbers and ceil for negative ones, never moving away from zero', function () {
			fc.assert(
				fc.property(fc.oneof(decimalValue, finiteDouble), fc.integer({ min: -3, max: 6 }), function (value, places) {
					const truncated = helpers.trunc(value, places);
					expect(truncated).toBe(1 / value < 0 ? helpers.ceil(value, places) : helpers.floor(value, places));
					expect(Math.abs(truncated)).toBeLessThanOrEqual(Math.abs(value));
					expect(truncated === 0 || Math.sign(truncated) === Math.sign(value)).toBe(true);
					expect(helpers.trunc(-value, places)).toBe(-truncated);
					expect(helpers.trunc(truncated, places)).toBe(truncated);
				})
			);
		});
	});

	describe('nextAfter and ulp', function () {
		const anyDouble = fc.double({ noNaN: true });

		it('should step to the adjacent double towards `to`', function () {
			fc.assert(
				fc.property(anyDouble, anyDouble, function (from, to) {
					const next = helpers.nextAfter(from, to);
					if (from === to) {
						expect(Object.is(next, to)).toBe(true);
					} else {
						expect(orderOf(next) - orderOf(from)).toBe(to > from ? 1n : -1n);
						expect(next > from).toBe(to > from);
					}
				})
			);
		});

		it('should step back to where it started', function () {
			fc.assert(
				fc.property(anyDouble, function (value) {
					fc.pre(value !== 0 && Math.abs(value) < Infinity);
					expect(helpers.nextAfter(helpers.nextAfter(value, Infinity), -Infinity)).toBe(value);
					expect(helpers.nextAfter(helpers.nextAfter(value, -Infinity), Infinity)).toBe(value);
				})
			);
		});

		it('should give the gap to the next larger double, a power of two', function () {
			fc.assert(
				fc.property(anyDouble, function (value) {
					const magnitude = Math.abs(value);
					fc.pre(magnitude < Number.MAX_VALUE);
					const gap = helpers.ulp(value);
					expect(gap).toBe(helpers.nextAfter(magnitude, Infinity) - magnitude);
					expect(Number.isInteger(Math.log2(gap))).toBe(true);
					expect(gap).toBeLessThanOrEqual(Math.max(magnitude * Number.EPSILON, Number.MIN_VALUE));
				})
			);
		});
	});

	describe('decimalPlaces', function () {
		it('should give the digits that the shortest representation needs', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), function (value) {
					const places = helpers.decimalPlaces(value);
					expect(Number.isInteger(places) && places >= 0).toBe(true);
					// `toFixed` writes the same number with that many places, and with one place fewer it is a different number.
					if (places <= 100) {
						expect(Number(value.toFixed(places)) === value).toBe(true);
						if (places > 0) expect(Number(value.toFixed(places - 1)) === value).toBe(false);
					}
				})
			);
		});
	});

	describe('toFraction', function () {
		it('should give back fractions with small denominators exactly, in lowest terms', function () {
			fc.assert(
				fc.property(fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: 1, max: 1000 }), function (numerator, denominator) {
					const divisor = helpers.gcd(numerator, denominator);
					expect(helpers.toFraction(numerator / denominator)).toEqual([numerator / divisor + 0, denominator / divisor]);
				})
			);
		});

		it('should be in lowest terms, within the limit, and odd-symmetric', function () {
			fc.assert(
				fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.integer({ min: 1, max: 1e9 }), function (value, limit) {
					const [numerator, denominator] = helpers.toFraction(value, limit);
					expect(denominator >= 1 && denominator <= limit).toBe(true);
					expect(helpers.gcd(numerator, denominator)).toBe(1);
					expect(helpers.toFraction(-value, limit)).toEqual([-numerator + 0, denominator]);
				})
			);
		});

		it('should be at least as close as any fraction within the limit (brute force)', function () {
			fc.assert(
				fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.integer({ min: 1, max: 60 }), function (value, limit) {
					const [numerator, denominator] = helpers.toFraction(value, limit);
					const [n, d] = exactFraction(value);
					// |value - p / q| as the fraction |n * q - p * d| / (d * q), compared by cross-multiplication.
					function distance(p: bigint, q: bigint): [bigint, bigint] {
						const difference = n * q - p * d;
						return [difference < 0n ? -difference : difference, d * q];
					}
					const [best, bestDenominator] = distance(BigInt(numerator), BigInt(denominator));
					for (let q = 1n; q <= BigInt(limit); q++) {
						// The two fractions with denominator `q` around the value.
						const floor = (n * q) / d - (n < 0n && (n * q) % d !== 0n ? 1n : 0n);
						for (const p of [floor, floor + 1n]) {
							const [other, otherDenominator] = distance(p, q);
							expect(best * otherDenominator <= other * bestDenominator).toBe(true);
						}
					}
				})
			);
		});
	});

	describe('percentageChange', function () {
		const value = fc.double({ min: -1e5, max: 1e5, noNaN: true });

		it('should have the sign of the difference, and be 0 without change', function () {
			fc.assert(
				fc.property(value, value, function (from, to) {
					fc.pre(from !== 0);
					expect(Math.sign(helpers.percentageChange(from, to)) || 0).toBe(Math.sign(to - from) || 0);
					expect(helpers.percentageChange(from, from)).toBe(0);
				})
			);
		});

		it('should not depend on the scale, even where the difference overflows', function () {
			fc.assert(
				fc.property(value, value, fc.integer({ min: -1000, max: 1000 }), function (from, to, exponent) {
					fc.pre(Math.abs(from) >= 1e-3);
					const scale = 2 ** exponent;
					fc.pre(Number.isFinite(from * scale) && Number.isFinite(to * scale) && Math.abs(from * scale) >= 2 ** -1000);
					fc.pre(Math.abs(to * scale) >= 2 ** -1000 || to === 0);
					expect(helpers.percentageChange(from * scale, to * scale)).toBe(helpers.percentageChange(from, to));
				})
			);
		});
	});

	describe('findRoot', function () {
		// Functions whose computed sign is exactly the sign of `x - t` (the difference of two different doubles is never rounded to 0, and
		// nothing underflows to 0 after it): their only sign change is at `t`.
		const shapes: ReadonlyArray<(x: number, t: number) => number> = [
			function (x, t) {
				return x - t;
			},
			function (x, t) {
				return (x - t) * 2 ** 1000;
			},
			function (x, t) {
				return Math.atan(x - t);
			},
			function (x, t) {
				return Math.cbrt(x - t) * 1e300;
			},
			function (x, t) {
				return x < t ? -1 : 1;
			},
			function (x, t) {
				return x < t ? -Infinity : (x - t) * 1e300;
			}
		];
		const finite = fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ min: -100, max: 100, noNaN: true }));

		it('should find the sign change within the tolerance', function () {
			fc.assert(
				fc.property(
					fc.tuple(finite, finite, finite),
					fc.nat({ max: shapes.length - 1 }),
					fc.oneof(fc.constant(0), fc.double({ min: 0, max: 1e3, noNaN: true })),
					function (points, shape, tolerance) {
						const [lower, t, upper] = [...points].sort(function (a, b) {
							return a - b;
						});
						fc.pre(lower < t && t < upper);
						let calls = 0;
						const root = helpers.findRoot(
							function (x) {
								calls++;
								return shapes[shape](x, t);
							},
							lower,
							upper,
							{ tolerance }
						);
						expect(root >= lower && root <= upper).toBe(true);
						expect(Math.abs(root - t)).toBeLessThanOrEqual(tolerance + 4 * Number.EPSILON * Math.max(Math.abs(root), Math.abs(t)) + 2 * Number.MIN_VALUE);
						expect(calls).toBeLessThanOrEqual(300);
					}
				)
			);
		});

		it('should find a root of a polynomial bracketing a sign change, as precisely as doubles allow', function () {
			fc.assert(
				fc.property(fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: 2, maxLength: 6 }), finite, finite, function (coefficients, a, b) {
					function polynomial(x: number): number {
						let result = 0;
						for (const coefficient of coefficients) result = result * x + coefficient;
						return result;
					}
					const lower = helpers.clamp(Math.min(a, b), -1e3, 1e3);
					const upper = helpers.clamp(Math.max(a, b), -1e3, 1e3);
					fc.pre(Math.sign(polynomial(lower)) * Math.sign(polynomial(upper)) < 0);
					const root = helpers.findRoot(polynomial, lower, upper);
					expect(root >= lower && root <= upper).toBe(true);
					// The polynomial (as computed) is zero at the root or changes sign within 4 epsilons of it: some double that close has the
					// other sign.
					const sign = Math.sign(polynomial(root));
					const reach = 4 * Number.EPSILON * Math.abs(root) + Number.MIN_VALUE;
					let found = sign === 0;
					for (const direction of [-Infinity, Infinity]) {
						for (let x = helpers.nextAfter(root, direction); !found && Math.abs(x - root) <= reach; x = helpers.nextAfter(x, direction)) {
							found = Math.sign(polynomial(x)) !== sign;
						}
					}
					expect(found).toBe(true);
				})
			);
		});
	});
});
