import { assertInteger, assertNumber, describe, draw, show } from '../utils/assert.js';
import type { RandomGenerator } from '../utils/index.js';

/**
 * Options accepted by {@link variance} and {@link standardDeviation}.
 */
export interface VarianceOptions {
	/**
	 * When `true`, computes the sample (Bessel-corrected, divides by `n - 1`) statistic instead of the population one (divides by `n`).
	 * @default false
	 */
	sample?: boolean;
}

/**
 * Multiplies a number by `10 ** exponent` without going through floating-point multiplication,
 * by editing the exponent of its decimal string representation. Works for numbers whose `String()` is already exponential.
 * @param {number} value - The number to shift
 * @param {number} exponent - The power of ten to shift by (may be negative)
 * @returns {number} `value * 10 ** exponent`, computed on the decimal representation
 * @example
 * shiftDecimal(1.005, 2); // => 100.5 // whereas 1.005 * 100 === 100.49999999999999
 */
function shiftDecimal(value: number, exponent: number): number {
	const [mantissa, currentExponent = '0'] = String(value).split('e');
	return Number(`${mantissa}e${Number(currentExponent) + exponent}`);
}

/**
 * Returns the largest double strictly smaller than `value` (for finite `value`).
 * @param {number} value - A finite number
 * @returns {number} The previous representable double
 * @example
 * nextDown(1); // => 0.9999999999999999
 */
function nextDown(value: number): number {
	if (value === 0) return -Number.MIN_VALUE;
	const double = new Float64Array([value]);
	// Doubles of one sign are ordered like their bit patterns: step the magnitude down (positive) or up (negative).
	new BigInt64Array(double.buffer)[0] += value > 0 ? -1n : 1n;
	return double[0];
}

/**
 * Whether `a` sorts after `b` in the total numeric order used by {@link sortedCopy}: ascending, `-0` before `0`, `NaN` last.
 * @param {number} a - A number
 * @param {number} b - Another number
 * @returns {boolean} `true` when `a` sorts strictly after `b`
 * @example
 * sortsAfter(0, -0); // => true
 */
function sortsAfter(a: number, b: number): boolean {
	// `1 / 0 > 1 / -0`; a `NaN` (the only value not equal to itself) is larger than any number. Also reporting `NaN` after `NaN` only
	// makes the insertion sort move a `NaN` past an identical one.
	return a > b || (a === b ? 1 / a > 1 / b : a !== a);
}

/**
 * Returns an ascending sorted copy of some numbers, in numeric order with `NaN` last and `-0` before `0`, so the order
 * never depends on the input order. Typed-array sorting is much faster than `Array#sort` with a comparator, but allocating
 * a typed array dominates for short inputs, which are insertion-sorted into a plain array instead.
 * @param {ArrayLike<number>} numbers - The numbers to sort (not mutated)
 * @returns {ArrayLike<number>} A new, sorted array
 * @example
 * Array.from(sortedCopy([3, NaN, 1])); // => [1, 3, NaN]
 */
function sortedCopy(numbers: ArrayLike<number>): ArrayLike<number> {
	const length = numbers.length;
	if (length > 32) return Float64Array.from(numbers).sort();
	const sorted: number[] = [];
	for (let i = 0; i < length; i++) {
		// The same conversion as the typed array's (`+` throws on BigInts too).
		const value = +numbers[i];
		let j = i;
		for (; j > 0 && sortsAfter(sorted[j - 1], value); j--) sorted[j] = sorted[j - 1];
		sorted[j] = value;
	}
	return sorted;
}

/**
 * Calculates the sum of an array of numbers using Neumaier (improved Kahan–Babuška) compensated summation,
 * which keeps the rounding error independent of the number of elements and makes the result
 * (practically) independent of their order.
 *
 * If any intermediate sum is non-finite (an `Infinity` or `NaN` element, or overflow), the plain
 * floating-point result (`Infinity`, `-Infinity` or `NaN`) is returned.
 * Like every aggregate of this module, each element is converted once with unary `+`, so numeric strings (from a query string,
 * a form or a CSV file) count as numbers instead of being concatenated, values that do not convert give `NaN`, and BigInts throw a `TypeError`.
 * @param {ReadonlyArray<number>} numbers - The numbers to add up
 * @returns {number} The sum (`0` for an empty array)
 * @example
 * sum([1, 2, 3, 4]); // => 10
 * sum([0.1, 0.2, 0.3]); // => 0.6 // naive reduce gives 0.6000000000000001
 * sum([1e100, 1, -1e100]); // => 1 // naive reduce gives 0
 * sum(['1', '2', '3'] as never); // => 6 // not '0123'
 */
export function sum(numbers: ReadonlyArray<number>): number {
	let total = 0;
	let compensation = 0;
	// An index loop: several times faster than `for...of` here. There is deliberately no fast path for exact (e.g. integer) input:
	// an integer pre-pass slowed mixed workloads down, and detecting exact additions inside the loop (`next - total === value`, both
	// ways) costs as much as the compensation it would skip, so the plain loop of other libraries stays about 1.6 times faster.
	for (let i = 0; i < numbers.length; i++) {
		const value = +numbers[i];
		const next = total + value;
		compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
		total = next;
	}
	return Number.isFinite(total) ? total + compensation : total;
}

/**
 * Rounds a number to a given number of decimal places, using its decimal representation so that
 * values like `1.005` round as written (`round(1.005, 2) === 1.01`).
 *
 * Ties are rounded half **away from zero** (symmetrically): `round(2.5) === 3`, `round(-2.5) === -3`,
 * `round(-1.235, 2) === -1.24`. Note that this differs from `Math.round`, which rounds negative halves towards `+Infinity`.
 *
 * Negative `decimals` round to tens, hundreds, etc. Non-finite input (`NaN`, `±Infinity`) is returned as-is.
 * @param {number} number - The number to round
 * @param {number} [decimals=0] - The number of decimal places to keep (integer, may be negative)
 * @returns {number} The rounded number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * round(1.2345, 2); // => 1.23
 * round(1.005, 2); // => 1.01
 * round(-2.5); // => -3
 * round(1234, -2); // => 1200
 * round(1e-7, 2); // => 0
 */
export function round(number: number, decimals = 0): number {
	assertNumber('round', 'decimals', decimals, Number.isInteger(decimals), 'an integer');
	// Fast path: `number * 10 ** decimals` (exact power of ten, correctly rounded product) is within a few ulps of the
	// decimal-shifted value, so unless it lies within a safety margin of a `.5` tie, both round to the same integer `k`, and
	// `k / 10 ** decimals` (a correctly rounded division) is exactly the double nearest to the decimal `k e-decimals`.
	// Away from ties, `Math.round` (ties towards +Infinity) agrees with rounding half away from zero, signs and `-0` included.
	// Near ties, for huge values (the margin exceeds `0.5` beyond `2 ** 45`), for non-finite numbers and for `decimals` outside
	// `0..22` (no exact power of ten: the product is `NaN`, which fails the margin test), the decimal strings are edited instead.
	const scale = POWERS_OF_TEN[decimals];
	const scaled = number * scale;
	if (Math.abs(scaled - Math.floor(scaled) - 0.5) > Math.abs(scaled) * 2 ** -46) return Math.round(scaled) / scale;
	// Non-finite input, or the number already has at most `decimals` fractional digits: rounding is the identity.
	if (!Number.isFinite(number) || decimalPlaces(number) <= decimals) return number;
	// `1 / -0` is `-Infinity`.
	const negative = 1 / number < 0;
	const rounded = roundDecimalString(Math.abs(number), decimals);
	return negative ? -rounded : rounded;
}

/**
 * Rounds a positive finite number half up on its shortest decimal representation (the digits `String` shows), to `decimals` places.
 * The digits are rounded as text and converted once: shifting them into a double first would lose the first dropped digit for
 * values of `2 ** 51` and more once shifted (`3.0000000000000004` to 15 places would round up).
 * @param {number} value - A positive finite number with more than `decimals` decimal places
 * @param {number} decimals - The integer number of decimal places to keep (may be negative)
 * @returns {number} The double nearest to the rounded decimal
 * @example
 * roundDecimalString(3.0000000000000004, 15); // => 3
 */
