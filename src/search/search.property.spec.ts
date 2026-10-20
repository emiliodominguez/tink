import fc from 'fast-check';
import * as helpers from '.';

// Small alphabets so that matches (and ties) are frequent; separators and case changes exercise the word-start bonuses.
const alphabet = fc.constantFrom('a', 'b', 'c', 'A', 'B', ' ', '-', '_', '.', 'é', '😀');
const shortText = fc.array(alphabet, { maxLength: 9 }).map(function (chars) {
	return chars.join('');
});
const shortQuery = fc.array(alphabet, { maxLength: 4 }).map(function (chars) {
	return chars.join('');
});
const lowerWord = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 4 }).map(function (chars) {
	return chars.join('');
});

function fold(char: string, caseSensitive: boolean): string {
	return caseSensitive ? char : char.toLowerCase();
}

function isWord(c: string | undefined): boolean {
	return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/** Independent re-implementation of the documented scoring of one alignment (positions are code point indices). */
function referenceScore(query: string[], target: string[], positions: number[]): number {
	let score = -Math.min(positions[0], 8);
	positions.forEach(function (p, i) {
		const prev = target[p - 1];
		const boundary = p === 0 || (isWord(target[p]) && !isWord(prev)) || (prev !== prev.toUpperCase() && target[p] !== target[p].toLowerCase());
		score += 16 + (boundary ? 8 : 0) + (query[i] === target[p] ? 1 : 0);
		if (i > 0) {
			const gap = p - positions[i - 1] - 1;
			score += gap === 0 ? 5 : -3 - (gap - 1);
		}
	});
	return score;
}

/** Brute force: the best score over every alignment, or undefined when there is none. */
function bruteForce(query: string, target: string, caseSensitive: boolean): number | undefined {
	const q = Array.from(query);
	const t = Array.from(target);
	if (q.length === 0) return 0;
	let best: number | undefined;
	(function search(i: number, from: number, positions: number[]): void {
		if (i === q.length) {
			const score = referenceScore(q, t, positions);
			if (best === undefined || score > best) best = score;
			return;
		}
		for (let p = from; p < t.length; p++) {
			if (fold(q[i], caseSensitive) === fold(t[p], caseSensitive)) search(i + 1, p + 1, [...positions, p]);
		}
	})(0, 0, []);
	return best;
}

/** UTF-16 ranges → code point positions in `target`. */
function positionsOf(target: string, ranges: Array<[number, number]>): number[] {
	const positions: number[] = [];
	let offset = 0;
	Array.from(target).forEach(function (char, index) {
		if (
			ranges.some(function ([start, end]) {
				return offset >= start && offset < end;
			})
		)
			positions.push(index);
		offset += char.length;
	});
	return positions;
}

describe('Search helpers (property-based)', function () {
	describe('fuzzyMatch', function () {
		it('should be defined iff the query is a subsequence, and score the optimal alignment (vs brute force)', function () {
			fc.assert(
				fc.property(shortQuery, shortText, fc.boolean(), function (query, target, caseSensitive) {
					const result = helpers.fuzzyMatch(query, target, { caseSensitive });
					const expected = bruteForce(query, target, caseSensitive);
					expect(result?.score).toBe(expected);
				}),
				{ numRuns: 500 }
			);
		});

		it('should find the optimum on queries built from the target (always matching)', function () {
			fc.assert(
				fc.property(
					shortText.chain(function (target) {
						return fc.tuple(fc.constant(target), fc.subarray(Array.from(target)));
					}),
					function ([target, chars]) {
						const query = chars.join('');
						const result = helpers.fuzzyMatch(query, target);
						expect(result).toBeDefined();
						expect(result!.score).toBe(bruteForce(query, target, false));
					}
				)
			);
		});

		it('should return sorted, non-overlapping, merged, in-bounds ranges that spell the query with the reported score', function () {
			fc.assert(
				fc.property(shortQuery, shortText, function (query, target) {
					const result = helpers.fuzzyMatch(query, target);
					if (result === undefined) return;
					const { ranges, score } = result;
					ranges.forEach(function ([start, end], i) {
						expect(0 <= start && start < end && end <= target.length).toBe(true);
						if (i > 0) expect(start).toBeGreaterThan(ranges[i - 1][1]);
					});
					const spelled = ranges
						.map(function ([start, end]) {
							return target.slice(start, end);
						})
						.join('');
					expect(spelled.toLowerCase()).toBe(query.toLowerCase());
					if (query !== '') expect(referenceScore(Array.from(query), Array.from(target), positionsOf(target, ranges))).toBe(score);
				})
			);
		});

		it('should score an exact prefix at least as high as the same query scattered', function () {
			fc.assert(
				fc.property(
					lowerWord,
					fc.array(fc.constantFrom('a', 'b', 'x', ' ', '-', '_'), { maxLength: 6 }),
					fc.array(fc.constantFrom('a', 'x', ' ', '-'), { maxLength: 3 }),
					function (query, fillers, suffix) {
						const scattered = Array.from(query)
							.map(function (char, i) {
								return (fillers[i] ?? '') + char;
							})
							.join('');
						const prefixed = query + suffix.join('');
						expect(helpers.fuzzyMatch(query, prefixed)!.score).toBeGreaterThanOrEqual(helpers.fuzzyMatch(query, scattered)!.score);
					}
				)
			);
		});
	});

	describe('fuzzySearch', function () {
		it('should return the matching items, sorted by score, ties in original order', function () {
			fc.assert(
				fc.property(fc.array(shortText, { maxLength: 15 }), shortQuery, function (items, query) {
					const results = helpers.fuzzySearch(
						items.map(function (text, index) {
							return { text, index };
						}),
						query,
						{
							key: function (item) {
								return item.text;
							}
						}
					);
					const expected = items
						.map(function (text, index) {
							return { index, match: helpers.fuzzyMatch(query, text) };
						})
						.filter(function (entry) {
							return entry.match !== undefined;
						});
					expect(results).toHaveLength(expected.length);
					results.forEach(function (result, i) {
						expect(result.score).toBe(helpers.fuzzyMatch(query, result.key)!.score);
						if (i > 0) {
							const previous = results[i - 1];
							expect(previous.score > result.score || (previous.score === result.score && previous.item.index < result.item.index)).toBe(true);
						}
					});
				})
			);
		});

		it('should agree with the unlimited search for any limit and threshold', function () {
			fc.assert(
				fc.property(fc.array(shortText, { maxLength: 15 }), shortQuery, fc.nat(20), fc.integer({ min: -20, max: 80 }), function (items, query, limit, threshold) {
					const all = helpers.fuzzySearch(items, query);
					expect(helpers.fuzzySearch(items, query, { limit, threshold })).toEqual(
						all
							.filter(function (r) {
								return r.score >= threshold;
							})
							.slice(0, limit)
					);
				})
			);
		});

		it('should pick the best of several keys', function () {
			fc.assert(
				fc.property(fc.array(shortText, { minLength: 1, maxLength: 4 }), shortQuery, function (texts, query) {
					const results = helpers.fuzzySearch([texts], query, {
						key: function (item) {
							return item;
						}
					});
					const scores = texts
						.map(function (text) {
							return helpers.fuzzyMatch(query, text)?.score;
						})
						.filter(function (score): score is number {
							return score !== undefined;
						});
					if (scores.length === 0) expect(results).toEqual([]);
					else expect(results[0].score).toBe(Math.max(...scores));
				})
			);
		});
	});

	describe('highlight', function () {
		it('should produce segments that concatenate to the text and whose flags match the ranges', function () {
			fc.assert(
				fc.property(
					fc.string({ maxLength: 20 }).chain(function (text) {
						const bound = fc.nat(text.length);
						return fc.tuple(
							fc.constant(text),
							fc.array(
								fc.tuple(bound, bound).map(function ([a, b]): [number, number] {
									return [Math.min(a, b), Math.max(a, b)];
								}),
								{ maxLength: 5 }
							)
						);
					}),
					function ([text, ranges]) {
						const segments = helpers.highlight(text, ranges);
						expect(
							segments
								.map(function (s) {
									return s.text;
								})
								.join('')
						).toBe(text);
						let offset = 0;
						segments.forEach(function (segment, i) {
							expect(segment.text).not.toBe('');
							if (i > 0) expect(segment.match).not.toBe(segments[i - 1].match);
							for (let k = offset; k < offset + segment.text.length; k++) {
								const covered = ranges.some(function ([start, end]) {
									return k >= start && k < end;
								});
								expect(covered).toBe(segment.match);
							}
							offset += segment.text.length;
						});
					}
				)
			);
		});
	});
});

/** The combining diacritical mark blocks that `ignoreDiacritics` removes. */
const DIACRITIC = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/gu;
/** The letters `ignoreDiacritics` spells in ASCII. */
const SPELLED: Record<string, string> = {
	ß: 'ss',
	ẞ: 'SS',
	æ: 'ae',
	Æ: 'AE',
	œ: 'oe',
	Œ: 'OE',
	ø: 'o',
	Ø: 'O',
	đ: 'd',
	Đ: 'D',
	ð: 'd',
	Ð: 'D',
	ł: 'l',
	Ł: 'L',
	þ: 'th',
	Þ: 'TH',
	ı: 'i'
};

/**
 * Reference folding for `ignoreDiacritics`: the characters each code point of `text` folds to, case kept (a code point that would fold to
 * more than 3 characters is kept as it is).
 */
function foldChars(text: string): string[] {
	const chars: string[] = [];
	for (const char of text) {
		const decomposed = char.normalize('NFKD').replace(DIACRITIC, '');
		const parts: string[] = [];
		for (const part of decomposed) parts.push(...Array.from(Object.hasOwn(SPELLED, part) ? SPELLED[part] : part));
		chars.push(...(parts.length > 3 ? [char] : parts));
	}
	return chars;
}

/** Brute force over already-folded characters. */
function bruteForceChars(q: string[], t: string[], caseSensitive: boolean): number | undefined {
	if (q.length === 0) return 0;
	let best: number | undefined;
	(function search(i: number, from: number, positions: number[]): void {
		if (i === q.length) {
			const score = referenceScore(q, t, positions);
			if (best === undefined || score > best) best = score;
			return;
		}
		for (let p = from; p < t.length; p++) {
			if (fold(q[i], caseSensitive) === fold(t[p], caseSensitive)) search(i + 1, p + 1, [...positions, p]);
		}
	})(0, 0, []);
	return best;
}

// Accented letters, precomposed and decomposed, letters that fold to several characters, and separators.
// `'ﬃ'` folds to 3 characters, `'㏂'` (`a.m.`), `'㍿'` and `'ﷺ'` (18 characters) to more, so they are kept as they are.
const accented = fc.constantFrom('a', 'e', 'E', 'é', 'É', 'e\u0301', 'è', 'ß', 'æ', 'Ø', '\ufb01', '\ufb03', '\u33c2', '\u337f', '\ufdfa', ' ', '-', 'B', 'b', '\u0301');
const accentedText = fc.array(accented, { maxLength: 7 }).map(function (chars) {
	return chars.join('');
});
const accentedQuery = fc.array(fc.constantFrom('a', 'e', 'E', 'é', 's', 'ß', 'f', 'i', 'o', 'b', 'B', '\u0301', '\ufdfa', 'm', '.'), { maxLength: 4 }).map(function (chars) {
	return chars.join('');
});

describe('Search helpers with ignoreDiacritics (property-based)', function () {
	it('scores the optimal alignment of the folded characters (vs brute force)', function () {
		fc.assert(
			fc.property(accentedQuery, accentedText, fc.boolean(), function (query, target, caseSensitive) {
				const result = helpers.fuzzyMatch(query, target, { caseSensitive, ignoreDiacritics: true });
				expect(result?.score).toBe(bruteForceChars(foldChars(query), foldChars(target), caseSensitive));
			}),
			{ numRuns: 500 }
		);
	});

	it('returns ranges of whole code points with their accents, whose folded text holds the query', function () {
		fc.assert(
			fc.property(accentedQuery, accentedText, function (query, target) {
				const result = helpers.fuzzyMatch(query, target, { ignoreDiacritics: true });
				if (result === undefined) return;
				let spelled: string[] = [];
				result.ranges.forEach(function ([start, end], i) {
					expect(0 <= start && start < end && end <= target.length).toBe(true);
					if (i > 0) expect(start).toBeGreaterThan(result.ranges[i - 1][1]);
					// A range neither starts nor ends next to a combining accent of its letter.
					expect(/^[\u0300-\u036f]/.test(target.slice(start))).toBe(false);
					expect(/^[\u0300-\u036f]/.test(target.slice(end))).toBe(false);
					spelled = spelled.concat(foldChars(target.slice(start, end)));
				});
				const needed = foldChars(query).map(function (char) {
					return char.toLowerCase();
				});
				let k = 0;
				for (const char of spelled) if (char.toLowerCase() === needed[k]) k++;
				expect(k).toBe(needed.length);
			})
		);
	});

	it('folds a text to at most 3 characters per code point', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.oneof(fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }), accented) }), function (text) {
				const codePoints = Array.from(text).length;
				expect(foldChars(text).length).toBeLessThanOrEqual(3 * codePoints);
				// Matched against itself, every folded character is matched, and earns at most 16 + 8 + 5 + 1 = 30.
				const self = helpers.fuzzyMatch(text, text, { ignoreDiacritics: true });
				expect(self).toBeDefined();
				expect((self as { score: number }).score).toBeLessThanOrEqual(30 * 3 * codePoints);
			})
		);
	});

	it('scores a text the same in NFC and NFD', function () {
		fc.assert(
			fc.property(accentedQuery, accentedText, fc.boolean(), function (query, target, caseSensitive) {
				const options = { caseSensitive, ignoreDiacritics: true };
				const composed = helpers.fuzzyMatch(query.normalize('NFC'), target.normalize('NFC'), options);
				const decomposed = helpers.fuzzyMatch(query.normalize('NFD'), target.normalize('NFD'), options);
				expect(decomposed?.score).toBe(composed?.score);
			})
		);
	});

	it('changes nothing for ASCII text', function () {
		fc.assert(
			fc.property(shortQuery, shortText, fc.boolean(), function (query, target, caseSensitive) {
				fc.pre(!/[^\0-\x7f]/.test(query + target));
				expect(helpers.fuzzyMatch(query, target, { caseSensitive, ignoreDiacritics: true })).toEqual(helpers.fuzzyMatch(query, target, { caseSensitive }));
			})
		);
	});

	it('finds what fuzzySearch finds with the same option', function () {
		fc.assert(
			fc.property(fc.array(accentedText, { maxLength: 8 }), accentedQuery, function (items, query) {
				const results = helpers.fuzzySearch(items, query, { ignoreDiacritics: true });
				const expected = items.filter(function (item) {
					return helpers.fuzzyMatch(query, item, { ignoreDiacritics: true }) !== undefined;
				});
				expect(results).toHaveLength(expected.length);
			})
		);
	});
});

