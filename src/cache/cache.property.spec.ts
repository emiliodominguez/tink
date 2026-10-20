import fc from 'fast-check';
import { memoize } from '../functions/index.js';
import {
	createBiMap,
	createBloomFilter,
	createDefaultMap,
	createDeque,
	createLRUCache,
	createMultiMap,
	createPriorityQueue,
	createRingBuffer,
	createTrie,
	type BiMap,
	type DefaultMap,
	type LRUCache,
	type LRUEvictionReason,
	type MultiMap,
	type RingBuffer,
	type Trie
} from '.';

type Key = number;
type Value = number;
type Event = [Key, Value, LRUEvictionReason];

interface Config {
	max: number;
	/** `Infinity`, or a bound on the total size. */
	maxSize: number;
	/** Whether `sizeOf` is given (each entry then weighs its value, 0 to 3), or each entry weighs 1. */
	sized: boolean;
	ttl: number | undefined;
	updateAgeOnGet: boolean;
}

interface ModelEntry {
	key: Key;
	value: Value;
	size: number;
	ttl: number;
	expiresAt: number;
}

/** Naive reference model: a plain array ordered from least- to most-recently used, plus a fake clock. */
interface Model {
	config: Config;
	time: number;
	entries: ModelEntry[];
	events: Event[];
}

interface Real {
	clock: { time: number };
	cache: LRUCache<Key, Value>;
	events: Event[];
}

function isExpired(model: Model, entry: ModelEntry): boolean {
	return model.time >= entry.expiresAt;
}

/** Finds `key` in the model, removing it (and recording 'expired') when it has expired. */
function modelLookup(model: Model, key: Key): ModelEntry | undefined {
	const index = model.entries.findIndex(function (e) {
		return e.key === key;
	});
	if (index === -1) return undefined;
	const entry = model.entries[index];
	if (isExpired(model, entry)) {
		model.entries.splice(index, 1);
		model.events.push([key, entry.value, 'expired']);
		return undefined;
	}
	return entry;
}

function modelGet(model: Model, key: Key): Value | undefined {
	const entry = modelLookup(model, key);
	if (entry === undefined) return undefined;
	model.entries.splice(model.entries.indexOf(entry), 1);
	model.entries.push(entry);
	if (model.config.updateAgeOnGet) entry.expiresAt = model.time + entry.ttl;
	return entry.value;
}

function modelTotal(model: Model): number {
	return model.entries.reduce(function (sum, e) {
		return sum + e.size;
	}, 0);
}

function modelSet(model: Model, key: Key, value: Value, ttlOverride: number | undefined): void {
	const ttl = ttlOverride ?? model.config.ttl ?? Infinity;
	const size = model.config.sized ? value : 1;
	const index = model.entries.findIndex(function (e) {
		return e.key === key;
	});
	const previous = index === -1 ? undefined : model.entries.splice(index, 1)[0];
	if (size > model.config.maxSize) {
		// Never stored, and the entry it would have replaced is gone.
		if (previous !== undefined) model.events.push([key, previous.value, isExpired(model, previous) ? 'expired' : 'oversized']);
		return;
	}
	model.entries.push({ key, value, size, ttl, expiresAt: model.time + ttl });
	// The very same value stays stored, so nothing is reported, expired or not.
	if (previous !== undefined && previous.value !== value) model.events.push([key, previous.value, isExpired(model, previous) ? 'expired' : 'replaced']);
	while (model.entries.length > model.config.max || modelTotal(model) > model.config.maxSize) {
		const oldest = model.entries.shift() as ModelEntry;
		model.events.push([oldest.key, oldest.value, isExpired(model, oldest) ? 'expired' : 'capacity']);
	}
}

function liveModelEntries(model: Model): Array<[Key, Value]> {
	return model.entries
		.filter(function (e) {
			return !isExpired(model, e);
		})
		.map(function (e): [Key, Value] {
			return [e.key, e.value];
		})
		.reverse();
}

/** Compares the whole observable state of the real cache with the model after every command. */
function checkInvariants(model: Model, real: Real): void {
	expect(real.cache.size).toBeLessThanOrEqual(model.config.max);
	expect(real.cache.size).toBe(model.entries.length);
	expect(real.cache.totalSize).toBe(modelTotal(model));
	expect(real.cache.totalSize).toBeLessThanOrEqual(model.config.maxSize);
	expect([...real.cache.entries()]).toEqual(liveModelEntries(model));
	expect(real.events).toEqual(model.events);
}

function command(label: string, apply: (model: Model, real: Real) => void): fc.Command<Model, Real> {
	return {
		check: function (): boolean {
			return true;
		},
		run: function (model: Model, real: Real): void {
			apply(model, real);
			checkInvariants(model, real);
		},
		toString: function (): string {
			return label;
		}
	};
}

const keyArb = fc.integer({ min: 0, max: 4 });
const valueArb = fc.integer({ min: 0, max: 3 });
const ttlArb = fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined });

const commandArbs = [
	fc.tuple(keyArb, valueArb, ttlArb).map(function ([key, value, ttl]) {
		return command(`set(${key}, ${value}, ttl=${String(ttl)})`, function (model, real) {
			modelSet(model, key, value, ttl);
			expect(real.cache.set(key, value, ttl === undefined ? undefined : { ttl })).toBe(real.cache);
		});
	}),
	fc.tuple(keyArb, valueArb, ttlArb).map(function ([key, value, ttl]) {
		return command(`getOrSet(${key}, ${value}, ttl=${String(ttl)})`, function (model, real) {
			const live = modelLookup(model, key) !== undefined;
			let expected = value;
			if (live) expected = modelGet(model, key) as Value;
			else modelSet(model, key, value, ttl);
			let calls = 0;
			const result = real.cache.getOrSet(
				key,
				function (received) {
					calls++;
					expect(received).toBe(key);
					return value;
				},
				ttl === undefined ? undefined : { ttl }
			);
			expect(result).toBe(expected);
			expect(calls).toBe(live ? 0 : 1);
		});
	}),
	keyArb.map(function (key) {
		return command(`get(${key})`, function (model, real) {
			expect(real.cache.get(key)).toBe(modelGet(model, key));
		});
	}),
	keyArb.map(function (key) {
		return command(`peek(${key})`, function (model, real) {
			expect(real.cache.peek(key)).toBe(modelLookup(model, key)?.value);
		});
	}),
	keyArb.map(function (key) {
		return command(`has(${key})`, function (model, real) {
			expect(real.cache.has(key)).toBe(modelLookup(model, key) !== undefined);
		});
	}),
	keyArb.map(function (key) {
		return command(`getRemainingTTL(${key})`, function (model, real) {
			const entry = modelLookup(model, key);
			expect(real.cache.getRemainingTTL(key)).toBe(entry === undefined ? undefined : entry.expiresAt - model.time);
		});
	}),
	keyArb.map(function (key) {
		return command(`delete(${key})`, function (model, real) {
			const entry = modelLookup(model, key);
			if (entry !== undefined) {
				model.entries.splice(model.entries.indexOf(entry), 1);
				model.events.push([key, entry.value, 'deleted']);
			}
			expect(real.cache.delete(key)).toBe(entry !== undefined);
		});
	}),
	fc.integer({ min: 0, max: 10 }).map(function (ms) {
		return command(`advance(${ms})`, function (model, real) {
			model.time += ms;
			real.clock.time += ms;
		});
	}),
	fc.constant(
		command('prune()', function (model, real) {
			const expired = model.entries.filter(function (e) {
				return isExpired(model, e);
			});
			model.entries = model.entries.filter(function (e) {
				return !isExpired(model, e);
			});
			for (const e of expired) model.events.push([e.key, e.value, 'expired']);
			expect(real.cache.prune()).toBe(expired.length);
		})
	),
	fc.constant(
		command('clear()', function (model, real) {
			for (const e of model.entries) model.events.push([e.key, e.value, isExpired(model, e) ? 'expired' : 'cleared']);
			model.entries = [];
			real.cache.clear();
		})
	)
];

const configArb: fc.Arbitrary<Config> = fc.record({
	max: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.constant(Infinity)),
	maxSize: fc.oneof(fc.constant(Infinity), fc.integer({ min: 1, max: 6 })),
	sized: fc.boolean(),
	ttl: ttlArb,
	updateAgeOnGet: fc.boolean()
});

describe('createLRUCache (properties)', function () {
	it('behaves like a naive recency-ordered array model (size, size budget, LRU order, expiry, onEvict)', function () {
		fc.assert(
			fc.property(configArb, fc.commands(commandArbs, { size: '+1' }), function (config, commands) {
				fc.modelRun(function () {
					const clock = { time: 0 };
					const events: Event[] = [];
					const cache = createLRUCache<Key, Value>({
						max: config.max,
						maxSize: config.maxSize,
						sizeOf: config.sized
							? function (value: Value, key: Key): number {
									expect(typeof key).toBe('number');
									return value;
								}
							: undefined,
						ttl: config.ttl,
						updateAgeOnGet: config.updateAgeOnGet,
						now: function (): number {
							return clock.time;
						},
						onEvict: function (key: Key, value: Value, reason: LRUEvictionReason): void {
							events.push([key, value, reason]);
						}
					});
					return { model: { config, time: 0, entries: [], events: [] }, real: { clock, cache, events } };
				}, commands);
			}),
			{ numRuns: 300 }
		);
	});

	it('without gets or expiry, keeps exactly the last `max` distinct keys, most recently set first', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 8 }), fc.array(keyArb, { maxLength: 40 }), function (max, keys) {
				const cache = createLRUCache<Key, Value>({ max });
				for (const key of keys) cache.set(key, key);

				const expected: Key[] = [];
				for (let i = keys.length - 1; i >= 0 && expected.length < max; i--) {
					if (!expected.includes(keys[i])) expected.push(keys[i]);
				}
				expect([...cache.keys()]).toEqual(expected);
				expect(cache.size).toBe(expected.length);
			})
		);
	});

	it('get right after set returns the value while it has not expired', function () {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				fc.array(fc.tuple(keyArb, valueArb), { maxLength: 30 }),
				fc.integer({ min: 1, max: 100 }),
				fc.integer({ min: 0, max: 200 }),
				function (max, pairs, ttl, elapsed) {
					let time = 0;
					const cache = createLRUCache<Key, Value>({
						max,
						ttl,
						now: function (): number {
							return time;
						}
					});
					for (const [key, value] of pairs) {
						cache.set(key, value);
						time += elapsed;
						expect(cache.get(key)).toBe(elapsed < ttl ? value : undefined);
					}
				}
			)
		);
	});

	it('a memoized function backed by an LRU cache always returns the same results as the original', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 4 }), fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 40 }), function (max, inputs) {
				let calls = 0;
				function cube(n: number): number {
					calls++;
					return n ** 3;
				}
				const memo = memoize(cube, { cache: createLRUCache({ max }) });
				for (const n of inputs) expect(memo(n)).toBe(n ** 3);
				expect(memo.cache.size).toBeLessThanOrEqual(max);
				expect(calls).toBeLessThanOrEqual(inputs.length);
				if (new Set(inputs).size <= max) expect(calls).toBe(new Set(inputs).size);
			})
		);
	});
});

