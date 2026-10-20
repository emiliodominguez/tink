import { assertFunction, assertInteger, assertNumber, readOption, show, describe as typeName } from '../utils/assert.js';
import { DIACRITICS, NON_ASCII, transliterate } from '../utils/latin.js';

/** Points awarded for every matched character. */
const MATCH = 16;
/** Bonus for a matched character that starts a word. */
const BOUNDARY = 8;
/** Bonus for a matched character that directly follows the previous matched character. */
const CONSECUTIVE = 5;
/** Bonus for a matched character whose case is exactly the query's. */
const EXACT_CASE = 1;
/** Penalty for opening a gap (one or more skipped characters) between two matched characters. */
const GAP_START = -3;
/** Penalty for every skipped character of a gap after the first one. */
const GAP_EXTENSION = -1;
/** Largest penalty (one point per character) for the characters skipped before the first match. */
const MAX_LEADING_PENALTY = 8;
/** A letter, a combining mark (part of the letter before it: NFD accents, Indic vowel signs) or a digit, in any script. */
const WORD = /[\p{L}\p{M}\p{N}]/u;

/**
 * Options accepted by {@link fuzzyMatch}.
 */
export interface FuzzyMatchOptions {
	/**
	 * When `true`, characters only match when their case is identical.
	 * @default false
	 */
	caseSensitive?: boolean;
	/**
	 * When `true`, accents and other diacritics are ignored (`'cafe'` matches `'Café'`, precomposed or with a combining accent).
	 * Folding at most triples the strings (a longer folding, such as `'ﷺ'`'s, is not applied), so the cost grows by at most 9 times.
	 * See {@link fuzzyMatch}.
	 * @default false
	 */
	ignoreDiacritics?: boolean;
}

/**
 * A successful {@link fuzzyMatch}.
 */
export interface FuzzyMatch {
	/** Score of the best alignment of the query in the target (higher is better). Scores are integers and only meaningful relative to each other. */
	score: number;
	/** Half-open `[start, end)` UTF-16 index ranges of the matched characters in the target: ascending, non-overlapping, adjacent ranges merged. */
	ranges: Array<[number, number]>;
}

/**
 * Options accepted by {@link fuzzySearch}. Items that are not strings need a `key`: type such options as {@link FuzzySearchKeyedOptions}.
 * @template T - The type of the searched items
 */
export interface FuzzySearchOptions<T> {
	/** Returns the text(s) to match for an item; when it returns several, the best-scoring one is used. Required unless the items are strings. */
	key?: (item: T) => string | ReadonlyArray<string>;
	/**
	 * Maximum number of results.
	 * @default Infinity
	 */
	limit?: number;
	/**
	 * Matches scoring below this value are dropped.
	 * @default -Infinity
	 */
	threshold?: number;
	/**
	 * When `true`, characters only match when their case is identical.
	 * @default false
	 */
	caseSensitive?: boolean;
	/**
	 * When `true`, accents and other diacritics are ignored. Folding at most triples the texts, so the cost grows by at most 9 times.
	 * See {@link fuzzyMatch}.
	 * @default false
	 */
	ignoreDiacritics?: boolean;
}

/**
 * {@link FuzzySearchOptions} with the `key` that items other than strings need (for options built ahead of the call).
 * @template T - The type of the searched items
 */
export type FuzzySearchKeyedOptions<T> = FuzzySearchOptions<T> & { key: (item: T) => string | ReadonlyArray<string> };

/**
 * One result of {@link fuzzySearch}.
 * @template T - The type of the searched items
 */
export interface FuzzySearchResult<T> extends FuzzyMatch {
	/** The matching item. */
	item: T;
	/** The text that matched (the item itself, or the best of the texts returned by `key`): `ranges` index into it. */
	key: string;
}

/**
 * A segment of text produced by {@link highlight}.
 */
export interface HighlightSegment {
	/** The segment's text (never empty). */
	text: string;
	/** Whether the segment is covered by a range. */
	match: boolean;
}

/**
 * Throws a `TypeError` unless `value` is a string.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @returns {void}
 * @throws {TypeError} when `value` is not a string
 */
function assertString(caller: string, name: string, value: unknown): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${caller}: \`${name}\` must be a string, got ${typeName(value)}`);
}

/**
 * Reads an element of a user array: a hole is `undefined`, never a value planted on a polluted `Object.prototype` (which a `for...of`
 * loop or an index read would find through the hole).
 * @param {ArrayLike<V>} array - The array
 * @param {number} index - The index
 * @returns {V | undefined} The element, or `undefined` for a hole
 */
function elementAt<V>(array: ArrayLike<V>, index: number): V | undefined {
	return Object.hasOwn(array, index) ? array[index] : undefined;
}

/** Character class flag: a letter or a digit. */
const WORD_CHAR = 1;
/** Character class flag: a character that has an upper-case form (i.e. a lower-case letter). */
const LOWER_CASE = 2;
/** Character class flag: a character that has a lower-case form (i.e. an upper-case letter). */
const UPPER_CASE = 4;
/** Targets up to this many UTF-16 code units are aligned in scratch buffers reused across calls (larger ones get one-off buffers, so they are not retained). */
const SHARED_LENGTH = 256;
/** Largest back-pointer matrix (query code points × target code points) kept in the reused scratch buffers. */
const SHARED_CELLS = 8192;
/** Largest back-pointer matrix allowed (`2 ** 28` cells: 1 GiB); larger alignments throw a `RangeError`. */
const MAX_CELLS = 2 ** 28;

/**
 * A query split into code points, folded once per search.
 */
interface PreparedQuery {
	/** Folded code points (see {@link fold}). */
	codes: number[];
	/** Original code points (for the exact-case bonus). */
	raw: number[];
	/**
	 * For an ASCII query, the characters each query character matches, to reject targets with `indexOf`: up to 3 indexes into `chars`,
	 * plus one, packed in the bytes of a number (`'k'` matches `k`, `K` and the Kelvin sign). `undefined` otherwise.
	 */
	needles: number[] | undefined;
	/** The distinct characters of `needles`. */
	chars: string[];
	/** Scratch space of {@link contains}: the next known position of each of `chars` in the current target (`-1`: none left). */
	next: number[];
	/** Whether diacritics are ignored (see {@link expand}). */
	diacritics: boolean;
}

/**
 * Scratch buffers of the alignment, indexed by target character: a code point, or with `ignoreDiacritics` one of the characters a
 * code point folds to (see {@link expand}).
 */
interface Workspace {
	/** Folded characters of the target. */
	codes: Int32Array;
	/** Original characters of the target (with `ignoreDiacritics`, before case folding only), for the exact-case bonus and the word starts. */
	raw: Int32Array;
	/** UTF-16 offset in the target where the code point of every character starts. */
	starts: Int32Array;
	/** UTF-16 offset in the target where the code point of every character ends (with any combining mark that `ignoreDiacritics` skips). */
	ends: Int32Array;
	/** Word-start bonus of every target position (see `bonus`), computed once per position rather than per cell. */
	bonuses: Int8Array;
	/** Two dynamic-programming rows. */
	rows: [Float64Array, Float64Array];
	/** Back pointers: position of the previous matched character, for every matched (query, target) pair. */
	back: Int32Array;
}

/** Reused scratch buffers (matching is synchronous, so calls never overlap), allocated on first use. */
let shared: Workspace | undefined;

/**
 * Allocates scratch buffers.
 * @param {number} length - Largest target length (UTF-16 code units)
 * @param {number} cells - Size of the back-pointer matrix
 * @returns {Workspace} The buffers
 */
function allocate(length: number, cells: number): Workspace {
	return {
		codes: new Int32Array(length),
		raw: new Int32Array(length),
		starts: new Int32Array(length),
		ends: new Int32Array(length),
		bonuses: new Int8Array(length),
		rows: [new Float64Array(length), new Float64Array(length)],
		back: new Int32Array(cells)
	};
}

/**
 * Folds a code point for comparison: its lower case (as `String.prototype.toLowerCase` gives it for the lone character) unless
 * `caseSensitive`, with the final sigma `'ς'` read as `'σ'`, as Unicode case folding does (`'Σ'` lower-cases to either, so `'κοσμος'`
 * matches `'ΚΟΣΜΟΣ'`). A character whose lower case is several code points (only `'İ'`) folds to itself, which no other character folds to.
 * @param {number} code - A code point
 * @param {boolean} caseSensitive - Whether case must match exactly
 * @returns {number} The folded code point
 */
function fold(code: number, caseSensitive: boolean): number {
	if (caseSensitive) return code;
	if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
	if (code === 0x3c2) return 0x3c3;
	const lower = String.fromCodePoint(code).toLowerCase();
	const folded = lower.codePointAt(0) as number;
	return String.fromCodePoint(folded) === lower ? folded : code;
}

/**
 * Lower-cases a target at once, which is much faster than folding its code points one by one (see {@link fold}) and gives the same code
 * points, at the same offsets (with the final sigma, which a capital sigma may lower-case to, read as `'σ'`), unless the target holds an
 * `'İ'` (whose lower case is two code points, so the target gets longer).
 * @param {string} target - The text searched
 * @returns {string | false} The lower-cased target, or `false` when its code points must be folded one by one (not `null`, which `??=`
 * would take as not computed yet, lower-casing the whole target again for each of its code points)
 */
function lowerTarget(target: string): string | false {
	const lower = target.toLowerCase();
	if (lower.length !== target.length) return false;
	return lower.includes('\u03c2') ? lower.replace(/\u03c2/g, '\u03c3') : lower;
}

/** The foldings computed by {@link expand}, by code point (at most 4096, then started afresh). */
const expansions = new Map<number, number[]>();

/**
 * Folds a code point for `ignoreDiacritics`, before case folding: its compatibility decomposition (NFKD), without the combining
 * diacritical marks, with the Latin letters that have no decomposition spelled in ASCII (as `toSlug` does). `'é'` and `'É'` give `e` and `E`, a combining accent nothing,
 * `'ß'` gives `ss`, `'ﬁ'` gives `fi`, `'ﬃ'` gives `ffi`, `'Ａ'` gives `A`. A code point whose folding is longer than 3 characters
 * (`'ﷺ'`, 18 characters, `'㍿'`) folds to itself instead, so that folding at most triples the length of a text.
 * @param {number} code - A code point
 * @returns {number[]} The code points it folds to (none to 3; an ASCII one folds to itself)
 */
function expand(code: number): number[] {
	let codes = expansions.get(code);
	if (codes === undefined) {
		codes = [];
		const text = transliterate(String.fromCodePoint(code).normalize('NFKD').replace(DIACRITICS, ''));
		for (const char of text) codes.push(char.codePointAt(0) as number);
		// A folding longer than 3 characters (`'ﷺ'` decomposes to 18, `'㍿'` to 4) is not kept, so that folding at most triples the text.
		if (codes.length > 3) codes = [code];
		if (expansions.size === 4096) expansions.clear();
		expansions.set(code, codes);
	}
	return codes;
}

