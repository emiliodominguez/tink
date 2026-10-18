import { createLRUCache, createPriorityQueue } from 'tinkit/cache';
import { PriorityQueue } from 'p-queue';

/**
 * A minimal LRU cache (Map re-insertion for recency, no TTL, no callbacks, no validation): the theoretical best for this API.
 * @param {number} max - Capacity
 * @returns {{ get(key: unknown): unknown, set(key: unknown, value: unknown): unknown, has(key: unknown): boolean }} The cache
 */
function minimalLRU(max) {
	const map = new Map();
	return {
		get: function (key) {
			const value = map.get(key);
			if (value !== undefined) {
				map.delete(key);
				map.set(key, value);
			}
			return value;
		},
		has: function (key) {
			return map.has(key);
		},
		peek: function (key) {
			return map.get(key);
		},
		set: function (key, value) {
			if (map.has(key)) map.delete(key);
			else if (map.size >= max) map.delete(map.keys().next().value);
			map.set(key, value);
			return this;
		}
	};
}

const SIZE = 1000;
const keys = Array.from({ length: SIZE }, function (_, index) {
	return `key-${index}`;
});
const numberKeys = Array.from({ length: SIZE }, function (_, index) {
	return index * 7;
});
const full = createLRUCache({ max: SIZE });
const withTTL = createLRUCache({ max: SIZE, ttl: 60_000 });
const numeric = createLRUCache({ max: SIZE });
const minimal = minimalLRU(SIZE);
const minimalNumeric = minimalLRU(SIZE);
for (let i = 0; i < SIZE; i++) {
	full.set(keys[i], i);
	withTTL.set(keys[i], i);
	minimal.set(keys[i], i);
	numeric.set(numberKeys[i], i);
	minimalNumeric.set(numberKeys[i], i);
}
const small = createLRUCache({ max: SIZE / 2 });
const minimalSmall = minimalLRU(SIZE / 2);
const map = new Map(
	keys.map(function (key, index) {
		return [key, index];
	})
);
const growingMap = new Map();

export default [
	{
		name: 'get hit (1k string keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) total += full.get(keys[i]);
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) total += map.get(keys[i]);
			return total;
		},
		competitors: {
			'minimal Map LRU': function () {
				let total = 0;
				for (let i = 0; i < SIZE; i++) total += minimal.get(keys[i]);
				return total;
			}
		}
	},
	{
		name: 'get hit (1k number keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) total += numeric.get(numberKeys[i]);
			return total;
		},
		competitors: {
			'minimal Map LRU': function () {
				let total = 0;
				for (let i = 0; i < SIZE; i++) total += minimalNumeric.get(numberKeys[i]);
				return total;
			}
		}
	},
	{
		name: 'get hit with ttl (1k keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) total += withTTL.get(keys[i]);
			return total;
		}
	},
	{
		name: 'get same key repeatedly',
		fn: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) total += full.get(keys[7]);
			return total;
		},
		competitors: {
			'minimal Map LRU': function () {
				let total = 0;
				for (let i = 0; i < SIZE; i++) total += minimal.get(keys[7]);
				return total;
			}
		}
	},
	{
		name: 'get miss (1k keys)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < SIZE; i++) if (small.get(numberKeys[i]) === undefined) count++;
			return count;
		},
		competitors: {
			'minimal Map LRU': function () {
				let count = 0;
				for (let i = 0; i < SIZE; i++) if (minimalSmall.get(numberKeys[i]) === undefined) count++;
				return count;
			}
		}
	},
	{
		name: 'peek/has (1k keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) if (full.has(keys[i])) total += full.peek(keys[i]);
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < SIZE; i++) if (map.has(keys[i])) total += map.get(keys[i]);
			return total;
		},
		competitors: {
			'minimal Map LRU': function () {
				let total = 0;
				for (let i = 0; i < SIZE; i++) if (minimal.has(keys[i])) total += minimal.peek(keys[i]);
				return total;
			}
		}
	},
	{
		name: 'set overwrite (1k keys)',
		fn: function () {
			for (let i = 0; i < SIZE; i++) full.set(keys[i], i);
			return full.size;
		},
		baseline: function () {
			for (let i = 0; i < SIZE; i++) map.set(keys[i], i);
			return map.size;
		},
		competitors: {
			'minimal Map LRU': function () {
				for (let i = 0; i < SIZE; i++) minimal.set(keys[i], i);
				return minimal;
			}
		}
	},
	{
		name: 'set with eviction (1k keys, max 500)',
		fn: function () {
			for (let i = 0; i < SIZE; i++) small.set(keys[i], i);
			return small.size;
		},
		baseline: function () {
			for (let i = 0; i < SIZE; i++) {
				growingMap.set(keys[i], i);
				if (growingMap.size > SIZE / 2) growingMap.delete(growingMap.keys().next().value);
			}
			return growingMap.size;
		},
		competitors: {
			'minimal Map LRU': function () {
				for (let i = 0; i < SIZE; i++) minimalSmall.set(keys[i], i);
				return minimalSmall;
			}
		}
	},
	{
		name: 'iterate entries (1k)',
		fn: function () {
			let count = 0;
			for (const entry of full) count += entry[1];
			return count;
		},
		baseline: function () {
			let count = 0;
			for (const entry of map) count += entry[1];
			return count;
		}
	},
	...[100, 10_000].map(function (n) {
		const priorities = Array.from({ length: n }, function (_, index) {
			return (index * 7919) % 97;
		});
		/**
		 * Max-priority order.
		 * @param {{ priority: number }} a - A task
		 * @param {{ priority: number }} b - Another task
		 * @returns {number} Negative when `a` comes first
		 */
		function byPriority(a, b) {
			return b.priority - a.priority;
		}
		const tasks = priorities.map(function (priority) {
			return { priority };
		});
		return {
			name: `createPriorityQueue: push ${n} + pop all`,
			fn: function () {
				const queue = createPriorityQueue(byPriority);
				for (let i = 0; i < n; i++) queue.push(tasks[i]);
				let last;
				while (queue.size > 0) last = queue.pop();
				return last;
			},
			competitors: {
				'p-queue PriorityQueue': function () {
					const queue = new PriorityQueue();
					for (let i = 0; i < n; i++) queue.enqueue(tasks[i], { priority: priorities[i] });
					let last;
					while (queue.size > 0) last = queue.dequeue();
					return last;
				},
				'stable sort (array)': function () {
					return tasks.slice().sort(byPriority);
				}
			}
		};
	})
];
