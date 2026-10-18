import * as helpers from '.';

/**
 * Generator that yields the given values once (a one-shot iterable).
 */
function* once<T>(...values: T[]): Generator<T> {
	yield* values;
}

/**
 * Deterministic random generator cycling through the given values.
 */
function sequence(...values: number[]): () => number {
	let i = 0;
	return function () {
		const value = values[i % values.length];
		i++;
		return value;
	};
}

/**
 * Reference O(n·m) dynamic-programming LCS length.
 */
function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
	let previous = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		const current = [0];
		b.forEach(function (y, j) {
			current.push(Object.is(x, y) || x === y ? previous[j] + 1 : Math.max(previous[j + 1], current[j]));
		});
		previous = current;
	}
	return previous[b.length];
}

/**
 * Checks that an edit script rebuilds both sequences and has the minimal number of edits.
 */
function expectValidMinimalScript<T>(a: readonly T[], b: readonly T[], script: Array<helpers.DiffOperation<T>>): void {
	const rebuiltA: T[] = [];
	const rebuiltB: T[] = [];
	for (const operation of script) {
		if (operation.type !== 'insert') rebuiltA.push(a[operation.indexA]);
		if (operation.type !== 'delete') rebuiltB.push(b[operation.indexB]);
	}
	expect(rebuiltA).toStrictEqual(a);
	expect(rebuiltB).toStrictEqual(b);
	const edits = script.filter(function (operation) {
		return operation.type !== 'equal';
	}).length;
	expect(edits).toBe(a.length + b.length - 2 * lcsLength(a, b));
}

