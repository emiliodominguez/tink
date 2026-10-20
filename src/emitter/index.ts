import { AbortError, TimeoutError } from '../async/index.js';
import { assertDelay, assertFunction, readOption } from '../utils/assert.js';
import { assertOptionalSignal, detach, reasonOf } from '../utils/signal.js';
import type { AbortSignalLike, AnyFunction } from '../utils/index.js';

/**
 * The reserved event name used to listen to every event.
 */
const WILDCARD = '*';

/**
 * Removes the subscription it was returned for. Calling it more than once is a no-op.
 */
export type Unsubscribe = () => void;

/**
 * A map from event name (string, number or symbol key) to payload type; any object type works, interfaces included.
 * Use `void` (or `undefined`) as payload type for events emitted without an argument.
 */
export type EventMap = object;

/**
 * A listener for an event whose payload has type `P`.
 * @template P - The payload type
 */
export type EventHandler<P> = (payload: P) => void;

/**
 * A listener registered with `on('*', ...)`: receives the event name and its payload. The `(event, payload)` pairs form a
 * discriminated union, so checking `event` narrows `payload`.
 *
 * `'*'` always registers such a listener. With an event map that has an index signature (`Record<string, T>`), `'*'` is also a key of
 * the map, so a handler written for a `T` payload type-checks there too, although it receives `(event, payload)`: type it with
 * `WildcardHandler` (generic wrappers over the event map, such as `class Bus<M> { on<K extends keyof M>(…) }`, rule out a stricter
 * signature).
 * @template Events - The event map
 */
export type WildcardHandler<Events extends EventMap> = (...args: { [K in keyof Events]-?: [event: K, payload: Events[K]] }[keyof Events]) => void;

/**
 * The argument list accepted by `emit` after the event name: the payload is optional when `P` is `void`, `undefined` or includes `undefined`.
 * @template P - The payload type
 */
export type EmitArgs<P> = [P] extends [void] ? [payload?: P] : undefined extends P ? [payload?: P] : [payload: P];

/**
 * Options accepted by {@link Emitter.waitFor}.
 * @template P - The payload type
 */
export interface WaitForOptions<P> {
	/** Stops waiting, rejecting with the signal's `reason` (or an `AbortError`). */
	signal?: AbortSignalLike;
	/** Time limit in ms (`0` to `2^31 - 1`, or `Infinity`), after which the promise rejects with a `TimeoutError`. Defaults to `Infinity`. */
	timeout?: number;
	/** Only payloads for which this returns `true` settle the promise. If it throws, the promise rejects with that error. */
	filter?(payload: P): boolean;
}

/**
 * Creates the reason of a signal aborted without one.
 * @returns {AbortError} A new `AbortError`
 */
function createAbortError(): AbortError {
	return new AbortError();
}

/**
 * The `waitFor` calls waiting on one abort signal, and the single listener that stops them all.
 */
interface SignalWaiters {
	readonly stops: Set<(reason: unknown) => void>;
	readonly listener: () => void;
}

/**
 * The `waitFor` calls of every emitter waiting on each signal, with ONE abort listener per signal: adding and removing a listener costs a
 * scan of the signal's listener list (a platform `AbortSignal` checks for duplicates), so one listener per call made n calls waiting on
 * one signal cost O(n²) (30,000 took 6 s to start).
 */
const signalWaiters = new WeakMap<AbortSignalLike, SignalWaiters>();

/**
 * Registers a `waitFor` call on `signal` (none: nothing to do), adding the abort listener for its first call. `stop` is called once,
 * with the signal's reason, unless {@link unwatch} unregisters it first (also from a call stopped before it).
 * @param {AbortSignalLike | null | undefined} signal - The signal (`null` from untyped code)
 * @param {(reason: unknown) => void} stop - Stops the call
 * @returns {void}
 * @throws {unknown} the error of a throwing `addEventListener` (the call is not registered then)
 */
