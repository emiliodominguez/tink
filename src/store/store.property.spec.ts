import fc from 'fast-check';
import { batch, computed, createHistory, createMachine, createStore, persistStore } from '.';

type Op = { kind: 'set'; value: number } | { kind: 'add'; value: number } | { kind: 'reset' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc.record({ kind: fc.constant('set' as const), value: fc.integer({ min: -20, max: 20 }) }),
	fc.record({ kind: fc.constant('add' as const), value: fc.integer({ min: -3, max: 3 }) }),
	fc.record({ kind: fc.constant('reset' as const) })
);

const equalsArb = fc.constantFrom<{ name: string; fn: (a: number, b: number) => boolean }>(
	{ name: 'Object.is', fn: Object.is },
	{
		name: 'same mod 4',
		fn: function (a, b) {
			return ((a % 4) + 4) % 4 === ((b % 4) + 4) % 4;
		}
	}
);

const selectorArb = fc.constantFrom<(n: number) => unknown>(
	function (n) {
		return n % 3;
	},
	function (n) {
		return Math.sign(n);
	},
	function (n) {
		return n > 5;
	},
	function (n) {
		return n;
	}
);

/**
 * Applies `op` to `state` the way the store is expected to compute the candidate next state.
 */
function next(state: number, op: Op, initial: number): number {
	if (op.kind === 'set') return op.value;
	if (op.kind === 'add') return state + op.value;
	return initial;
}

/**
 * Runs `op` against the store.
 */
function apply(store: ReturnType<typeof createStore<number>>, op: Op): void {
	if (op.kind === 'set') store.setState(op.value);
	else if (op.kind === 'add')
		store.setState(function (n) {
			return n + op.value;
		});
	else store.reset();
}

describe('createStore (properties)', function () {
	it('getState equals the reference fold and listeners fire once per non-equal transition', function () {
		fc.assert(
			fc.property(fc.integer({ min: -20, max: 20 }), equalsArb, fc.array(opArb, { maxLength: 50 }), function (initial, equals, ops) {
				const store = createStore(initial, { equals: equals.fn });
				let calls = 0;
				let expectedCalls = 0;
				let expected = initial;

				store.subscribe(function () {
					calls++;
				});

				for (const op of ops) {
					const candidate = next(expected, op, initial);
					if (!equals.fn(expected, candidate)) {
						expected = candidate;
						expectedCalls++;
					}
					apply(store, op);
					expect(store.getState()).toBe(expected);
				}

				expect(calls).toBe(expectedCalls);
			})
		);
	});

	it('select notifies exactly when the projection changes and always reflects the source', function () {
		fc.assert(
			fc.property(fc.integer({ min: -20, max: 20 }), selectorArb, fc.array(opArb, { maxLength: 50 }), function (initial, selector, ops) {
				const store = createStore(initial);
				const derived = store.select(selector);
				let calls = 0;
				let expectedCalls = 0;
				let projection = selector(initial);

				derived.subscribe(function () {
					calls++;
				});

				for (const op of ops) {
					apply(store, op);
					const current = selector(store.getState());
					if (!Object.is(current, projection)) {
						projection = current;
						expectedCalls++;
					}
					expect(derived.getState()).toBe(current);
				}

				expect(calls).toBe(expectedCalls);
			})
		);
	});

	it('never loses notifications under re-entrant setState: every listener last observes the final state', function () {
		fc.assert(
			fc.property(
				fc.array(fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }), { minLength: 1, maxLength: 5 }),
				fc.array(fc.integer({ min: -20, max: 20 }), { maxLength: 20 }),
				function (clamps, values) {
					const store = createStore(0);
					const lastSeen: Array<number | undefined> = clamps.map(function () {
						return undefined;
					});
					const bounds = clamps.filter(function (c): c is number {
						return c !== undefined;
					});
					const limit = bounds.length > 0 ? Math.min(...bounds) : Infinity;

					clamps.forEach(function (clamp, index) {
						store.subscribe(function () {
							lastSeen[index] = store.getState();
							// Re-entrant listeners clamp the state from above.
							if (clamp !== undefined && store.getState() > clamp) store.setState(clamp);
						});
					});

					let changed = false;

					for (const value of values) {
						const before = store.getState();
						store.setState(value);
						changed ||= value !== before;
						expect(store.getState()).toBe(Math.min(value, limit));
						// Once anything was notified, every listener has observed the latest state.
						expect(lastSeen).toEqual(
							lastSeen.map(function () {
								return changed ? store.getState() : undefined;
							})
						);
					}
				}
			)
		);
	});
});

/** A transition of a generated machine: target index (or `undefined` to stay), whether it increments the context, its guard. */
interface GeneratedTransition {
	target: number | undefined;
	increment: boolean;
	guard: 'none' | 'even' | 'odd';
}