/** The case-folded foldings computed by {@link expandFolded}, by code point (at most 4096, then started afresh). */
const foldedExpansions = new Map<number, number[]>();

/**
 * Folds a code point for `ignoreDiacritics` without case sensitivity: {@link expand}, then {@link fold} on each character.
 * @param {number} code - A code point
 * @returns {number[]} The case-folded code points it folds to (as many as `expand` gives)
 */
function expandFolded(code: number): number[] {
	let codes = foldedExpansions.get(code);
	if (codes === undefined) {
		codes = [];
		for (const char of expand(code)) codes.push(fold(char, false));
		if (foldedExpansions.size === 4096) foldedExpansions.clear();
		foldedExpansions.set(code, codes);
	}
	return codes;
}

/** The classes computed by {@link classify} for non-ASCII code points (at most 4096, then started afresh). */
const classes = new Map<number, number>();

/**
 * Classifies a code point for the word-start bonus.
 * @param {number} code - A code point
 * @returns {number} A combination of `WORD_CHAR`, `LOWER_CASE` and `UPPER_CASE`
 */
function classify(code: number): number {
	if (code < 128) return code >= 97 && code <= 122 ? WORD_CHAR | LOWER_CASE : code >= 65 && code <= 90 ? WORD_CHAR | UPPER_CASE : code >= 48 && code <= 57 ? WORD_CHAR : 0;
	let type = classes.get(code);
	if (type === undefined) {
		const char = String.fromCodePoint(code);
		type = (WORD.test(char) ? WORD_CHAR : 0) | (char === char.toUpperCase() ? 0 : LOWER_CASE) | (char === char.toLowerCase() ? 0 : UPPER_CASE);
		if (classes.size === 4096) classes.clear();
		classes.set(code, type);
	}
	return type;
}

/**
 * Word-start bonus of a target position after the first one (which always gets `BOUNDARY`): a letter or digit after any other character
 * (a combining mark belongs to the letter before it), or a camelCase hump.
 * @param {number} previous - The class (see {@link classify}) of the character before the position
 * @param {number} current - The class of the character at the position
 * @returns {number} `BOUNDARY` or `0`
 */
function bonus(previous: number, current: number): number {
	return (current & WORD_CHAR && !(previous & WORD_CHAR)) || (previous & LOWER_CASE && current & UPPER_CASE) ? BOUNDARY : 0;
}

/**
 * Splits and folds a query.
 * @param {string} query - The query
 * @param {boolean} caseSensitive - Whether case must match exactly
 * @param {boolean} diacritics - Whether diacritics are ignored
 * @returns {PreparedQuery} Its characters (code points, or their foldings with `diacritics`), original and folded
 */
function prepare(query: string, caseSensitive: boolean, diacritics: boolean): PreparedQuery {
	const raw: number[] = [];
	const codes: number[] = [];
	let needles: number[] | undefined = [];
	const chars: string[] = [];
	for (let k = 0; k < query.length; k++) {
		const code = query.codePointAt(k) as number;
		const folded = fold(code, caseSensitive);
		if (code > 127) {
			needles = undefined;
			if (code > 0xffff) k++;
			if (diacritics) {
				for (const char of expand(code)) {
					raw.push(char);
					codes.push(fold(char, caseSensitive));
				}
				continue;
			}
		}
		raw.push(code);
		codes.push(folded);
		if (needles !== undefined) {
			// Without case sensitivity, an ASCII letter matches its two cases, and 'k' also the Kelvin sign (whose lower case is 'k').
			const char = query[k];
			const alternatives = caseSensitive || folded < 97 || folded > 122 ? char : folded === 107 ? 'kK\u212A' : String.fromCharCode(folded, folded - 32);
			let packed = 0;
			for (let a = alternatives.length - 1; a >= 0; a--) {
				const index = chars.indexOf(alternatives[a]);
				packed = (packed << 8) | (index === -1 ? chars.push(alternatives[a]) : index + 1);
			}
			needles.push(packed);
		}
	}
	return { codes, raw, needles, chars, next: [], diacritics };
}

/**
 * Whether `target` contains, in order, one of the characters of every needle (the subsequence test for ASCII queries, done with `indexOf`).
 * The next position found for each character is remembered, so that `indexOf` only runs again once the search has moved past it, and
 * never for a character with none left: every character scans the target at most once, keeping the test O(target length).
 * @param {number[]} needles - The characters matched by each query character (see `PreparedQuery`)
 * @param {string[]} chars - The characters
 * @param {number[]} next - Scratch space for the positions of the characters (reset here)
 * @param {string} target - The text searched
 * @returns {boolean} `false` when the query cannot match
 */
function contains(needles: number[], chars: string[], next: number[], target: string): boolean {
	// `-2`: not looked for yet.
	for (let c = 0; c < chars.length; c++) next[c] = -2;
	let from = 0;
	for (const alternatives of needles) {
		let found = -1;
		for (let packed = alternatives; packed !== 0; packed >>>= 8) {
			const needle = (packed & 255) - 1;
			let index = next[needle];
			if (index === -2 || (index >= 0 && index < from)) next[needle] = index = target.indexOf(chars[needle], from);
			if (index >= 0 && (found < 0 || index < found)) found = index;
		}
		if (found < 0) return false;
		from = found + 1;
	}
	return true;
}

/**
 * Unvalidated implementation of {@link fuzzyMatch}: finds the best-scoring alignment with an O(n·m) dynamic program.
 *
 * `row[j]` holds the best score of an alignment of the first `i + 1` query characters whose last one is matched at target
 * position `j`. Gap penalties are affine, so the best gapped predecessor is maintained incrementally (Gotoh's algorithm):
 * `gap = max(gap + GAP_EXTENSION, previousRow[j - 2] + GAP_START)`.
 * @param {PreparedQuery} query - The prepared query
 * @param {string} target - The text searched
 * @param {boolean} caseSensitive - Whether case must match exactly
 * @param {string} caller - Name of the public function, for the error message
 * @returns {FuzzyMatch | undefined} The best alignment, or `undefined` when the query is not a subsequence of the target
 * @throws {RangeError} when the back-pointer matrix would exceed `MAX_CELLS` cells
 */
function match(query: PreparedQuery, target: string, caseSensitive: boolean, caller: string): FuzzyMatch | undefined {
	const q = query.codes;
	const m = q.length;
	const length = target.length;

	if (m === 0) return { score: 0, ranges: [] };
	// With `ignoreDiacritics`, only a target with non-ASCII text needs folding: an ASCII code point folds to itself.
	const diacritics = query.diacritics && NON_ASCII.test(target);
	// Fast rejections (the common case while filtering), without allocating: a target has at most `length` code points (but with
	// `ignoreDiacritics`, one of them may fold to several characters), and an ASCII query is looked for with `indexOf` (but with
	// `ignoreDiacritics`, an accented letter of the target matches its ASCII base).
	const filtered = query.needles !== undefined && !diacritics;
	if ((m > length && !diacritics) || (filtered && !contains(query.needles as number[], query.chars, query.next, target))) return undefined;
	// The number of characters of the target: its length bounds them, except with `ignoreDiacritics`, where they are counted first.
	let capacity = diacritics ? 0 : length;
	// The target lower-cased at once, to fold its non-ASCII code points (see `lowerTarget`), once the first one is met.
	let lower: string | false | undefined;
	if (!filtered) {
		// Greedy subsequence check (the alignment only exists if it passes, and the buffers are only filled then), unless `contains` did it.
		let matched = 0;
		for (let k = 0; k < length && (diacritics || matched < m);) {
			const code = target.codePointAt(k) as number;
			if (diacritics) {
				const chars = caseSensitive ? expand(code) : expandFolded(code);
				for (let c = 0; c < chars.length; c++) if (chars[c] === q[matched]) matched++;
				capacity += chars.length;
			} else if ((code < 128 || caseSensitive || (lower ??= lowerTarget(target)) === false ? fold(code, caseSensitive) : lower.codePointAt(k)) === q[matched]) matched++;
			k += code > 0xffff ? 2 : 1;
		}
		if (matched < m) return undefined;
	}

	// The linear buffers first: the O(m·n) back-pointer matrix is only allocated once the subsequence check has passed.
	const small = capacity <= SHARED_LENGTH;
	const workspace = small ? (shared ??= allocate(SHARED_LENGTH, SHARED_CELLS)) : allocate(capacity, 0);
	const { codes, raw, starts, ends, bonuses, rows } = workspace;
	let n = 0;
	// The first character of the last code point that folded to some: a combining mark that folds to none extends its range.
	let group = 0;
	for (let k = 0; k < length;) {
		const code = target.codePointAt(k) as number;
		const start = k;
		k += code > 0xffff ? 2 : 1;
		if (diacritics) {
			const chars = expand(code);
			const folded = caseSensitive ? chars : expandFolded(code);
			if (chars.length === 0) ends.fill(k, group, n);
			else group = n;
			for (let c = 0; c < chars.length; c++) {
				starts[n] = start;
				ends[n] = k;
				raw[n] = chars[c];
				codes[n++] = folded[c];
			}
		} else {
			starts[n] = start;
			ends[n] = k;
			raw[n] = code;
			codes[n++] = code < 128 || caseSensitive || (lower ??= lowerTarget(target)) === false ? fold(code, caseSensitive) : (lower.codePointAt(start) as number);
		}
	}
	const cells = m * n;
	// An explicit cap: past a few GiB, V8 aborts the process instead of throwing when allocating the matrix.
	if (cells > MAX_CELLS) throw new RangeError(`${caller}: the query and text are too long to align (${m} × ${n} code points, more than ${MAX_CELLS} cells)`);
	const back = small && cells <= SHARED_CELLS ? workspace.back : new Int32Array(cells);
	// Each character is classified once, for its own bonus and the next one's.
	for (let j = 0, previous = 0; j < n; j++) {
		const current = classify(raw[j]);
		bonuses[j] = j === 0 ? BOUNDARY : bonus(previous, current);
		previous = current;
	}

	let [row, previousRow] = rows;
	for (let j = 0; j < n; j++) row[j] = codes[j] === q[0] ? MATCH + bonuses[j] + (raw[j] === query.raw[0] ? EXACT_CASE : 0) - Math.min(j, MAX_LEADING_PENALTY) : -Infinity;
	for (let i = 1; i < m; i++) {
		const swap = previousRow;
		previousRow = row;
		row = swap;
		const code = q[i];
		const exact = query.raw[i];
		// Best score of an alignment of the previous query characters ending at least two positions before `j` (gap of >= 1).
		let gap = -Infinity;
		let gapFrom = 0;
		for (let j = i; j < n; j++) {
			if (codes[j] === code) {
				const consecutive = previousRow[j - 1] + CONSECUTIVE;
				const isConsecutive = consecutive >= gap;
				row[j] = (isConsecutive ? consecutive : gap) + MATCH + bonuses[j] + (raw[j] === exact ? EXACT_CASE : 0);
				back[i * n + j] = isConsecutive ? j - 1 : gapFrom;
			} else row[j] = -Infinity;
			// Extend the gap for position j + 1, or open one after position j - 1.
			gap += GAP_EXTENSION;
			const open = previousRow[j - 1] + GAP_START;
			if (open >= gap) {
				gap = open;
				gapFrom = j - 1;
			}
		}
	}

	let score = -Infinity;
	let end = 0;
	for (let j = m - 1; j < n; j++) {
		if (row[j] > score) {
			score = row[j];
			end = j;
		}
	}

	// Walk the back pointers from the last matched character, building the ranges from right to left.
	const ranges: Array<[number, number]> = [];
	for (let i = m - 1; i >= 0; i--) {
		// Not `ranges[-1]` when there is none yet: that would read a polluted `Object.prototype['-1']` (and write to it).
		const last = ranges.length === 0 ? undefined : ranges[ranges.length - 1];
		// Characters folded from the same code point share its range: they merge, like adjacent ones.
		if (last !== undefined && last[0] <= ends[end]) last[0] = starts[end];
		else ranges.push([starts[end], ends[end]]);
		end = back[i * n + end];
	}

	return { score, ranges: ranges.reverse() };
}

