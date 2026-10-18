// Runs the edge cases listed in the README against tink and the libraries it is compared with, and prints the results.
// Every row is computed live: `yarn build && yarn compare` (add `--markdown` for the README table).
process.env.TZ = 'America/New_York'; // the DST rows need a zone with a fall-back hour; Node applies TZ changes at runtime

const tink = {
	arrays: await import('@emiliodominguez/tink/arrays'),
	async: await import('@emiliodominguez/tink/async'),
	date: await import('@emiliodominguez/tink/date'),
	math: await import('@emiliodominguez/tink/math'),
	objects: await import('@emiliodominguez/tink/objects'),
	strings: await import('@emiliodominguez/tink/strings'),
	url: await import('@emiliodominguez/tink/url')
};
const toolkit = await import('es-toolkit');
const lodash = await import('lodash-es');
const radash = await import('radash');
const remeda = await import('remeda');
const dateFns = await import('date-fns');
const ufo = await import('ufo');
const bytes = (await import('bytes')).default;
const { readFileSync } = await import('node:fs');

/**
 * Reads the installed version of a dev dependency (some packages do not export their package.json).
 * @param {string} name - The package name
 * @returns {string} Its version
 */
function versionOf(name) {
	return JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
}

/**
 * Formats a result for the table.
 * @param {unknown} value - The value to show
 * @returns {string} A compact, unambiguous rendering
 */
function show(value) {
	if (value instanceof Error) return `throws ${value.name}`;
	if (value instanceof Date) return value.toTimeString().slice(0, 17);
	if (value === undefined) return 'undefined';
	if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
	if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
	return JSON.stringify(value);
}

/**
 * Calls `fn`, returning its result or the error it threw.
 * @param {() => unknown} fn - The call
 * @returns {Promise<unknown>} The result or the error
 */
async function capture(fn) {
	try {
		return await fn();
	} catch (error) {
		return error;
	}
}

/**
 * Plucks `v` from each row of an ordering result.
 * @param {Array<{ v: unknown }>} rows - The sorted rows
 * @returns {unknown[]} The keys, in order
 */
function keys(rows) {
	return rows.map(function (row) {
		return row.v;
	});
}

const unordered = [{ v: 2 }, { v: NaN }, { v: 1 }, { v: 3 }];
const withUndefined = [{ v: 2 }, { v: undefined }, { v: 1 }, { v: 3 }];
const fallBackEst = new Date(new Date(2024, 10, 3, 1, 30).getTime() + 3_600_000); // 01:30 EST, the second 01:30 of the day

/**
 * Builds a function that fails on its first call only (a transient error).
 * @returns {() => Promise<string>} The flaky function
 */
function flaky() {
	let calls = 0;
	return async function () {
		calls++;
		if (calls === 1) throw new Error('transient');
		return 'ok';
	};
}

