import * as helpers from '.';

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

/**
 * Async generator over the given values, recording whether its `finally` block ran (i.e. whether it was closed or finished).
 */
function asyncSource<T>(values: T[]) {
	const stats = { pulled: 0, finalized: 0 };
	const iterable = (async function* () {
		try {
			for (const value of values) {
				stats.pulled++;
				yield value;
			}
		} finally {
			stats.finalized++;
		}
	})();
	return { iterable, stats };
}

function double(n: number): number {
	return n * 2;
}

function isEven(n: number): boolean {
	return n % 2 === 0;
}

describe('iterables', function () {
	describe('count', function () {
		it('counts from 0 by 1 by default', function () {
			expect(helpers.toArray(helpers.take(helpers.count(), 4))).toStrictEqual([0, 1, 2, 3]);
		});

		it('supports a custom start and a negative, zero or fractional step', function () {
			expect(helpers.toArray(helpers.take(helpers.count(10, -5), 3))).toStrictEqual([10, 5, 0]);
			expect(helpers.toArray(helpers.take(helpers.count(7, 0), 3))).toStrictEqual([7, 7, 7]);
			// start + i * step: no accumulated rounding error (repeated addition would give 0.8999999999999999)
			expect(helpers.toArray(helpers.take(helpers.count(0, 0.1), 10))[9]).toBe(0.9);
		});

		it('throws a RangeError for non-finite arguments', function () {
			expect(function () {
				helpers.count(NaN);
			}).toThrow(new RangeError('count: `start` must be a finite number, got NaN'));
			expect(function () {
				helpers.count(0, Infinity);
			}).toThrow(new RangeError('count: `step` must be a finite number, got Infinity'));
			expect(function () {
				helpers.count('0' as any);
			}).toThrow(new TypeError('count: `start` must be a finite number, got string'));
			expect(function () {
				helpers.take([], '1' as any);
			}).toThrow(new TypeError('take: `n` must be an integer >= 0 or Infinity, got string'));
		});
	});

	describe('repeatValue', function () {
		it('repeats a value a given number of times', function () {
			expect(helpers.toArray(helpers.repeatValue('a', 3))).toStrictEqual(['a', 'a', 'a']);
			expect(helpers.toArray(helpers.repeatValue('a', 0))).toStrictEqual([]);
		});

		it('repeats forever by default', function () {
			expect(helpers.toArray(helpers.take(helpers.repeatValue(1), 5))).toStrictEqual([1, 1, 1, 1, 1]);
			expect(helpers.toArray(helpers.take(helpers.repeatValue(1, Infinity), 2))).toStrictEqual([1, 1]);
		});

		it('yields the same reference each time', function () {
			const object = {};
			const [a, b] = helpers.toArray(helpers.repeatValue(object, 2));
			expect(a).toBe(object);
			expect(b).toBe(object);
		});

		it('throws a RangeError for invalid counts', function () {
			for (const times of [-1, 1.5, NaN, -Infinity]) {
				expect(function () {
					helpers.repeatValue(0, times);
				}).toThrow(new RangeError(`repeatValue: \`times\` must be an integer >= 0 or Infinity, got ${String(times)}`));
			}
		});
	});

	describe('cycle', function () {
		it('repeats the items forever', function () {
			expect(helpers.toArray(helpers.take(helpers.cycle([1, 2, 3]), 7))).toStrictEqual([1, 2, 3, 1, 2, 3, 1]);
		});

		it('gives an empty iterator for an empty source', function () {
			expect(helpers.toArray(helpers.cycle([]))).toStrictEqual([]);
		});

		it('iterates the source only once (caches the first pass), so one-shot generators can be cycled', function () {
			const { iterable, stats } = spy(
				(function* () {
					yield 'a';
					yield 'b';
				})()
			);
			expect(helpers.toArray(helpers.take(helpers.cycle(iterable), 6))).toStrictEqual(['a', 'b', 'a', 'b', 'a', 'b']);
			expect(stats.opened).toBe(1);
			expect(stats.pulled).toBe(3);
			expect(stats.closed).toBe(0);
		});

		it('closes the source when stopped during the first pass', function () {
			const { iterable, stats } = spy([1, 2, 3]);
			expect(helpers.toArray(helpers.take(helpers.cycle(iterable), 2))).toStrictEqual([1, 2]);
			expect(stats.closed).toBe(1);
		});

		it('rethrows the error given to throw() while replaying the cache (regression: was a TypeError)', function () {
			const cycled = helpers.cycle([1, 2]);
			expect([cycled.next().value, cycled.next().value, cycled.next().value]).toStrictEqual([1, 2, 1]);
			const error = new Error('stop');
			expect(function () {
				cycled.throw?.(error);
			}).toThrow(error);
			expect(cycled.next()).toStrictEqual({ done: true, value: undefined });
		});

		it('throws a TypeError for a non-iterable', function () {
			expect(function () {
				helpers.cycle(5 as any);
			}).toThrow(new TypeError('cycle: `iterable` must be iterable, got number'));
		});
	});

	describe('iterate', function () {
		it('unfolds a sequence from a seed', function () {
			expect(helpers.toArray(helpers.take(helpers.iterate(1, double), 5))).toStrictEqual([1, 2, 4, 8, 16]);
		});

		it('only computes the items that are requested', function () {
			const next = jest.fn(double);
			expect(helpers.toArray(helpers.take(helpers.iterate(1, next), 3))).toStrictEqual([1, 2, 4]);
			expect(next).toHaveBeenCalledTimes(2);
		});

		it('throws a TypeError when next is not a function', function () {
			expect(function () {
				helpers.iterate(1, null as any);
			}).toThrow(new TypeError('iterate: `next` must be a function, got null'));
		});
	});

	describe('map', function () {
		it('maps items with their index', function () {
			expect(
				helpers.toArray(
					helpers.map(['a', 'b'], function (value, index) {
						return value + index;
					})
				)
			).toStrictEqual(['a0', 'b1']);
		});

		it('works on any iterable (Set, Map, string, generator)', function () {
			expect(helpers.toArray(helpers.map(new Set([1, 2]), double))).toStrictEqual([2, 4]);
			expect(
				helpers.toArray(
					helpers.map(new Map([['k', 1]]), function ([key, value]) {
						return key + value;
					})
				)
			).toStrictEqual(['k1']);
			expect(
				helpers.toArray(
					helpers.map('a😀', function (char) {
						return char.length;
					})
				)
			).toStrictEqual([1, 2]);
		});

		it('does not pull anything before being iterated', function () {
			const { iterable, stats } = spy([1, 2]);
			const fn = jest.fn(double);
			const mapped = helpers.map(iterable, fn);
			expect(stats.opened).toBe(0);
			expect(fn).not.toHaveBeenCalled();
			expect(mapped.next()).toStrictEqual({ done: false, value: 2 });
			expect(stats.pulled).toBe(1);
		});

		it('is its own iterator', function () {
			const mapped = helpers.map([1], double);
			expect(mapped[Symbol.iterator]()).toBe(mapped);
		});

		it('validates its arguments eagerly', function () {
			expect(function () {
				helpers.map(undefined as any, double);
			}).toThrow(new TypeError('map: `iterable` must be iterable, got undefined'));
			expect(function () {
				helpers.map([1], 'x' as any);
			}).toThrow(new TypeError('map: `fn` must be a function, got string'));
			expect(function () {
				helpers.map({} as any, double);
			}).toThrow(TypeError);
		});

		it('closes the source when the callback throws', function () {
			const { iterable, stats } = spy([1, 2, 3]);
			const mapped = helpers.map(iterable, function (n) {
				if (n === 2) throw new Error('boom');
				return n;
			});
			expect(function () {
				helpers.toArray(mapped);
			}).toThrow('boom');
			expect(stats.closed).toBe(1);
		});
	});

	describe('filter', function () {
		it('keeps matching items, passing the index', function () {
			expect(helpers.toArray(helpers.filter([1, 2, 3, 4], isEven))).toStrictEqual([2, 4]);
			expect(
				helpers.toArray(
					helpers.filter(['a', 'b', 'c'], function (_value, index) {
						return index !== 1;
					})
				)
			).toStrictEqual(['a', 'c']);
		});

		it('narrows the type with a type guard', function () {
			const numbers = helpers.toArray(
				helpers.filter([1, 'a', 2, null], function (value): value is number {
					return typeof value === 'number';
				})
			);
			const typed: number[] = numbers;
			expect(typed).toStrictEqual([1, 2]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.filter(1 as any, isEven);
			}).toThrow(TypeError);
			expect(function () {
				helpers.filter([1], undefined as any);
			}).toThrow(new TypeError('filter: `predicate` must be a function, got undefined'));
		});
	});

	describe('flatMap', function () {
		it('flattens one level of returned iterables', function () {
			expect(
				helpers.toArray(
					helpers.flatMap([1, 2, 3], function (n, index) {
						return index === 1 ? [] : [n, [n]];
					})
				)
			).toStrictEqual([1, [1], 3, [3]]);
		});

		it('accepts any iterable, including strings and generators', function () {
			expect(
				helpers.toArray(
					helpers.flatMap(['ab', 'c'], function (s) {
						return s;
					})
				)
			).toStrictEqual(['a', 'b', 'c']);
			expect(
				helpers.toArray(
					helpers.flatMap([2], function (n) {
						return helpers.repeatValue(n, n);
					})
				)
			).toStrictEqual([2, 2]);
		});

		it('throws a TypeError when the callback returns a non-iterable', function () {
			const flat = helpers.flatMap([1], function () {
				return 1 as any;
			});
			expect(function () {
				flat.next();
			}).toThrow(new TypeError('flatMap: `fn(...)` must be iterable, got number'));
		});

		it('closes both the inner and the outer iterators on early exit', function () {
			const outer = spy([1, 2]);
			const inner = spy(helpers.count());
			const flat = helpers.flatMap(outer.iterable, function () {
				return inner.iterable;
			});
			expect(helpers.toArray(helpers.take(flat, 3))).toStrictEqual([0, 1, 2]);
			expect(outer.stats.closed).toBe(1);
			expect(inner.stats.closed).toBe(1);
		});

		it('closes the inner and outer iterators and rethrows the error given to throw() (regression: was a TypeError)', function () {
			const outer = spy([1, 2]);
			const inner = spy(helpers.count());
			const flat = helpers.flatMap(outer.iterable, function () {
				return inner.iterable;
			});
			flat.next();
			const error = new Error('stop');
			expect(function () {
				flat.throw?.(error);
			}).toThrow(error);
			expect(outer.stats.closed).toBe(1);
			expect(inner.stats.closed).toBe(1);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.flatMap([1], 3 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.flatMap(null as any, double as any);
			}).toThrow(new TypeError('flatMap: `iterable` must be iterable, got null'));
		});
	});

	describe('take', function () {
		it('takes the first n items', function () {
			expect(helpers.toArray(helpers.take([1, 2, 3], 2))).toStrictEqual([1, 2]);
			expect(helpers.toArray(helpers.take([1, 2], 5))).toStrictEqual([1, 2]);
			expect(helpers.toArray(helpers.take([1, 2], Infinity))).toStrictEqual([1, 2]);
			expect(helpers.toArray(helpers.take([], 2))).toStrictEqual([]);
		});

		it('pulls exactly n items, then closes the source once', function () {
			const { iterable, stats } = spy(helpers.count());
			expect(helpers.toArray(helpers.take(iterable, 3))).toStrictEqual([0, 1, 2]);
			expect(stats.pulled).toBe(3);
			expect(stats.closed).toBe(1);
		});

		it('does not even open the source for n = 0', function () {
			const { iterable, stats } = spy([1]);
			expect(helpers.toArray(helpers.take(iterable, 0))).toStrictEqual([]);
			expect(stats.opened).toBe(0);
		});

		it('does not close a source that ended by itself', function () {
			const { iterable, stats } = spy([1, 2]);
			helpers.toArray(helpers.take(iterable, 5));
			expect(stats.closed).toBe(0);
		});

		it('throws the same RangeError rules as arrays.take (plus Infinity)', function () {
			for (const n of [-1, 1.5, NaN, -Infinity]) {
				expect(function () {
					helpers.take([1], n);
				}).toThrow(new RangeError(`take: \`n\` must be an integer >= 0 or Infinity, got ${String(n)}`));
			}
			expect(function () {
				helpers.take(2 as any, 1);
			}).toThrow(TypeError);
		});
	});

	describe('drop', function () {
		it('skips the first n items', function () {
			expect(helpers.toArray(helpers.drop([1, 2, 3], 2))).toStrictEqual([3]);
			expect(helpers.toArray(helpers.drop([1, 2, 3], 0))).toStrictEqual([1, 2, 3]);
			expect(helpers.toArray(helpers.drop([1, 2], 5))).toStrictEqual([]);
		});

		it('works on infinite iterators', function () {
			expect(helpers.toArray(helpers.take(helpers.drop(helpers.count(), 5), 2))).toStrictEqual([5, 6]);
		});

		it('throws the same RangeError as arrays.drop', function () {
			for (const n of [-1, 0.5, NaN, Infinity]) {
				expect(function () {
					helpers.drop([1], n);
				}).toThrow(new RangeError(`drop: \`n\` must be an integer >= 0, got ${String(n)}`));
			}
			expect(function () {
				helpers.drop(true as any, 1);
			}).toThrow(new TypeError('drop: `iterable` must be iterable, got boolean'));
		});
	});

	describe('takeWhile', function () {
		it('yields items while the predicate holds and closes the source at the first failure', function () {
			const { iterable, stats } = spy(helpers.count(1));
			expect(
				helpers.toArray(
					helpers.takeWhile(iterable, function (n) {
						return n < 4;
					})
				)
			).toStrictEqual([1, 2, 3]);
			expect(stats.pulled).toBe(4);
			expect(stats.closed).toBe(1);
		});

		it('passes the index and handles a predicate that always holds', function () {
			expect(
				helpers.toArray(
					helpers.takeWhile(['a', 'b', 'c'], function (_v, index) {
						return index < 2;
					})
				)
			).toStrictEqual(['a', 'b']);
			expect(
				helpers.toArray(
					helpers.takeWhile([1, 2], function () {
						return true;
					})
				)
			).toStrictEqual([1, 2]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.takeWhile([1], {} as any);
			}).toThrow(new TypeError('takeWhile: `predicate` must be a function, got object'));
			expect(function () {
				helpers.takeWhile(1 as any, isEven);
			}).toThrow(TypeError);
		});
	});

	describe('dropWhile', function () {
		it('skips items while the predicate holds, then yields everything', function () {
			const predicate = jest.fn(function (n: number) {
				return n < 2;
			});
			expect(helpers.toArray(helpers.dropWhile([1, 2, 3, 1], predicate))).toStrictEqual([2, 3, 1]);
			// not called again once it failed
			expect(predicate).toHaveBeenCalledTimes(2);
			expect(predicate).toHaveBeenNthCalledWith(2, 2, 1);
		});

		it('can drop everything', function () {
			expect(
				helpers.toArray(
					helpers.dropWhile([1, 2], function () {
						return true;
					})
				)
			).toStrictEqual([]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.dropWhile([1], 1 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.dropWhile(undefined as any, isEven);
			}).toThrow(TypeError);
		});
	});

	describe('chunk', function () {
		it('splits into chunks, the last one possibly shorter', function () {
			expect(helpers.toArray(helpers.chunk([1, 2, 3, 4, 5], 2))).toStrictEqual([[1, 2], [3, 4], [5]]);
			expect(helpers.toArray(helpers.chunk([1, 2, 3, 4], 2))).toStrictEqual([
				[1, 2],
				[3, 4]
			]);
			expect(helpers.toArray(helpers.chunk([], 3))).toStrictEqual([]);
		});

		it('yields each chunk as soon as it is full', function () {
			const { iterable, stats } = spy(helpers.count());
			const chunks = helpers.chunk(iterable, 3);
			expect(chunks.next().value).toStrictEqual([0, 1, 2]);
			expect(stats.pulled).toBe(3);
		});

		it('yields fresh arrays that later chunks do not touch', function () {
			const chunks = helpers.toArray(helpers.chunk('abcd', 2));
			chunks[0].push('z');
			expect(chunks).toStrictEqual([
				['a', 'b', 'z'],
				['c', 'd']
			]);
		});

		it('throws the same RangeError as arrays.chunk', function () {
			for (const size of [0, -1, 1.5, NaN, Infinity]) {
				expect(function () {
					helpers.chunk([1], size);
				}).toThrow(new RangeError(`chunk: \`size\` must be an integer >= 1, got ${String(size)}`));
			}
			expect(function () {
				helpers.chunk(null as any, 1);
			}).toThrow(TypeError);
		});
	});

	describe('windowed', function () {
		it('yields sliding windows', function () {
			expect(helpers.toArray(helpers.windowed([1, 2, 3, 4], 2))).toStrictEqual([
				[1, 2],
				[2, 3],
				[3, 4]
			]);
			expect(helpers.toArray(helpers.windowed([1, 2, 3, 4, 5], 3, 2))).toStrictEqual([
				[1, 2, 3],
				[3, 4, 5]
			]);
		});

		it('skips items between windows when step > size, and drops incomplete windows', function () {
			expect(helpers.toArray(helpers.windowed([1, 2, 3, 4, 5, 6, 7, 8], 2, 3))).toStrictEqual([
				[1, 2],
				[4, 5],
				[7, 8]
			]);
			expect(helpers.toArray(helpers.windowed([1, 2, 3, 4, 5, 6, 7], 2, 3))).toStrictEqual([
				[1, 2],
				[4, 5]
			]);
			expect(helpers.toArray(helpers.windowed([1, 2], 3))).toStrictEqual([]);
		});

		it('yields independent arrays', function () {
			const windows = helpers.toArray(helpers.windowed([1, 2, 3], 2));
			windows[0][1] = 99;
			expect(windows[1]).toStrictEqual([2, 3]);
		});

		it('throws the same RangeErrors as arrays.windowed', function () {
			expect(function () {
				helpers.windowed([1], 0);
			}).toThrow(new RangeError('windowed: `size` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.windowed([1], 2, 0.5);
			}).toThrow(new RangeError('windowed: `step` must be an integer >= 1, got 0.5'));
			expect(function () {
				helpers.windowed(4 as any, 1);
			}).toThrow(TypeError);
		});
	});

	describe('zip', function () {
		it('closes the sources already opened when opening a later one throws', function () {
			const first = spy([1, 2]);
			const second = spy([3, 4]);
			const broken: Iterable<number> = {
				[Symbol.iterator](): Iterator<number> {
					throw new Error('cannot open');
				}
			};
			expect(function () {
				helpers.toArray(helpers.zip(first.iterable, second.iterable, broken));
			}).toThrow('cannot open');
			expect(first.stats).toStrictEqual({ opened: 1, pulled: 0, closed: 1 });
			expect(second.stats).toStrictEqual({ opened: 1, pulled: 0, closed: 1 });
		});

		it('zips iterables into tuples, stopping at the shortest', function () {
			const zipped = helpers.toArray(helpers.zip([1, 2, 3], 'ab', new Set([true, false, true])));
			const typed: Array<[number, string, boolean]> = zipped;
			expect(typed).toStrictEqual([
				[1, 'a', true],
				[2, 'b', false]
			]);
		});

		it('is empty without arguments or with an empty iterable', function () {
			expect(helpers.toArray(helpers.zip())).toStrictEqual([]);
			expect(helpers.toArray(helpers.zip([1], []))).toStrictEqual([]);
		});

		it('works with infinite iterables as long as one is finite', function () {
			expect(helpers.toArray(helpers.zip(helpers.count(), ['a', 'b']))).toStrictEqual([
				[0, 'a'],
				[1, 'b']
			]);
		});

		it('closes the other sources when one ends, but not the one that ended', function () {
			const a = spy(helpers.count());
			const b = spy([1]);
			const c = spy(helpers.count());
			expect(helpers.toArray(helpers.zip(a.iterable, b.iterable, c.iterable))).toStrictEqual([[0, 1, 0]]);
			expect(a.stats.closed).toBe(1);
			expect(b.stats.closed).toBe(0);
			expect(c.stats.closed).toBe(1);
			// c was not pulled again once b ended
			expect(c.stats.pulled).toBe(1);
		});

		it('closes every source exactly once on early exit', function () {
			const a = spy([1, 2, 3]);
			const b = spy([4, 5, 6]);
			const zipped = helpers.zip(a.iterable, b.iterable);
			for (const tuple of zipped) {
				expect(tuple).toStrictEqual([1, 4]);
				break;
			}
			zipped.return?.();
			expect(a.stats.closed).toBe(1);
			expect(b.stats.closed).toBe(1);
		});

		it('closes the other sources when one throws, propagating its error', function () {
			const a = spy(helpers.count());
			const failing: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next(): IteratorResult<number> {
							throw new Error('next failed');
						},
						return: jest.fn()
					};
				}
			};
			expect(function () {
				helpers.toArray(helpers.zip(a.iterable, failing));
			}).toThrow('next failed');
			expect(a.stats.closed).toBe(1);
		});

		it('closes the already opened sources when opening one fails', function () {
			const a = spy([1]);
			const broken: Iterable<number> = {
				[Symbol.iterator]() {
					throw new Error('cannot open');
				}
			};
			expect(function () {
				helpers.toArray(helpers.zip(a.iterable, broken));
			}).toThrow('cannot open');
			expect(a.stats.closed).toBe(1);
		});

		it('rethrows the first error raised while closing, after closing all the others', function () {
			const throwing: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next() {
							return { done: false, value: 1 };
						},
						return(): IteratorResult<number> {
							throw new Error('close failed');
						}
					};
				}
			};
			const other = spy(helpers.count());
			const zipped = helpers.zip(throwing, other.iterable);
			zipped.next();
			expect(function () {
				zipped.return?.();
			}).toThrow('close failed');
			expect(other.stats.closed).toBe(1);
		});

		it('keeps the original error when closing also fails', function () {
			const throwingClose: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next() {
							return { done: false, value: 1 };
						},
						return(): IteratorResult<number> {
							throw new Error('close failed');
						}
					};
				}
			};
			const failingNext: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next(): IteratorResult<number> {
							throw new Error('next failed');
						}
					};
				}
			};
			expect(function () {
				helpers.toArray(helpers.zip(throwingClose, failingNext));
			}).toThrow('next failed');
		});

		it('tolerates iterators without a return method', function () {
			const plain: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next() {
							return { done: false, value: 7 };
						}
					};
				}
			};
			expect(helpers.toArray(helpers.zip(plain, [1, 2]))).toStrictEqual([
				[7, 1],
				[7, 2]
			]);
		});

		it('throws a TypeError for a non-iterable argument', function () {
			expect(function () {
				helpers.zip([1], 2 as any);
			}).toThrow(new TypeError('zip: `iterables` must be iterable, got number'));
		});
	});

	describe('enumerate', function () {
		it('pairs items with their index', function () {
			const pairs = helpers.toArray(helpers.enumerate(['a', 'b']));
			const typed: Array<[number, string]> = pairs;
			expect(typed).toStrictEqual([
				[0, 'a'],
				[1, 'b']
			]);
		});

		it('throws for a non-iterable', function () {
			expect(function () {
				helpers.enumerate(1 as any);
			}).toThrow(TypeError);
		});
	});

	describe('unique', function () {
		it('removes duplicates with SameValueZero, keeping first occurrences', function () {
			expect(helpers.toArray(helpers.unique([1, 2, 1, 3, 2]))).toStrictEqual([1, 2, 3]);
			expect(helpers.toArray(helpers.unique([NaN, NaN, 0, -0]))).toStrictEqual([NaN, 0]);
		});

		it('uses keyFn (with the index) when given', function () {
			const keyFn = jest.fn(function (s: string) {
				return s.toLowerCase();
			});
			expect(helpers.toArray(helpers.unique(['a', 'B', 'A', 'b'], keyFn))).toStrictEqual(['a', 'B']);
			expect(keyFn).toHaveBeenNthCalledWith(3, 'A', 2);
		});

		it('works on infinite iterators', function () {
			expect(
				helpers.toArray(
					helpers.take(
						helpers.unique(helpers.count(), function (n) {
							return n % 3;
						}),
						3
					)
				)
			).toStrictEqual([0, 1, 2]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.unique([1], 'key' as any);
			}).toThrow(new TypeError('unique: `keyFn` must be a function, got string'));
			expect(function () {
				helpers.unique(1 as any);
			}).toThrow(TypeError);
		});
	});

	describe('scan', function () {
		it('yields the running accumulator, without the initial value', function () {
			expect(
				helpers.toArray(
					helpers.scan(
						[1, 2, 3],
						function (sum, n) {
							return sum + n;
						},
						0
					)
				)
			).toStrictEqual([1, 3, 6]);
			expect(
				helpers.toArray(
					helpers.scan(
						[],
						function (sum: number) {
							return sum;
						},
						0
					)
				)
			).toStrictEqual([]);
		});

		it('passes the index and allows a different accumulator type', function () {
			expect(
				helpers.toArray(
					helpers.scan(
						['a', 'b'],
						function (acc: string[], value, index) {
							return [...acc, value + index];
						},
						[] as string[]
					)
				)
			).toStrictEqual([['a0'], ['a0', 'b1']]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.scan([1], null as any, 0);
			}).toThrow(TypeError);
			expect(function () {
				helpers.scan(1 as any, double as any, 0);
			}).toThrow(TypeError);
		});
	});

	describe('concat', function () {
		it('chains iterables', function () {
			expect(helpers.toArray(helpers.concat<number | string>([1, 2], new Set([3]), 'ab'))).toStrictEqual([1, 2, 3, 'a', 'b']);
			expect(helpers.toArray(helpers.concat())).toStrictEqual([]);
		});

		it('only opens a source once the previous one is exhausted', function () {
			const a = spy([1]);
			const b = spy([2]);
			const chained = helpers.concat(a.iterable, b.iterable);
			chained.next();
			expect(b.stats.opened).toBe(0);
			expect(helpers.toArray(chained)).toStrictEqual([2]);
			expect(b.stats.opened).toBe(1);
		});

		it('closes the current source on throw() instead of forwarding the error into it (regression)', function () {
			let finalized = false;
			const swallowing = (function* () {
				try {
					yield 1;
				} catch {
					yield 2;
				} finally {
					finalized = true;
				}
			})();
			const chained = helpers.concat(swallowing);
			chained.next();
			const error = new Error('stop');
			expect(function () {
				chained.throw?.(error);
			}).toThrow(error);
			expect(finalized).toBe(true);
		});

		it('throws a TypeError for a non-iterable argument', function () {
			expect(function () {
				helpers.concat([1], {} as any);
			}).toThrow(new TypeError('concat: `iterables` must be iterable, got object'));
		});
	});

	describe('tap', function () {
		it('runs a side effect on each item as it passes', function () {
			const seen: Array<[number, number]> = [];
			const tapped = helpers.tap([1, 2, 3], function (value, index) {
				seen.push([value, index]);
			});
			expect(seen).toStrictEqual([]);
			expect(tapped.next().value).toBe(1);
			expect(seen).toStrictEqual([[1, 0]]);
			expect(helpers.toArray(tapped)).toStrictEqual([2, 3]);
			expect(seen).toStrictEqual([
				[1, 0],
				[2, 1],
				[3, 2]
			]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.tap([1], undefined as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.tap(undefined as any, double);
			}).toThrow(TypeError);
		});
	});

	describe('early exit closes the source exactly once', function () {
		const transforms: Array<[string, (source: Iterable<number>) => IterableIterator<unknown>]> = [
			[
				'map',
				function (source) {
					return helpers.map(source, double);
				}
			],
			[
				'filter',
				function (source) {
					return helpers.filter(source, function () {
						return true;
					});
				}
			],
			[
				'flatMap',
				function (source) {
					return helpers.flatMap(source, function (n) {
						return [n];
					});
				}
			],
			[
				'drop',
				function (source) {
					return helpers.drop(source, 1);
				}
			],
			[
				'takeWhile',
				function (source) {
					return helpers.takeWhile(source, function () {
						return true;
					});
				}
			],
			[
				'dropWhile',
				function (source) {
					return helpers.dropWhile(source, function (n) {
						return n < 1;
					});
				}
			],
			[
				'chunk',
				function (source) {
					return helpers.chunk(source, 2);
				}
			],
			[
				'windowed',
				function (source) {
					return helpers.windowed(source, 2);
				}
			],
			['enumerate', helpers.enumerate],
			['unique', helpers.unique],
			[
				'scan',
				function (source) {
					return helpers.scan(
						source,
						function (a, b) {
							return a + b;
						},
						0
					);
				}
			],
			['concat', helpers.concat],
			[
				'tap',
				function (source) {
					return helpers.tap(source, function () {
						return undefined;
					});
				}
			],
			['cycle', helpers.cycle],
			[
				'zip',
				function (source) {
					return helpers.zip(source);
				}
			]
		];

		it.each(transforms)('%s', function (_name, transform) {
			const { iterable, stats } = spy(helpers.count());
			const result = transform(iterable);
			expect(stats.opened).toBe(0);
			const first = result.next();
			expect(first.done).toBe(false);
			expect(result.return?.()).toStrictEqual({ done: true, value: undefined });
			expect(stats.closed).toBe(1);
			// closing again, or iterating a closed iterator, does not touch the source
			result.return?.();
			expect(result.next()).toStrictEqual({ done: true, value: undefined });
			expect(stats.closed).toBe(1);
		});

		it.each(transforms)('%s (throw() closes the source and rethrows the given error)', function (_name, transform) {
			const { iterable, stats } = spy(helpers.count());
			const result = transform(iterable);
			result.next();
			const error = new Error('stop');
			expect(function () {
				result.throw?.(error);
			}).toThrow(error);
			expect(stats.closed).toBe(1);
			expect(result.next()).toStrictEqual({ done: true, value: undefined });
		});

		it.each(transforms)('%s (return before the first next does not open the source)', function (_name, transform) {
			const { iterable, stats } = spy(helpers.count());
			transform(iterable).return?.();
			expect(stats.opened).toBe(0);
			expect(stats.closed).toBe(0);
		});
	});

	describe('toArray', function () {
		it('collects the items', function () {
			expect(helpers.toArray(new Set([1, 2]))).toStrictEqual([1, 2]);
			expect(helpers.toArray([])).toStrictEqual([]);
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.toArray([1, , 'a'])).toStrictEqual([1, undefined, 'a']);
			expect(helpers.toArray('ab')).toStrictEqual(['a', 'b']);
		});

		it('returns a fresh array', function () {
			const source = [1];
			expect(helpers.toArray(source)).not.toBe(source);
		});

		it('throws for a non-iterable', function () {
			expect(function () {
				helpers.toArray(3 as any);
			}).toThrow(TypeError);
		});
	});

	describe('reduce', function () {
		it('reduces from an initial value, passing the index', function () {
			expect(
				helpers.reduce(
					[1, 2, 3],
					function (sum, n) {
						return sum + n;
					},
					10
				)
			).toBe(16);
			expect(
				helpers.reduce(
					'ab',
					function (acc: string[], c, index) {
						return [...acc, c + index];
					},
					[] as string[]
				)
			).toStrictEqual(['a0', 'b1']);
			expect(
				helpers.reduce(
					[],
					function (sum: number) {
						return sum + 1;
					},
					5
				)
			).toBe(5);
		});

		it('accepts undefined as an explicit initial value', function () {
			expect(
				helpers.reduce(
					[1],
					function (acc: number | undefined, n) {
						return acc === undefined ? n * 100 : acc;
					},
					undefined
				)
			).toBe(100);
		});

		it('uses the first item when no initial value is given (reducer starts at index 1)', function () {
			const reducer = jest.fn(function (max: number, n: number) {
				return Math.max(max, n);
			});
			expect(helpers.reduce([3, 7, 5], reducer)).toBe(7);
			expect(reducer).toHaveBeenNthCalledWith(1, 3, 7, 1);
			expect(helpers.reduce([42], reducer)).toBe(42);
		});

		it('throws a TypeError for an empty iterable without an initial value', function () {
			expect(function () {
				helpers.reduce([], double);
			}).toThrow(new TypeError('reduce: cannot reduce an empty iterable without an initial value'));
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.reduce([1], 'x' as any, 0);
			}).toThrow(TypeError);
			expect(function () {
				helpers.reduce(null as any, double, 0);
			}).toThrow(TypeError);
		});
	});

	describe('first', function () {
		it('returns the first item and closes the source', function () {
			const { iterable, stats } = spy(helpers.count(5));
			expect(helpers.first(iterable)).toBe(5);
			expect(stats.pulled).toBe(1);
			expect(stats.closed).toBe(1);
		});

		it('returns undefined for an empty iterable', function () {
			expect(helpers.first([])).toBeUndefined();
		});

		it('throws for a non-iterable', function () {
			expect(function () {
				helpers.first({} as any);
			}).toThrow(TypeError);
		});
	});

	describe('last', function () {
		it('returns the last item', function () {
			expect(helpers.last(helpers.take(helpers.count(), 4))).toBe(3);
			expect(helpers.last('abc')).toBe('c');
		});

		it('returns undefined for an empty iterable', function () {
			expect(helpers.last([])).toBeUndefined();
		});

		it('throws for a non-iterable', function () {
			expect(function () {
				helpers.last(1 as any);
			}).toThrow(TypeError);
		});
	});

	describe('find', function () {
		it('returns the first match and closes the source', function () {
			const { iterable, stats } = spy(helpers.count(1));
			expect(
				helpers.find(iterable, function (n) {
					return n % 7 === 0;
				})
			).toBe(7);
			expect(stats.pulled).toBe(7);
			expect(stats.closed).toBe(1);
		});

		it('returns undefined when nothing matches, and passes the index', function () {
			expect(helpers.find([1, 3], isEven)).toBeUndefined();
			expect(
				helpers.find(['a', 'b'], function (_v, index) {
					return index === 1;
				})
			).toBe('b');
		});

		it('narrows the type with a type guard', function () {
			const found = helpers.find([1, 'a'], function (value): value is string {
				return typeof value === 'string';
			});
			const typed: string | undefined = found;
			expect(typed).toBe('a');
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.find([1], 1 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.find(1 as any, isEven);
			}).toThrow(TypeError);
		});
	});

	describe('some / every', function () {
		it('some short-circuits on the first match', function () {
			const { iterable, stats } = spy(helpers.count());
			expect(
				helpers.some(iterable, function (n) {
					return n > 2;
				})
			).toBe(true);
			expect(stats.pulled).toBe(4);
			expect(stats.closed).toBe(1);
			expect(helpers.some([1, 3], isEven)).toBe(false);
			expect(helpers.some([], isEven)).toBe(false);
		});

		it('every short-circuits on the first mismatch', function () {
			const { iterable, stats } = spy(helpers.count());
			expect(
				helpers.every(iterable, function (n) {
					return n < 2;
				})
			).toBe(false);
			expect(stats.pulled).toBe(3);
			expect(stats.closed).toBe(1);
			expect(helpers.every([2, 4], isEven)).toBe(true);
			expect(helpers.every([], isEven)).toBe(true);
		});

		it('pass the index', function () {
			expect(
				helpers.some(['x', 'y'], function (_v, index) {
					return index === 1;
				})
			).toBe(true);
			expect(
				helpers.every(['x', 'y'], function (_v, index) {
					return index < 1;
				})
			).toBe(false);
		});

		it('validate their arguments', function () {
			expect(function () {
				helpers.some([1], null as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.every(null as any, isEven);
			}).toThrow(TypeError);
			expect(function () {
				helpers.some(null as any, isEven);
			}).toThrow(TypeError);
			expect(function () {
				helpers.every([1], null as any);
			}).toThrow(TypeError);
		});
	});

	describe('countItems', function () {
		it('counts all items, or the matching ones', function () {
			expect(helpers.countItems(new Set([1, 2, 3]))).toBe(3);
			expect(helpers.countItems([])).toBe(0);
			expect(helpers.countItems([1, 2, 3, 4], isEven)).toBe(2);
			expect(
				helpers.countItems(['a', 'b', 'c'], function (_v, index) {
					return index > 0;
				})
			).toBe(2);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.countItems(1 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.countItems([1], 1 as any);
			}).toThrow(new TypeError('countItems: `predicate` must be a function, got number'));
		});
	});

	describe('async helpers', function () {
		describe('close a sync source when one of its promises rejects (regression: the source was left open)', function () {
			const consumers: Array<[string, (source: Iterable<Promise<number>>) => Promise<unknown>]> = [
				[
					'mapAsync',
					function (source) {
						return helpers.toArrayAsync(helpers.mapAsync(source, double));
					}
				],
				[
					'filterAsync',
					function (source) {
						return helpers.toArrayAsync(helpers.filterAsync(source, isEven));
					}
				],
				[
					'takeAsync',
					function (source) {
						return helpers.toArrayAsync(helpers.takeAsync(source, 5));
					}
				],
				[
					'chunkAsync',
					function (source) {
						return helpers.toArrayAsync(helpers.chunkAsync(source, 2));
					}
				],
				['toArrayAsync', helpers.toArrayAsync]
			];

			it.each(consumers)('%s', async function (_name, consume) {
				let finalized = 0;
				const failure = new Error('item failed');
				const source = (function* () {
					try {
						yield Promise.resolve(1);
						yield Promise.reject(failure);
						yield Promise.resolve(3);
					} finally {
						finalized++;
					}
				})();
				await expect(consume(source)).rejects.toBe(failure);
				expect(finalized).toBe(1);
			});

			it('also closes an array whose iterator was replaced', async function () {
				let finalized = 0;
				const failure = new Error('item failed');
				const source: Array<Promise<number>> = [Promise.resolve(1), Promise.reject(failure)];
				(source as any)[Symbol.iterator] = function* (): Generator<Promise<number>, void, undefined> {
					try {
						yield* Array.prototype.values.call(source) as IterableIterator<Promise<number>>;
					} finally {
						finalized++;
					}
				};
				await expect(helpers.toArrayAsync(source)).rejects.toBe(failure);
				expect(finalized).toBe(1);
			});

			it('also closes it on early exit', async function () {
				let finalized = 0;
				const source = (function* () {
					try {
						yield Promise.resolve(1);
						yield 2;
					} finally {
						finalized++;
					}
				})();
				for await (const value of helpers.mapAsync(source, double)) {
					expect(value).toBe(2);
					break;
				}
				expect(finalized).toBe(1);
			});
		});

		describe('mapAsync', function () {
			it('maps with an async function, one item at a time, passing the index', async function () {
				let running = 0;
				let maxRunning = 0;
				const result = await helpers.toArrayAsync(
					helpers.mapAsync([1, 2, 3], async function (n, index) {
						running++;
						maxRunning = Math.max(maxRunning, running);
						await Promise.resolve();
						running--;
						return n * 10 + index;
					})
				);
				expect(result).toStrictEqual([10, 21, 32]);
				expect(maxRunning).toBe(1);
			});

			it('accepts async iterables and sync iterables of promises', async function () {
				const { iterable } = asyncSource([1, 2]);
				expect(await helpers.toArrayAsync(helpers.mapAsync(iterable, double))).toStrictEqual([2, 4]);
				const mapped = helpers.mapAsync([Promise.resolve(1), 2], function (n) {
					return n + 1;
				});
				const typed: AsyncIterableIterator<number> = mapped;
				expect(await helpers.toArrayAsync(typed)).toStrictEqual([2, 3]);
			});

			it('closes the source on early exit', async function () {
				const { iterable, stats } = asyncSource([1, 2, 3]);
				for await (const value of helpers.mapAsync(iterable, double)) {
					expect(value).toBe(2);
					break;
				}
				expect(stats.pulled).toBe(1);
				expect(stats.finalized).toBe(1);
			});

			it('validates its arguments synchronously', function () {
				expect(function () {
					helpers.mapAsync(1 as any, double);
				}).toThrow(new TypeError('mapAsync: `iterable` must be iterable, got number'));
				expect(function () {
					helpers.mapAsync([1], 1 as any);
				}).toThrow(TypeError);
			});
		});

		describe('filterAsync', function () {
			it('keeps items matching an async predicate', async function () {
				expect(
					await helpers.toArrayAsync(
						helpers.filterAsync([1, 2, 3, 4], async function (n, index) {
							return isEven(n) && index > 1;
						})
					)
				).toStrictEqual([4]);
			});

			it('narrows the type with a sync type guard', async function () {
				const numbers = await helpers.toArrayAsync(
					helpers.filterAsync([1, 'a'], function (value): value is number {
						return typeof value === 'number';
					})
				);
				const typed: number[] = numbers;
				expect(typed).toStrictEqual([1]);
			});

			it('validates its arguments synchronously', function () {
				expect(function () {
					helpers.filterAsync([1], undefined as any);
				}).toThrow(TypeError);
				expect(function () {
					helpers.filterAsync(undefined as any, isEven);
				}).toThrow(TypeError);
			});
		});

		describe('takeAsync', function () {
			it('takes the first n items, then closes the source', async function () {
				const { iterable, stats } = asyncSource([1, 2, 3, 4]);
				expect(await helpers.toArrayAsync(helpers.takeAsync(iterable, 2))).toStrictEqual([1, 2]);
				expect(stats.pulled).toBe(2);
				expect(stats.finalized).toBe(1);
			});

			it('handles n = 0, Infinity and short sources, and bounds infinite sync sources', async function () {
				const { iterable, stats } = asyncSource([1]);
				expect(await helpers.toArrayAsync(helpers.takeAsync(iterable, 0))).toStrictEqual([]);
				expect(stats.pulled).toBe(0);
				expect(await helpers.toArrayAsync(helpers.takeAsync([1, 2], Infinity))).toStrictEqual([1, 2]);
				expect(await helpers.toArrayAsync(helpers.takeAsync([1, 2], 5))).toStrictEqual([1, 2]);
				const counter = spy(helpers.count());
				expect(await helpers.toArrayAsync(helpers.takeAsync(counter.iterable, 3))).toStrictEqual([0, 1, 2]);
				expect(counter.stats.pulled).toBe(3);
				expect(counter.stats.closed).toBe(1);
			});

			it('validates its arguments synchronously', function () {
				expect(function () {
					helpers.takeAsync([1], -1);
				}).toThrow(new RangeError('takeAsync: `n` must be an integer >= 0 or Infinity, got -1'));
				expect(function () {
					helpers.takeAsync(null as any, 1);
				}).toThrow(TypeError);
			});
		});

		describe('chunkAsync', function () {
			it('splits into chunks', async function () {
				const { iterable } = asyncSource([1, 2, 3, 4, 5]);
				expect(await helpers.toArrayAsync(helpers.chunkAsync(iterable, 2))).toStrictEqual([[1, 2], [3, 4], [5]]);
				expect(await helpers.toArrayAsync(helpers.chunkAsync([1, 2], 2))).toStrictEqual([[1, 2]]);
				expect(await helpers.toArrayAsync(helpers.chunkAsync([], 2))).toStrictEqual([]);
			});

			it('validates its arguments synchronously', function () {
				expect(function () {
					helpers.chunkAsync([1], 0);
				}).toThrow(new RangeError('chunkAsync: `size` must be an integer >= 1, got 0'));
				expect(function () {
					helpers.chunkAsync(1 as any, 1);
				}).toThrow(TypeError);
			});
		});

		describe('toArrayAsync', function () {
			it('collects async and sync iterables, awaiting promises', async function () {
				const { iterable } = asyncSource(['a', 'b']);
				expect(await helpers.toArrayAsync(iterable)).toStrictEqual(['a', 'b']);
				const values = await helpers.toArrayAsync([Promise.resolve(1), 2]);
				const typed: number[] = values;
				expect(typed).toStrictEqual([1, 2]);
			});

			it('rejects when the source fails', async function () {
				const failing = (async function* () {
					yield 1;
					throw new Error('source failed');
				})();
				await expect(helpers.toArrayAsync(failing)).rejects.toThrow('source failed');
			});

			it('throws synchronously for a non-iterable', function () {
				expect(function () {
					helpers.toArrayAsync({} as any);
				}).toThrow(new TypeError('toArrayAsync: `iterable` must be iterable, got object'));
			});
		});
	});

	describe('argument errors', function () {
		function identity(value: unknown): unknown {
			return value;
		}
		const notIterable = 42 as any;
		// [function name, call with a non-iterable source]
		const iterableCases: Array<[string, () => unknown]> = [
			[
				'map',
				function () {
					return helpers.map(notIterable, identity);
				}
			],
			[
				'filter',
				function () {
					return helpers.filter(notIterable, Boolean);
				}
			],
			[
				'flatMap',
				function () {
					return helpers.flatMap(notIterable, function () {
						return [];
					});
				}
			],
			[
				'take',
				function () {
					return helpers.take(notIterable, 1);
				}
			],
			[
				'drop',
				function () {
					return helpers.drop(notIterable, 1);
				}
			],
			[
				'takeWhile',
				function () {
					return helpers.takeWhile(notIterable, Boolean);
				}
			],
			[
				'dropWhile',
				function () {
					return helpers.dropWhile(notIterable, Boolean);
				}
			],
			[
				'chunk',
				function () {
					return helpers.chunk(notIterable, 1);
				}
			],
			[
				'windowed',
				function () {
					return helpers.windowed(notIterable, 1);
				}
			],
			[
				'enumerate',
				function () {
					return helpers.enumerate(notIterable);
				}
			],
			[
				'unique',
				function () {
					return helpers.unique(notIterable);
				}
			],
			[
				'scan',
				function () {
					return helpers.scan(notIterable, identity, 0);
				}
			],
			[
				'tap',
				function () {
					return helpers.tap(notIterable, identity);
				}
			],
			[
				'toArray',
				function () {
					return helpers.toArray(notIterable);
				}
			],
			[
				'reduce',
				function () {
					return helpers.reduce(notIterable, identity, 0);
				}
			],
			[
				'first',
				function () {
					return helpers.first(notIterable);
				}
			],
			[
				'last',
				function () {
					return helpers.last(notIterable);
				}
			],
			[
				'find',
				function () {
					return helpers.find(notIterable, Boolean);
				}
			],
			[
				'some',
				function () {
					return helpers.some(notIterable, Boolean);
				}
			],
			[
				'every',
				function () {
					return helpers.every(notIterable, Boolean);
				}
			],
			[
				'countItems',
				function () {
					return helpers.countItems(notIterable);
				}
			],
			[
				'mapAsync',
				function () {
					return helpers.mapAsync(notIterable, identity);
				}
			],
			[
				'filterAsync',
				function () {
					return helpers.filterAsync(notIterable, Boolean);
				}
			],
			[
				'takeAsync',
				function () {
					return helpers.takeAsync(notIterable, 1);
				}
			],
			[
				'chunkAsync',
				function () {
					return helpers.chunkAsync(notIterable, 1);
				}
			]
		];
		it.each(iterableCases)('%s names itself and `iterable` when the source is not iterable', function (name, call) {
			expect(call).toThrow(new TypeError(`${name}: \`iterable\` must be iterable, got number`));
		});

		const notAFunction = 'nope' as any;
		// [function name, parameter name, call with a non-function callback]
		const functionCases: Array<[string, string, () => unknown]> = [
			[
				'map',
				'fn',
				function () {
					return helpers.map([], notAFunction);
				}
			],
			[
				'filter',
				'predicate',
				function () {
					return helpers.filter([], notAFunction);
				}
			],
			[
				'flatMap',
				'fn',
				function () {
					return helpers.flatMap([], notAFunction);
				}
			],
			[
				'takeWhile',
				'predicate',
				function () {
					return helpers.takeWhile([], notAFunction);
				}
			],
			[
				'dropWhile',
				'predicate',
				function () {
					return helpers.dropWhile([], notAFunction);
				}
			],
			[
				'unique',
				'keyFn',
				function () {
					return helpers.unique([], notAFunction);
				}
			],
			[
				'scan',
				'reducer',
				function () {
					return helpers.scan([], notAFunction, 0);
				}
			],
			[
				'tap',
				'fn',
				function () {
					return helpers.tap([], notAFunction);
				}
			],
			[
				'reduce',
				'reducer',
				function () {
					return helpers.reduce([], notAFunction, 0);
				}
			],
			[
				'find',
				'predicate',
				function () {
					return helpers.find([], notAFunction);
				}
			],
			[
				'some',
				'predicate',
				function () {
					return helpers.some([], notAFunction);
				}
			],
			[
				'every',
				'predicate',
				function () {
					return helpers.every([], notAFunction);
				}
			],
			[
				'countItems',
				'predicate',
				function () {
					return helpers.countItems([], notAFunction);
				}
			],
			[
				'iterate',
				'next',
				function () {
					return helpers.iterate(0, notAFunction);
				}
			],
			[
				'mapAsync',
				'fn',
				function () {
					return helpers.mapAsync([], notAFunction);
				}
			],
			[
				'filterAsync',
				'predicate',
				function () {
					return helpers.filterAsync([], notAFunction);
				}
			]
		];
		it.each(functionCases)('%s names itself and `%s` when the callback is not a function', function (name, parameter, call) {
			expect(call).toThrow(new TypeError(`${name}: \`${parameter}\` must be a function, got string`));
		});
	});
});

