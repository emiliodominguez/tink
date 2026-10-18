import fc from 'fast-check';
import { abortable, anySignal, attemptAsync, createDeferred, createLimiter, debounceAsync, mapWithConcurrency, promiseAllObject, retry, sequence } from '.';
import type { AbortSignalLike } from '../utils/index.js';

/**
 * Yields to the microtask queue `ticks` times (no timers involved).
 */
async function yieldTicks(ticks: number): Promise<void> {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/**
 * A fake abort signal that counts its listeners (EventTarget semantics: `once` listeners are removed before being called,
 * and listeners removed during dispatch are skipped).
 */
class CountingSignal implements AbortSignalLike {
	aborted = false;
	reason: unknown = undefined;
	readonly listeners = new Map<() => void, boolean>();

	addEventListener(_type: 'abort', listener: () => void, options?: { once?: boolean }): void {
		if (!this.listeners.has(listener)) this.listeners.set(listener, options?.once ?? false);
	}

	removeEventListener(_type: 'abort', listener: () => void): void {
		this.listeners.delete(listener);
	}

	abort(reason: unknown): void {
		if (this.aborted) return;
		this.aborted = true;
		this.reason = reason;
		for (const [listener, once] of Array.from(this.listeners)) {
			if (!this.listeners.has(listener)) continue;
			if (once) this.listeners.delete(listener);
			listener();
		}
	}
}

describe('Async helpers (properties)', function () {
	describe('mapWithConcurrency', function () {
		it('equals items.map(f), in order, and never exceeds the concurrency limit', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.record({ value: fc.integer({ min: -100, max: 100 }), ticks: fc.integer({ min: 0, max: 5 }) }), { maxLength: 30 }),
					fc.oneof(fc.integer({ min: 1, max: 8 }), fc.constant(Infinity)),
					async function (items, concurrency) {
						let inFlight = 0;
						let maxInFlight = 0;

						function f(item: { value: number }, index: number): string {
							return `${index}:${item.value * 2}`;
						}

						const result = await mapWithConcurrency(
							items,
							async function (item, index) {
								inFlight++;
								maxInFlight = Math.max(maxInFlight, inFlight);
								await yieldTicks(item.ticks);
								inFlight--;
								return f(item, index);
							},
							concurrency
						);

						expect(result).toEqual(items.map(f));
						expect(maxInFlight).toBeLessThanOrEqual(concurrency);
						expect(maxInFlight).toBe(Math.min(concurrency, items.length));
					}
				)
			);
		});
	});

	describe('retry', function () {
		it('succeeds iff the number of failures is <= retries, calling fn min(failures, retries) + 1 times', async function () {
			await fc.assert(
				fc.asyncProperty(fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: 10 }), async function (failures, retries) {
					let calls = 0;

					async function flaky(attempt: number): Promise<number> {
						calls++;
						if (attempt <= failures) throw new Error(`failure ${attempt}`);
						return attempt;
					}

					const outcome = await retry(flaky, { retries, delay: 0 }).then(
						function (value) {
							return { ok: true, value };
						},
						function (error: Error) {
							return { ok: false, value: error.message };
						}
					);

					if (failures <= retries) {
						expect(outcome).toEqual({ ok: true, value: failures + 1 });
					} else {
						expect(outcome).toEqual({ ok: false, value: `failure ${retries + 1}` });
					}
					expect(calls).toBe(Math.min(failures, retries) + 1);
				})
			);
		});
	});
	describe('attemptAsync', function () {
		it('never rejects and matches a try/catch reference', async function () {
			await fc.assert(
				fc.asyncProperty(fc.integer({ min: -50, max: 50 }), fc.boolean(), async function (x, sync) {
					function task(): Promise<number> | number {
						if (x % 4 === 0) {
							if (sync) throw new Error(`sync ${x}`);
							return Promise.reject(new Error(`async ${x}`));
						}
						return sync ? x : Promise.resolve(x);
					}

					let expected: unknown[];
					try {
						expected = [undefined, await task()];
					} catch (error) {
						expected = [error, undefined];
					}
					expect(await attemptAsync(task)).toEqual(expected);
				})
			);
		});
	});

	describe('createLimiter', function () {
		it('never exceeds the concurrency, starts tasks in FIFO order and resolves every task correctly', async function () {
			await fc.assert(
				fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 30 }), fc.integer({ min: 1, max: 6 }), async function (ticks, concurrency) {
					const limit = createLimiter(concurrency);
					const started: number[] = [];
					let maxActive = 0;

					const results = await Promise.all(
						ticks.map(function (tickCount, i) {
							return limit(async function () {
								started.push(i);
								maxActive = Math.max(maxActive, limit.activeCount);
								await yieldTicks(tickCount);
								return i * 2;
							});
						})
					);

					expect(results).toEqual(
						ticks.map(function (_, i) {
							return i * 2;
						})
					);
					expect(started).toEqual(
						ticks.map(function (_, i) {
							return i;
						})
					);
					expect(maxActive).toBeLessThanOrEqual(concurrency);
					expect(maxActive).toBe(Math.min(concurrency, ticks.length));
				})
			);
		});

		it('with `maxPending`, accepts exactly `concurrency + maxPending` simultaneous calls and rejects the others untouched', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 1, max: 4 }),
					fc.integer({ min: 0, max: 4 }),
					fc.integer({ min: 0, max: 15 }),
					async function (concurrency, maxPending, calls) {
						const limit = createLimiter(concurrency, { maxPending });
						const blocker = createDeferred<void>();
						const ran: number[] = [];
						const outcomes = await Promise.allSettled(
							Array.from({ length: calls }, function (_, i) {
								const promise = limit(async function () {
									ran.push(i);
									await blocker.promise;
									return i;
								});
								if (i === calls - 1) blocker.resolve();
								return promise;
							})
						);
						const accepted = Math.min(calls, concurrency + maxPending);
						expect(
							outcomes.map(function (outcome) {
								return outcome.status === 'fulfilled' ? outcome.value : (outcome.reason as Error).name;
							})
						).toEqual(
							Array.from({ length: calls }, function (_, i) {
								return i < accepted ? i : 'RangeError';
							})
						);
						expect(ran).toEqual(
							Array.from({ length: accepted }, function (_, i) {
								return i;
							})
						);
					}
				)
			);
		});
	});

	describe('promiseAllObject', function () {
		it('equals awaiting each key separately', async function () {
			await fc.assert(
				fc.asyncProperty(fc.dictionary(fc.string({ maxLength: 5 }), fc.tuple(fc.integer(), fc.boolean())), async function (spec) {
					const input: Record<string, Promise<number> | number> = {};
					Object.keys(spec).forEach(function (key) {
						const [value, async] = spec[key];
						Object.defineProperty(input, key, { value: async ? Promise.resolve(value) : value, enumerable: true });
					});

					const result = await promiseAllObject(input);
					const expected: Record<string, number> = {};
					for (const key of Object.keys(input)) {
						Object.defineProperty(expected, key, { value: await input[key], enumerable: true, writable: true, configurable: true });
					}
					expect(Object.keys(result)).toEqual(Object.keys(input));
					expect(result).toEqual(expected);
				})
			);
		});
	});

	describe('debounceAsync', function () {
		afterEach(function () {
			jest.clearAllTimers();
			jest.useRealTimers();
		});

		it('invokes fn once per burst with the last args, and every caller of a burst gets that result', async function () {
			const wait = 100;

			await fc.assert(
				fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 250 }), { minLength: 1, maxLength: 20 }), async function (gaps) {
					jest.useFakeTimers();

					const spy = jest.fn(async function (i: number) {
						return `burst ending at ${i}`;
					});
					const debounced = debounceAsync(spy, wait);
					const promises: Array<Promise<string>> = [];
					const burstOf: number[] = [];
					const burstEnds: number[] = [];

					for (let i = 0; i < gaps.length; i++) {
						if (i > 0) {
							await jest.advanceTimersByTimeAsync(gaps[i]);
							if (gaps[i] >= wait) burstEnds.push(i - 1);
						}
						burstOf.push(burstEnds.length);
						promises.push(debounced(i));
					}
					await jest.advanceTimersByTimeAsync(wait);
					burstEnds.push(gaps.length - 1);

					const results = await Promise.all(promises);
					expect(
						spy.mock.calls.map(function (call) {
							return call[0];
						})
					).toEqual(burstEnds);
					expect(results).toEqual(
						burstOf.map(function (burst) {
							return `burst ending at ${burstEnds[burst]}`;
						})
					);

					jest.useRealTimers();
				}),
				{ numRuns: 40 }
			);
		});
	});

	describe('sequence', function () {
		it('runs tasks strictly one at a time and in order, returning results in order', async function () {
			await fc.assert(
				fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 4 }), { maxLength: 20 }), async function (ticks) {
					const events: string[] = [];
					let running = 0;
					let maxRunning = 0;

					const results = await sequence(
						ticks.map(function (tickCount, i) {
							return async function () {
								running++;
								maxRunning = Math.max(maxRunning, running);
								events.push(`start ${i}`);
								await yieldTicks(tickCount);
								events.push(`end ${i}`);
								running--;
								return i;
							};
						})
					);

					expect(results).toEqual(
						ticks.map(function (_, i) {
							return i;
						})
					);
					expect(events).toEqual(
						ticks.flatMap(function (_, i) {
							return [`start ${i}`, `end ${i}`];
						})
					);
					expect(maxRunning).toBeLessThanOrEqual(1);
				})
			);
		});
	});
	describe('anySignal', function () {
		it('aborts iff some input aborts, with the first reason, and leaves no listener behind', function () {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 6 }), fc.array(fc.nat(), { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 8 }), function (count, preAborted, aborts) {
					const inputs = Array.from({ length: count }, function () {
						return new CountingSignal();
					});
					for (const n of preAborted) if (count > 0) inputs[n % count].abort(`pre-${n % count}`);

					const firstPre = inputs.find(function (input) {
						return input.aborted;
					});
					const signal = anySignal(inputs);
					let expectedReason: unknown = firstPre?.reason;

					for (const n of aborts) {
						if (count === 0) break;
						const input = inputs[n % count];
						if (expectedReason === undefined && !input.aborted) expectedReason = `late-${n % count}`;
						input.abort(`late-${n % count}`);
					}

					expect(signal.aborted).toBe(expectedReason !== undefined);
					if (expectedReason !== undefined) expect(signal.reason).toBe(expectedReason);
					for (const input of inputs) expect(input.listeners.size).toBe(signal.aborted ? 0 : 1);
				})
			);
		});
	});

	describe('abortable', function () {
		it('settles like whichever happens first (settlement or abort) and always removes its listener', async function () {
			await fc.assert(
				fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer({ min: 0, max: 3 }), async function (abortFirst, fulfil, ticks) {
					const signal = new CountingSignal();
					const work = createDeferred<string>();
					const result = abortable(work.promise, signal);
					const outcome = result.then(
						function (value) {
							return { value };
						},
						function (reason: unknown) {
							return { reason };
						}
					);

					await yieldTicks(ticks);
					if (abortFirst) signal.abort('aborted');
					if (fulfil) work.resolve('value');
					else work.reject('error');
					if (!abortFirst) {
						await yieldTicks(3);
						signal.abort('aborted');
					}

					const settled = await outcome;
					if (abortFirst) expect(settled).toEqual({ reason: 'aborted' });
					else expect(settled).toEqual(fulfil ? { value: 'value' } : { reason: 'error' });
					expect(signal.listeners.size).toBe(0);
				})
			);
		});
	});
});