/**
 * Fuzzy-matches `query` against `target` (as in command palettes and filter-as-you-type lists): the query matches when all of
 * its characters appear in the target in order, not necessarily contiguously. Among all such alignments, the one with the
 * highest score is returned, found exactly with an O(n·m) dynamic program (in the spirit of fzf's v2 algorithm / Smith–Waterman).
 *
 * Scoring (all integers, so results are deterministic) — each matched character earns `16`, plus:
 * - `+8` when it starts a word: first character of the target, a letter/digit after any other character (space, `-`, `_`, `.`, `/`...),
 *   or an upper-case letter after a lower-case one (camelCase);
 * - `+5` when it directly follows the previous matched character;
 * - `+1` when its case is exactly the query's;
 * - a gap of `g` skipped characters between two matched characters costs `3 + (g - 1)`;
 * - characters skipped before the first match cost `1` each, at most `8` in total.
 *
 * So an exact prefix always scores at least as much as the same query scattered over word starts, and shorter, tighter, earlier matches rank higher.
 * Among equally-scored alignments the one ending first is chosen, preferring consecutive matches, then the shortest gaps.
 *
 * Characters are compared per Unicode code point after `toLowerCase()` (locale-independent, with the final sigma `'ς'` read as `'σ'`, so
 * `'κοσμος'` matches `'ΚΟΣΜΟΣ'`; skipped when `caseSensitive`), so the ranges never split a surrogate pair. By default there is no
 * normalization and no grapheme segmentation: a precomposed `'é'` does not match `'e'` + combining accent, characters whose lower case
 * expands (`'İ'`) only match themselves, and ranges may split multi-code-point graphemes (flags, ZWJ emoji).
 *
 * With `ignoreDiacritics` (default `false`, as in fuse.js), both strings are folded per code point the way `toSlug` folds letters, before
 * case folding: compatibility decomposition (NFKD), combining diacritical marks (U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF,
 * U+FE20–FE2F) removed, and `ß`, `æ`, `œ`, `ø`, `đ`, `ð`, `ł`, `þ`, `ı` (and their capitals) spelled `ss`, `ae`, `oe`, `o`, `d`, `d`, `l`,
 * `th`, `i`. So `'cafe'` matches `'Café'` and `'Cafe\u0301'`, `'strasse'` matches `'Straße'`, `'fi'` matches the ligature `'ﬁ'`,
 * `'Ａ'` matches `'a'`, and Hangul syllables are compared by their jamo (`'하'` matches `'한'`). The ranges still index the original target: a combining mark is
 * highlighted with its letter, and a code point that folds to several characters (`'ß'`) is highlighted whole when any of them
 * matches. Scores count folded characters (`'ß'` scores as `'ss'`), and the `+1` bonus rewards the same case with the accents removed,
 * so a target scores the same in NFC and NFD. Other marks (Indic vowel signs, kana voicing marks) are kept as characters of their own.
 * A code point whose folding is longer than 3 characters (`'ﷺ'`, which decomposes to an 18-character phrase, or `'㍿'`) is kept as it
 * is, so that folding at most triples either string (`'ﬃ'` still matches `'ffi'`).
 *
 * An empty query (or one made only of combining accents, with `ignoreDiacritics`) matches every target with score `0` and no ranges.
 *
 * Cost: a query longer than the target, or that is not a subsequence of it, is rejected in O(target length) time without
 * allocating more than O(target length). A matching query costs O(query length × target length) time and a back-pointer matrix of
 * 4 bytes per (query code point, target code point) pair, at most `2 ** 28` pairs (1 GiB, e.g. a 1 000-character query against a
 * 268 000-character text): larger alignments throw a `RangeError`. With `ignoreDiacritics`, the lengths are those of the folded
 * strings, at most 3 times the original ones, so the time and the matrix grow by at most 9 times. Cap the query length of untrusted input (search boxes: 64–256 characters is plenty, e.g. `query.slice(0, 128)`), and the
 * target lengths if they are untrusted too.
 * @param {string} query - The characters to look for, in order
 * @param {string} target - The text to search in
 * @param {FuzzyMatchOptions} [options={}] - `caseSensitive` and `ignoreDiacritics` (both default `false`)
 * @returns {FuzzyMatch | undefined} The score and matched ranges of the best alignment, or `undefined` when the query is not a subsequence of the target
 * @throws {TypeError} when `query` or `target` is not a string
 * @throws {RangeError} when the back-pointer matrix of a matching query would exceed `2 ** 28` cells (see the cost above)
 * @example
 * fuzzyMatch('fb', 'fooBar'); // => { score: 45, ranges: [[0, 1], [3, 4]] }
 * fuzzyMatch('bar', 'fooBar'); // => { score: 65, ranges: [[3, 6]] }
 * fuzzyMatch('rab', 'fooBar'); // => undefined
 * fuzzyMatch('', 'anything'); // => { score: 0, ranges: [] }
 * @example
 * // Word starts and consecutive runs beat scattered matches:
 * fuzzyMatch('gc', 'git commit').score > fuzzyMatch('gc', 'magic').score; // => true
 * fuzzyMatch('ab', 'Ab', { caseSensitive: true }); // => undefined
 * fuzzyMatch('κοσμος', 'Ο ΚΟΣΜΟΣ')?.ranges; // => [[2, 8]]
 * @example
 * fuzzyMatch('cafe', 'Café'); // => undefined
 * fuzzyMatch('cafe', 'Café', { ignoreDiacritics: true })?.ranges; // => [[0, 4]]
 * fuzzyMatch('cafe', 'Cafe\u0301 noir', { ignoreDiacritics: true })?.ranges; // => [[0, 5]] // the accent is highlighted with its letter
 * fuzzyMatch('strasse', 'Straße', { ignoreDiacritics: true })?.ranges; // => [[0, 6]]
 */
export function fuzzyMatch(query: string, target: string, options: FuzzyMatchOptions = {}): FuzzyMatch | undefined {
	assertString('fuzzyMatch', 'query', query);
	assertString('fuzzyMatch', 'target', target);
	const caseSensitive = readOption(options, 'caseSensitive') === true;
	return match(prepare(query, caseSensitive, readOption(options, 'ignoreDiacritics') === true), target, caseSensitive, 'fuzzyMatch');
}

/**
 * Fuzzy-filters and ranks `items` by how well they match `query` (see {@link fuzzyMatch} for the matching and scoring rules).
 * Results are sorted by descending score; ties keep the original order of `items`. An empty query matches every text with score `0`,
 * so the full list (up to `limit`) is returned in its original order, except items for which `key` returns no text (an empty array).
 *
 * Cost: up to O(query length × text length) time and memory per searched text (see {@link fuzzyMatch}); cap the length of
 * untrusted queries.
 * @template T - The type of the searched items
 * @param {Iterable<T>} items - The items to search; strings unless `key` is given
 * @param {string} query - The characters to look for, in order
 * @param {FuzzySearchOptions<T>} [options={}] - `key` (text(s) of an item, best one wins), `limit`, `threshold` (minimum score), `caseSensitive`, `ignoreDiacritics`
 * @returns {Array<FuzzySearchResult<T>>} The matching items with their score, matched `key` text and its `ranges`, best first
 * @throws {TypeError} when `query` is not a string, `key` is not a function, or an item (without `key`) / a text returned by `key` is not a string
 * @throws {RangeError} when `limit` is not an integer >= 0 (or `Infinity`), or `threshold` is `NaN`, or a matching query and text are too
 * large for their back-pointer matrix (see {@link fuzzyMatch})
 * @example
 * fuzzySearch(['src/index.ts', 'README.md', 'src/search/index.ts'], 'sri').map(function (r) { return r.item; }); // => ['src/index.ts', 'src/search/index.ts']
 * @example
 * const commands = [{ title: 'Open File', id: 'open' }, { title: 'Find in Files', id: 'find' }, { title: 'Format Document', id: 'format' }];
 * const results = fuzzySearch(commands, 'ff', { key: function (c) { return c.title; }, limit: 1 });
 * results.map(function (r) { return r.item.id; }); // => ['find']
 * results[0].ranges; // => [[0, 1], [8, 9]]
 * @example
 * fuzzySearch(['Málaga', 'Zürich', 'Łódź'], 'lodz', { ignoreDiacritics: true }).map(function (r) { return r.item; }); // => ['Łódź']
 */
