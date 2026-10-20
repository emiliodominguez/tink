import * as helpers from '.';
import type { AbortSignalLike } from '../utils/index.js';
import { Readable } from 'node:stream';

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
		it('rejects an iterator that is not an object before pulling anything', function () {
			let pulled = 0;
			const counted: Iterable<number> = {
				[Symbol.iterator]() {
					return {
						next() {
							pulled++;
							return { done: false, value: 1 };
						}
					};
				}
			};
			const broken = {
				[Symbol.iterator]() {
					return 42;
				}
			} as unknown as Iterable<number>;
			expect(function () {
				helpers.toArray(helpers.zip(counted, broken));
			}).toThrow(new TypeError('zip: an iterator must be an object, got number'));
			expect(pulled).toBe(0);
		});

		it('stops on any truthy done, like for...of', function () {
			let i = 0;
			const loose: Iterable<number> = {
				[Symbol.iterator](): Iterator<number> {
					return {
						next(): IteratorResult<number> {
							return (i < 2 ? { done: false, value: i++ } : { done: 1, value: undefined }) as IteratorResult<number>;
						}
					};
				}
			};
			expect(helpers.toArray(helpers.zip(loose, [10, 20, 30]))).toEqual([
				[0, 10],
				[1, 20]
			]);
		});

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
	/**
	 * A hand-written async iterator (no async generator): `next` returns what `step` gives for each pull, and calls are logged.
	 */
	function handWritten(step: (pull: number) => unknown, onReturn: () => unknown = function () {}): { iterable: AsyncIterable<number>; log: string[] } {
		const log: string[] = [];
		let pulls = 0;
		const iterable = {
			[Symbol.asyncIterator]: function () {
				return {
					next: function () {
						log.push('next');
						return step(pulls++);
					},
					return: function () {
						log.push('return');
						return onReturn();
					}
				};
			}
		} as unknown as AsyncIterable<number>;
		return { iterable, log };
	}

	function identity(value: number): number {
		return value;
	}

	function boom(): never {
		throw new Error('boom');
	}

	it('rejects with the error of a next() that throws synchronously, without closing that source', async function () {
		const first = handWritten(function () {
			throw new Error('sync next');
		});
		await expect(helpers.toArrayAsync(helpers.mapConcurrent(first.iterable, identity, 1))).rejects.toThrow('sync next');
		expect(first.log).toEqual(['next']);
		const later = handWritten(function (pull) {
			if (pull === 1) throw new Error('second pull');
			return Promise.resolve({ done: false, value: pull });
		});
		await expect(helpers.toArrayAsync(helpers.mapConcurrent(later.iterable, identity, 2))).rejects.toThrow('second pull');
		expect(later.log).toEqual(['next', 'next']);
	});

	it('rejects (without closing the source) for results that are not objects or whose done or value getters throw', async function () {
		for (const result of [null, 42, Object.defineProperty({}, 'done', { get: boom }), Object.defineProperty({ done: false }, 'value', { get: boom })]) {
			const source = handWritten(function () {
				return Promise.resolve(result);
			});
			await expect(helpers.toArrayAsync(helpers.mapConcurrent(source.iterable, identity, 1))).rejects.toThrow();
			expect(source.log).toEqual(['next']);
		}
	});

	it('closes the source and ignores a throwing removeEventListener; closes it too when addEventListener throws', async function () {
		function signal(add: boolean, remove: boolean): AbortSignalLike {
			return {
				aborted: false,
				addEventListener: add ? boom : function () {},
				removeEventListener: remove ? boom : function () {}
			} as unknown as AbortSignalLike;
		}
		const finished = handWritten(function (pull) {
			return Promise.resolve(pull < 2 ? { done: false, value: pull } : { done: true, value: undefined });
		});
		await expect(helpers.toArrayAsync(helpers.mapConcurrent(finished.iterable, identity, { concurrency: 1, signal: signal(false, true) }))).resolves.toEqual([0, 1]);
		const broken = handWritten(function (pull) {
			return Promise.resolve({ done: false, value: pull });
		});
		await expect(
			(async function () {
				for await (const value of helpers.mapConcurrent(broken.iterable, identity, { concurrency: 1, signal: signal(false, true) })) if (value === 0) break;
			})()
		).resolves.toBeUndefined();
		expect(broken.log).toContain('return');
		const unlistened = handWritten(function (pull) {
			return Promise.resolve({ done: false, value: pull });
		});
		await expect(helpers.mapConcurrent(unlistened.iterable, identity, { concurrency: 1, signal: signal(true, false) }).next()).rejects.toThrow('boom');
		expect(unlistened.log).toEqual(['return']);
	});

	it('stops on an abort event even when the signal-like object does not report aborted', async function () {
		let listener: (() => void) | undefined;
		const lying = {
			aborted: false,
			reason: new Error('stop'),
			addEventListener(_type: string, callback: () => void) {
				listener = callback;
			},
			removeEventListener() {}
		} as unknown as AbortSignalLike;
		const iterator = helpers.mapConcurrent(
			(async function* () {
				yield 1;
				await new Promise(function () {});
			})(),
			identity,
			{ concurrency: 1, signal: lying }
		);
		expect(await iterator.next()).toEqual({ done: false, value: 1 });
		const pending = iterator.next();
		listener?.();
		await expect(pending).rejects.toThrow('stop');
	});

	it('accepts a next() that returns a plain result, like for await', async function () {
		const plain = handWritten(function (pull) {
			return pull < 3 ? { done: false, value: pull } : { done: true, value: undefined };
		});
		await expect(helpers.toArrayAsync(helpers.mapConcurrent(plain.iterable, identity, 2))).resolves.toEqual([0, 1, 2]);
	});

	it('reports the error the iteration failed with, not a failure to close the source', async function () {
		function source(): AsyncIterable<number> {
			return handWritten(
				function (pull) {
					return Promise.resolve({ done: false, value: pull });
				},
				function () {
					return Promise.reject(new Error('cannot close'));
				}
			).iterable;
		}
		await expect(
			helpers.toArrayAsync(
				helpers.mapConcurrent(
					source(),
					async function () {
						throw new Error('mapping failed');
					},
					1
				)
			)
		).rejects.toThrow('mapping failed');
		const controller = new AbortController();
		const reason = new Error('aborted');
		await expect(
			helpers.toArrayAsync(
				helpers.mapConcurrent(
					source(),
					function (value: number) {
						if (value === 1) controller.abort(reason);
						return value;
					},
					{ concurrency: 1, signal: controller.signal }
				)
			)
		).rejects.toBe(reason);
		// Closing after a `break` still reports its failure.
		await expect(
			(async function () {
				for await (const value of helpers.mapConcurrent(source(), identity, 1)) if (value === 0) break;
			})()
		).rejects.toThrow('cannot close');
	});

	/**
	 * Yields 1, then waits forever (an idle stream).
	 */
	async function* idle(): AsyncGenerator<number> {
		yield 1;
		await new Promise(function () {});
	}

	/**
	 * An async iterator whose second pull never settles, with the given `return`.
	 */
	function stalled(onReturn: () => unknown): AsyncIterable<number> {
		let pulls = 0;
		return {
			[Symbol.asyncIterator]: function () {
				return {
					next: function (): Promise<IteratorResult<number>> {
						pulls++;
						return pulls === 1 ? Promise.resolve({ done: false, value: 1 }) : new Promise(function () {});
					},
					return: onReturn as () => Promise<IteratorResult<number>>
				};
			}
		};
	}

	it('rejects a pending read on abort while a source pull is pending', async function () {
		const controller = new AbortController();
		const iterator = helpers.mapConcurrent(
			idle(),
			function (value) {
				return value;
			},
			{ concurrency: 1, signal: controller.signal }
		);
		expect(await iterator.next()).toEqual({ done: false, value: 1 });
		const pending = iterator.next();
		controller.abort(new Error('aborted'));
		await expect(pending).rejects.toThrow('aborted');
	});

	it('lets an early exit finish while a source pull is pending, and still requests the close', async function () {
		let exited = false;
		for await (const value of helpers.mapConcurrent(
			idle(),
			function (item) {
				return item;
			},
			1
		)) {
			expect(value).toBe(1);
			break;
		}
		exited = true;
		expect(exited).toBe(true);

		const closes: string[] = [];
		for await (const value of helpers.mapConcurrent(
			stalled(function () {
				closes.push('rejecting');
				return Promise.reject(new Error('cannot close'));
			}),
			function (item) {
				return item;
			},
			1
		)) {
			expect(value).toBe(1);
			break;
		}
		for await (const value of helpers.mapConcurrent(
			stalled(function () {
				closes.push('throwing');
				throw new Error('cannot close');
			}),
			function (item) {
				return item;
			},
			1
		)) {
			expect(value).toBe(1);
			break;
		}
		await new Promise(setImmediate);
		expect(closes).toEqual(['rejecting', 'throwing']);
	});

	it('pulls nothing more once a mapping failed', async function () {
		const pulled: number[] = [];
		/**
		 * Counts up forever, recording each pull.
		 */
		async function* counting(): AsyncGenerator<number> {
			for (let index = 0; ; index++) {
				pulled.push(index);
				yield index;
			}
		}
		await expect(
			helpers.toArrayAsync(
				helpers.mapConcurrent(
					counting(),
					async function (value) {
						throw new Error(`fn ${value}`);
					},
					1
				)
			)
		).rejects.toThrow('fn 0');
		expect(pulled).toEqual([0]);
	});

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

// ---------------------------------------------------------------------------------------------------------------------
// 1.4.0: stream readers and combinators
// ---------------------------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function bytes(...values: number[]): Uint8Array {
	return new Uint8Array(values);
}

function settle(n = 30): Promise<void> {
	let promise = Promise.resolve();
	for (let i = 0; i < n; i++) promise = promise.then();
	return promise;
}

