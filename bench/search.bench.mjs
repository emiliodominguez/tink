import Fuse from 'fuse.js';
import { createSearchIndex, fuzzyMatch, fuzzySearch, highlight, tokenize } from 'tinkit/search';

// Deterministic command-palette-like labels: "Category: Verb Noun", dotted command ids and file paths.
const categories = ['File', 'Edit', 'View', 'Git', 'Terminal', 'Debug', 'Search', 'Editor', 'Workspace', 'Preferences', 'Format', 'Refactor'];
const verbs = ['Open', 'Close', 'Toggle', 'Show', 'Hide', 'Run', 'Stop', 'Select', 'Copy', 'Move', 'Rename', 'Delete', 'Reveal', 'Focus', 'Reload', 'Commit'];
const nouns = [
	'File',
	'Folder',
	'Panel',
	'Sidebar',
	'Terminal',
	'Breakpoint',
	'Selection',
	'Line',
	'Word Wrap',
	'Minimap',
	'Settings',
	'Keyboard Shortcuts',
	'Recent',
	'Branch',
	'Changes',
	'Document'
];
const dirs = ['src', 'lib', 'test', 'docs', 'packages/core', 'packages/ui', 'scripts', 'components'];

/**
 * Builds `count` deterministic labels.
 * @param {number} count - Number of labels
 * @returns {string[]} The labels
 */
function labels(count) {
	return Array.from({ length: count }, function (_, i) {
		const a = (i * 7919) % 9973;
		switch (i % 3) {
			case 0:
				return `${categories[a % categories.length]}: ${verbs[(a >> 3) % verbs.length]} ${nouns[(a >> 5) % nouns.length]}`;
			case 1:
				return `${categories[a % categories.length].toLowerCase()}.action.${verbs[(a >> 2) % verbs.length].toLowerCase()}${nouns[(a >> 4) % nouns.length].replace(' ', '')}`;
			default:
				return `${dirs[a % dirs.length]}/${nouns[(a >> 3) % nouns.length].replace(' ', '-').toLowerCase()}/${verbs[(a >> 6) % verbs.length].toLowerCase()}${i}.ts`;
		}
	});
}

const small = labels(1000);
const large = labels(10_000);
const fuseSmall = new Fuse(small, { includeScore: true, includeMatches: true });
const fuseLarge = new Fuse(large, { includeScore: true, includeMatches: true });
const commands = small.map(function (title, id) {
	return { id, title };
});
const fuseCommands = new Fuse(commands, { keys: ['title'], includeScore: true, includeMatches: true });
const longTarget = `${'packages/core/src/'.repeat(12)}components/editor/toggleWordWrap.ts`;
const cyrillicWords = ['Открыть', 'файл', 'Закрыть', 'панель', 'Показать', 'терминал', 'Скрыть', 'боковую', 'Перейти', 'строку'];
const accentedWords = ['Café', 'Crème', 'Zürich', 'Málaga', 'São', 'Paulo', 'Ångström', 'Øresund', 'Łódź', 'Straße'];
const cyrillic = small.map(function (_, i) {
	return `${cyrillicWords[i % 10]} ${cyrillicWords[(i * 7) % 10]} ${cyrillicWords[(i * 3) % 10]} ${i}`;
});
const accented = small.map(function (_, i) {
	return `${accentedWords[i % 10]} ${accentedWords[(i * 7) % 10]} ${accentedWords[(i * 3) % 10]} ${i}`;
});
const fuseCyrillic = new Fuse(cyrillic, { includeScore: true, includeMatches: true });
const fuseAccented = new Fuse(accented, { includeScore: true, includeMatches: true, ignoreDiacritics: true });
const matchRanges = fuzzyMatch('ctww', longTarget).ranges;

// A deterministic 10k-document corpus for the BM25 index: a 4,000-word vocabulary of syllable words drawn with a Zipf-like skew,
// a 4–7-word title and a 30–59-word body per document.
const syllables = ['ka', 'lo', 'mi', 'ne', 'ru', 'ta', 'shi', 'po', 'den', 'var', 'ix', 'el', 'om', 'tra', 'ber', 'qu'];
const vocabulary = Array.from({ length: 4000 }, function (_, i) {
	let word = '';
	let x = (i * 2654435761) >>> 0;
	for (let k = 0, n = 2 + (x % 3); k < n; k++) {
		word += syllables[x % 16];
		x = Math.floor(x / 16) + k * 7;
	}
	return word;
});
let state = 12345;

