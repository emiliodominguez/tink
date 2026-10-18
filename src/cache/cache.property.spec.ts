import fc from 'fast-check';
import { memoize } from '../functions/index.js';
import { createLRUCache, createPriorityQueue, type LRUCache, type LRUEvictionReason } from '.';

type Key = number;
type Value = number;
type Event = [Key, Value, LRUEvictionReason];

interface Config {
	max: number;
	ttl: number | undefined;
	updateAgeOnGet: boolean;
}

interface ModelEntry {
	key: Key;
	value: Value;
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

function modelSet(model: Model, key: Key, value: Value, ttlOverride: number | undefined): void {
	const ttl = ttlOverride ?? model.config.ttl ?? Infinity;
	const index = model.entries.findIndex(function (e) {
		return e.key === key;
	});
	const previous = index === -1 ? undefined : model.entries.splice(index, 1)[0];
	model.entries.push({ key, value, ttl, expiresAt: model.time + ttl });
	if (previous !== undefined) {
		// The very same value stays stored, so nothing is reported, expired or not.
		if (previous.value !== value) model.events.push([key, previous.value, isExpired(model, previous) ? 'expired' : 'replaced']);
	} else if (model.entries.length > model.config.max) {
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
	ttl: ttlArb,
	updateAgeOnGet: fc.boolean()
});

describe('createLRUCache (properties)', function () {
	it('behaves like a naive recency-ordered array model (size, LRU order, expiry, onEvict)', function () {
		fc.assert(
			fc.property(configArb, fc.commands(commandArbs, { size: '+1' }), function (config, commands) {
				fc.modelRun(function () {
					const clock = { time: 0 };
					const events: Event[] = [];
					const cache = createLRUCache<Key, Value>({
						max: config.max,
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
