import { AbortError } from '../async/index.js';
import { isAsyncIterable, isIterable } from '../guards/index.js';
import { assertDelay, assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';
import type { AbortSignalLike } from '../utils/index.js';
import { assertOptionalSignal, detach, reasonOf } from '../utils/signal.js';

/**
 * The tuple of item types produced by {@link zip} for a tuple of input iterables.
 * @example
 * type R = ZippedValues<[number[], Set<string>]>; // [number, string]
 */
export type ZippedValues<T extends ReadonlyArray<Iterable<unknown>>> = { -readonly [K in keyof T]: T[K] extends Iterable<infer U> ? U : never };

/**
 * Inputs accepted by the async helpers: an async iterable, or a sync iterable whose items may be promises
 * (they are awaited one by one, as with `for await` and `Array.fromAsync`).
 */
export type AwaitableIterable<T> = AsyncIterable<T> | Iterable<T | PromiseLike<T>>;

/**
 * Throws a `TypeError` unless `value` is a (sync) iterable.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} value - The value to validate
 * @param {string} [name='iterable'] - Name of the validated parameter
 * @returns {void}
 * @throws {TypeError} when `value` is not iterable
 */
function assertIterable(caller: string, value: unknown, name = 'iterable'): void {
	if (!isIterable(value)) throw new TypeError(`${caller}: \`${name}\` must be iterable, got ${describe(value)}`);
}

/**
 * Throws a `TypeError` unless `value` is an async iterable or a sync iterable.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is neither async iterable nor iterable
 */
function assertAwaitableIterable(caller: string, value: unknown): void {
	if (!isAsyncIterable(value)) assertIterable(caller, value);
}

/**
 * Awaits each item of a sync iterable inside a `for...of` loop (see {@link awaitItems}).
 * @template T
 * @param {Iterable<T | PromiseLike<T>>} iterable - A sync iterable of values and/or promises
 * @returns {AsyncGenerator<T, void, undefined>} An async generator of the awaited items
 */
async function* awaitedItems<T>(iterable: Iterable<T | PromiseLike<T>>): AsyncGenerator<T, void, undefined> {
	// `yield` awaits the item in an async generator (an explicit `await` would cost a second tick): a rejection is thrown here, inside the
	// loop, which closes the source.
	for (const value of iterable) yield value;
}

/**
 * Adapts an {@link AwaitableIterable} for `for await`: async iterables are returned as is, and sync iterables are wrapped so
 * each item is awaited inside a `for...of` loop, which closes the sync source when an item rejects or iteration stops early
 * (the built-in async-from-sync wrapper of older engines leaves the source open when an item rejects).
 * @template T
 * @param {AwaitableIterable<T>} iterable - An async iterable, or a sync iterable of values and/or promises
 * @returns {AwaitableIterable<T>} An iterable that `for await` reads as the (awaited) items
 */
function awaitItems<T>(iterable: AwaitableIterable<T>): AwaitableIterable<T> {
	// An array (or array-like) using the built-in array iterator needs no wrapper: that iterator has nothing to close, so the
	// async-from-sync wrapper of `for await` is enough. (Read here rather than at the top level, which bundlers would keep in every helper.)
	if (isAsyncIterable(iterable) || iterable[Symbol.iterator] === Array.prototype[Symbol.iterator]) return iterable;
	return awaitedItems(iterable);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The generator behind {@link count} (the arguments are already validated).
 * @param {number} start - The first value
 * @param {number} step - The increment between values
 * @returns {Generator<number, void, undefined>} A generator of the counted values
 */
function* counter(start: number, step: number): Generator<number, void, undefined> {
	for (let i = 0; ; i++) yield start + i * step;
}

/**
 * Lazily count from `start` by `step`, forever: `start, start + step, start + 2 * step, ...`.
 * Each value is computed as `start + i * step`, so fractional steps do not accumulate rounding errors.
 * The sequence is infinite: bound it with {@link take} or {@link takeWhile}.
 * @param {number} [start=0] - The first value
 * @param {number} [step=1] - The increment between values (may be negative or 0)
 * @returns {IterableIterator<number>} An infinite iterator of numbers
 * @throws {RangeError} when `start` or `step` is not a finite number
 * @throws {TypeError} when `start` or `step` is not a number
 * @example
 * toArray(take(count(), 3)); // => [0, 1, 2]
 * toArray(take(count(10, -5), 3)); // => [10, 5, 0]
 */
export function count(start = 0, step = 1): IterableIterator<number> {
	assertNumber('count', 'start', start, Number.isFinite(start), 'a finite number');
	assertNumber('count', 'step', step, Number.isFinite(step), 'a finite number');
	return counter(start, step);
}

/**
 * The generator behind {@link repeatValue} (the arguments are already validated).
 * @template T
 * @param {T} value - The value to repeat
 * @param {number} times - How many times to yield it
 * @returns {Generator<T, void, undefined>} A generator of the repetitions
 */
function* repeated<T>(value: T, times: number): Generator<T, void, undefined> {
	for (let i = 0; i < times; i++) yield value;
}

/**
 * Lazily yield the same value `times` times (forever by default).
 * @template T
 * @param {T} value - The value to repeat
 * @param {number} [times=Infinity] - How many times to yield it (a non-negative integer or `Infinity`)
 * @returns {IterableIterator<T>} An iterator yielding `value` `times` times
 * @throws {RangeError} when `times` is negative, `NaN` or a non-integer finite number
 * @throws {TypeError} when `times` is not a number
 * @example
 * toArray(repeatValue('a', 3)); // => ['a', 'a', 'a']
 * toArray(take(repeatValue(0), 2)); // => [0, 0]
 */
export function repeatValue<T>(value: T, times = Infinity): IterableIterator<T> {
	assertInteger('repeatValue', 'times', times, 0, true);
	return repeated(value, times);
}

/**
 * The generator behind {@link cycle} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The items to cycle through
 * @returns {Generator<T, void, undefined>} A generator of the items, repeated
 */
function* cycled<T>(iterable: Iterable<T>): Generator<T, void, undefined> {
	const cache: T[] = [];
	for (const value of iterable) {
		cache.push(value);
		yield value;
	}
	if (cache.length === 0) return;
	// Plain loops rather than `yield*`, so `throw()` rethrows its error instead of a TypeError from the array iterator.
	for (;;) for (const value of cache) yield value;
}

/**
 * Lazily repeat the items of an iterable forever. The first pass is cached, so the source is iterated only once
 * (one-shot iterators such as generators can be cycled). An empty source gives an empty iterator (not an infinite loop).
 * Every item of the first pass is kept in memory, so an infinite source is never repeated and its cache grows without bound.
 * @template T
 * @param {Iterable<T>} iterable - The items to cycle through
 * @returns {IterableIterator<T>} An infinite iterator (or an empty one when the source is empty)
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * toArray(take(cycle([1, 2]), 5)); // => [1, 2, 1, 2, 1]
 * toArray(cycle([])); // => []
 */
export function cycle<T>(iterable: Iterable<T>): IterableIterator<T> {
	assertIterable('cycle', iterable);
	return cycled(iterable);
}

/**
 * The generator behind {@link iterate} (the arguments are already validated).
 * @template T
 * @param {T} seed - The first item
 * @param {(value: T) => T} next - Computes an item from the previous one
 * @returns {Generator<T, void, undefined>} A generator of the successive items
 */
function* iterated<T>(seed: T, next: (value: T) => T): Generator<T, void, undefined> {
	for (let value = seed; ; value = next(value)) yield value;
}

/**
 * Lazily unfold a sequence from a seed: `seed, next(seed), next(next(seed)), ...`, forever.
 * `next` is only called when the following item is actually requested.
 * @template T
 * @param {T} seed - The first item
 * @param {(value: T) => T} next - Computes an item from the previous one
 * @returns {IterableIterator<T>} An infinite iterator
 * @throws {TypeError} when `next` is not a function
 * @example
 * toArray(take(iterate(1, function (n) { return n * 2; }), 5)); // => [1, 2, 4, 8, 16]
 */
export function iterate<T>(seed: T, next: (value: T) => T): IterableIterator<T> {
	assertFunction('iterate', 'next', next);
	return iterated(seed, next);
}

// ---------------------------------------------------------------------------------------------------------------------
// Transforms (lazy: nothing is pulled from the source until the result is iterated, and early exits close the source)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The generator behind {@link map} (the arguments are already validated).
 * @template T
 * @template U
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => U} fn - Maps an item (and its index)
 * @returns {Generator<U, void, undefined>} A generator of the mapped items
 */
function* mapped<T, U>(iterable: Iterable<T>, fn: (value: T, index: number) => U): Generator<U, void, undefined> {
	let index = 0;
	for (const value of iterable) yield fn(value, index++);
}

/**
 * Lazily transform each item of an iterable (the lazy counterpart of `Array.prototype.map`).
 * @template T
 * @template U
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => U} fn - Maps an item (and its index) to the output item
 * @returns {IterableIterator<U>} An iterator of the mapped items
 * @throws {TypeError} when `iterable` is not iterable or `fn` is not a function
 * @example
 * toArray(map([1, 2, 3], function (n) { return n * 2; })); // => [2, 4, 6]
 */
export function map<T, U>(iterable: Iterable<T>, fn: (value: T, index: number) => U): IterableIterator<U> {
	assertIterable('map', iterable);
	assertFunction('map', 'fn', fn);
	return mapped(iterable, fn);
}

/**
 * The generator behind {@link filter} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides which items to keep
 * @returns {Generator<T, void, undefined>} A generator of the kept items
 */
function* filtered<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): Generator<T, void, undefined> {
	let index = 0;
	for (const value of iterable) if (predicate(value, index++)) yield value;
}

/**
 * Lazily keep the items matching a type guard, narrowing the item type.
 * @template T
 * @template S
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => value is S} predicate - Type guard deciding which items to keep
 * @returns {IterableIterator<S>} An iterator of the items for which `predicate` returned `true`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * toArray(filter([1, 'a', 2], function (v): v is number { return typeof v === 'number'; })); // => [1, 2] // typed as number[]
 */
export function filter<T, S extends T>(iterable: Iterable<T>, predicate: (value: T, index: number) => value is S): IterableIterator<S>;
/**
 * Lazily keep the items matching a predicate (the lazy counterpart of `Array.prototype.filter`).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides which items to keep
 * @returns {IterableIterator<T>} An iterator of the items for which `predicate` returned `true`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * toArray(filter([1, 2, 3, 4], function (n) { return n % 2 === 0; })); // => [2, 4]
 */
export function filter<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): IterableIterator<T>;
/**
 * Lazily keep the items matching a predicate (the lazy counterpart of `Array.prototype.filter`).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides which items to keep
 * @returns {IterableIterator<T>} An iterator of the items for which `predicate` returned `true`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * toArray(filter([1, 2, 3, 4], function (n) { return n % 2 === 0; })); // => [2, 4]
 */
export function filter<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): IterableIterator<T> {
	assertIterable('filter', iterable);
	assertFunction('filter', 'predicate', predicate);
	return filtered(iterable, predicate);
}

/**
 * The generator behind {@link flatMap} (the arguments are already validated).
 * @template T
 * @template U
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => Iterable<U>} fn - Maps an item (and its index) to an iterable
 * @returns {Generator<U, void, undefined>} A generator of the flattened items
 */
function* flatMapped<T, U>(iterable: Iterable<T>, fn: (value: T, index: number) => Iterable<U>): Generator<U, void, undefined> {
	let index = 0;
	for (const value of iterable) {
		const inner = fn(value, index++);
		assertIterable('flatMap', inner, 'fn(...)');
		// Not `yield*`: `throw()` must close the inner iterator and rethrow, not be forwarded into it.
		for (const item of inner) yield item;
	}
}

/**
 * Lazily map each item to an iterable and flatten the results one level. Any iterable may be returned
 * (arrays, sets, generators, ... and strings, which are flattened into their characters).
 * @template T
 * @template U
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => Iterable<U>} fn - Maps an item (and its index) to the iterable of output items
 * @returns {IterableIterator<U>} An iterator of the flattened items
 * @throws {TypeError} when `iterable` is not iterable, `fn` is not a function, or (while iterating) `fn` returns a non-iterable
 * @example
 * toArray(flatMap([1, 2], function (n) { return [n, n * 10]; })); // => [1, 10, 2, 20]
 */
export function flatMap<T, U>(iterable: Iterable<T>, fn: (value: T, index: number) => Iterable<U>): IterableIterator<U> {
	assertIterable('flatMap', iterable);
	assertFunction('flatMap', 'fn', fn);
	return flatMapped(iterable, fn);
}

/**
 * The generator behind {@link take} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} n - How many items to take
 * @returns {Generator<T, void, undefined>} A generator of the first items
 */
function* takenItems<T>(iterable: Iterable<T>, n: number): Generator<T, void, undefined> {
	if (n === 0) return;
	let taken = 0;
	for (const value of iterable) {
		yield value;
		if (++taken >= n) return;
	}
}

/**
 * Lazily yield the first `n` items of an iterable (or all of them when it is shorter). Exactly `n` items are pulled from
 * the source (none when `n` is 0), which is then closed — so `take` is the way to bound infinite iterators.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} n - How many items to take (a non-negative integer, or `Infinity` for all of them)
 * @returns {IterableIterator<T>} An iterator of at most `n` items
 * @throws {TypeError} when `iterable` is not iterable
 * @throws {RangeError} when `n` is negative, `NaN` or a non-integer finite number
 * @throws {TypeError} when `n` is not a number
 * @example
 * toArray(take(count(), 3)); // => [0, 1, 2]
 */
export function take<T>(iterable: Iterable<T>, n: number): IterableIterator<T> {
	assertIterable('take', iterable);
	assertInteger('take', 'n', n, 0, true);
	return takenItems(iterable, n);
}

/**
 * The generator behind {@link drop} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} n - How many items to skip
 * @returns {Generator<T, void, undefined>} A generator of the remaining items
 */
function* dropped<T>(iterable: Iterable<T>, n: number): Generator<T, void, undefined> {
	let skipped = 0;
	for (const value of iterable) {
		if (skipped < n) skipped++;
		else yield value;
	}
}

/**
 * Lazily skip the first `n` items of an iterable and yield the rest.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} n - How many items to skip (a non-negative integer)
 * @returns {IterableIterator<T>} An iterator of the remaining items
 * @throws {TypeError} when `iterable` is not iterable
 * @throws {RangeError} when `n` is negative or not an integer
 * @throws {TypeError} when `n` is not a number
 * @example
 * toArray(drop([1, 2, 3], 2)); // => [3]
 */
export function drop<T>(iterable: Iterable<T>, n: number): IterableIterator<T> {
	assertIterable('drop', iterable);
	assertInteger('drop', 'n', n, 0);
	return dropped(iterable, n);
}

/**
 * The generator behind {@link takeWhile} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides whether to keep going
 * @returns {Generator<T, void, undefined>} A generator of the leading matching items
 */
function* takenWhile<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): Generator<T, void, undefined> {
	let index = 0;
	for (const value of iterable) {
		if (!predicate(value, index++)) return;
		yield value;
	}
}

