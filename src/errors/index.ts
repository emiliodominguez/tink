/**
 * Helpers for whatever a `catch` block receives: normalizing it to an `Error` ({@link toError}), reading a message from it
 * ({@link getErrorMessage}), walking and printing its causes ({@link getErrorChain}, {@link formatError}), and moving errors across JSON
 * boundaries (workers, logs, HTTP responses) with {@link serializeError} and {@link deserializeError}. {@link defineError} creates typed
 * error classes with a code, default fields and a guard that works across bundles and realms.
 *
 * Conventions shared by every function in this module:
 * - **Never throws on the value.** Anything can be thrown in JavaScript: strings, `null`, symbols, bigints, objects whose getters or
 *   `toString` throw, revoked proxies. These functions accept all of it; only an invalid OPTION throws (a `TypeError` or `RangeError`).
 * - **Errors of any realm.** Errors from iframes and `vm` contexts are recognised as errors (see `isError` in `guards`), as are
 *   subclasses and `DOMException`s (of any realm too where the runtime has `Error.isError`).
 * - **Untrusted data.** {@link deserializeError} only ever instantiates built-in error constructors, chosen by name from a fixed list, and
 *   never reads or writes `__proto__`, `constructor` or `prototype`; values inherited from a polluted `Object.prototype` are ignored.
 *
 * The error classes thrown by other modules are `AbortError` and `TimeoutError` (`async`), `AssertionError` and `ValidationError`
 * (`guards`) and `JsonPatchError` (`objects`); all of them serialize and deserialize with these helpers (deserialized as an `Error` with
 * their `name` and own properties).
 * @packageDocumentation
 */
import { isPlainObject, type JsonValue } from '../guards/index.js';
import { assertInteger, describe, readOption } from '../utils/assert.js';
import { MAX_JSON_DEPTH, errorView, isAnyError, readText, toJsonMembers } from '../utils/json.js';

/**
 * An object with a string `name` and a string `message`, as recognised by {@link isErrorLike}: errors, and the plain objects errors
 * become once serialized.
 */
export interface ErrorLike {
	/** The error name, e.g. `'TypeError'`. */
	readonly name: string;
	/** The error message. */
	readonly message: string;
}

/**
 * The JSON-safe object {@link serializeError} returns: the error's `name` and `message`, its `stack`, its `cause` and an
 * `AggregateError`'s `errors` (errors among them serialized the same way), and its own `code` and other own enumerable properties,
 * converted to JSON values.
 */
export interface SerializedError {
	/** The error name (`'Error'` when it has none). */
	name: string;
	/** The error message (`''` when it has none). */
	message: string;
	/** The stack trace, when the error has one and the `stack` option is not `false`. */
	stack?: string;
	/** The cause, when the error has an own `cause`: a `SerializedError` for an error, any JSON value otherwise. */
	cause?: JsonValue;
	/** The errors of an `AggregateError`. */
	errors?: JsonValue[];
	/** Other own properties, such as Node's `code`, `errno` or `syscall`. */
	[key: string]: JsonValue | undefined;
}

/**
 * Options of {@link serializeError}.
 */
export interface SerializeErrorOptions {
	/**
	 * How deep objects are serialized below the error (the error itself is at depth 0): deeper objects, causes included, become the
	 * string `'[Object]'` (`'[Array]'` for arrays). An integer >= 0 or `Infinity` (the default); values above 1000 are clamped to 1000,
	 * the hard cap that keeps the result writable by `JSON.stringify`, so the default is effectively 1000.
	 */
	maxDepth?: number;
	/** Whether stack traces are kept (default `true`); `false` leaves them out, e.g. before sending an error to a client. */
	stack?: boolean;
}

/**
 * Options of {@link deserializeError}.
 */
export interface DeserializeErrorOptions {
	/**
	 * How many levels of `cause` and `errors` are rebuilt as errors (the root is at depth 0): deeper ones are kept as the data they are.
	 * An integer >= 0 or `Infinity` (the default).
	 */
	maxDepth?: number;
	/**
	 * Error classes to rebuild by name, an opt-in for your own classes (such as those of {@link defineError}): an error whose `name` is an
	 * own key of this object is built as usual and then given that class's `prototype`, so `instanceof` and the class's methods and
	 * getters work. The class's constructor is never called (its own fields, such as a {@link defineError} `code`, come from the data).
	 */
	classes?: Readonly<Record<string, abstract new (...args: never[]) => Error>>;
}

/** `Object.prototype.hasOwnProperty`. */
const hasOwn = Object.prototype.hasOwnProperty;

/** The constructors {@link deserializeError} may instantiate, by name: the built-in errors, nothing else. */
const BUILT_IN_ERRORS: ReadonlyMap<unknown, ErrorConstructor> = new Map<unknown, ErrorConstructor>([
	['Error', Error],
	['EvalError', EvalError],
	['RangeError', RangeError],
	['ReferenceError', ReferenceError],
	['SyntaxError', SyntaxError],
	['TypeError', TypeError],
	['URIError', URIError],
	['AggregateError', AggregateError as unknown as ErrorConstructor]
]);

/**
 * The keys {@link deserializeError} never copies besides those the rebuilt error already has (`name`, `message`, `stack`, a restored
 * `cause` or `errors`, and everything it inherits: `__proto__`, `constructor`, `toString`…): `errors` that is not an array, and `prototype`.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['errors', 'prototype']);

/**
 * Reads the depth option shared by the serializers.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {object} options - The options
 * @returns {number} The maximum depth
 * @throws {TypeError} when `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 */
function readDepth(caller: string, options: { maxDepth?: number }): number {
	const maxDepth = readOption(options, 'maxDepth', Infinity);
	assertInteger(caller, 'maxDepth', maxDepth, 0, true);
	return maxDepth;
}

/**
 * Checks whether a value is error-like: a non-null object with a string `name` and a string `message`, own or inherited (values
 * inherited from `Object.prototype` do not count, so a polluted prototype cannot make every object error-like). Every `Error` is
 * error-like, and so is a serialized error. Never throws: a throwing getter or a revoked proxy makes it `false`.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value has a string `name` and `message`
 * @example
 * isErrorLike(new TypeError('x')); // => true
 * isErrorLike({ name: 'HttpError', message: 'Not found', status: 404 }); // => true
 * isErrorLike({ message: 'x' }); // => false
 * isErrorLike('x'); // => false
 */
export function isErrorLike(value: unknown): value is ErrorLike {
	return typeof value === 'object' && value !== null && readText(value, 'name') !== undefined && readText(value, 'message') !== undefined;
}

