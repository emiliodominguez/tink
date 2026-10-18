import bytes from 'bytes';
import * as esToolkit from 'es-toolkit';
import * as esToolkitCompat from 'es-toolkit/compat';
import * as lodash from 'lodash-es';
import {
	average,
	ceil,
	clamp,
	cumulativeSum,
	floor,
	formatBytes,
	inRange,
	median,
	normalize,
	parseBytes,
	quantile,
	randomBetween,
	randomIntBetween,
	round,
	roundToStep,
	sum,
	variance,
	weightedAverage
} from 'tinkjs/math';

// Deterministic pseudo-random data (no Math.random, so every run measures the same work).
const large = Array.from({ length: 100_000 }, function (_, index) {
	return ((index * 7919) % 10_007) / 7.3 - 500;
});
const medium = large.slice(0, 10_000);
const thousand = large.slice(0, 1000);
const ten = large.slice(0, 10);
const integers = Array.from({ length: 1000 }, function (_, index) {
	return (index * 7919) % 1009;
});
const weights = medium.map(function (_, index) {
	return (index % 13) + 1;
});
const toRound = medium.slice(0, 1000);
const byteStrings = Array.from({ length: 1000 }, function (_, index) {
	return `${((index * 7.31) % 1000) | 0}.${index % 10} ${['B', 'kB', 'MB', 'GB'][index % 4]}`;
});
const byteCounts = Array.from({ length: 1000 }, function (_, index) {
	return index * index * 1234.5;
});

/**
 * Builds a bench case that applies a binary scalar function to the 1000 `toRound` values and sums the results.
 * @param {string} name - The case name
 * @param {(value: number, index: number) => number} ours - Our implementation
 * @param {Record<string, (value: number, index: number) => number>} others - Competitor implementations
 * @returns {object} The bench case
 */
function scalarCase(name, ours, others) {
	/**
	 * Wraps a scalar function into a loop over the sample values. Each loop is compiled separately (`new Function`) so
	 * its call site stays monomorphic: closures from one function literal share type feedback, which would penalise every case.
	 * @param {(value: number, index: number) => number} fn - The scalar function
	 * @returns {() => number} The looping benchmark body
	 */
	function loop(fn) {
		return new Function('fn', 'values', 'return function () { let total = 0; for (let i = 0; i < values.length; i++) total += fn(values[i], i); return total; };')(
			fn,
			toRound
		);
	}
	const competitors = {};
	for (const [label, fn] of Object.entries(others)) competitors[label] = loop(fn);
	return { name, fn: loop(ours), competitors };
}

/**
 * Returns a separately compiled `() => fn(input)` (see `loop` in {@link scalarCase} for why).
 * @param {(input: number[]) => number} fn - The function to call
 * @param {number[]} input - Its argument
 * @returns {() => number} The benchmark body
 */
function bind(fn, input) {
	return new Function('fn', 'input', 'return function () { return fn(input); };')(fn, input);
}

/**
 * Builds sum/average/median cases over several input sizes.
 * @param {string} label - The helper name
 * @param {(numbers: number[]) => number} ours - Our implementation
 * @param {Record<string, (numbers: number[]) => number>} others - Competitor implementations
 * @returns {object[]} One case per input size
 */
function sizedCases(label, ours, others) {
	return [
		['10', ten],
		['1k', thousand],
		['100k', large]
	].map(function ([size, input]) {
		const competitors = {};
		for (const [name, fn] of Object.entries(others)) competitors[name] = bind(fn, input);
		return { name: `${label} (${size} floats)`, fn: bind(ours, input), competitors };
	});
}

