// The conventions mandate the default import; fast-check's members are also named exports, which this rule flags.
import fc from 'fast-check';
import * as helpers from '.';

/** Small integers so that duplicates and overlaps between inputs are frequent. */
const smallInt = fc.integer({ min: -8, max: 8 });
const smallInts = fc.array(smallInt, { maxLength: 30 });

/** Arbitrarily nested arrays of integers. */
const { tree } = fc.letrec<{ tree: unknown }>(function (tie) {
	return {
		tree: fc.oneof({ depthSize: 'small', withCrossShrink: true }, fc.integer(), fc.array(tie('tree'), { maxLength: 4 }))
	};
});
const nestedArray = fc.array(tree, { maxLength: 6 });

/** A generator of floats in [0, 1) driven by fast-check, so failing cases shrink and replay. */
const randomStream = fc.infiniteStream(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }));

/**
 * Wraps a fast-check stream into a `random()`-compatible function.
 */
function fromStream(stream: Iterator<number>): () => number {
	return function () {
		return stream.next().value;
	};
}

/**
 * Seeded PRNG (mulberry32) returning floats in [0, 1).
 */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return function () {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Naive O(n²) reference implementation of deduplication. */
function naiveUnique<T>(values: T[]): T[] {
	return values.filter(function (value, index) {
		return values.indexOf(value) === index;
	});
}

function sortedNumbers(values: number[]): number[] {
	return [...values].sort(function (a, b) {
		return a - b;
	});
}

/**
 * Reference O(n·m) dynamic-programming LCS length (SameValueZero equality, like the default of diffSequences).
 */
function lcsLength(a: readonly number[], b: readonly number[]): number {
	let previous = new Array<number>(b.length + 1).fill(0);
	for (const x of a) {
		const current = [0];
		b.forEach(function (y, j) {
			current.push(x === y ? previous[j] + 1 : Math.max(previous[j + 1], current[j]));
		});
		previous = current;
	}
	return previous[b.length];
}

/**
 * Whether `sub` is a subsequence of `sequence`.
 */
function isSubsequence(sub: readonly number[], sequence: readonly number[]): boolean {
	let i = 0;
	for (const value of sequence) if (i < sub.length && sub[i] === value) i++;
	return i === sub.length;
}

/** Small-alphabet sequences, so that the inputs share many elements. */
const diffInput = fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 40 });