/**
 * Describes a value that has no message, for {@link getErrorMessage}: a primitive as `String` writes it (a bigint with its `n`), a plain
 * object or an array as JSON, a function by its tag (not its source), any other object as `String` writes it, and by its tag or type
 * when that throws.
 * @param {unknown} value - The value
 * @returns {string} The description
 */
function describeValue(value: unknown): string {
	if (typeof value === 'bigint') return `${value}n`;
	try {
		if (typeof value === 'function') return Object.prototype.toString.call(value);
		if (typeof value === 'object' && value !== null && (Array.isArray(value) || isPlainObject(value))) {
			const json = JSON.stringify(value) as string | undefined;
			if (json !== undefined) return json;
		}
		return String(value);
	} catch {
		// A cycle, a throwing getter, `toJSON` or `toString`, a null-prototype object without `toString`, or a revoked proxy.
		try {
			return Object.prototype.toString.call(value);
		} catch {
			return describe(value);
		}
	}
}

/**
 * Returns a human-readable message for anything caught: a non-empty string as it is, the `message` of an error or of any object with a
 * non-empty string `message`; otherwise `fallback` when given, or else a description of the value (`'42'`, `'null'`, `'10n'`,
 * `'{"code":1}'` for a plain object or an array, `String(value)` for other objects, so `'Error'` for an error with an empty message).
 * Never throws for any `value`: throwing getters, `toString` or `toJSON` methods and revoked proxies fall back to coarser descriptions.
 * @param {unknown} value - The caught value
 * @param {string} [fallback] - Returned when the value carries no message
 * @returns {string} The message
 * @throws {TypeError} when `fallback` is not a string
 * @example
 * getErrorMessage(new Error('Disk full')); // => 'Disk full'
 * getErrorMessage('Timed out'); // => 'Timed out'
 * getErrorMessage({ message: 'Not found', status: 404 }); // => 'Not found'
 * getErrorMessage(42); // => '42'
 * getErrorMessage(null, 'Unknown error'); // => 'Unknown error'
 * getErrorMessage({ code: 'E_LOCKED' }); // => '{"code":"E_LOCKED"}'
 */
export function getErrorMessage(value: unknown, fallback?: string): string {
	if (fallback !== undefined && typeof fallback !== 'string') throw new TypeError(`getErrorMessage: \`fallback\` must be a string, got ${describe(fallback)}`);
	const message = typeof value === 'string' ? value : typeof value === 'object' && value !== null ? readText(value, 'message') : undefined;
	if (message !== undefined && message !== '') return message;
	return fallback ?? (typeof value === 'string' ? value : describeValue(value));
}

/**
 * Normalizes anything caught into an `Error`: an error (of any realm, including subclasses and `DOMException`s) is returned as it is;
 * anything else becomes a new `Error` whose message is {@link getErrorMessage}'s, whose `name` is the value's own when it is an
 * error-like object (`{ name: 'AbortError', message }`), and whose `cause` is the original value. Never throws.
 * @param {unknown} value - The caught value
 * @returns {Error} The value itself when it is an error, a new `Error` otherwise
 * @example
 * const error = new TypeError('x');
 * toError(error) === error; // => true
 * toError('Timed out').message; // => 'Timed out'
 * toError('Timed out').cause; // => 'Timed out'
 * toError({ name: 'AbortError', message: 'Aborted' }).name; // => 'AbortError'
 * toError(null).message; // => 'null'
 */
export function toError(value: unknown): Error {
	if (isAnyError(value)) return value;
	const error = new Error(getErrorMessage(value), { cause: value });
	// Read once more without throwing: a getter may give another value (or throw) the second time.
	const name = isErrorLike(value) ? readText(value, 'name') : undefined;
	if (name !== undefined && name !== '' && name !== 'Error') defineHidden(error, 'name', name);
	return error;
}

/**
 * Whether a value is serialized and formatted as an error: an `Error` (of any realm), or any object with a string `message`.
 * @param {unknown} value - The value
 * @returns {boolean} `true` for errors and error-like objects
 */
function isSource(value: unknown): value is object {
	// `readText` returns `undefined` for `null` (whose read throws).
	return isAnyError(value) || (typeof value === 'object' && readText(value as object, 'message') !== undefined);
}

/**
 * Converts an error into a plain, JSON-safe object (`JSON.stringify` never throws on it, and `JSON.parse` gives back an equal object):
 * - `name`, `message` and `stack` (own or inherited), then the own `code` (even non-enumerable), `cause` and `errors` (of an
 *   `AggregateError`), then the other own enumerable string keys; values are converted as `JSON.stringify` would (`toJSON` is honoured,
 *   functions and `undefined` are left out), with nested errors serialized the same way. The error's own `toJSON`, if any, is not used:
 *   this function defines its shape.
 * - Never throws: circular references become `'[Circular]'`, bigints decimal strings, maps the array of their entries and sets the array
 *   of their values, a getter or `toJSON` that throws `'[Throws: <message>]'`, and objects deeper than `maxDepth` `'[Object]'`/`'[Array]'`.
 *   Nesting is capped at 1000 levels whatever `maxDepth` asks for (a longer chain of causes ends in these markers too), so that a
 *   hostile, deeply nested error cannot overflow the stack, here or when the result is passed to `JSON.stringify` with an ordinary amount
 *   of stack left (a caller already deep in its stack can use `safeStringify` from the `objects` module, which retries shallower).
 * - An error-like value that is not an `Error` (any object with a string `message`, such as an already serialized error) is serialized
 *   the same way, so serializing twice changes nothing. Anything else becomes `{ name: 'Error', message: getErrorMessage(value) }`.
 * @param {unknown} value - The error (or anything caught)
 * @param {SerializeErrorOptions} [options={}] - `maxDepth` (default `Infinity`, clamped to 1000) and `stack` (default `true`)
 * @returns {SerializedError} The plain object
 * @throws {TypeError} when `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 * @example
 * const error = new RangeError('Too big', { cause: new Error('Limit: 10') });
 * serializeError(error, { stack: false }); // => { name: 'RangeError', message: 'Too big', cause: { name: 'Error', message: 'Limit: 10' } }
 * const failure = Object.assign(new Error('Missing'), { code: 'ENOENT', path: '/tmp/x' });
 * serializeError(failure, { stack: false }); // => { name: 'Error', message: 'Missing', code: 'ENOENT', path: '/tmp/x' }
 * serializeError('Timed out'); // => { name: 'Error', message: 'Timed out' }
 * const loop = new Error('Loop');
 * loop.cause = loop;
 * serializeError(loop, { stack: false }); // => { name: 'Error', message: 'Loop', cause: '[Circular]' }
 */
