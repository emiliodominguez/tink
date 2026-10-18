import * as helpers from '.';

describe('Search helpers', function () {
	describe('fuzzyMatch', function () {
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
