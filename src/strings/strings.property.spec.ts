import fc from 'fast-check';

import { isNumericString } from '../validate/index.js';
import * as helpers from '.';

/**
 * Loads a fresh copy of the module while `Intl.Segmenter` is unavailable (code-point fallback).
 */
function loadWithoutSegmenter(): typeof helpers {
	const intl = Intl as any;
	const original = intl.Segmenter;
	let isolated: typeof helpers | undefined;

	try {
		delete intl.Segmenter;
		jest.isolateModules(function () {
			isolated = jest.requireActual<typeof helpers>('./index');
		});
		// The segmenter is resolved lazily (and only for text that is not plain ASCII/Latin), so trigger it while Intl.Segmenter is still missing.
		isolated!.reverse('warm-up \u{1F44D}');
	} finally {
		intl.Segmenter = original;
	}

	return isolated!;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(value: string): string[] {
	return Array.from(segmenter.segment(value), function (data) {
		return data.segment;
	});
}

function codePoints(value: string): string[] {
	return Array.from(value);
}

/**
 * Lowercase ASCII words starting with two letters. Shorter words are inherently ambiguous once joined without separators:
 * `toPascalCase('a b')` is `'AB'` and `toPascalCase('a0 b0')` is `'A0B0'`, which read back as a single acronym.
 */
const asciiWord = fc.stringMatching(/^[a-z]{2}[a-z0-9]{0,6}$/);
const lowerLetterWord = fc.stringMatching(/^[a-z]{2,8}$/);
const separator = fc.constantFrom(' ', '  ', '_', '-', '.', ' - ', '__', '/');

/** ASCII alphanumeric words joined by arbitrary separators. */
const separatedWords = fc.tuple(fc.array(asciiWord, { minLength: 1, maxLength: 6 }), fc.array(separator, { minLength: 6, maxLength: 6 })).map(function ([words, seps]) {
	return words
		.map(function (word, index) {
			return index === 0 ? word : seps[index] + word;
		})
		.join('');
});

/** Lowercase ASCII letter words separated by single spaces. */
const spacedLowerWords = fc.array(lowerLetterWord, { minLength: 1, maxLength: 6 }).map(function (words) {
	return words.join(' ');
});

/**
 * Text mixing characters that are graphemes on their own (below U+0300, Latin Extended Additional, General Punctuation, CJK
 * ideographs...) with sequences that form multi-code-unit graphemes (CR LF, combining marks, ZWJ, emoji with modifiers, Hangul jamo,
 * prepend characters, spacing marks), including the code points on each side of the ranges the implementation treats as plain text.
 */
const mixedText = fc.string({
	unit: fc.constantFrom(
		...['a', 'Z', '0', ' ', '.', 'é', 'ÿ', '\n', '\r', '\r\n', '\u0301', 'e\u0301', '\u200d', '👍🏽', '中', '—', '\u2070', '\u1e01', '\u1dff', '\u4e00'],
		...['\u9fff', '\u4dff', '\ua000', '\u3099', 'か', '\u200c', '\u206f', '\u20d0', 'Ω', 'ж', '\u0483', '\u1100', '\u1161', '\u11a8', '가', '\u0600', '\u0e33', 'ก']
	)
});

const caseFunctions = [helpers.toSnakeCase, helpers.toKebabCase, helpers.toConstantCase, helpers.toCamelCase, helpers.toPascalCase];

describe('String helpers (properties)', function () {
	describe('reverse', function () {
		it('is an involution on grapheme strings', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), function (s) {
					expect(helpers.reverse(helpers.reverse(s))).toBe(s);
				})
			);
		});

		it('reverses the grapheme sequence', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), function (s) {
					expect(graphemes(helpers.reverse(s))).toEqual(graphemes(s).reverse());
				})
			);
		});

		it('preserves the multiset of code points (and therefore the code-point length) for any string', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (s) {
					const reversed = helpers.reverse(s);
					expect(codePoints(reversed)).toHaveLength(codePoints(s).length);
					expect(codePoints(reversed).sort()).toEqual(codePoints(s).sort());
				})
			);
		});

		it('matches Intl.Segmenter on text mixing plain characters with CR LF, combining marks and emoji', function () {
			fc.assert(
				fc.property(mixedText, function (s) {
					expect(helpers.reverse(s)).toBe(graphemes(s).reverse().join(''));
				})
			);
		});

		it('matches Intl.Segmenter on arbitrary code points', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (s) {
					expect(helpers.reverse(s)).toBe(graphemes(s).reverse().join(''));
				})
			);
		});

		it('is an involution on arbitrary code points in the fallback mode', function () {
			const fallback = loadWithoutSegmenter();

			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (s) {
					expect(fallback.reverse(fallback.reverse(s))).toBe(s);
					expect(fallback.reverse(s)).toBe(codePoints(s).reverse().join(''));
				})
			);
		});
	});

	describe('isPalindrome', function () {
		it('accepts s + reverse(s)', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), function (s) {
					expect(helpers.isPalindrome(s + helpers.reverse(s))).toBe(true);
				})
			);
		});
	});

	describe('capitalize / uncapitalize', function () {
		it('changes exactly the first grapheme of mixed plain and complex text', function () {
			fc.assert(
				fc.property(mixedText, function (s) {
					const first = graphemes(s)[0] ?? '';
					expect(helpers.capitalize(s)).toBe(first.toUpperCase() + s.slice(first.length));
					expect(helpers.uncapitalize(s)).toBe(first.toLowerCase() + s.slice(first.length));
				})
			);
		});

		it('round-trips strings starting with a lowercase ASCII letter', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^[a-z]/), fc.string({ unit: 'grapheme' }), function (head, rest) {
					const s = head + rest;
					expect(helpers.uncapitalize(helpers.capitalize(s))).toBe(s);
				})
			);
		});

		it('only changes the first grapheme', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme', minLength: 1 }), function (s) {
					const tail = s.slice(graphemes(s)[0].length);
					expect(helpers.capitalize(s).endsWith(tail)).toBe(true);
					expect(helpers.uncapitalize(s).endsWith(tail)).toBe(true);
				})
			);
		});
	});

	describe('replace', function () {
		it('matches the split/join reference implementation', function () {
			fc.assert(
				fc.property(fc.string(), fc.string({ minLength: 1, maxLength: 3 }), fc.string(), function (s, search, replacement) {
					expect(helpers.replace(s, search, replacement)).toBe(s.split(search).join(replacement));
				})
			);
		});

		it('matches the reference on a small alphabet (frequent matches)', function () {
			const small = fc.string({ unit: fc.constantFrom('a', 'b', '.', '$', '&') });
			fc.assert(
				fc.property(small, small.filter(Boolean), small, function (s, search, replacement) {
					expect(helpers.replace(s, search, replacement)).toBe(s.split(search).join(replacement));
				})
			);
		});

		it('leaves no occurrence of a single-character search value when the replacement does not contain it', function () {
			fc.assert(
				fc.property(fc.string(), fc.string({ minLength: 1, maxLength: 1 }), fc.string(), function (s, search, replacement) {
					fc.pre(!replacement.includes(search));
					expect(helpers.replace(s, search, replacement).includes(search)).toBe(false);
				})
			);
		});
	});

	describe('countSubString', function () {
		it('matches the split-based reference implementation', function () {
			const small = fc.string({ unit: fc.constantFrom('a', 'b', '.', '(') });
			fc.assert(
				fc.property(small, small.filter(Boolean), function (s, sub) {
					expect(helpers.countSubString(s, sub)).toBe(s.split(sub).length - 1);
				})
			);
		});

		it('ignoreCase matches the reference on lower-cased inputs', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('a', 'A', 'b', 'B') }),
					fc.string({ unit: fc.constantFrom('a', 'A', 'b'), minLength: 1, maxLength: 3 }),
					function (s, sub) {
						expect(helpers.countSubString(s, sub, { ignoreCase: true })).toBe(s.toLowerCase().split(sub.toLowerCase()).length - 1);
					}
				)
			);
		});

		it('counts the copies of a repeated substring', function () {
			fc.assert(
				fc.property(fc.string({ minLength: 1 }), fc.nat(20), function (sub, n) {
					expect(helpers.countSubString(sub.repeat(n), sub)).toBe(n);
				})
			);
		});
	});

	describe('escapeRegExp', function () {
		it('builds a pattern that matches exactly the input', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), fc.string(), function (s, other) {
					const escaped = helpers.escapeRegExp(s);
					expect(new RegExp(escaped).test(s)).toBe(true);
					expect(new RegExp(`^${escaped}$`).test(s)).toBe(true);
					expect(new RegExp(`^${escaped}$`, 'u').test(s)).toBe(true);
					expect(new RegExp(`^${escaped}$`).test(other)).toBe(other === s);
				})
			);
		});

		/** Whether the runtime supports the `v` flag. */
		const hasVFlag = (function (): boolean {
			try {
				return new RegExp('[a]', 'v').test('a');
			} catch {
				return false;
			}
		})();
		const flags = hasVFlag ? ['', 'u', 'v'] : ['', 'u'];
		const tricky = fc.string({
			unit: fc.oneof(
				fc.constantFrom(...'^$\\.*+?()[]{}|/,-=<>#&!%:;@~\'`"_ \t\n\v\f\r\u00a0\u2028\u2029\ufeff\u3000aZ09'.split('')),
				fc.constantFrom('&&', '--', '!!', '\ud83d\ude00', 'é'),
				fc.string({ unit: 'binary', maxLength: 2 })
			)
		});

		it('matches the input exactly with the "", "u" and "v" (when supported) flags, lone surrogates included', function () {
			fc.assert(
				fc.property(fc.oneof(tricky, fc.string({ unit: 'binary' })), function (s) {
					const escaped = helpers.escapeRegExp(s);
					// Lone surrogates cannot be matched by u/v patterns as code units of a well-formed subject; they are still valid syntax.
					const wellFormed = !/[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
					for (const flag of flags) {
						const regex = new RegExp(`^${escaped}$`, flag);
						if (flag === '' || wellFormed) expect({ s, flag, test: regex.test(s) }).toEqual({ s, flag, test: true });
					}
				})
			);
		});

		it('inside a character class, matches every character of the input and no other one', function () {
			fc.assert(
				fc.property(tricky, fc.constantFrom('q', 'Q', '3', 'é', ' '), function (s, other) {
					fc.pre(s.length > 0);
					const escaped = helpers.escapeRegExp(s);
					for (const flag of flags) {
						// Without u/v, a class holds code units; with them, code points.
						const chars = flag === '' ? s.split('') : Array.from(s);
						const regex = new RegExp(`^[${escaped}]$`, flag);
						for (const char of chars) expect({ s, flag, char, test: regex.test(char) }).toEqual({ s, flag, char, test: true });
						expect(regex.test(other)).toBe(chars.includes(other));
					}
				})
			);
		});

		it('equals a direct transcription of the TC39 RegExp.escape algorithm (and the native one when available)', function () {
			/**
			 * RegExp.escape, transcribed from the proposal's spec text.
			 * @param s - The string
			 * @returns The escaped string
			 */
			function reference(s: string): string {
				/**
				 * Lower-case hex, zero-padded.
				 * @param n - The number
				 * @param width - The minimum width
				 * @returns The hex digits
				 */
				function hex(n: number, width: number): string {
					return n.toString(16).padStart(width, '0');
				}
				let result = '';
				let first = true;
				for (const c of s) {
					const cp = c.codePointAt(0) as number;
					if (first && /^[0-9A-Za-z]$/.test(c)) result += `\\x${hex(cp, 2)}`;
					else if ('^$\\.*+?()[]{}|/'.includes(c)) result += `\\${c}`;
					else if (c === '\t') result += '\\t';
					else if (c === '\n') result += '\\n';
					else if (c === '\v') result += '\\v';
					else if (c === '\f') result += '\\f';
					else if (c === '\r') result += '\\r';
					else if (',-=<>#&!%:;@~\'`"'.includes(c) || /^\s$/.test(c) || (cp >= 0xd800 && cp <= 0xdfff)) {
						result += cp <= 0xff ? `\\x${hex(cp, 2)}` : `\\u${hex(cp, 4)}`;
					} else result += c;
					first = false;
				}
				return result;
			}
			const native = (RegExp as any).escape as ((s: string) => string) | undefined;
			fc.assert(
				fc.property(fc.oneof(tricky, fc.string({ unit: 'binary' }), fc.string({ unit: 'grapheme' })), function (s) {
					expect(helpers.escapeRegExp(s)).toBe(reference(s));
					if (native !== undefined) expect(helpers.escapeRegExp(s)).toBe(native(s));
				}),
				{ numRuns: 1000 }
			);
		});
	});

	describe('escapeHtml / unescapeHtml', function () {
		it('round-trips any string', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (s) {
					expect(helpers.unescapeHtml(helpers.escapeHtml(s))).toBe(s);
				})
			);
		});

		it('round-trips strings full of entity-like text', function () {
			const entityish = fc.string({ unit: fc.constantFrom('&', 'amp;', 'lt;', 'gt;', 'quot;', '#39;', '#x27;', '<', '>', '"', "'", 'a') });
			fc.assert(
				fc.property(entityish, function (s) {
					expect(helpers.unescapeHtml(helpers.escapeHtml(s))).toBe(s);
				})
			);
		});

		it('produces no raw special characters', function () {
			const entityish = fc.string({ unit: fc.constantFrom('&', 'amp;', '<', '>', '"', "'", 'x', ';') });
			fc.assert(
				fc.property(fc.oneof(fc.string(), entityish), function (s) {
					const escaped = helpers.escapeHtml(s);
					expect(/[<>"']/.test(escaped)).toBe(false);
					expect(/&(?!(?:amp|lt|gt|quot|#39);)/.test(escaped)).toBe(false);
				})
			);
		});
	});

	describe('toSlug', function () {
		it('produces a well-formed slug and is idempotent', function () {
			fc.assert(
				fc.property(fc.oneof(fc.string(), fc.string({ unit: 'grapheme' }), fc.string({ unit: 'binary' })), function (s) {
					const slug = helpers.toSlug(s);
					expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$|^$/);
					expect(helpers.toSlug(slug)).toBe(slug);
				})
			);
		});
	});

	describe('case conversions', function () {
		it('are idempotent on their own output', function () {
			fc.assert(
				fc.property(separatedWords, function (s) {
					for (const convert of caseFunctions) {
						const once = convert(s);
						expect(convert(once)).toBe(once);
					}
				})
			);
		});

		it('preserve the word sequence when converting between cases', function () {
			fc.assert(
				fc.property(spacedLowerWords, function (s) {
					const expected = helpers.toSnakeCase(s);
					expect(expected).toBe(s.split(' ').join('_'));
					for (const convert of caseFunctions) {
						expect(helpers.toSnakeCase(convert(s))).toBe(expected);
					}
				})
			);
		});

		it('agree on the word sequence for separated alphanumeric words', function () {
			fc.assert(
				fc.property(separatedWords, function (s) {
					const snake = helpers.toSnakeCase(s);
					expect(helpers.toKebabCase(s)).toBe(snake.replace(/_/g, '-'));
					expect(helpers.toConstantCase(s)).toBe(snake.toUpperCase());
					expect(helpers.toSnakeCase(helpers.toKebabCase(s))).toBe(snake);
					expect(helpers.toSnakeCase(helpers.toConstantCase(s))).toBe(snake);
				})
			);
		});

		it('only emit letters, digits and their own separator', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), function (s) {
					expect(helpers.toKebabCase(s)).not.toMatch(/^-|-$|--|[\s_]/);
					expect(helpers.toSnakeCase(s)).not.toMatch(/^_|_$|__|[\s-]/);
					expect(helpers.toCamelCase(s)).not.toMatch(/[\s_-]/);
				})
			);
		});
	});

	describe('toTitleCase', function () {
		it('is idempotent and preserves whitespace positions', function () {
			fc.assert(
				fc.property(fc.oneof(fc.string(), fc.string({ unit: 'grapheme' })), function (s) {
					const titled = helpers.toTitleCase(s);
					expect(helpers.toTitleCase(titled)).toBe(titled);
					expect(titled.match(/\s+/g) ?? []).toEqual(s.match(/\s+/g) ?? []);
				})
			);
		});

		it('preserves the length of ASCII strings', function () {
			fc.assert(
				fc.property(fc.string(), function (s) {
					expect(helpers.toTitleCase(s)).toHaveLength(s.length);
					expect(helpers.toTitleCase(s).toLowerCase()).toBe(s.toLowerCase());
				})
			);
		});
	});

	describe('truncate', function () {
		it('keeps exactly the first length graphemes of mixed plain and complex text', function () {
			fc.assert(
				fc.property(mixedText, fc.nat(12), function (s, length) {
					const all = graphemes(s);
					expect(helpers.truncate(s, length, '…')).toBe(all.length > length ? all.slice(0, length).join('') + '…' : s);
				})
			);
		});

		it('returns a prefix plus the suffix, bounded by length graphemes', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), fc.nat(20), fc.string({ maxLength: 3 }), function (s, length, suffix) {
					const result = helpers.truncate(s, length, suffix);
					const count = graphemes(s).length;

					if (count <= length) {
						expect(result).toBe(s);
					} else {
						expect(result.endsWith(suffix)).toBe(true);
						const prefix = result.slice(0, result.length - suffix.length);
						expect(s.startsWith(prefix)).toBe(true);
						expect(graphemes(prefix)).toEqual(graphemes(s).slice(0, length));
					}
				})
			);
		});

		it('never splits a surrogate pair', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), fc.nat(20), function (s, length) {
					const result = helpers.truncate(s, length, '');
					expect(s.startsWith(result)).toBe(true);
					expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
				})
			);
		});
	});

	describe('normalizeWhitespace', function () {
		it('is idempotent and leaves no leading, trailing or repeated whitespace', function () {
			const spacey = fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\u00a0', 'a', 'b') });
			fc.assert(
				fc.property(fc.oneof(fc.string(), spacey), function (s) {
					const normalized = helpers.normalizeWhitespace(s);
					expect(helpers.normalizeWhitespace(normalized)).toBe(normalized);
					expect(normalized).not.toMatch(/^\s|\s$|\s\s|[^\S ]/);
					expect(normalized.split(' ').filter(Boolean)).toEqual(s.split(/\s+/).filter(Boolean));
				})
			);
		});
	});

	describe('removeDiacritics', function () {
		it('is idempotent and leaves ASCII untouched', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), fc.string(), function (s, ascii) {
					const cleaned = helpers.removeDiacritics(s);
					expect(helpers.removeDiacritics(cleaned)).toBe(cleaned);
					expect(helpers.removeDiacritics(ascii)).toBe(ascii);
				})
			);
		});
	});

	describe('toBoolean / toNumber', function () {
		it('toBoolean ignores surrounding whitespace and case', function () {
			fc.assert(
				fc.property(
					fc.constantFrom('true', '1', 'yes', 'y', 'on', 'false', '0', 'no', 'off', ''),
					fc.stringMatching(/^\s*$/),
					fc.boolean(),
					function (value, pad, upper) {
						const input = pad + (upper ? value.toUpperCase() : value) + pad;
						expect(helpers.toBoolean(input)).toBe(['true', '1', 'yes', 'y', 'on'].includes(value));
					}
				)
			);
		});

		it('toNumber round-trips integers and returns NaN for blank strings', function () {
			fc.assert(
				fc.property(fc.integer(), fc.stringMatching(/^\s*$/), function (n, pad) {
					expect(helpers.toNumber(pad + String(n) + pad)).toBe(n);
					expect(helpers.toNumber(pad)).toBeNaN();
				})
			);
		});

		it('toNumber returns a finite number exactly when isNumericString accepts the trimmed string, else NaN', function () {
			const numberish = fc.string({ unit: fc.constantFrom('0', '1', '9', '.', 'e', 'E', '+', '-', 'x', 'b', 'o', '_', 'I', 'nfinity', ' ', '4', '00') });
			fc.assert(
				fc.property(fc.oneof(numberish, fc.double().map(String)), function (text) {
					const value = helpers.toNumber(text);
					if (isNumericString(text.trim())) expect(value).toBe(Number(text.trim()));
					else expect(value).toBeNaN();
					expect(Number.isNaN(value) || Number.isFinite(value)).toBe(true);
				})
			);
		});
	});

	describe('interpolate', function () {
		it('substitutes every known key and leaves templates without placeholders unchanged', function () {
			fc.assert(
				fc.property(fc.dictionary(fc.stringMatching(/^[a-z]{1,5}$/), fc.string()), fc.string(), function (values, text) {
					fc.pre(!/[{}]/.test(text));
					const keys = Object.keys(values);
					const template = keys
						.map(function (key) {
							return `{${key}}`;
						})
						.join(text);
					const expected = keys
						.map(function (key) {
							return values[key];
						})
						.join(text);
					expect(helpers.interpolate(template, values)).toBe(expected);
					expect(helpers.interpolate(text, values)).toBe(text);
				})
			);
		});
	});

	describe('substring', function () {
		it('equals the native method whenever it does not swap the indices, and is empty otherwise', function () {
			const index = fc.oneof(fc.integer({ min: -5, max: 15 }), fc.constantFrom(NaN, Infinity, -Infinity), fc.double({ min: -5, max: 15, noNaN: true }));
			/** Mirrors the native index normalization. */
			function normalize(value: number, length: number): number {
				return Number.isNaN(value) ? 0 : Math.min(Math.max(Math.trunc(value), 0), length);
			}
			fc.assert(
				fc.property(fc.string({ maxLength: 10 }), index, index, function (s, start, end) {
					const from = normalize(start, s.length);
					const to = normalize(end, s.length);
					expect(helpers.substring(s, start, end)).toBe(from <= to ? s.substring(start, end) : '');
				})
			);
		});
	});

	describe('levenshtein / similarity', function () {
		const smallString = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '😀'), maxLength: 8 });

		/** Naive full-matrix reference implementation over code points. */
		function reference(a: string, b: string): number {
			const x = Array.from(a);
			const y = Array.from(b);
			const table: number[][] = [];
			for (let i = 0; i <= x.length; i++) {
				table.push([]);
				for (let j = 0; j <= y.length; j++) {
					if (i === 0 || j === 0) table[i].push(i + j);
					else table[i].push(Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)));
				}
			}
			return table[x.length][y.length];
		}

		it('matches the naive dynamic-programming reference', function () {
			fc.assert(
				fc.property(smallString, smallString, function (a, b) {
					expect(helpers.levenshtein(a, b)).toBe(reference(a, b));
				})
			);
		});

		it('satisfies the metric axioms and the length bounds', function () {
			fc.assert(
				fc.property(smallString, smallString, smallString, function (a, b, c) {
					const ab = helpers.levenshtein(a, b);
					const lengthA = Array.from(a).length;
					const lengthB = Array.from(b).length;
					expect(helpers.levenshtein(a, a)).toBe(0);
					expect(ab === 0).toBe(a === b);
					expect(helpers.levenshtein(b, a)).toBe(ab);
					expect(ab).toBeLessThanOrEqual(helpers.levenshtein(a, c) + helpers.levenshtein(c, b));
					expect(ab).toBeLessThanOrEqual(Math.max(lengthA, lengthB));
					expect(ab).toBeGreaterThanOrEqual(Math.abs(lengthA - lengthB));
				})
			);
		});

		it('similarity lies in [0, 1] and is 1 iff the strings are equal', function () {
			fc.assert(
				fc.property(fc.oneof(smallString, fc.string()), fc.oneof(smallString, fc.string()), function (a, b) {
					const score = helpers.similarity(a, b);
					expect(score).toBeGreaterThanOrEqual(0);
					expect(score).toBeLessThanOrEqual(1);
					expect(score === 1).toBe(a === b);
					expect(helpers.similarity(b, a)).toBe(score);
				})
			);
		});
	});

	describe('dedent', function () {
		const whitespaceLine = fc.string({ unit: fc.constantFrom(' ', '\t', 'a', 'b', ' '), maxLength: 8 });
		const text = fc.array(whitespaceLine, { maxLength: 8 }).map(function (lines) {
			return lines.join('\n');
		});

		it('is idempotent once the dropped blank edge lines are accounted for', function () {
			fc.assert(
				fc.property(text, function (s) {
					const once = helpers.dedent(s);
					expect(helpers.dedent('\n' + once + '\n')).toBe(once);
				})
			);
		});

		it('only removes leading whitespace: every output line is a suffix of its input line', function () {
			fc.assert(
				fc.property(text, function (s) {
					const input = helpers.splitLines(s);
					const output = helpers.splitLines(helpers.dedent(s));
					const offset = /^[ \t]*$/.test(input[0]) ? 1 : 0;
					if (helpers.dedent(s) === '') return;
					expect(output.length).toBeLessThanOrEqual(input.length - offset);
					output.forEach(function (line, index) {
						expect(line.length).toBeLessThanOrEqual(input[index + offset].length);
						expect(input[index + offset].endsWith(line)).toBe(true);
					});
					const indents = output
						.filter(function (line) {
							return line.trim() !== '';
						})
						.map(function (line) {
							return /^[ \t]*/.exec(line)![0];
						});
					// No common indentation is left.
					const common = indents.reduce(function (prefix, indent) {
						let length = 0;
						while (length < prefix.length && prefix[length] === indent[length]) length++;
						return prefix.slice(0, length);
					}, indents[0] ?? '');
					expect(common).toBe('');
				})
			);
		});

		it('undoes a uniform indentation', function () {
			const line = fc.tuple(fc.nat(3), fc.stringMatching(/^[a-z]{1,5}$/)).map(function ([spaces, word]) {
				return ' '.repeat(spaces) + word;
			});
			fc.assert(
				fc.property(
					fc.array(fc.oneof(line, fc.constant('')), { maxLength: 6 }),
					fc.stringMatching(/^[a-z]{1,5}$/),
					fc.stringMatching(/^[ \t]{0,4}$/),
					function (middle, head, prefix) {
						const block = [head, ...middle, head];
						const indented = block
							.map(function (value) {
								return value === '' ? '' : prefix + value;
							})
							.join('\n');
						expect(helpers.dedent(indented)).toBe(block.join('\n'));
						expect(helpers.dedent('\n' + indented + '\n')).toBe(block.join('\n'));
					}
				)
			);
		});

		it('as a tag, equals dedenting the literal text with inline values when they cannot affect indentation', function () {
			fc.assert(
				fc.property(
					fc.array(fc.tuple(fc.stringMatching(/^ {0,4}[a-z]{1,3}\n? {0,4}[a-z]{1,3}$/), fc.stringMatching(/^[A-Z]{1,3}$/)), { maxLength: 4 }),
					fc.stringMatching(/^[a-z]{1,3}$/),
					function (pieces, tail) {
						const literals = pieces.map(function ([literal]) {
							return literal;
						});
						const values = pieces.map(function ([, value]) {
							return value;
						});
						const strings = Object.assign([...literals, tail], { raw: [...literals, tail] }) as unknown as TemplateStringsArray;
						const inline = literals
							.map(function (literal, index) {
								return literal + values[index];
							})
							.join('');
						expect(helpers.dedent(strings, ...values)).toBe(helpers.dedent(inline + tail));
					}
				)
			);
		});
	});

	describe('splitLines', function () {
		it('joining with \\n gives the input with normalized newlines', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('a', 'b', '\n', '\r', '\r\n', ' ') }), function (s) {
					const lines = helpers.splitLines(s);
					expect(lines.join('\n')).toBe(s.replace(/\r\n|\r/g, '\n'));
					lines.forEach(function (line) {
						expect(line).not.toMatch(/[\r\n]/);
					});
				})
			);
		});
	});

	describe('wordWrap', function () {
		const words = fc.string({ unit: fc.constantFrom('a', 'b', 'é', '👍🏽', ' ', '  ', '\t', '\n', '\r\n') });

		it('keeps the words in order (whitespace aside)', function () {
			fc.assert(
				fc.property(words, fc.integer({ min: 1, max: 12 }), function (s, width) {
					const wrapped = helpers.wordWrap(s, width);
					expect(helpers.normalizeWhitespace(wrapped.split('\n').join(' '))).toBe(helpers.normalizeWhitespace(s));
					// Overlong lines only happen for a single long word.
					wrapped.split('\n').forEach(function (line) {
						if (graphemes(line).length > width) expect(line).not.toMatch(/\s/);
					});
				})
			);
		});

		it('never exceeds the width when breaking long words and loses no character', function () {
			fc.assert(
				fc.property(words, fc.integer({ min: 1, max: 12 }), function (s, width) {
					const wrapped = helpers.wordWrap(s, width, { breakLongWords: true });
					wrapped.split('\n').forEach(function (line) {
						expect(graphemes(line).length).toBeLessThanOrEqual(width);
						expect(line).toBe(line.trim());
					});
					expect(wrapped.replace(/\s+/g, '')).toBe(s.replace(/\s+/g, ''));
				})
			);
		});

		it('keeps the same number of hard line breaks with an infinite width', function () {
			fc.assert(
				fc.property(words, function (s) {
					const wrapped = helpers.wordWrap(s, Infinity);
					expect(helpers.splitLines(wrapped)).toHaveLength(helpers.splitLines(s).length);
				})
			);
		});
	});

	describe('mask', function () {
		const maskable = fc.string({ unit: fc.constantFrom('a', '1', ' ', 'é', 'é', '👍🏽', '🇫🇷', '-') });

		it('preserves the grapheme length and the visible parts, and always hides at least one grapheme of a non-empty string', function () {
			fc.assert(
				fc.property(maskable, fc.nat(5), fc.nat(5), fc.constantFrom('*', '•', '#'), function (s, visibleStart, visibleEnd, char) {
					const masked = helpers.mask(s, { visibleStart, visibleEnd, char });
					const input = graphemes(s);
					const output = graphemes(masked);
					expect(output).toHaveLength(input.length);
					if (input.length <= visibleStart + visibleEnd) {
						expect(masked).toBe(char.repeat(input.length));
						return;
					}
					expect(output.slice(0, visibleStart)).toEqual(input.slice(0, visibleStart));
					expect(output.slice(input.length - visibleEnd)).toEqual(input.slice(input.length - visibleEnd));
					expect(output.slice(visibleStart, input.length - visibleEnd).join('')).toBe(char.repeat(input.length - visibleStart - visibleEnd));
				})
			);
		});
	});

	describe('randomString', function () {
		it('has the requested length and only uses alphabet characters, picked as floor(r * n)', function () {
			fc.assert(
				fc.property(
					fc.nat(20),
					fc.string({ unit: fc.constantFrom('a', 'b', 'c', '😀', 'Z'), minLength: 1 }),
					fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 1 }),
					function (length, alphabet, draws) {
						const characters = Array.from(new Set(alphabet));
						let index = 0;
						function random(): number {
							return draws[index++ % draws.length];
						}
						const result = Array.from(helpers.randomString(length, alphabet, random));
						expect(result).toHaveLength(length);
						result.forEach(function (char, position) {
							expect(characters).toContain(char);
							expect(char).toBe(characters[Math.floor(draws[position % draws.length] * characters.length)]);
						});
					}
				)
			);
		});
	});

	describe('toSentenceCase', function () {
		it('has the same words as snake case and is idempotent', function () {
			fc.assert(
				fc.property(separatedWords, function (s) {
					const sentence = helpers.toSentenceCase(s);
					expect(sentence.toLowerCase()).toBe(helpers.toSnakeCase(s).split('_').join(' '));
					expect(helpers.toSentenceCase(sentence)).toBe(sentence);
					expect(sentence[0]).toBe(sentence[0].toUpperCase());
				})
			);
		});
	});

	describe('pluralize / formatCount', function () {
		it('uses the singular iff |count| is 1, and formatCount prefixes the count', function () {
			fc.assert(
				fc.property(fc.oneof(fc.integer({ min: -3, max: 3 }), fc.double()), fc.stringMatching(/^[a-z]{1,6}$/), function (count, word) {
					expect(helpers.pluralize(count, word) === word).toBe(Math.abs(count) === 1);
					expect(helpers.pluralize(count, word, 'X')).toBe(Math.abs(count) === 1 ? word : 'X');
					expect(helpers.formatCount(count, word)).toBe(`${String(count)} ${helpers.pluralize(count, word)}`);
				})
			);
		});
	});

	describe('ensurePrefix / ensureSuffix / stripPrefix / stripSuffix', function () {
		const piece = fc.string({ unit: fc.constantFrom('a', 'b', '/'), maxLength: 4 });

		it('ensure* is idempotent and guarantees the affix', function () {
			fc.assert(
				fc.property(piece, piece, function (s, affix) {
					const prefixed = helpers.ensurePrefix(s, affix);
					const suffixed = helpers.ensureSuffix(s, affix);
					expect(prefixed.startsWith(affix)).toBe(true);
					expect(suffixed.endsWith(affix)).toBe(true);
					expect(helpers.ensurePrefix(prefixed, affix)).toBe(prefixed);
					expect(helpers.ensureSuffix(suffixed, affix)).toBe(suffixed);
					expect(prefixed === s).toBe(s.startsWith(affix));
					expect(suffixed === s).toBe(s.endsWith(affix));
				})
			);
		});

		it('strip* undoes a concatenation and round-trips with ensure*', function () {
			fc.assert(
				fc.property(piece, piece, function (s, affix) {
					expect(helpers.stripPrefix(affix + s, affix)).toBe(s);
					expect(helpers.stripSuffix(s + affix, affix)).toBe(s);
					if (s.startsWith(affix)) expect(affix + helpers.stripPrefix(s, affix)).toBe(s);
					else expect(helpers.stripPrefix(s, affix)).toBe(s);
					if (s.endsWith(affix)) expect(helpers.stripSuffix(s, affix) + affix).toBe(s);
					else expect(helpers.stripSuffix(s, affix)).toBe(s);
					expect(helpers.stripPrefix(helpers.ensurePrefix(s, affix), affix)).toBe(s.startsWith(affix) ? helpers.stripPrefix(s, affix) : s);
					expect(helpers.stripSuffix(helpers.ensureSuffix(s, affix), affix)).toBe(s.endsWith(affix) ? helpers.stripSuffix(s, affix) : s);
				})
			);
		});
	});
});

