/**
 * Binary-to-text encodings and hashing that work in every JavaScript runtime, without Node's `Buffer`.
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
 * - **Strict decoding.** Malformed text throws a `SyntaxError` naming the first offending character and its index, like
 *   `Uint8Array.fromBase64`. {@link fromBase64} rejects anything that {@link toBase64} could not have produced (white space, stray
 *   padding, non-zero unused bits), so base64 text can be compared as text: the same bytes always have the same spelling (up to optional
 *   padding). {@link fromHex} accepts both letter cases (digests from other tools are often uppercase), so compare hex after
 *   lowercasing it.
 * - **Native fast paths.** `Uint8Array.prototype.toBase64` / `toHex`, `Uint8Array.fromBase64` / `fromHex`, `TextEncoder` and
 *   `TextDecoder` are used when the runtime has them, only in ways that give results identical to the portable implementation, which is
 *   used everywhere else.
 */

import { describe, show } from '../utils/assert.js';

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
 * Options accepted by {@link fromBase64}; the same as the validate module's `isBase64`, which accepts exactly the strings that
 * {@link fromBase64} decodes.
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
 * @returns {Uint8Array} The bytes
 * @throws {TypeError} when `value` is neither a string nor binary data
 */
function dataOf(caller: string, value: unknown): Uint8Array {
	const view = typeof value === 'string' ? encodeUtf8(value) : viewOf(value);
	if (view === undefined) throw new TypeError(`${caller}: \`data\` must be a string, an ArrayBuffer or an ArrayBuffer view, got ${describe(value)}`);
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

/** Lazily built decoding tables (index `0` for base64, `1` for base64url): ASCII code → 6-bit value, `64` for invalid characters. */
const decodeTables: Uint8Array[] = [];

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
	const codes = new Uint16Array(CHUNK + 4);
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
 * `isBase64` accepts with the same options.
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
	if (end < length ? padding === 'forbidden' : remainder !== 0 && padding === 'required') {
		problem = end < length ? `must not be padded, got "=" at index ${end}` : `must be padded to a multiple of 4 characters, got ${length}`;
	} else if (end < length && length % 4 !== 0) {
		problem = `must be padded to a multiple of 4 characters, got ${length}`;
	} else if (remainder === 1) {
		problem = `must not end with a lone character (it would encode no whole byte), got ${end} data characters`;
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
	const codes = new Uint16Array(CHUNK + 2);
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
		const index = text.search(LONE_SURROGATE);
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

/** The `TextDecoder` constructor the decoders were created from, and the replacing (`0`) and fatal (`1`) decoders. */
let decoderClass: unknown;
let utf8Decoders: (TextDecoderLike | undefined)[] = [];

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
			utf8Decoders = [];
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
	const units = new Uint16Array(CHUNK + 2);
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

/** The message schedule (64 words), reused by every compression. */
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
	schedule = new Int32Array(64);
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
	const w = schedule;
	for (let i = 0; i < 16; i++, offset += 4) w[i] = (block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3];
	for (let i = 16; i < 64; i++) {
		const x = w[i - 15];
		const y = w[i - 2];
		const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
		const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
		w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
	}
	let a = state[0];
	let b = state[1];
	let c = state[2];
	let d = state[3];
	let e = state[4];
	let f = state[5];
	let g = state[6];
	let h = state[7];
	for (let i = 0; i < 64; i++) {
		const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + (g ^ (e & (f ^ g))) + k[i] + w[i]) | 0;
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
 * around 150–200 MB/s on current engines (a 32-byte input takes about half a microsecond): fine for content addressing, cache keys,
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
	const state = k.slice(64);
	const length = bytes.length;
	const full = length - (length % 64);
	for (let offset = 0; offset < full; offset += 64) compress(state, bytes, offset, k);

	// Padding: the leftover bytes, a 1 bit, zeros, and the message length in bits as a 64-bit big-endian integer (one or two blocks).
	const tail = new Uint8Array(length - full < 56 ? 64 : 128);
	for (let i = full; i < length; i++) tail[i - full] = bytes[i];
	tail[length - full] = 0x80;
	const end = tail.length;
	const high = Math.floor(length / 0x20000000);
	const low = (length << 3) >>> 0;
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
