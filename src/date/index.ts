/**
 * Date helpers.
 *
 * Conventions shared by every function in this module:
 * - **Local time.** All calendar fields (year, month, day, weekday, hours…) are read and written in the
 *   runtime's LOCAL time zone, exactly like `Date#getDate()` / `Date#setDate()`. Nothing here uses UTC
 *   unless its name says so.
 * - **Pure.** Inputs are never mutated; every function that returns a date returns a NEW `Date` instance.
 * - **Inputs.** Every date parameter accepts a {@link DateInput}: a `Date` or a millisecond timestamp. Dates created in another
 *   realm (iframe, `vm` context) are accepted; objects that merely inherit from `Date.prototype` are not.
 * - **Invalid dates.** Every function except {@link isValidDate} throws `RangeError('Invalid date')` when
 *   given an invalid date (`new Date(NaN)`, `NaN`, `Infinity`…), and `TypeError` when given something that is
 *   neither a `Date` nor a number.
 * - **DST safety.** Calendar arithmetic (`addDays`, `addMonths`, `startOfWeek`…) works on local calendar fields,
 *   so "one day later" keeps the wall-clock time even across a daylight-saving transition (the day may then last
 *   23 or 25 hours). Calendar-day differences are computed from the local calendar fields, never by dividing a
 *   millisecond delta by 86 400 000. When a wall-clock time does not exist on the target day (it falls inside a
 *   DST gap), the engine moves it forward by the size of the gap. When it occurs twice (the repeated hour after the clocks are
 *   set back), the earlier occurrence is used, except that adding `0` always returns the original instant unchanged.
 * - **Range.** Results outside the `Date` range (±8.64e15 ms) throw a `RangeError`; an Invalid Date is never returned.
 * - **Absolute arithmetic.** `addHours`, `addMinutes`, `addSeconds`, `addMilliseconds` and `diffInHours` & co.
 *   work on the absolute timeline (milliseconds), so `addHours(date, 24)` is not always the same as `addDays(date, 1)`.
 */

import { isDate } from '../guards/index.js';
import { assertInteger as assertCount, assertNumber, describe } from '../utils/assert.js';

/**
 * A value that can be interpreted as a date: a `Date` instance or a millisecond timestamp.
 */
export type DateInput = Date | number;

/**
 * Index of a day of the week, `0` (Sunday) to `6` (Saturday), as returned by `Date#getDay()`.
 */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Bound inclusivity for {@link isBetween}: `[` / `]` include the bound, `(` / `)` exclude it.
 */
export type BetweenInclusivity = '[]' | '()' | '[)' | '(]';

/**
 * A calendar quarter, `1` (January-March) to `4` (October-December).
 */
export type Quarter = 1 | 2 | 3 | 4;

/**
 * A unit understood by {@link formatDuration} and {@link parseDuration}: days, hours, minutes, seconds, milliseconds.
 */
export type DurationUnit = 'd' | 'h' | 'm' | 's' | 'ms';

/**
 * Options for {@link eachDayOfInterval}.
 */
export interface EachDayOfIntervalOptions {
	/** Number of calendar days between two consecutive results (a positive integer, default `1`). */
	step?: number;
}

/**
 * Options for {@link formatDuration}.
 */
export interface FormatDurationOptions {
	/** The units that may appear in the output (any order; default: all of `d`, `h`, `m`, `s`, `ms`). */
	units?: ReadonlyArray<DurationUnit>;
	/** The maximum number of (non-zero) units to output, largest first (a positive integer, default: unlimited). */
	largest?: number;
}

/**
 * A calendar duration for {@link addDuration} and {@link subDuration}. Every field is optional and may be negative. The calendar
 * fields (`years`, `months`, `weeks`, `days`) must be integers; the time fields (`hours`, `minutes`, `seconds`, `milliseconds`) may
 * be any finite number.
 */
export interface Duration {
	years?: number;
	months?: number;
	weeks?: number;
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
	milliseconds?: number;
}

/**
 * The components of an interval returned by {@link intervalToDuration}: every field of a {@link Duration} except `weeks`.
 */
export type IntervalDuration = Required<Omit<Duration, 'weeks'>>;

/**
 * A unit enumerated by {@link eachOfInterval}.
 */
export type IntervalUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute';

/**
 * How {@link roundToNearestMinutes} rounds: to the nearest step (ties go to the later one), down, or up.
 */
export type RoundingMode = 'round' | 'floor' | 'ceil';

/**
 * A time interval for {@link intervalsOverlap}. `start` must not be after `end`.
 */
export interface Interval {
	start: DateInput;
	end: DateInput;
}

/**
 * Options for {@link intervalsOverlap}.
 */
export interface IntervalsOverlapOptions {
	/** `true` to treat both intervals as closed (`[start, end]`, so touching intervals overlap); default `false`: half-open `[start, end)`. */
	inclusive?: boolean;
}

/**
 * Options for {@link toISOStringLocal}.
 */
