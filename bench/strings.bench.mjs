import {
	camelCase,
	constantCase,
	deburr,
	escape,
	escapeRegExp as esEscapeRegExp,
	kebabCase,
	lowerCase,
	lowerFirst,
	pad as esPad,
	pascalCase,
	reverseString,
	snakeCase,
	startCase,
	trim as esTrim,
	trimEnd as esTrimEnd,
	trimStart as esTrimStart,
	unescape,
	upperFirst,
	words
} from 'es-toolkit';
import { padEnd as esPadEnd, padStart as esPadStart, repeat as esRepeat, template as esTemplate, truncate as esTruncate } from 'es-toolkit/compat';
import * as lodash from 'lodash-es';
import * as radash from 'radash';
import {
	capitalize,
	escapeHtml,
	escapeRegExp,
	getWords,
	interpolate,
	levenshtein,
	padCenter,
	padEnd,
	padStart,
	removeDiacritics,
	repeat,
	reverse,
	similarity,
	toCamelCase,
	toConstantCase,
	toDelimitedCase,
	toDotCase,
	toKebabCase,
	toNoCase,
	toPascalCase,
	toSlug,
	toSnakeCase,
	toStartCase,
	toTitleCase,
	toTrainCase,
	trim,
	trimChars,
	trimEndChars,
	trimStartChars,
	truncate,
	uncapitalize,
	unescapeHtml
} from 'tinkjs/strings';

// Input classes: short ASCII identifiers, long ASCII text (~1.6 KB) and unicode-heavy text (accents, CJK, emoji).
const identifiers = [
	'helloWorld',
	'XMLHttpRequest',
	'get-http-response2-code',
	'SOME_CONSTANT_NAME',
	'user name',
	'version2Beta',
	'Crème brûlée recipe',
	'already_snake_case'
];
const longAscii = 'The quick brownFox jumps_over the-lazy DOG and XMLHttpRequest handlers; '.repeat(22);
const unicode = 'Crème brûlée à Málaga — naïve Œuvre Straße, Ünïcödé façade 日本語テキスト 👍🏽 São Paulo déjà vu '.repeat(8);
const titles = ['Café Society: A Review', '  --Hello__World!!  ', 'Ünïcödé Straße & Œuvre', 'The Quick Brown Fox Jumps Over The Lazy Dog 2024'];
const html = '<p class="intro">Tom & Jerry\'s "best" episodes</p>'.repeat(20);
const escaped = escapeHtml(html);
const plain = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod tempor. '.repeat(10);
const paragraph = "Don't stop believing: café 2024, naïve résumé — it's 100% fine! ".repeat(10);
const names = ['Ada Lovelace', 'Grace Hopper', 'Tom & Jerry', 'Alan Turing', "O'Brien", 'Edsger Dijkstra', 'Barbara Liskov', '<script>'];
const regexSources = ['1.5*(x)', 'file[1].txt', 'a+b=c?', 'C:\\path\\to', 'plain words', '$100 (USD)', '^start|end$', '{json}'];
const padded = ['  hello  ', '\t\ntabbed\n', 'none', '   leading', 'trailing   ', '  mixed\u00a0nbsp  ', '', '  x  '];
const template = 'Hello {user.name}, you have {count} new messages from {sender} ({user.email}).';
const values = { user: { name: 'Ada', email: 'ada@example.com' }, count: 3, sender: 'Bob' };
const lodashTemplate = 'Hello ${user.name}, you have ${count} new messages from ${sender} (${user.email}).';
const compiledLodash = lodash.template(lodashTemplate);
const compiledEs = esTemplate(lodashTemplate);
const otherTemplate = 'Order {id} shipped to {address.city} on {date}.';
const otherValues = { id: 42, address: { city: 'Paris' }, date: '2024-01-15' };
const otherLodashTemplate = 'Order ${id} shipped to ${address.city} on ${date}.';
const otherCompiledLodash = lodash.template(otherLodashTemplate);
const otherCompiledEs = esTemplate(otherLodashTemplate);

