import { isDate, isIterable } from '../guards/index.js';
import { median } from '../math/index.js';
import { assertFunction, assertInteger, assertNumber, describe, draw, readOption, show } from '../utils/assert.js';
import type { RandomGenerator } from '../utils/index.js';

/**
 * Values that are falsy in JavaScript and representable as types.
 * At runtime {@link compact} also removes `-0` and `NaN`, which TypeScript cannot express as literal types.
 */
export type Falsy = false | null | undefined | 0 | 0n | '';

/**
 * Recursively unwraps (possibly readonly) nested arrays down to their non-array element type.
 * @example
 * type R = FlatDeep<number | (number | string[])[]>; // number | string
 */
export type FlatDeep<T> = T extends ReadonlyArray<infer U> ? FlatDeep<U> : T;

/**
 * The tuple of element types produced by {@link zip} for a tuple of input arrays.
 * @example
 * type R = Zipped<[number[], string[]]>; // [number, string]
 */
export type Zipped<T extends ReadonlyArray<ReadonlyArray<unknown>>> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U : never };

/**
 * Values accepted as sort keys by {@link sortBy}. Selectors may also return `null` or `undefined` (a missing key): such keys,
 * like `NaN` and invalid `Date`s, rank after every other key in both directions.
 */
export type SortKey = number | string | bigint | Date;

/**
 * Sort direction accepted by {@link sortBy}.
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Largest length a JavaScript array can have.
 */
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

/**
 * Nesting depth from which {@link flattenDeep} tracks the enclosing arrays in a `Set` (rather than scanning a list) to detect cycles.
 */
const DEEP_NESTING = 64;

/**
 * Check if an array contains a value, using SameValueZero equality (so `NaN` is found and `0` matches `-0`).
 * @template T
 * @param {ReadonlyArray<T>} array - The array to be checked
 * @param {T} value - The value to look for
 * @returns {boolean} Whether the value is in the array
 * @example
 * contains([1, 2, 3], 2); // => true
 * contains([NaN], NaN); // => true
 */
export function contains<T>(array: ReadonlyArray<T>, value: T): boolean {
	return array.includes(value);
}

/**
 * Get the first item in an array.
 * @template T
 * @param {ReadonlyArray<T>} array - The array to be processed
 * @returns {T | undefined} The first item, or `undefined` when the array is empty
 * @example
 * first([1, 2, 3]); // => 1
 * first([]); // => undefined
 */
export function first<T>(array: ReadonlyArray<T>): T | undefined {
	// The length is checked first: `[][0]` would be looked up on `Object.prototype`, where pollution can plant a `0`.
	return array.length === 0 ? undefined : array[0];
}

/**
 * Get the last item in an array.
 * @template T
 * @param {ReadonlyArray<T>} array - The array to be processed
 * @returns {T | undefined} The last item, or `undefined` when the array is empty
 * @example
 * last([1, 2, 3]); // => 3
 * last([]); // => undefined
 */
export function last<T>(array: ReadonlyArray<T>): T | undefined {
	// The length is checked first: `[][-1]` would be looked up on `Object.prototype`, where pollution can plant a `-1`.
	return array.length === 0 ? undefined : array[array.length - 1];
}

/**
 * Flatten an array by exactly one level, like `Array.prototype.flat()` (holes in sparse arrays are skipped).
 * @template T
 * @param {ReadonlyArray<T | ReadonlyArray<T>>} array - The array to be flattened
 * @returns {T[]} A new, one-level-flattened array
 * @example
 * flatten([[1, 2], 3, [4]]); // => [1, 2, 3, 4]
 * flatten([[1, [2]]]); // => [1, [2]]
 */
export function flatten<T>(array: ReadonlyArray<T | ReadonlyArray<T>>): T[] {
	const result: T[] = [];
	for (let i = 0; i < array.length; i++) {
		if (!(i in array)) continue;
		const value = array[i];
		if (Array.isArray(value)) {
			for (let j = 0; j < value.length; j++) {
				if (j in value) result.push((value as ReadonlyArray<T>)[j]);
			}
		} else {
			result.push(value as T);
		}
	}
	return result;
}

/**
 * Recursively flatten nested arrays of any depth, like `Array.prototype.flat(Infinity)` (holes are skipped).
 * The implementation is iterative, so very deep nesting cannot overflow the call stack.
 * @template T
 * @param {ReadonlyArray<T>} array - The array to be flattened
 * @returns {Array<FlatDeep<T>>} A new array containing every non-array leaf, in depth-first order
 * @throws {TypeError} when the array contains itself (directly or through nested arrays)
 * @example
 * flattenDeep([1, [2, [3, [4]]]]); // => [1, 2, 3, 4]
 */
export function flattenDeep<T>(array: ReadonlyArray<T>): Array<FlatDeep<T>> {
	const result: Array<FlatDeep<T>> = [];
	// The arrays enclosing `current` (outermost first), and the index to resume at in each of them.
	const parents: Array<ReadonlyArray<unknown>> = [];
	const positions: number[] = [];
	// Cycle detection scans `parents`, which beats maintaining a Set for usual depths; past DEEP_NESTING levels a Set mirroring
	// `parents` takes over, so that very deep inputs stay linear.
	let deepParents: Set<ReadonlyArray<unknown>> | undefined;
	let current: ReadonlyArray<unknown> = array;
	let index = 0;
	for (;;) {
		if (index === current.length) {
			if (parents.length === 0) return result;
			current = parents.pop() as ReadonlyArray<unknown>;
			index = positions.pop() as number;
			deepParents?.delete(current);
		} else if (index++ in current) {
			const value = current[index - 1];
			if (!Array.isArray(value)) {
				result.push(value as FlatDeep<T>);
				continue;
			}
			parents.push(current);
			positions.push(index);
			if (deepParents !== undefined) deepParents.add(current);
			else if (parents.length === DEEP_NESTING) deepParents = new Set(parents);
			if (deepParents === undefined ? parents.includes(value) : deepParents.has(value)) throw new TypeError('flattenDeep: cannot flatten a circular array');
			current = value;
			index = 0;
		}
	}
}

/**
 * Remove duplicates from an iterable (SameValueZero equality), keeping the first occurrence of each value.
 * @template T
 * @param {Iterable<T>} iterable - The iterable to be processed
 * @returns {T[]} A new array with duplicates removed, in first-appearance order
 * @example
 * unique([1, 2, 2, 3, 1]); // => [1, 2, 3]
 */
export function unique<T>(iterable: Iterable<T>): T[] {
	const values: ReadonlyArray<T> = Array.isArray(iterable) ? iterable : Array.from(iterable);
	if (values.length <= 32) {
		// Short inputs: scanning the result (`includes` is SameValueZero, and keeps the first zero as is) beats building a Set.
		const result: T[] = [];
		for (const value of values) if (!result.includes(value)) result.push(value);
		return result;
	}
	const set = new Set<T>(values);
	const result = Array.from(set);
	// A Set stores -0 as +0: when the first zero of the input is -0, it is put back, so every value is an original one.
	const zero = 0 as T;
	if (set.has(zero) && Object.is(values[values.indexOf(zero)], -0)) result[result.indexOf(zero)] = -0 as T;
	return result;
}

/**
 * Whether two set-operation inputs are both arrays with at most 32 items in total: scanning such short arrays (`includes`, which
 * is SameValueZero like a `Set`) beats hashing them into a `Set`.
 * @template T
 * @param {Iterable<unknown>} a - The first input
 * @param {Iterable<T>} b - The second input
 * @returns {boolean} Whether both are short arrays
 */
function areShortArrays<T>(a: Iterable<unknown>, b: Iterable<T>): b is ReadonlyArray<T> {
	return Array.isArray(a) && Array.isArray(b) && a.length + b.length <= 32;
}

/**
 * Get the union of two iterables: every distinct value from `a`, then every distinct value of `b` not already in `a`.
 * Uses SameValueZero equality.
 * @template T
 * @param {Iterable<T>} a - The first iterable
 * @param {Iterable<T>} b - The second iterable
 * @returns {T[]} The unique values of both iterables, in first-appearance order
 * @example
 * union([1, 2, 3], [3, 4, 5]); // => [1, 2, 3, 4, 5]
 */
export function union<T>(a: Iterable<T>, b: Iterable<T>): T[] {
	// `concat` joins two arrays faster than spreading them.
	return unique(Array.isArray(a) && Array.isArray(b) ? a.concat(b) : [...a, ...b]);
}

/**
 * Get the intersection of two iterables: the distinct values of `a` that also appear in `b`.
 * Uses SameValueZero equality.
 * @template T
 * @param {Iterable<T>} a - The first iterable (defines the output order)
 * @param {Iterable<T>} b - The second iterable
 * @returns {T[]} The unique common values, in order of first appearance in `a`
 * @example
 * intersection([1, 2, 3], [2, 3, 4]); // => [2, 3]
 */
export function intersection<T>(a: Iterable<T>, b: Iterable<T>): T[] {
	const result: T[] = [];
	if (areShortArrays(a, b)) {
		for (const value of a) if (b.includes(value) && !result.includes(value)) result.push(value);
		return result;
	}
	const remaining = new Set<T>(b);
	for (const value of a) {
		// Deleting on first match both tests membership and guarantees uniqueness.
		if (remaining.delete(value)) result.push(value);
	}
	return result;
}

/**
 * Get the difference of two iterables: the distinct values of `a` that do not appear in `b`.
 * Uses SameValueZero equality.
 * @template T
 * @param {Iterable<T>} a - The iterable to take values from (defines the output order)
 * @param {Iterable<T>} b - The iterable of values to exclude
 * @returns {T[]} The unique values of `a` missing from `b`, in first-appearance order
 * @example
 * difference([1, 2, 3, 1], [2, 3, 4]); // => [1]
 */
export function difference<T>(a: Iterable<T>, b: Iterable<T>): T[] {
	const result: T[] = [];
	if (areShortArrays(a, b)) {
		for (const value of a) if (!b.includes(value) && !result.includes(value)) result.push(value);
		return result;
	}
	const excluded = new Set<T>(b);
	for (const value of a) {
		if (!excluded.has(value)) {
			// Excluding the value once emitted guarantees uniqueness without a second Set.
			excluded.add(value);
			result.push(value);
		}
	}
	return result;
}

/**
 * Get the symmetric difference of two iterables: the distinct values that appear in exactly one of them.
 * Uses SameValueZero equality.
 * @template T
 * @param {Iterable<T>} a - The first iterable
 * @param {Iterable<T>} b - The second iterable
 * @returns {T[]} The values only in `a` (first-appearance order), followed by the values only in `b`
 * @example
 * symmetricDifference([1, 2, 3], [3, 4]); // => [1, 2, 4]
 */
export function symmetricDifference<T>(a: Iterable<T>, b: Iterable<T>): T[] {
	const left = Array.from(a);
	const right = Array.from(b);
	return difference(left, right).concat(difference(right, left));
}

/**
 * Check whether every value of `subset` also appears in `superset` (SameValueZero equality).
 * An empty `subset` is a subset of anything.
 * @template T
 * @param {Iterable<T>} subset - The candidate subset
 * @param {Iterable<T>} superset - The candidate superset
 * @returns {boolean} Whether `subset` ⊆ `superset`
 * @example
 * isSubset([1, 2], [3, 2, 1]); // => true
 * isSubset([1, 4], [1, 2, 3]); // => false
 */
export function isSubset<T>(subset: Iterable<T>, superset: Iterable<T>): boolean {
	if (areShortArrays(subset, superset)) {
		for (const value of subset) if (!superset.includes(value)) return false;
		return true;
	}
	const set = new Set<T>(superset);
	for (const value of subset) {
		if (!set.has(value)) return false;
	}
	return true;
}

/**
 * Copies `array[start, end)` (with `0 <= start <= end <= array.length`) into a new array, exactly like `slice` (holes are kept).
 * Short ranges of plain arrays are copied by hand: the fixed cost of a `slice` call dominates for them. (`slice` of an `Array`
 * subclass instance creates an instance of that subclass, so those always go through `slice`.)
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} start - First index copied
 * @param {number} end - Index after the last one copied
 * @returns {T[]} The copy
 */
function copyRange<T>(array: ReadonlyArray<T>, start: number, end: number): T[] {
	if (end - start > 32 || array.constructor !== Array) return array.slice(start, end);
	const copy = new Array<T>(end - start);
	for (let i = 0; start < end; i++, start++) if (start in array) copy[i] = array[start];
	return copy;
}

/**
 * Split an array into consecutive chunks of `size` items; only the last chunk may be shorter.
 * @template T
 * @param {ReadonlyArray<T>} array - The array to split
 * @param {number} size - The maximum length of each chunk (a positive integer)
 * @returns {T[][]} A new array of chunks (empty when the input is empty)
 * @throws {RangeError} when `size` is not a positive integer
 * @throws {TypeError} when `size` is not a number
 * @example
 * chunk([1, 2, 3, 4, 5], 2); // => [[1, 2], [3, 4], [5]]
 */
export function chunk<T>(array: ReadonlyArray<T>, size: number): T[][] {
	assertInteger('chunk', 'size', size, 1);
	const result = new Array<T[]>(Math.ceil(array.length / size));
	for (let i = 0; i < result.length; i++) result[i] = copyRange(array, i * size, Math.min((i + 1) * size, array.length));
	return result;
}

/**
 * Remove every falsy value (`false`, `null`, `undefined`, `0`, `-0`, `NaN`, `''`, `0n`) from an array.
 * @template T
 * @param {ReadonlyArray<T>} array - The array to compact
 * @returns {Array<Exclude<T, Falsy>>} A new array containing only the truthy values
 * @example
 * compact([0, 1, false, 2, '', 3, null, NaN]); // => [1, 2, 3]
 */
export function compact<T>(array: ReadonlyArray<T>): Array<Exclude<T, Falsy>> {
	const result: Array<Exclude<T, Falsy>> = [];
	for (let i = 0; i < array.length; i++) {
		const value = array[i];
		if (value) result.push(value as Exclude<T, Falsy>);
	}
	return result;
}

/**
 * Create an array of numbers progressing from `start` up to, but not including, `end`, with Python `range` semantics.
 * With a single argument, it is the (exclusive) end and the range starts at 0.
 * The result is empty when `step` points away from `end`. Each value is computed as `start + i * step`,
 * so fractional steps do not accumulate rounding errors (but are still subject to floating-point precision).
 * When `(end - start) / step` is an integer up to floating-point rounding (e.g. `range(0, 2.1, 0.3)`), the range has exactly
 * that many items, and no item ever reaches `end` (it is always exclusive, even when rounding errors would land on it). Safe integers
 * have no rounding errors: `range(0, 2e15 + 1, 1e15)` has 3 items.
 * Only lengths above `2 ** 32 - 1` (the array limit) are rejected, far more than a heap can hold: callers must bound untrusted sizes
 * (e.g. `range(Number(query.pages))`), since a result that does not fit in memory aborts the whole process with a fatal
 * "heap out of memory" error rather than throwing.
 * @param {number} start - The first value, or the exclusive end when `end` is omitted
 * @param {number} [end] - The exclusive end of the range
 * @param {number} [step=1] - The increment between values (may be negative, never 0)
 * @returns {number[]} The generated numbers
 * @throws {TypeError} when `start`, `end` or `step` is not a number
 * @throws {RangeError} when an argument is not finite, `step` is 0, or the result would exceed the maximum array length
 * @example
 * range(5); // => [0, 1, 2, 3, 4]
 * range(2, 8, 2); // => [2, 4, 6]
 * range(5, 0, -2); // => [5, 3, 1]
 * range(0, 5, -1); // => []
 * range(0, 2.1, 0.3); // => [0, 0.3, 0.6, 0.8999999999999999, 1.2, 1.5, 1.7999999999999998] // 7 items, 2.1 excluded
 */
export function range(start: number, end?: number, step = 1): number[] {
	const from = end === undefined ? 0 : start;
	const to = end === undefined ? start : end;
	assertNumber('range', 'start', start, Number.isFinite(start), 'a finite number');
	if (end !== undefined) assertNumber('range', 'end', end, Number.isFinite(end), 'a finite number');
	assertNumber('range', 'step', step, Number.isFinite(step) && step !== 0, 'a finite number other than 0');
	const length = rangeLength(from, to, step);
	const result: number[] = new Array<number>(length);
	if (length > 0 && !Number.isFinite(from + (length - 1) * step)) {
		// `i * step` overflows near `Number.MAX_VALUE` (`range(-1.5e308, 1.5e308, 1e308)`): compute at half scale (same rounding).
		for (let i = 0; i < length; i++) result[i] = 2 * (from / 2 + i * (step / 2));
	} else {
		for (let i = 0; i < length; i++) result[i] = from + i * step;
	}
	return result;
}

/**
 * Counts the items of `range(from, to, step)` (arguments already validated). Kept out of `range`, whose fill loop V8 then
 * optimizes better (1.2x to 1.5x faster).
 * @param {number} from - The first value
 * @param {number} to - The exclusive end
 * @param {number} step - The increment, finite and not 0
 * @returns {number} The number of items
 * @throws {RangeError} when the range would exceed the maximum array length
 */
function rangeLength(from: number, to: number, step: number): number {
	let ratio = (to - from) / step;
	// `to - from` overflows for spans beyond `Number.MAX_VALUE` (`range(-1.5e308, 1.5e308, 1e308)`); dividing first does not.
	if (!Number.isFinite(ratio)) ratio = to / step - from / step;
	const nearest = Math.round(ratio);
	// `ratio` carries rounding errors (`2.1 / 0.3` is `7.000000000000001`); when it is an integer up to those errors,
	// the range is meant to stop exactly one step before `end`, so the count must not be rounded up.
	// (An exact integer ratio, the usual case, needs no tolerance.) The tolerance bounds those errors: half an ulp for each of
	// `from` and `to` (relative to `step`) and a few for `step`, the subtraction and the division. Safe integers carry no such errors,
	// and their ratio is rounded to an integer only when it is one: they never get the tolerance (`range(0, 2e15 + 1, 1e15)` has 3 items).
	let length = Math.max(
		0,
		ratio === nearest ||
			(Math.abs(ratio - nearest) <= Number.EPSILON * ((Math.abs(from) + Math.abs(to)) / Math.abs(step) + 2 * Math.abs(ratio)) &&
				!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && Number.isSafeInteger(step) && Number.isSafeInteger(to - from)))
			? nearest
			: Math.ceil(ratio)
	);
	if (length > MAX_ARRAY_LENGTH) throw new RangeError(`range: the range would contain ${length} items, more than an array can hold`);
	// Safety net for huge magnitudes, where `start + i * step` rounds onto (or past) `end`: the end stays exclusive.
	// (Compared by sign rather than with `(final - to) * step >= 0`, which underflows to `-0` for subnormal steps.)
	for (; length > 0; length--) {
		let final = from + (length - 1) * step;
		if (!Number.isFinite(final)) final = 2 * (from / 2 + (length - 1) * (step / 2));
		if (step > 0 ? final < to : final > to) break;
	}
	return length;
}