describe('createPriorityQueue (properties)', function () {
	type Item = { priority: number; id: number };

	function byPriority(a: Item, b: Item): number {
		return a.priority - b.priority;
	}

	it('pops exactly like a stable sort of the pushed values, under any interleaving of push/pop/delete', function () {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.record({ op: fc.constant('push' as const), priority: fc.integer({ min: 0, max: 4 }) }),
						fc.record({ op: fc.constantFrom('pop' as const, 'delete' as const), at: fc.nat() })
					),
					{
						maxLength: 80
					}
				),
				function (ops) {
					const queue = createPriorityQueue(byPriority);
					// Reference model: the queued items in insertion order; the next one out is the first with the smallest priority.
					let model: Item[] = [];
					let id = 0;
					for (const step of ops) {
						if (step.op === 'push') {
							const item = { priority: step.priority, id: id++ };
							model.push(item);
							expect(queue.push(item)).toBe(model.length);
						} else if (step.op === 'pop') {
							const expected = model.slice().sort(byPriority)[0];
							model = model.filter(function (item) {
								return item !== expected;
							});
							expect(queue.pop()).toBe(expected);
						} else if (model.length > 0) {
							const victim = model[step.at % model.length];
							model = model.filter(function (item) {
								return item !== victim;
							});
							expect(queue.delete(victim)).toBe(true);
						}
						expect(queue.size).toBe(model.length);
						expect(queue.peek()).toBe(model.slice().sort(byPriority)[0]);
						expect([...queue]).toEqual(model.slice().sort(byPriority));
					}
				}
			)
		);
	});
});

describe('createDeque (properties)', function () {
	type DequeOp =
		| { op: 'pushBack' | 'pushFront'; value: number }
		| { op: 'popBack' | 'popFront' | 'peekBack' | 'peekFront' | 'clear' | 'iterate' }
		| { op: 'at'; index: number };

	const dequeOpArb: fc.Arbitrary<DequeOp> = fc.oneof(
		{ arbitrary: fc.record({ op: fc.constantFrom('pushBack' as const, 'pushFront' as const), value: fc.integer() }), weight: 6 },
		{ arbitrary: fc.record({ op: fc.constantFrom('popBack' as const, 'popFront' as const) }), weight: 4 },
		{ arbitrary: fc.record({ op: fc.constantFrom('peekBack' as const, 'peekFront' as const, 'iterate' as const) }), weight: 2 },
		{ arbitrary: fc.record({ op: fc.constant('clear' as const) }), weight: 1 },
		{ arbitrary: fc.record({ op: fc.constant('at' as const), index: fc.integer({ min: -40, max: 40 }) }), weight: 2 }
	);

	it('behaves like an array model under any sequence of operations, bounded or not', function () {
		fc.assert(
			fc.property(
				fc.array(fc.integer(), { maxLength: 20 }),
				fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
				fc.array(dequeOpArb, { maxLength: 300 }),
				function (initial, capacity, ops) {
					const deque = createDeque(initial, capacity === undefined ? {} : { capacity });
					const limit = capacity ?? Infinity;
					// Reference model: an array from front to back, trimmed like the deque.
					let model = initial.slice(Math.max(0, initial.length - limit));
					expect([...deque]).toEqual(model);
					for (const step of ops) {
						switch (step.op) {
							case 'pushBack':
								model.push(step.value);
								if (model.length > limit) model.shift();
								expect(deque.pushBack(step.value)).toBe(model.length);
								break;
							case 'pushFront':
								model.unshift(step.value);
								if (model.length > limit) model.pop();
								expect(deque.pushFront(step.value)).toBe(model.length);
								break;
							case 'popBack':
								expect(deque.popBack()).toBe(model.pop());
								break;
							case 'popFront':
								expect(deque.popFront()).toBe(model.shift());
								break;
							case 'peekBack':
								expect(deque.peekBack()).toBe(model[model.length - 1]);
								break;
							case 'peekFront':
								expect(deque.peekFront()).toBe(model[0]);
								break;
							case 'clear':
								model = [];
								deque.clear();
								break;
							case 'at':
								expect(deque.at(step.index)).toBe(model.at(step.index));
								break;
							default:
								expect([...deque]).toEqual(model);
						}
						expect(deque.size).toBe(model.length);
						expect(deque.size).toBeLessThanOrEqual(limit);
					}
					expect([...deque]).toEqual(model);
				}
			)
		);
	});
});