describe('mapConcurrent', function () {
	/** An infinite async source counting the items it produced, and whether it was closed. */
	function counter() {
		const stats = { produced: 0, closed: 0 };
		const iterable = (async function* () {
			try {
				for (let i = 0; ; i++) {
					stats.produced++;
					yield i;
				}
			} finally {
				stats.closed++;
			}
		})();
		return { iterable, stats };
	}

	function deferred<T>() {
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const promise = new Promise<T>(function (res, rej) {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	async function ticks(n = 20): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	class FakeSignal {
		aborted = false;
		reason: unknown = undefined;
		readonly listeners = new Set<() => void>();
		addEventListener(_type: 'abort', listener: () => void): void {
			this.listeners.add(listener);
		}
		removeEventListener(_type: 'abort', listener: () => void): void {
			this.listeners.delete(listener);
		}
		abort(reason?: unknown): void {
			this.aborted = true;
			this.reason = reason;
			for (const listener of [...this.listeners]) listener();
		}
	}

	it('maps in source order with at most `concurrency` mappings in flight', async function () {
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await helpers.toArrayAsync(
			helpers.mapConcurrent(
				[5, 1, 4, 2, 3, 0],
				async function (n, index) {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await ticks(n * 3);
					inFlight--;
					return `${index}:${n}`;
				},
				{ concurrency: 3 }
			)
		);
		expect(result).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0']);
		expect(maxInFlight).toBe(3);
	});

	it('yields results as they complete with ordered: false', async function () {
		const result = await helpers.toArrayAsync(
			helpers.mapConcurrent(
				[30, 10, 20],
				async function (n) {
					await ticks(n);
					return n;
				},
				{ concurrency: 3, ordered: false }
			)
		);
		expect(result).toEqual([10, 20, 30]);
	});

	it('applies backpressure: never more than `concurrency` items pulled ahead of the consumer', async function () {
		const { iterable, stats } = counter();
		const iterator = helpers.mapConcurrent(iterable, double, 2);
		expect(stats.produced).toBe(0);
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 0 });
		await ticks();
		// One item consumed, two buffered.
		expect(stats.produced).toBe(3);
		await iterator.next();
		await ticks();
		expect(stats.produced).toBe(4);
		await iterator.return!();
		expect(stats.closed).toBe(1);
	});

	it('closes the source and pulls nothing more on early exit', async function () {
		const { iterable, stats } = counter();
		const unhandled = jest.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const seen: number[] = [];
			for await (const value of helpers.mapConcurrent(
				iterable,
				async function (n) {
					if (n === 5) throw new Error('dropped in flight');
					return n;
				},
				{ concurrency: 4, ordered: false }
			)) {
				seen.push(value);
				if (value === 2) break;
			}
			const produced = stats.produced;
			await ticks();
			await new Promise(setImmediate);
			expect(seen).toContain(2);
			expect(stats.closed).toBe(1);
			expect(stats.produced).toBe(produced);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('throws a mapping error at its position (ordered) and closes the source', async function () {
		const { iterable, stats } = counter();
		const seen: number[] = [];
		await expect(
			(async function () {
				for await (const value of helpers.mapConcurrent(
					iterable,
					function (n) {
						if (n === 3) throw new Error('three');
						return n;
					},
					3
				)) {
					seen.push(value);
				}
			})()
		).rejects.toThrow('three');
		expect(seen).toEqual([0, 1, 2]);
		expect(stats.closed).toBe(1);
	});

	it('throws a source error after the items pulled before it, without closing the failed source', async function () {
		const returned = jest.fn();
		let i = 0;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					next: function () {
						i++;
						return i <= 2 ? Promise.resolve({ done: false, value: i }) : Promise.reject(new Error('source failed'));
					},
					return: function () {
						returned();
						return Promise.resolve({ done: true as const, value: undefined });
					}
				};
			}
		};
		const seen: number[] = [];
		await expect(
			(async function () {
				for await (const value of helpers.mapConcurrent(
					source,
					async function (n) {
						await ticks(5);
						return n * 10;
					},
					{ concurrency: 4, ordered: false }
				))
					seen.push(value);
			})()
		).rejects.toThrow('source failed');
		expect(seen).toEqual([10, 20]);
		expect(returned).not.toHaveBeenCalled();
	});

	it('accepts sync iterables of values and promises, closing them on early exit', async function () {
		const { iterable, stats } = spy([1, Promise.resolve(2), 3, 4]);
		const iterator = helpers.mapConcurrent(iterable, double, Infinity);
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 2 });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 4 });
		await iterator.return!();
		expect(stats.closed).toBe(1);
		await expect(helpers.toArrayAsync(helpers.mapConcurrent([], double, 1))).resolves.toEqual([]);
	});

	it('passes the index and the signal to fn', async function () {
		const signal = new FakeSignal();
		const calls: unknown[][] = [];
		await helpers.toArrayAsync(
			helpers.mapConcurrent(
				['a', 'b'],
				function (value, index, received) {
					calls.push([value, index, received]);
					return value;
				},
				{ concurrency: 1, signal }
			)
		);
		expect(calls).toEqual([
			['a', 0, signal],
			['b', 1, signal]
		]);
		expect(signal.listeners.size).toBe(0);
	});

	it('aborting rejects the pending read with the reason, stops pulling and closes the source', async function () {
		const { iterable, stats } = counter();
		const signal = new FakeSignal();
		const gate = deferred<number>();
		const iterator = helpers.mapConcurrent(
			iterable,
			function () {
				return gate.promise;
			},
			{ concurrency: 2, signal }
		);
		const pending = iterator.next();
		await ticks();
		const produced = stats.produced;
		signal.abort('cancelled');
		await expect(pending).rejects.toBe('cancelled');
		expect(stats.closed).toBe(1);
		expect(signal.listeners.size).toBe(0);
		gate.resolve(1);
		await ticks();
		expect(stats.produced).toBe(produced);
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
	});

	it('throws at the next read when aborted between reads, and does not start for an aborted signal', async function () {
		const signal = new FakeSignal();
		const iterator = helpers.mapConcurrent([1, 2, 3], double, { concurrency: 1, signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 2 });
		signal.abort();
		await expect(iterator.next()).rejects.toThrow('The operation was aborted.');
		const fn = jest.fn();
		const aborted = new FakeSignal();
		aborted.abort('early');
		const { iterable, stats } = counter();
		await expect(helpers.mapConcurrent(iterable, fn, { concurrency: 1, signal: aborted }).next()).rejects.toBe('early');
		expect(fn).not.toHaveBeenCalled();
		expect(stats.produced).toBe(0);
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.mapConcurrent(5 as any, double, 1);
		}).toThrow(new TypeError('mapConcurrent: `iterable` must be iterable, got number'));
		expect(function () {
			helpers.mapConcurrent([1], 'x' as any, 1);
		}).toThrow(new TypeError('mapConcurrent: `fn` must be a function, got string'));
		expect(function () {
			helpers.mapConcurrent([1], double, 0);
		}).toThrow(new RangeError('mapConcurrent: `concurrency` must be an integer >= 1 or Infinity, got 0'));
		expect(function () {
			helpers.mapConcurrent([1], double, {} as any);
		}).toThrow(new TypeError('mapConcurrent: `concurrency` must be an integer >= 1 or Infinity, got undefined'));
		expect(function () {
			helpers.mapConcurrent([1], double, { concurrency: 1, signal: { addEventListener() {} } as any });
		}).toThrow(new TypeError('mapConcurrent: `signal` must be an AbortSignal, null or undefined, got object'));
		expect(function () {
			helpers.mapConcurrent([1], double, { concurrency: 1, signal: 'x' as any });
		}).toThrow(new TypeError('mapConcurrent: `signal` must be an AbortSignal, null or undefined, got string'));
		expect(helpers.mapConcurrent([1], double, { concurrency: 1, signal: null })).toBeDefined();
	});
});
