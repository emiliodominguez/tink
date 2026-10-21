/**
 * PRIVATE memo of recursive checks, shared by the guards module (`isLazy`) and the validate module (`lazy`). Not part of the public
 * API: this file is not re-exported by `utils/index.ts` or the package root, and the `exports` map does not reach it.
 *
 * A lazy guard or parser remembers its result for each object it checks until the outermost check (or parse) returns, so that a
 * recursive union whose members are only told apart deep inside a value checks each object once per lazy schema, instead of once per
 * path through the members: that is the difference between linear and exponential time in the depth of the value. The entry of an
 * object being checked is {@link PENDING}, so meeting it again means a cycle.
 * @internal
 * @packageDocumentation
 */

/** The memo entry of an object whose check is in progress. */
export const PENDING: object = {};

/**
 * How many checks (or parses) are running: the memos are released when it drops back to 0. Callers update it inline rather than
 * through a function, since a call made while unwinding a stack overflow can overflow again, and skip the update.
 */
export const scope = {
	depth: 0,
	/** The last error a lazy schema saw thrown, and the `depth` of the first (so deepest) one to see it: see {@link isTooDeep}. */
	thrown: undefined as unknown,
	thrownAt: 0,
	/** How many times a lazy schema met an object it was already checking (a cycle): results that did are not remembered. */
	cycles: 0,
	/** How many lazy checks or parses are running outside `explain`, and the root their nested `explain` calls share (guards). */
	checks: 0,
	checkRoot: undefined as object | undefined
};

/** The nesting of lazy schemas from which a stack overflow is blamed on the value, not on the code (a guard or transform recursing). */
const TOO_DEEP = 100;

/**
 * The memos (and sets of objects being explained) holding entries. Not empty while no check runs (`scope.depth` is 0) only when the
 * `release` of the outermost check that ended last overflowed the stack: the next outermost check or parse then releases them first,
 * since their entries answer for objects that may have changed since (a `PENDING` reading as a cycle).
 * @internal
 */
export const held: Array<Map<object, unknown> | Set<object>> = [];

/**
 * Registers `collection` for clearing when the outermost check (or parse) ends; call it before adding an entry.
 * @template C - The collection type
 * @param {C} collection - A memo, or a set of objects being explained
 * @returns {C} `collection` itself
 * @internal
 */
export function hold<C extends Map<object, unknown> | Set<object>>(collection: C): C {
	if (collection.size === 0) held.push(collection);

	return collection;
}

/**
 * Clears every held collection: called by the outermost check (or parse) as it ends, so entries that a stack overflow kept from being
 * removed do not outlive it either.
 * @returns {void}
 * @internal
 */
export function release(): void {
	for (let index = 0; index < held.length; index++) held[index].clear();
	held.length = 0;
	scope.thrown = undefined;
	scope.thrownAt = 0;
}

/**
 * Whether `error` is the engine's stack overflow (`RangeError: Maximum call stack size exceeded` in V8 and JavaScriptCore,
 * `InternalError: too much recursion` in SpiderMonkey).
 * @param {unknown} error - The thrown value
 * @returns {boolean} `true` for a stack overflow
 */
function isStackOverflow(error: unknown): boolean {
	return error instanceof Error && (error.name === 'RangeError' || error.name === 'InternalError') && /call stack|too much recursion/i.test(error.message);
}

/**
 * Whether `error`, caught by the outermost check (or parse), means the value is nested too deeply to check: a stack overflow, raised
 * while lazy schemas were nested at least {@link TOO_DEEP} deep (lazy schemas record the depth at which they first see an error). An overflow at a shallower nesting comes from the code (a guard or a
 * transform that recurses forever, or a check started near the stack limit), and is rethrown.
 * @param {unknown} error - The thrown value
 * @returns {boolean} `true` for a value too deep to check
 * @internal
 */
export function isTooDeep(error: unknown): boolean {
	return scope.thrown === error && scope.thrownAt >= TOO_DEEP && isStackOverflow(error);
}