/** A naive word splitter: NFC, format characters ignored (a zero-width space separates), lower case, then one code point at a time. */
function naiveTokenize(text: string, caseSensitive = false): string[] {
	let prepared = text.replace(/\p{Cf}/gu, function (char) {
		return char === '​' ? ' ' : '';
	});
	if (!caseSensitive) prepared = prepared.toLowerCase();
	prepared = prepared.normalize('NFC');
	const tokens: string[] = [];
	let current = '';
	for (const char of prepared) {
		if (/[\p{L}\p{N}]/u.test(char) || (current !== '' && /\p{M}/u.test(char))) current += char;
		else if (current !== '') {
			tokens.push(current);
			current = '';
		}
	}
	if (current !== '') tokens.push(current);
	return tokens;
}

/** Folds one code point at a time (no length cap, unlike `foldChars`): compatibility decomposition, diacritics removed, spelled letters. */
function naiveFold(text: string): string {
	let folded = '';
	for (const char of text) {
		for (const part of char.normalize('NFKD').replace(DIACRITIC, '')) folded += Object.hasOwn(SPELLED, part) ? SPELLED[part] : part;
	}
	return folded;
}

const tokenChars = fc.constantFrom(
	'a',
	'B',
	'z',
	'0',
	'7',
	' ',
	'-',
	"'",
	'_',
	'.',
	'é',
	'E',
	'́',
	'̈',
	'ß',
	'Æ',
	'ﬁ',
	'Ａ',
	'Σ',
	'ς',
	'İ',
	'ı',
	'ł',
	'한',
	'東',
	'ि',
	'न',
	'٣',
	'𝒳',
	'😀',
	'­',
	'​',
	'‍',
	'⁠',
	'\ud800',
	'²',
	// Lower-cased, 'J' + caron and 'Ϊ' + acute compose ('ǰ', 'ΐ'); a capital Greek vowel + ypogegrammeni may too.
	'J',
	'\u030c',
	'\u03aa',
	'\u0345'
);
const tokenText = fc.array(tokenChars, { maxLength: 16 }).map(function (chars) {
	return chars.join('');
});