/**
 * Lazily yield items while `predicate` holds, stopping (and closing the source) at the first item that fails it.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides whether to keep going
 * @returns {IterableIterator<T>} An iterator of the leading items that satisfy `predicate`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * toArray(takeWhile(count(1), function (n) { return n < 4; })); // => [1, 2, 3]
 */
export function takeWhile<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): IterableIterator<T> {
	assertIterable('takeWhile', iterable);
	assertFunction('takeWhile', 'predicate', predicate);
	return takenWhile(iterable, predicate);
}

/**
 * The generator behind {@link dropWhile} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides whether to keep skipping
 * @returns {Generator<T, void, undefined>} A generator of the items from the first failing one
 */
function* droppedWhile<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): Generator<T, void, undefined> {
	let dropping = true;
	let index = 0;
	for (const value of iterable) {
		if (dropping && predicate(value, index++)) continue;
		dropping = false;
		yield value;
	}
}

/**
 * Lazily skip items while `predicate` holds, then yield the first failing item and everything after it
 * (`predicate` is no longer called once it has failed).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Decides whether to keep skipping
 * @returns {IterableIterator<T>} An iterator of the items from the first one failing `predicate`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * toArray(dropWhile([1, 2, 3, 1], function (n) { return n < 2; })); // => [2, 3, 1]
 */
export function dropWhile<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): IterableIterator<T> {
	assertIterable('dropWhile', iterable);
	assertFunction('dropWhile', 'predicate', predicate);
	return droppedWhile(iterable, predicate);
}

/**
 * The generator behind {@link chunk} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} size - The maximum length of each chunk
 * @returns {Generator<T[], void, undefined>} A generator of the chunks
 */
function* chunked<T>(iterable: Iterable<T>, size: number): Generator<T[], void, undefined> {
	let buffer: T[] = [];
	for (const value of iterable) {
		buffer.push(value);
		if (buffer.length === size) {
			const full = buffer;
			buffer = [];
			yield full;
		}
	}
	if (buffer.length > 0) yield buffer;
}

/**
 * Lazily split an iterable into consecutive chunks of `size` items; only the last chunk may be shorter.
 * Each chunk is a fresh array, yielded as soon as it is full.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} size - The maximum length of each chunk (a positive integer)
 * @returns {IterableIterator<T[]>} An iterator of chunks (empty when the source is empty)
 * @throws {TypeError} when `iterable` is not iterable
 * @throws {RangeError} when `size` is not a positive integer
 * @throws {TypeError} when `size` is not a number
 * @example
 * toArray(chunk([1, 2, 3, 4, 5], 2)); // => [[1, 2], [3, 4], [5]]
 */
export function chunk<T>(iterable: Iterable<T>, size: number): IterableIterator<T[]> {
	assertIterable('chunk', iterable);
	assertInteger('chunk', 'size', size, 1);
	return chunked(iterable, size);
}

/**
 * The generator behind {@link windowed} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} size - The length of each window
 * @param {number} step - The distance between window starts
 * @returns {Generator<T[], void, undefined>} A generator of the windows
 */
function* windows<T>(iterable: Iterable<T>, size: number, step: number): Generator<T[], void, undefined> {
	let buffer: T[] = [];
	let skip = 0;
	for (const value of iterable) {
		if (skip > 0) {
			skip--;
			continue;
		}
		buffer.push(value);
		if (buffer.length === size) {
			const window = buffer;
			buffer = buffer.slice(step);
			skip = Math.max(0, step - size);
			yield window;
		}
	}
}

/**
 * Lazily yield the sliding windows of `size` consecutive items, starting every `step` items. Only FULL windows are
 * yielded (trailing items that do not fill a window are dropped), and items between windows (when `step > size`)
 * are skipped without being buffered. Each window is a fresh array.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {number} size - The length of each window (a positive integer)
 * @param {number} [step=1] - The distance between the starts of two consecutive windows (a positive integer)
 * @returns {IterableIterator<T[]>} An iterator of windows
 * @throws {TypeError} when `iterable` is not iterable
 * @throws {RangeError} when `size` or `step` is not a positive integer
 * @throws {TypeError} when `size` or `step` is not a number
 * @example
 * toArray(windowed([1, 2, 3, 4], 2)); // => [[1, 2], [2, 3], [3, 4]]
 * toArray(windowed([1, 2, 3, 4, 5], 2, 2)); // => [[1, 2], [3, 4]]
 */
export function windowed<T>(iterable: Iterable<T>, size: number, step = 1): IterableIterator<T[]> {
	assertIterable('windowed', iterable);
	assertInteger('windowed', 'size', size, 1);
	assertInteger('windowed', 'step', step, 1);
	return windows(iterable, size, step);
}

/**
 * Calls `return()` on each iterator except the one at index `skip` (which is exhausted or has thrown).
 * @param {ReadonlyArray<Iterator<unknown>>} iterators - The iterators to close
 * @param {number} skip - Index of an iterator that must not be closed (`-1` for none)
 * @param {boolean} suppress - Whether errors thrown by `return()` are ignored (used when another error is propagating)
 * @returns {void}
 * @throws {unknown} the first error thrown by a `return()` call, unless `suppress` is set
 */
function closeIterators(iterators: ReadonlyArray<Iterator<unknown>>, skip: number, suppress: boolean): void {
	let failure: { error: unknown } | undefined;
	for (let i = 0; i < iterators.length; i++) {
		if (i === skip) continue;
		try {
			iterators[i].return?.();
		} catch (error) {
			failure ??= { error };
		}
	}
	if (failure !== undefined && !suppress) throw failure.error;
}

/**
 * Checks the result of an iterator's `next()` as `for...of` does: it must be an object (functions included).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} result - The result
 * @returns {IteratorResult<unknown>} The result
 * @throws {TypeError} when the result is not an object
 */
function stepOf(caller: string, result: unknown): IteratorResult<unknown> {
	if (typeof result !== 'object' ? typeof result !== 'function' : result === null) throw new TypeError(`${caller}: iterator result ${describe(result)} is not an object`);
	return result as IteratorResult<unknown>;
}

/**
 * The generator behind {@link zip} (the arguments are already validated).
 * @template T
 * @param {T} iterables - The iterables to zip
 * @returns {Generator<ZippedValues<T>, void, undefined>} A generator of the tuples
 */
function* zipped<T extends Array<Iterable<unknown>>>(iterables: T): Generator<ZippedValues<T>, void, undefined> {
	if (iterables.length === 0) return;
	const iterators: Array<Iterator<unknown>> = [];
	// Index of the iterator being advanced: when it ends (or throws), it must not be closed.
	let current = -1;
	let threw = false;
	try {
		for (const iterable of iterables) {
			const iterator: unknown = iterable[Symbol.iterator]();

			if (typeof iterator !== 'object' || iterator === null) throw new TypeError(`zip: an iterator must be an object, got ${describe(iterator)}`);
			iterators.push(iterator as Iterator<unknown>);
		}
		for (;;) {
			const tuple = new Array<unknown>(iterators.length);
			for (current = 0; current < iterators.length; current++) {
				const result = stepOf('zip', iterators[current].next());
				if (result.done) return;
				tuple[current] = result.value;
			}
			current = -1;
			yield tuple as ZippedValues<T>;
		}
	} catch (error) {
		threw = true;
		throw error;
	} finally {
		closeIterators(iterators, current, threw);
	}
}

/**
 * Lazily combine iterables item-wise into tuples, stopping at the end of the SHORTEST one (which may be infinite
 * as long as another one is finite). When one source ends, or iteration stops early, all the other sources are closed.
 * @template T
 * @param {...Iterable<unknown>} iterables - The iterables to zip
 * @returns {IterableIterator<ZippedValues<T>>} An iterator of tuples; empty when called without iterables
 * @throws {TypeError} when an argument is not iterable
 * @example
 * toArray(zip([1, 2, 3], 'ab')); // => [[1, 'a'], [2, 'b']] // typed as [number, string][]
 * toArray(zip(count(), ['a', 'b'])); // => [[0, 'a'], [1, 'b']]
 */
export function zip<T extends Array<Iterable<unknown>>>(...iterables: T): IterableIterator<ZippedValues<T>> {
	for (const iterable of iterables) assertIterable('zip', iterable, 'iterables');
	return zipped(iterables);
}

/**
 * The generator behind {@link enumerate} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {Generator<[number, T], void, undefined>} A generator of the `[index, value]` tuples
 */
function* enumerated<T>(iterable: Iterable<T>): Generator<[number, T], void, undefined> {
	let index = 0;
	for (const value of iterable) yield [index++, value];
}

/**
 * Lazily pair each item with its zero-based index.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {IterableIterator<[number, T]>} An iterator of `[index, value]` tuples
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * toArray(enumerate(['a', 'b'])); // => [[0, 'a'], [1, 'b']]
 */
export function enumerate<T>(iterable: Iterable<T>): IterableIterator<[number, T]> {
	assertIterable('enumerate', iterable);
	return enumerated(iterable);
}

/**
 * The generator behind {@link unique} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {((value: T, index: number) => unknown) | undefined} keyFn - Returns the identity key of an item
 * @returns {Generator<T, void, undefined>} A generator of the first item per key
 */
function* uniqueItems<T>(iterable: Iterable<T>, keyFn: ((value: T, index: number) => unknown) | undefined): Generator<T, void, undefined> {
	const seen = new Set<unknown>();
	let index = 0;
	for (const value of iterable) {
		const key = keyFn === undefined ? value : keyFn(value, index);
		index++;
		if (seen.has(key)) continue;
		seen.add(key);
		yield value;
	}
}

/**
 * Lazily drop items whose key (the item itself, or the result of `keyFn`) was already seen, keeping first occurrences.
 * Keys are compared with SameValueZero (so `NaN` equals `NaN` and `0` equals `-0`). Seen keys are kept in memory.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => unknown} [keyFn] - Returns the identity key of an item (defaults to the item itself)
 * @returns {IterableIterator<T>} An iterator of the first item for each distinct key
 * @throws {TypeError} when `iterable` is not iterable or `keyFn` is given but is not a function
 * @example
 * toArray(unique([1, 2, 1, 3, 2])); // => [1, 2, 3]
 * toArray(unique(['a', 'B', 'A'], function (s) { return s.toLowerCase(); })); // => ['a', 'B']
 */
export function unique<T>(iterable: Iterable<T>, keyFn?: (value: T, index: number) => unknown): IterableIterator<T> {
	assertIterable('unique', iterable);
	if (keyFn !== undefined) assertFunction('unique', 'keyFn', keyFn);
	return uniqueItems(iterable, keyFn);
}

/**
 * The generator behind {@link scan} (the arguments are already validated).
 * @template T
 * @template A
 * @param {Iterable<T>} iterable - The source items
 * @param {(accumulator: A, value: T, index: number) => A} reducer - Combines the accumulator with an item
 * @param {A} initial - The initial accumulator
 * @returns {Generator<A, void, undefined>} A generator of the successive accumulators
 */
function* scanned<T, A>(iterable: Iterable<T>, reducer: (accumulator: A, value: T, index: number) => A, initial: A): Generator<A, void, undefined> {
	let accumulator = initial;
	let index = 0;
	for (const value of iterable) {
		accumulator = reducer(accumulator, value, index++);
		yield accumulator;
	}
}

/**
 * Lazily yield the running accumulation of an iterable: the accumulator after each item (the initial value itself is
 * NOT yielded, so the output has as many items as the input, and its last item is what `reduce` would return).
 * @template T
 * @template A
 * @param {Iterable<T>} iterable - The source items
 * @param {(accumulator: A, value: T, index: number) => A} reducer - Combines the accumulator with an item
 * @param {A} initial - The initial accumulator
 * @returns {IterableIterator<A>} An iterator of the successive accumulators
 * @throws {TypeError} when `iterable` is not iterable or `reducer` is not a function
 * @example
 * toArray(scan([1, 2, 3], function (sum, n) { return sum + n; }, 0)); // => [1, 3, 6]
 */
export function scan<T, A>(iterable: Iterable<T>, reducer: (accumulator: A, value: T, index: number) => A, initial: A): IterableIterator<A> {
	assertIterable('scan', iterable);
	assertFunction('scan', 'reducer', reducer);
	return scanned(iterable, reducer, initial);
}

/**
 * The generator behind {@link concat} (the arguments are already validated).
 * @template T
 * @param {ReadonlyArray<Iterable<T>>} iterables - The iterables to chain
 * @returns {Generator<T, void, undefined>} A generator of all the items, in order
 */
function* concatenated<T>(iterables: ReadonlyArray<Iterable<T>>): Generator<T, void, undefined> {
	// Not `yield*`: `throw()` must close the current source and rethrow, not be forwarded into it.
	for (const iterable of iterables) for (const value of iterable) yield value;
}

/**
 * Lazily yield the items of each iterable in turn. Each source is only opened once the previous one is exhausted.
 * @template T
 * @param {...Iterable<T>} iterables - The iterables to chain
 * @returns {IterableIterator<T>} An iterator over all the items, in order
 * @throws {TypeError} when an argument is not iterable
 * @example
 * toArray(concat([1, 2], new Set([3]), 'ab')); // => [1, 2, 3, 'a', 'b']
 */
export function concat<T>(...iterables: Array<Iterable<T>>): IterableIterator<T> {
	for (const iterable of iterables) assertIterable('concat', iterable, 'iterables');
	return concatenated(iterables);
}

/**
 * The generator behind {@link tap} (the arguments are already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => void} fn - Side effect run on each item
 * @returns {Generator<T, void, undefined>} A generator of the same items
 */
function* tapped<T>(iterable: Iterable<T>, fn: (value: T, index: number) => void): Generator<T, void, undefined> {
	let index = 0;
	for (const value of iterable) {
		fn(value, index++);
		yield value;
	}
}

/**
 * Lazily call `fn` on each item as it passes through, yielding the items unchanged (for logging or debugging).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => void} fn - Side effect run on each item before it is yielded
 * @returns {IterableIterator<T>} An iterator of the same items
 * @throws {TypeError} when `iterable` is not iterable or `fn` is not a function
 * @example
 * const seen: number[] = [];
 * toArray(tap([1, 2], function (n) { seen.push(n); })); // => [1, 2]
 * seen; // => [1, 2]
 */
export function tap<T>(iterable: Iterable<T>, fn: (value: T, index: number) => void): IterableIterator<T> {
	assertIterable('tap', iterable);
	assertFunction('tap', 'fn', fn);
	return tapped(iterable, fn);
}

// ---------------------------------------------------------------------------------------------------------------------
// Consumers (eager: they pull from the source; those that can stop early close it)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Collect the items of an iterable into a new array. Never returns for an infinite iterable: bound it with {@link take}.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {T[]} A new array with every item
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * toArray(map(new Set([1, 2]), function (n) { return n + 1; })); // => [2, 3]
 */
export function toArray<T>(iterable: Iterable<T>): T[] {
	assertIterable('toArray', iterable);
	// Arrays are copied fastest by the built-in spread, but other iterators (generators) are drained faster by a `for...of` loop.
	if (Array.isArray(iterable)) return [...(iterable as T[])];
	const result: T[] = [];
	for (const value of iterable) result.push(value);
	return result;
}