/**
 * Combine arrays element-wise into tuples, truncating to the length of the shortest array.
 * @template T
 * @param {...ReadonlyArray<unknown>} arrays - The arrays to zip
 * @returns {Array<Zipped<T>>} A new array of tuples; empty when called without arrays
 * @example
 * zip([1, 2, 3], ['a', 'b']); // => [[1, 'a'], [2, 'b']] // typed as [number, string][]
 */
export function zip<T extends Array<ReadonlyArray<unknown>>>(...arrays: T): Array<Zipped<T>> {
	// Zipping is a transposition, like unzipping: the tuples of `zip(...arrays)` are the columns of `unzip(arrays)`.
	return unzip(arrays) as unknown as Array<Zipped<T>>;
}

/**
 * Creates an empty null-prototype object. `Object.create(null)` returns one in V8's slow dictionary mode; this one keeps fast
 * properties, which makes filling it with a few keys up to 1.5x faster.
 * @returns {object} The new object
 */
function nullObject(): object {
	return Object.setPrototypeOf({}, null) as object;
}

/**
 * Group the items of an array by the key returned by `keyFn`, preserving input order within each group.
 * The result is a null-prototype object, so keys such as `'__proto__'` or `'constructor'` are stored safely
 * (no prototype pollution), but it has no `Object.prototype` methods. Number keys are converted to strings, as in any object.
 * @template T
 * @template K
 * @param {ReadonlyArray<T>} array - The items to group
 * @param {(item: T, index: number) => K} keyFn - Returns the group key of an item
 * @returns {Partial<Record<K, T[]>>} An object mapping each key to the items that produced it
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * groupBy([1, 2, 3, 4], function (n) { return n % 2 === 0 ? 'even' : 'odd'; }); // => { odd: [1, 3], even: [2, 4] }
 */
export function groupBy<T, K extends PropertyKey>(array: ReadonlyArray<T>, keyFn: (item: T, index: number) => K): Partial<Record<K, T[]>> {
	assertFunction('groupBy', 'keyFn', keyFn);
	const groups = nullObject() as Partial<Record<K, T[]>>;
	for (let i = 0; i < array.length; i++) {
		const item = array[i];
		const key = keyFn(item, i);
		const group = groups[key];
		if (group === undefined) groups[key] = [item];
		else group.push(item);
	}
	return groups;
}

/**
 * Index the items of an array by the key returned by `keyFn`; when several items share a key, the last one wins.
 * The result is a null-prototype object (safe for keys such as `'__proto__'`).
 * @template T
 * @template K
 * @param {ReadonlyArray<T>} array - The items to index
 * @param {(item: T, index: number) => K} keyFn - Returns the key of an item
 * @returns {Partial<Record<K, T>>} An object mapping each key to the last item that produced it (keys no item produced are absent)
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * keyBy([{ id: 'a', v: 1 }, { id: 'a', v: 2 }], function (o) { return o.id; }); // => { a: { id: 'a', v: 2 } }
 */
export function keyBy<T, K extends PropertyKey>(array: ReadonlyArray<T>, keyFn: (item: T, index: number) => K): Partial<Record<K, T>> {
	assertFunction('keyBy', 'keyFn', keyFn);
	const result = nullObject() as Partial<Record<K, T>>;
	for (let i = 0; i < array.length; i++) {
		result[keyFn(array[i], i)] = array[i];
	}
	return result;
}

/**
 * Count the items of an array per key returned by `keyFn`.
 * The result is a null-prototype object (safe for keys such as `'__proto__'`).
 * @template T
 * @template K
 * @param {ReadonlyArray<T>} array - The items to count
 * @param {(item: T, index: number) => K} keyFn - Returns the key of an item
 * @returns {Partial<Record<K, number>>} An object mapping each key to the number of items that produced it (keys no item produced are absent)
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * countBy(['one', 'two', 'three'], function (s) { return s.length; }); // => { 3: 2, 5: 1 }
 */
export function countBy<T, K extends PropertyKey>(array: ReadonlyArray<T>, keyFn: (item: T, index: number) => K): Partial<Record<K, number>> {
	assertFunction('countBy', 'keyFn', keyFn);
	const counts = nullObject() as Partial<Record<K, number>>;
	for (let i = 0; i < array.length; i++) {
		const key = keyFn(array[i], i);
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/**
 * Split an array in two: the items matching a type-guard `predicate`, and the others. Relative order is preserved.
 * @template T
 * @template S
 * @param {ReadonlyArray<T>} array - The items to split
 * @param {(item: T, index: number) => item is S} predicate - Type guard deciding which side an item goes to
 * @returns {[S[], Exclude<T, S>[]]} `[matching, nonMatching]`
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * partition([1, 'a', 2], function (v): v is number { return typeof v === 'number'; }); // => [[1, 2], ['a']]
 */
export function partition<T, S extends T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => item is S): [S[], Exclude<T, S>[]];
/**
 * Split an array in two: the items for which `predicate` returns true, and the others. Relative order is preserved.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to split
 * @param {(item: T, index: number) => boolean} predicate - Decides which side an item goes to
 * @returns {[T[], T[]]} `[matching, nonMatching]`
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * partition([1, 2, 3, 4], function (n) { return n % 2 === 0; }); // => [[2, 4], [1, 3]]
 */
export function partition<T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): [T[], T[]];
/**
 * Split an array in two: the items for which `predicate` returns true, and the others. Relative order is preserved.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to split
 * @param {(item: T, index: number) => boolean} predicate - Decides which side an item goes to
 * @returns {[T[], T[]]} `[matching, nonMatching]`
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * partition([1, 2, 3, 4], function (n) { return n % 2 === 0; }); // => [[2, 4], [1, 3]]
 */
export function partition<T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): [T[], T[]] {
	assertFunction('partition', 'predicate', predicate);
	const matching: T[] = [];
	const rest: T[] = [];
	for (let i = 0; i < array.length; i++) {
		if (predicate(array[i], i)) matching.push(array[i]);
		else rest.push(array[i]);
	}
	return [matching, rest];
}

/**
 * Remove items whose key (as returned by `keyFn`, compared with SameValueZero) was already seen, keeping the first occurrence.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to deduplicate
 * @param {(item: T, index: number) => unknown} keyFn - Returns the identity key of an item
 * @returns {T[]} A new array with one item per distinct key, in first-appearance order
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * uniqueBy([{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }], function (o) { return o.id; }); // => [{ id: 1, v: 'a' }, { id: 2, v: 'c' }]
 */
export function uniqueBy<T>(array: ReadonlyArray<T>, keyFn: (item: T, index: number) => unknown): T[] {
	assertFunction('uniqueBy', 'keyFn', keyFn);
	const seen = new Set<unknown>();
	const result: T[] = [];
	for (let i = 0; i < array.length; i++) {
		const key = keyFn(array[i], i);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(array[i]);
		}
	}
	return result;
}

/**
 * Converts a sort key to a primitive that can be compared with `<`. Missing keys (`null`, `undefined`) become `NaN`, so that every
 * unorderable key (`NaN`, invalid `Date`, nullish) is a single kind of value the callers rank last.
 * @param {SortKey | null | undefined} key - The key returned by a `sortBy` selector
 * @returns {number | string | bigint} The key itself, the timestamp of a `Date`, or `NaN` for a missing key
 */
function toComparable(key: SortKey | null | undefined): number | string | bigint {
	// `isDate` also recognizes dates from other realms (iframes, `vm`), which `instanceof Date` does not.
	return isDate(key) ? Date.prototype.getTime.call(key) : (key ?? NaN);
}

/**
 * Converts a key returned by a selector with {@link toComparable}, skipping the conversion for numbers (the common case).
 * @param {SortKey | null | undefined} key - The selected key
 * @returns {number | string | bigint} The comparable key (`NaN` when unorderable)
 */
function rank(key: SortKey | null | undefined): number | string | bigint {
	return typeof key === 'number' ? key : toComparable(key);
}

/**
 * Total order over non-NaN comparable keys: numbers and bigints are compared numerically and sort before strings;
 * strings are compared by UTF-16 code units.
 * @param {number | string | bigint} a - The first key
 * @param {number | string | bigint} b - The second key
 * @returns {number} A negative number, zero or a positive number, as for `Array.prototype.sort`
 */
function compareKeys(a: number | string | bigint, b: number | string | bigint): number {
	const isString = typeof a === 'string';
	if (isString !== (typeof b === 'string')) return isString ? 1 : -1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The total order shared by the ranking helpers: comparable keys in the given direction, and `NaN` (unorderable) keys after
 * all of them in BOTH directions, equal to each other.
 * @param {number | string | bigint} a - The first comparable key
 * @param {number | string | bigint} b - The second comparable key
 * @param {number} direction - `1` for ascending, `-1` for descending
 * @returns {number} A negative number, zero or a positive number
 */
function compareRanked(a: number | string | bigint, b: number | string | bigint, direction: number): number {
	if (a !== a) return b !== b ? 0 : 1;
	return b !== b ? -1 : direction === 1 ? compareKeys(a, b) : compareKeys(b, a);
}

/**
 * Validates a sort direction.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} order - The direction to validate
 * @param {number} [index] - Position of `order` in the `name` array, if it is an item of one
 * @returns {number} `1` for `'asc'`, `-1` for `'desc'`
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 */
function toDirection(caller: string, name: string, order: unknown, index?: number): number {
	if (order === 'asc' || order === 'desc') return order === 'asc' ? 1 : -1;
	throw new RangeError(`${caller}: \`${index === undefined ? name : `${name}[${index}]`}\` must be 'asc' or 'desc', got ${show(order)}`);
}

/**
 * Sorts an array of indices in place, stably. Short arrays (the fixed cost of `Array.prototype.sort` with a comparator dominates
 * for them) are insertion-sorted, up to twice as fast.
 * @param {number[]} indices - The indices to sort
 * @param {Comparator<number>} compare - Compares two indices
 * @returns {void}
 */
function stableSort(indices: number[], compare: Comparator<number>): void {
	if (indices.length > 12) {
		indices.sort(compare);
		return;
	}
	for (let i = 1; i < indices.length; i++) {
		const index = indices[i];
		let j = i;
		// Strictly greater: an equal item stays after the earlier ones, which keeps the sort stable.
		for (; j > 0 && compare(indices[j - 1], index) > 0; j--) indices[j] = indices[j - 1];
		indices[j] = index;
	}
}

/**
 * Return a sorted copy of an array, ordered by the key `selector` returns for each item. The sort is stable
 * (items with equal keys keep their relative order, in both directions) and the selector is called once per item.
 *
 * Ordering rules, chosen to be deterministic and locale-independent:
 * - numbers and bigints compare numerically (and may be mixed); `Date`s compare by timestamp;
 * - strings compare by UTF-16 code units with plain `<` (not `localeCompare`), so `'B' < 'a'`;
 * - numeric keys sort before string keys when both kinds are mixed;
 * - `NaN` keys, invalid `Date`s and missing (`null`/`undefined`) keys always go last, whatever the order, in input order.
 *
 * Use {@link orderBy} to sort by several keys.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to sort (not mutated)
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the sort key of an item
 * @param {SortOrder} [order='asc'] - `'asc'` for ascending or `'desc'` for descending keys
 * @returns {T[]} A new sorted array
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 * @example
 * sortBy([{ n: 'b' }, { n: 'a' }], function (o) { return o.n; }); // => [{ n: 'a' }, { n: 'b' }]
 * sortBy([1, 3, 2], function (n) { return n; }, 'desc'); // => [3, 2, 1]
 * sortBy([{ n: 2 }, {}, { n: 1 }], function (o: { n?: number }) { return o.n; }); // => [{ n: 1 }, { n: 2 }, {}]
 */
export function sortBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => SortKey | null | undefined, order: SortOrder = 'asc'): T[] {
	assertFunction('sortBy', 'selector', selector);
	toDirection('sortBy', 'order', order);
	const length = array.length;
	const keys: Array<number | string | bigint> = [];
	// Indices of the items to sort, then of the items with a NaN key (they keep their input order, after all the others).
	const sorted: number[] = [];
	const unordered: number[] = [];
	for (let i = 0; i < length; i++) {
		const selected = selector(array[i], i);
		// Number keys (the common case) skip the `Date` check; NaN is the only key not equal to itself.
		const key = typeof selected === 'number' ? selected : toComparable(selected);
		keys.push(key);
		(key !== key ? unordered : sorted).push(i);
	}
	// The sort is stable and `sorted` is in input order, so items with equal keys keep their relative order.
	stableSort(
		sorted,
		order === 'asc'
			? function (x: number, y: number): number {
					return compareKeys(keys[x], keys[y]);
				}
			: function (x: number, y: number): number {
					return compareKeys(keys[y], keys[x]);
				}
	);
	const result = new Array<T>(length);
	for (let i = 0; i < sorted.length; i++) result[i] = array[sorted[i]];
	for (let i = 0; i < unordered.length; i++) result[sorted.length + i] = array[unordered[i]];
	return result;
}

/**
 * Return a shuffled copy of an array using the Fisher–Yates algorithm (the input is not mutated).
 * Not cryptographically secure by default: pass `secureRandom` (random module) for tokens, OTPs, lotteries…
 * @template T
 * @param {ReadonlyArray<T>} array - The items to shuffle
 * @param {RandomGenerator} [random=Math.random] - Generator of floats in `[0, 1)`, injectable for deterministic results
 * @returns {T[]} A new array containing the same items in random order
 * @throws {RangeError} when `random()` returns a value outside `[0, 1)`
 * @throws {TypeError} when `random` is not a function
 * @example
 * shuffle([1, 2, 3, 4]); // e.g. [3, 1, 4, 2]
 */
export function shuffle<T>(array: ReadonlyArray<T>, random: RandomGenerator = Math.random): T[] {
	assertFunction('shuffle', 'random', random);
	const result = Array.from(array);
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(draw('shuffle', random) * (i + 1));
		const held = result[i];
		result[i] = result[j];
		result[j] = held;
	}
	return result;
}

/**
 * Pick a random item from an array.
 * Not cryptographically secure by default: pass `secureRandom` (random module) for tokens, OTPs, lotteries…
 * @template T
 * @param {ReadonlyArray<T>} array - The items to pick from
 * @param {RandomGenerator} [random=Math.random] - Generator of floats in `[0, 1)`, injectable for deterministic results
 * @returns {T | undefined} A random item, or `undefined` when the array is empty (`random` is then not called)
 * @throws {RangeError} when `random()` returns a value outside `[0, 1)`
 * @throws {TypeError} when `random` is not a function
 * @example
 * sample(['a', 'b', 'c']); // e.g. 'b'
 * sample([]); // => undefined
 */
export function sample<T>(array: ReadonlyArray<T>, random: RandomGenerator = Math.random): T | undefined {
	assertFunction('sample', 'random', random);
	if (array.length === 0) return undefined;
	return array[Math.floor(draw('sample', random) * array.length)];
}

/**
 * Return the first `n` items of an array (or all of them when it is shorter).
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} n - How many items to take (a non-negative integer)
 * @returns {T[]} A new array with at most `n` items
 * @throws {RangeError} when `n` is negative or not an integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * take([1, 2, 3], 2); // => [1, 2]
 */
export function take<T>(array: ReadonlyArray<T>, n: number): T[] {
	assertInteger('take', 'n', n, 0);
	return copyRange(array, 0, Math.min(n, array.length));
}

/**
 * Return an array without its first `n` items.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} n - How many items to skip (a non-negative integer)
 * @returns {T[]} A new array with the remaining items
 * @throws {RangeError} when `n` is negative or not an integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * drop([1, 2, 3], 2); // => [3]
 */
export function drop<T>(array: ReadonlyArray<T>, n: number): T[] {
	assertInteger('drop', 'n', n, 0);
	return copyRange(array, Math.min(n, array.length), array.length);
}

/**
 * The tuple of arrays produced by {@link unzip} for an array of tuples of type `T`.
 * @example
 * type R = Unzipped<[number, string]>; // [number[], string[]]
 */
export type Unzipped<T extends ReadonlyArray<unknown>> = { -readonly [K in keyof T]: Array<T[K]> };

/**
 * A comparator, as accepted by `Array.prototype.sort`: negative when `a` sorts before `b`, positive when after, `0` when equivalent.
 */
export type Comparator<T> = (a: T, b: T) => number;

/**
 * Split an array of tuples into one array per tuple position: the inverse of {@link zip}.
 * Like `zip`, the result is truncated to the SHORTEST tuple, so `unzip(zip(a, b))` gives back `[a, b]` for equal-length, non-empty arrays.
 * The number of positions is read from the tuples themselves, so for an EMPTY input it cannot be known and `[]` is returned;
 * the return type says so (`Unzipped<T> | []`) — use destructuring defaults: `const [xs = [], ys = []] = unzip(pairs);`.
 * @template T - The tuple type
 * @param {ReadonlyArray<T>} tuples - The tuples to split
 * @returns {Unzipped<T> | []} One fresh array per tuple position, or `[]` when there are no tuples
 * @example
 * unzip([[1, 'a'], [2, 'b']] as [number, string][]); // => [[1, 2], ['a', 'b']] // typed as [number[], string[]] | []
 * unzip([]); // => []
 */
export function unzip<T extends ReadonlyArray<unknown>>(tuples: ReadonlyArray<T>): Unzipped<T> | [] {
	if (tuples.length === 0) return [];
	let arity = tuples[0].length;
	for (let row = 1; row < tuples.length; row++) arity = Math.min(arity, tuples[row].length);
	const result: unknown[][] = new Array<unknown[]>(arity);
	for (let position = 0; position < arity; position++) {
		const column: unknown[] = new Array<unknown>(tuples.length);
		for (let row = 0; row < tuples.length; row++) column[row] = tuples[row][position];
		result[position] = column;
	}
	return result as Unzipped<T>;
}

/**
 * Return the sliding windows of `size` consecutive items, starting every `step` items. Only FULL windows are returned,
 * so an array shorter than `size` gives `[]`, and trailing items that do not fill a window are dropped.
 * The number of windows is `max(0, floor((length - size) / step) + 1)`, and the result holds `size` times as many items in all, which
 * must not exceed `2 ** 32 - 1`. That limit is far more than a heap can hold: callers must bound untrusted sizes, since a result
 * that does not fit in memory aborts the whole process with a fatal "heap out of memory" error rather than throwing.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} size - The length of each window (a positive integer)
 * @param {number} [step=1] - The distance between the starts of two consecutive windows (a positive integer)
 * @returns {T[][]} A new array of windows (each window is a fresh array)
 * @throws {RangeError} when `size` or `step` is not a positive integer, or the windows would hold more than `2 ** 32 - 1` items in all
 * @throws {TypeError} when `size` or `step` is not a number
 * @example
 * windowed([1, 2, 3, 4], 2); // => [[1, 2], [2, 3], [3, 4]]
 * windowed([1, 2, 3, 4, 5], 2, 2); // => [[1, 2], [3, 4]]
 * windowed([1, 2], 3); // => []
 */
