import fc from 'fast-check';
import * as arrays from '../arrays/index.js';
import * as helpers from '.';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

/** Small integers so that duplicates are frequent. */
const smallInt = fc.integer({ min: -8, max: 8 });
const smallInts = fc.array(smallInt, { maxLength: 30 });
const positive = fc.integer({ min: 1, max: 7 });
const count = fc.nat({ max: 40 });

/**
 * Wraps an iterable so that every `[Symbol.iterator]()`, `next()` and `return()` call is counted.
 */
function spy<T>(source: Iterable<T>) {
	const stats = { opened: 0, pulled: 0, closed: 0 };
	const iterable: Iterable<T> = {
		[Symbol.iterator]() {
			stats.opened++;
			const iterator = source[Symbol.iterator]();
			return {
				next() {
					stats.pulled++;
					return iterator.next();
				},
				return(value?: any) {
					stats.closed++;
					iterator.return?.(value);
					return { done: true as const, value };
				}
			};
		}
	};
	return { iterable, stats };
}

/** A one-shot generator over the values, so tests do not accidentally rely on arrays being re-iterable. */
function* once<T>(values: T[]): Generator<T> {
	yield* values;
}

function affine(value: number, index: number): number {
	return value * 3 + index;
}

function isPositive(value: number): boolean {
	return value > 0;
}