export function fuzzySearch<T extends string>(items: Iterable<T>, query: string, options?: FuzzySearchOptions<T>): Array<FuzzySearchResult<T>>;
export function fuzzySearch<T>(items: Iterable<T>, query: string, options: FuzzySearchKeyedOptions<T>): Array<FuzzySearchResult<T>>;
export function fuzzySearch<T>(items: Iterable<T>, query: string, options: FuzzySearchOptions<T> = {}): Array<FuzzySearchResult<T>> {
	// Read as own (or class) properties, like every option of the module: a polluted `Object.prototype` must not supply a `key` to call.
	const key = readOption(options, 'key');
	const limit = readOption(options, 'limit', Infinity);
	const threshold = readOption(options, 'threshold', -Infinity);
	const caseSensitive = readOption(options, 'caseSensitive') === true;
	assertString('fuzzySearch', 'query', query);
	if (key !== undefined) assertFunction('fuzzySearch', 'key', key);
	assertInteger('fuzzySearch', 'limit', limit, 0, true);
	assertNumber('fuzzySearch', 'threshold', threshold, !Number.isNaN(threshold), 'a number');

	const prepared = prepare(query, caseSensitive, readOption(options, 'ignoreDiacritics') === true);
	const name = key === undefined ? 'item' : 'key(item)';
	const results: Array<FuzzySearchResult<T>> = [];
	/**
	 * Matches an item, keeping it in the results when it matches well enough.
	 * @param {T} item - The item
	 * @returns {void}
	 */
	function visit(item: T): void {
		const texts: unknown = key === undefined ? item : key(item);
		let best: FuzzySearchResult<T> | undefined;
		// Several texts per item only come from `key`: without it, an array item is rejected like any other non-string.
		if (key !== undefined && Array.isArray(texts)) {
			for (let t = 0; t < texts.length; t++) {
				const text = elementAt(texts, t);
				assertString('fuzzySearch', name, text);
				const result = match(prepared, text, caseSensitive, 'fuzzySearch');
				if (result !== undefined && (best === undefined || result.score > best.score)) best = { item, key: text, score: result.score, ranges: result.ranges };
			}
		} else {
			assertString('fuzzySearch', name, texts);
			const result = match(prepared, texts, caseSensitive, 'fuzzySearch');
			if (result !== undefined) best = { item, key: texts, score: result.score, ranges: result.ranges };
		}
		// Pruned as they come, so that a small `limit` keeps few results (not one per matching item) whatever the number of items.
		if (best !== undefined && best.score >= threshold && results.push(best) > 2 * limit + 64) prune();
	}
	/**
	 * Sorts the results, best first (ties keep their order: the sort is stable, and the kept ones come before the newer ones), and keeps the first `limit`.
	 * @returns {void}
	 */
	function prune(): void {
		results.sort(function (a, b) {
			return b.score - a.score;
		});
		if (results.length > limit) results.length = limit;
	}
	// An array is read by index, so that a hole is `undefined` (see `elementAt`).
	if (Array.isArray(items)) for (let i = 0; i < items.length; i++) visit(elementAt(items as T[], i) as T);
	else for (const item of items) visit(item);

	prune();
	return results;
}

/**
 * Splits `text` into alternating matched / unmatched segments, e.g. to render the `ranges` of {@link fuzzyMatch} with `<mark>`
 * elements in React (no `dangerouslySetInnerHTML` needed). Ranges are half-open `[start, end)` UTF-16 indices; they may be given
 * in any order and may overlap or touch (they are merged). Empty ranges are ignored. Segments are never empty, and two consecutive
 * segments never have the same `match` flag.
 * @param {string} text - The text to split
 * @param {Iterable<readonly [number, number]>} ranges - The `[start, end)` ranges to mark
 * @returns {HighlightSegment[]} Segments whose texts concatenate back to `text` (`[]` for an empty text)
 * @throws {TypeError} when `text` is not a string or a bound is not a number
 * @throws {RangeError} when a bound is not an integer, or not `0 <= start <= end <= text.length`
 * @example
 * highlight('fooBar', [[0, 1], [3, 4]]); // => [{ text: 'f', match: true }, { text: 'oo', match: false }, { text: 'B', match: true }, { text: 'ar', match: false }]
 * highlight('abc', [[1, 2], [0, 2]]); // => [{ text: 'ab', match: true }, { text: 'c', match: false }]
 * highlight('abc', [[2, 5]]); // throws RangeError
 * @example
 * // doctest: skip
 * const { ranges } = fuzzyMatch(query, label) ?? { ranges: [] };
 * highlight(label, ranges).map(function (s, i) { return s.match ? <mark key={i}>{s.text}</mark> : s.text; });
 */
export function highlight(text: string, ranges: Iterable<readonly [number, number]>): HighlightSegment[] {
	assertString('highlight', 'text', text);
	const length = text.length;
	const sorted: Array<[number, number]> = [];
	/**
	 * Validates a range and keeps it unless it is empty.
	 * @param {readonly [number, number]} range - The range
	 * @returns {void}
	 */
	function visit(range: readonly [number, number]): void {
		const [start, end] = Array.isArray(range) ? [elementAt(range, 0) as number, elementAt(range, 1) as number] : range;
		// The messages are only built for invalid bounds.
		if (!(Number.isInteger(start) && start >= 0 && start <= length)) assertNumber('highlight', 'start', start, false, `an integer between 0 and ${length}`);
		if (!(Number.isInteger(end) && end >= start && end <= length)) assertNumber('highlight', 'end', end, false, `an integer between ${start} and ${length}`);
		if (end > start) sorted.push([start, end]);
	}
	// Arrays are read by index, so that a hole is `undefined` (see `elementAt`); other iterables one range at a time, so that an invalid
	// range throws before the rest is read (an array-like with a huge length is not copied first).
	if (Array.isArray(ranges)) for (let i = 0; i < ranges.length; i++) visit(elementAt(ranges, i) as readonly [number, number]);
	else for (const range of ranges) visit(range);
	sorted.sort(function (a, b) {
		return a[0] - b[0];
	});

	const segments: HighlightSegment[] = [];
	// End of the text covered so far, and the matched segment that ends there (extended by overlapping or adjacent ranges).
	let cursor = 0;
	let open: HighlightSegment | undefined;
	for (const [start, end] of sorted) {
		// A range that overlaps or touches the covered text extends the open segment (by nothing when it ends inside it).
		if (open !== undefined && start <= cursor) open.text += text.slice(cursor, end);
		else {
			if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
			open = { text: text.slice(start, end), match: true };
			segments.push(open);
		}
		cursor = Math.max(cursor, end);
	}
	if (cursor < length) segments.push({ text: text.slice(cursor), match: false });
	return segments;
}

// ---------------------------------------------------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A word segmenter, such as `new Intl.Segmenter(locale, { granularity: 'word' })`: splits a text into consecutive segments.
 */
export interface WordSegmenter {
	/** Splits `text` into consecutive segments (concatenated, they give back `text`). */
	segment(text: string): Iterable<{ segment: string }>;
}

/**
 * Options accepted by {@link tokenize}.
 */
export interface TokenizeOptions {
	/**
	 * When `true`, tokens keep their case.
	 * @default false
	 */
	caseSensitive?: boolean;
	/**
	 * When `true`, accents and other diacritics are removed and letters are folded as {@link fuzzyMatch} folds them, without its length cap (`'Crème'` gives `'creme'`).
	 * See {@link tokenize}.
	 * @default false
	 */
	ignoreDiacritics?: boolean;
	/**
	 * Tokens with fewer code points are dropped (an integer `>= 1`).
	 * @default 1
	 */
	minLength?: number;
	/** Tokens to drop, compared with the final tokens (so give them lower-cased, and folded with `ignoreDiacritics`). */
	stopWords?: ReadonlySet<string>;
	/**
	 * Word segmenter for scripts written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese), typically
	 * `new Intl.Segmenter(locale, { granularity: 'word' })`: the text is also split at every boundary between its segments.
	 */
	segmenter?: WordSegmenter;
}

/** A word: a letter or digit, then letters, digits and combining marks (which belong to the letter before them), in any script. */
const WORDS = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
/** A format character (soft hyphen, zero-width joiners and spaces, bidirectional marks, word joiner, BOM...). */
const FORMAT = /\p{Cf}/gu;

/**
 * Replaces a format character before tokenizing: as in Unicode word segmentation (UAX #29), a zero-width space separates words and
 * the other format characters are ignored (`'co­operate'`, with a soft hyphen, is one word).
 * @param {string} char - A format character
 * @returns {string} A space for U+200B ZERO WIDTH SPACE, nothing for the others
 */
function unformat(char: string): string {
	return char === '​' ? ' ' : '';
}

/**
 * A capital sigma whose lower case may depend on the text outside its word: `toLowerCase` makes it final (`'ς'`) when a cased letter comes
 * before it and none after it, looking across case-ignorable characters, which include punctuation between words (`.`, `'`, `’`, `:`),
 * so the same word would give different tokens (`'ΟΔΟΣ.Α'` lower-cases to `'οδοσ.α'`). The text is then lower-cased word by word. Matched
 * when the sigma is followed or preceded, across case-ignorable characters only, by one that is outside words and cased or case-ignorable.
 * Linear: each alternative scans the case-ignorable characters next to one sigma.
 */
const SIGMA_CONTEXT =
	/\u03a3\p{Case_Ignorable}*(?![\p{L}\p{M}\p{N}])[\p{Case_Ignorable}\p{Cased}]|(?<=(?![\p{L}\p{M}\p{N}])[\p{Case_Ignorable}\p{Cased}]\p{Case_Ignorable}*)\u03a3/u;

/**
 * Lower-cases a word (a callback for `replace`).
 * @param {string} word - The word
 * @returns {string} The lower-cased word
 */
function toLowerCase(word: string): string {
	return word.toLowerCase();
}

/** More than 30 consecutive combining marks (or halfwidth kana voiced sound marks, which decompose to combining marks). */
const LONG_MARK_RUN = /[\p{M}\uff9e\uff9f]{31}/u;
/** 30 marks followed by another one: where {@link normalize} cuts a long run of marks. Global: only used from `lastIndex` 0. */
const MARK_RUN_PIECE = /[\p{M}\uff9e\uff9f]{30}(?=[\p{M}\uff9e\uff9f])/gu;

/**
 * Normalizes a string like `String.prototype.normalize`, in linear time. Runtimes put each run of combining marks in canonical order with
 * an insertion sort, quadratic in its length (100 000 alternating accents take seconds), so a run of more than 30 marks is normalized 30
 * marks at a time, where the Stream-Safe Text Format of UAX #15 cuts it: its marks are neither reordered nor composed across the cuts.
 * Text without such a run (all text but absurd text) is normalized exactly as the runtime does it.
 * @param {string} text - The string
 * @param {'NFC' | 'NFKD'} form - The normalization form
 * @returns {string} The normalized string
 */
function normalize(text: string, form: 'NFC' | 'NFKD'): string {
	if (!hasLongMarkRun(text)) return text.normalize(form);
	let result = '';
	let start = 0;
	MARK_RUN_PIECE.lastIndex = 0;
	while (MARK_RUN_PIECE.test(text)) {
		result += text.slice(start, MARK_RUN_PIECE.lastIndex).normalize(form);
		start = MARK_RUN_PIECE.lastIndex;
	}
	return result + text.slice(start).normalize(form);
}

/**
 * Whether a text holds more than 30 consecutive combining marks (see {@link LONG_MARK_RUN}), with a skip loop (as in Boyer–Moore) over the
 * code units that may be marks (see {@link isUnmarked}): such a run holds the code unit 30 after its start, so only that one is read, then
 * those before it back to the last one that is not a mark, from which the next run may start. The (slow) Unicode regular expression only
 * runs once 31 consecutive code units may be marks, so most text is only read in part.
 * @param {string} text - The text
 * @returns {boolean} Whether {@link LONG_MARK_RUN} matches it
 */
function hasLongMarkRun(text: string): boolean {
	// The code units from `start` to `known` may all be marks.
	let start = 0;
	let known = -1;
	while (start + 30 < text.length) {
		let index = start + 30;
		while (index > known && !isUnmarked(text.charCodeAt(index))) index--;
		if (index === known) return LONG_MARK_RUN.test(text);
		known = start + 30;
		start = index + 1;
	}
	return false;
}