describe('arrays (property-based)', function () {
	it('contains agrees with a SameValueZero reference', function () {
		fc.assert(
			fc.property(fc.array(fc.oneof(smallInt, fc.constant(NaN))), fc.oneof(smallInt, fc.constant(NaN)), function (array, value) {
				const expected = array.some(function (item) {
					return item === value || (Number.isNaN(item) && Number.isNaN(value));
				});
				expect(helpers.contains(array, value)).toBe(expected);
			})
		);
	});

	it('first and last agree with direct indexing', function () {
		fc.assert(
			fc.property(smallInts, function (array) {
				expect(helpers.first(array)).toBe(array[0]);
				expect(helpers.last(array)).toBe(array.at(-1));
			})
		);
	});

	it('removeDuplicates is idempotent, preserves membership and matches the naive reference', function () {
		fc.assert(
			fc.property(smallInts, function (array) {
				const unique = helpers.removeDuplicates(array);
				expect(helpers.removeDuplicates(unique)).toStrictEqual(unique);
				expect(unique).toStrictEqual(naiveUnique(array));
				expect(new Set(unique).size).toBe(unique.length);
				for (const value of array) expect(unique).toContain(value);
			})
		);
	});

	it('removeDuplicates keeps the first of each SameValueZero class (short and long inputs alike, -0 and NaN included)', function () {
		const value = fc.oneof(fc.integer({ min: -4, max: 4 }), fc.constantFrom(-0, NaN, 'a', 'b', undefined));
		fc.assert(
			fc.property(fc.array(value, { maxLength: 60 }), function (array) {
				const expected: unknown[] = [];
				for (const item of array) {
					if (
						!expected.some(function (kept) {
							return kept === item || (kept !== kept && item !== item);
						})
					) {
						expected.push(item);
					}
				}
				expect(helpers.removeDuplicates(array)).toStrictEqual(expected);
				expect(helpers.removeDuplicates(new Set(array).values())).toHaveLength(expected.length);
			})
		);
	});

	it('union, intersection and difference match naive references', function () {
		fc.assert(
			fc.property(smallInts, smallInts, function (a, b) {
				expect(helpers.union(a, b)).toStrictEqual(naiveUnique([...a, ...b]));
				expect(helpers.intersection(a, b)).toStrictEqual(
					naiveUnique(a).filter(function (value) {
						return b.includes(value);
					})
				);
				expect(helpers.difference(a, b)).toStrictEqual(
					naiveUnique(a).filter(function (value) {
						return !b.includes(value);
					})
				);
			})
		);
	});

	it('set operations satisfy the set-algebra laws', function () {
		fc.assert(
			fc.property(smallInts, smallInts, function (a, b) {
				const union = helpers.union(a, b);
				const inter = helpers.intersection(a, b);
				const diff = helpers.difference(a, b);
				const symDiff = helpers.symmetricDifference(a, b);

				// Commutativity (as sets).
				expect(sortedNumbers(union)).toStrictEqual(sortedNumbers(helpers.union(b, a)));
				expect(sortedNumbers(inter)).toStrictEqual(sortedNumbers(helpers.intersection(b, a)));
				expect(sortedNumbers(symDiff)).toStrictEqual(sortedNumbers(helpers.symmetricDifference(b, a)));

				// Bounds and disjointness.
				expect(helpers.isSubset(inter, a) && helpers.isSubset(inter, b)).toBe(true);
				expect(helpers.isSubset(a, union) && helpers.isSubset(b, union)).toBe(true);
				expect(helpers.intersection(diff, b)).toStrictEqual([]);

				// Partition of the union: |A ∪ B| = |A − B| + |A ∩ B| + |B − A|.
				expect(union.length).toBe(diff.length + inter.length + helpers.difference(b, a).length);

				// Symmetric difference = (A ∪ B) − (A ∩ B), in order (A − B) ++ (B − A).
				expect(sortedNumbers(symDiff)).toStrictEqual(sortedNumbers(helpers.difference(union, inter)));
				expect(symDiff).toStrictEqual([...diff, ...helpers.difference(b, a)]);

				// Every result is duplicate-free.
				for (const result of [union, inter, diff, symDiff]) expect(new Set(result).size).toBe(result.length);
			})
		);
	});

	it('set operations agree on short arrays (scanned) and other iterables (hashed)', function () {
		const value = fc.oneof(smallInt, fc.constantFrom(-0, NaN));
		const values = fc.array(value, { maxLength: 24 });
		function floorKey(item: number): number {
			return Math.floor(item / 2);
		}
		fc.assert(
			fc.property(values, values, function (a, b) {
				expect(helpers.union(a, b)).toStrictEqual(helpers.union(a.values(), b.values()));
				expect(helpers.intersection(a, b)).toStrictEqual(helpers.intersection(a.values(), b.values()));
				expect(helpers.difference(a, b)).toStrictEqual(helpers.difference(a.values(), b.values()));
				expect(helpers.isSubset(a, b)).toBe(helpers.isSubset(a.values(), b.values()));
				expect(helpers.differenceBy(a, b, floorKey)).toStrictEqual(helpers.differenceBy(a.values(), b, floorKey));
				expect(helpers.symmetricDifference(a, b)).toStrictEqual([...helpers.difference(a.values(), b), ...helpers.difference(b.values(), a)]);
			})
		);
	});

	it('isSubset holds exactly when the difference is empty', function () {
		fc.assert(
			fc.property(smallInts, smallInts, function (a, b) {
				expect(helpers.isSubset(a, b)).toBe(helpers.difference(a, b).length === 0);
				expect(helpers.isSubset(a, a)).toBe(true);
			})
		);
	});

	it('chunk round-trips through flat and respects the size bounds', function () {
		fc.assert(
			fc.property(fc.array(fc.integer(), { maxLength: 50 }), fc.integer({ min: 1, max: 12 }), function (array, size) {
				const chunks = helpers.chunk(array, size);
				expect(chunks.flat()).toStrictEqual(array);
				expect(chunks.length).toBe(Math.ceil(array.length / size));
				chunks.forEach(function (part, index) {
					expect(part.length).toBeGreaterThan(0);
					if (index < chunks.length - 1) expect(part.length).toBe(size);
					else expect(part.length).toBeLessThanOrEqual(size);
				});
			})
		);
	});

	it('flatten and flattenDeep agree with Array.prototype.flat', function () {
		fc.assert(
			fc.property(nestedArray, function (array) {
				expect(helpers.flatten(array)).toStrictEqual(array.flat());
				expect(helpers.flattenDeep(array)).toStrictEqual(array.flat(Infinity));
			})
		);
	});

	it('flattenDeep is idempotent and yields no arrays', function () {
		fc.assert(
			fc.property(nestedArray, function (array) {
				const flat = helpers.flattenDeep(array);
				expect(helpers.flattenDeep(flat)).toStrictEqual(flat);
				expect(flat.some(Array.isArray)).toBe(false);
			})
		);
	});

	it('compact removes exactly the falsy values', function () {
		const falsy = fc.constantFrom<unknown>(false, null, undefined, 0, -0, NaN, '', 0n);
		fc.assert(
			fc.property(fc.array(fc.oneof(falsy, fc.anything())), function (array) {
				const result = helpers.compact(array);
				expect(result.every(Boolean)).toBe(true);
				expect(result).toStrictEqual(array.filter(Boolean));
				expect(helpers.compact(result)).toStrictEqual(result);
			})
		);
	});

	it('range has length max(0, ceil((end - start) / step)) and evenly spaced values', function () {
		const step = fc.integer({ min: -10, max: 10 }).filter(function (n) {
			return n !== 0;
		});
		fc.assert(
			fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }), step, function (start, end, s) {
				const values = helpers.range(start, end, s);
				expect(values.length).toBe(Math.max(0, Math.ceil((end - start) / s)));
				values.forEach(function (value, index) {
					expect(value).toBe(start + index * s);
					expect(s > 0 ? value < end : value > end).toBe(true);
				});
			})
		);
	});

	it('range with one argument equals range(0, end)', function () {
		fc.assert(
			fc.property(fc.integer({ min: -50, max: 200 }), function (end) {
				expect(helpers.range(end)).toStrictEqual(helpers.range(0, end, 1));
			})
		);
	});

	it('zip truncates to the shortest input and keeps elements aligned', function () {
		fc.assert(
			fc.property(smallInts, fc.array(fc.string(), { maxLength: 30 }), fc.array(fc.boolean(), { maxLength: 30 }), function (a, b, c) {
				const zipped = helpers.zip(a, b, c);
				expect(zipped.length).toBe(Math.min(a.length, b.length, c.length));
				zipped.forEach(function (tuple, index) {
					expect(tuple).toStrictEqual([a[index], b[index], c[index]]);
				});
			})
		);
	});

	it('partition splits into the filter and its complement, preserving relative order', function () {
		fc.assert(
			fc.property(smallInts, smallInt, function (array, pivot) {
				function predicate(value: number): boolean {
					return value < pivot;
				}
				const [pass, fail] = helpers.partition(array, predicate);
				expect(pass).toStrictEqual(array.filter(predicate));
				expect(fail).toStrictEqual(
					array.filter(function (value) {
						return !predicate(value);
					})
				);
				expect(sortedNumbers([...pass, ...fail])).toStrictEqual(sortedNumbers(array));
			})
		);
	});

	it('groupBy, countBy and keyBy are consistent with filtering by key', function () {
		const keys = ['a', 'b', '__proto__', 'constructor', 'toString'];
		fc.assert(
			fc.property(fc.array(fc.record({ key: fc.constantFrom(...keys), value: fc.integer() }), { maxLength: 30 }), function (items) {
				function keyOf(item: { key: string }): string {
					return item.key;
				}
				const groups = helpers.groupBy(items, keyOf);
				const counts = helpers.countBy(items, keyOf);
				const index = helpers.keyBy(items, keyOf);
				const present = naiveUnique(items.map(keyOf));

				expect(Object.keys(groups).sort()).toStrictEqual([...present].sort());
				let total = 0;
				for (const key of present) {
					const expected = items.filter(function (item) {
						return item.key === key;
					});
					expect(groups[key]).toStrictEqual(expected);
					expect(counts[key]).toBe(expected.length);
					expect(index[key]).toBe(expected[expected.length - 1]);
					total += expected.length;
				}
				expect(total).toBe(items.length);
				// No pollution of the global prototype.
				expect(Object.getPrototypeOf({})).toBe(Object.prototype);
				expect(({} as any).a).toBeUndefined();
			})
		);
	});

	it('uniqueBy keeps exactly the first item of each key', function () {
		fc.assert(
			fc.property(fc.array(fc.record({ key: smallInt, id: fc.nat() }), { maxLength: 30 }), function (items) {
				function keyOf(item: { key: number }): number {
					return item.key;
				}
				const unique = helpers.uniqueBy(items, keyOf);
				expect(unique.map(keyOf)).toStrictEqual(naiveUnique(items.map(keyOf)));
				for (const item of unique) {
					expect(
						items.find(function (candidate) {
							return candidate.key === item.key;
						})
					).toBe(item);
				}
				expect(helpers.uniqueBy(items.map(keyOf), Number)).toStrictEqual(helpers.removeDuplicates(items.map(keyOf)));
			})
		);
	});

	it('sortBy returns a sorted, stable permutation and does not mutate its input', function () {
		fc.assert(
			fc.property(fc.array(smallInt, { maxLength: 40 }), fc.constantFrom<'asc' | 'desc'>('asc', 'desc'), function (keys, order) {
				const items = keys.map(function (key, id) {
					return { key, id };
				});
				const snapshot = items.slice();
				const sorted = helpers.sortBy(
					items,
					function (item) {
						return item.key;
					},
					order
				);
				expect(items).toStrictEqual(snapshot);
				expect(
					sorted
						.map(function (item) {
							return item.id;
						})
						.sort(function (a, b) {
							return a - b;
						})
				).toStrictEqual(
					items.map(function (item) {
						return item.id;
					})
				);
				for (let i = 1; i < sorted.length; i++) {
					const previous = sorted[i - 1];
					const current = sorted[i];
					if (previous.key === current.key) expect(previous.id).toBeLessThan(current.id);
					else expect(order === 'asc' ? previous.key < current.key : previous.key > current.key).toBe(true);
				}
			})
		);
	});

	it('sortBy on strings matches a code-unit reference sort', function () {
		fc.assert(
			fc.property(fc.array(fc.string({ unit: 'binary', maxLength: 4 }), { maxLength: 30 }), function (strings) {
				const expected = [...strings].sort(function (a, b) {
					return a < b ? -1 : a > b ? 1 : 0;
				});
				expect(helpers.sortBy(strings, String)).toStrictEqual(expected);
			})
		);
	});

	it('shuffle returns a permutation of its input without mutating it', function () {
		fc.assert(
			fc.property(fc.array(fc.integer(), { maxLength: 40 }), randomStream, function (array, stream) {
				const snapshot = array.slice();
				const shuffled = helpers.shuffle(array, fromStream(stream));
				expect(array).toStrictEqual(snapshot);
				expect(sortedNumbers(shuffled)).toStrictEqual(sortedNumbers(array));
			})
		);
	});

	it('shuffle and sample are deterministic for a given generator', function () {
		fc.assert(
			fc.property(fc.array(fc.integer(), { maxLength: 40 }), fc.integer(), function (array, seed) {
				expect(helpers.shuffle(array, seeded(seed))).toStrictEqual(helpers.shuffle(array, seeded(seed)));
				const picked = helpers.sample(array, seeded(seed));
				expect(picked).toBe(helpers.sample(array, seeded(seed)));
				if (array.length > 0) expect(array).toContain(picked);
				else expect(picked).toBeUndefined();
			})
		);
	});

	it('take(n) ++ drop(n) reconstructs the input', function () {
		fc.assert(
			fc.property(smallInts, fc.nat({ max: 40 }), function (array, n) {
				const head = helpers.take(array, n);
				const tail = helpers.drop(array, n);
				expect([...head, ...tail]).toStrictEqual(array);
				expect(head.length).toBe(Math.min(n, array.length));
			})
		);
	});

	it('range never reaches the exclusive end and matches the exact rational count', function () {
		// start = a / 10, end = b / 10, step = s / 10: the exact count is ceil((b - a) / s), which floats must reproduce.
		const tenth = fc.integer({ min: -200, max: 200 });
		const tenthStep = fc.integer({ min: -30, max: 30 }).filter(function (s) {
			return s !== 0;
		});
		fc.assert(
			fc.property(tenth, tenth, tenthStep, function (a, b, s) {
				const values = helpers.range(a / 10, b / 10, s / 10);
				expect(values).toHaveLength(Math.max(0, Math.ceil((b - a) / s)));
				for (const value of values) {
					if (s > 0) expect(value).toBeLessThan(b / 10);
					else expect(value).toBeGreaterThan(b / 10);
				}
			})
		);
	});

	describe('round 2 helpers', function () {
		it('unzip inverts zip for equal-length, non-empty arrays', function () {
			const columns = fc.integer({ min: 1, max: 12 }).chain(function (length) {
				return fc.tuple(
					fc.array(smallInt, { minLength: length, maxLength: length }),
					fc.array(fc.string(), { minLength: length, maxLength: length }),
					fc.array(fc.boolean(), { minLength: length, maxLength: length })
				);
			});
			fc.assert(
				fc.property(columns, function ([numbers, strings, booleans]) {
					expect(helpers.unzip(helpers.zip(numbers, strings, booleans))).toStrictEqual([numbers, strings, booleans]);
				})
			);
		});

		it('zip(...unzip(tuples)) gives the tuples back', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(smallInt, fc.string()), { minLength: 1, maxLength: 12 }), function (tuples) {
					const [numbers = [], strings = []] = helpers.unzip(tuples);
					expect(helpers.zip(numbers, strings)).toStrictEqual(tuples);
				})
			);
		});

		it('windowed returns the expected number of contiguous slices', function () {
			fc.assert(
				fc.property(smallInts, fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 8 }), function (array, size, step) {
					const windows = helpers.windowed(array, size, step);
					expect(windows).toHaveLength(Math.max(0, Math.floor((array.length - size) / step) + 1));
					windows.forEach(function (window, index) {
						expect(window).toStrictEqual(array.slice(index * step, index * step + size));
					});
				})
			);
		});

		it('pairwise equals windowed(array, 2) as tuples', function () {
			fc.assert(
				fc.property(smallInts, function (array) {
					expect(helpers.pairwise(array)).toStrictEqual(helpers.windowed(array, 2));
				})
			);
		});

		it('minBy / maxBy agree with the first item of sortBy ascending / descending', function () {
			const key = fc.oneof(smallInt, fc.constant(NaN), fc.string({ maxLength: 2 }));
			const items = fc.array(fc.record({ key, id: fc.nat() }), { maxLength: 20 });
			fc.assert(
				fc.property(items, function (array) {
					function selector(item: { key: number | string }): number | string {
						return item.key;
					}
					const valid = array.filter(function (item) {
						return !Number.isNaN(item.key);
					});
					expect(helpers.minBy(array, selector)).toBe(helpers.sortBy(valid, selector)[0]);
					expect(helpers.maxBy(array, selector)).toBe(helpers.sortBy(valid, selector, 'desc')[0]);
				})
			);
		});

		it('sumBy equals sum of the mapped integers', function () {
			fc.assert(
				fc.property(fc.array(fc.integer({ min: -1e6, max: 1e6 })), function (array) {
					const expected = array.reduce(function (total, value) {
						return total + value * 3;
					}, 0);
					expect(
						helpers.sumBy(array, function (value) {
							return value * 3;
						})
					).toBe(expected);
				})
			);
		});

		/** Arrays with a valid (possibly negative) index into them. */
		const withIndex = fc.array(smallInt, { minLength: 1, maxLength: 20 }).chain(function (array) {
			const index = fc.integer({ min: -array.length, max: array.length - 1 });
			return fc.tuple(fc.constant(array), index, index);
		});

		it('move matches a splice-based reference and keeps a permutation', function () {
			fc.assert(
				fc.property(withIndex, function ([array, from, to]) {
					const reference = [...array];
					reference.splice(to < 0 ? to + array.length : to, 0, ...reference.splice(from, 1));
					const moved = helpers.move(array, from, to);
					expect(moved).toStrictEqual(reference);
					expect(sortedNumbers(moved)).toStrictEqual(sortedNumbers(array));
					expect(helpers.move(moved, to, from)).toStrictEqual(array);
				})
			);
		});

		it('insertAt matches splice on a copy and grows the array by the inserted count', function () {
			const input = fc.array(smallInt, { maxLength: 20 }).chain(function (array) {
				return fc.tuple(fc.constant(array), fc.integer({ min: -array.length, max: array.length }), smallInts);
			});
			fc.assert(
				fc.property(input, function ([array, index, items]) {
					const reference = [...array];
					reference.splice(index, 0, ...items);
					const result = helpers.insertAt(array, index, ...items);
					expect(result).toStrictEqual(reference);
					expect(result).toHaveLength(array.length + items.length);
				})
			);
		});

		it('removeAt matches splice on a copy and inverts insertAt', function () {
			fc.assert(
				fc.property(withIndex, fc.nat({ max: 25 }), function ([array, index], count) {
					const reference = [...array];
					reference.splice(index, count);
					expect(helpers.removeAt(array, index, count)).toStrictEqual(reference);
					const position = index < 0 ? index + array.length : index;
					expect(helpers.removeAt(helpers.insertAt(array, position, 99, 98), position, 2)).toStrictEqual(array);
				})
			);
		});

		const sortedInts = smallInts.map(sortedNumbers);

		it('sortedIndex equals a naive linear scan and keeps the array sorted when inserting', function () {
			fc.assert(
				fc.property(sortedInts, smallInt, function (array, value) {
					const index = helpers.sortedIndex(array, value);
					const naive = array.filter(function (item) {
						return item < value;
					}).length;
					expect(index).toBe(naive);
					const inserted = helpers.insertAt(array, index, value);
					expect(inserted).toStrictEqual(sortedNumbers(inserted));
				})
			);
		});

		it('binarySearch finds present elements of sorted unique arrays and returns -1 otherwise', function () {
			const unique = fc.uniqueArray(fc.integer({ min: -50, max: 50 }), { maxLength: 30 }).map(sortedNumbers);
			fc.assert(
				fc.property(unique, fc.integer({ min: -50, max: 50 }), function (array, value) {
					array.forEach(function (item, index) {
						expect(helpers.binarySearch(array, item)).toBe(index);
					});
					expect(helpers.binarySearch(array, value)).toBe(array.indexOf(value));
				})
			);
		});

		it('cartesianProduct has the product of the lengths and lists every combination once', function () {
			const arrays = fc.array(fc.array(smallInt, { maxLength: 4 }), { maxLength: 4 });
			fc.assert(
				fc.property(arrays, function (inputs) {
					const product = helpers.cartesianProduct(...inputs);
					const expectedLength = inputs.reduce(function (total, array) {
						return total * array.length;
					}, 1);
					expect(product).toHaveLength(expectedLength);
					product.forEach(function (tuple, index) {
						expect(tuple).toHaveLength(inputs.length);
						// Decode `index` in mixed radix (last array fastest) to find the expected positions.
						let rest = index;
						for (let k = inputs.length - 1; k >= 0; k--) {
							expect(tuple[k]).toBe(inputs[k][rest % inputs[k].length]);
							rest = Math.floor(rest / inputs[k].length);
						}
					});
				})
			);
		});

		it('intersperse has length 2n - 1 and the original items at even positions', function () {
			fc.assert(
				fc.property(smallInts, function (array) {
					const result = helpers.intersperse(array, 'sep');
					expect(result).toHaveLength(Math.max(0, 2 * array.length - 1));
					expect(
						result.filter(function (_value, index) {
							return index % 2 === 0;
						})
					).toStrictEqual(array);
					expect(
						result.filter(function (_value, index) {
							return index % 2 === 1;
						})
					).toStrictEqual(new Array(Math.max(0, array.length - 1)).fill('sep'));
				})
			);
		});

		it('differenceBy / intersectionBy with identity equal difference / intersection and partition the distinct keys', function () {
			function modulo(value: number): number {
				return ((value % 3) + 3) % 3;
			}
			fc.assert(
				fc.property(smallInts, smallInts, function (a, b) {
					expect(helpers.differenceBy(a, b, Number)).toStrictEqual(helpers.difference(a, b));
					expect(helpers.intersectionBy(a, b, Number)).toStrictEqual(helpers.intersection(a, b));
					const kept = helpers.intersectionBy(a, b, modulo).map(modulo);
					const dropped = helpers.differenceBy(a, b, modulo).map(modulo);
					expect(sortedNumbers([...kept, ...dropped])).toStrictEqual(sortedNumbers(helpers.removeDuplicates(a.map(modulo))));
				})
			);
		});
	});
	describe('diffSequences / longestCommonSubsequence', function () {
		it('`maxEdits` accepts exactly the scripts with at most that many edits, and does not change the script', function () {
			fc.assert(
				fc.property(diffInput, diffInput, fc.nat({ max: 40 }), function (a, b, maxEdits) {
					const script = helpers.diffSequences(a, b);
					const edits = script.filter(function (operation) {
						return operation.type !== 'equal';
					}).length;
					if (edits <= maxEdits) {
						expect(helpers.diffSequences(a, b, undefined, { maxEdits })).toStrictEqual(script);
					} else {
						expect(function () {
							helpers.diffSequences(a, b, undefined, { maxEdits });
						}).toThrow(RangeError);
					}
				})
			);
		});

		it('the script should rebuild a (equal + delete) and b (equal + insert), with consistent indices', function () {
			fc.assert(
				fc.property(diffInput, diffInput, function (a, b) {
					const script = helpers.diffSequences(a, b);
					const fromA: number[] = [];
					const fromB: number[] = [];
					for (const operation of script) {
						if (operation.type !== 'insert') {
							expect(operation.indexA).toBe(fromA.length);
							fromA.push(operation.value);
						}
						if (operation.type !== 'delete') {
							expect(operation.indexB).toBe(fromB.length);
							fromB.push(operation.type === 'equal' ? b[operation.indexB] : operation.value);
						}
						if (operation.type === 'equal') expect(operation.value).toBe(b[operation.indexB]);
					}
					expect(fromA).toStrictEqual(a);
					expect(fromB).toStrictEqual(b);
				})
			);
		});

		it('the script should be minimal: |a| + |b| - 2·|LCS| edits (reference O(n·m) DP)', function () {
			fc.assert(
				fc.property(diffInput, diffInput, function (a, b) {
					const edits = helpers.diffSequences(a, b).filter(function (operation) {
						return operation.type !== 'equal';
					}).length;
					expect(edits).toBe(a.length + b.length - 2 * lcsLength(a, b));
				})
			);
		});

		it('deletions should come before insertions within each change block', function () {
			fc.assert(
				fc.property(diffInput, diffInput, function (a, b) {
					const types = helpers
						.diffSequences(a, b)
						.map(function (operation) {
							return operation.type[0];
						})
						.join('');
					expect(types).not.toMatch(/id/);
				})
			);
		});

		it('the LCS should be a common subsequence of maximal length', function () {
			fc.assert(
				fc.property(diffInput, diffInput, function (a, b) {
					const common = helpers.longestCommonSubsequence(a, b);
					expect(isSubsequence(common, a)).toBe(true);
					expect(isSubsequence(common, b)).toBe(true);
					expect(common).toHaveLength(lcsLength(a, b));
					expect(helpers.longestCommonSubsequence(b, a)).toHaveLength(common.length);
				})
			);
		});

		it('a sequence diffed against itself, or against an edited copy of itself, should behave predictably', function () {
			fc.assert(
				fc.property(diffInput, fc.integer({ min: 0, max: 40 }), fc.array(fc.integer({ min: 5, max: 9 }), { maxLength: 5 }), function (a, at, inserted) {
					expect(helpers.longestCommonSubsequence(a, a)).toStrictEqual(a);
					const index = Math.min(at, a.length);
					const b = [...a.slice(0, index), ...inserted, ...a.slice(index)];
					expect(
						helpers.diffSequences(a, b).filter(function (operation) {
							return operation.type === 'insert';
						})
					).toHaveLength(inserted.length);
				})
			);
		});
	});
});
