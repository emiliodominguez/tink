import {
	AbortError,
	abortable,
	anySignal,
	attemptAsync,
	backoff,
	CircuitOpenError,
	createBatcher,
	createCircuitBreaker,
	createDeferred,
	createKeyedMutex,
	createLimiter,
	createMutex,
	createQueue,
	createRateLimiter,
	createSemaphore,
	createStopwatch,
	debounceAsync,
	filterWithConcurrency,
	fromEvent,
	interval,
	isAbortError,
	isTimeoutError,
	mapSettledWithConcurrency,
	mapWithConcurrency,
	memoizeAsync,
	minDelay,
	pollUntil,
	promiseAllObject,
	promiseAllSettledObject,
	reduceAsync,
	retry,
	sequence,
	sleep,
	throwIfAborted,
	TimeoutError,
	timeoutSignal,
	waitForEvent,
	withTimeout,
	type Deferred,
	type Release
} from '.';
import { EventEmitter, getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createEmitter } from '../emitter/index.js';
import { createLRUCache } from '../cache/index.js';
import type { AbortSignalLike } from '../utils/index.js';

/**
 * A promise state probe that does not depend on timers.
 */
async function stateOf(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
	const marker = {};
	try {
		const winner = await Promise.race([promise, Promise.resolve(marker)]);
		return winner === marker ? 'pending' : 'fulfilled';
	} catch {
		return 'rejected';
	}
}

/**
 * A fake abort signal that tracks its listeners, so tests can check that none leak. Dispatch follows EventTarget semantics:
 * listeners removed during dispatch are not called, and `once` listeners are removed before being called.
 */
class CountingSignal implements AbortSignalLike {
	aborted = false;
	reason: unknown = undefined;
	readonly listeners = new Map<() => void, { once: boolean }>();

	get listenerCount(): number {
		return this.listeners.size;
	}

	addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void {
		if (type === 'abort' && !this.listeners.has(listener)) this.listeners.set(listener, { once: options?.once ?? false });
	}

	removeEventListener(type: 'abort', listener: () => void): void {
		if (type === 'abort') this.listeners.delete(listener);
	}

	abort(reason?: unknown): void {
		if (this.aborted) return;
		this.aborted = true;
		this.reason = reason;
		for (const [listener, { once }] of Array.from(this.listeners)) {
			if (!this.listeners.has(listener)) continue;
			if (once) this.listeners.delete(listener);
			listener();
		}
	}
}

/**
 * Runs `fn` with `globalThis.AbortController` removed.
 */
function withoutAbortController(fn: () => void): void {
	const original = globalThis.AbortController;
	delete (globalThis as any).AbortController;
	try {
		fn();
	} finally {
		globalThis.AbortController = original;
	}
}

