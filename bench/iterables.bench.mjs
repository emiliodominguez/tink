import {
	chunk,
	concat,
	countItems,
	drop,
	enumerate,
	filter,
	find,
	flatMap,
	map,
	mapConcurrent,
	reduce,
	scan,
	take,
	toArray,
	unique,
	windowed,
	zip
} from '@emiliodominguez/tink/iterables';
import { pMapIterable } from 'p-map';

// No library offers the same lazy, closing-aware helpers, so each case is compared with what one would write instead:
// eager array methods (`array`), hand-written generators (`generator`), and the native iterator helpers (`iterator helpers`).
const SIZES = [10, 1_000, 100_000];

/**
 * Formats an input size for case names.
 * @param {number} n - The number of items
 * @returns {string} e.g. `'10'`, `'1k'`, `'100k'`
 */
function label(n) {
	return n >= 1000 ? `${n / 1000}k` : String(n);
}

/**
 * Pseudo-random integers in `[0, modulo)` (deterministic).
 * @param {number} n - How many numbers
 * @param {number} modulo - Exclusive upper bound
 * @returns {number[]} The numbers
 */
function integers(n, modulo) {
	return Array.from({ length: n }, function (_, index) {
		return (index * 7919) % modulo;
	});
}

/**
 * Builds one bench case per size.
 * @param {string} name - The helper(s) being measured
 * @param {(n: number) => { fn: () => unknown, competitors?: Record<string, () => unknown> }} build - Creates the inputs and the measured functions
 * @returns {object[]} The cases
 */
function sized(name, build) {
	return SIZES.map(function (n) {
		return Object.assign({ name: `${name} (${label(n)})` }, build(n));
	});
}

/**
 * @param {number} value - A number
 * @returns {number} Twice the number
 */
function double(value) {
	return value * 2;
}
/**
 * @param {number} value - A number
 * @returns {boolean} Whether it is a multiple of 3
 */
function isMultipleOf3(value) {
	return value % 3 === 0;
}
/**
 * @param {number} total - The running total
 * @param {number} value - A number
 * @returns {number} The new total
 */
function add(total, value) {
	return total + value;
}
/**
 * @param {number} value - A number
 * @returns {number[]} The number twice
 */
function twice(value) {
	return [value, value];
}

/**
 * A hand-written lazy map.
 * @param {Iterable<number>} iterable - The source
 * @param {(value: number) => number} fn - The mapping
 * @yields {number} The mapped values
 * @returns {Generator<number>} The mapped values
 */
function* mapGenerator(iterable, fn) {
	for (const value of iterable) yield fn(value);
}
/**
 * A hand-written lazy filter.
 * @param {Iterable<number>} iterable - The source
 * @param {(value: number) => boolean} predicate - The test
 * @yields {number} The kept values
 * @returns {Generator<number>} The kept values
 */
function* filterGenerator(iterable, predicate) {
	for (const value of iterable) if (predicate(value)) yield value;
}
/**
 * A hand-written lazy take.
 * @param {Iterable<number>} iterable - The source
 * @param {number} n - How many values
 * @yields {number} The first values
 * @returns {Generator<number>} The first values
 */
function* takeGenerator(iterable, n) {
	if (n <= 0) return;
	let taken = 0;
	for (const value of iterable) {
		yield value;
		if (++taken >= n) return;
	}
}