/**
 * Whether a code unit is certainly not (half of) a combining mark: it is below U+0300, or a Thai, Lao, Myanmar or Khmer consonant, a kana
 * letter, a CJK ideograph or a Hangul syllable (scripts written without spaces, whose text would otherwise look like a run of marks).
 * @param {number} code - A UTF-16 code unit
 * @returns {boolean} `true` when the code unit is none of the marks {@link LONG_MARK_RUN} counts
 */
function isUnmarked(code: number): boolean {
	return (
		code < 0x300 ||
		(code >= 0xe01 && code <= 0xe30) ||
		(code >= 0xe81 && code <= 0xeb0) ||
		(code >= 0x1000 && code <= 0x102a) ||
		(code >= 0x1780 && code <= 0x17b3) ||
		(code >= 0x3041 && code <= 0x3096) ||
		(code >= 0x30a1 && code <= 0x30fa) ||
		(code >= 0x3400 && code <= 0x9fff) ||
		(code >= 0xac00 && code <= 0xd7a3)
	);
}

/**
 * Counts the code points of a string.
 * @param {string} text - The string
 * @returns {number} Its number of code points
 */
function codePoints(text: string): number {
	let count = 0;
	for (const _char of text) count++;
	return count;
}

/**
 * Unvalidated implementation of {@link tokenize}.
 * @param {string} text - The text
 * @param {boolean} caseSensitive - Whether tokens keep their case
 * @param {boolean} diacritics - Whether diacritics are removed
 * @param {number} minLength - Smallest number of code points of a token
 * @param {ReadonlySet<string> | undefined} stopWords - Tokens to drop
 * @param {WordSegmenter | undefined} segmenter - Additional word boundaries
 * @returns {string[]} The tokens
 * @throws {TypeError} when a segment is not a string
 */
function words(
	text: string,
	caseSensitive: boolean,
	diacritics: boolean,
	minLength: number,
	stopWords: ReadonlySet<string> | undefined,
	segmenter: WordSegmenter | undefined
): string[] {
	// ASCII text has no format characters or diacritics, and is in NFC (the segments of a segmenter are pieces of the text).
	const nonAscii = NON_ASCII.test(text);
	let prepared = nonAscii ? text.replace(FORMAT, unformat) : text;
	if (segmenter !== undefined) {
		const segments: string[] = [];
		// The segmenter sees the text in NFC, the form of its dictionaries.
		for (const { segment } of segmenter.segment(normalize(prepared, 'NFC'))) {
			assertString('tokenize', 'segment', segment);
			segments.push(segment);
		}
		prepared = segments.join(' ');
	}
	if (diacritics && nonAscii) prepared = transliterate(normalize(prepared, 'NFKD').replace(DIACRITICS, ''));
	// Word by word when a capital sigma touches the text between words (see `SIGMA_CONTEXT`).
	if (!caseSensitive) prepared = nonAscii && SIGMA_CONTEXT.test(prepared) ? prepared.replace(WORDS, toLowerCase) : prepared.toLowerCase();
	// Composed last, so that tokens are always in NFC: folding decomposes the text, and lower-casing can make characters composable
	// (`'J'` + caron, which has no precomposed form, gives `'ǰ'`).
	if (nonAscii) prepared = normalize(prepared, 'NFC');
	const tokens = (prepared.match(WORDS) ?? []) as string[];
	if (minLength === 1 && stopWords === undefined) return tokens;
	let kept = 0;
	for (const token of tokens) if ((minLength === 1 || codePoints(token) >= minLength) && !stopWords?.has(token)) tokens[kept++] = token;
	tokens.length = kept;
	return tokens;
}

/**
 * Splits `text` into lower-cased words, for indexing and full-text search (see {@link createSearchIndex}). A word is a letter or digit
 * of any script followed by letters, digits and combining marks (`\p{L}`, `\p{N}`, and `\p{M}` attached to the letter before it);
 * everything else separates words: spaces, punctuation, symbols, emoji, and also apostrophes, hyphens and underscores (`"don't"` gives
 * `'don'` and `'t'`, `'e-mail'` gives `'e'` and `'mail'`). Tokens are extracted in one pass of a single regular expression (after the
 * normalization and lower-casing passes below), so the cost is linear in the text: runtimes normalize a long run of combining marks in
 * quadratic time, so a run of more than 30 marks (which no language needs) is normalized 30 marks at a time, as the Stream-Safe Text
 * Format of UAX #15 cuts it.
 *
 * Before splitting, format characters are ignored as in Unicode word segmentation (UAX #29): a soft hyphen, zero-width joiner or
 * non-joiner, word joiner, bidirectional mark or BOM inside a word does not split it, and a zero-width space separates words. The text
 * is lower-cased with `toLowerCase()` (locale-independent: `'I'` gives `'i'` even in Turkish, `'İ'` gives `'i̇'` with a combining
 * dot, and a capital sigma becomes `'ς'` at the end of a word, whatever follows it: `'ΟΔΟΣ'`, `'ΟΔΟΣ.'` and `"ΟΔΟΣ'Α"` all give
 * `'οδος'`, as the lower-case `'οδος'` does), unless `caseSensitive`, then normalized to NFC: tokens are always in NFC, so a
 * precomposed `'é'` and `'e'` + combining accent give the same token, and so do `'ǰ'` and `'J'` + caron.
 *
 * With `ignoreDiacritics`, the text is folded before splitting with the rules of {@link fuzzyMatch}'s `ignoreDiacritics` (compatibility
 * decomposition, combining diacritical marks removed, `ß`, `æ`, `œ`, `ø`, `đ`, `ð`, `ł`, `þ`, `ı` spelled in ASCII), applied to the whole
 * text, then recomposed (NFC): `'Ｃａｆé'` gives `'cafe'`, `'Straße'` gives `'strasse'`, `'ﬁle'` gives `'file'`, `'İ'` gives `'i'`,
 * `'①'` gives `'1'`. Unlike {@link fuzzyMatch}, which keeps a code point whose folding is longer than 3 characters to bound its
 * quadratic cost, every folding is applied (`'ﷺ'` gives the 4 words of its decomposition): the cost stays linear.
 *
 * Scripts written without spaces are not segmented by default: a run of Chinese, Japanese or Thai letters is a single token. Pass an
 * `Intl.Segmenter` with `granularity: 'word'` as `segmenter` to split it into dictionary words as well (much slower: ICU's segmenter
 * runs on the whole text).
 * @param {string} text - The text to split
 * @param {TokenizeOptions} [options={}] - `caseSensitive`, `ignoreDiacritics` (both default `false`), `minLength` (default `1`), `stopWords`, `segmenter`
 * @returns {string[]} The tokens, in order (with repetitions)
 * @throws {TypeError} when `text` is not a string, `stopWords` is not a `Set`, `segmenter` has no `segment` method or gives a segment that is not a string
 * @throws {RangeError} when `minLength` is not an integer `>= 1`
 * @example
 * tokenize('Hello, World! Ünïcode-aware: 42 × π'); // => ['hello', 'world', 'ünïcode', 'aware', '42', 'π']
 * tokenize('Crème brûlée à Zürich', { ignoreDiacritics: true }); // => ['creme', 'brulee', 'a', 'zurich']
 * tokenize('The cat and a hat', { stopWords: new Set(['the', 'and']), minLength: 2 }); // => ['cat', 'hat']
 * tokenize("Η ΟΔΟΣ. ΟΔΟΣ'Α"); // => ['η', 'οδος', 'οδος', 'α']
 * @example
 * tokenize('東京都に住む'); // => ['東京都に住む']
 * tokenize('東京都に住む', { segmenter: new Intl.Segmenter('ja', { granularity: 'word' }) }).length > 1; // => true
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
	assertString('tokenize', 'text', text);
	const minLength = readOption(options, 'minLength', 1);
	assertInteger('tokenize', 'options.minLength', minLength, 1);
	const stopWords = readOption(options, 'stopWords');
	if (stopWords !== undefined && typeof (stopWords as Partial<ReadonlySet<string>> | null)?.has !== 'function') {
		throw new TypeError(`tokenize: \`options.stopWords\` must be a Set, got ${typeName(stopWords)}`);
	}
	const segmenter = readOption(options, 'segmenter');
	if (segmenter !== undefined && typeof (segmenter as Partial<WordSegmenter> | null)?.segment !== 'function') {
		throw new TypeError(`tokenize: \`options.segmenter\` must be an Intl.Segmenter, got ${typeName(segmenter)}`);
	}
	return words(text, readOption(options, 'caseSensitive') === true, readOption(options, 'ignoreDiacritics') === true, minLength, stopWords, segmenter);
}

// ---------------------------------------------------------------------------------------------------------------------
// createSearchIndex
// ---------------------------------------------------------------------------------------------------------------------

/** The id of a document in a {@link SearchIndex}: a string or a number (compared with SameValueZero, so `0` and `-0` are the same id). */
export type SearchId = string | number;

/**
 * Options accepted by {@link createSearchIndex}.
 * @template T - The type of the indexed documents
 */
export interface SearchIndexOptions<T> {
	/**
	 * The fields to index: their names (each with a boost of `1`), or an object mapping each name to its boost, a finite number `> 0` by
	 * which the field's BM25 score is multiplied (`{ title: 2, body: 1 }`).
	 */
	fields: ReadonlyArray<string> | Readonly<Record<string, number>>;
	/**
	 * Name of the property that holds each document's id (a string or a number, unique in the index).
	 * @default 'id'
	 */
	id?: string;
	/**
	 * Reads the text of a field: a string, an array of strings (tags, paragraphs), or `null`/`undefined` for none. By default, the
	 * document's property of that name (its own, or inherited from its class, but never from a polluted `Object.prototype`).
	 */
	extract?: (document: T, field: string) => string | ReadonlyArray<string> | null | undefined;
	/**
	 * Splits field texts and queries into terms (it must return an array of strings; empty strings are ignored). Wrap {@link tokenize}
	 * to change its options, e.g. `function (text) { return tokenize(text, { ignoreDiacritics: true }); }`.
	 * @default tokenize
	 */
	tokenize?: (text: string) => ReadonlyArray<string>;
	/**
	 * BM25 term-frequency saturation (a finite number `>= 0`; `0` ignores how often a term occurs).
	 * @default 1.2
	 */
	k1?: number;
	/**
	 * BM25 length normalization, between `0` (field length ignored) and `1` (term frequencies fully relative to the length).
	 * @default 0.75
	 */
	b?: number;
}

/**
 * Options accepted by {@link SearchIndex.search}.
 * @template T - The type of the indexed documents
 */