/** SameValueZero, the equality of `Map` keys and `Set` values. */
function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (a !== a && b !== b);
}

/** A `-0` becomes `0`, as `Map` stores keys. */
function normalizeZero<T>(value: T): T {
	return (Object.is(value, -0) ? 0 : value) as T;
}

/** Builds a model-based-testing command that checks the whole observable state after running. */
function modelCommand<M extends object, R>(label: string, apply: (model: M, real: R) => void, check: (model: M, real: R) => void): fc.Command<M, R> {
	return {
		check: function (): boolean {
			return true;
		},
		run: function (model: M, real: R): void {
			apply(model, real);
			check(model, real);
		},
		toString: function (): string {
			return label;
		}
	};
}

describe('createRingBuffer (properties)', function () {
	interface RingModel {
		capacity: number;
		values: number[];
		evicted: number[];
	}
	interface RingReal {
		buffer: RingBuffer<number>;
		evicted: number[];
	}

	function check(model: RingModel, real: RingReal): void {
		expect(real.buffer.toArray()).toEqual(model.values);
		expect([...real.buffer]).toEqual(model.values);
		expect(real.buffer.size).toBe(model.values.length);
		expect(real.buffer.full).toBe(model.values.length === model.capacity);
		expect(real.buffer.peekFirst()).toBe(model.values[0]);
		expect(real.buffer.peekLast()).toBe(model.values[model.values.length - 1]);
		expect(real.evicted).toEqual(model.evicted);
	}

	const commands = [
		fc.integer().map(function (value) {
			return modelCommand<RingModel, RingReal>(
				`push(${value})`,
				function (model, real) {
					model.values.push(value);
					if (model.values.length > model.capacity) model.evicted.push(model.values.shift() as number);
					expect(real.buffer.push(value)).toBe(model.values.length);
				},
				check
			);
		}),
		fc.constant(
			modelCommand<RingModel, RingReal>(
				'shift()',
				function (model, real) {
					expect(real.buffer.shift()).toBe(model.values.shift());
				},
				check
			)
		),
		fc.integer({ min: -12, max: 12 }).map(function (index) {
			return modelCommand<RingModel, RingReal>(
				`at(${index})`,
				function (model, real) {
					expect(real.buffer.at(index)).toBe(model.values.at(index));
				},
				check
			);
		}),
		fc.constant(
			modelCommand<RingModel, RingReal>(
				'clear()',
				function (model, real) {
					model.values = [];
					real.buffer.clear();
				},
				check
			)
		)
	];

	it('behaves like an array trimmed to the capacity from the front, reporting every overwritten value', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 8 }), fc.commands(commands, { size: '+1' }), function (capacity, cmds) {
				fc.modelRun(function () {
					const evicted: number[] = [];
					const buffer = createRingBuffer<number>(capacity, {
						onEvict: function (value) {
							evicted.push(value);
						}
					});
					return { model: { capacity, values: [], evicted: [] }, real: { buffer, evicted } };
				}, cmds);
			}),
			{ numRuns: 300 }
		);
	});

	it('holds the last `capacity` pushed values, like a deque with the same capacity', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 20 }), fc.array(fc.integer(), { maxLength: 80 }), function (capacity, values) {
				const buffer = createRingBuffer<number>(capacity);
				const deque = createDeque<number>(null, { capacity });
				for (const value of values) {
					buffer.push(value);
					deque.pushBack(value);
				}
				expect(buffer.toArray()).toEqual(values.slice(Math.max(0, values.length - capacity)));
				expect(buffer.toArray()).toEqual([...deque]);
			})
		);
	});
});

