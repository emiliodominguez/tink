import fc from 'fast-check';
import {
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
	mapSettledWithConcurrency,
	mapWithConcurrency,
	memoizeAsync,
	minDelay,
	promiseAllObject,
	reduceAsync,
	retry,
	sequence,
	sleep,
	waitForEvent,
	type CircuitState,
	type Deferred
} from '.';
import { EventEmitter } from 'node:events';
import { createEmitter } from '../emitter/index.js';
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
		// Every retry waits for a timer, even with a zero delay (it yields to the event loop), so the stress run's 1,000 cases need more
		// than Jest's default 5 seconds.
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
		}, 60_000);
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

describe('Async helpers (round 11 properties)', function () {
	afterEach(function () {
		jest.useRealTimers();
	});

	it('mapSettledWithConcurrency equals Promise.allSettled of the direct calls; filterWithConcurrency equals Array#filter', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ value: fc.integer({ min: -20, max: 20 }), ticks: fc.integer({ min: 0, max: 4 }) }), { maxLength: 25 }),
				fc.oneof(fc.integer({ min: 1, max: 6 }), fc.constant(Infinity)),
				async function (items, concurrency) {
					async function check(item: { value: number; ticks: number }): Promise<number> {
						await yieldTicks(item.ticks);
						if (item.value % 3 === 0) throw new Error(`bad ${item.value}`);
						return item.value * 2;
					}
					const settled = await mapSettledWithConcurrency(items, check, { concurrency });
					expect(settled).toEqual(await Promise.allSettled(items.map(check)));
					const kept = await filterWithConcurrency(
						items,
						async function (item) {
							await yieldTicks(item.ticks);
							return item.value > 0;
						},
						concurrency
					);
					expect(kept).toEqual(
						items.filter(function (item) {
							return item.value > 0;
						})
					);
				}
			)
		);
	});

	it('mapWithConcurrency with stopOnError: false reports every failure exactly once', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 20 }), fc.integer({ min: 1, max: 5 }), async function (failures, concurrency) {
				const outcome = await mapWithConcurrency(
					failures,
					async function (fails, index) {
						await yieldTicks(index % 3);
						if (fails) throw index;
						return index;
					},
					{ concurrency, stopOnError: false }
				).then(
					function (values) {
						return { values, errors: [] as unknown[] };
					},
					function (error: AggregateError) {
						return { values: undefined, errors: error.errors };
					}
				);
				const failed = failures.flatMap(function (fails, index) {
					return fails ? [index] : [];
				});
				if (failed.length === 0)
					expect(outcome.values).toEqual(
						failures.map(function (_, index) {
							return index;
						})
					);
				else
					expect(
						[...outcome.errors].sort(function (a, b) {
							return (a as number) - (b as number);
						})
					).toEqual(failed);
			})
		);
	});

	it('createQueue starts tasks by decreasing priority, FIFO among equals (a stable sort)', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.integer({ min: -2, max: 2 }), { maxLength: 30 }), fc.integer({ min: 1, max: 4 }), async function (priorities, concurrency) {
				const queue = createQueue({ concurrency });
				const order: number[] = [];
				queue.pause();
				priorities.forEach(function (priority, id) {
					queue.add(
						async function () {
							order.push(id);
							await yieldTicks(id % 3);
						},
						{ priority }
					);
				});
				queue.resume();
				await queue.onIdle();
				const expected = priorities
					.map(function (priority, id) {
						return { priority, id };
					})
					.sort(function (a, b) {
						return b.priority - a.priority;
					})
					.map(function (task) {
						return task.id;
					});
				expect(order).toEqual(expected);
			})
		);
	});

	it('createRateLimiter starts every call as early as the sliding window allows, in FIFO order', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 3 }),
				fc.integer({ min: 1, max: 50 }),
				fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 15 }),
				async function (limit, period, gaps) {
					jest.useFakeTimers({ now: 0 });
					try {
						const limiter = createRateLimiter({ limit, interval: period });
						const starts: number[] = [];
						const requests: number[] = [];
						let time = 0;
						for (const gap of gaps) {
							await jest.advanceTimersByTimeAsync(gap);
							time += gap;
							requests.push(time);
							limiter.schedule(function () {
								starts.push(Date.now());
							});
						}
						await jest.advanceTimersByTimeAsync(period * (gaps.length + 1));
						// Reference: call i starts at max(its request, the previous start, the start `limit` calls earlier + interval).
						const expected: number[] = [];
						requests.forEach(function (request, i) {
							expected.push(Math.max(request, i > 0 ? expected[i - 1] : 0, i >= limit ? expected[i - limit] + period : 0));
						});
						expect(starts).toEqual(expected);
						expect(jest.getTimerCount()).toBe(0);
					} finally {
						jest.useRealTimers();
					}
				}
			),
			{ numRuns: 60 }
		);
	});

	it('memoizeAsync calls the function once per distinct key, whatever the interleaving', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.record({ key: fc.integer({ min: 0, max: 5 }), ticks: fc.integer({ min: 0, max: 3 }) }), { maxLength: 30 }), async function (calls) {
				const counts = new Map<number, number>();
				const memo = memoizeAsync(async function (key: number) {
					counts.set(key, (counts.get(key) ?? 0) + 1);
					await yieldTicks(key);
					return key * 10;
				});
				const results = await Promise.all(
					calls.map(async function (call) {
						await yieldTicks(call.ticks);
						return memo(call.key);
					})
				);
				expect(results).toEqual(
					calls.map(function (call) {
						return call.key * 10;
					})
				);
				for (const count of counts.values()) expect(count).toBe(1);
				expect(counts.size).toBe(
					new Set(
						calls.map(function (call) {
							return call.key;
						})
					).size
				);
			})
		);
	});
});