function roundDecimalString(value: number, decimals: number): number {
	const [mantissa, exponent = '0'] = String(value).split('e');
	const point = mantissa.indexOf('.');
	const digits = point === -1 ? mantissa : mantissa.slice(0, point) + mantissa.slice(point + 1);
	// The number of digits before the decimal point, in the full positional form of the value.
	const integerDigits = (point === -1 ? mantissa.length : point) + Number(exponent);
	const keep = integerDigits + decimals;
	// Every kept digit is beyond the ones of the value, and the first dropped one is a leading zero: it rounds to zero.
	if (keep < 0) return 0;
	const kept = BigInt(digits.slice(0, keep) || '0') + (digits.charCodeAt(keep) >= 53 ? 1n : 0n);
	return Number(`${kept}e${-decimals}`);
}

/** `10 ** k` for `k` in `0..22`, the powers of ten that are exactly representable as doubles. */
const POWERS_OF_TEN: ReadonlyArray<number> = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/**
 * Calculates the arithmetic mean of an array of numbers (using the compensated {@link sum}, so numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers to average
 * @returns {number} The mean, or `NaN` for an empty array
 * @example
 * average([1, 2, 3, 4]); // => 2.5
 * average([]); // => NaN
 */
export function average(numbers: ReadonlyArray<number>): number {
	const total = sum(numbers);
	if (Number.isFinite(total)) return total / numbers.length;
	// The sum overflowed (or an element is infinite, or overflowing terms met an infinite one as `Infinity - Infinity`): the sum of the terms divided by the count cannot overflow when the mean is finite.
	const count = numbers.length;
	return sum(
		numbers.map(function (value) {
			return +value / count;
		})
	);
}

/**
 * Calculates the factorial of a non-negative integer, iteratively (in doubles: from `27!` on, the rounding of each product can leave the
 * result a few units in the last place away from the correctly rounded `n!`, while keeping `factorial(n + 1) === (n + 1) * factorial(n)`).
 * Results above `170!` exceed `Number.MAX_VALUE`, so `Infinity` is returned for `number > 170`.
 * @param {number} number - A non-negative integer
 * @returns {number} `number!` (`Infinity` when `number > 170`)
 * @throws {RangeError} when `number` is negative or not an integer
 * @throws {TypeError} when `number` is not a number
 * @example
 * factorial(0); // => 1
 * factorial(5); // => 120
 * factorial(171); // => Infinity
 */
export function factorial(number: number): number {
	assertInteger('factorial', 'number', number);
	if (number > 170) return Infinity;
	let result = 1;
	for (let i = 2; i <= number; i++) result *= i;
	return result;
}

/**
 * Finds the maximum value in an array of numbers, with the same semantics as `Math.max`
 * (`-Infinity` for an empty array, `NaN` if any element is `NaN`, `0` preferred over `-0`),
 * but without spreading the array, so it works on arrays of any length.
 * Elements are converted once with unary `+`, like `Math.max` does (numeric strings compare as numbers, and the result is always a number).
 * @param {ReadonlyArray<number>} numbers - The numbers to search
 * @returns {number} The largest value
 * @example
 * max([1, 5, 3]); // => 5
 * max([]); // => -Infinity
 */
export function max(numbers: ReadonlyArray<number>): number {
	let result = -Infinity;
	for (const item of numbers) {
		const value = +item;
		if (value !== value) return NaN;
		if (value > result || (value === 0 && Object.is(result, -0))) result = value;
	}
	return result;
}

/**
 * Finds the minimum value in an array of numbers, with the same semantics as `Math.min`
 * (`Infinity` for an empty array, `NaN` if any element is `NaN`, `-0` preferred over `0`),
 * but without spreading the array, so it works on arrays of any length.
 * Elements are converted once with unary `+`, like `Math.min` does (numeric strings compare as numbers, and the result is always a number).
 * @param {ReadonlyArray<number>} numbers - The numbers to search
 * @returns {number} The smallest value
 * @example
 * min([4, 1, 3]); // => 1
 * min([]); // => Infinity
 */
export function min(numbers: ReadonlyArray<number>): number {
	let result = Infinity;
	for (const item of numbers) {
		const value = +item;
		if (value !== value) return NaN;
		if (value < result || (result === 0 && Object.is(value, -0))) result = value;
	}
	return result;
}

/**
 * Finds the absolute value of a number.
 * @param {number} number - The number whose absolute value is to be found
 * @returns {number} The absolute value of the given number
 * @example
 * abs(-10); // => 10
 */
export function abs(number: number): number {
	return Math.abs(number);
}

/**
 * Finds the square root of a number.
 * @param {number} number - The number whose square root is to be found
 * @returns {number} The square root of the given number (`NaN` for negative input)
 * @example
 * sqrt(9); // => 3
 */
export function sqrt(number: number): number {
	return Math.sqrt(number);
}

/**
 * Raises a base to an exponent.
 * @param {number} base - The base number
 * @param {number} exponent - The exponent to raise the base to
 * @returns {number} `base ** exponent`
 * @example
 * pow(2, 3); // => 8
 */
export function pow(base: number, exponent: number): number {
	return Math.pow(base, exponent);
}

/**
 * Returns the logarithm of a number in the given base.
 * Bases `10`, `2` and `Math.E` use the dedicated (exact for exact powers) `Math.log10`, `Math.log2` and `Math.log`;
 * other bases use `Math.log(number) / Math.log(base)`, snapped to the nearest integer `k` when `base ** k === number`
 * exactly (so exact powers such as `log(81, 3)` give an exact integer instead of `4.000000000000001`).
 * @param {number} number - The number whose logarithm is wanted
 * @param {number} base - The base of the logarithm
 * @returns {number} `log_base(number)`
 * @example
 * log(1000, 10); // => 3 // the plain ratio gives 2.9999999999999996
 * log(16, 2); // => 4
 * log(81, 3); // => 4
 */
export function log(number: number, base: number): number {
	if (base === 10) return Math.log10(number);
	if (base === 2) return Math.log2(number);
	if (base === Math.E) return Math.log(number);
	const ratio = Math.log(number) / Math.log(base);
	const nearest = Math.round(ratio);
	// A non-finite ratio fails the first test (`Infinity - Infinity` is `NaN`) and is returned as is.
	if (Math.abs(ratio - nearest) <= 1e-9 * Math.max(1, Math.abs(nearest)) && Math.pow(base, nearest) === number) return nearest;
	return ratio;
}

/**
 * Rounds a number up (towards `+Infinity`) to a given number of decimal places. Like {@link round}, it works on the decimal
 * representation, so values are rounded as written: `ceil(1.1, 2) === 1.1` (the naive `Math.ceil(1.1 * 100) / 100` gives `1.11`).
 * Negative `decimals` round up to tens, hundreds, etc. Without `decimals` it is exactly `Math.ceil`. Non-finite input is returned as-is.
 * @param {number} number - The number to round up
 * @param {number} [decimals=0] - The number of decimal places to keep (integer, may be negative)
 * @returns {number} The smallest multiple of `10 ** -decimals` greater than or equal to the number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * ceil(3.14); // => 4
 * ceil(1.1, 2); // => 1.1
 * ceil(4.006, 2); // => 4.01
 * ceil(-4.006, 2); // => -4
 * ceil(6040, -2); // => 6100
 */
export function ceil(number: number, decimals = 0): number {
	return decimals === 0 ? Math.ceil(number) : roundDirected('ceil', Math.ceil, number, decimals);
}

/**
 * Rounds a number down (towards `-Infinity`) to a given number of decimal places. Like {@link round}, it works on the decimal
 * representation, so values are rounded as written: `floor(4.35, 2) === 4.35` (the naive `Math.floor(4.35 * 100) / 100` gives `4.34`).
 * Negative `decimals` round down to tens, hundreds, etc. Without `decimals` it is exactly `Math.floor`. Non-finite input is returned as-is.
 * @param {number} number - The number to round down
 * @param {number} [decimals=0] - The number of decimal places to keep (integer, may be negative)
 * @returns {number} The largest multiple of `10 ** -decimals` less than or equal to the number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * floor(3.14); // => 3
 * floor(4.35, 2); // => 4.35
 * floor(1.239, 2); // => 1.23
 * floor(-1.231, 2); // => -1.24
 * floor(4060, -2); // => 4000
 */
export function floor(number: number, decimals = 0): number {
	return decimals === 0 ? Math.floor(number) : roundDirected('floor', Math.floor, number, decimals);
}