describe('createDefaultMap (properties)', function () {
	interface DefaultModel {
		map: Map<number, string>;
		calls: number[];
	}
	interface DefaultReal {
		map: DefaultMap<number, string>;
		calls: number[];
	}

	function check(model: DefaultModel, real: DefaultReal): void {
		expect([...real.map]).toEqual([...model.map]);
		expect([...real.map.keys()]).toEqual([...model.map.keys()]);
		expect([...real.map.values()]).toEqual([...model.map.values()]);
		expect(real.map.size).toBe(model.map.size);
		expect(real.calls).toEqual(model.calls);
	}

	const defaultKeyArb = fc.constantFrom(0, -0, 1, 2, 3, NaN);
	const commands = [
		defaultKeyArb.map(function (key) {
			return modelCommand<DefaultModel, DefaultReal>(
				`get(${key})`,
				function (model, real) {
					if (!model.map.has(key)) {
						// The factory gets the key as the map stores it.
						model.calls.push(normalizeZero(key));
						model.map.set(key, `made ${key}`);
					}
					expect(real.map.get(key)).toBe(model.map.get(key));
				},
				check
			);
		}),
		defaultKeyArb.map(function (key) {
			return modelCommand<DefaultModel, DefaultReal>(
				`peek/has(${key})`,
				function (model, real) {
					expect(real.map.peek(key)).toBe(model.map.get(key));
					expect(real.map.has(key)).toBe(model.map.has(key));
				},
				check
			);
		}),
		fc.tuple(defaultKeyArb, fc.option(fc.string({ maxLength: 2 }), { nil: undefined })).map(function ([key, value]) {
			return modelCommand<DefaultModel, DefaultReal>(
				`set(${key}, ${JSON.stringify(value)})`,
				function (model, real) {
					model.map.set(key, value as string);
					expect(real.map.set(key, value as string)).toBe(real.map);
				},
				check
			);
		}),
		defaultKeyArb.map(function (key) {
			return modelCommand<DefaultModel, DefaultReal>(
				`delete(${key})`,
				function (model, real) {
					expect(real.map.delete(key)).toBe(model.map.delete(key));
				},
				check
			);
		}),
		fc.constant(
			modelCommand<DefaultModel, DefaultReal>(
				'clear()',
				function (model, real) {
					model.map.clear();
					real.map.clear();
				},
				check
			)
		)
	];

	it('behaves like a Map that calls the factory exactly on the misses of `get` (a stored undefined is a hit)', function () {
		fc.assert(
			fc.property(fc.commands(commands, { size: '+1' }), function (cmds) {
				fc.modelRun(function () {
					const calls: number[] = [];
					const map = createDefaultMap<number, string>(function (key) {
						calls.push(key);
						return `made ${key}`;
					});
					return { model: { map: new Map(), calls: [] }, real: { map, calls } };
				}, cmds);
			}),
			{ numRuns: 300 }
		);
	});
});

describe('createBiMap (properties)', function () {
	type Side = number;
	/** Naive model: the pairs in the order of each direction, as arrays scanned linearly. */
	interface BiModel {
		forward: Array<[Side, Side]>;
		backward: Array<[Side, Side]>;
	}
	interface BiReal {
		map: BiMap<Side, Side>;
	}

	/** `set(key, value)` on a naive ordered list of pairs: the pair of `value` leaves, the pair of `key` changes in place (or is appended). */
	function pairsSet(pairs: Array<[Side, Side]>, key: Side, value: Side): Array<[Side, Side]> {
		const result = pairs.filter(function ([k, v]) {
			return sameValueZero(k, key) || !sameValueZero(v, value);
		});
		const index = result.findIndex(function ([k]) {
			return sameValueZero(k, key);
		});
		if (index >= 0) result[index] = [result[index][0], normalizeZero(value)];
		else result.push([normalizeZero(key), normalizeZero(value)]);
		return result;
	}

	/** Removes the pair of `key` from both lists of a model. */
	function modelDelete(model: BiModel, key: Side): boolean {
		const index = model.forward.findIndex(function ([k]) {
			return sameValueZero(k, key);
		});
		if (index < 0) return false;
		const [, value] = model.forward[index];
		model.forward.splice(index, 1);
		model.backward = model.backward.filter(function ([v]) {
			return !sameValueZero(v, value);
		});
		return true;
	}

	function check(model: BiModel, real: BiReal): void {
		expect([...real.map]).toEqual(model.forward);
		expect([...real.map.keys()]).toEqual(
			model.forward.map(function ([k]) {
				return k;
			})
		);
		expect([...real.map.values()]).toEqual(
			model.forward.map(function ([, v]) {
				return v;
			})
		);
		expect([...real.map.inverse.entries()]).toEqual(model.backward);
		expect(real.map.size).toBe(model.forward.length);
		expect(real.map.inverse.size).toBe(model.forward.length);
		// A bijection: every pair reads the same in both directions.
		for (const [key, value] of model.forward) {
			expect(real.map.get(key)).toBe(value);
			expect(real.map.getKey(value)).toBe(key);
			expect(real.map.has(key) && real.map.hasValue(value)).toBe(true);
		}
		expect(new Set(model.backward.map(String))).toEqual(
			new Set(
				model.forward.map(function ([k, v]) {
					return String([v, k]);
				})
			)
		);
	}

	const sideArb = fc.constantFrom(0, -0, 1, 2, 3, NaN);
	const commands = [
		fc.tuple(sideArb, sideArb, fc.boolean()).map(function ([key, value, inverse]) {
			return modelCommand<BiModel, BiReal>(
				inverse ? `inverse.set(${value}, ${key})` : `set(${key}, ${value})`,
				function (model, real) {
					model.forward = pairsSet(model.forward, key, value);
					model.backward = pairsSet(model.backward, value, key);
					if (inverse) expect(real.map.inverse.set(value, key)).toBe(real.map.inverse);
					else expect(real.map.set(key, value)).toBe(real.map);
				},
				check
			);
		}),
		fc.tuple(sideArb, fc.boolean()).map(function ([side, byValue]) {
			return modelCommand<BiModel, BiReal>(
				byValue ? `deleteValue(${side})` : `delete(${side})`,
				function (model, real) {
					if (byValue) {
						const flipped: BiModel = { forward: model.backward, backward: model.forward };
						const expected = modelDelete(flipped, side);
						model.forward = flipped.backward;
						model.backward = flipped.forward;
						expect(real.map.deleteValue(side)).toBe(expected);
					} else expect(real.map.delete(side)).toBe(modelDelete(model, side));
				},
				check
			);
		}),
		sideArb.map(function (side) {
			return modelCommand<BiModel, BiReal>(
				`lookups(${side})`,
				function (model, real) {
					const pair = model.forward.find(function ([k]) {
						return sameValueZero(k, side);
					});
					const inverse = model.backward.find(function ([v]) {
						return sameValueZero(v, side);
					});
					expect(real.map.get(side)).toBe(pair?.[1]);
					expect(real.map.has(side)).toBe(pair !== undefined);
					expect(real.map.getKey(side)).toBe(inverse?.[1]);
					expect(real.map.hasValue(side)).toBe(inverse !== undefined);
					expect(real.map.inverse.get(side)).toBe(inverse?.[1]);
					expect(real.map.inverse.getKey(side)).toBe(pair?.[1]);
				},
				check
			);
		}),
		fc.constant(
			modelCommand<BiModel, BiReal>(
				'clear()',
				function (model, real) {
					model.forward = [];
					model.backward = [];
					real.map.inverse.clear();
				},
				check
			)
		)
	];

	it('stays a bijection that matches naive ordered pair lists in both directions', function () {
		fc.assert(
			fc.property(fc.commands(commands, { size: '+1' }), function (cmds) {
				fc.modelRun(function () {
					return { model: { forward: [], backward: [] }, real: { map: createBiMap<Side, Side>() } };
				}, cmds);
			}),
			{ numRuns: 300 }
		);
	});

	it('built from pairs, equals the pairs set one by one', function () {
		fc.assert(
			fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 })), { maxLength: 20 }), function (pairs) {
				const built = createBiMap(pairs);
				const stepwise = createBiMap<number, number>();
				for (const [key, value] of pairs) stepwise.set(key, value);
				expect([...built]).toEqual([...stepwise]);
				expect([...built.inverse]).toEqual([...stepwise.inverse]);
				expect(new Set(built.values()).size).toBe(built.size);
			})
		);
	});
});