export function serializeError(value: unknown, options: SerializeErrorOptions = {}): SerializedError {
	const maxDepth = readDepth('serializeError', options);
	const stack = readOption(options, 'stack') !== false;
	const source = isSource(value) ? value : undefined;
	const view = source === undefined ? { name: 'Error', message: getErrorMessage(value) } : errorView(source, stack);
	return toJsonMembers(view, {
		replacer: undefined,
		keys: undefined,
		stack,
		maxDepth: Math.min(maxDepth, MAX_JSON_DEPTH),
		ancestors: source === undefined ? [] : [source],
		onPath: new Set(source === undefined ? [] : [source])
	}) as SerializedError;
}

/**
 * Defines an own data property whatever a polluted `Object.prototype` holds: every attribute is given, so none is inherited, and a
 * descriptor that inherits a `get` or `set` (an accessor with a value, which `Object.defineProperty` rejects with a `TypeError`) is
 * given again without a prototype. Only the retry pays for that: a descriptor without a prototype is slower to read.
 * @param {object} target - The object
 * @param {PropertyKey} key - The key
 * @param {unknown} value - The value
 * @param {boolean} writable - Whether the property is writable
 * @param {boolean} enumerable - Whether it is enumerable
 * @param {boolean} [configurable=true] - Whether it is configurable
 * @returns {void}
 */
function defineValue(target: object, key: PropertyKey, value: unknown, writable: boolean, enumerable: boolean, configurable = true): void {
	const descriptor: PropertyDescriptor = { value, writable, enumerable, configurable };
	try {
		Object.defineProperty(target, key, descriptor);
	} catch {
		Object.defineProperty(target, key, Object.setPrototypeOf(descriptor, null) as PropertyDescriptor);
	}
}

/**
 * Defines a non-enumerable own property, as the `Error` constructors define `message`, `cause` and `errors`.
 * @param {Error} error - The error
 * @param {string} key - The key
 * @param {unknown} value - The value
 * @returns {void}
 */
function defineHidden(error: Error, key: string, value: unknown): void {
	defineValue(error, key, value, true, false);
}

/**
 * Reads the `name` of a rebuilt error without throwing: a class given to {@link deserializeError} may define a throwing getter (or
 * have a hostile proxy as its prototype).
 * @param {Error} error - The error
 * @returns {unknown} Its name, or `undefined` when reading it throws
 */
function readName(error: Error): unknown {
	try {
		return error.name;
	} catch {
		return undefined;
	}
}

/**
 * Whether an object has a property, own or inherited (`key in object`), leaving out the values planted on a polluted `Object.prototype`:
 * from it, only its methods (`toString`, `hasOwnProperty`…) and `__proto__` count, so that a planted `status` is not taken for a property
 * of every object.
 * @param {object} object - The object
 * @param {string} key - The key
 * @returns {boolean} Whether the object or a prototype below `Object.prototype` has it, or it is a method of `Object.prototype`
 */
function holds(object: object, key: string): boolean {
	if (!(key in object)) return false;
	let current = object;
	while (current !== Object.prototype && !hasOwn.call(current, key)) current = Object.getPrototypeOf(current) as object;
	return current !== Object.prototype || key === '__proto__' || typeof (Object.prototype as Record<string, unknown>)[key] === 'function';
}

/**
 * An error {@link deserializeError} is rebuilding, and how far the copy of its properties went.
 */
interface Rebuilding {
	readonly data: object;
	readonly error: Error;
	/** Levels of `cause` and `errors` left to rebuild below it. */
	readonly depth: number;
	/** Whether the `cause` is restored (the items of `errors` come next, then the other keys). */
	caused: boolean;
	/** The `errors` array of the data, once read, its items rebuilt so far (holes stay holes), and the next one. */
	errors: unknown[] | undefined;
	items: unknown[];
	index: number;
}

/**
 * Creates the error of a data object for {@link deserializeError}: its class, `name`, `message` and `stack` (the other properties are
 * copied by {@link advance}), and records it, so that a shared or circular reference gives the same error.
 * @param {object} data - The serialized error
 * @param {number} depth - Levels of `cause` and `errors` left to rebuild below it
 * @param {Map<object, Error>} built - The error rebuilt from each data object so far
 * @param {ReadonlyMap<unknown, object>} classes - The prototype to give the errors of each name (the `classes` option)
 * @returns {Rebuilding} The error, with nothing else copied yet
 */
function create(data: object, depth: number, built: Map<object, Error>, classes: ReadonlyMap<unknown, object>): Rebuilding {
	const name = readText(data, 'name');
	const message = readText(data, 'message') ?? '';
	const Constructor = BUILT_IN_ERRORS.get(name) ?? Error;
	const error = name === 'AggregateError' ? new AggregateError([], message) : new Constructor(message);
	const prototype = classes.get(name);
	// The built-in error keeps its internal slot (so `isError` and `Error.isError` still recognise it): only its prototype changes.
	if (prototype !== undefined) Object.setPrototypeOf(error, prototype);
	built.set(data, error);
	if (name !== undefined && name !== readName(error)) defineHidden(error, 'name', name);
	const stack = readText(data, 'stack');
	if (stack !== undefined) defineHidden(error, 'stack', stack);
	return { data, error, depth, caused: false, errors: undefined, items: [], index: 0 };
}

/**
 * Copies the properties of an error being rebuilt, until a nested error-like value needs an error of its own (rebuilt first, so that
 * the errors are built depth-first, in the order of the data, without recursion).
 * @param {Rebuilding} entry - The error being rebuilt
 * @param {Map<object, Error>} built - The error rebuilt from each data object so far
 * @param {ReadonlyMap<unknown, object>} classes - The prototype to give the errors of each name
 * @returns {Rebuilding | undefined} The nested error to rebuild before going on, or `undefined` once every property is copied
 */
