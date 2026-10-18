// The bench runner is synchronous, so these cases only measure synchronous overhead, and leave nothing pending behind them (every
// promise they create is either settled without reactions or never settles and is garbage collected). Awaited throughput against
// p-limit / es-toolkit (`mapAsync`, `limitAsync`) is not measurable here: their work runs in microtasks after the case returns.
import { createDeferred, createLimiter, throwIfAborted } from '@emiliodominguez/tink/async';

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
const controller = new AbortController();

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
	}
];
