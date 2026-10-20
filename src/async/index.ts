import { createLRUCache, createPriorityQueue } from '../cache/index.js';
import { debounce, defaultMemoizeKey, noop, type MemoizeCache, type Result } from '../functions/index.js';
import { isError } from '../guards/index.js';
import { assertDelay, assertFunction, assertInteger, assertNumber, describe, draw, MAX_TIMEOUT, readOption, show } from '../utils/assert.js';
import { assertOptionalSignal, detach, reasonOf } from '../utils/signal.js';
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
 * `Object.defineProperties`, whatever a polluted `Object.prototype` holds: the descriptors lose their prototype first, so that none
 * inherits a `get`, `set`, `value` or `writable` (with which `Object.defineProperties` throws) or an `enumerable` (which would list the
 * methods in `Object.keys`).
 * @param {object} target - The object
 * @param {Record<string, PropertyDescriptor>} descriptors - The descriptors (object literals)
 * @returns {void}
 */
function defineProperties(target: object, descriptors: Record<string, PropertyDescriptor>): void {
	for (const key of Object.keys(descriptors)) Object.setPrototypeOf(descriptors[key], null);
	Object.defineProperties(target, descriptors);
}

/**
 * `Promise.resolve(value)`, read as `await` reads it, so that calling `then` on the result never throws: `Promise.resolve` hands a
 * native promise back as it is, own `then` property (or prototype supplying one) included, which a `.then()` call would run, or throw
 * from, leaving a slot or a permit taken for good, or a timer callback throwing. Such a promise is followed with the built-in `then`
 * instead (one tick later); any other value costs nothing more.
 * @param {unknown} value - A value, a promise or a thenable
 * @returns {Promise<unknown>} A native promise settling like `value`, with the built-in `then`
 * @throws {unknown} the error of a `constructor` getter that throws (as from `Promise.resolve`)
 */
function toPromise(value: unknown): Promise<unknown> {
	const promise = Promise.resolve(value);

	// Neither check runs user code: `promise` is a native promise, not a proxy.
	return Object.getPrototypeOf(promise) === Promise.prototype && !Object.hasOwn(promise, 'then')
		? promise
		: (Promise.prototype.then.call(promise, undefined, undefined) as Promise<unknown>);
}

/**
 * Calls `fn` with `thisArg` and `args` and returns its outcome as a promise (see {@link toPromise}): a synchronous throw becomes a
 * rejection.
 * @param {Function} fn - The function to call
 * @param {unknown} thisArg - The `this` value
 * @param {ArrayLike<unknown>} args - The arguments
 * @returns {Promise<unknown>} A promise settling like the call
 */
