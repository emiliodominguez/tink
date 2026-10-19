/**
 * PRIVATE code generation shared by the object checks of the guards module (`isShape`) and the object schemas of the validate module
 * (`parse`). Not part of the public API: this file is not re-exported by `utils/index.ts` or the package root, and the `exports` map
 * does not reach it.
 *
 * A loop over the keys of a schema makes every property read and guard call a megamorphic site; one generated function per schema, with
 * a named property read and a direct call per key, is three to four times faster (zod 4 does the same). Only keys reach the generated
 * source, as `JSON.stringify` string literals, which escape every character that could end a string (quotes, backslashes, line
 * terminators, lone surrogates); everything else is passed in as arguments.
 * @internal
 * @packageDocumentation
 */
import type { AnyFunction } from './types.js';

/** Whether `new Function` works here: unknown until the first schema is compiled, `false` under a CSP without `'unsafe-eval'`. */
let available: boolean | undefined;

/**
 * Builds a function from source, or returns `undefined` when code generation from strings is disallowed (a Content Security Policy
 * without `'unsafe-eval'`, Cloudflare Workers…; the first attempt there may log a CSP violation report, later ones are not made).
 * Any other error, such as a stack overflow while compiling deep inside a recursion, only makes this one call fail.
 * @param {ReadonlyArray<string>} parameters - The parameter names of the factory
 * @param {string} source - The body of the factory, which returns the generated function
 * @param {ReadonlyArray<unknown>} args - The arguments of the factory, one per parameter
 * @returns {AnyFunction | undefined} The generated function, or `undefined`
 * @internal
 */
export function generate(parameters: ReadonlyArray<string>, source: string, args: ReadonlyArray<unknown>): AnyFunction | undefined {
	if (available === false) return undefined;
	try {
		const factory = new Function(...parameters, source) as (...values: unknown[]) => AnyFunction;

		available = true;

		return factory(...args);
	} catch (error) {
		if (error instanceof EvalError) available = false;

		return undefined;
	}
}