describe('Async helpers', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('AbortError / TimeoutError', function () {
		it('should be proper Error subclasses with names and default messages', function () {
			const abort = new AbortError();
			const timeout = new TimeoutError('late');
			expect(abort).toBeInstanceOf(Error);
			expect(abort).toBeInstanceOf(AbortError);
			expect(abort.name).toBe('AbortError');
			expect(abort.message).toBe('The operation was aborted.');
			expect(timeout).toBeInstanceOf(TimeoutError);
			expect(timeout.name).toBe('TimeoutError');
			expect(timeout.message).toBe('late');
			expect(new TimeoutError().message).toBe('The operation timed out.');
		});
	});

	describe('createDeferred', function () {
		it('should resolve from the outside', async function () {
			const deferred = createDeferred<number>();
			expect(await stateOf(deferred.promise)).toBe('pending');
			deferred.resolve(42);
			await expect(deferred.promise).resolves.toBe(42);
		});

		it('should reject from the outside and ignore later settlements', async function () {
			const deferred = createDeferred<number>();
			const error = new Error('nope');
			deferred.reject(error);
			deferred.resolve(1);
			await expect(deferred.promise).rejects.toBe(error);
		});

		it('should adopt thenables', async function () {
			const deferred = createDeferred<string>();
			deferred.resolve(Promise.resolve('inner'));
			await expect(deferred.promise).resolves.toBe('inner');
		});
	});

	describe('sleep', function () {
		it('should resolve after the delay', async function () {
			jest.useFakeTimers();

			const promise = sleep(100);
			await jest.advanceTimersByTimeAsync(99);
			expect(await stateOf(promise)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await expect(promise).resolves.toBeUndefined();
		});

		it('should resolve with real timers and a zero delay', async function () {
			await expect(sleep(0)).resolves.toBeUndefined();
		});

		it('should reject immediately with the reason of an already aborted signal', async function () {
			const controller = new AbortController();
			controller.abort(new Error('stop'));
			await expect(sleep(1000, { signal: controller.signal })).rejects.toThrow('stop');
		});

		it('should reject with the reason and clear the timer when aborted during the wait', async function () {
			jest.useFakeTimers();

			const controller = new AbortController();
			const promise = sleep(1000, { signal: controller.signal });
			expect(jest.getTimerCount()).toBe(1);
			controller.abort();
			await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should use an AbortError when the signal has no reason', async function () {
			let listener: (() => void) | undefined;
			const signal = {
				aborted: false,
				addEventListener: jest.fn(function (_type: 'abort', fn: () => void) {
					listener = fn;
				}),
				removeEventListener: jest.fn()
			};
			const promise = sleep(1000, { signal });
			signal.aborted = true;
			(listener as () => void)();
			await expect(promise).rejects.toBeInstanceOf(AbortError);

			const preAborted: AbortSignalLike = { aborted: true, addEventListener: jest.fn(), removeEventListener: jest.fn() };
			await expect(sleep(1, { signal: preAborted })).rejects.toBeInstanceOf(AbortError);
		});

		it('should not keep its abort listener after an abort', async function () {
			const signal = new CountingSignal();
			const promise = sleep(1000, { signal });
			expect(signal.listenerCount).toBe(1);
			signal.abort('stop');
			await expect(promise).rejects.toBe('stop');
			expect(signal.listenerCount).toBe(0);
		});

		it('should remove the abort listener once resolved', async function () {
			jest.useFakeTimers();

			const signal = { aborted: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
			const promise = sleep(10, { signal });
			await jest.advanceTimersByTimeAsync(10);
			await promise;
			expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
		});

		it.each([-1, NaN, Infinity, 2 ** 31])('should reject with a RangeError for ms = %p', async function (ms) {
			await expect(sleep(ms)).rejects.toThrow(new RangeError(`sleep: \`ms\` must be a number between 0 and 2147483647, got ${ms}`));
		});
	});

	describe('withTimeout', function () {
		it('should handle the rejection of the promise when `ms` is invalid', async function () {
			const unhandled = jest.fn();
			process.on('unhandledRejection', unhandled);
			try {
				await expect(withTimeout(Promise.reject(new Error('inner')), -1)).rejects.toThrow(RangeError);
				await new Promise(setImmediate);
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
		});

		it('should resolve with the value when the promise settles in time and clear the timer', async function () {
			jest.useFakeTimers();

			const deferred = createDeferred<string>();
			const promise = withTimeout(deferred.promise, 100);
			deferred.resolve('ok');
			await expect(promise).resolves.toBe('ok');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should forward rejections and clear the timer', async function () {
			jest.useFakeTimers();

			const error = new Error('fail');
			const promise = withTimeout(Promise.reject(error), 100);
			await expect(promise).rejects.toBe(error);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should reject with a TimeoutError when too slow', async function () {
			jest.useFakeTimers();

			const promise = withTimeout(new Promise(function () {}), 100);
			const assertion = expect(promise).rejects.toThrow(new TimeoutError('Operation timed out after 100 ms'));
			await jest.advanceTimersByTimeAsync(100);
			await assertion;
		});

		it('should use the custom message', async function () {
			jest.useFakeTimers();

			const promise = withTimeout(new Promise(function () {}), 5, 'too slow');
			const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError', message: 'too slow' });
			await jest.advanceTimersByTimeAsync(5);
			await assertion;
		});

		it('should accept the largest delay setTimeout supports, 2^31 - 1 ms', async function () {
			await expect(withTimeout(Promise.resolve('ok'), 2 ** 31 - 1)).resolves.toBe('ok');
		});

		it('should accept plain values', async function () {
			await expect(withTimeout(7, 10)).resolves.toBe(7);
		});

		it('should reject with a RangeError for invalid ms', async function () {
			await expect(withTimeout(Promise.resolve(1), -1)).rejects.toThrow(new RangeError('withTimeout: `ms` must be a number between 0 and 2147483647, got -1'));
		});
	});

	describe('retry', function () {
		it('accepts a function returning a thenable, and resolves with its value type', async function () {
			const thenable: PromiseLike<number> = {
				then(onFulfilled) {
					return Promise.resolve(42).then(onFulfilled);
				}
			};
			const result: number = await retry(function () {
				return thenable;
			});
			expect(result).toBe(42);
		});

		it('should keep a zero delay at zero when the backoff factor overflows', async function () {
			let attempts = 0;
			const result = await retry(
				function () {
					attempts++;
					if (attempts < 5) throw new Error('busy');
					return 'ok';
				},
				{ retries: 5, delay: 0, factor: 1e300 }
			);
			expect(result).toBe('ok');
			expect(attempts).toBe(5);
		});

		it('should validate the jitter random generator like the other modules do', async function () {
			const failing = jest.fn(function () {
				throw new Error('busy');
			});

			await expect(retry(failing, { retries: 1, jitter: true }, 'nope' as never)).rejects.toThrow(new TypeError('retry: `random` must be a function, got string'));
			await expect(
				retry(failing, { retries: 1, delay: 1, jitter: true }, function () {
					return 1;
				})
			).rejects.toThrow(new RangeError('retry: `random()` must return a number in [0, 1), got 1'));
			// Validated upfront, before any attempt (and only when jitter is on).
			expect(failing).toHaveBeenCalledTimes(1);
			await expect(retry(failing, { jitter: false }, 'unused' as never)).rejects.toThrow('busy');
		});

		it('should resolve on the first success without retrying', async function () {
			const fn = jest.fn(async function (attempt: number) {
				return attempt;
			});
			await expect(retry(fn)).resolves.toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should retry until success and pass the attempt number', async function () {
			const fn = jest.fn(function (attempt: number) {
				if (attempt < 3) throw new Error(`fail ${attempt}`);
				return 'done';
			});
			const onRetry = jest.fn();
			await expect(retry(fn, { onRetry })).resolves.toBe('done');
			expect(fn.mock.calls).toEqual([[1], [2], [3]]);
			expect(onRetry.mock.calls).toEqual([
				[new Error('fail 1'), 1],
				[new Error('fail 2'), 2]
			]);
		});

		it('should rethrow the last error once retries are exhausted', async function () {
			const fn = jest.fn(async function (attempt: number) {
				throw new Error(`fail ${attempt}`);
			});
			await expect(retry(fn, { retries: 2 })).rejects.toThrow('fail 3');
			expect(fn).toHaveBeenCalledTimes(3);
		});

		it('should not retry with retries = 0', async function () {
			const fn = jest.fn(async function () {
				throw new Error('x');
			});
			await expect(retry(fn, { retries: 0 })).rejects.toThrow('x');
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should stop when shouldRetry returns false', async function () {
			const fn = jest.fn(async function (attempt: number) {
				throw new Error(attempt === 1 ? 'retryable' : 'fatal');
			});
			const shouldRetry = jest.fn(function (error: unknown) {
				return (error as Error).message === 'retryable';
			});
			await expect(retry(fn, { retries: 10, shouldRetry })).rejects.toThrow('fatal');
			expect(fn).toHaveBeenCalledTimes(2);
			expect(shouldRetry).toHaveBeenLastCalledWith(new Error('fatal'), 2);
		});

		it('should wait with exponential backoff capped by maxDelay', async function () {
			jest.useFakeTimers();

			const times: number[] = [];
			const start = Date.now();
			const fn = jest.fn(async function (attempt: number) {
				times.push(Date.now() - start);
				if (attempt <= 4) throw new Error('again');
				return 'ok';
			});
			const promise = retry(fn, { retries: 4, delay: 100, factor: 2, maxDelay: 300 });
			await jest.advanceTimersByTimeAsync(10_000);
			await expect(promise).resolves.toBe('ok');
			expect(times).toEqual([0, 100, 300, 600, 900]);
		});

		it('should apply full jitter using the random source', async function () {
			jest.useFakeTimers();

			const times: number[] = [];
			const start = Date.now();
			const fn = jest.fn(async function (attempt: number) {
				times.push(Date.now() - start);
				if (attempt <= 2) throw new Error('again');
				return 'ok';
			});
			const promise = retry(fn, { delay: 100, jitter: true }, function () {
				return 0.5;
			});
			await jest.advanceTimersByTimeAsync(1000);
			await expect(promise).resolves.toBe('ok');
			expect(times).toEqual([0, 50, 150]);
		});

		it('should support infinite retries', async function () {
			const fn = jest.fn(function (attempt: number) {
				if (attempt < 20) throw new Error('again');
				return attempt;
			});
			await expect(retry(fn, { retries: Infinity })).resolves.toBe(20);
		});

		it('should reject with the abort reason when aborted before an attempt', async function () {
			const controller = new AbortController();
			controller.abort(new Error('cancelled'));
			const fn = jest.fn();
			await expect(retry(fn, { signal: controller.signal })).rejects.toThrow('cancelled');
			expect(fn).not.toHaveBeenCalled();
		});

		it('should reject with the abort reason when aborted during a delay', async function () {
			jest.useFakeTimers();

			const controller = new AbortController();
			const fn = jest.fn(async function () {
				throw new Error('fail');
			});
			const promise = retry(fn, { delay: 1000, signal: controller.signal });
			const assertion = expect(promise).rejects.toThrow('stop now');
			await jest.advanceTimersByTimeAsync(500);
			controller.abort(new Error('stop now'));
			await assertion;
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should not call shouldRetry/onRetry when aborted during a failing attempt (previously announced a retry)', async function () {
			const controller = new AbortController();
			const onRetry = jest.fn();
			const shouldRetry = jest.fn(function () {
				return true;
			});
			const fn = jest.fn(async function () {
				controller.abort(new Error('aborted mid-attempt'));
				throw new Error('fail');
			});
			await expect(retry(fn, { signal: controller.signal, onRetry, shouldRetry })).rejects.toThrow('aborted mid-attempt');
			expect(onRetry).not.toHaveBeenCalled();
			expect(shouldRetry).not.toHaveBeenCalled();
		});

		it('should reject with an AbortError when aborted between attempts without a reason', async function () {
			const signal = { aborted: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
			const fn = jest.fn(async function () {
				signal.aborted = true;
				throw new Error('fail');
			});
			await expect(retry(fn, { signal })).rejects.toBeInstanceOf(AbortError);
		});

		it.each([
			[{ retries: -1 }, '`retries` must be an integer >= 0 or Infinity, got -1'],
			[{ retries: 1.5 }, '`retries` must be an integer >= 0 or Infinity, got 1.5'],
			[{ retries: NaN }, '`retries` must be an integer >= 0 or Infinity, got NaN'],
			[{ delay: -1 }, '`delay` must be a finite number >= 0, got -1'],
			[{ delay: Infinity }, '`delay` must be a finite number >= 0, got Infinity'],
			[{ factor: 0 }, '`factor` must be a finite number > 0, got 0'],
			[{ factor: Infinity }, '`factor` must be a finite number > 0, got Infinity'],
			[{ factor: NaN }, '`factor` must be a finite number > 0, got NaN'],
			[{ maxDelay: -1 }, '`maxDelay` must be a number >= 0, got -1'],
			[{ maxDelay: NaN }, '`maxDelay` must be a number >= 0, got NaN']
		])('should reject with a RangeError for %p', async function (options, message) {
			await expect(retry(jest.fn(), options)).rejects.toThrow(new RangeError(`retry: ${message}`));
		});

		it('should accept maxDelay = 0 and still yield to the event loop between attempts', async function () {
			jest.useFakeTimers();

			let calls = 0;
			const fn = jest.fn(async function () {
				calls++;
				if (calls < 3) throw new Error('again');
				return 'done';
			});
			const zeroDelay = retry(fn, { delay: 0 });

			await jest.runAllTimersAsync();
			await expect(zeroDelay).resolves.toBe('done');
			calls = 0;

			const zeroMax = retry(fn, { delay: 100, maxDelay: 0 });

			await jest.runAllTimersAsync();
			await expect(zeroMax).resolves.toBe('done');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should not spin synchronously on a throwing fn with infinite retries, and should stay abortable', async function () {
			const controller = new AbortController();
			let calls = 0;
			const pending = retry(
				function (): never {
					calls++;
					throw new Error('sync');
				},
				{ retries: Infinity, signal: controller.signal }
			);

			// retry returned: the loop is not blocking the thread. A timer-driven abort is observed.
			setTimeout(function () {
				controller.abort(new Error('stop'));
			}, 20);
			await expect(pending).rejects.toThrow('stop');
			expect(calls).toBeGreaterThan(1);
		});

		it('should reject a signal-like value without listener methods before starting timers', async function () {
			await expect(retry(jest.fn(), { signal: { aborted: false } as never })).rejects.toThrow(
				new TypeError('retry: `signal` must be an AbortSignal, null or undefined, got object')
			);
			await expect(sleep(10, { signal: { aborted: false } as never })).rejects.toThrow(
				new TypeError('sleep: `signal` must be an AbortSignal, null or undefined, got object')
			);
			await expect(pollUntil(jest.fn(), { signal: { aborted: false } as never })).rejects.toThrow(
				new TypeError('pollUntil: `signal` must be an AbortSignal, null or undefined, got object')
			);
		});

		it('should reject with a TypeError when fn is not a function', async function () {
			await expect(retry(42 as any)).rejects.toThrow(new TypeError('retry: `fn` must be a function, got number'));
		});
	});

	describe('mapWithConcurrency', function () {
		it('should map items preserving order', async function () {
			const result = await mapWithConcurrency(
				[30, 10, 20],
				async function (n, i) {
					await sleep(n);
					return `${i}:${n}`;
				},
				2
			);
			expect(result).toEqual(['0:30', '1:10', '2:20']);
		});

		it('should accept any iterable and sync mappers', async function () {
			const result = await mapWithConcurrency(new Set(['a', 'b']), function (s) {
				return s.toUpperCase();
			});
			expect(result).toEqual(['A', 'B']);
		});

		it('should resolve with an empty array for empty input', async function () {
			const mapper = jest.fn();
			await expect(mapWithConcurrency([], mapper, 3)).resolves.toEqual([]);
			expect(mapper).not.toHaveBeenCalled();
		});

		it('should never exceed the concurrency limit', async function () {
			let inFlight = 0;
			let maxInFlight = 0;
			const deferreds = Array.from({ length: 6 }, function () {
				return createDeferred<void>();
			});
			const promise = mapWithConcurrency(
				deferreds,
				async function (deferred, i) {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await deferred.promise;
					inFlight--;
					return i;
				},
				2
			);

			await Promise.resolve();
			expect(inFlight).toBe(2);
			for (const deferred of deferreds) {
				deferred.resolve();
				await new Promise(setImmediate);
			}
			await expect(promise).resolves.toEqual([0, 1, 2, 3, 4, 5]);
			expect(maxInFlight).toBe(2);
		});

		it('should reject on the first error and stop scheduling new items', async function () {
			const started: number[] = [];
			const promise = mapWithConcurrency(
				[0, 1, 2, 3, 4],
				async function (n) {
					started.push(n);
					await Promise.resolve();
					if (n === 1) throw new Error('bad');
					return n;
				},
				2
			);
			await expect(promise).rejects.toThrow('bad');
			await new Promise(setImmediate);
			expect(started).toEqual([0, 1, 2]);
		});

		it('should start every item at once when the concurrency allows it, and stop at a synchronous throw', async function () {
			const started: number[] = [];
			const unhandled = jest.fn();
			process.on('unhandledRejection', unhandled);
			try {
				const promise = mapWithConcurrency([0, 1, 2, 3], function (n) {
					started.push(n);
					if (n === 0) return Promise.reject(new Error('async'));
					if (n === 2) throw new Error('sync');
					return n;
				});
				expect(started).toEqual([0, 1, 2]);
				await expect(promise).rejects.toThrow('sync');
				await new Promise(setImmediate);
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
			await expect(
				mapWithConcurrency(
					[1, 2, 3],
					function (n) {
						return Promise.resolve(n * 2);
					},
					3
				)
			).resolves.toEqual([2, 4, 6]);
		});

		it('should reject when the mapper throws synchronously', async function () {
			await expect(
				mapWithConcurrency([1], function () {
					throw new TypeError('sync');
				})
			).rejects.toThrow('sync');
		});

		it.each([0, -1, 1.5, NaN])('should reject with a RangeError for concurrency = %p', async function (concurrency) {
			await expect(mapWithConcurrency([1], jest.fn(), concurrency)).rejects.toThrow(
				new RangeError(`mapWithConcurrency: \`concurrency\` must be an integer >= 1 or Infinity, got ${concurrency}`)
			);
		});

		it('should reject with a TypeError when mapper is not a function', async function () {
			await expect(mapWithConcurrency([1], null as any)).rejects.toThrow(new TypeError('mapWithConcurrency: `mapper` must be a function, got null'));
		});
	});
});

describe('Async helpers (round 2)', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('attemptAsync', function () {
		it('should resolve with [undefined, value] for promises and functions', async function () {
			await expect(attemptAsync(Promise.resolve(1))).resolves.toEqual([undefined, 1]);
			await expect(
				attemptAsync(async function () {
					return 'a';
				})
			).resolves.toEqual([undefined, 'a']);
			await expect(
				attemptAsync(function () {
					return 2;
				})
			).resolves.toEqual([undefined, 2]);
		});

		it('should resolve with [error, undefined] for rejections and synchronous throws', async function () {
			const error = new Error('x');
			await expect(attemptAsync(Promise.reject(error))).resolves.toEqual([error, undefined]);
			await expect(
				attemptAsync(function () {
					throw error;
				})
			).resolves.toEqual([error, undefined]);
		});

		it('should accept thenables', async function () {
			const thenable: PromiseLike<number> = {
				then: function (onFulfilled: any) {
					return Promise.resolve(onFulfilled(5));
				}
			};
			await expect(attemptAsync(thenable)).resolves.toEqual([undefined, 5]);
		});
	});

	describe('createLimiter', function () {
		it('should run at most `concurrency` tasks and expose the counts', async function () {
			const limit = createLimiter(2);
			const deferreds = [createDeferred<number>(), createDeferred<number>(), createDeferred<number>()];
			const promises = deferreds.map(function (deferred) {
				return limit(function () {
					return deferred.promise;
				});
			});
			expect([limit.activeCount, limit.pendingCount]).toEqual([2, 1]);

			deferreds[0].resolve(0);
			await promises[0];
			await Promise.resolve();
			expect([limit.activeCount, limit.pendingCount]).toEqual([2, 0]);

			deferreds[1].resolve(1);
			deferreds[2].resolve(2);
			await expect(Promise.all(promises)).resolves.toEqual([0, 1, 2]);
			await Promise.resolve();
			expect([limit.activeCount, limit.pendingCount]).toEqual([0, 0]);
		});

		it('should start tasks in FIFO order and forward arguments', async function () {
			const limit = createLimiter(1);
			const started: number[] = [];
			const results = await Promise.all(
				[1, 2, 3, 4].map(function (n) {
					return limit(
						async function (value: number, factor: number) {
							started.push(value);
							await Promise.resolve();
							return value * factor;
						},
						n,
						10
					);
				})
			);
			expect(started).toEqual([1, 2, 3, 4]);
			expect(results).toEqual([10, 20, 30, 40]);
		});

		it('should turn synchronous throws and rejections into rejections and free the slot', async function () {
			const limit = createLimiter(1);
			const first = limit(function () {
				throw new Error('sync');
			});
			const second = limit(function () {
				return Promise.reject(new Error('async'));
			});
			const third = limit(function () {
				return 'ok';
			});
			await expect(first).rejects.toThrow('sync');
			await expect(second).rejects.toThrow('async');
			await expect(third).resolves.toBe('ok');
		});

		it('should drain its queue without leaving unhandled rejections behind', async function () {
			const unhandled = jest.fn();
			process.on('unhandledRejection', unhandled);
			try {
				const limit = createLimiter(1);
				const results = await Promise.all(
					[1, 2, 3].map(function (n) {
						return limit(function () {
							return n;
						});
					})
				);
				expect(results).toEqual([1, 2, 3]);
				await new Promise(function (resolve) {
					setTimeout(resolve, 10);
				});
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
		});

		it('should reject with a TypeError for non-function tasks', async function () {
			await expect(createLimiter(1)(42 as any)).rejects.toThrow(new TypeError('createLimiter: `fn` must be a function, got number'));
		});

		it('should discard queued tasks on clearQueue (never settling by default)', async function () {
			const limit = createLimiter(1);
			const blocker = createDeferred<void>();
			const spy = jest.fn();
			const running = limit(function () {
				return blocker.promise;
			});
			const queued = limit(spy);
			expect(limit.pendingCount).toBe(1);
			limit.clearQueue();
			expect(limit.pendingCount).toBe(0);
			blocker.resolve();
			await running;
			expect(await stateOf(queued)).toBe('pending');
			expect(spy).not.toHaveBeenCalled();
		});

		it('should reject discarded tasks with an AbortError when rejectOnClear is set', async function () {
			const limit = createLimiter(1, { rejectOnClear: true });
			const blocker = createDeferred<void>();
			limit(function () {
				return blocker.promise;
			});
			const queued = limit(jest.fn());
			const second = limit(jest.fn());
			limit.clearQueue();
			await expect(queued).rejects.toThrow(new AbortError('The task was removed from the limiter queue.'));
			await expect(second).rejects.toBeInstanceOf(AbortError);
			expect(limit.pendingCount).toBe(0);
			blocker.resolve();
		});

		it('should support Infinity and long queues', async function () {
			const unlimited = createLimiter(Infinity);
			const deferreds = Array.from({ length: 5 }, function () {
				return createDeferred<void>();
			});
			deferreds.forEach(function (deferred) {
				unlimited(function () {
					return deferred.promise;
				});
			});
			expect(unlimited.activeCount).toBe(5);

			const limit = createLimiter(3);
			const results = await Promise.all(
				Array.from({ length: 3000 }, function (_, i) {
					return limit(function () {
						return i;
					});
				})
			);
			expect(results[2999]).toBe(2999);
			expect(limit.pendingCount).toBe(0);
		});

		it.each([0, -1, 1.5, NaN])('should throw a RangeError for concurrency = %p', function (concurrency) {
			expect(function () {
				createLimiter(concurrency);
			}).toThrow(new RangeError(`createLimiter: \`concurrency\` must be an integer >= 1 or Infinity, got ${concurrency}`));
		});

		describe('security: maxPending bounds the queue', function () {
			it('should reject calls with a RangeError, without queueing or running them, once `maxPending` tasks wait', async function () {
				const limit = createLimiter(1, { maxPending: 1 });
				const blocker = createDeferred<string>();
				const running = limit(function () {
					return blocker.promise;
				});
				const queued = limit(function () {
					return 'queued';
				});
				const overflow = jest.fn();
				const rejected = limit(overflow);
				expect([limit.activeCount, limit.pendingCount]).toEqual([1, 1]);
				await expect(rejected).rejects.toThrow(new RangeError('createLimiter: the queue is full (`maxPending` is 1)'));
				expect(overflow).not.toHaveBeenCalled();
				expect(limit.pendingCount).toBe(1);

				blocker.resolve('running');
				await expect(running).resolves.toBe('running');
				await expect(queued).resolves.toBe('queued');
				// Once the queue has room again, calls are accepted.
				await expect(
					limit(function () {
						return 'later';
					})
				).resolves.toBe('later');
			});

			it('should never queue with `maxPending: 0`, but still run tasks while a slot is free', async function () {
				const limit = createLimiter(2, { maxPending: 0 });
				const blockers = [createDeferred<void>(), createDeferred<void>()];
				const running = blockers.map(function (blocker) {
					return limit(function () {
						return blocker.promise;
					});
				});
				await expect(limit(jest.fn())).rejects.toBeInstanceOf(RangeError);
				expect([limit.activeCount, limit.pendingCount]).toEqual([2, 0]);
				blockers[0].resolve();
				blockers[1].resolve();
				await Promise.all(running);
			});

			it('should free capacity when the queue is cleared', async function () {
				const limit = createLimiter(1, { maxPending: 2, rejectOnClear: true });
				const blocker = createDeferred<void>();
				const running = limit(function () {
					return blocker.promise;
				});
				const discarded = [limit(jest.fn()), limit(jest.fn())];
				await expect(limit(jest.fn())).rejects.toBeInstanceOf(RangeError);
				limit.clearQueue();
				await expect(Promise.allSettled(discarded)).resolves.toHaveLength(2);
				const accepted = limit(function () {
					return 1;
				});
				expect(limit.pendingCount).toBe(1);
				blocker.resolve();
				await running;
				await expect(accepted).resolves.toBe(1);
			});

			it('should keep the queue unbounded by default and with `maxPending: Infinity`', async function () {
				for (const limit of [createLimiter(1), createLimiter(1, { maxPending: Infinity })]) {
					const blocker = createDeferred<void>();
					const all = [
						limit(function () {
							return blocker.promise;
						})
					];
					for (let i = 0; i < 1000; i++) all.push(limit(jest.fn()));
					expect(limit.pendingCount).toBe(1000);
					blocker.resolve();
					await Promise.all(all);
				}
			});

			it.each([-1, 1.5, NaN])('should throw a RangeError for maxPending = %p', function (maxPending) {
				expect(function () {
					createLimiter(1, { maxPending });
				}).toThrow(new RangeError(`createLimiter: \`maxPending\` must be an integer >= 0 or Infinity, got ${maxPending}`));
			});

			it('should throw a TypeError for a non-number maxPending', function () {
				expect(function () {
					createLimiter(1, { maxPending: '5' as any });
				}).toThrow(new TypeError('createLimiter: `maxPending` must be an integer >= 0 or Infinity, got string'));
			});
		});
	});

	describe('pollUntil', function () {
		it('should resolve with the first truthy value, checking every interval', async function () {
			jest.useFakeTimers();

			let calls = 0;
			const check = jest.fn(function () {
				calls++;
				return calls >= 3 ? `done after ${calls}` : null;
			});
			const promise = pollUntil(check, { interval: 50 });
			expect(check).toHaveBeenCalledTimes(1);
			await jest.advanceTimersByTimeAsync(50);
			expect(check).toHaveBeenCalledTimes(2);
			await jest.advanceTimersByTimeAsync(50);
			await expect(promise).resolves.toBe('done after 3');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should wait for async checks without overlapping them', async function () {
			jest.useFakeTimers();

			let running = 0;
			let maxRunning = 0;
			let calls = 0;
			const promise = pollUntil(
				async function () {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await sleep(30);
					running--;
					calls++;
					return calls === 2 ? 0 : calls === 3;
				},
				{ interval: 10 }
			);
			await jest.advanceTimersByTimeAsync(200);
			await expect(promise).resolves.toBe(true);
			expect(maxRunning).toBe(1);
		});

		it('should use the default interval', async function () {
			jest.useFakeTimers();

			let ready = false;
			const promise = pollUntil(function () {
				return ready;
			});
			await jest.advanceTimersByTimeAsync(99);
			ready = true;
			expect(await stateOf(promise)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await expect(promise).resolves.toBe(true);
		});

		it('should reject with a TimeoutError and clean up', async function () {
			jest.useFakeTimers();

			const check = jest.fn(function () {
				return false;
			});
			const promise = pollUntil(check, { interval: 10, timeout: 35 });
			const assertion = expect(promise).rejects.toThrow(new TimeoutError('pollUntil: condition not met within 35 ms'));
			await jest.advanceTimersByTimeAsync(35);
			await assertion;
			expect(jest.getTimerCount()).toBe(0);
			expect(check).toHaveBeenCalledTimes(4);
		});

		it('should time out while an async check is still running and ignore its late result', async function () {
			jest.useFakeTimers();

			const promise = pollUntil(
				function () {
					return sleep(100).then(function () {
						return 'late';
					});
				},
				{ timeout: 20 }
			);
			const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
			await jest.advanceTimersByTimeAsync(200);
			await assertion;

			// A late falsy result does not start polling again.
			const slowFalsy = jest.fn(function () {
				return sleep(100).then(function () {
					return false;
				});
			});
			const stopped = pollUntil(slowFalsy, { interval: 10, timeout: 20 });
			const stoppedAssertion = expect(stopped).rejects.toBeInstanceOf(TimeoutError);
			await jest.advanceTimersByTimeAsync(1000);
			await stoppedAssertion;
			expect(slowFalsy).toHaveBeenCalledTimes(1);
			expect(jest.getTimerCount()).toBe(0);

			const lateFailure = pollUntil(
				function () {
					return sleep(100).then(function () {
						throw new Error('late failure');
					});
				},
				{ timeout: 20 }
			);
			const lateAssertion = expect(lateFailure).rejects.toBeInstanceOf(TimeoutError);
			await jest.advanceTimersByTimeAsync(200);
			await lateAssertion;
		});

		it('should reject with the error of a failing check', async function () {
			await expect(
				pollUntil(function () {
					throw new Error('sync fail');
				})
			).rejects.toThrow('sync fail');
			await expect(
				pollUntil(function () {
					return Promise.reject(new Error('async fail'));
				})
			).rejects.toThrow('async fail');
		});

		it('should reject with the abort reason, before or during polling', async function () {
			jest.useFakeTimers();

			const pre = new AbortController();
			pre.abort(new Error('pre'));
			const check = jest.fn();
			await expect(pollUntil(check, { signal: pre.signal })).rejects.toThrow('pre');
			expect(check).not.toHaveBeenCalled();

			const controller = new AbortController();
			const promise = pollUntil(check, { signal: controller.signal, timeout: 1000 });
			await jest.advanceTimersByTimeAsync(150);
			controller.abort();
			await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should remove the abort listener once settled', async function () {
			const signal = { aborted: false, addEventListener: jest.fn(), removeEventListener: jest.fn() };
			await pollUntil(
				function () {
					return 1;
				},
				{ signal }
			);
			expect(signal.removeEventListener).toHaveBeenCalledWith('abort', signal.addEventListener.mock.calls[0][1]);
		});

		it.each([
			[{ interval: -1 }, '`interval` must be a number between 0 and 2147483647, got -1'],
			[{ interval: NaN }, '`interval` must be a number between 0 and 2147483647, got NaN'],
			[{ timeout: -5 }, '`timeout` must be Infinity or a number between 0 and 2147483647, got -5'],
			[{ timeout: 2 ** 31 }, '`timeout` must be Infinity or a number between 0 and 2147483647, got 2147483648']
		])('should reject with a RangeError for %p', async function (options, message) {
			await expect(pollUntil(jest.fn(), options)).rejects.toThrow(new RangeError(`pollUntil: ${message}`));
		});

		it('should reject with a TypeError for a non-function check', async function () {
			await expect(pollUntil(null as any)).rejects.toThrow(new TypeError('pollUntil: `check` must be a function, got null'));
		});
	});

	describe('promiseAllObject / promiseAllSettledObject', function () {
		it('should await every value and keep the keys', async function () {
			const sym = Symbol('s');
			const result = await promiseAllObject({ a: Promise.resolve(1), b: 'plain', [sym]: Promise.resolve(true) });
			expect(result).toEqual({ a: 1, b: 'plain', [sym]: true });
			expect(result[sym]).toBe(true);
			// Ordinary data properties, like those of an object literal.
			expect(Object.getOwnPropertyDescriptor(result, 'a')).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
			const settled = await promiseAllSettledObject({ a: 1 });
			expect(Object.getOwnPropertyDescriptor(settled, 'a')).toEqual({ value: { status: 'fulfilled', value: 1 }, writable: true, enumerable: true, configurable: true });
			const typed: { a: number; b: string } = result;
			expect(typed.a).toBe(1);
			await expect(promiseAllObject({})).resolves.toEqual({});
		});

		it('should reject with the first rejection', async function () {
			await expect(promiseAllObject({ a: Promise.resolve(1), b: Promise.reject(new Error('b')) })).rejects.toThrow('b');
		});

		it('should keep __proto__ as an own key and ignore inherited and non-enumerable keys', async function () {
			const input = JSON.parse('{"__proto__": 1, "x": 2}');
			const inherited = Object.create({ inheritedKey: 1 }, { hidden: { value: 2, enumerable: false }, shown: { value: 3, enumerable: true } });
			const result = await promiseAllObject(input);
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.keys(result)).toEqual(['__proto__', 'x']);
			expect(Object.getOwnPropertyDescriptor(result, '__proto__')).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
			await expect(promiseAllObject(inherited)).resolves.toEqual({ shown: 3 });
			const hiddenSymbol = Symbol('hidden');
			const shownSymbol = Symbol('shown');
			const withSymbols = Object.defineProperties({}, { [hiddenSymbol]: { value: 1, enumerable: false }, [shownSymbol]: { value: 2, enumerable: true } });
			const symbolResult = await promiseAllObject(withSymbols);
			expect(Reflect.ownKeys(symbolResult)).toEqual([shownSymbol]);
		});

		it('should settle every value', async function () {
			const error = new Error('x');
			await expect(promiseAllSettledObject({ a: Promise.resolve(1), b: Promise.reject(error), c: 3 })).resolves.toEqual({
				a: { status: 'fulfilled', value: 1 },
				b: { status: 'rejected', reason: error },
				c: { status: 'fulfilled', value: 3 }
			});
		});

		it.each([null, 1, 'str', [1]])('should reject with a TypeError for %p', async function (input) {
			const got = Array.isArray(input) ? 'an array' : input === null ? 'null' : typeof input;
			await expect(promiseAllObject(input as any)).rejects.toThrow(new TypeError(`promiseAllObject: expected a non-array object, got ${got}`));
			await expect(promiseAllSettledObject(input as any)).rejects.toThrow(new TypeError(`promiseAllSettledObject: expected a non-array object, got ${got}`));
		});
	});

	describe('debounceAsync', function () {
		it('should share one invocation between all calls of a burst', async function () {
			jest.useFakeTimers();

			const fn = jest.fn(async function (query: string) {
				return `results for ${query}`;
			});
			const search = debounceAsync(fn, 100);
			const first = search('a');
			const second = search('ab');
			await jest.advanceTimersByTimeAsync(50);
			const third = search('abc');
			await jest.advanceTimersByTimeAsync(100);
			await expect(Promise.all([first, second, third])).resolves.toEqual(['results for abc', 'results for abc', 'results for abc']);
			expect(fn).toHaveBeenCalledTimes(1);

			const next = search('x');
			expect(next).not.toBe(first);
			await jest.advanceTimersByTimeAsync(100);
			await expect(next).resolves.toBe('results for x');
		});

		it('should reject every caller when fn throws or rejects, and preserve this', async function () {
			jest.useFakeTimers();

			const failing = debounceAsync(function (this: { name: string }) {
				throw new Error(`sync ${this.name}`);
			}, 10);
			const obj = { name: 'obj', failing };
			const a = obj.failing();
			const b = obj.failing();
			const assertions = Promise.all([expect(a).rejects.toThrow('sync obj'), expect(b).rejects.toThrow('sync obj')]);
			await jest.advanceTimersByTimeAsync(10);
			await assertions;

			const rejecting = debounceAsync(function () {
				return Promise.reject(new Error('async'));
			}, 10);
			const c = rejecting();
			const assertion = expect(c).rejects.toThrow('async');
			await jest.advanceTimersByTimeAsync(10);
			await assertion;
		});

		it('should start a new burst for calls made while fn runs', async function () {
			jest.useFakeTimers();

			let inner: Promise<number> | undefined;
			const fn = jest.fn(function (n: number): number {
				if (n === 1) inner = debounced(2);
				return n;
			});
			const debounced = debounceAsync(fn, 10);
			const outer = debounced(1);
			await jest.advanceTimersByTimeAsync(10);
			await expect(outer).resolves.toBe(1);
			await jest.advanceTimersByTimeAsync(10);
			await expect(inner).resolves.toBe(2);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should cancel with an AbortError and flush on demand', async function () {
			jest.useFakeTimers();

			const fn = jest.fn(function (n: number) {
				return n * 2;
			});
			const debounced = debounceAsync(fn, 100);
			const cancelled = debounced(1);
			debounced.cancel();
			await expect(cancelled).rejects.toThrow(new AbortError('The debounced call was cancelled.'));
			expect(jest.getTimerCount()).toBe(0);
			debounced.cancel();

			expect(debounced.flush()).toBeUndefined();
			const flushed = debounced(4);
			expect(debounced.flush()).toBe(flushed);
			await expect(flushed).resolves.toBe(8);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should validate its arguments', function () {
			expect(function () {
				debounceAsync(null as any, 10);
			}).toThrow(new TypeError('debounceAsync: `fn` must be a function, got null'));
			expect(function () {
				debounceAsync(jest.fn(), -1);
			}).toThrow(new RangeError('debounceAsync: `wait` must be a number between 0 and 2147483647, got -1'));
			expect(function () {
				debounceAsync(jest.fn(), 2 ** 31);
			}).toThrow(new RangeError('debounceAsync: `wait` must be a number between 0 and 2147483647, got 2147483648'));
		});
	});

	describe('sequence', function () {
		it('should run tasks one at a time, in order', async function () {
			const log: string[] = [];

			function task(name: string, ticks: number) {
				return async function () {
					log.push(`start ${name}`);
					for (let i = 0; i < ticks; i++) await Promise.resolve();
					log.push(`end ${name}`);
					return name;
				};
			}

			await expect(sequence([task('a', 3), task('b', 0), task('c', 1)])).resolves.toEqual(['a', 'b', 'c']);
			expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
		});

		it('should accept sync tasks, empty input and pull lazily from generators', async function () {
			await expect(sequence([])).resolves.toEqual([]);
			const pulled: number[] = [];

			function* tasks() {
				for (let i = 0; i < 3; i++) {
					pulled.push(i);
					yield function () {
						return i * 10;
					};
				}
			}

			await expect(sequence(tasks())).resolves.toEqual([0, 10, 20]);
			expect(pulled).toEqual([0, 1, 2]);
		});

		it('should stop at the first error and close the iterator', async function () {
			const ran: number[] = [];
			let closed = false;

			function* tasks() {
				try {
					yield function () {
						ran.push(1);
					};
					yield function () {
						throw new Error('second');
					};
					yield function () {
						ran.push(3);
					};
				} finally {
					closed = true;
				}
			}

			await expect(sequence(tasks())).rejects.toThrow('second');
			expect(ran).toEqual([1]);
			expect(closed).toBe(true);
		});

		it('should reject with a TypeError for non-function tasks', async function () {
			await expect(sequence([jest.fn(), 42 as any])).rejects.toThrow(new TypeError('sequence: `tasks[1]` must be a function, got number'));
		});
	});

	describe('argument validation', function () {
		it('validates the retry callbacks up front instead of failing on the first retry', async function () {
			const fn = jest.fn().mockRejectedValue(new Error('boom'));
			await expect(retry(fn, { shouldRetry: 'yes' as any })).rejects.toThrow(new TypeError('retry: `shouldRetry` must be a function, got string'));
			await expect(retry(fn, { onRetry: 1 as any })).rejects.toThrow(new TypeError('retry: `onRetry` must be a function, got number'));
			await expect(retry(undefined as any)).rejects.toThrow(new TypeError('retry: `fn` must be a function, got undefined'));
			expect(fn).not.toHaveBeenCalled();
		});

		it('throws a TypeError for non-number arguments and a RangeError for invalid numbers', async function () {
			await expect(sleep('5' as any)).rejects.toThrow(new TypeError('sleep: `ms` must be a number between 0 and 2147483647, got string'));
			await expect(retry(jest.fn(), { retries: -1 })).rejects.toThrow(new RangeError('retry: `retries` must be an integer >= 0 or Infinity, got -1'));
			await expect(pollUntil(jest.fn(), { timeout: -1 })).rejects.toThrow(
				new RangeError('pollUntil: `timeout` must be Infinity or a number between 0 and 2147483647, got -1')
			);
			expect(function () {
				createLimiter(null as any);
			}).toThrow(new TypeError('createLimiter: `concurrency` must be an integer >= 1 or Infinity, got null'));
		});
	});
	describe('timeoutSignal', function () {
		it('should abort with a TimeoutError after the delay', function () {
			jest.useFakeTimers();
			const signal = timeoutSignal(100);
			expect(signal).toBeInstanceOf(AbortSignal);
			jest.advanceTimersByTime(99);
			expect(signal.aborted).toBe(false);
			jest.advanceTimersByTime(1);
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toBeInstanceOf(TimeoutError);
			expect(signal.reason).toEqual(new TimeoutError('timeoutSignal: timed out after 100 ms'));
		});

		it('should dispatch an abort event', function () {
			jest.useFakeTimers();
			const signal = timeoutSignal(0);
			const listener = jest.fn();
			signal.addEventListener('abort', listener);
			jest.advanceTimersByTime(0);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('should return a platform AbortSignal (typed as such)', function () {
			const signal: AbortSignal = timeoutSignal(Infinity);
			expect(function () {
				signal.throwIfAborted();
			}).not.toThrow();
		});

		it('should never abort (and start no timer) for Infinity', function () {
			jest.useFakeTimers();
			const signal = timeoutSignal(Infinity);
			expect(jest.getTimerCount()).toBe(0);
			jest.advanceTimersByTime(2 ** 31);
			expect(signal.aborted).toBe(false);
		});

		it('should validate the delay', function () {
			expect(function () {
				timeoutSignal('10' as any);
			}).toThrow(new TypeError('timeoutSignal: `ms` must be Infinity or a number between 0 and 2147483647, got string'));
			for (const ms of [-1, NaN, 2 ** 31, -Infinity]) {
				expect(function () {
					timeoutSignal(ms);
				}).toThrow(new RangeError(`timeoutSignal: \`ms\` must be Infinity or a number between 0 and 2147483647, got ${ms}`));
			}
		});

		it('should throw a clear Error without AbortController', function () {
			withoutAbortController(function () {
				expect(function () {
					timeoutSignal(10);
				}).toThrow(new Error('timeoutSignal: `AbortController` is not available in this environment'));
			});
		});
	});

	describe('anySignal', function () {
		it('should abort with the reason of the first input that aborts and remove every listener', function () {
			const a = new CountingSignal();
			const b = new CountingSignal();
			const c = new CountingSignal();
			const signal = anySignal([a, b, c]);
			expect(signal.aborted).toBe(false);
			expect([a.listenerCount, b.listenerCount, c.listenerCount]).toEqual([1, 1, 1]);
			b.abort('b');
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toBe('b');
			expect([a.listenerCount, b.listenerCount, c.listenerCount]).toEqual([0, 0, 0]);
			a.abort('a');
			expect(signal.reason).toBe('b');
		});

		it('should dispatch an abort event on the result', function () {
			const controller = new AbortController();
			const signal = anySignal([controller.signal]);
			const listener = jest.fn();
			signal.addEventListener('abort', listener);
			controller.abort();
			expect(listener).toHaveBeenCalledTimes(1);
			expect((signal.reason as Error).name).toBe('AbortError');
		});

		it('should return an already-aborted signal without attaching listeners when an input is aborted', function () {
			const live = new CountingSignal();
			const first = new CountingSignal();
			const second = new CountingSignal();
			second.abort('second');
			first.abort('first');
			const signal = anySignal([live, second, first]);
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toBe('second');
			expect(live.listenerCount).toBe(0);
		});

		it('should use an AbortError when the input has no reason', function () {
			const input = new CountingSignal();
			const signal = anySignal([input]);
			input.abort();
			expect(signal.reason).toBeInstanceOf(AbortError);
			const already = new CountingSignal();
			already.abort();
			expect(anySignal([already]).reason).toBeInstanceOf(AbortError);
		});

		it('should ignore null and undefined, and never abort without inputs', function () {
			expect(anySignal([]).aborted).toBe(false);
			expect(anySignal([null, undefined]).aborted).toBe(false);
			const input = new CountingSignal();
			const signal = anySignal([undefined, input, null]);
			input.abort(42);
			expect(signal.reason).toBe(42);
		});

		it('should accept any iterable, including generators, and duplicated inputs', function () {
			const input = new CountingSignal();
			function* signals(): Generator<AbortSignalLike> {
				yield input;
				yield input;
			}
			const signal = anySignal(signals());
			// One listener per signal, however many times (and by however many waiters) it is listed.
			expect(input.listenerCount).toBe(1);
			input.abort('x');
			expect(signal.reason).toBe('x');
			expect(input.listenerCount).toBe(0);
		});

		it('should walk an array by its own keys (regression: a sparse array of length 2 ** 32 - 1 took hours, one index at a time)', function () {
			const first = new CountingSignal();
			const last = new CountingSignal();
			const signals: Array<AbortSignalLike | undefined> = [];
			signals.length = 2 ** 32 - 1;
			signals[0] = first;
			signals[2 ** 32 - 2] = last;
			// The iterator visits every index (and so do index reads): counted, and stopped long before the end.
			let reads = 0;
			const counted = new Proxy(signals, {
				get(target, key, receiver) {
					if (typeof key === 'string' && key !== 'length' && ++reads > 100) throw new Error('read index by index');
					return Reflect.get(target, key, receiver);
				}
			});
			const signal = anySignal(counted);
			expect(reads).toBe(2);
			expect(first.listenerCount + last.listenerCount).toBe(2);
			last.abort('last');
			expect(signal.reason).toBe('last');
			expect(first.listenerCount + last.listenerCount).toBe(0);
			// Keys that are not indexes are not entries; an invalid entry is reported at its index.
			// oxlint-disable-next-line no-sparse-arrays
			const named = Object.assign([undefined, , first], { name: {}, '1.5': {}, '4294967295': {}, '-1': {} });
			expect(anySignal(named as never).aborted).toBe(false);
			const invalid: unknown[] = [];
			invalid[2 ** 31] = 'x';
			expect(function () {
				anySignal(invalid as never);
			}).toThrow(new TypeError('anySignal: `signals[2147483648]` must be an AbortSignal, null or undefined, got string'));
		});

		it('should take every index of a Proxy listing a key that is not an index first (regression: the signals after it were dropped)', function () {
			const input = new CountingSignal();
			const target = Object.assign([input], { name: 'signals' });
			const listed = new Proxy(target, {
				ownKeys() {
					return ['name', '0', 'length'];
				}
			});
			const signal = anySignal(listed);
			expect(input.listenerCount).toBe(1);
			input.abort('x');
			expect(signal.reason).toBe('x');
		});

		it('should combine with timeoutSignal', function () {
			jest.useFakeTimers();
			const controller = new AbortController();
			const signal = anySignal([controller.signal, timeoutSignal(50)]);
			jest.advanceTimersByTime(50);
			expect(signal.reason).toBeInstanceOf(TimeoutError);
		});

		it('should validate its input', function () {
			for (const value of [null, undefined, 42, {}]) {
				expect(function () {
					anySignal(value as any);
				}).toThrow(new TypeError(`anySignal: \`signals\` must be an iterable, got ${value === null ? 'null' : typeof value}`));
			}
			expect(function () {
				anySignal([undefined, {}] as any);
			}).toThrow(new TypeError('anySignal: `signals[1]` must be an AbortSignal, null or undefined, got object'));
			expect(function () {
				anySignal('ab' as any);
			}).toThrow(new TypeError('anySignal: `signals[0]` must be an AbortSignal, null or undefined, got string'));
			expect(function () {
				anySignal([{ addEventListener() {} }] as any);
			}).toThrow(new TypeError('anySignal: `signals[0]` must be an AbortSignal, null or undefined, got object'));
			expect(function () {
				anySignal([{ removeEventListener() {} }] as any);
			}).toThrow(new TypeError('anySignal: `signals[0]` must be an AbortSignal, null or undefined, got object'));
			// Only objects qualify, even callable ones with the right methods.
			const callable = Object.assign(function () {}, { aborted: false, addEventListener() {}, removeEventListener() {} });
			expect(function () {
				anySignal([callable] as any);
			}).toThrow(new TypeError('anySignal: `signals[0]` must be an AbortSignal, null or undefined, got function'));
		});

		it('should throw a clear Error without AbortController', function () {
			withoutAbortController(function () {
				expect(function () {
					anySignal([]);
				}).toThrow(new Error('anySignal: `AbortController` is not available in this environment'));
			});
		});
	});

	describe('abortable', function () {
		it('should handle the rejection of the promise when `signal` is invalid', async function () {
			const unhandled = jest.fn();
			process.on('unhandledRejection', unhandled);
			try {
				await expect(abortable(Promise.reject(new Error('inner')), {} as any)).rejects.toThrow(TypeError);
				await new Promise(setImmediate);
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
		});

		it('should resolve like the promise and remove its listener', async function () {
			const signal = new CountingSignal();
			const promise = abortable(Promise.resolve('value'), signal);
			expect(signal.listenerCount).toBe(1);
			await expect(promise).resolves.toBe('value');
			expect(signal.listenerCount).toBe(0);
		});

		it('should reject like the promise and remove its listener', async function () {
			const signal = new CountingSignal();
			const error = new Error('boom');
			await expect(abortable(Promise.reject(error), signal)).rejects.toBe(error);
			expect(signal.listenerCount).toBe(0);
		});

		it('should accept plain values', async function () {
			await expect(abortable(7, new CountingSignal())).resolves.toBe(7);
		});

		it('should not keep its abort listener after an abort, even if the promise never settles', async function () {
			const signal = new CountingSignal();
			const promise = abortable(new Promise(function () {}), signal);
			expect(signal.listenerCount).toBe(1);
			signal.abort('gone');
			await expect(promise).rejects.toBe('gone');
			expect(signal.listenerCount).toBe(0);
		});

		it('should reject with the abort reason when the signal aborts first', async function () {
			const signal = new CountingSignal();
			const work = createDeferred<number>();
			const promise = abortable(work.promise, signal);
			signal.abort('cancelled');
			expect(signal.listenerCount).toBe(0);
			await expect(promise).rejects.toBe('cancelled');
			// The late outcome of the underlying work is ignored (and its rejection handled).
			work.reject(new Error('late'));
			await Promise.resolve();
		});

		it('should reject immediately for an already-aborted signal, even if the promise is resolved', async function () {
			const signal = new CountingSignal();
			signal.abort();
			const promise = abortable(Promise.resolve(1), signal);
			await expect(promise).rejects.toBeInstanceOf(AbortError);
			expect(signal.listenerCount).toBe(0);
			const controller = new AbortController();
			controller.abort(new TimeoutError());
			await expect(abortable(new Promise(function () {}), controller.signal)).rejects.toBeInstanceOf(TimeoutError);
		});

		it('should just settle like the promise without a signal', async function () {
			await expect(abortable(Promise.resolve(1), undefined)).resolves.toBe(1);
			await expect(abortable(Promise.reject(new Error('x')), null)).rejects.toThrow('x');
		});

		it('should reject with a TypeError for an invalid signal', async function () {
			await expect(abortable(Promise.resolve(1), {} as any)).rejects.toThrow(new TypeError('abortable: `signal` must be an AbortSignal, null or undefined, got object'));
			await expect(abortable(Promise.resolve(1), 'signal' as any)).rejects.toThrow(
				new TypeError('abortable: `signal` must be an AbortSignal, null or undefined, got string')
			);
		});
	});

	describe('throwIfAborted', function () {
		it('should do nothing for live, null or undefined signals', function () {
			expect(throwIfAborted(new CountingSignal())).toBeUndefined();
			expect(throwIfAborted(new AbortController().signal)).toBeUndefined();
			expect(throwIfAborted(null)).toBeUndefined();
			expect(throwIfAborted(undefined)).toBeUndefined();
		});

		it('should throw the abort reason, or an AbortError', function () {
			const signal = new CountingSignal();
			signal.abort('why');
			expect(function () {
				throwIfAborted(signal);
			}).toThrow('why');
			const bare = new CountingSignal();
			bare.abort();
			expect(function () {
				throwIfAborted(bare);
			}).toThrow(AbortError);
		});

		it('should throw a TypeError for an invalid signal', function () {
			expect(function () {
				throwIfAborted({ aborted: true } as any);
			}).toThrow(new TypeError('throwIfAborted: `signal` must be an AbortSignal, null or undefined, got object'));
		});
	});
});

/**
 * Fails the test if an unhandled rejection happens while `fn` runs (and for one macrotask after it).
 */
async function withoutUnhandledRejections(fn: () => Promise<void>): Promise<void> {
	const unhandled = jest.fn();
	process.on('unhandledRejection', unhandled);
	try {
		await fn();
		await new Promise(setImmediate);
	} finally {
		process.off('unhandledRejection', unhandled);
	}
	expect(unhandled).not.toHaveBeenCalled();
}

/** Flushes pending promise reactions (several hops). */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('Async helpers (round 11)', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('mapWithConcurrency (options)', function () {
		it('rejects when reading the items aborts the signal, and starts no item', async function () {
			const controller = new AbortController();
			const reason = new Error('stop');
			const mapper = jest.fn(function (n: number) {
				return n;
			});
			function* items(): Generator<number> {
				yield 1;
				controller.abort(reason);
				yield 2;
			}
			await expect(mapWithConcurrency(items(), mapper, { concurrency: 1, signal: controller.signal })).rejects.toBe(reason);
			expect(mapper).not.toHaveBeenCalled();
		});

		it('types the signal the callbacks receive after the signal option', async function () {
			function platformOnly(signal: AbortSignal | undefined): number {
				return signal === undefined ? 0 : 1;
			}
			const { signal } = new AbortController();
			const mapped: number[] = await mapWithConcurrency(
				[1],
				function (_n, _index, received) {
					return platformOnly(received);
				},
				{ signal }
			);
			const settled = await mapSettledWithConcurrency(
				[1],
				function (_n, _index, received) {
					return platformOnly(received);
				},
				{ signal }
			);
			const kept: number[] = await filterWithConcurrency(
				[1],
				function (_n, _index, received) {
					return platformOnly(received) === 1;
				},
				{ signal }
			);
			expect([mapped, settled, kept]).toEqual([[1], [{ status: 'fulfilled', value: 1 }], [1]]);
			await mapWithConcurrency(
				[1],
				function (_n, _index, received) {
					// @ts-expect-error a custom signal is not a platform AbortSignal
					return platformOnly(received);
				},
				{ signal: new CountingSignal() }
			);
		});

		it('accepts an options object and passes the signal to the mapper', async function () {
			const signal = new CountingSignal();
			const seen: unknown[] = [];
			const result = await mapWithConcurrency(
				[1, 2, 3],
				async function (n, index, received) {
					seen.push(received);
					await Promise.resolve();
					return n * 10 + index;
				},
				{ concurrency: 2, signal }
			);
			expect(result).toEqual([10, 21, 32]);
			expect(seen).toEqual([signal, signal, signal]);
			expect(signal.listenerCount).toBe(0);
		});

		it('defaults to unbounded concurrency with an empty options object, and passes undefined without a signal', async function () {
			const deferreds = [createDeferred<number>(), createDeferred<number>(), createDeferred<number>()];
			const signals: unknown[] = [];
			const promise = mapWithConcurrency(
				deferreds,
				function (deferred, _index, signal) {
					signals.push(signal);
					return deferred.promise;
				},
				{ signal: null }
			);
			expect(signals).toEqual([undefined, undefined, undefined]);
			deferreds.forEach(function (deferred, i) {
				deferred.resolve(i);
			});
			await expect(promise).resolves.toEqual([0, 1, 2]);
		});

		it('rejects at once with the abort reason, starts nothing more and removes its listener', async function () {
			await withoutUnhandledRejections(async function () {
				const signal = new CountingSignal();
				const started: number[] = [];
				const running: Array<ReturnType<typeof createDeferred<number>>> = [];
				const promise = mapWithConcurrency(
					[0, 1, 2, 3],
					function (n) {
						started.push(n);
						const deferred = createDeferred<number>();
						running.push(deferred);
						return deferred.promise;
					},
					{ concurrency: 2, signal }
				);
				expect(signal.listenerCount).toBe(1);
				signal.abort('stop');
				await expect(promise).rejects.toBe('stop');
				expect(signal.listenerCount).toBe(0);
				running[0].reject(new Error('late failure'));
				running[1].resolve(1);
				await flush();
				expect(started).toEqual([0, 1]);
			});
		});

		it('rejects with an AbortError when the signal has no reason, and does not call the mapper for an aborted signal', async function () {
			const mapper = jest.fn();
			const signal = new CountingSignal();
			signal.abort();
			await expect(mapWithConcurrency([1], mapper, { signal })).rejects.toBeInstanceOf(AbortError);
			expect(mapper).not.toHaveBeenCalled();
			expect(signal.listenerCount).toBe(0);
		});

		it('removes the listener after a failure', async function () {
			const signal = new CountingSignal();
			await expect(
				mapWithConcurrency(
					[1, 2],
					async function () {
						throw new Error('boom');
					},
					{ signal }
				)
			).rejects.toThrow('boom');
			expect(signal.listenerCount).toBe(0);
		});

		it('with stopOnError: false, processes every item and rejects with an AggregateError of all errors', async function () {
			await withoutUnhandledRejections(async function () {
				const started: number[] = [];
				const promise = mapWithConcurrency(
					[0, 1, 2, 3, 4],
					function (n) {
						started.push(n);
						if (n === 1) throw new Error('sync 1');
						if (n === 3) return Promise.reject(new Error('async 3'));
						return Promise.resolve(n);
					},
					{ concurrency: 2, stopOnError: false }
				);
				const error = await promise.then(
					function () {
						throw new Error('expected a rejection');
					},
					function (reason: unknown) {
						return reason as AggregateError;
					}
				);
				expect(error).toBeInstanceOf(AggregateError);
				expect(error.message).toBe('mapWithConcurrency: 2 of 5 items failed');
				expect(
					error.errors.map(function (e: Error) {
						return e.message;
					})
				).toEqual(['sync 1', 'async 3']);
				expect(started).toEqual([0, 1, 2, 3, 4]);
			});
		});

		it('with stopOnError: false, resolves when nothing failed', async function () {
			await expect(
				mapWithConcurrency(
					[1, 2],
					function (n) {
						return n + 1;
					},
					{ stopOnError: false, concurrency: 1 }
				)
			).resolves.toEqual([2, 3]);
		});

		it('rejects with a TypeError for an invalid signal or options', async function () {
			await expect(mapWithConcurrency([1], jest.fn(), { signal: {} as any })).rejects.toThrow(
				new TypeError('mapWithConcurrency: `signal` must be an AbortSignal, null or undefined, got object')
			);
			await expect(mapWithConcurrency([1], jest.fn(), null as any)).rejects.toThrow(
				new TypeError('mapWithConcurrency: `concurrency` must be an integer >= 1 or Infinity, got null')
			);
			await expect(mapWithConcurrency([1], jest.fn(), { concurrency: 0 })).rejects.toThrow(RangeError);
		});
	});

	describe('mapSettledWithConcurrency', function () {
		it('resolves with every outcome in input order, catching sync throws', async function () {
			const results = await mapSettledWithConcurrency(
				[1, 2, 3, 4],
				function (n) {
					if (n === 2) throw new Error('sync');
					if (n === 3) return Promise.reject(new Error('async'));
					return sleep(5 - n).then(function () {
						return n * 2;
					});
				},
				2
			);
			expect(results).toEqual([
				{ status: 'fulfilled', value: 2 },
				{ status: 'rejected', reason: new Error('sync') },
				{ status: 'rejected', reason: new Error('async') },
				{ status: 'fulfilled', value: 8 }
			]);
		});

		it('respects the concurrency and passes the signal', async function () {
			let inFlight = 0;
			let maxInFlight = 0;
			const signal = new CountingSignal();
			const results = await mapSettledWithConcurrency(
				[1, 2, 3, 4, 5],
				async function (n, _index, received) {
					expect(received).toBe(signal);
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await sleep(1);
					inFlight--;
					return n;
				},
				{ concurrency: 2, signal, stopOnError: true }
			);
			expect(maxInFlight).toBe(2);
			expect(results).toHaveLength(5);
		});

		it('rejects with the abort reason', async function () {
			const signal = new CountingSignal();
			const promise = mapSettledWithConcurrency(
				[1, 2],
				function () {
					return new Promise(function () {});
				},
				{ signal }
			);
			signal.abort('cancelled');
			await expect(promise).rejects.toBe('cancelled');
		});

		it('rejects with a TypeError when mapper is not a function', async function () {
			await expect(mapSettledWithConcurrency([1], 'x' as any)).rejects.toThrow(new TypeError('mapSettledWithConcurrency: `mapper` must be a function, got string'));
			await expect(mapSettledWithConcurrency([1], jest.fn(), -1)).rejects.toThrow(RangeError);
		});
	});

	describe('filterWithConcurrency', function () {
		it('does not read `items` when the signal is already aborted, like mapWithConcurrency', async function () {
			let pulled = 0;
			/**
			 * @yields {number} 0, 1 and 2, counting the reads
			 */
			function* counting(): Generator<number> {
				for (let i = 0; i < 3; i++) {
					pulled++;
					yield i;
				}
			}
			const controller = new AbortController();
			controller.abort(new AbortError('stopped'));
			await expect(
				filterWithConcurrency(
					counting(),
					function () {
						return true;
					},
					{ signal: controller.signal }
				)
			).rejects.toThrow('stopped');
			expect(pulled).toBe(0);
			// Array-likes are still accepted, as by Array.from.
			await expect(
				filterWithConcurrency({ length: 2, 0: 'a', 1: 'b' } as unknown as Iterable<string>, function (value) {
					return value === 'b';
				})
			).resolves.toEqual(['b']);
		});

		it('keeps the items whose (async) predicate is truthy, in input order', async function () {
			const result = await filterWithConcurrency(
				[5, 1, 4, 2, 3],
				async function (n) {
					await sleep(n);
					return n % 2 === 1 ? 'yes' : 0;
				},
				{ concurrency: 2 }
			);
			expect(result).toEqual([5, 1, 3]);
		});

		it('narrows with a type guard and accepts a positional concurrency', async function () {
			const values: Array<string | number> = ['a', 1, 'b'];
			const strings = await filterWithConcurrency(
				values,
				function (value): value is string {
					return typeof value === 'string';
				},
				1
			);
			const check: string[] = strings;
			expect(check).toEqual(['a', 'b']);
		});

		it('rejects with the first error, or the abort reason', async function () {
			await expect(
				filterWithConcurrency([1, 2], function (n) {
					if (n === 2) throw new Error('bad');
					return true;
				})
			).rejects.toThrow('bad');
			const signal = new CountingSignal();
			const promise = filterWithConcurrency(
				[1],
				function () {
					return new Promise<boolean>(function () {});
				},
				{ signal }
			);
			signal.abort('gone');
			await expect(promise).rejects.toBe('gone');
			expect(signal.listenerCount).toBe(0);
		});

		it('rejects with a TypeError naming the predicate', async function () {
			await expect(filterWithConcurrency([1], undefined as any)).rejects.toThrow(new TypeError('filterWithConcurrency: `predicate` must be a function, got undefined'));
		});
	});

	describe('createQueue', function () {
		it('types the signal a task receives after the queue and task signals', async function () {
			function platformOnly(signal: AbortSignal | undefined): number {
				return signal === undefined ? 0 : 1;
			}
			const { signal } = new AbortController();
			const results = await Promise.all([
				createQueue({ signal }).add(platformOnly),
				createQueue().add(platformOnly, { signal }),
				createQueue({ signal }).add(platformOnly, { signal: new AbortController().signal }),
				createQueue().add(platformOnly)
			]);
			expect(results).toEqual([1, 1, 1, 0]);
			// @ts-expect-error a custom signal is not a platform AbortSignal
			await createQueue({ signal: new CountingSignal() }).add(platformOnly);
		});

		it('runs tasks immediately while slots are free, and queues the rest', async function () {
			const queue = createQueue({ concurrency: 2 });
			const deferreds = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
			const started: number[] = [];
			const promises = deferreds.map(function (deferred, i) {
				return queue.add(function () {
					started.push(i);
					return deferred.promise;
				});
			});
			expect(started).toEqual([0, 1]);
			expect(queue.pending).toBe(2);
			expect(queue.size).toBe(1);
			deferreds[0].resolve('a');
			await flush();
			expect(started).toEqual([0, 1, 2]);
			deferreds[1].resolve('b');
			deferreds[2].resolve('c');
			await expect(Promise.all(promises)).resolves.toEqual(['a', 'b', 'c']);
			await queue.onIdle();
			expect(queue.pending).toBe(0);
		});

		it('starts higher priorities first and keeps FIFO order among equal priorities', async function () {
			const queue = createQueue({ concurrency: 1 });
			const order: string[] = [];
			function job(name: string): () => void {
				return function () {
					order.push(name);
				};
			}
			queue.pause();
			expect(queue.isPaused).toBe(true);
			queue.add(job('low-1'), { priority: -1 });
			queue.add(job('normal-1'));
			queue.add(job('high-1'), { priority: 5 });
			queue.add(job('normal-2'), { priority: 0 });
			queue.add(job('high-2'), { priority: 5 });
			queue.add(job('low-2'), { priority: -1 });
			queue.add(job('top'), { priority: Infinity });
			expect(queue.size).toBe(7);
			queue.resume();
			expect(queue.isPaused).toBe(false);
			await queue.onIdle();
			expect(order).toEqual(['top', 'high-1', 'high-2', 'normal-1', 'normal-2', 'low-1', 'low-2']);
		});

		it('defaults to unbounded concurrency', function () {
			const queue = createQueue();
			for (let i = 0; i < 5; i++)
				queue.add(function () {
					return new Promise(function () {});
				});
			expect(queue.pending).toBe(5);
			expect(queue.size).toBe(0);
		});

		it('does not let a task added from a running task jump ahead of waiting tasks', async function () {
			const queue = createQueue({ concurrency: 2 });
			const order: string[] = [];
			const gate = createDeferred<void>();
			queue.add(function () {
				return gate.promise;
			});
			queue.pause();
			queue.add(
				function () {
					order.push('waiting-high');
				},
				{ priority: 1 }
			);
			queue.resume();
			// The first slot is still busy; the second ran 'waiting-high' synchronously. Now fill both slots and queue more.
			const blocker = createDeferred<void>();
			queue.add(function () {
				queue.add(function () {
					order.push('nested');
				});
				return blocker.promise;
			});
			queue.add(
				function () {
					order.push('queued');
				},
				{ priority: 2 }
			);
			expect(order).toEqual(['waiting-high']);
			gate.resolve();
			await flush();
			blocker.resolve();
			await queue.onIdle();
			expect(order).toEqual(['waiting-high', 'queued', 'nested']);
		});

		it('turns synchronous throws into rejections and keeps going', async function () {
			const queue = createQueue({ concurrency: 1 });
			const failing = queue.add(function () {
				throw new Error('sync');
			});
			const next = queue.add(function () {
				return 'next';
			});
			await expect(failing).rejects.toThrow('sync');
			await expect(next).resolves.toBe('next');
		});

		it('onEmpty and onIdle resolve at once when idle, and can be awaited again', async function () {
			const queue = createQueue({ concurrency: 1 });
			await expect(queue.onEmpty()).resolves.toBeUndefined();
			await expect(queue.onIdle()).resolves.toBeUndefined();
			const first = createDeferred<void>();
			const second = createDeferred<void>();
			queue.add(function () {
				return first.promise;
			});
			queue.add(function () {
				return second.promise;
			});
			let empty = false;
			let idle = false;
			queue.onEmpty().then(function () {
				empty = true;
			});
			queue.onIdle().then(function () {
				idle = true;
			});
			first.resolve();
			await flush();
			expect(empty).toBe(true);
			expect(idle).toBe(false);
			second.resolve();
			await flush();
			expect(idle).toBe(true);
			// Re-armed
			const third = createDeferred<void>();
			queue.add(function () {
				return third.promise;
			});
			let idleAgain = false;
			queue.onIdle().then(function () {
				idleAgain = true;
			});
			await flush();
			expect(idleAgain).toBe(false);
			third.resolve();
			await flush();
			expect(idleAgain).toBe(true);
		});

		it('clear() rejects the waiting tasks with an AbortError and leaves running ones alone', async function () {
			const queue = createQueue({ concurrency: 1 });
			const running = createDeferred<string>();
			const first = queue.add(function () {
				return running.promise;
			});
			const signal = new CountingSignal();
			const task = jest.fn();
			const waiting = queue.add(task, { signal });
			expect(signal.listenerCount).toBe(1);
			let empty = false;
			queue.onEmpty().then(function () {
				empty = true;
			});
			queue.clear();
			await expect(waiting).rejects.toThrow(new AbortError('The task was removed from the queue.'));
			expect(empty).toBe(true);
			expect(signal.listenerCount).toBe(0);
			expect(queue.size).toBe(0);
			running.resolve('done');
			await expect(first).resolves.toBe('done');
			expect(task).not.toHaveBeenCalled();
		});

		it('removes a waiting task whose signal aborts: it never runs and its listener is gone', async function () {
			const queue = createQueue({ concurrency: 1 });
			const gate = createDeferred<void>();
			queue.add(function () {
				return gate.promise;
			});
			const signal = new CountingSignal();
			const task = jest.fn();
			const other = jest.fn(function () {
				return 'other';
			});
			const aborted = queue.add(task, { signal, priority: 9 });
			const kept = queue.add(other);
			let empty = false;
			queue.onEmpty().then(function () {
				empty = true;
			});
			signal.abort('not needed');
			await expect(aborted).rejects.toBe('not needed');
			expect(signal.listenerCount).toBe(0);
			expect(queue.size).toBe(1);
			expect(empty).toBe(false);
			gate.resolve();
			await expect(kept).resolves.toBe('other');
			expect(task).not.toHaveBeenCalled();
			expect(empty).toBe(true);
		});

		it('resolves onIdle when the last waiting task of a paused queue is aborted', async function () {
			const queue = createQueue();
			queue.pause();
			const signal = new CountingSignal();
			const task = queue.add(jest.fn(), { signal });
			let idle = false;
			queue.onIdle().then(function () {
				idle = true;
			});
			signal.abort();
			await expect(task).rejects.toBeInstanceOf(AbortError);
			await flush();
			expect(idle).toBe(true);
		});

		it('keeps the priority and FIFO orders when aborted tasks are dropped from the middle of the queue', async function () {
			const queue = createQueue({ concurrency: 1 });
			queue.pause();
			const order: string[] = [];
			const controllers = [new AbortController(), new AbortController()];
			const specs = [
				['a', 0, 0],
				['b', 1, 1],
				['c', 0, -1],
				['d', 2, 0],
				['e', 1, -1],
				['f', 0, 1],
				['g', 2, -1],
				['h', 1, 0]
			] as const;
			const tasks = specs.map(function ([name, priority, controller]) {
				return queue.add(
					function () {
						order.push(name);
					},
					{ priority, signal: controller < 0 ? undefined : controllers[controller].signal }
				);
			});
			controllers[0].abort();
			expect(queue.size).toBe(5);
			controllers[1].abort();
			expect(queue.size).toBe(3);
			tasks.push(
				queue.add(
					function () {
						order.push('i');
					},
					{ priority: 1 }
				)
			);
			queue.resume();
			const outcomes = await Promise.allSettled(tasks);
			expect(order).toEqual(['g', 'e', 'i', 'c']);
			expect(
				outcomes.map(function (outcome) {
					return outcome.status;
				})
			).toEqual(['rejected', 'rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
			expect(queue.size).toBe(0);
		});

		it('queues and aborts many tasks sharing a signal in linear time (previously quadratic: one listener each)', async function () {
			/**
			 * Times queuing 30,000 tasks on a paused queue, with or without a shared signal, then aborting them (or clearing the queue).
			 * @param {boolean} shared - Whether the tasks share a signal
			 * @returns {Promise<number>} The time in ms
			 */
			async function time(shared: boolean): Promise<number> {
				const queue = createQueue({ concurrency: 1 });
				const controller = new AbortController();
				const tasks: Array<Promise<unknown>> = [];
				const options = shared ? { signal: controller.signal } : {};
				queue.pause();
				const start = performance.now();
				for (let i = 0; i < 30_000; i++) tasks.push(queue.add(jest.fn(), { priority: i % 3, ...options }));
				if (shared) controller.abort();
				else queue.clear();
				const elapsed = performance.now() - start;
				expect(queue.size).toBe(0);
				await Promise.allSettled(tasks);
				return elapsed;
			}
			const alone = await time(false);
			// Quadratic, it took hundreds of times as long.
			expect(await time(true)).toBeLessThan(alone * 20 + 100);
		});

		it('rejects at once (without running) for an already-aborted task signal', async function () {
			const queue = createQueue();
			const signal = new CountingSignal();
			signal.abort('early');
			const task = jest.fn();
			await expect(queue.add(task, { signal })).rejects.toBe('early');
			expect(task).not.toHaveBeenCalled();
			expect(signal.listenerCount).toBe(0);
		});

		it('passes the task signal, the queue signal, or both combined to the task', async function () {
			const queueSignal = new CountingSignal();
			const queue = createQueue({ signal: queueSignal });
			const taskSignal = new CountingSignal();
			const received: Array<AbortSignalLike | undefined> = [];
			function record(signal: AbortSignalLike | undefined): void {
				received.push(signal);
			}
			await queue.add(record);
			expect(received[0]).toBe(queueSignal);
			const plain = createQueue();
			await plain.add(record);
			expect(received[1]).toBeUndefined();
			await plain.add(record, { signal: taskSignal });
			expect(received[2]).toBe(taskSignal);
			// Both: a combined signal, detached once the task settles.
			const gate = createDeferred<void>();
			const both = queue.add(
				function (signal) {
					record(signal);
					return gate.promise;
				},
				{ signal: taskSignal }
			);
			const combined = received[3] as AbortSignalLike;
			expect(combined).not.toBe(taskSignal);
			expect(combined).not.toBe(queueSignal);
			expect(taskSignal.listenerCount).toBe(1);
			// The combined signal's only: the queue listens to its own signal only while tasks wait.
			expect(queueSignal.listenerCount).toBe(1);
			queueSignal.abort('shutdown');
			expect(combined.aborted).toBe(true);
			expect(combined.reason).toBe('shutdown');
			gate.resolve();
			await both;
			await flush();
			expect(taskSignal.listenerCount).toBe(0);
		});

		it('detaches the combined signal after the task settles even when nothing aborted', async function () {
			const queueSignal = new CountingSignal();
			const taskSignal = new CountingSignal();
			const queue = createQueue({ signal: queueSignal });
			await queue.add(jest.fn(), { signal: taskSignal });
			await flush();
			expect(taskSignal.listenerCount).toBe(0);
			expect(queueSignal.listenerCount).toBe(0); // nothing waits: the queue does not listen either
		});

		it('aborting the queue signal rejects waiting tasks and later adds, but lets running tasks finish', async function () {
			await withoutUnhandledRejections(async function () {
				const controller = new AbortController();
				const queue = createQueue({ concurrency: 1, signal: controller.signal });
				const gate = createDeferred<string>();
				const running = queue.add(function () {
					return gate.promise;
				});
				const taskSignal = new CountingSignal();
				const waiting = queue.add(jest.fn(), { signal: taskSignal });
				const reason = new AbortError('queue closed');
				controller.abort(reason);
				await expect(waiting).rejects.toBe(reason);
				expect(taskSignal.listenerCount).toBe(0);
				await expect(queue.add(jest.fn())).rejects.toBe(reason);
				gate.resolve('finished');
				await expect(running).resolves.toBe('finished');
				await queue.onIdle();
			});
		});

		it('rejects every add when created with an aborted signal', async function () {
			const signal = new CountingSignal();
			signal.abort();
			const queue = createQueue({ signal });
			await expect(queue.add(jest.fn())).rejects.toBeInstanceOf(AbortError);
		});

		it('validates its arguments', async function () {
			expect(function () {
				createQueue({ concurrency: 0 });
			}).toThrow(new RangeError('createQueue: `concurrency` must be an integer >= 1 or Infinity, got 0'));
			expect(function () {
				createQueue({ signal: 1 as any });
			}).toThrow(new TypeError('createQueue: `signal` must be an AbortSignal, null or undefined, got number'));
			const queue = createQueue();
			await expect(queue.add(null as any)).rejects.toThrow(new TypeError('Queue.add: `task` must be a function, got null'));
			await expect(queue.add(jest.fn(), { priority: NaN })).rejects.toThrow(new RangeError('Queue.add: `priority` must be a number, got NaN'));
			await expect(queue.add(jest.fn(), { priority: '1' as any })).rejects.toThrow(new TypeError('Queue.add: `priority` must be a number, got string'));
			await expect(queue.add(jest.fn(), { signal: 'x' as any })).rejects.toThrow(TypeError);
		});
	});

	describe('createRateLimiter', function () {
		it('starts at most `limit` calls per sliding window, in FIFO order, without dropping any', async function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 2, interval: 100 });
			const starts: Array<[number, number]> = [];
			function call(id: number): number {
				starts.push([id, Date.now()]);
				return id;
			}
			const results = Promise.all(
				[1, 2, 3, 4, 5].map(function (id) {
					return limiter.schedule(call, id);
				})
			);
			expect(starts).toEqual([
				[1, 0],
				[2, 0]
			]);
			expect(limiter.pendingCount).toBe(3);
			expect(jest.getTimerCount()).toBe(1);
			await jest.advanceTimersByTimeAsync(250);
			expect(starts).toEqual([
				[1, 0],
				[2, 0],
				[3, 100],
				[4, 100],
				[5, 200]
			]);
			await expect(results).resolves.toEqual([1, 2, 3, 4, 5]);
			expect(limiter.pendingCount).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('uses a sliding window: no 2x burst across a window boundary', async function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 2, interval: 100 });
			const starts: number[] = [];
			function call(): void {
				starts.push(Date.now());
			}
			limiter.schedule(call);
			await jest.advanceTimersByTimeAsync(90);
			limiter.schedule(call);
			await jest.advanceTimersByTimeAsync(10);
			// t = 100: the start at 0 left the window, the one at 90 has not.
			limiter.schedule(call);
			limiter.schedule(call);
			expect(starts).toEqual([0, 90, 100]);
			await jest.advanceTimersByTimeAsync(89);
			expect(starts).toEqual([0, 90, 100]);
			await jest.advanceTimersByTimeAsync(1);
			expect(starts).toEqual([0, 90, 100, 190]);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('holds no timer while idle and starts immediately when allowed', function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 1, interval: 1000 });
			const fn = jest.fn();
			limiter.schedule(fn);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('picks up calls scheduled from a starting call without arming a second timer', async function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 2, interval: 100 });
			const order: string[] = [];
			limiter.schedule(function () {
				order.push('a');
				limiter.schedule(function () {
					order.push('nested');
				});
				limiter.schedule(function () {
					order.push('nested-2');
				});
			});
			expect(order).toEqual(['a', 'nested']);
			expect(jest.getTimerCount()).toBe(1);
			await jest.advanceTimersByTimeAsync(100);
			expect(order).toEqual(['a', 'nested', 'nested-2']);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('settles like the call: values, promises, sync throws and rejections', async function () {
			const limiter = createRateLimiter({ limit: 10, interval: 10 });
			await expect(
				limiter.schedule(
					function (a: number, b: number) {
						return a + b;
					},
					1,
					2
				)
			).resolves.toBe(3);
			await expect(
				limiter.schedule(function () {
					return Promise.resolve('async');
				})
			).resolves.toBe('async');
			await expect(
				limiter.schedule(function () {
					throw new Error('sync');
				})
			).rejects.toThrow('sync');
			await expect(
				limiter.schedule(function () {
					return Promise.reject(new Error('async'));
				})
			).rejects.toThrow('async');
		});

		it('wrap returns a rate-limited function that forwards this and arguments', async function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 1, interval: 50 });
			const counter = {
				base: 10,
				add: limiter.wrap(function (this: { base: number }, n: number): number {
					return this.base + n;
				})
			};
			const first = counter.add(1);
			const second = counter.add(2);
			await expect(first).resolves.toBe(11);
			await jest.advanceTimersByTimeAsync(50);
			await expect(second).resolves.toBe(12);
			expect(function () {
				limiter.wrap(5 as any);
			}).toThrow(new TypeError('RateLimiter.wrap: `fn` must be a function, got number'));
		});

		it('caps the wait at one interval when the clock goes backwards', async function () {
			jest.useFakeTimers({ now: 10_000 });
			const limiter = createRateLimiter({ limit: 1, interval: 100 });
			const starts: number[] = [];
			function call(): void {
				starts.push(Date.now());
			}
			limiter.schedule(call);
			jest.setSystemTime(0);
			limiter.schedule(call);
			await jest.advanceTimersByTimeAsync(99);
			expect(starts).toEqual([10_000]);
			await jest.advanceTimersByTimeAsync(1);
			expect(starts).toEqual([10_000, 100]);
		});

		it('aborting rejects the waiting calls with the reason, clears the timer and rejects later calls', async function () {
			jest.useFakeTimers({ now: 0 });
			const signal = new CountingSignal();
			const limiter = createRateLimiter({ limit: 1, interval: 1000, signal });
			const first = limiter.schedule(function () {
				return 'first';
			});
			const fn = jest.fn();
			const waiting = limiter.schedule(fn);
			expect(jest.getTimerCount()).toBe(1);
			signal.abort('stop');
			await expect(waiting).rejects.toBe('stop');
			await expect(first).resolves.toBe('first');
			expect(jest.getTimerCount()).toBe(0);
			expect(limiter.pendingCount).toBe(0);
			expect(signal.listenerCount).toBe(0);
			await expect(limiter.schedule(fn)).rejects.toBe('stop');
			expect(fn).not.toHaveBeenCalled();
		});

		it('clearQueue rejects the waiting calls with an AbortError and clears the timer', async function () {
			jest.useFakeTimers({ now: 0 });
			const limiter = createRateLimiter({ limit: 1, interval: 1000 });
			limiter.schedule(jest.fn());
			const waiting = limiter.schedule(jest.fn());
			const alsoWaiting = limiter.schedule(jest.fn());
			limiter.clearQueue();
			await expect(waiting).rejects.toThrow(new AbortError('The call was removed from the rate limiter queue.'));
			await expect(alsoWaiting).rejects.toBeInstanceOf(AbortError);
			expect(jest.getTimerCount()).toBe(0);
			// Still usable afterwards: the window still counts the first call.
			const fn = jest.fn();
			limiter.schedule(fn);
			expect(fn).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(1000);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('accepts an interval of 0 (no limiting)', function () {
			const limiter = createRateLimiter({ limit: 1, interval: 0 });
			const fn = jest.fn();
			limiter.schedule(fn);
			limiter.schedule(fn);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('validates its arguments', async function () {
			expect(function () {
				createRateLimiter(undefined as any);
			}).toThrow(new TypeError('createRateLimiter: `options` must be an object, got undefined'));
			expect(function () {
				createRateLimiter({ limit: 0, interval: 10 });
			}).toThrow(new RangeError('createRateLimiter: `limit` must be an integer >= 1, got 0'));
			expect(function () {
				createRateLimiter({ limit: Infinity, interval: 10 });
			}).toThrow(RangeError);
			expect(function () {
				createRateLimiter({ limit: 1, interval: -1 });
			}).toThrow(new RangeError('createRateLimiter: `interval` must be a number between 0 and 2147483647, got -1'));
			expect(function () {
				createRateLimiter({ limit: 1, interval: 10, signal: {} as any });
			}).toThrow(TypeError);
			await expect(createRateLimiter({ limit: 1, interval: 1 }).schedule(null as any)).rejects.toThrow(
				new TypeError('RateLimiter.schedule: `fn` must be a function, got null')
			);
		});
	});

	describe('memoizeAsync', function () {
		it('shares one in-flight call between concurrent callers and caches the value', async function () {
			const fn = jest.fn(async function (id: number) {
				await Promise.resolve();
				return { id };
			});
			const memo = memoizeAsync(fn);
			const a = memo(1);
			const b = memo(1);
			expect(a).toBe(b);
			const [first, second] = await Promise.all([a, b]);
			expect(first).toBe(second);
			expect(memo.cache.get(1)).toBe(first);
			await expect(memo(1)).resolves.toBe(first);
			await memo(2);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('never caches rejections or synchronous throws', async function () {
			await withoutUnhandledRejections(async function () {
				let calls = 0;
				const memo = memoizeAsync(function (n: number): Promise<number> | number {
					calls++;
					if (calls === 1) return Promise.reject(new Error('first'));
					if (calls === 2) throw new Error('second');
					return n;
				});
				const a = memo(1);
				const b = memo(1);
				await expect(a).rejects.toThrow('first');
				await expect(b).rejects.toThrow('first');
				await expect(memo(1)).rejects.toThrow('second');
				expect(memo.cache.has(1)).toBe(false);
				await expect(memo(1)).resolves.toBe(1);
				expect(calls).toBe(3);
			});
		});

		it('caches undefined results', async function () {
			const fn = jest.fn(async function () {
				return undefined;
			});
			const memo = memoizeAsync(fn);
			await memo();
			await expect(memo()).resolves.toBeUndefined();
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('expires values after ttl (backed by an LRU cache)', async function () {
			jest.useFakeTimers({ now: 0 });
			const fn = jest.fn(async function (key: string) {
				return `${key}@${Date.now()}`;
			});
			const memo = memoizeAsync(fn, { ttl: 1000 });
			await expect(memo('a')).resolves.toBe('a@0');
			jest.setSystemTime(999);
			await expect(memo('a')).resolves.toBe('a@0');
			jest.setSystemTime(1000);
			await expect(memo('a')).resolves.toBe('a@1000');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('uses a custom cache, passing the ttl to its set', async function () {
			jest.useFakeTimers({ now: 0 });
			const cache = createLRUCache<unknown, number>({ max: 2 });
			const set = jest.spyOn(cache, 'set');
			const memo = memoizeAsync(
				async function (n: number) {
					return n * 2;
				},
				{ cache, ttl: 50 }
			);
			await memo(1);
			await memo(2);
			await memo(3);
			expect(memo.cache).toBe(cache);
			expect(cache.size).toBe(2);
			expect(set).toHaveBeenCalledWith(3, 6, { ttl: 50 });
			jest.setSystemTime(50);
			expect(cache.has(3)).toBe(false);
			const map = new Map<unknown, number>();
			const plain = memoizeAsync(
				async function (n: number) {
					return n;
				},
				{ cache: map }
			);
			await plain(7);
			expect(map.get(7)).toBe(7);
		});

		it('uses the resolver (with this) for keys, and rejects when it throws', async function () {
			const memo = memoizeAsync(
				async function (this: { scope: string }, user: { id: number; name: string }) {
					return `${this.scope}:${user.name}`;
				},
				{
					resolver: function (this: { scope: string }, user) {
						return `${this.scope}/${user.id}`;
					}
				}
			);
			const context = { scope: 'admin', memo };
			await expect(context.memo({ id: 1, name: 'Ada' })).resolves.toBe('admin:Ada');
			await expect(context.memo({ id: 1, name: 'changed' })).resolves.toBe('admin:Ada');
			expect([...(memo.cache as Map<unknown, unknown>)].length).toBe(1);
			const failing = memoizeAsync(jest.fn(), {
				resolver: function () {
					throw new Error('bad key');
				}
			});
			await expect(failing()).rejects.toThrow('bad key');
		});

		it('delete() forwards this to the resolver, like a call (previously called it without this)', async function () {
			const memo = memoizeAsync(
				async function (this: { scope: string }, id: number) {
					return `${this.scope}:${id}`;
				},
				{
					resolver: function (this: { scope: string }, id) {
						return `${this.scope}/${id}`;
					}
				}
			);
			const admin = { scope: 'admin', memo };
			const guest = { scope: 'guest', memo };
			await admin.memo(1);
			await guest.memo(1);
			expect(admin.memo.delete.call(admin, 1)).toBe(true);
			expect([...(memo.cache as Map<unknown, unknown>).keys()]).toEqual(['guest/1']);
			expect(memo.delete.call(guest, 1)).toBe(true);
			expect(memo.cache.has('guest/1')).toBe(false);
		});

		it('clear() and delete() forget values and calls in flight (a cleared call does not write to the cache)', async function () {
			const gate = createDeferred<string>();
			const fn = jest.fn(function (key: string): Promise<string> | string {
				return key === 'slow' ? gate.promise : key;
			});
			const memo = memoizeAsync(fn);
			const slow = memo('slow');
			memo.clear();
			gate.resolve('stale');
			await expect(slow).resolves.toBe('stale');
			expect(memo.cache.has('slow')).toBe(false);
			await memo('fast');
			expect(memo.delete('fast')).toBe(true);
			expect(memo.delete('fast')).toBe(false);
			const again = createDeferred<string>();
			fn.mockImplementationOnce(function () {
				return again.promise;
			});
			const inflight = memo('x');
			expect(memo.delete('x')).toBe(true);
			expect(memo('x')).not.toBe(inflight);
			again.reject(new Error('ignored'));
			await expect(inflight).rejects.toThrow('ignored');
			await flush();
			expect(memo.cache.get('x')).toBe('x');
		});

		it('withSignal stops one caller waiting without cancelling the shared call', async function () {
			const gate = createDeferred<string>();
			const fn = jest.fn(function () {
				return gate.promise;
			});
			const memo = memoizeAsync(fn);
			const signal = new CountingSignal();
			const impatient = memo.withSignal(signal);
			const patient = memo();
			signal.abort('gave up');
			await expect(impatient).rejects.toBe('gave up');
			expect(signal.listenerCount).toBe(0);
			gate.resolve('value');
			await expect(patient).resolves.toBe('value');
			await expect(memo.withSignal(null)).resolves.toBe('value');
			await expect(memo()).resolves.toBe('value');
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('withSignal with an aborted signal rejects without calling the function, and validates the signal', async function () {
			const fn = jest.fn(async function (n: number) {
				return n;
			});
			const memo = memoizeAsync(fn);
			const signal = new CountingSignal();
			signal.abort();
			await expect(memo.withSignal(signal, 1)).rejects.toBeInstanceOf(AbortError);
			await expect(memo.withSignal({} as any, 1)).rejects.toThrow(new TypeError('memoizeAsync: `signal` must be an AbortSignal, null or undefined, got object'));
			expect(fn).not.toHaveBeenCalled();
			await expect(memo.withSignal(new CountingSignal(), 2)).resolves.toBe(2);
		});

		it('types the memoized function after the original', async function () {
			const memo = memoizeAsync(async function (a: number, b: string): Promise<string> {
				return `${a}${b}`;
			});
			const value: string = await memo(1, 'x');
			expect(value).toBe('1x');
			// @ts-expect-error wrong argument type
			await memo('1', 'x');
		});

		it('validates its arguments', function () {
			expect(function () {
				memoizeAsync(null as any);
			}).toThrow(new TypeError('memoizeAsync: `fn` must be a function, got null'));
			expect(function () {
				memoizeAsync(jest.fn(), { resolver: 1 as any });
			}).toThrow(new TypeError('memoizeAsync: `resolver` must be a function, got number'));
			expect(function () {
				memoizeAsync(jest.fn(), { ttl: 0 });
			}).toThrow(new RangeError('memoizeAsync: `ttl` must be a number > 0 or Infinity, got 0'));
			expect(function () {
				memoizeAsync(jest.fn(), { ttl: '5' as any });
			}).toThrow(TypeError);
		});
	});

	describe('anySignal (shared combinator)', function () {
		it('still aborts with the first aborted input and detaches the others', function () {
			const a = new CountingSignal();
			const b = new CountingSignal();
			const combined = anySignal([a, b]);
			expect(a.listenerCount).toBe(1);
			b.abort('b');
			expect(combined.reason).toBe('b');
			expect(a.listenerCount).toBe(0);
		});
	});
});

describe('Async helpers (hostile signals)', function () {
	/**
	 * A signal-like object whose methods can be made to throw.
	 */
	function hostile(overrides: Partial<Record<'addEventListener' | 'removeEventListener', () => void>> & { reason?: () => unknown } = {}): AbortSignalLike & {
		fire(): void;
		listeners: Array<() => void>;
	} {
		const listeners: Array<() => void> = [];
		const signal = {
			aborted: false,
			listeners,
			addEventListener:
				overrides.addEventListener ??
				function (_type: string, listener: () => void) {
					listeners.push(listener);
				},
			removeEventListener:
				overrides.removeEventListener ??
				function (_type: string, listener: () => void) {
					listeners.splice(listeners.indexOf(listener), 1);
				},
			fire(): void {
				signal.aborted = true;
				for (const listener of listeners.slice()) listener();
			}
		};
		if (overrides.reason !== undefined) Object.defineProperty(signal, 'reason', { get: overrides.reason });
		return signal as unknown as AbortSignalLike & { fire(): void; listeners: Array<() => void> };
	}

	function boom(): never {
		throw new Error('boom');
	}

	it('Queue.add: a task signal aborted after its start (its listener could not be removed) does not reject the running task', async function () {
		const signal = hostile({
			removeEventListener: function () {
				throw new Error('remove');
			}
		});
		const queue = createQueue({ concurrency: 1 });
		const first = createDeferred<void>();
		const second = createDeferred<string>();

		void queue.add(function () {
			return first.promise;
		});
		const task = queue.add(
			function () {
				return second.promise;
			},
			{ signal }
		);
		first.resolve();
		await sleep(0);
		expect(queue.pending).toBe(1);
		signal.fire();
		second.resolve('done');
		await expect(task).resolves.toBe('done');
		expect(queue.size).toBe(0);
	});

	it('createKeyedMutex: a request signal aborted after its grant does not unlock a key held again (previously forgot the key)', async function () {
		const signal = hostile({ removeEventListener: boom });
		const locks = createKeyedMutex<string>();
		const releaseFirst = await locks.acquire('k');
		const waiting = locks.acquire('k', { signal });
		releaseFirst();
		(await waiting)();
		const releaseSecond = await locks.acquire('k');
		signal.fire();
		expect(locks.isLocked('k')).toBe(true);
		expect(locks.tryAcquire('k')).toBeUndefined();
		releaseSecond();
		expect(locks.isLocked('k')).toBe(false);
		const pool = createSemaphore(1);
		const late = hostile({ removeEventListener: boom });
		const held = pool.tryAcquire() as () => void;
		const granted = pool.acquire({ signal: late });
		held();
		await expect(granted).resolves.toBeInstanceOf(Function);
		late.fire();
		expect(pool.available).toBe(0);
	});

	it('mapWithConcurrency: rejects when a callback returns a promise that cannot be awaited (previously stayed pending)', async function () {
		/**
		 * A promise whose `constructor` or `then` getter throws.
		 * @param {'constructor' | 'then'} key - The poisoned property
		 * @returns {Promise<number>} The promise
		 */
		function poisoned(key: 'constructor' | 'then'): Promise<number> {
			const promise = Promise.resolve(1);
			Object.defineProperty(promise, key, {
				get: function () {
					throw new Error(key);
				}
			});
			return promise;
		}
		await expect(
			mapWithConcurrency(
				[1, 2],
				function () {
					return poisoned('constructor');
				},
				1
			)
		).rejects.toThrow('constructor');
		const outcome = mapWithConcurrency(
			['constructor', 'then', 'ok'] as const,
			function (key) {
				return key === 'ok' ? 2 : poisoned(key);
			},
			{ concurrency: 1, stopOnError: false }
		);
		await expect(outcome).rejects.toMatchObject({ errors: [new Error('constructor'), new Error('then')] });
	});

	it('createSemaphore and createQueue: a signal aborting while its listener is added fails the request without leaking anything', async function () {
		/**
		 * A signal that aborts as soon as a listener is added, calling it at once.
		 * @returns {AbortSignalLike} The signal
		 */
		function abortingOnAdd(thenThrow = false): AbortSignalLike {
			const signal = {
				aborted: false,
				reason: 'stop',
				addEventListener: function (_type: string, listener: () => void) {
					signal.aborted = true;
					listener();
					if (thenThrow) throw new Error('add');
				},
				removeEventListener: jest.fn()
			};
			return signal;
		}
		jest.useFakeTimers();
		try {
			const pool = createSemaphore(1);
			const held = pool.tryAcquire() as () => void;
			await expect(pool.acquire({ signal: abortingOnAdd(), timeout: 1000 })).rejects.toBe('stop');
			await expect(pool.acquire({ signal: abortingOnAdd(true), timeout: 1000 })).rejects.toBe('stop');
			expect(pool.pending).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
			const queued = pool.acquire();
			expect(pool.pending).toBe(1);
			held();
			(await queued)();
			expect(pool.available).toBe(1);
			const queue = createQueue({ concurrency: 1 });
			queue.pause();
			const task = jest.fn();
			await expect(queue.add(task, { signal: abortingOnAdd() })).rejects.toBe('stop');
			expect(queue.size).toBe(0);
			queue.resume();
			await queue.onIdle();
			expect(task).not.toHaveBeenCalled();
		} finally {
			jest.useRealTimers();
		}
	});

	it('settles even when removeEventListener throws', async function () {
		const signal = hostile({ removeEventListener: boom });
		await expect(sleep(1, { signal })).resolves.toBeUndefined();
		await expect(abortable(Promise.resolve(1), signal)).resolves.toBe(1);
		await expect(mapWithConcurrency([1, 2], identity, { signal })).resolves.toEqual([1, 2]);
		await expect(pollUntil(constant(1), { signal })).resolves.toBe(1);
	});

	it('rejects with the error of a throwing reason getter', async function () {
		const signal = hostile({ reason: boom });
		const sleeping = sleep(1000, { signal });
		const queue = createQueue({ concurrency: 1 });
		const blocker = createDeferred<void>();
		void queue.add(function () {
			return blocker.promise;
		});
		const waiting = queue.add(constant(1), { signal });
		const mapped = mapWithConcurrency(
			[1, 2, 3],
			function () {
				return new Promise(function () {});
			},
			{ concurrency: 1, signal }
		);
		signal.fire();
		await expect(sleeping).rejects.toThrow('boom');
		await expect(waiting).rejects.toThrow('boom');
		await expect(mapped).rejects.toThrow('boom');
		blocker.resolve();
	});

	it('leaves no timer behind when addEventListener throws', async function () {
		const signal = hostile({ addEventListener: boom });
		const before = process.getActiveResourcesInfo().filter(isTimeout).length;
		await expect(sleep(5000, { signal })).rejects.toThrow('boom');
		await expect(pollUntil(constant(true), { timeout: 5000, signal })).rejects.toThrow('boom');
		expect(process.getActiveResourcesInfo().filter(isTimeout).length).toBe(before);
	});

	it('does not run a queued task whose add rejected, and keeps going when signals cannot be combined', async function () {
		const queue = createQueue({ concurrency: 1, signal: new AbortController().signal });
		const blocker = createDeferred<void>();
		void queue.add(function () {
			return blocker.promise;
		});
		const ran: string[] = [];
		const rejected = queue.add(
			function () {
				ran.push('rejected');
			},
			{ signal: hostile({ addEventListener: boom }) }
		);
		await expect(rejected).rejects.toThrow('boom');
		let calls = 0;
		const failing = queue.add(
			function () {
				ran.push('uncombined');
			},
			{
				signal: hostile({
					addEventListener: function () {
						if (++calls === 2) boom();
					}
				})
			}
		);
		const later = queue.add(function () {
			ran.push('later');
		});
		blocker.resolve();
		await expect(failing).rejects.toThrow('boom');
		await later;
		expect(ran).toEqual(['later']);
	});

	it('detaches the listeners already added when combining signals fails', function () {
		const first = hostile();
		expect(function () {
			anySignal([first, hostile({ addEventListener: boom })]);
		}).toThrow('boom');
		expect(first.listeners).toHaveLength(0);
	});

	it('rejects (never throws) for options whose reading throws, and validates in the same order as its siblings', async function () {
		const options = Object.defineProperty({}, 'concurrency', { get: boom });
		const result = mapWithConcurrency([1], identity, options);
		await expect(result).rejects.toThrow('boom');
		await expect(mapSettledWithConcurrency([], 'nope' as any, 0)).rejects.toBeInstanceOf(RangeError);
	});

	it('memoizeAsync resolves without an unhandled rejection when the cache cannot store', async function () {
		const cache = { get: constant(undefined), has: constant(false), set: boom, delete: constant(true), clear: function () {} };
		const memo = memoizeAsync(
			async function (n: number) {
				return n * 2;
			},
			{ cache: cache as any }
		);
		await expect(memo(2)).resolves.toBe(4);
	});

	function identity(value: number): number {
		return value;
	}

	function constant<T>(value: T): () => T {
		return function () {
			return value;
		};
	}

	function isTimeout(resource: string): boolean {
		return resource === 'Timeout';
	}
});

describe('createBatcher', function () {
	afterEach(function () {
		jest.useRealTimers();
	});

	/**
	 * A batch function that records its calls and maps each key to `value <key>`.
	 */
	function recorder<K = number>(): { calls: K[][]; batchLoad: (keys: K[]) => Promise<string[]> } {
		const calls: K[][] = [];
		return {
			calls,
			batchLoad: async function (keys: K[]): Promise<string[]> {
				calls.push(keys.slice());
				return keys.map(function (key) {
					return `value ${String(key)}`;
				});
			}
		};
	}

	function boom(): never {
		throw new Error('boom');
	}

	/** Waits until the batches opened so far are dispatched (by default, in a `process.nextTick` once the microtask queue drained). */
	function nextTurn(): Promise<void> {
		return new Promise(function (resolve) {
			setImmediate(resolve);
		});
	}

	describe('batching', function () {
		it('sends the keys requested in the same tick to one call, each key once, in first-request order', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const results = await Promise.all([batcher.load(3), batcher.load(1), batcher.load(3), batcher.load(2)]);
			expect(results).toEqual(['value 3', 'value 1', 'value 3', 'value 2']);
			expect(calls).toEqual([[3, 1, 2]]);
		});

		it('gives callers of one key the same value', async function () {
			const batcher = createBatcher(async function (keys: number[]) {
				return keys.map(function (key) {
					return { key };
				});
			});
			const [a, b] = await Promise.all([batcher.load(1), batcher.load(1)]);
			expect(a).toBe(b);
		});

		it('passes a new array to every call', async function () {
			const seen: number[][] = [];
			const batcher = createBatcher(function (keys: number[]) {
				seen.push(keys);
				const values = keys.slice();
				keys.length = 0;
				return values;
			});
			await expect(Promise.all([batcher.load(1), batcher.load(2)])).resolves.toEqual([1, 2]);
			await expect(batcher.load(3)).resolves.toBe(3);
			expect(seen[0]).not.toBe(seen[1]);
		});

		it('dispatches once the microtask queue has drained, not synchronously', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const pending = batcher.load(1);
			expect(calls).toEqual([]);
			await flush();
			expect(calls).toEqual([]);
			await nextTurn();
			expect(calls).toEqual([[1]]);
			await pending;
		});

		it('starts a new batch for keys requested after the dispatch', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			await batcher.load(1);
			await batcher.load(1);
			expect(calls).toEqual([[1], [1]]);
		});

		it('accepts a synchronous batch function', async function () {
			const batcher = createBatcher(function (keys: string[]) {
				return keys.map(function (key) {
					return key.length;
				});
			});
			await expect(batcher.loadMany(['a', 'bbb'])).resolves.toEqual([1, 3]);
		});

		it('accepts array-like results (typed arrays included) and reads holes as undefined', async function () {
			const arrayLike = createBatcher(function (keys: number[]) {
				return { length: keys.length, 0: 'zero', 1: 'one' } as ArrayLike<string>;
			});
			await expect(arrayLike.loadMany([0, 1])).resolves.toEqual(['zero', 'one']);
			const typed = createBatcher(function (keys: number[]) {
				return Float64Array.from(keys, Math.sqrt);
			});
			await expect(typed.loadMany([4, 9])).resolves.toEqual([2, 3]);
			// oxlint-disable-next-line no-sparse-arrays
			const holes = createBatcher(function (_keys: number[]) {
				return new Array<string>(2);
			});
			await expect(holes.loadMany([1, 2])).resolves.toEqual([undefined, undefined]);
		});

		it('reads holes as undefined, not as values planted on a polluted Object.prototype (previously handed out and cached)', async function () {
			const proto = Object.prototype as unknown as Record<number, unknown>;
			proto[1] = 'planted';
			try {
				const users = createBatcher(
					async function (keys: number[]) {
						const rows = new Array<string>(keys.length);
						rows[0] = 'ada';
						return rows;
					},
					{ cache: true }
				);
				await expect(users.loadMany([1, 2])).resolves.toEqual(['ada', undefined]);
				const arrayLike = createBatcher(function (keys: number[]) {
					return { length: keys.length, 0: 'zero' } as ArrayLike<string>;
				});
				await expect(arrayLike.loadMany([0, 1])).resolves.toEqual(['zero', undefined]);
			} finally {
				delete proto[1];
			}
			// Values inherited from another prototype (an array-like class) are read.
			class Pair {
				get length(): number {
					return 2;
				}
				get 1(): string {
					return 'inherited';
				}
			}
			const inherited = createBatcher(function (_keys: number[]) {
				return new Pair() as unknown as ArrayLike<string>;
			});
			await expect(inherited.loadMany([0, 1])).resolves.toEqual([undefined, 'inherited']);
		});

		it('compares keys with SameValueZero by default', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			await Promise.all([batcher.load(NaN), batcher.load(NaN), batcher.load(0), batcher.load(-0), batcher.load('0' as unknown as number)]);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toHaveLength(3);
			expect(calls[0][0]).toBeNaN();
			expect(calls[0].slice(1)).toEqual([0, '0']);
		});

		it('compares object keys by reference by default, and by the `key` function when given', async function () {
			const byReference = recorder<{ id: number }>();
			const batcher = createBatcher(byReference.batchLoad);
			await Promise.all([batcher.load({ id: 1 }), batcher.load({ id: 1 })]);
			expect(byReference.calls[0]).toHaveLength(2);

			const byId = recorder<{ id: number; tag: string }>();
			const keyed = createBatcher(byId.batchLoad, {
				key: function (key) {
					return key.id;
				}
			});
			const first = { id: 1, tag: 'first' };
			await Promise.all([keyed.load(first), keyed.load({ id: 1, tag: 'second' }), keyed.load({ id: 2, tag: 'third' })]);
			expect(byId.calls).toHaveLength(1);
			expect(byId.calls[0][0]).toBe(first);
			expect(byId.calls[0].map(String)).toHaveLength(2);
		});

		it('rejects the load when the `key` function throws, without affecting the batch', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, {
				key: function (key: number) {
					if (key < 0) throw new RangeError('negative');
					return key;
				}
			});
			const results = await Promise.allSettled([batcher.load(1), batcher.load(-1)]);
			expect(results[0]).toEqual({ status: 'fulfilled', value: 'value 1' });
			expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(RangeError);
			expect(calls).toEqual([[1]]);
		});

		it('handles a batch function that calls load itself (re-entrancy): those keys go to a new batch', async function () {
			const calls: number[][] = [];
			const nested: Array<Promise<number>> = [];
			const batcher = createBatcher(function (keys: number[]): number[] {
				calls.push(keys.slice());
				if (keys[0] === 1) nested.push(batcher.load(10), batcher.load(1));
				return keys.map(function (key) {
					return key * 2;
				});
			});
			await expect(batcher.load(1)).resolves.toBe(2);
			await expect(Promise.all(nested)).resolves.toEqual([20, 2]);
			expect(calls).toEqual([[1], [10, 1]]);
		});

		it('settles a batch that resolves late without mixing it with later batches', async function () {
			const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
			const batcher = createBatcher(async function (keys: number[]) {
				const gate = createDeferred<void>();
				gates.push(gate);
				await gate.promise;
				return keys.map(function (key) {
					return key + 0.5;
				});
			});
			const first = batcher.load(1);
			await nextTurn();
			const second = batcher.load(2);
			await nextTurn();
			expect(gates).toHaveLength(2);
			gates[1].resolve();
			await expect(second).resolves.toBe(2.5);
			expect(await stateOf(first)).toBe('pending');
			gates[0].resolve();
			await expect(first).resolves.toBe(1.5);
		});

		it('can be destructured (methods do not use `this`)', async function () {
			const { load, loadMany } = createBatcher(recorder().batchLoad);
			await expect(Promise.all([load(1), loadMany([2, 3])])).resolves.toEqual(['value 1', ['value 2', 'value 3']]);
		});
	});

	describe('delay and maxBatchSize', function () {
		it('collects keys requested after awaits when `delay` is set', async function () {
			jest.useFakeTimers();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { delay: 20 });
			const first = batcher.load(1);
			await flush();
			const second = batcher.load(2);
			jest.advanceTimersByTime(19);
			expect(calls).toEqual([]);
			jest.advanceTimersByTime(1);
			expect(calls).toEqual([[1, 2]]);
			await expect(Promise.all([first, second])).resolves.toEqual(['value 1', 'value 2']);
		});

		it('waits for a macrotask with `delay: 0`', async function () {
			const { calls, batchLoad } = recorder();
			// Fake timers: with real ones, a busy event loop can fire the `setTimeout(0)` before any `setImmediate` used to wait here.
			jest.useFakeTimers();
			const batcher = createBatcher(batchLoad, { delay: 0 });
			const first = batcher.load(1);
			await flush();
			expect(calls).toEqual([]);
			const second = batcher.load(2);
			jest.advanceTimersByTime(0);
			await expect(Promise.all([first, second])).resolves.toEqual(['value 1', 'value 2']);
			expect(calls).toEqual([[1, 2]]);
		});

		it('splits batches at maxBatchSize distinct keys', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { maxBatchSize: 2 });
			const results = await batcher.loadMany([1, 1, 2, 3, 2, 4, 5]);
			expect(results).toEqual(['value 1', 'value 1', 'value 2', 'value 3', 'value 2', 'value 4', 'value 5']);
			// A key listed twice is requested once, even once its batch is sealed.
			expect(calls).toEqual([[1, 2], [3, 4], [5]]);
		});

		it('dispatches a full batch without waiting for its delay', async function () {
			jest.useFakeTimers();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { delay: 1000, maxBatchSize: 2 });
			const all = batcher.loadMany([1, 2, 3]);
			await flush();
			expect(calls).toEqual([[1, 2]]);
			jest.advanceTimersByTime(1000);
			expect(calls).toEqual([[1, 2], [3]]);
			await expect(all).resolves.toEqual(['value 1', 'value 2', 'value 3']);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('accepts maxBatchSize: 1 (no batching, still deduplicated within a tick with a cache)', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { maxBatchSize: 1, cache: true });
			await batcher.loadMany([1, 2, 1]);
			expect(calls).toEqual([[1], [2]]);
		});
	});

	describe('errors', function () {
		it('rejects only the key whose value is an Error instance (other realms included)', async function () {
			const foreign: unknown = runInNewContext('new Error("foreign")');
			const batcher = createBatcher(async function (keys: number[]) {
				return keys.map(function (key) {
					return key === 2 ? new RangeError('no 2') : key === 3 ? (foreign as Error) : `ok ${key}`;
				});
			});
			const results = await Promise.allSettled([batcher.load(1), batcher.load(2), batcher.load(2), batcher.load(3)]);
			expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok 1' });
			expect((results[1] as PromiseRejectedResult).reason).toEqual(new RangeError('no 2'));
			expect((results[2] as PromiseRejectedResult).reason).toBe((results[1] as PromiseRejectedResult).reason);
			expect((results[3] as PromiseRejectedResult).reason).toBe(foreign);
		});

		it('rejects every key with the error of a batch function that throws synchronously or rejects', async function () {
			const error = new Error('db down');
			const throwing = createBatcher(function (_keys: number[]): number[] {
				throw error;
			});
			const rejecting = createBatcher(async function (_keys: number[]): Promise<number[]> {
				throw error;
			});
			for (const batcher of [throwing, rejecting]) {
				const results = await Promise.allSettled([batcher.load(1), batcher.load(2)]);
				expect(results).toEqual([
					{ status: 'rejected', reason: error },
					{ status: 'rejected', reason: error }
				]);
			}
		});

		it('rejects every key with a TypeError when the result has the wrong length', async function () {
			const short = createBatcher(async function (_keys: number[]) {
				return [1];
			});
			const results = await Promise.allSettled([short.load(1), short.load(2)]);
			for (const result of results) {
				expect((result as PromiseRejectedResult).reason).toEqual(
					new TypeError('createBatcher: `batchLoad` must return an array of 2 values (one per key), got 1 values')
				);
			}
			const long = createBatcher(async function (_keys: number[]) {
				return [1, 2];
			});
			await expect(long.load(1)).rejects.toThrow('must return an array of 1 values (one per key), got 2 values');
		});

		it.each([
			['undefined', undefined, 'got undefined'],
			['null', null, 'got null'],
			['a string', 'ab', 'got string'],
			['a number', 2, 'got number'],
			['a function with a length', function (_a: unknown, _b: unknown) {}, 'got function'],
			['a Map', new Map([[1, 'one']]), 'got object'],
			['an object with a non-numeric length', { length: '1', 0: 'x' }, 'got object']
		])('rejects every key with a TypeError when the result is %s', async function (_name, value, message) {
			const batcher = createBatcher(function (_keys: number[]) {
				return value as unknown as number[];
			});
			const results = await Promise.allSettled([batcher.load(1)]);
			expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeError);
			expect((results[0] as PromiseRejectedResult).reason.message).toContain(message);
		});

		it('rejects every key when reading the result throws (length or element getters), without resolving some keys first', async function () {
			const lengthThrows = createBatcher(function (_keys: number[]) {
				return {
					get length(): number {
						return boom();
					}
				} as ArrayLike<number>;
			});
			await expect(lengthThrows.load(1)).rejects.toThrow('boom');
			const elementThrows = createBatcher(function (_keys: number[]) {
				return new Proxy([1, 2], {
					get(target, property, receiver) {
						return property === '1' ? boom() : Reflect.get(target, property, receiver);
					}
				});
			});
			const results = await Promise.allSettled([elementThrows.load(1), elementThrows.load(2)]);
			expect(
				results.map(function (result) {
					return result.status;
				})
			).toEqual(['rejected', 'rejected']);
		});

		it('rejects every key when the result is a thenable whose `then` throws', async function () {
			const batcher = createBatcher(function (_keys: number[]) {
				return {
					get then(): never {
						return boom();
					}
				} as unknown as PromiseLike<number[]>;
			});
			await expect(batcher.load(1)).rejects.toThrow('boom');
		});

		it('keeps working after a failed batch', async function () {
			let fail = true;
			const batcher = createBatcher(async function (keys: number[]) {
				if (fail) throw new Error('first');
				return keys;
			});
			await expect(batcher.load(1)).rejects.toThrow('first');
			fail = false;
			await expect(batcher.load(1)).resolves.toBe(1);
		});
	});

	describe('cache', function () {
		it('requests keys again by default (no cache)', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			await batcher.load(1);
			batcher.prime(1, 'primed');
			batcher.clear(1);
			batcher.clearAll();
			await expect(batcher.load(1)).resolves.toBe('value 1');
			expect(calls).toEqual([[1], [1]]);
		});

		it('caches resolved values across batches with `cache: true`', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true });
			await batcher.loadMany([1, 2]);
			await expect(batcher.loadMany([2, 3, 1])).resolves.toEqual(['value 2', 'value 3', 'value 1']);
			expect(calls).toEqual([[1, 2], [3]]);
		});

		it('caches undefined values', async function () {
			let count = 0;
			const batcher = createBatcher(
				async function (keys: number[]) {
					count++;
					return keys.map(function () {
						return undefined;
					});
				},
				{ cache: true }
			);
			await batcher.load(1);
			await expect(batcher.load(1)).resolves.toBeUndefined();
			expect(count).toBe(1);
		});

		it('joins a request in flight instead of requesting the key again (single flight)', async function () {
			const gate = createDeferred<void>();
			const calls: number[][] = [];
			const batcher = createBatcher(
				async function (keys: number[]) {
					calls.push(keys.slice());
					await gate.promise;
					return keys;
				},
				{ cache: true }
			);
			const first = batcher.load(1);
			await nextTurn();
			const second = batcher.load(1);
			await nextTurn();
			gate.resolve();
			await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
			expect(calls).toEqual([[1]]);
		});

		it('never caches errors, so a failed key is requested again', async function () {
			const { calls, batchLoad } = recorder();
			let failing = true;
			const batcher = createBatcher(
				async function (keys: number[]) {
					if (failing)
						return keys.map(function () {
							return new Error('nope');
						});
					return batchLoad(keys);
				},
				{ cache: true }
			);
			await expect(batcher.load(1)).rejects.toThrow('nope');
			failing = false;
			await expect(batcher.load(1)).resolves.toBe('value 1');
			const throwing = createBatcher(
				async function (keys: number[]) {
					if (failing) throw new Error('down');
					return keys;
				},
				{ cache: true }
			);
			failing = true;
			await expect(throwing.load(1)).rejects.toThrow('down');
			failing = false;
			await expect(throwing.load(1)).resolves.toBe(1);
			expect(calls).toEqual([[1]]);
		});

		it('clear(key) and clearAll() forget cached values', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true });
			await batcher.loadMany([1, 2, 3]);
			batcher.clear(1);
			await batcher.loadMany([1, 2]);
			batcher.clearAll();
			await batcher.loadMany([2, 3]);
			expect(calls).toEqual([[1, 2, 3], [1], [2, 3]]);
		});

		it('clear(key) during a request in flight keeps its value out of the cache (callers still get it)', async function () {
			const gate = createDeferred<void>();
			let version = 0;
			const calls: number[][] = [];
			const batcher = createBatcher(
				async function (keys: number[]) {
					calls.push(keys.slice());
					const seen = version;
					if (calls.length === 1) await gate.promise;
					return keys.map(function (key) {
						return `${key}@${seen}`;
					});
				},
				{ cache: true }
			);
			const stale = batcher.load(1);
			await nextTurn();
			version = 1;
			batcher.clear(1);
			gate.resolve();
			await expect(stale).resolves.toBe('1@0');
			await expect(batcher.load(1)).resolves.toBe('1@1');
			await expect(batcher.load(1)).resolves.toBe('1@1');
			expect(calls).toEqual([[1], [1]]);
		});

		it('clearAll() during requests in flight keeps their values out of the cache', async function () {
			const { calls, batchLoad } = recorder();
			const gate = createDeferred<void>();
			const batcher = createBatcher(
				async function (keys: number[]) {
					await gate.promise;
					return batchLoad(keys);
				},
				{ cache: true }
			);
			const loading = batcher.loadMany([1, 2]);
			await nextTurn();
			batcher.clearAll();
			gate.resolve();
			await loading;
			await batcher.loadMany([1, 2]);
			expect(calls).toEqual([
				[1, 2],
				[1, 2]
			]);
		});

		it('clear(key) before the dispatch still caches the value (a request not sent yet is not stale)', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true });
			const loading = batcher.load(1);
			batcher.clear(1);
			batcher.clearAll();
			await loading;
			await batcher.load(1);
			expect(calls).toEqual([[1]]);
		});

		it('prime(key, value) stores a value, and wins over a request in flight', async function () {
			const gate = createDeferred<void>();
			const calls: number[][] = [];
			const batcher = createBatcher(
				async function (keys: number[]) {
					calls.push(keys.slice());
					await gate.promise;
					return keys.map(function (key) {
						return `fetched ${key}`;
					});
				},
				{ cache: true }
			);
			batcher.prime(1, 'primed 1');
			await expect(batcher.load(1)).resolves.toBe('primed 1');
			const inflight = batcher.load(2);
			await nextTurn();
			batcher.prime(2, 'primed 2');
			gate.resolve();
			await expect(inflight).resolves.toBe('fetched 2');
			await expect(batcher.load(2)).resolves.toBe('primed 2');
			expect(calls).toEqual([[2]]);
		});

		it('prime rejects Error values', function () {
			const batcher = createBatcher(recorder().batchLoad, { cache: true });
			expect(function () {
				batcher.prime(1, new Error('x') as unknown as string);
			}).toThrow(new TypeError('Batcher.prime: `value` must not be an Error (errors are never cached)'));
			expect(function () {
				createBatcher(recorder().batchLoad).prime(1, new Error('x') as unknown as string);
			}).toThrow(TypeError);
		});

		it('uses the key identity for the cache', async function () {
			const { calls, batchLoad } = recorder<{ id: number }>();
			const batcher = createBatcher(batchLoad, {
				cache: true,
				key: function (key) {
					return key.id;
				}
			});
			await batcher.load({ id: 1 });
			await batcher.load({ id: 1 });
			batcher.prime({ id: 2 }, 'two');
			await expect(batcher.load({ id: 2 })).resolves.toBe('two');
			batcher.clear({ id: 1 });
			await batcher.load({ id: 1 });
			expect(calls).toHaveLength(2);
		});

		it('accepts a Map-like store such as an LRU cache, with its eviction and expiry', async function () {
			let now = 0;
			const store = createLRUCache<unknown, string>({
				max: 2,
				ttl: 100,
				now: function () {
					return now;
				}
			});
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: store });
			await batcher.loadMany([1, 2, 3]);
			expect(Array.from(store.keys()).sort()).toEqual([2, 3]);
			await batcher.load(1);
			now = 1000;
			await batcher.load(1);
			expect(calls).toEqual([[1, 2, 3], [1], [1]]);
		});

		it('rejects the load when the cache throws on read, and ignores a cache that cannot store', async function () {
			const readFails = { get: boom, has: boom, set: boom, delete: boom, clear: boom };
			await expect(createBatcher(recorder().batchLoad, { cache: readFails }).load(1)).rejects.toThrow('boom');
			const writeFails = {
				get: function (): undefined {
					return undefined;
				},
				has: function () {
					return false;
				},
				set: boom,
				delete: boom,
				clear: boom
			};
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: writeFails });
			await expect(batcher.load(1)).resolves.toBe('value 1');
			await expect(batcher.load(1)).resolves.toBe('value 1');
			expect(calls).toEqual([[1], [1]]);
			expect(function () {
				batcher.clear(1);
			}).toThrow('boom');
			expect(function () {
				batcher.prime(1, 'x');
			}).toThrow('boom');
		});
	});

	describe('signal', function () {
		it('rejects at once for an already-aborted signal, without requesting the key', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true });
			batcher.prime(1, 'cached');
			const controller = new AbortController();
			controller.abort();
			await expect(batcher.load(1, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
			await expect(batcher.load(2, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
			await nextTurn();
			expect(calls).toEqual([]);
		});

		it('removes a key nobody else waits for from a batch not dispatched yet', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const controller = new AbortController();
			const aborted = batcher.load(1, { signal: controller.signal });
			const kept = batcher.load(2);
			controller.abort(new AbortError('gone'));
			await expect(aborted).rejects.toThrow('gone');
			await expect(kept).resolves.toBe('value 2');
			expect(calls).toEqual([[2]]);
		});

		it('keeps a key other callers still wait for', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const controller = new AbortController();
			const aborted = batcher.load(1, { signal: controller.signal });
			const kept = batcher.load(1);
			controller.abort();
			await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
			await expect(kept).resolves.toBe('value 1');
			expect(calls).toEqual([[1]]);
		});

		it('does not call the batch function when every key left the batch', async function () {
			jest.useFakeTimers();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { delay: 10 });
			const controller = new AbortController();
			const loads = batcher.loadMany([1, 2], { signal: controller.signal });
			controller.abort();
			await expect(loads).rejects.toMatchObject({ name: 'AbortError' });
			jest.advanceTimersByTime(10);
			await flush();
			expect(calls).toEqual([]);
			const microtask = createBatcher(batchLoad);
			const other = new AbortController();
			const load = microtask.load(1, { signal: other.signal });
			other.abort();
			await expect(load).rejects.toMatchObject({ name: 'AbortError' });
			await flush();
			expect(calls).toEqual([]);
		});

		it('clears the delay timer of a batch every key left, and opens a new batch for the next key (previously kept the timer)', async function () {
			jest.useFakeTimers();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { delay: 1000, cache: true });
			const controller = new AbortController();
			const aborted = batcher.load(1, { signal: controller.signal });
			controller.abort();
			await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
			expect(jest.getTimerCount()).toBe(0);
			const primed = batcher.load(2);
			batcher.prime(2, 'primed');
			await expect(primed).resolves.toBe('primed');
			expect(jest.getTimerCount()).toBe(0);
			const later = batcher.load(3);
			jest.advanceTimersByTime(999);
			await flush();
			expect(calls).toEqual([]);
			jest.advanceTimersByTime(1);
			await expect(later).resolves.toBe('value 3');
			expect(calls).toEqual([[3]]);
		});

		it('removes an aborted key from the requests in flight of a cache, so it is requested next time', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true, delay: 0 });
			const controller = new AbortController();
			const aborted = batcher.load(1, { signal: controller.signal });
			controller.abort();
			await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
			await expect(batcher.load(1)).resolves.toBe('value 1');
			expect(calls).toEqual([[1]]);
		});

		it('only stops waiting once the batch is dispatched: other callers and the cache still get the value', async function () {
			const gate = createDeferred<void>();
			const calls: number[][] = [];
			const batcher = createBatcher(
				async function (keys: number[]) {
					calls.push(keys.slice());
					await gate.promise;
					return keys;
				},
				{ cache: true }
			);
			const controller = new AbortController();
			const aborted = batcher.load(1, { signal: controller.signal });
			const kept = batcher.load(1);
			await nextTurn();
			controller.abort();
			await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
			gate.resolve();
			await expect(kept).resolves.toBe(1);
			await expect(batcher.load(1)).resolves.toBe(1);
			expect(calls).toEqual([[1]]);
		});

		it('removes its listener once the load settles (resolved or rejected)', async function () {
			const signal = new CountingSignal();
			const batcher = createBatcher(async function (keys: number[]) {
				return keys.map(function (key) {
					return key > 0 ? key : new Error('negative');
				});
			});
			await expect(batcher.load(1, { signal })).resolves.toBe(1);
			await expect(batcher.load(-1, { signal })).rejects.toThrow('negative');
			expect(signal.listenerCount).toBe(0);
			await expect(batcher.loadMany([1, 2, 3], { signal: null })).resolves.toEqual([1, 2, 3]);
		});

		it('rejects with a TypeError for an invalid signal', async function () {
			const batcher = createBatcher(recorder().batchLoad);
			await expect(batcher.load(1, { signal: {} as AbortSignalLike })).rejects.toThrow(
				new TypeError('Batcher.load: `signal` must be an AbortSignal, null or undefined, got object')
			);
		});

		it('survives hostile signals', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const addThrows = { aborted: false, addEventListener: boom, removeEventListener: function () {} };
			await expect(batcher.load(1, { signal: addThrows })).rejects.toThrow('boom');
			const callsAtOnce = {
				aborted: false,
				reason: 'sync abort',
				addEventListener: function (_type: string, listener: () => void) {
					listener();
				},
				removeEventListener: function () {}
			};
			await expect(batcher.load(2, { signal: callsAtOnce })).rejects.toBe('sync abort');
			const removeThrows = { aborted: false, addEventListener: function () {}, removeEventListener: boom };
			await expect(batcher.load(3, { signal: removeThrows })).resolves.toBe('value 3');
			const listeners: Array<() => void> = [];
			const reasonThrows = {
				aborted: false,
				get reason(): unknown {
					return boom();
				},
				addEventListener: function (_type: string, listener: () => void) {
					listeners.push(listener);
				},
				removeEventListener: boom
			};
			const late = batcher.load(4, { signal: reasonThrows });
			listeners[0]();
			await expect(late).rejects.toThrow('boom');
			// A listener left behind by a throwing `removeEventListener` is harmless when it fires after the load settled.
			const settled = batcher.load(5, { signal: reasonThrows });
			await expect(settled).resolves.toBe('value 5');
			listeners[1]();
			expect(calls).toEqual([[3], [5]]);
		});

		it('counts a caller once when a hostile signal calls its listener twice, or calls it and then throws', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const twice = {
				aborted: false,
				reason: 'twice',
				addEventListener: function (_type: string, listener: () => void) {
					listener();
					listener();
				},
				removeEventListener: function () {}
			};
			const callThenThrow = {
				aborted: false,
				reason: 'first',
				addEventListener: function (_type: string, listener: () => void) {
					listener();
					throw new Error('then throws');
				},
				removeEventListener: function () {}
			};
			const kept = batcher.load(1);
			await expect(batcher.load(1, { signal: twice })).rejects.toBe('twice');
			await expect(batcher.load(1, { signal: callThenThrow })).rejects.toBe('first');
			await expect(kept).resolves.toBe('value 1');
			expect(calls).toEqual([[1]]);
		});
	});

	describe('loadMany', function () {
		it('resolves in key order and rejects like Promise.all', async function () {
			const batcher = createBatcher(async function (keys: number[]) {
				return keys.map(function (key) {
					return key === 0 ? new RangeError('zero') : 10 / key;
				});
			});
			await expect(batcher.loadMany([1, 2, 5])).resolves.toEqual([10, 5, 2]);
			await expect(batcher.loadMany([])).resolves.toEqual([]);
			await expect(batcher.loadMany(new Set([2, 0]))).rejects.toBeInstanceOf(RangeError);
		});

		it('rejects with a TypeError for a non-iterable, and with the error of a throwing iterator', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			await expect(batcher.loadMany(null as unknown as number[])).rejects.toThrow(new TypeError('Batcher.loadMany: `keys` must be an iterable, got null'));
			await expect(batcher.loadMany(undefined as unknown as number[])).rejects.toThrow('got undefined');
			await expect(batcher.loadMany({ length: 1, 0: 1 } as unknown as number[])).rejects.toThrow('got object');
			const throwing = (function* () {
				yield 1;
				boom();
			})();
			await expect(batcher.loadMany(throwing)).rejects.toThrow('boom');
			await nextTurn();
			expect(calls).toEqual([]);
		});
	});

	describe('argument validation', function () {
		it('rejects invalid arguments with the library message format', function () {
			const { batchLoad } = recorder();
			expect(function () {
				createBatcher(42 as unknown as typeof batchLoad);
			}).toThrow(new TypeError('createBatcher: `batchLoad` must be a function, got number'));
			expect(function () {
				createBatcher(batchLoad, { delay: -1 });
			}).toThrow(RangeError);
			expect(function () {
				createBatcher(batchLoad, { delay: '5' as unknown as number });
			}).toThrow(TypeError);
			expect(function () {
				createBatcher(batchLoad, { delay: NaN });
			}).toThrow(RangeError);
			expect(function () {
				createBatcher(batchLoad, { maxBatchSize: 0 });
			}).toThrow(new RangeError('createBatcher: `maxBatchSize` must be an integer >= 1 or Infinity, got 0'));
			expect(function () {
				createBatcher(batchLoad, { maxBatchSize: 1.5 });
			}).toThrow(RangeError);
			expect(function () {
				createBatcher(batchLoad, { key: 'id' as unknown as () => unknown });
			}).toThrow(new TypeError('createBatcher: `key` must be a function, got string'));
			expect(function () {
				createBatcher(batchLoad, { cache: {} as Map<unknown, string> });
			}).toThrow(new TypeError('createBatcher: `cache` must be a boolean or a Map-like cache, got object'));
			expect(function () {
				createBatcher(batchLoad, { cache: null as unknown as boolean });
			}).toThrow('got null');
			expect(function () {
				createBatcher(batchLoad, { cache: 1 as unknown as boolean });
			}).toThrow('got number');
		});

		it('accepts Infinity for maxBatchSize and the largest timer delay', function () {
			const { batchLoad } = recorder();
			expect(createBatcher(batchLoad, { maxBatchSize: Infinity, delay: 2 ** 31 - 1, cache: false })).toBeDefined();
			expect(createBatcher(batchLoad, { cache: new Map() })).toBeDefined();
		});
	});

	describe('review regressions', function () {
		it('adds one abort listener per signal, however many keys wait on it, and removes it once none does', async function () {
			const signal = new CountingSignal();
			const batcher = createBatcher(function (keys: number[]) {
				return keys;
			});
			const loading = batcher.loadMany([1, 2, 3], { signal });
			const single = batcher.load(4, { signal });
			expect(signal.listenerCount).toBe(1);
			await expect(Promise.all([loading, single])).resolves.toEqual([[1, 2, 3], 4]);
			expect(signal.listenerCount).toBe(0);
		});

		it('stays linear for a loadMany of 40,000 keys sharing a signal, and for aborting them all', async function () {
			const batcher = createBatcher(function (keys: number[]) {
				return keys;
			});
			const keys = Array.from({ length: 40_000 }, function (_, index) {
				return index;
			});
			const controller = new AbortController();
			let start = performance.now();
			await expect(batcher.loadMany(keys, { signal: controller.signal })).resolves.toHaveLength(40_000);
			expect(performance.now() - start).toBeLessThan(2000);
			start = performance.now();
			const aborted = batcher.loadMany(keys, { signal: controller.signal });
			controller.abort(new AbortError('stop'));
			await expect(aborted).rejects.toThrow('stop');
			expect(performance.now() - start).toBeLessThan(2000);
		});

		it('batches keys requested after any number of awaits in the same tick (like DataLoader)', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			async function resolver(awaits: number, key: number): Promise<string> {
				for (let i = 0; i < awaits; i++) await null;
				return batcher.load(key);
			}
			await expect(Promise.all([0, 1, 2, 3, 15].map(resolver))).resolves.toEqual(['value 0', 'value 1', 'value 2', 'value 3', 'value 4']);
			expect(calls).toEqual([[0, 1, 2, 3, 4]]);
		});

		it.each([
			['no process.nextTick', { value: undefined, configurable: true, writable: true }],
			['a process.nextTick that cannot be read', { get: boom, configurable: true }]
		])('falls back to a setTimeout(0) with %s, still after the microtask queue drained', async function (_name, descriptor) {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad);
			const original = Object.getOwnPropertyDescriptor(process, 'nextTick') as PropertyDescriptor;
			let results: Promise<string[]>;
			Object.defineProperty(process, 'nextTick', descriptor);
			try {
				results = Promise.all(
					[0, 1, 2].map(async function (awaits) {
						for (let i = 0; i < awaits; i++) await null;
						return batcher.load(awaits);
					})
				);
				await flush();
			} finally {
				Object.defineProperty(process, 'nextTick', original);
			}
			expect(calls).toEqual([]);
			await expect(results).resolves.toEqual(['value 0', 'value 1', 'value 2']);
			expect(calls).toEqual([[0, 1, 2]]);
		});

		it('prime answers the callers of a key not dispatched yet with the primed value, and drops the key from the batch', async function () {
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, { cache: true });
			const primed = batcher.load(1);
			const fetched = batcher.load(2);
			batcher.prime(1, 'primed 1');
			await expect(Promise.all([primed, fetched])).resolves.toEqual(['primed 1', 'value 2']);
			await expect(batcher.load(1)).resolves.toBe('primed 1');
			expect(calls).toEqual([[2]]);
			// Every key primed: the batch function is not called at all.
			const only = batcher.load(3);
			batcher.prime(3, 'primed 3');
			await expect(only).resolves.toBe('primed 3');
			await nextTurn();
			expect(calls).toEqual([[2]]);
		});

		it('an abort right after prime does not remove another entry of the key from the batch', async function () {
			const { calls, batchLoad } = recorder();
			const store = new Map<unknown, string>();
			const batcher = createBatcher(batchLoad, { cache: store });
			const controller = new AbortController();
			const first = batcher.load(1, { signal: controller.signal });
			batcher.prime(1, 'primed');
			// The cache drops the primed value: a new caller opens a new entry for the key, in the same batch.
			store.clear();
			const second = batcher.load(1);
			controller.abort(new AbortError('late'));
			await expect(first).rejects.toThrow('late');
			await expect(second).resolves.toBe('value 1');
			expect(calls).toEqual([[1]]);
		});

		it('works with a polluted Object.prototype.then (no internal object is resolved like a promise)', async function () {
			const batcher = createBatcher(function (keys: number[]) {
				return keys.map(function (key) {
					return key * 2;
				});
			});
			Object.defineProperty(Object.prototype, 'then', { value: function () {}, configurable: true, writable: true });
			let result: Promise<number>;
			try {
				result = withTimeout(batcher.load(21), 1000);
				await nextTurn();
			} finally {
				delete (Object.prototype as { then?: unknown }).then;
			}
			await expect(result).resolves.toBe(42);
		});

		it('validates the options of createBatcher, load and loadMany with library errors, reading the signal once', async function () {
			const { batchLoad } = recorder();
			expect(function () {
				createBatcher(batchLoad, null as unknown as object);
			}).toThrow(new TypeError('createBatcher: `options` must be an object, got null'));
			const batcher = createBatcher(batchLoad);
			await expect(batcher.load(1, null as unknown as object)).rejects.toThrow(new TypeError('Batcher.load: `options` must be an object, got null'));
			await expect(batcher.loadMany([1], 'x' as unknown as object)).rejects.toThrow(new TypeError('Batcher.loadMany: `options` must be an object, got string'));
			await expect(batcher.loadMany([1], { signal: {} as AbortSignalLike })).rejects.toThrow(
				new TypeError('Batcher.loadMany: `signal` must be an AbortSignal, null or undefined, got object')
			);
			let reads = 0;
			const options = {
				get signal(): AbortSignalLike {
					reads++;
					return new CountingSignal();
				}
			};
			await expect(batcher.loadMany([1, 2, 3], options)).resolves.toEqual(['value 1', 'value 2', 'value 3']);
			expect(reads).toBe(1);
		});

		it('rejects a loadMany with an aborted signal without calling the key function, like load', async function () {
			const controller = new AbortController();
			controller.abort(new AbortError('already aborted'));
			const key = jest.fn(function (value: number) {
				return value;
			});
			const batcher = createBatcher(recorder().batchLoad, { key });
			await expect(batcher.loadMany([1, 2], { signal: controller.signal })).rejects.toThrow('already aborted');
			await expect(batcher.load(1, { signal: controller.signal })).rejects.toThrow('already aborted');
			expect(key).not.toHaveBeenCalled();
		});

		it('rejects a load whose key function aborts its signal, without requesting the key', async function () {
			const controller = new AbortController();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, {
				key: function (key: number) {
					controller.abort(new AbortError('aborted by the key function'));
					return key;
				}
			});
			await expect(batcher.load(1, { signal: controller.signal })).rejects.toThrow('aborted by the key function');
			await nextTurn();
			expect(calls).toEqual([]);
		});

		it('rejects the remaining keys of a loadMany whose key function aborts the signal', async function () {
			const controller = new AbortController();
			const { calls, batchLoad } = recorder();
			const batcher = createBatcher(batchLoad, {
				key: function (key: number) {
					if (key === 2) controller.abort(new AbortError('aborted by key 2'));
					return key;
				}
			});
			await expect(batcher.loadMany([1, 2, 3], { signal: controller.signal })).rejects.toThrow('aborted by key 2');
			await nextTurn();
			expect(calls).toEqual([]);
		});
	});
});