export default [
	...sizedCases('sum', sum, { 'es-toolkit': esToolkit.sum, lodash: lodash.sum }),
	{
		name: 'sum (1k integers)',
		fn: bind(sum, integers),
		competitors: { 'es-toolkit': bind(esToolkit.sum, integers), lodash: bind(lodash.sum, integers) }
	},
	...sizedCases('average', average, { 'es-toolkit': esToolkit.mean, lodash: lodash.mean }),
	...sizedCases('median', median, { 'es-toolkit': esToolkit.median }),
	{
		name: 'quantile (10k floats, q = 0.9)',
		fn: function () {
			return quantile(medium, 0.9);
		},
		competitors: {
			// Nearest-rank instead of linear interpolation, but the same sort-dominated work.
			'es-toolkit percentile': function () {
				return esToolkit.percentile(medium, 90);
			}
		}
	},
	{
		name: 'variance (100k floats)',
		fn: function () {
			return variance(large);
		}
	},
	{
		name: 'cumulativeSum (10k floats)',
		fn: function () {
			return cumulativeSum(medium);
		}
	},
	{
		name: 'weightedAverage (10k floats)',
		fn: function () {
			return weightedAverage(medium, weights);
		}
	},
	{
		name: 'normalize (10k floats)',
		fn: function () {
			return normalize(medium);
		}
	},
	scalarCase(
		'round (1000 floats, 2 decimals)',
		function (value) {
			return round(value, 2);
		},
		{
			'es-toolkit': function (value) {
				return esToolkit.round(value, 2);
			},
			lodash: function (value) {
				return lodash.round(value, 2);
			}
		}
	),
	scalarCase(
		'round (1000 floats, 0 decimals)',
		function (value) {
			return round(value);
		},
		{
			'es-toolkit': function (value) {
				return esToolkit.round(value);
			},
			lodash: function (value) {
				return lodash.round(value);
			}
		}
	),
	scalarCase(
		'ceil (1000 floats, 2 decimals)',
		function (value) {
			return ceil(value, 2);
		},
		{
			'es-toolkit': function (value) {
				return esToolkitCompat.ceil(value, 2);
			},
			lodash: function (value) {
				return lodash.ceil(value, 2);
			}
		}
	),
	scalarCase(
		'floor (1000 floats, 2 decimals)',
		function (value) {
			return floor(value, 2);
		},
		{
			'es-toolkit': function (value) {
				return esToolkitCompat.floor(value, 2);
			},
			lodash: function (value) {
				return lodash.floor(value, 2);
			}
		}
	),
	scalarCase(
		'floor (1000 floats, 0 decimals)',
		function (value) {
			return floor(value);
		},
		{
			lodash: function (value) {
				return lodash.floor(value);
			}
		}
	),
	scalarCase(
		'clamp (1000 floats)',
		function (value) {
			return clamp(value, -100, 100);
		},
		{
			'es-toolkit': function (value) {
				return esToolkit.clamp(value, -100, 100);
			},
			lodash: function (value) {
				return lodash.clamp(value, -100, 100);
			}
		}
	),
	scalarCase(
		'inRange (1000 floats)',
		function (value) {
			return inRange(value, -100, 100) ? 1 : 0;
		},
		{
			'es-toolkit': function (value) {
				return esToolkit.inRange(value, -100, 100) ? 1 : 0;
			},
			lodash: function (value) {
				return lodash.inRange(value, -100, 100) ? 1 : 0;
			}
		}
	),
	scalarCase(
		'randomBetween (1000 draws)',
		function (value) {
			return randomBetween(value, value + 10);
		},
		{
			'es-toolkit random': function (value) {
				return esToolkit.random(value, value + 10);
			},
			lodash: function (value) {
				return lodash.random(value, value + 10, true);
			}
		}
	),
	{
		name: 'randomIntBetween (1000 draws)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < integers.length; i++) total += randomIntBetween(integers[i], integers[i] + 10);
			return total;
		},
		competitors: {
			// Exclusive upper bound: + 11 draws from the same 11 integers.
			'es-toolkit randomInt': function () {
				let total = 0;
				for (let i = 0; i < integers.length; i++) total += esToolkit.randomInt(integers[i], integers[i] + 11);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < integers.length; i++) total += lodash.random(integers[i], integers[i] + 10);
				return total;
			}
		}
	},
	scalarCase(
		'roundToStep (1000 floats, step 0.25)',
		function (value) {
			return roundToStep(value, 0.25);
		},
		{}
	),
	{
		name: 'formatBytes (1000 values)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < byteCounts.length; i++) length += formatBytes(byteCounts[i]).length;
			return length;
		}
	},
	{
		name: 'parseBytes (1000 strings)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < byteStrings.length; i++) total += parseBytes(byteStrings[i]);
			return total;
		},
		competitors: {
			bytes: function () {
				let total = 0;
				for (let i = 0; i < byteStrings.length; i++) total += bytes.parse(byteStrings[i]);
				return total;
			}
		}
	}
];
