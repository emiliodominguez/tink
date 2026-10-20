/**
 * Binary-to-text encodings (base64, base32, hex, UTF-8), hashing, constant-time comparison, JWT decoding and CSV that work in every
 * JavaScript runtime, without Node's `Buffer`.
 *
 * Conventions shared by every function in this module:
 * - **Inputs.** Byte parameters accept a {@link BytesInput}: a `Uint8Array` (a Node `Buffer` too), any other typed array or `DataView`
 *   (its bytes as stored in memory, so in the platform's byte order for multi-byte elements), or an `ArrayBuffer`. Values from other
 *   realms (iframes, `vm` contexts) are accepted; a `SharedArrayBuffer` itself is not, but views over one are. The bytes are read through
 *   the built-in accessors, so an own `length` or `byteOffset` property planted on a view cannot redirect the read. Functions that also
 *   take a `string` encode it as UTF-8 first (lone surrogates become U+FFFD, like `TextEncoder`), never as `btoa`'s Latin-1.
 * - **Outputs.** Functions returning bytes always return a NEW `Uint8Array` over its own `ArrayBuffer` (typed `Uint8Array<ArrayBuffer>`,
 *   like `TextEncoder#encode`, so it can be passed to `crypto.subtle` or `new Blob()`); inputs are never mutated.
 * - **Options.** Options are read once each, as own properties only (a polluted `Object.prototype` cannot switch an alphabet or a mode),
 *   and must have the documented types: `options` itself must be an object when given.
 * - **Strict decoding.** Malformed text throws a `SyntaxError` naming the first offending character and its index (or the
 *   length that cannot be valid), like `Uint8Array.fromBase64`. {@link fromBase64} rejects anything that {@link toBase64} could not have produced (white space, stray
 *   padding, non-zero unused bits), so base64 text can be compared as text: the same bytes always have the same spelling (up to optional
 *   padding). {@link fromHex} accepts both letter cases (digests from other tools are often uppercase), so compare hex after
 *   lowercasing it.
 * - **Native fast paths.** `Uint8Array.prototype.toBase64` / `toHex`, `Uint8Array.fromBase64` / `fromHex`, `TextEncoder` and
 *   `TextDecoder` are used when the runtime has them, only in ways that give results identical to the portable implementation, which is
 *   used everywhere else.
 */

import { assertNumber, describe, show } from '../utils/assert.js';
import { withoutProtoKeys } from '../utils/proto.js';

export type { Base64Padding } from '../validate/index.js';
import type { Base64Padding } from '../validate/index.js';

/**
 * Binary data accepted by this module: an `ArrayBuffer`, or any view over one (`Uint8Array`, Node's `Buffer`, other typed arrays,
 * `DataView`). Views contribute the bytes they cover, as stored in memory.
 */
export type BytesInput = ArrayBuffer | ArrayBufferView;

/**
 * Options accepted by {@link toBase64}.
 */
export interface ToBase64Options {
	/** Use the URL-safe alphabet (`-` and `_` instead of `+` and `/`, RFC 4648 §5). Defaults to `false`. */
	readonly urlSafe?: boolean;
	/** Append `=` padding up to a multiple of 4 characters. Defaults to `true` for base64 and `false` for base64url (as in JWTs). */
	readonly padding?: boolean;
}

/**
 * Options accepted by {@link fromBase64}; the same as the validate module's `isBase64`, which, given the same valid options, accepts
 * exactly the strings that {@link fromBase64} decodes.
 */
export interface FromBase64Options {
	/** Use the URL-safe alphabet (`-` and `_` instead of `+` and `/`, RFC 4648 §5). Defaults to `false`. */
	readonly urlSafe?: boolean;
	/** Whether `=` padding is `'optional'`, `'required'` or `'forbidden'`. Defaults to `'optional'`. */
	readonly padding?: Base64Padding;
}

/**
 * Options accepted by {@link encodeUtf8}.
 */
export interface EncodeUtf8Options {
	/** Throw a `TypeError` on a lone surrogate instead of encoding it as U+FFFD (`EF BF BD`). Defaults to `false`. */
	readonly fatal?: boolean;
}

/**
 * Options accepted by {@link decodeUtf8}.
 */
export interface DecodeUtf8Options {
	/** Throw a `TypeError` on malformed UTF-8 instead of decoding each maximal invalid subpart as U+FFFD. Defaults to `false`. */
	readonly fatal?: boolean;
	/** Drop a leading byte order mark (`EF BB BF`). Defaults to `false`, so that `decodeUtf8(encodeUtf8(text)) === text` for every well-formed `text`. */
	readonly stripBom?: boolean;
}

/** Structural subset of the WHATWG `TextEncoder` (not in the ES2022 type library). */
interface TextEncoderLike {
	encode(input: string): Uint8Array<ArrayBuffer>;
}

/** Structural subset of the WHATWG `TextDecoder` (not in the ES2022 type library). */
interface TextDecoderLike {
	decode(input: Uint8Array): string;
}

/** The ES2025 `Uint8Array.prototype` methods (not in the ES2022 type library). */
interface NativeUint8Array {
	toBase64?(this: Uint8Array, options: { alphabet: string; omitPadding: boolean }): string;
	toHex?(this: Uint8Array): string;
}

/** The ES2025 `Uint8Array` static methods (not in the ES2022 type library). */
interface NativeUint8ArrayConstructor {
	fromBase64?(text: string, options: { alphabet: string; lastChunkHandling: string }): Uint8Array<ArrayBuffer>;
	fromHex?(text: string): Uint8Array<ArrayBuffer>;
}

/** A built-in accessor, called with an explicit receiver. */
type Getter = (this: unknown) => unknown;

/**
 * Looks up the built-in getters {@link viewOf} reads binary data through.
 * @returns {Getter[]} `%TypedArray%.prototype[Symbol.toStringTag]` (a typed array's constructor name, `undefined` for anything else),
 * `ArrayBuffer.prototype.byteLength` (throws for anything but a real `ArrayBuffer`, of any realm), then the `buffer`, `byteOffset` and
 * `byteLength` getters of typed arrays (indexes 2 to 4) and of data views (5 to 7)
 */
function builtInGetters(): Getter[] {
	const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const getters: Getter[] = [];
	for (const [prototype, key] of [
		[typedArray, Symbol.toStringTag],
		[ArrayBuffer.prototype, 'byteLength'],
		[typedArray, 'buffer'],
		[typedArray, 'byteOffset'],
		[typedArray, 'byteLength'],
		[DataView.prototype, 'buffer'],
		[DataView.prototype, 'byteOffset'],
		[DataView.prototype, 'byteLength']
	] as const) {
		getters.push((Object.getOwnPropertyDescriptor(prototype, key) as PropertyDescriptor).get as Getter);
	}
	return getters;
}

/** The getters returned by {@link builtInGetters}, looked up on first use. */
let getters: Getter[] | undefined;

/**
 * Wraps the bytes of a {@link BytesInput} in a fresh `Uint8Array` over the same memory (nothing is copied). A view's position is read
 * through the built-in getters, so that own properties shadowing them are ignored.
 * @param {unknown} value - The candidate
 * @returns {Uint8Array | undefined} A view over the bytes of `value`, or `undefined` when it is not an `ArrayBuffer` or a view
 */
function viewOf(value: unknown): Uint8Array | undefined {
	const builtIn = (getters ??= builtInGetters());
	let length: unknown = 0;
	if (ArrayBuffer.isView(value)) {
		// `ArrayBuffer.isView` is true for typed arrays and data views only; the typed-array tag getter tells them apart.
		const base = builtIn[0].call(value) === undefined ? 5 : 2;
		try {
			length = builtIn[base + 2].call(value);
		} catch {
			// A data view over a detached buffer, or one shrunk below the view, throws instead of reporting no bytes like a typed array.
		}
		// A detached buffer (or one shrunk below the view) cannot be wrapped again.
		return length === 0 ? new Uint8Array(0) : new Uint8Array(builtIn[base].call(value) as ArrayBuffer, builtIn[base + 1].call(value) as number, length as number);
	}
	try {
		length = builtIn[1].call(value);
	} catch {
		return undefined;
	}
	return length === 0 ? new Uint8Array(0) : new Uint8Array(value as ArrayBuffer);
}

/**
 * Normalizes a {@link BytesInput} parameter (see {@link viewOf}).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} value - The value of its `bytes` parameter
 * @returns {Uint8Array} A view over the bytes
 * @throws {TypeError} when `value` is neither an `ArrayBuffer` nor an `ArrayBuffer` view
 */
function bytesOf(caller: string, value: unknown): Uint8Array {
	const view = viewOf(value);
	if (view === undefined) throw new TypeError(`${caller}: \`bytes\` must be an ArrayBuffer or an ArrayBuffer view, got ${describe(value)}`);
	return view;
}

/**
 * Normalizes a string or {@link BytesInput} parameter: strings are encoded as UTF-8 (lone surrogates as U+FFFD).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} value - The value of its `data` parameter
 * @param {string} [name='data'] - Name of the parameter, used in the error message
 * @returns {Uint8Array} The bytes
 * @throws {TypeError} when `value` is neither a string nor binary data
 */
function dataOf(caller: string, value: unknown, name = 'data'): Uint8Array {
	const view = typeof value === 'string' ? encodeUtf8(value) : viewOf(value);
	if (view === undefined) throw new TypeError(`${caller}: \`${name}\` must be a string, an ArrayBuffer or an ArrayBuffer view, got ${describe(value)}`);
	return view;
}

/**
 * Reads an `options` argument: each listed key once, as an own property only, so that a key inherited from a polluted
 * `Object.prototype` is ignored.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} options - The argument: `undefined` or an object
 * @param {string[]} keys - The option names
 * @returns {unknown[]} The value of each key, `undefined` when it is not an own property
 * @throws {TypeError} when `options` is neither `undefined` nor an object
 */
function readOptions(caller: string, options: unknown, keys: readonly string[]): unknown[] {
	if (options === undefined) return [];
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);
	return keys.map(function (key: string): unknown {
		return Object.hasOwn(options, key) ? (options as Record<string, unknown>)[key] : undefined;
	});
}

/**
 * Validates a boolean option.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the option
 * @param {unknown} value - Its value (`undefined` when absent)
 * @param {boolean} fallback - The default
 * @returns {boolean} `value`, or `fallback` when it is `undefined`
 * @throws {TypeError} when `value` is neither `undefined` nor a boolean
 */
function booleanOption(caller: string, name: string, value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== 'boolean') throw new TypeError(`${caller}: \`${name}\` must be a boolean, got ${describe(value)}`);
	return value;
}

/**
 * Reads an element of an array as an own property.
 * @param {readonly unknown[]} array - The array
 * @param {number} index - The index
 * @returns {unknown} The element, `undefined` for a hole (never a value inherited from a polluted `Object.prototype`)
 */
function ownItem(array: readonly unknown[], index: number): unknown {
	return Object.hasOwn(array, index) ? array[index] : undefined;
}

/**
 * Quotes the character at `index` of `text` (a whole code point) for an error message.
 * @param {string} text - The text
 * @param {number} index - The UTF-16 index of the character
 * @returns {string} Its JSON representation, e.g. `'"!"'`
 */
function quoteAt(text: string, index: number): string {
	return JSON.stringify(String.fromCodePoint(text.codePointAt(index) as number));
}

/** The base64 alphabet (RFC 4648 §4); the base64url alphabet replaces its last two characters with `-` and `_`. */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `BASE64` with the base64url ending. */
const BASE64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The characters that the native `Uint8Array.fromBase64` skips (ASCII white space), but {@link fromBase64} rejects. */
const WHITE_SPACE = /[\t\n\f\r ]/;

/**
 * Lazily built decoding tables (index `0` for base64, `1` for base64url): ASCII code → 6-bit value, `64` for invalid characters. The
 * slots are own `undefined`s until built: a hole would be looked up on a (possibly polluted) `Object.prototype`, whose `0` or `1` would
 * then be used as the table.
 */
const decodeTables: (Uint8Array | undefined)[] = [undefined, undefined];

/**
 * Returns the decoding table of a base64 alphabet, building it on first use.
 * @param {number} kind - `0` for base64, `1` for base64url
 * @returns {Uint8Array} 128 entries: the value of each ASCII character, `64` when it is not in the alphabet
 */
function decodeTable(kind: number): Uint8Array {
	let table = decodeTables[kind];
	if (table === undefined) {
		const alphabet = kind === 0 ? BASE64 : BASE64_URL;
		table = new Uint8Array(128).fill(64);
		for (let i = 0; i < 64; i++) table[alphabet.charCodeAt(i)] = i;
		decodeTables[kind] = table;
	}
	return table;
}

/**
 * Encodes binary data (or the UTF-8 encoding of a string) as base64 (RFC 4648 §4) or base64url (§5).
 *
 * Uses the native `Uint8Array.prototype.toBase64` when available (identical output). Unlike `btoa`, strings may contain any
 * character: they are encoded as UTF-8 first.
 * @param {string | BytesInput} data - The bytes to encode, or a string to encode as UTF-8
 * @param {ToBase64Options} [options={}] - `urlSafe` (default `false`): use the `-` / `_` alphabet; `padding` (default `!urlSafe`):
 * append `=` up to a multiple of 4 characters
 * @returns {string} The encoded text (empty for no bytes)
 * @throws {TypeError} when `data` is neither a string nor binary data, `options` is not an object, or `urlSafe` or `padding` is not a boolean
 * @example
 * toBase64(new Uint8Array([104, 105])); // => 'aGk='
 * toBase64('hello'); // => 'aGVsbG8='
 * toBase64('✓ à la carte'); // => '4pyTIMOgIGxhIGNhcnRl'
 * toBase64(new Uint8Array([251, 255])); // => '+/8='
 * toBase64(new Uint8Array([251, 255]), { urlSafe: true }); // => '-_8'
 * toBase64(new Uint8Array([251, 255]), { urlSafe: true, padding: true }); // => '-_8='
 */
export function toBase64(data: string | BytesInput, options?: ToBase64Options): string {
	const [urlSafeOption, paddingOption] = readOptions('toBase64', options, ['urlSafe', 'padding']);
	const urlSafe = booleanOption('toBase64', 'urlSafe', urlSafeOption, false);
	const padding = booleanOption('toBase64', 'padding', paddingOption, !urlSafe);
	const bytes = dataOf('toBase64', data);
	const native = (Uint8Array.prototype as NativeUint8Array).toBase64;
	if (typeof native === 'function') return native.call(bytes, { alphabet: urlSafe ? 'base64url' : 'base64', omitPadding: !padding });

	const alphabet = urlSafe ? BASE64_URL : BASE64;
	const length = bytes.length;
	const full = length - (length % 3);
	// Sized for the output when it is short: a zeroed 16 kB buffer would dominate the cost of a small input.
	const codes = new Uint16Array(Math.min(CHUNK, (full / 3) * 4) + 4);
	let count = 0;
	let text = '';
	for (let i = 0; i < full; i += 3) {
		const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		codes[count] = alphabet.charCodeAt(value >> 18);
		codes[count + 1] = alphabet.charCodeAt((value >> 12) & 63);
		codes[count + 2] = alphabet.charCodeAt((value >> 6) & 63);
		codes[count + 3] = alphabet.charCodeAt(value & 63);
		count += 4;
		if (count >= CHUNK) {
			text += fromCodes(codes, count);
			count = 0;
		}
	}
	text += fromCodes(codes, count);
	if (full < length) {
		// One or two leftover bytes: two or three characters, the unused low bits set to zero.
		const value = (bytes[full] << 16) | (full + 1 < length ? bytes[full + 1] << 8 : 0);
		text += alphabet[value >> 18] + alphabet[(value >> 12) & 63];
		if (full + 1 < length) text += alphabet[(value >> 6) & 63];
		if (padding) text += full + 1 < length ? '=' : '==';
	}
	return text;
}

