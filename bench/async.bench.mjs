// The first cases measure synchronous overhead only, and leave nothing pending behind them (every promise they create is either settled
// without reactions or never settles and is garbage collected). The round-11 cases return promises, which the runner awaits, so they
// measure full async throughput against p-map, p-queue, p-throttle, es-toolkit and radash.
import {
	createDeferred,
	createLimiter,
	createQueue,
	createRateLimiter,
	filterWithConcurrency,
	mapSettledWithConcurrency,
	mapWithConcurrency,
	memoizeAsync,
	throwIfAborted
} from 'tinkit/async';
import * as esToolkit from 'es-toolkit';
import * as lodash from 'lodash-es';
import pMap, { pMapSettled } from 'p-map';
import PQueue from 'p-queue';
import pThrottle from 'p-throttle';
import * as radash from 'radash';

/**
 * A minimal p-limit-style limiter (array queue, no validation, no counters, no clearQueue rejection): the theoretical best for queueing.
 * @param {number} concurrency - Maximum number of running tasks
 * @returns {{ limit: (fn: () => unknown) => Promise<unknown>, clear: () => void }} The limiter
 */
function minimalLimiter(concurrency) {
	let queue = [];
	let active = 0;
	return {
		limit: function (fn) {
			return new Promise(function (resolve, reject) {
				const run = function () {
					active++;
					Promise.resolve(fn()).then(resolve, reject);
				};
				if (active < concurrency) run();
				else queue.push(run);
			});
		},
		clear: function () {
			queue = [];
		}
	};
}

/**
 * A task that never settles: it permanently occupies the limiters' only slot, so that every benchmarked call is queued.
 * @returns {Promise<never>} A promise that never settles
 */
function forever() {
	return new Promise(function () {
		return undefined;
	});
}

/**
 * A task that is never run (its queue entry is discarded).
 * @returns {number} 1
 */
function task() {
	return 1;
}

const busy = createLimiter(1);
busy(forever);
const minimalBusy = minimalLimiter(1);
minimalBusy.limit(forever);
const controller = new globalThis.AbortController();
const items = Array.from({ length: 1000 }, function (_, index) {
	return index;
});
const small = items.slice(0, 10);

/**
 * A minimal async mapper (resolves on the next microtask), so the cases measure scheduling rather than work.
 * @param {number} n - An item
 * @returns {Promise<number>} Twice the item
 */
async function twice(n) {
	return n * 2;
}

/**
 * A minimal async predicate.
 * @param {number} n - An item
 * @returns {Promise<boolean>} Whether the item is even
 */
async function isEven(n) {
	return n % 2 === 0;
}

/**
 * A minimal async task for the queues.
 * @returns {Promise<number>} 1
 */
async function work() {
	return 1;
}

const memoHit = memoizeAsync(twice);
const esMemoHit = esToolkit.memoize(twice);
const lodashMemoHit = lodash.memoize(twice);
await memoHit(1);

