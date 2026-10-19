import { assertInteger, assertNumber, describe, draw, readOption, show } from '../utils/assert.js';
import type { RandomGenerator } from '../utils/index.js';
import { isNumericString } from '../validate/index.js';

/**
 * Options accepted by {@link countSubString}.
 */
export interface CountSubStringOptions {
	/** Compare case-insensitively (both strings are lower-cased with `String.prototype.toLowerCase`, final `ς` read as `σ`). Defaults to `false`. */
	readonly ignoreCase?: boolean;
}

/**
 * Options accepted by {@link isPalindrome}.
 */
export interface IsPalindromeOptions {
	/** Compare case-insensitively (the string is lower-cased with `String.prototype.toLowerCase`, final `ς` read as `σ`). Defaults to `false`. */
	readonly ignoreCase?: boolean;
	/** Ignore every character that is not a Unicode letter, combining mark or number (spaces, punctuation, symbols...). Defaults to `false`. */
	readonly ignoreNonAlphanumeric?: boolean;
}

/**
 * Throws a `TypeError` unless `value` is a (primitive) string.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a string
 */
function assertString(caller: string, name: string, value: unknown): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${caller}: \`${name}\` must be a string, got ${describe(value)}`);
}

/**
 * Values accepted by {@link interpolate}: a (possibly nested) record whose leaves are stringified with `String()`.
 */
export type InterpolationValues = object;

/**
 * Lazily created grapheme segmenter (grapheme is the default granularity). `undefined` = not initialized yet, `null` = `Intl.Segmenter` is not available.
 */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * Returns the shared grapheme segmenter, creating it on first use.
 * @returns {Intl.Segmenter | null} The segmenter, or `null` when the runtime has no `Intl.Segmenter`
 */
function getGraphemeSegmenter(): Intl.Segmenter | null {
	if (graphemeSegmenter === undefined) {
		graphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
	}

	return graphemeSegmenter;
}

/**
 * Matches any code unit that may join a neighbour into a multi-code-unit grapheme cluster: `\r` (of `\r\n`), every surrogate, every BMP
 * code point whose grapheme-break property is Extend, ZWJ, SpacingMark, Prepend or a Hangul L/V/T jamo (combining marks, ZWJ/ZWNJ,
 * variation selectors, Indic vowel signs...), and, to keep the pattern short, the blocks around them. Below U+0300, in Latin Extended
 * Additional, Greek Extended and General Punctuation (U+1E00–U+206F, except ZWNJ and ZWJ) and in the CJK Unified Ideographs (U+4E00–U+9FFF),
 * every other code unit is a grapheme on its own: no grapheme-break rule joins two of them.
 */
const COMPLEX_TEXT = /[\u0300-\u1dff\u200c-\u200d\u2070-\u4dff\ua000-\uffff\r]/;

/** The {@link COMPLEX_TEXT} code units, as the body of a character class (a literal: a module-level call would defeat tree-shaking). */
const COMPLEX = '\\u0300-\\u1dff\\u200c-\\u200d\\u2070-\\u4dff\\ua000-\\uffff\\r';

/**
 * Tells whether every UTF-16 code unit of a string is a grapheme cluster on its own, so it can be processed without a segmenter.
 * @param {string} string - The string to inspect
 * @returns {boolean} `true` when the string has no code unit that {@link COMPLEX_TEXT} matches
 */
function isSimpleText(string: string): boolean {
	return !COMPLEX_TEXT.test(string);
}

/**
 * Tells whether a code unit is a grapheme cluster on its own, with a quick test that only accepts the code units below U+0300 other
 * than `\r` (see {@link COMPLEX_TEXT}).
 * @param {number} code - The code unit (`NaN` past the end of a string, which counts as simple)
 * @returns {boolean} `true` when the code unit is below U+0300 and not `\r`
 */
function isSimpleCode(code: number): boolean {
	return !(code >= 0x300 || code === 13);
}

/**
 * A region of text that may hold multi-code-unit grapheme clusters: runs of the code units {@link COMPLEX_TEXT} matches, the single other code units
 * between them, and the other code unit on each side (which a combining mark, `\n` after `\r`, a prepend character or an emoji ZWJ
 * sequence may join). Two consecutive other code units are always separated by a grapheme boundary (no grapheme-break rule joins them or
 * looks back across them), so the text outside these regions is one grapheme per code unit and every region can be segmented on its own.
 */
const COMPLEX_REGION = new RegExp(`[^${COMPLEX}]?(?:[${COMPLEX}]+[^${COMPLEX}]?)+`, 'g');

/** An emoji (`Extended_Pictographic`) with an optional skin tone modifier or emoji presentation selector. */
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\ufe0f)?`;

/**
 * One grapheme cluster of the common shapes that need no segmenter (a sticky match): an emoji ZWJ sequence of {@link PICTOGRAPH}s, a flag
 * (a pair of regional indicators), or a code unit that {@link COMPLEX_TEXT} does not match. Every `Extended_Pictographic` code point has the
 * grapheme-break property Other, so such a cluster ends before any code unit that does not continue it with a modifier, a selector or a
 * zero-width joiner (checked against `Intl.Segmenter` for all of them).
 */
const EMOJI_GRAPHEME = new RegExp(`${PICTOGRAPH}(?:\u200d${PICTOGRAPH})*|[\u{1F1E6}-\u{1F1FF}]{2}|(?![${COMPLEX}])[\0-\uffff]`, 'uy');

/**
 * Splits a region of {@link COMPLEX_REGION} into graphemes without the (slow) segmenter when it only holds the clusters {@link EMOJI_GRAPHEME}
 * matches. Any other shape (a combining mark, `\r\n`, a lone regional indicator, a keycap...) is left to the segmenter.
 * @param {string} region - The region
 * @param {string[]} graphemes - Receives the graphemes (left as it was when the region cannot be split this way)
 * @returns {boolean} Whether the region was split
 */
function pushEmojiGraphemes(region: string, graphemes: string[]): boolean {
	const length = graphemes.length;

	EMOJI_GRAPHEME.lastIndex = 0;

	while (EMOJI_GRAPHEME.lastIndex < region.length) {
		const match = EMOJI_GRAPHEME.exec(region);

		if (match === null) {
			graphemes.length = length;

			return false;
		}

		graphemes.push(match[0]);
	}

	return true;
}

/**
 * Splits a string into grapheme clusters (or code points when `Intl.Segmenter` is unavailable). Only the regions that may hold
 * multi-code-unit clusters (see {@link COMPLEX_REGION}) go through the (slow) segmenter, unless they only hold common emoji shapes (see
 * {@link EMOJI_GRAPHEME}); every other code unit is a grapheme on its own.
 * @param {string} string - The string to split
 * @param {number} [limit=Infinity] - Stop once more than `limit` graphemes have been collected (the ones returned are exact)
 * @returns {string[]} The graphemes of `string` (only the first ones, at least `limit + 1`, when it has more than `limit`)
 */
function splitGraphemes(string: string, limit: number = Infinity): string[] {
	if (isSimpleText(string)) return string.split('');

	const segmenter = getGraphemeSegmenter();
	const graphemes: string[] = [];
	let index = 0;

	COMPLEX_REGION.lastIndex = 0;

	for (;;) {
		const match = COMPLEX_REGION.exec(string);
		const end = match === null ? string.length : match.index;

		while (index < end && graphemes.length <= limit) graphemes.push(string[index++]);

		if (match === null || graphemes.length > limit) return graphemes;

		if (segmenter === null) {
			for (const codePoint of match[0]) graphemes.push(codePoint);
		} else if (!pushEmojiGraphemes(match[0], graphemes)) {
			for (const data of segmenter.segment(match[0])) {
				if (graphemes.length > limit) break;
				graphemes.push(data.segment);
			}
		}

		index = COMPLEX_REGION.lastIndex;
	}
}

/**
 * Returns the first grapheme cluster (or code point) of a string.
 * @param {string} string - The string to inspect
 * @returns {string} The first grapheme, or `''` for an empty string
 */
function firstGrapheme(string: string): string {
	return isSimpleCode(string.charCodeAt(1)) && isSimpleCode(string.charCodeAt(0)) ? string.charAt(0) : splitGraphemes(string, 0)[0];
}

/**
 * Lower-case Latin digraphs, whose Unicode title-case form is a dedicated letter (`ǆ` → `ǅ`) rather than their upper-case form (`Ǆ`):
 * the code point just before them. Only lower-case letters are needed: every caller lower-cases the word before title-casing its first letter.
 */
const TITLE_CASE_EXCEPTIONS = /[ǆǉǌǳ]/;

/**
 * Title-cases a single lower-case letter (one code point) for use at the start of a word. Digraphs use their dedicated title-case letter (`'ǆ'` → `'ǅ'`).
 * When the upper-case mapping expands to several code points (`'ß'` → `'SS'`, `'ﬁ'` → `'FI'`) only the first one stays upper-case
 * (`'Ss'`, `'Fi'`), approximating Unicode title case.
 * @param {string} letter - The letter to convert
 * @returns {string} The title-cased letter
 */
function titleCaseLetter(letter: string): string {
	if (letter.charCodeAt(0) < 0x80) return letter.toUpperCase();

	if (TITLE_CASE_EXCEPTIONS.test(letter)) return String.fromCharCode(letter.charCodeAt(0) - 1);

	const upper = letter.toUpperCase();
	const head = String.fromCodePoint(upper.codePointAt(0) as number);

	return head + upper.slice(head.length).toLowerCase();
}

/**
 * Lower-cases a word and title-cases its first code point.
 * @param {string} word - The word to convert
 * @returns {string} The converted word (`'hELLO'` → `'Hello'`)
 */
function upperFirstLowerRest(word: string): string {
	const lower = word.toLowerCase();

	// An ASCII first letter title-cases to its upper case (no exception, no expansion): skip the code point handling.
	if (lower.charCodeAt(0) < 0x80) return lower.charAt(0).toUpperCase() + lower.slice(1);

	const first = String.fromCodePoint(lower.codePointAt(0) as number);

	return titleCaseLetter(first) + lower.slice(first.length);
}

/**
 * A run of Unicode letters, combining marks and numbers. (The redundant ASCII alternative is a speed-up: V8 tests it before the large
 * Unicode property class, which makes the common characters about 1.5 times faster to match. The same trick is used below.)
 */
const WORD_CHUNK = /(?:[a-zA-Z0-9]|[\p{L}\p{M}\p{N}])+/gu;

/** Any lower-case letter. */
const HAS_LOWER_CASE = /\p{Ll}/u;

/** An upper-case or title-case letter after the first character: without one, a chunk has no word boundary. */
const INNER_UPPER = /.[\p{Lu}\p{Lt}]/u;

/** A run of capital units for {@link UNICODE_WORD}: each one after the first is not followed by a lower-case unit. */
const CAPITALS = String.raw`[\p{Lu}\p{Lt}]\p{M}*(?!\p{M})(?:[\p{Lu}\p{Lt}]\p{M}*(?![\p{M}\p{Ll}]))*`;

/**
 * The words of a chunk that has lower-case letters, as a single match. Characters are grouped into units (a base character and its
 * combining marks; the `(?!\p{M})` guards keep the engine from splitting a unit when it backtracks). A word ends before an upper/title-case
 * unit that follows a lower-case or number unit (`hello|World`, `version2|Beta`), or that follows another capital and precedes a lower-case
 * unit (`XML|Http`). So a word is: a run of capitals (each one after the first not followed by a lower-case unit), a lower-case/number unit,
 * or other letters/orphan marks optionally followed by such a run; then any number of lower-case/number units, or other letters
 * (`Lm`/`Lo`, after which a capital never starts a word) each optionally followed by a run of capitals.
 */
const UNICODE_WORD = new RegExp(
	String.raw`(?:${CAPITALS}|[\p{Ll}\p{N}]\p{M}*|(?:[\p{Lm}\p{Lo}]\p{M}*|\p{M}+)(?:${CAPITALS})?)(?:[\p{Ll}\p{N}]\p{M}*|[\p{Lm}\p{Lo}]\p{M}*(?:${CAPITALS})?)*`,
	'gu'
);

/** The apostrophes removed by the word splitter. */
const APOSTROPHES = /['’]/g;

/** Any non-ASCII code unit. */
const NON_ASCII = /[^\0-\x7f]/;

/**
 * The words of ASCII text (without apostrophes), with the same rules as the Unicode path of {@link splitWords}, as a single match:
 * a run of capitals and digits that is a whole run of letters and digits (`HTTP2`, `A0B1`), the capitals before the last one of a run
 * followed by a lower-case letter (`XML` in `XMLHttp`), capitals followed by lower-case letters and digits (`Http`, `version2`), or
 * trailing capitals (`DOG` in `lazyDOG`).
 */
const ASCII_WORD = /(?<![A-Za-z0-9])[A-Z0-9]+(?![A-Za-z0-9])|[A-Z]+(?=[A-Z][a-z])|[A-Z]*[a-z0-9]+|[A-Z]+/g;

/**
 * Splits an identifier or free text into words for the case-conversion helpers.
 *
 * Rules:
 * - Apostrophes (`'` and `’`) are removed (`"don't"` → `dont`).
 * - Any character that is not a Unicode letter, combining mark or number separates words (whitespace, `-`, `_`, `.`, other punctuation, symbols).
 * - A lower-case letter or digit followed by an upper-case letter starts a new word (`helloWorld` → `hello`, `World`; `version2Beta` → `version2`, `Beta`).
 * - Inside a run of upper-case letters, the last one starts a new word when followed by a lower-case letter (`XMLHttpRequest` → `XML`, `Http`, `Request`).
 * - Letter/digit transitions do NOT split (`version2` and `utf8` stay single words).
 * - A run without any lower-case letter is a single word (`HTTP2`, `A0B1`, the parts of `CONSTANT_CASE`), so constant case round-trips.
 *
 * ASCII text is split by a single plain regex match; other text is cut into chunks, and only the chunks with an inner capital and a
 * lower-case letter are split further.
 * @param {string} string - The text to tokenize
 * @returns {string[]} The words, in their original casing
 */
