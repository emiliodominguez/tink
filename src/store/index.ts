import type { Unsubscribe } from '../emitter/index.js';
import { assertFunction } from '../utils/assert.js';

export type { Unsubscribe } from '../emitter/index.js';

/**
 * Number of notification rounds a single `setState` may trigger (through listeners that keep updating the state) before giving up.
 */
const MAX_ROUNDS = 100;

/**
 * Decides whether two states are equal (no notification is sent for equal states).
 * @template T - The compared type
 */
export type EqualityFn<T> = (a: T, b: T) => boolean;

/**
 * A read-only view of a state container, compatible with React's `useSyncExternalStore(store.subscribe, store.getState)`.
 * Methods do not depend on `this`, so they can be passed around unbound.
 * @template S - The state type
 */
export interface ReadonlyStore<S> {
	/** The current state. The same reference is returned until the state changes. */
	getState(): S;
	/** Calls `listener` (without arguments) after each state change. Returns a function removing exactly this subscription. */
	subscribe(listener: () => void): Unsubscribe;
	/** A derived store holding `selector(state)`, which only notifies when the selected value changes according to `equals`. */
	select<T>(selector: (state: S) => T, equals?: EqualityFn<T>): ReadonlyStore<T>;
}

/**
 * A minimal state container. See {@link createStore}.
 * @template S - The state type
 */
export interface Store<S> extends ReadonlyStore<S> {
	/** Replaces the state with `next`, or with `next(prev)` when `next` is a function. No-op (no notification) when the new state equals the old one. */
	setState(next: S | ((prev: S) => S)): void;
	/** Restores the initial state (notifying only if it differs from the current one). */
	reset(): void;
}

/**
 * Options accepted by {@link createStore}.
 * @template S - The state type
 */
export interface StoreOptions<S> {
	/** Decides whether a new state equals the previous one (equal states are not stored and do not notify). Defaults to `Object.is`. */
	equals?: EqualityFn<S>;
}

/**
 * A list of no-argument listeners with re-entrancy safe, error tolerant notification.
 */
interface Notifier {
	subscribe(listener: () => void): Unsubscribe;
	notify(): void;
	size(): number;
}

/**
 * One subscription of a listener.
 */
interface Subscription {
	readonly listener: () => void;
	active: boolean;
}

/**
 * Creates a {@link Notifier}. A `notify` call made while listeners are being notified does not nest: it schedules another round that runs
 * once the current one has finished. Each round calls the listeners subscribed when it started, skipping those unsubscribed meanwhile.
 * Every listener is called in each round even if some throw; errors are rethrown afterwards (the error itself, or an `AggregateError`
 * when there are several).
 * @returns {Notifier} A new notifier
 * @throws {RangeError} from `notify` when listeners keep changing the state for 100 consecutive rounds
 */
function createNotifier(): Notifier {
	// Mutated in place, except during a round, which iterates the array it started with: then it is copied on write.
	let subscriptions: Subscription[] = [];
	let notifying = false;
	// Set by every `notify` call before it is read.
	let pending: boolean;

	/**
	 * Calls every active listener of the current list once.
	 * @returns {unknown[] | undefined} The errors thrown by listeners, if any
	 */
	function round(): unknown[] | undefined {
		const snapshot = subscriptions;
		let errors: unknown[] | undefined;

		for (const subscription of snapshot) {
			if (!subscription.active) continue;

			try {
				const listener = subscription.listener;
				listener();
			} catch (error) {
				errors = errors ?? [];
				errors.push(error);
			}
		}

		return errors;
	}

	return {
		subscribe(listener: () => void): Unsubscribe {
			const subscription: Subscription = { listener, active: true };

			if (notifying) subscriptions = subscriptions.slice();
			subscriptions.push(subscription);

			return function (): void {
				if (!subscription.active) return;

				subscription.active = false;
				if (notifying) subscriptions = subscriptions.slice();
				subscriptions.splice(subscriptions.indexOf(subscription), 1);
			};
		},

		notify(): void {
			pending = true;
			if (notifying) return;

			let errors: unknown[] | undefined;
			let rounds = 0;

			notifying = true;

			while (pending) {
				pending = false;

				if (++rounds > MAX_ROUNDS) {
					notifying = false;
					throw new RangeError(`store: listeners changed the state during ${MAX_ROUNDS} consecutive notification rounds`);
				}

				const roundErrors = round();

				if (roundErrors !== undefined) {
					errors = errors ?? [];
					errors.push(roundErrors.length === 1 ? roundErrors[0] : new AggregateError(roundErrors, `store: ${roundErrors.length} listeners threw`));
				}
			}

			notifying = false;

			if (errors === undefined) return;
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, `store: ${errors.length} notification rounds threw`);
		},

		size(): number {
			return subscriptions.length;
		}
	};
}

/**
 * Creates a read-only store derived from `source`. While it has no subscribers it is not subscribed to `source` (so unused derived stores
 * never leak), and `getState` recomputes lazily; the selected value is cached and only replaced when `equals` reports a change.
 * @template S - The source state type
 * @template T - The selected type
 * @param {ReadonlyStore<S>} source - The store to derive from
 * @param {(state: S) => T} selector - Projects the source state
 * @param {EqualityFn<T>} equals - Compares two selected values
 * @returns {ReadonlyStore<T>} The derived store
 * @throws {TypeError} when `selector` or `equals` is not a function
 */