/**
 * Maps a function over a list (the shape every case-conversion case uses).
 * @param {(value: string) => string} fn - The function
 * @param {string[]} list - The inputs
 * @returns {string[]} The results
 */
function each(fn, list) {
	const out = [];
	for (let i = 0; i < list.length; i++) out.push(fn(list[i]));
	return out;
}

/**
 * Builds three cases (short identifiers, long ASCII text, unicode text) for a one-argument string function and its competitors.
 * @param {string} label - The helper name
 * @param {(value: string) => unknown} ours - Our implementation
 * @param {Record<string, (value: string) => unknown>} others - The competitors
 * @returns {object[]} The cases
 */
function threeWay(label, ours, others) {
	const inputs = { '8 identifiers': identifiers, 'long ASCII 1.6 KB': [longAscii], 'unicode 0.7 KB': [unicode] };
	return Object.entries(inputs).map(function ([name, list]) {
		const competitors = {};
		for (const [lib, fn] of Object.entries(others)) {
			competitors[lib] = function () {
				return each(fn, list);
			};
		}
		return {
			name: `${label} (${name})`,
			fn: function () {
				return each(ours, list);
			},
			competitors
		};
	});
}

const fenced = ['--hello-world__', '__init__', '-_-', 'plain', '---a-very-long-identifier-with-dashes---', '_x_', '', '-_-_-_-_-_value-_-_-_-_-'];
const longFenced = '-_'.repeat(20) + longAscii + '_-'.repeat(20);
const unicodeFenced = '··' + unicode + '··';
const labels = ['id', 'Name', 'Ünïcödé', '👍🏽', 'a longer label', 'x', '日本語', ''];

/**
 * Builds a case trimming the same inputs with a set of characters, for ours and the competitors (es-toolkit takes an array of characters).
 * @param {string} name - The case name
 * @param {string[]} list - The inputs
 * @param {string} chars - The characters to trim
 * @returns {object} The case
 */
function trimCase(name, list, chars) {
	const array = Array.from(chars);
	return {
		name: `trimChars (${name})`,
		fn: function () {
			return each(function (value) {
				return trimChars(value, chars);
			}, list);
		},
		competitors: {
			'es-toolkit': function () {
				return each(function (value) {
					return esTrim(value, array);
				}, list);
			},
			lodash: function () {
				return each(function (value) {
					return lodash.trim(value, chars);
				}, list);
			},
			radash: function () {
				return each(function (value) {
					return radash.trim(value, chars);
				}, list);
			}
		}
	};
}

/**
 * Builds a case padding the labels to a width, for ours and the competitors.
 * @param {string} name - The helper name
 * @param {(value: string, width: number, fill: string) => string} ours - Our implementation
 * @param {Record<string, (value: string, width: number, fill: string) => string>} others - The competitors
 * @param {string} fill - The fill
 * @returns {object} The case
 */
function padCase(name, ours, others, fill) {
	const competitors = {};
	for (const [lib, fn] of Object.entries(others)) {
		competitors[lib] = function () {
			return each(function (value) {
				return fn(value, 16, fill);
			}, labels);
		};
	}
	return {
		name: `${name} (8 labels to 16, fill ${JSON.stringify(fill)})`,
		fn: function () {
			return each(function (value) {
				return ours(value, 16, fill);
			}, labels);
		},
		competitors
	};
}