describe('tokenize (property-based)', function () {
	it('splits like a naive code point scan', function () {
		fc.assert(
			fc.property(tokenText, fc.boolean(), function (text, caseSensitive) {
				expect(helpers.tokenize(text, { caseSensitive })).toEqual(naiveTokenize(text, caseSensitive));
			})
		);
	});

	it('folds like a per-code-point decomposition with ignoreDiacritics', function () {
		fc.assert(
			fc.property(tokenText, function (text) {
				const formatless = text.replace(/\p{Cf}/gu, function (char) {
					return char === '\u200b' ? ' ' : '';
				});
				expect(helpers.tokenize(text, { ignoreDiacritics: true })).toEqual(naiveTokenize(naiveFold(formatless.normalize('NFC'))));
			})
		);
	});

	it('is idempotent and gives the same tokens in NFC and NFD', function () {
		fc.assert(
			fc.property(tokenText, fc.boolean(), function (text, ignoreDiacritics) {
				const tokens = helpers.tokenize(text, { ignoreDiacritics });
				expect(helpers.tokenize(tokens.join(' '), { ignoreDiacritics })).toEqual(tokens);
				expect(helpers.tokenize(text.normalize('NFD'), { ignoreDiacritics })).toEqual(tokens);
				for (const token of tokens) {
					expect(token).toBe(token.normalize('NFC'));
					expect(helpers.tokenize(token, { ignoreDiacritics })).toEqual([token]);
				}
			})
		);
	});

	it('drops exactly the short tokens and the stop words', function () {
		fc.assert(
			fc.property(tokenText, fc.integer({ min: 1, max: 4 }), fc.subarray(['a', 'b', 'é', 'ab', '0', '7a']), function (text, minLength, stops) {
				const stopWords = new Set(stops);
				const expected = helpers.tokenize(text).filter(function (token) {
					return Array.from(token).length >= minLength && !stopWords.has(token);
				});
				expect(helpers.tokenize(text, { minLength, stopWords })).toEqual(expected);
			})
		);
	});

	it('only adds boundaries at the segments of a segmenter', function () {
		fc.assert(
			fc.property(tokenText, fc.array(fc.nat(), { maxLength: 4 }), function (text, cuts) {
				const prepared = text
					.replace(/\p{Cf}/gu, function (char) {
						return char === '​' ? ' ' : '';
					})
					.normalize('NFC');
				const points = cuts
					.map(function (cut) {
						return cut % (prepared.length + 1);
					})
					.sort(function (x, y) {
						return x - y;
					});
				const segments = [0, ...points, prepared.length].slice(1).map(function (end, i, ends) {
					return prepared.slice(i === 0 ? 0 : ends[i - 1], end);
				});
				const segmenter = {
					segment: function (input: string) {
						expect(input).toBe(prepared);
						return segments.map(function (segment) {
							return { segment };
						});
					}
				};
				expect(helpers.tokenize(text, { segmenter })).toEqual(naiveTokenize(segments.join(' ')));
			})
		);
	});
});