export interface SearchIndexQueryOptions<T> {
	/**
	 * Maximum number of results.
	 * @default Infinity
	 */
	limit?: number;
	/**
	 * Prefix matching: `true` lets every query term match the index terms it starts (`'eng'` matches `'engine'`), `'last'` only the last
	 * one (search as you type).
	 * @default false
	 */
	prefix?: boolean | 'last';
	/**
	 * `'or'` returns the documents matching any query term, `'and'` only those matching every one.
	 * @default 'or'
	 */
	combine?: 'or' | 'and';
	/** Keeps only the matching documents for which it returns a truthy value. It must not modify the index. */
	filter?: (document: T) => unknown;
}

/**
 * One result of {@link SearchIndex.search}.
 * @template T - The type of the indexed documents
 */
export interface SearchIndexResult<T> {
	/** The document's id. */
	id: SearchId;
	/** The document. */
	item: T;
	/** Its BM25 score (higher is better; only meaningful relative to the other results of the same index). */
	score: number;
	/**
	 * The index terms of the document that matched the query: for each query term in order, the term itself, or for a prefix the terms it
	 * starts (in code-unit order), each listed once.
	 */
	terms: string[];
}

/**
 * An in-memory full-text index ranked with BM25, as returned by {@link createSearchIndex}.
 * @template T - The type of the indexed documents
 */
export interface SearchIndex<T> {
	/** Number of indexed documents. */
	readonly size: number;
	/** Indexes a document; throws a `RangeError` if a document with the same id is already indexed (see `replace`). */
	add(document: T): void;
	/** Indexes documents in order (those before an invalid one stay indexed). */
	addAll(documents: Iterable<T>): void;
	/** Indexes a document, replacing the one with the same id (which loses its place in the insertion order); returns `true` when it replaced one. */
	replace(document: T): boolean;
	/** Removes the document with this id; returns `false` when there is none. */
	remove(id: SearchId): boolean;
	/** Whether a document with this id is indexed. */
	has(id: SearchId): boolean;
	/** The indexed document with this id, or `undefined`. */
	get(id: SearchId): T | undefined;
	/** The documents matching `query`, best first (see {@link createSearchIndex}). */
	search(query: string, options?: SearchIndexQueryOptions<T>): Array<SearchIndexResult<T>>;
}

/**
 * The postings of a term: the documents that contain it and how often, field by field.
 */
interface Posting {
	/** The term. */
	term: string;
	/** Slots of the documents containing the term, ascending (those of removed documents stay until the next vacuum). */
	slots: number[];
	/** Occurrences of the term in each field of each of these documents: `tfs[entry * fieldCount + field]`. */
	tfs: number[];
	/** Number of indexed documents containing the term, per field. */
	df: number[];
	/** Number of indexed documents containing the term (in any field). */
	live: number;
}

/**
 * Binary search in an ascending array.
 * @template V - Numbers or strings (compared with `<`: strings by UTF-16 code units, like `Array.prototype.sort`)
 * @param {readonly V[]} values - The ascending values
 * @param {V} value - The value looked for
 * @returns {number} The index of the first value `>= value` (`values.length` when there is none)
 */
function lowerBound<V extends number | string>(values: readonly V[], value: V): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < value) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * Orders the candidates of a search by descending score, then ascending slot (insertion order), keeping the first `limit` with a
 * bounded heap: O(n log limit) instead of sorting all of them.
 * @param {number[]} slots - The candidates' slots (distinct)
 * @param {number[]} scores - Their scores (never `NaN`)
 * @param {number} limit - Number of candidates to keep (`>= 1`, or `Infinity`)
 * @returns {number[]} The indexes (into `slots`) of the kept candidates, best first
 */
function rank(slots: number[], scores: number[], limit: number): number[] {
	/**
	 * Whether candidate `i` ranks before candidate `j` (a strict total order, as slots are distinct; infinite scores tie like equal ones).
	 * @param {number} i - A candidate
	 * @param {number} j - Another candidate
	 * @returns {boolean} Whether `i` comes first
	 */
	function before(i: number, j: number): boolean {
		return scores[i] > scores[j] || (scores[i] === scores[j] && slots[i] < slots[j]);
	}
	/**
	 * Compares two candidates for `Array.prototype.sort`.
	 * @param {number} i - A candidate
	 * @param {number} j - Another candidate
	 * @returns {number} `-1` when `i` comes first, `1` otherwise
	 */
	function compare(i: number, j: number): number {
		return before(i, j) ? -1 : 1;
	}
	// The best `limit` candidates seen so far, the worst at the root: no child ranks after its parent.
	const heap: number[] = [];
	for (let i = 0; i < slots.length; i++) {
		let k = heap.length;
		if (k < limit) {
			while (k > 0) {
				const parent = (k - 1) >> 1;
				if (before(i, heap[parent])) break;
				heap[k] = heap[parent];
				k = parent;
			}
			heap[k] = i;
		} else if (before(i, heap[0])) {
			k = 0;
			for (;;) {
				let child = 2 * k + 1;
				if (child >= limit) break;
				if (child + 1 < limit && before(heap[child], heap[child + 1])) child++;
				if (before(heap[child], i)) break;
				heap[k] = heap[child];
				k = child;
			}
			heap[k] = i;
		}
	}
	return heap.sort(compare);
}

/**
 * The terms of a document that matched a query, in the order of their postings in `matched`: found by binary search in the few matched
 * posting lists, or by going through the document's terms when there are more matched postings than a quarter of those.
 * @param {Posting[]} list - The postings of the document's terms
 * @param {number} slot - The document's slot
 * @param {Map<Posting, number>} matched - The matched postings, numbered in order
 * @returns {string[]} The matched terms
 */
function matchedTerms(list: Posting[], slot: number, matched: Map<Posting, number>): string[] {
	const found: Posting[] = [];
	if (4 * matched.size <= list.length) {
		for (const posting of matched.keys()) if (posting.slots[lowerBound(posting.slots, slot)] === slot) found.push(posting);
	} else {
		for (const posting of list) if (matched.has(posting)) found.push(posting);
		found.sort(function (a, b) {
			return (matched.get(a) as number) - (matched.get(b) as number);
		});
	}
	const terms: string[] = [];
	for (const posting of found) terms.push(posting.term);
	return terms;
}

/**
 * Throws a `TypeError` unless a token returned by the tokenizer is a string.
 * @param {string} caller - Name of the public method, used in the error message
 * @param {unknown} token - The token
 * @returns {void}
 * @throws {TypeError} when `token` is not a string
 */
function assertToken(caller: string, token: unknown): asserts token is string {
	if (typeof token !== 'string') throw new TypeError(`${caller}: \`options.tokenize\` must return an array of strings, got an array containing ${typeName(token)}`);
}

/**
 * Creates an in-memory full-text index whose results are ranked with Okapi BM25, over one or more fields of the documents with per-field
 * boosts. Documents are kept by reference and found by id; their fields are read and tokenized once, when added (changing a document
 * afterwards does not change the index: `replace` it). `search` tokenizes the query like the fields and returns the matching documents,
 * best first, with their score and the terms that matched. Each `add`, `replace` and `remove` is atomic: a document, field or term that
 * fails validation, or an `extract`/`tokenize` that throws, leaves the index as it was.
 *
 * Scoring — every field is scored as an index of its own, then the field scores are multiplied by their boosts and added (a simplified
 * BM25F, as Lucene's multi-field queries do it). For a query term `t`, a document `d` and a field `f`:
 *
 * `score(t, d, f) = boost(f) · idf(t, f) · tf · (k1 + 1) / (tf + k1 · (1 − b + b · len / avglen))`, where
 * - `tf` is the number of occurrences of `t` in field `f` of `d` (if none, the field adds nothing), and `len` the number of terms of that field;
 * - `idf(t, f) = ln(1 + (N − n + 0.5) / (n + 0.5))`, Lucene's form of the BM25 IDF, which is never negative: `N` is the number of indexed
 *   documents with at least one term in field `f`, and `n` the number of those containing `t` there;
 * - `avglen` is the average length of field `f` over those `N` documents (lengths are exact; Lucene rounds them to one byte).
 *
 * A document's score is the sum, over the distinct query terms, of `Σ_f score(t, d, f)`. With prefix matching, a query term matches every
 * index term it starts (the term itself included), and contributes the best of their scores for the document (not their sum, so a short
 * prefix does not favour documents with many words that share it). Duplicate query terms count once (as a prefix if any occurrence is one).
 * Results are sorted by descending score, then by insertion order (a replaced document counts as added last), so they are deterministic.
 * Scores are computed in a form whose denominator never overflows, so absurd boosts or `k1` (near `Number.MAX_VALUE`) can make a score
 * `Infinity` but never `NaN`.
 *
 * Removal is exact: the statistics (`N`, `n`, lengths) are updated at once, so the scores after `remove` or `replace` are those of an
 * index built without the document (no tombstones that would skew the IDF). The memory of removed documents (with their ids and the terms
 * only they had) is reclaimed when they outnumber the indexed ones, by renumbering the documents in O(total postings), which keeps removals
 * amortized O(terms of the document · log n), also when the same document is removed and added again, or replaced, over and over.
 *
 * Cost: adding a document is O(its terms) (tokenizing aside); a search is O(postings of the matched terms + matches · log limit), plus
 * O(limit · matched terms · log n) for the `terms` of the results, plus,
 * for prefixes, O(log V + expansions) on a sorted term list that is merged in O(V) (V terms) at the first prefix search after new terms
 * were added. Memory is O(postings). There is no fuzzy matching (combine with {@link fuzzySearch} over the terms if needed), and no
 * phrase or proximity scoring. To persist an index, keep the documents and rebuild it with `addAll`.
 * @template T - The type of the indexed documents
 * @param {SearchIndexOptions<T>} options - `fields` (names, or names → boosts), `id` (default `'id'`), `extract`, `tokenize` (default {@link tokenize}), `k1` (default `1.2`), `b` (default `0.75`)
 * @returns {SearchIndex<T>} A new, empty index
 * @throws {TypeError} when `options` is not an object, `fields` is neither an array of strings nor an object, `id` is not a string,
 * `extract`/`tokenize` are not functions, or `k1`, `b` or a boost is not a number
 * @throws {RangeError} when `fields` is empty or repeats a field, a boost is not a finite number `> 0`, `k1` is not a finite number `>= 0`, or `b` is not in `[0, 1]`
 * @example
 * const index = createSearchIndex<{ id: number; title: string; body: string }>({ fields: { title: 2, body: 1 } });
 * index.addAll([
 * 	{ id: 1, title: 'Moby Dick', body: 'The whale hunts the ship. A white whale.' },
 * 	{ id: 2, title: 'The Old Man and the Sea', body: 'An old fisherman, a marlin and sharks.' },
 * 	{ id: 3, title: 'Whale Songs', body: 'How humpback whales sing.' }
 * ]);
 * index.search('whale').map(function (r) { return r.id; }); // => [3, 1]
 * index.search('whale').map(function (r) { return r.terms; }); // => [['whale'], ['whale']]
 * index.search('old sharks', { combine: 'and' }).map(function (r) { return r.item.title; }); // => ['The Old Man and the Sea']
 * index.search('hum', { prefix: 'last' }).map(function (r) { return r.terms; }); // => [['humpback']]
 * index.remove(3); // => true
 * index.search('whale').map(function (r) { return r.id; }); // => [1]
 * index.size; // => 2
 * @example
 * // Accents folded on both sides, stop words dropped, a filter over the documents
 * const stopWords = new Set(['de', 'la', 'le']);
 * const places = createSearchIndex<{ code: string; name: string; country: string }>({
 * 	id: 'code',
 * 	fields: ['name'],
 * 	tokenize: function (text) { return tokenize(text, { ignoreDiacritics: true, stopWords }); }
 * });
 * places.addAll([{ code: 'MAD', name: 'Málaga', country: 'ES' }, { code: 'ZRH', name: 'Zürich', country: 'CH' }, { code: 'LEH', name: 'Le Havre', country: 'FR' }]);
 * places.search('zurich').map(function (r) { return r.id; }); // => ['ZRH']
 * places.search('le havre').map(function (r) { return r.terms; }); // => [['havre']]
 * places.search('ma zu', { prefix: true, filter: function (place) { return place.country !== 'CH'; } }).map(function (r) { return r.id; }); // => ['MAD']
 * places.add({ code: 'ZRH', name: 'Zurich', country: 'CH' }); // throws RangeError
 */
