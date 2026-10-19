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

		it('should use the Unicode title-case form of digraphs (regression)', function () {
			// Used to produce the upper-case digraph ('Ǆemal').
			expect(helpers.toTitleCase('ǆemal ǅEMAL Ǆemal')).toEqual('ǅemal ǅemal ǅemal');
			expect(helpers.toTitleCase('ǉubljana ǌ ǳ')).toEqual('ǈubljana ǋ ǲ');
			expect(helpers.toTitleCase(helpers.toTitleCase('ǆemal'))).toEqual('ǅemal');
			expect(helpers.toPascalCase('ǆemal ǉubljana')).toEqual('ǅemalǈubljana');
			expect(helpers.toCamelCase('foo ǆemal')).toEqual('fooǅemal');
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