function advance(entry: Rebuilding, built: Map<object, Error>, classes: ReadonlyMap<unknown, object>): Rebuilding | undefined {
	const { data, error, depth } = entry;
	let next: Rebuilding | undefined;
	/**
	 * The value a nested `cause` or item of `errors` is restored as: its error when it is error-like (created, when it is new, to be
	 * rebuilt next), anything else as it is.
	 * @param {unknown} nested - The value
	 * @returns {unknown} The value to restore
	 */
	function restore(nested: unknown): unknown {
		if (depth === 0 || !isErrorLike(nested) || isAnyError(nested)) return nested;
		const done = built.get(nested);
		if (done !== undefined) return done;
		next = create(nested, depth - 1, built, classes);
		return next.error;
	}
	if (!entry.caused) {
		entry.caused = true;
		if (hasOwn.call(data, 'cause')) defineHidden(error, 'cause', restore((data as { cause: unknown }).cause));
		if (next !== undefined) return next;
	}
	if (entry.errors === undefined) {
		const errors = hasOwn.call(data, 'errors') ? (data as { errors: unknown }).errors : undefined;
		// The length of an array is read once, like `Array#map` does. Anything else is neither restored nor copied: `items` is then
		// `errors` itself, empty.
		if (Array.isArray(errors)) entry.items = new Array<unknown>(errors.length);
		entry.errors = Array.isArray(errors) ? errors : entry.items;
	}
	const { errors, items } = entry;
	while (entry.index < items.length) {
		const index = entry.index++;
		// A hole stays a hole, rather than reading a polluted `Object.prototype[index]`.
		if (hasOwn.call(errors, index)) items[index] = restore(errors[index]);
		if (next !== undefined) return next;
	}
	if (items !== errors) defineHidden(error, 'errors', items);
	for (const key of Object.keys(data)) {
		// A key the error has or inherits (`toString`, `valueOf`, `hasOwnProperty`…) would shadow its method: `String(error)` would throw.
		if (!RESERVED_KEYS.has(key) && !holds(error, key)) defineValue(error, key, (data as Record<string, unknown>)[key], true, true);
	}
	return undefined;
}

/**
 * The worker of {@link deserializeError}: iterative, with an explicit stack of the errors being rebuilt, so that a chain of causes of
 * any length is rebuilt whole.
 * @param {unknown} data - The serialized error
 * @param {number} depth - Levels of `cause` and `errors` to rebuild
 * @param {ReadonlyMap<unknown, object>} classes - The prototype to give the errors of each name (the `classes` option)
 * @returns {Error} The error
 */
function rebuild(data: unknown, depth: number, classes: ReadonlyMap<unknown, object>): Error {
	if (isAnyError(data)) return data;
	if (typeof data !== 'object' || data === null) return new Error(getErrorMessage(data));
	const built = new Map<object, Error>();
	const root = create(data, depth, built, classes);
	const todo = [root];
	while (todo.length !== 0) {
		const entry = todo[todo.length - 1];
		let next: Rebuilding | undefined;
		try {
			next = advance(entry, built, classes);
		} catch {
			// A throwing getter or a hostile proxy: the properties copied so far are kept.
		}
		if (next === undefined) todo.pop();
		else todo.push(next);
	}
	return root.error;
}

/**
 * Rebuilds an `Error` from the output of {@link serializeError} (after any number of `JSON.stringify`/`JSON.parse` round trips):
 * - The class is chosen by `name` among the built-in errors (`Error`, `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`,
 *   `TypeError`, `URIError`, `AggregateError`); any other name gives an `Error` with that `name`. No other constructor is ever called,
 *   so untrusted data cannot instantiate arbitrary classes. Your own classes are opt-in: with `classes: { NotFoundError: NotFound }`, an
 *   error named `NotFoundError` is built that way and then given `NotFound.prototype` (its constructor is still not called).
 * - `message`, `stack` (when present; otherwise the stack is where `deserializeError` was called), `cause` and `errors` are restored as
 *   the non-enumerable properties the constructors create; an error-like `cause` or item of `errors` is rebuilt the same way (up to
 *   `maxDepth` levels, without recursion: a chain of any length is rebuilt whole), anything else is kept as data (a hole of `errors`
 *   stays a hole). Shared and circular references between them are preserved.
 * - Other own enumerable properties (`code`, `status`…) are copied, except `__proto__`, `constructor`, `prototype` and any key the error
 *   inherits (`toString`, `valueOf`, `toLocaleString`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `__defineGetter__`…),
 *   so that hostile data cannot shadow a method of the error and make `String(error)` or a logger throw; their values are kept as they
 *   are (not copied deeply). Values inherited from `Object.prototype` are ignored (a key planted there is copied like any other).
 *
 * An `Error` is returned as it is; any other value that is not an object gives an `Error` with {@link getErrorMessage}'s message. Never
 * throws for any `data`.
 * @param {unknown} data - The serialized error
 * @param {DeserializeErrorOptions} [options={}] - `maxDepth` (default `Infinity`) and `classes` (none by default)
 * @returns {Error} The rebuilt error
 * @throws {TypeError} when `maxDepth` is not a number, `classes` is not an object, or one of its values is not a class
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 * @example
 * const error = deserializeError(JSON.parse('{"name":"TypeError","message":"Bad input","code":"E_INPUT"}'));
 * error instanceof TypeError; // => true
 * error.message; // => 'Bad input'
 * (error as Error & { code?: string }).code; // => 'E_INPUT'
 * deserializeError({ name: 'AbortError', message: 'Aborted' }).name; // => 'AbortError'
 * const copy = deserializeError(JSON.parse(JSON.stringify(serializeError(new Error('Outer', { cause: new RangeError('Inner') })))));
 * copy.cause instanceof RangeError; // => true
 * @example
 * const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND' });
 * const data = JSON.parse(JSON.stringify(serializeError(new NotFound('No user 42'))));
 * deserializeError(data) instanceof NotFound; // => false // built-in classes only, by default
 * const rebuilt = deserializeError(data, { classes: { NotFoundError: NotFound } });
 * rebuilt instanceof NotFound; // => true
 * NotFound.is(rebuilt) && rebuilt.code; // => 'E_NOT_FOUND'
 */
export function deserializeError(data: unknown, options: DeserializeErrorOptions = {}): Error {
	return rebuild(data, readDepth('deserializeError', options), readClasses(readOption(options, 'classes')));
}

/**
 * Validates the `classes` option of {@link deserializeError} and indexes the prototypes of its own entries by name (read once, here).
 * @param {unknown} classes - The option
 * @returns {ReadonlyMap<unknown, object>} The prototype of each class, by name
 * @throws {TypeError} when `classes` is not an object, or one of its values is not a class with an object `prototype`
 */
function readClasses(classes: unknown): ReadonlyMap<unknown, object> {
	const prototypes = new Map<unknown, object>();
	if (classes === undefined) return prototypes;
	if (typeof classes !== 'object' || classes === null) throw new TypeError(`deserializeError: \`classes\` must be an object, got ${describe(classes)}`);
	for (const name of Object.keys(classes)) {
		const Class = (classes as Record<string, unknown>)[name];
		let prototype: unknown;
		try {
			if (typeof Class === 'function') prototype = (Class as { prototype?: unknown }).prototype;
		} catch {
			// A proxy whose `get` trap throws: no usable prototype.
		}
		if (typeof prototype !== 'object' || prototype === null)
			throw new TypeError(
				`deserializeError: \`classes.${name}\` must be a class, got ${typeof Class === 'function' ? 'a function without prototype' : describe(Class)}`
			);
		prototypes.set(name, prototype);
	}
	return prototypes;
}