describe('Async helpers (locks, events, reduceAsync, minDelay)', function () {
	function constant<T>(value: T): () => T {
		return function () {
			return value;
		};
	}

	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('createSemaphore', function () {
		it('validates permits', function () {
			expect(function () {
				createSemaphore('2' as any);
			}).toThrow(new TypeError('createSemaphore: `permits` must be an integer >= 1 or Infinity, got string'));
			for (const permits of [0, -1, 1.5, NaN, -Infinity]) {
				expect(function () {
					createSemaphore(permits);
				}).toThrow(RangeError);
			}
			expect(function () {
				createSemaphore(0);
			}).toThrow('createSemaphore: `permits` must be an integer >= 1 or Infinity, got 0');
			expect(createSemaphore(Infinity).available).toBe(Infinity);
		});

		it('grants available permits at once and counts them', async function () {
			const semaphore = createSemaphore(3);
			expect(semaphore.available).toBe(3);
			const first = await semaphore.acquire();
			const second = await semaphore.acquire({ weight: 2 });
			expect(semaphore.available).toBe(0);
			expect(semaphore.pending).toBe(0);
			first();
			expect(semaphore.available).toBe(1);
			second();
			expect(semaphore.available).toBe(3);
		});

		it('ignores a second call of the same release function', async function () {
			const semaphore = createSemaphore(2);
			const a = await semaphore.acquire();
			const b = await semaphore.acquire();
			a();
			a();
			a();
			expect(semaphore.available).toBe(1);
			// The extra calls did not hand b's permit to anybody.
			const waiting = semaphore.acquire({ weight: 2 });
			expect(semaphore.pending).toBe(1);
			b();
			b();
			const both = await waiting;
			expect(semaphore.available).toBe(0);
			both();
			expect(semaphore.available).toBe(2);
		});

		it('grants waiting requests in FIFO order, handing a released permit straight to the first waiter', async function () {
			const semaphore = createSemaphore(1);
			const order: number[] = [];
			const release = semaphore.tryAcquire() as Release;
			const requests = [1, 2, 3].map(function (n) {
				return semaphore.acquire().then(function (done) {
					order.push(n);
					return done;
				});
			});
			expect(semaphore.pending).toBe(3);
			release();
			// The permit already belongs to request 1: nothing can take it in between.
			expect(semaphore.available).toBe(0);
			expect(semaphore.pending).toBe(2);
			expect(semaphore.tryAcquire()).toBeUndefined();
			(await requests[0])();
			(await requests[1])();
			(await requests[2])();
			expect(order).toEqual([1, 2, 3]);
			expect(semaphore.available).toBe(1);
		});

		it('never lets tryAcquire jump the queue', async function () {
			const semaphore = createSemaphore(3);
			const big = semaphore.tryAcquire(2) as Release;
			const waiting = semaphore.acquire({ weight: 2 });
			expect(semaphore.available).toBe(1);
			expect(semaphore.tryAcquire()).toBeUndefined();
			big();
			const release = await waiting;
			expect(semaphore.tryAcquire()).toBeInstanceOf(Function);
			expect(semaphore.available).toBe(0);
			release();
		});

		it('does not let lighter requests overtake a heavy one at the head of the queue', async function () {
			const semaphore = createSemaphore(4);
			const order: string[] = [];
			const holder = semaphore.tryAcquire(3) as Release;
			const heavy = semaphore.acquire({ weight: 4 }).then(function (release) {
				order.push('heavy');
				return release;
			});
			const light = semaphore.acquire({ weight: 1 }).then(function (release) {
				order.push('light');
				return release;
			});
			await Promise.resolve();
			expect(order).toEqual([]);
			expect(semaphore.pending).toBe(2);
			holder();
			(await heavy)();
			(await light)();
			expect(order).toEqual(['heavy', 'light']);
		});

		it('serves the requests behind an aborted head request that now fit', async function () {
			const semaphore = createSemaphore(4);
			const holder = semaphore.tryAcquire(3) as Release;
			const controller = new AbortController();
			const heavy = semaphore.acquire({ weight: 4, signal: controller.signal });
			const light = semaphore.acquire({ weight: 1 });
			expect(semaphore.pending).toBe(2);
			controller.abort('changed my mind');
			expect(semaphore.pending).toBe(0);
			await expect(heavy).rejects.toBe('changed my mind');
			const release = await light;
			expect(semaphore.available).toBe(0);
			release();
			holder();
			expect(semaphore.available).toBe(4);
		});

		it('removes an aborted waiter at once, with its listener, and keeps the permits', async function () {
			const semaphore = createSemaphore(1);
			const holder = semaphore.tryAcquire() as Release;
			const signal = new CountingSignal();
			const waiting = semaphore.acquire({ signal });
			expect(signal.listenerCount).toBe(1);
			signal.abort();
			expect(semaphore.pending).toBe(0);
			expect(signal.listenerCount).toBe(0);
			await expect(waiting).rejects.toBeInstanceOf(AbortError);
			expect(semaphore.available).toBe(0);
			holder();
			expect(semaphore.available).toBe(1);
		});

		it('rejects an already-aborted request even when permits are available', async function () {
			const semaphore = createSemaphore(2);
			const controller = new AbortController();
			controller.abort(new TimeoutError('too late'));
			await expect(semaphore.acquire({ signal: controller.signal })).rejects.toThrow('too late');
			await expect(semaphore.run(jest.fn(), { signal: controller.signal })).rejects.toBeInstanceOf(TimeoutError);
			expect(semaphore.available).toBe(2);
		});

		it('removes the abort listener and the timer once a waiter is granted, and ignores a later abort', async function () {
			jest.useFakeTimers();
			const semaphore = createSemaphore(1);
			const holder = semaphore.tryAcquire() as Release;
			const signal = new CountingSignal();
			const waiting = semaphore.acquire({ signal, timeout: 1000 });
			expect(jest.getTimerCount()).toBe(1);
			holder();
			expect(signal.listenerCount).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
			signal.abort();
			const release = await waiting;
			expect(semaphore.available).toBe(0);
			release();
			expect(semaphore.available).toBe(1);
		});

		it('rejects with a TimeoutError once timeout expires, leaving the queue and the permits unchanged', async function () {
			jest.useFakeTimers();
			const semaphore = createSemaphore(1);
			const holder = semaphore.tryAcquire() as Release;
			const signal = new CountingSignal();
			const waiting = semaphore.acquire({ timeout: 100, signal });
			const outcome = waiting.catch(function (error: unknown) {
				return error;
			});
			await jest.advanceTimersByTimeAsync(99);
			expect(semaphore.pending).toBe(1);
			await jest.advanceTimersByTimeAsync(1);
			const error = await outcome;
			expect(error).toBeInstanceOf(TimeoutError);
			expect((error as Error).message).toBe('Semaphore.acquire: timed out after 100 ms');
			expect(semaphore.pending).toBe(0);
			expect(signal.listenerCount).toBe(0);
			holder();
			expect(semaphore.available).toBe(1);
		});

		it('starts no timer for a waiting request without timeout', async function () {
			jest.useFakeTimers();
			const semaphore = createSemaphore(1);
			const release = semaphore.tryAcquire() as Release;
			const waiting = semaphore.acquire();
			expect(jest.getTimerCount()).toBe(0);
			release();
			(await waiting)();
		});

		it('starts no timer for a request granted at once, and times out a zero timeout after a tick', async function () {
			jest.useFakeTimers();
			const semaphore = createSemaphore(1);
			const release = await semaphore.acquire({ timeout: 0 });
			expect(jest.getTimerCount()).toBe(0);
			const waiting = semaphore.acquire({ timeout: 0 });
			const outcome = expect(waiting).rejects.toThrow('Semaphore.acquire: timed out after 0 ms');
			await jest.advanceTimersByTimeAsync(0);
			await outcome;
			release();
		});

		it('rejects invalid acquire options', async function () {
			const semaphore = createSemaphore(2);
			await expect(semaphore.acquire({ weight: 3 })).rejects.toThrow(new RangeError('Semaphore.acquire: `weight` must be an integer between 1 and 2, got 3'));
			await expect(semaphore.acquire({ weight: 0 })).rejects.toThrow(RangeError);
			await expect(semaphore.acquire({ weight: 1.5 })).rejects.toThrow(RangeError);
			await expect(semaphore.acquire({ weight: '1' as any })).rejects.toThrow(
				new TypeError('Semaphore.acquire: `weight` must be an integer between 1 and 2, got string')
			);
			await expect(semaphore.acquire({ timeout: -1 })).rejects.toThrow(RangeError);
			await expect(semaphore.acquire({ timeout: '1' as any })).rejects.toThrow(TypeError);
			await expect(semaphore.acquire({ signal: {} as any })).rejects.toThrow('Semaphore.acquire: `signal` must be an AbortSignal, null or undefined, got object');
			await expect(semaphore.acquire(null as any)).rejects.toThrow(TypeError);
			await expect(semaphore.run(jest.fn(), { weight: 5 })).rejects.toThrow('Semaphore.run: `weight` must be an integer between 1 and 2, got 5');
			expect(semaphore.available).toBe(2);
		});

		it('validates the weight of tryAcquire', function () {
			const semaphore = createSemaphore(2);
			expect(function () {
				semaphore.tryAcquire(3);
			}).toThrow(new RangeError('Semaphore.tryAcquire: `weight` must be an integer between 1 and 2, got 3'));
			expect(function () {
				semaphore.tryAcquire(null as any);
			}).toThrow(TypeError);
			expect(semaphore.available).toBe(2);
		});

		it('ignores options inherited from a polluted Object.prototype', async function () {
			const semaphore = createSemaphore(2);
			Object.defineProperty(Object.prototype, 'weight', { value: 99, configurable: true });
			try {
				const release = await semaphore.acquire({});
				expect(semaphore.available).toBe(1);
				release();
			} finally {
				delete (Object.prototype as any).weight;
			}
		});

		it('does not queue a request whose signal cannot take a listener', async function () {
			jest.useFakeTimers();
			const semaphore = createSemaphore(1);
			const holder = semaphore.tryAcquire() as Release;
			const signal = {
				aborted: false,
				addEventListener(): void {
					throw new Error('no listeners');
				},
				removeEventListener(): void {}
			};
			await expect(semaphore.acquire({ signal, timeout: 50 })).rejects.toThrow('no listeners');
			expect(semaphore.pending).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
			holder();
			expect(semaphore.available).toBe(1);
		});

		it('queues and aborts many requests sharing a signal in linear time (previously quadratic: one listener each)', async function () {
			/**
			 * Times queuing 30,000 requests, with or without a shared signal, then aborting them (or timing them out at once).
			 * @param {boolean} shared - Whether the requests share a signal
			 * @returns {Promise<number>} The time in ms
			 */
			async function time(shared: boolean): Promise<number> {
				const pool = createSemaphore(1);
				const held = pool.tryAcquire() as () => void;
				const controller = new AbortController();
				const requests: Array<Promise<() => void>> = [];
				const start = performance.now();
				for (let i = 0; i < 30_000; i++) requests.push(pool.acquire(shared ? { signal: controller.signal } : {}));
				if (shared) controller.abort();
				const elapsed = performance.now() - start;
				held();
				if (shared) {
					expect(pool.pending).toBe(0);
					await Promise.allSettled(requests);
				} else {
					// Every request is granted in turn.
					for (const request of requests) (await request)();
				}
				return elapsed;
			}
			const alone = await time(false);
			expect(await time(true)).toBeLessThan(alone * 20 + 100);
		});

		it('serves a long queue of waiting requests in linear time (previously quadratic: a Set used as a queue)', async function () {
			/**
			 * Times `n` runs through a semaphore of 4 permits, all queued at once.
			 * @param {number} n - The number of runs
			 * @returns {Promise<number>} The time in ms
			 */
			async function time(n: number): Promise<number> {
				const pool = createSemaphore(4);
				const runs: Array<Promise<number>> = [];
				const start = performance.now();
				for (let i = 0; i < n; i++) {
					runs.push(
						pool.run(function () {
							return i;
						})
					);
				}
				await Promise.all(runs);
				return performance.now() - start;
			}
			await time(20_000);
			const small = await time(20_000);
			// Eight times the requests: about 8 times as long (64 times, quadratic).
			expect(await time(160_000)).toBeLessThan(small * 20 + 100);
		});

		it('works with Infinity permits', async function () {
			const semaphore = createSemaphore(Infinity);
			const releases = await Promise.all(
				[1, 2, 3].map(function (weight) {
					return semaphore.acquire({ weight });
				})
			);
			expect(semaphore.available).toBe(Infinity);
			for (const release of releases) release();
			expect(semaphore.pending).toBe(0);
		});

		it('has methods that do not depend on this', async function () {
			const { acquire, tryAcquire, run } = createSemaphore(1);
			const release = await acquire();
			expect(tryAcquire()).toBeUndefined();
			release();
			await expect(run(constant(5))).resolves.toBe(5);
		});

		describe('run', function () {
			it('holds a permit while fn runs and releases it when fn resolves', async function () {
				const semaphore = createSemaphore(1);
				const gate = createDeferred<string>();
				const running = semaphore.run(function () {
					return gate.promise;
				});
				await Promise.resolve();
				expect(semaphore.available).toBe(0);
				gate.resolve('done');
				await expect(running).resolves.toBe('done');
				expect(semaphore.available).toBe(1);
			});

			it('releases when fn rejects or throws synchronously', async function () {
				const semaphore = createSemaphore(1);
				const error = new Error('nope');
				await expect(
					semaphore.run(function () {
						return Promise.reject(error);
					})
				).rejects.toBe(error);
				expect(semaphore.available).toBe(1);
				await expect(
					semaphore.run(function (): number {
						throw error;
					})
				).rejects.toBe(error);
				expect(semaphore.available).toBe(1);
			});

			it('releases before the caller resumes', async function () {
				const semaphore = createSemaphore(1);
				await semaphore.run(constant(1));
				expect(semaphore.available).toBe(1);
			});

			it('takes `weight` permits and honours timeout, without calling fn when the acquisition fails', async function () {
				jest.useFakeTimers();
				const semaphore = createSemaphore(2);
				const holder = semaphore.tryAcquire() as Release;
				const fn = jest.fn(constant(1));
				const outcome = expect(semaphore.run(fn, { weight: 2, timeout: 10 })).rejects.toThrow('Semaphore.run: timed out after 10 ms');
				await jest.advanceTimersByTimeAsync(10);
				await outcome;
				expect(fn).not.toHaveBeenCalled();
				holder();
				expect(semaphore.available).toBe(2);
			});

			it('rejects a non-function fn', async function () {
				const semaphore = createSemaphore(1);
				await expect(semaphore.run('task' as any)).rejects.toThrow(new TypeError('Semaphore.run: `fn` must be a function, got string'));
				expect(semaphore.available).toBe(1);
			});
		});
	});

	describe('createMutex', function () {
		it('serializes run calls in FIFO order', async function () {
			const mutex = createMutex();
			const log: string[] = [];
			async function step(name: string): Promise<string> {
				log.push(`start ${name}`);
				await Promise.resolve();
				await Promise.resolve();
				log.push(`end ${name}`);
				return name;
			}
			const results = await Promise.all(
				['a', 'b', 'c'].map(function (name) {
					return mutex.run(function () {
						return step(name);
					});
				})
			);
			expect(results).toEqual(['a', 'b', 'c']);
			expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
		});

		it('reports isLocked and pending', async function () {
			const mutex = createMutex();
			expect(mutex.isLocked).toBe(false);
			const release = (await mutex.acquire()) as Release;
			expect(mutex.isLocked).toBe(true);
			expect(mutex.tryAcquire()).toBeUndefined();
			const waiting = mutex.acquire();
			expect(mutex.pending).toBe(1);
			release();
			release();
			expect(mutex.isLocked).toBe(true);
			expect(mutex.pending).toBe(0);
			(await waiting)();
			expect(mutex.isLocked).toBe(false);
			const again = mutex.tryAcquire() as Release;
			expect(mutex.isLocked).toBe(true);
			again();
		});

		it('names itself in error messages and has no weight', async function () {
			jest.useFakeTimers();
			const mutex = createMutex();
			const release = mutex.tryAcquire() as Release;
			const outcome = expect(mutex.acquire({ timeout: 5 })).rejects.toThrow('Mutex.acquire: timed out after 5 ms');
			await jest.advanceTimersByTimeAsync(5);
			await outcome;
			await expect(mutex.run('x' as any)).rejects.toThrow('Mutex.run: `fn` must be a function, got string');
			expect(function () {
				(mutex.tryAcquire as (weight: number) => unknown)(2);
			}).toThrow('Mutex.tryAcquire: `weight` must be an integer between 1 and 1, got 2');
			release();
		});
	});

	describe('createKeyedMutex', function () {
		it('serializes per key and runs different keys in parallel', async function () {
			const locks = createKeyedMutex<string>();
			const log: string[] = [];
			const gates = { a1: createDeferred<void>(), a2: createDeferred<void>(), b1: createDeferred<void>() };
			function task(name: keyof typeof gates): () => Promise<void> {
				return function () {
					log.push(name);
					return gates[name].promise;
				};
			}
			const work = [locks.run('a', task('a1')), locks.run('a', task('a2')), locks.run('b', task('b1'))];
			await Promise.resolve();
			expect(log).toEqual(['a1', 'b1']);
			expect(locks.size).toBe(2);
			expect(locks.isLocked('a')).toBe(true);
			expect(locks.isLocked('c')).toBe(false);
			gates.b1.resolve();
			await work[2];
			expect(locks.isLocked('b')).toBe(false);
			expect(locks.size).toBe(1);
			gates.a1.resolve();
			await work[0];
			await Promise.resolve();
			expect(log).toEqual(['a1', 'b1', 'a2']);
			expect(locks.size).toBe(1);
			gates.a2.resolve();
			await work[1];
			expect(locks.size).toBe(0);
		});

		it('forgets a key as soon as it is idle, so many keys do not grow memory', async function () {
			const locks = createKeyedMutex<number>();
			for (let id = 0; id < 1000; id++) {
				const release = await locks.acquire(id);
				expect(locks.size).toBe(1);
				release();
				expect(locks.size).toBe(0);
			}
			for (let id = 0; id < 100; id++) (locks.tryAcquire(id) as Release)();
			expect(locks.size).toBe(0);
		});

		it('keeps the key while it is held, even when a waiter gives up', async function () {
			const locks = createKeyedMutex<string>();
			const release = locks.tryAcquire('doc') as Release;
			const controller = new AbortController();
			const waiting = locks.acquire('doc', { signal: controller.signal });
			controller.abort();
			await expect(waiting).rejects.toHaveProperty('name', 'AbortError');
			expect(locks.isLocked('doc')).toBe(true);
			expect(locks.tryAcquire('doc')).toBeUndefined();
			release();
			expect(locks.size).toBe(0);
		});

		it('leaves no state behind for requests that fail at once', async function () {
			const locks = createKeyedMutex<string>();
			const controller = new AbortController();
			controller.abort();
			const aborted = locks.acquire('a', { signal: controller.signal });
			expect(locks.size).toBe(0);
			await expect(aborted).rejects.toHaveProperty('name', 'AbortError');
			const invalid = locks.run('b', 'nope' as any);
			expect(locks.size).toBe(0);
			await expect(invalid).rejects.toThrow('KeyedMutex.run: `fn` must be a function, got string');
			await expect(locks.acquire('c', { timeout: -1 })).rejects.toThrow('KeyedMutex.acquire: `timeout` must be Infinity or a number between 0 and 2147483647, got -1');
			expect(locks.size).toBe(0);
		});

		it('hands a key over to its next waiter, then forgets it after a timeout of the last one', async function () {
			jest.useFakeTimers();
			const locks = createKeyedMutex<string>();
			const first = locks.tryAcquire('k') as Release;
			const second = locks.acquire('k');
			const third = locks.acquire('k', { timeout: 10 });
			first();
			const releaseSecond = await second;
			expect(locks.isLocked('k')).toBe(true);
			const outcome = expect(third).rejects.toBeInstanceOf(TimeoutError);
			await jest.advanceTimersByTimeAsync(10);
			await outcome;
			expect(locks.size).toBe(1);
			releaseSecond();
			expect(locks.size).toBe(0);
		});

		it('compares keys like a Map (NaN, objects by identity)', async function () {
			const locks = createKeyedMutex<unknown>();
			const release = locks.tryAcquire(NaN) as Release;
			expect(locks.tryAcquire(NaN)).toBeUndefined();
			const key = {};
			const other = locks.tryAcquire(key) as Release;
			const another = locks.tryAcquire({}) as Release;
			expect(locks.size).toBe(3);
			release();
			other();
			another();
			expect(locks.size).toBe(0);
		});

		it('ignores a release called again after the key was forgotten and reused', async function () {
			const locks = createKeyedMutex<string>();
			const old = locks.tryAcquire('k') as Release;
			old();
			const current = locks.tryAcquire('k') as Release;
			old();
			expect(locks.isLocked('k')).toBe(true);
			expect(locks.tryAcquire('k')).toBeUndefined();
			current();
			expect(locks.size).toBe(0);
		});
	});

	describe('waitForEvent', function () {
		it('resolves with the Event of an EventTarget and removes its listener', async function () {
			const target = new EventTarget();
			const remove = jest.spyOn(target, 'removeEventListener');
			const waiting = waitForEvent(target, 'ready');
			const event = new Event('ready');
			target.dispatchEvent(event);
			await expect(waiting).resolves.toBe(event);
			expect(remove).toHaveBeenCalledTimes(1);
		});

		it('resolves with the first argument of a Node emitter and removes every listener', async function () {
			const emitter = new EventEmitter();
			const waiting = waitForEvent<number>(emitter, 'data', { rejectOn: ['error', 'close'] });
			const listening = emitter.listenerCount('data') + emitter.listenerCount('error') + emitter.listenerCount('close');
			emitter.emit('data', 1, 2, 3);
			await expect(waiting).resolves.toBe(1);
			expect(listening).toBe(3);
			expect(emitter.eventNames()).toEqual([]);
		});

		it('works with symbols and with emitters only offering addListener / removeListener', async function () {
			const listeners = new Map<unknown, (value: unknown) => void>();
			const emitter = {
				addListener(type: unknown, listener: (value: unknown) => void): void {
					listeners.set(type, listener);
				},
				removeListener(type: unknown): void {
					listeners.delete(type);
				}
			};
			const type = Symbol('ready');
			const waiting = waitForEvent(emitter, type);
			(listeners.get(type) as (value: unknown) => void)('go');
			await expect(waiting).resolves.toBe('go');
			expect(listeners.size).toBe(0);
		});

		it('works with createEmitter', async function () {
			const events = createEmitter<{ saved: { id: number }; failed: Error }>();
			const waiting = waitForEvent<{ id: number }>(events, 'saved', {
				filter: function (payload) {
					return payload.id > 1;
				},
				rejectOn: ['failed']
			});
			events.emit('saved', { id: 1 });
			events.emit('saved', { id: 2 });
			await expect(waiting).resolves.toEqual({ id: 2 });
			expect(events.listenerCount()).toBe(0);
			const failing = waitForEvent(events, 'saved', { rejectOn: ['failed'] });
			events.emit('failed', new Error('disk full'));
			await expect(failing).rejects.toThrow('disk full');
			expect(events.listenerCount()).toBe(0);
		});

		it('prefers addEventListener over on', async function () {
			const target = new EventTarget() as EventTarget & { on: () => void; off: () => void };
			target.on = jest.fn();
			target.off = jest.fn();
			const waiting = waitForEvent(target, 'x');
			target.dispatchEvent(new Event('x'));
			await waiting;
			expect(target.on).not.toHaveBeenCalled();
		});

		it('only uses a complete pair of methods', async function () {
			for (const partial of [{ addEventListener: jest.fn() }, { removeEventListener: jest.fn() }]) {
				const emitter = Object.assign(new EventEmitter(), partial);
				const waiting = waitForEvent(emitter, 'x');
				emitter.emit('x', 'via on');
				await expect(waiting).resolves.toBe('via on');
				expect(emitter.listenerCount('x')).toBe(0);
			}
		});

		it('skips the events filter rejects, and rejects with the error filter throws', async function () {
			const emitter = new EventEmitter();
			const waiting = waitForEvent<number>(emitter, 'n', {
				filter: function (n) {
					return n > 2;
				}
			});
			emitter.emit('n', 1);
			emitter.emit('n', 2);
			emitter.emit('n', 3);
			await expect(waiting).resolves.toBe(3);
			const error = new Error('bad filter');
			const failing = waitForEvent(emitter, 'n', {
				filter: function () {
					throw error;
				}
			});
			emitter.emit('n', 1);
			await expect(failing).rejects.toBe(error);
			expect(emitter.listenerCount('n')).toBe(0);
		});

		it('rejects with the event of a rejectOn type (an emitted error then no longer throws)', async function () {
			const emitter = new EventEmitter();
			const error = new Error('connection reset');
			const waiting = waitForEvent(emitter, 'open', { rejectOn: ['error'] });
			const outcome = expect(waiting).rejects.toBe(error);
			emitter.emit('error', error);
			await outcome;
			expect(emitter.listenerCount('open') + emitter.listenerCount('error')).toBe(0);
		});

		it('rejects with a TimeoutError after timeout, removing the listeners', async function () {
			jest.useFakeTimers();
			const emitter = new EventEmitter();
			const signal = new CountingSignal();
			const waiting = waitForEvent(emitter, 'never', { timeout: 100, signal, rejectOn: ['error'] });
			const outcome = expect(waiting).rejects.toThrow(new TimeoutError('waitForEvent: no `never` event within 100 ms'));
			await jest.advanceTimersByTimeAsync(100);
			await outcome;
			expect(emitter.eventNames()).toEqual([]);
			expect(signal.listenerCount).toBe(0);
		});

		it('starts no timer without timeout', async function () {
			jest.useFakeTimers();
			const emitter = new EventEmitter();
			const waiting = waitForEvent(emitter, 'x');
			const timers = jest.getTimerCount();
			emitter.emit('x', 1);
			await expect(waiting).resolves.toBe(1);
			expect(timers).toBe(0);
		});

		it('clears the timer when the event comes first', async function () {
			jest.useFakeTimers();
			const emitter = new EventEmitter();
			const waiting = waitForEvent(emitter, 'x', { timeout: 100 });
			// Checked once the promise is awaited: a failing assertion must not leave its rejection unhandled.
			const timers = jest.getTimerCount();
			emitter.emit('x', 'value');
			await expect(waiting).resolves.toBe('value');
			expect(timers).toBe(1);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('rejects with the abort reason, before or while waiting', async function () {
			const emitter = new EventEmitter();
			const controller = new AbortController();
			const waiting = waitForEvent(emitter, 'x', { signal: controller.signal });
			controller.abort('stop');
			await expect(waiting).rejects.toBe('stop');
			expect(emitter.listenerCount('x')).toBe(0);
			await expect(waitForEvent(emitter, 'x', { signal: controller.signal })).rejects.toBe('stop');
			expect(emitter.listenerCount('x')).toBe(0);
			const signal = new CountingSignal();
			const pending = waitForEvent(emitter, 'x', { signal });
			signal.abort();
			await expect(pending).rejects.toBeInstanceOf(AbortError);
		});

		it('handles a listener called while it is being added', async function () {
			const removed: unknown[] = [];
			const emitter = {
				on(type: string, listener: (value: unknown) => void): void {
					if (type === 'ready') listener('replayed');
				},
				off(type: string): void {
					removed.push(type);
				}
			};
			const added = jest.spyOn(emitter, 'on');
			await expect(waitForEvent(emitter, 'ready', { rejectOn: ['error'], timeout: 1000 })).resolves.toBe('replayed');
			expect(added).toHaveBeenCalledTimes(1);
			expect(removed).toEqual(['ready']);
		});

		it('removes the listeners added before as soon as one replayed while being added settles it (review regression)', async function () {
			const log: string[] = [];
			let listeners: Array<[unknown, (value: unknown) => void]> = [];
			const emitter = {
				on(type: string, listener: (value: unknown) => void): void {
					log.push(`on ${type}`);
					listeners.push([type, listener]);
					// Replays a `ready` event while its `error` listener is added.
					if (type === 'error') for (const [t, l] of listeners.slice()) if (t === 'ready') l('replayed');
					log.push(`on ${type} returned`);
				},
				off(type: string, listener: (value: unknown) => void): void {
					log.push(`off ${type}`);
					listeners = listeners.filter(function ([t, l]) {
						return t !== type || l !== listener;
					});
				}
			};
			// As in 1.3: the `ready` listener goes during the replay, the `error` one once it has been added, and no `close` one is added.
			await expect(waitForEvent(emitter, 'ready', { rejectOn: ['error', 'close'] })).resolves.toBe('replayed');
			expect(log).toEqual(['on ready', 'on ready returned', 'on error', 'off ready', 'on error returned', 'off error']);
			expect(listeners).toEqual([]);
			// fromEvent shares that code: a filter throwing on the replayed event ends the iteration the same way.
			log.length = 0;
			const iterator = fromEvent(emitter, 'ready', {
				rejectOn: ['error', 'close'],
				filter: function (): boolean {
					throw new Error('filter failed');
				}
			});
			expect(log).toEqual(['on ready', 'on ready returned', 'on error', 'off ready', 'on error returned', 'off error']);
			expect(listeners).toEqual([]);
			await expect(iterator.next()).rejects.toThrow('filter failed');
		});

		it('removes the listeners already added when adding one throws', async function () {
			const emitter = new EventEmitter();
			const on = emitter.on.bind(emitter);
			emitter.on = function (type: string | symbol, listener: (...args: any[]) => void) {
				if (type === 'error') throw new Error('cannot listen');
				return on(type, listener);
			};
			const signal = new CountingSignal();
			await expect(waitForEvent(emitter, 'data', { rejectOn: ['error'], signal })).rejects.toThrow('cannot listen');
			expect(emitter.listenerCount('data')).toBe(0);
			expect(signal.listenerCount).toBe(0);
		});

		it('removes every listener even when a removal throws', async function () {
			const emitter = new EventEmitter();
			const off = emitter.off.bind(emitter);
			emitter.off = function (type: string | symbol, listener: (...args: any[]) => void) {
				off(type, listener);
				if (type === 'data') throw new Error('cannot remove');
				return emitter;
			};
			const waiting = waitForEvent(emitter, 'data', { rejectOn: ['error', 'close'] });
			emitter.emit('data', 1);
			await expect(waiting).resolves.toBe(1);
			expect(emitter.eventNames()).toEqual([]);
		});

		it('validates its arguments', async function () {
			const emitter = new EventEmitter();
			for (const target of [null, undefined, 42, {}, { on(): void {} }, { addEventListener(): void {} }, { addListener(): void {} }, { removeListener(): void {} }]) {
				await expect(waitForEvent(target as any, 'x')).rejects.toThrow(
					`waitForEvent: \`target\` must be an EventTarget or an event emitter, got ${target === null ? 'null' : typeof target}`
				);
			}
			await expect(waitForEvent(Object.assign(function () {}, { on(): void {}, off(): void {} }) as any, 1 as any)).rejects.toThrow(
				new TypeError('waitForEvent: `type` must be a string or a symbol, got number')
			);
			await expect(waitForEvent(emitter, 'x', { timeout: -1 })).rejects.toThrow(
				new RangeError('waitForEvent: `timeout` must be Infinity or a number between 0 and 2147483647, got -1')
			);
			await expect(waitForEvent(emitter, 'x', { filter: 1 as any })).rejects.toThrow('waitForEvent: `filter` must be a function, got number');
			await expect(waitForEvent(emitter, 'x', { rejectOn: 'error' as any })).rejects.toThrow('waitForEvent: `rejectOn` must be an array, got string');
			await expect(waitForEvent(emitter, 'x', { rejectOn: ['error', null as any] })).rejects.toThrow(
				'waitForEvent: `rejectOn[1]` must be a string or a symbol, got null'
			);
			await expect(waitForEvent(emitter, 'x', { signal: 'no' as any })).rejects.toThrow('waitForEvent: `signal` must be an AbortSignal, null or undefined, got string');
			await expect(waitForEvent(emitter, 'x', null as any)).rejects.toThrow(TypeError);
			expect(emitter.eventNames()).toEqual([]);
		});

		it('rejects a hole in rejectOn, whatever a polluted Object.prototype holds at its index', async function () {
			const emitter = new EventEmitter();
			const proto = Object.prototype as Record<string, unknown>;
			// eslint-disable-next-line no-sparse-arrays
			const rejectOn = ['error', , 'close'] as string[];
			const error = new TypeError('waitForEvent: `rejectOn[1]` must be a string or a symbol, got undefined');

			await expect(waitForEvent(emitter, 'x', { rejectOn })).rejects.toThrow(error);
			proto[1] = 'end';
			try {
				await expect(waitForEvent(emitter, 'x', { rejectOn })).rejects.toThrow(error);
				expect(function () {
					fromEvent(emitter, 'x', { rejectOn });
				}).toThrow(new TypeError('fromEvent: `rejectOn[1]` must be a string or a symbol, got undefined'));
			} finally {
				delete proto[1];
			}
			expect(emitter.eventNames()).toEqual([]);
		});
	});

	describe('reduceAsync', function () {
		it('reduces arrays, sync iterables of promises and async iterables in order', async function () {
			await expect(
				reduceAsync(
					[1, 2, 3],
					function (sum, n) {
						return sum + n;
					},
					0
				)
			).resolves.toBe(6);
			await expect(
				reduceAsync(
					[Promise.resolve('a'), 'b'],
					async function (text, letter, index) {
						await Promise.resolve();
						return `${text}${letter}${index}`;
					},
					Promise.resolve('>')
				)
			).resolves.toBe('>a0b1');
			async function* numbers(): AsyncGenerator<number> {
				yield 1;
				yield 2;
			}
			await expect(
				reduceAsync(
					numbers(),
					function (list: number[], n) {
						return [...list, n];
					},
					[]
				)
			).resolves.toEqual([1, 2]);
			await expect(reduceAsync(new Set<number>(), jest.fn(), 'empty')).resolves.toBe('empty');
		});

		it('reads each item only after the previous step settled', async function () {
			const log: string[] = [];
			function* items(): Generator<number> {
				log.push('read 1');
				yield 1;
				log.push('read 2');
				yield 2;
			}
			await reduceAsync(
				items(),
				async function (_acc: number, n) {
					log.push(`start ${n}`);
					await Promise.resolve();
					log.push(`end ${n}`);
					return n;
				},
				0
			);
			expect(log).toEqual(['read 1', 'start 1', 'end 1', 'read 2', 'start 2', 'end 2']);
		});

		it('rejects with the reducer error and closes the iterator', async function () {
			let closed = false;
			async function* items(): AsyncGenerator<number> {
				try {
					yield 1;
					yield 2;
				} finally {
					closed = true;
				}
			}
			const error = new Error('bad item');
			await expect(
				reduceAsync(
					items(),
					function () {
						throw error;
					},
					0
				)
			).rejects.toBe(error);
			expect(closed).toBe(true);
		});

		it('stops at once when the signal aborts during a step, closing the iterator', async function () {
			let closed = false;
			function* items(): Generator<number> {
				try {
					yield 1;
					yield 2;
				} finally {
					closed = true;
				}
			}
			const controller = new AbortController();
			const reducer = jest.fn(function () {
				controller.abort('stop');
				return new Promise<number>(function () {});
			});
			await expect(reduceAsync(items(), reducer, 0, { signal: controller.signal })).rejects.toBe('stop');
			expect(reducer).toHaveBeenCalledTimes(1);
			expect(closed).toBe(true);
		});

		it('stops waiting for an item that never comes when the signal aborts, and asks the source to close', async function () {
			const controller = new AbortController();
			const returned = jest.fn(function () {
				return Promise.resolve({ done: true as const, value: undefined });
			});
			const idle: AsyncIterable<number> = {
				[Symbol.asyncIterator]: function () {
					let calls = 0;
					return {
						next: function () {
							return calls++ === 0 ? Promise.resolve({ done: false as const, value: 1 }) : new Promise<IteratorResult<number>>(function () {});
						},
						return: returned
					};
				}
			};
			let reduced!: () => void;
			const firstReduced = new Promise<void>(function (resolve) {
				reduced = resolve;
			});
			const reducer = jest.fn(function (sum: number, n: number) {
				reduced();
				return sum + n;
			});
			const pending = reduceAsync(idle, reducer, 0, { signal: controller.signal });
			await firstReduced;
			await Promise.resolve();
			controller.abort('gave up');
			await expect(pending).rejects.toBe('gave up');
			expect(reducer).toHaveBeenCalledTimes(1);
			expect(returned).toHaveBeenCalledTimes(1);
		});

		it('reads no further item after an abort between two steps', async function () {
			const controller = new AbortController();
			const log: string[] = [];
			async function* items(): AsyncGenerator<number> {
				try {
					for (let i = 0; i < 3; i++) {
						log.push(`produce ${i}`);
						yield i;
					}
				} finally {
					log.push('closed');
				}
			}
			const reducer = jest.fn(function (sum: number, n: number) {
				log.push(`reduce ${n}`);
				// Aborted by a microtask, after this step settled and before the next item is requested.
				if (n === 0) {
					Promise.resolve().then(function () {
						controller.abort('between steps');
					});
				}
				return sum + n;
			});
			await expect(reduceAsync(items(), reducer, 0, { signal: controller.signal })).rejects.toBe('between steps');
			expect(log).toEqual(['produce 0', 'reduce 0', 'closed']);
		});

		it('treats iterator results like for await does', async function () {
			function source(results: unknown[]): AsyncIterable<number> {
				return {
					[Symbol.asyncIterator]: function () {
						let index = 0;
						return {
							next: function () {
								return Promise.resolve(results[index++] as IteratorResult<number>);
							}
						};
					}
				};
			}
			// `done` is read as a boolean: a truthy `1` ends the iteration (it used to loop forever).
			await expect(
				reduceAsync(
					source([
						{ done: false, value: 1 },
						{ done: 1, value: 99 }
					]),
					function (sum: number, n: number) {
						return sum + n;
					},
					5
				)
			).resolves.toBe(6);
			// A result that is not an object is a TypeError.
			await expect(reduceAsync(source([5]), jest.fn(), 0)).rejects.toThrow(
				new TypeError('reduceAsync: the iterator returned a result that is not an object, got number')
			);
			await expect(reduceAsync(source([null]), jest.fn(), 0)).rejects.toThrow('got null');
			// Functions are objects.
			const result = Object.assign(function () {}, { done: true });
			await expect(reduceAsync(source([result]), jest.fn(), 7)).resolves.toBe(7);
		});

		it('closes the source when the signal aborts just after an item was read, without reducing it', async function () {
			const controller = new AbortController();
			const returned = jest.fn(function () {
				return Promise.resolve({ done: true as const, value: undefined });
			});
			const source: AsyncIterable<number> = {
				[Symbol.asyncIterator]: function () {
					return {
						next: function () {
							const read = Promise.resolve({ done: false as const, value: 1 });
							// Two ticks later: after the read settled, before `reduceAsync` resumes.
							read.then(function () {}).then(function () {
								controller.abort('late');
							});
							return read;
						},
						return: returned
					};
				}
			};
			const reducer = jest.fn();
			await expect(reduceAsync(source, reducer, 0, { signal: controller.signal })).rejects.toBe('late');
			expect(reducer).not.toHaveBeenCalled();
			expect(returned).toHaveBeenCalledTimes(1);

			// The same late abort on the read that ends the source: the reduction still rejects, and a finished source is not closed.
			const ending = new AbortController();
			const endReturned = jest.fn();
			const finished: AsyncIterable<number> = {
				[Symbol.asyncIterator]: function () {
					return {
						next: function () {
							const read = Promise.resolve({ done: true as const, value: undefined });
							read.then(function () {}).then(function () {
								ending.abort('late end');
							});
							return read;
						},
						return: endReturned
					};
				}
			};
			await expect(reduceAsync(finished, reducer, 0, { signal: ending.signal })).rejects.toBe('late end');
			expect(endReturned).not.toHaveBeenCalled();
		});

		it('ignores a source whose return method fails, and does not close a source that failed itself', async function () {
			const failing = {
				[Symbol.asyncIterator]: function () {
					return {
						next: function () {
							return Promise.resolve({ done: false as const, value: 1 });
						},
						return: function () {
							throw new Error('cannot close');
						}
					};
				}
			};
			const error = new Error('reducer failed');
			await expect(
				reduceAsync(
					failing,
					function () {
						throw error;
					},
					0
				)
			).rejects.toBe(error);
			const returned = jest.fn();
			const broken = {
				[Symbol.asyncIterator]: function () {
					return {
						next: function () {
							return Promise.reject(new Error('read failed'));
						},
						return: returned
					};
				}
			};
			await expect(reduceAsync(broken, jest.fn(), 0)).rejects.toThrow('read failed');
			expect(returned).not.toHaveBeenCalled();
		});

		it('rejects without calling the reducer when the signal is already aborted', async function () {
			const controller = new AbortController();
			controller.abort();
			const reducer = jest.fn();
			await expect(reduceAsync([1], reducer, 0, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
			expect(reducer).not.toHaveBeenCalled();
		});

		it('notices an abort that happens while reading an item', async function () {
			const controller = new AbortController();
			async function* items(): AsyncGenerator<number> {
				yield 1;
				controller.abort('while reading');
				yield 2;
			}
			const reducer = jest.fn(function (sum: number, n: number) {
				return sum + n;
			});
			await expect(reduceAsync(items(), reducer, 0, { signal: controller.signal })).rejects.toBe('while reading');
			expect(reducer).toHaveBeenCalledTimes(1);
			const last = new AbortController();
			async function* finishing(): AsyncGenerator<number> {
				yield 1;
				last.abort('after the last item');
			}
			await expect(reduceAsync(finishing(), reducer, 0, { signal: last.signal })).rejects.toBe('after the last item');
		});

		it('validates its arguments', async function () {
			await expect(reduceAsync(null as any, jest.fn(), 0)).rejects.toThrow(new TypeError('reduceAsync: `items` must be an iterable or an async iterable, got null'));
			await expect(reduceAsync(undefined as any, jest.fn(), 0)).rejects.toThrow('reduceAsync: `items` must be an iterable or an async iterable, got undefined');
			await expect(reduceAsync(42 as any, jest.fn(), 0)).rejects.toThrow('reduceAsync: `items` must be an iterable or an async iterable, got number');
			await expect(reduceAsync([1], 'add' as any, 0)).rejects.toThrow('reduceAsync: `reducer` must be a function, got string');
			await expect(reduceAsync([1], jest.fn(), 0, { signal: 1 as any })).rejects.toThrow('reduceAsync: `signal` must be an AbortSignal, null or undefined, got number');
			await expect(reduceAsync([1], jest.fn(), 0, null as any)).rejects.toThrow(TypeError);
		});
	});

	describe('minDelay', function () {
		it('resolves no earlier than ms, with the value', async function () {
			jest.useFakeTimers();
			const delayed = minDelay(Promise.resolve('fast'), 100);
			await jest.advanceTimersByTimeAsync(99);
			expect(await stateOf(delayed)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await expect(delayed).resolves.toBe('fast');
			const value = minDelay(7, 0);
			await jest.advanceTimersByTimeAsync(0);
			await expect(value).resolves.toBe(7);
		});

		it('does not delay a slower promise any further', async function () {
			jest.useFakeTimers();
			const slow = new Promise<string>(function (resolve) {
				setTimeout(resolve, 300, 'slow');
			});
			const delayed = minDelay(slow, 100);
			await jest.advanceTimersByTimeAsync(299);
			expect(await stateOf(delayed)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await expect(delayed).resolves.toBe('slow');
		});

		it('delays rejections by default', async function () {
			jest.useFakeTimers();
			const error = new Error('offline');
			const delayed = minDelay(Promise.reject(error), 100);
			const outcome = expect(delayed).rejects.toBe(error);
			await jest.advanceTimersByTimeAsync(99);
			expect(await stateOf(delayed)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await outcome;
		});

		it('passes rejections through at once with delayRejection: false, clearing the timer', async function () {
			jest.useFakeTimers();
			const error = new Error('offline');
			await expect(minDelay(Promise.reject(error), 100, { delayRejection: false })).rejects.toBe(error);
			expect(jest.getTimerCount()).toBe(0);
			const delayed = minDelay(Promise.resolve(1), 100, { delayRejection: false });
			await jest.advanceTimersByTimeAsync(99);
			expect(await stateOf(delayed)).toBe('pending');
			await jest.advanceTimersByTimeAsync(1);
			await expect(delayed).resolves.toBe(1);
		});

		it('validates its arguments, handling the rejection of the promise', async function () {
			const unhandled = jest.fn();
			process.on('unhandledRejection', unhandled);
			try {
				await expect(minDelay(Promise.reject(new Error('ignored')), -1)).rejects.toThrow(
					new RangeError('minDelay: `ms` must be a number between 0 and 2147483647, got -1')
				);
				await expect(minDelay(Promise.reject(new Error('ignored')), '5' as any)).rejects.toThrow(TypeError);
				await expect(minDelay(Promise.reject(new Error('ignored')), 5, null as any)).rejects.toThrow(TypeError);
				await new Promise(setImmediate);
				expect(unhandled).not.toHaveBeenCalled();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
		});
	});
});

describe('Async helpers (1.4: error checks, circuit breaker, backoff, fromEvent, interval, stopwatch)', function () {
	afterEach(function () {
		// Spies on the fake `performance.now` go first: restoring them after the real timers are back would reinstall the fake one.
		jest.restoreAllMocks();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	/**
	 * A manual clock for the `now` options.
	 */
	function manualClock(start = 0): { now: () => number; set: (time: number) => void; advance: (ms: number) => void } {
		let time = start;
		return {
			now: function () {
				return time;
			},
			set: function (value: number) {
				time = value;
			},
			advance: function (ms: number) {
				time += ms;
			}
		};
	}

	/**
	 * Collects the rejections of the promises derived with `.then` while `fn` runs, which nothing else handles (Jest would report them
	 * as unhandled rejections, failing the test, and does not let the test observe them through `process`).
	 */
	async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
		const reasons: unknown[] = [];
		const then = Promise.prototype.then;
		const spy = jest.spyOn(Promise.prototype, 'then').mockImplementation(function (this: Promise<unknown>, ...args: Parameters<Promise<unknown>['then']>) {
			const derived = then.apply(this, args);
			then.call(derived, undefined, function (reason: unknown) {
				reasons.push(reason);
			});
			return derived;
		} as Promise<unknown>['then']);
		try {
			await fn();
		} finally {
			spy.mockRestore();
		}
		return reasons;
	}

	describe('isAbortError / isTimeoutError', function () {
		it('recognizes the module errors, DOMExceptions, Node errors and errors of other realms by name', async function () {
			expect(isAbortError(new AbortError())).toBe(true);
			expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
			const controller = new AbortController();
			controller.abort();
			expect(isAbortError(controller.signal.reason)).toBe(true);
			const { setTimeout: delay } = await import('node:timers/promises');
			const nodeError = await delay(10, undefined, { signal: controller.signal }).catch(function (error: unknown) {
				return error;
			});
			expect(isAbortError(nodeError)).toBe(true);
			const vm = await import('node:vm');
			const foreign: unknown = vm.runInNewContext('const e = new Error("elsewhere"); e.name = "AbortError"; e');
			expect(foreign instanceof Error).toBe(false);
			expect(isAbortError(foreign)).toBe(true);
			expect(isAbortError(JSON.parse('{"name":"AbortError","message":"from JSON"}'))).toBe(true);
			expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
			expect(isAbortError(Object.assign(Object.create(null), { name: 'AbortError', message: '' }))).toBe(true);

			expect(isTimeoutError(new TimeoutError())).toBe(true);
			expect(isTimeoutError(new DOMException('late', 'TimeoutError'))).toBe(true);
			const timedOut = AbortSignal.timeout(0);
			await sleep(10);
			expect(isTimeoutError(timedOut.reason)).toBe(true);
			expect(
				isTimeoutError(
					await withTimeout(new Promise(function () {}), 1).catch(function (error: unknown) {
						return error;
					})
				)
			).toBe(true);
			expect(isTimeoutError(vm.runInNewContext('const e = new Error("x"); e.name = "TimeoutError"; e'))).toBe(true);
		});

		it('rejects other names, values that are not error-like objects, and functions', function () {
			expect(isAbortError(new TimeoutError())).toBe(false);
			expect(isTimeoutError(new AbortError())).toBe(false);
			expect(isAbortError(new Error('AbortError'))).toBe(false);
			expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(false);
			for (const value of ['AbortError', null, undefined, 0, true, Symbol('AbortError'), 1n]) {
				expect(isAbortError(value)).toBe(false);
				expect(isTimeoutError(value)).toBe(false);
			}
			expect(isAbortError({ name: 'AbortError' })).toBe(false);
			expect(isAbortError({ name: 'AbortError', message: 1 })).toBe(false);
			expect(isAbortError({ name: 'aborterror', message: '' })).toBe(false);
			// Functions have a `name` too.
			function AbortErrorLike(): void {}
			Object.defineProperty(AbortErrorLike, 'name', { value: 'AbortError' });
			Object.defineProperty(AbortErrorLike, 'message', { value: 'x' });
			expect(isAbortError(AbortErrorLike)).toBe(false);
		});

		it('never throws, and ignores names and messages inherited from a polluted Object.prototype', function () {
			const throwing = {
				get name(): string {
					throw new Error('getter');
				},
				message: 'x'
			};
			expect(isAbortError(throwing)).toBe(false);
			const trap = new Proxy(
				{},
				{
					get: function () {
						throw new Error('trap');
					}
				}
			);
			expect(isAbortError(trap)).toBe(false);
			const { proxy, revoke } = Proxy.revocable({ name: 'AbortError', message: 'x' }, {});
			expect(isAbortError(proxy)).toBe(true);
			revoke();
			expect(isAbortError(proxy)).toBe(false);
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.name = 'AbortError';
			prototype.message = 'polluted';
			try {
				expect(isAbortError({})).toBe(false);
				expect(isAbortError({ name: 'AbortError' })).toBe(false);
				expect(isAbortError({ message: 'x' })).toBe(false);
				expect(isAbortError(new AbortError())).toBe(true);
			} finally {
				delete prototype.name;
				delete prototype.message;
			}
		});
	});

	describe('CircuitOpenError', function () {
		it('has a name, a default message and a retryAfter', function () {
			const error = new CircuitOpenError();
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe('CircuitOpenError');
			expect(error.message).toBe('The circuit is open.');
			expect(error.retryAfter).toBe(0);
			expect(new CircuitOpenError('down', 250).retryAfter).toBe(250);
		});
	});

	describe('createCircuitBreaker', function () {
		/**
		 * An operation whose outcome is controlled by the test.
		 */
		function controlled(): { fn: jest.Mock<Promise<string>, [string?]>; healthy: (value: boolean) => void } {
			let ok = true;
			const fn = jest.fn(async function (value?: string): Promise<string> {
				if (!ok) throw new Error(`failed ${value}`);
				return `ok ${value}`;
			});
			return {
				fn,
				healthy: function (value: boolean) {
					ok = value;
				}
			};
		}

		it('passes calls through while closed, forwarding this and the arguments, and turns synchronous throws into rejections', async function () {
			const target = {
				prefix: '>',
				run(this: { prefix: string }, a: number, b: number): string {
					return `${this.prefix}${a + b}`;
				}
			};
			const guarded = createCircuitBreaker(target.run);
			await expect(guarded.call(target, 1, 2)).resolves.toBe('>3');
			const throwing = createCircuitBreaker(function (): never {
				throw new Error('sync');
			});
			const result = throwing();
			expect(result).toBeInstanceOf(Promise);
			await expect(result).rejects.toThrow('sync');
			expect(throwing.state).toBe('closed');
		});

		it('opens after failureThreshold consecutive failures and short-circuits without calling the operation', async function () {
			const clock = manualClock(1000);
			const { fn, healthy } = controlled();
			const changes: string[] = [];
			const guarded = createCircuitBreaker(fn, {
				failureThreshold: 3,
				resetTimeout: 500,
				now: clock.now,
				onStateChange: function (state, previous) {
					changes.push(`${previous}->${state}`);
				}
			});
			healthy(false);
			await expect(guarded('a')).rejects.toThrow('failed a');
			await expect(guarded('b')).rejects.toThrow('failed b');
			expect(guarded.stats.consecutiveFailures).toBe(2);
			healthy(true);
			await guarded('c');
			// A success resets the streak.
			expect(guarded.stats.consecutiveFailures).toBe(0);
			healthy(false);
			for (const value of ['d', 'e', 'f']) await expect(guarded(value)).rejects.toThrow(`failed ${value}`);
			expect(guarded.state).toBe('open');
			expect(changes).toEqual(['closed->open']);
			clock.advance(120);
			const rejection = guarded('g');
			await expect(rejection).rejects.toBeInstanceOf(CircuitOpenError);
			const error = (await rejection.catch(function (reason: unknown) {
				return reason;
			})) as CircuitOpenError;
			expect(error.retryAfter).toBe(380);
			expect(error.message).toBe('createCircuitBreaker: the circuit is open, retry in 380 ms');
			expect(fn).toHaveBeenCalledTimes(6);
			expect(guarded.stats).toEqual({ state: 'open', consecutiveFailures: 0, successes: 1, failures: 5, shortCircuited: 1 });
		});

		it('turns half-open lazily after resetTimeout: a successful trial closes it, a failed one reopens it', async function () {
			const clock = manualClock();
			const { fn, healthy } = controlled();
			const changes: string[] = [];
			const guarded = createCircuitBreaker(fn, {
				failureThreshold: 1,
				resetTimeout: 100,
				now: clock.now,
				onStateChange: function (state, previous) {
					changes.push(`${previous}->${state}`);
				}
			});
			healthy(false);
			await expect(guarded()).rejects.toThrow('failed');
			clock.advance(99);
			expect(guarded.state).toBe('open');
			clock.advance(1);
			// Nothing happens until the breaker is used.
			expect(changes).toEqual(['closed->open']);
			await expect(guarded('trial')).rejects.toThrow('failed trial');
			expect(changes).toEqual(['closed->open', 'open->half-open', 'half-open->open']);
			// Reopened for a full resetTimeout from the failed trial.
			await expect(guarded()).rejects.toMatchObject({ retryAfter: 100 });
			clock.advance(100);
			expect(guarded.state).toBe('half-open');
			healthy(true);
			await expect(guarded('trial')).resolves.toBe('ok trial');
			expect(guarded.state).toBe('closed');
			expect(changes).toEqual(['closed->open', 'open->half-open', 'half-open->open', 'open->half-open', 'half-open->closed']);
		});

		it('lets halfOpenMaxCalls trials through, rejects the others with retryAfter 0, and closes once all of them succeed', async function () {
			const clock = manualClock();
			const deferreds: Array<Deferred<string>> = [];
			let failing = true;
			const fn = jest.fn(function (): Promise<string> {
				if (failing) return Promise.reject(new Error('down'));
				const deferred = createDeferred<string>();
				deferreds.push(deferred);
				return deferred.promise;
			});
			const guarded = createCircuitBreaker(fn, { failureThreshold: 1, resetTimeout: 10, halfOpenMaxCalls: 2, now: clock.now });
			await expect(guarded()).rejects.toThrow('down');
			clock.advance(10);
			failing = false;
			const first = guarded();
			const second = guarded();
			const third = guarded();
			await expect(third).rejects.toThrow(new CircuitOpenError('createCircuitBreaker: the circuit is half-open and its trial calls are in flight'));
			await expect(third).rejects.toMatchObject({ retryAfter: 0 });
			expect(fn).toHaveBeenCalledTimes(3);
			deferreds[0].resolve('a');
			await expect(first).resolves.toBe('a');
			expect(guarded.state).toBe('half-open');
			// The trial slots are used up for this half-open period, even though one has settled.
			await expect(guarded()).rejects.toBeInstanceOf(CircuitOpenError);
			deferreds[1].resolve('b');
			await expect(second).resolves.toBe('b');
			expect(guarded.state).toBe('closed');
			expect(guarded.stats.shortCircuited).toBe(2);
		});

		it('reopens on the first failed trial; a later success of another trial does not close it', async function () {
			const clock = manualClock();
			const deferreds: Array<Deferred<string>> = [];
			const fn = jest.fn(function (): Promise<string> {
				const deferred = createDeferred<string>();
				deferreds.push(deferred);
				return deferred.promise;
			});
			const guarded = createCircuitBreaker(fn, { failureThreshold: 1, resetTimeout: 10, halfOpenMaxCalls: 2, now: clock.now });
			guarded.open();
			clock.advance(10);
			const first = guarded();
			const second = guarded();
			deferreds[0].reject(new Error('still down'));
			await expect(first).rejects.toThrow('still down');
			expect(guarded.state).toBe('open');
			deferreds[1].resolve('late');
			await expect(second).resolves.toBe('late');
			expect(guarded.state).toBe('open');
			expect(guarded.stats).toEqual({ state: 'open', consecutiveFailures: 0, successes: 1, failures: 1, shortCircuited: 0 });
		});

		it('ignores the outcome of calls that started in an earlier generation', async function () {
			const clock = manualClock();
			const deferreds: Array<Deferred<string>> = [];
			const fn = jest.fn(function (): Promise<string> {
				const deferred = createDeferred<string>();
				deferreds.push(deferred);
				return deferred.promise;
			});
			const onStateChange = jest.fn();
			const guarded = createCircuitBreaker(fn, { failureThreshold: 2, resetTimeout: 1000, now: clock.now, onStateChange });
			const slow = guarded();
			const calls = [guarded(), guarded(), guarded()];
			for (let i = 1; i <= 3; i++) deferreds[i].reject(new Error(`boom ${i}`));
			await Promise.allSettled(calls);
			// Concurrent failures open the circuit once.
			expect(onStateChange).toHaveBeenCalledTimes(1);
			expect(guarded.state).toBe('open');
			// A slow call made while closed succeeds after the circuit opened: it does not close it.
			deferreds[0].resolve('late');
			await expect(slow).resolves.toBe('late');
			expect(guarded.state).toBe('open');

			// A slow failure from before a reset does not count toward the new streak.
			guarded.reset();
			const before = guarded();
			guarded.reset();
			const after = guarded();
			deferreds[4].reject(new Error('old'));
			await expect(before).rejects.toThrow('old');
			expect(guarded.stats.consecutiveFailures).toBe(0);
			deferreds[5].reject(new Error('new'));
			await expect(after).rejects.toThrow('new');
			expect(guarded.stats.consecutiveFailures).toBe(1);
			expect(guarded.state).toBe('closed');
		});

		it('counts errors that isFailure rejects as successes, and a throwing isFailure as a failure with its error', async function () {
			const clock = manualClock();
			class NotFound extends Error {}
			let error: Error = new NotFound('404');
			const guarded = createCircuitBreaker(
				function (): Promise<never> {
					return Promise.reject(error);
				},
				{
					failureThreshold: 2,
					now: clock.now,
					isFailure: function (reason) {
						if ((reason as Error).message === 'filter') throw new TypeError('isFailure broke');
						return (reason instanceof NotFound ? 0 : 'yes') as unknown as boolean;
					}
				}
			);
			await expect(guarded()).rejects.toBe(error);
			expect(guarded.stats).toMatchObject({ successes: 1, failures: 0, consecutiveFailures: 0 });
			error = new Error('500');
			await expect(guarded()).rejects.toBe(error);
			expect(guarded.stats.consecutiveFailures).toBe(1);
			error = new NotFound('404');
			await expect(guarded()).rejects.toBe(error);
			expect(guarded.stats.consecutiveFailures).toBe(0);
			error = new Error('filter');
			await expect(guarded()).rejects.toThrow(new TypeError('isFailure broke'));
			await expect(guarded()).rejects.toThrow(new TypeError('isFailure broke'));
			expect(guarded.state).toBe('open');
			expect(guarded.stats.failures).toBe(3);
		});

		it('passes the error of onStateChange to whoever caused the change, the change standing', async function () {
			const clock = manualClock();
			let throwing = true;
			const guarded = createCircuitBreaker(
				function (): Promise<never> {
					return Promise.reject(new Error('down'));
				},
				{
					failureThreshold: 1,
					resetTimeout: 10,
					now: clock.now,
					onStateChange: function (state) {
						if (throwing) throw new Error(`listener: ${state}`);
					}
				}
			);
			await expect(guarded()).rejects.toThrow('listener: open');
			expect(guarded.state).toBe('open');
			expect(function () {
				guarded.reset();
			}).toThrow('listener: closed');
			expect(guarded.state).toBe('closed');
			expect(function () {
				guarded.open();
			}).toThrow('listener: open');
			clock.advance(10);
			// The switch to half-open at a call: that call rejects with the error, and the next one is the trial.
			await expect(guarded()).rejects.toThrow('listener: half-open');
			throwing = false;
			await expect(guarded()).rejects.toThrow('down');
			expect(guarded.state).toBe('open');
			throwing = true;
			clock.advance(10);
			expect(function () {
				return guarded.state;
			}).toThrow('listener: half-open');
			expect(guarded.state).toBe('half-open');
		});

		it('handles an onStateChange that reopens the circuit or calls the breaker while it turns half-open', async function () {
			const clock = manualClock();
			let reopen = false;
			let reenter = false;
			let inner: Promise<unknown> | undefined;
			const fn = jest.fn(function (): string {
				return 'ok';
			});
			const guarded = createCircuitBreaker(fn, {
				resetTimeout: 50,
				now: clock.now,
				onStateChange: function (state) {
					if (state !== 'half-open') return;
					if (reopen) guarded.open();
					if (reenter) inner = guarded();
				}
			});
			guarded.open();
			clock.advance(50);
			reopen = true;
			await expect(guarded()).rejects.toMatchObject({ name: 'CircuitOpenError', retryAfter: 50 });
			expect(fn).not.toHaveBeenCalled();
			expect(guarded.state).toBe('open');
			reopen = false;
			reenter = true;
			clock.advance(50);
			// The call made by the listener takes the trial slot.
			await expect(guarded()).rejects.toMatchObject({ retryAfter: 0 });
			await expect(inner).resolves.toBe('ok');
			expect(fn).toHaveBeenCalledTimes(1);
			expect(guarded.state).toBe('closed');
		});

		it('supports open() and reset() in every state, reporting only actual changes', async function () {
			const clock = manualClock();
			const changes: string[] = [];
			const guarded = createCircuitBreaker(
				function (): number {
					return 1;
				},
				{
					resetTimeout: 100,
					now: clock.now,
					onStateChange: function (state, previous) {
						changes.push(`${previous}->${state}`);
					}
				}
			);
			guarded.reset();
			expect(changes).toEqual([]);
			guarded.open();
			clock.advance(60);
			// Opening again restarts the reset timeout.
			guarded.open();
			expect(changes).toEqual(['closed->open']);
			await expect(guarded()).rejects.toMatchObject({ retryAfter: 100 });
			clock.advance(100);
			expect(guarded.state).toBe('half-open');
			guarded.open();
			expect(guarded.state).toBe('open');
			guarded.reset();
			await expect(guarded()).resolves.toBe(1);
			expect(changes).toEqual(['closed->open', 'open->half-open', 'half-open->open', 'open->closed']);
		});

		it('stays open with resetTimeout: Infinity and turns half-open at once with resetTimeout: 0', async function () {
			const clock = manualClock();
			const forever = createCircuitBreaker(
				function (): number {
					return 1;
				},
				{ resetTimeout: Infinity, now: clock.now }
			);
			forever.open();
			clock.advance(Number.MAX_SAFE_INTEGER);
			await expect(forever()).rejects.toMatchObject({ retryAfter: Infinity, message: 'createCircuitBreaker: the circuit is open, until reset()' });
			forever.reset();
			await expect(forever()).resolves.toBe(1);
			const instant = createCircuitBreaker(
				function (): number {
					return 2;
				},
				{ resetTimeout: 0, now: clock.now }
			);
			instant.open();
			expect(instant.state).toBe('half-open');
			await expect(instant()).resolves.toBe(2);
		});

		it('treats a clock going back as no time passing, without ever waiting longer than resetTimeout', async function () {
			const clock = manualClock(10_000);
			const guarded = createCircuitBreaker(
				function (): number {
					return 1;
				},
				{ resetTimeout: 100, now: clock.now }
			);
			guarded.open();
			clock.set(0);
			await expect(guarded()).rejects.toMatchObject({ retryAfter: 100 });
			clock.set(99);
			expect(guarded.state).toBe('open');
			clock.set(100);
			expect(guarded.state).toBe('half-open');
		});

		it('defaults to Date.now, a threshold of 5 and a reset timeout of 30 s', async function () {
			jest.useFakeTimers({ now: 0 });
			const guarded = createCircuitBreaker(function (): Promise<never> {
				return Promise.reject(new Error('down'));
			});
			for (let i = 0; i < 4; i++) await expect(guarded()).rejects.toThrow('down');
			expect(guarded.state).toBe('closed');
			await expect(guarded()).rejects.toThrow('down');
			expect(guarded.state).toBe('open');
			jest.setSystemTime(29_999);
			expect(guarded.state).toBe('open');
			jest.setSystemTime(30_000);
			expect(guarded.state).toBe('half-open');
		});

		it('reads the clock only while the circuit opens or is open', async function () {
			let time = 0;
			const now = jest.fn(function () {
				return time;
			});
			const guarded = createCircuitBreaker(
				function (): string {
					return 'ok';
				},
				{ resetTimeout: 10, now }
			);
			await guarded();
			guarded.reset();
			expect(guarded.state).toBe('closed');
			expect(now).not.toHaveBeenCalled();
			guarded.open();
			expect(now).toHaveBeenCalledTimes(1);
			time = 10;
			// The switch to half-open and the trial's success read it once more (to see that the timeout elapsed), not when entering.
			await guarded();
			expect(now).toHaveBeenCalledTimes(2);
			guarded.open();
			now.mockReturnValue(NaN);
			guarded.reset();
			expect(guarded.stats.state).toBe('closed');
		});

		it('validates now() whenever it reads the clock, changing nothing when it is invalid', async function () {
			let time: unknown = 0;
			const guarded = createCircuitBreaker(
				function (): Promise<never> {
					return Promise.reject(new Error('down'));
				},
				{
					failureThreshold: 1,
					now: function () {
						return time as number;
					}
				}
			);
			for (const [value, message] of [
				[NaN, 'createCircuitBreaker: `now()` must be a finite number, got NaN'],
				[Infinity, 'createCircuitBreaker: `now()` must be a finite number, got Infinity'],
				['5', 'createCircuitBreaker: `now()` must be a finite number, got string']
			]) {
				time = value;
				expect(function () {
					guarded.open();
				}).toThrow(message as string);
				expect(guarded.state).toBe('closed');
				// The failure that should open the circuit rejects with the clock's error.
				await expect(guarded()).rejects.toThrow(message as string);
				expect(guarded.state).toBe('closed');
			}
			time = 0;
			guarded.open();
			time = NaN;
			await expect(guarded()).rejects.toThrow(RangeError);
			time = null;
			expect(function () {
				return guarded.stats;
			}).toThrow(TypeError);
		});

		it('returns a null-prototype snapshot from stats', function () {
			const guarded = createCircuitBreaker(function (): number {
				return 1;
			});
			const stats = guarded.stats;
			expect(Object.getPrototypeOf(stats)).toBe(null);
			guarded.open();
			expect(stats.state).toBe('closed');
			expect(guarded.stats.state).toBe('open');
			expect(guarded.stats).not.toBe(guarded.stats);
		});

		it('validates its arguments and ignores options inherited from a polluted Object.prototype', async function () {
			function ok(): number {
				return 1;
			}
			expect(function () {
				createCircuitBreaker('x' as never);
			}).toThrow(new TypeError('createCircuitBreaker: `fn` must be a function, got string'));
			expect(function () {
				createCircuitBreaker(ok, { failureThreshold: 0 });
			}).toThrow(new RangeError('createCircuitBreaker: `failureThreshold` must be an integer >= 1, got 0'));
			expect(function () {
				createCircuitBreaker(ok, { failureThreshold: 1.5 });
			}).toThrow(RangeError);
			expect(function () {
				createCircuitBreaker(ok, { resetTimeout: -1 });
			}).toThrow(new RangeError('createCircuitBreaker: `resetTimeout` must be Infinity or a number between 0 and 2147483647, got -1'));
			expect(function () {
				createCircuitBreaker(ok, { resetTimeout: 2 ** 31 });
			}).toThrow(RangeError);
			expect(function () {
				createCircuitBreaker(ok, { halfOpenMaxCalls: 0 });
			}).toThrow(new RangeError('createCircuitBreaker: `halfOpenMaxCalls` must be an integer >= 1, got 0'));
			expect(function () {
				createCircuitBreaker(ok, { isFailure: 1 as never });
			}).toThrow(new TypeError('createCircuitBreaker: `isFailure` must be a function, got number'));
			expect(function () {
				createCircuitBreaker(ok, { onStateChange: {} as never });
			}).toThrow(new TypeError('createCircuitBreaker: `onStateChange` must be a function, got object'));
			expect(function () {
				createCircuitBreaker(ok, { now: null as never });
			}).toThrow(new TypeError('createCircuitBreaker: `now` must be a function, got null'));
			expect(function () {
				createCircuitBreaker(ok, null as never);
			}).toThrow(TypeError);
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.failureThreshold = 1;
			prototype.isFailure = 'nope';
			try {
				const guarded = createCircuitBreaker(function (): Promise<never> {
					return Promise.reject(new Error('down'));
				});
				await expect(guarded()).rejects.toThrow('down');
				expect(guarded.state).toBe('closed');
			} finally {
				delete prototype.failureThreshold;
				delete prototype.isFailure;
			}
		});
	});

	describe('backoff', function () {
		/**
		 * The first `count` delays of an (endless) backoff.
		 */
		function take(delays: Iterable<number>, count: number): number[] {
			const result: number[] = [];
			for (const delay of delays) {
				if (result.length === count) break;
				result.push(delay);
			}
			return result;
		}

		/**
		 * A random source replaying `values` (cycling).
		 */
		function replay(values: number[]): jest.Mock<number, []> {
			let index = 0;
			return jest.fn(function () {
				return values[index++ % values.length];
			});
		}

		it('grows exponentially from delay up to maxDelay, endlessly by default', function () {
			expect(take(backoff(), 12)).toEqual([100, 200, 400, 800, 1600, 3200, 6400, 12_800, 25_600, 30_000, 30_000, 30_000]);
			expect([...backoff({ delay: 1000, factor: 3, maxDelay: 5000, retries: 4 })]).toEqual([1000, 3000, 5000, 5000]);
			expect([...backoff({ delay: 10, factor: 1, retries: 3 })]).toEqual([10, 10, 10]);
			expect([...backoff({ delay: 10, factor: 1.5, retries: 4 })]).toEqual([10, 15, 22.5, 33.75]);
			// Above max from the start, or zero.
			expect([...backoff({ delay: 500, maxDelay: 100, retries: 2 })]).toEqual([100, 100]);
			expect([...backoff({ delay: 0, retries: 3 })]).toEqual([0, 0, 0]);
			expect([...backoff({ maxDelay: 0, retries: 2 })]).toEqual([0, 0]);
			expect([...backoff({ retries: 0 })]).toEqual([]);
		});

		it('never overflows, whatever the factor and the number of delays', function () {
			expect([...backoff({ delay: 2 ** 31 - 1, factor: Number.MAX_VALUE, maxDelay: 2 ** 31 - 1, retries: 3 })]).toEqual([2 ** 31 - 1, 2 ** 31 - 1, 2 ** 31 - 1]);
			expect([...backoff({ delay: 1, factor: 1e300, maxDelay: 1000, retries: 3 })]).toEqual([1, 1000, 1000]);
			const iterator = backoff({ factor: 1e300, jitter: 'decorrelated', random: replay([0.5, 0.999_999]) })[Symbol.iterator]();
			for (let i = 0; i < 1000; i++) {
				const { value } = iterator.next();
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(30_000);
			}
		});

		it('applies full, equal and decorrelated jitter as in the AWS article', function () {
			expect([...backoff({ retries: 3, jitter: 'full', random: replay([0.5]) })]).toEqual([50, 100, 200]);
			expect([...backoff({ retries: 3, jitter: 'full', random: replay([0]) })]).toEqual([0, 0, 0]);
			expect([...backoff({ retries: 3, jitter: 'equal', random: replay([0.5]) })]).toEqual([75, 150, 300]);
			expect([...backoff({ retries: 3, jitter: 'equal', random: replay([0]) })]).toEqual([50, 100, 200]);
			// sleep = min(maxDelay, uniform(delay, sleep * factor)), from sleep = delay.
			expect([...backoff({ retries: 4, factor: 3, jitter: 'decorrelated', random: replay([0.5]) })]).toEqual([200, 350, 575, 912.5]);
			expect([...backoff({ retries: 3, factor: 3, jitter: 'decorrelated', random: replay([0]) })]).toEqual([100, 100, 100]);
			expect([...backoff({ retries: 3, factor: 3, maxDelay: 250, jitter: 'decorrelated', random: replay([0.9]) })]).toEqual([250, 250, 250]);
			expect([...backoff({ delay: 500, maxDelay: 100, retries: 2, jitter: 'decorrelated', random: replay([0.5]) })]).toEqual([100, 100]);
		});

		it('draws exactly once per delay, never for no jitter, and validates what random() returns', function () {
			const random = replay([0.25]);
			expect([...backoff({ retries: 5, jitter: 'equal', random })]).toHaveLength(5);
			expect(random).toHaveBeenCalledTimes(5);
			const unused = replay([0.25]);
			expect([...backoff({ retries: 5, random: unused })]).toHaveLength(5);
			expect(unused).not.toHaveBeenCalled();
			expect([...backoff({ retries: 5, random: 'ignored' as never })]).toHaveLength(5);
			for (const jitter of ['full', 'equal', 'decorrelated'] as const) {
				expect(function () {
					return [
						...backoff({
							retries: 1,
							jitter,
							random: function () {
								return 1;
							}
						})
					];
				}).toThrow(new RangeError('backoff: `random()` must return a number in [0, 1), got 1'));
			}
			const spy = jest.spyOn(Math, 'random');
			// The default is read when `backoff` is called.
			expect([...backoff({ retries: 2, jitter: 'full' })]).toHaveLength(2);
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('starts over at each iteration; its iterators are iterable and stay done', function () {
			const delays = backoff({ retries: 3, jitter: 'decorrelated', random: replay([0.1, 0.7, 0.4]) });
			const first = [...delays];
			expect(first).toHaveLength(3);
			const iterator = delays[Symbol.iterator]() as IterableIterator<number>;
			expect(iterator[Symbol.iterator]()).toBe(iterator);
			expect([...iterator]).toEqual(first);
			expect(iterator.next()).toEqual({ value: undefined, done: true });
			expect(iterator.next()).toEqual({ value: undefined, done: true });
		});

		it('validates its options', function () {
			expect(function () {
				backoff({ delay: -1 });
			}).toThrow(new RangeError('backoff: `delay` must be a number between 0 and 2147483647, got -1'));
			expect(function () {
				backoff({ delay: NaN });
			}).toThrow(RangeError);
			expect(function () {
				backoff({ delay: '1' as never });
			}).toThrow(TypeError);
			expect(function () {
				backoff({ factor: 0.5 });
			}).toThrow(new RangeError('backoff: `factor` must be a finite number >= 1, got 0.5'));
			expect(function () {
				backoff({ factor: 1 - Number.EPSILON / 2 });
			}).toThrow(RangeError);
			expect(function () {
				backoff({ factor: Infinity });
			}).toThrow(RangeError);
			expect(function () {
				backoff({ factor: '2' as never });
			}).toThrow(TypeError);
			expect(function () {
				backoff({ maxDelay: 2 ** 31 });
			}).toThrow(new RangeError('backoff: `maxDelay` must be a number between 0 and 2147483647, got 2147483648'));
			expect(function () {
				backoff({ maxDelay: Infinity });
			}).toThrow(RangeError);
			expect(function () {
				backoff({ jitter: 'random' as never });
			}).toThrow(new RangeError("backoff: `jitter` must be 'none', 'full', 'equal' or 'decorrelated', got random"));
			expect(function () {
				backoff({ jitter: true as never });
			}).toThrow(new TypeError("backoff: `jitter` must be 'none', 'full', 'equal' or 'decorrelated', got true"));
			expect(function () {
				backoff({ retries: -1 });
			}).toThrow(new RangeError('backoff: `retries` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				backoff({ jitter: 'full', random: 'x' as never });
			}).toThrow(new TypeError('backoff: `random` must be a function, got string'));
			expect(function () {
				backoff(null as never);
			}).toThrow(TypeError);
		});
	});

	describe('fromEvent', function () {
		/**
		 * An EventTarget-like object that tracks its listeners (dispatching to a snapshot, like `EventTarget`).
		 */
		class CountingTarget {
			readonly listeners = new Map<string, Set<(event: unknown) => void>>();
			addThrows = false;
			removeThrows = false;

			get size(): number {
				let count = 0;
				for (const set of this.listeners.values()) count += set.size;
				return count;
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				if (this.addThrows) throw new Error('add failed');
				let set = this.listeners.get(type);
				if (set === undefined) this.listeners.set(type, (set = new Set()));
				set.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
				if (this.removeThrows) throw new Error('remove failed');
			}

			dispatch(type: string, event: unknown): void {
				for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
			}
		}

		it('buffers the events of an EventTarget until they are read, in order, and removes its listener on break', async function () {
			const target = new EventTarget();
			const iterator = fromEvent(target, 'ping');
			const first = new Event('ping');
			target.dispatchEvent(first);
			target.dispatchEvent(new Event('pong'));
			target.dispatchEvent(new Event('ping'));
			const seen: Event[] = [];
			for await (const event of iterator) {
				seen.push(event as Event);
				if (seen.length === 2) break;
			}
			expect(seen[0]).toBe(first);
			expect(seen.map(String)).toHaveLength(2);
			target.dispatchEvent(new Event('ping'));
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
			const counting = new CountingTarget();
			const counted = fromEvent(counting as unknown as EventTarget, 'x');
			expect(counting.size).toBe(1);
			expect(counted[Symbol.asyncIterator]()).toBe(counted);
			await counted.return?.();
			expect(counting.size).toBe(0);
		});

		it('yields the first argument of Node-style emitters (on/off and addListener/removeListener)', async function () {
			const emitter = new EventEmitter();
			const messages = fromEvent<string>(emitter, 'message');
			emitter.emit('message', 'a', 'ignored');
			emitter.emit('message', 'b');
			await expect(messages.next()).resolves.toEqual({ value: 'a', done: false });
			await expect(messages.next()).resolves.toEqual({ value: 'b', done: false });
			const pending = messages.next();
			emitter.emit('message', 'c');
			await expect(pending).resolves.toEqual({ value: 'c', done: false });
			await messages.return?.();
			expect(emitter.listenerCount('message')).toBe(0);

			const listeners = new Set<(value: unknown) => void>();
			const legacy = {
				addListener: function (_type: string, listener: (value: unknown) => void) {
					listeners.add(listener);
				},
				removeListener: function (_type: string, listener: (value: unknown) => void) {
					listeners.delete(listener);
				}
			};
			const symbol = Symbol('tick');
			const ticks = fromEvent<number>(legacy, symbol);
			for (const listener of listeners) listener(1);
			await expect(ticks.next()).resolves.toEqual({ value: 1, done: false });
			await ticks.return?.();
			expect(listeners.size).toBe(0);

			const events = createEmitter<{ saved: { id: number } }>();
			const saves = fromEvent<{ id: number }>(events, 'saved');
			events.emit('saved', { id: 7 });
			await expect(saves.next()).resolves.toEqual({ value: { id: 7 }, done: false });
			await saves.return?.();
		});

		it('serves concurrent reads in order', async function () {
			const emitter = new EventEmitter();
			const iterator = fromEvent<number>(emitter, 'n');
			const reads = [iterator.next(), iterator.next(), iterator.next()];
			emitter.emit('n', 1);
			emitter.emit('n', 2);
			await expect(reads[0]).resolves.toEqual({ value: 1, done: false });
			await expect(reads[1]).resolves.toEqual({ value: 2, done: false });
			expect(await stateOf(reads[2])).toBe('pending');
			await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
			await expect(reads[2]).resolves.toEqual({ value: undefined, done: true });
			await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
			// return() discards the unread events.
			const unread = fromEvent<number>(emitter, 'n');
			emitter.emit('n', 1);
			emitter.emit('n', 2);
			await unread.return?.();
			await expect(unread.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('serves many pending reads in linear time (previously quadratic: an Array#shift queue)', async function () {
			/**
			 * Times `n` events, each handed to one of `n` reads made beforehand.
			 * @param {number} n - The number of reads
			 * @returns {Promise<number>} The time in ms
			 */
			async function time(n: number): Promise<number> {
				const emitter = new EventEmitter();
				const iterator = fromEvent<number>(emitter, 'n');
				const reads: Array<Promise<IteratorResult<number>>> = [];
				for (let i = 0; i < n; i++) reads.push(iterator.next());
				const start = performance.now();
				for (let i = 0; i < n; i++) emitter.emit('n', i);
				const elapsed = performance.now() - start;
				expect((await reads[n - 1]).value).toBe(n - 1);
				await iterator.return?.();
				return elapsed;
			}
			await time(10_000);
			const small = await time(10_000);
			// Eight times the reads: about 8 times as long (64 times, quadratic: 100,000 reads took 8 s).
			expect(await time(80_000)).toBeLessThan(small * 20 + 200);
		});

		it('fails with a rejectOn event after the buffered events, removing every listener at once', async function () {
			const emitter = new EventEmitter();
			const iterator = fromEvent<string>(emitter, 'data', { rejectOn: ['error', 'close'] });
			expect(emitter.listenerCount('error') + emitter.listenerCount('close')).toBe(2);
			const failure = new Error('reset');
			emitter.emit('data', 'a');
			emitter.emit('error', failure);
			expect(emitter.listenerCount('data') + emitter.listenerCount('error') + emitter.listenerCount('close')).toBe(0);
			emitter.emit('data', 'b');
			await expect(iterator.next()).resolves.toEqual({ value: 'a', done: false });
			await expect(iterator.next()).rejects.toBe(failure);
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });

			const pendingTarget = new EventEmitter();
			const pendingIterator = fromEvent(pendingTarget, 'data', { rejectOn: ['close'] });
			const reads = [pendingIterator.next(), pendingIterator.next()];
			pendingTarget.emit('close', 'closed');
			await expect(reads[0]).rejects.toBe('closed');
			await expect(reads[1]).resolves.toEqual({ value: undefined, done: true });
			await expect(pendingIterator.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('skips the events filter rejects, and fails with the error filter throws', async function () {
			const emitter = new EventEmitter();
			const iterator = fromEvent<number>(emitter, 'n', {
				filter: function (n) {
					if (n < 0) throw new RangeError('negative');
					return n % 2 === 0;
				}
			});
			emitter.emit('n', 1);
			emitter.emit('n', 2);
			emitter.emit('n', -1);
			emitter.emit('n', 4);
			expect(emitter.listenerCount('n')).toBe(0);
			await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
			await expect(iterator.next()).rejects.toThrow(new RangeError('negative'));
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('drops an event whose filter ended the iteration', async function () {
			const emitter = new EventEmitter();
			const failure = new Error('during filter');
			const failing = fromEvent<number>(emitter, 'n', {
				rejectOn: ['error'],
				filter: function () {
					emitter.emit('error', failure);
					return true;
				}
			});
			emitter.emit('n', 1);
			await expect(failing.next()).rejects.toBe(failure);
			const closing: AsyncIterableIterator<number> = fromEvent<number>(emitter, 'm', {
				filter: function () {
					void closing.return?.();
					return true;
				}
			});
			const pending = closing.next();
			emitter.emit('m', 1);
			await expect(pending).resolves.toEqual({ value: undefined, done: true });
			await expect(closing.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('bounds the buffer: throw (the default), drop-oldest and drop-newest', async function () {
			const emitter = new EventEmitter();
			const strict = fromEvent<number>(emitter, 'n', { bufferSize: 2 });
			const oldest = fromEvent<number>(emitter, 'n', { bufferSize: 2, overflow: 'drop-oldest' });
			const newest = fromEvent<number>(emitter, 'n', { bufferSize: 2, overflow: 'drop-newest' });
			const none = fromEvent<number>(emitter, 'n', { bufferSize: 0, overflow: 'drop-oldest' });
			const pending = none.next();
			for (let n = 1; n <= 4; n++) emitter.emit('n', n);
			expect(emitter.listenerCount('n')).toBe(3);
			await expect(strict.next()).resolves.toEqual({ value: 1, done: false });
			await expect(strict.next()).resolves.toEqual({ value: 2, done: false });
			await expect(strict.next()).rejects.toThrow(new RangeError('fromEvent: more than 2 events are waiting to be read (`bufferSize` is 2)'));
			await expect(strict.next()).resolves.toEqual({ value: undefined, done: true });
			await expect(pending).resolves.toEqual({ value: 1, done: false });
			const values: number[] = [];
			for (const iterator of [oldest, newest]) {
				values.push(((await iterator.next()).value as number) * 10 + ((await iterator.next()).value as number));
			}
			expect(values).toEqual([34, 12]);
			const empty = none.next();
			emitter.emit('n', 5);
			await expect(empty).resolves.toEqual({ value: 5, done: false });
			emitter.emit('n', 6);
			for (const iterator of [oldest, newest, none]) await iterator.return?.();
			expect(emitter.listenerCount('n')).toBe(0);
		});

		it('keeps reading in order across buffer compactions', async function () {
			const emitter = new EventEmitter();
			const iterator = fromEvent<number>(emitter, 'n');
			let emitted = 0;
			let read = 0;
			for (let round = 0; round < 4; round++) {
				for (let i = 0; i < 3000; i++) emitter.emit('n', emitted++);
				for (let i = 0; i < 2000; i++) expect((await iterator.next()).value).toBe(read++);
			}
			while (read < emitted) expect((await iterator.next()).value).toBe(read++);
			await iterator.return?.();
		});

		it('ends at once when signal aborts: the next read rejects with its reason, unread events are discarded', async function () {
			const emitter = new EventEmitter();
			const controller = new AbortController();
			const signal = new CountingSignal();
			const iterator = fromEvent<number>(emitter, 'n', { signal });
			expect(signal.listenerCount).toBe(1);
			emitter.emit('n', 1);
			signal.abort(new Error('stop'));
			expect(signal.listenerCount).toBe(0);
			expect(emitter.listenerCount('n')).toBe(0);
			await expect(iterator.next()).rejects.toThrow('stop');
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });

			const waiting = fromEvent(emitter, 'n', { signal: controller.signal });
			const reads = [waiting.next(), waiting.next()];
			controller.abort();
			await expect(reads[0]).rejects.toBeInstanceOf(DOMException);
			await expect(reads[1]).resolves.toEqual({ value: undefined, done: true });

			const reasonless = new CountingSignal();
			const plain = fromEvent(emitter, 'n', { signal: reasonless });
			reasonless.abort();
			await expect(plain.next()).rejects.toThrow(new AbortError());

			// Closed first: the abort listener is gone.
			const closedSignal = new CountingSignal();
			const closed = fromEvent(emitter, 'n', { signal: closedSignal });
			await closed.return?.();
			expect(closedSignal.listenerCount).toBe(0);
		});

		it('adds no listener for an already-aborted signal, and rejects the first read', async function () {
			const target = new CountingTarget();
			const signal = new CountingSignal();
			signal.abort('gone');
			const iterator = fromEvent(target as unknown as EventTarget, 'x', { signal });
			expect(target.size).toBe(0);
			expect(signal.listenerCount).toBe(0);
			await expect(iterator.next()).rejects.toBe('gone');
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('ignores events delivered to a listener that was being removed', async function () {
			const emitter = new EventEmitter();
			const iterator = fromEvent<number>(emitter, 'n');
			// Registered second: Node's emitter still calls it during the emit that closes the iterator.
			emitter.prependListener('n', function () {
				void iterator.return?.();
			});
			emitter.emit('n', 1);
			await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
			// The same for a `rejectOn` listener: the iteration stays ended, not failed.
			const failing = fromEvent(emitter, 'n', { rejectOn: ['error'] });
			emitter.prependListener('error', function () {
				void failing.return?.();
			});
			emitter.emit('error', new Error('late'));
			await expect(failing.next()).resolves.toEqual({ value: undefined, done: true });
		});

		it('handles emitters calling listeners while they are added', async function () {
			const listeners: Array<[unknown, (value: unknown) => void]> = [];
			const replaying = {
				on: function (type: unknown, listener: (value: unknown) => void) {
					listeners.push([type, listener]);
					listener(type === 'data' ? 'replayed' : new Error(`replayed ${String(type)}`));
				},
				off: function (type: unknown, listener: (value: unknown) => void) {
					const index = listeners.findIndex(function ([t, l]) {
						return t === type && l === listener;
					});
					listeners.splice(index, 1);
				}
			};
			const quiet = fromEvent(replaying, 'data');
			await expect(quiet.next()).resolves.toEqual({ value: 'replayed', done: false });
			await quiet.return?.();
			expect(listeners).toHaveLength(0);
			const failing = fromEvent(replaying, 'data', { rejectOn: ['error', 'close'] });
			// The replayed error ended the iteration: no `close` listener was added, the others were removed.
			expect(listeners).toHaveLength(0);
			await expect(failing.next()).resolves.toEqual({ value: 'replayed', done: false });
			await expect(failing.next()).rejects.toThrow('replayed error');
		});

		it('shares its listener code with waitForEvent, which starts no timer for an event replayed while its listener is added', async function () {
			jest.useFakeTimers();
			const replaying = {
				on: function (_type: string, listener: (value: unknown) => void) {
					listener('now');
				},
				off: function () {}
			};
			await expect(waitForEvent(replaying, 'ready', { timeout: 1000 })).resolves.toBe('now');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('rethrows when adding a listener fails, leaving no listener behind; tolerates removals that throw', async function () {
			const target = new CountingTarget();
			const signal = new CountingSignal();
			let adds = 0;
			const flaky = {
				addEventListener: function (type: string, listener: (event: unknown) => void) {
					if (++adds === 2) throw new Error('add failed');
					target.addEventListener(type, listener);
				},
				removeEventListener: function (type: string, listener: (event: unknown) => void) {
					target.removeEventListener(type, listener);
				}
			};
			expect(function () {
				fromEvent(flaky as unknown as EventTarget, 'x', { rejectOn: ['error'], signal });
			}).toThrow('add failed');
			expect(target.size).toBe(0);
			expect(signal.listenerCount).toBe(0);
			target.addThrows = true;
			expect(function () {
				fromEvent(target as unknown as EventTarget, 'x');
			}).toThrow('add failed');
			target.addThrows = false;
			const iterator = fromEvent(target as unknown as EventTarget, 'x', { rejectOn: ['error'] });
			target.removeThrows = true;
			await iterator.return?.();
			expect(target.size).toBe(0);
		});

		it('validates its arguments', function () {
			const target = new EventTarget();
			expect(function () {
				fromEvent({} as never, 'x');
			}).toThrow(new TypeError('fromEvent: `target` must be an EventTarget or an event emitter, got object'));
			expect(function () {
				fromEvent(null as never, 'x');
			}).toThrow(new TypeError('fromEvent: `target` must be an EventTarget or an event emitter, got null'));
			expect(function () {
				fromEvent(target, 1 as never);
			}).toThrow(new TypeError('fromEvent: `type` must be a string or a symbol, got number'));
			expect(function () {
				fromEvent(target, 'x', { filter: 'x' as never });
			}).toThrow(new TypeError('fromEvent: `filter` must be a function, got string'));
			expect(function () {
				fromEvent(target, 'x', { rejectOn: 'error' as never });
			}).toThrow(new TypeError('fromEvent: `rejectOn` must be an array, got string'));
			expect(function () {
				fromEvent(target, 'x', { rejectOn: ['error', 1 as never] });
			}).toThrow(new TypeError('fromEvent: `rejectOn[1]` must be a string or a symbol, got number'));
			expect(function () {
				fromEvent(target, 'x', { bufferSize: -1 });
			}).toThrow(new RangeError('fromEvent: `bufferSize` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				fromEvent(target, 'x', { overflow: 'drop' as never });
			}).toThrow(new RangeError("fromEvent: `overflow` must be 'throw', 'drop-oldest' or 'drop-newest', got drop"));
			expect(function () {
				fromEvent(target, 'x', { overflow: 1 as never });
			}).toThrow(new TypeError("fromEvent: `overflow` must be 'throw', 'drop-oldest' or 'drop-newest', got 1"));
			expect(function () {
				fromEvent(target, 'x', { signal: {} as never });
			}).toThrow(new TypeError('fromEvent: `signal` must be an AbortSignal, null or undefined, got object'));
			expect(function () {
				fromEvent(target, 'x', null as never);
			}).toThrow(TypeError);
			// waitForEvent keeps its own messages.
			return expect(waitForEvent(target, 1 as never)).rejects.toThrow(new TypeError('waitForEvent: `type` must be a string or a symbol, got number'));
		});
	});

	describe('interval', function () {
		it('ticks every ms milliseconds, numbering the ticks, until stopped', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: Array<[number, number]> = [];
			const stop = interval(function (tick) {
				ticks.push([tick, performance.now()]);
			}, 100);
			expect(ticks).toEqual([]);
			await jest.advanceTimersByTimeAsync(350);
			expect(ticks).toEqual([
				[1, 100],
				[2, 200],
				[3, 300]
			]);
			stop();
			stop();
			expect(jest.getTimerCount()).toBe(0);
			await jest.advanceTimersByTimeAsync(1000);
			expect(ticks).toHaveLength(3);
		});

		it('runs tick 0 at once with immediate', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: number[] = [];
			const stop = interval(
				function (tick) {
					ticks.push(tick);
				},
				50,
				{ immediate: true }
			);
			expect(ticks).toEqual([0]);
			await jest.advanceTimersByTimeAsync(100);
			expect(ticks).toEqual([0, 1, 2]);
			stop();
		});

		it('does not drift: each tick is scheduled relative to the start, whatever the callback costs', async function () {
			jest.useFakeTimers({ now: 0 });
			let clock = 0;
			jest.spyOn(performance, 'now').mockImplementation(function () {
				return clock;
			});
			const delays: number[] = [];
			const realSetTimeout = globalThis.setTimeout;
			jest.spyOn(globalThis, 'setTimeout').mockImplementation(function (handler: () => void, ms?: number) {
				delays.push(ms as number);
				return realSetTimeout(handler, ms);
			} as typeof setTimeout);
			const ticks: number[] = [];
			const stop = interval(function (tick) {
				ticks.push(tick);
				// Each call takes 30 ms.
				clock += 30;
			}, 100);
			clock = 100;
			await jest.advanceTimersByTimeAsync(100);
			expect(delays).toEqual([100, 70]);
			clock = 200;
			await jest.advanceTimersByTimeAsync(70);
			expect(delays).toEqual([100, 70, 70]);
			expect(ticks).toEqual([1, 2]);
			stop();
		});

		it('skips the ticks missed while an async callback runs, without overlapping it', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: Array<[number, number]> = [];
			let running = 0;
			let overlap = false;
			const stop = interval(async function (tick) {
				ticks.push([tick, performance.now()]);
				if (++running > 1) overlap = true;
				if (tick === 1) {
					await sleep(250);
					// No timer of the interval while the callback runs (only this sleep's).
				}
				running--;
			}, 100);
			await jest.advanceTimersByTimeAsync(100);
			expect(jest.getTimerCount()).toBe(1);
			await jest.advanceTimersByTimeAsync(450);
			stop();
			expect(overlap).toBe(false);
			// Tick 1 ran from 100 to 350: ticks 2 and 3 are skipped, tick 4 comes on schedule.
			expect(ticks).toEqual([
				[1, 100],
				[4, 400],
				[5, 500]
			]);
		});

		it('runs a tick that is due exactly when an async callback settles', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: Array<[number, number]> = [];
			const stop = interval(async function (tick) {
				ticks.push([tick, performance.now()]);
				if (tick === 1) await sleep(100);
			}, 100);
			await jest.advanceTimersByTimeAsync(300);
			stop();
			// Due at once: a 0 ms timeout, which Node (and the fake timers) runs 1 ms later; tick 3 is back on schedule.
			expect(ticks).toEqual([
				[1, 100],
				[2, 201],
				[3, 300]
			]);
		});

		it('runs the latest due tick when a timer fires late, then goes back on schedule', async function () {
			jest.useFakeTimers({ now: 0 });
			let clock = 0;
			jest.spyOn(performance, 'now').mockImplementation(function () {
				return clock;
			});
			const delays: number[] = [];
			const realSetTimeout = globalThis.setTimeout;
			jest.spyOn(globalThis, 'setTimeout').mockImplementation(function (handler: () => void, ms?: number) {
				delays.push(ms as number);
				return realSetTimeout(handler, ms);
			} as typeof setTimeout);
			const ticks: number[] = [];
			const stop = interval(function (tick) {
				ticks.push(tick);
			}, 100);
			expect(delays).toEqual([100]);
			// The first timer fires at 345 (the event loop was blocked): tick 3 runs, the next one is due at 400.
			clock = 345;
			await jest.advanceTimersByTimeAsync(100);
			expect(ticks).toEqual([3]);
			expect(delays).toEqual([100, 55]);
			// A timer firing a little early still runs the tick it was armed for.
			clock = 399.5;
			await jest.advanceTimersByTimeAsync(55);
			expect(ticks).toEqual([3, 4]);
			expect(delays).toEqual([100, 55, 100]);
			// A clock that went back: the wait is capped at ms.
			clock = 100;
			await jest.advanceTimersByTimeAsync(100);
			expect(ticks).toEqual([3, 4, 5]);
			expect(delays).toEqual([100, 55, 100, 100]);
			stop();
		});

		it('falls back to Date.now without performance', async function () {
			jest.useFakeTimers({ now: 0 });
			jest.replaceProperty(globalThis, 'performance', undefined as never);
			const ticks: number[] = [];
			const stop = interval(function (tick) {
				ticks.push(tick);
			}, 10);
			await jest.advanceTimersByTimeAsync(30);
			stop();
			expect(ticks).toEqual([1, 2, 3]);
		});

		it('can be stopped from within the callback, and by its signal', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: number[] = [];
			const stop = interval(function (tick) {
				ticks.push(tick);
				if (tick === 2) stop();
			}, 10);
			await jest.advanceTimersByTimeAsync(100);
			expect(ticks).toEqual([1, 2]);
			expect(jest.getTimerCount()).toBe(0);

			const signal = new CountingSignal();
			const signalled: number[] = [];
			interval(
				function (tick) {
					signalled.push(tick);
				},
				10,
				{ signal }
			);
			expect(signal.listenerCount).toBe(1);
			await jest.advanceTimersByTimeAsync(25);
			signal.abort();
			expect(signal.listenerCount).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
			await jest.advanceTimersByTimeAsync(100);
			expect(signalled).toEqual([1, 2]);
		});

		it('stops after an async tick that was pending when it was stopped', async function () {
			jest.useFakeTimers({ now: 0 });
			const ticks: number[] = [];
			const stop = interval(async function (tick) {
				ticks.push(tick);
				await sleep(50);
			}, 10);
			await jest.advanceTimersByTimeAsync(20);
			stop();
			await jest.advanceTimersByTimeAsync(200);
			expect(ticks).toEqual([1]);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('starts nothing with an already-aborted signal', async function () {
			jest.useFakeTimers({ now: 0 });
			const signal = new CountingSignal();
			signal.abort();
			const callback = jest.fn();
			const stop = interval(callback, 10, { signal, immediate: true });
			expect(jest.getTimerCount()).toBe(0);
			expect(signal.listenerCount).toBe(0);
			await jest.advanceTimersByTimeAsync(100);
			expect(callback).not.toHaveBeenCalled();
			stop();
		});

		it('stops on an error of the callback, which surfaces as an unhandled rejection', async function () {
			const error = new Error('tick failed');
			const syncSignal = new CountingSignal();
			const syncCalls: number[] = [];
			const asyncCalls: number[] = [];
			const reasons = await unhandledDuring(async function () {
				interval(
					function (tick) {
						syncCalls.push(tick);
						throw error;
					},
					1,
					{ signal: syncSignal, immediate: true }
				);
				interval(async function (tick) {
					asyncCalls.push(tick);
					throw error;
				}, 1);
				await sleep(20);
			});
			expect(reasons).toEqual([error, error]);
			expect(syncCalls).toEqual([0]);
			expect(asyncCalls).toHaveLength(1);
			expect(syncSignal.listenerCount).toBe(0);
		});

		it('leaves no timer behind when adding the abort listener throws', function () {
			jest.useFakeTimers({ now: 0 });
			const signal = new CountingSignal();
			signal.addEventListener = function () {
				throw new Error('listener rejected');
			};
			expect(function () {
				interval(jest.fn(), 10, { signal });
			}).toThrow('listener rejected');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('validates its arguments', function () {
			function tick(): void {}
			expect(function () {
				interval('x' as never, 10);
			}).toThrow(new TypeError('interval: `callback` must be a function, got string'));
			for (const ms of [0, 0.5, -1, NaN, 2 ** 31, Infinity]) {
				expect(function () {
					interval(tick, ms);
				}).toThrow(new RangeError(`interval: \`ms\` must be a number between 1 and 2147483647, got ${ms}`));
			}
			expect(function () {
				interval(tick, '10' as never);
			}).toThrow(new TypeError('interval: `ms` must be a number between 1 and 2147483647, got string'));
			expect(function () {
				interval(tick, 10, { signal: 'x' as never });
			}).toThrow(new TypeError('interval: `signal` must be an AbortSignal, null or undefined, got string'));
			expect(function () {
				interval(tick, 10, null as never);
			}).toThrow(TypeError);
			jest.useFakeTimers();
			interval(tick, 1)();
			interval(tick, 2 ** 31 - 1)();
			expect(jest.getTimerCount()).toBe(0);
		});
	});

	describe('createStopwatch', function () {
		it('measures running time, pauses on stop, resumes on start, and laps', function () {
			const clock = manualClock(500);
			const watch = createStopwatch({ now: clock.now });
			expect(watch.running).toBe(false);
			expect(watch.elapsed).toBe(0);
			expect(watch.lap()).toBe(0);
			expect(watch.start()).toBe(watch);
			clock.advance(100);
			expect(watch.running).toBe(true);
			expect(watch.elapsed).toBe(100);
			// Starting again does nothing (the time since the last reading is kept).
			clock.advance(20);
			watch.start();
			clock.advance(30);
			expect(watch.elapsed).toBe(150);
			expect(watch.lap()).toBe(150);
			clock.advance(25);
			expect(watch.stop()).toBe(175);
			expect(watch.running).toBe(false);
			clock.advance(1000);
			expect(watch.elapsed).toBe(175);
			expect(watch.stop()).toBe(175);
			watch.start();
			clock.advance(5);
			expect(watch.lap()).toBe(30);
			expect(watch.elapsed).toBe(180);
			expect(watch.reset()).toBe(watch);
			expect(watch.running).toBe(false);
			expect(watch.elapsed).toBe(0);
			clock.advance(10);
			expect(watch.elapsed).toBe(0);
			watch.start();
			clock.advance(10);
			expect(watch.lap()).toBe(10);
		});

		it('counts a clock going back as no time passing: the measured time never decreases', function () {
			const clock = manualClock(1000);
			const watch = createStopwatch({ now: clock.now }).start();
			clock.advance(100);
			expect(watch.lap()).toBe(100);
			clock.set(0);
			expect(watch.elapsed).toBe(100);
			expect(watch.lap()).toBe(0);
			clock.set(50);
			expect(watch.stop()).toBe(150);
		});

		it('does not depend on this', function () {
			const clock = manualClock();
			const { start, stop, lap } = createStopwatch({ now: clock.now });
			start();
			clock.advance(7);
			expect(lap()).toBe(7);
			expect(stop()).toBe(7);
		});

		it('uses performance.now by default, and Date.now without performance', function () {
			jest.useFakeTimers({ now: 0 });
			const spy = jest.spyOn(performance, 'now');
			const watch = createStopwatch().start();
			jest.advanceTimersByTime(40);
			expect(watch.elapsed).toBe(40);
			expect(spy).toHaveBeenCalled();
			jest.replaceProperty(globalThis, 'performance', { now: 'broken' } as never);
			const fallback = createStopwatch().start();
			jest.setSystemTime(1000);
			expect(fallback.stop()).toBe(960);
		});

		it('validates now and what it returns', function () {
			expect(function () {
				createStopwatch({ now: 1 as never });
			}).toThrow(new TypeError('createStopwatch: `now` must be a function, got number'));
			expect(function () {
				createStopwatch(null as never);
			}).toThrow(TypeError);
			let time: unknown = NaN;
			const watch = createStopwatch({
				now: function () {
					return time as number;
				}
			});
			expect(function () {
				watch.start();
			}).toThrow(new RangeError('createStopwatch: `now()` must be a finite number, got NaN'));
			expect(watch.running).toBe(false);
			time = 'soon';
			expect(function () {
				watch.start();
			}).toThrow(new TypeError('createStopwatch: `now()` must be a finite number, got string'));
			time = 0;
			watch.start();
			time = -Infinity;
			expect(function () {
				return watch.elapsed;
			}).toThrow(new RangeError('createStopwatch: `now()` must be a finite number, got -Infinity'));
		});
	});
});

describe('Async helpers (options inherited from a polluted Object.prototype)', function () {
	const prototype = Object.prototype as Record<string, unknown>;
	const pollutedSignal = { aborted: true, reason: new Error('polluted'), addEventListener: noop, removeEventListener: noop };
	const poisonedCache = {
		get: function () {
			return 'poisoned';
		},
		has: yes,
		set: noop,
		delete: yes,
		clear: noop
	};

	/** Does nothing. */
	function noop(): void {
		return undefined;
	}

	/** Always `true`. */
	function yes(): boolean {
		return true;
	}

	/** Always `false`. */
	function no(): boolean {
		return false;
	}

	/** The same key for every argument. */
	function same(): string {
		return 'same';
	}

	/**
	 * Runs `fn` while `Object.prototype[key]` is `value`.
	 */
	async function polluted<T>(key: string, value: unknown, fn: () => Promise<T>): Promise<T> {
		Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
		try {
			return await fn();
		} finally {
			delete prototype[key];
		}
	}

	it('listens to a platform signal whatever listener options Object.prototype holds', async function () {
		for (const [key, value] of [
			['signal', pollutedSignal],
			['capture', true],
			['once', false]
		] as const) {
			const controller = new AbortController();
			await polluted(key, value, async function () {
				const slept = sleep(60_000, { signal: controller.signal });
				controller.abort(new Error('stop'));
				await expect(slept).rejects.toThrow('stop');
			});
		}
	});

	it('sleep and pollUntil ignore an inherited signal, interval or timeout', async function () {
		await polluted('signal', pollutedSignal, function () {
			return expect(sleep(0, {})).resolves.toBeUndefined();
		});
		await polluted('timeout', 0, function () {
			let calls = 0;
			return expect(
				pollUntil(
					function () {
						return ++calls === 3;
					},
					{ interval: 1 }
				)
			).resolves.toBe(true);
		});
		await polluted('interval', 'x', function () {
			return expect(
				pollUntil(function () {
					return 1;
				}, {})
			).resolves.toBe(1);
		});
	});

	it('retry ignores inherited options', async function () {
		for (const [key, value] of [
			['retries', 0],
			['shouldRetry', no],
			['signal', pollutedSignal],
			['delay', -1],
			['onRetry', 'x']
		] as const) {
			let attempts = 0;
			await polluted(key, value, function () {
				return expect(
					retry(function () {
						if (++attempts < 2) throw new Error('flaky');
						return attempts;
					}, {})
				).resolves.toBe(2);
			});
		}
	});

	it('the *WithConcurrency helpers ignore inherited options', async function () {
		function mapper(n: number): number {
			if (n === 1) throw new Error('one');
			return n;
		}
		await polluted('stopOnError', false, function () {
			return expect(mapWithConcurrency([1, 2], mapper, {})).rejects.toThrow('one');
		});
		await polluted('concurrency', 0.5, function () {
			return expect(filterWithConcurrency([1, 2], Boolean, {})).resolves.toEqual([1, 2]);
		});
		await polluted('signal', pollutedSignal, function () {
			return expect(mapSettledWithConcurrency([2], mapper, {})).resolves.toEqual([{ status: 'fulfilled', value: 2 }]);
		});
		// A number (or nothing) is still the concurrency.
		await polluted('concurrency', 0.5, function () {
			return expect(mapWithConcurrency([2, 3], mapper, 1)).resolves.toEqual([2, 3]);
		});
		await expect(mapWithConcurrency([2], mapper, null as never)).rejects.toThrow(TypeError);
	});

	it('createLimiter, createQueue, Queue.add and createRateLimiter ignore inherited options', async function () {
		await polluted('maxPending', 0, async function () {
			const limit = createLimiter(1, {});
			const first = limit(sleep, 1);
			await expect(limit(sleep, 1)).resolves.toBeUndefined();
			await first;
		});
		await polluted('concurrency', 0, function () {
			return expect(
				createQueue({}).add(function () {
					return 1;
				})
			).resolves.toBe(1);
		});
		await polluted('signal', pollutedSignal, async function () {
			const queue = createQueue({});
			await expect(
				queue.add(function () {
					return 2;
				}, {})
			).resolves.toBe(2);
			await expect(
				createRateLimiter({ limit: 1, interval: 10 }).schedule(function () {
					return 3;
				})
			).resolves.toBe(3);
		});
		await polluted('priority', 'high', function () {
			return expect(
				createQueue({}).add(function () {
					return 4;
				}, {})
			).resolves.toBe(4);
		});
		// `NaN` is not equal to itself: it is recognised as the polluted value all the same.
		await polluted('priority', NaN, function () {
			return expect(
				createQueue({}).add(function () {
					return 5;
				}, {})
			).resolves.toBe(5);
		});
		await polluted('limit', 5, async function () {
			expect(function () {
				createRateLimiter({ interval: 10 } as never);
			}).toThrow(new TypeError('createRateLimiter: `limit` must be an integer >= 1, got undefined'));
		});
	});

	it('memoizeAsync ignores an inherited cache, resolver or ttl', async function () {
		await polluted('cache', poisonedCache, async function () {
			const memoized = memoizeAsync(async function (n: number) {
				return n;
			}, {});
			await expect(memoized(1)).resolves.toBe(1);
			expect(memoized.cache).toBeInstanceOf(Map);
		});
		await polluted('resolver', same, async function () {
			const memoized = memoizeAsync(async function (n: number) {
				return n;
			}, {});
			await expect(Promise.all([memoized(1), memoized(2)])).resolves.toEqual([1, 2]);
		});
		await polluted('ttl', -1, async function () {
			expect(
				memoizeAsync(async function () {
					return 1;
				}, {}).cache
			).toBeInstanceOf(Map);
		});
	});

	it('createBatcher and its load options ignore inherited options', async function () {
		async function load(keys: number[]): Promise<number[]> {
			return keys;
		}
		await polluted('cache', poisonedCache, function () {
			return expect(createBatcher(load, {}).load(1)).resolves.toBe(1);
		});
		await polluted('key', same, function () {
			const batcher = createBatcher(load, {});
			return expect(Promise.all([batcher.load(1), batcher.load(2)])).resolves.toEqual([1, 2]);
		});
		await polluted('maxBatchSize', 0, function () {
			return expect(createBatcher(load, {}).loadMany([1, 2])).resolves.toEqual([1, 2]);
		});
		await polluted('delay', -1, function () {
			return expect(createBatcher(load, {}).load(3)).resolves.toBe(3);
		});
		await polluted('signal', pollutedSignal, async function () {
			const batcher = createBatcher(load);
			await expect(batcher.load(4, {})).resolves.toBe(4);
			await expect(batcher.loadMany([5], {})).resolves.toEqual([5]);
		});
	});
});

describe('Async helpers (one listener per shared signal, promises with their own then)', function () {
	afterEach(function () {
		jest.useRealTimers();
	});

	/**
	 * A native promise fulfilled with `value` whose own `then` getter throws: `await` ignores it, a `.then()` call throws.
	 * @param {T} value - The value
	 * @returns {Promise<T>} The promise
	 */
	function ownThen<T>(value: T): Promise<T> {
		const promise = Promise.resolve(value);
		Object.defineProperty(promise, 'then', {
			get: function () {
				throw new Error('then');
			}
		});
		return promise;
	}

	/**
	 * A signal that aborts as soon as a listener is added, calling it at once.
	 * @returns {AbortSignalLike} The signal
	 */
	function abortingOnAdd(): AbortSignalLike {
		const signal = {
			aborted: false,
			reason: 'stop',
			addEventListener: function (_type: string, listener: () => void) {
				signal.aborted = true;
				listener();
			},
			removeEventListener: jest.fn()
		};
		return signal;
	}

	it('sleep, abortable, pollUntil, the mappers, waitForEvent, fromEvent, interval and anySignal share one listener per signal (previously one each)', async function () {
		const signal = new CountingSignal();
		const target = new EventTarget();
		const ticks = jest.fn();
		const waits = [
			sleep(10_000, { signal }),
			sleep(10_000, { signal }),
			abortable(new Promise(function () {}), signal),
			pollUntil(
				function () {
					return false;
				},
				{ interval: 10_000, signal }
			),
			mapWithConcurrency(
				[1, 2],
				function () {
					return new Promise(function () {});
				},
				{ concurrency: 1, signal }
			),
			waitForEvent(target, 'ready', { signal }),
			fromEvent(target, 'ready', { signal }).next()
		];
		const stop = interval(ticks, 10_000, { signal });
		const combined = anySignal([signal]);
		const other = createQueue({ concurrency: 1 });
		const gate = createDeferred<void>();
		other.add(function () {
			return gate.promise;
		});
		const pool = createSemaphore(1);
		const held = pool.tryAcquire() as Release;
		waits.push(other.add(jest.fn(), { signal }), pool.acquire({ signal }));
		expect(signal.listenerCount).toBe(1);
		signal.abort('stop');
		for (const wait of waits) await expect(wait).rejects.toBe('stop');
		expect(combined.reason).toBe('stop');
		expect(signal.listenerCount).toBe(0);
		stop();
		expect(ticks).not.toHaveBeenCalled();
		gate.resolve();
		held();
		expect(pool.available).toBe(1);
	});

	it('start and abort many sleeps and abortable waits sharing a platform signal in linear time (previously 15 s for 30,000)', async function () {
		/**
		 * Times 30,000 sleeps and abortable waits, with or without a shared signal, then aborts them (or lets the sleeps end).
		 * @param {boolean} shared - Whether they share a signal
		 * @returns {Promise<number>} The time in ms
		 */
		async function time(shared: boolean): Promise<number> {
			const controller = new AbortController();
			const signal = shared ? controller.signal : undefined;
			const waits: Array<Promise<unknown>> = [];
			const start = performance.now();
			for (let i = 0; i < 15_000; i++) waits.push(sleep(shared ? 10_000 : 0, { signal }), abortable(shared ? new Promise(function () {}) : 1, signal));
			controller.abort();
			const elapsed = performance.now() - start;
			await Promise.allSettled(waits);
			return elapsed;
		}
		const alone = await time(false);
		expect(await time(true)).toBeLessThan(alone * 20 + 100);
	});

	it('createQueue and createRateLimiter listen to their own signal only while something waits (previously for good)', async function () {
		jest.useFakeTimers();
		const signal = new CountingSignal();
		const queue = createQueue({ concurrency: 1, signal });
		expect(signal.listenerCount).toBe(0);
		const gate = createDeferred<void>();
		const running = queue.add(function () {
			return gate.promise;
		});
		// The running task holds no listener of its own (it has no signal of its own to combine with).
		expect(signal.listenerCount).toBe(0);
		const waiting = queue.add(jest.fn().mockReturnValue('second'));
		const third = queue.add(jest.fn().mockReturnValue('third'));
		expect(signal.listenerCount).toBe(1);
		gate.resolve();
		await expect(Promise.all([running, waiting, third])).resolves.toEqual([undefined, 'second', 'third']);
		expect(signal.listenerCount).toBe(0);
		queue.pause();
		const dropped = queue.add(jest.fn());
		expect(signal.listenerCount).toBe(1);
		queue.clear();
		await expect(dropped).rejects.toBeInstanceOf(AbortError);
		expect(signal.listenerCount).toBe(0);
		const aborted = queue.add(jest.fn());
		signal.abort('stop');
		await expect(aborted).rejects.toBe('stop');
		await expect(queue.add(jest.fn())).rejects.toBe('stop');

		const limiterSignal = new CountingSignal();
		const limiter = createRateLimiter({ limit: 1, interval: 100, signal: limiterSignal });
		await expect(limiter.schedule(jest.fn().mockReturnValue(1))).resolves.toBe(1);
		expect(limiterSignal.listenerCount).toBe(0);
		const later = limiter.schedule(jest.fn().mockReturnValue(2));
		const last = limiter.schedule(jest.fn().mockReturnValue(3));
		expect(limiterSignal.listenerCount).toBe(1);
		jest.advanceTimersByTime(100);
		await expect(later).resolves.toBe(2);
		expect(limiterSignal.listenerCount).toBe(1);
		jest.advanceTimersByTime(100);
		await expect(last).resolves.toBe(3);
		expect(limiterSignal.listenerCount).toBe(0);
		const cleared = limiter.schedule(jest.fn());
		limiter.clearQueue();
		await expect(cleared).rejects.toBeInstanceOf(AbortError);
		expect(limiterSignal.listenerCount).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
		const stopped = limiter.schedule(jest.fn());
		limiterSignal.abort('stop');
		await expect(stopped).rejects.toBe('stop');
		expect(limiterSignal.listenerCount).toBe(0);
	});

	it('createQueue and createRateLimiter reject the call that cannot listen to their signal, and go on', async function () {
		const signal = {
			aborted: false,
			addEventListener: function () {
				throw new Error('add');
			},
			removeEventListener: jest.fn()
		};
		const queue = createQueue({ concurrency: 1, signal });
		const gate = createDeferred<void>();
		const running = queue.add(function () {
			return gate.promise;
		});
		await expect(queue.add(jest.fn())).rejects.toThrow('add');
		expect(queue.size).toBe(0);
		gate.resolve();
		await running;
		await queue.onIdle();
		await expect(queue.add(jest.fn().mockReturnValue(1))).resolves.toBe(1);
		const limiter = createRateLimiter({ limit: 1, interval: 50, signal });
		await expect(limiter.schedule(jest.fn().mockReturnValue(1))).resolves.toBe(1);
		await expect(limiter.schedule(jest.fn())).rejects.toThrow('add');
		expect(limiter.pendingCount).toBe(0);
	});

	it('a queued task that cannot listen to its own signal leaves the queue signal unwatched', async function () {
		const queueSignal = new CountingSignal();
		const queue = createQueue({ concurrency: 1, signal: queueSignal });
		queue.pause();
		const failing = { aborted: false, addEventListener: jest.fn().mockImplementation(boomAdd), removeEventListener: jest.fn() };
		await expect(queue.add(jest.fn(), { signal: failing })).rejects.toThrow('add');
		expect(queue.size).toBe(0);
		expect(queueSignal.listenerCount).toBe(0);

		/**
		 * Throws like a signal that cannot take listeners.
		 * @returns {never} Never returns
		 */
		function boomAdd(): never {
			throw new Error('add');
		}
	});

	it('a waiter unregistered by code an abort runs is not stopped by that abort (the queue stays consistent)', async function () {
		const controller = new AbortController();
		const queue = createQueue({ concurrency: 1 });
		queue.pause();
		// Aborting the signal aborts the combined one first, whose listener starts the waiting task (with the aborted signal).
		anySignal([controller.signal]).addEventListener('abort', function () {
			queue.resume();
		});
		const task = jest.fn().mockReturnValue('ran');
		const waiting = queue.add(task, { signal: controller.signal });
		controller.abort('stop');
		await expect(waiting).resolves.toBe('ran');
		expect(task).toHaveBeenCalledTimes(1);
		expect(queue.size).toBe(0);
		await expect(queue.add(jest.fn().mockReturnValue('next'))).resolves.toBe('next');
		expect(queue.size).toBe(0);
		expect(queue.pending).toBe(0);
	});

	it('sleep, pollUntil and interval stop at once for a signal that calls the listener while it is being added (previously a ReferenceError, a check, a tick)', async function () {
		jest.useFakeTimers();
		await expect(sleep(1000, { signal: abortingOnAdd() })).rejects.toBe('stop');
		const check = jest.fn().mockReturnValue(false);
		await expect(pollUntil(check, { interval: 10, timeout: 1000, signal: abortingOnAdd() })).rejects.toBe('stop');
		expect(check).not.toHaveBeenCalled();
		const tick = jest.fn();
		interval(tick, 10, { signal: abortingOnAdd(), immediate: true });
		expect(tick).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});

	it('createQueue and createRateLimiter reject a call queued as their signal aborts while its listener is added (previously queued, then run)', async function () {
		jest.useFakeTimers();
		const queue = createQueue({ concurrency: 1, signal: abortingOnAdd() });
		const gate = createDeferred<void>();
		const running = queue.add(function () {
			return gate.promise;
		});
		const task = jest.fn();
		const dropped = queue.add(task);
		expect(await stateOf(dropped)).toBe('rejected');
		await expect(dropped).rejects.toBe('stop');
		expect(queue.size).toBe(0);
		gate.resolve();
		await running;
		await flush();
		expect(task).not.toHaveBeenCalled();
		const limiter = createRateLimiter({ limit: 1, interval: 50, signal: abortingOnAdd() });
		await expect(limiter.schedule(jest.fn().mockReturnValue(1))).resolves.toBe(1);
		const call = jest.fn();
		const rejected = limiter.schedule(call);
		expect(await stateOf(rejected)).toBe('rejected');
		await expect(rejected).rejects.toBe('stop');
		expect(limiter.pendingCount).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(100);
		expect(call).not.toHaveBeenCalled();
	});

	it('follow a promise with its own throwing then like await does (previously leaked a slot or a permit, threw, or hung)', async function () {
		const limit = createLimiter(1);
		await expect(
			limit(function () {
				return ownThen(1);
			})
		).resolves.toBe(1);
		await flush();
		expect(limit.activeCount).toBe(0);
		await expect(limit(jest.fn().mockReturnValue(2))).resolves.toBe(2);

		const queue = createQueue({ concurrency: 1 });
		await expect(
			queue.add(function () {
				return ownThen(1);
			})
		).resolves.toBe(1);
		await flush();
		expect(queue.pending).toBe(0);
		await expect(queue.add(jest.fn().mockReturnValue(2))).resolves.toBe(2);

		const pool = createSemaphore(1);
		await expect(
			pool.run(function () {
				return ownThen(1);
			})
		).resolves.toBe(1);
		await flush();
		expect(pool.available).toBe(1);

		const fn = jest.fn().mockImplementation(function () {
			return ownThen(1);
		});
		const memoized = memoizeAsync(fn);
		await expect(memoized()).resolves.toBe(1);
		await expect(memoized()).resolves.toBe(1);
		expect(fn).toHaveBeenCalledTimes(1);

		let checks = 0;
		await expect(
			pollUntil<string | false>(
				function () {
					return checks++ === 0 ? false : ownThen('ready');
				},
				{ interval: 1 }
			)
		).resolves.toBe('ready');

		const breaker = createCircuitBreaker(function () {
			return ownThen(1);
		});
		await expect(breaker()).resolves.toBe(1);
		expect(breaker.stats.successes).toBe(1);

		await expect(
			mapSettledWithConcurrency([1], function () {
				return ownThen(1);
			})
		).resolves.toEqual([{ status: 'fulfilled', value: 1 }]);
		await expect(
			createBatcher(function () {
				return ownThen(['a']);
			}).load(1)
		).resolves.toBe('a');
		await expect(abortable(ownThen(1), new AbortController().signal)).resolves.toBe(1);
		await expect(minDelay(ownThen(1), 0)).resolves.toBe(1);
		await expect(
			reduceAsync(
				[1],
				function () {
					return ownThen(5);
				},
				0
			)
		).resolves.toBe(5);

		const ticks: number[] = [];
		const stop = interval(
			function (tick) {
				ticks.push(tick);
				return ownThen(tick);
			},
			1,
			{ immediate: true }
		);
		await sleep(30);
		stop();
		expect(ticks.length).toBeGreaterThan(1);

		jest.useFakeTimers();
		await expect(withTimeout(ownThen(1), 1000)).resolves.toBe(1);
		// The timer was cleared (previously left running for `ms`).
		expect(jest.getTimerCount()).toBe(0);
	});

	it('createBatcher rejects a batch whose promise has a throwing constructor getter (previously hung, with an uncaught exception)', async function () {
		const values = Promise.resolve(['a']);
		Object.defineProperty(values, 'constructor', {
			get: function () {
				throw new Error('constructor');
			}
		});
		const batcher = createBatcher(function () {
			return values;
		});
		await expect(batcher.loadMany([1, 2])).rejects.toThrow('constructor');
	});

	it('memoizeAsync rejects when its cache throws (previously threw synchronously)', async function () {
		const cache = new Map<unknown, unknown>();
		const fn = jest.fn().mockResolvedValue(1);
		const memoized = memoizeAsync(fn, {
			cache: Object.assign(cache, {
				get: function (): never {
					throw new Error('get');
				}
			})
		});
		const call = memoized();
		await expect(call).rejects.toThrow('get');
		expect(fn).not.toHaveBeenCalled();
		const hasThrows = memoizeAsync(fn, {
			cache: Object.assign(new Map<unknown, unknown>(), {
				has: function (): never {
					throw new Error('has');
				}
			})
		});
		await expect(hasThrows()).rejects.toThrow('has');
	});

	it('createLimiter, debounceAsync, memoizeAsync and createCircuitBreaker work over a polluted Object.prototype (previously threw a TypeError)', async function () {
		const proto = Object.prototype as unknown as Record<string, unknown>;
		for (const [key, value] of [
			['get', 1],
			['set', 1],
			['value', 1],
			['writable', true],
			['enumerable', true]
		] as const) {
			proto[key] = value;
			try {
				const limit = createLimiter(1);
				const debounced = debounceAsync(function () {
					return 1;
				}, 0);
				const memoized = memoizeAsync(async function () {
					return 1;
				});
				const breaker = createCircuitBreaker(function () {
					return 1;
				});
				expect(limit.activeCount).toBe(0);
				expect(breaker.state).toBe('closed');
				expect([Object.keys(limit), Object.keys(debounced), Object.keys(memoized), Object.keys(breaker)]).toEqual([[], [], ['cache'], []]);
				expect(Object.getOwnPropertyDescriptor(memoized, 'clear')?.writable).toBe(false);
				await expect(Promise.all([limit(jest.fn().mockReturnValue(1)), debounced(), memoized(), breaker()])).resolves.toEqual([1, 1, 1, 1]);
			} finally {
				delete proto[key];
			}
		}
	});

	it('removes its abort listeners over a polluted Object.prototype.capture (previously one left on the signal per sleep)', async function () {
		const proto = Object.prototype as unknown as Record<string, unknown>;
		const controller = new AbortController();
		proto.capture = true;
		try {
			for (let i = 0; i < 3; i++) await sleep(0, { signal: controller.signal });
			await abortable(Promise.resolve(1), controller.signal);
		} finally {
			delete proto.capture;
		}
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
	});

	it('anySignal skips the holes of an array, also over a polluted Object.prototype (previously threw a TypeError)', function () {
		const proto = Object.prototype as unknown as Record<number, unknown>;
		proto[1] = { planted: true };
		try {
			// oxlint-disable-next-line no-sparse-arrays
			const signal = anySignal([undefined, , null]);
			expect(signal.aborted).toBe(false);
			const controller = new AbortController();
			const sparse: Array<AbortSignalLike | undefined> = [];
			sparse[2] = controller.signal;
			const combined = anySignal(sparse);
			controller.abort('stop');
			expect(combined.reason).toBe('stop');
		} finally {
			delete proto[1];
		}
	});

	it('createLimiter and createRateLimiter queue tasks over a polluted Object.prototype.next (previously called it, crashing the process)', async function () {
		const proto = Object.prototype as unknown as Record<string, unknown>;
		function plantedCall(): never {
			throw new Error('planted');
		}
		const planted = { run: jest.fn(plantedCall), start: jest.fn(plantedCall), reject: jest.fn() };
		proto.next = planted;
		try {
			const limit = createLimiter(1);
			await expect(Promise.all([limit(jest.fn().mockReturnValue(1)), limit(jest.fn().mockReturnValue(2)), limit(jest.fn().mockReturnValue(3))])).resolves.toEqual([
				1, 2, 3
			]);
			expect(limit.pendingCount).toBe(0);
			const limiter = createRateLimiter({ limit: 1, interval: 1 });
			await expect(Promise.all([limiter.schedule(jest.fn().mockReturnValue(1)), limiter.schedule(jest.fn().mockReturnValue(2))])).resolves.toEqual([1, 2]);
			// Cleared queues stop at their last task too.
			const blocked = createLimiter(1, { rejectOnClear: true });
			blocked(function () {
				return new Promise(function () {});
			});
			const waiting = blocked(jest.fn());
			blocked.clearQueue();
			await expect(waiting).rejects.toThrow(AbortError);
			const slow = createRateLimiter({ limit: 1, interval: 1000 });
			slow.schedule(jest.fn());
			const queued = slow.schedule(jest.fn());
			slow.clearQueue();
			await expect(queued).rejects.toThrow(AbortError);
		} finally {
			delete proto.next;
		}
		expect(planted.run).not.toHaveBeenCalled();
		expect(planted.start).not.toHaveBeenCalled();
		expect(planted.reject).not.toHaveBeenCalled();
	});
});

/**
 * A signal-like whose `addEventListener` keeps the listener, then throws.
 * @returns {{ signal: { aborted: boolean; reason: unknown; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void }; abort: () => void }} The signal and its abort
 */
function keepingThenThrowing() {
	const listeners = new Set<() => void>();
	const signal = {
		aborted: false,
		reason: undefined as unknown,
		addEventListener(_type: string, listener: () => void): void {
			listeners.add(listener);
			throw new Error('add failed');
		},
		removeEventListener(_type: string, listener: () => void): void {
			listeners.delete(listener);
		}
	};
	return {
		signal,
		abort(): void {
			signal.aborted = true;
			for (const listener of listeners) listener();
		}
	};
}

describe('abort listener kept by a signal whose addEventListener throws', function () {
	it('does not stop the unregistered queue task later (regression: the queue counted it cancelled and left the next task waiting)', async function () {
		const queue = createQueue({ concurrency: 1 });
		const release: Array<() => void> = [];
		void queue.add(function () {
			return new Promise<void>(function (resolve) {
				release.push(resolve);
			});
		});
		const hostile = keepingThenThrowing();
		await expect(queue.add(function () {}, { signal: hostile.signal })).rejects.toThrow('add failed');
		const next = queue.add(function () {
			return 'next';
		});
		hostile.abort();
		expect(queue.size).toBe(1);
		release[0]();
		await expect(next).resolves.toBe('next');
	});

	it('does not let a late abort make a keyed mutex forget a held key (regression: two holders)', async function () {
		const mutex = createKeyedMutex<string>();
		const releaseA = await mutex.acquire('k');
		const hostile = keepingThenThrowing();
		await expect(mutex.acquire('k', { signal: hostile.signal })).rejects.toThrow('add failed');
		releaseA();
		const releaseC = await mutex.acquire('k');
		hostile.abort();
		expect(mutex.isLocked('k')).toBe(true);
		releaseC();
	});
});

/**
 * A signal-like whose `addEventListener` keeps the listener and runs `onAdd` (code re-entering the helper, or aborting the signal at once).
 * @param {(signal: { aborted: boolean; reason: unknown }, listener: () => void) => void} onAdd - Runs as the listener is added
 * @returns {{ signal: { aborted: boolean; reason: unknown; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void }; abort: (reason: unknown) => void }} The signal and its abort
 */
function reentrantSignal(onAdd: (signal: { aborted: boolean; reason: unknown }, listener: () => void) => void) {
	const listeners = new Set<() => void>();
	const signal = {
		aborted: false,
		reason: undefined as unknown,
		addEventListener(_type: string, listener: () => void): void {
			listeners.add(listener);
			onAdd(signal, listener);
		},
		removeEventListener(_type: string, listener: () => void): void {
			listeners.delete(listener);
		}
	};
	return {
		signal,
		abort(reason: unknown): void {
			signal.aborted = true;
			signal.reason = reason;
			for (const listener of [...listeners]) listener();
		}
	};
}

describe('instance state after a signal or option that runs user code while a request is queued', function () {
	it('keeps the queue listening to its signal after a task signal aborted as its listener was added (regression: the waiting tasks missed the abort)', async function () {
		const controller = new AbortController();
		const queue = createQueue({ concurrency: 1, signal: controller.signal });
		let release!: () => void;
		void queue.add(function () {
			return new Promise<void>(function (resolve) {
				release = resolve;
			});
		});
		const waiting = queue.add(function () {
			return 'ran';
		});
		const empty = jest.fn();
		void queue.onEmpty().then(empty);
		const eager = reentrantSignal(function (signal, listener) {
			signal.aborted = true;
			signal.reason = 'eager';
			listener();
		});
		await expect(queue.add(function () {}, { signal: eager.signal })).rejects.toBe('eager');
		expect(queue.size).toBe(1);
		expect(empty).not.toHaveBeenCalled();
		controller.abort('stop');
		expect(queue.size).toBe(0);
		await expect(waiting).rejects.toBe('stop');
		release();
	});

	it('ignores a late abort of a task that left the queue while its listener was being added (the next task must not wait forever)', async function () {
		const queue = createQueue({ concurrency: 1 });
		let release!: () => void;
		void queue.add(function () {
			return new Promise<void>(function (resolve) {
				release = resolve;
			});
		});
		const clearing = reentrantSignal(function () {
			queue.clear();
		});
		await expect(queue.add(function () {}, { signal: clearing.signal })).rejects.toThrow(AbortError);
		clearing.abort('late');
		const next = queue.add(function () {
			return 'next';
		});
		expect(queue.size).toBe(1);
		release();
		await expect(next).resolves.toBe('next');
	});

	it('ignores a late abort of a keyed mutex request granted while its listener was being added (regression: two holders)', async function () {
		const mutex = createKeyedMutex<string>();
		const first = await mutex.acquire('doc');
		const releasing = reentrantSignal(function () {
			first();
		});
		const second = await mutex.acquire('doc', { signal: releasing.signal });
		second();
		const third = await mutex.acquire('doc');
		releasing.abort('late');
		expect(mutex.isLocked('doc')).toBe(true);
		expect(mutex.tryAcquire('doc')).toBeUndefined();
		third();
		expect(mutex.size).toBe(0);
	});

	it('records a key whose lock an option getter released before the request took it (regression: two holders)', async function () {
		const mutex = createKeyedMutex<string>();
		const first = await mutex.acquire('doc');
		const second = await mutex.acquire('doc', {
			get timeout() {
				first();
				return Infinity;
			}
		});
		expect(mutex.isLocked('doc')).toBe(true);
		expect(mutex.tryAcquire('doc')).toBeUndefined();
		second();
		expect(mutex.size).toBe(0);
	});

	it('keeps the lock of a key whose option getter releases it and takes it again before the request takes it (regression: two holders)', async function () {
		const mutex = createKeyedMutex<string>();
		const first = await mutex.acquire('doc');
		let other: (() => void) | undefined;
		const second = mutex.acquire('doc', {
			get timeout() {
				first();
				other = mutex.tryAcquire('doc');
				return Infinity;
			}
		});
		expect(other).toBeInstanceOf(Function);
		const granted = jest.fn();
		void second.then(granted);
		await Promise.resolve();
		expect(granted).not.toHaveBeenCalled();
		expect(mutex.isLocked('doc')).toBe(true);
		(other as () => void)();
		const release = await second;
		expect(mutex.tryAcquire('doc')).toBeUndefined();
		release();
		expect(mutex.size).toBe(0);
	});

	it('keeps the lock of a key released and taken again by its signal, or by a nested request failing at once (regression: two holders)', async function () {
		const mutex = createKeyedMutex<string>();
		const first = await mutex.acquire('doc');
		let other: (() => void) | undefined;
		const signal = {
			get aborted() {
				if (other === undefined) {
					first();
					// A nested request of the key that fails at once must not forget the lock either.
					void mutex.run('doc', 'not a function' as never).catch(function () {});
					other = mutex.tryAcquire('doc');
				}
				return false;
			},
			addEventListener(): void {},
			removeEventListener(): void {}
		};
		const ran = jest.fn();
		const work = mutex.run('doc', ran, { signal });
		await Promise.resolve();
		await Promise.resolve();
		expect(ran).not.toHaveBeenCalled();
		(other as () => void)();
		await work;
		expect(ran).toHaveBeenCalledTimes(1);
		expect(mutex.size).toBe(0);
	});

	it('lets a new trial through when the clock throws as a failed trial reopens the circuit (regression: it rejected every call for good)', async function () {
		let clock = 0;
		let clockThrows = false;
		let healthy = false;
		const breaker = createCircuitBreaker(
			async function () {
				if (!healthy) throw new Error('down');
				return 'ok';
			},
			{
				failureThreshold: 1,
				resetTimeout: 100,
				now: function () {
					if (clockThrows) throw new Error('clock');
					return clock;
				}
			}
		);
		await expect(breaker()).rejects.toThrow('down');
		clock = 100;
		const trial = breaker();
		clockThrows = true;
		await expect(trial).rejects.toThrow('clock');
		clockThrows = false;
		expect(breaker.state).toBe('half-open');
		healthy = true;
		await expect(breaker()).resolves.toBe('ok');
		expect(breaker.state).toBe('closed');
	});
});