const EVENTS = ['A', 'B', 'C'] as const;

const transitionArb: fc.Arbitrary<GeneratedTransition | null> = fc.option(
	fc.record({
		target: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
		increment: fc.boolean(),
		guard: fc.constantFrom<GeneratedTransition['guard']>('none', 'even', 'odd')
	})
);

/** Transitions of up to four states for each event (`null`: not handled). */
const tableArb = fc.array(fc.tuple(transitionArb, transitionArb, transitionArb), { minLength: 1, maxLength: 4 });

/**
 * Builds a machine config from a generated table (targets wrap around the number of states).
 */
function buildConfig(table: Array<[GeneratedTransition | null, GeneratedTransition | null, GeneratedTransition | null]>) {
	const states: Record<string, { on: Record<string, unknown> }> = {};
	table.forEach(function (row, index) {
		const on: Record<string, unknown> = {};
		row.forEach(function (transition, event) {
			if (transition === null) return;
			on[EVENTS[event]] = {
				target: transition.target === undefined ? undefined : `s${transition.target % table.length}`,
				guard:
					transition.guard === 'none'
						? undefined
						: function (n: number): boolean {
								return n % 2 === (transition.guard === 'even' ? 0 : 1);
							},
				update: transition.increment
					? function (n: number): number {
							return n + 1;
						}
					: undefined
			};
		});
		states[`s${index}`] = { on };
	});
	return { initial: 's0', context: 0, states };
}

/**
 * The reference interpreter: the next `[state, context]`, or `undefined` when the event is ignored or changes nothing.
 */
function step(
	table: Array<[GeneratedTransition | null, GeneratedTransition | null, GeneratedTransition | null]>,
	state: number,
	context: number,
	event: number
): [number, number] | undefined {
	const transition = table[state][event];
	if (transition === null) return undefined;
	if (transition.guard !== 'none' && context % 2 !== (transition.guard === 'even' ? 0 : 1)) return undefined;
	const result: [number, number] = [transition.target === undefined ? state : transition.target % table.length, transition.increment ? context + 1 : context];
	return result[0] === state && result[1] === context ? undefined : result;
}

describe('createMachine (properties)', function () {
	it('agrees with a reference interpreter, notifying once per change, with events sent by listeners handled in FIFO order', function () {
		fc.assert(
			fc.property(
				tableArb,
				fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 30 }),
				fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 30 }),
				function (table, events, reactions) {
					type Generated = { send(event: string): void; can(event: string): boolean; getState(): { value: string; context: number } };
					const machine = createMachine(buildConfig(table) as never) as unknown as Generated & { subscribe(listener: () => void): () => void };
					const pending = reactions.slice();
					const seen: string[] = [];
					machine.subscribe(function () {
						const { value, context } = machine.getState();
						seen.push(`${value}:${context}`);
						const reaction = pending.shift();
						if (reaction !== undefined) machine.send(EVENTS[reaction]);
					});

					let state = 0;
					let context = 0;
					const expected: string[] = [];
					const model = reactions.slice();
					for (const event of events) {
						const previous = machine.getState();
						machine.send(EVENTS[event]);

						const queue = [event];
						let changed = false;
						while (queue.length > 0) {
							const result = step(table, state, context, queue.shift() as number);
							if (result === undefined) continue;
							[state, context] = result;
							changed = true;
							expected.push(`s${state}:${context}`);
							const reaction = model.shift();
							if (reaction !== undefined) queue.push(reaction);
						}

						expect(machine.getState()).toEqual({ value: `s${state}`, context });
						if (!changed) expect(machine.getState()).toBe(previous);
					}
					expect(seen).toEqual(expected);
				}
			)
		);
	});

	it('can(event) is true exactly when send(event) changes the snapshot or the transition is a no-op', function () {
		fc.assert(
			fc.property(tableArb, fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 30 }), function (table, events) {
				const machine = createMachine(buildConfig(table) as never) as unknown as {
					send(event: string): void;
					can(event: string): boolean;
					getState(): { value: string; context: number };
				};
				for (const event of events) {
					const state = Number(machine.getState().value.slice(1));
					const transition = table[state][event];
					const context = machine.getState().context;
					const allowed = transition !== null && (transition.guard === 'none' || context % 2 === (transition.guard === 'even' ? 0 : 1));
					expect(machine.can(EVENTS[event])).toBe(allowed);
					const before = machine.getState();
					machine.send(EVENTS[event]);
					if (!allowed) expect(machine.getState()).toBe(before);
				}
			})
		);
	});
});

type HistoryOp = { kind: 'set'; value: number } | { kind: 'undo' } | { kind: 'redo' } | { kind: 'batch'; values: number[] } | { kind: 'clear' };

