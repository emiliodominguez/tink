/**
 * PRIVATE registry of guard scores, shared by the guards module (which registers them) and the validate module (which reads them for
 * guards nested in its schemas). Not part of the public API: this file is not re-exported by `utils/index.ts` or the package root, and
 * the `exports` map does not reach it.
 *
 * A score tells how far a value rejected by a guard is from matching it, so that a union reports the closest member only: reporting every
 * member, at every level of a recursive union, takes time exponential in the depth of an invalid value. Shapes score the share of their
 * properties with a primitive (or missing) value that fail, below 1, and 2 for a value that is not an object; wrappers forward the score
 * of the guard they wrap; guards without a score count as 1. Lower is closer.
 * @internal
 * @packageDocumentation
 */
import type { AnyFunction } from './types.js';

/** The score of each guard that has one. */
const scorers = new WeakMap<AnyFunction, (value: unknown) => number>();

/**
 * Registers how far values rejected by `guard` are from matching it.
 * @template G - The guard type
 * @param {G} guard - The guard
 * @param {(value: unknown) => number} scorer - Its score, lower being closer
 * @returns {G} The guard itself
 * @internal
 */
export function scored<G extends AnyFunction>(guard: G, scorer: (value: unknown) => number): G {
	scorers.set(guard, scorer);

	return guard;
}

/**
 * Returns how far `value` is from matching `guard`: its registered score, or 1.
 * @param {AnyFunction} guard - The guard
 * @param {unknown} value - A value the guard rejects
 * @returns {number} The score, lower being closer
 * @internal
 */
export function guardScore(guard: AnyFunction, value: unknown): number {
	const scorer = scorers.get(guard);

	return scorer === undefined ? 1 : scorer(value);
}