function deferredValue<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>(function (res, rej) {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class TestSignal {
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

/**
 * A pull-based WHATWG stream over the chunks (then closed, or left open with `idle`), recording reads and cancellation.
 */
function webStream<T>(chunks: T[], options: { idle?: boolean; error?: unknown } = {}) {
	const stats = { pulls: 0, cancelled: 0, reason: undefined as unknown };
	let index = 0;
	const stream = new ReadableStream<T>(
		{
			pull(controller) {
				stats.pulls++;
				if (index < chunks.length) controller.enqueue(chunks[index++]);
				else if (options.error !== undefined) controller.error(options.error);
				else if (!options.idle) controller.close();
				else return new Promise<void>(function () {});
				return undefined;
			},
			cancel(reason) {
				stats.cancelled++;
				stats.reason = reason;
			}
		},
		{ highWaterMark: 0 }
	);
	return { stream, stats };
}

/** An endless stream of the same chunk. */
function endless<T>(chunk: T) {
	const stats = { cancelled: 0, reason: undefined as unknown };
	const stream = new ReadableStream<T>(
		{
			pull(controller) {
				controller.enqueue(chunk);
			},
			cancel(reason) {
				stats.cancelled++;
				stats.reason = reason;
			}
		},
		{ highWaterMark: 0 }
	);
	return { stream, stats };
}

/** A hand-made stream-like object whose reader is fully scripted. */
function fakeStream(reader: Partial<helpers.ReadableStreamReaderLike<unknown>>) {
	const stats = { released: 0, cancelled: 0 };
	const stream: helpers.ReadableStreamLike<unknown> = {
		getReader() {
			return {
				read:
					reader.read ??
					async function () {
						return { done: true };
					},
				cancel:
					reader.cancel ??
					async function () {
						stats.cancelled++;
					},
				releaseLock:
					reader.releaseLock ??
					function () {
						stats.released++;
					}
			};
		}
	};
	return { stream, stats };
}

/** An async generator over the values, recording whether it was closed (its `finally` ran). */
function generatorSource<T>(values: T[]) {
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

describe('readLines', function () {
	async function lines(source: helpers.TextStreamSource, options?: helpers.ReadLinesOptions): Promise<string[]> {
		return helpers.toArrayAsync(helpers.readLines(source, options));
	}

	it('splits on LF, CRLF and lone CR, without the line breaks', async function () {
		expect(await lines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
		expect(await lines('\r\r\n\n')).toEqual(['', '', '']);
		expect(await lines('x\r\ry')).toEqual(['x', '', 'y']);
		expect(await lines('\n\r')).toEqual(['', '']);
	});

	it('treats a CR ending a chunk and a LF starting the next one as one break (also across empty chunks)', async function () {
		expect(await lines(['a\r', '\nb'])).toEqual(['a', 'b']);
		expect(await lines(['a\r', '', '', '\nb'])).toEqual(['a', 'b']);
		expect(await lines(['a\r', 'b'])).toEqual(['a', 'b']);
		expect(await lines(['a\r', '\r', '\n', 'b'])).toEqual(['a', '', 'b']);
		expect(await lines(['a\r', '\n\n'])).toEqual(['a', '']);
		expect(await lines(['a\r'])).toEqual(['a']);
		expect(await lines([bytes(0x61, 0x0d), bytes(0x0a, 0x62)])).toEqual(['a', 'b']);
	});

	it('yields the last line when it is not empty, like readline', async function () {
		expect(await lines('')).toEqual([]);
		expect(await lines('\n')).toEqual(['']);
		expect(await lines('a')).toEqual(['a']);
		expect(await lines('a\n')).toEqual(['a']);
		expect(await lines('a\n\n')).toEqual(['a', '']);
		expect(await lines('a\r\n')).toEqual(['a']);
		expect(await lines(['a', 'b', 'c'])).toEqual(['abc']);
		expect(await lines(['', '', ''])).toEqual([]);
		expect(await lines([])).toEqual([]);
	});

	it('joins a line split over many chunks', async function () {
		expect(await lines(['he', 'll', 'o\nwor', 'ld\n', 'x'])).toEqual(['hello', 'world', 'x']);
		expect(await lines(['ab', 'c\r', '\nd', 'e\r', 'f'])).toEqual(['abc', 'de', 'f']);
	});

	it('reads whole strings and Uint8Arrays as one chunk', async function () {
		expect(await lines('a\nb')).toEqual(['a', 'b']);
		expect(await lines(encoder.encode('a\nb'))).toEqual(['a', 'b']);
		expect(await lines(Buffer.from('é\r\nü'))).toEqual(['é', 'ü']);
	});

	it('reads WHATWG streams, Node streams, async generators and sync iterables of promises', async function () {
		expect(await lines(webStream([encoder.encode('a\nb'), encoder.encode('\nc')]).stream)).toEqual(['a', 'b', 'c']);
		expect(await lines(new Response('x\ny\n').body!)).toEqual(['x', 'y']);
		expect(await lines(new Blob(['p\r\nq']).stream())).toEqual(['p', 'q']);
		expect(await lines(Readable.from([Buffer.from('1\n2'), Buffer.from('\n3')]))).toEqual(['1', '2', '3']);
		expect(await lines(generatorSource(['k\n', 'l']).iterable)).toEqual(['k', 'l']);
		expect(await lines([Promise.resolve('m\n'), 'n'])).toEqual(['m', 'n']);
		expect(await lines(new Set(['s\nt']))).toEqual(['s', 't']);
	});

	it('decodes UTF-8 incrementally: characters split across chunks, malformed bytes, a truncated end', async function () {
		const emoji = encoder.encode('😀\n');
		expect(
			await lines(
				Array.from(emoji, function (byte) {
					return bytes(byte);
				})
			)
		).toEqual(['😀']);
		// The maximal subparts of malformed sequences become one U+FFFD each, as TextDecoder does on the whole input.
		const malformed = bytes(0x61, 0xff, 0xe2, 0x82, 0x0a, 0xf0, 0x9f, 0x98, 0x62, 0xed, 0xa0, 0x80);
		const expected = new TextDecoder().decode(malformed).split('\n');
		expect(await lines([malformed.subarray(0, 3), malformed.subarray(3, 7), malformed.subarray(7)])).toEqual(expected);
		expect(await lines([bytes(0x61, 0xe2, 0x82)])).toEqual(['a\uFFFD']);
		// A string chunk interrupts an incomplete character, an empty one does not.
		expect(await lines([bytes(0x61, 0xc3), 'b'])).toEqual(['a\uFFFDb']);
		expect(await lines([bytes(0x61, 0xc3), '', bytes(0xa9)])).toEqual(['aé']);
		expect(await lines(['x', bytes(0xc3, 0xa9), 'y\n', bytes(0x7a)])).toEqual(['xéy', 'z']);
	});

	it('needs TextDecoder for bytes only', async function () {
		const original = globalThis.TextDecoder;
		delete (globalThis as { TextDecoder?: unknown }).TextDecoder;
		try {
			expect(await lines('a\nb')).toEqual(['a', 'b']);
			await expect(lines([bytes(0x61)])).rejects.toThrow(new TypeError('readLines: decoding Uint8Array chunks needs TextDecoder, which this runtime lacks'));
		} finally {
			globalThis.TextDecoder = original;
		}
	});

	it('drops a byte order mark at the very start only, whether it comes as bytes or as text', async function () {
		expect(await lines([bytes(0xef, 0xbb), bytes(0xbf, 0x61)])).toEqual(['a']);
		expect(await lines(['', '\uFEFFa\n\uFEFFb'])).toEqual(['a', '\uFEFFb']);
		expect(await lines(['\uFEFF\uFEFFa'])).toEqual(['\uFEFFa']);
		expect(await lines(['a', '\uFEFFb'])).toEqual(['a\uFEFFb']);
		expect(await lines([bytes(0xef, 0xbb, 0xbf)])).toEqual([]);
	});

	it('runs in linear time on one huge line split over many chunks', async function () {
		const piece = 'x'.repeat(200);
		const chunks = new Array<string>(20_000).fill(piece);
		chunks.push('\nend');
		const start = Date.now();
		const result = await lines(chunks);
		expect(Date.now() - start).toBeLessThan(5000);
		expect(result.length).toBe(2);
		expect(result[0].length).toBe(4_000_000);
		expect(result[1]).toBe('end');
	});

	it('throws a RangeError for a line longer than maxLineLength, as soon as it is buffered, and cancels the stream', async function () {
		expect(await lines('abc\nde\n', { maxLineLength: 3 })).toEqual(['abc', 'de']);
		expect(await lines(['ab', 'c'], { maxLineLength: 3 })).toEqual(['abc']);
		expect(await lines('\n\n', { maxLineLength: 0 })).toEqual(['', '']);
		await expect(lines('abc\nabcd\n', { maxLineLength: 3 })).rejects.toThrow(new RangeError('readLines: line 2 is longer than `maxLineLength` (3)'));
		await expect(lines(['ab', 'cd'], { maxLineLength: 3 })).rejects.toThrow(new RangeError('readLines: line 1 is longer than `maxLineLength` (3)'));
		await expect(lines(['x\nab', 'cd\n'], { maxLineLength: 3 })).rejects.toThrow(new RangeError('readLines: line 2 is longer than `maxLineLength` (3)'));
		await expect(lines('a\nabcd', { maxLineLength: 3 })).rejects.toThrow(new RangeError('readLines: line 2 is longer than `maxLineLength` (3)'));
		await expect(lines('x', { maxLineLength: 0 })).rejects.toThrow(RangeError);
		// A stream that never sends a line break.
		const { stream, stats } = endless('xxxxxxxxxx');
		await expect(lines(stream, { maxLineLength: 1000 })).rejects.toThrow(new RangeError('readLines: line 1 is longer than `maxLineLength` (1000)'));
		expect(stats.cancelled).toBe(1);
		expect(stats.reason).toBeInstanceOf(RangeError);
		expect(stream.locked).toBe(false);
	});

	it('yields the lines before a line longer than maxLineLength first, wherever the chunks are cut (regression)', async function () {
		for (const source of ['ok\nyes\ntoo long\nz\n', ['ok\nyes\ntoo long\nz\n'], ['ok\n', 'yes\ntoo long\nz\n'], ['ok\nyes\nto', 'o long\n']]) {
			const iterator = helpers.readLines(source, { maxLineLength: 5 });
			await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ok' });
			await expect(iterator.next()).resolves.toEqual({ done: false, value: 'yes' });
			await expect(iterator.next()).rejects.toThrow(new RangeError('readLines: line 3 is longer than `maxLineLength` (5)'));
			await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		}
		// Also for the unfinished last line, flushed at the end.
		const last = helpers.readLines([bytes(0x61, 0x0a, 0x62, 0x63, 0xe2)], { maxLineLength: 2 });
		await expect(last.next()).resolves.toEqual({ done: false, value: 'a' });
		await expect(last.next()).rejects.toThrow(new RangeError('readLines: line 2 is longer than `maxLineLength` (2)'));
	});

	it('throws the abort reason rather than the maxLineLength error when aborted while the line before it is held', async function () {
		const signal = new TestSignal();
		const iterator = helpers.readLines('ok\ntoo long\n', { maxLineLength: 3, signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ok' });
		signal.abort('stop');
		await expect(iterator.next()).rejects.toBe('stop');
	});

	it('cancels the stream and releases its lock when the loop stops early', async function () {
		const { stream, stats } = endless('line\n');
		for await (const line of helpers.readLines(stream)) {
			expect(line).toBe('line');
			break;
		}
		expect(stats).toEqual({ cancelled: 1, reason: undefined });
		expect(stream.locked).toBe(false);
	});

	it('closes an async iterable source on early exit, and leaves it alone when it ends or fails', async function () {
		const early = generatorSource(['a\nb\n', 'c\n']);
		for await (const line of helpers.readLines(early.iterable)) {
			expect(line).toBe('a');
			break;
		}
		expect(early.stats).toEqual({ pulled: 1, finalized: 1 });
		const full = generatorSource(['a\n']);
		await lines(full.iterable);
		expect(full.stats).toEqual({ pulled: 1, finalized: 1 });
		const error = new Error('boom');
		let closed = 0;
		const failing = {
			[Symbol.asyncIterator]() {
				return {
					next: async function () {
						throw error;
					},
					return: async function () {
						closed++;
						return { done: true as const, value: undefined };
					}
				};
			}
		};
		await expect(lines(failing)).rejects.toBe(error);
		expect(closed).toBe(0);
	});

	it('throws the error of a failing stream without cancelling it, and releases the lock', async function () {
		const error = new Error('network');
		const { stream, stats } = webStream([encoder.encode('a\nb')], { error });
		const iterator = helpers.readLines(stream);
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a' });
		await expect(iterator.next()).rejects.toBe(error);
		expect(stats.cancelled).toBe(0);
		expect(stream.locked).toBe(false);
	});

	it('rejects bad chunks with a TypeError and cancels the stream with it', async function () {
		const { stream, stats } = webStream<unknown>(['a\n', 42, 'b']);
		await expect(lines(stream as ReadableStream<string>)).rejects.toThrow(new TypeError('readLines: a chunk must be a string or a Uint8Array, got number'));
		expect(stats.cancelled).toBe(1);
		expect(stats.reason).toBeInstanceOf(TypeError);
		await expect(lines([new Uint16Array(2) as any])).rejects.toThrow(new TypeError('readLines: a chunk must be a string or a Uint8Array, got object'));
		await expect(lines([null as any])).rejects.toThrow(new TypeError('readLines: a chunk must be a string or a Uint8Array, got null'));
	});

	it('reports read results that are not objects, and reads that throw synchronously, without cancelling', async function () {
		const plain = fakeStream({
			read: function () {
				return 5 as any;
			}
		});
		await expect(lines(plain.stream as any)).rejects.toThrow(new TypeError('readLines: the source returned a read result that is not an object, got number'));
		expect(plain.stats).toEqual({ released: 1, cancelled: 0 });
		const nulls = fakeStream({
			read: async function () {
				return null as any;
			}
		});
		await expect(lines(nulls.stream as any)).rejects.toThrow('got null');
		const error = new Error('sync');
		const throwing = fakeStream({
			read: function () {
				throw error;
			}
		});
		await expect(lines(throwing.stream as any)).rejects.toBe(error);
		expect(throwing.stats).toEqual({ released: 1, cancelled: 0 });
	});

	it('accepts reads that return plain results', async function () {
		const queue = [{ done: false, value: 'a\n' }, { done: false, value: 'b' }, { done: true }];
		const { stream } = fakeStream({
			read: function () {
				return queue.shift() as any;
			}
		});
		expect(await lines(stream as any)).toEqual(['a', 'b']);
	});

	it('propagates a failure to cancel on early exit, but not when the reading already failed', async function () {
		const error = new Error('cancel failed');
		const queue = ['a\nb\n', 'c'];
		const rejecting = fakeStream({
			read: async function () {
				return { done: false, value: queue.shift() };
			},
			cancel: async function () {
				throw error;
			}
		});
		const iterator = helpers.readLines(rejecting.stream as any);
		await iterator.next();
		await expect(iterator.return!()).rejects.toBe(error);
		expect(rejecting.stats.released).toBe(1);
		const bad = fakeStream({
			read: async function () {
				return { done: false, value: 7 };
			},
			cancel: function () {
				throw error;
			},
			releaseLock: function () {
				throw new Error('release failed');
			}
		});
		await expect(lines(bad.stream as any)).rejects.toThrow(TypeError);
	});

	it('aborting cancels an idle stream at once and rejects the pending read with the reason', async function () {
		const { stream, stats } = webStream<string>([], { idle: true });
		const controller = new AbortController();
		const pending = lines(stream, { signal: controller.signal });
		await settle();
		const reason = new Error('stop');
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(stats).toEqual({ pulls: 1, cancelled: 1, reason });
		expect(stream.locked).toBe(false);
	});

	it('aborting closes an async generator source without waiting for its pending read', async function () {
		const gate = deferredValue<string>();
		let finalized = 0;
		const source = (async function* () {
			try {
				yield await gate.promise;
			} finally {
				finalized++;
			}
		})();
		const signal = new TestSignal();
		const pending = lines(source, { signal });
		await settle();
		signal.abort('bye');
		await expect(pending).rejects.toBe('bye');
		expect(signal.listeners.size).toBe(0);
		gate.resolve('late\n');
		await settle();
		expect(finalized).toBe(1);
	});

	it('aborting between reads cancels the stream at once, and no buffered line is yielded after it', async function () {
		const { stream, stats } = webStream(['a\nb\nc\n', 'd\n']);
		const signal = new TestSignal();
		const iterator = helpers.readLines(stream, { signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a' });
		signal.abort('enough');
		expect(stats.cancelled).toBe(1);
		// A second abort event changes nothing.
		signal.abort('again');
		expect(stats.cancelled).toBe(1);
		await expect(iterator.next()).rejects.toBe('enough');
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		expect(stream.locked).toBe(false);
	});

	it('throws an AbortError for a signal aborted without a reason, and cancels a stream at the first read when already aborted', async function () {
		const { stream, stats } = webStream(['a\n']);
		const signal = new TestSignal();
		signal.abort();
		const read = lines(stream, { signal });
		await expect(read).rejects.toThrow('The operation was aborted.');
		await expect(read).rejects.toMatchObject({ name: 'AbortError' });
		expect(stats.cancelled).toBe(1);
		expect(stream.locked).toBe(false);
		expect(signal.listeners.size).toBe(0);
		await expect(lines('a', { signal })).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('notices a signal-like object that sets aborted without dispatching, and cancels the stream', async function () {
		const { stream, stats } = webStream(['a\nb\n', 'c\n']);
		const signal = new TestSignal();
		const iterator = helpers.readLines(stream, { signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a' });
		signal.aborted = true;
		signal.reason = 'silent';
		await expect(iterator.next()).rejects.toBe('silent');
		expect(stats.cancelled).toBe(1);
		expect(stats.reason).toBe('silent');
	});

	it('drops a chunk that arrives while the signal is being aborted', async function () {
		const gate = deferredValue<{ done: boolean; value?: unknown }>();
		const signal = new TestSignal();
		const { stream, stats } = fakeStream({
			read: function () {
				return gate.promise;
			}
		});
		const iterator = helpers.readLines(stream as any, { signal });
		const pending = iterator.next();
		await settle();
		gate.resolve({ done: false, value: 'late\n' });
		signal.aborted = true;
		signal.reason = 'raced';
		await expect(pending).rejects.toBe('raced');
		expect(stats.cancelled).toBe(1);
	});

	it('ignores a throwing cancel or releaseLock while aborting', async function () {
		const signal = new TestSignal();
		const { stream } = fakeStream({
			read: function () {
				return new Promise(function () {});
			},
			cancel: function () {
				throw new Error('cancel');
			},
			releaseLock: function () {
				throw new Error('release');
			}
		});
		const pending = lines(stream as any, { signal });
		await settle();
		signal.abort('x');
		await expect(pending).rejects.toBe('x');
	});

	it('removes the abort listener once done, and still cancels the stream when adding it throws', async function () {
		const signal = new TestSignal();
		expect(await lines(['a\nb'], { signal })).toEqual(['a', 'b']);
		expect(signal.listeners.size).toBe(0);
		const { stream, stats } = webStream(['a']);
		const error = new Error('listener');
		const broken = {
			aborted: false,
			addEventListener() {
				throw error;
			},
			removeEventListener() {}
		};
		await expect(lines(stream, { signal: broken })).rejects.toBe(error);
		expect(stats.cancelled).toBe(1);
	});

	it('throws when the stream is already locked', async function () {
		const { stream } = webStream(['a']);
		stream.getReader();
		await expect(lines(stream)).rejects.toMatchObject({ name: 'TypeError' });
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.readLines(5 as any);
		}).toThrow(new TypeError('readLines: `source` must be a ReadableStream or an (async) iterable, got number'));
		expect(function () {
			helpers.readLines(null as any);
		}).toThrow(new TypeError('readLines: `source` must be a ReadableStream or an (async) iterable, got null'));
		expect(function () {
			helpers.readLines({ getReader: 1 } as any);
		}).toThrow(TypeError);
		expect(function () {
			helpers.readLines('', 5 as any);
		}).toThrow(new TypeError('readLines: `options` must be an object, got number'));
		expect(function () {
			helpers.readLines('', null as any);
		}).toThrow(new TypeError('readLines: `options` must be an object, got null'));
		expect(function () {
			helpers.readLines('', { maxLineLength: -1 });
		}).toThrow(new RangeError('readLines: `maxLineLength` must be an integer >= 0 or Infinity, got -1'));
		expect(function () {
			helpers.readLines('', { maxLineLength: 1.5 });
		}).toThrow(RangeError);
		expect(function () {
			helpers.readLines('', { maxLineLength: '5' as any });
		}).toThrow(new TypeError('readLines: `maxLineLength` must be an integer >= 0 or Infinity, got string'));
		expect(function () {
			helpers.readLines('', { signal: {} as any });
		}).toThrow(new TypeError('readLines: `signal` must be an AbortSignal, null or undefined, got object'));
		expect(helpers.readLines('', { signal: null, maxLineLength: Infinity })).toBeDefined();
	});

	it('ignores options inherited from a polluted Object.prototype', async function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.maxLineLength = 1;
		try {
			expect(await lines('abc\n', {})).toEqual(['abc']);
			expect(await lines('abc\n')).toEqual(['abc']);
		} finally {
			delete proto.maxLineLength;
		}
	});
});

describe('parseSSE', function () {
	async function events(source: helpers.TextStreamSource, options?: helpers.ParseSSEOptions): Promise<helpers.ServerSentEvent[]> {
		return helpers.toArrayAsync(helpers.parseSSE(source, options));
	}

	function datas(list: helpers.ServerSentEvent[]): string[] {
		return list.map(function (event) {
			return event.data;
		});
	}

	it('parses events with their type, data and last event ID', async function () {
		expect(await events('event: add\ndata: 1\nid: a\n\ndata: 2\n\n')).toEqual([
			{ event: 'add', data: '1', id: 'a' },
			{ event: 'message', data: '2', id: 'a' }
		]);
	});

	// The cases below follow the WHATWG HTML "event stream interpretation" algorithm and the web-platform-tests eventsource/format-*.
	it('format-field-parsing: case-sensitive fields, one leading space removed, unknown fields ignored', async function () {
		const stream = 'data:\0\ndata:  2\rData:1\ndata\0:2\ndata:1\r\0data:4\nda-ta:3\rdata_5\ndata:3\rdata:\r\n data:32\ndata:4\n\n';
		expect(datas(await events(stream))).toEqual(['\0\n 2\n1\n3\n\n4']);
	});

	it('format-comments: comment lines, with any line ending, are ignored', async function () {
		const long = 'x'.repeat(2049);
		const stream = 'data:1\r:\0\n:\r\ndata:2\n:' + long + '\rdata:3\n:data:fail\r:' + long + '\ndata:4\n\n';
		expect(datas(await events(stream))).toEqual(['1\n2\n3\n4']);
	});

	it('format-field-data: an empty data field counts, and one trailing LF is removed', async function () {
		expect(datas(await events('data:\n\ndata\ndata\n\ndata:test\n\n'))).toEqual(['', '\n', 'test']);
	});

	it('format-field-unknown and format-newlines', async function () {
		expect(datas(await events('data:test\n data\ndata\nfoobar:xxx\njustsometext\n:thisisacommentyay\ndata:test\n\n'))).toEqual(['test\n\ntest']);
		expect(datas(await events('data:test\r\ndata\ndata:test\r\n\r\n'))).toEqual(['test\n\ntest']);
		expect(datas(await events('data:\ttest\rdata: \ndata:test\n\n'))).toEqual(['\ttest\n\ntest']);
	});

	it('format-field-event: the event type, reset after each block, also after a block without data', async function () {
		expect(await events('event:test\ndata\n\n')).toEqual([{ event: 'test', data: '', id: '' }]);
		expect(await events('event: \ndata:data\n\n')).toEqual([{ event: 'message', data: 'data', id: '' }]);
		expect(await events('event:a\n\ndata:x\n\nevent:b\nevent:c\ndata:y\n\n')).toEqual([
			{ event: 'message', data: 'x', id: '' },
			{ event: 'c', data: 'y', id: '' }
		]);
	});

	it('format-field-id: the last event ID persists, an empty id resets it, an id with NUL is ignored', async function () {
		expect(await events('id: 1\ndata: x\n\ndata: y\n\nid\ndata: z\n\n')).toEqual([
			{ event: 'message', data: 'x', id: '1' },
			{ event: 'message', data: 'y', id: '1' },
			{ event: 'message', data: 'z', id: '' }
		]);
		expect(await events('id: 1\0\ndata: x\n\nid: 2\nid: 3\0x\ndata: y\n\n')).toEqual([
			{ event: 'message', data: 'x', id: '' },
			{ event: 'message', data: 'y', id: '2' }
		]);
		// An id in a block without data still updates the last event ID.
		expect(await events('id: 5\n\ndata: x\n\n')).toEqual([{ event: 'message', data: 'x', id: '5' }]);
		expect(await events('id:\u2026\ndata:x\n\n')).toEqual([{ event: 'message', data: 'x', id: '\u2026' }]);
	});

	it('format-field-retry: only ASCII digits set the reconnection time, which persists', async function () {
		const seen: number[] = [];
		function onRetry(ms: number): void {
			seen.push(ms);
		}
		expect(await events('retry:03000\ndata:x\n\ndata:y\n\n', { onRetry })).toEqual([
			{ event: 'message', data: 'x', id: '', retry: 3000 },
			{ event: 'message', data: 'y', id: '', retry: 3000 }
		]);
		expect(await events('retry: 1000\nretry:1000x\nretry\nretry:\nretry: -1\nretry:1 \nretry:１\nretry:2.5\ndata:x\n\n', { onRetry })).toEqual([
			{ event: 'message', data: 'x', id: '', retry: 1000 }
		]);
		// A retry in a block without data is not lost, and onRetry is called at once.
		expect(await events('retry: 500\n\n', { onRetry })).toEqual([]);
		expect(seen).toEqual([3000, 1000, 500]);
		expect(await events('data:x\n\n')).toEqual([{ event: 'message', data: 'x', id: '' }]);
	});

	it('format-bom: one leading byte order mark is dropped, a second one makes the first line a field of its own', async function () {
		expect(datas(await events('\uFEFFdata:1\n\n\uFEFFdata:2\n\ndata:3\n\n'))).toEqual(['1', '3']);
		expect(datas(await events('\uFEFF\uFEFFdata:1\n\ndata:2\n\ndata:3\n\n'))).toEqual(['2', '3']);
		expect(datas(await events([bytes(0xef, 0xbb), bytes(0xbf), 'data:1\n\n']))).toEqual(['1']);
	});

	it('format-null-character and format-utf-8', async function () {
		expect(datas(await events('data:\0\n\n\n\n'))).toEqual(['\0']);
		expect(datas(await events(encoder.encode('data:ok\u2026\n\n')))).toEqual(['ok\u2026']);
		expect(datas(await events([bytes(0x64, 0x61, 0x74, 0x61, 0x3a, 0xe2, 0x80), bytes(0xa6, 0x0a, 0x0a)]))).toEqual(['\u2026']);
	});

	it('discards an event not followed by a blank line at the end, and does not interpret an unfinished last line', async function () {
		expect(datas(await events('data:1\n\ndata:2'))).toEqual(['1']);
		expect(datas(await events('data:1\n\ndata:2\n'))).toEqual(['1']);
		expect(datas(await events('data:1\n\ndata:2\r'))).toEqual(['1']);
		const onRetry = jest.fn();
		expect(await events('data:1\n\nretry: 5', { onRetry })).toEqual([{ event: 'message', data: '1', id: '' }]);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it('dispatches on CR, CRLF and LF blank lines, also split across chunks', async function () {
		expect(datas(await events(['data:a\r', '\r', 'data:b\r', '\n\r', '\ndata:c\n', '\n']))).toEqual(['a', 'b', 'c']);
		expect(datas(await events(['data:a\r\r\n', 'data:b\r\n\r\n']))).toEqual(['a', 'b']);
	});

	it('reads fetch bodies, as for LLM streaming, stopping early with break', async function () {
		const body = 'data: {"token":"Hel"}\n\ndata: {"token":"lo"}\n\ndata: [DONE]\n\ndata: never\n\n';
		const tokens: string[] = [];
		for await (const { data } of helpers.parseSSE(new Response(body).body!)) {
			if (data === '[DONE]') break;
			tokens.push((JSON.parse(data) as { token: string }).token);
		}
		expect(tokens).toEqual(['Hel', 'lo']);
		const { stream, stats } = endless(encoder.encode('data: tick\n\n'));
		let count = 0;
		for await (const event of helpers.parseSSE(stream)) {
			expect(event.data).toBe('tick');
			if (++count === 3) break;
		}
		expect(stats.cancelled).toBe(1);
		expect(stream.locked).toBe(false);
	});

	it('stops yielding the events of a chunk once aborted, and cancels the stream', async function () {
		const { stream, stats } = webStream(['data:1\n\ndata:2\n\n']);
		const controller = new AbortController();
		const iterator = helpers.parseSSE(stream, { signal: controller.signal });
		expect((await iterator.next()).value).toEqual({ event: 'message', data: '1', id: '' });
		controller.abort('done');
		await expect(iterator.next()).rejects.toBe('done');
		expect(stats.cancelled).toBe(1);
	});

	it('calls onRetry in stream order, and interprets nothing more once aborted', async function () {
		const calls: number[] = [];
		const signal = new TestSignal();
		const iterator = helpers.parseSSE('data:a\n\nretry:5\ndata:b\n\nretry:6\n', {
			signal,
			onRetry(ms) {
				calls.push(ms);
			}
		});
		await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: 'message', data: 'a', id: '' } });
		expect(calls).toEqual([]);
		await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: 'message', data: 'b', id: '', retry: 5 } });
		expect(calls).toEqual([5]);
		signal.abort('stop');
		await expect(iterator.next()).rejects.toBe('stop');
		expect(calls).toEqual([5]);
	});

	it('limits lines with maxLineLength, and propagates errors of onRetry', async function () {
		await expect(events('data: 12345\n\n', { maxLineLength: 8 })).rejects.toThrow(new RangeError('parseSSE: line 1 is longer than `maxLineLength` (8)'));
		expect(datas(await events('data:123\n\n', { maxLineLength: 8 }))).toEqual(['123']);
		const error = new Error('retry handler');
		await expect(
			events('retry: 1\n', {
				onRetry() {
					throw error;
				}
			})
		).rejects.toBe(error);
		await expect(events([1 as any])).rejects.toThrow(new TypeError('parseSSE: a chunk must be a string or a Uint8Array, got number'));
	});

	it('dispatches the events before a line longer than maxLineLength first, wherever the chunks are cut (regression)', async function () {
		for (const source of ['data: a\n\ndata: too long\n\n', ['data: a\n', '\ndata: too long\n\n']]) {
			const signal = new TestSignal();
			const iterator = helpers.parseSSE(source, { maxLineLength: 8 });
			await expect(iterator.next()).resolves.toEqual({ done: false, value: { event: 'message', data: 'a', id: '' } });
			await expect(iterator.next()).rejects.toThrow(new RangeError('parseSSE: line 3 is longer than `maxLineLength` (8)'));
			// An abort while the event before it is held wins.
			const aborted = helpers.parseSSE(source, { maxLineLength: 8, signal });
			await expect(aborted.next()).resolves.toEqual({ done: false, value: { event: 'message', data: 'a', id: '' } });
			signal.abort('stop');
			await expect(aborted.next()).rejects.toBe('stop');
		}
	});

	it('limits the joined data of an event with maxDataLength (the LFs between values count), so data lines cannot pile up', async function () {
		expect(datas(await events('data: 1234\ndata: 567\n\n', { maxDataLength: 8 }))).toEqual(['1234\n567']);
		await expect(events('data: 1234\ndata: 5678\n\n', { maxDataLength: 8 })).rejects.toThrow(
			new RangeError('parseSSE: the data of an event is longer than `maxDataLength` (8)')
		);
		// Empty values count their LF.
		expect(datas(await events('data\ndata\ndata\n\n', { maxDataLength: 2 }))).toEqual(['\n\n']);
		await expect(events('data\ndata\ndata\ndata\n\n', { maxDataLength: 2 })).rejects.toThrow(RangeError);
		expect(datas(await events('data\n\n', { maxDataLength: 0 }))).toEqual(['']);
		await expect(events('data: x\n', { maxDataLength: 0 })).rejects.toThrow(RangeError);
		// The count restarts with each event; other fields, comments and blocks without data do not count.
		expect(datas(await events('data: 1234\n\nevent: long-name\nid: long-id\n: a long comment\n\ndata: 5678\n\n', { maxDataLength: 4 }))).toEqual(['1234', '5678']);
		// The events before the one that is too long come first; the stream is cancelled.
		const { stream, stats } = endless('data: x\n');
		const iterator = helpers.parseSSE(stream, { maxDataLength: 1000 });
		await expect(iterator.next()).rejects.toThrow(new RangeError('parseSSE: the data of an event is longer than `maxDataLength` (1000)'));
		expect(stats.cancelled).toBe(1);
		expect(stream.locked).toBe(false);
		const first = helpers.parseSSE('data: a\n\ndata: bc\n\n', { maxDataLength: 1 });
		await expect(first.next()).resolves.toEqual({ done: false, value: { event: 'message', data: 'a', id: '' } });
		await expect(first.next()).rejects.toThrow(RangeError);
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.parseSSE('', { maxDataLength: -1 });
		}).toThrow(new RangeError('parseSSE: `maxDataLength` must be an integer >= 0 or Infinity, got -1'));
		expect(function () {
			helpers.parseSSE('', { maxDataLength: '5' as any });
		}).toThrow(new TypeError('parseSSE: `maxDataLength` must be an integer >= 0 or Infinity, got string'));
		expect(helpers.parseSSE('', { maxDataLength: Infinity })).toBeDefined();
		expect(function () {
			helpers.parseSSE(undefined as any);
		}).toThrow(new TypeError('parseSSE: `source` must be a ReadableStream or an (async) iterable, got undefined'));
		expect(function () {
			helpers.parseSSE('', { onRetry: 1 as any });
		}).toThrow(new TypeError('parseSSE: `onRetry` must be a function, got number'));
		expect(function () {
			helpers.parseSSE('', { maxLineLength: NaN });
		}).toThrow(new RangeError('parseSSE: `maxLineLength` must be an integer >= 0 or Infinity, got NaN'));
		expect(function () {
			helpers.parseSSE('', 'x' as any);
		}).toThrow(new TypeError('parseSSE: `options` must be an object, got string'));
		expect(function () {
			helpers.parseSSE('', { signal: 1 as any });
		}).toThrow(new TypeError('parseSSE: `signal` must be an AbortSignal, null or undefined, got number'));
	});
});

describe('parseNdjson', function () {
	async function values(source: helpers.TextStreamSource, options?: helpers.ParseNdjsonOptions): Promise<unknown[]> {
		return helpers.toArrayAsync(helpers.parseNdjson(source, options));
	}

	it('parses one JSON value per line, LF or CRLF, with or without a final line break', async function () {
		expect(await values('{"a":1}\n[1,2]\r\n"s"\nnull\ntrue\n-1.5e3')).toEqual([{ a: 1 }, [1, 2], 's', null, true, -1500]);
		expect(await values(['{"a":', '1}\n{"b"', ':2}\n'])).toEqual([{ a: 1 }, { b: 2 }]);
		expect(await values('')).toEqual([]);
		expect(await values(encoder.encode('{"é":"ü"}\n'))).toEqual([{ é: 'ü' }]);
	});

	it('skips lines of JSON white space only', async function () {
		expect(await values('\n1\n \t\r\n\r\n\n2\n\n  ')).toEqual([1, 2]);
	});

	it('does not end a line at a lone CR (JSON white space)', async function () {
		expect(await values('[1,\r2]\n')).toEqual([[1, 2]]);
		await expect(values('1\r2\n')).rejects.toThrow(SyntaxError);
	});

	it('throws a SyntaxError with the 1-based line number (blank lines count) and the JSON.parse error as cause', async function () {
		const failure = await values('1\n\n\n{oops}\n2\n').catch(function (error: unknown) {
			return error as SyntaxError;
		});
		expect(failure).toBeInstanceOf(SyntaxError);
		expect((failure as SyntaxError).message).toMatch(/^parseNdjson: line 4 is not valid JSON: /);
		expect((failure as SyntaxError).cause).toBeInstanceOf(SyntaxError);
		await expect(values(['1\n', '2\n', '3\r\n', '{'])).rejects.toThrow(/^parseNdjson: line 4 is not valid JSON/);
		await expect(values('\u00A0\n')).rejects.toThrow(/line 1/);
	});

	it('cancels the stream on invalid JSON, and stops on early exit', async function () {
		const { stream, stats } = webStream(['1\n', 'x\n', '3\n']);
		await expect(values(stream)).rejects.toThrow(SyntaxError);
		expect(stats.cancelled).toBe(1);
		const second = webStream(['1\n2\n', '3\n']);
		for await (const value of helpers.parseNdjson(second.stream)) {
			expect(value).toBe(1);
			break;
		}
		expect(second.stats.cancelled).toBe(1);
	});

	it('applies the reviver, and passes its errors through as they are', async function () {
		function reviver(this: unknown, _key: string, value: unknown): unknown {
			return typeof value === 'number' ? value * 10 : value;
		}
		expect(await values('{"a":1}\n[2]\n', { reviver })).toEqual([{ a: 10 }, [20]]);
		const error = new SyntaxError('from the reviver');
		await expect(
			values('1\n2\n', {
				reviver(_key, value) {
					if (value === 2) throw error;
					return value;
				}
			})
		).rejects.toBe(error);
		const holders: unknown[] = [];
		await values('{"x":1}', {
			reviver(this: unknown, _key, value) {
				holders.push(this);
				return value;
			}
		});
		expect(holders[0]).toEqual({ x: 1 });
	});

	it('limits lines with maxLineLength (a CR before the LF counts)', async function () {
		expect(await values('123\n', { maxLineLength: 3 })).toEqual([123]);
		await expect(values('123\r\n', { maxLineLength: 3 })).rejects.toThrow(new RangeError('parseNdjson: line 1 is longer than `maxLineLength` (3)'));
	});

	it('yields the values before a line longer than maxLineLength first, wherever the chunks are cut (regression)', async function () {
		for (const source of ['1\n\n12345\n2\n', ['1\n', '\n12345\n2\n'], ['1\n\n1234', '5']]) {
			const iterator = helpers.parseNdjson(source, { maxLineLength: 4 });
			await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
			await expect(iterator.next()).rejects.toThrow(new RangeError('parseNdjson: line 3 is longer than `maxLineLength` (4)'));
		}
		const signal = new TestSignal();
		const aborted = helpers.parseNdjson('1\n12345\n', { maxLineLength: 4, signal });
		await expect(aborted.next()).resolves.toEqual({ done: false, value: 1 });
		signal.abort('stop');
		await expect(aborted.next()).rejects.toBe('stop');
	});

	it('honours the signal, parsing nothing more once aborted', async function () {
		const signal = new TestSignal();
		const iterator = helpers.parseNdjson('1\n{bad\n', { signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });
		signal.abort('stop');
		await expect(iterator.next()).rejects.toBe('stop');
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.parseNdjson({} as any);
		}).toThrow(new TypeError('parseNdjson: `source` must be a ReadableStream or an (async) iterable, got object'));
		expect(function () {
			helpers.parseNdjson('', { reviver: 'x' as any });
		}).toThrow(new TypeError('parseNdjson: `reviver` must be a function, got string'));
		expect(function () {
			helpers.parseNdjson('', { maxLineLength: -2 });
		}).toThrow(RangeError);
	});
});

describe('streamToText / streamToBytes / streamToArray', function () {
	it('streamToText decodes and joins the chunks, dropping a leading byte order mark', async function () {
		expect(await helpers.streamToText(['a', 'b', 'c'])).toBe('abc');
		expect(await helpers.streamToText([])).toBe('');
		expect(await helpers.streamToText('whole')).toBe('whole');
		expect(await helpers.streamToText(encoder.encode('\uFEFFbytes'))).toBe('bytes');
		expect(await helpers.streamToText([bytes(0xf0, 0x9f), bytes(0x98, 0x80), 'x', bytes(0xff)])).toBe('😀x\uFFFD');
		expect(await helpers.streamToText([bytes(0xe2, 0x82)])).toBe('\uFFFD');
		expect(await helpers.streamToText(Readable.from([Buffer.from('nod'), Buffer.from('e')]))).toBe('node');
		expect(await helpers.streamToText(new Response('response').body!)).toBe('response');
	});

	it('streamToText rejects a text longer than maxLength (in UTF-16 code units) and cancels the stream', async function () {
		expect(await helpers.streamToText(['ab', 'c'], { maxLength: 3 })).toBe('abc');
		expect(await helpers.streamToText('', { maxLength: 0 })).toBe('');
		await expect(helpers.streamToText(['ab', 'cd'], { maxLength: 3 })).rejects.toThrow(new RangeError('streamToText: the text is longer than `maxLength` (3)'));
		await expect(helpers.streamToText('😀', { maxLength: 1 })).rejects.toThrow(RangeError);
		const { stream, stats } = endless('x');
		await expect(helpers.streamToText(stream, { maxLength: 100 })).rejects.toThrow(RangeError);
		expect(stats.cancelled).toBe(1);
		expect(stream.locked).toBe(false);
		await expect(helpers.streamToText([{} as any])).rejects.toThrow(new TypeError('streamToText: a chunk must be a string or a Uint8Array, got object'));
	});

	it('streamToBytes copies the chunks once into a new exact-size buffer', async function () {
		const first = bytes(1, 2);
		const result = await helpers.streamToBytes([first, bytes(), Buffer.from([3]), bytes(4, 5).subarray(1)]);
		expect(result).toEqual(bytes(1, 2, 3, 5));
		expect(result.buffer.byteLength).toBe(4);
		const single = await helpers.streamToBytes([first]);
		expect(single).toEqual(first);
		expect(single.buffer).not.toBe(first.buffer);
		expect(await helpers.streamToBytes([])).toEqual(bytes());
		expect(await helpers.streamToBytes(webStream([bytes(9), bytes(8)]).stream)).toEqual(bytes(9, 8));
	});

	it('streamToBytes rejects chunks that are not Uint8Arrays, and streams larger than maxBytes', async function () {
		await expect(helpers.streamToBytes(['a'] as any)).rejects.toThrow(new TypeError('streamToBytes: a chunk must be a Uint8Array, got string'));
		await expect(helpers.streamToBytes(bytes(1, 2) as any)).rejects.toThrow(new TypeError('streamToBytes: a chunk must be a Uint8Array, got number'));
		expect(await helpers.streamToBytes([bytes(1, 2), bytes(3)], { maxBytes: 3 })).toEqual(bytes(1, 2, 3));
		await expect(helpers.streamToBytes([bytes(1, 2), bytes(3, 4)], { maxBytes: 3 })).rejects.toThrow(
			new RangeError('streamToBytes: the stream holds more than `maxBytes` (3) bytes')
		);
		const { stream, stats } = endless(bytes(1, 2, 3));
		await expect(helpers.streamToBytes(stream, { maxBytes: 1000 })).rejects.toThrow(RangeError);
		expect(stats.cancelled).toBe(1);
	});

	it('streamToArray collects chunks of any type, up to maxLength', async function () {
		expect(await helpers.streamToArray(webStream([1, 2, 3]).stream)).toEqual([1, 2, 3]);
		expect(await helpers.streamToArray([Promise.resolve('a'), 'b'])).toEqual(['a', 'b']);
		expect(await helpers.streamToArray('ab')).toEqual(['a', 'b']);
		expect(await helpers.streamToArray(Readable.from([{ x: 1 }, { x: 2 }]))).toEqual([{ x: 1 }, { x: 2 }]);
		expect(await helpers.streamToArray([1, 2], { maxLength: 2 })).toEqual([1, 2]);
		expect(await helpers.streamToArray([], { maxLength: 0 })).toEqual([]);
		await expect(helpers.streamToArray([1, 2, 3], { maxLength: 2 })).rejects.toThrow(new RangeError('streamToArray: the stream holds more than `maxLength` (2) chunks'));
		const { iterable, stats } = generatorSource([1, 2, 3, 4]);
		await expect(helpers.streamToArray(iterable, { maxLength: 1 })).rejects.toThrow(RangeError);
		expect(stats).toEqual({ pulled: 2, finalized: 1 });
	});

	it('the collectors honour the signal', async function () {
		const { stream, stats } = webStream<string>([], { idle: true });
		const controller = new AbortController();
		const pending = helpers.streamToText(stream, { signal: controller.signal });
		await settle();
		controller.abort('cancelled');
		await expect(pending).rejects.toBe('cancelled');
		expect(stats.cancelled).toBe(1);
		const aborted = AbortSignal.abort('early');
		await expect(helpers.streamToBytes([bytes(1)], { signal: aborted })).rejects.toBe('early');
		await expect(helpers.streamToArray([1], { signal: aborted })).rejects.toBe('early');
	});

	it('validate their arguments eagerly', function () {
		expect(function () {
			void helpers.streamToText(1 as any);
		}).toThrow(new TypeError('streamToText: `source` must be a ReadableStream or an (async) iterable, got number'));
		expect(function () {
			void helpers.streamToBytes({} as any);
		}).toThrow(new TypeError('streamToBytes: `source` must be a ReadableStream or an (async) iterable, got object'));
		expect(function () {
			void helpers.streamToArray(null as any);
		}).toThrow(new TypeError('streamToArray: `source` must be a ReadableStream or an (async) iterable, got null'));
		expect(function () {
			void helpers.streamToText('', { maxLength: -1 });
		}).toThrow(new RangeError('streamToText: `maxLength` must be an integer >= 0 or Infinity, got -1'));
		expect(function () {
			void helpers.streamToBytes([], { maxBytes: 0.5 });
		}).toThrow(new RangeError('streamToBytes: `maxBytes` must be an integer >= 0 or Infinity, got 0.5'));
		expect(function () {
			void helpers.streamToArray([], { maxLength: 'x' as any });
		}).toThrow(new TypeError('streamToArray: `maxLength` must be an integer >= 0 or Infinity, got string'));
		expect(function () {
			void helpers.streamToArray([], false as any);
		}).toThrow(new TypeError('streamToArray: `options` must be an object, got boolean'));
		expect(function () {
			void helpers.streamToBytes([], { signal: 'x' as any });
		}).toThrow(new TypeError('streamToBytes: `signal` must be an AbortSignal, null or undefined, got string'));
	});
});

/**
 * A hand-driven async iterator: each `next()` stays pending until `emit`, `end` or `fail` settles the oldest pending one.
 */
function controlled<T>() {
	const pending: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (reason: unknown) => void }> = [];
	const stats = { nexts: 0, returns: 0, maxPending: 0 };
	const iterator = {
		[Symbol.asyncIterator]() {
			return iterator;
		},
		next(): Promise<IteratorResult<T>> {
			stats.nexts++;
			return new Promise<IteratorResult<T>>(function (resolve, reject) {
				pending.push({ resolve, reject });
				stats.maxPending = Math.max(stats.maxPending, pending.length);
			});
		},
		async return(): Promise<IteratorResult<T>> {
			stats.returns++;
			return { done: true, value: undefined };
		}
	};
	return {
		iterator: iterator as AsyncIterableIterator<T>,
		stats,
		waiting(): number {
			return pending.length;
		},
		emit(value: T): void {
			pending.shift()!.resolve({ done: false, value });
		},
		end(): void {
			pending.shift()!.resolve({ done: true, value: undefined });
		},
		fail(error: unknown): void {
			pending.shift()!.reject(error);
		}
	};
}

describe('mergeAsync', function () {
	it('yields values in arrival order, pulling each source again only once its value was consumed', async function () {
		const a = controlled<number>();
		const b = controlled<string>();
		const merged = helpers.mergeAsync(a.iterator, b.iterator);
		const first = merged.next();
		await settle();
		expect([a.waiting(), b.waiting()]).toEqual([1, 1]);
		b.emit('x');
		await expect(first).resolves.toEqual({ done: false, value: 'x' });
		a.emit(1);
		await settle();
		// `a` delivered a value nobody has read yet: it is not pulled again.
		expect([a.waiting(), b.waiting()]).toEqual([0, 0]);
		await expect(merged.next()).resolves.toEqual({ done: false, value: 1 });
		const third = merged.next();
		await settle();
		expect([a.waiting(), b.waiting()]).toEqual([1, 1]);
		a.emit(2);
		await expect(third).resolves.toEqual({ done: false, value: 2 });
		const fourth = merged.next();
		await settle();
		a.end();
		b.emit('y');
		await expect(fourth).resolves.toEqual({ done: false, value: 'y' });
		const fifth = merged.next();
		await settle();
		b.end();
		await expect(fifth).resolves.toEqual({ done: true, value: undefined });
		expect(a.stats).toEqual({ nexts: 3, returns: 0, maxPending: 1 });
		expect(b.stats).toEqual({ nexts: 3, returns: 0, maxPending: 1 });
	});

	it('merges sync iterables (awaiting their promises) with async ones, and ends when all end', async function () {
		const values = await helpers.toArrayAsync(helpers.mergeAsync([1, Promise.resolve(2)], generatorSource(['a', 'b']).iterable, new Set([true])));
		expect(values.slice().sort()).toEqual([1, 2, 'a', 'b', true].sort());
		expect(values.indexOf(1)).toBeLessThan(values.indexOf(2));
		expect(values.indexOf('a')).toBeLessThan(values.indexOf('b'));
		expect(await helpers.toArrayAsync(helpers.mergeAsync())).toEqual([]);
		expect(await helpers.toArrayAsync(helpers.mergeAsync([], []))).toEqual([]);
	});

	it('closes every open source on early exit: idle ones awaited, pending ones without waiting', async function () {
		const a = controlled<number>();
		const b = controlled<number>();
		const sync = spy([10, 20, 30]);
		const merged = helpers.mergeAsync(a.iterator, b.iterator, sync.iterable);
		await expect(merged.next()).resolves.toEqual({ done: false, value: 10 });
		a.emit(1);
		await settle();
		await expect(merged.return!(undefined)).resolves.toEqual({ done: true, value: undefined });
		expect(a.stats.returns).toBe(1);
		expect(b.stats.returns).toBe(1);
		expect(sync.stats.closed).toBe(1);
		// Results arriving afterwards are dropped, rejections included.
		b.fail(new Error('late'));
		await settle();
		const c = controlled<number>();
		const d = controlled<number>();
		const other = helpers.mergeAsync(c.iterator, d.iterator);
		const read = other.next();
		await settle();
		c.emit(1);
		await expect(read).resolves.toEqual({ done: false, value: 1 });
		await other.return!(undefined);
		d.end();
		await settle();
		expect([c.stats.returns, d.stats.returns]).toEqual([1, 1]);
	});

	it('throws a source error in arrival order and closes the other sources, but not the failed one', async function () {
		const a = controlled<number>();
		const b = controlled<number>();
		const error = new Error('boom');
		const merged = helpers.mergeAsync(a.iterator, b.iterator);
		const first = merged.next();
		await settle();
		b.emit(5);
		a.fail(error);
		await expect(first).resolves.toEqual({ done: false, value: 5 });
		await expect(merged.next()).rejects.toBe(error);
		expect(a.stats.returns).toBe(0);
		expect(b.stats.returns).toBe(1);
		await expect(merged.next()).resolves.toEqual({ done: true, value: undefined });
	});

	it('treats a throwing next(), a result that is not an object and a throwing getter as failures', async function () {
		const error = new Error('sync');
		function source(next: () => unknown): AsyncIterable<number> {
			return {
				[Symbol.asyncIterator]() {
					return { next } as AsyncIterator<number>;
				}
			};
		}
		await expect(
			helpers.toArrayAsync(
				helpers.mergeAsync(
					source(function () {
						throw error;
					})
				)
			)
		).rejects.toBe(error);
		await expect(
			helpers.toArrayAsync(
				helpers.mergeAsync(
					source(function () {
						return 3;
					})
				)
			)
		).rejects.toThrow(new TypeError('mergeAsync: iterator result number is not an object'));
		await expect(
			helpers.toArrayAsync(
				helpers.mergeAsync(
					source(function () {
						return null;
					})
				)
			)
		).rejects.toThrow('mergeAsync: iterator result null is not an object');
		await expect(
			helpers.toArrayAsync(
				helpers.mergeAsync(
					source(function () {
						return {
							get done(): boolean {
								throw error;
							}
						};
					})
				)
			)
		).rejects.toBe(error);
		// A plain result is accepted, like `for await` does.
		let calls = 0;
		expect(
			await helpers.toArrayAsync(
				helpers.mergeAsync(
					source(function () {
						return calls++ === 0 ? { done: false, value: 7 } : { done: true };
					})
				)
			)
		).toEqual([7]);
	});

	it('closes the sources opened before one whose iterator cannot be created', async function () {
		const first = controlled<number>();
		const error = new Error('no iterator');
		const broken = {
			[Symbol.asyncIterator]() {
				throw error;
			}
		};
		await expect(helpers.mergeAsync(first.iterator, broken as AsyncIterable<number>).next()).rejects.toBe(error);
		expect(first.stats).toEqual({ nexts: 0, returns: 1, maxPending: 0 });
	});

	it('reports a failure to close on early exit (the first in source order), and ignores it when failing', async function () {
		const one = new Error('one');
		const two = new Error('two');
		function closing(failure: unknown, sync = false): AsyncIterable<number> {
			return {
				[Symbol.asyncIterator]() {
					return {
						next: async function () {
							return { done: false, value: 1 };
						},
						return: sync
							? function () {
									throw failure;
								}
							: async function () {
									throw failure;
								}
					} as AsyncIterator<number>;
				}
			};
		}
		const merged = helpers.mergeAsync(closing(one), closing(two, true));
		await merged.next();
		await merged.next();
		await expect(merged.return!(undefined)).rejects.toBe(one);
		const error = new Error('source');
		const failing = {
			[Symbol.asyncIterator]() {
				return {
					next: async function () {
						throw error;
					}
				} as AsyncIterator<number>;
			}
		};
		const quiet = helpers.mergeAsync(closing(one), failing);
		await expect(helpers.toArrayAsync(quiet)).rejects.toBe(error);
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.mergeAsync([1], 5 as any);
		}).toThrow(new TypeError('mergeAsync: `sources` must be iterable, got number'));
		expect(function () {
			helpers.mergeAsync(null as any);
		}).toThrow(new TypeError('mergeAsync: `sources` must be iterable, got null'));
	});
});

