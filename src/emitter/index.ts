import { AbortError, TimeoutError } from '../async/index.js';
import { assertDelay, assertFunction } from '../utils/assert.js';
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
 * The registrations of one event, in registration order.
 */
interface Listeners {
	list: Registration[];
	/** Number of `emit` calls currently iterating `list`: while it is non-zero, `list` is copied on write instead of mutated. */
	emitting: number;
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
	 * Adds a registration. The list is mutated in place, unless an `emit` is iterating it: then it is copied, so that the emit keeps its
	 * snapshot.
	 * @param {PropertyKey} event - The event name (`'*'` for wildcard listeners)
	 * @param {AnyFunction} handler - The listener
	 * @param {boolean} once - Whether to remove the registration before its first call
	 * @returns {Unsubscribe} Removes this registration
	 */
	function add(event: PropertyKey, handler: AnyFunction, once: boolean): Unsubscribe {
		const registration: Registration = { handler: handler as (...args: unknown[]) => unknown, once, active: true };
		const listeners = registry.get(event);

		if (listeners === undefined) registry.set(event, { list: [registration], emitting: 0 });
		else if (listeners.emitting > 0) listeners.list = [...listeners.list, registration];
		else listeners.list.push(registration);

		return function (): void {
			remove(event, registration);
		};
	}

	/**
	 * Deactivates and removes the registrations of `event` matching `target` (in place, or into a copy while an `emit` iterates the list).
	 * @param {PropertyKey} event - The event name
	 * @param {Registration | AnyFunction} [target] - A registration, or a handler (all its registrations), or nothing (every registration)
	 * @returns {boolean} Whether anything was removed
	 */
	function remove(event: PropertyKey, target?: Registration | AnyFunction): boolean {
		const listeners = registry.get(event);

		if (listeners === undefined) return false;

		const list = listeners.list;
		const length = list.length;
		const kept = listeners.emitting > 0 ? [] : list;
		let count = 0;

		for (let i = 0; i < length; i++) {
			const registration = list[i];

			if (target === undefined || registration === target || registration.handler === target) registration.active = false;
			else kept[count++] = registration;
		}

		if (count === 0) registry.delete(event);
		// Faster than assigning `length` (a generic store).
		while (kept.length > count) kept.pop();
		listeners.list = kept;

		return count !== length;
	}

	/**
	 * Calls the active registrations of a snapshot, collecting thrown errors. Listeners are called with no argument, `(payload)` or, for
	 * wildcard listeners, `(event, payload)`.
	 * @param {PropertyKey} event - The emitted event
	 * @param {ReadonlyArray<Registration>} snapshot - The registrations at the start of the emit
	 * @param {boolean} wildcard - Whether the snapshot holds the wildcard listeners
	 * @param {boolean} withPayload - Whether a payload argument was given to `emit`
	 * @param {unknown} payload - The payload
	 * @param {unknown[] | undefined} errors - The errors collected so far, if any
	 * @returns {unknown[] | undefined} The collected errors, if any
	 */
	function run(
		event: PropertyKey,
		snapshot: ReadonlyArray<Registration>,
		wildcard: boolean,
		withPayload: boolean,
		payload: unknown,
		errors: unknown[] | undefined
	): unknown[] | undefined {
		for (let i = 0; i < snapshot.length; i++) {
			const registration = snapshot[i];

			if (!registration.active) continue;
			if (registration.once) {
				remove(wildcard ? WILDCARD : event, registration);
			}

			try {
				if (wildcard) registration.handler(event, payload);
				else if (withPayload) registration.handler(payload);
				else registration.handler();
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

			return remove(event, handler);
		},

		emit(event: PropertyKey, ...args: unknown[]): void {
			assertNotWildcard('emit', event);

			// Both snapshots are taken (and protected from in-place mutation) before any listener runs.
			const listeners = registry.get(event);
			const wildcards = registry.get(WILDCARD);
			const withPayload = args.length > 0;
			const payload = args[0];
			const list = listeners?.list;
			const wildcardList = wildcards?.list;
			let errors: unknown[] | undefined;

			if (listeners !== undefined) listeners.emitting++;
			if (wildcards !== undefined) wildcards.emitting++;
			// The counters always come back down, even when a stack overflow escapes from `run`: a raised counter would make every later
			// `on` copy the listener list.
			try {
				if (list !== undefined) errors = run(event, list, false, withPayload, payload, errors);
				if (wildcardList !== undefined) errors = run(event, wildcardList, true, withPayload, payload, errors);
			} finally {
				if (listeners !== undefined) listeners.emitting--;
				if (wildcards !== undefined) wildcards.emitting--;
			}

			if (errors === undefined) return;
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, `emit: ${errors.length} listeners of ${String(event)} threw`);
		},

		clear(event?: PropertyKey): void {
			const events = event === undefined ? [...registry.keys()] : [event];

			for (const name of events) {
				remove(name);
			}
		},

		listenerCount(event?: PropertyKey): number {
			if (event !== undefined) return registry.get(event)?.list.length ?? 0;

			let total = 0;

			for (const listeners of registry.values()) total += listeners.list.length;

			return total;
		},

		waitFor(event: PropertyKey, options: WaitForOptions<unknown> = {}): Promise<never> {
			return new Promise<never>(function (resolve, reject) {
				const { signal, timeout = Infinity, filter } = options;

				assertNotWildcard('waitFor', event);
				assertDelay('waitFor', 'timeout', timeout, true);
				if (filter !== undefined) assertFunction('waitFor', 'filter', filter);
				assertOptionalSignal('waitFor', 'signal', signal);

				if (signal?.aborted) {
					reject(reasonOf(signal, createAbortError));
					return;
				}

				// The abort listener first: when adding it throws, neither the event listener nor the timer is left behind.
				signal?.addEventListener('abort', onAbort);

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
					detach(signal, onAbort);
				}

				/**
				 * Abort listener.
				 * @returns {void}
				 */
				function onAbort(): void {
					finish(reject, reasonOf(signal as AbortSignalLike, createAbortError));
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
			});
		}
	};

	return emitter;
}