// ---------------------------------------------------------------------------------------------------------------------
// defineError
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The options of {@link defineError}: an optional `code`, and default values for any other fields its errors carry.
 */
export interface DefineErrorOptions {
	/** The code of every error of the class (Node style, such as `'E_NOT_FOUND'`), typed as its literal. It cannot be changed per error. */
	readonly code?: string;
	/** The default value of another field of the errors (overridable per error). */
	readonly [field: string]: unknown;
}

/**
 * The type of a field of {@link defineError}'s errors: the type of the default as it would be inferred without `const`, since each error
 * may override it. Literal types are widened to their primitive (`404` gives `number`), and arrays and objects are widened deeply
 * (`['a']` gives `string[]`, `{ max: 3 }` gives `{ max: number }`); functions are kept as they are.
 * @template T - The type of the default value
 */
export type WidenField<T> = T extends string
	? string
	: T extends number
		? number
		: T extends boolean
			? boolean
			: T extends bigint
				? bigint
				: T extends readonly unknown[]
					? WidenField<T[number]>[]
					: T extends (...args: never[]) => unknown
						? T
						: T extends object
							? { -readonly [K in keyof T]: WidenField<T[K]> }
							: T;

/**
 * An error created by a {@link defineError} class: an `Error` with the class's literal `name`, its literal `code`, and its other fields.
 * @template N - The error name
 * @template M - The options the class was defined with
 */
export type DefinedError<N extends string, M extends DefineErrorOptions = Record<never, never>> = Error & { name: N } & {
	-readonly [K in keyof M]: K extends 'code' ? M[K] : WidenField<M[K]>;
};

/**
 * The second argument of a {@link defineError} constructor: the standard `cause`, and a value for any field the class defines (except
 * `code`); a field left out or `undefined` keeps the class's default.
 * @template M - The options the class was defined with
 */
export type DefinedErrorInit<M extends DefineErrorOptions = Record<never, never>> = { cause?: unknown } & { [K in Exclude<keyof M, 'code'>]?: WidenField<M[K]> };

/**
 * A class created by {@link defineError}. Extend it with `class X extends NotFound {}` like any error class.
 * @template N - The error name
 * @template M - The options the class was defined with
 */
export type DefinedErrorClass<N extends string, M extends DefineErrorOptions = Record<never, never>> = {
	/**
	 * Creates an error.
	 * @param {string} [message] - The message
	 * @param {DefinedErrorInit<M>} [init] - `cause`, and the values of the class's fields
	 */
	new (message?: string, init?: DefinedErrorInit<M>): DefinedError<N, M>;
	/** The prototype of the errors. */
	readonly prototype: DefinedError<N, M>;
	/** The error name (also the `name` of the class). */
	readonly name: N;
	/**
	 * Whether `value` is an error of this class, from this bundle or from another copy of the class defined with the same name (another
	 * bundle, realm or version of tinkit): recognised by a brand that `Symbol.for` shares between them, not by `instanceof`. Never
	 * throws. Called on a subclass (`Sub.is(value)`), it is `value instanceof Sub` instead.
	 * @param {unknown} value - Any value
	 * @returns {boolean} `true` for an error of this class or of a subclass
	 */
	is(value: unknown): value is DefinedError<N, M>;
} & { readonly [K in keyof M]: M[K] };

/** Field names {@link defineError} rejects besides those its classes and errors already have (`name`, `message`, `toString`…). */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['stack', 'cause', 'errors', 'is']);

/** Whether `Error.captureStackTrace` is needed to leave constructor frames out of stacks (computed on first use, by {@link capturesStack}). */
let captureNeeded: boolean | undefined;

/**
 * Whether the constructors of {@link defineError} must call `Error.captureStackTrace` to leave their own frames out of `stack`. V8 (Node,
 * Deno, Chrome) already leaves out the frames of the constructors up to `new.target`, so a second capture would only double the cost of
 * creating an error: this is checked by comparing the stacks of a plain and a derived error created at the same place, once the answer is
 * conclusive (different stacks, or equal ones with more than one line; not while `Error.stackTraceLimit` is 0 or the stack cannot be read,
 * when the class is created without the capture and the next {@link defineError} call probes again).
 * @returns {boolean} `true` when `Error.captureStackTrace` exists and is needed
 */
function capturesStack(): boolean {
	if (captureNeeded === undefined) {
		/** A derived error class with a constructor of its own, like those of {@link defineError}. */
		class StackProbe extends Error {
			/** Calls `super`, like the constructors of {@link defineError}. */
			// eslint-disable-next-line no-useless-constructor -- an explicit constructor, like those of `defineError`, is what is probed
			constructor() {
				super();
			}
		}
		const stacks: unknown[] = [];
		try {
			for (const Probe of [Error, StackProbe]) stacks.push(new Probe().stack);
		} catch {
			// A throwing `Error.prepareStackTrace`: inconclusive, so no second capture for now (it would call it again).
		}
		const differ = stacks[0] !== stacks[1];
		// Both stacks are needed: one alone differs from `stacks[1]`, which would also read a polluted `Object.prototype[1]`.
		if (stacks.length !== 2 || (!differ && !(typeof stacks[0] === 'string' && stacks[0].includes('\n')))) return false;
		captureNeeded = differ && typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === 'function';
	}
	return captureNeeded;
}