/** Number of UTF-16 code units converted to a string at once (well below engines' argument-count limits). */
const CHUNK = 8192;

/**
 * Converts the first `count` code units of a buffer into a string.
 * @param {Uint16Array} codes - The code units
 * @param {number} count - How many of them to convert
 * @returns {string} The string
 */
function fromCodes(codes: Uint16Array, count: number): string {
	return String.fromCharCode.apply(null, codes.subarray(0, count) as unknown as number[]);
}

/**
 * Decodes base64 (RFC 4648 §4) or base64url (§5) text, strictly: it accepts exactly the strings that the validate module's
 * `isBase64` accepts with the same (valid) options.
 *
 * Rejected: characters outside the chosen alphabet (including white space and line breaks, and the other alphabet's `+/` or `-_`),
 * `=` anywhere but at the end, padding that does not complete a multiple of 4 characters (or any padding when `'forbidden'`, missing
 * padding when `'required'`), a dangling final character (a length of 1 modulo 4), and non-canonical encodings whose last character has
 * non-zero unused bits (`'YR=='`, which a lenient decoder reads as `'a'`, like `'YQ=='`). So `toBase64(fromBase64(text))` is `text`
 * again (with matching options) for every accepted `text`.
 * @param {string} text - The base64 text
 * @param {FromBase64Options} [options={}] - `urlSafe` (default `false`): use the `-` / `_` alphabet;
 * `padding` (default `'optional'`): whether `=` padding is `'optional'`, `'required'` or `'forbidden'`
 * @returns {Uint8Array} The decoded bytes, in a new array
 * @throws {TypeError} when `text` is not a string, `options` is not an object, or `urlSafe` is not a boolean
 * @throws {RangeError} when `options.padding` is not `'optional'`, `'required'` or `'forbidden'`
 * @throws {SyntaxError} when `text` is not canonical base64 (or base64url) text satisfying the options
 * @example
 * fromBase64('aGk='); // => new Uint8Array([104, 105])
 * fromBase64('aGk'); // => new Uint8Array([104, 105])
 * fromBase64('-_8', { urlSafe: true }); // => new Uint8Array([251, 255])
 * fromBase64('aGk', { padding: 'required' }); // throws SyntaxError
 * fromBase64('aG k='); // throws SyntaxError
 * fromBase64('aGl='); // throws SyntaxError // non-canonical: the last character's unused bits are not zero
 * @example
 * decodeUtf8(fromBase64('4pyTIMOgIGxhIGNhcnRl')); // => '✓ à la carte'
 */
export function fromBase64(text: string, options?: FromBase64Options): Uint8Array<ArrayBuffer> {
	const [urlSafeOption, paddingOption = 'optional'] = readOptions('fromBase64', options, ['urlSafe', 'padding']);
	const urlSafe = booleanOption('fromBase64', 'urlSafe', urlSafeOption, false);
	const padding = paddingOption;
	if (padding !== 'optional' && padding !== 'required' && padding !== 'forbidden') {
		throw new RangeError(`fromBase64: \`padding\` must be 'optional', 'required' or 'forbidden', got ${show(padding)}`);
	}
	if (typeof text !== 'string') throw new TypeError(`fromBase64: \`text\` must be a string, got ${describe(text)}`);

	const length = text.length;
	// `end` is the number of data characters: at most two final `=` are padding; any other `=` is an invalid character below.
	let end = length;
	if (text.charCodeAt(end - 1) === 61) end -= text.charCodeAt(end - 2) === 61 ? 2 : 1;
	const remainder = end % 4;
	// A misplaced or missing padding is reported after any invalid character, which is likelier to be the actual problem.
	let problem: string | undefined;
	if (remainder === 1) {
		problem = `must not end with a lone character (it would encode no whole byte), got ${end} data characters`;
	} else if (end < length ? padding === 'forbidden' : remainder !== 0 && padding === 'required') {
		problem = end < length ? `must not be padded, got "=" at index ${end}` : `must be padded to a multiple of 4 characters, got ${length}`;
	} else if (end < length && length % 4 !== 0) {
		problem = `must be padded to a multiple of 4 characters, got ${length}`;
	}

	const table = decodeTable(urlSafe ? 1 : 0);
	const native = (Uint8Array as NativeUint8ArrayConstructor).fromBase64;
	// The native decoder skips ASCII white space and, in its 'loose' mode (the only one accepting an unpadded final group), does not check
	// the unused bits: those two rules are checked here first. An invalid last character reads as 64, whose low bits are clear: the native
	// decoder then rejects it. Whatever it rejects is decoded again below, to report the offending character.
	if (
		problem === undefined &&
		typeof native === 'function' &&
		!WHITE_SPACE.test(text) &&
		(remainder === 0 || (table[text.charCodeAt(end - 1)] & (remainder === 2 ? 15 : 3)) === 0)
	) {
		try {
			return native(text, { alphabet: urlSafe ? 'base64url' : 'base64', lastChunkHandling: 'loose' });
		} catch {
			// Reported below.
		}
	}
	const bytes = new Uint8Array((end - remainder) * 0.75 + (remainder > 1 ? remainder - 1 : 0));
	let offset = 0;
	let i = 0;
	for (; i < end - 3; i += 4) {
		const c0 = text.charCodeAt(i);
		const c1 = text.charCodeAt(i + 1);
		const c2 = text.charCodeAt(i + 2);
		const c3 = text.charCodeAt(i + 3);
		// Codes above 127 index past the table (`undefined`, read as 0 by the bitwise operators): they are caught by the first test.
		const value = (table[c0] << 18) | (table[c1] << 12) | (table[c2] << 6) | table[c3];
		if ((c0 | c1 | c2 | c3) > 127 || (table[c0] | table[c1] | table[c2] | table[c3]) & 64) invalidBase64(text, i, table, urlSafe);
		bytes[offset++] = value >> 16;
		bytes[offset++] = value >> 8;
		bytes[offset++] = value;
	}
	if (remainder !== 0) {
		// A final group of 2 (3) characters encodes one (two) bytes; the 4 (2) low bits of its last character encode nothing.
		let value = 0;
		for (let j = i; j < end; j++) {
			const code = text.charCodeAt(j);
			if (code > 127 || table[code] === 64) invalidBase64(text, j, table, urlSafe);
			value = (value << 6) | table[code];
		}
		if (problem === undefined && value & (remainder === 2 ? 15 : 3)) {
			throw new SyntaxError(
				`fromBase64: \`text\` must be canonical (the unused bits of its last character must be 0), got ${quoteAt(text, end - 1)} at index ${end - 1}`
			);
		}
		value >>= remainder === 2 ? 4 : 2;
		if (remainder === 3) bytes[offset++] = value >> 8;
		bytes[offset] = value;
	}
	if (problem !== undefined) throw new SyntaxError(`fromBase64: \`text\` ${problem}`);
	return bytes;
}

/**
 * Throws the error for the first character of `text`, from `start` on, that is not in the base64 alphabet.
 * @param {string} text - The base64 text
 * @param {number} start - Index of a group known to contain an invalid character
 * @param {Uint8Array} table - The decoding table of the alphabet
 * @param {boolean} urlSafe - Whether the alphabet is base64url (for the message)
 * @returns {never} Never returns
 * @throws {SyntaxError} always
 */
function invalidBase64(text: string, start: number, table: Uint8Array, urlSafe: boolean): never {
	let index = start;
	while (text.charCodeAt(index) < 128 && table[text.charCodeAt(index)] !== 64) index++;
	throw new SyntaxError(`fromBase64: \`text\` must contain only base64${urlSafe ? 'url' : ''} characters, got ${quoteAt(text, index)} at index ${index}`);
}

/**
 * Encodes binary data (or the UTF-8 encoding of a string) as lowercase hexadecimal, two digits per byte.
 * Uses the native `Uint8Array.prototype.toHex` when available (identical output).
 * @param {string | BytesInput} data - The bytes to encode, or a string to encode as UTF-8
 * @returns {string} The hex digits (empty for no bytes)
 * @throws {TypeError} when `data` is neither a string nor binary data
 * @example
 * toHex(new Uint8Array([0, 15, 16, 255])); // => '000f10ff'
 * toHex('hi'); // => '6869'
 * toHex(new Uint16Array([1]).buffer); // => '0100' // the bytes as stored (little-endian on almost every platform)
 */
export function toHex(data: string | BytesInput): string {
	const bytes = dataOf('toHex', data);
	const native = (Uint8Array.prototype as NativeUint8Array).toHex;
	if (typeof native === 'function') return native.call(bytes);
	const length = bytes.length;
	const codes = new Uint16Array(Math.min(CHUNK, 2 * length) + 2);
	let count = 0;
	let text = '';
	for (let i = 0; i < length; i++) {
		const byte = bytes[i];
		// 48 is `0`; digits above 9 are shifted to `a` (97 = 48 + 10 + 39).
		codes[count] = (byte >> 4) + (byte >> 4 > 9 ? 87 : 48);
		codes[count + 1] = (byte & 15) + ((byte & 15) > 9 ? 87 : 48);
		count += 2;
		if (count >= CHUNK) {
			text += fromCodes(codes, count);
			count = 0;
		}
	}
	return text + fromCodes(codes, count);
}

/**
 * Decodes hexadecimal text, two digits per byte, in either letter case. Strict: no `0x` prefix, separators or white space, and an even
 * number of digits. Uses the native `Uint8Array.fromHex` when available (identical results).
 * @param {string} text - The hex digits
 * @returns {Uint8Array} The decoded bytes, in a new array
 * @throws {TypeError} when `text` is not a string
 * @throws {SyntaxError} when `text` has an odd length or a character that is not a hex digit
 * @example
 * fromHex('000f10ff'); // => new Uint8Array([0, 15, 16, 255])
 * fromHex('CAFE'); // => new Uint8Array([202, 254])
 * fromHex('abc'); // throws SyntaxError
 * fromHex('0x12'); // throws SyntaxError
 */
export function fromHex(text: string): Uint8Array<ArrayBuffer> {
	if (typeof text !== 'string') throw new TypeError(`fromHex: \`text\` must be a string, got ${describe(text)}`);
	const length = text.length;
	if (length % 2 !== 0) throw new SyntaxError(`fromHex: \`text\` must have an even number of hex digits, got ${length}`);
	const native = (Uint8Array as NativeUint8ArrayConstructor).fromHex;
	if (typeof native === 'function') {
		try {
			return native(text);
		} catch {
			// Malformed: the portable decoder below reports the offending character.
		}
	}
	const bytes = new Uint8Array(length / 2);
	for (let i = 0; i < length; i += 2) bytes[i / 2] = (hexDigit(text, i) << 4) | hexDigit(text, i + 1);
	return bytes;
}

/**
 * Returns the value of the hex digit at `index` of `text`.
 * @param {string} text - The hex text
 * @param {number} index - Index of the digit
 * @returns {number} `0`–`15`
 * @throws {SyntaxError} when the character is not a hex digit
 */
function hexDigit(text: string, index: number): number {
	const code = text.charCodeAt(index);
	// `| 32` lowercases `A`-`F`; only `A`-`F` and `a`-`f` land in `a`-`f` that way.
	const letter = (code | 32) - 87;
	if (code >= 48 && code <= 57) return code - 48;
	if (letter >= 10 && letter <= 15) return letter;
	throw new SyntaxError(`fromHex: \`text\` must contain only hex digits, got ${quoteAt(text, index)} at index ${index}`);
}

/** A UTF-16 surrogate that is not part of a pair (with the `u` flag, paired ones form a single code point). */
const LONE_SURROGATE = /\p{Cs}/u;

/** The `TextEncoder` constructor {@link utf8Encoder} was created from, and that encoder. */
let encoderClass: unknown;
let utf8Encoder: TextEncoderLike;

/**
 * Encodes a string as UTF-8 bytes. Lone surrogates (invalid UTF-16) become U+FFFD (`EF BF BD`), exactly like `TextEncoder`, or throw
 * with `fatal`. No byte order mark is added.
 *
 * Uses the native `TextEncoder` when available, otherwise an equivalent portable encoder.
 * @param {string} text - The text to encode
 * @param {EncodeUtf8Options} [options={}] - `fatal` (default `false`): throw on a lone surrogate instead of replacing it
 * @returns {Uint8Array} The UTF-8 bytes, in a new array
 * @throws {TypeError} when `text` is not a string, `options` is not an object, `fatal` is not a boolean, or with `fatal`, when `text`
 * contains a lone surrogate
 * @example
 * encodeUtf8('hé'); // => new Uint8Array([104, 195, 169])
 * encodeUtf8('😀'); // => new Uint8Array([240, 159, 152, 128])
 * encodeUtf8('\uD800'); // => new Uint8Array([239, 191, 189]) // a lone surrogate becomes U+FFFD
 * encodeUtf8('\uD800', { fatal: true }); // throws TypeError
 */