function watch(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void): void {
	if (signal === null || signal === undefined) return;

	const existing = signalWaiters.get(signal);

	if (existing !== undefined) {
		existing.stops.add(stop);
		return;
	}

	const stops = new Set([stop]);
	const waiters: SignalWaiters = {
		stops,
		listener: function onAbort(): void {
			const reason = reasonOf(signal, createAbortError);

			// Live, each call removed before it is stopped: one unregistered meanwhile is skipped, and none is stopped twice.
			for (const each of stops) {
				stops.delete(each);
				each(reason);
			}
			if (signalWaiters.get(signal) === waiters) signalWaiters.delete(signal);
		}
	};

	// Mapped once added: when adding it throws, the waiter is not registered, and when the signal calls it while it is being added, the
	// waiter is stopped already. `capture` is given: one inherited from a polluted `Object.prototype` would keep `removeEventListener`
	// from finding the listener.
	signal.addEventListener('abort', waiters.listener, { once: true, capture: false } as { once: boolean });
	if (stops.size > 0) signalWaiters.set(signal, waiters);
}

/**
 * Unregisters a `waitFor` call that settled (idempotent), removing the abort listener once no call waits on the signal.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {(reason: unknown) => void} stop - The call's stop function
 * @returns {void}
 */
function unwatch(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void): void {
	const waiters = signal === null || signal === undefined ? undefined : signalWaiters.get(signal);

	if (waiters === undefined || !waiters.stops.delete(stop) || waiters.stops.size > 0) return;
	signalWaiters.delete(signal as AbortSignalLike);
	detach(signal, waiters.listener);
}

/**
 * A strictly typed, synchronous event emitter. See {@link createEmitter} for the exact semantics.
 * @template Events - Maps each event name to its payload type
 */
export interface Emitter<Events extends EventMap> {
	/** Listens to every event (`'*'`). Returns a function removing exactly this registration. */
	on(event: '*', handler: WildcardHandler<Events>): Unsubscribe;
	/** Listens to `event`. Returns a function removing exactly this registration. */
	on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): Unsubscribe;
	/** Like `on('*', handler)`, but the registration is removed before its first call. */
	once(event: '*', handler: WildcardHandler<Events>): Unsubscribe;
	/** Like `on`, but the registration is removed before its first call. */
	once<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): Unsubscribe;
	/** Removes every registration of `handler` for wildcard listeners; returns whether anything was removed. */
	off(event: '*', handler: WildcardHandler<Events>): boolean;
	/** Removes every registration of `handler` for `event`; returns whether anything was removed. */
	off<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): boolean;
	/** Synchronously calls the listeners of `event`, then the wildcard listeners. */
	emit<K extends keyof Events>(event: K, ...args: EmitArgs<Events[K]>): void;
	/** Removes the listeners of `event` (`'*'` for wildcard listeners), or every listener when called without argument. */
	clear(event?: keyof Events | '*'): void;
	/** Number of registrations for `event` (`'*'` for wildcard listeners), or the total when called without argument. */
	listenerCount(event?: keyof Events | '*'): number;
	/**
	 * Resolves with the payload of the next `event` accepted by `filter`. Its internal listener, timer and abort listener are always removed
	 * on settle. The internal listener counts as a registration, so `clear()` removes it too: the promise then only settles through
	 * `timeout` or `signal`.
	 */
	waitFor<K extends keyof Events>(event: K, options?: WaitForOptions<Events[K]>): Promise<Events[K]>;
}

/**
 * One registration of a listener.
 */
interface Registration {
	readonly handler: (...args: unknown[]) => unknown;
	readonly once: boolean;
	active: boolean;
}

/**
 * The registrations of one event.
 */
interface Listeners {
	/**
	 * The registrations in registration order, removed ones included until {@link compact} drops them. An `emit` iterates it by index up
	 * to the length it had when the emit started, so a registration added meanwhile (pushed at the end) is not called, and removing one
	 * only marks it inactive: neither copies the list, and each removal costs O(1) amortized.
	 */
	readonly list: Registration[];
	/** Number of inactive registrations in `list`. */
	removed: number;
	/** Number of `emit` calls iterating `list`: it is only compacted while none is. */
	emitting: number;
}