/**
 * Rounds a number up or down at a decimal precision, on its decimal representation (shared by {@link ceil} and {@link floor}).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {(value: number) => number} method - `Math.ceil` or `Math.floor`
 * @param {number} number - The number to round
 * @param {number} decimals - The number of decimal places to keep
 * @returns {number} The rounded number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * roundDirected('ceil', Math.ceil, 1.1, 2); // => 1.1
 */
function roundDirected(caller: string, method: (value: number) => number, number: number, decimals: number): number {
	assertNumber(caller, 'decimals', decimals, Number.isInteger(decimals), 'an integer');
	// Fast path (see `round`): unless the scaled product lies within a safety margin of an integer, it rounds to the same integer `k` as
	// the decimal-shifted value, and `k / 10 ** decimals` is the double nearest to `k e-decimals`.
	const scale = POWERS_OF_TEN[decimals];
	const scaled = number * scale;
	if (Math.abs(scaled - Math.round(scaled)) > Math.abs(scaled) * 2 ** -46) return method(scaled) / scale;
	if (!Number.isFinite(number)) return number;
	// The shortest decimal representation is `digits * 10 ** -places`; the last `drop` digits go. Working on the digits (not on a
	// shifted double, which cannot hold a fraction beyond 2 ** 52) converts to a double only once, so the result never crosses `number`.
	const [mantissa, exponent = '0'] = String(Math.abs(number)).split('e');
	const [whole, fraction = ''] = mantissa.split('.');
	const digits = whole + fraction;
	const drop = fraction.length - Number(exponent) - decimals;
	// Already at most `decimals` fractional digits: unchanged.
	if (drop <= 0) return number;
	const kept = BigInt(digits.slice(0, Math.max(0, digits.length - drop)) || 0);
	const negative = 1 / number < 0;
	// Ceiling a positive number or flooring a negative one moves its magnitude up when a non-zero digit is dropped.
	const away = (method === Math.ceil) !== negative && /[1-9]/.test(digits.slice(-drop));
	// A zero result keeps the sign of `number` (`ceil(-0.001, 2)` is `-0`, like `Math.ceil(-0.1)`).
	// (`BigInt` prints the exponent in full: `${1e21}` would be `1e+21`.)
	const result = Number(`${away ? kept + 1n : kept}e${BigInt(-decimals)}`);
	return negative ? -result : result;
}

/**
 * Mathematical (floored) modulo: the result always has the sign of the `divisor`
 * (so for a positive divisor it lies in `[0, divisor)`), unlike the JavaScript `%` operator (see {@link remainder}).
 * A zero result is always `+0`. Returns `NaN` when `divisor` is `0` or either argument is `NaN`.
 * When the exact result is so close to `divisor` that it rounds to it (e.g. `modulo(-1e-20, 3)`), `0` — the congruent
 * value nearest on the circle — is returned, so the result never equals a finite `divisor`.
 * @param {number} dividend - The number to be divided
 * @param {number} divisor - The number to divide by
 * @returns {number} `dividend mod divisor`
 * @example
 * modulo(7, 3); // => 1
 * modulo(-1, 3); // => 2 // whereas -1 % 3 === -1
 * modulo(1, -3); // => -2
 */
export function modulo(dividend: number, divisor: number): number {
	const rest = dividend % divisor;
	if (rest === 0) return 0;
	if (rest < 0 === divisor < 0) return rest;
	const wrapped = rest + divisor;
	return wrapped === divisor && Number.isFinite(divisor) ? 0 : wrapped;
}

/**
 * Truncated remainder, identical to the JavaScript `%` operator: the result has the sign of the `dividend`.
 * This is what `modulo` returned before it was fixed.
 * @param {number} dividend - The number to be divided
 * @param {number} divisor - The number to divide by
 * @returns {number} `dividend % divisor`
 * @example
 * remainder(7, 3); // => 1
 * remainder(-1, 3); // => -1
 */
export function remainder(dividend: number, divisor: number): number {
	return dividend % divisor;
}

/**
 * Generates a random floating-point number in the half-open range `[minimum, maximum)`.
 * When `minimum === maximum`, `minimum` is returned.
 * Not cryptographically secure by default: pass `secureRandom` (random module) for tokens, OTPs, lotteries…
 * @param {number} minimum - Inclusive lower bound
 * @param {number} maximum - Exclusive upper bound
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`
 * @returns {number} A random number `n` with `minimum <= n < maximum`
 * @throws {TypeError} when a bound is not a number, or `random` is not a function
 * @throws {RangeError} when a bound is not finite, `minimum > maximum`, or `random()` returns a value outside `[0, 1)`
 * @example
 * randomBetween(1, 10); // e.g. 4.7181…
 * randomBetween(0, 10, function () { return 0.5; }); // => 5
 */
export function randomBetween(minimum: number, maximum: number, random: RandomGenerator = Math.random): number {
	assertNumber('randomBetween', 'minimum', minimum, Number.isFinite(minimum), 'a finite number');
	assertNumber('randomBetween', 'maximum', maximum, Number.isFinite(maximum), 'a finite number');
	if (minimum > maximum) throw new RangeError(`randomBetween: \`minimum\` must not be greater than \`maximum\`, got ${minimum} and ${maximum}`);
	if (minimum === maximum) return minimum;

	const r = draw('randomBetween', random);
	const span = maximum - minimum;
	const value = Number.isFinite(span) ? minimum + r * span : minimum * (1 - r) + maximum * r;
	const clamped = Math.max(value, minimum);
	// Floating-point rounding can land exactly on `maximum`; keep the range half-open.
	return clamped < maximum ? clamped : nextDown(maximum);
}

/**
 * Returns a random integer between `minimum` and `maximum`, both inclusive.
 * Non-integer bounds are narrowed to the integers inside them (`ceil(minimum)` .. `floor(maximum)`).
 * Ranges of more than `2 ** 32` integers combine two draws (21 + 32 bits), so that generators with only 32 bits of precision (such as
 * `createRandom` streams) still reach every integer of ranges up to `2 ** 53`; smaller ranges use a single draw.
 * Not cryptographically secure by default: pass `secureRandom` (random module) for tokens, OTPs, lotteries…
 * @param {number} minimum - Inclusive lower bound
 * @param {number} maximum - Inclusive upper bound
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`
 * @returns {number} A random integer `n` with `ceil(minimum) <= n <= floor(maximum)`
 * @throws {TypeError} when a bound is not a number, or `random` is not a function
 * @throws {RangeError} when a bound is not finite, no integer lies in `[minimum, maximum]` (including `minimum > maximum`), or `random()` returns a value outside `[0, 1)`
 * @example
 * randomIntBetween(1, 6); // e.g. 4
 * randomIntBetween(1.2, 3.8); // 2 or 3: only the integers inside the range
 */
export function randomIntBetween(minimum: number, maximum: number, random: RandomGenerator = Math.random): number {
	assertNumber('randomIntBetween', 'minimum', minimum, Number.isFinite(minimum), 'a finite number');
	assertNumber('randomIntBetween', 'maximum', maximum, Number.isFinite(maximum), 'a finite number');
	const low = Math.ceil(minimum);
	const high = Math.floor(maximum);
	if (low > high) throw new RangeError(`randomIntBetween: no integer exists in [${minimum}, ${maximum}]`);
	const span = high - low + 1;
	let r = draw('randomIntBetween', random);
	// A single 32-bit draw could only reach 2 ** 32 evenly spaced integers of a wider range.
	if (span > 4294967296) r = (Math.floor(r * 2097152) * 4294967296 + Math.floor(draw('randomIntBetween', random) * 4294967296)) / 9007199254740992;
	return Math.min(high, low + Math.floor(r * span)) + 0;
}

/**
 * Converts degrees to radians.
 * @param {number} degrees - The angle in degrees
 * @returns {number} The angle in radians
 * @example
 * toRadians(180); // => 3.141592653589793
 */
export function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

/**
 * Converts radians to degrees.
 * @param {number} radians - The angle in radians
 * @returns {number} The angle in degrees
 * @example
 * toDegrees(Math.PI); // => 180
 */
export function toDegrees(radians: number): number {
	return (radians * 180) / Math.PI;
}

/**
 * Restricts a value to the inclusive range `[minimum, maximum]`. `NaN` values stay `NaN`.
 * @param {number} value - The value to clamp
 * @param {number} minimum - Lower bound
 * @param {number} maximum - Upper bound
 * @returns {number} `minimum` if `value < minimum`, `maximum` if `value > maximum`, otherwise `value`
 * @throws {RangeError} when `minimum > maximum` or a bound is `NaN`
 * @example
 * clamp(15, 0, 10); // => 10
 * clamp(-5, 0, 10); // => 0
 * clamp(5, 0, 10); // => 5
 * Object.is(clamp(-0, 0, 10), -0); // => true
 */
