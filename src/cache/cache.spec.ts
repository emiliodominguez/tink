import { memoize, type MemoizeCache } from '../functions/index.js';
import { createLRUCache, createPriorityQueue, type LRUCache, type LRUEvictionReason, type PriorityQueue } from '.';

function fakeClock(start = 0) {
	const clock = {
		time: start,
		now: function (): number {
			return clock.time;
		},
		advance: function (ms: number): void {
			clock.time += ms;
		}
	};
	return clock;
}

function recorder<K, V>() {
	const events: Array<[K, V, LRUEvictionReason]> = [];
	function onEvict(key: K, value: V, reason: LRUEvictionReason): void {
		events.push([key, value, reason]);
	}
	return { events, onEvict };
}

describe('createLRUCache', function () {
	describe('validation', function () {
		it.each([0, -1, 1.5, NaN, -Infinity])('throws RangeError for max = %p', function (max) {
			expect(function () {
				createLRUCache({ max });
			}).toThrow(RangeError);
		});

		it.each(['2' as any, undefined as any])('throws TypeError for a non-number max = %p', function (max) {
			expect(function () {
				createLRUCache({ max });
			}).toThrow(new TypeError(`createLRUCache: \`max\` must be an integer >= 1 or Infinity, got ${typeof max}`));
		});

		it('accepts max = Infinity and integer max >= 1', function () {
			expect(createLRUCache({ max: Infinity }).size).toBe(0);
			expect(createLRUCache({ max: 1 }).size).toBe(0);
		});

		it.each([0, -5, NaN, -Infinity])('throws RangeError for ttl = %p', function (ttl) {
			expect(function () {
				createLRUCache({ max: 2, ttl });
			}).toThrow(RangeError);
		});

		it.each(['10' as any, null as any])('throws TypeError for a non-number ttl = %p', function (ttl) {
			expect(function () {
				createLRUCache({ max: 2, ttl });
			}).toThrow(new TypeError(`createLRUCache: \`ttl\` must be a number > 0 or Infinity, got ${ttl === null ? 'null' : typeof ttl}`));
		});

		it('throws RangeError for an invalid per-entry ttl and leaves the cache untouched', function () {
			const cache = createLRUCache<string, number>({ max: 2 });
			cache.set('a', 1);
			expect(function () {
				cache.set('a', 2, { ttl: 0 });
			}).toThrow(RangeError);
			expect(function () {
				cache.set('b', 2, { ttl: NaN });
			}).toThrow(new RangeError('LRUCache.set: `ttl` must be a number > 0 or Infinity, got NaN'));
			expect([...cache]).toEqual([['a', 1]]);
		});

		it('throws TypeError for non-object options or non-function now/onEvict', function () {
			expect(function () {
				createLRUCache(null as any);
			}).toThrow(new TypeError('createLRUCache: `options` must be an object, got null'));
			expect(function () {
				createLRUCache(5 as any);
			}).toThrow(new TypeError('createLRUCache: `options` must be an object, got number'));
			expect(function () {
				createLRUCache(undefined as any);
			}).toThrow(new TypeError('createLRUCache: `options` must be an object, got undefined'));
			expect(function () {
				createLRUCache({ max: 1, now: 5 as any });
			}).toThrow(new TypeError('createLRUCache: `now` must be a function, got number'));
			expect(function () {
				createLRUCache({ max: 1, onEvict: 'x' as any });
			}).toThrow(new TypeError('createLRUCache: `onEvict` must be a function, got string'));
		});
	});

	describe('basic operations', function () {
		it('stores, reads and reports size', function () {
			const cache = createLRUCache<string, number>({ max: 3 });
			expect(cache.set('a', 1)).toBe(cache);
			cache.set('b', 2);
			expect(cache.size).toBe(2);
			expect(cache.get('a')).toBe(1);
			expect(cache.peek('b')).toBe(2);
			expect(cache.has('a')).toBe(true);
			expect(cache.has('z')).toBe(false);
			expect(cache.get('z')).toBeUndefined();
			expect(cache.peek('z')).toBeUndefined();
		});

		it('distinguishes a stored undefined via has()', function () {
			const cache = createLRUCache<string, undefined>({ max: 2 });
			cache.set('u', undefined);
			expect(cache.has('u')).toBe(true);
			expect(cache.get('u')).toBeUndefined();
		});

		it('uses SameValueZero keys like Map (NaN, -0, objects by identity, unicode)', function () {
			const cache = createLRUCache<unknown, string>({ max: 10 });
			const obj = {};
			cache.set(NaN, 'nan').set(-0, 'zero').set(obj, 'obj').set('😀', 'emoji');
			expect(cache.get(NaN)).toBe('nan');
			expect(cache.get(0)).toBe('zero');
			expect(cache.get({})).toBeUndefined();
			expect(cache.get(obj)).toBe('obj');
			expect(cache.get('😀')).toBe('emoji');
		});

		it('normalises a -0 key to +0 like Map, in iteration and eviction reports', function () {
			const evicted: unknown[] = [];
			const cache = createLRUCache<number, string>({
				max: 1,
				onEvict: function (key) {
					evicted.push(key);
				}
			});
			cache.set(-0, 'zero');
			expect(Object.is([...cache.keys()][0], 0)).toBe(true);
			cache.set(1, 'one');
			expect(Object.is(evicted[0], 0)).toBe(true);
		});

		it('reports a key stored as +0 as +0 from every removal path, whatever key it is removed with', function () {
			const clock = fakeClock();
			const reported: Array<[string, string, string]> = [];
			const cache = createLRUCache<number, string>({
				max: 5,
				ttl: 10,
				now: clock.now,
				onEvict: function (key, value, reason) {
					reported.push([Object.is(key, -0) ? '-0' : String(key), value, reason]);
				}
			});
			cache.set(0, 'a');
			cache.delete(-0);
			cache.set(0, 'b');
			cache.set(-0, 'c');
			clock.advance(20);
			cache.get(-0);
			cache.set(0, 'd');
			cache.clear();
			expect(reported).toEqual([
				['0', 'a', 'deleted'],
				['0', 'b', 'replaced'],
				['0', 'c', 'expired'],
				['0', 'd', 'cleared']
			]);
		});

		it('delete returns whether a live entry was removed', function () {
			const cache = createLRUCache<string, number>({ max: 2 });
			cache.set('a', 1);
			expect(cache.delete('a')).toBe(true);
			expect(cache.delete('a')).toBe(false);
			expect(cache.size).toBe(0);
		});

		it('clear empties the cache', function () {
			const cache = createLRUCache<string, number>({ max: 2 });
			cache.set('a', 1).set('b', 2);
			cache.clear();
			expect(cache.size).toBe(0);
			expect([...cache.keys()]).toEqual([]);
		});
	});

	describe('size', function () {
		it('is an own enumerable getter that reports the size of the cache it is read on', function () {
			const first = createLRUCache<string, number>({ max: 5 });
			const second = createLRUCache<string, number>({ max: 5 });
			first.set('a', 1).set('b', 2);
			second.set('c', 3);

			expect(first.size).toBe(2);
			expect(second.size).toBe(1);
			expect(Object.keys(first)).toContain('size');
			const descriptor = Object.getOwnPropertyDescriptor(first, 'size');
			expect(descriptor).toMatchObject({ enumerable: true, configurable: true, set: undefined });
			expect(typeof descriptor?.get).toBe('function');
			expect({ ...second }.size).toBe(1);
		});

		it('works through a proxy and for objects inheriting from a cache', function () {
			const cache = createLRUCache<string, number>({ max: 5 });
			cache.set('a', 1);

			expect(new Proxy(cache, {}).size).toBe(1);
			expect((Object.create(cache) as LRUCache<string, number>).size).toBe(1);
		});
	});

	describe('LRU order', function () {
		it('evicts the least-recently-used entry when full', function () {
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 2, onEvict });
			cache.set('a', 1).set('b', 2);
			cache.get('a');
			cache.set('c', 3);
			expect([...cache.keys()]).toEqual(['c', 'a']);
			expect(events).toEqual([['b', 2, 'capacity']]);
		});

		it('peek and has do not refresh recency', function () {
			const cache = createLRUCache<string, number>({ max: 2 });
			cache.set('a', 1).set('b', 2);
			cache.peek('a');
			cache.has('a');
			cache.set('c', 3);
			expect(cache.has('a')).toBe(false);
			expect([...cache.keys()]).toEqual(['c', 'b']);
		});

		it('set on an existing key refreshes recency without evicting', function () {
			const cache = createLRUCache<string, number>({ max: 2 });
			cache.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
			expect([...cache.entries()]).toEqual([
				['c', 3],
				['a', 10]
			]);
		});

		it('iterators go from most- to least-recently used and are snapshots', function () {
			const cache = createLRUCache<string, number>({ max: 5 });
			cache.set('a', 1).set('b', 2).set('c', 3);
			cache.get('a');
			expect([...cache.keys()]).toEqual(['a', 'c', 'b']);
			expect([...cache.values()]).toEqual([1, 3, 2]);
			expect([...cache]).toEqual([...cache.entries()]);

			const keys = cache.keys();
			cache.set('d', 4);
			expect([...keys]).toEqual(['a', 'c', 'b']);
		});

		it('max = 1 keeps only the latest key', function () {
			const cache = createLRUCache<number, number>({ max: 1 });
			for (let i = 0; i < 5; i++) cache.set(i, i);
			expect([...cache]).toEqual([[4, 4]]);
		});
	});

	describe('expiry', function () {
		it('expires entries after ttl and evicts them on get', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 10, ttl: 100, now: clock.now, onEvict });
			cache.set('a', 1);
			clock.advance(99);
			expect(cache.get('a')).toBe(1);
			clock.advance(1);
			expect(cache.size).toBe(1); // lazily removed
			expect(cache.get('a')).toBeUndefined();
			expect(cache.size).toBe(0);
			expect(events).toEqual([['a', 1, 'expired']]);
			expect(cache.get('a')).toBeUndefined();
			expect(events).toHaveLength(1); // misses never fire onEvict
		});

		it('peek, has and delete treat expired entries as absent and remove them', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 10, ttl: 10, now: clock.now, onEvict });
			cache.set('a', 1).set('b', 2).set('c', 3);
			clock.advance(10);
			expect(cache.peek('a')).toBeUndefined();
			expect(cache.has('b')).toBe(false);
			expect(cache.delete('c')).toBe(false);
			expect(cache.size).toBe(0);
			expect(events).toEqual([
				['a', 1, 'expired'],
				['b', 2, 'expired'],
				['c', 3, 'expired']
			]);
		});

		it('supports per-entry ttl overrides, including Infinity', function () {
			const clock = fakeClock();
			const cache = createLRUCache<string, number>({ max: 10, ttl: 100, now: clock.now });
			cache.set('short', 1, { ttl: 10 });
			cache.set('forever', 2, { ttl: Infinity });
			cache.set('default', 3, {});
			clock.advance(50);
			expect(cache.has('short')).toBe(false);
			expect(cache.has('default')).toBe(true);
			clock.advance(1e9);
			expect(cache.has('default')).toBe(false);
			expect(cache.get('forever')).toBe(2);
		});

		it('entries never expire without a ttl', function () {
			const clock = fakeClock();
			const cache = createLRUCache<string, number>({ max: 10, now: clock.now });
			cache.set('a', 1);
			clock.advance(Number.MAX_SAFE_INTEGER);
			expect(cache.get('a')).toBe(1);
		});

		it('defaults to Date.now', function () {
			const spy = jest.spyOn(Date, 'now').mockReturnValue(1000);
			const cache = createLRUCache<string, number>({ max: 10, ttl: 50 });
			cache.set('a', 1);
			spy.mockReturnValue(1049);
			expect(cache.get('a')).toBe(1);
			spy.mockReturnValue(1050);
			expect(cache.get('a')).toBeUndefined();
		});

		it('updateAgeOnGet restarts the ttl on get only', function () {
			const clock = fakeClock();
			const cache = createLRUCache<string, number>({ max: 10, ttl: 100, now: clock.now, updateAgeOnGet: true });
			cache.set('a', 1).set('b', 2).set('c', 3, { ttl: 20 });
			clock.advance(15);
			expect(cache.get('c')).toBe(3); // restarts with its own ttl (20)
			clock.advance(65);
			expect(cache.get('a')).toBe(1);
			expect(cache.peek('b')).toBe(2);
			expect(cache.has('c')).toBe(false); // 80 >= 15 + 20
			clock.advance(80);
			expect(cache.get('a')).toBe(1); // 160 > 100, but its age restarted at 80
			expect(cache.has('b')).toBe(false); // peek does not restart the ttl
			clock.advance(100);
			expect(cache.get('a')).toBeUndefined();
		});

		it('without updateAgeOnGet, get does not extend the ttl', function () {
			const clock = fakeClock();
			const cache = createLRUCache<string, number>({ max: 10, ttl: 100, now: clock.now });
			cache.set('a', 1);
			clock.advance(80);
			cache.get('a');
			clock.advance(20);
			expect(cache.get('a')).toBeUndefined();
		});

		it('iterators skip expired entries without removing them; prune removes them', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: Infinity, ttl: 100, now: clock.now, onEvict });
			cache.set('a', 1);
			cache.set('b', 2, { ttl: 1000 });
			cache.set('c', 3);
			clock.advance(100);
			expect([...cache.keys()]).toEqual(['b']);
			expect([...cache.values()]).toEqual([2]);
			expect(cache.size).toBe(3);
			expect(cache.prune()).toBe(2);
			expect(cache.size).toBe(1);
			expect(cache.prune()).toBe(0);
			expect(events).toEqual([
				['a', 1, 'expired'],
				['c', 3, 'expired']
			]);
		});

		it('setting over an expired entry reports it as expired, not replaced', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 1, ttl: 10, now: clock.now, onEvict });
			cache.set('a', 1);
			clock.advance(10);
			cache.set('a', 2);
			expect(events).toEqual([['a', 1, 'expired']]);
			expect(cache.get('a')).toBe(2);
		});

		it('setting the very same value over an expired entry reports nothing, since the value is still stored', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, object>();
			const resource = {};
			const cache = createLRUCache<string, object>({ max: 1, ttl: 10, now: clock.now, onEvict });
			cache.set('a', resource);
			clock.advance(10);
			cache.set('a', resource);
			expect(events).toEqual([]);
			expect(cache.get('a')).toBe(resource);
		});

		it('a capacity eviction of an expired LRU entry is reported as expired', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 2, now: clock.now, onEvict });
			cache.set('a', 1, { ttl: 5 }).set('b', 2);
			clock.advance(5);
			cache.set('c', 3);
			expect(events).toEqual([['a', 1, 'expired']]);
			expect([...cache.keys()]).toEqual(['c', 'b']);
		});

		it('clear reports live entries as cleared and expired ones as expired, oldest first', function () {
			const clock = fakeClock();
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 5, now: clock.now, onEvict });
			cache.set('a', 1, { ttl: 5 }).set('b', 2).set('c', 3);
			clock.advance(5);
			cache.clear();
			expect(events).toEqual([
				['a', 1, 'expired'],
				['b', 2, 'cleared'],
				['c', 3, 'cleared']
			]);
		});
	});

	describe('onEvict', function () {
		it('reports deleted and replaced entries, but not same-value overwrites', function () {
			const { events, onEvict } = recorder<string, object>();
			const cache = createLRUCache<string, object>({ max: 5, onEvict });
			const first = {};
			const second = {};
			cache.set('a', first);
			cache.set('a', first);
			expect(events).toEqual([]);
			cache.set('a', second);
			expect(events).toEqual([['a', first, 'replaced']]);
			cache.delete('a');
			expect(events).toEqual([
				['a', first, 'replaced'],
				['a', second, 'deleted']
			]);
		});

		it('runs after the cache was updated, so it may use the cache', function () {
			const seen: Array<[number, boolean]> = [];
			const cache: LRUCache<string, number> = createLRUCache<string, number>({
				max: 1,
				onEvict: function (key: string): void {
					seen.push([cache.size, cache.has(key)]);
				}
			});
			cache.set('a', 1).set('b', 2);
			expect(seen).toEqual([[1, false]]);
		});

		it('propagates exceptions but leaves the cache consistent', function () {
			const cache = createLRUCache<string, number>({
				max: 1,
				onEvict: function (): void {
					throw new Error('boom');
				}
			});
			cache.set('a', 1);
			expect(function () {
				cache.set('b', 2);
			}).toThrow('boom');
			expect([...cache]).toEqual([['b', 2]]);
		});

		it('reports every entry removed by clear or prune even when onEvict throws, then rethrows', function () {
			const clock = fakeClock();
			const seen: string[] = [];
			let failing = ['a'];
			const cache = createLRUCache<string, number>({
				max: 5,
				now: clock.now,
				onEvict: function (key: string): void {
					seen.push(key);
					if (failing.includes(key)) throw new Error(`boom ${key}`);
				}
			});

			cache.set('a', 1).set('b', 2).set('c', 3);
			expect(function () {
				cache.clear();
			}).toThrow('boom a');
			expect(seen).toEqual(['a', 'b', 'c']);
			expect(cache.size).toBe(0);

			seen.length = 0;
			failing = ['a', 'c'];
			cache.set('a', 1, { ttl: 1 }).set('b', 2, { ttl: 1 }).set('c', 3, { ttl: 1 }).set('d', 4);
			clock.advance(1);
			let thrown: unknown;
			try {
				cache.prune();
			} catch (error) {
				thrown = error;
			}
			expect(seen).toEqual(['a', 'b', 'c']);
			expect(thrown).toBeInstanceOf(AggregateError);
			expect((thrown as AggregateError).message).toBe('createLRUCache: 2 onEvict calls threw');
			expect((thrown as AggregateError).errors.map(String)).toEqual(['Error: boom a', 'Error: boom c']);
			expect([...cache.keys()]).toEqual(['d']);
		});
	});

	describe('memoize integration', function () {
		it('is structurally a MemoizeCache', function () {
			const cache: MemoizeCache<string, number> = createLRUCache<string, number>({ max: 3 });
			expect(cache.has('x')).toBe(false);
		});

		it('infers usable types for a bare createLRUCache({ max }) inside memoize', function () {
			function square(n: number): number {
				return n * n;
			}
			const memo = memoize(square, { cache: createLRUCache({ max: 100 }) });
			const result: number = memo(4);
			const cache: LRUCache<unknown, unknown> = memo.cache;
			expect(result).toBe(16);
			expect([...cache.keys()]).toEqual([4]);
		});

		it('bounds a memoized function', function () {
			const square = jest.fn(function (n: number): number {
				return n * n;
			});
			const memo = memoize(square, { cache: createLRUCache({ max: 100 }) });
			expect(memo(3)).toBe(9);
			expect(memo(3)).toBe(9);
			expect(square).toHaveBeenCalledTimes(1);
			expect(memo.cache.size).toBe(1);

			for (let i = 0; i < 200; i++) memo(i);
			expect(memo.cache.size).toBe(100);
			memo.clear();
			expect(memo.cache.size).toBe(0);
		});

		it('recomputes after an entry expires', function () {
			const clock = fakeClock();
			const fn = jest.fn(function (s: string): string {
				return s.toUpperCase();
			});
			const memo = memoize(fn, { cache: createLRUCache<unknown, string>({ max: 10, ttl: 1000, now: clock.now }) });
			memo('a');
			clock.advance(999);
			memo('a');
			expect(fn).toHaveBeenCalledTimes(1);
			clock.advance(1);
			expect(memo('a')).toBe('A');
			expect(fn).toHaveBeenCalledTimes(2);
		});
	});

	describe('clock reads', function () {
		it('rejects a clock returning NaN, a string or a bigint, without changing the cache', function () {
			for (const bad of [NaN, '1000', 5n]) {
				const evicted: unknown[] = [];
				let time: unknown = 0;
				const cache = createLRUCache<string, string>({
					max: 10,
					now: function () {
						return time as number;
					},
					onEvict: function (key, value) {
						evicted.push([key, value]);
					}
				});
				cache.set('a', 'old', { ttl: 100 });
				time = bad;
				expect(function () {
					cache.set('a', 'new', { ttl: 1000 });
				}).toThrow(
					new TypeError(`createLRUCache: \`now()\` must return a number, got ${typeof bad === 'string' ? 'string' : typeof bad === 'bigint' ? 'bigint' : 'NaN'}`)
				);
				expect(function () {
					cache.get('a');
				}).toThrow(TypeError);
				time = 50;
				expect([cache.get('a'), evicted]).toEqual(['old', []]);
			}
		});

		it('never reads the clock while no entry can expire', function () {
			const now = jest.fn(function (): number {
				return 0;
			});
			const cache = createLRUCache<string, number>({ max: 2, now });
			cache.set('a', 1).set('b', 2).set('a', 3).set('c', 4);
			cache.get('a');
			cache.peek('c');
			cache.has('b');
			cache.delete('c');
			expect([...cache.entries()]).toEqual([['a', 3]]);
			cache.prune();
			cache.clear();
			expect(now).not.toHaveBeenCalled();
		});

		it('starts expiring entries once a per-entry ttl is used in a cache without default ttl', function () {
			const clock = fakeClock(100);
			const { events, onEvict } = recorder<string, number>();
			const cache = createLRUCache<string, number>({ max: 10, now: clock.now, onEvict });
			cache.set('forever', 1);
			cache.set('short', 2, { ttl: 10 });
			clock.advance(9);
			expect(cache.get('short')).toBe(2);
			clock.advance(1);
			expect(cache.get('short')).toBeUndefined();
			expect(cache.get('forever')).toBe(1);
			expect(events).toEqual([['short', 2, 'expired']]);
		});

		it('keeps `size` as an enumerable accessor reflecting the current entry count', function () {
			const cache = createLRUCache<string, number>({ max: 3 });
			expect(Object.getOwnPropertyDescriptor(cache, 'size')).toMatchObject({ enumerable: true, configurable: true });
			cache.set('a', 1);
			expect(cache.size).toBe(1);
		});
	});
});

