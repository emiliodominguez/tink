import { assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';

/**
 * Why an entry left an {@link LRUCache}, as reported to `onEvict`:
 * - `'capacity'` — the least-recently-used live entry was dropped to make room for a new key;
 * - `'expired'` — the entry's TTL had elapsed when it was found (by a lookup, `set`, `delete`, `prune`, `clear` or a capacity eviction);
 * - `'deleted'` — removed with `delete(key)`;
 * - `'cleared'` — removed by `clear()`;
 * - `'replaced'` — `set(key, value)` overwrote a live entry with a different value (`Object.is`).
 */
export type LRUEvictionReason = 'capacity' | 'expired' | 'deleted' | 'cleared' | 'replaced';

/**
 * Options accepted by {@link createLRUCache}.
 * @template K - The key type
 * @template V - The value type
 */
export interface LRUCacheOptions<K, V> {
	/** Maximum number of entries (an integer `>= 1`, or `Infinity` for an unbounded, TTL-only cache). */
	max: number;
	/** Default time-to-live of an entry in milliseconds (`> 0`; `Infinity`, the default, means entries never expire). */
	ttl?: number;
	/**
	 * Clock used for expiry, in milliseconds. Defaults to `Date.now`. Inject a fake clock for deterministic tests. Expiry instants are
	 * absolute (`setTime + ttl`), so a clock that jumps backwards extends the lifetime of the entries stored before the jump. It must
	 * return a number other than `NaN` (or the operation reading it throws a `TypeError`, changing nothing) and must not use the cache.
	 */
	now?: () => number;
	/** Called after an entry has been removed (the cache is already in its new state, so the callback may use it). */
	onEvict?: (key: K, value: V, reason: LRUEvictionReason) => void;
	/** When `true`, a successful `get` restarts the entry's TTL (sliding expiry). `peek`/`has` never do. Defaults to `false`. */
	updateAgeOnGet?: boolean;
}

/**
 * Per-entry options accepted by {@link LRUCache.set}.
 */
export interface LRUCacheSetOptions {
	/** Time-to-live of this entry in milliseconds, overriding the cache's default `ttl` (`> 0`, or `Infinity` for no expiry). */
	ttl?: number;
}

/**
 * A least-recently-used cache with optional per-entry expiry, as returned by {@link createLRUCache}.
 * Structurally compatible with `MemoizeCache` (from the `functions` module), so it can back `memoize`.
 * @template K - The key type
 * @template V - The value type
 */
export interface LRUCache<K, V> extends Iterable<[K, V]> {
	/**
	 * Number of stored entries. Expired entries are removed lazily, so this may still count entries whose TTL has elapsed but that no
	 * operation has touched yet; call `prune()` first for an exact live count. Never exceeds `max`.
	 */
	readonly size: number;
	/** Returns the value of a live entry and marks it most-recently used (restarting its TTL with `updateAgeOnGet`); `undefined` otherwise. */
	get(key: K): V | undefined;
	/**
	 * Returns the value of a live entry, as `get` does (a stored `undefined` included); on a miss (or an expired entry) calls
	 * `factory(key)`, stores its result as `set(key, value, options)` does, and returns it. `factory` is only called on a miss; when it
	 * throws, nothing is stored. Its result replaces anything `factory` itself stored under `key`. For async values, store the promise
	 * (`V = Promise<T>`): concurrent callers then share one call (single flight); delete the key when it rejects, or the rejection
	 * stays cached until it expires.
	 */
	getOrSet(key: K, factory: (key: K) => V, options?: LRUCacheSetOptions): V;
	/** Returns the value of a live entry without changing its recency or TTL; `undefined` otherwise. */
	peek(key: K): V | undefined;
	/** Whether `key` holds a live (unexpired) entry. Does not change recency. */
	has(key: K): boolean;
	/** Stores `value` as the most-recently-used entry (evicting the least-recently-used one when full) and returns the cache. */
	set(key: K, value: V, options?: LRUCacheSetOptions): LRUCache<K, V>;
	/** Removes `key`; returns `true` when a live entry was removed. */
	delete(key: K): boolean;
	/** Removes every entry. */
	clear(): void;
	/** Removes every expired entry and returns how many were removed. */
	prune(): number;
	/** Live keys, from most- to least-recently used (a snapshot taken when called). */
	keys(): IterableIterator<K>;
	/** Live values, from most- to least-recently used (a snapshot taken when called). */
	values(): IterableIterator<V>;
	/** Live `[key, value]` pairs, from most- to least-recently used (a snapshot taken when called). */
	entries(): IterableIterator<[K, V]>;
	/** Same as `entries()`. */
	[Symbol.iterator](): IterableIterator<[K, V]>;
}

/**
 * A stored entry: its key and value, its own TTL (for `updateAgeOnGet`), the instant it expires (`Infinity` for never), and its
 * neighbours in the recency list.
 * @template K - The key type
 * @template V - The value type
 */
interface Entry<K, V> {
	readonly key: K;
	value: V;
	ttl: number;
	expiresAt: number;
	/** The next more recently used entry (`undefined` for the most recently used one). */
	newer: Entry<K, V> | undefined;
	/** The next less recently used entry (`undefined` for the least recently used one). */
	older: Entry<K, V> | undefined;
}

/**
 * Key of each cache's (non-enumerable) function returning its size, called by the shared `size` getter.
 */
const SIZE = Symbol();

/**
 * The `size` getter of every cache. Sharing one getter keeps the caches' shape shared: with a getter per cache, V8 turns every cache
 * but the first into a (much slower) dictionary-mode object.
 * @returns {number} The number of entries of the cache it is read on
 */
function getSize(this: { [SIZE](): number }): number {
	return this[SIZE]();
}

/**
 * Throws unless `ttl` is a number `> 0` (`Infinity` included).
 * @param {string} caller - Name of the function, used in the error message
 * @param {number} ttl - The TTL to validate
 * @returns {void}
 * @throws {TypeError} when `ttl` is not a number
 * @throws {RangeError} when `ttl` is not a positive number
 */
function assertTTL(caller: string, ttl: number): void {
	assertNumber(caller, 'ttl', ttl, ttl > 0, 'a number > 0 or Infinity');
}

/**
 * Creates a least-recently-used cache backed by a `Map` for lookups and a doubly linked list for recency, so `get`, `set`, `peek`, `has`
 * and `delete` are O(1) (a hit only relinks two list nodes; it never re-inserts the key into the `Map`).
 *
 * Semantics:
 * - Recency: `get`, `getOrSet` and `set` make an entry most-recently used; `peek`, `has` and iteration do not.
 * - Expiry: an entry expires once `now() >= setTime + ttl`. Expired entries behave as absent everywhere, but are removed lazily: by any
 *   operation that looks the key up (`get`, `getOrSet`, `peek`, `has`, `set`, `delete`), by `prune()`, by `clear()`, or when they are the
 *   least-recently-used entry at a capacity eviction. Until then they count towards `size` and `max`. The clock is only read for entries
 *   that can expire, so a cache without TTLs never calls `now`.
 * - `onEvict(key, value, reason)` fires once per removed entry (see {@link LRUEvictionReason}), never for misses. Overwriting an entry
 *   reports the old value as `'replaced'` (`'expired'` when it had expired) unless it is the very same value (`Object.is`), so a resource
 *   is never disposed while still stored. A `-0` key is stored and reported as `0`, as by `Map`.
 *   It is called after the cache has been updated; an exception it throws propagates to the caller, but the cache stays consistent, and
 *   `clear`/`prune` still report every removed entry before rethrowing (an `AggregateError` when several calls threw).
 * - For a TTL-only cache use `max: Infinity` (see the second example).
 * Type arguments: pass them explicitly for standalone use (`createLRUCache<string, User>(...)`), or let them be inferred from a contextual
 * type or `onEvict`. When nothing determines them they default to `unknown`, so a bare `createLRUCache({ max })` works standalone and
 * slots straight into `memoize(fn, { cache: ... })`.
 * @template K - The key type (defaults to `unknown`)
 * @template V - The value type (defaults to `unknown`)
 * @param {LRUCacheOptions<K, V>} options - `max` (required), and optional `ttl`, `now`, `onEvict`, `updateAgeOnGet`
 * @returns {LRUCache<K, V>} A new, empty cache
 * @throws {TypeError} when `options` is not an object, `now`/`onEvict` is provided but not a function, `max`/`ttl` is not a number, or
 * (from `getOrSet`) `factory` is not a function
 * @throws {RangeError} when `max` is not an integer `>= 1` (or `Infinity`), or `ttl` (here, in `set` or in `getOrSet`) is not a number `> 0`
 * @throws {AggregateError} from `clear`/`prune` when several `onEvict` calls threw
 * @example
 * const cache = createLRUCache<string, number>({ max: 2 });
 * cache.set('a', 1).set('b', 2);
 * cache.get('a'); // => 1 // 'a' is now the most recently used
 * cache.set('c', 3); // evicts 'b', the least recently used
 * cache.has('b'); // => false
 * [...cache.keys()]; // => ['c', 'a'] // most recently used first
 * @example
 * // TTL-only cache: unbounded size, entries expire after one minute (5 s for 'otp'); `now` is injectable for tests
 * let clock = 0;
 * const sessions = createLRUCache<string, string>({ max: Infinity, ttl: 60_000, now: function () { return clock; } });
 * sessions.set('otp', '123456', { ttl: 5_000 });
 * sessions.set('user', 'ada');
 * clock = 5_000;
 * sessions.get('otp'); // => undefined
 * sessions.get('user'); // => 'ada'
 * sessions.prune(); // optional (e.g. on an interval): reclaims the memory of expired entries nobody looked up
 * @example
 * // Compute on a miss: `getOrSet` returns the cached value, or stores and returns what the factory returns
 * const lengths = createLRUCache<string, number>({ max: 100 });
 * let calls = 0;
 * function measure(text: string): number { calls++; return text.length; }
 * lengths.getOrSet('hello', measure); // => 5
 * lengths.getOrSet('hello', measure); // => 5
 * calls; // => 1
 * lengths.getOrSet('x', 'nope' as never); // throws TypeError
 * @example
 * // Bounded memoization
 * import { memoize } from 'tinkit/functions';
 * const square = memoize(function (n: number): number { return n * n; }, { cache: createLRUCache({ max: 100 }) });
 * square(4); // => 16
 */
export function createLRUCache<K = unknown, V = unknown>(options: LRUCacheOptions<K, V>): LRUCache<K, V> {
	if (typeof options !== 'object' || options === null) throw new TypeError(`createLRUCache: \`options\` must be an object, got ${describe(options)}`);

	const { max, ttl: defaultTTL = Infinity, now = Date.now, onEvict, updateAgeOnGet = false } = options;

	assertInteger('createLRUCache', 'max', max, 1, true);
	assertTTL('createLRUCache', defaultTTL);
	assertFunction('createLRUCache', 'now', now);
	if (onEvict !== undefined) assertFunction('createLRUCache', 'onEvict', onEvict);

	const store = new Map<K, Entry<K, V>>();
	// Both ends of the recency list.
	let newest: Entry<K, V> | undefined;
	let oldest: Entry<K, V> | undefined;
	// Whether any entry may ever expire. Until then every `expiresAt` is `Infinity`, so the clock (`Date.now` costs more than a `Map`
	// lookup) is not read at all.
	let timed = defaultTTL !== Infinity;

	/**
	 * Reads the clock, or returns `0` while no entry can expire (any finite time is then equivalent).
	 * @returns {number} The current time
	 */
	function clock(): number {
		return timed ? readNow() : 0;
	}

	/**
	 * Reads the clock and checks the result: a `NaN`, string or bigint time would make expiry instants that every check reads differently.
	 * @returns {number} The current time
	 * @throws {TypeError} when `now()` does not return a number other than `NaN`
	 */
	function readNow(): number {
		const time = now();

		if (typeof time !== 'number' || time !== time) throw new TypeError(`createLRUCache: \`now()\` must return a number, got ${time !== time ? 'NaN' : describe(time)}`);

		return time;
	}

	/**
	 * Reports a removal to `onEvict`, if any.
	 * @param {K} key - The removed key
	 * @param {V} value - The removed value
	 * @param {LRUEvictionReason} reason - Why it was removed
	 * @returns {void}
	 */
	function notify(key: K, value: V, reason: LRUEvictionReason): void {
		if (onEvict) onEvict(key, value, reason);
	}

	/**
	 * Reports several removals, calling `onEvict` for every one of them even if some calls throw; the errors are rethrown afterwards (the
	 * error itself, or an `AggregateError` holding every error in call order when several calls threw).
	 * @param {Array<[Entry<K, V>, LRUEvictionReason]>} removed - The removed entries and why
	 * @returns {void}
	 * @throws {AggregateError} when several `onEvict` calls threw (a single error is rethrown as is)
	 */
	function notifyAll(removed: Array<[Entry<K, V>, LRUEvictionReason]>): void {
		const errors: unknown[] = [];

		for (const [entry, reason] of removed) {
			try {
				notify(entry.key, entry.value, reason);
			} catch (error) {
				errors.push(error);
			}
		}

		if (errors.length > 1) throw new AggregateError(errors, `createLRUCache: ${errors.length} onEvict calls threw`);
		if (errors.length === 1) throw errors[0];
	}

	/**
	 * Inserts a detached entry at the most-recently-used end of the list.
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {void}
	 */
	function pushNewest(entry: Entry<K, V>): void {
		entry.newer = undefined;
		entry.older = newest;
		if (newest === undefined) oldest = entry;
		else newest.newer = entry;
		newest = entry;
	}

	/**
	 * Detaches an entry from the list (its own links are left as they are).
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {void}
	 */
	function unlink(entry: Entry<K, V>): void {
		if (entry.newer === undefined) newest = entry.older;
		else entry.newer.older = entry.older;
		if (entry.older === undefined) oldest = entry.newer;
		else entry.older.newer = entry.newer;
	}

	/**
	 * Removes an entry from the map and the list.
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {void}
	 */
	function remove(entry: Entry<K, V>): void {
		store.delete(entry.key);
		unlink(entry);
	}

	/**
	 * Removes an expired entry and reports it.
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {undefined} Always `undefined`, so lookups can return the result
	 */
	function expire(entry: Entry<K, V>): undefined {
		remove(entry);
		notify(entry.key, entry.value, 'expired');
	}

	/**
	 * Looks `key` up, removing it (and reporting `'expired'`) when it has expired. The clock is only read for entries that can expire.
	 * @param {K} key - The key to look up
	 * @returns {Entry<K, V> | undefined} The live entry, or `undefined`
	 */
	function lookup(key: K): Entry<K, V> | undefined {
		const entry = store.get(key);

		return entry !== undefined && entry.expiresAt !== Infinity && readNow() >= entry.expiresAt ? expire(entry) : entry;
	}

	/**
	 * Snapshots something of every live entry, from most- to least-recently used.
	 * @template T - The snapshot element type
	 * @param {(entry: Entry<K, V>) => T} pick - Extracts what to collect from a live entry
	 * @returns {IterableIterator<T>} An iterator over the snapshot
	 */
	function live<T>(pick: (entry: Entry<K, V>) => T): IterableIterator<T> {
		const time = clock();
		const result: T[] = [];

		for (let entry = newest; entry !== undefined; entry = entry.older) {
			if (time < entry.expiresAt) result.push(pick(entry));
		}

		return result.values();
	}

	/**
	 * Extracts the `[key, value]` pair of an entry.
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {[K, V]} The pair
	 */
	function pair(entry: Entry<K, V>): [K, V] {
		return [entry.key, entry.value];
	}

	/**
	 * Looks `key` up as `get` does: a live entry becomes the most recently used one (and its TTL restarts with `updateAgeOnGet`).
	 * @param {K} key - The key to look up
	 * @returns {Entry<K, V> | undefined} The live entry, or `undefined`
	 */
	function touch(key: K): Entry<K, V> | undefined {
		const entry = store.get(key);
		if (entry === undefined) return undefined;

		// Same as `lookup`, keeping the time for `updateAgeOnGet` (an entry that cannot expire has no TTL to restart).
		if (entry.expiresAt !== Infinity) {
			const time = readNow();
			if (time >= entry.expiresAt) return expire(entry);
			if (updateAgeOnGet) entry.expiresAt = time + entry.ttl;
		}

		if (entry !== newest) {
			unlink(entry);
			pushNewest(entry);
		}

		return entry;
	}

	/**
	 * Reads the TTL of a `set` (or `getOrSet`) call, validating it when it is not the (already validated) default.
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {LRUCacheSetOptions | undefined} setOptions - The call's options
	 * @returns {number} The TTL
	 * @throws {RangeError} when the TTL is not a number `> 0`
	 */
	function readTTL(caller: string, setOptions: LRUCacheSetOptions | undefined): number {
		const ttl = setOptions?.ttl ?? defaultTTL;
		if (ttl !== defaultTTL) assertTTL(caller, ttl);
		return ttl;
	}

	// `size` is defined below, with the getter shared by every cache (see `getSize`).
	const cache = {
		get(key: K): V | undefined {
			return touch(key)?.value;
		},
		getOrSet(key: K, factory: (key: K) => V, setOptions?: LRUCacheSetOptions): V {
			assertFunction('LRUCache.getOrSet', 'factory', factory);
			// Validated before `factory` runs, so that its result is never computed for nothing.
			readTTL('LRUCache.getOrSet', setOptions);

			const entry = touch(key);
			if (entry !== undefined) return entry.value;

			const value = factory(key);
			cache.set(key, value, setOptions);

			return value;
		},
		peek(key: K): V | undefined {
			return lookup(key)?.value;
		},
		has(key: K): boolean {
			return lookup(key) !== undefined;
		},
		set(key: K, value: V, setOptions?: LRUCacheSetOptions): LRUCache<K, V> {
			const ttl = readTTL('LRUCache.set', setOptions);

			if (ttl !== Infinity) timed = true;

			const time = clock();
			const entry = store.get(key);

			if (entry !== undefined) {
				const previousValue = entry.value;
				const expired = time >= entry.expiresAt;

				entry.value = value;
				entry.ttl = ttl;
				entry.expiresAt = time + ttl;
				unlink(entry);
				pushNewest(entry);

				// Storing the very same value again removes nothing, even over an expired entry: it must not be disposed while stored.
				if (!Object.is(previousValue, value)) notify(entry.key, previousValue, expired ? 'expired' : 'replaced');

				return cache;
			}

			// `Map` normalises -0 to +0; keep the key it actually stores, so iteration and eviction report the same key as before.
			const added: Entry<K, V> = { key: Object.is(key, -0) ? (0 as K) : key, value, ttl, expiresAt: time + ttl, newer: undefined, older: undefined };

			store.set(key, added);
			pushNewest(added);

			if (store.size > max) {
				// The least-recently-used entry is never the one just added (size > max >= 1).
				const evicted = oldest as Entry<K, V>;

				remove(evicted);
				notify(evicted.key, evicted.value, time >= evicted.expiresAt ? 'expired' : 'capacity');
			}

			return cache;
		},
		delete(key: K): boolean {
			const entry = lookup(key);
			if (entry === undefined) return false;

			remove(entry);
			notify(entry.key, entry.value, 'deleted');

			return true;
		},
		clear(): void {
			const time = clock();
			const removed: Array<[Entry<K, V>, LRUEvictionReason]> = [];

			for (let entry = oldest; entry !== undefined; entry = entry.newer) removed.push([entry, time >= entry.expiresAt ? 'expired' : 'cleared']);
			store.clear();
			newest = undefined;
			oldest = undefined;

			notifyAll(removed);
		},
		prune(): number {
			const time = clock();
			const expired: Array<[Entry<K, V>, LRUEvictionReason]> = [];

			for (let entry = oldest; entry !== undefined; entry = entry.newer) {
				if (time >= entry.expiresAt) expired.push([entry, 'expired']);
			}
			for (const [entry] of expired) remove(entry);
			notifyAll(expired);

			return expired.length;
		},
		keys(): IterableIterator<K> {
			return live(function (entry): K {
				return entry.key;
			});
		},
		values(): IterableIterator<V> {
			return live(function (entry): V {
				return entry.value;
			});
		},
		entries(): IterableIterator<[K, V]> {
			return live(pair);
		},
		[Symbol.iterator](): IterableIterator<[K, V]> {
			return live(pair);
		}
	} as LRUCache<K, V>;

	Object.defineProperties(cache, {
		[SIZE]: {
			value: function (): number {
				return store.size;
			}
		},
		size: { get: getSize, enumerable: true, configurable: true }
	});

	return cache;
}

// ---------------------------------------------------------------------------------------------------------------------
// createPriorityQueue
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A priority queue (binary heap) as returned by {@link createPriorityQueue}. Values that compare equal leave in insertion order.
 * @template T - The value type
 */
export interface PriorityQueue<T> extends Iterable<T> {
	/** Number of queued values. */
	readonly size: number;
	/** Adds a value in O(log n) and returns the new size. */
	push(value: T): number;
	/** Removes and returns the first value (the one `compare` orders first; the oldest among equals) in O(log n); `undefined` when empty. */
	pop(): T | undefined;
	/** Returns the first value without removing it, in O(1); `undefined` when empty. */
	peek(): T | undefined;
	/** Removes the oldest queued occurrence of `value` (compared with `===`) in O(n); returns whether one was found. */
	delete(value: T): boolean;
	/** Removes every value. */
	clear(): void;
	/** The queued values in the order `pop` would return them (a sorted snapshot taken when called; the queue is not changed). */
	[Symbol.iterator](): IterableIterator<T>;
}

/**
 * Creates a priority queue backed by a binary heap: `push` and `pop` are O(log n) and `peek` is O(1). `compare(a, b)` works like an
 * `Array.prototype.sort` comparator: a negative result means `a` leaves the queue before `b` (so `(a, b) => a - b` gives a min-queue and
 * `(a, b) => b - a` a max-queue).
 *
 * The queue is stable: values that compare equal (`0`, or `NaN`, which is treated as equal like `sort` does) leave in insertion order
 * (FIFO), which plain binary heaps do not guarantee. That is what keeps task schedulers fair among tasks of the same priority.
 * `compare` is called during `push`, `pop`, `delete` and iteration, so it must not change the queue; it should be a consistent total
 * order, or the pop order is unspecified (though every value still comes out exactly once). When `compare` throws, the error propagates
 * and the queue is left exactly as it was (a failed `push` adds nothing, a failed `pop` or `delete` removes nothing).
 * @template T - The value type
 * @param {(a: T, b: T) => number} compare - Orders two values (negative: `a` first, positive: `b` first, zero: insertion order)
 * @returns {PriorityQueue<T>} A new, empty queue
 * @throws {TypeError} when `compare` is not a function
 * @example
 * const tasks = createPriorityQueue(function (a: { name: string; priority: number }, b: { name: string; priority: number }) { return b.priority - a.priority; });
 * tasks.push({ name: 'email', priority: 1 });
 * tasks.push({ name: 'deploy', priority: 5 });
 * tasks.push({ name: 'backup', priority: 1 });
 * tasks.size; // => 3
 * tasks.peek()?.name; // => 'deploy'
 * [...tasks].map(function (task) { return task.name; }); // => ['deploy', 'email', 'backup'] // equal priorities stay FIFO
 * tasks.pop()?.name; // => 'deploy'
 * tasks.pop()?.name; // => 'email'
 */
export function createPriorityQueue<T>(compare: (a: T, b: T) => number): PriorityQueue<T> {
	assertFunction('createPriorityQueue', 'compare', compare);

	// The heap as two parallel arrays (no object per value): the values, and the insertion number of each, which breaks ties.
	let values: T[] = [];
	let order: number[] = [];
	let inserted = 0;
	// The path of the current `siftDown`, reused between calls.
	const path: number[] = [];

	/**
	 * Whether `a` (inserted as number `rankA`) leaves before `b` (inserted as number `rankB`).
	 * @param {T} a - A value
	 * @param {number} rankA - Its insertion number
	 * @param {T} b - Another value
	 * @param {number} rankB - Its insertion number
	 * @returns {boolean} `true` when `a` comes first
	 */
	function precedes(a: T, rankA: number, b: T, rankB: number): boolean {
		const result = compare(a, b);

		// `NaN` is neither below nor above zero, so it counts as equal.
		return result < 0 || (!(result > 0) && rankA < rankB);
	}

	/**
	 * Places `value` (inserted as number `rank`) at heap index `i` or above, moving the parents it precedes down (one write per level).
	 * @param {number} i - The free heap index to start from
	 * @param {T} value - The value to place
	 * @param {number} rank - Its insertion number
	 * @returns {number} The index where it was placed
	 */
	function siftUp(i: number, value: T, rank: number): number {
		// Every comparison first, then the moves: when `compare` throws, nothing has been changed.
		let target = i;

		while (target > 0) {
			const parent = (target - 1) >> 1;

			if (!precedes(value, rank, values[parent], order[parent])) break;
			target = parent;
		}
		while (i > target) {
			const parent = (i - 1) >> 1;

			values[i] = values[parent];
			order[i] = order[parent];
			i = parent;
		}
		values[i] = value;
		order[i] = rank;

		return i;
	}

	/**
	 * Places `value` (inserted as number `rank`) at heap index `i` or below, moving up the children that precede it.
	 * @param {number} i - The free heap index to start from
	 * @param {T} value - The value to place
	 * @param {number} rank - Its insertion number
	 * @returns {void}
	 */
	function siftDown(i: number, value: T, rank: number): void {
		const length = values.length;

		// Every comparison first (recording the path), then the moves: when `compare` throws, nothing has been changed.
		path.length = 0;
		for (let hole = i; ;) {
			let child = 2 * hole + 1;

			if (child >= length) break;
			if (child + 1 < length && precedes(values[child + 1], order[child + 1], values[child], order[child])) child++;
			if (!precedes(values[child], order[child], value, rank)) break;
			path.push(child);
			hole = child;
		}
		for (const child of path) {
			values[i] = values[child];
			order[i] = order[child];
			i = child;
		}
		values[i] = value;
		order[i] = rank;
	}

	/**
	 * Removes the value at heap index `i` and restores the heap.
	 * @param {number} i - A heap index
	 * @returns {T} The removed value
	 */
	function removeAt(i: number): T {
		const removed = values[i];
		const removedRank = order[i];
		const value = values.pop() as T;
		const rank = order.pop() as number;

		try {
			// The last value fills the hole; it may belong above or below it.
			if (i < values.length && siftUp(i, value, rank) === i) siftDown(i, value, rank);
		} catch (error) {
			// `compare` threw before anything moved (at most `siftUp` placed the last value in the hole): restore the exact layout.
			values[i] = removed;
			order[i] = removedRank;
			values.push(value);
			order.push(rank);
			throw error;
		}

		return removed;
	}

	const queue = {
		push(value: T): number {
			siftUp(values.length, value, inserted++);

			return values.length;
		},
		pop(): T | undefined {
			return values.length === 0 ? undefined : removeAt(0);
		},
		peek(): T | undefined {
			return values[0];
		},
		delete(value: T): boolean {
			let found = -1;

			// The oldest occurrence: the one with the smallest insertion number.
			for (let i = 0; i < values.length; i++) if (values[i] === value && (found < 0 || order[i] < order[found])) found = i;
			if (found < 0) return false;
			removeAt(found);

			return true;
		},
		clear(): void {
			values = [];
			order = [];
		},
		[Symbol.iterator](): IterableIterator<T> {
			const indexes = values.map(function (_, i) {
				return i;
			});

			// Insertion numbers are unique, so `precedes` is a strict total order and two distinct slots are never equal.
			return indexes
				.sort(function (i, j) {
					return precedes(values[i], order[i], values[j], order[j]) ? -1 : 1;
				})
				.map(function (i) {
					return values[i];
				})
				.values();
		}
	} as PriorityQueue<T>;

	Object.defineProperties(queue, {
		[SIZE]: {
			value: function (): number {
				return values.length;
			}
		},
		size: { get: getSize, enumerable: true, configurable: true }
	});

	return queue;
}

// ---------------------------------------------------------------------------------------------------------------------
// createDeque
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link createDeque}.
 */