export function encodeUtf8(text: string, options?: EncodeUtf8Options): Uint8Array<ArrayBuffer> {
	const [fatalOption] = readOptions('encodeUtf8', options, ['fatal']);
	const fatal = booleanOption('encodeUtf8', 'fatal', fatalOption, false);
	if (typeof text !== 'string') throw new TypeError(`encodeUtf8: \`text\` must be a string, got ${describe(text)}`);
	if (fatal) {
		// The native `isWellFormed` (ES2024) is several times faster than the search, which is then only needed to report the surrogate.
		const index = (text as { isWellFormed?(): boolean }).isWellFormed?.() ? -1 : text.search(LONE_SURROGATE);
		if (index !== -1) {
			throw new TypeError(`encodeUtf8: \`text\` must be well-formed UTF-16, got a lone surrogate ${JSON.stringify(text[index])} at index ${index}`);
		}
	}
	const Encoder = (globalThis as { TextEncoder?: new () => TextEncoderLike }).TextEncoder;
	if (typeof Encoder === 'function') {
		if (Encoder !== encoderClass) {
			utf8Encoder = new Encoder();
			encoderClass = Encoder;
		}
		return utf8Encoder.encode(text);
	}

	const length = text.length;
	// First pass: the exact size, so that no oversized buffer is allocated and then trimmed.
	let size = length;
	for (let i = 0; i < length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0x80) {
			size += code < 0x800 ? 1 : 2;
			// A valid pair takes 4 bytes for 2 units: one more than the 3 already counted for its high surrogate, and the low one is skipped.
			if (isPair(text, i, code)) i++;
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (let i = 0; i < length; i++) {
		let code = text.charCodeAt(i);
		if (code < 0x80) {
			bytes[offset++] = code;
		} else if (code < 0x800) {
			bytes[offset++] = 0xc0 | (code >> 6);
			bytes[offset++] = 0x80 | (code & 63);
		} else {
			if (isPair(text, i, code)) {
				code = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
				bytes[offset++] = 0xf0 | (code >> 18);
				bytes[offset++] = 0x80 | ((code >> 12) & 63);
			} else {
				// A lone surrogate is encoded as U+FFFD.
				if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
				bytes[offset++] = 0xe0 | (code >> 12);
			}
			bytes[offset++] = 0x80 | ((code >> 6) & 63);
			bytes[offset++] = 0x80 | (code & 63);
		}
	}
	return bytes;
}

/**
 * Tells whether the code unit at `index` is a high surrogate followed by a low surrogate.
 * @param {string} text - The text
 * @param {number} index - Index of the code unit
 * @param {number} code - The code unit at `index`
 * @returns {boolean} `true` for the first unit of a valid surrogate pair
 */
function isPair(text: string, index: number, code: number): boolean {
	if (code < 0xd800 || code > 0xdbff) return false;
	const next = text.charCodeAt(index + 1);
	return next >= 0xdc00 && next <= 0xdfff;
}

/**
 * The `TextDecoder` constructor the decoders were created from, and the replacing (`0`) and fatal (`1`) decoders (own `undefined`s until
 * created, never holes looked up on a polluted `Object.prototype`).
 */
let decoderClass: unknown;
let utf8Decoders: (TextDecoderLike | undefined)[] = [undefined, undefined];

/**
 * Decodes UTF-8 bytes into a string, following the WHATWG Encoding Standard exactly (the behaviour of `TextDecoder`): each maximal
 * invalid subsequence (a stray continuation byte, a truncated sequence, an overlong form, a surrogate code point, a value above
 * U+10FFFF) becomes one U+FFFD, or throws with `fatal`. A leading byte order mark is kept unless `stripBom` is set, so that decoding is
 * the exact inverse of {@link encodeUtf8}.
 *
 * Uses the native `TextDecoder` when available, otherwise an equivalent portable decoder.
 * @param {BytesInput} bytes - The UTF-8 bytes
 * @param {DecodeUtf8Options} [options={}] - `fatal` (default `false`): throw on malformed input; `stripBom` (default `false`): drop a
 * leading byte order mark
 * @returns {string} The decoded text
 * @throws {TypeError} when `bytes` is not binary data, `options` is not an object, `fatal` or `stripBom` is not a boolean, or with
 * `fatal`, when `bytes` is not valid UTF-8
 * @example
 * decodeUtf8(new Uint8Array([104, 195, 169])); // => 'hé'
 * decodeUtf8(new Uint8Array([104, 255, 105])); // => 'h\uFFFDi'
 * decodeUtf8(new Uint8Array([104, 255, 105]), { fatal: true }); // throws TypeError
 * decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 104])); // => '\uFEFFh'
 * decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 104]), { stripBom: true }); // => 'h'
 */
export function decodeUtf8(bytes: BytesInput, options?: DecodeUtf8Options): string {
	const [fatalOption, stripBomOption] = readOptions('decodeUtf8', options, ['fatal', 'stripBom']);
	const fatal = booleanOption('decodeUtf8', 'fatal', fatalOption, false);
	const stripBom = booleanOption('decodeUtf8', 'stripBom', stripBomOption, false);
	const view = bytesOf('decodeUtf8', bytes);
	let text: string | undefined;
	const Decoder = (globalThis as { TextDecoder?: new (label: string, options: object) => TextDecoderLike }).TextDecoder;
	if (typeof Decoder === 'function') {
		if (Decoder !== decoderClass) {
			utf8Decoders = [undefined, undefined];
			decoderClass = Decoder;
		}
		const kind = fatal ? 1 : 0;
		const decoder = (utf8Decoders[kind] ??= new Decoder('utf-8', { fatal, ignoreBOM: true }));
		try {
			text = decoder.decode(view);
		} catch {
			// Malformed input under `fatal` (or a view the native decoder refuses, such as one over shared memory): the portable decoder
			// below reports the offending byte, or decodes what the native one would not.
		}
	}
	text ??= decodeUtf8Portable(view, fatal);
	return stripBom && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The portable UTF-8 decoder behind {@link decodeUtf8} (WHATWG Encoding Standard, "UTF-8 decoder" with replacement or fatal errors).
 * @param {Uint8Array} bytes - The UTF-8 bytes
 * @param {boolean} fatal - Throw on malformed input instead of emitting U+FFFD
 * @returns {string} The decoded text (a leading byte order mark is kept)
 * @throws {TypeError} with `fatal`, when `bytes` is not valid UTF-8
 */
function decodeUtf8Portable(bytes: Uint8Array, fatal: boolean): string {
	const length = bytes.length;
	// Two spare slots: a code point is flushed as a surrogate pair at most.
	const units = new Uint16Array(Math.min(CHUNK, length) + 2);
	let count = 0;
	let text = '';
	let i = 0;
	while (i < length) {
		const lead = bytes[i];
		let code = lead;
		let next = i + 1;
		if (lead >= 0x80) {
			// Continuation bytes needed, and the allowed range of the first one (narrowed to exclude overlongs, surrogates and > U+10FFFF).
			let needed = 0;
			let lower = 0x80;
			let upper = 0xbf;
			if (lead >= 0xc2 && lead <= 0xdf) {
				needed = 1;
				code = lead & 0x1f;
			} else if (lead >= 0xe0 && lead <= 0xef) {
				needed = 2;
				code = lead & 0x0f;
				if (lead === 0xe0) lower = 0xa0;
				if (lead === 0xed) upper = 0x9f;
			} else if (lead >= 0xf0 && lead <= 0xf4) {
				needed = 3;
				code = lead & 0x07;
				if (lead === 0xf0) lower = 0x90;
				if (lead === 0xf4) upper = 0x8f;
			}
			// An invalid lead byte (`needed` 0) is one error; so is a valid prefix cut short, which leaves the offending byte to be read again.
			let valid = needed > 0;
			for (; valid && needed > 0; needed--, next++) {
				const byte = bytes[next];
				valid = next < length && byte >= lower && byte <= upper;
				code = (code << 6) | (byte & 0x3f);
				lower = 0x80;
				upper = 0xbf;
			}
			if (!valid) {
				if (fatal) throw new TypeError(`decodeUtf8: \`bytes\` must be valid UTF-8, got a malformed sequence at byte ${i}`);
				code = 0xfffd;
				if (next > i + 1) next--;
			}
		}
		if (code > 0xffff) {
			code -= 0x10000;
			units[count++] = 0xd800 + (code >> 10);
			code = 0xdc00 + (code & 0x3ff);
		}
		units[count++] = code;
		if (count >= CHUNK) {
			text += fromCodes(units, count);
			count = 0;
		}
		i = next;
	}
	return text + fromCodes(units, count);
}

/** SHA-256 round constants (`K`, 64 words) followed by the initial hash value (`H0`, 8 words), computed on first use. */
let SHA256_CONSTANTS: Int32Array | undefined;

/** The last 16 words of the message schedule, reused by every compression. */
let schedule: Int32Array;

/**
 * Returns the first 32 bits of the fractional part of the `k`-th root of a prime, computed exactly with integer arithmetic, as the
 * SHA-256 specification (FIPS 180-4 §4.2.2, §5.3.3) defines its constants. Avoids both a 288-byte literal table and any dependence on
 * how precisely an engine's `Math.cbrt` or `**` rounds.
 * @param {number} prime - The prime (at most 311)
 * @param {bigint} k - `2n` (square root) or `3n` (cube root)
 * @returns {number} The 32 fractional bits, as a signed 32-bit integer
 */
function rootBits(prime: number, k: bigint): number {
	// floor(root(prime) * 2 ** 32) = floor(root(prime * 2 ** (32 * k))), by Newton's method on integers: started above the root
	// (every root here is below 7 * 2 ** 32 < 2 ** 36), the iterates decrease strictly until they reach it.
	const target = BigInt(prime) << (32n * k);
	let root = 1n << 36n;
	for (;;) {
		const next = ((k - 1n) * root + target / root ** (k - 1n)) / k;
		if (next >= root) return Number(BigInt.asIntN(32, root));
		root = next;
	}
}

/**
 * Builds the SHA-256 constants: the cube-root words of the first 64 primes, then the square-root words of the first 8.
 * @returns {Int32Array} 72 words
 */
function sha256Constants(): Int32Array {
	const constants = new Int32Array(72);
	const primes: number[] = [];
	for (let candidate = 2; primes.length < 64; candidate++) {
		if (
			primes.every(function (prime: number): boolean {
				return candidate % prime !== 0;
			})
		) {
			primes.push(candidate);
		}
	}
	for (let i = 0; i < 64; i++) constants[i] = rootBits(primes[i], 3n);
	for (let i = 0; i < 8; i++) constants[64 + i] = rootBits(primes[i], 2n);
	schedule = new Int32Array(16);
	return constants;
}

/**
 * Applies the SHA-256 compression function to one 64-byte block (FIPS 180-4 §6.2.2).
 * @param {Int32Array} state - The 8-word hash state (mutated)
 * @param {Uint8Array} block - The bytes holding the block
 * @param {number} offset - Index of the block's first byte
 * @param {Int32Array} k - The constants
 * @returns {void}
 */
function compress(state: Int32Array, block: Uint8Array, offset: number, k: Int32Array): void {
	// The schedule is computed round by round in a ring of 16 words (`w[t]` only needs the 16 before it): 1.6 times as fast as filling
	// all 64 words first, since the ring stays in registers and cache.
	const w = schedule;
	let a = state[0];
	let b = state[1];
	let c = state[2];
	let d = state[3];
	let e = state[4];
	let f = state[5];
	let g = state[6];
	let h = state[7];
	for (let i = 0; i < 64; i++) {
		let word: number;
		if (i < 16) {
			word = (block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3];
			offset += 4;
		} else {
			// `w[t - 15]`, `w[t - 2]` and `w[t - 7]` are at `t + 1`, `t + 14` and `t + 9` modulo 16; `w[t - 16]` is at `t` itself.
			const x = w[(i + 1) & 15];
			const y = w[(i + 14) & 15];
			const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
			const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
			word = (w[i & 15] + s0 + w[(i + 9) & 15] + s1) | 0;
		}
		w[i & 15] = word;
		const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + (g ^ (e & (f ^ g))) + k[i] + word) | 0;
		const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) | (c & (a | b)))) | 0;
		h = g;
		g = f;
		f = e;
		e = (d + t1) | 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) | 0;
	}
	state[0] += a;
	state[1] += b;
	state[2] += c;
	state[3] += d;
	state[4] += e;
	state[5] += f;
	state[6] += g;
	state[7] += h;
}

/**
 * Computes the SHA-256 digest (FIPS 180-4) of binary data or of the UTF-8 encoding of a string, synchronously and in plain JavaScript.
 *
 * Unlike `crypto.subtle.digest`, it needs no secure context (plain-HTTP pages), no `await`, and no Node `crypto` module, and it gives
 * the same digest everywhere: strings are hashed as `TextEncoder` would encode them (like Node's `hash.update(text)`). Throughput is
 * around 250 MB/s on current engines (a 32-byte input takes about 0.4 microseconds): fine for content addressing, cache keys,
 * integrity checks and ETags; prefer the native `crypto.subtle.digest` for very large inputs where it is available.
 * @param {string | BytesInput} data - The bytes to hash, or a string to hash as UTF-8
 * @returns {Uint8Array} The 32-byte digest
 * @throws {TypeError} when `data` is neither a string nor binary data
 * @example
 * toHex(sha256('abc')); // => 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
 * sha256(new Uint8Array(0)).length; // => 32
 */
export function sha256(data: string | BytesInput): Uint8Array<ArrayBuffer> {
	const bytes = dataOf('sha256', data);
	const k = (SHA256_CONSTANTS ??= sha256Constants());
	return sha256Finish(k.slice(64), bytes, 0, k);
}

/**
 * Hashes the rest of a message into a SHA-256 state and returns the digest: the whole blocks of `bytes` are compressed in place (never
 * copied), then the padding (FIPS 180-4 §5.1.1) with the length of the WHOLE message, `absorbed + bytes.length` bytes.
 * @param {Int32Array} state - The 8-word hash state (mutated), which has already absorbed `absorbed` bytes
 * @param {Uint8Array} bytes - The rest of the message
 * @param {number} absorbed - The number of bytes the state has already absorbed (a multiple of 64)
 * @param {Int32Array} k - The constants
 * @returns {Uint8Array} The 32-byte digest
 */
function sha256Finish(state: Int32Array, bytes: Uint8Array, absorbed: number, k: Int32Array): Uint8Array<ArrayBuffer> {
	const length = bytes.length;
	const full = length - (length % 64);
	for (let offset = 0; offset < full; offset += 64) compress(state, bytes, offset, k);

	// Padding: the leftover bytes, a 1 bit, zeros, and the message length in bits as a 64-bit big-endian integer (one or two blocks).
	const tail = new Uint8Array(length - full < 56 ? 64 : 128);
	tail.set(bytes.subarray(full));
	tail[length - full] = 0x80;
	const end = tail.length;
	const total = absorbed + length;
	const high = Math.floor(total / 0x20000000);
	const low = (total << 3) >>> 0;
	tail[end - 8] = high >>> 24;
	tail[end - 7] = high >>> 16;
	tail[end - 6] = high >>> 8;
	tail[end - 5] = high;
	tail[end - 4] = low >>> 24;
	tail[end - 3] = low >>> 16;
	tail[end - 2] = low >>> 8;
	tail[end - 1] = low;
	for (let offset = 0; offset < end; offset += 64) compress(state, tail, offset, k);

	const digest = new Uint8Array(32);
	for (let i = 0; i < 8; i++) {
		const word = state[i];
		digest[i * 4] = word >>> 24;
		digest[i * 4 + 1] = word >>> 16;
		digest[i * 4 + 2] = word >>> 8;
		digest[i * 4 + 3] = word;
	}
	return digest;
}

/**
 * Computes the SHA-256 digest of binary data or of the UTF-8 encoding of a string, as 64 lowercase hex digits (see {@link sha256}).
 * @param {string | BytesInput} data - The bytes to hash, or a string to hash as UTF-8
 * @returns {string} The digest in hex
 * @throws {TypeError} when `data` is neither a string nor binary data
 * @example
 * sha256Hex(''); // => 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
 * sha256Hex('abc') === sha256Hex(new Uint8Array([97, 98, 99])); // => true
 */
export function sha256Hex(data: string | BytesInput): string {
	return toHex(sha256(data));
}

/**
 * Computes the HMAC-SHA256 (RFC 2104, FIPS 198-1) of a message under a key, synchronously and in plain JavaScript: the keyed digest
 * behind HS256 JWTs, webhook signatures (Stripe, GitHub, Slack…), signed cookies and AWS Signature V4.
 *
 * Gives the same bytes as Node's `createHmac('sha256', key).update(message).digest()` and `crypto.subtle.sign('HMAC', …)`, without a
 * secure context, `await` or the Node `crypto` module. Strings (the key and the message alike) are taken as UTF-8. A key longer than
 * 64 bytes is hashed first, as the standard requires; a shorter one is zero-padded (so an empty key is valid, though useless as a
 * secret: use at least 32 random bytes). The message is hashed in place, never copied, and the cost is that of hashing it plus three
 * blocks (four with a long key). To check a received MAC, compare it with {@link timingSafeEqual}, never with `===`.
 * @param {string | BytesInput} key - The secret key, or a string to use as UTF-8
 * @param {string | BytesInput} message - The bytes to authenticate, or a string to authenticate as UTF-8
 * @returns {Uint8Array} The 32-byte MAC
 * @throws {TypeError} when `key` or `message` is neither a string nor binary data
 * @example
 * toHex(hmacSha256('key', 'The quick brown fox jumps over the lazy dog')); // => 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
 * hmacSha256(new Uint8Array(0), '').length; // => 32
 * @example
 * // Checking a webhook signature sent as hex in a header:
 * const secret = 'whsec_test';
 * const body = '{"event":"paid"}';
 * const header = hmacSha256Hex(secret, body); // what the sender computed
 * timingSafeEqual(fromHex(header), hmacSha256(secret, body)); // => true
 */
