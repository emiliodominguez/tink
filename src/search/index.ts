import { assertFunction, assertInteger, assertNumber, describe as typeName } from '../utils/assert.js';

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
 * Options accepted by {@link fuzzySearch}.
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
}

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
	/** For an ASCII query, the characters (as one string) each query character matches, to reject targets with `indexOf`; `undefined` otherwise. */
	needles: string[] | undefined;
	/** Scratch space of {@link contains}: the next known position of each needle character in the current target (`-1`: none left). */
	next: Map<string, number>;
}

/**
 * Scratch buffers of the alignment, indexed by target code point.
 */
interface Workspace {
	/** Folded code points of the target. */
	codes: Int32Array;
	/** Original code points of the target. */
	raw: Int32Array;
	/** UTF-16 offset of every code point, plus the target length at the end. */
	offsets: Int32Array;
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
		offsets: new Int32Array(length + 1),
		bonuses: new Int8Array(length),
		rows: [new Float64Array(length), new Float64Array(length)],
		back: new Int32Array(cells)
	};
}

/**
 * Folds a code point for comparison: its lower case (as `String.prototype.toLowerCase` gives it for the lone character) unless
 * `caseSensitive`. A character whose lower case is several code points (only `'İ'`) folds to itself, which no other character folds to.
 * @param {number} code - A code point
 * @param {boolean} caseSensitive - Whether case must match exactly
 * @returns {number} The folded code point
 */
function fold(code: number, caseSensitive: boolean): number {
	if (caseSensitive) return code;
	if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
	const lower = String.fromCodePoint(code).toLowerCase();
	const folded = lower.codePointAt(0) as number;
	return String.fromCodePoint(folded) === lower ? folded : code;
}

/**
 * Classifies a code point for the word-start bonus.
 * @param {number} code - A code point
 * @returns {number} A combination of `WORD_CHAR`, `LOWER_CASE` and `UPPER_CASE`
 */
function classify(code: number): number {
	if (code < 128) return code >= 97 && code <= 122 ? WORD_CHAR | LOWER_CASE : code >= 65 && code <= 90 ? WORD_CHAR | UPPER_CASE : code >= 48 && code <= 57 ? WORD_CHAR : 0;
	const char = String.fromCodePoint(code);
	return (WORD.test(char) ? WORD_CHAR : 0) | (char === char.toUpperCase() ? 0 : LOWER_CASE) | (char === char.toLowerCase() ? 0 : UPPER_CASE);
}

/**
 * Word-start bonus of a target position: the first character, a letter or digit after any other character (a combining mark belongs
 * to the letter before it), or a camelCase hump.
 * @param {Int32Array} raw - Code points of the target
 * @param {number} j - The position
 * @returns {number} `BOUNDARY` or `0`
 */
function bonus(raw: Int32Array, j: number): number {
	if (j === 0) return BOUNDARY;
	const current = classify(raw[j]);
	const previous = classify(raw[j - 1]);
	return (current & WORD_CHAR && !(previous & WORD_CHAR)) || (previous & LOWER_CASE && current & UPPER_CASE) ? BOUNDARY : 0;
}

/**
 * Splits and folds a query.
 * @param {string} query - The query
 * @param {boolean} caseSensitive - Whether case must match exactly
 * @returns {PreparedQuery} Its code points, original and folded
 */
function prepare(query: string, caseSensitive: boolean): PreparedQuery {
	const raw: number[] = [];
	const codes: number[] = [];
	let needles: string[] | undefined = [];
	for (let k = 0; k < query.length; k++) {
		const code = query.codePointAt(k) as number;
		const folded = fold(code, caseSensitive);
		raw.push(code);
		codes.push(folded);
		if (code > 127) {
			needles = undefined;
			if (code > 0xffff) k++;
		} else {
			// Without case sensitivity, an ASCII letter matches its two cases, and 'k' also the Kelvin sign (whose lower case is 'k').
			const char = query[k];
			needles?.push(caseSensitive || folded < 97 || folded > 122 ? char : folded === 107 ? 'kK\u212A' : String.fromCharCode(folded, folded - 32));
		}
	}
	return { codes, raw, needles, next: new Map() };
}

/**
 * Whether `target` contains, in order, one of the characters of every needle (the subsequence test for ASCII queries, done with `indexOf`).
 * The next position found for each character is remembered, so that `indexOf` only runs again once the search has moved past it, and
 * never for a character with none left: every character scans the target at most once, keeping the test O(target length).
 * @param {string[]} needles - The characters matched by each query character
 * @param {Map<string, number>} next - Scratch space for the positions (cleared here)
 * @param {string} target - The text searched
 * @returns {boolean} `false` when the query cannot match
 */