/**
 * Draws a word, frequent words first (deterministic linear congruential generator).
 * @returns {string} A word of the vocabulary
 */
function drawWord() {
	state = (state * 1103515245 + 12345) & 0x7fffffff;
	return vocabulary[Math.floor(vocabulary.length * (state / 0x7fffffff) ** 3)];
}

/**
 * Draws a phrase.
 * @param {number} length - Number of words
 * @returns {string} The words, separated by spaces
 */
function drawPhrase(length) {
	return Array.from({ length }, drawWord).join(' ');
}

const documents = Array.from({ length: 10_000 }, function (_, id) {
	return { id, title: drawPhrase(4 + (id % 4)), body: drawPhrase(30 + (id % 30)) };
});
const fields = { title: 2, body: 1 };

/**
 * Builds the BM25 index of the corpus.
 * @returns {import('tinkit/search').SearchIndex<{ id: number; title: string; body: string }>} The index
 */
function buildIndex() {
	const built = createSearchIndex({ fields });
	built.addAll(documents);
	return built;
}

const searchIndex = buildIndex();
const fuseDocuments = new Fuse(documents, {
	keys: [
		{ name: 'title', weight: 2 },
		{ name: 'body', weight: 1 }
	]
});
const tokenized = documents.map(function (document) {
	return [tokenize(document.title), tokenize(document.body)];
});

/**
 * Naive BM25 without an inverted index: scans every pre-tokenized document for every query term (same scores as the index).
 * @param {string} query - The query
 * @param {number} limit - Number of results
 * @returns {Array<{ id: number, score: number }>} The best documents
 */
function naiveSearch(query, limit) {
	const terms = [...new Set(tokenize(query))];
	const boosts = [fields.title, fields.body];
	const average = [0, 1].map(function (f) {
		return (
			tokenized.reduce(function (sum, document) {
				return sum + document[f].length;
			}, 0) / tokenized.length
		);
	});
	const idf = terms.map(function (term) {
		return [0, 1].map(function (f) {
			const n = tokenized.filter(function (document) {
				return document[f].includes(term);
			}).length;
			return Math.log(1 + (tokenized.length - n + 0.5) / (n + 0.5));
		});
	});
	const results = [];
	tokenized.forEach(function (document, id) {
		let score = 0;
		terms.forEach(function (term, q) {
			for (let f = 0; f < 2; f++) {
				let tf = 0;
				for (const word of document[f]) if (word === term) tf++;
				if (tf > 0) score += (boosts[f] * idf[q][f] * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * document[f].length) / average[f]));
			}
		});
		if (score > 0) results.push({ id, score });
	});
	return results
		.sort(function (a, b) {
			return b.score - a.score || a.id - b.id;
		})
		.slice(0, limit);
}

const [common, middle, rare] = [vocabulary[0], vocabulary[40], vocabulary[900]];
const threeTerms = `${common} ${middle} ${rare}`;
const body = documents[1].body;