export function hmacSha256(key: string | BytesInput, message: string | BytesInput): Uint8Array<ArrayBuffer> {
	let secret = dataOf('hmacSha256', key, 'key');
	const bytes = dataOf('hmacSha256', message, 'message');
	const k = (SHA256_CONSTANTS ??= sha256Constants());
	if (secret.length > 64) secret = sha256Finish(k.slice(64), secret, 0, k);
	// The key block, XORed with the inner pad, is absorbed by the inner state; then XORed with the outer pad instead, by the outer state.
	const block = new Uint8Array(64);
	block.set(secret);
	for (let i = 0; i < 64; i++) block[i] ^= 0x36;
	const inner = k.slice(64);
	compress(inner, block, 0, k);
	for (let i = 0; i < 64; i++) block[i] ^= 0x36 ^ 0x5c;
	const outer = k.slice(64);
	compress(outer, block, 0, k);
	return sha256Finish(outer, sha256Finish(inner, bytes, 64, k), 64, k);
}

/**
 * Computes the HMAC-SHA256 of a message under a key as 64 lowercase hex digits (see {@link hmacSha256}).
 * @param {string | BytesInput} key - The secret key, or a string to use as UTF-8
 * @param {string | BytesInput} message - The bytes to authenticate, or a string to authenticate as UTF-8
 * @returns {string} The MAC in hex
 * @throws {TypeError} when `key` or `message` is neither a string nor binary data
 * @example
 * hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'); // => 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
 * hmacSha256Hex('', ''); // => 'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad'
 */
export function hmacSha256Hex(key: string | BytesInput, message: string | BytesInput): string {
	return toHex(hmacSha256(key, message));
}

/**
 * Compares two byte sequences (or the UTF-8 encodings of two strings) in a time that depends only on their length, not on where they
 * first differ: use it to check a secret (an HMAC, an API key, a CSRF or reset token) against the expected value, where an early-exit
 * `===` lets an attacker recover it byte by byte by timing the responses.
 *
 * The LENGTH is not hidden: inputs of different lengths return `false` at once. That is the norm (Node's `crypto.timingSafeEqual`
 * throws instead) and harmless for fixed-length values such as digests; to hide the length of a variable-length secret, compare their
 * digests instead (`timingSafeEqual(sha256(a), sha256(b))`). JavaScript engines give no formal constant-time guarantee, but the loop has
 * no data-dependent branch or early exit.
 * @param {string | BytesInput} a - The first value (a string is compared as UTF-8)
 * @param {string | BytesInput} b - The second value
 * @returns {boolean} Whether both hold the same bytes
 * @throws {TypeError} when `a` or `b` is neither a string nor binary data
 * @example
 * timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])); // => true
 * timingSafeEqual('secret-token', 'secret-tokem'); // => false
 * timingSafeEqual('abc', 'abcd'); // => false // a different length returns false at once
 * timingSafeEqual(sha256('a'), sha256('a')); // => true
 */
export function timingSafeEqual(a: string | BytesInput, b: string | BytesInput): boolean {
	const left = dataOf('timingSafeEqual', a, 'a');
	const right = dataOf('timingSafeEqual', b, 'b');
	const length = left.length;
	if (length !== right.length) return false;
	let difference = 0;
	for (let i = 0; i < length; i++) difference |= left[i] ^ right[i];
	return difference === 0;
}

/** The CRC-32 lookup tables for slicing-by-8 (8 × 256 words, table `t` at `256 * t`), built on first use. */
let CRC32_TABLES: Int32Array | undefined;

/**
 * Builds the slicing-by-8 tables of the reflected CRC-32 polynomial `0xEDB88320`: table 0 holds the CRC of each byte value, and
 * table `t` that of the byte followed by `t` zero bytes.
 * @returns {Int32Array} 2,048 words
 */
function crc32Tables(): Int32Array {
	const tables = new Int32Array(2048);
	for (let n = 0; n < 256; n++) {
		let crc = n;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		tables[n] = crc;
	}
	for (let i = 256; i < 2048; i++) tables[i] = tables[tables[i - 256] & 255] ^ (tables[i - 256] >>> 8);
	return tables;
}

/**
 * Computes the CRC-32 checksum of binary data or of the UTF-8 encoding of a string: the IEEE 802.3 polynomial with the usual
 * reflection and final inversion (often called "CRC-32" or "CRC-32/ISO-HDLC"), as in zlib, gzip, ZIP, PNG and Ethernet, and as Node's
 * `zlib.crc32` computes it.
 *
 * Incremental: pass the checksum of the bytes before as `initial` to continue it, so that `crc32(b, crc32(a))` is the checksum of `a`
 * followed by `b` (streaming a file chunk by chunk). Runs in linear time with slicing-by-8 (eight bytes per step; the 8 kB of tables are
 * built on first use). A checksum detects accidental corruption, NOT tampering: use {@link hmacSha256} to authenticate data.
 * @param {string | BytesInput} data - The bytes to checksum, or a string to checksum as UTF-8
 * @param {number} [initial=0] - The checksum of the preceding bytes, to continue from (`0` for none)
 * @returns {number} The checksum, an unsigned 32-bit integer
 * @throws {TypeError} when `data` is neither a string nor binary data, or `initial` is not a number
 * @throws {RangeError} when `initial` is not an integer between 0 and 4294967295
 * @example
 * crc32('123456789'); // => 0xcbf43926 // the standard check value
 * crc32(''); // => 0
 * crc32('hello world').toString(16).padStart(8, '0'); // => '0d4a1185'
 * crc32(' world', crc32('hello')) === crc32('hello world'); // => true
 * crc32('x', -1); // throws RangeError
 */
export function crc32(data: string | BytesInput, initial = 0): number {
	assertNumber('crc32', 'initial', initial, Number.isInteger(initial) && initial >= 0 && initial <= 0xffffffff, 'an integer between 0 and 4294967295');
	const bytes = dataOf('crc32', data);
	const t = (CRC32_TABLES ??= crc32Tables());
	const length = bytes.length;
	const full = length - (length % 8);
	let crc = ~initial;
	let i = 0;
	for (; i < full; i += 8) {
		// The first four bytes are folded into the running CRC; the next four only go through their tables.
		crc ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
		crc =
			t[1792 + (crc & 255)] ^
			t[1536 + ((crc >>> 8) & 255)] ^
			t[1280 + ((crc >>> 16) & 255)] ^
			t[1024 + (crc >>> 24)] ^
			t[768 + bytes[i + 4]] ^
			t[512 + bytes[i + 5]] ^
			t[256 + bytes[i + 6]] ^
			t[bytes[i + 7]];
	}
	for (; i < length; i++) crc = t[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
	return ~crc >>> 0;
}

/**
 * The base32 alphabets: `'rfc4648'` (RFC 4648 §6: `A`–`Z` then `2`–`7`, as in TOTP secrets), `'hex'` (base32hex, RFC 4648 §7: `0`–`9`
 * then `A`–`V`, which keeps the sort order of the bytes) and `'crockford'` (Douglas Crockford's: `0`–`9` then the letters except `I`,
 * `L`, `O` and `U`, as in ULIDs).
 */
export type Base32Alphabet = 'rfc4648' | 'hex' | 'crockford';

/**
 * Options accepted by {@link toBase32}.
 */
export interface ToBase32Options {
	/** The alphabet. Defaults to `'rfc4648'`. */
	readonly alphabet?: Base32Alphabet;
	/** Append `=` padding up to a multiple of 8 characters. Defaults to `true`, except with `'crockford'` (which has no padding). */
	readonly padding?: boolean;
}

/**
 * Options accepted by {@link fromBase32}.
 */
export interface FromBase32Options {
	/** The alphabet. Defaults to `'rfc4648'`. */
	readonly alphabet?: Base32Alphabet;
	/** Whether `=` padding is `'optional'`, `'required'` or `'forbidden'`. Defaults to `'optional'`. */
	readonly padding?: Base64Padding;
}

/** The base32 alphabets, at the indexes returned by {@link base32Kind}. */
const BASE32 = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', '0123456789ABCDEFGHIJKLMNOPQRSTUV', '0123456789ABCDEFGHJKMNPQRSTVWXYZ'];

/**
 * Lazily built base32 decoding tables (indexes as in {@link BASE32}): ASCII code → 5-bit value, `32` for invalid characters. Own
 * `undefined`s until built, as in {@link decodeTables}.
 */
const base32Tables: (Uint8Array | undefined)[] = [undefined, undefined, undefined];

/**
 * Validates the `alphabet` option of the base32 functions.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} alphabet - The option (`undefined` when absent)
 * @returns {number} `0` for `'rfc4648'`, `1` for `'hex'`, `2` for `'crockford'`
 * @throws {RangeError} when `alphabet` is not one of those names
 */
function base32Kind(caller: string, alphabet: unknown): number {
	const kind = alphabet === undefined ? 0 : ['rfc4648', 'hex', 'crockford'].indexOf(alphabet as string);
	if (kind === -1) throw new RangeError(`${caller}: \`alphabet\` must be 'rfc4648', 'hex' or 'crockford', got ${show(alphabet)}`);
	return kind;
}

/**
 * Encodes binary data (or the UTF-8 encoding of a string) as base32: RFC 4648 §6 (the default), base32hex (§7) or Crockford's base32,
 * with uppercase letters.
 * @param {string | BytesInput} data - The bytes to encode, or a string to encode as UTF-8
 * @param {ToBase32Options} [options={}] - `alphabet` (default `'rfc4648'`): `'rfc4648'`, `'hex'` or `'crockford'`; `padding` (default
 * `true`, `false` with `'crockford'`): append `=` up to a multiple of 8 characters
 * @returns {string} The encoded text (empty for no bytes)
 * @throws {TypeError} when `data` is neither a string nor binary data, `options` is not an object, or `padding` is not a boolean
 * @throws {RangeError} when `alphabet` is not `'rfc4648'`, `'hex'` or `'crockford'`
 * @example
 * toBase32('foobar'); // => 'MZXW6YTBOI======'
 * toBase32('foobar', { padding: false }); // => 'MZXW6YTBOI'
 * toBase32('foobar', { alphabet: 'hex' }); // => 'CPNMUOJ1E8======'
 * toBase32(new Uint8Array([255, 0]), { alphabet: 'crockford' }); // => 'ZW00'
 */
export function toBase32(data: string | BytesInput, options?: ToBase32Options): string {
	const [alphabetOption, paddingOption] = readOptions('toBase32', options, ['alphabet', 'padding']);
	const kind = base32Kind('toBase32', alphabetOption);
	const padding = booleanOption('toBase32', 'padding', paddingOption, kind !== 2);
	const bytes = dataOf('toBase32', data);
	const alphabet = BASE32[kind];
	const length = bytes.length;
	// At most two characters per byte, plus the final partial one.
	const codes = new Uint16Array(Math.min(CHUNK, 2 * length) + 3);
	let count = 0;
	let text = '';
	// The bits not yet written are the low `bits` bits of `buffer` (higher ones fall off the 32-bit shifts harmlessly).
	let buffer = 0;
	let bits = 0;
	for (let i = 0; i < length; i++) {
		buffer = (buffer << 8) | bytes[i];
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			codes[count++] = alphabet.charCodeAt((buffer >> bits) & 31);
		}
		if (count >= CHUNK) {
			text += fromCodes(codes, count);
			count = 0;
		}
	}
	// The leftover bits, completed with zeros to a whole character.
	if (bits > 0) codes[count++] = alphabet.charCodeAt((buffer << (5 - bits)) & 31);
	text += fromCodes(codes, count);
	return padding ? text + '='.repeat(-text.length & 7) : text;
}

/**
 * Decodes base32 text (see {@link toBase32}) strictly, like {@link fromBase64}: it rejects characters outside the alphabet (white space
 * and Crockford's optional `-` separators included), misplaced or incomplete padding, a final group of 1, 3 or 6 characters (which no
 * bytes encode to), and non-canonical text whose last character has non-zero unused bits. Letters may be in either case (base32 is
 * meant to be case-insensitive), and with `'crockford'`, `I` and `L` read as `1` and `O` as `0`, as its specification requires; so
 * `toBase32(fromBase32(text))` gives `text` back up to letter case (and those substitutions).
 * @param {string} text - The base32 text
 * @param {FromBase32Options} [options={}] - `alphabet` (default `'rfc4648'`): `'rfc4648'`, `'hex'` or `'crockford'`; `padding` (default
 * `'optional'`): whether `=` padding is `'optional'`, `'required'` or `'forbidden'`
 * @returns {Uint8Array} The decoded bytes, in a new array
 * @throws {TypeError} when `text` is not a string or `options` is not an object
 * @throws {RangeError} when `alphabet` or `padding` is not one of the accepted names
 * @throws {SyntaxError} when `text` is not canonical base32 text in that alphabet, satisfying the options
 * @example
 * decodeUtf8(fromBase32('MZXW6YTBOI======')); // => 'foobar'
 * decodeUtf8(fromBase32('mzxw6ytboi')); // => 'foobar'
 * fromBase32('ZW00', { alphabet: 'crockford' }); // => new Uint8Array([255, 0])
 * fromBase32('zwoo', { alphabet: 'crockford' }); // => new Uint8Array([255, 0])
 * fromBase32('MZXW6YTBOI', { padding: 'required' }); // throws SyntaxError
 * fromBase32('MZ======'); // throws SyntaxError // non-canonical: the last character's unused bits are not zero
 */
export function fromBase32(text: string, options?: FromBase32Options): Uint8Array<ArrayBuffer> {
	const [alphabetOption, padding = 'optional'] = readOptions('fromBase32', options, ['alphabet', 'padding']);
	const kind = base32Kind('fromBase32', alphabetOption);
	if (padding !== 'optional' && padding !== 'required' && padding !== 'forbidden') {
		throw new RangeError(`fromBase32: \`padding\` must be 'optional', 'required' or 'forbidden', got ${show(padding)}`);
	}
	if (typeof text !== 'string') throw new TypeError(`fromBase32: \`text\` must be a string, got ${describe(text)}`);

	const length = text.length;
	// `end` is the number of data characters: at most six final `=` are padding; any other `=` is an invalid character below.
	let end = length;
	while (end > length - 6 && text.charCodeAt(end - 1) === 61) end--;
	const remainder = end % 8;
	// As in `fromBase64`, a misplaced or missing padding is reported after any invalid character.
	let problem: string | undefined;
	if (remainder === 1 || remainder === 3 || remainder === 6) {
		problem = `must not end with a group of ${remainder} characters (no bytes encode to it), got ${end} data characters`;
	} else if (end < length ? padding === 'forbidden' : remainder !== 0 && padding === 'required') {
		problem = end < length ? `must not be padded, got "=" at index ${end}` : `must be padded to a multiple of 8 characters, got ${length}`;
	} else if (end < length && length % 8 !== 0) {
		problem = `must be padded to a multiple of 8 characters, got ${length}`;
	}

	let table = base32Tables[kind];
	if (table === undefined) {
		table = base32Tables[kind] = new Uint8Array(128).fill(32);
		const alphabet = BASE32[kind];
		// Both letter cases (`| 32` lowercases a letter and leaves a digit unchanged).
		for (let i = 0; i < 32; i++) table[alphabet.charCodeAt(i)] = table[alphabet.charCodeAt(i) | 32] = i;
		if (kind === 2) {
			// Crockford: `I` and `L` read as 1, `O` as 0, in either case.
			for (const letter of 'IiLl') table[letter.charCodeAt(0)] = 1;
			table[79] = table[111] = 0;
		}
	}
	const bytes = new Uint8Array(Math.floor((end * 5) / 8));
	let buffer = 0;
	let bits = 0;
	let offset = 0;
	for (let i = 0; i < end; i++) {
		const code = text.charCodeAt(i);
		// Codes above 127 index past the table: `undefined`, which is not 32 but is caught by `>= 32`.
		const value = table[code];
		if (!(value < 32)) {
			const name = ['base32', 'base32hex', 'Crockford base32'][kind];
			throw new SyntaxError(`fromBase32: \`text\` must contain only ${name} characters, got ${quoteAt(text, i)} at index ${i}`);
		}
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes[offset++] = buffer >> bits;
		}
	}
	if (problem !== undefined) throw new SyntaxError(`fromBase32: \`text\` ${problem}`);
	if (buffer & ((1 << bits) - 1)) {
		throw new SyntaxError(`fromBase32: \`text\` must be canonical (the unused bits of its last character must be 0), got ${quoteAt(text, end - 1)} at index ${end - 1}`);
	}
	return bytes;
}