/**
 * Reduce the items of an iterable to a single value, starting from `initial`.
 * @template T
 * @template A
 * @param {Iterable<T>} iterable - The source items
 * @param {(accumulator: A, value: T, index: number) => A} reducer - Combines the accumulator with an item
 * @param {A} initial - The initial accumulator
 * @returns {A} The final accumulator (`initial` for an empty iterable)
 * @throws {TypeError} when `iterable` is not iterable or `reducer` is not a function
 * @example
 * reduce([1, 2, 3], function (sum, n) { return sum + n; }, 10); // => 16
 */
export function reduce<T, A>(iterable: Iterable<T>, reducer: (accumulator: A, value: T, index: number) => A, initial: A): A;
/**
 * Reduce the items of an iterable to a single value, using the first item as the initial accumulator
 * (the reducer is first called with the second item, at index 1, like `Array.prototype.reduce`).
 * @template T
 * @param {Iterable<T>} iterable - The source items (at least one)
 * @param {(accumulator: T, value: T, index: number) => T} reducer - Combines the accumulator with an item
 * @returns {T} The final accumulator
 * @throws {TypeError} when `iterable` is not iterable, `reducer` is not a function, or the iterable is empty
 * @example
 * reduce([1, 2, 3], function (max, n) { return Math.max(max, n); }); // => 3
 */
export function reduce<T>(iterable: Iterable<T>, reducer: (accumulator: T, value: T, index: number) => T): T;
/**
 * Reduce the items of an iterable to a single value, from `initial` or (when omitted) from the first item.
 * @template T
 * @template A
 * @param {Iterable<T>} iterable - The source items
 * @param {(accumulator: A, value: T, index: number) => A} reducer - Combines the accumulator with an item
 * @param {...A} initial - The optional initial accumulator
 * @returns {A} The final accumulator
 * @throws {TypeError} when `iterable` is not iterable, `reducer` is not a function, or the iterable is empty and no initial value is given
 * @example
 * reduce([1, 2, 3], function (sum, n) { return sum + n; }, 0); // => 6
 */
export function reduce<T, A>(iterable: Iterable<T>, reducer: (accumulator: A, value: T, index: number) => A, ...initial: [] | [A]): A {
	assertIterable('reduce', iterable);
	assertFunction('reduce', 'reducer', reducer);
	let accumulator = initial[0] as A;
	let index = 0;
	if (initial.length > 0) {
		// With an initial value, the loop needs no "first item" check.
		for (const value of iterable) accumulator = reducer(accumulator, value, index++);
		return accumulator;
	}
	let hasAccumulator = false;
	for (const value of iterable) {
		if (hasAccumulator) {
			accumulator = reducer(accumulator, value, index);
		} else {
			accumulator = value as unknown as A;
			hasAccumulator = true;
		}
		index++;
	}
	if (!hasAccumulator) throw new TypeError('reduce: cannot reduce an empty iterable without an initial value');
	return accumulator;
}

/**
 * Return the first item of an iterable, pulling only that item (the source is then closed).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {T | undefined} The first item, or `undefined` when the iterable is empty
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * first(count(5)); // => 5
 * first([]); // => undefined
 */
export function first<T>(iterable: Iterable<T>): T | undefined {
	assertIterable('first', iterable);
	for (const value of iterable) return value;
	return undefined;
}

/**
 * Return the last item of an iterable (consuming all of it; never returns for an infinite iterable).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {T | undefined} The last item, or `undefined` when the iterable is empty
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * last(take(count(), 4)); // => 3
 */
export function last<T>(iterable: Iterable<T>): T | undefined {
	assertIterable('last', iterable);
	let result: T | undefined;
	for (const value of iterable) result = value;
	return result;
}

/**
 * Return the first item matching a type guard, narrowing its type; stops pulling (and closes the source) once found.
 * @template T
 * @template S
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => value is S} predicate - Type guard identifying the wanted item
 * @returns {S | undefined} The first matching item, or `undefined` when none matches
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * find([1, 'a'], function (v): v is string { return typeof v === 'string'; }); // => 'a' // typed as string | undefined
 */
export function find<T, S extends T>(iterable: Iterable<T>, predicate: (value: T, index: number) => value is S): S | undefined;
/**
 * Return the first item matching a predicate; stops pulling (and closes the source) once found.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Identifies the wanted item
 * @returns {T | undefined} The first matching item, or `undefined` when none matches
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * find(count(1), function (n) { return n % 7 === 0; }); // => 7
 */
export function find<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): T | undefined;
/**
 * Return the first item matching a predicate; stops pulling (and closes the source) once found.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - Identifies the wanted item
 * @returns {T | undefined} The first matching item, or `undefined` when none matches
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * find([1, 2, 3], function (n) { return n > 1; }); // => 2
 */
export function find<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): T | undefined {
	assertIterable('find', iterable);
	assertFunction('find', 'predicate', predicate);
	let index = 0;
	for (const value of iterable) if (predicate(value, index++)) return value;
	return undefined;
}

/**
 * Tell whether at least one item matches a predicate; stops at (and closes the source on) the first match.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - The condition to test
 * @returns {boolean} Whether any item matches (`false` for an empty iterable)
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * some(count(), function (n) { return n > 100; }); // => true
 */
export function some<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): boolean {
	assertIterable('some', iterable);
	assertFunction('some', 'predicate', predicate);
	let index = 0;
	for (const value of iterable) if (predicate(value, index++)) return true;
	return false;
}

/**
 * Tell whether every item matches a predicate; stops at (and closes the source on) the first mismatch.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} predicate - The condition to test
 * @returns {boolean} Whether all items match (`true` for an empty iterable)
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * every([2, 4], function (n) { return n % 2 === 0; }); // => true
 */
export function every<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): boolean {
	assertIterable('every', iterable);
	assertFunction('every', 'predicate', predicate);
	let index = 0;
	for (const value of iterable) if (!predicate(value, index++)) return false;
	return true;
}

/**
 * Count the items of an iterable (consuming all of it), or only those matching `predicate` when given.
 * Named `countItems` because {@link count} is the infinite counter source.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean} [predicate] - Only items for which it returns `true` are counted
 * @returns {number} The number of (matching) items
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is given but is not a function
 * @example
 * countItems(new Set([1, 2, 3])); // => 3
 * countItems([1, 2, 3], function (n) { return n > 1; }); // => 2
 */
export function countItems<T>(iterable: Iterable<T>, predicate?: (value: T, index: number) => boolean): number {
	assertIterable('countItems', iterable);
	if (predicate !== undefined) assertFunction('countItems', 'predicate', predicate);
	let total = 0;
	let index = 0;
	for (const value of iterable) if (predicate === undefined || predicate(value, index++)) total++;
	return total;
}

// ---------------------------------------------------------------------------------------------------------------------
// Async (inputs may be async iterables, or sync iterables of values and/or promises; items are processed one at a time)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The async generator behind {@link mapAsync} (the arguments are already validated).
 * @template T
 * @template U
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => U | PromiseLike<U>} fn - Maps an item (and its index)
 * @returns {AsyncGenerator<U, void, undefined>} An async generator of the mapped items
 */
async function* mappedAsync<T, U>(iterable: AwaitableIterable<T>, fn: (value: T, index: number) => U | PromiseLike<U>): AsyncGenerator<U, void, undefined> {
	let index = 0;
	// `yield` awaits the mapped value (a rejection is thrown inside the loop, closing the source).
	for await (const value of awaitItems(iterable)) yield fn(value, index++);
}

/**
 * Lazily transform each item of an async (or sync) iterable with a possibly async function, one item at a time.
 * @template T
 * @template U
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => U | PromiseLike<U>} fn - Maps an item (and its index) to the output item
 * @returns {AsyncIterableIterator<U>} An async iterator of the mapped items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, or `fn` is not a function
 * @example
 * await toArrayAsync(mapAsync([1, 2], async function (n) { return n * 2; })); // => [2, 4]
 */
export function mapAsync<T, U>(iterable: AwaitableIterable<T>, fn: (value: T, index: number) => U | PromiseLike<U>): AsyncIterableIterator<U> {
	assertAwaitableIterable('mapAsync', iterable);
	assertFunction('mapAsync', 'fn', fn);
	return mappedAsync(iterable, fn);
}

/**
 * The async generator behind {@link filterAsync} (the arguments are already validated).
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean | PromiseLike<boolean>} predicate - Decides which items to keep
 * @returns {AsyncGenerator<T, void, undefined>} An async generator of the kept items
 */
async function* filteredAsync<T>(iterable: AwaitableIterable<T>, predicate: (value: T, index: number) => boolean | PromiseLike<boolean>): AsyncGenerator<T, void, undefined> {
	let index = 0;
	for await (const value of awaitItems(iterable)) if (await predicate(value, index++)) yield value;
}

/**
 * Lazily keep the items of an async (or sync) iterable matching a (sync) type guard, narrowing the item type.
 * @template T
 * @template S
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => value is S} predicate - Type guard deciding which items to keep
 * @returns {AsyncIterableIterator<S>} An async iterator of the kept items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, or `predicate` is not a function
 * @example
 * await toArrayAsync(filterAsync([1, 'a'], function (v): v is number { return typeof v === 'number'; })); // => [1]
 */
export function filterAsync<T, S extends T>(iterable: AwaitableIterable<T>, predicate: (value: T, index: number) => value is S): AsyncIterableIterator<S>;
/**
 * Lazily keep the items of an async (or sync) iterable matching a possibly async predicate, one item at a time.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean | PromiseLike<boolean>} predicate - Decides which items to keep
 * @returns {AsyncIterableIterator<T>} An async iterator of the kept items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, or `predicate` is not a function
 * @example
 * await toArrayAsync(filterAsync([1, 2, 3], async function (n) { return n > 1; })); // => [2, 3]
 */
export function filterAsync<T>(iterable: AwaitableIterable<T>, predicate: (value: T, index: number) => boolean | PromiseLike<boolean>): AsyncIterableIterator<T>;
/**
 * Lazily keep the items of an async (or sync) iterable matching a possibly async predicate, one item at a time.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number) => boolean | PromiseLike<boolean>} predicate - Decides which items to keep
 * @returns {AsyncIterableIterator<T>} An async iterator of the kept items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, or `predicate` is not a function
 * @example
 * await toArrayAsync(filterAsync([1, 2, 3], async function (n) { return n > 1; })); // => [2, 3]
 */
export function filterAsync<T>(iterable: AwaitableIterable<T>, predicate: (value: T, index: number) => boolean | PromiseLike<boolean>): AsyncIterableIterator<T> {
	assertAwaitableIterable('filterAsync', iterable);
	assertFunction('filterAsync', 'predicate', predicate);
	return filteredAsync(iterable, predicate);
}

/**
 * The async generator behind {@link takeAsync} (the arguments are already validated).
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {number} n - How many items to take
 * @returns {AsyncGenerator<T, void, undefined>} An async generator of the first items
 */
async function* takenAsync<T>(iterable: AwaitableIterable<T>, n: number): AsyncGenerator<T, void, undefined> {
	if (n === 0) return;
	let taken = 0;
	for await (const value of awaitItems(iterable)) {
		yield value;
		if (++taken >= n) return;
	}
}

/**
 * Lazily yield the first `n` items of an async (or sync) iterable; exactly `n` items are pulled, then the source is closed.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {number} n - How many items to take (a non-negative integer, or `Infinity` for all of them)
 * @returns {AsyncIterableIterator<T>} An async iterator of at most `n` items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable
 * @throws {RangeError} when `n` is negative, `NaN` or a non-integer finite number
 * @throws {TypeError} when `n` is not a number
 * @example
 * await toArrayAsync(takeAsync(count(), 2)); // => [0, 1]
 */
export function takeAsync<T>(iterable: AwaitableIterable<T>, n: number): AsyncIterableIterator<T> {
	assertAwaitableIterable('takeAsync', iterable);
	assertInteger('takeAsync', 'n', n, 0, true);
	return takenAsync(iterable, n);
}

/**
 * The async generator behind {@link chunkAsync} (the arguments are already validated).
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {number} size - The maximum length of each chunk
 * @returns {AsyncGenerator<T[], void, undefined>} An async generator of the chunks
 */
async function* chunkedAsync<T>(iterable: AwaitableIterable<T>, size: number): AsyncGenerator<T[], void, undefined> {
	let buffer: T[] = [];
	for await (const value of awaitItems(iterable)) {
		buffer.push(value);
		if (buffer.length === size) {
			const full = buffer;
			buffer = [];
			yield full;
		}
	}
	if (buffer.length > 0) yield buffer;
}

/**
 * Lazily split an async (or sync) iterable into consecutive chunks of `size` items; only the last chunk may be shorter.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {number} size - The maximum length of each chunk (a positive integer)
 * @returns {AsyncIterableIterator<T[]>} An async iterator of fresh chunk arrays
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable
 * @throws {RangeError} when `size` is not a positive integer
 * @throws {TypeError} when `size` is not a number
 * @example
 * await toArrayAsync(chunkAsync([1, 2, 3], 2)); // => [[1, 2], [3]]
 */
export function chunkAsync<T>(iterable: AwaitableIterable<T>, size: number): AsyncIterableIterator<T[]> {
	assertAwaitableIterable('chunkAsync', iterable);
	assertInteger('chunkAsync', 'size', size, 1);
	return chunkedAsync(iterable, size);
}

/**
 * Options accepted by {@link mapConcurrent}.
 */