/** Graphemes that never merge with a neighbour when concatenated in any order. */
const safeGrapheme = fc.constantFrom('a', 'Z', '0', ' ', '-', '.', 'é', 'é', '👍🏽', '👍', '中', '가', 'か', '🇫🇷', 'ж');
const safeText = fc.array(safeGrapheme, { maxLength: 12 }).map(function (parts) {
	return parts.join('');
});
const fill = fc.array(safeGrapheme, { minLength: 1, maxLength: 3 }).map(function (parts) {
	return parts.join('');
});

/**
 * Reference trim: removes the graphemes of `chars` from the ends of the grapheme list of `string`.
 */
function referenceTrim(string: string, chars: string, fromStart: boolean, fromEnd: boolean): string {
	const set = new Set(graphemes(chars));
	const list = graphemes(string);
	let start = 0;
	let end = list.length;
	while (fromStart && start < end && set.has(list[start])) start++;
	while (fromEnd && end > start && set.has(list[end - 1])) end--;
	return list.slice(start, end).join('');
}

describe('String helpers (round 11 properties)', function () {
	describe('grapheme splitting of emoji', function () {
		const emojiText = fc.string({
			unit: fc.constantFrom(
				...['a', ' ', '1', '©', '❤', '\ufe0f', '\u200d', '\u20e3', '👍', '\u{1F3FD}', '👨', '👩', '👧', '🏳', '🌈', '🇫', '🇷', '🇩', '🇪', '🏴', '\u{E0067}', '\u{E007F}'],
				...['e\u0301', '\r', '\n', '中', 'か', '\u0600', '\u{1F9D1}\u200d\u{1F4BB}', '\u{1F469}\u{1F3FB}\u200d\u{1F91D}\u200d\u{1F468}\u{1F3FF}']
			),
			maxLength: 16
		});

		it('matches Intl.Segmenter on emoji sequences, flags, modifiers and joiners', function () {
			fc.assert(
				fc.property(emojiText, function (s) {
					expect(helpers.reverse(s)).toBe(graphemes(s).reverse().join(''));
					expect(helpers.mask(s, { visibleEnd: 0 })).toBe('*'.repeat(graphemes(s).length));
				}),
				{ numRuns: 500 }
			);
		});
	});

	describe('trimChars / trimStartChars / trimEndChars', function () {
		const chars = fc.string({ unit: fc.constantFrom('a', ' ', '.', '\r', '\n', 'e', '́', 'é', '👍', '👍🏽', '中', '‍', '؀', 'ก') });

		it('match a reference built on Intl.Segmenter, on text mixing plain and complex graphemes', function () {
			fc.assert(
				fc.property(mixedText, chars, function (s, set) {
					expect(helpers.trimChars(s, set)).toBe(referenceTrim(s, set, true, true));
					expect(helpers.trimStartChars(s, set)).toBe(referenceTrim(s, set, true, false));
					expect(helpers.trimEndChars(s, set)).toBe(referenceTrim(s, set, false, true));
				})
			);
		});

		it('match the reference on arbitrary code points, with chars taken from the string itself', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), fc.nat(), fc.nat(), function (s, from, length) {
					const set = s.slice(from % (s.length + 1), (from % (s.length + 1)) + (length % 4));
					expect(helpers.trimChars(s, set)).toBe(referenceTrim(s, set, true, true));
				})
			);
		});

		it('are idempotent, compose, and return a slice of the input', function () {
			fc.assert(
				fc.property(mixedText, chars, function (s, set) {
					const trimmed = helpers.trimChars(s, set);
					expect(helpers.trimChars(trimmed, set)).toBe(trimmed);
					expect(helpers.trimStartChars(helpers.trimEndChars(s, set), set)).toBe(trimmed);
					expect(s.includes(trimmed)).toBe(true);
					expect(helpers.trimChars(s, graphemes(set))).toBe(trimmed);
				})
			);
		});

		it('equal the native trim for ASCII whitespace sets', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom(' ', '\t', '\n', 'a', 'b') }), function (s) {
					expect(helpers.trimChars(s, ' \t\n')).toBe(s.trim());
					expect(helpers.trimStartChars(s, [' ', '\t', '\n'])).toBe(s.trimStart());
					expect(helpers.trimEndChars(s, ' \t\n')).toBe(s.trimEnd());
				})
			);
		});
	});

	describe('toDelimitedCase and the extra case styles', function () {
		const text = fc.oneof(mixedText, fc.string(), fc.string({ unit: fc.constantFrom('a', 'B', 'Σ', 'ς', 'İ', '1', '_', '-', ' ', '.', "'", 'É', 'ǆ', 'ß') }));

		it('join the same words as the existing helpers', function () {
			fc.assert(
				fc.property(text, function (s) {
					const words = helpers.toNoCase(s);
					expect(helpers.toSnakeCase(s)).toBe(words.split(' ').join('_'));
					expect(helpers.toKebabCase(s)).toBe(words.split(' ').join('-'));
					expect(helpers.toDotCase(s)).toBe(words.split(' ').join('.'));
					expect(helpers.toPathCase(s)).toBe(words.split(' ').join('/'));
					expect(helpers.toTrainCase(s)).toBe(helpers.toStartCase(s).split(' ').join('-'));
					expect(helpers.toPascalCase(s)).toBe(helpers.toStartCase(s).split(' ').join(''));
					expect(helpers.toConstantCase(s)).toBe(helpers.toDelimitedCase(s, '_', { case: 'upper' }));
					expect(words).toBe(helpers.toDelimitedCase(s, ' ', { case: 'preserve' }).toLowerCase());
				})
			);
		});

		it('never let the delimiter change the casing of the words', function () {
			fc.assert(
				fc.property(
					text,
					fc.constantFrom('.', ':', "'", 'X', '', '--'),
					fc.constantFrom<helpers.WordCase>('lower', 'upper', 'capital', 'preserve'),
					function (s, delimiter, wordCase) {
						const reference = helpers.toDelimitedCase(s, '\u0000', { case: wordCase });
						expect(helpers.toDelimitedCase(s, delimiter, { case: wordCase })).toBe(reference.split('\u0000').join(delimiter));
					}
				)
			);
		});
	});

	describe('padStart / padEnd / padCenter', function () {
		it('reach exactly the target width in graphemes and keep the string', function () {
			fc.assert(
				fc.property(safeText, fc.nat(20), fill, function (s, width, padding) {
					const length = graphemes(s).length;
					const start = helpers.padStart(s, width, padding);
					const end = helpers.padEnd(s, width, padding);
					const center = helpers.padCenter(s, width, padding);

					for (const result of [start, end, center]) expect(graphemes(result)).toHaveLength(Math.max(width, length));

					expect(start.endsWith(s)).toBe(true);
					expect(end.startsWith(s)).toBe(true);

					const before = Math.floor(Math.max(width - length, 0) / 2);
					expect(center).toBe(helpers.padStart(s, length + before, padding) + helpers.padEnd('', Math.max(width - length, 0) - before, padding));
				})
			);
		});

		it('use the fill graphemes in order, cut at the end', function () {
			fc.assert(
				fc.property(fc.nat(20), fill, function (width, padding) {
					const expected = Array.from({ length: width }, function (_, index) {
						const list = graphemes(padding);
						return list[index % list.length];
					}).join('');
					expect(helpers.padEnd('', width, padding)).toBe(expected);
					expect(helpers.padStart('', width, padding)).toBe(expected);
				})
			);
		});

		it('equal the native methods on ASCII', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('a', 'b', ' ', '~') }),
					fc.nat(20),
					fc.string({ unit: fc.constantFrom('x', 'y', '-'), minLength: 1 }),
					function (s, width, padding) {
						expect(helpers.padStart(s, width, padding)).toBe(s.padStart(width, padding));
						expect(helpers.padEnd(s, width, padding)).toBe(s.padEnd(width, padding));
					}
				)
			);
		});
	});
});