/**
 * The registered claims of a JWT payload (RFC 7519 §4.1), all optional, and any other claim.
 */
export interface JwtPayload {
	/** Issuer. */
	readonly iss?: string;
	/** Subject. */
	readonly sub?: string;
	/** Audience: one recipient or several. */
	readonly aud?: string | readonly string[];
	/** Expiration time, in seconds since the epoch. */
	readonly exp?: number;
	/** Time before which the token must not be accepted, in seconds since the epoch. */
	readonly nbf?: number;
	/** Issue time, in seconds since the epoch. */
	readonly iat?: number;
	/** Unique identifier. */
	readonly jti?: string;
	/** Any other claim. */
	readonly [claim: string]: unknown;
}

/**
 * The common parameters of a JWT's JOSE header (RFC 7515 §4.1), and any other parameter.
 */
export interface JwtHeader {
	/** The signature algorithm (`'HS256'`, `'RS256'`, `'ES256'`, `'none'`…). */
	readonly alg?: string;
	/** The media type of the token (usually `'JWT'`). */
	readonly typ?: string;
	/** The identifier of the signing key. */
	readonly kid?: string;
	/** Any other parameter. */
	readonly [parameter: string]: unknown;
}

/**
 * A JWT decoded by {@link decodeJwt}.
 * @template P - The payload type
 * @template H - The header type
 */
export interface DecodedJwt<P extends object = JwtPayload, H extends object = JwtHeader> {
	/** The JOSE header. */
	readonly header: H;
	/** The claims. */
	readonly payload: P;
	/** The signature bytes (empty for an unsecured `alg: 'none'` token), NOT checked. */
	readonly signature: Uint8Array<ArrayBuffer>;
}

/**
 * Options accepted by {@link isJwtExpired}.
 */
export interface IsJwtExpiredOptions {
	/** The current time, as a `Date` or in milliseconds since the epoch. Defaults to `Date.now()`. */
	readonly now?: Date | number;
	/** Tolerated clock skew, in seconds: the token expires `leeway` seconds after its `exp` time. Defaults to `0`. */
	readonly leeway?: number;
}

/**
 * Decodes a JSON Web Token in compact serialization (`header.payload.signature`, each part base64url-encoded) WITHOUT VERIFYING IT.
 *
 * ⚠️ The signature is not checked: anyone can forge a token with any claims, so never trust the payload to authenticate or authorize
 * a request (verify the token server-side with its key, e.g. with `crypto.subtle.verify` or a JOSE library, before relying on it). This
 * is for reading claims you already trust (a token your own server just issued to this client) or for display and debugging, like
 * `jwt-decode` and jose's `decodeJwt`.
 *
 * Strict: the token must have exactly three parts (an encrypted JWE, with five, is rejected), each canonical base64url text without
 * padding (see {@link fromBase64}); the header and payload must be UTF-8 JSON objects. Prototype-pollution keys are removed from them
 * (any `__proto__` key, and a `constructor` key holding an object with a `prototype` key, as the validate module's `parseJson` does with
 * `proto: 'remove'`), so the claims can be merged or spread safely.
 * @template P - The payload type (not validated: check the claims you rely on)
 * @template H - The header type
 * @param {string} token - The JWT
 * @returns {DecodedJwt<P, H>} The header, the payload, and the signature bytes
 * @throws {TypeError} when `token` is not a string
 * @throws {SyntaxError} when `token` is not three base64url parts, or its header or payload is not a JSON object
 * @example
 * const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
 * decodeJwt(token).header; // => { alg: 'HS256', typ: 'JWT' }
 * decodeJwt(token).payload; // => { sub: '1234567890', name: 'John Doe', iat: 1516239022 }
 * decodeJwt(token).signature.length; // => 32
 * decodeJwt('not.a.jwt'); // throws SyntaxError
 */
export function decodeJwt<P extends object = JwtPayload, H extends object = JwtHeader>(token: string): DecodedJwt<P, H> {
	return decodeToken('decodeJwt', token) as DecodedJwt<P, H>;
}

/**
 * Decodes a JWT for {@link decodeJwt} and the expiration helpers.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} token - The token
 * @returns {DecodedJwt} The decoded token
 * @throws {TypeError} when `token` is not a string
 * @throws {SyntaxError} when `token` is malformed
 */
function decodeToken(caller: string, token: unknown): DecodedJwt {
	if (typeof token !== 'string') throw new TypeError(`${caller}: \`token\` must be a string, got ${describe(token)}`);
	const [first, second] = jwtDots(caller, token);
	return {
		header: jwtObject(caller, token.slice(0, first), 'header'),
		payload: jwtObject(caller, token.slice(first + 1, second), 'payload'),
		signature: jwtBytes(caller, token.slice(second + 1), 'signature')
	};
}

/**
 * Finds the two dots of a JWT in compact serialization.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} token - The token
 * @returns {number[]} The indexes of the first and second dots
 * @throws {SyntaxError} when `token` does not have exactly two dots
 */
function jwtDots(caller: string, token: string): number[] {
	const first = token.indexOf('.');
	// Without a first dot, `second` is -1 too.
	const second = token.indexOf('.', first + 1);
	if (second === -1 || token.includes('.', second + 1)) {
		// The parts are counted, not split: splitting a token of a hundred million dots ran the process out of memory.
		let parts = 1;
		for (let i = first; i !== -1; i = token.indexOf('.', i + 1)) parts++;
		throw new SyntaxError(`${caller}: \`token\` must have 3 parts separated by dots, got ${parts}`);
	}
	return [first, second];
}

/**
 * Decodes one base64url part of a JWT.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} part - The text of the part
 * @param {string} name - Its name, for the error message
 * @returns {Uint8Array} The bytes
 * @throws {SyntaxError} when `part` is not canonical base64url text without padding
 */
function jwtBytes(caller: string, part: string, name: string): Uint8Array<ArrayBuffer> {
	try {
		return fromBase64(part, { urlSafe: true, padding: 'forbidden' });
	} catch (error) {
		throw new SyntaxError(`${caller}: the ${name} of \`token\` must be base64url text without padding`, { cause: error });
	}
}

/**
 * Decodes the JSON object of a JWT part, without prototype-pollution keys.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} part - The base64url text of the part
 * @param {string} name - Its name, for error messages
 * @returns {Record<string, unknown>} The object
 * @throws {SyntaxError} when `part` is not the base64url encoding of a UTF-8 JSON object
 */
function jwtObject(caller: string, part: string, name: string): Record<string, unknown> {
	return jwtJson(caller, jwtBytes(caller, part, name), name);
}

/** Text that a JSON key removed by `withoutProtoKeys` contains: the key itself, or the backslash of an escape spelling it. */
const PROTO_KEY_TEXT = /__proto__|constructor|\\/;

/**
 * Parses the decoded bytes of a JWT part as a JSON object, without prototype-pollution keys.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {Uint8Array} bytes - The decoded part
 * @param {string} name - Its name, for error messages
 * @returns {Record<string, unknown>} The object
 * @throws {SyntaxError} when `bytes` is not a UTF-8 JSON object
 */
function jwtJson(caller: string, bytes: Uint8Array, name: string): Record<string, unknown> {
	let value: unknown;
	try {
		const json = decodeUtf8(bytes, { fatal: true });
		// A reviver makes `JSON.parse` several times slower. A `__proto__` or `constructor` key is spelled out in the text, or escaped with a
		// backslash: without either, there is nothing to remove.
		value = JSON.parse(json, PROTO_KEY_TEXT.test(json) ? withoutProtoKeys : undefined);
	} catch (error) {
		throw new SyntaxError(`${caller}: the ${name} of \`token\` must be UTF-8 JSON`, { cause: error });
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new SyntaxError(`${caller}: the ${name} of \`token\` must be a JSON object, got ${Array.isArray(value) ? 'array' : describe(value)}`);
	}
	return value as Record<string, unknown>;
}

/**
 * Reads the `exp` claim of a JWT.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {unknown} token - The token
 * @returns {Date | undefined} The expiration time, `undefined` without an `exp` claim
 * @throws {TypeError} when `token` is not a string
 * @throws {SyntaxError} when `token` is malformed or its `exp` claim is not a valid time
 */
function expirationOf(caller: string, token: unknown): Date | undefined {
	// An own claim only: an `exp` inherited from a polluted `Object.prototype` is not the token's.
	const exp = ownValue(decodeToken(caller, token).payload as Record<string, unknown>, 'exp');
	if (exp === undefined) return undefined;
	const date = new Date(typeof exp === 'number' ? exp * 1000 : NaN);
	if (Number.isNaN(date.getTime())) {
		throw new SyntaxError(`${caller}: the \`exp\` claim of \`token\` must be a time in seconds since the epoch, got ${typeof exp === 'number' ? exp : describe(exp)}`);
	}
	return date;
}

/**
 * Returns the expiration time of a JWT (its `exp` claim), WITHOUT VERIFYING the token (see {@link decodeJwt}): use it to schedule a
 * token refresh on the client, never to decide whether a token is valid.
 * @param {string} token - The JWT
 * @returns {Date | undefined} The expiration time, or `undefined` when the token has no `exp` claim
 * @throws {TypeError} when `token` is not a string
 * @throws {SyntaxError} when `token` is malformed (see {@link decodeJwt}) or its `exp` claim is not a number of seconds in the range of `Date`
 * @example
 * const token = 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDAwMDAwMDB9.';
 * getJwtExpiration(token); // => new Date(1_700_000_000_000)
 * getJwtExpiration('eyJhbGciOiJub25lIn0.e30.'); // => undefined
 */
export function getJwtExpiration(token: string): Date | undefined {
	return expirationOf('getJwtExpiration', token);
}

/**
 * Tells whether a JWT has expired, WITHOUT VERIFYING it (see {@link decodeJwt}): use it to refresh a token before sending it, never to
 * decide whether a token is valid. Like jose, a token is expired from its `exp` time on (`now >= exp + leeway`), and a token WITHOUT an
 * `exp` claim never expires (`false`).
 * @param {string} token - The JWT
 * @param {IsJwtExpiredOptions} [options={}] - `now` (default `Date.now()`): the current time, as a `Date` or in milliseconds;
 * `leeway` (default `0`): tolerated clock skew, in seconds
 * @returns {boolean} Whether the `exp` time (plus the leeway) has passed
 * @throws {TypeError} when `token` is not a string, `options` is not an object, or `now` or `leeway` has the wrong type
 * @throws {RangeError} when `now` is an invalid date or not finite, or `leeway` is negative or not finite
 * @throws {SyntaxError} when `token` is malformed or its `exp` claim is not a valid time (see {@link getJwtExpiration})
 * @example
 * const token = 'eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDAwMDAwMDB9.'; // exp: 1700000000
 * isJwtExpired(token, { now: 1_699_999_999_000 }); // => false
 * isJwtExpired(token, { now: 1_700_000_000_000 }); // => true
 * isJwtExpired(token, { now: 1_700_000_010_000, leeway: 30 }); // => false
 * isJwtExpired('eyJhbGciOiJub25lIn0.e30.'); // => false // no exp claim
 */
export function isJwtExpired(token: string, options?: IsJwtExpiredOptions): boolean {
	const [nowOption, leeway = 0] = readOptions('isJwtExpired', options, ['now', 'leeway']);
	const now = jwtNow('isJwtExpired', nowOption);
	jwtSeconds('isJwtExpired', 'leeway', leeway, true);
	const expiration = expirationOf('isJwtExpired', token);
	// Compared in seconds: `leeway * 1000` overflows to `Infinity` past 1.8e305 seconds, while the difference of two times cannot.
	return expiration !== undefined && (now - expiration.getTime()) / 1000 >= (leeway as number);
}

/**
 * Validates the `now` option of the JWT functions.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} now - The option (`undefined` when absent)
 * @returns {number} The time in milliseconds since the epoch (`Date.now()` by default)
 * @throws {TypeError} when `now` is neither a `Date` nor a number
 * @throws {RangeError} when `now` is an invalid date or not finite
 */
function jwtNow(caller: string, now: unknown): number {
	const time = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : now;
	assertNumber(caller, 'now', time, Number.isFinite(time), 'a valid Date or a finite number of milliseconds');
	return time;
}

/**
 * Validates a duration option of the JWT functions, in seconds.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the option
 * @param {unknown} value - Its value
 * @param {boolean} positive - Whether it must also be `>= 0`
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is not finite (or, when `positive`, negative)
 */
function jwtSeconds(caller: string, name: string, value: unknown, positive: boolean): asserts value is number {
	assertNumber(caller, name, value, Number.isFinite(value) && (!positive || (value as number) >= 0), `a finite number of seconds${positive ? ' >= 0' : ''}`);
}

/**
 * Reads an own property of a decoded JWT part, ignoring anything inherited (from a polluted `Object.prototype`, say).
 * @param {Record<string, unknown>} part - The header or the payload
 * @param {string} key - The parameter or claim
 * @returns {unknown} Its value, `undefined` when it is not an own property
 */
function ownValue(part: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(part, key) ? part[key] : undefined;
}

/**
 * Validates the secret of {@link signJwt} and {@link verifyJwt}.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} secret - The `secret` argument
 * @returns {Uint8Array} Its bytes
 * @throws {TypeError} when `secret` is neither a string nor binary data
 * @throws {RangeError} when `secret` is empty
 */
function jwtSecret(caller: string, secret: unknown): Uint8Array {
	const bytes = dataOf(caller, secret, 'secret');
	if (bytes.length === 0) throw new RangeError(`${caller}: \`secret\` must not be empty, got 0 bytes`);
	return bytes;
}

/** The options of {@link toBase64} that the JWT functions use. */
const BASE64_URL_OPTIONS = { urlSafe: true };

/** The header parameters {@link signJwt} writes first. */
const JWT_HEADER = { alg: 'HS256', typ: 'JWT' };

/**
 * Copies the header or the claims that {@link signJwt} writes (own enumerable properties only, defined rather than assigned, so that an own
 * `__proto__` key stays a plain key) into a plain object, which `JSON.stringify` writes several times faster than a null-prototype one.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the argument or option
 * @param {unknown} value - The object to copy
 * @param {object} [defaults] - Properties written first, which `value` can replace
 * @returns {Record<string, unknown>} The copy
 * @throws {TypeError} when `value` is not a non-array object, or has a `toJSON` method (which would replace it in the JSON)
 */