export interface MapConcurrentOptions {
	/**
	 * Maximum number of items pulled from the source but not yet consumed: mapping in flight, or mapped and waiting to be read (an
	 * integer >= 1, or `Infinity` to disable backpressure).
	 */
	concurrency: number;
	/** `true` (the default): yield results in source order. `false`: yield each result as soon as it is ready. */
	ordered?: boolean;
	/**
	 * Aborting it stops pulling from the source, which is closed, and makes the iterator throw the signal's `reason` (or an `AbortError`)
	 * at its next read. It is also passed to `fn` as its third argument.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * An item pulled by {@link mapConcurrent}: pending until its mapping settles, then its outcome.
 */
interface MappedSlot {
	settled: boolean;
	ok: boolean;
	result: unknown;
}

/**
 * The async generator behind {@link mapConcurrent} (the arguments are already validated).
 * @param {AwaitableIterable<unknown>} iterable - The source items
 * @param {(value: unknown, index: number, signal: AbortSignalLike | undefined) => unknown} fn - Maps an item
 * @param {number} concurrency - The read-ahead limit
 * @param {boolean} ordered - Whether results keep source order
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {AsyncGenerator<unknown, void, undefined>} An async generator of the mapped items
 */
async function* mappedConcurrently(
	iterable: AwaitableIterable<unknown>,
	fn: (value: unknown, index: number, signal: AbortSignalLike | undefined) => unknown,
	concurrency: number,
	ordered: boolean,
	signal: AbortSignalLike | undefined
): AsyncGenerator<unknown, void, undefined> {
	// Sync iterables always get the wrapper, which closes them on early exit and awaits their items.
	const source = (isAsyncIterable(iterable) ? iterable : awaitedItems(iterable))[Symbol.asyncIterator]();
	// Pulled items not yet yielded: in source order when `ordered`, otherwise in the order they settled.
	const slots: MappedSlot[] = [];
	let buffered = 0;
	let index = 0;
	let pulling = false;
	let exhausted = false;
	let stopped = false;
	let sourceError: { error: unknown } | undefined;
	let abortedWith: { reason: unknown } | undefined;
	let wakeUp: (() => void) | undefined;

	/**
	 * Wakes the consumer loop up, if it is waiting.
	 * @returns {void}
	 */
	function notify(): void {
		const resume = wakeUp;

		wakeUp = undefined;
		resume?.();
	}

	/**
	 * Records the outcome of a mapping and wakes the consumer up.
	 * @param {MappedSlot} slot - The item's slot
	 * @param {boolean} ok - Whether the mapping succeeded
	 * @param {unknown} result - The mapped value or the error
	 * @returns {void}
	 */
	function settle(slot: MappedSlot, ok: boolean, result: unknown): void {
		slot.settled = true;
		slot.ok = ok;
		slot.result = result;
		if (!ordered) slots.push(slot);
		notify();
	}

	/**
	 * Pulls the next item, unless the read-ahead limit is reached, a pull is already pending, or the source is done.
	 * @returns {void}
	 */
	function fill(): void {
		if (pulling || exhausted || stopped || buffered >= concurrency) return;
		pulling = true;

		let pull: Promise<IteratorResult<unknown>>;

		// A hand-written source may throw from `next()` or return a plain result: treated like `for await` does.
		try {
			pull = Promise.resolve(source.next());
		} catch (error) {
			pull = Promise.reject(error);
		}
		pull.then(function (step) {
			let done: unknown;
			let item: unknown;

			// The result is read like `for await` reads it: a non-object, or a `done` / `value` getter that throws, is the source failing.
			try {
				if (typeof step !== 'object' || step === null) throw new TypeError(`mapConcurrent: iterator result ${describe(step)} is not an object`);
				done = step.done;
				if (!done) item = step.value;
			} catch (error) {
				failSource(error);
				return;
			}
			pulling = false;
			if (done) {
				exhausted = true;
			} else if (!stopped) {
				const slot: MappedSlot = { settled: false, ok: false, result: undefined };
				let outcome: unknown;

				buffered++;
				if (ordered) slots.push(slot);
				try {
					outcome = fn(item, index++, signal);
				} catch (error) {
					outcome = Promise.reject(error);
				}
				Promise.resolve(outcome).then(
					function (value) {
						settle(slot, true, value);
					},
					function (error: unknown) {
						settle(slot, false, error);
					}
				);
				fill();
			}
			notify();
		}, failSource);
	}

	/**
	 * Records a failure of the source (it is not closed then) and wakes the consumer up, which throws it.
	 * @param {unknown} error - The error
	 * @returns {void}
	 */
	function failSource(error: unknown): void {
		pulling = false;
		exhausted = true;
		sourceError = { error };
		notify();
	}

	/**
	 * Abort listener: stops pulling and wakes the consumer up, which then throws the reason.
	 * @returns {void}
	 */
	function onAbort(): void {
		stopped = true;
		// Kept here rather than read back from `signal.aborted`, which a signal-like object may not have updated.
		abortedWith ??= { reason: abortReason(signal as AbortSignalLike) };
		notify();
	}

	let failed = false;

	try {
		// Inside the `try`: when adding the listener throws, the source opened above is still closed.
		signal?.addEventListener('abort', onAbort);
		for (;;) {
			if (abortedWith !== undefined) throw abortedWith.reason;
			if (signal?.aborted) throw abortReason(signal);
			fill();

			const slot = slots[0];

			if (slot?.settled) {
				slots.shift();
				buffered--;
				// A failed mapping ends the iteration: throw before `fill` would pull another item.
				if (!slot.ok) throw slot.result;
				fill();
				yield slot.result;
			} else if (exhausted && buffered === 0) {
				if (sourceError) throw sourceError.error;
				return;
			} else {
				await new Promise<void>(function (resolve) {
					wakeUp = resolve;
				});
			}
		}
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		stopped = true;
		detach(signal, onAbort);
		// Close the source unless it finished or failed on its own. An async generator answers a pending pull before `return()`, which
		// may never happen (an idle stream): the close is then requested without waiting for it, so that the consumer is not blocked.
		// When the iteration fails, a failure to close is ignored so that the original error comes out (like `for await`).
		if (!exhausted) {
			if (pulling) closeLater(source);
			else if (failed) await closeQuietly(source);
			else await source.return?.();
		}
	}
}

/**
 * Closes an async iterator and waits for it, ignoring a failure to close (see {@link mapConcurrent}).
 * @param {AsyncIterator<unknown>} source - The iterator to close
 * @returns {Promise<void>} Settles once the iterator is closed
 */
async function closeQuietly(source: AsyncIterator<unknown>): Promise<void> {
	try {
		await source.return?.();
	} catch {
		// The error the iteration failed with is the one reported.
	}
}

/**
 * Requests that an async iterator close, without waiting for it (see {@link mapConcurrent}). A failure to close is ignored, like the
 * outcome of a pull nobody waits for any more.
 * @param {AsyncIterator<unknown>} source - The iterator to close
 * @returns {void}
 */
function closeLater(source: AsyncIterator<unknown>): void {
	try {
		Promise.resolve(source.return?.()).then(undefined, ignore);
	} catch {
		// A synchronously throwing `return()`: nothing is waiting for it either.
	}
}

/**
 * Ignores a rejection.
 * @returns {undefined} Always `undefined`
 */
function ignore(): undefined {
	return undefined;
}

/**
 * Lazily maps an async (or sync) iterable with a possibly async `fn`, running up to `concurrency` mappings at the same time: the
 * streaming counterpart of `mapWithConcurrency` (from the async module), for sources too large or too slow to collect first.
 *
 * - Backpressure: at most `concurrency` items are pulled ahead of the consumer (mapping, or mapped and waiting to be read), and the
 *   source is pulled one item at a time, so a slow consumer slows the source down instead of buffering it.
 * - Order: results come in source order by default; with `ordered: false` each comes as soon as it is ready.
 * - Errors: an error of `fn` is thrown when its result would have been yielded (in order) or as soon as it happens (unordered); an error
 *   of the source is thrown after the items pulled before it. The source is then closed and nothing more is pulled.
 * - Early exit (`break`, `return()`, an error) stops pulling and calls the source's `return()`, waiting for it unless a pull is still
 *   pending (an async generator only closes once that pull is answered, which an idle source may never do). Mappings already running are
 *   not interrupted (their results are dropped, and their rejections handled), so pass `signal` to `fn` to cancel them.
 * - `signal`: aborting stops pulling and makes the iterator throw the signal's `reason` at its next read, closing the source.
 * @template T - The source item type
 * @template U - The mapped item type
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {(value: T, index: number, signal: AbortSignalLike | undefined) => U | PromiseLike<U>} fn - Maps an item (with its index and the signal)
 * @param {number | MapConcurrentOptions} options - The concurrency, or `{ concurrency, ordered, signal }`
 * @returns {AsyncIterableIterator<U>} An async iterator of the mapped items
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, `fn` is not a function, `concurrency` is not a number, or `signal` is not a signal
 * @throws {RangeError} when `concurrency` is not an integer >= 1 or `Infinity`
 * @example
 * async function double(n: number): Promise<number> { await new Promise(function (resolve) { setTimeout(resolve, 10 - n); }); return n * 2; }
 * await toArrayAsync(mapConcurrent([1, 2, 3, 4], double, 2)); // => [2, 4, 6, 8]
 * @example
 * // Unordered, stopping early: the source is closed and nothing more is pulled
 * for await (const size of mapConcurrent(count(1), async function (n) { return n * 10; }, { concurrency: 4, ordered: false })) {
 *   if (size >= 30) break;
 * }
 */
export function mapConcurrent<T, U>(
	iterable: AwaitableIterable<T>,
	fn: (value: T, index: number, signal: AbortSignalLike | undefined) => U | PromiseLike<U>,
	options: number | MapConcurrentOptions
): AsyncIterableIterator<U> {
	// Read as own properties: a polluted `Object.prototype` must not inject a signal, an order or a concurrency.
	const settings = typeof options === 'object' && options !== null ? options : undefined;
	const concurrency = (settings === undefined ? options : readOption(settings, 'concurrency')) as number;
	const ordered = settings === undefined || readOption(settings, 'ordered', true);
	const signal = settings === undefined ? undefined : readOption(settings, 'signal');

	assertAwaitableIterable('mapConcurrent', iterable);
	assertFunction('mapConcurrent', 'fn', fn);
	assertInteger('mapConcurrent', 'concurrency', concurrency, 1, true);
	assertOptionalSignal('mapConcurrent', 'signal', signal);

	return mappedConcurrently(
		iterable,
		fn as (value: unknown, index: number, signal: AbortSignalLike | undefined) => unknown,
		concurrency,
		ordered,
		signal ?? undefined
	) as AsyncIterableIterator<U>;
}

/**
 * The reason a signal was aborted with, or a fresh `AbortError` when it has none.
 * @param {AbortSignalLike} signal - An aborted signal
 * @returns {unknown} The rejection reason
 */
function abortReason(signal: AbortSignalLike): unknown {
	return reasonOf(signal, createAbortError);
}

/**
 * Creates the reason of a signal aborted without one.
 * @returns {AbortError} A new `AbortError`
 */
function createAbortError(): AbortError {
	return new AbortError();
}

/**
 * The async function behind {@link toArrayAsync} (the argument is already validated).
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @returns {Promise<T[]>} A promise of a new array with every (awaited) item
 */
async function collect<T>(iterable: AwaitableIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const value of awaitItems(iterable)) result.push(value);
	return result;
}

/**
 * Collect the items of an async (or sync) iterable into a new array, awaiting each item in turn (like `Array.fromAsync`).
 * Argument errors are thrown synchronously; errors from the source reject the returned promise.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @returns {Promise<T[]>} A promise of a new array with every (awaited) item
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable
 * @example
 * await toArrayAsync(mapAsync([1, 2], function (n) { return n + 1; })); // => [2, 3]
 * await toArrayAsync([Promise.resolve(1), 2]); // => [1, 2]
 */
export function toArrayAsync<T>(iterable: AwaitableIterable<T>): Promise<T[]> {
	assertAwaitableIterable('toArrayAsync', iterable);
	return collect(iterable);
}

// ---------------------------------------------------------------------------------------------------------------------
// More sync helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The generator behind {@link interleave} (the arguments are already validated).
 * @template T
 * @param {T} iterables - The iterables to interleave
 * @returns {Generator<ZippedValues<T>[number], void, undefined>} A generator of the items, in round-robin order
 */
function* interleaved<T extends Array<Iterable<unknown>>>(iterables: T): Generator<ZippedValues<T>[number], void, undefined> {
	// The iterators still running: an exhausted one is removed, so that it is skipped and never closed.
	const iterators: Array<Iterator<unknown>> = [];
	// Index of the iterator being advanced: when it throws, it must not be closed.
	let current = -1;
	let threw = false;
	try {
		for (const iterable of iterables) {
			const iterator: unknown = iterable[Symbol.iterator]();

			if (typeof iterator !== 'object' || iterator === null) throw new TypeError(`interleave: an iterator must be an object, got ${describe(iterator)}`);
			iterators.push(iterator as Iterator<unknown>);
		}
		let index = 0;
		while (iterators.length > 0) {
			if (index >= iterators.length) index = 0;
			current = index;
			const result = stepOf('interleave', iterators[index].next());
			if (result.done) {
				iterators.splice(index, 1);
			} else {
				const value = result.value;
				current = -1;
				index++;
				yield value as ZippedValues<T>[number];
			}
		}
	} catch (error) {
		threw = true;
		throw error;
	} finally {
		closeIterators(iterators, current, threw);
	}
}

/**
 * Lazily take one item from each iterable in turn (round-robin): `a1, b1, c1, a2, b2, c2, ...`. An exhausted iterable is skipped and
 * the others go on, so every item of every iterable comes out exactly once (infinite iterables are fine: the others are not starved).
 * When iteration stops early (or an iterable throws), the iterables still running are closed.
 * @template T
 * @param {...Iterable<unknown>} iterables - The iterables to interleave
 * @returns {IterableIterator<ZippedValues<T>[number]>} An iterator of all the items; empty when called without iterables
 * @throws {TypeError} when an argument is not iterable
 * @example
 * toArray(interleave([1, 2, 3], 'ab', [true])); // => [1, 'a', true, 2, 'b', 3] // typed as (number | string | boolean)[]
 * toArray(take(interleave(count(), repeatValue('x')), 4)); // => [0, 'x', 1, 'x']
 */
export function interleave<T extends Array<Iterable<unknown>>>(...iterables: T): IterableIterator<ZippedValues<T>[number]> {
	for (const iterable of iterables) assertIterable('interleave', iterable, 'iterables');
	return interleaved(iterables);
}

/**
 * The generator behind {@link pairwise} (the argument is already validated).
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {Generator<[T, T], void, undefined>} A generator of the pairs
 */
function* pairs<T>(iterable: Iterable<T>): Generator<[T, T], void, undefined> {
	let previous: T | undefined;
	let started = false;
	for (const value of iterable) {
		if (started) yield [previous as T, value];
		previous = value;
		started = true;
	}
}

/**
 * Lazily yield each item with the next one: `[a, b], [b, c], [c, d], ...` (one pair fewer than items; none for fewer than two items).
 * Each pair is a fresh array. Same as `windowed(iterable, 2)`, typed as a tuple.
 * @template T
 * @param {Iterable<T>} iterable - The source items
 * @returns {IterableIterator<[T, T]>} An iterator of the consecutive pairs
 * @throws {TypeError} when `iterable` is not iterable
 * @example
 * toArray(pairwise([1, 2, 4, 7])); // => [[1, 2], [2, 4], [4, 7]]
 * toArray(pairwise([1])); // => []
 */
export function pairwise<T>(iterable: Iterable<T>): IterableIterator<[T, T]> {
	assertIterable('pairwise', iterable);
	return pairs(iterable);
}

/**
 * Split the items of an iterable in two with a type guard: the items it accepts (narrowed) and the others. Order is preserved.
 * @template T
 * @template S
 * @param {Iterable<T>} iterable - The source items (consumed entirely)
 * @param {(value: T, index: number) => value is S} predicate - Type guard deciding which side an item goes to
 * @returns {[S[], Exclude<T, S>[]]} `[matching, rest]`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * partition(new Set([1, 'a', 2]), function (v): v is number { return typeof v === 'number'; }); // => [[1, 2], ['a']]
 */
export function partition<T, S extends T>(iterable: Iterable<T>, predicate: (value: T, index: number) => value is S): [S[], Exclude<T, S>[]];
/**
 * Split the items of an iterable in two: those for which `predicate` returns `true`, and the others. Order is preserved.
 * @template T
 * @param {Iterable<T>} iterable - The source items (consumed entirely)
 * @param {(value: T, index: number) => boolean} predicate - Decides which side an item goes to
 * @returns {[T[], T[]]} `[matching, rest]`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * partition(take(count(1), 5), function (n) { return n % 2 === 0; }); // => [[2, 4], [1, 3, 5]]
 */
export function partition<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): [T[], T[]];
/**
 * Split the items of an iterable in two: those for which `predicate` returns `true`, and the others. Order is preserved.
 * @template T
 * @param {Iterable<T>} iterable - The source items (consumed entirely)
 * @param {(value: T, index: number) => boolean} predicate - Decides which side an item goes to
 * @returns {[T[], T[]]} `[matching, rest]`
 * @throws {TypeError} when `iterable` is not iterable or `predicate` is not a function
 * @example
 * partition([1, 2, 3, 4], function (n) { return n > 2; }); // => [[3, 4], [1, 2]]
 */