export function clamp(value: number, minimum: number, maximum: number): number {
	if (!(minimum <= maximum)) throw new RangeError(`clamp: \`minimum\` must not be greater than \`maximum\`, got ${minimum} and ${maximum}`);
	// Plain comparisons, not Math.min/Math.max: an in-range value is returned as is (`-0` stays `-0`), and `NaN` compares false.
	return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * Linear interpolation between `start` and `end`. `t = 0` gives exactly `start`, `t = 1` exactly `end`
 * (even when the other endpoint is infinite), and `start === end` gives exactly `start` for every finite `t`;
 * `t` outside `[0, 1]` extrapolates.
 * @param {number} start - Value at `t = 0`
 * @param {number} end - Value at `t = 1`
 * @param {number} t - Interpolation factor
 * @returns {number} `start + (end - start) * t`
 * @example
 * lerp(0, 10, 0.5); // => 5
 * lerp(10, 20, 0.25); // => 12.5
 */
export function lerp(start: number, end: number, t: number): number {
	if (t === 0) return start;
	if (t === 1) return end;
	if (start === end && Number.isFinite(t)) return start;
	return (1 - t) * start + t * end;
}

/**
 * Inverse of {@link lerp}: the factor `t` for which `lerp(start, end, t) === value`.
 * Returns `0` when `start === end` (the range is degenerate). The result is not clamped.
 * @param {number} start - Value mapped to `0`
 * @param {number} end - Value mapped to `1`
 * @param {number} value - The value to locate
 * @returns {number} `(value - start) / (end - start)`, or `0` when `start === end`
 * @example
 * inverseLerp(0, 10, 5); // => 0.5
 * inverseLerp(10, 20, 12.5); // => 0.25
 */
export function inverseLerp(start: number, end: number, value: number): number {
	if (start === end) return 0;
	const span = end - start;
	const offset = value - start;
	if (Number.isFinite(span) && Number.isFinite(offset)) return offset / span;
	// A difference overflowed (`inverseLerp(-1e308, 1e308, 0)`): the halves do not, and their ratio is the same.
	return (value / 2 - start / 2) / (end / 2 - start / 2);
}

/**
 * Linearly maps a value from the range `[inMin, inMax]` to `[outMin, outMax]` (not clamped).
 * When `inMin === inMax`, `outMin` is returned.
 * @param {number} value - The value to map
 * @param {number} inMin - Start of the input range
 * @param {number} inMax - End of the input range
 * @param {number} outMin - Start of the output range
 * @param {number} outMax - End of the output range
 * @returns {number} The mapped value
 * @example
 * mapRange(5, 0, 10, 0, 100); // => 50
 * mapRange(0.5, 0, 1, 10, 20); // => 15
 */
export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
	return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/**
 * Checks whether a value lies in the half-open range `[start, end)`.
 * Like lodash's `inRange`, the bounds are swapped when `start > end`, so the range is always `[min(start, end), max(start, end))`.
 * @param {number} value - The value to check
 * @param {number} start - Inclusive bound
 * @param {number} end - Exclusive bound
 * @returns {boolean} `true` if the value is in range
 * @example
 * inRange(3, 2, 4); // => true
 * inRange(4, 2, 4); // => false
 * inRange(-3, -2, -6); // => true // bounds swapped to [-6, -2)
 */
export function inRange(value: number, start: number, end: number): boolean {
	return start <= end ? value >= start && value < end : value >= end && value < start;
}

/**
 * Multiplies all numbers of an array together. Elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers to multiply
 * @returns {number} The product (`1` for an empty array)
 * @example
 * product([2, 3, 4]); // => 24
 * product([]); // => 1
 */
export function product(numbers: ReadonlyArray<number>): number {
	let result = 1;
	for (const value of numbers) result *= +value;
	return result;
}

/**
 * Finds the median of an array of numbers (the mean of the two middle values for even lengths).
 * The input is not mutated, and the result does not depend on its order (`-0` sorts before `0`).
 * Elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {number} The median, or `NaN` if the array is empty or contains `NaN`
 * @example
 * median([3, 1, 2]); // => 2
 * median([4, 1, 3, 2]); // => 2.5
 * median([]); // => NaN
 */
export function median(numbers: ReadonlyArray<number>): number {
	const sorted = sortedCopy(numbers);
	const length = sorted.length;
	// The largest value is missing (empty input) or NaN (sorted last): the median is undefined.
	if (!(sorted[length - 1] <= Infinity)) return NaN;
	const middle = length >> 1;
	if (length % 2 === 1) return sorted[middle];
	const low = sorted[middle - 1];
	const high = sorted[middle];
	const total = low + high;
	// `(low + high) / 2` is correctly rounded (and exact for equal values, even subnormal); halve first only on overflow.
	return Number.isFinite(total) ? total / 2 : low / 2 + high / 2;
}

/**
 * Finds the most frequent value(s) of an array of numbers.
 * Elements are converted once with unary `+` (so `'1'` and `1` are the same value), then compared with SameValueZero
 * (`0` and `-0` are the same value, `NaN` equals `NaN`).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {number[]} Every value with the highest occurrence count, in ascending order (`NaN` last); `[]` for an empty array
 * @example
 * mode([1, 2, 2, 3]); // => [2]
 * mode([3, 1, 3, 1, 2]); // => [1, 3]
 * mode([]); // => []
 */
export function mode(numbers: ReadonlyArray<number>): number[] {
	const counts = new Map<number, number>();
	let highest = 0;
	for (const item of numbers) {
		const value = +item;
		const count = (counts.get(value) ?? 0) + 1;
		counts.set(value, count);
		highest = Math.max(highest, count);
	}
	const result: number[] = [];
	for (const [value, count] of counts) {
		if (count === highest) result.push(value);
	}
	return Array.from(sortedCopy(result));
}

/**
 * Computes the variance of an array of numbers using Welford's numerically stable online algorithm.
 * By default the population variance (divide by `n`) is returned; pass `{ sample: true }` for the
 * sample variance (divide by `n - 1`). Elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {VarianceOptions} [options={}] - `sample`: compute the sample variance instead of the population one
 * @returns {number} The variance; `NaN` for an empty array, for a sample of fewer than 2 values, or if an element is not finite;
 * `Infinity` when every element is finite but the variance overflows (e.g. `variance([1e308, -1e308])`)
 * @example
 * variance([2, 4, 4, 4, 5, 5, 7, 9]); // => 4
 * variance([1, 2, 3, 4], { sample: true }); // => 1.6666666666666667
 * variance([]); // => NaN
 */
export function variance(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	const sample = options.sample === true;
	const [count, squaredDistance, allFinite] = welford(numbers, 1);
	const divisor = sample ? count - 1 : count;
	if (divisor <= 0 || !allFinite) return NaN;
	if (squaredDistance >= 0 && squaredDistance < Infinity) return squaredDistance / divisor;
	// The running sum of squared deviations (`n` times the variance) overflowed, or Welford's update turned that into `-Infinity` or
	// `NaN`: redo it on values scaled by 2 ** -600 (exact), then scale the variance back in two exact steps, so that only a variance
	// that really overflows is `Infinity`.
	const scaledDistance = welford(numbers, 2 ** -600)[1];
	return (scaledDistance / divisor) * 2 ** 600 * 2 ** 600;
}

/**
 * Welford's online algorithm on `numbers` multiplied by `scale`: the count, the sum of squared deviations from the mean, and whether
 * every element is finite. Elements are converted with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {number} scale - A power of two to multiply them by
 * @returns {[number, number, boolean]} The count, the sum of squared deviations (of the scaled values) and whether all are finite
 */
function welford(numbers: ReadonlyArray<number>, scale: number): [number, number, boolean] {
	let count = 0;
	let mean = 0;
	let squaredDistance = 0;
	let allFinite = true;
	for (const item of numbers) {
		const value = +item * scale;
		count++;
		if (!Number.isFinite(value)) allFinite = false;
		const delta = value - mean;
		mean += delta / count;
		squaredDistance += delta * (value - mean);
	}
	return [count, squaredDistance, allFinite];
}

/**
 * Computes the standard deviation (square root of {@link variance}) of an array of numbers.
 * Population by default; pass `{ sample: true }` for the sample standard deviation.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {VarianceOptions} [options={}] - `sample`: compute the sample statistic instead of the population one
 * @returns {number} The standard deviation; `NaN` when the variance is undefined (see {@link variance})
 * @example
 * standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]); // => 2
 * standardDeviation([1]); // => 0
 * standardDeviation([1], { sample: true }); // => NaN
 */
export function standardDeviation(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	return Math.sqrt(variance(numbers, options));
}

/**
 * Greatest common divisor of two integers (Euclid's algorithm). The result is never negative,
 * and `gcd(0, 0) === 0`.
 * @param {number} a - First integer
 * @param {number} b - Second integer
 * @returns {number} The greatest common divisor of `a` and `b`
 * @throws {RangeError} when `a` or `b` is not an integer
 * @throws {TypeError} when `a` or `b` is not a number
 * @example
 * gcd(12, 18); // => 6
 * gcd(-4, 6); // => 2
 * gcd(0, 5); // => 5
 */
export function gcd(a: number, b: number): number {
	assertNumber('gcd', 'a', a, Number.isInteger(a), 'an integer');
	assertNumber('gcd', 'b', b, Number.isInteger(b), 'an integer');
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const rest = x % y;
		x = y;
		y = rest;
	}
	return x;
}