export default [
	{
		name: 'createLimiter: queue 100 tasks + clearQueue',
		fn: function () {
			for (let i = 0; i < 100; i++) busy(task);
			busy.clearQueue();
			return busy.pendingCount;
		},
		competitors: {
			'minimal inline limiter': function () {
				for (let i = 0; i < 100; i++) minimalBusy.limit(task);
				minimalBusy.clear();
				return minimalBusy;
			}
		}
	},
	{
		name: 'createDeferred + resolve',
		fn: function () {
			const deferred = createDeferred();
			deferred.resolve(1);
			return deferred.promise;
		},
		baseline: function () {
			const deferred = Promise.withResolvers();
			deferred.resolve(1);
			return deferred.promise;
		}
	},
	{
		name: 'throwIfAborted (not aborted, x100)',
		fn: function () {
			for (let i = 0; i < 100; i++) throwIfAborted(controller.signal);
			return controller;
		},
		baseline: function () {
			for (let i = 0; i < 100; i++) controller.signal.throwIfAborted();
			return controller;
		}
	},
	...[small, items].flatMap(function (list) {
		return [
			{
				name: `mapWithConcurrency (${list.length} items, concurrency 8)`,
				fn: function () {
					return mapWithConcurrency(list, twice, { concurrency: 8 });
				},
				competitors: {
					'p-map': function () {
						return pMap(list, twice, { concurrency: 8 });
					},
					'es-toolkit mapAsync': function () {
						return esToolkit.mapAsync(list, twice, { concurrency: 8 });
					},
					'radash parallel': function () {
						return radash.parallel(8, list, twice);
					}
				}
			},
			{
				name: `mapWithConcurrency (${list.length} items, unbounded)`,
				fn: function () {
					return mapWithConcurrency(list, twice);
				},
				competitors: {
					'p-map': function () {
						return pMap(list, twice);
					},
					'es-toolkit mapAsync': function () {
						return esToolkit.mapAsync(list, twice);
					}
				}
			},
			{
				name: `mapSettledWithConcurrency (${list.length}, conc. 8)`,
				fn: function () {
					return mapSettledWithConcurrency(list, twice, 8);
				},
				competitors: {
					'p-map pMapSettled': function () {
						return pMapSettled(list, twice, { concurrency: 8 });
					}
				}
			},
			{
				name: `filterWithConcurrency (${list.length}, conc. 8)`,
				fn: function () {
					return filterWithConcurrency(list, isEven, 8);
				},
				competitors: {
					'es-toolkit filterAsync': function () {
						return esToolkit.filterAsync(list, isEven, { concurrency: 8 });
					}
				}
			},
			{
				name: `createQueue: add ${list.length} + onIdle (conc. 4)`,
				fn: function () {
					const queue = createQueue({ concurrency: 4 });
					for (let i = 0; i < list.length; i++) queue.add(work, { priority: i % 3 });
					return queue.onIdle();
				},
				competitors: {
					'p-queue': function () {
						const queue = new PQueue({ concurrency: 4 });
						for (let i = 0; i < list.length; i++) queue.add(work, { priority: i % 3 });
						return queue.onIdle();
					}
				}
			},
			{
				name: `createRateLimiter: ${list.length} calls within limit`,
				fn: function () {
					const limiter = createRateLimiter({ limit: list.length, interval: 1000 });
					const calls = [];
					for (let i = 0; i < list.length; i++) calls.push(limiter.schedule(twice, i));
					return Promise.all(calls);
				},
				competitors: {
					'p-throttle (strict)': function () {
						const throttled = pThrottle({ limit: list.length, interval: 1000, strict: true })(twice);
						const calls = [];
						for (let i = 0; i < list.length; i++) calls.push(throttled(i));
						return Promise.all(calls);
					},
					'p-throttle (fixed window)': function () {
						const throttled = pThrottle({ limit: list.length, interval: 1000 })(twice);
						const calls = [];
						for (let i = 0; i < list.length; i++) calls.push(throttled(i));
						return Promise.all(calls);
					}
				}
			}
		];
	}),
	{
		name: 'memoizeAsync: cache hit',
		fn: function () {
			return memoHit(1);
		},
		competitors: {
			'es-toolkit memoize (caches the promise)': function () {
				return esMemoHit(1);
			},
			'lodash memoize (caches the promise)': function () {
				return lodashMemoHit(1);
			}
		}
	},
	{
		name: 'memoizeAsync: 100 misses + 100 hits',
		fn: function () {
			const memo = memoizeAsync(twice);
			const calls = [];
			for (let i = 0; i < 200; i++) calls.push(memo(i % 100));
			return Promise.all(calls);
		},
		competitors: {
			'es-toolkit memoize (caches the promise)': function () {
				const memo = esToolkit.memoize(twice);
				const calls = [];
				for (let i = 0; i < 200; i++) calls.push(memo(i % 100));
				return Promise.all(calls);
			},
			'lodash memoize (caches the promise)': function () {
				const memo = lodash.memoize(twice);
				const calls = [];
				for (let i = 0; i < 200; i++) calls.push(memo(i % 100));
				return Promise.all(calls);
			}
		}
	}
];