export function partition<T>(iterable: Iterable<T>, predicate: (value: T, index: number) => boolean): [T[], T[]] {
	assertIterable('partition', iterable);
	assertFunction('partition', 'predicate', predicate);
	const matching: T[] = [];
	const rest: T[] = [];
	let index = 0;
	for (const value of iterable) {
		if (predicate(value, index++)) matching.push(value);
		else rest.push(value);
	}
	return [matching, rest];
}

// ---------------------------------------------------------------------------------------------------------------------
// Async combinators
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The union of the item types of a tuple of {@link AwaitableIterable}s, as produced by {@link mergeAsync}.
 * @example
 * type R = MergedValue<[AsyncIterable<number>, Array<Promise<string>>]>; // number | string
 */
export type MergedValue<T extends ReadonlyArray<AwaitableIterable<unknown>>> = T[number] extends infer S
	? S extends AsyncIterable<infer U>
		? U
		: S extends Iterable<infer U>
			? Awaited<U>
			: never
	: never;

/** {@link mergeAsync}: a `next()` of the source is pending (a source with no state yet, or whose value was handed out, is idle). */
const PULLING = 1;
/** {@link mergeAsync}: the source delivered a value that is waiting to be yielded. */
const BUFFERED = 2;
/** {@link mergeAsync}: the source ended or failed on its own (it is not closed). */
const FINISHED = 3;
/** {@link mergeAsync}: the last value of the source was handed out, and it was not pulled again yet. */
const HANDED_OUT = 0;

/**
 * A result delivered by a source of {@link mergeAsync}, in arrival order.
 */
interface Arrival {
	index: number;
	ok: boolean;
	value: unknown;
}

/**
 * The async generator behind {@link mergeAsync} (the arguments are already validated).
 * @param {ReadonlyArray<AwaitableIterable<unknown>>} sources - The sources
 * @returns {AsyncGenerator<unknown, void, undefined>} An async generator of the values, in arrival order
 */
async function* merged(sources: ReadonlyArray<AwaitableIterable<unknown>>): AsyncGenerator<unknown, void, undefined> {
	const iterators: Array<AsyncIterator<unknown>> = [];
	const states: number[] = [];
	const arrivals: Arrival[] = [];
	// Sources not finished: a failed one still counts, its error being among the arrivals, thrown before the end is noticed.
	let running = 0;
	let wakeUp: () => void = ignore;

	/**
	 * Wakes the consumer loop up, if it is waiting.
	 * @returns {void}
	 */
	function notify(): void {
		const resume = wakeUp;

		wakeUp = ignore;
		resume();
	}

	/**
	 * Records what a source delivered and wakes the consumer up (once the merge is over, nobody reads it any more).
	 * @param {number} index - The source
	 * @param {boolean} ok - Whether it delivered a value (`false`: it failed)
	 * @param {unknown} value - The value or the error
	 * @returns {void}
	 */
	function arrive(index: number, ok: boolean, value: unknown): void {
		states[index] = ok ? BUFFERED : FINISHED;
		arrivals.push({ index, ok, value });
		notify();
	}

	/**
	 * Requests the next value of a source.
	 * @param {number} index - The source
	 * @returns {void}
	 */
	function pull(index: number): void {
		states[index] = PULLING;

		let step: Promise<IteratorResult<unknown>>;

		// A hand-written source may throw from `next()` or return a plain result: treated like `for await` does.
		try {
			step = Promise.resolve(iterators[index].next());
		} catch (error) {
			step = Promise.reject(error);
		}
		step.then(
			function (result) {
				let done: unknown;
				let value: unknown;

				// Read like `for await` reads it: a non-object, or a `done` / `value` getter that throws, is the source failing.
				try {
					if (typeof result !== 'object' || result === null) throw new TypeError(`mergeAsync: iterator result ${describe(result)} is not an object`);
					done = result.done;
					if (!done) value = result.value;
				} catch (error) {
					arrive(index, false, error);
					return;
				}
				if (!done) {
					arrive(index, true, value);
				} else {
					states[index] = FINISHED;
					running--;
					notify();
				}
			},
			function (error: unknown) {
				arrive(index, false, error);
			}
		);
	}

	let failed = false;

	try {
		for (const source of sources) {
			// Sync iterables get the wrapper, which awaits their items and closes them on early exit.
			iterators.push((isAsyncIterable(source) ? source : awaitedItems(source))[Symbol.asyncIterator]());
			running++;
		}
		for (let index = 0; index < iterators.length; index++) pull(index);
		for (;;) {
			const arrival = arrivals.shift();

			if (arrival !== undefined) {
				if (!arrival.ok) throw arrival.value;
				states[arrival.index] = HANDED_OUT;
				yield arrival.value;
				// Pulled again only once its value was consumed: at most one value per source is buffered.
				pull(arrival.index);
			} else if (running === 0) {
				return;
			} else {
				await new Promise<void>(function (resolve) {
					wakeUp = resolve;
				});
			}
		}
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		await closeSources(iterators, states, failed);
	}
}

/**
 * Closes the sources of {@link mergeAsync} that are still open: those with a pending `next()` without waiting (an async generator only
 * closes once that pull is answered), the others in parallel, waiting for them.
 * @param {ReadonlyArray<AsyncIterator<unknown>>} iterators - The sources
 * @param {ReadonlyArray<number>} states - Their states
 * @param {boolean} failed - Whether the merge is failing (a failure to close is then ignored, like `for await` does)
 * @returns {Promise<void>} Settles once the sources are closed
 * @throws {unknown} the first error of a `return()` call (in source order), unless `failed`
 */
async function closeSources(iterators: ReadonlyArray<AsyncIterator<unknown>>, states: ReadonlyArray<number>, failed: boolean): Promise<void> {
	const closing: Array<Promise<unknown>> = [];

	for (let index = 0; index < iterators.length; index++) {
		const state = states[index];

		if (state === PULLING) {
			closeLater(iterators[index]);
		} else if (state !== FINISHED) {
			try {
				closing.push(Promise.resolve(iterators[index].return?.()));
			} catch (error) {
				closing.push(Promise.reject(error));
			}
		}
	}
	// `allSettled`: every close is waited for, and no rejection is left unhandled.
	for (const outcome of await Promise.allSettled(closing)) {
		if (outcome.status === 'rejected' && !failed) throw outcome.reason;
	}
}

/**
 * Merges several async (or sync) iterables into one, yielding their values as they arrive (the first to settle comes first). Each source
 * has at most one `next()` pending at a time and is pulled again only once its previous value has been consumed, so at most one value per
 * source is buffered and a slow consumer slows every source down. Sync iterables may hold promises, which are awaited.
 *
 * - It ends once every source has ended (and is empty without sources).
 * - An error of a source is thrown in arrival order (after the values that arrived before it); the other sources are then closed.
 * - Early exit (`break`, `return()`, an error) calls `return()` on every source still open: waiting for those that are idle, and
 *   requesting it without waiting from those with a pending `next()` (an async generator only closes once that pull settles, which an
 *   idle source may never do). Values or errors arriving afterwards are dropped (and their rejections handled). Like any async
 *   generator, a `return()` called while a `next()` is pending only runs once that `next()` settles (when some source delivers): there
 *   is no `signal`, so to stop idle sources at once, give each one its own way to be aborted.
 * @template T
 * @param {...AwaitableIterable<unknown>} sources - The iterables to merge
 * @returns {AsyncIterableIterator<MergedValue<T>>} An async iterator of every value of every source, in arrival order
 * @throws {TypeError} when an argument is neither async iterable nor iterable
 * @example
 * import { sleep } from 'tinkit/async';
 * async function* ticks(name: string, ms: number): AsyncGenerator<string> { for (let i = 0; i < 2; i++) { await sleep(ms); yield name + i; } }
 * await toArrayAsync(mergeAsync(ticks('slow', 80), ticks('fast', 10))); // => ['fast0', 'fast1', 'slow0', 'slow1']
 */
export function mergeAsync<T extends Array<AwaitableIterable<unknown>>>(...sources: T): AsyncIterableIterator<MergedValue<T>> {
	for (const source of sources) {
		if (!isAsyncIterable(source) && !isIterable(source)) throw new TypeError(`mergeAsync: \`sources\` must be iterable, got ${describe(source)}`);
	}
	return merged(sources) as AsyncIterableIterator<MergedValue<T>>;
}

/**
 * Options accepted by {@link bufferTime}.
 */