function derive<S, T>(source: ReadonlyStore<S>, selector: (state: S) => T, equals: EqualityFn<T>): ReadonlyStore<T> {
	assertFunction('select', 'selector', selector);
	assertFunction('select', 'equals', equals);

	const notifier = createNotifier();
	let hasValue = false;
	let sourceState: S;
	let value: T;
	let version = 0;
	let notifiedVersion = 0;
	let notifiedValue: T;
	let detach: Unsubscribe | undefined;

	/**
	 * Returns the cached selected value, recomputing it when the source state changed.
	 * @returns {T} The selected value
	 */
	function getState(): T {
		const state = source.getState();

		if (!hasValue || !Object.is(state, sourceState)) {
			const next = selector(state);

			// Only record the source state once `equals` has returned: if it throws, the next call must recompute.
			if (!hasValue || !equals(value, next)) {
				value = next;
				version++;
			}
			sourceState = state;
			hasValue = true;
		}

		return value;
	}

	/**
	 * Source listener: notifies the derived subscribers when the selected value differs from the one of the last notification (comparing
	 * versions rather than recomputing, so a `getState` call made by another listener earlier in the same round cannot hide the change).
	 * @returns {void}
	 */
	function onSourceChange(): void {
		const current = getState();
		if (version === notifiedVersion) return;
		notifiedVersion = version;
		// The value may have changed and changed back within the round (A, then B read by another listener, then A again).
		if (equals(notifiedValue, current)) return;
		notifiedValue = current;
		notifier.notify();
	}

	const store: ReadonlyStore<T> = {
		getState,

		subscribe(listener: () => void): Unsubscribe {
			assertFunction('subscribe', 'listener', listener);

			if (!detach) {
				notifiedValue = getState();
				notifiedVersion = version;
				detach = source.subscribe(onSourceChange);
			}

			const unsubscribe = notifier.subscribe(listener);
			let active = true;

			return function (): void {
				if (!active) return;

				active = false;
				unsubscribe();
				if (notifier.size() === 0) {
					(detach as Unsubscribe)();
					detach = undefined;
				}
			};
		},

		select<U>(nextSelector: (state: T) => U, nextEquals: EqualityFn<U> = Object.is): ReadonlyStore<U> {
			return derive(store, nextSelector, nextEquals);
		}
	};

	return store;
}

/**
 * Creates a tiny synchronous state container, usable from React 18+ without any React dependency:
 * `const state = useSyncExternalStore(store.subscribe, store.getState);` (methods can be passed unbound).
 *
 * Semantics:
 * - `getState` returns the same reference until the state changes (as `useSyncExternalStore` requires).
 * - `setState(next)` stores `next` (or `next(prev)` when `next` is a function — so to store a function, wrap it: `setState(function () { return fn; })`)
 *   and notifies the listeners, unless `equals(prev, next)` holds, in which case nothing happens.
 * - Listeners receive no arguments and read the new state with `getState`. Subscribing the same listener twice calls it twice.
 * - Re-entrancy: `setState` called from a listener updates the state immediately, but notification does not nest — another round is
 *   queued and runs after every listener has seen the current round, so all listeners observe the latest state and no update is lost
 *   (several updates made during one round are coalesced into one more round).
 * - A throwing listener does not prevent the others from running; the error is rethrown from `setState` afterwards (an `AggregateError`
 *   when several rounds threw). The state change itself is kept.
 * - `select(selector, equals = Object.is)` returns a cached derived store that only notifies when the selected value changes.
 * @template S - The state type
 * @param {S} initialState - The initial state (also restored by `reset`)
 * @param {StoreOptions<S>} [options] - `equals` (defaults to `Object.is`)
 * @returns {Store<S>} The store
 * @throws {TypeError} when `options.equals` is not a function, or (from `subscribe`/`select`) when a listener, selector or equality function is not a function
 * @throws {RangeError} from `setState` when listeners keep changing the state for 100 consecutive notification rounds
 * @example
 * const counter = createStore({ count: 0, step: 1 });
 * const count = counter.select(function (s) { return s.count; });
 * const seen: number[] = [];
 * count.subscribe(function () { seen.push(count.getState()); });
 * counter.setState(function (s) { return { ...s, count: s.count + s.step }; }); // count changed: notifies
 * counter.setState(function (s) { return { ...s, step: 2 }; }); // count unchanged: no notification
 * seen; // => [1]
 * counter.getState(); // => { count: 1, step: 2 }
 * // React: const value = useSyncExternalStore(count.subscribe, count.getState);
 */
export function createStore<S>(initialState: S, options: StoreOptions<S> = {}): Store<S> {
	const { equals = Object.is } = options;

	assertFunction('createStore', 'options.equals', equals);

	const notifier = createNotifier();
	let state = initialState;

	/**
	 * Stores `next` and notifies, unless it equals the current state.
	 * @param {S} next - The new state
	 * @returns {void}
	 */
	function commit(next: S): void {
		if (equals(state, next)) return;

		state = next;
		notifier.notify();
	}

	const store: Store<S> = {
		getState(): S {
			return state;
		},

		setState(next: S | ((prev: S) => S)): void {
			commit(typeof next === 'function' ? (next as (prev: S) => S)(state) : next);
		},

		reset(): void {
			commit(initialState);
		},

		subscribe(listener: () => void): Unsubscribe {
			assertFunction('subscribe', 'listener', listener);

			return notifier.subscribe(listener);
		},

		select<T>(selector: (state: S) => T, selectEquals: EqualityFn<T> = Object.is): ReadonlyStore<T> {
			return derive(store, selector, selectEquals);
		}
	};

	return store;
}
