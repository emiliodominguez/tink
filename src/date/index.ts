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
 * Asserts that `weekStartsOn` is a valid weekday index (integer 0-6).
 * @param {string} caller - Name of the public function, used in the error message
 * @param {number} weekStartsOn - The value to check
 * @returns {void}
 * @throws {TypeError} when the value is not a number
 * @throws {RangeError} when the value is not an integer between 0 and 6
 */
function assertWeekday(caller: string, weekStartsOn: number): void {
	assertNumber(caller, 'weekStartsOn', weekStartsOn, Number.isInteger(weekStartsOn) && weekStartsOn >= 0 && weekStartsOn <= 6, 'an integer between 0 and 6');
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
	date.setTime(date.getTime() - 1);

	return ensureInRange(date);
}

/**
 * Checks whether a value is a `Date` instance holding a valid time (i.e. not `new Date(NaN)`).
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a valid `Date`
 * @example
 * isValidDate(new Date()); // => true
 * isValidDate(new Date('nope')); // => false
 * isValidDate(Date.now()); // => false // a number, not a Date
 * isValidDate(Object.create(Date.prototype)); // => false // not a real Date
 */
export function isValidDate(value: unknown): value is Date {
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

	const result = toValidDate(date);

	// Re-setting the same wall-clock time would move an instant in a repeated (fall-back) hour to its first occurrence.
	if (amount === 0) return result;

	result.setDate(result.getDate() + amount);

	return ensureInRange(result);
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

	const result = toValidDate(date);

	// Re-setting the same wall-clock time would move an instant in a repeated (fall-back) hour to its first occurrence.
	if (amount === 0) return result;

	const totalMonths = result.getMonth() + amount;
	const year = result.getFullYear() + Math.floor(totalMonths / 12);
	const month = mod(totalMonths, 12);

	result.setFullYear(year, month, Math.min(result.getDate(), daysInMonth(year, month)));

	return ensureInRange(result);
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
	const end = toValidDate(later);
	const start = toValidDate(earlier);

	if (end.getTime() < start.getTime()) return 0 - diffInMonths(start, end);

	const months = calendarMonthDiff(end, start);

	return addMonths(start, months).getTime() > end.getTime() ? months - 1 : months;
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

	return lastInstantOfDay(startOfWeek(date, weekStartsOn), 7);
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

	result.setMonth(11, 31);

	return lastInstantOfDay(result);
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
	const year = yearOrDate instanceof Date ? toValidDate(yearOrDate).getFullYear() : yearOrDate;

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
	if (!INCLUSIVITIES.includes(inclusivity)) throw new RangeError(`isBetween: \`inclusivity\` must be one of ${INCLUSIVITIES.join(', ')}, got ${String(inclusivity)}`);

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

	return localMidnight(year, monthIndex, day);
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

	assertNumber('eachDayOfInterval', 'step', step, Number.isSafeInteger(step) && step >= 1, 'a safe integer >= 1');

	const from = toValidDate(start);
	const to = toValidDate(end);

	if (from.getTime() > to.getTime()) throw new RangeError('eachDayOfInterval: `start` must not be after `end`');

	const total = diffInDays(to, from);
	const result: Date[] = [];

	for (let offset = 0; offset <= total; offset += step) {
		result.push(localMidnight(from.getFullYear(), from.getMonth(), from.getDate() + offset));
	}

	return result;
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

	return addDays(start, offset);
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

	units.forEach(function (unit: unknown): void {
		if (!DURATION_UNITS.includes(unit as DurationUnit))
			throw new RangeError(`formatDuration: \`units\` must only contain ${DURATION_UNITS.join(', ')}, got ${String(unit)}`);
	});

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
