import type { FuzzySearchKeyedOptions } from '.';
import * as helpers from '.';

describe('Search helpers', function () {
	describe('fuzzyMatch', function () {
		it('treats combining marks as part of the word, so the next letter is not a word start', function () {
			// NFD 'résumé': the 's' follows a combining acute accent, like the 's' after 'é' in NFC.
			const decomposed = helpers.fuzzyMatch('s', 're\u0301sume\u0301')?.score as number;
			const composed = helpers.fuzzyMatch('s', 'résumé')?.score as number;
			// One less: the leading-gap penalty counts the extra code point of the decomposed 'é'.
			expect(decomposed).toBe(composed - 1);
			// Devanagari vowel signs are always marks: 'न' is inside the word 'हिन्दी'.
			expect(helpers.fuzzyMatch('न', 'हिन्दी')?.score).toBe(helpers.fuzzyMatch('न', 'हकन')?.score);
		});

		it('scans the target at most once per needle character when rejecting an ASCII query', function () {
			const indexOf = jest.spyOn(String.prototype, 'indexOf');
			try {
				expect(helpers.fuzzyMatch('a'.repeat(100) + 'b', 'a'.repeat(1000))).toBeUndefined();
				// The upper-case form of `a` is absent: it is looked for once, not once per query character.
				expect(
					indexOf.mock.calls.filter(function ([needle]) {
						return needle === 'A';
					})
				).toHaveLength(1);
			} finally {
				indexOf.mockRestore();
			}
		});

		it('throws a RangeError instead of allocating a back-pointer matrix of more than 2 ** 28 cells', function () {
			const long = 'a'.repeat(20_000);
			expect(function () {
				helpers.fuzzyMatch(long, long);
			}).toThrow(new RangeError('fuzzyMatch: the query and text are too long to align (20000 × 20000 code points, more than 268435456 cells)'));
		});

		it('should match subsequences and return merged, ascending UTF-16 ranges', function () {
			expect(helpers.fuzzyMatch('fb', 'fooBar')).toEqual({
				score: 45,
				ranges: [
					[0, 1],
					[3, 4]
				]
			});
			expect(helpers.fuzzyMatch('bar', 'fooBar')).toEqual({ score: 65, ranges: [[3, 6]] });
			expect(helpers.fuzzyMatch('abc', 'abc')).toEqual({ score: 16 * 3 + 8 + 5 * 2 + 3, ranges: [[0, 3]] });
		});

		it('should return undefined when the query is not a subsequence', function () {
			expect(helpers.fuzzyMatch('rab', 'fooBar')).toBeUndefined();
			expect(helpers.fuzzyMatch('a', '')).toBeUndefined();
			expect(helpers.fuzzyMatch('aa', 'a')).toBeUndefined();
			expect(helpers.fuzzyMatch('ab', 'xyz')).toBeUndefined();
		});

		it('should match everything with score 0 for an empty query', function () {
			expect(helpers.fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] });
			expect(helpers.fuzzyMatch('', '')).toEqual({ score: 0, ranges: [] });
		});

		it('should be case-insensitive by default and reward exact case', function () {
			expect(helpers.fuzzyMatch('ABC', 'abc')).toEqual({ score: 16 * 3 + 8 + 5 * 2, ranges: [[0, 3]] });
			expect(helpers.fuzzyMatch('abc', 'abc')!.score - helpers.fuzzyMatch('ABC', 'abc')!.score).toBe(3);
		});

		it('should honour caseSensitive', function () {
			expect(helpers.fuzzyMatch('ab', 'Ab', { caseSensitive: true })).toBeUndefined();
			expect(helpers.fuzzyMatch('Ab', 'xAb', { caseSensitive: true })).toEqual({ score: 16 * 2 + 8 + 5 + 2 - 1, ranges: [[1, 3]] });
			expect(helpers.fuzzyMatch('ab', 'Ab', { caseSensitive: false })).toBeDefined();
		});

		it('should reward word starts after separators and camelCase humps', function () {
			for (const target of ['x a', 'x-a', 'x_a', 'x.a', 'x/a', 'x\\a', 'x:a', 'x@a', 'x[a', 'x`a', 'x{a', 'x~a', 'xA']) {
				// 16 match + 8 boundary + 1 exact case - 2 leading, or 16 match + 8 boundary - 1 leading for the camelCase hump
				expect(helpers.fuzzyMatch('a', target)!.score).toBe(23);
			}
			expect(helpers.fuzzyMatch('a', 'xa')!.score).toBe(16);
			for (const target of ['za', 'Za', '0a', '9a']) expect(helpers.fuzzyMatch('a', target)!.score).toBe(16); // after a letter or digit: no word start
			expect(helpers.fuzzyMatch('a', 'XA')!.score).toBe(15); // no lower → upper hump, no exact case
			expect(helpers.fuzzyMatch('b', 'a2b')!.score).toBe(16 + 1 - 2); // digits are word characters
			expect(helpers.fuzzyMatch('é', 'xé')!.score).toBe(17 - 1);
			expect(helpers.fuzzyMatch('é', 'x-é')!.score).toBe(25 - 2);
			expect(helpers.fuzzyMatch('é', 'aÉ')!.score).toBe(24 - 1); // camelCase hump with a non-ASCII capital
			expect(helpers.fuzzyMatch('a', '中A')!.score).toBe(16 - 1); // a caseless letter does not start a hump
		});

		it('should penalize gaps affinely and leading offsets with a cap', function () {
			const one = helpers.fuzzyMatch('ab', 'axb')!.score;
			const two = helpers.fuzzyMatch('ab', 'axxb')!.score;
			const three = helpers.fuzzyMatch('ab', 'axxxb')!.score;
			expect(one).toBe(25 + 17 - 3);
			expect(one - two).toBe(1);
			expect(two - three).toBe(1);
			expect(helpers.fuzzyMatch('b', 'aab')!.score).toBe(17 - 2);
			expect(helpers.fuzzyMatch('b', 'aaaaaaaaaaaab')!.score).toBe(17 - 8);
			expect(helpers.fuzzyMatch('b', 'aaaaaaaaaaaaaaaaab')!.score).toBe(17 - 8);
		});

		it('should find the best alignment, not the greedy one', function () {
			// Greedy would take the first 'a' and 'b' (scattered); the best alignment is the word "ab" at the end.
			expect(helpers.fuzzyMatch('ab', 'xaxxxb ab')!.ranges).toEqual([[7, 9]]);
			expect(helpers.fuzzyMatch('fbr', 'foo_bar_baz_far')!.ranges).toEqual([
				[0, 1],
				[4, 5],
				[6, 7]
			]);
			expect(helpers.fuzzyMatch('gc', 'git commit')!.ranges).toEqual([
				[0, 1],
				[4, 5]
			]);
		});

		it('should prefer the earliest end, consecutive runs and then the shortest gap among ties', function () {
			expect(helpers.fuzzyMatch('a', 'xaxa')!.ranges).toEqual([[1, 2]]);
			expect(helpers.fuzzyMatch('a', 'xxxxxxxxxaxa')).toEqual({ score: 17 - 8, ranges: [[9, 10]] }); // both 'a' pay the capped leading penalty
			expect(helpers.fuzzyMatch('aa', 'aaa')!.ranges).toEqual([[0, 2]]);
			// 'A' + gap (24 - 3) ties with 'a' + consecutive (16 + 5): the consecutive run wins.
			expect(helpers.fuzzyMatch('ab', 'Aab')).toEqual({ score: 38, ranges: [[1, 3]] });
			// The first 'a' + a 3-character gap ties with the second 'a' + a 1-character gap: the shorter gap wins.
			expect(helpers.fuzzyMatch('ab', 'a-a-b')).toEqual({
				score: 45,
				ranges: [
					[2, 3],
					[4, 5]
				]
			});
		});

		it('should rank prefixes above scattered matches', function () {
			expect(helpers.fuzzyMatch('gc', 'git commit')!.score).toBeGreaterThan(helpers.fuzzyMatch('gc', 'magic')!.score);
			expect(helpers.fuzzyMatch('abc', 'abcdef')!.score).toBeGreaterThanOrEqual(helpers.fuzzyMatch('abc', 'a_b_c')!.score);
		});

		it('should match per code point and never split surrogate pairs', function () {
			expect(helpers.fuzzyMatch('😀b', 'a😀b')).toEqual({ score: 16 + 8 + 1 - 1 + 16 + 5 + 1, ranges: [[1, 4]] });
			expect(helpers.fuzzyMatch('b', '😀😀b')).toEqual({ score: 17 + 8 - 2, ranges: [[4, 5]] }); // 2 code points skipped, word start after a symbol
			expect(helpers.fuzzyMatch('ÉT', 'été')).toEqual({ score: 16 + 8 + 16 + 5, ranges: [[0, 2]] });
			expect(helpers.fuzzyMatch('é', 'é')).toBeUndefined(); // no normalization
			expect(helpers.fuzzyMatch('é', 'é')).toBeDefined();
		});

		it('should treat U+FFFF (the last single-unit code point) as one character', function () {
			expect(helpers.fuzzyMatch('\uFFFFa', '\uFFFFab')!.ranges).toEqual([[0, 2]]);
			expect(helpers.fuzzyMatch('ab', '\uFFFFab')!.ranges).toEqual([[1, 3]]);
		});

		it('should fold case per code point with toLowerCase, and only letters', function () {
			expect(helpers.fuzzyMatch('z', 'Z')).toEqual({ score: 24, ranges: [[0, 1]] });
			expect(helpers.fuzzyMatch('Z', 'z')).toBeDefined();
			expect(helpers.fuzzyMatch('aa', 'Aa')!.ranges).toEqual([[0, 2]]); // the earliest of either case
			expect(helpers.fuzzyMatch('aa', 'aA')!.ranges).toEqual([[0, 2]]);
			expect(helpers.fuzzyMatch('[', ';[')!.ranges).toEqual([[1, 2]]); // ';' is not the lower case of '['
			expect(helpers.fuzzyMatch('[', ';')).toBeUndefined();
			expect(helpers.fuzzyMatch('{', '[')).toBeUndefined();
			expect(helpers.fuzzyMatch('@', ' ')).toBeUndefined();
			expect(helpers.fuzzyMatch('σ', 'ΑΣ')!.ranges).toEqual([[1, 2]]);
			expect(helpers.fuzzyMatch('σ', 'ς')).toBeUndefined(); // no final-sigma folding
			// The Kelvin sign's lower case is 'k'.
			expect(helpers.fuzzyMatch('k', '\u212A')).toEqual({ score: 24, ranges: [[0, 1]] });
			expect(helpers.fuzzyMatch('ok', 'O\u212A')!.ranges).toEqual([[0, 2]]);
			expect(helpers.fuzzyMatch('k', '\u212A', { caseSensitive: true })).toBeUndefined();
			// 'İ' lower-cases to two code points ('i' + a combining dot): it only matches itself.
			expect(helpers.fuzzyMatch('İ', 'i')).toBeUndefined();
			expect(helpers.fuzzyMatch('éi', 'éİ')).toBeUndefined();
			expect(helpers.fuzzyMatch('İ', 'xİ')).toEqual({ score: 25 - 1, ranges: [[1, 2]] }); // exact case, camelCase hump
		});

		it('should handle long targets and queries', function () {
			const target = `${'x'.repeat(5000)}needle${'y'.repeat(5000)}`;
			expect(helpers.fuzzyMatch('needle', target)!.ranges).toEqual([[5000, 5006]]);
			for (const length of [255, 256, 300]) expect(helpers.fuzzyMatch('z', `${'x'.repeat(length)}z`)!.ranges).toEqual([[length, length + 1]]);
			expect(helpers.fuzzyMatch('a'.repeat(40), `b${'a'.repeat(249)}`)).toEqual({ score: 16 * 40 + 39 * 5 + 40 - 1, ranges: [[1, 41]] });
			// Interleaved calls on short and long inputs do not interfere.
			expect(helpers.fuzzyMatch('ab', 'xab')!.ranges).toEqual([[1, 3]]);
		});

		it('should throw a TypeError for non-string arguments', function () {
			expect(function () {
				helpers.fuzzyMatch(1 as any, 'a');
			}).toThrow(new TypeError('fuzzyMatch: `query` must be a string, got number'));
			expect(function () {
				helpers.fuzzyMatch('a', null as any);
			}).toThrow(new TypeError('fuzzyMatch: `target` must be a string, got null'));
		});
	});

	describe('fuzzySearch', function () {
		it('reads caseSensitive like fuzzyMatch: only true is case-sensitive', function () {
			expect(helpers.fuzzySearch(['a'], 'A', { caseSensitive: 'false' as unknown as boolean })).toHaveLength(1);
			expect(helpers.fuzzySearch(['a'], 'A', { caseSensitive: true })).toHaveLength(0);
		});

		it('rejects array items without `key`, like any other non-string item', function () {
			expect(function () {
				helpers.fuzzySearch([['abc', 'xyz']] as never, 'a');
			}).toThrow(TypeError);
		});

		it('keeps literal item types', function () {
			const results = helpers.fuzzySearch(['x', 'y'] as const, 'x');
			const item: 'x' | 'y' = results[0].item;
			expect(item).toBe('x');
		});

		it('names itself when an alignment is too large', function () {
			const long = 'a'.repeat(20_000);
			expect(function () {
				helpers.fuzzySearch([long], long);
			}).toThrow(/^fuzzySearch: the query and text are too long to align/);
		});

		const files = ['src/index.ts', 'README.md', 'src/search/index.ts', 'docs/search.md'];

		it('should filter and sort string items by score', function () {
			const results = helpers.fuzzySearch(files, 'search');
			expect(
				results.map(function (r) {
					return r.item;
				})
			).toEqual(['src/search/index.ts', 'docs/search.md']); // smaller leading offset first
			expect(results[1]).toEqual({ item: 'docs/search.md', key: 'docs/search.md', ...helpers.fuzzyMatch('search', 'docs/search.md') });
		});

		it('should keep the original order for ties and return everything for an empty query', function () {
			expect(
				helpers.fuzzySearch(['b-x', 'a-x', 'c-x'], 'x').map(function (r) {
					return r.item;
				})
			).toEqual(['b-x', 'a-x', 'c-x']);
			expect(helpers.fuzzySearch(files, '')).toEqual(
				files.map(function (file) {
					return { item: file, key: file, score: 0, ranges: [] };
				})
			);
		});

		it('should accept any iterable', function () {
			expect(helpers.fuzzySearch(new Set(['ab', 'cd']), 'a')).toHaveLength(1);
		});

		it('should honour limit and threshold', function () {
			expect(helpers.fuzzySearch(files, 's', { limit: 2 })).toHaveLength(2);
			expect(helpers.fuzzySearch(files, 's', { limit: 0 })).toEqual([]);
			const all = helpers.fuzzySearch(files, 'i');
			const threshold = all[1].score;
			expect(helpers.fuzzySearch(files, 'i', { threshold })).toEqual(
				all.filter(function (r) {
					return r.score >= threshold;
				})
			);
		});

		it('should honour caseSensitive', function () {
			expect(
				helpers.fuzzySearch(['README', 'readme'], 'read', { caseSensitive: true }).map(function (r) {
					return r.item;
				})
			).toEqual(['readme']);
		});

		it('should search objects through key, picking the best of several keys', function () {
			const commands = [
				{ title: 'Open File', aliases: ['load'] },
				{ title: 'Close Window', aliases: ['quit', 'exit', 'leave'] },
				{ title: 'Toggle Sidebar', aliases: [] }
			];
			const results = helpers.fuzzySearch(commands, 'le', {
				key: function (command) {
					return [command.title, ...command.aliases];
				}
			});
			expect(
				results.map(function (r) {
					return [r.item.title, r.key];
				})
			).toEqual([
				['Close Window', 'leave'],
				['Toggle Sidebar', 'Toggle Sidebar'],
				['Open File', 'Open File']
			]);
			expect(results[0].ranges).toEqual([[0, 2]]);
			// An item whose key returns no text never matches.
			expect(
				helpers.fuzzySearch(commands, '', {
					key: function () {
						return [];
					}
				})
			).toEqual([]);
		});

		it('should keep the first of equally-scored keys', function () {
			const [result] = helpers.fuzzySearch([{ a: 'xa', b: 'ya' }], 'a', {
				key: function (item) {
					return [item.a, item.b];
				}
			});
			expect(result.key).toBe('xa');
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.fuzzySearch(files, 1 as any);
			}).toThrow(new TypeError('fuzzySearch: `query` must be a string, got number'));
			expect(function () {
				helpers.fuzzySearch(files, 'a', { key: 'title' as any });
			}).toThrow(new TypeError('fuzzySearch: `key` must be a function, got string'));
			expect(function () {
				helpers.fuzzySearch(files, 'a', { limit: -1 });
			}).toThrow(new RangeError('fuzzySearch: `limit` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				helpers.fuzzySearch(files, 'a', { limit: 1.5 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.fuzzySearch(files, 'a', { threshold: NaN });
			}).toThrow(new RangeError('fuzzySearch: `threshold` must be a number, got NaN'));
			expect(function () {
				helpers.fuzzySearch([1] as any, 'a');
			}).toThrow(new TypeError('fuzzySearch: `item` must be a string, got number'));
			expect(function () {
				helpers.fuzzySearch([{}], 'a', {
					key: function () {
						return [undefined] as any;
					}
				});
			}).toThrow(new TypeError('fuzzySearch: `key(item)` must be a string, got undefined'));
		});
	});

	describe('highlight', function () {
		it('should split text into matched and unmatched segments', function () {
			expect(
				helpers.highlight('fooBar', [
					[0, 1],
					[3, 4]
				])
			).toEqual([
				{ text: 'f', match: true },
				{ text: 'oo', match: false },
				{ text: 'B', match: true },
				{ text: 'ar', match: false }
			]);
			expect(helpers.highlight('abc', [[0, 3]])).toEqual([{ text: 'abc', match: true }]);
			expect(helpers.highlight('abc', [])).toEqual([{ text: 'abc', match: false }]);
			expect(helpers.highlight('', [])).toEqual([]);
			expect(helpers.highlight('', [[0, 0]])).toEqual([]);
		});

		it('should sort and merge overlapping, adjacent and nested ranges and ignore empty ones', function () {
			expect(
				helpers.highlight('abcdef', [
					[4, 5],
					[0, 2],
					[1, 3],
					[3, 4],
					[1, 2],
					[5, 5]
				])
			).toEqual([
				{ text: 'abcde', match: true },
				{ text: 'f', match: false }
			]);
		});

		it('should accept any iterable of ranges', function () {
			expect(helpers.highlight('ab', new Set([[1, 2] as const]))).toEqual([
				{ text: 'a', match: false },
				{ text: 'b', match: true }
			]);
		});

		it('should throw for invalid ranges', function () {
			expect(function () {
				helpers.highlight('abc', [[2, 5]]);
			}).toThrow(new RangeError('highlight: `end` must be an integer between 2 and 3, got 5'));
			expect(function () {
				helpers.highlight('abc', [[-1, 1]]);
			}).toThrow(new RangeError('highlight: `start` must be an integer between 0 and 3, got -1'));
			expect(function () {
				helpers.highlight('abc', [[4, 4]]);
			}).toThrow(new RangeError('highlight: `start` must be an integer between 0 and 3, got 4'));
			expect(function () {
				helpers.highlight('abc', [[2, 1]]);
			}).toThrow(RangeError);
			expect(function () {
				helpers.highlight('abc', [[0.5, 1]]);
			}).toThrow(RangeError);
			expect(function () {
				helpers.highlight('abc', [['0', 1] as any]);
			}).toThrow(new TypeError('highlight: `start` must be an integer between 0 and 3, got string'));
			expect(function () {
				helpers.highlight(5 as any, []);
			}).toThrow(new TypeError('highlight: `text` must be a string, got number'));
		});

		it('should round-trip fuzzyMatch ranges', function () {
			const { ranges } = helpers.fuzzyMatch('sidx', 'src/search/index.ts')!;
			const segments = helpers.highlight('src/search/index.ts', ranges);
			expect(
				segments
					.filter(function (s) {
						return s.match;
					})
					.map(function (s) {
						return s.text;
					})
					.join('')
			).toBe('sidx');
		});
	});

	describe('security', function () {
		const target = 'x'.repeat(20_000);

		it('rejects a query longer than the target without allocating (even when non-ASCII disables the indexOf pre-filter)', function () {
			expect(helpers.fuzzyMatch(`é${'y'.repeat(1_000_000)}`, target)).toBeUndefined();
			expect(helpers.fuzzyMatch('ab', 'a')).toBeUndefined();
			expect(helpers.fuzzyMatch('😀😀', '😀')).toBeUndefined();
			expect(helpers.fuzzyMatch('😀', '😀')).toEqual({ score: 25, ranges: [[0, 2]] });
			expect(helpers.fuzzySearch(['x'.repeat(5_000), 'abc'], `é${'y'.repeat(40_000)}`)).toEqual([]);
		});

		it('runs the subsequence check before allocating the O(query × target) matrix', function () {
			const before = process.memoryUsage().arrayBuffers;
			// 5001 × 20000 cells would be a 400 MB matrix.
			expect(helpers.fuzzyMatch(`é${'y'.repeat(5_000)}`, target)).toBeUndefined();
			expect(helpers.fuzzyMatch(`x${'é'.repeat(5_000)}`, target)).toBeUndefined();
			expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(10_000_000);
		});

		it('sizes the matrix by target code points and still aligns long non-ASCII matches', function () {
			const long = `${'é'.repeat(300)}😀`;
			expect(helpers.fuzzyMatch('é😀', long)?.ranges).toEqual([[299, 302]]);
			expect(helpers.fuzzyMatch('éé', 'é'.repeat(40))?.ranges).toEqual([[0, 2]]);
		});
	});
});