describe('createBatcher (properties)', function () {
	it('gives every caller the value of its own key, with batches of distinct keys within maxBatchSize, whatever the interleaving', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ key: fc.integer({ min: 0, max: 8 }), ticks: fc.integer({ min: 0, max: 3 }) }), { maxLength: 30 }),
				fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(Infinity)),
				fc.boolean(),
				fc.integer({ min: 2, max: 5 }),
				async function (requests, maxBatchSize, cache, modulus) {
					const batches: number[][] = [];
					const batcher = createBatcher(
						async function (keys: number[]) {
							batches.push(keys.slice());
							await yieldTicks(keys.length % 3);
							return keys.map(function (key) {
								return key % modulus === 0 ? new Error(`bad ${key}`) : key * 10;
							});
						},
						{ maxBatchSize, cache }
					);
					const outcomes = await Promise.all(
						requests.map(async function (request) {
							await yieldTicks(request.ticks);
							return batcher.load(request.key).then(
								function (value) {
									return value;
								},
								function (error: Error) {
									return error.message;
								}
							);
						})
					);

					expect(outcomes).toEqual(
						requests.map(function (request) {
							return request.key % modulus === 0 ? `bad ${request.key}` : request.key * 10;
						})
					);
					const requested = new Map<number, number>();
					for (const batch of batches) {
						expect(batch.length).toBeGreaterThan(0);
						expect(batch.length).toBeLessThanOrEqual(maxBatchSize);
						expect(new Set(batch).size).toBe(batch.length);
						for (const key of batch) requested.set(key, (requested.get(key) ?? 0) + 1);
					}
					for (const request of requests) expect(requested.has(request.key)).toBe(true);
					// With a cache, a value is requested once for good: only failed keys are requested again.
					if (cache) for (const [key, count] of requested) if (key % modulus !== 0) expect(count).toBe(1);
				}
			)
		);
	});

	it('requests exactly the keys some caller still waits for, in first-request order', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ key: fc.integer({ min: 0, max: 6 }), abort: fc.boolean() }), { maxLength: 20 }),
				fc.boolean(),
				async function (requests, cache) {
					const batches: number[][] = [];
					const batcher = createBatcher(
						function (keys: number[]) {
							batches.push(keys.slice());
							return keys;
						},
						{ cache }
					);
					const signals = requests.map(function () {
						return new CountingSignal();
					});
					const loads = requests.map(function (request, index) {
						return batcher.load(request.key, { signal: signals[index] });
					});
					requests.forEach(function (request, index) {
						if (request.abort) signals[index].abort(new Error('aborted'));
					});
					const outcomes = await Promise.allSettled(loads);

					const order: number[] = [];
					for (const request of requests) if (!order.includes(request.key)) order.push(request.key);
					const wanted = order.filter(function (key) {
						return requests.some(function (request) {
							return request.key === key && !request.abort;
						});
					});
					expect(batches).toEqual(wanted.length === 0 ? [] : [wanted]);
					outcomes.forEach(function (outcome, index) {
						expect(outcome).toEqual(
							requests[index].abort ? { status: 'rejected', reason: new Error('aborted') } : { status: 'fulfilled', value: requests[index].key }
						);
					});
					for (const signal of signals) expect(signal.listeners.size).toBe(0);
				}
			)
		);
	});
});

