import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isEqual } from '../objects/index.js';
import { createHistory, createMachine, createStore, type HistorySource, type MachineSnapshot, type ReadonlyStore, type StateConfig, type Store, type Unsubscribe } from '.';

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
				cause: expect.objectContaining({ errors: [new Error('round 10'), new Error('round 20')] })
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
				}).toThrow(TypeError);
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
			}).toThrow(expect.objectContaining({ cause: expect.objectContaining({ errors: [new Error('40'), new Error('80')] }) }));
		});
	});
});

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
