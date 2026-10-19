import {
	AbortError,
	abortable,
	anySignal,
	attemptAsync,
	createBatcher,
	createDeferred,
	createLimiter,
	createQueue,
	createRateLimiter,
	debounceAsync,
	filterWithConcurrency,
	mapSettledWithConcurrency,
	mapWithConcurrency,
	memoizeAsync,
	pollUntil,
	promiseAllObject,
	promiseAllSettledObject,
	retry,
	sequence,
	sleep,
	throwIfAborted,
	TimeoutError,
	timeoutSignal,
	withTimeout
} from '.';
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
			expect(input.listenerCount).toBe(2);
			input.abort('x');
			expect(signal.reason).toBe('x');
			expect(input.listenerCount).toBe(0);
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
			expect(queueSignal.listenerCount).toBe(2);
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
			expect(queueSignal.listenerCount).toBe(1); // the queue's own listener
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
			// eslint-disable-next-line no-sparse-arrays
			const holes = createBatcher(function (_keys: number[]) {
				return new Array<string>(2);
			});
			await expect(holes.loadMany([1, 2])).resolves.toEqual([undefined, undefined]);
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
			const batcher = createBatcher(batchLoad, { delay: 0 });
			const first = batcher.load(1);
			await nextTurn();
			const second = batcher.load(2);
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
			const foreign = Object.create(null, { [Symbol.toStringTag]: { value: 'Error' } });
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