function jwtCopy(caller: string, name: string, value: unknown, defaults?: object): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${caller}: \`${name}\` must be an object, got ${Array.isArray(value) ? 'array' : describe(value)}`);
	}
	const copy: Record<string, unknown> = { ...defaults, ...value };
	// `JSON.stringify` would call a `toJSON` of `value` (own, or inherited from a class or `Date`) instead of writing it, and the copy's (a
	// polluted `Object.prototype`) instead of writing the copy.
	if (typeof (value as Record<string, unknown>).toJSON === 'function' || typeof copy.toJSON === 'function') {
		throw new TypeError(`${caller}: \`${name}\` must not have a toJSON method, which would replace it`);
	}
	return copy;
}

/**
 * Options accepted by {@link signJwt}.
 */
export interface SignJwtOptions {
	/**
	 * Extra JOSE header parameters (`kid`, `cty`…), written after `alg` and `typ`. `typ` (`'JWT'` by default) can be replaced, or left
	 * out by setting it to `undefined`; `alg` is always `'HS256'`.
	 */
	readonly header?: { readonly alg?: 'HS256'; readonly typ?: string; readonly kid?: string; readonly [parameter: string]: unknown };
	/** Add an `exp` claim this many seconds after `now` (the token expires then). Not allowed when `payload` has an `exp` claim. */
	readonly expiresIn?: number;
	/** Add an `nbf` claim this many seconds after `now` (the token is not valid before). Not allowed when `payload` has an `nbf` claim. */
	readonly notBefore?: number;
	/** Add an `iat` claim (the time of `now`) when `payload` has none. Defaults to `true`. */
	readonly timestamp?: boolean;
	/** The current time, as a `Date` or in milliseconds since the epoch. Defaults to `Date.now()`. */
	readonly now?: Date | number;
}

/**
 * Signs a JWT with HMAC-SHA256 (`alg: 'HS256'`, RFC 7519 and RFC 7515), synchronously: the JSON header (`{"alg":"HS256","typ":"JWT"}`
 * plus `options.header`), the JSON claims, each base64url-encoded without padding, then the HMAC of both under `secret`. The token is
 * accepted by {@link verifyJwt} and by every JOSE library (jose, jsonwebtoken…).
 *
 * The claims are the own enumerable properties of `payload`, plus `iat` (the current time in whole seconds, unless `payload` has one or
 * `timestamp` is `false`), and with `notBefore` or `expiresIn`, `nbf` or `exp` that many seconds after it. Values are written with
 * `JSON.stringify` (so `undefined` and functions are left out, and a `Date` becomes its ISO text). Choose a secret of at least 32 random
 * bytes (RFC 7518 §3.2): a short or guessable one can be found offline from any token.
 * @param {object} payload - The claims: a JSON-serializable object, not an array
 * @param {string | BytesInput} secret - The HMAC key, or a string to use as UTF-8 (not empty)
 * @param {SignJwtOptions} [options={}] - `header`: extra header parameters; `expiresIn`, `notBefore`: lifetimes in seconds;
 * `timestamp` (default `true`): add `iat`; `now` (default `Date.now()`): the current time
 * @returns {string} The token, `header.payload.signature`
 * @throws {TypeError} when `payload` is not a non-array object or has a `toJSON` method, `secret` is neither a string nor binary data,
 * `options` or `header` is not an object, an option has the wrong type, `expiresIn` (`notBefore`) is given for a payload with an `exp`
 * (`nbf`) claim, or a value cannot be serialized (a bigint, a cycle)
 * @throws {RangeError} when `secret` is empty, `header.alg` is not `'HS256'`, `header` has a `crit` parameter (which `verifyJwt` would
 * reject), `now` is an invalid date or not finite, or `expiresIn` or `notBefore` is not finite
 * @example
 * signJwt({ sub: '1234567890', name: 'John Doe', iat: 1516239022 }, 'your-256-bit-secret'); // => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
 * const token = signJwt({ sub: 'ada' }, 'secret', { expiresIn: 3600, now: 1_700_000_000_000, header: { kid: 'k1' } });
 * decodeJwt(token).header; // => { alg: 'HS256', typ: 'JWT', kid: 'k1' }
 * decodeJwt(token).payload; // => { sub: 'ada', iat: 1700000000, exp: 1700003600 }
 * signJwt({}, 'secret', { header: { alg: 'none' } as never }); // throws RangeError
 */
export function signJwt(payload: object, secret: string | BytesInput, options?: SignJwtOptions): string {
	const [headerOption, expiresIn, notBefore, timestampOption, nowOption] = readOptions('signJwt', options, ['header', 'expiresIn', 'notBefore', 'timestamp', 'now']);
	const now = jwtNow('signJwt', nowOption);
	const timestamp = booleanOption('signJwt', 'timestamp', timestampOption, true);
	if (expiresIn !== undefined) jwtSeconds('signJwt', 'expiresIn', expiresIn, false);
	if (notBefore !== undefined) jwtSeconds('signJwt', 'notBefore', notBefore, false);
	// `alg` and `typ` come first; the extra parameters can replace (or remove) `typ`, and replacing `alg` is an error.
	const header = jwtCopy('signJwt', 'header', headerOption === undefined ? {} : headerOption, JWT_HEADER);
	if (header.alg !== 'HS256') throw new RangeError(`signJwt: \`header.alg\` must be 'HS256' (the only algorithm signJwt supports), got ${show(header.alg)}`);
	// `verifyJwt` rejects every `crit` (no extension is supported), so a token carrying one could never be verified.
	if (Object.hasOwn(header, 'crit') && header.crit !== undefined) throw new RangeError('signJwt: `header` must not have a `crit` parameter (no extension is supported)');
	const claims = jwtCopy('signJwt', 'payload', payload);
	const key = jwtSecret('signJwt', secret);
	const seconds = Math.floor(now / 1000);
	if (timestamp && ownValue(claims, 'iat') === undefined) claims.iat = seconds;
	for (const [name, claim, offset] of [
		['notBefore', 'nbf', notBefore],
		['expiresIn', 'exp', expiresIn]
	] as const) {
		if (offset === undefined) continue;
		if (ownValue(claims, claim) !== undefined) throw new TypeError(`signJwt: \`${name}\` must be left out when \`payload\` has an \`${claim}\` claim`);
		claims[claim] = seconds + offset;
	}
	const input = `${toBase64(JSON.stringify(header), BASE64_URL_OPTIONS)}.${toBase64(JSON.stringify(claims), BASE64_URL_OPTIONS)}`;
	return `${input}.${toBase64(hmacSha256(key, input), BASE64_URL_OPTIONS)}`;
}

/**
 * Why {@link verifyJwt} rejected a token:
 * - `'malformed'`: not three canonical base64url parts, or a header or payload that is not a UTF-8 JSON object (see {@link decodeJwt});
 * - `'invalid_algorithm'`: the `alg` header parameter is not exactly `'HS256'` (`'none'`, `'RS256'`, `'hs256'`, missing…);
 * - `'invalid_header'`: a `crit` header parameter (no extension is supported), or a `typ` other than the `typ` option;
 * - `'invalid_signature'`: the signature is not the HMAC-SHA256 of the token under the secret;
 * - `'invalid_claim'`: an `exp`, `nbf` or `iat` claim that is not a finite number, or, with `maxAge`, an `iat` claim missing or in the future;
 * - `'expired'`: the `exp` time has passed; `'not_before'`: the `nbf` time has not come; `'too_old'`: `iat` is more than `maxAge` ago;
 * - `'invalid_issuer'`, `'invalid_audience'`, `'invalid_subject'`: the `iss`, `aud` or `sub` claim is missing or not an expected value.
 */
export type JwtVerificationErrorCode =
	| 'malformed'
	| 'invalid_algorithm'
	| 'invalid_header'
	| 'invalid_signature'
	| 'invalid_claim'
	| 'expired'
	| 'not_before'
	| 'too_old'
	| 'invalid_issuer'
	| 'invalid_audience'
	| 'invalid_subject';

/**
 * Error thrown by {@link verifyJwt} when a token is malformed, forged, or not acceptable; `code` tells why. The message never quotes the
 * token, its claims or the secret, so it can be logged as is.
 * @example
 * try {
 *   verifyJwt(signJwt({}, 'secret'), 'other secret');
 * } catch (error) {
 *   error instanceof JwtVerificationError; // => true
 *   (error as JwtVerificationError).code; // => 'invalid_signature'
 * }
 */
export class JwtVerificationError extends Error {
	override name = 'JwtVerificationError';
	/** Why the token was rejected. */
	readonly code: JwtVerificationErrorCode;

	/**
	 * @param {string} message - The error message
	 * @param {JwtVerificationErrorCode} code - Why the token was rejected
	 */
	constructor(message: string, code: JwtVerificationErrorCode) {
		super(message);
		this.code = code;
	}
}

/**
 * A JWT verified by {@link verifyJwt}.
 * @template P - The payload type
 * @template H - The header type
 */
export interface VerifiedJwt<P extends object = JwtPayload, H extends object = JwtHeader> {
	/** The JOSE header. */
	readonly header: H;
	/** The claims. */
	readonly payload: P;
}

/**
 * Options accepted by {@link verifyJwt}.
 */
export interface VerifyJwtOptions {
	/** The current time, as a `Date` or in milliseconds since the epoch. Defaults to `Date.now()`. */
	readonly now?: Date | number;
	/** Tolerated clock skew, in seconds, for `exp`, `nbf` and `maxAge`. Defaults to `0`. */
	readonly clockTolerance?: number;
	/** The accepted issuer(s): the `iss` claim must be one of them. */
	readonly issuer?: string | readonly string[];
	/** The accepted audience(s): the `aud` claim (a string or an array) must hold at least one of them. */
	readonly audience?: string | readonly string[];
	/** The expected `sub` claim. */
	readonly subject?: string;
	/** The greatest accepted age, in whole seconds: the token must have an `iat` claim at most this long ago. */
	readonly maxAge?: number;
	/** The expected `typ` header parameter (such as `'at+jwt'`), compared ignoring case and an `application/` prefix. */
	readonly typ?: string;
}

/**
 * Reads an issuer or audience option of {@link verifyJwt}.
 * @param {string} name - Name of the option
 * @param {unknown} value - Its value (`undefined` when absent)
 * @returns {readonly string[] | undefined} The accepted values, `undefined` when the option is absent
 * @throws {TypeError} when `value` is neither a string nor an array of strings
 * @throws {RangeError} when `value` is an empty array
 */
function stringsOption(name: string, value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return [value];
	let valid = Array.isArray(value);
	// Every index, holes included: `every` would skip a hole, which `includes` then reads as `undefined`, accepting a token without the claim.
	for (let i = 0; valid && i < (value as unknown[]).length; i++) valid = Object.hasOwn(value as unknown[], i) && typeof (value as unknown[])[i] === 'string';
	if (!valid) throw new TypeError(`verifyJwt: \`${name}\` must be a string or an array of strings, got ${describe(value)}`);
	if ((value as unknown[]).length === 0) throw new RangeError(`verifyJwt: \`${name}\` must not be an empty array`);
	return value as string[];
}

/**
 * Throws the error of {@link verifyJwt} for a rejected token.
 * @param {JwtVerificationErrorCode} code - Why the token is rejected
 * @param {string} problem - The message, after the function name
 * @returns {never} Never returns
 * @throws {JwtVerificationError} always
 */
function reject(code: JwtVerificationErrorCode, problem: string): never {
	throw new JwtVerificationError(`verifyJwt: ${problem}`, code);
}

/**
 * Normalizes a `typ` value for comparison (RFC 7515 §4.1.9: media types are case-insensitive, and `application/` may be left out).
 * @param {string} typ - The value
 * @returns {string} It in lowercase, without an `application/` prefix
 */
function normalizeTyp(typ: string): string {
	const lower = typ.toLowerCase();
	return lower.startsWith('application/') ? lower.slice(12) : lower;
}

/**
 * Verifies a JWT signed with HMAC-SHA256 (`alg: 'HS256'`), synchronously, and returns its header and claims; anything else throws a
 * {@link JwtVerificationError} whose `code` tells why. The checks, in order:
 *
 * 1. **Structure**, as strictly as {@link decodeJwt}: three canonical base64url parts without padding; a JSON-object header.
 * 2. **Algorithm**: the `alg` header parameter must be exactly `'HS256'`. Anything else is rejected BEFORE the signature is looked at,
 *    which rules out the classic attacks: `alg: 'none'` (an unsigned token) and algorithm confusion (an `RS256` token "signed" with a
 *    public key used as an HMAC secret). A `crit` parameter is rejected (no extension is supported); with the `typ` option, the `typ`
 *    parameter must match it. Without it, `typ` may be anything or absent.
 * 3. **Signature**: the HMAC-SHA256 of `header.payload` under `secret`, compared in constant time (see {@link timingSafeEqual}).
 * 4. **Claims**, only once the token is authentic (the payload is parsed only then, without prototype-pollution keys): `exp`, `nbf` and
 *    `iat` must be finite numbers when present; the token is expired from its `exp` time on (`now >= exp + clockTolerance`, as in
 *    {@link isJwtExpired} and jose) and not valid before `nbf - clockTolerance`; with `maxAge`, `iat` must be present, not in the future
 *    and at most `maxAge + clockTolerance` whole seconds ago (the age is truncated to the second, like `iat` and as in jose); `issuer`,
 *    `audience` and `subject`, when given, must match `iss`, `aud` (a string or an array of strings, matching when one of them is
 *    accepted) and `sub`.
 *
 * A token without an `exp` claim never expires: issue tokens with `expiresIn` (see {@link signJwt}), or require a recent `iat` with
 * `maxAge`. Error messages never quote the token, its claims or the secret.
 * @template P - The payload type (not validated beyond the registered claims checked above)
 * @template H - The header type
 * @param {string} token - The JWT
 * @param {string | BytesInput} secret - The HMAC key it was signed with, or a string to use as UTF-8 (not empty)
 * @param {VerifyJwtOptions} [options={}] - `now` (default `Date.now()`), `clockTolerance` (default `0`, in seconds), `issuer`,
 * `audience`, `subject`, `maxAge` (in seconds) and `typ`
 * @returns {VerifiedJwt<P, H>} The header and the claims
 * @throws {TypeError} when `token` is not a string, `secret` is neither a string nor binary data, `options` is not an object, or an option
 * has the wrong type
 * @throws {RangeError} when `secret` is empty, `now` is an invalid date or not finite, `clockTolerance` or `maxAge` is negative or not
 * finite, or `issuer` or `audience` is an empty array
 * @throws {JwtVerificationError} when the token is malformed, not signed with `secret`, or its claims are not acceptable
 * @example
 * const token = signJwt({ sub: 'ada', aud: 'api' }, 'secret', { expiresIn: 60, now: 1_700_000_000_000 });
 * verifyJwt(token, 'secret', { audience: 'api', now: 1_700_000_030_000 }).payload; // => { sub: 'ada', aud: 'api', iat: 1700000000, exp: 1700000060 }
 * verifyJwt(token, 'wrong', { now: 1_700_000_030_000 }); // throws JwtVerificationError // code 'invalid_signature'
 * verifyJwt(token, 'secret', { now: 1_700_000_060_000 }); // throws JwtVerificationError // code 'expired'
 * verifyJwt(token, 'secret', { now: 1_700_000_065_000, clockTolerance: 10 }).payload.sub; // => 'ada'
 * verifyJwt('eyJhbGciOiJub25lIn0.e30.', 'secret'); // throws JwtVerificationError // code 'invalid_algorithm'
 */
