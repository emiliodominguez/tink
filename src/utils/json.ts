/**
 * PRIVATE JSON-safe conversion shared by the objects module (`safeStringify`) and the errors module (`serializeError`). Not part of the
 * public API: this file is not re-exported by `utils/index.ts` or the package root, and the `exports` map does not reach it.
 *
 * {@link toJsonValue} follows `JSON.stringify`'s algorithm (`toJSON`, then the replacer, then the value's type), but builds a tree of
 * JSON values instead of text and never throws on hostile input: circular references become `'[Circular]'`, bigints decimal strings,
 * errors their {@link errorView} (`name`, `message`, `stack`, `cause`, …), maps the array of their entries and sets the array of their
 * values; a getter, `toJSON` method, replacer or proxy trap that throws becomes `'[Throws: <message>]'`, and a container nested deeper
 * than `maxDepth` becomes `'[Object]'` or `'[Array]'`. The callers clamp `maxDepth` to {@link MAX_JSON_DEPTH}, so that `JSON.stringify` can
 * write the tree with an ordinary amount of stack left (its own recursion can overflow on a tree a few thousand levels deep, even when
 * the walker, once optimized, built it without overflowing); `safeStringify` walks again, shallower, when even that overflows. Each container is also converted inside its own `try`, so a call stack that runs out
 * anyway (the call made from deep in the stack) ends as a `'[Throws: …]'` marker where it ran out instead of an exception.
 * @internal
 * @packageDocumentation
 */
import { isError, isMap, isSet, type JsonValue } from '../guards/index.js';
import { readOption } from './assert.js';

/**
 * The deepest nesting of containers a conversion keeps (the root is at depth 0): deeper ones become `'[Object]'` or `'[Array]'` whatever
 * the `maxDepth` asked for. Far beyond any real data, and shallow enough for `JSON.stringify` (and any recursive writer) to write the
 * tree from any reasonable stack depth.
 */
export const MAX_JSON_DEPTH = 1000;

/** The settings and state of one conversion. */
export interface JsonWalk {
	/** `JSON.stringify`'s replacer function, called as `replacer.call(holder, key, value)`. */
	readonly replacer: ((this: unknown, key: string, value: unknown) => unknown) | undefined;
	/** `JSON.stringify`'s property list: the only keys written for objects (own properties only). */
	readonly keys: ReadonlyArray<string> | undefined;
	/** Whether errors keep their `stack`. */
	readonly stack: boolean;
	/** Containers deeper than this (the root is at depth 0) become `'[Object]'` or `'[Array]'`: at most {@link MAX_JSON_DEPTH}. */
	readonly maxDepth: number;
	/** The containers on the current path, outermost first (its length is the depth). */
	readonly ancestors: object[];
	/** The same containers, for O(1) cycle detection (a scan of `ancestors` would make deep values quadratic). */
	readonly onPath: Set<object>;
	/**
	 * The JSON of the containers converted so far that hold other containers or more than 64 values, by depth: a container shared by
	 * several paths (YAML aliases build such values) is converted once per depth instead of once per path, which is exponential in the
	 * depth of the sharing.
	 */
	converted?: Map<object, [depth: number, json: JsonValue] | Map<number, JsonValue>>;
	/** Whether the conversion under way depends on its path (it wrote `'[Circular]'`, a truncation or a thrown error): not remembered. */
	dependent?: boolean;
	/** The number of containers converted so far. */
	count?: number;
	/** The number of items and members converted so far. */
	values?: number;
	/** Whether the JSON of a container converted earlier was used again: the tree then shares it between several places. */
	shared?: boolean;
}

/**
 * Items of an array so long that its JSON (at least 2 characters an item) cannot fit in a string: refused at once, as `JSON.stringify`
 * would refuse the text, instead of building a tree that size (a sparse array of length 2 ** 32 - 1 ran the process out of memory).
 */
const MAX_JSON_ITEMS = 2 ** 28;

