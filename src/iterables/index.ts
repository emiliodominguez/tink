import { AbortError } from '../async/index.js';
import { isAsyncIterable, isIterable } from '../guards/index.js';
import { assertFunction, assertInteger, assertNumber, describe } from '../utils/assert.js';
import type { AbortSignalLike } from '../utils/index.js';

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
 * The built-in iterator of arrays (`Array.prototype[Symbol.iterator]`).
 */
const ARRAY_ITERATOR = Array.prototype[Symbol.iterator];

/**
 * Awaits each item of a sync iterable inside a `for...of` loop (see {@link awaitItems}).
 * @template T
 * @param {Iterable<T | PromiseLike<T>>} iterable - A sync iterable of values and/or promises
 * @returns {AsyncGenerator<T, void, undefined>} An async generator of the awaited items
 */
async function* awaitedItems<T>(iterable: Iterable<T | PromiseLike<T>>): AsyncGenerator<T, void, undefined> {
	for (const value of iterable) yield await value;
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
	// async-from-sync wrapper of `for await` is enough.
	if (isAsyncIterable(iterable) || iterable[Symbol.iterator] === ARRAY_ITERATOR) return iterable;
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
		for (const iterable of iterables) iterators.push(iterable[Symbol.iterator]());
		for (;;) {
			const tuple = new Array<unknown>(iterators.length);
			for (current = 0; current < iterators.length; current++) {
				const result = iterators[current].next();
				if (result.done === true) return;
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
	for await (const value of awaitItems(iterable)) yield await fn(value, index++);
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
		source.next().then(
			function (step) {
				pulling = false;
				if (step.done) {
					exhausted = true;
				} else if (!stopped) {
					const slot: MappedSlot = { settled: false, ok: false, result: undefined };
					let outcome: unknown;

					buffered++;
					if (ordered) slots.push(slot);
					try {
						outcome = fn(step.value, index++, signal);
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
			},
			function (error: unknown) {
				pulling = false;
				exhausted = true;
				sourceError = { error };
				notify();
			}
		);
	}

	/**
	 * Abort listener: stops pulling and wakes the consumer up, which then throws the reason.
	 * @returns {void}
	 */
	function onAbort(): void {
		stopped = true;
		notify();
	}

	signal?.addEventListener('abort', onAbort);

	try {
		for (;;) {
			if (signal?.aborted) throw abortReason(signal);
			fill();

			const slot = slots[0];

			if (slot?.settled) {
				slots.shift();
				buffered--;
				fill();
				if (!slot.ok) throw slot.result;
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
	} finally {
		stopped = true;
		signal?.removeEventListener('abort', onAbort);
		// Close the source unless it finished or failed on its own (a pending pull is answered first, then the source closes).
		if (!exhausted) await source.return?.();
	}
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
 * - Early exit (`break`, `return()`, an error) stops pulling and calls the source's `return()`. Mappings already running are not
 *   interrupted (their results are dropped, and their rejections handled), so pass `signal` to `fn` to cancel them.
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
	const { concurrency, ordered = true, signal } = typeof options === 'object' && options !== null ? options : { concurrency: options };

	assertAwaitableIterable('mapConcurrent', iterable);
	assertFunction('mapConcurrent', 'fn', fn);
	assertInteger('mapConcurrent', 'concurrency', concurrency, 1, true);
	if (signal != null && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
		throw new TypeError(`mapConcurrent: \`signal\` must be an AbortSignal, null or undefined, got ${describe(signal)}`);
	}

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
	return signal.reason ?? new AbortError();
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