/**
 * Creates a typed error class: `const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404 })`, then
 * `throw new NotFound('No user 42', { cause, status: 410 })`.
 * - **Name:** `name` is on the prototype (so `String(error)` and the stack read `NotFoundError: …`) and is the class's `name` too.
 *   `instanceof` works, subclasses (`class Gone extends NotFound {}`) too, and the stack leaves out the constructors' frames (V8 does it
 *   natively; elsewhere `Error.captureStackTrace` is used when it exists).
 * - **Fields:** `code` and every other option become own enumerable properties of each error (`code` is fixed; the others take the value
 *   given to the constructor, or the default when it is left out or `undefined`). The defaults are also read-only static properties of
 *   the class (`NotFound.code`), typed as literals. Defaults are shared, not copied: give an object or array field a fresh value per error.
 *   `cause` is read only when it is an own property of the second argument; anything but an object there is ignored, as `Error` does.
 * - **Guard:** `NotFound.is(value)` recognises its errors across bundles and realms (by a brand that `Symbol.for` shares, and the name).
 * - **Serialization:** {@link serializeError} keeps `name`, `message`, `code`, the fields and the cause; {@link deserializeError} rebuilds
 *   an `Error` with all of them, or a real `NotFound` when you opt in with `classes: { NotFoundError: NotFound }`.
 *
 * Reserved field names (they would break errors or the class) throw a `RangeError`: `name`, `message`, `stack`, `cause`, `errors`, `is`,
 * `prototype`, `length`, and anything else errors or classes already have (`toString`, `constructor`, `captureStackTrace`…).
 * @template N - The error name
 * @template M - The options
 * @param {N} name - The error name (non-empty), conventionally ending in `Error`
 * @param {M} [options={}] - `code` (a string), and the default values of other fields (own enumerable string keys)
 * @returns {DefinedErrorClass<N, M>} The class
 * @throws {TypeError} when `name` is not a string, `options` is not an object, or `code` is not a string
 * @throws {RangeError} when `name` is empty or a field name is reserved
 * @example
 * const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404 });
 * const error = new NotFound('No user 42', { cause: 'db miss' });
 * error instanceof NotFound && error instanceof Error; // => true
 * [error.name, error.code, error.status, error.cause]; // => ['NotFoundError', 'E_NOT_FOUND', 404, 'db miss']
 * new NotFound('Gone', { status: 410 }).status; // => 410
 * String(error); // => 'NotFoundError: No user 42'
 * [NotFound.name, NotFound.code, NotFound.status]; // => ['NotFoundError', 'E_NOT_FOUND', 404]
 * NotFound.is(error); // => true
 * NotFound.is(new Error('x')); // => false
 * @example
 * const HttpError = defineError('HttpError', { status: 500, url: undefined as string | undefined });
 * class GatewayTimeout extends HttpError {
 *   retryable(): boolean { return true; }
 * }
 * const timeout = new GatewayTimeout('Timed out', { status: 504, url: '/api' });
 * timeout instanceof HttpError && timeout.retryable(); // => true
 * [timeout.name, timeout.status, timeout.url]; // => ['HttpError', 504, '/api']
 * serializeError(timeout, { stack: false }); // => { name: 'HttpError', message: 'Timed out', status: 504, url: '/api' }
 */
export function defineError<const N extends string, const M extends DefineErrorOptions = Record<never, never>>(name: N, options?: M): DefinedErrorClass<N, M>;
/**
 * Implementation of {@link defineError} (see the first overload for the full documentation).
 * @param {string} name - The error name
 * @param {DefineErrorOptions} [options={}] - `code`, and the default values of other fields
 * @returns {DefinedErrorClass<string>} The class
 * @throws {TypeError} when `name` is not a string, `options` is not an object, or `code` is not a string
 * @throws {RangeError} when `name` is empty or a field name is reserved
 */
export function defineError(name: string, options: DefineErrorOptions = {}): DefinedErrorClass<string> {
	if (typeof name !== 'string') throw new TypeError(`defineError: \`name\` must be a non-empty string, got ${describe(name)}`);
	if (name === '') throw new RangeError('defineError: `name` must be a non-empty string, got an empty string');
	if (typeof options !== 'object' || options === null) throw new TypeError(`defineError: \`options\` must be an object, got ${describe(options)}`);
	const keys = Object.keys(options);
	const defaults = keys.map(function (key: string): unknown {
		return options[key];
	});
	const code = keys.indexOf('code');
	if (code !== -1 && typeof defaults[code] !== 'string') throw new TypeError(`defineError: \`options.code\` must be a string, got ${describe(defaults[code])}`);
	const brand = Symbol.for('tinkit.defineError');
	const capture = capturesStack();

	/** The class. */
	class DefinedError extends Error {
		/**
		 * Creates an error of the class.
		 * @param {string} [message] - The message
		 * @param {Record<string, unknown>} [init] - `cause`, and the values of the fields
		 */
		constructor(message?: string, init?: Readonly<Record<string, unknown>>) {
			const given = typeof init === 'object' && init !== null ? init : undefined;
			super(message, given !== undefined && hasOwn.call(given, 'cause') ? { cause: given.cause } : undefined);
			for (let index = 0; index < keys.length; index++) {
				const value = index === code || given === undefined || !hasOwn.call(given, keys[index]) ? undefined : given[keys[index]];
				defineValue(this, keys[index], value === undefined ? defaults[index] : value, true, true);
			}
			if (capture) (Error as unknown as { captureStackTrace(target: object, constructor: unknown): void }).captureStackTrace(this, new.target);
		}
	}

	for (const key of keys) {
		// A key planted on a polluted `Object.prototype` is not one the class or its errors have.
		if (RESERVED_FIELDS.has(key) || holds(DefinedError, key) || holds(DefinedError.prototype, key))
			throw new RangeError(`defineError: \`options.${key}\` is a reserved field name`);
	}
	/**
	 * Recognises the errors of the class (see {@link DefinedErrorClass}).
	 * @param {unknown} value - Any value
	 * @returns {boolean} Whether it is an error of the class
	 */
	function is(this: unknown, value: unknown): boolean {
		try {
			if (typeof this === 'function' && this !== DefinedError) return value instanceof this;
			return isAnyError(value) && (value as unknown as Record<symbol, unknown>)[brand] === name;
		} catch {
			// A revoked proxy, or a throwing `Symbol.hasInstance` or getter.
			return false;
		}
	}
	defineValue(DefinedError, 'name', name, false, false);
	defineValue(DefinedError, 'is', is, true, false);
	for (let index = 0; index < keys.length; index++) defineValue(DefinedError, keys[index], defaults[index], false, true, false);
	defineValue(DefinedError.prototype, 'name', name, true, false);
	defineValue(DefinedError.prototype, brand, name, false, false, false);
	return DefinedError as unknown as DefinedErrorClass<string>;
}

// ---------------------------------------------------------------------------------------------------------------------
// getErrorChain / formatError
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options of {@link getErrorChain}.
 */
export interface ErrorChainOptions {
	/** Whether the `errors` of an `AggregateError` (any own `errors` array) are walked too, depth-first (default `false`). */
	aggregate?: boolean;
	/**
	 * How many levels below the error are walked (the error itself is at depth 0). An integer >= 0 or `Infinity` (the default); values
	 * above 1000 are clamped to 1000, the cap {@link serializeError} applies too.
	 */
	maxDepth?: number;
}

/**
 * Options of {@link formatError}.
 */
export interface FormatErrorOptions {
	/** Whether stack frames are printed (default `true`). */
	stack?: boolean;
	/**
	 * How many levels of causes and aggregated errors are printed (the error itself is at depth 0): deeper ones are replaced by a
	 * `[Truncated]` line. An integer >= 0 or `Infinity` (the default); values above 1000 are clamped to 1000.
	 */
	maxDepth?: number;
}