/** `Object.prototype.hasOwnProperty`. */
const hasOwn = Object.prototype.hasOwnProperty;

/** `valueOf` implementations that brand-check boxed primitives (they throw for anything else). */
const BOXED: ReadonlyMap<string, (this: unknown) => unknown> = new Map<string, (this: unknown) => unknown>([
	['[object Number]', Number.prototype.valueOf],
	['[object String]', String.prototype.valueOf],
	['[object Boolean]', Boolean.prototype.valueOf],
	['[object BigInt]', BigInt.prototype.valueOf]
]);

/**
 * Whether a value is an error: `isError` (guards), or `Error.isError` (ES2026) where the runtime has it, a brand check that also
 * recognises `DOMException`s of other realms, which `isError` cannot tell from objects faking their tag.
 * @param {unknown} value - The value to check
 * @returns {boolean} Whether the value is an error
 */
export function isAnyError(value: unknown): value is Error {
	if (isError(value)) return true;
	const native = (Error as { isError?: unknown }).isError;
	return typeof native === 'function' && (native as (value: unknown) => boolean)(value);
}

/**
 * The marker written in place of a value whose conversion threw.
 * @param {unknown} error - What was thrown
 * @returns {string} `'[Throws: <message>]'`, or `'[Throws]'` when the thrown value has no readable message
 */
export function thrown(error: unknown): string {
	try {
		const message = typeof error === 'string' ? error : (error as { message?: unknown }).message;
		return typeof message === 'string' ? `[Throws: ${message}]` : '[Throws]';
	} catch {
		// `null`/`undefined` thrown, a throwing `message` getter or a revoked proxy.
		return '[Throws]';
	}
}

/**
 * Reads a property without throwing.
 * @param {object} object - The object to read from
 * @param {string} key - The key
 * @returns {unknown} The value (inherited ones too), or a `'[Throws: …]'` marker when the read throws
 */
function read(object: object, key: string): unknown {
	try {
		return (object as Record<string, unknown>)[key];
	} catch (error) {
		return thrown(error);
	}
}

/**
 * Writes an own data property of an object created by this file (whose prototype is `Object.prototype`): a key `Object.prototype` has
 * (`'__proto__'`, `'toString'`, anything a pollution added) is defined, so that no inherited setter intercepts it. Every attribute of
 * the descriptor is given, so none is inherited; one that inherits a `get` or `set` from a polluted `Object.prototype` (an accessor with
 * a value, which `Object.defineProperty` rejects) is given again without a prototype.
 * @param {Record<string, unknown>} target - The object to write to
 * @param {string} key - The key
 * @param {unknown} value - The value
 * @returns {void}
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
	if (!(key in target)) {
		target[key] = value;
		return;
	}
	const descriptor: PropertyDescriptor = { value, writable: true, enumerable: true, configurable: true };
	try {
		Object.defineProperty(target, key, descriptor);
	} catch {
		Object.defineProperty(target, key, Object.setPrototypeOf(descriptor, null) as PropertyDescriptor);
	}
}

/**
 * Reads a text property of an error (or error-like object) without throwing, ignoring a value inherited from `Object.prototype`.
 * @param {object} error - The error
 * @param {string} key - `'name'`, `'message'` or `'stack'`
 * @returns {string | undefined} The text, or `undefined` when it is missing, not a string or unreadable
 */
