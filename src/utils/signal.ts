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
