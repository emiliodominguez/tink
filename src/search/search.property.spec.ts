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