// --- createSearchIndex vs a naive BM25 computed from the documents -------------------------------------------------

interface Doc {
	id: number;
	title?: string | string[] | null;
	body?: string;
}

const FIELDS = ['title', 'body'] as const;
const vocabulary = fc.constantFrom('a', 'ab', 'abc', 'b', 'ba', 'bab', 'c', 'ca', 'cab', 'd', '__proto__', 'constructor');
const phrase = fc.array(vocabulary, { maxLength: 6 }).map(function (words) {
	return words.join(' ');
});
const docArbitrary = fc.record(
	{
		id: fc.integer({ min: 0, max: 7 }),
		title: fc.oneof(phrase, fc.array(phrase, { maxLength: 2 }), fc.constant(null)),
		body: phrase
	},
	{ requiredKeys: ['id'] }
);
const operation = fc.oneof(
	fc.record({ type: fc.constant('add' as const), doc: docArbitrary }),
	fc.record({ type: fc.constant('replace' as const), doc: docArbitrary }),
	fc.record({ type: fc.constant('remove' as const), id: fc.integer({ min: 0, max: 7 }) })
);
const queryArbitrary = fc.record({
	text: fc
		.array(fc.constantFrom('a', 'ab', 'b', 'ba', 'c', 'ca', 'cab', 'd', 'e', 'abc', '__proto__', '_', 'constructor', 'toString'), { maxLength: 4 })
		.map(function (words) {
			return words.join(' ');
		}),
	prefix: fc.constantFrom(false, true, 'last' as const),
	combine: fc.constantFrom('or' as const, 'and' as const)
});
const settings = fc.record({
	boosts: fc.tuple(fc.double({ min: 0.1, max: 5, noNaN: true }), fc.double({ min: 0.1, max: 5, noNaN: true })),
	k1: fc.oneof(fc.constant(1.2), fc.constant(0), fc.double({ min: 0, max: 3, noNaN: true })),
	b: fc.oneof(fc.constant(0.75), fc.constant(0), fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true }))
});

