import { assertFunction, assertInteger, assertNumber, describe, draw, readOption, show } from '../utils/assert.js';
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
	return scaledSum(numbers, 1);
}

/**
 * The compensated (Neumaier) sum of `numbers` divided by `divisor`, the division being applied to the running total and to the
 * compensation separately: the sum itself for `divisor = 1`, and a mean as accurate as `averageBy`'s (from the arrays module) otherwise.
 * @param {ReadonlyArray<number>} numbers - The numbers to add up
 * @param {number} divisor - What the sum is divided by
 * @returns {number} The scaled sum (`total / divisor` alone when the total is not finite)
 */
function scaledSum(numbers: ReadonlyArray<number>, divisor: number): number {
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
	return Number.isFinite(total) ? total / divisor + compensation / divisor : total / divisor;
}

/**
 * Rounds a number to a given number of decimal places, using its decimal representation so that
 * values like `1.005` round as written (`round(1.005, 2) === 1.01`).
 *
 * Ties are rounded half **away from zero** (symmetrically): `round(2.5) === 3`, `round(-2.5) === -3`,
 * `round(-1.235, 2) === -1.24`. Note that this differs from `Math.round`, which rounds negative halves towards `+Infinity`.
 *
 * Negative `decimals` round to tens, hundreds, etc. Non-finite input (`NaN`, `±Infinity`) is returned as-is.
 * @param {number} input - The number to round (converted with unary `+`)
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
export function round(input: number, decimals = 0): number {
	assertNumber('round', 'decimals', decimals, Number.isInteger(decimals), 'an integer');
	// Converted once with unary `+`, like the aggregates: the result is a number whichever path computes it.
	const number = +input;
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
	if (!Number.isFinite(number) || signedDecimalPlaces(number) <= decimals) return number;
	// `1 / -0` is `-Infinity`.
	const negative = 1 / number < 0;
	const rounded = roundDecimalString(Math.abs(number), decimals);
	return negative ? -rounded : rounded;
}

/**
 * Rounds a positive finite number half up (or half to even) on its shortest decimal representation (the digits `String` shows), to
 * `decimals` places. The digits are rounded as text and converted once: shifting them into a double first would lose the first dropped
 * digit for values of `2 ** 51` and more once shifted (`3.0000000000000004` to 15 places would round up).
 * @param {number} value - A positive finite number with more than `decimals` decimal places
 * @param {number} decimals - The integer number of decimal places to keep (may be negative)
 * @param {boolean} [halfEven=false] - Whether an exact tie goes to the even neighbour instead of up
 * @returns {number} The double nearest to the rounded decimal
 * @example
 * roundDecimalString(3.0000000000000004, 15); // => 3
 */