/**
 * Least common multiple of two integers. The result is never negative, and is `0` if either argument is `0`.
 * @param {number} a - First integer
 * @param {number} b - Second integer
 * @returns {number} The least common multiple of `a` and `b`
 * @throws {RangeError} when `a` or `b` is not an integer
 * @throws {TypeError} when `a` or `b` is not a number
 * @example
 * lcm(4, 6); // => 12
 * lcm(-3, 5); // => 15
 * lcm(0, 5); // => 0
 */
export function lcm(a: number, b: number): number {
	assertNumber('lcm', 'a', a, Number.isInteger(a), 'an integer');
	assertNumber('lcm', 'b', b, Number.isInteger(b), 'an integer');
	const divisor = gcd(a, b);
	// The divisor is `0` only for lcm(0, 0).
	return divisor === 0 ? 0 : Math.abs((a / divisor) * b);
}

/** Bases of the Miller–Rabin test run by {@link isPrime}: the first nine primes. */
const PRIME_BASES: ReadonlyArray<bigint> = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];

/**
 * `PRIME_BASE_LIMITS[i]` is the smallest strong pseudoprime to all the bases `PRIME_BASES[0..i]`: every odd number below it that
 * passes those bases is prime (the first nine prime bases are deterministic below 3,825,123,056,546,413,051, beyond `2 ** 53`).
 */
const PRIME_BASE_LIMITS: ReadonlyArray<number> = [2047, 1373653, 25326001, 3215031751, 2152302898747, 3474749660383, 341550071728321, 341550071728321, Infinity];

/**
 * Deterministic Miller–Rabin primality test for odd integers `5 <= number < 2 ** 53` without small factors, in BigInt arithmetic
 * (the squares of such numbers exceed `2 ** 53`). Runs only as many bases as {@link PRIME_BASE_LIMITS} requires for `number`.
 * @param {number} number - An odd safe integer, at least 5
 * @returns {boolean} Whether `number` is prime
 * @example
 * millerRabin(9007199254740881); // => true
 */
function millerRabin(number: number): boolean {
	const n = BigInt(number);
	const nMinusOne = n - 1n;
	// n - 1 = odd * 2 ** twos
	let odd = nMinusOne;
	let twos = 0;
	while ((odd & 1n) === 0n) {
		odd >>= 1n;
		twos++;
	}
	for (let i = 0; ; i++) {
		// x = base ** odd mod n, by right-to-left binary exponentiation.
		let x = 1n;
		let power = PRIME_BASES[i];
		for (let exponent = odd; ; power = (power * power) % n) {
			if ((exponent & 1n) === 1n) x = (x * power) % n;
			exponent >>= 1n;
			if (exponent === 0n) break;
		}
		// A prime n gives x = 1, or reaches n - 1 within `twos - 1` further squarings.
		if (x !== 1n) {
			for (let squarings = 1; x !== nMinusOne; squarings++) {
				if (squarings === twos) return false;
				x = (x * x) % n;
			}
		}
		if (number < PRIME_BASE_LIMITS[i]) return true;
	}
}

/**
 * Checks whether a number is a prime. Small numbers (below about `10 ** 6`) use 6k ± 1 trial division; larger ones are
 * trial-divided by the numbers up to about 1000 and then go through a deterministic Miller–Rabin test (exact for every safe integer,
 * with no probabilistic error), so the cost is bounded — a few tens of microseconds — whatever the input, even for attacker-chosen
 * numbers close to `2 ** 53` (trial division up to `√n` would take a third of a second there).
 * Returns `false` for non-integers, negatives, `0` and `1`, and for integers beyond `2 ** 53` (doubles that large are all even).
 * @param {number} number - The number to test
 * @returns {boolean} `true` if the number is prime
 * @example
 * isPrime(7); // => true
 * isPrime(9); // => false
 * isPrime(1); // => false
 * isPrime(9007199254740881); // => true // the largest prime below 2 ** 53
 */
export function isPrime(number: number): boolean {
	if (!Number.isInteger(number) || number < 2) return false;
	if (number < 4) return true;
	if (number % 2 === 0 || number % 3 === 0) return false;
	for (let i = 5; i * i <= number; i += 6) {
		if (number % i === 0 || number % (i + 2) === 0) return false;
		// Past `1024 ** 2`, finishing the trial division would cost more than the Miller–Rabin test.
		if (i > 1024) return millerRabin(number);
	}
	return true;
}

/**
 * Checks whether a number is an even integer. Non-integers (including `NaN` and `±Infinity`) are neither even nor odd.
 * @param {number} number - The number to test
 * @returns {boolean} `true` if the number is an even integer
 * @example
 * isEven(4); // => true
 * isEven(3); // => false
 * isEven(2.5); // => false
 */
export function isEven(number: number): boolean {
	return Number.isInteger(number) && number % 2 === 0;
}

/**
 * Checks whether a number is an odd integer. Non-integers (including `NaN` and `±Infinity`) are neither even nor odd.
 * @param {number} number - The number to test
 * @returns {boolean} `true` if the number is an odd integer
 * @example
 * isOdd(3); // => true
 * isOdd(-3); // => true
 * isOdd(4); // => false
 */
export function isOdd(number: number): boolean {
	return Number.isInteger(number) && Math.abs(number % 2) === 1;
}

/**
 * Expresses `value` as a percentage of `total` (`value / total * 100`).
 * When `total` is `0` the percentage is undefined and `NaN` is returned (rather than `±Infinity`).
 * @param {number} value - The part
 * @param {number} total - The whole
 * @returns {number} The percentage, or `NaN` when `total` is `0`
 * @example
 * percentage(25, 200); // => 12.5
 * percentage(3, 0); // => NaN
 */
export function percentage(value: number, total: number): number {
	if (total === 0) return NaN;
	return (value / total) * 100;
}

/**
 * Options accepted by {@link approximatelyEqual}.
 */
export interface ApproximatelyEqualOptions {
	/**
	 * Maximum allowed difference relative to the larger magnitude of the two values. Must be `>= 0`.
	 * @default 1e-9
	 */
	relative?: number;
	/**
	 * Minimum absolute tolerance, useful for comparisons near zero. Must be `>= 0`.
	 * @default 0
	 */
	absolute?: number;
}

/**
 * Options accepted by {@link formatBytes}.
 */
export interface FormatBytesOptions {
	/**
	 * Maximum number of decimal places (trailing zeros are dropped). Non-negative integer.
	 * @default 1
	 */
	decimals?: number;
	/**
	 * `1000` for SI units (`kB`, `MB`, …) or `1024` for IEC binary units (`KiB`, `MiB`, …).
	 * @default 1000
	 */
	base?: 1000 | 1024;
}

/**
 * Throws unless `base` is `1000` or `1024`.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} base - The value to check
 * @returns {void}
 * @throws {RangeError} when `base` is neither `1000` nor `1024`
 */
function assertByteBase(caller: string, base: unknown): void {
	if (base !== 1000 && base !== 1024) throw new RangeError(`${caller}: \`base\` must be 1000 or 1024, got ${show(base)}`);
}