/** The texts of a field. */
function textsOf(doc: Doc, field: (typeof FIELDS)[number]): string[] {
	const value = doc[field];
	return value == null ? [] : typeof value === 'string' ? [value] : value;
}

/** The terms of a field (split on spaces, like the indexes under test). */
function termsOf(doc: Doc, field: (typeof FIELDS)[number]): string[] {
	return textsOf(doc, field).flatMap(function (text) {
		return text.split(' ').filter(Boolean);
	});
}

interface Expected {
	id: number;
	score: number;
	terms: string[];
}

/** BM25 straight from the definition, recomputing every statistic from the documents (in insertion order). */
function naiveBm25(docs: Doc[], query: { text: string; prefix: boolean | 'last'; combine: 'or' | 'and' }, boosts: number[], k1: number, b: number): Expected[] {
	const tokens = query.text.split(' ').filter(Boolean);
	const queryTerms: Array<{ term: string; prefix: boolean }> = [];
	tokens.forEach(function (term, i) {
		const prefix = query.prefix === true || (query.prefix === 'last' && i === tokens.length - 1);
		const existing = queryTerms.find(function (q) {
			return q.term === term;
		});
		if (existing === undefined) queryTerms.push({ term, prefix });
		else existing.prefix ||= prefix;
	});
	const stats = FIELDS.map(function (field) {
		const withField = docs.filter(function (doc) {
			return termsOf(doc, field).length > 0;
		});
		const total = withField.reduce(function (sum, doc) {
			return sum + termsOf(doc, field).length;
		}, 0);
		return { count: withField.length, average: total / withField.length };
	});
	function fieldScore(doc: Doc, term: string): number {
		let score = 0;
		FIELDS.forEach(function (field, f) {
			const terms = termsOf(doc, field);
			const tf = terms.filter(function (t) {
				return t === term;
			}).length;
			if (tf === 0) return;
			const n = docs.filter(function (other) {
				return termsOf(other, field).includes(term);
			}).length;
			const idf = Math.log(1 + (stats[f].count - n + 0.5) / (n + 0.5));
			score += (boosts[f] * idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * terms.length) / stats[f].average));
		});
		return score;
	}
	const results: Array<Expected & { order: number }> = [];
	docs.forEach(function (doc, order) {
		const own = [...new Set([...termsOf(doc, 'title'), ...termsOf(doc, 'body')])];
		let score = 0;
		let hits = 0;
		const matched = new Set<string>();
		for (const { term, prefix } of queryTerms) {
			const candidates = own
				.filter(function (t) {
					return prefix ? t.startsWith(term) : t === term;
				})
				.sort();
			if (candidates.length === 0) continue;
			hits++;
			for (const candidate of candidates) matched.add(candidate);
			score += Math.max(
				...candidates.map(function (candidate) {
					return fieldScore(doc, candidate);
				})
			);
		}
		if (hits > 0 && (query.combine === 'or' || hits === queryTerms.length)) {
			results.push({
				id: doc.id,
				score,
				order,
				terms: [...matched]
			});
		}
	});
	return results
		.sort(function (x, y) {
			return y.score - x.score || x.order - y.order;
		})
		.map(function ({ id, score, terms }) {
			return { id, score, terms };
		});
}