export interface BufferTimeOptions {
	/** Largest batch (an integer >= 1, or `Infinity`, the default): a batch that reaches it is flushed at once. */
	maxSize?: number;
	/**
	 * Aborting it stops pulling from the source, which is closed, and makes the iterator throw the signal's `reason` (or an `AbortError`)
	 * at its next read.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * The async generator behind {@link bufferTime} (the arguments are already validated).
 * @param {AwaitableIterable<unknown>} iterable - The source items
 * @param {number} ms - The time window of a batch
 * @param {number} maxSize - The largest batch
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {AsyncGenerator<unknown[], void, undefined>} An async generator of the batches
 */
async function* batchedByTime(
	iterable: AwaitableIterable<unknown>,
	ms: number,
	maxSize: number,
	signal: AbortSignalLike | undefined
): AsyncGenerator<unknown[], void, undefined> {
	const source = (isAsyncIterable(iterable) ? iterable : awaitedItems(iterable))[Symbol.asyncIterator]();
	// Batches closed (full, timed out, or at the end) but not yet yielded: at most one while the consumer is busy with another, since
	// nothing more is pulled then.
	const ready: unknown[][] = [];
	let batch: unknown[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pulling = false;
	let exhausted = false;
	let stopped = false;
	let sourceError: { error: unknown } | undefined;
	let abortedWith: { reason: unknown } | undefined;
	let wakeUp: () => void = ignore;

	/**
	 * Wakes the consumer loop up, if it is waiting.
	 * @returns {void}
	 */
	function notify(): void {
		const resume = wakeUp;

		wakeUp = ignore;
		resume();
	}

	/**
	 * Closes the current batch (when it has items) and stops its timer.
	 * @returns {void}
	 */
	function flush(): void {
		clearTimeout(timer);
		timer = undefined;
		if (batch.length > 0) {
			ready.push(batch);
			batch = [];
		}
	}

	/**
	 * The timer of the current batch fired.
	 * @returns {void}
	 */
	function onTimer(): void {
		flush();
		notify();
	}

	/**
	 * Records a failure of the source (it is not closed then) and wakes the consumer up, which yields the last batch and then throws it
	 * (once the iteration is over, nobody reads it any more).
	 * @param {unknown} error - The error
	 * @returns {void}
	 */
	function failSource(error: unknown): void {
		exhausted = true;
		sourceError = { error };
		flush();
		notify();
	}

	/**
	 * Requests the next item of the source.
	 * @returns {void}
	 */
	function pull(): void {
		pulling = true;

		let step: Promise<IteratorResult<unknown>>;

		try {
			step = Promise.resolve(source.next());
		} catch (error) {
			step = Promise.reject(error);
		}
		step.then(function (result) {
			let done: unknown;
			let value: unknown;

			try {
				if (typeof result !== 'object' || result === null) throw new TypeError(`bufferTime: iterator result ${describe(result)} is not an object`);
				done = result.done;
				if (!done) value = result.value;
			} catch (error) {
				failSource(error);
				return;
			}
			if (stopped) return;
			pulling = false;
			if (done) {
				exhausted = true;
				flush();
			} else {
				batch.push(value);
				if (batch.length >= maxSize) flush();
				// The window of a batch opens with its first item.
				else if (batch.length === 1 && ms !== Infinity) timer = setTimeout(onTimer, ms);
			}
			notify();
		}, failSource);
	}

	/**
	 * Abort listener: wakes the consumer up, which then throws the reason.
	 * @returns {void}
	 */
	function onAbort(): void {
		// Kept here rather than read back from `signal.aborted`, which a signal-like object may not have updated.
		abortedWith ??= { reason: abortReason(signal as AbortSignalLike) };
		notify();
	}

	let failed = false;

	try {
		signal?.addEventListener('abort', onAbort);
		for (;;) {
			if (abortedWith !== undefined) throw abortedWith.reason;
			if (signal?.aborted) throw abortReason(signal);

			const next = ready.shift();

			if (next !== undefined) {
				yield next;
			} else if (exhausted) {
				if (sourceError !== undefined) throw sourceError.error;
				return;
			} else {
				if (!pulling) pull();
				await new Promise<void>(function (resolve) {
					wakeUp = resolve;
				});
			}
		}
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		stopped = true;
		clearTimeout(timer);
		detach(signal, onAbort);
		// As in `mapConcurrent`: close the source unless it finished or failed, without waiting when a pull is pending.
		if (!exhausted) {
			if (pulling) closeLater(source);
			else if (failed) await closeQuietly(source);
			else await source.return?.();
		}
	}
}

/**
 * Lazily groups the items of an async (or sync) iterable into batches by time: a batch opens with its first item and is flushed `ms`
 * milliseconds later, or as soon as it holds `maxSize` items, whichever comes first (the timer then restarts with the next item, so an
 * idle source produces no batches: a batch is never empty). The items left at the end are flushed as a last batch.
 *
 * - Pulling: the source is read one item at a time while the consumer waits for a batch; while a ready batch waits to be read, at most
 *   one more item is read into the next one, so a slow consumer slows the source down. A batch whose time is up while the consumer is
 *   busy is yielded at its next read.
 * - Errors: an error of the source is thrown after the batch of the items read before it.
 * - Early exit (`break`, `return()`, an error, an abort) clears the timer and closes the source, like {@link mapConcurrent} does. Like
 *   any async generator, a `return()` called while a `next()` is pending only runs once that `next()` settles (a batch, the end, or an
 *   error): abort `signal` to stop at once while the source is idle.
 * @template T
 * @param {AwaitableIterable<T>} iterable - The source items
 * @param {number} ms - How long a batch stays open, from its first item (0 to 2 ** 31 - 1, or `Infinity` to batch by `maxSize` only)
 * @param {BufferTimeOptions} [options] - `maxSize` and `signal`
 * @returns {AsyncIterableIterator<T[]>} An async iterator of non-empty batches (fresh arrays)
 * @throws {TypeError} when `iterable` is neither async iterable nor iterable, `options` is not an object, `ms` or `maxSize` is not a number, or `signal` is not a signal
 * @throws {RangeError} when `ms` is negative or too large, or `maxSize` is not an integer >= 1 or `Infinity`
 * @example
 * await toArrayAsync(bufferTime([1, 2, 3, 4, 5], 1000, { maxSize: 2 })); // => [[1, 2], [3, 4], [5]]
 * @example
 * import { sleep } from 'tinkit/async';
 * async function* bursts(): AsyncGenerator<number> { yield 1; yield 2; await sleep(100); yield 3; }
 * await toArrayAsync(bufferTime(bursts(), 20)); // => [[1, 2], [3]]
 */
export function bufferTime<T>(iterable: AwaitableIterable<T>, ms: number, options?: BufferTimeOptions): AsyncIterableIterator<T[]> {
	assertAwaitableIterable('bufferTime', iterable);
	assertDelay('bufferTime', 'ms', ms, true);
	const settings = optionsOf('bufferTime', options);
	const maxSize = readOption(settings, 'maxSize', Infinity);
	const signal = readOption(settings, 'signal');
	assertInteger('bufferTime', 'maxSize', maxSize, 1, true);
	assertOptionalSignal('bufferTime', 'signal', signal);
	return batchedByTime(iterable, ms, maxSize, signal ?? undefined) as AsyncIterableIterator<T[]>;
}

/**
 * Returns the options object of a function, or an empty one when it is `undefined`.
 * @template O
 * @param {string} caller - Name of the public function, used in the error message
 * @param {O | undefined} options - The options
 * @returns {O} The options
 * @throws {TypeError} when `options` is neither an object nor `undefined`
 */
function optionsOf<O extends object>(caller: string, options: O | undefined): O {
	if (options === undefined) return {} as O;
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);
	return options;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stream readers (WHATWG ReadableStreams, Node streams, fetch bodies, async generators... of bytes or text)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The part of a WHATWG `ReadableStream` the stream readers use (structural, so that the streams of every runtime fit, and so that the
 * declarations do not need the DOM type library): `fetch(...).body`, `Blob#stream()`, Node's `stream/web` and `Readable.toWeb()`.
 * @template T - The chunk type
 */
export interface ReadableStreamLike<T> {
	getReader(): ReadableStreamReaderLike<T>;
}

/**
 * The part of a `ReadableStreamDefaultReader` the stream readers use.
 * @template T - The chunk type
 */
export interface ReadableStreamReaderLike<T> {
	read(): PromiseLike<{ done: boolean; value?: T }>;
	cancel(reason?: unknown): PromiseLike<void>;
	releaseLock(): void;
}

/**
 * What the stream readers read from: a WHATWG `ReadableStream` (read through its reader, so it works where streams are not async
 * iterable yet), or any async iterable (a Node `Readable`, an async generator) or sync iterable of chunks (promises are awaited).
 * The chunk type is inferred from the async iterator of a stream (`ReadableStream` overloads `getReader`, which defeats inference from
 * it): pass it explicitly (`streamToArray<number>(stream)`) for a stream type that is not async iterable.
 * @template T - The chunk type
 */
export type StreamSource<T> = ReadableStreamLike<NoInfer<T>> | AwaitableIterable<T>;

/**
 * What the text readers read from: a {@link StreamSource} of chunks that are strings or UTF-8 bytes (`Uint8Array`, Node's `Buffer`),
 * mixed freely, or a whole text or byte buffer given as one chunk.
 */
export type TextStreamSource = StreamSource<string | Uint8Array> | string | Uint8Array;

/**
 * The option shared by the stream readers.
 */
export interface StreamReadOptions {
	/**
	 * Aborting it cancels the stream (or calls the iterator's `return()`) at once, even while a read is pending, and makes the reader throw
	 * the signal's `reason` (or an `AbortError`) at its next read. An already aborted signal cancels the stream at the first read.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * The `%TypedArray%.prototype[Symbol.toStringTag]` getter: the constructor name of a genuine typed array of any realm, else `undefined`.
 * Looked up on first use: bundlers keep a top-level property read, which would ship it with every helper of the module.
 */
let typedArrayTag: ((this: unknown) => string | undefined) | undefined;

/**
 * Tells whether a value is a genuine `Uint8Array` (or `Buffer`) of any realm: a brand check, which a fake `Symbol.toStringTag` cannot fool.
 * @param {unknown} value - The value
 * @returns {boolean} Whether it is a `Uint8Array`
 */
function isBytes(value: unknown): value is Uint8Array {
	typedArrayTag ??= (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag) as PropertyDescriptor).get as (
		this: unknown
	) => string | undefined;
	return typedArrayTag.call(value) === 'Uint8Array';
}

/**
 * Throws a `TypeError` unless `source` is something the stream readers can read.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} source - The value to validate
 * @returns {void}
 * @throws {TypeError} when `source` is neither a stream nor an (async) iterable
 */
function assertStreamSource(caller: string, source: unknown): void {
	// Strings and Uint8Arrays (whole buffers for the text readers) are iterable too.
	if (isStream(source) || isAsyncIterable(source) || isIterable(source)) return;
	throw new TypeError(`${caller}: \`source\` must be a ReadableStream or an (async) iterable, got ${describe(source)}`);
}

/**
 * Tells whether a value has a `getReader` method, like a WHATWG `ReadableStream`.
 * @param {unknown} value - The value
 * @returns {value is ReadableStreamLike<unknown>} Whether it looks like a stream
 */
function isStream(value: unknown): value is ReadableStreamLike<unknown> {
	return typeof value === 'object' && value !== null && typeof (value as Partial<ReadableStreamLike<unknown>>).getReader === 'function';
}

/** Returned by {@link ChunkReader.read} at the end of the stream. */
const END = {};

/**
 * Reads the chunks of a {@link StreamSource} one at a time, with abort support and cleanup.
 */
interface ChunkReader {
	/** Opens the source (locks the stream, or gets the iterator) and starts listening to the signal. */
	open(): void;
	/** Reads the next chunk, or {@link END}. Throws the source's error, or the abort reason. */
	read(): Promise<unknown>;
	/** Throws the abort reason if the signal was aborted. */
	check(): void;
	/** Cancels the stream (closes the iterator) unless it ended, failed or was already closed, then releases the lock. */
	close(failure: { error: unknown } | undefined): Promise<void>;
}

/**
 * Creates the {@link ChunkReader} of a source (nothing is read or locked until `open()`).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} source - The validated source
 * @param {boolean} whole - Whether a string or a `Uint8Array` source is one chunk
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {ChunkReader} The reader
 */
function chunkReader(caller: string, source: unknown, whole: boolean, signal: AbortSignalLike | undefined): ChunkReader {
	let reader: ReadableStreamReaderLike<unknown> | undefined;
	let iterator: AsyncIterator<unknown> | undefined;
	// Whether there is nothing left to close: the source ended, failed or was closed.
	let settled = false;
	let abortedWith: { reason: unknown } | undefined;
	// Rejects the pending read (with a signal only).
	let interrupt: ((reason: unknown) => void) | undefined;

	/**
	 * Releases the lock on the stream, ignoring a reader whose `releaseLock` throws.
	 * @returns {void}
	 */
	function release(): void {
		try {
			reader?.releaseLock();
		} catch {
			// Nothing more can be done with it.
		}
	}

	/**
	 * Abort listener: rejects the pending read and cancels the source at once (a pending read may never settle otherwise).
	 * @returns {void}
	 */
	function onAbort(): void {
		if (abortedWith !== undefined) return;
		const reason = abortReason(signal as AbortSignalLike);
		abortedWith = { reason };
		interrupt?.(reason);
		if (settled) return;
		settled = true;
		if (reader === undefined) {
			closeLater(iterator as AsyncIterator<unknown>);
			return;
		}
		// Cancelling settles a pending read, so the lock can be released at once.
		try {
			Promise.resolve(reader.cancel(reason)).then(undefined, ignore);
		} catch {
			// A synchronously throwing `cancel()`: nobody is waiting for it.
		}
		release();
	}

	/**
	 * Throws the abort reason if the signal was aborted (also for a signal-like object that did not dispatch the event).
	 * @returns {void}
	 */
	function check(): void {
		if (signal?.aborted) onAbort();
		if (abortedWith !== undefined) throw abortedWith.reason;
	}

	/**
	 * Waits for a read, unless the signal is aborted first (used only with a signal).
	 * @param {PromiseLike<unknown> | unknown} pull - The pending read
	 * @returns {Promise<unknown>} Its result
	 */
	function interruptible(pull: unknown): Promise<unknown> {
		return new Promise(function (resolve, reject) {
			interrupt = reject;
			Promise.resolve(pull).then(resolve, reject);
		});
	}

	return {
		open(): void {
			if (isStream(source)) {
				reader = source.getReader();
			} else {
				// A whole buffer is read as a single chunk.
				const chunks = whole && (typeof source === 'string' || isBytes(source)) ? [source] : (source as AwaitableIterable<unknown>);
				iterator = (isAsyncIterable(chunks) ? chunks : awaitedItems(chunks))[Symbol.asyncIterator]();
			}
			// An already aborted signal is noticed by the first read.
			signal?.addEventListener('abort', onAbort);
		},
		async read(): Promise<unknown> {
			check();
			try {
				const pull = reader !== undefined ? reader.read() : (iterator as AsyncIterator<unknown>).next();
				// Without a signal nothing can interrupt the read: awaiting it directly saves a promise and two ticks per chunk.
				const step = signal === undefined ? await pull : await interruptible(pull);
				// Aborted while the chunk was arriving: it is dropped (the source is already cancelled).
				check();
				if (typeof step !== 'object' || step === null)
					throw new TypeError(`${caller}: the source returned a read result that is not an object, got ${describe(step)}`);
				const { done, value } = step as IteratorResult<unknown>;
				if (!done) return value;
				settled = true;
				return END;
			} catch (error) {
				// The source failed on its own (it is not cancelled, like `for await` does), or the read was aborted (it is cancelled already).
				settled = true;
				throw error;
			}
		},
		check,
		async close(failure: { error: unknown } | undefined): Promise<void> {
			detach(signal, onAbort);
			try {
				if (!settled) await (reader !== undefined ? reader.cancel(failure?.error) : iterator?.return?.());
			} catch (error) {
				// When the reading failed, that error is the one reported (like `for await`).
				if (failure === undefined) throw error;
			} finally {
				release();
			}
		}
	};
}

/**
 * Throws the `TypeError` for a chunk that is neither a string nor a `Uint8Array`.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} piece - The chunk
 * @returns {never} Always throws
 * @throws {TypeError} always
 */
function badChunk(caller: string, piece: unknown): never {
	throw new TypeError(`${caller}: a chunk must be a string or a Uint8Array, got ${describe(piece)}`);
}

/** Structural subset of the WHATWG `TextDecoder` (not in the ES2022 type library). */
interface StreamingDecoder {
	decode(input?: Uint8Array, options?: { stream: boolean }): string;
}

/** The options of a streaming `decode` call. */
const STREAM = { stream: true };

/**
 * The state of the incremental UTF-8 decoding of a text stream.
 */
interface TextState {
	decoder: StreamingDecoder | undefined;
	// Whether the last chunk was bytes: the decoder may hold the start of a character.
	pending: boolean;
	// Whether some text was produced (a byte order mark is only dropped at the very start).
	started: boolean;
}

/**
 * Creates the state of an incremental decoding.
 * @returns {TextState} A fresh state
 */
function textState(): TextState {
	return { decoder: undefined, pending: false, started: false };
}

/**
 * Turns a chunk into text: a string as is, bytes through a streaming UTF-8 decoder (`TextDecoder`, which keeps the start of a character
 * split across chunks for the next one, and turns malformed bytes into U+FFFD exactly like decoding the whole stream at once). A byte
 * order mark at the very start of the stream is dropped, like `TextDecoderStream` and `Response#text()` do.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {TextState} state - The decoding state
 * @param {unknown} piece - The chunk, or {@link END} to flush the decoder
 * @returns {string} The text of the chunk
 * @throws {TypeError} when the chunk is neither a string nor a `Uint8Array`, or bytes come and the runtime has no `TextDecoder`
 */
function decodeChunk(caller: string, state: TextState, piece: unknown): string {
	let text: string;
	if (typeof piece === 'string' || piece === END) {
		// An empty string does not interrupt a character split across byte chunks.
		if (piece === '') return '';
		// Bytes before a string, or at the end, may have left an incomplete character: flushed as U+FFFD.
		const tail = state.pending ? (state.decoder as StreamingDecoder).decode() : '';
		state.pending = false;
		text = piece === END ? tail : tail + (piece as string);
	} else {
		if (!isBytes(piece)) badChunk(caller, piece);
		state.decoder ??= createDecoder(caller);
		state.pending = true;
		text = state.decoder.decode(piece, STREAM);
	}
	if (state.started || text.length === 0) return text;
	state.started = true;
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Creates a streaming UTF-8 decoder that keeps the byte order mark (it is dropped by {@link decodeChunk}, also from string chunks).
 * @param {string} caller - Name of the public function, used in the error message
 * @returns {StreamingDecoder} The decoder
 * @throws {TypeError} when the runtime has no `TextDecoder`
 */
function createDecoder(caller: string): StreamingDecoder {
	const Decoder = (globalThis as { TextDecoder?: new (label: string, options: object) => StreamingDecoder }).TextDecoder;
	if (typeof Decoder !== 'function') throw new TypeError(`${caller}: decoding Uint8Array chunks needs TextDecoder, which this runtime lacks`);
	return new Decoder('utf-8', { ignoreBOM: true });
}

/**
 * The state of the line splitting of a text stream.
 */
interface LineState {
	caller: string;
	// Longest line accepted.
	max: number;
	// Whether a lone CR ends a line too (otherwise only LF does, and a CR before it stays in the line).
	cr: boolean;
	// The pieces of the line being read, and their total length (joined once, so that a long line costs linear time).
	parts: string[];
	size: number;
	// Lines completed so far.
	count: number;
	// The last chunk ended with a CR: a LF at the start of the next one belongs to the same line break.
	skipLF: boolean;
}

/**
 * Creates the state of a line splitting.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {number} max - The longest line accepted
 * @param {boolean} cr - Whether a lone CR ends a line
 * @returns {LineState} A fresh state
 */
function lineState(caller: string, max: number, cr: boolean): LineState {
	return { caller, max, cr, parts: [], size: 0, count: 0, skipLF: false };
}

/**
 * Creates the error thrown for a line longer than `maxLineLength`.
 * @param {LineState} state - The splitting state
 * @param {number} line - The 1-based number of the line
 * @returns {RangeError} The error
 */
function lineTooLong(state: LineState, line: number): RangeError {
	return new RangeError(`${state.caller}: line ${line} is longer than \`maxLineLength\` (${state.max})`);
}

/**
 * Appends the lines completed by a piece of text to `lines`, keeping the unfinished last line for the next piece (or appending it too,
 * when not empty, for the last piece). Lines end at LF, CRLF and (when `state.cr`) a lone CR, also when the CR and the LF of a CRLF
 * come in different pieces. Each code unit is scanned once.
 *
 * A line longer than `state.max` stops the splitting: its error is returned rather than thrown, so that the caller first hands out
 * the lines before it (the outcome must not depend on where the chunks were cut), then throws it.
 * @param {LineState} state - The splitting state
 * @param {string} text - The next piece of text
 * @param {string[]} lines - Receives the completed lines (without their line breaks)
 * @param {boolean} atEnd - Whether it is the last piece of the stream
 * @returns {RangeError | undefined} The error of a line longer than `state.max`, if any
 */
function splitLines(state: LineState, text: string, lines: string[], atEnd: boolean): RangeError | undefined {
	const length = text.length;
	let start = 0;
	if (state.skipLF && length > 0) {
		state.skipLF = false;
		if (text.charCodeAt(0) === 10) start = 1;
	}
	// The next LF and CR at or after `start`, each searched again only once passed: a linear scan.
	let lf = text.indexOf('\n', start);
	let cr = state.cr ? text.indexOf('\r', start) : -1;
	while (lf !== -1 || cr !== -1) {
		let end: number;
		let next: number;
		if (cr === -1 || (lf !== -1 && lf < cr)) {
			end = lf;
			next = lf + 1;
			lf = text.indexOf('\n', next);
		} else {
			end = cr;
			next = cr + 1;
			if (next === length) {
				state.skipLF = true;
			} else if (text.charCodeAt(next) === 10) {
				next++;
				lf = text.indexOf('\n', next);
			}
			cr = text.indexOf('\r', next);
		}
		state.count++;
		if (state.size + end - start > state.max) return lineTooLong(state, state.count);
		let line = text.slice(start, end);
		if (state.parts.length > 0) {
			state.parts.push(line);
			line = state.parts.join('');
			state.parts = [];
			state.size = 0;
		}
		lines.push(line);
		start = next;
	}
	if (start < length) {
		const size = state.size + length - start;
		if (size > state.max) return lineTooLong(state, state.count + 1);
		state.parts.push(text.slice(start));
		state.size = size;
	}
	if (atEnd && state.parts.length > 0) lines.push(state.parts.join(''));
	return undefined;
}

/**
 * Reads the shared options of the line readers.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {ReadLinesOptions | undefined} options - The options
 * @returns {{ max: number; signal: AbortSignalLike | undefined; settings: ReadLinesOptions }} The validated options
 * @throws {TypeError} when `options` is not an object, `maxLineLength` is not a number or `signal` is not a signal
 * @throws {RangeError} when `maxLineLength` is not an integer >= 0 or `Infinity`
 */
function lineOptions<O extends ReadLinesOptions>(caller: string, options: O | undefined): { max: number; signal: AbortSignalLike | undefined; settings: O } {
	const settings = optionsOf(caller, options);
	const max = readOption(settings, 'maxLineLength', Infinity);
	const signal = readOption(settings, 'signal');
	assertInteger(caller, 'maxLineLength', max, 0, true);
	assertOptionalSignal(caller, 'signal', signal);
	return { max, signal: signal ?? undefined, settings };
}

/**
 * Options accepted by {@link readLines}.
 */
export interface ReadLinesOptions extends StreamReadOptions {
	/**
	 * Longest line accepted, in UTF-16 code units without the line break (an integer >= 0, or `Infinity`, the default): a longer line
	 * throws a `RangeError` as soon as that many characters are buffered, so a stream without line breaks cannot exhaust memory.
	 */
	maxLineLength?: number;
}

/**
 * The async generator behind {@link readLines} (the arguments are already validated).
 * @param {TextStreamSource} source - The text stream
 * @param {number} max - The longest line accepted
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {AsyncGenerator<string, void, undefined>} An async generator of the lines
 */
async function* linesOf(source: TextStreamSource, max: number, signal: AbortSignalLike | undefined): AsyncGenerator<string, void, undefined> {
	const chunks = chunkReader('readLines', source, true, signal);
	const text = textState();
	const state = lineState('readLines', max, true);
	const lines: string[] = [];
	let failure: { error: unknown } | undefined;
	try {
		chunks.open();
		for (;;) {
			const piece = await chunks.read();
			const tooLong = splitLines(state, decodeChunk('readLines', text, piece), lines, piece === END);
			for (let i = 0; i < lines.length; i++) {
				chunks.check();
				yield lines[i];
			}
			if (tooLong !== undefined) {
				// An abort while the consumer held the last line wins, as at any read.
				chunks.check();
				throw tooLong;
			}
			if (piece === END) return;
			lines.length = 0;
		}
	} catch (error) {
		failure = { error };
		throw error;
	} finally {
		await chunks.close(failure);
	}
}

/**
 * Lazily reads the lines of a text stream: a `fetch` body, a Node stream, a `Blob#stream()`, an async generator... of strings and/or UTF-8
 * bytes, or a whole string or byte buffer.
 *
 * - Line breaks: LF, CRLF and a lone CR, like Node's `readline` with `crlfDelay: Infinity` (a CR ending one chunk and a LF starting
 *   the next are ONE break, however long the pause between them). Lines are yielded without their line break.
 * - The last line is yielded when it is not empty, with or without a final line break, so `'a\nb'` and `'a\nb\n'` both give `a`, `b`
 *   (like `readline`), and `'a\n\n'` gives `a` and an empty line.
 * - Decoding: UTF-8, incremental (a character split across chunks is decoded whole; malformed bytes become U+FFFD exactly as when
 *   decoding the whole stream with `TextDecoder`), and a byte order mark at the very start is dropped. Needs `TextDecoder` for bytes.
 * - Cost: linear in the stream, even for one huge line split over thousands of chunks (its pieces are joined once).
 * - Cleanup: when the loop stops early (`break`, an error, a line over `maxLineLength`), the stream is cancelled and its lock released
 *   (an async iterable is closed with `return()`). A stream that fails is not cancelled, and its error is thrown. Like any async
 *   generator, a `return()` called while a read is pending waits for that read: abort `signal` to stop an idle stream at once.
 * @param {TextStreamSource} source - The text stream (or the whole text)
 * @param {ReadLinesOptions} [options] - `maxLineLength` and `signal`
 * @returns {AsyncIterableIterator<string>} An async iterator of the lines
 * @throws {TypeError} when `source` is not a stream, an (async) iterable, a string or a `Uint8Array`, `options` is not an object,
 * `maxLineLength` is not a number or `signal` is not a signal; (while reading) when a chunk is neither a string nor a `Uint8Array`
 * @throws {RangeError} when `maxLineLength` is not an integer >= 0 or `Infinity`; (while reading) when a line is longer than it
 * @example
 * await toArrayAsync(readLines(['one\r', '\ntwo\rthree\n', 'four'])); // => ['one', 'two', 'three', 'four']
 * await toArrayAsync(readLines('a\n\nb\n')); // => ['a', '', 'b']
 * // 'é' is the two bytes 0xc3 0xa9, here in different chunks
 * await toArrayAsync(readLines([new Uint8Array([0x68, 0xc3]), new Uint8Array([0xa9, 0x0a, 0x21])])); // => ['hé', '!']
 * await toArrayAsync(readLines(['short\n', 'much too long'], { maxLineLength: 8 })); // throws RangeError
 * @example
 * // doctest: skip
 * const response = await fetch('https://example.com/huge.log');
 * for await (const line of readLines(response.body!, { maxLineLength: 1_000_000 })) {
 *   if (line.includes('ERROR')) break; // cancels the download
 * }
 */
export function readLines(source: TextStreamSource, options?: ReadLinesOptions): AsyncIterableIterator<string> {
	assertStreamSource('readLines', source);
	const { max, signal } = lineOptions('readLines', options);
	return linesOf(source, max, signal);
}

/**
 * An event parsed by {@link parseSSE}, with the fields of the `MessageEvent` an `EventSource` would dispatch.
 */
export interface ServerSentEvent {
	/** The event type: the value of the block's last `event` field, or `'message'` when it has none (or an empty one). */
	event: string;
	/** The values of the block's `data` fields, joined with `\n` (an empty `data` field counts: `data` alone gives `''`). */
	data: string;
	/**
	 * The last event ID (`MessageEvent#lastEventId`): the value of the most recent `id` field so far, which PERSISTS across events
	 * (send it back as `Last-Event-ID` when reconnecting); `''` until one is set, and an empty `id` field resets it to `''`.
	 */
	id: string;
	/**
	 * The reconnection time in milliseconds, from the most recent valid `retry` field so far (it persists, like `id`, also when the
	 * block that set it dispatched no event); absent until one is seen. See also {@link ParseSSEOptions.onRetry}.
	 */
	retry?: number;
}

/**
 * Options accepted by {@link parseSSE}.
 */
export interface ParseSSEOptions extends ReadLinesOptions {
	/**
	 * Longest `data` of an event, in UTF-16 code units once its values are joined with `\n` (an integer >= 0, or `Infinity`, the
	 * default): a longer one throws a `RangeError` as soon as its `data` lines exceed it. `maxLineLength` bounds each line, this bounds
	 * the many `data` lines of an event that a stream never ends with a blank line; set both to bound the memory an event stream takes.
	 */
	maxDataLength?: number;
	/**
	 * Called with the new reconnection time whenever a valid `retry` field is parsed, even when no event follows (in stream order: after
	 * the events before it have been read).
	 */
	onRetry?: (milliseconds: number) => void;
}

/**
 * The state of the event stream interpretation of {@link parseSSE}.
 */
interface SseState {
	// The values of the `data` fields of the current block, and the length of their joined text plus one.
	data: string[];
	size: number;
	maxData: number;
	type: string;
	id: string;
	retry: number | undefined;
	onRetry: ((milliseconds: number) => void) | undefined;
}

/** A `retry` value the specification accepts: ASCII digits only. */
const RETRY_VALUE = /^[0-9]+$/;

/**
 * Interprets one line of an event stream (WHATWG HTML, "Interpreting an event stream").
 * @param {SseState} state - The interpretation state
 * @param {string} line - The line, without its line break
 * @returns {ServerSentEvent | undefined} The event the line dispatches, if any
 * @throws {RangeError} when the `data` of the event gets longer than `state.maxData`
 */
function interpretLine(state: SseState, line: string): ServerSentEvent | undefined {
	if (line.length === 0) {
		// Dispatch: a block without `data` dispatches nothing, but still resets the event type.
		const type = state.type;
		state.type = '';
		if (state.data.length === 0) return undefined;
		const event = type === '' ? 'message' : type;
		// Joining with LF is appending LF after each value, then removing the last one.
		const data = state.data.join('\n');
		state.data = [];
		state.size = 0;
		return state.retry === undefined ? { event, data, id: state.id } : { event, data, id: state.id, retry: state.retry };
	}
	const colon = line.indexOf(':');
	// A comment (a line starting with a colon) has an empty field name, which is no field.
	const field = colon === -1 ? line : line.slice(0, colon);
	// One leading space of the value is removed.
	const value = colon === -1 ? '' : line.slice(line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1);
	if (field === 'data') {
		if (state.size + value.length > state.maxData) throw new RangeError(`parseSSE: the data of an event is longer than \`maxDataLength\` (${state.maxData})`);
		state.size += value.length + 1;
		state.data.push(value);
	} else if (field === 'event') {
		state.type = value;
	} else if (field === 'id') {
		if (!value.includes('\0')) state.id = value;
	} else if (field === 'retry' && RETRY_VALUE.test(value)) {
		state.retry = Number(value);
		state.onRetry?.(state.retry);
	}
	return undefined;
}

/**
 * The async generator behind {@link parseSSE} (the arguments are already validated).
 * @param {TextStreamSource} source - The event stream
 * @param {number} max - The longest line accepted
 * @param {number} maxData - The longest `data` of an event accepted
 * @param {((milliseconds: number) => void) | undefined} onRetry - The `retry` callback
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {AsyncGenerator<ServerSentEvent, void, undefined>} An async generator of the events
 */
async function* sseEvents(
	source: TextStreamSource,
	max: number,
	maxData: number,
	onRetry: ((milliseconds: number) => void) | undefined,
	signal: AbortSignalLike | undefined
): AsyncGenerator<ServerSentEvent, void, undefined> {
	const chunks = chunkReader('parseSSE', source, true, signal);
	const text = textState();
	const lines = lineState('parseSSE', max, true);
	const state: SseState = { data: [], size: 0, maxData, type: '', id: '', retry: undefined, onRetry };
	const pending: string[] = [];
	let failure: { error: unknown } | undefined;
	try {
		chunks.open();
		for (;;) {
			const piece = await chunks.read();
			// At the end, an unfinished line is not interpreted and an unfinished event is discarded.
			if (piece === END) return;
			const tooLong = splitLines(lines, decodeChunk('parseSSE', text, piece), pending, false);
			// Each line is interpreted only once the events before it are consumed (so `onRetry` sees them in stream order), and
			// nothing more is interpreted once aborted.
			for (let i = 0; i < pending.length; i++) {
				chunks.check();
				const event = interpretLine(state, pending[i]);
				if (event !== undefined) yield event;
			}
			if (tooLong !== undefined) {
				// An abort while the consumer held the last event wins, as at any read.
				chunks.check();
				throw tooLong;
			}
			pending.length = 0;
		}
	} catch (error) {
		failure = { error };
		throw error;
	} finally {
		await chunks.close(failure);
	}
}

/**
 * Lazily parses a stream of Server-Sent Events (`text/event-stream`) exactly as an `EventSource` does, following the WHATWG HTML
 * "event stream interpretation" algorithm; usable directly on `fetch(...).body`, for example to read the streaming responses of LLM APIs
 * (where `EventSource` cannot send a POST body or headers).
 *
 * - A byte order mark at the very start is dropped (once); lines end at LF, CRLF or CR (also split across chunks); bytes are decoded as
 *   UTF-8 incrementally (see {@link readLines}).
 * - A line starting with `:` is a comment. Otherwise the field name is what precedes the first `:` (the whole line when there is none)
 *   and the value what follows it, minus one leading space. Field names are case-sensitive; unknown fields are ignored.
 * - `data` values are joined with `\n`; `event` sets the type (`'message'` by default); `id` sets the last event ID, which persists
 *   across events, unless its value contains U+0000; `retry` sets the reconnection time when its value is made of ASCII digits only.
 * - A blank line dispatches the event, unless no `data` field was seen since the last one (then nothing is yielded, as in browsers).
 *   An event not followed by a blank line when the stream ends is discarded.
 * - Each event is `{ event, data, id }`, plus `retry` once the stream has set one (see {@link ServerSentEvent}).
 * - Memory: `maxLineLength` bounds each line and `maxDataLength` the `data` of an event (a stream may send `data` lines forever
 *   without the blank line that dispatches them); both are unbounded by default, so set them for an untrusted stream.
 * - Cleanup, `signal` and `maxLineLength` work as in {@link readLines}. The parser never reconnects: that is up to the caller.
 * @param {TextStreamSource} source - The event stream (or its whole text)
 * @param {ParseSSEOptions} [options] - `maxLineLength`, `maxDataLength`, `onRetry` and `signal`
 * @returns {AsyncIterableIterator<ServerSentEvent>} An async iterator of the dispatched events
 * @throws {TypeError} when `source` is not a stream, an (async) iterable, a string or a `Uint8Array`, `options` is not an object,
 * `maxLineLength` or `maxDataLength` is not a number, `onRetry` is not a function or `signal` is not a signal; (while reading) for a bad chunk
 * @throws {RangeError} when `maxLineLength` or `maxDataLength` is not an integer >= 0 or `Infinity`; (while reading) when a line, or
 * the `data` of an event, is longer than it
 * @example
 * const body = new Response('event: greet\ndata: hello\ndata: world\nid: 7\n\n: a comment\ndata: bye\n\ndata: unfinished').body!;
 * await toArrayAsync(parseSSE(body)); // => [{ event: 'greet', data: 'hello\nworld', id: '7' }, { event: 'message', data: 'bye', id: '7' }]
 * await toArrayAsync(parseSSE(['retry: 3000\n\nda', 'ta:x\r\n\r\n'])); // => [{ event: 'message', data: 'x', id: '', retry: 3000 }]
 * await toArrayAsync(parseSSE('data: 1234\ndata: 5678\n', { maxDataLength: 8 })); // throws RangeError // '1234\n5678' is 9 long
 * @example
 * // doctest: skip
 * const response = await fetch('https://api.example.com/v1/chat', { method: 'POST', headers, body, signal });
 * for await (const { event, data } of parseSSE(response.body!, { signal })) {
 *   if (data === '[DONE]') break; // cancels the response stream
 *   render(JSON.parse(data));
 * }
 */
export function parseSSE(source: TextStreamSource, options?: ParseSSEOptions): AsyncIterableIterator<ServerSentEvent> {
	assertStreamSource('parseSSE', source);
	const { max, signal, settings } = lineOptions('parseSSE', options);
	const maxData = readOption(settings, 'maxDataLength', Infinity);
	const onRetry = readOption(settings, 'onRetry');
	assertInteger('parseSSE', 'maxDataLength', maxData, 0, true);
	if (onRetry !== undefined) assertFunction('parseSSE', 'onRetry', onRetry);
	return sseEvents(source, max, maxData, onRetry, signal);
}

/**
 * Options accepted by {@link parseNdjson}.
 */
export interface ParseNdjsonOptions extends ReadLinesOptions {
	/** Passed to `JSON.parse` for each value. */
	reviver?: (this: unknown, key: string, value: unknown) => unknown;
}

/**
 * Tells whether a line holds only JSON white space (space, tab, CR).
 * @param {string} line - The line
 * @returns {boolean} Whether it is blank
 */
function isBlank(line: string): boolean {
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code !== 32 && code !== 9 && code !== 13) return false;
	}
	return true;
}

/**
 * The async generator behind {@link parseNdjson} (the arguments are already validated).
 * @param {TextStreamSource} source - The NDJSON stream
 * @param {number} max - The longest line accepted
 * @param {((this: unknown, key: string, value: unknown) => unknown) | undefined} reviver - The `JSON.parse` reviver
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {AsyncGenerator<unknown, void, undefined>} An async generator of the values
 */
async function* ndjsonValues(
	source: TextStreamSource,
	max: number,
	reviver: ((this: unknown, key: string, value: unknown) => unknown) | undefined,
	signal: AbortSignalLike | undefined
): AsyncGenerator<unknown, void, undefined> {
	const chunks = chunkReader('parseNdjson', source, true, signal);
	const text = textState();
	const state = lineState('parseNdjson', max, false);
	const lines: string[] = [];
	// Set when the reviver throws: its error is passed through rather than reported as invalid JSON.
	let revived: { error: unknown } | undefined;
	const revive =
		reviver === undefined
			? undefined
			: function (this: unknown, key: string, value: unknown): unknown {
					try {
						return reviver.call(this, key, value);
					} catch (error) {
						revived = { error };
						throw error;
					}
				};
	let number = 0;
	let failure: { error: unknown } | undefined;
	try {
		chunks.open();
		for (;;) {
			const piece = await chunks.read();
			const tooLong = splitLines(state, decodeChunk('parseNdjson', text, piece), lines, piece === END);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				number++;
				if (isBlank(line)) continue;
				// Nothing more is parsed once aborted.
				chunks.check();
				let value: unknown;
				try {
					value = JSON.parse(line, revive);
				} catch (error) {
					if (revived !== undefined) throw revived.error;
					throw new SyntaxError(`parseNdjson: line ${number} is not valid JSON: ${(error as Error).message}`, { cause: error });
				}
				yield value;
			}
			if (tooLong !== undefined) {
				// An abort while the consumer held the last value wins, as at any read.
				chunks.check();
				throw tooLong;
			}
			if (piece === END) return;
			lines.length = 0;
		}
	} catch (error) {
		failure = { error };
		throw error;
	} finally {
		await chunks.close(failure);
	}
}