/** Reference for `compareNatural`: strings as token lists (BigInt numbers for digit runs, code units otherwise), then code units. */
function naturalReference(a: string, b: string, ignoreCase: boolean): number {
	function tokens(text: string): Array<bigint | number> {
		return (text.match(/[0-9]+|[\s\S]/g) ?? []).map(function (token) {
			return /^[0-9]/.test(token) ? BigInt(token) : token.charCodeAt(0);
		});
	}
	const left = tokens(ignoreCase ? a.toLowerCase().replace(/ς/g, 'σ') : a);
	const right = tokens(ignoreCase ? b.toLowerCase().replace(/ς/g, 'σ') : b);
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const x = left[index];
		const y = right[index];
		// A number sits where the digit 0 does among the code units.
		const slotX = typeof x === 'bigint' ? 48 : x;
		const slotY = typeof y === 'bigint' ? 48 : y;
		if (slotX !== slotY) return slotX < slotY ? -1 : 1;
		if (x !== y) return x < y ? -1 : 1;
	}
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return a === b ? 0 : a < b ? -1 : 1;
}

/** Strings made of digit runs (with leading zeros), letters of both cases, punctuation and non-ASCII characters. */
const naturalString = fc
	.array(fc.constantFrom('0', '1', '2', '9', '00', '010', '10', '99', 'a', 'A', 'b', 'B', 'z', '.', '-', ' ', '_', 'é', 'É', 'İ', 'Σ', 'σ', 'ς', '\u{1F600}', '\u{FFFF}'), {
		maxLength: 8
	})
	.map(function (parts) {
		return parts.join('');
	});

