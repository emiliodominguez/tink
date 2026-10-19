import type { Unsubscribe } from '../emitter/index.js';
import { assertFunction, assertInteger, assertNumber, describe, readOption } from '../utils/assert.js';

export type { Unsubscribe } from '../emitter/index.js';

/**
 * Number of notification rounds a single `setState` may trigger (through listeners that keep updating the state) before giving up;
 * also the number of events a single machine `send` may handle (through listeners that keep sending events).
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
	/** While a notification is running, schedules `callback` (once, however often it is deferred) for when its last round ends. */
	defer(callback: () => void): boolean;
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
	// Whether the current round already works on a copy (so that a round copies the list once, not once per change).
	let copied = false;
	// Set by every `notify` call before it is read.
	let pending: boolean;
	// Callbacks to run once the current notification has finished (see `defer`).
	let deferred: Array<() => void> = [];

	/**
	 * Calls every active listener of the current list once.
	 * @returns {unknown[] | undefined} The errors thrown by listeners, if any
	 */
	function round(): unknown[] | undefined {
		const snapshot = subscriptions;
		let errors: unknown[] | undefined;

		copied = false;

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

	/**
	 * Runs the deferred callbacks, once the notification has finished.
	 * @param {unknown[] | undefined} errors - The errors collected so far
	 * @returns {unknown[] | undefined} `errors`, plus those of the callbacks
	 */
	function settle(errors: unknown[] | undefined): unknown[] | undefined {
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
	 * Before a change during a round, replaces the list the round iterates with a copy (once per round).
	 * @returns {void}
	 */
	function copyOnWrite(): void {
		if (!notifying || copied) return;
		subscriptions = subscriptions.slice();
		copied = true;
	}

	return {
		subscribe(listener: () => void): Unsubscribe {
			const subscription: Subscription = { listener, active: true };

			copyOnWrite();
			subscriptions.push(subscription);

			return function (): void {
				if (!subscription.active) return;

				subscription.active = false;
				copyOnWrite();
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
					errors = settle(errors);
					const message = `store: listeners changed the state during ${MAX_ROUNDS} consecutive notification rounds`;
					// The errors of the rounds run so far are kept as the cause, rather than lost.
					if (errors === undefined) throw new RangeError(message);
					throw new RangeError(message, {
						cause: errors.length === 1 ? errors[0] : new AggregateError(errors, `store: ${errors.length} notification rounds threw`)
					});
				}

				const roundErrors = round();

				if (roundErrors !== undefined) {
					errors = errors ?? [];
					errors.push(roundErrors.length === 1 ? roundErrors[0] : new AggregateError(roundErrors, `store: ${roundErrors.length} listeners threw`));
				}
			}

			notifying = false;
			errors = settle(errors);

			if (errors === undefined) return;
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, `store: ${errors.length} notification rounds threw`);
		},

		size(): number {
			return subscriptions.length;
		},

		defer(callback: () => void): boolean {
			if (!notifying) return false;
			if (!deferred.includes(callback)) deferred.push(callback);
			return true;
		}
	};
}

/**
 * The notifier of each store made by {@link createStore}, so that {@link createHistory} can tell when a notification (all the rounds
 * caused by one change) has ended.
 */
const NOTIFIERS = /* @__PURE__ */ new WeakMap<object, Notifier>();

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
				const initial = getState();

				// The selector may have subscribed to this store itself (directly, or through a listener of the source): attach once.
				if (!detach) {
					notifiedValue = initial;
					notifiedVersion = version;
					detach = source.subscribe(onSourceChange);
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

	NOTIFIERS.set(store, notifier);
	return store;
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
 *   steps. States the store's `equals` deems equal make no step.
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
	const notifier = NOTIFIERS.get(store);

	// The state the history last saw, the undo steps (oldest first, from index `start`: dropping the oldest one just advances `start`,
	// and the array is compacted once half of it is dropped) and the redo steps (most recent last).
	let present = getState.call(store);
	let past: S[] = [];
	let start = 0;
	let future: S[] = [];
	// When the last change was recorded (for `coalesce`), batch nesting depth, whether the current batch has recorded its step, and
	// whether `undo`/`redo` is restoring a state (until the end of its notification).
	let lastChange = -Infinity;
	let depth = 0;
	let batched = false;
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
		batched = depth > 0 && !undone;
		publish();
	}

	/**
	 * Ends a restoration once its notification has ended: what listeners changed meanwhile belongs to the restored step.
	 * @returns {void}
	 */
	function settle(): void {
		record();
		restoring = false;
		trim();
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
			// Trimmed once restored, so that a rollback has nothing to bring back.
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
