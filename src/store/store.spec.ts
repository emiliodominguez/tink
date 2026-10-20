import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isEqual } from '../objects/index.js';
import {
	batch,
	computed,
	createHistory,
	createMachine,
	createStore,
	persistStore,
	type HistorySource,
	type PersistStorage,
	type MachineSnapshot,
	type ReadonlyStore,
	type StateConfig,
	type Store,
	type StoreHistory,
	type Unsubscribe
} from '.';

interface State {
	count: number;
	step: number;
	tags: string[];
}

function initial(): State {
	return { count: 0, step: 1, tags: [] };
}

describe('createStore', function () {
	describe('types', function () {
		it('infers state, updater and derived types', function () {
			const store: Store<State> = createStore(initial());
			const count: ReadonlyStore<number> = store.select(function (s) {
				return s.count;
			});

			const scratch = createStore(initial());
			// @ts-expect-error wrong state shape
			scratch.setState({ count: 1 });
			// @ts-expect-error updater must return the state
			scratch.setState(function (s: State) {
				return s.count;
			});
			expect(function () {
				// @ts-expect-error derived stores are read-only
				count.setState(1);
			}).toThrow(TypeError);

			expect(count.getState()).toBe(0);
		});
	});

	describe('getState / setState', function () {
		it('returns the initial state and the same reference until it changes', function () {
			const start = initial();
			const store = createStore(start);

			expect(store.getState()).toBe(start);
			expect(store.getState()).toBe(store.getState());
		});

		it('accepts values and updater functions', function () {
			const store = createStore(initial());

			store.setState({ count: 5, step: 2, tags: [] });
			store.setState(function (s) {
				return { ...s, count: s.count + s.step };
			});

			expect(store.getState().count).toBe(7);
		});

		it('notifies listeners without arguments after each change', function () {
			const store = createStore(0);
			const seen: unknown[][] = [];

			store.subscribe(function (...args: unknown[]) {
				seen.push([...args, store.getState()]);
			});
			store.setState(1);
			store.setState(function (n) {
				return n + 1;
			});

			expect(seen).toEqual([[1], [2]]);
		});

		it('is a no-op when the new state is Object.is-equal to the current one', function () {
			const store = createStore(NaN);
			const listener = jest.fn();

			store.subscribe(listener);
			store.setState(NaN);
			store.setState(function (n) {
				return n;
			});
			expect(listener).not.toHaveBeenCalled();

			store.setState(0);
			store.setState(-0);
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it('uses the custom equals option', function () {
			const store = createStore(initial(), { equals: isEqual });
			const listener = jest.fn();
			const before = store.getState();

			store.subscribe(listener);
			store.setState(initial());
			expect(listener).not.toHaveBeenCalled();
			expect(store.getState()).toBe(before);

			store.setState({ ...initial(), tags: ['x'] });
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('leaves the state unchanged when the updater throws', function () {
			const store = createStore(1);
			const listener = jest.fn();
			store.subscribe(listener);

			expect(function () {
				store.setState(function () {
					throw new Error('nope');
				});
			}).toThrow('nope');
			expect(store.getState()).toBe(1);
			expect(listener).not.toHaveBeenCalled();
		});

		it('treats function arguments as updaters (wrap functions to store them)', function () {
			function a(): string {
				return 'a';
			}
			function b(): string {
				return 'b';
			}
			const store = createStore<() => string>(a);

			store.setState(function () {
				return b;
			});
			expect(store.getState()).toBe(b);
		});

		it('supports undefined, null and unicode states', function () {
			const store = createStore<string | null | undefined>(undefined);

			store.setState(null);
			expect(store.getState()).toBeNull();
			store.setState('héllo 🌍');
			expect(store.getState()).toBe('héllo 🌍');
		});
	});

	describe('reset', function () {
		it('restores the initial state and notifies only when it differs', function () {
			const store = createStore(initial());
			const start = store.getState();
			const listener = jest.fn();

			store.subscribe(listener);
			store.reset();
			expect(listener).not.toHaveBeenCalled();

			store.setState({ ...start, count: 3 });
			store.reset();
			expect(store.getState()).toBe(start);
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it('restores a function state without calling it', function () {
			const original = jest.fn();
			const store = createStore<() => void>(original);

			store.setState(function () {
				return function () {};
			});
			store.reset();
			expect(store.getState()).toBe(original);
			expect(original).not.toHaveBeenCalled();
		});
	});

	describe('subscribe', function () {
		it('returns an idempotent unsubscribe that removes only its own subscription', function () {
			const store = createStore(0);
			const listener = jest.fn();
			const first = store.subscribe(listener);

			store.subscribe(listener);
			store.setState(1);
			expect(listener).toHaveBeenCalledTimes(2);

			first();
			first();
			store.setState(2);
			expect(listener).toHaveBeenCalledTimes(3);
		});

		it('works with unbound methods, as useSyncExternalStore uses them', function () {
			const { subscribe, getState, setState } = createStore(0);
			const values: number[] = [];

			const unsubscribe = subscribe(function () {
				values.push(getState());
			});
			setState(1);
			unsubscribe();
			setState(2);

			expect(values).toEqual([1]);
			expect(getState()).toBe(2);
		});

		it('does not call listeners added during a notification for that change', function () {
			const store = createStore(0);
			const late = jest.fn();

			store.subscribe(function () {
				store.subscribe(late);
			});
			store.setState(1);
			expect(late).not.toHaveBeenCalled();
		});

		it('keeps every existing listener when one is added during a notification', function () {
			const store = createStore(0);
			const first = jest.fn();
			const late = jest.fn();
			let added = false;

			store.subscribe(first);
			store.subscribe(function () {
				if (!added) store.subscribe(late);
				added = true;
			});
			store.setState(1);
			store.setState(2);
			expect(first).toHaveBeenCalledTimes(2);
			expect(late).toHaveBeenCalledTimes(1);
		});

		it('runs every listener when one throws, then rethrows; the change is kept', function () {
			const store = createStore(0);
			const after = jest.fn();
			const boom = new Error('boom');

			store.subscribe(function () {
				throw boom;
			});
			store.subscribe(after);

			expect(function () {
				store.setState(1);
			}).toThrow(boom);
			expect(after).toHaveBeenCalledTimes(1);
			expect(store.getState()).toBe(1);
		});

		it('wraps errors of several listeners in an AggregateError', function () {
			const store = createStore(0);

			store.subscribe(function () {
				throw new Error('1');
			});
			store.subscribe(function () {
				throw new Error('2');
			});

			let caught: unknown;
			try {
				store.setState(1);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AggregateError);
			expect((caught as AggregateError).message).toBe('store: 2 listeners threw');
			expect((caught as AggregateError).errors).toEqual([new Error('1'), new Error('2')]);
		});

		it('rethrows whatever a listener threw, even undefined', function () {
			const store = createStore(0);
			const after = jest.fn();

			store.subscribe(function () {
				throw undefined;
			});
			store.subscribe(after);

			let caught: unknown = 'nothing';
			try {
				store.setState(1);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeUndefined();
			expect(after).toHaveBeenCalledTimes(1);
		});

		it('skips listeners unsubscribed during a round and keeps the others in order', function () {
			const store = createStore(0);
			const calls: string[] = [];
			const handles: { stopB?: Unsubscribe; stopA?: Unsubscribe } = {};

			handles.stopA = store.subscribe(function () {
				calls.push('a');
				handles.stopA?.();
				handles.stopB?.();
			});
			handles.stopB = store.subscribe(function () {
				calls.push('b');
			});
			store.subscribe(function () {
				calls.push('c');
			});
			store.setState(1);
			store.setState(2);
			expect(calls).toEqual(['a', 'c', 'c']);
		});

		it('wraps errors of several notification rounds in an AggregateError', function () {
			const store = createStore(0);
			const errors: Error[] = [];

			store.subscribe(function () {
				const error = new Error(String(store.getState()));
				errors.push(error);
				if (store.getState() === 1) store.setState(2);
				throw error;
			});

			let caught: unknown;
			try {
				store.setState(1);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AggregateError);
			expect((caught as AggregateError).message).toBe('store: 2 notification rounds threw');
			expect((caught as AggregateError).errors).toEqual(errors);
			expect(errors).toHaveLength(2);
		});

		it('rejects non-function listeners and options', function () {
			const store = createStore(0);

			expect(function () {
				store.subscribe(null as any);
			}).toThrow(new TypeError('subscribe: `listener` must be a function, got null'));
			expect(function () {
				createStore(0, { equals: 'x' as any });
			}).toThrow(new TypeError('createStore: `options.equals` must be a function, got string'));
			const proto = Object.prototype as Record<string, unknown>;
			proto.equals = function (): boolean {
				return true;
			};
			try {
				const polluted = createStore(0);
				polluted.setState(1);
				expect(polluted.getState()).toBe(1);
			} finally {
				delete proto.equals;
			}
			expect(function () {
				store.select('x' as any);
			}).toThrow(new TypeError('select: `selector` must be a function, got string'));
			expect(function () {
				store.select(function (n) {
					return n;
				}, 1 as any);
			}).toThrow(new TypeError('select: `equals` must be a function, got number'));
			expect(function () {
				store
					.select(function (n) {
						return n;
					})
					.subscribe(undefined as any);
			}).toThrow(new TypeError('subscribe: `listener` must be a function, got undefined'));
		});
	});

	describe('re-entrancy', function () {
		it('applies setState from a listener immediately and runs another round after the current one', function () {
			const store = createStore(0);
			const calls: string[] = [];

			store.subscribe(function () {
				calls.push(`A${store.getState()}`);
				if (store.getState() === 1) store.setState(2);
				calls.push(`A-after${store.getState()}`);
			});
			store.subscribe(function () {
				calls.push(`B${store.getState()}`);
			});
			store.setState(1);

			expect(calls).toEqual(['A1', 'A-after2', 'B2', 'A2', 'A-after2', 'B2']);
			expect(store.getState()).toBe(2);
		});

		it('coalesces several updates made during one round into one more round', function () {
			const store = createStore(0);
			const listener = jest.fn();

			store.subscribe(function () {
				if (store.getState() === 1) {
					store.setState(2);
					store.setState(3);
				}
			});
			store.subscribe(listener);
			store.setState(1);

			expect(listener).toHaveBeenCalledTimes(2);
			expect(store.getState()).toBe(3);
		});

		it('keeps notifying after a round that threw', function () {
			const store = createStore(0);
			const values: number[] = [];
			const boom = new Error('boom');

			store.subscribe(function () {
				values.push(store.getState());
				if (store.getState() === 1) {
					store.setState(2);
					throw boom;
				}
			});

			expect(function () {
				store.setState(1);
			}).toThrow(boom);
			expect(values).toEqual([1, 2]);

			store.setState(3);
			expect(values).toEqual([1, 2, 3]);
		});

		it('throws a RangeError instead of looping forever, and stays usable', function () {
			const store = createStore(0);
			const stop = store.subscribe(function () {
				store.setState(function (n) {
					return n + 1;
				});
			});

			expect(function () {
				store.setState(1);
			}).toThrow(new RangeError('store: listeners changed the state during 100 consecutive notification rounds'));
			expect(store.getState()).toBeGreaterThan(100);

			stop();
			const listener = jest.fn();
			store.subscribe(listener);
			store.setState(0);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('select', function () {
		it('does not notify when the value changed and changed back within one notification, even if it was read in between', function () {
			const store = createStore({ v: 0 });
			const derived: { current?: ReadonlyStore<number> } = {};
			store.subscribe(function () {
				derived.current?.getState();
				if (store.getState().v === 1) store.setState({ v: 0 });
			});
			const selected = store.select(function (state) {
				return state.v;
			});
			derived.current = selected;
			const seen: number[] = [];
			selected.subscribe(function () {
				seen.push(selected.getState());
			});
			store.setState({ v: 1 });
			expect(seen).toEqual([]);
			store.setState({ v: 2 });
			expect(seen).toEqual([2]);
		});

		it('returns the selected value and only notifies when it changes', function () {
			const store = createStore(initial());
			const count = store.select(function (s) {
				return s.count;
			});
			const listener = jest.fn();

			count.subscribe(listener);
			store.setState(function (s) {
				return { ...s, step: 5 };
			});
			expect(listener).not.toHaveBeenCalled();

			store.setState(function (s) {
				return { ...s, count: s.count + s.step };
			});
			expect(listener).toHaveBeenCalledTimes(1);
			expect(count.getState()).toBe(5);
		});

		it('caches the selected value so getState is referentially stable', function () {
			const store = createStore(initial());
			const selector = jest.fn(function (s: State) {
				return { count: s.count };
			});
			const view = store.select(selector);

			const first = view.getState();
			expect(view.getState()).toBe(first);
			expect(selector).toHaveBeenCalledTimes(1);

			store.setState(function (s) {
				return { ...s, count: 1 };
			});
			const second = view.getState();
			expect(second).toEqual({ count: 1 });
			expect(second).not.toBe(first);
			expect(view.getState()).toBe(second);
		});

		it('keeps the previous reference when the custom equals reports no change', function () {
			const store = createStore(initial());
			const view = store.select(function (s) {
				return { count: s.count };
			}, isEqual);
			const listener = jest.fn();

			view.subscribe(listener);
			const first = view.getState();
			store.setState(function (s) {
				return { ...s, step: 3 };
			});

			expect(view.getState()).toBe(first);
			expect(listener).not.toHaveBeenCalled();
		});

		it('notifies even when another listener read the derived value earlier in the same round', function () {
			const store = createStore(0);
			const doubled = store.select(function (n) {
				return n * 2;
			});
			const seen: number[] = [];

			store.subscribe(function () {
				doubled.getState();
			});
			doubled.subscribe(function () {
				seen.push(doubled.getState());
			});
			store.setState(1);

			expect(seen).toEqual([2]);
		});

		it('detaches from the source when its last listener unsubscribes during a notification', function () {
			const store = createStore(0);
			const selector = jest.fn(function (n: number) {
				return n;
			});
			const selected = store.select(selector);
			const handles: { stop?: Unsubscribe } = {};

			handles.stop = selected.subscribe(function () {
				handles.stop?.();
			});
			store.setState(1);
			selector.mockClear();
			store.setState(2);
			expect(selector).not.toHaveBeenCalled();
		});

		it('only subscribes to the source while it has listeners', function () {
			const store = createStore(0);
			const selector = jest.fn(function (n: number) {
				return n % 2;
			});
			const parity = store.select(selector);
			const listener = jest.fn();

			store.setState(1);
			expect(selector).not.toHaveBeenCalled();

			const stop = parity.subscribe(listener);
			const again = parity.subscribe(listener);
			store.setState(2);
			expect(listener).toHaveBeenCalledTimes(2);

			stop();
			stop();
			store.setState(3);
			expect(listener).toHaveBeenCalledTimes(3);

			again();
			expect(again).not.toThrow(); // already detached: calling it again is a no-op
			selector.mockClear();
			store.setState(4);
			store.setState(5);
			expect(selector).not.toHaveBeenCalled();
			expect(parity.getState()).toBe(1);

			parity.subscribe(listener);
			store.setState(7);
			expect(listener).toHaveBeenCalledTimes(3);
			store.setState(8);
			expect(listener).toHaveBeenCalledTimes(4);
		});

		it('can be chained and stays consistent', function () {
			const store = createStore(initial());
			const tags = store.select(function (s) {
				return s.tags;
			});
			const tagCount = tags.select(function (t) {
				return t.length;
			});
			const counts: number[] = [];

			tagCount.subscribe(function () {
				counts.push(tagCount.getState());
			});
			store.setState(function (s) {
				return { ...s, tags: ['a'] };
			});
			store.setState(function (s) {
				return { ...s, tags: ['b'] };
			});
			store.setState(function (s) {
				return { ...s, tags: ['b', 'c'] };
			});

			expect(counts).toEqual([1, 2]);
			expect(tagCount.getState()).toBe(2);
		});

		it('sees state set by derived listeners in a follow-up round', function () {
			const store = createStore(0);
			const isOdd = store.select(function (n) {
				return n % 2 === 1;
			});
			const seen: number[] = [];

			isOdd.subscribe(function () {
				if (isOdd.getState()) store.setState(store.getState() + 1);
			});
			store.subscribe(function () {
				seen.push(store.getState());
			});
			store.setState(1);

			expect(store.getState()).toBe(2);
			expect(seen).toEqual([2, 2]);
		});

		it('propagates selector errors from setState without corrupting the store', function () {
			const store = createStore(0);
			const view = store.select(function (n) {
				if (n < 0) throw new Error('negative');
				return n;
			});
			const listener = jest.fn();

			view.subscribe(listener);
			expect(function () {
				store.setState(-1);
			}).toThrow('negative');
			expect(store.getState()).toBe(-1);

			store.setState(2);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(view.getState()).toBe(2);
		});

		it('recomputes after the equality function threw instead of serving a stale value', function () {
			const store = createStore(1);
			let failing = false;
			const view = store.select(
				function (n) {
					return { n };
				},
				function (a, b) {
					if (failing) throw new Error('equals');
					return a.n === b.n;
				}
			);

			expect(view.getState()).toEqual({ n: 1 });
			failing = true;
			store.setState(2);
			expect(view.getState).toThrow('equals');
			failing = false;
			expect(view.getState()).toEqual({ n: 2 });
		});

		it('does not attach to the source when the selector throws on subscribe', function () {
			const store = createStore(-1);
			const view = store.select(function (n) {
				if (n < 0) throw new Error('negative');
				return n;
			});
			const listener = jest.fn();

			expect(function () {
				view.subscribe(listener);
			}).toThrow('negative');
			store.setState(1);
			expect(listener).not.toHaveBeenCalled();
		});
	});
});

describe('createStore (re-entrancy)', function () {
	it('attaches a selection once when its selector subscribes to it, so it detaches when unsubscribed', function () {
		const root = createStore(0);
		let calls = 0;
		let inner: Unsubscribe | undefined;
		let subscribed = false;
		const selected: ReadonlyStore<number> = root.select(function (n: number): number {
			calls++;
			if (!subscribed) {
				subscribed = true;
				inner = selected.subscribe(function () {});
			}
			return n;
		});
		const outer = selected.subscribe(function () {});
		(inner as Unsubscribe)();
		outer();
		calls = 0;
		root.setState(1);
		expect(calls).toBe(0);
	});

	it('keeps the errors of earlier rounds as the cause when the round limit trips', function () {
		const root = createStore(0);
		const lost = new Error('lost');
		root.subscribe(function () {
			root.setState(root.getState() + 1);
			if (root.getState() === 50) throw lost;
		});
		let caught: unknown;
		try {
			root.setState(1);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(RangeError);
		expect((caught as RangeError).cause).toBe(lost);

		const twice = createStore(0);
		twice.subscribe(function () {
			twice.setState(twice.getState() + 1);
			if (twice.getState() === 10 || twice.getState() === 20) throw new Error(`round ${twice.getState()}`);
		});
		expect(function () {
			twice.setState(1);
		}).toThrow(
			expect.objectContaining({
				cause: expect.objectContaining({ message: 'store: 2 notification rounds threw', errors: [new Error('round 10'), new Error('round 20')] })
			})
		);
	});

	it('lets a listener replace every subscription during a round', function () {
		const root = createStore(0);
		const calls: string[] = [];
		const unsubscribes: Unsubscribe[] = [];
		for (let i = 0; i < 3; i++) {
			unsubscribes.push(
				root.subscribe(function () {
					calls.push(`old${i}`);
					if (i === 0) {
						for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
						for (let j = 0; j < 3; j++) {
							root.subscribe(function () {
								calls.push(`new${j}`);
							});
						}
					}
				})
			);
		}
		root.setState(1);
		root.setState(2);
		expect(calls).toEqual(['old0', 'new0', 'new1', 'new2']);
	});
});

/**
 * A fetch machine with a context, a typed payload, a guard and a targetless transition.
 */
function fetcher() {
	return createMachine({
		initial: 'idle',
		context: { data: '', retries: 0 },
		states: {
			idle: { on: { FETCH: 'loading', NOOP: 'idle' } },
			loading: {
				on: {
					RESOLVE: {
						target: 'done',
						update(context, event: { type: 'RESOLVE'; data: string }) {
							return { ...context, data: event.data };
						}
					},
					REJECT: {
						target: 'idle',
						guard(context) {
							return context.retries < 2;
						},
						update(context) {
							return { ...context, retries: context.retries + 1 };
						}
					},
					TICK: {
						update(context) {
							return context;
						}
					}
				}
			},
			done: {}
		}
	});
}

describe('createMachine', function () {
	describe('types', function () {
		it('infers states, context and events, and rejects unknown ones', function () {
			const machine = fetcher();
			const snapshot: MachineSnapshot<'idle' | 'loading' | 'done', { data: string; retries: number }> = machine.getState();
			expect(snapshot).toEqual({ value: 'idle', context: { data: '', retries: 0 } });

			expect(function () {
				// @ts-expect-error RESOLVE needs its payload
				machine.send('RESOLVE');
				// @ts-expect-error RESOLVE needs its payload
				machine.send({ type: 'RESOLVE' });
				// @ts-expect-error no state handles this event
				machine.send('NOPE');
				// @ts-expect-error not a state
				machine.matches('nope');
			}).not.toThrow();

			const bare = createMachine({ initial: 'a', states: { a: {} } });
			const context: undefined = bare.getState().context;
			expect(context).toBeUndefined();
		});
	});

	describe('types (shared events, annotations, separate configs)', function () {
		it('requires every payload declared for an event type, whichever state handles it', function () {
			const editor = createMachine({
				initial: 'editing',
				context: '',
				states: {
					editing: {
						on: {
							SAVE: {
								target: 'saved',
								update(previous, event: { type: 'SAVE'; text: string }) {
									void previous;
									return event.text;
								}
							}
						}
					},
					saved: { on: { SAVE: 'editing' } }
				}
			});

			/**
			 * Misuse rejected by the types (never called: the editing state would read `event.text` from an event without it).
			 */
			function misuse(): void {
				// @ts-expect-error the editing state needs the text
				editor.send('SAVE');
				// @ts-expect-error same for object events
				editor.send({ type: 'SAVE' });
			}
			editor.send({ type: 'SAVE', text: 'draft' });
			expect(editor.getState()).toEqual({ value: 'saved', context: 'draft' });
			// The saved state ignores the payload, but the sender cannot know which state the machine is in.
			editor.send({ type: 'SAVE', text: 'ignored' });
			expect(editor.getState()).toEqual({ value: 'editing', context: 'draft' });
			expect(misuse).toEqual(expect.any(Function));
		});

		it('reports an event parameter annotated with another type on the transition', function () {
			const machine = createMachine({
				initial: 'a',
				context: '',
				states: {
					a: {
						on: {
							// @ts-expect-error the event parameter says REJECT
							RESOLVE: {
								update(context: string, event: { type: 'REJECT'; data: string }): string {
									return context + event.data;
								}
							}
						}
					}
				}
			});
			expect(machine.getState().value).toBe('a');
		});

		it('accepts configs declared separately with as const and satisfies', function () {
			const config = { initial: 'off', states: { off: { on: { TOGGLE: 'on' } }, on: { on: { TOGGLE: 'off' } } } } as const;
			const toggle = createMachine(config);
			toggle.send('TOGGLE');
			// @ts-expect-error no state handles it
			expect(toggle.can('NOPE')).toBe(false);
			const value: 'on' | 'off' = toggle.getState().value;
			expect(value).toBe('on');

			const states = {
				idle: {
					on: {
						ADD: {
							update(count: number, event: { type: 'ADD'; by: number }): number {
								return count + event.by;
							}
						}
					}
				}
			} as const satisfies Record<string, StateConfig<number>>;
			const counter = createMachine({ initial: 'idle', context: 0, states });
			counter.send({ type: 'ADD', by: 2 });
			expect(counter.getState().context).toBe(2);
		});
	});

	describe('transitions', function () {
		it('follows transitions given as event types or event objects, with payloads', function () {
			const machine = fetcher();

			machine.send('FETCH');
			expect(machine.getState().value).toBe('loading');
			expect(machine.matches('loading')).toBe(true);
			expect(machine.matches('idle')).toBe(false);

			machine.send({ type: 'RESOLVE', data: 'héllo 🌍' });
			expect(machine.getState()).toEqual({ value: 'done', context: { data: 'héllo 🌍', retries: 0 } });
		});

		it('passes the context and the event object (built for bare types) to guards and updates', function () {
			const seen: unknown[][] = [];
			const machine = createMachine({
				initial: 'a',
				context: { n: 1 },
				states: {
					a: {
						on: {
							GO: {
								target: 'a',
								guard(context, event) {
									seen.push(['guard', context, event]);
									return true;
								},
								update(context, event) {
									seen.push(['update', context, event]);
									return { n: context.n + 1 };
								}
							}
						}
					}
				}
			});
			const event = { type: 'GO' as const, extra: 1 };

			machine.send('GO');
			machine.send(event);
			expect(seen).toEqual([
				['guard', { n: 1 }, { type: 'GO' }],
				['update', { n: 1 }, { type: 'GO' }],
				['guard', { n: 2 }, event],
				['update', { n: 2 }, event]
			]);
			expect(seen[3][2]).toBe(event);
		});

		it('ignores events the current state does not handle, and events whose guard refuses', function () {
			const machine = fetcher();
			const listener = jest.fn();
			machine.subscribe(listener);
			const start = machine.getState();

			machine.send({ type: 'RESOLVE', data: 'x' });
			machine.send('NOPE' as 'FETCH');
			machine.send('toString' as 'FETCH');
			machine.send('__proto__' as 'FETCH');
			expect(machine.getState()).toBe(start);

			machine.send('FETCH');
			machine.send('REJECT');
			machine.send('FETCH');
			machine.send('REJECT');
			machine.send('FETCH');
			expect(machine.can('REJECT')).toBe(false);
			machine.send('REJECT');
			expect(machine.getState()).toEqual({ value: 'loading', context: { data: '', retries: 2 } });
			expect(listener).toHaveBeenCalledTimes(5);
		});

		it('keeps the snapshot (and does not notify) for transitions that change nothing', function () {
			const machine = fetcher();
			const listener = jest.fn();
			machine.subscribe(listener);
			const start = machine.getState();

			machine.send('NOOP');
			expect(machine.getState()).toBe(start);
			machine.send('FETCH');
			const loading = machine.getState();
			machine.send('TICK');
			expect(machine.getState()).toBe(loading);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('updates the context without changing state for targetless transitions', function () {
			const counter = createMachine({
				initial: 'active',
				context: 0,
				states: {
					active: {
						on: {
							INC: {
								update(n) {
									return n + 1;
								}
							},
							STOP: 'stopped'
						}
					},
					stopped: {}
				}
			});
			const snapshots: Array<MachineSnapshot<'active' | 'stopped', number>> = [];
			counter.subscribe(function () {
				snapshots.push(counter.getState());
			});

			counter.send('INC');
			counter.send('INC');
			counter.send('STOP');
			counter.send('INC');
			expect(snapshots).toEqual([
				{ value: 'active', context: 1 },
				{ value: 'active', context: 2 },
				{ value: 'stopped', context: 2 }
			]);
		});

		it('supports state and event names that are Object.prototype keys', function () {
			const machine = createMachine({
				initial: '__proto__',
				states: {
					['__proto__']: { on: { constructor: 'toString' } },
					toString: { on: { ['__proto__']: '__proto__' } }
				}
			});

			expect(machine.getState().value).toBe('__proto__');
			machine.send('constructor');
			expect(machine.getState().value).toBe('toString');
			machine.send('__proto__');
			expect(machine.getState().value).toBe('__proto__');
		});

		it('copies the config: later changes to it have no effect', function () {
			const states = { a: { on: { GO: 'b' as const } }, b: { on: { BACK: 'a' as const } } };
			const machine = createMachine({ initial: 'a', states });

			(states.a.on as Record<string, string>).GO = 'a';
			delete (states.b as { on?: unknown }).on;
			machine.send('GO');
			machine.send('BACK');
			expect(machine.getState().value).toBe('a');
		});

		it('works with unbound methods and select, as useSyncExternalStore uses them', function () {
			const { send, subscribe, getState, select, can, matches } = fetcher();
			const retries = select(function (snapshot) {
				return snapshot.context.retries;
			});
			const values: number[] = [];
			subscribe(function () {
				values.push(retries.getState());
			});

			send('FETCH');
			send('REJECT');
			expect(values).toEqual([0, 1]);
			expect(getState().value).toBe('idle');
			expect(can('FETCH')).toBe(true);
			expect(matches('idle')).toBe(true);
		});
	});

	describe('can', function () {
		it('tells whether an event would take a transition, running the guard without side effects', function () {
			const machine = fetcher();
			const listener = jest.fn();
			machine.subscribe(listener);

			expect(machine.can('FETCH')).toBe(true);
			expect(machine.can({ type: 'RESOLVE', data: 'x' })).toBe(false);
			machine.send('FETCH');
			expect(machine.can({ type: 'RESOLVE', data: 'x' })).toBe(true);
			expect(machine.can('REJECT')).toBe(true);
			expect(machine.can('TICK')).toBe(true);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('rethrows guard errors', function () {
			const machine = createMachine({
				initial: 'a',
				states: {
					a: {
						on: {
							GO: {
								guard() {
									throw new Error('guard');
								}
							}
						}
					}
				}
			});

			expect(function () {
				machine.can('GO');
			}).toThrow('guard');
		});
	});

	describe('errors', function () {
		it('stays in its snapshot when a guard or update throws, and rethrows', function () {
			let fail = true;
			const machine = createMachine({
				initial: 'a',
				context: 0,
				states: {
					a: {
						on: {
							GUARDED: {
								target: 'b',
								guard() {
									if (fail) throw new Error('guard');
									return true;
								}
							},
							UPDATED: {
								target: 'b',
								update(n) {
									if (fail) throw new Error('update');
									return n + 1;
								}
							}
						}
					},
					b: {}
				}
			});
			const listener = jest.fn();
			machine.subscribe(listener);
			const start = machine.getState();

			expect(function () {
				machine.send('GUARDED');
			}).toThrow('guard');
			expect(function () {
				machine.send('UPDATED');
			}).toThrow('update');
			expect(machine.getState()).toBe(start);
			expect(listener).not.toHaveBeenCalled();

			fail = false;
			machine.send('UPDATED');
			expect(machine.getState()).toEqual({ value: 'b', context: 1 });
		});

		it('rejects guards returning anything but a boolean (an async guard would always pass)', function () {
			const machine = createMachine({
				initial: 'a',
				states: {
					a: {
						on: {
							GO: {
								target: 'b',
								guard: function () {
									return Promise.resolve(false);
								} as unknown as () => boolean
							}
						}
					},
					b: {}
				}
			});

			expect(function () {
				machine.send('GO');
			}).toThrow(new TypeError('send: the guard of `config.states.a.on.GO` must return a boolean, got object'));
			expect(function () {
				machine.can('GO');
			}).toThrow(new TypeError('can: the guard of `config.states.a.on.GO` must return a boolean, got object'));
			expect(machine.getState().value).toBe('a');
		});

		it('forbids send from guards and updates', function () {
			const machine = createMachine({
				initial: 'a',
				context: 0,
				states: {
					a: {
						on: {
							GO: {
								target: 'b',
								guard(): boolean {
									machine.send('GO');
									return true;
								}
							},
							SET: {
								update(n: number): number {
									expect(machine.can('GO')).toBe(false);
									machine.send('SET');
									return n + 1;
								}
							}
						}
					},
					b: {}
				}
			});

			expect(function () {
				machine.send('GO');
			}).toThrow(new Error('send: guards and updates must not send events'));
			expect(function () {
				machine.send('SET');
			}).toThrow(new Error('send: guards and updates must not send events'));
			expect(machine.getState()).toEqual({ value: 'a', context: 0 });
		});

		it('allows send again after a guard threw while nested in can', function () {
			const machine = createMachine({
				initial: 'a',
				states: {
					a: {
						on: {
							CHECK: {
								guard(): boolean {
									return machine.can('BAD');
								}
							},
							BAD: {
								guard() {
									throw new Error('bad');
								}
							},
							GO: 'b'
						}
					},
					b: {}
				}
			});

			expect(function () {
				machine.send('CHECK');
			}).toThrow('bad');
			machine.send('GO');
			expect(machine.getState().value).toBe('b');
		});

		it('validates events', function () {
			const machine = fetcher();
			for (const event of [undefined, null, 1, {}, { type: 1 }, Symbol('x')]) {
				expect(function () {
					machine.send(event as unknown as 'FETCH');
				}).toThrow(new TypeError(`send: \`event\` must be an event type or an object with a string \`type\`, got ${event === null ? 'null' : typeof event}`));
				expect(function () {
					machine.can(event as unknown as 'FETCH');
				}).toThrow(new TypeError(`can: \`event\` must be an event type or an object with a string \`type\`, got ${event === null ? 'null' : typeof event}`));
			}
			expect(function () {
				machine.subscribe(1 as unknown as () => void);
			}).toThrow(new TypeError('subscribe: `listener` must be a function, got number'));
		});

		it('validates the config when the machine is created', function () {
			const cases: Array<[unknown, Error]> = [
				[null, new TypeError('createMachine: `config` must be an object, got null')],
				['x', new TypeError('createMachine: `config` must be an object, got string')],
				[{ initial: 'a' }, new TypeError('createMachine: `config.states` must be an object, got undefined')],
				[{ initial: 'a', states: { a: null } }, new TypeError('createMachine: `config.states.a` must be an object, got null')],
				[{ initial: 'a', states: { a: { on: 1 } } }, new TypeError('createMachine: `config.states.a.on` must be an object, got number')],
				[
					{ initial: 'a', states: { a: { on: { GO: 1 } } } },
					new TypeError('createMachine: `config.states.a.on.GO` must be a state name or a transition object, got number')
				],
				[{ initial: 'a', states: { a: { on: { GO: 'b' } } } }, new RangeError('createMachine: `config.states.a.on.GO` must be the name of a state, got b')],
				[
					{ initial: 'a', states: { a: { on: { GO: { target: 'b' } } } } },
					new RangeError('createMachine: `config.states.a.on.GO.target` must be the name of a state, got b')
				],
				[
					{ initial: 'a', states: { a: { on: { GO: { target: 1 } } } } },
					new TypeError('createMachine: `config.states.a.on.GO.target` must be a state name, got number')
				],
				[
					{ initial: 'a', states: { a: { on: { GO: { guard: true } } } } },
					new TypeError('createMachine: `config.states.a.on.GO.guard` must be a function, got boolean')
				],
				[
					{ initial: 'a', states: { a: { on: { GO: { update: 'x' } } } } },
					new TypeError('createMachine: `config.states.a.on.GO.update` must be a function, got string')
				],
				[{ initial: 'z', states: { a: {} } }, new RangeError('createMachine: `config.initial` must be the name of a state, got z')],
				[{ initial: 'toString', states: { a: {} } }, new RangeError('createMachine: `config.initial` must be the name of a state, got toString')],
				[{ states: { a: {} } }, new TypeError('createMachine: `config.initial` must be a state name, got undefined')],
				[{ initial: 'a', states: {} }, new RangeError('createMachine: `config.initial` must be the name of a state, got a')]
			];
			for (const [config, error] of cases) {
				expect(function () {
					createMachine(config as Parameters<typeof createMachine>[0]);
				}).toThrow(error);
			}
		});

		it('reads the event type as an own property', function () {
			const machine = fetcher();
			const keys = Object.prototype as Record<string, unknown>;
			keys.type = 'FETCH';
			try {
				expect(function () {
					machine.send({} as 'FETCH');
				}).toThrow(new TypeError('send: `event` must be an event type or an object with a string `type`, got object'));
				expect(machine.getState().value).toBe('idle');
			} finally {
				delete keys.type;
			}
		});

		it('ignores a polluted Object.prototype', function () {
			const keys = Object.prototype as Record<string, unknown>;
			keys.on = { GO: 'b' };
			keys.context = 'polluted';
			keys.initial = 'b';
			keys.guard = function () {
				return false;
			};
			try {
				const machine = createMachine({ initial: 'a', states: { a: { on: { NEXT: { target: 'b' } } }, b: {} } } as never) as unknown as {
					send(event: string): void;
					getState(): MachineSnapshot<string, unknown>;
				};
				expect(machine.getState()).toEqual({ value: 'a', context: undefined });
				machine.send('GO');
				expect(machine.getState().value).toBe('a');
				machine.send('NEXT');
				expect(machine.getState().value).toBe('b');
			} finally {
				delete keys.on;
				delete keys.context;
				delete keys.initial;
				delete keys.guard;
			}
		});
	});

	describe('run-to-completion', function () {
		/**
		 * A traffic light whose listeners can react to transitions.
		 */
		function light() {
			return createMachine({
				initial: 'green',
				context: 0,
				states: {
					green: {
						on: {
							NEXT: {
								target: 'yellow',
								update(n) {
									return n + 1;
								}
							}
						}
					},
					yellow: {
						on: {
							NEXT: {
								target: 'red',
								update(n) {
									return n + 1;
								}
							}
						}
					},
					red: {
						on: {
							NEXT: {
								target: 'green',
								update(n) {
									return n + 1;
								}
							}
						}
					}
				}
			});
		}

		it('queues events sent by listeners until every listener has seen the current transition', function () {
			const machine = light();
			const log: string[] = [];
			machine.subscribe(function () {
				const { value } = machine.getState();
				log.push(`first:${value}`);
				if (value === 'yellow') {
					machine.send('NEXT');
					// Queued: not handled yet.
					log.push(`first:after-send:${machine.getState().value}`);
				}
			});
			machine.subscribe(function () {
				log.push(`second:${machine.getState().value}`);
			});

			machine.send('NEXT');
			expect(log).toEqual(['first:yellow', 'first:after-send:yellow', 'second:yellow', 'first:red', 'second:red']);
			expect(machine.getState()).toEqual({ value: 'red', context: 2 });
		});

		it('lets a listener send many events in reaction to one transition (only loops are capped)', function () {
			const machine = light();
			let reacted = false;
			machine.subscribe(function () {
				if (reacted) return;
				reacted = true;
				// 150 events, all but the first ignored by the state they reach... then the light goes round 50 times.
				for (let i = 0; i < 150; i++) machine.send('NEXT');
			});

			machine.send('NEXT');
			expect(machine.getState().context).toBe(151);
		});

		it('throws a RangeError when listeners fan out without end', function () {
			const machine = light();
			machine.subscribe(function () {
				machine.send('NEXT');
				machine.send('NEXT');
			});

			expect(function () {
				machine.send('NEXT');
			}).toThrow(new RangeError('send: listeners kept sending events (10000 events)'));
			machine.subscribe(function () {
				throw new Error('stop');
			});
		});

		it('keeps handling queued events after a listener throws, and rethrows afterwards', function () {
			const machine = light();
			machine.subscribe(function () {
				if (machine.matches('yellow')) machine.send('NEXT');
			});
			machine.subscribe(function () {
				throw new Error(machine.getState().value);
			});

			let caught: unknown;
			try {
				machine.send('NEXT');
			} catch (error) {
				caught = error;
			}
			expect(machine.getState().value).toBe('red');
			expect(caught).toBeInstanceOf(AggregateError);
			expect((caught as AggregateError).errors).toEqual([new Error('yellow'), new Error('red')]);
			expect((caught as AggregateError).message).toBe('send: 2 events threw');

			expect(function () {
				machine.send('NEXT');
			}).toThrow(new Error('green'));
		});

		it('throws a RangeError instead of looping forever, keeping earlier errors as the cause, and stays usable', function () {
			const machine = light();
			let forever = true;
			let thrown = false;
			const unsubscribe = machine.subscribe(function () {
				if (forever) machine.send('NEXT');
				if (!thrown) {
					thrown = true;
					throw new Error('first');
				}
			});

			let caught: unknown;
			try {
				machine.send('NEXT');
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RangeError);
			expect((caught as RangeError).message).toBe('send: listeners kept sending events (100 consecutive rounds)');
			expect((caught as RangeError).cause).toEqual(new Error('first'));
			expect(machine.getState().context).toBe(100);

			forever = false;
			machine.send('NEXT');
			expect(machine.getState().context).toBe(101);
			unsubscribe();

			const quiet = light();
			quiet.subscribe(function () {
				quiet.send('NEXT');
			});
			let quietError: unknown;
			try {
				quiet.send('NEXT');
			} catch (error) {
				quietError = error;
			}
			expect(quietError).toEqual(new RangeError('send: listeners kept sending events (100 consecutive rounds)'));
			expect(Object.hasOwn(quietError as RangeError, 'cause')).toBe(false);

			const noisy = light();
			noisy.subscribe(function () {
				noisy.send('NEXT');
				if (noisy.getState().context % 40 === 0) throw new Error(String(noisy.getState().context));
			});
			expect(function () {
				noisy.send('NEXT');
			}).toThrow(expect.objectContaining({ cause: expect.objectContaining({ message: 'send: 2 events threw', errors: [new Error('40'), new Error('80')] }) }));
		});
	});
});

/**
 * A store of another library that notifies its listeners only when `flush()` is called (so the history sees each change late), may
 * transform the states it is given (as a store that clamps or normalizes would), and counts its live subscriptions.
 * @param {number} initialState - The initial state
 * @param {(next: number) => number} [transform] - Applied to every state set
 * @returns {HistorySource<number> & { flush(): void; subscriptions(): number; unsubscribes(): number }} The store
 */
function lateStore(
	initialState: number,
	transform: (next: number) => number = function (next) {
		return next;
	}
): HistorySource<number> & { flush(): void; subscriptions(): number; unsubscribes(): number } {
	let state = initialState;
	let dirty = false;
	let unsubscribes = 0;
	const listeners = new Set<() => void>();
	return {
		getState(): number {
			return state;
		},
		setState(next: number | ((prev: number) => number)): void {
			state = transform(typeof next === 'function' ? next(state) : next);
			dirty = true;
		},
		subscribe(listener: () => void): () => void {
			// A subscription of its own, so that subscribing the same listener twice makes two subscriptions.
			function subscription(): void {
				listener();
			}
			listeners.add(subscription);
			return function (): void {
				unsubscribes++;
				listeners.delete(subscription);
			};
		},
		flush(): void {
			if (!dirty) return;
			dirty = false;
			for (const listener of [...listeners]) listener();
		},
		subscriptions(): number {
			return listeners.size;
		},
		unsubscribes(): number {
			return unsubscribes;
		}
	};
}

describe('createHistory', function () {
	describe('undo / redo', function () {
		it('undoes and redoes changes, publishing its status', function () {
			const store = createStore(0);
			const history = createHistory(store);
			const initialStatus = history.getState();

			expect(initialStatus).toEqual({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
			expect(history.undo()).toBe(false);
			expect(history.redo()).toBe(false);
			expect(history.getState()).toBe(initialStatus);

			store.setState(1);
			store.setState(2);
			store.setState(3);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 3, redoCount: 0 });

			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(true);
			expect(store.getState()).toBe(1);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 2 });

			expect(history.redo()).toBe(true);
			expect(store.getState()).toBe(2);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(false);
			expect(store.getState()).toBe(0);
			expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 3 });
		});

		it('clears the redo steps on a new change, and never records its own writes', function () {
			const store = createStore('a');
			const history = createHistory(store);
			const seen: string[] = [];
			store.subscribe(function () {
				seen.push(store.getState());
			});

			store.setState('b');
			store.setState('c');
			history.undo();
			store.setState('d');
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });
			expect(history.redo()).toBe(false);
			history.undo();
			history.undo();
			expect(store.getState()).toBe('a');
			expect(seen).toEqual(['b', 'c', 'b', 'd', 'b', 'a']);
		});

		it('restores the exact references, function states included, without calling them', function () {
			function first(): number {
				return 1;
			}
			function second(): number {
				return 2;
			}
			const objects = [{ id: 1 }, { id: 2 }];
			const fns = createStore<() => number>(first);
			const fnHistory = createHistory(fns);
			const store = createStore(objects[0]);
			const history = createHistory(store);

			fns.setState(function () {
				return second;
			});
			fnHistory.undo();
			expect(fns.getState()).toBe(first);
			fnHistory.redo();
			expect(fns.getState()).toBe(second);

			store.setState(objects[1]);
			history.undo();
			expect(store.getState()).toBe(objects[0]);
		});

		it('records no step for states the store deems equal, and stays consistent when it keeps an equal state', function () {
			const store = createStore({ n: 0 }, { equals: isEqual });
			const history = createHistory(store);

			store.setState({ n: 0 });
			expect(history.getState().undoCount).toBe(0);
			store.setState({ n: 1 });
			store.setState({ n: 2 });
			history.undo();
			expect(store.getState()).toEqual({ n: 1 });
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
		});

		it('attaches what listeners change in reaction to undo/redo to the restored step, keeping the redo steps', function () {
			const capped = createStore(0);
			const cappedHistory = createHistory(capped);
			capped.setState(20);
			capped.subscribe(function () {
				if (capped.getState() > 10) capped.setState(10);
			});
			capped.setState(5);
			// Restoring 20 makes the listener cap it to 10: part of the restored step, not a new change.
			cappedHistory.undo();
			expect(capped.getState()).toBe(10);
			expect(cappedHistory.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
			cappedHistory.undo();
			expect(capped.getState()).toBe(0);
			cappedHistory.redo();
			expect(capped.getState()).toBe(10);
			cappedHistory.redo();
			expect(capped.getState()).toBe(5);
			expect(cappedHistory.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });

			const store = createStore(0);
			// Subscribed before the history, so that the history sees the normalized states only.
			store.subscribe(function () {
				// Keeps the state even.
				if (store.getState() % 2 !== 0) store.setState(store.getState() + 1);
			});
			const history = createHistory(store);

			store.setState(2);
			store.setState(4);
			store.setState(1);
			expect(store.getState()).toBe(2);
			expect(history.getState().undoCount).toBe(3);
			history.undo();
			expect(store.getState()).toBe(4);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 2, redoCount: 1 });
		});

		it('records a change and what later-subscribed listeners derive from it as one step, and can always undo it', function () {
			const editor = createStore({ text: '', upper: '' });
			const history = createHistory(editor);
			// Subscribed after the history: keeps a derived field up to date.
			editor.subscribe(function () {
				const { text, upper } = editor.getState();
				if (upper !== text.toUpperCase()) editor.setState({ text, upper: text.toUpperCase() });
			});

			editor.setState({ ...editor.getState(), text: 'a' });
			editor.setState({ ...editor.getState(), text: 'ab' });
			expect(editor.getState()).toEqual({ text: 'ab', upper: 'AB' });
			expect(history.getState().undoCount).toBe(2);

			expect(history.undo()).toBe(true);
			expect(editor.getState()).toEqual({ text: 'a', upper: 'A' });
			expect(history.undo()).toBe(true);
			expect(editor.getState()).toEqual({ text: '', upper: '' });
			expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 2 });
			expect(history.redo()).toBe(true);
			expect(history.redo()).toBe(true);
			expect(editor.getState()).toEqual({ text: 'ab', upper: 'AB' });
		});

		it('reads its options as own properties only', function () {
			const polluted = Object.prototype as Record<string, unknown>;
			polluted.limit = 1;
			polluted.coalesce = 1e9;
			try {
				const store = createStore(0);
				const history = createHistory(store);
				store.setState(1);
				store.setState(2);
				store.setState(3);
				expect(history.getState().undoCount).toBe(3);
			} finally {
				delete polluted.limit;
				delete polluted.coalesce;
			}
			expect(function () {
				createHistory(createStore(0), null as unknown as object);
			}).toThrow(new TypeError('createHistory: `options` must be an object, got null'));
		});

		it('keeps a batch run by a listener in the step of the change that triggered it, before or after the history', function () {
			for (const first of [true, false]) {
				const store = createStore({ v: 0, a: 0, b: 0 });
				let history = first ? createHistory(store) : undefined;
				store.subscribe(function () {
					const state = store.getState();
					if (state.a === state.v * 2) return;
					(history as StoreHistory).batch(function () {
						store.setState({ ...store.getState(), a: state.v * 2 });
						store.setState({ ...store.getState(), b: state.v * 3 });
					});
				});
				history = history ?? createHistory(store);

				store.setState({ ...store.getState(), v: 1 });
				expect(store.getState()).toEqual({ v: 1, a: 2, b: 3 });
				expect(history.getState().undoCount).toBe(1);
				expect(history.undo()).toBe(true);
				expect(store.getState()).toEqual({ v: 0, a: 0, b: 0 });
				expect(history.redo()).toBe(true);
				expect(store.getState()).toEqual({ v: 1, a: 2, b: 3 });
				expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 });
			}
			const counter = createStore(0);
			const history = createHistory(counter);
			counter.subscribe(function () {
				history.batch(function () {
					return Promise.resolve();
				});
			});
			expect(function () {
				counter.setState(1);
			}).toThrow('batch: `fn` must be synchronous');
		});

		it('keeps restoring until the notification ends when undo is called by a listener', function () {
			const store = createStore(0);
			const history = createHistory(store);
			let undone = false;
			store.subscribe(function () {
				if (store.getState() === 2 && !undone) {
					undone = true;
					history.undo();
				}
			});
			// Subscribed last: reacts to the restored state in a later round of the same notification.
			store.subscribe(function () {
				if (store.getState() === 1) store.setState(-1);
			});

			store.setState(1);
			expect(store.getState()).toBe(-1);
			store.setState(2);
			// The undo restored -1 (the step before 2); nothing derived from it.
			expect(store.getState()).toBe(-1);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
			expect(history.redo()).toBe(true);
			expect(store.getState()).toBe(2);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(true);
			expect(store.getState()).toBe(0);
		});

		it('attaches synchronous reactions to undo of other stores to the restored step', function () {
			let state = 0;
			const listeners: Array<() => void> = [];
			const source: HistorySource<number> = {
				getState(): number {
					return state;
				},
				setState(next: number | ((prev: number) => number)): void {
					state = typeof next === 'function' ? next(state) : next;
					for (const listener of listeners.slice()) listener();
				},
				subscribe(listener: () => void): () => void {
					listeners.push(listener);
					return function (): void {
						listeners.splice(listeners.indexOf(listener), 1);
					};
				}
			};
			const history = createHistory(source);
			source.subscribe(function () {
				if (state > 10) source.setState(10);
			});

			source.setState(20);
			// Other stores do not tell when a notification ends: the capping is a step of its own.
			expect(history.getState().undoCount).toBe(2);
			// Restoring 20 is capped again, synchronously: part of the restored step, which keeps the redo step.
			history.undo();
			expect(state).toBe(10);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
			history.undo();
			expect(state).toBe(0);
			expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 2 });
		});

		it('leaves the steps in place when the store refuses the state during undo or redo', function () {
			let fail = false;
			const store = createStore(
				{ n: 0 },
				{
					equals(a: { n: number }, b: { n: number }): boolean {
						if (fail) throw new Error('equals');
						return a.n === b.n;
					}
				}
			);
			const history = createHistory(store, { limit: 2 });
			store.setState({ n: 1 });
			store.setState({ n: 2 });
			history.undo();
			const before = history.getState();

			fail = true;
			expect(function () {
				history.undo();
			}).toThrow('equals');
			expect(function () {
				history.redo();
			}).toThrow('equals');
			expect(history.getState()).toBe(before);
			fail = false;
			expect(history.undo()).toBe(true);
			expect(store.getState()).toEqual({ n: 0 });
			expect(history.redo()).toBe(true);
			expect(history.redo()).toBe(true);
			expect(store.getState()).toEqual({ n: 2 });
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });

			let refuse = false;
			const plain = createStore(0);
			const guarded: HistorySource<number> = {
				getState: plain.getState,
				subscribe: plain.subscribe,
				setState(next: number | ((prev: number) => number)): void {
					if (refuse) throw new Error('read-only');
					plain.setState(next);
				}
			};
			const guardedHistory = createHistory(guarded, { limit: 1 });
			plain.setState(1);
			plain.setState(2);
			guardedHistory.undo();
			refuse = true;
			expect(function () {
				guardedHistory.redo();
			}).toThrow('read-only');
			expect(guardedHistory.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });
			refuse = false;
			guardedHistory.redo();
			expect(plain.getState()).toBe(2);
			guardedHistory.undo();
			expect(plain.getState()).toBe(1);
		});

		it('records a pending change before undoing when called by a listener notified earlier', function () {
			const store = createStore(0);
			const calls: number[] = [];
			const later: Array<ReturnType<typeof createHistory>> = [];
			let undone = false;
			store.subscribe(function () {
				calls.push(store.getState());
				if (store.getState() === 2 && !undone) {
					undone = true;
					later[0].undo();
				}
			});
			const history = createHistory(store);
			later.push(history);

			store.setState(1);
			store.setState(2);
			expect(store.getState()).toBe(1);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
			history.redo();
			expect(store.getState()).toBe(2);
			expect(calls).toEqual([1, 2, 1, 2]);
		});

		it('records a pending change before redo or clear when called by a listener notified earlier', function () {
			const store = createStore(0);
			const commands: Array<() => unknown> = [];
			store.subscribe(function () {
				commands.shift()?.();
			});
			const history = createHistory(store);

			store.setState(1);
			store.setState(2);
			history.undo();
			// The listener redoes while the change to 3 is still being notified: that change clears the redo steps first.
			commands.push(function () {
				return history.redo();
			});
			store.setState(3);
			expect(store.getState()).toBe(3);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });

			// Clearing while the change to 4 is being notified forgets that change's step too.
			commands.push(function () {
				history.clear();
			});
			store.setState(4);
			expect(history.getState()).toEqual({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
			store.setState(5);
			history.undo();
			expect(store.getState()).toBe(4);
		});

		it('keeps its state consistent when a store listener throws during undo', function () {
			const store = createStore(0);
			const history = createHistory(store);
			store.setState(1);
			store.subscribe(function () {
				throw new Error('listener');
			});

			expect(function () {
				history.undo();
			}).toThrow('listener');
			expect(store.getState()).toBe(0);
			expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });
		});

		it('works with class-based stores (methods called on the store) and listeners receiving arguments', function () {
			class Counter implements HistorySource<number> {
				private value = 0;
				private listeners: Array<(state: number) => void> = [];
				getState(): number {
					return this.value;
				}
				setState(next: number | ((prev: number) => number)): void {
					this.value = typeof next === 'function' ? next(this.value) : next;
					for (const listener of this.listeners) listener(this.value);
				}
				subscribe(listener: () => void): () => void {
					this.listeners.push(listener);
					return this.unsubscribe.bind(this, listener);
				}
				private unsubscribe(listener: () => void): void {
					this.listeners = this.listeners.filter(function (l) {
						return l !== listener;
					});
				}
			}
			const counter = new Counter();
			const history = createHistory(counter);

			counter.setState(5);
			history.undo();
			expect(counter.getState()).toBe(0);
			history.dispose();
			counter.setState(6);
			expect(history.getState().undoCount).toBe(0);
		});
	});

	describe('stores that notify later', function () {
		it('records a change seen late as one step, before a batch and after it', function () {
			const store = lateStore(0);
			const history = createHistory(store);

			store.setState(1);
			// Not notified yet: the batch records it first, as its own step.
			history.batch(function () {
				store.setState(2);
				store.setState(3);
			});
			expect(history.getState().undoCount).toBe(2);
			store.flush();
			expect(history.getState().undoCount).toBe(2);
			history.undo();
			expect(store.getState()).toBe(1);
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('attaches what the store changes while restoring to the restored step', function () {
			let max = 100;
			const store = lateStore(0, function (next) {
				return Math.min(next, max);
			});
			const history = createHistory(store);

			store.setState(50);
			store.flush();
			store.setState(80);
			store.flush();
			// The store now clamps what it is given: restoring 50, then 80, sets 10 instead.
			max = 10;
			history.undo();
			store.flush();
			expect(store.getState()).toBe(10);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 });
			history.redo();
			store.flush();
			expect(store.getState()).toBe(10);
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 });
			history.undo();
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('unsubscribes once when disposed', function () {
			const store = lateStore(0);
			const history = createHistory(store);
			expect(store.subscriptions()).toBe(1);

			history.dispose();
			history.dispose();
			expect(store.subscriptions()).toBe(0);
			expect(store.unsubscribes()).toBe(1);
		});
	});

	describe('limit', function () {
		it('forgets the oldest steps beyond the limit', function () {
			const store = createStore(0);
			const history = createHistory(store, { limit: 3 });

			for (let i = 1; i <= 100; i++) store.setState(i);
			expect(history.getState().undoCount).toBe(3);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(true);
			expect(history.undo()).toBe(false);
			expect(store.getState()).toBe(97);
			expect(history.redo()).toBe(true);
			expect(history.redo()).toBe(true);
			expect(history.redo()).toBe(true);
			expect(store.getState()).toBe(100);
		});

		it('keeps `limit` steps after an undo, while dropped steps are waiting to be compacted', function () {
			const store = createStore(0);
			const history = createHistory(store, { limit: 3 });

			for (let i = 1; i <= 4; i++) store.setState(i);
			history.undo();
			store.setState(5);
			expect(history.getState().undoCount).toBe(3);
			for (const expected of [3, 2, 1]) {
				history.undo();
				expect(store.getState()).toBe(expected);
			}
			expect(history.undo()).toBe(false);
		});

		it('keeps the limit across redo', function () {
			const store = createStore(0);
			const history = createHistory(store, { limit: 1 });

			store.setState(1);
			store.setState(2);
			history.undo();
			expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });
			history.redo();
			expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoCount: 1, redoCount: 0 });
			history.undo();
			expect(store.getState()).toBe(1);
		});
	});

	describe('batch and coalesce', function () {
		it('records every change of a batch as one step, nested batches included, and returns its result', function () {
			const store = createStore(0);
			const history = createHistory(store);

			store.setState(1);
			const result = history.batch(function () {
				store.setState(2);
				history.batch(function () {
					store.setState(3);
				});
				store.setState(4);
				return 'done';
			});
			store.setState(5);
			expect(result).toBe('done');
			expect(history.getState().undoCount).toBe(3);
			history.undo();
			expect(store.getState()).toBe(4);
			history.undo();
			expect(store.getState()).toBe(1);
		});

		it('records nothing for a batch without changes, and still records when the batch throws', function () {
			const store = createStore(0);
			const history = createHistory(store);

			history.batch(function () {});
			expect(history.getState().undoCount).toBe(0);
			expect(function () {
				history.batch(function () {
					store.setState(1);
					store.setState(2);
					throw new Error('stop');
				});
			}).toThrow('stop');
			expect(history.getState().undoCount).toBe(1);
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('starts a new step after an undo within a batch', function () {
			const store = createStore(0);
			const history = createHistory(store);

			store.setState(1);
			history.batch(function () {
				store.setState(2);
				history.undo();
				store.setState(3);
				store.setState(4);
			});
			expect(store.getState()).toBe(4);
			history.undo();
			expect(store.getState()).toBe(1);
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('merges changes made within `coalesce` milliseconds of the previous one', function () {
			let now = 1000;
			jest.spyOn(Date, 'now').mockImplementation(function () {
				return now;
			});
			const store = createStore('');
			const history = createHistory(store, { coalesce: 500 });

			for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
				store.setState(text);
				now += 100;
			}
			now += 1000;
			store.setState('hello!');
			expect(history.getState().undoCount).toBe(2);
			history.undo();
			expect(store.getState()).toBe('hello');
			// The step after an undo is never merged into an older one.
			store.setState('hello?');
			history.undo();
			expect(store.getState()).toBe('hello');
			history.undo();
			expect(store.getState()).toBe('');
		});

		it('uses the injected clock, and never merges when it goes backwards', function () {
			let time = 1000;
			const store = createStore(0);
			const history = createHistory(store, {
				coalesce: 500,
				now(): number {
					return time;
				}
			});

			store.setState(1);
			time += 100;
			store.setState(2);
			expect(history.getState().undoCount).toBe(1);
			// A wall-clock adjustment backwards: a new step.
			time -= 3600_000;
			store.setState(3);
			expect(history.getState().undoCount).toBe(2);
			time += 100;
			store.setState(4);
			expect(history.getState().undoCount).toBe(2);
		});

		it('does not read the clock without coalesce, and validates it', function () {
			const now = jest.fn(function () {
				return 0;
			});
			const store = createStore(0);
			createHistory(store, { now });
			store.setState(1);
			expect(now).not.toHaveBeenCalled();

			expect(function () {
				createHistory(store, { now: 5 as unknown as () => number });
			}).toThrow(new TypeError('createHistory: `options.now` must be a function, got number'));
			for (const [value, shown] of [
				[NaN, 'NaN'],
				['1', 'string']
			] as const) {
				const broken = createStore(0);
				createHistory(broken, {
					coalesce: 1,
					now(): number {
						return value as number;
					}
				});
				expect(function () {
					broken.setState(1);
				}).toThrow(new TypeError(`createHistory: \`now()\` must return a number, got ${shown}`));
			}
		});

		it('leaves no step for a batch or a burst that ends where it started', function () {
			let time = 0;
			const store = createStore(0);
			const history = createHistory(store, {
				coalesce: 100,
				now(): number {
					return time;
				}
			});

			history.batch(function () {
				store.setState(1);
				store.setState(0);
				store.setState(2);
			});
			expect(history.getState().undoCount).toBe(1);
			time = 1000;
			store.setState(3);
			time += 10;
			store.setState(2);
			expect(history.getState().undoCount).toBe(1);
			// The burst is over: the next change starts a step, even within the window.
			time += 10;
			store.setState(5);
			expect(history.getState().undoCount).toBe(2);
			history.undo();
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('starts a new step after clear() within a batch', function () {
			const store = createStore(0);
			const history = createHistory(store);

			history.batch(function () {
				store.setState(1);
				history.clear();
				store.setState(2);
				store.setState(3);
			});
			expect(history.getState().undoCount).toBe(1);
			history.undo();
			expect(store.getState()).toBe(1);
		});

		it('merges changes made at the same instant, and never merges a change into the step of the batch before it', function () {
			let time = 100;
			const now = jest.fn(function (): number {
				return time;
			});
			const store = createStore(0);
			const history = createHistory(store, { coalesce: 500, now });

			store.setState(1);
			store.setState(2);
			expect(history.getState().undoCount).toBe(1);
			now.mockClear();
			history.batch(function () {
				store.setState(3);
				store.setState(4);
			});
			// Changes of a batch are merged without reading the clock.
			expect(now).not.toHaveBeenCalled();
			expect(history.getState().undoCount).toBe(2);
			time += 1;
			store.setState(5);
			expect(history.getState().undoCount).toBe(3);
			history.undo();
			expect(store.getState()).toBe(4);
			history.undo();
			expect(store.getState()).toBe(2);
		});

		it('rejects asynchronous batch functions', function () {
			const store = createStore(0);
			const history = createHistory(store);

			expect(function () {
				history.batch(function () {
					store.setState(1);
					return Promise.resolve();
				});
			}).toThrow(new TypeError('batch: `fn` must be synchronous, got a function returning a thenable'));
			// The synchronous part was recorded.
			expect(history.getState().undoCount).toBe(1);
			expect(
				history.batch(function () {
					return { then: 1 };
				})
			).toEqual({ then: 1 });
			for (const value of [null, undefined, 0, '', false]) {
				expect(
					history.batch(function () {
						return value;
					})
				).toBe(value);
			}
			expect(function () {
				history.batch(function () {
					return Object.assign(function () {}, {
						then(): void {}
					});
				});
			}).toThrow(TypeError);
		});

		it('rethrows the errors of its own subscribers from the store change, keeping the step', function () {
			const store = createStore(0);
			const history = createHistory(store);
			history.subscribe(function () {
				throw new Error('subscriber');
			});

			expect(function () {
				store.setState(1);
			}).toThrow('subscriber');
			expect(store.getState()).toBe(1);
			expect(history.getState().undoCount).toBe(1);
		});

		it('records the final state when the store gives up on a notification loop', function () {
			const store = createStore(0);
			const history = createHistory(store);
			let looping = true;
			store.subscribe(function () {
				if (looping) store.setState(store.getState() + 1);
			});

			expect(function () {
				store.setState(1);
			}).toThrow(RangeError);
			looping = false;
			expect(store.getState()).toBe(101);
			expect(history.getState().undoCount).toBe(1);
			history.undo();
			expect(store.getState()).toBe(0);
		});

		it('validates the batch function', function () {
			const history = createHistory(createStore(0));
			expect(function () {
				history.batch(null as unknown as () => void);
			}).toThrow(new TypeError('batch: `fn` must be a function, got null'));
		});
	});

	describe('clear, dispose and subscriptions', function () {
		it('clears every step, keeping the state', function () {
			const store = createStore(0);
			const history = createHistory(store);

			store.setState(1);
			store.setState(2);
			history.undo();
			history.clear();
			expect(store.getState()).toBe(1);
			expect(history.getState()).toEqual({ canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
			store.setState(2);
			history.undo();
			expect(store.getState()).toBe(1);
		});

		it('stops recording and releases the store when disposed', function () {
			const store = createStore(0);
			const subscribe = jest.spyOn(store, 'subscribe');
			const history = createHistory(store);
			const unsubscribe = subscribe.mock.results[0].value as jest.Mock;
			expect(unsubscribe).toEqual(expect.any(Function));

			store.setState(1);
			history.dispose();
			history.dispose();
			expect(history.getState().undoCount).toBe(0);
			store.setState(2);
			expect(history.undo()).toBe(false);
			expect(history.redo()).toBe(false);
			expect(store.getState()).toBe(2);
		});

		it('no longer references the states once disposed', async function () {
			setFlagsFromString('--expose-gc');
			const gc = runInNewContext('gc') as () => void;
			const store = createStore<object>({ id: 0 });
			const history = createHistory(store);
			let refs: Array<WeakRef<object>> = [];
			(function () {
				const states = [{ id: 1 }, { id: 2 }, { id: 3 }];
				refs = states.map(function (state) {
					return new WeakRef(state);
				});
				store.setState(states[0]);
				store.setState(states[1]);
				history.undo();
				store.setState(states[2]);
			})();
			history.dispose();
			// The store moves on: only the history could still hold the states (the initial one is kept by the store, for `reset`).
			store.setState({ id: 4 });
			await new Promise(function (resolve) {
				setTimeout(resolve, 0);
			});
			gc();
			expect(
				refs.map(function (ref) {
					return ref.deref();
				})
			).toEqual([undefined, undefined, undefined]);
		});

		it('notifies its subscribers only when a count changes', function () {
			const store = createStore(0);
			const history = createHistory(store, { limit: 1 });
			const canUndo = history.select(function (status) {
				return status.canUndo;
			});
			const listener = jest.fn();
			const canUndoListener = jest.fn();
			history.subscribe(listener);
			canUndo.subscribe(canUndoListener);

			store.setState(1);
			store.setState(2);
			store.setState(3);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(canUndoListener).toHaveBeenCalledTimes(1);
			history.clear();
			history.clear();
			expect(listener).toHaveBeenCalledTimes(2);
		});

		it('validates its arguments', function () {
			const store = createStore(0);
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return createHistory(null as unknown as Store<number>);
					},
					new TypeError('createHistory: `store` must be a store, got null')
				],
				[
					function () {
						return createHistory({ ...store, getState: 1 } as unknown as Store<number>);
					},
					new TypeError('createHistory: `store.getState` must be a function, got number')
				],
				[
					function () {
						return createHistory({ ...store, setState: undefined } as unknown as Store<number>);
					},
					new TypeError('createHistory: `store.setState` must be a function, got undefined')
				],
				[
					function () {
						return createHistory({ ...store, subscribe: 'x' } as unknown as Store<number>);
					},
					new TypeError('createHistory: `store.subscribe` must be a function, got string')
				],
				[
					function () {
						return createHistory({
							...store,
							subscribe() {
								return undefined;
							}
						} as unknown as Store<number>);
					},
					new TypeError('createHistory: `store.subscribe()` must be a function, got undefined')
				],
				[
					function () {
						return createHistory(store, { limit: 0 });
					},
					new RangeError('createHistory: `options.limit` must be an integer >= 1 or Infinity, got 0')
				],
				[
					function () {
						return createHistory(store, { limit: 1.5 });
					},
					new RangeError('createHistory: `options.limit` must be an integer >= 1 or Infinity, got 1.5')
				],
				[
					function () {
						return createHistory(store, { limit: '3' as unknown as number });
					},
					new TypeError('createHistory: `options.limit` must be an integer >= 1 or Infinity, got string')
				],
				[
					function () {
						return createHistory(store, { coalesce: -1 });
					},
					new RangeError('createHistory: `options.coalesce` must be a number >= 0, got -1')
				],
				[
					function () {
						return createHistory(store, { coalesce: NaN });
					},
					new RangeError('createHistory: `options.coalesce` must be a number >= 0, got NaN')
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
		});
	});
});

/**
 * Wraps a store, counting its live subscriptions.
 */
function spied<S>(store: ReadonlyStore<S>): ReadonlyStore<S> & { live(): number } {
	let live = 0;
	return {
		getState: store.getState,
		select: store.select,
		subscribe(listener: () => void): Unsubscribe {
			const unsubscribe = store.subscribe(listener);
			live++;
			let active = true;
			return function (): void {
				if (!active) return;
				active = false;
				live--;
				unsubscribe();
			};
		},
		live(): number {
			return live;
		}
	};
}

describe('batch', function () {
	it('notifies each changed store once, after fn, in the order of their first change, with the states already set', function () {
		const a = createStore(0);
		const b = createStore(0);
		const c = createStore(0);
		const seen: string[] = [];
		for (const [name, store] of [
			['a', a],
			['b', b],
			['c', c]
		] as const) {
			store.subscribe(function () {
				seen.push(`${name}:${a.getState()}${b.getState()}${c.getState()}`);
			});
		}

		const result = batch(function () {
			b.setState(1);
			a.setState(1);
			b.setState(2);
			expect([a.getState(), b.getState()]).toEqual([1, 2]);
			expect(seen).toEqual([]);
			return 'done';
		});
		expect(result).toBe('done');
		expect(seen).toEqual(['b:120', 'a:120']);
		// Outside a batch, notifications are immediate again.
		c.setState(1);
		expect(seen).toEqual(['b:120', 'a:120', 'c:121']);
	});

	it('nests: only the outermost batch releases the notifications', function () {
		const store = createStore(0);
		const listener = jest.fn();
		store.subscribe(listener);
		batch(function () {
			batch(function () {
				store.setState(1);
			});
			expect(listener).not.toHaveBeenCalled();
			store.setState(2);
		});
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('makes derived stores, machines and histories see one change', function () {
		const price = createStore(10);
		const quantity = createStore(1);
		const total = computed([price, quantity], function (p, q) {
			return p * q;
		});
		const totals: number[] = [];
		total.subscribe(function () {
			totals.push(total.getState());
		});
		const history = createHistory(price);
		batch(function () {
			price.setState(20);
			quantity.setState(3);
			price.setState(30);
		});
		expect(totals).toEqual([90]);
		expect(history.getState().undoCount).toBe(1);
		history.undo();
		expect(price.getState()).toBe(10);

		const toggle = createMachine({ initial: 'off', states: { off: { on: { FLIP: 'on' } }, on: { on: { FLIP: 'off' } } } });
		const values: string[] = [];
		toggle.subscribe(function () {
			values.push(toggle.getState().value);
		});
		batch(function () {
			toggle.send('FLIP');
			toggle.send('FLIP');
			toggle.send('FLIP');
		});
		expect(values).toEqual(['on']);
	});

	it('notifies a store changed by the listener of another held-back store once', function () {
		const a = createStore(0);
		const b = createStore(0);
		a.subscribe(function () {
			b.setState(a.getState() * 10);
		});
		const seen: number[] = [];
		b.subscribe(function () {
			seen.push(b.getState());
		});
		batch(function () {
			a.setState(1);
			b.setState(5);
		});
		expect(seen).toEqual([10]);
	});

	it('works from a listener: the changes join the running notification', function () {
		const store = createStore(0);
		const other = createStore(0);
		const seen: number[] = [];
		store.subscribe(function () {
			if (store.getState() === 1)
				batch(function () {
					store.setState(2);
					other.setState(2);
				});
		});
		store.subscribe(function () {
			seen.push(store.getState());
		});
		const otherListener = jest.fn();
		other.subscribe(otherListener);
		store.setState(1);
		expect(seen).toEqual([2, 2]);
		expect(otherListener).toHaveBeenCalledTimes(1);
	});

	it('still notifies when fn throws, then rethrows every error, fn first', function () {
		const store = createStore(0);
		const other = createStore(0);
		store.subscribe(function () {
			throw new Error('listener');
		});
		const listener = jest.fn();
		other.subscribe(listener);
		expect(function () {
			batch(function () {
				other.setState(1);
				throw new Error('fn');
			});
		}).toThrow(new Error('fn'));
		expect(listener).toHaveBeenCalledTimes(1);

		let caught: unknown;
		try {
			batch(function () {
				store.setState(1);
				other.setState(2);
				throw new Error('fn');
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toEqual(new AggregateError([new Error('fn'), new Error('listener')], 'batch: 2 errors'));
		expect((caught as AggregateError).errors).toEqual([new Error('fn'), new Error('listener')]);
		expect(listener).toHaveBeenCalledTimes(2);
		// The batch is over: notifications are immediate again.
		other.setState(3);
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it('rethrows a listener error after notifying every store, when fn itself succeeds', function () {
		const store = createStore(0);
		const other = createStore(0);
		store.subscribe(function () {
			throw new Error('listener');
		});
		const listener = jest.fn();
		other.subscribe(listener);
		expect(function () {
			batch(function () {
				store.setState(1);
				other.setState(1);
			});
		}).toThrow(new Error('listener'));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('rejects non-functions and asynchronous functions, after notifying', function () {
		expect(function () {
			batch(5 as never);
		}).toThrow(new TypeError('batch: `fn` must be a function, got number'));
		const store = createStore(0);
		const listener = jest.fn();
		store.subscribe(listener);
		expect(function () {
			batch(function () {
				store.setState(1);
				return Promise.resolve();
			});
		}).toThrow(new TypeError('batch: `fn` must be synchronous, got a function returning a thenable'));
		expect(listener).toHaveBeenCalledTimes(1);
		for (const value of [null, undefined, 0, '']) {
			expect(
				batch(function () {
					return value;
				})
			).toBe(value);
		}
	});
});

describe('computed', function () {
	it('combines several stores, in order, and recomputes only when a source state changes', function () {
		const a = createStore(2);
		const b = createStore('x');
		const compute = jest.fn(function (n: number, s: string): string {
			return s.repeat(n);
		});
		const view = computed([a, b], compute);
		expect(compute).not.toHaveBeenCalled();
		expect(view.getState()).toBe('xx');
		expect(view.getState()).toBe('xx');
		expect(compute).toHaveBeenCalledTimes(1);
		b.setState('y');
		expect(view.getState()).toBe('yy');
		a.setState(3);
		expect(view.getState()).toBe('yyy');
		expect(compute).toHaveBeenCalledTimes(3);
		expect(compute).toHaveBeenLastCalledWith(3, 'y');
	});

	it('accepts a single store, and an empty array (a constant)', function () {
		const a = createStore({ n: 1 });
		const n = computed(a, function (state) {
			return state.n * 10;
		});
		expect(n.getState()).toBe(10);
		const constant = computed([], function () {
			return { fixed: true };
		});
		expect(constant.getState()).toBe(constant.getState());
		const seen: unknown[] = [];
		const unsubscribe = constant.subscribe(function () {
			seen.push(1);
		});
		unsubscribe();
		expect(seen).toEqual([]);
	});

	it('keeps the same reference while the result is equal, and notifies only on changes', function () {
		const list = createStore([1, 2, 3]);
		const threshold = createStore(2);
		const above = computed(
			[list, threshold],
			function (items, min) {
				return items.filter(function (item) {
					return item > min;
				});
			},
			{ equals: isEqual }
		);
		const first = above.getState();
		const seen: number[][] = [];
		above.subscribe(function () {
			seen.push(above.getState());
		});
		list.setState([1, 2, 3, 0]);
		expect(above.getState()).toBe(first);
		threshold.setState(1);
		expect(seen).toEqual([[2, 3]]);
		list.setState([5]);
		expect(seen).toEqual([[2, 3], [5]]);
	});

	it('subscribes to its sources only while it has subscribers', function () {
		const a = spied(createStore(1));
		const b = spied(createStore(2));
		const sum = computed([a, b], function (x, y) {
			return x + y;
		});
		expect(sum.getState()).toBe(3);
		expect(a.live() + b.live()).toBe(0);
		const stop1 = sum.subscribe(function () {});
		const stop2 = sum.subscribe(function () {});
		expect([a.live(), b.live()]).toEqual([1, 1]);
		stop1();
		stop1();
		expect([a.live(), b.live()]).toEqual([1, 1]);
		stop2();
		expect([a.live(), b.live()]).toEqual([0, 0]);
		const stop3 = sum.subscribe(function () {});
		expect([a.live(), b.live()]).toEqual([1, 1]);
		stop3();
		expect([a.live(), b.live()]).toEqual([0, 0]);
	});

	it('is glitch-free on a diamond: one recomputation and one notification per change', function () {
		const root = createStore(1);
		const doubled = root.select(function (n) {
			return n * 2;
		});
		const tripled = computed(root, function (n) {
			return n * 3;
		});
		const compute = jest.fn(function (x: number, y: number): string {
			return `${x}:${y}`;
		});
		const both = computed([doubled, tripled], compute);
		const seen: string[] = [];
		both.subscribe(function () {
			seen.push(both.getState());
		});
		expect(compute).toHaveBeenCalledTimes(1);
		root.setState(2);
		expect(seen).toEqual(['4:6']);
		expect(compute).toHaveBeenCalledTimes(2);
		root.setState(5);
		expect(seen).toEqual(['4:6', '10:15']);
		expect(compute).toHaveBeenCalledTimes(3);
	});

	it('never shows an inconsistent combination, whatever the subscription order', function () {
		const root = createStore(1);
		const doubled = root.select(function (n) {
			return n * 2;
		});
		const inconsistent: number[] = [];
		const check = computed([root, doubled], function (n, d) {
			if (d !== n * 2) inconsistent.push(n);
			return n + d;
		});
		const nested = computed([doubled, check, root], function (d, c, n) {
			if (c !== n * 3 || d !== n * 2) inconsistent.push(n);
			return c;
		});
		const seen: number[] = [];
		root.subscribe(function () {
			seen.push(nested.getState());
		});
		nested.subscribe(function () {
			seen.push(nested.getState());
		});
		for (let i = 2; i < 6; i++) root.setState(i);
		expect(inconsistent).toEqual([]);
		expect(seen).toEqual([6, 6, 9, 9, 12, 12, 15, 15]);
	});

	it('supports select, machines and histories as sources', function () {
		const machine = createMachine({ initial: 'off', states: { off: { on: { TOGGLE: 'on' } }, on: { on: { TOGGLE: 'off' } } } });
		const text = createStore('');
		const history = createHistory(text);
		const status = computed([machine, history], function (snapshot, h) {
			return `${snapshot.value}/${h.undoCount}`;
		});
		const length = status.select(function (s) {
			return s.length;
		});
		const seen: string[] = [];
		length.subscribe(function () {
			seen.push(status.getState());
		});
		machine.send('TOGGLE');
		text.setState('a');
		expect(status.getState()).toBe('on/1');
		expect(seen).toEqual(['on/0']);
	});

	it('propagates compute errors and recomputes on the next read', function () {
		const source = createStore(0);
		let fail = true;
		const view = computed(source, function (n) {
			if (fail) throw new Error('boom');
			return n;
		});
		expect(view.getState).toThrow('boom');
		fail = false;
		expect(view.getState()).toBe(0);
		fail = true;
		view.subscribe(function () {});
		expect(function () {
			source.setState(1);
		}).toThrow('boom');
		fail = false;
		expect(view.getState()).toBe(1);
	});

	it('copies the stores array', function () {
		const a = createStore(1);
		const stores = [a];
		const view = computed(stores, function (n) {
			return n;
		});
		stores[0] = createStore(5);
		expect(view.getState()).toBe(1);
	});

	it('rolls back the source subscriptions when one fails', function () {
		const good = spied(createStore(1));
		const bad = {
			getState(): number {
				return 2;
			},
			subscribe(): Unsubscribe {
				return 'nope' as never;
			}
		} as unknown as ReadonlyStore<number>;
		const view = computed([good, bad], function (x, y) {
			return x + y;
		});
		expect(function () {
			view.subscribe(function () {});
		}).toThrow(new TypeError("computed: a source store's `subscribe` must return a function, got string"));
		expect(good.live()).toBe(0);
		const throwing = {
			getState: bad.getState,
			subscribe: jest.fn(bad.subscribe).mockImplementation(function () {
				throw new Error('closed');
			})
		} as unknown as ReadonlyStore<number>;
		expect(function () {
			computed([good, throwing], function (x, y) {
				return x + y;
			}).subscribe(function () {});
		}).toThrow('closed');
		expect(good.live()).toBe(0);
	});

	it('validates its arguments and ignores a polluted Object.prototype', function () {
		const store = createStore(1);
		expect(function () {
			computed(null as never, function () {});
		}).toThrow(new TypeError('computed: `stores` must be a store (an object with getState and subscribe methods), got null'));
		expect(function () {
			computed({ getState() {} } as never, function () {});
		}).toThrow(TypeError);
		expect(function () {
			computed([{ subscribe() {} }] as never, function () {});
		}).toThrow(new TypeError('computed: `stores[0]` must be a store (an object with getState and subscribe methods), got object'));
		expect(function () {
			computed([store, 5] as never, function () {});
		}).toThrow(new TypeError('computed: `stores[1]` must be a store (an object with getState and subscribe methods), got number'));
		expect(function () {
			computed(store, 'x' as never);
		}).toThrow(new TypeError('computed: `compute` must be a function, got string'));
		expect(function () {
			computed(
				store,
				function (n) {
					return n;
				},
				{ equals: 1 as never }
			);
		}).toThrow(new TypeError('computed: `options.equals` must be a function, got number'));
		expect(function () {
			computed(store, function (n) {
				return n;
			}).select('x' as never);
		}).toThrow(new TypeError('select: `selector` must be a function, got string'));
		const proto = Object.prototype as Record<string, unknown>;
		proto.equals = function (): boolean {
			return true;
		};
		try {
			const view = computed(store, function (n) {
				return n;
			});
			view.getState();
			store.setState(2);
			expect(view.getState()).toBe(2);
		} finally {
			delete proto.equals;
		}
	});
});

/**
 * An in-memory storage recording its calls.
 */
function memoryStorage(entries: Record<string, string> = {}): PersistStorage & { data: Map<string, string>; calls: string[] } {
	const data = new Map(Object.entries(entries));
	const calls: string[] = [];
	return {
		data,
		calls,
		getItem(key: string): string | null {
			calls.push(`get ${key}`);
			return data.get(key) ?? null;
		},
		setItem(key: string, value: string): void {
			calls.push(`set ${key}`);
			data.set(key, value);
		},
		removeItem(key: string): void {
			calls.push(`remove ${key}`);
			data.delete(key);
		}
	};
}

describe('persistStore', function () {
	it('hydrates synchronously, merging the persisted state into the current one', function () {
		const storage = memoryStorage({ prefs: JSON.stringify({ state: { theme: 'dark', removed: 1 }, version: 0 }) });
		const store = createStore({ theme: 'light', size: 14 });
		const seen: unknown[] = [];
		store.subscribe(function () {
			seen.push(store.getState());
		});
		persistStore(store, { key: 'prefs', storage });
		expect(store.getState()).toEqual({ theme: 'dark', size: 14, removed: 1 });
		expect(seen).toHaveLength(1);
		expect(storage.calls).toEqual(['get prefs']);
	});

	it('keeps the state and writes nothing when the key is missing, until the state changes', function () {
		const storage = memoryStorage();
		const store = createStore({ n: 0 });
		const before = store.getState();
		persistStore(store, { key: 'k', storage });
		expect(store.getState()).toBe(before);
		expect(storage.calls).toEqual(['get k']);
		store.setState({ n: 1 });
		expect(storage.data.get('k')).toBe('{"state":{"n":1},"version":0}');
	});

	it('treats undefined from getItem as missing', function () {
		const store = createStore(1);
		const onError = jest.fn();
		persistStore(store, {
			key: 'k',
			storage: {
				getItem(): undefined {
					return undefined;
				},
				setItem(): void {},
				removeItem(): void {}
			},
			onError
		});
		expect(store.getState()).toBe(1);
		expect(onError).not.toHaveBeenCalled();
	});

	it('replaces non-object states, and stores function-valued states as values', function () {
		const store = createStore<number | (() => number)>(1);
		persistStore(store, { key: 'k', storage: memoryStorage({ k: '{"state":5,"version":0}' }) });
		expect(store.getState()).toBe(5);
		/** A function-valued state. */
		function fn(): number {
			return 7;
		}
		const fnStore = createStore<unknown>(0);
		persistStore(fnStore, {
			key: 'k',
			storage: memoryStorage({ k: '{"state":0,"version":0}' }),
			merge(): unknown {
				return fn;
			}
		});
		expect(fnStore.getState()).toBe(fn);
	});

	it('skips writes whose text the storage already holds', function () {
		const storage = memoryStorage({ k: '{"state":{"a":1},"version":0}' });
		const store = createStore({ a: 1 });
		persistStore(store, { key: 'k', storage });
		store.setState({ a: 1 });
		store.setState({ a: 2 });
		store.setState({ a: 2 });
		store.setState({ a: 2, b: undefined } as { a: number });
		expect(storage.calls).toEqual(['get k', 'set k']);
		expect(storage.data.get('k')).toBe('{"state":{"a":2},"version":0}');
	});

	it('persists the partialized state, and removes the key when it is undefined', function () {
		const storage = memoryStorage();
		const store = createStore({ token: '', remember: false });
		persistStore(store, {
			key: 'auth',
			storage,
			partialize(state) {
				return state.remember ? { token: state.token } : undefined;
			}
		});
		store.setState({ token: 'a', remember: false });
		expect(storage.calls).toEqual(['get auth']);
		store.setState({ token: 'a', remember: true });
		expect(storage.data.get('auth')).toBe('{"state":{"token":"a"},"version":0}');
		store.setState({ token: 'b', remember: false });
		expect(storage.data.has('auth')).toBe(false);
		expect(storage.calls).toEqual(['get auth', 'set auth', 'remove auth']);
	});

	it('writes back the migrated state itself, whatever the store does with setState', function () {
		const stored = '{"state":{"dark":true,"items":[1,2,3]},"version":0}';
		function migrate(persisted: unknown): unknown {
			return { theme: (persisted as { dark: boolean }).dark ? 'dark' : 'light', items: (persisted as { items: number[] }).items };
		}
		// A store that ignores (or defers) setState: the migrated data must not be replaced by its default state.
		const ignoring = memoryStorage({ s: stored });
		const inert = {
			getState: function () {
				return { theme: 'light', items: [] as number[] };
			},
			setState: function () {},
			subscribe: function () {
				return function () {};
			}
		};
		persistStore(inert, { key: 's', storage: ignoring, version: 1, migrate });
		expect(ignoring.data.get('s')).toBe('{"state":{"theme":"dark","items":[1,2,3]},"version":1}');

		// A listener that throws during hydration: the error is reported, and the migrated state is still written back.
		const throwing = memoryStorage({ s: stored });
		const store = createStore({ theme: 'light', items: [] as number[] });
		store.subscribe(function () {
			throw new Error('listener');
		});
		const onError = jest.fn();
		persistStore(store, { key: 's', storage: throwing, version: 1, migrate, onError });
		expect(onError).toHaveBeenCalledWith(new Error('listener'));
		expect(throwing.data.get('s')).toBe('{"state":{"theme":"dark","items":[1,2,3]},"version":1}');
	});

	it('migrates states of another version, and reports them without migrate', function () {
		const stored = JSON.stringify({ state: { count: '3' }, version: 1 });
		const migrated = createStore({ count: 0 });
		const migrate = jest.fn(function (persisted: unknown, version: number) {
			return { count: Number((persisted as { count: string }).count) + version };
		});
		const storage = memoryStorage({ c: stored });
		persistStore(migrated, { key: 'c', storage, version: 2, migrate });
		expect(migrate).toHaveBeenCalledWith({ count: '3' }, 1);
		expect(migrated.getState()).toEqual({ count: 4 });
		// Written back at once in the current version, so the next load does not migrate again.
		expect(storage.calls).toEqual(['get c', 'set c']);
		expect(storage.data.get('c')).toBe('{"state":{"count":4},"version":2}');
		const reloaded = createStore({ count: 0 });
		persistStore(reloaded, { key: 'c', storage, version: 2 });
		expect(reloaded.getState()).toEqual({ count: 4 });
		expect(migrate).toHaveBeenCalledTimes(1);
		migrated.setState({ count: 5 });
		expect(storage.data.get('c')).toBe('{"state":{"count":5},"version":2}');

		const unmigrated = createStore({ count: 0 });
		const onError = jest.fn();
		persistStore(unmigrated, { key: 'c', storage: memoryStorage({ c: stored }), version: 2, onError });
		expect(unmigrated.getState()).toEqual({ count: 0 });
		expect(onError).toHaveBeenCalledWith(new RangeError('persistStore: the stored state has version 1, not 2, and no `migrate` was given'));
	});

	it('never throws on bad storage: reports to onError and keeps the state', function () {
		const cases: Array<[PersistStorage, unknown]> = [
			[memoryStorage({ k: '{not json' }), SyntaxError],
			[memoryStorage({ k: '5' }), new TypeError('persistStore: the stored value must be a { state, version } object, got number')],
			[memoryStorage({ k: 'null' }), new TypeError('persistStore: the stored value must be a { state, version } object, got null')],
			[memoryStorage({ k: '{"version":0}' }), new TypeError('persistStore: the stored value must be a { state, version } object, got object')],
			[memoryStorage({ k: '{"state":{},"version":"0"}' }), new TypeError('persistStore: the stored value must be a { state, version } object, got object')],
			[memoryStorage({ k: '{"state":{},"__proto__":{"version":0}}' }), new TypeError('persistStore: the stored value must be a { state, version } object, got object')],
			[memoryStorage({ k: '{"state":[1],"version":0}' }), new TypeError('persistStore: the persisted state must be a plain object like the current one, got object')],
			[memoryStorage({ k: '{"state":"x","version":0}' }), TypeError],
			[
				{
					getItem(): string {
						throw new Error('SecurityError');
					},
					setItem(): void {},
					removeItem(): void {}
				},
				Error
			],
			[
				{
					getItem(): number {
						return 5;
					},
					setItem(): void {},
					removeItem(): void {}
				} as unknown as PersistStorage,
				new TypeError('persistStore: `storage.getItem` must return a string or null, got number')
			]
		];
		for (const [storage, expected] of cases) {
			const store = createStore({ a: 1 });
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
			expect(store.getState()).toBe(before);
			expect(errors).toHaveLength(1);
			if (typeof expected === 'function') expect(errors[0]).toBeInstanceOf(expected);
			else expect(errors[0]).toEqual(expected);
		}
		// Without onError, errors are ignored.
		expect(function () {
			persistStore(createStore(1), { key: 'k', storage: memoryStorage({ k: '{' }) });
		}).not.toThrow();
	});

	it('reports failing migrate, merge, serialize and setItem calls, and retries on the next change', function () {
		const errors: unknown[] = [];
		/** Collects the reported errors. */
		function onError(error: unknown): void {
			errors.push(error);
		}
		const store = createStore({ a: 1 });
		persistStore(store, {
			key: 'k',
			storage: memoryStorage({ k: '{"state":{"a":2},"version":0}' }),
			version: 1,
			migrate(): never {
				throw new Error('migrate');
			},
			onError
		});
		persistStore(store, {
			key: 'k',
			storage: memoryStorage({ k: '{"state":{"a":2},"version":0}' }),
			merge(): never {
				throw new Error('merge');
			},
			onError
		});
		expect(store.getState()).toEqual({ a: 1 });
		expect(errors).toEqual([new Error('migrate'), new Error('merge')]);

		let full = true;
		const storage = memoryStorage();
		const quota = createStore(0);
		persistStore(quota, {
			key: 'q',
			storage: {
				getItem: storage.getItem,
				removeItem: storage.removeItem,
				setItem(key: string, value: string): void {
					if (full) throw new Error('QuotaExceededError');
					storage.setItem(key, value);
				}
			},
			onError
		});
		expect(function () {
			quota.setState(1);
		}).not.toThrow();
		expect(errors[2]).toEqual(new Error('QuotaExceededError'));
		full = false;
		quota.setState(2);
		expect(storage.data.get('q')).toBe('{"state":2,"version":0}');

		const bigints = createStore<unknown>(0);
		persistStore(bigints, { key: 'b', storage: memoryStorage(), onError });
		bigints.setState(1n);
		expect(errors[3]).toBeInstanceOf(TypeError);
		persistStore(bigints, {
			key: 'b',
			storage: memoryStorage(),
			serialize(): string {
				return 5 as never;
			},
			onError
		});
		bigints.setState(2);
		expect(errors[4]).toEqual(new TypeError('persistStore: `serialize` must return a string, got number'));
	});

	it('uses custom serialize and deserialize functions', function () {
		const storage = memoryStorage({ k: 'state=7;version=0' });
		const store = createStore(0);
		persistStore(store, {
			key: 'k',
			storage,
			serialize(value) {
				return `state=${value.state};version=${value.version}`;
			},
			deserialize(text) {
				const [state, version] = text.split(';').map(function (part) {
					return Number(part.split('=')[1]);
				});
				return { state, version };
			}
		});
		expect(store.getState()).toBe(7);
		store.setState(8);
		expect(storage.data.get('k')).toBe('state=8;version=0');
	});

	it('drops __proto__ keys and constructor.prototype objects from stored data', function () {
		const text = '{"state":{"__proto__":{"polluted":true},"nested":{"__proto__":{"polluted":true},"ok":1},"constructor":{"prototype":{"polluted":true}}},"version":0}';
		const store = createStore<Record<string, unknown>>({ initial: true });
		persistStore(store, { key: 'k', storage: memoryStorage({ k: text }) });
		const state = store.getState();
		expect(Object.hasOwn(state, '__proto__')).toBe(false);
		expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
		expect(Object.hasOwn(state.nested as object, '__proto__')).toBe(false);
		expect(state.nested).toEqual({ ok: 1 });
		expect(state.initial).toBe(true);
		// `constructor: { prototype }` would let a naive deep merge of the state write to `Object.prototype`.
		expect(Object.hasOwn(state, 'constructor')).toBe(false);
		// A plain `constructor` value (no `prototype` key) is ordinary data and stays.
		const named = createStore<Record<string, unknown>>({});
		persistStore(named, { key: 'k', storage: memoryStorage({ k: '{"state":{"constructor":{"name":"Ada"}},"version":0}' }) });
		expect(named.getState().constructor).toEqual({ name: 'Ada' });
		const copy = Object.assign({}, state, state.nested);
		expect((copy as Record<string, unknown>).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();

		// A custom deserialize keeping an own __proto__ key: the default merge still skips it.
		const raw = createStore<Record<string, unknown>>({});
		persistStore(raw, {
			key: 'k',
			storage: memoryStorage({ k: '{"state":{"__proto__":{"polluted":true},"a":1},"version":0}' }),
			deserialize: JSON.parse
		});
		expect(raw.getState()).toEqual({ a: 1 });
		expect(Object.hasOwn(raw.getState(), '__proto__')).toBe(false);
		expect(Object.getPrototypeOf(raw.getState())).toBe(Object.prototype);
	});

	it('debounces writes, writing every change made meanwhile at once, and flushes on dispose', function () {
		jest.useFakeTimers();
		try {
			const storage = memoryStorage();
			const store = createStore(0);
			const stop = persistStore(store, { key: 'k', storage, debounce: 100 });
			store.setState(1);
			store.setState(2);
			expect(jest.getTimerCount()).toBe(1);
			jest.advanceTimersByTime(99);
			expect(storage.data.has('k')).toBe(false);
			store.setState(3);
			jest.advanceTimersByTime(1);
			expect(storage.data.get('k')).toBe('{"state":3,"version":0}');
			store.setState(4);
			store.setState(3);
			jest.advanceTimersByTime(100);
			expect(storage.calls).toEqual(['get k', 'set k']);
			store.setState(5);
			stop();
			expect(storage.data.get('k')).toBe('{"state":5,"version":0}');
			stop();
			store.setState(6);
			jest.advanceTimersByTime(1000);
			expect(storage.data.get('k')).toBe('{"state":5,"version":0}');
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});

	it('unsubscribes once, however often it is disposed', function () {
		const store = createStore(0);
		const unsubscribe = jest.fn();
		const stop = persistStore(
			{
				getState: store.getState,
				setState: store.setState,
				subscribe(): Unsubscribe {
					return unsubscribe;
				}
			},
			{ key: 'k', storage: memoryStorage() }
		);
		stop();
		stop();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('stops writing once disposed', function () {
		const storage = memoryStorage();
		const store = createStore(0);
		const stop = persistStore(store, { key: 'k', storage });
		stop();
		store.setState(1);
		expect(storage.calls).toEqual(['get k']);
	});

	describe('sync', function () {
		/**
		 * Installs a fake `addEventListener`/`removeEventListener` pair on `globalThis` for the duration of `run`.
		 * @param {(dispatch: (event: object) => void, count: () => number) => void} run - The test, given a way to dispatch events
		 * @returns {void}
		 */
		function withEvents(run: (dispatch: (event: object) => void, count: () => number) => void): void {
			const listeners = new Set<(event: object) => void>();
			const scope = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
			const previous = [scope.addEventListener, scope.removeEventListener];
			scope.addEventListener = function (type: string, listener: (event: object) => void): void {
				if (type === 'storage') listeners.add(listener);
			};
			scope.removeEventListener = function (type: string, listener: (event: object) => void): void {
				if (type === 'storage') listeners.delete(listener);
			};
			try {
				run(
					function (event) {
						for (const listener of [...listeners]) listener(event);
					},
					function () {
						return listeners.size;
					}
				);
			} finally {
				[scope.addEventListener, scope.removeEventListener] = previous;
			}
		}

		it('hydrates what another tab writes under the key, without writing it back', function () {
			withEvents(function (dispatch) {
				const storage = memoryStorage({ prefs: '{"state":{"theme":"light","size":1},"version":0}' });
				const store = createStore({ theme: 'light', size: 1 });
				const seen: string[] = [];
				store.subscribe(function () {
					seen.push(store.getState().theme);
				});
				persistStore(store, { key: 'prefs', storage, sync: true });
				storage.calls.length = 0;

				const text = '{"state":{"theme":"dark"},"version":0}';
				storage.data.set('prefs', text);
				dispatch({ key: 'prefs', newValue: text, storageArea: storage });
				expect(store.getState()).toEqual({ theme: 'dark', size: 1 });
				// The startup hydration notified once (a merged copy), the event once more.
				expect(seen).toEqual(['light', 'dark']);
				expect(storage.calls).toEqual([]);
				// Other keys and other storages are ignored.
				dispatch({ key: 'other', newValue: '{"state":{"theme":"x"},"version":0}', storageArea: storage });
				dispatch({ key: 'prefs', newValue: '{"state":{"theme":"y"},"version":0}', storageArea: memoryStorage() });
				expect(store.getState().theme).toBe('dark');
				// A change of this tab is written as usual.
				store.setState({ theme: 'dark', size: 2 });
				expect(storage.data.get('prefs')).toBe('{"state":{"theme":"dark","size":2},"version":0}');
			});
		});

		it('keeps the state when another tab removes the key or clears the storage, and writes the next change', function () {
			withEvents(function (dispatch) {
				const storage = memoryStorage();
				const store = createStore(1);
				persistStore(store, { key: 'n', storage, sync: true });
				store.setState(2);
				for (const event of [
					{ key: 'n', newValue: null, storageArea: storage },
					{ key: null, newValue: null, storageArea: storage }
				]) {
					storage.data.clear();
					dispatch(event);
					expect(store.getState()).toBe(2);
					// Nothing is written back in reaction.
					expect(storage.data.has('n')).toBe(false);
					store.setState(3);
					store.setState(2);
					expect(storage.data.get('n')).toBe('{"state":2,"version":0}');
				}

				// A change whose persisted slice is what this tab last wrote is still written once the storage was cleared.
				const slice = createStore({ theme: 'dark', open: false });
				persistStore(slice, {
					key: 'slice',
					storage,
					sync: true,
					partialize(state) {
						return { theme: state.theme };
					}
				});
				slice.setState({ theme: 'light', open: false });
				storage.data.clear();
				dispatch({ key: null, newValue: null, storageArea: storage });
				slice.setState({ theme: 'light', open: true });
				expect(storage.data.get('slice')).toBe('{"state":{"theme":"light"},"version":0}');
			});
		});

		it('writes back a migrated state, and what listeners change in reaction', function () {
			withEvents(function (dispatch) {
				const storage = memoryStorage();
				const store = createStore(0);
				store.subscribe(function () {
					if (store.getState() > 100) store.setState(100);
				});
				persistStore(store, {
					key: 'n',
					storage,
					version: 1,
					migrate(persisted) {
						return (persisted as number) * 10;
					},
					sync: true
				});
				dispatch({ key: 'n', newValue: '{"state":5,"version":0}', storageArea: storage });
				expect(store.getState()).toBe(50);
				expect(storage.data.get('n')).toBe('{"state":50,"version":1}');
				dispatch({ key: 'n', newValue: '{"state":500,"version":1}', storageArea: storage });
				expect(store.getState()).toBe(100);
				expect(storage.data.get('n')).toBe('{"state":100,"version":1}');
			});
		});

		it('reports bad data, and stops listening once disposed', function () {
			withEvents(function (dispatch, count) {
				const storage = memoryStorage();
				const store = createStore(0);
				const onError = jest.fn();
				const stop = persistStore(store, { key: 'n', storage, sync: true, onError });
				expect(count()).toBe(1);
				storage.data.set('n', 'not json');
				dispatch({ key: 'n', newValue: 'not json', storageArea: storage });
				expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError));
				expect(store.getState()).toBe(0);
				// The bad data is not overwritten in reaction.
				expect(storage.calls).toEqual(['get n']);
				stop();
				stop();
				expect(count()).toBe(0);
				dispatch({ key: 'n', newValue: '{"state":1,"version":0}', storageArea: storage });
				expect(store.getState()).toBe(0);
				// Without `sync`, no listener at all.
				persistStore(createStore(0), { key: 'n', storage });
				expect(count()).toBe(0);
			});
		});

		it('does nothing where there are no storage events', function () {
			const scope = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
			expect(scope.addEventListener).toBeUndefined();
			const store = createStore(0);
			expect(function () {
				persistStore(store, { key: 'n', storage: memoryStorage(), sync: true })();
			}).not.toThrow();
			// Half an event API is no event API.
			for (const [add, remove] of [
				[jest.fn(), undefined],
				[undefined, jest.fn()],
				['x', jest.fn()]
			]) {
				scope.addEventListener = add;
				scope.removeEventListener = remove;
				try {
					persistStore(store, { key: 'n', storage: memoryStorage(), sync: true })();
					for (const fn of [add, remove]) if (typeof fn === 'function') expect(fn).not.toHaveBeenCalled();
				} finally {
					delete scope.addEventListener;
					delete scope.removeEventListener;
				}
			}
		});
	});

	it('defaults to globalThis.localStorage when it is usable, and does nothing otherwise', function () {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		const storage = memoryStorage({ k: '{"state":9,"version":0}' });
		try {
			Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
			const store = createStore(0);
			persistStore(store, { key: 'k' });
			expect(store.getState()).toBe(9);
			store.setState(10);
			expect(storage.data.get('k')).toBe('{"state":10,"version":0}');

			Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
			const none = createStore(0);
			const onError = jest.fn();
			const subscribe = jest.fn(none.subscribe);
			const stop = persistStore({ getState: none.getState, setState: none.setState, subscribe }, { key: 'k', storage: undefined, onError });
			none.setState(1);
			expect(stop()).toBeUndefined();
			// Nothing to persist to: no subscription, and nothing reported.
			expect(subscribe).not.toHaveBeenCalled();
			expect(onError).not.toHaveBeenCalled();

			for (const value of [{ getItem() {}, setItem() {} }, { setItem() {}, removeItem() {} }, { getItem() {}, removeItem() {} }, 5, null]) {
				Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
				const unusable = createStore(0);
				const unusableError = jest.fn();
				persistStore(unusable, { key: 'k', onError: unusableError });
				unusable.setState(1);
				expect(unusableError).not.toHaveBeenCalled();
			}

			// Jest's global proxy swallows errors thrown by a global getter: throw from the storage's own getter instead.
			Object.defineProperty(globalThis, 'localStorage', {
				value: {
					get getItem(): never {
						throw new Error('SecurityError');
					}
				},
				configurable: true,
				writable: true
			});
			const blocked = createStore(0);
			expect(function () {
				persistStore(blocked, { key: 'k' })();
			}).not.toThrow();
		} finally {
			if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
			else delete (globalThis as { localStorage?: unknown }).localStorage;
		}
	});

	it('validates its arguments, ignoring a polluted Object.prototype', function () {
		const store = createStore(0);
		const storage = memoryStorage();
		const cases: Array<[() => unknown, Error]> = [
			[
				function () {
					return persistStore(null as never, { key: 'k', storage });
				},
				new TypeError('persistStore: `store` must be a store, got null')
			],
			[
				function () {
					return persistStore({ getState: store.getState, subscribe: store.subscribe } as never, { key: 'k', storage });
				},
				new TypeError('persistStore: `store.setState` must be a function, got undefined')
			],
			[
				function () {
					return persistStore({ setState: store.setState, subscribe: store.subscribe } as never, { key: 'k', storage });
				},
				new TypeError('persistStore: `store.getState` must be a function, got undefined')
			],
			[
				function () {
					return persistStore({ getState: store.getState, setState: store.setState } as never, { key: 'k', storage });
				},
				new TypeError('persistStore: `store.subscribe` must be a function, got undefined')
			],
			[
				function () {
					return persistStore(store, null as never);
				},
				new TypeError('persistStore: `options` must be an object, got null')
			],
			[
				function () {
					return persistStore(store, {} as never);
				},
				new TypeError('persistStore: `options.key` must be a string, got undefined')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, version: -1 });
				},
				new RangeError('persistStore: `options.version` must be an integer >= 0, got -1')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, version: 1.5 });
				},
				new RangeError('persistStore: `options.version` must be an integer >= 0, got 1.5')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, debounce: -1 });
				},
				new RangeError('persistStore: `options.debounce` must be a number between 0 and 2147483647, got -1')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage: { getItem() {} } as never });
				},
				new TypeError('persistStore: `options.storage` must have getItem, setItem and removeItem methods, got object')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage: { getItem() {}, setItem() {} } as never });
				},
				new TypeError('persistStore: `options.storage` must have getItem, setItem and removeItem methods, got object')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage: { setItem() {}, removeItem() {} } as never });
				},
				new TypeError('persistStore: `options.storage` must have getItem, setItem and removeItem methods, got object')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage: { getItem() {}, removeItem() {} } as never });
				},
				new TypeError('persistStore: `options.storage` must have getItem, setItem and removeItem methods, got object')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage: null as never });
				},
				new TypeError('persistStore: `options.storage` must have getItem, setItem and removeItem methods, got null')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, serialize: 1 as never });
				},
				new TypeError('persistStore: `options.serialize` must be a function, got number')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, deserialize: 1 as never });
				},
				new TypeError('persistStore: `options.deserialize` must be a function, got number')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, migrate: 1 as never });
				},
				new TypeError('persistStore: `options.migrate` must be a function, got number')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, partialize: 1 as never });
				},
				new TypeError('persistStore: `options.partialize` must be a function, got number')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, merge: 1 as never });
				},
				new TypeError('persistStore: `options.merge` must be a function, got number')
			],
			[
				function () {
					return persistStore(store, { key: 'k', storage, onError: 1 as never });
				},
				new TypeError('persistStore: `options.onError` must be a function, got number')
			],
			[
				function () {
					return persistStore(
						{
							getState: store.getState,
							setState: store.setState,
							subscribe(): Unsubscribe {
								return undefined as never;
							}
						},
						{ key: 'k', storage }
					);
				},
				new TypeError('persistStore: `store.subscribe()` must be a function, got undefined')
			]
		];
		for (const [fn, error] of cases) expect(fn).toThrow(error);

		const proto = Object.prototype as Record<string, unknown>;
		proto.version = 3;
		proto.partialize = function (): string {
			return 'polluted';
		};
		try {
			const polluted = memoryStorage();
			persistStore(store, { key: 'p', storage: polluted });
			store.setState(1);
			expect(polluted.data.get('p')).toBe('{"state":1,"version":0}');
		} finally {
			delete proto.version;
			delete proto.partialize;
		}
	});
});