describe('createPriorityQueue', function () {
	function ascending(a: number, b: number): number {
		return a - b;
	}

	it('throws a TypeError when compare is not a function', function () {
		expect(function () {
			createPriorityQueue(undefined as any);
		}).toThrow(new TypeError('createPriorityQueue: `compare` must be a function, got undefined'));
	});

	it('pops values in comparator order', function () {
		const queue = createPriorityQueue(ascending);
		for (const n of [5, 1, 4, 1, 5, 9, 2, 6]) queue.push(n);
		const popped: number[] = [];
		while (queue.size > 0) popped.push(queue.pop() as number);
		expect(popped).toEqual([1, 1, 2, 4, 5, 5, 6, 9]);
		expect(queue.pop()).toBeUndefined();
		expect(queue.peek()).toBeUndefined();
	});

	it('returns the new size from push and peeks without removing', function () {
		const queue = createPriorityQueue(ascending);
		expect(queue.push(3)).toBe(1);
		expect(queue.push(1)).toBe(2);
		expect(queue.peek()).toBe(1);
		expect(queue.size).toBe(2);
		expect(Object.getOwnPropertyDescriptor(queue, 'size')).toMatchObject({ enumerable: true, configurable: true });
	});

	it('is stable: equal values leave in insertion order (FIFO)', function () {
		const queue = createPriorityQueue(function (a: { p: number; id: number }, b: { p: number; id: number }) {
			return b.p - a.p;
		});
		const items = [
			{ p: 1, id: 0 },
			{ p: 2, id: 1 },
			{ p: 1, id: 2 },
			{ p: 2, id: 3 },
			{ p: 1, id: 4 },
			{ p: 1, id: 5 },
			{ p: 2, id: 6 }
		];
		for (const item of items) queue.push(item);
		const ids: number[] = [];
		for (let item = queue.pop(); item !== undefined; item = queue.pop()) ids.push(item.id);
		expect(ids).toEqual([1, 3, 6, 0, 2, 4, 5]);
	});

	it('treats a NaN comparison as equal (insertion order)', function () {
		const queue = createPriorityQueue(function (): number {
			return NaN;
		});
		for (const value of ['a', 'b', 'c', 'd']) queue.push(value);
		expect([...queue]).toEqual(['a', 'b', 'c', 'd']);
		expect([queue.pop(), queue.pop(), queue.pop(), queue.pop()]).toEqual(['a', 'b', 'c', 'd']);
	});

	it('iterates a sorted snapshot without changing the queue', function () {
		const queue = createPriorityQueue(ascending);
		for (const n of [3, 1, 2]) queue.push(n);
		const iterator = queue[Symbol.iterator]();
		queue.push(0);
		expect([...iterator]).toEqual([1, 2, 3]);
		expect([...queue]).toEqual([0, 1, 2, 3]);
		expect(queue.size).toBe(4);
	});

	it('deletes the oldest occurrence of a value and keeps the heap valid', function () {
		const queue = createPriorityQueue(function (a: { p: number }, b: { p: number }) {
			return a.p - b.p;
		});
		const shared = { p: 5 };
		const values = [{ p: 4 }, shared, { p: 1 }, { p: 7 }, shared, { p: 3 }, { p: 6 }, { p: 2 }];
		for (const value of values) queue.push(value);
		expect(queue.delete({ p: 1 })).toBe(false);
		expect(queue.delete(values[2])).toBe(true);
		expect(queue.delete(shared)).toBe(true);
		expect(queue.size).toBe(6);
		expect(
			[...queue].map(function (value) {
				return value.p;
			})
		).toEqual([2, 3, 4, 5, 6, 7]);
		expect(queue.delete(shared)).toBe(true);
		expect(queue.delete(shared)).toBe(false);
		const order: number[] = [];
		for (let value = queue.pop(); value !== undefined; value = queue.pop()) order.push(value.p);
		expect(order).toEqual([2, 3, 4, 6, 7]);
	});

	it('deletes the last slot and the only value', function () {
		const queue = createPriorityQueue(ascending);
		queue.push(1);
		queue.push(2);
		expect(queue.delete(2)).toBe(true);
		expect(queue.delete(1)).toBe(true);
		expect(queue.size).toBe(0);
		expect(queue.peek()).toBeUndefined();
	});

	it('keeps FIFO order among equal values after a delete moves one of them', function () {
		const queue = createPriorityQueue(function (a: { p: number; id: string }, b: { p: number; id: string }) {
			return a.p - b.p;
		});
		const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(function (id) {
			return { p: 0, id };
		});
		for (const item of items) queue.push(item);
		queue.delete(items[1]);
		expect(
			[...queue].map(function (item) {
				return item.id;
			})
		).toEqual(['a', 'c', 'd', 'e', 'f']);
	});

	it('leaves the queue exactly as it was when compare throws during push, pop or delete', function () {
		const operations: ReadonlyArray<(queue: PriorityQueue<number>) => unknown> = [
			function (queue) {
				return queue.push(0);
			},
			function (queue) {
				return queue.pop();
			},
			function (queue) {
				return queue.delete(2);
			}
		];
		for (const operation of operations) {
			for (let throwAt = 1; throwAt <= 4; throwAt++) {
				let calls = 0;
				let armed = false;
				const queue = createPriorityQueue(function (a: number, b: number): number {
					if (armed && ++calls === throwAt) throw new Error('boom');
					return a - b;
				});
				for (const n of [1, 2, 3, 4, 5, 6, 7]) queue.push(n);
				armed = true;
				let threw = false;
				try {
					operation(queue);
				} catch {
					threw = true;
				}
				armed = false;
				if (!threw) continue;
				expect(queue.size).toBe(7);
				expect(queue.peek()).toBe(1);
				const drained: number[] = [];
				for (let value = queue.pop(); value !== undefined; value = queue.pop()) drained.push(value);
				expect(drained).toEqual([1, 2, 3, 4, 5, 6, 7]);
			}
		}
	});

	it('clears every value', function () {
		const queue = createPriorityQueue(ascending);
		queue.push(1);
		queue.push(2);
		queue.clear();
		expect(queue.size).toBe(0);
		expect([...queue]).toEqual([]);
		queue.push(3);
		expect(queue.pop()).toBe(3);
	});
});
