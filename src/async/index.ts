import { debounce, noop, type Result } from '../functions/index.js';
import { assertDelay, assertFunction, assertInteger, assertNumber, describe, draw, MAX_TIMEOUT } from '../utils/assert.js';
import type { AbortSignalLike, RandomGenerator } from '../utils/index.js';

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
		assertDelay('withTimeout', 'ms', ms);

		const timer = setTimeout(function () {
			reject(new TimeoutError(message ?? `Operation timed out after ${ms} ms`));
		}, ms);

		Promise.resolve(promise).then(
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

			const base = Math.min(delay * factor ** (attempt - 1), maxDelay, MAX_TIMEOUT);
			const wait = jitter ? draw('retry', random) * base : base;

			// Always yield to the event loop, even for a zero delay: a synchronously throwing `fn` with `retries: Infinity` would otherwise
			// spin forever without ever returning control, and an abort fired by a timer or by I/O could never be observed.
			await sleep(wait, { signal });
		}
	}
}

/**
 * Maps `items` with an async `mapper`, running at most `concurrency` mappers at the same time, and resolves with the results in input
 * order. Rejects with the first error; once an error occurred no new items are started (mappers already running are not cancelled).
 * @template T - The item type
 * @template R - The mapped value type
 * @param {Iterable<T>} items - The items to map (consumed eagerly)
 * @param {(item: T, index: number) => Promise<R> | R} mapper - The (possibly async) mapping function
 * @param {number} [concurrency=Infinity] - Maximum number of mappers in flight (an integer >= 1, or `Infinity`)
 * @returns {Promise<R[]>} The mapped values, in input order
 * @throws {TypeError} (as a rejection) when `mapper` is not a function, or `concurrency` is not a number
 * @throws {RangeError} (as a rejection) when `concurrency` is not an integer >= 1 or `Infinity`
 * @throws {unknown} (as a rejection) the first error thrown or rejected by `mapper`
 * @example
 * async function size(name: string): Promise<number> { await sleep(5); return name.length; }
 * await mapWithConcurrency(['a', 'bb', 'ccc'], size, 2); // => [1, 2, 3] // in input order, at most 2 running at once
 */
export async function mapWithConcurrency<T, R>(items: Iterable<T>, mapper: (item: T, index: number) => Promise<R> | R, concurrency = Infinity): Promise<R[]> {
	assertInteger('mapWithConcurrency', 'concurrency', concurrency, 1, true);
	assertFunction('mapWithConcurrency', 'mapper', mapper);

	const list = Array.from(items);

	// Every item can start at once: map them directly instead of running one worker per item (same behaviour, much cheaper).
	if (concurrency >= list.length) {
		const started: Array<Promise<R> | R> = [];

		for (let index = 0; index < list.length; index++) {
			try {
				started.push(mapper(list[index], index));
			} catch (error) {
				// The items already started keep running, as with workers; their outcome is ignored (and rejections are handled).
				Promise.all(started).catch(noop);
				throw error;
			}
		}

		return Promise.all(started);
	}

	const results: R[] = [];
	let next = 0;
	let failed = false;

	/**
	 * Repeatedly takes the next unprocessed item until none is left or a mapper failed.
	 * @returns {Promise<void>} Resolves when this worker is done
	 */
	async function worker(): Promise<void> {
		while (!failed && next < list.length) {
			const index = next++;

			try {
				results[index] = await mapper(list[index], index);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));

	return results;
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

				let outcome: Promise<unknown>;

				try {
					outcome = Promise.resolve(fn(...args));
				} catch (error) {
					outcome = Promise.reject(error);
				}

				outcome.then(resolve, reject).then(function () {
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

			let outcome: Promise<Awaited<T>>;

			try {
				outcome = Promise.resolve(check()) as Promise<Awaited<T>>;
			} catch (error) {
				outcome = Promise.reject(error);
			}

			outcome.then(
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

	const controller = createAbortController('anySignal');
	const aborted = inputs.find(function (input) {
		return input.aborted;
	});

	if (aborted !== undefined) {
		controller.abort(abortReason(aborted));
	} else {
		const listeners = inputs.map(function (input) {
			return function onAbort(): void {
				inputs.forEach(function (other, i) {
					other.removeEventListener('abort', listeners[i]);
				});
				controller.abort(abortReason(input));
			};
		});
		inputs.forEach(function (input, i) {
			// The first abort removes every listener, so none runs twice.
			input.addEventListener('abort', listeners[i]);
		});
	}

	return controller.signal as PlatformAbortSignal;
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
		assertOptionalSignal('abortable', 'signal', signal);

		/**
		 * Abort listener: rejects with the abort reason.
		 * @returns {void}
		 */
		function onAbort(): void {
			reject(abortReason(signal as AbortSignalLike));
		}

		Promise.resolve(promise).then(
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