describe('Async helpers (properties: locks, events, reduceAsync, minDelay)', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	type SemaphoreCommand =
		| { kind: 'acquire'; weight: number; abortable: boolean }
		| { kind: 'try'; weight: number }
		| { kind: 'release'; pick: number; twice: boolean }
		| { kind: 'abort'; pick: number };

	/**
	 * Commands for a semaphore of up to `maxPermits` permits (weights are clamped to the actual permits).
	 */
	function semaphoreCommands(maxPermits: number): fc.Arbitrary<SemaphoreCommand[]> {
		const weight = fc.integer({ min: 1, max: maxPermits });
		return fc.array(
			fc.oneof(
				fc.record({ kind: fc.constant('acquire' as const), weight, abortable: fc.boolean() }),
				fc.record({ kind: fc.constant('try' as const), weight }),
				fc.record({ kind: fc.constant('release' as const), pick: fc.nat(), twice: fc.boolean() }),
				fc.record({ kind: fc.constant('abort' as const), pick: fc.nat() })
			),
			{ maxLength: 40 }
		);
	}

	it('createSemaphore matches a FIFO model, conserves permits and leaks no listener under any acquire / abort / release interleaving', async function () {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 5 }), semaphoreCommands(5), async function (permits, commands) {
				const semaphore = createSemaphore(permits);
				// The model: holders by request id, and the FIFO queue of waiting requests.
				const held = new Map<number, number>();
				const queue: Array<{ id: number; weight: number; signal?: CountingSignal }> = [];
				const releases = new Map<number, () => void>();
				const signals: CountingSignal[] = [];
				const modelGrants: number[] = [];
				const actualGrants: number[] = [];
				let modelAvailable = permits;
				let nextId = 0;

				function modelDispatch(): void {
					while (queue.length > 0 && queue[0].weight <= modelAvailable) {
						const request = queue.shift() as { id: number; weight: number };
						modelAvailable -= request.weight;
						held.set(request.id, request.weight);
						modelGrants.push(request.id);
					}
				}

				function check(): void {
					let holding = 0;
					for (const weight of held.values()) holding += weight;
					expect(semaphore.available).toBe(modelAvailable);
					expect(semaphore.available + holding).toBe(permits);
					expect(semaphore.pending).toBe(queue.length);
				}

				for (const command of commands) {
					if (command.kind === 'acquire') {
						const id = nextId++;
						const weight = Math.min(command.weight, permits);
						const signal = command.abortable ? new CountingSignal() : undefined;
						if (signal) signals.push(signal);
						semaphore.acquire({ weight, signal }).then(
							function (release) {
								actualGrants.push(id);
								releases.set(id, release);
							},
							function () {
								// Aborted: checked through the model.
							}
						);
						if (queue.length === 0 && weight <= modelAvailable) {
							modelAvailable -= weight;
							held.set(id, weight);
							modelGrants.push(id);
						} else {
							queue.push({ id, weight, signal });
						}
					} else if (command.kind === 'try') {
						const weight = Math.min(command.weight, permits);
						const release = semaphore.tryAcquire(weight);
						const expected = queue.length === 0 && weight <= modelAvailable;
						expect(release !== undefined).toBe(expected);
						if (release) {
							const id = nextId++;
							modelAvailable -= weight;
							held.set(id, weight);
							releases.set(id, release);
						}
					} else if (command.kind === 'release') {
						const ids = Array.from(releases.keys());
						if (ids.length > 0) {
							const id = ids[command.pick % ids.length];
							const release = releases.get(id) as () => void;
							release();
							if (command.twice) release();
							releases.delete(id);
							modelAvailable += held.get(id) as number;
							held.delete(id);
							modelDispatch();
						}
					} else {
						const cancellable = queue.filter(function (request) {
							return request.signal !== undefined;
						});
						if (cancellable.length > 0) {
							const request = cancellable[command.pick % cancellable.length];
							(request.signal as CountingSignal).abort(new Error('aborted'));
							queue.splice(queue.indexOf(request), 1);
							modelDispatch();
						}
					}
					check();
					await yieldTicks(3);
				}

				// Drain: abort what can be aborted, release every holder (including those granted while draining).
				for (const request of queue.slice()) {
					// Skips a request that an earlier abort let through (granted, it left the queue: aborting it now changes nothing, and
					// `splice(-1, 1)` would drop the last waiter from the model).
					if (request.signal && queue.includes(request)) {
						request.signal.abort(new Error('aborted'));
						queue.splice(queue.indexOf(request), 1);
						modelDispatch();
					}
				}
				while (releases.size > 0) {
					for (const [id, release] of Array.from(releases)) {
						release();
						releases.delete(id);
						modelAvailable += held.get(id) as number;
						held.delete(id);
						modelDispatch();
						check();
					}
					await yieldTicks(3);
				}

				check();
				expect(semaphore.available).toBe(permits);
				expect(semaphore.pending).toBe(0);
				expect(actualGrants).toEqual(modelGrants);
				for (const signal of signals) expect(signal.listeners.size).toBe(0);
			})
		);
	});

	it('createSemaphore.run never holds more than `permits` weighted permits at once and runs every task', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 6 }),
				fc.array(fc.record({ weight: fc.integer({ min: 1, max: 6 }), ticks: fc.integer({ min: 0, max: 4 }), fails: fc.boolean() }), { maxLength: 25 }),
				async function (permits, tasks) {
					const semaphore = createSemaphore(permits);
					let inUse = 0;
					let peak = 0;
					const outcomes = await Promise.allSettled(
						tasks.map(function (task, index) {
							const weight = Math.min(task.weight, permits);
							return semaphore.run(
								async function () {
									inUse += weight;
									peak = Math.max(peak, inUse);
									expect(inUse).toBeLessThanOrEqual(permits);
									await yieldTicks(task.ticks);
									inUse -= weight;
									if (task.fails) throw new Error(`task ${index}`);
									return index;
								},
								{ weight }
							);
						})
					);
					expect(
						outcomes.map(function (outcome) {
							return outcome.status === 'fulfilled' ? outcome.value : (outcome.reason as Error).message;
						})
					).toEqual(
						tasks.map(function (task, index) {
							return task.fails ? `task ${index}` : index;
						})
					);
					expect(peak).toBeLessThanOrEqual(permits);
					expect(semaphore.available).toBe(permits);
				}
			)
		);
	});

	it('createMutex.run never overlaps and starts tasks in call order, whatever they throw', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ ticks: fc.integer({ min: 0, max: 4 }), outcome: fc.constantFrom('value', 'reject', 'throw') }), { maxLength: 20 }),
				async function (tasks) {
					const mutex = createMutex();
					const started: number[] = [];
					let inside = 0;
					await Promise.allSettled(
						tasks.map(function (task, index) {
							return mutex.run(function () {
								started.push(index);
								expect(mutex.isLocked).toBe(true);
								inside++;
								expect(inside).toBe(1);
								if (task.outcome === 'throw') {
									inside--;
									throw new Error('sync');
								}
								return yieldTicks(task.ticks).then(function () {
									inside--;
									if (task.outcome === 'reject') throw new Error('async');
									return index;
								});
							});
						})
					);
					expect(started).toEqual(
						tasks.map(function (_, index) {
							return index;
						})
					);
					expect(mutex.isLocked).toBe(false);
					expect(mutex.pending).toBe(0);
				}
			)
		);
	});

	it('createKeyedMutex serializes each key in call order, overlaps different keys, and forgets every key once idle', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ key: fc.constantFrom('a', 'b', 'c', 1, NaN), ticks: fc.integer({ min: 0, max: 4 }) }), { maxLength: 25 }),
				async function (tasks) {
					const locks = createKeyedMutex<string | number>();
					const inside = new Map<string | number, number>();
					const started = new Map<string | number, number[]>();
					await Promise.all(
						tasks.map(function (task, index) {
							return locks.run(task.key, async function () {
								expect(inside.get(task.key) ?? 0).toBe(0);
								inside.set(task.key, 1);
								started.set(task.key, [...(started.get(task.key) ?? []), index]);
								expect(locks.isLocked(task.key)).toBe(true);
								await yieldTicks(task.ticks);
								inside.set(task.key, 0);
							});
						})
					);
					for (const [key, order] of started) {
						expect(order).toEqual(
							tasks
								.map(function (task, index) {
									return Object.is(task.key, key) ? index : -1;
								})
								.filter(function (index) {
									return index >= 0;
								})
						);
					}
					expect(locks.size).toBe(0);
				}
			)
		);
	});

	it('waitForEvent settles like the first accepted or rejecting event, and always removes its listeners', async function () {
		const event = fc.record({ type: fc.constantFrom('data', 'error', 'close', 'other'), value: fc.integer({ min: 0, max: 9 }) });
		await fc.assert(
			fc.asyncProperty(
				fc.array(event, { maxLength: 12 }),
				fc.subarray(['error', 'close']),
				fc.integer({ min: 0, max: 10 }),
				fc.constantFrom('node', 'tinkit', 'dom'),
				async function (events, rejectOn, threshold, kind) {
					const node = new EventEmitter();
					// Node throws when 'error' is emitted with no listener: keep one of our own.
					function ignore(): void {}
					node.on('error', ignore);
					const tinkit = createEmitter<Record<string, number>>();
					const dom = new EventTarget();
					let listeners = 0;
					const addEventListener = dom.addEventListener.bind(dom);
					const removeEventListener = dom.removeEventListener.bind(dom);
					dom.addEventListener = function (type: string, listener: EventListener) {
						listeners++;
						addEventListener(type, listener);
					};
					dom.removeEventListener = function (type: string, listener: EventListener) {
						listeners--;
						removeEventListener(type, listener);
					};
					const target = kind === 'node' ? node : kind === 'tinkit' ? tinkit : dom;
					const controller = new AbortController();
					function filter(received: unknown): boolean {
						const value = received instanceof CustomEvent ? (received.detail as number) : (received as number);
						return value >= threshold;
					}
					const waiting = waitForEvent(target as EventEmitter, 'data', { filter, rejectOn, signal: controller.signal });
					const outcome = waiting.then(
						function (value) {
							return { status: 'resolved', value: value instanceof CustomEvent ? value.detail : value };
						},
						function (reason: unknown) {
							return { status: 'rejected', value: reason instanceof CustomEvent ? reason.detail : reason };
						}
					);

					for (const { type, value } of events) {
						if (kind === 'node') node.emit(type, value);
						else if (kind === 'tinkit') tinkit.emit(type, value);
						else dom.dispatchEvent(new CustomEvent(type, { detail: value }));
					}
					controller.abort('none');

					const first = events.find(function ({ type, value }) {
						return (type === 'data' && value >= threshold) || rejectOn.includes(type);
					});
					const expected =
						first === undefined ? { status: 'rejected', value: 'none' } : { status: first.type === 'data' ? 'resolved' : 'rejected', value: first.value };
					expect(await outcome).toEqual(expected);
					expect(node.eventNames()).toEqual(['error']);
					expect(node.listeners('error')).toEqual([ignore]);
					expect(tinkit.listenerCount()).toBe(0);
					expect(listeners).toBe(0);
				}
			)
		);
	});

	it('reduceAsync equals Array.prototype.reduce, for sync, promise and async iterables', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.integer()), fc.constantFrom('array', 'promises', 'async'), async function (values, kind) {
				async function* asyncValues(): AsyncGenerator<number> {
					for (const value of values) {
						await Promise.resolve();
						yield value;
					}
				}
				const items = kind === 'array' ? values : kind === 'promises' ? values.map(Promise.resolve, Promise) : asyncValues();
				function step(accumulator: string, value: number, index: number): string {
					return `${accumulator}|${index}:${value}`;
				}
				const result = await reduceAsync(
					items as AsyncIterable<number>,
					async function (accumulator: string, value, index) {
						await Promise.resolve();
						return step(accumulator, value, index);
					},
					'>'
				);
				expect(result).toBe(values.reduce(step, '>'));
			})
		);
	});

	it('minDelay settles at max(ms, the time the promise takes), or at once for an early rejection with delayRejection: false', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 50 }),
				fc.integer({ min: 0, max: 80 }),
				fc.boolean(),
				fc.option(fc.boolean(), { nil: undefined }),
				async function (ms, takes, fails, delayRejection) {
					jest.useFakeTimers({ now: 0 });
					try {
						const promise = new Promise<string>(function (resolve, reject) {
							setTimeout(function () {
								if (fails) reject(new Error('failed'));
								else resolve('done');
							}, takes);
						});
						let settledAt = -1;
						let outcome: unknown;
						minDelay(promise, ms, delayRejection === undefined ? {} : { delayRejection }).then(
							function (value) {
								settledAt = Date.now();
								outcome = value;
							},
							function (error: Error) {
								settledAt = Date.now();
								outcome = error.message;
							}
						);
						// One advance past both timers: fake timers run each timer at its own time, and drain the microtasks it queues before the
						// next one, so `Date.now()` in the handlers is the exact settling time (stepping 1 ms at a time is ~100× slower).
						await jest.advanceTimersByTimeAsync(100);
						// Both timers have fired, or the minimum-delay one was cleared by an early rejection.
						expect(jest.getTimerCount()).toBe(0);
						expect(outcome).toBe(fails ? 'failed' : 'done');
						expect(settledAt).toBe(fails && delayRejection === false ? takes : Math.max(ms, takes));
					} finally {
						jest.clearAllTimers();
						jest.useRealTimers();
					}
				}
			)
		);
	});
});