describe('createMultiMap (properties)', function () {
	/** Naive model: groups in key order, as an array of `[key, values]` scanned linearly. */
	interface MultiModel {
		unique: boolean;
		groups: Array<[number, number[]]>;
	}
	interface MultiReal {
		map: MultiMap<number, number>;
	}

	function groupOf(model: MultiModel, key: number): [number, number[]] | undefined {
		return model.groups.find(function ([k]) {
			return sameValueZero(k, key);
		});
	}

	function holds(values: number[], value: number): boolean {
		return values.some(function (v) {
			return sameValueZero(v, value);
		});
	}

	function check(model: MultiModel, real: MultiReal): void {
		const pairs: Array<[number, number]> = [];
		for (const [key, values] of model.groups) for (const value of values) pairs.push([key, value]);
		expect([...real.map]).toEqual(pairs);
		expect([...real.map.entries()]).toEqual(pairs);
		expect([...real.map.values()]).toEqual(
			pairs.map(function ([, v]) {
				return v;
			})
		);
		expect([...real.map.keys()]).toEqual(
			model.groups.map(function ([k]) {
				return k;
			})
		);
		expect(real.map.size).toBe(pairs.length);
		expect(real.map.keyCount).toBe(model.groups.length);
		for (const [key, values] of model.groups) {
			expect(real.map.get(key)).toEqual(values);
			expect(real.map.count(key)).toBe(values.length);
		}
	}

	const groupKeyArb = fc.constantFrom(0, -0, 1, 2, NaN);
	const groupValueArb = fc.constantFrom(0, -0, 1, 2, NaN);
	const commands = [
		fc.tuple(groupKeyArb, groupValueArb).map(function ([key, value]) {
			return modelCommand<MultiModel, MultiReal>(
				`add(${key}, ${value})`,
				function (model, real) {
					const group = groupOf(model, key);
					// `Set` stores -0 as 0; a list keeps the value as given.
					const stored = model.unique ? normalizeZero(value) : value;
					let added = true;
					if (group === undefined) model.groups.push([normalizeZero(key), [stored]]);
					else if (model.unique && holds(group[1], value)) added = false;
					else group[1].push(stored);
					expect(real.map.add(key, value)).toBe(added);
				},
				check
			);
		}),
		fc.tuple(groupKeyArb, fc.option(groupValueArb, { nil: undefined })).map(function ([key, value]) {
			return modelCommand<MultiModel, MultiReal>(
				value === undefined ? `delete(${key})` : `delete(${key}, ${value})`,
				function (model, real) {
					const group = groupOf(model, key);
					let removed = false;
					if (group !== undefined) {
						if (value === undefined) removed = true;
						else {
							const index = group[1].findIndex(function (v) {
								return sameValueZero(v, value);
							});
							if (index >= 0) {
								group[1].splice(index, 1);
								removed = true;
							}
						}
						if (value === undefined || group[1].length === 0) model.groups.splice(model.groups.indexOf(group), 1);
					}
					expect(value === undefined ? real.map.delete(key) : real.map.delete(key, value)).toBe(removed);
				},
				check
			);
		}),
		fc.tuple(groupKeyArb, groupValueArb).map(function ([key, value]) {
			return modelCommand<MultiModel, MultiReal>(
				`has(${key}, ${value})`,
				function (model, real) {
					const group = groupOf(model, key);
					expect(real.map.has(key)).toBe(group !== undefined);
					expect(real.map.has(key, value)).toBe(group !== undefined && holds(group[1], value));
					expect(real.map.get(key)).toEqual(group === undefined ? [] : group[1]);
					expect(real.map.count(key)).toBe(group === undefined ? 0 : group[1].length);
				},
				check
			);
		}),
		fc.constant(
			modelCommand<MultiModel, MultiReal>(
				'clear()',
				function (model, real) {
					model.groups = [];
					real.map.clear();
				},
				check
			)
		)
	];

	it('matches a naive list of groups, with lists or sets of values', function () {
		fc.assert(
			fc.property(fc.boolean(), fc.commands(commands, { size: '+1' }), function (unique, cmds) {
				fc.modelRun(function () {
					return { model: { unique, groups: [] }, real: { map: createMultiMap<number, number>(null, { unique }) } };
				}, cmds);
			}),
			{ numRuns: 300 }
		);
	});
});