export function readText(error: object, key: 'name' | 'message' | 'stack'): string | undefined {
	try {
		const value = readOption(error as Record<string, unknown>, key);
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The plain object an error is serialized as (its values not converted yet): `name` (default `'Error'`), `message` (default `''`), its
 * own `code` (even non-enumerable), `stack` (when `withStack`), its own `cause` and `errors` (an `AggregateError`'s), then its other own
 * enumerable string keys.
 * @param {object} error - The error, or an error-like object
 * @param {boolean} withStack - Whether to keep the stack
 * @returns {Record<string, unknown>} The view
 */
export function errorView(error: object, withStack: boolean): Record<string, unknown> {
	const view: Record<string, unknown> = { name: readText(error, 'name') ?? 'Error', message: readText(error, 'message') ?? '' };
	const stack = withStack ? readText(error, 'stack') : undefined;
	if (stack !== undefined) view.stack = stack;
	let keys: string[] = [];
	try {
		keys = ['code', 'cause', 'errors', ...Object.keys(error)];
	} catch {
		// A proxy whose `ownKeys` trap throws: only the text properties are kept.
	}
	for (const key of keys) {
		// `stack` was read above (or deliberately left out).
		if (key !== 'stack' && !hasOwn.call(view, key) && isOwn(error, key)) put(view, key, read(error, key));
	}
	return view;
}

/**
 * Whether `object` has an own property `key`, without throwing.
 * @param {object} object - The object
 * @param {string} key - The key
 * @returns {boolean} `false` too when the check throws (a revoked proxy)
 */
function isOwn(object: object, key: string): boolean {
	try {
		return hasOwn.call(object, key);
	} catch {
		return false;
	}
}

/**
 * Converts the property `key` of `holder` to a JSON value, as `JSON.stringify` would serialize it (with the additions described in the
 * file comment). Only own properties are read: a hole of an array, or a listed key the object lacks, reads as `undefined`.
 * @param {object} holder - The object holding the value (`{ '': value }` for the root)
 * @param {string | number} key - The key of the value in `holder` (a number for an array index: it is only converted when needed)
 * @param {JsonWalk} walk - The settings and state of the conversion
 * @param {boolean} [own=false] - Whether `key` is known to be an own key of `holder` (listed by `Object.keys`)
 * @returns {JsonValue | undefined} The JSON value, or `undefined` where `JSON.stringify` writes nothing (a function, a symbol, `undefined`)
 */
export function toJsonValue(holder: object, key: string | number, walk: JsonWalk, own = false): JsonValue | undefined {
	const depth = walk.ancestors.length;
	try {
		let value = own || hasOwn.call(holder, key) ? (holder as Record<string | number, unknown>)[key] : undefined;
		if ((typeof value === 'object' && value !== null) || typeof value === 'bigint') {
			// A `toJSON` that a pollution put on `Object.prototype` is ignored (own and other inherited ones, such as `Date`'s, are honoured).
			const toJSON = readOption(value as { toJSON?: unknown }, 'toJSON');
			if (typeof toJSON === 'function') value = toJSON.call(value, String(key));
		}
		if (walk.replacer !== undefined) value = walk.replacer.call(holder, String(key), value);
		return typeof value === 'object' && value !== null ? toJsonObject(value, walk) : primitive(value);
	} catch (error) {
		// Unwinds the containers a throw (a stack overflow included) left on the path.
		const { ancestors, onPath } = walk;
		while (ancestors.length > depth) onPath.delete(ancestors.pop() as object);
		walk.dependent = true;
		return thrown(error);
	}
}

/**
 * Converts a primitive (or `null`) the way `JSON.stringify` does (bigints become decimal strings).
 * @param {unknown} value - The value (not an object)
 * @returns {JsonValue | undefined} The JSON value, or `undefined` for functions, symbols and `undefined`
 */
function primitive(value: unknown): JsonValue | undefined {
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			// `-0` becomes `0`, as `JSON.stringify` writes it, so that the tree equals what `JSON.parse` gives back.
			return Number.isFinite(value) ? value + 0 : null;
		case 'bigint':
			return String(value);
		default:
			return value === null ? null : undefined;
	}
}

/**
 * Converts an object (see {@link toJsonValue}).
 * @param {object} value - The object
 * @param {JsonWalk} walk - The settings and state of the conversion
 * @returns {JsonValue} The JSON value
 */
function toJsonObject(value: object, walk: JsonWalk): JsonValue {
	const { ancestors, onPath } = walk;
	if (onPath.has(value)) {
		walk.dependent = true;
		return '[Circular]';
	}
	const isArray = Array.isArray(value);
	// Plain objects and arrays (the bulk of most values) skip the checks below: none of them can hold.
	const prototype: unknown = isArray ? undefined : Object.getPrototypeOf(value);
	const isPlain = isArray || prototype === Object.prototype || prototype === null;
	// A boxed primitive (`new Number(1)`, `Object(1n)`) is written as its primitive. The tag only pre-filters: the brand check decides.
	const valueOf = isPlain ? undefined : BOXED.get(Object.prototype.toString.call(value));
	if (valueOf !== undefined) {
		try {
			return primitive(valueOf.call(value)) as JsonValue;
		} catch {
			// A fake `Symbol.toStringTag`: an ordinary object.
		}
	}
	const depth = ancestors.length;
	if (depth > walk.maxDepth) {
		walk.dependent = true;
		return isArray ? '[Array]' : '[Object]';
	}
	// The JSON of a container already converted at this depth: a replacer sees the holder and key of each path, so it disables this.
	const entry = walk.replacer === undefined ? walk.converted?.get(value) : undefined;
	const known = entry === undefined ? undefined : Array.isArray(entry) ? (entry[0] === depth ? entry[1] : undefined) : entry.get(depth);
	if (known !== undefined) {
		walk.shared = true;
		return known;
	}
	const outer = walk.dependent;
	const before = (walk.count = (walk.count ?? 0) + 1);
	const values = walk.values ?? 0;
	walk.dependent = false;
	ancestors.push(value);
	onPath.add(value);
	const json = isArray
		? toJsonItems(value, walk)
		: !isPlain && (isMap(value) || isSet(value))
			? toJsonItems(Array.from(value as Iterable<unknown>), walk)
			: toJsonMembers(!isPlain && isAnyError(value) ? errorView(value, walk.stack) : value, walk);
	ancestors.pop();
	onPath.delete(value);
	// Remembered when it holds other containers or more than a few values (a leaf of a million items shared by thousands of paths cost
	// a conversion per path), and does not depend on its path.
	if (!walk.dependent && (walk.count > before || (walk.values as number) > values + 64) && walk.replacer === undefined) {
		const converted = (walk.converted ??= new Map());
		if (entry === undefined) converted.set(value, [depth, json]);
		else if (Array.isArray(entry)) converted.set(value, new Map([entry, [depth, json]]));
		else entry.set(depth, json);
	}
	walk.dependent = outer || walk.dependent;
	return json;
}

/**
 * Converts the items of an array (`undefined`, functions and symbols become `null`, as in `JSON.stringify`).
 * @param {ReadonlyArray<unknown>} items - The array
 * @param {JsonWalk} walk - The settings and state of the conversion
 * @returns {JsonValue[]} The JSON array
 */
function toJsonItems(items: ReadonlyArray<unknown>, walk: JsonWalk): JsonValue[] {
	if (items.length >= MAX_JSON_ITEMS) throw new RangeError('Invalid string length');
	walk.values = (walk.values ?? 0) + items.length;
	const json: JsonValue[] = [];
	for (let index = 0; index < items.length; index++) json.push(toJsonValue(items, index, walk) ?? null);
	return json;
}

/**
 * Converts the members of an object: its own enumerable string keys (or the listed keys), skipping those whose value converts to
 * `undefined`.
 * @param {object} object - The object
 * @param {JsonWalk} walk - The settings and state of the conversion
 * @returns {Record<string, JsonValue>} The JSON object
 */
export function toJsonMembers(object: object, walk: JsonWalk): Record<string, JsonValue> {
	const listed = walk.keys;
	const keys = listed ?? Object.keys(object);
	walk.values = (walk.values ?? 0) + keys.length;
	const json: Record<string, JsonValue> = {};
	for (const key of keys) {
		const member = toJsonValue(object, key, walk, listed === undefined);
		if (member !== undefined) put(json, key, member);
	}
	return json;
}