export interface DequeOptions {
	/**
	 * The maximum number of values (an integer `>= 1`, or `Infinity`). Adding a value to a full deque drops the value at the other end:
	 * `pushBack` drops the front value and `pushFront` the back one, so a bounded deque fed with `pushBack` keeps the most recent values
	 * (a ring buffer: the last N log lines, samples or undo steps).
	 * @default Infinity
	 */
	capacity?: number;
}

/**
 * A double-ended queue, as returned by {@link createDeque}.
 * @template T - The value type
 */
export interface Deque<T> extends Iterable<T> {
	/** Number of values. */
	readonly size: number;
	/** The maximum number of values (`Infinity` when unbounded). */
	readonly capacity: number;
	/** Adds a value at the back (dropping the front value when the deque is full) and returns the new size. */
	pushBack(value: T): number;
	/** Adds a value at the front (dropping the back value when the deque is full) and returns the new size. */
	pushFront(value: T): number;
	/** Removes and returns the back value; `undefined` when empty. */
	popBack(): T | undefined;
	/** Removes and returns the front value; `undefined` when empty. */
	popFront(): T | undefined;
	/** Returns the front value without removing it; `undefined` when empty. */
	peekFront(): T | undefined;
	/** Returns the back value without removing it; `undefined` when empty. */
	peekBack(): T | undefined;
	/** Returns the value at `index` from the front (`0` is the front; a negative index counts from the back: `-1` is the back); `undefined` when out of range. */
	at(index: number): T | undefined;
	/** Removes every value. */
	clear(): void;
	/** The values from front to back (a snapshot taken when called). */
	[Symbol.iterator](): IterableIterator<T>;
}

