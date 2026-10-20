import {
	createBiMap,
	createBloomFilter,
	createDefaultMap,
	createDeque,
	createLRUCache,
	createMultiMap,
	createPriorityQueue,
	createRingBuffer,
	createTrie
} from 'tinkit/cache';
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

// ---------------------------------------------------------------------------------------------------------------------
// 1.4 structures: ring buffer, default map, bimap, multimap, trie, Bloom filter
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Deterministic pseudo-random words (a 16-letter alphabet, 3 to 10 letters), so that runs compare the same data.
 * @param {number} count - How many words
 * @param {number} seed - The generator seed
 * @returns {string[]} The words
 */
function makeWords(count, seed) {
	let state = seed;
	const words = [];
	for (let i = 0; i < count; i++) {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		const length = 3 + (state % 8);
		let word = '';
		for (let j = 0; j < length; j++) {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			word += String.fromCharCode(97 + (state >>> 28));
		}
		words.push(word);
	}
	return words;
}

/**
 * A naive trie: one object per character, a `Map` of children per node, recursion for listing.
 * @returns {{ set(key: string, value: unknown): void, get(key: string): unknown, keysWithPrefix(prefix: string, limit: number): string[] }} The trie
 */
function naiveTrie() {
	const root = { children: new Map(), terminal: false, value: undefined };
	/**
	 * Lists the keys of a subtree in order.
	 * @param {{ children: Map<string, unknown>, terminal: boolean }} node - The subtree
	 * @param {string} key - Its key
	 * @param {string[]} out - Collected keys
	 * @param {number} limit - Maximum number of keys
	 * @returns {void}
	 */
	function walk(node, key, out, limit) {
		if (out.length >= limit) return;
		if (node.terminal) out.push(key);
		for (const char of [...node.children.keys()].sort()) walk(node.children.get(char), key + char, out, limit);
	}
	return {
		set: function (key, value) {
			let node = root;
			for (const char of key) {
				let child = node.children.get(char);
				if (child === undefined) {
					child = { children: new Map(), terminal: false, value: undefined };
					node.children.set(char, child);
				}
				node = child;
			}
			node.terminal = true;
			node.value = value;
		},
		get: function (key) {
			let node = root;
			for (const char of key) {
				node = node.children.get(char);
				if (node === undefined) return undefined;
			}
			return node.terminal ? node.value : undefined;
		},
		keysWithPrefix: function (prefix, limit) {
			let node = root;
			for (const char of prefix) {
				node = node.children.get(char);
				if (node === undefined) return [];
			}
			const out = [];
			walk(node, prefix, out, limit);
			return out.slice(0, limit);
		}
	};
}

/**
 * The first index of a sorted array whose element is `>= target`.
 * @param {string[]} sorted - A sorted array
 * @param {string} target - The value
 * @returns {number} The insertion index
 */
function lowerBound(sorted, target) {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sorted[middle] < target) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * A minimal Bloom filter: FNV-1a with two seeds, a `Uint8Array` of booleans and a `%` per position.
 * @param {number} bits - Number of bits
 * @param {number} hashes - Number of positions per item
 * @returns {{ add(item: string): void, has(item: string): boolean }} The filter
 */
function naiveBloom(bits, hashes) {
	const flags = new Uint8Array(bits);
	/**
	 * FNV-1a of a string with a seed.
	 * @param {string} text - The string
	 * @param {number} seed - The offset basis
	 * @returns {number} The hash
	 */
	function fnv(text, seed) {
		let hash = seed;
		for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
		return hash >>> 0;
	}
	return {
		add: function (item) {
			const a = fnv(item, 2166136261);
			const b = fnv(item, 3735928559);
			for (let i = 0; i < hashes; i++) flags[(a + i * b) % bits] = 1;
		},
		has: function (item) {
			const a = fnv(item, 2166136261);
			const b = fnv(item, 3735928559);
			for (let i = 0; i < hashes; i++) if (flags[(a + i * b) % bits] === 0) return false;
			return true;
		}
	};
}

