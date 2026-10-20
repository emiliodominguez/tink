/**
 * PRIVATE helpers for the abort signals accepted by the async, emitter and iterables modules. Not part of the public API: this file is
 * not re-exported by `utils/index.ts` or the package root, and the `exports` map does not reach it.
 *
 * Signals are typed {@link AbortSignalLike}, so they may come from user code whose methods or `reason` getter throw: these helpers keep
 * such a signal from leaving an operation unsettled, or from throwing out of a timer callback.
 * @internal
 * @packageDocumentation
 */
import { describe } from './assert.js';
import type { AbortSignalLike } from './types.js';

/**
 * The reason a signal was aborted with, or `fallback()` when it has none. A `reason` getter that throws gives its error: the signal
 * still aborts the operation, with that error.
 * @param {AbortSignalLike} signal - An aborted signal
 * @param {() => unknown} fallback - Creates the reason of a signal without one (an `AbortError`)
 * @returns {unknown} The rejection reason
 * @internal
 */
export function reasonOf(signal: AbortSignalLike, fallback: () => unknown): unknown {
	try {
		return signal.reason ?? fallback();
	} catch (error) {
		return error;
	}
}

/**
 * Removes an abort listener once the operation it watched has settled. A signal whose `removeEventListener` throws keeps the listener,
 * which is then harmless (settling twice does nothing): the error must not stop the settling, or escape from a timer callback.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {() => void} listener - The listener
 * @returns {void}
 * @internal
 */
export function detach(signal: AbortSignalLike | null | undefined, listener: () => void): void {
	try {
		signal?.removeEventListener('abort', listener);
	} catch {
		// See above.
	}
}

/**
 * Throws a `TypeError` unless `value` is `null`, `undefined` or looks like an abort signal (an object with `addEventListener` and
 * `removeEventListener` methods).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a signal, `null` or `undefined`
 * @internal
 */
export function assertOptionalSignal(caller: string, name: string, value: unknown): asserts value is AbortSignalLike | null | undefined {
	if (value === null || value === undefined) return;
	const signal = value as Partial<AbortSignalLike>;
	if (typeof value !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
		throw new TypeError(`${caller}: \`${name}\` must be an AbortSignal, null or undefined, got ${describe(value)}`);
	}
}

/**
 * The waiters sharing one abort signal, and the single listener that stops them all.
 */
interface SignalGroup {
	readonly stops: Set<(reason: unknown) => void>;
	readonly listener: () => void;
}

/**
 * The waiters of every signal passed to the async and emitter modules (queued tasks, permit requests, batched keys, sleeps, `waitFor`
 * calls...), with ONE abort listener per signal however many wait on it: adding and removing a listener costs a scan of the signal's
 * listener list (a platform `AbortSignal` checks for duplicates), so one listener per waiter made n waiters on one signal cost O(n²)
 * (30,000 sleeps on one signal took 15 s to start). Shared by both modules, so that the waiters of a signal are stopped in registration
 * order whichever helper or structure they belong to.
 */
const signalGroups = new WeakMap<AbortSignalLike, SignalGroup>();

/**
 * Registers a waiter on `signal` (none: nothing to do), adding the abort listener to the signal for its first waiter. `stop` is called
 * once, with the signal's reason (read once for all its waiters), unless {@link unwatchSignal} unregisters it first; a signal that calls
 * the listener while it is being added stops the waiter before this returns.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {(reason: unknown) => void} stop - Stops the waiter (it must not throw)
 * @param {() => unknown} fallback - Creates the reason of a signal aborted without one (an `AbortError`), see {@link reasonOf}
 * @returns {void}
 * @throws {unknown} the error of a throwing `addEventListener` (the waiter is not registered then)
 * @internal
 */
export function watchSignal(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void, fallback: () => unknown): void {
	if (signal === null || signal === undefined) return;

	const existing = signalGroups.get(signal);

	if (existing !== undefined) {
		existing.stops.add(stop);
		return;
	}

	const stops = new Set([stop]);
	const group: SignalGroup = {
		stops,
		listener: function onAbort(): void {
			const reason = reasonOf(signal, fallback);

			// Iterated live, each waiter removed before it is stopped: a waiter unregistered by an earlier one (a permit granted, a task
			// started by code that the abort ran) is skipped, and a hostile signal calling the listener again stops nobody twice.
			for (const each of stops) {
				stops.delete(each);
				each(reason);
			}
			if (signalGroups.get(signal) === group) signalGroups.delete(signal);
		}
	};

	// Mapped once added: when adding it throws, the waiter is not registered, and when the signal calls it while it is being added, the
	// waiter is stopped already. The options have no prototype: a `capture` inherited from a polluted `Object.prototype` would keep
	// `removeEventListener` from finding the listener, and an inherited `signal` makes a platform signal throw.
	try {
		signal.addEventListener('abort', group.listener, { __proto__: null, once: true } as { once: boolean });
		if (stops.size > 0) signalGroups.set(signal, group);
	} catch (error) {
		// The waiter is not registered: a listener the signal kept anyway (added, then a throw, or a stack overflow at the mapping) must
		// stop nobody (a keyed mutex would forget a key held since, a queue miscount its cancelled tasks).
		stops.clear();
		throw error;
	}
}

/**
 * Unregisters a waiter that no longer waits (idempotent), removing the abort listener once no waiter is left on the signal. A waiter is
 * never stopped once unregistered, even by a signal whose `removeEventListener` throws.
 * @param {AbortSignalLike | null | undefined} signal - The signal
 * @param {(reason: unknown) => void} stop - The waiter's stop function
 * @returns {void}
 * @internal
 */
export function unwatchSignal(signal: AbortSignalLike | null | undefined, stop: (reason: unknown) => void): void {
	if (signal === null || signal === undefined) return;

	const group = signalGroups.get(signal);

	if (group === undefined || !group.stops.delete(stop) || group.stops.size > 0) return;
	signalGroups.delete(signal);
	detach(signal, group.listener);
}