describe('fuzzySearch options types', function () {
	it('accepts keyed options built ahead of the call', function () {
		const options: FuzzySearchKeyedOptions<{ n: string }> = {
			key: function (item) {
				return item.n;
			}
		};
		expect(
			helpers.fuzzySearch([{ n: 'abc' }], 'a', options).map(function (result) {
				return result.key;
			})
		).toEqual(['abc']);
	});
});

describe('fuzzyMatch / fuzzySearch with ignoreDiacritics', function () {
	const options = { ignoreDiacritics: true };

	it('is off by default, and only true turns it on', function () {
		expect(helpers.fuzzyMatch('cafe', 'Café')).toBeUndefined();
		expect(helpers.fuzzyMatch('cafe', 'Café', { ignoreDiacritics: 1 as never })).toBeUndefined();
		expect(helpers.fuzzyMatch('cafe', 'Café', options)).toEqual({ score: 90, ranges: [[0, 4]] });
		expect(helpers.fuzzyMatch('café', 'Cafe', options)).toEqual({ score: 90, ranges: [[0, 4]] });
	});

	it('matches precomposed and decomposed accents alike, highlighting a combining accent with its letter', function () {
		expect(helpers.fuzzyMatch('cafe', 'Cafe\u0301 noir', options)).toEqual({ score: 90, ranges: [[0, 5]] });
		expect(helpers.fuzzyMatch('e', 'e\u0301\u0323x', options)?.ranges).toEqual([[0, 3]]);
		expect(helpers.fuzzyMatch('aa', 'a\u0301a\u0301', options)?.ranges).toEqual([[0, 4]]);
		expect(helpers.fuzzyMatch('ab', 'a\u0301xb', options)?.ranges).toEqual([
			[0, 2],
			[3, 4]
		]);
		expect(helpers.fuzzyMatch('Créme', 'creme', options)?.score).toBe(helpers.fuzzyMatch('Creme', 'creme', options)?.score);
		// A combining accent at the very start has no letter to join: it is never highlighted.
		expect(helpers.fuzzyMatch('e', '\u0301e\u0301x', options)?.ranges).toEqual([[1, 3]]);
		// A query made only of combining accents is empty.
		expect(helpers.fuzzyMatch('\u0301\u0300', 'abc', options)).toEqual({ score: 0, ranges: [] });
	});

	it('keeps a code point that would fold to more than 3 characters as it is (regression)', function () {
		// `'ﷺ'` decomposes to an 18-character phrase: the alignment used to be sized on it (331 ms and +796 MB for this call).
		const started = Date.now();
		const result = helpers.fuzzyMatch('ﷺ'.repeat(900), 'ﷺ'.repeat(920), options);
		expect(Date.now() - started).toBeLessThan('__stryker__' in globalThis ? Infinity : 250);
		expect(result).toEqual(helpers.fuzzyMatch('ﷺ'.repeat(900), 'ﷺ'.repeat(920)));
		expect(helpers.fuzzyMatch('ﷺ', 'xﷺ', options)?.ranges).toEqual([[1, 2]]);
		expect(helpers.fuzzyMatch('صلى', 'ﷺ', options)).toBeUndefined();
		expect(helpers.fuzzyMatch('am', '㏂', options)).toBeUndefined();
		expect(helpers.fuzzyMatch('㏂', 'x㏂', options)?.ranges).toEqual([[1, 2]]);
		// Foldings of up to 3 characters still apply.
		expect(helpers.fuzzyMatch('ffi', 'ﬃ', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('ﬃ', 'office', options)?.ranges).toEqual([[1, 4]]);
		expect(helpers.fuzzyMatch('mhz', '㎒', options)?.ranges).toEqual([[0, 1]]);
	});

	it('spells letters without a decomposition in ASCII, and highlights them whole', function () {
		expect(helpers.fuzzyMatch('strasse', 'Straße', options)?.ranges).toEqual([[0, 6]]);
		expect(helpers.fuzzyMatch('ss', 'ß', options)).toEqual({ score: 47, ranges: [[0, 1]] });
		expect(helpers.fuzzyMatch('s', 'ß', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('ß', 'ss', options)?.ranges).toEqual([[0, 2]]);
		expect(helpers.fuzzyMatch('ß', 'strasse', options)?.ranges).toEqual([
			[0, 1],
			[4, 5]
		]);
		expect(helpers.fuzzyMatch('lodz', 'Łódź', options)?.ranges).toEqual([[0, 4]]);
		expect(helpers.fuzzyMatch('aero', 'Ærø', options)?.ranges).toEqual([[0, 3]]);
		expect(helpers.fuzzyMatch('thor', 'Þór', options)?.ranges).toEqual([[0, 3]]);
		expect(helpers.fuzzyMatch('i', 'ı', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('oeuvre', 'œuvre', options)?.ranges).toEqual([[0, 5]]);
		expect(helpers.fuzzyMatch('ddlth', 'đðłþ', options)?.ranges).toEqual([[0, 4]]);
		expect(helpers.fuzzyMatch('DDLTHO', 'ĐÐŁÞØ', { ignoreDiacritics: true, caseSensitive: true })?.ranges).toEqual([[0, 5]]);
		expect(helpers.fuzzyMatch('DD', 'Đð', { ignoreDiacritics: true, caseSensitive: true })).toBeUndefined();
		expect(helpers.fuzzyMatch('SS', 'ẞ', { ignoreDiacritics: true, caseSensitive: true })?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('OEO', 'Œø', { ignoreDiacritics: true, caseSensitive: true })).toBeUndefined();
		expect(helpers.fuzzyMatch('OEo', 'Œø', { ignoreDiacritics: true, caseSensitive: true })?.ranges).toEqual([[0, 2]]);
	});

	it('folds compatibility characters: ligatures, full-width forms, Hangul syllables', function () {
		expect(helpers.fuzzyMatch('file', '\ufb01le', options)?.ranges).toEqual([[0, 3]]);
		expect(helpers.fuzzyMatch('fi', '\ufb01', options)).toEqual({ score: 47, ranges: [[0, 1]] });
		expect(helpers.fuzzyMatch('ab', '\uff21\uff42', options)?.ranges).toEqual([[0, 2]]);
		expect(helpers.fuzzyMatch('\ud558', '\ud55c\uad6d', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('i', '\u0130stanbul', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('12', '\u00bd', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('a😀', 'á😀', options)?.ranges).toEqual([[0, 3]]);
	});

	it('finds camelCase humps after accented lower-case letters', function () {
		expect(helpers.fuzzyMatch('b', 'aéB')!.score).toBe(helpers.fuzzyMatch('b', 'aeB')!.score);
		expect(helpers.fuzzyMatch('b', 'aéB', options)!.score).toBe(helpers.fuzzyMatch('b', 'aeB', options)!.score);
	});

	it('keeps case sensitivity, and gives the exact-case bonus with the accents removed', function () {
		expect(helpers.fuzzyMatch('CAFE', 'café', { ignoreDiacritics: true, caseSensitive: true })).toBeUndefined();
		expect(helpers.fuzzyMatch('Cafe', 'Café', { ignoreDiacritics: true, caseSensitive: true })?.ranges).toEqual([[0, 4]]);
		expect(helpers.fuzzyMatch('E', 'É', options)!.score).toBe(helpers.fuzzyMatch('E', 'E', options)!.score);
		expect(helpers.fuzzyMatch('e', 'É', options)!.score).toBe(helpers.fuzzyMatch('e', 'E', options)!.score);
	});

	it('scores a target the same in NFC and NFD', function () {
		const text = 'Crème Brûlée à Málaga';
		for (const query of ['creme', 'brulee', 'cbm', 'Créme', 'aga', 'MA']) {
			const composed = helpers.fuzzyMatch(query, text, options);
			const decomposed = helpers.fuzzyMatch(query, text.normalize('NFD'), options);
			expect(decomposed?.score).toBe(composed?.score);
		}
	});

	it('does not reject a query longer than the target, nor an ASCII query against accented text', function () {
		expect(helpers.fuzzyMatch('ffi', '\ufb03', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('ffix', '\ufb03', options)).toBeUndefined();
		expect(helpers.fuzzyMatch('xyz', 'abc', options)).toBeUndefined();
		expect(helpers.fuzzyMatch('abc', 'xaxbxc', options)?.ranges).toEqual([
			[1, 2],
			[3, 4],
			[5, 6]
		]);
		expect(helpers.fuzzyMatch('ae', 'æ', options)?.ranges).toEqual([[0, 1]]);
		expect(helpers.fuzzyMatch('ae', 'a', options)).toBeUndefined();
		// Surrogate pairs and U+FFFF are read as single code points.
		expect(helpers.fuzzyMatch('\ude00', '😀', options)).toBeUndefined();
		expect(helpers.fuzzyMatch('a', '\uffffa', options)?.ranges).toEqual([[1, 2]]);
	});

	it('aligns long folded targets, and keeps the matrix cap', function () {
		const long = 'ß'.repeat(200) + 'x';
		expect(helpers.fuzzyMatch('sx', long, options)?.ranges).toEqual([[199, 201]]);
		expect(helpers.fuzzyMatch('ssx', long, options)?.ranges).toEqual([[199, 201]]);
		expect(function () {
			helpers.fuzzyMatch('s'.repeat(1_000), 'ß'.repeat(140_000), options);
		}).toThrow(RangeError);
	});

	it('folds many distinct characters (its cache is bounded)', function () {
		let text = '';
		for (let code = 0x4e00; code < 0x4e00 + 5_000; code++) text += String.fromCharCode(code);
		expect(helpers.fuzzyMatch('\u4e00\u6187', text + 'é', options)?.ranges).toEqual([
			[0, 1],
			[4999, 5000]
		]);
		expect(helpers.fuzzyMatch('\u4e01', text, options)?.ranges).toEqual([[1, 2]]);
	});

	it('is passed through by fuzzySearch', function () {
		expect(
			helpers.fuzzySearch(['Málaga', 'Zürich', 'Łódź'], 'lodz', options).map(function (result) {
				return result.item;
			})
		).toEqual(['Łódź']);
		expect(helpers.fuzzySearch(['Zürich'], 'zur')).toEqual([]);
		const results = helpers.fuzzySearch([{ name: 'Crème brûlée' }], 'creme', {
			ignoreDiacritics: true,
			key: function (item) {
				return item.name;
			}
		});
		expect(results).toEqual([{ item: { name: 'Crème brûlée' }, key: 'Crème brûlée', score: 112, ranges: [[0, 5]] }]);
	});

	it('ignores an ignoreDiacritics inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.ignoreDiacritics = true;
		try {
			expect(helpers.fuzzyMatch('cafe', 'Café')).toBeUndefined();
			expect(helpers.fuzzySearch(['Café'], 'cafe')).toEqual([]);
		} finally {
			delete proto.ignoreDiacritics;
		}
	});

	it('ignores every option inherited from a polluted Object.prototype (regression)', function () {
		// `caseSensitive`, `key`, `limit` and `threshold` used to be read with plain property accesses: a polluted `key` was even called.
		const proto = Object.prototype as Record<string, unknown>;
		const key = jest.fn(function () {
			return 'polluted';
		});
		Object.assign(proto, { caseSensitive: true, key, limit: 0, threshold: 1000 });
		try {
			expect(helpers.fuzzyMatch('ab', 'AB')).toEqual({ score: 45, ranges: [[0, 2]] });
			expect(helpers.fuzzySearch(['AB'], 'ab')).toEqual([{ item: 'AB', key: 'AB', score: 45, ranges: [[0, 2]] }]);
			expect(helpers.fuzzySearch(['AB'], 'pol')).toEqual([]);
			expect(key).not.toHaveBeenCalled();
			// Own options still apply.
			expect(helpers.fuzzyMatch('ab', 'AB', { caseSensitive: true })).toBeUndefined();
			expect(helpers.fuzzySearch(['AB', 'ab'], 'ab', { caseSensitive: true, limit: 1, threshold: 0 })).toEqual([{ item: 'ab', key: 'ab', score: 47, ranges: [[0, 2]] }]);
		} finally {
			for (const name of ['caseSensitive', 'key', 'limit', 'threshold']) delete proto[name];
		}
	});
});

describe('tokenize', function () {
	it('splits on everything but letters, digits and attached marks, lower-casing', function () {
		expect(helpers.tokenize('Hello, World! 42 times')).toEqual(['hello', 'world', '42', 'times']);
		expect(helpers.tokenize("don't e-mail snake_case a.b/c")).toEqual(['don', 't', 'e', 'mail', 'snake', 'case', 'a', 'b', 'c']);
		expect(helpers.tokenize('')).toEqual([]);
		expect(helpers.tokenize(' ,;!? 😀 ')).toEqual([]);
		expect(helpers.tokenize('x²+y½ — ٣٤ हिन्दी 𝒳𝒴')).toEqual(['x²', 'y½', '٣٤', 'हिन्दी', '𝒳𝒴']);
		// A mark only continues a word: alone, it is a separator.
		expect(helpers.tokenize('́abc ́')).toEqual(['abc']);
	});

	it('normalizes to NFC, so precomposed and decomposed accents give the same token', function () {
		expect(helpers.tokenize('Café café')).toEqual(['café', 'café']);
	});

	it('recomposes after lower-casing, so tokens are in NFC whatever the case of the text', function () {
		// 'J' + caron and 'Ϊ' + acute have no precomposed capital, but their lower cases compose to 'ǰ' and 'ΐ'.
		expect(helpers.tokenize('J\u030c \u01f0 \u03aa\u0301 \u0390')).toEqual(['\u01f0', '\u01f0', '\u0390', '\u0390']);
		expect(helpers.tokenize('J\u030c', { segmenter: new Intl.Segmenter('en', { granularity: 'word' }) })).toEqual(['\u01f0']);
		expect(helpers.tokenize('J\u030c', { caseSensitive: true })).toEqual(['J\u030c']);
	});

	it('ignores format characters inside words, but splits on a zero-width space', function () {
		expect(helpers.tokenize('co­operate zero​width joi‍ner bi‎di ﻿bom')).toEqual(['cooperate', 'zero', 'width', 'joiner', 'bidi', 'bom']);
	});

	it('lower-cases with toLowerCase, whole-text (final sigma) and locale-independent', function () {
		expect(helpers.tokenize('ΟΔΟΣ İstanbul I')).toEqual(['οδος', 'i̇stanbul', 'i']);
		expect(helpers.tokenize('Hello WORLD', { caseSensitive: true })).toEqual(['Hello', 'WORLD']);
		expect(helpers.tokenize('Hello', { caseSensitive: false })).toEqual(['hello']);
	});

	it('folds diacritics and compatibility characters with ignoreDiacritics', function () {
		const options = { ignoreDiacritics: true };
		expect(helpers.tokenize('Crème Brûlée Straße ﬁle Ｃａｆé İ Łódź Æon', options)).toEqual(['creme', 'brulee', 'strasse', 'file', 'cafe', 'i', 'lodz', 'aeon']);
		expect(helpers.tokenize('plain ASCII', options)).toEqual(['plain', 'ascii']);
		expect(helpers.tokenize('ÉCOLE', { ignoreDiacritics: true, caseSensitive: true })).toEqual(['ECOLE']);
		// A folding longer than 3 characters is kept, unlike fuzzyMatch's.
		expect(helpers.tokenize('ﷺ', options)).toHaveLength(4);
		expect(helpers.tokenize('Crème', { ignoreDiacritics: false })).toEqual(['crème']);
	});

	it('drops tokens shorter than minLength code points', function () {
		expect(helpers.tokenize('a bb ccc', { minLength: 2 })).toEqual(['bb', 'ccc']);
		// '𝒳𝒴' is 4 UTF-16 code units but 2 code points.
		expect(helpers.tokenize('𝒳𝒴 abc', { minLength: 3 })).toEqual(['abc']);
		expect(helpers.tokenize('𝒳𝒴 abc', { minLength: 2 })).toEqual(['𝒳𝒴', 'abc']);
		expect(helpers.tokenize('a', { minLength: 1 })).toEqual(['a']);
	});

	it('drops stop words, compared with the final tokens', function () {
		const stopWords = new Set(['the', 'a', 'ecole']);
		expect(helpers.tokenize('The cat and A hat', { stopWords })).toEqual(['cat', 'and', 'hat']);
		expect(helpers.tokenize('The École', { stopWords, ignoreDiacritics: true })).toEqual([]);
		expect(helpers.tokenize('the cat at', { stopWords, minLength: 3 })).toEqual(['cat']);
	});

	it('splits at the boundaries of a segmenter', function () {
		const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
		expect(helpers.tokenize('東京都に住む')).toEqual(['東京都に住む']);
		expect(helpers.tokenize('東京都に住む', { segmenter })).toEqual(['東京', '都', 'に', '住む']);
		expect(helpers.tokenize('ASCII text', { segmenter })).toEqual(['ascii', 'text']);
		const halves = {
			segment: function (text: string) {
				return [{ segment: text.slice(0, 2) }, { segment: text.slice(2) }];
			}
		};
		expect(helpers.tokenize('abcd', { segmenter: halves })).toEqual(['ab', 'cd']);
		// The segmenter sees the NFC text, and its segments are folded afterwards.
		expect(helpers.tokenize('École', { segmenter: halves, ignoreDiacritics: true })).toEqual(['ec', 'ole']);
	});

	it('validates its arguments', function () {
		expect(function () {
			helpers.tokenize(1 as unknown as string);
		}).toThrow(new TypeError('tokenize: `text` must be a string, got number'));
		expect(function () {
			helpers.tokenize('a', { minLength: 0 });
		}).toThrow(new RangeError('tokenize: `options.minLength` must be an integer >= 1, got 0'));
		expect(function () {
			helpers.tokenize('a', { minLength: 1.5 });
		}).toThrow(RangeError);
		expect(function () {
			helpers.tokenize('a', { stopWords: ['a'] as unknown as Set<string> });
		}).toThrow(new TypeError('tokenize: `options.stopWords` must be a Set, got object'));
		expect(function () {
			helpers.tokenize('a', { stopWords: null as unknown as Set<string> });
		}).toThrow(new TypeError('tokenize: `options.stopWords` must be a Set, got null'));
		expect(function () {
			helpers.tokenize('a', { segmenter: {} as unknown as Intl.Segmenter });
		}).toThrow(new TypeError('tokenize: `options.segmenter` must be an Intl.Segmenter, got object'));
		expect(function () {
			helpers.tokenize('a', { segmenter: null as unknown as Intl.Segmenter });
		}).toThrow(new TypeError('tokenize: `options.segmenter` must be an Intl.Segmenter, got null'));
		expect(function () {
			helpers.tokenize('a', {
				segmenter: {
					segment: function () {
						return [{ segment: 1 as unknown as string }];
					}
				}
			});
		}).toThrow(new TypeError('tokenize: `segment` must be a string, got number'));
	});

	it('normalizes runs of more than 30 combining marks 30 marks at a time, in linear time (regression)', function () {
		// Runtimes reorder a run of marks with an insertion sort: tokenizing 100 000 alternating accents used to take about 10 seconds.
		const started = Date.now();
		const text = 'x' + '\u0301\u05b0'.repeat(50_000);
		expect(helpers.tokenize(text)[0].length).toBe(100_001);
		expect(helpers.tokenize(text, { ignoreDiacritics: true })).toEqual(['x' + '\u05b0'.repeat(50_000)]);
		expect(helpers.tokenize(text, { segmenter: new Intl.Segmenter('en', { granularity: 'word' }) }).join('').length).toBe(100_001);
		const index = helpers.createSearchIndex<{ id: number; text: string }>({ fields: ['text'] });
		index.add({ id: 1, text });
		expect(
			index.search(text).map(function (result) {
				return result.id;
			})
		).toEqual([1]);
		expect(Date.now() - started).toBeLessThan('__stryker__' in globalThis ? Infinity : 2000);
		// Up to 30 marks are reordered as the runtime does it, a longer run 30 marks at a time (the Stream-Safe Text Format of UAX #15).
		expect(helpers.tokenize('א' + '\u05b1\u05b0'.repeat(15))).toEqual(['א' + '\u05b0'.repeat(15) + '\u05b1'.repeat(15)]);
		expect(helpers.tokenize('א' + '\u05b1\u05b0'.repeat(20))).toEqual(['א' + '\u05b0'.repeat(15) + '\u05b1'.repeat(15) + '\u05b0'.repeat(5) + '\u05b1'.repeat(5)]);
		expect(helpers.tokenize('ж'.repeat(40) + 'e\u0301')).toEqual(['ж'.repeat(40) + 'é']);
		expect(helpers.tokenize('한국어'.repeat(20) + ' 😀😀😀 ' + 'ภาษาไทย'.repeat(10))).toEqual(['한국어'.repeat(20), 'ภาษาไทย'.repeat(10)]);
	});

	it('ignores options inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.caseSensitive = true;
		proto.minLength = 5;
		try {
			expect(helpers.tokenize('Hi there')).toEqual(['hi', 'there']);
		} finally {
			delete proto.caseSensitive;
			delete proto.minLength;
		}
	});
});

interface Book {
	id: number | string;
	title?: unknown;
	body?: unknown;
}

/** The ids of search results. */
function idsOf<T>(results: Array<helpers.SearchIndexResult<T>>): helpers.SearchId[] {
	return results.map(function (result) {
		return result.id;
	});
}

describe('createSearchIndex', function () {
	const books: Book[] = [
		{ id: 1, title: 'Moby Dick', body: 'The whale hunts the ship. A white whale.' },
		{ id: 2, title: 'The Old Man and the Sea', body: 'An old fisherman, a marlin and sharks.' },
		{ id: 3, title: 'Whale Songs', body: 'How humpback whales sing.' }
	];

	/**
	 * BM25 of one field, written out.
	 */
	function bm25(tf: number, length: number, averageLength: number, n: number, documents: number, k1 = 1.2, b = 0.75): number {
		return (Math.log(1 + (documents - n + 0.5) / (n + 0.5)) * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / averageLength));
	}

	it('scores single terms with Okapi BM25 and Lucene IDF', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['body'] });
		index.addAll(books);
		// Body lengths: 8, 7, 4 terms (average 19 / 3); 'whale' occurs twice in book 1 only.
		const [result] = index.search('whale');
		expect(result.id).toBe(1);
		expect(result.item).toBe(books[0]);
		expect(result.terms).toEqual(['whale']);
		expect(result.score).toBeCloseTo(bm25(2, 8, 19 / 3, 1, 3), 12);
		const [sharks] = index.search('sharks');
		expect(sharks.score).toBeCloseTo(bm25(1, 7, 19 / 3, 1, 3), 12);
		// A term in every document still scores > 0 (Lucene's IDF is never negative).
		expect(
			index.search('a').every(function (r) {
				return r.score > 0;
			})
		).toBe(true);
	});

	it('adds the boosted per-field scores, each field with its own statistics', function () {
		const index = helpers.createSearchIndex<Book>({ fields: { title: 3, body: 1 }, k1: 2, b: 0.5 });
		index.addAll(books);
		const results = index.search('whale');
		expect(idsOf(results)).toEqual([3, 1]);
		// Titles: lengths 2, 6, 2 (average 10 / 3), 'whale' in 1 of 3.
		expect(results[0].score).toBeCloseTo(3 * bm25(1, 2, 10 / 3, 1, 3, 2, 0.5), 12);
		expect(results[1].score).toBeCloseTo(bm25(2, 8, 19 / 3, 1, 3, 2, 0.5), 12);
		// A document scores the sum of its query terms.
		const [both] = index.search('moby whale');
		expect(both.id).toBe(1);
		expect(both.score).toBeCloseTo(3 * bm25(1, 2, 10 / 3, 1, 3, 2, 0.5) + bm25(2, 8, 19 / 3, 1, 3, 2, 0.5), 12);
		expect(both.terms).toEqual(['moby', 'whale']);
	});

	it('counts only the documents that have a field in its statistics', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.add({ id: 1, title: 'alpha beta' });
		index.add({ id: 2, body: 'alpha' });
		index.add({ id: 3, title: null, body: [] });
		index.add({ id: 4, title: ['gamma', 'delta epsilon'] });
		// Titles: 2 documents, average length 2.5; bodies: 1 document of length 1.
		const alpha = index.search('alpha');
		expect(idsOf(alpha)).toEqual([1, 2]);
		expect(alpha[0].score).toBeCloseTo(bm25(1, 2, 2.5, 1, 2), 12);
		expect(alpha[1].score).toBeCloseTo(bm25(1, 1, 1, 1, 1), 12);
		expect(index.search('epsilon')[0].score).toBeCloseTo(bm25(1, 3, 2.5, 1, 2), 12);
		expect(index.search('nothing')).toEqual([]);
		// Removing documents with empty fields leaves the statistics of those fields alone.
		index.remove(3);
		index.remove(2);
		const remaining = index.search('alpha');
		expect(idsOf(remaining)).toEqual([1]);
		expect(remaining[0].score).toBeCloseTo(bm25(1, 2, 2.5, 1, 2), 12);
		// k1 = 0 ignores term frequencies; b = 0 ignores lengths.
		const flat = helpers.createSearchIndex<Book>({ fields: ['body'], k1: 0, b: 0 });
		flat.addAll([
			{ id: 1, body: 'a a a b' },
			{ id: 2, body: 'a c' }
		]);
		expect(flat.search('a')[0].score).toBe(flat.search('a')[1].score);
		const unnormalized = helpers.createSearchIndex<Book>({ fields: ['body'], b: 0 });
		unnormalized.addAll([
			{ id: 1, body: 'a b b b b b' },
			{ id: 2, body: 'a' }
		]);
		expect(unnormalized.search('a')[0].score).toBe(unnormalized.search('a')[1].score);
	});

	it('never scores NaN, even with huge boosts and k1', function () {
		for (const k1 of [0, 1.2, 1e300, Number.MAX_VALUE]) {
			for (const boost of [Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
				const index = helpers.createSearchIndex<Book>({ fields: { title: boost, body: Number.MAX_VALUE }, k1 });
				index.addAll(books);
				for (const result of index.search('whale the a old', { prefix: true })) {
					expect(result.score).toBeGreaterThanOrEqual(0);
					expect(Number.isNaN(result.score)).toBe(false);
				}
				expect(
					index.search('moby whale').map(function (r) {
						return r.id;
					})[0]
				).toBe(1);
			}
		}
	});

	it('breaks ties by insertion order, a replaced document counting as added last', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		index.addAll([
			{ id: 'b', title: 'same' },
			{ id: 'a', title: 'same' },
			{ id: 'c', title: 'same' }
		]);
		expect(idsOf(index.search('same'))).toEqual(['b', 'a', 'c']);
		expect(index.replace({ id: 'b', title: 'same' })).toBe(true);
		expect(idsOf(index.search('same'))).toEqual(['a', 'c', 'b']);
		expect(idsOf(index.search('same', { limit: 2 }))).toEqual(['a', 'c']);
	});

	it('keeps the best results with a limit', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['body'] });
		for (let i = 0; i < 40; i++) index.add({ id: i, body: `x ${'y '.repeat(i % 7)}${'x '.repeat(i % 5)}` });
		const all = index.search('x');
		expect(all).toHaveLength(40);
		for (let i = 1; i < all.length; i++) {
			expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score);
			if (all[i - 1].score === all[i].score) expect(all[i - 1].id).toBeLessThan(all[i].id as number);
		}
		for (const limit of [0, 1, 2, 3, 5, 8, 13, 39, 40, 41, Infinity]) expect(index.search('x', { limit })).toEqual(all.slice(0, limit));
		// A limit of 0 returns at once, without running the filter.
		const filter = jest.fn(Boolean);
		expect(index.search('x', { limit: 0, filter })).toEqual([]);
		expect(filter).not.toHaveBeenCalled();
	});

	it('matches every term with combine "or" and all of them with "and"', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.addAll(books);
		expect(idsOf(index.search('old whale')).sort()).toEqual([1, 2, 3]);
		expect(idsOf(index.search('old whale', { combine: 'and' }))).toEqual([]);
		expect(idsOf(index.search('old sharks', { combine: 'and' }))).toEqual([2]);
		expect(idsOf(index.search('old unknown', { combine: 'and' }))).toEqual([]);
		expect(idsOf(index.search('old unknown', { combine: 'or' }))).toEqual([2]);
		expect(index.search('')).toEqual([]);
		expect(index.search('?!')).toEqual([]);
	});

	it('lists the matched terms of each document in query order', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.addAll(books);
		expect(
			index
				.search('sharks whale')
				.map(function (r) {
					return [r.id, r.terms];
				})
				.sort()
		).toEqual([
			[1, ['whale']],
			[2, ['sharks']],
			[3, ['whale']]
		]);
		expect(
			index.search('whale moby').find(function (r) {
				return r.id === 1;
			})?.terms
		).toEqual(['whale', 'moby']);
	});

	it('counts duplicate query terms once', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.addAll(books);
		expect(index.search('whale whale WHALE')).toEqual(index.search('whale'));
		expect(index.search('whale whale', { combine: 'and' })).toEqual(index.search('whale'));
	});

	it('matches prefixes of every term or of the last one, scoring the best expansion', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['body'] });
		index.addAll(books);
		expect(index.search('wha')).toEqual([]);
		const results = index.search('wha', { prefix: true });
		expect(idsOf(results)).toEqual([1, 3]);
		expect(results[1].terms).toEqual(['whales']);
		expect(results[0].score).toBe(index.search('whale')[0].score);
		expect(results[1].score).toBe(index.search('whales')[0].score);
		expect(idsOf(index.search('sh wha', { prefix: 'last' }))).toEqual([1, 3]);
		const all = index.search('sh wha', { prefix: true });
		expect(idsOf(all).sort()).toEqual([1, 2, 3]);
		expect(
			all.find(function (r) {
				return r.id === 1;
			})?.score
		).toBe(index.search('ship whale')[0].score);
		const both = index.search('sh wha', { prefix: true, combine: 'and' });
		expect(
			both.map(function (r) {
				return [r.id, r.terms];
			})
		).toEqual([[1, ['ship', 'whale']]]);
		// The exact term is one of its own expansions.
		expect(idsOf(index.search('whale', { prefix: true }))).toEqual([1, 3]);
		expect(index.search('whale', { prefix: false })).toEqual(index.search('whale'));
		expect(index.search('zz', { prefix: true })).toEqual([]);
		// A repeated term is a prefix if any of its occurrences is one.
		expect(index.search('wha wha', { prefix: 'last' })).toEqual(results);
		// Only the last term is a prefix: 'wha' matches nothing, while with `prefix: true` both terms match 'whale'.
		expect(index.search('wha whale', { prefix: 'last' })).toEqual(index.search('whale', { prefix: true }));
		expect(index.search('wha whale', { prefix: true })[0].score).toBe(2 * results[0].score);
	});

	it('takes the last non-empty term of a custom tokenizer as the prefix', function () {
		const index = helpers.createSearchIndex<Book>({
			fields: ['title'],
			tokenize: function (text) {
				return text.split(' ');
			}
		});
		index.addAll([
			{ id: 1, title: 'apple pie' },
			{ id: 2, title: 'apricot jam' }
		]);
		expect(idsOf(index.search('ap  ', { prefix: 'last' }))).toEqual([1, 2]);
		expect(idsOf(index.search('ap jam', { prefix: 'last' }))).toEqual([2]);
		expect(idsOf(index.search('ap  jam', { prefix: 'last' }))).toEqual([2]);
		expect(idsOf(index.search('  ', { prefix: 'last' }))).toEqual([]);
		// Empty terms are ignored anywhere (an empty prefix would match everything).
		expect(idsOf(index.search('apple  pie', { combine: 'and' }))).toEqual([1]);
		expect(idsOf(index.search('zzz  zzz', { prefix: true }))).toEqual([]);
		// Splitting on single spaces keeps punctuation: 'pie' is not 'pie,'.
		expect(idsOf(index.search('pie,'))).toEqual([]);
	});

	it('keeps the sorted term list in sync with additions and removals', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		index.add({ id: 1, title: 'beta' });
		expect(idsOf(index.search('b', { prefix: true }))).toEqual([1]);
		index.add({ id: 2, title: 'alpha bet' });
		index.add({ id: 3, title: 'gamma' });
		expect(
			index.search('b', { prefix: true }).map(function (r) {
				return r.terms;
			})
		).toEqual([['beta'], ['bet']]);
		index.remove(1);
		expect(idsOf(index.search('b', { prefix: true }))).toEqual([2]);
		// Removed, then added again: listed once.
		index.add({ id: 4, title: 'beta' });
		index.remove(2);
		index.add({ id: 5, title: 'bet' });
		expect(idsOf(index.search('be', { prefix: true }))).toEqual([4, 5]);
		index.remove(4);
		expect(idsOf(index.search('be', { prefix: true }))).toEqual([5]);
		// A term added and removed between two prefix searches.
		index.add({ id: 6, title: 'betting' });
		index.remove(6);
		expect(idsOf(index.search('be', { prefix: true }))).toEqual([5]);
		expect(idsOf(index.search('', { prefix: true }))).toEqual([]);
		// Terms sorting before and after the new ones survive the merge.
		const ordered = helpers.createSearchIndex<Book>({ fields: ['title'] });
		ordered.add({ id: 1, title: 'zeta 10' });
		expect(idsOf(ordered.search('1', { prefix: true }))).toEqual([1]);
		ordered.add({ id: 2, title: 'alpha' });
		expect(idsOf(ordered.search('z', { prefix: true }))).toEqual([1]);
		expect(idsOf(ordered.search('1', { prefix: true }))).toEqual([1]);
		expect(idsOf(ordered.search('al', { prefix: true }))).toEqual([2]);
	});

	it('removes documents exactly, as if they had never been added', function () {
		const fresh = helpers.createSearchIndex<Book>({ fields: { title: 2, body: 1 } });
		fresh.addAll(books.slice(1));
		const churned = helpers.createSearchIndex<Book>({ fields: { title: 2, body: 1 } });
		churned.addAll(books);
		for (let i = 0; i < 20; i++) churned.add({ id: `extra${i}`, title: 'whale old', body: `filler ${i}` });
		for (let i = 0; i < 20; i++) expect(churned.remove(`extra${i}`)).toBe(true);
		expect(churned.remove(1)).toBe(true);
		expect(churned.remove(1)).toBe(false);
		expect(churned.size).toBe(2);
		for (const query of ['whale', 'old', 'the sea', 'a', 'filler']) {
			expect(churned.search(query)).toEqual(fresh.search(query));
			expect(churned.search(query, { prefix: true })).toEqual(fresh.search(query, { prefix: true }));
		}
		churned.remove(2);
		churned.remove(3);
		expect(churned.size).toBe(0);
		expect(churned.search('whale')).toEqual([]);
		churned.add(books[0]);
		expect(churned.search('whale')).toHaveLength(1);
	});

	it('keeps posting lists sorted and exact across vacuums', function () {
		const all: Book[] = [];
		for (let i = 0; i < 10; i++) all.push({ id: i, title: i % 2 === 1 ? 'x' : 'y', body: i % 2 === 1 ? 'y' : 'x x z' });
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.addAll(all);
		// Removing 6 of 10 documents vacuums the index (removed documents outnumber the others).
		for (let id = 2; id < 8; id++) index.remove(id);
		const fresh = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		fresh.addAll([all[0], all[1], all[8], all[9]]);
		for (const query of ['x', 'y', 'z', 'x y z']) expect(index.search(query)).toEqual(fresh.search(query));
		index.remove(1);
		fresh.remove(1);
		for (const query of ['x', 'y', 'z', 'x y z']) expect(index.search(query)).toEqual(fresh.search(query));
		expect(
			index.search('x').map(function (r) {
				return r.terms;
			})
		).toEqual([['x'], ['x'], ['x']]);
	});

	it('replaces or removes and adds the same document in constant time (regression)', function () {
		// Deleting a key of a large Map and adding it again made its V8 hash chain grow until the next rehash: replacing the same document
		// in a 10 000-document index cost about 170 µs, growing with the index (now about 1 µs): this loop took more than 3 seconds.
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		for (let id = 0; id < 20_000; id++) index.add({ id, title: `common ${id}` });
		const started = Date.now();
		for (let i = 0; i < 20_000; i++) {
			index.replace({ id: 0, title: 'common unique' });
			index.remove(1);
			index.add({ id: 1, title: 'common other' });
		}
		expect(Date.now() - started).toBeLessThan('__stryker__' in globalThis ? Infinity : 1000);
		expect(index.size).toBe(20_000);
		expect(idsOf(index.search('unique other', { prefix: true }))).toEqual([0, 1]);
		// A removed document's id and the terms only it had are kept until the next vacuum, but are never found.
		index.remove(0);
		expect(index.has(0)).toBe(false);
		expect(index.get(0)).toBeUndefined();
		expect(index.remove(0)).toBe(false);
		expect(index.search('unique')).toEqual([]);
		expect(index.search('uni', { prefix: true })).toEqual([]);
		expect(idsOf(index.search('unique other', { combine: 'or' }))).toEqual([1]);
		index.add({ id: 0, title: 'common unique' });
		expect(idsOf(index.search('unique'))).toEqual([0]);
		expect(index.search('unique')[0].score).toBe(index.search('other')[0].score);
	});

	it('replaces documents, keeping the old one when the new one is invalid', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		expect(index.replace({ id: 1, title: 'first' })).toBe(false);
		expect(index.replace({ id: 1, title: 'second' })).toBe(true);
		expect(idsOf(index.search('first'))).toEqual([]);
		expect(idsOf(index.search('second'))).toEqual([1]);
		expect(function () {
			index.replace({ id: 1, title: 3 });
		}).toThrow(TypeError);
		expect(index.get(1)).toEqual({ id: 1, title: 'second' });
		expect(index.size).toBe(1);
	});

	it('has, get, size and SameValueZero ids', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		const document = { id: 0, title: 'zero' };
		index.add(document);
		index.add({ id: '0', title: 'string zero' });
		expect(index.size).toBe(2);
		expect(index.has(0)).toBe(true);
		expect(index.has(-0)).toBe(true);
		expect(index.has('0')).toBe(true);
		expect(index.has(1)).toBe(false);
		expect(index.get(-0)).toBe(document);
		expect(index.get(1)).toBeUndefined();
		expect(function () {
			index.add({ id: -0, title: 'again' });
		}).toThrow(new RangeError('SearchIndex.add: a document with the id 0 is already indexed'));
		expect(function () {
			index.addAll([
				{ id: 5, title: 'five' },
				{ id: '0', title: 'again' }
			]);
		}).toThrow(new RangeError('SearchIndex.addAll: a document with the id 0 is already indexed'));
		// The documents before the invalid one stay indexed.
		expect(index.has(5)).toBe(true);
	});

	it('gets nothing for an unknown id, even with a polluted Object.prototype', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		index.add({ id: 1, title: 'one' });
		const proto = Object.prototype as Record<string, unknown>;
		proto.undefined = 'polluted';
		try {
			expect(index.get(2)).toBeUndefined();
		} finally {
			delete proto.undefined;
		}
	});

	it('reads ids and fields through `id` and `extract`', function () {
		const fields: string[] = [];
		const index = helpers.createSearchIndex<{ key: string; meta: { name: string; tags: string[] } }>({
			id: 'key',
			fields: ['name', 'tags'],
			extract: function (document, field) {
				fields.push(field);
				return field === 'name' ? document.meta.name : document.meta.tags;
			}
		});
		index.add({ key: 'k', meta: { name: 'Widget', tags: ['blue', 'small'] } });
		expect(idsOf(index.search('small widget', { combine: 'and' }))).toEqual(['k']);
		expect(fields).toStrictEqual(['name', 'tags']);
	});

	it('reads own and class properties, never a polluted Object.prototype', function () {
		class Article {
			id = 7;
			get title(): string {
				return 'getter title';
			}
		}
		const index = helpers.createSearchIndex<object>({ fields: ['title', 'toString'] });
		index.add(new Article());
		expect(idsOf(index.search('getter'))).toEqual([7]);
		// A class prototype is not Object.prototype: its `constructor` is read (and is not text).
		expect(function () {
			helpers.createSearchIndex<object>({ fields: ['constructor'] }).add(new Article());
		}).toThrow(new TypeError('SearchIndex.add: `document.constructor` must be a string, an array of strings, null or undefined, got function'));
		helpers.createSearchIndex<object>({ fields: ['constructor'] }).add({ id: 1 });
		const proto = Object.prototype as Record<string, unknown>;
		proto.body = 'polluted';
		proto.limit = 0;
		proto.combine = 'and';
		try {
			const polluted = helpers.createSearchIndex<Book>({ fields: ['body'] });
			polluted.add({ id: 1 });
			polluted.add({ id: 2, body: 'clean' });
			expect(polluted.search('polluted')).toEqual([]);
			expect(idsOf(polluted.search('clean polluted'))).toEqual([2]);
		} finally {
			delete proto.body;
			delete proto.limit;
			delete proto.combine;
		}
	});

	it('uses a custom tokenizer for fields and queries, ignoring empty terms', function () {
		const calls: string[] = [];
		const index = helpers.createSearchIndex<Book>({
			fields: ['title'],
			tokenize: function (text) {
				calls.push(text);
				return text.split(/(?=[A-Z])/).concat('');
			}
		});
		index.add({ id: 1, title: 'fooBarBaz' });
		expect(idsOf(index.search('Bar'))).toEqual([1]);
		expect(idsOf(index.search('bar'))).toEqual([]);
		expect(calls).toEqual(['fooBarBaz', 'Bar', 'bar']);
		expect(index.search('')).toEqual([]);
	});

	it('tokenizes with tokenize and its default options', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		index.add({ id: 1, title: 'Café CRÈME' });
		expect(idsOf(index.search('cafe'))).toEqual([]);
		expect(idsOf(index.search('café crème', { combine: 'and' }))).toEqual([1]);
		expect(index.search('CAFÉ')[0].terms).toEqual(['café']);
	});

	it('accepts the default tokenizer with options', function () {
		const index = helpers.createSearchIndex<Book>({
			fields: ['title'],
			tokenize: function (text) {
				return helpers.tokenize(text, { ignoreDiacritics: true });
			}
		});
		index.add({ id: 1, title: 'Crème brûlée' });
		expect(idsOf(index.search('CREME'))).toEqual([1]);
		expect(index.search('brul', { prefix: true })[0].terms).toEqual(['brulee']);
	});

	it('filters the matching documents', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title', 'body'] });
		index.addAll(books);
		const seen: Book[] = [];
		const results = index.search('whale', {
			filter: function (book) {
				seen.push(book);
				return book.id !== 3;
			}
		});
		expect(idsOf(results)).toEqual([1]);
		expect(seen).toHaveLength(2);
		expect(
			index
				.search('whale old', {
					limit: 1,
					filter: function (book) {
						return book.id === 2 ? 1 : 0;
					}
				})
				.map(function (r) {
					return r.id;
				})
		).toEqual([2]);
		// Searching from the filter is fine.
		const nested = index.search('whale', {
			filter: function () {
				return index.search('old').length === 1;
			}
		});
		expect(idsOf(nested)).toEqual(idsOf(index.search('whale')));
		expect(function () {
			index.search('whale', {
				filter: function (book) {
					index.remove(book.id);
					return true;
				}
			});
		}).toThrow(new Error('SearchIndex.search: `options.filter` must not modify the index'));
	});

	it('grows its scratch space as documents are added between searches', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		for (let i = 0; i < 50; i++) {
			index.add({ id: i, title: `common word${i}` });
			expect(index.search('common')).toHaveLength(i + 1);
			expect(idsOf(index.search(`word${i}`))).toEqual([i]);
		}
	});

	it('validates its options', function () {
		function create(options: unknown): void {
			helpers.createSearchIndex(options as helpers.SearchIndexOptions<object>);
		}
		expect(function () {
			create(null);
		}).toThrow(new TypeError('createSearchIndex: `options` must be an object, got null'));
		expect(function () {
			create('title');
		}).toThrow(new TypeError('createSearchIndex: `options` must be an object, got string'));
		expect(function () {
			create({});
		}).toThrow(new TypeError('createSearchIndex: `options.fields` must be an array of field names or an object of boosts, got undefined'));
		expect(function () {
			create({ fields: 'title' });
		}).toThrow(new TypeError('createSearchIndex: `options.fields` must be an array of field names or an object of boosts, got string'));
		expect(function () {
			create({ fields: null });
		}).toThrow(new TypeError('createSearchIndex: `options.fields` must be an array of field names or an object of boosts, got null'));
		expect(function () {
			create({ fields: ['title', 1] });
		}).toThrow(new TypeError('createSearchIndex: `options.fields` must contain field names, got number'));
		expect(function () {
			create({ fields: [] });
		}).toThrow(new RangeError('createSearchIndex: `options.fields` must name at least one field, got none'));
		expect(function () {
			create({ fields: {} });
		}).toThrow(new RangeError('createSearchIndex: `options.fields` must name at least one field, got none'));
		expect(function () {
			create({ fields: ['a', 'b', 'a'] });
		}).toThrow(new RangeError('createSearchIndex: `options.fields` must name each field once, got a, b, a'));
		expect(function () {
			create({ fields: { title: '2' } });
		}).toThrow(new TypeError('createSearchIndex: `options.fields.title` must be a finite number > 0, got string'));
		for (const boost of [0, -1, Infinity, NaN]) {
			expect(function () {
				create({ fields: { title: boost } });
			}).toThrow(new RangeError(`createSearchIndex: \`options.fields.title\` must be a finite number > 0, got ${boost}`));
		}
		expect(function () {
			create({ fields: { title: Number.MIN_VALUE, body: Number.MAX_VALUE } });
		}).not.toThrow();
		expect(function () {
			create({ fields: ['title'], id: 1 });
		}).toThrow(new TypeError('createSearchIndex: `options.id` must be a string, got number'));
		expect(function () {
			create({ fields: ['title'], extract: 'title' });
		}).toThrow(new TypeError('createSearchIndex: `options.extract` must be a function, got string'));
		expect(function () {
			create({ fields: ['title'], tokenize: /\s/ });
		}).toThrow(new TypeError('createSearchIndex: `options.tokenize` must be a function, got object'));
		for (const k1 of [-1, Infinity, NaN]) {
			expect(function () {
				create({ fields: ['title'], k1 });
			}).toThrow(new RangeError(`createSearchIndex: \`options.k1\` must be a finite number >= 0, got ${k1}`));
		}
		expect(function () {
			create({ fields: ['title'], k1: '1' });
		}).toThrow(new TypeError('createSearchIndex: `options.k1` must be a finite number >= 0, got string'));
		for (const b of [-0.1, 1.1, NaN]) {
			expect(function () {
				create({ fields: ['title'], b });
			}).toThrow(new RangeError(`createSearchIndex: \`options.b\` must be a number between 0 and 1, got ${b}`));
		}
		expect(function () {
			create({ fields: ['title'], k1: 0, b: 1 });
			create({ fields: ['title'], b: 0 });
		}).not.toThrow();
	});

	it('validates documents and what the tokenizer returns', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		const add = index.add as (document: unknown) => void;
		expect(function () {
			add(null);
		}).toThrow(new TypeError('SearchIndex.add: `document` must be an object, got null'));
		expect(function () {
			add('doc');
		}).toThrow(new TypeError('SearchIndex.add: `document` must be an object, got string'));
		expect(function () {
			add({ title: 'no id' });
		}).toThrow(new TypeError('SearchIndex.add: `document.id` must be a string or a number other than NaN, got undefined'));
		expect(function () {
			add({ id: {}, title: 'object id' });
		}).toThrow(new TypeError('SearchIndex.add: `document.id` must be a string or a number other than NaN, got object'));
		expect(function () {
			add({ id: NaN, title: 'NaN id' });
		}).toThrow(new RangeError('SearchIndex.add: `document.id` must be a string or a number other than NaN, got NaN'));
		expect(function () {
			add({ id: 1, title: 42 });
		}).toThrow(new TypeError('SearchIndex.add: `document.title` must be a string, an array of strings, null or undefined, got number'));
		expect(function () {
			add({ id: 1, title: ['ok', 42] });
		}).toThrow(new TypeError('SearchIndex.add: `document.title` must be a string, an array of strings, null or undefined, got an array containing number'));
		expect(index.size).toBe(0);
		expect(function () {
			index.addAll(null as unknown as Book[]);
		}).toThrow(new TypeError('SearchIndex.addAll: `documents` must be an iterable, got null'));
		expect(function () {
			index.addAll({} as unknown as Book[]);
		}).toThrow(new TypeError('SearchIndex.addAll: `documents` must be an iterable, got object'));
		expect(function () {
			(index.replace as (document: unknown) => boolean)(undefined);
		}).toThrow(new TypeError('SearchIndex.replace: `document` must be an object, got undefined'));

		const strange = helpers.createSearchIndex<Book>({
			fields: ['title'],
			tokenize: function (text) {
				return (text === 'string' ? 'abc' : text === 'number' ? ['a', 1] : [text]) as string[];
			}
		});
		expect(function () {
			strange.add({ id: 1, title: 'string' });
		}).toThrow(new TypeError('SearchIndex.add: `options.tokenize` must return an array of strings, got string'));
		expect(function () {
			strange.add({ id: 1, title: 'number' });
		}).toThrow(new TypeError('SearchIndex.add: `options.tokenize` must return an array of strings, got an array containing number'));
		expect(function () {
			strange.search('number');
		}).toThrow(new TypeError('SearchIndex.search: `options.tokenize` must return an array of strings, got an array containing number'));
		expect(function () {
			strange.search('string');
		}).toThrow(new TypeError('SearchIndex.search: `options.tokenize` must return an array of strings, got string'));
		expect(strange.size).toBe(0);
	});

	it('validates the search arguments', function () {
		const index = helpers.createSearchIndex<Book>({ fields: ['title'] });
		index.add({ id: 1, title: 'one' });
		const search = index.search as (query: unknown, options?: unknown) => unknown;
		expect(function () {
			search(1);
		}).toThrow(new TypeError('SearchIndex.search: `query` must be a string, got number'));
		expect(function () {
			search('one', { limit: -1 });
		}).toThrow(new RangeError('SearchIndex.search: `options.limit` must be an integer >= 0 or Infinity, got -1'));
		expect(function () {
			search('one', { prefix: 'first' });
		}).toThrow(new TypeError("SearchIndex.search: `options.prefix` must be a boolean or 'last', got first"));
		expect(function () {
			search('one', { prefix: 1 });
		}).toThrow(new TypeError("SearchIndex.search: `options.prefix` must be a boolean or 'last', got 1"));
		expect(function () {
			search('one', { combine: 'xor' });
		}).toThrow(new TypeError("SearchIndex.search: `options.combine` must be 'or' or 'and', got xor"));
		expect(function () {
			search('one', { filter: true });
		}).toThrow(new TypeError('SearchIndex.search: `options.filter` must be a function, got boolean'));
		expect(search('one', { limit: 0 })).toEqual([]);
		expect(search('one', { prefix: false, combine: 'or' })).toHaveLength(1);
	});
});
