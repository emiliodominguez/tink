import * as helpers from '.';

const MAX = Number.MAX_VALUE;

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
		it('should handle precisions of 1e21 digits and more', function () {
			expect(helpers.ceil(5, -1e21)).toBe(Infinity);
			expect(helpers.floor(-5, -1e21)).toBe(-Infinity);
		});

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

		it('should let the minimum win when the bounds cross, as CSS clamp() does', function () {
			// Before the first layout: `containerWidth - panelWidth` is negative.
			expect(helpers.clamp(120, 0, 0 - 300)).toBe(0);
			expect(helpers.clamp(1, 10, 0)).toBe(10);
			expect(helpers.clamp(-5, 10, 0)).toBe(10);
			expect(helpers.clamp(50, 10, 0)).toBe(10);
			expect(helpers.clamp(Infinity, 10, 0)).toBe(10);
			expect(helpers.clamp(5, Infinity, -Infinity)).toBe(Infinity);
			// `NaN` values still stay `NaN`.
			expect(helpers.clamp(NaN, 10, 0)).toBeNaN();
		});

		it('should throw a RangeError when a bound is NaN', function () {
			expect(function () {
				helpers.clamp(1, NaN, 0);
			}).toThrow(new RangeError('clamp: `minimum` must not be NaN'));
			expect(function () {
				helpers.clamp(1, 0, NaN);
			}).toThrow(new RangeError('clamp: `maximum` must not be NaN'));
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
		it('should not overflow for ranges wider than Number.MAX_VALUE', function () {
			expect(helpers.inverseLerp(-1e308, 1e308, 0)).toBe(0.5);
			expect(helpers.inverseLerp(-1e308, 1e308, 1e308)).toBe(1);
			expect(helpers.mapRange(0, -1e308, 1e308, 0, 1)).toBe(0.5);
		});

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

		it('roundToStep finds the nearest multiple between 2 ** 52 and 2 ** 53, and returns it as a decimal multiple', function () {
			expect(helpers.roundToStep(845493132055022.1, 0.7)).toBe(845493132055021.8);
			expect(helpers.roundToStep(622277132369530.25, 0.5)).toBe(622277132369530);
			expect(helpers.roundToStep(100446303783480.36, 0.05)).toBe(100446303783480.34);
			expect(helpers.roundToStep(4219485185534389, 0.9)).toBe(4219485185534389);
			expect(helpers.roundToStep(4.0451279852133525e30, 1e25)).toBe(4.04513e30);
			// A binary step keeps binary products: 3 * (1 / 3) is 1.
			expect(helpers.roundToStep(1, 1 / 3)).toBe(1);
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
			// Regression: the terms were divided by the count one by one, and their roundings added up past MAX_VALUE.
			expect(helpers.average([MAX, MAX, MAX])).toBe(MAX);
			expect(helpers.average([-MAX, -MAX, -MAX])).toBe(-MAX);
			expect(helpers.average([MAX, MAX, MAX, MAX, MAX, MAX, MAX])).toBe(MAX);
			expect(helpers.average([MAX, MAX, -MAX, MAX])).toBe(MAX / 2);
			expect(helpers.average(['1e308', 1e308, 1e308] as never)).toBe(1e308);
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
			// The standard deviation itself (1e308) does not overflow.
			expect(helpers.standardDeviation([-1e308, 1e308])).toBe(1e308);
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
				helpers.clamp(1, NaN, 1);
			}).toThrow(new RangeError('clamp: `minimum` must not be NaN'));
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

	describe('pass 3 regressions', function () {
		it('standardDeviation stays finite when the variance overflows', function () {
			expect(helpers.standardDeviation([1e200, -1e200])).toBe(1e200);
			expect(helpers.standardDeviation([1e200, -1e200], { sample: true })).toBeCloseTo(Math.SQRT2 * 1e200, -185);
			expect(Number.isFinite(helpers.standardDeviation([Number.MAX_VALUE, -Number.MAX_VALUE]))).toBe(true);
		});

		it('average agrees with averageBy', function () {
			expect(helpers.average([0.1, 0.2, 0.3])).toBe(0.2);
			expect(helpers.average([])).toBeNaN();
		});

		it('round, ceil and floor always return numbers', function () {
			expect(helpers.round('2.5' as never)).toBe(3);
			expect(helpers.ceil('1.1' as never, 2)).toBe(1.1);
			expect(helpers.round([2.5] as never)).toBe(3);
		});

		it('clamp rejects non-number bounds with a TypeError', function () {
			expect(function () {
				helpers.clamp(5, '9' as never, 10);
			}).toThrow(new TypeError('clamp: `minimum` must be a number, got string'));
		});

		it('weightedAverage validates the weights it uses', function () {
			let reads = 0;
			const flipping = {
				valueOf(): number {
					return reads++ < 1 ? 1 : -1;
				}
			};
			expect(helpers.weightedAverage([10, 20], [flipping as never, 1])).toBe(15);
		});

		it('parseBytes accepts zero sizes with huge exponents', function () {
			expect(helpers.parseBytes('0e999999999999999999999')).toBe(0);
			expect(helpers.parseBytes('1e-1000000000000000000000')).toBe(0);
		});
	});
});

/**
 * Loads a fresh copy of the module while `Math.sumPrecise` is `native` (the module checks it once, on the first call).
 */
function loadWithSumPrecise(native: unknown): typeof helpers {
	const math = Math as { sumPrecise?: unknown };
	const original = Object.getOwnPropertyDescriptor(Math, 'sumPrecise');
	let isolated: typeof helpers | undefined;

	try {
		math.sumPrecise = native;
		jest.isolateModules(function () {
			isolated = jest.requireActual<typeof helpers>('./index');
		});
		// The check runs on the first call: make it while the replacement is installed.
		isolated!.sumPrecise([]);
	} finally {
		if (original === undefined) delete math.sumPrecise;
		else Object.defineProperty(Math, 'sumPrecise', original);
	}

	return isolated!;
}