const SI_BYTE_UNITS: ReadonlyArray<string> = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
const IEC_BYTE_UNITS: ReadonlyArray<string> = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];

/**
 * Interpolates between two sorted values `low <= high`, monotonically in `t` and never leaving `[low, high]`.
 * @param {number} low - Value at `t = 0`
 * @param {number} high - Value at `t = 1` (must be `>= low`)
 * @param {number} t - Factor in `[0, 1)`
 * @returns {number} The interpolated value
 * @example
 * interpolateSorted(1, 3, 0.5); // => 2
 */
function interpolateSorted(low: number, high: number, t: number): number {
	if (t === 0 || low === high) return low;
	const span = high - low;
	if (!Number.isFinite(span)) return (1 - t) * low + t * high;
	return Math.min(low + t * span, high);
}

/**
 * Counts the decimal places in the shortest decimal representation of a finite number: the power of ten `-k` of its last
 * significant digit, so it is negative for large numbers written in exponential form (`1.5e+22` has `-21`).
 * @param {number} value - A finite number
 * @returns {number} The number of digits after the decimal point (`0` for integers written in full, negative for `1e21` and above)
 * @example
 * decimalPlaces(0.25); // => 2
 * decimalPlaces(1e-7); // => 7
 * decimalPlaces(1.5e22); // => -21
 */
function decimalPlaces(value: number): number {
	const [mantissa, exponent = '0'] = String(value).split('e');
	return (mantissa.split('.')[1] ?? '').length - Number(exponent);
}

/**
 * Computes the `q`-quantile of an array of numbers by linear interpolation between closest ranks
 * (R type 7, the default of R, NumPy and Excel's `PERCENTILE.INC`): with the values sorted ascending,
 * `h = (n - 1) * q` and the result interpolates between the values at ranks `floor(h)` and `ceil(h)`.
 * The input is not mutated, and the result does not depend on its order (`-0` sorts before `0`).
 * Elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {number} q - The quantile to compute, in `[0, 1]` (`0` gives the minimum, `0.5` the median, `1` the maximum)
 * @returns {number} The quantile, or `NaN` if the array is empty or contains `NaN`
 * @throws {RangeError} when `q` is not in `[0, 1]` (including `NaN`)
 * @throws {TypeError} when `q` is not a number
 * @example
 * quantile([1, 2, 3, 4], 0.5); // => 2.5
 * quantile([1, 2, 3, 4], 0.25); // => 1.75
 * quantile([7, 1, 3], 1); // => 7
 * quantile([], 0.5); // => NaN
 */
export function quantile(numbers: ReadonlyArray<number>, q: number): number {
	assertNumber('quantile', 'q', q, q >= 0 && q <= 1, 'a number in [0, 1]');
	const sorted = sortedCopy(numbers);
	const length = sorted.length;
	// The largest value is missing (empty input) or NaN (sorted last): the quantile is undefined.
	if (!(sorted[length - 1] <= Infinity)) return NaN;
	const position = (length - 1) * q;
	const lowerIndex = Math.floor(position);
	// At q = 1 the factor is 0, so the (missing) value after the maximum is never used.
	return interpolateSorted(sorted[lowerIndex], sorted[lowerIndex + 1], position - lowerIndex);
}

/**
 * Computes the `p`-th percentile of an array of numbers: `quantile(numbers, p / 100)`
 * (linear interpolation, same semantics as Excel's `PERCENTILE.INC`).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {number} p - The percentile to compute, in `[0, 100]`
 * @returns {number} The percentile, or `NaN` if the array is empty or contains `NaN`
 * @throws {RangeError} when `p` is not in `[0, 100]` (including `NaN`)
 * @throws {TypeError} when `p` is not a number
 * @example
 * percentile([1, 2, 3, 4], 50); // => 2.5
 * percentile([15, 20, 35, 40, 50], 40); // => 29
 */
export function percentile(numbers: ReadonlyArray<number>, p: number): number {
	assertNumber('percentile', 'p', p, p >= 0 && p <= 100, 'a number in [0, 100]');
	return quantile(numbers, p / 100);
}

/**
 * Computes the running totals of a sequence of numbers using the same compensated (Neumaier) summation as {@link sum},
 * so the last element is exactly `sum(numbers)` and rounding errors do not accumulate along the sequence.
 * Elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {Iterable<number>} numbers - The numbers to accumulate
 * @returns {number[]} A new array of the same length whose `i`-th element is the sum of the first `i + 1` numbers
 * @example
 * cumulativeSum([1, 2, 3, 4]); // => [1, 3, 6, 10]
 * cumulativeSum([1e100, 1, -1e100]); // => [1e100, 1e100, 1] // naive running sums end with 0
 * cumulativeSum([]); // => []
 */
export function cumulativeSum(numbers: Iterable<number>): number[] {
	const result: number[] = [];
	let total = 0;
	let compensation = 0;
	for (const item of numbers) {
		const value = +item;
		const next = total + value;
		compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
		total = next;
		result.push(Number.isFinite(total) ? total + compensation : total);
	}
	return result;
}

/**
 * Checks whether two numbers are close to each other, with the semantics of Python's `math.isclose`:
 * `|a - b| <= max(relative * max(|a|, |b|), absolute)`.
 * `NaN` is never close to anything (not even itself), and an infinity is only close to itself.
 * Note that with the default `absolute = 0`, no non-zero number is close to `0`; pass an `absolute` tolerance for that.
 * @param {number} a - First number
 * @param {number} b - Second number
 * @param {ApproximatelyEqualOptions} [options={}] - `relative` (default `1e-9`) and `absolute` (default `0`) tolerances
 * @returns {boolean} `true` if the numbers are within tolerance of each other
 * @throws {RangeError} when a tolerance is negative or `NaN`
 * @throws {TypeError} when a tolerance is not a number
 * @example
 * approximatelyEqual(0.1 + 0.2, 0.3); // => true
 * approximatelyEqual(1, 1.1); // => false
 * approximatelyEqual(1, 1.1, { relative: 0.1 }); // => true
 * approximatelyEqual(1e-12, 0); // => false
 * approximatelyEqual(1e-12, 0, { absolute: 1e-9 }); // => true
 */
export function approximatelyEqual(a: number, b: number, options: ApproximatelyEqualOptions = {}): boolean {
	const { relative = 1e-9, absolute = 0 } = options;
	assertNumber('approximatelyEqual', 'relative', relative, relative >= 0, 'a number >= 0');
	assertNumber('approximatelyEqual', 'absolute', absolute, absolute >= 0, 'a number >= 0');
	if (a === b) return true;
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	const difference = Math.abs(a - b);
	return difference <= Math.abs(relative * a) || difference <= Math.abs(relative * b) || difference <= absolute;
}

/**
 * Computes the weighted arithmetic mean `Σ(value × weight) / Σ(weight)`, using the compensated {@link sum}.
 * Weights are rescaled by the largest one first, so only their ratios matter and very large or tiny (subnormal) weights neither overflow nor underflow.
 * Values and weights are converted with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} values - The values to average
 * @param {ReadonlyArray<number>} weights - One finite, non-negative weight per value
 * @returns {number} The weighted mean, or `NaN` when the total weight is `0` (including empty arrays)
 * @throws {TypeError} when a weight is a non-number that does not coerce to a valid weight
 * @throws {RangeError} when `values` and `weights` have different lengths, or a weight is negative, `NaN` or infinite
 * @example
 * weightedAverage([80, 90], [1, 3]); // => 87.5
 * weightedAverage([10, 20], [1, 1]); // => 15
 * weightedAverage([10, 20], [0, 0]); // => NaN
 */
export function weightedAverage(values: ReadonlyArray<number>, weights: ReadonlyArray<number>): number {
	if (values.length !== weights.length) {
		throw new RangeError(`weightedAverage: \`values\` and \`weights\` must have the same length, got ${values.length} and ${weights.length}`);
	}
	let largestWeight = 0;
	for (let i = 0; i < weights.length; i++) {
		const weight = weights[i];
		if (!(weight >= 0 && weight < Infinity)) assertNumber('weightedAverage', `weights[${i}]`, weight, false, 'a finite number >= 0');
		largestWeight = Math.max(largestWeight, weight);
	}
	// Rescaling the weights into [0, 1] keeps the products and the total weight from overflowing or underflowing. A zero total weight
	// (including empty arrays) needs no special case: `0 / 0` makes every scaled weight, and so the result, `NaN`.
	const scaledWeights = weights.map(function (weight) {
		return weight / largestWeight;
	});
	const products = values.map(function (value, index) {
		return value * scaledWeights[index];
	});
	const totalWeight = sum(scaledWeights);
	const total = sum(products);
	if (Number.isFinite(total)) return total / totalWeight;
	// The sum of the products overflowed (or a value is infinite, possibly meeting an overflow as `Infinity - Infinity`): dividing each product by the total weight first cannot overflow
	// when the mean is finite.
	return sum(
		products.map(function (weighted) {
			return weighted / totalWeight;
		})
	);
}