const segmenterForTests = new Intl.Segmenter();

/** The grapheme clusters of a string, by `Intl.Segmenter`. */
function clustersOf(value: string): string[] {
	return Array.from(segmenterForTests.segment(value), function (data) {
		return data.segment;
	});
}

/**
 * Whole grapheme clusters that never merge with their neighbours, with their terminal widths (checked against string-width 8.3 by hand
 * for the non-trivial ones).
 */
const MEASURED_CLUSTERS: ReadonlyArray<readonly [string, number]> = [
	['a', 1],
	['Z', 1],
	[' ', 1],
	['~', 1],
	['é', 1],
	['e\u{301}', 1],
	['Ω', 1],
	['±', 1],
	['中', 2],
	['각', 2],
	['ｶ', 1],
	['ｶ\u{ff9e}', 2],
	['Ａ', 2],
	['कि', 2],
	['👍', 2],
	['👍🏽', 2],
	['☝🏽', 2],
	['👨\u{200d}👩\u{200d}👧', 2],
	['🇯🇵', 2],
	['❤', 1],
	['❤\u{fe0f}', 2],
	['1\u{fe0f}\u{20e3}', 2],
	['\u{200b}', 0],
	['\t', 0],
	['\x1b[31m', 0],
	['\x1b]8;;https://example.com\x07', 0],
	['\u{20000}', 2]
];