function contains(needles: string[], next: Map<string, number>, target: string): boolean {
	next.clear();
	let from = 0;
	for (const alternatives of needles) {
		let found = -1;
		for (const needle of alternatives) {
			let index = next.get(needle);
			if (index === undefined || (index >= 0 && index < from)) {
				index = target.indexOf(needle, from);
				next.set(needle, index);
			}
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
	// Fast rejections (the common case while filtering), without allocating: a target has at most `length` code points.
	if (m > length || (query.needles !== undefined && !contains(query.needles, query.next, target))) return undefined;

	// The linear buffers first: the O(m·n) back-pointer matrix is only allocated once the subsequence check below has passed.
	const small = length <= SHARED_LENGTH;
	const workspace = small ? (shared ??= allocate(SHARED_LENGTH, SHARED_CELLS)) : allocate(length, 0);
	const { codes, raw, offsets, bonuses, rows } = workspace;
	let n = 0;
	// Greedy subsequence check (the alignment only exists if it passes), unless `contains` already did it.
	let matched = query.needles === undefined ? 0 : m;
	for (let k = 0; k < length; n++) {
		const code = target.codePointAt(k) as number;
		const folded = fold(code, caseSensitive);
		if (folded === q[matched]) matched++;
		offsets[n] = k;
		k += code > 0xffff ? 2 : 1;
		raw[n] = code;
		codes[n] = folded;
	}
	offsets[n] = length;
	if (matched < m) return undefined;
	const cells = m * n;
	// An explicit cap: past a few GiB, V8 aborts the process instead of throwing when allocating the matrix.
	if (cells > MAX_CELLS) throw new RangeError(`${caller}: the query and text are too long to align (${m} × ${n} code points, more than ${MAX_CELLS} cells)`);
	const back = small && cells <= SHARED_CELLS ? workspace.back : new Int32Array(cells);
	for (let j = 0; j < n; j++) bonuses[j] = bonus(raw, j);

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
		const last = ranges[ranges.length - 1];
		if (last !== undefined && last[0] === offsets[end + 1]) last[0] = offsets[end];
		else ranges.push([offsets[end], offsets[end + 1]]);
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
 * Characters are compared per Unicode code point after `toLowerCase()` (locale-independent; skipped when `caseSensitive`), so the
 * ranges never split a surrogate pair. There is no normalization and no grapheme segmentation: a precomposed `'é'` does not
 * match `'e'` + combining accent, characters whose lower case expands (`'İ'`) only match themselves, and ranges may split
 * multi-code-point graphemes (flags, ZWJ emoji). Normalize both strings (e.g. `.normalize('NFC')`) beforehand when that matters.
 *
 * An empty query matches every target with score `0` and no ranges.
 *
 * Cost: a query longer than the target, or that is not a subsequence of it, is rejected in O(target length) time without
 * allocating more than O(target length). A matching query costs O(query length × target length) time and a back-pointer matrix of
 * 4 bytes per (query code point, target code point) pair, at most `2 ** 28` pairs (1 GiB, e.g. a 1 000-character query against a
 * 268 000-character text): larger alignments throw a `RangeError`. Cap the query length of untrusted input (search boxes: 64–256 characters is plenty, e.g. `query.slice(0, 128)`), and the
 * target lengths if they are untrusted too.
 * @param {string} query - The characters to look for, in order
 * @param {string} target - The text to search in
 * @param {FuzzyMatchOptions} [options={}] - `caseSensitive` (default `false`)
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
 */
export function fuzzyMatch(query: string, target: string, options: FuzzyMatchOptions = {}): FuzzyMatch | undefined {
	assertString('fuzzyMatch', 'query', query);
	assertString('fuzzyMatch', 'target', target);
	const caseSensitive = options.caseSensitive === true;
	return match(prepare(query, caseSensitive), target, caseSensitive, 'fuzzyMatch');
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
 * @param {FuzzySearchOptions<T>} [options={}] - `key` (text(s) of an item, best one wins), `limit`, `threshold` (minimum score), `caseSensitive`
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
 */
export function fuzzySearch<T extends string>(items: Iterable<T>, query: string, options?: FuzzySearchOptions<T>): Array<FuzzySearchResult<T>>;
export function fuzzySearch<T>(items: Iterable<T>, query: string, options: FuzzySearchOptions<T> & Required<Pick<FuzzySearchOptions<T>, 'key'>>): Array<FuzzySearchResult<T>>;
export function fuzzySearch<T>(items: Iterable<T>, query: string, options: FuzzySearchOptions<T> = {}): Array<FuzzySearchResult<T>> {
	const { key, limit = Infinity, threshold = -Infinity } = options;
	const caseSensitive = options.caseSensitive === true;
	assertString('fuzzySearch', 'query', query);
	if (key !== undefined) assertFunction('fuzzySearch', 'key', key);
	assertInteger('fuzzySearch', 'limit', limit, 0, true);
	assertNumber('fuzzySearch', 'threshold', threshold, !Number.isNaN(threshold), 'a number');

	const prepared = prepare(query, caseSensitive);
	const name = key === undefined ? 'item' : 'key(item)';
	const results: Array<FuzzySearchResult<T>> = [];
	for (const item of items) {
		const texts: unknown = key === undefined ? item : key(item);
		let best: FuzzySearchResult<T> | undefined;
		// Several texts per item only come from `key`: without it, an array item is rejected like any other non-string.
		if (key !== undefined && Array.isArray(texts)) {
			for (const text of texts as unknown[]) {
				assertString('fuzzySearch', name, text);
				const result = match(prepared, text, caseSensitive, 'fuzzySearch');
				if (result !== undefined && (best === undefined || result.score > best.score)) best = { item, key: text, score: result.score, ranges: result.ranges };
			}
		} else {
			assertString('fuzzySearch', name, texts);
			const result = match(prepared, texts, caseSensitive, 'fuzzySearch');
			if (result !== undefined) best = { item, key: texts, score: result.score, ranges: result.ranges };
		}
		if (best !== undefined && best.score >= threshold) results.push(best);
	}

	return results
		.sort(function (a, b) {
			return b.score - a.score;
		})
		.slice(0, limit);
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
	for (const [start, end] of ranges) {
		// The messages are only built for invalid bounds.
		if (!(Number.isInteger(start) && start >= 0 && start <= length)) assertNumber('highlight', 'start', start, false, `an integer between 0 and ${length}`);
		if (!(Number.isInteger(end) && end >= start && end <= length)) assertNumber('highlight', 'end', end, false, `an integer between ${start} and ${length}`);
		if (end > start) sorted.push([start, end]);
	}
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