/** Applies the operations to an index and to a list of the documents in insertion order. */
function apply(index: helpers.SearchIndex<Doc>, operations: Array<{ type: 'add' | 'replace'; doc: Doc } | { type: 'remove'; id: number }>): Doc[] {
	let docs: Doc[] = [];
	for (const op of operations) {
		if (op.type === 'remove') {
			expect(index.remove(op.id)).toBe(
				docs.some(function (doc) {
					return doc.id === op.id;
				})
			);
			docs = docs.filter(function (doc) {
				return doc.id !== op.id;
			});
		} else {
			const exists = docs.some(function (doc) {
				return doc.id === op.doc.id;
			});
			if (op.type === 'add') {
				if (exists) {
					expect(function () {
						index.add(op.doc);
					}).toThrow(RangeError);
					continue;
				}
				index.add(op.doc);
			} else expect(index.replace(op.doc)).toBe(exists);
			docs = docs
				.filter(function (doc) {
					return doc.id !== op.doc.id;
				})
				.concat(op.doc);
		}
		expect(index.size).toBe(docs.length);
	}
	return docs;
}

/** Splits on spaces, so that the oracle needs no tokenizer of its own. */
function splitSpaces(text: string): string[] {
	return text.split(' ');
}

describe('createSearchIndex (property-based)', function () {
	it('ranks and scores like BM25 computed from the documents, after any adds, replaces and removes', function () {
		fc.assert(
			fc.property(
				fc.array(operation, { maxLength: 30 }),
				fc.array(queryArbitrary, { minLength: 1, maxLength: 4 }),
				settings,
				function (operations, queries, { boosts, k1, b }) {
					const index = helpers.createSearchIndex<Doc>({ fields: { title: boosts[0], body: boosts[1] }, tokenize: splitSpaces, k1, b });
					const docs = apply(index, operations);
					for (const query of queries) {
						const results = index.search(query.text, { prefix: query.prefix, combine: query.combine });
						const expected = naiveBm25(docs, query, boosts, k1, b);
						expect(
							results.map(function (r) {
								return r.id;
							})
						).toEqual(
							expected.map(function (e) {
								return e.id;
							})
						);
						results.forEach(function (result, i) {
							expect(Math.abs(result.score - expected[i].score)).toBeLessThanOrEqual(1e-9 * Math.max(1, expected[i].score));
							expect(result.terms).toEqual(expected[i].terms);
							expect(result.item).toBe(
								docs.find(function (doc) {
									return doc.id === result.id;
								})
							);
						});
					}
				}
			)
		);
	});

	it('gives exactly the results of an index built from the remaining documents', function () {
		fc.assert(
			fc.property(fc.array(operation, { maxLength: 40 }), queryArbitrary, function (operations, query) {
				const churned = helpers.createSearchIndex<Doc>({ fields: ['title', 'body'], tokenize: splitSpaces });
				const docs = apply(churned, operations);
				const fresh = helpers.createSearchIndex<Doc>({ fields: ['title', 'body'], tokenize: splitSpaces });
				fresh.addAll(docs);
				expect(churned.search(query.text, query)).toEqual(fresh.search(query.text, query));
			})
		);
	});

	it('returns the first `limit` results of the unlimited search, filtered like the documents', function () {
		fc.assert(
			fc.property(fc.array(docArbitrary, { maxLength: 30 }), queryArbitrary, fc.nat({ max: 12 }), fc.nat({ max: 7 }), function (list, query, limit, odd) {
				const index = helpers.createSearchIndex<Doc>({ fields: ['title', 'body'], tokenize: splitSpaces });
				for (const doc of list) index.replace(doc);
				const all = index.search(query.text, query);
				expect(index.search(query.text, { ...query, limit })).toEqual(all.slice(0, limit));
				function filter(doc: Doc): boolean {
					return doc.id % 2 === odd % 2;
				}
				expect(index.search(query.text, { ...query, filter, limit })).toEqual(
					all
						.filter(function (r) {
							return filter(r.item);
						})
						.slice(0, limit)
				);
			})
		);
	});

	it('finds with the default tokenizer what tokenize splits', function () {
		fc.assert(
			fc.property(fc.array(tokenText, { minLength: 1, maxLength: 6 }), tokenText, function (texts, query) {
				const index = helpers.createSearchIndex<{ id: number; text: string }>({ fields: ['text'] });
				texts.forEach(function (text, id) {
					index.add({ id, text });
				});
				const terms = new Set(helpers.tokenize(query));
				const expected = texts
					.map(function (text, id) {
						return { id, text };
					})
					.filter(function ({ text }) {
						return helpers.tokenize(text).some(function (token) {
							return terms.has(token);
						});
					})
					.map(function ({ id }) {
						return id;
					})
					.sort(function (x, y) {
						return x - y;
					});
				expect(
					index
						.search(query)
						.map(function (r) {
							return r.id as number;
						})
						.sort(function (x, y) {
							return x - y;
						})
				).toEqual(expected);
			})
		);
	});
});
