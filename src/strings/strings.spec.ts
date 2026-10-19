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
		expect(performance.now() - start).toBeLessThan(2000);
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
		expect(performance.now() - start).toBeLessThan(2000);
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
			expect(helpers.mask('12345678')).toBe('****5678');
			expect(helpers.wordWrap('abcdefghij', 4)).toBe('abcdefghij');
			expect(helpers.toDelimitedCase('helloWorld', '-')).toBe('hello-world');
		} finally {
			for (const key of ['ellipsis', 'position', 'ignoreCase', 'visibleEnd', 'char', 'breakLongWords', 'case']) delete polluted[key];
		}
	});
});