/**
 * Min–max normalization: linearly rescales the numbers so the smallest becomes `0` and the largest `1`.
 * Order is preserved (`a <= b` implies `normalize(a) <= normalize(b)`) and every result lies in `[0, 1]`.
 * When all numbers are equal, every result is `0`. Elements are converted with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The finite numbers to rescale
 * @returns {number[]} A new array of the same length with values in `[0, 1]`
 * @throws {RangeError} when an element is a number that is not finite (`NaN` or `±Infinity`)
 * @throws {TypeError} when an element is a non-number that does not convert to a finite number
 * @example
 * normalize([10, 20, 15]); // => [0, 1, 0.5]
 * normalize([5, 5]); // => [0, 0]
 * normalize([]); // => []
 */
export function normalize(numbers: ReadonlyArray<number>): number[] {
	for (let i = 0; i < numbers.length; i++) {
		if (!Number.isFinite(+numbers[i])) assertNumber('normalize', `numbers[${i}]`, numbers[i], false, 'a finite number');
	}
	const low = min(numbers);
	const high = max(numbers);
	if (low === high)
		return numbers.map(function () {
			return 0;
		});
	const range = high - low;
	// When the range overflows, work on halved values (exact for normal doubles) to keep it finite.
	const scale = Number.isFinite(range) ? 1 : 0.5;
	const scaledRange = high * scale - low * scale;
	return numbers.map(function (value) {
		return (value * scale - low * scale) / scaledRange;
	});
}

/**
 * Expresses a byte count in the unit `base ** exponent`. SI units shift the decimal digits (like {@link parseBytes}), since powers of
 * `1000` beyond `1000 ** 7` are not exact doubles (`305.035e24` bytes must read `305.035 YB` before rounding); powers of `1024` divide
 * exactly.
 * @param {number} bytes - A finite byte count
 * @param {number} base - `1000` or `1024`
 * @param {number} exponent - The unit's power of `base`
 * @returns {number} The count in that unit
 */
function inUnit(bytes: number, base: number, exponent: number): number {
	return base === 1000 ? Math.sign(bytes) * shiftDecimal(Math.abs(bytes), -3 * exponent) : bytes / Math.pow(base, exponent);
}

/**
 * Formats a byte count as a human-readable string, using SI units (`kB`, `MB`, …, powers of `1000`) by default,
 * or IEC binary units (`KiB`, `MiB`, …, powers of `1024`) with `{ base: 1024 }`.
 * The value is rounded with {@link round} to at most `decimals` places (trailing zeros are dropped), and moves up to the
 * next unit when rounding reaches the base (`999_999` → `'1 MB'`, not `'1000 kB'`). Negative values keep their sign.
 * Values beyond the largest unit (`YB` / `YiB`) are expressed in that unit.
 * @param {number} bytes - The number of bytes (may be negative or fractional)
 * @param {FormatBytesOptions} [options={}] - `decimals` (default `1`) and `base` (`1000` (default) or `1024`)
 * @returns {string} The formatted size, e.g. `'1.5 kB'`
 * @throws {RangeError} when `bytes` is not finite, `decimals` is not a non-negative integer, or `base` is not `1000` or `1024`
 * @throws {TypeError} when `bytes` or `decimals` is not a number
 * @example
 * formatBytes(0); // => '0 B'
 * formatBytes(1500); // => '1.5 kB'
 * formatBytes(1536, { base: 1024 }); // => '1.5 KiB'
 * formatBytes(1234567, { decimals: 2 }); // => '1.23 MB'
 * formatBytes(-2048, { base: 1024 }); // => '-2 KiB'
 */
export function formatBytes(bytes: number, options: FormatBytesOptions = {}): string {
	const { decimals = 1, base = 1000 } = options;
	assertNumber('formatBytes', 'bytes', bytes, Number.isFinite(bytes), 'a finite number');
	assertInteger('formatBytes', 'decimals', decimals);
	assertByteBase('formatBytes', base);

	const units = base === 1024 ? IEC_BYTE_UNITS : SI_BYTE_UNITS;
	const magnitude = Math.abs(bytes);
	let exponent = 0;
	while (exponent < units.length - 1 && magnitude >= Math.pow(base, exponent + 1)) exponent++;
	let value = round(inUnit(bytes, base, exponent), decimals);
	if (Math.abs(value) >= base && exponent < units.length - 1) {
		exponent++;
		value = round(inUnit(bytes, base, exponent), decimals);
	}
	// A template literal prints `-0` as "0", so tiny negative values do not print as "-0".
	return `${value} ${units[exponent]}`;
}

/**
 * Options accepted by {@link parseBytes}.
 */
export interface ParseBytesOptions {
	/**
	 * The multiple denoted by the SI symbols (`kB`/`KB`, `MB`, …): `1000` (SI, default) or `1024` (the JEDEC convention, as used by
	 * Windows and for memory sizes). IEC symbols (`KiB`, `MiB`, …) always denote powers of `1024`.
	 * @default 1000
	 */
	base?: 1000 | 1024;
}

/**
 * A byte size: a decimal number (optional minus sign, optional fraction and exponent) and an optional unit symbol, possibly
 * separated by whitespace, with whitespace around. The unit needs a letter, so the whitespace before and after it cannot be
 * split in several ways (matching is linear).
 */
const BYTES_REGEX = /^\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?:[eE]([+-]?\d+))?(?:\s*([A-Za-z]+))?\s*$/;

/**
 * Parses a human-readable byte size into a number of bytes: the strict inverse of {@link formatBytes}.
 *
 * The unit symbols are case-sensitive and exact: `B`, the SI symbols `kB` (or `KB`), `MB`, `GB`, `TB`, `PB`, `EB`, `ZB`, `YB`
 * (powers of `base`, `1000` by default) and the IEC symbols `KiB`, `MiB`, `GiB`, `TiB`, `PiB`, `EiB`, `ZiB`, `YiB` (always powers
 * of `1024`). A bare number is a number of bytes. Anything else (an unknown unit such as `'KiBs'`, bits such as `'Mb'`, a missing
 * number, trailing text) throws instead of being half-parsed: `bytes.parse('1KiB')` returns `1`, `parseBytes('1KiB')` returns `1024`.
 * Leading and trailing whitespace is ignored. SI multiples are applied to the decimal digits, so `parseBytes('1.1 kB') === 1100`
 * exactly (not `1100.0000000000002`). Fractional results are returned as-is (`'0.5 kB'` is `500`, `'1.5 B'` is `1.5`).
 *
 * `parseBytes(formatBytes(n, options), options)` is `n` rounded as `formatBytes` displays it, and
 * `formatBytes(parseBytes(text, options), options) === text` for every `text` that `formatBytes` produced with at most 15
 * significant digits (a double holds 15 to 17, so longer numbers may come back with a different last digit).
 * @param {string} value - The text to parse, e.g. `'1.5 MB'`, `'2KiB'` or `'512'`
 * @param {ParseBytesOptions} [options={}] - `base`: what the SI symbols denote, `1000` (default) or `1024`
 * @returns {number} The number of bytes
 * @throws {TypeError} when `value` is not a string
 * @throws {RangeError} when `value` is not a valid byte size, the result is not finite, or `base` is not `1000` or `1024`
 * @example
 * parseBytes('1.5 kB'); // => 1500
 * parseBytes('1 MiB'); // => 1_048_576
 * parseBytes('1KiB'); // => 1024
 * parseBytes('2 MB', { base: 1024 }); // => 2_097_152
 * parseBytes('-2 KiB'); // => -2048
 * parseBytes('512'); // => 512
 * parseBytes('1 Mb'); // throws RangeError (bits are not bytes)
 * parseBytes('12 apples'); // throws RangeError
 */