describe('sumPrecise', function () {
	it('should return the correctly rounded sum', function () {
		expect(helpers.sumPrecise([1, 2, 3, 4])).toBe(10);
		expect(helpers.sumPrecise([0.1, 0.2, 0.3])).toBe(0.6);
		expect(helpers.sumPrecise([1e20, 0.1, -1e20])).toBe(0.1);
		expect(helpers.sumPrecise([1, 1e100, 1, -1e100])).toBe(2);
		expect(helpers.sumPrecise([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe(1);
		expect(helpers.sumPrecise([2 ** 53, 1, 1])).toBe(2 ** 53 + 2);
		expect(helpers.sumPrecise([5e-324, 5e-324, -5e-324])).toBe(5e-324);
	});

	it('should round ties to even, and away from the tie when more partials follow', function () {
		expect(helpers.sumPrecise([1, 2 ** -53])).toBe(1);
		expect(helpers.sumPrecise([1 + 2 ** -52, 2 ** -53])).toBe(1 + 2 ** -51);
		expect(helpers.sumPrecise([1, 2 ** -53, 2 ** -105])).toBe(1 + 2 ** -52);
		expect(helpers.sumPrecise([1, 2 ** -53, -(2 ** -105)])).toBe(1);
		expect(helpers.sumPrecise([-1, -(2 ** -53), -(2 ** -105)])).toBe(-1 - 2 ** -52);
		expect(helpers.sumPrecise([-1, -(2 ** -53), 2 ** -105])).toBe(-1);
	});

	it('should break a tie between tiny partials (whose product underflows)', function () {
		// 2 ** -553 is half an ulp of 2 ** -500, and 2 ** -600 tips the sum past the tie.
		expect(helpers.sumPrecise([2 ** -500, 2 ** -553, 2 ** -600])).toBe(2 ** -500 + 2 ** -552);
		expect(helpers.sumPrecise([-(2 ** -500), -(2 ** -553), -(2 ** -600)])).toBe(-(2 ** -500) - 2 ** -552);
	});

	it('should give -0 for an empty sum or only negative zeros, +0 for any other zero sum', function () {
		expect(helpers.sumPrecise([])).toBe(-0);
		expect(helpers.sumPrecise([-0])).toBe(-0);
		expect(helpers.sumPrecise([-0, -0])).toBe(-0);
		expect(helpers.sumPrecise([-0, 0])).toBe(0);
		expect(helpers.sumPrecise([0])).toBe(0);
		expect(helpers.sumPrecise([1, -1])).toBe(0);
		expect(helpers.sumPrecise([-1, 1, -0])).toBe(0);
		expect(helpers.sumPrecise('' as never)).toBe(-0);
	});

	it('should follow the Math.sumPrecise rules for NaN and infinities', function () {
		expect(helpers.sumPrecise([NaN])).toBeNaN();
		expect(helpers.sumPrecise([1, NaN, 2])).toBeNaN();
		expect(helpers.sumPrecise([Infinity, -Infinity])).toBeNaN();
		expect(helpers.sumPrecise([Infinity, NaN])).toBeNaN();
		expect(helpers.sumPrecise([NaN, Infinity])).toBeNaN();
		expect(helpers.sumPrecise([Infinity, 1])).toBe(Infinity);
		expect(helpers.sumPrecise([Infinity, Infinity, -1e308])).toBe(Infinity);
		expect(helpers.sumPrecise([1e308, -Infinity, 1e308])).toBe(-Infinity);
		expect(helpers.sumPrecise([-0, -Infinity])).toBe(-Infinity);
	});

	it('should carry intermediate sums beyond Number.MAX_VALUE exactly', function () {
		expect(helpers.sumPrecise([1e308, 1e308, -1e308])).toBe(1e308);
		expect(helpers.sumPrecise([MAX, MAX, -MAX])).toBe(MAX);
		expect(helpers.sumPrecise([-MAX, -MAX, MAX])).toBe(-MAX);
		expect(helpers.sumPrecise([MAX, MAX, MAX, -MAX, -MAX])).toBe(MAX);
		expect(helpers.sumPrecise([MAX, MAX, -MAX, -MAX, 1])).toBe(1);
		expect(helpers.sumPrecise([2 ** 1023, 2 ** 1023, -(2 ** 1023)])).toBe(2 ** 1023);
		expect(helpers.sumPrecise([2 ** 1023, 2 ** 1023, -(2 ** 1023), 2 ** -1074])).toBe(2 ** 1023);
		// MAX + 2 ** 971 is 2 ** 1024.
		expect(helpers.sumPrecise([MAX, 2 ** 971, -(2 ** 1023), -(2 ** 1022)])).toBe(2 ** 1022);
		expect(helpers.sumPrecise([MAX, 2 ** 971, 2 ** 971, -MAX])).toBe(2 ** 972);
		// 2 ** 1024 carried, then a partial with bits below the ulp of the result: rounded once, ties to even.
		expect(helpers.sumPrecise([MAX, 2 ** 971, -(2 ** 1000 + 2 ** 948)])).toBe(MAX - 2 ** 1000 + 2 ** 971);
		expect(helpers.sumPrecise([MAX, 2 ** 971, -(2 ** 1000 + 2 ** 970)])).toBe(MAX - 2 ** 1000 + 2 ** 971);
		expect(helpers.sumPrecise([MAX, 2 ** 971, -(2 ** 1000 + 2 ** 970), -5e-324])).toBe(MAX - 2 ** 1000);
		expect(helpers.sumPrecise([-MAX, -(2 ** 971), 2 ** 1000 + 2 ** 970, 5e-324])).toBe(2 ** 1000 - MAX);
	});

	it('should overflow to Infinity only when the exact sum rounds beyond the doubles', function () {
		expect(helpers.sumPrecise([MAX, MAX])).toBe(Infinity);
		expect(helpers.sumPrecise([-MAX, -MAX])).toBe(-Infinity);
		expect(helpers.sumPrecise([MAX, MAX, MAX, -MAX])).toBe(Infinity);
		expect(helpers.sumPrecise([MAX, MAX, MAX])).toBe(Infinity);
		expect(helpers.sumPrecise([2 ** 1023, 2 ** 1023])).toBe(Infinity);
		expect(helpers.sumPrecise([2 ** 1023, 2 ** 1023, 1])).toBe(Infinity);
		// MAX + half an ulp is a tie, which rounds to even: Infinity, unless more of the sum lies below it.
		expect(helpers.sumPrecise([MAX, 2 ** 970])).toBe(Infinity);
		expect(helpers.sumPrecise([MAX, 2 ** 970, 5e-324])).toBe(Infinity);
		expect(helpers.sumPrecise([MAX, 2 ** 970, -5e-324])).toBe(MAX);
		expect(helpers.sumPrecise([-MAX, -(2 ** 970)])).toBe(-Infinity);
		expect(helpers.sumPrecise([-MAX, -(2 ** 970), 5e-324])).toBe(-MAX);
		expect(helpers.sumPrecise([MAX, 2 ** 969])).toBe(MAX);
	});

	it('should accept any iterable of numbers', function () {
		expect(helpers.sumPrecise(new Set([1, 2, 3]))).toBe(6);
		expect(helpers.sumPrecise(new Float64Array([0.1, 0.2]))).toBe(0.30000000000000004);
		expect(
			helpers.sumPrecise(
				(function* () {
					yield 1e20;
					yield 1;
					yield -1e20;
				})()
			)
		).toBe(1);
	});

	it('should throw a TypeError for a non-iterable or an item that is not a number', function () {
		expect(function () {
			helpers.sumPrecise(null as never);
		}).toThrow(new TypeError('sumPrecise: `numbers` must be an iterable, got null'));
		expect(function () {
			helpers.sumPrecise(undefined as never);
		}).toThrow(new TypeError('sumPrecise: `numbers` must be an iterable, got undefined'));
		expect(function () {
			helpers.sumPrecise({ length: 1, 0: 1 } as never);
		}).toThrow(new TypeError('sumPrecise: `numbers` must be an iterable, got object'));
		expect(function () {
			helpers.sumPrecise(['1'] as never);
		}).toThrow(new TypeError('sumPrecise: `numbers[0]` must be a number, got string'));
		expect(function () {
			helpers.sumPrecise([1, 2n] as never);
		}).toThrow(new TypeError('sumPrecise: `numbers[1]` must be a number, got bigint'));
		expect(function () {
			helpers.sumPrecise([NaN, new Number(1)] as never);
		}).toThrow(new TypeError('sumPrecise: `numbers[1]` must be a number, got object'));
		expect(function () {
			helpers.sumPrecise('12' as never);
		}).toThrow(TypeError);
	});

	it('should close the iterator when an item is rejected', function () {
		let closed = false;
		function* numbers(): Generator<unknown> {
			try {
				yield 1;
				yield 'two';
				yield 3;
			} finally {
				closed = true;
			}
		}
		expect(function () {
			helpers.sumPrecise(numbers() as Iterable<number>);
		}).toThrow(TypeError);
		expect(closed).toBe(true);
	});

	it('should delegate to a native Math.sumPrecise that passes the check, with validated items', function () {
		const calls: unknown[] = [];
		const isolated = loadWithSumPrecise(function (items: number[]) {
			calls.push(items);
			// Exact on the probes (this module's own sum), and recognizable on the items of the test.
			const marked = (items.length === 2 && items[0] === 1 && items[1] === 2) || (items.length === 1 && items[0] === 3);
			return marked ? 42 : helpers.sumPrecise(items);
		});
		calls.length = 0;
		expect(isolated.sumPrecise([1, 2])).toBe(42);
		expect(isolated.sumPrecise(new Float64Array([3]))).toBe(42);
		expect(calls).toEqual([[1, 2], [3]]);
		// Other iterables are streamed, not copied for the native function.
		expect(isolated.sumPrecise(new Set([1, 2]))).toBe(3);
		expect(calls).toHaveLength(2);
		expect(function () {
			isolated.sumPrecise([1, '2'] as never);
		}).toThrow(new TypeError('sumPrecise: `numbers[1]` must be a number, got string'));
		expect(calls).toHaveLength(2);
	});

	it('should not use a native Math.sumPrecise that fails the check or throws', function () {
		const naive = loadWithSumPrecise(function (items: number[]) {
			return items.reduce(function (total, value) {
				return total + value;
			}, -0);
		});
		expect(naive.sumPrecise([1e308, 1e308, -1e308])).toBe(1e308);
		const noNegativeZero = loadWithSumPrecise(function () {
			return 1e308;
		});
		expect(noNegativeZero.sumPrecise([1, 2])).toBe(3);
		const throwing = loadWithSumPrecise(function () {
			throw new Error('broken');
		});
		expect(throwing.sumPrecise([1, 2])).toBe(3);
		const notAFunction = loadWithSumPrecise(42);
		expect(notAFunction.sumPrecise([1, 2])).toBe(3);
	});

	it('should not use an inexact polyfill that gets the overflow and empty-sum cases right', function () {
		// Regression: a compensated (Neumaier) sum with special cases for the two cases that used to be probed was trusted.
		function compensated(items: number[]): number {
			if (items.length === 0) return -0;
			if (items.length === 3 && items[0] === 1e308 && items[1] === 1e308 && items[2] === -1e308) return 1e308;
			let total = 0;
			let compensation = 0;
			for (const value of items) {
				const next = total + value;
				compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
				total = next;
			}
			return total + compensation;
		}
		expect(compensated([1, 1e-20, -1e16])).toBe(-1e16);
		const isolated = loadWithSumPrecise(compensated);
		expect(isolated.sumPrecise([1, 1e-20, -1e16])).toBe(-9999999999999998);
		expect(isolated.sumPrecise([5e-324, 5e-324, 5e-324])).toBe(1.5e-323);
	});
});

describe('movingAverage', function () {
	it('should average every window of consecutive values', function () {
		expect(helpers.movingAverage([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
		expect(helpers.movingAverage([1, 2, 3, 4, 5], 1)).toEqual([1, 2, 3, 4, 5]);
		expect(helpers.movingAverage([1, 2, 3, 4, 5], 5)).toEqual([3]);
		expect(helpers.movingAverage([2, 4], 2)).toEqual([3]);
	});

	it('should return an empty array when there are fewer values than the window', function () {
		expect(helpers.movingAverage([1, 2], 3)).toEqual([]);
		expect(helpers.movingAverage([], 1)).toEqual([]);
	});

	it('should not drift: each average is the exact window sum, rounded once, divided by the window', function () {
		expect(helpers.movingAverage([1e20, 1, 2, 3], 2)).toEqual([5e19, 1.5, 2.5]);
		expect(helpers.movingAverage([0.1, 0.2, 0.3, 0.4], 3)).toEqual([0.6 / 3, 0.9 / 3]);
		// An incremental float sum loses the 1s next to 1e17, and never gets them back (it starts and ends with 0 instead of 0.5 and 1).
		const values = [1e17, 1, 1, -1e17, 1, 1, 1, 1];
		expect(helpers.movingAverage(values, 4)).toEqual([0.5, -2.5e16, -2.5e16, -2.5e16, 1]);
		const long = Array.from({ length: 10_000 }, function (_, index) {
			return index % 2 === 0 ? 0.1 : 1e15;
		});
		const averages = helpers.movingAverage(long, 2);
		expect(
			averages.every(function (average) {
				return average === (0.1 + 1e15) / 2;
			})
		).toBe(true);
	});

	it('should only let NaN and infinities affect the windows that hold them', function () {
		expect(helpers.movingAverage([1, NaN, 3, 4], 2)).toEqual([NaN, NaN, 3.5]);
		expect(helpers.movingAverage([Infinity, 1, 2], 2)).toEqual([Infinity, 1.5]);
		expect(helpers.movingAverage([-Infinity, 1, 2], 2)).toEqual([-Infinity, 1.5]);
		expect(helpers.movingAverage([Infinity, -Infinity, 2, 4], 2)).toEqual([NaN, -Infinity, 3]);
		expect(helpers.movingAverage([NaN, Infinity, 1, 1], 2)).toEqual([NaN, Infinity, 1]);
	});

	it('should keep the sign of zero like sumPrecise', function () {
		expect(helpers.movingAverage([-0, -0, 0, -0], 2)).toEqual([-0, 0, 0]);
		expect(Object.is(helpers.movingAverage([-0], 1)[0], -0)).toBe(true);
		expect(Object.is(helpers.movingAverage([1, -1], 2)[0], 0)).toBe(true);
	});

	it('should keep the averages of windows whose sum overflows finite', function () {
		// Regression: the mean of overflowing windows was computed on rounded halves, 2 ulps below MAX here.
		expect(helpers.movingAverage([MAX, MAX, MAX], 3)).toEqual([MAX]);
		expect(helpers.movingAverage([-MAX, -MAX, -MAX, -MAX, -MAX], 4)).toEqual([-MAX, -MAX]);
		expect(helpers.movingAverage([MAX, MAX, MAX], 2)).toEqual([MAX, MAX]);
		expect(helpers.movingAverage([-MAX, -MAX], 2)).toEqual([-MAX]);
		expect(helpers.movingAverage([1e308, 1e308, -1e308, 1e308], 2)).toEqual([1e308, 0, 0]);
		const [average] = helpers.movingAverage([MAX, MAX, 1e308], 3);
		expect(Math.abs(average - (MAX / 3) * 2 - 1e308 / 3) / average).toBeLessThan(4 * Number.EPSILON);
		const [negative] = helpers.movingAverage([-MAX, -1e308, -1e308, -1e308], 4);
		expect(Math.abs(negative + MAX / 4 + (1e308 / 4) * 3) / -negative).toBeLessThan(4 * Number.EPSILON);
	});

	it('should convert values once with unary plus, like the other aggregates', function () {
		expect(helpers.movingAverage(['1', '2', '3'] as never, 2)).toEqual([1.5, 2.5]);
		// eslint-disable-next-line no-sparse-arrays
		expect(helpers.movingAverage([1, , 3] as never, 2)).toEqual([NaN, NaN]);
		let reads = 0;
		const values = new Proxy([1, 2, 3], {
			get(target, key, receiver) {
				if (key !== 'length') reads++;
				return Reflect.get(target, key, receiver);
			}
		});
		expect(helpers.movingAverage(values, 2)).toEqual([1.5, 2.5]);
		expect(reads).toBe(3);
		expect(function () {
			helpers.movingAverage([1n] as never, 1);
		}).toThrow(TypeError);
	});

	it('should validate the window', function () {
		expect(function () {
			helpers.movingAverage([1, 2], 0);
		}).toThrow(new RangeError('movingAverage: `window` must be an integer >= 1, got 0'));
		expect(function () {
			helpers.movingAverage([1, 2], 1.5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.movingAverage([1, 2], NaN);
		}).toThrow(RangeError);
		expect(function () {
			helpers.movingAverage([1, 2], Infinity);
		}).toThrow(RangeError);
		expect(function () {
			helpers.movingAverage([1, 2], '2' as never);
		}).toThrow(new TypeError('movingAverage: `window` must be an integer >= 1, got string'));
	});

	it('should stay linear on long series and wide windows', function () {
		const values = Array.from({ length: 20_000 }, function (_, index) {
			return Math.sin(index) * 10 ** (index % 40);
		});
		const start = performance.now();
		// Recomputing each window would take 10,000 additions per average.
		expect(helpers.movingAverage(values, 10_000)).toHaveLength(10_001);
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe('toSignificant', function () {
	it('should round to the given number of significant digits', function () {
		expect(helpers.toSignificant(123456, 2)).toBe(120000);
		expect(helpers.toSignificant(123456, 1)).toBe(100000);
		expect(helpers.toSignificant(0.000123456, 3)).toBe(0.000123);
		expect(helpers.toSignificant(123.456, 4)).toBe(123.5);
		expect(helpers.toSignificant(-123.456, 4)).toBe(-123.5);
		expect(helpers.toSignificant(1.23456e25, 3)).toBe(1.23e25);
		expect(helpers.toSignificant(1.5e-7, 1)).toBe(2e-7);
		expect(helpers.toSignificant(9.876e-200, 2)).toBe(9.9e-200);
		expect(helpers.toSignificant(Math.PI, 3)).toBe(3.14);
	});

	it('should round as written next to powers of ten, where the fast path does not apply', function () {
		// 1e23 is the double 99999999999999991611392, which String writes as 1e+23.
		expect(helpers.toSignificant(1e23, 1)).toBe(1e23);
		expect(helpers.toSignificant(1e23, 2)).toBe(1e23);
		expect(helpers.toSignificant(1000, 2)).toBe(1000);
		expect(helpers.toSignificant(0.001, 1)).toBe(0.001);
		expect(helpers.toSignificant(999.9999999999999, 3)).toBe(1000);
		expect(helpers.toSignificant(1.0000000000000002, 2)).toBe(1);
		expect(helpers.toSignificant(9.999999999999999e-5, 15)).toBe(0.0001);
		expect(helpers.toSignificant(123.456e-30, 2)).toBe(1.2e-28);
		expect(helpers.toSignificant(123.456e30, 2)).toBe(1.2e32);
	});

	it('should carry into a new digit', function () {
		expect(helpers.toSignificant(-9.96, 2)).toBe(-10);
		expect(helpers.toSignificant(999.5, 3)).toBe(1000);
		expect(helpers.toSignificant(0.0995, 2)).toBe(0.1);
		expect(helpers.toSignificant(9.5, 1)).toBe(10);
	});

	it('should round ties half away from zero, as written', function () {
		expect(helpers.toSignificant(2.5, 1)).toBe(3);
		expect(helpers.toSignificant(-2.5, 1)).toBe(-3);
		expect(helpers.toSignificant(1.005, 3)).toBe(1.01);
		expect(helpers.toSignificant(-1.005, 3)).toBe(-1.01);
		expect(helpers.toSignificant(0.125, 2)).toBe(0.13);
		expect(helpers.toSignificant(1.45, 2)).toBe(1.5);
		expect(helpers.toSignificant(8.345e-10, 3)).toBe(8.35e-10);
	});

	it('should return numbers with at most `digits` significant digits unchanged', function () {
		expect(helpers.toSignificant(0.1, 1)).toBe(0.1);
		expect(helpers.toSignificant(120000, 2)).toBe(120000);
		expect(helpers.toSignificant(1e21, 1)).toBe(1e21);
		expect(helpers.toSignificant(0.1 + 0.2, 17)).toBe(0.30000000000000004);
		expect(helpers.toSignificant(0.1 + 0.2, 100)).toBe(0.30000000000000004);
		expect(helpers.toSignificant(0.1 + 0.2, 16)).toBe(0.3);
		expect(helpers.toSignificant(MAX, 17)).toBe(MAX);
	});

	it('should keep zeros, NaN and infinities as they are', function () {
		expect(helpers.toSignificant(0, 3)).toBe(0);
		expect(helpers.toSignificant(-0, 3)).toBe(-0);
		expect(helpers.toSignificant(NaN, 3)).toBeNaN();
		expect(helpers.toSignificant(Infinity, 3)).toBe(Infinity);
		expect(helpers.toSignificant(-Infinity, 3)).toBe(-Infinity);
	});

	it('should handle subnormal numbers and overflow past the largest double', function () {
		expect(helpers.toSignificant(5e-324, 1)).toBe(5e-324);
		expect(helpers.toSignificant(2.5e-323, 1)).toBe(3e-323);
		expect(helpers.toSignificant(1.7976931348623157e308, 1)).toBe(Infinity);
		expect(helpers.toSignificant(-1.7976931348623157e308, 2)).toBe(-Infinity);
		expect(helpers.toSignificant(1.7976931348623157e308, 3)).toBe(Infinity);
		// 1.797693134862316e308 is beyond the doubles too.
		expect(helpers.toSignificant(1.7976931348623157e308, 16)).toBe(Infinity);
		expect(helpers.toSignificant(1.7976931348623155e308, 16)).toBe(Infinity);
		expect(helpers.toSignificant(1.7976931348623153e308, 16)).toBe(1.797693134862315e308);
	});

	it('should convert the number with unary plus, like round', function () {
		expect(helpers.toSignificant('1234' as never, 2)).toBe(1200);
		expect(helpers.toSignificant(null as never, 2)).toBe(0);
		expect(function () {
			helpers.toSignificant(1n as never, 2);
		}).toThrow(TypeError);
	});

	it('should validate digits', function () {
		for (const digits of [0, 101, 1.5, -1, NaN, Infinity]) {
			expect(function () {
				helpers.toSignificant(1, digits);
			}).toThrow(new RangeError(`toSignificant: \`digits\` must be an integer between 1 and 100, got ${digits}`));
		}
		expect(function () {
			helpers.toSignificant(1, '3' as never);
		}).toThrow(new TypeError('toSignificant: `digits` must be an integer between 1 and 100, got string'));
		expect(function () {
			helpers.toSignificant(1, undefined as never);
		}).toThrow(TypeError);
	});
});

describe('histogram', function () {
	it('should split the extent of the values into equal-width bins', function () {
		expect(helpers.histogram([1, 2, 2, 3, 4], { bins: 3 })).toEqual([
			{ x0: 1, x1: 2, count: 1 },
			{ x0: 2, x1: 3, count: 2 },
			{ x0: 3, x1: 4, count: 2 }
		]);
		expect(helpers.histogram([0, 10], { bins: 2 })).toEqual([
			{ x0: 0, x1: 5, count: 1 },
			{ x0: 5, x1: 10, count: 1 }
		]);
	});

	it('should use correctly rounded edges', function () {
		expect(
			helpers.histogram([0, 1], { bins: 10 }).map(function (bin) {
				return bin.x0;
			})
		).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
	});

	it("should default to Sturges' rule", function () {
		expect(helpers.histogram([1, 2, 3, 4, 5, 6, 7, 8])).toHaveLength(4);
		expect(helpers.histogram([1, 2, 3, 4, 5, 6, 7, 8, 9])).toHaveLength(5);
		expect(helpers.histogram([1, 2])).toEqual([
			{ x0: 1, x1: 1.5, count: 1 },
			{ x0: 1.5, x1: 2, count: 1 }
		]);
		expect(helpers.histogram([], { domain: [0, 1] })).toEqual([{ x0: 0, x1: 1, count: 0 }]);
	});

	it('should give a single bin when every value is equal', function () {
		expect(helpers.histogram([7])).toEqual([{ x0: 7, x1: 7, count: 1 }]);
		expect(helpers.histogram([7, 7, 7], { bins: 5 })).toEqual([{ x0: 7, x1: 7, count: 3 }]);
		expect(helpers.histogram([7, 8], { bins: 5, domain: [7, 7] })).toEqual([{ x0: 7, x1: 7, count: 1 }]);
		expect(helpers.histogram([7], { thresholds: [5, 7, 9] })).toEqual([{ x0: 7, x1: 7, count: 1 }]);
	});

	it('should return no bins for no values and no domain', function () {
		expect(helpers.histogram([])).toEqual([]);
		expect(helpers.histogram([], { bins: 3 })).toEqual([]);
		expect(helpers.histogram([], { thresholds: [1, 2] })).toEqual([]);
	});

	it('should put values on an inner edge in the bin above, and the maximum in the last bin', function () {
		expect(
			helpers.histogram([0, 5, 10, 10], { bins: 2 }).map(function (bin) {
				return bin.count;
			})
		).toEqual([1, 3]);
		expect(
			helpers.histogram([0, 4.999, 5], { thresholds: [5], domain: [0, 10] }).map(function (bin) {
				return bin.count;
			})
		).toEqual([2, 1]);
	});

	it('should cover the domain and skip the values outside it', function () {
		expect(helpers.histogram([-5, 0, 0.5, 1, 1.5], { bins: 2, domain: [0, 1] })).toEqual([
			{ x0: 0, x1: 0.5, count: 1 },
			{ x0: 0.5, x1: 1, count: 2 }
		]);
		expect(helpers.histogram([5, 25, 30, 31], { thresholds: [10, 20], domain: [0, 30] })).toEqual([
			{ x0: 0, x1: 10, count: 1 },
			{ x0: 10, x1: 20, count: 0 },
			{ x0: 20, x1: 30, count: 2 }
		]);
	});

	it('should ignore the thresholds outside the open domain, so edges can include the bounds', function () {
		const expected = [
			{ x0: 0, x1: 10, count: 1 },
			{ x0: 10, x1: 20, count: 1 },
			{ x0: 20, x1: 30, count: 1 }
		];
		expect(helpers.histogram([1, 11, 21], { thresholds: [0, 10, 20, 30], domain: [0, 30] })).toEqual(expected);
		expect(helpers.histogram([1, 11, 21], { thresholds: [-10, 0, 10, 20, 30, 40], domain: [0, 30] })).toEqual(expected);
		expect(helpers.histogram([1, 11, 21], { thresholds: [10, 20], domain: [0, 30] })).toEqual(expected);
		// Without a domain, the extent of the values bounds the bins.
		expect(helpers.histogram([3, 12, 17], { thresholds: [0, 10, 20] })).toEqual([
			{ x0: 3, x1: 10, count: 1 },
			{ x0: 10, x1: 17, count: 2 }
		]);
		expect(helpers.histogram([3, 12], { thresholds: [] })).toEqual([{ x0: 3, x1: 12, count: 2 }]);
	});

	it('should keep the edges finite and ordered for domains wider than Number.MAX_VALUE', function () {
		expect(helpers.histogram([-1e308, 1e308, 0], { bins: 4 })).toEqual([
			{ x0: -1e308, x1: -5e307, count: 1 },
			{ x0: -5e307, x1: 0, count: 0 },
			{ x0: 0, x1: 5e307, count: 1 },
			{ x0: 5e307, x1: 1e308, count: 1 }
		]);
		const edges = helpers.histogram([0, 1e308], { bins: 10 }).map(function (bin) {
			return bin.x0;
		});
		expect(edges).toHaveLength(10);
		edges.forEach(function (edge, index) {
			expect(Math.abs(edge - index * 1e307)).toBeLessThanOrEqual(index * 1e307 * Number.EPSILON);
		});
		const extreme = helpers.histogram([-MAX, MAX], { bins: 3 });
		expect(extreme[0].x0).toBe(-MAX);
		expect(extreme[2].x1).toBe(MAX);
		expect(extreme[1].x0).toBeLessThan(extreme[1].x1);
		expect(
			extreme.map(function (bin) {
				return bin.count;
			})
		).toEqual([1, 0, 1]);
	});

	it('should only accept finite numbers as values, read once', function () {
		// Regression: values used to be converted with unary plus, so null, '' and [] counted as 0 and stretched the domain.
		for (const [value, type] of [
			[null, 'null'],
			['', 'string'],
			['1', 'string'],
			['Infinity', 'string'],
			[[], 'object'],
			[true, 'boolean']
		] as const) {
			expect(function () {
				helpers.histogram([5, value as never, 6]);
			}).toThrow(new TypeError(`histogram: \`values[1]\` must be a finite number, got ${type}`));
		}
		expect(function () {
			helpers.histogram([1, NaN]);
		}).toThrow(new RangeError('histogram: `values[1]` must be a finite number, got NaN'));
		expect(function () {
			helpers.histogram([Infinity], { domain: [0, 1] });
		}).toThrow(new RangeError('histogram: `values[0]` must be a finite number, got Infinity'));
		expect(function () {
			helpers.histogram(['x'] as never);
		}).toThrow(new TypeError('histogram: `values[0]` must be a finite number, got string'));
		expect(function () {
			// eslint-disable-next-line no-sparse-arrays
			helpers.histogram([1, , 2] as never);
		}).toThrow(new TypeError('histogram: `values[1]` must be a finite number, got undefined'));
		expect(function () {
			helpers.histogram([1n] as never);
		}).toThrow(new TypeError('histogram: `values[0]` must be a finite number, got bigint'));
		let reads = 0;
		const values = new Proxy([1, 2, 3], {
			get(target, key, receiver) {
				if (key !== 'length') reads++;
				return Reflect.get(target, key, receiver);
			}
		});
		expect(helpers.histogram(values, { bins: 1 })).toEqual([{ x0: 1, x1: 3, count: 3 }]);
		expect(reads).toBe(3);
	});

	it('should validate bins', function () {
		// Regression: 2 ** 31 - 1 bins made the runtime abort with an out-of-memory error.
		for (const bins of [0, 1.5, -1, NaN, Infinity, 2 ** 20 + 1, 2 ** 31 - 1]) {
			expect(function () {
				helpers.histogram([1], { bins });
			}).toThrow(new RangeError(`histogram: \`bins\` must be an integer between 1 and 1048576, got ${bins}`));
		}
		expect(function () {
			helpers.histogram([1], { bins: '2' as never });
		}).toThrow(new TypeError('histogram: `bins` must be an integer between 1 and 1048576, got string'));
		expect(function () {
			helpers.histogram([1], { bins: 2, thresholds: [1] } as never);
		}).toThrow(new TypeError('histogram: `bins` and `thresholds` cannot be used together'));
	});

	it('should validate thresholds', function () {
		expect(function () {
			helpers.histogram([1], { thresholds: 5 as never });
		}).toThrow(new TypeError('histogram: `thresholds` must be an array, got number'));
		expect(function () {
			helpers.histogram([1], { thresholds: [1, 3, 2] });
		}).toThrow(new RangeError('histogram: `thresholds` must be strictly increasing, got 3 before 2'));
		expect(function () {
			helpers.histogram([1], { thresholds: [1, 1] });
		}).toThrow(new RangeError('histogram: `thresholds` must be strictly increasing, got 1 before 1'));
		expect(function () {
			helpers.histogram([1], { thresholds: [1, NaN] });
		}).toThrow(new RangeError('histogram: `thresholds[1]` must be a finite number, got NaN'));
		expect(function () {
			helpers.histogram([1], { thresholds: [-Infinity] });
		}).toThrow(new RangeError('histogram: `thresholds[0]` must be a finite number, got -Infinity'));
		expect(function () {
			helpers.histogram([1], { thresholds: ['1'] as never });
		}).toThrow(new TypeError('histogram: `thresholds[0]` must be a finite number, got string'));
	});

	it('should validate the domain', function () {
		expect(function () {
			helpers.histogram([1], { domain: 5 as never });
		}).toThrow(new TypeError('histogram: `domain` must be an array of two numbers, got number'));
		expect(function () {
			helpers.histogram([1], { domain: [1, 2, 3] as never });
		}).toThrow(new TypeError('histogram: `domain` must be an array of two numbers, got object'));
		expect(function () {
			helpers.histogram([1], { domain: [2, 1] });
		}).toThrow(new RangeError('histogram: `domain` must be in increasing order, got [2, 1]'));
		expect(function () {
			helpers.histogram([1], { domain: [0, Infinity] });
		}).toThrow(new RangeError('histogram: `domain[1]` must be a finite number, got Infinity'));
		expect(function () {
			helpers.histogram([1], { domain: ['0', 1] as never });
		}).toThrow(new TypeError('histogram: `domain[0]` must be a finite number, got string'));
	});

	it('should read each option once', function () {
		let reads = 0;
		const options = {
			get thresholds(): number[] {
				reads++;
				return reads === 1 ? [5] : [1, 0];
			}
		};
		expect(helpers.histogram([0, 10], options)).toEqual([
			{ x0: 0, x1: 5, count: 1 },
			{ x0: 5, x1: 10, count: 1 }
		]);
		let thresholdReads = 0;
		const thresholds = new Proxy([5], {
			get(target, key, receiver) {
				if (key === '0') thresholdReads++;
				return Reflect.get(target, key, receiver);
			}
		});
		helpers.histogram([0, 10], { thresholds });
		expect(thresholdReads).toBe(1);
	});

	it('should place values in O(n log b)', function () {
		const values = Array.from({ length: 50_000 }, function (_, index) {
			return (index * 7919) % 100_003;
		});
		const start = performance.now();
		// A linear scan of the bins would take 50,000 × 50,000 steps.
		const bins = helpers.histogram(values, { bins: 50_000 });
		expect(performance.now() - start).toBeLessThan(2000);
		expect(
			bins.reduce(function (total, bin) {
				return total + bin.count;
			}, 0)
		).toBe(50_000);
	});
});

describe('Math helpers under prototype pollution', function () {
	it('read their options as own properties only', function () {
		const clean = helpers.histogram([1, 2, 3, 4]);
		const polluted = Object.prototype as Record<string, unknown>;
		Object.assign(polluted, { thresholds: [2], domain: [0, 100], decimals: 5, base: 1024, relative: 1, absolute: 1 });
		try {
			expect(helpers.histogram([1, 2, 3, 4])).toEqual(clean);
			expect(helpers.approximatelyEqual(1, 2)).toBe(false);
			expect(helpers.approximatelyEqual(1, 2, {})).toBe(false);
			expect(function () {
				helpers.approximatelyEqual(1, 2, null as unknown as object);
			}).toThrow(TypeError);
			// An own option equal to the polluted value is still an option.
			expect(helpers.approximatelyEqual(1, 2, { absolute: 1 })).toBe(true);
			expect(helpers.approximatelyEqual(1, 2, { relative: 1 })).toBe(true);
			expect(helpers.approximatelyEqual(1, 2, { absolute: 0.5 })).toBe(false);
		} finally {
			for (const key of ['thresholds', 'domain', 'decimals', 'base', 'relative', 'absolute']) delete polluted[key];
		}
	});
});

describe('extent', function () {
	it('finds the smallest and largest values in one pass', function () {
		expect(helpers.extent([3, 1, 4, 1, 5])).toEqual([1, 5]);
		expect(helpers.extent([-2])).toEqual([-2, -2]);
		expect(helpers.extent([Infinity, -Infinity, 0])).toEqual([-Infinity, Infinity]);
		expect(helpers.extent([Infinity])).toEqual([Infinity, Infinity]);
	});

	it('reads any iterable once, including a generator', function () {
		function* values(): Generator<number> {
			yield 5;
			yield -1;
			yield 2;
		}
		expect(helpers.extent(values())).toEqual([-1, 5]);
		expect(helpers.extent(new Set([7]))).toEqual([7, 7]);
	});

	it('is undefined for no numbers, and [NaN, NaN] when one is NaN', function () {
		expect(helpers.extent([])).toBeUndefined();
		expect(helpers.extent([1, NaN, 2])).toEqual([NaN, NaN]);
		expect(helpers.extent(['x'] as never)).toEqual([NaN, NaN]);
	});

	it('orders -0 before 0, like min and max', function () {
		const [low, high] = helpers.extent([0, -0]) as [number, number];
		expect(Object.is(low, -0) && Object.is(high, 0)).toBe(true);
		const [low2, high2] = helpers.extent([-0, 0]) as [number, number];
		expect(Object.is(low2, -0) && Object.is(high2, 0)).toBe(true);
		const [low3, high3] = helpers.extent([-0]) as [number, number];
		expect(Object.is(low3, -0) && Object.is(high3, -0)).toBe(true);
	});

	it('converts elements with unary +', function () {
		expect(helpers.extent(['10', '9'] as never)).toEqual([9, 10]);
	});
});

describe('wrap', function () {
	it('wraps values cyclically into [minimum, maximum)', function () {
		expect(helpers.wrap(370, 0, 360)).toBe(10);
		expect(helpers.wrap(-10, 0, 360)).toBe(350);
		expect(helpers.wrap(720, 0, 360)).toBe(0);
		expect(helpers.wrap(360, 0, 360)).toBe(0);
		expect(helpers.wrap(190, -180, 180)).toBe(-170);
		expect(helpers.wrap(-180, -180, 180)).toBe(-180);
		expect(helpers.wrap(180, -180, 180)).toBe(-180);
		expect(helpers.wrap(-1, 0, 5)).toBe(4);
		expect(helpers.wrap(-6, 0, 5)).toBe(4);
		expect(helpers.wrap(5.5, 0, 1)).toBe(0.5);
		expect(helpers.wrap(2.75, 0.5, 1.5)).toBe(0.75);
	});

	it('returns a value in range as is, -0 included', function () {
		expect(helpers.wrap(0.1, 0, 1)).toBe(0.1);
		expect(helpers.wrap(-0, 0, 1)).toBe(-0);
		expect(helpers.wrap(1e-300, 0, 1)).toBe(1e-300);
	});

	it('is exact for integers, even far from the range', function () {
		expect(helpers.wrap(2 ** 53 - 1, 0, 7)).toBe((2 ** 53 - 1) % 7);
		expect(helpers.wrap(-(2 ** 53) + 1, 0, 10)).toBe(9);
		expect(helpers.wrap(1e300, 0, 1024)).toBe(0);
	});

	it('returns minimum when the result rounds up to maximum', function () {
		// The exact result, 3 - 2 ** -52, rounds to 3.
		expect(helpers.wrap(1 - 2 ** -52, 1, 3)).toBe(1);
		expect(helpers.wrap(-1e-20, 0, 1)).toBe(0);
	});

	it('does not overflow when the span or the distance to minimum exceeds Number.MAX_VALUE', function () {
		expect(helpers.wrap(1.7e308, -1e308, 1e308)).toBeCloseTo(-0.3e308, -300);
		expect(helpers.wrap(-1.7e308, -1e308, 1e308)).toBeCloseTo(0.3e308, -300);
		expect(helpers.wrap(1e308, -1e308, -0.9e308)).toBeGreaterThanOrEqual(-1e308);
		expect(helpers.wrap(1e308, -1e308, -0.9e308)).toBeLessThan(-0.9e308);
		expect(helpers.wrap(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE)).toBe(-Number.MAX_VALUE);
	});

	it('gives NaN for a value that is not finite', function () {
		expect(helpers.wrap(NaN, 0, 1)).toBeNaN();
		expect(helpers.wrap(Infinity, 0, 1)).toBeNaN();
		expect(helpers.wrap(-Infinity, 0, 1)).toBeNaN();
		expect(helpers.wrap(Infinity, -1e308, 1e308)).toBeNaN();
	});

	it('rejects bounds that are not finite or not in increasing order', function () {
		expect(function () {
			helpers.wrap(1, 3, 3);
		}).toThrow(new RangeError('wrap: `minimum` must be less than `maximum`, got 3 and 3'));
		expect(function () {
			helpers.wrap(1, 4, 3);
		}).toThrow(RangeError);
		expect(function () {
			helpers.wrap(1, NaN, 3);
		}).toThrow(new RangeError('wrap: `minimum` must be a finite number, got NaN'));
		expect(function () {
			helpers.wrap(1, 0, Infinity);
		}).toThrow(new RangeError('wrap: `maximum` must be a finite number, got Infinity'));
		expect(function () {
			helpers.wrap(1, '0' as never, 3);
		}).toThrow(new TypeError('wrap: `minimum` must be a finite number, got string'));
	});
});

describe('allocate', function () {
	it('splits an amount by the largest remainder method', function () {
		expect(helpers.allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
		expect(helpers.allocate(1000, [70, 20, 10])).toEqual([700, 200, 100]);
		expect(helpers.allocate(5, [0.5, 0.25, 0.25])).toEqual([3, 1, 1]);
		expect(helpers.allocate(10, [1, 0, 2])).toEqual([3, 0, 7]);
		expect(helpers.allocate(7, [1])).toEqual([7]);
		expect(helpers.allocate(0, [1, 2])).toEqual([0, 0]);
		// Quotas 1.2, 1.2, 1.6: the unit left goes to the largest remainder, not to the first share.
		expect(helpers.allocate(4, [3, 3, 4])).toEqual([1, 1, 2]);
		expect(helpers.allocate(6, [2, 2, 1])).toEqual([3, 2, 1]);
	});

	it('breaks ties in favour of the earlier index', function () {
		expect(helpers.allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
		expect(helpers.allocate(1, [1, 2, 1])).toEqual([0, 1, 0]);
		expect(helpers.allocate(1, [2, 1, 1, 2])).toEqual([1, 0, 0, 0]);
	});

	it('reads the ratios as the exact fractions their doubles hold', function () {
		expect(helpers.allocate(100, [0.1, 0.1, 0.1])).toEqual(helpers.allocate(100, [1, 1, 1]));
		// With the doubles 0.1, 0.2 and 0.3 (whose sum is not that of 1, 2 and 3 tenths), the first quota is just above 1/2 and the last one
		// just below 3/2: the unit left goes to the first share by its remainder, not by the tie rule.
		expect(helpers.allocate(3, [0.1, 0.2, 0.3])).toEqual([1, 1, 1]);
		expect(helpers.allocate(3, [1, 2, 3])).toEqual([1, 1, 1]);
		expect(helpers.allocate(10, [Number.MIN_VALUE, Number.MAX_VALUE])).toEqual([0, 10]);
		expect(helpers.allocate(2, [Number.MIN_VALUE, Number.MIN_VALUE])).toEqual([1, 1]);
	});

	it('splits a negative amount like its absolute value, negated', function () {
		expect(helpers.allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
		expect(helpers.allocate(-10, [1, 0, 2])).toEqual([-3, 0, -7]);
		expect(Object.is(helpers.allocate(-10, [1, 0, 2])[1], 0)).toBe(true);
	});

	it('handles bigint totals and ratios', function () {
		expect(helpers.allocate(10n ** 20n, [1, 2])).toEqual([33333333333333333333n, 66666666666666666667n]);
		expect(helpers.allocate(-5n, [1n, 1n])).toEqual([-3n, -2n]);
		expect(helpers.allocate(100, [1n, 1n, 1n])).toEqual([34, 33, 33]);
		expect(helpers.allocate(100, [1n, 0.5, 2 ** 70])).toEqual([0, 0, 100]);
		expect(helpers.allocate(Number.MAX_SAFE_INTEGER, [1, 1])).toEqual([4503599627370496, 4503599627370495]);
	});

	it('rejects a total that is not a safe integer or a bigint', function () {
		for (const total of [1.5, NaN, Infinity, 2 ** 53]) {
			expect(function () {
				helpers.allocate(total, [1]);
			}).toThrow(new RangeError(`allocate: \`total\` must be a safe integer or a bigint, got ${total}`));
		}
		expect(function () {
			helpers.allocate('5' as never, [1]);
		}).toThrow(new TypeError('allocate: `total` must be a safe integer or a bigint, got string'));
	});

	it('rejects ratios that are not an array of finite non-negative numbers or bigints, or all zero', function () {
		expect(function () {
			helpers.allocate(5, 'ab' as never);
		}).toThrow(new TypeError('allocate: `ratios` must be an array, got string'));
		expect(function () {
			helpers.allocate(5, [1, '1'] as never);
		}).toThrow(new TypeError('allocate: `ratios[1]` must be a finite number >= 0 or a bigint >= 0, got string'));
		expect(function () {
			helpers.allocate(5, [{ valueOf: Number }] as never);
		}).toThrow(new TypeError('allocate: `ratios[0]` must be a finite number >= 0 or a bigint >= 0, got object'));
		for (const ratio of [-1, NaN, Infinity, -Infinity]) {
			expect(function () {
				helpers.allocate(5, [1, ratio]);
			}).toThrow(new RangeError(`allocate: \`ratios[1]\` must be a finite number >= 0 or a bigint >= 0, got ${ratio}`));
		}
		expect(function () {
			helpers.allocate(5, [1, -1n]);
		}).toThrow(new RangeError('allocate: `ratios[1]` must be a finite number >= 0 or a bigint >= 0, got -1'));
		for (const ratios of [[], [0], [0, 0n, -0]]) {
			expect(function () {
				helpers.allocate(5, ratios);
			}).toThrow(new RangeError('allocate: `ratios` must contain a ratio > 0'));
		}
	});

	it('reads each ratio once', function () {
		let reads = 0;
		const ratios = new Proxy([1, 1], {
			get(target, key, receiver) {
				if (key === '0') reads++;
				return Reflect.get(target, key, receiver);
			}
		});
		expect(helpers.allocate(3, ratios)).toEqual([2, 1]);
		expect(reads).toBe(1);
	});
});

describe('covariance', function () {
	it('computes the population covariance, or the sample one', function () {
		expect(helpers.covariance([1, 2, 3, 4], [2, 4, 6, 8])).toBe(2.5);
		expect(helpers.covariance([1, 2, 3, 4], [2, 4, 6, 8], { sample: true })).toBe(10 / 3);
		expect(helpers.covariance([1, 2, 3], [3, 2, 1])).toBe(-2 / 3);
		expect(helpers.covariance([5], [7])).toBe(0);
		expect(helpers.covariance([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0);
		expect(helpers.covariance(['1', '2'] as never, [2, 4])).toBe(0.5);
	});

	it('is NaN for no pairs, a sample of one pair, or values that are not finite', function () {
		expect(helpers.covariance([], [])).toBeNaN();
		expect(helpers.covariance([1], [2], { sample: true })).toBeNaN();
		expect(helpers.covariance([1, NaN], [1, 2])).toBeNaN();
		expect(helpers.covariance([1, Infinity], [1, 2])).toBeNaN();
		expect(helpers.covariance([1, 2], [-Infinity, 2])).toBeNaN();
	});

	it('stays accurate far from zero (two passes, no cancellation)', function () {
		const offset = 1e9;
		expect(helpers.covariance([offset + 1, offset + 2, offset + 3], [offset + 2, offset + 4, offset + 6])).toBe(4 / 3);
		expect(helpers.covariance([1e15 + 1, 1e15 + 3], [1, 3])).toBe(1);
	});

	it('does not overflow before the result does', function () {
		const xs = [1e154, -1e154, 0];
		expect(helpers.covariance(xs, xs)).toBeCloseTo(helpers.variance(xs), -300);
		expect(Number.isFinite(helpers.covariance(xs, xs))).toBe(true);
		expect(helpers.covariance([1e200, -1e200], [1e200, -1e200])).toBe(Infinity);
		expect(helpers.covariance([1e200, -1e200], [-1e200, 1e200])).toBe(-Infinity);
		expect(helpers.covariance([1e200, -1e200], [1, -1])).toBe(1e200);
		expect(helpers.covariance([Number.MAX_VALUE, -Number.MAX_VALUE], [1, -1])).toBe(Number.MAX_VALUE);
		expect(helpers.covariance([1e-200, -1e-200], [1e200, -1e200])).toBe(1);
		expect(helpers.covariance([1e200, -1e200], [1e-200, -1e-200])).toBe(1);
		expect(helpers.covariance([1e-170, -1e-170], [1e-170, -1e-170])).toBe(0);
		expect(helpers.covariance([2 ** -1000, -(2 ** -1000)], [2 ** -60, -(2 ** -60)])).toBe(2 ** -1060);
		expect(helpers.covariance([1e300, -1e300, 1e300, -1e300], [1, 1, -1, -1])).toBe(0);
	});

	it('equals variance for a sample paired with itself', function () {
		const xs = [2, 4, 4, 4, 5, 5, 7, 9];
		expect(helpers.covariance(xs, xs)).toBe(helpers.variance(xs));
		expect(helpers.covariance(xs, xs, { sample: true })).toBe(helpers.variance(xs, { sample: true }));
	});

	it('rejects samples of different lengths', function () {
		expect(function () {
			helpers.covariance([1, 2], [1]);
		}).toThrow(new RangeError('covariance: `xs` and `ys` must have the same length, got 2 and 1'));
	});

	it('ignores a sample option inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.sample = true;
		try {
			expect(helpers.covariance([1, 2, 3, 4], [2, 4, 6, 8])).toBe(2.5);
			expect(helpers.covariance([1, 2, 3, 4], [2, 4, 6, 8], {})).toBe(2.5);
		} finally {
			delete proto.sample;
		}
	});
});

describe('correlation', function () {
	it('computes the Pearson correlation coefficient', function () {
		expect(helpers.correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBe(1);
		expect(helpers.correlation([1, 2, 3], [3, 2, 1])).toBe(-1);
		expect(helpers.correlation([1, 2, 3, 4], [1, 3, 2, 4])).toBe(0.8);
		expect(helpers.correlation([1, 2, 3, 4], [1, -1, -1, 1])).toBe(0);
		expect(helpers.correlation([0.1, 0.2, 0.3], [10, 20, 30])).toBeCloseTo(1, 15);
	});

	it('is NaN when undefined: fewer than 2 pairs, a constant sample, values that are not finite', function () {
		expect(helpers.correlation([], [])).toBeNaN();
		expect(helpers.correlation([1], [1])).toBeNaN();
		expect(helpers.correlation([1, 2, 3], [5, 5, 5])).toBeNaN();
		expect(helpers.correlation([5, 5], [1, 2])).toBeNaN();
		expect(helpers.correlation([1, NaN], [1, 2])).toBeNaN();
	});

	it('neither overflows nor underflows', function () {
		expect(helpers.correlation([1e200, -1e200, 0], [1, -1, 0])).toBe(1);
		expect(helpers.correlation([Number.MAX_VALUE, -Number.MAX_VALUE], [-1, 1])).toBe(-1);
		expect(helpers.correlation([1e-160, 2e-160, 3e-160], [3, 2, 1])).toBe(-1);
		expect(helpers.correlation([1e-300, 0, 0], [5e-324, 0, 0])).toBe(1);
		expect(helpers.correlation([3e-170, 1e-170, 2e-170], [3e170, 1e170, 2e170])).toBeCloseTo(1, 15);
	});

	it('rejects samples of different lengths', function () {
		expect(function () {
			helpers.correlation([1], [1, 2]);
		}).toThrow(new RangeError('correlation: `xs` and `ys` must have the same length, got 1 and 2'));
	});
});

describe('linearRegression', function () {
	it('fits the least-squares line', function () {
		const line = helpers.linearRegression([1, 2, 3, 4], [3, 5, 7, 9]);
		expect([line.slope, line.intercept, line.r2]).toEqual([2, 1, 1]);
		expect(line.predict(10)).toBe(21);
		expect(line.predict(0)).toBe(1);
		const noisy = helpers.linearRegression([1, 2, 3], [2, 1, 3]);
		expect(noisy.slope).toBe(0.5);
		expect(noisy.intercept).toBe(1);
		expect(noisy.r2).toBe(0.25);
		expect(helpers.linearRegression([0, 1], [5, 5])).toMatchObject({ slope: 0, intercept: 5, r2: 1 });
	});

	it('stays accurate for data far from zero, such as timestamps', function () {
		const start = Date.UTC(2024, 0, 1);
		const line = helpers.linearRegression([start, start + 1000, start + 2000], [10, 12, 14]);
		expect(line.slope).toBe(0.002);
		expect(line.predict(start + 3000)).toBe(16);
		expect(line.r2).toBe(1);
	});

	it('gives NaN fields for values that are not finite', function () {
		const line = helpers.linearRegression([1, 2, NaN], [1, 2, 3]);
		expect([line.slope, line.intercept, line.r2]).toEqual([NaN, NaN, NaN]);
		const flat = helpers.linearRegression([1, 2, NaN], [3, 3, 3]);
		expect(flat.r2).toBeNaN();
	});

	it('handles values whose squares overflow or underflow', function () {
		expect(helpers.linearRegression([1e-170, 2e-170, 4e-170], [1, 2, 4]).slope).toBe(1e170);
		expect(helpers.linearRegression([1, 2, 4], [1e-170, 2e-170, 4e-170]).slope).toBe(1e-170);
		const line = helpers.linearRegression([1e200, -1e200, 0], [2e200, -2e200, 0]);
		expect(line.slope).toBe(2);
		expect(line.intercept).toBe(0);
		expect(line.r2).toBe(1);
	});

	it('rejects fewer than 2 points, equal xs and samples of different lengths', function () {
		expect(function () {
			helpers.linearRegression([1], [1]);
		}).toThrow(new RangeError('linearRegression: `xs` and `ys` must hold at least 2 points, got 1'));
		expect(function () {
			helpers.linearRegression([], []);
		}).toThrow(new RangeError('linearRegression: `xs` and `ys` must hold at least 2 points, got 0'));
		expect(function () {
			helpers.linearRegression([3, 3], [1, 2]);
		}).toThrow(new RangeError('linearRegression: `xs` must not all be equal (the line would be vertical)'));
		expect(function () {
			helpers.linearRegression([1, 2], [1]);
		}).toThrow(new RangeError('linearRegression: `xs` and `ys` must have the same length, got 2 and 1'));
	});
});

describe('interquartileRange', function () {
	it('is the difference between the third and first quartiles', function () {
		expect(helpers.interquartileRange([1, 2, 3, 4, 5, 6, 7, 8])).toBe(3.5);
		expect(helpers.interquartileRange([8, 1, 7, 2, 6, 3, 5, 4])).toBe(3.5);
		expect(helpers.interquartileRange([7, 7, 7])).toBe(0);
		expect(helpers.interquartileRange([5])).toBe(0);
	});

	it('is NaN for no numbers or a NaN', function () {
		expect(helpers.interquartileRange([])).toBeNaN();
		expect(helpers.interquartileRange([1, NaN])).toBeNaN();
	});
});

describe('zScore', function () {
	it('measures the distance from the mean in standard deviations', function () {
		expect(helpers.zScore(130, 100, 15)).toBe(2);
		expect(helpers.zScore(85, 100, 15)).toBe(-1);
		expect(helpers.zScore(100, 100, 15)).toBe(0);
	});

	it('rejects a standard deviation that is not positive', function () {
		expect(function () {
			helpers.zScore(1, 0, 0);
		}).toThrow(new RangeError('zScore: `deviation` must be a number > 0, got 0'));
		expect(function () {
			helpers.zScore(1, 0, NaN);
		}).toThrow(new RangeError('zScore: `deviation` must be a number > 0, got NaN'));
		expect(function () {
			helpers.zScore(1, 0, '1' as never);
		}).toThrow(new TypeError('zScore: `deviation` must be a number > 0, got string'));
	});
});

describe('primeFactors', function () {
	it('factors small numbers by trial division', function () {
		expect(helpers.primeFactors(1)).toEqual([]);
		expect(helpers.primeFactors(2)).toEqual([2]);
		expect(helpers.primeFactors(360)).toEqual([2, 2, 2, 3, 3, 5]);
		expect(helpers.primeFactors(97)).toEqual([97]);
		expect(helpers.primeFactors(1021 * 1019)).toEqual([1019, 1021]);
		expect(helpers.primeFactors(1021 * 1021 * 7)).toEqual([7, 1021, 1021]);
		expect(helpers.primeFactors(2 ** 52)).toEqual(new Array(52).fill(2));
		expect(helpers.primeFactors(3 ** 33)).toEqual(new Array(33).fill(3));
	});

	it('keeps a large prime cofactor left after trial division', function () {
		expect(helpers.primeFactors(1031)).toEqual([1031]);
		expect(helpers.primeFactors(8 * 1_000_003)).toEqual([2, 2, 2, 1_000_003]);
		expect(helpers.primeFactors(9007199254740881)).toEqual([9007199254740881]);
	});

	it('splits products of large primes with Pollard rho', function () {
		expect(helpers.primeFactors(1031 * 1033)).toEqual([1031, 1033]);
		expect(helpers.primeFactors(9007199254740991)).toEqual([6361, 69431, 20394401]);
		expect(helpers.primeFactors(94906249 * 94906247)).toEqual([94906247, 94906249]);
		expect(helpers.primeFactors(1031 ** 5)).toEqual([1031, 1031, 1031, 1031, 1031]);
		expect(helpers.primeFactors(208057 ** 3)).toEqual([208057, 208057, 208057]);
		expect(helpers.primeFactors(94906249 ** 2)).toEqual([94906249, 94906249]);
	});

	it('replays a batch that overshoots, and retries another polynomial when the replay finds the number itself', function () {
		// Found by search: 1071209 makes the batched gcd reach n, 1260913 makes the replay reach n with c = 1 too.
		expect(helpers.primeFactors(1071209)).toEqual([1031, 1039]);
		expect(helpers.primeFactors(1260913)).toEqual([1031, 1223]);
	});

	it('factors adversarial semiprimes near 2 ** 53 quickly', function () {
		const start = performance.now();
		expect(helpers.primeFactors(94906249 * 94906219)).toEqual([94906219, 94906249]);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it('rejects numbers that are not safe integers >= 1', function () {
		expect(function () {
			helpers.primeFactors(0);
		}).toThrow(new RangeError('primeFactors: `n` must be a safe integer >= 1, got 0'));
		expect(function () {
			helpers.primeFactors(-6);
		}).toThrow(new RangeError('primeFactors: `n` must be a safe integer >= 1, got -6'));
		expect(function () {
			helpers.primeFactors(1.5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.primeFactors(2 ** 53);
		}).toThrow(RangeError);
		expect(function () {
			helpers.primeFactors(NaN);
		}).toThrow(RangeError);
		expect(function () {
			helpers.primeFactors('12' as never);
		}).toThrow(new TypeError('primeFactors: `n` must be a safe integer >= 1, got string'));
	});
});

describe('divisors', function () {
	it('lists every divisor in ascending order', function () {
		expect(helpers.divisors(1)).toEqual([1]);
		expect(helpers.divisors(12)).toEqual([1, 2, 3, 4, 6, 12]);
		expect(helpers.divisors(13)).toEqual([1, 13]);
		expect(helpers.divisors(36)).toEqual([1, 2, 3, 4, 6, 9, 12, 18, 36]);
		expect(helpers.divisors(2 ** 10)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
		expect(helpers.divisors(9007199254740991)).toEqual([1, 6361, 69431, 20394401, 441650591, 129728784761, 1416003655831, 9007199254740991]);
	});

	it('handles highly composite numbers', function () {
		expect(helpers.divisors(720720)).toHaveLength(240);
		// 2^4 · 3^2 · 5 · 7 · 11 · 13 · 17 · 19 · 23 · 29 · 31 · 37 · 41 has 15 · 2 ** 11 divisors.
		const n = 16 * 9 * 5 * 7 * 11 * 13 * 17 * 19 * 23 * 29 * 31 * 37 * 41;
		const result = helpers.divisors(n);
		expect(result).toHaveLength(30720);
		expect(result[result.length - 1]).toBe(n);
	});

	it('rejects numbers that are not safe integers >= 1', function () {
		expect(function () {
			helpers.divisors(-12);
		}).toThrow(new RangeError('divisors: `n` must be a safe integer >= 1, got -12'));
		expect(function () {
			helpers.divisors(null as never);
		}).toThrow(new TypeError('divisors: `n` must be a safe integer >= 1, got null'));
	});
});

describe('primesUpTo', function () {
	it('lists the primes up to the limit, inclusive', function () {
		expect(helpers.primesUpTo(30)).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29]);
		expect(helpers.primesUpTo(29)).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29]);
		expect(helpers.primesUpTo(2)).toEqual([2]);
		expect(helpers.primesUpTo(3)).toEqual([2, 3]);
		expect(helpers.primesUpTo(4)).toEqual([2, 3]);
		expect(helpers.primesUpTo(9)).toEqual([2, 3, 5, 7]);
		expect(helpers.primesUpTo(25)).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23]);
	});

	it('counts the primes below a non-integer limit', function () {
		expect(helpers.primesUpTo(10.9)).toEqual([2, 3, 5, 7]);
		expect(helpers.primesUpTo(2.5)).toEqual([2]);
	});

	it('is empty below 2', function () {
		expect(helpers.primesUpTo(1)).toEqual([]);
		expect(helpers.primesUpTo(1.99)).toEqual([]);
		expect(helpers.primesUpTo(0)).toEqual([]);
		expect(helpers.primesUpTo(-10)).toEqual([]);
		expect(helpers.primesUpTo(-Infinity)).toEqual([]);
	});

	it('matches the prime-counting function', function () {
		expect(helpers.primesUpTo(1000)).toHaveLength(168);
		const primes = helpers.primesUpTo(1_000_000);
		expect(primes).toHaveLength(78498);
		expect(primes[primes.length - 1]).toBe(999983);
	});

	it('rejects limits above 10 ** 8 and NaN', function () {
		expect(function () {
			helpers.primesUpTo(1e9);
		}).toThrow(new RangeError('primesUpTo: `limit` must be a number <= 100000000, got 1000000000'));
		expect(function () {
			helpers.primesUpTo(Infinity);
		}).toThrow(RangeError);
		expect(function () {
			helpers.primesUpTo(NaN);
		}).toThrow(RangeError);
		expect(function () {
			helpers.primesUpTo('10' as never);
		}).toThrow(new TypeError('primesUpTo: `limit` must be a number <= 100000000, got string'));
	});
});

describe('nextPrime', function () {
	it('finds the smallest prime greater than n', function () {
		expect(helpers.nextPrime(2)).toBe(3);
		expect(helpers.nextPrime(3)).toBe(5);
		expect(helpers.nextPrime(7)).toBe(11);
		expect(helpers.nextPrime(8)).toBe(11);
		expect(helpers.nextPrime(10.5)).toBe(11);
		expect(helpers.nextPrime(113)).toBe(127);
		expect(helpers.nextPrime(2_147_483_629)).toBe(2_147_483_647);
		expect(helpers.nextPrime(9007199254740880)).toBe(9007199254740881);
	});

	it('gives 2 below 2', function () {
		expect(helpers.nextPrime(1.999)).toBe(2);
		expect(helpers.nextPrime(0)).toBe(2);
		expect(helpers.nextPrime(-5)).toBe(2);
		expect(helpers.nextPrime(-Infinity)).toBe(2);
	});

	it('rejects n from the largest safe prime on, and NaN', function () {
		expect(function () {
			helpers.nextPrime(9007199254740881);
		}).toThrow(new RangeError('nextPrime: `n` must be a number < 9007199254740881, got 9007199254740881'));
		expect(function () {
			helpers.nextPrime(Infinity);
		}).toThrow(RangeError);
		expect(function () {
			helpers.nextPrime(NaN);
		}).toThrow(RangeError);
		expect(function () {
			helpers.nextPrime(5n as never);
		}).toThrow(new TypeError('nextPrime: `n` must be a number < 9007199254740881, got bigint'));
	});
});

describe('previousPrime', function () {
	it('finds the largest prime less than n', function () {
		expect(helpers.previousPrime(2.5)).toBe(2);
		expect(helpers.previousPrime(3)).toBe(2);
		expect(helpers.previousPrime(3.5)).toBe(3);
		expect(helpers.previousPrime(4)).toBe(3);
		expect(helpers.previousPrime(11)).toBe(7);
		expect(helpers.previousPrime(12)).toBe(11);
		expect(helpers.previousPrime(127)).toBe(113);
		expect(helpers.previousPrime(2 ** 53)).toBe(9007199254740881);
	});

	it('rejects n outside (2, 2 ** 53]', function () {
		expect(function () {
			helpers.previousPrime(2);
		}).toThrow(new RangeError('previousPrime: `n` must be a number > 2 and <= 2 ** 53, got 2'));
		expect(function () {
			helpers.previousPrime(2 ** 53 + 2);
		}).toThrow(RangeError);
		expect(function () {
			helpers.previousPrime(NaN);
		}).toThrow(RangeError);
		expect(function () {
			helpers.previousPrime('9' as never);
		}).toThrow(new TypeError('previousPrime: `n` must be a number > 2 and <= 2 ** 53, got string'));
	});
});

describe('binomial', function () {
	it('counts the ways to choose k items out of n', function () {
		expect(helpers.binomial(0, 0)).toBe(1);
		expect(helpers.binomial(5, 0)).toBe(1);
		expect(helpers.binomial(5, 5)).toBe(1);
		expect(helpers.binomial(5, 2)).toBe(10);
		expect(helpers.binomial(5, 3)).toBe(10);
		expect(helpers.binomial(52, 5)).toBe(2598960);
		expect(helpers.binomial(9007199254740991, 1)).toBe(9007199254740991);
		expect(helpers.binomial(9007199254740991, 9007199254740990)).toBe(9007199254740991);
	});

	it('is 0 when k is negative or greater than n', function () {
		expect(helpers.binomial(10, 11)).toBe(0);
		expect(helpers.binomial(10, -1)).toBe(0);
		expect(helpers.binomial(0, 1)).toBe(0);
	});

	it('is exact up to 2 ** 53, where the factorial formula is not', function () {
		// The largest central binomial coefficient below 2 ** 53.
		expect(helpers.binomial(56, 28)).toBe(7648690600760440);
		expect(helpers.binomial(30, 15)).toBe(155117520);
		expect(helpers.factorial(30) / (helpers.factorial(15) * helpers.factorial(15))).not.toBe(155117520);
	});

	it('rounds larger results correctly', function () {
		expect(helpers.binomial(60, 30)).toBe(Number(118264581564861424n));
		expect(helpers.binomial(100, 50)).toBe(Number(100891344545564193334812497256n));
		expect(helpers.binomial(1000, 500)).toBe(Number(binomialBig(1000n, 500n)));
		expect(helpers.binomial(1029, 514)).toBe(Number(binomialBig(1029n, 514n)));
	});

	it('overflows to Infinity quickly, whatever k', function () {
		expect(helpers.binomial(2000, 1000)).toBe(Infinity);
		expect(helpers.binomial(1030, 515)).toBe(Infinity);
		const start = performance.now();
		expect(helpers.binomial(9007199254740991, 4503599627370495)).toBe(Infinity);
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it('rejects an n that is not a safe integer >= 0 or a k that is not an integer', function () {
		expect(function () {
			helpers.binomial(-1, 0);
		}).toThrow(new RangeError('binomial: `n` must be a safe integer >= 0, got -1'));
		expect(function () {
			helpers.binomial(2 ** 53, 1);
		}).toThrow(RangeError);
		expect(function () {
			helpers.binomial(5, 1.5);
		}).toThrow(new RangeError('binomial: `k` must be an integer, got 1.5'));
		expect(function () {
			helpers.binomial(5, '2' as never);
		}).toThrow(new TypeError('binomial: `k` must be an integer, got string'));
	});
});

describe('extendedGcd', function () {
	it('gives the gcd and Bézout coefficients', function () {
		expect(helpers.extendedGcd(240, 46)).toEqual({ gcd: 2, x: -9, y: 47 });
		expect(helpers.extendedGcd(46, 240)).toEqual({ gcd: 2, x: 47, y: -9 });
		expect(helpers.extendedGcd(-4, 6)).toEqual({ gcd: 2, x: 1, y: 1 });
		expect(helpers.extendedGcd(4, -6)).toEqual({ gcd: 2, x: -1, y: -1 });
		expect(helpers.extendedGcd(7, 7)).toEqual({ gcd: 7, x: 0, y: 1 });
	});

	it('handles zeros without negative zeros', function () {
		expect(helpers.extendedGcd(0, 0)).toEqual({ gcd: 0, x: 0, y: 0 });
		expect(helpers.extendedGcd(0, 5)).toEqual({ gcd: 5, x: 0, y: 1 });
		expect(helpers.extendedGcd(0, -5)).toEqual({ gcd: 5, x: 0, y: -1 });
		expect(helpers.extendedGcd(-5, 0)).toEqual({ gcd: 5, x: -1, y: 0 });
		const { x, y } = helpers.extendedGcd(-5, 0);
		expect(Object.is(x, -1) && Object.is(y, 0)).toBe(true);
		expect(Object.is(helpers.extendedGcd(-0, -5).x, 0)).toBe(true);
	});

	it('is exact for safe integers', function () {
		const { gcd, x, y } = helpers.extendedGcd(9007199254740991, 9007199254740990);
		expect(gcd).toBe(1);
		expect(BigInt(9007199254740991) * BigInt(x) + BigInt(9007199254740990) * BigInt(y)).toBe(1n);
		// Consecutive Fibonacci numbers (F78 and F77) take the most steps, with the largest quotients times coefficients.
		const fibonacci = helpers.extendedGcd(8944394323791464, 5527939700884757);
		expect(fibonacci.gcd).toBe(1);
		expect(8944394323791464n * BigInt(fibonacci.x) + 5527939700884757n * BigInt(fibonacci.y)).toBe(1n);
	});

	it('rejects arguments that are not safe integers', function () {
		expect(function () {
			helpers.extendedGcd(1.5, 2);
		}).toThrow(new RangeError('extendedGcd: `a` must be a safe integer, got 1.5'));
		expect(function () {
			helpers.extendedGcd(1, 2 ** 53);
		}).toThrow(RangeError);
		expect(function () {
			helpers.extendedGcd(1, '2' as never);
		}).toThrow(new TypeError('extendedGcd: `b` must be a safe integer, got string'));
	});
});

describe('modInverse', function () {
	it('inverts numbers coprime to the modulus', function () {
		expect(helpers.modInverse(3, 11)).toBe(4);
		expect(helpers.modInverse(-3, 11)).toBe(7);
		expect(helpers.modInverse(10, 17)).toBe(12);
		expect(helpers.modInverse(14, 11)).toBe(4);
		expect(helpers.modInverse(1, 2)).toBe(1);
		expect(helpers.modInverse(9007199254740990, 9007199254740991)).toBe(9007199254740990);
	});

	it('is 0 modulo 1', function () {
		expect(helpers.modInverse(0, 1)).toBe(0);
		expect(helpers.modInverse(5, 1)).toBe(0);
		expect(Object.is(helpers.modInverse(-5, 1), 0)).toBe(true);
	});

	it('throws when there is no inverse', function () {
		expect(function () {
			helpers.modInverse(4, 8);
		}).toThrow(new RangeError('modInverse: `a` must be coprime to `modulus`, got 4 and 8'));
		expect(function () {
			helpers.modInverse(0, 7);
		}).toThrow(new RangeError('modInverse: `a` must be coprime to `modulus`, got 0 and 7'));
	});

	it('rejects invalid arguments', function () {
		expect(function () {
			helpers.modInverse(3, 0);
		}).toThrow(new RangeError('modInverse: `modulus` must be a safe integer >= 1, got 0'));
		expect(function () {
			helpers.modInverse(0.5, 7);
		}).toThrow(new RangeError('modInverse: `a` must be a safe integer, got 0.5'));
		expect(function () {
			helpers.modInverse(3, '7' as never);
		}).toThrow(new TypeError('modInverse: `modulus` must be a safe integer >= 1, got string'));
	});
});

describe('modPow', function () {
	it('raises to a power modulo a small modulus', function () {
		expect(helpers.modPow(4, 13, 497)).toBe(445);
		expect(helpers.modPow(2, 10, 1000)).toBe(24);
		expect(helpers.modPow(-2, 3, 5)).toBe(2);
		expect(helpers.modPow(7, 0, 13)).toBe(1);
		expect(helpers.modPow(0, 0, 13)).toBe(1);
		expect(helpers.modPow(0, 5, 13)).toBe(0);
		expect(helpers.modPow(3, 2 ** 53 - 1, 7)).toBe(Number(bigModPow(3n, 2n ** 53n - 1n, 7n)));
		expect(helpers.modPow(94906264, 2, 94906265)).toBe(1);
	});

	it('uses BigInt arithmetic for large moduli', function () {
		expect(helpers.modPow(2, 1e15, 1e15 + 37)).toBe(Number(bigModPow(2n, 10n ** 15n, 10n ** 15n + 37n)));
		expect(helpers.modPow(94906265, 2, 94906266)).toBe(1);
		expect(helpers.modPow(-1, 9007199254740991, 9007199254740991)).toBe(9007199254740990);
		// Fermat: a ** (p - 1) ≡ 1 (mod p).
		expect(helpers.modPow(123456789, 9007199254740880, 9007199254740881)).toBe(1);
		expect(helpers.modPow(5, 0, 9007199254740881)).toBe(1);
	});

	it('is 0 modulo 1', function () {
		expect(helpers.modPow(5, 3, 1)).toBe(0);
		expect(helpers.modPow(0, 0, 1)).toBe(0);
		expect(helpers.modPow(5, -3, 1)).toBe(0);
	});

	it('raises the inverse to a negative exponent', function () {
		expect(helpers.modPow(3, -1, 11)).toBe(4);
		expect(helpers.modPow(3, -2, 11)).toBe(5);
		expect(helpers.modPow(2, -3, 9007199254740881)).toBe(Number(bigModPow(BigInt(helpers.modInverse(2, 9007199254740881)), 3n, 9007199254740881n)));
		expect(function () {
			helpers.modPow(2, -1, 4);
		}).toThrow(new RangeError('modPow: `base` must be coprime to `modulus` for a negative `exponent`, got 2 and 4'));
	});

	it('rejects invalid arguments', function () {
		expect(function () {
			helpers.modPow(2, 3, 0);
		}).toThrow(new RangeError('modPow: `modulus` must be a safe integer >= 1, got 0'));
		expect(function () {
			helpers.modPow(2, 0.5, 5);
		}).toThrow(new RangeError('modPow: `exponent` must be a safe integer, got 0.5'));
		expect(function () {
			helpers.modPow(2 ** 53, 1, 5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.modPow('2' as never, 1, 5);
		}).toThrow(new TypeError('modPow: `base` must be a safe integer, got string'));
	});
});

describe('integerSqrt', function () {
	it('is the floor of the square root of a number', function () {
		expect(helpers.integerSqrt(0)).toBe(0);
		expect(helpers.integerSqrt(1)).toBe(1);
		expect(helpers.integerSqrt(3)).toBe(1);
		expect(helpers.integerSqrt(4)).toBe(2);
		expect(helpers.integerSqrt(17)).toBe(4);
		expect(helpers.integerSqrt(9007199254740991)).toBe(94906265);
	});

	it('is exact where Math.sqrt rounds up', function () {
		expect(Math.floor(Math.sqrt(94906265 ** 2 - 1))).toBe(94906265);
		expect(helpers.integerSqrt(94906265 ** 2 - 1)).toBe(94906264);
		expect(helpers.integerSqrt(94906265 ** 2)).toBe(94906265);
	});

	it('handles bigints of any size', function () {
		expect(helpers.integerSqrt(0n)).toBe(0n);
		expect(helpers.integerSqrt(1n)).toBe(1n);
		expect(helpers.integerSqrt(2n)).toBe(1n);
		expect(helpers.integerSqrt(3n)).toBe(1n);
		expect(helpers.integerSqrt(4n)).toBe(2n);
		expect(helpers.integerSqrt(10n ** 40n)).toBe(10n ** 20n);
		expect(helpers.integerSqrt(10n ** 40n - 1n)).toBe(10n ** 20n - 1n);
		expect(helpers.integerSqrt(2n ** 64n + 1n)).toBe(2n ** 32n);
		const big = 3n ** 1001n;
		const root = helpers.integerSqrt(big);
		expect(root * root <= big && (root + 1n) * (root + 1n) > big).toBe(true);
	});

	it('rejects negative numbers, non-integers and other types', function () {
		expect(function () {
			helpers.integerSqrt(-1);
		}).toThrow(new RangeError('integerSqrt: `n` must be a safe integer >= 0 or a bigint >= 0, got -1'));
		expect(function () {
			helpers.integerSqrt(-1n);
		}).toThrow(new RangeError('integerSqrt: `n` must be a safe integer >= 0 or a bigint >= 0, got -1'));
		expect(function () {
			helpers.integerSqrt(2.5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.integerSqrt(2 ** 53);
		}).toThrow(RangeError);
		expect(function () {
			helpers.integerSqrt('4' as never);
		}).toThrow(new TypeError('integerSqrt: `n` must be a safe integer >= 0 or a bigint >= 0, got string'));
	});
});

describe('isPerfectSquare', function () {
	it('recognizes squares of integers', function () {
		expect([0, 1, 4, 9, 16, 49, 10000].map(helpers.isPerfectSquare)).toEqual([true, true, true, true, true, true, true]);
		expect([2, 3, 5, 50, 99].map(helpers.isPerfectSquare)).toEqual([false, false, false, false, false]);
		expect(helpers.isPerfectSquare(-0)).toBe(true);
	});

	it('is exact near 2 ** 53, where Math.sqrt rounds', function () {
		expect(helpers.isPerfectSquare(94906265 ** 2)).toBe(true);
		expect(helpers.isPerfectSquare(94906265 ** 2 + 1)).toBe(false);
		expect(helpers.isPerfectSquare(94906265 ** 2 - 1)).toBe(false);
	});

	it('handles doubles beyond 2 ** 53', function () {
		expect(helpers.isPerfectSquare(2 ** 100)).toBe(true);
		expect(helpers.isPerfectSquare(2 ** 101)).toBe(false);
		expect(helpers.isPerfectSquare((3 * 2 ** 30) ** 2)).toBe(true);
		// Math.sqrt gives the integer 134217729, whose square (18014398777917441) is not a double.
		expect(Math.sqrt(18014398777917440)).toBe(134217729);
		expect(helpers.isPerfectSquare(18014398777917440)).toBe(false);
		expect(helpers.isPerfectSquare(Number.MAX_VALUE)).toBe(false);
	});

	it('is false for non-integers, negative numbers and non-finite values', function () {
		expect([2.25, -4, NaN, Infinity, -Infinity].map(helpers.isPerfectSquare)).toEqual([false, false, false, false, false]);
	});
});

describe('isPowerOfTwo', function () {
	it('recognizes integer powers of two', function () {
		expect([1, 2, 4, 1024, 2 ** 31, 2 ** 32, 2 ** 53, 2 ** 1023].map(helpers.isPowerOfTwo)).toEqual(new Array(8).fill(true));
	});

	it('rejects everything else', function () {
		expect([0, -2, 3, 6, 1000, 2 ** 32 + 2, 2 ** 53 + 2, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_VALUE].map(helpers.isPowerOfTwo)).toEqual(
			new Array(13).fill(false)
		);
	});
});

describe('nextPowerOfTwo', function () {
	it('rounds up to a power of two', function () {
		expect(helpers.nextPowerOfTwo(1000)).toBe(1024);
		expect(helpers.nextPowerOfTwo(1024)).toBe(1024);
		expect(helpers.nextPowerOfTwo(1025)).toBe(2048);
		expect(helpers.nextPowerOfTwo(5.5)).toBe(8);
		expect(helpers.nextPowerOfTwo(1.0000001)).toBe(2);
		expect(helpers.nextPowerOfTwo(2 ** 31 + 1)).toBe(2 ** 32);
		expect(helpers.nextPowerOfTwo(2 ** 40 + 1)).toBe(2 ** 41);
		expect(helpers.nextPowerOfTwo(2 ** 40 * (1 + 2 ** -52))).toBe(2 ** 41);
		expect(helpers.nextPowerOfTwo(2 ** 40 * (1 - 2 ** -53))).toBe(2 ** 40);
		expect(helpers.nextPowerOfTwo(2 ** 1023)).toBe(2 ** 1023);
	});

	it('gives 1 up to 1', function () {
		expect([1, 0.3, 0, -0, -5, -Infinity].map(helpers.nextPowerOfTwo)).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it('does not depend on the rounding of Math.log2', function () {
		// The specification leaves `Math.log2` implementation-approximated: an estimate one too low or too high is corrected.
		const low = jest.spyOn(Math, 'log2').mockReturnValue(9.5);
		expect(helpers.nextPowerOfTwo(3000)).toBe(4096);
		expect(helpers.isPowerOfTwo(2048)).toBe(true);
		low.mockReturnValue(12.5);
		expect(helpers.nextPowerOfTwo(3000)).toBe(4096);
		expect(helpers.isPowerOfTwo(2048)).toBe(true);
	});

	it('overflows to Infinity beyond 2 ** 1023', function () {
		expect(helpers.nextPowerOfTwo(2 ** 1023 * 1.5)).toBe(Infinity);
		expect(helpers.nextPowerOfTwo(Number.MAX_VALUE)).toBe(Infinity);
		expect(helpers.nextPowerOfTwo(Infinity)).toBe(Infinity);
	});

	it('rejects NaN and non-numbers', function () {
		expect(function () {
			helpers.nextPowerOfTwo(NaN);
		}).toThrow(new RangeError('nextPowerOfTwo: `n` must be a number (not NaN), got NaN'));
		expect(function () {
			helpers.nextPowerOfTwo('8' as never);
		}).toThrow(new TypeError('nextPowerOfTwo: `n` must be a number (not NaN), got string'));
	});
});

/** `n` choose `k` in BigInt arithmetic. */
function binomialBig(n: bigint, k: bigint): bigint {
	let result = 1n;
	for (let i = 1n; i <= k; i++) result = (result * (n - k + i)) / i;
	return result;
}

/** `base ** exponent mod modulus` in BigInt arithmetic, for non-negative arguments. */
function bigModPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
	let result = 1n % modulus;
	let power = base % modulus;
	for (let rest = exponent; rest > 0n; rest >>= 1n, power = (power * power) % modulus) {
		if ((rest & 1n) === 1n) result = (result * power) % modulus;
	}
	return result;
}
