import * as dateFns from 'date-fns';
import {
	addBusinessDays,
	addDays,
	addMonths,
	addYears,
	diffInBusinessDays,
	diffInDays,
	diffInMonths,
	eachDayOfInterval,
	endOfDay,
	endOfMonth,
	formatDate,
	formatDuration,
	getISOWeek,
	getRelativeTime,
	isSameDay,
	isValidDate,
	parseDuration,
	parseISODate,
	startOfDay,
	startOfMonth,
	startOfWeek,
	toISODateString
} from '@emiliodominguez/tink/date';

// 100 deterministic dates spread over several years (local time).
const dates = Array.from({ length: 100 }, function (_, index) {
	return new Date(2020 + (index % 7), index % 12, (index % 28) + 1, index % 24, (index * 7) % 60, (index * 13) % 60, index * 9);
});
const isoStrings = dates.map(function (date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
});
const durations = dates.map(function (date) {
	return date.getTime() % 1_000_000_000;
});
const durationStrings = durations.map(function (ms, index) {
	return `${index}d ${ms % 24}h ${ms % 60}m ${(ms % 600) / 10}s`;
});
const mixedValues = dates.map(function (date, index) {
	return index % 3 === 0 ? new Date(NaN) : index % 3 === 1 ? date : date.getTime();
});

/**
 * Returns a benchmark body that runs `fn(date, index, other)` on every sample date (`other` is the mirrored sample)
 * and returns a checksum so the work cannot be optimized away. Each body is compiled separately (`new Function`) so
 * its call site stays monomorphic: closures of one function literal share type feedback, which would penalise every case.
 * @param {(date: Date, index: number, other: Date) => number} fn - The work to do for one date
 * @returns {() => number} The benchmark body
 */
function each(fn) {
	return new Function(
		'fn',
		'dates',
		'return function () { let total = 0; for (let i = 0; i < dates.length; i++) total += fn(dates[i], i, dates[dates.length - 1 - i]); return total; };'
	)(fn, dates);
}

/**
 * Builds a bench case running `ours` and the date-fns equivalent on every sample date.
 * @param {string} name - The case name
 * @param {(date: Date, index: number, other: Date) => number} ours - Our implementation
 * @param {(date: Date, index: number, other: Date) => number} [theirs] - The date-fns implementation
 * @returns {object} The bench case
 */
function dateCase(name, ours, theirs) {
	return theirs === undefined ? { name, fn: each(ours) } : { name, fn: each(ours), competitors: { 'date-fns': each(theirs) } };
}