const historyOpArb: fc.Arbitrary<HistoryOp> = fc.oneof(
	{ weight: 4, arbitrary: fc.record({ kind: fc.constant('set' as const), value: fc.integer({ min: 0, max: 5 }) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant('undo' as const) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant('redo' as const) }) },
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant('batch' as const), values: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 4 }) }) },
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant('clear' as const) }) }
);

describe('createHistory (properties)', function () {
	it('agrees with a reference undo/redo stack model, whatever the limit', function () {
		fc.assert(
			fc.property(fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }), fc.array(historyOpArb, { maxLength: 60 }), function (limit, ops) {
				const store = createStore(0);
				const history = createHistory(store, { limit });
				const max = limit ?? Infinity;
				let past: number[] = [];
				let future: number[] = [];
				let present = 0;

				/**
				 * The model of a recorded change (merged into the newest step when `merge`, which disappears when the change goes back to
				 * the state it restores): whether the batch now has a step.
				 */
				function change(value: number, merge: boolean): boolean {
					if (value === present) return merge;
					future = [];
					if (merge && past.length > 0 && past[past.length - 1] === value) {
						past.pop();
						present = value;
						return false;
					}
					if (!merge) {
						past.push(present);
						if (past.length > max) past.shift();
					}
					present = value;
					return true;
				}

				for (const op of ops) {
					if (op.kind === 'set') {
						store.setState(op.value);
						change(op.value, false);
					} else if (op.kind === 'undo') {
						expect(history.undo()).toBe(past.length > 0);
						if (past.length > 0) {
							future.push(present);
							present = past.pop() as number;
						}
					} else if (op.kind === 'redo') {
						expect(history.redo()).toBe(future.length > 0);
						if (future.length > 0) {
							past.push(present);
							if (past.length > max) past.shift();
							present = future.pop() as number;
						}
					} else if (op.kind === 'batch') {
						history.batch(function () {
							for (const value of op.values) store.setState(value);
						});
						let recorded = false;
						for (const value of op.values) recorded = change(value, recorded);
					} else {
						history.clear();
						past = [];
						future = [];
					}
					expect(store.getState()).toBe(present);
					expect(history.getState()).toEqual({ canUndo: past.length > 0, canRedo: future.length > 0, undoCount: past.length, redoCount: future.length });
				}
			})
		);
	});
});

describe('computed (properties)', function () {
	/** An operation on one of three root stores. */
	const rootOpArb = fc.tuple(fc.integer({ min: 0, max: 2 }), opArb);

	it('always equals the reference combination, and notifies at most once per change, exactly when the result changes', function () {
		fc.assert(
			fc.property(selectorArb, selectorArb, equalsArb, fc.array(rootOpArb, { maxLength: 40 }), function (selectA, selectB, equals, ops) {
				const roots = [createStore(0), createStore(1), createStore(2)];
				// A diamond: `left` and `right` both derive from roots[0], and `total` combines them with the other roots.
				const left = roots[0].select(selectA);
				const right = computed([roots[0], roots[1]], function (a, b) {
					return String(selectB(a)) + b;
				});
				let computations = 0;
				const total = computed(
					[left, right, roots[2]],
					function (l, r, c) {
						computations++;
						return String(l).length + r.length + c;
					},
					{ equals: equals.fn }
				);
				/** The reference value, from the root states. */
				function reference(): number {
					const [a, b, c] = roots.map(function (root) {
						return root.getState();
					});
					return String(selectA(a)).length + (String(selectB(a)) + b).length + c;
				}
				let notified = total.getState();
				let calls = 0;
				total.subscribe(function () {
					calls++;
				});
				for (const [index, op] of ops) {
					const before = calls;
					const computationsBefore = computations;
					apply(roots[index], op);
					const expected = reference();
					// The stored value only changes when `equals` says so, so compare through it.
					expect(equals.fn(total.getState(), expected)).toBe(true);
					expect(calls - before).toBeLessThanOrEqual(1);
					expect(computations - computationsBefore).toBeLessThanOrEqual(1);
					if (!equals.fn(notified, total.getState())) {
						notified = total.getState();
						expect(calls - before).toBe(1);
					} else expect(calls - before).toBe(0);
				}
			})
		);
	});

	it('getState without subscribers equals getState with subscribers', function () {
		fc.assert(
			fc.property(selectorArb, fc.array(rootOpArb, { maxLength: 30 }), fc.array(fc.boolean(), { maxLength: 30 }), function (selector, ops, toggles) {
				const roots = [createStore(0), createStore(1), createStore(2)];
				const view = computed(roots, function (a, b, c) {
					return [selector(a), b, c];
				});
				let unsubscribe: (() => void) | undefined;
				ops.forEach(function ([index, op], i) {
					if (toggles[i]) {
						if (unsubscribe === undefined) unsubscribe = view.subscribe(function () {});
						else {
							unsubscribe();
							unsubscribe = undefined;
						}
					}
					apply(roots[index], op);
					expect(view.getState()).toEqual([selector(roots[0].getState()), roots[1].getState(), roots[2].getState()]);
					expect(view.getState()).toBe(view.getState());
				});
			})
		);
	});
});

