import type { Unsubscribe } from '../emitter/index.js';
import { isPlainObject } from '../guards/index.js';
import { assertDelay, assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';
import { withoutProtoKeys } from '../utils/proto.js';

export type { Unsubscribe } from '../emitter/index.js';

/**
 * Number of notification rounds a single `setState` may trigger (through listeners that keep updating the state) before giving up;
 * also the number of events a single machine `send` may handle (through listeners that keep sending events).
 */
const MAX_ROUNDS = 100;

/** How many {@link batch} calls are running (nested ones included). */
let batchDepth = 0;
/** The notifications held back by the running batch, in the order of the first change of each store (called with `true`). */
let heldBack: Array<(released: boolean) => void> = [];

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
	/**
	 * While a notification is running, or held back by a batch, schedules `callback` (once, however often it is deferred) for when its
	 * last round ends.
	 */
	defer(callback: () => void): boolean;
}

/**
 * One subscription of a listener.
 */
interface Subscription {
	/** The listener, `undefined` once unsubscribed (so that the list does not keep it alive). */
	listener: (() => void) | undefined;
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
	// The subscriptions in subscription order, unsubscribed ones included until `compact` drops them: unsubscribing only clears the
	// listener, so it is O(1) amortized (a `splice` per unsubscription made unmounting n subscribers O(n²)), and a round can iterate the
	// list by index, up to the length it started with, while listeners subscribe and unsubscribe.
	const subscriptions: Subscription[] = [];
	// How many of them are unsubscribed.
	let removed = 0;
	let notifying = false;
	// Set by every `run` call before it is read.
	let pending: boolean;
	// Callbacks to run once the current notification has finished (see `defer`).
	let deferred: Array<() => void> = [];
	// Whether a notification is held back by a batch.
	let held = false;

	/**
	 * Drops the unsubscribed entries once they are half of the list (never during a notification, whose rounds iterate it by index),
	 * so that the list stays within twice the number of subscribers and each unsubscription costs O(1) amortized.
	 * @returns {void}
	 */
	function compact(): void {
		if (notifying || removed * 2 < subscriptions.length) return;
		let kept = 0;
		for (const subscription of subscriptions) if (subscription.listener !== undefined) subscriptions[kept++] = subscription;
		subscriptions.length = kept;
		removed = 0;
	}

	/**
	 * Ends a notification: compacts the list, then runs the deferred callbacks.
	 * @param {unknown[] | undefined} errors - The errors collected so far
	 * @returns {unknown[] | undefined} `errors`, plus those of the callbacks
	 */
	function settle(errors: unknown[] | undefined): unknown[] | undefined {
		notifying = false;
		compact();
		// Most notifications defer nothing: no array is allocated for them.
		if (deferred.length === 0) return errors;
		const callbacks = deferred;
		deferred = [];
		for (const callback of callbacks) {
			try {
				callback();
			} catch (error) {
				errors = errors ?? [];
				errors.push(error);
			}
		}
		return errors;
	}

	/**
	 * Notifies the listeners: rounds until no listener changes the state anymore, then the deferred callbacks. Each round calls every
	 * listener subscribed when it starts, and still subscribed when its turn comes, once. (One closure rather than several: a derived
	 * store creates a notifier, and every closure adds to the cost of `select`.)
	 * @param {boolean} released - Whether a batch releases the notification it held back
	 * @returns {void}
	 * @throws {RangeError} when listeners keep changing the state for 100 consecutive rounds
	 */
	function run(released: boolean): void {
		// Already notified: a listener of a store released earlier changed this one again, which notified at once.
		if (released && !held) return;
		held = false;
		pending = true;
		if (notifying) return;

		let errors: unknown[] | undefined;
		let rounds = 0;

		notifying = true;

		while (pending) {
			pending = false;

			if (++rounds > MAX_ROUNDS) {
				errors = settle(errors);
				const message = `store: listeners changed the state during ${MAX_ROUNDS} consecutive notification rounds`;
				// The errors of the rounds run so far are kept as the cause, rather than lost.
				if (errors === undefined) throw new RangeError(message);
				throw new RangeError(message, {
					cause: errors.length === 1 ? errors[0] : new AggregateError(errors, `store: ${errors.length} notification rounds threw`)
				});
			}

			const length = subscriptions.length;
			let roundErrors: unknown[] | undefined;

			for (let i = 0; i < length; i++) {
				const listener = subscriptions[i].listener;
				if (listener === undefined) continue;

				try {
					listener();
				} catch (error) {
					roundErrors = roundErrors ?? [];
					roundErrors.push(error);
				}
			}

			if (roundErrors !== undefined) {
				errors = errors ?? [];
				errors.push(roundErrors.length === 1 ? roundErrors[0] : new AggregateError(roundErrors, `store: ${roundErrors.length} listeners threw`));
			}
		}

		errors = settle(errors);

		if (errors === undefined) return;
		if (errors.length === 1) throw errors[0];
		throw new AggregateError(errors, `store: ${errors.length} notification rounds threw`);
	}

	return {
		subscribe(listener: () => void): Unsubscribe {
			const subscription: Subscription = { listener };

			subscriptions.push(subscription);

			return function (): void {
				if (subscription.listener === undefined) return;

				subscription.listener = undefined;
				removed++;
				compact();
			};
		},

		notify(): void {
			if (batchDepth > 0) {
				// Held back until the outermost batch ends, once however many changes the batch makes.
				if (!held) {
					held = true;
					heldBack.push(run);
				}
				return;
			}
			run(false);
		},

		size(): number {
			return subscriptions.length - removed;
		},

		defer(callback: () => void): boolean {
			// A held notification runs when the batch ends, and its last round then runs the callbacks.
			if (!notifying && !held) return false;
			if (!deferred.includes(callback)) deferred.push(callback);
			return true;
		}
	};
}

/**
 * A base class whose constructor returns the object it is given, so that a subclass can add private fields to an existing object.
 */
class Stamp {
	/**
	 * Returns `target` as the instance under construction.
	 * @param {object} target - The object to stamp
	 */
	constructor(target: object) {
		return target;
	}
}

/**
 * Attaches the notifier of each store made by {@link createStore}, so that {@link createHistory} can tell when a notification (all the
 * rounds caused by one change) has ended. A private field rather than a `WeakMap`: registering a store in a `WeakMap` cost more than
 * creating the rest of it, and a private field is just as invisible and impossible to forge (no reflection reaches it, and only the
 * constructor below can add it). The store keeps its `Object.prototype` prototype.
 */
class NotifierBrand extends Stamp {
	/** The store's notifier. */
	readonly #notifier: Notifier;

	/**
	 * Adds the private field to `store`.
	 * @param {object} store - The store
	 * @param {Notifier} notifier - Its notifier
	 */
	constructor(store: object, notifier: Notifier) {
		super(store);
		this.#notifier = notifier;
	}

	/**
	 * Returns the notifier of a store made by {@link createStore}.
	 * @param {object} store - Any store
	 * @returns {Notifier | undefined} Its notifier, or `undefined` for other stores
	 */
	static of(store: object): Notifier | undefined {
		return #notifier in store ? (store as NotifierBrand).#notifier : undefined;
	}
}

/**
 * Creates a read-only store derived from `source`. While it has no subscribers it is not subscribed to `source` (so unused derived stores
 * never leak), and `getState` recomputes lazily; the selected value is cached and only replaced when `equals` reports a change. Reading
 * the source on demand (rather than caching what its notifications carried) keeps every read consistent with the current source state,
 * which is what makes diamonds glitch-free: the first notification recomputes from the up-to-date state, and the next ones find
 * nothing changed.
 * @template S - The source state type
 * @template T - The selected type
 * @param {Pick<ReadonlyStore<S>, 'getState' | 'subscribe'>} source - The store to derive from
 * @param {(state: S) => T} selector - Projects the source state
 * @param {EqualityFn<T>} equals - Compares two selected values
 * @returns {ReadonlyStore<T>} The derived store
 * @throws {TypeError} when `selector` or `equals` is not a function, or (from `subscribe`) when the source's `subscribe` does not return
 * a function
 */