/**
 * Reads the own `cause` of a value without throwing.
 * @param {object} value - An error or error-like object
 * @returns {unknown} The cause, or `undefined` when there is none (or it cannot be read)
 */
function readCause(value: object): unknown {
	let cause: unknown;
	try {
		if (hasOwn.call(value, 'cause')) cause = (value as { cause: unknown }).cause;
	} catch {
		// A revoked proxy, or a throwing getter or trap: no cause.
	}
	return cause;
}

/**
 * Reads the items of the own `errors` array of a value (an `AggregateError`, or its serialized form) without throwing.
 * @param {object} value - An error or error-like object
 * @returns {unknown[]} A copy of the items (those read before a read threw), empty when there is no `errors` array
 */
function readErrors(value: object): unknown[] {
	const items: unknown[] = [];
	try {
		const errors = hasOwn.call(value, 'errors') ? (value as { errors: unknown }).errors : undefined;
		// A hole reads as `undefined`, not as a polluted `Object.prototype[index]`.
		if (Array.isArray(errors)) for (let index = 0; index < errors.length; index++) items.push(hasOwn.call(errors, index) ? errors[index] : undefined);
	} catch {
		// A revoked proxy, or a throwing getter or trap: the items read so far are kept.
	}
	return items;
}

/**
 * Lists an error and its causes: `[error, error.cause, error.cause.cause, …]`, following own `cause` properties of objects (errors,
 * error-like objects, serialized errors). The chain ends at a value that is not an object, an object without an own `cause` (or with an
 * `undefined` one), or `maxDepth` levels down; a value that is not an error, such as a string cause, is included as it is.
 * - With `aggregate: true`, the own `errors` array of an `AggregateError` (or of any object) is walked too, depth-first in pre-order:
 *   each value, then each of its `errors` with everything below it, then its `cause` with everything below it.
 * - Cycle-safe: an object met again (a circular or shared reference) is not listed again, so the result is at most as long as the number
 *   of distinct objects reached plus their primitive causes. Iterative (no recursion), O(n), and never throws on the value: getters,
 *   proxies and revoked proxies that throw end that branch.
 * @param {unknown} error - The error (or anything caught)
 * @param {ErrorChainOptions} [options={}] - `aggregate` (default `false`) and `maxDepth` (default `Infinity`, clamped to 1000)
 * @returns {unknown[]} The error, then its causes (and aggregated errors), outermost first
 * @throws {TypeError} when `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 * @example
 * const root = new Error('ECONNREFUSED');
 * const error = new Error('Request failed', { cause: new TypeError('fetch failed', { cause: root }) });
 * function message(value: unknown): string { return getErrorMessage(value); }
 * getErrorChain(error).map(message); // => ['Request failed', 'fetch failed', 'ECONNREFUSED']
 * getErrorChain(error).at(-1) === root; // => true
 * getErrorChain(new Error('x', { cause: 'disk full' }))[1]; // => 'disk full'
 * const group = new AggregateError([new Error('a', { cause: new Error('a1') }), new Error('b')], 'all', { cause: new Error('c') });
 * getErrorChain(group, { aggregate: true }).map(message); // => ['all', 'a', 'a1', 'b', 'c']
 * const loop = new Error('loop');
 * loop.cause = loop;
 * getErrorChain(loop).length; // => 1
 */
export function getErrorChain(error: unknown, options: ErrorChainOptions = {}): unknown[] {
	const maxDepth = Math.min(readDepth('getErrorChain', options), MAX_JSON_DEPTH);
	const aggregate = readOption(options, 'aggregate') === true;
	const chain: unknown[] = [];
	if (!aggregate) {
		// A single chain: no stack needed, and a linear scan of the (short) chain finds cycles faster than a `Set`, until it grows.
		chain.push(error);
		let seen: Set<unknown> | undefined;
		for (let value = error, depth = 0; depth < maxDepth; depth++) {
			// Only objects have causes (`readCause` gives none for `null`, whose read throws). A primitive cause ends the chain on the next step,
			// so checking it for a cycle too is harmless: the chain holds objects only before it.
			const cause = typeof value === 'object' ? readCause(value as object) : undefined;
			if (cause === undefined) break;
			if (seen === undefined && chain.length > 16) seen = new Set(chain);
			if (seen === undefined ? chain.includes(cause) : seen.has(cause)) break;
			seen?.add(cause);
			chain.push(cause);
			value = cause;
		}
		return chain;
	}
	const seen = new Set<object>();
	// Depth-first, with an explicit stack of the values to visit and their depths (pushed in reverse order of visit).
	const values: unknown[] = [error];
	const depths: number[] = [0];
	while (values.length !== 0) {
		const value = values.pop();
		const depth = depths.pop() as number;
		if (typeof value !== 'object' || value === null) {
			chain.push(value);
			continue;
		}
		if (seen.has(value)) continue;
		seen.add(value);
		chain.push(value);
		if (depth === maxDepth) continue;
		const cause = readCause(value);
		if (cause !== undefined) {
			values.push(cause);
			depths.push(depth + 1);
		}
		const errors = readErrors(value);
		for (let index = errors.length - 1; index >= 0; index--) {
			values.push(errors[index]);
			depths.push(depth + 1);
		}
	}
	return chain;
}

/**
 * The first line of a printed error: `Name: message` as `Error.prototype.toString` writes it (`Name` alone when the message is empty, the
 * message alone when the name is), or {@link getErrorMessage}'s description of a value that is not error-like.
 * @param {unknown} value - The error (or anything caught)
 * @returns {string} The header
 */
function headerOf(value: unknown): string {
	if (!isSource(value)) return getErrorMessage(value);
	const name = readText(value, 'name') ?? 'Error';
	const message = readText(value, 'message') ?? '';
	return name === '' ? message : message === '' ? name : `${name}: ${message}`;
}

/**
 * Appends the frames of a stack trace, without the header that V8 writes before them (whether or not it is still the current header).
 * @param {string[]} lines - The output lines
 * @param {string} stack - The stack trace
 * @param {string} header - The error's current header
 * @param {string} indent - The indentation of the frames
 * @returns {void}
 */
function pushFrames(lines: string[], stack: string, header: string, indent: string): void {
	let frames = stack;
	// The header must be the whole first line: after `error.message = 'Request'`, a stack written as `Error: Request failed` starts with the
	// new header too, and ` failed` would be printed as a frame.
	if (stack.startsWith(header) && (stack.length === header.length || stack.charCodeAt(header.length) === 10)) frames = stack.slice(header.length);
	else {
		// A header written before the message or name changed: V8's frames start at the first `at` line (`[ \t]`, not `\s`, keeps the
		// search linear). Other engines (Firefox, Safari) write frames only.
		const first = stack.search(/\n[ \t]+at /);
		if (first !== -1) frames = stack.slice(first);
	}
	for (const line of frames.split('\n')) {
		const frame = line.trim();
		if (frame !== '') lines.push(`${indent}${frame}`);
	}
}