export function windowed<T>(array: ReadonlyArray<T>, size: number, step = 1): T[][] {
	assertInteger('windowed', 'size', size, 1);
	assertInteger('windowed', 'step', step, 1);
	const windows = array.length < size ? 0 : Math.floor((array.length - size) / step) + 1;
	if (windows * size > MAX_ARRAY_LENGTH) {
		throw new RangeError(`windowed: the result would contain ${windows} windows of ${size} items, more than 2 ** 32 - 1 items in all`);
	}
	const result: T[][] = [];
	for (let start = 0; start + size <= array.length; start += step) {
		result.push(copyRange(array, start, start + size));
	}
	return result;
}

/**
 * Return every pair of adjacent items: `[a[0], a[1]], [a[1], a[2]], ...` (empty for arrays with fewer than 2 items).
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @returns {Array<[T, T]>} A new array of `length - 1` pairs
 * @example
 * pairwise([1, 2, 3]); // => [[1, 2], [2, 3]]
 * pairwise([1]); // => []
 */
export function pairwise<T>(array: ReadonlyArray<T>): Array<[T, T]> {
	const result: Array<[T, T]> = [];
	for (let i = 1; i < array.length; i++) result.push([array[i - 1], array[i]]);
	return result;
}

/**
 * Shared worker of {@link minBy} and {@link maxBy}: the first item whose key is extreme in the given direction.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to inspect
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the key of an item
 * @param {number} direction - `-1` to find the smallest key, `1` to find the largest
 * @returns {T | undefined} The first item with the extreme key, or `undefined` when there is no non-NaN key
 */
function extremeBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => SortKey | null | undefined, direction: number): T | undefined {
	let best: T | undefined;
	let bestKey: number | string | bigint = NaN;
	let selected: SortKey | null | undefined = NaN;
	let i = 0;
	// Fast path while the keys are numbers (the common case): find the first non-NaN key...
	for (; i < array.length; i++) {
		selected = selector(array[i], i);
		if (typeof selected !== 'number') break;
		if (selected === selected) {
			best = array[i++];
			bestKey = selected;
			break;
		}
	}
	// ...then compare with plain strict comparisons (on ties the first item wins; NaN keys compare false and are skipped).
	if (bestKey === bestKey) {
		for (; i < array.length; i++) {
			selected = selector(array[i], i);
			if (typeof selected !== 'number') break;
			if (direction < 0 ? selected < bestKey : selected > bestKey) {
				best = array[i];
				bestKey = selected;
			}
		}
	}
	// General path from the first non-number key on (`selected` already holds it).
	let found = bestKey === bestKey;
	for (; i < array.length; i++) {
		const key = toComparable(selected);
		if (key === key && (!found || compareKeys(key, bestKey) === direction)) {
			found = true;
			best = array[i];
			bestKey = key;
		}
		if (i + 1 < array.length) selected = selector(array[i + 1], i + 1);
	}
	return best;
}

/**
 * Return the item with the SMALLEST key, using the same ordering rules as {@link sortBy}
 * (numbers/bigints numerically and before strings, strings by UTF-16 code units, `Date`s by timestamp).
 * On ties the FIRST such item wins. Items whose key is `NaN`, an invalid `Date`, `null` or `undefined` are ignored.
 * The selector is called exactly once per item.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to inspect
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the key of an item
 * @returns {T | undefined} The first item with the smallest key, or `undefined` when the array is empty or every key is `NaN`
 * @throws {TypeError} when `selector` is not a function
 * @example
 * const items = [{ n: 3 }, { n: 1 }, { n: 1 }];
 * minBy(items, function (o) { return o.n; }) === items[1]; // => true // ties keep the first
 * minBy([NaN, 2], function (n) { return n; }); // => 2
 */
export function minBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => SortKey | null | undefined): T | undefined {
	assertFunction('minBy', 'selector', selector);
	return extremeBy(array, selector, -1);
}

/**
 * Return the item with the LARGEST key, using the same ordering rules as {@link sortBy}
 * (numbers/bigints numerically and before strings, strings by UTF-16 code units, `Date`s by timestamp).
 * On ties the FIRST such item wins. Items whose key is `NaN`, an invalid `Date`, `null` or `undefined` are ignored.
 * The selector is called exactly once per item.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to inspect
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the key of an item
 * @returns {T | undefined} The first item with the largest key, or `undefined` when the array is empty or every key is `NaN`
 * @throws {TypeError} when `selector` is not a function
 * @example
 * maxBy([{ n: 3 }, { n: 7 }], function (o) { return o.n; }); // => { n: 7 }
 * maxBy(['b', 'a', 'B'], function (s) { return s; }); // => 'b'
 */
export function maxBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => SortKey | null | undefined): T | undefined {
	assertFunction('maxBy', 'selector', selector);
	return extremeBy(array, selector, 1);
}

/**
 * Add up the numbers returned by `selector` for each item, using compensated (Neumaier) summation like `sum` from the math module (same algorithm, same result),
 * so the rounding error does not grow with the number of items.
 * `NaN`/`Infinity` keys propagate as in plain addition. Like the aggregates of the math module, each key is converted once with unary `+`,
 * so numeric strings count as numbers instead of being concatenated.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to add up
 * @param {(item: T, index: number) => number} selector - Returns the number contributed by an item
 * @returns {number} The total (`0` for an empty array)
 * @throws {TypeError} when `selector` is not a function
 * @example
 * sumBy([{ price: 0.1 }, { price: 0.2 }, { price: 0.3 }], function (o) { return o.price; }); // => 0.6
 */
export function sumBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => number): number {
	assertFunction('sumBy', 'selector', selector);
	return scaledSum(array, selector, 1);
}

/**
 * Neumaier sum of the selected numbers divided by `divisor`, the division being applied to the running total and to the compensation
 * separately: this is the compensated sum itself for `divisor = 1`, and makes the mean of {@link averageBy} more accurate than dividing
 * the rounded sum (`0.1`, `0.2`, `0.3` average to `0.2`, not `0.19999999999999998`). When the running total overflows on finite
 * values, the rest is added up already divided (like `average` from the math module), so a finite mean is not lost to `Infinity`.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to add up
 * @param {(item: T, index: number) => number} selector - Returns the number contributed by an item
 * @param {number} divisor - What the sum is divided by
 * @returns {number} The scaled sum
 */
function scaledSum<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => number, divisor: number): number {
	// Neumaier summation inlined (same algorithm and result as `sum`), so no intermediate array of keys is allocated.
	let total = 0;
	let compensation = 0;
	// 1 until the running total overflows; `divisor` afterwards, when the terms are added up already divided.
	let scale = 1;
	for (let i = 0; i < array.length; i++) {
		let value = +selector(array[i], i) / scale;
		let next = total + value;
		if (!Number.isFinite(next) && scale < divisor && Number.isFinite(total) && Number.isFinite(value)) {
			scale = divisor;
			total /= divisor;
			compensation /= divisor;
			value /= divisor;
			next = total + value;
		}
		compensation += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
		total = next;
	}
	if (!Number.isFinite(total)) return total / scale / divisor;
	return scale === 1 ? total / divisor + compensation / divisor : total + compensation;
}

/**
 * Resolves a possibly negative index (counting from the end, like `Array.prototype.at`) and checks its range.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {number} index - The index to resolve
 * @param {number} length - The length of the array
 * @param {boolean} allowEnd - Whether `length` itself is a valid (insertion) position
 * @returns {number} The resolved index, in `[0, length)` (or `[0, length]` when `allowEnd`)
 * @throws {TypeError} when `index` is not a number
 * @throws {RangeError} when `index` is not an integer or is out of range
 */
function resolveIndex(caller: string, name: string, index: number, length: number, allowEnd: boolean): number {
	const resolved = index < 0 ? length + index : index;
	const upper = allowEnd ? length : length - 1;
	assertNumber(
		caller,
		name,
		index,
		Number.isInteger(index) && resolved >= 0 && resolved <= upper,
		upper < 0 ? 'a valid index, but the array is empty' : `an integer in [${-length}, ${upper}]`
	);
	return resolved;
}

/**
 * Return a copy of an array with the item at `from` moved to position `to` (the input is not mutated).
 * `to` is the index the item has in the RESULT. Negative indices count from the end, like `Array.prototype.at`.
 * Equivalent to `copy.splice(to, 0, ...copy.splice(from, 1))` on a copy. Holes of sparse arrays become `undefined`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} from - Index of the item to move, in `[-length, length - 1]`
 * @param {number} to - Index of the item in the result, in `[-length, length - 1]`
 * @returns {T[]} A new array, a permutation of the input
 * @throws {RangeError} when `from` or `to` is not an integer or is out of range (any index is out of range for an empty array)
 * @throws {TypeError} when `from` or `to` is not a number
 * @example
 * move(['a', 'b', 'c', 'd'], 0, 2); // => ['b', 'c', 'a', 'd']
 * move(['a', 'b', 'c'], -1, 0); // => ['c', 'a', 'b']
 */
export function move<T>(array: ReadonlyArray<T>, from: number, to: number): T[] {
	const source = resolveIndex('move', 'from', from, array.length, false);
	const target = resolveIndex('move', 'to', to, array.length, false);
	const result = Array.from(array);
	const [item] = result.splice(source, 1);
	result.splice(target, 0, item);
	return result;
}

/**
 * Return a copy of an array with `items` inserted before position `index` (the input is not mutated).
 * Negative indices count from the end, like `Array.prototype.at` / `splice`: `-1` inserts before the last item;
 * `index === length` appends. Holes of sparse arrays become `undefined`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} index - Insertion position, in `[-length, length]`
 * @param {...T} items - The items to insert (in order)
 * @returns {T[]} A new array of length `array.length + items.length`
 * @throws {RangeError} when `index` is not an integer or is out of range
 * @throws {TypeError} when `index` is not a number
 * @example
 * insertAt([1, 2, 3], 1, 9, 8); // => [1, 9, 8, 2, 3]
 * insertAt([1, 2, 3], -1, 9); // => [1, 2, 9, 3]
 * insertAt([1, 2, 3], 3, 9); // => [1, 2, 3, 9]
 */
export function insertAt<T>(array: ReadonlyArray<T>, index: number, ...items: T[]): T[] {
	const position = resolveIndex('insertAt', 'index', index, array.length, true);
	// Copied with loops: `splice(position, 0, ...items)` would spread `items` onto the stack a second time.
	const result = new Array<T>(array.length + items.length);
	for (let i = 0; i < position; i++) result[i] = array[i];
	for (let i = 0; i < items.length; i++) result[position + i] = items[i];
	for (let i = position; i < array.length; i++) result[items.length + i] = array[i];
	return result;
}

/**
 * Return a copy of an array without the `count` items starting at `index` (the input is not mutated).
 * Negative indices count from the end, like `Array.prototype.at`. Like `splice`, `count` is clamped to the items available
 * (pass `array.length` to remove everything from `index` on). Holes of sparse arrays become `undefined`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} index - Index of the first item to remove, in `[-length, length - 1]`
 * @param {number} [count=1] - How many items to remove (a non-negative integer)
 * @returns {T[]} A new array without the removed items
 * @throws {RangeError} when `index` is not an integer or is out of range (any index is out of range for an empty array)
 * @throws {RangeError} when `count` is not a non-negative integer
 * @throws {TypeError} when `index` or `count` is not a number
 * @example
 * removeAt([1, 2, 3, 4], 1); // => [1, 3, 4]
 * removeAt([1, 2, 3, 4], -2, 2); // => [1, 2]
 */
export function removeAt<T>(array: ReadonlyArray<T>, index: number, count = 1): T[] {
	const position = resolveIndex('removeAt', 'index', index, array.length, false);
	assertInteger('removeAt', 'count', count, 0);
	const result = Array.from(array);
	result.splice(position, count);
	return result;
}

/**
 * Default comparator of {@link sortedIndex} and {@link binarySearch}: orders numbers, strings or bigints with `<`.
 * @param {unknown} a - The first value
 * @param {unknown} b - The second value
 * @returns {number} `-1`, `0` or `1`
 */