function splitWords(string: string): string[] {
	const text = string.replace(APOSTROPHES, '');

	if (!NON_ASCII.test(text)) return text.match(ASCII_WORD) ?? [];

	const words: string[] = [];

	for (const chunk of text.match(WORD_CHUNK) ?? []) {
		// Most chunks of natural text (`Crème`, `brûlée`) have no inner capital; a chunk without lower-case letters is kept whole too.
		if (INNER_UPPER.test(chunk) && HAS_LOWER_CASE.test(chunk)) {
			for (const word of chunk.match(UNICODE_WORD) as RegExpMatchArray) words.push(word);
		} else {
			words.push(chunk);
		}
	}

	return words;
}

/**
 * Reverses a string by user-perceived characters (grapheme clusters), so emoji, surrogate pairs and combining marks are kept intact.
 * Uses `Intl.Segmenter` when available and falls back to code points otherwise.
 * @param {string} string - The string to be reversed
 * @returns {string} The reversed string
 * @example
 * reverse('hello'); // => 'olleh'
 * reverse('a👍🏽b'); // => 'b👍🏽a'
 */
export function reverse(string: string): string {
	return splitGraphemes(string).reverse().join('');
}

/**
 * Upper-cases the first user-perceived character (grapheme cluster) of a string and leaves the rest untouched.
 * @param {string} string - The string to be capitalized
 * @returns {string} The capitalized string
 * @example
 * capitalize('hello'); // => 'Hello'
 * capitalize('élan'); // => 'Élan'
 */
export function capitalize(string: string): string {
	const first = firstGrapheme(string);

	return first.toUpperCase() + string.slice(first.length);
}

/**
 * Lower-cases the first user-perceived character (grapheme cluster) of a string and leaves the rest untouched.
 * @param {string} string - The string to be uncapitalized
 * @returns {string} The uncapitalized string
 * @example
 * uncapitalize('Hello World'); // => 'hello World'
 */
export function uncapitalize(string: string): string {
	const first = firstGrapheme(string);

	return first.toLowerCase() + string.slice(first.length);
}

/**
 * Extracts a substring from a string based on start and end indices (UTF-16 code units, like `String.prototype.substring`).
 * Indices are normalized like the native method (`NaN` → `0`, fractions truncated, clamped to `[0, string.length]`), but they are never swapped:
 * when the normalized `start` is not before the normalized `end`, an empty string is returned.
 * @param {string} string - The original string
 * @param {number} start - The start index of the substring
 * @param {number} end - The end index of the substring (exclusive)
 * @returns {string} The extracted substring
 * @example
 * substring('Hello, World!', 7, 12); // => 'World'
 * substring('Hello, World!', 12, 7); // => ''
 */
export function substring(string: string, start: number, end: number): string {
	// `slice` already maps `NaN` to `0`, truncates fractions and clamps to the length; only negative indices need clamping (to `0`, as
	// `substring` does, instead of counting from the end). Unlike `substring`, `slice` never swaps its arguments: `from >= to` gives `''`.
	return string.slice(Math.max(start, 0), Math.max(end, 0));
}

/**
 * Checks if a string contains a specified substring (case-sensitive).
 * @param {string} string - The original string
 * @param {string} subString - The substring to be searched for
 * @returns {boolean} Whether the string contains the specified substring
 * @example
 * includes('hello world', 'lo w'); // => true
 */
export function includes(string: string, subString: string): boolean {
	return string.includes(subString);
}

/**
 * Replaces all occurrences of a substring with a replacement string. Both values are treated literally:
 * the search value is never interpreted as a regular expression and `$&`, `$1`, `$$`... in the replacement are not expanded.
 * @param {string} string - The original string
 * @param {string} searchValue - The substring to be replaced; when empty the input is returned unchanged
 * @param {string} replaceValue - The replacement string
 * @returns {string} The string with all occurrences of the substring replaced
 * @example
 * replace('a.b.c', '.', '-'); // => 'a-b-c'
 * replace('price: 5', '5', '$&0'); // => 'price: $&0'
 */
export function replace(string: string, searchValue: string, replaceValue: string): string {
	if (!searchValue) return string;

	return string.replaceAll(searchValue, function (): string {
		return replaceValue;
	});
}

/**
 * Truncates a string to `length` user-perceived characters (grapheme clusters) and appends a suffix when it was longer.
 * The cut never splits a surrogate pair, an emoji sequence or a base character from its combining marks.
 * The suffix is not counted in `length`.
 * @param {string} string - The original string
 * @param {number} length - The maximum number of graphemes to keep (non-negative integer)
 * @param {string} [suffix='...'] - The suffix appended when the string is truncated
 * @returns {string} The truncated string, or the original one when it has at most `length` graphemes
 * @throws {RangeError} when `length` is negative or not an integer
 * @throws {TypeError} when `length` is not a number, or `suffix` is not a string
 * @example
 * truncate('hello world', 5); // => 'hello...'
 * truncate('hello world', 5, '!'); // => 'hello!'
 * truncate('👍🏽👍🏽👍🏽', 1); // => '👍🏽...'
 */
export function truncate(string: string, length: number, suffix: string = '...'): string {
	assertInteger('truncate', 'length', length);
	if (typeof suffix !== 'string') throw new TypeError(`truncate: \`suffix\` must be a string, got ${describe(suffix)}`);

	// A string never has more graphemes than UTF-16 code units.
	if (string.length <= length) return string;

	// When the first `length + 1` code units are graphemes on their own, the cut falls right after the first `length` of them.
	if (isSimpleText(string.slice(0, length + 1))) return string.slice(0, length) + suffix;

	const graphemes = splitGraphemes(string, length);

	return graphemes.length > length ? graphemes.slice(0, length).join('') + suffix : string;
}

/**
 * Repeats a string a specified number of times (wraps `String.prototype.repeat`).
 * @param {string} string - The original string
 * @param {number} times - How many times to repeat the string (non-negative integer)
 * @returns {string} The repeated string
 * @throws {RangeError} when `times` is negative, not an integer, `NaN` or infinite
 * @throws {TypeError} when `times` is not a number
 * @example
 * repeat('ab', 3); // => 'ababab'
 * repeat('ab', 0); // => ''
 */
export function repeat(string: string, times: number): string {
	assertInteger('repeat', 'times', times);

	return string.repeat(times);
}

/**
 * Removes whitespace (and line terminators) from both ends of a string.
 * @param {string} string - The string to be trimmed
 * @returns {string} The trimmed string
 * @example
 * trim('  hello world  '); // => 'hello world'
 */
export function trim(string: string): string {
	return string.trim();
}

/** The first letter of every whitespace-separated word that does not start with a digit (after any leading punctuation), with that punctuation. */
const TITLE_CASE_TARGET = /(?<!\S)([^\s\p{L}\p{N}]*)(\p{L})/gu;

/**
 * Lower-cases a string (a callback for `replace`).
 * @param {string} text - The text
 * @returns {string} The lower-cased text
 */
function toLowerCase(text: string): string {
	return text.toLowerCase();
}

/**
 * Converts a string to title case: in every whitespace-separated word the first letter is upper-cased and everything else is lower-cased.
 * Whitespace and punctuation are preserved exactly. Leading punctuation is skipped (`'(hello)'` → `'(Hello)'`),
 * but a word starting with a digit is left lower-case (`'1st'` stays `'1st'`). Works with Unicode letters.
 * @param {string} string - The string to be converted to title case
 * @returns {string} The string in title case
 * @example
 * toTitleCase('hello  WORLD'); // => 'Hello  World'
 * toTitleCase('élan vital, "quoted"'); // => 'Élan Vital, "Quoted"'
 */
export function toTitleCase(string: string): string {
	// Lower-casing the whole string equals lower-casing each word (only final sigma is context-sensitive, and white space is neither cased
	// nor case-ignorable), except across U+FEFF: white space for `\s` but case-ignorable, so per-word lower-casing is kept for it.
	const lower = string.includes('\ufeff') ? string.replace(/\S+/g, toLowerCase) : string.toLowerCase();

	return lower.replace(TITLE_CASE_TARGET, function (_match: string, prefix: string, letter: string): string {
		return prefix + titleCaseLetter(letter);
	});
}

/**
 * Converts a string to snake_case. Words are detected on whitespace, punctuation (`-`, `_`, `.`...), camelCase and acronym boundaries
 * (`XMLHttpRequest` → `xml_http_request`). Digits stay attached to the preceding letters (`version2` is one word). Apostrophes are dropped.
 * @param {string} string - The string to be converted to snake case
 * @returns {string} The string in snake case
 * @example
 * toSnakeCase('hello world'); // => 'hello_world'
 * toSnakeCase('helloWorld'); // => 'hello_world'
 * toSnakeCase('XMLHttpRequest'); // => 'xml_http_request'
 */
export function toSnakeCase(string: string): string {
	// Lower-casing the joined words equals lower-casing each word: `_` is neither cased nor case-ignorable, so it cannot change the
	// only context-sensitive mapping (final sigma).
	return splitWords(string).join('_').toLowerCase();
}

/**
 * Converts a string to kebab-case, using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to be converted to kebab case
 * @returns {string} The string in kebab case
 * @example
 * toKebabCase('Hello World'); // => 'hello-world'
 * toKebabCase('getHTTPResponse2Code'); // => 'get-http-response2-code'
 */
export function toKebabCase(string: string): string {
	return splitWords(string).join('-').toLowerCase();
}

/**
 * Converts a string to CONSTANT_CASE (SCREAMING_SNAKE_CASE), using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to be converted to constant case
 * @returns {string} The string in constant case
 * @example
 * toConstantCase('maxRetryCount'); // => 'MAX_RETRY_COUNT'
 */
export function toConstantCase(string: string): string {
	return splitWords(string).join('_').toUpperCase();
}

/**
 * Converts a string to camelCase, using the same word detection as {@link toSnakeCase}.
 * The first word is lower-cased; every following word is lower-cased with its first letter upper-cased.
 * Note that consecutive single-letter words are ambiguous once joined (`'a b c'` → `'aBC'`, which reads back as `a`, `bc`).
 * @param {string} string - The string to be converted to camel case
 * @returns {string} The string in camel case
 * @example
 * toCamelCase('hello world'); // => 'helloWorld'
 * toCamelCase('XMLHttpRequest'); // => 'xmlHttpRequest'
 */
export function toCamelCase(string: string): string {
	const words = splitWords(string);
	let result = words.length === 0 ? '' : words[0].toLowerCase();

	for (let index = 1; index < words.length; index++) result += upperFirstLowerRest(words[index]);

	return result;
}

/**
 * Converts a string to PascalCase, using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to be converted to Pascal case
 * @returns {string} The string in Pascal case
 * @example
 * toPascalCase('hello world'); // => 'HelloWorld'
 * toPascalCase('xml-http-request'); // => 'XmlHttpRequest'
 */
export function toPascalCase(string: string): string {
	const words = splitWords(string);
	let result = '';

	for (let index = 0; index < words.length; index++) result += upperFirstLowerRest(words[index]);

	return result;
}

/** The combining diacritical mark blocks (U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF, U+FE20–FE2F). */
const DIACRITICS = /[\u0300-\u036f]|[\u1ab0-\u1aff]|[\u1dc0-\u1dff]|[\u20d0-\u20ff]|[\ufe20-\ufe2f]/g;

/**
 * Removes diacritical marks (accents, umlauts, cedillas...) from a string: it is decomposed (NFD), the combining diacritical marks are stripped
 * and the result is recomposed (NFC). Only the combining diacritical mark blocks are removed, so scripts that use other combining marks are left intact.
 * @param {string} string - The string to clean
 * @returns {string} The string without diacritics
 * @throws {TypeError} when `string` is not a string
 * @example
 * removeDiacritics('Crème Brûlée à Málaga'); // => 'Creme Brulee a Malaga'
 */
export function removeDiacritics(string: string): string {
	assertString('removeDiacritics', 'string', string);
	// ASCII text has no decomposition and nothing to recompose.
	return NON_ASCII.test(string) ? string.normalize('NFD').replace(DIACRITICS, '').normalize('NFC') : string;
}

/**
 * Latin letters that have no Unicode decomposition, mapped to their usual ASCII transliteration for slugs.
 */
const SLUG_TRANSLITERATIONS: Readonly<Record<string, string>> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

/** Matches the letters of {@link SLUG_TRANSLITERATIONS}. */
const SLUG_LETTERS = /[ßæœøđðłþı]/g;

/**
 * Converts a string to a URL-friendly slug: compatibility-decomposed (NFKD), diacritics removed, a few common Latin letters transliterated
 * (`ß` → `ss`, `æ` → `ae`, `ø` → `o`...), lower-cased, every run of characters outside `[a-z0-9]` replaced by a single `-`,
 * and leading/trailing hyphens removed. The result always matches `/^([a-z0-9]+(-[a-z0-9]+)*)?$/`.
 * @param {string} string - The string to be converted to a slug
 * @returns {string} The URL-friendly slug (possibly empty)
 * @example
 * toSlug('Café Society'); // => 'cafe-society'
 * toSlug('  --Hello__World!!  '); // => 'hello-world'
 */
