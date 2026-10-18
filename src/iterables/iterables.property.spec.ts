import fc from 'fast-check';
import * as arrays from '../arrays/index.js';
import * as helpers from '.';

/** Small integers so that duplicates are frequent. */
const smallInt = fc.integer({ min: -8, max: 8 });
const smallInts = fc.array(smallInt, { maxLength: 30 });
const positive = fc.integer({ min: 1, max: 7 });
const count = fc.nat({ max: 40 });

/**
 * Wraps an iterable so that every `[Symbol.iterator]()`, `next()` and `return()` call is counted.
 */
function spy<T>(source: Iterable<T>) {
	const stats = { opened: 0, pulled: 0, closed: 0 };
	const iterable: Iterable<T> = {
		[Symbol.iterator]() {
			stats.opened++;
			const iterator = source[Symbol.iterator]();
			return {
				next() {
					stats.pulled++;
					return iterator.next();
				},
				return(value?: any) {
					stats.closed++;
					iterator.return?.(value);
					return { done: true as const, value };
				}
			};
		}
	};
	return { iterable, stats };
}

/** A one-shot generator over the values, so tests do not accidentally rely on arrays being re-iterable. */
function* once<T>(values: T[]): Generator<T> {
	yield* values;
}

function affine(value: number, index: number): number {
	return value * 3 + index;
}

function isPositive(value: number): boolean {
	return value > 0;
}