describe('bufferTime', function () {
	beforeEach(function () {
		jest.useFakeTimers();
	});
	afterEach(function () {
		jest.useRealTimers();
	});

	it('flushes a batch when it reaches maxSize, and the rest at the end', async function () {
		expect(await helpers.toArrayAsync(helpers.bufferTime([1, 2, 3, 4, 5], Infinity, { maxSize: 2 }))).toEqual([[1, 2], [3, 4], [5]]);
		expect(await helpers.toArrayAsync(helpers.bufferTime([1, 2, 3], 1000, { maxSize: 1 }))).toEqual([[1], [2], [3]]);
		expect(await helpers.toArrayAsync(helpers.bufferTime([1, 2, 3], Infinity))).toEqual([[1, 2, 3]]);
		expect(await helpers.toArrayAsync(helpers.bufferTime([], 10))).toEqual([]);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('flushes a batch `ms` after its first item, and never yields an empty batch', async function () {
		const source = controlled<number>();
		const batches = helpers.bufferTime(source.iterator, 100);
		const first = batches.next();
		await jest.advanceTimersByTimeAsync(500);
		// Idle source: no timer runs, no empty batch.
		expect(jest.getTimerCount()).toBe(0);
		source.emit(1);
		await jest.advanceTimersByTimeAsync(60);
		source.emit(2);
		await jest.advanceTimersByTimeAsync(39);
		let resolved = false;
		void first.then(function () {
			resolved = true;
		});
		await settle();
		expect(resolved).toBe(false);
		await jest.advanceTimersByTimeAsync(1);
		await expect(first).resolves.toEqual({ done: false, value: [1, 2] });
		// The pull pending when the batch was flushed fills the next batch, which starts its own window.
		const second = batches.next();
		source.emit(3);
		await jest.advanceTimersByTimeAsync(100);
		await expect(second).resolves.toEqual({ done: false, value: [3] });
		const third = batches.next();
		await settle();
		source.end();
		await expect(third).resolves.toEqual({ done: true, value: undefined });
		expect(source.stats.maxPending).toBe(1);
	});

	it('yields a batch whose time ran out while the consumer was busy at its next read, keeping later items for the next batch', async function () {
		const source = controlled<number>();
		const batches = helpers.bufferTime(source.iterator, 50, { maxSize: 2 });
		const first = batches.next();
		await settle();
		source.emit(1);
		await settle();
		source.emit(2);
		await expect(first).resolves.toEqual({ done: false, value: [1, 2] });
		// Nothing is pulled while the consumer is busy.
		await settle();
		expect(source.waiting()).toBe(0);
		const second = batches.next();
		await settle();
		source.emit(3);
		await jest.advanceTimersByTimeAsync(50);
		await expect(second).resolves.toEqual({ done: false, value: [3] });
		// A pending pull answered while the consumer is busy: its item opens the next batch, flushed at the next read once timed out.
		await settle();
		expect(source.waiting()).toBe(1);
		source.emit(4);
		await jest.advanceTimersByTimeAsync(50);
		await expect(batches.next()).resolves.toEqual({ done: false, value: [4] });
	});

	it('flushes the items read before a source error, then throws it without closing the source', async function () {
		const source = controlled<number>();
		const error = new Error('broken');
		const batches = helpers.bufferTime(source.iterator, 100);
		const first = batches.next();
		await settle();
		source.emit(1);
		await settle();
		source.fail(error);
		await expect(first).resolves.toEqual({ done: false, value: [1] });
		await expect(batches.next()).rejects.toBe(error);
		expect(source.stats.returns).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('clears its timer and closes the source on early exit', async function () {
		const source = controlled<number>();
		const batches = helpers.bufferTime(source.iterator, 100, { maxSize: 1 });
		const first = batches.next();
		await settle();
		source.emit(1);
		await expect(first).resolves.toEqual({ done: false, value: [1] });
		await expect(batches.return!(undefined)).resolves.toEqual({ done: true, value: undefined });
		expect(source.stats.returns).toBe(1);
		// With a batch in progress (its timer running) and a pull pending.
		const other = controlled<number>();
		const timed = helpers.bufferTime(other.iterator, 100, { maxSize: 2 });
		const batch = timed.next();
		await settle();
		other.emit(1);
		await settle();
		other.emit(2);
		await expect(batch).resolves.toEqual({ done: false, value: [1, 2] });
		const generator = generatorSource([1, 2, 3]);
		for await (const value of helpers.bufferTime(generator.iterable, 100)) {
			expect(value).toEqual([1, 2, 3]);
		}
		expect(generator.stats.finalized).toBe(1);
		const sync = spy([1, 2, 3, 4]);
		for await (const value of helpers.bufferTime(sync.iterable, 100, { maxSize: 2 })) {
			expect(value).toEqual([1, 2]);
			break;
		}
		expect(sync.stats.closed).toBe(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('requests the close without waiting when a pull is pending, and ignores late results', async function () {
		const source = controlled<number>();
		const batches = helpers.bufferTime(source.iterator, 100);
		const pending = batches.next();
		await settle();
		source.emit(1);
		await jest.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toEqual({ done: false, value: [1] });
		// The next pull is pending: closing does not wait for it.
		const signal = new TestSignal();
		const aborted = helpers.bufferTime(source.iterator, 100, { signal });
		const read = aborted.next();
		await settle();
		signal.abort('stop');
		await expect(read).rejects.toBe('stop');
		expect(source.stats.returns).toBe(1);
		expect(signal.listeners.size).toBe(0);
		source.emit(2);
		source.fail(new Error('late'));
		await settle();
		await expect(batches.return!(undefined)).resolves.toEqual({ done: true, value: undefined });
		// A value answering a pull after the close is dropped.
		const idle = controlled<number>();
		const stop = new TestSignal();
		const closed = helpers.bufferTime(idle.iterator, 100, { signal: stop });
		const one = closed.next();
		await settle();
		stop.abort('x');
		await expect(one).rejects.toBe('x');
		idle.emit(1);
		await settle();
		expect(jest.getTimerCount()).toBe(0);
		expect(idle.stats.returns).toBe(1);
	});

	it('reports a failure to close on early exit, and ignores it when failing', async function () {
		const error = new Error('close');
		function source(next: () => unknown): AsyncIterable<number> {
			return {
				[Symbol.asyncIterator]() {
					return {
						next,
						return: async function () {
							throw error;
						}
					} as AsyncIterator<number>;
				}
			};
		}
		const batches = helpers.bufferTime(
			source(async function () {
				return { done: false, value: 1 };
			}),
			100,
			{ maxSize: 1 }
		);
		await batches.next();
		await expect(batches.return!(undefined)).rejects.toBe(error);
		const signal = new TestSignal();
		const aborted = helpers.bufferTime(
			source(async function () {
				return { done: false, value: 1 };
			}),
			100,
			{ maxSize: 1, signal }
		);
		await aborted.next();
		signal.abort('abort');
		await expect(aborted.next()).rejects.toBe('abort');
	});

	it('treats a throwing next(), a result that is not an object and a throwing getter as failures', async function () {
		const error = new Error('sync');
		function source(next: () => unknown): AsyncIterable<number> {
			return {
				[Symbol.asyncIterator]() {
					return { next } as AsyncIterator<number>;
				}
			};
		}
		await expect(
			helpers.toArrayAsync(
				helpers.bufferTime(
					source(function () {
						throw error;
					}),
					10
				)
			)
		).rejects.toBe(error);
		await expect(
			helpers.toArrayAsync(
				helpers.bufferTime(
					source(function () {
						return 'x';
					}),
					10
				)
			)
		).rejects.toThrow(new TypeError('bufferTime: iterator result string is not an object'));
		await expect(
			helpers.toArrayAsync(
				helpers.bufferTime(
					source(function () {
						return null;
					}),
					10
				)
			)
		).rejects.toThrow('bufferTime: iterator result null is not an object');
		await expect(
			helpers.toArrayAsync(
				helpers.bufferTime(
					source(function () {
						return {
							done: false,
							get value(): number {
								throw error;
							}
						};
					}),
					10
				)
			)
		).rejects.toBe(error);
	});

	it('stops at once for an already aborted signal, with an AbortError when it has no reason', async function () {
		const { iterable, stats } = generatorSource([1]);
		const signal = new TestSignal();
		signal.abort();
		await expect(helpers.bufferTime(iterable, 10, { signal }).next()).rejects.toMatchObject({ name: 'AbortError' });
		expect(stats.pulled).toBe(0);
		const silent = new TestSignal();
		const batches = helpers.bufferTime([1, 2], 10, { maxSize: 1, signal: silent });
		await expect(batches.next()).resolves.toEqual({ done: false, value: [1] });
		silent.aborted = true;
		silent.reason = 'quiet';
		await expect(batches.next()).rejects.toBe('quiet');
	});

	it('validates its arguments eagerly', function () {
		expect(function () {
			helpers.bufferTime(1 as any, 10);
		}).toThrow(new TypeError('bufferTime: `iterable` must be iterable, got number'));
		expect(function () {
			helpers.bufferTime([], -1);
		}).toThrow(new RangeError('bufferTime: `ms` must be Infinity or a number between 0 and 2147483647, got -1'));
		expect(function () {
			helpers.bufferTime([], 'x' as any);
		}).toThrow(TypeError);
		expect(function () {
			helpers.bufferTime([], 10, { maxSize: 0 });
		}).toThrow(new RangeError('bufferTime: `maxSize` must be an integer >= 1 or Infinity, got 0'));
		expect(function () {
			helpers.bufferTime([], 10, 3 as any);
		}).toThrow(new TypeError('bufferTime: `options` must be an object, got number'));
		expect(function () {
			helpers.bufferTime([], 10, { signal: {} as any });
		}).toThrow(new TypeError('bufferTime: `signal` must be an AbortSignal, null or undefined, got object'));
		expect(helpers.bufferTime([], 0, { signal: null, maxSize: Infinity })).toBeDefined();
	});
});

describe('interleave', function () {
	it('takes one item from each iterable in turn, skipping exhausted ones', function () {
		expect(helpers.toArray(helpers.interleave([1, 2, 3], ['a'], [true, false]))).toEqual([1, 'a', true, 2, false, 3]);
		expect(helpers.toArray(helpers.interleave([], [1, 2], []))).toEqual([1, 2]);
		expect(helpers.toArray(helpers.interleave())).toEqual([]);
		expect(helpers.toArray(helpers.interleave([1, 2]))).toEqual([1, 2]);
		expect(helpers.toArray(helpers.take(helpers.interleave(helpers.count(), [9]), 5))).toEqual([0, 9, 1, 2, 3]);
	});

	it('is lazy and closes the iterables still running on early exit, but not the exhausted ones', function () {
		const a = spy([1, 2, 3]);
		const b = spy(['x']);
		const c = spy([true, false, true]);
		const iterator = helpers.interleave(a.iterable, b.iterable, c.iterable);
		expect(a.stats.opened).toBe(0);
		expect(helpers.toArray(helpers.take(iterator, 5))).toEqual([1, 'x', true, 2, false]);
		expect([a.stats.closed, b.stats.closed, c.stats.closed]).toEqual([1, 0, 1]);
		const d = spy([1, 2]);
		const e = spy([3, 4]);
		expect(helpers.toArray(helpers.take(helpers.interleave(d.iterable, e.iterable), 1))).toEqual([1]);
		expect([d.stats.closed, e.stats.closed]).toEqual([1, 1]);
	});

	it('closes the others, but not the one that threw, when an iterator throws', function () {
		const error = new Error('bad');
		const a = spy([1, 2]);
		const throwing: Iterable<number> = {
			[Symbol.iterator]() {
				return {
					next(): IteratorResult<number> {
						throw error;
					},
					return() {
						throw new Error('must not be closed');
					}
				};
			}
		};
		expect(function () {
			helpers.toArray(helpers.interleave(a.iterable, throwing));
		}).toThrow(error);
		expect(a.stats.closed).toBe(1);
		// throw() on the interleaved iterator closes all of them.
		const b = spy([1, 2]);
		const c = spy([3, 4]);
		const iterator = helpers.interleave(b.iterable, c.iterable);
		iterator.next();
		expect(function () {
			iterator.throw!(error);
		}).toThrow(error);
		expect([b.stats.closed, c.stats.closed]).toEqual([1, 1]);
	});

	it('rejects iterators that are not objects, and non-iterables', function () {
		const bad = {
			[Symbol.iterator]() {
				return 1;
			}
		};
		const a = spy([1]);
		expect(function () {
			helpers.toArray(helpers.interleave(a.iterable, bad as any));
		}).toThrow(new TypeError('interleave: an iterator must be an object, got number'));
		expect(a.stats.closed).toBe(1);
		expect(function () {
			helpers.interleave([1], 2 as any);
		}).toThrow(new TypeError('interleave: `iterables` must be iterable, got number'));
	});
});

describe('pairwise', function () {
	it('yields each item with the next one', function () {
		expect(helpers.toArray(helpers.pairwise([1, 2, 3]))).toEqual([
			[1, 2],
			[2, 3]
		]);
		expect(helpers.toArray(helpers.pairwise('ab'))).toEqual([['a', 'b']]);
		expect(helpers.toArray(helpers.pairwise([undefined, undefined]))).toEqual([[undefined, undefined]]);
		expect(helpers.toArray(helpers.pairwise([1]))).toEqual([]);
		expect(helpers.toArray(helpers.pairwise([]))).toEqual([]);
	});

	it('is lazy and closes the source on early exit', function () {
		const { iterable, stats } = spy([1, 2, 3, 4]);
		const pairs = helpers.pairwise(iterable);
		expect(stats.opened).toBe(0);
		expect(helpers.toArray(helpers.take(pairs, 1))).toEqual([[1, 2]]);
		expect(stats).toEqual({ opened: 1, pulled: 2, closed: 1 });
		expect(helpers.toArray(helpers.take(helpers.pairwise(helpers.count()), 2))).toEqual([
			[0, 1],
			[1, 2]
		]);
	});

	it('validates its argument', function () {
		expect(function () {
			helpers.pairwise(3 as any);
		}).toThrow(new TypeError('pairwise: `iterable` must be iterable, got number'));
	});
});

describe('partition', function () {
	it('splits the items in two, in order, passing the index', function () {
		const calls: Array<[number, number]> = [];
		const result = helpers.partition(new Set([5, 6, 7, 8]), function (value, index) {
			calls.push([value, index]);
			return value % 2 === 0;
		});
		expect(result).toEqual([
			[6, 8],
			[5, 7]
		]);
		expect(calls).toEqual([
			[5, 0],
			[6, 1],
			[7, 2],
			[8, 3]
		]);
		expect(helpers.partition([], isEven)).toEqual([[], []]);
		const [strings, others] = helpers.partition(['a', 1, 'b', null], function (value): value is string {
			return typeof value === 'string';
		});
		const typed: string[] = strings;
		const rest: Array<number | null> = others;
		expect([typed, rest]).toEqual([
			['a', 'b'],
			[1, null]
		]);
	});

	it('validates its arguments', function () {
		expect(function () {
			helpers.partition(1 as any, isEven);
		}).toThrow(new TypeError('partition: `iterable` must be iterable, got number'));
		expect(function () {
			helpers.partition([1], 'x' as any);
		}).toThrow(new TypeError('partition: `predicate` must be a function, got string'));
	});
});

describe('stream readers and combinators: edge cases', function () {
	function noReturn<T>(values: T[]): AsyncIterable<T> {
		return {
			[Symbol.asyncIterator]() {
				let index = 0;
				return {
					next: async function (): Promise<IteratorResult<T>> {
						return index < values.length ? { done: false, value: values[index++] } : { done: true, value: undefined };
					}
				};
			}
		};
	}

	function doneWithThrowingValue(): AsyncIterable<number> {
		return {
			[Symbol.asyncIterator]() {
				return {
					next: async function () {
						return {
							done: true,
							get value(): number {
								throw new Error('value of a done result must not be read');
							}
						};
					}
				} as AsyncIterator<number>;
			}
		};
	}

	it('interleave reports a failure to close on early exit, but not over the error of a throwing iterator', function () {
		const error = new Error('close');
		function closing(values: number[]): Iterable<number> {
			return {
				[Symbol.iterator]() {
					const inner = values[Symbol.iterator]();
					return {
						next: function () {
							return inner.next();
						},
						return: function (): IteratorResult<number> {
							throw error;
						}
					};
				}
			};
		}
		expect(function () {
			helpers.toArray(helpers.take(helpers.interleave(closing([1, 2]), [3, 4]), 1));
		}).toThrow(error);
		const failure = new Error('next');
		const throwing: Iterable<number> = {
			[Symbol.iterator]() {
				return {
					next(): IteratorResult<number> {
						throw failure;
					}
				};
			}
		};
		expect(function () {
			helpers.toArray(helpers.interleave(closing([1, 2]), throwing));
		}).toThrow(failure);
	});

	it('interleave closes every iterator opened before one that is not an object (null included)', function () {
		const a = spy([1]);
		const b = spy([2]);
		const nullIterator = {
			[Symbol.iterator]() {
				return null;
			}
		};
		expect(function () {
			helpers.toArray(helpers.interleave(a.iterable, b.iterable, nullIterator as any));
		}).toThrow(new TypeError('interleave: an iterator must be an object, got null'));
		expect([a.stats.closed, b.stats.closed]).toEqual([1, 1]);
	});

	it('mergeAsync and bufferTime do not read the value of a done result, and accept sources without return()', async function () {
		expect(await helpers.toArrayAsync(helpers.mergeAsync(doneWithThrowingValue(), [1]))).toEqual([1]);
		expect(await helpers.toArrayAsync(helpers.bufferTime(doneWithThrowingValue(), 10))).toEqual([]);
		for await (const value of helpers.mergeAsync(noReturn([1, 2, 3]))) {
			expect(value).toBe(1);
			break;
		}
		for await (const batch of helpers.bufferTime(noReturn([1, 2, 3]), 10, { maxSize: 1 })) {
			expect(batch).toEqual([1]);
			break;
		}
		for await (const line of helpers.readLines(noReturn(['a\nb\n']))) {
			expect(line).toBe('a');
			break;
		}
	});

	it('mergeAsync ignores a failure to close an idle source when another source failed', async function () {
		const failing = controlled<number>();
		const error = new Error('source');
		const gate = deferredValue<IteratorResult<number>>();
		const idle = {
			[Symbol.asyncIterator]() {
				return this;
			},
			next: function () {
				return gate.promise;
			},
			return: async function (): Promise<IteratorResult<number>> {
				throw new Error('close');
			}
		};
		const merged = helpers.mergeAsync(failing.iterator, idle);
		const first = merged.next();
		await settle();
		// The value arrives right after the error, before the merge wakes up: that source is idle when the error is thrown, so it is
		// closed and waited for (and its failure to close ignored).
		failing.fail(error);
		gate.resolve({ done: false, value: 1 });
		await expect(first).rejects.toBe(error);
	});

	it('mergeAsync closes on early exit without waiting for the pending pull of an async generator', async function () {
		const gate = deferredValue<number>();
		let finalized = 0;
		const blocked = (async function* () {
			try {
				yield await gate.promise;
			} finally {
				finalized++;
			}
		})();
		const merged = helpers.mergeAsync(blocked, [1]);
		await expect(merged.next()).resolves.toEqual({ done: false, value: 1 });
		await expect(merged.return!(undefined)).resolves.toEqual({ done: true, value: undefined });
		expect(finalized).toBe(0);
		gate.resolve(2);
		await settle();
		expect(finalized).toBe(1);
	});

	it('mergeAsync reports the first failure to close in source order, including a synchronous one', async function () {
		const one = new Error('one');
		const two = new Error('two');
		function closing(failure: unknown, sync: boolean): AsyncIterable<number> {
			return {
				[Symbol.asyncIterator]() {
					return {
						next: async function () {
							return { done: false, value: 1 };
						},
						return: sync
							? function () {
									throw failure;
								}
							: async function () {
									throw failure;
								}
					} as AsyncIterator<number>;
				}
			};
		}
		const both = helpers.mergeAsync(closing(one, false), closing(two, true));
		await both.next();
		await expect(both.return!(undefined)).rejects.toBe(one);
		const single = helpers.mergeAsync(closing(two, true));
		await single.next();
		await expect(single.return!(undefined)).rejects.toBe(two);
	});

	it('bufferTime with ms = Infinity never flushes on time', async function () {
		jest.useFakeTimers();
		try {
			const source = controlled<number>();
			const batches = helpers.bufferTime(source.iterator, Infinity);
			const first = batches.next();
			await settle();
			source.emit(1);
			await jest.advanceTimersByTimeAsync(10_000);
			let resolved = false;
			void first.then(function () {
				resolved = true;
			});
			await settle();
			expect(resolved).toBe(false);
			expect(jest.getTimerCount()).toBe(0);
			source.end();
			await expect(first).resolves.toEqual({ done: false, value: [1] });
		} finally {
			jest.useRealTimers();
		}
	});

	it('stops on an abort event from a signal-like object that does not report aborted', async function () {
		function dispatching() {
			const listeners = new Set<() => void>();
			return {
				aborted: false,
				reason: 'event only',
				addEventListener(_type: 'abort', listener: () => void): void {
					listeners.add(listener);
				},
				removeEventListener(_type: 'abort', listener: () => void): void {
					listeners.delete(listener);
				},
				fire(): void {
					for (const listener of [...listeners]) listener();
				}
			};
		}
		const first = dispatching();
		const batches = helpers.bufferTime([1, 2, 3], 10, { maxSize: 1, signal: first });
		await batches.next();
		first.fire();
		await expect(batches.next()).rejects.toBe('event only');
		const second = dispatching();
		const { stream, stats } = webStream(['a\n', 'b\n']);
		const lines = helpers.readLines(stream, { signal: second });
		await lines.next();
		second.fire();
		await expect(lines.next()).rejects.toBe('event only');
		expect(stats.cancelled).toBe(1);
	});

	it('bufferTime aborts at once, closing an async generator source without waiting for its pending pull', async function () {
		const gate = deferredValue<number>();
		let finalized = 0;
		const blocked = (async function* () {
			try {
				yield await gate.promise;
			} finally {
				finalized++;
			}
		})();
		const controller = new AbortController();
		const pending = helpers.bufferTime(blocked, 10, { signal: controller.signal }).next();
		await settle();
		controller.abort('now');
		await expect(pending).rejects.toBe('now');
		gate.resolve(1);
		await settle();
		expect(finalized).toBe(1);
	});

	it('does not cancel a stream that ended, even when aborted while its last lines are read', async function () {
		const queue: Array<{ done: boolean; value?: unknown }> = [{ done: false, value: 'a\nb' }, { done: true }];
		const { stream, stats } = fakeStream({
			read: async function () {
				return queue.shift()!;
			}
		});
		const signal = new TestSignal();
		const iterator = helpers.readLines(stream as any, { signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a' });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: 'b' });
		signal.abort('late');
		await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
		expect(stats.cancelled).toBe(0);
		const finished = fakeStream({
			read: async function () {
				return { done: true };
			}
		});
		expect(await helpers.toArrayAsync(helpers.readLines(finished.stream as any))).toEqual([]);
		expect(finished.stats).toEqual({ released: 1, cancelled: 0 });
	});

	it('cancels once and releases the lock at once on abort, and reads nothing more', async function () {
		let reads = 0;
		const { stream, stats } = fakeStream({
			read: async function () {
				reads++;
				return { done: false, value: reads + '\n' };
			}
		});
		const signal = new TestSignal();
		const iterator = helpers.readLines(stream as any, { signal });
		await expect(iterator.next()).resolves.toEqual({ done: false, value: '1' });
		signal.abort('stop');
		expect(stats).toEqual({ released: 1, cancelled: 1 });
		await expect(iterator.next()).rejects.toBe('stop');
		expect(reads).toBe(1);
		expect(stats.cancelled).toBe(1);
		const web = webStream(['a\n', 'b\n']);
		const controller = new AbortController();
		const lines = helpers.readLines(web.stream, { signal: controller.signal });
		await lines.next();
		controller.abort('quit');
		expect(web.stream.locked).toBe(false);
		await expect(lines.next()).rejects.toBe('quit');
	});

	it('drops a chunk that arrives while the signal is being aborted, before processing it', async function () {
		const gate = deferredValue<{ done: boolean; value?: unknown }>();
		const signal = new TestSignal();
		const { stream } = fakeStream({
			read: function () {
				return gate.promise;
			}
		});
		const text = helpers.streamToText(stream as any, { signal, maxLength: 2 });
		await settle();
		gate.resolve({ done: false, value: 'too long' });
		signal.aborted = true;
		signal.reason = 'raced';
		await expect(text).rejects.toBe('raced');
	});

	it('keeps a byte order mark that does not start the stream, after a string chunk', async function () {
		expect(await helpers.streamToText(['a', bytes(0xef, 0xbb, 0xbf, 0x62)])).toBe('a﻿b');
		expect(await helpers.streamToText([bytes(0x61), 'x', bytes(0xef, 0xbb, 0xbf, 0x62)])).toBe('ax﻿b');
	});

	it('parseSSE: no retry key until one is set, unknown fields with digits are ignored, onRetry is optional', async function () {
		expect(await helpers.toArrayAsync(helpers.parseSSE('data:x\n\n'))).toStrictEqual([{ event: 'message', data: 'x', id: '' }]);
		expect(await helpers.toArrayAsync(helpers.parseSSE('foo: 5\nretr: 6\ndata:x\n\n'))).toStrictEqual([{ event: 'message', data: 'x', id: '' }]);
		expect(await helpers.toArrayAsync(helpers.parseSSE('retry: 7\ndata:x\n\n'))).toStrictEqual([{ event: 'message', data: 'x', id: '', retry: 7 }]);
		expect(await helpers.toArrayAsync(helpers.parseSSE('data\ndat\nd:x\n\n'))).toStrictEqual([{ event: 'message', data: '', id: '' }]);
	});

	it('names the right function in the errors of every reader', async function () {
		function plain() {
			return fakeStream({
				read: function () {
					return 5 as any;
				}
			}).stream as any;
		}
		const readers: Array<[string, () => Promise<unknown>]> = [
			[
				'parseSSE',
				function () {
					return helpers.toArrayAsync(helpers.parseSSE(plain()));
				}
			],
			[
				'parseNdjson',
				function () {
					return helpers.toArrayAsync(helpers.parseNdjson(plain()));
				}
			],
			[
				'streamToText',
				function () {
					return helpers.streamToText(plain());
				}
			],
			[
				'streamToBytes',
				function () {
					return helpers.streamToBytes(plain());
				}
			],
			[
				'streamToArray',
				function () {
					return helpers.streamToArray(plain());
				}
			]
		];
		for (const [name, read] of readers) {
			await expect(read()).rejects.toThrow(new TypeError(`${name}: the source returned a read result that is not an object, got number`));
		}
		await expect(helpers.toArrayAsync(helpers.parseNdjson([true as any]))).rejects.toThrow(
			new TypeError('parseNdjson: a chunk must be a string or a Uint8Array, got boolean')
		);
		expect(function () {
			helpers.parseNdjson('', { maxLineLength: -2 });
		}).toThrow(new RangeError('parseNdjson: `maxLineLength` must be an integer >= 0 or Infinity, got -2'));
	});

	it('cancels the stream with the error that stopped the reading', async function () {
		const sse = webStream(['data: 123456789\n\n']);
		await expect(helpers.toArrayAsync(helpers.parseSSE(sse.stream, { maxLineLength: 4 }))).rejects.toThrow(RangeError);
		expect(sse.stats.reason).toBeInstanceOf(RangeError);
		const ndjson = webStream(['{\n', '1\n']);
		await expect(helpers.toArrayAsync(helpers.parseNdjson(ndjson.stream))).rejects.toThrow(SyntaxError);
		expect(ndjson.stats.reason).toBeInstanceOf(SyntaxError);
		const text = webStream(['abc', 'def']);
		await expect(helpers.streamToText(text.stream, { maxLength: 4 })).rejects.toThrow(RangeError);
		expect(text.stats.reason).toBeInstanceOf(RangeError);
	});
});