export function toSlug(string: string): string {
	// NFKD output is already fully decomposed, and recomposing (NFC) after stripping the diacritics never changes the slug: no character
	// with an ASCII letter or digit (or a transliterated letter) as its base composes with a mark outside the stripped blocks.
	// ASCII text has no decomposition and no letter to transliterate (lower-casing it never leaves ASCII).
	const folded = NON_ASCII.test(string)
		? string
				.normalize('NFKD')
				.replace(DIACRITICS, '')
				.toLowerCase()
				.replace(SLUG_LETTERS, function (letter: string): string {
					return SLUG_TRANSLITERATIONS[letter];
				})
		: string.toLowerCase();

	return folded.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Matches the values recognized as `true` by {@link toBoolean} (compared after trimming and lower-casing).
 */
const TRUTHY_STRING = /^(?:true|1|yes|y|on)$/;

/**
 * Converts a string to a boolean, which is handy for environment variables and query parameters.
 * The input is trimmed and compared case-insensitively; `'true'`, `'1'`, `'yes'`, `'y'` and `'on'` are `true`, everything else is `false`.
 * @param {string} string - The string to be converted to a boolean
 * @returns {boolean} The converted boolean
 * @example
 * toBoolean(' TRUE '); // => true
 * toBoolean('on'); // => true
 * toBoolean('false'); // => false
 * toBoolean('anything else'); // => false
 */
export function toBoolean(string: string): boolean {
	return TRUTHY_STRING.test(string.trim().toLowerCase());
}

/**
 * Converts a string holding a finite decimal number to that number, ignoring surrounding whitespace: the trimmed string must satisfy
 * `isNumericString` from the validate module (optional sign, digits with an optional fraction, optional exponent), so the result is
 * either a finite number or `NaN`, never `±Infinity`.
 *
 * Unlike `Number()`, blank strings give `NaN` (not `0`), and so do hex, octal and binary literals (`'0x1f'`), `'Infinity'`, numeric
 * separators and values that overflow (`'1e400'`): validation with `isNumericString` and conversion with `toNumber` always agree.
 * @param {string} string - The string to be converted to a number
 * @returns {number} The converted (finite) number, or `NaN` when the trimmed string is not a finite decimal number
 * @example
 * toNumber(' 42 '); // => 42
 * toNumber('-1.5e3'); // => -1500
 * toNumber('0x1f'); // => NaN
 * toNumber('Infinity'); // => NaN
 * toNumber(''); // => NaN
 * toNumber('12px'); // => NaN
 */
export function toNumber(string: string): number {
	const trimmed = string.trim();

	return isNumericString(trimmed) ? Number(trimmed) : NaN;
}

/**
 * Checks if a string starts with a given substring (case-sensitive).
 * @param {string} string - The string to be checked
 * @param {string} subString - The substring to search for
 * @returns {boolean} Whether the string starts with the substring
 * @example
 * startsWith('hello world', 'hello'); // => true
 */
export function startsWith(string: string, subString: string): boolean {
	return string.startsWith(subString);
}

/**
 * Checks if a string ends with a given substring (case-sensitive).
 * @param {string} string - The original string
 * @param {string} subString - The substring to be searched for
 * @returns {boolean} Whether the string ends with the specified substring
 * @example
 * endsWith('hello world', 'world'); // => true
 */
export function endsWith(string: string, subString: string): boolean {
	return string.endsWith(subString);
}

/**
 * Counts the non-overlapping, literal occurrences of a substring, scanning left to right (`countSubString('aaaa', 'aa')` is `2`).
 * The comparison is case-sensitive by default. With `ignoreCase`, both strings are lower-cased with the locale-independent
 * `String.prototype.toLowerCase` (and the final sigma `ς` read as `σ`, since `'Σ'` lower-cases to either) before counting; since a few characters change length when lower-cased (e.g. `'İ'`), the count is
 * computed on the lower-cased forms.
 * @param {string} string - The string to search in
 * @param {string} subString - The substring to search for; an empty substring yields `0`
 * @param {CountSubStringOptions} [options={}] - Matching options
 * @returns {number} The number of occurrences
 * @throws {TypeError} when `string` or `subString` is not a string
 * @example
 * countSubString('hello world, hello', 'hello'); // => 2
 * countSubString('Hello hello', 'hello'); // => 1
 * countSubString('Hello hello', 'hello', { ignoreCase: true }); // => 2
 * countSubString('a.b.c', '.'); // => 2
 */
export function countSubString(string: string, subString: string, options: CountSubStringOptions = {}): number {
	assertString('countSubString', 'string', string);
	// Checked before the search: a needle without a length (a number, an array) would never advance it.
	assertString('countSubString', 'subString', subString);
	if (subString === '') return 0;

	const ignoreCase = readOption(options, 'ignoreCase');
	const haystack = ignoreCase ? foldCase(string) : string;
	const needle = ignoreCase ? foldCase(subString) : subString;
	let count = 0;
	let index = haystack.indexOf(needle);

	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}

	return count;
}

/**
 * Checks if a string is empty or contains only whitespace characters.
 * @param {string} string - The string to be checked
 * @returns {boolean} Whether the string is blank
 * @example
 * isEmpty('   '); // => true
 * isEmpty(' a '); // => false
 */
export function isEmpty(string: string): boolean {
	return !string.trim().length;
}

/**
 * Extracts the words of a string. A word is a run of Unicode letters, combining marks and numbers, optionally joined by inner
 * apostrophes (`'` or `’`), so `"don't"` and `'café'` are single words. Everything else (whitespace, punctuation, symbols) separates words.
 * @param {string} string - The string to be split into words
 * @returns {string[]} The words in the string
 * @example
 * getWords("Don't stop, café 2024!"); // => ["Don't", 'stop', 'café', '2024']
 */