describe('iterables (properties)', function () {
	describe('lazy transforms match their eager Array references', function () {
		it('map ≡ Array#map', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					expect(helpers.toArray(helpers.map(once(xs), affine))).toStrictEqual(xs.map(affine));
				})
			);
		});

		it('filter ≡ Array#filter', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					function predicate(value: number, index: number): boolean {
						return (value + index) % 3 === 0;
					}
					expect(helpers.toArray(helpers.filter(once(xs), predicate))).toStrictEqual(xs.filter(predicate));
				})
			);
		});

		it('flatMap ≡ Array#flatMap', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					function expand(value: number, index: number): number[] {
						return arrays.range(Math.abs(value) % 4).map(function (k) {
							return k + index;
						});
					}
					expect(helpers.toArray(helpers.flatMap(once(xs), expand))).toStrictEqual(xs.flatMap(expand));
				})
			);
		});

		it('take / drop ≡ slice ≡ arrays.take / arrays.drop', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					expect(helpers.toArray(helpers.take(once(xs), n))).toStrictEqual(xs.slice(0, n));
					expect(helpers.toArray(helpers.drop(once(xs), n))).toStrictEqual(arrays.drop(xs, n));
					expect(helpers.toArray(helpers.take(once(xs), n))).toStrictEqual(arrays.take(xs, n));
				})
			);
		});

		it('take(n) ++ drop(n) rebuilds the input', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					expect(helpers.toArray(helpers.concat(helpers.take(xs, n), helpers.drop(xs, n)))).toStrictEqual(xs);
				})
			);
		});

		it('takeWhile / dropWhile split the input at the first failing item', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					const failing = xs.findIndex(function (x) {
						return !isPositive(x);
					});
					const cut = failing === -1 ? xs.length : failing;
					expect(helpers.toArray(helpers.takeWhile(once(xs), isPositive))).toStrictEqual(xs.slice(0, cut));
					expect(helpers.toArray(helpers.dropWhile(once(xs), isPositive))).toStrictEqual(xs.slice(cut));
				})
			);
		});

		it('chunk ≡ arrays.chunk', function () {
			fc.assert(
				fc.property(smallInts, positive, function (xs, size) {
					expect(helpers.toArray(helpers.chunk(once(xs), size))).toStrictEqual(arrays.chunk(xs, size));
				})
			);
		});

		it('windowed ≡ arrays.windowed', function () {
			fc.assert(
				fc.property(smallInts, positive, positive, function (xs, size, step) {
					expect(helpers.toArray(helpers.windowed(once(xs), size, step))).toStrictEqual(arrays.windowed(xs, size, step));
				})
			);
		});

		it('zip ≡ arrays.zip', function () {
			fc.assert(
				fc.property(smallInts, fc.array(fc.string(), { maxLength: 30 }), fc.array(fc.boolean(), { maxLength: 30 }), function (a, b, c) {
					expect(helpers.toArray(helpers.zip(once(a), once(b), once(c)))).toStrictEqual(arrays.zip(a, b, c));
					expect(helpers.toArray(helpers.zip(once(a)))).toStrictEqual(arrays.zip(a));
				})
			);
		});

		it('enumerate ≡ Array#map to [index, value]', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					expect(helpers.toArray(helpers.enumerate(once(xs)))).toStrictEqual(
						xs.map(function (value, index) {
							return [index, value];
						})
					);
				})
			);
		});

		it('unique ≡ arrays.unique, and unique(keyFn) ≡ arrays.uniqueBy', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(smallInt, fc.constant(NaN), fc.constant(-0)), { maxLength: 30 }), function (xs) {
					const deduplicated = helpers.toArray(helpers.unique(once(xs)));
					// Both keep the original first item (so -0 stays -0); toStrictEqual tells -0 and +0 apart.
					expect(deduplicated).toStrictEqual(
						arrays.uniqueBy(xs, function (value) {
							return value;
						})
					);
					expect(deduplicated).toStrictEqual(arrays.unique(xs));
					function key(value: number, index: number): number {
						return Math.abs(value) + (index % 2);
					}
					expect(helpers.toArray(helpers.unique(once(xs), key))).toStrictEqual(arrays.uniqueBy(xs, key));
				})
			);
		});

		it('scan yields the reduction of every prefix', function () {
			fc.assert(
				fc.property(smallInts, smallInt, function (xs, initial) {
					function reducer(acc: number, value: number, index: number): number {
						return acc * 2 - value + index;
					}
					const scanned = helpers.toArray(helpers.scan(once(xs), reducer, initial));
					expect(scanned).toStrictEqual(
						xs.map(function (_value, i) {
							return xs.slice(0, i + 1).reduce(reducer, initial);
						})
					);
				})
			);
		});

		it('concat ≡ Array#concat', function () {
			fc.assert(
				fc.property(fc.array(smallInts, { maxLength: 5 }), function (lists) {
					expect(helpers.toArray(helpers.concat(...lists.map(once)))).toStrictEqual(([] as number[]).concat(...lists));
				})
			);
		});

		it('tap yields its input unchanged and sees every item in order', function () {
			fc.assert(
				fc.property(smallInts, function (xs) {
					const seen: number[] = [];
					expect(
						helpers.toArray(
							helpers.tap(once(xs), function (value) {
								seen.push(value);
							})
						)
					).toStrictEqual(xs);
					expect(seen).toStrictEqual(xs);
				})
			);
		});

		it('cycle repeats the input periodically', function () {
			fc.assert(
				fc.property(smallInts, count, function (xs, n) {
					const expected =
						xs.length === 0
							? []
							: arrays.range(n).map(function (i) {
									return xs[i % xs.length];
								});
					expect(helpers.toArray(helpers.take(helpers.cycle(once(xs)), n))).toStrictEqual(expected);
				})
			);
		});
	});

	describe('consumers match their Array references', function () {
		it('reduce, first, last, find, some, every, countItems', function () {
			fc.assert(
				fc.property(smallInts, smallInt, function (xs, initial) {
					function add(acc: number, value: number, index: number): number {
						return acc + value * index;
					}
					expect(helpers.reduce(once(xs), add, initial)).toBe(xs.reduce(add, initial));
					if (xs.length > 0) expect(helpers.reduce(once(xs), add)).toBe(xs.reduce(add));
					expect(helpers.first(once(xs))).toBe(xs[0]);
					expect(helpers.last(once(xs))).toBe(xs[xs.length - 1]);
					expect(helpers.find(once(xs), isPositive)).toBe(xs.find(isPositive));
					expect(helpers.some(once(xs), isPositive)).toBe(xs.some(isPositive));
					expect(helpers.every(once(xs), isPositive)).toBe(xs.every(isPositive));
					expect(helpers.countItems(once(xs))).toBe(xs.length);
					expect(helpers.countItems(once(xs), isPositive)).toBe(xs.filter(isPositive).length);
					expect(helpers.toArray(once(xs))).toStrictEqual(xs);
				})
			);
		});
	});

	describe('laziness over infinite sources', function () {
		const oneToOne: Array<[string, (source: Iterable<number>) => Iterable<unknown>]> = [
			[
				'map',
				function (source) {
					return helpers.map(source, affine);
				}
			],
			[
				'filter (always true)',
				function (source) {
					return helpers.filter(source, function () {
						return true;
					});
				}
			],
			[
				'flatMap (singletons)',
				function (source) {
					return helpers.flatMap(source, function (n) {
						return [n];
					});
				}
			],
			['enumerate', helpers.enumerate],
			['unique', helpers.unique],
			[
				'scan',
				function (source) {
					return helpers.scan(source, affine, 0);
				}
			],
			[
				'tap',
				function (source) {
					return helpers.tap(source, function () {
						return undefined;
					});
				}
			],
			[
				'takeWhile (always true)',
				function (source) {
					return helpers.takeWhile(source, function () {
						return true;
					});
				}
			],
			[
				'zip',
				function (source) {
					return helpers.zip(source);
				}
			],
			['cycle', helpers.cycle],
			['concat', helpers.concat]
		];

		it.each(oneToOne)('take(%s(count()), n) terminates, pulls exactly n items and closes the source once', function (_name, transform) {
			fc.assert(
				fc.property(count, function (n) {
					const { iterable, stats } = spy(helpers.count());
					expect(helpers.toArray(helpers.take(transform(iterable), n))).toHaveLength(n);
					expect(stats.pulled).toBe(n);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});

		it('drop(count(), k) pulls exactly k + n items for n taken items', function () {
			fc.assert(
				fc.property(count, count, function (k, n) {
					const { iterable, stats } = spy(helpers.count());
					expect(helpers.toArray(helpers.take(helpers.drop(iterable, k), n))).toStrictEqual(arrays.range(k, k + n));
					expect(stats.pulled).toBe(n === 0 ? 0 : k + n);
				})
			);
		});

		it('chunk over count() pulls exactly n * size items for n chunks', function () {
			fc.assert(
				fc.property(count, positive, function (n, size) {
					const { iterable, stats } = spy(helpers.count());
					const chunks = helpers.toArray(helpers.take(helpers.chunk(iterable, size), n));
					expect(chunks).toStrictEqual(arrays.chunk(arrays.range(n * size), size));
					expect(stats.pulled).toBe(n * size);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});

		it('windowed over count() pulls exactly size + (n - 1) * step items for n windows', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 30 }), positive, positive, function (n, size, step) {
					const { iterable, stats } = spy(helpers.count());
					const windows = helpers.toArray(helpers.take(helpers.windowed(iterable, size, step), n));
					expect(windows).toStrictEqual(arrays.windowed(arrays.range(size + (n - 1) * step), size, step));
					expect(stats.pulled).toBe(size + (n - 1) * step);
					expect(stats.closed).toBe(1);
				})
			);
		});

		it('zip of several infinite sources pulls n items from each and closes each once', function () {
			fc.assert(
				fc.property(count, fc.integer({ min: 1, max: 4 }), function (n, arity) {
					const spies = arrays.range(arity).map(function () {
						return spy(helpers.count());
					});
					const zipped = helpers.toArray(
						helpers.take(
							helpers.zip(
								...spies.map(function (s) {
									return s.iterable;
								})
							),
							n
						)
					);
					expect(zipped).toHaveLength(n);
					for (const { stats } of spies) {
						expect(stats.pulled).toBe(n);
						expect(stats.closed).toBe(n === 0 ? 0 : 1);
					}
				})
			);
		});

		it('consumers that can stop early pull only what they need and close the source once', function () {
			fc.assert(
				fc.property(count, function (target) {
					function isTarget(value: number): boolean {
						return value === target;
					}
					for (const consume of [helpers.find, helpers.some]) {
						const { iterable, stats } = spy(helpers.count());
						consume(iterable, isTarget);
						expect(stats.pulled).toBe(target + 1);
						expect(stats.closed).toBe(1);
					}
					const { iterable, stats } = spy(helpers.count());
					expect(
						helpers.every(iterable, function (value) {
							return value < target;
						})
					).toBe(false);
					expect(stats.pulled).toBe(target + 1);
					expect(stats.closed).toBe(1);
				})
			);
		});
	});

	describe('early exit', function () {
		it('breaking out of a pipeline closes the source exactly once, whatever the stage count', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 6 }), count, function (stages, n) {
					const { iterable, stats } = spy(helpers.count());
					let pipeline: Iterable<number> = iterable;
					for (let i = 0; i < stages; i++) pipeline = helpers.map(pipeline, affine);
					let seen = 0;
					for (const _value of pipeline) {
						if (seen++ === n) break;
					}
					expect(stats.pulled).toBe(n + 1);
					expect(stats.closed).toBe(1);
				})
			);
		});
	});

	describe('async helpers match their sync counterparts', function () {
		it('mapAsync / filterAsync / takeAsync / chunkAsync', async function () {
			await fc.assert(
				fc.asyncProperty(smallInts, count, positive, async function (xs, n, size) {
					expect(
						await helpers.toArrayAsync(
							helpers.mapAsync(once(xs), async function (value, index) {
								return affine(value, index);
							})
						)
					).toStrictEqual(xs.map(affine));
					expect(
						await helpers.toArrayAsync(
							helpers.filterAsync(once(xs), async function (value) {
								return isPositive(value);
							})
						)
					).toStrictEqual(xs.filter(isPositive));
					expect(await helpers.toArrayAsync(helpers.takeAsync(once(xs), n))).toStrictEqual(xs.slice(0, n));
					expect(await helpers.toArrayAsync(helpers.chunkAsync(once(xs), size))).toStrictEqual(arrays.chunk(xs, size));
					expect(await helpers.toArrayAsync(xs.map(Promise.resolve.bind(Promise)))).toStrictEqual(xs);
				})
			);
		});

		it('takeAsync over an infinite source pulls exactly n items and closes it once', async function () {
			await fc.assert(
				fc.asyncProperty(count, async function (n) {
					const { iterable, stats } = spy(helpers.count());
					expect(await helpers.toArrayAsync(helpers.takeAsync(helpers.mapAsync(iterable, affine), n))).toHaveLength(n);
					expect(stats.pulled).toBe(n);
					expect(stats.closed).toBe(n === 0 ? 0 : 1);
				})
			);
		});
	});
});

