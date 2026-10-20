import { assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';

/**
 * Why an entry left an {@link LRUCache}, as reported to `onEvict`:
 * - `'capacity'` — the least-recently-used live entry was dropped to make room (for a new key, or under `maxSize` for a larger value);
 * - `'expired'` — the entry's TTL had elapsed when it was found (by a lookup, `set`, `delete`, `prune`, `clear` or a capacity eviction);
 * - `'deleted'` — removed with `delete(key)`;
 * - `'cleared'` — removed by `clear()`;
 * - `'replaced'` — `set(key, value)` overwrote a live entry with a different value (`Object.is`);
 * - `'oversized'` — `set(key, value)` was given a value whose `sizeOf` exceeds `maxSize`: that value was not stored, and the live entry
 *   it would have overwritten was removed.
 */
export type LRUEvictionReason = 'capacity' | 'expired' | 'deleted' | 'cleared' | 'replaced' | 'oversized';

/**
 * Options accepted by {@link createLRUCache}.
 * @template K - The key type
 * @template V - The value type
 */
export interface LRUCacheOptions<K, V> {
	/** Maximum number of entries (an integer `>= 1`, or `Infinity` for an unbounded, TTL-only or `maxSize`-only cache). */
	max: number;
	/**
	 * Maximum total size of the entries, as measured by `sizeOf` (a number `> 0`, or `Infinity`, the default): the least-recently-used
	 * entries are evicted until the total fits, so a cache can be bounded in bytes, tokens or any other weight rather than in entries.
	 * A value larger than `maxSize` is never stored (see `'oversized'` in {@link LRUEvictionReason}).
	 * @default Infinity
	 */
	maxSize?: number;
	/**
	 * Measures an entry for `maxSize` and `totalSize`: a finite number `>= 0` (otherwise `set` throws, changing nothing). It is called
	 * once per `set` (and per `getOrSet` miss), before the cache changes, and must not use the cache. Defaults to `1` per entry.
	 */
	sizeOf?: (value: V, key: K) => number;
	/** Default time-to-live of an entry in milliseconds (`> 0`; `Infinity`, the default, means entries never expire). */
	ttl?: number;
	/**
	 * Clock used for expiry, in milliseconds. Defaults to `Date.now`. Inject a fake clock for deterministic tests. Expiry instants are
	 * absolute (`setTime + ttl`), so a clock that jumps backwards extends the lifetime of the entries stored before the jump. It must
	 * return a finite number (or the operation reading it throws a `TypeError`, changing nothing) and must not use the cache.
	 */
	now?: () => number;
	/** Called after an entry has been removed (the cache is already in its new state, so the callback may use it). */
	onEvict?: (key: K, value: V, reason: LRUEvictionReason) => void;
	/** When `true`, a successful `get` restarts the entry's TTL (sliding expiry). `peek`/`has` never do. A boolean; defaults to `false`. */
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
	/**
	 * Total size of the stored entries, as measured by `sizeOf` (the number of entries without it). Never exceeds `maxSize`. It is kept
	 * as a compensated sum (about twice the precision of a plain running total), so fractional sizes do not drift as entries come and
	 * go (an emptied cache totals `0`); `Infinity` while the sizes add up beyond `Number.MAX_VALUE`.
	 */
	readonly totalSize: number;
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
	/**
	 * The milliseconds left before the entry of `key` expires (`Infinity` when it never does), or `undefined` when there is no live
	 * entry. Changes neither recency nor TTL (e.g. to send a `Cache-Control: max-age`, or to refresh an entry ahead of its expiry).
	 */
	getRemainingTTL(key: K): number | undefined;
	/**
	 * Stores `value` as the most-recently-used entry (evicting least-recently-used ones until the cache fits `max` and `maxSize`) and
	 * returns the cache.
	 */
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
 * A stored entry: its key and value, its size (from `sizeOf`), its own TTL (for `updateAgeOnGet`), the instant it expires (`Infinity`
 * for never), and its neighbours in the recency list.
 * @template K - The key type
 * @template V - The value type
 */
interface Entry<K, V> {
	readonly key: K;
	value: V;
	size: number;
	ttl: number;
	expiresAt: number;
	/** The next more recently used entry (`undefined` for the most recently used one). */
	newer: Entry<K, V> | undefined;
	/** The next less recently used entry (`undefined` for the least recently used one). */
	older: Entry<K, V> | undefined;
}

/**
 * Key of each structure's function returning its size, called by the shared `size` getter.
 */
const SIZE = Symbol();

/**
 * The `size` getter of every structure.
 * @returns {number} The number of values or entries of the structure it is read on
 */
function getSize(this: { [SIZE](): number }): number {
	return this[SIZE]();
}

/**
 * Creates a prototype holding shared getters (not enumerable, like `Map.prototype.size`).
 * @param {Record<string, () => unknown>} getters - The getters, by property name
 * @returns {object} The prototype
 */
function withGetters(getters: Record<string, () => unknown>): object {
	const prototype = {};
	// Descriptors without a prototype: a `value`, `writable` or `set` planted on `Object.prototype` would make `defineProperty` throw (an
	// accessor with a value), or install a setter.
	for (const name of Object.keys(getters)) Object.defineProperty(prototype, name, { __proto__: null, get: getters[name], configurable: true } as PropertyDescriptor);
	return prototype;
}

/** The prototype of the structures whose only getter is `size`, created on first use. */
let sized: object | undefined;

/**
 * Returns the prototype of the structures whose only getter is `size`, creating it on first use (a call at the top level of the module would run on import, and keep
 * bundlers from dropping the module when nothing of it is used).
 * @returns {object} The prototype
 */
function sizedPrototype(): object {
	return (sized ??= withGetters({ size: getSize }));
}

/**
 * Key of each LRU cache's function returning its total size, called by the shared `totalSize` getter.
 */
const TOTAL_SIZE = Symbol();

/**
 * The `totalSize` getter of every LRU cache.
 * @returns {number} The total size of the cache it is read on
 */
function getTotalSize(this: { [TOTAL_SIZE](): number }): number {
	return this[TOTAL_SIZE]();
}

/** The prototype of LRU caches, created on first use. */
let lru: object | undefined;

/**
 * Returns the prototype of LRU caches, creating it on first use (a call at the top level of the module would run on import, and keep
 * bundlers from dropping the module when nothing of it is used).
 * @returns {object} The prototype
 */
function lruPrototype(): object {
	return (lru ??= withGetters({ size: getSize, totalSize: getTotalSize }));
}

/**
 * Builds a structure: an object inheriting the shared getters of `prototype`, holding `methods` (closures over the structure's state,
 * so they work unbound) and the functions the getters call. Built this way, a structure costs about 40 ns to create: an object literal
 * with a computed key such as `[Symbol.iterator]`, or `Object.defineProperties` on each instance, costs 150 to 400 ns, more than a
 * short-lived queue or cache spends doing its job. With the getters on a shared prototype, every instance also keeps one shape (a getter
 * per instance turns every instance but the first into a much slower dictionary-mode object).
 * @template T - The structure type
 * @param {object} prototype - The prototype with the structure's getters
 * @param {object} methods - The methods (an object literal without computed keys)
 * @param {() => number} size - Returns the size
 * @param {() => Iterator<unknown>} iterate - The `[Symbol.iterator]` method
 * @returns {T} The structure
 */
function build<T>(prototype: object, methods: object, size: () => number, iterate: () => Iterator<unknown>): T {
	const structure = Object.assign(Object.create(prototype) as Record<symbol, unknown>, methods);
	structure[SIZE] = size;
	structure[Symbol.iterator] = iterate;
	return structure as T;
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
 * - Size budget: with `maxSize` and `sizeOf`, the cache also evicts least-recently-used entries until the total size fits (see the
 *   fourth example); a value too large to ever fit is not stored. Without `sizeOf`, each entry counts as `1`.
 * - For a TTL-only cache use `max: Infinity` (see the second example).
 * Type arguments: pass them explicitly for standalone use (`createLRUCache<string, User>(...)`), or let them be inferred from a contextual
 * type or `onEvict`. When nothing determines them they default to `unknown`, so a bare `createLRUCache({ max })` works standalone and
 * slots straight into `memoize(fn, { cache: ... })`.
 * @template K - The key type (defaults to `unknown`)
 * @template V - The value type (defaults to `unknown`)
 * @param {LRUCacheOptions<K, V>} options - `max` (required), and optional `maxSize`, `sizeOf`, `ttl`, `now`, `onEvict`, `updateAgeOnGet`
 * @returns {LRUCache<K, V>} A new, empty cache
 * @throws {TypeError} when `options` is not an object, `now`/`onEvict`/`sizeOf` is provided but not a function, `max`/`maxSize`/`ttl`
 * is not a number, `updateAgeOnGet` is not a boolean, (from `getOrSet`) `factory` is not a function, or (from `set`/`getOrSet`)
 * `sizeOf` does not return a number
 * @throws {RangeError} when `max` is not an integer `>= 1` (or `Infinity`), `maxSize` is not a number `> 0`, `ttl` (here, in `set` or in
 * `getOrSet`) is not a number `> 0`, or (from `set`/`getOrSet`) `sizeOf` returns a negative, infinite or `NaN` size
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
 * sessions.getRemainingTTL('user'); // => 55_000
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
 * // Bounded by size: at most 10 characters of text, whatever the number of entries
 * const texts = createLRUCache<string, string>({ max: Infinity, maxSize: 10, sizeOf: function (text) { return text.length; } });
 * texts.set('a', 'hello').set('b', 'world');
 * texts.totalSize; // => 10
 * texts.set('c', 'hi'); // evicts 'a', the least recently used, to make room
 * [...texts.keys()]; // => ['c', 'b']
 * texts.set('d', 'far too long'); // larger than maxSize: not stored
 * texts.has('d'); // => false
 * @example
 * // Bounded memoization
 * import { memoize } from 'tinkit/functions';
 * const square = memoize(function (n: number): number { return n * n; }, { cache: createLRUCache({ max: 100 }) });
 * square(4); // => 16
 */
export function createLRUCache<K = unknown, V = unknown>(options: LRUCacheOptions<K, V>): LRUCache<K, V> {
	if (typeof options !== 'object' || options === null) throw new TypeError(`createLRUCache: \`options\` must be an object, got ${describe(options)}`);

	// Read as own properties: a polluted `Object.prototype` must not set a TTL, a clock or an eviction callback.
	const max = readOption(options, 'max') as number;
	const maxSize = readOption(options, 'maxSize', Infinity);
	const sizeOf = readOption(options, 'sizeOf');
	const defaultTTL = readOption(options, 'ttl', Infinity);
	const now = readOption(options, 'now', Date.now);
	const onEvict = readOption(options, 'onEvict');
	const updateAgeOnGet = readOption(options, 'updateAgeOnGet', false);
	// Checked: a truthy string such as 'false' (from a configuration file) must not turn sliding expiry on.
	if (typeof updateAgeOnGet !== 'boolean') throw new TypeError(`createLRUCache: \`updateAgeOnGet\` must be a boolean, got ${describe(updateAgeOnGet)}`);

	assertInteger('createLRUCache', 'max', max, 1, true);
	assertNumber('createLRUCache', 'maxSize', maxSize, maxSize > 0, 'a number > 0 or Infinity');
	if (sizeOf !== undefined) assertFunction('createLRUCache', 'sizeOf', sizeOf);
	assertTTL('createLRUCache', defaultTTL);
	assertFunction('createLRUCache', 'now', now);
	if (onEvict !== undefined) assertFunction('createLRUCache', 'onEvict', onEvict);

	const store = new Map<K, Entry<K, V>>();
	// Both ends of the recency list.
	let newest: Entry<K, V> | undefined;
	let oldest: Entry<K, V> | undefined;
	// The sum of the entries' sizes, kept as a rounded sum plus the rounding errors of the additions that made it (`total + residue`):
	// with sizes that are not integers (0.1, 0.2...), plain additions and subtractions drift, so that an emptied cache would total
	// 5.6e-17 and a value that fits on its own would be evicted on arrival.
	let total = 0;
	let residue = 0;
	// Whether any entry may ever expire (set by the first `set` with a finite TTL). Until then every `expiresAt` is `Infinity`, so the
	// clock (`Date.now` costs more than a `Map` lookup) is not read at all.
	let timed = false;

	/**
	 * Reads the clock, or returns `0` while no entry can expire (any finite time is then equivalent).
	 * @returns {number} The current time
	 */
	function clock(): number {
		return timed ? readNow() : 0;
	}

	/**
	 * Reads the clock and checks the result: a `NaN`, string or bigint time would make expiry instants that every check reads differently,
	 * and an infinite one entries that never expire (`Infinity + ttl`) or are expired from the start (`-Infinity + ttl`).
	 * @returns {number} The current time
	 * @throws {TypeError} when `now()` does not return a finite number
	 */
	function readNow(): number {
		const time = now();

		// `time - time` is `0` for finite numbers only (`NaN` for `NaN` and ±Infinity).
		if (typeof time !== 'number' || time - time !== 0)
			throw new TypeError(`createLRUCache: \`now()\` must return a finite number, got ${typeof time === 'number' ? time : describe(time)}`);

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
	 * @param {Array<[K, V, LRUEvictionReason]>} removed - The removed keys and values, and why
	 * @returns {void}
	 * @throws {AggregateError} when several `onEvict` calls threw (a single error is rethrown as is)
	 */
	function notifyAll(removed: Array<[K, V, LRUEvictionReason]>): void {
		const errors: unknown[] = [];

		for (const [key, value, reason] of removed) {
			try {
				notify(key, value, reason);
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
	 * Adds a size to the total, keeping the exact rounding error of the addition (Knuth's TwoSum) in `residue`.
	 * @param {number} size - The size to add (negative to subtract)
	 * @returns {void}
	 */
	function account(size: number): void {
		const sum = total + size;
		const added = sum - total;
		residue += total - (sum - added) + (size - added);
		total = sum;
	}

	/**
	 * Recomputes the total from the entries once it has gone past `Number.MAX_VALUE` (sizes near it: `Infinity - size` stays `Infinity`,
	 * and the residue becomes `NaN`), so that it comes back as soon as the sizes fit again; it stays `Infinity` until then. Called where
	 * the total is read, never on the way to a decision that does not depend on it.
	 * @returns {void}
	 */
	function recount(): void {
		if (total + residue < Infinity) return;
		total = residue = 0;
		for (let entry = oldest; entry !== undefined; entry = entry.newer) account(entry.size);
		if (!(total + residue < Infinity)) {
			total = Infinity;
			residue = 0;
		}
	}

	/**
	 * Removes an entry from the map and the list.
	 * @param {Entry<K, V>} entry - The entry
	 * @returns {void}
	 */
	function remove(entry: Entry<K, V>): void {
		store.delete(entry.key);
		unlink(entry);
		account(-entry.size);
		// An empty cache totals exactly 0, whatever rounding the residue itself went through.
		if (store.size === 0) total = residue = 0;
	}

	/**
	 * Whether the cache holds more entries than `max`, or more than `maxSize` in total.
	 * @returns {boolean} `true` when least-recently-used entries must go
	 */
	function overflows(): boolean {
		if (store.size > max) return true;
		if (total + residue <= maxSize) return false;
		// Over `maxSize`, or beyond `Number.MAX_VALUE` (`NaN` included): recounted first, only then.
		recount();
		return total + residue > maxSize;
	}

	/**
	 * Evicts least-recently-used entries until the cache fits `max` and `maxSize` (never the most recently used one, which fits on its
	 * own), then reports them after `removed` (a single eviction, the usual case, is reported without allocating).
	 * @param {number} time - The current time, to tell expired entries apart
	 * @param {Array<[K, V, LRUEvictionReason]> | undefined} removed - Removals to report first, if any
	 * @returns {void}
	 */
	function fit(time: number, removed: Array<[K, V, LRUEvictionReason]> | undefined): void {
		while (overflows()) {
			const evicted = oldest as Entry<K, V>;
			const reason = time >= evicted.expiresAt ? 'expired' : 'capacity';

			remove(evicted);
			if (removed === undefined && !overflows()) return notify(evicted.key, evicted.value, reason);
			(removed ??= []).push([evicted.key, evicted.value, reason]);
		}
		if (removed !== undefined) notifyAll(removed);
	}

	/**
	 * Measures a value with `sizeOf` (`1` without it).
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {K} key - The key
	 * @param {V} value - The value
	 * @returns {number} Its size
	 * @throws {TypeError} when `sizeOf` does not return a number
	 * @throws {RangeError} when it returns a negative, infinite or `NaN` size
	 */
	function measure(caller: string, key: K, value: V): number {
		if (sizeOf === undefined) return 1;
		const size: unknown = sizeOf(value, key);
		if (!(typeof size === 'number' && size >= 0 && size < Infinity)) assertNumber(caller, 'sizeOf()', size, false, 'a finite number >= 0');
		return size;
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
		const ttl = (setOptions == null ? undefined : readOption(setOptions, 'ttl')) ?? defaultTTL;
		if (ttl !== defaultTTL) assertTTL(caller, ttl);
		return ttl;
	}

	const cache: LRUCache<K, V> = build(
		lruPrototype(),
		{
			get(key: K): V | undefined {
				return touch(key)?.value;
			},
			getOrSet(key: K, factory: (key: K) => V, setOptions?: LRUCacheSetOptions): V {
				assertFunction('LRUCache.getOrSet', 'factory', factory);
				// Validated before `factory` runs, so that its result is never computed for nothing.
				const ttl = readTTL('LRUCache.getOrSet', setOptions);

				const entry = touch(key);
				if (entry !== undefined) return entry.value;

				const value = factory(key);
				// With the TTL read above: the options are read once (a getter could return another TTL the second time).
				cache.set(key, value, setOptions == null ? setOptions : { ttl });

				return value;
			},
			peek(key: K): V | undefined {
				return lookup(key)?.value;
			},
			has(key: K): boolean {
				return lookup(key) !== undefined;
			},
			getRemainingTTL(key: K): number | undefined {
				const entry = store.get(key);
				if (entry === undefined) return undefined;
				if (entry.expiresAt === Infinity) return Infinity;
				// The clock is read once, so that a live entry never reports a remaining time <= 0.
				const remaining = entry.expiresAt - readNow();
				return remaining > 0 ? remaining : expire(entry);
			},
			set(key: K, value: V, setOptions?: LRUCacheSetOptions): LRUCache<K, V> {
				const ttl = readTTL('LRUCache.set', setOptions);
				// Measured before anything changes: when `sizeOf` throws, the cache is left as it was.
				const size = measure('LRUCache.set', key, value);

				if (ttl !== Infinity) timed = true;

				const time = clock();
				const entry = store.get(key);

				if (size > maxSize) {
					// It would evict every other entry and still not fit: it is not stored, and neither is the value it replaces.
					if (entry !== undefined) {
						remove(entry);
						notify(entry.key, entry.value, time >= entry.expiresAt ? 'expired' : 'oversized');
					}
					return cache;
				}

				if (entry !== undefined) {
					const previousValue = entry.value;
					const expired = time >= entry.expiresAt;

					entry.value = value;
					// Two additions: `size - entry.size` would be rounded before reaching the total.
					account(size);
					account(-entry.size);
					entry.size = size;
					entry.ttl = ttl;
					entry.expiresAt = time + ttl;
					unlink(entry);
					pushNewest(entry);

					// Storing the very same value again removes nothing, even over an expired entry: it must not be disposed while stored.
					if (Object.is(previousValue, value)) fit(time, undefined);
					else if (overflows()) fit(time, [[entry.key, previousValue, expired ? 'expired' : 'replaced']]);
					else notify(entry.key, previousValue, expired ? 'expired' : 'replaced');

					return cache;
				}

				// `Map` normalises -0 to +0; keep the key it actually stores, so iteration and eviction report the same key as before.
				const added: Entry<K, V> = {
					key: Object.is(key, -0) ? (0 as K) : key,
					value,
					size,
					ttl,
					expiresAt: time + ttl,
					newer: undefined,
					older: undefined
				};

				store.set(key, added);
				pushNewest(added);
				account(size);
				fit(time, undefined);

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
				const removed: Array<[K, V, LRUEvictionReason]> = [];

				for (let entry = oldest; entry !== undefined; entry = entry.newer) removed.push([entry.key, entry.value, time >= entry.expiresAt ? 'expired' : 'cleared']);
				store.clear();
				newest = undefined;
				oldest = undefined;
				total = residue = 0;

				notifyAll(removed);
			},
			prune(): number {
				const time = clock();
				const expired: Array<Entry<K, V>> = [];

				for (let entry = oldest; entry !== undefined; entry = entry.newer) {
					if (time >= entry.expiresAt) expired.push(entry);
				}
				for (const entry of expired) remove(entry);
				notifyAll(
					expired.map(function (entry): [K, V, LRUEvictionReason] {
						return [entry.key, entry.value, 'expired'];
					})
				);

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
			}
		},
		function (): number {
			return store.size;
		},
		function (): IterableIterator<[K, V]> {
			return live(pair);
		}
	);
	(cache as unknown as Record<symbol, unknown>)[TOTAL_SIZE] = function (): number {
		recount();
		return total + residue;
	};

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

	const queue: PriorityQueue<T> = build(
		sizedPrototype(),
		{
			push(value: T): number {
				siftUp(values.length, value, inserted++);

				return values.length;
			},
			pop(): T | undefined {
				return values.length === 0 ? undefined : removeAt(0);
			},
			peek(): T | undefined {
				// Checked: reading index 0 of an empty array would reach a polluted `Array.prototype`.
				return values.length === 0 ? undefined : values[0];
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
			}
		},
		function (): number {
			return values.length;
		},
		function (): IterableIterator<T> {
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
	);

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

	const deque: Deque<T> = build(
		sizedPrototype(),
		{
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
			// An empty deque's slots are all cleared, and every masked index is inside the filled ring: no check needed.
			peekFront(): T | undefined {
				return ring[head];
			},
			peekBack(): T | undefined {
				return ring[(head + length - 1) & (ring.length - 1)];
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
			}
		},
		function (): number {
			return length;
		},
		function (): IterableIterator<T> {
			const snapshot: T[] = [];
			for (let i = 0; i < length; i++) snapshot.push(ring[(head + i) & (ring.length - 1)] as T);
			return snapshot.values();
		}
	);

	if (values != null) for (const value of values) deque.pushBack(value);

	return deque;
}

// ---------------------------------------------------------------------------------------------------------------------
// createRingBuffer
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link createRingBuffer}.
 * @template T - The value type
 */
export interface RingBufferOptions<T> {
	/**
	 * Called with each value that a `push` to a full buffer overwrites, after the buffer holds the new value (so the callback may use it).
	 * Not called by `shift` or `clear`. An exception it throws propagates to the caller of `push`; the buffer is already consistent.
	 */
	onEvict?: (value: T) => void;
}

/**
 * A fixed-capacity circular buffer, as returned by {@link createRingBuffer}.
 * @template T - The value type
 */
export interface RingBuffer<T> extends Iterable<T> {
	/** Number of values. */
	readonly size: number;
	/** The maximum number of values. */
	readonly capacity: number;
	/** Whether `size === capacity`, i.e. the next `push` overwrites the oldest value. */
	readonly full: boolean;
	/** Adds a value as the newest one, overwriting (and reporting to `onEvict`) the oldest value when the buffer is full; returns the new size. */
	push(value: T): number;
	/** Removes and returns the oldest value; `undefined` when empty. */
	shift(): T | undefined;
	/** Returns the oldest value without removing it; `undefined` when empty. */
	peekFirst(): T | undefined;
	/** Returns the newest value without removing it; `undefined` when empty. */
	peekLast(): T | undefined;
	/** Returns the value at `index` from the oldest (`0`; a negative index counts from the newest: `-1` is the newest); `undefined` when out of range. */
	at(index: number): T | undefined;
	/** The values from oldest to newest, as a new array. */
	toArray(): T[];
	/** Removes every value (without calling `onEvict`) and releases the storage. */
	clear(): void;
	/** The values from oldest to newest (a snapshot taken when called). */
	[Symbol.iterator](): IterableIterator<T>;
}

/** Largest array length, and so the largest capacity of a ring buffer. */
const MAX_LENGTH = 2 ** 32 - 1;

/**
 * Key of each ring buffer's function telling whether it is full, called by the shared `full` getter (which therefore never depends on
 * the writable `capacity` property).
 */
const FULL = Symbol();

/**
 * The `full` getter of every ring buffer (shared, like {@link getSize}).
 * @returns {boolean} Whether the buffer it is read on is full
 */
function getFull(this: { [FULL](): boolean }): boolean {
	return this[FULL]();
}

/** The prototype of ring buffers, created on first use. */
let ringBuffer: object | undefined;

/**
 * Returns the prototype of ring buffers, creating it on first use (a call at the top level of the module would run on import, and keep
 * bundlers from dropping the module when nothing of it is used).
 * @returns {object} The prototype
 */
function ringBufferPrototype(): object {
	return (ringBuffer ??= withGetters({ size: getSize, full: getFull }));
}

/**
 * Creates a ring buffer: a circular buffer of at most `capacity` values where pushing to a full buffer overwrites the oldest value, so it
 * always holds the most recent values (the last N log lines, samples, frames or events). `push`, `shift`, `at` and the peeks are O(1)
 * and never allocate once the buffer has filled up: its storage grows with the first `capacity` pushes (an empty buffer of capacity
 * 10⁶ costs nothing) and is then reused in place, never resized.
 *
 * Compared with {@link createDeque} with a `capacity` (which also drops the value at the other end when full): a ring buffer is
 * single-ended (push newest, shift oldest), reports overwritten values to `onEvict`, has `full`, and never grows or shrinks its storage
 * once full. Use a deque for an unbounded queue or to add and remove at both ends.
 * - A shifted or cleared value is released at once (its slot is cleared), so the buffer never keeps a reference to a value it no
 *   longer holds.
 * - Iteration goes from oldest to newest over a snapshot: changing the buffer while iterating is safe and does not affect the loop.
 * @template T - The value type
 * @param {number} capacity - The maximum number of values (an integer between 1 and 2³² - 1)
 * @param {RingBufferOptions<T>} [options={}] - `onEvict`, called with each overwritten value
 * @returns {RingBuffer<T>} A new, empty buffer
 * @throws {TypeError} when `capacity` is not a number, or `onEvict` is provided but not a function
 * @throws {RangeError} when `capacity` is not an integer between 1 and 2³² - 1 (`Infinity` included: use a deque), or (from `at`) the
 * index is not an integer
 * @example
 * const recent = createRingBuffer<number>(3);
 * for (const sample of [1, 2, 3, 4, 5]) recent.push(sample);
 * recent.toArray(); // => [3, 4, 5]
 * recent.full; // => true
 * recent.peekFirst(); // => 3
 * recent.at(-1); // => 5
 * recent.shift(); // => 3
 * [...recent]; // => [4, 5]
 * @example
 * // Dispose of what falls out of the window
 * const dropped: string[] = [];
 * const lines = createRingBuffer<string>(2, { onEvict: function (line) { dropped.push(line); } });
 * lines.push('a');
 * lines.push('b');
 * lines.push('c'); // => 2
 * dropped; // => ['a']
 * createRingBuffer(0); // throws RangeError
 */
export function createRingBuffer<T>(capacity: number, options: RingBufferOptions<T> = {}): RingBuffer<T> {
	if (!(Number.isInteger(capacity) && capacity >= 1 && capacity <= MAX_LENGTH)) {
		assertNumber('createRingBuffer', 'capacity', capacity, false, `an integer between 1 and ${MAX_LENGTH}`);
	}
	const onEvict = readOption(options, 'onEvict');
	if (onEvict !== undefined) assertFunction('createRingBuffer', 'options.onEvict', onEvict);

	// The storage grows by `push` until it holds `capacity` slots (it stays packed: no hole, so no read reaches `Array.prototype`), then
	// wraps. The next free slot is `(head + length) % capacity`, which equals `ring.length` exactly while the storage is still growing.
	let ring: Array<T | undefined> = [];
	let head = 0;
	let length = 0;

	/**
	 * The storage index of the value at `offset` from the oldest.
	 * @param {number} offset - An offset in `[0, length]`
	 * @returns {number} The storage index
	 */
	function slot(offset: number): number {
		const index = head + offset;
		return index >= capacity ? index - capacity : index;
	}

	const buffer: RingBuffer<T> = build(
		ringBufferPrototype(),
		{
			capacity,
			push(value: T): number {
				if (length === capacity) {
					// Full: the oldest value's slot becomes the newest one's.
					const evicted = ring[head] as T;
					ring[head] = value;
					head = slot(1);
					if (onEvict) onEvict(evicted);
					return length;
				}
				const tail = slot(length);
				if (tail === ring.length) ring.push(value);
				else ring[tail] = value;
				return ++length;
			},
			shift(): T | undefined {
				if (length === 0) return undefined;
				const value = ring[head];
				ring[head] = undefined;
				head = slot(1);
				length--;
				return value;
			},
			peekFirst(): T | undefined {
				return length === 0 ? undefined : ring[head];
			},
			peekLast(): T | undefined {
				return length === 0 ? undefined : ring[slot(length - 1)];
			},
			at(index: number): T | undefined {
				if (!Number.isInteger(index)) assertNumber('RingBuffer.at', 'index', index, false, 'an integer');
				const offset = index < 0 ? index + length : index;
				return offset >= 0 && offset < length ? ring[slot(offset)] : undefined;
			},
			toArray(): T[] {
				const values: T[] = [];
				for (let i = 0; i < length; i++) values.push(ring[slot(i)] as T);
				return values;
			},
			clear(): void {
				ring = [];
				head = 0;
				length = 0;
			}
		},
		function (): number {
			return length;
		},
		function (): IterableIterator<T> {
			return buffer.toArray().values();
		}
	);
	(buffer as unknown as Record<symbol, unknown>)[FULL] = function (): boolean {
		return length === capacity;
	};

	return buffer;
}

// ---------------------------------------------------------------------------------------------------------------------
// createDefaultMap
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A `Map` whose `get` creates missing values, as returned by {@link createDefaultMap}.
 * @template K - The key type
 * @template V - The value type
 */
export interface DefaultMap<K, V> extends Iterable<[K, V]> {
	/** Number of entries. */
	readonly size: number;
	/** Returns the value stored under `key`; when there is none, stores `factory(key)` and returns it. */
	get(key: K): V;
	/** Returns the value stored under `key`, or `undefined`, without creating it. */
	peek(key: K): V | undefined;
	/** Whether a value is stored under `key` (never creates one). */
	has(key: K): boolean;
	/** Stores `value` under `key` and returns the map. */
	set(key: K, value: V): DefaultMap<K, V>;
	/** Removes `key`; returns whether it was present. */
	delete(key: K): boolean;
	/** Removes every entry. */
	clear(): void;
	/** The keys in insertion order (a live iterator, as `Map`'s). */
	keys(): IterableIterator<K>;
	/** The values in insertion order (a live iterator, as `Map`'s). */
	values(): IterableIterator<V>;
	/** The `[key, value]` pairs in insertion order (a live iterator, as `Map`'s). */
	entries(): IterableIterator<[K, V]>;
	/** Same as `entries()`. */
	[Symbol.iterator](): IterableIterator<[K, V]>;
}

/**
 * Checks the initial entries of a structure: an iterable, or `null`/`undefined` for none.
 * @template E - The entry type
 * @param {string} caller - Name of the public function, used in the error message
 * @param {Iterable<E> | null | undefined} entries - The entries
 * @returns {Iterable<E> | undefined} The entries (`undefined` for none)
 * @throws {TypeError} when `entries` is neither iterable nor `null`/`undefined`
 */
function readEntries<E>(caller: string, entries: Iterable<E> | null | undefined): Iterable<E> | undefined {
	if (entries == null) return undefined;
	if (typeof (entries as Partial<Iterable<E>>)[Symbol.iterator] !== 'function') throw new TypeError(`${caller}: \`entries\` must be an iterable, got ${describe(entries)}`);
	return entries;
}

/**
 * Creates a `Map` whose `get` never misses: a missing key gets the value `factory(key)`, which is stored and returned (Python's
 * `defaultdict`, or `Map.prototype.getOrInsertComputed` on every `get`). It turns grouping, counting and memo tables into one-liners
 * without `if (!map.has(key)) map.set(key, [])`. `peek` and `has` look without creating.
 *
 * - Keys compare with SameValueZero, as in a `Map`; iteration is in insertion order, with `Map`'s live iterators.
 * - `factory` is only called on a miss, with the key as the map stores it (`-0` as `0`), and a stored `undefined` is a hit. When it
 *   throws, nothing is stored. Its result replaces anything `factory` itself stored under `key`.
 * @template K - The key type
 * @template V - The value type
 * @param {(key: K) => V} factory - Creates the value of a missing key
 * @param {Iterable<readonly [K, V]> | null} [entries] - Initial `[key, value]` pairs
 * @returns {DefaultMap<K, V>} A new map
 * @throws {TypeError} when `factory` is not a function, or `entries` is neither iterable nor `null`/`undefined`
 * @example
 * const byLength = createDefaultMap(function (): string[] { return []; });
 * for (const word of ['a', 'bb', 'cc', 'd']) byLength.get(word.length).push(word);
 * byLength.get(2); // => ['bb', 'cc']
 * byLength.peek(3); // => undefined
 * byLength.size; // => 2
 * @example
 * // Counting
 * const counts = createDefaultMap<string, number>(function () { return 0; });
 * for (const letter of 'banana') counts.set(letter, counts.get(letter) + 1);
 * [...counts]; // => [['b', 1], ['a', 3], ['n', 2]]
 */
export function createDefaultMap<K, V>(factory: (key: K) => V, entries?: Iterable<readonly [K, V]> | null): DefaultMap<K, V> {
	assertFunction('createDefaultMap', 'factory', factory);
	const map = new Map<K, V>(readEntries('createDefaultMap', entries));

	const defaults: DefaultMap<K, V> = build(
		sizedPrototype(),
		{
			get(key: K): V {
				const stored = map.get(key);
				if (stored !== undefined || map.has(key)) return stored as V;
				// The key as the map stores it (`-0` as `0`), as `getOrInsertComputed` passes it.
				const value = factory(key === 0 ? (0 as K) : key);
				map.set(key, value);
				return value;
			},
			peek(key: K): V | undefined {
				return map.get(key);
			},
			has(key: K): boolean {
				return map.has(key);
			},
			set(key: K, value: V): DefaultMap<K, V> {
				map.set(key, value);
				return defaults;
			},
			delete(key: K): boolean {
				return map.delete(key);
			},
			clear(): void {
				map.clear();
			},
			keys(): IterableIterator<K> {
				return map.keys();
			},
			values(): IterableIterator<V> {
				return map.values();
			},
			entries(): IterableIterator<[K, V]> {
				return map.entries();
			}
		},
		function (): number {
			return map.size;
		},
		function (): IterableIterator<[K, V]> {
			return map.entries();
		}
	);

	return defaults;
}

// ---------------------------------------------------------------------------------------------------------------------
// createBiMap
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A bidirectional one-to-one map, as returned by {@link createBiMap}.
 * @template K - The key type
 * @template V - The value type
 */
export interface BiMap<K, V> extends Iterable<[K, V]> {
	/** Number of pairs. */
	readonly size: number;
	/** The same pairs seen from the other side (values as keys), backed by the same storage: changes through either view show in both. */
	readonly inverse: BiMap<V, K>;
	/** Returns the value paired with `key`, or `undefined`. */
	get(key: K): V | undefined;
	/** Returns the key paired with `value`, or `undefined`. */
	getKey(value: V): K | undefined;
	/** Whether `key` is paired. */
	has(key: K): boolean;
	/** Whether `value` is paired. */
	hasValue(value: V): boolean;
	/** Pairs `key` with `value`, first removing the pairs either of them was part of; returns the map. */
	set(key: K, value: V): BiMap<K, V>;
	/** Removes the pair of `key`; returns whether there was one. */
	delete(key: K): boolean;
	/** Removes the pair of `value`; returns whether there was one. */
	deleteValue(value: V): boolean;
	/** Removes every pair. */
	clear(): void;
	/** The keys (a live iterator, in the order of a `Map` of keys to values). */
	keys(): IterableIterator<K>;
	/** The values, in the order of `keys()` (a live iterator). */
	values(): IterableIterator<V>;
	/** The `[key, value]` pairs, in the order of `keys()` (a live iterator). */
	entries(): IterableIterator<[K, V]>;
	/** Same as `entries()`. */
	[Symbol.iterator](): IterableIterator<[K, V]>;
}

/**
 * Key of each bimap view's other side, returned by the shared `inverse` getter (a getter rather than an own property, so that spreading
 * or serializing a map does not walk into the cycle).
 */
const INVERSE = Symbol();

/**
 * The `inverse` getter of every bimap view.
 * @returns {BiMap<unknown, unknown>} The other side of the view it is read on
 */
function getInverse(this: { [INVERSE]: BiMap<unknown, unknown> }): BiMap<unknown, unknown> {
	return this[INVERSE];
}

/** The prototype of bimap views, created on first use. */
let biMap: object | undefined;

/**
 * Returns the prototype of bimap views, creating it on first use (a call at the top level of the module would run on import, and keep
 * bundlers from dropping the module when nothing of it is used).
 * @returns {object} The prototype
 */
function biMapPrototype(): object {
	return (biMap ??= withGetters({ size: getSize, inverse: getInverse }));
}

/**
 * Creates one side of a bidirectional map over two `Map`s kept as exact mirrors.
 * @template K - The key type of this side
 * @template V - The value type of this side
 * @param {Map<K, V>} forward - Keys to values
 * @param {Map<V, K>} backward - Values to keys
 * @returns {BiMap<K, V>} The view (its inverse view is set by the caller)
 */
function biMapView<K, V>(forward: Map<K, V>, backward: Map<V, K>): BiMap<K, V> {
	const view: BiMap<K, V> = build(
		biMapPrototype(),
		{
			get(key: K): V | undefined {
				return forward.get(key);
			},
			getKey(value: V): K | undefined {
				return backward.get(value);
			},
			has(key: K): boolean {
				return forward.has(key);
			},
			hasValue(value: V): boolean {
				return backward.has(value);
			},
			set(key: K, value: V): BiMap<K, V> {
				// Both sides are keys of one of the maps, so both are stored as those maps store keys (`-0` as `0`): each side then reads the
				// same in both directions.
				const left = Object.is(key, -0) ? (0 as K) : key;
				const right = Object.is(value, -0) ? (0 as V) : value;

				if (forward.has(left)) {
					const previous = forward.get(left) as V;
					// The pair is already there (SameValueZero, like the maps).
					if (previous === right || (previous !== previous && right !== right)) return view;
					backward.delete(previous);
				}
				if (backward.has(right)) forward.delete(backward.get(right) as K);
				forward.set(left, right);
				backward.set(right, left);
				return view;
			},
			delete(key: K): boolean {
				if (!forward.has(key)) return false;
				backward.delete(forward.get(key) as V);
				return forward.delete(key);
			},
			deleteValue(value: V): boolean {
				if (!backward.has(value)) return false;
				forward.delete(backward.get(value) as K);
				return backward.delete(value);
			},
			clear(): void {
				forward.clear();
				backward.clear();
			},
			keys(): IterableIterator<K> {
				return forward.keys();
			},
			values(): IterableIterator<V> {
				return forward.values();
			},
			entries(): IterableIterator<[K, V]> {
				return forward.entries();
			}
		},
		function (): number {
			return forward.size;
		},
		function (): IterableIterator<[K, V]> {
			return forward.entries();
		}
	);

	return view;
}

/**
 * Creates a bidirectional map: a one-to-one map that looks up values by key (`get`) and keys by value (`getKey`) in O(1), backed by two
 * `Map`s kept as exact mirrors. Every value belongs to one key at most, so `set(key, value)` first removes the pairs `key` and `value`
 * were part of (Guava's `forcePut`): the map can never hold a stale or duplicated pair. `inverse` is the same map seen from the other
 * side, with no copy.
 *
 * - Keys and values compare with SameValueZero (both are `Map` keys); a `-0` key or value is stored as `0`.
 * - Order: `keys()`, `values()` and `entries()` follow the order a `Map` of keys to values would have after the same changes (changing
 *   the value of a key keeps the key's place); `inverse` follows the order of a `Map` of values to keys (changing the key of a value
 *   keeps the value's place). Iterators are live, as `Map`'s.
 * @template K - The key type
 * @template V - The value type
 * @param {Iterable<readonly [K, V]> | null} [entries] - Initial `[key, value]` pairs, set in order (a later pair replaces the earlier
 * pairs that share its key or its value)
 * @returns {BiMap<K, V>} A new map
 * @throws {TypeError} when `entries` is neither iterable nor `null`/`undefined`
 * @example
 * const codes = createBiMap([['en', 'English'], ['fr', 'French']]);
 * codes.get('fr'); // => 'French'
 * codes.getKey('English'); // => 'en'
 * codes.inverse.get('French'); // => 'fr'
 * codes.set('gb', 'English'); // 'en' loses its value, so its pair is removed
 * codes.has('en'); // => false
 * [...codes]; // => [['fr', 'French'], ['gb', 'English']]
 * codes.inverse.inverse === codes; // => true
 */
export function createBiMap<K, V>(entries?: Iterable<readonly [K, V]> | null): BiMap<K, V> {
	const pairs = readEntries('createBiMap', entries);
	const forward = new Map<K, V>();
	const backward = new Map<V, K>();
	const map = biMapView(forward, backward);
	const inverse = biMapView(backward, forward);

	(map as unknown as Record<symbol, unknown>)[INVERSE] = inverse;
	(inverse as unknown as Record<symbol, unknown>)[INVERSE] = map;
	if (pairs !== undefined) for (const [key, value] of pairs) map.set(key, value);

	return map;
}

// ---------------------------------------------------------------------------------------------------------------------
// createMultiMap
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link createMultiMap}.
 */
export interface MultiMapOptions {
	/**
	 * When `true`, a key holds each value at most once (a set of values per key, SameValueZero): adding a value already there does
	 * nothing. When `false`, a key holds a list, duplicates included.
	 * @default false
	 */
	unique?: boolean;
}

/**
 * A map from keys to several values, as returned by {@link createMultiMap}.
 * @template K - The key type
 * @template V - The value type
 */
export interface MultiMap<K, V> extends Iterable<[K, V]> {
	/** Total number of values, over every key. */
	readonly size: number;
	/** Number of keys that hold at least one value. */
	readonly keyCount: number;
	/** Adds `value` under `key`; returns whether it was added (`false` only when `unique` and the key already holds it). */
	add(key: K, value: V): boolean;
	/** The values of `key` in insertion order, as a new array (empty when the key holds none). */
	get(key: K): V[];
	/** Number of values `key` holds, in O(1). */
	count(key: K): number;
	/** Whether `key` holds at least one value. */
	has(key: K): boolean;
	/** Whether `key` holds `value` (SameValueZero). */
	has(key: K, value: V): boolean;
	/** Removes `key` and all its values; returns whether it held any. */
	delete(key: K): boolean;
	/** Removes one occurrence of `value` (the oldest) from `key`, and the key once it holds nothing; returns whether one was found. */
	delete(key: K, value: V): boolean;
	/** Removes everything. */
	clear(): void;
	/** The keys, in the order they were first added (a snapshot taken when called). */
	keys(): IterableIterator<K>;
	/** Every value, key by key in the order of `keys()` (a snapshot taken when called). */
	values(): IterableIterator<V>;
	/** Every `[key, value]` pair, key by key in the order of `keys()` (a snapshot taken when called). */
	entries(): IterableIterator<[K, V]>;
	/** Same as `entries()`. */
	[Symbol.iterator](): IterableIterator<[K, V]>;
}

/**
 * Key of each multimap's (non-enumerable) function returning its number of keys, called by the shared `keyCount` getter.
 */
const KEY_COUNT = Symbol();

/**
 * The `keyCount` getter of every multimap (shared, like {@link getSize}).
 * @returns {number} The number of keys of the multimap it is read on
 */
function getKeyCount(this: { [KEY_COUNT](): number }): number {
	return this[KEY_COUNT]();
}

/** The prototype of multimaps, created on first use. */
let multiMap: object | undefined;

/**
 * Returns the prototype of multimaps, creating it on first use (a call at the top level of the module would run on import, and keep
 * bundlers from dropping the module when nothing of it is used).
 * @returns {object} The prototype
 */
function multiMapPrototype(): object {
	return (multiMap ??= withGetters({ size: getSize, keyCount: getKeyCount }));
}

/**
 * Finds the first occurrence of `value` in a list, with SameValueZero (so `NaN` is found, unlike with `indexOf`).
 * @template T - The element type
 * @param {T[]} list - The list
 * @param {T} value - The value to find
 * @returns {number} Its index, or `-1`
 */
function indexOfValue<T>(list: T[], value: T): number {
	if (value === value) return list.indexOf(value);
	for (let i = 0; i < list.length; i++) if (list[i] !== list[i]) return i;
	return -1;
}

/**
 * Builds a `[key, value]` pair.
 * @template K - The key type
 * @template V - The value type
 * @param {K} key - The key
 * @param {V} value - The value
 * @returns {[K, V]} The pair
 */
function pairOf<K, V>(key: K, value: V): [K, V] {
	return [key, value];
}

/**
 * Creates a multimap: a map from each key to several values, a list per key (or a set, with `unique: true`). Missing keys read as empty:
 * `get` returns `[]`, so there is no `map.get(key) ?? []` dance, and a key disappears as soon as its last value is removed, so `has`,
 * `keyCount` and iteration never see empty groups. `add`, `count` and `has(key)` are O(1); `has(key, value)` and `delete(key, value)` are
 * O(1) with `unique` and linear in the key's values otherwise. `size` counts values, `keyCount` keys.
 *
 * - Keys and values compare with SameValueZero (keys are `Map` keys; with `unique`, values are `Set` values, which store `-0` as `0`).
 * - `get` returns a new array (O(values of the key)): changing the multimap later never changes an array it returned, and changing the
 *   array never changes the multimap.
 * - Iteration (`keys`, `values`, `entries`) is over a snapshot: changing the multimap while iterating is safe and does not affect the loop.
 * @template K - The key type
 * @template V - The value type
 * @param {Iterable<readonly [K, V]> | null} [entries] - Initial `[key, value]` pairs, added in order
 * @param {MultiMapOptions} [options={}] - `unique` (default `false`)
 * @returns {MultiMap<K, V>} A new multimap
 * @throws {TypeError} when `entries` is neither iterable nor `null`/`undefined`, or `unique` is not a boolean
 * @example
 * const tags = createMultiMap<string, string>();
 * tags.add('post-1', 'js');
 * tags.add('post-1', 'ts');
 * tags.add('post-2', 'js');
 * tags.get('post-1'); // => ['js', 'ts']
 * tags.get('post-3'); // => []
 * [tags.size, tags.keyCount]; // => [3, 2]
 * tags.delete('post-1', 'js'); // => true
 * [...tags]; // => [['post-1', 'ts'], ['post-2', 'js']]
 * @example
 * // A set of values per key
 * const followers = createMultiMap([['ada', 'bob'], ['ada', 'bob'], ['ada', 'eve']], { unique: true });
 * followers.get('ada'); // => ['bob', 'eve']
 * followers.add('ada', 'eve'); // => false
 * followers.has('ada', 'bob'); // => true
 */
export function createMultiMap<K, V>(entries?: Iterable<readonly [K, V]> | null, options: MultiMapOptions = {}): MultiMap<K, V> {
	const pairs = readEntries('createMultiMap', entries);
	const unique = readOption(options, 'unique', false);
	if (typeof unique !== 'boolean') throw new TypeError(`createMultiMap: \`options.unique\` must be a boolean, got ${describe(unique)}`);
	// A list of values per key, or a set with `unique`. Keys without values are never stored.
	const groups = new Map<K, V[] | Set<V>>();
	let total = 0;

	/**
	 * Snapshots something of every value of every key, key by key.
	 * @template T - The snapshot element type
	 * @param {(key: K, value: V) => T} pick - Extracts what to collect from a pair
	 * @returns {IterableIterator<T>} An iterator over the snapshot
	 */
	function collect<T>(pick: (key: K, value: V) => T): IterableIterator<T> {
		const result: T[] = [];
		for (const [key, group] of groups) for (const value of group) result.push(pick(key, value));
		return result.values();
	}

	/**
	 * Number of values in a group.
	 * @param {V[] | Set<V>} group - A group
	 * @returns {number} Its size
	 */
	function countOf(group: V[] | Set<V>): number {
		return unique ? (group as Set<V>).size : (group as V[]).length;
	}

	const multimap: MultiMap<K, V> = build(
		multiMapPrototype(),
		{
			add(key: K, value: V): boolean {
				const group = groups.get(key);
				if (group === undefined) groups.set(key, unique ? new Set([value]) : [value]);
				else if (!unique) (group as V[]).push(value);
				else if ((group as Set<V>).has(value)) return false;
				else (group as Set<V>).add(value);
				total++;
				return true;
			},
			get(key: K): V[] {
				const group = groups.get(key);
				return group === undefined ? [] : Array.from(group);
			},
			count(key: K): number {
				const group = groups.get(key);
				return group === undefined ? 0 : countOf(group);
			},
			has(key: K, ...value: [] | [V]): boolean {
				const group = groups.get(key);
				if (group === undefined) return false;
				if (value.length === 0) return true;
				return unique ? (group as Set<V>).has(value[0]) : indexOfValue(group as V[], value[0]) >= 0;
			},
			delete(key: K, ...value: [] | [V]): boolean {
				const group = groups.get(key);
				if (group === undefined) return false;
				if (value.length === 0) {
					total -= countOf(group);
					return groups.delete(key);
				}
				if (unique) {
					if (!(group as Set<V>).delete(value[0])) return false;
				} else {
					const index = indexOfValue(group as V[], value[0]);
					if (index < 0) return false;
					(group as V[]).splice(index, 1);
				}
				total--;
				if (countOf(group) === 0) groups.delete(key);
				return true;
			},
			clear(): void {
				groups.clear();
				total = 0;
			},
			keys(): IterableIterator<K> {
				return Array.from(groups.keys()).values();
			},
			values(): IterableIterator<V> {
				return collect(function (_, value): V {
					return value;
				});
			},
			entries(): IterableIterator<[K, V]> {
				return collect<[K, V]>(pairOf);
			}
		},
		function (): number {
			return total;
		},
		function (): IterableIterator<[K, V]> {
			return collect<[K, V]>(pairOf);
		}
	);
	(multimap as unknown as Record<symbol, unknown>)[KEY_COUNT] = function (): number {
		return groups.size;
	};

	if (pairs !== undefined) for (const [key, value] of pairs) multimap.add(key, value);

	return multimap;
}

// ---------------------------------------------------------------------------------------------------------------------
// createTrie
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link Trie.keysWithPrefix} and {@link Trie.entriesWithPrefix}.
 */
export interface TrieQueryOptions {
	/**
	 * The maximum number of results (an integer `>= 0`, or `Infinity`): the first ones in key order. The search stops as soon as it has
	 * them, so a small limit is fast even when many keys match.
	 * @default Infinity
	 */
	limit?: number;
}

/**
 * A map from strings to values with prefix queries, as returned by {@link createTrie}. Keys are ordered by UTF-16 code units, as
 * `Array.prototype.sort()` and `<` order strings.
 * @template V - The value type
 */
export interface Trie<V> extends Iterable<[string, V]> {
	/** Number of keys. */
	readonly size: number;
	/** Returns the value stored under `key`, or `undefined`. */
	get(key: string): V | undefined;
	/** Whether `key` is stored (a stored `undefined` included). */
	has(key: string): boolean;
	/** Stores `value` under `key` and returns the trie. */
	set(key: string, value: V): Trie<V>;
	/** Removes `key`; returns whether it was stored. */
	delete(key: string): boolean;
	/** Removes every key. */
	clear(): void;
	/** Whether at least one stored key starts with `prefix` (with `''`: whether the trie holds any key). */
	hasPrefix(prefix: string): boolean;
	/** The stored keys that start with `prefix` (`prefix` itself included), in key order. */
	keysWithPrefix(prefix: string, options?: TrieQueryOptions): string[];
	/** The `[key, value]` pairs whose key starts with `prefix` (`prefix` itself included), in key order. */
	entriesWithPrefix(prefix: string, options?: TrieQueryOptions): Array<[string, V]>;
	/** The longest stored key that is a prefix of `text` (`text` itself included; possibly `''`); `undefined` when there is none. */
	longestPrefixOf(text: string): string | undefined;
	/** The keys in key order (a snapshot taken when called). */
	keys(): IterableIterator<string>;
	/** The values, in key order (a snapshot taken when called). */
	values(): IterableIterator<V>;
	/** The `[key, value]` pairs in key order (a snapshot taken when called). */
	entries(): IterableIterator<[string, V]>;
	/** Same as `entries()`. */
	[Symbol.iterator](): IterableIterator<[string, V]>;
}

/**
 * A node of a radix tree: the label of the edge that leads to it, the value of the key that ends there ({@link NO_VALUE} when none
 * does), its children by the first code unit of their label (`undefined` for a leaf, so that leaves cost no `Map`), and those children
 * sorted by first code unit, descending: built by the first listing that walks the node and dropped by any change to `children`, so
 * that repeated listings do not sort again.
 */
interface TrieNode {
	label: string;
	value: unknown;
	children: Map<number, TrieNode> | undefined;
	sorted: TrieNode[] | undefined;
}

/** The value of a node that no key ends at (a stored `undefined` is a value). */
const NO_VALUE = Symbol();

/**
 * Throws a `TypeError` unless `value` is a string.
 * @param {string} caller - Name of the method, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a string
 */
function assertString(caller: string, name: string, value: unknown): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${caller}: \`${name}\` must be a string, got ${describe(value)}`);
}

/**
 * Length of the common prefix of `label` and of `text` from `offset`, whose first code units are known to be equal. Past the end of
 * either string `charCodeAt` returns `NaN`, which equals nothing, so the loop needs no bound.
 * @param {string} label - An edge label
 * @param {string} text - The text being matched
 * @param {number} offset - Where the label is matched in `text`
 * @returns {number} The common length, at least 1
 */
function commonLength(label: string, text: string, offset: number): number {
	let length = 1;
	while (label.charCodeAt(length) === text.charCodeAt(offset + length)) length++;
	return length;
}

/**
 * Copies a label so that it keeps no longer string alive. V8 makes a substring of 13 code units or more a view of the string it was
 * cut from, so a label sliced from a key would keep the whole key (or the whole text the key was sliced from) in memory after that key
 * is deleted; concatenating flattens the view into new memory, and the slice is then a view of that copy only.
 * @param {string} label - A label
 * @returns {string} The same code units, backed by memory of their own
 */
function detach(label: string): string {
	return label.length < 13 ? label : (label + ' ').slice(0, -1);
}

/**
 * Orders trie nodes by the first code unit of their label, descending (siblings never share it).
 * @param {TrieNode} a - A node
 * @param {TrieNode} b - Another node
 * @returns {number} Negative when `a` comes first
 */
function byLabelDescending(a: TrieNode, b: TrieNode): number {
	return b.label.charCodeAt(0) - a.label.charCodeAt(0);
}

/**
 * Creates a trie (prefix tree): a map from strings to values that also answers prefix queries: autocomplete (`keysWithPrefix`, which
 * stops at `limit` results), `hasPrefix`, and `longestPrefixOf(text)` for routing tables, tokenizers and dictionaries.
 *
 * It is a radix tree (each edge holds a whole run of code units, so chains without branches are a single node): `get`, `has`, `set` and
 * `delete` are O(key length) whatever the number of keys, `longestPrefixOf` is O(text length) at most, and a prefix query costs the
 * prefix length plus the size of the results (a node sorts its children the first time a query or an iteration lists them, and keeps
 * that order until they change). Memory stays close to the number of keys, not of characters: there are at most two nodes per key, a
 * node is four fields, and only nodes with children allocate a `Map` (keyed by code unit, so no key, `'__proto__'` included, is ever a
 * property name) and, once listed, an array of them. Labels hold their own copy of the code units, never a view of a longer string,
 * so the trie never keeps a deleted key, or the text a key was sliced from, in memory. `delete` prunes the nodes it leaves without keys
 * and merges the chains it creates, so a trie that shrank is as small as one built with the remaining keys. Nothing is recursive: keys
 * of any length work.
 *
 * - Keys are compared and ordered by UTF-16 code units, as `===`, `startsWith`, `Array.prototype.sort()` and `<` do: iteration and
 *   prefix queries list keys in the order `[...keys].sort()` would. A prefix may end in the middle of a surrogate pair, and strings are
 *   not normalized (`'é'` precomposed and decomposed are different keys).
 * - Iteration and prefix queries return snapshots: changing the trie afterwards does not affect them.
 * @template V - The value type
 * @param {Iterable<readonly [string, V]> | null} [entries] - Initial `[key, value]` pairs, set in order
 * @returns {Trie<V>} A new trie
 * @throws {TypeError} when `entries` is neither iterable nor `null`/`undefined`, or a key, prefix or text is not a string
 * @throws {RangeError} when `limit` is not an integer `>= 0` or `Infinity`
 * @example
 * const words = createTrie([['car', 1], ['cart', 2], ['care', 3], ['dog', 4]]);
 * words.keysWithPrefix('car'); // => ['car', 'care', 'cart']
 * words.keysWithPrefix('ca', { limit: 2 }); // => ['car', 'care']
 * words.hasPrefix('do'); // => true
 * words.longestPrefixOf('carton'); // => 'cart'
 * words.longestPrefixOf('cat'); // => undefined
 * words.delete('car'); // => true
 * [...words.keys()]; // => ['care', 'cart', 'dog']
 * @example
 * // Longest-prefix routing
 * const routes = createTrie<string>().set('/api', 'api').set('/api/users', 'users').set('/', 'home');
 * routes.get(routes.longestPrefixOf('/api/users/42') ?? '/'); // => 'users'
 * routes.get(routes.longestPrefixOf('/about') ?? '/'); // => 'home'
 */
export function createTrie<V>(entries?: Iterable<readonly [string, V]> | null): Trie<V> {
	const pairs = readEntries('createTrie', entries);
	// The root is the node of the empty key; its label is always ''.
	const root: TrieNode = { label: '', value: NO_VALUE, children: undefined, sorted: undefined };
	let count = 0;
	// The full key of the node `locate` last returned.
	let locatedKey: string;

	/**
	 * Finds the node where `key` ends, if the trie has one (it may hold no value).
	 * @param {string} key - The key
	 * @returns {TrieNode | undefined} The node, or `undefined`
	 */
	function find(key: string): TrieNode | undefined {
		let node = root;
		for (let i = 0; i < key.length;) {
			const child = node.children?.get(key.charCodeAt(i));
			if (child === undefined || !key.startsWith(child.label, i)) return undefined;
			i += child.label.length;
			node = child;
		}
		return node;
	}

	/**
	 * Finds the highest node whose key starts with `prefix` (its subtree holds exactly the keys that do) and stores its key in
	 * `locatedKey` (longer than `prefix` when the prefix ends inside an edge).
	 * @param {string} prefix - The prefix
	 * @returns {TrieNode | undefined} The node, or `undefined` when no key starts with `prefix`
	 */
	function locate(prefix: string): TrieNode | undefined {
		let node = root;
		for (let i = 0; i < prefix.length;) {
			const child = node.children?.get(prefix.charCodeAt(i));
			if (child === undefined) return undefined;
			const label = child.label;
			const rest = prefix.length - i;
			if (rest < label.length) {
				if (commonLength(label, prefix, i) < rest) return undefined;
				locatedKey = prefix.slice(0, i) + label;
				return child;
			}
			if (!prefix.startsWith(label, i)) return undefined;
			i += label.length;
			node = child;
		}
		locatedKey = prefix;
		return node;
	}

	/**
	 * Lists something of every key of a subtree in key order (an iterative pre-order walk, children by first code unit), stopping at
	 * `limit` results.
	 * @template T - The result element type
	 * @param {TrieNode | undefined} start - The subtree root (`undefined` for none)
	 * @param {string} startKey - Its key
	 * @param {number} limit - The maximum number of results
	 * @param {(key: string, value: V) => T} pick - Extracts what to collect from a key and its value
	 * @returns {T[]} The results
	 */
	function collect<T>(start: TrieNode | undefined, startKey: string, limit: number, pick: (key: string, value: V) => T): T[] {
		const result: T[] = [];
		if (start === undefined || limit === 0) return result;
		const nodes = [start];
		const keys = [startKey];
		while (nodes.length > 0) {
			const node = nodes.pop() as TrieNode;
			const key = keys.pop() as string;
			if (node.value !== NO_VALUE && result.push(pick(key, node.value as V)) === limit) break;
			if (node.children !== undefined) {
				// Pushed in descending order, so that the smallest child is visited next.
				for (const child of (node.sorted ??= Array.from(node.children.values()).sort(byLabelDescending))) {
					nodes.push(child);
					keys.push(key + child.label);
				}
			}
		}
		return result;
	}

	/**
	 * Replaces a node without value that has a single child by that child (whose label absorbs the node's), keeping the tree compressed.
	 * @param {TrieNode} parent - The node's parent
	 * @param {TrieNode} node - The node
	 * @returns {void}
	 */
	function merge(parent: TrieNode, node: TrieNode): void {
		const child = (node.children as Map<number, TrieNode>).values().next().value as TrieNode;
		child.label = node.label + child.label;
		(parent.children as Map<number, TrieNode>).set(node.label.charCodeAt(0), child);
		parent.sorted = undefined;
	}

	/**
	 * Reads the `limit` of a prefix query.
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {TrieQueryOptions} options - The query options
	 * @returns {number} The limit
	 * @throws {RangeError} when it is not an integer `>= 0` or `Infinity`
	 */
	function readLimit(caller: string, options: TrieQueryOptions): number {
		const limit = readOption(options, 'limit', Infinity);
		assertInteger(caller, 'options.limit', limit, 0, true);
		return limit;
	}

	/**
	 * Returns a key itself.
	 * @param {string} key - The key
	 * @returns {string} The key
	 */
	function keyOf(key: string): string {
		return key;
	}

	const trie: Trie<V> = build(
		sizedPrototype(),
		{
			get(key: string): V | undefined {
				assertString('Trie.get', 'key', key);
				const value = find(key)?.value;
				return value === NO_VALUE ? undefined : (value as V | undefined);
			},
			has(key: string): boolean {
				assertString('Trie.has', 'key', key);
				const node = find(key);
				return node !== undefined && node.value !== NO_VALUE;
			},
			set(key: string, value: V): Trie<V> {
				assertString('Trie.set', 'key', key);
				let node = root;
				for (let i = 0; i < key.length;) {
					const code = key.charCodeAt(i);
					let child = node.children?.get(code);
					if (child === undefined) {
						// A new leaf holds the rest of the key.
						child = { label: detach(key.slice(i)), value: NO_VALUE, children: undefined, sorted: undefined };
						(node.children ??= new Map()).set(code, child);
						node.sorted = undefined;
						node = child;
						break;
					}
					const label = child.label;
					const common = commonLength(label, key, i);
					if (common < label.length) {
						// The key leaves (or ends inside) the edge: split it at the divergence.
						const middle: TrieNode = { label: detach(label.slice(0, common)), value: NO_VALUE, children: new Map(), sorted: undefined };
						child.label = detach(label.slice(common));
						(middle.children as Map<number, TrieNode>).set(child.label.charCodeAt(0), child);
						(node.children as Map<number, TrieNode>).set(code, middle);
						node.sorted = undefined;
						child = middle;
					}
					i += common;
					node = child;
				}
				if (node.value === NO_VALUE) count++;
				node.value = value;
				return trie;
			},
			delete(key: string): boolean {
				assertString('Trie.delete', 'key', key);
				let grandparent: TrieNode | undefined;
				let parent: TrieNode | undefined;
				let node = root;
				for (let i = 0; i < key.length;) {
					const child = node.children?.get(key.charCodeAt(i));
					if (child === undefined || !key.startsWith(child.label, i)) return false;
					i += child.label.length;
					grandparent = parent;
					parent = node;
					node = child;
				}
				if (node.value === NO_VALUE) return false;
				node.value = NO_VALUE;
				count--;
				// Every node but the root holds a value or has two children or more; restore that.
				if (parent !== undefined) {
					const children = node.children;
					if (children === undefined) {
						const siblings = parent.children as Map<number, TrieNode>;
						siblings.delete(node.label.charCodeAt(0));
						parent.sorted = undefined;
						// A parent left without children holds a value (or is the root): it becomes a leaf.
						if (siblings.size === 0) parent.children = undefined;
						else if (grandparent !== undefined && parent.value === NO_VALUE && siblings.size === 1) merge(grandparent, parent);
					} else if (children.size === 1) merge(parent, node);
				}
				return true;
			},
			clear(): void {
				root.value = NO_VALUE;
				root.children = undefined;
				root.sorted = undefined;
				count = 0;
			},
			hasPrefix(prefix: string): boolean {
				assertString('Trie.hasPrefix', 'prefix', prefix);
				// Every node below the root leads to a key; only the root can be empty.
				return count > 0 && locate(prefix) !== undefined;
			},
			keysWithPrefix(prefix: string, options: TrieQueryOptions = {}): string[] {
				assertString('Trie.keysWithPrefix', 'prefix', prefix);
				const limit = readLimit('Trie.keysWithPrefix', options);
				const start = locate(prefix);
				return collect(start, locatedKey, limit, keyOf);
			},
			entriesWithPrefix(prefix: string, options: TrieQueryOptions = {}): Array<[string, V]> {
				assertString('Trie.entriesWithPrefix', 'prefix', prefix);
				const limit = readLimit('Trie.entriesWithPrefix', options);
				const start = locate(prefix);
				return collect<[string, V]>(start, locatedKey, limit, pairOf);
			},
			longestPrefixOf(text: string): string | undefined {
				assertString('Trie.longestPrefixOf', 'text', text);
				let node = root;
				let longest = root.value === NO_VALUE ? -1 : 0;
				for (let i = 0; i < text.length;) {
					const child = node.children?.get(text.charCodeAt(i));
					if (child === undefined || !text.startsWith(child.label, i)) break;
					i += child.label.length;
					node = child;
					if (node.value !== NO_VALUE) longest = i;
				}
				return longest < 0 ? undefined : text.slice(0, longest);
			},
			keys(): IterableIterator<string> {
				return collect(root, '', Infinity, keyOf).values();
			},
			values(): IterableIterator<V> {
				return collect(root, '', Infinity, function (_, value: V): V {
					return value;
				}).values();
			},
			entries(): IterableIterator<[string, V]> {
				return collect<[string, V]>(root, '', Infinity, pairOf).values();
			}
		},
		function (): number {
			return count;
		},
		function (): IterableIterator<[string, V]> {
			return collect<[string, V]>(root, '', Infinity, pairOf).values();
		}
	);

	if (pairs !== undefined) for (const [key, value] of pairs) trie.set(key, value);

	return trie;
}

// ---------------------------------------------------------------------------------------------------------------------
// createBloomFilter
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options of {@link createBloomFilter} that size the filter from the number of items it should hold.
 */
export interface BloomFilterSizingOptions {
	/** How many distinct items the filter should hold at the target false-positive rate (an integer `>= 1`). */
	expectedItems: number;
	/**
	 * The false-positive rate to reach with `expectedItems` items (a number in `(0, 1)`). Each halving costs about 1.44 bits per item.
	 * @default 0.01
	 */
	falsePositiveRate?: number;
	bits?: never;
	hashes?: never;
	data?: never;
}

/**
 * Options of {@link createBloomFilter} that give the filter's geometry explicitly, optionally with its content (from `toBytes()`).
 */
export interface BloomFilterGeometryOptions {
	/** The number of bits (an integer between 1 and 2³¹, rounded up to a multiple of 32). */
	bits: number;
	/** The number of bit positions per item (an integer between 1 and 256). */
	hashes: number;
	/** The filter's bits, as returned by `toBytes()` of a filter with the same `bits` and `hashes` (`bits / 8` bytes). Copied. */
	data?: Uint8Array;
	expectedItems?: never;
	falsePositiveRate?: never;
}

/**
 * Options accepted by {@link createBloomFilter}: either the sizing (`expectedItems`, `falsePositiveRate`) or the geometry (`bits`,
 * `hashes`, and optionally `data`).
 */
export type BloomFilterOptions = BloomFilterSizingOptions | BloomFilterGeometryOptions;

/**
 * A Bloom filter over strings, as returned by {@link createBloomFilter}.
 */
export interface BloomFilter {
	/** The number of bits (a multiple of 32). */
	readonly bits: number;
	/** The number of bit positions per item. */
	readonly hashes: number;
	/** Adds an item; returns `true` when it set at least one bit, which proves the item had never been added (a `false` means "probably"). */
	add(item: string): boolean;
	/** Whether the item may have been added: `false` is certain, `true` is wrong with a probability of about `estimatedFalsePositiveRate()`. */
	has(item: string): boolean;
	/** The probability that `has` answers `true` for an item never added, from the current fill: `(set bits / bits) ** hashes`. O(1). */
	estimatedFalsePositiveRate(): number;
	/** An estimate of the number of distinct items added, from the current fill (Swamidass & Baldi); `Infinity` once every bit is set. O(1). */
	estimatedSize(): number;
	/** The bits as `bits / 8` bytes (bit `i` is bit `i % 8` of byte `i >> 3`, whatever the platform's endianness), to persist or send. */
	toBytes(): Uint8Array;
	/** Removes every item. */
	clear(): void;
}

/** Largest number of bits of a Bloom filter (256 MiB): positions come from 31-bit hashes. */
const MAX_BITS = 2 ** 31;

/** Largest number of hashes of a Bloom filter (the optimal number only reaches it for false-positive rates below about 1e-77). */
const MAX_HASHES = 256;

/** The second hash returned by the last {@link murmurPair} call. */
let murmurSecond = 0;

/**
 * The MurmurHash3 (x86, 32-bit) finalizer, which makes every input bit affect every output bit, keeping the top 31 bits: a
 * non-negative 32-bit integer keeps the `%` that maps it to a bit position on the fast integer path (a hash above 2³¹ would be a double).
 * @param {number} hash - The state
 * @returns {number} The top 31 bits of the final hash
 */
function fmix31(hash: number): number {
	hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
	hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
	return (hash ^ (hash >>> 16)) >>> 1;
}

/**
 * Two independent hashes of a string in one pass: the top 31 bits of MurmurHash3 x86_32 of its UTF-16LE bytes (two code units per
 * block) with the seeds `0` and `0x9747b28c`. The second is left in {@link murmurSecond}.
 * @param {string} text - The string
 * @returns {number} The first hash, in `[0, 2³¹)`
 */
function murmurPair(text: string): number {
	const length = text.length;
	let first = 0;
	let second = 0x9747b28c;
	let i = 0;
	for (; i + 1 < length; i += 2) {
		let block = Math.imul(text.charCodeAt(i) | (text.charCodeAt(i + 1) << 16), 0xcc9e2d51);
		block = Math.imul((block << 15) | (block >>> 17), 0x1b873593);
		first ^= block;
		first = (Math.imul((first << 13) | (first >>> 19), 5) + 0xe6546b64) | 0;
		second ^= block;
		second = (Math.imul((second << 13) | (second >>> 19), 5) + 0xe6546b64) | 0;
	}
	// The last two bytes, for an odd number of code units (otherwise `charCodeAt` returns `NaN`, the block is 0 and changes nothing).
	let block = Math.imul(text.charCodeAt(i), 0xcc9e2d51);
	block = Math.imul((block << 15) | (block >>> 17), 0x1b873593);
	first ^= block;
	second ^= block;
	murmurSecond = fmix31(second ^ (length * 2));
	return fmix31(first ^ (length * 2));
}

/**
 * Number of set bits of a 32-bit integer.
 * @param {number} word - The integer
 * @returns {number} Its population count
 */
function popcount(word: number): number {
	word -= (word >>> 1) & 0x55555555;
	word = (word & 0x33333333) + ((word >>> 2) & 0x33333333);
	return Math.imul((word + (word >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * Creates a Bloom filter: a set of strings in a fixed, small amount of memory (about 9.6 bits per item at 1% false positives, whatever
 * the length of the strings) that answers "definitely not added" or "probably added". It suits caches of negative lookups, "seen
 * before?" checks over large streams, or deciding whether a slow lookup is worth making. Items cannot be removed, and the filter never
 * holds the items themselves.
 *
 * - Sizing: with `{ expectedItems: n, falsePositiveRate: p }` the filter takes the optimal `m = ⌈-n ln p / (ln 2)²⌉` bits (rounded up
 *   to a multiple of 32) and `k = round(m / n · ln 2)` hashes, so that after `n` distinct items about a fraction `p` of the items never
 *   added test positive; beyond `n` the rate climbs (see `estimatedFalsePositiveRate()`). `{ bits, hashes }` sets them directly.
 * - Hashing: the `k` bit positions come from two MurmurHash3 x86_32 hashes of the UTF-16LE code units (seeds `0` and `0x9747b28c`, top
 *   31 bits of each, reduced modulo `m`), combined by enhanced double hashing (Kirsch & Mitzenmacher; Dillinger & Manolios: positions
 *   `x`, `x + y`, `x + 2y + 1`, `x + 3y + 4`… mod `m`), so an `add` or `has` costs one pass over the string plus `k` bit operations,
 *   and allocates nothing. Two independent hashes matter: with a single 32-bit hash, each item would collide with one of a few
 *   billion values, a floor of `n / 2³²` false positives that no size can lower. Strings are not normalized (`'é'`
 *   precomposed and decomposed are different items). The hash is fixed: it is part of the format of `toBytes()`.
 * - Not for adversarial input: anyone who knows the hash can craft items that test positive, or that fill the filter.
 * - `toBytes()` and `createBloomFilter({ bits, hashes, data })` save and restore a filter (or send it to another process).
 * @param {BloomFilterOptions} options - `{ expectedItems, falsePositiveRate }` (default rate `0.01`), or `{ bits, hashes, data }`
 * @returns {BloomFilter} A new filter
 * @throws {TypeError} when `options` is not an object, mixes both forms, an option has the wrong type, `data` is not a `Uint8Array`, or
 * (from `add`/`has`) the item is not a string
 * @throws {RangeError} when `expectedItems` is not an integer `>= 1`, `falsePositiveRate` is not in `(0, 1)`, the sizing needs more than
 * 2³¹ bits (256 MiB), `bits` is not an integer between 1 and 2³¹, `hashes` is not an integer between 1 and 256, or `data` does not hold
 * `bits / 8` bytes
 * @example
 * const seen = createBloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
 * [seen.bits, seen.hashes]; // => [9600, 7]
 * seen.add('alice'); // => true // a bit changed: 'alice' was certainly new
 * seen.add('alice'); // => false
 * seen.has('alice'); // => true
 * seen.has('bob'); // => false // certain
 * seen.estimatedSize(); // => 1
 * @example
 * // Save and restore
 * import { toBase64, fromBase64 } from 'tinkit/encoding';
 * const filter = createBloomFilter({ bits: 1024, hashes: 4 });
 * filter.add('x');
 * const saved = { bits: filter.bits, hashes: filter.hashes, data: toBase64(filter.toBytes()) };
 * const restored = createBloomFilter({ bits: saved.bits, hashes: saved.hashes, data: fromBase64(saved.data) });
 * restored.has('x'); // => true
 * createBloomFilter({ expectedItems: 100, falsePositiveRate: 1 }); // throws RangeError
 */
export function createBloomFilter(options: BloomFilterOptions): BloomFilter {
	if (typeof options !== 'object' || options === null) throw new TypeError(`createBloomFilter: \`options\` must be an object, got ${describe(options)}`);
	const settings = options as { bits?: number; hashes?: number; data?: Uint8Array; expectedItems?: number; falsePositiveRate?: number };
	// Each option is read once.
	const geometry = readOption(settings, 'bits');
	const items = readOption(settings, 'expectedItems') as number;
	const rate = readOption(settings, 'falsePositiveRate');
	let hashes = readOption(settings, 'hashes') as number;
	const data = readOption(settings, 'data');
	let bits: number;

	if (geometry === undefined) {
		if (hashes !== undefined || data !== undefined) throwMixed();
		const target = rate === undefined ? 0.01 : rate;
		assertInteger('createBloomFilter', 'expectedItems', items, 1);
		assertNumber('createBloomFilter', 'falsePositiveRate', target, target > 0 && target < 1, 'a number between 0 and 1 (exclusive)');
		bits = Math.ceil((-items * Math.log(target)) / (Math.LN2 * Math.LN2) / 32) * 32;
		if (bits > MAX_BITS) throw new RangeError(`createBloomFilter: ${items} items at a false-positive rate of ${target} need ${bits} bits, more than ${MAX_BITS}`);
		hashes = Math.min(MAX_HASHES, Math.max(1, Math.round((bits / items) * Math.LN2)));
	} else {
		if (items !== undefined || rate !== undefined) throwMixed();
		assertNumber('createBloomFilter', 'bits', geometry, Number.isInteger(geometry) && geometry >= 1 && geometry <= MAX_BITS, `an integer between 1 and ${MAX_BITS}`);
		assertNumber('createBloomFilter', 'hashes', hashes, Number.isInteger(hashes) && hashes >= 1 && hashes <= MAX_HASHES, `an integer between 1 and ${MAX_HASHES}`);
		bits = Math.ceil(geometry / 32) * 32;
	}

	let words: Uint32Array;
	let setBits = 0;
	if (data === undefined) words = new Uint32Array(bits / 32);
	else {
		const tag = (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag) as PropertyDescriptor).get as () => unknown;
		if (tag.call(data) !== 'Uint8Array') throw new TypeError(`createBloomFilter: \`data\` must be a Uint8Array, got ${describe(data)}`);
		// Copied through the internal slots of `data` (its length and bytes), never through its properties, which own ones could shadow.
		const bytes = new Uint8Array(data);
		if (bytes.length !== bits / 8) throw new RangeError(`createBloomFilter: \`data\` must hold ${bits / 8} bytes (bits / 8), got ${bytes.length}`);
		// The copy becomes the words: each is decoded from little-endian in place (which changes nothing on a little-endian platform).
		words = new Uint32Array(bytes.buffer);
		const view = new DataView(bytes.buffer);
		for (let word = 0; word < words.length; word++) {
			words[word] = view.getUint32(word * 4, true);
			setBits += popcount(words[word]);
		}
	}

	return {
		bits,
		hashes,
		add(item: string): boolean {
			assertString('BloomFilter.add', 'item', item);
			let position = murmurPair(item) % bits;
			let step = murmurSecond % bits;
			let added = false;
			for (let i = 1; i <= hashes; i++) {
				const word = position >>> 5;
				const mask = 1 << (position & 31);
				if ((words[word] & mask) === 0) {
					words[word] |= mask;
					setBits++;
					added = true;
				}
				// Enhanced double hashing: positions h1, h1 + h2, h1 + 2 h2 + 1, … (mod bits).
				position += step;
				if (position >= bits) position -= bits;
				step += i;
				if (step >= bits) step %= bits;
			}
			return added;
		},
		has(item: string): boolean {
			assertString('BloomFilter.has', 'item', item);
			let position = murmurPair(item) % bits;
			let step = murmurSecond % bits;
			for (let i = 1; i <= hashes; i++) {
				if ((words[position >>> 5] & (1 << (position & 31))) === 0) return false;
				position += step;
				if (position >= bits) position -= bits;
				step += i;
				if (step >= bits) step %= bits;
			}
			return true;
		},
		estimatedFalsePositiveRate(): number {
			return (setBits / bits) ** hashes;
		},
		estimatedSize(): number {
			return Math.round((bits / hashes) * -Math.log1p(-setBits / bits));
		},
		toBytes(): Uint8Array {
			const bytes = new Uint8Array(bits / 8);
			const view = new DataView(bytes.buffer);
			// Little-endian words: bit `i` is bit `i % 8` of byte `i >> 3`.
			for (let word = 0; word < words.length; word++) view.setUint32(word * 4, words[word], true);
			return bytes;
		},
		clear(): void {
			words.fill(0);
			setBits = 0;
		}
	};
}

/**
 * Throws the error of a Bloom filter configured with both forms of options.
 * @returns {never} Never returns
 * @throws {TypeError} always
 */
function throwMixed(): never {
	throw new TypeError('createBloomFilter: pass either `expectedItems` (and `falsePositiveRate`) or `bits` and `hashes` (and `data`), not both');
}
