import { isEqual } from '../objects/index.js';
import { createStore, type ReadonlyStore, type Store, type Unsubscribe } from '.';

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
