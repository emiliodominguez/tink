import Fuse from 'fuse.js';
import { fuzzyMatch, fuzzySearch, highlight } from 'tinkjs/search';

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
const matchRanges = fuzzyMatch('ctww', longTarget).ranges;

export default [
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
