import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { partition as partitionArray } from 'tinkit/arrays';
import {
	bufferTime,
	chunk,
	chunkAsync,
	concat,
	countItems,
	drop,
	enumerate,
	filter,
	find,
	flatMap,
	interleave,
	map,
	mapConcurrent,
	mergeAsync,
	pairwise,
	parseNdjson,
	parseSSE,
	partition,
	readLines,
	reduce,
	scan,
	streamToBytes,
	streamToText,
	take,
	toArray,
	unique,
	windowed,
	zip
} from 'tinkit/iterables';
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

// ---------------------------------------------------------------------------------------------------------------------
// Stream readers and combinators (1.4.0). Each reader is compared with the naive approach on the whole buffer (which needs the
// entire stream in memory first) and, where Node has one, with the built-in streaming equivalent.
// ---------------------------------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Cuts a string or a byte buffer into chunks of `size`.
 * @template {string | Uint8Array} T
 * @param {T} whole - The data
 * @param {number} size - The chunk size
 * @returns {T[]} The chunks
 */
function cut(whole, size) {
	const chunks = [];
	for (let start = 0; start < whole.length; start += size) chunks.push(whole.slice(start, start + size));
	return chunks;
}

/**
 * Drains an async iterable, counting its items.
 * @param {AsyncIterable<unknown>} iterable - The iterable
 * @returns {Promise<number>} How many items it had
 */
async function countAsync(iterable) {
	let total = 0;
	for await (const _ of iterable) total++;
	return total;
}

/**
 * The naive line splitting: the whole text at once.
 * @param {string} text - The text
 * @returns {string[]} The lines
 */
