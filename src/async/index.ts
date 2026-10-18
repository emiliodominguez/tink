import { createLRUCache, createPriorityQueue } from '../cache/index.js';
import { debounce, defaultMemoizeKey, noop, type MemoizeCache, type Result } from '../functions/index.js';
import { assertDelay, assertFunction, assertInteger, assertNumber, describe, draw, MAX_TIMEOUT } from '../utils/assert.js';
import type { AbortSignalLike, AnyFunction, RandomGenerator } from '../utils/index.js';

export type { Result } from '../functions/index.js';

/**
 * Error used to reject operations cancelled through an abort signal that carries no `reason`.
 * @example
 * const controller = new AbortController();
 * controller.abort(new AbortError('cancelled by the user'));
 * await sleep(1000, { signal: controller.signal }); // throws AbortError
 * new AbortError().message; // => 'The operation was aborted.'
 */
export class AbortError extends Error {
	override name = 'AbortError';

	/**
	 * @param {string} [message='The operation was aborted.'] - The error message
	 */
	constructor(message = 'The operation was aborted.') {
		super(message);
	}
}

/**
 * Error used by {@link withTimeout} when the wrapped promise does not settle in time.
 * @example
 * try {
 *   await withTimeout(new Promise(function () {}), 10);
 * } catch (error) {
 *   error instanceof TimeoutError; // => true
 * }
 */
export class TimeoutError extends Error {
	override name = 'TimeoutError';

	/**
	 * @param {string} [message='The operation timed out.'] - The error message
	 */
	constructor(message = 'The operation timed out.') {
		super(message);
	}
}

/**
 * A promise together with the functions that settle it.
 * @template T - The resolved value type
 */
export interface Deferred<T> {
	/** The pending promise. */
	readonly promise: Promise<T>;
	/** Resolves `promise` (no-op once settled). */
	resolve(value: T | PromiseLike<T>): void;
	/** Rejects `promise` (no-op once settled). */
	reject(reason?: unknown): void;
}

/**
 * Options accepted by {@link sleep}.
 */
export interface SleepOptions {
	/** Aborts the sleep, rejecting with the signal's `reason` (or an {@link AbortError}). */
	signal?: AbortSignalLike;
}

/**
 * Options accepted by {@link retry}.
 */
export interface RetryOptions {
	/** Number of retries after the first attempt (`Infinity` allowed). Defaults to `3`. */
	retries?: number;
	/** Delay in ms before the first retry. Defaults to `0`. */
	delay?: number;
	/** Multiplier applied to the delay after each retry. Defaults to `2`. */
	factor?: number;
	/** Upper bound for a single delay in ms. Defaults to `Infinity`. */
	maxDelay?: number;
	/** When `true`, each delay is drawn uniformly from `[0, delay]` ("full jitter"). Defaults to `false`. */
	jitter?: boolean;
	/** Decides whether the error thrown by attempt number `attempt` (1-based) should be retried. Defaults to always. */
	shouldRetry?(error: unknown, attempt: number): boolean;
	/** Called before waiting for the next retry, with the error of attempt number `attempt` (1-based). */
	onRetry?(error: unknown, attempt: number): void;
	/** Aborts the retry loop between attempts (and during delays), rejecting with the signal's reason. */
	signal?: AbortSignalLike;
}

/**
 * The reason a signal was aborted with, or a fresh {@link AbortError} when it has none.
 * @param {AbortSignalLike} signal - An aborted signal
 * @returns {unknown} The rejection reason
 */
function abortReason(signal: AbortSignalLike): unknown {
	return signal.reason ?? new AbortError();
}

/**
 * Calls `fn` with `thisArg` and `args` and returns its outcome as a promise: a synchronous throw becomes a rejection.
 * @param {Function} fn - The function to call
 * @param {unknown} thisArg - The `this` value
 * @param {ArrayLike<unknown>} args - The arguments
 * @returns {Promise<unknown>} A promise settling like the call
 */
