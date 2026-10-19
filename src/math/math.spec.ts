import * as helpers from '.';

function constant(value: number) {
	return function () {
		return value;
	};
}

const ALMOST_ONE = 1 - 2 ** -53;

describe('Math helpers', function () {
	describe('sum', function () {
		it('should calculate the sum of an array of numbers', function () {
			expect(helpers.sum([1, 2, 3, 4])).toBe(10);
			expect(helpers.sum([-1, -2, -3, -4])).toBe(-10);
			expect(helpers.sum([0, 0, 0, 0])).toBe(0);
		});

		it('should return 0 for an empty array', function () {
			expect(helpers.sum([])).toBe(0);
		});

		it('should stay exact for int32 values, also after a non-integer and on long arrays', function () {
			expect(helpers.sum([2 ** 31 - 1, 2 ** 31 - 1, -(2 ** 31)])).toBe(2 ** 31 - 2);
			expect(helpers.sum([1, 2, 0.5, 2 ** 31 - 1, 1e100, -1e100])).toBe(2 ** 31 + 2.5);
			const many = new Array(2 ** 21 + 1).fill(2 ** 31 - 1);
			many[0] = 0.5;
			many[1] = -0.5;
			expect(helpers.sum(many)).toBe((2 ** 21 - 1) * (2 ** 31 - 1));
			expect(helpers.sum(new Array(2 ** 21 + 1).fill(-1))).toBe(-(2 ** 21) - 1);
		});

		it('should compensate floating-point rounding errors', function () {
			expect(helpers.sum([0.1, 0.2, 0.3])).toBe(0.6);
			expect(helpers.sum([1e100, 1, -1e100])).toBe(1);
			expect(helpers.sum([1, 1e100, 1, -1e100])).toBe(2);
			expect(helpers.sum(new Array(10).fill(0.1))).toBe(1);
		});

		it('should be order-independent for typical inputs', function () {
			expect(helpers.sum([0.3, 0.2, 0.1])).toBe(helpers.sum([0.1, 0.2, 0.3]));
		});

		it('should propagate non-finite values', function () {
			expect(helpers.sum([1, Infinity])).toBe(Infinity);
			expect(helpers.sum([-Infinity, 1])).toBe(-Infinity);
			expect(helpers.sum([Infinity, -Infinity])).toBeNaN();
			expect(helpers.sum([1, NaN])).toBeNaN();
			expect(helpers.sum([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Infinity);
		});

		it('should accept readonly arrays and not mutate them', function () {
			const input: ReadonlyArray<number> = Object.freeze([1, 2, 3]);
			expect(helpers.sum(input)).toBe(6);
		});
	});

	describe('round', function () {
		it('should round values whose first kept digit is past the significant digits', function () {
			expect(helpers.round(5e-7, 6)).toBe(0.000001);
			expect(helpers.round(4e-7, 6)).toBe(0);
		});

		it('should round a number to a specified number of decimal places', function () {
			expect(helpers.round(1.2345, 2)).toBe(1.23);
			expect(helpers.round(1.2355, 2)).toBe(1.24);
			expect(helpers.round(-1.2345, 2)).toBe(-1.23);
		});

		it('should default to 0 decimals', function () {
			expect(helpers.round(1.4)).toBe(1);
			expect(helpers.round(1.5)).toBe(2);
		});

		it('should round decimal representations correctly', function () {
			expect(helpers.round(1.005, 2)).toBe(1.01);
			expect(helpers.round(1.255, 2)).toBe(1.26);
			expect(helpers.round(8.345, 2)).toBe(8.35);
		});

		it('should round half away from zero (symmetric for negatives)', function () {
			expect(helpers.round(2.5)).toBe(3);
			expect(helpers.round(-2.5)).toBe(-3);
			expect(helpers.round(-0.5)).toBe(-1);
			expect(helpers.round(-1.235, 2)).toBe(-1.24);
			expect(helpers.round(1.235, 2)).toBe(1.24);
		});

		it('should handle numbers whose string form is exponential', function () {
			expect(helpers.round(1e-7, 2)).toBe(0);
			expect(helpers.round(1.5e-7, 7)).toBe(2e-7);
			expect(helpers.round(1e21, 2)).toBe(1e21);
			expect(helpers.round(1.23456e25, 2)).toBe(1.23456e25);
			expect(helpers.round(Number.MAX_VALUE, 2)).toBe(Number.MAX_VALUE);
			expect(helpers.round(Number.MIN_VALUE, 2)).toBe(0);
		});

		it('should be the identity when the number already has fewer decimals than requested', function () {
			expect(helpers.round(1.5, 400)).toBe(1.5);
			expect(helpers.round(-1.5, 400)).toBe(-1.5);
			// Shifting 17 significant digits by 20 places and back used to change the last one (…148 → …146).
			expect(helpers.round(1.1773748397827148, 20)).toBe(1.1773748397827148);
			expect(helpers.round(-1.1773748397827148, 17)).toBe(-1.1773748397827148);
			expect(helpers.round(123.5, 1)).toBe(123.5);
		});

		it('should support negative decimals', function () {
			expect(helpers.round(1234, -2)).toBe(1200);
			expect(helpers.round(1250, -2)).toBe(1300);
			expect(helpers.round(-1250, -2)).toBe(-1300);
			expect(helpers.round(5, -400)).toBe(0);
		});

		it('should preserve the sign of zero', function () {
			expect(helpers.round(0, 2)).toBe(0);
			expect(helpers.round(-0, 2)).toBe(-0);
			expect(helpers.round(-0.001, 2)).toBe(-0);
		});

		it('should return non-finite input as-is', function () {
			expect(helpers.round(NaN, 2)).toBeNaN();
			expect(helpers.round(Infinity, 2)).toBe(Infinity);
			expect(helpers.round(-Infinity)).toBe(-Infinity);
		});

		it('should throw a RangeError for non-integer decimals', function () {
			expect(function () {
				helpers.round(1, 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.round(1, NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.round(1, Infinity);
			}).toThrow(RangeError);
		});
	});

	describe('average', function () {
		it('should calculate the average of an array of numbers', function () {
			expect(helpers.average([1, 2, 3, 4])).toBe(2.5);
			expect(helpers.average([-1, -2, -3, -4])).toBe(-2.5);
			expect(helpers.average([0, 0, 0, 0])).toBe(0);
		});

		it('should use compensated summation', function () {
			expect(helpers.average([1e100, 1, -1e100, 3])).toBe(1);
		});

		it('should return NaN for an empty array', function () {
			expect(helpers.average([])).toBeNaN();
		});
	});

	describe('factorial', function () {
		it('should calculate the factorial of a number', function () {
			expect(helpers.factorial(0)).toBe(1);
			expect(helpers.factorial(1)).toBe(1);
			expect(helpers.factorial(2)).toBe(2);
			expect(helpers.factorial(3)).toBe(6);
			expect(helpers.factorial(4)).toBe(24);
			expect(helpers.factorial(10)).toBe(3628800);
		});

		it('should return Infinity above 170', function () {
			expect(Number.isFinite(helpers.factorial(170))).toBe(true);
			expect(helpers.factorial(171)).toBe(Infinity);
			expect(helpers.factorial(1e9)).toBe(Infinity);
		});

		it('should throw a RangeError for negative or non-integer input instead of overflowing the stack', function () {
			for (const value of [-1, 1.5, NaN, Infinity, -Infinity]) {
				expect(function () {
					helpers.factorial(value);
				}).toThrow(RangeError);
			}
		});
	});

	describe('max', function () {
		it('should return the maximum value in an array of numbers', function () {
			expect(helpers.max([1, 2, 3, 4, 5])).toBe(5);
			expect(helpers.max([-3, -1, -2])).toBe(-1);
		});

		it('should follow Math.max semantics', function () {
			expect(helpers.max([])).toBe(-Infinity);
			expect(helpers.max([1, NaN, 3])).toBeNaN();
			expect(helpers.max([-0, 0])).toBe(0);
			expect(helpers.max([0, -0])).toBe(0);
			expect(helpers.max([-0])).toBe(-0);
			expect(helpers.max([-Infinity, Infinity])).toBe(Infinity);
			// Only a zero may replace a -0 maximum, and a zero never replaces a positive maximum.
			expect(helpers.max([-0, -5])).toBe(-0);
			expect(helpers.max([5, 0])).toBe(5);
			expect(helpers.min([0, 5])).toBe(0);
			expect(helpers.min([0, -0, 5])).toBe(-0);
			expect(helpers.min([-5, -0])).toBe(-5);
		});

		it('should work on very large arrays', function () {
			const numbers = Array.from({ length: 200_000 }, function (_, i) {
				return i;
			});
			expect(helpers.max(numbers)).toBe(199_999);
		});
	});

	describe('min', function () {
		it('should return the minimum value in an array of numbers', function () {
			expect(helpers.min([1, 2, 3, 4, 5])).toBe(1);
			expect(helpers.min([-3, -1, -2])).toBe(-3);
		});

		it('should follow Math.min semantics', function () {
			expect(helpers.min([])).toBe(Infinity);
			expect(helpers.min([1, NaN, 3])).toBeNaN();
			expect(helpers.min([0, -0])).toBe(-0);
			expect(helpers.min([-0, 0])).toBe(-0);
			expect(helpers.min([0])).toBe(0);
		});

		it('should work on very large arrays', function () {
			const numbers = Array.from({ length: 200_000 }, function (_, i) {
				return 200_000 - i;
			});
			expect(helpers.min(numbers)).toBe(1);
		});
	});

	describe('abs', function () {
		it('should return the absolute value of a number', function () {
			expect(helpers.abs(-10)).toBe(10);
			expect(helpers.abs(10)).toBe(10);
			expect(helpers.abs(NaN)).toBeNaN();
		});
	});

	describe('sqrt', function () {
		it('should return the square root of a number', function () {
			expect(helpers.sqrt(9)).toBe(3);
			expect(helpers.sqrt(-1)).toBeNaN();
		});
	});

	describe('pow', function () {
		it('should return the value of a number raised to an exponent', function () {
			expect(helpers.pow(2, 3)).toBe(8);
			expect(helpers.pow(2, -1)).toBe(0.5);
		});
	});

	describe('log', function () {
		it('should return the logarithm of a number with the specified base', function () {
			expect(helpers.log(16, 2)).toBe(4);
			expect(helpers.log(100, 10)).toBe(2);
			expect(helpers.log(81, 3)).toBe(4);
		});

		it('should be exact for powers of 10, 2 and e', function () {
			expect(helpers.log(1000, 10)).toBe(3);
			expect(helpers.log(1e-3, 10)).toBe(-3);
			expect(helpers.log(2 ** 50, 2)).toBe(50);
			expect(helpers.log(Math.E, Math.E)).toBe(1);
		});

		it('should only snap to an integer when base ** k is exactly the number', function () {
			// Within 1e-9 of 4, but 3 ** 4 !== 81.0000001: the plain ratio is returned.
			expect(helpers.log(81.0000001, 3)).toBe(Math.log(81.0000001) / Math.log(3));
			// The snapping tolerance scales with k: a base close to 1 needs it for exact powers.
			const base = 1 + 1e-8;
			expect(helpers.log(Math.pow(base, 1000), base)).toBe(1000);
			expect(helpers.log(Infinity, 3)).toBe(Infinity);
			expect(helpers.log(0, 3)).toBe(-Infinity);
			expect(helpers.log(-1, 3)).toBeNaN();
		});

		it('should not snap when a power only matches after underflowing to a subnormal', function () {
			// 3 ** -678 rounds to Number.MIN_VALUE, but the logarithm of Number.MIN_VALUE is -677.6…, not -678.
			expect(Math.pow(3, -678)).toBe(Number.MIN_VALUE);
			expect(helpers.log(Number.MIN_VALUE, 3)).toBe(Math.log(Number.MIN_VALUE) / Math.log(3));
			expect(helpers.log(Number.MIN_VALUE, 0.9)).toBeCloseTo(7065.6457, 4);
		});

		it('should return exactly what Math.log returns for base e (no snapping)', function () {
			const value = Math.pow(Math.E, 16);
			expect(Math.log(value)).toBe(15.999999999999998);
			expect(helpers.log(value, Math.E)).toBe(Math.log(value));
		});

		it('should handle edge values', function () {
			expect(helpers.log(0, 10)).toBe(-Infinity);
			expect(helpers.log(-1, 10)).toBeNaN();
		});
	});

	describe('ceil', function () {
		it('should return the smallest integer greater than or equal to a number', function () {
			expect(helpers.ceil(3.14)).toBe(4);
			expect(helpers.ceil(-2.9)).toBe(-2);
			expect(Object.is(helpers.ceil(-0.5), -0)).toBe(true);
			expect(helpers.ceil(NaN)).toBeNaN();
		});

		it('should round up at a decimal precision, as the number is written', function () {
			expect(helpers.ceil(1.1, 2)).toBe(1.1); // naive: 1.11
			expect(helpers.ceil(0.29, 2)).toBe(0.29);
			expect(helpers.ceil(4.006, 2)).toBe(4.01);
			expect(helpers.ceil(-4.006, 2)).toBe(-4);
			expect(helpers.ceil(1.234, 1)).toBe(1.3);
			expect(helpers.ceil(0.1 + 0.2, 1)).toBe(0.4);
			expect(helpers.ceil(0.1 + 0.2, 16)).toBe(0.3000000000000001);
			expect(helpers.ceil(6040, -2)).toBe(6100);
			expect(helpers.ceil(6000, -2)).toBe(6000);
			expect(helpers.ceil(1e-7, 2)).toBe(0.01);
			expect(helpers.ceil(5, 2)).toBe(5);
			expect(Object.is(helpers.ceil(-0.001, 2), -0)).toBe(true);
			expect(Object.is(helpers.ceil(-0, 3), -0)).toBe(true);
			expect(helpers.ceil(1.5, 400)).toBe(1.5);
			expect(helpers.ceil(5, -400)).toBe(Infinity);
			expect(Object.is(helpers.ceil(-5, -400), -0)).toBe(true);
			expect(helpers.ceil(1.1773748397827148, 20)).toBe(1.1773748397827148);
			expect(helpers.floor(1.1773748397827148, 17)).toBe(1.1773748397827148);
			expect(helpers.ceil(Infinity, 2)).toBe(Infinity);
			expect(helpers.ceil(NaN, 2)).toBeNaN();
			expect(helpers.ceil(1e300, 5)).toBe(1e300);
		});

		it('should validate decimals', function () {
			expect(function () {
				helpers.ceil(1, 1.5);
			}).toThrow(new RangeError('ceil: `decimals` must be an integer, got 1.5'));
			expect(function () {
				helpers.ceil(1, '2' as any);
			}).toThrow(new TypeError('ceil: `decimals` must be an integer, got string'));
		});
	});

	describe('floor', function () {
		it('should return the largest integer less than or equal to a number', function () {
			expect(helpers.floor(3.14)).toBe(3);
			expect(helpers.floor(-2.9)).toBe(-3);
			expect(Object.is(helpers.floor(-0), -0)).toBe(true);
		});

		it('should round down at a decimal precision, as the number is written', function () {
			expect(helpers.floor(4.35, 2)).toBe(4.35); // naive: 4.34
			expect(helpers.floor(1.239, 2)).toBe(1.23);
			expect(helpers.floor(-1.231, 2)).toBe(-1.24);
			expect(helpers.floor(0.57, 2)).toBe(0.57);
			expect(helpers.floor(4060, -2)).toBe(4000);
			expect(helpers.floor(-4060, -2)).toBe(-4100);
			expect(helpers.floor(5, -400)).toBe(0);
			expect(helpers.floor(-5, -400)).toBe(-Infinity);
			expect(helpers.floor(-Infinity, 1)).toBe(-Infinity);
		});

		it('should validate decimals', function () {
			expect(function () {
				helpers.floor(1, NaN);
			}).toThrow(new RangeError('floor: `decimals` must be an integer, got NaN'));
		});
	});

	describe('modulo', function () {
		it('should return the modulo for positive operands', function () {
			expect(helpers.modulo(7, 3)).toBe(1);
			expect(helpers.modulo(10, 4)).toBe(2);
			expect(helpers.modulo(5.5, 2)).toBe(1.5);
		});

		it('should return a result with the sign of the divisor', function () {
			expect(helpers.modulo(-1, 3)).toBe(2);
			expect(helpers.modulo(-7, 3)).toBe(2);
			expect(helpers.modulo(1, -3)).toBe(-2);
			expect(helpers.modulo(-1, -3)).toBe(-1);
			expect(helpers.modulo(-5.5, 2)).toBe(0.5);
		});

		it('should return +0 for exact multiples', function () {
			expect(helpers.modulo(-3, 3)).toBe(0);
			expect(helpers.modulo(6, -3)).toBe(0);
		});

		it('should return NaN for a zero divisor or NaN operands', function () {
			expect(helpers.modulo(5, 0)).toBeNaN();
			expect(helpers.modulo(NaN, 3)).toBeNaN();
			expect(helpers.modulo(3, NaN)).toBeNaN();
			expect(helpers.modulo(Infinity, 3)).toBeNaN();
		});
	});

	describe('remainder', function () {
		it('should behave like the % operator', function () {
			expect(helpers.remainder(7, 3)).toBe(1);
			expect(helpers.remainder(-1, 3)).toBe(-1);
			expect(helpers.remainder(1, -3)).toBe(1);
			expect(helpers.remainder(5, 0)).toBeNaN();
		});
	});

	describe('randomBetween', function () {
		it('should compute minimum + r * (maximum - minimum) for finite spans', function () {
			// The overflow-safe form `minimum * (1 - r) + maximum * r` would round differently here (0.27999999999999997, 1.5999999999999999).
			expect(
				helpers.randomBetween(0.1, 0.7, function () {
					return 0.3;
				})
			).toBe(0.28);
			expect(
				helpers.randomBetween(1, 3, function () {
					return 0.3;
				})
			).toBe(1.6);
		});

		it('should generate a random number between two specified numbers', function () {
			for (let i = 0; i < 100; i++) {
				const value = helpers.randomBetween(1, 10);
				expect(value).toBeGreaterThanOrEqual(1);
				expect(value).toBeLessThan(10);
			}
		});

		it('should use the provided generator', function () {
			expect(helpers.randomBetween(0, 10, constant(0))).toBe(0);
			expect(helpers.randomBetween(0, 10, constant(0.5))).toBe(5);
			expect(helpers.randomBetween(-10, 10, constant(0.25))).toBe(-5);
		});

		it('should step below a maximum hit by rounding, including a zero maximum and a one-ulp range', function () {
			expect(helpers.randomBetween(-Number.MIN_VALUE, 0, constant(0.75))).toBe(-Number.MIN_VALUE);
			expect(helpers.randomBetween(1, 1 + Number.EPSILON, constant(ALMOST_ONE))).toBe(1);
			expect(helpers.randomBetween(-1 - Number.EPSILON, -1, constant(ALMOST_ONE))).toBe(-1 - Number.EPSILON);
		});

		it('should never return max, even when rounding would', function () {
			expect(helpers.randomBetween(1, 2, constant(ALMOST_ONE))).toBeLessThan(2);
			expect(helpers.randomBetween(-2, -1, constant(ALMOST_ONE))).toBeLessThan(-1);
		});

		it('should reject a random source returning values outside [0, 1), like the other random helpers', function () {
			expect(function () {
				helpers.randomBetween(-1, 0, constant(1));
			}).toThrow(new RangeError('randomBetween: `random()` must return a number in [0, 1), got 1'));
			expect(function () {
				helpers.randomIntBetween(1, 6, constant(NaN));
			}).toThrow(new RangeError('randomIntBetween: `random()` must return a number in [0, 1), got NaN'));
			expect(function () {
				helpers.randomBetween(0, 1, 'x' as any);
			}).toThrow(new TypeError('randomBetween: `random` must be a function, got string'));
		});

		it('should return min when min === max', function () {
			expect(helpers.randomBetween(3, 3)).toBe(3);
		});

		it('should handle spans that overflow', function () {
			const value = helpers.randomBetween(-Number.MAX_VALUE, Number.MAX_VALUE, constant(0.5));
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBe(0);
		});

		it('should throw a RangeError for invalid bounds', function () {
			expect(function () {
				helpers.randomBetween(10, 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.randomBetween(0, Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.randomBetween(NaN, 1);
			}).toThrow(RangeError);
		});
	});

	describe('random draws', function () {
		it('should trust only the built-in Math.random: a replacement installed later is still validated', function () {
			const replacement = jest.spyOn(Math, 'random').mockReturnValue(1);
			try {
				expect(function () {
					helpers.randomBetween(0, 10);
				}).toThrow(RangeError);
				expect(function () {
					helpers.randomIntBetween(0, 10);
				}).toThrow(RangeError);
			} finally {
				replacement.mockRestore();
			}
			expect(helpers.randomIntBetween(3, 3)).toBe(3);
		});
	});

	describe('randomIntBetween', function () {
		it('should return a random integer between `min` and `max`, inclusive', function () {
			for (let i = 0; i < 100; i++) {
				const value = helpers.randomIntBetween(1, 10);
				expect(Number.isInteger(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(1);
				expect(value).toBeLessThanOrEqual(10);
			}
		});

		it('should never return -0', function () {
			expect(helpers.randomIntBetween(-1, -0, constant(ALMOST_ONE))).toBe(0);
			expect(helpers.randomIntBetween(-0.5, 0, constant(0))).toBe(0);
		});

		it('should include both bounds', function () {
			expect(helpers.randomIntBetween(1, 6, constant(0))).toBe(1);
			expect(helpers.randomIntBetween(1, 6, constant(ALMOST_ONE))).toBe(6);
		});

		it('should narrow non-integer bounds to the integers inside them', function () {
			expect(helpers.randomIntBetween(1.2, 3.8, constant(0))).toBe(2);
			expect(helpers.randomIntBetween(1.2, 3.8, constant(ALMOST_ONE))).toBe(3);
			expect(helpers.randomIntBetween(-0.5, 0.5, constant(0))).toBe(0);
			expect(Object.is(helpers.randomIntBetween(-0.5, 0.5, constant(0)), 0)).toBe(true);
		});

		it('should return the single integer when min === max', function () {
			expect(helpers.randomIntBetween(4, 4)).toBe(4);
		});

		it('should throw a RangeError when no integer exists in range', function () {
			expect(function () {
				helpers.randomIntBetween(1.2, 1.8);
			}).toThrow(RangeError);
			expect(function () {
				helpers.randomIntBetween(5, 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.randomIntBetween(0, Infinity);
			}).toThrow(RangeError);
		});
	});

	describe('toRadians', function () {
		it('should convert degrees to radians', function () {
			expect(helpers.toRadians(90)).toBeCloseTo(Math.PI / 2, 12);
			expect(helpers.toRadians(180)).toBe(Math.PI);
		});
	});

	describe('toDegrees', function () {
		it('should convert radians to degrees', function () {
			expect(helpers.toDegrees(Math.PI / 2)).toBeCloseTo(90, 12);
			expect(helpers.toDegrees(Math.PI)).toBe(180);
		});
	});

	describe('clamp', function () {
		it('should return an in-range value unchanged, keeping the sign of zero', function () {
			expect(Object.is(helpers.clamp(-0, 0, 0), -0)).toBe(true);
			expect(Object.is(helpers.clamp(-0, -1, 1), -0)).toBe(true);
			expect(Object.is(helpers.clamp(0, -0, 0), 0)).toBe(true);
			expect(helpers.clamp(NaN, 0, 1)).toBeNaN();
		});

		it('should clamp values into the range', function () {
			expect(helpers.clamp(15, 0, 10)).toBe(10);
			expect(helpers.clamp(-5, 0, 10)).toBe(0);
			expect(helpers.clamp(5, 0, 10)).toBe(5);
			expect(helpers.clamp(5, 5, 5)).toBe(5);
			expect(helpers.clamp(Infinity, 0, 10)).toBe(10);
		});

		it('should keep NaN values', function () {
			expect(helpers.clamp(NaN, 0, 10)).toBeNaN();
		});

		it('should throw a RangeError when min > max or a bound is NaN', function () {
			expect(function () {
				helpers.clamp(1, 10, 0);
			}).toThrow(RangeError);
			expect(function () {
				helpers.clamp(1, NaN, 0);
			}).toThrow(RangeError);
		});
	});

	describe('lerp', function () {
		it('should interpolate linearly', function () {
			expect(helpers.lerp(0, 10, 0.5)).toBe(5);
			expect(helpers.lerp(10, 20, 0.25)).toBe(12.5);
			expect(helpers.lerp(10, 20, 0)).toBe(10);
			expect(helpers.lerp(10, 20, 1)).toBe(20);
		});

		it('should extrapolate outside [0, 1]', function () {
			expect(helpers.lerp(0, 10, 2)).toBe(20);
			expect(helpers.lerp(0, 10, -1)).toBe(-10);
		});
	});

	describe('inverseLerp', function () {
		it('should return the interpolation factor', function () {
			expect(helpers.inverseLerp(0, 10, 5)).toBe(0.5);
			expect(helpers.inverseLerp(10, 20, 12.5)).toBe(0.25);
			expect(helpers.inverseLerp(10, 20, 30)).toBe(2);
		});

		it('should return 0 for a degenerate range', function () {
			expect(helpers.inverseLerp(5, 5, 7)).toBe(0);
		});
	});

	describe('mapRange', function () {
		it('should map values between ranges', function () {
			expect(helpers.mapRange(5, 0, 10, 0, 100)).toBe(50);
			expect(helpers.mapRange(0.5, 0, 1, 10, 20)).toBe(15);
			expect(helpers.mapRange(0, 0, 10, 100, 0)).toBe(100);
			expect(helpers.mapRange(20, 0, 10, 0, 1)).toBe(2);
		});

		it('should return outMin for a degenerate input range', function () {
			expect(helpers.mapRange(3, 1, 1, 10, 20)).toBe(10);
		});
	});

	describe('inRange', function () {
		it('should check both swapped bounds', function () {
			expect(helpers.inRange(-10, 0, -5)).toBe(false);
			expect(helpers.inRange(-3, 0, -5)).toBe(true);
			expect(helpers.inRange(0, 0, -5)).toBe(false);
		});

		it('should check the half-open range [start, end)', function () {
			expect(helpers.inRange(3, 2, 4)).toBe(true);
			expect(helpers.inRange(2, 2, 4)).toBe(true);
			expect(helpers.inRange(4, 2, 4)).toBe(false);
			expect(helpers.inRange(1, 2, 4)).toBe(false);
			expect(helpers.inRange(2, 2, 2)).toBe(false);
			expect(helpers.inRange(NaN, 0, 4)).toBe(false);
		});

		it('should swap the bounds when start > end', function () {
			expect(helpers.inRange(-3, -2, -6)).toBe(true);
			expect(helpers.inRange(3, 4, 2)).toBe(true);
			expect(helpers.inRange(4, 4, 2)).toBe(false);
			expect(helpers.inRange(2, 4, 2)).toBe(true);
		});
	});

	describe('product', function () {
		it('should multiply all numbers', function () {
			expect(helpers.product([2, 3, 4])).toBe(24);
			expect(helpers.product([-2, 3])).toBe(-6);
			expect(helpers.product([5, 0])).toBe(0);
		});

		it('should return 1 for an empty array', function () {
			expect(helpers.product([])).toBe(1);
		});
	});

	describe('median', function () {
		it('should return the middle value for odd lengths', function () {
			expect(helpers.median([3, 1, 2])).toBe(2);
			expect(helpers.median([7])).toBe(7);
		});

		it('should order short and long inputs alike (NaN last, -0 before 0)', function () {
			const descending = Array.from({ length: 41 }, function (_, index) {
				return 40 - index;
			});
			expect(helpers.median(descending)).toBe(20);
			// Long inputs (typed-array sort) must be sorted too: the middle element of this one is 12 before sorting.
			const scrambled = Array.from({ length: 41 }, function (_, index) {
				return (index * 17) % 41;
			});
			expect(helpers.median(scrambled)).toBe(20);
			expect(helpers.quantile(scrambled, 0.1)).toBe(4);
			expect(helpers.median(descending.slice(0, 32))).toBe(24.5);
			expect(helpers.median(descending.concat(NaN))).toBeNaN();
			expect(helpers.median([NaN, 1, 2])).toBeNaN();
			expect(Object.is(helpers.median([0, -0, 0]), 0)).toBe(true);
			expect(Object.is(helpers.median([0, -0, -0]), -0)).toBe(true);
			expect(Object.is(helpers.median(new Array(17).fill(0).concat(new Array(16).fill(-0))), 0)).toBe(true);
			expect(Object.is(helpers.median(new Array(16).fill(0).concat(new Array(17).fill(-0))), -0)).toBe(true);
		});

		it('should return the mean of the middle values for even lengths', function () {
			expect(helpers.median([4, 1, 3, 2])).toBe(2.5);
			expect(helpers.median([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
		});

		it('should not depend on the input order for the sign of a zero (regression: -0 vs 0 followed the input order)', function () {
			expect(helpers.median([1, Infinity, 2])).toBe(2);
			// Type 7: x[j] + g * (x[j + 1] - x[j]); the lerp form (1 - g) * x[j] + g * x[j + 1] gives 0.15000000000000002.
			expect(helpers.quantile([0.1, 0.3], 0.25)).toBe(0.15);
			expect(helpers.median([Infinity, -Infinity])).toBeNaN();
			expect(helpers.quantile([0, Infinity], 1)).toBe(Infinity);
			expect(helpers.median([0, -0, 5])).toBe(0);
			expect(helpers.median([-0, 0, 5])).toBe(0);
			expect(helpers.median([5, -0, -1])).toBe(-0);
			expect(helpers.quantile([0, -0], 0.25)).toBe(-0);
			expect(helpers.quantile([-0, 0], 0.25)).toBe(-0);
		});

		it('should sort numerically, not lexicographically', function () {
			expect(helpers.median([10, 9, 100])).toBe(10);
		});

		it('should return NaN for empty input or input containing NaN', function () {
			expect(helpers.median([])).toBeNaN();
			expect(helpers.median([1, NaN, 2])).toBeNaN();
			expect(helpers.median([NaN, NaN, 1])).toBeNaN();
		});

		it('should not mutate the input', function () {
			const input = [3, 1, 2];
			helpers.median(input);
			expect(input).toEqual([3, 1, 2]);
		});
	});

	describe('mode', function () {
		it('should return the most frequent value', function () {
			expect(helpers.mode([1, 2, 2, 3])).toEqual([2]);
		});

		it('should return all most frequent values in ascending order', function () {
			expect(helpers.mode([3, 1, 3, 1, 2])).toEqual([1, 3]);
			expect(helpers.mode([10, 9, 100])).toEqual([9, 10, 100]);
		});

		it('should treat NaN as a value and sort it last', function () {
			expect(helpers.mode([NaN, 1, NaN, 1])).toEqual([1, NaN]);
			expect(helpers.mode([NaN, NaN, 1])).toEqual([NaN]);
			expect(helpers.mode([NaN, 2, NaN, 2, NaN, 2])).toEqual([2, NaN]);
		});

		it('should return an empty array for empty input', function () {
			expect(helpers.mode([])).toEqual([]);
		});
	});

	describe('variance', function () {
		it('should compute the population variance by default', function () {
			expect(helpers.variance([2, 4, 4, 4, 5, 5, 7, 9])).toBe(4);
			expect(helpers.variance([5])).toBe(0);
		});

		it('should compute the sample variance', function () {
			expect(helpers.variance([1, 2, 3, 4], { sample: true })).toBeCloseTo(5 / 3, 12);
			expect(helpers.variance([1, 2, 3, 4], { sample: false })).toBe(1.25);
			expect(helpers.variance([], { sample: true })).toBeNaN();
			expect(helpers.variance([3], { sample: true })).toBeNaN();
		});

		it('should be numerically stable for large offsets', function () {
			expect(helpers.variance([1e9 + 4, 1e9 + 7, 1e9 + 13, 1e9 + 16])).toBe(22.5);
		});

		it('should return NaN when undefined', function () {
			expect(helpers.variance([])).toBeNaN();
			expect(helpers.variance([1], { sample: true })).toBeNaN();
			expect(helpers.variance([1, Infinity])).toBeNaN();
			expect(helpers.variance([1, NaN])).toBeNaN();
		});
	});

	describe('standardDeviation', function () {
		it('should compute the population standard deviation by default', function () {
			expect(helpers.standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
			expect(helpers.standardDeviation([1])).toBe(0);
		});

		it('should compute the sample standard deviation', function () {
			expect(helpers.standardDeviation([1, 2, 3, 4], { sample: true })).toBeCloseTo(Math.sqrt(5 / 3), 12);
		});

		it('should return NaN when undefined', function () {
			expect(helpers.standardDeviation([])).toBeNaN();
			expect(helpers.standardDeviation([1], { sample: true })).toBeNaN();
		});
	});

	describe('gcd', function () {
		it('should compute the greatest common divisor', function () {
			expect(helpers.gcd(12, 18)).toBe(6);
			expect(helpers.gcd(17, 5)).toBe(1);
			expect(helpers.gcd(0, 5)).toBe(5);
			expect(helpers.gcd(5, 0)).toBe(5);
			expect(helpers.gcd(0, 0)).toBe(0);
		});

		it('should always return a non-negative result', function () {
			expect(helpers.gcd(-4, 6)).toBe(2);
			expect(helpers.gcd(-4, -6)).toBe(2);
			expect(Object.is(helpers.gcd(-0, 0), 0)).toBe(true);
		});

		it('should throw a RangeError for non-integers', function () {
			for (const [a, b] of [
				[1.5, 2],
				[2, NaN],
				[Infinity, 2]
			]) {
				expect(function () {
					helpers.gcd(a, b);
				}).toThrow(RangeError);
			}
		});
	});

	describe('lcm', function () {
		it('should name the offending argument when it is not an integer', function () {
			expect(function () {
				helpers.lcm(1.5, 2);
			}).toThrow(new RangeError('lcm: `a` must be an integer, got 1.5'));
			expect(function () {
				helpers.lcm(2, 1.5);
			}).toThrow(new RangeError('lcm: `b` must be an integer, got 1.5'));
			expect(function () {
				helpers.gcd(2, '3' as unknown as number);
			}).toThrow(new TypeError('gcd: `b` must be an integer, got string'));
		});

		it('should compute the least common multiple', function () {
			expect(helpers.lcm(4, 6)).toBe(12);
			expect(helpers.lcm(-3, 5)).toBe(15);
			expect(helpers.lcm(-3, -5)).toBe(15);
			expect(helpers.lcm(7, 7)).toBe(7);
		});

		it('should return 0 when an argument is 0', function () {
			expect(helpers.lcm(0, 5)).toBe(0);
			expect(helpers.lcm(5, 0)).toBe(0);
			expect(helpers.lcm(0, 0)).toBe(0);
		});

		it('should throw a RangeError for non-integers', function () {
			expect(function () {
				helpers.lcm(1.5, 2);
			}).toThrow(RangeError);
		});
	});

	describe('isPrime', function () {
		it('should detect primes', function () {
			expect([2, 3, 5, 7, 11, 13, 25, 29, 49, 97, 7919].map(helpers.isPrime)).toEqual([true, true, true, true, true, true, false, true, false, true, true]);
			expect(helpers.isPrime(2_147_483_647)).toBe(true);
			expect(helpers.isPrime(1_000_000_007 * 3)).toBe(false);
		});

		it('should return false for non-primes, non-integers, negatives, 0 and 1', function () {
			for (const value of [0, 1, -7, 4, 9, 2.5, NaN, Infinity, 2 ** 53 + 2]) {
				expect(helpers.isPrime(value)).toBe(false);
			}
		});
	});

	describe('isEven / isOdd', function () {
		it('should classify integers', function () {
			expect(helpers.isEven(4)).toBe(true);
			expect(helpers.isEven(0)).toBe(true);
			expect(helpers.isEven(-2)).toBe(true);
			expect(helpers.isEven(3)).toBe(false);
			expect(helpers.isOdd(3)).toBe(true);
			expect(helpers.isOdd(-3)).toBe(true);
			expect(helpers.isOdd(4)).toBe(false);
			expect(helpers.isOdd(0)).toBe(false);
		});

		it('should return false for non-integers', function () {
			for (const value of [2.5, NaN, Infinity, -Infinity]) {
				expect(helpers.isEven(value)).toBe(false);
				expect(helpers.isOdd(value)).toBe(false);
			}
		});
	});

	describe('percentage', function () {
		it('should compute the percentage of a total', function () {
			expect(helpers.percentage(25, 200)).toBe(12.5);
			expect(helpers.percentage(50, 50)).toBe(100);
			expect(helpers.percentage(-1, 4)).toBe(-25);
			expect(helpers.percentage(0, 4)).toBe(0);
		});

		it('should return NaN when the total is 0', function () {
			expect(helpers.percentage(3, 0)).toBeNaN();
			expect(helpers.percentage(0, 0)).toBeNaN();
		});
	});

	describe('regressions (helper review)', function () {
		it('round keeps the first dropped digit even when the shifted value exceeds 2 ** 51', function () {
			expect(helpers.round(3.0000000000000004, 15)).toBe(3);
			expect(helpers.round(34729124319504.973, 2)).toBe(34729124319504.97);
			expect(helpers.round(49725191080312.305, 2)).toBe(49725191080312.31);
			expect(helpers.round(-49725191080312.305, 2)).toBe(-49725191080312.31);
			expect(helpers.round(434026.60000000003, 10)).toBe(434026.6);
			expect(helpers.round(5e-324, 0)).toBe(0);
			expect(Object.is(helpers.round(-5e-324, 0), -0)).toBe(true);
			expect(helpers.round(1.7976931348623157e308, -308)).toBe(Infinity);
		});

		it('roundToStep finds the nearest multiple when the shifted value exceeds 2 ** 53', function () {
			expect(helpers.roundToStep(434026.6, 1e-10)).toBe(434026.6);
			expect(helpers.roundToStep(3.0000000000000004, 1e-15)).toBe(3);
			// 69859533205.86203 is 2794381328234481.2 steps of 0.000025: the nearest multiple is step 2794381328234481.
			expect(helpers.roundToStep(69859533205.86203, 0.000025)).toBe(helpers.round(2794381328234481 * 0.000025, 6));
			expect(helpers.roundToStep(-69859533205.86203, 0.000025)).toBe(-helpers.roundToStep(69859533205.86203, 0.000025));
		});

		it('variance and standardDeviation stay finite when only n times the variance overflows', function () {
			expect(helpers.variance([1.2e154, -1.2e154, 1.2e154, -1.2e154])).toBeCloseTo(1.44e308, -300);
			expect(helpers.standardDeviation([1.2e154, -1.2e154, 1.2e154, -1.2e154])).toBeCloseTo(1.2e154, -146);
			expect(helpers.variance([1e308, -1e308])).toBe(Infinity);
		});

		it('average and weightedAverage do not overflow when the mean is finite', function () {
			expect(helpers.average([1e308, 1e308])).toBe(1e308);
			expect(helpers.average([1e308, 1e308, -1e308])).toBeCloseTo(1e308 / 3, -300);
			expect(helpers.average([Infinity, 1])).toBe(Infinity);
			expect(helpers.average([Infinity, -Infinity])).toBeNaN();
			expect(helpers.weightedAverage([1e308, 1e308], [1, 1])).toBe(1e308);
			expect(helpers.weightedAverage([Infinity, 1], [1, 1])).toBe(Infinity);
		});

		it('average and weightedAverage keep an infinite element when the other terms overflow', function () {
			expect(helpers.average([1e308, 1e308, -Infinity])).toBe(-Infinity);
			expect(helpers.weightedAverage([1e308, 1e308, -Infinity], [1, 1, 1])).toBe(-Infinity);
			expect(helpers.average([1e308, 1e308, NaN])).toBeNaN();
		});

		it('formatBytes rounds SI values as written in every unit, YB included', function () {
			expect(helpers.formatBytes(305.035e24, { decimals: 2 })).toBe('305.04 YB');
			expect(helpers.formatBytes(305.035e21, { decimals: 2 })).toBe('305.04 ZB');
			expect(helpers.formatBytes(-305.035e24, { decimals: 2 })).toBe('-305.04 YB');
			expect(helpers.formatBytes(1536, { base: 1024 })).toBe('1.5 KiB');
		});
	});

	describe('regressions (round 2 bug hunt)', function () {
		it('log should return the exact integer for exact powers of any base', function () {
			expect(helpers.log(81, 3)).toBe(4);
			expect(helpers.log(125, 5)).toBe(3);
			expect(helpers.log(7 ** 20, 7)).toBe(20);
			expect(helpers.log(1 / 27, 3)).toBe(-3);
			expect(helpers.log(0.25, 0.5)).toBe(2);
			expect(helpers.log(1, 3)).toBe(0);
			expect(helpers.log(80, 3)).toBeCloseTo(3.98869, 4);
		});

		it('modulo should stay inside [0, divisor) when a tiny negative dividend rounds up to the divisor', function () {
			expect(helpers.modulo(-1e-20, 3)).toBe(0);
			expect(helpers.modulo(1e-20, -3)).toBe(0);
			expect(helpers.modulo(-1e-20, 360)).toBe(0);
		});

		it('lerp should return the endpoints exactly even when the other endpoint is infinite', function () {
			expect(helpers.lerp(0, Infinity, 0)).toBe(0);
			expect(helpers.lerp(-Infinity, 0, 1)).toBe(0);
		});

		it('lerp should return the constant when both endpoints are equal', function () {
			expect(helpers.lerp(0.1, 0.1, 0.3)).toBe(0.1);
			expect(helpers.mapRange(3, 0, 10, 0.1, 0.1)).toBe(0.1);
		});

		it('median should not underflow when averaging two equal subnormal middle values', function () {
			expect(helpers.median([Number.MIN_VALUE, Number.MIN_VALUE])).toBe(Number.MIN_VALUE);
			expect(helpers.median([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
			expect(helpers.median([-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(0);
		});

		it('variance should return Infinity (not a negative number or NaN) when finite inputs overflow', function () {
			expect(helpers.variance([1e308, -1e308])).toBe(Infinity);
			expect(helpers.variance([1e308, -1e308, 1e308, 5])).toBe(Infinity);
			expect(helpers.standardDeviation([-1e308, 1e308])).toBe(Infinity);
			expect(helpers.variance([1, Infinity])).toBeNaN();
		});
	});

	describe('quantile', function () {
		it('should interpolate linearly between closest ranks (R-7 / PERCENTILE.INC)', function () {
			expect(helpers.quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
			expect(helpers.quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
			expect(helpers.quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
			expect(helpers.quantile([15, 20, 35, 40, 50], 0.4)).toBe(29);
			expect(helpers.quantile([10], 0.3)).toBe(10);
		});

		it('should return the minimum and maximum at q = 0 and q = 1 regardless of order', function () {
			expect(helpers.quantile([7, 1, 3], 0)).toBe(1);
			expect(helpers.quantile([7, 1, 3], 1)).toBe(7);
		});

		it('should agree with median at q = 0.5', function () {
			expect(helpers.quantile([5, 3, 9, 1], 0.5)).toBe(helpers.median([5, 3, 9, 1]));
		});

		it('should handle infinities and huge spans', function () {
			expect(helpers.quantile([-Infinity, 1, 2], 0.25)).toBe(-Infinity);
			expect(helpers.quantile([Infinity, Infinity], 0.5)).toBe(Infinity);
			expect(helpers.quantile([-Number.MAX_VALUE, Number.MAX_VALUE], 0.5)).toBe(0);
		});

		it('should return NaN for empty input or input containing NaN', function () {
			expect(helpers.quantile([], 0.5)).toBeNaN();
			expect(helpers.quantile([1, NaN, 3], 0.5)).toBeNaN();
		});

		it('should not mutate the input', function () {
			const input = [3, 1, 2];
			helpers.quantile(input, 0.5);
			expect(input).toEqual([3, 1, 2]);
		});

		it('should throw a RangeError when q is outside [0, 1]', function () {
			expect(function () {
				helpers.quantile([1, 2], -0.1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.quantile([1, 2], 1.1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.quantile([1, 2], NaN);
			}).toThrow(RangeError);
		});
	});

	describe('percentile', function () {
		it('should be quantile with p / 100', function () {
			expect(helpers.percentile([1, 2, 3, 4], 50)).toBe(2.5);
			expect(helpers.percentile([15, 20, 35, 40, 50], 40)).toBe(29);
			expect(helpers.percentile([15, 20, 35, 40, 50], 0)).toBe(15);
			expect(helpers.percentile([15, 20, 35, 40, 50], 100)).toBe(50);
			expect(helpers.percentile([], 10)).toBeNaN();
		});

		it('should throw a RangeError when p is outside [0, 100]', function () {
			expect(function () {
				helpers.percentile([1], 101);
			}).toThrow(RangeError);
			expect(function () {
				helpers.percentile([1], -1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.percentile([1], NaN);
			}).toThrow(RangeError);
		});
	});

	describe('cumulativeSum', function () {
		it('should return running totals', function () {
			expect(helpers.cumulativeSum([1, 2, 3, 4])).toEqual([1, 3, 6, 10]);
			expect(helpers.cumulativeSum([5])).toEqual([5]);
			expect(helpers.cumulativeSum([])).toEqual([]);
		});

		it('should compensate rounding errors', function () {
			expect(helpers.cumulativeSum([1e100, 1, -1e100])).toEqual([1e100, 1e100, 1]);
			expect(helpers.cumulativeSum(new Array(10).fill(0.1))[9]).toBe(1);
			// The small term is lost when a much larger one is added after it: the compensation recovers it.
			expect(helpers.cumulativeSum([1, 1e100, 1, -1e100])).toEqual([1, 1e100, 1e100, 2]);
			expect(helpers.sum([1, 1e100, 1, -1e100])).toBe(2);
		});

		it('should accept any iterable and not mutate arrays', function () {
			const input = Object.freeze([1, 2]);
			expect(helpers.cumulativeSum(input)).toEqual([1, 3]);
			expect(helpers.cumulativeSum(new Set([1, 2, 3]))).toEqual([1, 3, 6]);
		});

		it('should propagate non-finite values', function () {
			expect(helpers.cumulativeSum([1, Infinity, 1])).toEqual([1, Infinity, Infinity]);
			expect(helpers.cumulativeSum([1, NaN])).toEqual([1, NaN]);
			expect(helpers.cumulativeSum([Infinity, -Infinity])).toEqual([Infinity, NaN]);
		});
	});

	describe('approximatelyEqual', function () {
		it('should use a relative tolerance of 1e-9 by default', function () {
			expect(helpers.approximatelyEqual(0.1 + 0.2, 0.3)).toBe(true);
			expect(helpers.approximatelyEqual(1e10, 1e10 + 1)).toBe(true);
			expect(helpers.approximatelyEqual(1, 1 + 1e-8)).toBe(false);
			expect(helpers.approximatelyEqual(1, 1.1)).toBe(false);
		});

		it('should honour custom relative and absolute tolerances', function () {
			expect(helpers.approximatelyEqual(1, 1.1, { relative: 0.1 })).toBe(true);
			expect(helpers.approximatelyEqual(1, 1.2, { relative: 0.1 })).toBe(false);
			expect(helpers.approximatelyEqual(1e-12, 0)).toBe(false);
			expect(helpers.approximatelyEqual(1e-12, 0, { absolute: 1e-9 })).toBe(true);
			expect(helpers.approximatelyEqual(5, 6, { relative: 0, absolute: 1 })).toBe(true);
			expect(helpers.approximatelyEqual(5, 6, { relative: 0 })).toBe(false);
		});

		it('should scale the relative tolerance by the larger magnitude, inclusively, in both argument orders', function () {
			expect(helpers.approximatelyEqual(1, 0.5, { relative: 0.5 })).toBe(true);
			expect(helpers.approximatelyEqual(0.5, 1, { relative: 0.5 })).toBe(true);
			expect(helpers.approximatelyEqual(1, 0.9, { relative: 0.1 })).toBe(true);
			expect(helpers.approximatelyEqual(0.9, 1, { relative: 0.1 })).toBe(true);
			expect(helpers.approximatelyEqual(1, 0.25, { relative: 0.5 })).toBe(false);
			expect(helpers.approximatelyEqual(3, 4, { relative: 0, absolute: 1 })).toBe(true);
		});

		it('should treat NaN as never close and infinities as close only to themselves', function () {
			expect(helpers.approximatelyEqual(NaN, NaN)).toBe(false);
			expect(helpers.approximatelyEqual(NaN, 1, { absolute: Infinity })).toBe(false);
			expect(helpers.approximatelyEqual(Infinity, Infinity)).toBe(true);
			expect(helpers.approximatelyEqual(-Infinity, -Infinity)).toBe(true);
			expect(helpers.approximatelyEqual(Infinity, -Infinity, { absolute: Infinity })).toBe(false);
			expect(helpers.approximatelyEqual(Infinity, Number.MAX_VALUE, { relative: 1 })).toBe(false);
			expect(helpers.approximatelyEqual(0, -0)).toBe(true);
		});

		it('should throw a RangeError for negative or NaN tolerances', function () {
			expect(function () {
				helpers.approximatelyEqual(1, 1, { relative: -1 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.approximatelyEqual(1, 1, { absolute: NaN });
			}).toThrow(RangeError);
		});
	});

	describe('weightedAverage', function () {
		it('should compute the weighted mean', function () {
			expect(helpers.weightedAverage([1, 2, 3], [3, 2, 1])).toBeCloseTo(10 / 6, 15);
			expect(helpers.weightedAverage([10, 20], [1, 1])).toBe(15);
			expect(helpers.weightedAverage([10, 20], [0, 2])).toBe(20);
			expect(helpers.weightedAverage([0.1, 0.2, 0.3], [0.5, 0.25, 0.25])).toBeCloseTo(0.175, 15);
		});

		it('should only depend on weight ratios, even for huge or subnormal weights', function () {
			expect(helpers.weightedAverage([1e-9], [5e-324])).toBe(1e-9);
			expect(helpers.weightedAverage([10, 20], [Number.MAX_VALUE, Number.MAX_VALUE])).toBe(15);
			expect(helpers.weightedAverage([10, 20], [1e300, 3e300])).toBe(17.5);
		});

		it('should return NaN when the total weight is 0', function () {
			expect(helpers.weightedAverage([10, 20], [0, 0])).toBeNaN();
			expect(helpers.weightedAverage([], [])).toBeNaN();
		});

		it('should throw a RangeError on length mismatch', function () {
			expect(function () {
				helpers.weightedAverage([1, 2], [1]);
			}).toThrow(RangeError);
		});

		it('should throw a RangeError on negative, NaN or infinite weights', function () {
			expect(function () {
				helpers.weightedAverage([1, 2], [1, -1]);
			}).toThrow(RangeError);
			expect(function () {
				helpers.weightedAverage([1, 2], [1, NaN]);
			}).toThrow(RangeError);
			expect(function () {
				helpers.weightedAverage([1, 2], [1, Infinity]);
			}).toThrow(RangeError);
		});
	});

	describe('normalize', function () {
		it('should rescale to [0, 1]', function () {
			expect(helpers.normalize([10, 20, 15])).toEqual([0, 1, 0.5]);
			expect(helpers.normalize([-1, 0, 1])).toEqual([0, 0.5, 1]);
		});

		it('should map all-equal input to zeros and keep empty input empty', function () {
			expect(helpers.normalize([5, 5, 5])).toEqual([0, 0, 0]);
			expect(helpers.normalize([7])).toEqual([0]);
			expect(helpers.normalize([])).toEqual([]);
		});

		it('should not overflow for ranges larger than Number.MAX_VALUE', function () {
			expect(helpers.normalize([-Number.MAX_VALUE, 0, Number.MAX_VALUE])).toEqual([0, 0.5, 1]);
		});

		it('should not mutate the input', function () {
			const input = [3, 1, 2];
			expect(helpers.normalize(input)).toEqual([1, 0, 0.5]);
			expect(input).toEqual([3, 1, 2]);
		});

		it('should throw a RangeError on non-finite elements', function () {
			expect(function () {
				helpers.normalize([1, NaN]);
			}).toThrow(RangeError);
			expect(function () {
				helpers.normalize([1, Infinity]);
			}).toThrow(RangeError);
		});
	});

	describe('parseBytes', function () {
		it('should parse SI, IEC and bare byte counts', function () {
			expect(helpers.parseBytes('1.5 kB')).toBe(1500);
			expect(helpers.parseBytes('1.5 KB')).toBe(1500);
			expect(helpers.parseBytes('1.1 kB')).toBe(1100); // not 1100.0000000000002
			expect(helpers.parseBytes('1 MiB')).toBe(1_048_576);
			expect(helpers.parseBytes('1KiB')).toBe(1024); // bytes.parse gives 1
			expect(helpers.parseBytes('-2 KiB')).toBe(-2048);
			expect(helpers.parseBytes('512')).toBe(512);
			expect(helpers.parseBytes('512 B')).toBe(512);
			expect(helpers.parseBytes('0.5 B')).toBe(0.5);
			expect(helpers.parseBytes('.5kB')).toBe(500);
			expect(helpers.parseBytes('1e3')).toBe(1000); // bytes.parse gives 1
			expect(helpers.parseBytes('1E3 B')).toBe(1000);
			expect(helpers.parseBytes('1e+16 YB')).toBe(1e40);
			expect(helpers.parseBytes('  2   GiB  ')).toBe(2 ** 31);
			expect(helpers.parseBytes('1 EB')).toBe(1e18);
			expect(helpers.parseBytes('1 EiB')).toBe(2 ** 60);
			expect(helpers.parseBytes('3 YiB')).toBe(3 * 2 ** 80);
			const si = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
			const iec = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
			for (let k = 0; k < si.length; k++) {
				expect(helpers.parseBytes(`7 ${si[k]}`)).toBe(Number(`7e${3 * k}`));
				expect(helpers.parseBytes(`7 ${si[k]}`, { base: 1024 })).toBe(7 * 1024 ** k);
				expect(helpers.parseBytes(`7 ${iec[k]}`)).toBe(7 * 1024 ** k);
				expect(helpers.parseBytes(`7 ${iec[k]}`, { base: 1000 })).toBe(7 * 1024 ** k);
			}
		});

		it('should reject garbage instead of half-parsing it', function () {
			const rejected = [
				'1 Mb',
				'1 mb',
				'1 kb',
				'12 apples',
				'1 KiBs',
				'1 kiB',
				'1 K',
				'',
				' ',
				'1.',
				'1..5 B',
				'+1 B',
				'1,5 MB',
				'1 024 B',
				'MB',
				'- 1 B',
				'1e B',
				'0x10',
				'Infinity',
				'NaN B',
				'1e400 B',
				'1e300 YB'
			];
			for (const value of rejected) {
				expect(function () {
					helpers.parseBytes(value);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.parseBytes('1 Mb');
			}).toThrow(new RangeError(`parseBytes: \`value\` must be a finite byte size such as '1.5 MB' or '2 KiB', got "1 Mb"`));
			expect(function () {
				helpers.parseBytes(`${'9'.repeat(60)} apples`);
			}).toThrow(new RangeError(`parseBytes: \`value\` must be a finite byte size such as '1.5 MB' or '2 KiB', got "${'9'.repeat(50)}…"`));
			expect(function () {
				helpers.parseBytes(1024 as any);
			}).toThrow(new TypeError('parseBytes: `value` must be a string, got number'));
			expect(function () {
				helpers.parseBytes('1 kB', { base: 1000.5 as any });
			}).toThrow(new RangeError('parseBytes: `base` must be 1000 or 1024, got 1000.5'));
		});

		it('should parse in linear time', function () {
			const start = performance.now();
			for (const value of [`1${' '.repeat(100_000)}x`, `1${'e'.repeat(100_000)}1`, `${'1'.repeat(100_000)}.`, `1 ${'B'.repeat(100_000)} 1`]) {
				expect(function () {
					helpers.parseBytes(value);
				}).toThrow(RangeError);
			}
			expect(performance.now() - start).toBeLessThan(1000);
		});

		it('should invert formatBytes', function () {
			for (const bytes of [0, 1, 999, 1000, 1500, 999_999, 1_234_567, 3e9, 1e24, 1e40, -2048, 0.5]) {
				for (const base of [1000, 1024] as const) {
					const text = helpers.formatBytes(bytes, { base, decimals: 2 });
					expect(helpers.formatBytes(helpers.parseBytes(text, { base }), { base, decimals: 2 })).toBe(text);
				}
			}
			expect(helpers.parseBytes(helpers.formatBytes(1_234_567, { decimals: 6 }))).toBe(1_234_567);
			expect(helpers.parseBytes(helpers.formatBytes(1_234_567, { base: 1024, decimals: 20 }), { base: 1024 })).toBe(1_234_567);
		});
	});

	describe('formatBytes', function () {
		it('should name every unit of both systems', function () {
			const si = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
			const iec = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
			for (let k = 0; k < si.length; k++) {
				expect(helpers.formatBytes(1000 ** k)).toBe(`1 ${si[k]}`);
				expect(helpers.formatBytes(1024 ** k, { base: 1024 })).toBe(`1 ${iec[k]}`);
			}
		});

		it('should use SI units by default', function () {
			expect(helpers.formatBytes(0)).toBe('0 B');
			expect(helpers.formatBytes(512)).toBe('512 B');
			expect(helpers.formatBytes(1000)).toBe('1 kB');
			expect(helpers.formatBytes(1500)).toBe('1.5 kB');
			expect(helpers.formatBytes(1_500_000)).toBe('1.5 MB');
			expect(helpers.formatBytes(3e9)).toBe('3 GB');
			expect(helpers.formatBytes(1e24)).toBe('1 YB');
		});

		it('should use IEC units with base 1024', function () {
			expect(helpers.formatBytes(1023, { base: 1024 })).toBe('1023 B');
			expect(helpers.formatBytes(1024, { base: 1024 })).toBe('1 KiB');
			expect(helpers.formatBytes(1536, { base: 1024 })).toBe('1.5 KiB');
			expect(helpers.formatBytes(1024 ** 3 * 2.25, { base: 1024, decimals: 2 })).toBe('2.25 GiB');
		});

		it('should honour decimals and drop trailing zeros', function () {
			expect(helpers.formatBytes(1234567, { decimals: 2 })).toBe('1.23 MB');
			expect(helpers.formatBytes(1234567, { decimals: 0 })).toBe('1 MB');
			expect(helpers.formatBytes(1005, { decimals: 3 })).toBe('1.005 kB');
			expect(helpers.formatBytes(1.5)).toBe('1.5 B');
		});

		it('should move up a unit when rounding reaches the base', function () {
			expect(helpers.formatBytes(999_999)).toBe('1 MB');
			expect(helpers.formatBytes(999.96)).toBe('1 kB');
			expect(helpers.formatBytes(1023.99, { base: 1024 })).toBe('1 KiB');
			expect(helpers.formatBytes(999.94)).toBe('999.9 B');
		});

		it('should keep the sign of negative values and never print -0', function () {
			expect(helpers.formatBytes(-1500)).toBe('-1.5 kB');
			expect(helpers.formatBytes(-2048, { base: 1024 })).toBe('-2 KiB');
			expect(helpers.formatBytes(-0.01)).toBe('0 B');
			expect(helpers.formatBytes(-0)).toBe('0 B');
		});

		it('should express values beyond the largest unit in that unit', function () {
			expect(helpers.formatBytes(1e27)).toBe('1000 YB');
		});

		it('should throw a RangeError on invalid arguments', function () {
			expect(function () {
				helpers.formatBytes(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatBytes(NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatBytes(1, { decimals: -1 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatBytes(1, { decimals: 1.5 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatBytes(1, { base: 1001 as any });
			}).toThrow(RangeError);
		});
	});

	describe('ordinal', function () {
		it('should append the English ordinal suffix', function () {
			const expected: Array<[number, string]> = [
				[0, '0th'],
				[1, '1st'],
				[2, '2nd'],
				[3, '3rd'],
				[4, '4th'],
				[11, '11th'],
				[12, '12th'],
				[13, '13th'],
				[21, '21st'],
				[22, '22nd'],
				[23, '23rd'],
				[101, '101st'],
				[111, '111th'],
				[112, '112th'],
				[1013, '1013th']
			];
			for (const [n, text] of expected) expect(helpers.ordinal(n)).toBe(text);
		});

		it('should keep the sign of negative integers and treat -0 as 0', function () {
			expect(helpers.ordinal(-1)).toBe('-1st');
			expect(helpers.ordinal(-2)).toBe('-2nd');
			expect(helpers.ordinal(-11)).toBe('-11th');
			expect(helpers.ordinal(-112)).toBe('-112th');
			expect(helpers.ordinal(-0)).toBe('0th');
		});

		it('should write huge integers in full digits', function () {
			expect(helpers.ordinal(1e21)).toBe('1000000000000000000000th');
			expect(helpers.ordinal(-1e21 - 2 ** 20)).toBe('-1000000000000001048576th');
		});

		it('should throw a RangeError for non-integers', function () {
			for (const value of [1.5, NaN, Infinity, -Infinity]) {
				expect(function () {
					helpers.ordinal(value);
				}).toThrow(RangeError);
			}
		});
	});

	describe('nthRoot', function () {
		it('should compute exact roots of perfect powers', function () {
			expect(helpers.nthRoot(27, 3)).toBe(3);
			expect(helpers.nthRoot(16, 4)).toBe(2);
			expect(helpers.nthRoot(9, 2)).toBe(3);
			expect(helpers.nthRoot(3 ** 10, 10)).toBe(3);
			expect(helpers.nthRoot(1e15, 5)).toBe(1000);
			expect(helpers.nthRoot(7, 1)).toBe(7);
			expect(helpers.nthRoot(-2.5, 1)).toBe(-2.5);
			expect(helpers.nthRoot(0, 4)).toBe(0);
			expect(helpers.nthRoot(-0, 4)).toBe(-0);
			expect(helpers.nthRoot(-0, 5)).toBe(-0);
		});

		it('should return negative odd roots of negative numbers', function () {
			expect(helpers.nthRoot(-8, 3)).toBe(-2);
			expect(helpers.nthRoot(-32, 5)).toBe(-2);
			expect(helpers.nthRoot(-7, 1)).toBe(-7);
			expect(helpers.nthRoot(-2, 7) ** 7).toBeCloseTo(-2, 12);
		});

		it('should return NaN for even roots of negative numbers', function () {
			expect(helpers.nthRoot(-16, 4)).toBeNaN();
			expect(helpers.nthRoot(-4, 2)).toBeNaN();
		});

		it('should approximate irrational roots', function () {
			expect(helpers.nthRoot(2, 5) ** 5).toBeCloseTo(2, 12);
		});

		it('should handle special values', function () {
			expect(helpers.nthRoot(0, 4)).toBe(0);
			expect(helpers.nthRoot(-0, 4)).toBe(-0);
			expect(helpers.nthRoot(Infinity, 4)).toBe(Infinity);
			expect(helpers.nthRoot(-Infinity, 5)).toBe(-Infinity);
			expect(helpers.nthRoot(NaN, 5)).toBeNaN();
		});

		it('should throw a RangeError when n is not a positive integer', function () {
			for (const n of [0, -2, 2.5, NaN, Infinity]) {
				expect(function () {
					helpers.nthRoot(8, n);
				}).toThrow(RangeError);
			}
		});
	});

	describe('roundToStep', function () {
		it('should snap values with more digits than a double holds exactly, both ways', function () {
			expect(helpers.roundToStep(9876543.223456789, 0.5)).toBe(9876543);
			expect(helpers.roundToStep(9876543.323456788, 0.5)).toBe(9876543.5);
		});

		it('should snap to the nearest multiple of the step', function () {
			expect(helpers.roundToStep(1.13, 0.25)).toBe(1.25);
			expect(helpers.roundToStep(1.12, 0.25)).toBe(1);
			expect(helpers.roundToStep(7, 5)).toBe(5);
			expect(helpers.roundToStep(8, 5)).toBe(10);
			expect(helpers.roundToStep(123456.789, 0.01)).toBe(123456.79);
		});

		it('should break exact ties away from zero even when the step is not a binary fraction', function () {
			// 7 / 0.56 is exactly 12.5, but 7 / 0.56 in binary floating point is 12.499999999999998.
			expect(helpers.roundToStep(7, 0.56)).toBe(7.28);
			expect(helpers.roundToStep(-7, 0.56)).toBe(-7.28);
		});

		it('should avoid binary floating-point artefacts', function () {
			expect(helpers.roundToStep(0.3, 0.1)).toBe(0.3);
			expect(helpers.roundToStep(0.7, 0.1)).toBe(0.7);
			expect(helpers.roundToStep(1, 1 / 3)).toBe(1);
			expect(helpers.roundToStep(1e-20, 1e-21)).toBe(1e-20);
		});

		it('should give clean multiples of steps written in exponent notation', function () {
			// String(1e-7) is '1e-7': its decimal places come from the exponent alone.
			expect(helpers.roundToStep(1.3e-6, 1e-7)).toBe(1.3e-6);
			expect(helpers.roundToStep(1.3e-6, 5e-8)).toBe(1.3e-6);
			expect(helpers.roundToStep(0.35, 1e-9)).toBe(0.35);
			expect(helpers.roundToStep(1e-7, 3e-8)).toBe(9e-8);
			expect(helpers.roundToStep(123456789, 2)).toBe(123456790);
		});

		it('should round ties half away from zero', function () {
			expect(helpers.roundToStep(0.35, 0.1)).toBe(0.4);
			expect(helpers.roundToStep(-0.35, 0.1)).toBe(-0.4);
			expect(helpers.roundToStep(-7.5, 5)).toBe(-10);
			expect(helpers.roundToStep(1.125, 0.25)).toBe(1.25);
		});

		it('should fall back to plain division when the decimal shift overflows', function () {
			expect(helpers.roundToStep(1e300, 1e-300)).toBe(1e300);
			expect(helpers.roundToStep(1e-300, 1e300)).toBe(0);
		});

		it('should return non-finite values unchanged', function () {
			expect(helpers.roundToStep(Infinity, 0.5)).toBe(Infinity);
			expect(helpers.roundToStep(NaN, 0.5)).toBeNaN();
		});

		it('should throw a RangeError for invalid steps', function () {
			for (const step of [0, -1, NaN, Infinity]) {
				expect(function () {
					helpers.roundToStep(1, step);
				}).toThrow(RangeError);
			}
		});
	});

	describe('argument validation', function () {
		it('uses the library-wide message format, with a TypeError for non-numbers', function () {
			expect(function () {
				helpers.round(1, 1.5);
			}).toThrow(new RangeError('round: `decimals` must be an integer, got 1.5'));
			expect(function () {
				helpers.round(1, '2' as any);
			}).toThrow(new TypeError('round: `decimals` must be an integer, got string'));
			expect(function () {
				helpers.gcd(4, 1.5);
			}).toThrow(new RangeError('gcd: `b` must be an integer, got 1.5'));
			expect(function () {
				helpers.normalize([1, NaN]);
			}).toThrow(new RangeError('normalize: `numbers[1]` must be a finite number, got NaN'));
			expect(function () {
				helpers.weightedAverage([1, 2], [1, -1]);
			}).toThrow(new RangeError('weightedAverage: `weights[1]` must be a finite number >= 0, got -1'));
			expect(function () {
				helpers.clamp(1, 2, 1);
			}).toThrow(new RangeError('clamp: `minimum` must not be greater than `maximum`, got 2 and 1'));
		});

		it('names the right function and parameter for every validated argument', function () {
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.factorial(-1);
					},
					new RangeError('factorial: `number` must be an integer >= 0, got -1')
				],
				[
					function () {
						return helpers.lcm(1.5, 2);
					},
					new RangeError('lcm: `a` must be an integer, got 1.5')
				],
				[
					function () {
						return helpers.gcd('1' as any, 2);
					},
					new TypeError('gcd: `a` must be an integer, got string')
				],
				[
					function () {
						return helpers.randomBetween(NaN, 1);
					},
					new RangeError('randomBetween: `minimum` must be a finite number, got NaN')
				],
				[
					function () {
						return helpers.randomBetween(0, Infinity);
					},
					new RangeError('randomBetween: `maximum` must be a finite number, got Infinity')
				],
				[
					function () {
						return helpers.randomBetween(2, 1);
					},
					new RangeError('randomBetween: `minimum` must not be greater than `maximum`, got 2 and 1')
				],
				[
					function () {
						return helpers.randomIntBetween(NaN, 1);
					},
					new RangeError('randomIntBetween: `minimum` must be a finite number, got NaN')
				],
				[
					function () {
						return helpers.randomIntBetween(0, '1' as any);
					},
					new TypeError('randomIntBetween: `maximum` must be a finite number, got string')
				],
				[
					function () {
						return helpers.randomIntBetween(1.2, 1.8);
					},
					new RangeError('randomIntBetween: no integer exists in [1.2, 1.8]')
				],
				[
					function () {
						return helpers.quantile([1], 2);
					},
					new RangeError('quantile: `q` must be a number in [0, 1], got 2')
				],
				[
					function () {
						return helpers.percentile([1], 101);
					},
					new RangeError('percentile: `p` must be a number in [0, 100], got 101')
				],
				[
					function () {
						return helpers.percentile([1], -1);
					},
					new RangeError('percentile: `p` must be a number in [0, 100], got -1')
				],
				[
					function () {
						return helpers.approximatelyEqual(1, 1, { relative: -1 });
					},
					new RangeError('approximatelyEqual: `relative` must be a number >= 0, got -1')
				],
				[
					function () {
						return helpers.approximatelyEqual(1, 1, { absolute: NaN });
					},
					new RangeError('approximatelyEqual: `absolute` must be a number >= 0, got NaN')
				],
				[
					function () {
						return helpers.weightedAverage([1], [1, 2]);
					},
					new RangeError('weightedAverage: `values` and `weights` must have the same length, got 1 and 2')
				],
				[
					function () {
						return helpers.formatBytes(Infinity);
					},
					new RangeError('formatBytes: `bytes` must be a finite number, got Infinity')
				],
				[
					function () {
						return helpers.formatBytes(1, { decimals: -1 });
					},
					new RangeError('formatBytes: `decimals` must be an integer >= 0, got -1')
				],
				[
					function () {
						return helpers.formatBytes(1, { base: 1023 as any });
					},
					new RangeError('formatBytes: `base` must be 1000 or 1024, got 1023')
				],
				[
					function () {
						return helpers.ordinal(1.5);
					},
					new RangeError('ordinal: `n` must be an integer, got 1.5')
				],
				[
					function () {
						return helpers.nthRoot(8, 0);
					},
					new RangeError('nthRoot: `n` must be an integer >= 1, got 0')
				],
				[
					function () {
						return helpers.roundToStep(1, 0);
					},
					new RangeError('roundToStep: `step` must be a finite number > 0, got 0')
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
		});
	});

	describe('security', function () {
		it('isPrime answers for the largest primes below 2 ** 53 in well under a millisecond (no trial division up to sqrt(n))', function () {
			const largePrimes = [9_007_199_254_740_881, 9_007_199_254_740_847, 4_503_599_627_370_449, 1_099_511_627_689, 4_294_967_291];
			const start = performance.now();
			for (let i = 0; i < 20; i++) for (const prime of largePrimes) expect(helpers.isPrime(prime)).toBe(true);
			// Trial division needs about 300 ms for EACH of the first two numbers.
			expect(performance.now() - start).toBeLessThan(250);
		});

		it('isPrime rejects the strong pseudoprimes to the first prime bases and Carmichael numbers', function () {
			const composites = [
				2047, // strong pseudoprime to base 2
				1_373_653, // bases 2, 3
				25_326_001, // bases 2, 3, 5
				3_215_031_751, // bases 2, 3, 5, 7
				2_152_302_898_747, // bases 2 .. 11
				3_474_749_660_383, // bases 2 .. 13
				341_550_071_728_321, // bases 2 .. 17 (and 19)
				561,
				41_041,
				825_265,
				321_197_185,
				5_394_826_801,
				232_250_619_601,
				9_746_347_772_161, // Carmichael numbers
				94_906_249 * 94_906_247, // the product of the two largest primes below sqrt(2 ** 53)
				67_108_859 * 134_217_689, // the product of two primes close to 2 ** 26 and 2 ** 27
				9_007_199_254_740_991 // 2 ** 53 - 1 = 6361 * 69431 * 20394401
			];
			for (const composite of composites) expect(helpers.isPrime(composite)).toBe(false);
		});

		it('aggregates convert numeric strings with unary plus instead of concatenating them', function () {
			const strings = new URLSearchParams('n=1&n=2&n=3').getAll('n') as never as number[];
			expect(helpers.sum(strings)).toBe(6);
			expect(helpers.average(strings)).toBe(2);
			expect(helpers.median(strings)).toBe(2);
			expect(helpers.product(strings)).toBe(6);
			expect(helpers.cumulativeSum(strings)).toEqual([1, 3, 6]);
			expect(helpers.variance(strings)).toBeCloseTo(2 / 3, 15);
			expect(helpers.standardDeviation(['2', '4', '4', '4', '5', '5', '7', '9'] as never as number[])).toBe(2);
			expect(helpers.max(['10', '9'] as never as number[])).toBe(10);
			expect(helpers.min(['10', '9'] as never as number[])).toBe(9);
			expect(helpers.mode(['1', 1, '2'] as never as number[])).toEqual([1]);
			expect(helpers.quantile(strings, 0.5)).toBe(2);
			expect(helpers.percentile(strings, 100)).toBe(3);
			expect(helpers.weightedAverage(['10', '20'] as never as number[], ['1', '3'] as never as number[])).toBe(17.5);
			expect(helpers.normalize(['10', '20', '15'] as never as number[])).toEqual([0, 1, 0.5]);
			// Values that do not convert give NaN, as in plain arithmetic.
			expect(helpers.sum(['1', 'x'] as never as number[])).toBe(NaN);
			expect(helpers.max(['x', 1] as never as number[])).toBe(NaN);
			expect(helpers.min([1, 'x'] as never as number[])).toBe(NaN);
			expect(function () {
				helpers.normalize(['1', 'x'] as never as number[]);
			}).toThrow(new TypeError('normalize: `numbers[1]` must be a finite number, got string'));
			expect(function () {
				helpers.sum([1n] as never as number[]);
			}).toThrow(TypeError);
		});

		it('aggregates convert each element exactly once', function () {
			let calls = 0;
			const two = {
				valueOf: function (): number {
					calls++;
					return 2;
				}
			} as never as number;
			for (const aggregate of [
				helpers.sum,
				helpers.average,
				helpers.product,
				helpers.max,
				helpers.min,
				helpers.variance,
				helpers.cumulativeSum,
				helpers.median,
				helpers.mode
			]) {
				calls = 0;
				aggregate([two, two, two]);
				expect(calls).toBe(3);
			}
		});

		it('randomIntBetween reaches every residue of ranges wider than 2 ** 32 with a 32-bit generator', function () {
			let state = 1;
			function lcg32(): number {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
				return state / 2 ** 32;
			}
			const lowBits = new Set<number>();
			for (let i = 0; i < 6000; i++) lowBits.add(helpers.randomIntBetween(0, 2 ** 40, lcg32) % 256);
			expect(lowBits.size).toBe(256);
			// Two draws make up the 53 bits: the high 21 bits from the first one, the low 32 bits from the second one.
			const draws = [0.5, 0.25];
			expect(
				helpers.randomIntBetween(0, 2 ** 53 - 1, function () {
					return draws.shift() as number;
				})
			).toBe(2 ** 52 + 2 ** 30);
			expect(helpers.randomIntBetween(0, 2 ** 53 - 1, constant(ALMOST_ONE))).toBe(2 ** 53 - 1);
			expect(helpers.randomIntBetween(-(2 ** 33), 2 ** 33, constant(0))).toBe(-(2 ** 33));
		});
	});
});