export interface ToISOStringLocalOptions {
	/** Whether to include the milliseconds (`.SSS`), like `Date#toISOString` (default `true`). */
	milliseconds?: boolean;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const DAYS_PER_WEEK = 7;

/**
 * Epoch day number (days since 1970-01-01) of a Monday (1970-01-05), used as an anchor for weekday arithmetic.
 */
const EPOCH_MONDAY = 4;

const DAYS_PER_MONTH: ReadonlyArray<number> = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const INCLUSIVITIES: ReadonlyArray<string> = ['[]', '()', '[)', '(]'];

/**
 * Size in milliseconds of every unit understood by {@link formatDuration} and {@link parseDuration}.
 */
const DURATION_UNIT_MS: Readonly<Record<DurationUnit, number>> = { d: MS_PER_DAY, h: MS_PER_HOUR, m: MS_PER_MINUTE, s: MS_PER_SECOND, ms: 1 };

/**
 * Every duration unit, largest first (also the default `units` of {@link formatDuration}).
 */
const DURATION_UNITS: ReadonlyArray<DurationUnit> = ['d', 'h', 'm', 's', 'ms'];

/**
 * A whole duration string: optional leading minus sign, then one or more `<number><unit>` tokens. Every token must
 * contain digits and end in a unit, so the repetition cannot backtrack exponentially.
 */
const DURATION_REGEX = /^\s*-?(?:(?:\d+(?:\.\d+)?|\.\d+)\s*(?:ms|d|h|m|s)\s*)+$/;

/**
 * A single `<number><unit>` token of a duration string (`ms` is listed before `m` so it wins).
 */
const DURATION_TOKEN_REGEX = /(\d+(?:\.\d+)?|\.\d+)\s*(ms|d|h|m|s)/g;

/**
 * The fields of a {@link Duration}, largest first (the order in which {@link addDuration} applies them).
 */
const DURATION_FIELDS: ReadonlyArray<keyof Duration> = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'];

/**
 * What one unit of each {@link DURATION_FIELDS} entry adds: months (years, months), days (weeks, days) or milliseconds.
 */
const DURATION_FIELD_SIZES: ReadonlyArray<number> = [12, 1, 7, 1, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND, 1];

const INTERVAL_UNITS: ReadonlyArray<string> = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'];

const ROUNDING_MODES: ReadonlyArray<string> = ['round', 'floor', 'ceil'];

/**
 * The largest number of dates {@link eachOfInterval} returns (a `RangeError` is thrown instead of allocating more).
 */
const MAX_INTERVAL_DATES = 1_000_000;

/**
 * Size bound of the module's internal caches (tokenized `formatDate` patterns, `Intl.RelativeTimeFormat` instances).
 */
const MAX_CACHE_ENTRIES = 64;

/**
 * Keys longer than this are never cached, so the caches cannot retain attacker-sized patterns or locales (their size is
 * bounded by entries, not bytes).
 */
const MAX_CACHED_KEY_LENGTH = 1024;

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The tokens of {@link formatDate}, ordered longest-first so that e.g. `YYYY` wins over `YY` and `MM` over `M`.
 */
const TOKEN_REGEX = /YYYY|YY|SSS|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g;

/**
 * {@link TOKEN_REGEX} plus a `[...]` group capturing literal text. Only run on text that ends with `]` (see
 * {@link compilePattern}): there, every `[` has a closing `]` and each match consumes all it scans, so tokenizing is linear.
 */
const FORMAT_TOKEN_REGEX = new RegExp(`\\[([^\\]]*)]|${TOKEN_REGEX.source}`, 'g');

/**
 * Left-pads the absolute value of an integer with zeros, keeping a leading minus sign for negatives.
 * @param {number} value - The integer to pad
 * @param {number} length - The minimum number of digits
 * @returns {string} The padded string
 * @example
 * pad(7, 2); // => '07'
 */
function pad(value: number, length: number): string {
	const digits = String(Math.abs(value)).padStart(length, '0');

	return value < 0 ? `-${digits}` : digits;
}

/**
 * Converts a 24-hour clock hour to a 12-hour clock hour (`0` → `12`, `13` → `1`).
 * @param {number} hours - The hour, 0-23
 * @returns {number} The hour, 1-12
 * @example
 * to12Hour(0); // => 12
 */
function to12Hour(hours: number): number {
	return hours % 12 === 0 ? 12 : hours % 12;
}

/**
 * Token formatters for {@link formatDate}, keyed by token.
 */
const FORMATTERS: Readonly<Record<string, (date: Date) => string>> = {
	YYYY: function (date: Date): string {
		return pad(date.getFullYear(), 4);
	},
	YY: function (date: Date): string {
		return pad(Math.abs(date.getFullYear()) % 100, 2);
	},
	MM: function (date: Date): string {
		return pad(date.getMonth() + 1, 2);
	},
	M: function (date: Date): string {
		return String(date.getMonth() + 1);
	},
	DD: function (date: Date): string {
		return pad(date.getDate(), 2);
	},
	D: function (date: Date): string {
		return String(date.getDate());
	},
	HH: function (date: Date): string {
		return pad(date.getHours(), 2);
	},
	H: function (date: Date): string {
		return String(date.getHours());
	},
	hh: function (date: Date): string {
		return pad(to12Hour(date.getHours()), 2);
	},
	h: function (date: Date): string {
		return String(to12Hour(date.getHours()));
	},
	mm: function (date: Date): string {
		return pad(date.getMinutes(), 2);
	},
	m: function (date: Date): string {
		return String(date.getMinutes());
	},
	ss: function (date: Date): string {
		return pad(date.getSeconds(), 2);
	},
	s: function (date: Date): string {
		return String(date.getSeconds());
	},
	SSS: function (date: Date): string {
		return pad(date.getMilliseconds(), 3);
	},
	A: function (date: Date): string {
		return date.getHours() < 12 ? 'AM' : 'PM';
	},
	a: function (date: Date): string {
		return date.getHours() < 12 ? 'am' : 'pm';
	}
};

/**
 * Converts a {@link DateInput} into a fresh, valid `Date` copy.
 * @param {DateInput} input - The date or timestamp
 * @returns {Date} A new `Date` instance
 * @throws {TypeError} when `input` is neither a `Date` nor a number
 * @throws {RangeError} when `input` is an invalid date
 * @example
 * toValidDate(0).toISOString(); // => '1970-01-01T00:00:00.000Z'
 */
function toValidDate(input: DateInput): Date {
	if (!isDate(input) && typeof input !== 'number') {
		throw new TypeError('Expected a Date or a timestamp number');
	}

	// The constructor reads the internal time value of a Date, also from another realm or with an overridden `getTime`.
	const date = new Date(input);

	if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');

	return date;
}

/**
 * Returns the millisecond timestamp of a valid {@link DateInput}.
 * @param {DateInput} input - The date or timestamp
 * @returns {number} The timestamp in milliseconds
 * @throws {TypeError} when `input` is neither a `Date` nor a number
 * @throws {RangeError} when `input` is an invalid date
 * @example
 * timeOf(new Date(5)); // => 5
 */
function timeOf(input: DateInput): number {
	return toValidDate(input).getTime();
}

/**
 * Throws when an arithmetic result fell outside the representable `Date` range.
 * @param {Date} date - The computed date
 * @returns {Date} The same date, when valid
 * @throws {RangeError} when the date is invalid (out of range)
 * @example
 * ensureInRange(new Date(0)); // returns the date
 */
function ensureInRange(date: Date): Date {
	if (Number.isNaN(date.getTime())) throw new RangeError('Resulting date is out of range');

	return date;
}

/**
 * Asserts that a calendar amount is an integer.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - The parameter name, used in the error message
 * @param {number} amount - The amount to check
 * @returns {void}
 * @throws {TypeError} when `amount` is not a number
 * @throws {RangeError} when `amount` is not an integer
 */
function assertInteger(caller: string, name: string, amount: number): void {
	assertNumber(caller, name, amount, Number.isInteger(amount), 'an integer');
}

/**
 * Asserts that a time amount is a finite number.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} amount - The amount to check
 * @returns {void}
 * @throws {TypeError} when `amount` is not a number
 * @throws {RangeError} when `amount` is not finite
 */
function assertFinite(caller: string, amount: number): void {
	assertNumber(caller, 'amount', amount, Number.isFinite(amount), 'a finite number');
}

/**
 * Asserts that a value is a valid weekday index (integer 0-6).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} weekday - The value to check
 * @param {string} [name='weekStartsOn'] - The parameter name, used in the error message
 * @returns {void}
 * @throws {TypeError} when the value is not a number
 * @throws {RangeError} when the value is not an integer between 0 and 6
 */
function assertWeekday(caller: string, weekday: number, name = 'weekStartsOn'): void {
	assertNumber(caller, name, weekday, Number.isInteger(weekday) && weekday >= 0 && weekday <= 6, 'an integer between 0 and 6');
}

/**
 * Asserts that a value is one of a few allowed strings.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - The parameter name, used in the error message
 * @param {unknown} value - The value to check
 * @param {ReadonlyArray<string>} allowed - The allowed values
 * @returns {void}
 * @throws {RangeError} when `value` is not one of `allowed`
 */
function assertOneOf(caller: string, name: string, value: unknown, allowed: ReadonlyArray<string>): void {
	if (!allowed.includes(value as string)) throw new RangeError(`${caller}: \`${name}\` must be one of ${allowed.join(', ')}, got ${String(value)}`);
}

/**
 * Returns the number of whole days between the Unix epoch and the given LOCAL calendar date, using UTC so that
 * the result is unaffected by daylight-saving transitions.
 * @param {Date} date - A valid date
 * @returns {number} The epoch day number of the local calendar date
 * @example
 * epochDay(new Date(1970, 0, 2)); // => 1
 */
function epochDay(date: Date): number {
	return daysFromCivil(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Returns the number of days from 1970-01-01 to a proleptic Gregorian calendar date, using pure integer arithmetic
 * (Howard Hinnant's `days_from_civil`), so it works for every year, even where the UTC midnight of that date is outside
 * the `Date` range.
 * @param {number} year - The integer year
 * @param {number} monthIndex - The zero-based month (0-11)
 * @param {number} day - The day of the month (1-31)
 * @returns {number} The epoch day number
 * @example
 * daysFromCivil(1970, 0, 2); // => 1
 */
function daysFromCivil(year: number, monthIndex: number, day: number): number {
	const y = monthIndex < 2 ? year - 1 : year;
	const era = Math.floor(y / 400);
	const yearOfEra = y - era * 400;
	const marchBasedMonth = monthIndex < 2 ? monthIndex + 10 : monthIndex - 2;
	const dayOfYear = Math.floor((153 * marchBasedMonth + 2) / 5) + day - 1;
	const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;

	return era * 146097 + dayOfEra - 719468;
}

/**
 * Mathematical (always non-negative) modulo.
 * @param {number} value - The dividend
 * @param {number} divisor - The positive divisor
 * @returns {number} `value mod divisor`, in `[0, divisor)`
 * @example
 * mod(-1, 7); // => 6
 */
function mod(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor;
}

/**
 * Returns a new date at the start (normally 00:00:00.000) of a LOCAL calendar day. Out-of-range day numbers roll over
 * into the neighbouring months, like `Date#setFullYear`.
 * @param {number} year - The integer year (0-99 are NOT remapped to 1900-1999)
 * @param {number} monthIndex - The zero-based month
 * @param {number} day - The day of the month
 * @returns {Date} The start of that local day
 * @throws {RangeError} when the result is outside the representable range
 * @example
 * localMidnight(2024, 0, 32); // => new Date(2024, 1, 1) // 00:00 local time
 */
function localMidnight(year: number, monthIndex: number, day: number): Date {
	// Go through noon so that the intermediate wall-clock time can never fall into a DST gap. `setFullYear` then moves it to the
	// target day without remapping years 0-99, as the constructor would.
	const result = new Date(2000, 0, 1, 12);

	result.setFullYear(year, monthIndex, day);
	// Noon of the first or last representable day can be out of range while its midnight is not: go through midnight then.
	if (Number.isNaN(result.getTime())) result.setTime(new Date(2000, 0, 1).setFullYear(year, monthIndex, day));
	result.setHours(0, 0, 0, 0);

	return ensureInRange(result);
}

/**
 * Number of weekdays (Monday-Friday) from an arbitrary fixed origin up to and including an epoch day, so that
 * `weekdaysThrough(b) - weekdaysThrough(a)` counts the weekdays in `(a, b]`.
 * @param {number} day - An epoch day number
 * @returns {number} The cumulative weekday count
 * @example
 * weekdaysThrough(4) - weekdaysThrough(3); // => 1 // 1970-01-05 was a Monday
 */
function weekdaysThrough(day: number): number {
	const sinceMonday = day - EPOCH_MONDAY;

	return Math.floor(sinceMonday / DAYS_PER_WEEK) * 5 + Math.min(mod(sinceMonday, DAYS_PER_WEEK) + 1, 5);
}

/**
 * Computes the ISO 8601 week-numbering year and week of the LOCAL calendar date (weeks start on Monday; week 1 is the
 * week containing the year's first Thursday).
 * @param {Date} date - A valid date
 * @returns {[number, number]} `[isoWeekYear, isoWeek]`
 * @example
 * isoWeekParts(new Date(2021, 0, 3)); // => [2020, 53]
 */
function isoWeekParts(date: Date): [number, number] {
	const day = epochDay(date);
	// 1 = Monday … 7 = Sunday (1970-01-01, epoch day 0, was a Thursday).
	const isoWeekday = mod(day + 3, DAYS_PER_WEEK) + 1;
	const thursday = day + 4 - isoWeekday;
	let year = date.getFullYear();

	if (thursday < daysFromCivil(year, 0, 1)) year -= 1;
	else if (thursday >= daysFromCivil(year + 1, 0, 1)) year += 1;

	return [year, Math.floor((thursday - daysFromCivil(year, 0, 1)) / DAYS_PER_WEEK) + 1];
}

/**
 * Returns the number of calendar months from `earlier` to `later`, ignoring the day and time.
 * @param {Date} later - A valid date
 * @param {Date} earlier - A valid date
 * @returns {number} `12 * yearDelta + monthDelta`
 * @example
 * calendarMonthDiff(new Date(2024, 0, 1), new Date(2023, 11, 31)); // => 1
 */
function calendarMonthDiff(later: Date, earlier: Date): number {
	return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}

/**
 * Moves a date by whole calendar months, then by whole calendar days, keeping its wall-clock time, in a single wall-clock
 * conversion: when the day of the month does not exist in the target month it is first clamped to that month's last day
 * (`addMonths` semantics), then the days are added. Moving by nothing returns the date unchanged, even in a repeated hour.
 * @param {Date} date - A valid date, which is mutated (callers pass a fresh copy)
 * @param {number} months - The integer number of months to move by
 * @param {number} days - The integer number of days to move by after the months
 * @returns {Date} `date`, moved
 * @throws {RangeError} when the result is outside the representable range
 * @example
 * shiftCalendar(new Date(2023, 0, 31), 1, 1); // => new Date(2023, 2, 1) // Jan 31 → Feb 28 → Mar 1
 */
function shiftCalendar(date: Date, months: number, days: number): Date {
	return ensureInRange(shiftCalendarUnchecked(date, months, days));
}

/**
 * {@link shiftCalendar} without the range check: the result is an invalid `Date` when it is out of range (for trial shifts, which
 * treat that as overshooting).
 * @param {Date} date - A valid date, which is mutated (callers pass a fresh copy)
 * @param {number} months - The integer number of months to move by
 * @param {number} days - The integer number of days to move by after the months
 * @returns {Date} `date`, moved (invalid when out of range)
 */
function shiftCalendarUnchecked(date: Date, months: number, days: number): Date {
	// Re-setting the same wall-clock time would move an instant in a repeated (fall-back) hour to its first occurrence.
	if (months === 0 && days === 0) return date;

	if (months === 0) {
		// Days only (`addDays`): no clamping, and much faster.
		date.setDate(date.getDate() + days);
	} else {
		const totalMonths = date.getMonth() + months;
		const year = date.getFullYear() + Math.floor(totalMonths / 12);
		const month = mod(totalMonths, 12);

		date.setFullYear(year, month, Math.min(date.getDate(), daysInMonth(year, month)) + days);
	}

	return date;
}

/**
 * Returns the signed number of COMPLETE units of `unitMonths` months plus `unitDays` days (one of them is `0`) between two dates:
 * for `later >= earlier` the largest `n` such that `shiftCalendar(earlier, n * unitMonths, n * unitDays) <= later`, else
 * `-diffInCompleteUnits(earlier, later)`.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @param {number} unitMonths - Months per unit (`0` for day-based units)
 * @param {number} unitDays - Days per unit (`0` for month-based units)
 * @returns {number} The number of complete units
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInCompleteUnits(new Date(2024, 0, 15), new Date(2024, 0, 1), 0, 7); // => 2
 */
function diffInCompleteUnits(later: DateInput, earlier: DateInput, unitMonths: number, unitDays: number): number {
	const end = toValidDate(later);
	const start = toValidDate(earlier);

	if (end.getTime() < start.getTime()) return 0 - diffInCompleteUnits(start, end, unitMonths, unitDays);

	// The calendar difference counts at most one unit too many (when the time of day or a clamped day is not reached yet).
	const units = Math.floor(unitMonths === 0 ? diffInDays(end, start) / unitDays : calendarMonthDiff(end, start) / unitMonths);

	// A trial shift past the representable range (an invalid date) overshoots too.
	return !(shiftCalendarUnchecked(start, units * unitMonths, units * unitDays).getTime() <= end.getTime()) ? units - 1 : units;
}

/**
 * Truncates toward zero, normalizing `-0` to `0`.
 * @param {number} value - The value to truncate
 * @returns {number} The truncated value
 * @example
 * truncate(-0.5); // => 0
 */
function truncate(value: number): number {
	return Math.trunc(value) + 0;
}

/**
 * Moves `date` to the last millisecond of its local day, or of the `days - 1`-th local day after it (normally 23:59:59.999),
 * computed as the start of the following local day minus 1 ms so that it is correct even when the clock is set back around midnight.
 * @param {Date} date - A valid date, which is mutated (callers pass a fresh copy)
 * @param {number} [days=1] - `1` for the end of the same day, `2` for the end of the next day, and so on
 * @returns {Date} `date`, now at the end of the requested local day
 * @throws {RangeError} when the end of the day is outside the representable range
 * @example
 * lastInstantOfDay(new Date(2024, 0, 1, 12)); // => new Date(2024, 0, 1, 23, 59, 59, 999)
 * lastInstantOfDay(new Date(2024, 0, 1, 12), 3); // => new Date(2024, 0, 3, 23, 59, 59, 999)
 */
function lastInstantOfDay(date: Date, days = 1): Date {
	// Hour `24 * days` is the local midnight `days` days later: a single wall-clock conversion instead of `setDate()` then
	// `setHours(0)`, so no intermediate wall-clock time can be moved by a DST gap.
	date.setHours(24 * days, 0, 0, 0);

	// Where the clock was set back just after midnight (St. John's and Moncton at 00:01, until 2010), midnight happens twice and the
	// conversion gives the first one, after which the previous day comes back: the day ends just before the second midnight.
	const shift = new Date(date.getTime() + 3 * MS_PER_HOUR).getTimezoneOffset() - date.getTimezoneOffset();

	if (shift > 0) {
		const second = new Date(date.getTime() + shift * MS_PER_MINUTE);

		// Only when the previous day came back in between (not when the repeated hour starts the new day, as in Havana at 01:00).
		if (
			second.getDate() === date.getDate() &&
			second.getHours() === 0 &&
			second.getMinutes() === 0 &&
			second.getSeconds() === 0 &&
			new Date(second.getTime() - 1).getDate() !== second.getDate()
		)
			date.setTime(second.getTime());
	}
	date.setTime(date.getTime() - 1);

	return ensureInRange(date);
}

declare const validDate: unique symbol;

/**
 * A `Date` known to hold a valid time, as narrowed by {@link isValidDate}. The brand only exists in the type system: a `Date` that
 * fails the check is still a `Date`, so `if (!isValidDate(date))` keeps `date` typed as one.
 */
export type ValidDate = Date & { readonly [validDate]: true };

/**
 * Checks whether a value is a `Date` instance holding a valid time (i.e. not `new Date(NaN)`). It narrows `value` to
 * {@link ValidDate}, a `Date`, when it returns `true`, and leaves its type alone otherwise (an invalid `Date` is still a `Date`).
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a valid `Date`
 * @example
 * isValidDate(new Date()); // => true
 * isValidDate(new Date('nope')); // => false
 * isValidDate(Date.now()); // => false // a number, not a Date
 * isValidDate(Object.create(Date.prototype)); // => false // not a real Date
 */
export function isValidDate(value: unknown): value is ValidDate {
	return isDate(value) && !Number.isNaN(Date.prototype.getTime.call(value));
}

/**
 * Adds a number of calendar days (local time). The wall-clock time is preserved, even across DST transitions.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The integer number of days to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not an integer, or the result is out of range
 * @example
 * addDays(new Date(2024, 0, 31, 10, 30), 1); // => new Date(2024, 1, 1, 10, 30) // same local time of day
 */
export function addDays(date: DateInput, amount: number): Date {
	assertInteger('addDays', 'amount', amount);

	return shiftCalendar(toValidDate(date), 0, amount);
}

/**
 * Adds a number of weeks (7 calendar days each, local time).
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The integer number of weeks to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not an integer, or the result is out of range
 * @example
 * addWeeks(new Date(2024, 0, 1), 2); // => new Date(2024, 0, 15)
 */
export function addWeeks(date: DateInput, amount: number): Date {
	assertInteger('addWeeks', 'amount', amount);

	return addDays(date, amount * 7);
}

/**
 * Adds a number of calendar months (local time). When the original day does not exist in the target month the
 * result is clamped to that month's last day. The time of day is preserved.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The integer number of months to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not an integer, or the result is out of range
 * @example
 * addMonths(new Date(2023, 0, 31), 1); // => new Date(2023, 1, 28)
 * addMonths(new Date(2024, 0, 31), 1); // => new Date(2024, 1, 29)
 */
export function addMonths(date: DateInput, amount: number): Date {
	assertInteger('addMonths', 'amount', amount);

	return shiftCalendar(toValidDate(date), amount, 0);
}

/**
 * Adds a number of calendar years (local time). February 29th is clamped to February 28th in non-leap years.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The integer number of years to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not an integer, or the result is out of range
 * @example
 * addYears(new Date(2024, 1, 29), 1); // => new Date(2025, 1, 28)
 */
export function addYears(date: DateInput, amount: number): Date {
	assertInteger('addYears', 'amount', amount);

	return addMonths(date, amount * 12);
}

/**
 * Adds an absolute number of hours (3 600 000 ms each); unlike {@link addDays}, this is not wall-clock based.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The finite number of hours to add (may be fractional or negative)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not finite, or the result is out of range
 * @example
 * addHours(new Date(Date.UTC(2024, 0, 1)), 2).toISOString(); // => '2024-01-01T02:00:00.000Z'
 */
export function addHours(date: DateInput, amount: number): Date {
	assertFinite('addHours', amount);

	return addMilliseconds(date, amount * MS_PER_HOUR);
}

/**
 * Adds an absolute number of minutes.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The finite number of minutes to add (may be fractional or negative)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not finite, or the result is out of range
 * @example
 * addMinutes(new Date(Date.UTC(2024, 0, 1)), 90).toISOString(); // => '2024-01-01T01:30:00.000Z'
 */
export function addMinutes(date: DateInput, amount: number): Date {
	assertFinite('addMinutes', amount);

	return addMilliseconds(date, amount * MS_PER_MINUTE);
}

/**
 * Adds an absolute number of seconds.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The finite number of seconds to add (may be fractional or negative)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not finite, or the result is out of range
 * @example
 * addSeconds(new Date(0), 1.5).getTime(); // => 1500
 */
export function addSeconds(date: DateInput, amount: number): Date {
	assertFinite('addSeconds', amount);

	return addMilliseconds(date, amount * MS_PER_SECOND);
}

/**
 * Adds an absolute number of milliseconds. Fractional results are truncated by the `Date` constructor.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The finite number of milliseconds to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not finite, or the result is out of range
 * @example
 * addMilliseconds(new Date(0), 250).getTime(); // => 250
 */
export function addMilliseconds(date: DateInput, amount: number): Date {
	assertFinite('addMilliseconds', amount);

	return ensureInRange(new Date(timeOf(date) + amount));
}

/**
 * Returns the signed number of calendar days between two dates (local time), ignoring the time of day:
 * `diffInDays(Jan 2 00:01, Jan 1 23:59) === 1`. DST-safe: a 23- or 25-hour day still counts as one day.
 * @param {DateInput} later - The later date (the result is negative if it is actually earlier)
 * @param {DateInput} earlier - The earlier date
 * @returns {number} `later`'s calendar day minus `earlier`'s calendar day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInDays(new Date(2024, 2, 1), new Date(2024, 1, 1)); // => 29
 * diffInDays(new Date(2024, 0, 1), new Date(2024, 0, 3)); // => -2
 */
export function diffInDays(later: DateInput, earlier: DateInput): number {
	return epochDay(toValidDate(later)) - epochDay(toValidDate(earlier));
}

/**
 * Returns the signed number of whole hours between two dates, truncated toward zero (absolute time).
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of whole hours
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInHours(new Date(2024, 0, 1, 10, 59), new Date(2024, 0, 1, 9, 0)); // => 1 // when no DST change happens in between
 */
export function diffInHours(later: DateInput, earlier: DateInput): number {
	return truncate((timeOf(later) - timeOf(earlier)) / MS_PER_HOUR);
}

/**
 * Returns the signed number of whole minutes between two dates, truncated toward zero (absolute time).
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of whole minutes
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInMinutes(150_000, 0); // => 2
 */
export function diffInMinutes(later: DateInput, earlier: DateInput): number {
	return truncate((timeOf(later) - timeOf(earlier)) / MS_PER_MINUTE);
}

/**
 * Returns the signed number of whole seconds between two dates, truncated toward zero (absolute time).
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of whole seconds
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInSeconds(0, 2_500); // => -2
 */
export function diffInSeconds(later: DateInput, earlier: DateInput): number {
	return truncate((timeOf(later) - timeOf(earlier)) / MS_PER_SECOND);
}

/**
 * Returns the signed number of COMPLETE calendar months between two dates (date-fns `differenceInMonths` semantics):
 * for `later >= earlier` it is the largest `n` such that `addMonths(earlier, n) <= later` (time of day included, with
 * end-of-month clamping, so Jan 31 → Feb 28 counts as one full month); for `later < earlier` it is
 * `-diffInMonths(earlier, later)`.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of complete months
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInMonths(new Date(2024, 2, 14), new Date(2024, 0, 15)); // => 1
 * diffInMonths(new Date(2023, 1, 28), new Date(2023, 0, 31)); // => 1
 */
export function diffInMonths(later: DateInput, earlier: DateInput): number {
	return diffInCompleteUnits(later, earlier, 1, 0);
}

/**
 * Returns the start of the local day (00:00:00.000).
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the same local day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfDay(new Date(2024, 4, 10, 15, 30)); // => new Date(2024, 4, 10)
 */
export function startOfDay(date: DateInput): Date {
	const result = toValidDate(date);

	result.setHours(0, 0, 0, 0);

	return ensureInRange(result);
}

/**
 * Returns the last millisecond of the local day (23:59:59.999). Computed as the start of the next day minus 1 ms,
 * so it is correct even in zones whose clocks are set back around midnight.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the same local day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfDay(new Date(2024, 4, 10, 15, 30)); // => new Date(2024, 4, 10, 23, 59, 59, 999)
 */
export function endOfDay(date: DateInput): Date {
	return lastInstantOfDay(toValidDate(date));
}

/**
 * Returns the first day of the local month at 00:00:00.000.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the month
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfMonth(new Date(2024, 1, 20)); // => new Date(2024, 1, 1)
 */
export function startOfMonth(date: DateInput): Date {
	const result = toValidDate(date);

	// Hour `-24 * n` of the current day is the midnight `n` days earlier: a single wall-clock conversion.
	result.setHours(-24 * (result.getDate() - 1), 0, 0, 0);

	return ensureInRange(result);
}

/**
 * Returns the last day of the local month at 23:59:59.999.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the month
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfMonth(new Date(2024, 1, 20)); // => new Date(2024, 1, 29, 23, 59, 59, 999)
 */
export function endOfMonth(date: DateInput): Date {
	const result = toValidDate(date);

	return lastInstantOfDay(result, daysInMonth(result.getFullYear(), result.getMonth()) - result.getDate() + 1);
}

/**
 * Returns the start (00:00:00.000, local) of the week containing `date`.
 * @param {DateInput} date - The date
 * @param {WeekdayIndex} [weekStartsOn=0] - The first day of the week: 0 = Sunday … 6 = Saturday
 * @returns {Date} A new date at the start of the week
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `weekStartsOn` is not a number
 * @throws {RangeError} when `date` is invalid, `weekStartsOn` is not an integer between 0 and 6, or the result is out of range
 * @example
 * startOfWeek(new Date(2024, 4, 15)); // => new Date(2024, 4, 12) // Sunday
 * startOfWeek(new Date(2024, 4, 15), 1); // => new Date(2024, 4, 13) // Monday
 */
export function startOfWeek(date: DateInput, weekStartsOn: WeekdayIndex = 0): Date {
	assertWeekday('startOfWeek', weekStartsOn);

	const result = toValidDate(date);

	// Hour `-24 * n` of the current day is the midnight `n` days earlier: a single wall-clock conversion.
	result.setHours(-24 * ((result.getDay() - weekStartsOn + 7) % 7), 0, 0, 0);

	return ensureInRange(result);
}

/**
 * Returns the end (23:59:59.999, local) of the week containing `date`.
 * @param {DateInput} date - The date
 * @param {WeekdayIndex} [weekStartsOn=0] - The first day of the week: 0 = Sunday … 6 = Saturday
 * @returns {Date} A new date at the end of the week
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `weekStartsOn` is not a number
 * @throws {RangeError} when `date` is invalid, `weekStartsOn` is not an integer between 0 and 6, or the result is out of range
 * @example
 * endOfWeek(new Date(2024, 4, 15)); // => new Date(2024, 4, 18, 23, 59, 59, 999) // Saturday
 */
export function endOfWeek(date: DateInput, weekStartsOn: WeekdayIndex = 0): Date {
	assertWeekday('endOfWeek', weekStartsOn);

	// Counted from the week's epoch day rather than from `startOfWeek`, which moves to the next day when the first one was skipped
	// (Samoa, 2011-12-30): the instant before the first midnight of the next week.
	return lastInstantOfDay(localMidnight(1970, 0, 1 + weekStartDay(toValidDate(date), weekStartsOn) + DAYS_PER_WEEK), 0);
}

/**
 * Returns January 1st of the local year at 00:00:00.000.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the year
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfYear(new Date(2024, 6, 4)); // => new Date(2024, 0, 1)
 */
export function startOfYear(date: DateInput): Date {
	const result = toValidDate(date);

	result.setMonth(0, 1);
	result.setHours(0, 0, 0, 0);

	return ensureInRange(result);
}

/**
 * Returns December 31st of the local year at 23:59:59.999.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the year
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfYear(new Date(2024, 6, 4)); // => new Date(2024, 11, 31, 23, 59, 59, 999)
 */
export function endOfYear(date: DateInput): Date {
	const result = toValidDate(date);

	// Counted from `date`'s own day, like `endOfMonth`: `setMonth(11, 31)` would move to January 1st in a zone that skipped December 31st.
	return lastInstantOfDay(result, daysFromCivil(result.getFullYear(), 11, 31) - epochDay(result) + 1);
}

/**
 * Checks whether two dates fall on the same local calendar day.
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {boolean} `true` when year, month and day match
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isSameDay(new Date(2024, 0, 1, 0, 0), new Date(2024, 0, 1, 23, 59)); // => true
 */
export function isSameDay(a: DateInput, b: DateInput): boolean {
	const left = toValidDate(a);
	const right = toValidDate(b);

	return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

/**
 * Checks whether two dates fall in the same local calendar month (of the same year).
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {boolean} `true` when year and month match
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isSameMonth(new Date(2024, 0, 1), new Date(2024, 0, 31)); // => true
 * isSameMonth(new Date(2024, 0, 1), new Date(2023, 0, 1)); // => false
 */
export function isSameMonth(a: DateInput, b: DateInput): boolean {
	const left = toValidDate(a);
	const right = toValidDate(b);

	return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
}

/**
 * Checks whether two dates fall in the same local calendar year.
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {boolean} `true` when the years match
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isSameYear(new Date(2024, 0, 1), new Date(2024, 11, 31)); // => true
 */
export function isSameYear(a: DateInput, b: DateInput): boolean {
	return toValidDate(a).getFullYear() === toValidDate(b).getFullYear();
}

/**
 * Checks whether a year (or the local year of a date) is a Gregorian leap year.
 * @param {number | Date} yearOrDate - An integer year, or a date
 * @returns {boolean} `true` for leap years
 * @throws {TypeError} when `yearOrDate` is neither a number nor a `Date`
 * @throws {RangeError} when given a non-integer year or an invalid date
 * @example
 * isLeapYear(2024); // => true
 * isLeapYear(1900); // => false
 * isLeapYear(new Date(2000, 5, 1)); // => true
 */
export function isLeapYear(yearOrDate: number | Date): boolean {
	const year = isDate(yearOrDate) ? toValidDate(yearOrDate).getFullYear() : yearOrDate;

	assertNumber('isLeapYear', 'yearOrDate', year, Number.isInteger(year), 'an integer or a Date');

	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the number of days in a month.
 * @param {number} year - The integer year
 * @param {number} monthIndex - The zero-based month index (0 = January … 11 = December)
 * @returns {number} 28, 29, 30 or 31
 * @throws {TypeError} when `year` or `monthIndex` is not a number
 * @throws {RangeError} when `year` is not an integer or `monthIndex` is not an integer between 0 and 11
 * @example
 * daysInMonth(2024, 1); // => 29
 * daysInMonth(2023, 1); // => 28
 */
export function daysInMonth(year: number, monthIndex: number): number {
	assertInteger('daysInMonth', 'year', year);
	assertNumber('daysInMonth', 'monthIndex', monthIndex, Number.isInteger(monthIndex) && monthIndex >= 0 && monthIndex <= 11, 'an integer between 0 and 11');

	return monthIndex === 1 && isLeapYear(year) ? 29 : DAYS_PER_MONTH[monthIndex];
}

/**
 * Returns the number of days in the local month of a date.
 * @param {DateInput} date - The date
 * @returns {number} 28, 29, 30 or 31
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * getDaysInMonth(new Date(2024, 1, 10)); // => 29
 */
export function getDaysInMonth(date: DateInput): number {
	const d = toValidDate(date);

	return daysInMonth(d.getFullYear(), d.getMonth());
}

/**
 * Checks whether a date falls on a Saturday or a Sunday (local time).
 * @param {DateInput} date - The date
 * @returns {boolean} `true` on weekends
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * isWeekend(new Date(2024, 4, 18)); // => true // a Saturday
 */
export function isWeekend(date: DateInput): boolean {
	const day = toValidDate(date).getDay();

	return day === 0 || day === 6;
}

/**
 * Checks whether `a` is strictly before `b`.
 * @param {DateInput} a - The date to check
 * @param {DateInput} b - The date to compare against
 * @returns {boolean} `true` when `a < b`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isBefore(new Date(2024, 0, 1), new Date(2024, 0, 2)); // => true
 */
export function isBefore(a: DateInput, b: DateInput): boolean {
	return timeOf(a) < timeOf(b);
}

/**
 * Checks whether `a` is strictly after `b`.
 * @param {DateInput} a - The date to check
 * @param {DateInput} b - The date to compare against
 * @returns {boolean} `true` when `a > b`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isAfter(new Date(2024, 0, 2), new Date(2024, 0, 1)); // => true
 */
export function isAfter(a: DateInput, b: DateInput): boolean {
	return timeOf(a) > timeOf(b);
}

/**
 * Checks whether a date lies within a range.
 * @param {DateInput} date - The date to check
 * @param {DateInput} start - The start of the range
 * @param {DateInput} end - The end of the range (must not be before `start`)
 * @param {BetweenInclusivity} [inclusivity='[]'] - Whether each bound is included (`[`, `]`) or excluded (`(`, `)`)
 * @returns {boolean} `true` when `date` is inside the range
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when a date is invalid, `start` is after `end`, or `inclusivity` is not one of `'[]' | '()' | '[)' | '(]'`
 * @example
 * isBetween(new Date(2024, 0, 5), new Date(2024, 0, 1), new Date(2024, 0, 10)); // => true
 * isBetween(new Date(2024, 0, 10), new Date(2024, 0, 1), new Date(2024, 0, 10), '[)'); // => false
 */
export function isBetween(date: DateInput, start: DateInput, end: DateInput, inclusivity: BetweenInclusivity = '[]'): boolean {
	assertOneOf('isBetween', 'inclusivity', inclusivity, INCLUSIVITIES);

	const time = timeOf(date);
	const from = timeOf(start);
	const to = timeOf(end);

	if (from > to) throw new RangeError('isBetween: `start` must not be after `end`');

	const afterStart = inclusivity[0] === '[' ? time >= from : time > from;
	const beforeEnd = inclusivity[1] === ']' ? time <= to : time < to;

	return afterStart && beforeEnd;
}

/**
 * Ascending comparator, usable with `Array#sort`.
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {number} `-1` if `a < b`, `1` if `a > b`, `0` if equal
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * [new Date(2024, 1, 1), new Date(2023, 1, 1)].sort(compareAsc); // => [new Date(2023, 1, 1), new Date(2024, 1, 1)]
 */
export function compareAsc(a: DateInput, b: DateInput): -1 | 0 | 1 {
	const left = timeOf(a);
	const right = timeOf(b);

	if (left < right) return -1;

	return left > right ? 1 : 0;
}

/**
 * Descending comparator, usable with `Array#sort`.
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {number} `1` if `a < b`, `-1` if `a > b`, `0` if equal
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * [new Date(2023, 1, 1), new Date(2024, 1, 1)].sort(compareDesc); // => [new Date(2024, 1, 1), new Date(2023, 1, 1)]
 */
export function compareDesc(a: DateInput, b: DateInput): -1 | 0 | 1 {
	return compareAsc(b, a);
}

/**
 * Returns a copy of the earliest date.
 * @param {Iterable<DateInput>} dates - The dates to scan
 * @returns {Date | undefined} A new `Date` equal to the earliest date, or `undefined` when `dates` is empty
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when any date is invalid
 * @example
 * minDate([new Date(2024, 0, 2), new Date(2024, 0, 1)]); // => new Date(2024, 0, 1)
 * minDate([]); // => undefined
 */
export function minDate(dates: Iterable<DateInput>): Date | undefined {
	let result = Infinity;

	for (const date of dates) result = Math.min(result, timeOf(date));

	// Valid timestamps are finite, so `Infinity` means that `dates` was empty.
	return result === Infinity ? undefined : new Date(result);
}

/**
 * Returns a copy of the latest date.
 * @param {Iterable<DateInput>} dates - The dates to scan
 * @returns {Date | undefined} A new `Date` equal to the latest date, or `undefined` when `dates` is empty
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when any date is invalid
 * @example
 * maxDate([new Date(2024, 0, 2), new Date(2024, 0, 1)]); // => new Date(2024, 0, 2)
 * maxDate([]); // => undefined
 */
export function maxDate(dates: Iterable<DateInput>): Date | undefined {
	let result = -Infinity;

	for (const date of dates) result = Math.max(result, timeOf(date));

	// Valid timestamps are finite, so `-Infinity` means that `dates` was empty.
	return result === -Infinity ? undefined : new Date(result);
}

/**
 * Formats a date (local time) with a token pattern. No locale data is used.
 *
 * | Token | Output | Token | Output |
 * |-------|--------|-------|--------|
 * | `YYYY` | 4-digit year (`2024`) | `YY` | 2-digit year (`24`) |
 * | `MM` / `M` | month `01-12` / `1-12` | `DD` / `D` | day `01-31` / `1-31` |
 * | `HH` / `H` | hour `00-23` / `0-23` | `hh` / `h` | hour `01-12` / `1-12` |
 * | `mm` / `m` | minute `00-59` / `0-59` | `ss` / `s` | second `00-59` / `0-59` |
 * | `SSS` | millisecond `000-999` | `A` / `a` | `AM`/`PM` / `am`/`pm` |
 *
 * Text inside `[square brackets]` is output literally (without the brackets). Any other character is copied as is;
 * note that a bare `a`, `s`, `m`, `h`, `D`… IS a token, so wrap words in brackets: `'[at] HH:mm'`. A `[` without a closing `]`
 * is copied as is.
 *
 * Tokenizing takes time linear in the pattern length, so untrusted patterns cannot stall the event loop (the output is still
 * proportional to the pattern: cap its length if it comes from users). Compiled patterns of at most 1024 characters are cached
 * (64 at most); longer ones are re-tokenized on every call.
 * @param {DateInput} date - The date to format
 * @param {string} pattern - The format pattern
 * @returns {string} The formatted date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * formatDate(new Date(2024, 0, 5, 14, 7, 9, 3), 'YYYY-MM-DD HH:mm:ss.SSS'); // => '2024-01-05 14:07:09.003'
 * formatDate(new Date(2024, 0, 5, 14, 7), 'D/M/YY h:mm A [o\'clock]'); // => "5/1/24 2:07 PM o'clock"
 */
export function formatDate(date: DateInput, pattern: string): string {
	const d = toValidDate(date);
	let result = '';

	for (const part of cached(compiledPatterns, pattern, compilePattern)) result += typeof part === 'string' ? part : part(d);

	return result;
}

/**
 * Returns `cache.get(key)`, computing and storing `create(key)` first when missing. The cache is cleared when it reaches
 * {@link MAX_CACHE_ENTRIES} entries, and keys longer than {@link MAX_CACHED_KEY_LENGTH} are not stored, so its size stays
 * bounded whatever the keys.
 * @template V - Type of the cached values
 * @param {Map<string, V>} cache - The cache
 * @param {string} key - The key
 * @param {(key: string) => V} create - Computes the value of a missing key
 * @returns {V} The cached value
 * @example
 * cached(new Map(), 'YYYY', compilePattern).length; // => 3
 */
function cached<V>(cache: Map<string, V>, key: string, create: (key: string) => V): V {
	let value = cache.get(key);

	if (value === undefined) {
		value = create(key);
		if (key.length <= MAX_CACHED_KEY_LENGTH) {
			if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
			cache.set(key, value);
		}
	}

	return value;
}

/**
 * {@link formatDate} patterns already split by {@link compilePattern}.
 */
const compiledPatterns = new Map<string, ReadonlyArray<string | ((date: Date) => string)>>();

/**
 * Splits a {@link formatDate} pattern into literal strings and token formatters (cached by `formatDate`, so repeated
 * formatting with the same pattern does not run the tokenizing regex again).
 * @param {string} pattern - The format pattern
 * @returns {ReadonlyArray<string | ((date: Date) => string)>} The literal texts and formatters, in pattern order
 * @example
 * compilePattern('[at] HH')[1]; // => 'at'
 */
function compilePattern(pattern: string): ReadonlyArray<string | ((date: Date) => string)> {
	const parts: Array<string | ((date: Date) => string)> = [];
	// Every `[` after the last `]` is unclosed, so that tail cannot hold a `[...]` group: it is tokenized without that alternative,
	// which would otherwise rescan to the end of the pattern from each `[` (quadratic time on `'['.repeat(n)`).
	const head = pattern.lastIndexOf(']') + 1;
	const end = tokenize(parts, pattern, head, pattern.length, TOKEN_REGEX, tokenize(parts, pattern, 0, head, FORMAT_TOKEN_REGEX, 0));
	parts.push(pattern.slice(end));

	return parts;
}

/**
 * Appends to `parts` the tokens of `pattern.slice(start, stop)` found by `regex`, each preceded by the literal text since `end`.
 * @param {Array<string | ((date: Date) => string)>} parts - The compiled pattern so far
 * @param {string} pattern - The whole pattern
 * @param {number} start - Start of the tokenized slice
 * @param {number} stop - End of the tokenized slice
 * @param {RegExp} regex - {@link FORMAT_TOKEN_REGEX} or {@link TOKEN_REGEX}
 * @param {number} end - End of the text already in `parts`
 * @returns {number} End of the text in `parts` after the last token
 * @example
 * tokenize([], 'D [D]', 0, 5, FORMAT_TOKEN_REGEX, 0); // => 5
 */
function tokenize(parts: Array<string | ((date: Date) => string)>, pattern: string, start: number, stop: number, regex: RegExp, end: number): number {
	for (const match of pattern.slice(start, stop).matchAll(regex)) {
		parts.push(pattern.slice(end, start + match.index), match[1] ?? FORMATTERS[match[0]]);
		end = start + match.index + match[0].length;
	}

	return end;
}

/**
 * Returns the LOCAL calendar date as `'YYYY-MM-DD'`.
 * Note: this differs from `date.toISOString().slice(0, 10)`, which uses the UTC date.
 * @param {DateInput} date - The date
 * @returns {string} The local date in ISO 8601 calendar format
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * toISODateString(new Date(2024, 0, 5, 23, 30)); // => '2024-01-05'
 */
export function toISODateString(date: DateInput): string {
	return formatDate(date, 'YYYY-MM-DD');
}

/**
 * Parses a strict `'YYYY-MM-DD'` string into a date at LOCAL midnight (unlike `new Date('YYYY-MM-DD')`, which is UTC).
 * Month and day ranges are validated, so impossible dates such as `'2023-02-30'` are rejected.
 * @param {string} value - The string to parse
 * @returns {Date | undefined} The parsed date, or `undefined` when the string is not a valid calendar date
 * @example
 * parseISODate('2024-02-29'); // => new Date(2024, 1, 29) // local midnight
 * parseISODate('2023-02-29'); // => undefined
 * parseISODate('2024-2-1'); // => undefined
 */
export function parseISODate(value: string): Date | undefined {
	const match = typeof value === 'string' ? ISO_DATE_REGEX.exec(value) : null;

	if (match === null) return undefined;

	const year = Number(match[1]);
	const monthIndex = Number(match[2]) - 1;
	const day = Number(match[3]);

	if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > daysInMonth(year, monthIndex)) return undefined;

	const date = localMidnight(year, monthIndex, day);

	// A calendar day that the time zone skipped (Samoa's December 30th, 2011) starts on the next day: like `parseDate`, reject it.
	return date.getDate() === day ? date : undefined;
}

/**
 * `Intl.RelativeTimeFormat` instances created by {@link relativeTimeFormat}, by locale (cached by `getRelativeTime`:
 * constructing one is much more expensive than formatting with it).
 */
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

/**
 * Creates an `Intl.RelativeTimeFormat` with `numeric: 'auto'` for `locale`.
 * @param {string} locale - A BCP 47 locale
 * @returns {Intl.RelativeTimeFormat} The formatter
 * @throws {RangeError} when the locale is malformed
 * @example
 * relativeTimeFormat('en').format(-1, 'day'); // => 'yesterday'
 */
function relativeTimeFormat(locale: string): Intl.RelativeTimeFormat {
	return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
}

/**
 * Describes `date` relative to `baseDate` in words, e.g. `'in 3 days'`, `'2 hours ago'`, `'yesterday'`, `'now'`,
 * using `Intl.RelativeTimeFormat` with `numeric: 'auto'`.
 *
 * The unit is chosen as follows: seconds below one minute, minutes below one hour, hours below one day (all from
 * the absolute millisecond delta, truncated toward zero); then calendar days (see {@link diffInDays}) below 7 days,
 * weeks while less than one complete month has elapsed (see {@link diffInMonths}), months below 12 months, else years.
 * @param {DateInput} date - The date to describe
 * @param {DateInput} [baseDate=new Date()] - The reference date ("now")
 * @param {string} [locale='en'] - A BCP 47 locale passed to `Intl.RelativeTimeFormat` (formatters are cached per locale, for the 64 most recent
 * locales of at most 1024 characters)
 * @returns {string} The relative time phrase
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid or the locale is malformed
 * @example
 * const base = new Date(2024, 0, 10, 12);
 * getRelativeTime(new Date(2024, 0, 10, 9), base); // => '3 hours ago'
 * getRelativeTime(new Date(2024, 0, 11, 12), base); // => 'tomorrow'
 * getRelativeTime(new Date(2024, 3, 10, 12), base); // => 'in 3 months'
 */
export function getRelativeTime(date: DateInput, baseDate: DateInput = new Date(), locale = 'en'): string {
	const target = toValidDate(date);
	const base = toValidDate(baseDate);
	const formatter = cached(relativeTimeFormats, locale, relativeTimeFormat);
	const delta = target.getTime() - base.getTime();

	if (Math.abs(delta) < MS_PER_MINUTE) return formatter.format(truncate(delta / MS_PER_SECOND), 'second');
	if (Math.abs(delta) < MS_PER_HOUR) return formatter.format(truncate(delta / MS_PER_MINUTE), 'minute');

	const days = diffInDays(target, base);

	// `days === 0` covers a 24h+ delta inside a single 25-hour (DST) day.
	if (Math.abs(delta) < MS_PER_DAY || days === 0) return formatter.format(truncate(delta / MS_PER_HOUR), 'hour');
	if (Math.abs(days) < 7) return formatter.format(days, 'day');

	const months = diffInMonths(target, base);

	if (months === 0) return formatter.format(truncate(days / 7), 'week');
	if (Math.abs(months) < 12) return formatter.format(months, 'month');

	return formatter.format(truncate(months / 12), 'year');
}

/**
 * Returns every LOCAL calendar day from `start` to `end` (both inclusive), each at the start of the day (normally
 * 00:00:00.000). Only the calendar days of `start` and `end` matter for which days are included.
 * The result holds one date per `step` days of the interval, so bound intervals that come from untrusted input (the range of valid
 * dates spans about 200 million days).
 * @param {DateInput} start - The first day of the interval
 * @param {DateInput} end - The last day of the interval (must not be before `start`)
 * @param {EachDayOfIntervalOptions} [options={}] - `step`: the number of days between consecutive results (default `1`)
 * @returns {Date[]} A new array of new dates, in ascending order; its first element is the start of `start`'s day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `step` is not a number
 * @throws {RangeError} when a date is invalid, `start` is after `end`, `step` is not a positive integer, or a result is out of range
 * @example
 * eachDayOfInterval(new Date(2024, 0, 30, 18), new Date(2024, 1, 2, 9)); // => [new Date(2024, 0, 30), new Date(2024, 0, 31), new Date(2024, 1, 1), new Date(2024, 1, 2)]
 * eachDayOfInterval(new Date(2024, 0, 1), new Date(2024, 0, 10), { step: 3 }); // => [new Date(2024, 0, 1), new Date(2024, 0, 4), new Date(2024, 0, 7), new Date(2024, 0, 10)]
 */
export function eachDayOfInterval(start: DateInput, end: DateInput, options: EachDayOfIntervalOptions = {}): Date[] {
	const { step = 1 } = options;

	return eachUnit('eachDayOfInterval', start, end, 4, step, 0, Infinity);
}

/**
 * Returns the ISO 8601 week number (1-53) of the LOCAL calendar date. ISO weeks start on Monday and week 1 is the week
 * that contains the year's first Thursday (equivalently, January 4th), so the first days of January may belong to
 * week 52/53 of the previous ISO year and the last days of December to week 1 of the next (see {@link getISOWeekYear}).
 * @param {DateInput} date - The date
 * @returns {number} The ISO week number, 1-53
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * getISOWeek(new Date(2024, 0, 1)); // => 1 // a Monday
 * getISOWeek(new Date(2021, 0, 3)); // => 53 // Sunday; belongs to ISO year 2020
 * getISOWeek(new Date(2024, 11, 30)); // => 1 // belongs to ISO year 2025
 */
export function getISOWeek(date: DateInput): number {
	return isoWeekParts(toValidDate(date))[1];
}

/**
 * Returns the ISO 8601 week-numbering year of the LOCAL calendar date: the calendar year of the Thursday of its ISO
 * week. It differs from the calendar year for a few days around New Year.
 * @param {DateInput} date - The date
 * @returns {number} The ISO week-numbering year
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * getISOWeekYear(new Date(2021, 0, 3)); // => 2020
 * getISOWeekYear(new Date(2024, 11, 30)); // => 2025
 * getISOWeekYear(new Date(2024, 5, 15)); // => 2024
 */
export function getISOWeekYear(date: DateInput): number {
	return isoWeekParts(toValidDate(date))[0];
}

/**
 * Returns the calendar quarter (1-4) of the LOCAL date: `Math.floor(monthIndex / 3) + 1`.
 * @param {DateInput} date - The date
 * @returns {Quarter} 1 (Jan-Mar), 2 (Apr-Jun), 3 (Jul-Sep) or 4 (Oct-Dec)
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * getQuarter(new Date(2024, 4, 10)); // => 2
 */
export function getQuarter(date: DateInput): Quarter {
	return (Math.floor(toValidDate(date).getMonth() / 3) + 1) as Quarter;
}

/**
 * Returns the first day of the local quarter at 00:00:00.000.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the quarter
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfQuarter(new Date(2024, 4, 10, 15)); // => new Date(2024, 3, 1)
 */
export function startOfQuarter(date: DateInput): Date {
	const result = toValidDate(date);

	return localMidnight(result.getFullYear(), result.getMonth() - (result.getMonth() % 3), 1);
}

/**
 * Returns the last day of the local quarter at 23:59:59.999.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the quarter
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfQuarter(new Date(2024, 4, 10)); // => new Date(2024, 5, 30, 23, 59, 59, 999)
 */
export function endOfQuarter(date: DateInput): Date {
	const source = toValidDate(date);

	// The instant before the first midnight of the next quarter.
	return lastInstantOfDay(localMidnight(source.getFullYear(), source.getMonth() - (source.getMonth() % 3) + 3, 1), 0);
}

/**
 * Returns a person's age: the number of COMPLETED years between the LOCAL calendar days of `birthDate` and `now` (the
 * time of day is ignored, so the age increases at the start of the birthday).
 *
 * February 29th birthdays: in non-leap years the birthday is taken to be **February 28th** (consistent with
 * {@link addYears}, which clamps Feb 29 to Feb 28), so `getAge(birthDate, addYears(birthDate, n)) === n` for every date.
 * @param {DateInput} birthDate - The date of birth
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {number} The age in completed years (`0` on the day of birth)
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when a date is invalid or `birthDate` is on a later calendar day than `now`
 * @example
 * getAge(new Date(1990, 5, 15), new Date(2024, 5, 14)); // => 33
 * getAge(new Date(1990, 5, 15), new Date(2024, 5, 15)); // => 34
 * getAge(new Date(2000, 1, 29), new Date(2001, 1, 28)); // => 1
 */
export function getAge(birthDate: DateInput, now: DateInput = new Date()): number {
	const birth = toValidDate(birthDate);
	const current = toValidDate(now);

	if (epochDay(birth) > epochDay(current)) throw new RangeError('getAge: `birthDate` must not be after `now`');

	const birthday = Math.min(birth.getDate(), daysInMonth(current.getFullYear(), birth.getMonth()));
	const hadBirthday = current.getMonth() > birth.getMonth() || (current.getMonth() === birth.getMonth() && current.getDate() >= birthday);
	const years = current.getFullYear() - birth.getFullYear();

	return hadBirthday ? years : years - 1;
}

/**
 * Adds a number of business days (Monday-Friday, local time; no holidays), skipping Saturdays and Sundays. The time
 * of day is preserved like in {@link addDays}.
 *
 * Weekend start: when `date` falls on a weekend, the first business day in the direction of travel counts as the
 * first step (Saturday + 1 → Monday, Sunday - 1 → Friday), so for any non-zero `amount` the result is always a
 * weekday. An `amount` of `0` returns a copy of `date` unchanged, even on a weekend.
 * @param {DateInput} date - The date to start from
 * @param {number} amount - The integer number of business days to add (negative to subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `amount` is not a number
 * @throws {RangeError} when `date` is invalid, `amount` is not an integer, or the result is out of range
 * @example
 * addBusinessDays(new Date(2024, 4, 17, 9), 1); // => new Date(2024, 4, 20, 9) // Friday → Monday
 * addBusinessDays(new Date(2024, 4, 20), -1); // => new Date(2024, 4, 17) // Monday → Friday
 * addBusinessDays(new Date(2024, 4, 18), 1); // => new Date(2024, 4, 20) // Saturday → Monday
 */
export function addBusinessDays(date: DateInput, amount: number): Date {
	assertInteger('addBusinessDays', 'amount', amount);

	const start = toValidDate(date);

	if (amount === 0) return start;

	const sign = Math.sign(amount);
	let weekday = start.getDay();
	let remaining = Math.abs(amount);
	let offset = 0;

	if (weekday === 0 || weekday === 6) {
		// Step onto the nearest weekday in the direction of travel; that counts as one business day.
		const target = sign > 0 ? 1 : 5;

		offset = sign > 0 ? mod(target - weekday, DAYS_PER_WEEK) : 0 - mod(weekday - target, DAYS_PER_WEEK);
		weekday = target;
		remaining -= 1;
	}

	// Five business days from a weekday are always exactly one calendar week.
	offset += sign * Math.trunc(remaining / 5) * DAYS_PER_WEEK;
	remaining %= 5;

	while (remaining > 0) {
		offset += sign;
		weekday = mod(weekday + sign, DAYS_PER_WEEK);
		if (weekday !== 0 && weekday !== 6) remaining -= 1;
	}

	let result = addDays(start, offset);

	// Only where a whole calendar day was skipped (Samoa's December 30th, 2011): the target day does not exist, `addDays` lands on the
	// next one, which can be a weekend day. Keep going in the direction of travel to the next weekday.
	while (isWeekendDay(result)) {
		offset += sign;
		result = addDays(start, offset);
	}

	return result;
}

/**
 * Checks whether a date falls on a Saturday or a Sunday (local time).
 * @param {Date} date - A valid date
 * @returns {boolean} `true` on weekends
 */
function isWeekendDay(date: Date): boolean {
	const day = date.getDay();
	return day === 0 || day === 6;
}

/**
 * Returns the signed number of business days (Monday-Friday, local calendar days; the time of day is ignored) between
 * two dates: for `later >= earlier` it counts the weekdays AFTER `earlier`'s day up to and INCLUDING `later`'s day;
 * for `later < earlier` it is `-diffInBusinessDays(earlier, later)`. Hence, for a weekday `d`,
 * `diffInBusinessDays(addBusinessDays(d, n), d) === n`.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of business days
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInBusinessDays(new Date(2024, 4, 20), new Date(2024, 4, 17)); // => 1 // Fri → Mon
 * diffInBusinessDays(new Date(2024, 4, 31), new Date(2024, 4, 1)); // => 22
 * diffInBusinessDays(new Date(2024, 4, 17), new Date(2024, 4, 20)); // => -1
 */
export function diffInBusinessDays(later: DateInput, earlier: DateInput): number {
	return weekdaysThrough(epochDay(toValidDate(later))) - weekdaysThrough(epochDay(toValidDate(earlier)));
}

/**
 * Checks whether a date falls on the same LOCAL calendar day as `now`.
 * @param {DateInput} date - The date to check
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {boolean} `true` when `date` is on `now`'s calendar day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isToday(new Date()); // => true
 * isToday(new Date(2024, 0, 1, 23, 59), new Date(2024, 0, 1, 8)); // => true
 */
export function isToday(date: DateInput, now: DateInput = new Date()): boolean {
	return isSameDay(date, now);
}

/**
 * Checks whether a date is strictly before `now` (absolute time).
 * @param {DateInput} date - The date to check
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {boolean} `true` when `date < now`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isPast(new Date(2000, 0, 1)); // => true
 * isPast(5, 5); // => false
 */
export function isPast(date: DateInput, now: DateInput = new Date()): boolean {
	return isBefore(date, now);
}

/**
 * Checks whether a date is strictly after `now` (absolute time).
 * @param {DateInput} date - The date to check
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {boolean} `true` when `date > now`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isFuture(Date.now() + 60_000); // => true
 * isFuture(5, 5); // => false
 */
export function isFuture(date: DateInput, now: DateInput = new Date()): boolean {
	return isAfter(date, now);
}

/**
 * Clamps a date into the closed range `[min, max]`.
 * @param {DateInput} date - The date to clamp
 * @param {DateInput} min - The lower bound
 * @param {DateInput} max - The upper bound (must not be before `min`)
 * @returns {Date} A new date: `min` if `date < min`, `max` if `date > max`, else a copy of `date`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when a date is invalid or `min` is after `max`
 * @example
 * clampDate(new Date(2025, 0, 1), new Date(2024, 0, 1), new Date(2024, 11, 31)); // => new Date(2024, 11, 31)
 * clampDate(new Date(2024, 5, 1), new Date(2024, 0, 1), new Date(2024, 11, 31)); // => new Date(2024, 5, 1)
 */
export function clampDate(date: DateInput, min: DateInput, max: DateInput): Date {
	const time = timeOf(date);
	const lower = timeOf(min);
	const upper = timeOf(max);

	if (lower > upper) throw new RangeError('clampDate: `min` must not be after `max`');

	return new Date(Math.min(Math.max(time, lower), upper));
}

/**
 * Formats a millisecond duration as a compact string such as `'1d 2h 3m'`.
 *
 * The duration is split into the selected units, largest first, with every unit but the largest one below its
 * natural limit (`h` < 24, `m` < 60…); units whose value is zero are skipped. Whatever is smaller than the smallest
 * selected unit, or than the last unit shown when `largest` is set, is TRUNCATED (not rounded). A zero result is
 * `'0s'` (or `0` followed by the smallest selected unit when `s` is not selected). Negative durations get a `'-'`
 * prefix. With the default options, {@link parseDuration} is its exact inverse for every safe integer.
 * @param {number} ms - The duration in milliseconds (finite; may be negative or fractional)
 * @param {FormatDurationOptions} [options={}] - `units`: the units allowed in the output (default all: `d`, `h`, `m`,
 * `s`, `ms`); `largest`: the maximum number of non-zero units to show (default unlimited)
 * @returns {string} The formatted duration
 * @throws {TypeError} when `ms` or `largest` is not a number, or `units` is not an array
 * @throws {RangeError} when `ms` is not finite, `units` is empty or contains an unknown unit, or `largest` is not a positive integer
 * @example
 * formatDuration(93_784_005); // => '1d 2h 3m 4s 5ms'
 * formatDuration(5_400_000); // => '1h 30m'
 * formatDuration(0); // => '0s'
 * formatDuration(-90_500); // => '-1m 30s 500ms'
 * formatDuration(93_784_005, { largest: 2 }); // => '1d 2h'
 * formatDuration(93_784_005, { units: ['h', 'm'] }); // => '26h 3m'
 */
export function formatDuration(ms: number, options: FormatDurationOptions = {}): string {
	assertNumber('formatDuration', 'ms', ms, Number.isFinite(ms), 'a finite number');

	const { units = DURATION_UNITS, largest = Infinity } = options;

	if (!Array.isArray(units)) throw new TypeError(`formatDuration: \`units\` must be an array of duration units, got ${describe(units)}`);
	if (units.length === 0) throw new RangeError('formatDuration: `units` must not be empty');

	// An index loop, unlike `forEach`, also visits the holes of a sparse array.
	for (let i = 0; i < units.length; i++) {
		const unit: unknown = units[i];

		if (!DURATION_UNITS.includes(unit as DurationUnit))
			throw new RangeError(`formatDuration: \`units\` must only contain ${DURATION_UNITS.join(', ')}, got ${typeof unit === 'string' ? unit : describe(unit)}`);
	}

	assertCount('formatDuration', 'largest', largest, 1, true);

	const selected = DURATION_UNITS.filter(function (unit: DurationUnit): boolean {
		return units.includes(unit);
	});
	const parts: string[] = [];
	let rest = Math.abs(ms);

	for (const unit of selected) {
		if (parts.length >= largest) break;

		const size = DURATION_UNIT_MS[unit];
		let value = Math.floor(rest / size);

		// Guard against the quotient being rounded up to the next integer for large values.
		if (value * size > rest) value -= 1;

		rest -= value * size;

		if (value > 0) parts.push(`${value}${unit}`);
	}

	if (parts.length === 0) return units.includes('s') ? '0s' : `0${selected[selected.length - 1]}`;

	return (ms < 0 ? '-' : '') + parts.join(' ');
}

/**
 * Parses a duration string made of `<number><unit>` tokens (units `d`, `h`, `m`, `s`, `ms`, lowercase; whitespace
 * between and inside tokens is optional; decimals such as `'1.5h'` or `'.5s'` are allowed) into milliseconds, e.g.
 * `'1h 30m'` → `5_400_000`. Tokens may appear in any order and repeated units are summed. A single leading `'-'`
 * negates the whole duration. It is the inverse of {@link formatDuration}'s output.
 * @param {string} value - The duration string
 * @returns {number} The duration in milliseconds (may be fractional, e.g. `'0.5ms'`)
 * @throws {TypeError} when `value` is not a string or is not a valid duration (empty, a bare number, an unknown unit…)
 * @throws {RangeError} when the duration is too large to be represented as a finite number
 * @example
 * parseDuration('1h 30m'); // => 5_400_000
 * parseDuration('1d 2h 3m 4s 5ms'); // => 93_784_005
 * parseDuration('1.5s'); // => 1_500
 * parseDuration('-2m'); // => -120_000
 * parseDuration('10'); // throws TypeError (missing unit)
 */
export function parseDuration(value: string): number {
	if (typeof value !== 'string') throw new TypeError(`parseDuration: \`value\` must be a string, got ${describe(value)}`);
	if (!DURATION_REGEX.test(value))
		throw new TypeError(`parseDuration: \`value\` must be a valid duration, got ${JSON.stringify(value.length > 50 ? `${value.slice(0, 50)}…` : value)}`);

	let total = 0;

	for (const [, amount, unit] of value.matchAll(DURATION_TOKEN_REGEX)) {
		total += Number(amount) * DURATION_UNIT_MS[unit as DurationUnit];
	}

	if (!Number.isFinite(total)) throw new RangeError('parseDuration: the duration is too large to be represented');

	return value.trimStart().startsWith('-') ? 0 - total : total;
}

/**
 * Returns the epoch day number of the first day of the week containing `date`.
 * @param {Date} date - A valid date
 * @param {number} weekStartsOn - The first day of the week: 0 = Sunday … 6 = Saturday
 * @returns {number} The epoch day number of the week's first day
 * @example
 * weekStartDay(new Date(1970, 0, 8), 1); // => 4 // Thursday Jan 8 → Monday Jan 5
 */
function weekStartDay(date: Date, weekStartsOn: number): number {
	const day = epochDay(date);

	// 1970-01-01 (epoch day 0) was a Thursday (weekday 4).
	return day - mod(day + 4 - weekStartsOn, DAYS_PER_WEEK);
}

/**
 * Applies a {@link Duration} (multiplied by `sign`) to a date, largest units first: the calendar months (years and months), then the
 * calendar days (weeks and days), in one wall-clock step with end-of-month clamping, then the absolute time.
 * @param {string} caller - Name of the public function, used in the error messages
 * @param {DateInput} date - The date to start from
 * @param {Duration} duration - The duration
 * @param {number} sign - `1` to add, `-1` to subtract
 * @returns {Date} A new date
 * @throws {TypeError} when `date` is neither a `Date` nor a number, `duration` is not an object, or a field is not a number
 * @throws {RangeError} when `date` is invalid, a field is unknown or invalid, or the result is out of range
 * @example
 * applyDuration('addDuration', new Date(2024, 0, 31), { months: 1, days: 1 }, 1); // => new Date(2024, 2, 1)
 */
function applyDuration(caller: string, date: DateInput, duration: Duration, sign: number): Date {
	if (typeof duration !== 'object' || duration === null) throw new TypeError(`${caller}: \`duration\` must be an object, got ${describe(duration)}`);

	for (const key of Object.keys(duration)) {
		if (!DURATION_FIELDS.includes(key as keyof Duration))
			throw new RangeError(`${caller}: \`duration\` must only have the fields ${DURATION_FIELDS.join(', ')}, got ${JSON.stringify(key)}`);
	}

	// Total months, days and milliseconds.
	const totals = [0, 0, 0];

	DURATION_FIELDS.forEach(function (field: keyof Duration, index: number): void {
		// Own fields only, like the check of unknown fields above (an inherited `days` must not move the date).
		const amount = Object.prototype.hasOwnProperty.call(duration, field) ? duration[field] : undefined;

		if (amount === undefined) return;

		const calendar = index < 4;

		assertNumber(caller, `duration.${field}`, amount, calendar ? Number.isInteger(amount) : Number.isFinite(amount), calendar ? 'an integer' : 'a finite number');
		totals[Math.min(index >> 1, 2)] += sign * amount * DURATION_FIELD_SIZES[index];
	});

	const result = shiftCalendar(toValidDate(date), totals[0], totals[1]);

	return totals[2] === 0 ? result : ensureInRange(new Date(result.getTime() + totals[2]));
}

/**
 * Adds a {@link Duration} to a date, applying the units LARGEST FIRST (the order of date-fns' `add`, Luxon and Temporal): years and
 * months together, with the end-of-month clamping of {@link addMonths}; then weeks and days, as calendar days that keep the
 * wall-clock time (like {@link addDays}); then hours, minutes, seconds and milliseconds on the absolute timeline (like
 * {@link addHours}). The order matters at month ends: `{ months: 1, days: 1 }` from January 31st gives March 1st (Jan 31 →
 * Feb 29 → Mar 1), whereas adding the day first would give March 1st + 1 month = April 1st.
 *
 * The calendar part is a single wall-clock conversion, so it is DST-safe like {@link addDays}. For every `start <= end`,
 * `addDuration(start, intervalToDuration(start, end))` is exactly `end`.
 * @param {DateInput} date - The date to start from
 * @param {Duration} duration - The amounts to add (missing fields count as `0`; negative amounts subtract)
 * @returns {Date} A new date
 * @throws {TypeError} when `date` is neither a `Date` nor a number, `duration` is not an object, or a field is not a number
 * @throws {RangeError} when `date` is invalid, `duration` has an unknown field, a calendar field is not an integer, a time field is not
 * finite, or the result is out of range
 * @example
 * addDuration(new Date(2024, 0, 31, 9), { months: 1, days: 1, hours: 2 }); // => new Date(2024, 2, 1, 11)
 * addDuration(new Date(2023, 0, 31), { months: 1 }); // => new Date(2023, 1, 28)
 * addDuration(new Date(2024, 1, 29), { years: 1, weeks: 1 }); // => new Date(2025, 2, 7)
 * addDuration(new Date(2024, 0, 1), { days: 1.5 }); // throws RangeError (calendar units must be integers)
 */
export function addDuration(date: DateInput, duration: Duration): Date {
	return applyDuration('addDuration', date, duration, 1);
}

/**
 * Subtracts a {@link Duration} from a date: the same as {@link addDuration} with every field negated (so the largest units are
 * still applied first, with end-of-month clamping). Because of the clamping, `subDuration(addDuration(date, d), d)` is not always
 * `date` (Jan 31 + 1 month = Feb 28; Feb 28 - 1 month = Jan 28).
 * @param {DateInput} date - The date to start from
 * @param {Duration} duration - The amounts to subtract (missing fields count as `0`)
 * @returns {Date} A new date
 * @throws {TypeError} when `date` is neither a `Date` nor a number, `duration` is not an object, or a field is not a number
 * @throws {RangeError} when `date` is invalid, `duration` has an unknown field, a calendar field is not an integer, a time field is not
 * finite, or the result is out of range
 * @example
 * subDuration(new Date(2024, 2, 31, 12), { months: 1, hours: 12 }); // => new Date(2024, 1, 29)
 * subDuration(new Date(2024, 0, 10), { weeks: 1, days: 2 }); // => new Date(2024, 0, 1)
 */
export function subDuration(date: DateInput, duration: Duration): Date {
	return applyDuration('subDuration', date, duration, -1);
}

/**
 * Breaks the interval from `start` to `end` into calendar components, largest first: the most complete months (reported as
 * `years` and `months`) that fit after `start` (with the end-of-month clamping of {@link addMonths}), then the most complete days
 * that fit after that, then the remaining absolute time as `hours` (normally below 24, but 24 when the last day lasts 25 hours),
 * `minutes`, `seconds` and `milliseconds`. It is the exact inverse of {@link addDuration}:
 * `addDuration(start, intervalToDuration(start, end))` is always `end`.
 *
 * When `end` is before `start`, every component is negative or zero and the same steps are taken backwards from `start` (so
 * the result is not always the negation of `intervalToDuration(end, start)`, but still adds back to `end`). `weeks` is never set.
 * @param {DateInput} start - The start of the interval
 * @param {DateInput} end - The end of the interval
 * @returns {IntervalDuration} The components, all present (zero when empty)
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * intervalToDuration(new Date(2024, 0, 31, 9), new Date(2025, 2, 1, 11, 30)); // => { years: 1, months: 1, days: 1, hours: 2, minutes: 30, seconds: 0, milliseconds: 0 }
 * intervalToDuration(new Date(2023, 0, 31), new Date(2023, 1, 28)); // => { years: 0, months: 1, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }
 * intervalToDuration(new Date(2024, 0, 2), new Date(2024, 0, 1, 12)); // => { years: 0, months: 0, days: 0, hours: -12, minutes: 0, seconds: 0, milliseconds: 0 }
 */
export function intervalToDuration(start: DateInput, end: DateInput): IntervalDuration {
	const from = toValidDate(start);
	const to = toValidDate(end);
	const target = to.getTime();
	const sign = target < from.getTime() ? -1 : 1;
	let months = calendarMonthDiff(to, from);
	// Trial shifts may land past the representable range (an invalid date): that counts as too far.
	let reached = shiftCalendarUnchecked(new Date(from), months, 0);

	// One month too far (the day or the time of day is not reached yet) in the direction of travel.
	if (!(sign * (reached.getTime() - target) <= 0)) {
		months -= sign;
		reached = shiftCalendar(new Date(from), months, 0);
	}

	let days = diffInDays(to, reached);

	reached = shiftCalendarUnchecked(new Date(from), months, days);

	// Likewise one day too far (the time of day is not reached yet).

	while (!(sign * (reached.getTime() - target) <= 0)) {
		days -= sign;
		reached = shiftCalendarUnchecked(new Date(from), months, days);
	}

	const rest = target - reached.getTime();

	return {
		years: truncate(months / 12),
		months: (months % 12) + 0,
		days,
		hours: truncate(rest / MS_PER_HOUR),
		minutes: truncate((rest % MS_PER_HOUR) / MS_PER_MINUTE),
		seconds: truncate((rest % MS_PER_MINUTE) / MS_PER_SECOND),
		milliseconds: (rest % MS_PER_SECOND) + 0
	};
}

/**
 * Formats a date as an RFC 3339 / ISO 8601 timestamp in LOCAL time with its UTC offset, e.g. `'2026-10-18T09:30:00.000+02:00'`:
 * what people usually expect from `Date#toISOString()`, which always uses UTC (`Z`). Offsets with minutes are written in full
 * (`+05:30` in India, `+05:45` in Nepal, `-03:30` in Newfoundland, `+10:30` on Lord Howe Island) and a zero offset is written `Z`,
 * so in a UTC environment the result equals `toISOString()`. Years outside 0-9999 use the expanded form of `toISOString()`
 * (`'-000001-…'`, `'+010000-…'`).
 *
 * The string always denotes the same instant (`new Date(toISOStringLocal(d))` equals `d`). Historical local mean time offsets have
 * seconds (Paris used +00:09:21 until 1911), which RFC 3339 cannot express: such an offset is rounded to the minute and the time is
 * shown in that rounded offset (date-fns' `formatISO` keeps the wall-clock time with a truncated offset, which is a different
 * instant). For the same reason the result may differ from the wall-clock fields by those seconds.
 * @param {DateInput} date - The date to format
 * @param {ToISOStringLocalOptions} [options={}] - `milliseconds`: `false` to leave out the `.SSS` fraction (default `true`)
 * @returns {string} The local timestamp with its offset
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid, or (within minutes of the limits of the `Date` range, where the offset has seconds) the
 * time at the rounded offset is out of range
 * @example
 * toISOStringLocal(new Date(Date.UTC(2026, 9, 18, 7, 30))); // '2026-10-18T09:30:00.000+02:00' in Paris, '2026-10-18T13:00:00.000+05:30' in India
 * new Date(toISOStringLocal(new Date(2026, 9, 18, 9, 30))); // => new Date(2026, 9, 18, 9, 30)
 * toISOStringLocal(new Date(2026, 9, 18, 9, 30, 15), { milliseconds: false }).slice(0, 19); // => '2026-10-18T09:30:15'
 */
export function toISOStringLocal(date: DateInput, options: ToISOStringLocalOptions = {}): string {
	const local = toValidDate(date);
	const time = local.getTime();
	const year = local.getFullYear();
	// The offset of the wall clock, from the local fields: `Date.UTC` would remap the years 0-99, and `getTimezoneOffset()` drops the
	// seconds of historical offsets.
	const offsetMs = epochDay(local) * MS_PER_DAY + local.getHours() * MS_PER_HOUR + msIntoHour(local) - time;
	const offset = Math.round(offsetMs / MS_PER_MINUTE);
	const minutes = Math.abs(offset);
	const suffix = offset === 0 ? 'Z' : `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}`;
	const withMilliseconds = options.milliseconds !== false;

	// An offset with seconds cannot be written: show the instant at the rounded offset instead of the wall clock.
	if (offsetMs !== offset * MS_PER_MINUTE) {
		return ensureInRange(new Date(time + offset * MS_PER_MINUTE))
			.toISOString()
			.slice(0, withMilliseconds ? -1 : -5)
			.concat(suffix);
	}

	// The years outside 0-9999 take the expanded form of `toISOString()` (`pad` keeps the minus sign).
	const yearText = year >= 0 && year <= 9999 ? pad(year, 4) : (year < 0 ? '' : '+') + pad(year, 6);

	return yearText + formatDate(local, withMilliseconds ? '-MM-DD[T]HH:mm:ss.SSS' : '-MM-DD[T]HH:mm:ss') + suffix;
}

/**
 * Returns the signed number of COMPLETE weeks between two dates: for `later >= earlier` it is the largest `n` such that
 * `addWeeks(earlier, n) <= later` (calendar weeks that keep the wall-clock time, so a week across a DST change still counts once);
 * for `later < earlier` it is `-diffInWeeks(earlier, later)`. Same complete-unit semantics as {@link diffInMonths}.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of complete weeks
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInWeeks(new Date(2024, 0, 15), new Date(2024, 0, 1)); // => 2
 * diffInWeeks(new Date(2024, 0, 15, 8), new Date(2024, 0, 1, 9)); // => 1 // 9:00 not reached yet
 * diffInWeeks(new Date(2024, 0, 1), new Date(2024, 0, 15)); // => -2
 */
export function diffInWeeks(later: DateInput, earlier: DateInput): number {
	return diffInCompleteUnits(later, earlier, 0, DAYS_PER_WEEK);
}

/**
 * Returns the signed number of COMPLETE years between two dates: for `later >= earlier` it is the largest `n` such that
 * `addYears(earlier, n) <= later` (time of day included); for `later < earlier` it is `-diffInYears(earlier, later)`. Same
 * complete-unit semantics as {@link diffInMonths}.
 *
 * February 29th: like {@link addYears} and {@link getAge}, a year from February 29th ends on February 28th of a non-leap year, so
 * `diffInYears(new Date(2025, 1, 28), new Date(2024, 1, 29)) === 1` (date-fns' `differenceInYears` says `0`).
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The number of complete years
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInYears(new Date(2024, 5, 15), new Date(2020, 5, 16)); // => 3
 * diffInYears(new Date(2025, 1, 28), new Date(2024, 1, 29)); // => 1
 * diffInYears(new Date(2020, 0, 1), new Date(2024, 0, 1)); // => -4
 */
export function diffInYears(later: DateInput, earlier: DateInput): number {
	return diffInCompleteUnits(later, earlier, 12, 0);
}

/**
 * Returns the signed number of calendar months between two dates (local time), ignoring the day and the time of day:
 * `12 * (later's year - earlier's year) + (later's month - earlier's month)`.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} The difference in calendar months
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInCalendarMonths(new Date(2024, 0, 1), new Date(2023, 11, 31)); // => 1
 * diffInCalendarMonths(new Date(2024, 2, 31), new Date(2024, 2, 1)); // => 0
 */
export function diffInCalendarMonths(later: DateInput, earlier: DateInput): number {
	return calendarMonthDiff(toValidDate(later), toValidDate(earlier));
}

/**
 * Returns the signed number of calendar years between two dates (local time), ignoring everything but the year.
 * @param {DateInput} later - The later date
 * @param {DateInput} earlier - The earlier date
 * @returns {number} `later`'s year minus `earlier`'s year
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * diffInCalendarYears(new Date(2024, 0, 1), new Date(2023, 11, 31)); // => 1
 */
export function diffInCalendarYears(later: DateInput, earlier: DateInput): number {
	return toValidDate(later).getFullYear() - toValidDate(earlier).getFullYear();
}

/**
 * Returns the milliseconds elapsed since the start of the local wall-clock hour.
 * @param {Date} date - A date
 * @returns {number} `minutes * 60000 + seconds * 1000 + milliseconds` of the local time (`NaN` for an invalid date)
 * @example
 * msIntoHour(new Date(2024, 0, 1, 9, 2, 3, 4)); // => 123_004
 */
function msIntoHour(date: Date): number {
	return date.getMinutes() * MS_PER_MINUTE + date.getSeconds() * MS_PER_SECOND + date.getMilliseconds();
}

/**
 * Returns the boundary of a wall-clock grid of `stepMs` (a divisor of an hour) at or around `date`: `'floor'` gives the last
 * boundary at or before `date`, `'ceil'` the first at or after it, `'round'` the nearest one (ties go up) and `'next'` the
 * first one strictly after it.
 *
 * The boundary is normally `date`'s distance to it on the wall clock away on the timeline too. When the UTC offset changes in
 * between, the instant that far away on the timeline is taken when the wall clock reads a grid time there (so the repeated hour after
 * clocks are set back keeps its own boundaries), else the wall-clock boundary (after a change by a fraction of the step, e.g. Lord
 * Howe Island's 30 minutes), where a time inside a DST gap is moved forward by the gap and a repeated one takes its first occurrence.
 * @param {Date} date - A valid date, which may be mutated (callers pass a fresh copy)
 * @param {number} stepMs - The grid step in milliseconds, a divisor of an hour
 * @param {string} mode - `'floor'`, `'ceil'`, `'round'` or `'next'`
 * @returns {Date} The boundary
 * @throws {RangeError} when the result is outside the representable range
 * @example
 * gridBoundary(new Date(2024, 0, 1, 9, 40), 15 * 60_000, 'round'); // => new Date(2024, 0, 1, 9, 45)
 */
function gridBoundary(date: Date, stepMs: number, mode: string): Date {
	const time = date.getTime();
	const intoHour = msIntoHour(date);
	const intoStep = intoHour % stepMs;
	const back = mode === 'next' ? 1 : 0;
	const next = back === 1 || (mode === 'ceil' ? intoStep > 0 : mode === 'round' && intoStep * 2 >= stepMs) ? 1 : 0;
	// How long before `date` the boundary is (negative when it is after) on the wall clock.
	const distance = intoStep - next * stepMs;

	date.setMinutes(0, 0, intoHour - distance);

	// The usual case: no change of UTC offset in between, so the wall-clock boundary is as far away on the timeline.
	if (time - date.getTime() === distance) return date;

	// Otherwise take the instant that far away on the timeline (the repeated hour after clocks are set back keeps its own boundaries)
	// when the wall clock reads a grid time there (for `'next'`: 1 ms before it), else the wall-clock boundary (a change by a fraction
	// of the step, e.g. Lord Howe Island's 30 minutes, moves the grid).
	const result = new Date(time - distance);

	return ensureInRange((msIntoHour(new Date(result.getTime() - back)) + back) % stepMs === 0 ? result : date);
}

/**
 * Returns the instant just before a boundary returned by {@link gridBoundary} (the end of the unit that it closes).
 * @param {Date} boundary - A valid date, which is mutated
 * @returns {Date} `boundary` minus 1 ms
 * @throws {RangeError} when the result is outside the representable range
 * @example
 * justBefore(new Date(5)).getTime(); // => 4
 */
function justBefore(boundary: Date): Date {
	boundary.setTime(boundary.getTime() - 1);

	return ensureInRange(boundary);
}

/**
 * Returns the start of the local wall-clock hour (`HH:00:00.000`) containing `date`. Across DST changes it stays on the hour actually
 * shown by the clock: in the repeated hour after clocks are set back, it returns the `01:00` of the SAME occurrence (date-fns'
 * `startOfHour` jumps to the first one, an hour earlier); after a change by a fraction of an hour (Lord Howe Island), it returns
 * the instant at which the wall clock last showed `HH:00` (or, when that hour began inside the gap, the end of the gap).
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the hour
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfHour(new Date(2024, 4, 10, 15, 42, 7, 9)); // => new Date(2024, 4, 10, 15)
 */
export function startOfHour(date: DateInput): Date {
	return gridBoundary(toValidDate(date), MS_PER_HOUR, 'floor');
}

/**
 * Returns the last millisecond of the local wall-clock hour (`HH:59:59.999`) containing `date`: the instant before the next hour
 * starts (see {@link startOfHour} for the DST behaviour).
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the hour
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfHour(new Date(2024, 4, 10, 15, 42)); // => new Date(2024, 4, 10, 15, 59, 59, 999)
 */
export function endOfHour(date: DateInput): Date {
	const valid = toValidDate(date);
	const start = gridBoundary(new Date(valid), MS_PER_HOUR, 'floor').getTime();
	let next = gridBoundary(valid, MS_PER_HOUR, 'next');

	// After clocks are set back by a fraction of an hour (Lord Howe Island: 02:00 becomes 01:30), the wall clock shows the same hour
	// again past the first boundary: the hour that `startOfHour` returns ends where the next hour starts.
	while (gridBoundary(new Date(next), MS_PER_HOUR, 'floor').getTime() === start) next = gridBoundary(next, MS_PER_HOUR, 'next');

	return justBefore(next);
}

/**
 * Returns the start of the local wall-clock minute (`HH:mm:00.000`) containing `date` (see {@link startOfHour} for the DST behaviour).
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the start of the minute
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * startOfMinute(new Date(2024, 4, 10, 15, 42, 7, 9)); // => new Date(2024, 4, 10, 15, 42)
 */
export function startOfMinute(date: DateInput): Date {
	return gridBoundary(toValidDate(date), MS_PER_MINUTE, 'floor');
}

/**
 * Returns the last millisecond of the local wall-clock minute (`HH:mm:59.999`) containing `date`.
 * @param {DateInput} date - The date
 * @returns {Date} A new date at the end of the minute
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid or the result is outside the representable range
 * @example
 * endOfMinute(new Date(2024, 4, 10, 15, 42, 7)); // => new Date(2024, 4, 10, 15, 42, 59, 999)
 */
export function endOfMinute(date: DateInput): Date {
	return justBefore(gridBoundary(toValidDate(date), MS_PER_MINUTE, 'next'));
}

/**
 * Rounds a date to a grid of `step` minutes of the local wall clock (`step` must divide 60, so the grid restarts at every hour:
 * `:00`, `:15`, `:30`, `:45` for 15), e.g. to snap a time picker to 5- or 15-minute slots. Seconds and milliseconds count: with
 * `'round'`, `09:07:30` is nearer to `09:10` than to `09:05` on a 5-minute grid, and a tie goes to the later slot. Across DST changes
 * the grid follows the wall clock, like {@link startOfHour}. `step` 60 rounds to the hour.
 * @param {DateInput} date - The date to round
 * @param {number} [step=1] - The grid step in minutes: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60
 * @param {RoundingMode} [mode='round'] - `'round'` (nearest, ties up), `'floor'` (down) or `'ceil'` (up)
 * @returns {Date} A new date on the grid
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `step` is not a number
 * @throws {RangeError} when `date` is invalid, `step` does not divide 60, `mode` is unknown, or the result is out of range
 * @example
 * roundToNearestMinutes(new Date(2024, 0, 1, 9, 7, 30), 5); // => new Date(2024, 0, 1, 9, 10)
 * roundToNearestMinutes(new Date(2024, 0, 1, 9, 7), 15, 'floor'); // => new Date(2024, 0, 1, 9, 0)
 * roundToNearestMinutes(new Date(2024, 0, 1, 9, 50), 15, 'ceil'); // => new Date(2024, 0, 1, 10, 0)
 * roundToNearestMinutes(new Date(2024, 0, 1, 9, 29, 59)); // => new Date(2024, 0, 1, 9, 30)
 */
export function roundToNearestMinutes(date: DateInput, step = 1, mode: RoundingMode = 'round'): Date {
	assertNumber('roundToNearestMinutes', 'step', step, Number.isInteger(step) && step > 0 && 60 % step === 0, 'a divisor of 60');
	assertOneOf('roundToNearestMinutes', 'mode', mode, ROUNDING_MODES);

	return gridBoundary(toValidDate(date), step * MS_PER_MINUTE, mode);
}

/**
 * Returns the start of every `unit` from the one containing `start` to the one containing `end` (both included), stepping by `step`
 * units: years (January 1st), quarters, months (the 1st), weeks (starting on `weekStartsOn`), days (each at the start of the day,
 * like {@link eachDayOfInterval}), hours or minutes. The first result is the start of `start`'s unit, which may be before `start`.
 *
 * Calendar units are local midnights, the `k`-th one computed from the first (`k × step` units later), never from the previous one,
 * so nothing drifts at month ends. Hours and minutes are stepped on the absolute timeline, each step snapped to the wall-clock unit it
 * lands in (see {@link startOfHour}): the repeated hour after clocks are set back appears twice, the skipped one not at all, and in
 * a zone that shifts by 30 minutes (Lord Howe Island) the results stay on the wall-clock hours (date-fns drifts to `:30`).
 * @param {DateInput} start - The start of the interval
 * @param {DateInput} end - The end of the interval (must not be before `start`)
 * @param {IntervalUnit} unit - `'year'`, `'quarter'`, `'month'`, `'week'`, `'day'`, `'hour'` or `'minute'`
 * @param {number} [step=1] - The number of units between consecutive results (a positive safe integer)
 * @param {WeekdayIndex} [weekStartsOn=0] - For weeks, the first day of the week: 0 = Sunday … 6 = Saturday
 * @returns {Date[]} A new array of new dates, in ascending order
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `step` or `weekStartsOn` is not a number
 * @throws {RangeError} when a date is invalid, `start` is after `end`, `unit` is unknown, `step` is not a positive safe integer,
 * `weekStartsOn` is not an integer between 0 and 6, the result would hold more than 1 000 000 dates, or a date is out of range
 * @example
 * eachOfInterval(new Date(2024, 0, 31), new Date(2024, 3, 15), 'month'); // => [new Date(2024, 0, 1), new Date(2024, 1, 1), new Date(2024, 2, 1), new Date(2024, 3, 1)]
 * eachOfInterval(new Date(2024, 0, 1, 9, 30), new Date(2024, 0, 1, 12), 'hour', 1); // => [new Date(2024, 0, 1, 9), new Date(2024, 0, 1, 10), new Date(2024, 0, 1, 11), new Date(2024, 0, 1, 12)]
 * eachOfInterval(new Date(2024, 0, 3), new Date(2024, 0, 20), 'week', 1, 1); // => [new Date(2024, 0, 1), new Date(2024, 0, 8), new Date(2024, 0, 15)]
 * eachOfInterval(new Date(2020, 5, 1), new Date(2024, 5, 1), 'year', 2); // => [new Date(2020, 0, 1), new Date(2022, 0, 1), new Date(2024, 0, 1)]
 */
export function eachOfInterval(start: DateInput, end: DateInput, unit: IntervalUnit, step = 1, weekStartsOn: WeekdayIndex = 0): Date[] {
	assertOneOf('eachOfInterval', 'unit', unit, INTERVAL_UNITS);
	assertWeekday('eachOfInterval', weekStartsOn);

	return eachUnit('eachOfInterval', start, end, INTERVAL_UNITS.indexOf(unit), step, weekStartsOn, MAX_INTERVAL_DATES);
}

/**
 * Implements {@link eachOfInterval} (and {@link eachDayOfInterval}, with no limit) for the unit at `index` in {@link INTERVAL_UNITS}.
 * @param {string} caller - Name of the public function, used in the error messages
 * @param {DateInput} start - The start of the interval
 * @param {DateInput} end - The end of the interval
 * @param {number} index - The unit's index in {@link INTERVAL_UNITS}
 * @param {number} step - The number of units between consecutive results
 * @param {number} weekStartsOn - For weeks, the first day of the week (already validated)
 * @param {number} max - The largest number of dates to return
 * @returns {Date[]} The dates
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `step` is not a number
 * @throws {RangeError} when a date is invalid, `start` is after `end`, `step` is not a positive safe integer, the result would hold more
 * than `max` dates, or a date is out of range
 * @example
 * eachUnit('eachOfInterval', 0, 0, 4, 1, 0, 10).length; // => 1
 */
function eachUnit(caller: string, start: DateInput, end: DateInput, index: number, step: number, weekStartsOn: number, max: number): Date[] {
	assertNumber(caller, 'step', step, Number.isSafeInteger(step) && step >= 1, 'a safe integer >= 1');

	const from = toValidDate(start);
	const to = toValidDate(end);

	if (from.getTime() > to.getTime()) throw new RangeError(`${caller}: \`start\` must not be after \`end\``);

	// The unit's size on its scale: absolute milliseconds (hours, minutes), month numbers (years, quarters, months) or epoch day
	// numbers (weeks, days).
	const unitSize = [12, 3, 1, DAYS_PER_WEEK, 1, MS_PER_HOUR, MS_PER_MINUTE][index];
	const size = unitSize * step;
	const byMonth = index < 3;
	const byTime = index > 4;
	const result: Date[] = [];
	let first: number;
	let last: number;

	if (byTime) {
		first = gridBoundary(from, unitSize, 'floor').getTime();
		last = to.getTime();
	} else if (byMonth) {
		first = from.getFullYear() * 12 + from.getMonth();
		first -= mod(first, unitSize);
		last = to.getFullYear() * 12 + to.getMonth();
	} else {
		first = index === 3 ? weekStartDay(from, weekStartsOn) : epochDay(from);
		last = epochDay(to);
	}

	const count = Math.floor((last - first) / size) + 1;

	if (count > max) throw new RangeError(`${caller}: the interval holds ${count} dates, more than ${max}`);

	if (!byTime) {
		for (let k = 0; k < count; k++) {
			const date = byMonth ? localMidnight(0, first + k * size, 1) : localMidnight(1970, 0, 1 + first + k * size);
			// A skipped calendar day (Samoa's December 30th, 2011) starts where the next one does: list that instant once.
			if (result.length === 0 || result[result.length - 1].getTime() !== date.getTime()) result.push(date);
		}

		return result;
	}

	// Each result is snapped to the wall-clock unit that `step` units later falls in, so nothing drifts. After a change by a fraction
	// of the unit (30 minutes on Lord Howe Island) that can be the unit just added, or one starting after a skipped half unit.
	for (let value = first; value <= last;) {
		result.push(new Date(value));

		const jumped = new Date(value + size);

		// Past the largest date: no further unit can start in range.
		if (Number.isNaN(jumped.getTime())) break;

		const next = gridBoundary(new Date(jumped), unitSize, 'floor').getTime();

		value = next > value ? next : gridBoundary(jumped, unitSize, 'ceil').getTime();
	}

	return result;
}

/**
 * Returns the next given weekday STRICTLY after `date` (local time), keeping the time of day like {@link addDays}: on a Monday,
 * `nextWeekday(date, 1)` is the following Monday, 7 days later (never `date` itself).
 * @param {DateInput} date - The date to start from
 * @param {WeekdayIndex} weekday - The weekday to find: 0 = Sunday … 6 = Saturday
 * @returns {Date} A new date, 1 to 7 days after `date`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `weekday` is not a number
 * @throws {RangeError} when `date` is invalid, `weekday` is not an integer between 0 and 6, or the result is out of range
 * @example
 * nextWeekday(new Date(2024, 4, 15, 9), 5); // => new Date(2024, 4, 17, 9) // Wednesday → Friday
 * nextWeekday(new Date(2024, 4, 15), 3); // => new Date(2024, 4, 22) // Wednesday → next Wednesday
 */
export function nextWeekday(date: DateInput, weekday: WeekdayIndex): Date {
	assertWeekday('nextWeekday', weekday, 'weekday');

	const result = toValidDate(date);

	return onWeekday(result, mod(weekday - result.getDay() - 1, DAYS_PER_WEEK) + 1, weekday);
}

/**
 * Shifts a date by a number of days that should land on `weekday`, one more week further when that day was skipped (Samoa's
 * December 30th, 2011, a Friday: the shift then lands on the next day).
 * @param {Date} date - A valid date, which is mutated
 * @param {number} days - The shift, in calendar days
 * @param {number} weekday - The weekday the result must fall on
 * @returns {Date} The shifted date
 * @throws {RangeError} when the result is out of range
 */
function onWeekday(date: Date, days: number, weekday: number): Date {
	const time = date.getTime();
	const result = shiftCalendar(date, 0, days);

	return result.getDay() === weekday ? result : shiftCalendar(new Date(time), 0, days + Math.sign(days) * DAYS_PER_WEEK);
}

/**
 * Returns the previous given weekday STRICTLY before `date` (local time), keeping the time of day like {@link addDays}: on a
 * Monday, `previousWeekday(date, 1)` is the Monday before, 7 days earlier (never `date` itself).
 * @param {DateInput} date - The date to start from
 * @param {WeekdayIndex} weekday - The weekday to find: 0 = Sunday … 6 = Saturday
 * @returns {Date} A new date, 1 to 7 days before `date`
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `weekday` is not a number
 * @throws {RangeError} when `date` is invalid, `weekday` is not an integer between 0 and 6, or the result is out of range
 * @example
 * previousWeekday(new Date(2024, 4, 15, 9), 1); // => new Date(2024, 4, 13, 9) // Wednesday → Monday
 * previousWeekday(new Date(2024, 4, 15), 3); // => new Date(2024, 4, 8)
 */
export function previousWeekday(date: DateInput, weekday: WeekdayIndex): Date {
	assertWeekday('previousWeekday', weekday, 'weekday');

	const result = toValidDate(date);

	return onWeekday(result, -1 - mod(result.getDay() - weekday - 1, DAYS_PER_WEEK), weekday);
}

/**
 * Returns the start and end timestamps of an {@link Interval}, validated.
 * @param {string} name - The parameter name, used in the error messages
 * @param {Interval} interval - The interval
 * @returns {[number, number]} `[start, end]` in milliseconds
 * @throws {TypeError} when `interval` is not an object, or a bound is neither a `Date` nor a number
 * @throws {RangeError} when a bound is invalid or `start` is after `end`
 * @example
 * intervalBounds('a', { start: 1, end: 2 }); // => [1, 2]
 */
function intervalBounds(name: string, interval: Interval): [number, number] {
	if (typeof interval !== 'object' || interval === null) throw new TypeError(`intervalsOverlap: \`${name}\` must be an interval object, got ${describe(interval)}`);

	const start = timeOf(interval.start);
	const end = timeOf(interval.end);

	if (start > end) throw new RangeError(`intervalsOverlap: \`${name}.start\` must not be after \`${name}.end\``);

	return [start, end];
}

/**
 * Checks whether two time intervals overlap (bookings, calendar events…).
 *
 * By default intervals are HALF-OPEN, `[start, end)`: an interval ending exactly when the other one starts does not overlap it, and
 * an empty interval (`start === end`) overlaps nothing — it is the set intersection, so a zero-length interval is not considered
 * to overlap the interval around it (date-fns' `areIntervalsOverlapping` says it does). With `{ inclusive: true }` both intervals are
 * CLOSED, `[start, end]`: touching intervals overlap, and so does a zero-length interval inside or at the edge of the other one.
 * @param {Interval} a - The first interval
 * @param {Interval} b - The second interval
 * @param {IntervalsOverlapOptions} [options={}] - `inclusive`: treat both intervals as closed (default `false`)
 * @returns {boolean} `true` when the intervals share at least one instant
 * @throws {TypeError} when an interval is not an object, or a bound is neither a `Date` nor a number
 * @throws {RangeError} when a bound is invalid or an interval's `start` is after its `end`
 * @example
 * const morning = { start: new Date(2024, 0, 1, 9), end: new Date(2024, 0, 1, 12) };
 * const afternoon = { start: new Date(2024, 0, 1, 12), end: new Date(2024, 0, 1, 17) };
 * intervalsOverlap(morning, afternoon); // => false // they only touch
 * intervalsOverlap(morning, afternoon, { inclusive: true }); // => true
 * intervalsOverlap(morning, { start: new Date(2024, 0, 1, 11), end: new Date(2024, 0, 1, 13) }); // => true
 */
export function intervalsOverlap(a: Interval, b: Interval, options: IntervalsOverlapOptions = {}): boolean {
	const [aStart, aEnd] = intervalBounds('a', a);
	const [bStart, bEnd] = intervalBounds('b', b);

	return options.inclusive === true ? aStart <= bEnd && bStart <= aEnd : Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

/**
 * {@link FORMATTERS}' tokens, by formatter (to recognise the tokens of a compiled pattern in {@link parseDate}). Built on first use: a
 * module-level call would be kept by bundlers even when `parseDate` is not imported.
 */
let tokens: Map<(date: Date) => string, string> | undefined;

/**
 * Returns the token of one of {@link FORMATTERS}' formatters.
 * @param {(date: Date) => string} formatter - The formatter
 * @returns {string} Its token
 */
function tokenOf(formatter: (date: Date) => string): string {
	tokens ??= new Map(
		Object.keys(FORMATTERS).map(function (token: string): [(date: Date) => string, string] {
			return [FORMATTERS[token], token];
		})
	);

	return tokens.get(formatter) as string;
}

/**
 * Parses a date written with a {@link formatDate} pattern (same tokens, same `[literal]` syntax), in LOCAL time: the strict inverse
 * of `formatDate`. The result is returned only when formatting it with `pattern` gives back exactly `value`, so non-canonical or
 * impossible input is rejected instead of being half-parsed or rolled over: `'2023-02-30'`, `'24:00'`, `'5'` for `DD`, `'05'` for
 * `D`, a 12-hour `hh` of `'00'` or `'13'`, trailing text, and a local time skipped by a DST change all give `undefined`. A time
 * repeated when clocks are set back resolves to its first occurrence.
 *
 * Fields missing from the pattern take the values of 2000-01-01 00:00:00.000 (2000 is a leap year, so `'02-29'` parses with
 * `'MM-DD'`). `YY` means 2000-2099. `hh`/`h` without `A`/`a` means AM. Numbers are read greedily: `YYYY` takes 4 digits when a
 * numeric token follows directly (`'YYYYMMDD'`) and every digit otherwise (years after 9999, and a `-` for years before 0), the
 * unpadded tokens (`M`, `D`, `H`, `h`, `m`, `s`) take up to 2 digits, so two of them in a row (`'DM'`) cannot always be told apart.
 * So `parseDate(formatDate(d, pattern), pattern)` equals `d` whenever `pattern` has every field down to the milliseconds (with
 * 4-digit years when they are written next to another number), outside the repeated hour.
 *
 * Parsing takes time linear in the lengths of `value` and `pattern`, so untrusted input cannot stall the event loop.
 * @param {string} value - The text to parse (anything that is not a string gives `undefined`)
 * @param {string} pattern - The {@link formatDate} pattern
 * @returns {Date | undefined} The parsed date, or `undefined` when `value` is not exactly what `formatDate` would output
 * @throws {TypeError} when `pattern` is not a string
 * @example
 * parseDate('2024-01-05 14:07:09.003', 'YYYY-MM-DD HH:mm:ss.SSS'); // => new Date(2024, 0, 5, 14, 7, 9, 3)
 * parseDate('5/1/24 2:07 PM', 'D/M/YY h:mm A'); // => new Date(2024, 0, 5, 14, 7)
 * parseDate('20240229', 'YYYYMMDD'); // => new Date(2024, 1, 29)
 * parseDate('2023-02-29', 'YYYY-MM-DD'); // => undefined // no Feb 29 in 2023
 * parseDate('2024-1-5', 'YYYY-MM-DD'); // => undefined // MM and DD are zero-padded
 */
export function parseDate(value: string, pattern: string): Date | undefined {
	if (typeof pattern !== 'string') throw new TypeError(`parseDate: \`pattern\` must be a string, got ${describe(pattern)}`);
	if (typeof value !== 'string') return undefined;

	const parts = cached(compiledPatterns, pattern, compilePattern);
	// Field values by key: Y (YYYY), y (YY), M, D, H, h, m, s, S, A (1 for PM).
	// A null prototype: a polluted `Object.prototype` must not supply missing fields.
	const fields: Partial<Record<string, number>> = Object.create(null) as Partial<Record<string, number>>;
	let position = 0;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		if (typeof part === 'string') {
			if (!value.startsWith(part, position)) return undefined;
			position += part.length;
			continue;
		}

		const token = tokenOf(part);

		// AM/PM: anything else is rejected when the result is formatted again.
		if (token === 'A' || token === 'a') {
			fields.A = value[position] === 'P' || value[position] === 'p' ? 1 : 0;
			position += 2;
			continue;
		}

		// A formatter is always followed by a literal text, empty when another token follows directly (empty `[]` literals too).
		let after = i + 1;
		while (parts[after] === '') after++;
		const next = parts[after];
		const followedByNumber = typeof next === 'function' && next !== FORMATTERS.A && next !== FORMATTERS.a;
		const maxDigits = token.length === 1 ? 2 : token === 'YYYY' && !followedByNumber ? Infinity : token.length;
		const start = position;

		if (token === 'YYYY' && value[position] === '-') position++;

		const digitsStart = position;

		while (position - digitsStart < maxDigits && value.charCodeAt(position) >= 48 && value.charCodeAt(position) <= 57) position++;
		if (position - digitsStart < token.length) return undefined;

		fields[token === 'YY' ? 'y' : token[0]] = Number(value.slice(start, position));
	}

	const date = new Date(2000, 0, 1, 12);
	const year = fields.Y ?? 2000 + (fields.y ?? 0);
	const hours = fields.H ?? ((fields.h ?? 0) % 12) + (fields.A ?? 0) * 12;

	date.setFullYear(year, (fields.M ?? 1) - 1, fields.D ?? 1);
	// Noon of the first or last representable day can be out of range while the parsed time is not: go through that time then.
	if (Number.isNaN(date.getTime())) {
		date.setTime(new Date(2000, 0, 1, hours, fields.m ?? 0, fields.s ?? 0, fields.S ?? 0).setFullYear(year, (fields.M ?? 1) - 1, fields.D ?? 1));
	}
	date.setHours(hours, fields.m ?? 0, fields.s ?? 0, fields.S ?? 0);

	return isValidDate(date) && formatDate(date, pattern) === value ? date : undefined;
}

/**
 * Returns the day of the year (1-366) of the LOCAL calendar date.
 * @param {DateInput} date - The date
 * @returns {number} 1 for January 1st … 365 (366 in leap years) for December 31st
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when `date` is invalid
 * @example
 * getDayOfYear(new Date(2024, 0, 1)); // => 1
 * getDayOfYear(new Date(2024, 11, 31)); // => 366
 */
export function getDayOfYear(date: DateInput): number {
	const d = toValidDate(date);

	return epochDay(d) - daysFromCivil(d.getFullYear(), 0, 1) + 1;
}

/**
 * Checks whether a date falls on the LOCAL calendar day after `now`'s.
 * @param {DateInput} date - The date to check
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {boolean} `true` when `date` is on the day after `now`'s calendar day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isTomorrow(new Date(2024, 0, 2, 23, 59), new Date(2024, 0, 1, 8)); // => true
 * isTomorrow(new Date(2024, 0, 3), new Date(2024, 0, 1, 23)); // => false
 */
export function isTomorrow(date: DateInput, now: DateInput = new Date()): boolean {
	return diffInDays(date, now) === 1;
}

/**
 * Checks whether a date falls on the LOCAL calendar day before `now`'s.
 * @param {DateInput} date - The date to check
 * @param {DateInput} [now=new Date()] - The reference date
 * @returns {boolean} `true` when `date` is on the day before `now`'s calendar day
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isYesterday(new Date(2023, 11, 31, 0, 1), new Date(2024, 0, 1, 8)); // => true
 */
export function isYesterday(date: DateInput, now: DateInput = new Date()): boolean {
	return diffInDays(date, now) === -1;
}

/**
 * Checks whether two dates fall in the same local week (see {@link startOfWeek}).
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @param {WeekdayIndex} [weekStartsOn=0] - The first day of the week: 0 = Sunday … 6 = Saturday
 * @returns {boolean} `true` when both dates are in the same week
 * @throws {TypeError} when a date argument is neither a `Date` nor a number, or `weekStartsOn` is not a number
 * @throws {RangeError} when a date is invalid or `weekStartsOn` is not an integer between 0 and 6
 * @example
 * isSameWeek(new Date(2024, 4, 12), new Date(2024, 4, 18)); // => true // Sunday and Saturday
 * isSameWeek(new Date(2024, 4, 12), new Date(2024, 4, 18), 1); // => false // weeks starting on Monday
 */
export function isSameWeek(a: DateInput, b: DateInput, weekStartsOn: WeekdayIndex = 0): boolean {
	assertWeekday('isSameWeek', weekStartsOn);

	return weekStartDay(toValidDate(a), weekStartsOn) === weekStartDay(toValidDate(b), weekStartsOn);
}

/**
 * Checks whether two dates fall in the same local calendar quarter (of the same year).
 * @param {DateInput} a - The first date
 * @param {DateInput} b - The second date
 * @returns {boolean} `true` when year and quarter match
 * @throws {TypeError} when a date argument is neither a `Date` nor a number
 * @throws {RangeError} when either date is invalid
 * @example
 * isSameQuarter(new Date(2024, 0, 1), new Date(2024, 2, 31)); // => true
 * isSameQuarter(new Date(2024, 2, 31), new Date(2024, 3, 1)); // => false
 */
export function isSameQuarter(a: DateInput, b: DateInput): boolean {
	const left = toValidDate(a);
	const right = toValidDate(b);

	return left.getFullYear() === right.getFullYear() && Math.floor(left.getMonth() / 3) === Math.floor(right.getMonth() / 3);
}