describe('String helpers (property-based, new helpers)', function () {
	describe('compareNatural', function () {
		it('should match a token-based reference (BigInt numbers)', function () {
			fc.assert(
				fc.property(naturalString, naturalString, fc.boolean(), function (a, b, ignoreCase) {
					expect(helpers.compareNatural(a, b, { ignoreCase })).toBe(naturalReference(a, b, ignoreCase));
				})
			);
		});

		it('should be antisymmetric, and 0 only for equal strings', function () {
			fc.assert(
				fc.property(naturalString, naturalString, fc.boolean(), function (a, b, ignoreCase) {
					const order = helpers.compareNatural(a, b, { ignoreCase });
					expect([-1, 0, 1]).toContain(order);
					expect(order).toBe(-helpers.compareNatural(b, a, { ignoreCase }) || 0);
					expect(order === 0).toBe(a === b);
				})
			);
		});

		it('should be transitive', function () {
			fc.assert(
				fc.property(naturalString, naturalString, naturalString, fc.boolean(), function (a, b, c, ignoreCase) {
					const [first, second, third] = [a, b, c].sort(function (x, y) {
						return helpers.compareNatural(x, y, { ignoreCase });
					});
					expect(helpers.compareNatural(first, second, { ignoreCase })).toBeLessThanOrEqual(0);
					expect(helpers.compareNatural(second, third, { ignoreCase })).toBeLessThanOrEqual(0);
					expect(helpers.compareNatural(first, third, { ignoreCase })).toBeLessThanOrEqual(0);
				})
			);
		});

		it('should sort the same way whatever the input order', function () {
			fc.assert(
				fc.property(fc.array(naturalString, { maxLength: 20 }), fc.boolean(), function (list, ignoreCase) {
					function compare(x: string, y: string): number {
						return helpers.compareNatural(x, y, { ignoreCase });
					}
					expect(list.slice().reverse().sort(compare)).toEqual(list.slice().sort(compare));
				})
			);
		});

		it('should order plain non-negative integers numerically', function () {
			fc.assert(
				fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 30n }), function (x, y) {
					expect(helpers.compareNatural(`file${x}.txt`, `file${y}.txt`)).toBe(x === y ? 0 : x < y ? -1 : 1);
				})
			);
		});
	});

	describe('truncateMiddle', function () {
		const text = fc.string({ unit: fc.constantFrom('a', 'b', '/', '.', 'é', 'e\u{301}', '👍🏽', '🇯🇵', '中', '\r\n'), maxLength: 30 });

		it('should keep the first and last graphemes of the string, `length` in all, around the ellipsis', function () {
			fc.assert(
				fc.property(text, fc.nat(30), fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom('…', '...', ''), function (value, length, position, ellipsis) {
					const result = helpers.truncateMiddle(value, length, { position, ellipsis });
					const parts = clustersOf(value);
					if (parts.length <= length) {
						expect(result).toBe(value);
						return;
					}
					// Rounded down, except for the rounding error of the product.
					const product = length * position;
					const head = Math.abs(product - Math.round(product)) <= product * 2 ** -50 ? Math.round(product) : Math.floor(product);
					expect(result).toBe(parts.slice(0, head).join('') + ellipsis + parts.slice(parts.length - (length - head)).join(''));
				})
			);
		});

		it('should split only the ends of long strings, with the same result as splitting them whole', function () {
			// Pieces that join or look back across neighbours (regional indicators, ZWJ sequences, marks, jamo, CR LF, conjuncts, prepended
			// characters, lone surrogates) mixed with plain ones, in strings longer than the windows the ends are split from.
			const piece = fc.constantFrom(
				'a',
				' ',
				'/',
				'\r',
				'\n',
				'é',
				'\u{301}',
				'\u{200d}',
				'\u{fe0f}',
				'👍',
				'🏽',
				'👨',
				'\u{1f1ef}',
				'\u{1f1f5}',
				'中',
				'カ',
				'각',
				'\u{1100}',
				'\u{1161}',
				'\u{11a8}',
				'क',
				'\u{94d}',
				'ि',
				'ก',
				'ำ',
				'\u{600}',
				'©',
				'\u{20000}',
				'\u{d800}',
				'\u{dc00}'
			);
			const long = fc.array(fc.oneof(piece, fc.constantFrom('a', 'b', 'カ', '👍')), { minLength: 20, maxLength: 300 }).map(function (parts) {
				return parts.join('');
			});
			fc.assert(
				fc.property(long, fc.nat(12), fc.double({ min: 0, max: 1, noNaN: true }), function (value, length, position) {
					const parts = clustersOf(value);
					const product = length * position;
					const head = Math.abs(product - Math.round(product)) <= product * 2 ** -50 ? Math.round(product) : Math.floor(product);
					const expected = parts.length <= length ? value : parts.slice(0, head).join('') + '…' + parts.slice(parts.length - (length - head)).join('');
					expect(helpers.truncateMiddle(value, length, { position })).toBe(expected);
				})
			);
		});

		it('should be truncate at position 1', function () {
			fc.assert(
				fc.property(text, fc.nat(30), function (value, length) {
					expect(helpers.truncateMiddle(value, length, { position: 1, ellipsis: '...' })).toBe(helpers.truncate(value, length));
				})
			);
		});
	});

	describe('stringWidth', function () {
		it('should add up the widths of whole clusters', function () {
			fc.assert(
				fc.property(fc.array(fc.constantFrom(...MEASURED_CLUSTERS), { maxLength: 20 }), function (items) {
					const text = items
						.map(function ([cluster]) {
							return cluster;
						})
						.join('');
					const expected = items.reduce(function (total, [, width]) {
						return total + width;
					}, 0);
					expect(helpers.stringWidth(text)).toBe(expected);
				})
			);
		});

		it('should not change when escape sequences are inserted between clusters', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: 'grapheme', maxLength: 20 }),
					fc.constantFrom('\x1b[1m', '\x1b[0m', '\x1b[38;5;196m', '\x1b]8;;x\x1b\\'),
					function (value, code) {
						// eslint-disable-next-line no-control-regex -- strings without escape sequences of their own
						fc.pre(!/[\x1b\x80-\x9f]/.test(value));
						expect(helpers.stringWidth(clustersOf(value).join(code))).toBe(helpers.stringWidth(value));
					}
				)
			);
		});

		it('should count printable ASCII by length, and never more than two columns per code point', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map(String.fromCharCode) }), fc.string({ unit: 'binary' }), function (ascii, any) {
					expect(helpers.stringWidth(ascii)).toBe(ascii.length);
					const width = helpers.stringWidth(any);
					expect(width).toBeGreaterThanOrEqual(0);
					expect(width).toBeLessThanOrEqual(2 * Array.from(any).length);
				})
			);
		});
	});
});