/**
 * Formats an error as a human-readable, multi-line report: `Name: message`, its stack frames, then its aggregated `errors` (labelled
 * `[1/2]`, `[2/2]`…) and its `cause` (`Caused by: …`), each nested two spaces deeper, recursively:
 *
 * ```text
 * AggregateError: 2 tasks failed
 *     at main (app.js:9:11)
 *   [1/2] TypeError: Bad input
 *       at parse (app.js:3:9)
 *     Caused by: SyntaxError: Unexpected token
 *   [2/2] Error: Timed out
 *   Caused by: Error: Pool closed
 * ```
 *
 * - The frames come from `stack`, without the header V8 writes before them, trimmed and indented four spaces below their error's line;
 *   `stack: false` leaves them out (e.g. for a user-facing message). A cause that is not error-like is printed as {@link getErrorMessage}
 *   describes it (`Caused by: disk full`), and so is a thrown value that is not an error.
 * - The indentation stops growing 10 levels down (20 spaces): deeper lines keep it and start with a `[depth N]` marker instead
 *   (`[depth 11] Caused by: …`), so that the report grows linearly with the chain (no `d²` spaces for a chain `d` levels deep).
 * - Never throws, and prints each object once: a circular reference prints `[Circular]`, an error met again in another branch prints
 *   its header followed by `[Seen above]` (without its frames, causes and errors), and the causes and errors deeper than `maxDepth` are
 *   replaced by one `[Truncated]` line. Iterative (no recursion), and linear in the size of what it prints.
 * @param {unknown} error - The error (or anything caught)
 * @param {FormatErrorOptions} [options={}] - `stack` (default `true`) and `maxDepth` (default `Infinity`, clamped to 1000)
 * @returns {string} The report (lines separated by `\n`, no trailing newline)
 * @throws {TypeError} when `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 * @example
 * const error = new Error('Request failed', { cause: new TypeError('fetch failed', { cause: 'ECONNREFUSED' }) });
 * formatError(error, { stack: false }); // => 'Error: Request failed\n  Caused by: TypeError: fetch failed\n    Caused by: ECONNREFUSED'
 * formatError(error, { stack: false, maxDepth: 1 }); // => 'Error: Request failed\n  Caused by: TypeError: fetch failed\n    [Truncated]'
 * const group = new AggregateError([new RangeError('Too big'), 'offline'], '2 failed');
 * formatError(group, { stack: false }); // => 'AggregateError: 2 failed\n  [1/2] RangeError: Too big\n  [2/2] offline'
 * const loop = new Error('Loop');
 * loop.cause = loop;
 * formatError(loop, { stack: false }); // => 'Error: Loop\n  Caused by: [Circular]'
 * formatError(new Error('Disk full')).split('\n')[1].startsWith('    at '); // => true
 * @example
 * let deep: unknown = 'root cause';
 * for (let level = 12; level > 0; level--) deep = new Error(`level ${level}`, { cause: deep });
 * const lines = formatError(deep, { stack: false }).split('\n');
 * lines[10]; // => '                    Caused by: Error: level 11'
 * lines[11]; // => '                    [depth 11] Caused by: Error: level 12'
 * lines[12]; // => '                    [depth 12] Caused by: root cause'
 */
export function formatError(error: unknown, options: FormatErrorOptions = {}): string {
	const maxDepth = Math.min(readDepth('formatError', options), MAX_JSON_DEPTH);
	const withStack = readOption(options, 'stack') !== false;
	const lines: string[] = [];
	const printed = new Set<object>();
	const onPath = new Set<object>();
	// Depth-first, with an explicit stack of entries to print (pushed in reverse order); `exit` entries take an object off the path once
	// everything below it has been printed.
	const todo: Array<{ value: unknown; depth: number; label: string } | { exit: object }> = [{ value: error, depth: 0, label: '' }];
	while (todo.length !== 0) {
		const entry = todo.pop() as { value: unknown; depth: number; label: string } | { exit: object };
		if ('exit' in entry) {
			onPath.delete(entry.exit);
			continue;
		}
		const { value, depth } = entry;
		const indent = indentOf(depth);
		const label = `${markerOf(depth)}${entry.label}`;
		const isObject = typeof value === 'object' && value !== null;
		if (isObject && onPath.has(value)) {
			lines.push(`${indent}${label}[Circular]`);
			continue;
		}
		const header = headerOf(value);
		const line = `${indent}${label}${header.replaceAll('\n', `\n${indent}`)}`;
		if (!isObject) {
			lines.push(line);
			continue;
		}
		if (printed.has(value)) {
			lines.push(`${line} [Seen above]`);
			continue;
		}
		printed.add(value);
		lines.push(line);
		const stack = withStack ? readText(value, 'stack') : undefined;
		if (stack !== undefined) pushFrames(lines, stack, header, `${indent}    `);
		const cause = readCause(value);
		const errors = readErrors(value);
		if (cause === undefined && errors.length === 0) continue;
		if (depth === maxDepth) {
			lines.push(`${indentOf(depth + 1)}${markerOf(depth + 1)}[Truncated]`);
			continue;
		}
		onPath.add(value);
		todo.push({ exit: value });
		if (cause !== undefined) todo.push({ value: cause, depth: depth + 1, label: 'Caused by: ' });
		for (let index = errors.length - 1; index >= 0; index--) {
			todo.push({ value: errors[index], depth: depth + 1, label: `[${index + 1}/${errors.length}] ` });
		}
	}
	return lines.join('\n');
}

/** How many levels down {@link formatError} indents its lines further; deeper lines get a `[depth N]` marker instead. */
const MAX_INDENT_DEPTH = 10;

/**
 * The indentation of a line of {@link formatError}: two spaces per level, up to {@link MAX_INDENT_DEPTH} levels.
 * @param {number} depth - The level (0 for the error itself)
 * @returns {string} The spaces
 */
function indentOf(depth: number): string {
	return '  '.repeat(Math.min(depth, MAX_INDENT_DEPTH));
}

/**
 * The marker of a line of {@link formatError} deeper than its indentation shows.
 * @param {number} depth - The level (0 for the error itself)
 * @returns {string} `'[depth N] '` below {@link MAX_INDENT_DEPTH} levels, `''` otherwise
 */
function markerOf(depth: number): string {
	return depth > MAX_INDENT_DEPTH ? `[depth ${depth}] ` : '';
}