export function verifyJwt<P extends object = JwtPayload, H extends object = JwtHeader>(
	token: string,
	secret: string | BytesInput,
	options?: VerifyJwtOptions
): VerifiedJwt<P, H> {
	const [nowOption, tolerance = 0, issuerOption, audienceOption, subject, maxAge, typ] = readOptions('verifyJwt', options, [
		'now',
		'clockTolerance',
		'issuer',
		'audience',
		'subject',
		'maxAge',
		'typ'
	]);
	const now = jwtNow('verifyJwt', nowOption);
	jwtSeconds('verifyJwt', 'clockTolerance', tolerance, true);
	const issuers = stringsOption('issuer', issuerOption);
	const audiences = stringsOption('audience', audienceOption);
	if (subject !== undefined && typeof subject !== 'string') throw new TypeError(`verifyJwt: \`subject\` must be a string, got ${describe(subject)}`);
	if (maxAge !== undefined) jwtSeconds('verifyJwt', 'maxAge', maxAge, true);
	if (typ !== undefined && typeof typ !== 'string') throw new TypeError(`verifyJwt: \`typ\` must be a string, got ${describe(typ)}`);
	const key = jwtSecret('verifyJwt', secret);
	if (typeof token !== 'string') throw new TypeError(`verifyJwt: \`token\` must be a string, got ${describe(token)}`);

	let second: number;
	let header: Record<string, unknown>;
	let payloadBytes: Uint8Array;
	let signature: Uint8Array;
	try {
		let first: number;
		[first, second] = jwtDots('verifyJwt', token);
		header = jwtObject('verifyJwt', token.slice(0, first), 'header');
		payloadBytes = jwtBytes('verifyJwt', token.slice(first + 1, second), 'payload');
		signature = jwtBytes('verifyJwt', token.slice(second + 1), 'signature');
	} catch (error) {
		// The message of the SyntaxError, not its cause, which may quote the token.
		throw new JwtVerificationError((error as Error).message, 'malformed');
	}
	if (ownValue(header, 'alg') !== 'HS256') reject('invalid_algorithm', "the `alg` header parameter of `token` must be 'HS256'");
	if (Object.hasOwn(header, 'crit')) reject('invalid_header', 'the header of `token` must not have a `crit` parameter (no extension is supported)');
	const tokenTyp = ownValue(header, 'typ');
	if (typ !== undefined && !(typeof tokenTyp === 'string' && normalizeTyp(tokenTyp) === normalizeTyp(typ))) {
		reject('invalid_header', `the \`typ\` header parameter of \`token\` must be ${JSON.stringify(typ)}`);
	}
	if (!timingSafeEqual(hmacSha256(key, token.slice(0, second)), signature)) reject('invalid_signature', 'the signature of `token` must match `secret`');

	let payload: Record<string, unknown>;
	try {
		payload = jwtJson('verifyJwt', payloadBytes, 'payload');
	} catch (error) {
		throw new JwtVerificationError((error as Error).message, 'malformed');
	}
	const exp = ownValue(payload, 'exp');
	const nbf = ownValue(payload, 'nbf');
	const iat = ownValue(payload, 'iat');
	for (const [claim, value] of [
		['exp', exp],
		['nbf', nbf],
		['iat', iat]
	] as const) {
		if (value !== undefined && !Number.isFinite(value)) reject('invalid_claim', `the \`${claim}\` claim of \`token\` must be a finite number of seconds since the epoch`);
	}
	// Compared in seconds, like `isJwtExpired`: a claim's time in milliseconds may overflow to ±Infinity, which still compares correctly.
	// An absent claim makes the difference NaN, and every comparison with NaN is false.
	if ((now - (exp as number) * 1000) / 1000 >= (tolerance as number)) reject('expired', '`token` has expired (its `exp` time has passed)');
	if (((nbf as number) * 1000 - now) / 1000 > (tolerance as number)) reject('not_before', '`token` is not valid yet (its `nbf` time has not come)');
	if (maxAge !== undefined) {
		if (iat === undefined) reject('invalid_claim', 'the `iat` claim of `token` must be present to check `maxAge`');
		if ((now - (iat as number) * 1000) / 1000 < -(tolerance as number)) reject('invalid_claim', 'the `iat` claim of `token` must not be in the future');
		// The age in whole seconds, like jose: `iat` is itself truncated to the second, so a token issued 60.9 seconds ago may be 60 seconds old.
		if (Math.floor(now / 1000) - (iat as number) - (tolerance as number) > maxAge) {
			reject('too_old', '`token` must have been issued at most `maxAge` seconds ago (its `iat` claim)');
		}
	}
	const iss = ownValue(payload, 'iss');
	// The accepted values are strings: a claim of any other type is not among them.
	if (issuers !== undefined && !issuers.includes(iss as string)) reject('invalid_issuer', 'the `iss` claim of `token` must be an accepted `issuer`');
	if (subject !== undefined && ownValue(payload, 'sub') !== subject) reject('invalid_subject', 'the `sub` claim of `token` must be `subject`');
	if (audiences !== undefined) {
		const aud = ownValue(payload, 'aud');
		const values: unknown[] = Array.isArray(aud) ? aud : [aud];
		// A set: `includes` for each value took time in the product of the two lengths.
		const accepted = new Set<unknown>(audiences);
		if (
			!values.some(function (value: unknown): boolean {
				return accepted.has(value);
			})
		) {
			reject('invalid_audience', 'the `aud` claim of `token` must hold an accepted `audience`');
		}
	}
	return { header: header as H, payload: payload as P };
}

/**
 * Options accepted by {@link parseCsv}.
 */
export interface ParseCsvOptions {
	/** The field separator: a single character other than `"`, `\r` and `\n`. Defaults to `','`. */
	readonly delimiter?: string;
	/**
	 * Read the first row as column names and return records instead of arrays; a field missing from a short row is absent from its
	 * record. Defaults to `false`.
	 */
	readonly header?: boolean;
	/** Throw when a row has a different number of fields than the first row (with `header`, every record then has every column). Defaults to `false`. */
	readonly strict?: boolean;
	/** Skip lines holding no character at all (a line holding `""` is not empty). Defaults to `false`: such a line is a row of one empty field. */
	readonly skipEmptyLines?: boolean;
}

/**
 * A cell accepted by {@link toCsv}: numbers, bigints and booleans are written with `String()`, `null` and `undefined` as empty fields.
 */
export type CsvValue = string | number | bigint | boolean | null | undefined;

/**
 * Options accepted by {@link toCsv}.
 */
export interface ToCsvOptions {
	/** The field separator: a single character other than `"`, `\r` and `\n`. Defaults to `','`. */
	readonly delimiter?: string;
	/** The line break between rows: `'\r\n'` (RFC 4180) or `'\n'`. No line break follows the last row. Defaults to `'\r\n'`. */
	readonly newline?: '\r\n' | '\n';
	/** Quote only the fields that need it (`'needed'`) or every field (`'all'`). Defaults to `'needed'`. */
	readonly quote?: 'needed' | 'all';
	/**
	 * The column names. For records: the keys written, in this order (defaults to every own enumerable key, in the order first seen).
	 * For arrays: the header row. Defaults to none for arrays.
	 */
	readonly columns?: readonly string[];
	/** Write the column names as the first row (when there are any). Defaults to `true`. */
	readonly header?: boolean;
	/**
	 * Defuse CSV (formula) injection (OWASP): prefix with `'` every string cell starting with a tab or a carriage return, or whose first
	 * character after any leading white space is `=`, `+`, `-`, `@` or their full-width forms `＝`, `＋`, `－`, `＠`, so that spreadsheet
	 * software shows it as text instead of running it as a formula; and quote every field, as `quote: 'all'` does. Defaults to `false`,
	 * which keeps the data exact (`parseCsv` reads back what was written): turn it on for files meant to be opened in Excel, LibreOffice
	 * or Google Sheets.
	 */
	readonly formulaEscape?: boolean;
}

/**
 * Validates the `delimiter` option of the CSV functions.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {unknown} delimiter - The option (`undefined` when absent)
 * @returns {number} The delimiter's character code (`,` by default)
 * @throws {TypeError} when `delimiter` is not a string
 * @throws {RangeError} when `delimiter` is not a single character other than `"`, `\r` and `\n`
 */
function delimiterOf(caller: string, delimiter: unknown): number {
	if (delimiter === undefined) return 44;
	if (typeof delimiter !== 'string') throw new TypeError(`${caller}: \`delimiter\` must be a string, got ${describe(delimiter)}`);
	const code = delimiter.charCodeAt(0);
	if (delimiter.length !== 1 || code === 34 || code === 10 || code === 13) {
		throw new RangeError(`${caller}: \`delimiter\` must be a single character other than '"', '\\r' and '\\n', got ${JSON.stringify(delimiter)}`);
	}
	return code;
}

/**
 * Describes a position of CSV text for an error message (lines end with CRLF, LF or CR; columns count UTF-16 code units from 1).
 * @param {string} text - The CSV text
 * @param {number} index - The position
 * @returns {string} `'line L, column C'`
 */
function csvPosition(text: string, index: number): string {
	let line = 1;
	// A byte order mark is not a column.
	let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	for (let i = 0; i < index; i++) {
		const code = text.charCodeAt(i);
		if (code === 10 || (code === 13 && text.charCodeAt(i + 1) !== 10)) {
			line++;
			start = i + 1;
		}
	}
	return `line ${line}, column ${index - start + 1}`;
}

/**
 * Parses CSV text (RFC 4180) into rows of fields, or with `header`, into records keyed by the first row.
 *
 * - Fields are separated by `delimiter`, rows by CRLF, LF or CR (mixed freely). A line break after the last row does not start
 *   another one; an empty line inside the text is a row with one empty field (unless `skipEmptyLines`).
 * - A field starting with `"` is quoted: it runs to the next lone `"`, may hold delimiters and line breaks (kept as written), and `""`
 *   inside it stands for one `"`. A `"` inside an unquoted field is kept as is; anything but a delimiter or a line break after a closing
 *   quote, or an unclosed quote, throws a `SyntaxError` with its line and column.
 * - A leading byte order mark (U+FEFF) is ignored. Fields are not trimmed nor converted: every value is a string.
 * - Ragged rows are returned as they are, unless `strict` is set: then every row must have as many fields as the first one.
 * - With `header`, every record has a `null` prototype (a `__proto__` or `constructor` column is an ordinary own key) and holds the
 *   fields of its row, keyed by column. A row shorter than the header leaves its missing trailing fields ABSENT from its record (not
 *   `''`), so that the records take memory in proportion to the text, not to columns × rows; fields past the last column are dropped.
 *   Use `strict` to reject such rows instead: then every record has every column. An empty column name is the key `''`; a repeated one
 *   throws a `SyntaxError`, since one of the columns would be lost.
 *
 * Runs in linear time, and the result takes memory in proportion to the text. `toCsv` writes text that this function reads back exactly.
 * @template K - The column names, with `header`
 * @param {string} text - The CSV text
 * @param {ParseCsvOptions} [options={}] - `delimiter` (default `','`), `header` (default `false`), `strict` (default `false`) and
 * `skipEmptyLines` (default `false`)
 * @returns {string[][] | Partial<Record<K, string>>[]} The rows, or with `header` the records (with every column, `Record<K, string>[]`,
 * when `strict` is also set)
 * @throws {TypeError} when `text` is not a string, `options` is not an object, or an option has the wrong type
 * @throws {RangeError} when `delimiter` is not a single character other than `"`, `\r` and `\n`
 * @throws {SyntaxError} when a quote is unclosed or followed by other text, a header name repeats, or with `strict`, a row is ragged
 * @example
 * parseCsv('a,b\r\n1,"x, ""y"""\n'); // => [['a', 'b'], ['1', 'x, "y"']]
 * parseCsv('name;age\nAda;36', { delimiter: ';', header: true }); // => [{ name: 'Ada', age: '36' }]
 * parseCsv('name,age\nAda\nAlan,41,x', { header: true }); // => [{ name: 'Ada' }, { name: 'Alan', age: '41' }]
 * parseCsv('"multi\nline",2'); // => [['multi\nline', '2']]
 * parseCsv('a,b\n1', { strict: true }); // throws SyntaxError
 * parseCsv('"open'); // throws SyntaxError
 */
export function parseCsv(text: string, options?: ParseCsvOptions & { readonly header?: false }): string[][];
/**
 * Parses CSV text into records keyed by its first row, rejecting ragged rows, so that every record has every column (see the first
 * overload).
 * @template K - The column names
 * @param {string} text - The CSV text
 * @param {ParseCsvOptions} options - With `header: true` and `strict: true`
 * @returns {Record<K, string>[]} The records, with a `null` prototype
 */
export function parseCsv<K extends string = string>(text: string, options: ParseCsvOptions & { readonly header: true; readonly strict: true }): Record<K, string>[];
/**
 * Parses CSV text into records keyed by its first row; a field missing from a short row is absent from its record (see the first overload).
 * @template K - The column names
 * @param {string} text - The CSV text
 * @param {ParseCsvOptions} options - With `header: true`
 * @returns {Partial<Record<K, string>>[]} The records, with a `null` prototype
 */
export function parseCsv<K extends string = string>(text: string, options: ParseCsvOptions & { readonly header: true }): Partial<Record<K, string>>[];
/**
 * Parses CSV text into rows or records (see the first overload).
 * @param {string} text - The CSV text
 * @param {ParseCsvOptions} [options={}] - The options
 * @returns {string[][] | Partial<Record<string, string>>[]} The rows, or with `header` the records
 */
export function parseCsv(text: string, options?: ParseCsvOptions): string[][] | Partial<Record<string, string>>[];
/**
 * Implementation of the overloads above.
 * @param {string} text - The CSV text
 * @param {ParseCsvOptions} [options={}] - The options
 * @returns {string[][] | Partial<Record<string, string>>[]} The rows or records
 */