/**
 * Lazily parses a stream of newline-delimited JSON (NDJSON, JSON Lines): one JSON value per line.
 *
 * - Lines end at LF only (a CR before it is JSON white space, so CRLF works, but a lone CR does not end a line: JSON text may not contain
 *   one outside white space, and NDJSON and JSON Lines both separate values with LF). Lines of white space only are skipped.
 * - A line that is not valid JSON throws a `SyntaxError` naming its 1-based line number (blank lines count), with the error of `JSON.parse`
 *   as `cause`; an error thrown by `reviver` is passed through as is. The last line needs no final LF.
 * - Decoding, cleanup, `signal` and `maxLineLength` (which counts a CR before the LF) work as in {@link readLines}.
 * @template T - The type of the values (not checked: validate them, e.g. with a `guards` or `validate` schema)
 * @param {TextStreamSource} source - The NDJSON stream (or its whole text)
 * @param {ParseNdjsonOptions} [options] - `reviver`, `maxLineLength` and `signal`
 * @returns {AsyncIterableIterator<T>} An async iterator of the parsed values
 * @throws {TypeError} when `source` is not a stream, an (async) iterable, a string or a `Uint8Array`, `options` is not an object,
 * `maxLineLength` is not a number, `reviver` is not a function or `signal` is not a signal; (while reading) for a bad chunk
 * @throws {RangeError} when `maxLineLength` is not an integer >= 0 or `Infinity`; (while reading) when a line is longer than it
 * @throws {SyntaxError} (while reading) when a line is not valid JSON
 * @example
 * await toArrayAsync(parseNdjson(['{"id":1}\n', '\n[2,', '3]\r\n', '"four"'])); // => [{ id: 1 }, [2, 3], 'four']
 * await toArrayAsync(parseNdjson('1\n\n{oops}\n')); // throws SyntaxError // parseNdjson: line 3 is not valid JSON: ...
 */