const words = makeWords(10_000, 42);
const probes = makeWords(1000, 7);
const prefixes = probes.map(function (word) {
	return word.slice(0, 2);
});
const sortedWords = [...new Set(words)].sort();
const trie = createTrie(
	words.map(function (word, index) {
		return [word, index];
	})
);
const naive = naiveTrie();
const wordMap = new Map();
words.forEach(function (word, index) {
	naive.set(word, index);
	wordMap.set(word, index);
});
const ring = createRingBuffer(100);
const boundedDeque = createDeque(null, { capacity: 100 });
const ringArray = [];
const nativeGetOrInsert = typeof Map.prototype.getOrInsertComputed === 'function';
const bloom = createBloomFilter({ expectedItems: 10_000, falsePositiveRate: 0.01 });
const simpleBloom = naiveBloom(bloom.bits, bloom.hashes);
const exact = new Set(words);
for (const word of words) {
	bloom.add(word);
	simpleBloom.add(word);
}
const urls = probes.map(function (word, index) {
	return `/api/${word}/${index}/details`;
});
const routes = createTrie(
	urls.map(function (url) {
		return [url.slice(0, url.lastIndexOf('/')), url];
	})
);
const urlTrie = createTrie(
	urls.map(function (url, index) {
		return [url, index];
	})
);
const urlMap = new Map(
	urls.map(function (url, index) {
		return [url, index];
	})
);
const naiveUrls = naiveTrie();
urls.forEach(function (url, index) {
	naiveUrls.set(url, index);
});
const routeMap = new Map(
	urls.map(function (url) {
		return [url.slice(0, url.lastIndexOf('/')), url];
	})
);

/**
 * Groups words by their first letter with a plain `Map` (the pattern `createMultiMap` and `createDefaultMap` replace).
 * @returns {Map<string, string[]>} The groups
 */
function groupWithMap() {
	const groups = new Map();
	for (let i = 0; i < 1000; i++) {
		const word = words[i];
		const key = word[0];
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [word]);
		else group.push(word);
	}
	return groups;
}