const CASES = [
	{
		topic: 'Float sums',
		library: 'lodash',
		pkg: 'lodash-es',
		call: 'sum([0.1, 0.2, 0.3])',
		theirs: function () {
			return lodash.sum([0.1, 0.2, 0.3]);
		},
		ours: function () {
			return tink.math.sum([0.1, 0.2, 0.3]);
		}
	},
	{
		topic: 'Sorting with NaN',
		library: 'es-toolkit',
		call: "orderBy(rows, ['v'])  // v: 2, NaN, 1, 3",
		theirs: function () {
			return keys(toolkit.orderBy(unordered, ['v'], ['asc']));
		},
		ours: function () {
			return keys(
				tink.arrays.orderBy(unordered, [
					function (row) {
						return row.v;
					}
				])
			);
		}
	},
	{
		topic: 'Sorting with undefined',
		library: 'remeda',
		call: 'sortBy(rows, byV)  // v: 2, undefined, 1, 3',
		theirs: function () {
			return keys(
				remeda.sortBy(withUndefined, function (row) {
					return row.v;
				})
			);
		},
		ours: function () {
			return keys(
				tink.arrays.sortBy(withUndefined, function (row) {
					return row.v;
				})
			);
		}
	},
	{
		topic: 'Hostile keys',
		library: 'es-toolkit',
		call: "zipObject(['__proto__'], [{ isAdmin: true }]).isAdmin",
		theirs: function () {
			return toolkit.zipObject(['__proto__'], [{ isAdmin: true }]).isAdmin;
		},
		ours: function () {
			return tink.arrays.zipObject(['__proto__'], [{ isAdmin: true }]).isAdmin;
		}
	},
	{
		topic: 'Prototype pollution',
		library: 'radash',
		call: "set({}, '__proto__.polluted', true); ({}).polluted",
		theirs: function () {
			radash.set({}, '__proto__.polluted', true);
			const polluted = {}.polluted;
			delete Object.prototype.polluted;
			return polluted;
		},
		ours: function () {
			tink.objects.setInObjectByKeys({}, '__proto__.polluted', true);
			return {}.polluted;
		}
	},
	{
		topic: 'Silent data loss',
		library: 'es-toolkit',
		call: 'toCamelCaseKeys({ user_id: 1, userId: 2 })',
		theirs: function () {
			return toolkit.toCamelCaseKeys({ user_id: 1, userId: 2 });
		},
		ours: function () {
			return tink.objects.toCamelCaseKeys({ user_id: 1, userId: 2 });
		}
	},
	{
		topic: 'Emoji padding',
		library: 'es-toolkit',
		call: "pad('👍', 5, '*')",
		theirs: function () {
			return toolkit.pad('👍', 5, '*');
		},
		ours: function () {
			return tink.strings.padCenter('👍', 5, '*');
		}
	},
	{
		topic: 'Emoji trimming',
		library: 'es-toolkit',
		call: "trim('👍🏽x👍🏽', '👍')",
		theirs: function () {
			return toolkit.trim('👍🏽x👍🏽', '👍');
		},
		ours: function () {
			return tink.strings.trimChars('👍🏽x👍🏽', '👍');
		}
	},
	{
		topic: 'Unit parsing',
		library: 'bytes',
		call: "parse('1KiB')",
		theirs: function () {
			return bytes.parse('1KiB');
		},
		ours: function () {
			return tink.math.parseBytes('1KiB');
		}
	},
	{
		topic: 'URL editing',
		library: 'ufo',
		call: "withTrailingSlash('/a?x=1')",
		theirs: function () {
			return ufo.withTrailingSlash('/a?x=1');
		},
		ours: function () {
			return tink.url.withTrailingSlash('/a?x=1');
		}
	},
	{
		topic: 'URL editing',
		library: 'ufo',
		call: "cleanDoubleSlashes('//cdn.example//a')",
		theirs: function () {
			return ufo.cleanDoubleSlashes('//cdn.example//a');
		},
		ours: function () {
			return tink.url.cleanDoubleSlashes('//cdn.example//a');
		}
	},
	{
		topic: 'DST (New York)',
		library: 'date-fns',
		call: 'startOfHour(01:30 EST on fall-back day)',
		theirs: function () {
			return dateFns.startOfHour(fallBackEst);
		},
		ours: function () {
			return tink.date.startOfHour(fallBackEst);
		}
	},
	{
		topic: 'DST (New York)',
		library: 'date-fns',
		call: 'hours from 00:00 to 03:00 on fall-back day',
		theirs: function () {
			return dateFns.eachHourOfInterval({ start: new Date(2024, 10, 3, 0), end: new Date(2024, 10, 3, 3) }).length;
		},
		ours: function () {
			return tink.date.eachOfInterval(new Date(2024, 10, 3, 0), new Date(2024, 10, 3, 3), 'hour').length;
		}
	},
	{
		topic: 'Async memoization',
		library: 'es-toolkit',
		call: 'memoize(fetcher) after one transient failure',
		theirs: async function () {
			const fetcher = toolkit.memoize(flaky());
			await capture(fetcher);
			return fetcher();
		},
		ours: async function () {
			const fetcher = tink.async.memoizeAsync(flaky());
			await capture(fetcher);
			return fetcher();
		}
	}
];

const markdown = process.argv.includes('--markdown');
const rows = [];
for (const { topic, library, pkg = library, call, theirs, ours } of CASES) {
	const version = versionOf(pkg);
	rows.push([topic, `\`${library}@${version}\``, `\`${call}\``, show(await capture(theirs)), show(await capture(ours))]);
}

if (markdown) {
	console.log('| Case | Library | Call | Library returns | tink returns |\n| --- | --- | --- | --- | --- |');
	for (const row of rows) {
		console.log(`| ${row.slice(0, 3).join(' | ')} | \`${row[3]}\` | \`${row[4]}\` |`);
	}
} else {
	for (const [topic, library, call, theirs, ours] of rows) console.log(`${topic} · ${library} · ${call}\n    library: ${theirs}\n    tink:    ${ours}`);
}