export function parseNdjson<T = unknown>(source: TextStreamSource, options?: ParseNdjsonOptions): AsyncIterableIterator<T> {
	assertStreamSource('parseNdjson', source);
	const { max, signal, settings } = lineOptions('parseNdjson', options);
	const reviver = readOption(settings, 'reviver');
	if (reviver !== undefined) assertFunction('parseNdjson', 'reviver', reviver);
	return ndjsonValues(source, max, reviver, signal) as AsyncIterableIterator<T>;
}

/**
 * Options accepted by {@link streamToText}.
 */
export interface StreamToTextOptions extends StreamReadOptions {
	/** Longest text accepted, in UTF-16 code units (an integer >= 0, or `Infinity`, the default): a longer one rejects with a `RangeError`. */
	maxLength?: number;
}

/**
 * Options accepted by {@link streamToBytes}.
 */
export interface StreamToBytesOptions extends StreamReadOptions {
	/** Largest size accepted, in bytes (an integer >= 0, or `Infinity`, the default): a larger stream rejects with a `RangeError`. */
	maxBytes?: number;
}

/**
 * Options accepted by {@link streamToArray}.
 */
export interface StreamToArrayOptions extends StreamReadOptions {
	/** Most chunks accepted (an integer >= 0, or `Infinity`, the default): a longer stream rejects with a `RangeError`. */
	maxLength?: number;
}

/**
 * Reads the shared options of the stream collectors.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {StreamReadOptions | undefined} options - The options
 * @param {'maxLength' | 'maxBytes'} key - The name of the limit
 * @returns {{ max: number; signal: AbortSignalLike | undefined }} The validated options
 * @throws {TypeError} when `options` is not an object, the limit is not a number or `signal` is not a signal
 * @throws {RangeError} when the limit is not an integer >= 0 or `Infinity`
 */
function collectOptions(caller: string, options: StreamReadOptions | undefined, key: 'maxLength' | 'maxBytes'): { max: number; signal: AbortSignalLike | undefined } {
	const settings = optionsOf(caller, options) as StreamToTextOptions & StreamToBytesOptions;
	const max = readOption(settings, key, Infinity);
	const signal = readOption(settings, 'signal');
	assertInteger(caller, key, max, 0, true);
	assertOptionalSignal(caller, 'signal', signal);
	return { max, signal: signal ?? undefined };
}

/**
 * Reads every chunk of a source, passing each to `add` (the shared loop of the stream collectors).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} source - The validated source
 * @param {boolean} whole - Whether a string or a `Uint8Array` source is one chunk
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @param {(piece: unknown) => void} add - Takes each chunk, then {@link END}; throws to stop (the stream is then cancelled)
 * @returns {Promise<void>} Settles once the stream is read and released
 */
async function drain(caller: string, source: unknown, whole: boolean, signal: AbortSignalLike | undefined, add: (piece: unknown) => void): Promise<void> {
	const chunks = chunkReader(caller, source, whole, signal);
	let failure: { error: unknown } | undefined;
	try {
		chunks.open();
		for (;;) {
			const piece = await chunks.read();
			add(piece);
			if (piece === END) return;
		}
	} catch (error) {
		failure = { error };
		throw error;
	} finally {
		await chunks.close(failure);
	}
}

/**
 * The async function behind {@link streamToText} (the arguments are already validated).
 * @param {TextStreamSource} source - The text stream
 * @param {number} max - The longest text accepted
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {Promise<string>} The text
 */
async function collectText(source: TextStreamSource, max: number, signal: AbortSignalLike | undefined): Promise<string> {
	const state = textState();
	const parts: string[] = [];
	let length = 0;
	await drain('streamToText', source, true, signal, function (piece) {
		const text = decodeChunk('streamToText', state, piece);
		length += text.length;
		if (length > max) throw new RangeError(`streamToText: the text is longer than \`maxLength\` (${max})`);
		parts.push(text);
	});
	return parts.join('');
}

/**
 * Reads a whole text stream into a string (like `Response#text()`, for any stream of strings and/or UTF-8 bytes): decoding, the byte order
 * mark, cleanup and `signal` work as in {@link readLines}. The pieces are joined once, in linear time.
 * @param {TextStreamSource} source - The text stream
 * @param {StreamToTextOptions} [options] - `maxLength` and `signal`
 * @returns {Promise<string>} The text
 * @throws {TypeError} when `source` is not a stream, an (async) iterable, a string or a `Uint8Array`, `options` is not an object,
 * `maxLength` is not a number or `signal` is not a signal; (as a rejection) for a bad chunk
 * @throws {RangeError} when `maxLength` is not an integer >= 0 or `Infinity`; (as a rejection) when the text is longer than it (the
 * stream is cancelled as soon as it is)
 * @example
 * // '€' is the three bytes 0xe2 0x82 0xac
 * await streamToText([new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac]), '!']); // => '€!'
 * await streamToText(new Response('\uFEFFhello').body!); // => 'hello'
 * await streamToText(['abc', 'def'], { maxLength: 5 }); // throws RangeError
 */
export function streamToText(source: TextStreamSource, options?: StreamToTextOptions): Promise<string> {
	assertStreamSource('streamToText', source);
	const { max, signal } = collectOptions('streamToText', options, 'maxLength');
	return collectText(source, max, signal);
}

/**
 * The async function behind {@link streamToBytes} (the arguments are already validated).
 * @param {StreamSource<Uint8Array>} source - The byte stream
 * @param {number} max - The largest size accepted
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {Promise<Uint8Array<ArrayBuffer>>} The bytes
 */
async function collectBytes(source: StreamSource<Uint8Array>, max: number, signal: AbortSignalLike | undefined): Promise<Uint8Array<ArrayBuffer>> {
	const parts: Uint8Array[] = [];
	let size = 0;
	await drain('streamToBytes', source, false, signal, function (piece) {
		if (piece === END) return;
		if (!isBytes(piece)) throw new TypeError(`streamToBytes: a chunk must be a Uint8Array, got ${describe(piece)}`);
		size += piece.length;
		if (size > max) throw new RangeError(`streamToBytes: the stream holds more than \`maxBytes\` (${max}) bytes`);
		parts.push(piece);
	});
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

/**
 * Reads a whole byte stream into one new `Uint8Array` (like `Response#bytes()`): the chunks are kept as they come and copied once, into a
 * buffer of the exact total size (so a source must not reuse a chunk's memory after handing it out, as with any stream). Cleanup and
 * `signal` work as in {@link readLines}.
 * @param {StreamSource<Uint8Array>} source - The byte stream (chunks must be `Uint8Array`s, e.g. Node `Buffer`s)
 * @param {StreamToBytesOptions} [options] - `maxBytes` and `signal`
 * @returns {Promise<Uint8Array<ArrayBuffer>>} A new `Uint8Array` over its own `ArrayBuffer`
 * @throws {TypeError} when `source` is not a stream or an (async) iterable, `options` is not an object, `maxBytes` is not a number or
 * `signal` is not a signal; (as a rejection) when a chunk is not a `Uint8Array`
 * @throws {RangeError} when `maxBytes` is not an integer >= 0 or `Infinity`; (as a rejection) when the stream is larger (it is cancelled
 * as soon as it is)
 * @example
 * await streamToBytes([new Uint8Array([1, 2]), new Uint8Array([3])]); // => new Uint8Array([1, 2, 3])
 * await streamToBytes(new Response('hi').body!); // => new Uint8Array([104, 105])
 * await streamToBytes([new Uint8Array(4)], { maxBytes: 3 }); // throws RangeError
 */
export function streamToBytes(source: StreamSource<Uint8Array>, options?: StreamToBytesOptions): Promise<Uint8Array<ArrayBuffer>> {
	assertStreamSource('streamToBytes', source);
	const { max, signal } = collectOptions('streamToBytes', options, 'maxBytes');
	return collectBytes(source, max, signal);
}

/**
 * The async function behind {@link streamToArray} (the arguments are already validated).
 * @template T
 * @param {StreamSource<T>} source - The stream
 * @param {number} max - The most chunks accepted
 * @param {AbortSignalLike | undefined} signal - The abort signal
 * @returns {Promise<T[]>} The chunks
 */
async function collectChunks<T>(source: StreamSource<T>, max: number, signal: AbortSignalLike | undefined): Promise<T[]> {
	const items: T[] = [];
	await drain('streamToArray', source, false, signal, function (piece) {
		if (piece === END) return;
		if (items.length >= max) throw new RangeError(`streamToArray: the stream holds more than \`maxLength\` (${max}) chunks`);
		items.push(piece as T);
	});
	return items;
}

/**
 * Collects the chunks (or values, for an object stream) of a stream into a new array: {@link toArrayAsync} for `ReadableStream`s too,
 * with a limit and a signal. Cleanup and `signal` work as in {@link readLines}.
 * @template T
 * @param {StreamSource<T>} source - The stream, or an (async) iterable
 * @param {StreamToArrayOptions} [options] - `maxLength` and `signal`
 * @returns {Promise<T[]>} The chunks, in order
 * @throws {TypeError} when `source` is not a stream or an (async) iterable, `options` is not an object, `maxLength` is not a number or
 * `signal` is not a signal
 * @throws {RangeError} when `maxLength` is not an integer >= 0 or `Infinity`; (as a rejection) when the stream has more chunks (it is
 * cancelled as soon as it does)
 * @example
 * const stream = new ReadableStream({ start(controller) { controller.enqueue('a'); controller.enqueue('b'); controller.close(); } });
 * await streamToArray(stream); // => ['a', 'b']
 * await streamToArray(count(), { maxLength: 100 }); // throws RangeError
 */
export function streamToArray<T>(source: StreamSource<T>, options?: StreamToArrayOptions): Promise<T[]> {
	assertStreamSource('streamToArray', source);
	const { max, signal } = collectOptions('streamToArray', options, 'maxLength');
	return collectChunks(source, max, signal);
}