function invoke(fn: (...args: never[]) => unknown, thisArg: unknown, args: ArrayLike<unknown>): Promise<unknown> {
	try {
		return Promise.resolve((fn as (this: unknown, ...args: unknown[]) => unknown).apply(thisArg, args as unknown[]));
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * Creates a promise that can be resolved or rejected from the outside.
 * @template T - The resolved value type
 * @returns {Deferred<T>} The promise and its `resolve`/`reject` functions
 * @example
 * const ready = createDeferred<string>();
 * setTimeout(function () { ready.resolve('open'); }, 10);
 * await ready.promise; // => 'open'
 */
export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>(function (res, rej) {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

/**
 * Resolves after `ms` milliseconds. If `options.signal` is aborted (before or during the wait), the timer is cleared and the promise
 * rejects with the signal's `reason` (or an {@link AbortError} if it has none).
 * @param {number} ms - Delay in milliseconds (`0` to `2^31 - 1`)
 * @param {SleepOptions} [options] - Optional abort `signal`
 * @returns {Promise<void>} A promise resolving after the delay
 * @throws {TypeError} (as a rejection) when `ms` is not a number
 * @throws {RangeError} (as a rejection) when `ms` is negative, `NaN` or larger than `2^31 - 1`
 * @example
 * await sleep(10); // resolves after ~10 ms
 * const controller = new AbortController();
 * const nap = sleep(10_000, { signal: controller.signal });
 * controller.abort(); // clears the timer
 * await nap; // throws AbortError
 */
export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
	return new Promise<void>(function (resolve, reject) {
		assertDelay('sleep', 'ms', ms);

		const { signal } = options;

		assertOptionalSignal('sleep', 'signal', signal);

		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}

		/**
		 * Abort listener: clears the timer and rejects.
		 * @returns {void}
		 */
		function onAbort(): void {
			clearTimeout(timer);
			reject(abortReason(signal as AbortSignalLike));
		}

		const timer = setTimeout(function () {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Races `promise` against a timer: resolves/rejects like `promise` if it settles within `ms` milliseconds, otherwise rejects with a
 * {@link TimeoutError}. The timer is always cleared. Note that the underlying operation is not cancelled.
 * @template T - The resolved value type
 * @param {PromiseLike<T> | T} promise - The promise (or value) to wait for
 * @param {number} ms - The time limit in milliseconds (`0` to `2^31 - 1`)
 * @param {string} [message] - Message of the `TimeoutError` (defaults to `Operation timed out after <ms> ms`)
 * @returns {Promise<T>} A promise settling like `promise`, or rejecting on timeout
 * @throws {TimeoutError} (as a rejection) when `promise` does not settle within `ms` milliseconds
 * @throws {TypeError} (as a rejection) when `ms` is not a number
 * @throws {RangeError} (as a rejection) when `ms` is negative, `NaN` or larger than `2^31 - 1`
 * @example
 * await withTimeout(Promise.resolve('data'), 5000); // => 'data'
 * await withTimeout(new Promise(function () {}), 10, 'took too long'); // throws TimeoutError
 */
export function withTimeout<T>(promise: PromiseLike<T> | T, ms: number, message?: string): Promise<T> {
	return new Promise<T>(function (resolve, reject) {
		const settled = Promise.resolve(promise);
		try {
			assertDelay('withTimeout', 'ms', ms);
		} catch (error) {
			// The argument error wins, but `promise` may still reject: handle it so it does not surface as an unhandled rejection.
			settled.catch(noop);
			throw error;
		}

		const timer = setTimeout(function () {
			reject(new TimeoutError(message ?? `Operation timed out after ${ms} ms`));
		}, ms);

		settled.then(
			function (value) {
				clearTimeout(timer);
				resolve(value);
			},
			function (error: unknown) {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

/**
 * Calls `fn` until it succeeds, retrying up to `options.retries` times with exponential backoff:
 * the delay before retry `k` (1-based) is `min(delay * factor^(k - 1), maxDelay)`, optionally randomised with full jitter.
 * Resolves with the first successful result; rejects with the last error once retries are exhausted or `shouldRetry` returns `false`.
 * Every retry waits for at least one timer tick (`setTimeout(0)` for a zero delay), so even `retries: Infinity` with a synchronously
 * throwing `fn` never blocks the thread and stays abortable through `signal`.
 * @template T - The resolved value type
 * @param {(attempt: number) => Promise<T> | T} fn - The operation; receives the 1-based attempt number
 * @param {RetryOptions} [options] - `retries` (3), `delay` (0), `factor` (2), `maxDelay` (Infinity), `jitter` (false), `shouldRetry`, `onRetry`, `signal`
 * @param {RandomGenerator} [random=Math.random] - Random source used for jitter
 * @returns {Promise<T>} The first successful result
 * @throws {TypeError} (as a rejection) when `fn`, `shouldRetry`, `onRetry` or (with `jitter`) `random` is not a function, or a numeric option is not a number
 * @throws {RangeError} (as a rejection) when `retries` is not a non-negative integer or `Infinity`, `delay` is not a finite number >= 0,
 * `factor` is not a finite number > 0, `maxDelay` is negative or `NaN`, or `random()` returns a value outside [0, 1)
 * @throws {unknown} (as a rejection) the last error of `fn`, or the abort reason of `signal`
 * @example
 * let calls = 0;
 * function flaky(): Promise<string> { calls++; return calls < 3 ? Promise.reject(new Error('busy')) : Promise.resolve('ok'); }
 * await retry(flaky, { retries: 5, delay: 10, maxDelay: 2000, jitter: true }); // => 'ok'
 * calls; // => 3
 */
export async function retry<T>(fn: (attempt: number) => Promise<T> | T, options: RetryOptions = {}, random: RandomGenerator = Math.random): Promise<T> {
	const { retries = 3, delay = 0, factor = 2, maxDelay = Infinity, jitter = false, shouldRetry, onRetry, signal } = options;

	assertFunction('retry', 'fn', fn);
	assertInteger('retry', 'retries', retries, 0, true);
	assertNumber('retry', 'delay', delay, delay >= 0 && delay < Infinity, 'a finite number >= 0');
	assertNumber('retry', 'factor', factor, factor > 0 && factor < Infinity, 'a finite number > 0');
	assertNumber('retry', 'maxDelay', maxDelay, maxDelay >= 0, 'a number >= 0');
	if (shouldRetry !== undefined) assertFunction('retry', 'shouldRetry', shouldRetry);
	if (onRetry !== undefined) assertFunction('retry', 'onRetry', onRetry);
	if (jitter) assertFunction('retry', 'random', random);
	assertOptionalSignal('retry', 'signal', signal);

	for (let attempt = 1; ; attempt++) {
		if (signal?.aborted) throw abortReason(signal);

		try {
			return await fn(attempt);
		} catch (error) {
			if (attempt > retries) throw error;
			// Aborted while the attempt was running: no retry will happen, so don't ask about or announce one.
			if (signal?.aborted) throw abortReason(signal);
			if (shouldRetry !== undefined && !shouldRetry(error, attempt)) throw error;

			onRetry?.(error, attempt);

			// A zero delay stays zero: once `factor ** n` overflows, `0 * Infinity` would be `NaN`.
			const base = delay === 0 ? 0 : Math.min(delay * factor ** (attempt - 1), maxDelay, MAX_TIMEOUT);
			const wait = jitter ? draw('retry', random) * base : base;

			// Always yield to the event loop, even for a zero delay: a synchronously throwing `fn` with `retries: Infinity` would otherwise
			// spin forever without ever returning control, and an abort fired by a timer or by I/O could never be observed.
			await sleep(wait, { signal });
		}
	}
}

/**
 * Options accepted by {@link mapWithConcurrency}, {@link mapSettledWithConcurrency} and {@link filterWithConcurrency}.
 */
export interface ConcurrencyOptions {
	/** Maximum number of callbacks in flight (an integer >= 1, or `Infinity`). Defaults to `Infinity`. */
	concurrency?: number;
	/**
	 * Aborting it stops starting new items and rejects straight away with the signal's `reason` (or an {@link AbortError}); callbacks
	 * already running are not interrupted (their outcome is ignored), but they receive the signal as their third argument.
	 */
	signal?: AbortSignalLike | null;
	/**
	 * `true` (the default): reject with the first error and start no further items. `false`: process every item, then reject with an
	 * `AggregateError` holding every error (in the order they occurred) if any callback failed.
	 */
	stopOnError?: boolean;
}

/**
 * A callback run by the `*WithConcurrency` helpers: receives the item, its index and the caller's abort signal.
 * @template T - The item type
 * @template R - The result type
 */
export type ConcurrentCallback<T, R> = (item: T, index: number, signal: AbortSignalLike | undefined) => PromiseLike<R> | R;

/**
 * Runs `callback` on every element of `list` with bounded concurrency (see {@link ConcurrencyOptions}).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} name - Name of the callback parameter, used in error messages
 * @param {Iterable<unknown>} items - The items (consumed eagerly)
 * @param {ConcurrentCallback<unknown, unknown>} callback - The callback
 * @param {number | ConcurrencyOptions | undefined} options - The concurrency, or the options
 * @returns {Promise<unknown[]>} The results, in input order
 */
function runConcurrently(
	caller: string,
	name: string,
	items: Iterable<unknown>,
	callback: ConcurrentCallback<unknown, unknown>,
	options: number | ConcurrencyOptions | undefined
): Promise<unknown[]> {
	const { concurrency = Infinity, signal, stopOnError = true } = typeof options === 'object' && options !== null ? options : { concurrency: options };
	let list: unknown[];

	// Argument errors, an aborted signal and (on the fast path) synchronous throws become rejections.
	try {
		assertInteger(caller, 'concurrency', concurrency, 1, true);
		assertFunction(caller, name, callback);
		assertOptionalSignal(caller, 'signal', signal);
		if (signal?.aborted) throw abortReason(signal);

		list = Array.from(items);

		// Every item can start at once and nothing can stop the run early except a failure: map them directly (same behaviour as below,
		// much cheaper than tracking slots).
		if (concurrency >= list.length && signal == null && stopOnError) {
			const started: unknown[] = [];

			for (let index = 0; index < list.length; index++) {
				try {
					started.push(callback(list[index], index, undefined));
				} catch (error) {
					// The items already started keep running; their outcome is ignored (and their rejections are handled).
					Promise.all(started).catch(noop);
					throw error;
				}
			}

			return Promise.all(started);
		}
	} catch (error) {
		return Promise.reject(error);
	}

	return new Promise<unknown[]>(function (resolve, reject) {
		const results: unknown[] = [];
		const errors: unknown[] = [];
		const mapperSignal = signal ?? undefined;
		let next = 0;
		let running = 0;
		let done = false;

		/**
		 * Settles the returned promise once and removes the abort listener.
		 * @param {(value: never) => void} settle - `resolve` or `reject`
		 * @param {unknown} value - The value or reason
		 * @returns {void}
		 */
		function finish(settle: (value: never) => void, value: unknown): void {
			if (done) return;
			done = true;
			signal?.removeEventListener('abort', onAbort);
			settle(value as never);
		}

		/**
		 * Abort listener.
		 * @returns {void}
		 */
		function onAbort(): void {
			finish(reject, abortReason(signal as AbortSignalLike));
		}

		/**
		 * Records a failed callback: rejects at once with `stopOnError`, otherwise collects the error.
		 * @param {unknown} error - The error
		 * @returns {void}
		 */
		function failed(error: unknown): void {
			if (stopOnError) finish(reject, error);
			else errors.push(error);
		}

		/**
		 * Starts items while slots are free, and settles once every item has completed.
		 * @returns {void}
		 */
		function launch(): void {
			while (!done && running < concurrency && next < list.length) {
				const index = next++;
				let outcome: unknown;

				try {
					outcome = callback(list[index], index, mapperSignal);
				} catch (error) {
					// A synchronous throw is handled before the next item starts (so `stopOnError` starts nothing more).
					failed(error);
					continue;
				}

				running++;
				Promise.resolve(outcome).then(
					function (value) {
						results[index] = value;
						release();
					},
					function (error: unknown) {
						failed(error);
						release();
					}
				);
			}

			if (running === 0 && next >= list.length) {
				if (errors.length > 0) finish(reject, new AggregateError(errors, `${caller}: ${errors.length} of ${list.length} items failed`));
				else finish(resolve, results);
			}
		}

		/**
		 * Frees the slot of a completed callback.
		 * @returns {void}
		 */
		function release(): void {
			running--;
			launch();
		}

		signal?.addEventListener('abort', onAbort);
		launch();
	});
}

/**
 * Maps `items` with an async `mapper`, running at most `concurrency` mappers at the same time, and resolves with the results in input
 * order. The third argument is either the concurrency or a {@link ConcurrencyOptions} object:
 * - `stopOnError` (default `true`) rejects with the first error and starts no further items (mappers already running are not
 *   cancelled; their outcome is ignored and their rejections are handled). With `false`, every item is processed and the promise then
 *   rejects with an `AggregateError` of all the errors if any mapper failed.
 * - `signal` stops starting new items and rejects at once with the signal's `reason`; it is also passed to every mapper as its third
 *   argument, so mappers can cancel their own work (e.g. `fetch(url, { signal })`). The abort listener is removed on settle.
 * @template T - The item type
 * @template R - The mapped value type
 * @param {Iterable<T>} items - The items to map (consumed eagerly)
 * @param {ConcurrentCallback<T, R>} mapper - The (possibly async) mapping function, called with `(item, index, signal)`
 * @param {number | ConcurrencyOptions} [options=Infinity] - The maximum number of mappers in flight, or `{ concurrency, signal, stopOnError }`
 * @returns {Promise<R[]>} The mapped values, in input order
 * @throws {TypeError} (as a rejection) when `mapper` is not a function, `concurrency` is not a number, or `signal` is not a signal
 * @throws {RangeError} (as a rejection) when `concurrency` is not an integer >= 1 or `Infinity`
 * @throws {AggregateError} (as a rejection) with `stopOnError: false`, when at least one mapper failed
 * @throws {unknown} (as a rejection) the first error thrown or rejected by `mapper`, or the abort reason of `signal`
 * @example
 * async function size(name: string): Promise<number> { await sleep(5); return name.length; }
 * await mapWithConcurrency(['a', 'bb', 'ccc'], size, 2); // => [1, 2, 3] // in input order, at most 2 running at once
 * @example
 * const controller = new AbortController();
 * async function load(id: number, index: number, signal?: AbortSignalLike): Promise<number> { await sleep(20, { signal }); return id; }
 * const pages = mapWithConcurrency([1, 2, 3], load, { concurrency: 2, signal: controller.signal });
 * controller.abort(new AbortError('navigated away'));
 * await pages; // throws AbortError
 */
export function mapWithConcurrency<T, R>(items: Iterable<T>, mapper: ConcurrentCallback<T, R>, options?: number | ConcurrencyOptions): Promise<R[]> {
	return runConcurrently('mapWithConcurrency', 'mapper', items, mapper as ConcurrentCallback<unknown, unknown>, options) as Promise<R[]>;
}

/**
 * Turns a fulfilled value into a `PromiseFulfilledResult`.
 * @param {unknown} value - The value
 * @returns {PromiseFulfilledResult<unknown>} The settled result
 */
function fulfilled(value: unknown): PromiseFulfilledResult<unknown> {
	return { status: 'fulfilled', value };
}

/**
 * Turns a rejection reason into a `PromiseRejectedResult`.
 * @param {unknown} reason - The reason
 * @returns {PromiseRejectedResult} The settled result
 */
function rejected(reason: unknown): PromiseRejectedResult {
	return { status: 'rejected', reason };
}

/**
 * Like {@link mapWithConcurrency}, but never rejects because of a mapper: resolves with a `PromiseSettledResult` per item, in input
 * order (like `Promise.allSettled`). It still rejects for invalid arguments, and with the signal's `reason` when `signal` aborts
 * (no new items start; `stopOnError` has no effect).
 * @template T - The item type
 * @template R - The mapped value type
 * @param {Iterable<T>} items - The items to map (consumed eagerly)
 * @param {ConcurrentCallback<T, R>} mapper - The (possibly async) mapping function, called with `(item, index, signal)`
 * @param {number | ConcurrencyOptions} [options=Infinity] - The maximum number of mappers in flight, or `{ concurrency, signal }`
 * @returns {Promise<Array<PromiseSettledResult<Awaited<R>>>>} The outcome of every item, in input order
 * @throws {TypeError} (as a rejection) when `mapper` is not a function, `concurrency` is not a number, or `signal` is not a signal
 * @throws {RangeError} (as a rejection) when `concurrency` is not an integer >= 1 or `Infinity`
 * @throws {unknown} (as a rejection) the abort reason of `signal`
 * @example
 * async function parse(text: string): Promise<number> { const n = Number(text); if (Number.isNaN(n)) throw new Error(`bad: ${text}`); return n; }
 * const results = await mapSettledWithConcurrency(['1', 'x'], parse, 2);
 * results[0]; // => { status: 'fulfilled', value: 1 }
 * results[1]; // => { status: 'rejected', reason: new Error('bad: x') }
 */
export async function mapSettledWithConcurrency<T, R>(
	items: Iterable<T>,
	mapper: ConcurrentCallback<T, R>,
	options?: number | ConcurrencyOptions
): Promise<Array<PromiseSettledResult<Awaited<R>>>> {
	assertFunction('mapSettledWithConcurrency', 'mapper', mapper);

	return runConcurrently(
		'mapSettledWithConcurrency',
		'mapper',
		items,
		function (item, index, signal) {
			return invoke(mapper, undefined, [item, index, signal]).then(fulfilled, rejected);
		},
		options
	) as Promise<Array<PromiseSettledResult<Awaited<R>>>>;
}

/**
 * Filters `items` with an async `predicate`, running at most `concurrency` predicates at the same time, and resolves with the items
 * whose predicate returned (or resolved to) a truthy value, in input order. Accepts the same options as {@link mapWithConcurrency}
 * (`concurrency`, `signal`, `stopOnError`), with the same error and abort semantics.
 * @template T - The item type
 * @param {Iterable<T>} items - The items to filter (consumed eagerly)
 * @param {ConcurrentCallback<T, unknown>} predicate - The (possibly async) predicate, called with `(item, index, signal)`
 * @param {number | ConcurrencyOptions} [options=Infinity] - The maximum number of predicates in flight, or `{ concurrency, signal, stopOnError }`
 * @returns {Promise<T[]>} The kept items, in input order
 * @throws {TypeError} (as a rejection) when `predicate` is not a function, `concurrency` is not a number, or `signal` is not a signal
 * @throws {RangeError} (as a rejection) when `concurrency` is not an integer >= 1 or `Infinity`
 * @throws {AggregateError} (as a rejection) with `stopOnError: false`, when at least one predicate failed
 * @throws {unknown} (as a rejection) the first error thrown or rejected by `predicate`, or the abort reason of `signal`
 * @example
 * async function isOnline(host: string): Promise<boolean> { await sleep(5); return host !== 'down.example'; }
 * await filterWithConcurrency(['a.example', 'down.example', 'b.example'], isOnline, { concurrency: 2 }); // => ['a.example', 'b.example']
 */
export function filterWithConcurrency<T, S extends T>(
	items: Iterable<T>,
	predicate: (item: T, index: number, signal: AbortSignalLike | undefined) => item is S,
	options?: number | ConcurrencyOptions
): Promise<S[]>;
/**
 * Filters `items` with an async `predicate`, with bounded concurrency (see the first overload).
 * @template T - The item type
 * @param {Iterable<T>} items - The items to filter (consumed eagerly)
 * @param {ConcurrentCallback<T, unknown>} predicate - The (possibly async) predicate, called with `(item, index, signal)`
 * @param {number | ConcurrencyOptions} [options=Infinity] - The maximum number of predicates in flight, or `{ concurrency, signal, stopOnError }`
 * @returns {Promise<T[]>} The kept items, in input order
 * @example
 * await filterWithConcurrency([1, 2, 3, 4], async function (n) { return n % 2 === 0; }); // => [2, 4]
 */
export function filterWithConcurrency<T>(items: Iterable<T>, predicate: ConcurrentCallback<T, unknown>, options?: number | ConcurrencyOptions): Promise<T[]>;
/**
 * Filters `items` with an async `predicate`, with bounded concurrency (see the first overload).
 * @template T - The item type
 * @param {Iterable<T>} items - The items to filter (consumed eagerly)
 * @param {ConcurrentCallback<T, unknown>} predicate - The (possibly async) predicate
 * @param {number | ConcurrencyOptions} [options=Infinity] - The concurrency, or the options
 * @returns {Promise<T[]>} The kept items, in input order
 */
export async function filterWithConcurrency<T>(items: Iterable<T>, predicate: ConcurrentCallback<T, unknown>, options?: number | ConcurrencyOptions): Promise<T[]> {
	let list: T[] = [];

	/**
	 * Reads `items` only when `runConcurrently` does, after it has checked the arguments and the signal (as for `mapWithConcurrency`).
	 * @yields {T} The items, kept in `list` to filter them afterwards
	 */
	function* deferred(): Generator<T> {
		list = Array.from(items);
		yield* list;
	}

	const keep = await runConcurrently('filterWithConcurrency', 'predicate', { [Symbol.iterator]: deferred }, predicate as ConcurrentCallback<unknown, unknown>, options);

	return list.filter(function (_, index) {
		return keep[index];
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// attemptAsync / createLimiter / pollUntil / promiseAllObject / debounceAsync / sequence
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Awaits a promise (or calls a possibly async function and awaits its result) and captures the outcome as a {@link Result} tuple.
 * The returned promise never rejects: synchronous throws and rejections both become `[error, undefined]`.
 * @template T - The resolved value type
 * @param {PromiseLike<T> | (() => PromiseLike<T> | T)} fnOrPromise - A promise, or a function to call (with no arguments)
 * @returns {Promise<Result<T>>} `[undefined, value]` on success, `[error, undefined]` on failure
 * @example
 * await attemptAsync(Promise.resolve(42)); // => [undefined, 42]
 * const [error, value] = await attemptAsync(function () { return JSON.parse('{'); });
 * error instanceof SyntaxError; // => true
 * value; // => undefined
 */
export async function attemptAsync<T>(fnOrPromise: PromiseLike<T> | (() => PromiseLike<T> | T)): Promise<Result<T>> {
	try {
		const value = typeof fnOrPromise === 'function' ? await fnOrPromise() : await fnOrPromise;

		return [undefined, value];
	} catch (error) {
		return [error, undefined];
	}
}

/**
 * Options accepted by {@link createLimiter}.
 */
export interface LimiterOptions {
	/** When `true`, {@link Limiter.clearQueue} rejects the promises of the discarded tasks with an {@link AbortError}. Defaults to `false` (they never settle). */
	rejectOnClear?: boolean;
	/**
	 * Largest number of tasks allowed to wait for a slot (an integer >= 0, or `Infinity`). Once that many wait, further calls reject
	 * with a `RangeError` straight away, without queueing or running their task. Set it whenever tasks are created from untrusted or
	 * unbounded input (e.g. one per incoming request): an unbounded queue grows until the process runs out of memory.
	 * @default Infinity
	 */
	maxPending?: number;
}

/**
 * A concurrency limiter as returned by {@link createLimiter}.
 */
export interface Limiter {
	/**
	 * Runs `fn(...args)` as soon as fewer than `concurrency` tasks are active (immediately and synchronously when a slot is free),
	 * and settles like its result. Synchronous throws become rejections.
	 * @throws {TypeError} (as a rejection) when `fn` is not a function
	 * @throws {RangeError} (as a rejection) when no slot is free and `maxPending` tasks are already waiting
	 */
	<A extends unknown[], T>(fn: (...args: A) => PromiseLike<T> | T, ...args: A): Promise<T>;
	/** Number of tasks currently running. */
	readonly activeCount: number;
	/** Number of tasks waiting for a free slot. */
	readonly pendingCount: number;
	/** Discards the waiting tasks (running tasks are not affected). */
	clearQueue(): void;
}

/**
 * A queued limiter task.
 */
interface LimiterTask {
	readonly run: () => void;
	readonly reject: (reason: unknown) => void;
	/** The task queued after this one. */
	next?: LimiterTask;
}

/**
 * Creates a limiter that runs at most `concurrency` tasks at the same time, starting waiting tasks in FIFO order (like `p-limit`).
 * The queue of waiting tasks is unbounded by default: pass `maxPending` to bound it (calls beyond it reject with a `RangeError`)
 * whenever the number of calls is not under your control.
 * @param {number} concurrency - Maximum number of tasks running at once (an integer >= 1, or `Infinity`)
 * @param {LimiterOptions} [options] - `rejectOnClear` (default `false`) and `maxPending` (default `Infinity`)
 * @returns {Limiter} The `limit(fn, ...args)` function, with `activeCount`, `pendingCount` and `clearQueue()`
 * @throws {TypeError} when `concurrency` or `maxPending` is not a number
 * @throws {RangeError} when `concurrency` is not an integer >= 1 or `Infinity`, or `maxPending` is not an integer >= 0 or `Infinity`
 * @example
 * const limit = createLimiter(2);
 * async function double(n: number): Promise<number> { await sleep(5); return n * 2; }
 * const results = Promise.all([1, 2, 3].map(function (n) { return limit(double, n); }));
 * limit.activeCount; // => 2
 * limit.pendingCount; // => 1
 * await results; // => [2, 4, 6]
 * @example
 * const limit = createLimiter(1, { maxPending: 1 });
 * const running = limit(sleep, 5);
 * const queued = limit(sleep, 5);
 * await limit(sleep, 5); // throws RangeError // the queue is full
 * await Promise.all([running, queued]);
 */
export function createLimiter(concurrency: number, options: LimiterOptions = {}): Limiter {
	assertInteger('createLimiter', 'concurrency', concurrency, 1, true);

	const { rejectOnClear = false, maxPending = Infinity } = options;
	assertInteger('createLimiter', 'maxPending', maxPending, 0, true);
	// The waiting tasks form a linked FIFO queue (O(1) enqueue and dequeue, no array to compact).
	let first: LimiterTask | undefined;
	let last: LimiterTask | undefined;
	let pending = 0;
	let active = 0;

	/**
	 * Starts waiting tasks while slots are free.
	 * @returns {void}
	 */
	function startNext(): void {
		while (active < concurrency && first !== undefined) {
			const task = first;
			first = task.next;
			pending--;
			task.run();
		}
	}

	/**
	 * The limiter function.
	 * @param {(...args: unknown[]) => unknown} fn - The task
	 * @param {...unknown} args - Arguments for the task
	 * @returns {Promise<unknown>} Settles like the task
	 */
	function limit(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
		return new Promise<unknown>(function (resolve, reject) {
			assertFunction('createLimiter', 'fn', fn);

			/**
			 * Runs the task in a slot and releases the slot once it settles.
			 * @returns {void}
			 */
			function run(): void {
				active++;

				invoke(fn, undefined, args)
					.then(resolve, reject)
					.then(function () {
						active--;
						startNext();
					});
			}

			if (active < concurrency) {
				run();
				return;
			}
			if (pending >= maxPending) {
				reject(new RangeError(`createLimiter: the queue is full (\`maxPending\` is ${maxPending})`));
				return;
			}

			const task: LimiterTask = { run, reject };
			// `last` is stale once the queue has drained, so it is only followed while `first` is set.
			if (first === undefined) first = task;
			else (last as LimiterTask).next = task;
			last = task;
			pending++;
		});
	}

	Object.defineProperties(limit, {
		activeCount: {
			get: function (): number {
				return active;
			}
		},
		pendingCount: {
			get: function (): number {
				return pending;
			}
		},
		clearQueue: {
			value: function clearQueue(): void {
				let task = first;

				first = undefined;
				pending = 0;

				for (; rejectOnClear && task !== undefined; task = task.next) {
					task.reject(new AbortError('The task was removed from the limiter queue.'));
				}
			}
		}
	});

	return limit as unknown as Limiter;
}

// ---------------------------------------------------------------------------------------------------------------------
// createQueue / createRateLimiter
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link createQueue}.
 */
export interface QueueOptions {
	/** Maximum number of tasks running at once (an integer >= 1, or `Infinity`). Defaults to `Infinity`. */
	concurrency?: number;
	/**
	 * Aborting it removes every waiting task and rejects its promise with the signal's `reason` (or an {@link AbortError}), and so does
	 * every later `add`. Running tasks are not interrupted: they receive the signal and settle on their own.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * Options accepted by {@link Queue.add}.
 */
export interface QueueAddOptions {
	/** Tasks with a higher priority start first; tasks of equal priority start in the order they were added. Defaults to `0`. */
	priority?: number;
	/**
	 * Aborting it before the task starts removes the task from the queue (it never runs) and rejects its promise with the signal's
	 * `reason`. Once started, the task receives it (combined with the queue's signal, when both are set).
	 */
	signal?: AbortSignalLike | null;
}

/**
 * A priority task queue as returned by {@link createQueue}.
 */
export interface Queue {
	/**
	 * Adds a task and returns a promise that settles like it. The task is called with an abort signal (see {@link QueueAddOptions.signal})
	 * when it starts: immediately and synchronously if a slot is free, nothing is waiting and the queue is not paused. Synchronous throws
	 * become rejections.
	 * @throws {TypeError} (as a rejection) when `task` is not a function, `priority` is not a number, or `signal` is not a signal
	 * @throws {RangeError} (as a rejection) when `priority` is `NaN`
	 */
	add<T>(task: (signal: AbortSignalLike | undefined) => PromiseLike<T> | T, options?: QueueAddOptions): Promise<T>;
	/** Number of tasks waiting to start. */
	readonly size: number;
	/** Number of tasks running. */
	readonly pending: number;
	/** Whether the queue is paused. */
	readonly isPaused: boolean;
	/** Stops starting tasks (running tasks continue) until `resume()` is called. */
	pause(): void;
	/** Starts waiting tasks again, up to the concurrency. */
	resume(): void;
	/** Removes every waiting task, rejecting its promise with an {@link AbortError} (running tasks are not affected). */
	clear(): void;
	/** Resolves as soon as no task is waiting (immediately if none is). Each call returns a new promise, so it can be awaited again later. */
	onEmpty(): Promise<void>;
	/** Resolves as soon as no task is waiting or running (immediately if none is). Each call returns a new promise. */
	onIdle(): Promise<void>;
}

/**
 * A waiting {@link Queue} task.
 */
interface QueueTask {
	readonly priority: number;
	readonly run: () => void;
	readonly reject: (reason: unknown) => void;
	readonly signal: AbortSignalLike | null | undefined;
	readonly onAbort: () => void;
}

/**
 * Orders queue tasks by decreasing priority (ties keep insertion order: the priority queue is stable).
 * @param {QueueTask} a - A task
 * @param {QueueTask} b - Another task
 * @returns {number} A negative number when `a` starts first
 */
function byPriority(a: QueueTask, b: QueueTask): number {
	return b.priority - a.priority;
}

/**
 * Calls and empties a list of waiting resolvers.
 * @param {Array<() => void>} waiters - The resolvers
 * @returns {Array<() => void>} A new, empty list
 */
function wake(waiters: Array<() => void>): Array<() => void> {
	for (const resolve of waiters) resolve();

	return [];
}

/**
 * Creates a task queue that runs at most `concurrency` tasks at the same time, starting the waiting task with the highest `priority`
 * first and tasks of equal priority in FIFO order (a stable binary heap, so `add` and every start are O(log n)). It has no timers.
 *
 * Cancellation is precise: a task whose own `signal` aborts while it waits is removed from the queue (it never runs) and its promise
 * rejects with the signal's `reason`; aborting the queue's `signal` does the same for every waiting task and rejects every later `add`.
 * Running tasks are never interrupted, but they receive the signal(s) to cancel their own work. Listeners are removed as soon as a task
 * starts or leaves the queue.
 * @param {QueueOptions} [options] - `concurrency` (default `Infinity`) and `signal`
 * @returns {Queue} The queue
 * @throws {TypeError} when `concurrency` is not a number or `signal` is not a signal
 * @throws {RangeError} when `concurrency` is not an integer >= 1 or `Infinity`
 * @example
 * const queue = createQueue({ concurrency: 1 });
 * const order: string[] = [];
 * async function job(name: string): Promise<string> { await sleep(5); order.push(name); return name; }
 * queue.add(function () { return job('first'); }); // starts at once
 * queue.add(function () { return job('low'); });
 * queue.add(function () { return job('urgent'); }, { priority: 10 });
 * queue.size; // => 2
 * queue.pending; // => 1
 * await queue.onIdle();
 * order; // => ['first', 'urgent', 'low']
 * @example
 * const queue = createQueue({ concurrency: 1 });
 * const controller = new AbortController();
 * queue.add(function () { return sleep(10); });
 * const waiting = queue.add(function () { return 'never runs'; }, { signal: controller.signal });
 * controller.abort(new AbortError('not needed any more'));
 * await waiting; // throws AbortError
 * queue.size; // => 0
 */
export function createQueue(options: QueueOptions = {}): Queue {
	const { concurrency = Infinity, signal: queueSignal } = options;

	assertInteger('createQueue', 'concurrency', concurrency, 1, true);
	assertOptionalSignal('createQueue', 'signal', queueSignal);

	const waiting = createPriorityQueue(byPriority);
	let running = 0;
	let paused = false;
	let emptyWaiters: Array<() => void> = [];
	let idleWaiters: Array<() => void> = [];

	/**
	 * Resolves the `onEmpty` / `onIdle` promises whose condition now holds.
	 * @returns {void}
	 */
	function notify(): void {
		if (waiting.size > 0) return;
		emptyWaiters = wake(emptyWaiters);
		if (running === 0) idleWaiters = wake(idleWaiters);
	}

	/**
	 * Starts waiting tasks while slots are free and the queue is not paused.
	 * @returns {void}
	 */
	function startNext(): void {
		while (!paused && running < concurrency && waiting.size > 0) (waiting.pop() as QueueTask).run();
		notify();
	}

	/**
	 * Removes every waiting task and rejects its promise.
	 * @param {unknown} reason - The rejection reason
	 * @returns {void}
	 */
	function drop(reason: unknown): void {
		for (let task = waiting.pop(); task !== undefined; task = waiting.pop()) {
			task.signal?.removeEventListener('abort', task.onAbort);
			task.reject(reason);
		}
		notify();
	}

	queueSignal?.addEventListener(
		'abort',
		function () {
			drop(abortReason(queueSignal));
		},
		{ once: true }
	);

	return {
		add<T>(task: (signal: AbortSignalLike | undefined) => PromiseLike<T> | T, addOptions: QueueAddOptions = {}): Promise<T> {
			return new Promise<T>(function (resolve, reject) {
				const { priority = 0, signal } = addOptions;

				assertFunction('Queue.add', 'task', task);
				assertNumber('Queue.add', 'priority', priority, priority === priority, 'a number');
				assertOptionalSignal('Queue.add', 'signal', signal);
				if (queueSignal?.aborted) throw abortReason(queueSignal);
				if (signal?.aborted) throw abortReason(signal);

				/**
				 * Starts the task in a slot and frees the slot once it settles.
				 * @returns {void}
				 */
				function run(): void {
					signal?.removeEventListener('abort', onAbort);

					// The task sees both signals; the combined one is detached from them once the task settles.
					const [taskSignal, release] = signal && queueSignal ? combineSignals('createQueue', [signal, queueSignal]) : [signal ?? queueSignal ?? undefined, noop];
					running++;
					(invoke(task, undefined, [taskSignal]) as Promise<T>).then(resolve, reject).then(function () {
						release();
						running--;
						startNext();
					});
				}

				/**
				 * Abort listener of a waiting task: removes it from the queue and rejects its promise.
				 * @returns {void}
				 */
				function onAbort(): void {
					waiting.delete(entry);
					reject(abortReason(signal as AbortSignalLike));
					notify();
				}

				const entry: QueueTask = { priority, run, reject, signal, onAbort };

				if (!paused && running < concurrency && waiting.size === 0) {
					run();
				} else {
					waiting.push(entry);
					signal?.addEventListener('abort', onAbort, { once: true });
				}
			});
		},
		get size(): number {
			return waiting.size;
		},
		get pending(): number {
			return running;
		},
		get isPaused(): boolean {
			return paused;
		},
		pause(): void {
			paused = true;
		},
		resume(): void {
			paused = false;
			startNext();
		},
		clear(): void {
			drop(new AbortError('The task was removed from the queue.'));
		},
		onEmpty(): Promise<void> {
			return new Promise<void>(function (resolve) {
				if (waiting.size === 0) resolve();
				else emptyWaiters.push(resolve);
			});
		},
		onIdle(): Promise<void> {
			return new Promise<void>(function (resolve) {
				if (waiting.size === 0 && running === 0) resolve();
				else idleWaiters.push(resolve);
			});
		}
	};
}

/**
 * Options accepted by {@link createRateLimiter}.
 */
export interface RateLimiterOptions {
	/** Maximum number of calls that may start within any window of `interval` milliseconds (an integer >= 1). */
	limit: number;
	/** Length of the sliding window in milliseconds (`0` to `2^31 - 1`). */
	interval: number;
	/**
	 * Aborting it rejects every waiting call (and every later one) with the signal's `reason` (or an {@link AbortError}) and clears the
	 * timer. Calls already started are not affected.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * A rate limiter as returned by {@link createRateLimiter}.
 */
export interface RateLimiter {
	/**
	 * Calls `fn(...args)` as soon as the rate limit allows it (immediately and synchronously when it does and no call is waiting), and
	 * settles like its result. Calls start in FIFO order and are never dropped. Synchronous throws become rejections.
	 * @throws {TypeError} (as a rejection) when `fn` is not a function
	 */
	schedule<A extends unknown[], T>(fn: (...args: A) => PromiseLike<T> | T, ...args: A): Promise<T>;
	/**
	 * Returns a rate-limited version of `fn`: every call goes through {@link RateLimiter.schedule} (with `this` forwarded) and returns a promise.
	 * @throws {TypeError} when `fn` is not a function
	 */
	wrap<A extends unknown[], T, This = unknown>(fn: (this: This, ...args: A) => PromiseLike<T> | T): (this: This, ...args: A) => Promise<Awaited<T>>;
	/** Number of calls waiting for the rate limit. */
	readonly pendingCount: number;
	/** Removes every waiting call, rejecting its promise with an {@link AbortError}, and clears the timer. */
	clearQueue(): void;
}

/**
 * A waiting rate-limited call.
 */
interface RateLimitedCall {
	readonly start: () => void;
	readonly reject: (reason: unknown) => void;
	/** The call queued after this one. */
	next?: RateLimitedCall;
}

/**
 * Creates a rate limiter that starts at most `limit` calls within any window of `interval` milliseconds. Calls beyond the limit are
 * queued (never dropped, unlike `throttle`) and start in FIFO order as soon as the window allows.
 *
 * The window slides (it is "strict"): a call may start only once the call `limit` starts before it started at least `interval` ms ago.
 * Fixed windows, the default of several libraries, let `2 × limit` calls through around a window boundary. Only the start times of the
 * last `limit` calls are kept, and at most one timer exists, only while calls are waiting: an idle limiter holds no timer, so it never
 * keeps a process alive. `limit` caps how often calls start, not how many run at once (combine with {@link createLimiter} for that).
 * @param {RateLimiterOptions} options - `limit`, `interval` and an optional `signal`
 * @returns {RateLimiter} The limiter, with `schedule`, `wrap`, `pendingCount` and `clearQueue`
 * @throws {TypeError} when `options` is not an object, `limit` or `interval` is not a number, or `signal` is not a signal
 * @throws {RangeError} when `limit` is not an integer >= 1, or `interval` is not between `0` and `2^31 - 1`
 * @example
 * const limiter = createRateLimiter({ limit: 2, interval: 50 });
 * const started: number[] = [];
 * const begin = Date.now();
 * function call(id: number): number { started.push(Date.now() - begin); return id; }
 * await Promise.all([1, 2, 3].map(function (id) { return limiter.schedule(call, id); })); // => [1, 2, 3]
 * started[1] < 50; // => true // the first two start at once
 * started[2] >= 49; // => true // the third waits for the window to slide
 * @example
 * // doctest: skip
 * const search = createRateLimiter({ limit: 5, interval: 1000 }).wrap(function (query: string) { return fetch(`/api?q=${query}`); });
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
	if (typeof options !== 'object' || options === null) throw new TypeError(`createRateLimiter: \`options\` must be an object, got ${describe(options)}`);

	const { limit, interval, signal } = options;

	assertInteger('createRateLimiter', 'limit', limit, 1);
	assertDelay('createRateLimiter', 'interval', interval);
	assertOptionalSignal('createRateLimiter', 'signal', signal);

	// The start times of the last `limit` calls, as a ring buffer whose oldest entry is at `cursor` once it is full.
	const starts: number[] = [];
	let cursor = 0;
	// The waiting calls form a linked FIFO queue.
	let first: RateLimitedCall | undefined;
	let last: RateLimitedCall | undefined;
	let pending = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let draining = false;

	/**
	 * Records a start now if the window allows one.
	 * @returns {number} `0` or less when a start was recorded, otherwise how many milliseconds to wait for the window to allow one
	 */
	function admit(): number {
		const now = Date.now();
		const full = starts.length === limit;

		// A start "in the future" means the clock went back: count it as starting now, so the wait never exceeds `interval`.
		if (full && starts[cursor] > now) starts[cursor] = now;

		// The oldest of the last `limit` starts must be `interval` ms old.
		const wait = full ? starts[cursor] + interval - now : 0;

		if (wait <= 0) {
			if (full) {
				starts[cursor] = now;
				cursor = (cursor + 1) % limit;
			} else {
				starts.push(now);
			}
		}

		return wait;
	}

	/**
	 * Starts waiting calls while the window allows it, then arms a timer for the next one (if any is still waiting).
	 * @returns {void}
	 */
	function drain(): void {
		timer = undefined;
		draining = true;

		while (first !== undefined) {
			const wait = admit();

			if (wait > 0) {
				timer = setTimeout(drain, wait);
				break;
			}

			const call = first;

			first = call.next;
			pending--;
			call.start();
		}

		draining = false;
	}

	/**
	 * Clears the timer and rejects every waiting call.
	 * @param {unknown} reason - The rejection reason
	 * @returns {void}
	 */
	function drop(reason: unknown): void {
		clearTimeout(timer);
		timer = undefined;

		let call = first;

		first = undefined;
		pending = 0;
		for (; call !== undefined; call = call.next) call.reject(reason);
	}

	signal?.addEventListener(
		'abort',
		function () {
			drop(abortReason(signal));
		},
		{ once: true }
	);

	/**
	 * Queues a call (see {@link RateLimiter.schedule}).
	 * @param {(...args: unknown[]) => unknown} fn - The function to call
	 * @param {...unknown} args - Its arguments
	 * @returns {Promise<unknown>} Settles like the call
	 */
	function schedule(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown> {
		return new Promise<unknown>(function (resolve, reject) {
			assertFunction('RateLimiter.schedule', 'fn', fn);
			if (signal?.aborted) throw abortReason(signal);

			/**
			 * Calls `fn` and settles like it.
			 * @returns {void}
			 */
			function start(): void {
				try {
					resolve(fn(...args));
				} catch (error) {
					reject(error);
				}
			}

			// Nothing waits and the window allows it: start now (no timer exists while nothing waits).
			if (first === undefined && admit() <= 0) {
				start();
				return;
			}

			const call: RateLimitedCall = { start, reject };

			// `last` is stale once the queue has drained, so it is only followed while `first` is set.
			if (first === undefined) first = call;
			else (last as RateLimitedCall).next = call;
			last = call;
			pending++;
			// A call scheduled from a starting call is picked up by the running drain loop.
			if (timer === undefined && !draining) drain();
		});
	}

	return {
		schedule: schedule as RateLimiter['schedule'],
		wrap<A extends unknown[], T, This = unknown>(fn: (this: This, ...args: A) => PromiseLike<T> | T): (this: This, ...args: A) => Promise<Awaited<T>> {
			assertFunction('RateLimiter.wrap', 'fn', fn);

			return function rateLimited(this: This, ...args: A): Promise<Awaited<T>> {
				return schedule(Reflect.apply as (...args: unknown[]) => unknown, fn, this, args) as Promise<Awaited<T>>;
			};
		},
		get pendingCount(): number {
			return pending;
		},
		clearQueue(): void {
			drop(new AbortError('The call was removed from the rate limiter queue.'));
		}
	};
}

/**
 * Values considered falsy by JavaScript, removed from a type by {@link Truthy}.
 */
type Falsy = false | 0 | 0n | '' | null | undefined;

/**
 * `T` without its falsy members (`false`, `0`, `0n`, `''`, `null`, `undefined`).
 * @template T - The type to narrow
 * @example
 * type T = Truthy<string | null>; // string
 */
export type Truthy<T> = Exclude<T, Falsy>;

/**
 * Options accepted by {@link pollUntil}.
 */
export interface PollOptions {
	/** Delay in ms between the end of one check and the start of the next. Defaults to `100`. */
	interval?: number;
	/** Overall time limit in ms, after which the promise rejects with a {@link TimeoutError}. Defaults to `Infinity`. */
	timeout?: number;
	/** Stops polling, rejecting with the signal's `reason` (or an {@link AbortError}). */
	signal?: AbortSignalLike;
}

/**
 * Calls `check` immediately and then every `interval` ms (waiting for async checks to settle in between, so checks never overlap)
 * until it returns (or resolves to) a truthy value, and resolves with that value. All timers and listeners are cleaned up on settle.
 * @template T - The value produced by `check`
 * @param {() => T | PromiseLike<T>} check - The condition to poll
 * @param {PollOptions} [options] - `interval` (100), `timeout` (Infinity) and `signal`
 * @returns {Promise<Truthy<Awaited<T>>>} The first truthy value
 * @throws {TimeoutError} (as a rejection) when no truthy value was produced within `timeout` ms
 * @throws {RangeError} (as a rejection) when `interval` is not a number between `0` and `2^31 - 1`, or `timeout` is neither such a number nor `Infinity`
 * @throws {TypeError} (as a rejection) when `check` is not a function, or `interval` or `timeout` is not a number
 * @throws {unknown} (as a rejection) the error thrown or rejected by `check`, or the abort reason of `signal`
 * @example
 * let status = 'loading';
 * setTimeout(function () { status = 'ready'; }, 30);
 * await pollUntil(function () { return status === 'ready' && status; }, { interval: 10, timeout: 5000 }); // => 'ready'
 * await pollUntil(function () { return false; }, { interval: 10, timeout: 50 }); // throws TimeoutError
 */
export function pollUntil<T>(check: () => T | PromiseLike<T>, options: PollOptions = {}): Promise<Truthy<Awaited<T>>> {
	return new Promise<Truthy<Awaited<T>>>(function (resolve, reject) {
		const { interval = 100, timeout = Infinity, signal } = options;

		assertFunction('pollUntil', 'check', check);
		assertDelay('pollUntil', 'interval', interval);
		assertDelay('pollUntil', 'timeout', timeout, true);
		assertOptionalSignal('pollUntil', 'signal', signal);

		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}

		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const deadlineTimer =
			timeout === Infinity
				? undefined
				: setTimeout(function () {
						finish(reject, new TimeoutError(`pollUntil: condition not met within ${timeout} ms`));
					}, timeout);

		/**
		 * Settles the promise once and releases timers and the abort listener.
		 * @param {(value: never) => void} settle - `resolve` or `reject`
		 * @param {unknown} value - The value or reason
		 * @returns {void}
		 */
		function finish(settle: (value: never) => void, value: unknown): void {
			// Idempotent: everything below is a no-op the second time.
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(deadlineTimer);
			signal?.removeEventListener('abort', onAbort);
			settle(value as never);
		}

		/**
		 * Abort listener.
		 * @returns {void}
		 */
		function onAbort(): void {
			finish(reject, abortReason(signal as AbortSignalLike));
		}

		/**
		 * Runs one check and schedules the next one if needed.
		 * @returns {void}
		 */
		function poll(): void {
			pollTimer = undefined;

			(invoke(check, undefined, []) as Promise<Awaited<T>>).then(
				function (value) {
					if (settled) return;
					if (value) {
						finish(resolve, value);
					} else {
						pollTimer = setTimeout(poll, interval);
					}
				},
				function (error: unknown) {
					finish(reject, error);
				}
			);
		}

		// `finish` removes it, so it never runs twice.
		signal?.addEventListener('abort', onAbort);
		poll();
	});
}

/**
 * Collects own enumerable string and symbol keys of a plain input object for the `promiseAll*Object` helpers.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} obj - The input
 * @returns {PropertyKey[]} The keys
 * @throws {TypeError} when `obj` is not a non-array object
 */
function objectKeys(caller: string, obj: unknown): PropertyKey[] {
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
		throw new TypeError(`${caller}: expected a non-array object, got ${Array.isArray(obj) ? 'an array' : describe(obj)}`);
	}

	const keys: PropertyKey[] = Object.keys(obj);

	for (const symbol of Object.getOwnPropertySymbols(obj)) {
		if (Object.prototype.propertyIsEnumerable.call(obj, symbol)) keys.push(symbol);
	}

	return keys;
}

/**
 * Builds a plain object from parallel key/value lists. `Object.fromEntries` defines the properties, so keys like `__proto__` (or ones
 * with a setter on a polluted `Object.prototype`) stay ordinary own properties.
 * @param {PropertyKey[]} keys - The keys
 * @param {unknown[]} values - The values, in key order
 * @returns {Record<PropertyKey, unknown>} The new object
 */
function zipObject(keys: PropertyKey[], values: unknown[]): Record<PropertyKey, unknown> {
	return Object.fromEntries(
		keys.map(function (key, i): [PropertyKey, unknown] {
			return [key, values[i]];
		})
	);
}

/**
 * Like `Promise.all`, but for an object of promises (or values): resolves with an object with the same keys and the awaited values.
 * Rejects with the first rejection. Own enumerable string and symbol keys are used; the input is not mutated.
 * @template T - The input object type
 * @param {T} obj - An object whose values are promises or plain values
 * @returns {Promise<{ [K in keyof T]: Awaited<T[K]> }>} The awaited values, keyed like `obj`
 * @throws {TypeError} (as a rejection) when `obj` is not a non-array object
 * @example
 * await promiseAllObject({ user: Promise.resolve('Ada'), posts: sleep(5).then(function () { return [1, 2]; }) }); // => { user: 'Ada', posts: [1, 2] }
 */
export async function promiseAllObject<T extends object>(obj: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	const keys = objectKeys('promiseAllObject', obj);
	const values = await Promise.all(
		keys.map(function (key) {
			return (obj as Record<PropertyKey, unknown>)[key];
		})
	);

	return zipObject(keys, values) as { -readonly [K in keyof T]: Awaited<T[K]> };
}

/**
 * Like `Promise.allSettled`, but for an object of promises (or values): resolves with an object with the same keys and a
 * `PromiseSettledResult` for each value. Never rejects (except for invalid input). Own enumerable string and symbol keys are used.
 * @template T - The input object type
 * @param {T} obj - An object whose values are promises or plain values
 * @returns {Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }>} The settled results, keyed like `obj`
 * @throws {TypeError} (as a rejection) when `obj` is not a non-array object
 * @example
 * const results = await promiseAllSettledObject({ a: Promise.resolve(1), b: Promise.reject(new Error('x')) });
 * results.a; // => { status: 'fulfilled', value: 1 }
 * results.b; // => { status: 'rejected', reason: Error('x') }
 */
export async function promiseAllSettledObject<T extends object>(obj: T): Promise<{ -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }> {
	const keys = objectKeys('promiseAllSettledObject', obj);
	const values = await Promise.allSettled(
		keys.map(function (key) {
			return (obj as Record<PropertyKey, unknown>)[key];
		})
	);

	return zipObject(keys, values) as { -readonly [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> };
}

/**
 * A debounced async function as returned by {@link debounceAsync}.
 * @template F - The original function type
 */
export interface DebouncedAsync<F extends (...args: never[]) => unknown> {
	(this: ThisParameterType<F>, ...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
	/** Cancels the pending invocation; the promises of the current burst reject with an {@link AbortError}. */
	cancel(): void;
	/** Performs the pending invocation now and returns its shared promise (`undefined` when nothing is pending). */
	flush(): Promise<Awaited<ReturnType<F>>> | undefined;
}

/**
 * Creates a debounced version of a (possibly async) function: `fn` is invoked `wait` ms after the last call of a burst, with the latest
 * `this` and arguments, and every call of the burst returns a promise that settles with the result of that single invocation.
 * Calls made while an invocation is running start a new burst.
 * @template F - The type of the function to debounce
 * @param {F} fn - The function to debounce
 * @param {number} wait - The quiet period in milliseconds (`0` to `2^31 - 1`)
 * @returns {DebouncedAsync<F>} The debounced function, with `.cancel()` and `.flush()`
 * @throws {TypeError} when `fn` is not a function, or `wait` is not a number
 * @throws {RangeError} when `wait` is negative, `NaN` or larger than `2^31 - 1`
 * @example
 * const queries: string[] = [];
 * const search = debounceAsync(async function (query: string) { queries.push(query); return `results for ${query}`; }, 20);
 * const first = search('a');
 * const second = search('ab');
 * await Promise.all([first, second]); // => ['results for ab', 'results for ab']
 * queries; // => ['ab'] // one call for the whole burst
 */
export function debounceAsync<F extends (...args: never[]) => unknown>(fn: F, wait: number): DebouncedAsync<F> {
	assertFunction('debounceAsync', 'fn', fn);
	assertDelay('debounceAsync', 'wait', wait);

	const call = fn as unknown as (this: unknown, ...args: unknown[]) => unknown;
	let burst: Deferred<unknown> | undefined;

	const debounced = debounce(function (this: unknown, ...args: unknown[]): void {
		const current = burst as Deferred<unknown>;

		// Calls made from now on (including from within `fn`) belong to a new burst.
		burst = undefined;

		try {
			current.resolve(call.apply(this, args));
		} catch (error) {
			current.reject(error);
		}
	}, wait);

	/**
	 * The debounced wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {Promise<unknown>} The shared promise of the current burst
	 */
	function debouncedAsync(this: unknown, ...args: unknown[]): Promise<unknown> {
		if (burst === undefined) burst = createDeferred<unknown>();

		const { promise } = burst;
		debounced.apply(this, args);

		return promise;
	}

	Object.defineProperties(debouncedAsync, {
		cancel: {
			value: function cancel(): void {
				debounced.cancel();
				burst?.reject(new AbortError('The debounced call was cancelled.'));
				burst = undefined;
			}
		},
		flush: {
			value: function flush(): Promise<unknown> | undefined {
				const promise = burst?.promise;

				debounced.flush();

				return promise;
			}
		}
	});

	return debouncedAsync as unknown as DebouncedAsync<F>;
}

/**
 * Options accepted by {@link memoizeAsync}.
 * @template F - The memoized function type
 */
export interface MemoizeAsyncOptions<F extends AnyFunction> {
	/** Computes the cache key from the call arguments (`this` is forwarded). Defaults to `defaultMemoizeKey` (from the functions module). */
	resolver?: (this: ThisParameterType<F>, ...args: Parameters<F>) => unknown;
	/**
	 * Where resolved values are stored. Defaults to a new `Map`, or, with `ttl`, to an unbounded `createLRUCache` (from the cache module).
	 * Pass `createLRUCache({ max })` to bound it. With `ttl`, the cache's `set` is called with `{ ttl }` as its third argument.
	 */
	cache?: MemoizeCache<unknown, Awaited<ReturnType<F>>>;
	/** Time-to-live of every resolved value in milliseconds (`> 0`, or `Infinity`). Defaults to no expiry. */
	ttl?: number;
}

/**
 * An async function memoized with {@link memoizeAsync}.
 * @template F - The original function type
 */
export interface MemoizedAsync<F extends AnyFunction> {
	(this: ThisParameterType<F>, ...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
	/** The cache of resolved values, keyed by the resolver's result. */
	readonly cache: MemoizeCache<unknown, Awaited<ReturnType<F>>>;
	/** Forgets every resolved value and every call in flight (a call in flight still settles its callers, but its value is not cached). */
	clear(): void;
	/** Forgets the resolved value and the call in flight for these arguments; returns whether there was one. */
	delete(...args: Parameters<F>): boolean;
	/**
	 * Calls the memoized function (with `this` undefined) but stops waiting when `signal` aborts: this caller's promise rejects with the
	 * signal's `reason`, while the shared call keeps running for the other callers and still fills the cache. An already-aborted signal
	 * rejects without calling anything.
	 */
	withSignal(signal: AbortSignalLike | null | undefined, ...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
}

/**
 * Memoizes an async (or promise-returning) function, correctly:
 * - Single flight: concurrent calls with the same key share one in-flight call instead of starting one each.
 * - Only resolved values are cached. A rejection (or a synchronous throw) is passed to the callers of that call and then forgotten, so
 *   the next call retries; `memoize` or `once` on an async function would cache the rejected promise forever.
 * - `ttl` expires resolved values; `cache` can be any `Map`-like store, such as `createLRUCache` to bound memory.
 * - `withSignal(signal, ...args)` lets one caller stop waiting without cancelling the work shared with the others.
 * - `clear()` / `delete(...args)` invalidate: a call in flight at that moment does not write its (possibly stale) value to the cache.
 * @template F - The type of the function to memoize
 * @param {F} fn - The function to memoize
 * @param {MemoizeAsyncOptions<F>} [options] - `resolver` (key function), `cache` and `ttl`
 * @returns {MemoizedAsync<F>} The memoized function, with `cache`, `clear()`, `delete(...args)` and `withSignal(signal, ...args)`
 * @throws {TypeError} when `fn` or `resolver` is not a function, or `ttl` is not a number
 * @throws {RangeError} when `ttl` is not a number > 0
 * @example
 * let requests = 0;
 * async function fetchUser(id: number): Promise<{ id: number }> { requests++; await sleep(5); return { id }; }
 * const getUser = memoizeAsync(fetchUser, { ttl: 60_000 });
 * const [a, b] = await Promise.all([getUser(1), getUser(1)]);
 * a === b; // => true
 * await getUser(1); // => { id: 1 } // cached
 * requests; // => 1
 * @example
 * let attempts = 0;
 * const flaky = memoizeAsync(async function (): Promise<string> { attempts++; if (attempts === 1) throw new Error('offline'); return 'ok'; });
 * await flaky(); // throws Error
 * await flaky(); // => 'ok' // the rejection was not cached
 */
export function memoizeAsync<F extends AnyFunction>(fn: F, options: MemoizeAsyncOptions<F> = {}): MemoizedAsync<F> {
	const { resolver = defaultMemoizeKey, ttl } = options;

	assertFunction('memoizeAsync', 'fn', fn);
	assertFunction('memoizeAsync', 'resolver', resolver);
	if (ttl !== undefined) assertNumber('memoizeAsync', 'ttl', ttl, ttl > 0, 'a number > 0 or Infinity');

	const cache = (options.cache ?? (ttl === undefined ? new Map() : createLRUCache({ max: Infinity, ttl }))) as MemoizeCache<unknown, unknown>;
	const setOptions = ttl === undefined ? undefined : { ttl };
	const inflight = new Map<unknown, Promise<unknown>>();
	const call = fn as unknown as (this: unknown, ...args: unknown[]) => unknown;
	const key = resolver as unknown as (this: unknown, ...args: unknown[]) => unknown;

	/**
	 * The memoized wrapper.
	 * @param {...unknown} args - The call arguments
	 * @returns {Promise<unknown>} The cached value, the shared call in flight, or a new call
	 */
	function memoized(this: unknown, ...args: unknown[]): Promise<unknown> {
		let id: unknown;

		try {
			id = key.apply(this, args);
		} catch (error) {
			return Promise.reject(error);
		}

		// Read once, then `has` only for a cached `undefined` (an expiring cache could drop the entry between the two).
		const cached = cache.get(id);
		if (cached !== undefined || cache.has(id)) return Promise.resolve(cached);

		let shared = inflight.get(id);

		if (shared === undefined) {
			const started = invoke(call, this, args);

			// Only the call still registered for this key (not cleared or deleted meanwhile) may write to the cache.
			started.then(
				function (value) {
					if (inflight.get(id) !== started) return;
					inflight.delete(id);
					(cache.set as (key: unknown, value: unknown, options?: { ttl: number }) => unknown)(id, value, setOptions);
				},
				function () {
					if (inflight.get(id) === started) inflight.delete(id);
				}
			);
			inflight.set(id, started);
			shared = started;
		}

		return shared;
	}

	Object.defineProperties(memoized, {
		cache: { value: cache, enumerable: true },
		clear: {
			value: function clear(): void {
				inflight.clear();
				cache.clear();
			}
		},
		delete: {
			value: function (...args: unknown[]): boolean {
				const id = key(...args);
				const removed = inflight.delete(id);

				return cache.delete(id) || removed;
			}
		},
		withSignal: {
			value: function withSignal(signal: AbortSignalLike | null | undefined, ...args: unknown[]): Promise<unknown> {
				return new Promise<unknown>(function (resolve) {
					assertOptionalSignal('memoizeAsync', 'signal', signal);
					if (signal?.aborted) throw abortReason(signal);
					resolve(abortable(memoized(...args), signal));
				});
			}
		}
	});

	return memoized as unknown as MemoizedAsync<F>;
}

/**
 * Runs (possibly async) tasks one at a time, in iteration order, and resolves with their results in the same order. Each task is
 * only pulled from the iterable (and started) after the previous one has settled, so lazy iterables and generators are supported.
 * Rejects with the first error, without starting the remaining tasks.
 * @template T - The task result type
 * @param {Iterable<() => PromiseLike<T> | T>} tasks - The tasks to run
 * @returns {Promise<T[]>} The results, in order
 * @throws {TypeError} (as a rejection) when a task is not a function
 * @throws {unknown} (as a rejection) the first error thrown or rejected by a task
 * @example
 * const log: string[] = [];
 * async function migrate(version: number): Promise<number> { await sleep(10 - version); log.push(`v${version}`); return version; }
 * await sequence([function () { return migrate(1); }, function () { return migrate(2); }]); // => [1, 2]
 * log; // => ['v1', 'v2'] // each task starts after the previous one settled
 */
export async function sequence<T>(tasks: Iterable<() => PromiseLike<T> | T>): Promise<T[]> {
	const results: T[] = [];
	for (const task of tasks) {
		// `typeof` first, so that the parameter name is only formatted on failure.
		if (typeof task !== 'function') assertFunction('sequence', `tasks[${results.length}]`, task);
		results.push(await task());
	}

	return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// AbortSignal combinators: timeoutSignal / anySignal / abortable / throwIfAborted
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The platform's `AbortSignal` type when the consumer's TypeScript environment declares one (DOM or Node typings), and
 * {@link AbortSignalLike} otherwise. {@link timeoutSignal} and {@link anySignal} return real `AbortSignal`s created by the platform's
 * `AbortController`, so their results can be passed straight to `fetch`, `addEventListener` and other platform APIs.
 */
export type PlatformAbortSignal = typeof globalThis extends { AbortSignal: { prototype: infer S } } ? S : AbortSignalLike;

/**
 * The parts of the platform `AbortController` used by this module.
 */
interface AbortControllerLike {
	readonly signal: AbortSignalLike;
	abort(reason?: unknown): void;
}

/**
 * Creates a platform `AbortController`, found through `globalThis` (available in browsers, Node 15+, Deno and Bun).
 * @param {string} caller - Name of the public function, used in the error message
 * @returns {AbortControllerLike} A new controller
 * @throws {Error} when the environment has no `AbortController`
 */
function createAbortController(caller: string): AbortControllerLike {
	const Controller = (globalThis as { AbortController?: new () => AbortControllerLike }).AbortController;
	if (typeof Controller !== 'function') throw new Error(`${caller}: \`AbortController\` is not available in this environment`);
	return new Controller();
}

/**
 * Throws a `TypeError` unless `value` is `null`, `undefined` or looks like an abort signal (an object with `addEventListener` and
 * `removeEventListener` methods).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a signal, `null` or `undefined`
 */
function assertOptionalSignal(caller: string, name: string, value: unknown): asserts value is AbortSignalLike | null | undefined {
	if (value === null || value === undefined) return;
	const signal = value as Partial<AbortSignalLike>;
	if (typeof value !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
		throw new TypeError(`${caller}: \`${name}\` must be an AbortSignal, null or undefined, got ${describe(value)}`);
	}
}

/**
 * Creates an `AbortSignal` that aborts with a {@link TimeoutError} after `ms` milliseconds — like the platform's `AbortSignal.timeout`,
 * but with this library's `TimeoutError` as the reason (so `error instanceof TimeoutError` works across the async helpers).
 *
 * The timer cannot be cancelled and is not `unref`'d (browsers have no such concept): in Node it keeps the process alive until it
 * fires, so prefer short timeouts or an `AbortController` you abort yourself for long-lived work. `Infinity` gives a signal that never
 * aborts (and starts no timer), which is handy for optional timeouts.
 * @param {number} ms - Delay in milliseconds (`0` to `2^31 - 1`, or `Infinity`)
 * @returns {PlatformAbortSignal} A new signal that aborts after `ms` milliseconds
 * @throws {TypeError} when `ms` is not a number
 * @throws {RangeError} when `ms` is negative, `NaN` or larger than `2^31 - 1` (and not `Infinity`)
 * @throws {Error} when the environment has no `AbortController`
 * @example
 * const signal = timeoutSignal(10);
 * signal.aborted; // => false
 * await sleep(30);
 * signal.aborted; // => true
 * signal.reason instanceof TimeoutError; // => true
 * signal.reason.message; // => 'timeoutSignal: timed out after 10 ms'
 * @example
 * // doctest: skip
 * const response = await fetch(url, { signal: timeoutSignal(5000) });
 */
export function timeoutSignal(ms: number): PlatformAbortSignal {
	assertDelay('timeoutSignal', 'ms', ms, true);
	const controller = createAbortController('timeoutSignal');
	if (ms !== Infinity) {
		setTimeout(function () {
			controller.abort(new TimeoutError(`timeoutSignal: timed out after ${ms} ms`));
		}, ms);
	}
	return controller.signal as PlatformAbortSignal;
}

/**
 * Combines abort signals: returns a new `AbortSignal` that aborts as soon as any of the inputs aborts, with that input's `reason`
 * (or an {@link AbortError} when it has none) — like the platform's `AbortSignal.any`, but accepting any {@link AbortSignalLike}.
 * `null` and `undefined` entries are ignored, so optional signals can be passed directly; with no signals the result never aborts.
 *
 * If an input is already aborted, the result is returned already aborted (with the reason of the first such input) and no listener
 * is attached. Otherwise one `abort` listener is added to each input, and all of them are removed as soon as the result aborts.
 * Note that if no input ever aborts, those listeners stay attached for as long as the inputs live (unlike the native implementation,
 * which holds them weakly), so avoid creating unbounded numbers of combined signals from one long-lived signal.
 * @param {Iterable<AbortSignalLike | null | undefined>} signals - The signals to combine (consumed eagerly)
 * @returns {PlatformAbortSignal} A new signal
 * @throws {TypeError} when `signals` is not iterable, or one of its entries is not a signal, `null` or `undefined`
 * @throws {Error} when the environment has no `AbortController`
 * @example
 * const user = new AbortController();
 * const shutdown = new AbortController();
 * const signal = anySignal([user.signal, shutdown.signal, undefined]);
 * signal.aborted; // => false
 * shutdown.abort('shutting down');
 * signal.aborted; // => true
 * signal.reason; // => 'shutting down'
 * @example
 * // doctest: skip
 * await fetch(url, { signal: anySignal([options.signal, timeoutSignal(5000)]) });
 */
export function anySignal(signals: Iterable<AbortSignalLike | null | undefined>): PlatformAbortSignal {
	if (signals === null || signals === undefined || typeof (signals as Partial<Iterable<unknown>>)[Symbol.iterator] !== 'function') {
		throw new TypeError(`anySignal: \`signals\` must be an iterable, got ${describe(signals)}`);
	}

	const inputs: AbortSignalLike[] = [];
	let index = 0;
	for (const signal of signals) {
		assertOptionalSignal('anySignal', `signals[${index}]`, signal);
		if (signal !== null && signal !== undefined) inputs.push(signal);
		index++;
	}

	return combineSignals('anySignal', inputs)[0] as PlatformAbortSignal;
}

/**
 * Creates a signal that aborts as soon as any of `inputs` aborts (see {@link anySignal}), together with a function that detaches it
 * from the inputs (removing every listener) once it is no longer needed.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {AbortSignalLike[]} inputs - The signals to combine
 * @returns {[AbortSignalLike, () => void]} The combined signal and its `release` function
 * @throws {Error} when the environment has no `AbortController`
 */
function combineSignals(caller: string, inputs: AbortSignalLike[]): [AbortSignalLike, () => void] {
	const controller = createAbortController(caller);
	const aborted = inputs.find(function (input) {
		return input.aborted;
	});
	const listeners = inputs.map(function (input) {
		return function onAbort(): void {
			release();
			controller.abort(abortReason(input));
		};
	});

	/**
	 * Removes every listener (the first abort does it, so none runs twice).
	 * @returns {void}
	 */
	function release(): void {
		inputs.forEach(function (input, i) {
			input.removeEventListener('abort', listeners[i]);
		});
	}

	if (aborted !== undefined) {
		controller.abort(abortReason(aborted));
	} else {
		inputs.forEach(function (input, i) {
			input.addEventListener('abort', listeners[i]);
		});
	}

	return [controller.signal, release];
}

/**
 * Settles like `promise`, unless `signal` aborts first, in which case it rejects with the signal's `reason` (or an
 * {@link AbortError} when it has none). An already-aborted signal rejects immediately. The abort listener is removed as soon as
 * `promise` settles. `signal` may be `null` or `undefined`, in which case this simply settles like `promise`.
 *
 * This only stops *waiting*: the underlying operation is not cancelled and keeps running (pass the signal to the operation itself,
 * e.g. to `fetch`, when it supports cancellation). A later rejection of `promise` is handled, so it does not surface as an
 * unhandled rejection.
 * @template T - The resolved value type
 * @param {PromiseLike<T> | T} promise - The promise (or value) to wait for
 * @param {AbortSignalLike | null | undefined} signal - The signal that stops the wait
 * @returns {Promise<T>} A promise settling like `promise`, or rejecting when `signal` aborts first
 * @throws {TypeError} (as a rejection) when `signal` is not a signal, `null` or `undefined`
 * @throws {unknown} (as a rejection) the abort reason of `signal`, or the rejection of `promise`
 * @example
 * const controller = new AbortController();
 * await abortable(Promise.resolve(42), controller.signal); // => 42
 * const pending = abortable(new Promise(function () {}), controller.signal);
 * controller.abort(new AbortError('stopped waiting'));
 * await pending; // throws AbortError
 * await abortable(Promise.resolve(42), controller.signal); // throws AbortError
 * await abortable(Promise.resolve(42), undefined); // => 42
 */
export function abortable<T>(promise: PromiseLike<T> | T, signal: AbortSignalLike | null | undefined): Promise<T> {
	return new Promise<T>(function (resolve, reject) {
		const settled = Promise.resolve(promise);
		try {
			assertOptionalSignal('abortable', 'signal', signal);
		} catch (error) {
			// The argument error wins, but `promise` may still reject: handle it so it does not surface as an unhandled rejection.
			settled.catch(noop);
			throw error;
		}

		/**
		 * Abort listener: rejects with the abort reason.
		 * @returns {void}
		 */
		function onAbort(): void {
			reject(abortReason(signal as AbortSignalLike));
		}

		settled.then(
			function (value) {
				signal?.removeEventListener('abort', onAbort);
				resolve(value);
			},
			function (error: unknown) {
				signal?.removeEventListener('abort', onAbort);
				reject(error);
			}
		);

		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Throws the signal's `reason` (or an {@link AbortError} when it has none) if `signal` is aborted; does nothing otherwise. Works with
 * any {@link AbortSignalLike} (unlike the platform's `signal.throwIfAborted()`), and accepts `null` / `undefined` for optional signals.
 * @param {AbortSignalLike | null | undefined} signal - The signal to check
 * @returns {void}
 * @throws {unknown} the abort reason of `signal`, when it is aborted
 * @throws {TypeError} when `signal` is not a signal, `null` or `undefined`
 * @example
 * const controller = new AbortController();
 * throwIfAborted(controller.signal); // => undefined
 * throwIfAborted(undefined); // => undefined
 * controller.abort(new TimeoutError());
 * throwIfAborted(controller.signal); // throws TimeoutError
 */
export function throwIfAborted(signal: AbortSignalLike | null | undefined): void {
	assertOptionalSignal('throwIfAborted', 'signal', signal);
	if (signal?.aborted) throw abortReason(signal);
}