/** Smallest length of a deque's ring (a power of two). */
const MIN_RING = 8;

/**
 * Creates a double-ended queue backed by a growable ring buffer: adding or removing a value at either end, and reading any index, are
 * O(1) (amortized: the ring doubles when full and halves when three quarters empty, so memory follows the size). `Array.prototype.shift`
 * and `unshift` are O(n), which makes arrays slow as queues; a deque is the right structure for FIFO queues, sliding windows, work
 * stealing or BFS.
 *
 * - With a `capacity`, the deque is bounded: adding to a full deque drops the value at the opposite end (see {@link DequeOptions}).
 *   Initial values beyond the capacity drop the first ones, as if pushed back one by one.
 * - Removed values are released at once (their slots are cleared), so a deque never keeps a reference to a value it no longer holds.
 * - Iteration goes from front to back over a snapshot: changing the deque while iterating is safe and does not affect the loop.
 * @template T - The value type
 * @param {Iterable<T> | null} [values] - Initial values, from front to back
 * @param {DequeOptions} [options={}] - `capacity` (default `Infinity`)
 * @returns {Deque<T>} A new deque
 * @throws {TypeError} when `values` is neither iterable nor `null`/`undefined`, or `capacity` is not a number
 * @throws {RangeError} when `capacity` is not an integer `>= 1` or `Infinity`
 * @example
 * const deque = createDeque([2, 3]);
 * deque.pushFront(1); // => 3
 * deque.pushBack(4); // => 4
 * [...deque]; // => [1, 2, 3, 4]
 * deque.at(-1); // => 4
 * deque.popFront(); // => 1
 * deque.popBack(); // => 4
 * deque.size; // => 2
 * @example
 * // A ring buffer of the last 3 values
 * const recent = createDeque<string>(null, { capacity: 3 });
 * for (const line of ['a', 'b', 'c', 'd', 'e']) recent.pushBack(line);
 * [...recent]; // => ['c', 'd', 'e']
 * createDeque([], { capacity: 0 }); // throws RangeError
 */
