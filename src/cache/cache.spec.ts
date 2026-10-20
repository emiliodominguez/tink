import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { memoize, type MemoizeCache } from '../functions/index.js';
import {
	createBiMap,
	createBloomFilter,
	createDefaultMap,
	createDeque,
	createLRUCache,
	createMultiMap,
	createPriorityQueue,
	createRingBuffer,
	createTrie,
	type BiMap,
	type DefaultMap,
	type Deque,
	type LRUCache,
	type LRUEvictionReason,
	type MultiMap,
	type PriorityQueue,
	type RingBuffer,
	type Trie
} from '.';

/**
 * Returns the getter `name` of a structure, checking that it is inherited (like `Map.prototype.size`): not an own property, and not
 * enumerable, so that every instance keeps one shape and creating one defines no accessor.
 * @param {object} structure - A structure
 * @param {string} name - The getter name
 * @returns {(() => unknown) | undefined} The getter
 */
function inheritedGetter(structure: object, name: string): (() => unknown) | undefined {
	expect(Object.hasOwn(structure, name)).toBe(false);
	expect(name in structure).toBe(true);
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(structure), name);
	expect(descriptor).toMatchObject({ enumerable: false, configurable: true, set: undefined });
	expect(typeof descriptor?.get).toBe('function');
	return descriptor?.get;
}

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

		it('ignores options inherited from a polluted Object.prototype', function () {
			const proto = Object.prototype as Record<string, unknown>;
			const evicted: unknown[] = [];
			proto.max = 1;
			proto.ttl = 1;
			proto.now = function (): number {
				throw new Error('polluted clock');
			};
			proto.onEvict = function (key: unknown): void {
				evicted.push(key);
			};
			proto.updateAgeOnGet = true;
			try {
				expect(function () {
					createLRUCache({} as never);
				}).toThrow(new TypeError('createLRUCache: `max` must be an integer >= 1 or Infinity, got undefined'));
				const cache = createLRUCache<string, number>({ max: 2 });
				cache.set('a', 1).set('b', 2, {}).set('c', 3);
				// No TTL (so the polluted clock is never read), no eviction callback, and the real `max`.
				expect([...cache]).toEqual([
					['c', 3],
					['b', 2]
				]);
				expect(cache.get('b')).toBe(2);
				expect(evicted).toEqual([]);
			} finally {
				delete proto.max;
				delete proto.ttl;
				delete proto.now;
				delete proto.onEvict;
				delete proto.updateAgeOnGet;
			}
		});

		it('rejects a non-boolean updateAgeOnGet', function () {
			for (const updateAgeOnGet of ['false', 1, null]) {
				expect(function () {
					createLRUCache({ max: 1, updateAgeOnGet: updateAgeOnGet as never });
				}).toThrow(new TypeError(`createLRUCache: \`updateAgeOnGet\` must be a boolean, got ${updateAgeOnGet === null ? 'null' : typeof updateAgeOnGet}`));
			}
		});

		it('builds the shared getters when Object.prototype holds a value, writable or set', function () {
			const proto = Object.prototype as Record<string, unknown>;
			const planted = jest.fn();
			let fresh: typeof import('./index.js') | undefined;
			// A fresh copy of the module, whose prototypes are created on first use (loaded before the pollution, which the loader
			// itself would not survive).
			jest.isolateModules(function () {
				fresh = jest.requireActual<typeof import('./index.js')>('./index');
			});
			const module = fresh as typeof import('./index.js');
			proto.value = 1;
			proto.writable = true;
			proto.set = planted;
			try {
				const cache = module.createLRUCache<string, number>({ max: 2 });
				cache.set('a', 1);
				expect([cache.size, cache.totalSize]).toEqual([1, 1]);
				for (const structure of [cache, module.createDeque(), module.createRingBuffer(1), module.createBiMap(), module.createMultiMap()]) {
					expect(function () {
						(structure as { size: number }).size = 5;
					}).toThrow(TypeError);
					expect(structure.size).not.toBe(5);
				}
				expect(planted).not.toHaveBeenCalled();
			} finally {
				delete proto.value;
				delete proto.writable;
				delete proto.set;
			}
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
		it('is an inherited getter that reports the size of the cache it is read on', function () {
			const first = createLRUCache<string, number>({ max: 5 });
			const second = createLRUCache<string, number>({ max: 5 });
			first.set('a', 1).set('b', 2);
			second.set('c', 3);

			expect(first.size).toBe(2);
			expect(second.size).toBe(1);
			expect(inheritedGetter(first, 'size')).toBe(inheritedGetter(second, 'size'));
			expect(Object.getPrototypeOf(first)).toBe(Object.getPrototypeOf(second));
			// Like a `Map`, the size is not an own property: a spread copy or a serialization does not include it.
			expect(Object.keys(first)).not.toContain('size');
			expect(JSON.stringify(first)).toBe('{}');
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
		it('rejects a clock returning NaN, ±Infinity, a string or a bigint, without changing the cache', function () {
			// An infinite time would store entries that never expire (Infinity + ttl) or have expired from the start (-Infinity + ttl).
			for (const bad of [NaN, Infinity, -Infinity, '1000', 5n]) {
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
				}).toThrow(new TypeError(`createLRUCache: \`now()\` must return a finite number, got ${typeof bad === 'number' ? bad : typeof bad}`));
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

		it('keeps `size` as an inherited accessor reflecting the current entry count', function () {
			const cache = createLRUCache<string, number>({ max: 3 });
			inheritedGetter(cache, 'size');
			cache.set('a', 1);
			expect(cache.size).toBe(1);
		});
	});
});

describe('LRUCache size budget and remaining TTL', function () {
	function textCache(maxSize: number, onEvict?: (key: string, value: string, reason: LRUEvictionReason) => void): LRUCache<string, string> {
		return createLRUCache<string, string>({
			max: Infinity,
			maxSize,
			sizeOf: function (text) {
				return text.length;
			},
			onEvict
		});
	}

	it('evicts least-recently-used entries until the total size fits, several at once if needed', function () {
		const { events, onEvict } = recorder<string, string>();
		const cache = textCache(6, onEvict);
		cache.set('a', 'aa').set('b', 'bb').set('c', 'cc');
		cache.get('a');
		expect(cache.totalSize).toBe(6);
		cache.set('d', 'dddd');
		expect([...cache.keys()]).toEqual(['d', 'a']);
		expect(events).toEqual([
			['b', 'bb', 'capacity'],
			['c', 'cc', 'capacity']
		]);
		// Growing an entry evicts others too, after reporting the replaced value.
		cache.set('a', 'aaaa');
		expect([...cache]).toEqual([['a', 'aaaa']]);
		expect(cache.totalSize).toBe(4);
		expect(events.slice(2)).toEqual([
			['a', 'aa', 'replaced'],
			['d', 'dddd', 'capacity']
		]);
		cache.delete('a');
		expect(cache.totalSize).toBe(0);
	});

	it('never stores a value larger than maxSize, removing the entry it would replace', function () {
		const { events, onEvict } = recorder<string, string>();
		const cache = textCache(4, onEvict);
		cache.set('a', 'aa').set('b', 'bb');
		cache.set('a', 'too long');
		expect([...cache]).toEqual([['b', 'bb']]);
		expect(events).toEqual([['a', 'aa', 'oversized']]);
		cache.set('c', 'longer still');
		expect(cache.has('c')).toBe(false);
		expect(
			cache.getOrSet('d', function () {
				return 'way too long';
			})
		).toBe('way too long');
		expect([cache.has('d'), cache.size, cache.totalSize]).toEqual([false, 1, 2]);
		expect(events).toEqual([['a', 'aa', 'oversized']]);
	});

	it('counts each entry as 1 without sizeOf, and accepts zero-sized entries', function () {
		const counted = createLRUCache<string, number>({ max: Infinity, maxSize: 2 });
		counted.set('a', 1).set('b', 2).set('c', 3);
		expect([[...counted.keys()], counted.totalSize]).toEqual([['c', 'b'], 2]);
		const free = textCache(1);
		free.set('a', '').set('b', '').set('c', 'c');
		expect([free.size, free.totalSize]).toEqual([3, 1]);
	});

	it('keeps the total exact with fractional sizes: an emptied cache totals 0, and a value that fits on its own is kept', function () {
		const { events, onEvict } = recorder<string, number>();
		const cache = createLRUCache<string, number>({
			max: Infinity,
			maxSize: 0.3,
			sizeOf: function (size) {
				return size;
			},
			onEvict
		});
		// The doubles 0.1 and 0.2 add up to more than the double 0.3: 'a' goes.
		cache.set('a', 0.1).set('b', 0.2);
		expect([[...cache], cache.totalSize]).toEqual([[['b', 0.2]], 0.2]);
		cache.delete('b');
		expect([cache.size, cache.totalSize]).toEqual([0, 0]);
		cache.set('c', 0.3);
		expect([[...cache], cache.totalSize]).toEqual([[['c', 0.3]], 0.3]);
		cache.set('c', 0.1).set('d', 0.2);
		expect([[...cache], cache.totalSize]).toEqual([[['d', 0.2]], 0.2]);
		expect(events).toEqual([
			['a', 0.1, 'capacity'],
			['b', 0.2, 'deleted'],
			['c', 0.3, 'replaced'],
			['c', 0.1, 'capacity']
		]);
		// Sizes of very different magnitudes: the residue itself is rounded, yet an emptied cache still totals exactly 0.
		const mixed = createLRUCache<string, number>({
			max: Infinity,
			sizeOf: function (size) {
				return size;
			}
		});
		mixed
			.set('a', 0.1)
			.set('b', 0.2)
			.set('c', 2 ** 53);
		mixed.delete('a');
		mixed.delete('b');
		expect(mixed.totalSize).toBe(2 ** 53);
		mixed.delete('c');
		expect(mixed.totalSize).toBe(0);
		// Growing or shrinking an entry: 0.01 - 0.1 rounds, the total must not.
		mixed.set('d', 0.1).set('d', 0.01);
		expect(mixed.totalSize).toBe(0.01);
	});

	it('enforces maxSize and keeps the total right when the sizes add up beyond Number.MAX_VALUE', function () {
		const { events, onEvict } = recorder<string, number>();
		function identity(size: number): number {
			return size;
		}
		// 2e308 does not fit Number.MAX_VALUE: 'a' goes, and 'b', which fits on its own, stays.
		const cache = createLRUCache<string, number>({ max: Infinity, maxSize: Number.MAX_VALUE, sizeOf: identity, onEvict });
		cache.set('a', 1e308).set('b', 1e308);
		expect([[...cache], cache.totalSize, events]).toEqual([[['b', 1e308]], 1e308, [['a', 1e308, 'capacity']]]);
		cache.set('c', 5);
		expect(cache.totalSize).toBe(1e308 + 5);
		cache.set('b', 1);
		expect([cache.size, cache.totalSize]).toEqual([2, 6]);

		// Without a bound, the total is Infinity while the sizes add up beyond Number.MAX_VALUE, and comes back after.
		const unbounded = createLRUCache<string, number>({ max: Infinity, sizeOf: identity });
		unbounded.set('a', 1e308).set('b', 1e308).set('c', 1e308).set('d', 2);
		expect([unbounded.size, unbounded.totalSize]).toEqual([4, Infinity]);
		unbounded.delete('a');
		expect(unbounded.totalSize).toBe(Infinity);
		unbounded.set('b', 3);
		expect(unbounded.totalSize).toBe(1e308 + 5);
		unbounded.delete('c');
		expect(unbounded.totalSize).toBe(5);
	});

	it('reports every eviction even when onEvict throws', function () {
		const seen: string[] = [];
		const cache = textCache(4, function (key) {
			seen.push(key);
			throw new Error(key);
		});
		cache.set('a', 'a').set('b', 'b').set('c', 'cc');
		let caught: unknown;
		try {
			cache.set('d', 'dddd');
		} catch (error) {
			caught = error;
		}
		expect(seen).toEqual(['a', 'b', 'c']);
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors).toEqual([new Error('a'), new Error('b'), new Error('c')]);
		expect([...cache]).toEqual([['d', 'dddd']]);
	});

	it('validates maxSize, sizeOf and its results, leaving the cache unchanged', function () {
		for (const maxSize of [0, -1, NaN]) {
			expect(function () {
				createLRUCache({ max: 1, maxSize });
			}).toThrow(new RangeError(`createLRUCache: \`maxSize\` must be a number > 0 or Infinity, got ${maxSize}`));
		}
		expect(function () {
			createLRUCache({ max: 1, maxSize: '5' as never });
		}).toThrow(new TypeError('createLRUCache: `maxSize` must be a number > 0 or Infinity, got string'));
		expect(function () {
			createLRUCache({ max: 1, sizeOf: 5 as never });
		}).toThrow(new TypeError('createLRUCache: `sizeOf` must be a function, got number'));

		let size: unknown = 1;
		const { events, onEvict } = recorder<string, number>();
		const cache = createLRUCache<string, number>({
			max: 5,
			maxSize: 10,
			sizeOf: function () {
				if (size instanceof Error) throw size;
				return size as number;
			},
			onEvict
		});
		cache.set('a', 1);
		for (const [bad, error] of [
			['1', new TypeError('LRUCache.set: `sizeOf()` must be a finite number >= 0, got string')],
			[-1, new RangeError('LRUCache.set: `sizeOf()` must be a finite number >= 0, got -1')],
			[NaN, new RangeError('LRUCache.set: `sizeOf()` must be a finite number >= 0, got NaN')],
			[Infinity, new RangeError('LRUCache.set: `sizeOf()` must be a finite number >= 0, got Infinity')],
			[new Error('measure'), new Error('measure')]
		] as const) {
			size = bad;
			expect(function () {
				cache.set('a', 2);
			}).toThrow(error);
			expect(function () {
				cache.getOrSet('b', function () {
					return 2;
				});
			}).toThrow(error);
		}
		expect([[...cache], cache.totalSize, events]).toEqual([[['a', 1]], 1, []]);
	});

	it('reports an oversized or grown value over an expired entry as expired, and evicts for a grown value', function () {
		const clock = fakeClock();
		const { events, onEvict } = recorder<string, string[]>();
		const cache = createLRUCache<string, string[]>({
			max: Infinity,
			maxSize: 4,
			sizeOf: function (list) {
				return list.length;
			},
			ttl: 10,
			now: clock.now,
			onEvict
		});
		cache.set('a', ['x']);
		clock.advance(10);
		cache.set('a', ['x', 'x', 'x', 'x', 'x']);
		expect(events).toEqual([['a', ['x'], 'expired']]);
		// The very same value, grown: it stays, the others go to make room.
		const list = ['y'];
		cache.set('b', ['z', 'z']).set('c', list);
		list.push('y', 'y');
		cache.set('c', list);
		expect([...cache.keys()]).toEqual(['c']);
		expect(events.slice(1)).toEqual([['b', ['z', 'z'], 'capacity']]);
		// A larger value over an expired entry: reported as expired, then the evictions.
		cache.set('d', ['d']);
		clock.advance(10);
		cache.set('d', ['d', 'd']);
		expect(events.slice(2)).toEqual([
			['d', ['d'], 'expired'],
			['c', list, 'expired']
		]);
	});

	it('never reads the clock for the remaining TTL of a cache without TTLs', function () {
		const cache = createLRUCache<string, number>({
			max: 2,
			now(): number {
				throw new Error('clock');
			}
		});
		cache.set('a', 1);
		expect(cache.getRemainingTTL('a')).toBe(Infinity);
	});

	it('tells the remaining TTL without touching the entry, and expires it once it is due', function () {
		const clock = fakeClock(1000);
		const { events, onEvict } = recorder<string, number>();
		const cache = createLRUCache<string, number>({ max: 5, ttl: 100, now: clock.now, onEvict });
		cache.set('a', 1).set('forever', 2, { ttl: Infinity });
		clock.advance(30);
		expect(cache.getRemainingTTL('a')).toBe(70);
		expect(cache.getRemainingTTL('forever')).toBe(Infinity);
		expect(cache.getRemainingTTL('missing')).toBeUndefined();
		// No recency change: 'forever' is still the most recently used.
		expect([...cache.keys()]).toEqual(['forever', 'a']);
		clock.advance(70);
		expect(cache.getRemainingTTL('a')).toBeUndefined();
		expect(events).toEqual([['a', 1, 'expired']]);
		expect(cache.size).toBe(1);
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
		inheritedGetter(queue, 'size');
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

	it('moves the last value up when a delete leaves a hole below a value it precedes', function () {
		const queue = createPriorityQueue(ascending);
		// The heap is laid out as [1, 10, 2, 11, 12, 3, 4]: deleting 11 (below 10) leaves 4, the last value, to move up above 10.
		for (const n of [1, 10, 2, 11, 12, 3, 4]) queue.push(n);
		expect(queue.delete(11)).toBe(true);
		const drained: number[] = [];
		for (let value = queue.pop(); value !== undefined; value = queue.pop()) drained.push(value);
		expect(drained).toEqual([1, 2, 3, 4, 10, 12]);
		// Here a heap that only moved the value down would pop 3 before 2.
		const other = createPriorityQueue(ascending);
		for (const n of [3, 1, 6, 5, 4, 0, 2]) other.push(n);
		other.delete(5);
		const order: number[] = [];
		for (let value = other.pop(); value !== undefined; value = other.pop()) order.push(value);
		expect(order).toEqual([0, 1, 2, 3, 4, 6]);
	});

	it('deletes the oldest of several occurrences of a value, and never finds an absent undefined', function () {
		const queue = createPriorityQueue(function (a: { p: number; id: string }, b: { p: number; id: string }) {
			return a.p - b.p;
		});
		const shared = { p: 0, id: 'shared' };
		const items = [shared, { p: 0, id: 'a' }, shared, { p: 0, id: 'b' }];
		for (const item of items) queue.push(item);
		expect(queue.delete(shared)).toBe(true);
		function ids(): string[] {
			return [...queue].map(function (item) {
				return item.id;
			});
		}
		// The first `shared` (the oldest, at the root) went: the second keeps its place between 'a' and 'b'.
		expect(ids()).toEqual(['a', 'shared', 'b']);
		const later = createPriorityQueue(function (a: { p: number; id: string }, b: { p: number; id: string }) {
			return a.p - b.p;
		});
		for (const item of [{ p: 0, id: 'x' }, shared, { p: 0, id: 'y' }, shared]) later.push(item);
		later.delete(shared);
		expect(
			[...later].map(function (item) {
				return item.id;
			})
		).toEqual(['x', 'y', 'shared']);
		expect(queue.delete(undefined as never)).toBe(false);
		expect(queue.size).toBe(3);

		// Here the newer occurrence sits closer to the root than the older one: age decides, not the heap layout.
		const byAge = createPriorityQueue(function (a: { p: number; id: string }, b: { p: number; id: string }) {
			return a.p - b.p;
		});
		const s = { p: 1, id: 'S' };
		for (const item of [{ p: 1, id: 'x0' }, { p: 2, id: 'x1' }, s, { p: 1, id: 'x3' }, { p: 0, id: 'x4' }, s, { p: 0, id: 'x6' }]) byAge.push(item);
		byAge.delete(s);
		const drained: string[] = [];
		for (let item = byAge.pop(); item !== undefined; item = byAge.pop()) drained.push(item.id);
		expect(drained).toEqual(['x4', 'x6', 'x0', 'x3', 'S', 'x1']);
	});

	it('leaves the queue exactly as it was when compare throws during push, pop or delete', function () {
		interface Item {
			p: number;
			id: number;
		}
		// Priorities laid out so that deleting some items moves the last one up, and others down; ties make insertion numbers matter.
		const items: Item[] = [1, 10, 2, 11, 12, 3, 4, 10, 2, 4].map(function (p, id) {
			return { p, id };
		});
		const sorted = items.slice().sort(function (a, b) {
			return a.p - b.p;
		});
		const operations: Array<[string, (queue: PriorityQueue<Item>) => unknown]> = [
			[
				'push',
				function (queue) {
					return queue.push({ p: 0, id: -1 });
				}
			],
			[
				'pop',
				function (queue) {
					return queue.pop();
				}
			],
			...items.map(function (item): [string, (queue: PriorityQueue<Item>) => unknown] {
				return [
					`delete #${item.id}`,
					function (queue) {
						return queue.delete(item);
					}
				];
			})
		];
		for (const [name, operation] of operations) {
			for (let throwAt = 1; throwAt <= 8; throwAt++) {
				let calls = 0;
				let armed = false;
				const queue = createPriorityQueue(function (a: Item, b: Item): number {
					if (armed && ++calls === throwAt) throw new Error('boom');
					return a.p - b.p;
				});
				for (const item of items) queue.push(item);
				armed = true;
				let threw = false;
				try {
					operation(queue);
				} catch {
					threw = true;
				}
				armed = false;
				// It throws exactly when `compare` was called `throwAt` times.
				expect([name, throwAt, threw]).toEqual([name, throwAt, calls >= throwAt]);
				if (!threw) continue;
				expect(queue.size).toBe(items.length);
				const drained: Item[] = [];
				for (let item = queue.pop(); item !== undefined; item = queue.pop()) drained.push(item);
				expect([name, throwAt, drained]).toEqual([name, throwAt, sorted]);
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

describe('LRUCache.getOrSet', function () {
	it('returns a live value without calling the factory, and marks it most recently used', function () {
		const cache = createLRUCache<string, number>({ max: 2 });
		cache.set('a', 1).set('b', 2);
		const factory = jest.fn(function (): number {
			return 99;
		});
		expect(cache.getOrSet('a', factory)).toBe(1);
		expect(factory).not.toHaveBeenCalled();
		cache.set('c', 3);
		expect([...cache.keys()]).toEqual(['c', 'a']);
	});

	it('calls the factory with the key on a miss, stores and returns its result', function () {
		const events: unknown[] = [];
		const cache = createLRUCache<string, number>({
			max: 1,
			onEvict(key, value, reason) {
				events.push([key, value, reason]);
			}
		});
		cache.set('old', 0);
		expect(
			cache.getOrSet('abc', function (key) {
				return key.length;
			})
		).toBe(3);
		expect(cache.get('abc')).toBe(3);
		expect(events).toEqual([['old', 0, 'capacity']]);
	});

	it('treats a stored undefined as a hit', function () {
		const cache = createLRUCache<string, number | undefined>({ max: 2 });
		cache.set('u', undefined);
		const factory = jest.fn(function (): number {
			return 1;
		});
		expect(cache.getOrSet('u', factory)).toBeUndefined();
		expect(factory).not.toHaveBeenCalled();
	});

	it('respects TTLs: recomputes expired entries, applies the given TTL, restarts it with updateAgeOnGet', function () {
		const clock = fakeClock();
		const events: unknown[] = [];
		const cache = createLRUCache<string, number>({
			max: 10,
			ttl: 100,
			now: clock.now,
			updateAgeOnGet: true,
			onEvict(key, value, reason) {
				events.push([key, value, reason]);
			}
		});
		let next = 0;
		function factory(): number {
			return ++next;
		}
		expect(cache.getOrSet('k', factory, { ttl: 10 })).toBe(1);
		clock.advance(9);
		expect(cache.getOrSet('k', factory)).toBe(1);
		clock.advance(9);
		// Restarted by the previous hit (updateAgeOnGet).
		expect(cache.getOrSet('k', factory)).toBe(1);
		clock.advance(10);
		expect(cache.getOrSet('k', factory)).toBe(2);
		expect(events).toEqual([['k', 1, 'expired']]);
		clock.advance(99);
		expect(cache.getOrSet('k', factory)).toBe(2);
		clock.advance(100);
		expect(cache.peek('k')).toBeUndefined();
	});

	it('reads the TTL option once', function () {
		const clock = fakeClock();
		const cache = createLRUCache<string, number>({ max: 2, now: clock.now });
		let reads = 0;
		// A getter returning a valid TTL, then an invalid one: the validated TTL is the one used.
		const options = {
			get ttl(): number {
				return ++reads === 1 ? 10 : 0;
			}
		};
		expect(
			cache.getOrSet(
				'k',
				function () {
					return 1;
				},
				options
			)
		).toBe(1);
		expect([reads, cache.getRemainingTTL('k')]).toEqual([1, 10]);
	});

	it('stores nothing when the factory throws, and validates before calling it', function () {
		const cache = createLRUCache<string, number>({ max: 2 });
		expect(function () {
			cache.getOrSet('k', function (): number {
				throw new Error('boom');
			});
		}).toThrow('boom');
		expect(cache.has('k')).toBe(false);
		const factory = jest.fn(function (): number {
			return 1;
		});
		expect(function () {
			cache.getOrSet('k', factory, { ttl: 0 });
		}).toThrow(new RangeError('LRUCache.getOrSet: `ttl` must be a number > 0 or Infinity, got 0'));
		expect(factory).not.toHaveBeenCalled();
		expect(function () {
			cache.getOrSet('k', 'nope' as never);
		}).toThrow(new TypeError('LRUCache.getOrSet: `factory` must be a function, got string'));
	});

	it('stores the factory result over anything the factory stored itself', function () {
		const events: unknown[] = [];
		const cache = createLRUCache<string, number>({
			max: 3,
			onEvict(key, value, reason) {
				events.push([key, value, reason]);
			}
		});
		expect(
			cache.getOrSet('k', function (): number {
				cache.set('k', 1);
				return 2;
			})
		).toBe(2);
		expect(cache.get('k')).toBe(2);
		expect(events).toEqual([['k', 1, 'replaced']]);
	});

	it('shares one in-flight promise between concurrent callers', async function () {
		const cache = createLRUCache<string, Promise<string>>({ max: 10 });
		let calls = 0;
		function load(key: string): Promise<string> {
			calls++;
			return Promise.resolve(key.toUpperCase());
		}
		const [a, b] = await Promise.all([cache.getOrSet('x', load), cache.getOrSet('x', load)]);
		expect([a, b, calls]).toEqual(['X', 'X', 1]);
	});
});

describe('createDeque', function () {
	it('pushes, pops and peeks at both ends', function () {
		const deque: Deque<number> = createDeque<number>();
		expect(deque.size).toBe(0);
		expect(deque.capacity).toBe(Infinity);
		expect([deque.popBack(), deque.popFront(), deque.peekBack(), deque.peekFront(), deque.at(0)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(deque.pushBack(2)).toBe(1);
		expect(deque.pushFront(1)).toBe(2);
		expect(deque.pushBack(3)).toBe(3);
		expect([...deque]).toEqual([1, 2, 3]);
		expect([deque.peekFront(), deque.peekBack()]).toEqual([1, 3]);
		expect([deque.at(0), deque.at(2), deque.at(3), deque.at(-1), deque.at(-3), deque.at(-4)]).toEqual([1, 3, undefined, 3, 1, undefined]);
		expect(deque.popFront()).toBe(1);
		expect(deque.popBack()).toBe(3);
		expect(deque.popBack()).toBe(2);
		expect(deque.size).toBe(0);
	});

	it('takes initial values from any iterable, null or undefined', function () {
		expect([...createDeque('abc')]).toEqual(['a', 'b', 'c']);
		expect([...createDeque(new Set([1, 2]))]).toEqual([1, 2]);
		expect([...createDeque(null)]).toEqual([]);
		expect([...createDeque(undefined)]).toEqual([]);
		expect([
			...createDeque(
				(function* () {
					yield 1;
					yield 2;
				})()
			)
		]).toEqual([1, 2]);
	});

	it('grows and shrinks its ring across many wraps', function () {
		const deque = createDeque<number>();
		const model: number[] = [];
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 1000; i++) {
				if (i % 2) {
					deque.pushBack(i);
					model.push(i);
				} else {
					deque.pushFront(i);
					model.unshift(i);
				}
			}
			expect([...deque]).toEqual(model);
			for (let i = 0; i < 990; i++) {
				expect(i % 3 ? deque.popFront() : deque.popBack()).toBe(i % 3 ? model.shift() : model.pop());
			}
			expect([...deque]).toEqual(model);
		}
	});

	it('drops the value at the other end when full (a ring buffer)', function () {
		const deque = createDeque([1, 2, 3, 4, 5], { capacity: 3 });
		expect([...deque]).toEqual([3, 4, 5]);
		expect(deque.capacity).toBe(3);
		expect(deque.pushBack(6)).toBe(3);
		expect([...deque]).toEqual([4, 5, 6]);
		expect(deque.pushFront(0)).toBe(3);
		expect([...deque]).toEqual([0, 4, 5]);
		const one = createDeque<string>(null, { capacity: 1 });
		one.pushBack('a');
		one.pushFront('b');
		expect([...one]).toEqual(['b']);
		one.pushBack('c');
		expect([one.peekFront(), one.peekBack(), one.size]).toEqual(['c', 'c', 1]);
		const large = createDeque<number>(null, { capacity: 20 });
		for (let i = 0; i < 100; i++) large.pushBack(i);
		expect([...large]).toEqual(
			Array.from({ length: 20 }, function (_, i) {
				return 80 + i;
			})
		);
	});

	it('clears, and iterates over a snapshot', function () {
		const deque = createDeque([1, 2, 3]);
		const seen: number[] = [];
		for (const value of deque) {
			seen.push(value);
			deque.pushBack(value * 10);
		}
		expect(seen).toEqual([1, 2, 3]);
		expect(deque.size).toBe(6);
		deque.clear();
		expect([deque.size, [...deque], deque.popFront()]).toEqual([0, [], undefined]);
		deque.pushFront(7);
		expect([...deque]).toEqual([7]);
	});

	it('releases removed and dropped values', async function () {
		setFlagsFromString('--expose-gc');
		const gc = runInNewContext('gc') as () => void;
		const bounded = createDeque<object>(null, { capacity: 2 });
		const unbounded = createDeque<object>();
		const grown = createDeque<object>();
		const refs: Array<WeakRef<object>> = [];
		(function () {
			const values = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
			// Growing the ring from the front must not leave a stale copy of a value in the new ring (popping the front value, without
			// shrinking the ring, must release it).
			const first = { id: 10 };
			grown.pushBack(first);
			for (let i = 11; i < 18; i++) grown.pushBack({ id: i });
			grown.pushFront({ id: 9 });
			grown.popFront();
			grown.popFront();
			refs.push(new WeakRef(first));
			refs.push(
				...values.map(function (value) {
					return new WeakRef(value);
				})
			);
			// 1 dropped by capacity from the back, 2 by a pushFront from the front... then both popped.
			bounded.pushBack(values[0]);
			bounded.pushBack(values[1]);
			bounded.pushBack(values[2]);
			bounded.pushFront(values[3]);
			bounded.popFront();
			bounded.popBack();
			unbounded.pushFront(values[4]);
			unbounded.popBack();
		})();
		await new Promise(function (resolve) {
			setTimeout(resolve, 0);
		});
		gc();
		expect(refs).toHaveLength(6);
		expect(
			refs.filter(function (ref) {
				return ref.deref() !== undefined;
			})
		).toEqual([]);
		expect([bounded.size, unbounded.size, grown.size]).toEqual([0, 0, 7]);
	});

	it('never reads a polluted Array.prototype', function () {
		const proto = Array.prototype as unknown as Record<number, unknown>;
		proto[0] = 'polluted';
		proto[5] = 'polluted';
		try {
			const deque = createDeque<number>();
			expect([deque.peekFront(), deque.peekBack(), deque.popFront(), deque.popBack(), deque.at(0)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
			deque.pushBack(1);
			deque.clear();
			expect([deque.peekFront(), deque.peekBack(), deque.at(0)]).toEqual([undefined, undefined, undefined]);
			deque.pushBack(2);
			expect([deque.popFront(), deque.peekFront(), deque.popBack()]).toEqual([2, undefined, undefined]);
			const queue = createPriorityQueue(function (a: number, b: number) {
				return a - b;
			});
			expect([queue.pop(), queue.peek(), queue.size]).toEqual([undefined, undefined, 0]);
		} finally {
			delete proto[0];
			delete proto[5];
		}
	});

	it('validates its arguments, ignoring a polluted Object.prototype', function () {
		expect(function () {
			createDeque(5 as never);
		}).toThrow(new TypeError('createDeque: `values` must be an iterable, got number'));
		expect(function () {
			createDeque({} as never);
		}).toThrow(new TypeError('createDeque: `values` must be an iterable, got object'));
		expect(function () {
			createDeque([], { capacity: 0 });
		}).toThrow(new RangeError('createDeque: `options.capacity` must be an integer >= 1 or Infinity, got 0'));
		expect(function () {
			createDeque([], { capacity: 1.5 });
		}).toThrow(RangeError);
		expect(function () {
			createDeque([], { capacity: '3' as never });
		}).toThrow(TypeError);
		const deque = createDeque([1]);
		expect(function () {
			deque.at(0.5);
		}).toThrow(new RangeError('Deque.at: `index` must be an integer, got 0.5'));
		expect(function () {
			deque.at('0' as never);
		}).toThrow(new TypeError('Deque.at: `index` must be an integer, got string'));
		expect(function () {
			deque.at(NaN);
		}).toThrow(RangeError);
		const proto = Object.prototype as Record<string, unknown>;
		proto.capacity = 1;
		try {
			expect(createDeque([1, 2, 3]).size).toBe(3);
		} finally {
			delete proto.capacity;
		}
	});

	it('shares the size getter with the other structures', function () {
		const deque = createDeque([1, 2]);
		expect(inheritedGetter(deque, 'size')).toBe(inheritedGetter(createLRUCache({ max: 1 }), 'size'));
		expect(Object.getPrototypeOf(deque)).toBe(
			Object.getPrototypeOf(
				createPriorityQueue(function (a: number, b: number) {
					return a - b;
				})
			)
		);
		expect(deque.size).toBe(2);
	});
});

/** Collects the values a callback releases, after a garbage collection. */
async function collectGarbage(): Promise<void> {
	setFlagsFromString('--expose-gc');
	const gc = runInNewContext('gc') as () => void;
	await new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
	gc();
}

describe('createRingBuffer', function () {
	it('pushes, shifts, peeks and indexes across wraps', function () {
		const buffer: RingBuffer<number> = createRingBuffer<number>(3);
		expect([buffer.size, buffer.capacity, buffer.full]).toEqual([0, 3, false]);
		expect([buffer.shift(), buffer.peekFirst(), buffer.peekLast(), buffer.at(0), buffer.at(-1)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(buffer.push(1)).toBe(1);
		expect(buffer.push(2)).toBe(2);
		expect([buffer.peekFirst(), buffer.peekLast(), buffer.full]).toEqual([1, 2, false]);
		expect(buffer.push(3)).toBe(3);
		expect(buffer.full).toBe(true);
		expect(buffer.push(4)).toBe(3);
		expect(buffer.push(5)).toBe(3);
		expect(buffer.toArray()).toEqual([3, 4, 5]);
		expect([buffer.at(0), buffer.at(1), buffer.at(2), buffer.at(3), buffer.at(-1), buffer.at(-3), buffer.at(-4)]).toEqual([3, 4, 5, undefined, 5, 3, undefined]);
		expect([buffer.peekFirst(), buffer.peekLast()]).toEqual([3, 5]);
		expect(buffer.shift()).toBe(3);
		expect(buffer.full).toBe(false);
		expect(buffer.push(6)).toBe(3);
		expect(buffer.toArray()).toEqual([4, 5, 6]);
		expect([buffer.shift(), buffer.shift(), buffer.shift(), buffer.shift()]).toEqual([4, 5, 6, undefined]);
		expect(buffer.size).toBe(0);
		buffer.push(7);
		expect([...buffer]).toEqual([7]);
	});

	it('wraps every slot of the storage in turn (the newest value lands where the storage index wraps)', function () {
		const buffer = createRingBuffer<number>(4);
		const model: number[] = [];
		for (let i = 0; i < 40; i++) {
			buffer.push(i);
			model.push(i);
			if (model.length > 4) model.shift();
			if (i % 3 === 0) expect(buffer.shift()).toBe(model.shift());
			expect(buffer.toArray()).toEqual(model);
			expect(buffer.peekLast()).toBe(model[model.length - 1]);
			for (let index = -5; index < 5; index++) expect(buffer.at(index)).toBe(model.at(index));
		}
	});

	it('reports overwritten values to onEvict, after the push, and only those', function () {
		const seen: Array<[string, string[]]> = [];
		const buffer = createRingBuffer<string>(2, {
			onEvict: function (value) {
				seen.push([value, buffer.toArray()]);
			}
		});
		buffer.push('a');
		buffer.push('b');
		buffer.shift();
		buffer.push('c');
		expect(seen).toEqual([]);
		buffer.push('d');
		buffer.push('e');
		buffer.clear();
		expect(seen).toEqual([
			['b', ['c', 'd']],
			['c', ['d', 'e']]
		]);
	});

	it('stays consistent when onEvict throws', function () {
		const buffer = createRingBuffer<number>(1, {
			onEvict: function () {
				throw new Error('boom');
			}
		});
		buffer.push(1);
		expect(function () {
			buffer.push(2);
		}).toThrow('boom');
		expect([buffer.toArray(), buffer.size]).toEqual([[2], 1]);
	});

	it('iterates over a snapshot, and clear releases the storage', function () {
		const buffer = createRingBuffer<number>(5);
		for (const value of [1, 2, 3]) buffer.push(value);
		const seen: number[] = [];
		for (const value of buffer) {
			seen.push(value);
			buffer.push(value * 10);
		}
		expect(seen).toEqual([1, 2, 3]);
		expect(buffer.toArray()).toEqual([2, 3, 10, 20, 30]);
		const copy = buffer.toArray();
		copy.push(99);
		expect(buffer.size).toBe(5);
		buffer.clear();
		expect([buffer.size, buffer.full, buffer.toArray(), buffer.peekFirst()]).toEqual([0, false, [], undefined]);
		buffer.push(8);
		expect(buffer.toArray()).toEqual([8]);
	});

	it('allocates storage lazily: a huge capacity costs nothing until used', function () {
		const buffer = createRingBuffer<number>(2 ** 32 - 1);
		buffer.push(1);
		expect([buffer.capacity, buffer.size, buffer.at(0), buffer.full]).toEqual([2 ** 32 - 1, 1, 1, false]);
	});

	it('releases shifted, overwritten and cleared values', async function () {
		const refs: Array<WeakRef<object>> = [];
		const kept = createRingBuffer<object>(2);
		const cleared = createRingBuffer<object>(3);
		(function () {
			const values = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
			refs.push(
				...values.map(function (value) {
					return new WeakRef(value);
				})
			);
			kept.push(values[0]);
			kept.push(values[1]);
			// Overwrites 0, then shifts 1 and 2 away: only 3 stays.
			kept.push(values[2]);
			kept.push(values[3]);
			kept.shift();
			kept.shift();
			kept.push(values[3]);
			cleared.push(values[4]);
			cleared.clear();
		})();
		await collectGarbage();
		expect(
			refs.map(function (ref) {
				return ref.deref() !== undefined;
			})
		).toEqual([false, false, false, true, false]);
		expect(kept.size).toBe(1);
	});

	it('never reads a polluted Array.prototype', function () {
		const proto = Array.prototype as unknown as Record<number, unknown>;
		proto[-1] = 'polluted';
		proto[0] = 'polluted';
		proto[1] = 'polluted';
		proto[2] = 'polluted';
		try {
			const buffer = createRingBuffer<number>(3);
			expect([buffer.peekFirst(), buffer.peekLast(), buffer.shift(), buffer.at(0)]).toEqual([undefined, undefined, undefined, undefined]);
			buffer.push(1);
			buffer.push(2);
			buffer.shift();
			buffer.shift();
			// The oldest slot is now past the end of the (still growing) storage.
			expect([buffer.peekFirst(), buffer.peekLast(), buffer.shift(), buffer.at(0), buffer.at(-1)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
		} finally {
			delete proto[-1];
			delete proto[0];
			delete proto[1];
			delete proto[2];
		}
	});

	it('validates its arguments, ignoring a polluted Object.prototype', function () {
		expect(function () {
			createRingBuffer(0);
		}).toThrow(new RangeError('createRingBuffer: `capacity` must be an integer between 1 and 4294967295, got 0'));
		for (const capacity of [1.5, -1, Infinity, NaN, 2 ** 32]) {
			expect(function () {
				createRingBuffer(capacity);
			}).toThrow(RangeError);
		}
		expect(function () {
			createRingBuffer('3' as never);
		}).toThrow(new TypeError('createRingBuffer: `capacity` must be an integer between 1 and 4294967295, got string'));
		expect(function () {
			createRingBuffer(1, { onEvict: 'no' as never });
		}).toThrow(new TypeError('createRingBuffer: `options.onEvict` must be a function, got string'));
		const buffer = createRingBuffer<number>(2);
		expect(function () {
			buffer.at(0.5);
		}).toThrow(new RangeError('RingBuffer.at: `index` must be an integer, got 0.5'));
		expect(function () {
			buffer.at('0' as never);
		}).toThrow(new TypeError('RingBuffer.at: `index` must be an integer, got string'));
		const proto = Object.prototype as Record<string, unknown>;
		proto.onEvict = function (): void {
			throw new Error('polluted');
		};
		try {
			const polluted = createRingBuffer<number>(1);
			polluted.push(1);
			expect(polluted.push(2)).toBe(1);
		} finally {
			delete proto.onEvict;
		}
	});

	it('shares the size and full getters between buffers', function () {
		const a = createRingBuffer<number>(1);
		const b = createRingBuffer<number>(2);
		expect(inheritedGetter(a, 'size')).toBe(inheritedGetter(createDeque(), 'size'));
		expect(inheritedGetter(a, 'full')).toBe(inheritedGetter(b, 'full'));
		a.push(1);
		expect([a.full, b.full, b.size]).toEqual([true, false, 0]);
		// `full` never depends on the (writable) `capacity` property.
		(a as { capacity: number }).capacity = 10;
		expect(a.full).toBe(true);
	});
});

describe('createDefaultMap', function () {
	it('creates, stores and returns the value of a missing key, once', function () {
		const keys: string[] = [];
		const map: DefaultMap<string, string[]> = createDefaultMap(function (key: string): string[] {
			keys.push(key);
			return [key];
		});
		const a = map.get('a');
		expect(a).toEqual(['a']);
		expect(map.get('a')).toBe(a);
		expect(keys).toEqual(['a']);
		expect([map.peek('b'), map.has('b'), map.size]).toEqual([undefined, false, 1]);
		expect(map.set('b', ['x'])).toBe(map);
		expect(map.get('b')).toEqual(['x']);
		expect(map.delete('b')).toBe(true);
		expect(map.delete('b')).toBe(false);
		expect([...map.keys(), ...map.values(), ...map.entries()]).toEqual(['a', ['a'], ['a', ['a']]]);
		map.clear();
		expect(map.size).toBe(0);
	});

	it('treats a stored undefined as a hit, and -0 and NaN keys as a Map does', function () {
		let calls = 0;
		const map = createDefaultMap<number, number | undefined>(
			function (key) {
				calls++;
				return key * 2;
			},
			[[1, undefined]]
		);
		expect(map.get(1)).toBeUndefined();
		expect(map.get(-0)).toBe(0);
		expect(map.get(0)).toBe(0);
		expect([...map.keys()]).toEqual([1, 0]);
		expect(map.get(NaN)).toBeNaN();
		expect(map.get(NaN)).toBeNaN();
		expect(calls).toBe(2);
	});

	it('passes the factory the key as the map stores it (-0 as 0), as Map.prototype.getOrInsertComputed does', function () {
		const keys: number[] = [];
		const map = createDefaultMap(function (key: number): string {
			keys.push(key);
			return Object.is(key, -0) ? 'minus zero' : 'zero';
		});
		expect(map.get(-0)).toBe('zero');
		expect(Object.is(keys[0], 0)).toBe(true);
	});

	it('stores nothing when the factory throws, and keeps the factory result over what the factory stored', function () {
		const map = createDefaultMap<string, number>(function (key) {
			if (key === 'bad') throw new Error('nope');
			map.set(key, -1);
			return 1;
		});
		expect(function () {
			map.get('bad');
		}).toThrow('nope');
		expect(map.has('bad')).toBe(false);
		expect(map.get('x')).toBe(1);
		expect(map.peek('x')).toBe(1);
		expect(map.size).toBe(1);
	});

	it('iterates live, as a Map', function () {
		const map = createDefaultMap<number, number>(
			function (key) {
				return key;
			},
			[[1, 1]]
		);
		const seen: number[] = [];
		for (const [key] of map) {
			seen.push(key);
			if (key < 3) map.get(key + 1);
		}
		expect(seen).toEqual([1, 2, 3]);
		expect([...map]).toEqual([
			...new Map([
				[1, 1],
				[2, 2],
				[3, 3]
			])
		]);
	});

	it('validates its arguments', function () {
		expect(function () {
			createDefaultMap('x' as never);
		}).toThrow(new TypeError('createDefaultMap: `factory` must be a function, got string'));
		expect(function () {
			createDefaultMap(String, 5 as never);
		}).toThrow(new TypeError('createDefaultMap: `entries` must be an iterable, got number'));
		expect(createDefaultMap(String, null).size).toBe(0);
		expect(Object.getOwnPropertyDescriptor(createDefaultMap(String), 'size')).toEqual(Object.getOwnPropertyDescriptor(createDeque(), 'size'));
	});
});

describe('createBiMap', function () {
	it('looks up both ways and keeps the pairs one-to-one', function () {
		const map: BiMap<string, number> = createBiMap<string, number>();
		expect(map.set('a', 1)).toBe(map);
		map.set('b', 2);
		expect([map.get('a'), map.getKey(2), map.has('b'), map.hasValue(1), map.hasValue(3), map.get('z'), map.getKey(9)]).toEqual([
			1,
			'b',
			true,
			true,
			false,
			undefined,
			undefined
		]);
		// 'a' takes 2: its old pair (a, 1) and the pair of 2 (b, 2) both go.
		map.set('a', 2);
		expect([...map]).toEqual([['a', 2]]);
		expect([map.size, map.hasValue(1), map.has('b')]).toEqual([1, false, false]);
		// The same pair again changes nothing.
		map.set('c', 3);
		map.set('a', 2);
		expect([...map]).toEqual([
			['a', 2],
			['c', 3]
		]);
		expect([map.delete('a'), map.delete('a'), map.deleteValue(3), map.deleteValue(3)]).toEqual([true, false, true, false]);
		expect(map.size).toBe(0);
	});

	it('keeps the place of the side that stays, in each direction', function () {
		const map = createBiMap([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
		map.set('a', 4);
		expect([...map.keys()]).toEqual(['a', 'b', 'c']);
		expect([...map.inverse.keys()]).toEqual([2, 3, 4]);
		map.set('d', 2);
		expect([...map.entries()]).toEqual([
			['a', 4],
			['c', 3],
			['d', 2]
		]);
		expect([...map.inverse]).toEqual([
			[2, 'd'],
			[3, 'c'],
			[4, 'a']
		]);
		expect([...map.values()]).toEqual([4, 3, 2]);
	});

	it('exposes an inverse view over the same storage', function () {
		const map = createBiMap<string, number>([['x', 1]]);
		const inverse: BiMap<number, string> = map.inverse;
		expect(inverse.inverse).toBe(map);
		expect(map.inverse).toBe(inverse);
		inverse.set(2, 'y');
		expect(map.get('y')).toBe(2);
		expect(inverse.size).toBe(2);
		inverse.delete(1);
		expect(map.has('x')).toBe(false);
		map.clear();
		expect([map.size, inverse.size]).toEqual([0, 0]);
		expect(inheritedGetter(map, 'size')).toBe(inheritedGetter(inverse, 'size'));
		expect(inheritedGetter(map, 'inverse')).toBe(inheritedGetter(inverse, 'inverse'));
		// Inherited: spreading and serializing do not walk into the cycle.
		map.set('z', 26);
		expect(JSON.stringify(map)).toBe('{}');
		expect(JSON.stringify(inverse)).toBe('{}');
		expect({ ...inverse }.inverse).toBeUndefined();
	});

	it('keeps pairs with an undefined key or value intact when other keys and values change', function () {
		const map = createBiMap<string | undefined, number | undefined>([
			[undefined, 1],
			['u', undefined]
		]);
		map.set('a', 2);
		map.set('b', 3);
		expect([map.delete('missing'), map.deleteValue(42)]).toEqual([false, false]);
		expect([...map]).toEqual([
			[undefined, 1],
			['u', undefined],
			['a', 2],
			['b', 3]
		]);
		expect([map.getKey(undefined), map.get(undefined), map.inverse.size]).toEqual(['u', 1, 4]);
	});

	it('compares with SameValueZero and stores -0 as 0 on both sides', function () {
		const map = createBiMap<number, number>();
		map.set(-0, -0);
		expect([...map]).toEqual([[0, 0]]);
		expect([...map.inverse]).toEqual([[0, 0]]);
		map.set(NaN, NaN);
		map.set(NaN, NaN);
		expect([map.get(NaN), map.getKey(NaN), map.size]).toEqual([NaN, NaN, 2]);
		map.set(0, NaN);
		expect([...map]).toEqual([[0, NaN]]);
	});

	it('validates its entries', function () {
		expect(function () {
			createBiMap(1 as never);
		}).toThrow(new TypeError('createBiMap: `entries` must be an iterable, got number'));
		expect(createBiMap(undefined).size).toBe(0);
	});
});

describe('createMultiMap', function () {
	it('groups values per key, counting values and keys', function () {
		const map: MultiMap<string, number> = createMultiMap<string, number>();
		expect([map.add('a', 1), map.add('a', 1), map.add('b', 2), map.add('a', 3)]).toEqual([true, true, true, true]);
		expect([map.size, map.keyCount, map.count('a'), map.count('z')]).toEqual([4, 2, 3, 0]);
		expect(map.get('a')).toEqual([1, 1, 3]);
		expect(map.get('z')).toEqual([]);
		expect([map.has('a'), map.has('z'), map.has('a', 3), map.has('a', 2), map.has('z', 1)]).toEqual([true, false, true, false, false]);
		expect(map.delete('a', 1)).toBe(true);
		expect(map.get('a')).toEqual([1, 3]);
		expect([map.delete('a', 7), map.delete('z', 1), map.delete('z')]).toEqual([false, false, false]);
		expect(map.delete('a')).toBe(true);
		expect([map.size, map.keyCount, [...map]]).toEqual([1, 1, [['b', 2]]]);
		expect(map.delete('b', 2)).toBe(true);
		expect([map.size, map.keyCount, map.has('b')]).toEqual([0, 0, false]);
	});

	it('distinguishes an undefined value from no value, and finds NaN', function () {
		const map = createMultiMap<string, number | undefined>([
			['a', undefined],
			['a', NaN],
			['a', 1]
		]);
		expect([map.has('a', undefined), map.has('a', NaN), map.has('a', 2)]).toEqual([true, true, false]);
		expect(map.delete('a', undefined)).toBe(true);
		expect(map.delete('a', NaN)).toBe(true);
		expect(map.delete('a', NaN)).toBe(false);
		expect([...map]).toEqual([['a', 1]]);
		// Never reads past the end of a group.
		const proto = Array.prototype as unknown as Record<number, unknown>;
		proto[1] = NaN;
		try {
			expect([map.has('a', NaN), map.delete('a', NaN), map.get('a')]).toEqual([false, false, [1]]);
		} finally {
			delete proto[1];
		}
	});

	it('keeps each value once per key with `unique`', function () {
		const map = createMultiMap<string, number>(null, { unique: true });
		expect([map.add('a', 1), map.add('a', 1), map.add('a', -0), map.add('a', 0), map.add('a', NaN), map.add('a', NaN)]).toEqual([true, false, true, false, true, false]);
		expect(map.get('a')).toEqual([1, 0, NaN]);
		expect([map.size, map.count('a'), map.has('a', 0), map.has('a', 2)]).toEqual([3, 3, true, false]);
		expect([map.delete('a', 2), map.delete('a', 0), map.delete('a', 1), map.delete('a', NaN)]).toEqual([false, true, true, true]);
		expect([map.size, map.keyCount]).toEqual([0, 0]);
		map.add('b', 1);
		map.add('b', 2);
		expect(map.delete('b')).toBe(true);
		expect(map.size).toBe(0);
	});

	it('returns copies and iterates over snapshots', function () {
		const map = createMultiMap([
			['a', 1],
			['b', 2]
		]);
		const values = map.get('a');
		values.push(99);
		map.add('a', 3);
		expect(values).toEqual([1, 99]);
		expect(map.get('a')).toEqual([1, 3]);
		const seen: Array<[string, number]> = [];
		for (const pair of map) {
			seen.push(pair);
			map.delete(pair[0]);
			map.add('c', 0);
		}
		expect(seen).toEqual([
			['a', 1],
			['a', 3],
			['b', 2]
		]);
		expect([...map.keys()]).toEqual(['c']);
		expect([...map.values()]).toEqual([0, 0, 0]);
		map.clear();
		expect([map.size, map.keyCount, [...map.entries()]]).toEqual([0, 0, []]);
	});

	it('validates its arguments, ignoring a polluted Object.prototype', function () {
		expect(function () {
			createMultiMap(1 as never);
		}).toThrow(new TypeError('createMultiMap: `entries` must be an iterable, got number'));
		const proto = Object.prototype as Record<string, unknown>;
		proto.unique = true;
		try {
			const map = createMultiMap<string, number>();
			map.add('a', 1);
			expect(map.add('a', 1)).toBe(true);
		} finally {
			delete proto.unique;
		}
		// A truthy non-boolean (a 'false' read from a configuration file) does not turn `unique` on.
		for (const unique of ['false', 1, null]) {
			expect(function () {
				createMultiMap(null, { unique: unique as never });
			}).toThrow(new TypeError(`createMultiMap: \`options.unique\` must be a boolean, got ${unique === null ? 'null' : typeof unique}`));
		}
		const map = createMultiMap();
		expect(inheritedGetter(map, 'size')).toBe(inheritedGetter(createDeque(), 'size'));
		expect(inheritedGetter(map, 'keyCount')).toBe(inheritedGetter(createMultiMap(), 'keyCount'));
		expect([map.size, map.keyCount]).toEqual([0, 0]);
	});
});

describe('createTrie', function () {
	it('stores, finds and removes keys, splitting and merging edges', function () {
		const trie: Trie<number> = createTrie<number>();
		expect(trie.set('romane', 1)).toBe(trie);
		trie.set('romanus', 2).set('romulus', 3).set('rubens', 4).set('ruber', 5).set('rubicon', 6).set('rubicundus', 7);
		expect(trie.size).toBe(7);
		expect([trie.get('romanus'), trie.get('roman'), trie.get('r'), trie.get('rubiconx'), trie.get(''), trie.get('x')]).toEqual([
			2,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		]);
		expect([trie.has('ruber'), trie.has('rube'), trie.has('rubers')]).toEqual([true, false, false]);
		expect([...trie.keys()]).toEqual(['romane', 'romanus', 'romulus', 'rubens', 'ruber', 'rubicon', 'rubicundus']);
		// A key ending at a branch point, then on an edge.
		trie.set('rub', 8).set('rom', 9);
		expect(trie.keysWithPrefix('rub')).toEqual(['rub', 'rubens', 'ruber', 'rubicon', 'rubicundus']);
		expect(trie.set('rub', 10).size).toBe(9);
		expect([trie.delete('ru'), trie.delete('rubx'), trie.delete('rubicundu')]).toEqual([false, false, false]);
		expect(trie.delete('rub')).toBe(true);
		expect(trie.delete('rub')).toBe(false);
		expect(trie.delete('rubicon')).toBe(true);
		expect(trie.delete('rubicundus')).toBe(true);
		expect(trie.keysWithPrefix('rub')).toEqual(['rubens', 'ruber']);
		expect(trie.delete('romane')).toBe(true);
		expect(trie.delete('rom')).toBe(true);
		expect([...trie]).toEqual([
			['romanus', 2],
			['romulus', 3],
			['rubens', 4],
			['ruber', 5]
		]);
		for (const key of ['romanus', 'romulus', 'rubens', 'ruber']) expect(trie.delete(key)).toBe(true);
		expect([trie.size, [...trie], trie.hasPrefix(''), trie.hasPrefix('r')]).toEqual([0, [], false, false]);
	});

	it('answers prefix queries, including prefixes that end inside an edge', function () {
		const trie = createTrie([
			['apple', 1],
			['application', 2],
			['apply', 3],
			['banana', 4]
		]);
		expect(trie.keysWithPrefix('appl')).toEqual(['apple', 'application', 'apply']);
		expect(trie.keysWithPrefix('applic')).toEqual(['application']);
		expect(trie.keysWithPrefix('applix')).toEqual([]);
		expect(trie.keysWithPrefix('bananas')).toEqual([]);
		expect(trie.keysWithPrefix('c')).toEqual([]);
		expect(trie.keysWithPrefix('')).toEqual(['apple', 'application', 'apply', 'banana']);
		expect(trie.entriesWithPrefix('app', { limit: 2 })).toEqual([
			['apple', 1],
			['application', 2]
		]);
		expect(trie.keysWithPrefix('app', { limit: 0 })).toEqual([]);
		expect(trie.keysWithPrefix('app', { limit: 1 })).toEqual(['apple']);
		expect(trie.keysWithPrefix('', { limit: Infinity })).toHaveLength(4);
		expect([trie.hasPrefix('ban'), trie.hasPrefix('banana'), trie.hasPrefix('bananas'), trie.hasPrefix('bx'), trie.hasPrefix('')]).toEqual([
			true,
			true,
			false,
			false,
			true
		]);
		expect([...trie.values()]).toEqual([1, 2, 3, 4]);
	});

	it('finds the longest stored prefix of a text', function () {
		const trie = createTrie([
			['a', 1],
			['abc', 2],
			['abcde', 3]
		]);
		expect([trie.longestPrefixOf('abcd'), trie.longestPrefixOf('abcdef'), trie.longestPrefixOf('ab'), trie.longestPrefixOf('b'), trie.longestPrefixOf('')]).toEqual([
			'abc',
			'abcde',
			'a',
			undefined,
			undefined
		]);
		trie.set('', 0);
		expect([trie.longestPrefixOf('b'), trie.longestPrefixOf(''), trie.get(''), trie.size]).toEqual(['', '', 0, 4]);
		expect(trie.keysWithPrefix('')[0]).toBe('');
		expect(trie.delete('')).toBe(true);
		expect(trie.longestPrefixOf('x')).toBeUndefined();
	});

	it('stores undefined values and prototype-like keys safely', function () {
		const trie = createTrie<number | undefined>();
		trie.set('__proto__', undefined).set('constructor', 1).set('toString', 2).set('hasOwnProperty', 3);
		expect([trie.has('__proto__'), trie.get('__proto__'), trie.size]).toEqual([true, undefined, 4]);
		expect(trie.keysWithPrefix('_')).toEqual(['__proto__']);
		expect([trie.get('valueOf'), trie.has('__defineGetter__'), trie.longestPrefixOf('constructors')]).toEqual([undefined, false, 'constructor']);
		expect(({} as Record<string, unknown>).constructor).toBe(Object);
	});

	it('orders keys by UTF-16 code units, like Array.prototype.sort', function () {
		const keys = ['\u{1F600}', '\uFFFF', '\u00E9', 'e\u0301', 'Z', 'a', '\uD83D', '\u{1F600}x', 'ab', 'a\u0000', ''];
		const trie = createTrie(
			keys.map(function (key): [string, string] {
				return [key, key];
			})
		);
		expect([...trie.keys()]).toEqual([...keys].sort());
		expect(trie.keysWithPrefix('\uD83D')).toEqual(['\uD83D', '\u{1F600}', '\u{1F600}x']);
		expect(trie.size).toBe(keys.length);
	});

	it('handles very long keys and very deep tries without recursion', function () {
		const trie = createTrie<number>();
		const depth = 4000;
		for (let i = 1; i <= depth; i++) trie.set('a'.repeat(i), i);
		expect(trie.size).toBe(depth);
		const keys = [...trie.keys()];
		expect(keys).toHaveLength(depth);
		expect(keys[depth - 1]).toBe('a'.repeat(depth));
		expect(trie.longestPrefixOf('a'.repeat(depth + 5))).toBe('a'.repeat(depth));
		expect(trie.keysWithPrefix('a'.repeat(depth - 1))).toEqual(['a'.repeat(depth - 1), 'a'.repeat(depth)]);
		const long = 'x'.repeat(1_000_000);
		trie.set(long, -1);
		expect([trie.get(long), trie.has(long.slice(1)), trie.hasPrefix(long.slice(0, 500_000))]).toEqual([-1, false, true]);
	});

	it('keeps listing in key order after every kind of change below a node it already listed', function () {
		const trie = createTrie([
			['ab', 1],
			['ac', 2],
			['b', 3]
		]);
		/** Lists every key, then the keys under `a`, so that both nodes have been listed before the next change. */
		function listed(): string[] {
			expect(trie.keysWithPrefix('a')).toEqual(
				[...trie.keys()].filter(function (key) {
					return key.startsWith('a');
				})
			);
			return [...trie.keys()];
		}
		expect(listed()).toEqual(['ab', 'ac', 'b']);
		trie.set('aa', 0); // a new leaf under a listed node
		expect(listed()).toEqual(['aa', 'ab', 'ac', 'b']);
		trie.set('bz', 4); // a new leaf under a listed leaf
		trie.set('bb', 5);
		expect(listed()).toEqual(['aa', 'ab', 'ac', 'b', 'bb', 'bz']);
		trie.set('abcd', 6);
		expect(listed()).toEqual(['aa', 'ab', 'abcd', 'ac', 'b', 'bb', 'bz']);
		trie.set('abce', 7); // splits the listed edge 'cd'
		trie.set('abd', 8);
		trie.set('abc', 9);
		expect(listed()).toEqual(['aa', 'ab', 'abc', 'abcd', 'abce', 'abd', 'ac', 'b', 'bb', 'bz']);
		trie.set('0', -1); // a new leaf under the listed root
		trie.set('ba', 10);
		expect(listed()).toEqual(['0', 'aa', 'ab', 'abc', 'abcd', 'abce', 'abd', 'ac', 'b', 'ba', 'bb', 'bz']);
		trie.delete('aa'); // removes a leaf of a listed node
		expect(listed()).toEqual(['0', 'ab', 'abc', 'abcd', 'abce', 'abd', 'ac', 'b', 'ba', 'bb', 'bz']);
		trie.delete('abc'); // a node with two children loses its value
		trie.delete('abd'); // its parent is merged with its only child
		expect(listed()).toEqual(['0', 'ab', 'abcd', 'abce', 'ac', 'b', 'ba', 'bb', 'bz']);
		trie.delete('ab');
		trie.delete('ac'); // the node of 'a' is left with one child and no value: merged into its parent, the root
		expect(listed()).toEqual(['0', 'abcd', 'abce', 'b', 'ba', 'bb', 'bz']);
		trie.delete('b'); // a valued node with three children loses its value
		trie.delete('ba');
		trie.delete('bb'); // leaves the node of 'b' without value and with one child: merged
		expect(listed()).toEqual(['0', 'abcd', 'abce', 'bz']);
		trie.clear();
		expect(listed()).toEqual([]);
		trie.set('q', 1);
		expect(listed()).toEqual(['q']);
	});

	it('keeps no reference to a string longer than its keys need (a deleted long key, or a key sliced from a long text)', async function () {
		const tries: Array<Trie<number>> = [];
		await collectGarbage();
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < 20; i++) {
			const trie = createTrie<number>();
			const prefix = `a shared prefix ${i} `;
			// One megabyte that the trie no longer needs once the key is deleted: the edge of the prefix outlives it.
			const long = prefix + 'x'.repeat(1_000_000) + i;
			trie.set(long, 0);
			trie.set(prefix + 'a', 1);
			trie.set(prefix + 'b', 2);
			trie.delete(long);
			// A short key cut from a megabyte of text.
			const text = 'y'.repeat(1_000_000) + i;
			trie.set(text.slice(1000, 1040), 3);
			tries.push(trie);
		}
		await collectGarbage();
		// 40 MB if the labels kept views of the long strings.
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(8_000_000);
		expect(
			tries[7].keysWithPrefix('a shared prefix 7 ').concat(
				tries[7].keysWithPrefix('y').map(function (key) {
					return String(key.length);
				})
			)
		).toEqual(['a shared prefix 7 a', 'a shared prefix 7 b', '40']);
	});

	it('returns snapshots and clears', function () {
		const trie = createTrie([
			['a', 1],
			['b', 2]
		]);
		const keys = trie.keysWithPrefix('');
		const iterator = trie.entries();
		trie.set('c', 3);
		trie.delete('a');
		expect(keys).toEqual(['a', 'b']);
		expect([...iterator]).toEqual([
			['a', 1],
			['b', 2]
		]);
		const seen: string[] = [];
		for (const [key] of trie) {
			seen.push(key);
			trie.set(key + key, 0);
		}
		expect(seen).toEqual(['b', 'c']);
		trie.clear();
		expect([trie.size, [...trie], trie.get('b')]).toEqual([0, [], undefined]);
		trie.set('b', 9);
		expect([...trie]).toEqual([['b', 9]]);
	});

	it('validates its arguments', function () {
		const trie = createTrie<number>();
		const calls: Array<[string, () => unknown]> = [
			[
				'Trie.get: `key`',
				function () {
					return trie.get(1 as never);
				}
			],
			[
				'Trie.has: `key`',
				function () {
					return trie.has(null as never);
				}
			],
			[
				'Trie.set: `key`',
				function () {
					return trie.set(undefined as never, 1);
				}
			],
			[
				'Trie.delete: `key`',
				function () {
					return trie.delete({} as never);
				}
			],
			[
				'Trie.hasPrefix: `prefix`',
				function () {
					return trie.hasPrefix(1 as never);
				}
			],
			[
				'Trie.keysWithPrefix: `prefix`',
				function () {
					return trie.keysWithPrefix(1 as never);
				}
			],
			[
				'Trie.entriesWithPrefix: `prefix`',
				function () {
					return trie.entriesWithPrefix(1 as never);
				}
			],
			[
				'Trie.longestPrefixOf: `text`',
				function () {
					return trie.longestPrefixOf(1 as never);
				}
			]
		];
		for (const [message, call] of calls)
			expect(call).toThrow(
				new TypeError(
					`${message} must be a string, got ${message.includes('has:') ? 'null' : message.includes('set:') ? 'undefined' : message.includes('delete') ? 'object' : 'number'}`
				)
			);
		expect(function () {
			trie.keysWithPrefix('', { limit: -1 });
		}).toThrow(new RangeError('Trie.keysWithPrefix: `options.limit` must be an integer >= 0 or Infinity, got -1'));
		expect(function () {
			trie.entriesWithPrefix('', { limit: 1.5 });
		}).toThrow(new RangeError('Trie.entriesWithPrefix: `options.limit` must be an integer >= 0 or Infinity, got 1.5'));
		expect(function () {
			createTrie(1 as never);
		}).toThrow(new TypeError('createTrie: `entries` must be an iterable, got number'));
		expect(trie.size).toBe(0);
		const proto = Object.prototype as Record<string, unknown>;
		proto.limit = 0;
		try {
			expect(createTrie([['a', 1]]).keysWithPrefix('')).toEqual(['a']);
		} finally {
			delete proto.limit;
		}
		expect(Object.getOwnPropertyDescriptor(trie, 'size')).toEqual(Object.getOwnPropertyDescriptor(createDeque(), 'size'));
	});
});

describe('createBloomFilter', function () {
	/** Reference MurmurHash3 x86_32 over bytes, written from the reference C code (SMHasher). */
	function murmur3(bytes: Uint8Array, seed: number): number {
		function rotl(x: number, r: number): number {
			return (x << r) | (x >>> (32 - r));
		}
		function scramble(k: number): number {
			return Math.imul(rotl(Math.imul(k, 0xcc9e2d51), 15), 0x1b873593);
		}
		let h = seed | 0;
		const blocks = bytes.length >> 2;
		for (let b = 0; b < blocks; b++) {
			const i = b * 4;
			h ^= scramble(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
			h = (Math.imul(rotl(h, 13), 5) + 0xe6546b64) | 0;
		}
		const tail = blocks * 4;
		const rest = bytes.length & 3;
		let k = 0;
		if (rest >= 3) k ^= bytes[tail + 2] << 16;
		if (rest >= 2) k ^= bytes[tail + 1] << 8;
		if (rest >= 1) h ^= scramble(k ^ bytes[tail]);
		h ^= bytes.length;
		h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
		h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
		return (h ^ (h >>> 16)) >>> 0;
	}

	/** The bit positions of `item` by the documented scheme, from the reference hash. */
	function positions(item: string, bits: number, hashes: number): number[] {
		const bytes = new Uint8Array(Buffer.from(item, 'utf16le'));
		let x = (murmur3(bytes, 0) >>> 1) % bits;
		let y = (murmur3(bytes, 0x9747b28c) >>> 1) % bits;
		const result: number[] = [];
		for (let i = 1; i <= hashes; i++) {
			result.push(x);
			x = (x + y) % bits;
			y = (y + i) % bits;
		}
		return result;
	}

	it('has a correct reference MurmurHash3 (published test vectors)', function () {
		const vectors: Array<[number[] | string, number, number]> = [
			[[], 0, 0],
			[[], 1, 0x514e28b7],
			[[], 0xffffffff, 0x81f16f39],
			[[0, 0, 0, 0], 0, 0x2362f9de],
			[[0xff, 0xff, 0xff, 0xff], 0, 0x76293b50],
			[[0x21, 0x43, 0x65, 0x87], 0, 0xf55b516b],
			[[0x21, 0x43, 0x65, 0x87], 0x5082edee, 0x2362f9de],
			[[0x21, 0x43, 0x65], 0, 0x7e4a8634],
			[[0x21, 0x43], 0, 0xa0f7b07a],
			[[0x21], 0, 0x72661cf4],
			['Hello, world!', 1234, 0xfaf6cdb3],
			['The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2fa826cd]
		];
		for (const [input, seed, expected] of vectors) {
			const bytes = typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'latin1')) : new Uint8Array(input);
			expect(murmur3(bytes, seed)).toBe(expected);
		}
	});

	it('sets exactly the bits of the documented scheme (MurmurHash3 of the UTF-16LE code units, top 31 bits, enhanced double hashing)', function () {
		const items = ['', 'a', 'ab', 'abc', '\u00E9', '\u{1F600}', '\uD83D', 'hello world', 'x'.repeat(33), '\uFFFF\u0000\u8000'];
		for (const [bits, hashes] of [
			[32, 1],
			[64, 3],
			[1000, 7],
			[96, 40]
		]) {
			for (const item of items) {
				const filter = createBloomFilter({ bits, hashes });
				filter.add(item);
				const expected = new Uint8Array(filter.bits / 8);
				for (const position of positions(item, filter.bits, hashes)) expected[position >> 3] |= 1 << (position & 7);
				expect(filter.toBytes()).toEqual(expected);
			}
		}
	});

	it('sizes itself with the optimal formulas', function () {
		const cases: Array<[number, number, number, number]> = [
			[1000, 0.01, 9600, 7],
			[1_000_000, 0.001, 14_377_600, 10],
			[1, 0.5, 32, 22],
			[100, 0.1, 480, 3],
			[10_000, 1e-9, 431_328, 30]
		];
		for (const [expectedItems, falsePositiveRate, bits, hashes] of cases) {
			const filter = createBloomFilter({ expectedItems, falsePositiveRate });
			expect([filter.bits, filter.hashes]).toEqual([bits, hashes]);
		}
		expect(createBloomFilter({ expectedItems: 1000 }).bits).toBe(9600);
		// The optimal number of hashes passes 256 only for absurd rates.
		expect(createBloomFilter({ expectedItems: 1, falsePositiveRate: 1e-300 }).hashes).toBe(256);
		const explicit = createBloomFilter({ bits: 33, hashes: 2 });
		expect([explicit.bits, explicit.hashes, explicit.toBytes().length]).toEqual([64, 2, 8]);
	});

	it('meets its false-positive rate on structured keys, which a single 32-bit hash could not', function () {
		const items = 100_000;
		const filter = createBloomFilter({ expectedItems: items, falsePositiveRate: 1e-6 });
		for (let i = 0; i < items; i++) filter.add(`user:${i}`);
		let positives = 0;
		for (let i = items; i < items + 400_000; i++) if (filter.has(`user:${i}`)) positives++;
		// About 0.4 expected; with one 32-bit hash, each query would collide with an added item with probability 100,000 / 2³², about 9
		// false positives whatever the size.
		expect(positives).toBeLessThan(4);
		const percent = createBloomFilter({ expectedItems: 10_000, falsePositiveRate: 0.01 });
		for (let i = 0; i < 10_000; i++) percent.add(String(i));
		let hits = 0;
		for (let i = 10_000; i < 110_000; i++) if (percent.has(String(i))) hits++;
		expect(hits / 100_000).toBeGreaterThan(0.0085);
		expect(hits / 100_000).toBeLessThan(0.0115);
	});

	it('estimates its fill, its rate and its number of items', function () {
		const filter = createBloomFilter({ bits: 32, hashes: 1 });
		expect([filter.estimatedFalsePositiveRate(), filter.estimatedSize()]).toEqual([0, 0]);
		expect(Object.is(filter.estimatedSize(), 0)).toBe(true);
		let added = 0;
		for (let i = 0; added < 32; i++) if (filter.add(String(i))) added++;
		expect([filter.estimatedFalsePositiveRate(), filter.estimatedSize()]).toEqual([1, Infinity]);
		expect(filter.toBytes()).toEqual(new Uint8Array(4).fill(255));
		filter.clear();
		expect([filter.estimatedFalsePositiveRate(), filter.estimatedSize(), filter.has('0')]).toEqual([0, 0, false]);
		const big = createBloomFilter({ expectedItems: 5000, falsePositiveRate: 0.02 });
		for (let i = 0; i < 2500; i++) big.add(`k${i}`);
		expect(Math.abs(big.estimatedSize() - 2500)).toBeLessThan(75);
	});

	it('reads the bytes of `data` themselves, whatever own properties shadow its view', function () {
		const filter = createBloomFilter({ bits: 64, hashes: 3 });
		filter.add('a');
		const backing = new Uint8Array(24);
		backing.set(filter.toBytes(), 8);
		const data = backing.subarray(8, 16);
		Object.defineProperties(data, { buffer: { value: new ArrayBuffer(8) }, byteOffset: { value: 16 }, byteLength: { value: 8 }, length: { value: 8 } });
		expect(createBloomFilter({ bits: 64, hashes: 3, data }).toBytes()).toEqual(filter.toBytes());
		const short = backing.subarray(0, 4);
		Object.defineProperties(short, { byteLength: { value: 8 }, length: { value: 8 } });
		expect(function () {
			createBloomFilter({ bits: 64, hashes: 3, data: short });
		}).toThrow(new RangeError('createBloomFilter: `data` must hold 8 bytes (bits / 8), got 4'));
	});

	it('restores from bytes of any realm, and copies them', function () {
		const filter = createBloomFilter({ bits: 64, hashes: 3 });
		filter.add('a');
		const bytes = filter.toBytes();
		const restored = createBloomFilter({ bits: 64, hashes: 3, data: bytes });
		bytes.fill(0);
		expect(restored.has('a')).toBe(true);
		expect(createBloomFilter({ bits: 64, hashes: 3, data: Buffer.from(filter.toBytes()) }).has('a')).toBe(true);
		const foreign = runInNewContext('new Uint8Array(8)') as Uint8Array;
		foreign.set(filter.toBytes());
		const fromForeign = createBloomFilter({ bits: 64, hashes: 3, data: foreign });
		expect([fromForeign.has('a'), fromForeign.estimatedSize()]).toEqual([true, filter.estimatedSize()]);
		// Every bit of every byte maps back.
		const full = createBloomFilter({ bits: 32, hashes: 1, data: new Uint8Array([1, 2, 128, 255]) });
		expect(full.toBytes()).toEqual(new Uint8Array([1, 2, 128, 255]));
		expect(full.estimatedFalsePositiveRate()).toBe(11 / 32);
	});

	it('validates its options, ignoring a polluted Object.prototype', function () {
		const errors: Array<[unknown, Error | typeof TypeError | typeof RangeError]> = [
			[null, new TypeError('createBloomFilter: `options` must be an object, got null')],
			['x', new TypeError('createBloomFilter: `options` must be an object, got string')],
			[{}, new TypeError('createBloomFilter: `expectedItems` must be an integer >= 1, got undefined')],
			[{ expectedItems: 0 }, new RangeError('createBloomFilter: `expectedItems` must be an integer >= 1, got 0')],
			[{ expectedItems: 1.5 }, new RangeError('createBloomFilter: `expectedItems` must be an integer >= 1, got 1.5')],
			[{ expectedItems: 10, falsePositiveRate: 0 }, new RangeError('createBloomFilter: `falsePositiveRate` must be a number between 0 and 1 (exclusive), got 0')],
			[{ expectedItems: 10, falsePositiveRate: 1 }, new RangeError('createBloomFilter: `falsePositiveRate` must be a number between 0 and 1 (exclusive), got 1')],
			[{ expectedItems: 10, falsePositiveRate: NaN }, new RangeError('createBloomFilter: `falsePositiveRate` must be a number between 0 and 1 (exclusive), got NaN')],
			[
				{ expectedItems: 10, falsePositiveRate: '0.1' },
				new TypeError('createBloomFilter: `falsePositiveRate` must be a number between 0 and 1 (exclusive), got string')
			],
			[
				{ expectedItems: 1e9, falsePositiveRate: 0.01 },
				new RangeError('createBloomFilter: 1000000000 items at a false-positive rate of 0.01 need 9585058400 bits, more than 2147483648')
			],
			[
				{ expectedItems: 10, hashes: 2 },
				new TypeError('createBloomFilter: pass either `expectedItems` (and `falsePositiveRate`) or `bits` and `hashes` (and `data`), not both')
			],
			[{ expectedItems: 10, data: new Uint8Array(4) }, TypeError],
			[{ bits: 64, hashes: 2, expectedItems: 10 }, TypeError],
			[{ bits: 64, hashes: 2, falsePositiveRate: 0.1 }, TypeError],
			[{ bits: 0, hashes: 1 }, new RangeError('createBloomFilter: `bits` must be an integer between 1 and 2147483648, got 0')],
			[{ bits: 2 ** 31 + 1, hashes: 1 }, RangeError],
			[{ bits: 64.5, hashes: 1 }, RangeError],
			[{ bits: '64', hashes: 1 }, new TypeError('createBloomFilter: `bits` must be an integer between 1 and 2147483648, got string')],
			[{ bits: 64 }, new TypeError('createBloomFilter: `hashes` must be an integer between 1 and 256, got undefined')],
			[{ bits: 64, hashes: 0 }, new RangeError('createBloomFilter: `hashes` must be an integer between 1 and 256, got 0')],
			[{ bits: 64, hashes: 257 }, RangeError],
			[{ bits: 64, hashes: 1.5 }, RangeError],
			[{ bits: 64, hashes: 1, data: [0, 0, 0, 0, 0, 0, 0, 0] }, new TypeError('createBloomFilter: `data` must be a Uint8Array, got object')],
			[{ bits: 64, hashes: 1, data: new Uint16Array(4) }, TypeError],
			[{ bits: 64, hashes: 1, data: { [Symbol.toStringTag]: 'Uint8Array', length: 8 } }, TypeError],
			[{ bits: 64, hashes: 1, data: new Uint8Array(4) }, new RangeError('createBloomFilter: `data` must hold 8 bytes (bits / 8), got 4')],
			[{ bits: 40, hashes: 1, data: new Uint8Array(5) }, new RangeError('createBloomFilter: `data` must hold 8 bytes (bits / 8), got 5')]
		];
		for (const [options, error] of errors) {
			expect(function () {
				createBloomFilter(options as never);
			}).toThrow(error);
		}
		// The bounds themselves are accepted.
		expect([
			createBloomFilter({ bits: 1, hashes: 1 }).bits,
			createBloomFilter({ bits: 2 ** 31 - 31, hashes: 1 }).bits,
			createBloomFilter({ bits: 2 ** 31, hashes: 1 }).bits
		]).toEqual([32, 2 ** 31, 2 ** 31]);
		expect(createBloomFilter({ bits: 64, hashes: 256 }).hashes).toBe(256);
		expect(createBloomFilter({ expectedItems: 1_488_522_235, falsePositiveRate: 0.5 }).bits).toBe(2 ** 31);
		expect(function () {
			createBloomFilter({ expectedItems: 1_488_522_236, falsePositiveRate: 0.5 });
		}).toThrow(new RangeError('createBloomFilter: 1488522236 items at a false-positive rate of 0.5 need 2147483680 bits, more than 2147483648'));
		const filter = createBloomFilter({ bits: 64, hashes: 2 });
		expect(function () {
			filter.add(1 as never);
		}).toThrow(new TypeError('BloomFilter.add: `item` must be a string, got number'));
		expect(function () {
			filter.has(undefined as never);
		}).toThrow(new TypeError('BloomFilter.has: `item` must be a string, got undefined'));
		const proto = Object.prototype as Record<string, unknown>;
		proto.bits = 64;
		proto.hashes = 1;
		proto.data = new Uint8Array(1);
		try {
			expect(createBloomFilter({ expectedItems: 1000 }).bits).toBe(9600);
			expect(createBloomFilter({ bits: 32, hashes: 2 }).toBytes()).toEqual(new Uint8Array(4));
		} finally {
			delete proto.bits;
			delete proto.hashes;
			delete proto.data;
		}
	});
});