describe('persistStore (properties)', function () {
	/**
	 * An in-memory storage.
	 */
	function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; data: Map<string, string> } {
		const data = new Map<string, string>();
		return {
			data,
			getItem(key: string): string | null {
				return data.get(key) ?? null;
			},
			setItem(key: string, value: string): void {
				data.set(key, value);
			},
			removeItem(key: string): void {
				data.delete(key);
			}
		};
	}

	/**
	 * What a JSON round trip without the documented pollution keys gives: `__proto__`, and a `constructor` object with a `prototype` key.
	 */
	function sanitized(value: unknown): unknown {
		return JSON.parse(JSON.stringify(value), function (key, item) {
			if (key === '__proto__') return undefined;
			return key === 'constructor' && typeof item === 'object' && item !== null && Object.hasOwn(item, 'prototype') ? undefined : item;
		});
	}

	const keyArb = fc.oneof(fc.string(), fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString'));
	const stateArb = fc.dictionary(keyArb, fc.jsonValue(), { maxKeys: 6 });

	it('a persisted state hydrates a new store to the same (JSON) state', function () {
		fc.assert(
			fc.property(stateArb, stateArb, function (state, initial) {
				const storage = memory();
				const source = createStore<Record<string, unknown>>({});
				persistStore(source, { key: 'k', storage });
				source.setState(state);
				const target = createStore<Record<string, unknown>>(initial);
				persistStore(target, { key: 'k', storage });
				const expected = { ...(sanitized(initial) as object) };
				for (const [key, value] of Object.entries(sanitized(state) as object)) {
					Object.defineProperty(expected, key, { value, enumerable: true, writable: true, configurable: true });
				}
				expect(sanitized(target.getState())).toEqual(sanitized(expected));
				expect(Object.getPrototypeOf(target.getState())).toBe(Object.prototype);
				expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			}),
			{ examples: [[{ constructor: { prototype: 0 } }, {}]] }
		);
	});

	it('hydration never throws on arbitrary stored text, and either keeps the state or reports nothing', function () {
		const textArb = fc.oneof(
			fc.string(),
			fc.json(),
			fc.jsonValue().map(function (value) {
				return JSON.stringify({ state: value, version: 0 });
			})
		);
		fc.assert(
			fc.property(textArb, function (text) {
				const storage = memory();
				storage.data.set('k', text);
				const store = createStore<unknown>({ initial: true });
				const before = store.getState();
				const errors: unknown[] = [];
				expect(function () {
					persistStore(store, {
						key: 'k',
						storage,
						onError(error) {
							errors.push(error);
						}
					});
				}).not.toThrow();
				// Exactly one outcome: hydrated (no error) or untouched (one error).
				if (errors.length > 0) expect(store.getState()).toBe(before);
				expect(errors.length).toBeLessThanOrEqual(1);
			})
		);
	});
});

describe('batch (properties)', function () {
	it('notifies every store that changed exactly once, after every change, and a computed store over them at most once', function () {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(fc.tuple(fc.nat(3), fc.integer({ min: 0, max: 3 }), fc.boolean()), { maxLength: 20 }),
				function (count, changes) {
					const stores = Array.from({ length: count }, function () {
						return createStore(0);
					});
					const sum = computed(stores, function (...states: number[]) {
						return states.reduce(function (a, b) {
							return a + b;
						}, 0);
					});
					const seen: number[][] = stores.map(function () {
						return [];
					});
					const sums: number[] = [];
					stores.forEach(function (store, i) {
						store.subscribe(function () {
							seen[i].push(store.getState());
						});
					});
					sum.subscribe(function () {
						sums.push(sum.getState());
					});
					const changed = new Set<number>();
					const before = sum.getState();
					batch(function () {
						for (const [index, value, nested] of changes) {
							const store = stores[index % count];
							if (!Object.is(store.getState(), value)) changed.add(index % count);
							if (nested)
								batch(function () {
									store.setState(value);
								});
							else store.setState(value);
						}
						expect(seen.flat()).toEqual([]);
					});
					stores.forEach(function (store, i) {
						expect(seen[i]).toEqual(changed.has(i) ? [store.getState()] : []);
					});
					expect(sums).toEqual(sum.getState() === before ? [] : [sum.getState()]);
				}
			)
		);
	});
});
