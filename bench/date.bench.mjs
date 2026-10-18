import * as dateFns from 'date-fns';
import {
	addBusinessDays,
	addDays,
	addDuration,
	addMonths,
	addYears,
	diffInBusinessDays,
	diffInCalendarMonths,
	diffInDays,
	diffInMonths,
	diffInWeeks,
	diffInYears,
	eachDayOfInterval,
	eachOfInterval,
	endOfDay,
	endOfHour,
	endOfMonth,
	formatDate,
	formatDuration,
	getDayOfYear,
	getISOWeek,
	getRelativeTime,
	intervalsOverlap,
	intervalToDuration,
	isSameDay,
	isSameQuarter,
	isSameWeek,
	isTomorrow,
	isValidDate,
	nextWeekday,
	parseDate,
	parseDuration,
	parseISODate,
	roundToNearestMinutes,
	startOfDay,
	startOfHour,
	startOfMinute,
	startOfMonth,
	startOfWeek,
	subDuration,
	toISODateString,
	toISOStringLocal
} from 'tinkjs/date';

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
const formatted = dates.map(function (date) {
	return formatDate(date, 'YYYY-MM-DD HH:mm:ss.SSS');
});
const duration = { years: 1, months: 2, weeks: 1, days: 3, hours: 4, minutes: 5, seconds: 6 };
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
	dateCase(
		'addDuration (100 × { y, mo, w, d, h, m, s })',
		function (date) {
			return addDuration(date, duration).getTime();
		},
		function (date) {
			return dateFns.add(date, duration).getTime();
		}
	),
	dateCase(
		'subDuration (100 × { y, mo, w, d, h, m, s })',
		function (date) {
			return subDuration(date, duration).getTime();
		},
		function (date) {
			return dateFns.sub(date, duration).getTime();
		}
	),
	dateCase(
		'intervalToDuration (100 pairs)',
		function (date, index, other) {
			return intervalToDuration(date, other).days;
		},
		function (date, index, other) {
			return dateFns.intervalToDuration({ start: date, end: other }).days ?? 0;
		}
	),
	dateCase(
		'toISOStringLocal (100) vs formatISO',
		function (date) {
			return toISOStringLocal(date, { milliseconds: false }).length;
		},
		function (date) {
			return dateFns.formatISO(date).length;
		}
	),
	dateCase(
		'diffInWeeks (100 pairs)',
		function (date, index, other) {
			return diffInWeeks(date, other);
		},
		function (date, index, other) {
			return dateFns.differenceInWeeks(date, other);
		}
	),
	dateCase(
		'diffInYears (100 pairs)',
		function (date, index, other) {
			return diffInYears(date, other);
		},
		function (date, index, other) {
			return dateFns.differenceInYears(date, other);
		}
	),
	dateCase(
		'diffInCalendarMonths (100 pairs)',
		function (date, index, other) {
			return diffInCalendarMonths(date, other);
		},
		function (date, index, other) {
			return dateFns.differenceInCalendarMonths(date, other);
		}
	),
	dateCase(
		'startOfHour (100)',
		function (date) {
			return startOfHour(date).getTime();
		},
		function (date) {
			return dateFns.startOfHour(date).getTime();
		}
	),
	dateCase(
		'endOfHour (100)',
		function (date) {
			return endOfHour(date).getTime();
		},
		function (date) {
			return dateFns.endOfHour(date).getTime();
		}
	),
	dateCase(
		'startOfMinute (100)',
		function (date) {
			return startOfMinute(date).getTime();
		},
		function (date) {
			return dateFns.startOfMinute(date).getTime();
		}
	),
	dateCase(
		'roundToNearestMinutes (100, 15 min)',
		function (date) {
			return roundToNearestMinutes(date, 15).getTime();
		},
		function (date) {
			return dateFns.roundToNearestMinutes(date, { nearestTo: 15 }).getTime();
		}
	),
	dateCase(
		'nextWeekday (100)',
		function (date, index) {
			return nextWeekday(date, index % 7).getTime();
		},
		function (date, index) {
			return dateFns.nextDay(date, index % 7).getTime();
		}
	),
	dateCase(
		'intervalsOverlap (100 pairs)',
		function (date, index, other) {
			return intervalsOverlap({ start: date, end: dates[(index + 1) % 100] < date ? date : dates[(index + 1) % 100] }, { start: other, end: other }, { inclusive: true })
				? 1
				: 0;
		},
		function (date, index, other) {
			return dateFns.areIntervalsOverlapping(
				{ start: date, end: dates[(index + 1) % 100] < date ? date : dates[(index + 1) % 100] },
				{ start: other, end: other },
				{ inclusive: true }
			)
				? 1
				: 0;
		}
	),
	dateCase(
		'getDayOfYear (100)',
		function (date) {
			return getDayOfYear(date);
		},
		function (date) {
			return dateFns.getDayOfYear(date);
		}
	),
	dateCase(
		'isSameWeek (100 pairs)',
		function (date, index, other) {
			return isSameWeek(date, other, 1) ? 1 : 0;
		},
		function (date, index, other) {
			return dateFns.isSameWeek(date, other, { weekStartsOn: 1 }) ? 1 : 0;
		}
	),
	dateCase(
		'isSameQuarter (100 pairs)',
		function (date, index, other) {
			return isSameQuarter(date, other) ? 1 : 0;
		},
		function (date, index, other) {
			return dateFns.isSameQuarter(date, other) ? 1 : 0;
		}
	),
	dateCase(
		'isTomorrow (100)',
		function (date) {
			return isTomorrow(date) ? 1 : 0;
		},
		function (date) {
			return dateFns.isTomorrow(date) ? 1 : 0;
		}
	),
	dateCase(
		"parseDate (100 × 'YYYY-MM-DD HH:mm:ss.SSS')",
		function (date, index) {
			return parseDate(formatted[index], 'YYYY-MM-DD HH:mm:ss.SSS').getTime();
		},
		function (date, index) {
			return dateFns.parse(formatted[index], 'yyyy-MM-dd HH:mm:ss.SSS', 0).getTime();
		}
	),
	{
		name: 'eachOfInterval (1 year of months)',
		fn: function () {
			return eachOfInterval(dates[0], dates[12], 'month');
		},
		competitors: {
			'date-fns': function () {
				return dateFns.eachMonthOfInterval({ start: dates[0], end: dates[12] });
			}
		}
	},
	{
		name: 'eachOfInterval (1 week of hours)',
		fn: function () {
			return eachOfInterval(dates[0], dates[0].getTime() + 7 * 86_400_000, 'hour');
		},
		competitors: {
			'date-fns': function () {
				return dateFns.eachHourOfInterval({ start: dates[0], end: dates[0].getTime() + 7 * 86_400_000 });
			}
		}
	},
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