export function createSearchIndex<T extends object>(options: SearchIndexOptions<T>): SearchIndex<T> {
	const caller = 'createSearchIndex';
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${typeName(options)}`);
	const fields: unknown = readOption(options, 'fields');
	const names: string[] = [];
	const boosts: number[] = [];
	if (Array.isArray(fields)) {
		for (let i = 0; i < fields.length; i++) {
			const name = elementAt(fields as unknown[], i);
			if (typeof name !== 'string') throw new TypeError(`${caller}: \`options.fields\` must contain field names, got ${typeName(name)}`);
			names.push(name);
			boosts.push(1);
		}
	} else if (typeof fields === 'object' && fields !== null) {
		for (const name of Object.keys(fields)) {
			const boost: unknown = (fields as Record<string, unknown>)[name];
			assertNumber(caller, `options.fields.${name}`, boost, (boost as number) > 0 && (boost as number) < Infinity, 'a finite number > 0');
			names.push(name);
			boosts.push(boost);
		}
	} else throw new TypeError(`${caller}: \`options.fields\` must be an array of field names or an object of boosts, got ${typeName(fields)}`);
	if (names.length === 0) throw new RangeError(`${caller}: \`options.fields\` must name at least one field, got none`);
	if (new Set(names).size < names.length) throw new RangeError(`${caller}: \`options.fields\` must name each field once, got ${names.join(', ')}`);
	const idKey = readOption(options, 'id', 'id');
	assertString(caller, 'options.id', idKey);
	const extract = readOption(options, 'extract');
	if (extract !== undefined) assertFunction(caller, 'options.extract', extract);
	const split = readOption(options, 'tokenize');
	if (split !== undefined) assertFunction(caller, 'options.tokenize', split);
	const k1 = readOption(options, 'k1', 1.2);
	assertNumber(caller, 'options.k1', k1, k1 >= 0 && k1 < Infinity, 'a finite number >= 0');
	const b = readOption(options, 'b', 0.75);
	assertNumber(caller, 'options.b', b, b >= 0 && b <= 1, 'a number between 0 and 1');

	const fieldCount = names.length;
	/** Per field: the number of indexed documents with at least one term in it, and their total number of terms in it. */
	const docCount: number[] = new Array<number>(fieldCount).fill(0);
	const totalLength: number[] = new Array<number>(fieldCount).fill(0);
	// Per slot (documents are numbered in insertion order; a removed document leaves an empty slot until the next vacuum): id, document,
	// field lengths (`lengths[slot * fieldCount + field]`) and the postings of its distinct terms (in order of first occurrence).
	const ids: SearchId[] = [];
	const docs: Array<T | undefined> = [];
	const lengths: number[] = [];
	const termsOf: Array<Posting[] | undefined> = [];
	// The slots of the ids, and the postings of the terms. Removing a document deletes neither its id nor the terms only it had: they
	// stay (with an empty slot, and no live documents) until the next vacuum, so that removing and adding a document again (or replacing
	// it) overwrites them instead of deleting and re-adding the same keys, which V8 makes cost O(size of the map) a time.
	const slotOf = new Map<SearchId, number>();
	const postings = new Map<string, Posting>();
	// The terms in code-unit order (some possibly without indexed documents since), and the terms added since it was sorted.
	let sorted: string[] = [];
	let fresh: string[] = [];
	let live = 0;
	// Incremented by every change, to detect a `filter` that changes the index.
	let version = 0;
	// Search scratch space, indexed by slot (no user code runs while it is in use): the total score, the best score for the current
	// query term, the number of query terms matched, and stamps telling whether those slots were set for the current query / term.
	let total = new Float64Array(0);
	let best = total;
	let docMark = total;
	let termMark = total;
	let hits = new Int32Array(0);
	let clock = 0;

	/**
	 * Splits a text into terms with the index's tokenizer.
	 * @param {string} text - The text
	 * @param {string} method - Name of the public method, for the error messages
	 * @returns {ReadonlyArray<unknown>} The terms (unvalidated when the tokenizer is the user's)
	 * @throws {TypeError} when the user's tokenizer does not return an array
	 */
	function analyze(text: string, method: string): ReadonlyArray<unknown> {
		if (split === undefined) return words(text, false, false, 1, undefined, undefined);
		const terms: unknown = split(text);
		if (!Array.isArray(terms)) throw new TypeError(`${method}: \`options.tokenize\` must return an array of strings, got ${typeName(terms)}`);
		return terms;
	}

	/**
	 * The slot of an indexed document.
	 * @param {SearchId} id - The id
	 * @returns {number | undefined} Its slot, or `undefined` when no indexed document has this id
	 */
	function find(id: SearchId): number | undefined {
		const slot = slotOf.get(id);
		return slot !== undefined && docs[slot] !== undefined ? slot : undefined;
	}

	/**
	 * Removes the document in a slot, updating every statistic, and vacuums when removed documents outnumber the indexed ones.
	 * @param {number} slot - The slot of an indexed document
	 * @returns {void}
	 */
	function discard(slot: number): void {
		for (const posting of termsOf[slot] as Posting[]) {
			const entry = lowerBound(posting.slots, slot);
			for (let f = 0; f < fieldCount; f++) if (posting.tfs[entry * fieldCount + f] > 0) posting.df[f]--;
			posting.live--;
		}
		for (let f = 0; f < fieldCount; f++) {
			const length = lengths[slot * fieldCount + f];
			if (length > 0) {
				docCount[f]--;
				totalLength[f] -= length;
			}
		}
		docs[slot] = undefined;
		termsOf[slot] = undefined;
		live--;
		version++;
		if (docs.length > 2 * live) vacuum();
	}

	/**
	 * Drops the slots of removed documents: renumbers the indexed ones (keeping their order), compacts every posting list, and deletes the
	 * ids and terms that no indexed document has.
	 * @returns {void}
	 */
	function vacuum(): void {
		const renumbered = new Int32Array(docs.length).fill(-1);
		let next = 0;
		for (let slot = 0; slot < docs.length; slot++) {
			if (docs[slot] === undefined) {
				// Unless the id was indexed again since.
				if (slotOf.get(ids[slot]) === slot) slotOf.delete(ids[slot]);
				continue;
			}
			renumbered[slot] = next;
			ids[next] = ids[slot];
			docs[next] = docs[slot];
			termsOf[next] = termsOf[slot];
			for (let f = 0; f < fieldCount; f++) lengths[next * fieldCount + f] = lengths[slot * fieldCount + f];
			slotOf.set(ids[next], next);
			next++;
		}
		ids.length = docs.length = termsOf.length = next;
		lengths.length = next * fieldCount;
		for (const posting of postings.values()) {
			if (posting.live === 0) {
				postings.delete(posting.term);
				continue;
			}
			const { slots, tfs } = posting;
			let kept = 0;
			for (let entry = 0; entry < slots.length; entry++) {
				const slot = renumbered[slots[entry]];
				if (slot < 0) continue;
				slots[kept] = slot;
				for (let f = 0; f < fieldCount; f++) tfs[kept * fieldCount + f] = tfs[entry * fieldCount + f];
				kept++;
			}
			slots.length = kept;
			tfs.length = kept * fieldCount;
		}
		// Also forget the removed terms of the prefix lists, which would otherwise grow with every new term while no prefix search merges them.
		sorted = sorted.filter(isIndexed);
		fresh = fresh.filter(isIndexed);
	}

	/**
	 * Whether a term is in the index (or was, until the next vacuum).
	 * @param {string} term - The term
	 * @returns {boolean} Whether the term has postings
	 */
	function isIndexed(term: string): boolean {
		return postings.has(term);
	}

	/**
	 * Indexes a document. Every piece of user code (`extract`, `tokenize`) runs before the index changes, so a throwing one leaves it intact.
	 * @param {T} document - The document
	 * @param {string} method - Name of the public method, for the error messages
	 * @param {boolean} replace - Whether a document with the same id is replaced (otherwise it is an error)
	 * @returns {boolean} Whether a document was replaced
	 * @throws {TypeError} when the document is not an object, its id is neither a string nor a number, or a field or term is invalid
	 * @throws {RangeError} when its id is `NaN`, or already indexed and `replace` is `false`
	 */
	function insert(document: T, method: string, replace: boolean): boolean {
		if (typeof document !== 'object' || document === null) throw new TypeError(`${method}: \`document\` must be an object, got ${typeName(document)}`);
		const id: unknown = readOption(document as Record<string, unknown>, idKey);
		if (typeof id !== 'string') assertNumber(method, `document.${idKey}`, id, !Number.isNaN(id), 'a string or a number other than NaN');
		// The distinct terms (by order of first occurrence) with the index of their counts in `counts` (one per field), and the field lengths.
		const entries = new Map<string, number>();
		const counts: number[] = [];
		const fieldLengths: number[] = new Array<number>(fieldCount).fill(0);
		for (let f = 0; f < fieldCount; f++) {
			const name = names[f];
			const value: unknown = extract === undefined ? readOption(document as Record<string, unknown>, name) : extract(document, name);
			if (value == null) continue;
			const texts: unknown = typeof value === 'string' ? [value] : value;
			if (!Array.isArray(texts)) throw new TypeError(`${method}: \`document.${name}\` must be a string, an array of strings, null or undefined, got ${typeName(value)}`);
			// Holes are read as `undefined` (see `elementAt`), here and in the terms.
			for (let t = 0; t < texts.length; t++) {
				const text = elementAt(texts as unknown[], t);
				if (typeof text !== 'string')
					throw new TypeError(`${method}: \`document.${name}\` must be a string, an array of strings, null or undefined, got an array containing ${typeName(text)}`);
				const terms = analyze(text, method);
				for (let k = 0; k < terms.length; k++) {
					const term = elementAt(terms, k);
					assertToken(method, term);
					if (term === '') continue;
					let entry = entries.get(term);
					if (entry === undefined) {
						entry = entries.size;
						entries.set(term, entry);
						for (let g = 0; g < fieldCount; g++) counts.push(0);
					}
					counts[entry * fieldCount + f]++;
					fieldLengths[f]++;
				}
			}
		}

		const existing = find(id);
		if (existing !== undefined) {
			if (!replace) throw new RangeError(`${method}: a document with the id ${show(id)} is already indexed`);
			discard(existing);
		}
		const slot = docs.length;
		ids.push(id);
		docs.push(document);
		slotOf.set(id, slot);
		for (let f = 0; f < fieldCount; f++) {
			lengths.push(fieldLengths[f]);
			if (fieldLengths[f] > 0) {
				docCount[f]++;
				totalLength[f] += fieldLengths[f];
			}
		}
		const list: Posting[] = [];
		for (const [term, entry] of entries) {
			let posting = postings.get(term);
			if (posting === undefined) {
				posting = { term, slots: [], tfs: [], df: new Array<number>(fieldCount).fill(0), live: 0 };
				postings.set(term, posting);
				fresh.push(term);
			}
			posting.slots.push(slot);
			for (let f = 0; f < fieldCount; f++) {
				const tf = counts[entry * fieldCount + f];
				posting.tfs.push(tf);
				if (tf > 0) posting.df[f]++;
			}
			posting.live++;
			list.push(posting);
		}
		termsOf.push(list);
		live++;
		version++;
		return existing !== undefined;
	}

	/**
	 * The postings of the indexed terms that start with `prefix` (merging the new terms into the sorted list first).
	 * @param {string} prefix - The prefix
	 * @returns {Posting[]} Their postings, in code-unit order of the terms
	 */
	function complete(prefix: string): Posting[] {
		if (fresh.length > 0) {
			fresh.sort();
			// Merge the two sorted lists, which are disjoint: a term only joins `fresh` when its postings are created, and both lists only hold
			// terms with postings (which are only deleted by a vacuum, along with their terms in the lists).
			const merged: string[] = [];
			for (let i = 0, j = 0; i < sorted.length || j < fresh.length;) {
				merged.push(j === fresh.length || (i < sorted.length && sorted[i] < fresh[j]) ? sorted[i++] : fresh[j++]);
			}
			sorted = merged;
			fresh = [];
		}
		const found: Posting[] = [];
		for (let i = lowerBound(sorted, prefix); i < sorted.length && sorted[i].startsWith(prefix); i++) {
			const posting = postings.get(sorted[i]) as Posting;
			// The postings of a term no indexed document has any more stay until the next vacuum.
			if (posting.live > 0) found.push(posting);
		}
		return found;
	}

	/**
	 * Unvalidated implementation of `search`'s scoring: accumulates the BM25 score of every document matching the query terms.
	 * @param {string[]} queryTerms - The distinct query terms
	 * @param {boolean[]} prefixes - Whether each query term is a prefix
	 * @param {Map<Posting, number>} matched - Receives the postings of the index terms that matched, numbered in order
	 * @returns {number[]} The slots of the documents matching at least one query term (their totals and hits are in the scratch space)
	 */
	function score(queryTerms: string[], prefixes: boolean[], matched: Map<Posting, number>): number[] {
		if (total.length < docs.length) {
			const size = Math.max(docs.length, 2 * total.length);
			total = new Float64Array(size);
			best = new Float64Array(size);
			docMark = new Float64Array(size);
			termMark = new Float64Array(size);
			hits = new Int32Array(size);
		}
		// `boost · idf · tf · (k1 + 1) / (tf + k1 · (1 − b + b · len / avglen))`, numerator and denominator divided by `k1 + 1`:
		// `weight · tf / (tf · unit + shift + scale · len)`, whose denominator is always finite and positive, so that even huge boosts
		// or `k1` can only overflow the score to `Infinity`, never make it `NaN`. (A field no document has gives a `NaN` scale, never used.)
		const unit = 1 / (k1 + 1);
		const shift = k1 * (1 - b) * unit;
		const scales: number[] = [];
		const weights: number[] = [];
		for (let f = 0; f < fieldCount; f++) scales.push(k1 * unit * ((b * docCount[f]) / totalLength[f]));
		const queryStamp = ++clock;
		const touched: number[] = [];
		for (let q = 0; q < queryTerms.length; q++) {
			let matches: Posting[];
			if (prefixes[q]) matches = complete(queryTerms[q]);
			else {
				const posting = postings.get(queryTerms[q]);
				matches = posting === undefined || posting.live === 0 ? [] : [posting];
			}
			const termStamp = ++clock;
			const termTouched: number[] = [];
			// A single posting (an exact term) lists each document once: its scores go straight to the totals.
			const single = matches.length === 1;
			for (const posting of matches) {
				if (!matched.has(posting)) matched.set(posting, matched.size);
				const { slots, tfs, df } = posting;
				for (let f = 0; f < fieldCount; f++) weights[f] = boosts[f] * Math.log(1 + (docCount[f] - df[f] + 0.5) / (df[f] + 0.5));
				for (let entry = 0; entry < slots.length; entry++) {
					const slot = slots[entry];
					if (docs[slot] === undefined) continue;
					let value = 0;
					for (let f = 0; f < fieldCount; f++) {
						const tf = tfs[entry * fieldCount + f];
						if (tf > 0) value += (weights[f] * tf) / (tf * unit + shift + scales[f] * lengths[slot * fieldCount + f]);
					}
					if (single) accumulate(touched, queryStamp, slot, value);
					else if (termMark[slot] !== termStamp) {
						termMark[slot] = termStamp;
						best[slot] = value;
						termTouched.push(slot);
					} else best[slot] = Math.max(best[slot], value);
				}
			}
			for (const slot of termTouched) accumulate(touched, queryStamp, slot, best[slot]);
		}
		return touched;
	}

	/**
	 * Adds the score of a query term to a document's total (see `score`).
	 * @param {number[]} touched - The slots of the documents matched so far (receives this one if it is new)
	 * @param {number} queryStamp - The stamp of the current query
	 * @param {number} slot - The document's slot
	 * @param {number} value - The score of the query term for the document
	 * @returns {void}
	 */
	function accumulate(touched: number[], queryStamp: number, slot: number, value: number): void {
		if (docMark[slot] !== queryStamp) {
			docMark[slot] = queryStamp;
			total[slot] = 0;
			hits[slot] = 0;
			touched.push(slot);
		}
		total[slot] += value;
		hits[slot]++;
	}

	return {
		get size(): number {
			return live;
		},
		add(document: T): void {
			insert(document, 'SearchIndex.add', false);
		},
		addAll(documents: Iterable<T>): void {
			if (typeof (documents as Partial<Iterable<T>> | null)?.[Symbol.iterator] !== 'function') {
				throw new TypeError(`SearchIndex.addAll: \`documents\` must be an iterable, got ${typeName(documents)}`);
			}
			// An array is read by index, so that a hole is `undefined` (see `elementAt`), not a document planted on `Object.prototype`.
			if (Array.isArray(documents)) for (let i = 0; i < documents.length; i++) insert(elementAt(documents as T[], i) as T, 'SearchIndex.addAll', false);
			else for (const document of documents) insert(document, 'SearchIndex.addAll', false);
		},
		replace(document: T): boolean {
			return insert(document, 'SearchIndex.replace', true);
		},
		remove(id: SearchId): boolean {
			const slot = find(id);
			if (slot === undefined) return false;
			discard(slot);
			return true;
		},
		has(id: SearchId): boolean {
			return find(id) !== undefined;
		},
		get(id: SearchId): T | undefined {
			const slot = find(id);
			return slot === undefined ? undefined : docs[slot];
		},
		search(query: string, searchOptions: SearchIndexQueryOptions<T> = {}): Array<SearchIndexResult<T>> {
			const method = 'SearchIndex.search';
			assertString(method, 'query', query);
			const limit = readOption(searchOptions, 'limit', Infinity);
			assertInteger(method, 'options.limit', limit, 0, true);
			const prefix: unknown = readOption(searchOptions, 'prefix', false);
			if (prefix !== true && prefix !== false && prefix !== 'last')
				throw new TypeError(`${method}: \`options.prefix\` must be a boolean or 'last', got ${show(prefix)}`);
			const combine: unknown = readOption(searchOptions, 'combine', 'or');
			if (combine !== 'or' && combine !== 'and') throw new TypeError(`${method}: \`options.combine\` must be 'or' or 'and', got ${show(combine)}`);
			const filter = readOption(searchOptions, 'filter');
			if (filter !== undefined) assertFunction(method, 'options.filter', filter);

			// The distinct query terms, in order, each a prefix if any of its occurrences is one.
			const tokens = analyze(query, method);
			let last = tokens.length - 1;
			// Not past the start: `tokens[-1]` would read a polluted `Object.prototype['-1']` (as a hole would: see `elementAt`).
			while (last >= 0 && elementAt(tokens, last) === '') last--;
			const queryTerms: string[] = [];
			const prefixes: boolean[] = [];
			const positions = new Map<string, number>();
			for (let i = 0; i <= last; i++) {
				const term = elementAt(tokens, i);
				assertToken(method, term);
				if (term === '') continue;
				const isPrefix = prefix === true || (prefix === 'last' && i === last);
				const position = positions.get(term);
				if (position === undefined) {
					positions.set(term, queryTerms.length);
					queryTerms.push(term);
					prefixes.push(isPrefix);
				} else if (isPrefix) prefixes[position] = true;
			}
			if (limit === 0) return [];

			const matched = new Map<Posting, number>();
			const touched = score(queryTerms, prefixes, matched);
			const required = combine === 'and' ? queryTerms.length : 1;
			// Copied out of the scratch space before `filter` runs (it may search the index too).
			const slots: number[] = [];
			const scores: number[] = [];
			for (const slot of touched) {
				if (hits[slot] >= required) {
					slots.push(slot);
					scores.push(total[slot]);
				}
			}
			if (filter !== undefined) {
				const start = version;
				let kept = 0;
				for (let i = 0; i < slots.length; i++) {
					const keep = filter(docs[slots[i]] as T);
					if (version !== start) throw new Error(`${method}: \`options.filter\` must not modify the index`);
					if (keep) {
						slots[kept] = slots[i];
						scores[kept++] = scores[i];
					}
				}
				slots.length = scores.length = kept;
			}

			const results: Array<SearchIndexResult<T>> = [];
			for (const i of rank(slots, scores, limit)) {
				const slot = slots[i];
				results.push({ id: ids[slot], item: docs[slot] as T, score: scores[i], terms: matchedTerms(termsOf[slot] as Posting[], slot, matched) });
			}
			return results;
		}
	};
}