describe('mapConcurrent (properties)', function () {
	function ascending(a: number, b: number): number {
		return a - b;
	}

	async function yieldTicks(n: number): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	it('ordered output equals Array#map; unordered output is a permutation of it; read-ahead never exceeds concurrency', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.record({ value: smallInt, delay: fc.nat({ max: 6 }) }), { maxLength: 25 }),
				fc.oneof(positive, fc.constant(Infinity)),
				fc.boolean(),
				async function (items, concurrency, ordered) {
					let produced = 0;
					let consumed = 0;
					let maxAhead = 0;
					const source = (async function* () {
						for (const item of items) {
							produced++;
							maxAhead = Math.max(maxAhead, produced - consumed);
							yield item;
						}
					})();
					const output: number[] = [];
					for await (const value of helpers.mapConcurrent(
						source,
						async function (item) {
							await yieldTicks(item.delay);
							return item.value * 2;
						},
						{ concurrency, ordered }
					)) {
						consumed++;
						output.push(value);
						await yieldTicks(2);
					}
					const expected = items.map(function (item) {
						return item.value * 2;
					});
					if (ordered) expect(output).toEqual(expected);
					else expect(output.slice().sort(ascending)).toEqual(expected.slice().sort(ascending));
					// The item being consumed plus at most `concurrency` buffered ones.
					expect(maxAhead).toBeLessThanOrEqual(Math.min(concurrency, items.length) + 1);
				}
			)
		);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// 1.4.0: stream readers and combinators