const structures = [
	{
		name: 'createRingBuffer: push 1k into capacity 100',
		fn: function () {
			for (let i = 0; i < 1000; i++) ring.push(i);
			return ring.size;
		},
		baseline: function () {
			for (let i = 0; i < 1000; i++) {
				ringArray.push(i);
				if (ringArray.length > 100) ringArray.shift();
			}
			return ringArray.length;
		},
		competitors: {
			'createDeque({ capacity })': function () {
				for (let i = 0; i < 1000; i++) boundedDeque.pushBack(i);
				return boundedDeque.size;
			}
		}
	},
	{
		name: 'createRingBuffer: at(i) over 100 values',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += ring.at(i);
			return total;
		},
		competitors: {
			'createDeque.at': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += boundedDeque.at(i);
				return total;
			}
		}
	},
	{
		name: 'createDefaultMap: group 1k words',
		fn: function () {
			const groups = createDefaultMap(function () {
				return [];
			});
			for (let i = 0; i < 1000; i++) groups.get(words[i][0]).push(words[i]);
			return groups.size;
		},
		baseline: groupWithMap,
		competitors: nativeGetOrInsert
			? {
					'Map.getOrInsertComputed': function () {
						const groups = new Map();
						for (let i = 0; i < 1000; i++) {
							groups
								.getOrInsertComputed(words[i][0], function () {
									return [];
								})
								.push(words[i]);
						}
						return groups.size;
					}
				}
			: {}
	},
	{
		name: 'createMultiMap: add 1k words by first letter',
		fn: function () {
			const groups = createMultiMap();
			for (let i = 0; i < 1000; i++) groups.add(words[i][0], words[i]);
			return groups.size;
		},
		baseline: groupWithMap
	},
	{
		name: 'createMultiMap unique: add 1k words by first letter',
		fn: function () {
			const groups = createMultiMap(null, { unique: true });
			for (let i = 0; i < 1000; i++) groups.add(words[i][0], words[i]);
			return groups.size;
		},
		baseline: function () {
			const groups = new Map();
			for (let i = 0; i < 1000; i++) {
				const key = words[i][0];
				const group = groups.get(key);
				if (group === undefined) groups.set(key, new Set([words[i]]));
				else group.add(words[i]);
			}
			return groups.size;
		}
	},
	{
		name: 'createBiMap: set 1k pairs + 1k getKey',
		fn: function () {
			const map = createBiMap();
			let total = 0;
			for (let i = 0; i < 1000; i++) map.set(words[i], i);
			for (let i = 0; i < 1000; i++) total += map.getKey(i) === words[i] ? 1 : 0;
			return total;
		},
		baseline: function () {
			// Two plain maps, without removing stale pairs.
			const forward = new Map();
			const backward = new Map();
			let total = 0;
			for (let i = 0; i < 1000; i++) {
				forward.set(words[i], i);
				backward.set(i, words[i]);
			}
			for (let i = 0; i < 1000; i++) total += backward.get(i) === words[i] ? 1 : 0;
			return total;
		}
	},
	{
		name: 'createTrie: build from 10k words',
		fn: function () {
			const built = createTrie();
			for (let i = 0; i < words.length; i++) built.set(words[i], i);
			return built.size;
		},
		baseline: function () {
			const built = new Map();
			for (let i = 0; i < words.length; i++) built.set(words[i], i);
			return built.size;
		},
		competitors: {
			'naive char trie': function () {
				const built = naiveTrie();
				for (let i = 0; i < words.length; i++) built.set(words[i], i);
				return built;
			}
		}
	},
	{
		name: 'createTrie: get 1k (hits and misses)',
		fn: function () {
			let found = 0;
			for (let i = 0; i < 1000; i++) if (trie.get(probes[i]) !== undefined) found++;
			for (let i = 0; i < 1000; i++) if (trie.get(words[i]) !== undefined) found++;
			return found;
		},
		baseline: function () {
			let found = 0;
			for (let i = 0; i < 1000; i++) if (wordMap.get(probes[i]) !== undefined) found++;
			for (let i = 0; i < 1000; i++) if (wordMap.get(words[i]) !== undefined) found++;
			return found;
		},
		competitors: {
			'naive char trie': function () {
				let found = 0;
				for (let i = 0; i < 1000; i++) if (naive.get(probes[i]) !== undefined) found++;
				for (let i = 0; i < 1000; i++) if (naive.get(words[i]) !== undefined) found++;
				return found;
			}
		}
	},
	{
		name: 'createTrie: get 1k paths (~25 chars)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += urlTrie.get(urls[i]);
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += urlMap.get(urls[i]);
			return total;
		},
		competitors: {
			'naive char trie': function () {
				let total = 0;
				for (let i = 0; i < 1000; i++) total += naiveUrls.get(urls[i]);
				return total;
			}
		}
	},
	{
		name: 'createTrie: keysWithPrefix (100 two-letter prefixes, limit 10)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < 100; i++) count += trie.keysWithPrefix(prefixes[i], { limit: 10 }).length;
			return count;
		},
		baseline: function () {
			// Binary search in a sorted array: the best static alternative.
			let count = 0;
			for (let i = 0; i < 100; i++) {
				const prefix = prefixes[i];
				const result = [];
				for (let j = lowerBound(sortedWords, prefix); j < sortedWords.length && result.length < 10 && sortedWords[j].startsWith(prefix); j++)
					result.push(sortedWords[j]);
				count += result.length;
			}
			return count;
		},
		competitors: {
			'naive char trie': function () {
				let count = 0;
				for (let i = 0; i < 100; i++) count += naive.keysWithPrefix(prefixes[i], 10).length;
				return count;
			},
			'filter + sort': function () {
				let count = 0;
				for (let i = 0; i < 100; i++) {
					const prefix = prefixes[i];
					count += words
						.filter(function (word) {
							return word.startsWith(prefix);
						})
						.sort()
						.slice(0, 10).length;
				}
				return count;
			}
		}
	},
	{
		name: 'createTrie: longestPrefixOf (1k paths)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < 1000; i++) if (routes.longestPrefixOf(urls[i]) !== undefined) count++;
			return count;
		},
		baseline: function () {
			// Every prefix, longest first, looked up in a Map.
			let count = 0;
			for (let i = 0; i < 1000; i++) {
				const url = urls[i];
				for (let end = url.length; end >= 0; end--) {
					if (routeMap.has(url.slice(0, end))) {
						count++;
						break;
					}
				}
			}
			return count;
		}
	},
	{
		name: 'createBloomFilter: add 1k words',
		fn: function () {
			const filter = createBloomFilter({ expectedItems: 1000, falsePositiveRate: 0.01 });
			for (let i = 0; i < 1000; i++) filter.add(words[i]);
			return filter;
		},
		baseline: function () {
			const set = new Set();
			for (let i = 0; i < 1000; i++) set.add(words[i]);
			return set;
		},
		competitors: {
			'naive Bloom filter': function () {
				const filter = naiveBloom(9600, 7);
				for (let i = 0; i < 1000; i++) filter.add(words[i]);
				return filter;
			}
		}
	},
	{
		name: 'createBloomFilter: has 1k (hits and misses)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < 1000; i++) if (bloom.has(probes[i])) count++;
			for (let i = 0; i < 1000; i++) if (bloom.has(words[i])) count++;
			return count;
		},
		baseline: function () {
			let count = 0;
			for (let i = 0; i < 1000; i++) if (exact.has(probes[i])) count++;
			for (let i = 0; i < 1000; i++) if (exact.has(words[i])) count++;
			return count;
		},
		competitors: {
			'naive Bloom filter': function () {
				let count = 0;
				for (let i = 0; i < 1000; i++) if (simpleBloom.has(probes[i])) count++;
				for (let i = 0; i < 1000; i++) if (simpleBloom.has(words[i])) count++;
				return count;
			}
		}
	}
];

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
	}),
	...structures
];