describe('createTrie (properties)', function () {
	interface TrieModel {
		map: Map<string, number | undefined>;
	}
	interface TrieReal {
		trie: Trie<number | undefined>;
	}

	/** Every model key starting with `prefix`, in code-unit order. */
	function withPrefix(model: TrieModel, prefix: string): string[] {
		return [...model.map.keys()]
			.filter(function (key) {
				return key.startsWith(prefix);
			})
			.sort();
	}

	function check(model: TrieModel, real: TrieReal): void {
		const keys = [...model.map.keys()].sort();
		expect([...real.trie.keys()]).toEqual(keys);
		expect([...real.trie]).toEqual(
			keys.map(function (key) {
				return [key, model.map.get(key)];
			})
		);
		expect([...real.trie.values()]).toEqual(
			keys.map(function (key) {
				return model.map.get(key);
			})
		);
		expect(real.trie.size).toBe(model.map.size);
	}

	// A small alphabet makes keys share prefixes (splits and merges); a surrogate pair and its halves split code points.
	const unit = fc.constantFrom('a', 'b', 'c', '\u{1F600}', '\uD83D', '\uDE00', '_');
	const trieKeyArb = fc.oneof({ arbitrary: fc.string({ unit, maxLength: 6 }), weight: 5 }, { arbitrary: fc.constantFrom('__proto__', 'constructor', ''), weight: 1 });
	const textArb = fc.oneof(fc.string({ unit, maxLength: 9 }), fc.constantFrom('__proto__x', 'constructor'));
	const commands = [
		fc.tuple(trieKeyArb, fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined, freq: 8 })).map(function ([key, value]) {
			return modelCommand<TrieModel, TrieReal>(
				`set(${JSON.stringify(key)}, ${value})`,
				function (model, real) {
					model.map.set(key, value);
					expect(real.trie.set(key, value)).toBe(real.trie);
				},
				check
			);
		}),
		trieKeyArb.map(function (key) {
			return modelCommand<TrieModel, TrieReal>(
				`delete(${JSON.stringify(key)})`,
				function (model, real) {
					expect(real.trie.delete(key)).toBe(model.map.delete(key));
				},
				check
			);
		}),
		fc.tuple(textArb, fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined })).map(function ([text, limit]) {
			return modelCommand<TrieModel, TrieReal>(
				`queries(${JSON.stringify(text)}, limit=${String(limit)})`,
				function (model, real) {
					const matching = withPrefix(model, text);
					const limited = matching.slice(0, limit ?? Infinity);
					const options = limit === undefined ? undefined : { limit };
					expect(real.trie.get(text)).toBe(model.map.get(text));
					expect(real.trie.has(text)).toBe(model.map.has(text));
					expect(real.trie.hasPrefix(text)).toBe(matching.length > 0);
					expect(real.trie.keysWithPrefix(text, options)).toEqual(limited);
					expect(real.trie.entriesWithPrefix(text, options)).toEqual(
						limited.map(function (key) {
							return [key, model.map.get(key)];
						})
					);
					const longest = [...model.map.keys()]
						.filter(function (key) {
							return text.startsWith(key);
						})
						.reduce<string | undefined>(function (best, key) {
							return best === undefined || key.length > best.length ? key : best;
						}, undefined);
					expect(real.trie.longestPrefixOf(text)).toBe(longest);
				},
				check
			);
		}),
		fc.constant(
			modelCommand<TrieModel, TrieReal>(
				'clear()',
				function (model, real) {
					model.map.clear();
					real.trie.clear();
				},
				check
			)
		)
	];

	it('behaves like a Map with sorted, filtered keys, under any sequence of sets, deletes and queries', function () {
		fc.assert(
			fc.property(fc.commands(commands, { size: '+1' }), function (cmds) {
				fc.modelRun(function () {
					return { model: { map: new Map() }, real: { trie: createTrie<number | undefined>() } };
				}, cmds);
			}),
			{ numRuns: 300 }
		);
	});

	it('lists any strings in the order of Array.prototype.sort, and every prefix query is a filter of it', function () {
		fc.assert(
			fc.property(fc.array(fc.string({ unit: 'binary', maxLength: 8 }), { maxLength: 40 }), fc.string({ unit: 'binary', maxLength: 3 }), function (keys, prefix) {
				const trie = createTrie(
					keys.map(function (key, index): [string, number] {
						return [key, index];
					})
				);
				const sorted = [...new Set(keys)].sort();
				expect([...trie.keys()]).toEqual(sorted);
				expect(trie.keysWithPrefix(prefix)).toEqual(
					sorted.filter(function (key) {
						return key.startsWith(prefix);
					})
				);
			})
		);
	});

	it('deleting keys gives the same trie as never inserting them', function () {
		fc.assert(
			fc.property(fc.uniqueArray(fc.string({ unit, maxLength: 6 }), { maxLength: 30 }), fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }), function (keys, drop) {
				const shrunk = createTrie<number>();
				const fresh = createTrie<number>();
				keys.forEach(function (key, index) {
					shrunk.set(key, index);
					if (!drop[index]) fresh.set(key, index);
				});
				keys.forEach(function (key, index) {
					if (drop[index]) expect(shrunk.delete(key)).toBe(true);
				});
				expect([...shrunk]).toEqual([...fresh]);
				for (const key of keys) {
					for (let end = 0; end <= key.length; end++) {
						const prefix = key.slice(0, end);
						expect(shrunk.hasPrefix(prefix)).toBe(fresh.hasPrefix(prefix));
						expect(shrunk.keysWithPrefix(prefix)).toEqual(fresh.keysWithPrefix(prefix));
						expect(shrunk.longestPrefixOf(key + 'z')).toBe(fresh.longestPrefixOf(key + 'z'));
					}
				}
			})
		);
	});
});