function derive<S, T>(source: Pick<ReadonlyStore<S>, 'getState' | 'subscribe'>, selector: (state: S) => T, equals: EqualityFn<T>): ReadonlyStore<T> {
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
		// The value may have changed and changed back within the round (A, then B read by another listener, then A again). Compared
		// before the version is marked as notified: when `equals` throws, the next notification of the source compares again.
		const unchanged = equals(notifiedValue, current);
		notifiedVersion = version;
		if (unchanged) return;
		notifiedValue = current;
		notifier.notify();
	}

	const store: ReadonlyStore<T> = {
		getState,

		subscribe(listener: () => void): Unsubscribe {
			assertFunction('subscribe', 'listener', listener);

			if (!detach) {
				const initial = getState();

				// The selector may have subscribed to this store itself (directly, or through a listener of the source): attach once.
				if (!detach) {
					notifiedValue = initial;
					notifiedVersion = version;
					detach = attach(source, onSourceChange);
				}
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
 * Subscribes `listener` to a source store, checking that it returns an unsubscribe function (a foreign store given to {@link computed}
 * may not).
 * @param {Pick<ReadonlyStore<unknown>, 'subscribe'>} source - The store
 * @param {() => void} listener - The listener
 * @returns {Unsubscribe} The unsubscribe function
 * @throws {TypeError} when `source.subscribe` does not return a function
 */
function attach(source: Pick<ReadonlyStore<unknown>, 'subscribe'>, listener: () => void): Unsubscribe {
	const unsubscribe: unknown = source.subscribe(listener);
	if (typeof unsubscribe !== 'function') throw new TypeError(`computed: a source store's \`subscribe\` must return a function, got ${describe(unsubscribe)}`);
	return unsubscribe as Unsubscribe;
}

/**
 * Combines stores into a single source for {@link derive}: its state is the array of their states, read on demand (a new array only
 * when one of them changed, `Object.is`, so that `derive` recomputes only then), and subscribing to it subscribes to all of them (all
 * or none: when one throws, the subscriptions already made are removed).
 * @param {ReadonlyArray<ReadonlyStore<unknown>>} sources - The stores
 * @returns {Pick<ReadonlyStore<unknown[]>, 'getState' | 'subscribe'>} The combined source
 */
function combineStores(sources: ReadonlyArray<ReadonlyStore<unknown>>): Pick<ReadonlyStore<unknown[]>, 'getState' | 'subscribe'> {
	let states: unknown[] | undefined;

	return {
		getState(): unknown[] {
			// Allocated only when a state changed (or on the first read).
			let next: unknown[] | undefined = states === undefined ? [] : undefined;
			for (let i = 0; i < sources.length; i++) {
				const state = sources[i].getState();
				if (next === undefined && !Object.is(state, (states as unknown[])[i])) next = (states as unknown[]).slice(0, i);
				if (next !== undefined) next.push(state);
			}
			if (next !== undefined) states = next;
			return states as unknown[];
		},

		subscribe(listener: () => void): Unsubscribe {
			const subscriptions: Unsubscribe[] = [];
			try {
				for (const source of sources) subscriptions.push(attach(source, listener));
			} catch (error) {
				for (const unsubscribe of subscriptions) unsubscribe();
				throw error;
			}
			return function (): void {
				for (const unsubscribe of subscriptions) unsubscribe();
			};
		}
	};
}

/**
 * The states of a tuple (or array) of stores, in the same order: what {@link computed} passes to its `compute` function.
 * @template T - The stores
 */
export type StoreStates<T extends readonly unknown[]> = { [K in keyof T]: T[K] extends ReadonlyStore<infer S> ? S : never };

/**
 * Options accepted by {@link computed}.
 * @template T - The computed type
 */
export interface ComputedOptions<T> {
	/** Decides whether a new computed value equals the previous one (equal values are not stored and do not notify). Defaults to `Object.is`. */
	equals?: EqualityFn<T>;
}

/**
 * Throws unless `value` looks like a store (an object with `getState` and `subscribe` methods).
 * @param {string} name - The parameter name, for the error message
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a store
 */
function assertStore(name: string, value: unknown): asserts value is ReadonlyStore<unknown> {
	if (!isObject(value) || typeof value.getState !== 'function' || typeof value.subscribe !== 'function') {
		throw new TypeError(`computed: \`${name}\` must be a store (an object with getState and subscribe methods), got ${describe(value)}`);
	}
}

/**
 * Creates a read-only store computed from one or more stores (like nanostores' `computed`, or a selector over several Zustand stores):
 * its state is `compute(...states)`, recomputed when one of the source states changes, and it only notifies when the result changes
 * according to `equals` (default `Object.is`). Works with any store with `getState` and `subscribe` (those of this module, machines,
 * histories, other computed stores...).
 *
 * - Lazy and leak-free: it subscribes to its sources only while it has subscribers of its own (from the first `subscribe` to the last
 *   unsubscribe), so a computed store nobody listens to can be garbage collected with no cleanup. Without subscribers, `getState`
 *   recomputes on demand, only when a source state changed (`Object.is`).
 * - Glitch-free: `compute` always sees the current state of every source, and one change notifies the computed store's subscribers
 *   at most once, even through a diamond (two sources derived from the same store: one recomputation, one notification). Sources are
 *   read on demand, so this holds for every store whose `getState` is always up to date, which is the case of this module's stores.
 * - `useSyncExternalStore` friendly: `getState` returns the same reference until the result changes, and methods can be passed
 *   unbound: `useSyncExternalStore(total.subscribe, total.getState)`.
 * - `compute` and `equals` must be pure: they may run for a `getState` call, not only on changes. Errors they throw propagate to
 *   the caller (`getState`, or the source's `setState` through the notification), and the next read recomputes.
 * @template S - The source state type (single store)
 * @template T - The computed type
 * @param {ReadonlyStore<S> | ReadonlyArray<ReadonlyStore<unknown>>} stores - A store, or an array of stores (whose states are passed to
 * `compute` in the same order)
 * @param {(state: S) => T} compute - Computes the state from the source state(s)
 * @param {ComputedOptions<T>} [options={}] - `equals` (default `Object.is`)
 * @returns {ReadonlyStore<T>} The computed store
 * @throws {TypeError} when `stores` is not a store or an array of stores, or `compute` or `options.equals` is not a function, or (from
 * `subscribe`) when a source's `subscribe` does not return a function
 * @example
 * const price = createStore(10);
 * const quantity = createStore(3);
 * const total = computed([price, quantity], function (p, q) { return p * q; });
 * total.getState(); // => 30
 * const seen: number[] = [];
 * total.subscribe(function () { seen.push(total.getState()); });
 * price.setState(12);
 * quantity.setState(3); // unchanged: no notification
 * seen; // => [36]
 * @example
 * // A diamond: both sources derive from `celsius`, yet one change makes one recomputation and one notification
 * const celsius = createStore(0);
 * const fahrenheit = celsius.select(function (c) { return c * 1.8 + 32; });
 * const kelvin = computed(celsius, function (c) { return c + 273.15; });
 * let runs = 0;
 * const label = computed([fahrenheit, kelvin], function (f, k) { runs++; return `${f} °F / ${k} K`; });
 * const labels: string[] = [];
 * label.subscribe(function () { labels.push(label.getState()); });
 * celsius.setState(100);
 * labels; // => ['212 °F / 373.15 K']
 * runs; // => 2 // the initial computation, then one per change
 */
export function computed<S, T>(store: ReadonlyStore<S>, compute: (state: S) => T, options?: ComputedOptions<T>): ReadonlyStore<T>;
export function computed<const Stores extends ReadonlyArray<ReadonlyStore<unknown>>, T>(
	stores: Stores,
	compute: (...states: StoreStates<Stores>) => T,
	options?: ComputedOptions<T>
): ReadonlyStore<T>;
/**
 * Implementation of {@link computed} (see the first overload for the full documentation).
 * @template T - The computed type
 * @param {ReadonlyStore<unknown> | ReadonlyArray<ReadonlyStore<unknown>>} stores - A store, or an array of stores
 * @param {(...states: never[]) => T} compute - Computes the state from the source states
 * @param {ComputedOptions<T>} [options={}] - `equals`
 * @returns {ReadonlyStore<T>} The computed store
 */
export function computed<T>(
	stores: ReadonlyStore<unknown> | ReadonlyArray<ReadonlyStore<unknown>>,
	compute: (...states: never[]) => T,
	options: ComputedOptions<T> = {}
): ReadonlyStore<T> {
	const many = Array.isArray(stores);
	// Copied, so that changing the array afterwards has no effect.
	const sources = many ? Array.from(stores as ReadonlyArray<ReadonlyStore<unknown>>) : [stores as ReadonlyStore<unknown>];
	sources.forEach(function (source, i) {
		assertStore(many ? `stores[${i}]` : 'stores', source);
	});
	assertFunction('computed', 'compute', compute);
	const equals = readOption(options, 'equals', Object.is as EqualityFn<T>);
	assertFunction('computed', 'options.equals', equals);

	if (!many) return derive(sources[0], compute as (state: unknown) => T, equals);
	return derive(
		combineStores(sources),
		function (states: unknown[]): T {
			return compute(...(states as never[]));
		},
		equals
	);
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
	// Not destructured: a polluted `Object.prototype.equals` must not decide which states are equal.
	const equals = readOption(options, 'equals', Object.is as EqualityFn<S>);

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

	new NotifierBrand(store, notifier);
	return store;
}

/**
 * Runs `fn`, holding back the notifications of every store it changes until it returns: each store then notifies its listeners once,
 * however many times `fn` changed it. Updating several stores (or one store several times) thus costs one notification per store, and
 * no subscriber ever sees a combination of states that `fn` only passed through (Preact signals' and MobX's `batch`, nanostores'
 * `batched`).
 *
 * - States change at once: `getState` returns the new state inside `fn`; only the listeners wait. When the outermost batch ends
 *   (batches nest), the stores notify in the order of their first change, even when `fn` threw.
 * - Covers every store of this module: {@link createStore} stores, and through them `select`, {@link computed}, {@link createMachine}
 *   (whose listeners then only see the last snapshot of the batch) and {@link createHistory} (the changes of a batch make one undo step,
 *   like `history.batch`). A derived store over several changed stores still recomputes and notifies once.
 * - Errors: those of `fn` and of the listeners are rethrown once every store has notified (the error itself, or an `AggregateError`,
 *   `fn`'s error first). `fn` must be synchronous: what an `async` function changes after its first `await` escapes the batch, so a
 *   returned thenable throws a `TypeError` (after the changes made so far have been notified).
 * @template R - The result type
 * @param {() => R} fn - The function making the changes
 * @returns {R} What `fn` returns
 * @throws {TypeError} when `fn` is not a function, or returns a thenable
 * @throws {AggregateError} when `fn` and listeners, or several listeners, threw
 * @example
 * const first = createStore('Ada');
 * const last = createStore('Lovelace');
 * const full = computed([first, last], function (f, l) { return `${f} ${l}`; });
 * const seen: string[] = [];
 * full.subscribe(function () { seen.push(full.getState()); });
 * batch(function () {
 * 	first.setState('Grace');
 * 	last.setState('Hopper');
 * });
 * seen; // => ['Grace Hopper'] // never 'Grace Lovelace'
 * batch(function () { return first.getState(); }); // => 'Grace'
 */
export function batch<R>(fn: () => R): R {
	assertFunction('batch', 'fn', fn);
	let result: R | undefined;
	let errors: unknown[] | undefined;

	batchDepth++;
	try {
		result = fn();
	} catch (error) {
		errors = [error];
	} finally {
		batchDepth--;
	}
	if (batchDepth === 0) {
		// Taken as a whole: a batch run by a listener holds back (and releases) its own notifications.
		const released = heldBack;
		heldBack = [];
		for (const release of released) {
			try {
				release(true);
			} catch (error) {
				errors = errors ?? [];
				errors.push(error);
			}
		}
	}
	if (errors !== undefined) throw errors.length === 1 ? errors[0] : new AggregateError(errors, `batch: ${errors.length} errors`);
	if (isThenable(result)) throw new TypeError('batch: `fn` must be synchronous, got a function returning a thenable');
	return result as R;
}

/**
 * An event of a {@link createMachine} machine: an object with a string `type`, plus any payload.
 */
export interface EventObject {
	/** The event type, matched against the keys of the current state's `on` table. */
	type: string;
}

/**
 * A transition of a {@link createMachine} config, taken when the current state receives its event and `guard` (if any) allows it.
 * Guards and updates must be pure: they receive the current context and the event object, and must not mutate them or send events.
 * Annotate the `event` parameter of either one with the full event type (`event: { type: 'RESOLVE'; data: string }`) to give the event
 * a typed payload: `send` then requires it.
 * @template C - The context type
 */
export interface TransitionConfig<C> {
	/** The state to enter. When omitted, the machine stays in its state and only `update` applies. */
	target?: string;
	/** Allows the transition when it returns `true`; any non-boolean result throws (an `async` guard would otherwise always pass). */
	guard?(context: C, event: EventObject): boolean;
	/** Returns the context of the next snapshot (return the same reference to keep it). */
	update?(context: C, event: EventObject): C;
}

/**
 * A state of a {@link createMachine} config: its transitions by event type, each a target state name or a {@link TransitionConfig}.
 * A state without transitions is final.
 * @template C - The context type
 */
export interface StateConfig<C> {
	/** The transitions, by event type. */
	on?: { [type: string]: string | TransitionConfig<C> };
}

/**
 * The configuration of {@link createMachine}.
 * @template T - The states, by name
 * @template C - The context type
 */
export interface MachineConfig<T, C> {
	/** The name of the initial state. */
	initial: keyof T & string;
	/** The initial context (extended state): any value, `undefined` when omitted. */
	context?: C;
	/** The states, by name. */
	states: T & MachineTargets<T>;
}

/**
 * The `on` table of a state config, or an empty table.
 * @template N - A state config
 */
type TransitionsOf<N> = N extends { on?: infer O } ? NonNullable<O> : Record<never, never>;

/**
 * Restricts every transition target of the states `T` to their names, so that an unknown target is a type error where it is written;
 * likewise an `event` parameter annotated with another event's `type` (see {@link EventTypeMismatch}).
 * @template T - The states, by name
 */
export type MachineTargets<T> = {
	[K in keyof T]: {
		on?: {
			[E in keyof TransitionsOf<T[K]>]: TransitionsOf<T[K]>[E] extends string
				? keyof T & string
				: { target?: keyof T & string } & EventTypeCheck<TransitionsOf<T[K]>[E], E>;
		};
	};
};

/**
 * The type error reported on a transition whose `update` or `guard` declares an `event` parameter of another type than the event
 * that triggers it (e.g. `RESOLVE: { update(context, event: { type: 'REJECT' }) {...} }`).
 * @template E - The event type of the transition
 */
export interface EventTypeMismatch<E> {
	/** Never present: its name is the error message. */
	'error: the `type` of the event parameter must be the event of the transition': E;
}

/**
 * {@link EventTypeMismatch} when the transition `X` of the event `E` declares an event of another type, `unknown` otherwise.
 * @template X - A transition object
 * @template E - The event type it is the transition of
 */
type EventTypeCheck<X, E> = DeclaredEvent<X> extends { type: infer D } ? ([E] extends [D] ? unknown : EventTypeMismatch<E>) : unknown;

/**
 * The type of the second parameter of a guard or update (`unknown` for anything else).
 * @template F - The function type
 */
type EventParameter<F> = F extends (context: never, event: infer E) => unknown ? E : unknown;

/**
 * The event type a transition declares through the `event` parameter of its `update` and `guard` (`unknown` when it declares none).
 * @template X - A transition: a target name or a transition object
 */
type DeclaredEvent<X> = X extends string
	? unknown
	: (X extends { update: infer U } ? EventParameter<U> : unknown) & (X extends { guard: infer G } ? EventParameter<G> : unknown);

/**
 * The event types handled by at least one of the states `T`.
 * @template T - The states, by name
 */
type EventTypes<T> = { [K in keyof T]: keyof TransitionsOf<T[K]> & string }[keyof T];

/**
 * Turns a union into the intersection of its members.
 * @template U - The union
 */
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/**
 * The event `E` as every state handling it declares it: the intersection of their declarations, since the sender does not know which
 * state the machine is in. (Each declaration is wrapped, so that an undeclared one, `unknown`, does not absorb the others in the union.)
 * @template T - The states, by name
 * @template E - The event type
 */
type DeclaredEventOf<T, E extends string> =
	Intersection<{ [K in keyof T]: E extends keyof TransitionsOf<T[K]> ? { event: DeclaredEvent<TransitionsOf<T[K]>[E]> } : never }[keyof T]> extends { event: infer D }
		? D
		: never;

/**
 * The union of the events handled by the states `T`: `{ type }` plus the payload declared for that type (by every state handling it).
 * @template T - The states, by name
 */
export type MachineEvent<T> = { [E in EventTypes<T>]: { type: E } & DeclaredEventOf<T, E> }[EventTypes<T>];

/**
 * What `send` and `can` accept: an event object, or the bare type of an event without required payload (`'FETCH'` for `{ type: 'FETCH' }`).
 * @template E - The event union
 */
export type MachineInput<E extends EventObject> = E | (E extends unknown ? ({ type: E['type'] } extends E ? E['type'] : never) : never);

/**
 * A snapshot of a {@link createMachine} machine. A new snapshot object is created on every transition, and only then.
 * @template S - The state names
 * @template C - The context type
 */
export interface MachineSnapshot<S extends string, C> {
	/** The current state. */
	readonly value: S;
	/** The current context. */
	readonly context: C;
}

/**
 * A finite state machine created by {@link createMachine}: a read-only store of {@link MachineSnapshot}s (so `subscribe`, `getState` and
 * `select` work as for {@link createStore}, `useSyncExternalStore` included), plus `send`, `can` and `matches`. Methods do not depend on
 * `this`.
 * @template S - The state names
 * @template C - The context type
 * @template E - The event union
 */
export interface Machine<S extends string, C, E extends EventObject> extends ReadonlyStore<MachineSnapshot<S, C>> {
	/** Sends an event: takes the matching transition of the current state, if any and allowed by its guard; otherwise ignores the event. */
	send(event: MachineInput<E>): void;
	/** Whether `send(event)` would take a transition now (the current state handles the event and its guard, if any, allows it). */
	can(event: MachineInput<E>): boolean;
	/** Whether the machine is in the state `value`. */
	matches(value: S): boolean;
}

/**
 * A transition as stored by {@link createMachine}.
 */
interface Transition {
	/** The state to enter, or `undefined` to stay. */
	readonly target: string | undefined;
	/** The guard, if any. */
	readonly guard: ((context: unknown, event: EventObject) => unknown) | undefined;
	/** The context update, if any. */
	readonly update: ((context: unknown, event: EventObject) => unknown) | undefined;
	/** Where the transition is in the config, for error messages. */
	readonly path: string;
}

/**
 * Tells whether a value is a non-null object (functions excluded).
 * @param {unknown} value - The value
 * @returns {boolean} `true` for objects and arrays
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Reads an own property (a polluted `Object.prototype` must not add states, transitions, guards or a context to a machine).
 * @param {Record<string, unknown>} object - The object
 * @param {string} key - The property name
 * @returns {unknown} The own property's value, or `undefined`
 */
function own(object: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * Combines the errors collected while processing into one: the error itself, or an `AggregateError`.
 * @param {unknown[]} errors - At least one error
 * @param {string} message - The message of the `AggregateError`
 * @returns {unknown} The error to throw
 */
function combine(errors: unknown[], message: string): unknown {
	return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

/**
 * Creates a tiny, fully typed finite state machine. State names, the context type and the events (with their payloads) are inferred
 * from the config, so sending an event that no state handles, or forgetting a required payload, is a type error. An event gets a
 * payload by annotating the `event` parameter of its `update` or `guard` with the full event type, `type` included (another `type`
 * is a type error on the transition). When several states handle the same event type, `send` requires every payload they declare,
 * since the sender does not know the current state:
 *
 * ```ts
 * const fetcher = createMachine({
 * 	initial: 'idle',
 * 	context: { data: '', retries: 0 },
 * 	states: {
 * 		idle: { on: { FETCH: 'loading' } },
 * 		loading: {
 * 			on: {
 * 				RESOLVE: { target: 'done', update(context, event: { type: 'RESOLVE'; data: string }) { return { ...context, data: event.data }; } },
 * 				REJECT: { target: 'idle', guard(context) { return context.retries < 3; }, update(context) { return { ...context, retries: context.retries + 1 }; } }
 * 			}
 * 		},
 * 		done: {}
 * 	}
 * });
 * fetcher.send('FETCH');
 * fetcher.send({ type: 'RESOLVE', data: 'hello' });
 * ```
 *
 * Write the config inline, as above. A config declared separately must keep its literal types: add `as const` (and, to type its
 * guards and updates, `satisfies Record<string, StateConfig<Context>>` on the states), otherwise its state names widen to `string`.
 *
 * Semantics:
 * - The config is validated (and copied) when the machine is created: an unknown `initial` or transition target throws then, not
 *   when the transition is first taken. Changing the config object afterwards has no effect.
 * - An event is handled by the transition of the *current* state with its `type` (own `on` keys, and the event's own `type`
 *   property: a class instance whose `type` is an inherited getter is not an event). Events the current state does
 *   not handle are ignored (`can` tells beforehand); so are events whose guard returns `false`. A transition without `target` stays in
 *   the state and only updates the context. A transition that changes neither the state nor the context reference is a no-op.
 * - Snapshots are `{ value, context }` objects, replaced on each transition and stable otherwise (as `useSyncExternalStore` requires):
 *   `useSyncExternalStore(machine.subscribe, machine.getState)`.
 * - Run-to-completion (actor semantics): an event sent by a listener (or a selector of `select`) while the machine processes another one is
 *   queued, and handled after every listener has seen the current transition; that `send` returns at once. So listeners observe every
 *   transition, in order. Loops throw a `RangeError` and drop the queue: events sent in reaction to events that were themselves sent
 *   in reaction to... 100 rounds deep (as for {@link createStore}), or 10,000 events handled by one outer `send`.
 * - Guards and updates must be pure: calling `send` from one throws. When a guard or update throws (or a guard returns a non-boolean),
 *   the machine stays in its snapshot, the remaining queued events are still handled, and the error is rethrown from the outer `send`
 *   afterwards, like listener errors (an `AggregateError` when there are several). `can` rethrows guard errors too.
 * - Deliberately left out, to stay small: entry/exit actions (subscribe and compare snapshots instead), delayed and eventless
 *   transitions, nested and parallel states.
 * @template T - The states, by name (inferred)
 * @template C - The context type (inferred from `context`; `undefined` without it)
 * @param {MachineConfig<T, C>} config - `initial`, the optional `context`, and the `states` with their `on` transitions
 * @returns {Machine<keyof T & string, C, MachineEvent<T>>} The machine, in its initial state
 * @throws {TypeError} when the config, a state, an `on` table, a transition, a state name, a guard or an update has the wrong type
 * @throws {RangeError} when `initial` or a transition target is not the name of a state
 * @example
 * const toggle = createMachine({
 * 	initial: 'off',
 * 	context: 0,
 * 	states: {
 * 		off: { on: { TOGGLE: { target: 'on', update(count) { return count + 1; } } } },
 * 		on: { on: { TOGGLE: 'off' } }
 * 	}
 * });
 * toggle.send('TOGGLE');
 * toggle.getState(); // => { value: 'on', context: 1 }
 * toggle.matches('on'); // => true
 * toggle.can({ type: 'TOGGLE' }); // => true
 * toggle.send('TOGGLE');
 * toggle.send('TOGGLE');
 * toggle.getState(); // => { value: 'on', context: 2 }
 * createMachine({ initial: 'a', states: { a: { on: { GO: 'b' as 'a' } } } }); // throws RangeError
 */
export function createMachine<const T extends Record<string, StateConfig<C>>, C = undefined>(config: MachineConfig<T, C>): Machine<keyof T & string, C, MachineEvent<T>> {
	if (!isObject(config)) throw new TypeError(`createMachine: \`config\` must be an object, got ${describe(config)}`);
	const initial = own(config, 'initial');
	const context = own(config, 'context');
	const states = own(config, 'states');
	if (!isObject(states)) throw new TypeError(`createMachine: \`config.states\` must be an object, got ${describe(states)}`);

	// Transitions by state, then by event type: `Map`s, so that names such as `__proto__` or `toString` are plain keys.
	const table = new Map<string, Map<string, Transition>>();
	const names = Object.keys(states);
	for (const name of names) table.set(name, new Map());

	/**
	 * Throws unless `value` names a state.
	 * @param {string} path - Where the value is in the config
	 * @param {unknown} value - The value
	 * @returns {void}
	 * @throws {TypeError} when `value` is not a string
	 * @throws {RangeError} when no state has that name
	 */
	function assertState(path: string, value: unknown): asserts value is string {
		if (typeof value !== 'string') throw new TypeError(`createMachine: \`${path}\` must be a state name, got ${describe(value)}`);
		if (!table.has(value)) throw new RangeError(`createMachine: \`${path}\` must be the name of a state, got ${value}`);
	}

	for (const name of names) {
		const path = `config.states.${name}`;
		const state = own(states, name);
		if (!isObject(state)) throw new TypeError(`createMachine: \`${path}\` must be an object, got ${describe(state)}`);
		const on = own(state, 'on');
		if (on === undefined) continue;
		if (!isObject(on)) throw new TypeError(`createMachine: \`${path}.on\` must be an object, got ${describe(on)}`);
		for (const type of Object.keys(on)) {
			const at = `${path}.on.${type}`;
			const spec = own(on, type);
			let target = spec;
			let guard: unknown;
			let update: unknown;
			if (isObject(spec)) {
				target = own(spec, 'target');
				guard = own(spec, 'guard');
				update = own(spec, 'update');
				if (target !== undefined) assertState(`${at}.target`, target);
				if (guard !== undefined) assertFunction('createMachine', `${at}.guard`, guard);
				if (update !== undefined) assertFunction('createMachine', `${at}.update`, update);
			} else if (typeof spec === 'string') assertState(at, spec);
			else throw new TypeError(`createMachine: \`${at}\` must be a state name or a transition object, got ${describe(spec)}`);
			(table.get(name) as Map<string, Transition>).set(type, {
				target: target as string | undefined,
				guard: guard as Transition['guard'],
				update: update as Transition['update'],
				path: at
			});
		}
	}
	assertState('config.initial', initial);

	const store = createStore<MachineSnapshot<string, unknown>>({ value: initial, context });
	// Events waiting to be handled (with their types, read once, and their round: 0 for an event sent from outside, `n + 1` for one
	// sent by a listener while an event of round `n` was handled), the round being handled, and whether `send` is handling events or
	// running a guard or update.
	const queue: Array<[string, EventObject, number]> = [];
	let round = 0;
	let processing = false;
	let evaluating = false;

	/**
	 * Validates an event and reads its type once (an own property: a polluted `Object.prototype.type` must not turn `{}` into an event).
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {unknown} event - An event type or an event object
	 * @returns {[string, EventObject]} The type and the event object (`{ type }` for a bare type)
	 * @throws {TypeError} when `event` is neither a string nor an object with a string `type`
	 */
	function read(caller: string, event: unknown): [string, EventObject] {
		if (typeof event === 'string') return [event, { type: event }];
		const type = isObject(event) ? own(event, 'type') : undefined;
		if (typeof type !== 'string') throw new TypeError(`${caller}: \`event\` must be an event type or an object with a string \`type\`, got ${describe(event)}`);
		return [type, event as EventObject];
	}

	/**
	 * Calls a guard or update, during which `send` is forbidden.
	 * @param {(context: unknown, event: EventObject) => unknown} fn - The guard or update
	 * @param {unknown} current - The current context
	 * @param {EventObject} event - The event
	 * @returns {unknown} What `fn` returned
	 */
	function evaluate(fn: (context: unknown, event: EventObject) => unknown, current: unknown, event: EventObject): unknown {
		const outer = evaluating;
		evaluating = true;
		try {
			return fn(current, event);
		} finally {
			evaluating = outer;
		}
	}

	/**
	 * Finds the transition the current snapshot takes for an event, running its guard.
	 * @param {string} caller - Name of the method, used in the error message
	 * @param {MachineSnapshot<string, unknown>} snapshot - The current snapshot
	 * @param {string} type - The event type
	 * @param {EventObject} event - The event
	 * @returns {Transition | undefined} The transition, or `undefined` when the event is ignored
	 * @throws {TypeError} when the guard returns a non-boolean
	 */
	function find(caller: string, snapshot: MachineSnapshot<string, unknown>, type: string, event: EventObject): Transition | undefined {
		const transition = (table.get(snapshot.value) as Map<string, Transition>).get(type);
		if (transition === undefined || transition.guard === undefined) return transition;
		const allowed = evaluate(transition.guard, snapshot.context, event);
		if (typeof allowed !== 'boolean') throw new TypeError(`${caller}: the guard of \`${transition.path}\` must return a boolean, got ${describe(allowed)}`);
		return allowed ? transition : undefined;
	}

	/**
	 * Handles one event: takes its transition, if any, and notifies the listeners.
	 * @param {string} type - The event type
	 * @param {EventObject} event - The event
	 * @returns {void}
	 */
	function handle(type: string, event: EventObject): void {
		const snapshot = store.getState();
		const transition = find('send', snapshot, type, event);
		if (transition === undefined) return;
		const next = transition.update === undefined ? snapshot.context : evaluate(transition.update, snapshot.context, event);
		const value = transition.target ?? snapshot.value;
		if (value !== snapshot.value || !Object.is(next, snapshot.context)) store.setState({ value, context: next });
	}

	return {
		getState: store.getState as () => MachineSnapshot<keyof T & string, C>,
		subscribe: store.subscribe,
		select: store.select as Machine<keyof T & string, C, MachineEvent<T>>['select'],

		send(event: MachineInput<MachineEvent<T>>): void {
			const [type, object] = read('send', event);
			if (evaluating) throw new Error('send: guards and updates must not send events');
			queue.push([type, object, processing ? round + 1 : 0]);
			if (processing) return;

			let errors: unknown[] | undefined;
			processing = true;
			try {
				for (let i = 0; i < queue.length; i++) {
					round = queue[i][2];
					// A loop: listeners reacting to the events their own events caused, 100 rounds deep (like the rounds of `createStore`),
					// or fanning out (every round sending several events) to 10,000 events.
					if (round === MAX_ROUNDS || i === MAX_ROUNDS * MAX_ROUNDS) {
						const message = `send: listeners kept sending events (${round === MAX_ROUNDS ? `${MAX_ROUNDS} consecutive rounds` : `${i} events`})`;
						throw errors === undefined ? new RangeError(message) : new RangeError(message, { cause: combine(errors, `send: ${errors.length} events threw`) });
					}
					try {
						handle(queue[i][0], queue[i][1]);
					} catch (error) {
						errors = errors ?? [];
						errors.push(error);
					}
				}
			} finally {
				queue.length = 0;
				processing = false;
			}
			if (errors !== undefined) throw combine(errors, `send: ${errors.length} events threw`);
		},

		can(event: MachineInput<MachineEvent<T>>): boolean {
			const [type, object] = read('can', event);
			return find('can', store.getState(), type, object) !== undefined;
		},

		matches(value: keyof T & string): boolean {
			return store.getState().value === value;
		}
	};
}

/**
 * The undo/redo status published by a {@link StoreHistory}: a new object whenever a count changes, the same one otherwise.
 */
export interface HistoryState {
	/** Whether `undo()` would change the state (`undoCount > 0`). */
	readonly canUndo: boolean;
	/** Whether `redo()` would change the state (`redoCount > 0`). */
	readonly canRedo: boolean;
	/** The number of recorded steps `undo()` can go back. */
	readonly undoCount: number;
	/** The number of undone steps `redo()` can replay. */
	readonly redoCount: number;
}

/**
 * Options accepted by {@link createHistory}.
 */
export interface HistoryOptions {
	/**
	 * The maximum number of undo steps kept: when a change exceeds it, the oldest step is forgotten. An integer `>= 1` or `Infinity`.
	 * @default Infinity
	 */
	limit?: number;
	/**
	 * Changes made less than this many milliseconds after the previous recorded one are merged into its undo step (typing, dragging),
	 * so one `undo()` reverts the whole burst. `0` records every change as its own step.
	 * @default 0
	 */
	coalesce?: number;
	/**
	 * Clock used by `coalesce`, in milliseconds. Defaults to `Date.now`; inject a fake clock for deterministic tests. A clock going
	 * backwards (a wall-clock adjustment) never merges changes.
	 * @default Date.now
	 */
	now?: () => number;
}

/**
 * The part of a store {@link createHistory} relies on: any {@link createStore} store, or a compatible one (whose listeners may receive
 * arguments, which are ignored). Its methods are called on the store object, so class-based stores work too.
 * @template S - The state type
 */
export type HistorySource<S> = Pick<Store<S>, 'getState' | 'setState' | 'subscribe'>;

/**
 * Undo/redo for a store, created by {@link createHistory}: a read-only store of {@link HistoryState}s (so the undo and redo buttons of
 * a UI can subscribe to it, or to `select(function (h) { return h.canUndo; })`), plus the commands. Methods do not depend on `this`.
 */
export interface StoreHistory extends ReadonlyStore<HistoryState> {
	/** Restores the state before the last recorded step; returns `false` (and does nothing) when there is none. */
	undo(): boolean;
	/** Replays the last undone step; returns `false` (and does nothing) when there is none. */
	redo(): boolean;
	/**
	 * Runs `fn`, which must be synchronous, and records every change it makes to the store as one undo step; returns what `fn` returns.
	 * Nests. Throws a `TypeError` (after `fn` ran) when `fn` returns a promise or another thenable: changes made after an `await` would
	 * escape the batch.
	 */
	batch<R>(fn: () => R): R;
	/** Forgets every undo and redo step (the store keeps its state). */
	clear(): void;
	/** Stops recording and forgets every step: the history no longer references the store or its states. */
	dispose(): void;
}

/**
 * Tells whether a value is a thenable (a promise or promise-like object).
 * @param {unknown} value - The value
 * @returns {boolean} `true` when `value` is an object or function with a `then` method
 */
function isThenable(value: unknown): boolean {
	return ((typeof value === 'object' && value !== null) || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Adds undo/redo to a store (see {@link createStore}): every change of its state becomes an undo step, holding the previous state by
 * reference (states are meant to be immutable, so no copy is made). A new change clears the redo steps; `undo()` and `redo()` set the
 * state through the store, as one more change seen by its listeners, but never recorded as a new step.
 *
 * - One notification, one step: for a {@link createStore} store, a change and everything its listeners change in reaction (in any
 *   order, e.g. a listener keeping a derived field up to date) make one step, recorded once the notification has ended. Likewise, what
 *   listeners change in reaction to `undo()` or `redo()` belongs to the restored step: it neither adds a step nor clears the redo
 *   steps. States the store's `equals` deems equal make no step. Inside a {@link batch}, whose listeners run when it ends, everything
 *   the batch changes after `undo()` or `redo()` belongs to the restored step too, and a `history.batch` called after a change makes
 *   one step with it.
 * - Other stores do not tell when a notification ends: changes are recorded as the history's listener sees them, so a listener
 *   subscribed after the history that changes the state in reaction makes a step of its own (subscribe it before the history, or
 *   make the change in a `batch`); reactions to `undo()`/`redo()` are only attached to the restored step if the store notifies
 *   synchronously.
 * - `batch(fn)` turns every change made during the synchronous `fn` into one step (e.g. a "replace all"); `coalesce` merges rapid
 *   changes. A batch or burst that ends on the state it started from leaves no step.
 * - `limit` bounds the memory held: the oldest steps are dropped beyond it (amortized constant time).
 * - When the store's `setState` (or `equals`) throws during `undo()` or `redo()` without changing the state, the steps stay where
 *   they were. When a listener throws, the change is kept (as the store does) and so is the move.
 * - The history's own snapshot ({@link HistoryState}) is `useSyncExternalStore` friendly:
 *   `const { canUndo, canRedo } = useSyncExternalStore(history.subscribe, history.getState);`.
 * - Call `dispose()` when the history is no longer needed but the store lives on: the history stays subscribed to it until then.
 * @template S - The state type
 * @param {HistorySource<S>} store - The store to record (any object with `getState`, `setState` and `subscribe`)
 * @param {HistoryOptions} [options={}] - `limit` (default `Infinity`), `coalesce` (milliseconds, default `0`) and `now` (default `Date.now`)
 * @returns {StoreHistory} The history, empty
 * @throws {TypeError} when `store` lacks one of the methods, `store.subscribe` does not return a function, `limit` or `coalesce`
 * is not a number, `now` is not a function (or, when a change is recorded, `now()` does not return a number), or (from `batch`) `fn`
 * is not a function or returns a thenable
 * @throws {RangeError} when `limit` is not an integer `>= 1` or `Infinity`, or `coalesce` is negative or `NaN`
 * @example
 * const text = createStore('');
 * const history = createHistory(text);
 * text.setState('a');
 * text.setState('ab');
 * history.undo(); // => true
 * text.getState(); // => 'a'
 * history.getState(); // => { canUndo: true, canRedo: true, undoCount: 1, redoCount: 1 }
 * history.redo(); // => true
 * text.getState(); // => 'ab'
 * history.batch(function () {
 * 	text.setState('abc');
 * 	text.setState('abcd');
 * });
 * history.undo(); // => true
 * text.getState(); // => 'ab'
 * history.redo(); // => true
 * history.redo(); // => false
 * createHistory(text, { limit: 0 }); // throws RangeError
 */
export function createHistory<S>(store: HistorySource<S>, options: HistoryOptions = {}): StoreHistory {
	if (!isObject(store)) throw new TypeError(`createHistory: \`store\` must be a store, got ${describe(store)}`);
	const { getState, setState, subscribe } = store;
	assertFunction('createHistory', 'store.getState', getState);
	assertFunction('createHistory', 'store.setState', setState);
	assertFunction('createHistory', 'store.subscribe', subscribe);
	if (!isObject(options)) throw new TypeError(`createHistory: \`options\` must be an object, got ${describe(options)}`);
	// A polluted `Object.prototype` cannot set a limit or a coalescing window.
	const settings: HistoryOptions = options;
	const limit = readOption(settings, 'limit', Infinity);
	const coalesce = readOption(settings, 'coalesce', 0);
	const now = readOption(settings, 'now', Date.now);
	assertInteger('createHistory', 'options.limit', limit, 1, true);
	assertNumber('createHistory', 'options.coalesce', coalesce, coalesce >= 0, 'a number >= 0');
	assertFunction('createHistory', 'options.now', now);
	// Set for `createStore` stores only: tells when a notification has ended.
	const notifier = NotifierBrand.of(store);

	// The state the history last saw, the undo steps (oldest first, from index `start`: dropping the oldest one just advances `start`,
	// and the array is compacted once half of it is dropped) and the redo steps (most recent last).
	let present = getState.call(store);
	let past: S[] = [];
	let start = 0;
	let future: S[] = [];
	// When the last change was recorded (for `coalesce`), batch nesting depth, whether the current batch has recorded its step (only
	// read during a batch, which sets it first), and whether `undo`/`redo` is restoring a state (until the end of its notification).
	let lastChange = -Infinity;
	let depth = 0;
	let batched: boolean;
	let restoring = false;
	let disposed = false;

	/**
	 * Builds the published snapshot.
	 * @returns {HistoryState} The snapshot for the current steps
	 */
	function snapshot(): HistoryState {
		const undoCount = past.length - start;
		return { canUndo: undoCount > 0, canRedo: future.length > 0, undoCount, redoCount: future.length };
	}

	const status = createStore(snapshot(), {
		equals(a: HistoryState, b: HistoryState): boolean {
			return a.undoCount === b.undoCount && a.redoCount === b.redoCount;
		}
	});

	/**
	 * Publishes the snapshot (subscribers are only notified when a count changed).
	 * @returns {void}
	 */
	function publish(): void {
		status.setState(snapshot());
	}

	/**
	 * Drops the oldest undo step when there are more than `limit`.
	 * @returns {void}
	 */
	function trim(): void {
		if (past.length - start <= limit) return;
		// Release the dropped state now, rather than at the next compaction.
		(past as Array<S | undefined>)[start++] = undefined;
		if (start * 2 >= past.length) {
			past = past.slice(start);
			start = 0;
		}
	}

	/**
	 * Runs `callback` once the store's current notification has ended (right away for other stores, or outside a notification).
	 * @param {() => void} callback - The callback
	 * @returns {void}
	 */
	function later(callback: () => void): void {
		if (notifier === undefined || !notifier.defer(callback)) callback();
	}

	/**
	 * Reads the clock for `coalesce`.
	 * @returns {number} The current time
	 * @throws {TypeError} when `now()` does not return a number other than `NaN`
	 */
	function clock(): number {
		const time = now();
		if (typeof time !== 'number' || time !== time) throw new TypeError(`createHistory: \`now()\` must return a number, got ${time !== time ? 'NaN' : describe(time)}`);
		return time;
	}

	/**
	 * Records a change of the store's state not seen yet (once a notification has ended, and before every command so that a change
	 * whose notification is still running, e.g. a command called by one of its listeners, is never lost). While restoring, the change
	 * belongs to the restored step: it only becomes the present state.
	 * @returns {void}
	 */
	function record(): void {
		if (disposed) return;
		const next = getState.call(store);
		if (Object.is(next, present)) return;
		if (restoring) {
			present = next;
			return;
		}
		const time = coalesce > 0 && depth === 0 ? clock() : 0;
		const elapsed = time - lastChange;
		// Merged into the current step: a later change of the same batch, or a change within `coalesce` ms after the previous one.
		const merge = depth > 0 ? batched : elapsed >= 0 && elapsed < coalesce;
		// A merged change back to the state the step restores: the batch or burst changed nothing in the end, so the step goes.
		const undone = merge && Object.is(next, past[past.length - 1]) && past.length > start;
		if (undone) past.pop();
		else if (!merge) {
			past.push(present);
			trim();
		}
		present = next;
		future = [];
		lastChange = undone ? -Infinity : time;
		batched = !undone;
		publish();
	}

	/**
	 * Ends a restoration once its notification has ended: what listeners changed meanwhile belongs to the restored step.
	 * @returns {void}
	 */
	function settle(): void {
		record();
		restoring = false;
		publish();
	}

	/**
	 * Sets the store's state to a recorded one, without recording it as a change. The steps have already been moved: `rollback`
	 * moves them back when the store refused the state.
	 * @param {S} state - The state to restore
	 * @param {() => void} rollback - Undoes the move of the steps
	 * @returns {true} Always `true`
	 */
	function restore(state: S, rollback: () => void): true {
		const before = present;
		present = state;
		lastChange = -Infinity;
		batched = false;
		restoring = true;
		try {
			// Wrapped: `setState` would call a function-valued state as an updater.
			setState.call(store, function (): S {
				return state;
			});
		} catch (error) {
			// The store's `setState` (or `equals`) threw before changing the state: the step stays where it was.
			if (Object.is(getState.call(store), before)) {
				rollback();
				present = before;
			}
			throw error;
		} finally {
			later(settle);
		}
		return true;
	}

	/**
	 * The store listener.
	 * @returns {void}
	 */
	function onChange(): void {
		later(record);
	}

	const unsubscribe: unknown = subscribe.call(store, onChange);
	assertFunction('createHistory', 'store.subscribe()', unsubscribe);

	return {
		getState: status.getState,
		subscribe: status.subscribe,
		select: status.select,

		undo(): boolean {
			record();
			if (past.length === start) return false;
			const target = past.pop() as S;
			future.push(present);
			return restore(target, function (): void {
				future.pop();
				past.push(target);
			});
		},

		redo(): boolean {
			record();
			if (future.length === 0) return false;
			const target = future.pop() as S;
			// No trimming: `undo` took this step off `past`, so `past` is back to at most `limit` steps.
			past.push(present);
			return restore(target, function (): void {
				past.pop();
				future.push(target);
			});
		},

		batch<R>(fn: () => R): R {
			assertFunction('batch', 'fn', fn);
			// Called by a listener of the store: everything until the notification ends already makes one step with the change that
			// triggered it, and recording now would split it in two.
			if (notifier !== undefined && notifier.defer(record)) {
				const reaction = fn();
				if (isThenable(reaction)) throw new TypeError('batch: `fn` must be synchronous, got a function returning a thenable');
				return reaction;
			}
			record();
			if (depth++ === 0) batched = false;
			let result: R;
			try {
				result = fn();
			} finally {
				record();
				// A change right after the batch starts a new step.
				if (--depth === 0) lastChange = -Infinity;
			}
			if (isThenable(result)) throw new TypeError('batch: `fn` must be synchronous, got a function returning a thenable');
			return result;
		},

		clear(): void {
			record();
			past = [];
			start = 0;
			future = [];
			lastChange = -Infinity;
			batched = false;
			publish();
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			past = [];
			start = 0;
			future = [];
			present = undefined as S;
			publish();
		}
	};
}

/**
 * A synchronous string storage, such as `localStorage` or `sessionStorage` (or any object with these three methods: an in-memory
 * `Map` wrapper for tests and servers, a cookie or a native storage adapter...).
 */
export interface PersistStorage {
	/** Returns the value stored under `key`, or `null` (or `undefined`) when there is none. */
	getItem(key: string): string | null | undefined;
	/** Stores `value` under `key`. */
	setItem(key: string, value: string): void;
	/** Removes `key`. */
	removeItem(key: string): void;
}

/**
 * What {@link persistStore} stores under its key (once serialized): the persisted state and the version of its shape.
 * @template P - The persisted state type
 */
export interface PersistedState<P> {
	/** The persisted state (the store's state, or what `partialize` returned). */
	state: P;
	/** The `version` option at the time it was written. */
	version: number;
}

/**
 * Options accepted by {@link persistStore}.
 * @template S - The store's state type
 * @template P - The persisted state type (what `partialize` returns; the whole state by default)
 */
export interface PersistOptions<S, P = S> {
	/** The storage key. */
	key: string;
	/**
	 * Where the state is kept. Defaults to `globalThis.localStorage` when it is available (a browser, or Node with `--localstorage-file`);
	 * otherwise nothing is read or written.
	 */
	storage?: PersistStorage;
	/** Turns a {@link PersistedState} into the stored string. Defaults to `JSON.stringify`. */
	serialize?: (value: PersistedState<P>) => string;
	/**
	 * Turns the stored string back into a {@link PersistedState}. Defaults to `JSON.parse`, dropping every `__proto__` key and every `constructor`
	 * object with a `prototype` key, so that the parsed state cannot pollute prototypes when it is later copied with `Object.assign` or a
	 * deep merge.
	 */
	deserialize?: (text: string) => unknown;
	/**
	 * The version of the persisted state's shape (an integer `>= 0`): bump it when the shape changes, and give `migrate`.
	 * @default 0
	 */
	version?: number;
	/**
	 * Converts a state persisted with another version (given as the second argument) into the current shape. Without it, a state of
	 * another version is discarded (and reported to `onError`).
	 */
	migrate?: (persisted: unknown, version: number) => P;
	/**
	 * Selects what is persisted (e.g. `function (s) { return { theme: s.theme }; }`); returning `undefined` removes the key from the
	 * storage. Defaults to the whole state.
	 */
	partialize?: (state: S) => P;
	/**
	 * Combines the persisted state with the store's current state when hydrating. Defaults to a shallow merge when both are plain
	 * objects (`{ ...current, ...persisted }`, without `__proto__` keys: keys added to the state since it was persisted keep their
	 * initial values), and to the persisted state otherwise. Stored data is untrusted input: validate it here or in `migrate`.
	 */
	merge?: (persisted: P, current: S) => S;
	/**
	 * Delays writes by this many milliseconds: every change made meanwhile is written at once, so a burst of changes (typing, dragging)
	 * costs one write, and a continuous stream of changes one write per `debounce` milliseconds. `0` writes on every change, synchronously.
	 * A pending write is made by the dispose function.
	 * @default 0
	 */
	debounce?: number;
	/**
	 * When `true`, follows the changes other tabs (or windows) make to the key: on each `storage` event for it, the new text is
	 * hydrated into the store as at startup (deserialized, migrated and merged into the current state), without being written back (not
	 * even once migrated: the other tab may run another version).
	 * Only native storages (`localStorage`, `sessionStorage`) fire these events, and only in browsers; elsewhere the option does nothing.
	 * Removing the key in another tab leaves the state as it is. The store must notify synchronously (as this module's stores do), so
	 * that hydrating does not echo the state back to the other tabs.
	 * @default false
	 */
	sync?: boolean;
	/**
	 * Receives the errors of reading, parsing, migrating, merging, serializing and writing, which never propagate (a storage may throw
	 * when it is full or disabled, and stored data may be corrupt). By default they are ignored.
	 */
	onError?: (error: unknown) => void;
}

/**
 * Tells whether a value has the three methods of a {@link PersistStorage}.
 * @param {unknown} value - The value
 * @returns {boolean} `true` when `value` is a storage
 */
function isStorage(value: unknown): value is PersistStorage {
	return isObject(value) && typeof value.getItem === 'function' && typeof value.setItem === 'function' && typeof value.removeItem === 'function';
}

/**
 * Returns `globalThis.localStorage` when it is a usable storage.
 * @returns {PersistStorage | undefined} The storage, or `undefined`
 */
function defaultStorage(): PersistStorage | undefined {
	try {
		const storage: unknown = (globalThis as { localStorage?: unknown }).localStorage;
		return isStorage(storage) ? storage : undefined;
	} catch {
		// Reading `localStorage` throws a `SecurityError` where storage is disabled (blocked cookies, sandboxed iframes).
		return undefined;
	}
}

/**
 * The default `deserialize`: `JSON.parse`, dropping prototype-pollution keys (`__proto__`, and `constructor` objects with a `prototype`)
 * at every depth.
 * @param {string} text - The stored text
 * @returns {unknown} The parsed value
 * @throws {SyntaxError} when `text` is not JSON
 */
function parseJSON(text: string): unknown {
	return JSON.parse(text, withoutProtoKeys);
}

/**
 * The default `merge`: a shallow merge of two plain objects (never copying a `__proto__` key), or the persisted state.
 * @template S - The state type
 * @param {unknown} persisted - The persisted state
 * @param {S} current - The store's current state
 * @returns {S} The merged state
 * @throws {TypeError} when the current state is a plain object and the persisted one is not
 */
function mergeShallow<S>(persisted: unknown, current: S): S {
	if (!isPlainObject(current)) return persisted as S;
	if (!isPlainObject(persisted)) throw new TypeError(`persistStore: the persisted state must be a plain object like the current one, got ${describe(persisted)}`);
	const merged: Record<string, unknown> = { ...current };
	// Plain assignments, never through a `__proto__` key (it would replace the prototype, as `Object.assign` does).
	for (const key of Object.keys(persisted)) if (key !== '__proto__') merged[key] = persisted[key];
	return merged as S;
}

/**
 * Returns its argument (the default `partialize`).
 * @template T - The value type
 * @param {T} value - The value
 * @returns {T} `value`
 */
function identity<T>(value: T): T {
	return value;
}

/**
 * Persists a store (see {@link createStore}) in a synchronous storage, `localStorage` by default, like Zustand's `persist` middleware
 * but for any store with `getState`, `setState` and `subscribe`. Returns a function that stops persisting (making a pending write
 * first).
 *
 * - Hydration, right away and synchronously: the stored value is deserialized, migrated when its `version` differs, merged into the
 *   current state (`merge`) and set on the store, which notifies its listeners as for any change. A migrated state is written back at
 *   once, in the current `version`. When nothing is stored, the store keeps its state (nothing is written until it changes).
 * - Never throws on bad storage: a missing key, a storage that throws (disabled, full, private mode), corrupt or foreign data, a
 *   version without `migrate`, or a failing `migrate`/`merge`/`serialize` leaves the store's state as it was (or skips the write) and
 *   reports the error to `onError`. Only invalid arguments throw.
 * - Writes follow the store's changes (debounced with `debounce`) and are skipped when the serialized text is the one the storage
 *   already holds. Only the `partialize`d part of the state is written, as `serialize({ state, version })`.
 * - Safe with untrusted stored data: the default `deserialize` drops `__proto__` keys and `constructor.prototype` objects at every
 *   depth, and the default `merge` copies
 *   own keys with plain assignments. A custom `deserialize` or `merge` must take the same care.
 * - Changes made in other tabs (`storage` events) are followed with `sync: true`, and ignored otherwise.
 * @template S - The store's state type
 * @template P - The persisted state type
 * @param {Pick<Store<S>, 'getState' | 'setState' | 'subscribe'>} store - The store (any object with `getState`, `setState` and `subscribe`)
 * @param {PersistOptions<S, P>} options - `key` (required), and `storage`, `serialize`, `deserialize`, `version`, `migrate`,
 * `partialize`, `merge`, `debounce`, `sync` and `onError`
 * @returns {Unsubscribe} Stops persisting: writes a pending change, then unsubscribes from the store and from `storage` events (idempotent)
 * @throws {TypeError} when `store` lacks one of the methods, `options` is not an object, `key` is not a string, `storage` is not a
 * storage, a function option is not a function, `version` or `debounce` is not a number, or `sync` is not a boolean
 * @throws {RangeError} when `version` is not an integer `>= 0`, or `debounce` is not a usable delay
 * @example
 * // An in-memory storage (in a browser, omit `storage` to use localStorage)
 * const memory = new Map<string, string>([['settings', '{"state":{"theme":"dark"},"version":0}']]);
 * const storage = {
 * 	getItem(key: string) { return memory.get(key) ?? null; },
 * 	setItem(key: string, value: string) { memory.set(key, value); },
 * 	removeItem(key: string) { memory.delete(key); }
 * };
 * const settings = createStore({ theme: 'light', fontSize: 14 });
 * const stop = persistStore(settings, { key: 'settings', storage });
 * settings.getState(); // => { theme: 'dark', fontSize: 14 } // hydrated, merged with the new `fontSize` key
 * settings.setState({ theme: 'dark', fontSize: 16 });
 * memory.get('settings'); // => '{"state":{"theme":"dark","fontSize":16},"version":0}'
 * stop();
 * @example
 * // Persist a slice, with a migration from version 0 (where the theme was a boolean)
 * const writes: string[] = [];
 * const storage = {
 * 	getItem() { return '{"state":{"dark":true},"version":0}'; },
 * 	setItem(key: string, value: string) { writes.push(value); },
 * 	removeItem() { writes.push('(removed)'); }
 * };
 * const ui = createStore({ theme: 'light', menuOpen: false });
 * persistStore(ui, {
 * 	key: 'ui',
 * 	storage,
 * 	version: 1,
 * 	partialize(state) { return { theme: state.theme }; },
 * 	migrate(persisted, version) { return version === 0 ? { theme: (persisted as { dark: boolean }).dark ? 'dark' : 'light' } : (persisted as { theme: string }); }
 * });
 * ui.getState(); // => { theme: 'dark', menuOpen: false }
 * ui.setState({ theme: 'dark', menuOpen: true });
 * ui.setState({ theme: 'dark', menuOpen: false }); // same persisted slice: no write
 * writes; // => ['{"state":{"theme":"dark"},"version":1}']
 */
export function persistStore<S, P = S>(store: Pick<Store<S>, 'getState' | 'setState' | 'subscribe'>, options: PersistOptions<S, P>): Unsubscribe {
	if (!isObject(store)) throw new TypeError(`persistStore: \`store\` must be a store, got ${describe(store)}`);
	const { getState, setState, subscribe } = store;
	assertFunction('persistStore', 'store.getState', getState);
	assertFunction('persistStore', 'store.setState', setState);
	assertFunction('persistStore', 'store.subscribe', subscribe);
	if (!isObject(options)) throw new TypeError(`persistStore: \`options\` must be an object, got ${describe(options)}`);
	const settings: PersistOptions<S, P> = options;
	const key = readOption(settings, 'key');
	if (typeof key !== 'string') throw new TypeError(`persistStore: \`options.key\` must be a string, got ${describe(key)}`);
	const version = readOption(settings, 'version', 0);
	const debounce = readOption(settings, 'debounce', 0);
	const serialize = readOption(settings, 'serialize', JSON.stringify as (value: PersistedState<P>) => string);
	const deserialize = readOption(settings, 'deserialize', parseJSON);
	const migrate = readOption(settings, 'migrate');
	const partialize = readOption(settings, 'partialize', identity as (state: S) => P);
	const merge = readOption(settings, 'merge', mergeShallow as (persisted: P, current: S) => S);
	const onError = readOption(settings, 'onError');
	const sync = readOption(settings, 'sync', false);
	if (typeof sync !== 'boolean') throw new TypeError(`persistStore: \`options.sync\` must be a boolean, got ${describe(sync)}`);
	assertInteger('persistStore', 'options.version', version);
	assertDelay('persistStore', 'options.debounce', debounce);
	assertFunction('persistStore', 'options.serialize', serialize);
	assertFunction('persistStore', 'options.deserialize', deserialize);
	if (migrate !== undefined) assertFunction('persistStore', 'options.migrate', migrate);
	assertFunction('persistStore', 'options.partialize', partialize);
	assertFunction('persistStore', 'options.merge', merge);
	if (onError !== undefined) assertFunction('persistStore', 'options.onError', onError);
	const given = readOption(settings, 'storage');
	if (given !== undefined && !isStorage(given)) {
		throw new TypeError(`persistStore: \`options.storage\` must have getItem, setItem and removeItem methods, got ${describe(given)}`);
	}
	const storage = given ?? defaultStorage();
	// Nowhere to persist: nothing to read, write or stop.
	if (storage === undefined) return identity as Unsubscribe;

	// The text the storage is known to hold under `key` (`null`: none), so that writing it again is skipped.
	let stored: string | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active = true;
	// Whether a `storage` event is being hydrated (the store's notification then writes nothing), and the state it set.
	let syncing = false;
	let synced: S;

	/**
	 * Reports an error to `onError`, if any.
	 * @param {unknown} error - The error
	 * @returns {void}
	 */
	function report(error: unknown): void {
		if (onError !== undefined) onError(error);
	}

	/**
	 * Reads, migrates and merges a stored state into the store. Never throws: errors go to `onError`.
	 * @param {() => unknown} read - Returns the stored text (`null` or `undefined` for none)
	 * @returns {boolean} Whether a state was set on the store
	 */
	function hydrate(read: () => unknown): boolean {
		try {
			const text = read();
			if (text === null || text === undefined) return false;
			if (typeof text !== 'string') throw new TypeError(`persistStore: \`storage.getItem\` must return a string or null, got ${describe(text)}`);
			stored = text;
			const persisted = deserialize(text);
			// Each field is read once (a custom `deserialize` may return getters).
			const from = isObject(persisted) ? own(persisted, 'version') : undefined;
			if (!isObject(persisted) || !Object.hasOwn(persisted, 'state') || typeof from !== 'number') {
				throw new TypeError(`persistStore: the stored value must be a { state, version } object, got ${describe(persisted)}`);
			}
			let state = persisted.state;
			if (from !== version) {
				if (migrate === undefined) throw new RangeError(`persistStore: the stored state has version ${from}, not ${version}, and no \`migrate\` was given`);
				state = migrate(state, from);
			}
			const next = merge(state as P, getState.call(store));
			// The storage still holds the old version: replace it with the migrated state now (not with whatever the store holds after
			// `setState`, which a store may defer or ignore), or every load would migrate it again, and fail once `migrate` is gone. Not
			// for a state another tab wrote: that tab runs another version, and would migrate it back and write it again, endlessly.
			if (from !== version && !syncing) writeState(next);
			synced = next;
			// Wrapped: `setState` would call a function-valued state as an updater.
			setState.call(store, function (): S {
				return next;
			});
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	}

	/**
	 * Reads the stored text.
	 * @returns {unknown} What `storage.getItem` returned
	 */
	function readStorage(): unknown {
		return (storage as PersistStorage).getItem(key as string);
	}

	/**
	 * The `storage` event listener (with `sync`): hydrates what another tab wrote under the key.
	 * @param {unknown} event - The event
	 * @returns {void}
	 */
	function onStorage(event: unknown): void {
		const { key: changed, newValue, storageArea } = event as { key?: unknown; newValue?: unknown; storageArea?: unknown };
		// `key` is `null` when another tab cleared the whole storage.
		if (storageArea !== storage || (changed !== key && changed !== null)) return;
		// The storage no longer holds what this tab wrote (`hydrate` records what it holds now, when it is a string).
		stored = null;
		const before = getState.call(store);
		syncing = true;
		let set: boolean;
		try {
			set = hydrate(function (): unknown {
				return newValue;
			});
		} finally {
			syncing = false;
		}
		// What this tab's listeners changed in reaction is a change of its own, written as usual; a state the store did not take (its
		// `equals` deemed it equal to the current one) is not, or two tabs whose states only differ in key order would echo each other.
		const after = getState.call(store);
		if (set && !Object.is(after, synced) && !Object.is(after, before)) onChange();
	}

	/**
	 * Writes the store's current state (see {@link writeState}): the store listener, possibly debounced.
	 * @returns {void}
	 */
	function write(): void {
		timer = undefined;
		writeState(getState.call(store));
	}

	/**
	 * Writes a (partialized) state, unless the storage already holds the same text. Never throws: errors go to `onError`.
	 * @param {S} current - The state to write
	 * @returns {void}
	 */
	function writeState(current: S): void {
		try {
			const state = partialize(current);
			if (state === undefined) {
				if (stored === null) return;
				(storage as PersistStorage).removeItem(key as string);
				stored = null;
				return;
			}
			const text: unknown = serialize({ state, version: version as number });
			if (typeof text !== 'string') throw new TypeError(`persistStore: \`serialize\` must return a string, got ${describe(text)}`);
			if (text === stored) return;
			(storage as PersistStorage).setItem(key as string, text);
			stored = text;
		} catch (error) {
			report(error);
		}
	}

	/**
	 * The store listener: writes now, or schedules a write.
	 * @returns {void}
	 */
	function onChange(): void {
		if (syncing) return;
		if (debounce === 0) write();
		else if (timer === undefined) timer = setTimeout(write, debounce);
	}

	hydrate(readStorage);
	const unsubscribe: unknown = subscribe.call(store, onChange);
	assertFunction('persistStore', 'store.subscribe()', unsubscribe);
	const events = sync ? (globalThis as { addEventListener?: unknown; removeEventListener?: unknown }) : undefined;
	const listening = events !== undefined && typeof events.addEventListener === 'function' && typeof events.removeEventListener === 'function';
	if (listening) (events.addEventListener as (type: string, listener: (event: unknown) => void) => void)('storage', onStorage);

	return function (): void {
		if (!active) return;
		active = false;
		unsubscribe();
		if (listening) (events.removeEventListener as (type: string, listener: (event: unknown) => void) => void)('storage', onStorage);
		if (timer === undefined) return;
		clearTimeout(timer);
		write();
	};
}