export default [
	dateCase(
		"formatDate (100 × 'YYYY-MM-DD HH:mm:ss.SSS')",
		function (date) {
			return formatDate(date, 'YYYY-MM-DD HH:mm:ss.SSS').length;
		},
		function (date) {
			return dateFns.format(date, 'yyyy-MM-dd HH:mm:ss.SSS').length;
		}
	),
	dateCase(
		"formatDate (100 × 'D/M/YY h:mm A [at]')",
		function (date) {
			return formatDate(date, 'D/M/YY h:mm A [at]').length;
		},
		function (date) {
			return dateFns.format(date, "d/M/yy h:mm a 'at'").length;
		}
	),
	dateCase(
		'toISODateString (100)',
		function (date) {
			return toISODateString(date).length;
		},
		function (date) {
			return dateFns.format(date, 'yyyy-MM-dd').length;
		}
	),
	{
		name: 'parseISODate (100 × YYYY-MM-DD)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < isoStrings.length; i++) total += parseISODate(isoStrings[i]).getTime();
			return total;
		},
		competitors: {
			'date-fns parseISO': function () {
				let total = 0;
				for (let i = 0; i < isoStrings.length; i++) total += dateFns.parseISO(isoStrings[i]).getTime();
				return total;
			}
		}
	},
	{
		name: 'isValidDate (100 mixed values)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < mixedValues.length; i++) total += isValidDate(mixedValues[i]) ? 1 : 0;
			return total;
		},
		competitors: {
			// `isValid` also accepts timestamps, so it reports more values as valid; the work is comparable.
			'date-fns isValid': function () {
				let total = 0;
				for (let i = 0; i < mixedValues.length; i++) total += dateFns.isValid(mixedValues[i]) ? 1 : 0;
				return total;
			}
		}
	},
	dateCase(
		'addDays (100)',
		function (date, index) {
			return addDays(date, index - 50).getTime();
		},
		function (date, index) {
			return dateFns.addDays(date, index - 50).getTime();
		}
	),
	dateCase(
		'addMonths (100)',
		function (date, index) {
			return addMonths(date, index - 50).getTime();
		},
		function (date, index) {
			return dateFns.addMonths(date, index - 50).getTime();
		}
	),
	dateCase(
		'addYears (100)',
		function (date, index) {
			return addYears(date, index - 50).getTime();
		},
		function (date, index) {
			return dateFns.addYears(date, index - 50).getTime();
		}
	),
	dateCase(
		'addBusinessDays (100)',
		function (date, index) {
			return addBusinessDays(date, index - 50).getTime();
		},
		function (date, index) {
			return dateFns.addBusinessDays(date, index - 50).getTime();
		}
	),
	dateCase(
		'diffInDays (100)',
		function (date, _, other) {
			return diffInDays(date, other);
		},
		function (date, _, other) {
			return dateFns.differenceInCalendarDays(date, other);
		}
	),
	dateCase(
		'diffInMonths (100)',
		function (date, _, other) {
			return diffInMonths(date, other);
		},
		function (date, _, other) {
			return dateFns.differenceInMonths(date, other);
		}
	),
	dateCase(
		'diffInBusinessDays (100)',
		function (date, _, other) {
			return diffInBusinessDays(date, other);
		},
		function (date, _, other) {
			return dateFns.differenceInBusinessDays(date, other);
		}
	),
	dateCase(
		'startOfDay (100)',
		function (date) {
			return startOfDay(date).getTime();
		},
		function (date) {
			return dateFns.startOfDay(date).getTime();
		}
	),
	dateCase(
		'endOfDay (100)',
		function (date) {
			return endOfDay(date).getTime();
		},
		function (date) {
			return dateFns.endOfDay(date).getTime();
		}
	),
	dateCase(
		'startOfWeek (100, Monday)',
		function (date) {
			return startOfWeek(date, 1).getTime();
		},
		function (date) {
			return dateFns.startOfWeek(date, { weekStartsOn: 1 }).getTime();
		}
	),
	dateCase(
		'startOfMonth (100)',
		function (date) {
			return startOfMonth(date).getTime();
		},
		function (date) {
			return dateFns.startOfMonth(date).getTime();
		}
	),
	dateCase(
		'endOfMonth (100)',
		function (date) {
			return endOfMonth(date).getTime();
		},
		function (date) {
			return dateFns.endOfMonth(date).getTime();
		}
	),
	dateCase(
		'isSameDay (100)',
		function (date, _, other) {
			return isSameDay(date, other) ? 1 : 0;
		},
		function (date, _, other) {
			return dateFns.isSameDay(date, other) ? 1 : 0;
		}
	),
	dateCase(
		'getISOWeek (100)',
		function (date) {
			return getISOWeek(date);
		},
		function (date) {
			return dateFns.getISOWeek(date);
		}
	),
	dateCase(
		'getRelativeTime (100)',
		function (date, _, other) {
			return getRelativeTime(date, other).length;
		},
		function (date, _, other) {
			// Loosely equivalent: English words instead of Intl.RelativeTimeFormat.
			return dateFns.formatDistance(date, other, { addSuffix: true }).length;
		}
	),
	{
		name: 'eachDayOfInterval (1 year)',
		fn: function () {
			return eachDayOfInterval(dates[0], dates[12]);
		},
		competitors: {
			'date-fns': function () {
				return dateFns.eachDayOfInterval({ start: dates[0], end: dates[12] });
			}
		}
	},
	{
		name: 'formatDuration (100)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < durations.length; i++) length += formatDuration(durations[i]).length;
			return length;
		}
	},
	{
		name: 'parseDuration (100)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < durationStrings.length; i++) total += parseDuration(durationStrings[i]);
			return total;
		}
	}
];