describe('createBloomFilter (properties)', function () {
	const geometryArb = fc.oneof(
		fc.record({ expectedItems: fc.integer({ min: 1, max: 200 }), falsePositiveRate: fc.double({ min: 1e-6, max: 0.5, noNaN: true }) }),
		fc.record({ bits: fc.integer({ min: 1, max: 300 }), hashes: fc.integer({ min: 1, max: 12 }) })
	);

	it('never gives a false negative, and `add` is true exactly when `has` was false before it', function () {
		fc.assert(
			fc.property(
				geometryArb,
				fc.array(fc.oneof(fc.string({ unit: 'binary', maxLength: 12 }), fc.string({ maxLength: 4 })), { maxLength: 120 }),
				function (options, items) {
					const filter = createBloomFilter(options);
					for (const item of items) {
						const before = filter.has(item);
						expect(filter.add(item)).toBe(!before);
						expect(filter.has(item)).toBe(true);
					}
					for (const item of items) expect(filter.has(item)).toBe(true);
					const rate = filter.estimatedFalsePositiveRate();
					expect(rate >= 0 && rate <= 1).toBe(true);
					expect(filter.estimatedSize()).toBeGreaterThanOrEqual(0);
				}
			)
		);
	});

	it('round-trips through toBytes: the restored filter answers and estimates the same', function () {
		fc.assert(
			fc.property(
				geometryArb,
				fc.array(fc.string({ maxLength: 6 }), { maxLength: 60 }),
				fc.array(fc.string({ maxLength: 6 }), { maxLength: 30 }),
				function (options, items, probes) {
					const filter = createBloomFilter(options);
					for (const item of items) filter.add(item);
					const restored = createBloomFilter({ bits: filter.bits, hashes: filter.hashes, data: filter.toBytes() });
					expect(restored.toBytes()).toEqual(filter.toBytes());
					expect(restored.estimatedSize()).toBe(filter.estimatedSize());
					expect(restored.estimatedFalsePositiveRate()).toBe(filter.estimatedFalsePositiveRate());
					for (const probe of [...items, ...probes]) expect(restored.has(probe)).toBe(filter.has(probe));
				}
			)
		);
	});

	it('reaches the target false-positive rate (within sampling error) once filled with `expectedItems` items', function () {
		fc.assert(
			fc.property(fc.constantFrom(0.1, 0.05, 0.01), fc.string({ maxLength: 4 }), function (rate, salt) {
				const expectedItems = 3000;
				const filter = createBloomFilter({ expectedItems, falsePositiveRate: rate });
				for (let i = 0; i < expectedItems; i++) filter.add(`${salt}in:${i}`);
				const queries = 30_000;
				let positives = 0;
				for (let i = 0; i < queries; i++) if (filter.has(`${salt}out:${i}`)) positives++;
				// Binomial sampling error: 6 standard deviations around the target (the rounding of the formulas only lowers the rate).
				const sigma = Math.sqrt(queries * rate * (1 - rate));
				expect(positives).toBeLessThan(queries * rate + 6 * sigma);
				expect(positives).toBeGreaterThan(queries * rate * 0.8 - 6 * sigma);
				expect(Math.abs(filter.estimatedFalsePositiveRate() - rate) / rate).toBeLessThan(0.2);
				expect(Math.abs(filter.estimatedSize() - expectedItems) / expectedItems).toBeLessThan(0.05);
			}),
			{ numRuns: 8 }
		);
	});
});