export function getWords(string: string): string[] {
	return string.match(/(?:[a-zA-Z0-9]|[\p{L}\p{M}\p{N}])+(?:['’](?:[a-zA-Z0-9]|[\p{L}\p{M}\p{N}])+)*/gu) ?? [];
}

/**
 * Checks if a string reads the same backwards (grapheme-aware, see {@link reverse}). Strict by default.
 * @param {string} string - The string to be checked
 * @param {IsPalindromeOptions} [options={}] - `ignoreCase` and `ignoreNonAlphanumeric` (both default to `false`)
 * @returns {boolean} Whether the string is a palindrome
 * @throws {TypeError} when `string` is not a string
 * @example
 * isPalindrome('racecar'); // => true
 * isPalindrome('Racecar'); // => false
 * isPalindrome('A man, a plan, a canal: Panama', { ignoreCase: true, ignoreNonAlphanumeric: true }); // => true
 */
export function isPalindrome(string: string, options: IsPalindromeOptions = {}): boolean {
	assertString('isPalindrome', 'string', string);
	let candidate = readOption(options, 'ignoreNonAlphanumeric') ? string.replace(/[^\p{L}\p{M}\p{N}]/gu, '') : string;

	if (readOption(options, 'ignoreCase')) candidate = foldCase(candidate);

	return candidate === reverse(candidate);
}

/**
 * Lower-cases a string for case-insensitive comparisons: `String.prototype.toLowerCase`, with the final sigma `ς` read as `σ` (`'Σ'`
 * lower-cases to `ς` at the end of a word and to `σ` elsewhere, so `'ΣΟΣ'` would not read the same backwards). The length is unchanged.
 * @param {string} string - The string
 * @returns {string} Its folded form
 * @example
 * foldCase('ΣΟΣ'); // => 'σοσ'
 */
function foldCase(string: string): string {
	return string.toLowerCase().replace(/ς/g, 'σ');
}

/**
 * The characters {@link escapeRegExp} escapes (as TC39 `RegExp.escape` does): a leading ASCII letter or digit, the syntax characters
 * and `/`, the other ASCII punctuators, white space, line terminators and lone surrogates. Without the `u` flag, so surrogates are seen
 * as code units.
 */
const REGEXP_ESCAPED = /^[0-9A-Za-z]|[$^\\.*+?()[\]{}|/,\-=<>#&!%:;@~'`"\s]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Escape sequences computed by {@link escapeRegExpChar}, by character (at most the ~2 200 code units {@link REGEXP_ESCAPED} matches). */
const regExpEscapes = new Map<string, string>();

/**
 * Escapes one character matched by {@link REGEXP_ESCAPED}: `\` before a syntax character or `/`, a control escape (`\t`, `\n`, `\v`,
 * `\f`, `\r`), else `\xHH` (code units up to `0xff`) or `\uHHHH`.
 * @param {string} char - The character (one UTF-16 code unit)
 * @returns {string} Its escape sequence
 */
function escapeRegExpChar(char: string): string {
	let escape = regExpEscapes.get(char);

	if (escape === undefined) {
		const control = '\t\n\v\f\r'.indexOf(char);
		const code = char.charCodeAt(0);

		escape = '^$\\.*+?()[]{}|/'.includes(char)
			? `\\${char}`
			: control >= 0
				? `\\${'tnvfr'[control]}`
				: code < 256
					? `\\x${code.toString(16).padStart(2, '0')}`
					: `\\u${code.toString(16).padStart(4, '0')}`;
		regExpEscapes.set(char, escape);
	}

	return escape;
}

/**
 * Escapes a string so that it matches itself literally in a regular expression, following the TC39 `RegExp.escape` algorithm (same
 * output as the native `RegExp.escape` where it exists):
 * - the syntax characters `^ $ \ . * + ? ( ) [ ] { } |` and `/` get a backslash;
 * - the other ASCII punctuators `` , - = < > # & ! % : ; @ ~ ' ` " ``, white space, line terminators and lone surrogates become `\xHH`,
 *   `\uHHHH` or a control escape (`\t`, `\n`...);
 * - a leading ASCII letter or digit becomes `\xHH`, so it cannot extend a preceding escape (`\1` + `0` is not `\10`, `\c` + `J` ...).
 *
 * The result is valid with and without the `u` and `v` flags, both outside and inside a character class (`[...]`, where `-`, `&&`
 * and `--` would otherwise form ranges or set operations), and in a regex literal (`/` is escaped).
 * @param {string} string - The string to escape
 * @returns {string} The escaped string
 * @example
 * escapeRegExp('1.5*(x)'); // => '\\x31\\.5\\*\\(x\\)'
 * escapeRegExp('a-z'); // => '\\x61\\x2dz'
 * new RegExp(escapeRegExp('a.b')).test('axb'); // => false
 * new RegExp('[' + escapeRegExp('a-z') + ']').test('m'); // => false
 */
export function escapeRegExp(string: string): string {
	return string.replace(REGEXP_ESCAPED, escapeRegExpChar);
}

/**
 * HTML entities produced by {@link escapeHtml}.
 */
const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Converts a value to the string that {@link escapeHtml} and {@link unescapeHtml} process.
 * @param {unknown} value - The value
 * @returns {string} `value` itself for strings, `''` for `null` and `undefined`, else `String(value)`
 */
function toText(value: unknown): string {
	return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Escapes the HTML-significant characters `&`, `<`, `>`, `"` and `'` so the string can be safely embedded in HTML text or quoted attributes
 * (not in unquoted attributes, URLs, `<script>` or `<style>`).
 *
 * The result is always a string: other values are converted with `String()` first (`null` and `undefined` become `''`), so that, for
 * example, a query parameter parsed as an array (`?q[]=<script>` gives `['<script>']`) is escaped too, instead of being returned as is
 * and stringified unescaped by a template.
 * @param {unknown} value - The string to escape (other values are converted to strings)
 * @returns {string} The escaped string
 * @throws {TypeError} when `value` cannot be converted to a string (e.g. an object with a throwing or missing `toString`)
 * @example
 * escapeHtml('<a href="x">Tom & Jerry\'s</a>'); // => '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;'
 * escapeHtml(['<script>']); // => '&lt;script&gt;'
 * escapeHtml(undefined); // => ''
 */
export function escapeHtml(value: unknown): string {
	const string = toText(value);
	// Testing first saves the (slower) replace call on text without special characters, the common case.
	return /[&<>"']/.test(string)
		? string.replace(/[&<>"']/g, function (char: string): string {
				return HTML_ESCAPES[char];
			})
		: string;
}

/**
 * Characters for the entities decoded by {@link unescapeHtml}, except the apostrophe: the other entities it decodes (`&#39;`, `&#x27;`,
 * `&#X27;` and `&apos;`) are all spellings of `'`.
 */
const HTML_UNESCAPES: Readonly<Record<string, string | undefined>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };

/**
 * Reverses {@link escapeHtml}: decodes `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&#x27;`, `&apos;` and `&amp;`. Decoding happens in a single pass,
 * so `&amp;` is effectively decoded last and `'&amp;lt;'` becomes `'&lt;'` (never `'<'`). Other entities are left untouched.
 * Like {@link escapeHtml}, it always returns a string: other values are converted with `String()` (`null` and `undefined` become `''`).
 * @param {unknown} value - The string to unescape (other values are converted to strings)
 * @returns {string} The unescaped string
 * @throws {TypeError} when `value` cannot be converted to a string
 * @example
 * unescapeHtml('&lt;b&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;'); // => "<b>Tom & Jerry's</b>"
 * unescapeHtml('&amp;lt;'); // => '&lt;'
 * unescapeHtml(null); // => ''
 */
export function unescapeHtml(value: unknown): string {
	const string = toText(value);
	if (!string.includes('&')) return string;

	return string.replace(/&(?:amp|lt|gt|quot|apos|#39|#[xX]27);/g, function (entity: string): string {
		// Own entries only: a polluted `Object.prototype` must not supply the decoding of `&#39;`.
		return (Object.hasOwn(HTML_UNESCAPES, entity) ? HTML_UNESCAPES[entity] : undefined) ?? "'";
	});
}

/**
 * Trims a string and collapses every run of whitespace (spaces, tabs, line breaks, non-breaking spaces...) into a single space.
 * @param {string} string - The string to normalize
 * @returns {string} The normalized string
 * @example
 * normalizeWhitespace('  hello \n\t world  '); // => 'hello world'
 */
export function normalizeWhitespace(string: string): string {
	return string.trim().replace(/\s+/g, ' ');
}

/**
 * Resolves a dot-separated path against a value, following own properties only.
 * @param {unknown} source - The root value
 * @param {string} path - The dot-separated path (`'user.name'`, `'items.0'`)
 * @returns {unknown} The value found at `path`, or `undefined` when any segment is missing
 */
function resolvePath(source: unknown, path: string): unknown {
	let current: unknown = source;
	let start = 0;

	for (;;) {
		const dot = path.indexOf('.', start);
		const key = dot === -1 ? path.slice(start) : path.slice(start, dot);

		if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;

		current = (current as Readonly<Record<string, unknown>>)[key];

		if (dot === -1) return current;

		start = dot + 1;
	}
}

/** A `{...}` placeholder of {@link interpolate}, capturing its path. */
const PLACEHOLDER = /\{([^{}]+)\}/;

/**
 * The templates {@link interpolate} parsed recently, at most 16 of at most {@link MAX_CACHED_TEMPLATE_LENGTH} characters (templates are
 * usually constants, applied to many value objects), each split into the text parts at even indices (first and last included, possibly
 * empty) and the raw paths between braces at odd ones.
 */
const parsedTemplates = new Map<string, string[]>();

/** Longer templates are not cached, so the cache cannot retain attacker-sized strings (it is bounded by entries, not bytes). */
const MAX_CACHED_TEMPLATE_LENGTH = 1024;

/**
 * Replaces `{key}` and `{nested.key}` placeholders (whitespace inside the braces is ignored) with values from an object.
 * Values are stringified with `String()`. Placeholders whose path does not exist (or resolves to `undefined`) are left untouched.
 * Only own properties are read, so `{constructor}` or `{__proto__}` never leak prototype members. There is no escaping syntax for braces.
 * Values are inserted as is (escape them, e.g. with {@link escapeHtml}, for HTML). The 16 most recent templates of at most 1024
 * characters are kept parsed.
 * @param {string} template - The template containing placeholders
 * @param {InterpolationValues} values - The values to insert; nested objects and arrays are addressed with dots (`{items.0}`)
 * @returns {string} The interpolated string
 * @example
 * interpolate('Hello {user.name}, you have {count} messages', { user: { name: 'Ada' }, count: 3 }); // => 'Hello Ada, you have 3 messages'
 * interpolate('Hi {missing}', {}); // => 'Hi {missing}'
 */
export function interpolate(template: string, values: InterpolationValues): string {
	let parts = parsedTemplates.get(template);

	if (parts === undefined) {
		parts = template.split(PLACEHOLDER);
		if (template.length <= MAX_CACHED_TEMPLATE_LENGTH) {
			// Simple eviction keeps the cache bounded: start afresh once it is full.
			if (parsedTemplates.size === 16) parsedTemplates.clear();
			parsedTemplates.set(template, parts);
		}
	}

	let result = parts[0];

	for (let index = 1; index < parts.length; index += 2) {
		const value = resolvePath(values, parts[index].trim());

		result += (value === undefined ? `{${parts[index]}}` : String(value)) + parts[index + 1];
	}

	return result;
}

/**
 * Returns the number of user-perceived characters (grapheme clusters, or code points without `Intl.Segmenter`) of a string.
 * @param {string} string - The string to measure
 * @returns {number} The grapheme count
 */
function graphemeLength(string: string): number {
	return isSimpleText(string) ? string.length : splitGraphemes(string).length;
}

/**
 * Computes the Levenshtein distance between two sequences of code points (see {@link levenshtein}).
 * @param {ReadonlyArray<string>} a - The code points of the first string
 * @param {ReadonlyArray<string>} b - The code points of the second string
 * @returns {number} The edit distance
 */
function editDistance(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
	let shorter = a;
	let longer = b;

	if (shorter.length > longer.length) [shorter, longer] = [longer, shorter];

	// Skip the common prefix and suffix: they never contribute to the distance.
	let start = 0;
	let shorterEnd = shorter.length;
	let longerEnd = longer.length;

	while (start < shorterEnd && shorter[start] === longer[start]) start++;

	while (shorterEnd > start && shorter[shorterEnd - 1] === longer[longerEnd - 1]) {
		shorterEnd--;
		longerEnd--;
	}

	const rowLength = shorterEnd - start;
	const row = new Uint32Array(rowLength + 1);

	for (let i = 0; i <= rowLength; i++) row[i] = i;

	for (let j = 1; j <= longerEnd - start; j++) {
		const character = longer[start + j - 1];
		let diagonal = row[0];

		row[0] = j;

		for (let i = 1; i <= rowLength; i++) {
			const above = row[i];
			const substitution = diagonal + (shorter[start + i - 1] === character ? 0 : 1);

			row[i] = Math.min(above + 1, row[i - 1] + 1, substitution);
			diagonal = above;
		}
	}

	return row[rowLength];
}

/**
 * Computes the Levenshtein edit distance between two strings: the minimum number of single-character insertions, deletions and substitutions
 * turning `a` into `b`. Characters are Unicode code points, so an astral character (emoji, surrogate pair) counts as one.
 * The common prefix and suffix are skipped and the dynamic-programming table keeps a single row sized after the shorter string,
 * so the extra memory is O(min(n, m)) and the time O(n × m): cap the length of untrusted inputs (two 100 000-character strings take
 * 10¹⁰ steps).
 * @param {string} a - The first string
 * @param {string} b - The second string
 * @returns {number} The edit distance (a non-negative integer, `0` iff the strings are equal)
 * @throws {TypeError} when `a` or `b` is not a string
 * @example
 * levenshtein('kitten', 'sitting'); // => 3
 * levenshtein('', 'abc'); // => 3
 * levenshtein('😀a', '😃a'); // => 1
 */
export function levenshtein(a: string, b: string): number {
	assertString('levenshtein', 'a', a);
	assertString('levenshtein', 'b', b);
	return editDistance(Array.from(a), Array.from(b));
}

/**
 * Computes a normalized similarity score from the {@link levenshtein} distance: `1 - distance / maxLength`, where lengths are counted in code points.
 * Two empty strings are considered identical (`1`).
 * @param {string} a - The first string
 * @param {string} b - The second string
 * @returns {number} A score in `[0, 1]`: `1` iff the strings are equal, `0` when every character must be changed
 * @throws {TypeError} when `a` or `b` is not a string
 * @example
 * similarity('kitten', 'sitting'); // => 0.5714285714285714 // 1 - 3 / 7
 * similarity('abc', 'abc'); // => 1
 * similarity('', ''); // => 1
 * similarity('abc', 'xyz'); // => 0
 */
export function similarity(a: string, b: string): number {
	assertString('similarity', 'a', a);
	assertString('similarity', 'b', b);
	const left = Array.from(a);
	const right = Array.from(b);
	const maxLength = Math.max(left.length, right.length);

	return maxLength === 0 ? 1 : 1 - editDistance(left, right) / maxLength;
}

/**
 * Removes the common indentation from template literal parts. Interpolation points (between two parts) count as non-blank content
 * and end a line's indentation, but are never modified themselves.
 * @param {ReadonlyArray<string>} parts - The literal parts (one more than the interpolated values)
 * @returns {string[]} The dedented parts, in the same order
 */
function dedentParts(parts: ReadonlyArray<string>): string[] {
	const joined = parts.join('');
	// The offsets in `joined` where the values are inserted (between two parts).
	const valueOffsets: number[] = [];
	let offset = 0;

	for (let index = 1; index < parts.length; index++) valueOffsets.push((offset += parts[index - 1].length));

	const valueAt = new Set(valueOffsets);
	const removed = new Uint8Array(joined.length);
	// The starts of the non-blank lines, whose common indentation is removed once it is known.
	const indented: number[] = [];
	const separator = /\r\n|\r|\n/g;
	let common: string | undefined;
	let valueIndex = 0;
	let start = 0;
	let previousEnd = 0;

	for (;;) {
		const match = separator.exec(joined);
		const end = match === null ? joined.length : match.index;
		// The start of the next line (only read when there is one: after the last line, `exec` resets `lastIndex` to 0).
		const next = separator.lastIndex;
		const firstValue = valueIndex;
		let indentationEnd = start;

		// The line separator (or the end of the text) stops the scan.
		while ((joined[indentationEnd] === ' ' || joined[indentationEnd] === '\t') && !valueAt.has(indentationEnd)) indentationEnd++;

		// A value belongs to this line when it is inserted before the next line starts (or anywhere after the start of the last line).
		while (valueIndex < valueOffsets.length && (match === null || valueOffsets[valueIndex] < next)) valueIndex++;

		if (valueIndex === firstValue && indentationEnd === end) {
			// A blank line is emptied; the first line (the only one starting at 0) is dropped with its line separator, and the last one
			// with the separator before it (for a single line, that is the whole text either way).
			if (match === null) removed.fill(1, previousEnd);
			else removed.fill(1, start, start === 0 ? next : end);
		} else {
			const indentation = joined.slice(start, indentationEnd);
			let length = 0;

			// Past the end of the indentation, `indentation[length]` is `undefined` and stops the loop.
			while (common !== undefined && length < common.length && common[length] === indentation[length]) length++;

			common = common === undefined ? indentation : common.slice(0, length);
			indented.push(start);
		}

		if (match === null) break;

		previousEnd = end;
		start = next;
	}

	for (const lineStart of indented) removed.fill(1, lineStart, lineStart + (common as string).length);

	let base = 0;

	return parts.map(function (part: string): string {
		let text = '';

		for (let index = 0; index < part.length; index++) if (removed[base + index] === 0) text += part[index];

		base += part.length;

		return text;
	});
}

/**
 * Removes the common leading indentation from a multi-line string, so it can be written indented in the source code.
 *
 * Rules:
 * - Lines are separated by `\n`, `\r\n` or `\r` (separators are kept as they are).
 * - The first line is dropped when it is blank (empty or only spaces/tabs), and so is the last one; this removes the line breaks that
 *   follow the opening backtick and precede the closing one.
 * - The longest common prefix of spaces/tabs of the remaining non-blank lines is removed from each of them (tabs and spaces are not
 *   converted into each other). Lines that contain only spaces/tabs become empty.
 *
 * It can be called as a function or used as a template tag. As a tag, the indentation is computed on the literal text only (cooked,
 * i.e. escape sequences such as `\n` are already resolved; the raw text is used for an invalid escape) and the interpolated values are
 * inserted afterwards with `String()`: they are NOT re-indented, so a multi-line value keeps its own line breaks and indentation,
 * and a line holding an interpolation is never treated as blank.
 * @param {string} string - The text to dedent
 * @returns {string} The dedented text
 * @example
 * dedent('\n    a\n      b\n    c\n'); // => 'a\n  b\nc'
 */
export function dedent(string: string): string;
/**
 * Template-tag form of {@link dedent}: removes the common indentation of the literal text, then inserts the values (not re-indented).
 * @param {TemplateStringsArray} strings - The literal parts of the template
 * @param {...unknown} values - The interpolated values, stringified with `String()`
 * @returns {string} The dedented text
 * @example
 * const name = 'Ada';
 * dedent`
 *     Hello ${name},
 *       welcome!
 * `; // => 'Hello Ada,\n  welcome!'
 */
export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string;
/**
 * Removes the common leading indentation from a multi-line string; usable as a function or as a template tag (see the overloads).
 * @param {string | TemplateStringsArray} input - The text, or the literal parts of a template
 * @param {...unknown} values - The interpolated values when used as a tag
 * @returns {string} The dedented text
 * @throws {TypeError} when `input` is neither a string nor a template strings array
 * @example
 * dedent('  a\n    b'); // => 'a\n  b'
 */
export function dedent(input: string | TemplateStringsArray, ...values: unknown[]): string {
	if (typeof input === 'string') return dedentParts([input])[0];

	if (!Array.isArray(input)) throw new TypeError(`dedent: \`input\` must be a string or a template strings array, got ${describe(input)}`);

	const literals = input.map(function (cooked: string | undefined, index: number): string {
		return cooked ?? input.raw[index];
	});
	const parts = dedentParts(literals);
	let result = parts[0];

	for (let index = 1; index < parts.length; index++) result += String(values[index - 1]) + parts[index];

	return result;
}

/**
 * Splits a string into lines. `\r\n`, `\r` and `\n` are all recognized as line breaks; the separators are not included in the result.
 * A trailing line break produces a trailing empty line, and an empty string gives `['']`.
 * @param {string} string - The text to split
 * @returns {string[]} The lines (at least one)
 * @example
 * splitLines('a\r\nb\rc\nd'); // => ['a', 'b', 'c', 'd']
 * splitLines('a\n'); // => ['a', '']
 */
export function splitLines(string: string): string[] {
	return string.split(/\r\n|\r|\n/);
}

/**
 * Options accepted by {@link wordWrap}.
 */
export interface WordWrapOptions {
	/** Cut words longer than `width` into `width`-sized pieces. When `false`, such words stay whole on their own (overlong) line. Defaults to `false`. */
	readonly breakLongWords?: boolean;
	/** The line break inserted between output lines. Defaults to `'\n'`. */
	readonly newline?: string;
}

/**
 * Wraps text to lines of at most `width` user-perceived characters (grapheme clusters) using a greedy algorithm: words are separated
 * by whitespace and added to the current line while they fit, with a single space between them.
 *
 * Existing line breaks (`\n`, `\r\n`, `\r`) are kept as hard breaks (each input line is wrapped on its own, blank lines are preserved),
 * every output line break is `newline`, and runs of other whitespace (including indentation and trailing spaces) collapse into the
 * separating single space. A word longer than `width` starts a new line; it is cut into `width`-sized pieces when `breakLongWords` is set
 * (the last piece can be followed by more words), otherwise it is kept whole.
 * @param {string} string - The text to wrap
 * @param {number} width - The maximum line width in graphemes (a positive integer, or `Infinity` to only normalize whitespace)
 * @param {WordWrapOptions} [options={}] - `breakLongWords` (default `false`) and `newline` (default `'\n'`)
 * @returns {string} The wrapped text
 * @throws {RangeError} when `width` is less than 1, `NaN` or a non-integer finite number
 * @throws {TypeError} when `width` is not a number, or `newline` is not a string
 * @example
 * wordWrap('The quick brown fox jumps', 10); // => 'The quick\nbrown fox\njumps'
 * wordWrap('abcdefghij xy', 4, { breakLongWords: true }); // => 'abcd\nefgh\nij\nxy'
 * wordWrap('a b c', 3, { newline: '<br>' }); // => 'a b<br>c'
 */
export function wordWrap(string: string, width: number, options: WordWrapOptions = {}): string {
	assertInteger('wordWrap', 'width', width, 1, true);

	const breakLongWords = readOption(options, 'breakLongWords', false);
	const newline = readOption(options, 'newline', '\n');
	if (typeof newline !== 'string') throw new TypeError(`wordWrap: \`newline\` must be a string, got ${describe(newline)}`);
	const output: string[] = [];

	for (const line of splitLines(string)) {
		let current = '';
		let currentLength = 0;

		for (const word of line.match(/\S+/g) ?? []) {
			const wordLength = graphemeLength(word);

			if (wordLength > width && breakLongWords) {
				if (current !== '') output.push(current);

				const pieces = splitGraphemes(word);

				for (let index = 0; index + width < pieces.length; index += width) output.push(pieces.slice(index, index + width).join(''));

				const lastLength = pieces.length % width || width;

				current = pieces.slice(pieces.length - lastLength).join('');
				currentLength = lastLength;
			} else if (current === '') {
				current = word;
				currentLength = wordLength;
			} else if (currentLength + 1 + wordLength <= width) {
				current += ' ' + word;
				currentLength += 1 + wordLength;
			} else {
				output.push(current);
				current = word;
				currentLength = wordLength;
			}
		}

		output.push(current);
	}

	return output.join(newline);
}

/**
 * Options accepted by {@link mask}.
 */
export interface MaskOptions {
	/** How many graphemes to leave visible at the start. Defaults to `0`. */
	readonly visibleStart?: number;
	/** How many graphemes to leave visible at the end. Defaults to `4`. */
	readonly visibleEnd?: number;
	/** The replacement for every hidden grapheme; must be exactly one grapheme. Defaults to `'*'`. */
	readonly char?: string;
}

/**
 * Hides the middle of a string (card numbers, tokens, phone numbers...), replacing every user-perceived character (grapheme cluster)
 * except the first `visibleStart` and the last `visibleEnd` ones with `char`. The grapheme length is preserved.
 * It fails closed: when the visible parts would cover the whole string (it has at most `visibleStart + visibleEnd` graphemes, e.g.
 * `mask('1234')` with the default 4 visible graphemes), nothing could be hidden, so every grapheme is masked instead. Otherwise at least
 * one grapheme is hidden, which may still reveal most of a short secret (`mask('12345')` is `'*2345'`): pick the visible counts accordingly.
 * @param {string} string - The string to mask
 * @param {MaskOptions} [options={}] - `visibleStart` (default `0`), `visibleEnd` (default `4`) and `char` (default `'*'`)
 * @returns {string} The masked string
 * @throws {RangeError} when `visibleStart` or `visibleEnd` is not a non-negative integer, or `char` is not exactly one grapheme
 * @throws {TypeError} when `visibleStart` or `visibleEnd` is not a number, or `char` is not a string
 * @example
 * mask('4111111111111111'); // => '************1111'
 * mask('john.doe@mail.com', { visibleStart: 2, visibleEnd: 9, char: '•' }); // => 'jo••••••@mail.com'
 * mask('👍🏽👍🏽👍🏽👍🏽👍🏽', { visibleEnd: 1 }); // => '****👍🏽'
 * mask('1234'); // => '****'
 */
export function mask(string: string, options: MaskOptions = {}): string {
	const visibleStart = readOption(options, 'visibleStart', 0);
	const visibleEnd = readOption(options, 'visibleEnd', 4);
	const char = readOption(options, 'char', '*');

	assertInteger('mask', 'visibleStart', visibleStart);
	assertInteger('mask', 'visibleEnd', visibleEnd);

	if (typeof char !== 'string') throw new TypeError(`mask: \`char\` must be a string, got ${describe(char)}`);
	if (graphemeLength(char) !== 1)
		throw new RangeError(`mask: \`char\` must be exactly one grapheme, got ${JSON.stringify(char.length > 50 ? `${char.slice(0, 50)}…` : char)}`);

	const graphemes = splitGraphemes(string);
	const hidden = graphemes.length - visibleStart - visibleEnd;

	if (hidden <= 0) return char.repeat(graphemes.length);

	return graphemes.slice(0, visibleStart).join('') + char.repeat(hidden) + graphemes.slice(visibleStart + hidden).join('');
}

/**
 * The default alphabet of {@link randomString}: ASCII letters and digits.
 */
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates a random string by drawing `length` characters uniformly and independently from `alphabet`.
 *
 * The alphabet is split into Unicode code points and duplicates are ignored, so every distinct character is equally likely;
 * the result therefore has exactly `length` code points.
 *
 * NOT cryptographically secure: with the default `Math.random` the output is predictable. Do not use it for passwords, tokens,
 * session ids or anything security-sensitive; use `crypto.getRandomValues` / `crypto.randomUUID` instead.
 * @param {number} length - The number of characters to generate (non-negative integer)
 * @param {string} [alphabet='A-Za-z0-9'] - The characters to choose from (defaults to the 62 ASCII letters and digits)
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`, injectable for deterministic results
 * @returns {string} The random string
 * @throws {RangeError} when `length` is not a non-negative integer, `alphabet` is empty or contains lone surrogates (which could pair
 * up into a different character in the result), or `random()` returns a value outside `[0, 1)`
 * @throws {TypeError} when `length` is not a number, or `random` is not a function
 * @example
 * randomString(8); // e.g. 'aZ3kP0qx'
 * randomString(6, '0123456789'); // e.g. '402913'
 * randomString(3, 'ab', function () { return 0; }); // => 'aaa'
 */
export function randomString(length: number, alphabet: string = ALPHANUMERIC, random: RandomGenerator = Math.random): string {
	assertInteger('randomString', 'length', length);

	const characters = Array.from(new Set(alphabet));

	if (characters.length === 0) throw new RangeError('randomString: `alphabet` must not be empty');
	// A lone surrogate counts as one code point here, but in the result a high one followed by a low one would form a single character.
	if (/\p{Cs}/u.test(alphabet)) throw new RangeError('randomString: `alphabet` must not contain lone surrogates');

	let result = '';

	for (let index = 0; index < length; index++) {
		result += characters[Math.floor(draw('randomString', random) * characters.length)];
	}

	return result;
}

/**
 * Converts a string to Sentence case, using the same word detection as {@link toSnakeCase}: the words are lower-cased, joined with
 * single spaces, and the first letter of the first word is upper-cased. Punctuation and separators are dropped, and acronyms are
 * lower-cased too (`'XMLHttpRequest'` → `'Xml http request'`).
 * @param {string} string - The string to convert
 * @returns {string} The string in sentence case
 * @example
 * toSentenceCase('helloWorld-foo'); // => 'Hello world foo'
 * toSentenceCase('SOME_CONSTANT_NAME'); // => 'Some constant name'
 */
export function toSentenceCase(string: string): string {
	const sentence = splitWords(string).join(' ');

	// A space is neither cased nor case-ignorable, so lower-casing the joined words equals lower-casing each of them.
	return sentence === '' ? '' : upperFirstLowerRest(sentence);
}

/**
 * Picks the singular or plural form of a word for a count. The singular is used when `count` is `1` or `-1`, the plural otherwise
 * (including `0`, fractions and `NaN`). Only the word is returned; see {@link formatCount} to include the number.
 * @param {number} count - The quantity
 * @param {string} singular - The singular form
 * @param {string} [plural=singular + 's'] - The plural form, for irregular plurals
 * @returns {string} `singular` or `plural`
 * @example
 * pluralize(1, 'item'); // => 'item'
 * pluralize(3, 'item'); // => 'items'
 * pluralize(0, 'child', 'children'); // => 'children'
 */
export function pluralize(count: number, singular: string, plural: string = singular + 's'): string {
	return Math.abs(count) === 1 ? singular : plural;
}

/**
 * Formats a count followed by the matching singular or plural word (see {@link pluralize}); the number is stringified with `String()`.
 * @param {number} count - The quantity
 * @param {string} singular - The singular form
 * @param {string} [plural=singular + 's'] - The plural form, for irregular plurals
 * @returns {string} `'<count> <word>'`
 * @example
 * formatCount(3, 'item'); // => '3 items'
 * formatCount(1, 'item'); // => '1 item'
 * formatCount(2, 'person', 'people'); // => '2 people'
 */
export function formatCount(count: number, singular: string, plural: string = singular + 's'): string {
	return `${String(count)} ${pluralize(count, singular, plural)}`;
}

/**
 * Prepends `prefix` unless the string already starts with it.
 * @param {string} string - The original string
 * @param {string} prefix - The required prefix
 * @returns {string} A string that starts with `prefix`
 * @example
 * ensurePrefix('example.com', 'https://'); // => 'https://example.com'
 * ensurePrefix('https://example.com', 'https://'); // => 'https://example.com'
 */
export function ensurePrefix(string: string, prefix: string): string {
	return string.startsWith(prefix) ? string : prefix + string;
}

/**
 * Appends `suffix` unless the string already ends with it.
 * @param {string} string - The original string
 * @param {string} suffix - The required suffix
 * @returns {string} A string that ends with `suffix`
 * @example
 * ensureSuffix('path/to', '/'); // => 'path/to/'
 * ensureSuffix('path/to/', '/'); // => 'path/to/'
 */
export function ensureSuffix(string: string, suffix: string): string {
	return string.endsWith(suffix) ? string : string + suffix;
}

/**
 * Removes `prefix` from the start of the string once, if present.
 * @param {string} string - The original string
 * @param {string} prefix - The prefix to remove
 * @returns {string} The string without the prefix (unchanged when it does not start with it)
 * @example
 * stripPrefix('https://example.com', 'https://'); // => 'example.com'
 * stripPrefix('//a', '/'); // => '/a'
 */
export function stripPrefix(string: string, prefix: string): string {
	return string.startsWith(prefix) ? string.slice(prefix.length) : string;
}

/**
 * Removes `suffix` from the end of the string once, if present.
 * @param {string} string - The original string
 * @param {string} suffix - The suffix to remove
 * @returns {string} The string without the suffix (unchanged when it does not end with it)
 * @example
 * stripSuffix('report.pdf', '.pdf'); // => 'report'
 * stripSuffix('a//', '/'); // => 'a/'
 */
export function stripSuffix(string: string, suffix: string): string {
	return string.endsWith(suffix) ? string.slice(0, string.length - suffix.length) : string;
}

/**
 * The sets built by {@link graphemeSet} for the 16 most recent `chars` strings of at most 64 code units (trimming usually repeats the same
 * characters; longer strings are not kept, so the cache cannot retain attacker-sized strings).
 */
const charSets = new Map<string, ReadonlySet<string>>();

/**
 * Validates the `chars` argument of {@link trimChars} and turns it into a set of graphemes.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string | ReadonlyArray<string>} chars - A string or an array of strings, each split into graphemes
 * @returns {ReadonlySet<string>} The graphemes
 * @throws {TypeError} when `chars` is not a string or an array of strings
 */
function graphemeSet(caller: string, chars: string | ReadonlyArray<string>): ReadonlySet<string> {
	if (typeof chars === 'string') {
		let cached = charSets.get(chars);

		if (cached === undefined) {
			cached = new Set(splitGraphemes(chars));

			if (chars.length <= 64) {
				// Simple eviction keeps the cache bounded: start afresh once it is full.
				if (charSets.size === 16) charSets.clear();
				charSets.set(chars, cached);
			}
		}

		return cached;
	}

	const set = new Set<string>();

	for (const item of Array.isArray(chars) ? (chars as ReadonlyArray<unknown>) : [chars]) {
		if (typeof item !== 'string') throw new TypeError(`${caller}: \`chars\` must be a string or an array of strings, got ${describe(item)}`);

		for (const grapheme of splitGraphemes(item)) set.add(grapheme);
	}

	return set;
}

/**
 * Trims the graphemes of a set from one or both ends of a string (see {@link trimChars}). Plain code units at the ends are compared one at a
 * time; graphemes are only split where an end holds text that may form multi-code-unit graphemes.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} string - The string to trim
 * @param {string | ReadonlyArray<string>} chars - The graphemes to remove
 * @param {boolean} fromStart - Whether to trim the start
 * @param {boolean} fromEnd - Whether to trim the end
 * @returns {string} The trimmed string
 * @throws {TypeError} when `chars` is not a string or an array of strings
 */
function trimGraphemes(caller: string, string: string, chars: string | ReadonlyArray<string>, fromStart: boolean, fromEnd: boolean): string {
	const set = graphemeSet(caller, chars);

	let start = 0;
	let end = string.length;

	// The graphemes from `start`, split once the start holds complex text (splitting the rest again for every grapheme was quadratic).
	let front: string[] | undefined;
	let next = 0;

	while (fromStart && start < end) {
		// `start` is a grapheme boundary: the code unit there is a whole grapheme when it and the next one are both simple.
		const grapheme =
			front === undefined && isSimpleCode(string.charCodeAt(start)) && isSimpleCode(string.charCodeAt(start + 1))
				? string[start]
				: (front ??= splitGraphemes(string.slice(start, end)))[next++];

		if (!set.has(grapheme)) break;

		start += grapheme.length;
	}

	// The graphemes between `start` and `end`, split once the end holds complex text (and then always used, so they stay in sync with `end`).
	let rest: string[] | undefined;

	while (fromEnd && end > start) {
		// `end` is a grapheme boundary too: the code unit before it is a whole grapheme when it and the previous one are both simple.
		const grapheme =
			rest === undefined && isSimpleCode(string.charCodeAt(end - 1)) && isSimpleCode(string.charCodeAt(end - 2))
				? string[end - 1]
				: ((rest ??= splitGraphemes(string.slice(start, end))).pop() as string);

		if (!set.has(grapheme)) break;

		end -= grapheme.length;
	}

	return string.slice(start, end);
}

/**
 * Removes every leading and trailing occurrence of the given characters. `chars` is a SET of user-perceived characters (grapheme
 * clusters), not a substring: `trimChars('abXba', 'ab')` removes any `a` or `b` at either end. A string is split into its graphemes, and an
 * array is a list of such strings (`['-', '_']` equals `'-_'`). Since whole graphemes are compared, `'👍'` does not remove the `'👍🏽'`
 * (thumbs up with a skin tone) and `'e'` does not strip the base letter of an `e` followed by a combining accent. Characters are matched
 * literally: no regular expression is built, so `]`, `\` or `^` need no escaping. An empty set returns the string unchanged.
 * @param {string} string - The string to trim
 * @param {string | ReadonlyArray<string>} chars - The characters to remove
 * @returns {string} The trimmed string
 * @throws {TypeError} when `chars` is not a string or an array of strings
 * @example
 * trimChars('--hello__', '-_'); // => 'hello'
 * trimChars('/path/to/', ['/']); // => 'path/to'
 * trimChars('👍🏽ok👍', '👍'); // => '👍🏽ok'
 * trimChars(']]x]]', ']'); // => 'x'
 */
export function trimChars(string: string, chars: string | ReadonlyArray<string>): string {
	return trimGraphemes('trimChars', string, chars, true, true);
}

/**
 * Removes every leading occurrence of the given characters (a set of graphemes, see {@link trimChars}).
 * @param {string} string - The string to trim
 * @param {string | ReadonlyArray<string>} chars - The characters to remove
 * @returns {string} The string without the leading characters
 * @throws {TypeError} when `chars` is not a string or an array of strings
 * @example
 * trimStartChars('000123', '0'); // => '123'
 * trimStartChars('-_x_-', ['-', '_']); // => 'x_-'
 */
export function trimStartChars(string: string, chars: string | ReadonlyArray<string>): string {
	return trimGraphemes('trimStartChars', string, chars, true, false);
}

/**
 * Removes every trailing occurrence of the given characters (a set of graphemes, see {@link trimChars}).
 * @param {string} string - The string to trim
 * @param {string | ReadonlyArray<string>} chars - The characters to remove
 * @returns {string} The string without the trailing characters
 * @throws {TypeError} when `chars` is not a string or an array of strings
 * @example
 * trimEndChars('1.500', '0'); // => '1.5'
 * trimEndChars('wait...!?', '.!?'); // => 'wait'
 */
export function trimEndChars(string: string, chars: string | ReadonlyArray<string>): string {
	return trimGraphemes('trimEndChars', string, chars, false, true);
}

/**
 * How {@link toDelimitedCase} cases each word:
 * - `'lower'`: `xml.http.request`
 * - `'upper'`: `XML.HTTP.REQUEST`
 * - `'capital'`: the first letter upper-cased (title case), the rest lower-cased: `Xml.Http.Request`
 * - `'preserve'`: the words as they appear in the input: `XML.Http.Request`
 */
export type WordCase = 'lower' | 'upper' | 'capital' | 'preserve';

/**
 * Options accepted by {@link toDelimitedCase}.
 */
export interface DelimitedCaseOptions {
	/** How each word is cased. Defaults to `'lower'`. */
	readonly case?: WordCase;
}

/** A cased or case-ignorable character: one that lower- or upper-casing could change, or that changes how a neighbouring `Σ` is lower-cased. */
const CASE_SENSITIVE = /[\p{Cased}\p{Case_Ignorable}]/u;

/**
 * Splits a string into words (see {@link toSnakeCase}), cases them and joins them. The result is always the words cased one by one: they
 * are only cased after joining when the delimiter can neither change nor be changed (it is not empty and holds no cased or case-ignorable
 * character, unlike `.`, which would turn a final `Σ` into `σ`).
 * @param {string} string - The string to convert
 * @param {string} delimiter - The text between words
 * @param {WordCase} wordCase - How each word is cased
 * @returns {string} The converted string
 */
function joinWords(string: string, delimiter: string, wordCase: WordCase): string {
	const words = splitWords(string);

	if (wordCase === 'preserve') return words.join(delimiter);

	if (wordCase === 'capital' || delimiter === '' || CASE_SENSITIVE.test(delimiter)) {
		for (let index = 0; index < words.length; index++) {
			const word = words[index];

			words[index] = wordCase === 'capital' ? upperFirstLowerRest(word) : wordCase === 'lower' ? word.toLowerCase() : word.toUpperCase();
		}

		return words.join(delimiter);
	}

	const joined = words.join(delimiter);

	return wordCase === 'lower' ? joined.toLowerCase() : joined.toUpperCase();
}

/** The values of {@link WordCase}. */
const WORD_CASES: ReadonlySet<string> = new Set<WordCase>(['lower', 'upper', 'capital', 'preserve']);

/**
 * Converts a string to words joined by any delimiter, using the same word detection as every other case helper (see {@link toSnakeCase}:
 * whitespace, punctuation, camelCase and acronym boundaries; digits stay attached to the preceding letters; apostrophes are dropped).
 * Case mapping is locale-independent (`'I'` always lower-cases to `'i'`, also on a Turkish system).
 * @param {string} string - The string to convert
 * @param {string} delimiter - The text inserted between words (may be empty or longer than one character)
 * @param {DelimitedCaseOptions} [options={}] - `case`: `'lower'` (default), `'upper'`, `'capital'` or `'preserve'`
 * @returns {string} The converted string
 * @throws {TypeError} when `delimiter` is not a string
 * @throws {RangeError} when `options.case` is not a {@link WordCase}
 * @example
 * toDelimitedCase('XMLHttpRequest', '.'); // => 'xml.http.request'
 * toDelimitedCase('user id', ' | ', { case: 'upper' }); // => 'USER | ID'
 * toDelimitedCase('helloWorld', '__', { case: 'capital' }); // => 'Hello__World'
 * toDelimitedCase('XMLHttpRequest', ':', { case: 'preserve' }); // => 'XML:Http:Request'
 */
export function toDelimitedCase(string: string, delimiter: string, options: DelimitedCaseOptions = {}): string {
	const wordCase = readOption(options, 'case', 'lower');

	if (typeof delimiter !== 'string') throw new TypeError(`toDelimitedCase: \`delimiter\` must be a string, got ${describe(delimiter)}`);

	if (!WORD_CASES.has(wordCase)) throw new RangeError(`toDelimitedCase: \`options.case\` must be 'lower', 'upper', 'capital' or 'preserve', got ${show(wordCase)}`);

	return joinWords(string, delimiter, wordCase);
}

/**
 * Converts a string to Train-Case: capitalized words joined with `-`, using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to convert
 * @returns {string} The string in train case
 * @example
 * toTrainCase('XMLHttpRequest2Go'); // => 'Xml-Http-Request2-Go'
 * toTrainCase('content_type'); // => 'Content-Type'
 */
export function toTrainCase(string: string): string {
	return joinWords(string, '-', 'capital');
}

/**
 * Converts a string to dot.case: lower-cased words joined with `.`, using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to convert
 * @returns {string} The string in dot case
 * @example
 * toDotCase('iOS17Pro'); // => 'i.os17.pro'
 * toDotCase('app_Config-key'); // => 'app.config.key'
 */
export function toDotCase(string: string): string {
	return joinWords(string, '.', 'lower');
}

/**
 * Converts a string to path/case: lower-cased words joined with `/`, using the same word detection as {@link toSnakeCase}.
 * @param {string} string - The string to convert
 * @returns {string} The string in path case
 * @example
 * toPathCase('UserProfileSettings'); // => 'user/profile/settings'
 */
export function toPathCase(string: string): string {
	return joinWords(string, '/', 'lower');
}

/**
 * Converts a string to "no case": lower-cased words joined with single spaces, using the same word detection as {@link toSnakeCase}
 * (punctuation and separators are dropped).
 * @param {string} string - The string to convert
 * @returns {string} The string in no case
 * @example
 * toNoCase('XMLHttpRequest'); // => 'xml http request'
 * toNoCase('--foo_bar--'); // => 'foo bar'
 */
export function toNoCase(string: string): string {
	return joinWords(string, ' ', 'lower');
}

/**
 * Converts a string to Start Case: capitalized words joined with single spaces, using the same word detection as {@link toSnakeCase}.
 * Unlike {@link toTitleCase}, which only re-cases whitespace-separated words and keeps punctuation, identifiers are split into words
 * and separators are dropped.
 * @param {string} string - The string to convert
 * @returns {string} The string in start case
 * @example
 * toStartCase('helloWorld'); // => 'Hello World'
 * toStartCase('XMLHttpRequest2Go'); // => 'Xml Http Request2 Go'
 * toStartCase('--foo_bar--'); // => 'Foo Bar'
 */
export function toStartCase(string: string): string {
	return joinWords(string, ' ', 'capital');
}

/**
 * Builds `count` graphemes of padding by repeating the graphemes of `fill` (the last repetition is cut short).
 * @param {string} fill - The padding text (not empty)
 * @param {number} count - The number of graphemes to produce
 * @returns {string} The padding
 */
function padding(fill: string, count: number): string {
	// One grapheme per code unit: the native padding cuts the last repetition at the right place.
	if (isSimpleText(fill)) return ''.padEnd(count, fill);

	const graphemes = splitGraphemes(fill);

	return fill.repeat(Math.floor(count / graphemes.length)) + graphemes.slice(0, count % graphemes.length).join('');
}

/**
 * Pads a string to a width in graphemes (see {@link padStart}).
 * @param {string} caller - Name of the public function, used in error messages
 * @param {string} string - The string to pad
 * @param {number} width - The target width in graphemes
 * @param {string} fill - The padding text
 * @param {number} share - The share of the padding that goes before the string: `1`, `0` or `0.5` (rounded down)
 * @returns {string} The padded string
 * @throws {RangeError} when `width` is not a non-negative integer or `fill` is empty
 * @throws {TypeError} when `width` is not a number or `fill` is not a string
 */
function pad(caller: string, string: string, width: number, fill: string, share: number): string {
	assertInteger(caller, 'width', width);

	if (typeof fill !== 'string' || fill === '') {
		const message = `${caller}: \`fill\` must be a non-empty string, got ${typeof fill === 'string' ? "''" : describe(fill)}`;

		throw typeof fill === 'string' ? new RangeError(message) : new TypeError(message);
	}

	const simple = isSimpleText(string);
	// Splitting stops once `width` graphemes have been seen: a longer string is returned as it is.
	const missing = width - (simple ? string.length : splitGraphemes(string, width).length);

	if (missing <= 0) return string;

	const before = Math.floor(missing * share);

	// One grapheme per code unit in both: the native methods count and cut the same way.
	if (simple && isSimpleText(fill)) return string.padStart(string.length + before, fill).padEnd(width, fill);

	return padding(fill, before) + string + padding(fill, missing - before);
}

/**
 * Pads the start of a string until it is `width` user-perceived characters (grapheme clusters) wide. Unlike the native
 * `String.prototype.padStart`, which counts UTF-16 code units (an emoji counts as 2, `'é'` written with a combining accent as 2), widths
 * are counted in graphemes, and so is the cut of the last repetition of a multi-character `fill`.
 *
 * Width means grapheme count: East Asian wide characters (CJK ideographs, full-width forms) and emoji, which terminals usually draw two
 * columns wide, count as 1. A string that starts with a combining mark (or a fill that ends with a zero-width joiner) can merge with the
 * padding into fewer graphemes.
 * @param {string} string - The string to pad
 * @param {number} width - The target width in graphemes (a non-negative integer); a string at least that wide is returned unchanged
 * @param {string} [fill=' '] - The padding, repeated and cut as needed (must not be empty)
 * @returns {string} The padded string
 * @throws {RangeError} when `width` is not a non-negative integer or `fill` is empty
 * @throws {TypeError} when `width` is not a number or `fill` is not a string
 * @example
 * padStart('42', 5, '0'); // => '00042'
 * padStart('👍🏽', 3, '*'); // => '**👍🏽'
 * padStart('x', 4, '👍🏽-'); // => '👍🏽-👍🏽x'
 */
export function padStart(string: string, width: number, fill: string = ' '): string {
	return pad('padStart', string, width, fill, 1);
}

/**
 * Pads the end of a string until it is `width` user-perceived characters (grapheme clusters) wide (see {@link padStart}).
 * @param {string} string - The string to pad
 * @param {number} width - The target width in graphemes (a non-negative integer); a string at least that wide is returned unchanged
 * @param {string} [fill=' '] - The padding, repeated and cut as needed (must not be empty)
 * @returns {string} The padded string
 * @throws {RangeError} when `width` is not a non-negative integer or `fill` is empty
 * @throws {TypeError} when `width` is not a number or `fill` is not a string
 * @example
 * padEnd('Name', 8, '.'); // => 'Name....'
 * padEnd('café', 6); // => 'café  '
 */
export function padEnd(string: string, width: number, fill: string = ' '): string {
	return pad('padEnd', string, width, fill, 0);
}

/**
 * Pads both ends of a string until it is `width` user-perceived characters (grapheme clusters) wide (see {@link padStart}). When the
 * padding is odd, the extra grapheme goes at the end. Each side starts its own repetition of `fill`.
 * @param {string} string - The string to pad
 * @param {number} width - The target width in graphemes (a non-negative integer); a string at least that wide is returned unchanged
 * @param {string} [fill=' '] - The padding, repeated and cut as needed (must not be empty)
 * @returns {string} The padded string
 * @throws {RangeError} when `width` is not a non-negative integer or `fill` is empty
 * @throws {TypeError} when `width` is not a number or `fill` is not a string
 * @example
 * padCenter('abc', 8, '_-'); // => '_-abc_-_'
 * padCenter('👍', 5, '*'); // => '**👍**'
 */
export function padCenter(string: string, width: number, fill: string = ' '): string {
	return pad('padCenter', string, width, fill, 0.5);
}

/**
 * Options accepted by {@link compareNatural}.
 */
export interface CompareNaturalOptions {
	/**
	 * Compare letters case-insensitively (lower-cased with `String.prototype.toLowerCase`, locale-independent, final `ς` read as `σ`, as in
	 * the other `ignoreCase` options of this module), so `'apple'`, `'Banana'` and
	 * `'cherry'` sort in that order. Strings that only differ in case still never compare equal: they are ordered by code units, so
	 * upper case first (`'File'` before `'file'`). Defaults to `false`: strings compare by UTF-16 code units, like `<` (`'Z'` before `'a'`).
	 */
	readonly ignoreCase?: boolean;
}

/**
 * Whether a UTF-16 code unit is an ASCII digit.
 * @param {number} code - The code unit (`NaN` past the end of a string)
 * @returns {boolean} `true` for `0` to `9`
 */
function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

/**
 * Compares two strings as sequences of runs of ASCII digits, compared by numeric value (any length, leading zeros ignored), and single
 * other code units, compared by value. A run of digits sorts where its first digit would, so before letters and after spaces and most
 * punctuation. A string that is a prefix of the other (in this sense) sorts first.
 * @param {string} a - The first string
 * @param {string} b - The second string
 * @returns {number} `-1`, `0` or `1`; `0` also for different strings whose numbers only differ in leading zeros (`'a01'` and `'a1'`)
 */
function compareRuns(a: string, b: string): number {
	let i = 0;
	let j = 0;

	while (i < a.length && j < b.length) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(j);

		if (isDigit(x) && isDigit(y)) {
			// Skip the leading zeros: the longer of the significant runs is the larger number, else the first different digit decides.
			while (a.charCodeAt(i) === 48) i++;
			while (b.charCodeAt(j) === 48) j++;

			let endA = i;
			let endB = j;

			while (isDigit(a.charCodeAt(endA))) endA++;
			while (isDigit(b.charCodeAt(endB))) endB++;

			if (endA - i !== endB - j) return endA - i < endB - j ? -1 : 1;

			for (; i < endA; i++, j++) {
				const difference = a.charCodeAt(i) - b.charCodeAt(j);

				if (difference !== 0) return difference < 0 ? -1 : 1;
			}
		} else if (x !== y) {
			// A digit faces another character: digits are contiguous (U+0030 to U+0039), so comparing the code units places the whole run.
			return x < y ? -1 : 1;
		} else {
			i++;
			j++;
		}
	}

	// The string with characters left is the longer one.
	return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/**
 * Compares two strings in natural order, for `Array.prototype.sort`: runs of digits compare by their numeric value, so `'file2'` sorts
 * before `'file10'` and `'v1.9'` before `'v1.10'`, and everything else compares by UTF-16 code units, like `<` (or case-insensitively,
 * with `ignoreCase`).
 *
 * It is a consistent total order, so sorting gives the same result whatever the input order: it is antisymmetric and transitive, and only
 * equal strings compare equal. Numbers that only differ in leading zeros (`'a01'` and `'a1'`) are tied, and ties are broken by code
 * units, which puts zero-padded numbers first (`'001'`, `'01'`, `'1'`), except for runs of zeros only (`'0'` comes before `'00'`). Digit runs of any length compare exactly (no conversion to a double
 * that would merge `'9007199254740993'` with `'9007199254740992'`).
 *
 * Only ASCII digits form numbers: signs, decimal points and thousands separators are ordinary characters (`'1.5'` sorts before `'1.25'`,
 * as versions do), and so are other scripts' digits. The order is deterministic: it depends on neither the locale nor the ICU version of
 * the runtime. For a locale-aware order of words (`'é'` next to `'e'`), use `new Intl.Collator(locale, { numeric: true }).compare` instead,
 * which ignores leading zeros (it ties `'01'` with `'1'`, so their order depends on the input order) and is not available everywhere.
 * @param {string} a - The first string
 * @param {string} b - The second string
 * @param {CompareNaturalOptions} [options={}] - `ignoreCase` (default `false`)
 * @returns {number} A negative number when `a` sorts first, a positive one when `b` does, `0` when they are equal (`-1`, `1` or `0`)
 * @throws {TypeError} when `a` or `b` is not a string
 * @example
 * ['file10.txt', 'file2.txt', 'file1.txt'].sort(compareNatural); // => ['file1.txt', 'file2.txt', 'file10.txt']
 * ['v1.10', 'v1.9', 'v1.9.1'].sort(compareNatural); // => ['v1.9', 'v1.9.1', 'v1.10']
 * ['1', '01', '001', '2'].sort(compareNatural); // => ['001', '01', '1', '2']
 * ['b', 'A2', 'a10', 'a2'].sort(compareNatural); // => ['A2', 'a2', 'a10', 'b']
 * ['b', 'A2', 'a10', 'a2'].sort(function (a, b) { return compareNatural(a, b, { ignoreCase: true }); }); // => ['A2', 'a2', 'a10', 'b']
 * compareNatural('img12.png', 'img2.png'); // => 1
 */
export function compareNatural(a: string, b: string, options?: CompareNaturalOptions): number {
	assertString('compareNatural', 'a', a);
	assertString('compareNatural', 'b', b);

	if (a === b) return 0;

	// A sort comparator: read inline (see `readOption`), and not at all without options.
	const flag = options === undefined ? undefined : options.ignoreCase;
	const ignoreCase = flag === true && (flag !== (Object.prototype as CompareNaturalOptions).ignoreCase || Object.hasOwn(options as object, 'ignoreCase'));
	const order = ignoreCase ? compareRuns(foldCase(a), foldCase(b)) : compareRuns(a, b);

	return order !== 0 ? order : a < b ? -1 : 1;
}

/**
 * Options accepted by {@link truncateMiddle}.
 */
export interface TruncateMiddleOptions {
	/** The text inserted in place of the removed middle (it is not counted in the length). Defaults to `'…'`. */
	readonly ellipsis?: string;
	/**
	 * Where the cut goes, as the share of the kept graphemes taken from the start (rounded down, `0.29` of 100 being 29 despite the
	 * floating-point product): `0` keeps only the end (`'…ndex.ts'`), `1` only the start (like `truncate(string, length, ellipsis)`; note
	 * that the default ellipsis of {@link truncate} is `'...'`), and `0.5` (the default) half of each, the odd one at the end.
	 */
	readonly position?: number;
}

/**
 * Shortens a string by removing its middle, so both ends stay visible (paths, URLs, identifiers, hashes): when the string is longer than
 * `length` user-perceived characters (grapheme clusters), it keeps `length` of them, half from the start and half from the end by default,
 * with the ellipsis between. As in {@link truncate}, the ellipsis is not counted in `length`, a string of at most `length` graphemes is
 * returned unchanged, and no surrogate pair, emoji sequence or base character and its combining marks is ever split.
 *
 * Only the ends of the string are split into graphemes, so the cost depends on `length`, not on the length of the string: the end is
 * split from a boundary that no grapheme rule looks across (two consecutive characters among ASCII, Latin-1, CJK ideographs, kana, Hangul
 * syllables and emoji). Text without such a pair near its end (long runs of Thai or Devanagari, for example) is split up to its start.
 * @param {string} string - The string to shorten
 * @param {number} length - The number of graphemes to keep (a non-negative integer)
 * @param {TruncateMiddleOptions} [options={}] - `ellipsis` (default `'…'`) and `position` (default `0.5`)
 * @returns {string} The shortened string, or `string` itself when it has at most `length` graphemes
 * @throws {RangeError} when `length` is not a non-negative integer, or `position` is not between 0 and 1
 * @throws {TypeError} when `string` or `ellipsis` is not a string, or `length` or `position` is not a number
 * @example
 * truncateMiddle('/Users/ada/projects/tinkit/src/index.ts', 24); // => '/Users/ada/p…src/index.ts'
 * truncateMiddle('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 10, { ellipsis: '...' }); // => '0x71C...8976F'
 * truncateMiddle('/Users/ada/projects/tinkit/src/index.ts', 12, { position: 0 }); // => '…src/index.ts'
 * truncateMiddle('👍🏽👍🏽👍🏽👍🏽', 2); // => '👍🏽…👍🏽'
 * truncateMiddle('short', 10); // => 'short'
 */
export function truncateMiddle(string: string, length: number, options: TruncateMiddleOptions = {}): string {
	assertString('truncateMiddle', 'string', string);
	assertInteger('truncateMiddle', 'length', length);

	const ellipsis = readOption(options, 'ellipsis', '…');
	const position = readOption(options, 'position', 0.5);

	assertString('truncateMiddle', 'ellipsis', ellipsis);
	assertNumber('truncateMiddle', 'position', position, typeof position === 'number' && position >= 0 && position <= 1, 'a number between 0 and 1');

	// A string never has more graphemes than UTF-16 code units.
	if (string.length <= length) return string;

	// `length * position` can fall just below the integer it stands for (`100 * 0.29` is `28.999999999999996`): an error within the
	// rounding of the product (and of `position` itself) is not a fraction to round down.
	const product = length * position;
	const nearest = Math.round(product);
	const head = Math.abs(product - nearest) <= product * 2 ** -50 ? nearest : Math.floor(product);
	const tail = length - head;

	// When the first `head + 1` and the last `tail + 1` code units are graphemes on their own, the string has more than `length`
	// graphemes (it has more than `length` code units) and the cuts fall between code units.
	if (isSimpleText(string.slice(0, head + 1)) && isSimpleText(string.slice(string.length - tail - 1))) {
		return string.slice(0, head) + ellipsis + string.slice(string.length - tail);
	}

	const front = leadingGraphemes(string, length);

	if (front.length <= length) return string;

	return front.slice(0, head).join('') + ellipsis + trailingGraphemes(string, tail).join('');
}

/**
 * Splits the start of a string into graphemes, looking at a prefix that grows until it holds enough of them. A prefix is segmented as the
 * whole string is, except for its last grapheme (a boundary only depends on what comes before it and on the code point right after it).
 * @param {string} string - The string
 * @param {number} count - How many graphemes are needed
 * @returns {string[]} The first `count + 1` graphemes, or all of them when the string has at most `count + 1`
 */
function leadingGraphemes(string: string, count: number): string[] {
	for (let size = 4 * count + 16; ; size *= 2) {
		if (size >= string.length) return splitGraphemes(string, count).slice(0, count + 1);

		const graphemes = splitGraphemes(string.slice(0, size), count + 1);

		if (graphemes.length > count + 1) return graphemes.slice(0, count + 1);
	}
}

/**
 * Whether a code point is a grapheme on its own that no grapheme-break rule joins to a neighbour of the same kind or looks across: one that
 * {@link isSimpleCode} accepts, a CJK ideograph (U+3400–4DBF, U+4E00–9FFF), a kana letter (U+3041–3096, U+30A1–30FA), a precomposed
 * Hangul syllable (U+AC00–D7A3) or a pictograph of the emoji blocks (U+1F300–1FAFF, except the skin tones). All of them have the
 * grapheme-break property Other or LV/LVT, and none is a regional indicator, an extending character or an Indic conjunct linker.
 * @param {number} code - The code point (or a lone surrogate)
 * @returns {boolean} Whether a boundary between two such code points is certain and independent of what comes before
 */
function isPlainPoint(code: number): boolean {
	return (
		isSimpleCode(code) ||
		(code >= 0x3041 && code <= 0x3096) ||
		(code >= 0x30a1 && code <= 0x30fa) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0x1f300 && code <= 0x1faff && !(code >= 0x1f3fb && code <= 0x1f3ff))
	);
}

/**
 * Whether a position of a string lies between two {@link isPlainPoint} code points.
 * @param {string} string - The string
 * @param {number} index - A position, from 1 to `string.length - 1`
 * @returns {boolean} Whether the grapheme boundary there is certain, and the segmentation after it the same as the whole string's
 */
function isPlainBoundary(string: string, index: number): boolean {
	const unit = string.charCodeAt(index - 1);
	// The code point that ends at `index`: a surrogate pair, or a single code unit (possibly a lone surrogate).
	const pair = unit >= 0xdc00 && unit <= 0xdfff && index >= 2 ? (string.codePointAt(index - 2) as number) : unit;

	return isPlainPoint(pair > 0xffff ? pair : unit) && isPlainPoint(string.codePointAt(index) as number);
}

/**
 * Splits the end of a string into graphemes: from a boundary between two {@link isPlainPoint} code points (where the segmentation of the
 * whole string and of the rest of it agree), moved back until enough graphemes follow it, or from the start of the string.
 * @param {string} string - The string
 * @param {number} count - How many graphemes are needed
 * @returns {string[]} The last `count` graphemes (all of them when there are fewer)
 */
function trailingGraphemes(string: string, count: number): string[] {
	let graphemes: string[] = [];

	for (let size = 4 * count + 16; graphemes.length < count; size *= 2) {
		let start = Math.max(0, string.length - size);

		while (start > 0 && !isPlainBoundary(string, start)) start--;

		graphemes = splitGraphemes(string.slice(start));

		if (start === 0) break;

		size = Math.max(size, string.length - start);
	}

	return graphemes.slice(Math.max(0, graphemes.length - count));
}

/**
 * The code points that East Asian Width (Unicode 17.0, UAX #11) classes as Wide or Fullwidth, as ranges: base-36 numbers, alternately the
 * gap since the end of the previous range (from 0) and the length of the range minus one. Unassigned code points between two wide ones
 * are included (they are mostly reserved for more ideographs and emoji), which takes 123 ranges down to 83.
 */
const WIDE_RANGES =
	'3cw,2n,3i2,1,d,1,5a,3,3,0,2,0,eh,1,l,1,q,7,g,b,17,0,a,5,3,0,d,0,8,1,h,1,5,1,8,0,5,0,l,0,7,1,1,0,4,0,2,0,7,0,4,1,s,0,z,0,1,0,4,2,1,0,1p,2,o,0,e,0,nv,1,1f,0,4,0,mi,ce,2,ee,8,mly,wp,s,hv,8mb,6l8,e7,ls,9,m,1n,45,2n,3j,6,m49,d97,6bo,3a,5n1,0,5m,0,5a,0,2,9,2t,80,c,8,1,1x,1,l,c,16,4,4,c,g,3,0,3,1y,1,0,1,56,2,1q,d,3,1,n,i,0,q,1,d,0,2e,2c,1c,1x,6,0,3,2,2,a,b,1,7,8,6b,g,7v,1a,1,9,1,54,34,3s,zr,2t4t';

/** The decoded {@link WIDE_RANGES}, as `[start, end, start, end...]` (inclusive), or `undefined` until first used. */
let wideRanges: number[] | undefined;

/**
 * Whether a code point is East Asian Wide or Fullwidth (two terminal columns), by binary search in {@link WIDE_RANGES}.
 * @param {number} code - The code point
 * @returns {boolean} `true` for wide and fullwidth code points
 */
function isWide(code: number): boolean {
	if (code < 0x1100) return false;

	if (wideRanges === undefined) {
		const numbers = WIDE_RANGES.split(',');
		let next = 0;

		wideRanges = [];

		for (let index = 0; index < numbers.length; index += 2) {
			const start = next + parseInt(numbers[index], 36);

			next = start + parseInt(numbers[index + 1], 36);
			wideRanges.push(start, next++);
		}
	}

	// The last range starting at or before `code`.
	let low = 0;
	let high = wideRanges.length / 2 - 1;

	while (low < high) {
		const middle = (low + high + 1) >>> 1;

		if (wideRanges[middle * 2] <= code) low = middle;
		else high = middle - 1;
	}

	return wideRanges[low * 2] <= code && code <= wideRanges[low * 2 + 1];
}

/**
 * An ANSI escape sequence, as terminals read them: a CSI sequence (`ESC [` or U+009B, parameter bytes, intermediate bytes and a final
 * byte, such as the colour code `ESC [ 3 1 m`), a control string (`ESC ]` for an OSC such as a hyperlink, or `ESC P`, `ESC X`, `ESC ^`,
 * `ESC _`, up to a BEL, `ESC \` or U+009C terminator, or up to the ESC, CAN or SUB that cancels it), or another escape (`ESC`,
 * intermediate bytes and a final byte, such as `ESC ( B`). A CSI sequence or a control string that the string ends inside is removed to
 * the end, since a terminal waits for the rest of it. Each pattern consumes characters that cannot start another one, so matching is linear.
 */
const ANSI_SEQUENCE =
	// eslint-disable-next-line no-control-regex -- escape sequences start with control characters
	/(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|$)|\x1b[\]PX^_][^\x07\x18\x1a\x1b\x9c]*(?:\x07|\x1b\\|\x9c|(?=[\x18\x1a\x1b])|$)|\x1b[\x20-\x2f]*[\x30-\x7e]/g;