export function parseBytes(value: string, options: ParseBytesOptions = {}): number {
	const { base = 1000 } = options;
	assertByteBase('parseBytes', base);
	if (typeof value !== 'string') throw new TypeError(`parseBytes: \`value\` must be a string, got ${describe(value)}`);
	const match = BYTES_REGEX.exec(value);
	let bytes = NaN;
	if (match !== null) {
		const unit = match[3] === 'KB' ? 'kB' : match[3] || 'B';
		// `-1` for an unknown unit; the IEC symbols are the only ones with three letters.
		const power = Math.max(SI_BYTE_UNITS.indexOf(unit), IEC_BYTE_UNITS.indexOf(unit));
		const decimal = base === 1000 && unit.length < 3;
		// SI multiples go into the decimal exponent, so the text is converted to a double only once.
		if (power >= 0) bytes = Number(`${match[1]}e${Number(match[2] ?? 0) + (decimal ? 3 * power : 0)}`) * (decimal ? 1 : Math.pow(1024, power));
	}
	if (!Number.isFinite(bytes)) {
		const shown = value.length > 50 ? `${value.slice(0, 50)}…` : value;
		throw new RangeError(`parseBytes: \`value\` must be a finite byte size such as '1.5 MB' or '2 KiB', got ${JSON.stringify(shown)}`);
	}
	return bytes;
}

/**
 * Converts an integer to its English ordinal string (`1st`, `2nd`, `3rd`, `4th`, `11th`, `12th`, `13th`, `21st`, `112th`, …).
 * Negative integers keep their minus sign and take the suffix of their absolute value (`-1` → `'-1st'`, `-12` → `'-12th'`);
 * `-0` is treated as `0` (`'0th'`). Every integer is written out in full digits, even above `1e21` (no exponent notation).
 * @param {number} n - An integer
 * @returns {string} The number followed by its ordinal suffix
 * @throws {RangeError} when `n` is not an integer (including `NaN` and `±Infinity`)
 * @throws {TypeError} when `n` is not a number
 * @example
 * ordinal(1); // => '1st'
 * ordinal(22); // => '22nd'
 * ordinal(13); // => '13th'
 * ordinal(112); // => '112th'
 * ordinal(-3); // => '-3rd'
 */
export function ordinal(n: number): string {
	assertNumber('ordinal', 'n', n, Number.isInteger(n), 'an integer');
	const digits = BigInt(n).toString();
	const lastTwo = Number(digits.slice(-2).replace('-', ''));
	const last = lastTwo % 10;
	let suffix = 'th';
	if (lastTwo < 11 || lastTwo > 13) {
		if (last === 1) suffix = 'st';
		else if (last === 2) suffix = 'nd';
		else if (last === 3) suffix = 'rd';
	}
	return `${digits}${suffix}`;
}

/**
 * Computes the real `n`-th root of a number. Odd roots of negative numbers are negative (`nthRoot(-8, 3) === -2`),
 * even roots of negative numbers are `NaN`. Uses `Math.sqrt` / `Math.cbrt` for `n = 2` / `n = 3`, and otherwise snaps the
 * result to an integer `k` when `k ** n === |value|` exactly (so `nthRoot(16, 4) === 2`, not `1.9999999999999998`).
 * @param {number} value - The radicand
 * @param {number} n - The degree of the root, a positive integer
 * @returns {number} The real `n`-th root of `value`, or `NaN` when it does not exist
 * @throws {RangeError} when `n` is not a positive integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * nthRoot(27, 3); // => 3
 * nthRoot(-32, 5); // => -2
 * nthRoot(16, 4); // => 2
 * nthRoot(-16, 4); // => NaN
 */
export function nthRoot(value: number, n: number): number {
	assertInteger('nthRoot', 'n', n, 1);
	if (n === 2) return Math.sqrt(value);
	if (n === 3) return Math.cbrt(value);
	if (value < 0 && n % 2 === 0) return NaN;
	const magnitude = Math.abs(value);
	let root = Math.pow(magnitude, 1 / n);
	const nearest = Math.round(root);
	if (Math.pow(nearest, n) === magnitude) root = nearest;
	// `n = 1` and `±0` need no special case: the root is `|value|` and the sign (of a zero too) is restored here.
	return Math.sign(value) * root;
}

/**
 * Rounds a number to the nearest multiple of `step` (e.g. snapping to quarters with `step = 0.25`).
 * Like {@link round}, the computation works on decimal representations, so `roundToStep(0.3, 0.1) === 0.3`
 * (not `0.30000000000000004`), and ties are rounded half away from zero (`roundToStep(0.35, 0.1) === 0.4`).
 * Non-finite `value`s are returned as-is, as are values more than `2 ** 53` steps away from zero (already as close to a
 * multiple of `step` as their precision allows).
 * @param {number} value - The number to round
 * @param {number} step - The positive, finite step size
 * @returns {number} The multiple of `step` nearest to `value`
 * @throws {RangeError} when `step` is not a finite number greater than `0`
 * @throws {TypeError} when `step` is not a number
 * @example
 * roundToStep(1.13, 0.25); // => 1.25
 * roundToStep(7, 5); // => 5
 * roundToStep(-7.5, 5); // => -10
 * roundToStep(0.3, 0.1); // => 0.3
 */
export function roundToStep(value: number, step: number): number {
	assertNumber('roundToStep', 'step', step, step > 0 && step < Infinity, 'a finite number > 0');
	// Work on the magnitude and restore the sign at the end, exactly like `round` (ties away from zero, `-0` preserved).
	const negative = 1 / value < 0;
	const magnitude = Math.abs(value);
	const stepDecimals = Math.max(0, decimalPlaces(step));
	const shift = Math.max(decimalPlaces(magnitude), stepDecimals);
	const scaledValue = shiftDecimal(magnitude, shift);
	const scaledStep = shiftDecimal(step, shift);
	// Dividing the decimal-shifted integers avoids binary-fraction artefacts such as 0.35 / 0.1 === 3.4999999999999996. A shift that
	// overflows needs no fallback: an infinite `scaledValue` means far more than 2 ** 53 steps, and an infinite `scaledStep` (a step
	// vastly larger than the value) gives `0`, as `magnitude / step` would after rounding.
	const quotient = scaledValue / scaledStep;
	// Beyond 2 ** 53 steps, every double is already (within its own precision) a multiple of `step`. Non-finite values (whose
	// shifted string is `NaN`) are returned here too.
	if (!(quotient < 2 ** 53)) return value;
	// The number of steps. Below 2 ** 52 the quotient of the (exact) shifted integers is off by less than the distance from any
	// fraction `r / scaledStep` to one half, so `Math.round` is exact; from there on (and when the shifted value has more digits than a
	// double holds), divide the exact decimal integers instead, rounding half away from zero (the count itself is below 2 ** 53).
	let multiple = Math.round(quotient);
	if (scaledValue >= 2 ** 52) {
		const exactValue = scaledInteger(magnitude, shift);
		const exactStep = scaledInteger(step, shift);
		multiple = Number(exactValue / exactStep + (2n * (exactValue % exactStep) >= exactStep ? 1n : 0n));
	}
	// `multiple * step` in doubles can be off by an ulp, which reads as a non-multiple (`…480.36` for a step of 0.05): for a decimal
	// step (one that round-trips through 15 significant digits), the result is built from the digits of the exact decimal product
	// (correctly rounded by `Number`). Other steps are binary values (`1 / 3`), whose products are computed in binary.
	const rounded =
		Number(step.toPrecision(15)) === step ? Number(`${BigInt(multiple) * scaledInteger(step, stepDecimals)}e-${stepDecimals}`) : round(multiple * step, stepDecimals);
	return negative ? -rounded : rounded;
}

/**
 * The exact integer `value * 10 ** shift`, read from the decimal representation of `value` (`shift` is at least its number of
 * decimal places).
 * @param {number} value - A non-negative finite number
 * @param {number} shift - The power of ten, at least `decimalPlaces(value)`
 * @returns {bigint} The shifted value
 * @example
 * scaledInteger(1.25, 3); // => 1250n
 */
function scaledInteger(value: number, shift: number): bigint {
	const [mantissa, exponent = '0'] = String(value).split('e');
	const point = mantissa.indexOf('.');
	const digits = point === -1 ? mantissa : mantissa.slice(0, point) + mantissa.slice(point + 1);
	const fractionDigits = (point === -1 ? 0 : mantissa.length - point - 1) - Number(exponent);
	return BigInt(digits) * 10n ** BigInt(shift - fractionDigits);
}