function naturalCompare(a: unknown, b: unknown): number {
	return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/**
 * Binary search for the lowest (or highest) index at which `value` could be inserted while keeping `sortedArray` sorted.
 * @template T
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<T>} sortedArray - An array sorted according to `compare`
 * @param {T} value - The value to locate
 * @param {Comparator<T> | undefined} compare - The comparator (`undefined` for the natural `<` order)
 * @param {boolean} [upper=false] - Whether to return the upper bound (after the items comparing equal) instead of the lower one
 * @returns {[number, Comparator<T>]} The bound and the comparator actually used
 * @throws {TypeError} when `compare` is given but is not a function
 * @throws {RangeError} when `value` is `NaN` and no comparator is given
 */
function searchBound<T>(caller: string, sortedArray: ReadonlyArray<T>, value: T, compare: Comparator<T> | undefined, upper = false): [number, Comparator<T>] {
	if (compare === undefined) {
		if (Number.isNaN(value)) throw new RangeError(`${caller}: \`value\` must not be NaN when no comparator is given, got NaN`);
	} else assertFunction(caller, 'compare', compare);
	const order: Comparator<T> = compare ?? naturalCompare;
	let low = 0;
	let high = sortedArray.length;
	while (low < high) {
		// Not `(low + high) >>> 1`, which wraps around past 2 ** 32 (array-likes and sparse arrays can be that long).
		const middle = low + ((high - low) >>> 1);
		const comparison = order(sortedArray[middle], value);
		if (comparison < 0 || (upper && comparison === 0)) low = middle + 1;
		else high = middle;
	}
	return [low, order];
}

/**
 * Find, by binary search (O(log n)), the LOWEST index at which `value` can be inserted into `sortedArray` keeping it sorted
 * (before any equal items). Without a comparator, numbers, strings or bigints are ordered with `<` (strings by UTF-16 code units).
 * The array must already be sorted in that order (and contain no `NaN`); otherwise the result is unspecified.
 * @template T - A number, string or bigint type
 * @param {ReadonlyArray<T>} sortedArray - An array sorted in ascending `<` order
 * @param {T} value - The value to locate
 * @returns {number} An index in `[0, length]`
 * @throws {RangeError} when `value` is `NaN`
 * @example
 * sortedIndex([10, 20, 20, 30], 20); // => 1
 * sortedIndex([10, 20, 30], 99); // => 3
 */
export function sortedIndex<T extends number | string | bigint>(sortedArray: ReadonlyArray<T>, value: T): number;
/**
 * Find, by binary search (O(log n)), the LOWEST index at which `value` can be inserted into `sortedArray` keeping it sorted
 * according to `compare` (before any items comparing equal). The array must already be sorted by `compare`.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - An array sorted according to `compare`
 * @param {T} value - The value to locate
 * @param {Comparator<T>} compare - The comparator the array is sorted by
 * @returns {number} An index in `[0, length]`
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * sortedIndex([{ n: 1 }, { n: 5 }], { n: 3 }, function (a, b) { return a.n - b.n; }); // => 1
 */
export function sortedIndex<T>(sortedArray: ReadonlyArray<T>, value: T, compare: Comparator<T>): number;
/**
 * Implementation of {@link sortedIndex}.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - A sorted array
 * @param {T} value - The value to locate
 * @param {Comparator<T>} [compare] - The comparator the array is sorted by
 * @returns {number} The lowest insertion index
 * @throws {RangeError} when `value` is `NaN` and no comparator is given
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * sortedIndex([1, 3], 2); // => 1
 */
export function sortedIndex<T>(sortedArray: ReadonlyArray<T>, value: T, compare?: Comparator<T>): number {
	return searchBound('sortedIndex', sortedArray, value, compare)[0];
}

/**
 * Find the index of `value` in `sortedArray` by binary search (O(log n)); with duplicates, the LOWEST matching index is returned.
 * Without a comparator, numbers, strings or bigints are ordered with `<`. The array must already be sorted in that order.
 * @template T - A number, string or bigint type
 * @param {ReadonlyArray<T>} sortedArray - An array sorted in ascending `<` order
 * @param {T} value - The value to find
 * @returns {number} The index of `value`, or `-1` when it is absent
 * @throws {RangeError} when `value` is `NaN`
 * @example
 * binarySearch([1, 3, 5, 7], 5); // => 2
 * binarySearch([1, 3, 5, 7], 4); // => -1
 */
export function binarySearch<T extends number | string | bigint>(sortedArray: ReadonlyArray<T>, value: T): number;
/**
 * Find the index of an item comparing equal (`compare(item, value) === 0`) to `value` in `sortedArray` by binary search;
 * with several equal items, the LOWEST index is returned. The array must already be sorted by `compare`.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - An array sorted according to `compare`
 * @param {T} value - The value to find
 * @param {Comparator<T>} compare - The comparator the array is sorted by
 * @returns {number} The index of a matching item, or `-1`
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * binarySearch(['b', 'c'], 'B', function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0; }); // => 0
 */
export function binarySearch<T>(sortedArray: ReadonlyArray<T>, value: T, compare: Comparator<T>): number;
/**
 * Implementation of {@link binarySearch}.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - A sorted array
 * @param {T} value - The value to find
 * @param {Comparator<T>} [compare] - The comparator the array is sorted by
 * @returns {number} The lowest matching index, or `-1`
 * @throws {RangeError} when `value` is `NaN` and no comparator is given
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * binarySearch([1, 3], 3); // => 1
 */
export function binarySearch<T>(sortedArray: ReadonlyArray<T>, value: T, compare?: Comparator<T>): number {
	const [index, order] = searchBound('binarySearch', sortedArray, value, compare);
	return index < sortedArray.length && order(sortedArray[index], value) === 0 ? index : -1;
}

/**
 * Return the cartesian product of the given arrays: every tuple taking one item from each array, in lexicographic order
 * (the LAST array varies fastest). The result has `product of the lengths` tuples: it is empty when any array is empty,
 * and is `[[]]` (one empty tuple) when called without arrays. The tuples must not hold more than `2 ** 32 - 1` items in all (checked
 * before anything is allocated). That limit is far more than a heap can hold: callers must bound untrusted inputs (e.g. option lists
 * of a product configurator), since a result that does not fit in memory aborts the whole process with a fatal "heap out of memory"
 * error rather than throwing.
 * @template T - The tuple of input array types
 * @param {...ReadonlyArray<unknown>} arrays - The arrays to combine
 * @returns {Array<Zipped<T>>} A new array of fresh tuples
 * @throws {RangeError} when the tuples would hold more than `2 ** 32 - 1` items in all
 * @example
 * cartesianProduct([1, 2], ['a', 'b']); // => [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']] // typed as [number, string][]
 */
export function cartesianProduct<T extends Array<ReadonlyArray<unknown>>>(...arrays: T): Array<Zipped<T>> {
	let total = 1;
	for (const array of arrays) total *= array.length;
	// Without arrays, the one (empty) tuple holds no item.
	if (total * arrays.length > MAX_ARRAY_LENGTH) {
		throw new RangeError(`cartesianProduct: the product would contain ${total} tuples of ${arrays.length} items, more than 2 ** 32 - 1 items in all`);
	}
	const result: Array<Zipped<T>> = [];
	const positions = new Array<number>(arrays.length).fill(0);
	for (let count = 0; count < total; count++) {
		const tuple: unknown[] = [];
		for (let k = 0; k < arrays.length; k++) tuple.push(arrays[k][positions[k]]);
		result.push(tuple as Zipped<T>);
		// Odometer increment: the last position turns fastest.
		for (let k = arrays.length - 1; k >= 0; k--) {
			positions[k]++;
			if (positions[k] < arrays[k].length) break;
			positions[k] = 0;
		}
	}
	return result;
}

/**
 * Return a copy of an array with `separator` inserted between every two consecutive items.
 * @template T - The item type
 * @template S - The separator type
 * @param {ReadonlyArray<T>} array - The source array
 * @param {S} separator - The value to insert
 * @returns {Array<T | S>} A new array of length `max(0, 2 * length - 1)`
 * @example
 * intersperse([1, 2, 3], 0); // => [1, 0, 2, 0, 3]
 * intersperse(['a'], ','); // => ['a']
 */
export function intersperse<T, S>(array: ReadonlyArray<T>, separator: S): Array<T | S> {
	const result: Array<T | S> = [];
	for (let i = 0; i < array.length; i++) {
		if (i > 0) result.push(separator);
		result.push(array[i]);
	}
	return result;
}

/**
 * Collects the keys `keyFn` returns for every item of an iterable.
 * @template U
 * @param {Iterable<U>} iterable - The items
 * @param {(item: U) => unknown} keyFn - Returns the key of an item
 * @returns {unknown[]} The keys, in iteration order
 */
function keyList<U>(iterable: Iterable<U>, keyFn: (item: U) => unknown): unknown[] {
	const keys = new Array<unknown>();
	for (const item of iterable) keys.push(keyFn(item));
	return keys;
}

/**
 * Like {@link difference}, but items are compared by the key `keyFn` returns (SameValueZero): the items of `a` whose key is
 * not the key of any item of `b`, keeping only the FIRST item of `a` per key. `differenceBy(a, b, identity)` equals `difference(a, b)`.
 * `keyFn` is called once per item of both iterables.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The items to take from (defines the output order)
 * @param {Iterable<U>} b - The items whose keys are excluded
 * @param {(item: T | U) => unknown} keyFn - Returns the identity key of an item of either iterable
 * @returns {T[]} The items of `a` with a distinct key missing from `b`, in first-appearance order
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * differenceBy([{ id: 1 }, { id: 2 }], [{ id: 2 }], function (o) { return o.id; }); // => [{ id: 1 }]
 * differenceBy([1.2, 2.5, 3.1], [2.1], Math.floor); // => [1.2, 3.1]
 */
export function differenceBy<T, U = T>(a: Iterable<T>, b: Iterable<U>, keyFn: (item: T | U) => unknown): T[] {
	assertFunction('differenceBy', 'keyFn', keyFn);
	const keys = keyList(b, keyFn);
	const result: T[] = [];
	if (areShortArrays(a, keys)) {
		for (const item of a) {
			const key = keyFn(item);
			if (!keys.includes(key)) {
				keys.push(key);
				result.push(item);
			}
		}
		return result;
	}
	const excluded = new Set(keys);
	for (const item of a) {
		const key = keyFn(item);
		if (!excluded.has(key)) {
			excluded.add(key);
			result.push(item);
		}
	}
	return result;
}

/**
 * Like {@link intersection}, but items are compared by the key `keyFn` returns (SameValueZero): the items of `a` whose key is
 * also the key of an item of `b`, keeping only the FIRST item of `a` per key. `intersectionBy(a, b, identity)` equals `intersection(a, b)`.
 * `keyFn` is called once per item of both iterables.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The items to take from (defines the output order)
 * @param {Iterable<U>} b - The items whose keys are kept
 * @param {(item: T | U) => unknown} keyFn - Returns the identity key of an item of either iterable
 * @returns {T[]} The items of `a` with a distinct key also present in `b`, in first-appearance order
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * intersectionBy([{ id: 1 }, { id: 2 }], [{ id: 2 }], function (o) { return o.id; }); // => [{ id: 2 }]
 */
export function intersectionBy<T, U = T>(a: Iterable<T>, b: Iterable<U>, keyFn: (item: T | U) => unknown): T[] {
	assertFunction('intersectionBy', 'keyFn', keyFn);
	const remaining = new Set(keyList(b, keyFn));
	const result: T[] = [];
	for (const item of a) {
		if (remaining.delete(keyFn(item))) result.push(item);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// diffSequences / longestCommonSubsequence
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One step of the edit script returned by {@link diffSequences}:
 * - `'equal'`: `value` is `a[indexA]`, kept (it matches `b[indexB]`);
 * - `'delete'`: `value` is `a[indexA]`, removed;
 * - `'insert'`: `value` is `b[indexB]`, added.
 * @template T - The element type
 */
export type DiffOperation<T> =
	| { type: 'equal'; value: T; indexA: number; indexB: number }
	| { type: 'delete'; value: T; indexA: number }
	| { type: 'insert'; value: T; indexB: number };

/**
 * Options accepted by {@link diffSequences} and {@link longestCommonSubsequence}.
 */
export interface DiffOptions {
	/**
	 * Largest number of edits (deletions plus insertions) accepted: when the sequences differ by more, a `RangeError` is thrown instead,
	 * after O((N + M) · maxEdits) work. An integer >= 0 or `Infinity`.
	 * @default Infinity
	 */
	maxEdits?: number;
}

/**
 * SameValueZero equality (like `===`, but `NaN` equals `NaN`), the default of {@link diffSequences}.
 * @param {unknown} x - First value
 * @param {unknown} y - Second value
 * @returns {boolean} Whether the values are SameValueZero-equal
 */
function sameValueZero(x: unknown, y: unknown): boolean {
	return x === y || (Number.isNaN(x) && Number.isNaN(y));
}

/**
 * Copies the elements of an iterable into a new array.
 * @template T - The element type
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {Iterable<T>} value - The iterable
 * @returns {ReadonlyArray<T>} The elements
 * @throws {TypeError} when `value` is not iterable
 */
function toList<T>(caller: string, name: string, value: Iterable<T>): ReadonlyArray<T> {
	if (!isIterable(value)) throw new TypeError(`${caller}: \`${name}\` must be an iterable, got ${describe(value)}`);
	return Array.from(value);
}

/**
 * Computes a minimal edit script with Myers' linear-space algorithm (see {@link diffSequences}).
 * @template T - The element type
 * @param {string} caller - Name of the public function, used in error messages
 * @param {Iterable<T>} a - The original sequence
 * @param {Iterable<T>} b - The target sequence
 * @param {(x: T, y: T) => boolean} equals - Element equality, called as `equals(itemOfA, itemOfB)`
 * @param {DiffOptions} options - `maxEdits`
 * @returns {Array<DiffOperation<T>>} The edit script
 * @throws {TypeError} when `a` or `b` is not iterable, `equals` is not a function or `maxEdits` is not a number
 * @throws {RangeError} when `maxEdits` is invalid or the sequences differ by more than `maxEdits` edits
 */
function myersDiff<T>(caller: string, a: Iterable<T>, b: Iterable<T>, equals: (x: T, y: T) => boolean, options: DiffOptions): Array<DiffOperation<T>> {
	const left = toList(caller, 'a', a);
	const right = toList(caller, 'b', b);
	assertFunction(caller, 'equals', equals);
	// Not destructured: a polluted `Object.prototype.maxEdits` must not cap (or fail) every diff.
	const maxEdits = readOption(options, 'maxEdits', Infinity);
	assertInteger(caller, 'maxEdits', maxEdits, 0, true);
	// The searches for the middle snake of a sub-problem with D edits stop after ceil(D / 2) rounds, and every sub-problem has at most
	// as many edits as the whole problem: a search that needs more rounds proves that more than `maxEdits` edits are needed.
	const maxRounds = Math.ceil(maxEdits / 2);
	let edits = 0;

	/**
	 * Counts edits about to be emitted, and enforces `maxEdits` exactly (every edit of the script is counted here).
	 * @param {number} count - Number of new deletions or insertions
	 * @returns {void}
	 * @throws {RangeError} when more than `maxEdits` edits are needed
	 */
	function spend(count: number): void {
		edits += count;
		if (edits > maxEdits) throw new RangeError(`${caller}: the sequences differ by more than \`maxEdits\` (${maxEdits}) insertions and deletions`);
	}

	const script: Array<DiffOperation<T>> = [];
	const deletions: number[] = [];
	const insertions: number[] = [];
	// Furthest-reaching x per diagonal for the forward and backward searches, shared by every sub-problem (each one only reads
	// entries it wrote itself, plus the seed at diagonal 1). Diagonals range over [-max, max] with max = ceil((N + M) / 2).
	const offset = Math.ceil((left.length + right.length) / 2) + 1;
	const forward = new Int32Array(2 * offset);
	const backward = new Int32Array(2 * offset);

	/**
	 * Appends the pending deletions, then the pending insertions (so each change block reads "delete, then insert").
	 * @returns {void}
	 */
	function flush(): void {
		for (const indexA of deletions) script.push({ type: 'delete', value: left[indexA], indexA });
		for (const indexB of insertions) script.push({ type: 'insert', value: right[indexB], indexB });
		deletions.length = 0;
		insertions.length = 0;
	}

	/**
	 * Appends a kept element.
	 * @param {number} indexA - Its index in `a`
	 * @param {number} indexB - The index of the matching element in `b`
	 * @returns {void}
	 */
	function keep(indexA: number, indexB: number): void {
		flush();
		script.push({ type: 'equal', value: left[indexA], indexA, indexB });
	}

	/**
	 * Finds the middle snake of `a[aLo, aHi)` versus `b[bLo, bHi)`: a diagonal run on an optimal edit path, found by searching
	 * forwards from the start and backwards from the end until the two searches meet (Myers 1986, section 4b).
	 * @param {number} aLo - Start of the range of `a` (inclusive)
	 * @param {number} aHi - End of the range of `a` (exclusive)
	 * @param {number} bLo - Start of the range of `b` (inclusive)
	 * @param {number} bHi - End of the range of `b` (exclusive)
	 * @returns {[number, number, number, number]} The snake's start `(x, y)` and end `(u, v)`, as absolute indices
	 */
	function middleSnake(aLo: number, aHi: number, bLo: number, bHi: number): [number, number, number, number] {
		const n = aHi - aLo;
		const m = bHi - bLo;
		const delta = n - m;
		const odd = delta % 2 !== 0;
		forward[offset + 1] = 0;
		backward[offset + 1] = 0;

		for (let d = 0; ; d++) {
			// Round `d` costs O(d) (plus the snakes): give up as soon as the budget is provably exceeded.
			if (d > maxRounds) spend(Infinity);
			for (let k = -d; k <= d; k += 2) {
				let x = k === -d || (k !== d && forward[offset + k - 1] < forward[offset + k + 1]) ? forward[offset + k + 1] : forward[offset + k - 1] + 1;
				let y = x - k;
				const startX = x;
				const startY = y;
				while (x < n && y < m && equals(left[aLo + x], right[bLo + y])) {
					x++;
					y++;
				}
				forward[offset + k] = x;
				// The backward diagonal through the same points is delta - k; it was explored up to d - 1 edits.
				if (odd && Math.abs(delta - k) <= d - 1 && x + backward[offset + delta - k] >= n) return [aLo + startX, bLo + startY, aLo + x, bLo + y];
			}

			for (let k = -d; k <= d; k += 2) {
				let x = k === -d || (k !== d && backward[offset + k - 1] < backward[offset + k + 1]) ? backward[offset + k + 1] : backward[offset + k - 1] + 1;
				let y = x - k;
				const startX = x;
				const startY = y;
				while (x < n && y < m && equals(left[aHi - 1 - x], right[bHi - 1 - y])) {
					x++;
					y++;
				}
				backward[offset + k] = x;
				if (!odd && Math.abs(delta - k) <= d && x + forward[offset + delta - k] >= n) return [aHi - x, bHi - y, aHi - startX, bHi - startY];
			}
		}
	}

	/**
	 * Diffs `a[aLo, aHi)` against `b[bLo, bHi)`, appending to the script in order.
	 * @param {number} aLo - Start of the range of `a` (inclusive)
	 * @param {number} aHi - End of the range of `a` (exclusive)
	 * @param {number} bLo - Start of the range of `b` (inclusive)
	 * @param {number} bHi - End of the range of `b` (exclusive)
	 * @returns {void}
	 */
	function compare(aLo: number, aHi: number, bLo: number, bHi: number): void {
		// Matching a common prefix or suffix is always optimal, and it is where most real-world diffs spend their time.
		while (aLo < aHi && bLo < bHi && equals(left[aLo], right[bLo])) keep(aLo++, bLo++);
		let aEnd = aHi;
		let bEnd = bHi;
		while (aEnd > aLo && bEnd > bLo && equals(left[aEnd - 1], right[bEnd - 1])) {
			aEnd--;
			bEnd--;
		}

		if (aLo === aEnd) {
			spend(bEnd - bLo);
			for (let j = bLo; j < bEnd; j++) insertions.push(j);
		} else if (bLo === bEnd) {
			spend(aEnd - aLo);
			for (let i = aLo; i < aEnd; i++) deletions.push(i);
		} else {
			// Both ranges are non-empty and differ at both ends, so at least 2 edits are needed and each half needs strictly fewer.
			const [x, y, u, v] = middleSnake(aLo, aEnd, bLo, bEnd);
			compare(aLo, x, bLo, y);
			for (let i = x, j = y; i < u; i++, j++) keep(i, j);
			compare(u, aEnd, v, bEnd);
		}

		for (let i = aEnd, j = bEnd; i < aHi; i++, j++) keep(i, j);
	}

	compare(0, left.length, 0, right.length);
	flush();
	return script;
}

/**
 * Computes a minimal edit script turning sequence `a` into sequence `b`: a list of `'equal'`, `'delete'` and `'insert'` operations
 * (see {@link DiffOperation}) with the smallest possible number of deletions plus insertions. Reading the script in order,
 * the `'equal'` and `'delete'` values spell out `a`, and the `'equal'` and `'insert'` values spell out `b`. Within each run of
 * changes, deletions come before insertions. When several minimal scripts exist, which one is returned is unspecified but
 * deterministic.
 *
 * Uses Myers' O((N + M)·D) algorithm, in its linear-space divide-and-conquer form, after stripping the common prefix and suffix:
 * time is O((N + M)·D) where D is the size of the edit script (so near-identical inputs are fast, and completely different ones
 * cost O((N + M)²)), memory is O(N + M), and recursion depth is O(log D). Non-array iterables are copied first (strings are split
 * into code points).
 *
 * **Untrusted input:** two unrelated texts of 16,000 characters already take seconds of CPU. Cap the input sizes, or pass
 * `{ maxEdits }`, which bounds the work to O((N + M) · maxEdits) and throws a `RangeError` when the sequences differ by more.
 * @template T - The element type
 * @param {Iterable<T>} a - The original sequence
 * @param {Iterable<T>} b - The target sequence
 * @param {(x: T, y: T) => boolean} [equals=SameValueZero] - Element equality, always called as `equals(itemOfA, itemOfB)`;
 * defaults to SameValueZero (`===`, except that `NaN` equals `NaN`). `'equal'` operations carry the element of `a`.
 * @param {DiffOptions} [options={}] - `maxEdits` (default `Infinity`): the largest number of deletions plus insertions accepted
 * @returns {Array<DiffOperation<T>>} The edit script, in order
 * @throws {TypeError} when `a` or `b` is not iterable, `equals` is not a function, or `maxEdits` is not a number
 * @throws {RangeError} when `maxEdits` is not an integer >= 0 or `Infinity`, or the sequences differ by more than `maxEdits` edits
 * @example
 * diffSequences([1, 2, 3], [1, 3, 4]); // => [{ type: 'equal', value: 1, indexA: 0, indexB: 0 }, { type: 'delete', value: 2, indexA: 1 }, { type: 'equal', value: 3, indexA: 2, indexB: 1 }, { type: 'insert', value: 4, indexB: 2 }]
 * diffSequences('cat', 'cut').map(function (op) { return op.type; }); // => ['equal', 'delete', 'insert', 'equal']
 * @example
 * const before = ['Alice', 'bob'];
 * const after = ['alice', 'Bob', 'Carol'];
 * diffSequences(before, after, function (x, y) { return x.toLowerCase() === y.toLowerCase(); }).map(function (op) { return op.type; }); // => ['equal', 'equal', 'insert']
 * @example
 * diffSequences('kitten', 'sitting', undefined, { maxEdits: 5 }).length; // => 9
 * diffSequences('a'.repeat(10000), 'b'.repeat(10000), undefined, { maxEdits: 100 }); // throws RangeError
 */
export function diffSequences<T>(a: Iterable<T>, b: Iterable<T>, equals: (x: T, y: T) => boolean = sameValueZero, options: DiffOptions = {}): Array<DiffOperation<T>> {
	return myersDiff('diffSequences', a, b, equals, options);
}

/**
 * Computes a longest common subsequence of `a` and `b`: the longest list of elements that appear in both, in the same relative
 * order (not necessarily contiguously). It is the `'equal'` part of {@link diffSequences}, with the same complexity
 * (O((N + M)·D) time, O(N + M) memory). When several longest subsequences exist, which one is returned is unspecified but deterministic.
 * **Untrusted input:** cap the input sizes or pass `{ maxEdits }`, as for {@link diffSequences}.
 * @template T - The element type
 * @param {Iterable<T>} a - The first sequence
 * @param {Iterable<T>} b - The second sequence
 * @param {(x: T, y: T) => boolean} [equals=SameValueZero] - Element equality, always called as `equals(itemOfA, itemOfB)`;
 * defaults to SameValueZero. The returned elements are taken from `a`.
 * @param {DiffOptions} [options={}] - `maxEdits` (default `Infinity`): the largest number of deletions plus insertions accepted
 * @returns {T[]} The common subsequence, as a new array of elements of `a`
 * @throws {TypeError} when `a` or `b` is not iterable, `equals` is not a function, or `maxEdits` is not a number
 * @throws {RangeError} when `maxEdits` is not an integer >= 0 or `Infinity`, or the sequences differ by more than `maxEdits` edits
 * @example
 * longestCommonSubsequence([1, 2, 3, 4, 5], [2, 4, 6, 5]); // => [2, 4, 5]
 * longestCommonSubsequence('ABCBDAB', 'BDCABA').length; // => 4
 * longestCommonSubsequence([NaN, 0], [-0, NaN]).length; // => 1
 */
export function longestCommonSubsequence<T>(a: Iterable<T>, b: Iterable<T>, equals: (x: T, y: T) => boolean = sameValueZero, options: DiffOptions = {}): T[] {
	const common: T[] = [];
	for (const operation of myersDiff('longestCommonSubsequence', a, b, equals, options)) {
		if (operation.type === 'equal') common.push(operation.value);
	}
	return common;
}

/**
 * Like {@link union}, but items are compared by the key `keyFn` returns (SameValueZero): every item of `a`, then of `b`, whose key
 * was not seen before, so only the FIRST item per key is kept. `unionBy(a, b, identity)` equals `union(a, b)`.
 * `keyFn` is called once per item of both iterables.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The first items
 * @param {Iterable<U>} b - The second items
 * @param {(item: T | U) => unknown} keyFn - Returns the identity key of an item of either iterable
 * @returns {Array<T | U>} One item per distinct key, in first-appearance order
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * unionBy([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], function (o) { return o.id; }); // => [{ id: 1 }, { id: 2 }, { id: 3 }]
 * unionBy([1.2, 2.5], [2.1, 3.4], Math.floor); // => [1.2, 2.5, 3.4]
 */
export function unionBy<T, U = T>(a: Iterable<T>, b: Iterable<U>, keyFn: (item: T | U) => unknown): Array<T | U> {
	assertFunction('unionBy', 'keyFn', keyFn);
	const seen = new Set<unknown>();
	const result: Array<T | U> = [];
	for (const items of [a, b] as Array<Iterable<T | U>>) {
		for (const item of items) {
			const key = keyFn(item);
			if (!seen.has(key)) {
				seen.add(key);
				result.push(item);
			}
		}
	}
	return result;
}

/**
 * Appends to `result` the items whose key is not in `excluded`, adding each appended key to `excluded` (so one item per key).
 * @template T
 * @param {ReadonlyArray<T>} items - The items
 * @param {unknown[]} keys - The key of each item
 * @param {Set<unknown>} excluded - Keys to skip; grows with every appended item
 * @param {T[]} result - The array appended to
 * @returns {T[]} `result`
 */
function keepNew<T>(items: ReadonlyArray<T>, keys: unknown[], excluded: Set<unknown>, result: T[]): T[] {
	for (let i = 0; i < items.length; i++) {
		if (!excluded.has(keys[i])) {
			excluded.add(keys[i]);
			result.push(items[i]);
		}
	}
	return result;
}

/**
 * Like {@link symmetricDifference}, but items are compared by the key `keyFn` returns (SameValueZero): the items of `a` whose key
 * is not the key of any item of `b`, followed by the items of `b` whose key is not the key of any item of `a`, keeping only the
 * FIRST item per key. `keyFn` is called once per item of both iterables.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The first items
 * @param {Iterable<U>} b - The second items
 * @param {(item: T | U) => unknown} keyFn - Returns the identity key of an item of either iterable
 * @returns {Array<T | U>} The items whose key appears in exactly one of the iterables, in first-appearance order
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * symmetricDifferenceBy([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], function (o) { return o.id; }); // => [{ id: 1 }, { id: 3 }]
 */
export function symmetricDifferenceBy<T, U = T>(a: Iterable<T>, b: Iterable<U>, keyFn: (item: T | U) => unknown): Array<T | U> {
	assertFunction('symmetricDifferenceBy', 'keyFn', keyFn);
	const left = Array.from(a);
	const right = Array.from(b);
	const leftKeys = keyList(left, keyFn);
	const rightKeys = keyList(right, keyFn);
	// Emitted keys join the set of the side they are tested against, which keeps one item per key without another Set.
	const result = keepNew<T | U>(left, leftKeys, new Set(rightKeys), []);
	return keepNew(right, rightKeys, new Set(leftKeys), result);
}

/**
 * Appends to `result` the items not `equals` to an item already in it.
 * @template T
 * @param {Iterable<T>} items - The candidates
 * @param {(x: T, y: T) => boolean} equals - The equality (`x` is the candidate, `y` an item already kept)
 * @param {T[]} result - The array appended to
 * @returns {T[]} `result`
 */
function keepDistinct<T>(items: Iterable<T>, equals: (x: T, y: T) => boolean, result: T[]): T[] {
	// The scans are inlined in the comparator-based helpers: a shared scanning function is not inlined by V8, which halves their speed.
	for (const item of items) {
		let i = 0;
		while (i < result.length && !equals(item, result[i])) i++;
		if (i === result.length) result.push(item);
	}
	return result;
}

/**
 * Remove the items `equals` to an earlier item, keeping the first occurrence: {@link unique} with a custom equality, for
 * values that have no identity key (e.g. points within a tolerance). It compares every pair, in O(n²): when a key exists, prefer
 * {@link uniqueBy}, which is O(n).
 * @template T
 * @param {Iterable<T>} iterable - The items to deduplicate
 * @param {(x: T, y: T) => boolean} equals - Whether two items are duplicates (`x` is the candidate, `y` an item already kept)
 * @returns {T[]} A new array of distinct items, in first-appearance order
 * @throws {TypeError} when `equals` is not a function
 * @example
 * uniqueWith([1, 1.05, 2, 1.9], function (x, y) { return Math.abs(x - y) < 0.2; }); // => [1, 2]
 */
export function uniqueWith<T>(iterable: Iterable<T>, equals: (x: T, y: T) => boolean): T[] {
	assertFunction('uniqueWith', 'equals', equals);
	return keepDistinct(iterable, equals, []);
}

/**
 * {@link union} with a custom equality: every item of `a`, then of `b`, not `equals` to an item already kept (first occurrence
 * wins). O(n²) in the total number of items: when a key exists, prefer {@link unionBy}, which is linear.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The first items
 * @param {Iterable<U>} b - The second items
 * @param {(x: T | U, y: T | U) => boolean} equals - Whether two items are the same (`x` is the candidate, `y` an item already kept)
 * @returns {Array<T | U>} The distinct items of both iterables, in first-appearance order
 * @throws {TypeError} when `equals` is not a function
 * @example
 * unionWith([{ x: 1, y: 2 }], [{ x: 1, y: 2 }, { x: 3, y: 4 }], function (p, q) { return p.x === q.x && p.y === q.y; }); // => [{ x: 1, y: 2 }, { x: 3, y: 4 }]
 */
export function unionWith<T, U = T>(a: Iterable<T>, b: Iterable<U>, equals: (x: T | U, y: T | U) => boolean): Array<T | U> {
	assertFunction('unionWith', 'equals', equals);
	return keepDistinct<T | U>(b, equals, keepDistinct<T | U>(a, equals, []));
}

/**
 * {@link difference} with a custom equality: the items of `a` not `equals` to any item of `b`, keeping only the first of several
 * items of `a` that are `equals` to each other. O(n·m): when a key exists, prefer {@link differenceBy}, which is linear.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The items to take from (defines the output order)
 * @param {Iterable<U>} b - The items to exclude
 * @param {(x: T, y: T | U) => boolean} equals - Whether two items are the same (`x` is always an item of `a`; `y` is an item of `b`, or an item of `a` already kept)
 * @returns {T[]} The distinct items of `a` with no equal in `b`, in first-appearance order
 * @throws {TypeError} when `equals` is not a function
 * @example
 * differenceWith([{ x: 1 }, { x: 2 }], [{ x: 2 }], function (p, q) { return p.x === q.x; }); // => [{ x: 1 }]
 */
export function differenceWith<T, U = T>(a: Iterable<T>, b: Iterable<U>, equals: (x: T, y: T | U) => boolean): T[] {
	assertFunction('differenceWith', 'equals', equals);
	// Kept items join the exclusion list, which removes later duplicates of them in the same pass.
	const excluded: Array<T | U> = Array.isArray(b) ? b.slice() : Array.from(b);
	const result: T[] = [];
	for (const item of a) {
		let i = 0;
		while (i < excluded.length && !equals(item, excluded[i])) i++;
		if (i === excluded.length) {
			excluded.push(item);
			result.push(item);
		}
	}
	return result;
}

/**
 * {@link intersection} with a custom equality: the items of `a` `equals` to some item of `b`, keeping only the first of several
 * items of `a` that are `equals` to each other. O(n·m): when a key exists, prefer {@link intersectionBy}, which is linear.
 * @template T - The item type of `a`
 * @template U - The item type of `b`
 * @param {Iterable<T>} a - The items to take from (defines the output order)
 * @param {Iterable<U>} b - The items to match
 * @param {(x: T, y: T | U) => boolean} equals - Whether two items are the same (`x` is always an item of `a`; `y` is an item of `b`, or an item of `a` already kept)
 * @returns {T[]} The distinct items of `a` with an equal in `b`, in first-appearance order
 * @throws {TypeError} when `equals` is not a function
 * @example
 * intersectionWith([{ x: 1 }, { x: 2 }], [{ x: 2 }], function (p, q) { return p.x === q.x; }); // => [{ x: 2 }]
 */
export function intersectionWith<T, U = T>(a: Iterable<T>, b: Iterable<U>, equals: (x: T, y: T | U) => boolean): T[] {
	assertFunction('intersectionWith', 'equals', equals);
	const candidates: ReadonlyArray<U> = Array.isArray(b) ? b : Array.from(b);
	const result: T[] = [];
	for (const item of a) {
		let i = 0;
		while (i < candidates.length && !equals(item, candidates[i])) i++;
		if (i === candidates.length) continue;
		let j = 0;
		while (j < result.length && !equals(item, result[j])) j++;
		if (j === result.length) result.push(item);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ordering and ranking
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Return a sorted copy of an array, ordered by several keys: by the first selector's key, then items with equal first keys by the
 * second selector's key, and so on, each key in its own direction. The sort is stable (items with equal keys in all selectors keep
 * their input order) and each selector is called exactly once per item, not once per comparison.
 *
 * Every key follows the ordering rules of {@link sortBy}, which make the order TOTAL and deterministic: numbers/bigints numerically
 * and before strings, strings by UTF-16 code units, `Date`s by timestamp, and `NaN`, invalid `Date`s, `null` and `undefined` keys
 * after every other key in BOTH directions (equal to each other, so the next selector decides between them).
 * @template T
 * @param {ReadonlyArray<T>} array - The items to sort (not mutated)
 * @param {ReadonlyArray<(item: T, index: number) => SortKey | null | undefined>} selectors - Return the keys of an item, most significant first (none: a plain copy)
 * @param {SortOrder | ReadonlyArray<SortOrder>} [orders='asc'] - One direction for all keys, or one per selector (missing trailing ones are `'asc'`)
 * @returns {T[]} A new sorted array
 * @throws {TypeError} when `selectors` is not an array of functions, or `orders` is neither a direction nor an array
 * @throws {RangeError} when a direction is neither `'asc'` nor `'desc'`, or there are more directions than selectors
 * @example
 * const users = [{ name: 'bo', age: 30 }, { name: 'al', age: 25 }, { name: 'cy', age: 30 }];
 * orderBy(users, [function (u) { return u.age; }, function (u) { return u.name; }], ['desc', 'asc']); // => [{ name: 'bo', age: 30 }, { name: 'cy', age: 30 }, { name: 'al', age: 25 }]
 * orderBy([3, NaN, 1], [function (n) { return n; }]); // => [1, 3, NaN]
 */
export function orderBy<T>(
	array: ReadonlyArray<T>,
	selectors: ReadonlyArray<(item: T, index: number) => SortKey | null | undefined>,
	orders: SortOrder | ReadonlyArray<SortOrder> = 'asc'
): T[] {
	if (!Array.isArray(selectors)) throw new TypeError(`orderBy: \`selectors\` must be an array of functions, got ${describe(selectors)}`);
	const single = typeof orders === 'string';
	if (!single && !Array.isArray(orders)) throw new TypeError(`orderBy: \`orders\` must be 'asc', 'desc' or an array of them, got ${describe(orders)}`);
	const count = selectors.length;
	if (!single && orders.length > count) throw new RangeError(`orderBy: \`orders\` must not be longer than \`selectors\` (${count}), got ${orders.length} directions`);
	const shared = single ? toDirection('orderBy', 'orders', orders) : 0;
	const directions: number[] = [];
	for (let k = 0; k < count; k++) {
		// The parameter names are only formatted on failure.
		if (typeof selectors[k] !== 'function') assertFunction('orderBy', `selectors[${k}]`, selectors[k]);
		// Missing trailing directions are not read: past the end, an index would be looked up on a polluted `Object.prototype`.
		directions.push(single ? shared : toDirection('orderBy', 'orders', k < orders.length ? (orders[k] ?? 'asc') : 'asc', k));
	}
	if (count === 1) return sortBy(array, selectors[0], directions[0] === 1 ? 'asc' : 'desc');
	const length = array.length;
	// Decorate: the keys of item `i` are `keys[i * count]` to `keys[i * count + count - 1]`.
	const keys: Array<number | string | bigint> = [];
	const indices: number[] = [];
	for (let i = 0; i < length; i++) {
		for (let k = 0; k < count; k++) keys.push(rank(selectors[k](array[i], i)));
		indices.push(i);
	}
	// The sort is stable and `indices` is in input order, so items with equal keys keep their relative order.
	stableSort(indices, function (x: number, y: number): number {
		for (let k = 0; k < count; k++) {
			const comparison = compareRanked(keys[x * count + k], keys[y * count + k], directions[k]);
			if (comparison !== 0) return comparison;
		}
		return 0;
	});
	const result = new Array<T>(length);
	for (let i = 0; i < length; i++) result[i] = array[indices[i]];
	return result;
}

/**
 * Restores the heap property of `heap[from..size)` from position `position` down: the root holds the WORST ranked entry.
 * Entries are item indices, ranked by their key (`compareRanked`) then by index (later is worse), a strict total order.
 * @param {number[]} heap - Item indices
 * @param {Array<number | string | bigint>} keys - The comparable key of each heap slot (parallel to `heap`)
 * @param {number} size - The number of entries in the heap
 * @param {number} position - The slot to sift down
 * @param {number} dir - `1` for ascending, `-1` for descending
 * @returns {void}
 */
function siftDown(heap: number[], keys: Array<number | string | bigint>, size: number, position: number, dir: number): void {
	for (;;) {
		let worst = position;
		for (let child = 2 * position + 1; child <= 2 * position + 2 && child < size; child++) {
			const comparison = compareRanked(keys[child], keys[worst], dir);
			if (comparison > 0 || (comparison === 0 && heap[child] > heap[worst])) worst = child;
		}
		if (worst === position) return;
		const index = heap[position];
		const key = keys[position];
		heap[position] = heap[worst];
		keys[position] = keys[worst];
		heap[worst] = index;
		keys[worst] = key;
		position = worst;
	}
}

/**
 * Selects the `size` best-ranked items in O(n log size) with a bounded heap.
 * @template T
 * @param {string} caller - Name of the public function, used in error messages
 * @param {ReadonlyArray<T>} array - The items
 * @param {number} size - How many items to keep (an integer in `[0, length]`)
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the key of an item
 * @param {SortOrder} order - The direction
 * @returns {[number[], Array<number | string | bigint>, number]} The heap of item indices (worst at the root), their keys, and the direction
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 */
function selectBest<T>(
	caller: string,
	array: ReadonlyArray<T>,
	size: number,
	selector: (item: T, index: number) => SortKey | null | undefined,
	order: SortOrder
): [number[], Array<number | string | bigint>, number] {
	assertFunction(caller, 'selector', selector);
	const dir = toDirection(caller, 'order', order);
	const heap: number[] = [];
	const keys: Array<number | string | bigint> = [];
	if (size === 0) return [heap, keys, dir];
	for (let i = 0; i < size; i++) {
		heap.push(i);
		keys.push(rank(selector(array[i], i)));
	}
	for (let position = (size >> 1) - 1; position >= 0; position--) siftDown(heap, keys, size, position, dir);
	for (let i = size; i < array.length; i++) {
		const key = rank(selector(array[i], i));
		// A later item replaces the root only when STRICTLY better ranked, so ties keep the earlier item (stability).
		if (compareRanked(key, keys[0], dir) < 0) {
			heap[0] = i;
			keys[0] = key;
			siftDown(heap, keys, size, 0, dir);
		}
	}
	return [heap, keys, dir];
}

/**
 * Return the `n` first items of `sortBy(array, selector, order)` without sorting the whole array: a bounded heap selects them in
 * O(length · log n), then only they are sorted. Same ordering rules as {@link sortBy} (stable on ties, `NaN`/invalid `Date`/nullish
 * keys last in both directions), so the result always equals `sortBy(array, selector, order).slice(0, n)`.
 * The selector is called exactly once per item. Use `'desc'` for the `n` largest ("top N").
 * @template T
 * @param {ReadonlyArray<T>} array - The items to rank (not mutated)
 * @param {number} n - How many items to return (a non-negative integer; all of them when larger than the array)
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the ranking key of an item
 * @param {SortOrder} [order='asc'] - `'asc'` for the smallest keys first, `'desc'` for the largest first
 * @returns {T[]} A new array of at most `n` items, in rank order
 * @throws {TypeError} when `n` is not a number or `selector` is not a function
 * @throws {RangeError} when `n` is not a non-negative integer, or `order` is neither `'asc'` nor `'desc'`
 * @example
 * const scores = [{ id: 'a', score: 7 }, { id: 'b', score: 9 }, { id: 'c', score: 8 }];
 * takeFirstBy(scores, 2, function (s) { return s.score; }, 'desc'); // => [{ id: 'b', score: 9 }, { id: 'c', score: 8 }]
 * takeFirstBy([5, NaN, 1, 3], 3, function (n) { return n; }); // => [1, 3, 5]
 */
export function takeFirstBy<T>(array: ReadonlyArray<T>, n: number, selector: (item: T, index: number) => SortKey | null | undefined, order: SortOrder = 'asc'): T[] {
	assertInteger('takeFirstBy', 'n', n, 0);
	if (n >= array.length) {
		// Every item is taken: a plain sort is cheaper than the heap.
		assertFunction('takeFirstBy', 'selector', selector);
		toDirection('takeFirstBy', 'order', order);
		return sortBy(array, selector, order);
	}
	const [heap, keys, dir] = selectBest('takeFirstBy', array, n, selector, order);
	const slots = range(heap.length);
	stableSort(slots, function (x: number, y: number): number {
		return compareRanked(keys[x], keys[y], dir) || heap[x] - heap[y];
	});
	return slots.map(function (slot: number): T {
		return array[heap[slot]];
	});
}

/**
 * Return the item at position `index` of `sortBy(array, selector, order)` without sorting the whole array (a bounded heap of
 * `position + 1` items, O(length · log position)): `0` is the first ranked item, `1` the second... Negative indices count from the end
 * like `Array.prototype.at` (`-1` is the last ranked item). Same ordering rules as {@link sortBy}: stable on ties, and `NaN`/invalid
 * `Date`/nullish keys ranked last in both directions. The selector is called exactly once per item.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to rank (not mutated)
 * @param {number} index - The rank to return, an integer (negative counts from the end)
 * @param {(item: T, index: number) => SortKey | null | undefined} selector - Returns the ranking key of an item
 * @param {SortOrder} [order='asc'] - `'asc'` to rank the smallest keys first, `'desc'` the largest first
 * @returns {T | undefined} The item at that rank, or `undefined` when `index` is out of range
 * @throws {TypeError} when `index` is not a number or `selector` is not a function
 * @throws {RangeError} when `index` is not an integer, or `order` is neither `'asc'` nor `'desc'`
 * @example
 * nthBy([40, 10, 30, 20], 1, function (n) { return n; }); // => 20
 * nthBy([40, 10, 30, 20], 0, function (n) { return n; }, 'desc'); // => 40
 * nthBy([40, 10, 30, 20], -1, function (n) { return n; }); // => 40
 * nthBy([1, 2], 5, function (n) { return n; }); // => undefined
 */
export function nthBy<T>(array: ReadonlyArray<T>, index: number, selector: (item: T, index: number) => SortKey | null | undefined, order: SortOrder = 'asc'): T | undefined {
	assertNumber('nthBy', 'index', index, Number.isInteger(index), 'an integer');
	const position = index < 0 ? array.length + index : index;
	// Out-of-range positions still validate `selector` and `order`, through a selection of no item.
	const [heap] = selectBest('nthBy', array, position >= 0 && position < array.length ? position + 1 : 0, selector, order);
	// The root of the heap of the `position + 1` best items is the worst of them: the item at `position`.
	return heap.length === 0 ? undefined : array[heap[0]];
}

/**
 * Shared worker of {@link sortedIndexBy} and {@link sortedLastIndexBy}.
 * @template T
 * @param {string} caller - Name of the public function, used in error messages
 * @param {ReadonlyArray<T>} sortedArray - Items sorted as `sortBy(sortedArray, selector, order)` would
 * @param {T} value - The item to locate
 * @param {(item: T) => SortKey | null | undefined} selector - Returns the sort key of an item
 * @param {SortOrder} order - The direction the array is sorted in
 * @param {boolean} upper - Whether to return the upper bound
 * @returns {number} An index in `[0, length]`
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 */
function sortedIndexByKey<T>(
	caller: string,
	sortedArray: ReadonlyArray<T>,
	value: T,
	selector: (item: T) => SortKey | null | undefined,
	order: SortOrder,
	upper: boolean
): number {
	assertFunction(caller, 'selector', selector);
	const dir = toDirection(caller, 'order', order);
	const target = rank(selector(value));
	let low = 0;
	let high = sortedArray.length;
	while (low < high) {
		// Not `(low + high) >>> 1`, which wraps around past 2 ** 32 (array-likes and sparse arrays can be that long).
		const middle = low + ((high - low) >>> 1);
		const comparison = compareRanked(rank(selector(sortedArray[middle])), target, dir);
		if (comparison < 0 || (upper && comparison === 0)) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Find, by binary search (O(log n) selector calls), the LOWEST index at which `value` can be inserted into `sortedArray` keeping it
 * sorted by the key `selector` returns (before any items with an equal key). Keys are compared with the ordering rules of
 * {@link sortBy}, so any array sorted by `sortBy(items, selector, order)` qualifies, including its trailing `NaN`/invalid
 * `Date`/nullish keys (an unorderable `value` key is located among them). For another order, use {@link sortedIndex} with a comparator.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - Items sorted as `sortBy(sortedArray, selector, order)` would
 * @param {T} value - The item to locate (its key is computed once)
 * @param {(item: T) => SortKey | null | undefined} selector - Returns the sort key of an item
 * @param {SortOrder} [order='asc'] - The direction the array is sorted in
 * @returns {number} An index in `[0, length]`
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 * @example
 * const byAge = [{ age: 20 }, { age: 30 }, { age: 30 }, { age: 40 }];
 * sortedIndexBy(byAge, { age: 30 }, function (p) { return p.age; }); // => 1
 * sortedIndexBy([3, 2, 1], 2, function (n) { return n; }, 'desc'); // => 1
 */
export function sortedIndexBy<T>(sortedArray: ReadonlyArray<T>, value: T, selector: (item: T) => SortKey | null | undefined, order: SortOrder = 'asc'): number {
	return sortedIndexByKey('sortedIndexBy', sortedArray, value, selector, order, false);
}

/**
 * Like {@link sortedIndexBy}, but returns the HIGHEST insertion index (after any items with an equal key), which keeps insertion
 * order among equal keys when used to insert.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - Items sorted as `sortBy(sortedArray, selector, order)` would
 * @param {T} value - The item to locate (its key is computed once)
 * @param {(item: T) => SortKey | null | undefined} selector - Returns the sort key of an item
 * @param {SortOrder} [order='asc'] - The direction the array is sorted in
 * @returns {number} An index in `[0, length]`
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 * @example
 * sortedLastIndexBy([{ age: 20 }, { age: 30 }, { age: 30 }, { age: 40 }], { age: 30 }, function (p) { return p.age; }); // => 3
 */
export function sortedLastIndexBy<T>(sortedArray: ReadonlyArray<T>, value: T, selector: (item: T) => SortKey | null | undefined, order: SortOrder = 'asc'): number {
	return sortedIndexByKey('sortedLastIndexBy', sortedArray, value, selector, order, true);
}

/**
 * Find, by binary search (O(log n)), the HIGHEST index at which `value` can be inserted into `sortedArray` keeping it sorted (after
 * any equal items): the upper-bound counterpart of {@link sortedIndex}. Without a comparator, numbers, strings or bigints are
 * ordered with `<`; the array must already be sorted in that order (and contain no `NaN`), otherwise the result is unspecified.
 * @template T - A number, string or bigint type
 * @param {ReadonlyArray<T>} sortedArray - An array sorted in ascending `<` order
 * @param {T} value - The value to locate
 * @returns {number} An index in `[0, length]`
 * @throws {RangeError} when `value` is `NaN`
 * @example
 * sortedLastIndex([10, 20, 20, 30], 20); // => 3
 * sortedLastIndex([10, 20, 30], 5); // => 0
 */
export function sortedLastIndex<T extends number | string | bigint>(sortedArray: ReadonlyArray<T>, value: T): number;
/**
 * Find, by binary search (O(log n)), the HIGHEST index at which `value` can be inserted into `sortedArray` keeping it sorted
 * according to `compare` (after any items comparing equal). The array must already be sorted by `compare`.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - An array sorted according to `compare`
 * @param {T} value - The value to locate
 * @param {Comparator<T>} compare - The comparator the array is sorted by
 * @returns {number} An index in `[0, length]`
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * sortedLastIndex([{ n: 1 }, { n: 3 }, { n: 3 }], { n: 3 }, function (a, b) { return a.n - b.n; }); // => 3
 */
export function sortedLastIndex<T>(sortedArray: ReadonlyArray<T>, value: T, compare: Comparator<T>): number;
/**
 * Implementation of {@link sortedLastIndex}.
 * @template T
 * @param {ReadonlyArray<T>} sortedArray - A sorted array
 * @param {T} value - The value to locate
 * @param {Comparator<T>} [compare] - The comparator the array is sorted by
 * @returns {number} The highest insertion index
 * @throws {RangeError} when `value` is `NaN` and no comparator is given
 * @throws {TypeError} when `compare` is given but is not a function
 * @example
 * sortedLastIndex([1, 3, 3], 3); // => 3
 */
export function sortedLastIndex<T>(sortedArray: ReadonlyArray<T>, value: T, compare?: Comparator<T>): number {
	return searchBound('sortedLastIndex', sortedArray, value, compare, true)[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// Slicing, splitting and reordering
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Return the last `n` items of an array (or all of them when it is shorter). Unlike `array.slice(-n)`, `n = 0` gives `[]`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} n - How many items to take (a non-negative integer)
 * @returns {T[]} A new array with at most `n` items
 * @throws {RangeError} when `n` is negative or not an integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * takeLast([1, 2, 3], 2); // => [2, 3]
 * takeLast([1, 2, 3], 0); // => []
 */
export function takeLast<T>(array: ReadonlyArray<T>, n: number): T[] {
	assertInteger('takeLast', 'n', n, 0);
	return copyRange(array, Math.max(array.length - n, 0), array.length);
}

/**
 * Return an array without its last `n` items.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} n - How many items to drop (a non-negative integer)
 * @returns {T[]} A new array with the remaining items
 * @throws {RangeError} when `n` is negative or not an integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * dropLast([1, 2, 3], 2); // => [1]
 * dropLast([1, 2, 3], 0); // => [1, 2, 3]
 */
export function dropLast<T>(array: ReadonlyArray<T>, n: number): T[] {
	assertInteger('dropLast', 'n', n, 0);
	return copyRange(array, 0, Math.max(array.length - n, 0));
}

/**
 * The index just after the last item, scanning from the end, for which `predicate` returns false (`0` when it holds for all).
 * @template T
 * @param {string} caller - Name of the public function, used in the error message
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => boolean} predicate - The condition
 * @returns {number} The start of the longest suffix whose items all match
 * @throws {TypeError} when `predicate` is not a function
 */
function suffixStart<T>(caller: string, array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): number {
	assertFunction(caller, 'predicate', predicate);
	let start = array.length;
	while (start > 0 && predicate(array[start - 1], start - 1)) start--;
	return start;
}

/**
 * Return the longest suffix of an array whose items all match `predicate`, scanning from the end and stopping at the first item
 * that does not match. The predicate receives each item with its index in the input.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {(item: T, index: number) => boolean} predicate - The condition the kept items meet
 * @returns {T[]} A new array with the matching trailing items, in input order
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * takeLastWhile([1, 5, 2, 3], function (n) { return n < 4; }); // => [2, 3]
 */
export function takeLastWhile<T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): T[] {
	return copyRange(array, suffixStart('takeLastWhile', array, predicate), array.length);
}

/**
 * Return an array without its longest suffix whose items all match `predicate` (scanning from the end, stopping at the first item
 * that does not match). The predicate receives each item with its index in the input.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {(item: T, index: number) => boolean} predicate - The condition the dropped items meet
 * @returns {T[]} A new array with the remaining items
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * dropLastWhile(['a', 'b', '', ''], function (s) { return s === ''; }); // => ['a', 'b']
 */
export function dropLastWhile<T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): T[] {
	return copyRange(array, 0, suffixStart('dropLastWhile', array, predicate));
}

/**
 * Split an array into runs of ADJACENT items with the same key (compared with SameValueZero, so `NaN` keys group together), like
 * Python's `itertools.groupby`: unlike {@link groupBy}, a key that comes back after another one starts a new run.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {(item: T, index: number) => unknown} keyFn - Returns the key of an item (called once per item)
 * @returns {T[][]} The runs, in input order (each a fresh, non-empty array); `[]` for an empty array
 * @throws {TypeError} when `keyFn` is not a function
 * @example
 * chunkBy([1, 3, 2, 4, 5], function (n) { return n % 2; }); // => [[1, 3], [2, 4], [5]]
 * chunkBy(['a', 'b', 'a'], function (s) { return s; }); // => [['a'], ['b'], ['a']]
 */
export function chunkBy<T>(array: ReadonlyArray<T>, keyFn: (item: T, index: number) => unknown): T[][] {
	assertFunction('chunkBy', 'keyFn', keyFn);
	const result: T[][] = [];
	let run: T[] = [];
	let previous: unknown;
	for (let i = 0; i < array.length; i++) {
		const key = keyFn(array[i], i);
		// SameValueZero, inlined.
		if (i > 0 && (key === previous || (key !== key && previous !== previous))) run.push(array[i]);
		else {
			run = [array[i]];
			result.push(run);
		}
		previous = key;
	}
	return result;
}

/**
 * Split an array in two at the first item matching `predicate`: the items before it, and the rest (starting with that item).
 * When no item matches, the second part is empty.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {(item: T, index: number) => boolean} predicate - The condition that starts the second part
 * @returns {[T[], T[]]} `[before, fromMatch]`, two new arrays
 * @throws {TypeError} when `predicate` is not a function
 * @example
 * splitWhen([1, 2, 3, 2], function (n) { return n > 2; }); // => [[1, 2], [3, 2]]
 * splitWhen([1, 2], function (n) { return n > 5; }); // => [[1, 2], []]
 */
export function splitWhen<T>(array: ReadonlyArray<T>, predicate: (item: T, index: number) => boolean): [T[], T[]] {
	assertFunction('splitWhen', 'predicate', predicate);
	let index = 0;
	while (index < array.length && !predicate(array[index], index)) index++;
	return [copyRange(array, 0, index), copyRange(array, index, array.length)];
}

/**
 * Return a copy of an array with the items at positions `i` and `j` exchanged (the input is not mutated). Negative indices count
 * from the end, like `Array.prototype.at`. Holes of sparse arrays become `undefined`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} i - Index of the first item, in `[-length, length - 1]`
 * @param {number} j - Index of the second item, in `[-length, length - 1]`
 * @returns {T[]} A new array, a permutation of the input
 * @throws {RangeError} when `i` or `j` is not an integer or is out of range (any index is out of range for an empty array)
 * @throws {TypeError} when `i` or `j` is not a number
 * @example
 * swap(['a', 'b', 'c'], 0, 2); // => ['c', 'b', 'a']
 * swap(['a', 'b', 'c'], 0, -2); // => ['b', 'a', 'c']
 */
export function swap<T>(array: ReadonlyArray<T>, i: number, j: number): T[] {
	const left = resolveIndex('swap', 'i', i, array.length, false);
	const right = resolveIndex('swap', 'j', j, array.length, false);
	const result = Array.from(array);
	result[left] = array[right];
	result[right] = array[left];
	return result;
}

/**
 * Return a copy of an array rotated by `k` positions (the input is not mutated): a positive `k` moves every item `k` places towards
 * the END, the last items wrapping around to the front (like Python's `deque.rotate`); a negative `k` rotates towards the start.
 * `k` may exceed the length (it is taken modulo the length). Holes of sparse arrays become `undefined`.
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} k - The number of positions, an integer (any sign or magnitude)
 * @returns {T[]} A new array, a permutation of the input
 * @throws {RangeError} when `k` is not an integer
 * @throws {TypeError} when `k` is not a number
 * @example
 * rotate([1, 2, 3, 4], 1); // => [4, 1, 2, 3]
 * rotate([1, 2, 3, 4], -1); // => [2, 3, 4, 1]
 * rotate([1, 2, 3], 7); // => [3, 1, 2]
 */
export function rotate<T>(array: ReadonlyArray<T>, k: number): T[] {
	assertNumber('rotate', 'k', k, Number.isInteger(k), 'an integer');
	const length = array.length;
	const result = new Array<T>(length);
	// The item at `i` moves to `i + k` (mod length): position `i` of the result takes the item at `i - shift`.
	const shift = ((k % length) + length) % length;
	for (let i = 0; i < length; i++) result[i] = array[i < shift ? i - shift + length : i - shift];
	return result;
}

/**
 * Return a copy of an array where `item` is removed if present, or appended otherwise: the state change of a checkbox list or tag
 * picker. Presence is decided by SameValueZero (so `NaN` is found), or by comparing the keys `keyFn` returns. Every matching item
 * is removed (a list with duplicates loses all of them).
 * @template T
 * @param {ReadonlyArray<T>} array - The current items (not mutated)
 * @param {T} item - The item to toggle
 * @param {(item: T) => unknown} [keyFn] - Returns the identity key of an item (compared with SameValueZero)
 * @returns {T[]} A new array without the matching items, or with `item` appended when none matched
 * @throws {TypeError} when `keyFn` is given but is not a function
 * @example
 * toggle(['a', 'b'], 'b'); // => ['a']
 * toggle(['a', 'b'], 'c'); // => ['a', 'b', 'c']
 * toggle([{ id: 1 }, { id: 2 }], { id: 1 }, function (o) { return o.id; }); // => [{ id: 2 }]
 */
export function toggle<T>(array: ReadonlyArray<T>, item: T, keyFn?: (item: T) => unknown): T[] {
	if (keyFn !== undefined) assertFunction('toggle', 'keyFn', keyFn);
	const target = keyFn === undefined ? item : keyFn(item);
	const result: T[] = [];
	for (let i = 0; i < array.length; i++) {
		const value = array[i];
		if (!sameValueZero(keyFn === undefined ? value : keyFn(value), target)) result.push(value);
	}
	if (result.length === array.length) result.push(item);
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Normalize a value that may be a single item, an array of items, or nothing, into a fresh array (lodash's `castArray`):
 * - an array is COPIED (shallowly), so the result can be mutated without touching the input (lodash returns the same array);
 * - `null` and `undefined` mean "nothing" and give `[]` (lodash gives `[undefined]` for `castArray(undefined)` but `[]` for
 *   `castArray()`); to keep a nullish item, wrap it yourself: `[value]`;
 * - anything else, including strings, `Set`s and other iterables, is wrapped as ONE item (use `Array.from` to spread an iterable).
 * @template T
 * @param {T | ReadonlyArray<T> | null | undefined} value - An item, an array of items, or nothing
 * @returns {T[]} A new array
 * @example
 * toArray(1); // => [1]
 * toArray([1, 2]); // => [1, 2]
 * toArray(null); // => []
 * toArray('ab'); // => ['ab']
 */
export function toArray<T>(value: T | ReadonlyArray<T> | null | undefined): T[] {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? copyRange(value as ReadonlyArray<T>, 0, value.length) : [value as T];
}

/**
 * Build an object from a list of keys and a list of values: `{ [keys[i]]: values[i] }`, like `Object.fromEntries(zip(keys, values))`.
 * Keys are DEFINED as own data properties, never assigned: a `'__proto__'` key becomes an ordinary own property instead of
 * replacing the prototype (as it does in es-toolkit and radash), and no inherited setter or read-only property interferes.
 * The result is a plain object (`Object.prototype`). When a key repeats, the last value wins (its position stays the first one's).
 * @template K - The key type
 * @template V - The value type
 * @param {ReadonlyArray<K>} keys - The property keys (strings, numbers or symbols)
 * @param {ReadonlyArray<V>} values - The values, one per key
 * @returns {Record<K, V>} A new object
 * @throws {RangeError} when the arrays have different lengths (no key or value is silently dropped)
 * @example
 * zipObject(['a', 'b'], [1, 2]); // => { a: 1, b: 2 }
 * Object.keys(zipObject(['__proto__'], [1])); // => ['__proto__']
 * zipObject(['a', 'b'], [1]); // throws RangeError
 */
export function zipObject<const K extends PropertyKey, V>(keys: ReadonlyArray<K>, values: ReadonlyArray<V>): Record<K, V> {
	if (keys.length !== values.length) throw new RangeError(`zipObject: \`values\` must have as many items as \`keys\` (${keys.length}), got ${values.length}`);
	// Assigning to a null-prototype object is defining (nothing is inherited, not even the `__proto__` accessor), and is several
	// times faster than `Object.defineProperty`; the usual prototype is attached afterwards. For few keys (the usual case, e.g. a CSV
	// header), attaching it costs more than the keys themselves: they are assigned to a plain object as long as `Object.prototype`
	// holds none of them (`__proto__`, `toString`, a polluted setter or read-only property) and none is an object (whose conversion to a
	// property key could run code twice). The first such key moves the keys assigned so far to a null-prototype object. The value is read
	// before the check: a getter reading it must not plant a setter or read-only property between the check and the assignment.
	let plain = keys.length <= 16;
	let result = (plain ? {} : nullObject()) as Record<K, V>;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const value = values[i];
		if (plain && (typeof key === 'object' || typeof key === 'function' || key in Object.prototype)) {
			plain = false;
			result = Object.assign(nullObject(), result) as Record<K, V>;
		}
		result[key] = value;
	}
	return plain ? result : (Object.setPrototypeOf(result, Object.prototype) as Record<K, V>);
}

/**
 * Combine arrays element-wise with `fn`: `fn(a[i], b[i], ...)` for every index, truncating to the length of the SHORTEST array like
 * {@link zip} (lodash pads the shorter arrays with `undefined` instead, which `fn`'s parameter types would not reveal). The
 * arguments of `fn` are typed from the arrays, one per array.
 * @template T - The tuple of input array types
 * @template R - The result type of `fn`
 * @param {(...values: Zipped<T>) => R} fn - Combines the items at one index
 * @param {...ReadonlyArray<unknown>} arrays - The arrays to combine
 * @returns {R[]} A new array of `fn` results; empty when called without arrays
 * @throws {TypeError} when `fn` is not a function
 * @example
 * zipWith(function (a, b) { return a + b; }, [1, 2, 3], [10, 20]); // => [11, 22]
 * zipWith(function (name, age) { return `${name} (${age})`; }, ['al', 'bo'], [30, 25]); // => ['al (30)', 'bo (25)']
 */
export function zipWith<T extends Array<ReadonlyArray<unknown>>, R>(fn: (...values: Zipped<T>) => R, ...arrays: T): R[] {
	assertFunction('zipWith', 'fn', fn);
	const call = fn as (...values: unknown[]) => R;
	let length = arrays.length === 0 ? 0 : arrays[0].length;
	for (let k = 1; k < arrays.length; k++) length = Math.min(length, arrays[k].length);
	const result = new Array<R>(length);
	if (arrays.length === 2) {
		// Two arrays (the usual case) skip the argument list.
		const [left, right] = arrays;
		for (let i = 0; i < length; i++) result[i] = call(left[i], right[i]);
		return result;
	}
	const values = new Array<unknown>(arrays.length);
	for (let i = 0; i < length; i++) {
		for (let k = 0; k < arrays.length; k++) values[k] = arrays[k][i];
		result[i] = call(...values);
	}
	return result;
}

/**
 * Return `n` distinct random items of an array (sampling WITHOUT replacement: positions are distinct, so equal values may repeat only
 * if the input repeats them). The result is in random order: a uniformly random arrangement of a uniformly random subset, so
 * `sampleSize(array, array.length)` is a shuffle. When `n` exceeds the length, every item is returned (like {@link take}).
 * Partial Fisher–Yates, on a copy when `n` is a large part of the array, otherwise over a virtual copy (O(n) time and memory
 * whatever the array length); both make exactly `min(n, length)` calls to `random` and give the same result for the same draws.
 * Not cryptographically secure by default: pass `secureRandom` (random module) for raffles, lotteries, audits...
 * @template T
 * @param {ReadonlyArray<T>} array - The items to pick from (not mutated)
 * @param {number} n - How many items to pick (a non-negative integer)
 * @param {RandomGenerator} [random=Math.random] - Generator of floats in `[0, 1)`, injectable for deterministic results
 * @returns {T[]} A new array of `min(n, length)` items
 * @throws {RangeError} when `n` is not a non-negative integer, or `random()` returns a value outside `[0, 1)`
 * @throws {TypeError} when `n` is not a number or `random` is not a function
 * @example
 * sampleSize([1, 2, 3, 4, 5], 2); // e.g. [4, 1]
 * sampleSize([1, 2, 3], 3, function () { return 0; }); // => [1, 2, 3]
 * sampleSize([1, 2], 5).length; // => 2
 */
export function sampleSize<T>(array: ReadonlyArray<T>, n: number, random: RandomGenerator = Math.random): T[] {
	assertInteger('sampleSize', 'n', n, 0);
	assertFunction('sampleSize', 'random', random);
	const length = array.length;
	const count = Math.min(n, length);
	const result = new Array<T>(count);
	if (length <= 64 * count) {
		// The sample is a large part of the array: shuffling the front of a real copy is cheaper than tracking the swaps.
		const pool = copyRange(array, 0, length);
		for (let i = 0; i < count; i++) {
			const j = i + Math.floor(draw('sampleSize', random) * (length - i));
			result[i] = pool[j];
			pool[j] = pool[i];
		}
		return result;
	}
	// A few items of a long array: only the swaps of a virtual copy are recorded, as position -> index of the input item now there.
	const moved = new Map<number, number>();
	for (let i = 0; i < count; i++) {
		const j = i + Math.floor(draw('sampleSize', random) * (length - i));
		result[i] = array[moved.get(j) ?? j];
		moved.set(j, moved.get(i) ?? i);
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Return the mean of the numbers `selector` returns for each item, added up with compensated summation like {@link sumBy} (so
 * `0.1`, `0.2`, `0.3` average to exactly `0.2`). Each key is converted once with unary `+`; `NaN` keys propagate.
 * @template T
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => number} selector - Returns the number of an item
 * @returns {number} The mean, or `NaN` for an empty array (like `average` from the math module)
 * @throws {TypeError} when `selector` is not a function
 * @example
 * averageBy([{ n: 0.1 }, { n: 0.2 }, { n: 0.3 }], function (o) { return o.n; }); // => 0.2
 * averageBy([], function (n: number) { return n; }); // => NaN
 */
export function averageBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => number): number {
	assertFunction('averageBy', 'selector', selector);
	return scaledSum(array, selector, array.length);
}

/**
 * Return the median of the numbers `selector` returns for each item (the mean of the two middle values for an even count), with
 * the semantics of `median` from the math module: keys are converted once with unary `+`, and the result does not depend on the
 * item order.
 * @template T
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => number} selector - Returns the number of an item
 * @returns {number} The median, or `NaN` when the array is empty or a key is `NaN`
 * @throws {TypeError} when `selector` is not a function
 * @example
 * medianBy([{ age: 30 }, { age: 20 }, { age: 50 }], function (p) { return p.age; }); // => 30
 * medianBy([4, 1, 3, 2], function (n) { return n; }); // => 2.5
 */
export function medianBy<T>(array: ReadonlyArray<T>, selector: (item: T, index: number) => number): number {
	assertFunction('medianBy', 'selector', selector);
	const values = new Array<number>(array.length);
	for (let i = 0; i < array.length; i++) values[i] = selector(array[i], i);
	return median(values);
}

// ---------------------------------------------------------------------------------------------------------------------
// Combinatorics
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Throws when a combinatorial result would not fit in arrays: more than `2 ** 32 - 1` tuples, or items in all.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} count - The number of tuples
 * @param {number} items - The number of items in all the tuples
 * @returns {void}
 * @throws {RangeError} when either number exceeds `2 ** 32 - 1`
 */
function assertResultSize(caller: string, count: number, items: number): void {
	if (count > MAX_ARRAY_LENGTH || items > MAX_ARRAY_LENGTH) {
		throw new RangeError(`${caller}: the result would contain ${count} tuples holding ${items} items, more than 2 ** 32 - 1`);
	}
}

/**
 * Picks the items at the given positions.
 * @template T
 * @param {ReadonlyArray<T>} array - The items
 * @param {number[]} positions - The positions to pick
 * @returns {T[]} A new tuple
 */
function pick<T>(array: ReadonlyArray<T>, positions: number[]): T[] {
	const tuple = new Array<T>(positions.length);
	for (let i = 0; i < positions.length; i++) tuple[i] = array[positions[i]];
	return tuple;
}

/**
 * Return every combination of `k` items of an array (subsets of `k` POSITIONS, items in input order), in lexicographic order of
 * positions, like Python's `itertools.combinations`. There are `C(length, k)` of them: `[[]]` for `k = 0`, `[]` when `k > length`.
 * Positions are distinct, not values: duplicate inputs give duplicate-looking combinations (deduplicate the input first if needed).
 * The size is checked before anything is allocated: more than `2 ** 32 - 1` tuples or items in all throws, and since a result
 * that does not fit in memory aborts the process instead of throwing, callers must still bound untrusted sizes.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to choose from
 * @param {number} k - The size of each combination (a non-negative integer)
 * @returns {T[][]} A new array of fresh tuples
 * @throws {TypeError} when `k` is not a number
 * @throws {RangeError} when `k` is not a non-negative integer, or the result would exceed `2 ** 32 - 1` tuples or items
 * @example
 * combinations(['a', 'b', 'c'], 2); // => [['a', 'b'], ['a', 'c'], ['b', 'c']]
 * combinations([1, 2], 3); // => []
 */
export function combinations<T>(array: ReadonlyArray<T>, k: number): T[][] {
	assertInteger('combinations', 'k', k, 0);
	const length = array.length;
	if (k > length) return [];
	// C(length, k) = C(length, length - k), computed incrementally (each step is an exact integer) and stopped as soon as it is too
	// large. Counting up to the smaller of the two never passes the peak C(length, length / 2), which can be too large on its own.
	const smaller = Math.min(k, length - k);
	let count = 1;
	for (let i = 0; i < smaller && count <= MAX_ARRAY_LENGTH; i++) count = (count * (length - i)) / (i + 1);
	assertResultSize('combinations', count, count * k);
	const result: T[][] = [];
	// Filled with `push`, so that V8 keeps the array packed (`range` returns a holey one, which is slower to read).
	const positions: number[] = [];
	for (let i = 0; i < k; i++) positions.push(i);
	for (;;) {
		result.push(pick(array, positions));
		// Advance the rightmost position that can still move, then reset the following ones right after it.
		let i = k - 1;
		while (i >= 0 && positions[i] === length - k + i) i--;
		if (i < 0) return result;
		positions[i]++;
		for (let j = i + 1; j < k; j++) positions[j] = positions[j - 1] + 1;
	}
}

/**
 * Return every arrangement of `k` items of an array (ordered selections of `k` distinct POSITIONS), in lexicographic order of
 * positions, like Python's `itertools.permutations`. There are `length! / (length - k)!` of them: `[[]]` for `k = 0`, `[]` when
 * `k > length`. Positions are distinct, not values: duplicate inputs give duplicate-looking permutations.
 * The size is checked before anything is allocated: more than `2 ** 32 - 1` tuples or items in all throws, and since a result
 * that does not fit in memory aborts the process instead of throwing, callers must still bound untrusted sizes.
 * @template T
 * @param {ReadonlyArray<T>} array - The items to arrange
 * @param {number} [k=array.length] - The size of each permutation (a non-negative integer)
 * @returns {T[][]} A new array of fresh tuples
 * @throws {TypeError} when `k` is not a number
 * @throws {RangeError} when `k` is not a non-negative integer, or the result would exceed `2 ** 32 - 1` tuples or items
 * @example
 * permutations([1, 2, 3]); // => [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]
 * permutations(['a', 'b', 'c'], 2); // => [['a', 'b'], ['a', 'c'], ['b', 'a'], ['b', 'c'], ['c', 'a'], ['c', 'b']]
 */
export function permutations<T>(array: ReadonlyArray<T>, k = array.length): T[][] {
	assertInteger('permutations', 'k', k, 0);
	const length = array.length;
	if (k > length) return [];
	let count = 1;
	for (let i = 0; i < k && count <= MAX_ARRAY_LENGTH; i++) count *= length - i;
	assertResultSize('permutations', count, count * k);
	const result: T[][] = [];
	// Depth-first search over the positions: `positions` is the current prefix, `next` the first position to try after it.
	const positions: number[] = [];
	const used = new Array<boolean>(length).fill(false);
	let next = 0;
	for (;;) {
		if (positions.length === k) {
			result.push(pick(array, positions));
			next = length;
		}
		while (next < length && used[next]) next++;
		if (next < length) {
			used[next] = true;
			positions.push(next);
			next = 0;
		} else {
			if (positions.length === 0) return result;
			const position = positions.pop() as number;
			used[position] = false;
			next = position + 1;
		}
	}
}

/**
 * Return every subset of an array (`2 ** length` of them, items in input order), in binary-counting order: item `i` is in subset
 * `m` when bit `i` of `m` is set, so `[]` comes first and the whole array last. Positions are distinct, not values.
 * The size is checked before anything is allocated (more than `2 ** 32 - 1` subsets or items in all throws, i.e. inputs longer
 * than 28 items); since a result that does not fit in memory aborts the process instead of throwing, keep inputs short.
 * @template T
 * @param {ReadonlyArray<T>} array - The items
 * @returns {T[][]} A new array of fresh subsets
 * @throws {RangeError} when the result would exceed `2 ** 32 - 1` subsets or items
 * @example
 * powerSet(['a', 'b', 'c']); // => [[], ['a'], ['b'], ['a', 'b'], ['c'], ['a', 'c'], ['b', 'c'], ['a', 'b', 'c']]
 */
export function powerSet<T>(array: ReadonlyArray<T>): T[][] {
	const length = array.length;
	// Every item is in half of the subsets.
	assertResultSize('powerSet', 2 ** length, length * 2 ** (length - 1));
	const result: T[][] = [[]];
	for (let i = 0; i < length; i++) {
		const size = result.length;
		for (let j = 0; j < size; j++) {
			const subset = result[j].slice();
			subset.push(array[i]);
			result.push(subset);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Create a {@link Comparator} for `Array.prototype.sort` / `toSorted` (or {@link sortedIndex}, {@link binarySearch}...) that orders
 * items by the key `selector` returns, with exactly the ordering rules of {@link sortBy} and {@link orderBy}: numbers and bigints
 * numerically and before strings, strings by UTF-16 code units, `Date`s by timestamp, and `NaN`, invalid `Date`s, `null` and
 * `undefined` keys after every other key in BOTH directions (equal to each other). The order is total, so the comparator is
 * consistent and `sort` is deterministic.
 *
 * The selector is called twice per comparison: when it is expensive, prefer {@link sortBy}, which calls it once per item.
 * Combine several keys with {@link combineComparators}. (`sort` itself moves `undefined` ITEMS to the end without calling the comparator.)
 * @template T
 * @param {(item: T) => SortKey | null | undefined} selector - Returns the sort key of an item
 * @param {SortOrder} [order='asc'] - `'asc'` for ascending or `'desc'` for descending keys
 * @returns {Comparator<T>} A comparator returning `-1`, `0` or `1`
 * @throws {TypeError} when `selector` is not a function
 * @throws {RangeError} when `order` is neither `'asc'` nor `'desc'`
 * @example
 * [{ n: 2 }, { n: 1 }, {}].sort(compareBy(function (o: { n?: number }) { return o.n; })); // => [{ n: 1 }, { n: 2 }, {}]
 * [1, NaN, 3].sort(compareBy(function (n) { return n; }, 'desc')); // => [3, 1, NaN]
 */
export function compareBy<T>(selector: (item: T) => SortKey | null | undefined, order: SortOrder = 'asc'): Comparator<T> {
	assertFunction('compareBy', 'selector', selector);
	const direction = toDirection('compareBy', 'order', order);
	return function (a: T, b: T): number {
		return compareRanked(rank(selector(a)), rank(selector(b)), direction);
	};
}

/**
 * Combine comparators into one that compares by the first, then breaks ties with the second, and so on: the first non-zero result
 * wins (a `NaN` result counts as a tie, as `Array.prototype.sort` treats it). Without comparators, every pair is a tie.
 * @template T
 * @param {...Comparator<T>} comparators - The comparators, most significant first
 * @returns {Comparator<T>} The combined comparator
 * @throws {TypeError} when one of `comparators` is not a function
 * @example
 * type Person = { name: string; age: number };
 * const people: Person[] = [{ name: 'bo', age: 30 }, { name: 'al', age: 30 }, { name: 'cy', age: 25 }];
 * people.sort(combineComparators(compareBy(function (p: Person) { return p.age; }, 'desc'), compareBy(function (p: Person) { return p.name; }))); // => [{ name: 'al', age: 30 }, { name: 'bo', age: 30 }, { name: 'cy', age: 25 }]
 */
export function combineComparators<T>(...comparators: Array<Comparator<T>>): Comparator<T> {
	// The parameter names are only formatted on failure.
	for (let i = 0; i < comparators.length; i++) if (typeof comparators[i] !== 'function') assertFunction('combineComparators', `comparators[${i}]`, comparators[i]);
	// `comparators` is a fresh rest array: no one else can change it.
	return function (a: T, b: T): number {
		for (let i = 0; i < comparators.length; i++) {
			const comparison = comparators[i](a, b);
			if (comparison) return comparison;
		}
		return 0;
	};
}

/**
 * Reverse a comparator: the result orders items the opposite way (`reverseComparator(c)(a, b)` is `c(b, a)`).
 * Note that reversing a {@link compareBy} comparator also moves its missing keys (`NaN`, `null`...) FIRST: pass `'desc'` to
 * `compareBy` instead to keep them last.
 * @template T
 * @param {Comparator<T>} compare - The comparator to reverse
 * @returns {Comparator<T>} The reversed comparator
 * @throws {TypeError} when `compare` is not a function
 * @example
 * [1, 3, 2].sort(reverseComparator(function (a: number, b: number) { return a - b; })); // => [3, 2, 1]
 */
export function reverseComparator<T>(compare: Comparator<T>): Comparator<T> {
	assertFunction('reverseComparator', 'compare', compare);
	return function (a: T, b: T): number {
		return compare(b, a);
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A node built by {@link toTree}: a shallow copy of an item (without any previous `C` property) with its children under `C`. The copy
 * is a plain object holding the item's own enumerable properties (as `{ ...item }` does): the methods and accessors of a class instance
 * are not copied, although this type (which cannot tell own properties from inherited ones) still lists them.
 * @template T - The item type
 * @template C - The name of the children property
 */
export type TreeNode<T, C extends string = 'children'> = Omit<T, C> & { [K in C]: Array<TreeNode<T, C>> };

/**
 * Options accepted by {@link toTree}.
 * @template T - The item type
 * @template C - The name of the children property
 */
export interface ToTreeOptions<T, C extends string = 'children'> {
	/**
	 * The id of an item: a property name, or a function returning it. Ids are compared with SameValueZero and must be unique.
	 * @default 'id'
	 */
	id?: keyof T | ((item: T) => unknown);
	/**
	 * The id of an item's parent: a property name, or a function returning it. `null` or `undefined` makes the item a root.
	 * @default 'parentId'
	 */
	parentId?: keyof T | ((item: T) => unknown);
	/**
	 * The property the children of each node are stored under (any string but `'__proto__'`).
	 * @default 'children'
	 */
	childrenKey?: C;
	/**
	 * What to do with an item whose parent id matches no item: make it a root (`'root'`, so a filtered list still shows every
	 * match), leave it out with its descendants (`'drop'`), or throw a `RangeError` (`'throw'`).
	 * @default 'root'
	 */
	orphans?: 'root' | 'drop' | 'throw';
}

/**
 * Validates the property name a tree helper stores or reads children under.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} key - The `childrenKey` option
 * @returns {void}
 * @throws {TypeError} when `key` is not a string
 * @throws {RangeError} when `key` is `'__proto__'`
 */
function assertChildrenKey(caller: string, key: unknown): asserts key is string {
	if (typeof key !== 'string') throw new TypeError(`${caller}: \`options.childrenKey\` must be a string, got ${describe(key)}`);
	if (key === '__proto__') throw new RangeError(`${caller}: \`options.childrenKey\` must not be '__proto__', got __proto__`);
}

/**
 * Turns the `id` or `parentId` option of {@link toTree} into a function reading the key of an item.
 * @template T
 * @param {string} name - The option name
 * @param {unknown} key - A property name or a function
 * @returns {(item: T) => unknown} The key reader
 * @throws {TypeError} when `key` is neither a property key nor a function
 * @throws {RangeError} when `key` is `'__proto__'`
 */
function keyReader<T extends object>(name: string, key: unknown): (item: T) => unknown {
	if (typeof key === 'function') return key as (item: T) => unknown;
	if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'symbol') {
		throw new TypeError(`toTree: \`options.${name}\` must be a property key or a function, got ${describe(key)}`);
	}
	if (key === '__proto__') throw new RangeError(`toTree: \`options.${name}\` must not be '__proto__', got __proto__`);
	return function (item: T): unknown {
		// Not inherited from a polluted `Object.prototype`.
		return readOption(item, key as keyof T & string);
	};
}

/**
 * Build a forest from a flat list of items that reference their parent by id (an adjacency list, as rows of a database table or
 * a CMS export): each item becomes a node, a SHALLOW COPY of the item with the array of its children added under `childrenKey`
 * (the items themselves are never mutated). A node is a plain object with the item's own enumerable properties, like `{ ...item }`:
 * class instances lose their methods and accessors (see {@link TreeNode}). Roots are the items whose parent id is `null` or `undefined`; children and roots keep
 * the order of the input. An item whose parent id matches no item is an orphan: by default it becomes a root (see
 * {@link ToTreeOptions.orphans}). O(n) time and memory, whatever the order of the items and the depth of the tree.
 *
 * Ids are read with `id` and `parentId` (property names or functions; own and class properties are read, values inherited from a
 * polluted `Object.prototype` are not), compared with SameValueZero (`1` and `'1'` differ). Use {@link flattenTree} for the inverse.
 * @template T - The item type
 * @template C - The name of the children property
 * @param {ReadonlyArray<T>} items - The items, in any order (not mutated)
 * @param {ToTreeOptions<T, C>} [options={}] - `id` (default `'id'`), `parentId` (default `'parentId'`), `childrenKey` (default
 * `'children'`) and `orphans` (default `'root'`)
 * @returns {Array<TreeNode<T, C>>} The root nodes
 * @throws {TypeError} when `id` or `parentId` is neither a property key nor a function, or `childrenKey` is not a string
 * @throws {RangeError} when two items have the same id, the parent references form a cycle (an item is its own ancestor), an orphan
 * is found with `orphans: 'throw'`, or an option has an invalid value
 * @example
 * const rows = [{ id: 2, parentId: 1, name: 'b' }, { id: 1, parentId: null, name: 'a' }, { id: 3, parentId: 1, name: 'c' }];
 * toTree(rows); // => [{ id: 1, parentId: null, name: 'a', children: [{ id: 2, parentId: 1, name: 'b', children: [] }, { id: 3, parentId: 1, name: 'c', children: [] }] }]
 * @example
 * const paths = [{ path: 'a' }, { path: 'a/b' }];
 * toTree(paths, { id: 'path', parentId: function (p) { return p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : null; }, childrenKey: 'items' }); // => [{ path: 'a', items: [{ path: 'a/b', items: [] }] }]
 * @example
 * toTree([{ id: 1, parentId: 2 }, { id: 2, parentId: 1 }]); // throws RangeError
 */
export function toTree<T extends object, C extends string = 'children'>(items: ReadonlyArray<T>, options: ToTreeOptions<T, C> = {}): Array<TreeNode<T, C>> {
	const getId = keyReader<T>('id', readOption(options, 'id', 'id'));
	const getParentId = keyReader<T>('parentId', readOption(options, 'parentId', 'parentId'));
	const childrenKey = readOption(options, 'childrenKey', 'children');
	assertChildrenKey('toTree', childrenKey);
	const orphans = readOption(options, 'orphans', 'root');
	if (orphans !== 'root' && orphans !== 'drop' && orphans !== 'throw') {
		throw new RangeError(`toTree: \`options.orphans\` must be 'root', 'drop' or 'throw', got ${show(orphans)}`);
	}
	const length = items.length;
	const indices = new Map<unknown, number>();
	const nodes: Array<TreeNode<T, C>> = [];
	const children: Array<Array<TreeNode<T, C>>> = [];
	for (let i = 0; i < length; i++) {
		const id = getId(items[i]);
		if (indices.has(id)) throw new RangeError(`toTree: ids must be unique, got ${show(id)} twice`);
		indices.set(id, i);
		children.push([]);
		// A computed key in a literal is defined, never assigned: no setter or `__proto__` accessor can be triggered.
		nodes.push({ ...items[i], [childrenKey]: children[i] } as TreeNode<T, C>);
	}
	// The index of each item's parent; -1 for a root, -2 for an orphan left out.
	const parents: number[] = [];
	const roots: Array<TreeNode<T, C>> = [];
	for (let i = 0; i < length; i++) {
		const parentId = getParentId(items[i]);
		const parent = parentId === null || parentId === undefined ? -1 : (indices.get(parentId) ?? (orphans === 'root' ? -1 : -2));
		if (parent === -2 && orphans === 'throw') {
			throw new RangeError(`toTree: the parent of \`items[${i}]\` must be one of the items, got parent id ${show(parentId)}`);
		}
		parents.push(parent);
		if (parent >= 0) children[parent].push(nodes[i]);
		else if (parent === -1) roots.push(nodes[i]);
	}
	// Cycle detection: walk up from every item, stamping the items met with the walk's number. Every item is stamped once, so this is
	// O(n); meeting an item stamped by the same walk means the walk went round a cycle.
	const stamps = new Array<number>(length).fill(0);
	for (let i = 0; i < length; i++) {
		let j = i;
		while (j >= 0 && stamps[j] === 0) {
			stamps[j] = i + 1;
			j = parents[j];
		}
		if (j >= 0 && stamps[j] === i + 1) throw new RangeError(`toTree: the parent ids must not form a cycle, got one through id ${show(getId(items[j]))}`);
	}
	return roots;
}

/**
 * Options accepted by {@link flattenTree}.
 */
export interface FlattenTreeOptions {
	/**
	 * The property holding the children of a node (an array; a missing, `null` or `undefined` value means no children).
	 * @default 'children'
	 */
	childrenKey?: string;
	/**
	 * `'depth-first'` lists every node before its descendants and after its previous siblings' subtrees (pre-order);
	 * `'breadth-first'` lists the nodes level by level.
	 * @default 'depth-first'
	 */
	order?: 'depth-first' | 'breadth-first';
}

/**
 * List every node of a forest (an array of root nodes, each holding its children under `childrenKey`), the inverse of
 * {@link toTree}: `toTree(flattenTree(forest))` rebuilds the forest. The nodes themselves are returned (not copies; they still hold
 * their children). The walk is iterative, so trees of any depth are flattened without overflowing the call stack, in O(n) time.
 * A node may appear in several places (it is listed each time), but not inside its own subtree.
 * @template N - The node type
 * @param {ReadonlyArray<N>} roots - The root nodes
 * @param {FlattenTreeOptions} [options={}] - `childrenKey` (default `'children'`) and `order` (default `'depth-first'`)
 * @returns {N[]} A new array of the nodes
 * @throws {TypeError} when a node's children are neither an array nor nullish, a node is its own descendant, or `childrenKey` is not a string
 * @throws {RangeError} when `order` is invalid or `childrenKey` is `'__proto__'`
 * @example
 * type Node = { id: number; children?: Node[] };
 * const tree: Node[] = [{ id: 1, children: [{ id: 2, children: [{ id: 4 }] }, { id: 3 }] }];
 * flattenTree(tree).map(function (node) { return node.id; }); // => [1, 2, 4, 3]
 * flattenTree(tree, { order: 'breadth-first' }).map(function (node) { return node.id; }); // => [1, 2, 3, 4]
 */
export function flattenTree<N extends object>(roots: ReadonlyArray<N>, options: FlattenTreeOptions = {}): N[] {
	const childrenKey = readOption(options, 'childrenKey', 'children');
	assertChildrenKey('flattenTree', childrenKey);
	const order = readOption(options, 'order', 'depth-first');
	if (order !== 'depth-first' && order !== 'breadth-first') {
		throw new RangeError(`flattenTree: \`options.order\` must be 'depth-first' or 'breadth-first', got ${show(order)}`);
	}
	const result: N[] = [];
	// Breadth-first order is the depth-first order stably grouped by depth (both order the nodes of a level by their path).
	const levels: N[][] = [];
	// The nodes whose children are being listed, the lists holding them, and the index to resume at in each list.
	const ancestors = new Set<N>();
	const lists: Array<ReadonlyArray<N>> = [];
	const positions: number[] = [];
	let list = roots;
	let index = 0;
	for (;;) {
		if (index === list.length) {
			if (lists.length === 0) return order === 'depth-first' ? result : levels.flat();
			list = lists.pop() as ReadonlyArray<N>;
			index = positions.pop() as number;
			// The ancestor whose children were just listed is the item before the resume position.
			ancestors.delete(list[index - 1]);
			continue;
		}
		const node = list[index++];
		if (order === 'depth-first') result.push(node);
		else {
			// A level is reached from the one above it, so it is created right after it: `levels` has no holes, whose reads would fall
			// through to a polluted `Object.prototype[depth]`.
			if (lists.length === levels.length) levels.push([]);
			levels[lists.length].push(node);
		}
		const nodeChildren: unknown = readOption(node, childrenKey as keyof N & string);
		if (nodeChildren === null || nodeChildren === undefined) continue;
		if (!Array.isArray(nodeChildren)) throw new TypeError(`flattenTree: \`${childrenKey}\` must be an array, got ${describe(nodeChildren)}`);
		if (nodeChildren.length === 0) continue;
		if (ancestors.has(node)) throw new TypeError('flattenTree: cannot flatten a circular tree');
		ancestors.add(node);
		lists.push(list);
		positions.push(index);
		list = nodeChildren as ReadonlyArray<N>;
		index = 0;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Updating, selecting and paging
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Return a copy of an array where the FIRST item matching `item` is replaced by `item`, or with `item` appended when none matches:
 * the "insert or update" of a list held in state (save a record, merge a server response). Matching is decided like {@link toggle}:
 * by SameValueZero, or by comparing the keys `keyFn` returns. Later matches, if any, are kept.
 * @template T
 * @param {ReadonlyArray<T>} array - The current items (not mutated)
 * @param {T} item - The item to insert or put in place of its match
 * @param {(item: T) => unknown} [keyFn] - Returns the identity key of an item (compared with SameValueZero)
 * @returns {T[]} A new array of the same length (when an item matched) or one longer
 * @throws {TypeError} when `keyFn` is given but is not a function
 * @example
 * const users = [{ id: 1, name: 'Al' }, { id: 2, name: 'Bo' }];
 * upsert(users, { id: 2, name: 'Bob' }, function (u) { return u.id; }); // => [{ id: 1, name: 'Al' }, { id: 2, name: 'Bob' }]
 * upsert(users, { id: 3, name: 'Cy' }, function (u) { return u.id; }); // => [{ id: 1, name: 'Al' }, { id: 2, name: 'Bo' }, { id: 3, name: 'Cy' }]
 * upsert(['a', 'b'], 'b'); // => ['a', 'b']
 */
export function upsert<T>(array: ReadonlyArray<T>, item: T, keyFn?: (item: T) => unknown): T[] {
	if (keyFn !== undefined) assertFunction('upsert', 'keyFn', keyFn);
	const target = keyFn === undefined ? item : keyFn(item);
	const result = Array.from(array);
	for (let i = 0; i < result.length; i++) {
		if (sameValueZero(keyFn === undefined ? result[i] : keyFn(result[i]), target)) {
			result[i] = item;
			return result;
		}
	}
	result.push(item);
	return result;
}

/**
 * Map an array and drop the `null` and `undefined` results, in one pass (Kotlin's `mapNotNull`, Swift's `compactMap`): return
 * `undefined` (or nothing, or `null`) from `fn` to skip an item. Other falsy results (`0`, `''`, `false`, `NaN`) are kept.
 * @template T
 * @template R
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => R} fn - Maps an item, or returns `null`/`undefined` to skip it
 * @returns {Array<NonNullable<R>>} A new array of the non-nullish results, in input order
 * @throws {TypeError} when `fn` is not a function
 * @example
 * filterMap(['1', 'x', '3'], function (s) { const n = Number(s); return Number.isNaN(n) ? undefined : n * 10; }); // => [10, 30]
 * filterMap(['a=1', 'b', 'c=0'], function (s) { return /=(\d)$/.exec(s)?.[1]; }); // => ['1', '0']
 */
export function filterMap<T, R>(array: ReadonlyArray<T>, fn: (item: T, index: number) => R): Array<NonNullable<R>> {
	assertFunction('filterMap', 'fn', fn);
	const result: Array<NonNullable<R>> = [];
	for (let i = 0; i < array.length; i++) {
		const value = fn(array[i], i);
		if (value !== null && value !== undefined) result.push(value);
	}
	return result;
}

/**
 * Return the items that occur more than once (by SameValueZero, or by the key `keyFn` returns), each reported ONCE: the first item
 * with each repeated key, in order of first occurrence. So `duplicates(array)` is always a subsequence of {@link unique}`(array)`,
 * and it is empty exactly when every item (key) is distinct.
 * @template T
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => unknown} [keyFn] - Returns the identity key of an item (called once per item)
 * @returns {T[]} A new array with the first item of every repeated key
 * @throws {TypeError} when `keyFn` is given but is not a function
 * @example
 * duplicates([3, 1, 3, 2, 1, 3]); // => [3, 1]
 * duplicates([{ email: 'a@x.io' }, { email: 'b@x.io' }, { email: 'A@x.io' }], function (u) { return u.email.toLowerCase(); }); // => [{ email: 'a@x.io' }]
 */
export function duplicates<T>(array: ReadonlyArray<T>, keyFn?: (item: T, index: number) => unknown): T[] {
	if (keyFn !== undefined) assertFunction('duplicates', 'keyFn', keyFn);
	// Each key's first index, stored as `-1 - index` once the key repeats; a Map iterates in insertion (first occurrence) order.
	const firsts = new Map<unknown, number>();
	for (let i = 0; i < array.length; i++) {
		const key = keyFn === undefined ? array[i] : keyFn(array[i], i);
		const seen = firsts.get(key);
		if (seen === undefined) firsts.set(key, i);
		else if (seen >= 0) firsts.set(key, -1 - seen);
	}
	const result: T[] = [];
	for (const index of firsts.values()) if (index < 0) result.push(array[-1 - index]);
	return result;
}

/**
 * Build an object from the `[key, value]` pairs `fn` returns for each item (remeda's `mapToObj`, radash's `objectify`, Kotlin's
 * `associate`); when several items give the same key, the last one wins. Like {@link keyBy}, the result is a null-prototype object,
 * so keys such as `'__proto__'` or `'constructor'` are stored safely (no prototype pollution), but it has no `Object.prototype` methods.
 * @template T
 * @template K
 * @template V
 * @param {ReadonlyArray<T>} array - The items
 * @param {(item: T, index: number) => readonly [K, V]} fn - Returns the key and the value of an item
 * @returns {Partial<Record<K, V>>} An object mapping each key to the last value given for it
 * @throws {TypeError} when `fn` is not a function or returns something other than an array
 * @example
 * associate([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], function (o) { return [o.id, o.n]; }); // => { a: 1, b: 2 }
 * associate(['x', 'yy'], function (s, i) { return [s, i]; }); // => { x: 0, yy: 1 }
 */
export function associate<T, K extends PropertyKey, V>(array: ReadonlyArray<T>, fn: (item: T, index: number) => readonly [K, V]): Partial<Record<K, V>> {
	assertFunction('associate', 'fn', fn);
	const result = nullObject() as Partial<Record<K, V>>;
	for (let i = 0; i < array.length; i++) {
		const entry = fn(array[i], i);
		if (!Array.isArray(entry)) throw new TypeError(`associate: \`fn\` must return a [key, value] pair, got ${describe(entry)}`);
		result[entry[0]] = entry[1];
	}
	return result;
}

/**
 * One page of items, as returned by {@link paginate}.
 * @template T - The item type
 */
export interface Page<T> {
	/** The items of the page (empty when the page is past the last one). */
	items: T[];
	/** The page number, 1-based, as requested. */
	page: number;
	/** The maximum number of items per page, as requested. */
	pageSize: number;
	/** The number of non-empty pages (`0` for no items). */
	pageCount: number;
	/** The number of items in all pages. */
	total: number;
	/** Whether `page` is past the first page. */
	hasPrevious: boolean;
	/** Whether a non-empty page follows `page`. */
	hasNext: boolean;
}

/**
 * Return one page of an array with the metadata a pager needs. Pages are 1-based. A page past the last one is NOT clamped: it has
 * no items (like an `OFFSET` past the end of a table), and `page` is reported as requested, so a stale page number shows up as an
 * empty page instead of silently showing another one; clamp it yourself with `Math.min(page, Math.max(pageCount, 1))` if you prefer.
 * @template T
 * @param {ReadonlyArray<T>} array - All the items
 * @param {number} page - The page number (an integer >= 1)
 * @param {number} pageSize - The maximum number of items per page (an integer >= 1)
 * @returns {Page<T>} `{ items, page, pageSize, pageCount, total, hasPrevious, hasNext }`
 * @throws {TypeError} when `page` or `pageSize` is not a number
 * @throws {RangeError} when `page` or `pageSize` is not an integer >= 1
 * @example
 * paginate(['a', 'b', 'c', 'd', 'e'], 2, 2); // => { items: ['c', 'd'], page: 2, pageSize: 2, pageCount: 3, total: 5, hasPrevious: true, hasNext: true }
 * paginate(['a', 'b', 'c'], 5, 2).items; // => []
 */
export function paginate<T>(array: ReadonlyArray<T>, page: number, pageSize: number): Page<T> {
	assertInteger('paginate', 'page', page, 1);
	assertInteger('paginate', 'pageSize', pageSize, 1);
	const total = array.length;
	const pageCount = Math.ceil(total / pageSize);
	const start = Math.min((page - 1) * pageSize, total);
	return {
		items: copyRange(array, start, Math.min(start + pageSize, total)),
		page,
		pageSize,
		pageCount,
		total,
		hasPrevious: page > 1,
		hasNext: page < pageCount
	};
}

/**
 * Split an array in two at `index`: the items before it, and the items from it on. A negative index counts from the end, like
 * `Array.prototype.slice`, and an index out of range is clamped (`splitAt(array, 99)` gives `[copy, []]`).
 * @template T
 * @param {ReadonlyArray<T>} array - The source array
 * @param {number} index - Where the second part starts (an integer; negative counts from the end)
 * @returns {[T[], T[]]} `[before, after]`, two new arrays
 * @throws {TypeError} when `index` is not a number
 * @throws {RangeError} when `index` is not an integer
 * @example
 * splitAt([1, 2, 3, 4], 1); // => [[1], [2, 3, 4]]
 * splitAt([1, 2, 3, 4], -1); // => [[1, 2, 3], [4]]
 * splitAt([1, 2], 5); // => [[1, 2], []]
 */
export function splitAt<T>(array: ReadonlyArray<T>, index: number): [T[], T[]] {
	assertNumber('splitAt', 'index', index, Number.isInteger(index), 'an integer');
	const length = array.length;
	const at = index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
	return [copyRange(array, 0, at), copyRange(array, at, length)];
}