/**
 * Drops the inactive registrations once they are half of the list, unless an `emit` iterates it, so that the list stays within twice
 * the number of registrations.
 * @param {Listeners} listeners - The registrations of an event
 * @returns {void}
 */
function compact(listeners: Listeners): void {
	const list = listeners.list;

	if (listeners.emitting > 0 || listeners.removed * 2 < list.length) return;

	let kept = 0;

	for (const registration of list) if (registration.active) list[kept++] = registration;
	// Faster than assigning `length` (a generic store).
	while (list.length > kept) list.pop();
	listeners.removed = 0;
}

/**
 * Creates a strictly typed, synchronous event emitter.
 *
 * Semantics:
 * - `emit` calls the listeners of the event in registration order, then the wildcard (`'*'`) listeners, synchronously. Listeners receive
 *   exactly the payload argument given to `emit` (no argument when it was omitted); wildcard listeners always receive `(event, payload)`.
 * - Listeners are taken from a snapshot at the start of `emit`: listeners added during an emit do not run for that emit; listeners removed
 *   (through `off`, an unsubscribe function or `clear`) during an emit and not yet called are skipped.
 * - Registering the same handler twice registers it twice: it is called twice per emit. The function returned by `on`/`once` removes
 *   exactly its own registration, while `off(event, handler)` removes every registration of `handler` for `event`.
 * - `once` registrations are removed before their handler runs, so a nested emit of the same event does not call them again.
 * - Nested `emit` calls from inside a listener run immediately (depth first).
 * - A throwing listener does not stop the others: every listener is called, then the error is rethrown (or an `AggregateError` holding
 *   every error, in call order, when several listeners threw).
 * - `'*'` is reserved for wildcard listeners and cannot be emitted.
 * - Adding a listener, removing one through its unsubscribe function and removing a `once` listener as it runs cost O(1) amortized,
 *   also during an emit (which neither copies the listener list nor is affected by the changes).
 * @template Events - Maps each event name to its payload type (`void` payloads can be emitted without argument)
 * @returns {Emitter<Events>} A new emitter
 * @throws {TypeError} from `on`/`once`/`off` when the handler is not a function, and (as a rejection) from `waitFor` when `filter` is not
 *   a function, `timeout` is not a number or `signal` is not a signal
 * @throws {RangeError} from `emit` when the event is `'*'`, and (as a rejection) from `waitFor` when the event is `'*'` or `timeout` is
 *   neither a number between `0` and `2^31 - 1` nor `Infinity`
 * @example
 * const events = createEmitter<{ ready: void; message: { text: string } }>();
 * const received: string[] = [];
 * const stop = events.on('message', function (msg) { received.push(msg.text); });
 * events.emit('ready');
 * events.emit('message', { text: 'hi' });
 * stop();
 * events.emit('message', { text: 'unheard' });
 * received; // => ['hi']
 * setTimeout(function () { events.emit('message', { text: 'later' }); }, 10);
 * await events.waitFor('message', { timeout: 1000 }); // => { text: 'later' }
 */