function invoke(fn: (...args: never[]) => unknown, thisArg: unknown, args: ArrayLike<unknown>): Promise<unknown> {
	try {
		return toPromise((fn as (this: unknown, ...args: unknown[]) => unknown).apply(thisArg, args as unknown[]));
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * The waiters sharing one abort signal, and the single listener that stops them all.
 */
interface SignalGroup {
	readonly stops: Set<(reason: unknown) => void>;
	readonly listener: () => void;
}

/**
 * The waiters of every signal passed to this module (queued tasks, permit requests, batched keys, sleeps, abortable waits...), with ONE
 * abort listener per signal however many wait on it: adding and removing a listener costs a scan of the signal's listener list (a
 * platform `AbortSignal` checks for duplicates), so one listener per waiter made n waiters on one signal cost O(n²) (30,000 sleeps on
 * one signal took 15 s to start). Shared by the whole module, so that the waiters of a signal are stopped in registration order
 * whichever helper or structure they belong to.
 */
const signalGroups = new WeakMap<AbortSignalLike, SignalGroup>();

/**
 * Registers a waiter on `signal` (none: nothing to do), adding the abort listener to the signal for its first waiter. `stop` is called
 * once, with the signal's reason (read once for all its waiters), unless {@link unwatchSignal} unregisters it first; a signal that calls
 * the listener while it is being added stops the waiter before this returns.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {(reason: unknown) => void} stop - Stops the waiter (it must not throw)
 * @returns {void}
 * @throws {unknown} the error of a throwing `addEventListener` (the waiter is not registered then)
 */
function watchSignal(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void): void {
	if (signal === null || signal === undefined) return;

	const existing = signalGroups.get(signal);

	if (existing !== undefined) {
		existing.stops.add(stop);
		return;
	}

	const stops = new Set([stop]);
	const group: SignalGroup = {
		stops,
		listener: function onAbort(): void {
			const reason = abortReason(signal);

			// Iterated live, each waiter removed before it is stopped: a waiter unregistered by an earlier one (a permit granted, a task
			// started by code that the abort ran) is skipped, and a hostile signal calling the listener again stops nobody twice.
			for (const each of stops) {
				stops.delete(each);
				each(reason);
			}
			if (signalGroups.get(signal) === group) signalGroups.delete(signal);
		}
	};

	// Mapped once added: when adding it throws, the waiter is not registered, and when the signal calls it while it is being added, the
	// waiter is stopped already. `capture` is given: one inherited from a polluted `Object.prototype` would keep `removeEventListener`
	// from finding the listener.
	signal.addEventListener('abort', group.listener, { once: true, capture: false } as { once: boolean });
	if (stops.size > 0) signalGroups.set(signal, group);
}

/**
 * Unregisters a waiter that no longer waits (idempotent), removing the abort listener once no waiter is left on the signal. A waiter is
 * never stopped once unregistered, even by a signal whose `removeEventListener` throws.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {(reason: unknown) => void} stop - The waiter's stop function
 * @returns {void}
 */
function unwatchSignal(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void): void {
	if (signal === null || signal === undefined) return;

	const group = signalGroups.get(signal);

	if (group === undefined || !group.stops.delete(stop) || group.stops.size > 0) return;
	signalGroups.delete(signal);
	detach(signal, group.listener);
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

		const signal = readOption(options, 'signal');

		assertOptionalSignal('sleep', 'signal', signal);

		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}

		const timer = setTimeout(function () {
			resolve();
			unwatchSignal(signal, onAbort);
		}, ms);

		/**
		 * Abort listener: clears the timer and rejects.
		 * @param {unknown} reason - The abort reason
		 * @returns {void}
		 */
		function onAbort(reason: unknown): void {
			clearTimeout(timer);
			reject(reason);
		}

		// After the timer, which a signal calling the listener while it is being added clears; when adding it throws, no timer is left behind.
		try {
			watchSignal(signal, onAbort);
		} catch (error) {
			clearTimeout(timer);
			throw error;
		}
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
		const settled = toPromise(promise) as Promise<T>;
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
 * @param {(attempt: number) => PromiseLike<T> | T} fn - The operation; receives the 1-based attempt number
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
export async function retry<T>(fn: (attempt: number) => PromiseLike<T> | T, options: RetryOptions = {}, random: RandomGenerator = Math.random): Promise<T> {
	// Every option is read as an own property (or a getter): a value inherited from a polluted `Object.prototype` is ignored.
	const retries = readOption(options, 'retries', 3);
	const delay = readOption(options, 'delay', 0);
	const factor = readOption(options, 'factor', 2);
	const maxDelay = readOption(options, 'maxDelay', Infinity);
	const jitter = readOption(options, 'jitter', false);
	const shouldRetry = readOption(options, 'shouldRetry');
	const onRetry = readOption(options, 'onRetry');
	const signal = readOption(options, 'signal');

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
 * @template S - The signal type, passed on to the callbacks
 */
export interface ConcurrencyOptions<S extends AbortSignalLike = AbortSignalLike> {
	/** Maximum number of callbacks in flight (an integer >= 1, or `Infinity`). Defaults to `Infinity`. */
	concurrency?: number;
	/**
	 * Aborting it stops starting new items and rejects straight away with the signal's `reason` (or an {@link AbortError}); callbacks
	 * already running are not interrupted (their outcome is ignored), but they receive the signal as their third argument.
	 */
	signal?: S | null;
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
 * @template S - The signal type (that of the `signal` option)
 */
export type ConcurrentCallback<T, R, S extends AbortSignalLike = AbortSignalLike> = (item: T, index: number, signal: S | undefined) => PromiseLike<R> | R;

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
	let concurrency: number;
	let signal: AbortSignalLike | null | undefined;
	let stopOnError: boolean;
	let list: unknown[];

	// Argument errors (also from reading the options), an aborted signal and (on the fast path) synchronous throws become rejections.
	try {
		if (typeof options === 'object' && options !== null) {
			concurrency = readOption(options, 'concurrency', Infinity);
			signal = readOption(options, 'signal');
			stopOnError = readOption(options, 'stopOnError', true);
		} else {
			concurrency = options === undefined ? Infinity : options;
			stopOnError = true;
		}
		assertInteger(caller, 'concurrency', concurrency, 1, true);
		assertFunction(caller, name, callback);
		assertOptionalSignal(caller, 'signal', signal);
		if (signal?.aborted) throw abortReason(signal);

		list = Array.from(items);
		// Reading `items` runs user code (a generator), which may abort the signal before the listener is added.
		if (signal?.aborted) throw abortReason(signal);

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
			settle(value as never);
			unwatchSignal(signal, onAbort);
		}

		/**
		 * Abort listener.
		 * @param {unknown} reason - The abort reason
		 * @returns {void}
		 */
		function onAbort(reason: unknown): void {
			finish(reject, reason);
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
				let outcome: Promise<unknown>;

				// A synchronous throw is handled before the next item starts (so `stopOnError` starts nothing more), and so is a returned
				// promise that cannot be awaited (its `constructor` or `then` getter throws), which would otherwise leave the run pending.
				try {
					outcome = Promise.resolve(callback(list[index], index, mapperSignal));
				} catch (error) {
					failed(error);
					continue;
				}

				running++;
				try {
					outcome.then(
						function (value) {
							results[index] = value;
							release();
						},
						function (error: unknown) {
							failed(error);
							release();
						}
					);
				} catch (error) {
					running--;
					failed(error);
				}
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

		watchSignal(signal, onAbort);
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
export function mapWithConcurrency<T, R, S extends AbortSignalLike = AbortSignalLike>(
	items: Iterable<T>,
	mapper: ConcurrentCallback<T, R, S>,
	options?: number | ConcurrencyOptions<S>
): Promise<R[]> {
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
export async function mapSettledWithConcurrency<T, R, S extends AbortSignalLike = AbortSignalLike>(
	items: Iterable<T>,
	mapper: ConcurrentCallback<T, R, S>,
	options?: number | ConcurrencyOptions<S>
): Promise<Array<PromiseSettledResult<Awaited<R>>>> {
	return runConcurrently(
		'mapSettledWithConcurrency',
		'mapper',
		items,
		// An invalid mapper is passed on as is, so that the arguments are validated in the same order as by the sibling helpers.
		typeof mapper === 'function'
			? function (item, index, signal) {
					return invoke(mapper, undefined, [item, index, signal]).then(fulfilled, rejected);
				}
			: (mapper as ConcurrentCallback<unknown, unknown>),
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
export function filterWithConcurrency<T, U extends T, S extends AbortSignalLike = AbortSignalLike>(
	items: Iterable<T>,
	predicate: (item: T, index: number, signal: S | undefined) => item is U,
	options?: number | ConcurrencyOptions<S>
): Promise<U[]>;
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
export function filterWithConcurrency<T, S extends AbortSignalLike = AbortSignalLike>(
	items: Iterable<T>,
	predicate: ConcurrentCallback<T, unknown, S>,
	options?: number | ConcurrencyOptions<S>
): Promise<T[]>;
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

	const rejectOnClear = readOption(options, 'rejectOnClear', false);
	const maxPending = readOption(options, 'maxPending', Infinity);
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

	defineProperties(limit, {
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
 * @template S - The signal type, passed on to the tasks
 */
export interface QueueOptions<S extends AbortSignalLike = AbortSignalLike> {
	/** Maximum number of tasks running at once (an integer >= 1, or `Infinity`). Defaults to `Infinity`. */
	concurrency?: number;
	/**
	 * Aborting it removes every waiting task and rejects its promise with the signal's `reason` (or an {@link AbortError}), and so does
	 * every later `add`. Running tasks are not interrupted: they receive the signal and settle on their own.
	 */
	signal?: S | null;
}

/**
 * Options accepted by {@link Queue.add}.
 * @template S - The signal type, passed on to the task
 */
export interface QueueAddOptions<S extends AbortSignalLike = AbortSignalLike> {
	/** Tasks with a higher priority start first; tasks of equal priority start in the order they were added. Defaults to `0`. */
	priority?: number;
	/**
	 * Aborting it before the task starts removes the task from the queue (it never runs) and rejects its promise with the signal's
	 * `reason`. Once started, the task receives it (combined with the queue's signal, when both are set).
	 */
	signal?: S | null;
}

/**
 * A priority task queue as returned by {@link createQueue}.
 * @template S - The type of the queue's signal
 */
export interface Queue<S extends AbortSignalLike = AbortSignalLike> {
	/**
	 * Adds a task and returns a promise that settles like it. The task is called with an abort signal (see {@link QueueAddOptions.signal})
	 * when it starts: immediately and synchronously if a slot is free, nothing is waiting and the queue is not paused. Synchronous throws
	 * become rejections.
	 * @throws {TypeError} (as a rejection) when `task` is not a function, `priority` is not a number, or `signal` is not a signal
	 * @throws {RangeError} (as a rejection) when `priority` is `NaN`
	 */
	add<T, O extends QueueAddOptions = QueueAddOptions<never>>(task: (signal: QueueTaskSignal<S | SignalOption<O>>) => PromiseLike<T> | T, options?: O): Promise<T>;
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
 * The signal a {@link Queue} task receives: the queue's or the task's own, a platform signal combining both when both are set, or
 * `undefined` when neither is.
 * @template S - The types of the queue's and the task's signals
 */
export type QueueTaskSignal<S extends AbortSignalLike> = S | PlatformAbortSignal | undefined;

/**
 * The type of the `signal` of a {@link QueueAddOptions} object (`never` without one). Inferred from the options rather than from the
 * task's parameter, so a task declared as `(signal: AbortSignal | undefined) => ...` does not widen it.
 * @template O - The options type
 */
type SignalOption<O extends QueueAddOptions> = 'signal' extends keyof O ? NonNullable<O['signal']> : never;

/**
 * A waiting {@link Queue} task.
 */
interface QueueTask {
	readonly priority: number;
	readonly run: () => void;
	readonly reject: (reason: unknown) => void;
	readonly signal: AbortSignalLike | null | undefined;
	readonly onAbort: (reason: unknown) => void;
	/** Whether the task has left the queue (started, dropped or aborted): an aborted task stays in the heap until popped or compacted. */
	done: boolean;
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
export function createQueue<S extends AbortSignalLike = never>(options: QueueOptions<S> = {}): Queue<S> {
	const concurrency = readOption(options, 'concurrency', Infinity);
	const queueSignal = readOption(options, 'signal');

	assertInteger('createQueue', 'concurrency', concurrency, 1, true);
	assertOptionalSignal('createQueue', 'signal', queueSignal);

	// Aborted tasks are only marked `done` and counted in `cancelled` (removing one from the heap costs O(n), so aborting n waiting tasks
	// at once would cost O(n²)); they are skipped when popped, and dropped once they are half of the heap.
	const waiting = createPriorityQueue(byPriority);
	let cancelled = 0;
	let running = 0;
	let paused = false;
	let emptyWaiters: Array<() => void> = [];
	let idleWaiters: Array<() => void> = [];

	/**
	 * Resolves the `onEmpty` / `onIdle` promises whose condition now holds.
	 * @returns {void}
	 */
	function notify(): void {
		if (queued() > 0) return;
		// Listened to only while tasks wait (aborting it changes nothing else): a queue left idle is not kept alive by a long-lived signal.
		unwatchSignal(queueSignal, drop);
		emptyWaiters = wake(emptyWaiters);
		if (running === 0) idleWaiters = wake(idleWaiters);
	}

	/**
	 * Starts waiting tasks while slots are free and the queue is not paused.
	 * @returns {void}
	 */
	function startNext(): void {
		while (!paused && running < concurrency && queued() > 0) (take() as QueueTask).run();
		notify();
	}

	/**
	 * Counts the tasks waiting to start.
	 * @returns {number} The number of waiting tasks
	 */
	function queued(): number {
		return waiting.size - cancelled;
	}

	/**
	 * Removes and returns the next waiting task, dropping the aborted ones popped on the way.
	 * @returns {QueueTask | undefined} The task, or `undefined` when none is waiting
	 */
	function take(): QueueTask | undefined {
		for (let task = waiting.pop(); task !== undefined; task = waiting.pop()) {
			if (!task.done) return task;
			cancelled--;
		}
		return undefined;
	}

	/**
	 * Removes every waiting task and rejects its promise.
	 * @param {unknown} reason - The rejection reason
	 * @returns {void}
	 */
	function drop(reason: unknown): void {
		for (let task = take(); task !== undefined; task = take()) {
			task.done = true;
			task.reject(reason);
			unwatchSignal(task.signal, task.onAbort);
		}
		notify();
	}

	return {
		add<T, O extends QueueAddOptions = QueueAddOptions<never>>(
			task: (signal: QueueTaskSignal<S | SignalOption<O>>) => PromiseLike<T> | T,
			addOptions: O = {} as O
		): Promise<T> {
			return new Promise<T>(function (resolve, reject) {
				const priority = readOption(addOptions, 'priority', 0);
				const signal = readOption(addOptions, 'signal');

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
					entry.done = true;
					unwatchSignal(signal, onAbort);

					let taskSignal: AbortSignalLike | undefined;
					let release: () => void;

					// The task sees both signals; the combined one is detached from them once the task settles. When they cannot be combined
					// (a signal whose `addEventListener` throws), that task fails and the queue goes on.
					try {
						[taskSignal, release] = signal && queueSignal ? combineSignals('createQueue', [signal, queueSignal]) : [signal ?? queueSignal ?? undefined, noop];
					} catch (error) {
						reject(error);
						return;
					}
					running++;
					(invoke(task, undefined, [taskSignal]) as Promise<T>).then(resolve, reject).then(function () {
						release();
						running--;
						startNext();
					});
				}

				/**
				 * Abort listener of a waiting task (unregistered once it starts or is dropped): removes it from the queue and rejects its
				 * promise.
				 * @param {unknown} reason - The abort reason
				 * @returns {void}
				 */
				function onAbort(reason: unknown): void {
					entry.done = true;
					// Once the aborted tasks are half of the heap, the waiting ones are popped and pushed back in order (both orders kept): the
					// heap stays within twice the waiting tasks, at O(log n) amortized per abort.
					if (++cancelled * 2 > waiting.size) {
						const kept: QueueTask[] = [];

						for (let other = take(); other !== undefined; other = take()) kept.push(other);
						for (const other of kept) waiting.push(other);
					}
					reject(reason);
					notify();
				}

				const entry: QueueTask = { priority, run, reject, signal, onAbort, done: false };

				if (!paused && running < concurrency && queued() === 0) {
					run();
				} else {
					// The listeners first (the queue's, idempotent, then the task's): when adding one throws, the task is not queued (its
					// promise rejects).
					watchSignal(queueSignal, drop);
					try {
						watchSignal(signal, onAbort);
					} catch (error) {
						notify();
						throw error;
					}
					waiting.push(entry);
				}
			});
		},
		get size(): number {
			return queued();
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
				if (queued() === 0) resolve();
				else emptyWaiters.push(resolve);
			});
		},
		onIdle(): Promise<void> {
			return new Promise<void>(function (resolve) {
				if (queued() === 0 && running === 0) resolve();
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

	const limit = readOption(options, 'limit') as number;
	const period = readOption(options, 'interval') as number;
	const signal = readOption(options, 'signal');

	assertInteger('createRateLimiter', 'limit', limit, 1);
	assertDelay('createRateLimiter', 'interval', period);
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
		const wait = full ? starts[cursor] + period - now : 0;

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
		if (first === undefined) unwatchSignal(signal, drop);
	}

	/**
	 * Clears the timer and rejects every waiting call.
	 * @param {unknown} reason - The rejection reason
	 * @returns {void}
	 */
	function drop(reason: unknown): void {
		clearTimeout(timer);
		timer = undefined;
		unwatchSignal(signal, drop);

		let call = first;

		first = undefined;
		pending = 0;
		for (; call !== undefined; call = call.next) call.reject(reason);
	}

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

			// Listened to only while calls wait (idempotent), so that an idle limiter is not kept alive by a long-lived signal; when adding
			// the listener throws, the call is not queued.
			watchSignal(signal, drop);
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

// ---------------------------------------------------------------------------------------------------------------------
// createSemaphore / createMutex / createKeyedMutex
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Gives back what {@link Semaphore.acquire} (or a mutex's `acquire`) obtained. Only the first call has an effect, so calling it twice
 * (in a `finally` block and an error handler, say) can never release permits held by someone else.
 */
export type Release = () => void;

/**
 * Options accepted by {@link Semaphore.acquire} and {@link Semaphore.run}.
 */
export interface SemaphoreAcquireOptions {
	/** Number of permits taken at once (an integer between `1` and the semaphore's `permits`). Defaults to `1`. */
	weight?: number;
	/**
	 * Aborting it while the request waits removes the request from the queue at once and rejects it with the signal's `reason` (or an
	 * {@link AbortError}). An already-aborted signal rejects even when permits are available. Once granted, the signal has no effect.
	 */
	signal?: AbortSignalLike | null;
	/**
	 * Longest wait in milliseconds (`0` to `2^31 - 1`, or `Infinity`, the default): the request then leaves the queue and rejects with a
	 * {@link TimeoutError}. Permits available straight away are granted without starting a timer.
	 */
	timeout?: number;
}

/**
 * A counting semaphore as returned by {@link createSemaphore}. Its methods do not depend on `this`, so they can be passed around.
 */
export interface Semaphore {
	/**
	 * Resolves with a {@link Release} function once `weight` permits are granted: immediately when they are available and nobody waits,
	 * otherwise in FIFO order. Rejects instead when `signal` aborts or `timeout` expires first.
	 * @throws {TypeError} (as a rejection) when `weight` or `timeout` is not a number, or `signal` is not a signal
	 * @throws {RangeError} (as a rejection) when `weight` is not an integer between 1 and `permits`, or `timeout` is not a valid delay
	 */
	acquire(options?: SemaphoreAcquireOptions): Promise<Release>;
	/**
	 * Takes `weight` permits (default `1`) synchronously when they are available and nobody waits (it never jumps the queue), and returns
	 * their {@link Release} function; returns `undefined` otherwise.
	 * @throws {TypeError} when `weight` is not a number
	 * @throws {RangeError} when `weight` is not an integer between 1 and `permits`
	 */
	tryAcquire(weight?: number): Release | undefined;
	/**
	 * Acquires (see {@link Semaphore.acquire}), calls `fn()`, and releases once its result settles, also when it throws synchronously or
	 * rejects. Settles like `fn()`; `fn` is not called when the acquisition fails.
	 * @throws {TypeError} (as a rejection) when `fn` is not a function, or for invalid options (see `acquire`)
	 */
	run<T>(fn: () => PromiseLike<T> | T, options?: SemaphoreAcquireOptions): Promise<T>;
	/** Number of permits not currently held. */
	readonly available: number;
	/** Number of requests waiting for permits. */
	readonly pending: number;
}

/**
 * Options accepted by {@link Mutex.acquire}, {@link Mutex.run} and the {@link KeyedMutex} methods: those of a semaphore, without `weight`.
 */
export type MutexAcquireOptions = Omit<SemaphoreAcquireOptions, 'weight'>;

/**
 * A mutual-exclusion lock as returned by {@link createMutex}: a {@link Semaphore} with one permit, plus `isLocked`.
 */
export interface Mutex {
	/** Resolves with the {@link Release} function once the lock is held (see {@link Semaphore.acquire}). */
	acquire(options?: MutexAcquireOptions): Promise<Release>;
	/** Takes the lock synchronously when it is free and nobody waits, and returns its {@link Release} function; `undefined` otherwise. */
	tryAcquire(): Release | undefined;
	/** Runs `fn()` while holding the lock, which is released once its result settles (see {@link Semaphore.run}). */
	run<T>(fn: () => PromiseLike<T> | T, options?: MutexAcquireOptions): Promise<T>;
	/** Whether the lock is held. */
	readonly isLocked: boolean;
	/** Number of requests waiting for the lock. */
	readonly pending: number;
}

/**
 * One lock per key, as returned by {@link createKeyedMutex}. Keys are compared like `Map` keys (SameValueZero).
 * @template K - The key type
 */
export interface KeyedMutex<K> {
	/** Resolves with the {@link Release} function once the lock of `key` is held (see {@link Semaphore.acquire}). */
	acquire(key: K, options?: MutexAcquireOptions): Promise<Release>;
	/** Takes the lock of `key` synchronously when it is free and nobody waits for it, and returns its {@link Release} function; `undefined` otherwise. */
	tryAcquire(key: K): Release | undefined;
	/** Runs `fn()` while holding the lock of `key`, which is released once its result settles (see {@link Semaphore.run}). */
	run<T>(key: K, fn: () => PromiseLike<T> | T, options?: MutexAcquireOptions): Promise<T>;
	/** Whether the lock of `key` is held. */
	isLocked(key: K): boolean;
	/** Number of keys whose lock is held (only those have any state). */
	readonly size: number;
}

/**
 * A request waiting for permits.
 */
interface SemaphoreWaiter {
	readonly weight: number;
	/** Hands over the permits (already taken) and settles the request. */
	readonly grant: (release: Release) => void;
	/** The neighbours in the queue of waiting requests. */
	previous: SemaphoreWaiter | undefined;
	next: SemaphoreWaiter | undefined;
	/** Whether the request is in the queue. */
	queued: boolean;
}

/**
 * The semaphore behind {@link createSemaphore}, {@link createMutex} and {@link createKeyedMutex}.
 * @param {string} name - Prefix of the error messages (`'Semaphore'`, `'Mutex'`…)
 * @param {number} permits - Number of permits
 * @param {() => void} [onIdle] - Called each time every permit is back and nobody waits any more
 * @returns {Semaphore} The semaphore
 */
function semaphore(name: string, permits: number, onIdle: () => void = noop): Semaphore {
	let available = permits;
	// The waiting requests form a doubly linked FIFO queue: O(1) to append, to take the first and to remove an aborted request. (A `Set`
	// used as a queue is quadratic: each iteration from its start skips the entries deleted before it until the table is rebuilt.)
	let first: SemaphoreWaiter | undefined;
	let last: SemaphoreWaiter | undefined;
	let waiting = 0;

	/**
	 * Throws unless `weight` is an integer between 1 and `permits` (a larger request could never be granted).
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {number} weight - The value to validate
	 * @returns {void}
	 */
	function assertWeight(caller: string, weight: number): void {
		if (!(Number.isInteger(weight) && weight >= 1 && weight <= permits)) assertNumber(caller, 'weight', weight, false, `an integer between 1 and ${permits}`);
	}

	/**
	 * Takes `weight` permits and creates the function that gives them back.
	 * @param {number} weight - Number of permits
	 * @returns {Release} The idempotent release function
	 */
	function lease(weight: number): Release {
		let held = true;

		available -= weight;

		return function release(): void {
			if (!held) return;
			held = false;
			available += weight;
			dispatch();
		};
	}

	/**
	 * Grants permits to the waiting requests, in order, for as long as the first one fits (a heavy request is never overtaken, so it cannot
	 * starve), then reports idleness.
	 * @returns {void}
	 */
	function dispatch(): void {
		// `grant` removes the waiter from the queue.
		for (let waiter = first; waiter !== undefined && waiter.weight <= available; waiter = first) waiter.grant(lease(waiter.weight));
		// Every permit is back only when nobody waits (the first waiter would fit).
		if (available === permits) onIdle();
	}

	/**
	 * Appends a request to the queue.
	 * @param {SemaphoreWaiter} waiter - The request
	 * @returns {void}
	 */
	function enqueue(waiter: SemaphoreWaiter): void {
		waiter.previous = last;
		if (last === undefined) first = waiter;
		else last.next = waiter;
		last = waiter;
		waiter.queued = true;
		waiting++;
	}

	/**
	 * Removes a request from the queue, if it is in it.
	 * @param {SemaphoreWaiter} waiter - The request
	 * @returns {void}
	 */
	function unlink(waiter: SemaphoreWaiter): void {
		if (!waiter.queued) return;

		const { previous, next } = waiter;

		if (previous === undefined) first = next;
		else previous.next = next;
		if (next === undefined) last = previous;
		else next.previous = previous;
		waiter.previous = waiter.next = undefined;
		waiter.queued = false;
		waiting--;
	}

	/**
	 * Requests permits (see {@link Semaphore.acquire}).
	 * @param {string} caller - Name of the public method, used in error messages
	 * @param {SemaphoreAcquireOptions} options - The options
	 * @returns {Promise<Release>} Resolves with the release function
	 */
	function acquire(caller: string, options: SemaphoreAcquireOptions): Promise<Release> {
		return new Promise<Release>(function (resolve, reject) {
			const weight = readOption(options, 'weight', 1);
			const signal = readOption(options, 'signal');
			const timeout = readOption(options, 'timeout', Infinity);

			assertWeight(caller, weight);
			assertDelay(caller, 'timeout', timeout, true);
			assertOptionalSignal(caller, 'signal', signal);
			if (signal?.aborted) throw abortReason(signal);

			if (waiting === 0 && weight <= available) {
				resolve(lease(weight));
				return;
			}

			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter: SemaphoreWaiter = {
				weight,
				grant: function (release: Release): void {
					leave();
					resolve(release);
				},
				previous: undefined,
				next: undefined,
				queued: false
			};

			/**
			 * Removes the request from the queue and releases its timer and abort listener.
			 * @returns {void}
			 */
			function leave(): void {
				unlink(waiter);
				clearTimeout(timer);
				unwatchSignal(signal, onAbort);
			}

			/**
			 * Rejects the request; the requests behind it may fit now.
			 * @param {unknown} reason - The rejection reason
			 * @returns {void}
			 */
			function fail(reason: unknown): void {
				leave();
				reject(reason);
				dispatch();
			}

			/**
			 * Abort listener, unregistered once the request leaves the queue: a late abort (from a signal whose `removeEventListener`
			 * throws) would otherwise `dispatch` again and report the semaphore idle, making a keyed mutex forget a key held again.
			 * @param {unknown} reason - The abort reason
			 * @returns {void}
			 */
			function onAbort(reason: unknown): void {
				fail(reason);
			}

			// Queued first, so that a listener called while being added finds the request; when adding it throws, the request leaves the
			// queue before any timer exists. `leave` removes it.
			enqueue(waiter);
			try {
				watchSignal(signal, onAbort);
			} catch (error) {
				unlink(waiter);
				throw error;
			}
			// A listener called while being added has failed the request already: no timer.
			if (!waiter.queued) return;
			if (timeout !== Infinity) {
				timer = setTimeout(function () {
					fail(new TimeoutError(`${caller}: timed out after ${timeout} ms`));
				}, timeout);
			}
		});
	}

	return {
		acquire(options: SemaphoreAcquireOptions = {}): Promise<Release> {
			return acquire(`${name}.acquire`, options);
		},
		tryAcquire(weight = 1): Release | undefined {
			assertWeight(`${name}.tryAcquire`, weight);
			return waiting === 0 && weight <= available ? lease(weight) : undefined;
		},
		run<T>(fn: () => PromiseLike<T> | T, options: SemaphoreAcquireOptions = {}): Promise<T> {
			const caller = `${name}.run`;

			if (typeof fn !== 'function') return Promise.reject(new TypeError(`${caller}: \`fn\` must be a function, got ${describe(fn)}`));

			return acquire(caller, options).then(function (release) {
				const result = invoke(fn, undefined, []) as Promise<T>;

				result.then(release, release);

				return result;
			});
		},
		get available(): number {
			return available;
		},
		get pending(): number {
			return waiting;
		}
	};
}

/**
 * Creates a counting semaphore: at most `permits` permits are held at once (like the slots of {@link createLimiter}, but held
 * explicitly, across any number of steps, until released).
 * - **Fair:** requests are granted in FIFO order, and `tryAcquire` never jumps the queue. A released permit goes straight to the first
 *   waiter, so nothing can barge in between.
 * - **Weighted:** `acquire({ weight })` takes several permits at once (for a memory or bandwidth budget); a heavy request at the head of
 *   the queue is never overtaken by lighter ones, so it cannot starve.
 * - **Cancellable:** a request whose `signal` aborts or whose `timeout` expires leaves the queue at once (`pending` drops immediately)
 *   without taking permits or leaving a listener or timer behind, and the requests behind it are served if they now fit.
 * - **Leak-proof:** each grant has its own {@link Release} function, and calling it again does nothing, so permits are never released
 *   twice. `run(fn)` releases whatever `fn` does, including throwing synchronously.
 * @param {number} permits - Number of permits (an integer >= 1, or `Infinity`)
 * @returns {Semaphore} The semaphore, with `acquire`, `tryAcquire`, `run`, `available` and `pending`
 * @throws {TypeError} when `permits` is not a number
 * @throws {RangeError} when `permits` is not an integer >= 1 or `Infinity`
 * @example
 * const pool = createSemaphore(2);
 * let running = 0;
 * let peak = 0;
 * async function download(id: number): Promise<number> { running++; peak = Math.max(peak, running); await sleep(5); running--; return id; }
 * await Promise.all([1, 2, 3, 4].map(function (id) { return pool.run(function () { return download(id); }); })); // => [1, 2, 3, 4]
 * peak; // => 2
 * @example
 * const budget = createSemaphore(10); // say, megabytes of memory
 * const big = await budget.acquire({ weight: 8 });
 * const small = budget.acquire({ weight: 4 }); // waits: only 2 are left
 * budget.pending; // => 1
 * big();
 * big(); // does nothing: already released
 * const release = await small;
 * budget.available; // => 6
 * release();
 * @example
 * const semaphore = createSemaphore(1);
 * const release = semaphore.tryAcquire();
 * semaphore.tryAcquire(); // => undefined
 * await semaphore.acquire({ timeout: 10 }); // throws TimeoutError
 * semaphore.pending; // => 0
 * release?.();
 */
export function createSemaphore(permits: number): Semaphore {
	assertInteger('createSemaphore', 'permits', permits, 1, true);

	return semaphore('Semaphore', permits);
}

/**
 * Creates a promise-based mutex (mutual-exclusion lock): a {@link createSemaphore} semaphore with a single permit, with the same
 * guarantees (FIFO, cancellation through `signal` and `timeout` without leaks, idempotent release) and method names, plus `isLocked`.
 * Coming from `async-mutex`: `acquire()` resolves with the release function there too, `runExclusive(fn)` is `run(fn)`, `isLocked()`
 * is the `isLocked` property, and `tryAcquire()` returns `undefined` instead of throwing when the lock is taken.
 * @returns {Mutex} The mutex, with `acquire`, `tryAcquire`, `run`, `isLocked` and `pending`
 * @example
 * const mutex = createMutex();
 * const log: string[] = [];
 * async function save(name: string): Promise<void> { log.push(`start ${name}`); await sleep(5); log.push(`end ${name}`); }
 * await Promise.all([mutex.run(function () { return save('a'); }), mutex.run(function () { return save('b'); })]);
 * log; // => ['start a', 'end a', 'start b', 'end b']
 * @example
 * const mutex = createMutex();
 * const release = await mutex.acquire();
 * mutex.isLocked; // => true
 * try {
 *   // critical section
 * } finally {
 *   release();
 * }
 * mutex.isLocked; // => false
 */
export function createMutex(): Mutex {
	const lock = semaphore('Mutex', 1);

	return {
		acquire: lock.acquire,
		tryAcquire: lock.tryAcquire,
		run: lock.run,
		get isLocked(): boolean {
			return lock.available === 0;
		},
		get pending(): number {
			return lock.pending;
		}
	};
}

/**
 * Creates one mutex per key, to serialize work per user, per document or per file while different keys proceed in parallel. Each lock
 * behaves like {@link createMutex} (FIFO, `signal` and `timeout`, idempotent release).
 *
 * A key only has state while its lock is held: the state is deleted as soon as the last holder releases with nobody waiting, so locking
 * an unbounded number of keys (one per request id, say) does not grow memory.
 * @template K - The key type
 * @returns {KeyedMutex<K>} The keyed mutex, with `acquire`, `tryAcquire`, `run`, `isLocked` and `size`
 * @example
 * const locks = createKeyedMutex<string>();
 * const log: string[] = [];
 * async function charge(user: string, amount: number): Promise<void> { log.push(`${user} +${amount}`); await sleep(5); }
 * const work = Promise.all([
 *   locks.run('ada', function () { return charge('ada', 1); }),
 *   locks.run('ada', function () { return charge('ada', 2); }), // waits for the first one
 *   locks.run('bob', function () { return charge('bob', 3); }) // another key: runs at once
 * ]);
 * locks.size; // => 2
 * await work;
 * log; // => ['ada +1', 'bob +3', 'ada +2']
 * locks.size; // => 0 // idle keys are forgotten
 */
export function createKeyedMutex<K = unknown>(): KeyedMutex<K> {
	const locks = new Map<K, Semaphore>();

	/**
	 * The lock of `key`, created on first use; it deletes itself once idle.
	 * @param {K} key - The key
	 * @returns {Semaphore} The lock
	 */
	function lockOf(key: K): Semaphore {
		let lock = locks.get(key);

		if (lock === undefined) {
			lock = semaphore('KeyedMutex', 1, function () {
				locks.delete(key);
			});
			locks.set(key, lock);
		}

		return lock;
	}

	/**
	 * Forgets a lock left free by a request that failed at once (invalid options, aborted signal), and returns the request's promise.
	 * @template T - The resolved value type
	 * @param {K} key - The key
	 * @param {Semaphore} lock - Its lock
	 * @param {Promise<T>} request - The promise to return
	 * @returns {Promise<T>} `request`
	 */
	function tidy<T>(key: K, lock: Semaphore, request: Promise<T>): Promise<T> {
		if (lock.available === 1) locks.delete(key);
		return request;
	}

	return {
		acquire(key: K, options?: MutexAcquireOptions): Promise<Release> {
			const lock = lockOf(key);
			return tidy(key, lock, lock.acquire(options));
		},
		tryAcquire(key: K): Release | undefined {
			// A free key gets a lock and takes it, a held one keeps its lock: nothing to tidy.
			return lockOf(key).tryAcquire();
		},
		run<T>(key: K, fn: () => PromiseLike<T> | T, options?: MutexAcquireOptions): Promise<T> {
			const lock = lockOf(key);
			return tidy(key, lock, lock.run(fn, options));
		},
		isLocked(key: K): boolean {
			return locks.has(key);
		},
		get size(): number {
			return locks.size;
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
		const period = readOption(options, 'interval', 100);
		const timeout = readOption(options, 'timeout', Infinity);
		const signal = readOption(options, 'signal');

		assertFunction('pollUntil', 'check', check);
		assertDelay('pollUntil', 'interval', period);
		assertDelay('pollUntil', 'timeout', timeout, true);
		assertOptionalSignal('pollUntil', 'signal', signal);

		if (signal?.aborted) {
			reject(abortReason(signal));
			return;
		}

		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

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
			settle(value as never);
			unwatchSignal(signal, onAbort);
		}

		/**
		 * Abort listener.
		 * @param {unknown} reason - The abort reason
		 * @returns {void}
		 */
		function onAbort(reason: unknown): void {
			finish(reject, reason);
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
						pollTimer = setTimeout(poll, period);
					}
				},
				function (error: unknown) {
					finish(reject, error);
				}
			);
		}

		// `finish` removes it, so it never runs twice. Added before the deadline timer: when adding it throws, no timer is left behind, and
		// when the signal calls it while it is being added, nothing starts.
		watchSignal(signal, onAbort);
		if (settled) return;
		if (timeout !== Infinity) {
			deadlineTimer = setTimeout(function () {
				finish(reject, new TimeoutError(`pollUntil: condition not met within ${timeout} ms`));
			}, timeout);
		}
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

	defineProperties(debouncedAsync, {
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
	/**
	 * Forgets the resolved value and the call in flight for these arguments; returns whether there was one. `this` is forwarded to the
	 * resolver, like a call's: when the resolver reads it, call `delete.call(receiver, ...args)` with the receiver of the memoized call.
	 */
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
	const resolver = readOption(options, 'resolver', defaultMemoizeKey);
	const ttl = readOption(options, 'ttl');
	const cacheOption = readOption(options, 'cache');

	assertFunction('memoizeAsync', 'fn', fn);
	assertFunction('memoizeAsync', 'resolver', resolver);
	if (ttl !== undefined) assertNumber('memoizeAsync', 'ttl', ttl, ttl > 0, 'a number > 0 or Infinity');

	const cache = (cacheOption ?? (ttl === undefined ? new Map() : createLRUCache({ max: Infinity, ttl }))) as MemoizeCache<unknown, unknown>;
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

		// Read once, then `has` only for a cached `undefined` (an expiring cache could drop the entry between the two). A cache that
		// throws rejects, like a throwing resolver.
		try {
			const cached = cache.get(id);
			if (cached !== undefined || cache.has(id)) return Promise.resolve(cached);
		} catch (error) {
			return Promise.reject(error);
		}

		let shared = inflight.get(id);

		if (shared === undefined) {
			const started = invoke(call, this, args);

			// Only the call still registered for this key (not cleared or deleted meanwhile) may write to the cache.
			started.then(
				function (value) {
					if (inflight.get(id) !== started) return;
					inflight.delete(id);
					try {
						(cache.set as (key: unknown, value: unknown, options?: { ttl: number }) => unknown)(id, value, setOptions);
					} catch {
						// The callers already have the value: a cache that cannot store it only makes the next call compute it again.
					}
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

	defineProperties(memoized, {
		cache: { value: cache, enumerable: true },
		clear: {
			value: function clear(): void {
				inflight.clear();
				cache.clear();
			}
		},
		delete: {
			value: function (this: unknown, ...args: unknown[]): boolean {
				// `this` is forwarded like a call's: a resolver reading it computes the same key (`delete.call(receiver, ...args)`).
				const id = key.apply(this, args);
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
// createBatcher
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The batch function of {@link createBatcher}: receives the distinct keys of one batch (a new array on every call) and returns, or
 * resolves to, an array (or array-like object, not a string) of exactly one value per key, in the same order. An `Error` instance at
 * a position rejects the callers of that key only.
 * @template K - The key type
 * @template V - The value type
 */
export type BatchLoadFunction<K, V> = (keys: K[]) => PromiseLike<ArrayLike<V | Error> & object> | (ArrayLike<V | Error> & object);

/**
 * Options accepted by {@link createBatcher}.
 * @template K - The key type
 * @template V - The value type
 */
export interface BatcherOptions<K, V> {
	/**
	 * How long a batch collects keys, in milliseconds from its first key (`0` to `2^31 - 1`). By default a batch is dispatched as soon
	 * as the microtask queue has drained, like DataLoader: it holds every key requested in the current tick, also from promise callbacks
	 * and after any number of `await`s (GraphQL resolvers at the same depth). In Node, Bun and Deno that is a `process.nextTick` queued
	 * from a microtask; elsewhere (browsers, workers) a `setTimeout(0)` macrotask, which costs about a millisecond (up to 4 when timers
	 * nest), negligible next to the I/O a batch performs. Set `delay` to collect keys for longer, across timers and I/O.
	 */
	delay?: number;
	/**
	 * Largest number of distinct keys passed to one call of the batch function (an integer >= 1, or `Infinity`, the default). A full
	 * batch is sealed (further keys start a new batch) and dispatched without waiting for `delay`.
	 */
	maxBatchSize?: number;
	/**
	 * Maps a key to its identity, compared with SameValueZero like `Map` keys: the keys of one identity are requested once per batch,
	 * and share their cache entry. Defaults to the key itself, so object keys are compared by reference; pass, for example,
	 * `function (key) { return key.id; }`, or `defaultMemoizeKey` from the functions module to compare plain data by value.
	 */
	key?: (key: K) => unknown;
	/**
	 * Whether resolved values are kept across batches:
	 * - `false` (the default): every batch requests its keys again, so no value is ever stale and nothing grows.
	 * - `true`: an unbounded `Map`, for a short-lived batcher only (one per request, the way DataLoader is meant to be used).
	 * - a `Map`-like store, such as `createLRUCache({ max, ttl })` from the cache module, to bound both memory and staleness.
	 *
	 * With a cache, a key already requested and not yet settled is joined instead of requested again (single flight). Only values are
	 * stored, never errors: a failed key is requested again by its next `load`.
	 */
	cache?: boolean | MemoizeCache<unknown, V>;
}

/**
 * Options accepted by {@link Batcher.load} and {@link Batcher.loadMany}.
 */
export interface BatcherLoadOptions {
	/**
	 * Stops waiting: the promise rejects with the signal's `reason` (or an {@link AbortError}). A key that no other caller waits for is
	 * removed from its batch when the batch has not been dispatched yet, so it is never requested; a dispatched batch is not affected.
	 * A batcher adds one listener per signal, however many keys wait on it, and removes it once none does.
	 */
	signal?: AbortSignalLike | null;
}

/**
 * A request batcher as returned by {@link createBatcher}. Its methods do not use `this`, so they can be passed around on their own.
 * @template K - The key type
 * @template V - The value type
 */
export interface Batcher<K, V> {
	/**
	 * Requests the value of `key`: from the cache when it holds one, otherwise through the next call of the batch function.
	 * @throws {TypeError} (as a rejection) when `options` is not an object, `signal` is not a signal, or the batch function returns
	 * something other than one value per key
	 * @throws {unknown} (as a rejection) the `Error` at the key's position, the error of the batch function, the error of the `key`
	 * function or of the cache, or the abort reason of `signal`
	 */
	load(key: K, options?: BatcherLoadOptions): Promise<V>;
	/**
	 * Requests the values of several keys (through the same batch, when they fit in one) and resolves with them in the same order.
	 * Rejects like `Promise.all`, as soon as one key fails (unlike DataLoader's `loadMany`, which resolves with `Error` values: use
	 * `Promise.allSettled(keys.map(load))` for that).
	 * @throws {TypeError} (as a rejection) when `keys` is not iterable, `options` is not an object or `signal` is not a signal
	 */
	loadMany(keys: Iterable<K>, options?: BatcherLoadOptions): Promise<V[]>;
	/**
	 * Forgets the cached value of `key`, and makes a request for it that is already in flight leave its (possibly stale) value out of
	 * the cache (its callers still get it). A request not dispatched yet cannot be stale: it is kept, and caches its value. Does nothing
	 * without a cache.
	 */
	clear(key: K): void;
	/** Like {@link Batcher.clear}, for every key. */
	clearAll(): void;
	/**
	 * Stores `value` as the cached value of `key` (replacing any), for instance the record returned by an update. Callers waiting for
	 * `key` in a batch not dispatched yet get `value` at once, and the key leaves the batch (it is not requested); a request already in
	 * flight still settles its callers, but leaves its value out of the cache. Does nothing without a cache.
	 * @throws {TypeError} when `value` is an `Error` (errors are never cached)
	 */
	prime(key: K, value: V): void;
}

/**
 * The keys collected for one call of the batch function.
 */
interface Batch {
	/** One entry per key identity, in the order of their first request. */
	readonly entries: Map<unknown, BatchEntry>;
	/** The `delay` timer, until the batch is dispatched or sealed (`undefined` once sealed). */
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether the batch function has been called with the batch. */
	dispatched: boolean;
}

/**
 * A key of a {@link Batch}, shared by every caller requesting its identity.
 */
interface BatchEntry {
	/** The first key requested with this identity: the one passed to the batch function. */
	readonly key: unknown;
	readonly id: unknown;
	readonly batch: Batch;
	readonly deferred: Deferred<unknown>;
	/** Callers that have not aborted. */
	waiters: number;
}

/**
 * Whether `value` has the methods of a {@link MemoizeCache}.
 * @param {unknown} value - The value
 * @returns {boolean} `true` for a `Map`-like store
 */
function isCacheLike(value: unknown): value is MemoizeCache<unknown, unknown> {
	const cache = value as Partial<MemoizeCache<unknown, unknown>>;

	return (
		typeof value === 'object' &&
		value !== null &&
		typeof cache.get === 'function' &&
		typeof cache.has === 'function' &&
		typeof cache.set === 'function' &&
		typeof cache.delete === 'function' &&
		typeof cache.clear === 'function'
	);
}

/**
 * Reads the values a batch function returned: exactly `count` of them, each read once.
 * @param {unknown} values - What the batch function returned (or resolved to)
 * @param {number} count - The number of keys in the batch
 * @returns {unknown[]} The values, in key order
 * @throws {TypeError} when `values` is not an array or array-like object of `count` values
 */
function readValues(values: unknown, count: number): unknown[] {
	if (typeof values !== 'object' || values === null) {
		throw new TypeError(`createBatcher: \`batchLoad\` must return an array of ${count} values (one per key), got ${describe(values)}`);
	}

	const { length } = values as ArrayLike<unknown>;

	if (length !== count) {
		throw new TypeError(
			`createBatcher: \`batchLoad\` must return an array of ${count} values (one per key), got ${typeof length === 'number' ? `${length} values` : 'object'}`
		);
	}

	const results: unknown[] = [];

	for (let index = 0; index < count; index++) {
		const value = (values as ArrayLike<unknown>)[index];

		// A hole (`new Array(n)` with a missing row) reads as `undefined`, not as a value planted on a polluted `Object.prototype` (or
		// inherited by an array whatever its prototype): it would be handed out, and cached.
		results.push(
			value !== undefined && !Object.hasOwn(values, index) && (Array.isArray(values) || Object.is(value, (Object.prototype as ArrayLike<unknown>)[index]))
				? undefined
				: value
		);
	}

	return results;
}

/**
 * Calls `fn` once the microtask queue has drained (see {@link BatcherOptions.delay}): from a `process.nextTick` callback queued by a
 * microtask where the runtime has one (Node runs it after every pending promise reaction, including those queued meanwhile), and from
 * a `setTimeout(0)` macrotask elsewhere. The lookup happens at call time, so nothing runs when the module loads.
 * @param {() => void} fn - The callback
 * @returns {void}
 */
function afterMicrotasks(fn: () => void): void {
	Promise.resolve().then(function () {
		try {
			const host = (globalThis as unknown as { process?: { nextTick?: unknown } }).process;
			const nextTick = host?.nextTick;

			if (typeof nextTick === 'function') {
				(nextTick as (callback: () => void) => void).call(host, fn);
				return;
			}
		} catch {
			// A `process` whose `nextTick` cannot be read or called: fall back to a timer.
		}
		setTimeout(fn, 0);
	});
}

/**
 * Reads the `signal` of the options of {@link Batcher.load} or {@link Batcher.loadMany}, once.
 * @param {string} caller - Name of the method, used in error messages
 * @param {unknown} options - The options
 * @returns {AbortSignalLike | null | undefined} The signal
 * @throws {TypeError} when `options` is not an object (or `undefined`), or `signal` is not a signal
 */
function signalOption(caller: string, options: unknown): AbortSignalLike | null | undefined {
	if (options === undefined) return undefined;
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);

	const signal = readOption(options as BatcherLoadOptions, 'signal');

	assertOptionalSignal(caller, 'signal', signal);

	return signal;
}

/**
 * Creates a request batcher, DataLoader-style: every key requested with `load` while a batch is open goes to ONE call of `batchLoad`,
 * which returns one value per key, and each caller gets the value of its own key. N lookups (an N+1 query in a GraphQL resolver, one
 * request per row of a list) become one round trip.
 * - A batch collects the keys requested until the microtask queue drains, like DataLoader (see `delay` to wait longer).
 * - Each key identity (see `key`) is requested once per batch, however many callers ask for it.
 * - An `Error` instance in the results rejects that key only. A batch function that throws, rejects, or returns anything but an array
 *   (or array-like object) of exactly one value per key rejects every key of the batch (with its error, or a `TypeError`).
 * - `maxBatchSize` splits large batches.
 * - A caller's `signal` stops its wait, and removes its key from a batch not yet dispatched when no other caller waits for it.
 *
 * Nothing is cached across batches by default, unlike DataLoader, whose default unbounded cache serves stale values forever (and
 * grows without bound) as soon as a loader outlives its request. Pass `cache: true` for a per-request batcher, or a bounded store such
 * as `createLRUCache({ max, ttl })`; `clear`, `clearAll` and `prime` then keep it up to date after writes. The batch function may call
 * `load` itself: those keys go to a new batch, except, with a cache, keys of a batch still in flight, which join it (so awaiting one of
 * the batch's own keys from inside the batch function never settles). To cap how many batches run at once, call the batch function through
 * {@link createLimiter}.
 * @template K - The key type
 * @template V - The value type
 * @param {BatchLoadFunction<K, V>} batchLoad - Receives the distinct keys of a batch and returns (a promise of) one value per key, in order
 * @param {BatcherOptions<K, V>} [options] - `delay`, `maxBatchSize` (Infinity), `key` and `cache` (false)
 * @returns {Batcher<K, V>} The batcher, with `load`, `loadMany`, `clear`, `clearAll` and `prime`
 * @throws {TypeError} when `batchLoad` or `key` is not a function, `options` is not an object, `delay` or `maxBatchSize` is not a
 * number, or `cache` is neither a boolean nor a `Map`-like store
 * @throws {RangeError} when `delay` is not between `0` and `2^31 - 1`, or `maxBatchSize` is not an integer >= 1 or `Infinity`
 * @example
 * const calls: number[][] = [];
 * const users = createBatcher(async function (ids: number[]) {
 *   calls.push(ids);
 *   return ids.map(function (id) { return { id, name: `user ${id}` }; });
 * });
 * async function resolveAfter(awaits: number, id: number) { for (let i = 0; i < awaits; i++) await null; return users.load(id); }
 * const [first, second, again] = await Promise.all([users.load(1), resolveAfter(3, 2), resolveAfter(1, 1)]);
 * second; // => { id: 2, name: 'user 2' }
 * first === again; // => true
 * calls; // => [[1, 2]] // one call, each key once
 * @example
 * import { createLRUCache } from 'tinkit/cache';
 * const posts = createBatcher(
 *   async function (ids: number[]) { return ids.map(function (id) { return id > 0 ? `post ${id}` : new RangeError(`no post ${id}`); }); },
 *   { maxBatchSize: 100, cache: createLRUCache({ max: 1000, ttl: 60_000 }) }
 * );
 * await posts.loadMany([1, 2]); // => ['post 1', 'post 2']
 * await posts.load(-1); // throws RangeError // only this key fails
 * posts.prime(3, 'post 3 (edited)');
 * await posts.load(3); // => 'post 3 (edited)'
 */
export function createBatcher<K, V>(batchLoad: BatchLoadFunction<K, V>, options: BatcherOptions<K, V> = {}): Batcher<K, V> {
	if (typeof options !== 'object' || options === null) throw new TypeError(`createBatcher: \`options\` must be an object, got ${describe(options)}`);

	const delay = readOption(options, 'delay');
	const maxBatchSize = readOption(options, 'maxBatchSize', Infinity);
	const keyOf = readOption(options, 'key');
	const cacheOption = readOption(options, 'cache', false);

	assertFunction('createBatcher', 'batchLoad', batchLoad);
	if (delay !== undefined) assertDelay('createBatcher', 'delay', delay);
	assertInteger('createBatcher', 'maxBatchSize', maxBatchSize, 1, true);
	if (keyOf !== undefined) assertFunction('createBatcher', 'key', keyOf);
	if (typeof cacheOption !== 'boolean' && !isCacheLike(cacheOption)) {
		throw new TypeError(`createBatcher: \`cache\` must be a boolean or a Map-like cache, got ${describe(cacheOption)}`);
	}

	const cache = cacheOption === true ? new Map<unknown, unknown>() : cacheOption === false ? undefined : (cacheOption as MemoizeCache<unknown, unknown>);
	// With a cache: the entry of every key requested and not settled yet, dispatched or not (single flight). Only the entry still
	// registered here when its batch settles writes its value to the cache.
	const inflight = new Map<unknown, BatchEntry>();
	let pending: Batch | undefined;

	/**
	 * Computes the identity of a key.
	 * @param {unknown} key - The key
	 * @returns {unknown} Its identity
	 */
	function identify(key: unknown): unknown {
		return keyOf === undefined ? key : keyOf(key as K);
	}

	/**
	 * Calls the batch function with the keys of a batch, and settles their entries with the outcome.
	 * @param {Batch} batch - The batch
	 * @returns {void}
	 */
	function dispatch(batch: Batch): void {
		if (pending === batch) pending = undefined;
		batch.dispatched = true;

		// Keys whose callers all aborted (or were primed) have left the batch: when none is left, there is nothing to request.
		const entries = Array.from(batch.entries.values());

		if (entries.length === 0) return;

		let values: unknown;
		let direct: boolean;

		try {
			values = (batchLoad as (keys: unknown[]) => unknown)(
				entries.map(function (entry) {
					return entry.key;
				})
			);
			// An array is read as it is: resolving it like a promise would look up a `then` method, which a polluted prototype supplies.
			direct = Array.isArray(values) || ArrayBuffer.isView(values);
			if (!direct) values = toPromise(values);
		} catch (error) {
			fail(entries, error);
			return;
		}
		if (direct) {
			complete(entries, values);
			return;
		}
		(values as Promise<unknown>).then(
			function (resolved) {
				complete(entries, resolved);
			},
			function (error: unknown) {
				fail(entries, error);
			}
		);
	}

	/**
	 * Settles the entries of a batch with the values the batch function returned.
	 * @param {BatchEntry[]} entries - The entries
	 * @param {unknown} values - The values
	 * @returns {void}
	 */
	function complete(entries: BatchEntry[], values: unknown): void {
		let results: unknown[];

		try {
			results = readValues(values, entries.length);
		} catch (error) {
			fail(entries, error);
			return;
		}
		entries.forEach(function (entry, index) {
			const value = results[index];
			const current = settle(entry);

			if (isError(value)) {
				entry.deferred.reject(value);
				return;
			}
			// Stored before the callers resume, so that their next `load` finds it.
			if (current) store(entry.id, value);
			entry.deferred.resolve(value);
		});
	}

	/**
	 * Rejects every entry of a batch.
	 * @param {BatchEntry[]} entries - The entries
	 * @param {unknown} error - The rejection reason
	 * @returns {void}
	 */
	function fail(entries: BatchEntry[], error: unknown): void {
		for (const entry of entries) {
			settle(entry);
			entry.deferred.reject(error);
		}
	}

	/**
	 * Unregisters a settling entry from the requests in flight.
	 * @param {BatchEntry} entry - The entry
	 * @returns {boolean} Whether it was still registered (only then may its value be cached)
	 */
	function settle(entry: BatchEntry): boolean {
		if (inflight.get(entry.id) !== entry) return false;
		inflight.delete(entry.id);

		return true;
	}

	/**
	 * Writes a value to the cache.
	 * @param {unknown} id - The key identity
	 * @param {unknown} value - The value
	 * @returns {void}
	 */
	function store(id: unknown, value: unknown): void {
		try {
			(cache as MemoizeCache<unknown, unknown>).set(id, value);
		} catch {
			// The callers get the value anyway: a cache that cannot store it only makes the next `load` request it again.
		}
	}

	/**
	 * Unregisters the dispatched request for a key, so that its (possibly stale) value is not cached. A request not dispatched yet
	 * cannot be stale: it stays.
	 * @param {unknown} id - The key identity
	 * @returns {void}
	 */
	function forget(id: unknown): void {
		if (inflight.get(id)?.batch.dispatched) inflight.delete(id);
	}

	/**
	 * Returns the entry a new caller of `key` waits for: the request in flight (with a cache), the entry in the open batch, or a new
	 * entry, opening a batch when none is open.
	 * @param {unknown} key - The key
	 * @param {unknown} id - Its identity
	 * @returns {BatchEntry} The entry, counting the caller among its waiters
	 */
	function join(key: unknown, id: unknown): BatchEntry {
		let entry = cache === undefined ? pending?.entries.get(id) : inflight.get(id);

		if (entry === undefined) {
			let batch = pending;

			if (batch === undefined) {
				const opened: Batch = { entries: new Map(), timer: undefined, dispatched: false };

				batch = pending = opened;
				if (delay === undefined) {
					afterMicrotasks(function () {
						dispatch(opened);
					});
				} else {
					opened.timer = setTimeout(dispatch, delay, opened);
				}
			}
			entry = { key, id, batch, deferred: createDeferred<unknown>(), waiters: 0 };
			batch.entries.set(id, entry);
			if (cache !== undefined) inflight.set(id, entry);
			// A full batch is sealed: later keys open a new one. With a `delay`, it goes in a microtask rather than when its timer fires.
			if (batch.entries.size >= maxBatchSize) {
				const full = batch;

				pending = undefined;
				if (full.timer !== undefined) {
					clearTimeout(full.timer);
					full.timer = undefined;
					Promise.resolve().then(function () {
						dispatch(full);
					});
				}
			}
		}
		entry.waiters++;

		return entry;
	}

	/**
	 * Removes an aborted caller from an entry, and the entry from its batch when nobody else waits for it and the batch has not been
	 * dispatched yet (an entry already settled by `prime` has left it).
	 * @param {BatchEntry} entry - The entry
	 * @returns {void}
	 */
	function leave(entry: BatchEntry): void {
		if (--entry.waiters > 0 || entry.batch.dispatched || entry.batch.entries.get(entry.id) !== entry) return;
		entry.batch.entries.delete(entry.id);
		settle(entry);
		discardIfEmpty(entry.batch);
	}

	/**
	 * Drops a batch waiting for its `delay` once every key has left it (aborted or primed): its timer would otherwise keep running (and
	 * a process alive) for nothing. The next key opens a new batch.
	 * @param {Batch} batch - A batch not dispatched yet
	 * @returns {void}
	 */
	function discardIfEmpty(batch: Batch): void {
		// Only an open batch has a timer (a sealed one is dispatched in a microtask, which finds it empty).
		if (batch.entries.size > 0 || batch.timer === undefined) return;
		clearTimeout(batch.timer);
		batch.dispatched = true;
		pending = undefined;
	}

	/**
	 * Requests the value of a key, once the options have been read and checked.
	 * @param {unknown} key - The key
	 * @param {AbortSignalLike | null | undefined} signal - The caller's signal
	 * @param {{ id: unknown }} [known] - The identity of the key, when already computed
	 * @returns {Promise<unknown>} The value
	 */
	function request(key: unknown, signal: AbortSignalLike | null | undefined, known?: { id: unknown }): Promise<unknown> {
		return new Promise<unknown>(function (resolve, reject) {
			// Checked for every key: the `key` functions of a `loadMany`, or the cache of an earlier key, may have aborted it.
			if (signal?.aborted) throw abortReason(signal);

			const id = known === undefined ? identify(key) : known.id;

			if (cache !== undefined) {
				// Read once, then `has` only for a cached `undefined` (an expiring cache could drop the entry between the two).
				const cached = cache.get(id);

				if (cached !== undefined || cache.has(id)) {
					resolve(cached);
					return;
				}
			}
			if (signal === null || signal === undefined) {
				resolve(join(key, id).deferred.promise);
				return;
			}

			// Again: the `key` function or the cache may have aborted it, and a listener added now would never be called.
			if (signal.aborted) throw abortReason(signal);

			const entry = join(key, id);
			let stopped = false;

			/**
			 * Stops waiting (once): rejects, and leaves the entry.
			 * @param {unknown} reason - The rejection reason
			 * @returns {void}
			 */
			function stop(reason: unknown): void {
				if (stopped) return;
				stopped = true;
				reject(reason);
				leave(entry);
			}

			try {
				watchSignal(signal, stop);
			} catch (error) {
				// The key leaves its batch again (unless another caller waits for it).
				stop(error);
				return;
			}
			entry.deferred.promise.then(
				function (value) {
					unwatchSignal(signal, stop);
					resolve(value);
				},
				function (error: unknown) {
					unwatchSignal(signal, stop);
					reject(error);
				}
			);
		});
	}

	return {
		load(key: K, loadOptions?: BatcherLoadOptions): Promise<V> {
			let signal: AbortSignalLike | null | undefined;

			try {
				signal = signalOption('Batcher.load', loadOptions);
			} catch (error) {
				return Promise.reject(error);
			}

			return request(key, signal) as Promise<V>;
		},
		loadMany(keys: Iterable<K>, loadOptions?: BatcherLoadOptions): Promise<V[]> {
			let list: K[];
			let ids: unknown[];
			let signal: AbortSignalLike | null | undefined;

			try {
				if (keys === null || keys === undefined || typeof (keys as Partial<Iterable<K>>)[Symbol.iterator] !== 'function') {
					throw new TypeError(`Batcher.loadMany: \`keys\` must be an iterable, got ${describe(keys)}`);
				}
				signal = signalOption('Batcher.loadMany', loadOptions);
				list = Array.from(keys);
				// Like `load`: an aborted signal wins over the `key` function, which is then never called.
				if (signal?.aborted) throw abortReason(signal);
				ids = list.map(identify);
			} catch (error) {
				return Promise.reject(error);
			}

			// A key listed twice is requested once, even when `maxBatchSize` seals its batch before the second occurrence.
			const requests = new Map<unknown, Promise<unknown>>();

			return Promise.all(
				list.map(function (key, index) {
					const id = ids[index];
					let promise = requests.get(id);

					if (promise === undefined) {
						promise = request(key, signal, { id });
						requests.set(id, promise);
					}

					return promise;
				})
			) as Promise<V[]>;
		},
		clear(key: K): void {
			if (cache === undefined) return;

			const id = identify(key);

			cache.delete(id);
			forget(id);
		},
		clearAll(): void {
			if (cache === undefined) return;
			cache.clear();
			for (const id of inflight.keys()) forget(id);
		},
		prime(key: K, value: V): void {
			if (isError(value)) throw new TypeError('Batcher.prime: `value` must not be an Error (errors are never cached)');
			if (cache === undefined) return;

			const id = identify(key);
			const entry = inflight.get(id);

			cache.set(id, value);
			if (entry === undefined) return;
			// A request in flight must not overwrite the primed value; one not dispatched yet is answered now and not made at all.
			inflight.delete(id);
			if (!entry.batch.dispatched) {
				entry.batch.entries.delete(id);
				entry.deferred.resolve(value);
				discardIfEmpty(entry.batch);
			}
		}
	};
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
 * is attached. Otherwise the result is registered with each input (which gets one `abort` listener, shared by everything of this
 * module waiting on it), and unregistered from all of them as soon as it aborts. Note that if no input ever aborts, the registrations
 * stay for as long as the inputs live (unlike the native implementation, which holds them weakly), so avoid creating unbounded numbers
 * of combined signals from one long-lived signal.
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
	const array = Array.isArray(signals);
	let index = 0;
	for (let signal of signals) {
		// A hole of an array (`[a, , b]`) is skipped like `undefined`, not read from a polluted `Object.prototype`.
		if (array && !Object.hasOwn(signals, index)) signal = undefined;
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
	const listeners = inputs.map(function () {
		return function onAbort(reason: unknown): void {
			release();
			controller.abort(reason);
		};
	});

	/**
	 * Removes every listener (the first abort does it, so none runs twice).
	 * @returns {void}
	 */
	function release(): void {
		inputs.forEach(function (input, i) {
			unwatchSignal(input, listeners[i]);
		});
	}

	if (aborted !== undefined) {
		controller.abort(abortReason(aborted));
	} else {
		try {
			inputs.forEach(function (input, i) {
				watchSignal(input, listeners[i]);
			});
		} catch (error) {
			// The listeners already added would keep the combined signal (and what it is attached to) alive.
			release();
			throw error;
		}
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
		const settled = toPromise(promise) as Promise<T>;
		try {
			assertOptionalSignal('abortable', 'signal', signal);
		} catch (error) {
			// The argument error wins, but `promise` may still reject: handle it so it does not surface as an unhandled rejection.
			settled.catch(noop);
			throw error;
		}

		/**
		 * Abort listener: rejects with the abort reason.
		 * @param {unknown} reason - The abort reason
		 * @returns {void}
		 */
		function onAbort(reason: unknown): void {
			reject(reason);
		}

		settled.then(
			function (value) {
				resolve(value);
				unwatchSignal(signal, onAbort);
			},
			function (error: unknown) {
				reject(error);
				unwatchSignal(signal, onAbort);
			}
		);

		if (signal?.aborted) reject(abortReason(signal));
		else watchSignal(signal, onAbort);
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

// ---------------------------------------------------------------------------------------------------------------------
// waitForEvent / reduceAsync / minDelay
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The platform's `Event` type when the consumer's TypeScript environment declares one (DOM or Node typings), and `unknown` otherwise:
 * what {@link waitForEvent} resolves with for an {@link EventTargetLike} by default.
 */
export type PlatformEvent = typeof globalThis extends { Event: { prototype: infer E } } ? E : unknown;

/**
 * An object with DOM-style `addEventListener` and `removeEventListener` methods: an `EventTarget` such as a DOM element, `window`, a
 * `WebSocket`, a worker, an `AbortSignal` or Node's `EventTarget`.
 */
export interface EventTargetLike {
	addEventListener(type: string, listener: never): void;
	removeEventListener(type: string, listener: never): void;
}

/**
 * A Node.js-style event emitter: one with `on` and `off` methods (Node's `EventEmitter`, `createEmitter` from the emitter module, mitt…),
 * or with `addListener` and `removeListener`.
 */
export type EventEmitterLike =
	| { on(type: never, listener: never): unknown; off(type: never, listener: never): unknown }
	| { addListener(type: never, listener: never): unknown; removeListener(type: never, listener: never): unknown };

/**
 * Options accepted by {@link waitForEvent}.
 * @template T - The event (or first listener argument) type
 */
export interface WaitForEventOptions<T> {
	/** Stops waiting, rejecting with the signal's `reason` (or an {@link AbortError}). */
	signal?: AbortSignalLike | null;
	/** Time limit in ms (`0` to `2^31 - 1`, or `Infinity`, the default), after which the promise rejects with a {@link TimeoutError}. */
	timeout?: number;
	/** Only events for which this returns a truthy value resolve the promise. If it throws, the promise rejects with that error. */
	filter?(event: T): boolean;
	/** Event types that reject the promise with their event (or first listener argument), such as `['error']`. Defaults to none. */
	rejectOn?: ReadonlyArray<string | symbol>;
}

/**
 * Throws a `TypeError` unless `value` is a string or a symbol.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 */
function assertEventType(caller: string, name: string, value: unknown): void {
	if (typeof value !== 'string' && typeof value !== 'symbol') throw new TypeError(`${caller}: \`${name}\` must be a string or a symbol, got ${describe(value)}`);
}

/**
 * Finds the methods that add and remove listeners on an event target or emitter (see {@link waitForEvent}), and validates the event type.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} target - The event target or emitter
 * @param {unknown} type - The event type
 * @returns {[AnyFunction, AnyFunction]} The add and remove methods (unbound)
 * @throws {TypeError} when `target` has no supported listener methods, or `type` is neither a string nor a symbol
 */
function listenerMethods(caller: string, target: unknown, type: unknown): [AnyFunction, AnyFunction] {
	const methods = target as Record<string, unknown>;
	let add: unknown;
	let remove: unknown;

	if ((typeof target === 'object' && target !== null) || typeof target === 'function') {
		for (const [adder, remover] of [
			['addEventListener', 'removeEventListener'],
			['on', 'off'],
			['addListener', 'removeListener']
		]) {
			add = methods[adder];
			remove = methods[remover];
			if (typeof add === 'function' && typeof remove === 'function') break;
		}
	}
	if (typeof add !== 'function' || typeof remove !== 'function') {
		throw new TypeError(`${caller}: \`target\` must be an EventTarget or an event emitter, got ${describe(target)}`);
	}
	assertEventType(caller, 'type', type);

	return [add as AnyFunction, remove as AnyFunction];
}

/**
 * Throws a `TypeError` unless `rejectOn` is an array of strings and symbols.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} rejectOn - The value to validate
 * @returns {void}
 */
function assertRejectOn(caller: string, rejectOn: unknown): asserts rejectOn is ReadonlyArray<string | symbol> {
	if (!Array.isArray(rejectOn)) throw new TypeError(`${caller}: \`rejectOn\` must be an array, got ${describe(rejectOn)}`);
	rejectOn.forEach(function (rejectType: unknown, index) {
		assertEventType(caller, `rejectOn[${index}]`, rejectType);
	});
}

/**
 * Removes the listeners recorded in `added` from `target`, and empties it (each listener is removed once, also when another removal
 * throws).
 * @param {unknown} target - The event target or emitter
 * @param {AnyFunction} remove - Its remove method
 * @param {Array<[unknown, (event: unknown) => void]>} added - The listeners added so far, as `[type, listener]` pairs
 * @returns {void}
 */
function removeListeners(target: unknown, remove: AnyFunction, added: Array<[unknown, (event: unknown) => void]>): void {
	for (const pair of added.splice(0)) {
		try {
			Reflect.apply(remove, target, pair);
		} catch {
			// The other listeners must still be removed.
		}
	}
}

/**
 * Adds `listener` for `type`, and `onReject` for each of the `rejectOn` types, to `target`, recording each one in `added` as soon as it
 * is added, so that the caller can remove those added so far at any time (see {@link removeListeners}). A listener called while being
 * added (an emitter replaying its last event) may have ended the operation: once `stopped()` is true, no more are added. When adding one
 * throws, the error propagates; removing the listeners already added is left to the caller in both cases.
 * @param {unknown} target - The event target or emitter
 * @param {AnyFunction} add - Its add method
 * @param {Array<[unknown, (event: unknown) => void]>} added - Receives the listeners added
 * @param {unknown} type - The event type
 * @param {(event: unknown) => void} listener - The listener of `type`
 * @param {ReadonlyArray<string | symbol>} rejectOn - The event types that end the operation with an error
 * @param {(event: unknown) => void} onReject - Their listener
 * @param {() => boolean} stopped - Whether the operation has ended
 * @returns {void}
 */
function addListeners(
	target: unknown,
	add: AnyFunction,
	added: Array<[unknown, (event: unknown) => void]>,
	type: unknown,
	listener: (event: unknown) => void,
	rejectOn: ReadonlyArray<string | symbol>,
	onReject: (event: unknown) => void,
	stopped: () => boolean
): void {
	for (const pair of [
		[type, listener],
		...rejectOn.map(function (rejectType) {
			return [rejectType, onReject];
		})
	] as Array<[unknown, (event: unknown) => void]>) {
		Reflect.apply(add, target, pair);
		added.push(pair);
		if (stopped()) return;
	}
}

/**
 * Waits for the next `type` event of a DOM `EventTarget` (resolving with the `Event`) or of a Node-style emitter (resolving with the first
 * argument the listeners receive), like `events.once` or `p-event`, with the cleanup done right:
 * - `filter` skips the events it does not accept; `rejectOn: ['error']` rejects with the first `error` event instead of waiting forever.
 * - `timeout` rejects with a {@link TimeoutError}, `signal` with its `reason`.
 * - However it settles, every listener it added (to `target` and to `signal`) is removed and its timer cleared, so waiting in a loop leaks
 *   nothing. Listeners are added with `addEventListener` when `target` has it, otherwise with `on` (removed with `off`), otherwise with
 *   `addListener` (removed with `removeListener`); `once` is never used, so that filtered-out events do not unsubscribe.
 * @template E - The event type for an `EventTarget` (defaults to the platform's `Event`)
 * @param {EventTargetLike} target - The event target
 * @param {string} type - The event type to wait for
 * @param {WaitForEventOptions<E>} [options] - `signal`, `timeout`, `filter` and `rejectOn`
 * @returns {Promise<E>} The first accepted event
 * @throws {TypeError} (as a rejection) when `target` has no supported listener methods, `type` or an entry of `rejectOn` is neither a
 *   string nor a symbol, `filter` is not a function, `rejectOn` is not an array, `timeout` is not a number or `signal` is not a signal
 * @throws {RangeError} (as a rejection) when `timeout` is neither a number between `0` and `2^31 - 1` nor `Infinity`
 * @throws {TimeoutError} (as a rejection) when no accepted event arrives within `timeout` ms
 * @throws {unknown} (as a rejection) the event of a `rejectOn` type, the error thrown by `filter`, or the abort reason of `signal`
 * @example
 * const target = new EventTarget();
 * setTimeout(function () { target.dispatchEvent(new Event('ready')); }, 10);
 * const event = await waitForEvent(target, 'ready', { timeout: 1000 });
 * event.type; // => 'ready'
 * @example
 * import { EventEmitter } from 'node:events';
 * const socket = new EventEmitter();
 * setTimeout(function () { socket.emit('message', 'ping'); socket.emit('message', 'hello'); }, 10);
 * await waitForEvent<string>(socket, 'message', { filter: function (text) { return text !== 'ping'; } }); // => 'hello'
 * setTimeout(function () { socket.emit('error', new Error('connection reset')); }, 10);
 * await waitForEvent(socket, 'message', { rejectOn: ['error'] }); // throws Error
 * socket.listenerCount('message') + socket.listenerCount('error'); // => 0
 */
export function waitForEvent<E = PlatformEvent>(target: EventTargetLike, type: string, options?: WaitForEventOptions<E>): Promise<E>;
/**
 * Waits for the next `type` event of a Node-style emitter (see the first overload).
 * @template T - The type of the first listener argument
 * @param {EventEmitterLike} target - The emitter
 * @param {string | symbol} type - The event type to wait for
 * @param {WaitForEventOptions<T>} [options] - `signal`, `timeout`, `filter` and `rejectOn`
 * @returns {Promise<T>} The first argument of the first accepted event
 * @example
 * import { createEmitter } from 'tinkit/emitter';
 * const events = createEmitter<{ saved: { id: number } }>();
 * setTimeout(function () { events.emit('saved', { id: 7 }); }, 10);
 * await waitForEvent<{ id: number }>(events, 'saved'); // => { id: 7 }
 */
export function waitForEvent<T = unknown>(target: EventEmitterLike, type: string | symbol, options?: WaitForEventOptions<T>): Promise<T>;
/**
 * Waits for the next `type` event of `target` (see the first overload).
 * @param {EventTargetLike | EventEmitterLike} target - The event target or emitter
 * @param {string | symbol} type - The event type to wait for
 * @param {WaitForEventOptions<unknown>} [options] - `signal`, `timeout`, `filter` and `rejectOn`
 * @returns {Promise<unknown>} The first accepted event
 */
export function waitForEvent(target: EventTargetLike | EventEmitterLike, type: string | symbol, options: WaitForEventOptions<unknown> = {}): Promise<unknown> {
	return new Promise<unknown>(function (resolve, reject) {
		const signal = readOption(options, 'signal');
		const timeout = readOption(options, 'timeout', Infinity);
		const filter = readOption(options, 'filter');
		const rejectOn = readOption(options, 'rejectOn', []);
		const [add, remove] = listenerMethods('waitForEvent', target, type);

		assertDelay('waitForEvent', 'timeout', timeout, true);
		if (filter !== undefined) assertFunction('waitForEvent', 'filter', filter);
		assertRejectOn('waitForEvent', rejectOn);
		assertOptionalSignal('waitForEvent', 'signal', signal);
		if (signal?.aborted) throw abortReason(signal);

		const added: Array<[unknown, (event: unknown) => void]> = [];
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		/**
		 * Removes the listeners added to `target` so far.
		 * @returns {void}
		 */
		function unlisten(): void {
			removeListeners(target, remove, added);
		}

		/**
		 * Settles the promise and releases the listeners, the timer and the abort listener.
		 * @param {(value: never) => void} settle - `resolve` or `reject`
		 * @param {unknown} value - The value or reason
		 * @returns {void}
		 */
		function finish(settle: (value: never) => void, value: unknown): void {
			done = true;
			unlisten();
			clearTimeout(timer);
			unwatchSignal(signal, onAbort);
			settle(value as never);
		}

		/**
		 * Abort listener.
		 * @param {unknown} reason - The abort reason
		 * @returns {void}
		 */
		function onAbort(reason: unknown): void {
			finish(reject, reason);
		}

		/**
		 * Listener of `type`: settles with the first accepted event.
		 * @param {unknown} event - The event, or the first listener argument
		 * @returns {void}
		 */
		function onEvent(event: unknown): void {
			let accepted: boolean;

			try {
				accepted = filter === undefined || filter(event);
			} catch (error) {
				finish(reject, error);
				return;
			}

			if (accepted) finish(resolve, event);
		}

		/**
		 * Listener of the `rejectOn` types.
		 * @param {unknown} event - The event, or the first listener argument
		 * @returns {void}
		 */
		function onReject(event: unknown): void {
			finish(reject, event);
		}

		// The abort listener first: when adding it throws, nothing else is left behind. `finish` removes it.
		watchSignal(signal, onAbort);

		try {
			addListeners(target, add, added, type, onEvent, rejectOn, onReject, function () {
				return done;
			});
		} catch (error) {
			finish(reject, error);
			return;
		}
		// A listener called while being added has settled the promise (and removed the listeners added before it).
		if (done) {
			unlisten();
			return;
		}

		if (timeout !== Infinity) {
			timer = setTimeout(function () {
				finish(reject, new TimeoutError(`waitForEvent: no \`${String(type)}\` event within ${timeout} ms`));
			}, timeout);
		}
	});
}

/**
 * Options accepted by {@link reduceAsync}.
 */
export interface ReduceAsyncOptions {
	/**
	 * Aborting it stops the reduction: no further item is read or reduced, a running `reducer` or a pending read of the next item stops
	 * being awaited (neither is interrupted), the iterator is closed, and the promise rejects with the signal's `reason` (or an
	 * {@link AbortError}). When the abort comes during a read, the close is requested without waiting for it: an async generator only runs
	 * it once that read settles. Otherwise the promise rejects once the iterator is closed, as `for await` waits for it (an async generator
	 * whose `finally` block never settles keeps it pending).
	 */
	signal?: AbortSignalLike | null;
}

/**
 * Reduces a sync or async iterable with an async `reducer`, one item at a time, in order: each item is read only after the previous step
 * has settled, so lazy and infinite sources (async generators, paginated APIs, streams) are consumed on demand. Promises among the items
 * of a sync iterable, and `initial`, are awaited. The iterator is closed when the reduction stops early (a throwing `reducer`, an abort).
 * @template T - The item type
 * @template A - The accumulator type
 * @param {Iterable<T> | AsyncIterable<T>} items - The items
 * @param {(accumulator: A, item: Awaited<T>, index: number) => PromiseLike<A> | A} reducer - Called with the accumulator, the item and its index
 * @param {PromiseLike<A> | A} initial - The initial accumulator
 * @param {ReduceAsyncOptions} [options] - An optional `signal`
 * @returns {Promise<A>} The final accumulator
 * @throws {TypeError} (as a rejection) when `items` is not iterable, `reducer` is not a function or `signal` is not a signal
 * @throws {unknown} (as a rejection) the first error thrown or rejected by `reducer` or by the iterable, or the abort reason of `signal`
 * @example
 * async function* pages(): AsyncGenerator<number[]> { yield [1, 2]; yield [3]; }
 * await reduceAsync(pages(), async function (total, page) { await sleep(1); return total + page.length; }, 0); // => 3
 * await reduceAsync([Promise.resolve('a'), 'b'], function (text, letter, index) { return text + letter + index; }, ''); // => 'a0b1'
 */
export async function reduceAsync<T, A>(
	items: Iterable<T> | AsyncIterable<T>,
	reducer: (accumulator: A, item: Awaited<T>, index: number) => PromiseLike<A> | A,
	initial: PromiseLike<A> | A,
	options: ReduceAsyncOptions = {}
): Promise<A> {
	const signal = readOption(options, 'signal');
	const source = items as Partial<Iterable<T> & AsyncIterable<T>> | null | undefined;

	if (source === null || source === undefined || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
		throw new TypeError(`reduceAsync: \`items\` must be an iterable or an async iterable, got ${describe(items)}`);
	}
	assertFunction('reduceAsync', 'reducer', reducer);
	assertOptionalSignal('reduceAsync', 'signal', signal);

	let accumulator = await abortable(initial, signal);
	let index = 0;
	// Iterated by hand rather than with `for await`, so that an abort also interrupts the wait for the next item (an idle source would
	// otherwise keep the reduction pending forever). A sync iterable is wrapped like `for await` does: its values are awaited.
	const iterator: AsyncIterator<T> =
		typeof source[Symbol.asyncIterator] === 'function'
			? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
			: (async function* (): AsyncGenerator<T> {
					yield* source as Iterable<T>;
				})();

	for (;;) {
		// Aborted between two steps (e.g. by a microtask after the reducer settled): no further item is read.
		if (signal?.aborted) {
			await closeIterator(iterator);
			throw abortReason(signal);
		}
		let step: IteratorResult<T>;
		try {
			step = await abortable(iterator.next(), signal);
		} catch (error) {
			// `return` would be queued behind the pending `next`, which may never settle: request the close without waiting for it.
			if (signal?.aborted) void closeIterator(iterator);
			throw error;
		}
		// As `for await`: a result that is not an object is an error (the iterator is not closed), and `done` is read as a boolean.
		if ((typeof step !== 'object' && typeof step !== 'function') || step === null)
			throw new TypeError(`reduceAsync: the iterator returned a result that is not an object, got ${describe(step)}`);
		const done = Boolean(step.done);
		// Aborted while the last item was being read.
		if (signal?.aborted) {
			if (!done) await closeIterator(iterator);
			throw abortReason(signal);
		}
		if (done) return accumulator;
		try {
			accumulator = await abortable(reducer(accumulator, step.value as Awaited<T>, index++), signal);
		} catch (error) {
			await closeIterator(iterator);
			throw error;
		}
	}
}

/**
 * Closes an iterator that is abandoned early, like `for await` does on a `break` or a throw: calls its `return` method, if any, and
 * ignores a failure to close (the reason the loop stopped is the error that matters).
 * @param {AsyncIterator<unknown>} iterator - The iterator to close
 * @returns {Promise<void>} Settles once the iterator is closed
 */
async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
	try {
		await iterator.return?.();
	} catch {
		// Ignored, as by `for await`.
	}
}

/**
 * Options accepted by {@link minDelay}.
 */
export interface MinDelayOptions {
	/** When `true` (the default), a rejection is held back until `ms` have passed too; with `false`, it comes through at once. */
	delayRejection?: boolean;
}

/**
 * Settles like `promise`, but no earlier than `ms` milliseconds after the call (like `p-min-delay`): a loading indicator shown while
 * waiting then stays up long enough to be read, instead of flickering when the response is fast. A slower `promise` is not delayed
 * further. The timer is cleared when a rejection comes through early (`delayRejection: false`).
 * @template T - The resolved value type
 * @param {PromiseLike<T> | T} promise - The promise (or value) to wait for
 * @param {number} ms - The minimum delay in milliseconds (`0` to `2^31 - 1`)
 * @param {MinDelayOptions} [options] - `delayRejection` (default `true`)
 * @returns {Promise<T>} A promise settling like `promise`, at the earliest `ms` milliseconds from now
 * @throws {TypeError} (as a rejection) when `ms` is not a number
 * @throws {RangeError} (as a rejection) when `ms` is negative, `NaN` or larger than `2^31 - 1`
 * @throws {unknown} (as a rejection) the rejection of `promise`
 * @example
 * const start = Date.now();
 * await minDelay(Promise.resolve('cached'), 50); // => 'cached'
 * Date.now() - start >= 49; // => true
 * @example
 * const start = Date.now();
 * await minDelay(Promise.reject(new Error('offline')), 50, { delayRejection: false }); // throws Error
 * Date.now() - start < 49; // => true
 */
export function minDelay<T>(promise: PromiseLike<T> | T, ms: number, options: MinDelayOptions = {}): Promise<T> {
	return new Promise<T>(function (resolve, reject) {
		const settled = toPromise(promise) as Promise<T>;
		let delayRejection: boolean;

		try {
			assertDelay('minDelay', 'ms', ms);
			delayRejection = readOption(options, 'delayRejection', true);
		} catch (error) {
			// The argument error wins, but `promise` may still reject: handle it so it does not surface as an unhandled rejection.
			settled.catch(noop);
			throw error;
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const elapsed = new Promise<void>(function (done) {
			timer = setTimeout(done, ms);
		});

		settled.then(
			function (value) {
				elapsed.then(function () {
					resolve(value);
				});
			},
			function (error: unknown) {
				if (delayRejection) {
					elapsed.then(function () {
						reject(error);
					});
				} else {
					clearTimeout(timer);
					reject(error);
				}
			}
		);
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// isAbortError / isTimeoutError / createCircuitBreaker / backoff
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether `value` is an error-like object (a string `message`) whose `name` is `name`. Realm-independent (no `instanceof`), and never
 * throws: a throwing getter or a revoked proxy gives `false`. A `name` or `message` inherited from a polluted `Object.prototype` does
 * not count.
 * @param {unknown} value - The value to check
 * @param {string} name - The expected `name`
 * @returns {boolean} Whether `value` is such an error
 */
function isErrorNamed(value: unknown, name: string): boolean {
	if (typeof value !== 'object' || value === null) return false;
	try {
		const error = value as { name?: unknown; message?: unknown };
		return readOption(error, 'name') === name && typeof readOption(error, 'message') === 'string';
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is an abort error: an error-like object (with a string `message`) whose `name` is `'AbortError'`. That covers
 * this module's {@link AbortError}, the `DOMException` that `AbortController.abort()` gives without a reason (and that `fetch` rejects
 * with), Node's `AbortError`, and such errors from other realms (iframes, workers, `vm` contexts) or rebuilt from JSON, where
 * `instanceof` fails. Never throws: a throwing getter or a revoked proxy gives `false`.
 *
 * `AbortSignal.timeout()` aborts with a `'TimeoutError'` instead (as does {@link timeoutSignal}): check {@link isTimeoutError} too to
 * catch both.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether `value` is an abort error
 * @example
 * isAbortError(new AbortError()); // => true
 * const controller = new AbortController();
 * controller.abort();
 * isAbortError(controller.signal.reason); // => true // a DOMException
 * isAbortError({ name: 'AbortError', message: 'from JSON' }); // => true
 * isAbortError(new TimeoutError()); // => false
 * isAbortError('AbortError'); // => false
 */
export function isAbortError(value: unknown): value is Error & { readonly name: 'AbortError' } {
	return isErrorNamed(value, 'AbortError');
}

/**
 * Checks whether a value is a timeout error: an error-like object (with a string `message`) whose `name` is `'TimeoutError'`. That
 * covers this module's {@link TimeoutError} (from {@link withTimeout}, {@link pollUntil}, {@link timeoutSignal}…), the `DOMException`
 * that `AbortSignal.timeout()` aborts with, and such errors from other realms or rebuilt from JSON. Never throws.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether `value` is a timeout error
 * @example
 * isTimeoutError(new TimeoutError()); // => true
 * const signal = AbortSignal.timeout(0);
 * await sleep(10);
 * isTimeoutError(signal.reason); // => true // a DOMException
 * isTimeoutError(new AbortError()); // => false
 * isTimeoutError(null); // => false
 */
export function isTimeoutError(value: unknown): value is Error & { readonly name: 'TimeoutError' } {
	return isErrorNamed(value, 'TimeoutError');
}

/**
 * Error with which a {@link createCircuitBreaker} breaker rejects the calls it does not let through.
 * @example
 * const error = new CircuitOpenError('the payment service is down', 5000);
 * error.name; // => 'CircuitOpenError'
 * error.retryAfter; // => 5000
 */
export class CircuitOpenError extends Error {
	override name = 'CircuitOpenError';
	/**
	 * Milliseconds until the circuit lets a trial call through: the rest of the reset timeout while it is open (`Infinity` when it never
	 * resets by itself), `0` while it is half-open and its trial calls are in flight.
	 */
	readonly retryAfter: number;

	/**
	 * @param {string} [message='The circuit is open.'] - The error message
	 * @param {number} [retryAfter=0] - Milliseconds until a call may be let through
	 */
	constructor(message = 'The circuit is open.', retryAfter = 0) {
		super(message);
		this.retryAfter = retryAfter;
	}
}

/**
 * The state of a {@link CircuitBreaker}: `'closed'` (calls go through), `'open'` (calls are rejected at once) or `'half-open'` (a few
 * trial calls go through to test whether the operation works again).
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Options accepted by {@link createCircuitBreaker}.
 */
export interface CircuitBreakerOptions {
	/** Number of consecutive failures that opens the circuit (an integer >= 1). Defaults to `5`. */
	failureThreshold?: number;
	/**
	 * Milliseconds the circuit stays open before letting trial calls through (`0` to `2^31 - 1`, or `Infinity`: only `reset()` closes it).
	 * Defaults to `30_000`.
	 */
	resetTimeout?: number;
	/** Number of trial calls let through while half-open (an integer >= 1); all of them must succeed to close the circuit. Defaults to `1`. */
	halfOpenMaxCalls?: number;
	/**
	 * Decides whether an error thrown or rejected by the operation counts as a failure (defaults to always). An error that does not (a
	 * `404`, a validation error) still reaches the caller, but counts as a success: the operation answered. When it throws, the call
	 * counts as a failure and rejects with that error.
	 */
	isFailure?(error: unknown): boolean;
	/**
	 * Called after each change of state, with the new and the previous state. An error it throws takes the place of the outcome of the
	 * call (or is thrown by the `open()` / `reset()` call, or the `state` / `stats` read) that caused the change; the change stands.
	 */
	onStateChange?(state: CircuitState, previous: CircuitState): void;
	/**
	 * Clock in milliseconds, read only while the circuit opens or is open. Defaults to `Date.now`. It must return a finite number (or the
	 * operation reading it throws); a clock going back counts as no time passing. It is called without a receiver: pass
	 * `performance.now.bind(performance)` rather than `performance.now`.
	 */
	now?(): number;
}

/**
 * Counters of a {@link CircuitBreaker}, as read from its `stats` property (a snapshot).
 */
export interface CircuitBreakerStats {
	/** The current state. */
	readonly state: CircuitState;
	/** Failures in a row in the current closed period (`0` while open or half-open). */
	readonly consecutiveFailures: number;
	/** Calls of the operation that settled without a counted failure. */
	readonly successes: number;
	/** Calls of the operation that settled with a counted failure. */
	readonly failures: number;
	/** Calls rejected with a {@link CircuitOpenError} without calling the operation. */
	readonly shortCircuited: number;
}

/**
 * A function guarded by {@link createCircuitBreaker}.
 * @template F - The guarded function type
 */
export interface CircuitBreaker<F extends AnyFunction> {
	/**
	 * Calls the operation (forwarding `this` and the arguments) when the circuit lets the call through, and settles like it; otherwise
	 * rejects with a {@link CircuitOpenError} without calling it. Synchronous throws become rejections.
	 */
	(this: ThisParameterType<F>, ...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
	/** The current state (an open circuit whose reset timeout has elapsed turns half-open when this is read). */
	readonly state: CircuitState;
	/** A snapshot of the counters (a null-prototype object). */
	readonly stats: CircuitBreakerStats;
	/** Opens the circuit now, as if the failure threshold had been reached: calls are rejected for `resetTimeout` ms. */
	open(): void;
	/** Closes the circuit and forgets the failures counted so far. */
	reset(): void;
}

/**
 * The settlement handlers of the calls a {@link CircuitBreaker} lets through in one generation.
 */
interface Settlers {
	readonly value: (value: unknown) => unknown;
	readonly error: (error: unknown) => never;
}

/**
 * Wraps an async (or sync) operation in a circuit breaker, which stops calling a dependency that keeps failing, so that callers fail fast
 * instead of piling up on timeouts, and the dependency gets time to recover:
 * - **Closed** (initially): calls go through. `failureThreshold` failures in a row (as decided by `isFailure`) open the circuit; a
 *   success resets the count.
 * - **Open**: calls are rejected at once with a {@link CircuitOpenError} whose `retryAfter` tells how long the circuit stays open.
 *   After `resetTimeout` ms, it turns half-open. There are no timers: the switch happens when the breaker is next called or its
 *   `state` read, so an idle breaker costs nothing and never keeps a process alive.
 * - **Half-open**: up to `halfOpenMaxCalls` trial calls go through, the others are rejected (`retryAfter` is `0`). The first failing trial
 *   reopens the circuit for another `resetTimeout`; once all of them have succeeded, it closes.
 *
 * Calls in flight while the state changes are handled by generations: every change of state, `open()` and `reset()` start a new one, and
 * a call only affects the state if it settles in the generation it started in. So a slow call made while closed that succeeds after the
 * circuit opened does not close it, a slow failure does not reopen a circuit that was reset or count toward a new streak, and concurrent
 * failures open the circuit once. Such a call still settles its caller, and counts in `stats`.
 *
 * A trial call that never settles keeps the circuit half-open: bound the operation with {@link withTimeout} or a `signal`.
 * @template F - The type of the operation
 * @param {F} fn - The operation
 * @param {CircuitBreakerOptions} [options] - `failureThreshold` (5), `resetTimeout` (30 000), `halfOpenMaxCalls` (1), `isFailure`, `onStateChange` and `now` (`Date.now`)
 * @returns {CircuitBreaker<F>} The guarded function, with `state`, `stats`, `open()` and `reset()`
 * @throws {TypeError} when `fn`, `isFailure`, `onStateChange` or `now` is not a function, or a numeric option is not a number
 * @throws {RangeError} when `failureThreshold` or `halfOpenMaxCalls` is not an integer >= 1, or `resetTimeout` is neither a number
 * between `0` and `2^31 - 1` nor `Infinity`
 * @example
 * let clock = 0;
 * let healthy = false;
 * async function charge(amount: number): Promise<number> { if (!healthy) throw new Error('payment service down'); return amount; }
 * const guarded = createCircuitBreaker(charge, { failureThreshold: 2, resetTimeout: 1000, now: function () { return clock; } });
 * await guarded(10); // throws Error
 * await guarded(10); // throws Error // the second failure in a row opens the circuit
 * guarded.state; // => 'open'
 * await guarded(10); // throws CircuitOpenError // rejected without calling `charge`
 * clock = 1000;
 * healthy = true;
 * await guarded(10); // => 10 // the trial call succeeds and closes the circuit
 * guarded.state; // => 'closed'
 * guarded.stats; // => { state: 'closed', consecutiveFailures: 0, successes: 1, failures: 2, shortCircuited: 1 }
 * @example
 * // doctest: skip
 * const getUser = createCircuitBreaker(function (id: string) { return withTimeout(fetchUser(id), 2000); }, {
 *   isFailure: function (error) { return !(error instanceof NotFoundError); }, // a 404 means the service is up
 *   onStateChange: function (state) { logger.warn(`users circuit is ${state}`); }
 * });
 * try { await getUser('42'); } catch (error) { if (error instanceof CircuitOpenError) return cached('42'); throw error; }
 */
export function createCircuitBreaker<F extends AnyFunction>(fn: F, options: CircuitBreakerOptions = {}): CircuitBreaker<F> {
	const caller = 'createCircuitBreaker';
	const failureThreshold = readOption(options, 'failureThreshold', 5);
	const resetTimeout = readOption(options, 'resetTimeout', 30_000);
	const halfOpenMaxCalls = readOption(options, 'halfOpenMaxCalls', 1);
	const isFailure = readOption(options, 'isFailure');
	const onStateChange = readOption(options, 'onStateChange');
	const now = readOption(options, 'now', Date.now);

	assertFunction(caller, 'fn', fn);
	assertInteger(caller, 'failureThreshold', failureThreshold, 1);
	assertDelay(caller, 'resetTimeout', resetTimeout, true);
	assertInteger(caller, 'halfOpenMaxCalls', halfOpenMaxCalls, 1);
	if (isFailure !== undefined) assertFunction(caller, 'isFailure', isFailure);
	if (onStateChange !== undefined) assertFunction(caller, 'onStateChange', onStateChange);
	assertFunction(caller, 'now', now);

	let state: CircuitState = 'closed';
	// The handlers of the calls let through in the current generation, created by the first of them: the generation is their identity,
	// so a call settling in a later one is recognized at no cost, and calls allocate no closures.
	let current: Settlers | undefined;
	let consecutiveFailures = 0;
	let openedAt = 0;
	// Trial calls let through, and those that succeeded, in the current half-open period.
	let trials = 0;
	let passed = 0;
	let successes = 0;
	let failures = 0;
	let shortCircuited = 0;

	/**
	 * Reads the clock.
	 * @returns {number} The current time
	 * @throws {TypeError} when `now()` does not return a number
	 * @throws {RangeError} when `now()` returns `NaN` or an infinity
	 */
	function readClock(): number {
		const time = now();
		assertNumber(caller, 'now()', time, Number.isFinite(time), 'a finite number');
		return time;
	}

	/**
	 * Enters a state (again, for `open()` and `reset()`), starting a new generation, then reports a change of state.
	 * @param {CircuitState} next - The new state
	 * @returns {void}
	 */
	function enter(next: CircuitState): void {
		// The clock first: when it throws, nothing changes.
		if (next === 'open') openedAt = readClock();

		const previous = state;

		state = next;
		current = undefined;
		consecutiveFailures = 0;
		trials = 0;
		passed = 0;
		if (next !== previous) onStateChange?.(next, previous);
	}

	/**
	 * Turns an open circuit whose reset timeout has elapsed half-open.
	 * @returns {number} While the circuit is (still) open, how many milliseconds it stays open; otherwise meaningless
	 */
	function refresh(): number {
		if (state !== 'open') return 0;

		const time = readClock();

		// A clock that went back: no time has passed, but the wait never exceeds `resetTimeout`.
		openedAt = Math.min(openedAt, time);

		const wait = resetTimeout - (time - openedAt);

		if (wait > 0) return wait;
		enter('half-open');
		// In case `onStateChange` reopened it.
		return resetTimeout;
	}

	/**
	 * Records the outcome of a call.
	 * @param {Settlers} admitted - The handlers of the generation the call started in
	 * @param {boolean} failed - Whether it failed
	 * @returns {void}
	 */
	function settle(admitted: Settlers, failed: boolean): void {
		if (failed) failures++;
		else successes++;
		// A call from an earlier generation does not affect the state.
		if (admitted !== current) return;
		if (state === 'closed') {
			if (!failed) consecutiveFailures = 0;
			else if (++consecutiveFailures >= failureThreshold) enter('open');
		} else if (failed) {
			enter('open');
		} else if (++passed >= halfOpenMaxCalls) {
			enter('closed');
		}
	}

	/**
	 * Creates the handlers of the calls let through in a new generation.
	 * @returns {Settlers} The handlers
	 */
	function settlers(): Settlers {
		const own: Settlers = {
			value: function (value: unknown): unknown {
				settle(own, false);
				return value;
			},
			error: function (error: unknown): never {
				let failed: boolean;

				try {
					failed = isFailure === undefined || Boolean(isFailure(error));
				} catch (filterError) {
					settle(own, true);
					throw filterError;
				}
				settle(own, failed);
				throw error;
			}
		};

		return own;
	}

	/**
	 * The guarded function.
	 * @param {...unknown} args - The call arguments
	 * @returns {Promise<unknown>} Settles like the operation, or rejects with a `CircuitOpenError`
	 */
	function breaker(this: unknown, ...args: unknown[]): Promise<unknown> {
		let wait: number;

		try {
			wait = refresh();
		} catch (error) {
			return Promise.reject(error);
		}
		if (state === 'half-open' && trials < halfOpenMaxCalls) trials++;
		else if (state !== 'closed') {
			shortCircuited++;
			return Promise.reject(
				state === 'half-open'
					? new CircuitOpenError(`${caller}: the circuit is half-open and its trial calls are in flight`, 0)
					: new CircuitOpenError(`${caller}: the circuit is open, ${wait === Infinity ? 'until reset()' : `retry in ${wait} ms`}`, wait)
			);
		}

		const handlers = (current ??= settlers());

		return invoke(fn, this, args).then(handlers.value, handlers.error);
	}

	defineProperties(breaker, {
		state: {
			get: function (): CircuitState {
				refresh();
				return state;
			}
		},
		stats: {
			get: function (): CircuitBreakerStats {
				refresh();

				const stats = Object.create(null) as { -readonly [K in keyof CircuitBreakerStats]: CircuitBreakerStats[K] };

				stats.state = state;
				stats.consecutiveFailures = consecutiveFailures;
				stats.successes = successes;
				stats.failures = failures;
				stats.shortCircuited = shortCircuited;
				return stats;
			}
		},
		open: {
			value: function open(): void {
				enter('open');
			}
		},
		reset: {
			value: function reset(): void {
				enter('closed');
			}
		}
	});

	return breaker as unknown as CircuitBreaker<F>;
}

/**
 * How {@link backoff} randomizes its delays (see the AWS Architecture Blog, "Exponential Backoff And Jitter", Marc Brooker, 2015), where
 * `exp(n)` is `min(maxDelay, delay × factor^n)`:
 * - `'none'`: `exp(n)`, deterministic.
 * - `'full'`: uniform in `[0, exp(n))`: the fewest collisions between competing clients, the least total waiting.
 * - `'equal'`: `exp(n) / 2` plus uniform in `[0, exp(n) / 2)`: never less than half the exponential delay.
 * - `'decorrelated'`: `min(maxDelay, uniform in [delay, previous × factor))`, starting from `previous = delay` (the article multiplies by
 *   `3`: pass `factor: 3` for its exact formula).
 */
export type BackoffJitter = 'none' | 'full' | 'equal' | 'decorrelated';

/**
 * Options accepted by {@link backoff}.
 */
export interface BackoffOptions {
	/** The first (base) delay in ms (`0` to `2^31 - 1`). Defaults to `100`. */
	delay?: number;
	/** Growth factor between consecutive delays (a finite number >= 1). Defaults to `2`. */
	factor?: number;
	/** Upper bound of every delay in ms (`0` to `2^31 - 1`, so each delay can be passed to `setTimeout` or {@link sleep}). Defaults to `30_000`. */
	maxDelay?: number;
	/** The randomization (see {@link BackoffJitter}). Defaults to `'none'`. */
	jitter?: BackoffJitter;
	/** Number of delays (an integer >= 0, or `Infinity`, the default: the sequence never ends). */
	retries?: number;
	/** Random source used for jitter (defaults to `Math.random`): inject a seeded generator for reproducible delays. */
	random?: RandomGenerator;
}

/**
 * Creates the sequence of delays (in ms) of an exponential backoff, for retry loops written by hand (or for a `retry` policy of your
 * own): `delay`, `delay × factor`, `delay × factor²`… capped at `maxDelay`, optionally randomized (see {@link BackoffJitter}), and
 * `retries` long (endless by default).
 *
 * The result is an iterable that starts over each time it is iterated, so one policy can serve many loops. Every delay is a finite
 * number between `0` and `maxDelay`, never `NaN`: growth is by repeated multiplication clamped to `maxDelay` at each step, so it is monotonic
 * (without jitter) and cannot overflow, however many delays are drawn. `random` is called once per delay (never for `'none'`).
 * @param {BackoffOptions} [options] - `delay` (100), `factor` (2), `maxDelay` (30 000), `jitter` (`'none'`), `retries` (Infinity) and `random` (`Math.random`)
 * @returns {Iterable<number>} The delays, an iterable that can be iterated any number of times
 * @throws {TypeError} when a numeric option is not a number, `jitter` is not a string, or (with jitter) `random` is not a function
 * @throws {RangeError} when `delay` or `maxDelay` is not a number between `0` and `2^31 - 1`, `factor` is not a finite number >= 1,
 * `retries` is not an integer >= 0 or `Infinity`, `jitter` is not one of the {@link BackoffJitter} names, or (while iterating)
 * `random()` returns a value outside [0, 1)
 * @example
 * [...backoff({ retries: 5 })]; // => [100, 200, 400, 800, 1600]
 * [...backoff({ delay: 1000, factor: 3, maxDelay: 5000, retries: 4 })]; // => [1000, 3000, 5000, 5000]
 * [...backoff({ retries: 3, jitter: 'full', random: function () { return 0.5; } })]; // => [50, 100, 200]
 * @example
 * async function fetchWithRetries(url: string): Promise<Response> {
 *   for (const delay of backoff({ retries: 4, jitter: 'full' })) {
 *     const response = await fetch(url);
 *     if (response.status !== 503) return response;
 *     await sleep(delay);
 *   }
 *   return fetch(url); // the last attempt
 * }
 */
export function backoff(options: BackoffOptions = {}): Iterable<number> {
	const initial = readOption(options, 'delay', 100);
	const factor = readOption(options, 'factor', 2);
	const max = readOption(options, 'maxDelay', 30_000);
	const jitter = readOption(options, 'jitter', 'none');
	const retries = readOption(options, 'retries', Infinity);
	const random = readOption(options, 'random', Math.random);

	assertDelay('backoff', 'delay', initial);
	assertNumber('backoff', 'factor', factor, factor >= 1 && factor < Infinity, 'a finite number >= 1');
	assertDelay('backoff', 'maxDelay', max);
	if (jitter !== 'none' && jitter !== 'full' && jitter !== 'equal' && jitter !== 'decorrelated') {
		const message = `backoff: \`jitter\` must be 'none', 'full', 'equal' or 'decorrelated', got ${show(jitter)}`;
		throw typeof jitter === 'string' ? new RangeError(message) : new TypeError(message);
	}
	assertInteger('backoff', 'retries', retries, 0, true);
	if (jitter !== 'none') assertFunction('backoff', 'random', random);

	return new BackoffPolicy(initial, factor, max, jitter, retries, random);
}

/**
 * The iterable returned by {@link backoff}, holding its validated options. A class rather than an object literal: an object with a
 * computed `[Symbol.iterator]` key is several times slower to create.
 */
class BackoffPolicy implements Iterable<number> {
	readonly initial: number;
	readonly factor: number;
	readonly max: number;
	readonly jitter: BackoffJitter;
	readonly retries: number;
	readonly random: RandomGenerator;

	/**
	 * Creates a policy.
	 * @param {number} initial - The first delay
	 * @param {number} factor - The growth factor
	 * @param {number} max - The largest delay
	 * @param {BackoffJitter} jitter - The randomization
	 * @param {number} retries - The number of delays
	 * @param {RandomGenerator} random - The random source
	 */
	constructor(initial: number, factor: number, max: number, jitter: BackoffJitter, retries: number, random: RandomGenerator) {
		this.initial = initial;
		this.factor = factor;
		this.max = max;
		this.jitter = jitter;
		this.retries = retries;
		this.random = random;
	}

	/**
	 * Starts the sequence over.
	 * @returns {IterableIterator<number>} An iterator of the delays, from the first one
	 */
	[Symbol.iterator](): IterableIterator<number> {
		return new BackoffIterator(this);
	}
}

/**
 * An iterator over the delays of a {@link BackoffPolicy}.
 */
class BackoffIterator implements IterableIterator<number> {
	readonly policy: BackoffPolicy;
	/** Delays produced so far. */
	count: number;
	/** `min(max, initial × factor^count)`. */
	exponential: number;
	/** The previous delay of the decorrelated jitter. */
	previous: number;

	/**
	 * Creates an iterator at the first delay.
	 * @param {BackoffPolicy} policy - The options
	 */
	constructor(policy: BackoffPolicy) {
		this.policy = policy;
		this.count = 0;
		this.exponential = Math.min(policy.initial, policy.max);
		this.previous = policy.initial;
	}

	/**
	 * Produces the next delay.
	 * @returns {IteratorResult<number>} The delay, or the end after `retries` delays
	 */
	next(): IteratorResult<number> {
		const { initial, factor, max, jitter, random } = this.policy;
		const exponential = this.exponential;

		if (this.count >= this.policy.retries) return { value: undefined, done: true };

		let delay = exponential;

		if (jitter === 'full') {
			delay = draw('backoff', random) * exponential;
		} else if (jitter === 'equal') {
			// Rather than `exponential / 2 + uniform(0, exponential / 2)`: the same, but rounding can never take it past `exponential`.
			delay = (exponential + draw('backoff', random) * exponential) / 2;
		} else if (jitter === 'decorrelated') {
			// `previous × factor` may overflow: `Number.MAX_VALUE` keeps the uniform draw finite (the cap then applies anyway).
			delay = this.previous = Math.min(max, initial + draw('backoff', random) * (Math.min(this.previous * factor, Number.MAX_VALUE) - initial));
		}
		this.count++;
		// Clamped at every step: the product never exceeds `max × factor`, which is finite for any `factor` (or `Infinity`, clamped).
		this.exponential = Math.min(exponential * factor, max);
		return { value: delay, done: false };
	}

	/**
	 * Iterators are iterable.
	 * @returns {this} This iterator
	 */
	[Symbol.iterator](): this {
		return this;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// fromEvent / interval / createStopwatch
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What {@link fromEvent} does with an event that arrives when `bufferSize` events are already waiting to be read:
 * - `'throw'` (the default): the iteration fails with a `RangeError`, after the waiting events have been read;
 * - `'drop-oldest'`: the oldest waiting event is discarded (the buffer keeps the latest ones);
 * - `'drop-newest'`: the new event is discarded.
 */
export type FromEventOverflow = 'throw' | 'drop-oldest' | 'drop-newest';

/**
 * Options accepted by {@link fromEvent}.
 * @template T - The event (or first listener argument) type
 */
export interface FromEventOptions<T> {
	/** Ends the iteration: the next read rejects with the signal's `reason` (or an {@link AbortError}), and unread events are discarded. */
	signal?: AbortSignalLike | null;
	/** Only events for which this returns a truthy value are yielded. If it throws, the iteration fails with that error. */
	filter?(event: T): boolean;
	/** Event types that make the iteration fail with their event (or first listener argument), such as `['error']`. Defaults to none. */
	rejectOn?: ReadonlyArray<string | symbol>;
	/**
	 * Largest number of events kept while nobody reads them (an integer >= 0, or `Infinity`, the default). Bound it for sources that may
	 * emit faster than they are consumed: an unbounded buffer grows until the process runs out of memory.
	 */
	bufferSize?: number;
	/** What happens to an event that does not fit in the buffer (see {@link FromEventOverflow}). Defaults to `'throw'`. */
	overflow?: FromEventOverflow;
}

/**
 * An event buffered by {@link fromEvent}.
 */
interface QueuedEvent {
	readonly value: unknown;
	next: QueuedEvent | undefined;
}

/**
 * Turns the `type` events of a DOM `EventTarget` (yielding the `Event`s) or of a Node-style emitter (yielding the first argument the
 * listeners receive) into an async iterator, for `for await` loops, like Node's `events.on` but for any target, with:
 * - **Buffering:** listening starts at once, and events that arrive while the consumer is not reading are kept, in order, up to
 *   `bufferSize` (unbounded by default: see `overflow` for what happens beyond). Several pending `next()` calls get events in order.
 * - **Errors:** `rejectOn: ['error']` makes the iteration fail with the first `error` event instead of hanging; a throwing `filter` and an
 *   `overflow: 'throw'` fail it too. The events received before the failure are read first, then the next read rejects with it.
 * - **Cancellation:** aborting `signal` ends the iteration at once: the next read rejects with the signal's `reason` (unread events are
 *   discarded), and later reads report the end. An already-aborted signal adds no listener.
 * - **Cleanup:** the listeners (on `target` and `signal`) are removed as soon as the iteration ends: on `return()` (a `break`, a `return` or
 *   an exception out of a `for await` loop), on a failure, or on abort. Pending reads then report the end (or the error, for the first).
 *   An iterator that is neither read to its end nor closed keeps its listeners: close it with `return()` when abandoning it by hand.
 *
 * Listeners are added like {@link waitForEvent} adds them, and never with `once`.
 * @template E - The event type for an `EventTarget` (defaults to the platform's `Event`)
 * @param {EventTargetLike} target - The event target
 * @param {string} type - The event type to listen to
 * @param {FromEventOptions<E>} [options] - `signal`, `filter`, `rejectOn`, `bufferSize` and `overflow`
 * @returns {AsyncIterableIterator<E>} An async iterator of the accepted events (it never ends by itself)
 * @throws {TypeError} when `target` has no supported listener methods, `type` or an entry of `rejectOn` is neither a string nor a symbol,
 *   `filter` is not a function, `rejectOn` is not an array, `bufferSize` is not a number, `overflow` is not a string, or `signal` is not a signal
 * @throws {RangeError} when `bufferSize` is not an integer >= 0 or `Infinity`, or `overflow` is not one of the {@link FromEventOverflow} names
 * @throws {unknown} the error thrown by `target` while adding a listener
 * @example
 * const target = new EventTarget();
 * const clicks = fromEvent(target, 'click');
 * target.dispatchEvent(new Event('click')); // buffered until read
 * target.dispatchEvent(new Event('click'));
 * let count = 0;
 * for await (const event of clicks) {
 *   event.type; // => 'click'
 *   if (++count === 2) break; // removes the listener
 * }
 * @example
 * import { EventEmitter } from 'node:events';
 * const socket = new EventEmitter();
 * const messages: string[] = [];
 * setTimeout(function () { socket.emit('message', 'a'); socket.emit('message', 'b'); socket.emit('error', new Error('reset')); }, 10);
 * try {
 *   for await (const message of fromEvent<string>(socket, 'message', { rejectOn: ['error'] })) messages.push(message);
 * } catch (error) {
 *   (error as Error).message; // => 'reset'
 * }
 * messages; // => ['a', 'b']
 * socket.listenerCount('message') + socket.listenerCount('error'); // => 0
 */
export function fromEvent<E = PlatformEvent>(target: EventTargetLike, type: string, options?: FromEventOptions<E>): AsyncIterableIterator<E>;
/**
 * Turns the `type` events of a Node-style emitter into an async iterator (see the first overload).
 * @template T - The type of the first listener argument
 * @param {EventEmitterLike} target - The emitter
 * @param {string | symbol} type - The event type to listen to
 * @param {FromEventOptions<T>} [options] - `signal`, `filter`, `rejectOn`, `bufferSize` and `overflow`
 * @returns {AsyncIterableIterator<T>} An async iterator of the first arguments of the accepted events
 * @example
 * import { createEmitter } from 'tinkit/emitter';
 * const events = createEmitter<{ saved: { id: number } }>();
 * const saves = fromEvent<{ id: number }>(events, 'saved', { bufferSize: 100, overflow: 'drop-oldest' });
 * events.emit('saved', { id: 7 });
 * await saves.next(); // => { value: { id: 7 }, done: false }
 * await saves.return?.(); // => { value: undefined, done: true }
 */
export function fromEvent<T = unknown>(target: EventEmitterLike, type: string | symbol, options?: FromEventOptions<T>): AsyncIterableIterator<T>;
/**
 * Turns the `type` events of `target` into an async iterator (see the first overload).
 * @param {EventTargetLike | EventEmitterLike} target - The event target or emitter
 * @param {string | symbol} type - The event type to listen to
 * @param {FromEventOptions<unknown>} [options] - `signal`, `filter`, `rejectOn`, `bufferSize` and `overflow`
 * @returns {AsyncIterableIterator<unknown>} An async iterator of the accepted events
 */
export function fromEvent(target: EventTargetLike | EventEmitterLike, type: string | symbol, options: FromEventOptions<unknown> = {}): AsyncIterableIterator<unknown> {
	const signal = readOption(options, 'signal');
	const filter = readOption(options, 'filter');
	const rejectOn = readOption(options, 'rejectOn', []);
	const bufferSize = readOption(options, 'bufferSize', Infinity);
	const overflow = readOption(options, 'overflow', 'throw');
	const [add, remove] = listenerMethods('fromEvent', target, type);

	if (filter !== undefined) assertFunction('fromEvent', 'filter', filter);
	assertRejectOn('fromEvent', rejectOn);
	assertInteger('fromEvent', 'bufferSize', bufferSize, 0, true);
	if (overflow !== 'throw' && overflow !== 'drop-oldest' && overflow !== 'drop-newest') {
		const message = `fromEvent: \`overflow\` must be 'throw', 'drop-oldest' or 'drop-newest', got ${show(overflow)}`;
		throw typeof overflow === 'string' ? new RangeError(message) : new TypeError(message);
	}
	assertOptionalSignal('fromEvent', 'signal', signal);

	// The unread events, as a linked FIFO queue (O(1) at both ends, nothing to compact).
	let first: QueuedEvent | undefined;
	let last: QueuedEvent | undefined;
	let buffered = 0;
	// The reads waiting for an event.
	const reads: Array<Deferred<IteratorResult<unknown>>> = [];
	// Whether the listeners are gone (no event is accepted any more), and the error the iteration fails with once the buffer is read.
	let closed = false;
	let failure: { error: unknown } | undefined;
	const added: Array<[unknown, (event: unknown) => void]> = [];

	/**
	 * Removes every listener.
	 * @returns {void}
	 */
	function close(): void {
		closed = true;
		removeListeners(target, remove, added);
		unwatchSignal(signal, onAbort);
	}

	/**
	 * Ends the waiting reads: the first one rejects with `error` (when given), the others report the end.
	 * @param {{ error: unknown } | undefined} error - The error, if any
	 * @returns {{ error: unknown } | undefined} `error` when no read was waiting for it (it is then thrown by the next read)
	 */
	function endReads(error: { error: unknown } | undefined): { error: unknown } | undefined {
		for (const read of reads.splice(0)) {
			if (error === undefined) {
				read.resolve({ value: undefined, done: true });
			} else {
				read.reject(error.error);
				error = undefined;
			}
		}
		return error;
	}

	/**
	 * Ends the iteration with an error, thrown once the buffered events have been read.
	 * @param {unknown} error - The error
	 * @returns {void}
	 */
	function fail(error: unknown): void {
		if (closed) return;
		close();
		failure = endReads({ error });
	}

	/**
	 * Abort listener: ends the iteration at once.
	 * @param {unknown} reason - The abort reason
	 * @returns {void}
	 */
	function onAbort(reason: unknown): void {
		discard();
		fail(reason);
	}

	/**
	 * Discards the buffered events.
	 * @returns {void}
	 */
	function discard(): void {
		first = undefined;
		last = undefined;
		buffered = 0;
	}

	/**
	 * Removes the oldest buffered event.
	 * @returns {unknown} The event
	 */
	function shift(): unknown {
		const node = first as QueuedEvent;

		first = node.next;
		// Not to keep the event alive through `last`.
		if (first === undefined) last = undefined;
		buffered--;
		return node.value;
	}

	/**
	 * Listener of `type`: hands an accepted event to the first waiting read, or buffers it.
	 * @param {unknown} event - The event, or the first listener argument
	 * @returns {void}
	 */
	function onEvent(event: unknown): void {
		// An emitter may still call a listener it is removing.
		if (closed) return;
		try {
			// A filter may also have ended the iteration (by closing it, or making the target emit a `rejectOn` event).
			if (filter !== undefined && (!filter(event) || closed)) return;
		} catch (error) {
			fail(error);
			return;
		}

		const read = reads.shift();

		if (read !== undefined) {
			read.resolve({ value: event, done: false });
		} else if (buffered < bufferSize || overflow === 'drop-oldest') {
			const node: QueuedEvent = { value: event, next: undefined };

			if (first === undefined) first = node;
			else (last as QueuedEvent).next = node;
			last = node;
			// Over the limit only with `drop-oldest`, which then drops the oldest one (the new one itself, for a `bufferSize` of 0).
			if (++buffered > bufferSize) shift();
		} else if (overflow === 'throw') {
			fail(new RangeError(`fromEvent: more than ${bufferSize} events are waiting to be read (\`bufferSize\` is ${bufferSize})`));
		}
	}

	const iterator: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (first !== undefined) return Promise.resolve({ value: shift(), done: false });
			if (failure !== undefined) {
				const { error } = failure;

				failure = undefined;
				return Promise.reject(error);
			}
			if (closed) return Promise.resolve({ value: undefined, done: true });

			const read = createDeferred<IteratorResult<unknown>>();

			reads.push(read);
			return read.promise;
		},
		return(): Promise<IteratorResult<unknown>> {
			// Idempotent: the listeners are only removed once.
			close();
			discard();
			failure = undefined;
			endReads(undefined);
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
			return iterator;
		}
	};

	if (signal?.aborted) {
		closed = true;
		failure = { error: abortReason(signal) };
		return iterator;
	}
	// The abort listener first: when adding it throws, nothing else is left behind.
	watchSignal(signal, onAbort);
	try {
		addListeners(target, add, added, type, onEvent, rejectOn, fail, function () {
			return closed;
		});
	} catch (error) {
		removeListeners(target, remove, added);
		unwatchSignal(signal, onAbort);
		throw error;
	}
	// A listener called while being added has ended the iteration (and removed the listeners added before it).
	if (closed) removeListeners(target, remove, added);

	return iterator;
}

/**
 * Reads a monotonic clock in milliseconds: `performance.now()` where available, `Date.now()` otherwise.
 * @returns {number} The current time
 */
function monotonicNow(): number {
	const clock = (globalThis as { performance?: { now?: () => number } }).performance;

	return typeof clock?.now === 'function' ? clock.now() : Date.now();
}

/**
 * Options accepted by {@link interval}.
 */
export interface IntervalOptions {
	/** Aborting it stops the interval, like calling the returned function. An already-aborted signal starts nothing. */
	signal?: AbortSignalLike | null;
	/** When `true`, the callback is also called at once (synchronously) with tick `0`. Defaults to `false`. */
	immediate?: boolean;
}

/**
 * Calls `callback` every `ms` milliseconds, without drift: tick `n` is scheduled at `start + n × ms` (on a monotonic clock), not `ms`
 * after the previous one, so late timers do not add up as they do with `setInterval` or a chain of `setTimeout`s. The callback receives
 * the tick number `n`.
 * - **Missed ticks are skipped, not bursted:** when a timer fires late (the event loop was blocked), the ticks whose time has passed are
 *   not made up for: the callback runs once, with the number of the latest due tick, and then on schedule again. The ticks that come due
 *   while the callback itself runs (longer than `ms`) are skipped too: the next run is the first tick not yet past when it returns. Gaps in
 *   the tick numbers show how many were skipped.
 * - **No overlap:** when the callback returns a promise, the next tick waits for it to settle, and the ticks due meanwhile are skipped.
 * - **Errors:** an error thrown or rejected by the callback stops the interval, and is not caught: it surfaces as an unhandled rejection
 *   (catch inside the callback to keep going).
 * - **No leaks:** at most one timer exists at a time, none while an async callback runs, and none once stopped, so a stopped interval
 *   never keeps a process alive. Stopping is idempotent, and works from within the callback.
 * @param {(tick: number) => unknown} callback - Called with the tick number (`1`, `2`…, or `0` first with `immediate`)
 * @param {number} ms - The period in milliseconds (`1` to `2^31 - 1`)
 * @param {IntervalOptions} [options] - `signal` and `immediate` (default `false`)
 * @returns {() => void} Stops the interval
 * @throws {TypeError} when `callback` is not a function, `ms` is not a number, or `signal` is not a signal
 * @throws {RangeError} when `ms` is not a number between `1` and `2^31 - 1`
 * @example
 * const ticks: number[] = [];
 * const stop = interval(function (tick) { ticks.push(tick); }, 25, { immediate: true });
 * await sleep(90); // ticks at 0, 25, 50 and 75 ms
 * stop();
 * ticks; // => [0, 1, 2, 3]
 * @example
 * // doctest: skip
 * const controller = new AbortController();
 * interval(async function () { await refreshDashboard(); }, 60_000, { signal: controller.signal }); // refreshes never overlap
 */
export function interval(callback: (tick: number) => unknown, ms: number, options: IntervalOptions = {}): () => void {
	const signal = readOption(options, 'signal');
	const immediate = readOption(options, 'immediate', false);

	assertFunction('interval', 'callback', callback);
	assertNumber('interval', 'ms', ms, ms >= 1 && ms <= MAX_TIMEOUT, `a number between 1 and ${MAX_TIMEOUT}`);
	assertOptionalSignal('interval', 'signal', signal);

	const start = monotonicNow();
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The number of the next tick to run.
	let next = 1;

	/**
	 * Stops the interval (idempotent).
	 * @returns {void}
	 */
	function stop(): void {
		stopped = true;
		clearTimeout(timer);
		timer = undefined;
		unwatchSignal(signal, stop);
	}

	/**
	 * Arms the timer for the first tick due now or later (a tick due while the callback ran is skipped).
	 * @returns {void}
	 */
	function schedule(): void {
		if (stopped) return;

		const time = monotonicNow();

		next = Math.max(next, Math.ceil((time - start) / ms));
		// At most `ms`: with a clock that went back, the wait would otherwise grow by as much.
		timer = setTimeout(fire, Math.min(start + next * ms - time, ms));
	}

	/**
	 * Runs one tick, then schedules the next one once the callback has settled.
	 * @param {number} tick - The tick number
	 * @returns {void}
	 */
	function run(tick: number): void {
		next = tick + 1;
		invoke(callback, undefined, [tick]).then(schedule, function (error: unknown) {
			stop();
			throw error;
		});
	}

	/**
	 * Timer callback: runs the latest due tick (a timer may fire a little early, never with an earlier number than scheduled).
	 * @returns {void}
	 */
	function fire(): void {
		timer = undefined;
		run(Math.max(next, Math.floor((monotonicNow() - start) / ms)));
	}

	if (signal?.aborted) return stop;
	// The listener first: when adding it throws, no timer is left behind, and when the signal calls it while it is being added, nothing
	// starts. `stop` removes it.
	watchSignal(signal, stop);
	if (stopped) return stop;
	if (immediate) run(0);
	else schedule();

	return stop;
}

/**
 * Options accepted by {@link createStopwatch}.
 */
export interface StopwatchOptions {
	/**
	 * Clock in milliseconds. Defaults to `performance.now()` (monotonic, sub-millisecond), or `Date.now()` where `performance` is missing.
	 * It must return a finite number (or the operation reading it throws); a clock going back counts as no time passing. It is called
	 * without a receiver: pass `performance.now.bind(performance)` rather than `performance.now`.
	 */
	now?(): number;
}

/**
 * A stopwatch as returned by {@link createStopwatch}. Its methods do not depend on `this`.
 */
export interface Stopwatch {
	/** Starts (or resumes) measuring; does nothing when already running. Returns the stopwatch. */
	start(): Stopwatch;
	/** Pauses measuring and returns the elapsed time; does nothing else when not running. */
	stop(): number;
	/** Stops and sets the elapsed time (and the lap) back to `0`. Returns the stopwatch, so `reset().start()` restarts it. */
	reset(): Stopwatch;
	/** Returns the time measured since the previous `lap()` (or since the first start), and starts a new lap. */
	lap(): number;
	/** The measured time in milliseconds, paused periods excluded; it grows while running. */
	readonly elapsed: number;
	/** Whether it is measuring. */
	readonly running: boolean;
}

/**
 * Creates a stopwatch measuring elapsed time in milliseconds on a monotonic clock (`performance.now()` by default, so changes of the
 * system time do not affect it), with pause and resume (`stop()` / `start()`), laps and an injectable clock for tests. The measured
 * time never decreases (an injected clock that goes back counts as no time passing), so laps are never negative.
 * @param {StopwatchOptions} [options] - `now`, the clock
 * @returns {Stopwatch} A stopped stopwatch at `0`
 * @throws {TypeError} when `now` is not a function
 * @example
 * let clock = 0;
 * const watch = createStopwatch({ now: function () { return clock; } }).start();
 * clock = 150;
 * watch.elapsed; // => 150 // live while running
 * watch.lap(); // => 150
 * clock = 200;
 * watch.stop(); // => 200
 * clock = 1000; // paused: not counted
 * watch.start();
 * clock = 1100;
 * watch.lap(); // => 150 // since the previous lap
 * watch.elapsed; // => 300
 * watch.reset().elapsed; // => 0
 * @example
 * const watch = createStopwatch().start();
 * await sleep(20);
 * watch.stop() >= 19; // => true
 */
export function createStopwatch(options: StopwatchOptions = {}): Stopwatch {
	const now = readOption(options, 'now', monotonicNow);

	assertFunction('createStopwatch', 'now', now);

	// The measured time, the clock when it was last added to, and the measured time at the last lap.
	let accumulated = 0;
	let last = 0;
	let lapped = 0;
	let running = false;

	/**
	 * Reads the clock.
	 * @returns {number} The current time
	 * @throws {TypeError} when `now()` does not return a number
	 * @throws {RangeError} when `now()` returns `NaN` or an infinity
	 */
	function readClock(): number {
		const time = now();
		assertNumber('createStopwatch', 'now()', time, Number.isFinite(time), 'a finite number');
		return time;
	}

	/**
	 * Adds the time passed since the last reading, if running.
	 * @returns {number} The elapsed milliseconds
	 */
	function elapsed(): number {
		if (running) {
			const time = readClock();

			accumulated += Math.max(time - last, 0);
			last = time;
		}
		return accumulated;
	}

	const stopwatch: Stopwatch = {
		start(): Stopwatch {
			if (!running) {
				last = readClock();
				running = true;
			}
			return stopwatch;
		},
		stop(): number {
			accumulated = elapsed();
			running = false;
			return accumulated;
		},
		reset(): Stopwatch {
			accumulated = 0;
			lapped = 0;
			running = false;
			return stopwatch;
		},
		lap(): number {
			const total = elapsed();
			const split = total - lapped;

			lapped = total;
			return split;
		},
		get elapsed(): number {
			return elapsed();
		},
		get running(): boolean {
			return running;
		}
	};

	return stopwatch;
}