describe('Arrays helpers', function () {
	describe('contains', function () {
		it('should return true if the value is in the array', function () {
			expect(helpers.contains([1, 2, 3], 2)).toBe(true);
		});

		it('should return false if the value is not in the array', function () {
			expect(helpers.contains([1, 2, 3], 4)).toBe(false);
			expect(helpers.contains([], 4)).toBe(false);
		});

		it('should find NaN and treat -0 as 0 (SameValueZero)', function () {
			expect(helpers.contains([1, NaN], NaN)).toBe(true);
			expect(helpers.contains([-0], 0)).toBe(true);
		});

		it('should use reference equality for objects and accept readonly arrays', function () {
			const obj = { a: 1 };
			const array: ReadonlyArray<{ a: number }> = [obj];
			expect(helpers.contains(array, obj)).toBe(true);
			expect(helpers.contains(array, { a: 1 })).toBe(false);
		});
	});

	describe('first', function () {
		it('should return the first item in the array', function () {
			expect(helpers.first([1, 2, 3])).toBe(1);
		});

		it('should return undefined for an empty array', function () {
			const result: number | undefined = helpers.first<number>([]);
			expect(result).toBeUndefined();
		});
	});

	describe('last', function () {
		it('should return the last item in the array', function () {
			expect(helpers.last([1, 2, 3])).toBe(3);
		});

		it('should return undefined for an empty array', function () {
			const result: string | undefined = helpers.last<string>([]);
			expect(result).toBeUndefined();
		});
	});

	describe('flatten', function () {
		it('should flatten a nested array into a single-dimensional array', function () {
			const array = [
				[1, 2],
				[3, 4]
			];
			expect(helpers.flatten(array)).toStrictEqual([1, 2, 3, 4]);
		});

		it('should handle mixed items and flatten exactly one level', function () {
			expect(helpers.flatten<number | number[]>([1, [2, [3]], 4])).toStrictEqual([1, 2, [3], 4]);
			const typed: number[] = helpers.flatten([1, [2, 3]]);
			expect(typed).toStrictEqual([1, 2, 3]);
		});

		it('should return an empty array for empty inputs', function () {
			expect(helpers.flatten([])).toStrictEqual([]);
			expect(helpers.flatten([[], []])).toStrictEqual([]);
		});

		it('should skip holes like Array.prototype.flat', function () {
			const inner = new Array<number>(3);
			inner[1] = 2;
			const outer = new Array<number | number[]>(3);
			outer[0] = 1;
			outer[2] = inner;
			expect(helpers.flatten(outer)).toStrictEqual([1, 2]);
			expect(helpers.flatten(outer)).toStrictEqual(outer.flat());
		});

		it('should not mutate the input', function () {
			const array = [[1], [2]];
			helpers.flatten(array);
			expect(array).toStrictEqual([[1], [2]]);
		});
	});

	describe('flattenDeep', function () {
		it('should flatten arbitrarily nested arrays', function () {
			const result: number[] = helpers.flattenDeep([1, [2, [3, [4, [5]]]], 6]);
			expect(result).toStrictEqual([1, 2, 3, 4, 5, 6]);
		});

		it('should handle empty arrays at any level', function () {
			expect(helpers.flattenDeep([])).toStrictEqual([]);
			expect(helpers.flattenDeep([[], [[]], [[[]]]])).toStrictEqual([]);
		});

		it('should keep non-array values, including strings and objects, intact', function () {
			const obj = { a: [1] };
			expect(helpers.flattenDeep(['ab', [obj, ['c']]])).toStrictEqual(['ab', obj, 'c']);
		});

		it('should not overflow the stack on deep nesting', function () {
			let nested: unknown[] = [42];
			for (let i = 0; i < 100_000; i++) nested = [nested];
			expect(helpers.flattenDeep(nested)).toStrictEqual([42]);
		});

		it('should allow the same array to appear several times when not circular', function () {
			const shared = [1, 2];
			expect(helpers.flattenDeep([shared, [shared]])).toStrictEqual([1, 2, 1, 2]);
		});

		it('should skip holes', function () {
			const sparse = new Array<number>(2);
			sparse[1] = 7;
			expect(helpers.flattenDeep([sparse, [sparse]])).toStrictEqual([7, 7]);
		});

		it('should throw a TypeError on circular arrays', function () {
			const circular: unknown[] = [1];
			circular.push([2, circular]);
			expect(function () {
				helpers.flattenDeep(circular);
			}).toThrow(TypeError);
			const selfContaining: unknown[] = [];
			selfContaining.push(selfContaining);
			expect(function () {
				helpers.flattenDeep(selfContaining);
			}).toThrow(new TypeError('flattenDeep: cannot flatten a circular array'));
		});

		it('should detect cycles and accept shared arrays at any depth', function () {
			for (const depth of [10, 63, 64, 65, 200]) {
				const chain: unknown[][] = [[]];
				for (let i = 0; i < depth; i++) {
					const next: unknown[] = [i];
					chain[i].push(next);
					chain.push(next);
				}
				const [root] = chain;
				const innermost = chain[depth];
				// A back-reference to an ancestor halfway up is a cycle...
				innermost.push(chain[depth >> 1]);
				expect(function () {
					helpers.flattenDeep(root);
				}).toThrow(TypeError);
				// ...but once that branch is left, the same array may appear again elsewhere.
				innermost.pop();
				expect(helpers.flattenDeep([root, root, [root]])).toHaveLength(3 * depth);
			}
		});
	});

	describe('unique', function () {
		it('should keep the original sign of zero on the hashed path (more than 32 items)', function () {
			const many = Array.from({ length: 40 }, function (_, index) {
				return index + 1;
			});
			const negativeFirst = helpers.unique([-0, ...many, 0]);
			const positiveFirst = helpers.unique([0, ...many, -0]);
			const noZero = helpers.unique([...many, ...many]);

			expect(negativeFirst).toHaveLength(41);
			expect(Object.is(negativeFirst[0], -0)).toBe(true);
			expect(Object.is(positiveFirst[0], 0)).toBe(true);
			expect(noZero).toStrictEqual(many);
		});

		it('should give the same result for long inputs (more than 16 items)', function () {
			const long = [3, -0, 3, NaN, 'x', 0, NaN, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'x', -0, 11];
			const result = helpers.unique(long);
			expect(result).toStrictEqual([3, -0, NaN, 'x', 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
			expect(Object.is(result[1], -0)).toBe(true);
			expect(helpers.unique([0, ...long])[0]).toBe(0);
			expect(Object.is(helpers.unique([0, ...long])[0], 0)).toBe(true);
		});

		it('should keep the original -0 instead of the +0 a Set hands back', function () {
			expect(Object.is(helpers.unique([-0, 0])[0], -0)).toBe(true);
			expect(Object.is(helpers.union([-0], [1])[0], -0)).toBe(true);
			expect(Object.is(helpers.union([1], [-0])[1], -0)).toBe(true);
			expect(Object.is(helpers.symmetricDifference([-0], [1])[0], -0)).toBe(true);
			expect(Object.is(helpers.symmetricDifference([1], [-0])[1], -0)).toBe(true);
		});

		it('should remove duplicates from an array', function () {
			expect(helpers.unique([1, 2, 2, 3, 4, 4])).toStrictEqual([1, 2, 3, 4]);
		});

		it('should keep the sign of the FIRST zero only', function () {
			expect(helpers.unique([1, -0, 2, 0])).toStrictEqual([1, -0, 2]);
			expect(helpers.unique([1, 0, 2, -0])).toStrictEqual([1, 0, 2]);
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.unique([undefined, , 0n, 0n])).toStrictEqual([undefined, 0n]);
		});

		it('should accept one-shot iterables', function () {
			function* values(): Generator<number> {
				yield* [3, -0, 3, 0, 1];
			}
			expect(helpers.unique(values())).toStrictEqual([3, -0, 1]);
		});

		it('should keep first-occurrence order and handle NaN and strings', function () {
			expect(helpers.unique([3, NaN, 1, 3, NaN])).toStrictEqual([3, NaN, 1]);
			expect(helpers.unique('hello')).toStrictEqual(['h', 'e', 'l', 'o']);
			expect(helpers.unique([])).toStrictEqual([]);
		});
	});

	describe('union', function () {
		it('should return the union of two arrays', function () {
			expect(helpers.union([1, 2, 3], [3, 4, 5])).toStrictEqual([1, 2, 3, 4, 5]);
		});

		it('should deduplicate within each input and preserve first-appearance order', function () {
			expect(helpers.union([2, 1, 2], [3, 1, 3])).toStrictEqual([2, 1, 3]);
			expect(helpers.union([], [])).toStrictEqual([]);
		});

		it('should work with one-shot iterables', function () {
			expect(helpers.union(once('a', 'b'), once('b', 'c'))).toStrictEqual(['a', 'b', 'c']);
		});

		it('should mix an array with another kind of iterable, in either order', function () {
			expect(helpers.union([1, 2], new Set([2, 3]))).toStrictEqual([1, 2, 3]);
			expect(helpers.union(new Set([1, 2]), [2, 3])).toStrictEqual([1, 2, 3]);
		});
	});

	describe('intersection', function () {
		it('should return the intersection of two arrays', function () {
			expect(helpers.intersection([1, 2, 3], [2, 3, 4])).toStrictEqual([2, 3]);
		});

		it('should return unique values ordered as in the first input', function () {
			expect(helpers.intersection([3, 2, 3, 2, 1], [1, 2, 3, 3])).toStrictEqual([3, 2, 1]);
			expect(helpers.intersection([NaN], [NaN])).toStrictEqual([NaN]);
		});

		it('should return an empty array when there is no overlap', function () {
			expect(helpers.intersection([1], [2])).toStrictEqual([]);
			expect(helpers.intersection([], [1])).toStrictEqual([]);
		});

		it('should work with one-shot iterables', function () {
			expect(helpers.intersection(once(1, 2, 3), once(3, 2))).toStrictEqual([2, 3]);
		});
	});

	describe('difference', function () {
		it('should return the difference of two arrays', function () {
			expect(helpers.difference([1, 2, 3], [2, 3, 4])).toStrictEqual([1]);
		});

		it('should return unique values of the first input', function () {
			expect(helpers.difference([1, 5, 1, 5, 2], [2])).toStrictEqual([1, 5]);
			expect(helpers.difference([1, 2], [])).toStrictEqual([1, 2]);
			expect(helpers.difference([], [1])).toStrictEqual([]);
		});

		it('should work with one-shot iterables', function () {
			expect(helpers.difference(once(1, 2, 3), once(2))).toStrictEqual([1, 3]);
		});
	});

	describe('symmetricDifference', function () {
		it('should return values present in exactly one input', function () {
			expect(helpers.symmetricDifference([1, 2, 3], [3, 4])).toStrictEqual([1, 2, 4]);
		});

		it('should deduplicate and handle empty inputs', function () {
			expect(helpers.symmetricDifference([1, 1, 2], [2, 3, 3])).toStrictEqual([1, 3]);
			expect(helpers.symmetricDifference([], [1])).toStrictEqual([1]);
			expect(helpers.symmetricDifference([1, 2], [2, 1])).toStrictEqual([]);
		});
	});

	describe('isSubset', function () {
		it('should detect subsets regardless of order and duplicates', function () {
			expect(helpers.isSubset([1, 2, 2], [3, 2, 1])).toBe(true);
			expect(helpers.isSubset([1, 4], [1, 2, 3])).toBe(false);
		});

		it('should treat the empty set as a subset of anything', function () {
			expect(helpers.isSubset([], [])).toBe(true);
			expect(helpers.isSubset([], [1])).toBe(true);
			expect(helpers.isSubset([1], [])).toBe(false);
		});

		it('should use SameValueZero', function () {
			expect(helpers.isSubset([NaN, -0], [0, NaN])).toBe(true);
		});

		it('should give the same answers for long inputs (hashed rather than scanned)', function () {
			const evens = helpers.range(0, 80, 2);
			expect(helpers.isSubset([NaN, -0, 40], [NaN, ...evens])).toBe(true);
			expect(helpers.isSubset(helpers.range(0, 40), evens)).toBe(false);
			expect(helpers.isSubset([1], evens)).toBe(false);
		});
	});

	describe('set operations on short arrays and long inputs', function () {
		// Inputs totalling at most 32 items are scanned, longer ones (or non-array iterables) are hashed: both must agree.
		const a = [3, -0, NaN, 1, 3, 0, 7, NaN];
		const b = [7, 0, 2, NaN];
		const padding = helpers.range(100, 140);

		it('should give the same results either way, keeping -0 and NaN as SameValueZero', function () {
			expect(helpers.union(a, b)).toStrictEqual([3, -0, NaN, 1, 7, 2]);
			expect(helpers.intersection(a, b)).toStrictEqual([-0, NaN, 7]);
			expect(helpers.intersection(once(...a), once(...b))).toStrictEqual([-0, NaN, 7]);
			expect(helpers.difference(a, b)).toStrictEqual([3, 1]);
			expect(helpers.difference(once(...a), b)).toStrictEqual([3, 1]);
			expect(helpers.symmetricDifference(a, b)).toStrictEqual([3, 1, 2]);
			expect(helpers.isSubset(b, a)).toBe(false);
			expect(helpers.isSubset([0, NaN], a)).toBe(true);
			expect(helpers.isSubset(once(0, NaN), once(...a))).toBe(true);

			expect(helpers.difference([...a, ...padding], b)).toStrictEqual([3, 1, ...padding]);
			expect(helpers.intersection([...a, ...padding], [...b, 139])).toStrictEqual([-0, NaN, 7, 139]);
			expect(helpers.intersection([-0, ...padding], [0])).toStrictEqual([-0]);
		});

		it('should accept any iterable for either input, such as a Set or a string (iterated by code point)', function () {
			expect(helpers.intersection<number | string>([1, '1', 'a', 'b'], 'a1')).toStrictEqual(['1', 'a']);
			expect(helpers.difference<number | string>([1, '1', 'a'], 'a1')).toStrictEqual([1]);
			expect(helpers.isSubset<number | string>([1], '1')).toBe(false);
			expect(helpers.isSubset(['1'], '12')).toBe(true);
			expect(helpers.intersection([1, 2, 3], new Set([3, 2]))).toStrictEqual([2, 3]);
			expect(helpers.difference([1, 2, 3], new Set([2]))).toStrictEqual([1, 3]);
			expect(helpers.isSubset([2], new Set([2]))).toBe(true);
		});
	});

	describe('chunk', function () {
		it('should create the pieces like Array.prototype.slice, also for Array subclasses', function () {
			class List<T> extends Array<T> {}
			const list = List.from([1, 2, 3, 4, 5]) as List<number>;
			for (const piece of [...helpers.chunk(list, 2), helpers.take(list, 2), helpers.drop(list, 3), ...helpers.windowed(list, 2)]) {
				expect(piece).toBeInstanceOf(List);
			}
			expect(helpers.chunk(list, 2)).toStrictEqual([list.slice(0, 2), list.slice(2, 4), list.slice(4)]);
			expect(Object.getPrototypeOf(helpers.take([1, 2, 3], 2))).toBe(Array.prototype);
		});

		it('should keep holes like Array.prototype.slice (chunk, take, drop and windowed)', function () {
			const sparse = new Array<number>(40);
			sparse[1] = 1;
			sparse[38] = 38;
			const chunks = helpers.chunk(sparse, 3);
			expect(chunks).toHaveLength(14);
			expect(0 in chunks[0]).toBe(false);
			expect(chunks[0][1]).toBe(1);
			expect(chunks[0]).toHaveLength(3);
			expect(helpers.take(sparse, 3)).toStrictEqual(sparse.slice(0, 3));
			expect(2 in helpers.take(sparse, 3)).toBe(false);
			expect(helpers.drop(sparse, 37)).toStrictEqual(sparse.slice(37));
			expect(helpers.drop(sparse, 2)).toStrictEqual(sparse.slice(2));
			expect(helpers.windowed(sparse, 2, 19)).toStrictEqual([sparse.slice(0, 2), sparse.slice(19, 21), sparse.slice(38, 40)]);
			expect(0 in helpers.windowed(sparse, 2, 19)[0]).toBe(false);
		});

		it('should split an array into chunks of the given size', function () {
			expect(helpers.chunk([1, 2, 3, 4, 5], 2)).toStrictEqual([[1, 2], [3, 4], [5]]);
			expect(helpers.chunk([1, 2, 3, 4], 2)).toStrictEqual([
				[1, 2],
				[3, 4]
			]);
		});

		it('should handle sizes larger than the array and empty arrays', function () {
			expect(helpers.chunk([1, 2], 10)).toStrictEqual([[1, 2]]);
			expect(helpers.chunk([], 3)).toStrictEqual([]);
			expect(helpers.chunk([1, 2], 1)).toStrictEqual([[1], [2]]);
		});

		it.each([0, -1, 1.5, NaN, Infinity])('should throw a RangeError for size %p', function (size) {
			expect(function () {
				helpers.chunk([1, 2, 3], size);
			}).toThrow(RangeError);
		});
	});

	describe('compact', function () {
		it('should remove every falsy value', function () {
			const input = [0, -0, 1, false, true, '', 'a', null, undefined, NaN, 0n, 1n, [], {}];
			expect(helpers.compact(input)).toStrictEqual([1, true, 'a', 1n, [], {}]);
		});

		it('should narrow the element type', function () {
			const input: Array<string | null | undefined | false> = ['a', null, 'b', undefined, false];
			const result: string[] = helpers.compact(input);
			expect(result).toStrictEqual(['a', 'b']);
			expect(helpers.compact([])).toStrictEqual([]);
		});
	});

	describe('range', function () {
		it('should count from 0 with a single argument', function () {
			expect(helpers.range(5)).toStrictEqual([0, 1, 2, 3, 4]);
			expect(helpers.range(0)).toStrictEqual([]);
			expect(helpers.range(-3)).toStrictEqual([]);
		});

		it('should support start, end and step', function () {
			expect(helpers.range(2, 5)).toStrictEqual([2, 3, 4]);
			expect(helpers.range(2, 8, 2)).toStrictEqual([2, 4, 6]);
			expect(helpers.range(2, 9, 2)).toStrictEqual([2, 4, 6, 8]);
			expect(helpers.range(-2, 2)).toStrictEqual([-2, -1, 0, 1]);
		});

		it('should support negative steps', function () {
			expect(helpers.range(5, 0, -1)).toStrictEqual([5, 4, 3, 2, 1]);
			expect(helpers.range(5, 0, -2)).toStrictEqual([5, 3, 1]);
			expect(helpers.range(0, -3, -1)).toStrictEqual([0, -1, -2]);
		});

		it('should be empty when the step points away from the end', function () {
			expect(helpers.range(0, 5, -1)).toStrictEqual([]);
			expect(helpers.range(5, 0)).toStrictEqual([]);
			expect(helpers.range(3, 3)).toStrictEqual([]);
		});

		it('should use the step when the end is undefined', function () {
			expect(helpers.range(5, undefined, 2)).toStrictEqual([0, 2, 4]);
		});

		it('should compute fractional steps without accumulating errors', function () {
			const values = helpers.range(0, 1, 0.1);
			expect(values).toHaveLength(10);
			expect(values[9]).toBeCloseTo(0.9, 12);
		});

		it('regression: never includes a value equal to the exclusive end because of float rounding', function () {
			// (2.1 - 0) / 0.3 is 7.000000000000001: the count used to be rounded up to 8, so 2.1 itself was produced.
			expect(helpers.range(0, 2.1, 0.3)).toHaveLength(7);
			expect(helpers.range(0, 1.1, 0.1)).toHaveLength(11);
			expect(helpers.range(0, 1.1, 0.1)[10]).toBeCloseTo(1, 12);
			expect(helpers.range(2.1, 0, -0.3)).toHaveLength(7);
			for (const value of helpers.range(0, 2.1, 0.3)) expect(value).toBeLessThan(2.1);
		});

		it('regression: does not add a value just below the end when the step divides the span up to rounding', function () {
			// 3 * 0.3 is 0.8999999999999999 < 0.9; the mathematically intended range has 3 items.
			expect(helpers.range(0, 0.9, 0.3)).toStrictEqual([0, 0.3, 0.6]);
			expect(helpers.range(1e6 + 0.1, 1e6 + 0.4, 0.1)).toHaveLength(3);
		});

		it('keeps the end exclusive even when large magnitudes round values onto it', function () {
			const values = helpers.range(1e16, 1e16 + 4);
			expect(values.length).toBeLessThan(4);
			for (const value of values) expect(value).toBeLessThan(1e16 + 4);
		});

		it('should throw a RangeError for a zero step', function () {
			expect(function () {
				helpers.range(0, 5, 0);
			}).toThrow(RangeError);
		});

		it.each([
			[NaN, undefined, undefined],
			[Infinity, undefined, undefined],
			[0, Infinity, 1],
			[0, 5, NaN],
			[0, 5, -Infinity]
		])('should throw a RangeError for non-finite arguments (%p, %p, %p)', function (start, end, step) {
			expect(function () {
				helpers.range(start, end, step);
			}).toThrow(RangeError);
		});

		it('should throw a RangeError when the result would be too large', function () {
			expect(function () {
				helpers.range(0, 2 ** 40);
			}).toThrow(RangeError);
			expect(function () {
				helpers.range(2 ** 32);
			}).toThrow(new RangeError('range: the range would contain 4294967296 items, more than an array can hold'));
		});

		it.each([
			[137.38, 254.77, 2.73, 43],
			[0.188, 27.966, 0.731, 38],
			[-282.568, -283.696, -0.024, 47],
			[17.9, 18.1, 0.2, 1],
			[-340.78, -468.18, -4.55, 28]
		])('should have exactly (end - start) / step items when that ratio is an integer up to rounding errors: range(%p, %p, %p)', function (start, end, step, count) {
			const values = helpers.range(start, end, step);
			expect(values).toHaveLength(count);
			for (const value of values) expect((value - end) * step).toBeLessThan(0);
		});
	});

	describe('zip', function () {
		it('should zip arrays into typed tuples', function () {
			const result: Array<[number, string, boolean]> = helpers.zip([1, 2], ['a', 'b'], [true, false]);
			expect(result).toStrictEqual([
				[1, 'a', true],
				[2, 'b', false]
			]);
		});

		it('should truncate to the shortest array', function () {
			expect(helpers.zip([1, 2, 3], ['a'])).toStrictEqual([[1, 'a']]);
			expect(helpers.zip([1, 2, 3], [])).toStrictEqual([]);
		});

		it('should handle zero and one arrays', function () {
			expect(helpers.zip()).toStrictEqual([]);
			expect(helpers.zip([1, 2])).toStrictEqual([[1], [2]]);
		});

		it('should accept readonly arrays', function () {
			const a: ReadonlyArray<number> = [1];
			const b = ['x'] as const;
			const result: Array<[number, 'x']> = helpers.zip(a, b);
			expect(result).toStrictEqual([[1, 'x']]);
		});
	});

	describe('groupBy', function () {
		it('should group items by key, preserving order', function () {
			const result = helpers.groupBy([1, 2, 3, 4, 5], function (n) {
				return n % 2 === 0 ? 'even' : 'odd';
			});
			expect(result).toEqual({ odd: [1, 3, 5], even: [2, 4] });
			const odd: number[] | undefined = result.odd;
			expect(odd).toEqual([1, 3, 5]);
		});

		it('should pass the index and support symbol and number keys', function () {
			const sym = Symbol('s');
			const result = helpers.groupBy(['a', 'b', 'c'], function (_value, index) {
				return index === 0 ? sym : index;
			});
			expect(result[sym]).toEqual(['a']);
			expect(result[1]).toEqual(['b']);
			expect(result[2]).toEqual(['c']);
		});

		it('should return an empty object for an empty array', function () {
			expect(helpers.groupBy([], String)).toEqual({});
		});

		it('should be safe against prototype pollution', function () {
			const result = helpers.groupBy(['__proto__', 'constructor', '__proto__'], function (s) {
				return s;
			});
			expect(Object.getPrototypeOf(result)).toBeNull();
			expect(result['__proto__']).toEqual(['__proto__', '__proto__']);
			expect(result['constructor']).toEqual(['constructor']);
			expect(Object.keys(result)).toEqual(['__proto__', 'constructor']);
			expect(({} as any).constructor).toBe(Object);
		});
	});

	describe('keyBy', function () {
		it('should index items by key, last one wins', function () {
			const items = [
				{ id: 'a', v: 1 },
				{ id: 'b', v: 2 },
				{ id: 'a', v: 3 }
			];
			const result = helpers.keyBy(items, function (o) {
				return o.id;
			});
			expect(result).toEqual({ a: { id: 'a', v: 3 }, b: { id: 'b', v: 2 } });
		});

		it('should pass the index and be safe against prototype pollution', function () {
			const result = helpers.keyBy([{ polluted: true }], function (_o, index) {
				return index === 0 ? '__proto__' : 'other';
			});
			expect(Object.getPrototypeOf(result)).toBeNull();
			expect(Object.keys(result)).toEqual(['__proto__']);
			expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
		});
	});

	describe('countBy', function () {
		it('should count items per key', function () {
			const result = helpers.countBy(['one', 'two', 'three'], function (s) {
				return s.length;
			});
			expect(result).toEqual({ 3: 2, 5: 1 });
			expect(helpers.countBy([], String)).toEqual({});
		});

		it('should pass the index and be safe against prototype pollution', function () {
			const result = helpers.countBy(['x', 'y', 'z'], function (_s, index) {
				return index < 2 ? '__proto__' : 'hasOwnProperty';
			});
			expect(Object.getPrototypeOf(result)).toBeNull();
			expect(result['__proto__']).toBe(2);
			expect(result['hasOwnProperty']).toBe(1);
		});
	});

	describe('partition', function () {
		it('should split items according to the predicate, preserving order', function () {
			const [even, odd] = helpers.partition([1, 2, 3, 4, 5], function (n) {
				return n % 2 === 0;
			});
			expect(even).toStrictEqual([2, 4]);
			expect(odd).toStrictEqual([1, 3, 5]);
		});

		it('should narrow with a type-guard predicate', function () {
			const [numbers, strings] = helpers.partition([1, 'a', 2, 'b'], function (value): value is number {
				return typeof value === 'number';
			});
			const n: number[] = numbers;
			const s: string[] = strings;
			expect(n).toStrictEqual([1, 2]);
			expect(s).toStrictEqual(['a', 'b']);
		});

		it('should pass the index and handle empty arrays', function () {
			expect(
				helpers.partition(['a', 'b', 'c'], function (_value, index) {
					return index === 1;
				})
			).toStrictEqual([['b'], ['a', 'c']]);
			expect(helpers.partition([], Boolean)).toStrictEqual([[], []]);
		});
	});

	describe('uniqueBy', function () {
		it('should keep the first item for each key', function () {
			const items = [
				{ id: 1, v: 'a' },
				{ id: 1, v: 'b' },
				{ id: 2, v: 'c' }
			];
			expect(
				helpers.uniqueBy(items, function (o) {
					return o.id;
				})
			).toStrictEqual([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'c' }
			]);
		});

		it('should compare keys with SameValueZero and pass the index', function () {
			expect(helpers.uniqueBy([NaN, 1, NaN], Number)).toStrictEqual([NaN, 1]);
			expect(
				helpers.uniqueBy(['a', 'b', 'c'], function (_value, index) {
					return index % 2;
				})
			).toStrictEqual(['a', 'b']);
			expect(helpers.uniqueBy([], String)).toStrictEqual([]);
		});
	});

	describe('sortBy', function () {
		it('should sort by numeric keys ascending by default without mutating', function () {
			const input = [{ n: 3 }, { n: 1 }, { n: 2 }];
			const result = helpers.sortBy(input, function (o) {
				return o.n;
			});
			expect(result).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
			expect(input).toStrictEqual([{ n: 3 }, { n: 1 }, { n: 2 }]);
			expect(result).not.toBe(input);
		});

		it('should sort descending', function () {
			expect(helpers.sortBy([1, 3, 2], Number, 'desc')).toStrictEqual([3, 2, 1]);
		});

		it('should be stable in both directions', function () {
			const input = [
				{ k: 1, id: 'a' },
				{ k: 0, id: 'b' },
				{ k: 1, id: 'c' },
				{ k: 0, id: 'd' }
			];
			function key(o: { k: number }) {
				return o.k;
			}
			function ids(list: Array<{ id: string }>) {
				return list.map(function (o) {
					return o.id;
				});
			}
			expect(ids(helpers.sortBy(input, key))).toStrictEqual(['b', 'd', 'a', 'c']);
			expect(ids(helpers.sortBy(input, key, 'desc'))).toStrictEqual(['a', 'c', 'b', 'd']);
		});

		it('should compare strings by code units, not locale', function () {
			expect(helpers.sortBy(['b', 'a', 'B', 'é', 'e'], String)).toStrictEqual(['B', 'a', 'b', 'e', 'é']);
		});

		it('should sort by Date and bigint keys', function () {
			const dates = [new Date(2020, 1, 1), new Date(2010, 1, 1), new Date(2015, 1, 1)];
			expect(
				helpers.sortBy(dates, function (d) {
					return d;
				})
			).toStrictEqual([dates[1], dates[2], dates[0]]);
			expect(
				helpers.sortBy([3n, 1n, 2n], function (n) {
					return n;
				})
			).toStrictEqual([1n, 2n, 3n]);
		});

		it('should compare mixed numbers and bigints numerically and put numbers before strings', function () {
			const input: Array<number | bigint | string> = ['a', 2n, 1.5, 'B', 1];
			const result = helpers.sortBy(input, function (v) {
				return v;
			});
			expect(result).toStrictEqual([1, 1.5, 2n, 'B', 'a']);
			expect(
				helpers.sortBy(
					input,
					function (v) {
						return v;
					},
					'desc'
				)
			).toStrictEqual(['a', 'B', 2n, 1.5, 1]);
		});

		it('should put NaN keys and invalid dates last in both directions, stably', function () {
			const input = [NaN, 2, NaN, 1];
			const keys = [10, 2, 20, 1];
			function selector(_value: number, index: number) {
				return Number.isNaN(input[index]) ? NaN : keys[index];
			}
			expect(helpers.sortBy(input, selector)).toStrictEqual([1, 2, NaN, NaN]);
			expect(helpers.sortBy(input, selector, 'desc')).toStrictEqual([2, 1, NaN, NaN]);
			const invalid = new Date(NaN);
			const valid = new Date(0);
			expect(
				helpers.sortBy([invalid, valid], function (d) {
					return d;
				})
			).toStrictEqual([valid, invalid]);
		});

		it('should call the selector once per item', function () {
			const selector = jest.fn(function (n: number) {
				return n;
			});
			helpers.sortBy([5, 4, 3, 2, 1], selector);
			expect(selector).toHaveBeenCalledTimes(5);
		});

		it('should throw a RangeError for an invalid order', function () {
			expect(function () {
				helpers.sortBy([1], Number, 'DESC' as any);
			}).toThrow(new RangeError("sortBy: `order` must be 'asc' or 'desc', got DESC"));
		});
	});

	describe('shuffle', function () {
		it('should return a permutation without mutating the input', function () {
			const input = [1, 2, 3, 4, 5];
			const result = helpers.shuffle(input);
			expect(input).toStrictEqual([1, 2, 3, 4, 5]);
			expect(result).not.toBe(input);
			expect([...result].sort()).toStrictEqual(input);
		});

		it('should be deterministic with an injected generator', function () {
			// random() = 0 always swaps position i with 0: [1,2,3,4] -> [4,2,3,1] -> [3,2,4,1] -> [2,3,4,1]
			expect(helpers.shuffle([1, 2, 3, 4], sequence(0))).toStrictEqual([2, 3, 4, 1]);
			// random() close to 1 always picks j = i, i.e. the identity permutation
			expect(helpers.shuffle([1, 2, 3, 4], sequence(0.999999))).toStrictEqual([1, 2, 3, 4]);
		});

		it('should handle empty and single-item arrays without calling random', function () {
			const random = jest.fn(Math.random);
			expect(helpers.shuffle([], random)).toStrictEqual([]);
			expect(helpers.shuffle(['x'], random)).toStrictEqual(['x']);
			expect(random).not.toHaveBeenCalled();
		});

		it.each([1, -0.1, NaN, 2])('should throw a RangeError when random() returns %p', function (value) {
			expect(function () {
				helpers.shuffle([1, 2, 3], sequence(value));
			}).toThrow(RangeError);
		});

		it('should trust only the built-in Math.random: a replacement installed later is still validated', function () {
			const replacement = jest.spyOn(Math, 'random').mockReturnValue(1);
			try {
				expect(function () {
					helpers.shuffle([1, 2, 3]);
				}).toThrow(RangeError);
				expect(function () {
					helpers.sample([1, 2, 3]);
				}).toThrow(RangeError);
			} finally {
				replacement.mockRestore();
			}
			expect(helpers.sample([1, 2, 3])).toBeGreaterThanOrEqual(1);
		});
	});

	describe('sample', function () {
		it('should pick the item selected by the generator', function () {
			expect(helpers.sample(['a', 'b', 'c'], sequence(0))).toBe('a');
			expect(helpers.sample(['a', 'b', 'c'], sequence(0.5))).toBe('b');
			expect(helpers.sample(['a', 'b', 'c'], sequence(0.99))).toBe('c');
		});

		it('should use Math.random by default', function () {
			expect(['a', 'b']).toContain(helpers.sample(['a', 'b']));
		});

		it('should return undefined for an empty array', function () {
			const random = jest.fn(Math.random);
			expect(helpers.sample([], random)).toBeUndefined();
			expect(random).not.toHaveBeenCalled();
		});

		it('should throw a RangeError when random() is out of range', function () {
			expect(function () {
				helpers.sample([1], sequence(1));
			}).toThrow(RangeError);
		});
	});

	describe('take', function () {
		it('should take the first n items', function () {
			expect(helpers.take([1, 2, 3], 2)).toStrictEqual([1, 2]);
			expect(helpers.take([1, 2, 3], 0)).toStrictEqual([]);
			expect(helpers.take([1, 2, 3], 10)).toStrictEqual([1, 2, 3]);
			expect(helpers.take([], 1)).toStrictEqual([]);
		});

		it.each([-1, 1.5, NaN, Infinity])('should throw a RangeError for n = %p', function (n) {
			expect(function () {
				helpers.take([1, 2, 3], n);
			}).toThrow(RangeError);
		});
	});

	describe('drop', function () {
		it('should drop the first n items', function () {
			expect(helpers.drop([1, 2, 3], 2)).toStrictEqual([3]);
			expect(helpers.drop([1, 2, 3], 0)).toStrictEqual([1, 2, 3]);
			expect(helpers.drop([1, 2, 3], 10)).toStrictEqual([]);
		});

		it.each([-1, 0.5, NaN, -Infinity])('should throw a RangeError for n = %p', function (n) {
			expect(function () {
				helpers.drop([1, 2, 3], n);
			}).toThrow(RangeError);
		});
	});

	describe('unzip', function () {
		it('splits tuples into one array per position (inverse of zip)', function () {
			const pairs: Array<[number, string]> = [
				[1, 'a'],
				[2, 'b']
			];
			const result = helpers.unzip(pairs);
			const typed: [number[], string[]] | [] = result;
			expect(typed).toStrictEqual([
				[1, 2],
				['a', 'b']
			]);
			expect(helpers.unzip(helpers.zip([1, 2, 3], [true, false, true]))).toStrictEqual([
				[1, 2, 3],
				[true, false, true]
			]);
		});

		it('truncates to the shortest tuple, like zip', function () {
			expect(
				helpers.unzip([
					[1, 2, 3],
					[4, 5],
					[6, 7, 8]
				])
			).toStrictEqual([
				[1, 4, 6],
				[2, 5, 7]
			]);
			expect(helpers.unzip([[1], []])).toStrictEqual([]);
		});

		it('returns [] for an empty input (arity unknown)', function () {
			const [xs = [], ys = []] = helpers.unzip<[number, string]>([]);
			expect(xs).toStrictEqual([]);
			expect(ys).toStrictEqual([]);
			expect(helpers.unzip([])).toStrictEqual([]);
		});
	});

	describe('windowed / pairwise', function () {
		it('returns full sliding windows', function () {
			expect(helpers.windowed([1, 2, 3, 4], 2)).toStrictEqual([
				[1, 2],
				[2, 3],
				[3, 4]
			]);
			expect(helpers.windowed([1, 2, 3, 4, 5], 2, 2)).toStrictEqual([
				[1, 2],
				[3, 4]
			]);
			expect(helpers.windowed([1, 2, 3, 4, 5], 3, 2)).toStrictEqual([
				[1, 2, 3],
				[3, 4, 5]
			]);
			expect(helpers.windowed([1, 2, 3], 1, 5)).toStrictEqual([[1]]);
			expect(helpers.windowed([1, 2], 3)).toStrictEqual([]);
			expect(helpers.windowed([], 1)).toStrictEqual([]);
		});

		it('returns fresh windows', function () {
			const input = [1, 2, 3];
			const [window] = helpers.windowed(input, 3);
			window.push(4);
			expect(input).toStrictEqual([1, 2, 3]);
		});

		it.each([
			[0, 1],
			[-1, 1],
			[1.5, 1],
			[NaN, 1],
			[Infinity, 1],
			[2, 0],
			[2, -2],
			[2, 0.5],
			[2, Infinity]
		])('throws a RangeError for size %p and step %p', function (size, step) {
			expect(function () {
				helpers.windowed([1, 2, 3], size, step);
			}).toThrow(RangeError);
		});

		it('pairwise returns adjacent pairs', function () {
			const pairs: Array<[string, string]> = helpers.pairwise(['a', 'b', 'c']);
			expect(pairs).toStrictEqual([
				['a', 'b'],
				['b', 'c']
			]);
			expect(helpers.pairwise([1])).toStrictEqual([]);
			expect(helpers.pairwise([])).toStrictEqual([]);
		});
	});

	describe('minBy / maxBy', function () {
		const items = [
			{ id: 'a', n: 3 },
			{ id: 'b', n: 1 },
			{ id: 'c', n: 7 },
			{ id: 'd', n: 1 },
			{ id: 'e', n: 7 }
		];

		function byN(item: { n: number }): number {
			return item.n;
		}

		it('returns the first item with the extreme key', function () {
			expect(helpers.minBy(items, byN)?.id).toBe('b');
			expect(helpers.maxBy(items, byN)?.id).toBe('c');
		});

		it('keeps the first of several equal string keys', function () {
			const words = [
				{ id: 1, w: 'b' },
				{ id: 2, w: 'a' },
				{ id: 3, w: 'c' },
				{ id: 4, w: 'a' },
				{ id: 5, w: 'c' }
			];
			function byWord(item: { w: string }): string {
				return item.w;
			}
			expect(helpers.minBy(words, byWord)?.id).toBe(2);
			expect(helpers.maxBy(words, byWord)?.id).toBe(3);
		});

		it('returns undefined for empty arrays or when every key is NaN', function () {
			expect(helpers.minBy([], byN)).toBeUndefined();
			expect(helpers.maxBy([], byN)).toBeUndefined();
			expect(helpers.minBy([NaN, NaN], Number)).toBeUndefined();
			expect(
				helpers.maxBy([new Date(NaN)], function (d) {
					return d;
				})
			).toBeUndefined();
		});

		it('ignores NaN keys and invalid dates', function () {
			expect(helpers.minBy([NaN, 2, NaN, 1], Number)).toBe(1);
			expect(helpers.maxBy([NaN, 2, 1], Number)).toBe(2);
			const dates = [new Date(NaN), new Date(5), new Date(1)];
			expect(
				helpers.minBy(dates, function (d) {
					return d;
				})
			).toBe(dates[2]);
			expect(
				helpers.maxBy(dates, function (d) {
					return d;
				})
			).toBe(dates[1]);
		});

		it('uses the sortBy ordering (bigints, strings by code unit, numbers before strings)', function () {
			expect(helpers.maxBy(['b', 'a', 'B'], String)).toBe('b');
			expect(helpers.minBy(['b', 'a', 'B'], String)).toBe('B');
			expect(
				helpers.maxBy([1n, 3, 2n], function (v) {
					return v;
				})
			).toBe(3);
			expect(
				helpers.minBy<number | string>(['a', 5], function (v) {
					return v;
				})
			).toBe(5);
			expect(
				helpers.maxBy<number | string>([5, 'a'], function (v) {
					return v;
				})
			).toBe('a');
		});

		it('calls the selector once per item with its index', function () {
			const selector = jest.fn(function (value: number) {
				return value;
			});
			helpers.minBy([3, 1, 2], selector);
			expect(selector.mock.calls).toStrictEqual([
				[3, 0],
				[1, 1],
				[2, 2]
			]);
		});

		it('handles number keys followed by other key types, still calling the selector once per item', function () {
			const keys: Array<number | string | bigint | Date> = [NaN, 4, 2, 'b', 1n, new Date(0), 'a', 3];
			const indices: number[] = [];
			/**
			 * Records the index it is called with and returns the item as its key.
			 * @param {number | string | bigint | Date} value - The item
			 * @param {number} index - Its index
			 * @returns {number | string | bigint | Date} The item
			 */
			function selector(value: number | string | bigint | Date, index: number): number | string | bigint | Date {
				indices.push(index);
				return value;
			}
			expect(helpers.minBy(keys, selector)).toBe(keys[5]);
			expect(indices).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(helpers.maxBy(keys, selector)).toBe('b');
			expect(helpers.minBy([NaN, 'x'], selector)).toBe('x');
			expect(helpers.maxBy([NaN, NaN, new Date(NaN), 2n], selector)).toBe(2n);
			expect(helpers.minBy([5, 5, 'q', 5], selector)).toBe(5);
			indices.length = 0;
			expect(helpers.maxBy(['b', 1, 'c'], selector)).toBe('c');
			expect(indices).toStrictEqual([0, 1, 2]);
		});
	});

	describe('sumBy', function () {
		it('sums the selected numbers with compensated summation', function () {
			expect(
				helpers.sumBy([{ p: 0.1 }, { p: 0.2 }, { p: 0.3 }], function (o) {
					return o.p;
				})
			).toBe(0.6);
			expect(helpers.sumBy([1e100, 1, -1e100], Number)).toBe(1);
			// The small term is kept whether it comes before or after the large one.
			expect(helpers.sumBy([1, 1e100, -1e100], Number)).toBe(1);
			expect(
				helpers.sumBy(['a', 'bb'], function (s, i) {
					return s.length * 10 + i;
				})
			).toBe(31);
		});

		it('returns 0 for an empty array and propagates NaN/Infinity', function () {
			expect(helpers.sumBy([], Number)).toBe(0);
			expect(helpers.sumBy([1, NaN], Number)).toBeNaN();
			expect(helpers.sumBy([1, Infinity], Number)).toBe(Infinity);
		});
	});

	describe('move / insertAt / removeAt', function () {
		it('move relocates an item without mutating the input', function () {
			const input = ['a', 'b', 'c', 'd'];
			expect(helpers.move(input, 0, 2)).toStrictEqual(['b', 'c', 'a', 'd']);
			expect(helpers.move(input, 3, 0)).toStrictEqual(['d', 'a', 'b', 'c']);
			expect(helpers.move(input, -1, 0)).toStrictEqual(['d', 'a', 'b', 'c']);
			expect(helpers.move(input, 0, -1)).toStrictEqual(['b', 'c', 'd', 'a']);
			expect(helpers.move(input, 1, 1)).toStrictEqual(input);
			expect(helpers.move(input, 1, 1)).not.toBe(input);
			expect(input).toStrictEqual(['a', 'b', 'c', 'd']);
		});

		it.each([
			[4, 0],
			[0, 4],
			[-5, 0],
			[0, -5],
			[0.5, 0],
			[0, NaN]
		])('move throws a RangeError for from %p and to %p', function (from, to) {
			expect(function () {
				helpers.move(['a', 'b', 'c', 'd'], from, to);
			}).toThrow(RangeError);
		});

		it('move throws for any index of an empty array', function () {
			expect(function () {
				helpers.move([], 0, 0);
			}).toThrow('move: `from` must be a valid index, but the array is empty, got 0');
		});

		it('insertAt inserts items before the index (negative indices count from the end)', function () {
			const input = [1, 2, 3];
			expect(helpers.insertAt(input, 0, 9)).toStrictEqual([9, 1, 2, 3]);
			expect(helpers.insertAt(input, 1, 9, 8)).toStrictEqual([1, 9, 8, 2, 3]);
			expect(helpers.insertAt(input, 3, 9)).toStrictEqual([1, 2, 3, 9]);
			expect(helpers.insertAt(input, -1, 9)).toStrictEqual([1, 2, 9, 3]);
			expect(helpers.insertAt(input, -3, 9)).toStrictEqual([9, 1, 2, 3]);
			expect(helpers.insertAt(input, 2)).toStrictEqual([1, 2, 3]);
			expect(helpers.insertAt([], 0, 'x')).toStrictEqual(['x']);
			expect(helpers.insertAt([[1]], 1, [2])).toStrictEqual([[1], [2]]);
			expect(input).toStrictEqual([1, 2, 3]);
		});

		it.each([4, -4, 1.5, NaN, Infinity])('insertAt throws a RangeError for index %p', function (index) {
			expect(function () {
				helpers.insertAt([1, 2, 3], index, 0);
			}).toThrow(RangeError);
		});

		it('removeAt removes count items from the index', function () {
			const input = [1, 2, 3, 4];
			expect(helpers.removeAt(input, 1)).toStrictEqual([1, 3, 4]);
			expect(helpers.removeAt(input, 1, 2)).toStrictEqual([1, 4]);
			expect(helpers.removeAt(input, -2, 2)).toStrictEqual([1, 2]);
			expect(helpers.removeAt(input, -1)).toStrictEqual([1, 2, 3]);
			expect(helpers.removeAt(input, 2, 0)).toStrictEqual([1, 2, 3, 4]);
			expect(helpers.removeAt(input, 1, 100)).toStrictEqual([1]);
			expect(input).toStrictEqual([1, 2, 3, 4]);
		});

		it.each([
			[4, 1],
			[-5, 1],
			[0.5, 1],
			[0, -1],
			[0, 1.5],
			[0, Infinity]
		])('removeAt throws a RangeError for index %p and count %p', function (index, count) {
			expect(function () {
				helpers.removeAt([1, 2, 3, 4], index, count);
			}).toThrow(RangeError);
		});
	});

	describe('sortedIndex / binarySearch', function () {
		it('sortedIndex returns the lowest insertion index', function () {
			expect(helpers.sortedIndex([10, 20, 20, 30], 20)).toBe(1);
			expect(helpers.sortedIndex([10, 20, 30], 5)).toBe(0);
			expect(helpers.sortedIndex([10, 20, 30], 25)).toBe(2);
			expect(helpers.sortedIndex([10, 20, 30], 99)).toBe(3);
			expect(helpers.sortedIndex([], 1)).toBe(0);
			expect(helpers.sortedIndex(['B', 'a', 'c'], 'b')).toBe(2);
			expect(helpers.sortedIndex([1n, 5n, 9n], 6n)).toBe(2);
		});

		it('sortedIndex accepts a comparator', function () {
			const people = [{ age: 20 }, { age: 30 }, { age: 30 }, { age: 40 }];
			function compare(a: { age: number }, b: { age: number }): number {
				return a.age - b.age;
			}
			expect(helpers.sortedIndex(people, { age: 30 }, compare)).toBe(1);
			expect(
				helpers.sortedIndex([3, 2, 1], 2, function (a, b) {
					return b - a;
				})
			).toBe(1);
		});

		it('binarySearch finds the lowest matching index or -1', function () {
			expect(helpers.binarySearch([1, 3, 5, 7], 5)).toBe(2);
			expect(helpers.binarySearch([1, 3, 5, 7], 1)).toBe(0);
			expect(helpers.binarySearch([1, 3, 5, 7], 7)).toBe(3);
			expect(helpers.binarySearch([1, 3, 5, 7], 4)).toBe(-1);
			expect(helpers.binarySearch([1, 3, 5, 7], 8)).toBe(-1);
			expect(helpers.binarySearch([], 8)).toBe(-1);
			expect(helpers.binarySearch([1, 2, 2, 2, 3], 2)).toBe(1);
			expect(helpers.binarySearch(['a', 'b'], 'b')).toBe(1);
		});

		it('binarySearch accepts a comparator', function () {
			function caseInsensitive(a: string, b: string): number {
				const x = a.toLowerCase();
				const y = b.toLowerCase();
				return x < y ? -1 : x > y ? 1 : 0;
			}
			expect(helpers.binarySearch(['a', 'B', 'c'], 'b', caseInsensitive)).toBe(1);
			expect(helpers.binarySearch(['a', 'B', 'c'], 'd', caseInsensitive)).toBe(-1);
		});

		it('rejects NaN with the default comparator', function () {
			expect(function () {
				helpers.sortedIndex([1, 2], NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.binarySearch([1, 2], NaN);
			}).toThrow(RangeError);
		});
	});

	describe('cartesianProduct', function () {
		it('combines every item of each array, last array fastest', function () {
			const result = helpers.cartesianProduct([1, 2], ['a', 'b'], [true]);
			const typed: Array<[number, string, boolean]> = result;
			expect(typed).toStrictEqual([
				[1, 'a', true],
				[1, 'b', true],
				[2, 'a', true],
				[2, 'b', true]
			]);
		});

		it('handles empty arrays and no arguments', function () {
			expect(helpers.cartesianProduct([1, 2], [])).toStrictEqual([]);
			expect(helpers.cartesianProduct()).toStrictEqual([[]]);
			expect(helpers.cartesianProduct([1, 2])).toStrictEqual([[1], [2]]);
		});

		it('throws a RangeError when the product is too large', function () {
			const big = { length: 2 ** 20 } as unknown as number[];
			expect(function () {
				helpers.cartesianProduct(big, big);
			}).toThrow(new RangeError('cartesianProduct: the product would contain 1099511627776 tuples of 2 items, more than 2 ** 32 - 1 items in all'));
		});
	});

	describe('intersperse', function () {
		it('inserts the separator between items', function () {
			const result: Array<number | string> = helpers.intersperse([1, 2, 3], ',');
			expect(result).toStrictEqual([1, ',', 2, ',', 3]);
			expect(helpers.intersperse(['a'], 0)).toStrictEqual(['a']);
			expect(helpers.intersperse([], 0)).toStrictEqual([]);
		});
	});

	describe('differenceBy / intersectionBy', function () {
		function id(o: { id: number }): number {
			return o.id;
		}

		it('differenceBy keeps the first item of a per key absent from b', function () {
			expect(helpers.differenceBy([{ id: 1 }, { id: 2 }, { id: 1, v: 'dup' }], [{ id: 2 }], id)).toStrictEqual([{ id: 1 }]);
			expect(helpers.differenceBy([1.2, 2.5, 3.1, 3.9], [2.1], Math.floor)).toStrictEqual([1.2, 3.1]);
			expect(helpers.differenceBy([], [1], Number)).toStrictEqual([]);
		});

		it('intersectionBy keeps the first item of a per key present in b', function () {
			expect(helpers.intersectionBy([{ id: 1 }, { id: 2, v: 'first' }, { id: 2 }], [{ id: 2 }, { id: 3 }], id)).toStrictEqual([{ id: 2, v: 'first' }]);
			expect(helpers.intersectionBy([1.2, 2.5], [], Math.floor)).toStrictEqual([]);
		});

		it('accepts different item types and iterables, and uses SameValueZero', function () {
			const users = [{ id: 1 }, { id: 2 }];
			function key(item: { id: number } | number): number {
				return typeof item === 'number' ? item : item.id;
			}
			expect(helpers.differenceBy<{ id: number }, number>(users, once(2), key)).toStrictEqual([{ id: 1 }]);
			expect(helpers.intersectionBy<{ id: number }, number>(once(...users), [2], key)).toStrictEqual([{ id: 2 }]);
			expect(helpers.intersectionBy([NaN], [NaN], Number)).toStrictEqual([NaN]);
		});

		it('differenceBy gives the same results for short arrays (keys scanned) and long inputs (keys hashed)', function () {
			const a = [1.5, 2.5, 1.9, NaN, 4.2, NaN];
			const b = [2.1, 9];
			const padding = helpers.range(100, 140);
			expect(helpers.differenceBy(a, b, Math.floor)).toStrictEqual([1.5, NaN, 4.2]);
			expect(helpers.differenceBy(once(...a), b, Math.floor)).toStrictEqual([1.5, NaN, 4.2]);
			expect(helpers.differenceBy([...a, ...padding, 100.5], b, Math.floor)).toStrictEqual([1.5, NaN, 4.2, ...padding]);
		});
	});

	describe('argument validation', function () {
		it('rejects non-function callbacks with a TypeError, even for empty input', function () {
			const callbacks: Array<[string, () => unknown]> = [
				[
					'groupBy: `keyFn`',
					function () {
						return helpers.groupBy([], undefined as any);
					}
				],
				[
					'keyBy: `keyFn`',
					function () {
						return helpers.keyBy([], undefined as any);
					}
				],
				[
					'countBy: `keyFn`',
					function () {
						return helpers.countBy([], undefined as any);
					}
				],
				[
					'partition: `predicate`',
					function () {
						return helpers.partition([], undefined as any);
					}
				],
				[
					'uniqueBy: `keyFn`',
					function () {
						return helpers.uniqueBy([], undefined as any);
					}
				],
				[
					'sortBy: `selector`',
					function () {
						return helpers.sortBy([], undefined as any);
					}
				],
				[
					'minBy: `selector`',
					function () {
						return helpers.minBy([], undefined as any);
					}
				],
				[
					'maxBy: `selector`',
					function () {
						return helpers.maxBy([], undefined as any);
					}
				],
				[
					'sumBy: `selector`',
					function () {
						return helpers.sumBy([], undefined as any);
					}
				],
				[
					'differenceBy: `keyFn`',
					function () {
						return helpers.differenceBy([], [], undefined as any);
					}
				],
				[
					'intersectionBy: `keyFn`',
					function () {
						return helpers.intersectionBy([], [], undefined as any);
					}
				],
				[
					'sortedIndex: `compare`',
					function () {
						return helpers.sortedIndex([], 1, 'x' as any);
					}
				],
				[
					'binarySearch: `compare`',
					function () {
						return helpers.binarySearch([], 1, null as any);
					}
				],
				[
					'shuffle: `random`',
					function () {
						return helpers.shuffle([1, 2], 0.5 as any);
					}
				],
				[
					'sample: `random`',
					function () {
						return helpers.sample([1], 0.5 as any);
					}
				]
			];
			for (const [prefix, call] of callbacks) {
				expect(call).toThrow(TypeError);
				expect(call).toThrow(`${prefix} must be a function`);
			}
		});

		it('rejects non-number counts with a TypeError and invalid numbers with a RangeError', function () {
			expect(function () {
				helpers.chunk([1], '2' as any);
			}).toThrow(new TypeError('chunk: `size` must be an integer >= 1, got string'));
			expect(function () {
				helpers.chunk([1], 0);
			}).toThrow(new RangeError('chunk: `size` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.insertAt([1], null as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.insertAt([1], 5);
			}).toThrow(new RangeError('insertAt: `index` must be an integer in [-1, 1], got 5'));
		});

		it('names the function and the argument in index and count errors', function () {
			expect(function () {
				helpers.take([1], -1);
			}).toThrow(new RangeError('take: `n` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.drop([1], 0.5);
			}).toThrow(new RangeError('drop: `n` must be an integer >= 0, got 0.5'));
			expect(function () {
				helpers.windowed([1], 0);
			}).toThrow(new RangeError('windowed: `size` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.windowed([1], 1, 0);
			}).toThrow(new RangeError('windowed: `step` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.move([1, 2], 0, 2);
			}).toThrow(new RangeError('move: `to` must be an integer in [-2, 1], got 2'));
			expect(function () {
				helpers.move([1], 1, 0);
			}).toThrow(new RangeError('move: `from` must be an integer in [-1, 0], got 1'));
			expect(function () {
				helpers.move([], 0, 0);
			}).toThrow(new RangeError('move: `from` must be a valid index, but the array is empty, got 0'));
			expect(function () {
				helpers.removeAt([1], 1);
			}).toThrow(new RangeError('removeAt: `index` must be an integer in [-1, 0], got 1'));
			expect(function () {
				helpers.removeAt([1], 0, -1);
			}).toThrow(new RangeError('removeAt: `count` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.insertAt([1], 2, 0);
			}).toThrow(new RangeError('insertAt: `index` must be an integer in [-1, 1], got 2'));
			expect(function () {
				helpers.binarySearch([1], NaN);
			}).toThrow(new RangeError('binarySearch: `value` must not be NaN when no comparator is given, got NaN'));
		});

		it('validates every argument of range by name', function () {
			expect(function () {
				helpers.range(NaN);
			}).toThrow(new RangeError('range: `start` must be a finite number, got NaN'));
			expect(function () {
				helpers.range(0, Infinity);
			}).toThrow(new RangeError('range: `end` must be a finite number, got Infinity'));
			expect(function () {
				helpers.range(0, null as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.range(0, 5, 0);
			}).toThrow(new RangeError('range: `step` must be a finite number other than 0, got 0'));
		});
	});
	describe('diffSequences', function () {
		it('should produce an ordered edit script', function () {
			expect(helpers.diffSequences([1, 2, 3], [1, 3, 4])).toStrictEqual([
				{ type: 'equal', value: 1, indexA: 0, indexB: 0 },
				{ type: 'delete', value: 2, indexA: 1 },
				{ type: 'equal', value: 3, indexA: 2, indexB: 1 },
				{ type: 'insert', value: 4, indexB: 2 }
			]);
		});

		it('should handle empty sequences', function () {
			expect(helpers.diffSequences([], [])).toStrictEqual([]);
			expect(helpers.diffSequences([], ['a', 'b'])).toStrictEqual([
				{ type: 'insert', value: 'a', indexB: 0 },
				{ type: 'insert', value: 'b', indexB: 1 }
			]);
			expect(helpers.diffSequences(['a', 'b'], [])).toStrictEqual([
				{ type: 'delete', value: 'a', indexA: 0 },
				{ type: 'delete', value: 'b', indexA: 1 }
			]);
		});

		it('should keep identical sequences entirely', function () {
			expect(helpers.diffSequences('abc', 'abc')).toStrictEqual([
				{ type: 'equal', value: 'a', indexA: 0, indexB: 0 },
				{ type: 'equal', value: 'b', indexA: 1, indexB: 1 },
				{ type: 'equal', value: 'c', indexA: 2, indexB: 2 }
			]);
		});

		it('should list deletions before insertions within a change block', function () {
			const types = helpers.diffSequences([0, 1, 2, 9, 3, 4], [0, 5, 6, 9, 7]).map(function (operation) {
				return operation.type;
			});
			expect(types).toStrictEqual(['equal', 'delete', 'delete', 'insert', 'insert', 'equal', 'delete', 'delete', 'insert']);
		});

		it('should be minimal on classic examples', function () {
			const a = Array.from('ABCABBA');
			const b = Array.from('CBABAC');
			const script = helpers.diffSequences(a, b);
			expectValidMinimalScript(a, b, script);
			expect(
				script.filter(function (operation) {
					return operation.type !== 'equal';
				})
			).toHaveLength(5);
			expectValidMinimalScript(Array.from('kitten'), Array.from('sitting'), helpers.diffSequences('kitten', 'sitting'));
		});

		it('should be minimal for every pair of short binary sequences', function () {
			const sequences: number[][] = [[]];
			for (let length = 1; length <= 5; length++) {
				for (let bits = 0; bits < 2 ** length; bits++) {
					sequences.push(
						Array.from({ length }, function (_, i) {
							return (bits >> i) & 1;
						})
					);
				}
			}
			for (const a of sequences) {
				for (const b of sequences) expectValidMinimalScript(a, b, helpers.diffSequences(a, b));
			}
		});

		it('should be minimal when the backward search must choose between diagonals (sequences of different lengths)', function () {
			const pairs: Array<[number[], number[]]> = [
				[
					[1, 1, 1, 0, 0],
					[0, 0, 0, 1, 0, 1, 1]
				],
				[
					[1, 1, 0, 1, 0],
					[0, 0, 0, 0, 1, 1, 1]
				],
				[
					[2, 2, 1, 2, 0],
					[0, 2, 0, 1, 0, 1, 1]
				]
			];
			for (const [a, b] of pairs) {
				expectValidMinimalScript(a, b, helpers.diffSequences(a, b));
				expectValidMinimalScript(b, a, helpers.diffSequences(b, a));
			}
			expect(helpers.longestCommonSubsequence([2, 2, 1, 2, 0], [0, 2, 0, 1, 0, 1, 1])).toHaveLength(3);
		});

		it('should split strings and other iterables into elements', function () {
			expect(helpers.diffSequences('😀a', '😀b')).toStrictEqual([
				{ type: 'equal', value: '😀', indexA: 0, indexB: 0 },
				{ type: 'delete', value: 'a', indexA: 1 },
				{ type: 'insert', value: 'b', indexB: 1 }
			]);
			expect(helpers.diffSequences(new Set([1, 2]), once(2, 3))).toStrictEqual([
				{ type: 'delete', value: 1, indexA: 0 },
				{ type: 'equal', value: 2, indexA: 1, indexB: 0 },
				{ type: 'insert', value: 3, indexB: 1 }
			]);
		});

		it('should compare with SameValueZero by default and report the element of a', function () {
			const script = helpers.diffSequences([NaN, -0], [NaN, 0]);
			expect(script).toStrictEqual([
				{ type: 'equal', value: NaN, indexA: 0, indexB: 0 },
				{ type: 'equal', value: -0, indexA: 1, indexB: 1 }
			]);
			expect(Object.is(script[1].value, -0)).toBe(true);
			expect(helpers.longestCommonSubsequence([NaN, 1], [2, NaN])).toStrictEqual([NaN]);
			expect(helpers.longestCommonSubsequence([NaN], [1])).toStrictEqual([]);
			expect(helpers.longestCommonSubsequence([1], [NaN])).toStrictEqual([]);
			expect(
				helpers.diffSequences([{}], [{}]).map(function (operation) {
					return operation.type;
				})
			).toStrictEqual(['delete', 'insert']);
		});

		it('should call a custom equality as equals(itemOfA, itemOfB)', function () {
			const a = [
				{ id: 1, from: 'a' },
				{ id: 2, from: 'a' }
			];
			const b = [
				{ id: 2, from: 'b' },
				{ id: 3, from: 'b' }
			];
			const equals = jest.fn(function (x: { id: number; from: string }, y: { id: number; from: string }) {
				expect(x.from).toBe('a');
				expect(y.from).toBe('b');
				return x.id === y.id;
			});
			expect(helpers.diffSequences(a, b, equals)).toStrictEqual([
				{ type: 'delete', value: a[0], indexA: 0 },
				{ type: 'equal', value: a[1], indexA: 1, indexB: 0 },
				{ type: 'insert', value: b[1], indexB: 1 }
			]);
			expect(equals).toHaveBeenCalled();
		});

		it('should not mutate its inputs', function () {
			const a = Object.freeze([1, 2, 3]);
			const b = Object.freeze([3, 2, 1]);
			expectValidMinimalScript(a, b, helpers.diffSequences(a, b));
			expect(a).toStrictEqual([1, 2, 3]);
		});

		it('should handle long, nearly identical sequences quickly', function () {
			const a = Array.from({ length: 100_000 }, function (_, i) {
				return i % 997;
			});
			const b = a.slice();
			b.splice(500, 3, -1);
			b.splice(90_000, 0, -2, -3);
			const script = helpers.diffSequences(a, b);
			expect(
				script.filter(function (operation) {
					return operation.type !== 'equal';
				})
			).toHaveLength(6);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.diffSequences(null as any, []);
			}).toThrow(new TypeError('diffSequences: `a` must be an iterable, got null'));
			expect(function () {
				helpers.diffSequences([], 42 as any);
			}).toThrow(new TypeError('diffSequences: `b` must be an iterable, got number'));
			expect(function () {
				helpers.diffSequences([], {} as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.diffSequences([], [], 'eq' as any);
			}).toThrow(new TypeError('diffSequences: `equals` must be a function, got string'));
		});
	});

	describe('longestCommonSubsequence', function () {
		it('should return a longest common subsequence', function () {
			expect(helpers.longestCommonSubsequence([1, 2, 3, 4, 5], [2, 4, 6, 5])).toStrictEqual([2, 4, 5]);
			expect(helpers.longestCommonSubsequence('ABCBDAB', 'BDCABA')).toHaveLength(4);
			expect(helpers.longestCommonSubsequence('abc', 'abc')).toStrictEqual(['a', 'b', 'c']);
		});

		it('should return an empty array when nothing is shared', function () {
			expect(helpers.longestCommonSubsequence([], [1])).toStrictEqual([]);
			expect(helpers.longestCommonSubsequence([1, 2], [3, 4])).toStrictEqual([]);
		});

		it('should take the elements from a when a custom equality is used', function () {
			const result = helpers.longestCommonSubsequence(['A', 'b', 'C'], ['a', 'c'], function (x, y) {
				return x.toLowerCase() === y.toLowerCase();
			});
			expect(result).toStrictEqual(['A', 'C']);
		});

		it('should validate its arguments under its own name', function () {
			expect(function () {
				helpers.longestCommonSubsequence(undefined as any, []);
			}).toThrow(new TypeError('longestCommonSubsequence: `a` must be an iterable, got undefined'));
			expect(function () {
				helpers.longestCommonSubsequence([], [], null as any);
			}).toThrow(new TypeError('longestCommonSubsequence: `equals` must be a function, got null'));
		});
	});
	describe('security', function () {
		it('sumBy converts numeric strings with unary plus instead of concatenating them, like sum', function () {
			const strings = new URLSearchParams('n=1&n=2&n=3').getAll('n');
			expect(
				helpers.sumBy(strings, function (value) {
					return value as never as number;
				})
			).toBe(6);
			expect(
				helpers.sumBy(['1', 'x'], function (value) {
					return value as never as number;
				})
			).toBe(NaN);
		});

		it('diffSequences and longestCommonSubsequence stop with a RangeError once more than `maxEdits` edits are needed', function () {
			const a = 'a'.repeat(20_000);
			const b = 'b'.repeat(20_000);
			const start = performance.now();
			expect(function () {
				helpers.diffSequences(a, b, undefined, { maxEdits: 100 });
			}).toThrow(new RangeError('diffSequences: the sequences differ by more than `maxEdits` (100) insertions and deletions'));
			expect(function () {
				helpers.longestCommonSubsequence(a, b, undefined, { maxEdits: 100 });
			}).toThrow(new RangeError('longestCommonSubsequence: the sequences differ by more than `maxEdits` (100) insertions and deletions'));
			// Without the budget, the same call costs about 40 000² / 2 comparisons (seconds).
			expect(performance.now() - start).toBeLessThan(500);
		});

		it('`maxEdits` is exact: the edit distance itself is accepted, one less is rejected', function () {
			const pairs: Array<[string, string]> = [
				['kitten', 'sitting'],
				['abc', 'abc'],
				['', 'abcd'],
				['abcd', ''],
				['abcabba', 'cbabac'],
				['ab', 'ba'],
				['xaaaay', 'yaaaax']
			];
			for (const [a, b] of pairs) {
				const distance = helpers.diffSequences(a, b).filter(function (operation) {
					return operation.type !== 'equal';
				}).length;
				expect(helpers.diffSequences(a, b, undefined, { maxEdits: distance })).toStrictEqual(helpers.diffSequences(a, b));
				expect(helpers.longestCommonSubsequence(a, b, undefined, { maxEdits: distance })).toStrictEqual(helpers.longestCommonSubsequence(a, b));
				if (distance > 0) {
					expect(function () {
						helpers.diffSequences(a, b, undefined, { maxEdits: distance - 1 });
					}).toThrow(RangeError);
				}
			}
		});

		it('validates `maxEdits`', function () {
			expect(function () {
				helpers.diffSequences([], [], undefined, { maxEdits: -1 });
			}).toThrow(new RangeError('diffSequences: `maxEdits` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				helpers.longestCommonSubsequence([], [], undefined, { maxEdits: '5' as any });
			}).toThrow(new TypeError('longestCommonSubsequence: `maxEdits` must be an integer >= 0 or Infinity, got string'));
			expect(helpers.diffSequences([1], [2], undefined, { maxEdits: Infinity })).toHaveLength(2);
			expect(helpers.diffSequences([1], [2], undefined, {})).toHaveLength(2);
		});

		it('windowed rejects results with more than 2 ** 32 - 1 items in all before allocating them', function () {
			const items = new Array(200_000).fill(0);
			expect(function () {
				helpers.windowed(items, 100_000);
			}).toThrow(new RangeError('windowed: the result would contain 100001 windows of 100000 items, more than 2 ** 32 - 1 items in all'));
			const huge = { length: 2 ** 32 - 1 } as unknown as number[];
			expect(function () {
				helpers.windowed(huge, 2, 1);
			}).toThrow(new RangeError('windowed: the result would contain 4294967294 windows of 2 items, more than 2 ** 32 - 1 items in all'));
			expect(helpers.windowed([1, 2, 3, 4, 5], 2, 2)).toStrictEqual([
				[1, 2],
				[3, 4]
			]);
		});

		it('cartesianProduct rejects results with more than 2 ** 32 - 1 items in all before allocating them', function () {
			const values = Array.from({ length: 200 }, function (_, index) {
				return index;
			});
			expect(function () {
				helpers.cartesianProduct(values, values, values, values);
			}).toThrow(new RangeError('cartesianProduct: the product would contain 1600000000 tuples of 4 items, more than 2 ** 32 - 1 items in all'));
		});
	});
});

describe('Arrays helpers (ordering, slicing, set algebra, combinatorics)', function () {
	/** Identity selector for numbers. */
	function self(n: number): number {
		return n;
	}

	/** Record key used by the set-algebra tests. */
	function byId(item: { id: number }): number {
		return item.id;
	}

	/** SameValueZero, for the comparator-based helpers. */
	function same(x: unknown, y: unknown): boolean {
		return x === y || (x !== x && y !== y);
	}

	describe('orderBy', function () {
		const users = [
			{ name: 'cy', age: 30 },
			{ name: 'al', age: 25 },
			{ name: 'bo', age: 30 },
			{ name: 'al', age: 40 }
		];

		/** Name selector. */
		function name(user: { name: string }): string {
			return user.name;
		}

		/** Age selector. */
		function age(user: { age: number }): number {
			return user.age;
		}

		it('sorts by several keys, each in its own direction', function () {
			expect(helpers.orderBy(users, [age, name], ['desc', 'asc'])).toStrictEqual([users[3], users[2], users[0], users[1]]);
			expect(helpers.orderBy(users, [name, age], ['asc', 'desc'])).toStrictEqual([users[3], users[1], users[2], users[0]]);
		});

		it('applies a single direction to every key, and defaults missing trailing directions to ascending', function () {
			expect(helpers.orderBy(users, [name, age], 'desc')).toStrictEqual([users[0], users[2], users[3], users[1]]);
			expect(helpers.orderBy(users, [name, age], ['desc'])).toStrictEqual([users[0], users[2], users[1], users[3]]);
			expect(helpers.orderBy(users, [name, age])).toStrictEqual([users[1], users[3], users[2], users[0]]);
		});

		it('is stable and never mutates the input', function () {
			const items = [
				{ k: 1, id: 'a' },
				{ k: 0, id: 'b' },
				{ k: 1, id: 'c' },
				{ k: 0, id: 'd' }
			];
			const copy = items.slice();
			const sorted = helpers.orderBy(
				items,
				[
					function (item) {
						return item.k;
					},
					function () {
						return 0;
					}
				],
				'desc'
			);
			expect(
				sorted.map(function (item) {
					return item.id;
				})
			).toStrictEqual(['a', 'c', 'b', 'd']);
			expect(items).toStrictEqual(copy);
		});

		it('ranks NaN, invalid dates, null and undefined keys last in both directions, leaving the next key to decide', function () {
			const items = [
				{ k: 2 as number | null | undefined, t: 1 },
				{ k: NaN, t: 3 },
				{ k: undefined, t: 1 },
				{ k: 1, t: 0 },
				{ k: null, t: 2 }
			];
			/** First key. */
			function k(item: { k: number | null | undefined }): number | null | undefined {
				return item.k;
			}
			/** Second key. */
			function t(item: { t: number }): number {
				return item.t;
			}
			expect(helpers.orderBy(items, [k, t])).toStrictEqual([items[3], items[0], items[2], items[4], items[1]]);
			expect(helpers.orderBy(items, [k, t], ['desc', 'desc'])).toStrictEqual([items[0], items[3], items[1], items[4], items[2]]);
			const dates = [new Date(Number.NaN), new Date(5), new Date(1)];
			expect(
				helpers.orderBy(dates, [
					function (d) {
						return d;
					},
					function () {
						return 0;
					}
				])
			).toStrictEqual([dates[2], dates[1], dates[0]]);
		});

		it('gives a correct order where es-toolkit (NaN) and remeda (undefined) do not', function () {
			expect(helpers.orderBy([2, NaN, 1], [self, self])).toStrictEqual([1, 2, NaN]);
			expect(helpers.orderBy([2, undefined, 1], [self as (n: number | undefined) => number, self as (n: number | undefined) => number])).toStrictEqual([
				1,
				2,
				undefined
			]);
		});

		it('orders mixed key kinds like sortBy (numbers and bigints before strings)', function () {
			const keys: Array<number | bigint | string> = ['b', 3n, 1, 'a', 2];
			/** Identity over mixed keys. */
			function mixed(key: number | bigint | string): number | bigint | string {
				return key;
			}
			expect(helpers.orderBy(keys, [mixed, mixed])).toStrictEqual([1, 2, 3n, 'a', 'b']);
		});

		it('calls each selector exactly once per item, with the item and its index', function () {
			const first = jest.fn(function (n: number) {
				return n % 2;
			});
			const second = jest.fn(self);
			const input = [5, 4, 3, 2, 1, 0, 9, 8, 7, 6];
			expect(helpers.orderBy(input, [first, second])).toStrictEqual([0, 2, 4, 6, 8, 1, 3, 5, 7, 9]);
			expect(first).toHaveBeenCalledTimes(input.length);
			expect(second).toHaveBeenCalledTimes(input.length);
			expect(first).toHaveBeenNthCalledWith(3, 3, 2);
		});

		it('with one selector equals sortBy, and with none returns a copy', function () {
			expect(helpers.orderBy([3, 1, 2], [self], ['desc'])).toStrictEqual([3, 2, 1]);
			expect(helpers.orderBy([3, 1, 2], [self])).toStrictEqual([1, 2, 3]);
			const input = [3, 1, 2];
			const copy = helpers.orderBy(input, []);
			expect(copy).toStrictEqual(input);
			expect(copy).not.toBe(input);
			expect(helpers.orderBy([], [self, self])).toStrictEqual([]);
		});

		it('rejects invalid selectors and directions', function () {
			expect(function () {
				helpers.orderBy([1], self as any);
			}).toThrow(new TypeError('orderBy: `selectors` must be an array of functions, got function'));
			expect(function () {
				helpers.orderBy([1], [self, 1 as any]);
			}).toThrow(new TypeError('orderBy: `selectors[1]` must be a function, got number'));
			expect(function () {
				helpers.orderBy([1], [self], 'up' as any);
			}).toThrow(new RangeError("orderBy: `orders` must be 'asc' or 'desc', got up"));
			expect(function () {
				helpers.orderBy([1], [], 'up' as any);
			}).toThrow(RangeError);
			expect(function () {
				helpers.orderBy([1], [self, self], ['asc', 'down' as any]);
			}).toThrow(new RangeError("orderBy: `orders[1]` must be 'asc' or 'desc', got down"));
			expect(function () {
				helpers.orderBy([1], [self], ['asc', 'asc']);
			}).toThrow(new RangeError('orderBy: `orders` must not be longer than `selectors` (1), got 2 directions'));
			expect(function () {
				helpers.orderBy([1], [self], 1 as any);
			}).toThrow(new TypeError("orderBy: `orders` must be 'asc', 'desc' or an array of them, got number"));
		});
	});

	describe('nullish sort keys in sortBy, minBy and maxBy', function () {
		const items = [{ n: 2 }, {}, { n: null }, { n: 1 }];

		/** Optional key. */
		function n(item: { n?: number | null }): number | null | undefined {
			return item.n;
		}

		it('sortBy puts null and undefined keys last, in input order, in both directions', function () {
			expect(helpers.sortBy(items, n)).toStrictEqual([items[3], items[0], items[1], items[2]]);
			expect(helpers.sortBy(items, n, 'desc')).toStrictEqual([items[0], items[3], items[1], items[2]]);
		});

		it('minBy and maxBy ignore null and undefined keys', function () {
			expect(helpers.minBy(items, n)).toBe(items[3]);
			expect(helpers.maxBy(items, n)).toBe(items[0]);
			expect(helpers.minBy([{}, { n: 'b' }, { n: 'a' }] as Array<{ n?: string }>, n as any)).toStrictEqual({ n: 'a' });
			expect(helpers.maxBy([{}, { n: null }], n)).toBeUndefined();
		});
	});

	describe('takeFirstBy and nthBy', function () {
		const scores = [
			{ id: 'a', score: 7 },
			{ id: 'b', score: 9 },
			{ id: 'c', score: 8 },
			{ id: 'd', score: 9 },
			{ id: 'e', score: 7 }
		];

		/** Score selector. */
		function score(entry: { score: number }): number {
			return entry.score;
		}

		it('takeFirstBy returns the n best ranked items in rank order, ties in input order', function () {
			expect(helpers.takeFirstBy(scores, 3, score, 'desc')).toStrictEqual([scores[1], scores[3], scores[2]]);
			expect(helpers.takeFirstBy(scores, 2, score)).toStrictEqual([scores[0], scores[4]]);
			expect(helpers.takeFirstBy(scores, 10, score)).toStrictEqual(helpers.sortBy(scores, score));
			expect(helpers.takeFirstBy([5, 4, 3, 2, 1, 0, 6, 7, 8, 9], 4, self)).toStrictEqual([0, 1, 2, 3]);
		});

		it('takeFirstBy ranks NaN and nullish keys last', function () {
			expect(helpers.takeFirstBy([NaN, 5, 1, 3], 3, self)).toStrictEqual([1, 3, 5]);
			expect(helpers.takeFirstBy([NaN, 5, 1], 3, self, 'desc')).toStrictEqual([5, 1, NaN]);
			expect(helpers.takeFirstBy([NaN, 2, undefined, 1], 4, self as (n: number | undefined) => number | undefined)).toStrictEqual([1, 2, NaN, undefined]);
		});

		it('takeFirstBy calls the selector once per item, and not at all for n = 0', function () {
			const selector = jest.fn(self);
			expect(helpers.takeFirstBy([3, 1, 2, 5, 4], 2, selector)).toStrictEqual([1, 2]);
			expect(selector).toHaveBeenCalledTimes(5);
			expect(selector).toHaveBeenNthCalledWith(4, 5, 3);
			selector.mockClear();
			expect(helpers.takeFirstBy([3, 1], 0, selector)).toStrictEqual([]);
			expect(selector).not.toHaveBeenCalled();
			expect(helpers.takeFirstBy([], 3, self)).toStrictEqual([]);
		});

		it('takeFirstBy validates its arguments', function () {
			expect(function () {
				helpers.takeFirstBy([1], -1, self);
			}).toThrow(new RangeError('takeFirstBy: `n` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.takeFirstBy([1], 1.5, self);
			}).toThrow(RangeError);
			expect(function () {
				helpers.takeFirstBy([1], '1' as any, self);
			}).toThrow(TypeError);
			expect(function () {
				helpers.takeFirstBy([1], 0, null as any);
			}).toThrow(new TypeError('takeFirstBy: `selector` must be a function, got null'));
			expect(function () {
				helpers.takeFirstBy([1], 0, self, 'up' as any);
			}).toThrow(new RangeError("takeFirstBy: `order` must be 'asc' or 'desc', got up"));
		});

		it('nthBy returns the item at a rank, counting from the end for negative indices', function () {
			const values = [40, 10, 30, 20];
			expect(helpers.nthBy(values, 0, self)).toBe(10);
			expect(helpers.nthBy(values, 2, self)).toBe(30);
			expect(helpers.nthBy(values, 3, self)).toBe(40);
			expect(helpers.nthBy(values, -1, self)).toBe(40);
			expect(helpers.nthBy(values, -4, self)).toBe(10);
			expect(helpers.nthBy(values, 1, self, 'desc')).toBe(30);
			expect(helpers.nthBy(scores, 1, score, 'desc')).toBe(scores[3]);
			expect(helpers.nthBy([NaN, 1], -1, self, 'desc')).toBeNaN();
		});

		it('nthBy returns undefined out of range, but still validates the selector and order', function () {
			expect(helpers.nthBy([1, 2], 2, self)).toBeUndefined();
			expect(helpers.nthBy([1, 2], -3, self)).toBeUndefined();
			expect(helpers.nthBy([], 0, self)).toBeUndefined();
			expect(function () {
				helpers.nthBy([1], 5, 'x' as any);
			}).toThrow(new TypeError('nthBy: `selector` must be a function, got string'));
			expect(function () {
				helpers.nthBy([1], 5, self, 'down' as any);
			}).toThrow(RangeError);
			expect(function () {
				helpers.nthBy([1], 0.5, self);
			}).toThrow(new RangeError('nthBy: `index` must be an integer, got 0.5'));
			expect(function () {
				helpers.nthBy([1], '0' as any, self);
			}).toThrow(new TypeError('nthBy: `index` must be an integer, got string'));
		});
	});

	describe('sortedLastIndex, sortedIndexBy and sortedLastIndexBy', function () {
		it('sortedLastIndex returns the upper bound', function () {
			expect(helpers.sortedLastIndex([10, 20, 20, 30], 20)).toBe(3);
			expect(helpers.sortedLastIndex([10, 20, 30], 5)).toBe(0);
			expect(helpers.sortedLastIndex([10, 20, 30], 99)).toBe(3);
			expect(helpers.sortedLastIndex([], 1)).toBe(0);
			expect(helpers.sortedLastIndex(['a', 'b', 'b'], 'b')).toBe(3);
			expect(
				helpers.sortedLastIndex([{ n: 1 }, { n: 3 }, { n: 3 }, { n: 4 }], { n: 3 }, function (a, b) {
					return a.n - b.n;
				})
			).toBe(3);
		});

		it('sortedLastIndex validates like sortedIndex', function () {
			expect(function () {
				helpers.sortedLastIndex([1, 2], NaN);
			}).toThrow(new RangeError('sortedLastIndex: `value` must not be NaN when no comparator is given, got NaN'));
			expect(function () {
				helpers.sortedLastIndex([1, 2], 1, 'x' as any);
			}).toThrow(new TypeError('sortedLastIndex: `compare` must be a function, got string'));
		});

		const people = [{ age: 20 }, { age: 30 }, { age: 30 }, { age: 40 }];

		/** Age selector. */
		function age(person: { age: number }): number {
			return person.age;
		}

		it('locate a value by its key, before or after the equal keys', function () {
			expect(helpers.sortedIndexBy(people, { age: 30 }, age)).toBe(1);
			expect(helpers.sortedLastIndexBy(people, { age: 30 }, age)).toBe(3);
			expect(helpers.sortedIndexBy(people, { age: 10 }, age)).toBe(0);
			expect(helpers.sortedLastIndexBy(people, { age: 50 }, age)).toBe(4);
			expect(helpers.sortedIndexBy([3, 2, 2, 1], 2, self, 'desc')).toBe(1);
			expect(helpers.sortedLastIndexBy([3, 2, 2, 1], 2, self, 'desc')).toBe(3);
		});

		it('work on arrays sorted by sortBy, including their trailing NaN and nullish keys', function () {
			const sorted = helpers.sortBy([NaN, 3, undefined, 1, 2], self as (n: number | undefined) => number | undefined, 'desc');
			expect(sorted).toStrictEqual([3, 2, 1, NaN, undefined]);
			const select = self as (n: number | undefined) => number | undefined;
			expect(helpers.sortedIndexBy(sorted, 2, select, 'desc')).toBe(1);
			expect(helpers.sortedIndexBy(sorted, 0, select, 'desc')).toBe(3);
			expect(helpers.sortedIndexBy(sorted, NaN, select, 'desc')).toBe(3);
			expect(helpers.sortedLastIndexBy(sorted, undefined, select, 'desc')).toBe(5);
		});

		it('call the selector once for the value and once per probe', function () {
			const selector = jest.fn(self);
			helpers.sortedIndexBy([1, 2, 3, 4, 5, 6, 7], 4, selector);
			expect(selector.mock.calls.length).toBeLessThanOrEqual(1 + 3);
			expect(selector).toHaveBeenNthCalledWith(1, 4);
		});

		it('validate the selector and order', function () {
			expect(function () {
				helpers.sortedIndexBy([1], 1, 1 as any);
			}).toThrow(new TypeError('sortedIndexBy: `selector` must be a function, got number'));
			expect(function () {
				helpers.sortedLastIndexBy([1], 1, self, 'x' as any);
			}).toThrow(new RangeError("sortedLastIndexBy: `order` must be 'asc' or 'desc', got x"));
		});
	});

	describe('takeLast, dropLast, takeLastWhile and dropLastWhile', function () {
		it('takeLast returns the last n items (none for n = 0, unlike slice(-0))', function () {
			expect(helpers.takeLast([1, 2, 3], 2)).toStrictEqual([2, 3]);
			expect(helpers.takeLast([1, 2, 3], 0)).toStrictEqual([]);
			expect(helpers.takeLast([1, 2, 3], 5)).toStrictEqual([1, 2, 3]);
			expect(helpers.takeLast([], 1)).toStrictEqual([]);
		});

		it('dropLast removes the last n items', function () {
			expect(helpers.dropLast([1, 2, 3], 2)).toStrictEqual([1]);
			expect(helpers.dropLast([1, 2, 3], 0)).toStrictEqual([1, 2, 3]);
			expect(helpers.dropLast([1, 2, 3], 5)).toStrictEqual([]);
			const input = [1, 2];
			expect(helpers.dropLast(input, 0)).not.toBe(input);
		});

		it('takeLast and dropLast validate n like take and drop (no silent flooring)', function () {
			expect(function () {
				helpers.takeLast([1, 2, 3], 1.5);
			}).toThrow(new RangeError('takeLast: `n` must be an integer >= 0, got 1.5'));
			expect(function () {
				helpers.dropLast([1, 2, 3], -1);
			}).toThrow(new RangeError('dropLast: `n` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.takeLast([1], '1' as any);
			}).toThrow(TypeError);
		});

		it('takeLastWhile and dropLastWhile split off the longest matching suffix', function () {
			/** Small numbers. */
			function small(n: number): boolean {
				return n < 4;
			}
			expect(helpers.takeLastWhile([1, 5, 2, 3], small)).toStrictEqual([2, 3]);
			expect(helpers.dropLastWhile([1, 5, 2, 3], small)).toStrictEqual([1, 5]);
			expect(helpers.takeLastWhile([1, 2], small)).toStrictEqual([1, 2]);
			expect(helpers.dropLastWhile([1, 2], small)).toStrictEqual([]);
			expect(helpers.takeLastWhile([1, 9], small)).toStrictEqual([]);
			expect(helpers.dropLastWhile([1, 9], small)).toStrictEqual([1, 9]);
			expect(helpers.takeLastWhile([], small)).toStrictEqual([]);
		});

		it('takeLastWhile passes the input index and stops at the first mismatch from the end', function () {
			const predicate = jest.fn(function (n: number) {
				return n > 1;
			});
			expect(helpers.takeLastWhile([5, 1, 3, 4], predicate)).toStrictEqual([3, 4]);
			expect(predicate.mock.calls).toStrictEqual([
				[4, 3],
				[3, 2],
				[1, 1]
			]);
		});

		it('takeLastWhile and dropLastWhile require a function', function () {
			expect(function () {
				helpers.takeLastWhile([1], null as any);
			}).toThrow(new TypeError('takeLastWhile: `predicate` must be a function, got null'));
			expect(function () {
				helpers.dropLastWhile([1], 1 as any);
			}).toThrow(new TypeError('dropLastWhile: `predicate` must be a function, got number'));
		});
	});

	describe('zipObject', function () {
		it('pairs keys with values', function () {
			const symbol = Symbol('s');
			expect(helpers.zipObject(['a', 'b'], [1, 2])).toStrictEqual({ a: 1, b: 2 });
			const mixed = helpers.zipObject([1, symbol], ['x', 'y']);
			expect(mixed[1]).toBe('x');
			expect(mixed[symbol]).toBe('y');
			expect(helpers.zipObject([], [])).toStrictEqual({});
		});

		it('returns a plain object, and the last value wins for a repeated key', function () {
			const result = helpers.zipObject(['a', 'b', 'a'], [1, 2, 3]);
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.entries(result)).toStrictEqual([
				['a', 3],
				['b', 2]
			]);
		});

		it('defines hostile keys as own data properties without touching any prototype', function () {
			const hostile = JSON.parse('{"__proto__":{"x":1},"constructor":{"prototype":{"x":1}}}') as Record<string, unknown>;
			const keys = Object.keys(hostile);
			const result = helpers.zipObject(
				keys,
				keys.map(function (key) {
					return hostile[key];
				})
			);
			expect(Object.keys(result)).toStrictEqual(['__proto__', 'constructor']);
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toStrictEqual({ value: { x: 1 }, writable: true, enumerable: true, configurable: true });
			expect(result.constructor).toStrictEqual({ prototype: { x: 1 } });
			expect((result as any).x).toBeUndefined();
			expect(({} as any).x).toBeUndefined();
			expect((Object.prototype as any).x).toBeUndefined();
			const named = helpers.zipObject(['toString', 'hasOwnProperty'], [1, 2]);
			expect(Object.keys(named)).toStrictEqual(['toString', 'hasOwnProperty']);
		});

		it('rejects arrays of different lengths instead of dropping keys or values', function () {
			expect(function () {
				helpers.zipObject(['a', 'b'], [1]);
			}).toThrow(new RangeError('zipObject: `values` must have as many items as `keys` (2), got 1'));
			expect(function () {
				helpers.zipObject(['a'], [1, 2]);
			}).toThrow(RangeError);
		});

		it('types the result from literal keys', function () {
			const typed: { a: number; b: number } = helpers.zipObject(['a', 'b'], [1, 2]);
			expect(typed.a + typed.b).toBe(3);
		});
	});

	describe('sampleSize', function () {
		it('returns n distinct items driven by the injected generator', function () {
			expect(helpers.sampleSize([1, 2, 3], 3, sequence(0))).toStrictEqual([1, 2, 3]);
			expect(helpers.sampleSize([1, 2, 3, 4], 2, sequence(0.99))).toStrictEqual([4, 1]);
			// Draws 0.5 then 0: position 2 swaps with 0, then position 1 is picked.
			expect(helpers.sampleSize(['a', 'b', 'c', 'd'], 2, sequence(0.5, 0))).toStrictEqual(['c', 'b']);
			expect(helpers.sampleSize(['a', 'b', 'c', 'd'], 3, sequence(0.99, 0.99, 0))).toStrictEqual(['d', 'a', 'c']);
			expect(helpers.sampleSize(['a', 'b', 'c', 'd'], 4, sequence(0, 0.9, 0))).toStrictEqual(['a', 'd', 'c', 'b']);
		});

		it('clamps n to the length and calls random exactly min(n, length) times', function () {
			const random = jest.fn(sequence(0.3));
			expect(helpers.sampleSize([1, 2], 5, random)).toHaveLength(2);
			expect(random).toHaveBeenCalledTimes(2);
			random.mockClear();
			expect(helpers.sampleSize([1, 2], 0, random)).toStrictEqual([]);
			expect(helpers.sampleSize([], 3, random)).toStrictEqual([]);
			expect(random).not.toHaveBeenCalled();
		});

		it('never repeats a position, whatever the array length', function () {
			const values = Array.from({ length: 1000 }, function (_, index) {
				return index;
			});
			const picked = helpers.sampleSize(values, 600);
			expect(new Set(picked).size).toBe(600);
			expect(
				helpers.sampleSize(values, 1000).sort(function (a, b) {
					return a - b;
				})
			).toStrictEqual(values);
		});

		it('is roughly uniform', function () {
			const counts = [0, 0, 0, 0];
			for (let i = 0; i < 4000; i++) for (const value of helpers.sampleSize([0, 1, 2, 3], 2)) counts[value]++;
			for (const count of counts) expect(Math.abs(count - 2000)).toBeLessThan(250);
		});

		it('validates n and the generator', function () {
			expect(function () {
				helpers.sampleSize([1], -1);
			}).toThrow(new RangeError('sampleSize: `n` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.sampleSize([1], 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.sampleSize([1], 1, sequence(1));
			}).toThrow(new RangeError('sampleSize: `random()` must return a number in [0, 1), got 1'));
			expect(function () {
				helpers.sampleSize([1], 1, 'x' as any);
			}).toThrow(new TypeError('sampleSize: `random` must be a function, got string'));
		});
	});

	describe('toArray', function () {
		it('wraps single values, copies arrays and maps nullish values to []', function () {
			expect(helpers.toArray(1)).toStrictEqual([1]);
			expect(helpers.toArray(null)).toStrictEqual([]);
			expect(helpers.toArray(undefined)).toStrictEqual([]);
			expect(helpers.toArray('ab')).toStrictEqual(['ab']);
			const set = new Set([1]);
			expect(helpers.toArray(set)).toStrictEqual([set]);
			expect(helpers.toArray(0)).toStrictEqual([0]);
			expect(helpers.toArray(false)).toStrictEqual([false]);
		});

		it('returns a fresh, typed copy of an array', function () {
			const input: ReadonlyArray<number> = [1, 2];
			const copy: number[] = helpers.toArray(input);
			expect(copy).toStrictEqual([1, 2]);
			expect(copy).not.toBe(input);
			const single: string[] = helpers.toArray<string>('a' as string | undefined);
			expect(single).toStrictEqual(['a']);
		});
	});

	describe('chunkBy and splitWhen', function () {
		it('chunkBy groups adjacent items with the same key', function () {
			expect(
				helpers.chunkBy([1, 3, 2, 4, 5], function (n) {
					return n % 2;
				})
			).toStrictEqual([[1, 3], [2, 4], [5]]);
			expect(
				helpers.chunkBy(['a', 'b', 'a'], function (s) {
					return s;
				})
			).toStrictEqual([['a'], ['b'], ['a']]);
			expect(helpers.chunkBy([], self)).toStrictEqual([]);
		});

		it('chunkBy compares keys with SameValueZero (NaN keys group, unlike es-toolkit)', function () {
			expect(helpers.chunkBy([NaN, NaN, 1], self)).toStrictEqual([[NaN, NaN], [1]]);
			expect(helpers.chunkBy([0, -0, 1], self)).toStrictEqual([[0, -0], [1]]);
			expect(
				helpers.chunkBy([undefined, undefined, 1], function (v) {
					return v;
				})
			).toStrictEqual([[undefined, undefined], [1]]);
		});

		it('chunkBy passes the index and validates keyFn', function () {
			const keyFn = jest.fn(function (_: string, index: number) {
				return index < 2;
			});
			expect(helpers.chunkBy(['a', 'b', 'c'], keyFn)).toStrictEqual([['a', 'b'], ['c']]);
			expect(keyFn).toHaveBeenNthCalledWith(3, 'c', 2);
			expect(function () {
				helpers.chunkBy([1], null as any);
			}).toThrow(new TypeError('chunkBy: `keyFn` must be a function, got null'));
		});

		it('splitWhen splits before the first matching item', function () {
			/** Large numbers. */
			function large(n: number): boolean {
				return n > 2;
			}
			expect(helpers.splitWhen([1, 2, 3, 2], large)).toStrictEqual([
				[1, 2],
				[3, 2]
			]);
			expect(helpers.splitWhen([3, 1], large)).toStrictEqual([[], [3, 1]]);
			expect(helpers.splitWhen([1, 2], large)).toStrictEqual([[1, 2], []]);
			expect(helpers.splitWhen([], large)).toStrictEqual([[], []]);
		});

		it('splitWhen passes the index, stops at the first match and validates the predicate', function () {
			const predicate = jest.fn(function (_: string, index: number) {
				return index === 1;
			});
			expect(helpers.splitWhen(['a', 'b', 'c'], predicate)).toStrictEqual([['a'], ['b', 'c']]);
			expect(predicate).toHaveBeenCalledTimes(2);
			expect(function () {
				helpers.splitWhen([1], 1 as any);
			}).toThrow(new TypeError('splitWhen: `predicate` must be a function, got number'));
		});
	});

	describe('unionBy, symmetricDifferenceBy and the comparator-based set operations', function () {
		it('unionBy keeps the first item per key, a before b', function () {
			expect(helpers.unionBy([{ id: 1 }, { id: 2, v: 'a' }], [{ id: 2, v: 'b' }, { id: 3 }], byId)).toStrictEqual([{ id: 1 }, { id: 2, v: 'a' }, { id: 3 }]);
			expect(helpers.unionBy([1.2, 2.5, 1.9], [2.1, 3.4], Math.floor)).toStrictEqual([1.2, 2.5, 3.4]);
			expect(helpers.unionBy([NaN], [NaN, 1], self)).toStrictEqual([NaN, 1]);
			expect(helpers.unionBy(once(1, 1), once(2), self)).toStrictEqual([1, 2]);
		});

		it('unionBy calls keyFn with the item only', function () {
			const keyFn = jest.fn(self);
			helpers.unionBy([1], [2], keyFn);
			expect(keyFn.mock.calls).toStrictEqual([[1], [2]]);
		});

		it('symmetricDifferenceBy keeps the items whose key is in exactly one input', function () {
			expect(helpers.symmetricDifferenceBy([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], byId)).toStrictEqual([{ id: 1 }, { id: 3 }]);
			expect(helpers.symmetricDifferenceBy([1.1, 1.5, 2.2], [2.9, 3.1, 3.2], Math.floor)).toStrictEqual([1.1, 3.1]);
			expect(helpers.symmetricDifferenceBy(once(1, 2), once(2, 3), self)).toStrictEqual([1, 3]);
			const keyFn = jest.fn(self);
			helpers.symmetricDifferenceBy([1, 2], [3], keyFn);
			expect(keyFn).toHaveBeenCalledTimes(3);
		});

		it('uniqueWith keeps the first of equal items', function () {
			const near = jest.fn(function (x: number, y: number) {
				return Math.abs(x - y) < 0.2;
			});
			expect(helpers.uniqueWith([1, 1.05, 2, 1.9], near)).toStrictEqual([1, 2]);
			expect(near).toHaveBeenNthCalledWith(1, 1.05, 1);
			expect(helpers.uniqueWith(once(NaN, NaN, 0, -0), same)).toStrictEqual([NaN, 0]);
		});

		it('unionWith keeps the distinct items of a then b', function () {
			/** Point equality. */
			function samePoint(p: { x: number }, q: { x: number }): boolean {
				return p.x === q.x;
			}
			expect(helpers.unionWith([{ x: 1 }, { x: 1 }], [{ x: 1 }, { x: 2 }], samePoint)).toStrictEqual([{ x: 1 }, { x: 2 }]);
			expect(helpers.unionWith(once(1), once(2, 1), same)).toStrictEqual([1, 2]);
		});

		it('differenceWith keeps the distinct items of a without an equal in b', function () {
			const equals = jest.fn(function (p: { x: number }, q: { x: number }) {
				return p.x === q.x;
			});
			expect(helpers.differenceWith([{ x: 1 }, { x: 2 }, { x: 1 }], [{ x: 2 }], equals)).toStrictEqual([{ x: 1 }]);
			expect(equals.mock.calls[0]).toStrictEqual([{ x: 1 }, { x: 2 }]);
			expect(helpers.differenceWith(once(1, 2, 3), once(2), same)).toStrictEqual([1, 3]);
		});

		it('intersectionWith keeps the distinct items of a with an equal in b', function () {
			const equals = jest.fn(function (p: { x: number }, q: { x: number }) {
				return p.x === q.x;
			});
			expect(helpers.intersectionWith([{ x: 1 }, { x: 2 }, { x: 2 }], [{ x: 2 }, { x: 3 }], equals)).toStrictEqual([{ x: 2 }]);
			expect(equals.mock.calls[0]).toStrictEqual([{ x: 1 }, { x: 2 }]);
			expect(helpers.intersectionWith(once(1, 2, 3), once(3, 2), same)).toStrictEqual([2, 3]);
		});

		it('all validate their function argument', function () {
			expect(function () {
				helpers.unionBy([], [], null as any);
			}).toThrow(new TypeError('unionBy: `keyFn` must be a function, got null'));
			expect(function () {
				helpers.symmetricDifferenceBy([], [], null as any);
			}).toThrow(new TypeError('symmetricDifferenceBy: `keyFn` must be a function, got null'));
			expect(function () {
				helpers.uniqueWith([], 1 as any);
			}).toThrow(new TypeError('uniqueWith: `equals` must be a function, got number'));
			expect(function () {
				helpers.unionWith([], [], 1 as any);
			}).toThrow(new TypeError('unionWith: `equals` must be a function, got number'));
			expect(function () {
				helpers.differenceWith([], [], 1 as any);
			}).toThrow(new TypeError('differenceWith: `equals` must be a function, got number'));
			expect(function () {
				helpers.intersectionWith([], [], 1 as any);
			}).toThrow(new TypeError('intersectionWith: `equals` must be a function, got number'));
		});
	});

	describe('toggle', function () {
		it('removes a present item or appends a missing one, without mutating', function () {
			const input = ['a', 'b'];
			expect(helpers.toggle(input, 'b')).toStrictEqual(['a']);
			expect(helpers.toggle(input, 'c')).toStrictEqual(['a', 'b', 'c']);
			expect(input).toStrictEqual(['a', 'b']);
			expect(helpers.toggle([], 1)).toStrictEqual([1]);
		});

		it('uses SameValueZero and removes every match', function () {
			expect(helpers.toggle([NaN, 1], NaN)).toStrictEqual([1]);
			expect(helpers.toggle([0, 1], -0)).toStrictEqual([1]);
			expect(helpers.toggle([1, 2, 1], 1)).toStrictEqual([2]);
		});

		it('compares keys when given a keyFn', function () {
			const keyFn = jest.fn(byId);
			expect(helpers.toggle([{ id: 1 }, { id: 2 }], { id: 1 }, keyFn)).toStrictEqual([{ id: 2 }]);
			expect(keyFn).toHaveBeenCalledTimes(3);
			expect(helpers.toggle([{ id: 1 }], { id: 3 }, byId)).toStrictEqual([{ id: 1 }, { id: 3 }]);
			expect(function () {
				helpers.toggle([1], 1, 1 as any);
			}).toThrow(new TypeError('toggle: `keyFn` must be a function, got number'));
		});
	});

	describe('averageBy and medianBy', function () {
		/** Value selector. */
		function value(item: { n: number }): number {
			return item.n;
		}

		it('averageBy uses compensated summation', function () {
			expect(helpers.averageBy([{ n: 0.1 }, { n: 0.2 }, { n: 0.3 }], value)).toBe(0.2);
			expect(helpers.averageBy([1, 2, 3, 4], self)).toBe(2.5);
			expect(helpers.averageBy([1e308, 1e308], self)).toBe(Infinity);
			expect(helpers.averageBy([1, NaN], self)).toBeNaN();
			expect(helpers.averageBy(['1', '2'] as any[], self)).toBe(1.5);
		});

		it('averageBy is NaN for an empty array, and sumBy is unchanged', function () {
			expect(helpers.averageBy([], self)).toBeNaN();
			expect(helpers.sumBy([], self)).toBe(0);
			expect(helpers.sumBy([0.1, 0.2, 0.3], self)).toBe(0.6);
		});

		it('medianBy matches math.median', function () {
			expect(helpers.medianBy([{ n: 30 }, { n: 20 }, { n: 50 }], value)).toBe(30);
			expect(helpers.medianBy([4, 1, 3, 2], self)).toBe(2.5);
			expect(helpers.medianBy([], self)).toBeNaN();
			expect(helpers.medianBy([1, NaN, 2], self)).toBeNaN();
			const selector = jest.fn(self);
			helpers.medianBy([5, 6], selector);
			expect(selector).toHaveBeenNthCalledWith(2, 6, 1);
		});

		it('both validate the selector', function () {
			expect(function () {
				helpers.averageBy([1], null as any);
			}).toThrow(new TypeError('averageBy: `selector` must be a function, got null'));
			expect(function () {
				helpers.medianBy([1], null as any);
			}).toThrow(new TypeError('medianBy: `selector` must be a function, got null'));
		});
	});

	describe('combinations, permutations and powerSet', function () {
		it('combinations lists the k-subsets of positions in lexicographic order', function () {
			expect(helpers.combinations(['a', 'b', 'c'], 2)).toStrictEqual([
				['a', 'b'],
				['a', 'c'],
				['b', 'c']
			]);
			expect(helpers.combinations([1, 2, 3, 4], 3)).toStrictEqual([
				[1, 2, 3],
				[1, 2, 4],
				[1, 3, 4],
				[2, 3, 4]
			]);
			expect(helpers.combinations([1, 2], 0)).toStrictEqual([[]]);
			expect(helpers.combinations([1, 2], 2)).toStrictEqual([[1, 2]]);
			expect(helpers.combinations([1, 2], 3)).toStrictEqual([]);
			expect(helpers.combinations([], 0)).toStrictEqual([[]]);
			expect(helpers.combinations([1, 1], 1)).toStrictEqual([[1], [1]]);
		});

		it('permutations lists the arrangements of positions in lexicographic order', function () {
			expect(helpers.permutations([1, 2, 3])).toStrictEqual([
				[1, 2, 3],
				[1, 3, 2],
				[2, 1, 3],
				[2, 3, 1],
				[3, 1, 2],
				[3, 2, 1]
			]);
			expect(helpers.permutations(['a', 'b', 'c'], 1)).toStrictEqual([['a'], ['b'], ['c']]);
			expect(helpers.permutations([1, 2], 0)).toStrictEqual([[]]);
			expect(helpers.permutations([], 0)).toStrictEqual([[]]);
			expect(helpers.permutations([])).toStrictEqual([[]]);
			expect(helpers.permutations([1, 2], 3)).toStrictEqual([]);
		});

		it('powerSet lists every subset in binary-counting order', function () {
			expect(helpers.powerSet(['a', 'b', 'c'])).toStrictEqual([[], ['a'], ['b'], ['a', 'b'], ['c'], ['a', 'c'], ['b', 'c'], ['a', 'b', 'c']]);
			expect(helpers.powerSet([])).toStrictEqual([[]]);
		});

		it('reject results larger than arrays can hold before allocating them', function () {
			expect(function () {
				helpers.combinations(new Array(100_000), 3);
			}).toThrow(RangeError);
			expect(function () {
				helpers.combinations(new Array(66_000), 2);
			}).toThrow(new RangeError('combinations: the result would contain 2177967000 tuples holding 4355934000 items, more than 2 ** 32 - 1'));
			expect(function () {
				helpers.permutations(new Array(20));
			}).toThrow(RangeError);
			expect(function () {
				helpers.permutations(new Array(70_000), 2);
			}).toThrow(new RangeError('permutations: the result would contain 4899930000 tuples holding 9799860000 items, more than 2 ** 32 - 1'));
			expect(function () {
				helpers.powerSet(new Array(29));
			}).toThrow(new RangeError('powerSet: the result would contain 536870912 tuples holding 7784628224 items, more than 2 ** 32 - 1'));
		});

		it('validate k', function () {
			expect(function () {
				helpers.combinations([1], -1);
			}).toThrow(new RangeError('combinations: `k` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.permutations([1], 1.5);
			}).toThrow(new RangeError('permutations: `k` must be an integer >= 0, got 1.5'));
			expect(function () {
				helpers.combinations([1], '1' as any);
			}).toThrow(TypeError);
		});
	});

	describe('zipWith', function () {
		it('combines arrays element-wise, truncating to the shortest (unlike lodash, which pads)', function () {
			expect(
				helpers.zipWith(
					function (a, b) {
						return a + b;
					},
					[1, 2, 3],
					[10, 20]
				)
			).toStrictEqual([11, 22]);
			const labels: string[] = helpers.zipWith(
				function (name, age, active) {
					return `${name}:${age}:${active}`;
				},
				['al', 'bo'],
				[30, 25],
				[true, false]
			);
			expect(labels).toStrictEqual(['al:30:true', 'bo:25:false']);
			expect(helpers.zipWith(self, [1, 2])).toStrictEqual([1, 2]);
			expect(helpers.zipWith(self, [], [1])).toStrictEqual([]);
		});

		it('returns [] without arrays and validates fn', function () {
			const fn = jest.fn();
			expect(helpers.zipWith(fn)).toStrictEqual([]);
			expect(fn).not.toHaveBeenCalled();
			expect(function () {
				helpers.zipWith(null as any, [1]);
			}).toThrow(new TypeError('zipWith: `fn` must be a function, got null'));
		});
	});

	describe('swap and rotate', function () {
		it('swap exchanges two items of a copy, with negative indices', function () {
			const input = ['a', 'b', 'c'];
			expect(helpers.swap(input, 0, 2)).toStrictEqual(['c', 'b', 'a']);
			expect(helpers.swap(input, 0, -2)).toStrictEqual(['b', 'a', 'c']);
			expect(helpers.swap(input, 1, 1)).toStrictEqual(['a', 'b', 'c']);
			expect(input).toStrictEqual(['a', 'b', 'c']);
		});

		it('swap rejects out-of-range indices', function () {
			expect(function () {
				helpers.swap([1, 2], 0, 2);
			}).toThrow(new RangeError('swap: `j` must be an integer in [-2, 1], got 2'));
			expect(function () {
				helpers.swap([1, 2], -3, 0);
			}).toThrow(new RangeError('swap: `i` must be an integer in [-2, 1], got -3'));
			expect(function () {
				helpers.swap([], 0, 0);
			}).toThrow(new RangeError('swap: `i` must be a valid index, but the array is empty, got 0'));
		});

		it('rotate moves items towards the end for positive k, towards the start for negative k', function () {
			expect(helpers.rotate([1, 2, 3, 4], 1)).toStrictEqual([4, 1, 2, 3]);
			expect(helpers.rotate([1, 2, 3, 4], -1)).toStrictEqual([2, 3, 4, 1]);
			expect(helpers.rotate([1, 2, 3], 7)).toStrictEqual([3, 1, 2]);
			expect(helpers.rotate([1, 2, 3], -7)).toStrictEqual([2, 3, 1]);
			expect(helpers.rotate([1, 2, 3], 3)).toStrictEqual([1, 2, 3]);
			expect(helpers.rotate([1, 2, 3], 0)).toStrictEqual([1, 2, 3]);
			expect(helpers.rotate([], 5)).toStrictEqual([]);
		});

		it('rotate requires an integer k', function () {
			expect(function () {
				helpers.rotate([1], 1.5);
			}).toThrow(new RangeError('rotate: `k` must be an integer, got 1.5'));
			expect(function () {
				helpers.rotate([1], Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.rotate([1], '1' as any);
			}).toThrow(new TypeError('rotate: `k` must be an integer, got string'));
		});
	});
});