export default [
	trimCase('8 short identifiers', fenced, '-_'),
	trimCase('long ASCII 1.6 KB', [longFenced], '-_'),
	trimCase('unicode 0.7 KB', [unicodeFenced], '·'),
	{
		name: 'trimStartChars + trimEndChars (8 short identifiers)',
		fn: function () {
			return each(function (value) {
				return trimStartChars(value, '-') + trimEndChars(value, '_');
			}, fenced);
		},
		competitors: {
			'es-toolkit': function () {
				return each(function (value) {
					return esTrimStart(value, '-') + esTrimEnd(value, '_');
				}, fenced);
			},
			lodash: function () {
				return each(function (value) {
					return lodash.trimStart(value, '-') + lodash.trimEnd(value, '_');
				}, fenced);
			}
		}
	},
	...threeWay('toStartCase', toStartCase, { 'es-toolkit': startCase, lodash: lodash.startCase, radash: radash.title }),
	...threeWay('toNoCase ~ lowerCase', toNoCase, { 'es-toolkit': lowerCase, lodash: lodash.lowerCase }),
	...threeWay('toTrainCase', toTrainCase, {}),
	...threeWay('toDotCase', toDotCase, {}),
	{
		name: 'toDelimitedCase (8 identifiers, upper)',
		fn: function () {
			return each(function (value) {
				return toDelimitedCase(value, '.', { case: 'upper' });
			}, identifiers);
		}
	},
	padCase('padStart', padStart, { 'es-toolkit': esPadStart, lodash: lodash.padStart }, ' '),
	padCase('padEnd', padEnd, { 'es-toolkit': esPadEnd, lodash: lodash.padEnd }, '.'),
	padCase('padCenter', padCenter, { 'es-toolkit': esPad, lodash: lodash.pad }, '*'),
	padCase('padStart', padStart, { 'es-toolkit': esPadStart, lodash: lodash.padStart }, '-='),
	...threeWay('toCamelCase', toCamelCase, { 'es-toolkit': camelCase, lodash: lodash.camelCase }),
	...threeWay('toSnakeCase', toSnakeCase, { 'es-toolkit': snakeCase, lodash: lodash.snakeCase }),
	...threeWay('toKebabCase', toKebabCase, { 'es-toolkit': kebabCase, lodash: lodash.kebabCase }),
	...threeWay('toPascalCase', toPascalCase, { 'es-toolkit': pascalCase }),
	...threeWay('toConstantCase', toConstantCase, { 'es-toolkit': constantCase }),
	// Loose: startCase re-splits words (`helloWorld` → `Hello World`); toTitleCase only re-cases whitespace-separated words.
	...threeWay('toTitleCase ~ startCase', toTitleCase, { 'es-toolkit': startCase, lodash: lodash.startCase }),
	...threeWay('capitalize ~ upperFirst', capitalize, { 'es-toolkit': upperFirst, lodash: lodash.upperFirst }),
	...threeWay('uncapitalize ~ lowerFirst', uncapitalize, { 'es-toolkit': lowerFirst, lodash: lodash.lowerFirst }),
	...threeWay('removeDiacritics ~ deburr', removeDiacritics, { 'es-toolkit': deburr, lodash: lodash.deburr }),
	// Loose: getWords keeps inner apostrophes and does not split camelCase; `words` splits camelCase.
	...threeWay('getWords ~ words', getWords, { 'es-toolkit': words, lodash: lodash.words }),
	...threeWay('reverse ~ reverseString', reverse, { 'es-toolkit': reverseString }),
	{
		name: 'toSlug (4 titles)',
		fn: function () {
			return each(toSlug, titles);
		},
		competitors: {
			// Loose: the closest composition users write.
			lodash: function () {
				return each(function (title) {
					return lodash.kebabCase(lodash.deburr(title));
				}, titles);
			}
		}
	},
	{
		name: 'escapeHtml (1 KB)',
		fn: function () {
			return escapeHtml(html);
		},
		competitors: {
			'es-toolkit': function () {
				return escape(html);
			},
			lodash: function () {
				return lodash.escape(html);
			}
		}
	},
	{
		name: 'escapeHtml (800 B, nothing to escape)',
		fn: function () {
			return escapeHtml(plain);
		},
		competitors: {
			'es-toolkit': function () {
				return escape(plain);
			},
			lodash: function () {
				return lodash.escape(plain);
			}
		}
	},
	{
		name: 'escapeHtml (8 short strings)',
		fn: function () {
			return each(escapeHtml, names);
		},
		competitors: {
			'es-toolkit': function () {
				return each(escape, names);
			},
			lodash: function () {
				return each(lodash.escape, names);
			}
		}
	},
	{
		name: 'unescapeHtml (1.6 KB)',
		fn: function () {
			return unescapeHtml(escaped);
		},
		competitors: {
			'es-toolkit': function () {
				return unescape(escaped);
			},
			lodash: function () {
				return lodash.unescape(escaped);
			}
		}
	},
	{
		name: 'unescapeHtml (8 short strings)',
		fn: function () {
			return each(unescapeHtml, names);
		},
		competitors: {
			'es-toolkit': function () {
				return each(unescape, names);
			},
			lodash: function () {
				return each(lodash.unescape, names);
			}
		}
	},
	{
		name: 'escapeRegExp (8 short strings)',
		fn: function () {
			return each(escapeRegExp, regexSources);
		},
		competitors: {
			'es-toolkit': function () {
				return each(esEscapeRegExp, regexSources);
			},
			lodash: function () {
				return each(lodash.escapeRegExp, regexSources);
			}
		}
	},
	{
		name: 'trim (8 short strings)',
		fn: function () {
			return each(trim, padded);
		},
		competitors: {
			lodash: function () {
				return each(lodash.trim, padded);
			}
		}
	},
	{
		// Our `length` excludes the suffix; lodash's includes the omission, so it gets `length + 3` for the same output.
		name: 'truncate (800 chars to 20)',
		fn: function () {
			return truncate(plain, 20);
		},
		competitors: {
			'es-toolkit': function () {
				return esTruncate(plain, { length: 23 });
			},
			lodash: function () {
				return lodash.truncate(plain, { length: 23 });
			}
		}
	},
	{
		name: 'truncate (unicode 0.7 KB to 40)',
		fn: function () {
			return truncate(unicode, 40);
		},
		competitors: {
			'es-toolkit': function () {
				return esTruncate(unicode, { length: 43 });
			},
			lodash: function () {
				return lodash.truncate(unicode, { length: 43 });
			}
		}
	},
	{
		name: 'repeat (short string x 50)',
		fn: function () {
			return repeat('ab-', 50);
		},
		competitors: {
			'es-toolkit': function () {
				return esRepeat('ab-', 50);
			},
			lodash: function () {
				return lodash.repeat('ab-', 50);
			}
		}
	},
	{
		// Loose: lodash/es-toolkit compile a template once and call it; interpolate parses the template on every call.
		name: 'interpolate ~ template (4 placeholders)',
		fn: function () {
			return interpolate(template, values);
		},
		competitors: {
			'es-toolkit (precompiled)': function () {
				return compiledEs(values);
			},
			'lodash (precompiled)': function () {
				return compiledLodash(values);
			},
			'lodash (compile per call)': function () {
				return lodash.template(lodashTemplate)(values);
			}
		}
	},
	{
		// interpolate remembers the last template it parsed: alternating templates is its slowest pattern.
		name: 'interpolate ~ template (2 alternating templates)',
		fn: function () {
			return interpolate(template, values) + interpolate(otherTemplate, otherValues);
		},
		competitors: {
			'es-toolkit (precompiled)': function () {
				return compiledEs(values) + otherCompiledEs(otherValues);
			},
			'lodash (precompiled)': function () {
				return compiledLodash(values) + otherCompiledLodash(otherValues);
			}
		}
	},
	{
		name: 'getWords (640 chars)',
		fn: function () {
			return getWords(paragraph);
		},
		competitors: {
			'es-toolkit': function () {
				return words(paragraph);
			},
			lodash: function () {
				return lodash.words(paragraph);
			}
		}
	},
	{
		name: 'levenshtein (2 x 40 chars)',
		fn: function () {
			return levenshtein('the quick brown fox jumps over a lazy dog', 'a quick brown dog leaps over the lazy fox');
		}
	},
	{
		name: 'similarity (short words)',
		fn: function () {
			return similarity('kitten', 'sitting') + similarity('flaw', 'lawn');
		}
	}
];