describe('Async helpers (properties: circuit breaker, backoff, fromEvent, interval, stopwatch)', function () {
	afterEach(function () {
		jest.restoreAllMocks();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('backoff', function () {
		type Jitter = 'none' | 'full' | 'equal' | 'decorrelated';

		/**
		 * The AWS Architecture Blog formulas ("Exponential Backoff And Jitter"), written as in the article's Python code, with `factor` in
		 * place of its `2` (exponential) and `3` (decorrelated).
		 */
		function reference(initial: number, factor: number, max: number, jitter: Jitter, count: number, randoms: number[]): number[] {
			const delays: number[] = [];
			let sleepValue = initial;
			let draws = 0;
			function uniform(low: number, high: number): number {
				return low + (high - low) * randoms[draws++ % randoms.length];
			}
			for (let n = 0; n < count; n++) {
				const expo = Math.min(max, initial * factor ** n);
				if (jitter === 'none') delays.push(expo);
				else if (jitter === 'full') delays.push(uniform(0, expo));
				else if (jitter === 'equal') delays.push(expo / 2 + uniform(0, expo / 2));
				else delays.push((sleepValue = Math.min(max, uniform(initial, sleepValue * factor))));
			}
			return delays;
		}

		function replay(randoms: number[]): () => number {
			let index = 0;
			return function () {
				return randoms[index++ % randoms.length];
			};
		}

		const jitters = fc.constantFrom<Jitter>('none', 'full', 'equal', 'decorrelated');
		const randoms = fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 1, maxLength: 20 });

		it('matches the AWS formulas exactly for integer parameters', function () {
			fc.assert(
				fc.property(
					fc.integer({ min: 0, max: 10_000 }),
					fc.integer({ min: 1, max: 10 }),
					fc.integer({ min: 0, max: 2 ** 31 - 1 }),
					jitters,
					fc.integer({ min: 0, max: 60 }),
					randoms,
					function (initial, factor, max, jitter, retries, values) {
						const delays = [...backoff({ delay: initial, factor, maxDelay: max, jitter, retries, random: replay(values) })];
						expect(delays).toEqual(reference(initial, factor, max, jitter, retries, values));
					}
				)
			);
		});

		it('matches the AWS formulas to within rounding for any parameters', function () {
			fc.assert(
				fc.property(
					fc.double({ min: 0, max: 2 ** 31 - 1, noNaN: true }),
					fc.double({ min: 1, max: 1000, noNaN: true }),
					fc.double({ min: 0, max: 2 ** 31 - 1, noNaN: true }),
					jitters,
					fc.integer({ min: 0, max: 40 }),
					randoms,
					function (initial, factor, max, jitter, retries, values) {
						const delays = [...backoff({ delay: initial, factor, maxDelay: max, jitter, retries, random: replay(values) })];
						const expected = reference(initial, factor, max, jitter, retries, values);
						expect(delays).toHaveLength(retries);
						delays.forEach(function (delay, index) {
							// Repeated multiplication versus `factor ** n`: a few ulps per step, compounded by the decorrelated recurrence.
							expect(Math.abs(delay - expected[index])).toBeLessThanOrEqual(1e-9 * Math.max(1, expected[index]));
						});
					}
				)
			);
		});

		it('only yields finite delays in [0, max], non-decreasing without jitter, within the jitter bounds otherwise', function () {
			fc.assert(
				fc.property(
					fc.double({ min: 0, max: 2 ** 31 - 1, noNaN: true }),
					fc.oneof(fc.double({ min: 1, max: 4, noNaN: true }), fc.double({ min: 1, max: Number.MAX_VALUE, noNaN: true })),
					fc.double({ min: 0, max: 2 ** 31 - 1, noNaN: true }),
					jitters,
					randoms,
					function (initial, factor, max, jitter, values) {
						const iterator = backoff({ delay: initial, factor, maxDelay: max, jitter, random: replay(values) })[Symbol.iterator]();
						const plain = backoff({ delay: initial, factor, maxDelay: max })[Symbol.iterator]();
						let previous = -Infinity;
						for (let i = 0; i < 80; i++) {
							const delay = iterator.next().value as number;
							const exponential = plain.next().value as number;
							expect(Number.isFinite(delay)).toBe(true);
							expect(delay).toBeGreaterThanOrEqual(0);
							expect(delay).toBeLessThanOrEqual(max);
							expect(exponential).toBeGreaterThanOrEqual(previous);
							previous = exponential;
							if (jitter === 'none') expect(delay).toBe(exponential);
							if (jitter === 'full') expect(delay).toBeLessThanOrEqual(exponential);
							if (jitter === 'equal') {
								expect(delay).toBeGreaterThanOrEqual(exponential / 2);
								expect(delay).toBeLessThanOrEqual(exponential);
							}
							if (jitter === 'decorrelated') expect(delay).toBeGreaterThanOrEqual(Math.min(initial, max));
						}
					}
				)
			);
		});
	});

	describe('createCircuitBreaker', function () {
		type Command = { kind: 'call'; ok: boolean; ignored: boolean } | { kind: 'advance'; ms: number } | { kind: 'open' } | { kind: 'reset' };

		const commands = fc.array(
			fc.oneof(
				{ weight: 6, arbitrary: fc.record({ kind: fc.constant('call' as const), ok: fc.boolean(), ignored: fc.boolean() }) },
				{ weight: 3, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 150 }) }) },
				{ weight: 1, arbitrary: fc.record({ kind: fc.constant('open' as const) }) },
				{ weight: 1, arbitrary: fc.record({ kind: fc.constant('reset' as const) }) }
			),
			{ maxLength: 60 }
		);

		it('matches a sequential model of the closed / open / half-open state machine', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 1, max: 4 }),
					fc.integer({ min: 0, max: 200 }),
					fc.integer({ min: 1, max: 3 }),
					commands,
					async function (failureThreshold, resetTimeout, halfOpenMaxCalls, script) {
						let clock = 0;
						const transitions: string[] = [];
						class Ignored extends Error {}
						let next: Command & { kind: 'call' } = { kind: 'call', ok: true, ignored: false };
						const guarded = createCircuitBreaker(
							async function (): Promise<string> {
								if (next.ok) return 'ok';
								throw next.ignored ? new Ignored('ignored') : new Error('failed');
							},
							{
								failureThreshold,
								resetTimeout,
								halfOpenMaxCalls,
								now: function () {
									return clock;
								},
								isFailure: function (error) {
									return !(error instanceof Ignored);
								},
								onStateChange: function (state, previous) {
									transitions.push(`${previous}>${state}`);
								}
							}
						);
						// The model.
						let state = 'closed' as CircuitState;
						let streak = 0;
						let openedAt = 0;
						let passed = 0;
						const expectedTransitions: string[] = [];
						const counts = { successes: 0, failures: 0, shortCircuited: 0 };
						function move(to: CircuitState): void {
							if (to === 'open') openedAt = clock;
							if (to !== state) expectedTransitions.push(`${state}>${to}`);
							state = to;
							streak = 0;
							passed = 0;
						}

						for (const command of script) {
							if (command.kind === 'advance') {
								clock += command.ms;
							} else if (command.kind === 'open') {
								guarded.open();
								move('open');
							} else if (command.kind === 'reset') {
								guarded.reset();
								move('closed');
							} else {
								next = command;
								const outcome = await guarded().then(
									function (value) {
										return value;
									},
									function (error: unknown) {
										return error instanceof CircuitOpenError ? `open ${error.retryAfter}` : (error as Error).message;
									}
								);
								if (state === 'open' && clock - openedAt >= resetTimeout) move('half-open');
								let expected: string;
								if (state === 'open') {
									counts.shortCircuited++;
									expected = `open ${resetTimeout - (clock - openedAt)}`;
								} else {
									const failed = !command.ok && !command.ignored;
									expected = command.ok ? 'ok' : command.ignored ? 'ignored' : 'failed';
									if (failed) counts.failures++;
									else counts.successes++;
									if (state === 'closed') {
										streak = failed ? streak + 1 : 0;
										if (streak >= failureThreshold) move('open');
									} else if (failed) {
										move('open');
									} else if (++passed >= halfOpenMaxCalls) {
										move('closed');
									}
								}
								expect(outcome).toBe(expected);
							}
							if (state === 'open' && clock - openedAt >= resetTimeout) move('half-open');
							expect(guarded.stats).toEqual({ state, consecutiveFailures: streak, ...counts });
						}
						expect(transitions).toEqual(expectedTransitions);
					}
				)
			);
		});

		type ConcurrentCommand = { kind: 'start' } | { kind: 'settle'; pick: number; ok: boolean } | { kind: 'advance'; ms: number } | { kind: 'open' } | { kind: 'reset' };

		it('under any interleaving: never calls the operation while open, admits at most halfOpenMaxCalls trials, and only lets calls of the current period change the state', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 1, max: 3 }),
					fc.integer({ min: 1, max: 3 }),
					fc.array(
						fc.oneof(
							{ weight: 4, arbitrary: fc.record({ kind: fc.constant('start' as const) }) },
							{ weight: 4, arbitrary: fc.record({ kind: fc.constant('settle' as const), pick: fc.nat(), ok: fc.boolean() }) },
							{ weight: 2, arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 60 }) }) },
							{ weight: 1, arbitrary: fc.record({ kind: fc.constant('open' as const) }) },
							{ weight: 1, arbitrary: fc.record({ kind: fc.constant('reset' as const) }) }
						) as fc.Arbitrary<ConcurrentCommand>,
						{ maxLength: 80 }
					),
					async function (failureThreshold, halfOpenMaxCalls, script) {
						let clock = 0;
						// A period is the time between two changes of state or calls of open() / reset(): calls only count in their own.
						let period = 0;
						let state = 'closed' as CircuitState;
						let trialsThisPeriod = 0;
						const inFlight: Array<{ deferred: Deferred<string>; period: number }> = [];
						let starting: { deferred: Deferred<string>; period: number } | undefined;
						// Errors thrown in the operation or the listener would only reject a call: they are collected instead.
						const violations: string[] = [];
						const guarded = createCircuitBreaker(
							function (): Promise<string> {
								if (state === 'open') violations.push('called while open');
								if (state === 'half-open' && ++trialsThisPeriod > halfOpenMaxCalls) violations.push('too many trials');
								starting = { deferred: createDeferred<string>(), period };
								return starting.deferred.promise;
							},
							{
								failureThreshold,
								resetTimeout: 50,
								halfOpenMaxCalls,
								now: function () {
									return clock;
								},
								onStateChange: function (next, previous) {
									if (previous !== state) violations.push(`from ${previous}, not ${state}`);
									// `open>closed` and `half-open>closed` also come from reset(), `closed>open` from open().
									if (!['closed>open', 'open>half-open', 'half-open>open', 'half-open>closed', 'open>closed'].includes(`${previous}>${next}`)) {
										violations.push(`${previous}>${next}`);
									}
									state = next;
									period++;
									trialsThisPeriod = 0;
								}
							}
						);
						for (const command of script) {
							if (command.kind === 'advance') {
								clock += command.ms;
							} else if (command.kind === 'open') {
								guarded.open();
								state = 'open';
								period++;
							} else if (command.kind === 'reset') {
								guarded.reset();
								state = 'closed';
								period++;
							} else if (command.kind === 'start') {
								starting = undefined;
								guarded().catch(function () {
									// Failures and short-circuits are checked through the state.
								});
								if (starting !== undefined) inFlight.push(starting);
							} else if (inFlight.length > 0) {
								const [call] = inFlight.splice(command.pick % inFlight.length, 1);
								const before = { state, period };
								if (command.ok) call.deferred.resolve('ok');
								else call.deferred.reject(new Error('failed'));
								for (let i = 0; i < 5; i++) await Promise.resolve();
								// A call of an earlier period never changes the state.
								if (call.period !== before.period) expect({ state, period }).toEqual(before);
								// A success never opens the circuit, a failure never closes it.
								if (period !== before.period) expect(state).toBe(command.ok ? 'closed' : 'open');
							}
							expect(guarded.state).toBe(state);
						}
						expect(violations).toEqual([]);
					}
				)
			);
		});
	});

	describe('fromEvent', function () {
		type Step = { kind: 'emit'; value: number } | { kind: 'read' };

		it('yields what a naive queue model yields, for any interleaving of emits and reads, buffer size and overflow policy', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.array(
						fc.oneof(
							fc.record({ kind: fc.constant('emit' as const), value: fc.integer() }),
							fc.record({ kind: fc.constant('read' as const) })
						) as fc.Arbitrary<Step>,
						{ maxLength: 60 }
					),
					fc.oneof(fc.integer({ min: 0, max: 5 }), fc.constant(Infinity)),
					fc.constantFrom<'throw' | 'drop-oldest' | 'drop-newest'>('throw', 'drop-oldest', 'drop-newest'),
					async function (steps, bufferSize, overflow) {
						const emitter = new EventEmitter();
						const iterator = fromEvent<number>(emitter, 'n', { bufferSize, overflow });
						const reads: Array<Promise<IteratorResult<number>>> = [];
						// The model.
						const queue: number[] = [];
						let waiting = 0;
						let failed = false;
						const expected: string[] = [];
						const expectedOrder: Array<number | 'pending'> = [];
						for (const step of steps) {
							if (step.kind === 'emit') {
								emitter.emit('n', step.value);
								if (failed) continue;
								const pendingIndex = expectedOrder.indexOf('pending');
								if (waiting > 0 && pendingIndex !== -1) {
									waiting--;
									expectedOrder[pendingIndex] = step.value;
								} else if (queue.length < bufferSize) {
									queue.push(step.value);
								} else if (overflow === 'drop-oldest') {
									queue.push(step.value);
									queue.shift();
								} else if (overflow === 'throw') {
									failed = true;
								}
							} else {
								reads.push(iterator.next());
								if (queue.length > 0) expectedOrder.push(queue.shift() as number);
								else if (failed) expectedOrder.push(Number.NaN);
								else {
									waiting++;
									expectedOrder.push('pending');
								}
							}
						}
						expect(emitter.listenerCount('n')).toBe(failed ? 0 : 1);
						await iterator.return?.();
						expect(emitter.listenerCount('n')).toBe(0);
						const settled = await Promise.allSettled(reads);
						let threw = false;
						for (const want of expectedOrder) {
							if (typeof want === 'number' && !Number.isNaN(want)) {
								expected.push(String(want));
							} else if (typeof want === 'number' && !threw) {
								threw = true;
								expected.push('error');
							} else {
								expected.push('done');
							}
						}
						expect(
							settled.map(function (result) {
								if (result.status === 'rejected') return 'error';
								return result.value.done ? 'done' : String(result.value.value);
							})
						).toEqual(expected);
					}
				)
			);
		});
	});

	describe('interval', function () {
		it('runs each tick within its slot (start + n × ms), never overlapping, skipping only the slots that passed while the callback ran', async function () {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 1, max: 50 }),
					fc.array(fc.integer({ min: 0, max: 150 }), { minLength: 1, maxLength: 15 }),
					fc.boolean(),
					async function (ms, durations, immediate) {
						jest.useFakeTimers({ now: 0 });
						try {
							const start = performance.now();
							const runs: Array<{ tick: number; begin: number; end: number }> = [];
							let running = false;
							let overlapped = false;
							const stop = interval(
								async function (tick) {
									if (running) overlapped = true;
									running = true;
									const begin = performance.now();
									const duration = durations[runs.length % durations.length];
									if (duration > 0) await sleep(duration);
									running = false;
									runs.push({ tick, begin, end: performance.now() });
								},
								ms,
								{ immediate }
							);
							await jest.advanceTimersByTimeAsync(ms * 40);
							stop();
							// Lets a callback still sleeping finish.
							await jest.advanceTimersByTimeAsync(200);
							expect(jest.getTimerCount()).toBe(0);
							expect(overlapped).toBe(false);
							expect(runs[0]).toMatchObject(immediate ? { tick: 0, begin: start } : { tick: 1, begin: start + ms });
							runs.forEach(function (run, index) {
								// Each run is the latest due tick: it starts within that tick's slot.
								expect(run.tick).toBe(Math.floor((run.begin - start) / ms));
								if (index > 0) {
									const previous = runs[index - 1];
									expect(run.tick).toBeGreaterThan(previous.tick);
									expect(run.begin).toBeGreaterThanOrEqual(previous.end);
									// No needless wait: the next run comes at the first slot after the previous one that is not over when it ends (a slot
									// due exactly then gets a 0 ms timeout, which fake timers, like Node, run 1 ms later).
									const due = start + Math.max(previous.tick + 1, Math.ceil((previous.end - start) / ms)) * ms;
									expect(run.begin).toBe(due === previous.end ? due + 1 : due);
								}
							});
						} finally {
							jest.useRealTimers();
						}
					}
				),
				{ numRuns: 50 }
			);
		});
	});

	describe('createStopwatch', function () {
		type Op = { kind: 'start' } | { kind: 'stop' } | { kind: 'lap' } | { kind: 'reset' } | { kind: 'advance'; ms: number };

		it('measures the clock advances made while running (never a step back), and its laps add up to the elapsed time', function () {
			fc.assert(
				fc.property(
					fc.array(
						fc.oneof(
							fc.record({ kind: fc.constantFrom('start' as const, 'stop' as const, 'lap' as const, 'reset' as const) }),
							fc.record({ kind: fc.constant('advance' as const), ms: fc.integer({ min: -50, max: 1000 }) })
						) as fc.Arbitrary<Op>,
						{ maxLength: 50 }
					),
					function (ops) {
						let clock = 10_000;
						const watch = createStopwatch({
							now: function () {
								return clock;
							}
						});
						let running = false;
						let measured = 0;
						let lapsTotal = 0;
						let last = clock;
						for (const op of ops) {
							if (op.kind === 'advance') {
								clock += op.ms;
								if (running) {
									measured += Math.max(clock - last, 0);
									last = clock;
								}
							} else if (op.kind === 'start') {
								watch.start();
								if (!running) last = clock;
								running = true;
							} else if (op.kind === 'stop') {
								expect(watch.stop()).toBe(measured);
								running = false;
							} else if (op.kind === 'reset') {
								watch.reset();
								running = false;
								measured = 0;
								lapsTotal = 0;
							} else {
								const split = watch.lap();
								expect(split).toBeGreaterThanOrEqual(0);
								lapsTotal += split;
								expect(lapsTotal).toBe(measured);
							}
							expect(watch.running).toBe(running);
							expect(watch.elapsed).toBe(measured);
						}
					}
				)
			);
		});
	});
});