export function createEmitter<Events extends EventMap>(): Emitter<Events> {
	const registry = new Map<PropertyKey, Listeners>();

	/**
	 * Adds a registration at the end of the list of `event` (an `emit` iterating the list does not reach it).
	 * @param {PropertyKey} event - The event name (`'*'` for wildcard listeners)
	 * @param {AnyFunction} handler - The listener
	 * @param {boolean} once - Whether to remove the registration before its first call
	 * @returns {Unsubscribe} Removes this registration
	 */
	function add(event: PropertyKey, handler: AnyFunction, once: boolean): Unsubscribe {
		const registration: Registration = { handler: handler as (...args: unknown[]) => unknown, once, active: true };
		let listeners = registry.get(event);

		if (listeners === undefined) registry.set(event, (listeners = { list: [registration], removed: 0, emitting: 0 }));
		else listeners.list.push(registration);

		const owner = listeners;

		return function (): void {
			if (!registration.active) return;
			registration.active = false;
			release(event, owner, 1);
		};
	}

	/**
	 * Accounts for registrations of `event` just marked inactive: forgets the event once it has no active registration left, and
	 * compacts its list.
	 * @param {PropertyKey} event - The event name
	 * @param {Listeners} listeners - Its registrations (those of the registry: an inactive registration is never released again)
	 * @param {number} count - Number of registrations just marked inactive
	 * @returns {void}
	 */
	function release(event: PropertyKey, listeners: Listeners, count: number): void {
		listeners.removed += count;
		// An emit iterating the list keeps it (and empties it when it ends): only the registry forgets it.
		if (listeners.removed === listeners.list.length) registry.delete(event);
		// Also once forgotten: the unsubscribe functions still hold the list, which must not keep the removed handlers alive.
		compact(listeners);
	}

	/**
	 * Calls the active registrations among the first `length` of a list, collecting thrown errors. Listeners are called with no argument,
	 * `(payload)` or, for wildcard listeners, `(event, payload)`.
	 * @param {PropertyKey} event - The emitted event
	 * @param {Listeners} listeners - The registrations of the event, or the wildcard ones
	 * @param {number} length - The length of their list when the emit started
	 * @param {boolean} wildcard - Whether these are the wildcard listeners
	 * @param {boolean} withPayload - Whether a payload argument was given to `emit`
	 * @param {unknown} payload - The payload
	 * @param {unknown[] | undefined} errors - The errors collected so far, if any
	 * @returns {unknown[] | undefined} The collected errors, if any
	 */
	function run(
		event: PropertyKey,
		listeners: Listeners,
		length: number,
		wildcard: boolean,
		withPayload: boolean,
		payload: unknown,
		errors: unknown[] | undefined
	): unknown[] | undefined {
		// Not compacted while the emit runs: the indexes are stable.
		const list = listeners.list;

		for (let i = 0; i < length; i++) {
			const registration = list[i];

			if (!registration.active) continue;
			if (registration.once) {
				registration.active = false;
				release(wildcard ? WILDCARD : event, listeners, 1);
			}

			// Called as a plain function: `this` is `undefined`, not the registration (which a listener could otherwise reactivate).
			const handler = registration.handler;

			try {
				if (wildcard) handler(event, payload);
				else if (withPayload) handler(payload);
				else handler();
			} catch (error) {
				errors = errors ?? [];
				errors.push(error);
			}
		}

		return errors;
	}

	/**
	 * Throws a `RangeError` when `event` is the reserved wildcard name.
	 * @param {string} caller - Name of the public method, used in the error message
	 * @param {PropertyKey} event - The event name
	 * @returns {void}
	 * @throws {RangeError} when `event` is `'*'`
	 */
	function assertNotWildcard(caller: string, event: PropertyKey): void {
		if (event === WILDCARD) throw new RangeError(`${caller}: \`event\` must not be '*' (reserved for wildcard listeners), got '*'`);
	}

	const emitter: Emitter<Events> = {
		on(event: PropertyKey, handler: AnyFunction): Unsubscribe {
			assertFunction('on', 'handler', handler);

			return add(event, handler, false);
		},

		once(event: PropertyKey, handler: AnyFunction): Unsubscribe {
			assertFunction('once', 'handler', handler);

			return add(event, handler, true);
		},

		off(event: PropertyKey, handler: AnyFunction): boolean {
			assertFunction('off', 'handler', handler);

			const listeners = registry.get(event);

			if (listeners === undefined) return false;

			let count = 0;

			for (const registration of listeners.list) {
				if (registration.active && registration.handler === handler) {
					registration.active = false;
					count++;
				}
			}
			if (count === 0) return false;
			release(event, listeners, count);

			return true;
		},

		emit(event: PropertyKey, ...args: unknown[]): void {
			assertNotWildcard('emit', event);

			const listeners = registry.get(event);
			const wildcards = registry.get(WILDCARD);

			if (listeners === undefined && wildcards === undefined) return;

			const withPayload = args.length > 0;
			const payload = args[0];
			// Both snapshots (the list lengths) are taken before any listener runs.
			const length = listeners === undefined ? 0 : listeners.list.length;
			const wildcardLength = wildcards === undefined ? 0 : wildcards.list.length;
			let errors: unknown[] | undefined;

			if (listeners !== undefined) listeners.emitting++;
			if (wildcards !== undefined) wildcards.emitting++;
			// The counters always come back down, even when a stack overflow escapes from `run`: a raised counter would keep the list from
			// ever being compacted.
			try {
				if (listeners !== undefined) errors = run(event, listeners, length, false, withPayload, payload, errors);
				if (wildcards !== undefined) errors = run(event, wildcards, wildcardLength, true, withPayload, payload, errors);
			} finally {
				if (listeners !== undefined && --listeners.emitting === 0) compact(listeners);
				if (wildcards !== undefined && --wildcards.emitting === 0) compact(wildcards);
			}

			if (errors === undefined) return;
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, `emit: ${errors.length} listeners of ${String(event)} threw`);
		},

		clear(event?: PropertyKey): void {
			for (const listeners of event === undefined ? registry.values() : [registry.get(event)]) {
				if (listeners === undefined) continue;
				// Inactive, they are skipped by an emit iterating the list, and their unsubscribe functions do nothing.
				for (const registration of listeners.list) registration.active = false;
				// Emptied (now, or when the emits iterating it end): the unsubscribe functions still hold the list, which must not keep the
				// removed handlers alive.
				listeners.removed = listeners.list.length;
				compact(listeners);
			}
			if (event === undefined) registry.clear();
			else registry.delete(event);
		},

		listenerCount(event?: PropertyKey): number {
			let total = 0;

			for (const listeners of event === undefined ? registry.values() : [registry.get(event)]) {
				if (listeners !== undefined) total += listeners.list.length - listeners.removed;
			}

			return total;
		},

		waitFor(event: PropertyKey, options: WaitForOptions<unknown> = {}): Promise<never> {
			return new Promise<never>(function (resolve, reject) {
				// Read as own properties: a value inherited from a polluted `Object.prototype` is ignored.
				const signal = readOption(options, 'signal');
				const timeout = readOption(options, 'timeout', Infinity);
				const filter = readOption(options, 'filter');

				assertNotWildcard('waitFor', event);
				assertDelay('waitFor', 'timeout', timeout, true);
				if (filter !== undefined) assertFunction('waitFor', 'filter', filter);
				assertOptionalSignal('waitFor', 'signal', signal);

				if (signal?.aborted) {
					reject(reasonOf(signal, createAbortError));
					return;
				}

				const unsubscribe = add(event, onEvent, false);
				const timer =
					timeout === Infinity
						? undefined
						: setTimeout(function () {
								finish(reject, new TimeoutError(`waitFor: ${String(event)} was not emitted within ${timeout} ms`));
							}, timeout);

				/**
				 * Settles the promise and releases the listener, the timer and the abort listener.
				 * @param {(value: never) => void} settle - `resolve` or `reject`
				 * @param {unknown} value - The value or reason
				 * @returns {void}
				 */
				function finish(settle: (value: never) => void, value: unknown): void {
					unsubscribe();
					clearTimeout(timer);
					settle(value as never);
					unwatch(signal, onAbort);
				}

				/**
				 * Abort listener.
				 * @param {unknown} reason - The abort reason
				 * @returns {void}
				 */
				function onAbort(reason: unknown): void {
					finish(reject, reason);
				}

				/**
				 * Event listener: settles with the first accepted payload.
				 * @param {unknown} payload - The emitted payload
				 * @returns {void}
				 */
				function onEvent(payload: unknown): void {
					let accepted: boolean;

					try {
						accepted = filter === undefined || filter(payload);
					} catch (error) {
						finish(reject, error);
						return;
					}

					if (accepted) finish(resolve, payload);
				}

				// The abort listener last, so that a signal calling it while it is being added finds everything to release; when adding it
				// throws, neither the event listener nor the timer is left behind.
				try {
					watch(signal, onAbort);
				} catch (error) {
					unsubscribe();
					clearTimeout(timer);
					throw error;
				}
			});
		}
	};

	return emitter;
}