/** The pattern of `ansi-regex` 6.4 (used by `strip-ansi` 7), as a reference for the sequences both read the same way. */
// eslint-disable-next-line no-control-regex -- escape sequences start with control characters
const ANSI_REGEX_REFERENCE = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c\x9d]*(?:\x07|\x1b\\|\x9c)|[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/** Text without escape sequences: no ESC, no C0 or C1 controls. */
const plainText = fc
	.string({ unit: fc.oneof(fc.constantFrom('a', 'Z', ' ', '9', ';', '[', ']', '\\', 'm', 'é', '古', '😀'), fc.string({ minLength: 1, maxLength: 1 })) })
	.map(function (text) {
		// eslint-disable-next-line no-control-regex -- removes the control characters from the generated text
		return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
	});

/** Well-formed escape sequences that `strip-ansi` removes whole too: SGR and other CSI sequences, OSC strings (hyperlinks, titles) with each terminator. */
const escapeSequence = fc.oneof(
	fc.array(fc.nat(255), { maxLength: 5 }).map(function (params) {
		return `\x1b[${params.join(';')}m`;
	}),
	fc.tuple(fc.constantFrom('\x1b[', '\x9b'), fc.constantFrom('', '?', '1', '12;3', '?25'), fc.constantFrom('A', 'B', 'H', 'J', 'K', 'h', 'l', 'm')).map(function (parts) {
		return parts.join('');
	}),
	fc
		.tuple(
			fc.constantFrom('\x1b]', '\x9d'),
			fc.constantFrom('8;;', '8;id=1;', '0;', '2;'),
			fc.string({ unit: fc.constantFrom('h', 't', 'p', ':', '/', '.', 'x', '?', '=', '&', ' ', 'é'), maxLength: 12 }),
			fc.constantFrom('\x07', '\x1b\\', '\x9c')
		)
		.map(function (parts) {
			return parts.join('');
		})
);

describe('String helpers (property-based, text cleanup)', function () {
	describe('stripAnsi', function () {
		it('removes every inserted sequence and nothing else', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(plainText, fc.array(escapeSequence, { maxLength: 3 })), { maxLength: 6 }), function (pieces) {
					const text = pieces
						.map(function ([plain, codes]) {
							return codes.join('') + plain;
						})
						.join('');
					const expected = pieces
						.map(function ([plain]) {
							return plain;
						})
						.join('');
					expect(helpers.stripAnsi(text)).toBe(expected);
					expect(helpers.stripAnsi(text)).toBe(text.replace(ANSI_REGEX_REFERENCE, ''));
				})
			);
		});

		it('only removes characters, and leaves text without ESC or C1 introducers alone', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('\x1b', '\x9b', '\x9d', '\x9c', '\x90', '\x07', '[', ']', '\\', ';', '1', 'm', 'a', 'P', '\x18', '古') }),
					function (text) {
						const stripped = helpers.stripAnsi(text);
						// A subsequence of the input.
						let index = 0;
						for (const char of stripped) index = text.indexOf(char, index) + 1;
						expect(index).toBeGreaterThan(stripped === '' ? -1 : 0);
						expect(stripped.length).toBeLessThanOrEqual(text.length);
						// eslint-disable-next-line no-control-regex -- the introducers
						if (!/[\x1b\x90\x98\x9b\x9d-\x9f]/.test(text)) expect(stripped).toBe(text);
					}
				)
			);
		});

		it('never outputs an ESC or C1 introducer, so stripping twice changes nothing', function () {
			/** Fragments of sequences, stray introducers and terminators, mixed with any text. */
			const fragment = fc.oneof(
				fc.constantFrom('\x1b', '\x1b[', '\x1b]', '\x1bP', '\x1b\\', '\x9b', '\x9d', '\x90', '\x98', '\x9e', '\x9f', '\x9c', '\x07', '\x18', '\x1a'),
				fc.constantFrom('[', ']', '0', '31', ';', 'm', '2;', '52;c;', '(B', 'a', ' '),
				escapeSequence,
				fc.string({ unit: 'binary', maxLength: 3 })
			);
			fc.assert(
				fc.property(fc.array(fragment, { maxLength: 12 }), function (fragments) {
					const stripped = helpers.stripAnsi(fragments.join(''));
					// eslint-disable-next-line no-control-regex -- the introducers
					expect(/[\x1b\x90\x98\x9b\x9d-\x9f]/.test(stripped)).toBe(false);
					expect(helpers.stripAnsi(stripped)).toBe(stripped);
				})
			);
		});

		it('is the identity on text without ESC or C1 introducers', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'binary' }), function (text) {
					// eslint-disable-next-line no-control-regex -- the introducers
					const plain = text.replace(/[\x1b\x90\x98\x9b\x9d-\x9f]/g, '');
					expect(helpers.stripAnsi(plain)).toBe(plain);
				})
			);
		});
	});

	describe('stripHtml', function () {
		it('returns any text escaped with escapeHtml', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme' }), function (text) {
					expect(helpers.stripHtml(helpers.escapeHtml(text))).toBe(text);
				})
			);
		});

		/** An attribute value, with the characters that must not end a tag. */
		const attributeValue = fc.string({ unit: fc.constantFrom('a', ' ', '<', '>', '/', '=', '-', "'", '"'), maxLength: 6 });
		/** A piece of markup that holds no text. */
		const markup = fc.oneof(
			fc
				.tuple(
					fc.constantFrom('a', 'span', 'DIV', 'b', 'x-y'),
					fc.array(fc.tuple(fc.constantFrom('id', 'title', 'data-x', 'on-click'), attributeValue, fc.constantFrom('"', "'", '')), { maxLength: 3 }),
					fc.constantFrom('>', '/>', ' >', '\n>')
				)
				.map(function ([name, attributes, close]) {
					return (
						`<${name}` +
						attributes
							.map(function ([key, value, quote]) {
								// An unquoted value cannot hold white space, quotes, `=`, `<` or `>`.
								const written = quote === '' ? value.replace(/[\s'"=<>]/g, '') || 'v' : value.split(quote).join('');
								return ` ${key}=${quote}${written}${quote}`;
							})
							.join('') +
						close
					);
				}),
			fc.constantFrom('a', 'span', 'DIV').map(function (name) {
				return `</${name}>`;
			}),
			fc.string({ unit: fc.constantFrom('a', ' ', '<', '>', '-', '!'), maxLength: 8 }).map(function (content) {
				// A comment ends at the first `-->` or `--!>`: a space before every `>` keeps the content from holding one.
				return `<!-- ${content.replace(/>/g, ' >')} -->`;
			}),
			fc.constantFrom('<!-->', '<!--->', '<!DOCTYPE html>', '<?xml version="1.0"?>', '<![CDATA[x]]>', '</>', '<br/>'),
			fc.tuple(fc.constantFrom('script', 'STYLE'), fc.string({ unit: fc.constantFrom('a', '<', '>', '=', 'b', ' ', '"', 's'), maxLength: 10 })).map(function ([
				name,
				content
			]) {
				// Without `/`, the content cannot hold an end tag.
				return `<${name}>${content}</${name.toLowerCase()}>`;
			})
		);

		it('keeps exactly the (escaped) text between generated markup', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(fc.string({ maxLength: 6 }), markup), { maxLength: 8 }), fc.string({ maxLength: 6 }), function (pieces, last) {
					const html = pieces
						.map(function ([text, tag]) {
							return helpers.escapeHtml(text) + tag;
						})
						.join('');
					const expected = pieces
						.map(function ([text]) {
							return text;
						})
						.join('');
					expect(helpers.stripHtml(html + helpers.escapeHtml(last))).toBe(expected + last);
				})
			);
		});

		it('never grows the text, and keeps text without markup', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('<', '>', '/', '!', '-', '?', '"', "'", '=', ' ', 'a', 's', 'c', 'r', 'i', 'p', 't', '&', ';') }),
					function (html) {
						const text = helpers.stripHtml(html);
						expect(text.length).toBeLessThanOrEqual(html.length);
						if (!/[<&]/.test(html)) expect(text).toBe(html);
					}
				)
			);
		});
	});

	describe('indent', function () {
		it('prefixes every non-blank line and keeps the line breaks', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('a', ' ', '\t', '\n', '\r', 'é', '\u2028') }),
					fc.oneof(fc.nat(4), fc.constantFrom('', '\t', '> ')),
					fc.boolean(),
					function (text, count, includeEmptyLines) {
						const prefix = typeof count === 'string' ? count : ' '.repeat(count);
						const lines = helpers.splitLines(text);
						const indented = helpers.splitLines(helpers.indent(text, count, { includeEmptyLines }));
						expect(indented).toHaveLength(lines.length);
						lines.forEach(function (line, index) {
							expect(indented[index]).toBe(includeEmptyLines || line.trim() !== '' ? prefix + line : line);
						});
						// eslint-disable-next-line no-control-regex -- only the separators are compared
						expect(helpers.indent(text, count, { includeEmptyLines }).replace(/[^\r\n]/g, '')).toBe(text.replace(/[^\r\n]/g, ''));
					}
				)
			);
		});

		it('is undone by dedent for text whose first and last lines are not blank', function () {
			fc.assert(
				fc.property(
					fc
						.array(fc.oneof(fc.constant(''), fc.stringMatching(/^[a-z(][a-z ()]{0,6}$/), fc.stringMatching(/^ {1,3}[a-z][a-z ]{0,4}$/)), {
							minLength: 1,
							maxLength: 6
						})
						.filter(function (lines) {
							return /^[a-z(]/.test(lines[0]) && lines[lines.length - 1].trim() !== '';
						}),
					fc.integer({ min: 1, max: 4 }),
					function (lines, count) {
						const text = lines.join('\n');
						expect(helpers.dedent(helpers.indent(text, count))).toBe(text);
					}
				)
			);
		});
	});

	describe('splitOnce / splitLast', function () {
		it('split around the first and last occurrence, and join back', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('a', 'b', '=', '😀') }),
					fc.string({ unit: fc.constantFrom('a', '=', '😀'), maxLength: 2 }),
					function (text, sep) {
						const first = helpers.splitOnce(text, sep);
						const last = helpers.splitLast(text, sep);
						expect(first === undefined).toBe(!text.includes(sep));
						expect(last === undefined).toBe(!text.includes(sep));
						if (first !== undefined && last !== undefined) {
							expect(first.join(sep)).toBe(text);
							expect(last.join(sep)).toBe(text);
							// The empty separator occurs everywhere: at the start for splitOnce, at the end for splitLast.
							expect(first[0].includes(sep)).toBe(sep === '');
							expect(last[1].includes(sep)).toBe(sep === '');
							expect(first[0].length).toBeLessThanOrEqual(last[0].length);
						}
					}
				)
			);
		});
	});

	describe('toSafeFilename', function () {
		/** The characters a safe name never holds (the separator lookalikes of Windows best-fit conversions included). */
		// eslint-disable-next-line no-control-regex -- the forbidden characters
		const FORBIDDEN = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩⁄∕∖⧸⧹﹨／：＼]|\p{Cs}/u;

		/** Text with every kind of character the helper treats specially. */
		const anyName = fc.string({
			unit: fc.oneof(
				fc.constantFrom(
					'a',
					'Z',
					'.',
					' ',
					'/',
					'\\',
					':',
					'*',
					'?',
					'"',
					'<',
					'>',
					'|',
					'\0',
					'\x1f',
					'\x85',
					'∕',
					'／',
					'＼',
					'﹨',
					'：',
					'¥',
					'\u202e',
					'é',
					'e\u0301',
					'日',
					'😀',
					'👍🏽',
					'\ud800',
					'con',
					'NUL',
					'com1',
					'lpt\u00b9',
					'conin$'
				),
				fc.string({ minLength: 1, maxLength: 1 })
			),
			maxLength: 30
		});

		it('always returns a valid, non-empty name within maxLength UTF-8 bytes', function () {
			fc.assert(
				fc.property(
					anyName,
					fc.constantFrom('_', '', '-', 'x.y', ' '),
					fc.oneof(fc.integer({ min: 1, max: 40 }), fc.constant(255)),
					function (name, replacement, maxLength) {
						const safe = helpers.toSafeFilename(name, { replacement, maxLength });
						expect(safe).not.toBe('');
						expect(safe).not.toBe('.');
						expect(safe).not.toBe('..');
						expect(FORBIDDEN.test(safe)).toBe(false);
						expect(/[. ]$/.test(safe)).toBe(false);
						expect(/^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³]) *(\.|$)/i.test(safe)).toBe(false);
						expect(new TextEncoder().encode(safe).length).toBeLessThanOrEqual(maxLength);
					}
				)
			);
		});

		it('only changes what it must: a valid name within the limit is returned as it is', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^[a-zA-Z0-9_-][a-zA-Z0-9 ._-]{0,20}[a-zA-Z0-9_-]$/), function (name) {
					fc.pre(!/^(con|prn|aux|nul|(com|lpt)[0-9]) *(\.|$)/i.test(name));
					expect(helpers.toSafeFilename(name)).toBe(name);
				})
			);
		});

		it('cuts between graphemes, keeping the extension when there is room (vs a reference)', function () {
			const encoder = new TextEncoder();
			function bytes(text: string): number {
				return encoder.encode(text).length;
			}
			function fit(text: string, budget: number): string {
				let fitted = '';
				for (const grapheme of graphemes(text)) {
					if (bytes(fitted + grapheme) > budget) break;
					fitted += grapheme;
				}
				return fitted;
			}
			fc.assert(
				fc.property(
					fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 }),
					fc.stringMatching(/^[a-z]{1,4}$/),
					fc.integer({ min: 1, max: 40 }),
					function (stem, extension, maxLength) {
						// The characters the helper replaces or trims.
						fc.pre(!FORBIDDEN.test(stem) && !/[ .]/.test(stem) && !/^(con|prn|aux|nul|com|lpt)/i.test(stem));
						const name = `${stem}.${extension}`;
						const room = maxLength - extension.length - 1;
						const kept = room > 0 ? fit(stem, room) : '';
						const expected = bytes(name) <= maxLength ? name : kept !== '' ? `${kept}.${extension}` : fit(name, maxLength).replace(/\.$/, '') || '_';
						expect(helpers.toSafeFilename(name, { maxLength })).toBe(expected);
					}
				)
			);
		});
	});

	describe('toSlug options', function () {
		it('only joins the words differently with a custom separator', function () {
			fc.assert(
				fc.property(fc.string({ unit: 'grapheme', maxLength: 20 }), fc.constantFrom('_', '', '--', '.'), function (text, joiner) {
					expect(helpers.toSlug(text, { separator: joiner })).toBe(helpers.toSlug(text).split('-').join(joiner));
				})
			);
		});

		it('keeps the case of the same letters with lowercase: false', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('a', 'B', 'é', 'Ö', 'ß', 'ẞ', 'Æ', 'œ', ' ', '-', '1', '日', 'İ', 'Σ'), maxLength: 12 }), function (text) {
					const slug = helpers.toSlug(text, { lowercase: false });
					expect(slug).toMatch(/^([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*)?$/);
					expect(slug.toLowerCase()).toBe(helpers.toSlug(text));
				})
			);
		});
	});

	describe('truncate with a separator', function () {
		it('cuts at the last occurrence that starts on a grapheme boundary at or before the hard cut (vs a reference)', function () {
			fc.assert(
				fc.property(
					fc.string({ unit: fc.constantFrom('a', 'b', ' ', '-', 'é', 'e\u0301', '👍🏽', '\u0301'), maxLength: 16 }),
					fc.nat(12),
					fc.constantFrom(' ', '-', ' -', '\u0301'),
					function (text, length, sep) {
						const hard = helpers.truncate(text, length, '');
						const soft = helpers.truncate(text, length, { separator: sep, suffix: '' });
						let expected = hard;
						if (hard !== text) {
							let boundary = 0;
							let last = -1;
							for (const grapheme of [''].concat(graphemes(text))) {
								boundary += grapheme.length;
								if (boundary > hard.length) break;
								if (text.startsWith(sep, boundary)) last = boundary;
							}
							if (last !== -1) expected = text.slice(0, last);
						}
						expect(soft).toBe(expected);
						expect(helpers.truncate(text, length, { separator: new RegExp(sep), suffix: '' })).toBe(expected);
						expect(helpers.truncate(text, length, { separator: sep, suffix: '~' })).toBe(hard === text ? text : expected + '~');
					}
				)
			);
		});
	});
});