/** Printable ASCII only: one column per code unit. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Emoji clusters that are two columns wide although their first code point may be narrow: a flag (any pair of regional indicators), a
 * keycap (`#`, `*` or a digit, with or without U+FE0F, then U+20E3), a pictograph followed by the emoji presentation selector U+FE0F,
 * an emoji modifier base followed by a skin tone, or a ZWJ sequence of pictographs. (Pictographs that are wide on their own, which most
 * emoji are, are found by {@link isWide}.)
 */
const NARROW_BASED_EMOJI =
	/^(?:[\u{1f1e6}-\u{1f1ff}]{2}|[#*0-9]\ufe0f?\u20e3|\p{Extended_Pictographic}\ufe0f|\p{Emoji_Modifier_Base}\p{Emoji_Modifier})|\u200d\p{Extended_Pictographic}/u;

/** A code point that takes up room: not a control, format, default-ignorable or non-spacing/enclosing mark code point, nor a lone surrogate. */
const VISIBLE = /[^\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;

/** A spacing combining mark (e.g. Devanagari vowel signs), which takes up a column of its own after its base. */
const SPACING_MARK = /\p{Mc}/u;

/**
 * The kind of a conjoining Hangul jamo.
 * @param {number} code - A code point (`undefined` past the end of a list, which is no jamo)
 * @returns {number} `1` for a leading consonant (L), `2` for a vowel (V), `3` for a trailing consonant (T), else `0`
 */
function jamoKind(code: number): number {
	if ((code >= 0x1100 && code <= 0x115f) || (code >= 0xa960 && code <= 0xa97c)) return 1;
	if ((code >= 0x1160 && code <= 0x11a7) || (code >= 0xd7b0 && code <= 0xd7c6)) return 2;
	if ((code >= 0x11a8 && code <= 0x11ff) || (code >= 0xd7cb && code <= 0xd7fb)) return 3;

	return 0;
}

/**
 * Computes the width of a grapheme cluster that starts with a conjoining Hangul jamo, as `string-width` does: a leading consonant
 * followed by a vowel (and optionally a trailing consonant) forms a 2-column syllable block, any other jamo keeps its own width (2 for a
 * leading consonant, 1 for the others), and from the first code point that is not a jamo, every code point adds its own width.
 * @param {number[]} points - The visible code points of the cluster
 * @returns {number} The width in columns
 */
function jamoWidth(points: number[]): number {
	let width = 0;

	for (let index = 0; index < points.length; index++) {
		const kind = jamoKind(points[index]);

		if (kind === 0) {
			for (; index < points.length; index++) width += isWide(points[index]) ? 2 : 1;
		} else if (kind === 1 && jamoKind(points[index + 1]) === 2) {
			width += 2;
			index += jamoKind(points[index + 2]) === 3 ? 2 : 1;
		} else {
			width += kind === 1 ? 2 : 1;
		}
	}

	return width;
}

/**
 * Computes the terminal width of a grapheme cluster (see {@link stringWidth}).
 * @param {string} grapheme - The grapheme cluster
 * @returns {number} Its width in columns
 */
function graphemeWidth(grapheme: string): number {
	const code = grapheme.codePointAt(0) as number;

	// A single code point (most graphemes) is as wide as its class says.
	if (grapheme.length === (code > 0xffff ? 2 : 1)) return VISIBLE.test(grapheme) ? (isWide(code) ? 2 : 1) : 0;

	const start = grapheme.search(VISIBLE);

	// Only zero-width code points.
	if (start === -1) return 0;

	if (jamoKind(grapheme.codePointAt(start) as number) !== 0) {
		const points: number[] = [];

		for (const char of grapheme.slice(start)) if (VISIBLE.test(char)) points.push(char.codePointAt(0) as number);

		return jamoWidth(points);
	}

	let width = 0;
	let first = true;

	// The first visible code point (or the emoji sequence it starts), then the spacing marks and halfwidth/fullwidth forms (such as a
	// halfwidth voiced sound mark) after it.
	for (const char of grapheme.slice(start)) {
		const point = char.codePointAt(0) as number;

		if (first) width = isWide(point) || NARROW_BASED_EMOJI.test(grapheme) ? 2 : 1;
		else if (SPACING_MARK.test(char) || (point >= 0xff00 && point <= 0xffef)) width += isWide(point) ? 2 : 1;

		first = false;
	}

	return width;
}

/**
 * Computes how many columns a string takes up in a monospace terminal, for aligning tables, progress bars and other command-line output.
 * The string is measured per user-perceived character (grapheme cluster), with the rules of `string-width` (version 8):
 * - ANSI escape sequences (colours, cursor movements, OSC 8 hyperlinks... as ECMA-48 defines them) are ignored;
 * - East Asian Wide and Fullwidth characters (CJK ideographs, kana, Hangul syllables, fullwidth forms) and emoji are 2 columns, including
 *   emoji sequences (flags, keycaps, skin tones, ZWJ sequences such as families) and text-style symbols with the emoji presentation selector
 *   (`'❤️'`); every other character, including East Asian Ambiguous ones (`'±'`, Greek and Cyrillic letters), is 1 column;
 * - C0 and C1 control characters (tabs, `\n` and `\r` included: the string is measured as one line), format characters, combining
 *   marks, zero-width spaces and joiners, variation selectors and other default-ignorable code points are 0 columns. A spacing mark (as in
 *   Devanagari `'कि'`) adds a column to its cluster. U+2028 and U+2029 (line and paragraph separators, which terminals do not treat as line
 *   breaks) are 1 column, as in `string-width`;
 * - conjoining Hangul jamo form 2-column syllable blocks (a leading consonant, a vowel and an optional trailing consonant); other jamo
 *   keep their own width, so a run of leading consonants is 2 columns each.
 *
 * Every assigned code point measures as with `string-width` 8.3, and so do jamo clusters. Sequences differ in a few places:
 * - any pair of regional indicators is a 2-column flag, not only the pairs that are country flags (`'🇦🇦'` is 2 here, 1 there);
 * - an emoji sequence followed by a stray code point is still 2 columns: a keycap followed by a ZWJ or a combining mark (`'1️⃣'` + ZWJ
 *   is 2 here, 1 there), an emoji with a skin tone and a stray selector (a spacing mark after an emoji sequence adds its column: `'©️'` + U+0903 is 3
 *   here, 2 there);
 * - escape sequences are found by their ECMA-48 syntax, so malformed and rare ones are removed differently: an `ESC` inside an OSC
 *   cancels it (its text is not shown, as in terminals), an unterminated CSI sequence or control string at the end is removed to the end,
 *   `ESC SP F` is removed whole, and `ESC 3 1 3` keeps its `13` (`ESC 3` is a complete escape).
 *
 * The width classes come from Unicode 17.0 (`EastAsianWidth.txt`, as a table of 83 ranges), while the grapheme clusters and the other
 * character properties (marks, emoji) come from the runtime's own Unicode data (`Intl.Segmenter` and regular expressions). Without
 * `Intl.Segmenter`, code points are measured one by one, so emoji sequences count each of their emoji. Terminals and fonts differ in
 * places (emoji sequences that a font draws as several glyphs, ambiguous characters drawn wide in CJK locales), so this is the common
 * case, not a guarantee.
 * @param {string} string - The string to measure
 * @returns {number} Its width in terminal columns
 * @throws {TypeError} when `string` is not a string
 * @example
 * stringWidth('hello'); // => 5
 * stringWidth('古池や'); // => 6
 * stringWidth('\x1b[31mred\x1b[39m'); // => 3
 * stringWidth('👨‍👩‍👧 🇯🇵'); // => 5
 * stringWidth('e\u0301'); // => 1
 * stringWidth('a\u200bb'); // => 2
 */
export function stringWidth(string: string): number {
	assertString('stringWidth', 'string', string);

	const text = string.includes('\x1b') || string.includes('\x9b') ? string.replace(ANSI_SEQUENCE, '') : string;

	if (PRINTABLE_ASCII.test(text)) return text.length;

	let width = 0;
	const segmenter = getGraphemeSegmenter();

	// Text that is not one grapheme per code unit goes through the segmenter in one pass: `splitGraphemes` segments each region of complex
	// text on its own, which costs more here, where Latin, CJK and kana alternate at every character.
	if (segmenter !== null && !isSimpleText(text)) {
		for (const data of segmenter.segment(text)) width += graphemeWidth(data.segment);
	} else {
		for (const grapheme of splitGraphemes(text)) width += graphemeWidth(grapheme);
	}

	return width;
}
