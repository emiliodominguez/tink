/**
 * Helpers for whatever a `catch` block receives: normalizing it to an `Error` ({@link toError}), reading a message from it
 * ({@link getErrorMessage}), and moving errors across JSON boundaries (workers, logs, HTTP responses) with {@link serializeError} and
 * {@link deserializeError}.
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
 * Converts an error into a plain, JSON-safe object (`JSON.stringify` never throws on it, and `JSON.parse` gives back an equal object):
 * - `name`, `message` and `stack` (own or inherited), then the own `code` (even non-enumerable), `cause` and `errors` (of an
 *   `AggregateError`), then the other own enumerable string keys; values are converted as `JSON.stringify` would (`toJSON` is honoured,
 *   functions and `undefined` are left out), with nested errors serialized the same way. The error's own `toJSON`, if any, is not used:
 *   this function defines its shape.
 * - Never throws: circular references become `'[Circular]'`, bigints decimal strings, maps the array of their entries and sets the array
 *   of their values, a getter or `toJSON` that throws `'[Throws: <message>]'`, and objects deeper than `maxDepth` `'[Object]'`/`'[Array]'`.
 *   Nesting is capped at 1000 levels whatever `maxDepth` asks for (a longer chain of causes ends in these markers too), so that
 *   `JSON.stringify` can always write the result: a hostile, deeply nested error can make neither call overflow the stack.
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
	const source = isAnyError(value) || (typeof value === 'object' && value !== null && readText(value, 'message') !== undefined) ? (value as object) : undefined;
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
 * Defines a non-enumerable own property, as the `Error` constructors define `message`, `cause` and `errors`.
 * @param {Error} error - The error
 * @param {string} key - The key
 * @param {unknown} value - The value
 * @returns {void}
 */
function defineHidden(error: Error, key: string, value: unknown): void {
	Object.defineProperty(error, key, { value, writable: true, enumerable: false, configurable: true });
}

/**
 * Recursive worker of {@link deserializeError}.
 * @param {unknown} data - The serialized error
 * @param {number} depth - Levels of `cause` and `errors` left to rebuild
 * @param {Map<object, Error>} built - The error rebuilt from each data object so far (cycles and shared references)
 * @returns {Error} The error
 */
function rebuild(data: unknown, depth: number, built: Map<object, Error>): Error {
	if (isAnyError(data)) return data;
	if (typeof data !== 'object' || data === null) return new Error(getErrorMessage(data));
	const done = built.get(data);
	if (done !== undefined) return done;
	const name = readText(data, 'name');
	const message = readText(data, 'message') ?? '';
	const Constructor = BUILT_IN_ERRORS.get(name) ?? Error;
	const error = name === 'AggregateError' ? new AggregateError([], message) : new Constructor(message);
	built.set(data, error);
	if (name !== undefined && name !== error.name) defineHidden(error, 'name', name);
	const stack = readText(data, 'stack');
	if (stack !== undefined) defineHidden(error, 'stack', stack);
	/**
	 * Rebuilds a nested error-like value (one level deeper), keeping anything else as it is.
	 * @param {unknown} nested - A `cause`, or an item of `errors`
	 * @returns {unknown} The nested value, rebuilt when it is error-like
	 */
	function nestedValue(nested: unknown): unknown {
		return depth === 0 || !isErrorLike(nested) ? nested : rebuild(nested, depth - 1, built);
	}
	try {
		if (hasOwn.call(data, 'cause')) defineHidden(error, 'cause', nestedValue((data as { cause: unknown }).cause));
		const errors = hasOwn.call(data, 'errors') ? (data as { errors: unknown }).errors : undefined;
		if (Array.isArray(errors)) defineHidden(error, 'errors', errors.map(nestedValue));
		for (const key of Object.keys(data)) {
			// A key the error inherits (`toString`, `valueOf`, `hasOwnProperty`…) would shadow its method: `String(error)` would throw.
			if (!RESERVED_KEYS.has(key) && !(key in error))
				Object.defineProperty(error, key, { value: (data as Record<string, unknown>)[key], writable: true, enumerable: true, configurable: true });
		}
	} catch {
		// A throwing getter, a hostile proxy, or a chain of causes longer than the call stack allows: the properties copied so far are kept.
	}
	return error;
}

/**
 * Rebuilds an `Error` from the output of {@link serializeError} (after any number of `JSON.stringify`/`JSON.parse` round trips):
 * - The class is chosen by `name` among the built-in errors (`Error`, `EvalError`, `RangeError`, `ReferenceError`, `SyntaxError`,
 *   `TypeError`, `URIError`, `AggregateError`); any other name gives an `Error` with that `name`. No other constructor is ever called,
 *   so untrusted data cannot instantiate arbitrary classes.
 * - `message`, `stack` (when present; otherwise the stack is where `deserializeError` was called), `cause` and `errors` are restored as
 *   the non-enumerable properties the constructors create; an error-like `cause` or item of `errors` is rebuilt recursively (up to
 *   `maxDepth` levels), anything else is kept as data. Shared and circular references between them are preserved.
 * - Other own enumerable properties (`code`, `status`…) are copied, except `__proto__`, `constructor`, `prototype` and any key the error
 *   inherits (`toString`, `valueOf`, `toLocaleString`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `__defineGetter__`…),
 *   so that hostile data cannot shadow a method of the error and make `String(error)` or a logger throw; their values are kept as they
 *   are (not copied deeply). Values inherited from `Object.prototype` are ignored.
 *
 * An `Error` is returned as it is; any other value that is not an object gives an `Error` with {@link getErrorMessage}'s message. Never
 * throws for any `data`.
 * @param {unknown} data - The serialized error
 * @param {DeserializeErrorOptions} [options={}] - `maxDepth` (default `Infinity`)
 * @returns {Error} The rebuilt error
 * @throws {TypeError} when `maxDepth` is not a number
 * @throws {RangeError} when `maxDepth` is not an integer >= 0 or `Infinity`
 * @example
 * const error = deserializeError(JSON.parse('{"name":"TypeError","message":"Bad input","code":"E_INPUT"}'));
 * error instanceof TypeError; // => true
 * error.message; // => 'Bad input'
 * (error as Error & { code?: string }).code; // => 'E_INPUT'
 * deserializeError({ name: 'AbortError', message: 'Aborted' }).name; // => 'AbortError'
 * const copy = deserializeError(JSON.parse(JSON.stringify(serializeError(new Error('Outer', { cause: new RangeError('Inner') })))));
 * copy.cause instanceof RangeError; // => true
 */
export function deserializeError(data: unknown, options: DeserializeErrorOptions = {}): Error {
	return rebuild(data, readDepth('deserializeError', options), new Map());
}