export default [
	{
		name: 'createSearchIndex (10k docs, 2 fields, addAll)',
		fn: buildIndex,
		competitors: {
			'fuse.js': function () {
				return new Fuse(documents, { keys: ['title', 'body'] });
			}
		}
	},
	{
		name: 'SearchIndex.search (10k docs, term in 95%, limit 10)',
		fn: function () {
			return searchIndex.search(common, { limit: 10 });
		},
		baseline: function () {
			return naiveSearch(common, 10);
		},
		competitors: {
			'fuse.js': function () {
				return fuseDocuments.search(common, { limit: 10 });
			}
		}
	},
	{
		name: 'SearchIndex.search (10k docs, term in 6%, limit 10)',
		fn: function () {
			return searchIndex.search(middle, { limit: 10 });
		},
		baseline: function () {
			return naiveSearch(middle, 10);
		},
		competitors: {
			'fuse.js': function () {
				return fuseDocuments.search(middle, { limit: 10 });
			}
		}
	},
	{
		name: 'SearchIndex.search (10k docs, rare term, limit 10)',
		fn: function () {
			return searchIndex.search(rare, { limit: 10 });
		},
		baseline: function () {
			return naiveSearch(rare, 10);
		}
	},
	{
		name: 'SearchIndex.search (10k docs, 3 terms, limit 10)',
		fn: function () {
			return searchIndex.search(threeTerms, { limit: 10 });
		},
		baseline: function () {
			return naiveSearch(threeTerms, 10);
		}
	},
	{
		name: 'SearchIndex.search (10k docs, term in 95%, all)',
		fn: function () {
			return searchIndex.search(common);
		},
		baseline: function () {
			return naiveSearch(common, Infinity);
		}
	},
	{
		name: 'SearchIndex.search (10k docs, and + last prefix)',
		fn: function () {
			return searchIndex.search(`${common} ${middle.slice(0, 3)}`, { prefix: 'last', combine: 'and', limit: 10 });
		}
	},
	{
		name: 'SearchIndex remove + add (10k docs)',
		fn: function () {
			searchIndex.remove(5);
			searchIndex.add(documents[5]);
		}
	},
	{
		// The same document over and over (a live-edited one): its id and its own terms are overwritten, never deleted and re-added.
		name: 'SearchIndex.replace (10k docs, the same document)',
		fn: function () {
			return searchIndex.replace(documents[7]);
		}
	},
	{
		name: 'tokenize (50-word text)',
		fn: function () {
			return tokenize(body);
		},
		baseline: function () {
			return body.toLowerCase().split(/[^\p{L}\p{N}]+/u);
		}
	},
	{
		name: 'tokenize (50-word text, ignoreDiacritics)',
		fn: function () {
			return tokenize(body, { ignoreDiacritics: true });
		}
	},
	{
		name: 'fuzzySearch (1k labels, "delch")',
		fn: function () {
			return fuzzySearch(small, 'delch');
		},
		competitors: {
			'fuse.js': function () {
				return fuseSmall.search('delch');
			}
		}
	},
	{
		name: 'fuzzySearch (1k labels, "git")',
		fn: function () {
			return fuzzySearch(small, 'git');
		},
		competitors: {
			'fuse.js': function () {
				return fuseSmall.search('git');
			}
		}
	},
	{
		name: 'fuzzySearch (1k labels, no match "zqx")',
		fn: function () {
			return fuzzySearch(small, 'zqx');
		},
		competitors: {
			'fuse.js': function () {
				return fuseSmall.search('zqx');
			}
		}
	},
	{
		name: 'fuzzySearch (10k labels, "opfl")',
		fn: function () {
			return fuzzySearch(large, 'opfl');
		},
		competitors: {
			'fuse.js': function () {
				return fuseLarge.search('opfl');
			}
		}
	},
	{
		name: 'fuzzySearch (10k labels, "e")',
		fn: function () {
			return fuzzySearch(large, 'e');
		},
		competitors: {
			'fuse.js': function () {
				return fuseLarge.search('e');
			}
		}
	},
	{
		name: 'fuzzySearch (10k labels, no match "zqx")',
		fn: function () {
			return fuzzySearch(large, 'zqx');
		},
		competitors: {
			'fuse.js': function () {
				return fuseLarge.search('zqx');
			}
		}
	},
	{
		name: 'fuzzySearch (1k objects, key, limit 10)',
		fn: function () {
			return fuzzySearch(commands, 'shterm', {
				key: function (command) {
					return command.title;
				},
				limit: 10
			});
		},
		competitors: {
			'fuse.js': function () {
				return fuseCommands.search('shterm', { limit: 10 });
			}
		}
	},
	{
		name: 'fuzzySearch (1k Cyrillic labels, "офз")',
		fn: function () {
			return fuzzySearch(cyrillic, 'офз');
		},
		competitors: {
			'fuse.js': function () {
				return fuseCyrillic.search('офз');
			}
		}
	},
	{
		name: 'fuzzySearch (1k accented labels, "zur", ignoreDiacritics)',
		fn: function () {
			return fuzzySearch(accented, 'zur', { ignoreDiacritics: true });
		},
		competitors: {
			'fuse.js (ignoreDiacritics)': function () {
				return fuseAccented.search('zur');
			}
		}
	},
	{
		name: 'fuzzyMatch (1k labels, "rnm")',
		fn: function () {
			let total = 0;
			for (let i = 0; i < small.length; i++) total += fuzzyMatch('rnm', small[i])?.score ?? 0;
			return total;
		}
	},
	{
		name: 'fuzzyMatch (250-char path, "ctww")',
		fn: function () {
			return fuzzyMatch('ctww', longTarget);
		}
	},
	{
		name: 'highlight (250-char path, 4 ranges)',
		fn: function () {
			return highlight(longTarget, matchRanges);
		}
	}
];