// ---------------------------------------------------------------------------------------------------------------------

/** Cuts a string or byte buffer into chunks at the given points (repeated points give empty chunks). */
function cutAt<T extends string | Uint8Array>(whole: T, points: number[]): T[] {
	const cuts = points
		.map(function (point) {
			return point % (whole.length + 1);
		})
		.sort(function (a, b) {
			return a - b;
		});
	const chunks: T[] = [];
	let start = 0;
	for (const cut of cuts) {
		chunks.push(whole.slice(start, cut) as T);
		start = cut;
	}
	chunks.push(whole.slice(start) as T);
	return chunks;
}

/** The lines `readLines` must give: split the whole text on every line break, and drop a final empty line. */
function naiveLines(text: string): string[] {
	const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Node's readline, the reference for line splitting. Empty chunks are left out: readline forgets a CR that ended the previous chunk when
 * it receives one, so it would count `['\r', '', '\n']` as two line breaks (the same text as `'\r\n'`, a single break).
 */
async function readlineLines(chunks: Array<string | Uint8Array>): Promise<string[]> {
	const lines: string[] = [];
	const input = Readable.from(
		chunks
			.filter(function (chunk) {
				return chunk.length > 0;
			})
			.map(function (chunk) {
				return typeof chunk === 'string' ? chunk : Buffer.from(chunk);
			})
	);
	for await (const line of createInterface({ input, crlfDelay: Infinity })) lines.push(line);
	return lines;
}

/**
 * The WHATWG "event stream interpretation" algorithm, written as literally as possible over the whole text. With `maxData`, the events
 * dispatched before the data buffer (without its final LF) gets longer than it, then `null`.
 */
function referenceSSE(whole: string, maxData = Infinity): Array<helpers.ServerSentEvent | null> {
	const text = whole.startsWith('﻿') ? whole.slice(1) : whole;
	const lines = text.split(/\r\n|\r|\n/);
	// The last piece is not followed by a line break: it is not a line.
	lines.pop();
	const events: Array<helpers.ServerSentEvent | null> = [];
	let data = '';
	let type = '';
	let lastEventId = '';
	let retry: number | undefined;
	for (const line of lines) {
		if (line === '') {
			if (data === '') {
				type = '';
				continue;
			}
			if (data.endsWith('\n')) data = data.slice(0, -1);
			const event: helpers.ServerSentEvent = { event: type === '' ? 'message' : type, data, id: lastEventId };
			if (retry !== undefined) event.retry = retry;
			events.push(event);
			data = '';
			type = '';
			continue;
		}
		if (line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') type = value;
		else if (field === 'data') {
			data += value + '\n';
			if (data.length - 1 > maxData) {
				events.push(null);
				break;
			}
		} else if (field === 'id' && !value.includes('\0')) lastEventId = value;
		else if (field === 'retry' && /^[0-9]+$/.test(value)) retry = parseInt(value, 10);
	}
	return events;
}

function joined(parts: string[]): string {
	return parts.join('');
}

const sseTokens = ['data', 'event', 'id', 'retry', 'data:', 'id:', 'retry:', ':', ': ', ' ', 'x', 'é', '7', '0', '\0', '\r', '\n', '\r\n', '\n\n', '﻿'];
const sseText = fc.array(fc.constantFrom(...sseTokens), { maxLength: 40 }).map(joined);
const lineText = fc.array(fc.constantFrom('a', 'b', ' ', '\r', '\n', '\r\n', 'é', '€', '😀', '﻿'), { maxLength: 40 }).map(joined);
const cuts = fc.array(fc.nat({ max: 200 }), { maxLength: 8 });

describe('stream readers (properties)', function () {
	it('readLines ≡ Node readline (crlfDelay: Infinity) on text chunks and on UTF-8 bytes cut anywhere', async function () {
		await fc.assert(
			fc.asyncProperty(lineText, cuts, fc.boolean(), async function (text, points, asBytes) {
				// readline keeps a byte order mark: compared on text that does not start with one.
				fc.pre(!text.startsWith('﻿'));
				const chunks: Array<string | Uint8Array> = asBytes ? cutAt(new TextEncoder().encode(text), points) : cutAt(text, points);
				const lines = await helpers.toArrayAsync(helpers.readLines(chunks));
				expect(lines).toEqual(await readlineLines(chunks));
				expect(lines).toEqual(naiveLines(text));
			})
		);
	});

	it('readLines on arbitrary bytes ≡ splitting the TextDecoder output of the whole input', async function () {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ maxLength: 60 }), cuts, async function (data, points) {
				const lines = await helpers.toArrayAsync(helpers.readLines(cutAt(data, points)));
				expect(lines).toEqual(naiveLines(new TextDecoder('utf-8', { ignoreBOM: true }).decode(data)));
			})
		);
	});

	it('readLines throws a RangeError exactly when a line is longer than maxLineLength, after the lines before it', async function () {
		await fc.assert(
			fc.asyncProperty(lineText, cuts, fc.nat({ max: 12 }), async function (text, points, max) {
				const expected = naiveLines(text);
				const tooLong = expected.findIndex(function (line) {
					return line.length > max;
				});
				const read: string[] = [];
				let error: unknown;
				try {
					for await (const line of helpers.readLines(cutAt(text, points), { maxLineLength: max })) read.push(line);
				} catch (caught) {
					error = caught;
				}
				// Whatever the chunking: the same lines, then the error of the same line.
				if (tooLong === -1) {
					expect(error).toBeUndefined();
					expect(read).toEqual(expected);
				} else {
					expect(error).toEqual(new RangeError(`readLines: line ${tooLong + 1} is longer than \`maxLineLength\` (${max})`));
					expect(read).toEqual(expected.slice(0, tooLong));
				}
			})
		);
	});

	it('streamToText ≡ TextDecoder on the whole input; streamToBytes ≡ concatenating the chunks', async function () {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ maxLength: 60 }), cuts, async function (data, points) {
				const chunks = cutAt(data, points);
				expect(await helpers.streamToText(chunks)).toBe(new TextDecoder().decode(data));
				expect(await helpers.streamToBytes(chunks)).toEqual(data);
				expect(await helpers.streamToArray(chunks)).toEqual(chunks);
			})
		);
	});

	it('streamToText ≡ TextDecoderStream on a ReadableStream of random byte chunks', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.uint8Array({ maxLength: 8 }), { maxLength: 8 }), async function (chunks) {
				function stream(): ReadableStream<Uint8Array> {
					const copies = chunks.map(function (chunk) {
						return Buffer.from(chunk);
					});
					return Readable.toWeb(Readable.from(copies)) as unknown as ReadableStream<Uint8Array>;
				}
				let expected = '';
				for await (const text of stream().pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)) expected += text;
				expect(await helpers.streamToText(stream())).toBe(expected);
			})
		);
	});

	it('parseSSE ≡ the WHATWG algorithm run literally on the whole text, for text and UTF-8 bytes cut anywhere', async function () {
		await fc.assert(
			fc.asyncProperty(sseText, cuts, fc.boolean(), async function (text, points, asBytes) {
				const chunks: Array<string | Uint8Array> = asBytes ? cutAt(new TextEncoder().encode(text), points) : cutAt(text, points);
				expect(await helpers.toArrayAsync(helpers.parseSSE(chunks))).toEqual(referenceSSE(text));
			})
		);
	});

	it('parseSSE with maxDataLength ≡ the WHATWG algorithm stopping once a data buffer is too long, whatever the chunking', async function () {
		await fc.assert(
			fc.asyncProperty(sseText, cuts, fc.nat({ max: 6 }), async function (text, points, max) {
				const read: Array<helpers.ServerSentEvent | null> = [];
				try {
					for await (const event of helpers.parseSSE(cutAt(text, points), { maxDataLength: max })) read.push(event);
				} catch (error) {
					expect(error).toEqual(new RangeError(`parseSSE: the data of an event is longer than \`maxDataLength\` (${max})`));
					read.push(null);
				}
				expect(read).toEqual(referenceSSE(text, max));
			})
		);
	});

	it('parseSSE round-trips events written by a server, whatever the line endings and chunking', async function () {
		const message = fc.record({
			event: fc.constantFrom('', 'update', 'ping'),
			lines: fc.array(fc.string({ unit: fc.constantFrom('a', ':', ' ', 'é', '😀') }), { minLength: 1, maxLength: 3 }),
			id: fc.option(fc.constantFrom('1', 'abc', ''), { nil: undefined })
		});
		await fc.assert(
			fc.asyncProperty(fc.array(message, { maxLength: 6 }), fc.constantFrom('\n', '\r\n', '\r'), cuts, async function (messages, eol, points) {
				let text = '';
				let lastId = '';
				const expected: helpers.ServerSentEvent[] = [];
				for (const { event, lines, id } of messages) {
					if (event !== '') text += 'event: ' + event + eol;
					for (const line of lines) text += 'data: ' + line + eol;
					if (id !== undefined) {
						text += 'id: ' + id + eol;
						lastId = id;
					}
					text += eol;
					expected.push({ event: event === '' ? 'message' : event, data: lines.join('\n'), id: lastId });
				}
				expect(await helpers.toArrayAsync(helpers.parseSSE(cutAt(new TextEncoder().encode(text), points)))).toEqual(expected);
			})
		);
	});

	it('parseNdjson round-trips JSON values, skipping blank lines, whatever the line endings and chunking', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.jsonValue(), fc.constantFrom('\n', '\r\n'), fc.constantFrom('', ' ', '\t\r', '\r')), { maxLength: 8 }),
				fc.boolean(),
				cuts,
				async function (entries, finalBreak, points) {
					let text = '';
					entries.forEach(function ([value, eol, blank], index) {
						const more = index < entries.length - 1 || finalBreak;
						text += JSON.stringify(value) + (more ? eol : '');
						if (blank !== '' && more) text += blank + '\n';
					});
					const expected = entries.map(function ([value]) {
						return JSON.parse(JSON.stringify(value)) as unknown;
					});
					expect(await helpers.toArrayAsync(helpers.parseNdjson(cutAt(text, points)))).toEqual(expected);
				}
			)
		);
	});

	it('parseNdjson reports the 1-based line number of the first invalid line', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.constantFrom('1', '"a"', '', ' ', '{}', '[1]'), { maxLength: 8 }), fc.nat(), cuts, async function (lines, at, points) {
				const position = at % (lines.length + 1);
				const all = [...lines.slice(0, position), '{x', ...lines.slice(position)];
				await expect(helpers.toArrayAsync(helpers.parseNdjson(cutAt(all.join('\n'), points)))).rejects.toThrow(
					new RegExp('^parseNdjson: line ' + (position + 1) + ' is not valid JSON')
				);
			})
		);
	});
});