export function createDeque<T>(values?: Iterable<T> | null, options: DequeOptions = {}): Deque<T> {
	const capacity = readOption(options, 'capacity', Infinity);
	assertInteger('createDeque', 'options.capacity', capacity, 1, true);
	if (values != null && typeof (values as Partial<Iterable<T>>)[Symbol.iterator] !== 'function') {
		throw new TypeError(`createDeque: \`values\` must be an iterable, got ${describe(values)}`);
	}

	// The ring (its length a power of two, so that indexes wrap with a mask; filled, so that no read reaches `Array.prototype`), the
	// index of the front value, and the number of values.
	let ring: Array<T | undefined> = new Array<T | undefined>(MIN_RING).fill(undefined);
	let head = 0;
	let length = 0;

	/**
	 * Moves the values into a new ring of `size` slots, the front value first.
	 * @param {number} size - The new ring length (a power of two `>= length`)
	 * @returns {void}
	 */
	function resize(size: number): void {
		const next = new Array<T | undefined>(size).fill(undefined);
		for (let i = 0; i < length; i++) next[i] = ring[(head + i) & (ring.length - 1)];
		ring = next;
		head = 0;
	}

	/**
	 * Releases the ring's memory once it is three quarters empty.
	 * @returns {void}
	 */
	function shrink(): void {
		if (ring.length > MIN_RING && length <= ring.length >> 2) resize(ring.length >> 1);
	}

	/**
	 * Makes room for one more value: drops the value at the other end when full, grows the ring when it has no free slot.
	 * @param {boolean} back - Whether the value goes to the back
	 * @returns {void}
	 */
	function reserve(back: boolean): void {
		if (length === capacity) {
			// Full: the value at the other end leaves (its slot is cleared, so that it is not retained).
			const slot = back ? head : (head + length - 1) & (ring.length - 1);
			ring[slot] = undefined;
			if (back) head = (head + 1) & (ring.length - 1);
			length--;
		} else if (length === ring.length) resize(ring.length * 2);
	}

	const deque = {
		capacity,
		pushBack(value: T): number {
			reserve(true);
			ring[(head + length) & (ring.length - 1)] = value;
			return ++length;
		},
		pushFront(value: T): number {
			reserve(false);
			head = (head - 1) & (ring.length - 1);
			ring[head] = value;
			return ++length;
		},
		popBack(): T | undefined {
			if (length === 0) return undefined;
			const slot = (head + length - 1) & (ring.length - 1);
			const value = ring[slot];
			ring[slot] = undefined;
			length--;
			shrink();
			return value;
		},
		popFront(): T | undefined {
			if (length === 0) return undefined;
			const value = ring[head];
			ring[head] = undefined;
			head = (head + 1) & (ring.length - 1);
			length--;
			shrink();
			return value;
		},
		peekFront(): T | undefined {
			return length === 0 ? undefined : ring[head];
		},
		peekBack(): T | undefined {
			return length === 0 ? undefined : ring[(head + length - 1) & (ring.length - 1)];
		},
		at(index: number): T | undefined {
			if (!Number.isInteger(index)) assertNumber('Deque.at', 'index', index, false, 'an integer');
			const offset = index < 0 ? index + length : index;
			return offset >= 0 && offset < length ? ring[(head + offset) & (ring.length - 1)] : undefined;
		},
		clear(): void {
			ring = new Array<T | undefined>(MIN_RING).fill(undefined);
			head = 0;
			length = 0;
		},
		[Symbol.iterator](): IterableIterator<T> {
			const snapshot: T[] = [];
			for (let i = 0; i < length; i++) snapshot.push(ring[(head + i) & (ring.length - 1)] as T);
			return snapshot.values();
		}
	} as Deque<T>;

	Object.defineProperties(deque, {
		[SIZE]: {
			value: function (): number {
				return length;
			}
		},
		size: { get: getSize, enumerable: true, configurable: true }
	});

	if (values != null) for (const value of values) deque.pushBack(value);

	return deque;
}
