import fc from 'fast-check';
import {
	abortable,
	anySignal,
	attemptAsync,
	createBatcher,
	createDeferred,
	createKeyedMutex,
	createLimiter,
	createMutex,
	createQueue,
	createRateLimiter,
	createSemaphore,
	debounceAsync,
	filterWithConcurrency,
	mapSettledWithConcurrency,
	mapWithConcurrency,
	memoizeAsync,
	minDelay,
	promiseAllObject,
	reduceAsync,
	retry,
	sequence,
	waitForEvent
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
				async function (limit, interval, gaps) {
					jest.useFakeTimers({ now: 0 });
					try {
						const limiter = createRateLimiter({ limit, interval });
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
						await jest.advanceTimersByTimeAsync(interval * (gaps.length + 1));
						// Reference: call i starts at max(its request, the previous start, the start `limit` calls earlier + interval).
						const expected: number[] = [];
						requests.forEach(function (request, i) {
							expected.push(Math.max(request, i > 0 ? expected[i - 1] : 0, i >= limit ? expected[i - limit] + interval : 0));
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
						for (let t = 0; t <= 100 && settledAt < 0; t++) await jest.advanceTimersByTimeAsync(t === 0 ? 0 : 1);
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
