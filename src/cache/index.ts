import { assertFunction, assertInteger, assertNumber, describe } from '../utils/assert.js';

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
	 * absolute (`setTime + ttl`), so a clock that jumps backwards extends the lifetime of the entries stored before the jump.
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
 * - Recency: `get` and `set` make an entry most-recently used; `peek`, `has` and iteration do not.
 * - Expiry: an entry expires once `now() >= setTime + ttl`. Expired entries behave as absent everywhere, but are removed lazily: by any
 *   operation that looks the key up (`get`, `peek`, `has`, `set`, `delete`), by `prune()`, by `clear()`, or when they are the
 *   least-recently-used entry at a capacity eviction. Until then they count towards `size` and `max`. The clock is only read for entries
 *   that can expire, so a cache without TTLs never calls `now`.
 * - `onEvict(key, value, reason)` fires once per removed entry (see {@link LRUEvictionReason}), never for misses. Overwriting a live entry
 *   reports the old value as `'replaced'` unless it is the very same value (`Object.is`), so a resource is never disposed while still stored.
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
 * @throws {TypeError} when `options` is not an object, `now`/`onEvict` is provided but not a function, or `max`/`ttl` is not a number
 * @throws {RangeError} when `max` is not an integer `>= 1` (or `Infinity`), or `ttl` (here or in `set`) is not a number `> 0`
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
 * // Bounded memoization
 * import { memoize } from '@emiliodominguez/tink/functions';
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
		return timed ? now() : 0;
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
	 * @param {K} key - The key it was looked up with (reported as is)
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {undefined} Always `undefined`, so lookups can return the result
	 */
	function expire(key: K, entry: Entry<K, V>): undefined {
		remove(entry);
		notify(key, entry.value, 'expired');
	}

	/**
	 * Looks `key` up, removing it (and reporting `'expired'`) when it has expired. The clock is only read for entries that can expire.
	 * @param {K} key - The key to look up
	 * @returns {Entry<K, V> | undefined} The live entry, or `undefined`
	 */
	function lookup(key: K): Entry<K, V> | undefined {
		const entry = store.get(key);

		return entry !== undefined && entry.expiresAt !== Infinity && now() >= entry.expiresAt ? expire(key, entry) : entry;
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

	// `size` is defined below, with the getter shared by every cache (see `getSize`).
	const cache = {
		get(key: K): V | undefined {
			const entry = store.get(key);
			if (entry === undefined) return undefined;

			// Same as `lookup`, keeping the time for `updateAgeOnGet` (an entry that cannot expire has no TTL to restart).
			if (entry.expiresAt !== Infinity) {
				const time = now();
				if (time >= entry.expiresAt) return expire(key, entry);
				if (updateAgeOnGet) entry.expiresAt = time + entry.ttl;
			}

			if (entry !== newest) {
				unlink(entry);
				pushNewest(entry);
			}

			return entry.value;
		},
		peek(key: K): V | undefined {
			return lookup(key)?.value;
		},
		has(key: K): boolean {
			return lookup(key) !== undefined;
		},
		set(key: K, value: V, setOptions?: LRUCacheSetOptions): LRUCache<K, V> {
			const ttl = setOptions?.ttl ?? defaultTTL;

			// The default was validated by `createLRUCache`.
			if (ttl !== defaultTTL) {
				assertTTL('LRUCache.set', ttl);
				if (ttl !== Infinity) timed = true;
			}

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

				if (expired) notify(key, previousValue, 'expired');
				else if (!Object.is(previousValue, value)) notify(key, previousValue, 'replaced');

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
			notify(key, entry.value, 'deleted');

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
