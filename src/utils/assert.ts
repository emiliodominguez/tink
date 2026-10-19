/**
 * PRIVATE argument-validation helpers shared by the modules. Not part of the public API: this file is not re-exported by
 * `utils/index.ts` or the package root, the `exports` map does not reach it, and TypeDoc/doctest skip it.
 *
 * Every helper throws with the library-wide message format `` `${caller}: \`${name}\` must be ${expected}, got ${actual}` ``:
 * a `TypeError` when the value has the wrong type, a `RangeError` when it has the right type but an invalid value.
 * @internal
 * @packageDocumentation
 */
import type { AnyFunction, RandomGenerator } from './types.js';

/**
 * Largest delay accepted by `setTimeout` (2^31 - 1 ms, about 24.8 days).
 * @internal
 */
export const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Describes a value's type for `TypeError` messages.
 * @param {unknown} value - The offending value
 * @returns {string} `'null'` or the `typeof` of the value
 * @internal
 */
export function describe(value: unknown): string {
	return value === null ? 'null' : typeof value;
}

/**
 * Shows a rejected value in an error message: a primitive as `String` writes it, an object or function by its type only (converting
 * it could call a throwing `toString`, or fail for a null-prototype object, turning the intended error into another one).
 * @param {unknown} value - The value
 * @returns {string} Its text for the message
 * @internal
 */
export function show(value: unknown): string {
	return typeof value === 'object' || typeof value === 'function' ? describe(value) : String(value);
}

/**
 * Throws a `TypeError` unless `value` is callable.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a function
 * @internal
 */
export function assertFunction(caller: string, name: string, value: unknown): asserts value is AnyFunction {
	if (typeof value !== 'function') throw new TypeError(`${caller}: \`${name}\` must be a function, got ${describe(value)}`);
}

/**
 * Throws a `TypeError` unless `value` is a number, and a `RangeError` unless `valid` is `true`.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @param {boolean} valid - Whether the (numeric) value is acceptable
 * @param {string} expected - What the parameter must be, e.g. `'an integer >= 0'`
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `valid` is `false`
 * @internal
 */
export function assertNumber(caller: string, name: string, value: unknown, valid: boolean, expected: string): asserts value is number {
	if (typeof value !== 'number') throw new TypeError(`${caller}: \`${name}\` must be ${expected}, got ${describe(value)}`);
	if (!valid) throw new RangeError(`${caller}: \`${name}\` must be ${expected}, got ${value}`);
}

/**
 * Throws unless `value` is an integer `>= min` (or `Infinity`, when allowed).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {number} value - The value to validate
 * @param {number} [min=0] - Smallest accepted value
 * @param {boolean} [allowInfinity=false] - Whether `Infinity` is accepted
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is not an accepted integer
 * @internal
 */
export function assertInteger(caller: string, name: string, value: number, min = 0, allowInfinity = false): void {
	// Checked first so that the message is only formatted on failure.
	if ((Number.isInteger(value) && value >= min) || (allowInfinity && value === Infinity)) return;
	assertNumber(caller, name, value, false, `an integer >= ${min}${allowInfinity ? ' or Infinity' : ''}`);
}

/**
 * Throws unless `value` is a usable timer delay: a number in `[0, MAX_TIMEOUT]` (or `Infinity`, when allowed).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {number} value - The value to validate
 * @param {boolean} [allowInfinity=false] - Whether `Infinity` is accepted
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is not a usable delay
 * @internal
 */
export function assertDelay(caller: string, name: string, value: number, allowInfinity = false): void {
	// Checked first so that the message is only formatted on failure (`typeof` guards against strings such as '5' passing the comparisons).
	if (typeof value === 'number' && ((value >= 0 && value <= MAX_TIMEOUT) || (allowInfinity && value === Infinity))) return;
	assertNumber(caller, name, value, false, `${allowInfinity ? 'Infinity or ' : ''}a number between 0 and ${MAX_TIMEOUT}`);
}

/**
 * The built-in `Math.random` (captured at load time, so a replacement installed later is still validated).
 * @internal
 */
const nativeRandom = Math.random;

/**
 * Calls `random()` and returns its result, which must be a number in `[0, 1)`. The built-in `Math.random` (the usual default)
 * is trusted, since the specification guarantees that range: its results are returned unchecked.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {RandomGenerator} random - The generator to draw from
 * @returns {number} The drawn value
 * @throws {TypeError} when `random` is not a function
 * @throws {RangeError} when the drawn value is outside `[0, 1)` or `NaN`
 * @internal
 */
export function draw(caller: string, random: RandomGenerator): number {
	if (random === nativeRandom) return random();
	assertFunction(caller, 'random', random);
	const value = random();
	// `typeof` first: comparisons coerce, so `null`, `false`, `''` or `[]` would otherwise pass as 0.
	if (!(typeof value === 'number' && value >= 0 && value < 1)) throw new RangeError(`${caller}: \`random()\` must return a number in [0, 1), got ${show(value)}`);
	return value;
}

/**
 * Reads a property of an options object (or of an input object) once, ignoring a value inherited from a polluted `Object.prototype`:
 * own properties are read, and so are properties of the object's own prototypes (class getters, proxies), but an inherited value that
 * is the very value `Object.prototype` holds for that key is not (only this realm's `Object.prototype` is known). Allocation-free, and
 * the common case (the option is not set) costs a single property read.
 * @template O - The options type
 * @template K - The key
 * @template D - The fallback type
 * @param {O} options - The options (`null` and `undefined` throw a `TypeError`, like destructuring them)
 * @param {K} key - The option name
 * @param {D} [fallback] - Returned instead of `undefined`
 * @returns {Exclude<O[K], undefined> | D} The value, or `fallback` when it is `undefined` or inherited from `Object.prototype`
 * @internal
 */
export function readOption<O extends object, K extends keyof O & string, D = undefined>(options: O, key: K, fallback?: D): Exclude<O[K], undefined> | D {
	const value = options[key];
	if (value === undefined || (value === (Object.prototype as O)[key] && !hasOwn.call(options, key))) return fallback as D;
	return value as Exclude<O[K], undefined>;
}

/** `Object.prototype.hasOwnProperty`, captured before any user code runs. */
const hasOwn = Object.prototype.hasOwnProperty;
