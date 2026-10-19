import fc from 'fast-check';
import { createHistory, createMachine, createStore } from '.';

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