function roundDecimalString(value: number, decimals: number, halfEven = false): number {
	const [mantissa, exponent = '0'] = String(value).split('e');
	const point = mantissa.indexOf('.');
	const digits = point === -1 ? mantissa : mantissa.slice(0, point) + mantissa.slice(point + 1);
	// The number of digits before the decimal point, in the full positional form of the value.
	const integerDigits = (point === -1 ? mantissa.length : point) + Number(exponent);
	const keep = integerDigits + decimals;
	// Every kept digit is beyond the ones of the value, and the first dropped one is a leading zero: it rounds to zero.
	if (keep < 0) return 0;
	let up = digits.charCodeAt(keep) >= 53;
	// An exact tie (a `5` followed by nothing but zeros) goes up only from an odd last kept digit (char codes have the parity of their
	// digits; with no kept digit, `NaN & 1` is `0`: the kept part is `0`, which is even).
	if (halfEven && digits.charCodeAt(keep) === 53 && !/[1-9]/.test(digits.slice(keep + 1))) up = (digits.charCodeAt(keep - 1) & 1) === 1;
	const kept = BigInt(digits.slice(0, keep) || '0') + (up ? 1n : 0n);
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
	const count = numbers.length;
	const mean = scaledSum(numbers, count);
	if (Number.isFinite(mean) || count === 0) return mean;
	// The sum overflowed (or an element is infinite, or overflowing terms met an infinite one as `Infinity - Infinity`): add up the terms
	// scaled by a power of two at most `1 / count` (exactly, as far as the result is concerned), which cannot overflow, then scale back.
	// Dividing each term by `count` instead rounds them all, and `average([M, M, M])` (with `M = Number.MAX_VALUE`) added up past `M`.
	const scale = 2 ** -Math.ceil(Math.log2(count));
	const scaled = scaledSum(
		numbers.map(function (value) {
			return +value * scale;
		}),
		count
	);
	// No mean of finite values exceeds the largest double, but the last rounding can push it there.
	return Number.isFinite(scaled) ? Math.min(Math.max(scaled / scale, -Number.MAX_VALUE), Number.MAX_VALUE) : scaled;
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
 * Finds the smallest and the largest value of some numbers in a single pass, with the semantics of {@link min} and {@link max}: elements
 * are converted once with unary `+`, any `NaN` makes both bounds `NaN`, and `-0` is smaller than `0`. Unlike `[min(xs), max(xs)]`, it
 * reads the numbers once, so it also works on a generator, and an empty input is `undefined` rather than `[Infinity, -Infinity]`.
 * @param {Iterable<number>} numbers - The numbers (an array or any iterable)
 * @returns {[number, number] | undefined} `[smallest, largest]`, or `undefined` when there are no numbers
 * @example
 * extent([3, 1, 4, 1, 5]); // => [1, 5]
 * extent(new Set([2])); // => [2, 2]
 * extent([]); // => undefined
 * extent([1, NaN]); // => [NaN, NaN]
 */
export function extent(numbers: Iterable<number>): [number, number] | undefined {
	let low = Infinity;
	let high = -Infinity;
	let empty = true;
	for (const item of numbers) {
		const value = +item;
		if (value !== value) return [NaN, NaN];
		empty = false;
		if (value < low || (low === 0 && Object.is(value, -0))) low = value;
		if (value > high || (value === 0 && Object.is(high, -0))) high = value;
	}
	return empty ? undefined : [low, high];
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
function roundDirected(caller: string, method: (value: number) => number, input: number, decimals: number): number {
	assertNumber(caller, 'decimals', decimals, Number.isInteger(decimals), 'an integer');
	// Converted once (see `round`).
	const number = +input;
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
 *
 * When the bounds cross (`minimum > maximum`), `minimum` wins, as in CSS `clamp(MIN, VAL, MAX)` and lodash: layout code computes
 * bounds such as `[0, containerWidth - panelWidth]` that cross before the first layout, or when the content is wider than its container.
 * @param {number} value - The value to clamp
 * @param {number} minimum - Lower bound (it wins over `maximum` when they cross)
 * @param {number} maximum - Upper bound
 * @returns {number} `minimum` if `value < minimum` (or the bounds cross), `maximum` if `value > maximum`, otherwise `value`
 * @throws {RangeError} when a bound is `NaN`
 * @throws {TypeError} when a bound is not a number
 * @example
 * clamp(15, 0, 10); // => 10
 * clamp(-5, 0, 10); // => 0
 * clamp(5, 0, 10); // => 5
 * Object.is(clamp(-0, 0, 10), -0); // => true
 * const containerWidth = 0; // before the first layout
 * clamp(120, 0, containerWidth - 300); // => 0
 */
export function clamp(value: number, minimum: number, maximum: number): number {
	assertNumber('clamp', 'minimum', minimum, true, 'a number');
	assertNumber('clamp', 'maximum', maximum, true, 'a number');
	if (Number.isNaN(minimum) || Number.isNaN(maximum)) throw new RangeError(`clamp: \`${Number.isNaN(minimum) ? 'minimum' : 'maximum'}\` must not be NaN`);
	// Plain comparisons, not Math.min/Math.max: an in-range value is returned as is (`-0` stays `-0`), and `NaN` compares false. `maximum`
	// is applied first, so `minimum` wins when the bounds cross.
	const capped = value > maximum ? maximum : value;
	return capped < minimum ? minimum : capped;
}

/**
 * Wraps a value cyclically into the half-open range `[minimum, maximum)`, for angles (`wrap(370, 0, 360) === 10`), carousel or ring-buffer
 * indices (`wrap(-1, 0, 5) === 4`) and other periodic quantities: the result is the value of the range congruent to `value` modulo
 * `maximum - minimum` (the Euclidean remainder, shifted to `minimum`). Unlike {@link clamp}, out-of-range values come back in from the other
 * side, and `maximum` itself wraps to `minimum`.
 *
 * A value already in range is returned as is (`-0` included). Otherwise the remainders are taken with `%`, which is exact, so integers stay
 * exact and neither the distance to `minimum` nor the span overflows; when the exact result is so close to `maximum` that it rounds to it,
 * `minimum`, the congruent value nearest on the circle, is returned (as {@link modulo} does), so the result is always below `maximum`.
 * `NaN` and `±Infinity` give `NaN`.
 * @param {number} value - The value to wrap
 * @param {number} minimum - Inclusive lower bound
 * @param {number} maximum - Exclusive upper bound
 * @returns {number} The value of `[minimum, maximum)` congruent to `value`
 * @throws {RangeError} when a bound is not finite, or `minimum >= maximum`
 * @throws {TypeError} when a bound is not a number
 * @example
 * wrap(370, 0, 360); // => 10
 * wrap(-10, 0, 360); // => 350
 * wrap(190, -180, 180); // => -170
 * wrap(5, 0, 5); // => 0
 * wrap(-1, 0, 5); // => 4
 * wrap(1, 3, 3); // throws RangeError
 */
export function wrap(value: number, minimum: number, maximum: number): number {
	assertNumber('wrap', 'minimum', minimum, Number.isFinite(minimum), 'a finite number');
	assertNumber('wrap', 'maximum', maximum, Number.isFinite(maximum), 'a finite number');
	if (!(minimum < maximum)) throw new RangeError(`wrap: \`minimum\` must be less than \`maximum\`, got ${minimum} and ${maximum}`);
	if (value >= minimum && value < maximum) return value;
	const span = maximum - minimum;
	// The span exceeds `Number.MAX_VALUE` (so the bounds are huge and the value out of range is too): halving all three is exact.
	if (span === Infinity) return 2 * wrap(value / 2, minimum / 2, maximum / 2);
	// `(value - minimum) mod span`, from the exact remainders of both (subtracting first could overflow, or lose the digits of a small
	// `minimum` next to a large `value`).
	const result = minimum + modulo((value % span) - (minimum % span), span);
	// `NaN` (for a value that is not finite) fails the comparison and is returned.
	return result >= maximum ? minimum : result;
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
	return sortedMedian(sortedCopy(numbers));
}

/**
 * The median of numbers sorted by {@link sortedCopy} (see {@link median}).
 * @param {ArrayLike<number>} sorted - The sorted numbers
 * @returns {number} The median, or `NaN` if there are no numbers or one is `NaN`
 */
function sortedMedian(sorted: ArrayLike<number>): number {
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
	const sample = readOption(options, 'sample') === true;
	const [count, squaredDistance, allFinite] = welford(numbers, 1);
	const divisor = sample ? count - 1 : count;
	if (divisor <= 0 || !allFinite) return NaN;
	if (squaredDistance >= 0 && squaredDistance < Infinity) return squaredDistance / divisor;
	// The running sum of squared deviations (`n` times the variance) overflowed, or Welford's update turned that into `-Infinity` or
	// `NaN`: redo it on values scaled by 2 ** -600 (exact), then scale the variance back in two exact steps, so that only a variance
	// that really overflows is `Infinity`.
	return scaledVariance(numbers, divisor) * 2 ** 600 * 2 ** 600;
}

/**
 * The variance of `numbers` scaled by `2 ** -1200` (computed on the values scaled by `2 ** -600`, exactly), for variances that overflow.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {number} divisor - `n` or `n - 1`
 * @returns {number} The scaled variance
 */
function scaledVariance(numbers: ReadonlyArray<number>, divisor: number): number {
	return welford(numbers, 2 ** -600)[1] / divisor;
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
 * @returns {number} The standard deviation; `NaN` when the variance is undefined (see {@link variance}). It is finite for finite values, even
 * when the variance overflows
 * @example
 * standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]); // => 2
 * standardDeviation([1]); // => 0
 * standardDeviation([1], { sample: true }); // => NaN
 */
export function standardDeviation(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	const result = variance(numbers, options);
	if (result !== Infinity) return Math.sqrt(result);
	// The variance overflows although every value is finite, but its square root (at most half the range) does not: take the root of
	// the scaled variance, then scale back by 2 ** 600.
	return Math.sqrt(scaledVariance(numbers, readOption(options, 'sample') === true ? numbers.length - 1 : numbers.length)) * 2 ** 600;
}

/**
 * The statistics of paired samples that {@link covariance}, {@link correlation} and {@link linearRegression} derive their results from.
 */
interface PairedMoments {
	/** The number of pairs. */
	count: number;
	/** The mean of `xs`. */
	meanX: number;
	/** The mean of `ys`. */
	meanY: number;
	/** The power of two the values of `xs` are multiplied by in the sums (see {@link scaledSample}). */
	scaleX: number;
	/** The power of two the values of `ys` are multiplied by in the sums. */
	scaleY: number;
	/** The sum of the squared (scaled) deviations of `xs` from their mean. */
	sxx: number;
	/** The sum of the squared (scaled) deviations of `ys` from their mean. */
	syy: number;
	/** The sum of the products of the paired (scaled) deviations. */
	sxy: number;
}

/**
 * Converts a sample with unary `+` and multiplies it by a power of two that brings its largest magnitude close to `1` (by `1` when that is
 * `0` or not finite), between `2 ** -1000` and `2 ** 1000` so that it is a normal double. The scaling is exact (subnormal values become
 * normal), and the scaled values, their sums and their squares neither overflow nor underflow.
 * @param {ReadonlyArray<number>} numbers - The sample
 * @returns {[number[], number]} The scaled values and the scale
 */
function scaledSample(numbers: ReadonlyArray<number>): [number[], number] {
	const values = Array.from(numbers, function (value) {
		return +value;
	});
	let largest = 0;
	// `NaN` once a value is `NaN`.
	for (const value of values) largest = Math.max(largest, Math.abs(value));
	const scale = largest > 0 && largest < Infinity ? 2 ** Math.min(1000, Math.max(-1000, -Math.floor(Math.log2(largest)))) : 1;
	return [
		values.map(function (value) {
			return value * scale;
		}),
		scale
	];
}

/**
 * Computes the means and the centred sums of squares and products of paired samples: the means first (compensated, see {@link average}),
 * then the sums of the deviations from them, which is numerically stable (no catastrophic cancellation, unlike the textbook
 * `Σxy - n·x̄·ȳ`). Each sample is scaled by a power of two first (exactly), so that neither the deviations nor the sums overflow or
 * underflow, whatever the magnitude of the values: only a final result can. Values are converted with unary `+`.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<number>} xs - The first sample
 * @param {ReadonlyArray<number>} ys - The second sample, as long as `xs`
 * @returns {PairedMoments} The count, means, scales and sums
 * @throws {RangeError} when `xs` and `ys` have different lengths
 */
function pairedMoments(caller: string, xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): PairedMoments {
	const count = xs.length;
	if (count !== ys.length) throw new RangeError(`${caller}: \`xs\` and \`ys\` must have the same length, got ${count} and ${ys.length}`);
	const [x, scaleX] = scaledSample(xs);
	const [y, scaleY] = scaledSample(ys);
	const centreX = average(x);
	const centreY = average(y);
	let sumX = 0;
	let sumY = 0;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (let i = 0; i < count; i++) {
		const dx = x[i] - centreX;
		const dy = y[i] - centreY;
		sumX += dx;
		sumY += dy;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	// The corrected two-pass algorithm (Chan, Golub and LeVeque): the deviations from the rounded means add up to `n` times the rounding
	// error `e` of the mean instead of `0`, which adds `n·e²` to the sum of squares; subtracting `(Σd)² / n` takes it out again.
	return {
		count,
		meanX: centreX / scaleX,
		meanY: centreY / scaleY,
		scaleX,
		scaleY,
		sxx: sxx - (sumX * sumX) / count,
		syy: syy - (sumY * sumY) / count,
		sxy: sxy - (sumX * sumY) / count
	};
}

/**
 * The coefficient of determination of paired samples, `sxy² / (sxx · syy)` (which the scales do not change), capped at `1` against rounding.
 * @param {PairedMoments} moments - The paired moments
 * @returns {number} The squared correlation, in `[0, 1]` (`NaN` when a sample is constant)
 */
function determination(moments: PairedMoments): number {
	return Math.min((moments.sxy / moments.sxx) * (moments.sxy / moments.syy), 1);
}

/**
 * Computes the covariance of two paired samples: how they vary together, `Σ(x - x̄)(y - ȳ) / n`. By default the population covariance
 * (divide by `n`) is returned; pass `{ sample: true }` for the sample covariance (divide by `n - 1`), like {@link variance}, of which it is
 * the generalization (`covariance(xs, xs)` is `variance(xs)`, up to rounding). It is computed in two passes (compensated means, then the
 * centred products, corrected for the rounding of the means), so it stays accurate for data far from zero, where the one-pass
 * `Σxy / n - x̄ȳ` formula loses every digit, and on values scaled by powers of two, so that it only overflows or underflows when the
 * covariance itself does.
 * Values are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} xs - The first sample
 * @param {ReadonlyArray<number>} ys - The second sample, one value per value of `xs`
 * @param {VarianceOptions} [options={}] - `sample`: compute the sample covariance instead of the population one
 * @returns {number} The covariance; `NaN` for empty samples, for a sample covariance of fewer than 2 pairs, or if a value is not finite;
 * `±Infinity` when every value is finite but the covariance overflows
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * covariance([1, 2, 3, 4], [2, 4, 6, 8]); // => 2.5
 * covariance([1, 2, 3, 4], [2, 4, 6, 8], { sample: true }); // => 3.3333333333333335
 * covariance([1, 2, 3], [3, 2, 1]); // => -0.6666666666666666
 * covariance([], []); // => NaN
 * covariance([1, 2], [1]); // throws RangeError
 */
export function covariance(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	const sample = readOption(options, 'sample') === true;
	const moments = pairedMoments('covariance', xs, ys);
	const divisor = sample ? moments.count - 1 : moments.count;
	if (divisor <= 0) return NaN;
	// Scaled back by the smaller scale first: the intermediate result grows, so it cannot underflow before the final one does.
	return moments.sxy / divisor / Math.min(moments.scaleX, moments.scaleY) / Math.max(moments.scaleX, moments.scaleY);
}

/**
 * Computes the Pearson correlation coefficient of two paired samples: their covariance divided by the product of their standard deviations,
 * from `-1` (perfectly opposite linear relation) through `0` (no linear relation) to `1` (perfectly linear). The sums come from the same
 * stable two-pass computation as {@link covariance}, the coefficient is computed so that it neither overflows nor underflows, and it never
 * leaves `[-1, 1]` through rounding. Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} xs - The first sample
 * @param {ReadonlyArray<number>} ys - The second sample, one value per value of `xs`
 * @returns {number} The coefficient, in `[-1, 1]`; `NaN` for fewer than 2 pairs, when either sample is constant (the coefficient is
 * undefined), or if a value is not finite
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * correlation([1, 2, 3, 4], [2, 4, 6, 8]); // => 1
 * correlation([1, 2, 3], [3, 2, 1]); // => -1
 * correlation([1, 2, 3, 4], [1, 3, 2, 4]); // => 0.8
 * correlation([1, 2, 3], [5, 5, 5]); // => NaN
 */
export function correlation(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
	const moments = pairedMoments('correlation', xs, ys);
	const root = Math.sqrt(determination(moments));
	return moments.sxy < 0 ? -root : root;
}

/**
 * The result of {@link linearRegression}: the least-squares line `y = slope · x + intercept` and how well it fits.
 */
export interface LinearRegression {
	/** The slope of the line. */
	readonly slope: number;
	/** The value of the line at `x = 0`. */
	readonly intercept: number;
	/** The coefficient of determination R², in `[0, 1]`: the share of the variance of `ys` that the line explains. */
	readonly r2: number;
	/**
	 * The value of the line at `x`: `slope * x + intercept`, computed as `ȳ + slope * (x - x̄)` (the line through the means), which is
	 * more accurate far from zero (`intercept` can be large and rounded when the `xs` are timestamps).
	 * @param {number} x - A value of the independent variable
	 * @returns {number} The predicted value
	 */
	readonly predict: (x: number) => number;
}

/**
 * Fits a straight line through paired samples by ordinary least squares (simple linear regression of `ys` on `xs`), as
 * simple-statistics' `linearRegression` and `rSquared`, or Excel's `SLOPE`, `INTERCEPT` and `RSQ`, do. The slope is
 * `Σ(x - x̄)(y - ȳ) / Σ(x - x̄)²`, from the same stable two-pass sums as {@link covariance} (accurate for data far from zero, such as
 * timestamps), and the line goes through the means. `r2` is the squared {@link correlation}; when every `y` is the same, the horizontal
 * line fits every point exactly and `r2` is `1` (as in scikit-learn).
 * Values are converted once with unary `+`; a value that is not finite makes every field `NaN`.
 * @param {ReadonlyArray<number>} xs - The values of the independent variable
 * @param {ReadonlyArray<number>} ys - The observed values, one per value of `xs`
 * @returns {LinearRegression} `{ slope, intercept, r2, predict }`
 * @throws {RangeError} when `xs` and `ys` have different lengths, hold fewer than 2 points, or every `x` is the same (the slope is
 * undefined: the line would be vertical)
 * @example
 * const line = linearRegression([1, 2, 3, 4], [3, 5, 7, 9]);
 * [line.slope, line.intercept, line.r2]; // => [2, 1, 1]
 * line.predict(10); // => 21
 * linearRegression([1, 2, 3], [2, 1, 3]).slope; // => 0.5
 * linearRegression([1, 1], [2, 3]); // throws RangeError
 */
export function linearRegression(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): LinearRegression {
	const moments = pairedMoments('linearRegression', xs, ys);
	if (moments.count < 2) throw new RangeError(`linearRegression: \`xs\` and \`ys\` must hold at least 2 points, got ${moments.count}`);
	if (moments.sxx === 0) throw new RangeError('linearRegression: `xs` must not all be equal (the line would be vertical)');
	// The ratio of the scaled sums, scaled back.
	const slope = (moments.sxy / moments.sxx) * (moments.scaleX / moments.scaleY);
	const { meanX, meanY } = moments;
	const intercept = meanY - slope * meanX;
	return {
		slope,
		intercept,
		// Constant `ys` (and no `NaN` among the `xs`): every point is on the horizontal line.
		r2: moments.syy === 0 && moments.sxx === moments.sxx ? 1 : determination(moments),
		predict: function (x: number): number {
			return meanY + slope * (x - meanX);
		}
	};
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
 * signedDecimalPlaces(0.25); // => 2
 * signedDecimalPlaces(1e-7); // => 7
 * signedDecimalPlaces(1.5e22); // => -21
 */
function signedDecimalPlaces(value: number): number {
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
	return sortedQuantile(sortedCopy(numbers), q);
}

/**
 * The `q`-quantile of numbers sorted by {@link sortedCopy} (see {@link quantile}).
 * @param {ArrayLike<number>} sorted - The sorted numbers
 * @param {number} q - The quantile, in `[0, 1]`
 * @returns {number} The quantile, or `NaN` if there are no numbers or one is `NaN`
 */
function sortedQuantile(sorted: ArrayLike<number>, q: number): number {
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
 * Computes the interquartile range of an array of numbers, the spread of their middle half: `quantile(numbers, 0.75) -
 * quantile(numbers, 0.25)`, with the same interpolation as {@link quantile} (R type 7, Excel's `QUARTILE.INC`), but sorting only once.
 * The input is not mutated, and elements are converted once with unary `+` (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {number} The interquartile range, or `NaN` if the array is empty or contains `NaN`
 * @example
 * interquartileRange([1, 2, 3, 4, 5, 6, 7, 8]); // => 3.5
 * interquartileRange([7, 7, 7]); // => 0
 * interquartileRange([]); // => NaN
 */
export function interquartileRange(numbers: ReadonlyArray<number>): number {
	const sorted = sortedCopy(numbers);
	return sortedQuantile(sorted, 0.75) - sortedQuantile(sorted, 0.25);
}

/**
 * Computes the standard score of a value: how many standard deviations it lies above (positive) or below (negative) the mean,
 * `(value - mean) / standardDeviation`. Pass the mean and standard deviation of the reference population (see {@link average} and
 * {@link standardDeviation}).
 * @param {number} value - The value to score
 * @param {number} mean - The mean of the population
 * @param {number} deviation - Its standard deviation, a number `> 0`
 * @returns {number} The z-score
 * @throws {RangeError} when `deviation` is not greater than `0` (including `NaN`)
 * @throws {TypeError} when `deviation` is not a number
 * @example
 * zScore(130, 100, 15); // => 2
 * zScore(85, 100, 15); // => -1
 * zScore(1, 0, 0); // throws RangeError
 */
export function zScore(value: number, mean: number, deviation: number): number {
	assertNumber('zScore', 'deviation', deviation, deviation > 0, 'a number > 0');
	return (value - mean) / deviation;
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
export function approximatelyEqual(a: number, b: number, options?: ApproximatelyEqualOptions): boolean {
	// Often called in loops: read inline (see `readOption`), and not at all without options.
	let relative = options === undefined ? undefined : options.relative;
	if (relative === undefined || (relative === (Object.prototype as ApproximatelyEqualOptions).relative && !Object.hasOwn(options as object, 'relative'))) relative = 1e-9;
	let absolute = options === undefined ? undefined : options.absolute;
	if (absolute === undefined || (absolute === (Object.prototype as ApproximatelyEqualOptions).absolute && !Object.hasOwn(options as object, 'absolute'))) absolute = 0;
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
	// Each weight is read and converted once: the values validated are the values used.
	const checkedWeights: number[] = [];
	for (let i = 0; i < weights.length; i++) {
		const raw = weights[i];
		const weight = typeof raw === 'number' ? raw : +raw;
		if (!(weight >= 0 && weight < Infinity)) assertNumber('weightedAverage', `weights[${i}]`, raw, false, 'a finite number >= 0');
		checkedWeights.push(weight);
		largestWeight = Math.max(largestWeight, weight);
	}
	// Rescaling the weights into [0, 1] keeps the products and the total weight from overflowing or underflowing. A zero total weight
	// (including empty arrays) needs no special case: `0 / 0` makes every scaled weight, and so the result, `NaN`.
	const scaledWeights = checkedWeights.map(function (weight) {
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

/** What every ratio of {@link allocate} must be. */
const ALLOCATE_RATIO = 'a finite number >= 0 or a bigint >= 0';

/**
 * Splits an integer amount (cents, items, seats) in proportion to some ratios, without losing or creating a single unit: the shares always
 * add up to exactly `total`. Each share is its exact quota `total * ratio / Σ ratios` rounded down or up (never off by 1 or more), by the
 * largest remainder (Hamilton) method: every share gets the integer part of its quota, then the units left over go, one each, to the shares
 * with the largest fractional parts, ties going to the earlier index. The arithmetic is exact (in `BigInt`, with the ratios read as the exact
 * fractions their doubles hold), so `[1, 1, 1]`, `[0.1, 0.1, 0.1]` and `[1n, 1n, 1n]` split alike, and no rounding error can make a remainder
 * win or lose a unit. Unlike dinero.js' `allocate`, which hands the leftover units to the first shares in order, a unit always goes where
 * the quota is closest to the next integer.
 *
 * A negative `total` is split like its absolute value, with every share negated (`allocate(-total, r)` is `allocate(total, r)` negated). A
 * zero ratio always gets `0`. A `bigint` total gives `bigint` shares, for amounts beyond `Number.MAX_SAFE_INTEGER`.
 * @param {number | bigint} total - The amount to split: a safe integer, or a bigint
 * @param {ReadonlyArray<number | bigint>} ratios - One finite, non-negative weight per share (numbers, bigints or both), not all zero; only
 * their proportions matter (`[70, 20, 10]` splits like `[0.7, 0.2, 0.1]`)
 * @returns {Array<number | bigint>} The shares, one per ratio, in order, of the same type as `total`
 * @throws {TypeError} when `total` is neither a number nor a bigint, `ratios` is not an array, or a ratio is neither a number nor a bigint
 * @throws {RangeError} when `total` is not a safe integer, a ratio is negative or not finite, or every ratio is zero (including no ratios)
 * @example
 * allocate(100, [1, 1, 1]); // => [34, 33, 33]
 * allocate(1000, [70, 20, 10]); // => [700, 200, 100]
 * allocate(5, [0.5, 0.25, 0.25]); // => [3, 1, 1]
 * allocate(-100, [1, 1, 1]); // => [-34, -33, -33]
 * allocate(10, [1, 0, 2]); // => [3, 0, 7]
 * allocate(10n ** 20n, [1, 2]); // => [33333333333333333333n, 66666666666666666667n]
 * allocate(100, [0, 0]); // throws RangeError
 */
export function allocate(total: number, ratios: ReadonlyArray<number | bigint>): number[];
/**
 * {@link allocate} for a `bigint` total: the shares are bigints.
 * @param {bigint} total - The amount to split
 * @param {ReadonlyArray<number | bigint>} ratios - One finite, non-negative weight per share, not all zero
 * @returns {bigint[]} The shares, one per ratio, adding up to exactly `total`
 * @example
 * allocate(5n, [1, 1]); // => [3n, 2n]
 */
export function allocate(total: bigint, ratios: ReadonlyArray<number | bigint>): bigint[];
/**
 * Splits an integer amount in proportion to some ratios without losing or creating a unit (see the overloads).
 * @param {number | bigint} total - The amount to split: a safe integer, or a bigint
 * @param {ReadonlyArray<number | bigint>} ratios - One finite, non-negative weight per share, not all zero
 * @returns {Array<number | bigint>} The shares, of the same type as `total`
 * @throws {TypeError} when `total` is neither a number nor a bigint, `ratios` is not an array, or a ratio is neither a number nor a bigint
 * @throws {RangeError} when `total` is not a safe integer, a ratio is negative or not finite, or every ratio is zero
 * @example
 * allocate(7, [1, 1]); // => [4, 3]
 */
export function allocate(total: number | bigint, ratios: ReadonlyArray<number | bigint>): Array<number | bigint> {
	const big = typeof total === 'bigint';
	if (!big) assertNumber('allocate', 'total', total, Number.isSafeInteger(total), 'a safe integer or a bigint');
	if (!Array.isArray(ratios)) throw new TypeError(`allocate: \`ratios\` must be an array, got ${describe(ratios)}`);
	// Each ratio as an integer times a power of two (`mantissas[i] * 2 ** exponents[i]`), the exact value of its double.
	const mantissas: bigint[] = [];
	const exponents: number[] = [];
	let lowest = 0;
	for (let i = 0; i < ratios.length; i++) {
		// Read once: the value validated is the value used.
		let ratio: unknown = ratios[i];
		let exponent = 0;
		if (typeof ratio === 'bigint') {
			if (ratio < 0n) throw new RangeError(`allocate: \`ratios[${i}]\` must be ${ALLOCATE_RATIO}, got ${ratio}`);
		} else {
			assertNumber('allocate', `ratios[${i}]`, ratio, typeof ratio === 'number' && ratio >= 0 && ratio < Infinity, ALLOCATE_RATIO);
			// Doubling a double is exact, and after at most 1074 doublings any finite double is an integer.
			for (; !Number.isInteger(ratio); exponent--) ratio *= 2;
			ratio = BigInt(ratio);
		}
		mantissas.push(ratio as bigint);
		exponents.push(exponent);
		lowest = Math.min(lowest, exponent);
	}
	// The ratios over their common denominator `2 ** -lowest`: integers in the same proportions.
	let denominator = 0n;
	const weights = mantissas.map(function (mantissa, index) {
		const weight = mantissa << BigInt(exponents[index] - lowest);
		denominator += weight;
		return weight;
	});
	if (denominator === 0n) throw new RangeError('allocate: `ratios` must contain a ratio > 0');
	const amount = BigInt(total);
	const magnitude = amount < 0n ? -amount : amount;
	// Every quota `magnitude * weight / denominator`, split into its integer part (the share so far) and its remainder (its fraction, times
	// `denominator`).
	let left = magnitude;
	const remainders: bigint[] = [];
	const shares = weights.map(function (weight) {
		const scaled = magnitude * weight;
		const share = scaled / denominator;
		remainders.push(scaled % denominator);
		left -= share;
		return share;
	});
	// `left` units remain (fewer than there are shares with a remainder): one each to the largest remainders, the earlier first on a tie (the
	// sort is stable).
	const order = shares.map(function (_share, index) {
		return index;
	});
	order.sort(function (a, b) {
		return remainders[a] < remainders[b] ? 1 : remainders[a] > remainders[b] ? -1 : 0;
	});
	for (let i = 0; i < left; i++) shares[order[i]]++;
	return shares.map(function (share) {
		const signed = amount < 0n ? -share : share;
		return big ? signed : Number(signed);
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
	const decimals = readOption(options, 'decimals', 1);
	const base = readOption(options, 'base', 1000);
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
	const base = readOption(options, 'base', 1000);
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
		// (`BigInt` writes the exponent in full: a number of 1e21 or more would print as `1e+21`.)
		if (power >= 0) bytes = Number(`${match[1]}e${BigInt(match[2] ?? 0) + BigInt(decimal ? 3 * power : 0)}`) * (decimal ? 1 : Math.pow(1024, power));
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
	const stepDecimals = Math.max(0, signedDecimalPlaces(step));
	const shift = Math.max(signedDecimalPlaces(magnitude), stepDecimals);
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
 * @param {number} shift - The power of ten, at least `signedDecimalPlaces(value)`
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

/**
 * Rounds a number to `digits` significant figures. Like {@link round}, it works on the decimal representation (the shortest one that
 * `String` writes), so values round as written (`toSignificant(1.005, 3) === 1.01`, where `Number((1.005).toPrecision(3))` is `1`) and
 * ties are rounded half away from zero (`toSignificant(-2.5, 1) === -3`). The result is the double nearest to the rounded decimal, so it
 * prints without noise (`toSignificant(0.000123456, 3)` is `0.000123`, not `0.00012300000000000001`).
 *
 * `±0`, `NaN` and `±Infinity` are returned as-is, as is a number that already has at most `digits` significant digits (doubles never need
 * more than 17). Like {@link round}, a number that rounds up past `Number.MAX_VALUE` gives `±Infinity` (only the very largest doubles do:
 * `toSignificant(1.7976931348623157e308, 1)` is `2e308`).
 * @param {number} input - The number to round (converted with unary `+`)
 * @param {number} digits - The number of significant digits to keep, an integer from 1 to 100 (the range of `toPrecision`)
 * @returns {number} The rounded number
 * @throws {RangeError} when `digits` is not an integer between 1 and 100
 * @throws {TypeError} when `digits` is not a number
 * @example
 * toSignificant(123456, 2); // => 120000
 * toSignificant(0.000123456, 3); // => 0.000123
 * toSignificant(-9.96, 2); // => -10
 * toSignificant(1.005, 3); // => 1.01 // as written: (1.005).toPrecision(3) is '1.00'
 * toSignificant(2.5, 1); // => 3
 * toSignificant(1.5, 0); // throws RangeError
 */
export function toSignificant(input: number, digits: number): number {
	assertNumber('toSignificant', 'digits', digits, Number.isInteger(digits) && digits >= 1 && digits <= 100, 'an integer between 1 and 100');
	// Converted once with unary `+`, like `round`.
	const number = +input;
	if (number === 0 || !Number.isFinite(number)) return number;
	const magnitude = Math.abs(number);
	// Fast path (see `round`): away from powers of ten, `floor(log10)` is the power of the first significant digit, of the value and of
	// its shortest decimal form alike (they only differ within half an ulp of a power of ten). Scaling by an exact power of ten is then
	// within a few ulps of the decimal shift, so unless the scaled value lies within a safety margin of a `.5` tie, it rounds to the same
	// integer `k`, and `k` scaled back (a correctly rounded division or product) is the double nearest to the rounded decimal.
	const logarithm = Math.log10(magnitude);
	const power = Math.floor(logarithm);
	const shift = digits - 1 - power;
	if (logarithm - power > 1e-12 && power + 1 - logarithm > 1e-12 && shift >= -22 && shift <= 22) {
		const factor = POWERS_OF_TEN[Math.abs(shift)];
		const scaled = shift >= 0 ? magnitude * factor : magnitude / factor;
		if (Math.abs(scaled - Math.floor(scaled) - 0.5) > scaled * 2 ** -46) {
			const fast = shift >= 0 ? Math.round(scaled) / factor : Math.round(scaled) * factor;
			return number < 0 ? -fast : fast;
		}
	}
	const [mantissa, exponent = '0'] = String(magnitude).split('e');
	const point = mantissa.indexOf('.');
	const digitString = point === -1 ? mantissa : mantissa.slice(0, point) + mantissa.slice(point + 1);
	// The number of digits before the decimal point in the full positional form, and the power of ten of the first significant digit
	// (`0.000123` is written `0.000123`: one integer digit, then four zeros before the `1`).
	const integerDigits = (point === -1 ? mantissa.length : point) + Number(exponent);
	const leading = integerDigits - 1 - digitString.search(/[1-9]/);
	const decimals = digits - 1 - leading;
	// Already at most `digits` significant digits (`roundDecimalString` needs a digit to drop).
	if (digitString.length - integerDigits <= decimals) return number;
	const rounded = roundDecimalString(magnitude, decimals);
	return number < 0 ? -rounded : rounded;
}

/**
 * An exact sum of finite doubles: Shewchuk's non-overlapping partials, in increasing magnitude, plus a count of `2 ** 1024` carried out
 * of them on overflow, so that the sum is `overflow * 2 ** 1024 + Σ partials` (the representation of the TC39 `Math.sumPrecise` polyfill).
 */
interface ExactSum {
	/** Non-overlapping doubles, in increasing magnitude, none of them zero (the first `size` items; the array is not shrunk). */
	partials: number[];
	/** How many partials there are. */
	size: number;
	/** How many times `2 ** 1024` was carried out of the partials (negative for `-2 ** 1024`). */
	overflow: number;
}

/**
 * Adds a finite double to an exact sum (Shewchuk's `grow-expansion`, as in Python's `math.fsum`). When two partials add up beyond
 * `Number.MAX_VALUE`, `2 ** 1024` is moved (exactly, in two halves) from the larger one into `total.overflow`, so nothing is lost.
 * @param {ExactSum} total - The exact sum, updated in place
 * @param {number} value - A finite double
 * @returns {void}
 */
function addExact(total: ExactSum, value: number): void {
	const partials = total.partials;
	let x = value;
	let used = 0;
	for (let i = 0, size = total.size; i < size; i++) {
		let y = partials[i];
		if (Math.abs(x) < Math.abs(y)) {
			y = x;
			x = partials[i];
		}
		let high = x + y;
		if (Math.abs(high) === Infinity) {
			// `x` and `y` have the same sign and `|x| >= 2 ** 1023`, so both subtractions are exact.
			const sign = high > 0 ? 1 : -1;
			total.overflow += sign;
			x = x - sign * 2 ** 1023 - sign * 2 ** 1023;
			if (Math.abs(x) < Math.abs(y)) {
				const larger = y;
				y = x;
				x = larger;
			}
			high = x + y;
		}
		// Fast two-sum (`|x| >= |y|`): `low` is the exact rounding error of `high`.
		const low = y - (high - x);
		if (low !== 0) partials[used++] = low;
		x = high;
	}
	if (x !== 0) partials[used++] = x;
	// Tracking the size is about twice as fast as shrinking the array.
	total.size = used;
}

/**
 * Rounds an exact sum to the nearest double (ties to even), `±Infinity` when it is beyond the doubles. The sum is not modified.
 * @param {ExactSum} total - The exact sum
 * @returns {number} The correctly rounded sum (`+0` for an exact zero)
 */
function roundExact(total: ExactSum): number {
	let partials = total.partials;
	const overflow = total.overflow;
	let n = total.size - 1;
	let high = 0;
	let low = 0;
	if (overflow !== 0) {
		const next = n >= 0 ? partials[n] : 0;
		n--;
		// The partials add up to less than `2 ** 1024` in magnitude: beyond one carry, or with the largest partial of the same sign, the
		// sum is out of range.
		if (Math.abs(overflow) > 1 || next * overflow > 0) return overflow * Infinity;
		// `overflow * 2 ** 1024 + next`, halved to stay in range (exactly, by a two-sum), then doubled back.
		high = overflow * 2 ** 1023 + next / 2;
		low = (next / 2 - (high - overflow * 2 ** 1023)) * 2;
		if (Math.abs(high * 2) === Infinity) {
			// `2 ** 1024 - 2 ** 970` (half an ulp above `Number.MAX_VALUE`) rounds to even, so to Infinity, unless the rest of the sum
			// pulls it below the tie.
			const belowTie = high === overflow * 2 ** 1023 && low === -overflow * 2 ** 970 && n >= 0 && partials[n] * overflow < 0;
			return overflow * (belowTie ? Number.MAX_VALUE : Infinity);
		}
		if (low !== 0) {
			partials = partials.slice(0, n + 1);
			partials.push(low);
			n++;
			low = 0;
		}
		high *= 2;
	}
	// Add the partials from the largest down, until one is not absorbed exactly: the rest cannot change the rounding, except at a tie.
	while (n >= 0) {
		const x = high;
		const y = partials[n--];
		high = x + y;
		low = y - (high - x);
		if (low !== 0) break;
	}
	// `low` is half an ulp of `high` (a tie) and the next partial has the same sign: the exact sum is beyond the tie, round away.
	// (Signs are compared, not multiplied: the product of two tiny partials underflows to 0.)
	if (n >= 0 && low !== 0 && low < 0 === partials[n] < 0) {
		const doubled = low * 2;
		const away = high + doubled;
		if (away - high === doubled) high = away;
	}
	return high;
}

/** The type of the native `Math.sumPrecise` (ES2026). */
type SumPrecise = (items: Iterable<number>) => number;

/**
 * The native `Math.sumPrecise` once it passed the check of {@link nativeSumPrecise}, `null` when it is missing or failed it, `undefined`
 * before the first call.
 */
let checkedSumPrecise: SumPrecise | null | undefined;

/**
 * Sums that only an exact implementation of `Math.sumPrecise` gets right, with their results: an intermediate overflow, subnormals (whose
 * sum a scaled or extended-precision polyfill loses), a cancellation beyond the precision of a double, a rounding decided by a part 36
 * orders of magnitude smaller (which compensated summation such as Kahan's or Neumaier's, and fixed-size double-double sums, get wrong),
 * the `-0` of an empty sum, and `NaN` for opposite infinities.
 */
const SUM_PRECISE_PROBES: ReadonlyArray<readonly [number[], number]> = [
	[[1e308, 1e308, -1e308], 1e308],
	[[5e-324, 5e-324, 5e-324], 1.5e-323],
	[[1, 1e100, 1, -1e100], 2],
	[[1, 1e-20, -1e16], -9999999999999998],
	[[], -0],
	[[Infinity, -Infinity], NaN]
];

/**
 * Returns the runtime's `Math.sumPrecise` when it gets every one of {@link SUM_PRECISE_PROBES} right. Requiring a native (built-in)
 * function instead would be no safer (a polyfill can claim to be native through `toString`), and would refuse a correct polyfill. A
 * function that passes is exact on the cases where inexact algorithms differ; its results are then the same as {@link sumPrecise}'s own.
 * @returns {SumPrecise | null} The function, or `null`
 */
function nativeSumPrecise(): SumPrecise | null {
	if (checkedSumPrecise === undefined) {
		const candidate = (Math as { sumPrecise?: unknown }).sumPrecise;
		checkedSumPrecise = null;
		try {
			const works =
				typeof candidate === 'function' &&
				SUM_PRECISE_PROBES.every(function ([items, expected]) {
					return Object.is(candidate(items), expected);
				});
			if (works) checkedSumPrecise = candidate as SumPrecise;
		} catch {
			// A replacement that throws is not used.
		}
	}
	return checkedSumPrecise;
}

/**
 * Adds up numbers exactly, then rounds once: the result is the double nearest to the true sum (ties to even), whatever the order of the
 * numbers and however much they cancel. This is TC39 `Math.sumPrecise` (ES2026), with its semantics, and Python's `math.fsum`, minus its
 * `OverflowError`: intermediate sums beyond `Number.MAX_VALUE` are carried exactly (`sumPrecise([1e308, 1e308, -1e308])` is `1e308`).
 * Where the runtime has a native `Math.sumPrecise` (checked once), it adds up arrays and typed arrays, with the same results.
 *
 * Unlike {@link sum}, which is compensated (its error is tiny, but can show in the last digit, typically when the true sum lies near a
 * tie between two doubles), the result is exact up to that final rounding. Like `Math.sumPrecise`, and also unlike {@link sum}, nothing is
 * converted: every item must be a number.
 * - An empty iterable, or only `-0`s, give `-0` (the identity of addition); any other zero sum is `+0`.
 * - Any `NaN`, or both `Infinity` and `-Infinity`, give `NaN`; otherwise an infinity gives that infinity.
 * - A finite sum beyond the doubles gives `±Infinity`.
 *
 * Exactness costs time: in the order of 20 times as long as {@link sum} on everyday data. Each number goes through the partials of the
 * exact sum (Shewchuk's algorithm), usually one to three of them; numbers spread over the whole range of doubles can make that a hundred.
 * @param {Iterable<number>} numbers - The numbers to add up (any iterable: an array, a typed array, a generator...)
 * @returns {number} The correctly rounded sum
 * @throws {TypeError} when `numbers` is not iterable or an item is not a number
 * @example
 * sumPrecise([0.1, 0.2, 0.3]); // => 0.6
 * sumPrecise([1, 1e-20, -1e16]); // => -9999999999999998 // sum gives -10000000000000000
 * sumPrecise([1e308, 1e308, -1e308]); // => 1e308
 * sumPrecise([]); // => -0
 * sumPrecise(new Set([1, 2, 3])); // => 6
 * sumPrecise(['1'] as never); // throws TypeError
 */
export function sumPrecise(numbers: Iterable<number>): number {
	if (numbers == null || typeof (numbers as Partial<Iterable<number>>)[Symbol.iterator] !== 'function') {
		throw new TypeError(`sumPrecise: \`numbers\` must be an iterable, got ${describe(numbers)}`);
	}
	// The native function adds up arrays (and typed arrays): copying their items, once validated, keeps this function's error messages and
	// reads each item once. Other iterables (generators, sets...) are streamed through the partials instead, without a copy.
	const native = Array.isArray(numbers) || ArrayBuffer.isView(numbers) ? nativeSumPrecise() : null;
	const items: number[] = [];
	const total: ExactSum = { partials: [], size: 0, overflow: 0 };
	// `0` while every item is finite, else the sum of the infinite ones so far (`NaN` once a `NaN` or opposite infinities were seen).
	let infinite = 0;
	let negativeZero = true;
	let index = 0;
	for (const value of numbers) {
		if (typeof value !== 'number') throw new TypeError(`sumPrecise: \`numbers[${index}]\` must be a number, got ${describe(value)}`);
		index++;
		if (native !== null) {
			items.push(value);
		} else if (value - value !== 0) {
			// `Infinity - Infinity` and `NaN - NaN` are `NaN`.
			infinite += value;
		} else {
			if (value !== 0 || 1 / value > 0) negativeZero = false;
			// Once the sum is infinite (or `NaN`), the finite items cannot change it, but they still have to be numbers.
			if (value !== 0 && infinite === 0) addExact(total, value);
		}
	}
	if (native !== null) return native(items);
	if (infinite !== 0) return infinite;
	return negativeZero ? -0 : roundExact(total);
}

/**
 * Computes the simple moving average of a series: the mean of every run of `window` consecutive values, in order. The result has
 * `values.length - window + 1` elements (`[]` when there are fewer values than `window`), like pandas' `rolling(window).mean()` without
 * its leading `NaN`s, and is computed in O(n), each value being added to and removed from a running sum once.
 *
 * The running sum is kept exactly (see {@link sumPrecise}), so there is no drift: each average is the window's exact sum, rounded once,
 * divided by `window`, i.e. exactly `sumPrecise(window values) / window`, however long the series and whatever left the window before
 * (`movingAverage([1e20, 1, 2, 3], 2)` ends with `2.5`, where an incremental float sum gives `0`). A `NaN` or an infinity only affects the
 * windows that hold it (an incremental sum stays `NaN` forever), and windows whose sum exceeds `Number.MAX_VALUE` still get their finite
 * average, rounded the same way (the exact sum, scaled down by a power of two, rounded once, divided by `window`).
 * Values are converted once with unary `+`, like the other aggregates (numeric strings count as numbers).
 * @param {ReadonlyArray<number>} values - The series
 * @param {number} window - The number of values per average, a positive integer
 * @returns {number[]} The averages, one per window position
 * @throws {RangeError} when `window` is not a positive integer
 * @throws {TypeError} when `window` is not a number
 * @example
 * movingAverage([1, 2, 3, 4, 5], 3); // => [2, 3, 4]
 * movingAverage([1, 2], 3); // => []
 * movingAverage([1e20, 1, 2, 3], 2); // => [5e19, 1.5, 2.5]
 * movingAverage([1, NaN, 3, 4], 2); // => [NaN, NaN, 3.5]
 * movingAverage([1, 2, 3], 0); // throws RangeError
 */
export function movingAverage(values: ReadonlyArray<number>, window: number): number[] {
	assertInteger('movingAverage', 'window', window, 1);
	const count = values.length;
	const numbers = new Float64Array(count);
	for (let i = 0; i < count; i++) numbers[i] = +values[i];
	const result: number[] = [];
	const total: ExactSum = { partials: [], size: 0, overflow: 0 };
	// How many `NaN`s, infinities and negative zeros the window holds: they are kept out of the exact sum.
	let nans = 0;
	let positiveInfinities = 0;
	let negativeInfinities = 0;
	let negativeZeros = 0;
	/**
	 * Adds a value to the window, or removes it.
	 * @param {number} value - The value
	 * @param {number} sign - `1` to add it, `-1` to remove it
	 * @returns {void}
	 */
	function update(value: number, sign: number): void {
		if (value !== value) nans += sign;
		else if (value === Infinity) positiveInfinities += sign;
		else if (value === -Infinity) negativeInfinities += sign;
		else if (value !== 0) addExact(total, sign * value);
		else if (1 / value < 0) negativeZeros += sign;
	}
	for (let i = 0; i < count; i++) {
		update(numbers[i], 1);
		if (i >= window) update(numbers[i - window], -1);
		if (i < window - 1) continue;
		if (nans > 0 || (positiveInfinities > 0 && negativeInfinities > 0)) result.push(NaN);
		else if (positiveInfinities > 0 || negativeInfinities > 0) result.push(positiveInfinities > 0 ? Infinity : -Infinity);
		else if (negativeZeros === window) result.push(-0);
		else result.push(exactMean(total, window));
	}
	return result;
}

/**
 * Divides an exact sum by a count: the correctly rounded sum divided by `count` (one more rounding). When the sum is beyond the doubles
 * but the mean is not, the same is done on the sum scaled by `2 ** -k` (`2 ** k >= 2 * (count + 2)`, so that both the scaled sum and
 * the scaled carries stay in range; exact, except for bits far below the result's last place), and the result is scaled back (exactly,
 * capped at `Number.MAX_VALUE`, which no mean of finite values exceeds).
 * @param {ExactSum} total - The exact sum of `count` finite values
 * @param {number} count - The number of values
 * @returns {number} Their mean
 */
function exactMean(total: ExactSum, count: number): number {
	const rounded = roundExact(total);
	if (Number.isFinite(rounded)) return rounded / count;
	// The carried part is at most `(count + 2) * 2 ** 1024` in magnitude (the partials add up to less than `2 ** 1025`).
	const exponent = Math.ceil(Math.log2(count + 2)) + 1;
	const scale = 2 ** -exponent;
	const scaled: ExactSum = { partials: [], size: 0, overflow: 0 };
	for (let i = 0; i < total.size; i++) addExact(scaled, total.partials[i] * scale);
	addExact(scaled, total.overflow * 2 ** (1024 - exponent));
	const mean = (roundExact(scaled) / count) * 2 ** exponent;
	return Math.min(Math.max(mean, -Number.MAX_VALUE), Number.MAX_VALUE);
}

/**
 * One bin of a {@link histogram}: the values `v` with `x0 <= v < x1` (`x0 <= v <= x1` for the last bin).
 */
export interface HistogramBin {
	/** The inclusive lower bound. */
	x0: number;
	/** The upper bound: exclusive, except for the last bin. */
	x1: number;
	/** How many values fall in the bin. */
	count: number;
}

/**
 * Options accepted by {@link histogram}: equal-width `bins`, or explicit `thresholds` (not both), and an optional `domain`.
 */
export type HistogramOptions = HistogramBinsOptions | HistogramThresholdsOptions;

/**
 * Options of a {@link histogram} with equal-width bins.
 */
export interface HistogramBinsOptions {
	/**
	 * The number of bins, an integer from 1 to 2 ** 20: the domain is split into that many bins of equal width (exactly that many, unlike
	 * d3's `thresholds(count)`, which picks round boundaries and only approaches the count).
	 * @default Sturges' rule: `ceil(log2(n)) + 1` for `n` values
	 */
	readonly bins?: number;
	/** Not allowed together with `bins`. */
	readonly thresholds?: undefined;
	/**
	 * The range `[x0, x1]` covered by the bins (finite, `x0 <= x1`); values outside it are not counted.
	 * @default the smallest and largest values
	 */
	readonly domain?: readonly [number, number];
}

/**
 * Options of a {@link histogram} with explicit bin boundaries.
 */
export interface HistogramThresholdsOptions {
	/** Not allowed together with `thresholds`. */
	readonly bins?: undefined;
	/**
	 * The boundaries between bins, finite and strictly increasing. As in d3, the first bin starts at the domain's lower bound and the last
	 * one ends at its upper bound; thresholds outside the open domain (including the bounds themselves) are ignored, so the edges of a
	 * histogram can be passed with or without its bounds (`[0, 10, 20, 30]` and `[10, 20]` give the same bins over `[0, 30]`).
	 */
	readonly thresholds: ReadonlyArray<number>;
	/**
	 * The range `[x0, x1]` covered by the bins (finite, `x0 <= x1`); values outside it are not counted.
	 * @default the smallest and largest values
	 */
	readonly domain?: readonly [number, number];
}

/**
 * The largest `bins` count of {@link histogram}: 2 ** 20 (1,048,576) bins already take about 100 MB (an object, a count and two edges each),
 * and are far more than any chart can show (a 4K screen is 3,840 pixels wide). An uncapped count, such as one read from a query string,
 * could make the runtime abort with an out-of-memory error, which cannot be caught.
 */
const MAX_BINS = 1_048_576;

/**
 * Reads a bin boundary option (an element of `domain` or `thresholds`), which must be a finite number.
 * @param {string} name - The name of the option element, for the error message
 * @param {unknown} value - Its value
 * @returns {number} The value
 * @throws {RangeError} when `value` is a number that is not finite
 * @throws {TypeError} when `value` is not a number
 */
function finiteBound(name: string, value: unknown): number {
	assertNumber('histogram', name, value, Number.isFinite(value), 'a finite number');
	return value;
}

/**
 * Counts values into bins, like d3's `bin()`: equal-width `bins` (Sturges' rule by default) or explicit `thresholds`, over a `domain`
 * that defaults to the extent of the values. Each bin `{ x0, x1, count }` holds the values `v` with `x0 <= v < x1`, except the last one,
 * which also holds `x1` (so the largest value is counted). Values outside the domain are not counted.
 *
 * Unlike d3, the domain is not widened to round ("nice") boundaries and `bins` gives exactly that many bins (pass `thresholds` for round
 * boundaries), a domain with `x0 === x1` (all values equal) gives a single bin, and non-finite values throw instead of being skipped
 * silently: filter missing values out first. Only the counts are kept, not the values. Values must be numbers (nothing is converted: `null`
 * or `''` would otherwise count as 0), each one read once and placed by binary search, so the cost is O(n log b) for `n` values and `b`
 * bins. At most 2 ** 20 bins can be asked for: each one is allocated.
 * @param {ReadonlyArray<number>} values - The values to count
 * @param {HistogramOptions} [options={}] - `bins` or `thresholds`, and `domain`
 * @returns {HistogramBin[]} The bins, in increasing order, edge to edge (`[]` for no values and no `domain`)
 * @throws {RangeError} when a value is `NaN` or infinite, `bins` is not an integer from 1 to 2 ** 20, a threshold or a domain bound is
 * not finite, the thresholds are not strictly increasing, or the domain's bounds are reversed
 * @throws {TypeError} when a value is not a number, `bins` is not a number, `thresholds` or `domain` is not an array (a domain of two
 * numbers), or both `bins` and `thresholds` are given
 * @example
 * histogram([1, 2, 2, 3, 4], { bins: 3 }); // => [{ x0: 1, x1: 2, count: 1 }, { x0: 2, x1: 3, count: 2 }, { x0: 3, x1: 4, count: 2 }]
 * histogram([5, 25, 30], { thresholds: [10, 20], domain: [0, 30] }); // => [{ x0: 0, x1: 10, count: 1 }, { x0: 10, x1: 20, count: 0 }, { x0: 20, x1: 30, count: 2 }]
 * histogram([0.1, 0.25, 0.3], { bins: 2, domain: [0, 1] }).map(function (bin) { return bin.count; }); // => [3, 0]
 * histogram([]); // => []
 * histogram([1, NaN]); // throws RangeError
 */
export function histogram(values: ReadonlyArray<number>, options: HistogramOptions = {}): HistogramBin[] {
	const bins = readOption(options, 'bins');
	const thresholds = readOption(options, 'thresholds');
	const domain = readOption(options, 'domain');
	if (bins !== undefined && thresholds !== undefined) throw new TypeError('histogram: `bins` and `thresholds` cannot be used together');
	if (bins !== undefined) assertNumber('histogram', 'bins', bins, Number.isInteger(bins) && bins >= 1 && bins <= MAX_BINS, `an integer between 1 and ${MAX_BINS}`);
	// Each option element is read once: the values validated are the values used.
	let inner: number[] | undefined;
	if (thresholds !== undefined) {
		if (!Array.isArray(thresholds)) throw new TypeError(`histogram: \`thresholds\` must be an array, got ${describe(thresholds)}`);
		inner = [];
		for (let i = 0; i < thresholds.length; i++) {
			const threshold = finiteBound(`thresholds[${i}]`, thresholds[i]);
			if (i > 0 && !(threshold > inner[i - 1])) {
				throw new RangeError(`histogram: \`thresholds\` must be strictly increasing, got ${inner[i - 1]} before ${threshold}`);
			}
			inner.push(threshold);
		}
	}
	let low = Infinity;
	let high = -Infinity;
	if (domain !== undefined) {
		if (!Array.isArray(domain) || domain.length !== 2) throw new TypeError(`histogram: \`domain\` must be an array of two numbers, got ${describe(domain)}`);
		low = finiteBound('domain[0]', domain[0]);
		high = finiteBound('domain[1]', domain[1]);
		if (low > high) throw new RangeError(`histogram: \`domain\` must be in increasing order, got [${low}, ${high}]`);
	}
	const count = values.length;
	const numbers = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		const value = values[i];
		if (!Number.isFinite(value)) assertNumber('histogram', `values[${i}]`, value, false, 'a finite number');
		numbers[i] = value;
		if (domain === undefined) {
			low = Math.min(low, value);
			high = Math.max(high, value);
		}
	}
	// No values and no domain: nothing to cover.
	if (low > high) return [];
	// The edges of the bins, from `low` to `high`.
	const edges = [low];
	if (inner !== undefined) {
		for (const threshold of inner) if (threshold > low && threshold < high) edges.push(threshold);
	} else if (low < high) {
		const binCount = bins ?? Math.max(1, Math.ceil(Math.log2(count)) + 1);
		// When the bounds are further apart than `Number.MAX_VALUE`, their halves are used (exactly: such bounds are far from the subnormals).
		const scale = Number.isFinite(high - low) ? 1 : 0.5;
		const start = low * scale;
		const width = high * scale - start;
		// `(width * i) / binCount` is correctly rounded (`0.3` rather than `0.30000000000000004` for 3 tenths), unless it can overflow.
		const exact = Number.isFinite(width * binCount);
		for (let i = 1; i < binCount; i++) {
			const offset = exact ? (width * i) / binCount : (width / binCount) * i;
			edges.push(Math.min((start + offset) / scale, high));
		}
	}
	edges.push(high);
	const counts = new Array<number>(edges.length - 1).fill(0);
	for (let i = 0; i < count; i++) {
		const value = numbers[i];
		if (value < low || value > high) continue;
		// The number of inner edges at or below the value is its bin (`high` itself lands in the last one).
		let first = 0;
		let last = edges.length - 2;
		while (first < last) {
			const middle = (first + last + 1) >>> 1;
			if (edges[middle] <= value) first = middle;
			else last = middle - 1;
		}
		counts[first]++;
	}
	return counts.map(function (binCount: number, index: number): HistogramBin {
		return { x0: edges[index], x1: edges[index + 1], count: binCount };
	});
}

/**
 * Greatest common divisor of two positive safe integers, without validation (see {@link gcd}).
 * @param {number} a - A positive integer
 * @param {number} b - A positive integer
 * @returns {number} Their greatest common divisor
 */
function euclid(a: number, b: number): number {
	while (b !== 0) {
		const rest = a % b;
		a = b;
		b = rest;
	}
	return a;
}

/**
 * Greatest common divisor of two non-negative bigints (Euclid's algorithm).
 * @param {bigint} a - A non-negative bigint
 * @param {bigint} b - A non-negative bigint
 * @returns {bigint} Their greatest common divisor
 */
function euclidBig(a: bigint, b: bigint): bigint {
	while (b !== 0n) {
		const rest = a % b;
		a = b;
		b = rest;
	}
	return a;
}

/**
 * Finds a non-trivial factor of an odd composite number by Pollard's rho method, in Brent's variant: Floyd's cycle detection is replaced
 * by comparing against a saved point at powers of two, and the gcd is taken once per batch of 128 differences multiplied together, then
 * replayed one step at a time when a batch overshoots to `n` itself. A polynomial `y² + c` that only finds `n` is retried with the next `c`.
 * In BigInt arithmetic: the products of residues of numbers up to `2 ** 53` need 106 bits.
 * @param {bigint} n - An odd composite number without small factors
 * @returns {bigint} A factor `d` of `n` with `1 < d < n`
 * @example
 * pollardRho(10403n); // => 101n
 */
function pollardRho(n: bigint): bigint {
	for (let c = 1n; ; c++) {
		let y = 2n;
		let x = y;
		let saved = y;
		let differences = 1n;
		let divisor = 1n;
		for (let length = 1; divisor === 1n; length *= 2) {
			x = y;
			for (let i = 0; i < length; i++) y = (y * y + c) % n;
			for (let done = 0; done < length && divisor === 1n; done += 128) {
				saved = y;
				for (let i = Math.min(128, length - done); i > 0; i--) {
					y = (y * y + c) % n;
					differences = (differences * (x > y ? x - y : y - x)) % n;
				}
				divisor = euclidBig(differences, n);
			}
		}
		// The batch multiplied a difference divisible by `n` (or several whose factors together make `n`): replay it one step at a time.
		if (divisor === n) {
			do {
				saved = (saved * saved + c) % n;
				divisor = euclidBig(x > saved ? x - saved : saved - x, n);
			} while (divisor === 1n);
		}
		if (divisor !== n) return divisor;
	}
}

/**
 * Pushes the prime factors of a number without prime factors below 1031 (so prime or a product of primes of at least 1031), in no order.
 * @param {number} n - An odd safe integer, at least 1031, without prime factors below 1031
 * @param {number[]} factors - Receives the prime factors
 * @returns {void}
 */
function splitLarge(n: number, factors: number[]): void {
	if (millerRabin(n)) {
		factors.push(n);
		return;
	}
	const divisor = Number(pollardRho(BigInt(n)));
	splitLarge(divisor, factors);
	splitLarge(n / divisor, factors);
}

/**
 * The prime factorization of a safe integer `>= 1`, ascending (see {@link primeFactors}).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} n - The number to factor
 * @returns {number[]} Its prime factors with multiplicity, ascending
 * @throws {RangeError} when `n` is not a safe integer `>= 1`
 * @throws {TypeError} when `n` is not a number
 */
function factorize(caller: string, n: number): number[] {
	assertNumber(caller, 'n', n, Number.isSafeInteger(n) && n >= 1, 'a safe integer >= 1');
	const factors: number[] = [];
	let rest = n;
	for (; rest % 2 === 0; rest /= 2) factors.push(2);
	for (; rest % 3 === 0; rest /= 3) factors.push(3);
	// 6k ± 1 trial division by the numbers up to about 1000 (as `isPrime` does), which takes out most factors of everyday numbers cheaply.
	let i = 5;
	for (; i <= 1024 && i * i <= rest; i += 6) {
		for (; rest % i === 0; rest /= i) factors.push(i);
		for (; rest % (i + 2) === 0; rest /= i + 2) factors.push(i + 2);
	}
	// What is left has no prime factor below `i`: below `i ** 2`, it is 1 or a prime; otherwise each of its (at most five) prime factors is
	// at least 1031, which Pollard's rho finds in about `√p` steps, so the cost stays bounded even for adversarial numbers near `2 ** 53`.
	if (rest > 1) {
		if (i * i > rest) factors.push(rest);
		else splitLarge(rest, factors);
	}
	return factors.sort(function (a, b) {
		return a - b;
	});
}

/**
 * Factors a positive integer into primes: the primes whose product is `n`, each repeated as many times as it divides `n`, in ascending
 * order (`[]` for `1`). Factors below about 1000 are found by trial division; what remains is split by a deterministic Miller–Rabin test
 * (see {@link isPrime}) and Pollard's rho method, so every safe integer, even a product of two primes near `2 ** 26.5` (the hardest case),
 * is factored in tens of milliseconds at most (about one millisecond typically), where trial division up to `√n` would take seconds.
 * @param {number} n - A safe integer `>= 1`
 * @returns {number[]} The prime factors of `n`, with multiplicity, ascending
 * @throws {RangeError} when `n` is not a safe integer `>= 1`
 * @throws {TypeError} when `n` is not a number
 * @example
 * primeFactors(360); // => [2, 2, 2, 3, 3, 5]
 * primeFactors(97); // => [97]
 * primeFactors(1); // => []
 * primeFactors(9007199254740991); // => [6361, 69431, 20394401]
 * primeFactors(0); // throws RangeError
 */
export function primeFactors(n: number): number[] {
	return factorize('primeFactors', n);
}

/**
 * Lists the positive divisors of a positive integer in ascending order, from `1` to `n` itself, built from its prime factorization (see
 * {@link primeFactors}), so the cost depends on the number of divisors (at most a few tens of thousands for safe integers) rather than on `√n`.
 * @param {number} n - A safe integer `>= 1`
 * @returns {number[]} Every positive divisor of `n`, ascending
 * @throws {RangeError} when `n` is not a safe integer `>= 1`
 * @throws {TypeError} when `n` is not a number
 * @example
 * divisors(12); // => [1, 2, 3, 4, 6, 12]
 * divisors(13); // => [1, 13]
 * divisors(1); // => [1]
 * divisors(-12); // throws RangeError
 */
export function divisors(n: number): number[] {
	const factors = factorize('divisors', n);
	const result = [1];
	for (let i = 0; i < factors.length;) {
		const prime = factors[i];
		const count = result.length;
		// Every divisor found so far, times each power of `prime` that divides `n`.
		for (let power = prime; factors[i] === prime; i++, power *= prime) {
			for (let j = 0; j < count; j++) result.push(result[j] * power);
		}
	}
	return result.sort(function (a, b) {
		return a - b;
	});
}

/**
 * The largest `limit` of {@link primesUpTo}: sieving up to `10 ** 8` takes a 50 MB buffer and returns 5,761,455 primes (about 50 MB more).
 * An uncapped limit, such as one read from a query string, could make the runtime abort with an out-of-memory error, which cannot be caught.
 */
const MAX_SIEVE_LIMIT = 100_000_000;

/**
 * Lists the primes up to `limit` (inclusive), in ascending order, with the sieve of Eratosthenes over the odd numbers. It is the fast way to
 * get many primes at once (about a second for the 5.7 million primes below `10 ** 8`); use {@link isPrime} to test a few numbers, and
 * {@link nextPrime} to walk the primes beyond the limit. A non-integer limit counts the primes below it, and a limit below 2 gives `[]`.
 * @param {number} limit - The largest number to consider, at most `10 ** 8` (the sieve is allocated in full)
 * @returns {number[]} The primes `p <= limit`, ascending
 * @throws {RangeError} when `limit` is `NaN` or greater than `10 ** 8`
 * @throws {TypeError} when `limit` is not a number
 * @example
 * primesUpTo(30); // => [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
 * primesUpTo(2); // => [2]
 * primesUpTo(1); // => []
 * primesUpTo(1e9); // throws RangeError
 */
export function primesUpTo(limit: number): number[] {
	assertNumber('primesUpTo', 'limit', limit, limit <= MAX_SIEVE_LIMIT, `a number <= ${MAX_SIEVE_LIMIT}`);
	const top = Math.floor(limit);
	if (top < 2) return [];
	// `composite[i]` stands for the odd number `2i + 3`.
	const size = (top - 1) >> 1;
	const composite = new Uint8Array(size);
	for (let i = 0, prime = 3; prime * prime <= top; i++, prime += 2) {
		if (composite[i] === 1) continue;
		// Smaller multiples of `prime` have a smaller prime factor and are already crossed out; even multiples are not in the sieve.
		for (let j = (prime * prime - 3) >> 1; j < size; j += prime) composite[j] = 1;
	}
	const result = [2];
	for (let i = 0; i < size; i++) if (composite[i] === 0) result.push(2 * i + 3);
	return result;
}

/** The largest prime below `2 ** 53`: the primes beyond it are not safe integers. */
const LARGEST_SAFE_PRIME = 9007199254740881;

/**
 * Finds the smallest prime greater than `n` (`nextPrime(7)` is `11`; `n` need not be an integer, and every `n < 2` gives `2`). Candidates
 * are tested with {@link isPrime}, whose cost is bounded, and gaps between primes below `2 ** 53` are at most 1132 numbers (after `1693182318746371`),
 * so the search takes milliseconds at most for any `n`. There is no safe-integer prime after `9007199254740881`, so larger `n` are rejected.
 * @param {number} n - The number to start after, less than `9007199254740881` (the largest prime below `2 ** 53`)
 * @returns {number} The smallest prime `p > n`
 * @throws {RangeError} when `n` is `NaN` or not less than `9007199254740881`
 * @throws {TypeError} when `n` is not a number
 * @example
 * nextPrime(7); // => 11
 * nextPrime(10.5); // => 11
 * nextPrime(-5); // => 2
 * nextPrime(9007199254740000); // => 9007199254740041
 * nextPrime(9007199254740881); // throws RangeError
 */
export function nextPrime(n: number): number {
	assertNumber('nextPrime', 'n', n, n < LARGEST_SAFE_PRIME, `a number < ${LARGEST_SAFE_PRIME}`);
	if (n < 2) return 2;
	// From here on, only odd numbers can be prime.
	let candidate = Math.floor(n) + 1;
	if (candidate % 2 === 0) candidate++;
	while (!isPrime(candidate)) candidate += 2;
	return candidate;
}

/**
 * Finds the largest prime less than `n` (`previousPrime(11)` is `7`; `n` need not be an integer). There is no prime below `2`, so `n` must
 * be greater than `2`; and `n` can be at most `2 ** 53`, since the primes just below larger doubles are not safe integers (and could not be
 * represented exactly). Like {@link nextPrime}, the search is fast for any `n`.
 * @param {number} n - The number to search below, greater than `2` and at most `2 ** 53`
 * @returns {number} The largest prime `p < n`
 * @throws {RangeError} when `n` is not greater than `2` and at most `2 ** 53` (including `NaN`)
 * @throws {TypeError} when `n` is not a number
 * @example
 * previousPrime(11); // => 7
 * previousPrime(3); // => 2
 * previousPrime(2 ** 53); // => 9007199254740881
 * previousPrime(2); // throws RangeError
 */
export function previousPrime(n: number): number {
	assertNumber('previousPrime', 'n', n, n > 2 && n <= 2 ** 53, 'a number > 2 and <= 2 ** 53');
	if (n <= 3) return 2;
	// From here on, only odd numbers can be prime.
	let candidate = Math.ceil(n) - 1;
	if (candidate % 2 === 0) candidate--;
	while (!isPrime(candidate)) candidate -= 2;
	return candidate;
}

/** `2 ** 1024`: a bigint at least this large converts to `Infinity`. */
const OVERFLOW = 2n ** 1024n;

/**
 * Computes the binomial coefficient "`n` choose `k`": the number of ways to choose `k` items out of `n`, `n! / (k! (n - k)!)`, and `0`
 * when `k < 0` or `k > n` (no way to choose them). The result is exact whenever it is a safe integer, as the multiplicative formula is
 * evaluated so that every intermediate value is an integer no larger than the result (unlike `factorial(n) / (factorial(k) *
 * factorial(n - k))`, which is inexact from `n = 23` and `NaN` from `n = 171`); larger results continue in BigInt arithmetic and are
 * correctly rounded, and results beyond `Number.MAX_VALUE` are `Infinity` (after at most about a thousand steps, whatever `k`).
 * @param {number} n - The number of items, a safe integer `>= 0`
 * @param {number} k - The number of items chosen, an integer
 * @returns {number} `n` choose `k`
 * @throws {RangeError} when `n` is not a safe integer `>= 0`, or `k` is not an integer
 * @throws {TypeError} when `n` or `k` is not a number
 * @example
 * binomial(5, 2); // => 10
 * binomial(52, 5); // => 2598960
 * binomial(10, 11); // => 0
 * binomial(60, 30); // => 118264581564861424 // exact, although above 2 ** 53
 * binomial(2000, 1000); // => Infinity
 */
export function binomial(n: number, k: number): number {
	assertNumber('binomial', 'n', n, Number.isSafeInteger(n) && n >= 0, 'a safe integer >= 0');
	assertNumber('binomial', 'k', k, Number.isInteger(k), 'an integer');
	if (k < 0 || k > n) return 0;
	// `C(n, k) = C(n, n - k)`: the fewer factors, the better.
	const steps = Math.min(k, n - k);
	const base = n - steps;
	let result = 1;
	let i = 1;
	for (; i <= steps; i++) {
		// `result` is `C(base + i - 1, i - 1)`, and `result * (base + i) / i` is the integer `C(base + i, i)`. With `g = gcd(result, i)`,
		// `i / g` divides `base + i`, so both factors below are integers and the product is exact whenever it is safe.
		const common = euclid(result, i);
		const next = (result / common) * ((base + i) / (i / common));
		if (next > Number.MAX_SAFE_INTEGER) break;
		result = next;
	}
	if (i > steps) return result;
	// `C(base + i, i)` grows with `i` and is at least `2 ** i`, so the exact computation reaches `2 ** 1024` within about 1024 steps.
	let exact = BigInt(result);
	for (; i <= steps; i++) {
		exact = (exact * BigInt(base + i)) / BigInt(i);
		if (exact >= OVERFLOW) return Infinity;
	}
	return Number(exact);
}

/**
 * The result of {@link extendedGcd}: the greatest common divisor of `a` and `b`, and Bézout coefficients `x` and `y` with
 * `a * x + b * y === gcd`.
 */
export interface ExtendedGcd {
	/** The greatest common divisor of `a` and `b`, never negative (`0` only when both are `0`). */
	readonly gcd: number;
	/** The coefficient of `a`. */
	readonly x: number;
	/** The coefficient of `b`. */
	readonly y: number;
}

/**
 * The extended Euclidean algorithm on the magnitudes of two safe integers (see {@link extendedGcd}).
 * @param {number} a - A safe integer
 * @param {number} b - A safe integer
 * @returns {ExtendedGcd} The gcd and the Bézout coefficients
 */
function bezout(a: number, b: number): ExtendedGcd {
	let previous = Math.abs(a);
	let current = Math.abs(b);
	let previousX = 1;
	let x = 0;
	let previousY = 0;
	let y = 1;
	while (current !== 0) {
		// The quotient from the exact remainder: `Math.floor(previous / current)` can round up when the true quotient is just below an integer.
		const rest = previous % current;
		const quotient = (previous - rest) / current;
		previous = current;
		current = rest;
		// The coefficients alternate in sign and stay below `|a / gcd|` and `|b / gcd|`, so these products and differences are exact.
		const nextX = previousX - quotient * x;
		previousX = x;
		x = nextX;
		const nextY = previousY - quotient * y;
		previousY = y;
		y = nextY;
	}
	// `0 * x + 0 * y` is `0` for any coefficients: the algorithm's `x = 1` is as good as any, `0` is the conventional choice.
	if (previous === 0) return { gcd: 0, x: 0, y: 0 };
	// `+ 0` turns a `-0` coefficient into `0`.
	return { gcd: previous, x: (a < 0 ? -previousX : previousX) + 0, y: (b < 0 ? -previousY : previousY) + 0 };
}

/**
 * Computes the greatest common divisor of two integers together with Bézout coefficients: integers `x` and `y` such that
 * `a * x + b * y === gcd(a, b)`, as found by the extended Euclidean algorithm (the smallest ones: when neither `a` nor `b` is
 * `0`, `|x| <= |b / gcd|` and `|y| <= |a / gcd|`). They solve linear Diophantine equations and give modular inverses (see {@link modInverse}). Every intermediate
 * value is a safe integer, so the result is exact. `extendedGcd(0, 0)` is `{ gcd: 0, x: 0, y: 0 }`.
 * @param {number} a - A safe integer
 * @param {number} b - A safe integer
 * @returns {ExtendedGcd} `{ gcd, x, y }`, with `gcd >= 0` and `a * x + b * y === gcd`
 * @throws {RangeError} when `a` or `b` is not a safe integer
 * @throws {TypeError} when `a` or `b` is not a number
 * @example
 * extendedGcd(240, 46); // => { gcd: 2, x: -9, y: 47 }
 * extendedGcd(-4, 6); // => { gcd: 2, x: 1, y: 1 }
 * extendedGcd(0, 5); // => { gcd: 5, x: 0, y: 1 }
 */
export function extendedGcd(a: number, b: number): ExtendedGcd {
	assertNumber('extendedGcd', 'a', a, Number.isSafeInteger(a), 'a safe integer');
	assertNumber('extendedGcd', 'b', b, Number.isSafeInteger(b), 'a safe integer');
	return bezout(a, b);
}

/**
 * The inverse of `a` modulo `modulus`, in `[0, modulus)`.
 * @param {string} message - The start of the error message, naming the caller and the arguments
 * @param {number} a - A safe integer
 * @param {number} modulus - A safe integer `>= 1`
 * @returns {number} The `x` in `[0, modulus)` with `a * x ≡ 1 (mod modulus)`
 * @throws {RangeError} when `a` and `modulus` are not coprime
 */
function modularInverse(message: string, a: number, modulus: number): number {
	const { gcd: divisor, x } = bezout(a, modulus);
	if (divisor !== 1) throw new RangeError(`${message}, got ${a} and ${modulus}`);
	return modulo(x, modulus);
}

/**
 * Computes the modular multiplicative inverse of `a`: the `x` in `[0, modulus)` with `a * x ≡ 1 (mod modulus)`, by the extended Euclidean
 * algorithm (see {@link extendedGcd}). It exists exactly when `a` and `modulus` are coprime; otherwise a `RangeError` is thrown rather than
 * a sentinel returned, since a `NaN` or `undefined` would flow silently into the arithmetic it is meant for (check `gcd(a, modulus) === 1`
 * first when the inputs may not be coprime). Modulo `1`, every number is `0`, so is its inverse.
 * @param {number} a - The number to invert, a safe integer (negative values are reduced first)
 * @param {number} modulus - The modulus, a safe integer `>= 1`
 * @returns {number} The inverse of `a` modulo `modulus`, in `[0, modulus)`
 * @throws {RangeError} when `a` is not a safe integer, `modulus` is not a safe integer `>= 1`, or `a` and `modulus` are not coprime
 * @throws {TypeError} when `a` or `modulus` is not a number
 * @example
 * modInverse(3, 11); // => 4 // 3 * 4 = 12 ≡ 1 (mod 11)
 * modInverse(-3, 11); // => 7
 * modInverse(10, 17); // => 12
 * modInverse(4, 8); // throws RangeError
 */
export function modInverse(a: number, modulus: number): number {
	assertNumber('modInverse', 'a', a, Number.isSafeInteger(a), 'a safe integer');
	assertNumber('modInverse', 'modulus', modulus, Number.isSafeInteger(modulus) && modulus >= 1, 'a safe integer >= 1');
	return modularInverse('modInverse: `a` must be coprime to `modulus`', a, modulus);
}

/** The largest modulus whose residues multiply exactly in doubles: `94906265 ** 2` is below `2 ** 53`. */
const SQRT_SAFE = 94906265;

/**
 * Computes `base ** exponent` modulo `modulus` (Python's three-argument `pow`) by square-and-multiply, exactly: residues are multiplied in
 * doubles while their products stay below `2 ** 53` (moduli up to `94906265`), and in BigInt arithmetic beyond, where `(base ** exponent)
 * % modulus` would overflow or lose every digit. The result is floored (see {@link modulo}), so it lies in `[0, modulus)` even for a
 * negative base; `0 ** 0` is `1`, and every result modulo `1` is `0`. A negative exponent raises the modular inverse of `base` (see
 * {@link modInverse}) to `-exponent`, as Python does.
 * @param {number} base - The base, a safe integer
 * @param {number} exponent - The exponent, a safe integer (negative only when `base` and `modulus` are coprime)
 * @param {number} modulus - The modulus, a safe integer `>= 1`
 * @returns {number} `base ** exponent mod modulus`, in `[0, modulus)`
 * @throws {RangeError} when an argument is not a safe integer, `modulus` is less than `1`, or `exponent` is negative and `base` is not
 * coprime to `modulus`
 * @throws {TypeError} when an argument is not a number
 * @example
 * modPow(4, 13, 497); // => 445
 * modPow(-2, 3, 5); // => 2 // -8 mod 5
 * modPow(3, -1, 11); // => 4 // the inverse of 3
 * modPow(2, -1, 4); // throws RangeError
 */
export function modPow(base: number, exponent: number, modulus: number): number {
	assertNumber('modPow', 'base', base, Number.isSafeInteger(base), 'a safe integer');
	assertNumber('modPow', 'exponent', exponent, Number.isSafeInteger(exponent), 'a safe integer');
	assertNumber('modPow', 'modulus', modulus, Number.isSafeInteger(modulus) && modulus >= 1, 'a safe integer >= 1');
	let power = modulo(base, modulus);
	let rest = exponent;
	if (exponent < 0) {
		power = modularInverse('modPow: `base` must be coprime to `modulus` for a negative `exponent`', base, modulus);
		rest = -exponent;
	}
	if (modulus <= SQRT_SAFE) {
		let result = 1 % modulus;
		for (; rest > 0; rest = Math.floor(rest / 2), power = (power * power) % modulus) {
			if (rest % 2 === 1) result = (result * power) % modulus;
		}
		return result;
	}
	const big = BigInt(modulus);
	let result = 1n;
	let square = BigInt(power);
	for (let bits = BigInt(rest); bits > 0n; bits >>= 1n, square = (square * square) % big) {
		if ((bits & 1n) === 1n) result = (result * square) % big;
	}
	return Number(result);
}

/**
 * Computes the integer square root of a non-negative integer: the largest integer `r` with `r * r <= n` (Python's `math.isqrt`). Unlike
 * `Math.floor(Math.sqrt(n))`, it is always exact: `Math.sqrt` rounds `√(r² - 1)` up to `r` for large `r`
 * (`Math.floor(Math.sqrt(94906265 ** 2 - 1))` is `94906265`, one too many). Pass a bigint for numbers of any size: they use Newton's method
 * in BigInt arithmetic.
 * @param {number} n - A safe integer `>= 0`
 * @returns {number} `⌊√n⌋`
 * @throws {RangeError} when `n` is a number that is not a safe integer `>= 0`, or a negative bigint
 * @throws {TypeError} when `n` is neither a number nor a bigint
 * @example
 * integerSqrt(17); // => 4
 * integerSqrt(94906265 ** 2 - 1); // => 94906264 // Math.floor(Math.sqrt(...)) gives 94906265
 * integerSqrt(10n ** 40n); // => 10n ** 20n
 * integerSqrt(-1); // throws RangeError
 */
export function integerSqrt(n: number): number;
/**
 * {@link integerSqrt} for a bigint: the largest bigint `r` with `r * r <= n`, by Newton's method.
 * @param {bigint} n - A bigint `>= 0n`
 * @returns {bigint} `⌊√n⌋`
 * @example
 * integerSqrt(2n ** 64n + 1n); // => 2n ** 32n
 */
export function integerSqrt(n: bigint): bigint;
/**
 * Computes the integer square root of a non-negative integer, a number or a bigint (see the overloads).
 * @param {number | bigint} n - A safe integer `>= 0` or a bigint `>= 0n`
 * @returns {number | bigint} `⌊√n⌋`, of the same type as `n`
 * @throws {RangeError} when `n` is a number that is not a safe integer `>= 0`, or a negative bigint
 * @throws {TypeError} when `n` is neither a number nor a bigint
 * @example
 * integerSqrt(99); // => 9
 */
export function integerSqrt(n: number | bigint): number | bigint {
	const expected = 'a safe integer >= 0 or a bigint >= 0';
	if (typeof n === 'bigint') {
		if (n < 0n) throw new RangeError(`integerSqrt: \`n\` must be ${expected}, got ${n}`);
		if (n < 2n) return n;
		// Newton's iteration decreases monotonically to `⌊√n⌋` from any start above it, such as `2 ** ⌈bits / 2⌉`.
		let root = 1n << BigInt((n.toString(2).length + 1) >> 1);
		for (let next = (root + n / root) >> 1n; next < root; next = (root + n / root) >> 1n) root = next;
		return root;
	}
	assertNumber('integerSqrt', 'n', n, Number.isSafeInteger(n) && n >= 0, expected);
	// `Math.sqrt` is correctly rounded: it never rounds below the integer root (an exact double), but can round up to `r + 1` when `n` is
	// just below `(r + 1) ** 2`. Such squares are below `2 ** 53`, so the product is exact.
	const root = Math.floor(Math.sqrt(n));
	// `+ 0` turns the root of `-0` into `0`.
	return (root * root > n ? root - 1 : root) + 0;
}

/**
 * Checks whether a number is the square of an integer (`0`, `1`, `4`, `9`, …), exactly: `Math.sqrt` alone cannot tell large squares from
 * their neighbours, so the candidate root is squared back (in BigInt arithmetic above `2 ** 53`, where every double is an integer).
 * Non-integers, negative numbers, `NaN` and `±Infinity` are not perfect squares.
 * @param {number} n - The number to test
 * @returns {boolean} `true` when `n` is the square of an integer
 * @example
 * isPerfectSquare(49); // => true
 * isPerfectSquare(50); // => false
 * isPerfectSquare(94906265 ** 2 + 1); // => false // Math.sqrt gives exactly 94906265
 * isPerfectSquare(2.25); // => false // 1.5 is not an integer
 * isPerfectSquare(2 ** 100); // => true
 */
export function isPerfectSquare(n: number): boolean {
	if (!Number.isInteger(n) || n < 0) return false;
	// A double that is a square has an exactly representable root, which `Math.sqrt` (correctly rounded) returns.
	const root = Math.sqrt(n);
	if (!Number.isInteger(root)) return false;
	return n <= Number.MAX_SAFE_INTEGER ? root * root === n : BigInt(root) ** 2n === BigInt(n);
}

/**
 * The largest power of two `<= n`, for a finite `n >= 1`: `Math.log2` is approximate, so its estimate is corrected with exact comparisons.
 * @param {number} n - A finite number `>= 1`
 * @returns {number} `2 ** ⌊log2(n)⌋`
 */
function floorPowerOfTwo(n: number): number {
	// `Math.log2` of the largest doubles rounds to 1024, and `2 ** 1024` is `Infinity`, which halving never brings back.
	let power = 2 ** Math.min(Math.floor(Math.log2(n)), 1023);
	while (power > n) power /= 2;
	// Past `2 ** 1023`, `power * 2` is `Infinity`, never `<= n`.
	while (power * 2 <= n) power *= 2;
	return power;
}

/**
 * Checks whether a number is an integer power of two (`1`, `2`, `4`, …, up to `2 ** 1023`), for buffer, texture and hash-table sizes.
 * Fractions (`0.5` is `2 ** -1`), zero, negative numbers, `NaN` and `±Infinity` are not. The test is exact (no `Math.log2` rounding, and
 * no 32-bit `n & (n - 1)`, which is wrong from `2 ** 32`).
 * @param {number} n - The number to test
 * @returns {boolean} `true` when `n` is `2 ** k` for an integer `k >= 0`
 * @example
 * isPowerOfTwo(1024); // => true
 * isPowerOfTwo(1000); // => false
 * isPowerOfTwo(2 ** 40); // => true
 * isPowerOfTwo(0.5); // => false
 */
export function isPowerOfTwo(n: number): boolean {
	return Number.isInteger(n) && n >= 1 && floorPowerOfTwo(n) === n;
}

/**
 * Finds the smallest integer power of two greater than or equal to a number (`nextPowerOfTwo(1000)` is `1024`), for growing buffers, texture
 * and hash-table sizes. A power of two is returned as is, and any number up to `1` (fractions, zero and negative numbers included) gives
 * `1` (`2 ** 0`). Numbers beyond `2 ** 1023` give `Infinity`, since `2 ** 1024` exceeds the doubles. Exact for every number, unlike
 * `2 ** Math.ceil(Math.log2(n))` (which depends on the rounding of `Math.log2`) and 32-bit tricks (wrong from `2 ** 31`).
 * @param {number} n - The number to round up (`NaN` is rejected)
 * @returns {number} The smallest `2 ** k >= n` with `k >= 0`
 * @throws {RangeError} when `n` is `NaN`
 * @throws {TypeError} when `n` is not a number
 * @example
 * nextPowerOfTwo(1000); // => 1024
 * nextPowerOfTwo(1024); // => 1024
 * nextPowerOfTwo(5.5); // => 8
 * nextPowerOfTwo(0.3); // => 1
 * nextPowerOfTwo(2 ** 40 + 1); // => 2 ** 41
 */
export function nextPowerOfTwo(n: number): number {
	assertNumber('nextPowerOfTwo', 'n', n, n === n, 'a number (not NaN)');
	if (n <= 1) return 1;
	if (n === Infinity) return n;
	const power = floorPowerOfTwo(n);
	return power === n ? n : power * 2;
}

/**
 * Multiplies a number by `2 ** exponent` in two steps, so that the power of two itself never overflows or underflows (`2 ** 1074` is
 * `Infinity`): exact whenever the result is a normal double.
 * @param {number} value - The number to scale
 * @param {number} exponent - An integer between `-2098` and `2098`
 * @returns {number} `value * 2 ** exponent`
 * @example
 * scaleByPowerOfTwo(5e-324, 1074); // => 1
 */
function scaleByPowerOfTwo(value: number, exponent: number): number {
	const half = Math.trunc(exponent / 2);
	return value * 2 ** half * 2 ** (exponent - half);
}

/**
 * Computes the geometric mean of an array of numbers, the `n`-th root of their product: the average of growth rates, ratios and other
 * multiplicative quantities (Python's `statistics.geometric_mean`, scipy's `gmean`, Excel's `GEOMEAN`). The product is accumulated with
 * its power of two kept apart, so that it neither overflows nor underflows whatever the number of values (`geometricMean([1e300, 1e300])`
 * is `1e300`, where the product is `Infinity`), and its root is taken once, so the result is accurate to a few units in the last place
 * (exact for exact powers: `geometricMean([2, 8])` is `4`, where `exp(mean(log))` gives `4.000000000000001`).
 *
 * Values are converted once with unary `+`. The geometric mean is only defined for non-negative values: a negative value or `NaN` gives
 * `NaN`; otherwise a zero gives `0`, and an `Infinity` gives `Infinity` (`NaN` with a zero).
 * @param {ReadonlyArray<number>} numbers - The non-negative numbers
 * @returns {number} The geometric mean, or `NaN` for an empty array
 * @example
 * geometricMean([2, 8]); // => 4
 * geometricMean([1, 3, 9]); // => 3
 * geometricMean([1e300, 1e300]); // => 1e300
 * geometricMean([4, 0]); // => 0
 * geometricMean([-1, 1]); // => NaN
 */
export function geometricMean(numbers: ReadonlyArray<number>): number {
	const count = numbers.length;
	if (count === 0) return NaN;
	// The product is `scaledProduct * 2 ** exponent`, with `scaledProduct` kept in `[2 ** -500, 2 ** 500]` (every value is brought into that
	// range too, by exact powers of two), so that multiplying two of them can neither overflow nor underflow.
	let scaledProduct = 1;
	let exponent = 0;
	let zero = false;
	let infinite = false;
	for (let i = 0; i < count; i++) {
		let value = +numbers[i];
		// Negative or `NaN`.
		if (!(value >= 0)) return NaN;
		if (value === 0) zero = true;
		else if (value === Infinity) infinite = true;
		else {
			if (value > 2 ** 500) {
				value *= 2 ** -600;
				exponent += 600;
			} else if (value < 2 ** -500) {
				value *= 2 ** 600;
				exponent -= 600;
			}
			scaledProduct *= value;
			if (scaledProduct > 2 ** 500) {
				scaledProduct *= 2 ** -500;
				exponent += 500;
			} else if (scaledProduct < 2 ** -500) {
				scaledProduct *= 2 ** 500;
				exponent -= 500;
			}
		}
	}
	if (zero) return infinite ? NaN : 0;
	if (infinite) return Infinity;
	// The product as `mantissa * 2 ** exponent`, with the mantissa in `[1, 2)`.
	let shift = Math.floor(Math.log2(scaledProduct));
	let mantissa = scaledProduct * 2 ** -shift;
	// `Math.log2` is exact on powers of two and monotonic, so it can only round up to one (for a product just below it).
	if (mantissa < 1) {
		mantissa *= 2;
		shift--;
	}
	exponent += shift;
	// `(mantissa * 2 ** exponent) ** (1 / count)` is `(mantissa * 2 ** rest) ** (1 / count) * 2 ** quotient`: a single root, of a number in
	// `[1, 2 ** count)`, which is snapped to an exact root when there is one. Past `2 ** 500` the power of two is rooted on its own.
	const quotient = Math.floor(exponent / count);
	const rest = exponent - quotient * count;
	if (rest > 500) return scaleByPowerOfTwo(nthRoot(mantissa, count) * 2 ** (rest / count), quotient);
	const radicand = mantissa * 2 ** rest;
	return scaleByPowerOfTwo(exactRoot(nthRoot(radicand, count), radicand, count), quotient);
}

/**
 * Snaps an approximate `n`-th root to the exact one when the radicand is the `n`-th power of a double: an exact root `r` of a double has at
 * most `floor(53 / n)` significant bits (its `n`-th power has at most 53), so the approximation rounded to that many bits is `r` if `r`
 * exists, which its exact `n`-th power (computed by `n - 1` exact multiplications) confirms (`geometricMean([81, 1, 1, 1])` is then exactly
 * `3`, and `geometricMean([2.25, 1])` exactly `1.5`).
 * @param {number} root - The approximate root, at least `1`
 * @param {number} radicand - The radicand, at least `1`
 * @param {number} n - The degree of the root, a positive integer
 * @returns {number} The exact root if there is one, else `root`
 * @example
 * exactRoot(1.4999999999999998, 5.0625, 4); // => 1.5
 */
function exactRoot(root: number, radicand: number, n: number): number {
	// Beyond 26, an exact root has a single significant bit: in `[1, 2)` that is `1`, the root of `1`, which `nthRoot` gives exactly.
	if (n > 26) return root;
	const unit = 2 ** (Math.floor(Math.log2(root)) + 1 - Math.floor(53 / n));
	const candidate = Math.round(root / unit) * unit;
	let power = candidate;
	for (let i = 1; i < n; i++) power *= candidate;
	return power === radicand ? candidate : root;
}

/**
 * Computes the harmonic mean of an array of numbers, `n / Σ(1 / x)`: the average of rates, such as speeds over equal distances or
 * price-earnings ratios (Python's `statistics.harmonic_mean`, scipy's `hmean`, Excel's `HARMEAN`). The reciprocals are taken of values
 * scaled by a power of two (exactly), so that tiny values do not overflow them, and added up with the compensated {@link sum}.
 *
 * Values are converted once with unary `+`. The harmonic mean is only defined for non-negative values: a negative value or `NaN` gives
 * `NaN`; otherwise a zero gives `0`, and `Infinity` values count for nothing (only `Infinity`s give `Infinity`).
 * @param {ReadonlyArray<number>} numbers - The non-negative numbers
 * @returns {number} The harmonic mean, or `NaN` for an empty array
 * @example
 * harmonicMean([40, 60]); // => 48 // the average speed of a round trip at 40 and 60 km/h
 * harmonicMean([1, 4, 4]); // => 2
 * harmonicMean([5e-324, 5e-324]); // => 5e-324 // 1 / 5e-324 is Infinity
 * harmonicMean([2, 0]); // => 0
 * harmonicMean([-1, 1]); // => NaN
 */
export function harmonicMean(numbers: ReadonlyArray<number>): number {
	const count = numbers.length;
	if (count === 0) return NaN;
	const values: number[] = [];
	let smallest = Infinity;
	for (let i = 0; i < count; i++) {
		const value = +numbers[i];
		// Negative or `NaN`.
		if (!(value >= 0)) return NaN;
		values.push(value);
		smallest = Math.min(smallest, value);
	}
	if (smallest === 0) return 0;
	if (smallest === Infinity) return Infinity;
	// Scaled so that the smallest value is close to `1`: no reciprocal exceeds `2`, and those that underflow are negligible next to it.
	const exponent = -Math.floor(Math.log2(smallest));
	// The sum of the reciprocals in double-double precision: each reciprocal and its rounding error go through a Neumaier sum, whose total
	// and compensation are then renormalized into `high + low`.
	let total = 0;
	let compensation = 0;
	/**
	 * Adds a term to the Neumaier sum.
	 * @param {number} term - The term
	 * @returns {void}
	 */
	function add(term: number): void {
		const next = total + term;
		compensation += Math.abs(total) >= Math.abs(term) ? total - next + term : term - next + total;
		total = next;
	}
	for (const value of values) {
		const scaled = scaleByPowerOfTwo(value, exponent);
		const reciprocal = 1 / scaled;
		add(reciprocal);
		// Splitting multiplies by `2 ** 27 + 1`, which would overflow for the largest doubles; the reciprocals of values beyond `2 ** 900`
		// count for nothing next to the others (at least `1 / 2`) anyway.
		if (scaled <= 2 ** 900) add((1 - reciprocal * scaled - productError(reciprocal, scaled)) / scaled);
	}
	const high = total + compensation;
	const low = compensation - (high - total);
	// `count / (high + low)`: the quotient by `high`, corrected by one Newton step on the exact residual `count - quotient * (high + low)`
	// (`count - quotient * high` is exact, the product being within an ulp of `count`), so that a repeated value gives back that value.
	const quotient = count / high;
	const residual = count - quotient * high - productError(quotient, high) - quotient * low;
	return scaleByPowerOfTwo(quotient + residual / high, -exponent);
}

/**
 * The rounding error of a product: `a * b - fl(a * b)`, exactly, by Dekker's algorithm (each factor split into two halves of 26 bits, whose
 * partial products are exact). The factors must stay below `2 ** 996` in magnitude, so that splitting them does not overflow, and their
 * product must not underflow.
 * @param {number} a - A factor
 * @param {number} b - The other factor
 * @returns {number} The exact error of the rounded product `a * b`
 * @example
 * productError(1 / 3, 3); // => -5.551115123125783e-17
 */
function productError(a: number, b: number): number {
	const rounded = a * b;
	const aSplit = 134217729 * a;
	const aHigh = aSplit - (aSplit - a);
	const aLow = a - aHigh;
	const bSplit = 134217729 * b;
	const bHigh = bSplit - (bSplit - b);
	const bLow = b - bHigh;
	return aHigh * bHigh - rounded + aHigh * bLow + aLow * bHigh + aLow * bLow;
}

/**
 * Computes the root mean square (quadratic mean) of an array of numbers, `√(Σx² / n)`: the magnitude of a signal or of errors (the RMSE of
 * residuals). Like `Math.hypot`, the values are scaled by a power of two first (exactly), so that their squares neither overflow nor
 * underflow (`rootMeanSquare([1e200, 1e200])` is `1e200`, not `Infinity`); the squares are added up with the compensated {@link sum}.
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {number} The root mean square: `NaN` for an empty array or if a value is `NaN`, else `Infinity` if a value is infinite
 * @example
 * rootMeanSquare([3, 4]); // => 3.5355339059327378
 * rootMeanSquare([-2, 2]); // => 2
 * rootMeanSquare([1e200, 1e200]); // => 1e200
 * rootMeanSquare([]); // => NaN
 */
export function rootMeanSquare(numbers: ReadonlyArray<number>): number {
	const count = numbers.length;
	if (count === 0) return NaN;
	const [values, scale] = scaledSample(numbers);
	const squares = values.map(function (value) {
		return value * value;
	});
	return Math.sqrt(scaledSum(squares, count)) / scale;
}

/**
 * The central moments of a sample that {@link skewness} and {@link kurtosis} derive their results from, of the sample scaled by
 * {@link scaledSample} (the ratios they compute do not depend on the scale).
 */
interface CentralMoments {
	/** The number of values. */
	count: number;
	/** Whether every value is the same (the shape statistics are then undefined). */
	constant: boolean;
	/** The second central moment `Σ(x - x̄)² / n`. */
	m2: number;
	/** The third central moment `Σ(x - x̄)³ / n`. */
	m3: number;
	/** The fourth central moment `Σ(x - x̄)⁴ / n`. */
	m4: number;
}

/**
 * Computes the second, third and fourth central moments of a sample in two passes (the compensated mean, then the powers of the
 * deviations from it), on the values scaled by a power of two (so that the fourth powers neither overflow nor underflow). The deviations
 * from the rounded mean add up to `n` times its rounding error instead of `0`: as in {@link pairedMoments}, the sums are re-centred on the
 * mean of the deviations (by the binomial expansion), which matters for data far from zero. Values are converted with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The sample
 * @returns {CentralMoments} The count, whether the sample is constant, and the moments (`NaN` if a value is not finite)
 */
function centralMoments(numbers: ReadonlyArray<number>): CentralMoments {
	const [values] = scaledSample(numbers);
	const count = values.length;
	const mean = average(values);
	let constant = true;
	let s1 = 0;
	let s2 = 0;
	let s3 = 0;
	let s4 = 0;
	for (let i = 0; i < count; i++) {
		if (values[i] !== values[0]) constant = false;
		const deviation = values[i] - mean;
		const square = deviation * deviation;
		s1 += deviation;
		s2 += square;
		s3 += square * deviation;
		s4 += square * square;
	}
	// `Σ(d - c)^k` for the mean `c` of the deviations, expanded (with `Σd = n·c`).
	const c = s1 / count;
	return {
		count,
		constant,
		m2: (s2 - c * s1) / count,
		m3: (s3 - 3 * c * s2 + 2 * count * c ** 3) / count,
		m4: (s4 - 4 * c * s3 + 6 * c * c * s2 - 3 * count * c ** 4) / count
	};
}

/**
 * Computes the skewness of an array of numbers, the asymmetry of their distribution: positive when the tail on the right (large values) is
 * longer, negative when the left one is, `0` for symmetric data. By default the population (biased) skewness `g1 = m3 / m2^1.5` is
 * returned, like scipy's `skew`; pass `{ sample: true }` for the adjusted Fisher–Pearson sample skewness
 * `G1 = g1 · √(n(n - 1)) / (n - 2)` of Excel's `SKEW` and pandas' `skew`. The moments are computed in two passes from the compensated
 * mean, on values scaled by a power of two, so the result is accurate for data far from zero and for any magnitude.
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {VarianceOptions} [options={}] - `sample`: compute the adjusted sample skewness instead of the population one
 * @returns {number} The skewness; `NaN` for an empty array, for a sample skewness of fewer than 3 values, when every value is the same
 * (the skewness is undefined), or if a value is not finite
 * @example
 * skewness([1, 2, 3, 10]); // => 1.0182337649086284
 * skewness([3, 4, 5, 2, 3, 4, 5, 6, 4, 7], { sample: true }); // => 0.359543071406797 // Excel's SKEW
 * skewness([1, 2, 3]); // => 0
 * skewness([5, 5, 5]); // => NaN
 */
export function skewness(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	const sample = readOption(options, 'sample') === true;
	const { count, constant, m2, m3 } = centralMoments(numbers);
	if (constant || (sample && count < 3)) return NaN;
	const population = m3 / (m2 * Math.sqrt(m2));
	return sample ? (population * Math.sqrt(count * (count - 1))) / (count - 2) : population;
}

/**
 * Computes the excess kurtosis of an array of numbers, how heavy the tails of their distribution are compared to a normal distribution
 * (whose excess kurtosis is `0`): positive for heavy tails and outliers, negative for light tails (a uniform distribution has `-1.2`).
 * By default the population (biased) excess kurtosis `g2 = m4 / m2² - 3` is returned, like scipy's `kurtosis`; pass `{ sample: true }` for
 * the adjusted sample excess kurtosis `G2 = ((n + 1) g2 + 6) (n - 1) / ((n - 2)(n - 3))` of Excel's `KURT` and pandas' `kurt`. Add `3` to
 * the population value for Pearson's (non-excess) kurtosis. The moments are computed like those of {@link skewness}.
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {VarianceOptions} [options={}] - `sample`: compute the adjusted sample excess kurtosis instead of the population one
 * @returns {number} The excess kurtosis; `NaN` for an empty array, for a sample kurtosis of fewer than 4 values, when every value is the
 * same (the kurtosis is undefined), or if a value is not finite
 * @example
 * kurtosis([1, 2, 3, 4]); // => -1.36
 * kurtosis([3, 4, 5, 2, 3, 4, 5, 6, 4, 7], { sample: true }); // => -0.15179963720841477 // Excel's KURT
 * kurtosis([5, 5, 5, 5]); // => NaN
 */
export function kurtosis(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number {
	const sample = readOption(options, 'sample') === true;
	const { count, constant, m2, m4 } = centralMoments(numbers);
	if (constant || (sample && count < 4)) return NaN;
	const population = m4 / (m2 * m2) - 3;
	return sample ? (((count + 1) * population + 6) * (count - 1)) / ((count - 2) * (count - 3)) : population;
}

/**
 * Computes the median absolute deviation of an array of numbers, `median(|x - median(x)|)`: a measure of spread that, unlike the standard
 * deviation, outliers barely move (scipy's `median_abs_deviation` with its default `scale = 1`). Multiply it by `1.4826` to estimate the
 * standard deviation of normally distributed data (scipy's `scale='normal'`), e.g. to flag values more than three such deviations from the
 * median as outliers. The input is not mutated; values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {number} The median absolute deviation; `NaN` for an empty array, if a value is `NaN`, or when the median is infinite
 * @example
 * medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9]); // => 1
 * medianAbsoluteDeviation([1, 2, 3, 4, 1000]); // => 1 // the standard deviation is about 399
 * medianAbsoluteDeviation([]); // => NaN
 */
export function medianAbsoluteDeviation(numbers: ReadonlyArray<number>): number {
	const sorted = sortedCopy(numbers);
	const center = sortedMedian(sorted);
	return median(
		Array.from(sorted, function (value) {
			return Math.abs(value - center);
		})
	);
}

/**
 * Computes the trimmed (truncated) mean of an array of numbers: the mean of what remains once the `floor(n · proportion)` smallest and as
 * many largest values are cut off, a mean that outliers do not move (scipy's `trim_mean`). `proportion = 0` gives the plain
 * {@link average}, and a proportion close to `0.5` tends to the median. The input is not mutated; values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {number} proportion - The share cut off at each end, in `[0, 0.5)`
 * @returns {number} The trimmed mean, or `NaN` for an empty array or if a value is `NaN`
 * @throws {RangeError} when `proportion` is not in `[0, 0.5)` (including `NaN`)
 * @throws {TypeError} when `proportion` is not a number
 * @example
 * trimmedMean([1, 2, 3, 4, 100], 0.2); // => 3 // 1 and 100 are cut off
 * trimmedMean([1, 2, 3, 4, 100], 0); // => 22
 * trimmedMean([], 0.1); // => NaN
 * trimmedMean([1, 2], 0.5); // throws RangeError
 */
export function trimmedMean(numbers: ReadonlyArray<number>, proportion: number): number {
	assertNumber('trimmedMean', 'proportion', proportion, proportion >= 0 && proportion < 0.5, 'a number in [0, 0.5)');
	const sorted = sortedCopy(numbers);
	const length = sorted.length;
	// The largest value is missing (empty input) or NaN (sorted last).
	if (!(sorted[length - 1] <= Infinity)) return NaN;
	const cut = Math.floor(length * proportion);
	const kept: number[] = [];
	for (let i = cut; i < length - cut; i++) kept.push(sorted[i]);
	return average(kept);
}

/**
 * Ranks numbers in ascending order: the smallest gets `1`, the next `2`, and so on, equal values sharing the average of the ranks they
 * span (fractional ranking: `[10, 20, 20, 30]` ranks `[1, 2.5, 2.5, 4]`), like scipy's `rankdata`, pandas' `rank()` and Excel's `RANK.AVG`
 * in ascending order. The ranks are given in the order of the input. Like pandas' default, a `NaN` gets a `NaN` rank and the other values
 * are ranked among themselves; `0` and `-0` are equal, and infinities rank first or last. Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers to rank
 * @returns {number[]} One rank per number, from `1` to the count of numbers that are not `NaN`
 * @example
 * ranks([10, 30, 20]); // => [1, 3, 2]
 * ranks([10, 20, 20, 30]); // => [1, 2.5, 2.5, 4]
 * ranks([3, NaN, 1]); // => [2, NaN, 1]
 */
export function ranks(numbers: ReadonlyArray<number>): number[] {
	const values = Array.from(numbers, function (value) {
		return +value;
	});
	const result = new Array<number>(values.length).fill(NaN);
	const order: number[] = [];
	for (let i = 0; i < values.length; i++) {
		if (values[i] === values[i]) order.push(i);
	}
	order.sort(function (a, b) {
		return values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0;
	});
	// Each run of equal values, at sorted positions `start` to `end - 1`, gets the mean of the ranks `start + 1` to `end`.
	for (let start = 0; start < order.length;) {
		let end = start + 1;
		while (end < order.length && values[order[end]] === values[order[start]]) end++;
		for (let i = start; i < end; i++) result[order[i]] = (start + 1 + end) / 2;
		start = end;
	}
	return result;
}

/**
 * Computes Spearman's rank correlation coefficient of two paired samples: the Pearson {@link correlation} of their {@link ranks}, from `-1`
 * to `1`. Where the Pearson coefficient measures how linear the relation is, Spearman's measures how monotonic it is (`1` whenever `ys`
 * grows with `xs`, however non-linearly), and outliers count only by their rank (scipy's `spearmanr`, pandas' `corr(method='spearman')`).
 * Ties get average ranks; infinities are ranked like any other value. Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} xs - The first sample
 * @param {ReadonlyArray<number>} ys - The second sample, one value per value of `xs`
 * @returns {number} The coefficient, in `[-1, 1]`; `NaN` for fewer than 2 pairs, when either sample is constant, or if a value is `NaN`
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * spearmanCorrelation([1, 2, 3, 4], [1, 4, 9, 16]); // => 1
 * spearmanCorrelation([1, 2, 3, 4], [1, 8, 27, 1000]); // => 1 // their Pearson correlation is about 0.8
 * spearmanCorrelation([1, 2, 3], [3, 2, 1]); // => -1
 * spearmanCorrelation([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]); // => 0.8207826816681233
 * spearmanCorrelation([1, 2], [1]); // throws RangeError
 */
export function spearmanCorrelation(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
	// The ranks have the lengths of the samples, which `pairedMoments` checks.
	const moments = pairedMoments('spearmanCorrelation', ranks(xs), ranks(ys));
	const root = Math.sqrt(determination(moments));
	return moments.sxy < 0 ? -root : root;
}

/**
 * Standardizes numbers into z-scores: how many standard deviations each one lies from their mean, `(x - mean) / standardDeviation`, so
 * that the result has a mean of `0` and a standard deviation of `1` (scikit-learn's `StandardScaler`, scipy's `zscore`). The population
 * standard deviation is used by default; pass `{ sample: true }` for the sample one. When every value is the same, every score is `0`, as
 * in scikit-learn. The computation runs on values scaled by a power of two (exactly), so that no difference overflows.
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @param {VarianceOptions} [options={}] - `sample`: divide by the sample standard deviation instead of the population one
 * @returns {number[]} One z-score per number; every score is `NaN` when the standard deviation is undefined (a value that is not finite,
 * or a single value with `{ sample: true }`)
 * @example
 * standardize([2, 4, 4, 4, 5, 5, 7, 9]); // => [-1.5, -0.5, -0.5, -0.5, 0, 0, 1, 2]
 * standardize([1, 2, 3], { sample: true }); // => [-1, 0, 1]
 * standardize([5, 5]); // => [0, 0]
 */
export function standardize(numbers: ReadonlyArray<number>, options: VarianceOptions = {}): number[] {
	const [values] = scaledSample(numbers);
	const mean = average(values);
	const deviation = standardDeviation(values, options);
	return values.map(function (value) {
		return deviation === 0 ? 0 : (value - mean) / deviation;
	});
}

/**
 * Computes the softmax of some numbers (scores, logits): `exp(x) / Σ exp(x)` for each one, positive weights that add up to `1` and keep
 * the order of the scores. The largest score is subtracted first, which changes nothing mathematically but keeps `exp` from overflowing
 * (`softmax([1000, 1000])` is `[0.5, 0.5]`, where the naive formula gives `NaN`); the exponentials are added up with the compensated
 * {@link sum}. A `-Infinity` score gets a weight of `0` (a masked choice); `Infinity` scores share the whole weight equally.
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} numbers - The scores
 * @returns {number[]} One weight per score, in `[0, 1]`; all `NaN` if a score is `NaN` or every score is `-Infinity`
 * @example
 * softmax([1, 2, 3]); // => [0.09003057317038046, 0.24472847105479764, 0.6652409557748218]
 * softmax([1000, 1000]); // => [0.5, 0.5]
 * softmax([0, -Infinity]); // => [1, 0]
 * softmax([]); // => []
 */
export function softmax(numbers: ReadonlyArray<number>): number[] {
	const values = Array.from(numbers, function (value) {
		return +value;
	});
	const largest = max(values);
	if (largest === Infinity) {
		const infinities = values.filter(function (value) {
			return value === Infinity;
		}).length;
		return values.map(function (value) {
			return value === Infinity ? 1 / infinities : 0;
		});
	}
	// `NaN` (a `NaN` score), or `-Infinity` (every score is, or there are none: then the map is empty).
	if (!(largest > -Infinity)) {
		return values.map(function () {
			return NaN;
		});
	}
	const exponentials = values.map(function (value) {
		return Math.exp(value - largest);
	});
	// At least `1`: the largest score contributes `exp(0)`.
	const total = sum(exponentials);
	return exponentials.map(function (exponential) {
		return exponential / total;
	});
}

/**
 * Computes the exponential moving average of a series: each average is `alpha · value + (1 - alpha) · previous average`, starting from the
 * first value, so recent values weigh more and the weight of older ones decays geometrically. These are the results of pandas'
 * `ewm(alpha=alpha, adjust=False, ignore_na=True).mean()`; for a smoothing over `span` periods (as trading indicators define their EMA), pass
 * `alpha = 2 / (span + 1)`, and for a half-life of `h` periods, `alpha = 1 - 0.5 ** (1 / h)`. Each step is a {@link lerp}, so `alpha = 1`
 * gives the values themselves.
 *
 * A `NaN` value is skipped: its position repeats the previous average (`NaN` before the first number), and the average goes on from there,
 * instead of every later average being `NaN`. An infinite value makes every later average infinite (`NaN` once both infinities were seen).
 * Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} values - The series
 * @param {number} alpha - The smoothing factor, in `(0, 1]`: the weight of the newest value
 * @returns {number[]} One average per value
 * @throws {RangeError} when `alpha` is not in `(0, 1]` (including `NaN`)
 * @throws {TypeError} when `alpha` is not a number
 * @example
 * exponentialMovingAverage([1, 2, 3, 4, 5], 0.5); // => [1, 1.5, 2.25, 3.125, 4.0625]
 * exponentialMovingAverage([NaN, 10, NaN, 20], 0.5); // => [NaN, 10, 10, 15]
 * exponentialMovingAverage([1, 2, 3], 2 / (3 + 1)); // => [1, 1.5, 2.25] // a 3-period EMA
 * exponentialMovingAverage([1, 2], 0); // throws RangeError
 */
export function exponentialMovingAverage(values: ReadonlyArray<number>, alpha: number): number[] {
	assertNumber('exponentialMovingAverage', 'alpha', alpha, alpha > 0 && alpha <= 1, 'a number in (0, 1]');
	const result: number[] = [];
	let current = NaN;
	let started = false;
	for (const item of values) {
		const value = +item;
		if (value === value) {
			current = started ? lerp(current, value, alpha) : value;
			started = true;
		}
		result.push(current);
	}
	return result;
}

/**
 * The descriptive statistics of a sample, as computed by {@link summarize}.
 */
export interface Summary {
	/** The number of values. */
	readonly count: number;
	/** The smallest value, as {@link min} gives it (`Infinity` for no values). */
	readonly min: number;
	/** The largest value, as {@link max} gives it (`-Infinity` for no values). */
	readonly max: number;
	/** The compensated {@link sum} (`0` for no values). */
	readonly sum: number;
	/** The arithmetic mean, as {@link average} gives it. */
	readonly mean: number;
	/** The {@link median}. */
	readonly median: number;
	/** The first quartile, `quantile(numbers, 0.25)`. */
	readonly q1: number;
	/** The third quartile, `quantile(numbers, 0.75)`. */
	readonly q3: number;
	/** The population {@link variance}. */
	readonly variance: number;
	/** The population {@link standardDeviation}. */
	readonly standardDeviation: number;
}

/**
 * Computes the usual descriptive statistics of a sample at once (the count, extremes, sum, mean, median, quartiles, and population
 * variance and standard deviation), as pandas' `describe()` or a box plot needs them. Every field is exactly what the function of the
 * same name gives (`summary.q1` is `quantile(numbers, 0.25)`, `summary.mean` is `average(numbers)`...), but the values are converted and
 * sorted only once. For the sample variance, call {@link variance} with `{ sample: true }`.
 * Values are converted once with unary `+`. With no values, the count and the sum are `0`, `min` and `max` are `Infinity` and `-Infinity`
 * (like `Math.min()` and `Math.max()`), and every other field is `NaN`; a `NaN` value makes every field but `count` `NaN`.
 * @param {ReadonlyArray<number>} numbers - The numbers
 * @returns {Summary} `{ count, min, max, sum, mean, median, q1, q3, variance, standardDeviation }`
 * @example
 * summarize([2, 4, 4, 4, 5, 5, 7, 9]); // => { count: 8, min: 2, max: 9, sum: 40, mean: 5, median: 4.5, q1: 4, q3: 5.5, variance: 4, standardDeviation: 2 }
 * summarize([]).count; // => 0
 */
export function summarize(numbers: ReadonlyArray<number>): Summary {
	const values = Array.from(numbers, function (value) {
		return +value;
	});
	const count = values.length;
	const sorted = sortedCopy(values);
	// `NaN` sorts last.
	const nan = count > 0 && sorted[count - 1] !== sorted[count - 1];
	return {
		count,
		min: nan ? NaN : count === 0 ? Infinity : sorted[0],
		max: nan ? NaN : count === 0 ? -Infinity : sorted[count - 1],
		sum: sum(values),
		mean: average(values),
		median: sortedMedian(sorted),
		q1: sortedQuantile(sorted, 0.25),
		q3: sortedQuantile(sorted, 0.75),
		variance: variance(values),
		standardDeviation: standardDeviation(values)
	};
}

/**
 * Rounds a number to a given number of decimal places with ties to even (banker's rounding, the rounding of IEEE 754 arithmetic, of
 * Python's `round` and of `Intl.NumberFormat` with `roundingMode: 'halfEven'`), so that rounding many values does not drift upwards on
 * average: `2.5` and `1.5` both round to `2`. Like {@link round}, it works on the decimal representation, so values round as written:
 * `roundHalfEven(2.675, 2) === 2.68` and `roundHalfEven(0.125, 2) === 0.12` are ties (Python gives `2.67` for the first, from the binary
 * value of `2.675`, slightly below the tie).
 *
 * Away from ties it gives the same result as {@link round}. Negative `decimals` round to tens, hundreds, etc. The sign of a zero result is
 * kept (`roundHalfEven(-0.5)` is `-0`), and non-finite input (`NaN`, `±Infinity`) is returned as-is.
 * @param {number} input - The number to round (converted with unary `+`)
 * @param {number} [decimals=0] - The number of decimal places to keep (integer, may be negative)
 * @returns {number} The rounded number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * roundHalfEven(2.5); // => 2
 * roundHalfEven(3.5); // => 4
 * roundHalfEven(-2.5); // => -2
 * roundHalfEven(0.125, 2); // => 0.12
 * roundHalfEven(2.675, 2); // => 2.68 // as written: the double is 2.67499999999999982236431605997495353221893310546875
 * roundHalfEven(1.2351, 2); // => 1.24 // not a tie
 * roundHalfEven(250, -2); // => 200
 */
export function roundHalfEven(input: number, decimals = 0): number {
	assertNumber('roundHalfEven', 'decimals', decimals, Number.isInteger(decimals), 'an integer');
	const number = +input;
	// The fast path of `round`: away from a tie, `Math.round` agrees with every rounding to nearest.
	const scale = POWERS_OF_TEN[decimals];
	const scaled = number * scale;
	if (Math.abs(scaled - Math.floor(scaled) - 0.5) > Math.abs(scaled) * 2 ** -46) return Math.round(scaled) / scale;
	if (!Number.isFinite(number) || signedDecimalPlaces(number) <= decimals) return number;
	const negative = 1 / number < 0;
	const rounded = roundDecimalString(Math.abs(number), decimals, true);
	return negative ? -rounded : rounded;
}

/**
 * Rounds a number towards zero to a given number of decimal places, dropping the digits after them: {@link floor} for positive numbers
 * and {@link ceil} for negative ones. Like them, it works on the decimal representation, so values are truncated as written:
 * `trunc(4.35, 2) === 4.35` (the naive `Math.trunc(4.35 * 100) / 100` gives `4.34`). Negative `decimals` truncate to tens, hundreds, etc.
 * Without `decimals` it is exactly `Math.trunc`. The sign of a zero result is kept, and non-finite input is returned as-is.
 * @param {number} number - The number to truncate
 * @param {number} [decimals=0] - The number of decimal places to keep (integer, may be negative)
 * @returns {number} The multiple of `10 ** -decimals` nearest to the number between zero and the number
 * @throws {RangeError} when `decimals` is not an integer
 * @throws {TypeError} when `decimals` is not a number
 * @example
 * trunc(3.99); // => 3
 * trunc(1.239, 2); // => 1.23
 * trunc(-1.239, 2); // => -1.23
 * trunc(4.35, 2); // => 4.35
 * trunc(-4567, -2); // => -4500
 */
export function trunc(number: number, decimals = 0): number {
	// `1 / -0` is `-Infinity`: `-0` takes the negative side, like the negative numbers, where `ceil` moves towards zero.
	return decimals === 0 ? Math.trunc(number) : roundDirected('trunc', 1 / +number < 0 ? Math.ceil : Math.floor, number, decimals);
}

/**
 * Returns the next representable double after `from` in the direction of `to`, with the semantics of C's `nextafter` and Python's
 * `math.nextafter`: `to` itself when the two are equal (so `nextAfter(0, -0)` is `-0`), `NaN` when either is `NaN`, the smallest
 * subnormal of the sign of `to` after a zero, and `±Infinity` after `±Number.MAX_VALUE` (and `±Number.MAX_VALUE` after `±Infinity`).
 * Use it to step over a boundary exactly (the largest value below a limit), or to widen a range by the smallest possible amount.
 * @param {number} from - The starting number
 * @param {number} to - The direction to step in
 * @returns {number} The double adjacent to `from` towards `to`
 * @example
 * nextAfter(1, 2); // => 1.0000000000000002
 * nextAfter(1, 0); // => 0.9999999999999999
 * nextAfter(0, -1); // => -5e-324
 * nextAfter(Number.MAX_VALUE, Infinity); // => Infinity
 * nextAfter(1, 1); // => 1
 */
export function nextAfter(from: number, to: number): number {
	if (from === to || to !== to) return to;
	if (from !== from) return from;
	if (from === 0) return to > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
	const double = new Float64Array([from]);
	// Doubles of one sign are ordered like their bit patterns (see `nextDown`): the magnitude goes up when stepping away from zero.
	new BigInt64Array(double.buffer)[0] += to > from === from > 0 ? 1n : -1n;
	return double[0];
}

/**
 * Returns the unit in the last place of a number: the gap between `|x|` and the next larger double (the spacing of the doubles at that
 * magnitude), with the semantics of Python's `math.ulp`. `ulp(1)` is `Number.EPSILON`; it is `Number.MIN_VALUE` for `0` and the
 * subnormals, and for `Number.MAX_VALUE` (which has no larger double) the gap below it. `±Infinity` gives `Infinity`, `NaN` gives `NaN`.
 * Useful for tolerances that scale with the numbers compared, such as "within 4 ulps".
 * @param {number} x - The number
 * @returns {number} The spacing of the doubles at `|x|` (always `>= 0`)
 * @example
 * ulp(1); // => Number.EPSILON
 * ulp(-1); // => 2.220446049250313e-16
 * ulp(1e16); // => 2
 * ulp(0); // => 5e-324
 */
export function ulp(x: number): number {
	const magnitude = Math.abs(x);
	if (magnitude === Infinity || magnitude !== magnitude) return magnitude;
	const next = nextAfter(magnitude, Infinity);
	// Neighbouring doubles subtract exactly.
	return next === Infinity ? magnitude - nextAfter(magnitude, 0) : next - magnitude;
}

/**
 * Counts the decimal places of a number: the digits after the decimal point in its shortest decimal representation (the one `String`
 * writes, without the noise of the binary value), such as the precision of a step or of user input. Integers have `0`, including those
 * that `String` writes in exponential form (`1e21` and above), and the exponential form of small numbers is expanded (`1e-7` has `7`).
 * `NaN` and `±Infinity` have no decimal places: they give `NaN`.
 * @param {number} value - The number (converted with unary `+`)
 * @returns {number} The number of decimal places, an integer from `0` to `324` (for `5e-324`), or `NaN` when `value` is not finite
 * @example
 * decimalPlaces(1.25); // => 2
 * decimalPlaces(0.1 + 0.2); // => 17 // 0.30000000000000004
 * decimalPlaces(100); // => 0
 * decimalPlaces(1e-7); // => 7
 * decimalPlaces(Infinity); // => NaN
 */
export function decimalPlaces(value: number): number {
	const number = +value;
	if (!Number.isFinite(number)) return NaN;
	return Math.max(0, signedDecimalPlaces(number));
}

/**
 * Finds the fraction closest to a number among those with a denominator up to `maxDenominator`: its best rational approximation, by
 * continued fractions, with the semantics of Python's `Fraction(value).limit_denominator(maxDenominator)`. The number is read as the exact
 * value of its double, so a value that is exactly a fraction with a small enough denominator gives that fraction (`0.75` is `[3, 4]`), and
 * decimals that doubles cannot hold exactly come back as written (`0.1` is `[1, 10]`) as long as `maxDenominator` stays well below the
 * precision of the double (the default, `1_000_000`, does for values up to about a thousand).
 *
 * The fraction is in lowest terms, its denominator is positive and its numerator carries the sign (`toFraction(-x)` is `toFraction(x)`
 * with the numerator negated); `±0` gives `[0, 1]` and an integer `[value, 1]`. Being symmetric, it differs from Python on the rare exact
 * ties of negative values, which Python breaks downwards: `toFraction(-1.5, 1)` is `[-1, 1]` (the candidate nearer zero), where
 * `Fraction(-1.5).limit_denominator(1)` is `-2`. The arithmetic is exact (BigInt), and so are both parts.
 * @param {number} value - The finite number to approximate
 * @param {number} [maxDenominator=1_000_000] - The largest denominator allowed, a safe integer `>= 1`
 * @returns {[number, number]} `[numerator, denominator]`
 * @throws {RangeError} when `value` is not finite, or `maxDenominator` is not a safe integer `>= 1`
 * @throws {TypeError} when `value` or `maxDenominator` is not a number
 * @example
 * toFraction(0.75); // => [3, 4]
 * toFraction(0.1); // => [1, 10]
 * toFraction(1 / 3); // => [1, 3]
 * toFraction(-1.25); // => [-5, 4]
 * toFraction(Math.PI, 1000); // => [355, 113]
 * toFraction(0.333, 10); // => [1, 3]
 * toFraction(Infinity); // throws RangeError
 */
export function toFraction(value: number, maxDenominator = 1_000_000): [number, number] {
	assertNumber('toFraction', 'value', value, Number.isFinite(value), 'a finite number');
	assertNumber('toFraction', 'maxDenominator', maxDenominator, Number.isSafeInteger(maxDenominator) && maxDenominator >= 1, 'a safe integer >= 1');
	// The exact value of the double, `mantissa / 2 ** exponent`, in lowest terms (doubling is exact, and stops as soon as the mantissa is
	// an integer, which is then odd unless the value already was an integer).
	let mantissa = Math.abs(value);
	let exponent = 0;
	for (; !Number.isInteger(mantissa); exponent++) mantissa *= 2;
	const numerator = BigInt(mantissa);
	const denominator = 1n << BigInt(exponent);
	const limit = BigInt(maxDenominator);
	let fraction = [numerator, denominator];
	if (denominator > limit) {
		// The convergents `p1 / q1` of the continued fraction, up to the last one whose denominator fits (Python's algorithm).
		let p0 = 0n;
		let q0 = 1n;
		let p1 = 1n;
		let q1 = 0n;
		let n = numerator;
		let d = denominator;
		for (;;) {
			const a = n / d;
			const q2 = q0 + a * q1;
			if (q2 > limit) break;
			[p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
			[n, d] = [d, n - a * d];
		}
		// The best approximation is that convergent or the semiconvergent with the largest denominator that fits, whichever is closer:
		// they are `1 / (q1 * (q0 + k * q1))` apart, and the convergent is `d / (q1 * denominator)` away from the value (a tie keeps the
		// convergent).
		const k = (limit - q0) / q1;
		fraction = 2n * d * (q0 + k * q1) <= denominator ? [p1, q1] : [p0 + k * p1, q0 + k * q1];
	}
	// `BigInt` has no negative zero, so `-0` gives `0`.
	return [Number(value < 0 ? -fraction[0] : fraction[0]), Number(fraction[1])];
}

/**
 * Computes the relative change from one value to another, as a percentage of the first: `(to - from) / |from| * 100`. Dividing by the
 * magnitude keeps the sign meaningful for negative values (going from `-50` to `-25` is an increase of `50`). When `from` is `0` the
 * change is undefined and `NaN` is returned (rather than `±Infinity`), like {@link percentage}. The difference is multiplied by `100`
 * before it is divided, so that a change that is a simple ratio comes out as the double nearest to it (`3` to `4` is `100 / 3`); in
 * general the result is within a couple of units in the last place of the exact change. It does not overflow when the difference (or
 * `100` times it) does but the change does not.
 * @param {number} from - The original value
 * @param {number} to - The new value
 * @returns {number} The change in percent (negative for a decrease), or `NaN` when `from` is `0`
 * @example
 * percentageChange(50, 75); // => 50
 * percentageChange(80, 60); // => -25
 * percentageChange(-50, -25); // => 50
 * percentageChange(3, 4); // => 33.333333333333336
 * percentageChange(0, 10); // => NaN
 */
export function percentageChange(from: number, to: number): number {
	if (from === 0) return NaN;
	const magnitude = Math.abs(from);
	const difference = to - from;
	if (Number.isFinite(difference)) {
		const hundredfold = difference * 100;
		// `100` times the difference, then divided: dividing first would round twice for the ratio alone (`3` to `4` would be
		// `33.33333333333333`, not the nearest double to 100 / 3).
		if (Number.isFinite(hundredfold)) return hundredfold / magnitude;
	}
	// The difference, or `100` times it, overflowed although both values are finite: work on the values divided by 256 (exactly, for values
	// that large; a tiny `from` makes the change overflow anyway). A non-finite value makes the change `NaN` or infinite.
	return Number.isFinite(from) && Number.isFinite(to) ? ((to / 256 - from / 256) * 100) / (magnitude / 256) : difference / magnitude;
}

/**
 * Options accepted by {@link findRoot}.
 */
export interface FindRootOptions {
	/**
	 * The absolute tolerance on the root, a finite number `>= 0`: the search stops once the root is bracketed within `tolerance` (plus
	 * `4 * Number.EPSILON` times the root, the precision of doubles). `0` finds the root as precisely as doubles allow.
	 * @default 0
	 */
	tolerance?: number;
	/**
	 * The largest number of iterations (one call of `fn` each), a positive integer. The default is far more than any search takes: smooth
	 * functions need 5 to 15 at full precision, and bisection bounds every search to about 260.
	 * @default 1000
	 */
	maxIterations?: number;
}

/**
 * The position of a double in the order of the doubles: its bit pattern read as an integer with the sign of the double, so that adjacent
 * doubles are `1` apart (`-0` and `0` are both `0`). Halving the difference of two positions halves the number of doubles between them:
 * on a bracket within one binade that is the arithmetic midpoint, across binades it is closer to a geometric mean, so bisecting by
 * positions reaches adjacent doubles in at most 64 steps whatever the bracket (halving `[0, 1]` arithmetically takes 1075 to reach `0`).
 * @param {number} value - A finite number
 * @returns {bigint} Its position
 * @example
 * doubleAtPosition((doublePosition(1) + doublePosition(4)) >> 1n); // => 2
 */
function doublePosition(value: number): bigint {
	const pattern = new BigInt64Array(new Float64Array([value]).buffer)[0];
	// A negative double's pattern, as a signed integer, is `-2 ** 63` plus its magnitude's: map it to minus its magnitude's.
	return pattern < 0n ? -(pattern + (1n << 63n)) : pattern;
}

/**
 * The double at a position of {@link doublePosition}.
 * @param {bigint} at - A position, between those of two finite doubles
 * @returns {number} The double
 */
function doubleAtPosition(at: bigint): number {
	const double = new Float64Array(1);
	new BigInt64Array(double.buffer)[0] = at < 0n ? -at : at;
	return at < 0n ? -double[0] : double[0];
}

/** How many iterations of {@link findRoot} may leave the number of doubles in the bracket above half before it is bisected by position. */
const STALLED_ITERATIONS = 3;

/**
 * Calls the function of {@link findRoot} and checks its result.
 * @param {(x: number) => number} fn - The function
 * @param {number} x - The argument
 * @returns {number} `fn(x)`
 * @throws {TypeError} when `fn` returns something other than a number
 * @throws {RangeError} when `fn` returns `NaN`
 */
function evaluateRoot(fn: (x: number) => number, x: number): number {
	const value: unknown = fn(x);
	if (typeof value !== 'number') throw new TypeError(`findRoot: \`fn\` must return a number, got ${describe(value)} for ${x}`);
	if (value !== value) throw new RangeError(`findRoot: \`fn\` must not return NaN, got NaN for ${x}`);
	return value;
}

/**
 * Finds a root of a continuous function (an `x` with `fn(x) === 0`) between two bounds where it has opposite signs, by Brent's method
 * (as in scipy's `brentq` and netlib's `zeroin`): inverse quadratic interpolation and secant steps, which converge superlinearly on
 * smooth functions, safeguarded by bisection, so that the bracket keeps shrinking whatever the function (for a discontinuous one, it
 * finds a point where the sign changes). When the bracket stops halving, it is bisected in the order of the doubles rather than on the
 * number line, so that whatever the function and the bracket (even `[-Number.MAX_VALUE, Number.MAX_VALUE]` around a root next to `0`), the
 * search takes at most about 260 iterations. Use it to invert a function that has no inverse formula: an interest rate from payments, a
 * time from a position on an easing curve, a parameter that hits a target value.
 *
 * The result `x` lies in the bracket, and `fn` changes sign (or is `0`) within `tolerance + 4 · Number.EPSILON · |x|` of it (or between it
 * and an adjacent double): with the default tolerance, a few units in the last place from the root. A bound where `fn` is exactly `0` is
 * returned as is. Each iteration calls `fn` once; smooth functions typically take 5 to 15. Infinite values of `fn` are fine, `NaN` is not.
 * @param {(x: number) => number} fn - A function with opposite signs at `lower` and `upper` (continuous, for a root rather than a sign change)
 * @param {number} lower - One end of the bracket, a finite number
 * @param {number} upper - The other end, a finite number (the bounds can be given in either order)
 * @param {FindRootOptions} [options={}] - `tolerance` (default `0`: full precision) and `maxIterations` (default `1000`)
 * @returns {number} The root
 * @throws {TypeError} when `fn` is not a function or returns something other than a number, or a bound or option is not a number
 * @throws {RangeError} when a bound is not finite, `fn` has the same sign at both bounds or returns `NaN`, an option is out of range, or
 * no root is found within `maxIterations` iterations
 * @example
 * findRoot(function (x) { return x * x - 2; }, 0, 2); // => 1.414213562373095 // √2, to the last digit (Math.SQRT2 is the next double)
 * findRoot(Math.cos, 0, 3); // => Math.PI / 2
 * const root = findRoot(function (x) { return x ** 3 - x - 1; }, 1, 2, { tolerance: 1e-6 });
 * Math.abs(root - 1.324717957244746) < 1e-6; // => true
 * findRoot(function (x) { return x - 3; }, 3, 10); // => 3
 * findRoot(function (x) { return x * x + 1; }, -1, 1); // throws RangeError
 */
export function findRoot(fn: (x: number) => number, lower: number, upper: number, options: FindRootOptions = {}): number {
	assertFunction('findRoot', 'fn', fn);
	assertNumber('findRoot', 'lower', lower, Number.isFinite(lower), 'a finite number');
	assertNumber('findRoot', 'upper', upper, Number.isFinite(upper), 'a finite number');
	const tolerance = readOption(options, 'tolerance', 0);
	const maxIterations = readOption(options, 'maxIterations', 1000);
	assertNumber('findRoot', 'tolerance', tolerance, tolerance >= 0 && tolerance < Infinity, 'a finite number >= 0');
	assertInteger('findRoot', 'maxIterations', maxIterations, 1);
	let a = lower;
	let b = upper;
	let fa = evaluateRoot(fn, a);
	if (fa === 0) return a;
	let fb = evaluateRoot(fn, b);
	if (fb === 0) return b;
	if (fa > 0 === fb > 0) throw new RangeError(`findRoot: \`fn\` must have opposite signs at \`lower\` and \`upper\`, got ${fa} and ${fb}`);
	// Brent's `zeroin`: `b` is the best estimate, `c` the other end of the bracket (`fn` changes sign between `b` and `c`), `a` the
	// previous `b`; `d` is the last step and `e` the one before, against which interpolation steps must make progress.
	let c = a;
	let fc = fa;
	let d = b - a;
	let e = d;
	// The number of doubles in the bracket when it last halved, and the iterations since then (see below).
	let checkpoint = doublePosition(a) - doublePosition(b);
	if (checkpoint < 0n) checkpoint = -checkpoint;
	let stalled = 0;
	for (let iteration = 0; ; iteration++) {
		if (fb > 0 === fc > 0) {
			c = a;
			fc = fa;
			d = b - a;
			e = d;
		}
		if (Math.abs(fc) < Math.abs(fb)) {
			a = b;
			b = c;
			c = a;
			fa = fb;
			fb = fc;
			fc = fa;
		}
		// At least the smallest subnormal, so that a step always moves `b`, even next to a root at `0`.
		const step = Math.max(2 * Number.EPSILON * Math.abs(b) + tolerance / 2, Number.MIN_VALUE);
		const width = c - b;
		// Done once the bracket is within the tolerance (or `b` and `c` are adjacent doubles). The difference of two subnormals is exact,
		// their half may not be: the test is on the width. Halved first when the width overflows (a bracket wider than `Number.MAX_VALUE`).
		if (Math.abs(width) <= Math.max(4 * Number.EPSILON * Math.abs(b) + tolerance, Number.MIN_VALUE) || fb === 0) return b;
		// Checked after the test above, so that the result of the last allowed call of `fn` is still used.
		if (iteration === maxIterations) throw new RangeError(`findRoot: no root found within ${maxIterations} iterations`);
		const middle = Number.isFinite(width) ? width / 2 : c / 2 - b / 2;
		const from = doublePosition(b);
		const to = doublePosition(c);
		const span = from < to ? to - from : from - to;
		if (span <= checkpoint / 2n) {
			checkpoint = span;
			stalled = 0;
		} else {
			stalled++;
		}
		let interpolated = false;
		// Brent's rule makes interpolation steps shrink, but not the bracket: steps towards a root next to `0`, or creeping up on a root
		// of high multiplicity, can each halve while the bracket keeps nearly all its doubles (over a thousand halvings, from `1` to
		// the subnormals). After 3 iterations without halving the number of doubles in the bracket, it is bisected by position.
		if (stalled < STALLED_ITERATIONS && Math.abs(e) >= step && Math.abs(fa) > Math.abs(fb)) {
			// Interpolate: a secant step through `a` and `b`, or an inverse quadratic one through `a`, `b` and `c`. (A difference or a
			// ratio that overflows makes `p` infinite or `NaN`, which fails the test below: the step is then a bisection.)
			const s = fb / fa;
			let p: number;
			let q: number;
			if (a === c) {
				p = 2 * middle * s;
				q = 1 - s;
			} else {
				const r = fb / fc;
				q = fa / fc;
				p = s * (2 * middle * q * (q - r) - (b - a) * (r - 1));
				q = (q - 1) * (r - 1) * (s - 1);
			}
			if (p > 0) q = -q;
			else p = -p;
			// The step must stay well inside the bracket and shrink faster than bisection would over two steps; otherwise bisect.
			if (2 * p < Math.min(3 * middle * q - Math.abs(step * q), Math.abs(e * q))) {
				e = d;
				d = p / q;
				interpolated = true;
			}
		}
		const previous = b;
		if (interpolated) {
			b += Math.abs(d) > step ? d : middle > 0 ? step : -step;
		} else {
			// Bisect: on the number line (which finds a root in the middle of a bracket at once), or by position once stalled. The new point
			// is set directly: adding a step to `b` could round a midpoint next to `0` to `0` itself.
			b = stalled < STALLED_ITERATIONS ? b + middle : doubleAtPosition((from + to) >> 1n);
			d = b - previous;
			e = d;
		}
		a = previous;
		fa = fb;
		fb = evaluateRoot(fn, b);
	}
}

/**
 * Hermite interpolation between two edges, as GLSL's `smoothstep`: `0` up to `edge0`, `1` from `edge1` on, and the S-shaped curve
 * `3t² - 2t³` in between (`t` being the position of `x` between the edges, see {@link inverseLerp}), whose slope is `0` at both edges. For
 * fades, easing a scroll position into an opacity, or soft thresholds.
 *
 * Reversed edges (`edge0 > edge1`) give the mirrored, decreasing curve (`1` up to `edge1`, `0` from `edge0` on), as the GLSL formula
 * does in practice, although the specification leaves it undefined. Equal edges give a step: `0` below the edge, `1` from it on (GLSL's
 * `step`). `x = ±Infinity` gives `0` or `1`, and `NaN` gives `NaN`.
 * @param {number} edge0 - Where the curve starts rising (the result is `0` at and before it)
 * @param {number} edge1 - Where it reaches `1`
 * @param {number} x - The value to interpolate
 * @returns {number} A number in `[0, 1]` (or `NaN`)
 * @throws {RangeError} when an edge is not finite
 * @throws {TypeError} when an edge is not a number
 * @example
 * smoothstep(0, 10, 5); // => 0.5
 * smoothstep(0, 10, 2.5); // => 0.15625
 * smoothstep(0, 10, -3); // => 0
 * smoothstep(10, 0, 2.5); // => 0.84375 // reversed edges: decreasing
 * smoothstep(5, 5, 5); // => 1 // equal edges: a step
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = stepPosition('smoothstep', edge0, edge1, x);
	// Within a few ulps of 1, the rounding of the polynomial can exceed 1.
	return Math.min(t * t * (3 - 2 * t), 1);
}

/**
 * Ken Perlin's smoother variant of {@link smoothstep}: the curve `6t⁵ - 15t⁴ + 10t³`, whose first and second derivatives are both `0` at
 * the edges, so a motion that follows it starts and stops without a jolt. Same edges, clamping and special values as {@link smoothstep}.
 * @param {number} edge0 - Where the curve starts rising (the result is `0` at and before it)
 * @param {number} edge1 - Where it reaches `1`
 * @param {number} x - The value to interpolate
 * @returns {number} A number in `[0, 1]` (or `NaN`)
 * @throws {RangeError} when an edge is not finite
 * @throws {TypeError} when an edge is not a number
 * @example
 * smootherstep(0, 10, 5); // => 0.5
 * smootherstep(0, 10, 2.5); // => 0.103515625
 * smootherstep(0, 10, 12); // => 1
 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
	const t = stepPosition('smootherstep', edge0, edge1, x);
	// Within a few ulps of 1, the rounding of the polynomial can exceed 1 (`smootherstep(0, 1, 0.9999955)` would be `1.0000000000000009`).
	return Math.min(t * t * t * (t * (6 * t - 15) + 10), 1);
}

/**
 * The position of `x` between two edges, clamped to `[0, 1]`, shared by {@link smoothstep} and {@link smootherstep}: a step when the
 * edges are equal, and {@link inverseLerp} otherwise (which neither overflows nor loses the direction of a reversed range).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} edge0 - The edge mapped to `0`
 * @param {number} edge1 - The edge mapped to `1`
 * @param {number} x - The value
 * @returns {number} The clamped position (`NaN` for a `NaN` value)
 * @throws {RangeError} when an edge is not finite
 * @throws {TypeError} when an edge is not a number
 */
function stepPosition(caller: string, edge0: number, edge1: number, x: number): number {
	assertNumber(caller, 'edge0', edge0, Number.isFinite(edge0), 'a finite number');
	assertNumber(caller, 'edge1', edge1, Number.isFinite(edge1), 'a finite number');
	// Equal edges: a step (`NaN` is neither below nor at or above the edge).
	if (edge0 === edge1) return x < edge0 ? 0 : x >= edge0 ? 1 : NaN;
	const t = inverseLerp(edge0, edge1, x);
	// Plain comparisons: `NaN` fails both and is returned.
	return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/**
 * Moves `current` towards `target` by exponential decay over `deltaTime`, independently of the frame rate: two steps of `deltaTime / 2`
 * land where one step of `deltaTime` does (up to rounding), which `lerp(current, target, 0.1)` called once per frame does not (it is twice
 * as fast at 120 fps as at 60 fps). This is the `lerp(current, target, 1 - exp(-lambda * deltaTime))` of game engines, with
 * `1 - exp(-x)` computed as `-expm1(-x)`, so that tiny steps are not rounded away.
 *
 * `lambda` is the decay rate: after `1 / lambda` units of time, about 63% of the distance is covered (`ln(2) / lambda` is the half-life).
 * The result always lies between `current` and `target` and never overshoots. It is exactly `target` when `lambda * deltaTime` is large,
 * and a step too small to change `current` (one below half an ulp, close to the target) moves it by an ulp instead, so repeated steps reach
 * `target` exactly and an animation that waits for `value === target` ends: rounding to nearest alone can leave the value a few ulps short
 * forever.
 * @param {number} current - The current value
 * @param {number} target - The value to approach
 * @param {number} lambda - The decay rate per unit of time, a finite number `>= 0` (`0` never moves)
 * @param {number} deltaTime - The time elapsed since the last step, a finite number `>= 0`, in the unit of `lambda`
 * @returns {number} The new value, between `current` and `target`
 * @throws {RangeError} when `lambda` or `deltaTime` is negative or not finite
 * @throws {TypeError} when `lambda` or `deltaTime` is not a number
 * @example
 * damp(0, 100, Math.LN2, 1); // => 50 // half the distance after one half-life
 * damp(0, 100, 5, 0); // => 0
 * damp(0, 100, 5, 100); // => 100
 * damp(0, 1, 1e-17, 1); // => 1e-17 // 1 - Math.exp(-1e-17) is 0: the step would be lost
 */
export function damp(current: number, target: number, lambda: number, deltaTime: number): number {
	assertNumber('damp', 'lambda', lambda, lambda >= 0 && lambda < Infinity, 'a finite number >= 0');
	assertNumber('damp', 'deltaTime', deltaTime, deltaTime >= 0 && deltaTime < Infinity, 'a finite number >= 0');
	const factor = -Math.expm1(-lambda * deltaTime);
	// A safety net: no rounding of `(1 - t) * current + t * target` past an end has been found, but the guarantee is cheap.
	const result = Math.min(Math.max(lerp(current, target, factor), Math.min(current, target)), Math.max(current, target));
	// `(1 - t) * current + t * target` rounds back to `current` a few ulps from the target (`damp(x, 1, 10, 1 / 60)` stops at
	// `0.9999999999999991`): move by one ulp, which is within an ulp of the exact step and can only end at `target`.
	if (result !== current || factor === 0 || current === target || !Number.isFinite(current)) return result;
	return current < target ? -nextDown(-current) : nextDown(current);
}

/**
 * The shortest signed rotation from one angle to another: the value of `(-period / 2, period / 2]` congruent to `to - from` modulo the
 * period, as Unity's `DeltaAngle` (`angleDifference(350, 10) === 20`, not `-340`). Degrees by default; pass `2 * Math.PI` as the period
 * for radians, or any other period (`24` for hours on a clock). A half turn is `+period / 2`.
 *
 * Both angles are reduced modulo the period first (with the exact `%`), so angles accumulated over many turns lose no precision in the
 * subtraction. A zero difference is `+0`, and `NaN` or `±Infinity` angles give `NaN`.
 * @param {number} from - The starting angle
 * @param {number} to - The target angle
 * @param {number} [period=360] - The size of a full turn, a finite number `> 0`
 * @returns {number} The signed difference, in `(-period / 2, period / 2]`
 * @throws {RangeError} when `period` is not a finite number `> 0`
 * @throws {TypeError} when `period` is not a number
 * @example
 * angleDifference(350, 10); // => 20
 * angleDifference(10, 350); // => -20
 * angleDifference(0, 180); // => 180
 * angleDifference(0, 540); // => 180
 * angleDifference(0, (3 * Math.PI) / 2, 2 * Math.PI) === -Math.PI / 2; // => true
 */
export function angleDifference(from: number, to: number, period = 360): number {
	return shortestRotation('angleDifference', from, to, period);
}

/**
 * The shortest rotation from `from` to `to` (see {@link angleDifference}).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} from - The starting angle
 * @param {number} to - The target angle
 * @param {number} period - The size of a full turn
 * @returns {number} The signed difference, in `(-period / 2, period / 2]`
 * @throws {RangeError} when `period` is not a finite number `> 0`
 * @throws {TypeError} when `period` is not a number
 */
function shortestRotation(caller: string, from: number, to: number, period: number): number {
	assertNumber(caller, 'period', period, period > 0 && period < Infinity, 'a finite number > 0');
	// The remainders are exact and lie in `(-period, period)`, so their difference cannot overflow. Wrapping into `[0, period)` and then
	// subtracting the period from the upper half (exactly: both are within a factor 2 of each other) gives `(-period / 2, period / 2]`
	// without `±period / 2` bounds, which a subnormal period would round to 0.
	const turn = wrap((to % period) - (from % period), 0, period);
	// `+ 0` turns `-0` into `0`; `NaN` fails the comparison and is returned.
	return (turn > period / 2 ? turn - period : turn) + 0;
}

/**
 * Interpolates between two angles along the shortest arc: `start + angleDifference(start, end) * t`, as Unity's `LerpAngle` (without its
 * clamping of `t`) and Godot's `lerp_angle`: from 350° to 10° it goes up through 360°, not down through 180°. Degrees by default; pass
 * `2 * Math.PI` as the period for radians.
 *
 * The result is not wrapped, so it moves continuously with `t` and can be fed to a rotation without a jump: `lerpAngle(350, 10, 1)` is
 * `370`, the same direction as `10` (wrap it with {@link wrap} for `[0, 360)`). `t = 0` gives exactly `start`, and `t` outside `[0, 1]`
 * extrapolates. Opposite angles are half a turn apart either way; the rotation is then positive.
 * @param {number} start - The angle at `t = 0`
 * @param {number} end - The angle at `t = 1` (modulo the period)
 * @param {number} t - Interpolation factor
 * @param {number} [period=360] - The size of a full turn, a finite number `> 0`
 * @returns {number} The interpolated angle, unwrapped
 * @throws {RangeError} when `period` is not a finite number `> 0`
 * @throws {TypeError} when `period` is not a number
 * @example
 * lerpAngle(350, 10, 0.5); // => 360
 * lerpAngle(350, 10, 1); // => 370
 * lerpAngle(10, 350, 0.5); // => 0
 * lerpAngle(0, 90, 0.5); // => 45
 * wrap(lerpAngle(350, 10, 0.75), 0, 360); // => 5
 */
export function lerpAngle(start: number, end: number, t: number, period = 360): number {
	const rotation = shortestRotation('lerpAngle', start, end, period);
	return t === 0 ? start : start + rotation * t;
}

/**
 * Bounces a value back and forth between `0` and `length`, as Unity's `Mathf.PingPong`: a triangle wave that rises from `0` to `length`
 * as `value` goes from `0` to `length`, falls back to `0` at `2 * length`, and so on. For animations driven by a time that only grows
 * (a pulsing glow, a patrolling sprite), or to reflect an index at the ends of a range. Negative values mirror positive ones.
 *
 * The value is reduced with the exact {@link modulo} of `2 * length`, and the falling half is `2 * length` minus the reduced value, which
 * is exact too, so `pingPong(0.1, 3)` is `0.1` (where `length - |value mod 2·length - length|` gives `0.10000000000000009`). `NaN` and
 * `±Infinity` give `NaN`.
 * @param {number} value - The ever-changing input (typically a time)
 * @param {number} length - The top of the bounce, a finite number `> 0`
 * @returns {number} A number in `[0, length]`
 * @throws {RangeError} when `length` is not a finite number `> 0`
 * @throws {TypeError} when `length` is not a number
 * @example
 * pingPong(2, 3); // => 2
 * pingPong(4, 3); // => 2
 * pingPong(6, 3); // => 0
 * pingPong(7.5, 3); // => 1.5
 * pingPong(-1, 3); // => 1
 * pingPong(0.1, 3); // => 0.1
 */
export function pingPong(value: number, length: number): number {
	assertNumber('pingPong', 'length', length, length > 0 && length < Infinity, 'a finite number > 0');
	const cycle = 2 * length;
	// A cycle beyond `Number.MAX_VALUE`: halving the value and the length is exact for such a large length (and for any value that is not
	// subnormal; a subnormal one is then off by at most the smallest subnormal).
	if (cycle === Infinity) return 2 * pingPong(value / 2, length / 2);
	const phase = modulo(value, cycle);
	// `cycle - phase` is exact for `phase` in `[length, cycle)` (Sterbenz), and `NaN` fails the comparison and is returned.
	return phase > length ? cycle - phase : phase;
}

/**
 * Options accepted by {@link linspace}.
 */
export interface LinspaceOptions {
	/**
	 * Whether `end` is the last value (`count - 1` intervals), or the end of the last interval, excluded (`count` intervals), as in NumPy:
	 * `linspace(0, 1, 4, { endpoint: false })` is `[0, 0.25, 0.5, 0.75]`, the sample positions of a periodic signal.
	 * @default true
	 */
	readonly endpoint?: boolean;
}

/**
 * The largest `count` of {@link linspace}: 2 ** 24 (16,777,216) numbers take about 130 MB. An uncapped count, such as one read from a query
 * string, could make the runtime abort with an out-of-memory error, which cannot be caught.
 */
const MAX_LINSPACE = 16_777_216;

/**
 * Returns `count` evenly spaced numbers from `start` to `end`, as NumPy's `linspace`: for chart axes, sampling a function, gradient stops
 * or animation keyframes. Unlike adding a step repeatedly (or `range(0, 1.1, 0.1)`), each value is computed from its index as
 * `start + (end - start) * i / (count - 1)`, so errors do not accumulate, the first value is exactly `start`, the last one exactly `end`,
 * and fractions come out as written (`linspace(0, 1, 11)` holds `0.3`, not `0.30000000000000004`).
 *
 * The values are monotonic (increasing, or decreasing when `end < start`) and never leave `[start, end]`, even when the span exceeds
 * `Number.MAX_VALUE`. A single value is `[start]`, and none is `[]`.
 * @param {number} start - The first value, a finite number
 * @param {number} end - The last value (or, with `{ endpoint: false }`, the excluded end), a finite number
 * @param {number} count - How many values, an integer from 0 to 2 ** 24
 * @param {LinspaceOptions} [options={}] - `endpoint` (default `true`): whether `end` is included
 * @returns {number[]} The values
 * @throws {RangeError} when `start` or `end` is not finite, or `count` is not an integer from 0 to 2 ** 24
 * @throws {TypeError} when `start`, `end` or `count` is not a number
 * @example
 * linspace(0, 1, 5); // => [0, 0.25, 0.5, 0.75, 1]
 * linspace(0, 1, 11)[3]; // => 0.3
 * linspace(10, 0, 3); // => [10, 5, 0]
 * linspace(0, 1, 4, { endpoint: false }); // => [0, 0.25, 0.5, 0.75]
 * linspace(2, 5, 1); // => [2]
 * linspace(0, 1, -1); // throws RangeError
 */
export function linspace(start: number, end: number, count: number, options: LinspaceOptions = {}): number[] {
	const endpoint = readOption(options, 'endpoint') !== false;
	assertNumber('linspace', 'start', start, Number.isFinite(start), 'a finite number');
	assertNumber('linspace', 'end', end, Number.isFinite(end), 'a finite number');
	assertNumber('linspace', 'count', count, Number.isInteger(count) && count >= 0 && count <= MAX_LINSPACE, `an integer between 0 and ${MAX_LINSPACE}`);
	const result: number[] = count === 0 ? [] : [start];
	const intervals = endpoint ? count - 1 : count;
	// When the bounds are further apart than `Number.MAX_VALUE`, their halves are used (exactly: such bounds are far from the subnormals).
	const scale = Number.isFinite(end - start) ? 1 : 0.5;
	const first = start * scale;
	const span = end * scale - first;
	// `(span * i) / intervals` is correctly rounded (`0.3` rather than `0.30000000000000004` for 3 tenths), unless it can overflow.
	const exact = Number.isFinite(span * intervals);
	// The offsets grow with `i` (each rounding is monotonic) and stay below the rounded span for every `i < intervals` (each rounding is off by
	// less than `2 ** -52` of the span, and the last interval is a fraction `1 / intervals` of it, `intervals` being below `2 ** 52`), so no
	// value but the one at `end` can round beyond it. That one is set to `end` exactly.
	for (let i = 1; i < count; i++) result.push((first + (exact ? (span * i) / intervals : (span / intervals) * i)) / scale);
	if (endpoint && count > 1) result[count - 1] = end;
	return result;
}

/**
 * The largest `count` of {@link ticks} and {@link niceDomain}: they produce at most about `1.6 * count + 2` ticks, and a count of 2 ** 20
 * already makes far more than any axis can show. An uncapped count, such as one read from a query string, could make the runtime abort with
 * an out-of-memory error, which cannot be caught.
 */
const MAX_TICKS = 1_048_576;

/** `√50`, `√10` and `√2`: the geometric means of the neighbouring nice factors 10, 5, 2 and 1, d3's thresholds for picking one. */
const TICK_THRESHOLDS: readonly [number, number, number] = [Math.sqrt(50), Math.sqrt(10), Math.sqrt(2)];

/**
 * Picks the tick step of an increasing domain, as d3-array's `tickSpec`: the power of ten of `span / count`, times 1, 2, 5 or 10, whichever
 * is nearest on a logarithmic scale. A step below 1 is returned as a negative inverse (`-5` for a step of `0.2`): the ticks are then
 * computed as `i / 5`, which is correctly rounded (`0.6`), where `i * 0.2` is not (`0.6000000000000001`). The step is kept within the
 * doubles (a subnormal, or `1e308`) for domains whose `span / count` underflows or overflows.
 * @param {number} start - The lower bound, finite
 * @param {number} stop - The upper bound, finite and greater than `start`
 * @param {number} count - The approximate number of ticks wanted, a number `> 0`
 * @returns {[number, number, number]} The indices of the first and last ticks inside the domain, and the step (negative: its inverse)
 * @example
 * tickSpec(0, 1, 5); // => [0, 5, -5]
 */
function tickSpec(start: number, stop: number, count: number): [number, number, number] {
	const span = stop - start;
	const step = Math.min(Math.max(Number.isFinite(span) ? span / count : stop / count - start / count, Number.MIN_VALUE), Number.MAX_VALUE);
	// `10 ** -324` is 0: the smallest power used is `10 ** -323` (a subnormal, about twice `Number.MIN_VALUE`).
	const power = Math.max(Math.floor(Math.log10(step)), -323);
	const error = step / 10 ** power;
	const factor = error >= TICK_THRESHOLDS[0] ? 10 : error >= TICK_THRESHOLDS[1] ? 5 : error >= TICK_THRESHOLDS[2] ? 2 : 1;
	let first: number;
	let last: number;
	let increment: number;
	// Steps below 1 divide by their inverse, except below `1e-308`, where `10 ** -power` overflows: the subnormal step multiplies then.
	const inverse = 10 ** -power / factor;
	if (power < 0 && inverse < Infinity) {
		first = Math.round(start * inverse);
		last = Math.round(stop * inverse);
		// The same expressions as the ticks themselves, so that the first and last ticks are inside the domain.
		if (first / inverse < start) first++;
		if (last / inverse > stop) last--;
		increment = -inverse;
	} else {
		// `2e308` overflows: a step of `1e308` gives at most four ticks over the whole range of doubles anyway.
		increment = 10 ** power * factor;
		if (increment === Infinity) increment = 10 ** power;
		first = Math.round(start / increment);
		last = Math.round(stop / increment);
		if (first * increment < start) first++;
		if (last * increment > stop) last--;
	}
	// No tick fits a domain asked for one tick or so: d3 asks for twice as many.
	if (last < first && count >= 0.5 && count < 2) return tickSpec(start, stop, count * 2);
	return [first, last, increment];
}

/**
 * Validates the arguments of {@link ticks} and {@link niceDomain}.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} start - One end of the domain
 * @param {number} stop - The other end
 * @param {number} count - The approximate number of ticks
 * @returns {void}
 * @throws {RangeError} when a bound is not finite, or `count` is not a number in `(0, 2 ** 20]`
 * @throws {TypeError} when an argument is not a number
 */
function assertTickDomain(caller: string, start: number, stop: number, count: number): void {
	assertNumber(caller, 'start', start, Number.isFinite(start), 'a finite number');
	assertNumber(caller, 'stop', stop, Number.isFinite(stop), 'a finite number');
	assertNumber(caller, 'count', count, count > 0 && count <= MAX_TICKS, `a number > 0 and <= ${MAX_TICKS}`);
}

/**
 * Returns round, human-friendly values for the ticks of a chart axis over `[start, stop]`, as d3's `ticks`: multiples of a step of
 * `1`, `2` or `5` times a power of ten, chosen so that there are about `count` of them (the result can hold somewhat more or fewer). Values
 * print as written: below 1 they are computed by dividing by the inverse of the step, so `ticks(0, 1, 10)` holds `0.3`, not
 * `0.30000000000000004`.
 *
 * Every tick lies inside the domain (its bounds are ticks only when they are round), in the order of the domain: decreasing when
 * `stop < start`. A domain of one value gives that value, and a domain too narrow for any round value gives `[]`. Pair it with
 * {@link niceDomain} to extend the domain to round bounds first, so that the axis starts and ends with a tick.
 * @param {number} start - One end of the domain, a finite number
 * @param {number} stop - The other end, a finite number
 * @param {number} [count=10] - The approximate number of ticks wanted, a number in `(0, 2 ** 20]` (not necessarily an integer)
 * @returns {number[]} The ticks, in the order of the domain
 * @throws {RangeError} when a bound is not finite, or `count` is not a number in `(0, 2 ** 20]`
 * @throws {TypeError} when an argument is not a number
 * @example
 * ticks(0, 10, 5); // => [0, 2, 4, 6, 8, 10]
 * ticks(0, 1, 5); // => [0, 0.2, 0.4, 0.6, 0.8, 1]
 * ticks(-3.7, 12.1, 4); // => [0, 5, 10]
 * ticks(1, 0, 2); // => [1, 0.5, 0]
 * ticks(0, 1, 10)[3]; // => 0.3
 * ticks(5, 5); // => [5]
 */
export function ticks(start: number, stop: number, count = 10): number[] {
	assertTickDomain('ticks', start, stop, count);
	if (start === stop) return [start];
	const reverse = stop < start;
	const low = reverse ? stop : start;
	const high = reverse ? start : stop;
	const [first, last, increment] = tickSpec(low, high, count);
	const result: number[] = [];
	// Counted with `k`: beyond `2 ** 53` (a step finer than the precision of the domain) `first + k` can stop growing. Such ticks are not
	// distinct, and are only kept when they are inside the domain and above the previous one.
	for (let k = 0; k <= last - first; k++) {
		const index = first + k;
		const tick = increment < 0 ? index / -increment : index * increment;
		if (tick >= low && tick <= high && !(tick <= result[result.length - 1])) result.push(tick);
	}
	return reverse ? result.reverse() : result;
}

/**
 * Extends a domain to round bounds, as d3's `scale.nice()`: each bound moves outwards to the nearest multiple of the {@link ticks} step,
 * repeatedly, until the step no longer changes (at most 10 times), so that an axis over the result starts and ends with a tick
 * (`niceDomain(0.201, 0.996)` is `[0.2, 1]`). The bounds are computed with the same expressions as the ticks, so
 * `ticks(...niceDomain(a, b, n), n)` starts and ends exactly with them, and a domain that is already nice is returned as is (d3 floors the
 * rounded quotients, which can move a bound that is already round out by a step, or in by an ulp).
 *
 * The result always contains the domain and keeps its direction: a decreasing domain stays decreasing. A domain of one value is returned as
 * is, and the bounds never go beyond `±Number.MAX_VALUE`. With a `count` below 2, widening the bounds can double the step every round, as in
 * d3: the result is then the bounds of the tenth round, which are not always ticks.
 * @param {number} start - One end of the domain, a finite number
 * @param {number} stop - The other end, a finite number
 * @param {number} [count=10] - The approximate number of ticks wanted, a number in `(0, 2 ** 20]`
 * @returns {[number, number]} The extended `[start, stop]`
 * @throws {RangeError} when a bound is not finite, or `count` is not a number in `(0, 2 ** 20]`
 * @throws {TypeError} when an argument is not a number
 * @example
 * niceDomain(0.201, 0.996); // => [0.2, 1]
 * niceDomain(-3.7, 12.1, 4); // => [-5, 15]
 * niceDomain(130, 2, 5); // => [140, 0]
 * niceDomain(3, 3); // => [3, 3]
 */
export function niceDomain(start: number, stop: number, count = 10): [number, number] {
	assertTickDomain('niceDomain', start, stop, count);
	const reverse = stop < start;
	let low = reverse ? stop : start;
	let high = reverse ? start : stop;
	let previous = 0;
	for (let pass = 0; pass < 10 && low < high; pass++) {
		const increment = tickSpec(low, high, count)[2];
		if (increment === previous) break;
		previous = increment;
		// The bounds go to the nearest tick, moved out by a step when that is inside the domain: with the same expressions as the ticks, so
		// that a bound that is already a tick stays (flooring `low * inverse` would move it out whenever the product rounds up).
		let nextLow: number;
		let nextHigh: number;
		if (increment < 0) {
			const inverse = -increment;
			let first = Math.round(low * inverse);
			let last = Math.round(high * inverse);
			if (first / inverse > low) first--;
			if (last / inverse < high) last++;
			nextLow = first / inverse;
			nextHigh = last / inverse;
		} else {
			let first = Math.round(low / increment);
			let last = Math.round(high / increment);
			if (first * increment > low) first--;
			if (last * increment < high) last++;
			nextLow = first * increment;
			nextHigh = last * increment;
		}
		// Beyond `2 ** 53` steps from zero (a step finer than the precision of the bounds), moving an index by one can leave it unchanged:
		// the bounds then stay where they are rather than move inwards. Nor do they go beyond the doubles.
		// (`+ 0` turns a `-0` bound, which the ticks write `0`, into `0`.)
		low = Math.max(Math.min(nextLow, low), -Number.MAX_VALUE) + 0;
		high = Math.min(Math.max(nextHigh, high), Number.MAX_VALUE) + 0;
	}
	return reverse ? [high, low] : [low, high];
}

/** Veltkamp's splitting constant, `2 ** 27 + 1`: `x * SPLITTER` cuts a double into two halves of at most 26 bits, whose products are exact. */
const SPLITTER = 134217729;

/**
 * Converts the elements of a vector once with unary `+` (the conversion of the aggregates of this module), into a typed array.
 * @param {ReadonlyArray<number>} numbers - The vector
 * @returns {Float64Array} The converted elements
 */
function toFloat64(numbers: ReadonlyArray<number>): Float64Array {
	const values = new Float64Array(numbers.length);
	for (let i = 0; i < values.length; i++) values[i] = +numbers[i];
	return values;
}

/**
 * The power of two that brings the largest magnitude of some values close to `1`, as {@link scaledSample} picks it: between `2 ** -1000`
 * and `2 ** 1000`, so that the scaled values are normal doubles, and `1` when that magnitude is `0` or not finite.
 * @param {Float64Array} values - The values
 * @returns {number} The scale
 */
function vectorScale(values: Float64Array): number {
	let largest = 0;
	// `NaN` once a value is `NaN`.
	for (let i = 0; i < values.length; i++) largest = Math.max(largest, Math.abs(values[i]));
	return largest > 0 && largest < Infinity ? 2 ** Math.min(1000, Math.max(-1000, -Math.floor(Math.log2(largest)))) : 1;
}

/**
 * Ogita, Rump and Oishi's `Dot2` on two vectors scaled by powers of two (exactly, so that their values are at most about 2 in magnitude):
 * a dot product as accurate as if it were computed in twice the precision of doubles, then rounded. Each product is split exactly into
 * `high + low` (Dekker's TwoProduct with Veltkamp's splitting, since JavaScript has no fused multiply-add, which needs values below about
 * `2 ** 996`), the high parts are added with Knuth's TwoSum, and every error term goes into a second sum. A value that is not finite makes
 * the result `NaN`.
 * @param {Float64Array} xs - The first vector
 * @param {number} scaleX - The power of two its values are multiplied by
 * @param {Float64Array} ys - The second vector, as long as `xs`
 * @param {number} scaleY - The power of two its values are multiplied by
 * @returns {number} The dot product of the scaled vectors
 */
function dot2(xs: Float64Array, scaleX: number, ys: Float64Array, scaleY: number): number {
	let high = 0;
	let low = 0;
	for (let i = 0; i < xs.length; i++) {
		const x = xs[i] * scaleX;
		const y = ys[i] * scaleY;
		const productHigh = x * y;
		let split = SPLITTER * x;
		const xHigh = split - (split - x);
		const xLow = x - xHigh;
		split = SPLITTER * y;
		const yHigh = split - (split - y);
		const yLow = y - yHigh;
		// `productHigh + productLow` is exactly `x * y` (unless it underflows).
		const productLow = xLow * yLow - (productHigh - xHigh * yHigh - xLow * yHigh - xHigh * yLow);
		// `sumHigh + sumLow` is exactly `high + productHigh`.
		const sumHigh = high + productHigh;
		const virtual = sumHigh - high;
		const sumLow = high - (sumHigh - virtual) + (productHigh - virtual);
		high = sumHigh;
		low += sumLow + productLow;
	}
	return high + low;
}

/**
 * Throws unless two vectors have the same length.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<number>} xs - The first vector
 * @param {ReadonlyArray<number>} ys - The second vector
 * @returns {void}
 * @throws {RangeError} when `xs` and `ys` have different lengths
 */
function assertSameLength(caller: string, xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): void {
	if (xs.length !== ys.length) throw new RangeError(`${caller}: \`xs\` and \`ys\` must have the same length, got ${xs.length} and ${ys.length}`);
}

/**
 * Computes the dot (scalar) product of two vectors, `Σ xs[i] · ys[i]`, as accurately as if it were computed in twice the precision of
 * doubles and then rounded (Ogita, Rump and Oishi's `Dot2`), so that products that cancel do not wipe out the result:
 * `dot([1e16, 1, -1e16], [1, 1, 1])` is `1`, where the plain loop gives `0`. The error is at most about an ulp of the result plus
 * `n² · 2 ** -106` times `Σ |xs[i] · ys[i]|`, for `n` elements. When a product or the sum overflows, or the result is so small (below
 * `2 ** -900`) that the rounding of products below the normal doubles could matter, it is computed again on both vectors scaled by powers of
 * two (exactly), so that only a result beyond the doubles overflows. About five times as slow as the plain loop on long vectors.
 *
 * Values are converted once with unary `+`. When one is not finite, the result is the IEEE sum of the products (`Infinity`, `-Infinity` or
 * `NaN`), without the spurious `Infinity - Infinity` of products that overflow.
 * @param {ReadonlyArray<number>} xs - The first vector
 * @param {ReadonlyArray<number>} ys - The second vector, as long as `xs`
 * @returns {number} The dot product (`0` for empty vectors)
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * dot([1, 2, 3], [4, 5, 6]); // => 32
 * dot([1e16, 1, -1e16], [1, 1, 1]); // => 1 // the plain loop gives 0
 * dot([1e200, 1e200], [1e200, -1e200]); // => 0 // the plain loop gives NaN (Infinity - Infinity)
 * dot([Infinity, 1e200], [1, -1e200]); // => Infinity
 * dot([], []); // => 0
 * dot([1, 2], [1]); // throws RangeError
 */
export function dot(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
	assertSameLength('dot', xs, ys);
	const x = toFloat64(xs);
	const y = toFloat64(ys);
	// Scaling each vector by its largest magnitude would flush values far smaller than it (`dot([1e300, 1e-300], [1e-300, 1e300])` is `2`),
	// so the products are first taken as they are: an overflow makes the result infinite or `NaN` (`Infinity - Infinity`).
	const direct = dot2(x, 1, y, 1);
	if (Math.abs(direct) >= 2 ** -900 && Math.abs(direct) < Infinity) return direct;
	const scaleX = vectorScale(x);
	const scaleY = vectorScale(y);
	const scaled = dot2(x, scaleX, y, scaleY);
	if (scaled !== scaled) {
		// A value is not finite (its vector's scale is then 1): the plain sum of the scaled products, where an infinity or a `NaN` decides.
		let total = 0;
		for (let i = 0; i < x.length; i++) total += x[i] * scaleX * (y[i] * scaleY);
		return total;
	}
	// Scaled back by the smaller scale first: the intermediate result grows, so it cannot underflow before the final one does.
	return scaled / Math.min(scaleX, scaleY) / Math.max(scaleX, scaleY);
}

/**
 * The Euclidean norm of some values, computed on the values scaled by a power of two (so that the squares neither overflow nor underflow)
 * with the accurate {@link dot2}, with the semantics of `Math.hypot` for values that are not finite: an infinity gives `Infinity`, even
 * next to a `NaN`.
 * @param {Float64Array} values - The values
 * @returns {number} `√(Σ values[i]²)`
 */
function euclideanNorm(values: Float64Array): number {
	const scale = vectorScale(values);
	const squares = dot2(values, scale, values, scale);
	if (squares === squares) return Math.sqrt(squares) / scale;
	return values.some(function (value) {
		return value === Infinity || value === -Infinity;
	})
		? Infinity
		: NaN;
}

/**
 * Computes the Euclidean length (L2 norm) of a vector, `√(Σ xs[i]²)`, like `Math.hypot(...xs)` but for arrays of any length (without
 * spreading) and more accurately: the squares are added as if in twice the precision of doubles (see {@link dot}), on the values scaled by a
 * power of two, so it neither overflows nor underflows unless the length itself does (`norm([1e200, 1e200])` is `1.414213562373095e200`,
 * where the square root of the summed squares is `Infinity`).
 *
 * Values are converted once with unary `+`. As with `Math.hypot`, an infinite value gives `Infinity` (even next to a `NaN`), and otherwise a
 * `NaN` gives `NaN`.
 * @param {ReadonlyArray<number>} xs - The vector
 * @returns {number} Its length (`0` for an empty vector)
 * @example
 * norm([3, 4]); // => 5
 * norm([1, 2, 2]); // => 3
 * norm([1e200, 1e200]); // => 1.414213562373095e200
 * norm([]); // => 0
 * norm([NaN, -Infinity]); // => Infinity
 */
export function norm(xs: ReadonlyArray<number>): number {
	return euclideanNorm(toFloat64(xs));
}

/**
 * Computes the Euclidean distance between two points given as coordinate arrays, `√(Σ (xs[i] - ys[i])²)`, as Python's `math.dist`, in any
 * number of dimensions: each difference is rounded once, then their {@link norm} is taken (accurate, and safe from overflow and
 * underflow). Differences that overflow (`1e308 - -1e308`) are taken on halved coordinates instead, so the distance is only `Infinity` when it
 * is beyond the doubles. It is symmetric (`distance(a, b) === distance(b, a)`).
 *
 * Coordinates are converted once with unary `+`. An infinite difference gives `Infinity` (even next to a `NaN`), and otherwise a `NaN`
 * gives `NaN` (`Infinity - Infinity` is `NaN`).
 * @param {ReadonlyArray<number>} xs - The coordinates of the first point
 * @param {ReadonlyArray<number>} ys - The coordinates of the second point, as many as `xs`
 * @returns {number} The distance (`0` for points without coordinates)
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * distance([0, 0], [3, 4]); // => 5
 * distance([1, 2, 3], [1, 2, 3]); // => 0
 * distance([-8e307], [8e307]); // => 1.6e308
 * distance([-1e308], [1e308]); // => Infinity // 2e308 is beyond the doubles
 * distance([1, 2], [1]); // throws RangeError
 */
export function distance(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
	assertSameLength('distance', xs, ys);
	const x = toFloat64(xs);
	const y = toFloat64(ys);
	const differences = new Float64Array(x.length);
	let overflow = false;
	for (let i = 0; i < x.length; i++) {
		differences[i] = x[i] - y[i];
		if (!Number.isFinite(differences[i]) && Number.isFinite(x[i]) && Number.isFinite(y[i])) overflow = true;
	}
	if (!overflow) return euclideanNorm(differences);
	// Halving is exact for coordinates that are not subnormal (a subnormal one is then off by at most the smallest subnormal, negligible next
	// to a difference beyond `Number.MAX_VALUE`).
	for (let i = 0; i < x.length; i++) differences[i] = x[i] / 2 - y[i] / 2;
	return 2 * euclideanNorm(differences);
}

/**
 * Computes the cosine similarity of two vectors, `dot(xs, ys) / (|xs| · |ys|)`: the cosine of the angle between them, from `-1` (opposite)
 * through `0` (orthogonal) to `1` (same direction), whatever their lengths. The usual measure of how close two text embeddings are.
 *
 * Both vectors are scaled by powers of two first (which does not change the cosine), and the dot product and the norms are computed as if in
 * twice the precision of doubles (see {@link dot}), so the result neither overflows nor underflows, stays accurate when the vectors are almost
 * orthogonal, and is clamped to `[-1, 1]` against rounding. Values are converted once with unary `+`.
 * @param {ReadonlyArray<number>} xs - The first vector
 * @param {ReadonlyArray<number>} ys - The second vector, as long as `xs`
 * @returns {number} The cosine similarity, in `[-1, 1]`; `NaN` when a vector is all zeros (or empty: the angle is undefined) or holds a value
 * that is not finite
 * @throws {RangeError} when `xs` and `ys` have different lengths
 * @example
 * cosineSimilarity([1, 0], [0, 1]); // => 0
 * cosineSimilarity([1, 2, 3], [2, 4, 6]); // => 1
 * cosineSimilarity([1, 1], [-1, -1]); // => -1
 * cosineSimilarity([3, 4], [4, 3]); // => 0.96
 * cosineSimilarity([1e300, 1e300], [1e-300, 1e-300]); // => 1 // the plain formula gives 0
 * cosineSimilarity([0, 0], [1, 2]); // => NaN
 */
export function cosineSimilarity(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
	assertSameLength('cosineSimilarity', xs, ys);
	const x = toFloat64(xs);
	const y = toFloat64(ys);
	const scaleX = vectorScale(x);
	const scaleY = vectorScale(y);
	// The scaled vectors have norms between 1 and `2 * √n` (or 0): the product of their squares cannot overflow or underflow. A value that
	// is not finite makes `dot2`, and so the result, `NaN`.
	const cosine = dot2(x, scaleX, y, scaleY) / Math.sqrt(dot2(x, scaleX, x, scaleX) * dot2(y, scaleY, y, scaleY));
	return cosine > 1 ? 1 : cosine < -1 ? -1 : cosine;
}