describe('iterables (properties)', function () {
	describe('lazy transforms match their eager Array references', function () {
		it('map ≡ Array#map', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					expect(helpers.toArray(helpers.map(once(xs), affine))).toStrictEqual(xs.map(affine));
				})
			);
		});

		it('filter ≡ Array#filter', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					function predicate(value: number, index: number): boolean {
						return (value + index) % 3 === 0;
					}
					expect(helpers.toArray(helpers.filter(once(xs), predicate))).toStrictEqual(xs.filter(predicate));
				})
			);
		});

		it('flatMap ≡ Array#flatMap', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					function expand(value: number, index: number): number[] {
						return arrays.range(Math.abs(value) % 4).map(function (k) {
							return k + index;
						});
					}
					expect(helpers.toArray(helpers.flatMap(once(xs), expand))).toStrictEqual(xs.flatMap(expand));
				})
			);
		});

		it('take / drop ≡ slice ≡ arrays.take / arrays.drop', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					expect(helpers.toArray(helpers.take(once(xs), n))).toStrictEqual(xs.slice(0, n));
					expect(helpers.toArray(helpers.drop(once(xs), n))).toStrictEqual(arrays.drop(xs, n));
					expect(helpers.toArray(helpers.take(once(xs), n))).toStrictEqual(arrays.take(xs, n));
				})
			);
		});

		it('take(n) ++ drop(n) rebuilds the input', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					expect(helpers.toArray(helpers.concat(helpers.take(xs, n), helpers.drop(xs, n)))).toStrictEqual(xs);
				})
			);
		});

		it('takeWhile / dropWhile split the input at the first failing item', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					const failing = xs.findIndex(function (x) {
						return !isPositive(x);
					});
					const cut = failing === -1 ? xs.length : failing;
					expect(helpers.toArray(helpers.takeWhile(once(xs), isPositive))).toStrictEqual(xs.slice(0, cut));
					expect(helpers.toArray(helpers.dropWhile(once(xs), isPositive))).toStrictEqual(xs.slice(cut));
				})
			);
		});

		it('chunk ≡ arrays.chunk', function () {
			fc.assert(
				fc.property(smallInts, positive, function (xs, size) {
					expect(helpers.toArray(helpers.chunk(once(xs), size))).toStrictEqual(arrays.chunk(xs, size));
				})
			);
		});

		it('windowed ≡ arrays.windowed', function () {
			fc.assert(
				fc.property(smallInts, positive, positive, function (xs, size, step) {
					expect(helpers.toArray(helpers.windowed(once(xs), size, step))).toStrictEqual(arrays.windowed(xs, size, step));
				})
			);
		});

		it('zip ≡ arrays.zip', function () {
			fc.assert(
				fc.property(smallInts, fc.array(fc.string(), { maxLength: 30 }), fc.array(fc.boolean(), { maxLength: 30 }), function (a, b, c) {
					expect(helpers.toArray(helpers.zip(once(a), once(b), once(c)))).toStrictEqual(arrays.zip(a, b, c));
					expect(helpers.toArray(helpers.zip(once(a)))).toStrictEqual(arrays.zip(a));
				})
			);
		});

		it('enumerate ≡ Array#map to [index, value]', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					expect(helpers.toArray(helpers.enumerate(once(xs)))).toStrictEqual(
						xs.map(function (value, index) {
							return [index, value];
						})
					);
				})
			);
		});

		it('unique ≡ arrays.unique, and unique(keyFn) ≡ arrays.uniqueBy', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(smallInt, fc.constant(NaN), fc.constant(-0)), { maxLength: 30 }), function (xs) {
					const deduplicated = helpers.toArray(helpers.unique(once(xs)));
					// Both keep the original first item (so -0 stays -0); toStrictEqual tells -0 and +0 apart.
					expect(deduplicated).toStrictEqual(
						arrays.uniqueBy(xs, function (value) {
							return value;
						})
					);
					expect(deduplicated).toStrictEqual(arrays.unique(xs));
					function key(value: number, index: number): number {
						return Math.abs(value) + (index % 2);
					}
					expect(helpers.toArray(helpers.unique(once(xs), key))).toStrictEqual(arrays.uniqueBy(xs, key));
				})
			);
		});

		it('scan yields the reduction of every prefix', function () {
			fc.assert(
				fc.property(smallInts, smallInt, function (xs, initial) {
					function reducer(acc: number, value: number, index: number): number {
						return acc * 2 - value + index;
					}
					const scanned = helpers.toArray(helpers.scan(once(xs), reducer, initial));
					expect(scanned).toStrictEqual(
						xs.map(function (_value, i) {
							return xs.slice(0, i + 1).reduce(reducer, initial);
						})
					);
				})
			);
		});

		it('concat ≡ Array#concat', function () {
			fc.assert(
				fc.property(fc.array(smallInts, { maxLength: 5 }), function (lists) {
					expect(helpers.toArray(helpers.concat(...lists.map(once)))).toStrictEqual(([] as number[]).concat(...lists));
				})
			);
		});

		it('tap yields its input unchanged and sees every item in order', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					const seen: number[] = [];
					expect(
						helpers.toArray(
							helpers.tap(once(xs), function (value) {
								seen.push(value);
							})
						)
					).toStrictEqual(xs);
					expect(seen).toStrictEqual(xs);
				})
			);
		});

		it('cycle repeats the input periodically', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					const expected =
						xs.length === 0
							? []
							: arrays.range(n).map(function (i) {
									return xs[i % xs.length];
								});
					expect(helpers.toArray(helpers.take(helpers.cycle(once(xs)), n))).toStrictEqual(expected);
				})
			);
		});
	});

	describe('consumers match their Array references', function () {
		it('reduce, first, last, find, some, every, countItems', function () {
			fc.assert(
				fc.property(smallInts, smallInt, function (xs, initial) {
					function add(acc: number, value: number, index: number): number {
						return acc + value * index;
					}
					expect(helpers.reduce(once(xs), add, initial)).toBe(xs.reduce(add, initial));
					if (xs.length > 0) expect(helpers.reduce(once(xs), add)).toBe(xs.reduce(add));
					expect(helpers.first(once(xs))).toBe(xs[0]);
					expect(helpers.last(once(xs))).toBe(xs[xs.length - 1]);
					expect(helpers.find(once(xs), isPositive)).toBe(xs.find(isPositive));
					expect(helpers.some(once(xs), isPositive)).toBe(xs.some(isPositive));
					expect(helpers.every(once(xs), isPositive)).toBe(xs.every(isPositive));
					expect(helpers.countItems(once(xs))).toBe(xs.length);
					expect(helpers.countItems(once(xs), isPositive)).toBe(xs.filter(isPositive).length);
					expect(helpers.toArray(once(xs))).toStrictEqual(xs);
				})
			);
		});
	});

	describe('laziness over infinite sources', function () {
		const oneToOne: Array<[string, (source: Iterable<number>) => Iterable<unknown>]> = [
			[
				'map',
				function (source) {
					return helpers.map(source, affine);
				}
			],
			[
				'filter (always true)',
				function (source) {
					return helpers.filter(source, function () {
						return true;
					});
				}
			],
			[
				'flatMap (singletons)',
				function (source) {
					return helpers.flatMap(source, function (n) {
						return [n];
					});
				}
			],
			['enumerate', helpers.enumerate],
			['unique', helpers.unique],
			[
				'scan',
				function (source) {
					return helpers.scan(source, affine, 0);
				}
			],
			[
				'tap',
				function (source) {
					return helpers.tap(source, function () {
						return undefined;
					});
				}
			],
			[
				'takeWhile (always true)',
				function (source) {
					return helpers.takeWhile(source, function () {
						return true;
					});
				}
			],
			[
				'zip',
				function (source) {
					return helpers.zip(source);
				}
			],
			['cycle', helpers.cycle],
			['concat', helpers.concat]
		];

		it.each(oneToOne)('take(%s(count()), n) terminates, pulls exactly n items and closes the source once', function (_name, transform) {
			fc.assert(
				fc.property(count, function (n) {
					const { iterable, stats } = spy(helpers.count());
					expect(helpers.toArray(helpers.take(transform(iterable), n))).toHaveLength(n);
					expect(stats.pulled).toBe(n);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});

		it('drop(count(), k) pulls exactly k + n items for n taken items', function () {
			fc.assert(
				fc.property(count, count, function (k, n) {
					const { iterable, stats } = spy(helpers.count());
					expect(helpers.toArray(helpers.take(helpers.drop(iterable, k), n))).toStrictEqual(arrays.range(k, k + n));
					expect(stats.pulled).toBe(n === 0 ? 0 : k + n);
				})
			);
		});

		it('chunk over count() pulls exactly n * size items for n chunks', function () {
			fc.assert(
				fc.property(count, positive, function (n, size) {
					const { iterable, stats } = spy(helpers.count());
					const chunks = helpers.toArray(helpers.take(helpers.chunk(iterable, size), n));
					expect(chunks).toStrictEqual(arrays.chunk(arrays.range(n * size), size));
					expect(stats.pulled).toBe(n * size);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});

		it('windowed over count() pulls exactly size + (n - 1) * step items for n windows', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 30 }), positive, positive, function (n, size, step) {
					const { iterable, stats } = spy(helpers.count());
					const windows = helpers.toArray(helpers.take(helpers.windowed(iterable, size, step), n));
					expect(windows).toStrictEqual(arrays.windowed(arrays.range(size + (n - 1) * step), size, step));
					expect(stats.pulled).toBe(size + (n - 1) * step);
					expect(stats.closed).toBe(1);
				})
			);
		});

		it('zip of several infinite sources pulls n items from each and closes each once', function () {
			fc.assert(
				fc.property(count, fc.integer({ min: 1, max: 4 }), function (n, arity) {
					const spies = arrays.range(arity).map(function () {
						return spy(helpers.count());
					});
					const zipped = helpers.toArray(
						helpers.take(
							helpers.zip(
								...spies.map(function (s) {
									return s.iterable;
								})
							),
							n
						)
					);
					expect(zipped).toHaveLength(n);
					for (const { stats } of spies) {
						expect(stats.pulled).toBe(n);
						expect(stats.closed).toBe(n === 0 ? 0 : 1);
					}
				})
			);
		});

		it('consumers that can stop early pull only what they need and close the source once', function () {
			fc.assert(
				fc.property(count, function (target) {
					function isTarget(value: number): boolean {
						return value === target;
					}
					for (const consume of [helpers.find, helpers.some]) {
						const { iterable, stats } = spy(helpers.count());
						consume(iterable, isTarget);
						expect(stats.pulled).toBe(target + 1);
						expect(stats.closed).toBe(1);
					}
					const { iterable, stats } = spy(helpers.count());
					expect(
						helpers.every(iterable, function (value) {
							return value < target;
						})
					).toBe(false);
					expect(stats.pulled).toBe(target + 1);
					expect(stats.closed).toBe(1);
				})
			);
		});
	});

	describe('early exit', function () {
		it('breaking out of a pipeline closes the source exactly once, whatever the stage count', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 6 }), count, function (stages, n) {
					const { iterable, stats } = spy(helpers.count());
					let pipeline: Iterable<number> = iterable;
					for (let i = 0; i < stages; i++) pipeline = helpers.map(pipeline, affine);
					let seen = 0;
					for (const _value of pipeline) {
						if (seen++ === n) break;
					}
					expect(stats.pulled).toBe(n + 1);
					expect(stats.closed).toBe(1);
				})
			);
		});
	});

	describe('async helpers match their sync counterparts', function () {
		it('mapAsync / filterAsync / takeAsync / chunkAsync', async function () {
			await fc.assert(
				fc.asyncProperty(smallInts, count, positive, async function (xs, n, size) {
					expect(
						await helpers.toArrayAsync(
							helpers.mapAsync(once(xs), async function (value, index) {
								return affine(value, index);
							})
						)
					).toStrictEqual(xs.map(affine));
					expect(
						await helpers.toArrayAsync(
							helpers.filterAsync(once(xs), async function (value) {
								return isPositive(value);
							})
						)
					).toStrictEqual(xs.filter(isPositive));
					expect(await helpers.toArrayAsync(helpers.takeAsync(once(xs), n))).toStrictEqual(xs.slice(0, n));
					expect(await helpers.toArrayAsync(helpers.chunkAsync(once(xs), size))).toStrictEqual(arrays.chunk(xs, size));
					expect(await helpers.toArrayAsync(xs.map(Promise.resolve.bind(Promise)))).toStrictEqual(xs);
				})
			);
		});

		it('takeAsync over an infinite source pulls exactly n items and closes it once', async function () {
			await fc.assert(
				fc.asyncProperty(count, async function (n) {
					const { iterable, stats } = spy(helpers.count());
					expect(await helpers.toArrayAsync(helpers.takeAsync(helpers.mapAsync(iterable, affine), n))).toHaveLength(n);
					expect(stats.pulled).toBe(n);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});
	});
});

describe('mapConcurrent (properties)', function () {
	function ascending(a: number, b: number): number {
		return a - b;
	}

	async function yieldTicks(n: number): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	it('ordered output equals Array#map; unordered output is a permutation of it; read-ahead never exceeds concurrency', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ value: smallInt, delay: fc.nat({ max: 6 }) }), { maxLength: 25 }),
				fc.oneof(positive, fc.constant(Infinity)),
				fc.boolean(),
				async function (items, concurrency, ordered) {
					let produced = 0;
					let consumed = 0;
					let maxAhead = 0;
					const source = (async function* () {
						for (const item of items) {
							produced++;
							maxAhead = Math.max(maxAhead, produced - consumed);
							yield item;
						}
					})();
					const output: number[] = [];
					for await (const value of helpers.mapConcurrent(
						source,
						async function (item) {
							await yieldTicks(item.delay);
							return item.value * 2;
						},
						{ concurrency, ordered }
					)) {
						consumed++;
						output.push(value);
						await yieldTicks(2);
					}
					const expected = items.map(function (item) {
						return item.value * 2;
					});
					if (ordered) expect(output).toEqual(expected);
					else expect(output.slice().sort(ascending)).toEqual(expected.slice().sort(ascending));
					// The item being consumed plus at most `concurrency` buffered ones.
					expect(maxAhead).toBeLessThanOrEqual(Math.min(concurrency, items.length) + 1);
				}
			)
		);
	});
});
