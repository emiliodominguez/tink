import * as helpers from '.';

/**
 * Loads a fresh copy of the module while `Intl.Segmenter` (or, with `withoutIntl`, the whole `Intl` global) is unavailable, to exercise
 * the code-point fallback.
 */
function loadWithoutSegmenter(withoutIntl: boolean = false): typeof helpers {
	const global = globalThis as any;
	const intl = Intl as any;
	const original = intl.Segmenter;
	let isolated: typeof helpers | undefined;

	try {
		if (withoutIntl) delete global.Intl;
		else delete intl.Segmenter;
		jest.isolateModules(function () {
			isolated = jest.requireActual<typeof helpers>('./index');
		});
		// The segmenter is resolved lazily (and only for text that is not plain ASCII/Latin), so trigger it while Intl.Segmenter is still missing.
		isolated!.reverse('warm-up \u{1F44D}');
	} finally {
		global.Intl = intl;
		intl.Segmenter = original;
	}

	return isolated!;
}

describe('String helpers', function () {
	describe('reverse', function () {
		it('should reverse the string', function () {
			expect(helpers.reverse('hello')).toEqual('olleh');
		});

		it('should return an empty string for an empty input', function () {
			expect(helpers.reverse('')).toEqual('');
		});

		it('should return the same string for a single character input', function () {
			expect(helpers.reverse('a')).toEqual('a');
		});

		it('should keep surrogate pairs, emoji sequences and combining marks intact', function () {
			expect(helpers.reverse('a😀b')).toEqual('b😀a');
			expect(helpers.reverse('x👍🏽y')).toEqual('y👍🏽x');
			expect(helpers.reverse('👨\u200d👩\u200d👧!')).toEqual('!👨\u200d👩\u200d👧');
			expect(helpers.reverse('ae\u0301b')).toEqual('be\u0301a');
			expect(helpers.reverse('🇫🇷🇩🇪')).toEqual('🇩🇪🇫🇷');
		});

		describe('without Intl.Segmenter', function () {
			const fallback = loadWithoutSegmenter();

			it('should fall back to code points (surrogate pairs kept)', function () {
				expect(fallback.reverse('a😀b')).toEqual('b😀a');
				expect(fallback.reverse('')).toEqual('');
				// Combining marks are separate code points in the fallback.
				expect(fallback.reverse('e\u0301')).toEqual('\u0301e');
			});

			it('should keep the other grapheme-aware helpers working', function () {
				expect(fallback.capitalize('😀abc')).toEqual('😀abc');
				expect(fallback.capitalize('élan')).toEqual('Élan');
				expect(fallback.capitalize('')).toEqual('');
				expect(fallback.truncate('😀😀😀', 2)).toEqual('😀😀...');
			});

			it('should also fall back on runtimes without any Intl global', function () {
				const noIntl = loadWithoutSegmenter(true);
				expect(noIntl.reverse('a😀e\u0301')).toEqual('\u0301e😀a');
				expect(noIntl.truncate('😀😀😀', 2)).toEqual('😀😀...');
			});
		});
	});

	describe('capitalize', function () {
		it('should return the capitalized string', function () {
			expect(helpers.capitalize('hello')).toEqual('Hello');
			expect(helpers.capitalize('world')).toEqual('World');
			expect(helpers.capitalize('javascript')).toEqual('Javascript');
		});

		it('should return an empty string when given an empty string', function () {
			expect(helpers.capitalize('')).toEqual('');
		});

		it('should only touch the first character', function () {
			expect(helpers.capitalize('hELLO')).toEqual('HELLO');
			expect(helpers.capitalize('1abc')).toEqual('1abc');
		});

		it('should handle unicode first characters', function () {
			expect(helpers.capitalize('élan')).toEqual('Élan');
			expect(helpers.capitalize('e\u0301lan')).toEqual('E\u0301lan');
			expect(helpers.capitalize('😀 smile')).toEqual('😀 smile');
			expect(helpers.capitalize('𐐨x')).toEqual('𐐀x');
		});

		it('should upper-case the whole first grapheme, combining marks included', function () {
			// U+0345 (combining ypogegrammeni) upper-cases to U+0399 (Ι): only visible when the mark is converted with its base letter.
			expect(helpers.capitalize('a\u0345b')).toEqual('A\u0399b');
			expect(helpers.capitalize('\u03b1\u0345\u03b2')).toEqual('\u0391\u0399\u03b2');
		});
	});

	describe('uncapitalize', function () {
		it('should lower-case the first character only', function () {
			expect(helpers.uncapitalize('Hello World')).toEqual('hello World');
			expect(helpers.uncapitalize('HELLO')).toEqual('hELLO');
			expect(helpers.uncapitalize('')).toEqual('');
		});

		it('should handle unicode first characters', function () {
			expect(helpers.uncapitalize('Élan')).toEqual('élan');
			expect(helpers.uncapitalize('𐐀x')).toEqual('𐐨x');
		});
	});

	describe('substring', function () {
		it('should extract a substring from a string based on start and end indices', function () {
			expect(helpers.substring('Hello, World!', 7, 12)).toEqual('World');
			expect(helpers.substring('Hello, World!', 0, 5)).toEqual('Hello');
		});

		it('should return an empty string if the start index is greater than the end index', function () {
			expect(helpers.substring('Hello, World!', 12, 7)).toEqual('');
		});

		it('should return the entire string if the end index is greater than the length of the string', function () {
			expect(helpers.substring('Hello, World!', 7, 100)).toEqual('World!');
		});

		it('should handle empty input', function () {
			expect(helpers.substring('', 0, 3)).toEqual('');
		});

		it('should never swap the indices, even when one of them is NaN (regression)', function () {
			// NaN used to reach String.prototype.substring, which treats it as 0 and swaps the indices.
			expect(helpers.substring('abc', 1, NaN)).toEqual('');
			expect(helpers.substring('abc', Infinity, NaN)).toEqual('');
			expect(helpers.substring('abc', NaN, 2)).toEqual('ab');
		});

		it('should clamp negative and out-of-range indices and truncate fractional ones', function () {
			expect(helpers.substring('abc', -5, 2)).toEqual('ab');
			expect(helpers.substring('abc', 0, -1)).toEqual('');
			expect(helpers.substring('abc', 1.9, 2.9)).toEqual('b');
			expect(helpers.substring('abc', -Infinity, Infinity)).toEqual('abc');
		});
	});

	describe('includes', function () {
		it('should return true if the string contains the specified substring', function () {
			expect(helpers.includes('hello world', 'hello')).toEqual(true);
			expect(helpers.includes('hello', '')).toEqual(true);
		});

		it('should return false if the string does not contain the specified substring', function () {
			expect(helpers.includes('hello world', 'goodbye')).toEqual(false);
			expect(helpers.includes('hello world', 'Hello')).toEqual(false);
		});
	});

	describe('replace', function () {
		it('should replace all occurrences of a specified substring with a replacement string', function () {
			expect(helpers.replace('hello world', 'o', '0')).toEqual('hell0 w0rld');
		});

		it('should return the original string if the specified substring is not found', function () {
			expect(helpers.replace('hello world', 'x', '0')).toEqual('hello world');
		});

		it('should return the original string if the searchValue is an empty string', function () {
			expect(helpers.replace('hello world', '', '0')).toEqual('hello world');
		});

		it('should treat the search value literally (no regex injection)', function () {
			expect(helpers.replace('a.b.c', '.', '-')).toEqual('a-b-c');
			expect(helpers.replace('f(x) = (y)', '(', '[')).toEqual('f[x) = [y)');
			expect(helpers.replace('a*b+c?', '*', 'x')).toEqual('axb+c?');
			expect(helpers.replace('a\\b', '\\', '/')).toEqual('a/b');
		});

		it('should treat the replacement literally (no $ patterns)', function () {
			expect(helpers.replace('price: 5', '5', '$&0')).toEqual('price: $&0');
			expect(helpers.replace('abc', 'b', '$1$$')).toEqual('a$1$$c');
			expect(helpers.replace('abc', 'b', "$`$'")).toEqual("a$`$'c");
		});

		it('should replace non-overlapping occurrences from left to right', function () {
			expect(helpers.replace('aaa', 'aa', 'b')).toEqual('ba');
		});
	});

	describe('truncate', function () {
		it('should truncate the string to the specified length and adds the suffix', function () {
			expect(helpers.truncate('hello world', 5)).toEqual('hello...');
			expect(helpers.truncate('hello world', 5, '!')).toEqual('hello!');
			expect(helpers.truncate('hello world', 0)).toEqual('...');
			expect(helpers.truncate('hello world', 5, '')).toEqual('hello');
		});

		it('should return the original string if the length is greater than or equal to the string length', function () {
			expect(helpers.truncate('hello world', 20)).toEqual('hello world');
			expect(helpers.truncate('hello world', 20, '!')).toEqual('hello world');
			expect(helpers.truncate('hello', 5)).toEqual('hello');
			expect(helpers.truncate('', 0)).toEqual('');
		});

		it('should only split the start of a long text into graphemes (regression: the whole text was segmented)', function () {
			const segment = jest.spyOn(Intl.Segmenter.prototype, 'segment');
			try {
				for (const text of ['привет '.repeat(100_000), 'é' + 'a'.repeat(1_000_000), 'नमस्ते '.repeat(100_000)]) {
					const expected = Array.from(new Intl.Segmenter().segment(text.slice(0, 100)), function (data) {
						return data.segment;
					})
						.slice(0, 10)
						.join('');
					segment.mockClear();
					expect(helpers.truncate(text, 10)).toBe(expected + '...');
					for (const [input] of segment.mock.calls) expect(input.length).toBeLessThan(1000);
				}
				expect(helpers.truncate('привет мир', 6, { separator: ' ' })).toBe('привет...');
				expect(helpers.truncate('é'.repeat(40), 30)).toBe('é'.repeat(30) + '...');
				expect(helpers.truncate('é'.repeat(30), 30)).toBe('é'.repeat(30));
			} finally {
				segment.mockRestore();
			}
		});

		it('should never split a surrogate pair or a grapheme cluster', function () {
			expect(helpers.truncate('😀😀😀', 1)).toEqual('😀...');
			expect(helpers.truncate('👍🏽👍🏽👍🏽', 2)).toEqual('👍🏽👍🏽...');
			expect(helpers.truncate('e\u0301e\u0301e\u0301', 1)).toEqual('e\u0301...');
		});

		it('should count graphemes, not UTF-16 code units', function () {
			// 3 graphemes but 6 code units: nothing to truncate.
			expect(helpers.truncate('😀😀😀', 3)).toEqual('😀😀😀');
			expect(helpers.truncate('😀😀😀', 4)).toEqual('😀😀😀');
		});

		it('should throw a RangeError for invalid lengths', function () {
			expect(function () {
				helpers.truncate('hello', -1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.truncate('hello', 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.truncate('hello', NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.truncate('hello', Infinity);
			}).toThrow(new RangeError('truncate: `length` must be an integer >= 0, got Infinity'));
			expect(function () {
				helpers.truncate('hello', '3' as any);
			}).toThrow(new TypeError('truncate: `length` must be an integer >= 0, got string'));
		});
	});

	describe('repeat', function () {
		it('should repeat the string the specified number of times', function () {
			expect(helpers.repeat('hello', 3)).toEqual('hellohellohello');
			expect(helpers.repeat('', 3)).toEqual('');
			expect(helpers.repeat('ab', 0)).toEqual('');
			expect(helpers.repeat('😀', 2)).toEqual('😀😀');
		});

		it('should throw a RangeError for negative, fractional, NaN or infinite counts', function () {
			for (const times of [-1, 1.5, NaN, Infinity, -Infinity]) {
				expect(function () {
					helpers.repeat('a', times);
				}).toThrow(RangeError);
			}
		});
	});

	describe('trim', function () {
		it('should remove white spaces from the beginning and end of the string', function () {
			expect(helpers.trim('  hello world  ')).toEqual('hello world');
			expect(helpers.trim('hello world')).toEqual('hello world');
			expect(helpers.trim('')).toEqual('');
			expect(helpers.trim('\t\n hi \u00a0')).toEqual('hi');
		});
	});

	describe('toTitleCase', function () {
		it('should convert a string to title case', function () {
			expect(helpers.toTitleCase('hello world')).toEqual('Hello World');
			expect(helpers.toTitleCase('The quick brown fox')).toEqual('The Quick Brown Fox');
			expect(helpers.toTitleCase('HELLO wORLD')).toEqual('Hello World');
		});

		it('should preserve whitespace and punctuation', function () {
			expect(helpers.toTitleCase('  hello \t\n world  ')).toEqual('  Hello \t\n World  ');
			expect(helpers.toTitleCase('hello, world! (foo) "bar"')).toEqual('Hello, World! (Foo) "Bar"');
			expect(helpers.toTitleCase('hello-world')).toEqual('Hello-world');
			expect(helpers.toTitleCase('')).toEqual('');
		});

		it('should not capitalize a word that starts with a digit', function () {
			expect(helpers.toTitleCase('the 1st PLACE')).toEqual('The 1st Place');
		});

		it('should handle unicode letters', function () {
			expect(helpers.toTitleCase('élan vital')).toEqual('Élan Vital');
			expect(helpers.toTitleCase('ΑΘΗΝΑ')).toEqual('Αθηνα');
			expect(helpers.toTitleCase('straße ßa')).toEqual('Straße Ssa');
			expect(helpers.toTitleCase('ﬁne')).toEqual('Fine');
		});

		it('should skip modifier letters without case at the start of a word (regression: the Hawaiian ʻokina, toTitleCase not idempotent)', function () {
			expect(helpers.toTitleCase('ʻiolani palace, ʻōlelo hawaiʻi')).toBe('ʻIolani Palace, ʻŌlelo Hawaiʻi');
			expect(helpers.toTitleCase(helpers.toTitleCase('ŉ'))).toBe('ʼN');
			expect(helpers.toTitleCase('ʼnaff')).toBe('ʼNaff');
			expect(helpers.toPascalCase('ʻiolani palace')).toBe('ʻIolaniPalace');
			expect(helpers.toStartCase('ʻōlelo')).toBe('ʻŌlelo');
			expect(helpers.toSentenceCase('ʻaiea town')).toBe('ʻAiea town');
			expect(helpers.toCamelCase('the ʻewa beach')).toBe('theʻEwaBeach');
			// Cased modifier letters (ʰ, ᴬ) are letters like any other; a word of modifier letters only is left as it is.
			expect(helpers.toTitleCase('ʰa ᴬb ʻ ʻʻ')).toBe('ʰa ᴬb ʻ ʻʻ');
			expect(helpers.toPascalCase('ʻ ʻʻ')).toBe('ʻʻʻ');
		});

		it('should use the Unicode title-case form of digraphs (regression)', function () {
			// Used to produce the upper-case digraph ('Ǆemal').
			expect(helpers.toTitleCase('ǆemal ǅEMAL Ǆemal')).toEqual('ǅemal ǅemal ǅemal');
			expect(helpers.toTitleCase('ǉubljana ǌ ǳ')).toEqual('ǈubljana ǋ ǲ');
			expect(helpers.toTitleCase(helpers.toTitleCase('ǆemal'))).toEqual('ǅemal');
			expect(helpers.toPascalCase('ǆemal ǉubljana')).toEqual('ǅemalǈubljana');
			expect(helpers.toCamelCase('foo ǆemal')).toEqual('fooǅemal');
		});

		it('should use the full Unicode title-case mapping where it differs from the upper case (regression)', function () {
			// Georgian letters are their own title case: their upper case (Mtavruli) is only for all-caps text. Used to give 'Საქართველო'.
			expect(helpers.toTitleCase('საქართველო თბილისი')).toBe('საქართველო თბილისი');
			expect(helpers.toPascalCase('ქართული ენა')).toBe('ქართულიენა');
			// 'ŉ' title-cases to 'ʼN' (SpecialCasing.txt), not 'ʼn'.
			expect(helpers.toTitleCase('ŉ')).toBe('\u02bcN');
			// The Greek letters with ypogegrammeni keep it (as a prosgegrammeni): used to give 'Αι' and 'Ἀι' (a capital then a small iota).
			expect(helpers.toTitleCase('ᾳ ᾀ ᾗ ῳ')).toBe('\u1fbc \u1f88 \u1f9f \u1ffc');
			expect(helpers.toTitleCase('ᾲ ᾴ ᾷ ῇ')).toBe('\u1fba\u0345 \u0386\u0345 \u0391\u0342\u0345 \u0397\u0342\u0345');
			// Their capitals lower-case to them first; the prosgegrammeni alone title-cases to a capital iota.
			expect(helpers.toTitleCase('ᾼ ᾈ \u1fbe')).toBe('\u1fbc \u1f88 \u0399');
			expect(helpers.toStartCase('ᾳδη ქალაქი')).toBe('\u1fbcδη ქალაქი');
			expect(helpers.toTrainCase('ᾳδη ქალაქი')).toBe('\u1fbcδη-ქალაქი');
			expect(helpers.toSentenceCase('ქალაქი ᾳδη')).toBe('ქალაქი ᾳδη');
			expect(helpers.toCamelCase('foo ᾳδη')).toBe('foo\u1fbcδη');
			expect(helpers.toDelimitedCase('ᾳ ŉ', '.', { case: 'capital' })).toBe('\u1fbc.\u02bcN');
		});
	});

	describe('toSnakeCase', function () {
		it('should convert a string to snake case', function () {
			expect(helpers.toSnakeCase('hello world')).toEqual('hello_world');
			expect(helpers.toSnakeCase('The quick brown fox')).toEqual('the_quick_brown_fox');
		});

		it('should split on camelCase, acronyms and any separator', function () {
			expect(helpers.toSnakeCase('helloWorld')).toEqual('hello_world');
			expect(helpers.toSnakeCase('HelloWorld')).toEqual('hello_world');
			expect(helpers.toSnakeCase('a  b')).toEqual('a_b');
			expect(helpers.toSnakeCase('foo-bar.baz/qux')).toEqual('foo_bar_baz_qux');
			expect(helpers.toSnakeCase('XMLHttpRequest')).toEqual('xml_http_request');
			expect(helpers.toSnakeCase('getHTTPResponse2Code')).toEqual('get_http_response2_code');
			expect(helpers.toSnakeCase('  __private_value__  ')).toEqual('private_value');
			expect(helpers.toSnakeCase('CONSTANT_CASE')).toEqual('constant_case');
		});

		it('should keep digits attached to the preceding word', function () {
			expect(helpers.toSnakeCase('version2')).toEqual('version2');
			expect(helpers.toSnakeCase('version2Beta')).toEqual('version2_beta');
			expect(helpers.toSnakeCase('HTTP2Server')).toEqual('http2_server');
			expect(helpers.toSnakeCase('utf8 encoder')).toEqual('utf8_encoder');
		});

		it('should drop apostrophes', function () {
			expect(helpers.toSnakeCase("don't stop")).toEqual('dont_stop');
			expect(helpers.toSnakeCase('it’s fine')).toEqual('its_fine');
		});

		it('should handle unicode letters and empty input', function () {
			expect(helpers.toSnakeCase('ÉcoleNormale supérieure')).toEqual('école_normale_supérieure');
			expect(helpers.toSnakeCase('')).toEqual('');
			expect(helpers.toSnakeCase('  -_- ')).toEqual('');
		});
	});

	describe('toKebabCase', function () {
		it('should convert a string to kebab case', function () {
			expect(helpers.toKebabCase('Hello World')).toEqual('hello-world');
			expect(helpers.toKebabCase('helloWorld')).toEqual('hello-world');
			expect(helpers.toKebabCase('XMLHttpRequest')).toEqual('xml-http-request');
			expect(helpers.toKebabCase('snake_case_value')).toEqual('snake-case-value');
			expect(helpers.toKebabCase('')).toEqual('');
		});
	});

	describe('toConstantCase', function () {
		it('should convert a string to constant case', function () {
			expect(helpers.toConstantCase('maxRetryCount')).toEqual('MAX_RETRY_COUNT');
			expect(helpers.toConstantCase('hello world')).toEqual('HELLO_WORLD');
			expect(helpers.toConstantCase('api-v2-url')).toEqual('API_V2_URL');
			expect(helpers.toConstantCase('')).toEqual('');
		});
	});

	describe('toCamelCase', function () {
		it('should convert a string to camel case', function () {
			expect(helpers.toCamelCase('hello world')).toEqual('helloWorld');
			expect(helpers.toCamelCase('The quick brown fox')).toEqual('theQuickBrownFox');
		});

		it('should handle separators, acronyms and existing cases', function () {
			expect(helpers.toCamelCase('foo-bar_baz qux')).toEqual('fooBarBazQux');
			expect(helpers.toCamelCase('XMLHttpRequest')).toEqual('xmlHttpRequest');
			expect(helpers.toCamelCase('HELLO_WORLD')).toEqual('helloWorld');
			expect(helpers.toCamelCase('helloWorld')).toEqual('helloWorld');
			expect(helpers.toCamelCase('get-http-response2-code')).toEqual('getHttpResponse2Code');
			expect(helpers.toCamelCase('école normale')).toEqual('écoleNormale');
			expect(helpers.toCamelCase('')).toEqual('');
		});
	});

	describe('toPascalCase', function () {
		it('should convert a string to Pascal case', function () {
			expect(helpers.toPascalCase('hello world')).toEqual('HelloWorld');
			expect(helpers.toPascalCase('xml-http-request')).toEqual('XmlHttpRequest');
			expect(helpers.toPascalCase('helloWorld')).toEqual('HelloWorld');
			expect(helpers.toPascalCase('straße')).toEqual('Straße');
			expect(helpers.toPascalCase('ßa')).toEqual('Ssa');
			expect(helpers.toPascalCase('')).toEqual('');
		});
	});

	describe('removeDiacritics', function () {
		it('should strip accents and keep base letters', function () {
			expect(helpers.removeDiacritics('Crème Brûlée à Málaga')).toEqual('Creme Brulee a Malaga');
			expect(helpers.removeDiacritics('Ångström, naïve, façade, São Paulo')).toEqual('Angstrom, naive, facade, Sao Paulo');
			expect(helpers.removeDiacritics('e\u0301')).toEqual('e');
		});

		it('should leave other text untouched', function () {
			expect(helpers.removeDiacritics('')).toEqual('');
			expect(helpers.removeDiacritics('plain ascii 123')).toEqual('plain ascii 123');
			expect(helpers.removeDiacritics('한국어 日本語 😀')).toEqual('한국어 日本語 😀');
		});

		it('should normalize runs of more than 30 combining marks 30 marks at a time, in linear time (regression)', function () {
			// Runtimes reorder a run of marks with an insertion sort: 100 000 alternating accents used to take about 10 seconds.
			const started = Date.now();
			expect(helpers.removeDiacritics('a' + '\u0301\u05b0'.repeat(50_000) + 'b')).toBe('a' + '\u05b0'.repeat(50_000) + 'b');
			expect(helpers.toSlug('a' + '\u0301\u0345'.repeat(50_000) + 'b')).toBe('ab');
			expect(Date.now() - started).toBeLessThan('__stryker__' in globalThis ? Infinity : 1000);
			// Up to 30 marks are reordered and composed as the runtime does it, a longer run 30 marks at a time (the Stream-Safe Text Format).
			const run = '\u05b1\u05b0'.repeat(15);
			expect(helpers.removeDiacritics('א' + run)).toBe('א' + '\u05b0'.repeat(15) + '\u05b1'.repeat(15));
			expect(helpers.removeDiacritics('א' + run + '\u05b1\u05b0'.repeat(5))).toBe(
				'א' + '\u05b0'.repeat(15) + '\u05b1'.repeat(15) + '\u05b0'.repeat(5) + '\u05b1'.repeat(5)
			);
			expect(helpers.removeDiacritics('ж'.repeat(40) + 'e\u0301')).toBe('ж'.repeat(40) + 'e');
			expect(helpers.removeDiacritics('ж'.repeat(40) + '\u0301'.repeat(40))).toBe('ж'.repeat(40));
			// Halfwidth voiced sound marks decompose (NFKD) to combining marks too.
			expect(helpers.toSlug('a' + '\uff9e\u0301'.repeat(20) + 'b')).toBe('a-b');
		});
	});

	describe('toSlug', function () {
		it('should convert a string to a URL-friendly slug', function () {
			expect(helpers.toSlug('hello world')).toEqual('hello-world');
			expect(helpers.toSlug('The quick brown fox!')).toEqual('the-quick-brown-fox');
		});

		it('should strip diacritics and transliterate common letters', function () {
			expect(helpers.toSlug('Café Society')).toEqual('cafe-society');
			expect(helpers.toSlug('Straße Æon Øre Łódź')).toEqual('strasse-aeon-ore-lodz');
			expect(helpers.toSlug('ﬁle №5')).toEqual('file-no5');
			expect(helpers.toSlug('œuvre đak ðe þing ıl')).toEqual('oeuvre-dak-de-thing-il');
		});

		it('should collapse separators and trim hyphens', function () {
			expect(helpers.toSlug('  --Hello__World!!  ')).toEqual('hello-world');
			expect(helpers.toSlug('a - b')).toEqual('a-b');
			expect(helpers.toSlug('snake_case')).toEqual('snake-case');
		});

		it('should return an empty string when nothing is left', function () {
			expect(helpers.toSlug('')).toEqual('');
			expect(helpers.toSlug('!!! 😀 ---')).toEqual('');
			expect(helpers.toSlug('日本語')).toEqual('');
		});
	});

	describe('toBoolean', function () {
		it('should convert a string to a boolean', function () {
			expect(helpers.toBoolean('true')).toEqual(true);
			expect(helpers.toBoolean('false')).toEqual(false);
		});

		it('should accept common truthy values, trimmed and case-insensitively', function () {
			for (const value of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', 'y', 'Y', 'on', 'ON', '\ton\n']) {
				expect(helpers.toBoolean(value)).toEqual(true);
			}
		});

		it('should return false for everything else', function () {
			for (const value of ['', ' ', '0', 'no', 'n', 'off', 'false', 'truthy', '2', 't', 'yes please']) {
				expect(helpers.toBoolean(value)).toEqual(false);
			}
		});
	});

	describe('toNumber', function () {
		it('should convert a string to a number', function () {
			expect(helpers.toNumber('123')).toEqual(123);
			expect(helpers.toNumber('123.45')).toEqual(123.45);
			expect(helpers.toNumber(' -7 ')).toEqual(-7);
			expect(helpers.toNumber('1e3')).toEqual(1000);
			expect(helpers.toNumber('+.5')).toEqual(0.5);
			expect(helpers.toNumber('5.')).toEqual(5);
			expect(helpers.toNumber('\u00a012\n')).toEqual(12);
		});

		it('security: only converts finite decimal numbers, exactly like isNumericString validates them', function () {
			for (const text of ['Infinity', '-Infinity', '+Infinity', '0x7fffffff', '0X1F', '0b1111', '0o777', '1e400', '-1e400', '1_000', 'NaN', '1 2', '١٢']) {
				expect({ text, value: helpers.toNumber(text) }).toEqual({ text, value: NaN });
			}
		});

		it('should return NaN for blank or non-numeric strings', function () {
			expect(helpers.toNumber('')).toBeNaN();
			expect(helpers.toNumber('   ')).toBeNaN();
			expect(helpers.toNumber('\n\t')).toBeNaN();
			expect(helpers.toNumber('12px')).toBeNaN();
			expect(helpers.toNumber('abc')).toBeNaN();
		});
	});

	describe('startsWith', function () {
		it('should true if string starts with subString', function () {
			expect(helpers.startsWith('hello world', 'hello')).toEqual(true);
			expect(helpers.startsWith('hello world', '')).toEqual(true);
		});

		it('should false if string does not start with subString', function () {
			expect(helpers.startsWith('hello world', 'world')).toEqual(false);
			expect(helpers.startsWith('hello world', 'Hello')).toEqual(false);
		});
	});

	describe('endsWith', function () {
		it('should return true if string ends with subString', function () {
			expect(helpers.endsWith('hello world', 'world')).toEqual(true);
		});

		it('should return false if string does not end with subString', function () {
			expect(helpers.endsWith('hello world', 'hello')).toEqual(false);
		});
	});

	describe('countSubString', function () {
		it('should return the number of occurrences of the sub-string in the string', function () {
			expect(helpers.countSubString('hello world, hello', 'hello')).toEqual(2);
		});

		it('should return 0 if the sub-string is not found in the string', function () {
			expect(helpers.countSubString('hello world, hello', 'goodbye')).toEqual(0);
			expect(helpers.countSubString('', 'a')).toEqual(0);
		});

		it('should return 0 for an empty sub-string', function () {
			expect(helpers.countSubString('hello', '')).toEqual(0);
			expect(helpers.countSubString('', '')).toEqual(0);
		});

		it('should match literally (no regex injection)', function () {
			expect(helpers.countSubString('a.b.c', '.')).toEqual(2);
			expect(helpers.countSubString('f(x) + (y)', '(')).toEqual(2);
			expect(helpers.countSubString('a*b', '*')).toEqual(1);
		});

		it('should count non-overlapping occurrences', function () {
			expect(helpers.countSubString('aaaa', 'aa')).toEqual(2);
			expect(helpers.countSubString('aaa', 'aa')).toEqual(1);
		});

		it('should be case-sensitive by default and support ignoreCase', function () {
			expect(helpers.countSubString('Hello hello HELLO', 'hello')).toEqual(1);
			expect(helpers.countSubString('Hello hello HELLO', 'hello', { ignoreCase: true })).toEqual(3);
			expect(helpers.countSubString('Hello hello', 'HELLO', { ignoreCase: true })).toEqual(2);
			expect(helpers.countSubString('ÉCOLE école', 'école', { ignoreCase: true })).toEqual(2);
			expect(helpers.countSubString('İstanbul İzmir', 'İ', { ignoreCase: true })).toEqual(2);
		});
	});

	describe('isEmpty', function () {
		it('should return true for empty strings', function () {
			expect(helpers.isEmpty('')).toEqual(true);
			expect(helpers.isEmpty('   ')).toEqual(true);
			expect(helpers.isEmpty('\n\t\u00a0')).toEqual(true);
		});

		it('should return false for non-empty strings', function () {
			expect(helpers.isEmpty('Hello World')).toEqual(false);
			expect(helpers.isEmpty('   Hello World   ')).toEqual(false);
		});
	});

	describe('getWords', function () {
		it('should return an empty array for empty strings', function () {
			expect(helpers.getWords('')).toEqual([]);
			expect(helpers.getWords('   ')).toEqual([]);
			expect(helpers.getWords('!?, -')).toEqual([]);
		});

		it('should return the words in the string as an array', function () {
			expect(helpers.getWords('Hello World')).toEqual(['Hello', 'World']);
			expect(helpers.getWords('Hello   World')).toEqual(['Hello', 'World']);
			expect(helpers.getWords('one,two;three')).toEqual(['one', 'two', 'three']);
		});

		it('should support unicode letters, numbers and combining marks', function () {
			expect(helpers.getWords('café naïve 2024')).toEqual(['café', 'naïve', '2024']);
			expect(helpers.getWords('cafe\u0301 Привет мир')).toEqual(['cafe\u0301', 'Привет', 'мир']);
		});

		it('should keep inner apostrophes but not leading/trailing ones', function () {
			expect(helpers.getWords("Don't stop, it’s 'quoted'")).toEqual(["Don't", 'stop', 'it’s', 'quoted']);
			expect(helpers.getWords("o'clock rock'n'roll")).toEqual(["o'clock", "rock'n'roll"]);
		});

		it('should split on underscores (unlike \\w)', function () {
			expect(helpers.getWords('snake_case')).toEqual(['snake', 'case']);
		});
	});

	describe('isPalindrome', function () {
		it('should return true for a palindrome string', function () {
			expect(helpers.isPalindrome('racecar')).toEqual(true);
		});

		it('should return false for a non-palindrome string', function () {
			expect(helpers.isPalindrome('hello')).toEqual(false);
		});

		it('should return true for an empty string', function () {
			expect(helpers.isPalindrome('')).toEqual(true);
		});

		it('should return true for a single character string', function () {
			expect(helpers.isPalindrome('a')).toEqual(true);
		});

		it('should be strict by default', function () {
			expect(helpers.isPalindrome('Racecar')).toEqual(false);
			expect(helpers.isPalindrome('race car')).toEqual(false);
		});

		it('should support ignoreCase and ignoreNonAlphanumeric', function () {
			expect(helpers.isPalindrome('Racecar', { ignoreCase: true })).toEqual(true);
			expect(helpers.isPalindrome('race car', { ignoreNonAlphanumeric: true })).toEqual(true);
			expect(helpers.isPalindrome('A man, a plan, a canal: Panama', { ignoreCase: true, ignoreNonAlphanumeric: true })).toEqual(true);
			expect(helpers.isPalindrome('A man, a plan, a canal: Panama', { ignoreNonAlphanumeric: true })).toEqual(false);
			expect(helpers.isPalindrome('hello, world', { ignoreCase: true, ignoreNonAlphanumeric: true })).toEqual(false);
		});

		it('should lower-case both sides with ignoreCase', function () {
			// Upper-casing would turn 'ß' into 'SS' and make 'ßSS' a palindrome.
			expect(helpers.isPalindrome('ßSS', { ignoreCase: true })).toEqual(false);
			expect(helpers.isPalindrome('ẞß', { ignoreCase: true })).toEqual(true);
		});

		it('should be grapheme-aware', function () {
			expect(helpers.isPalindrome('😀a😀')).toEqual(true);
			expect(helpers.isPalindrome('👍🏽x👍🏽')).toEqual(true);
			expect(helpers.isPalindrome('e\u0301te\u0301')).toEqual(true);
		});
	});

	describe('escapeRegExp', function () {
		it('should escape every regex metacharacter', function () {
			expect(helpers.escapeRegExp('.*+?^${}()|[]\\/')).toEqual('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\\\/');
			expect(helpers.escapeRegExp('1.5*(x)')).toEqual('\\x31\\.5\\*\\(x\\)');
		});

		it('should escape like TC39 RegExp.escape: punctuators, white space, line terminators, lone surrogates, a leading letter or digit', function () {
			expect(helpers.escapeRegExp('')).toEqual('');
			expect(helpers.escapeRegExp('_bc😀')).toEqual('_bc😀');
			expect(helpers.escapeRegExp('abc')).toEqual('\\x61bc');
			expect(helpers.escapeRegExp('Z9')).toEqual('\\x5a9');
			expect(helpers.escapeRegExp(',-=<>#&!%:;@~\'`"')).toEqual('\\x2c\\x2d\\x3d\\x3c\\x3e\\x23\\x26\\x21\\x25\\x3a\\x3b\\x40\\x7e\\x27\\x60\\x22');
			expect(helpers.escapeRegExp('\t\n\v\f\r \u00a0\u2028\u2029\ufeff\u3000')).toEqual('\\t\\n\\v\\f\\r\\x20\\xa0\\u2028\\u2029\\ufeff\\u3000');
			expect(helpers.escapeRegExp('_\ud800_\udc00_\ud83d\ude00')).toEqual('_\\ud800_\\udc00_😀');
			expect(helpers.escapeRegExp('\udc00\ud800')).toEqual('\\udc00\\ud800');
		});

		it('security: is safe inside character classes, with the v flag and after a backreference', function () {
			const forbidden = new RegExp(`[${helpers.escapeRegExp('a-z')}]`);
			expect(
				['a', '-', 'z'].map(function (c) {
					return forbidden.test(c);
				})
			).toEqual([true, true, true]);
			expect(forbidden.test('m')).toBe(false);
			for (const set of ['a&&b', 'a--b', 'a/b', '(a)', '[a]', '{}|\\', '!!##$$%%**++,,..::;;<<==>>??@@^^``~~']) {
				const v = new RegExp(`^[${helpers.escapeRegExp(set)}]+$`, 'v');
				expect({ set, all: v.test(set), other: v.test('q') }).toEqual({ set, all: true, other: false });
			}
			const backreference = new RegExp(`(a)\\1${helpers.escapeRegExp('0')}`);
			expect(backreference.test('aa0')).toBe(true);
			expect(new RegExp(`\\c${helpers.escapeRegExp('J')}`).test('\\cJ')).toBe(true);
		});

		it('should produce patterns that match literally, with and without the u flag', function () {
			const source = 'a.b*(c)[d]{1}|$^\\-/';
			expect(new RegExp(`^${helpers.escapeRegExp(source)}$`).test(source)).toEqual(true);
			expect(new RegExp(`^${helpers.escapeRegExp(source)}$`, 'u').test(source)).toEqual(true);
			expect(new RegExp(helpers.escapeRegExp('a.b')).test('axb')).toEqual(false);
		});
	});

	describe('escapeHtml', function () {
		it('should escape & < > " and \'', function () {
			expect(helpers.escapeHtml('<a href="x">Tom & Jerry\'s</a>')).toEqual('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
		});

		it('should escape already-escaped entities again', function () {
			expect(helpers.escapeHtml('&amp;')).toEqual('&amp;amp;');
		});

		it('should leave safe text untouched', function () {
			expect(helpers.escapeHtml('')).toEqual('');
			expect(helpers.escapeHtml('plain text 😀')).toEqual('plain text 😀');
		});

		it('security: always returns an escaped string, converting other values with String()', function () {
			// e.g. Express parses `?q[]=<script>` into an array
			const query: any = ['<script>alert(1)</script>'];
			expect(helpers.escapeHtml(query)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
			expect(`<p>${helpers.escapeHtml(query)}</p>`).not.toContain('<script>');
			expect(helpers.escapeHtml(['<a>', '"b"'])).toBe('&lt;a&gt;,&quot;b&quot;');
			expect(
				helpers.escapeHtml({
					toString: function () {
						return '<i>';
					}
				})
			).toBe('&lt;i&gt;');
			expect(helpers.escapeHtml(null)).toBe('');
			expect(helpers.escapeHtml(undefined)).toBe('');
			expect(helpers.escapeHtml(42)).toBe('42');
			expect(helpers.escapeHtml(false)).toBe('false');
			expect(function () {
				helpers.escapeHtml(Object.create(null));
			}).toThrow(TypeError);
		});
	});

	describe('unescapeHtml', function () {
		it('should decode the entities produced by escapeHtml and common aliases', function () {
			expect(helpers.unescapeHtml('&lt;b&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;')).toEqual("<b>Tom & Jerry's</b>");
			expect(helpers.unescapeHtml('&quot;&#x27;&#X27;&apos;')).toEqual("\"'''");
		});

		it('should not double-unescape', function () {
			expect(helpers.unescapeHtml('&amp;lt;')).toEqual('&lt;');
			expect(helpers.unescapeHtml('&amp;amp;')).toEqual('&amp;');
			expect(helpers.unescapeHtml('&amp;#39;')).toEqual('&#39;');
		});

		it('should leave unknown or malformed entities untouched', function () {
			expect(helpers.unescapeHtml('&nbsp; &copy; &lt &amp')).toEqual('&nbsp; &copy; &lt &amp');
			expect(helpers.unescapeHtml('')).toEqual('');
		});

		it('always returns a string, converting other values with String()', function () {
			expect(helpers.unescapeHtml(['&lt;b&gt;'] as any)).toBe('<b>');
			expect(helpers.unescapeHtml(null)).toBe('');
			expect(helpers.unescapeHtml(undefined)).toBe('');
			expect(helpers.unescapeHtml(7)).toBe('7');
		});
	});

	describe('normalizeWhitespace', function () {
		it('should trim and collapse whitespace runs', function () {
			expect(helpers.normalizeWhitespace('  hello \n\t world  ')).toEqual('hello world');
			expect(helpers.normalizeWhitespace('a\u00a0\u2003b')).toEqual('a b');
			expect(helpers.normalizeWhitespace('already normal')).toEqual('already normal');
		});

		it('should return an empty string for blank input', function () {
			expect(helpers.normalizeWhitespace('')).toEqual('');
			expect(helpers.normalizeWhitespace(' \n ')).toEqual('');
		});
	});

	describe('interpolate', function () {
		it('security: does not cache templates longer than 1024 characters', function () {
			const set = jest.spyOn(Map.prototype, 'set');
			try {
				const long = `{a}${'x'.repeat(1021)}!`;
				expect(helpers.interpolate(long, { a: 1 })).toBe(`1${'x'.repeat(1021)}!`);
				expect(helpers.interpolate(long.slice(0, -1), { a: 2 })).toBe(`2${'x'.repeat(1021)}`);
				expect(
					set.mock.calls.map(function (call: any[]) {
						return call[0];
					})
				).toEqual([long.slice(0, -1)]);
			} finally {
				set.mockRestore();
			}
		});

		it('should replace simple and nested placeholders', function () {
			expect(helpers.interpolate('Hello {user.name}, you have {count} messages', { user: { name: 'Ada' }, count: 3 })).toEqual('Hello Ada, you have 3 messages');
			expect(helpers.interpolate('{ name }!', { name: 'Bob' })).toEqual('Bob!');
			expect(helpers.interpolate('{items.1}', { items: ['a', 'b'] })).toEqual('b');
			expect(helpers.interpolate('{a}{a}', { a: 'x' })).toEqual('xx');
		});

		it('should stringify values with String()', function () {
			expect(helpers.interpolate('{a} {b} {c} {d} {e}', { a: null, b: false, c: 0, d: [1, 2], e: 10n })).toEqual('null false 0 1,2 10');
		});

		it('should stay correct while more templates alternate than its parse cache holds', function () {
			for (let round = 0; round < 3; round++) {
				for (let i = 0; i < 40; i++) {
					expect(helpers.interpolate(`#${i} {a}-{b.c}`, { a: round, b: { c: i } })).toBe(`#${i} ${round}-${i}`);
				}
			}
		});

		it('should leave missing placeholders untouched', function () {
			expect(helpers.interpolate('Hi {missing}', {})).toEqual('Hi {missing}');
			expect(helpers.interpolate('{user.age}', { user: { name: 'Ada' } })).toEqual('{user.age}');
			expect(helpers.interpolate('{user.name.first}', { user: { name: 'Ada' } })).toEqual('{user.name.first}');
			expect(helpers.interpolate('{a.b}', { a: null })).toEqual('{a.b}');
			expect(helpers.interpolate('{u}', { u: undefined })).toEqual('{u}');
		});

		it('should not read properties of primitive values', function () {
			expect(helpers.interpolate('{name.length} {name.0}', { name: 'Ada' })).toEqual('{name.length} {name.0}');
		});

		it('should apply a template (parsed once) to many values, and alternate between templates', function () {
			for (let round = 0; round < 3; round++) {
				expect(helpers.interpolate('{a}-{b}', { a: round, b: 'x' })).toEqual(`${round}-x`);
				expect(helpers.interpolate('{a}-{b}', { a: 'y' })).toEqual('y-{b}');
				expect(helpers.interpolate('[{b}]', { b: round })).toEqual(`[${round}]`);
			}
		});

		it('should support values whose getters interpolate another template', function () {
			const values = {
				get inner(): string {
					return helpers.interpolate('<{x}>', { x: 1 });
				},
				outer: 2
			};
			expect(helpers.interpolate('{inner} {outer} {inner}', values)).toEqual('<1> 2 <1>');
		});

		it('should not read inherited properties', function () {
			expect(helpers.interpolate('{constructor} {toString} {__proto__}', {})).toEqual('{constructor} {toString} {__proto__}');
		});

		it('should ignore text that is not a placeholder', function () {
			expect(helpers.interpolate('no placeholders', { a: 1 })).toEqual('no placeholders');
			expect(helpers.interpolate('{} { a', { a: 1 })).toEqual('{} { a');
			expect(helpers.interpolate('', {})).toEqual('');
		});
	});

	describe('levenshtein', function () {
		it('should compute classic edit distances', function () {
			expect(helpers.levenshtein('kitten', 'sitting')).toBe(3);
			expect(helpers.levenshtein('flaw', 'lawn')).toBe(2);
			expect(helpers.levenshtein('saturday', 'sunday')).toBe(3);
			expect(helpers.levenshtein('abc', 'abc')).toBe(0);
			expect(helpers.levenshtein('abc', 'xyz')).toBe(3);
		});

		it('should handle empty strings', function () {
			expect(helpers.levenshtein('', '')).toBe(0);
			expect(helpers.levenshtein('', 'abc')).toBe(3);
			expect(helpers.levenshtein('abc', '')).toBe(3);
		});

		it('should be symmetric and handle pure insertions around a common core', function () {
			expect(helpers.levenshtein('sitting', 'kitten')).toBe(3);
			expect(helpers.levenshtein('abc', 'xabcx')).toBe(2);
			expect(helpers.levenshtein('xabcx', 'abc')).toBe(2);
		});

		it('should count code points, not UTF-16 units', function () {
			expect(helpers.levenshtein('😀a', '😃a')).toBe(1);
			expect(helpers.levenshtein('😀', '')).toBe(1);
			expect(helpers.levenshtein('a😀b', 'ab')).toBe(1);
		});
	});

	describe('similarity', function () {
		it('should normalize the distance by the longest length', function () {
			expect(helpers.similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
			expect(helpers.similarity('abcd', 'abce')).toBe(0.75);
			expect(helpers.similarity('abc', 'xyz')).toBe(0);
			expect(helpers.similarity('abc', '')).toBe(0);
		});

		it('should return 1 for equal strings, including two empty strings', function () {
			expect(helpers.similarity('', '')).toBe(1);
			expect(helpers.similarity('same', 'same')).toBe(1);
		});

		it('should count code points', function () {
			expect(helpers.similarity('😀😀', '😀😃')).toBe(0.5);
		});
	});

	describe('dedent', function () {
		it('should remove the common indentation and the surrounding blank lines', function () {
			expect(helpers.dedent('\n    a\n      b\n    c\n')).toBe('a\n  b\nc');
			expect(helpers.dedent('  a\n    b')).toBe('a\n  b');
			expect(helpers.dedent('no indentation\n  here')).toBe('no indentation\n  here');
		});

		it('should only drop one leading and one trailing blank line', function () {
			expect(helpers.dedent('\n\n  a\n\n')).toBe('\na\n');
			expect(helpers.dedent('  \n  a\n  ')).toBe('a');
		});

		it('should ignore blank lines when computing the indentation and empty them', function () {
			expect(helpers.dedent('  a\n\n    b')).toBe('a\n\n  b');
			expect(helpers.dedent('  a\n      \n  b')).toBe('a\n\nb');
			expect(helpers.dedent('  a\n \n  b')).toBe('a\n\nb');
		});

		it('should handle empty and blank input', function () {
			expect(helpers.dedent('')).toBe('');
			expect(helpers.dedent('\n')).toBe('');
			expect(helpers.dedent('   ')).toBe('');
			expect(helpers.dedent('  \n  ')).toBe('');
			expect(helpers.dedent(' \n \n ')).toBe('');
		});

		it('should keep \\r\\n and \\r separators', function () {
			expect(helpers.dedent('\r\n  a\r\n    b\r\n')).toBe('a\r\n  b');
			expect(helpers.dedent('  a\r  b')).toBe('a\rb');
		});

		it('should only remove the longest common prefix of mixed tabs and spaces', function () {
			expect(helpers.dedent('\t\ta\n\t b')).toBe('\ta\n b');
			expect(helpers.dedent('\ta\n b')).toBe('\ta\n b');
		});

		it('should work as a template tag without re-indenting interpolated values', function () {
			const name = 'Ada\n  Lovelace';
			const result = helpers.dedent`
				Hello ${name},
				  welcome ${42}!
			`;
			expect(result).toBe('Hello Ada\n  Lovelace,\n  welcome 42!');
		});

		it('should treat a line holding an interpolation as non-blank and stop its indentation there', function () {
			expect(helpers.dedent`
				a
				${''}
			`).toBe('a\n');
			expect(helpers.dedent`\n    a\n  ${'x'}b\n`).toBe('  a\nxb');
			expect(helpers.dedent`${'x'}
				y`).toBe('x\n\t\t\t\ty');
			expect(helpers.dedent`  ${1}  ${2}`).toBe('1  2');
			// An interpolation ending the text keeps the last line; one starting a line belongs to that line, not the previous one.
			expect(helpers.dedent`\n    a\n    ${'b'}`).toBe('a\nb');
			expect(helpers.dedent`\n  a\n${'  '}\n  b\n`).toBe('  a\n  \n  b');
			// An interpolation inside a `\r\n` belongs to the line before it: the trailing blank line is dropped around it.
			expect(helpers.dedent`a\r${'X'}\n  `).toBe('aX');
			expect(helpers.dedent`\n  a\r${'X'}\n  b\r${'Y'}\n  `).toBe('a\rX\nbY');
		});

		it('should resolve escape sequences in the literal text before dedenting', function () {
			expect(helpers.dedent`\n  a\n    b\n`).toBe('a\n  b');
			expect(helpers.dedent`\x20\x20a`).toBe('a');
		});

		it('should fall back to the raw text for invalid escapes', function () {
			const strings = Object.assign([undefined, 'b'], { raw: ['  \\unicode\n  ', 'b'] }) as any;
			expect(helpers.dedent(strings, 'x')).toBe('\\unicode\nxb');
		});

		it('should stringify values with String()', function () {
			expect(helpers.dedent`${null} ${undefined} ${[1, 2]} ${10n}`).toBe('null undefined 1,2 10');
		});

		it('should throw a TypeError for other inputs', function () {
			expect(function () {
				helpers.dedent(42 as any);
			}).toThrow(TypeError);
		});
	});

	describe('splitLines', function () {
		it('should split on every newline flavour', function () {
			expect(helpers.splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
			expect(helpers.splitLines('a\n\r\nb')).toEqual(['a', '', 'b']);
			expect(helpers.splitLines('a\r\rb')).toEqual(['a', '', 'b']);
		});

		it('should keep empty leading and trailing lines', function () {
			expect(helpers.splitLines('')).toEqual(['']);
			expect(helpers.splitLines('a\n')).toEqual(['a', '']);
			expect(helpers.splitLines('\na')).toEqual(['', 'a']);
		});
	});

	describe('wordWrap', function () {
		it('should wrap greedily on whitespace', function () {
			expect(helpers.wordWrap('The quick brown fox jumps', 10)).toBe('The quick\nbrown fox\njumps');
			expect(helpers.wordWrap('aaa bbb ccc', 7)).toBe('aaa bbb\nccc');
			expect(helpers.wordWrap('a b c', 1)).toBe('a\nb\nc');
		});

		it('should collapse whitespace runs and keep existing line breaks', function () {
			expect(helpers.wordWrap('  a   b\t c  ', 80)).toBe('a b c');
			expect(helpers.wordWrap('a\n\n  b  c ', 80)).toBe('a\n\nb c');
			expect(helpers.wordWrap('a b\r\nc d', 3)).toBe('a b\nc d');
			expect(helpers.wordWrap('', 5)).toBe('');
		});

		it('should neither break at nor replace non-breaking spaces (regression)', function () {
			const nbsp = String.fromCharCode(0xa0);
			const narrow = String.fromCharCode(0x202f);
			const figure = String.fromCharCode(0x2007);
			const zwnbsp = String.fromCharCode(0xfeff);
			const text = `Bonjour${narrow}! Comment allez-vous${nbsp}? 10${narrow}000 et 1${figure}234${zwnbsp}5 euros`;
			expect(helpers.wordWrap(text, 10)).toBe(`Bonjour${narrow}!\nComment\nallez-vous${nbsp}?\n10${narrow}000 et\n1${figure}234${zwnbsp}5\neuros`);
			expect(helpers.wordWrap(`a${nbsp}${nbsp}b`, 2, { breakLongWords: true })).toBe(`a${nbsp}\n${nbsp}b`);
			// The other Unicode spaces still break (and collapse).
			const em = String.fromCharCode(0x2003);
			const ideographic = String.fromCharCode(0x3000);
			expect(helpers.wordWrap(`a${em}b${ideographic}c`, 1)).toBe('a\nb\nc');
		});

		it('should keep long words whole by default', function () {
			expect(helpers.wordWrap('ab abcdefgh cd', 4)).toBe('ab\nabcdefgh\ncd');
		});

		it('should break long words when asked', function () {
			expect(helpers.wordWrap('abcdefghij xy', 4, { breakLongWords: true })).toBe('abcd\nefgh\nij\nxy');
			expect(helpers.wordWrap('abcdefgh', 4, { breakLongWords: true })).toBe('abcd\nefgh');
			expect(helpers.wordWrap('ab abcdefghi c', 4, { breakLongWords: true })).toBe('ab\nabcd\nefgh\ni c');
		});

		it('should use the custom newline', function () {
			expect(helpers.wordWrap('a b c', 3, { newline: '<br>' })).toBe('a b<br>c');
			expect(helpers.wordWrap('a\nb', 3, { newline: '\r\n' })).toBe('a\r\nb');
		});

		it('should measure graphemes', function () {
			expect(helpers.wordWrap('👍🏽👍🏽 👍🏽', 3)).toBe('👍🏽👍🏽\n👍🏽');
			expect(helpers.wordWrap('👍🏽👍🏽👍🏽', 2, { breakLongWords: true })).toBe('👍🏽👍🏽\n👍🏽');
		});

		it('should accept Infinity as a width', function () {
			expect(helpers.wordWrap(' a  b ', Infinity, { breakLongWords: true })).toBe('a b');
		});

		it('should throw a RangeError for invalid widths', function () {
			for (const width of [0, -1, 1.5, NaN, -Infinity]) {
				expect(function () {
					helpers.wordWrap('a', width);
				}).toThrow(RangeError);
			}
		});
	});

	describe('mask', function () {
		it('should reject a non-string char, suffix or newline with a TypeError, like pad', function () {
			expect(function () {
				helpers.mask('abcdef', { char: null as any });
			}).toThrow(new TypeError('mask: `char` must be a string, got null'));
			expect(function () {
				helpers.mask('abcdef', { char: ['#'] as any });
			}).toThrow(TypeError);
			expect(function () {
				helpers.truncate('hello', 2, null as any);
			}).toThrow(new TypeError('truncate: `suffix` must be a string, got null'));
			expect(function () {
				helpers.wordWrap('a b', 1, { newline: null as any });
			}).toThrow(new TypeError('wordWrap: `newline` must be a string, got null'));
		});

		it('should keep the last 4 characters visible by default', function () {
			expect(helpers.mask('4111111111111111')).toBe('************1111');
			expect(helpers.mask('12345')).toBe('*2345');
		});

		it('should support visibleStart, visibleEnd and char', function () {
			expect(helpers.mask('john.doe@mail.com', { visibleStart: 2, visibleEnd: 9, char: '•' })).toBe('jo••••••@mail.com');
			expect(helpers.mask('secret', { visibleEnd: 0 })).toBe('******');
			expect(helpers.mask('secret', { visibleStart: 1, visibleEnd: 1, char: '#' })).toBe('s####t');
			expect(helpers.mask('abc', { visibleEnd: 0, char: '👍🏽' })).toBe('👍🏽👍🏽👍🏽');
		});

		it('security: fails closed, masking everything when the visible parts would reveal the whole string', function () {
			expect(helpers.mask('1234')).toBe('****');
			expect(helpers.mask('123')).toBe('***');
			expect(helpers.mask('1')).toBe('*');
			expect(helpers.mask('')).toBe('');
			expect(helpers.mask('abcd', { visibleStart: 2, visibleEnd: 2 })).toBe('****');
			expect(helpers.mask('abc', { visibleStart: 5, visibleEnd: 0, char: '•' })).toBe('•••');
			expect(helpers.mask('👍🏽é', { visibleEnd: 2 })).toBe('**');
			expect(helpers.mask('abcde', { visibleStart: 2, visibleEnd: 2 })).toBe('ab*de');
		});

		it('should be grapheme-aware', function () {
			expect(helpers.mask('👍🏽👍🏽👍🏽👍🏽👍🏽', { visibleEnd: 1 })).toBe('****👍🏽');
			expect(helpers.mask('e\u0301e\u0301e\u0301', { visibleStart: 1, visibleEnd: 0 })).toBe('e\u0301**');
		});

		it('should throw a RangeError for invalid options', function () {
			const invalid: helpers.MaskOptions[] = [{ visibleStart: -1 }, { visibleStart: 1.5 }, { visibleEnd: -1 }, { visibleEnd: NaN }, { char: '' }, { char: '**' }];
			for (const options of invalid) {
				expect(function () {
					helpers.mask('abcdef', options);
				}).toThrow(RangeError);
			}
		});
	});

	describe('randomString', function () {
		it('should generate strings of the requested length from the default alphanumeric alphabet', function () {
			const value = helpers.randomString(32);
			expect(value).toHaveLength(32);
			expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
			expect(helpers.randomString(0)).toBe('');
		});

		it('should map random() uniformly onto the alphabet', function () {
			const values = [0, 0.25, 0.5, 0.75, 0.999];
			let index = 0;
			function random(): number {
				return values[index++];
			}
			expect(helpers.randomString(5, 'abcd', random)).toBe('abcdd');
			expect(
				helpers.randomString(3, 'ab', function () {
					return 0;
				})
			).toBe('aaa');
		});

		it('should ignore duplicate characters and split by code points', function () {
			expect(
				helpers.randomString(2, 'aab', function () {
					return 0.6;
				})
			).toBe('bb');
			expect(
				helpers.randomString(2, '😀😃', function () {
					return 0.9;
				})
			).toBe('😃😃');
		});

		it('should throw a RangeError for invalid arguments', function () {
			for (const length of [-1, 1.5, NaN, Infinity]) {
				expect(function () {
					helpers.randomString(length);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.randomString(3, '');
			}).toThrow(RangeError);
			for (const bad of [1, -0.1, NaN]) {
				expect(function () {
					helpers.randomString(3, 'ab', function () {
						return bad;
					});
				}).toThrow(RangeError);
			}
		});
	});

	describe('toSentenceCase', function () {
		it('should convert identifiers and text to sentence case', function () {
			expect(helpers.toSentenceCase('helloWorld-foo')).toBe('Hello world foo');
			expect(helpers.toSentenceCase('SOME_CONSTANT_NAME')).toBe('Some constant name');
			expect(helpers.toSentenceCase('XMLHttpRequest')).toBe('Xml http request');
			expect(helpers.toSentenceCase('  the QUICK  brown fox. ')).toBe('The quick brown fox');
		});

		it('should handle unicode and empty input', function () {
			expect(helpers.toSentenceCase('élanVital')).toBe('Élan vital');
			expect(helpers.toSentenceCase('ßa')).toBe('Ssa');
			expect(helpers.toSentenceCase('')).toBe('');
			expect(helpers.toSentenceCase('--- !!')).toBe('');
		});
	});

	describe('pluralize / formatCount', function () {
		it('should pick the singular only for 1 and -1', function () {
			expect(helpers.pluralize(1, 'item')).toBe('item');
			expect(helpers.pluralize(-1, 'item')).toBe('item');
			expect(helpers.pluralize(0, 'item')).toBe('items');
			expect(helpers.pluralize(2, 'item')).toBe('items');
			expect(helpers.pluralize(1.5, 'item')).toBe('items');
			expect(helpers.pluralize(NaN, 'item')).toBe('items');
		});

		it('should support irregular plurals', function () {
			expect(helpers.pluralize(2, 'child', 'children')).toBe('children');
			expect(helpers.pluralize(1, 'child', 'children')).toBe('child');
		});

		it('should format the count with the word', function () {
			expect(helpers.formatCount(3, 'item')).toBe('3 items');
			expect(helpers.formatCount(1, 'item')).toBe('1 item');
			expect(helpers.formatCount(0, 'person', 'people')).toBe('0 people');
			expect(helpers.formatCount(2.5, 'liter')).toBe('2.5 liters');
		});
	});

	describe('ensurePrefix / ensureSuffix / stripPrefix / stripSuffix', function () {
		it('should add a missing prefix or suffix only once', function () {
			expect(helpers.ensurePrefix('example.com', 'https://')).toBe('https://example.com');
			expect(helpers.ensurePrefix('https://example.com', 'https://')).toBe('https://example.com');
			expect(helpers.ensureSuffix('path/to', '/')).toBe('path/to/');
			expect(helpers.ensureSuffix('path/to/', '/')).toBe('path/to/');
			expect(helpers.ensurePrefix('a', '')).toBe('a');
			expect(helpers.ensureSuffix('', 'x')).toBe('x');
		});

		it('should strip a prefix or suffix once', function () {
			expect(helpers.stripPrefix('https://example.com', 'https://')).toBe('example.com');
			expect(helpers.stripPrefix('//a', '/')).toBe('/a');
			expect(helpers.stripPrefix('abc', 'x')).toBe('abc');
			expect(helpers.stripSuffix('report.pdf', '.pdf')).toBe('report');
			expect(helpers.stripSuffix('a//', '/')).toBe('a/');
			expect(helpers.stripSuffix('abc', 'x')).toBe('abc');
			expect(helpers.stripPrefix('abc', '')).toBe('abc');
			expect(helpers.stripSuffix('abc', '')).toBe('abc');
		});
	});

	describe('error messages', function () {
		it('should name the function and the parameter', function () {
			expect(function () {
				helpers.repeat('a', -1);
			}).toThrow(new RangeError('repeat: `times` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.wordWrap('a', 0);
			}).toThrow(new RangeError('wordWrap: `width` must be an integer >= 1 or Infinity, got 0'));
			expect(function () {
				helpers.mask('secret', { visibleStart: 1.5 });
			}).toThrow(new RangeError('mask: `visibleStart` must be an integer >= 0, got 1.5'));
			expect(function () {
				helpers.mask('secret', { visibleEnd: -1 });
			}).toThrow(new RangeError('mask: `visibleEnd` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.mask('secret', { char: '**' });
			}).toThrow(new RangeError('mask: `char` must be exactly one grapheme, got "**"'));
			expect(function () {
				helpers.mask('secret', { char: '*'.repeat(10_000) });
			}).toThrow(new RangeError(`mask: \`char\` must be exactly one grapheme, got "${'*'.repeat(50)}…"`));
			expect(function () {
				helpers.mask('secret', { char: '*'.repeat(50) });
			}).toThrow(new RangeError(`mask: \`char\` must be exactly one grapheme, got "${'*'.repeat(50)}"`));
			expect(function () {
				helpers.randomString(NaN);
			}).toThrow(new RangeError('randomString: `length` must be an integer >= 0, got NaN'));
			expect(function () {
				helpers.randomString(1, '');
			}).toThrow(new RangeError('randomString: `alphabet` must not be empty'));
			expect(function () {
				helpers.randomString(1, 'ab', function () {
					return 1;
				});
			}).toThrow(new RangeError('randomString: `random()` must return a number in [0, 1), got 1'));
			expect(function () {
				helpers.dedent(42 as any);
			}).toThrow(new TypeError('dedent: `input` must be a string or a template strings array, got number'));
		});
	});

	describe('word detection', function () {
		it('should not split before a capitalized word that follows an uncased letter', function () {
			// Only a lower-case letter, a digit or an upper-case run starts a new word before an upper-case letter.
			expect(helpers.toSnakeCase('日本Go')).toBe('日本go');
			expect(helpers.toSnakeCase('Go日本Go')).toBe('go日本go');
			expect(helpers.toKebabCase('xʰAb')).toBe('xʰab');
		});

		it('should start a new word at a title-case letter after a lower-case one', function () {
			expect(helpers.toKebabCase('aǅ')).toBe('a-ǆ');
			expect(helpers.toSnakeCase('xǈ')).toBe('x_ǉ');
		});
	});

	describe('title-case digraphs', function () {
		it('should use the dedicated title-case letter of every Latin digraph', function () {
			expect(helpers.toTitleCase('ǆ Ǆ ǅ ǉ Ǉ ǈ ǌ Ǌ ǋ ǳ Ǳ ǲ')).toBe('ǅ ǅ ǅ ǈ ǈ ǈ ǋ ǋ ǋ ǲ ǲ ǲ');
			expect(helpers.toPascalCase('ǌegoš ǳak')).toBe('ǋegošǲak');
		});
	});

	describe('fast paths (ASCII, Unicode chunks, grapheme regions)', function () {
		it('splits ASCII identifiers with the same rules as Unicode text', function () {
			expect(helpers.toKebabCase('HTTP2 A0B1 aB1C 2Go abcDEF aBCd1E')).toBe('http2-a0b1-a-b1-c-2-go-abc-def-a-b-cd1-e');
			// The same words once a non-ASCII character sends the text down the Unicode path.
			expect(helpers.toKebabCase('HTTP2 A0B1 aB1C 2Go abcDEF aBCd1E é')).toBe('http2-a0b1-a-b1-c-2-go-abc-def-a-b-cd1-e-é');
			expect(helpers.toSnakeCase('XMLHttpRequest é')).toBe('xml_http_request_é');
		});

		it('splits non-ASCII chunks at camelCase and acronym boundaries, keeping marks with their letter', function () {
			expect(helpers.toSnakeCase('helloWörld naïveÜber')).toBe('hello_wörld_naïve_über');
			expect(helpers.toSnakeCase('ÀBCdé')).toBe('àb_cdé');
			// The capital followed by a combining mark still starts the last word of the acronym run.
			expect(helpers.toSnakeCase('xAE\u0301b')).toBe('x_a_e\u0301b');
			// Orphan marks at the start of a chunk belong to the first word.
			expect(helpers.toSnakeCase('\u0301Abc')).toBe('\u0301abc');
			expect(helpers.toSnakeCase('ÉCOLE_NORMALE')).toBe('école_normale');
			// Text without any ASCII character, and chunks whose only inner capital follows a lower-case letter (upper and title case).
			expect(helpers.toSnakeCase('日本語')).toBe('日本語');
			expect(helpers.toCamelCase('ΟΔΟΣ')).toBe('οδος');
			expect(helpers.toSnakeCase('aB é')).toBe('a_b_é');
			expect(helpers.toSnakeCase('aǅb é')).toBe('a_ǆb_é');
		});

		it('lower-cases the joined words exactly like each word on its own (final sigma)', function () {
			expect(helpers.toSnakeCase('ΟΔΟΣ ΑΒ')).toBe('οδος_αβ');
			expect(helpers.toKebabCase('ΟΔΟΣ ΑΒ')).toBe('οδος-αβ');
			expect(helpers.toCamelCase('ΟΔΟΣ ΑΒ')).toBe('οδοςΑβ');
			expect(helpers.toSentenceCase('ΟΔΟΣ ΑΒ')).toBe('Οδος αβ');
			expect(helpers.toSentenceCase('  ')).toBe('');
			expect(helpers.toTitleCase('ΑΣ ΒΓ')).toBe('Ας Βγ');
		});

		it('lower-cases each word on its own when U+FEFF (white space, but case-ignorable) separates them', function () {
			// Lower-casing 'ΑΣ\uFEFFΒ' at once would give a non-final sigma ('ασ\uFEFFβ').
			expect(helpers.toTitleCase('ΑΣ\uFEFFΒ')).toBe('Ας\uFEFFΒ');
		});

		it('only segments the regions that may hold multi-code-unit graphemes', function () {
			expect(helpers.reverse('ab👍🏽cd e\u0301f\r\ng')).toBe('g\r\nfe\u0301 dc👍🏽ba');
			expect(helpers.truncate('日本語'.repeat(1000), 4)).toBe('日本語日...');
			expect(helpers.truncate('e\u0301'.repeat(5), 2)).toBe('e\u0301e\u0301...');
			expect(helpers.truncate('ab' + 'e\u0301'.repeat(3), 4)).toBe('abe\u0301e\u0301...');
			expect(helpers.capitalize('e\u0301cole')).toBe('E\u0301cole');
			expect(helpers.capitalize('\r\nx')).toBe('\r\nx');
			expect(helpers.uncapitalize('É')).toBe('é');
			expect(helpers.mask('ab👍🏽cd👍🏽', { visibleEnd: 1 })).toBe('*****👍🏽');
		});

		it('returns ASCII text unchanged from removeDiacritics and slugs it directly', function () {
			expect(helpers.removeDiacritics('plain ASCII text')).toBe('plain ASCII text');
			expect(helpers.toSlug('Hello, World 2024!')).toBe('hello-world-2024');
		});
	});
});

describe('String helpers (round 11)', function () {
	describe('trimChars / trimStartChars / trimEndChars', function () {
		it('should trim a set of characters, not a substring', function () {
			expect(helpers.trimChars('--hello__', '-_')).toBe('hello');
			expect(helpers.trimChars('abXba', 'ab')).toBe('X');
			expect(helpers.trimChars('abXba', 'ba')).toBe('X');
			expect(helpers.trimStartChars('-_x_-', '-_')).toBe('x_-');
			expect(helpers.trimEndChars('-_x_-', '-_')).toBe('-_x');
			expect(helpers.trimEndChars('1.500', '0')).toBe('1.5');
		});

		it('should accept an array of characters, each split into graphemes', function () {
			expect(helpers.trimChars('-_x_-', ['-', '_'])).toBe('x');
			expect(helpers.trimChars('-_x_-', ['-_'])).toBe('x');
			expect(helpers.trimChars('-x-', [])).toBe('-x-');
		});

		it('should treat regular expression syntax literally', function () {
			expect(helpers.trimChars(']]x]]', ']')).toBe('x');
			expect(helpers.trimChars('^^x^^', '^')).toBe('x');
			expect(helpers.trimChars('\\x\\', '\\')).toBe('x');
			expect(helpers.trimChars('.*x*.', '.*')).toBe('x');
			expect(helpers.trimChars('a-z', 'a-z')).toBe('');
		});

		it('should handle empty inputs', function () {
			expect(helpers.trimChars('', '-')).toBe('');
			expect(helpers.trimChars('---', '-')).toBe('');
			expect(helpers.trimChars('-x-', '')).toBe('-x-');
			expect(helpers.trimStartChars('---', '-')).toBe('');
			expect(helpers.trimEndChars('---', '-')).toBe('');
		});

		it('should compare whole graphemes', function () {
			expect(helpers.trimChars('👍x👍', '👍')).toBe('x');
			expect(helpers.trimChars('👍🏽ok👍', '👍')).toBe('👍🏽ok');
			expect(helpers.trimChars('👍🏽ok👍🏽', '👍🏽')).toBe('ok');
			expect(helpers.trimChars('éxe', 'e')).toBe('éx');
			expect(helpers.trimChars('éxé', 'é')).toBe('x');
			expect(helpers.trimChars('\r\nx\r\n', '\n')).toBe('\r\nx\r\n');
			expect(helpers.trimChars('\r\nx\n\r\n', '\r\n')).toBe('x\n');
			expect(helpers.trimChars('🇫🇷🇩🇪x🇩🇪🇫🇷', '🇫🇷')).toBe('🇩🇪x🇩🇪');
			expect(helpers.trimChars('日本日', '日')).toBe('本');
		});

		it('should mix plain and complex graphemes at the ends', function () {
			expect(helpers.trimChars('-👍-é-x-👍-é-', '-👍é')).toBe('x');
			expect(helpers.trimChars('a👍🏽b', 'ab')).toBe('👍🏽');
			expect(helpers.trimEndChars('x👍🏽-👍', '-👍')).toBe('x👍🏽');
			expect(helpers.trimStartChars('👍🏽👍x', '👍🏽')).toBe('👍x');
		});

		it('should give the same results for many different and long character sets', function () {
			for (let code = 0x61; code < 0x61 + 20; code++) {
				const char = String.fromCharCode(code);
				expect(helpers.trimChars(`${char}${char}x${char}`, char)).toBe('x');
				expect(helpers.trimChars(`${char}${char}x${char}`, char)).toBe('x');
			}
			const long = '-'.repeat(65) + '_';
			expect(helpers.trimChars('-_x_-', long)).toBe('x');
			expect(helpers.trimChars('-_x_-', long)).toBe('x');
		});

		it('should fall back to code points without Intl.Segmenter', function () {
			const fallback = loadWithoutSegmenter();

			expect(fallback.trimChars('👍x👍', '👍')).toBe('x');
			expect(fallback.trimChars('éxe', 'e')).toBe('́x');
		});

		it('should reject chars that are not strings', function () {
			expect(function () {
				helpers.trimChars('x', 5 as any);
			}).toThrow(new TypeError('trimChars: `chars` must be a string or an array of strings, got number'));
			expect(function () {
				helpers.trimStartChars('x', ['-', null] as any);
			}).toThrow(new TypeError('trimStartChars: `chars` must be a string or an array of strings, got null'));
			expect(function () {
				helpers.trimEndChars('x', undefined as any);
			}).toThrow(TypeError);
		});
	});

	describe('toDelimitedCase and the extra case styles', function () {
		it('should share the word splitter of the other case helpers', function () {
			expect(helpers.toTrainCase('XMLHttpRequest2Go')).toBe('Xml-Http-Request2-Go');
			expect(helpers.toDotCase('XMLHttpRequest2Go')).toBe('xml.http.request2.go');
			expect(helpers.toPathCase('XMLHttpRequest2Go')).toBe('xml/http/request2/go');
			expect(helpers.toNoCase('XMLHttpRequest2Go')).toBe('xml http request2 go');
			expect(helpers.toStartCase('XMLHttpRequest2Go')).toBe('Xml Http Request2 Go');
			expect(helpers.toStartCase('iOS17Pro')).toBe('I Os17 Pro');
			expect(helpers.toTrainCase("don't stop")).toBe('Dont-Stop');
			expect(helpers.toStartCase('--foo_bar--')).toBe('Foo Bar');
			expect(helpers.toNoCase('SOME_CONSTANT')).toBe('some constant');
		});

		it('should return an empty string when there are no words', function () {
			for (const fn of [helpers.toTrainCase, helpers.toDotCase, helpers.toPathCase, helpers.toNoCase, helpers.toStartCase]) {
				expect(fn('')).toBe('');
				expect(fn(' -_. ')).toBe('');
			}
		});

		it('should handle Unicode words and title-case letters', function () {
			expect(helpers.toStartCase('crème brûlée')).toBe('Crème Brûlée');
			expect(helpers.toTrainCase('ǆungla straße')).toBe('ǅungla-Straße');
			expect(helpers.toStartCase('ßtraße')).toBe('Sstraße');
		});

		it('should case each word on its own (final sigma before a case-ignorable delimiter)', function () {
			expect(helpers.toDotCase('ΟΔΟΣ ΒΓ')).toBe('οδος.βγ');
			expect(helpers.toDelimitedCase('ΟΔΟΣ ΒΓ', ':')).toBe('οδος:βγ');
			expect(helpers.toDelimitedCase('ab cd', 'X')).toBe('abXcd');
		});

		it('should be locale-independent', function () {
			expect(helpers.toNoCase('TITLE ISTANBUL')).toBe('title istanbul');
		});

		it('should support every word case and any delimiter', function () {
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.')).toBe('xml.http.request');
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.', {})).toBe('xml.http.request');
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.', { case: 'lower' })).toBe('xml.http.request');
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.', { case: 'upper' })).toBe('XML.HTTP.REQUEST');
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.', { case: 'capital' })).toBe('Xml.Http.Request');
			expect(helpers.toDelimitedCase('XMLHttpRequest', '.', { case: 'preserve' })).toBe('XML.Http.Request');
			expect(helpers.toDelimitedCase('user id', ' | ', { case: 'upper' })).toBe('USER | ID');
			expect(helpers.toDelimitedCase('helloWorld', '')).toBe('helloworld');
			expect(helpers.toDelimitedCase('straße', '-', { case: 'upper' })).toBe('STRASSE');
		});

		it('should agree with the existing case helpers', function () {
			const inputs = ['XMLHttpRequest', 'hello world', 'version2Beta', 'SOME_CONSTANT_NAME', 'Crème brûlée', 'ΟΔΟΣ ΑΓΟΡΑΣ'];

			for (const input of inputs) {
				expect(helpers.toDelimitedCase(input, '_')).toBe(helpers.toSnakeCase(input));
				expect(helpers.toDelimitedCase(input, '-')).toBe(helpers.toKebabCase(input));
				expect(helpers.toDelimitedCase(input, '_', { case: 'upper' })).toBe(helpers.toConstantCase(input));
				expect(helpers.toDelimitedCase(input, '', { case: 'capital' })).toBe(helpers.toPascalCase(input));
			}
		});

		it('should validate the delimiter and the case', function () {
			expect(function () {
				helpers.toDelimitedCase('a b', 1 as any);
			}).toThrow(new TypeError('toDelimitedCase: `delimiter` must be a string, got number'));
			expect(function () {
				helpers.toDelimitedCase('a b', '-', { case: 'title' as any });
			}).toThrow(new RangeError("toDelimitedCase: `options.case` must be 'lower', 'upper', 'capital' or 'preserve', got title"));
		});
	});

	describe('padStart / padEnd / padCenter', function () {
		it('should pad plain text like the native methods', function () {
			expect(helpers.padStart('42', 5, '0')).toBe('00042');
			expect(helpers.padStart('42', 5)).toBe('   42');
			expect(helpers.padEnd('Name', 8, '.')).toBe('Name....');
			expect(helpers.padEnd('ab', 7, 'xyz')).toBe('abxyzxy');
			expect(helpers.padStart('ab', 7, 'xyz')).toBe('xyzxyab');
			expect(helpers.padCenter('abc', 8, '_-')).toBe('_-abc_-_');
			expect(helpers.padCenter('abc', 7)).toBe('  abc  ');
			expect(helpers.padCenter('', 3, '*')).toBe('***');
		});

		it('should return the string unchanged when it is already wide enough', function () {
			expect(helpers.padStart('hello', 3)).toBe('hello');
			expect(helpers.padEnd('hello', 5)).toBe('hello');
			expect(helpers.padCenter('hello', 0)).toBe('hello');
			expect(helpers.padCenter('', 0)).toBe('');
			expect(helpers.padStart('👍🏽👍🏽👍🏽', 2)).toBe('👍🏽👍🏽👍🏽');
		});

		it('should count graphemes, not code units', function () {
			expect(helpers.padStart('👍🏽', 3, '*')).toBe('**👍🏽');
			expect(helpers.padEnd('café', 6)).toBe('café  ');
			expect(helpers.padEnd('café', 6)).toBe('café  ');
			expect(helpers.padCenter('👍', 5, '*')).toBe('**👍**');
			expect(helpers.padCenter('日本', 6, '・')).toBe('・・日本・・');
		});

		it('should cut a multi-grapheme fill by graphemes', function () {
			expect(helpers.padStart('x', 4, '👍🏽-')).toBe('👍🏽-👍🏽x');
			expect(helpers.padEnd('x', 3, 'éa')).toBe('xéa');
			expect(helpers.padEnd('x', 4, 'éa')).toBe('xéaé');
			expect(helpers.padCenter('x', 4, '👍🏽')).toBe('👍🏽x👍🏽👍🏽');
		});

		it('should validate the width and the fill', function () {
			expect(function () {
				helpers.padStart('x', -1);
			}).toThrow(new RangeError('padStart: `width` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.padEnd('x', 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.padCenter('x', Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.padCenter('x', '3' as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.padStart('x', 3, '');
			}).toThrow(new RangeError("padStart: `fill` must be a non-empty string, got ''"));
			expect(function () {
				helpers.padEnd('x', 3, 0 as any);
			}).toThrow(new TypeError('padEnd: `fill` must be a non-empty string, got number'));
		});
	});
});

describe('internal tables', function () {
	it('keeps the slug transliteration regex in sync with its table', function () {
		expect(helpers.toSlug('ßæœøđðłþı')).toBe('ssaeoeoddlthi');
	});
});

describe('getWords on non-ASCII text without words', function () {
	it('returns no words for punctuation only', function () {
		expect(helpers.getWords('—…—')).toEqual([]);
		expect(helpers.toSnakeCase('—…—')).toBe('');
		expect(helpers.getWords('é')).toEqual(['é']);
	});
});

describe('strings (helper review regressions)', function () {
	it('isPalindrome and countSubString ignore the case of the Greek sigma', function () {
		expect(helpers.isPalindrome('ΣΟΣ', { ignoreCase: true })).toBe(true);
		expect(helpers.countSubString('ΟΔΟΣ', 'Σ', { ignoreCase: true })).toBe(1);
		expect(helpers.countSubString('ΟΔΟΣ', 'ς', { ignoreCase: true })).toBe(1);
		expect(helpers.isPalindrome('ΣΟΣ')).toBe(true);
		expect(helpers.isPalindrome('σος')).toBe(false);
	});

	it('randomString rejects alphabets with lone surrogates, which could pair up in the result', function () {
		expect(function () {
			helpers.randomString(2, '\udc00\ud83d');
		}).toThrow(new RangeError('randomString: `alphabet` must not contain lone surrogates'));
		expect(Array.from(helpers.randomString(4, 'a🍎'))).toHaveLength(4);
	});
});

describe('Strings helpers (hostile inputs)', function () {
	it('rejects non-string arguments instead of looping or answering wrongly', function () {
		for (const call of [
			function () {
				helpers.countSubString('a1a', 1 as never);
			},
			function () {
				helpers.countSubString('abc', [] as never);
			},
			function () {
				helpers.levenshtein(123 as never, 'abc');
			},
			function () {
				helpers.similarity(123 as never, 456 as never);
			},
			function () {
				helpers.removeDiacritics(null as never);
			},
			function () {
				helpers.isPalindrome(new String('racecar') as never);
			}
		]) {
			expect(call).toThrow(TypeError);
		}
	});

	it('trims the start of long non-Latin text in linear time', function () {
		const started = Date.now();
		expect(helpers.trimStartChars('а'.repeat(40_000) + 'x', 'а')).toBe('x');
		expect(helpers.trimChars('é'.repeat(8_000) + 'x' + 'é'.repeat(8_000), 'é')).toBe('x');
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('ignores a polluted Object.prototype in its escape tables', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto['-'] = '-';
		proto['&#39;'] = '<img>';
		try {
			expect(new RegExp(`[${helpers.escapeRegExp('a-z')}]`).test('m')).toBe(false);
			expect(helpers.unescapeHtml('&#39;')).toBe("'");
		} finally {
			delete proto['-'];
			delete proto['&#39;'];
		}
	});

	it('interpolates values typed as interfaces or class instances', function () {
		interface User {
			name: string;
		}
		const user: User = { name: 'Ada' };
		class Point {
			constructor(readonly x: number) {}
		}
		expect([helpers.interpolate('{name}', user), helpers.interpolate('{x}', new Point(1))]).toEqual(['Ada', '1']);
	});
});

describe('compareNatural', function () {
	function sorted(list: string[], options?: helpers.CompareNaturalOptions): string[] {
		return list.slice().sort(function (a, b) {
			return helpers.compareNatural(a, b, options);
		});
	}

	it('should compare runs of digits by numeric value', function () {
		expect(sorted(['file10.txt', 'file2.txt', 'file1.txt'])).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
		expect(sorted(['v1.10', 'v1.9', 'v1.9.1', 'v1.2.10', 'v1.2.9'])).toEqual(['v1.2.9', 'v1.2.10', 'v1.9', 'v1.9.1', 'v1.10']);
		expect(sorted(['x100y2', 'x100y10', 'x20y5'])).toEqual(['x20y5', 'x100y2', 'x100y10']);
		expect(helpers.compareNatural('img12.png', 'img2.png')).toBe(1);
		expect(helpers.compareNatural('img2.png', 'img12.png')).toBe(-1);
		expect(helpers.compareNatural('a2', 'a2')).toBe(0);
	});

	it('should compare digit runs of any length exactly', function () {
		expect(helpers.compareNatural('9007199254740993', '9007199254740992')).toBe(1);
		expect(helpers.compareNatural('id-18446744073709551616', 'id-18446744073709551615')).toBe(1);
		const big = '9'.repeat(400);
		expect(helpers.compareNatural(big + '8', big + '9')).toBe(-1);
		expect(helpers.compareNatural('1' + '0'.repeat(400), big)).toBe(1);
	});

	it('should tie numbers that only differ in leading zeros, then put zero-padded ones first', function () {
		expect(sorted(['1', '01', '001', '2', '0', '00', '000'])).toEqual(['0', '00', '000', '001', '01', '1', '2']);
		expect(sorted(['a1b02', 'a01b2', 'a1b2'])).toEqual(['a01b2', 'a1b02', 'a1b2']);
		expect(helpers.compareNatural('a01', 'a1')).toBe(-1);
		expect(helpers.compareNatural('a1', 'a01')).toBe(1);
		// The tie only matters when nothing else differs.
		expect(helpers.compareNatural('a01b', 'a1a')).toBe(1);
		expect(helpers.compareNatural('0010', '9')).toBe(1);
	});

	it('should place digits where their code units are: after spaces and most punctuation, before letters', function () {
		expect(sorted(['a', 'a-1', 'a 1', 'a1', 'aa', 'a.1', 'aA'])).toEqual(['a', 'a 1', 'a-1', 'a.1', 'a1', 'aA', 'aa']);
		expect(sorted(['10', '9', 'a', '_', '~', '-'])).toEqual(['-', '9', '10', '_', 'a', '~']);
		expect(helpers.compareNatural('', 'a')).toBe(-1);
		expect(helpers.compareNatural('0', '')).toBe(1);
		expect(helpers.compareNatural('', '')).toBe(0);
	});

	it('should sort a prefix first', function () {
		expect(helpers.compareNatural('file', 'file1')).toBe(-1);
		expect(helpers.compareNatural('file1', 'file')).toBe(1);
		expect(helpers.compareNatural('file1', 'file1a')).toBe(-1);
		expect(helpers.compareNatural('file01', 'file1a')).toBe(-1);
	});

	it('should compare by UTF-16 code units by default, case-insensitively with ignoreCase', function () {
		expect(sorted(['b', 'A2', 'a10', 'a2', 'B1'])).toEqual(['A2', 'B1', 'a2', 'a10', 'b']);
		expect(sorted(['b', 'A2', 'a10', 'a2', 'B1'], { ignoreCase: true })).toEqual(['A2', 'a2', 'a10', 'b', 'B1']);
		expect(sorted(['file', 'File', 'FILE', 'fILE'], { ignoreCase: true })).toEqual(['FILE', 'File', 'fILE', 'file']);
		expect(helpers.compareNatural('File', 'file', { ignoreCase: true })).toBe(-1);
		expect(helpers.compareNatural('file', 'File', { ignoreCase: true })).toBe(1);
		expect(helpers.compareNatural('ÉCOLE2', 'école10', { ignoreCase: true })).toBe(-1);
		expect(helpers.compareNatural('a', 'B', { ignoreCase: false })).toBe(1);
		// Lower-casing can change the length (İ becomes i + a combining dot): the folded strings are compared as they are.
		expect(helpers.compareNatural('İ2', 'i\u030710', { ignoreCase: true })).toBe(-1);
		expect(helpers.compareNatural('\u{1F600}', '\uffff')).toBe(-1);
		// Regression: a final sigma folds like any sigma, as in the other ignoreCase options (toLowerCase alone gave -1).
		expect(helpers.compareNatural('ΑΣ1', 'ασ0', { ignoreCase: true })).toBe(1);
		expect(helpers.compareNatural('ας1', 'ασ0', { ignoreCase: true })).toBe(1);
		expect(helpers.compareNatural('ας', 'ασ', { ignoreCase: true })).toBe(-1);
	});

	it('should be a total order: only equal strings compare equal', function () {
		const list = ['a1', 'a01', 'A1', 'a001', 'a1 ', 'a1b', 'a', ''];
		for (const a of list) {
			for (const b of list) {
				const order = helpers.compareNatural(a, b, { ignoreCase: true });
				expect(order === 0).toBe(a === b);
				expect(order).toBe(-helpers.compareNatural(b, a, { ignoreCase: true }) || 0);
			}
		}
	});

	it('should throw a TypeError for non-strings', function () {
		expect(function () {
			helpers.compareNatural(1 as never, 'a');
		}).toThrow(new TypeError('compareNatural: `a` must be a string, got number'));
		expect(function () {
			helpers.compareNatural('a', undefined as never);
		}).toThrow(new TypeError('compareNatural: `b` must be a string, got undefined'));
		expect(function () {
			[1, 'b'].sort(helpers.compareNatural as never);
		}).toThrow(TypeError);
	});

	it('should stay linear on long digit runs and long strings', function () {
		const a = '1'.repeat(1_000_000);
		const b = '1'.repeat(999_999) + '2';
		const start = performance.now();
		expect(helpers.compareNatural(a, b)).toBe(-1);
		expect(helpers.compareNatural('0'.repeat(1_000_000) + 'x', '0'.repeat(1_000_000) + 'y')).toBe(-1);
		expect(helpers.compareNatural('a'.repeat(1_000_000), 'a'.repeat(1_000_000) + 'b', { ignoreCase: true })).toBe(-1);
		expect(performance.now() - start).toBeLessThan('__stryker__' in globalThis ? Infinity : 2000);
	});
});

describe('truncateMiddle', function () {
	const path = '/Users/ada/projects/tinkit/src/index.ts';

	it('should keep `length` graphemes, half from each end, the odd one at the end', function () {
		expect(helpers.truncateMiddle(path, 24)).toBe('/Users/ada/p…src/index.ts');
		expect(helpers.truncateMiddle('abcdefghij', 5)).toBe('ab…hij');
		expect(helpers.truncateMiddle('abcdefghij', 4)).toBe('ab…ij');
		expect(helpers.truncateMiddle('abcdefghij', 1)).toBe('…j');
		expect(helpers.truncateMiddle('abcdefghij', 0)).toBe('…');
	});

	it('should return strings of at most `length` graphemes unchanged', function () {
		expect(helpers.truncateMiddle('short', 10)).toBe('short');
		expect(helpers.truncateMiddle('short', 5)).toBe('short');
		expect(helpers.truncateMiddle('', 0)).toBe('');
		// 8 code units, but 2 graphemes.
		expect(helpers.truncateMiddle('👍🏽👍🏽', 3)).toBe('👍🏽👍🏽');
		expect(helpers.truncateMiddle('👍🏽👍🏽', 2)).toBe('👍🏽👍🏽');
	});

	it('should move the cut with `position`', function () {
		expect(helpers.truncateMiddle(path, 12, { position: 0 })).toBe('…src/index.ts');
		expect(helpers.truncateMiddle(path, 12, { position: 1 })).toBe('/Users/ada/p…');
		expect(helpers.truncateMiddle('abcdefghij', 4, { position: 0.25 })).toBe('a…hij');
		expect(helpers.truncateMiddle('abcdefghij', 4, { position: 0.74 })).toBe('ab…ij');
		expect(helpers.truncateMiddle('abcdefghij', 4, { position: 0.75 })).toBe('abc…j');
	});

	it('should not lose a grapheme to the rounding error of length * position', function () {
		// Regression: 100 * 0.29 is 28.999999999999996, which was rounded down to 28.
		const text = 'x'.repeat(200);
		expect(helpers.truncateMiddle(text, 100, { position: 0.29 }).indexOf('…')).toBe(29);
		expect(helpers.truncateMiddle(text, 100, { position: 0.57 }).indexOf('…')).toBe(57);
		expect(helpers.truncateMiddle(text, 100, { position: 0.575 }).indexOf('…')).toBe(57);
		for (let percent = 0; percent <= 100; percent++) {
			expect(helpers.truncateMiddle(text, 100, { position: percent / 100 }).indexOf('…')).toBe(percent);
		}
		expect(helpers.truncateMiddle(text, 3, { position: 1 / 3 })).toBe('x…xx');
	});

	it('should only split the ends of long strings', function () {
		// Regression: the whole string was split into graphemes (50 million code units kept 20 in about half a second and 1.2 GB).
		const start = performance.now();
		const ascii = 'a'.repeat(2_000_000) + 'z';
		expect(helpers.truncateMiddle(ascii, 4)).toBe('aa…az');
		const kana = 'カ'.repeat(2_000_000) + 'ナ';
		expect(helpers.truncateMiddle(kana, 4)).toBe('カカ…カナ');
		const emoji = '👍🏽'.repeat(500_000) + '👍';
		expect(helpers.truncateMiddle(emoji, 4)).toBe('👍🏽👍🏽…👍🏽👍');
		const flags = '中' + '🇯🇵'.repeat(500_000);
		expect(helpers.truncateMiddle(flags, 3)).toBe('中…🇯🇵🇯🇵');
		const mixed = 'é' + 'e\u0301'.repeat(1_000_000) + '각';
		expect(helpers.truncateMiddle(mixed, 3)).toBe('é…e\u0301각');
		// Clusters longer than the first window: the window grows.
		const accented = ('a' + '\u0301'.repeat(40)).repeat(5);
		expect(helpers.truncateMiddle(accented, 2)).toBe('a' + '\u0301'.repeat(40) + '…a' + '\u0301'.repeat(40));
		expect(performance.now() - start).toBeLessThan('__stryker__' in globalThis ? Infinity : 2000);
	});

	it('should find the graphemes at the end of text without plain characters by splitting it all', function () {
		// Thai: no pair of characters where a boundary is certain without looking back.
		const thai = 'กำ'.repeat(1000) + 'ก';
		expect(helpers.truncateMiddle(thai, 3)).toBe('กำ…กำก');
		// A run of regional indicators pairs from its start: the last flag depends on the parity of the whole run.
		const odd = 'a' + '🇯🇵'.repeat(100) + '🇫';
		expect(helpers.truncateMiddle(odd, 2)).toBe('a…🇫');
		expect(helpers.truncateMiddle('🇯' + odd.slice(1), 2, { position: 0 })).toBe('…🇵🇯🇵🇫');
		// A ZWJ sequence longer than the first window.
		const family = 'ab' + '👨\u200d'.repeat(100) + '👧';
		expect(helpers.truncateMiddle(family, 2)).toBe('a…' + family.slice(2));
	});

	it('should match truncate at position 1', function () {
		expect(helpers.truncateMiddle('hello world', 5, { position: 1, ellipsis: '...' })).toBe(helpers.truncate('hello world', 5));
		expect(helpers.truncateMiddle('👍🏽👍🏽👍🏽', 1, { position: 1, ellipsis: '...' })).toBe(helpers.truncate('👍🏽👍🏽👍🏽', 1));
	});

	it('should use the given ellipsis, which is not counted', function () {
		expect(helpers.truncateMiddle('0x71C7656EC7ab88b098defB751B7401B5f6d8976F', 10, { ellipsis: '...' })).toBe('0x71C...8976F');
		expect(helpers.truncateMiddle('abcdefghij', 4, { ellipsis: '' })).toBe('abij');
		expect(helpers.truncateMiddle('abcdefghij', 4, { ellipsis: ' [...] ' })).toBe('ab [...] ij');
	});

	it('should never split a grapheme cluster', function () {
		expect(helpers.truncateMiddle('👍🏽👍🏽👍🏽👍🏽', 2)).toBe('👍🏽…👍🏽');
		expect(helpers.truncateMiddle('e\u0301e\u0301e\u0301e\u0301e\u0301', 2)).toBe('e\u0301…e\u0301');
		expect(helpers.truncateMiddle('🇯🇵🇫🇷🇩🇪🇮🇹', 3)).toBe('🇯🇵…🇩🇪🇮🇹');
		expect(helpers.truncateMiddle('👨\u200d👩\u200d👧 family 👨\u200d👩\u200d👧', 2)).toBe('👨\u200d👩\u200d👧…👨\u200d👩\u200d👧');
		expect(helpers.truncateMiddle('ab\r\ncd\r\nef', 4)).toBe('ab…ef');
	});

	it('should cut code points without Intl.Segmenter', function () {
		const fallback = loadWithoutSegmenter();
		expect(fallback.truncateMiddle('😀😁😂🤣😃', 2)).toBe('😀…😃');
		expect(fallback.truncateMiddle('😀😁', 2)).toBe('😀😁');
	});

	it('should validate its arguments', function () {
		expect(function () {
			helpers.truncateMiddle(42 as never, 2);
		}).toThrow(new TypeError('truncateMiddle: `string` must be a string, got number'));
		expect(function () {
			helpers.truncateMiddle('abc', -1);
		}).toThrow(new RangeError('truncateMiddle: `length` must be an integer >= 0, got -1'));
		expect(function () {
			helpers.truncateMiddle('abc', 1.5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.truncateMiddle('abc', '2' as never);
		}).toThrow(TypeError);
		expect(function () {
			helpers.truncateMiddle('abc', 2, { ellipsis: null as never });
		}).toThrow(new TypeError('truncateMiddle: `ellipsis` must be a string, got null'));
		for (const position of [-0.1, 1.1, NaN, Infinity]) {
			expect(function () {
				helpers.truncateMiddle('abc', 2, { position });
			}).toThrow(new RangeError(`truncateMiddle: \`position\` must be a number between 0 and 1, got ${position}`));
		}
		expect(function () {
			helpers.truncateMiddle('abc', 2, { position: '0.5' as never });
		}).toThrow(new TypeError('truncateMiddle: `position` must be a number between 0 and 1, got string'));
	});
});

/**
 * The code points that are East Asian Wide (W) or Fullwidth (F) in EastAsianWidth-17.0.0.txt, merged into ranges, as hex.
 * Generated from https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt (independently of the compressed table in the module).
 */
const EAST_ASIAN_WIDE_17 =
	'1100-115f 231a-231b 2329-232a 23e9-23ec 23f0 23f3 25fd-25fe 2614-2615 2630-2637 2648-2653 267f 268a-268f 2693 26a1 ' +
	'26aa-26ab 26bd-26be 26c4-26c5 26ce 26d4 26ea 26f2-26f3 26f5 26fa 26fd 2705 270a-270b 2728 274c 274e 2753-2755 2757 ' +
	'2795-2797 27b0 27bf 2b1b-2b1c 2b50 2b55 2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-303e 3041-3096 3099-30ff 3105-312f 3131-318e ' +
	'3190-31e5 31ef-321e 3220-3247 3250-a48c a490-a4c6 a960-a97c ac00-d7a3 f900-faff fe10-fe19 fe30-fe52 fe54-fe66 fe68-fe6b ' +
	'ff01-ff60 ffe0-ffe6 16fe0-16fe4 16ff0-16ff6 17000-18cd5 18cff-18d1e 18d80-18df2 1aff0-1aff3 1aff5-1affb 1affd-1affe ' +
	'1b000-1b122 1b132 1b150-1b152 1b155 1b164-1b167 1b170-1b2fb 1d300-1d356 1d360-1d376 1f004 1f0cf 1f18e 1f191-1f19a ' +
	'1f200-1f202 1f210-1f23b 1f240-1f248 1f250-1f251 1f260-1f265 1f300-1f320 1f32d-1f335 1f337-1f37c 1f37e-1f393 1f3a0-1f3ca ' +
	'1f3cf-1f3d3 1f3e0-1f3f0 1f3f4 1f3f8-1f43e 1f440 1f442-1f4fc 1f4ff-1f53d 1f54b-1f54e 1f550-1f567 1f57a 1f595-1f596 1f5a4 ' +
	'1f5fb-1f64f 1f680-1f6c5 1f6cc 1f6d0-1f6d2 1f6d5-1f6d8 1f6dc-1f6df 1f6eb-1f6ec 1f6f4-1f6fc 1f7e0-1f7eb 1f7f0 1f90c-1f93a ' +
	'1f93c-1f945 1f947-1f9ff 1fa70-1fa7c 1fa80-1fa8a 1fa8e-1fac6 1fac8 1facd-1fadc 1fadf-1faea 1faef-1faf8 20000-2fffd ' +
	'30000-3fffd';

describe('stringWidth', function () {
	it('should count printable ASCII as one column per character', function () {
		expect(helpers.stringWidth('')).toBe(0);
		expect(helpers.stringWidth('hello')).toBe(5);
		expect(helpers.stringWidth(' ~!@#$%^&*()_+')).toBe(14);
	});

	it('should count East Asian Wide and Fullwidth characters as two columns', function () {
		expect(helpers.stringWidth('古池や')).toBe(6);
		expect(helpers.stringWidth('한국어')).toBe(6);
		expect(helpers.stringWidth('ＡＢＣ１２３')).toBe(12);
		expect(helpers.stringWidth('カタカナ')).toBe(8);
		expect(helpers.stringWidth('a中b')).toBe(4);
		expect(helpers.stringWidth('\u{20000}\u{30000}')).toBe(4);
		expect(helpers.stringWidth('　')).toBe(2);
	});

	it('should count halfwidth forms, ambiguous and other narrow characters as one column', function () {
		expect(helpers.stringWidth('ｶﾀｶﾅ')).toBe(4);
		expect(helpers.stringWidth('±×÷§')).toBe(4);
		expect(helpers.stringWidth('Ωαβγ')).toBe(4);
		expect(helpers.stringWidth('Привет')).toBe(6);
		expect(helpers.stringWidth('é')).toBe(1);
		expect(helpers.stringWidth('←─●')).toBe(3);
	});

	it('should count emoji and emoji sequences as two columns', function () {
		expect(helpers.stringWidth('👍')).toBe(2);
		expect(helpers.stringWidth('👍🏽')).toBe(2);
		expect(helpers.stringWidth('☝🏽')).toBe(2);
		expect(helpers.stringWidth('👨\u200d👩\u200d👧')).toBe(2);
		expect(helpers.stringWidth('🧑🏽\u200d🚀')).toBe(2);
		expect(helpers.stringWidth('❤\u200d🔥')).toBe(2);
		expect(helpers.stringWidth('👁\ufe0f\u200d🗨\ufe0f')).toBe(2);
		expect(helpers.stringWidth('🇯🇵🇫🇷')).toBe(4);
		expect(helpers.stringWidth('🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}')).toBe(2);
		expect(helpers.stringWidth('1\ufe0f\u20e3#\u20e3*\ufe0f\u20e3')).toBe(6);
		expect(helpers.stringWidth('❤\ufe0f©\ufe0f↔\ufe0f')).toBe(6);
		expect(helpers.stringWidth('⌚')).toBe(2);
		expect(helpers.stringWidth('⌚\ufe0e')).toBe(2);
		expect(helpers.stringWidth('\u{1fae9}\u{1faea}')).toBe(4);
		expect(helpers.stringWidth('🏽')).toBe(2);
	});

	it('should count text-style symbols and partial sequences as one column', function () {
		expect(helpers.stringWidth('❤')).toBe(1);
		expect(helpers.stringWidth('©®')).toBe(2);
		expect(helpers.stringWidth('🇯')).toBe(1);
		expect(helpers.stringWidth('1\ufe0f')).toBe(1);
		expect(helpers.stringWidth('❤🏽')).toBe(1);
		expect(helpers.stringWidth('©🏽')).toBe(1);
		expect(helpers.stringWidth('❤\u200d')).toBe(1);
		expect(helpers.stringWidth('a\u20e3')).toBe(1);
	});

	it('should count every pair of regional indicators as a flag', function () {
		// string-width only counts the pairs that are country flags (2), and others as 1.
		expect(helpers.stringWidth('🇦🇦')).toBe(2);
		expect(helpers.stringWidth('🇯🇵🇯')).toBe(3);
	});

	it('should count combining marks, zero-width and default-ignorable characters as zero columns', function () {
		expect(helpers.stringWidth('e\u0301')).toBe(1);
		expect(helpers.stringWidth('\u0301')).toBe(0);
		expect(helpers.stringWidth('a\u0301\u0302\u0303')).toBe(1);
		expect(helpers.stringWidth('a\u200bb')).toBe(2);
		expect(helpers.stringWidth('\u200b\u200c\u200d\u2060\ufeff')).toBe(0);
		expect(helpers.stringWidth('a\ufe0f')).toBe(1);
		expect(helpers.stringWidth('\u00ad')).toBe(0);
		expect(helpers.stringWidth('\u202e\u2066abc\u2069')).toBe(3);
		expect(helpers.stringWidth('\u{e0001}\u{e0067}')).toBe(0);
		expect(helpers.stringWidth('\u0600١')).toBe(1);
		expect(helpers.stringWidth('\u3164')).toBe(0);
		expect(helpers.stringWidth('\u302a')).toBe(0);
	});

	it('should count control characters, tabs and line breaks as zero columns', function () {
		expect(helpers.stringWidth('a\tb')).toBe(2);
		expect(helpers.stringWidth('line 1\nline 2\r\n')).toBe(12);
		expect(helpers.stringWidth('\0\x07\x7f\x80\x9f')).toBe(0);
	});

	it('should add a column for each spacing mark and halfwidth form in a cluster', function () {
		expect(helpers.stringWidth('कि')).toBe(2);
		expect(helpers.stringWidth('क्षि')).toBe(2);
		expect(helpers.stringWidth('ｶﾞ')).toBe(2);
		expect(helpers.stringWidth('ﾞ')).toBe(1);
		expect(helpers.stringWidth('👨\ufe0fﾞ')).toBe(3);
		// A wide spacing mark (a Hangul tone mark) adds two columns.
		expect(helpers.stringWidth('각\u302e')).toBe(4);
		expect(helpers.stringWidth('a\u302e')).toBe(3);
	});

	it('should count a Hangul syllable as two columns, precomposed or of conjoining jamo', function () {
		expect(helpers.stringWidth('각')).toBe(2);
		expect(helpers.stringWidth('\u1100\u1161\u11a8')).toBe(2);
		expect(helpers.stringWidth('\u1100\u1161\u1100\u1161\u11a8')).toBe(4);
		expect(helpers.stringWidth('\u1161')).toBe(1);
		expect(helpers.stringWidth('\u115f\u1161')).toBe(1);
		expect(helpers.stringWidth('\ua960\ud7b0\ud7cb')).toBe(2);
	});

	it('should count unpaired conjoining jamo by their own width, like string-width', function () {
		// Regression: a whole cluster of jamo counted as one syllable (a million leading consonants were 2 columns).
		expect(helpers.stringWidth('\u1100'.repeat(1000))).toBe(2000);
		expect(helpers.stringWidth('\u1100\u1100하')).toBe(6);
		expect(helpers.stringWidth('\u1100\u1100\u1161')).toBe(4);
		expect(helpers.stringWidth('\u1161\u11a8')).toBe(2);
		expect(helpers.stringWidth('\u1100\u1161\u1161')).toBe(3);
		expect(helpers.stringWidth('\u11a8🏽')).toBe(3);
		expect(helpers.stringWidth('\u1161ำ')).toBe(2);
		expect(helpers.stringWidth('\u1100\u0301\u1161')).toBe(3);
	});

	it('should count lone surrogates as zero columns', function () {
		expect(helpers.stringWidth('\ud800')).toBe(0);
		expect(helpers.stringWidth('a\udc00b')).toBe(2);
	});

	it('should ignore ANSI escape sequences', function () {
		expect(helpers.stringWidth('\x1b[31mred\x1b[39m')).toBe(3);
		expect(helpers.stringWidth('\x1b[1;38;2;255;0;0m古\x1b[0m')).toBe(2);
		expect(helpers.stringWidth('\x1b[?25l\x1b[2K\x1b[1G')).toBe(0);
		expect(helpers.stringWidth('\x9b31mx\x9b0m')).toBe(1);
		expect(helpers.stringWidth('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe(4);
		expect(helpers.stringWidth('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')).toBe(4);
		expect(helpers.stringWidth('\x1b]0;window title\x9cx')).toBe(1);
		expect(helpers.stringWidth('\x1bP+q544e\x1b\\ok')).toBe(2);
		expect(helpers.stringWidth('\x1b(Bx\x1b7y\x1b8\x1bc')).toBe(2);
		expect(helpers.stringWidth('\x1b[ q')).toBe(0);
	});

	it('should keep the text after a malformed or unterminated sequence', function () {
		// The escape character itself is a zero-width control.
		expect(helpers.stringWidth('ab\x1b')).toBe(2);
		expect(helpers.stringWidth('\x1b[\x00x')).toBe(1);
		expect(helpers.stringWidth('\x1bé')).toBe(1);
	});

	it('should end a control string where terminals do', function () {
		// Regression: an ESC inside an OSC cancels it; its text was counted.
		expect(helpers.stringWidth('\x1b]0;title\x1b[31m\x07X')).toBe(1);
		expect(helpers.stringWidth('\x1b]0;title\x1b7Y')).toBe(1);
		// ESC X starts another control string (SOS), unterminated here.
		expect(helpers.stringWidth('\x1b]0;title\x1bXY')).toBe(0);
		expect(helpers.stringWidth('\x1b]0;title\x18Y')).toBe(1);
		expect(helpers.stringWidth('\x1bPq#0\x1aY')).toBe(1);
		// Unterminated: a terminal waits for the rest, so nothing after it is shown.
		expect(helpers.stringWidth('ok\x1b]8;;url')).toBe(2);
		expect(helpers.stringWidth('ok\x1b[31')).toBe(2);
		expect(helpers.stringWidth('ok\x9b')).toBe(2);
		expect(helpers.stringWidth('\x1b[31')).toBe(0);
	});

	it('should measure code points one by one without Intl.Segmenter', function () {
		const fallback = loadWithoutSegmenter();
		expect(fallback.stringWidth('👨\u200d👩\u200d👧')).toBe(6);
		expect(fallback.stringWidth('e\u0301中')).toBe(3);
		expect(fallback.stringWidth('hello')).toBe(5);
	});

	it('should give every code point its Unicode 17 width (exhaustive)', function () {
		const wide = EAST_ASIAN_WIDE_17.split(' ').map(function (range) {
			const [start, end = start] = range.split('-');
			return [parseInt(start, 16), parseInt(end, 16)];
		});
		const zeroWidth = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/u;
		const assigned = /\P{Cn}/u;
		const mismatches: string[] = [];
		let range = 0;
		for (let code = 0; code <= 0x10ffff; code++) {
			if (code >= 0xd800 && code <= 0xdfff) continue;
			while (range < wide.length - 1 && wide[range][1] < code) range++;
			const char = String.fromCodePoint(code);
			const isWide = code >= wide[range][0] && code <= wide[range][1];
			const width = helpers.stringWidth(char);
			// Unassigned code points between wide ones count as wide (they are reserved for ideographs and emoji): either is fine.
			const expected = zeroWidth.test(char) ? 0 : isWide ? 2 : assigned.test(char) ? 1 : width;
			if (width !== expected) mismatches.push(`U+${code.toString(16)}: ${width}, expected ${expected}`);
		}
		expect(mismatches).toEqual([]);
	});

	it('should only count unassigned code points as wide inside the wide blocks', function () {
		expect(helpers.stringWidth('\u{1f6d9}')).toBe(2);
		expect(helpers.stringWidth('\u{3fffe}')).toBe(1);
		expect(helpers.stringWidth('\u{50000}')).toBe(1);
		expect(helpers.stringWidth('\u{10fffd}')).toBe(1);
	});

	it('should throw a TypeError for a non-string', function () {
		expect(function () {
			helpers.stringWidth(42 as never);
		}).toThrow(new TypeError('stringWidth: `string` must be a string, got number'));
		expect(function () {
			helpers.stringWidth(null as never);
		}).toThrow(new TypeError('stringWidth: `string` must be a string, got null'));
	});

	it('should stay linear on hostile input', function () {
		const start = performance.now();
		expect(helpers.stringWidth('a' + '\u0301'.repeat(100_000))).toBe(1);
		expect(helpers.stringWidth('\x1b]'.repeat(50_000))).toBe(0);
		expect(helpers.stringWidth('\x1b]0;' + 'x'.repeat(100_000))).toBe(0);
		expect(helpers.stringWidth('\x1b]0;' + 'x'.repeat(100_000) + '\x07z')).toBe(1);
		expect(helpers.stringWidth('\x1b[' + '1;'.repeat(50_000))).toBe(0);
		expect(helpers.stringWidth('\x1b[' + '1;'.repeat(50_000) + '\x00z')).toBe(100_001);
		expect(helpers.stringWidth('\u1100'.repeat(100_000))).toBe(200_000);
		expect(helpers.stringWidth('\x9b\x9b'.repeat(50_000))).toBe(0);
		expect(helpers.stringWidth('क' + 'ि'.repeat(50_000))).toBe(50_001);
		expect(helpers.stringWidth('👍'.repeat(50_000))).toBe(100_000);
		expect(performance.now() - start).toBeLessThan(5000);
	});
});

describe('String helpers under prototype pollution', function () {
	it('read their options as own properties only', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		Object.assign(polluted, { ellipsis: '<EVIL>', position: 0, ignoreCase: true, visibleEnd: 0, char: '#', breakLongWords: true, case: 'upper' });
		try {
			expect(helpers.truncateMiddle('abcdefghij', 5)).toBe('ab…hij');
			expect(helpers.compareNatural('a', 'B')).toBe(1);
			expect(helpers.compareNatural('a', 'B', {})).toBe(1);
			expect(function () {
				helpers.compareNatural('a', 'B', null as unknown as object);
			}).toThrow(TypeError);
			expect(helpers.compareNatural('a', 'B', { ignoreCase: true })).toBe(-1);
			expect(helpers.mask('12345678')).toBe('****5678');
			expect(helpers.wordWrap('abcdefghij', 4)).toBe('abcdefghij');
			expect(helpers.toDelimitedCase('helloWorld', '-')).toBe('hello-world');
		} finally {
			for (const key of ['ellipsis', 'position', 'ignoreCase', 'visibleEnd', 'char', 'breakLongWords', 'case']) delete polluted[key];
		}
	});

	it('read the options of the text helpers as own properties only', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		Object.assign(polluted, { suffix: '<EVIL>', separator: 'x', lowercase: false, replacements: { a: 'b' }, indent: '#', includeEmptyLines: true, replacement: '' });
		polluted.maxLength = 3;
		try {
			expect(helpers.truncate('hello world', 7, {})).toBe('hello w...');
			expect(helpers.toSlug('A b')).toBe('a-b');
			expect(helpers.toSlug('A b', {})).toBe('a-b');
			expect(helpers.indent('a\n\nb', 1)).toBe(' a\n\n b');
			expect(helpers.toSafeFilename('a/b.txt')).toBe('a_b.txt');
		} finally {
			for (const key of ['suffix', 'separator', 'lowercase', 'replacements', 'indent', 'includeEmptyLines', 'replacement', 'maxLength']) delete polluted[key];
		}
	});

	it('dedent inserts undefined for a missing value, not a polluted Object.prototype index (regression)', function () {
		const polluted = Object.prototype as Record<string, unknown>;
		polluted[0] = '<EVIL>';
		try {
			const strings = Object.assign(['a', 'b', 'c'], { raw: ['a', 'b', 'c'] }) as unknown as TemplateStringsArray;
			expect(helpers.dedent(strings, 1)).toBe('a1bundefinedc');
			expect(helpers.dedent(strings)).toBe('aundefinedbundefinedc');
		} finally {
			delete polluted[0];
		}
	});
});

describe('truncate with options', function () {
	it('takes the suffix from an options object, and keeps every other suffix argument as before', function () {
		expect(helpers.truncate('hello world', 5, {})).toBe('hello...');
		expect(helpers.truncate('hello world', 5, { suffix: '…' })).toBe('hello…');
		expect(helpers.truncate('hello', 5, { separator: ' ' })).toBe('hello');
		expect(function () {
			helpers.truncate('hello', 2, { suffix: 1 as never });
		}).toThrow(new TypeError('truncate: `suffix` must be a string, got number'));
		expect(function () {
			helpers.truncate('hello', 2, 1 as never);
		}).toThrow(new TypeError('truncate: `suffix` must be a string, got number'));
		expect(function () {
			helpers.truncate('hello', 2, { separator: 1 as never });
		}).toThrow(new TypeError('truncate: `separator` must be a string or a RegExp, got number'));
		expect(function () {
			helpers.truncate('hello', 2, { separator: null as never });
		}).toThrow(new TypeError('truncate: `separator` must be a string or a RegExp, got null'));
	});

	it('moves the cut back to the last separator, like lodash', function () {
		expect(helpers.truncate('hello world foo', 8, { separator: ' ' })).toBe('hello...');
		// The separator starts right at the cut: the kept text ends with a whole word.
		expect(helpers.truncate('hello world', 5, { separator: ' ' })).toBe('hello...');
		// No separator in the kept text: the hard cut stays.
		expect(helpers.truncate('helloworld', 5, { separator: ' ' })).toBe('hello...');
		// Two spaces: a string separator cuts before the last one, a RegExp before the whole run.
		expect(helpers.truncate('hello  world', 7, { separator: ' ' })).toBe('hello ...');
		expect(helpers.truncate('hello  world', 7, { separator: / +/ })).toBe('hello...');
		expect(helpers.truncate(' leading', 4, { separator: ' ' })).toBe('...');
		// An occurrence that straddles the cut counts from its start.
		expect(helpers.truncate('one - two', 5, { separator: ' - ' })).toBe('one...');
		expect(helpers.truncate('abc', 2, { separator: '' })).toBe('ab...');
	});

	it('matches a RegExp separator on a copy, with look-arounds across the cut', function () {
		const separator = /,? +/g;
		separator.lastIndex = 5;
		expect(helpers.truncate('hi-diddly-ho there, neighborino', 24, { separator })).toBe('hi-diddly-ho there...');
		expect(separator.lastIndex).toBe(5);
		expect(helpers.truncate('a b c d', 4, { separator: /\s(?=d)/y })).toBe('a b ...');
		expect(helpers.truncate('a b c d', 5, { separator: /\s(?=d)/ })).toBe('a b c...');
		expect(helpers.truncate('one two', 5, { separator: /\b/ })).toBe('one ...');
		expect(helpers.truncate('aaaa', 2, { separator: /x*/ })).toBe('aa...');
		expect(helpers.truncate('abc def', 2, { separator: /\s/u })).toBe('ab...');
	});

	it('never cuts at a separator inside a grapheme cluster', function () {
		expect(helpers.truncate('e\u0301e\u0301 e\u0301e\u0301', 4, { separator: ' ' })).toBe('e\u0301e\u0301...');
		// A ZWJ is a separator here, but only between graphemes.
		expect(helpers.truncate('a\u200db 👨\u200d👩\u200d👧x', 3, { separator: '\u200d' })).toBe('a\u200db ...');
		expect(helpers.truncate('x\u0301 y\u0301z', 3, { separator: '\u0301' })).toBe('x\u0301 y\u0301...');
		expect(helpers.truncate('ab\u0301cd e', 3, { separator: /\u0301/ })).toBe('ab\u0301c...');
		expect(helpers.truncate('👍🏽 👍🏽👍🏽', 3, { separator: /\s/ })).toBe('👍🏽...');
		expect(helpers.truncate(' e\u0301e\u0301e\u0301', 2, { separator: /\s/ })).toBe('...');
	});
});

describe('toSlug options', function () {
	it('keeps its default output', function () {
		expect(helpers.toSlug('Straße Æon Øre Łódź', {})).toBe('strasse-aeon-ore-lodz');
		expect(helpers.toSlug('ẞ Œ Þ', {})).toBe('ss-oe-th');
	});

	it('joins the words with a custom separator', function () {
		expect(helpers.toSlug('Hello, World!', { separator: '_' })).toBe('hello_world');
		expect(helpers.toSlug('Hello World', { separator: '' })).toBe('helloworld');
		expect(helpers.toSlug('  a  b  ', { separator: ' -- ' })).toBe('a -- b');
		expect(function () {
			helpers.toSlug('x', { separator: 1 as never });
		}).toThrow(new TypeError('toSlug: `separator` must be a string, got number'));
	});

	it('keeps the case of letters when lowercase is false', function () {
		expect(helpers.toSlug('Hello World', { lowercase: false })).toBe('Hello-World');
		expect(helpers.toSlug('Æon Þór ẞ Œuvre Ørsted Đ Ð Łódź straße', { lowercase: false })).toBe('AEon-THor-SS-OEuvre-Orsted-D-D-Lodz-strasse');
	});

	it('applies replacements first, longest key first, in a single pass', function () {
		expect(helpers.toSlug('Tom & Jerry', { replacements: { '&': ' and ' } })).toBe('tom-and-jerry');
		expect(helpers.toSlug('C++ & C#', { replacements: { '+': ' plus ', '++': ' plus plus ', '#': ' sharp', '&': ' ' } })).toBe('c-plus-plus-c-sharp');
		expect(helpers.toSlug('a->b-c', { replacements: { '-': ' minus ', '->': ' to ' } })).toBe('a-to-b-minus-c');
		expect(helpers.toSlug('ab', { replacements: { a: 'b', b: 'c' } })).toBe('bc');
		expect(helpers.toSlug('1€', { replacements: { '€': ' euros' } })).toBe('1-euros');
		expect(helpers.toSlug('a.b', { replacements: { '.': ' dot ' } })).toBe('a-dot-b');
		expect(helpers.toSlug('a-b', { replacements: {} })).toBe('a-b');
		expect(helpers.toSlug('a__proto__b', { replacements: JSON.parse('{"__proto__": "-"}') })).toBe('a-b');
	});

	it('validates the replacements', function () {
		expect(function () {
			helpers.toSlug('x', { replacements: 'x' as never });
		}).toThrow(new TypeError('toSlug: `replacements` must be an object, got string'));
		expect(function () {
			helpers.toSlug('x', { replacements: null as never });
		}).toThrow(new TypeError('toSlug: `replacements` must be an object, got null'));
		expect(function () {
			helpers.toSlug('x', { replacements: { x: 1 } as never });
		}).toThrow(new TypeError('toSlug: `replacements` values must be strings, got number'));
		expect(function () {
			helpers.toSlug('x', { replacements: { '': 'y' } });
		}).toThrow(new RangeError('toSlug: `replacements` keys must not be empty'));
	});
});

describe('stripAnsi', function () {
	it('removes colours, styles and cursor movements', function () {
		expect(helpers.stripAnsi('\x1b[0m\x1b[4m\x1b[42m\x1b[31mfoo\x1b[39m\x1b[49m\x1b[24mfoo\x1b[0m')).toBe('foofoo');
		expect(helpers.stripAnsi('\x1b[00;38;5;244m\x1b[m\x1b[00;38;5;33mfoo\x1b[0m')).toBe('foo');
		expect(helpers.stripAnsi('\x1b[0;33;49;3;9;4mbar\x1b[0m')).toBe('bar');
		expect(helpers.stripAnsi('\x1b[38:2:255:0:0mrgb\x1b[4:3m~\x1b[0m')).toBe('rgb~');
		expect(helpers.stripAnsi('\x1b[?25l\x1b[2J\x1b[H\x1b[=3h\x1b[>c\x1b[<u ok')).toBe(' ok');
		expect(helpers.stripAnsi('\x9b31mred\x9b0m')).toBe('red');
		expect(helpers.stripAnsi('\x1b(B\x1b#8\x1b=\x1b>\x1b7\x1b8\x1bc\x1bN\x1bO done')).toBe(' done');
	});

	it('removes OSC strings with any terminator, keeping the text of hyperlinks', function () {
		expect(helpers.stripAnsi('\x1b]8;;https://github.com\x07click\x1b]8;;\x07')).toBe('click');
		expect(helpers.stripAnsi('\x1b]8;;https://github.com\x1b\\click\x1b]8;;\x1b\\')).toBe('click');
		expect(helpers.stripAnsi('\x9d8;;https://github.com\x9cclick\x9d8;;\x07')).toBe('click');
		expect(helpers.stripAnsi('\x1b]0;window title\x07text')).toBe('text');
		expect(helpers.stripAnsi('\x1b]8;id=1;https://a.b/c?d=e&f=g\x1b\\link\x1b]8;;\x1b\\ tail')).toBe('link tail');
	});

	it('removes DCS, SOS, PM and APC strings whole', function () {
		expect(helpers.stripAnsi('\x1bP1$r0m\x1b\\after')).toBe('after');
		expect(helpers.stripAnsi('\x90q#0\x9c|\x98sos\x9c|\x9epm\x9c|\x9fapc\x07|\x1bXs\x1b\\|\x1b^p\x1b\\|\x1b_a\x1b\\')).toBe('||||||');
	});

	it('cancels a control string at ESC, CAN, SUB or another introducer', function () {
		expect(helpers.stripAnsi('\x1b]0;title\x1b[31mX')).toBe('X');
		expect(helpers.stripAnsi('\x1b]0;title\x18Y')).toBe('\x18Y');
		expect(helpers.stripAnsi('\x1b]0;title\x1aY')).toBe('\x1aY');
		expect(helpers.stripAnsi('\x1b]0;title\x9b1mZ')).toBe('Z');
		expect(helpers.stripAnsi('\x1b]0;a\x9d0;b\x07c')).toBe('c');
	});

	it('removes a sequence left open at the end, and keeps the other control characters', function () {
		expect(helpers.stripAnsi('unterminated \x1b]8;;https://x')).toBe('unterminated ');
		expect(helpers.stripAnsi('a\x1b[31')).toBe('a');
		expect(helpers.stripAnsi('a\x1b')).toBe('a');
		expect(helpers.stripAnsi('\x1b[31\nx')).toBe('31\nx');
		expect(helpers.stripAnsi('a\tb\r\n\x07c\x85\x9c\x18\x1a')).toBe('a\tb\r\n\x07c\x85\x9c\x18\x1a');
	});

	it('removes stray introducers, so that removing a sequence never splices a new one together (regression)', function () {
		// A lone ESC before a removed sequence used to be kept and joined to the text after it: a window title or clipboard write (OSC 52).
		expect(helpers.stripAnsi('\x1b\x1b[0m]2;pwned\x07after')).toBe(']2;pwned\x07after');
		expect(helpers.stripAnsi('\x1b\x1b[m]52;c;aGk=\x07')).toBe(']52;c;aGk=\x07');
		expect(helpers.stripAnsi('\x1b\x9b0m[31mred')).toBe('[31mred');
		expect(helpers.stripAnsi('\x1b\x1b\x1b[1m[2m]0;t\x07')).toBe('[2m]0;t\x07');
		expect(helpers.stripAnsi('\x9b\x90\x98\x9d\x9e\x9f')).toBe('');
		expect(helpers.stripAnsi('x\x1b')).toBe('x');
	});

	it('leaves stringWidth unchanged on stray introducers', function () {
		expect(helpers.stringWidth('\x1b\x1b[0m]2;pwned\x07after')).toBe(13);
		expect(helpers.stringWidth('a\x1b')).toBe(1);
	});

	it('returns plain text unchanged, validates its argument and stays linear', function () {
		expect(helpers.stripAnsi('plain')).toBe('plain');
		expect(helpers.stripAnsi('')).toBe('');
		expect(function () {
			helpers.stripAnsi(1 as never);
		}).toThrow(new TypeError('stripAnsi: `string` must be a string, got number'));
		const started = Date.now();
		expect(helpers.stripAnsi('\x1b]'.repeat(50_000))).toBe('');
		expect(helpers.stripAnsi('\x1b[' + '1;'.repeat(50_000) + '\x00z')).toBe('1;'.repeat(50_000) + '\x00z');
		expect(helpers.stripAnsi('\x1b]0;' + 'x'.repeat(100_000) + '\x07z')).toBe('z');
		expect(helpers.stripAnsi('\x9d'.repeat(50_000) + 'z')).toBe('');
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('agrees with stringWidth', function () {
		expect(helpers.stringWidth('\x9d0;title\x07古')).toBe(2);
		expect(helpers.stringWidth(helpers.stripAnsi('\x1b[1m古\x1b[0m'))).toBe(2);
	});
});

describe('stripHtml', function () {
	it('extracts the text of elements and decodes the basic entities', function () {
		expect(helpers.stripHtml('<p>Hello <b>world</b>!</p>')).toBe('Hello world!');
		expect(helpers.stripHtml('<p>a</p><p>b</p>')).toBe('ab');
		expect(helpers.stripHtml('Tom &amp; Jerry &lt;3 &nbsp;&#169;')).toBe('Tom & Jerry <3 &nbsp;&#169;');
		expect(helpers.stripHtml('&lt;b&gt;not a tag&lt;/b&gt;')).toBe('<b>not a tag</b>');
		expect(helpers.stripHtml('plain')).toBe('plain');
		expect(helpers.stripHtml('')).toBe('');
	});

	it('decodes each run of text on its own', function () {
		expect(helpers.stripHtml('&am<b></b>p;')).toBe('&amp;');
		expect(helpers.stripHtml('&amp;lt;<i>x</i>')).toBe('&lt;x');
	});

	it('drops comments, doctypes, CDATA and processing instructions', function () {
		expect(helpers.stripHtml('<!DOCTYPE html><?xml version="1.0"?>a<!-- b -->c<![CDATA[d]]>e')).toBe('ace');
		expect(helpers.stripHtml('a<!-->b<!--->c<!---->d<!-- x --!>e')).toBe('abcde');
		expect(helpers.stripHtml('a<!-- -- > still a comment -->b')).toBe('ab');
		expect(helpers.stripHtml('a<!x>b<!>c<?>d')).toBe('abcd');
		expect(helpers.stripHtml('a<!-- open')).toBe('a');
		expect(helpers.stripHtml('a<!DOCTYPE')).toBe('a');
	});

	it('removes the content of script and style elements, up to their own end tag', function () {
		expect(helpers.stripHtml('a<script>if (a < b) document.write("<b>x</b>")</script>b')).toBe('ab');
		expect(helpers.stripHtml('a<STYLE type="text/css">p > b { }</style >b<Script/>c</SCRIPT\tx>d')).toBe('abd');
		expect(helpers.stripHtml('<script>a</style>b</scripts>c</script>d')).toBe('d');
		expect(helpers.stripHtml('a<script>never closed</b>')).toBe('a');
		expect(helpers.stripHtml('a<script')).toBe('a');
		expect(helpers.stripHtml('a<scripts>b</scripts>c<styles>d')).toBe('abcd');
		expect(helpers.stripHtml('a<script>x</script')).toBe('a');
		expect(helpers.stripHtml('a<style>p { }</styles>')).toBe('a');
	});

	it('ends a script where browsers do, in its escaped states (regression: the double-escaped form leaked script text)', function () {
		expect(helpers.stripHtml('a<script><!--document.write("<script src=x></script>");//--></script>b')).toBe('ab');
		expect(helpers.stripHtml('a<script><!--<SCRIPT>x</script>y</script>z')).toBe('az');
		expect(helpers.stripHtml('a<script><!--<script>x</script/>y</script >z')).toBe('az');
		// `-->` leaves either escaped state, after which `<script` does not double-escape any more.
		expect(helpers.stripHtml('a<script><!--<script>x-->y<script></script>z')).toBe('az');
		expect(helpers.stripHtml('a<script><!--x--><script>y</script>z')).toBe('az');
		expect(helpers.stripHtml('a<script><!--></script>z')).toBe('az');
		expect(helpers.stripHtml('a<script><!---></script>z')).toBe('az');
		// Escaped (one `<!--`, no `<script`): the end tag still ends it.
		expect(helpers.stripHtml('a<script><!-- x </script>z')).toBe('az');
		// `<scripts` is no script start tag.
		expect(helpers.stripHtml('a<script><!--<scripts></script>z')).toBe('az');
		expect(helpers.stripHtml('a<script><!--<script>never closed</script>b')).toBe('a');
		expect(helpers.stripHtml('a<script><!--<script')).toBe('a');
	});

	it('keeps the content of title and textarea elements as text (regression: tags in it were removed, a <script> hid the rest)', function () {
		expect(helpers.stripHtml('<title>How to use <script> tags</title><p>Body &amp; soul</p>')).toBe('How to use <script> tags' + 'Body & soul');
		expect(helpers.stripHtml('<textarea name="embed"><script src="x.js"></script></textarea>after')).toBe('<script src="x.js"></script>after');
		expect(helpers.stripHtml('<TEXTAREA><!-- not a comment --></textarea >b')).toBe('<!-- not a comment -->b');
		expect(helpers.stripHtml('<title>a &lt;b&gt; <b>c</b></title>d')).toBe('a <b> <b>c</b>d');
		expect(helpers.stripHtml('<title>a</titles></title>b')).toBe('a</titles>b');
		expect(helpers.stripHtml('<textarea/>x<b>y')).toBe('x<b>y');
		expect(helpers.stripHtml('a<title')).toBe('a');
		expect(helpers.stripHtml('<titles>a<b>c</b></titles>')).toBe('ac');
	});

	it('reads attributes like the HTML tokenizer', function () {
		expect(helpers.stripHtml('<a title="a > b" data-x=\'c > d\' href=/x>link</a> 1 < 2')).toBe('link 1 < 2');
		expect(helpers.stripHtml('<a b = "x>y" c=d>e</a>')).toBe('e');
		expect(helpers.stripHtml('<a b="x"c=\'>\'/>e')).toBe('e');
		expect(helpers.stripHtml('<a ="x>y">')).toBe('y">');
		expect(helpers.stripHtml('<a b c=>d')).toBe('d');
		expect(helpers.stripHtml('<a b=c/>d')).toBe('d');
		expect(helpers.stripHtml('<br/>a<img src=x onerror=alert(1)//>b')).toBe('ab');
		// Not a sanitizer (documented): the text around a removed tag can recombine into a tag.
		expect(helpers.stripHtml('<<b>img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
		expect(helpers.stripHtml('<a\n\thref\f=\r"x">y</a\n>')).toBe('y');
		expect(helpers.stripHtml('</a b="c>d">e')).toBe('e');
		for (const space of ['\t', '\n', '\f', '\r', ' ']) expect(helpers.stripHtml(`<a${space}b="x>y">z`)).toBe('z');
		expect(helpers.stripHtml('<z>a<Z>b')).toBe('ab');
		// `/` ends a tag name and an attribute name; a `=` after it starts another name, not a value.
		expect(helpers.stripHtml('<br/x="a>b">c')).toBe('c');
		expect(helpers.stripHtml('<x a/="y>z">w')).toBe('z">w');
		expect(helpers.stripHtml('<a /="x>y">z')).toBe('y">z');
		// An unquoted value holds `=` and quotes.
		expect(helpers.stripHtml('<a x=b="c>d">e')).toBe('d">e');
	});

	it('treats a < that starts no markup as text', function () {
		expect(helpers.stripHtml('a < b <3 <= c <')).toBe('a < b <3 <= c <');
		expect(helpers.stripHtml('a <{b} <~ <@ <[ <` < -- b')).toBe('a <{b} <~ <@ <[ <` < -- b');
		expect(helpers.stripHtml('x</')).toBe('x</');
		expect(helpers.stripHtml('x</>y</ z>w</1>v')).toBe('xywv');
	});

	it('drops a tag left open at the end, as browsers do', function () {
		expect(helpers.stripHtml('a <b c="unterminated>d')).toBe('a ');
		expect(helpers.stripHtml("a <b c='x")).toBe('a ');
		expect(helpers.stripHtml('a <b c=')).toBe('a ');
		expect(helpers.stripHtml('a <b c')).toBe('a ');
		expect(helpers.stripHtml('a <b c ')).toBe('a ');
		expect(helpers.stripHtml('a <b')).toBe('a ');
		expect(helpers.stripHtml('a </b')).toBe('a ');
	});

	it('validates its argument and runs in linear time on hostile markup', function () {
		expect(function () {
			helpers.stripHtml(null as never);
		}).toThrow(new TypeError('stripHtml: `html` must be a string, got null'));
		const started = Date.now();
		expect(helpers.stripHtml('<'.repeat(100_000))).toBe('<'.repeat(100_000));
		expect(helpers.stripHtml('<a b="'.repeat(20_000))).toBe('');
		expect(helpers.stripHtml('<a '.repeat(30_000) + '>x')).toBe('x');
		expect(helpers.stripHtml('<a b=c '.repeat(20_000) + '>x')).toBe('x');
		expect(helpers.stripHtml('<script>' + '</scrip'.repeat(20_000))).toBe('');
		expect(helpers.stripHtml('<!--'.repeat(30_000))).toBe('');
		expect(helpers.stripHtml('<script>' + '<!--<script></script>-->'.repeat(20_000))).toBe('');
		expect(helpers.stripHtml('<script><!--' + '<script></script x'.repeat(20_000))).toBe('');
		expect(helpers.stripHtml('<title>' + '</titl'.repeat(20_000))).toBe('</titl'.repeat(20_000));
		expect(helpers.stripHtml('<!-'.repeat(30_000))).toBe('');
		expect(helpers.stripHtml('</'.repeat(30_000) + 'x')).toBe('');
		expect(Date.now() - started).toBeLessThan('__stryker__' in globalThis ? Infinity : 1000);
	});
});

describe('indent', function () {
	it('indents every non-blank line by count units', function () {
		expect(helpers.indent('a\n\nb', 2)).toBe('  a\n\n  b');
		expect(helpers.indent('a\n \n\tb\r\nc\rd\n', 2)).toBe('  a\n \n  \tb\r\n  c\r  d\n');
		expect(helpers.indent('a', 0)).toBe('a');
		expect(helpers.indent('', 3)).toBe('');
		expect(helpers.indent('a\nb', 2, { indent: '\t' })).toBe('\t\ta\n\t\tb');
		expect(helpers.indent('a\u2028b', 1)).toBe(' a\u2028b');
	});

	it('takes the indentation itself as a string', function () {
		expect(helpers.indent('a\r\nb', '\t')).toBe('\ta\r\n\tb');
		expect(helpers.indent('a\nb', '> ', { indent: 'ignored' as never })).toBe('> a\n> b');
		expect(helpers.indent('a', '')).toBe('a');
	});

	it('indents blank lines too with includeEmptyLines', function () {
		expect(helpers.indent('a\n\n \nb\n', 1, { includeEmptyLines: true })).toBe(' a\n \n  \n b\n ');
		expect(helpers.indent('', '#', { includeEmptyLines: true })).toBe('#');
	});

	it('is undone by dedent', function () {
		expect(helpers.dedent(helpers.indent('if (x) {\n  y();\n}', 4))).toBe('if (x) {\n  y();\n}');
	});

	it('validates its arguments', function () {
		expect(function () {
			helpers.indent(1 as never, 1);
		}).toThrow(new TypeError('indent: `string` must be a string, got number'));
		expect(function () {
			helpers.indent('a', null as never);
		}).toThrow(new TypeError('indent: `count` must be an integer >= 0 or a string, got null'));
		expect(function () {
			helpers.indent('a', -1);
		}).toThrow(new RangeError('indent: `count` must be an integer >= 0, got -1'));
		expect(function () {
			helpers.indent('a', 1.5);
		}).toThrow(RangeError);
		expect(function () {
			helpers.indent('a', 2, { indent: 2 as never });
		}).toThrow(new TypeError('indent: `indent` must be a string, got number'));
	});
});

describe('splitOnce / splitLast', function () {
	it('splits at the first or last occurrence', function () {
		expect(helpers.splitOnce('key=value=x', '=')).toEqual(['key', 'value=x']);
		expect(helpers.splitLast('key=value=x', '=')).toEqual(['key=value', 'x']);
		expect(helpers.splitOnce('a::b::c', '::')).toEqual(['a', 'b::c']);
		expect(helpers.splitLast('a::b::c', '::')).toEqual(['a::b', 'c']);
		expect(helpers.splitOnce('=x', '=')).toEqual(['', 'x']);
		expect(helpers.splitLast('x=', '=')).toEqual(['x', '']);
		expect(helpers.splitOnce('aaa', 'aa')).toEqual(['', 'a']);
		expect(helpers.splitLast('aaa', 'aa')).toEqual(['a', '']);
	});

	it('returns undefined when the separator does not occur', function () {
		expect(helpers.splitOnce('abc', '=')).toBeUndefined();
		expect(helpers.splitLast('abc', '=')).toBeUndefined();
		expect(helpers.splitOnce('', '=')).toBeUndefined();
	});

	it('matches an empty separator at the start or the end', function () {
		expect(helpers.splitOnce('abc', '')).toEqual(['', 'abc']);
		expect(helpers.splitLast('abc', '')).toEqual(['abc', '']);
	});

	it('validates its arguments', function () {
		expect(function () {
			helpers.splitOnce(null as never, '=');
		}).toThrow(new TypeError('splitOnce: `string` must be a string, got null'));
		expect(function () {
			helpers.splitOnce('a', /=/ as never);
		}).toThrow(new TypeError('splitOnce: `separator` must be a string, got object'));
		expect(function () {
			helpers.splitLast(1 as never, '=');
		}).toThrow(new TypeError('splitLast: `string` must be a string, got number'));
		expect(function () {
			helpers.splitLast('a', undefined as never);
		}).toThrow(new TypeError('splitLast: `separator` must be a string, got undefined'));
	});
});

describe('toSafeFilename', function () {
	it('replaces each run of invalid characters', function () {
		expect(helpers.toSafeFilename('Q1/Q2 report: "final"?.pdf')).toBe('Q1_Q2 report_ _final_.pdf');
		expect(helpers.toSafeFilename('a<>:"/\\|?*b')).toBe('a_b');
		expect(helpers.toSafeFilename('a\x00b\x1fc\x7fd\x9fe')).toBe('a_b_c_d_e');
		expect(helpers.toSafeFilename('invoice\u202efdp.exe')).toBe('invoice_fdp.exe');
		expect(helpers.toSafeFilename('a\u2066b\u200fc\u061cd')).toBe('a_b_c_d');
		expect(helpers.toSafeFilename('a\ud800b\udc00c😀')).toBe('a_b_c😀');
		expect(helpers.toSafeFilename('../etc/passwd', { replacement: '-' })).toBe('..-etc-passwd');
		expect(helpers.toSafeFilename('<script>', { replacement: '' })).toBe('script');
		expect(helpers.toSafeFilename('a/b', { replacement: '$&' })).toBe('a$&b');
		expect(helpers.toSafeFilename('Crème brûlée 🍮.txt')).toBe('Crème brûlée 🍮.txt');
	});

	it('replaces the separator lookalikes that Windows best-fit conversions turn into real ones (regression)', function () {
		expect(helpers.toSafeFilename('a∕b／c⧸d⁄e＼f')).toBe('a_b_c_d_e_f');
		expect(helpers.toSafeFilename('a∕b⁄c／d⧸e∖f＼g⧹h﹨i：j')).toBe('a_b_c_d_e_f_g_h_i_j');
		expect(helpers.toSafeFilename('..∕..∕win.ini')).toBe('.._.._win.ini');
		// The full-width forms of the other forbidden characters best-fit to `" * < > ? |`.
		expect(helpers.toSafeFilename('a＂b＊c＜d＞e？f｜g')).toBe('a_b_c_d_e_f_g');
		expect(helpers.toSafeFilename('C：＼x', { replacement: '' })).toBe('Cx');
		expect(function () {
			helpers.toSafeFilename('a', { replacement: '／' });
		}).toThrow(RangeError);
		// Legitimate characters that some ANSI code pages also map to `\` are kept.
		expect(helpers.toSafeFilename('¥100 ₩200.txt')).toBe('¥100 ₩200.txt');
		expect(helpers.toSafeFilename('.htaccess')).toBe('.htaccess');
	});

	it('removes dots and spaces at the end, and never returns an empty name, . or ..', function () {
		expect(helpers.toSafeFilename('notes. . .')).toBe('notes');
		expect(helpers.toSafeFilename('.')).toBe('_');
		expect(helpers.toSafeFilename('..')).toBe('_');
		expect(helpers.toSafeFilename('')).toBe('_');
		expect(helpers.toSafeFilename('   ')).toBe('_');
		expect(helpers.toSafeFilename('///', { replacement: '' })).toBe('_');
		expect(helpers.toSafeFilename('a?', { replacement: '.' })).toBe('a');
		expect(helpers.toSafeFilename('.bashrc')).toBe('.bashrc');
		expect(helpers.toSafeFilename(' leading')).toBe(' leading');
	});

	it('escapes the Windows device names, with or without an extension', function () {
		expect(helpers.toSafeFilename('con')).toBe('con_');
		expect(helpers.toSafeFilename('aux.txt')).toBe('aux_.txt');
		expect(helpers.toSafeFilename('NUL.tar.gz')).toBe('NUL_.tar.gz');
		expect(helpers.toSafeFilename('CON .txt')).toBe('CON_ .txt');
		expect(helpers.toSafeFilename('con.')).toBe('con_');
		expect(helpers.toSafeFilename('Com1')).toBe('Com1_');
		expect(helpers.toSafeFilename('lpt9.log')).toBe('lpt9_.log');
		expect(helpers.toSafeFilename('COM0')).toBe('COM0_');
		expect(helpers.toSafeFilename('com¹')).toBe('com¹_');
		expect(helpers.toSafeFilename('LPT³.x')).toBe('LPT³_.x');
		expect(helpers.toSafeFilename('conin$')).toBe('conin$_');
		expect(helpers.toSafeFilename('CONOUT$.txt')).toBe('CONOUT$_.txt');
		expect(helpers.toSafeFilename('prn?', { replacement: '' })).toBe('prn_');
		expect(helpers.toSafeFilename('?', { replacement: 'con' })).toBe('con_');
		for (const name of ['console', 'com10', 'com', 'lpt', 'auxx.txt', 'xcon', 'con_', 'con-1.txt', 'nul x.txt']) expect(helpers.toSafeFilename(name)).toBe(name);
	});

	it('changes the last letter of a device name that already fills maxLength', function () {
		expect(helpers.toSafeFilename('con', { maxLength: 3 })).toBe('co_');
		expect(helpers.toSafeFilename('com¹', { maxLength: 5 })).toBe('com_');
		expect(helpers.toSafeFilename('com¹', { maxLength: 4 })).toBe('com');
		expect(helpers.toSafeFilename('nul.txt', { maxLength: 7 })).toBe('nu_.txt');
		expect(helpers.toSafeFilename('nul.txt', { maxLength: 8 })).toBe('nul_.txt');
	});

	it('cuts the name to maxLength UTF-8 bytes between graphemes, keeping the extension', function () {
		expect(helpers.toSafeFilename('a'.repeat(300) + '.txt')).toBe('a'.repeat(251) + '.txt');
		expect(helpers.toSafeFilename('a'.repeat(300))).toBe('a'.repeat(255));
		expect(helpers.toSafeFilename('é'.repeat(200) + '.md')).toBe('é'.repeat(126) + '.md');
		expect(helpers.toSafeFilename('日'.repeat(100) + '.md')).toBe('日'.repeat(84) + '.md');
		expect(helpers.toSafeFilename('😀'.repeat(100))).toBe('😀'.repeat(63));
		expect(helpers.toSafeFilename('👍🏽'.repeat(10) + '.txt', { maxLength: 20 })).toBe('👍🏽👍🏽.txt');
		expect(helpers.toSafeFilename('e\u0301'.repeat(10), { maxLength: 7 })).toBe('e\u0301e\u0301');
		expect(helpers.toSafeFilename('crème brûlée.txt', { maxLength: 10 })).toBe('crème.txt');
		expect(helpers.toSafeFilename('abc. def.txt', { maxLength: 8 })).toBe('abc..txt');
		expect(helpers.toSafeFilename('abc.txt', { maxLength: 4 })).toBe('abc');
		expect(helpers.toSafeFilename('abcdefgh.verylongext', { maxLength: 8 })).toBe('abcdefgh');
		expect(helpers.toSafeFilename('Chapter 1. The end', { maxLength: 12 })).toBe('Chapter 1. T');
		expect(helpers.toSafeFilename('👨\u200d👩\u200d👧.txt', { maxLength: 8 })).toBe('_');
		expect(helpers.toSafeFilename('👨\u200d👩\u200d👧', { maxLength: 17 })).toBe('_');
		expect(helpers.toSafeFilename('👨\u200d👩\u200d👧', { maxLength: 18 })).toBe('👨\u200d👩\u200d👧');
		expect(helpers.toSafeFilename('x'.repeat(1000), { maxLength: Infinity })).toBe('x'.repeat(1000));
		expect(helpers.toSafeFilename('ab', { maxLength: 1 })).toBe('a');
		// 3 bytes from U+0800, 4 for a surrogate pair (U+10000 is D800 DC00, U+103FF is D800 DFFF).
		expect(helpers.toSafeFilename('\u07ff'.repeat(4), { maxLength: 7 })).toBe('\u07ff'.repeat(3));
		expect(helpers.toSafeFilename('\u0800'.repeat(4), { maxLength: 7 })).toBe('\u0800'.repeat(2));
		expect(helpers.toSafeFilename('\u{10000}'.repeat(3), { maxLength: 9 })).toBe('\u{10000}'.repeat(2));
		expect(helpers.toSafeFilename('\u{103ff}'.repeat(3), { maxLength: 9 })).toBe('\u{103ff}'.repeat(2));
	});

	it('validates its arguments', function () {
		expect(function () {
			helpers.toSafeFilename(1 as never);
		}).toThrow(new TypeError('toSafeFilename: `string` must be a string, got number'));
		expect(function () {
			helpers.toSafeFilename('a', { replacement: 1 as never });
		}).toThrow(new TypeError('toSafeFilename: `replacement` must be a string, got number'));
		expect(function () {
			helpers.toSafeFilename('a', { replacement: '/' });
		}).toThrow(new RangeError('toSafeFilename: `replacement` must not hold characters that are invalid in file names, got "/"'));
		expect(function () {
			helpers.toSafeFilename('a', { replacement: 'x\u202e' });
		}).toThrow(RangeError);
		expect(function () {
			helpers.toSafeFilename('a', { maxLength: 0 });
		}).toThrow(new RangeError('toSafeFilename: `maxLength` must be an integer >= 1 or Infinity, got 0'));
		expect(function () {
			helpers.toSafeFilename('a', { maxLength: '9' as never });
		}).toThrow(TypeError);
	});

	it('runs in linear time on hostile input', function () {
		const started = Date.now();
		expect(helpers.toSafeFilename('.'.repeat(100_000) + 'x')).toBe('.'.repeat(254) + 'x');
		expect(helpers.toSafeFilename('x' + ' .'.repeat(100_000))).toBe('x');
		expect(helpers.toSafeFilename('/'.repeat(100_000))).toBe('_');
		expect(helpers.toSafeFilename('é'.repeat(100_000) + '.txt').length).toBe(125 + 4);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