export function parseCsv(text: string, options?: ParseCsvOptions): string[][] | Partial<Record<string, string>>[] {
	const [delimiterOption, headerOption, strictOption, skipOption] = readOptions('parseCsv', options, ['delimiter', 'header', 'strict', 'skipEmptyLines']);
	const delimiter = delimiterOf('parseCsv', delimiterOption);
	const header = booleanOption('parseCsv', 'header', headerOption, false);
	const strict = booleanOption('parseCsv', 'strict', strictOption, false);
	const skipEmptyLines = booleanOption('parseCsv', 'skipEmptyLines', skipOption, false);
	if (typeof text !== 'string') throw new TypeError(`parseCsv: \`text\` must be a string, got ${describe(text)}`);

	const rows: string[][] = [];
	const length = text.length;
	let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	// The fields of the current row, `row[0]` to `row[count - 1]`, copied into an array of their exact size at the end of the row: an
	// array grown by `push` reserves room for 17 fields, about 150 bytes, which is much more than the text of a short row.
	const row: string[] = [];
	let count = 0;
	let rowStart = i;
	while (i < length) {
		let field: string;
		if (text.charCodeAt(i) === 34) {
			// A quoted field runs to the next lone `"`; `""` stands for one `"`.
			const open = i;
			field = '';
			for (;;) {
				const close = text.indexOf('"', i + 1);
				if (close === -1) throw new SyntaxError(`parseCsv: \`text\` must close every quoted field, got one opened at ${csvPosition(text, open)}`);
				field += text.slice(i + 1, close);
				i = close + 1;
				if (text.charCodeAt(i) !== 34) break;
				field += '"';
			}
			const code = text.charCodeAt(i);
			if (i < length && code !== delimiter && code !== 10 && code !== 13) {
				throw new SyntaxError(`parseCsv: \`text\` must have a delimiter or a line break after a closing quote, got ${quoteAt(text, i)} at ${csvPosition(text, i)}`);
			}
		} else {
			const start = i;
			for (let code = text.charCodeAt(i); i < length && code !== delimiter && code !== 10 && code !== 13; code = text.charCodeAt(i)) i++;
			field = text.slice(start, i);
		}
		row[count++] = field;
		const code = text.charCodeAt(i);
		if (code === delimiter) {
			i++;
			// A delimiter ending the text is followed by one more, empty, field.
			if (i === length) row[count++] = '';
			else continue;
		}
		// The end of the row: a line break, or the end of the text. An empty line has its line break at `rowStart`.
		if (!(skipEmptyLines && i === rowStart)) {
			if (strict && rows.length > 0 && count !== rows[0].length) {
				throw new SyntaxError(
					`parseCsv: \`text\` must have ${rows[0].length} fields in every row, like the first one, got ${count} in row ${rows.length + 1} (${csvPosition(text, rowStart)})`
				);
			}
			rows.push(row.slice(0, count));
		}
		i += code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
		count = 0;
		rowStart = i;
	}
	return header ? csvRecords(rows) : rows;
}

/**
 * Turns parsed CSV rows into records keyed by the first row (see {@link parseCsv}). A record holds only the fields of its row, so the
 * records take as much memory as the rows, whatever the number of columns.
 * @param {string[][]} rows - The rows, the first one holding the column names
 * @returns {Partial<Record<string, string>>[]} The records, with a `null` prototype
 * @throws {SyntaxError} when a column name repeats
 */
function csvRecords(rows: string[][]): Partial<Record<string, string>>[] {
	const names = rows.length > 0 ? rows[0] : [];
	const seen = new Set<string>();
	for (let column = 0; column < names.length; column++) {
		if (seen.has(names[column])) {
			throw new SyntaxError(`parseCsv: the header of \`text\` must not repeat a column name, got ${JSON.stringify(names[column])} again in column ${column + 1}`);
		}
		seen.add(names[column]);
	}
	const records: Partial<Record<string, string>>[] = [];
	for (let index = 1; index < rows.length; index++) {
		const row = rows[index];
		const record = Object.create(null) as Record<string, string>;
		const fields = Math.min(row.length, names.length);
		for (let column = 0; column < fields; column++) record[names[column]] = row[column];
		records.push(record);
	}
	return records;
}

/**
 * The start of a cell that spreadsheet software may run as a formula: OWASP's CSV injection list (a tab or a carriage return, or `=`,
 * `+`, `-`, `@`), also after leading white space (any `\s`: spaces, no-break spaces, U+3000, the byte order mark…), which spreadsheets
 * skip, and in full-width form (`＝`, `＋`, `－`, `＠`), which some read as the ASCII sign.
 */
const FORMULA_START = /^[\t\r]|^\s*[=+\-@＝＋－＠]/;

/**
 * Holes of a row that {@link toCsv} reads index by index; past them, the row (which may be sparse) is walked through its own keys. A count
 * of holes, not of columns: listing the keys of a long dense row takes several times as long as reading its cells.
 */
const SPARSE_SCAN = 65536;

/**
 * Writes rows as CSV text (RFC 4180) that {@link parseCsv} reads back exactly: rows of cells, or records (objects) whose keys become
 * the columns.
 *
 * - A field is quoted only when it must be (it holds the delimiter, `"`, `\r` or `\n`, or starts with a byte order mark), or always
 *   with `quote: 'all'` or `formulaEscape`; a `"` inside it is doubled. A row of one empty field is written `""`, so that it is not an empty line,
 *   and so is an empty first field before a U+FEFF delimiter, so that the text does not start with a byte order mark.
 * - Strings are written as they are, numbers, bigints and booleans with `String()`, `null`, `undefined` and holes as empty fields; any other
 *   value (an object, a `Date`…) throws, so format it first.
 * - Records: only own properties are read. The columns are `columns`, or every own enumerable key in the order first seen; a missing
 *   key is an empty field. The column names are written as the first row unless `header` is `false`. With arrays, `columns` (when given)
 *   is the header row.
 * - Rows are separated by `newline` (CRLF by default), with none after the last one. A row with no cells is written as an empty line,
 *   which `parseCsv` reads as one empty field; as the last row, it is written `""` (one empty field), since a line break ending the text
 *   does not start a row.
 *
 * ⚠️ CSV injection: a cell such as `=HYPERLINK(...)` or `@SUM(...)` runs as a formula when the file is opened in a spreadsheet. When
 * the data comes from users and the file is meant for Excel, LibreOffice or Google Sheets, set `formulaEscape: true` (OWASP's advice),
 * which applies two rules:
 * - A string cell starting with a tab or a carriage return, or whose first character after any leading white space (spaces, tabs, line
 *   breaks, no-break spaces, U+3000, a byte order mark…) is `=`, `+`, `-`, `@` or a full-width `＝`, `＋`, `－`, `＠`, gets a leading
 *   `'`: spreadsheets skip such white space and read the full-width signs as ASCII ones, so `' =1+2'` is as dangerous as `'=1+2'`.
 * - Every field is quoted, as with `quote: 'all'`: the file may be opened in a spreadsheet whose locale uses another separator (`;` in
 *   much of Europe), where an unquoted `safe;=1+2` would be split into a second cell `=1+2` that the first rule never saw.
 *
 * It is off by default because it changes the data (`-5` written as a string reads back as `'-5`); number cells are never prefixed.
 * @param {ReadonlyArray<ReadonlyArray<CsvValue>>} rows - The rows: arrays of cells
 * @param {ToCsvOptions} [options={}] - `delimiter` (default `','`), `newline` (default `'\r\n'`), `quote` (default `'needed'`),
 * `columns`, `header` (default `true`) and `formulaEscape` (default `false`)
 * @returns {string} The CSV text
 * @throws {TypeError} when `rows` is not an array of arrays or of records, a cell has an unsupported type, `options` is not an object, or
 * an option has the wrong type
 * @throws {RangeError} when `delimiter`, `newline` or `quote` has an unsupported value
 * @example
 * toCsv([['a', 'b'], [1, 'x, "y"']]); // => 'a,b\r\n1,"x, ""y"""'
 * toCsv([{ name: 'Ada', age: 36 }, { name: 'Alan' }], { newline: '\n' }); // => 'name,age\nAda,36\nAlan,'
 * toCsv([[1, 2]], { columns: ['x', 'y'], delimiter: ';' }); // => 'x;y\r\n1;2'
 * toCsv([['=1+2', ' @x', 'safe;=1+2', -3]], { formulaEscape: true }); // => `"'=1+2","' @x","safe;=1+2","-3"`
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvValue>>, options?: ToCsvOptions): string;
/**
 * Writes records as CSV text, one column per key (see the first overload).
 * @template R - The record type
 * @param {ReadonlyArray<R>} rows - The records
 * @param {ToCsvOptions} [options={}] - The options; `columns` lists keys of the records
 * @returns {string} The CSV text
 */
export function toCsv<R extends { readonly [K in keyof R]: CsvValue }>(
	rows: ReadonlyArray<R>,
	options?: ToCsvOptions & { readonly columns?: ReadonlyArray<R extends unknown ? keyof R & string : never> }
): string;
/**
 * Implementation of the overloads above.
 * @param {ReadonlyArray<unknown>} rows - The rows or records
 * @param {ToCsvOptions} [options={}] - The options
 * @returns {string} The CSV text
 */
export function toCsv(rows: ReadonlyArray<unknown>, options?: ToCsvOptions): string {
	const [delimiterOption, newline = '\r\n', quote = 'needed', columns, headerOption, escapeOption] = readOptions('toCsv', options, [
		'delimiter',
		'newline',
		'quote',
		'columns',
		'header',
		'formulaEscape'
	]);
	const delimiter = delimiterOf('toCsv', delimiterOption);
	if (newline !== '\r\n' && newline !== '\n')
		throw new RangeError(`toCsv: \`newline\` must be '\\r\\n' or '\\n', got ${typeof newline === 'string' ? JSON.stringify(newline) : show(newline)}`);
	if (quote !== 'needed' && quote !== 'all') throw new RangeError(`toCsv: \`quote\` must be 'needed' or 'all', got ${show(quote)}`);
	if (columns !== undefined) {
		// Every index, holes included: `findIndex` would read a hole from a (possibly polluted) `Object.prototype`.
		let bad = Array.isArray(columns) ? -1 : -2;
		for (let i = 0; bad === -1 && i < (columns as unknown[]).length; i++) if (typeof ownItem(columns as unknown[], i) !== 'string') bad = i;
		if (bad !== -1) {
			throw new TypeError(
				`toCsv: \`columns\` must be an array of strings, got ${bad === -2 ? describe(columns) : `${describe(ownItem(columns as unknown[], bad))} at index ${bad}`}`
			);
		}
	}
	const header = booleanOption('toCsv', 'header', headerOption, true);
	const formulaEscape = booleanOption('toCsv', 'formulaEscape', escapeOption, false);
	// Escaping formulas quotes every field, so that no cell can be split off where a spreadsheet uses another separator.
	const quoteAll = quote === 'all' || formulaEscape;
	if (!Array.isArray(rows)) throw new TypeError(`toCsv: \`rows\` must be an array, got ${describe(rows)}`);

	// Rows are read as own elements: a hole is an invalid (`undefined`) row, never a row planted on a polluted `Object.prototype`.
	const records = rows.length > 0 ? !Array.isArray(ownItem(rows, 0)) : false;
	let names = columns as string[] | undefined;
	if (records && names === undefined) {
		const keys = new Set<string>();
		for (let index = 0; index < rows.length; index++) {
			const row = ownItem(rows, index);
			// Up to the first invalid row, which the loop below rejects: a huge sparse `rows` must not be walked to its end first.
			if (typeof row !== 'object' || row === null || Array.isArray(row)) break;
			for (const key of Object.keys(row)) keys.add(key);
		}
		names = [...keys];
	}

	const separator = String.fromCharCode(delimiter);
	// A hole, as `field` writes it: the fields of a run of holes are written at once in a long sparse row.
	const hole = quoteAll ? '""' : '';

	/**
	 * Writes one cell.
	 * @param {unknown} value - The cell
	 * @param {number} row - Index of its row in `rows`, for the error message (the header row, `-1`, holds only strings)
	 * @param {number} column - Index of its column, for the error message
	 * @returns {string} The field, quoted when needed
	 * @throws {TypeError} when `value` is not a {@link CsvValue}
	 */
	function field(value: unknown, row: number, column: number): string {
		let text: string;
		if (typeof value === 'string') text = formulaEscape && FORMULA_START.test(value) ? `'${value}` : value;
		else if (value === null || value === undefined) text = '';
		else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') text = String(value);
		else {
			// The position (`rows[1][2]`, `rows[0]["name"]`) is only spelled out here: building it for every cell made `toCsv` 1.4 times as slow.
			const at = `rows[${row}][${records ? JSON.stringify((names as string[])[column]) : column}]`;
			throw new TypeError(`toCsv: \`${at}\` must be a string, number, bigint, boolean, null or undefined, got ${describe(value)}`);
		}
		let needed = quoteAll || text.charCodeAt(0) === 0xfeff;
		for (let i = 0; !needed && i < text.length; i++) {
			const code = text.charCodeAt(i);
			needed = code === delimiter || code === 34 || code === 10 || code === 13;
		}
		return needed ? `"${text.replaceAll('"', '""')}"` : text;
	}

	/**
	 * Writes one row.
	 * @param {ReadonlyArray<unknown>} cells - The cells
	 * @param {number} row - Index of the row in `rows` (`-1` for the header row), for error messages
	 * @returns {string} The line, without its line break
	 */
	function line(cells: ReadonlyArray<unknown>, row: number): string {
		const length = cells.length;
		const fields = new Array<string>(Math.min(length, SPARSE_SCAN));
		let column = 0;
		let holes = 0;
		for (; column < length; column++) {
			// A hole is an empty field, never a value inherited from a polluted `Array.prototype` (which `map` would read).
			const own = Object.hasOwn(cells, column);
			if (!own && ++holes > SPARSE_SCAN) break;
			fields[column] = field(own ? cells[column] : undefined, row, column);
		}
		if (column < length) {
			// Many holes in a long row, which may be sparse (a length of 2 ** 32 - 1 with a few cells): its own cells are visited (indexes
			// come first, in ascending order), each after the separators of the holes before it, so that a run of holes is written at once.
			// One field at a time, a few hundred million holes ran the process out of memory before the text reached the engine's maximum
			// length, which now throws a RangeError at once. `column` is the first column not written yet.
			const indexes: number[] = [];
			for (const key of Object.getOwnPropertyNames(cells)) {
				const index = Number(key);
				// Only array indexes from `column` to the length read above: a Proxy may list keys past it.
				if (index >= column && index < length && String(index >>> 0) === key) indexes.push(index);
			}
			// A Proxy may also list them in any order (sorting indexes already in order takes linear time).
			indexes.sort(function (a: number, b: number): number {
				return a - b;
			});
			for (const index of indexes) {
				// Read as in the loop above, the cell could have been deleted by the getter of an earlier one.
				fields.push((hole + separator).repeat(index - column) + field(Object.hasOwn(cells, index) ? cells[index] : undefined, row, index));
				column = index + 1;
			}
		}
		return length === 1 && fields[0] === '' ? '""' : fields.join(separator) + (separator + hole).repeat(length - column);
	}

	const lines: string[] = [];
	if (names !== undefined && header) lines.push(line(names, -1));
	for (let index = 0; index < rows.length; index++) {
		const row = ownItem(rows, index) as Readonly<Record<string, unknown>> | ReadonlyArray<unknown>;
		const isArray = Array.isArray(row);
		if (records ? isArray || typeof row !== 'object' || row === null : !isArray) {
			throw new TypeError(
				`toCsv: \`rows[${index}]\` must be ${records ? 'a record (a non-array object)' : 'an array'} like the first row, got ${isArray ? 'array' : describe(row)}`
			);
		}
		const cells = records
			? (names as string[]).map(function (key: string): unknown {
					return Object.hasOwn(row, key) ? (row as Readonly<Record<string, unknown>>)[key] : undefined;
				})
			: (row as ReadonlyArray<unknown>);
		lines.push(line(cells, index));
	}
	// A line break ending the text does not start another row in `parseCsv` (nor, by RFC 4180, anywhere): a last row without cells, an
	// empty line there, would be lost. It is written as one empty field instead, which is how `parseCsv` reads an empty line elsewhere.
	if (lines.length > 0 && lines[lines.length - 1] === '') lines[lines.length - 1] = '""';
	// With the delimiter U+FEFF, a text starting with an empty field would start with the delimiter, which `parseCsv` (and spreadsheets)
	// would drop as a byte order mark, losing the field: it is quoted instead. (A field starting with U+FEFF is already quoted.)
	if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = `""${lines[0]}`;
	return lines.join(newline as string);
}