export default [
	...sized('map → filter → take → toArray', function (n) {
		const numbers = integers(n, n);
		const limit = n >> 2;
		return {
			fn: function () {
				return toArray(take(filter(map(numbers, double), isMultipleOf3), limit));
			},
			competitors: {
				array: function () {
					return numbers.map(double).filter(isMultipleOf3).slice(0, limit);
				},
				generator: function () {
					return Array.from(takeGenerator(filterGenerator(mapGenerator(numbers, double), isMultipleOf3), limit));
				},
				'iterator helpers': function () {
					return numbers.values().map(double).filter(isMultipleOf3).take(limit).toArray();
				}
			}
		};
	}),
	...sized('map → toArray', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(map(numbers, double));
			},
			competitors: {
				array: function () {
					return numbers.map(double);
				},
				generator: function () {
					return Array.from(mapGenerator(numbers, double));
				},
				'iterator helpers': function () {
					return numbers.values().map(double).toArray();
				}
			}
		};
	}),
	...sized('unique (~50% duplicates)', function (n) {
		const numbers = integers(n, Math.max(1, n >> 1));
		return {
			fn: function () {
				return toArray(unique(numbers));
			},
			competitors: {
				array: function () {
					return Array.from(new Set(numbers));
				}
			}
		};
	}),
	...sized('zip (2 arrays)', function (n) {
		const numbers = integers(n, n);
		const words = numbers.map(String);
		return {
			fn: function () {
				return toArray(zip(numbers, words));
			},
			competitors: {
				array: function () {
					return numbers.map(function (value, index) {
						return [value, words[index]];
					});
				}
			}
		};
	}),
	...sized('chunk (size 3)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(chunk(numbers, 3));
			},
			competitors: {
				array: function () {
					const chunks = [];
					for (let index = 0; index < numbers.length; index += 3) chunks.push(numbers.slice(index, index + 3));
					return chunks;
				}
			}
		};
	}),
	...sized('windowed (size 3)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(windowed(numbers, 3));
			},
			competitors: {
				array: function () {
					const windows = [];
					for (let index = 0; index + 3 <= numbers.length; index++) windows.push(numbers.slice(index, index + 3));
					return windows;
				}
			}
		};
	}),
	...sized('enumerate', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(enumerate(numbers));
			},
			competitors: {
				array: function () {
					return Array.from(numbers.entries());
				}
			}
		};
	}),
	...sized('flatMap', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(flatMap(numbers, twice));
			},
			competitors: {
				array: function () {
					return numbers.flatMap(twice);
				},
				'iterator helpers': function () {
					return numbers.values().flatMap(twice).toArray();
				}
			}
		};
	}),
	...sized('concat (2 arrays)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(concat(numbers, numbers));
			},
			competitors: {
				array: function () {
					return numbers.concat(numbers);
				}
			}
		};
	}),
	...sized('scan (running total)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(scan(numbers, add, 0));
			},
			competitors: {
				array: function () {
					let total = 0;
					return numbers.map(function (value) {
						return (total += value);
					});
				}
			}
		};
	}),
	...sized('drop (half)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return toArray(drop(numbers, n >> 1));
			},
			competitors: {
				array: function () {
					return numbers.slice(n >> 1);
				},
				'iterator helpers': function () {
					return numbers
						.values()
						.drop(n >> 1)
						.toArray();
				}
			}
		};
	}),
	...sized('reduce (sum)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return reduce(numbers, add, 0);
			},
			competitors: {
				array: function () {
					return numbers.reduce(add, 0);
				}
			}
		};
	}),
	...sized('find (last item)', function (n) {
		const numbers = integers(n, n);
		const target = numbers[numbers.length - 1];
		/**
		 * @param {number} value - A number
		 * @returns {boolean} Whether it is the target
		 */
		function isTarget(value) {
			return value === target;
		}
		return {
			fn: function () {
				return find(numbers, isTarget);
			},
			competitors: {
				array: function () {
					return numbers.find(isTarget);
				}
			}
		};
	}),
	...sized('countItems (predicate)', function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return countItems(numbers, isMultipleOf3);
			},
			competitors: {
				array: function () {
					return numbers.filter(isMultipleOf3).length;
				}
			}
		};
	}),
	// Async and awaited by the runner: lazy concurrent mapping of an async source, consumed with `for await`.
	...[10, 1_000].flatMap(function (n) {
		const numbers = integers(n, n);
		/**
		 * An async source over `numbers`.
		 * @returns {AsyncGenerator<number>} The source
		 */
		async function* source() {
			for (const value of numbers) yield value;
		}
		/**
		 * @param {number} value - A number
		 * @returns {Promise<number>} Twice the number
		 */
		async function doubleAsync(value) {
			return value * 2;
		}
		/**
		 * Drains an async iterable.
		 * @param {AsyncIterable<number>} iterable - The iterable
		 * @returns {Promise<number>} The sum of its items
		 */
		async function drain(iterable) {
			let sum = 0;
			for await (const value of iterable) sum += value;
			return sum;
		}
		return [
			{
				name: `mapConcurrent (${label(n)}, concurrency 8)`,
				fn: function () {
					return drain(mapConcurrent(source(), doubleAsync, 8));
				},
				competitors: {
					'p-map pMapIterable': function () {
						return drain(pMapIterable(source(), doubleAsync, { concurrency: 8 }));
					}
				}
			},
			{
				name: `mapConcurrent unordered (${label(n)}, conc. 8)`,
				fn: function () {
					return drain(mapConcurrent(source(), doubleAsync, { concurrency: 8, ordered: false }));
				},
				competitors: {
					'p-map pMapIterable (ordered only)': function () {
						return drain(pMapIterable(source(), doubleAsync, { concurrency: 8 }));
					}
				}
			}
		];
	})
];