describe('combinators (properties)', function () {
	async function yieldTicks(n: number): Promise<void> {
		for (let i = 0; i < n; i++) await Promise.resolve();
	}

	function label(source: number, index: number): string {
		return source + ':' + index;
	}

	it('mergeAsync yields every value once, keeps the order of each source, and has one pull per source at most', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.array(fc.nat({ max: 6 }), { maxLength: 6 }), { maxLength: 5 }), fc.nat({ max: 3 }), async function (delays, consumerDelay) {
				let violations = 0;
				const sources = delays.map(function (list, source) {
					let active = 0;
					return (async function* () {
						for (let index = 0; index < list.length; index++) {
							active++;
							if (active > 1) violations++;
							await yieldTicks(list[index]);
							active--;
							yield label(source, index);
						}
					})();
				});
				const output: string[] = [];
				for await (const value of helpers.mergeAsync(...sources)) {
					output.push(value);
					await yieldTicks(consumerDelay);
				}
				expect(violations).toBe(0);
				delays.forEach(function (list, source) {
					const own = output.filter(function (value) {
						return value.startsWith(source + ':');
					});
					expect(own).toEqual(
						list.map(function (_, index) {
							return label(source, index);
						})
					);
				});
				const total = delays.reduce(function (sum, list) {
					return sum + list.length;
				}, 0);
				expect(output.length).toBe(total);
			})
		);
	});

	it('mergeAsync closes every unfinished source when the consumer stops early', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 5 }), fc.nat({ max: 10 }), async function (lengths, stopAfter) {
				const finished = lengths.map(function () {
					return false;
				});
				const sources = lengths.map(function (length, source) {
					return (async function* () {
						try {
							for (let index = 0; index < length; index++) {
								await yieldTicks(source);
								yield index;
							}
						} finally {
							finished[source] = true;
						}
					})();
				});
				let seen = 0;
				for await (const value of helpers.mergeAsync(...sources)) {
					expect(typeof value).toBe('number');
					if (++seen > stopAfter) break;
				}
				// Every source was started (pulled once at the start), so each one runs its `finally` once its pending pull settles.
				await yieldTicks(60);
				expect(
					finished.every(function (flag) {
						return flag;
					})
				).toBe(true);
			})
		);
	});

	it('bufferTime batches are the source cut into non-empty pieces of at most maxSize, each spanning at most `ms`', async function () {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.nat({ max: 30 }), { maxLength: 15 }),
				fc.integer({ min: 1, max: 40 }),
				fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(Infinity)),
				async function (gaps, ms, maxSize) {
					jest.useFakeTimers();
					try {
						const arrivals: number[] = [];
						const source = (async function* () {
							for (let index = 0; index < gaps.length; index++) {
								await new Promise(function (resolve) {
									setTimeout(resolve, gaps[index]);
								});
								arrivals.push(Date.now());
								yield index;
							}
						})();
						const batches: number[][] = [];
						let finished = false;
						const done = (async function () {
							for await (const batch of helpers.bufferTime(source, ms, { maxSize })) batches.push(batch);
							finished = true;
						})();
						while (!finished) await jest.advanceTimersByTimeAsync(1);
						await done;
						expect(batches.flat()).toEqual(
							gaps.map(function (_, index) {
								return index;
							})
						);
						batches.forEach(function (batch, position) {
							expect(batch.length).toBeGreaterThan(0);
							expect(batch.length).toBeLessThanOrEqual(maxSize);
							expect(arrivals[batch[batch.length - 1]] - arrivals[batch[0]]).toBeLessThanOrEqual(ms);
							// A batch flushed before it was full (and not the last one) had used up its window.
							const next = batches[position + 1];
							if (next !== undefined && batch.length < maxSize) expect(arrivals[next[0]] - arrivals[batch[0]]).toBeGreaterThanOrEqual(ms);
						});
						expect(jest.getTimerCount()).toBe(0);
					} finally {
						jest.useRealTimers();
					}
				}
			),
			{ numRuns: 40 }
		);
	});

	it('interleave ≡ a naive round-robin over arrays', function () {
		fc.assert(
			fc.property(fc.array(smallInts, { maxLength: 5 }), function (lists) {
				const expected: number[] = [];
				let longest = 0;
				for (const list of lists) longest = Math.max(longest, list.length);
				for (let index = 0; index < longest; index++) for (const list of lists) if (index < list.length) expected.push(list[index]);
				expect(helpers.toArray(helpers.interleave(...lists.map(once)))).toEqual(expected);
			})
		);
	});

	it('pairwise ≡ windowed(…, 2); partition ≡ arrays.partition', function () {
		fc.assert(
			fc.property(smallInts, function (xs) {
				expect(helpers.toArray(helpers.pairwise(once(xs)))).toEqual(helpers.toArray(helpers.windowed(xs, 2)));
				expect(helpers.partition(once(xs), isPositive)).toEqual(arrays.partition(xs, isPositive));
			})
		);
	});
});