function splitAll(text) {
	const lines = text.split(/\r\n|\r|\n/);
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * A naive streaming line splitter: appends each chunk to a buffer and searches it again from the start (quadratic on long lines).
 * @param {string[]} chunks - The chunks
 * @returns {string[]} The lines
 */
function rescanningLines(chunks) {
	const lines = [];
	let buffer = '';
	for (const chunk of chunks) {
		buffer += chunk;
		let match;
		while ((match = /\r\n|\r|\n/.exec(buffer)) !== null) {
			lines.push(buffer.slice(0, match.index));
			buffer = buffer.slice(match.index + match[0].length);
		}
	}
	if (buffer !== '') lines.push(buffer);
	return lines;
}

/**
 * Lines through Node's readline.
 * @param {Array<string | Uint8Array>} chunks - The chunks
 * @returns {Promise<number>} How many lines
 */
function readlineCount(chunks) {
	return countAsync(createInterface({ input: Readable.from(chunks), crlfDelay: Infinity }));
}

/**
 * What one writes without a parser: split events on blank lines, then keep the `data:` lines.
 * @param {string} text - The whole event stream
 * @returns {Array<{ event: string, data: string }>} The events
 */
function naiveSSE(text) {
	const events = [];
	for (const block of text.split('\n\n')) {
		if (block === '') continue;
		const data = [];
		let event = 'message';
		for (const line of block.split('\n')) {
			if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
			else if (line.startsWith('event:')) event = line.slice(6).trim();
		}
		events.push({ event, data: data.join('\n') });
	}
	return events;
}

/**
 * A naive merge: `Promise.race` over the pending `next()` of every source, rebuilt for each value.
 * @param {AsyncIterable<number>[]} sources - The sources
 * @returns {Promise<number>} How many values
 */
async function raceMerge(sources) {
	const iterators = sources.map(function (source) {
		return source[Symbol.asyncIterator]();
	});
	const pending = new Map();
	/**
	 * @param {number} index - The source
	 * @returns {void}
	 */
	function pull(index) {
		pending.set(
			index,
			iterators[index].next().then(function (result) {
				return { index, result };
			})
		);
	}
	iterators.forEach(function (_, index) {
		pull(index);
	});
	let total = 0;
	while (pending.size > 0) {
		const { index, result } = await Promise.race(pending.values());
		if (result.done) {
			pending.delete(index);
		} else {
			total++;
			pull(index);
		}
	}
	return total;
}

/**
 * An async generator over the values.
 * @param {number[]} values - The values
 * @yields {number} The values
 * @returns {AsyncGenerator<number>} The values
 */
async function* asyncValues(values) {
	for (const value of values) yield value;
}

const LOG = Array.from({ length: 20_000 }, function (_, index) {
	return `2026-10-20T12:00:${String(index % 60).padStart(2, '0')}Z INFO request ${index} ${'x'.repeat(index % 80)}`;
}).join('\n');
const LOG_TEXT_CHUNKS = cut(LOG, 65_536);
const LOG_BYTE_CHUNKS = cut(encoder.encode(LOG), 65_536);
const LONG_LINE_CHUNKS = cut('y'.repeat(1_000_000) + '\n', 1000);
const NDJSON = Array.from({ length: 10_000 }, function (_, index) {
	return JSON.stringify({ id: index, name: `user ${index}`, tags: ['a', 'b'], score: index / 7 });
}).join('\n');
const NDJSON_CHUNKS = cut(encoder.encode(NDJSON), 65_536);
const SSE = Array.from({ length: 10_000 }, function (_, index) {
	return `data: {"choices":[{"delta":{"content":"token ${index}"}}]}\n\n`;
}).join('');
const SSE_CHUNKS = cut(encoder.encode(SSE), 16_384);
const BYTE_CHUNKS = cut(new Uint8Array(1 << 20).fill(7), 16_384);
const MERGE_VALUES = Array.from({ length: 2_500 }, function (_, index) {
	return index;
});
const NUMBERS = integers(30_000, 30_000);

const streamCases = [
	{
		name: 'readLines (20k lines, 64 KiB string chunks)',
		fn: function () {
			return countAsync(readLines(LOG_TEXT_CHUNKS));
		},
		baseline: function () {
			return splitAll(LOG_TEXT_CHUNKS.join('')).length;
		},
		competitors: {
			'node:readline': function () {
				return readlineCount(LOG_TEXT_CHUNKS);
			}
		}
	},
	{
		name: 'readLines (20k lines, 64 KiB UTF-8 chunks)',
		fn: function () {
			return countAsync(readLines(LOG_BYTE_CHUNKS));
		},
		baseline: function () {
			return splitAll(new TextDecoder().decode(Buffer.concat(LOG_BYTE_CHUNKS))).length;
		},
		competitors: {
			'node:readline': function () {
				return readlineCount(LOG_BYTE_CHUNKS);
			}
		}
	},
	{
		name: 'readLines (one 1 MB line in 1000 chunks)',
		fn: function () {
			return countAsync(readLines(LONG_LINE_CHUNKS));
		},
		baseline: function () {
			return rescanningLines(LONG_LINE_CHUNKS).length;
		},
		competitors: {
			'node:readline': function () {
				return readlineCount(LONG_LINE_CHUNKS);
			}
		}
	},
	{
		name: 'parseNdjson (10k records, 64 KiB chunks)',
		fn: function () {
			return countAsync(parseNdjson(NDJSON_CHUNKS));
		},
		baseline: function () {
			return splitAll(new TextDecoder().decode(Buffer.concat(NDJSON_CHUNKS))).map(function (line) {
				return JSON.parse(line);
			}).length;
		}
	},
	{
		name: 'parseSSE (10k LLM deltas, 16 KiB chunks)',
		fn: function () {
			return countAsync(parseSSE(SSE_CHUNKS));
		},
		baseline: function () {
			return naiveSSE(new TextDecoder().decode(Buffer.concat(SSE_CHUNKS))).length;
		}
	},
	{
		name: 'parseSSE (10k LLM deltas, from a ReadableStream)',
		fn: function () {
			return countAsync(parseSSE(ReadableStream.from(SSE_CHUNKS)));
		},
		baseline: async function () {
			return naiveSSE(await new Response(ReadableStream.from(SSE_CHUNKS)).text()).length;
		}
	},
	{
		name: 'streamToText (1.2 MB, ReadableStream of 64 KiB)',
		fn: function () {
			return streamToText(ReadableStream.from(LOG_BYTE_CHUNKS));
		},
		competitors: {
			'Response#text()': function () {
				return new Response(ReadableStream.from(LOG_BYTE_CHUNKS)).text();
			}
		}
	},
	{
		name: 'streamToBytes (1 MiB in 16 KiB chunks)',
		fn: function () {
			return streamToBytes(BYTE_CHUNKS);
		},
		baseline: function () {
			// Growing the result chunk by chunk copies it again each time.
			let result = new Uint8Array(0);
			for (const chunk of BYTE_CHUNKS) {
				const next = new Uint8Array(result.length + chunk.length);
				next.set(result);
				next.set(chunk, result.length);
				result = next;
			}
			return result;
		},
		competitors: {
			'Buffer.concat (sync)': function () {
				return Buffer.concat(BYTE_CHUNKS);
			},
			'Response#arrayBuffer()': function () {
				return new Response(ReadableStream.from(BYTE_CHUNKS)).arrayBuffer();
			}
		}
	},
	{
		name: 'mergeAsync (4 async sources × 2.5k)',
		fn: function () {
			return countAsync(mergeAsync(asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES)));
		},
		baseline: function () {
			return raceMerge([asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES), asyncValues(MERGE_VALUES)]);
		}
	},
	{
		name: 'bufferTime (10k items, maxSize 100)',
		fn: function () {
			return countAsync(bufferTime(asyncValues(MERGE_VALUES.concat(MERGE_VALUES, MERGE_VALUES, MERGE_VALUES)), 1000, { maxSize: 100 }));
		},
		competitors: {
			'chunkAsync (no timer)': function () {
				return countAsync(chunkAsync(asyncValues(MERGE_VALUES.concat(MERGE_VALUES, MERGE_VALUES, MERGE_VALUES)), 100));
			}
		}
	},
	{
		name: 'interleave (3 arrays × 10k)',
		fn: function () {
			return toArray(interleave(NUMBERS.slice(0, 10_000), NUMBERS.slice(10_000, 20_000), NUMBERS.slice(20_000)));
		},
		baseline: function () {
			const lists = [NUMBERS.slice(0, 10_000), NUMBERS.slice(10_000, 20_000), NUMBERS.slice(20_000)];
			const result = [];
			for (let index = 0; index < 10_000; index++) for (const list of lists) result.push(list[index]);
			return result;
		}
	},
	{
		name: 'pairwise (30k)',
		fn: function () {
			return toArray(pairwise(NUMBERS));
		},
		baseline: function () {
			const pairs = [];
			for (let index = 1; index < NUMBERS.length; index++) pairs.push([NUMBERS[index - 1], NUMBERS[index]]);
			return pairs;
		},
		competitors: {
			'windowed(…, 2)': function () {
				return toArray(windowed(NUMBERS, 2));
			}
		}
	},
	{
		name: 'partition (30k)',
		fn: function () {
			return partition(NUMBERS, isMultipleOf3);
		},
		competitors: {
			'arrays.partition': function () {
				return partitionArray(NUMBERS, isMultipleOf3);
			}
		}
	}
];

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
	}),
	...streamCases
];
