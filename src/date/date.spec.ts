import * as util from 'util';
import * as vm from 'vm';
import * as helpers from '.';

/**
 * The real `process`: Jest gives tests a copy whose `env` does not reach the engine's time zone, so a function created by the
 * outer realm's `Function` constructor fetches it.
 */
const realProcess = new (util.inspect.constructor as FunctionConstructor)('return process')() as { env: Record<string, string | undefined> };

/**
 * Runs `fn` with the engine's local time zone set to `timeZone`, then restores it.
 */
function withTimeZone(timeZone: string, fn: () => void): void {
	const previous = realProcess.env.TZ;
	realProcess.env.TZ = timeZone;
	try {
		fn();
	} finally {
		if (previous === undefined) delete realProcess.env.TZ;
		else realProcess.env.TZ = previous;
	}
}

/**
 * Returns the local calendar/time components of a date, for TZ-agnostic assertions.
 */
function parts(date: Date): number[] {
	return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
}

/**
 * Returns the local calendar components (year, month, day) of a date.
 */
function ymd(date: Date): number[] {
	return [date.getFullYear(), date.getMonth(), date.getDate()];
}

const INVALID = new Date(NaN);

describe('Date helpers', function () {
	describe('isValidDate', function () {
		it('accepts valid Date instances only', function () {
			expect(helpers.isValidDate(new Date())).toBe(true);
			expect(helpers.isValidDate(new Date(0))).toBe(true);
			expect(helpers.isValidDate(INVALID)).toBe(false);
			expect(helpers.isValidDate(new Date('not a date'))).toBe(false);
			expect(helpers.isValidDate(Date.now())).toBe(false);
			expect(helpers.isValidDate('2024-01-01')).toBe(false);
			expect(helpers.isValidDate(null)).toBe(false);
			expect(helpers.isValidDate(undefined)).toBe(false);
			expect(
				helpers.isValidDate({
					getTime: function () {
						return 0;
					}
				})
			).toBe(false);
		});
	});

	describe('input validation', function () {
		const unary: Array<[string, (d: any) => unknown]> = [
			[
				'addDays',
				function (d) {
					return helpers.addDays(d, 1);
				}
			],
			[
				'addWeeks',
				function (d) {
					return helpers.addWeeks(d, 1);
				}
			],
			[
				'addMonths',
				function (d) {
					return helpers.addMonths(d, 1);
				}
			],
			[
				'addYears',
				function (d) {
					return helpers.addYears(d, 1);
				}
			],
			[
				'addHours',
				function (d) {
					return helpers.addHours(d, 1);
				}
			],
			[
				'addMinutes',
				function (d) {
					return helpers.addMinutes(d, 1);
				}
			],
			[
				'addSeconds',
				function (d) {
					return helpers.addSeconds(d, 1);
				}
			],
			[
				'addMilliseconds',
				function (d) {
					return helpers.addMilliseconds(d, 1);
				}
			],
			[
				'diffInDays',
				function (d) {
					return helpers.diffInDays(d, 0);
				}
			],
			[
				'diffInDays (2nd arg)',
				function (d) {
					return helpers.diffInDays(0, d);
				}
			],
			[
				'diffInHours',
				function (d) {
					return helpers.diffInHours(d, 0);
				}
			],
			[
				'diffInMinutes',
				function (d) {
					return helpers.diffInMinutes(0, d);
				}
			],
			[
				'diffInSeconds',
				function (d) {
					return helpers.diffInSeconds(d, 0);
				}
			],
			[
				'diffInMonths',
				function (d) {
					return helpers.diffInMonths(d, 0);
				}
			],
			[
				'diffInMonths (2nd arg)',
				function (d) {
					return helpers.diffInMonths(0, d);
				}
			],
			['startOfDay', helpers.startOfDay],
			['endOfDay', helpers.endOfDay],
			['startOfMonth', helpers.startOfMonth],
			['endOfMonth', helpers.endOfMonth],
			[
				'startOfWeek',
				function (d) {
					return helpers.startOfWeek(d);
				}
			],
			[
				'endOfWeek',
				function (d) {
					return helpers.endOfWeek(d);
				}
			],
			['startOfYear', helpers.startOfYear],
			['endOfYear', helpers.endOfYear],
			[
				'isSameDay',
				function (d) {
					return helpers.isSameDay(d, 0);
				}
			],
			[
				'isSameMonth',
				function (d) {
					return helpers.isSameMonth(0, d);
				}
			],
			[
				'isSameYear',
				function (d) {
					return helpers.isSameYear(d, 0);
				}
			],
			[
				'isLeapYear',
				function (d) {
					return helpers.isLeapYear(d instanceof Date ? d : new Date(d));
				}
			],
			['getDaysInMonth', helpers.getDaysInMonth],
			['isWeekend', helpers.isWeekend],
			[
				'isBefore',
				function (d) {
					return helpers.isBefore(d, 0);
				}
			],
			[
				'isAfter',
				function (d) {
					return helpers.isAfter(0, d);
				}
			],
			[
				'isBetween',
				function (d) {
					return helpers.isBetween(d, 0, 1);
				}
			],
			[
				'isBetween (end)',
				function (d) {
					return helpers.isBetween(0, 0, d);
				}
			],
			[
				'compareAsc',
				function (d) {
					return helpers.compareAsc(d, 0);
				}
			],
			[
				'compareDesc',
				function (d) {
					return helpers.compareDesc(0, d);
				}
			],
			[
				'minDate',
				function (d) {
					return helpers.minDate([0, d]);
				}
			],
			[
				'maxDate',
				function (d) {
					return helpers.maxDate([d, 0]);
				}
			],
			[
				'formatDate',
				function (d) {
					return helpers.formatDate(d, 'YYYY');
				}
			],
			['toISODateString', helpers.toISODateString],
			[
				'getRelativeTime',
				function (d) {
					return helpers.getRelativeTime(d, 0);
				}
			],
			[
				'getRelativeTime (base)',
				function (d) {
					return helpers.getRelativeTime(0, d);
				}
			]
		];

		it.each(unary)('%s throws RangeError("Invalid date") for invalid dates', function (_name, fn) {
			expect(function () {
				fn(INVALID);
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				fn(NaN);
			}).toThrow(RangeError);
			expect(function () {
				fn(Infinity);
			}).toThrow(RangeError);
		});

		it.each(
			unary.filter(function (entry) {
				return entry[0] !== 'isLeapYear';
			})
		)('%s throws TypeError for non-date inputs', function (_name, fn) {
			expect(function () {
				fn('2024-01-01');
			}).toThrow(TypeError);
			expect(function () {
				fn(null);
			}).toThrow(TypeError);
		});

		it('accepts timestamps as well as Date instances', function () {
			const time = new Date(2024, 0, 15, 10).getTime();

			expect(helpers.addDays(time, 1).getDate()).toBe(16);
			expect(helpers.isSameDay(time, new Date(time))).toBe(true);
		});
	});

	describe('addDays / addWeeks', function () {
		it('adds and subtracts calendar days, preserving the time of day', function () {
			expect(parts(helpers.addDays(new Date(2024, 0, 31, 10, 20, 30, 400), 1))).toEqual([2024, 1, 1, 10, 20, 30, 400]);
			expect(parts(helpers.addDays(new Date(2024, 2, 1, 8), -1))).toEqual([2024, 1, 29, 8, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2023, 11, 31), 1))).toEqual([2024, 0, 1, 0, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2024, 4, 10), 0))).toEqual([2024, 4, 10, 0, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2024, 0, 1), 366))).toEqual([2025, 0, 1, 0, 0, 0, 0]);
		});

		it('adds weeks', function () {
			expect(ymd(helpers.addWeeks(new Date(2024, 0, 1), 2))).toEqual([2024, 0, 15]);
			expect(ymd(helpers.addWeeks(new Date(2024, 0, 1), -1))).toEqual([2023, 11, 25]);
		});

		it('rejects non-integer amounts', function () {
			expect(function () {
				helpers.addDays(new Date(), 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addDays(new Date(), NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addDays(new Date(), Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addWeeks(new Date(), 0.5);
			}).toThrow(RangeError);
		});

		it('rejects results outside the Date range', function () {
			expect(function () {
				helpers.addDays(new Date(2024, 0, 1), 1e9);
			}).toThrow('Resulting date is out of range');
		});
	});

	describe('addMonths / addYears', function () {
		it('adds months, clamping to the end of the target month', function () {
			expect(ymd(helpers.addMonths(new Date(2023, 0, 31), 1))).toEqual([2023, 1, 28]);
			expect(ymd(helpers.addMonths(new Date(2024, 0, 31), 1))).toEqual([2024, 1, 29]);
			expect(ymd(helpers.addMonths(new Date(2024, 2, 31), -1))).toEqual([2024, 1, 29]);
			expect(ymd(helpers.addMonths(new Date(2024, 4, 31), 1))).toEqual([2024, 5, 30]);
			expect(ymd(helpers.addMonths(new Date(2024, 0, 15), 0))).toEqual([2024, 0, 15]);
		});

		it('crosses year boundaries in both directions', function () {
			expect(ymd(helpers.addMonths(new Date(2023, 10, 15), 3))).toEqual([2024, 1, 15]);
			expect(ymd(helpers.addMonths(new Date(2024, 1, 15), -3))).toEqual([2023, 10, 15]);
			expect(ymd(helpers.addMonths(new Date(2024, 0, 15), -25))).toEqual([2021, 11, 15]);
			expect(ymd(helpers.addMonths(new Date(2024, 0, 15), 120))).toEqual([2034, 0, 15]);
		});

		it('preserves the time of day', function () {
			expect(parts(helpers.addMonths(new Date(2024, 0, 31, 13, 14, 15, 16), 1))).toEqual([2024, 1, 29, 13, 14, 15, 16]);
		});

		it('handles years 0-99 without remapping them to 1900-1999', function () {
			const date = new Date(2000, 0, 31);

			date.setFullYear(50);

			expect(ymd(helpers.addMonths(date, 1))).toEqual([50, 1, 28]);
		});

		it('adds years, clamping February 29th', function () {
			expect(ymd(helpers.addYears(new Date(2024, 1, 29), 1))).toEqual([2025, 1, 28]);
			expect(ymd(helpers.addYears(new Date(2024, 1, 29), 4))).toEqual([2028, 1, 29]);
			expect(ymd(helpers.addYears(new Date(2024, 5, 1), -10))).toEqual([2014, 5, 1]);
		});

		it('rejects non-integer amounts and out-of-range results', function () {
			expect(function () {
				helpers.addMonths(new Date(), 0.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addYears(new Date(), 0.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addMonths(new Date(2024, 0, 1), 1e10);
			}).toThrow('Resulting date is out of range');
			expect(function () {
				helpers.addYears(new Date(2024, 0, 1), 1e300);
			}).toThrow(RangeError);
		});
	});

	describe('addHours / addMinutes / addSeconds / addMilliseconds', function () {
		it('performs absolute (millisecond based) arithmetic', function () {
			const base = Date.UTC(2024, 0, 1);

			expect(helpers.addHours(base, 2).toISOString()).toBe('2024-01-01T02:00:00.000Z');
			expect(helpers.addHours(base, -1.5).toISOString()).toBe('2023-12-31T22:30:00.000Z');
			expect(helpers.addMinutes(base, 90).toISOString()).toBe('2024-01-01T01:30:00.000Z');
			expect(helpers.addSeconds(base, 1.5).getTime()).toBe(base + 1500);
			expect(helpers.addMilliseconds(base, -250).getTime()).toBe(base - 250);
		});

		it('rejects non-finite amounts and out-of-range results', function () {
			expect(function () {
				helpers.addHours(0, NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addMinutes(0, Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addSeconds(0, -Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addMilliseconds(0, '1' as any);
			}).toThrow(new TypeError('addMilliseconds: `amount` must be a finite number, got string'));
			expect(function () {
				helpers.addMilliseconds(8.64e15, 1);
			}).toThrow('Resulting date is out of range');
		});
	});

	describe('diffInDays', function () {
		it('counts calendar days, ignoring the time of day', function () {
			expect(helpers.diffInDays(new Date(2024, 2, 1), new Date(2024, 1, 1))).toBe(29);
			expect(helpers.diffInDays(new Date(2024, 0, 2, 0, 1), new Date(2024, 0, 1, 23, 59))).toBe(1);
			expect(helpers.diffInDays(new Date(2024, 0, 1, 23, 59), new Date(2024, 0, 1, 0, 0))).toBe(0);
			expect(helpers.diffInDays(new Date(2024, 0, 1), new Date(2024, 0, 3))).toBe(-2);
			expect(helpers.diffInDays(new Date(2025, 0, 1), new Date(2024, 0, 1))).toBe(366);
			expect(Object.is(helpers.diffInDays(new Date(2024, 0, 1, 5), new Date(2024, 0, 1, 6)), 0)).toBe(true);
		});

		it('handles years 0-99', function () {
			const a = new Date(2000, 0, 1);
			const b = new Date(2000, 0, 1);

			a.setFullYear(50, 0, 1);
			b.setFullYear(49, 0, 1);

			expect(helpers.diffInDays(a, b)).toBe(365);
		});
	});

	describe('diffInHours / diffInMinutes / diffInSeconds', function () {
		it('truncates toward zero', function () {
			expect(helpers.diffInHours(5_399_999, 0)).toBe(1);
			expect(helpers.diffInHours(0, 5_399_999)).toBe(-1);
			expect(helpers.diffInMinutes(150_000, 0)).toBe(2);
			expect(helpers.diffInSeconds(0, 2_500)).toBe(-2);
			expect(helpers.diffInSeconds(new Date(1999), new Date(0))).toBe(1);
		});

		it('never returns -0', function () {
			expect(Object.is(helpers.diffInHours(0, 1), 0)).toBe(true);
			expect(Object.is(helpers.diffInMinutes(0, 1), 0)).toBe(true);
			expect(Object.is(helpers.diffInSeconds(0, 1), 0)).toBe(true);
		});
	});

	describe('diffInMonths', function () {
		it('counts complete months', function () {
			expect(helpers.diffInMonths(new Date(2024, 2, 14), new Date(2024, 0, 15))).toBe(1);
			expect(helpers.diffInMonths(new Date(2024, 2, 15), new Date(2024, 0, 15))).toBe(2);
			expect(helpers.diffInMonths(new Date(2024, 0, 20), new Date(2024, 0, 15))).toBe(0);
			expect(helpers.diffInMonths(new Date(2025, 0, 15), new Date(2024, 0, 15))).toBe(12);
			expect(helpers.diffInMonths(new Date(2024, 0, 1), new Date(2023, 11, 31))).toBe(0);
			expect(helpers.diffInMonths(new Date(2024, 0, 15, 8), new Date(2024, 0, 15, 8))).toBe(0);
		});

		it('uses end-of-month clamping (date-fns semantics)', function () {
			expect(helpers.diffInMonths(new Date(2023, 1, 28), new Date(2023, 0, 31))).toBe(1);
			expect(helpers.diffInMonths(new Date(2023, 1, 27), new Date(2023, 0, 31))).toBe(0);
			expect(helpers.diffInMonths(new Date(2023, 2, 31), new Date(2023, 1, 28))).toBe(1);
		});

		it('takes the time of day into account', function () {
			expect(helpers.diffInMonths(new Date(2024, 1, 15, 9), new Date(2024, 0, 15, 10))).toBe(0);
			expect(helpers.diffInMonths(new Date(2024, 1, 15, 10), new Date(2024, 0, 15, 10))).toBe(1);
		});

		it('is negative when later is before earlier, never -0', function () {
			expect(helpers.diffInMonths(new Date(2024, 0, 15), new Date(2024, 2, 15))).toBe(-2);
			expect(helpers.diffInMonths(new Date(2024, 0, 15), new Date(2024, 2, 14))).toBe(-1);
			expect(Object.is(helpers.diffInMonths(new Date(2024, 0, 15), new Date(2024, 0, 20)), 0)).toBe(true);
		});
	});

	describe('startOf / endOf', function () {
		const date = new Date(2024, 4, 15, 13, 45, 30, 500); // Wednesday

		it('startOfDay / endOfDay', function () {
			expect(parts(helpers.startOfDay(date))).toEqual([2024, 4, 15, 0, 0, 0, 0]);
			expect(parts(helpers.endOfDay(date))).toEqual([2024, 4, 15, 23, 59, 59, 999]);
		});

		it('startOfMonth / endOfMonth', function () {
			expect(parts(helpers.startOfMonth(date))).toEqual([2024, 4, 1, 0, 0, 0, 0]);
			expect(parts(helpers.endOfMonth(date))).toEqual([2024, 4, 31, 23, 59, 59, 999]);
			expect(parts(helpers.endOfMonth(new Date(2024, 1, 10)))).toEqual([2024, 1, 29, 23, 59, 59, 999]);
			expect(parts(helpers.endOfMonth(new Date(2023, 1, 10)))).toEqual([2023, 1, 28, 23, 59, 59, 999]);
			expect(parts(helpers.endOfMonth(new Date(2024, 0, 31, 12)))).toEqual([2024, 0, 31, 23, 59, 59, 999]);
		});

		it('startOfWeek / endOfWeek', function () {
			expect(parts(helpers.startOfWeek(date))).toEqual([2024, 4, 12, 0, 0, 0, 0]);
			expect(parts(helpers.startOfWeek(date, 1))).toEqual([2024, 4, 13, 0, 0, 0, 0]);
			expect(parts(helpers.startOfWeek(date, 3))).toEqual([2024, 4, 15, 0, 0, 0, 0]);
			expect(parts(helpers.startOfWeek(date, 4))).toEqual([2024, 4, 9, 0, 0, 0, 0]);
			expect(parts(helpers.endOfWeek(date))).toEqual([2024, 4, 18, 23, 59, 59, 999]);
			expect(parts(helpers.endOfWeek(date, 1))).toEqual([2024, 4, 19, 23, 59, 59, 999]);
			expect(parts(helpers.startOfWeek(new Date(2024, 0, 2), 1))).toEqual([2024, 0, 1, 0, 0, 0, 0]);
			expect(parts(helpers.startOfWeek(new Date(2024, 0, 1)))).toEqual([2023, 11, 31, 0, 0, 0, 0]);
		});

		it('rejects invalid weekStartsOn values', function () {
			expect(function () {
				helpers.startOfWeek(date, 7 as any);
			}).toThrow(RangeError);
			expect(function () {
				helpers.startOfWeek(date, -1 as any);
			}).toThrow(RangeError);
			expect(function () {
				helpers.endOfWeek(date, 1.5 as any);
			}).toThrow(RangeError);
		});

		it('startOfYear / endOfYear', function () {
			expect(parts(helpers.startOfYear(date))).toEqual([2024, 0, 1, 0, 0, 0, 0]);
			expect(parts(helpers.endOfYear(date))).toEqual([2024, 11, 31, 23, 59, 59, 999]);
			expect(parts(helpers.endOfYear(new Date(2024, 1, 29)))).toEqual([2024, 11, 31, 23, 59, 59, 999]);
		});

		it('throws when the end of the period is outside the Date range', function () {
			expect(function () {
				helpers.endOfDay(8.64e15);
			}).toThrow('Resulting date is out of range');
			expect(function () {
				helpers.endOfYear(8.64e15);
			}).toThrow(RangeError);
			expect(helpers.startOfDay(-8.64e15 + 86_400_000 * 2).getTime()).toBeGreaterThanOrEqual(-8.64e15);
		});

		it('does not throw when the local day ends exactly at the Date range limit (regression)', function () {
			// Only where the last representable instant is a local midnight (UTC) does the day before end inside the range;
			// that day's end used to be computed through the following day, which is out of range, and threw.
			const limit = new Date(8.64e15);
			const endsAtLimit = limit.getHours() + limit.getMinutes() + limit.getSeconds() + limit.getMilliseconds() === 0;
			let result: number | string;
			try {
				result = helpers.endOfDay(8.64e15 - 1).getTime();
			} catch (error) {
				result = (error as Error).message;
			}
			expect(result).toBe(endsAtLimit ? 8.64e15 - 1 : 'Resulting date is out of range');
		});

		it('returns new instances and does not mutate the input', function () {
			const input = new Date(2024, 4, 15, 13);
			const before = input.getTime();
			const fns = [
				helpers.startOfDay,
				helpers.endOfDay,
				helpers.startOfMonth,
				helpers.endOfMonth,
				helpers.startOfWeek,
				helpers.endOfWeek,
				helpers.startOfYear,
				helpers.endOfYear
			];

			fns.forEach(function (fn) {
				expect(fn(input)).not.toBe(input);
			});
			expect(helpers.addDays(input, 0)).not.toBe(input);
			expect(helpers.addMonths(input, 0)).not.toBe(input);
			expect(helpers.addMilliseconds(input, 0)).not.toBe(input);
			expect(input.getTime()).toBe(before);
		});
	});

	describe('isSameDay / isSameMonth / isSameYear', function () {
		it('compares local calendar components', function () {
			expect(helpers.isSameDay(new Date(2024, 0, 1, 0, 0), new Date(2024, 0, 1, 23, 59, 59, 999))).toBe(true);
			expect(helpers.isSameDay(new Date(2024, 0, 1), new Date(2024, 0, 2))).toBe(false);
			expect(helpers.isSameDay(new Date(2024, 0, 1), new Date(2024, 1, 1))).toBe(false);
			expect(helpers.isSameDay(new Date(2024, 0, 1), new Date(2023, 0, 1))).toBe(false);
			expect(helpers.isSameMonth(new Date(2024, 0, 1), new Date(2024, 0, 31))).toBe(true);
			expect(helpers.isSameMonth(new Date(2024, 0, 1), new Date(2023, 0, 1))).toBe(false);
			expect(helpers.isSameMonth(new Date(2024, 0, 1), new Date(2024, 1, 1))).toBe(false);
			expect(helpers.isSameYear(new Date(2024, 0, 1), new Date(2024, 11, 31))).toBe(true);
			expect(helpers.isSameYear(new Date(2024, 0, 1), new Date(2023, 11, 31))).toBe(false);
		});
	});

	describe('isLeapYear / daysInMonth / getDaysInMonth', function () {
		it('applies the Gregorian rules', function () {
			expect(helpers.isLeapYear(2024)).toBe(true);
			expect(helpers.isLeapYear(2023)).toBe(false);
			expect(helpers.isLeapYear(1900)).toBe(false);
			expect(helpers.isLeapYear(2000)).toBe(true);
			expect(helpers.isLeapYear(0)).toBe(true);
			expect(helpers.isLeapYear(-4)).toBe(true);
			expect(helpers.isLeapYear(new Date(2000, 5, 1))).toBe(true);
			expect(helpers.isLeapYear(new Date(2100, 5, 1))).toBe(false);
		});

		it('returns the number of days in a month', function () {
			expect(
				[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (m) {
					return helpers.daysInMonth(2023, m);
				})
			).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
			expect(helpers.daysInMonth(2024, 1)).toBe(29);
			expect(helpers.getDaysInMonth(new Date(2024, 1, 10))).toBe(29);
			expect(helpers.getDaysInMonth(new Date(2024, 3, 30))).toBe(30);
		});

		it('rejects invalid arguments', function () {
			expect(function () {
				helpers.isLeapYear(2024.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.isLeapYear(NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.daysInMonth(2024, 12);
			}).toThrow(RangeError);
			expect(function () {
				helpers.daysInMonth(2024, -1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.daysInMonth(2024, 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.daysInMonth(2024.5, 1);
			}).toThrow(RangeError);
		});
	});

	describe('isWeekend', function () {
		it('detects Saturdays and Sundays', function () {
			expect(helpers.isWeekend(new Date(2024, 4, 18))).toBe(true); // Sat
			expect(helpers.isWeekend(new Date(2024, 4, 19))).toBe(true); // Sun
			expect(helpers.isWeekend(new Date(2024, 4, 20))).toBe(false); // Mon
			expect(helpers.isWeekend(new Date(2024, 4, 17))).toBe(false); // Fri
		});
	});

	describe('isBefore / isAfter / isBetween', function () {
		const a = new Date(2024, 0, 1);
		const b = new Date(2024, 0, 2);
		const c = new Date(2024, 0, 3);

		it('compares strictly', function () {
			expect(helpers.isBefore(a, b)).toBe(true);
			expect(helpers.isBefore(b, a)).toBe(false);
			expect(helpers.isBefore(a, a.getTime())).toBe(false);
			expect(helpers.isAfter(b, a)).toBe(true);
			expect(helpers.isAfter(a, b)).toBe(false);
			expect(helpers.isAfter(a, new Date(a))).toBe(false);
		});

		it('checks ranges with every inclusivity', function () {
			expect(helpers.isBetween(b, a, c)).toBe(true);
			expect(helpers.isBetween(a, a, c)).toBe(true);
			expect(helpers.isBetween(c, a, c)).toBe(true);
			expect(helpers.isBetween(a, a, c, '()')).toBe(false);
			expect(helpers.isBetween(c, a, c, '()')).toBe(false);
			expect(helpers.isBetween(b, a, c, '()')).toBe(true);
			expect(helpers.isBetween(a, a, c, '[)')).toBe(true);
			expect(helpers.isBetween(c, a, c, '[)')).toBe(false);
			expect(helpers.isBetween(a, a, c, '(]')).toBe(false);
			expect(helpers.isBetween(c, a, c, '(]')).toBe(true);
			expect(helpers.isBetween(a, b, c)).toBe(false);
			expect(helpers.isBetween(new Date(2024, 0, 4), a, c)).toBe(false);
			expect(helpers.isBetween(a, a, a)).toBe(true);
			expect(helpers.isBetween(a, a, a, '[)')).toBe(false);
		});

		it('rejects reversed ranges and unknown inclusivity', function () {
			expect(function () {
				helpers.isBetween(b, c, a);
			}).toThrow(new RangeError('isBetween: `start` must not be after `end`'));
			expect(function () {
				helpers.isBetween(b, a, c, '[[' as any);
			}).toThrow(RangeError);
		});
	});

	describe('compareAsc / compareDesc / minDate / maxDate', function () {
		const dates = [new Date(2024, 1, 1), new Date(2022, 5, 1), new Date(2023, 1, 1), new Date(2022, 5, 1)];

		it('sorts ascending and descending', function () {
			expect(dates.slice().sort(helpers.compareAsc).map(helpers.toISODateString)).toEqual(['2022-06-01', '2022-06-01', '2023-02-01', '2024-02-01']);
			expect(dates.slice().sort(helpers.compareDesc).map(helpers.toISODateString)).toEqual(['2024-02-01', '2023-02-01', '2022-06-01', '2022-06-01']);
			expect(helpers.compareAsc(1, 2)).toBe(-1);
			expect(helpers.compareAsc(2, 1)).toBe(1);
			expect(helpers.compareAsc(2, 2)).toBe(0);
			expect(helpers.compareDesc(1, 2)).toBe(1);
			expect(helpers.compareDesc(2, 2)).toBe(0);
		});

		it('finds the earliest / latest date as a new instance', function () {
			const earliest = helpers.minDate(dates);
			const latest = helpers.maxDate(new Set(dates));

			expect(earliest?.getTime()).toBe(dates[1].getTime());
			expect(earliest).not.toBe(dates[1]);
			expect(latest?.getTime()).toBe(dates[0].getTime());
			expect(latest).not.toBe(dates[0]);
			expect(helpers.minDate([5, new Date(3), 4])?.getTime()).toBe(3);
			expect(helpers.maxDate([5, new Date(3), 4])?.getTime()).toBe(5);
		});

		it('returns undefined for empty input', function () {
			expect(helpers.minDate([])).toBeUndefined();
			expect(helpers.maxDate(new Set<Date>())).toBeUndefined();
		});
	});

	describe('formatDate', function () {
		const date = new Date(2024, 0, 5, 14, 7, 9, 3);

		it('formats every token', function () {
			expect(helpers.formatDate(date, 'YYYY-MM-DD HH:mm:ss.SSS')).toBe('2024-01-05 14:07:09.003');
			expect(helpers.formatDate(date, 'YY M D H m s')).toBe('24 1 5 14 7 9');
			expect(helpers.formatDate(date, 'hh:mm A')).toBe('02:07 PM');
			expect(helpers.formatDate(date, 'h a')).toBe('2 pm');
			expect(helpers.formatDate(new Date(2024, 11, 25, 0, 5), 'h:mm A, hh a, DD/MM')).toBe('12:05 AM, 12 am, 25/12');
			expect(helpers.formatDate(new Date(2024, 11, 25, 12, 0), 'h A HH')).toBe('12 PM 12');
			expect(helpers.formatDate(new Date(2024, 11, 25, 12, 0), 'a A')).toBe('pm PM');
			expect(helpers.formatDate(new Date(2024, 11, 25, 11, 59), 'a A')).toBe('am AM');
			expect(helpers.formatDate(new Date(2024, 11, 25, 23, 59, 59, 999), 'H h a SSS')).toBe('23 11 pm 999');
		});

		it('prefers the longest token', function () {
			expect(helpers.formatDate(date, 'YYYYY')).toBe('2024Y');
			expect(helpers.formatDate(date, 'MMM')).toBe('011');
			expect(helpers.formatDate(date, 'SSSS')).toBe('003S');
		});

		it('outputs bracketed text literally', function () {
			expect(helpers.formatDate(date, '[YYYY] YYYY')).toBe('YYYY 2024');
			expect(helpers.formatDate(date, '[Today is] dddd')).toBe('Today is dddd');
			expect(helpers.formatDate(date, "D/M/YY h:mm A [o'clock]")).toBe("5/1/24 2:07 PM o'clock");
			expect(helpers.formatDate(date, '[día] D [🎉]')).toBe('día 5 🎉');
			expect(helpers.formatDate(date, '[]')).toBe('');
			expect(helpers.formatDate(date, '[YYYY')).toBe('[2024');
			expect(helpers.formatDate(date, '')).toBe('');
		});

		it('replaces bare letters that are tokens', function () {
			expect(helpers.formatDate(date, 'Date: D')).toBe('5pmte: 5');
		});

		it('formats correctly when the same pattern is reused and after many distinct patterns', function () {
			const pattern = 'YYYY-MM-DD [at] HH:mm';
			expect(helpers.formatDate(date, pattern)).toBe('2024-01-05 at 14:07');
			expect(helpers.formatDate(new Date(1999, 11, 31, 23, 59), pattern)).toBe('1999-12-31 at 23:59');
			for (let i = 0; i < 150; i++) {
				expect(helpers.formatDate(date, `[#${i}] D/M`)).toBe(`#${i} 5/1`);
			}
			expect(helpers.formatDate(date, pattern)).toBe('2024-01-05 at 14:07');
		});

		it('pads small and negative years', function () {
			const small = new Date(2000, 0, 1);
			const negative = new Date(2000, 0, 1);

			small.setFullYear(5);
			negative.setFullYear(-44);

			expect(helpers.formatDate(small, 'YYYY YY')).toBe('0005 05');
			expect(helpers.formatDate(negative, 'YYYY YY')).toBe('-0044 44');
		});
	});

	describe('toISODateString / parseISODate', function () {
		it('formats the LOCAL calendar date', function () {
			expect(helpers.toISODateString(new Date(2024, 0, 5, 23, 30))).toBe('2024-01-05');
			expect(helpers.toISODateString(new Date(2024, 11, 31, 0, 0))).toBe('2024-12-31');
		});

		it('parses valid dates at local midnight', function () {
			expect(parts(helpers.parseISODate('2024-02-29') as Date)).toEqual([2024, 1, 29, 0, 0, 0, 0]);
			expect(parts(helpers.parseISODate('1999-12-31') as Date)).toEqual([1999, 11, 31, 0, 0, 0, 0]);
			expect(parts(helpers.parseISODate('0050-06-15') as Date)).toEqual([50, 5, 15, 0, 0, 0, 0]);
		});

		it('rejects malformed or impossible dates', function () {
			['2023-02-29', '2023-02-30', '2023-04-31', '2023-13-01', '2023-00-10', '2023-01-00', '2023-1-01', ' 2023-01-01', '2023-01-01T00:00', '20230101', ''].forEach(
				function (value) {
					expect(helpers.parseISODate(value)).toBeUndefined();
				}
			);
			expect(helpers.parseISODate(20230101 as any)).toBeUndefined();
			expect(helpers.parseISODate(undefined as any)).toBeUndefined();
			// Non-strings are rejected, even when their string form is a valid date.
			expect(
				helpers.parseISODate({
					toString: function () {
						return '2024-01-01';
					}
				} as any)
			).toBeUndefined();
		});

		it('round-trips', function () {
			expect(helpers.toISODateString(helpers.parseISODate('2024-07-04') as Date)).toBe('2024-07-04');
		});
	});

	describe('getRelativeTime', function () {
		const base = new Date(2024, 0, 10, 12);

		it('picks a sensible unit', function () {
			expect(helpers.getRelativeTime(base, base)).toBe('now');
			expect(helpers.getRelativeTime(helpers.addSeconds(base, -30), base)).toBe('30 seconds ago');
			expect(helpers.getRelativeTime(helpers.addMinutes(base, 5), base)).toBe('in 5 minutes');
			expect(helpers.getRelativeTime(new Date(2024, 0, 10, 9), base)).toBe('3 hours ago');
			expect(helpers.getRelativeTime(new Date(2024, 0, 11, 11), base)).toBe('in 23 hours');
			expect(helpers.getRelativeTime(new Date(2024, 0, 11, 12), base)).toBe('tomorrow');
			expect(helpers.getRelativeTime(new Date(2024, 0, 9, 8), base)).toBe('yesterday');
			expect(helpers.getRelativeTime(new Date(2024, 0, 13, 12), base)).toBe('in 3 days');
			expect(helpers.getRelativeTime(new Date(2024, 0, 24, 12), base)).toBe('in 2 weeks');
			expect(helpers.getRelativeTime(new Date(2023, 11, 20, 12), base)).toBe('3 weeks ago');
			expect(helpers.getRelativeTime(new Date(2024, 3, 10, 12), base)).toBe('in 3 months');
			expect(helpers.getRelativeTime(new Date(2023, 6, 1), base)).toBe('6 months ago');
			expect(helpers.getRelativeTime(new Date(2022, 0, 1), base)).toBe('2 years ago');
			expect(helpers.getRelativeTime(new Date(2025, 0, 10, 12), base)).toBe('next year');
		});

		it('switches unit exactly at one minute, one hour and seven days', function () {
			expect(helpers.getRelativeTime(helpers.addSeconds(base, 59), base)).toBe('in 59 seconds');
			expect(helpers.getRelativeTime(helpers.addSeconds(base, 60), base)).toBe('in 1 minute');
			expect(helpers.getRelativeTime(helpers.addMinutes(base, 59), base)).toBe('in 59 minutes');
			expect(helpers.getRelativeTime(helpers.addMinutes(base, -60), base)).toBe('1 hour ago');
			expect(helpers.getRelativeTime(new Date(2024, 0, 16, 12), base)).toBe('in 6 days');
			expect(helpers.getRelativeTime(new Date(2024, 0, 17, 12), base)).toBe('next week');
		});

		it('accepts a locale', function () {
			expect(helpers.getRelativeTime(new Date(2024, 0, 13, 12), base, 'es')).toBe('dentro de 3 días');
		});

		it('keeps each locale distinct when many locales are used', function () {
			const tomorrow = new Date(2024, 0, 11, 12);
			for (let i = 0; i < 100; i++) {
				expect(helpers.getRelativeTime(tomorrow, base, `en-x-p${i}`)).toBe('tomorrow');
				expect(helpers.getRelativeTime(tomorrow, base, i % 2 === 0 ? 'es' : 'fr')).toBe(i % 2 === 0 ? 'mañana' : 'demain');
			}
			expect(function () {
				helpers.getRelativeTime(tomorrow, base, 'not a locale!');
			}).toThrow(RangeError);
		});

		it('defaults the base date to now', function () {
			expect(helpers.getRelativeTime(Date.now() + 3 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('in 3 hours');
		});

		it('uses hours for a 24h+ span within one long (DST fall-back) day', function () {
			// 23.5 hours in most zones; 24.5 hours where 2023-11-05 lasts 25 hours (e.g. America/New_York).
			expect(helpers.getRelativeTime(new Date(2023, 10, 5, 23, 30), new Date(2023, 10, 5, 0, 0))).toMatch(/^in 2[34] hours$/);
		});
	});

	describe('DST transitions (assertions hold in every time zone)', function () {
		it('addDays keeps the wall-clock time across the New York spring-forward (2023-03-12)', function () {
			expect(parts(helpers.addDays(new Date(2023, 2, 11, 12), 1))).toEqual([2023, 2, 12, 12, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2023, 2, 11, 12), 2))).toEqual([2023, 2, 13, 12, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2023, 2, 13, 0, 30), -1))).toEqual(parts(new Date(2023, 2, 12, 0, 30))); // 01:30 where midnight was skipped (Havana)
			expect(helpers.diffInDays(new Date(2023, 2, 13), new Date(2023, 2, 12))).toBe(1);
			expect(helpers.diffInDays(new Date(2023, 2, 12, 23, 59), new Date(2023, 2, 11, 0, 0))).toBe(1);
		});

		it('a non-existent wall-clock time still lands on the right calendar day', function () {
			const result = helpers.addDays(new Date(2023, 2, 11, 2, 30), 1);

			expect(ymd(result)).toEqual([2023, 2, 12]);
			expect([2, 3]).toContain(result.getHours());
			expect(result.getMinutes()).toBe(30);
		});

		it('addDays keeps the wall-clock time across the New York fall-back (2023-11-05)', function () {
			expect(parts(helpers.addDays(new Date(2023, 10, 4, 12), 1))).toEqual([2023, 10, 5, 12, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2023, 10, 5, 23), 1))).toEqual([2023, 10, 6, 23, 0, 0, 0]);
			expect(parts(helpers.addDays(new Date(2023, 10, 6, 0, 0), -1))).toEqual([2023, 10, 5, 0, 0, 0, 0]);
			expect(helpers.diffInDays(new Date(2023, 10, 6), new Date(2023, 10, 5))).toBe(1);
			expect(helpers.diffInDays(new Date(2023, 10, 5, 23, 59), new Date(2023, 10, 5, 0, 0))).toBe(0);
		});

		it('start/end of day around the New York and Lord Howe transitions', function () {
			[new Date(2023, 2, 12, 12), new Date(2023, 10, 5, 12), new Date(2023, 3, 2, 12), new Date(2023, 9, 1, 12)].forEach(function (date) {
				expect(parts(helpers.startOfDay(date))).toEqual(parts(new Date(date.getFullYear(), date.getMonth(), date.getDate())));
				expect(parts(helpers.endOfDay(date))).toEqual([...ymd(date), 23, 59, 59, 999]);
			});
		});

		it('every day of 2023 is exactly one calendar day after the previous one', function () {
			let day = new Date(2023, 0, 1, 12);

			for (let i = 1; i <= 365; i++) {
				const next = helpers.addDays(day, 1);

				expect(helpers.diffInDays(next, day)).toBe(1);
				expect(next.getHours()).toBe(12);
				expect(helpers.diffInDays(next, new Date(2023, 0, 1))).toBe(i);
				day = next;
			}

			expect(ymd(day)).toEqual([2024, 0, 1]);
		});

		it('addMonths and startOfWeek across transitions', function () {
			expect(parts(helpers.addMonths(new Date(2023, 1, 12, 12), 1))).toEqual([2023, 2, 12, 12, 0, 0, 0]);
			expect(parts(helpers.addMonths(new Date(2023, 9, 5, 1, 30), 1))).toEqual([2023, 10, 5, 1, 30, 0, 0]);
			expect(parts(helpers.startOfWeek(new Date(2023, 2, 15, 12)))).toEqual(parts(new Date(2023, 2, 12)));
			expect(parts(helpers.endOfWeek(new Date(2023, 10, 1, 12), 1))).toEqual([2023, 10, 5, 23, 59, 59, 999]);
		});
	});

	describe('regressions (round 2)', function () {
		// Instants whose local wall-clock time occurs twice in at least one of the tested zones (the SECOND occurrence):
		// New York 2024-11-03 01:30 EST, Lord Howe 2024-04-07 01:45 (+10:30), Sao Paulo 2018-02-17 23:30 (-03).
		const repeatedHourInstants = [new Date('2024-11-03T06:30:00Z'), new Date('2024-04-06T15:15:00Z'), new Date('2018-02-18T02:30:00Z')];

		it('adding zero days/weeks/months/years returns the very same instant, even inside a repeated (fall-back) hour', function () {
			repeatedHourInstants.forEach(function (date) {
				expect(helpers.addDays(date, 0).getTime()).toBe(date.getTime());
				expect(helpers.addWeeks(date, 0).getTime()).toBe(date.getTime());
				expect(helpers.addMonths(date, 0).getTime()).toBe(date.getTime());
				expect(helpers.addYears(date, 0).getTime()).toBe(date.getTime());
			});
		});

		it('startOfDay/Week/Month/Year throw instead of returning an Invalid Date at the edge of the Date range', function () {
			const min = -8.64e15;

			[helpers.startOfMonth, helpers.startOfYear, helpers.startOfWeek].forEach(function (fn) {
				expect(function () {
					fn(min);
				}).toThrow(RangeError);
			});

			// Local midnight of the earliest representable instant only exists in zones east of UTC (or in UTC itself).
			let result: Date | undefined;

			try {
				result = helpers.startOfDay(min);
			} catch (error) {
				expect(error).toBeInstanceOf(RangeError);
			}

			if (result !== undefined) expect(helpers.isValidDate(result)).toBe(true);
		});

		it('diffInDays is finite at the edges of the Date range (it used to return NaN west of UTC)', function () {
			const days = helpers.diffInDays(-8.64e15, 0);

			expect(Number.isInteger(days)).toBe(true);
			expect(Math.abs(days + 100_000_000)).toBeLessThanOrEqual(1);
			// The exact span depends on the time zone (see 'diffInDays spans the whole Date range in any time zone').
			expect(Math.abs(helpers.diffInDays(8.64e15, -8.64e15) - 200_000_000)).toBeLessThanOrEqual(1);
		});

		it('accepts Dates created in another realm (vm context / iframe)', function () {
			const foreign = vm.runInNewContext('new Date(2024, 0, 15, 10)');

			expect(foreign instanceof Date).toBe(false);
			expect(helpers.isValidDate(foreign)).toBe(true);
			expect(helpers.isValidDate(vm.runInNewContext('new Date(NaN)'))).toBe(false);
			expect(helpers.addDays(foreign, 1).getTime()).toBe(helpers.addDays(new Date(foreign.getTime()), 1).getTime());
			expect(helpers.formatDate(foreign, 'YYYY')).toBe(String(new Date(foreign.getTime()).getFullYear()));
		});

		it('isValidDate returns false (instead of throwing) for objects that merely inherit from Date.prototype', function () {
			const fake = Object.create(Date.prototype);

			expect(helpers.isValidDate(fake)).toBe(false);
			expect(function () {
				helpers.addDays(fake, 1);
			}).toThrow(TypeError);
		});
	});

	describe('round 2 additions: input validation', function () {
		const newUnary: Array<[string, (d: any) => unknown]> = [
			[
				'eachDayOfInterval',
				function (d) {
					return helpers.eachDayOfInterval(d, 0);
				}
			],
			[
				'eachDayOfInterval (end)',
				function (d) {
					return helpers.eachDayOfInterval(0, d);
				}
			],
			['getISOWeek', helpers.getISOWeek],
			['getISOWeekYear', helpers.getISOWeekYear],
			['getQuarter', helpers.getQuarter],
			['startOfQuarter', helpers.startOfQuarter],
			['endOfQuarter', helpers.endOfQuarter],
			[
				'getAge',
				function (d) {
					return helpers.getAge(d, 0);
				}
			],
			[
				'getAge (now)',
				function (d) {
					return helpers.getAge(0, d);
				}
			],
			[
				'addBusinessDays',
				function (d) {
					return helpers.addBusinessDays(d, 1);
				}
			],
			[
				'diffInBusinessDays',
				function (d) {
					return helpers.diffInBusinessDays(d, 0);
				}
			],
			[
				'diffInBusinessDays (2nd arg)',
				function (d) {
					return helpers.diffInBusinessDays(0, d);
				}
			],
			[
				'isToday',
				function (d) {
					return helpers.isToday(d, 0);
				}
			],
			[
				'isPast',
				function (d) {
					return helpers.isPast(0, d);
				}
			],
			[
				'isFuture',
				function (d) {
					return helpers.isFuture(d, 0);
				}
			],
			[
				'clampDate',
				function (d) {
					return helpers.clampDate(d, 0, 1);
				}
			],
			[
				'clampDate (min)',
				function (d) {
					return helpers.clampDate(0, d, 1);
				}
			],
			[
				'clampDate (max)',
				function (d) {
					return helpers.clampDate(0, 0, d);
				}
			]
		];

		it.each(newUnary)('%s throws RangeError for invalid dates and TypeError for non-dates', function (_name, fn) {
			expect(function () {
				fn(INVALID);
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				fn(NaN);
			}).toThrow(RangeError);
			expect(function () {
				fn('2024-01-01');
			}).toThrow(TypeError);
			expect(function () {
				fn(null);
			}).toThrow(TypeError);
		});
	});

	describe('eachDayOfInterval', function () {
		it('returns every local midnight between the two calendar days, inclusive', function () {
			const days = helpers.eachDayOfInterval(new Date(2024, 0, 30, 18), new Date(2024, 1, 2, 9));

			expect(days.map(parts)).toEqual([
				[2024, 0, 30, 0, 0, 0, 0],
				[2024, 0, 31, 0, 0, 0, 0],
				[2024, 1, 1, 0, 0, 0, 0],
				[2024, 1, 2, 0, 0, 0, 0]
			]);
		});

		it('supports a step', function () {
			expect(helpers.eachDayOfInterval(new Date(2024, 0, 1), new Date(2024, 0, 10), { step: 3 }).map(ymd)).toEqual([
				[2024, 0, 1],
				[2024, 0, 4],
				[2024, 0, 7],
				[2024, 0, 10]
			]);
			expect(helpers.eachDayOfInterval(new Date(2024, 0, 1), new Date(2024, 0, 2), { step: 5 }).map(ymd)).toEqual([[2024, 0, 1]]);
		});

		it('returns a single day when start and end are on the same day', function () {
			expect(helpers.eachDayOfInterval(new Date(2024, 4, 1, 1), new Date(2024, 4, 1, 23)).map(parts)).toEqual([[2024, 4, 1, 0, 0, 0, 0]]);
		});

		it('crosses DST transitions and leap days correctly', function () {
			const march = helpers.eachDayOfInterval(new Date(2023, 2, 1), new Date(2023, 2, 31));

			expect(march).toHaveLength(31);
			march.forEach(function (day, index) {
				expect(ymd(day)).toEqual([2023, 2, index + 1]);
				expect(day.getTime()).toBe(helpers.startOfDay(day).getTime());
			});
			expect(helpers.eachDayOfInterval(new Date(2024, 1, 27), new Date(2024, 2, 1)).map(ymd)).toEqual([
				[2024, 1, 27],
				[2024, 1, 28],
				[2024, 1, 29],
				[2024, 2, 1]
			]);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.eachDayOfInterval(new Date(2024, 0, 2), new Date(2024, 0, 1));
			}).toThrow(new RangeError('eachDayOfInterval: `start` must not be after `end`'));
			expect(function () {
				helpers.eachDayOfInterval(new Date(2024, 0, 1, 12), new Date(2024, 0, 1, 11));
			}).toThrow(RangeError);
			[0, -1, 1.5, NaN, Infinity].forEach(function (step) {
				expect(function () {
					helpers.eachDayOfInterval(0, 0, { step });
				}).toThrow(RangeError);
			});
		});
	});

	describe('getISOWeek / getISOWeekYear', function () {
		// [year, monthIndex, day, isoYear, isoWeek] - examples from ISO 8601 / Wikipedia.
		const table: Array<[number, number, number, number, number]> = [
			[2005, 0, 1, 2004, 53],
			[2005, 0, 2, 2004, 53],
			[2005, 11, 31, 2005, 52],
			[2006, 0, 1, 2005, 52],
			[2006, 0, 2, 2006, 1],
			[2007, 0, 1, 2007, 1],
			[2007, 11, 30, 2007, 52],
			[2007, 11, 31, 2008, 1],
			[2008, 0, 1, 2008, 1],
			[2008, 11, 28, 2008, 52],
			[2008, 11, 29, 2009, 1],
			[2009, 11, 31, 2009, 53],
			[2010, 0, 3, 2009, 53],
			[2010, 0, 4, 2010, 1],
			[2024, 0, 1, 2024, 1],
			[2024, 11, 30, 2025, 1],
			[2021, 0, 3, 2020, 53],
			[2026, 9, 14, 2026, 42]
		];

		it.each(table)('%i-%i-%i is in ISO week %i-W%i', function (year, month, day, isoYear, isoWeek) {
			const date = new Date(year, month, day, 23, 59);

			expect(helpers.getISOWeek(date)).toBe(isoWeek);
			expect(helpers.getISOWeekYear(date)).toBe(isoYear);
			expect(helpers.getISOWeek(helpers.startOfDay(date))).toBe(isoWeek);
		});

		it('works far from the epoch', function () {
			const ancient = new Date(0);

			ancient.setFullYear(1, 0, 1);
			expect(helpers.getISOWeek(ancient)).toBe(1);
			expect(helpers.getISOWeekYear(ancient)).toBe(1);
			expect(helpers.getISOWeek(8.64e15 - 86_400_000)).toBeGreaterThanOrEqual(36);
		});
	});

	describe('getQuarter / startOfQuarter / endOfQuarter', function () {
		it('maps every month to its quarter and bounds', function () {
			for (let month = 0; month < 12; month++) {
				const date = new Date(2024, month, 15, 13, 45);
				const first = month - (month % 3);

				expect(helpers.getQuarter(date)).toBe(Math.floor(month / 3) + 1);
				expect(parts(helpers.startOfQuarter(date))).toEqual([2024, first, 1, 0, 0, 0, 0]);
				expect(parts(helpers.endOfQuarter(date))).toEqual([2024, first + 2, helpers.daysInMonth(2024, first + 2), 23, 59, 59, 999]);
			}
		});

		it('handles years 0-99 without remapping them to 19xx', function () {
			const date = new Date(0);

			date.setFullYear(42, 4, 5);
			expect(helpers.startOfQuarter(date).getFullYear()).toBe(42);
			expect(helpers.endOfQuarter(date).getFullYear()).toBe(42);
		});

		it('throws outside the Date range', function () {
			expect(function () {
				helpers.startOfQuarter(-8.64e15);
			}).toThrow(RangeError);
			expect(function () {
				helpers.endOfQuarter(8.64e15);
			}).toThrow(RangeError);
		});
	});

	describe('getAge', function () {
		it('counts completed years by calendar day', function () {
			expect(helpers.getAge(new Date(1990, 5, 15), new Date(2024, 5, 14))).toBe(33);
			expect(helpers.getAge(new Date(1990, 5, 15, 23), new Date(2024, 5, 15, 0))).toBe(34);
			expect(helpers.getAge(new Date(1990, 5, 15), new Date(2024, 6, 1))).toBe(34);
			expect(helpers.getAge(new Date(1990, 5, 15), new Date(2024, 4, 30))).toBe(33);
			expect(helpers.getAge(new Date(2024, 0, 1, 20), new Date(2024, 0, 1, 8))).toBe(0);
			expect(helpers.getAge(new Date(2023, 11, 31), new Date(2024, 0, 1))).toBe(0);
		});

		it('treats Feb 28 as the birthday of Feb 29 babies in non-leap years', function () {
			const leapling = new Date(2000, 1, 29);

			expect(helpers.getAge(leapling, new Date(2001, 1, 27))).toBe(0);
			expect(helpers.getAge(leapling, new Date(2001, 1, 28))).toBe(1);
			expect(helpers.getAge(leapling, new Date(2004, 1, 28))).toBe(3);
			expect(helpers.getAge(leapling, new Date(2004, 1, 29))).toBe(4);
		});

		it('defaults now to the current date', function () {
			expect(helpers.getAge(new Date(1990, 0, 1))).toBeGreaterThanOrEqual(36);
		});

		it('rejects a birth date after now', function () {
			expect(function () {
				helpers.getAge(new Date(2024, 0, 2), new Date(2024, 0, 1, 23));
			}).toThrow(new RangeError('getAge: `birthDate` must not be after `now`'));
		});
	});

	describe('addBusinessDays / diffInBusinessDays', function () {
		// 2024-05-13 is a Monday.
		const monday = new Date(2024, 4, 13, 9, 30);

		it('skips weekends in both directions, preserving the time of day', function () {
			expect(parts(helpers.addBusinessDays(monday, 4))).toEqual([2024, 4, 17, 9, 30, 0, 0]);
			expect(parts(helpers.addBusinessDays(monday, 5))).toEqual([2024, 4, 20, 9, 30, 0, 0]);
			expect(parts(helpers.addBusinessDays(new Date(2024, 4, 17, 9), 1))).toEqual([2024, 4, 20, 9, 0, 0, 0]);
			expect(ymd(helpers.addBusinessDays(monday, -1))).toEqual([2024, 4, 10]);
			expect(ymd(helpers.addBusinessDays(monday, -5))).toEqual([2024, 4, 6]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 15), 7))).toEqual([2024, 4, 24]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 15), -8))).toEqual([2024, 4, 3]);
			expect(ymd(helpers.addBusinessDays(monday, 260))).toEqual([2025, 4, 12]);
		});

		it('counts the step off a Saturday as the first business day, also for whole weeks', function () {
			const saturday = new Date(2024, 4, 18, 9);
			expect(parts(helpers.addBusinessDays(saturday, 5))).toEqual([2024, 4, 24, 9, 0, 0, 0]);
			expect(parts(helpers.addBusinessDays(saturday, -5))).toEqual([2024, 4, 13, 9, 0, 0, 0]);
			expect(ymd(helpers.addBusinessDays(saturday, 10))).toEqual([2024, 4, 31]);
		});

		it('from a weekend, the nearest weekday in the direction of travel is the first step', function () {
			const saturday = new Date(2024, 4, 18, 8);
			const sunday = new Date(2024, 4, 19, 8);

			expect(ymd(helpers.addBusinessDays(saturday, 1))).toEqual([2024, 4, 20]);
			expect(ymd(helpers.addBusinessDays(sunday, 1))).toEqual([2024, 4, 20]);
			expect(ymd(helpers.addBusinessDays(saturday, -1))).toEqual([2024, 4, 17]);
			expect(ymd(helpers.addBusinessDays(sunday, -1))).toEqual([2024, 4, 17]);
			expect(ymd(helpers.addBusinessDays(saturday, 6))).toEqual([2024, 4, 27]);
			expect(ymd(helpers.addBusinessDays(sunday, -6))).toEqual([2024, 4, 10]);
			expect(parts(helpers.addBusinessDays(saturday, 0))).toEqual(parts(saturday));
		});

		it('jumps straight to the target day, so passing a DST gap does not shift the time of day', function () {
			// Walking day by day would cross the US spring-forward Sunday at 02:00 (which does not exist) and drift to 03:00.
			const result = helpers.addBusinessDays(new Date(2096, 11, 22, 2), 56);

			expect(parts(result)).toEqual([2097, 2, 11, 2, 0, 0, 0]);
		});

		it('returns a new instance and validates the amount', function () {
			const result = helpers.addBusinessDays(monday, 0);

			expect(result).not.toBe(monday);
			expect(result.getTime()).toBe(monday.getTime());
			expect(function () {
				helpers.addBusinessDays(monday, 1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.addBusinessDays(monday, 1e15);
			}).toThrow('Resulting date is out of range');
		});

		it('diffInBusinessDays counts the weekdays in (earlier, later]', function () {
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 20), new Date(2024, 4, 17))).toBe(1);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 17), new Date(2024, 4, 20))).toBe(-1);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 31), new Date(2024, 4, 1))).toBe(22);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 19), new Date(2024, 4, 18))).toBe(0);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 20), new Date(2024, 4, 18))).toBe(1);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 13, 23), new Date(2024, 4, 13, 1))).toBe(0);
			expect(helpers.diffInBusinessDays(new Date(2025, 4, 12), monday)).toBe(260);
			expect(Object.is(helpers.diffInBusinessDays(monday, monday), 0)).toBe(true);
		});
	});

	describe('isToday / isPast / isFuture', function () {
		it('compare against an explicit now', function () {
			const now = new Date(2024, 0, 1, 12);

			expect(helpers.isToday(new Date(2024, 0, 1, 0), now)).toBe(true);
			expect(helpers.isToday(new Date(2024, 0, 2, 0), now)).toBe(false);
			expect(helpers.isPast(new Date(2024, 0, 1, 11), now)).toBe(true);
			expect(helpers.isPast(now, now)).toBe(false);
			expect(helpers.isFuture(new Date(2024, 0, 1, 13), now)).toBe(true);
			expect(helpers.isFuture(now, now)).toBe(false);
		});

		it('default to the current time', function () {
			expect(helpers.isToday(new Date())).toBe(true);
			expect(helpers.isPast(Date.now() - 60_000)).toBe(true);
			expect(helpers.isFuture(Date.now() + 60_000)).toBe(true);
		});
	});

	describe('clampDate', function () {
		const min = new Date(2024, 0, 1);
		const max = new Date(2024, 11, 31);

		it('clamps into [min, max] and returns a new instance', function () {
			const inside = new Date(2024, 5, 1);
			const clamped = helpers.clampDate(inside, min, max);

			expect(clamped).not.toBe(inside);
			expect(clamped.getTime()).toBe(inside.getTime());
			expect(helpers.clampDate(new Date(2023, 0, 1), min, max).getTime()).toBe(min.getTime());
			expect(helpers.clampDate(new Date(2025, 0, 1), min, max).getTime()).toBe(max.getTime());
			expect(helpers.clampDate(5, 5, 5).getTime()).toBe(5);
		});

		it('lets min win when the bounds cross, like clamp', function () {
			for (const date of [new Date(2023, 0, 1), new Date(2024, 5, 1), new Date(2025, 0, 1)]) {
				expect(helpers.clampDate(date, max, min).getTime()).toBe(max.getTime());
			}
		});
	});

	describe('formatDuration', function () {
		it('reads each unit once (a getter cannot pass validation with one unit and supply another)', function () {
			function shifty(): helpers.DurationUnit[] {
				let reads = 0;
				const units = [] as helpers.DurationUnit[];

				Object.defineProperty(units, 0, {
					get: function () {
						return reads++ === 0 ? 'm' : 'x';
					},
					enumerable: true
				});

				return units;
			}

			expect(helpers.formatDuration(0, { units: shifty() })).toBe('0m');
			expect(helpers.formatDuration(150_000, { units: shifty() })).toBe('2m');
		});

		it('rejects a sparse units array instead of formatting its holes', function () {
			expect(function () {
				helpers.formatDuration(1000, { units: new Array(1) });
			}).toThrow(new RangeError('formatDuration: `units` must only contain d, h, m, s, ms, got undefined'));
		});

		it('formats with every unit by default, skipping zeros', function () {
			expect(helpers.formatDuration(93_784_005)).toBe('1d 2h 3m 4s 5ms');
			expect(helpers.formatDuration(5_400_000)).toBe('1h 30m');
			expect(helpers.formatDuration(86_400_000 + 3_000)).toBe('1d 3s');
			expect(helpers.formatDuration(999)).toBe('999ms');
			expect(helpers.formatDuration(0)).toBe('0s');
			expect(helpers.formatDuration(-0)).toBe('0s');
		});

		it('prefixes negative durations with a minus sign', function () {
			expect(helpers.formatDuration(-90_500)).toBe('-1m 30s 500ms');
			expect(helpers.formatDuration(-500, { units: ['s'] })).toBe('0s');
		});

		it('restricts the output to the selected units (any order, duplicates ignored)', function () {
			expect(helpers.formatDuration(93_784_005, { units: ['h', 'm'] })).toBe('26h 3m');
			expect(helpers.formatDuration(93_784_005, { units: ['m', 'h', 'm'] })).toBe('26h 3m');
			expect(helpers.formatDuration(1_500, { units: ['ms'] })).toBe('1500ms');
			expect(helpers.formatDuration(59_999, { units: ['m'] })).toBe('0m');
			expect(helpers.formatDuration(59_999, { units: ['m', 's'] })).toBe('59s');
		});

		it('limits the number of units with largest (truncating the rest)', function () {
			expect(helpers.formatDuration(93_784_005, { largest: 2 })).toBe('1d 2h');
			expect(helpers.formatDuration(86_400_000 + 180_000 + 59_000, { largest: 2 })).toBe('1d 3m');
			expect(helpers.formatDuration(93_784_005, { largest: 1 })).toBe('1d');
			expect(helpers.formatDuration(93_784_005, { largest: 99 })).toBe('1d 2h 3m 4s 5ms');
		});

		it('never produces negative parts for huge (non-safe) values whose quotient rounds up', function () {
			const text = helpers.formatDuration(3.9071043313737117e21);

			expect(text).not.toContain('-');
			expect(helpers.parseDuration(text)).toBeLessThanOrEqual(3.9071043313737117e21);
		});

		it('truncates sub-millisecond fractions', function () {
			expect(helpers.formatDuration(1.9)).toBe('1ms');
			expect(helpers.formatDuration(0.5)).toBe('0s');
		});

		it('is exact for the largest safe integers', function () {
			expect(helpers.formatDuration(Number.MAX_SAFE_INTEGER)).toBe('104249991d 8h 59m 991ms');
			expect(helpers.parseDuration(helpers.formatDuration(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
			expect(helpers.parseDuration(helpers.formatDuration(86_400_000 * 1e8 - 1))).toBe(86_400_000 * 1e8 - 1);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.formatDuration('1000' as any);
			}).toThrow(TypeError);
			[NaN, Infinity, -Infinity].forEach(function (ms) {
				expect(function () {
					helpers.formatDuration(ms);
				}).toThrow(RangeError);
			});
			expect(function () {
				helpers.formatDuration(1, { units: 'h' as any });
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatDuration(1, { units: [] });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatDuration(1, { units: ['h', 'w' as any] });
			}).toThrow(new RangeError('formatDuration: `units` must only contain d, h, m, s, ms, got w'));
			[0, -1, 1.5, NaN].forEach(function (largest) {
				expect(function () {
					helpers.formatDuration(1, { largest });
				}).toThrow(RangeError);
			});
		});
	});

	describe('parseDuration', function () {
		it('parses unit tokens into milliseconds', function () {
			expect(helpers.parseDuration('1h 30m')).toBe(5_400_000);
			expect(helpers.parseDuration('1d 2h 3m 4s 5ms')).toBe(93_784_005);
			expect(helpers.parseDuration('1h30m')).toBe(5_400_000);
			expect(helpers.parseDuration('  2 h  15 m ')).toBe(8_100_000);
			expect(helpers.parseDuration('250ms')).toBe(250);
			expect(helpers.parseDuration('1m1ms')).toBe(60_001);
			expect(helpers.parseDuration('30m 1h')).toBe(5_400_000);
			expect(helpers.parseDuration('1h 1h')).toBe(7_200_000);
			expect(helpers.parseDuration('0s')).toBe(0);
		});

		it('supports decimals and a leading minus sign', function () {
			expect(helpers.parseDuration('1.5s')).toBe(1_500);
			expect(helpers.parseDuration('.5h')).toBe(1_800_000);
			expect(helpers.parseDuration('0.5ms')).toBe(0.5);
			expect(helpers.parseDuration('-2m')).toBe(-120_000);
			expect(helpers.parseDuration(' -1m 30s 500ms')).toBe(-90_500);
			expect(Object.is(helpers.parseDuration('-0s'), 0)).toBe(true);
		});

		it('reads millions of tokens without overflowing the regex backtracking stack', function () {
			const tokens = '1d'.repeat(3_000_000);

			expect(helpers.parseDuration(tokens)).toBe(3_000_000 * 86_400_000);
			expect(function () {
				helpers.parseDuration(`${tokens}!`);
			}).toThrow(TypeError);
			expect(function () {
				helpers.parseDuration(`-${tokens} -`);
			}).toThrow(TypeError);
			expect(function () {
				helpers.parseDuration('- 1d');
			}).toThrow(TypeError);
			expect(function () {
				helpers.parseDuration(' -');
			}).toThrow(TypeError);
		});

		it('accepts multi-digit decimals, with or without a leading digit', function () {
			expect(helpers.parseDuration('1.25h')).toBe(4_500_000);
			expect(helpers.parseDuration('.25s')).toBe(250);
			expect(helpers.parseDuration('0.125m 1.5s')).toBe(9_000);
		});

		it('reads decimal amounts as written, not through a binary fraction', function () {
			// Multiplying the parsed number by the unit gives 1000.9999999999999, 95040000.00000001 and 864.0000000000001.
			expect(helpers.parseDuration('1.001s')).toBe(1_001);
			expect(helpers.parseDuration('1.1d')).toBe(95_040_000);
			expect(helpers.parseDuration('0.07s')).toBe(70);
			expect(helpers.parseDuration('-1.001s 0.3h')).toBe(-1_081_001);
			expect(helpers.parseDuration('0.0001m')).toBe(6);
			expect(helpers.parseDuration('0.00001d')).toBe(864);
			expect(helpers.parseDuration('0.25ms')).toBe(0.25);
		});

		it('gives the double nearest to a decimal amount of up to 13 significant digits, also when it has a fraction of a millisecond', function () {
			// Moving the point first (`Number('12.345678e5') * 36`) rounds twice: 44444440.800000004.
			expect(helpers.parseDuration('12.345678h')).toBe(44_444_440.8);
			expect(helpers.parseDuration('-12.345678h')).toBe(-44_444_440.8);
			// Beyond, the point is moved before multiplying.
			expect(helpers.parseDuration('123456789012345.5d')).toBe(Number('123456789012345.5e5') * 864);
		});

		it('does not coerce non-strings, even those whose string form is valid', function () {
			expect(function () {
				helpers.parseDuration({
					toString: function () {
						return '1h';
					}
				} as any);
			}).toThrow(TypeError);
		});

		it('throws TypeError on garbage', function () {
			['', '   ', '10', 'h', '1x', '1 h m', '--1h', '1h -2m', '1H', '1.h', '1e3s', '1,5s', '+1h', '1hour', 'NaNs', '1 d2'].forEach(function (value) {
				expect(function () {
					helpers.parseDuration(value);
				}).toThrow(TypeError);
			});
			expect(function () {
				helpers.parseDuration(1000 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.parseDuration(`${'1'.repeat(200)}x`);
			}).toThrow(/…/);
		});

		it('throws RangeError when the total is not finite', function () {
			expect(function () {
				helpers.parseDuration(`1${'0'.repeat(400)}d`);
			}).toThrow(RangeError);
		});
	});

	describe('argument validation', function () {
		it('names the public function and the parameter in error messages', function () {
			expect(function () {
				helpers.endOfWeek(new Date(2024, 0, 1), 7 as any);
			}).toThrow(new RangeError('endOfWeek: `weekStartsOn` must be an integer between 0 and 6, got 7'));
			expect(function () {
				helpers.addDays(new Date(2024, 0, 1), '1' as any);
			}).toThrow(new TypeError('addDays: `amount` must be an integer, got string'));
			expect(function () {
				helpers.daysInMonth(2024, 12);
			}).toThrow(new RangeError('daysInMonth: `monthIndex` must be an integer between 0 and 11, got 12'));
			expect(function () {
				helpers.isLeapYear(2024.5);
			}).toThrow(new RangeError('isLeapYear: `yearOrDate` must be an integer or a Date, got 2024.5'));
			expect(function () {
				helpers.formatDuration(1, { largest: 0 });
			}).toThrow(new RangeError('formatDuration: `largest` must be an integer >= 1 or Infinity, got 0'));
			expect(function () {
				helpers.parseDuration('10');
			}).toThrow(new TypeError('parseDuration: `value` must be a valid duration, got "10"'));
		});

		it('names the right function and parameter for every validated argument', function () {
			const date = new Date(2024, 0, 1);
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.addWeeks(date, 0.5);
					},
					new RangeError('addWeeks: `amount` must be an integer, got 0.5')
				],
				[
					function () {
						return helpers.addMonths(date, 0.5);
					},
					new RangeError('addMonths: `amount` must be an integer, got 0.5')
				],
				[
					function () {
						return helpers.addYears(date, 0.5);
					},
					new RangeError('addYears: `amount` must be an integer, got 0.5')
				],
				[
					function () {
						return helpers.addHours(date, NaN);
					},
					new RangeError('addHours: `amount` must be a finite number, got NaN')
				],
				[
					function () {
						return helpers.addMinutes(date, NaN);
					},
					new RangeError('addMinutes: `amount` must be a finite number, got NaN')
				],
				[
					function () {
						return helpers.addSeconds(date, NaN);
					},
					new RangeError('addSeconds: `amount` must be a finite number, got NaN')
				],
				[
					function () {
						return helpers.addBusinessDays(date, 0.5);
					},
					new RangeError('addBusinessDays: `amount` must be an integer, got 0.5')
				],
				[
					function () {
						return helpers.startOfWeek(date, -1 as any);
					},
					new RangeError('startOfWeek: `weekStartsOn` must be an integer between 0 and 6, got -1')
				],
				[
					function () {
						return helpers.daysInMonth(2024.5, 0);
					},
					new RangeError('daysInMonth: `year` must be an integer, got 2024.5')
				],
				[
					function () {
						return helpers.eachDayOfInterval(date, date, { step: 0 });
					},
					new RangeError('eachDayOfInterval: `step` must be a safe integer >= 1, got 0')
				],
				[
					function () {
						return helpers.formatDuration(Infinity);
					},
					new RangeError('formatDuration: `ms` must be a finite number, got Infinity')
				],
				[
					function () {
						return helpers.formatDuration(1, { units: 'h' as any });
					},
					new TypeError('formatDuration: `units` must be an array of duration units, got string')
				],
				[
					function () {
						return helpers.formatDuration(1, { units: [] });
					},
					new RangeError('formatDuration: `units` must not be empty')
				],
				[
					function () {
						return helpers.isBetween(date, date, date, '[[' as any);
					},
					new RangeError('isBetween: `inclusivity` must be one of [], (), [), (], got [[')
				],
				[
					function () {
						return helpers.parseDuration(5 as any);
					},
					new TypeError('parseDuration: `value` must be a string, got number')
				],
				[
					function () {
						return helpers.parseDuration(`1${'0'.repeat(400)}d`);
					},
					new RangeError('parseDuration: the duration is too large to be represented')
				],
				[
					function () {
						return helpers.addDays('2024-01-01' as any, 1);
					},
					new TypeError('Expected a Date or a timestamp number')
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
		});

		it('quotes at most 50 characters of an invalid duration string', function () {
			const fifty = `${'1'.repeat(49)}x`;
			expect(function () {
				helpers.parseDuration(fifty);
			}).toThrow(new TypeError(`parseDuration: \`value\` must be a valid duration, got "${fifty}"`));
			expect(function () {
				helpers.parseDuration(`${fifty}y`);
			}).toThrow(new TypeError(`parseDuration: \`value\` must be a valid duration, got "${fifty}…"`));
		});
	});

	describe('security', function () {
		it('tokenizes patterns full of unclosed brackets in linear time', function () {
			const pattern = '['.repeat(200_000);
			const start = performance.now();
			expect(helpers.formatDate(0, pattern)).toBe(pattern);
			expect(helpers.formatDate(new Date(2024, 0, 5), `YYYY [x] ${pattern}D`)).toBe(`2024 x ${pattern}5`);
			expect(helpers.formatDate(new Date(2024, 0, 5), `]${pattern}`)).toBe(`]${pattern}`);
			// The quadratic tokenizer took several seconds on 80k characters.
			expect(performance.now() - start).toBeLessThan(1000);
		});

		it('keeps the meaning of brackets: the first `]` closes a group, unclosed `[` are literal', function () {
			const date = new Date(2024, 0, 5, 14, 7);
			expect(helpers.formatDate(date, '[[D]] D')).toBe('[D] 5');
			expect(helpers.formatDate(date, '[D [D] D')).toBe('D [D 5');
			expect(helpers.formatDate(date, 'D] [D')).toBe('5] [5');
			expect(helpers.formatDate(date, ']]')).toBe(']]');
		});

		it('does not cache patterns or locales longer than 1024 characters', function () {
			const set = jest.spyOn(Map.prototype, 'set');
			try {
				const date = new Date(2024, 0, 5);
				const long = `${'['.repeat(1024)}D`;
				const longLocale = `en-x-${'abcdefgh-'.repeat(113)}abc`;
				expect(helpers.formatDate(date, long)).toBe(`${'['.repeat(1024)}5`);
				expect(helpers.formatDate(date, long.slice(1))).toBe(`${'['.repeat(1023)}5`);
				expect(helpers.getRelativeTime(date, date, longLocale)).toBe('now');
				const keys = set.mock.calls.map(function (call: any[]) {
					return call[0];
				});
				expect(keys).toEqual([long.slice(1)]);
			} finally {
				set.mockRestore();
			}
		});
	});

	describe('round 11: addDuration / subDuration / intervalToDuration', function () {
		it('applies the largest units first, with end-of-month clamping', function () {
			expect(parts(helpers.addDuration(new Date(2024, 0, 31, 9), { months: 1, days: 1, hours: 2 }))).toEqual([2024, 2, 1, 11, 0, 0, 0]);
			expect(ymd(helpers.addDuration(new Date(2023, 0, 31), { months: 1 }))).toEqual([2023, 1, 28]);
			expect(ymd(helpers.addDuration(new Date(2024, 1, 29), { years: 1, weeks: 1 }))).toEqual([2025, 2, 7]);
			expect(ymd(helpers.addDuration(new Date(2024, 1, 29), { years: -4 }))).toEqual([2020, 1, 29]);
			expect(parts(helpers.addDuration(new Date(2024, 0, 1), { minutes: 90, seconds: 1.5, milliseconds: 2 }))).toEqual([2024, 0, 1, 1, 30, 1, 502]);
			expect(parts(helpers.addDuration(new Date(2024, 0, 1, 12), { hours: -0.5 }))).toEqual([2024, 0, 1, 11, 30, 0, 0]);
		});

		it('returns a copy for an empty duration and never mutates the input', function () {
			const date = new Date(2024, 0, 31);
			const result = helpers.addDuration(date, {});
			expect(result).not.toBe(date);
			expect(result.getTime()).toBe(date.getTime());
			expect(helpers.addDuration(date.getTime(), { days: 0, hours: 0 }).getTime()).toBe(date.getTime());
			helpers.addDuration(date, { months: 1, hours: 1 });
			expect(ymd(date)).toEqual([2024, 0, 31]);
			expect(helpers.addDuration(0, { years: undefined, hours: 1 }).getTime()).toBe(3_600_000);
		});

		it('subDuration negates every field', function () {
			expect(parts(helpers.subDuration(new Date(2024, 2, 31, 12), { months: 1, hours: 12 }))).toEqual([2024, 1, 29, 0, 0, 0, 0]);
			expect(ymd(helpers.subDuration(new Date(2024, 0, 10), { weeks: 1, days: 2 }))).toEqual([2024, 0, 1]);
			expect(ymd(helpers.subDuration(new Date(2024, 0, 10), { days: -2 }))).toEqual([2024, 0, 12]);
		});

		it('validates the duration', function () {
			expect(function () {
				helpers.addDuration(new Date(), null as any);
			}).toThrow(new TypeError('addDuration: `duration` must be an object, got null'));
			expect(function () {
				helpers.subDuration(new Date(), 5 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.addDuration(new Date(), { day: 1 } as any);
			}).toThrow(new RangeError('addDuration: `duration` must only have the fields years, months, weeks, days, hours, minutes, seconds, milliseconds, got "day"'));
			expect(function () {
				helpers.addDuration(new Date(), JSON.parse('{"__proto__":{"days":1}}'));
			}).toThrow(RangeError);
			expect(function () {
				helpers.addDuration(new Date(), { days: 1.5 });
			}).toThrow(new RangeError('addDuration: `duration.days` must be an integer, got 1.5'));
			expect(function () {
				helpers.subDuration(new Date(), { years: '1' as any });
			}).toThrow(new TypeError('subDuration: `duration.years` must be an integer, got string'));
			expect(function () {
				helpers.addDuration(new Date(), { hours: Infinity });
			}).toThrow(new RangeError('addDuration: `duration.hours` must be a finite number, got Infinity'));
			expect(function () {
				helpers.addDuration(INVALID, { days: 1 });
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				helpers.addDuration(new Date(), { years: 300_000 });
			}).toThrow(new RangeError('Resulting date is out of range'));
			expect(function () {
				helpers.addDuration(8.64e15, { hours: 1 });
			}).toThrow(new RangeError('Resulting date is out of range'));
		});

		it('intervalToDuration breaks an interval into calendar components', function () {
			const zero = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };
			expect(helpers.intervalToDuration(new Date(2024, 0, 31, 9), new Date(2025, 2, 1, 11, 30, 5, 7))).toEqual({
				years: 1,
				months: 1,
				days: 1,
				hours: 2,
				minutes: 30,
				seconds: 5,
				milliseconds: 7
			});
			expect(helpers.intervalToDuration(new Date(2023, 0, 31), new Date(2023, 1, 28))).toEqual({ ...zero, months: 1 });
			expect(helpers.intervalToDuration(new Date(2024, 0, 31), new Date(2024, 1, 28))).toEqual({ ...zero, days: 28 });
			expect(helpers.intervalToDuration(new Date(2024, 0, 15, 12), new Date(2024, 1, 15, 11))).toEqual({ ...zero, days: 30, hours: 23 });
			expect(helpers.intervalToDuration(5, 5)).toEqual(zero);
		});

		it('intervalToDuration walks backwards from start when end is earlier', function () {
			const zero = { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };
			expect(helpers.intervalToDuration(new Date(2024, 0, 2), new Date(2024, 0, 1, 12))).toEqual({ ...zero, hours: -12 });
			expect(helpers.intervalToDuration(new Date(2023, 2, 31, 10), new Date(2023, 1, 28, 12))).toEqual({ ...zero, days: -30, hours: -22 });
			expect(helpers.intervalToDuration(new Date(2024, 2, 31, 10), new Date(2024, 1, 28, 12))).toEqual({ ...zero, months: -1, hours: -22 });
			expect(helpers.intervalToDuration(new Date(2025, 2, 31), new Date(2024, 1, 29))).toEqual({ ...zero, years: -1, months: -1 });
			const start = new Date(2024, 2, 31, 10);
			const end = new Date(2023, 1, 28, 12);
			expect(helpers.addDuration(start, helpers.intervalToDuration(start, end)).getTime()).toBe(end.getTime());
		});
	});

	describe('round 11: toISOStringLocal', function () {
		it('equals toISOString() when the offset is zero', function () {
			withTimeZone('UTC', function () {
				const date = new Date(Date.UTC(2026, 9, 18, 9, 30, 15, 7));
				expect(helpers.toISOStringLocal(date)).toBe('2026-10-18T09:30:15.007Z');
				expect(helpers.toISOStringLocal(date.getTime(), { milliseconds: false })).toBe('2026-10-18T09:30:15Z');
				expect(helpers.toISOStringLocal(Date.UTC(-1, 0, 1) - 1)).toBe('-000002-12-31T23:59:59.999Z');
				expect(helpers.toISOStringLocal(new Date(Date.UTC(10000, 0, 1)))).toBe('+010000-01-01T00:00:00.000Z');
				expect(helpers.toISOStringLocal(8.64e15)).toBe('+275760-09-13T00:00:00.000Z');
			});
		});

		it('writes half-hour and 45-minute offsets with the right sign', function () {
			const instant = Date.UTC(2026, 0, 18, 7, 30);
			const expected: Array<[string, string]> = [
				['Asia/Kolkata', '2026-01-18T13:00:00.000+05:30'],
				['Asia/Kathmandu', '2026-01-18T13:15:00.000+05:45'],
				['America/St_Johns', '2026-01-18T04:00:00.000-03:30'],
				['Australia/Lord_Howe', '2026-01-18T18:30:00.000+11:00'],
				['Pacific/Chatham', '2026-01-18T21:15:00.000+13:45'],
				['America/New_York', '2026-01-18T02:30:00.000-05:00']
			];
			for (const [zone, iso] of expected) {
				withTimeZone(zone, function () {
					expect(helpers.toISOStringLocal(instant)).toBe(iso);
					expect(new Date(iso).getTime()).toBe(instant);
				});
			}
			withTimeZone('Australia/Lord_Howe', function () {
				expect(helpers.toISOStringLocal(Date.UTC(2026, 5, 18, 7, 30))).toBe('2026-06-18T18:00:00.000+10:30');
			});
		});

		it('keeps the instant for negative years and historical offsets with seconds', function () {
			withTimeZone('America/New_York', function () {
				const ancient = new Date(Date.UTC(-1, 0, 1, 12));
				const iso = helpers.toISOStringLocal(ancient);
				expect(iso).toBe('-000001-01-01T07:04:00.000-04:56');
				expect(new Date(iso).getTime()).toBe(ancient.getTime());
			});
			withTimeZone('Europe/Paris', function () {
				// Paris mean time was UTC+00:09:21: shown at +00:09, 21 seconds earlier than the wall clock.
				const date = new Date(1900, 0, 1);
				expect(helpers.toISOStringLocal(date)).toBe('1899-12-31T23:59:39.000+00:09');
				expect(helpers.toISOStringLocal(date, { milliseconds: false })).toBe('1899-12-31T23:59:39+00:09');
				expect(new Date(helpers.toISOStringLocal(date)).getTime()).toBe(date.getTime());
			});
		});

		it('works up to the limits of the Date range', function () {
			withTimeZone('Asia/Tokyo', function () {
				expect(helpers.toISOStringLocal(8.64e15)).toBe('+275760-09-13T09:00:00.000+09:00');
				expect(new Date(helpers.toISOStringLocal(8.64e15)).getTime()).toBe(8.64e15);
			});
			withTimeZone('America/New_York', function () {
				// Local mean time (-04:56:02) at the earliest date: the instant at -04:56 is before the range.
				expect(function () {
					helpers.toISOStringLocal(-8.64e15);
				}).toThrow(new RangeError('Resulting date is out of range'));
			});
			expect(function () {
				helpers.toISOStringLocal(INVALID);
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('round 11: diffInWeeks / diffInYears / diffInCalendarMonths / diffInCalendarYears', function () {
		it('counts complete weeks, time of day included', function () {
			expect(helpers.diffInWeeks(new Date(2024, 0, 15), new Date(2024, 0, 1))).toBe(2);
			expect(helpers.diffInWeeks(new Date(2024, 0, 15, 8), new Date(2024, 0, 1, 9))).toBe(1);
			expect(helpers.diffInWeeks(new Date(2024, 0, 1), new Date(2024, 0, 15))).toBe(-2);
			expect(helpers.diffInWeeks(new Date(2024, 0, 1, 9), new Date(2024, 0, 15, 8))).toBe(-1);
			expect(helpers.diffInWeeks(new Date(2024, 0, 7), new Date(2024, 0, 1))).toBe(0);
			expect(Object.is(helpers.diffInWeeks(new Date(2024, 0, 1), new Date(2024, 0, 3)), 0)).toBe(true);
		});

		it('counts complete years with the Feb 29 → Feb 28 policy of addYears', function () {
			expect(helpers.diffInYears(new Date(2024, 5, 15), new Date(2020, 5, 16))).toBe(3);
			expect(helpers.diffInYears(new Date(2024, 5, 16), new Date(2020, 5, 16))).toBe(4);
			expect(helpers.diffInYears(new Date(2025, 1, 28), new Date(2024, 1, 29))).toBe(1);
			expect(helpers.diffInYears(new Date(2025, 1, 27, 23), new Date(2024, 1, 29))).toBe(0);
			expect(helpers.diffInYears(new Date(2020, 0, 1), new Date(2024, 0, 1))).toBe(-4);
			expect(helpers.diffInYears(new Date(2024, 11, 31), new Date(2024, 0, 1))).toBe(0);
		});

		it('counts calendar months and years, ignoring the rest', function () {
			expect(helpers.diffInCalendarMonths(new Date(2024, 0, 1), new Date(2023, 11, 31, 23))).toBe(1);
			expect(helpers.diffInCalendarMonths(new Date(2024, 2, 31), new Date(2024, 2, 1))).toBe(0);
			expect(helpers.diffInCalendarMonths(new Date(2023, 0, 1), new Date(2024, 11, 31))).toBe(-23);
			expect(helpers.diffInCalendarYears(new Date(2024, 0, 1), new Date(2023, 11, 31))).toBe(1);
			expect(helpers.diffInCalendarYears(0, 0)).toBe(0);
		});
	});

	describe('round 11: startOfHour / endOfHour / startOfMinute / endOfMinute', function () {
		it('truncates to the wall-clock hour and minute', function () {
			const date = new Date(2024, 4, 10, 15, 42, 7, 9);
			expect(parts(helpers.startOfHour(date))).toEqual([2024, 4, 10, 15, 0, 0, 0]);
			expect(parts(helpers.endOfHour(date))).toEqual([2024, 4, 10, 15, 59, 59, 999]);
			expect(parts(helpers.startOfMinute(date))).toEqual([2024, 4, 10, 15, 42, 0, 0]);
			expect(parts(helpers.endOfMinute(date))).toEqual([2024, 4, 10, 15, 42, 59, 999]);
			expect(parts(helpers.endOfHour(new Date(2024, 4, 10, 15)))).toEqual([2024, 4, 10, 15, 59, 59, 999]);
			expect(parts(helpers.endOfMinute(new Date(2024, 11, 31, 23, 59, 30)))).toEqual([2024, 11, 31, 23, 59, 59, 999]);
			expect(helpers.startOfMinute(date)).not.toBe(date);
		});

		it('keeps each occurrence of the repeated hour when clocks are set back (New York)', function () {
			withTimeZone('America/New_York', function () {
				const second = new Date('2024-11-03T06:30:00Z'); // 01:30 EST, the second 01:30
				expect(helpers.startOfHour(second).toISOString()).toBe('2024-11-03T06:00:00.000Z'); // 01:00 EST
				expect(helpers.endOfHour(second).toISOString()).toBe('2024-11-03T06:59:59.999Z');
				const first = new Date('2024-11-03T05:30:00Z'); // 01:30 EDT
				expect(helpers.startOfHour(first).toISOString()).toBe('2024-11-03T05:00:00.000Z');
				expect(helpers.endOfHour(first).toISOString()).toBe('2024-11-03T05:59:59.999Z');
				expect(helpers.startOfHour(new Date('2024-03-10T07:30:00Z')).toISOString()).toBe('2024-03-10T07:00:00.000Z'); // 03:00 EDT
			});
		});

		it('stays on the wall-clock hour when the clock moves by 30 minutes (Lord Howe Island)', function () {
			withTimeZone('Australia/Lord_Howe', function () {
				// 2024-04-07 02:00 (+11:00) → 01:30 (+10:30): 01:45 (+10:30) is in the repeated half hour.
				const repeated = new Date('2024-04-06T15:15:00Z');
				expect(helpers.startOfHour(repeated).toISOString()).toBe('2024-04-06T14:00:00.000Z'); // 01:00 (+11:00)
				expect(parts(helpers.startOfHour(repeated))).toEqual([2024, 3, 7, 1, 0, 0, 0]);
				expect(parts(helpers.endOfHour(repeated))).toEqual([2024, 3, 7, 1, 59, 59, 999]);
				// 2024-10-06 02:00 (+10:30) → 02:30 (+11:00): the hour 02 starts at 02:30.
				const afterGap = new Date('2024-10-05T15:45:00Z'); // 02:45 (+11:00)
				expect(parts(helpers.startOfHour(afterGap))).toEqual([2024, 9, 6, 2, 30, 0, 0]);
				expect(helpers.startOfHour(afterGap).toISOString()).toBe('2024-10-05T15:30:00.000Z');
			});
		});

		it('starts an hour whose beginning the clocks skipped at the end of the gap (Chatham Islands, Toronto 1919)', function () {
			withTimeZone('Pacific/Chatham', function () {
				// 2025-09-28 02:45 (+12:45) → 03:45 (+13:45): the hour 03 starts at 03:45, and the hour 02 ends at the jump.
				expect(helpers.startOfHour(new Date('2025-09-27T14:05:00Z')).toISOString()).toBe('2025-09-27T14:00:00.000Z'); // 03:50, not 02:00
				expect(helpers.endOfHour(new Date('2025-09-27T13:45:00Z')).toISOString()).toBe('2025-09-27T13:59:59.999Z'); // 02:30, not 03:59:59
			});
			withTimeZone('America/Toronto', function () {
				// 1919-03-30 23:30 (-05:00) → 00:30 (-04:00): midnight was skipped.
				expect(helpers.startOfHour(new Date('1919-03-31T04:45:00Z')).toISOString()).toBe('1919-03-31T04:30:00.000Z'); // 00:45, not 23:00
				expect(helpers.endOfHour(new Date('1919-03-31T04:15:00Z')).toISOString()).toBe('1919-03-31T04:29:59.999Z'); // 23:15
				// 1895-01-01 00:00 (-05:17:32) → 00:17:32 (-05:00): the minute 00:17 starts at 00:17:32, not 17 minutes later.
				expect(helpers.startOfMinute(new Date('1895-01-01T05:17:32Z')).toISOString()).toBe('1895-01-01T05:17:32.000Z');
			});
		});

		it('ends an hour where the next one starts when the clocks are set back to a full hour (Colombo 2006, Barbados 1944)', function () {
			withTimeZone('Asia/Colombo', function () {
				// 2006-04-15 00:30 (+06:00) → 00:00 (+05:30): a new hour 00 starts at the jump, as startOfHour and eachOfInterval say.
				const before = new Date('2006-04-14T18:10:00Z'); // 00:10 (+06:00)
				expect(helpers.startOfHour(before).toISOString()).toBe('2006-04-14T18:00:00.000Z');
				expect(helpers.endOfHour(before).toISOString()).toBe('2006-04-14T18:29:59.999Z'); // not 00:59:59 (+05:30)
				expect(helpers.startOfHour(new Date('2006-04-14T18:30:00Z')).toISOString()).toBe('2006-04-14T18:30:00.000Z');
				expect(helpers.endOfHour(new Date('2006-04-14T18:30:00Z')).toISOString()).toBe('2006-04-14T19:29:59.999Z');
			});
			withTimeZone('America/Barbados', function () {
				// 1944-09-10 02:30 (-03:30) → 02:00 (-04:00).
				expect(helpers.endOfHour(new Date('1944-09-10T05:30:09Z')).toISOString()).toBe('1944-09-10T05:59:59.999Z'); // 02:00:09
			});
		});

		it('ends a minute that the clocks repeat part of where it ends for startOfMinute (N’Djamena 1911)', function () {
			withTimeZone('Africa/Ndjamena', function () {
				// 1912-01-01 00:00:00 (+01:00:12) → 1911-12-31 23:59:48 (+01:00): the minute 23:59 (+01:00:12) goes on 12 more seconds.
				const minute = new Date('1911-12-31T22:59:30Z'); // 23:59:42 (+01:00:12)
				expect(helpers.startOfMinute(minute).toISOString()).toBe('1911-12-31T22:58:48.000Z');
				expect(helpers.startOfMinute(new Date('1911-12-31T22:59:53Z')).toISOString()).toBe('1911-12-31T22:58:48.000Z');
				expect(helpers.endOfMinute(minute).toISOString()).toBe('1911-12-31T22:59:59.999Z'); // not 22:59:47.999
			});
		});

		it('throws when the boundary is out of range', function () {
			withTimeZone('UTC', function () {
				expect(helpers.startOfHour(-8.64e15).getTime()).toBe(-8.64e15);
				expect(function () {
					helpers.endOfHour(8.64e15);
				}).toThrow(new RangeError('Resulting date is out of range'));
				expect(function () {
					helpers.endOfMinute(8.64e15);
				}).toThrow(RangeError);
			});
			withTimeZone('America/New_York', function () {
				expect(function () {
					helpers.startOfMinute(-8.64e15);
				}).toThrow(new RangeError('Resulting date is out of range'));
			});
		});
	});

	describe('round 11: roundToNearestMinutes', function () {
		it('rounds to a wall-clock grid in the three modes', function () {
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 7, 30), 5))).toEqual([2024, 0, 1, 9, 10, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 7, 29, 999), 5))).toEqual([2024, 0, 1, 9, 5, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 7), 15, 'floor'))).toEqual([2024, 0, 1, 9, 0, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 50), 15, 'ceil'))).toEqual([2024, 0, 1, 10, 0, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 45), 15, 'ceil'))).toEqual([2024, 0, 1, 9, 45, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 29, 59)))).toEqual([2024, 0, 1, 9, 30, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 11, 31, 23, 30), 60))).toEqual([2025, 0, 1, 0, 0, 0, 0]);
			expect(parts(helpers.roundToNearestMinutes(new Date(2024, 0, 1, 9, 0, 0, 1), 1, 'ceil'))).toEqual([2024, 0, 1, 9, 1, 0, 0]);
		});

		it('rounds to the nearest instant across a DST change', function () {
			withTimeZone('America/New_York', function () {
				// 01:30 EDT is as far from 01:00 EDT as from 01:00 EST, 30 minutes later: the tie goes up.
				expect(helpers.roundToNearestMinutes(new Date('2024-11-03T05:30:00Z'), 60).toISOString()).toBe('2024-11-03T06:00:00.000Z');
			});
			withTimeZone('Australia/Lord_Howe', function () {
				// 01:45 (+11:00) rounded up to the hour: 02:00 comes after the repeated half hour, at +10:30.
				expect(helpers.roundToNearestMinutes(new Date('2024-04-06T14:45:00Z'), 60, 'ceil').toISOString()).toBe('2024-04-06T15:30:00.000Z');
				expect(helpers.roundToNearestMinutes(new Date('2024-04-06T14:45:00Z'), 30, 'ceil').toISOString()).toBe('2024-04-06T15:00:00.000Z');
			});
		});

		it('replaces a slot that the clocks skipped with the end of the gap, never past the date with floor', function () {
			withTimeZone('Australia/Lord_Howe', function () {
				// 2024-10-06 02:00 (+10:30) → 02:30 (+11:00): 02:20 (20-minute grid) and 02:24 (12-minute grid) never happened.
				expect(helpers.roundToNearestMinutes(new Date('2024-10-05T15:35:00Z'), 20, 'floor').toISOString()).toBe('2024-10-05T15:30:00.000Z'); // not 02:50
				expect(helpers.roundToNearestMinutes(new Date('2024-10-05T15:31:00Z'), 12, 'floor').toISOString()).toBe('2024-10-05T15:30:00.000Z'); // not 02:54
				expect(helpers.roundToNearestMinutes(new Date('2024-10-05T15:25:00Z'), 12, 'ceil').toISOString()).toBe('2024-10-05T15:30:00.000Z');
			});
			withTimeZone('Pacific/Chatham', function () {
				// 2025-09-28 02:45 (+12:45) → 03:45 (+13:45): 03:00 and 03:30 never happened.
				expect(helpers.roundToNearestMinutes(new Date('2025-09-27T14:05:00Z'), 30, 'floor').toISOString()).toBe('2025-09-27T14:00:00.000Z'); // not 02:30
				expect(helpers.roundToNearestMinutes(new Date('2025-09-27T13:45:00Z'), 60, 'ceil').toISOString()).toBe('2025-09-27T14:00:00.000Z'); // not 04:00
				expect(helpers.roundToNearestMinutes(new Date('2025-09-27T13:45:00Z'), 60).toISOString()).toBe('2025-09-27T14:00:00.000Z');
			});
		});

		it('validates step and mode', function () {
			for (const step of [0, 7, 45, 120, 1.5, -5, NaN]) {
				expect(function () {
					helpers.roundToNearestMinutes(0, step);
				}).toThrow(new RangeError(`roundToNearestMinutes: \`step\` must be a divisor of 60, got ${step}`));
			}
			expect(function () {
				helpers.roundToNearestMinutes(0, '5' as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.roundToNearestMinutes(0, 5, 'up' as any);
			}).toThrow(new RangeError('roundToNearestMinutes: `mode` must be one of round, floor, ceil, got up'));
			expect(function () {
				helpers.roundToNearestMinutes(INVALID);
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('round 11: eachOfInterval', function () {
		it('enumerates every unit from the start of the first one', function () {
			expect(helpers.eachOfInterval(new Date(2024, 0, 31), new Date(2024, 3, 15), 'month').map(ymd)).toEqual([
				[2024, 0, 1],
				[2024, 1, 1],
				[2024, 2, 1],
				[2024, 3, 1]
			]);
			expect(helpers.eachOfInterval(new Date(2023, 10, 5), new Date(2024, 6, 1), 'quarter').map(ymd)).toEqual([
				[2023, 9, 1],
				[2024, 0, 1],
				[2024, 3, 1],
				[2024, 6, 1]
			]);
			expect(helpers.eachOfInterval(new Date(2020, 5, 1), new Date(2024, 5, 1), 'year', 2).map(ymd)).toEqual([
				[2020, 0, 1],
				[2022, 0, 1],
				[2024, 0, 1]
			]);
			expect(helpers.eachOfInterval(new Date(2024, 0, 3), new Date(2024, 0, 20), 'week', 1, 1).map(ymd)).toEqual([
				[2024, 0, 1],
				[2024, 0, 8],
				[2024, 0, 15]
			]);
			expect(helpers.eachOfInterval(new Date(2024, 0, 3), new Date(2024, 0, 20), 'week').map(ymd)).toEqual([
				[2023, 11, 31],
				[2024, 0, 7],
				[2024, 0, 14]
			]);
			expect(helpers.eachOfInterval(new Date(2024, 0, 30, 18), new Date(2024, 1, 2, 9), 'day', 2).map(parts)).toEqual([
				[2024, 0, 30, 0, 0, 0, 0],
				[2024, 1, 1, 0, 0, 0, 0]
			]);
			expect(helpers.eachOfInterval(new Date(2024, 0, 1, 9, 30), new Date(2024, 0, 1, 12), 'hour').map(parts)).toEqual([
				[2024, 0, 1, 9, 0, 0, 0],
				[2024, 0, 1, 10, 0, 0, 0],
				[2024, 0, 1, 11, 0, 0, 0],
				[2024, 0, 1, 12, 0, 0, 0]
			]);
			expect(helpers.eachOfInterval(new Date(2024, 0, 1, 9, 58, 30), new Date(2024, 0, 1, 10, 1), 'minute', 2).map(parts)).toEqual([
				[2024, 0, 1, 9, 58, 0, 0],
				[2024, 0, 1, 10, 0, 0, 0]
			]);
			expect(helpers.eachOfInterval(5, 5, 'minute')).toEqual([helpers.startOfMinute(5)]);
		});

		it('agrees with eachDayOfInterval for days', function () {
			const start = new Date(2024, 1, 25, 13);
			const end = new Date(2024, 2, 5, 2);
			expect(helpers.eachOfInterval(start, end, 'day', 3)).toEqual(helpers.eachDayOfInterval(start, end, { step: 3 }));
		});

		it('steps hours on the timeline and snaps them to the wall clock', function () {
			withTimeZone('America/New_York', function () {
				const fallBack = helpers.eachOfInterval(new Date(2024, 10, 3), new Date(2024, 10, 3, 3), 'hour');
				expect(fallBack.map(Number)).toEqual(
					[4, 5, 6, 7, 8].map(function (hour: number) {
						return Date.UTC(2024, 10, 3, hour);
					})
				);
				expect(
					helpers.eachOfInterval(new Date(2024, 2, 10), new Date(2024, 2, 10, 4), 'hour').map(function (date: Date) {
						return date.getHours();
					})
				).toEqual([0, 1, 3, 4]);
			});
			withTimeZone('Australia/Lord_Howe', function () {
				/**
				 * Formats the wall-clock time.
				 */
				function hours(date: Date): string {
					return helpers.formatDate(date, 'HH:mm');
				}
				// Clocks set back from 02:00 to 01:30: whole hours only, each once.
				expect(helpers.eachOfInterval(new Date('2024-04-06T13:00:00Z'), new Date('2024-04-06T17:00:00Z'), 'hour').map(hours)).toEqual([
					'00:00',
					'01:00',
					'02:00',
					'03:00'
				]);
				// Clocks moved forward from 02:00 to 02:30: the hour 02 starts at 02:30.
				expect(helpers.eachOfInterval(new Date('2024-10-05T13:30:00Z'), new Date('2024-10-05T17:00:00Z'), 'hour').map(hours)).toEqual([
					'00:00',
					'01:00',
					'02:30',
					'03:00',
					'04:00'
				]);
			});
		});

		it('validates its arguments and refuses huge results', function () {
			expect(function () {
				helpers.eachOfInterval(0, 1, 'decade' as any);
			}).toThrow(new RangeError('eachOfInterval: `unit` must be one of year, quarter, month, week, day, hour, minute, got decade'));
			expect(function () {
				helpers.eachOfInterval(0, 1, 'day', 0);
			}).toThrow(new RangeError('eachOfInterval: `step` must be a safe integer >= 1, got 0'));
			expect(function () {
				helpers.eachOfInterval(0, 1, 'week', 1, 7 as any);
			}).toThrow(new RangeError('eachOfInterval: `weekStartsOn` must be an integer between 0 and 6, got 7'));
			expect(function () {
				helpers.eachOfInterval(1, 0, 'day');
			}).toThrow(new RangeError('eachOfInterval: `start` must not be after `end`'));
			expect(function () {
				helpers.eachOfInterval(0, 3 * 365 * 86_400_000, 'minute');
			}).toThrow(new RangeError('eachOfInterval: the interval holds 1576801 dates, more than 1000000'));
			expect(function () {
				helpers.eachOfInterval(-8.64e15, 8.64e15, 'day');
			}).toThrow(RangeError);
			expect(helpers.eachOfInterval(Date.UTC(-200_000, 6, 1), Date.UTC(200_000, 6, 1), 'year', 1000)).toHaveLength(401);
			withTimeZone('UTC', function () {
				expect(function () {
					helpers.eachOfInterval(-8.64e15, 8.64e15, 'year', 1000);
				}).toThrow(new RangeError('Resulting date is out of range'));
				expect(helpers.eachOfInterval(8.64e15 - 3_600_000, 8.64e15, 'hour').map(Number)).toEqual([8.64e15 - 3_600_000, 8.64e15]);
			});
		});
	});

	describe('round 11: nextWeekday / previousWeekday', function () {
		it('finds the weekday strictly after or before, keeping the time of day', function () {
			const wednesday = new Date(2024, 4, 15, 9, 30);
			expect(parts(helpers.nextWeekday(wednesday, 5))).toEqual([2024, 4, 17, 9, 30, 0, 0]);
			expect(ymd(helpers.nextWeekday(wednesday, 3))).toEqual([2024, 4, 22]);
			expect(ymd(helpers.nextWeekday(wednesday, 2))).toEqual([2024, 4, 21]);
			expect(parts(helpers.previousWeekday(wednesday, 1))).toEqual([2024, 4, 13, 9, 30, 0, 0]);
			expect(ymd(helpers.previousWeekday(wednesday, 3))).toEqual([2024, 4, 8]);
			expect(ymd(helpers.previousWeekday(wednesday, 4))).toEqual([2024, 4, 9]);
			expect(ymd(helpers.previousWeekday(new Date(2024, 0, 1), 6))).toEqual([2023, 11, 30]);
		});

		it('validates the weekday', function () {
			expect(function () {
				helpers.nextWeekday(0, 7 as any);
			}).toThrow(new RangeError('nextWeekday: `weekday` must be an integer between 0 and 6, got 7'));
			expect(function () {
				helpers.previousWeekday(0, '1' as any);
			}).toThrow(new TypeError('previousWeekday: `weekday` must be an integer between 0 and 6, got string'));
		});
	});

	describe('round 11: intervalsOverlap', function () {
		/**
		 * A date on 2024-01-01 at `hour`.
		 */
		function at(hour: number): Date {
			return new Date(2024, 0, 1, hour);
		}

		it('treats intervals as half-open by default', function () {
			expect(helpers.intervalsOverlap({ start: at(9), end: at(12) }, { start: at(12), end: at(17) })).toBe(false);
			expect(helpers.intervalsOverlap({ start: at(9), end: at(12) }, { start: at(11), end: at(13) })).toBe(true);
			expect(helpers.intervalsOverlap({ start: at(11), end: at(13) }, { start: at(9), end: at(12) })).toBe(true);
			expect(helpers.intervalsOverlap({ start: at(9), end: at(17) }, { start: at(11), end: at(12) })).toBe(true);
			expect(helpers.intervalsOverlap({ start: at(9), end: at(10) }, { start: at(11), end: at(12) })).toBe(false);
			// An empty interval is an empty set.
			expect(helpers.intervalsOverlap({ start: at(10), end: at(10) }, { start: at(9), end: at(12) })).toBe(false);
			expect(helpers.intervalsOverlap({ start: 5, end: 5 }, { start: 5, end: 5 })).toBe(false);
		});

		it('treats intervals as closed with `inclusive`', function () {
			const options = { inclusive: true };
			expect(helpers.intervalsOverlap({ start: at(9), end: at(12) }, { start: at(12), end: at(17) }, options)).toBe(true);
			expect(helpers.intervalsOverlap({ start: at(10), end: at(10) }, { start: at(9), end: at(12) }, options)).toBe(true);
			expect(helpers.intervalsOverlap({ start: 5, end: 5 }, { start: 5, end: 5 }, options)).toBe(true);
			expect(helpers.intervalsOverlap({ start: at(9), end: at(10) }, { start: at(11), end: at(12) }, options)).toBe(false);
			expect(helpers.intervalsOverlap({ start: at(13), end: at(14) }, { start: at(11), end: at(12) }, options)).toBe(false);
		});

		it('validates the intervals', function () {
			expect(function () {
				helpers.intervalsOverlap({ start: at(12), end: at(9) }, { start: at(9), end: at(12) });
			}).toThrow(new RangeError('intervalsOverlap: `a.start` must not be after `a.end`'));
			expect(function () {
				helpers.intervalsOverlap({ start: at(9), end: at(12) }, { start: 2, end: 1 });
			}).toThrow(new RangeError('intervalsOverlap: `b.start` must not be after `b.end`'));
			expect(function () {
				helpers.intervalsOverlap(null as any, { start: 1, end: 2 });
			}).toThrow(new TypeError('intervalsOverlap: `a` must be an interval object, got null'));
			expect(function () {
				helpers.intervalsOverlap({ start: 1, end: 2 }, 'x' as any);
			}).toThrow(new TypeError('intervalsOverlap: `b` must be an interval object, got string'));
			expect(function () {
				helpers.intervalsOverlap({ start: INVALID, end: 2 }, { start: 1, end: 2 });
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				helpers.intervalsOverlap({ start: '1' as any, end: 2 }, { start: 1, end: 2 });
			}).toThrow(TypeError);
		});
	});

	describe('round 11: parseDate', function () {
		it('parses every formatDate token', function () {
			expect(helpers.parseDate('2024-01-05 14:07:09.003', 'YYYY-MM-DD HH:mm:ss.SSS')).toEqual(new Date(2024, 0, 5, 14, 7, 9, 3));
			expect(helpers.parseDate('5/1/24 2:07 PM', 'D/M/YY h:mm A')).toEqual(new Date(2024, 0, 5, 14, 7));
			expect(helpers.parseDate('12:05 am', 'hh:mm a')).toEqual(new Date(2000, 0, 1, 0, 5));
			expect(helpers.parseDate('12:05 pm', 'hh:mm a')).toEqual(new Date(2000, 0, 1, 12, 5));
			expect(helpers.parseDate('9:5:7', 'H:m:s')).toEqual(new Date(2000, 0, 1, 9, 5, 7));
			expect(helpers.parseDate('23:59:59', 'H:m:s')).toEqual(new Date(2000, 0, 1, 23, 59, 59));
			expect(helpers.parseDate('20240229', 'YYYYMMDD')).toEqual(new Date(2024, 1, 29));
			expect(helpers.parseDate('20240229235959999', 'YYYYMMDDHHmmssSSS')).toEqual(new Date(2024, 1, 29, 23, 59, 59, 999));
			// A literal digit after the year is not part of it, as in what formatDate writes.
			expect(helpers.parseDate('2024001', 'YYYY[0]MM')).toEqual(new Date(2024, 0, 1));
			expect(helpers.parseDate(helpers.formatDate(new Date(2024, 4, 5), 'YYYY[1]MMDD'), 'YYYY[1]MMDD')).toEqual(new Date(2024, 4, 5));
			expect(helpers.parseDate('2024 1', 'YYYY[ 1]')).toEqual(new Date(2024, 0, 1));
			expect(helpers.parseDate("on 05 [x] o'clock", "[on] DD [[x]] [o'clock]")).toEqual(new Date(2000, 0, 5));
			expect(helpers.parseDate('PM', 'A')).toEqual(new Date(2000, 0, 1, 12));
			expect(helpers.parseDate('', '')).toEqual(new Date(2000, 0, 1));
			expect(helpers.parseDate('02-29', 'MM-DD')).toEqual(new Date(2000, 1, 29));
			expect(helpers.parseDate('3 PM', 'h A')).toEqual(new Date(2000, 0, 1, 15));
			expect(helpers.parseDate('15 PM', 'H A')).toEqual(new Date(2000, 0, 1, 15));
		});

		it('reads years of any size and sign', function () {
			const ancient = new Date(2000, 0, 1);
			ancient.setFullYear(-1, 5, 15);
			expect(helpers.parseDate('-0001-06-15', 'YYYY-MM-DD')).toEqual(ancient);
			const yearZero = new Date(2000, 0, 1);
			yearZero.setFullYear(0);
			expect(helpers.parseDate('0000', 'YYYY')).toEqual(yearZero);
			expect(helpers.parseDate('123456-01', 'YYYY-MM')?.getFullYear()).toBe(123456);
			expect(helpers.parseDate('12345 AD', 'YYYY [AD]')?.getFullYear()).toBe(12345);
			expect(helpers.parseDate('2024 AM', 'YYYYA')).toBeUndefined();
			expect(helpers.parseDate('2024AM', 'YYYYA')).toEqual(new Date(2024, 0, 1));
			expect(helpers.parseDate('999999999-01', 'YYYY-MM')).toBeUndefined();
			expect(helpers.parseDate(`${'9'.repeat(400)}`, 'YYYY')).toBeUndefined();
		});

		it('rejects input that formatDate would not produce', function () {
			const rejected: Array<[string, string]> = [
				['2023-02-29', 'YYYY-MM-DD'],
				['2024-13-01', 'YYYY-MM-DD'],
				['2024-00-10', 'YYYY-MM-DD'],
				['2024-01-32', 'YYYY-MM-DD'],
				['2024-1-5', 'YYYY-MM-DD'],
				['2024-01-05 ', 'YYYY-MM-DD'],
				['2024-01-0', 'YYYY-MM-DD'],
				['2024/01/05', 'YYYY-MM-DD'],
				['24:00', 'HH:mm'],
				['12:60', 'HH:mm'],
				['05', 'D'],
				['5', 'DD'],
				['00:00 AM', 'hh:mm A'],
				['13:00 PM', 'hh:mm A'],
				['10:00 pm', 'hh:mm A'],
				['10:00 XM', 'hh:mm A'],
				['10:00 P', 'hh:mm A'],
				['14:00 AM', 'HH:mm A'],
				['-', 'YYYY'],
				['-024', 'YYYY'],
				['024', 'YYYY'],
				['2024', 'YY'],
				['abc', 'YYYY'],
				['', 'YYYY'],
				['at', '[on]'],
				['2024 25', 'YYYY YY']
			];
			for (const [value, pattern] of rejected) expect([value, pattern, helpers.parseDate(value, pattern)]).toEqual([value, pattern, undefined]);
			expect(helpers.parseDate('2099 99', 'YYYY YY')).toEqual(new Date(2099, 0, 1));
			expect(helpers.parseDate('1999 99', 'YYYY YY')).toEqual(new Date(1999, 0, 1));
			expect(helpers.parseDate(20240105 as any, 'YYYYMMDD')).toBeUndefined();
			expect(helpers.parseDate(null as any, 'YYYY')).toBeUndefined();
		});

		it('rejects local times skipped by a DST change and takes the first of a repeated time', function () {
			withTimeZone('America/New_York', function () {
				expect(helpers.parseDate('2024-03-10 02:30', 'YYYY-MM-DD HH:mm')).toBeUndefined();
				expect(helpers.parseDate('2024-11-03 01:30', 'YYYY-MM-DD HH:mm')?.toISOString()).toBe('2024-11-03T05:30:00.000Z');
			});
		});

		it('throws on a non-string pattern', function () {
			expect(function () {
				helpers.parseDate('2024', 5 as any);
			}).toThrow(new TypeError('parseDate: `pattern` must be a string, got number'));
		});

		it('parses in linear time', function () {
			const start = performance.now();
			expect(helpers.parseDate('1'.repeat(200_000), 'D'.repeat(100_000))).toBeUndefined();
			expect(helpers.parseDate('1'.repeat(200_000), 'YYYY')).toBeUndefined();
			expect(helpers.parseDate(`${'['.repeat(100_000)}5`, `${'['.repeat(100_000)}D`)).toEqual(new Date(2000, 0, 5));
			expect(performance.now() - start).toBeLessThan(2000);
		});
	});

	describe('round 11: getDayOfYear / isTomorrow / isYesterday / isSameWeek / isSameQuarter', function () {
		it('getDayOfYear', function () {
			expect(helpers.getDayOfYear(new Date(2024, 0, 1, 23))).toBe(1);
			expect(helpers.getDayOfYear(new Date(2024, 2, 1))).toBe(61);
			expect(helpers.getDayOfYear(new Date(2023, 2, 1))).toBe(60);
			expect(helpers.getDayOfYear(new Date(2024, 11, 31))).toBe(366);
			expect(helpers.getDayOfYear(new Date(2023, 11, 31, 23, 59))).toBe(365);
		});

		it('isTomorrow / isYesterday compare local calendar days', function () {
			const now = new Date(2024, 0, 1, 8);
			expect(helpers.isTomorrow(new Date(2024, 0, 2, 23, 59), now)).toBe(true);
			expect(helpers.isTomorrow(new Date(2024, 0, 3), now)).toBe(false);
			expect(helpers.isTomorrow(new Date(2024, 0, 1, 23), now)).toBe(false);
			expect(helpers.isYesterday(new Date(2023, 11, 31, 0, 1), now)).toBe(true);
			expect(helpers.isYesterday(new Date(2024, 0, 1), now)).toBe(false);
			expect(helpers.isTomorrow(Date.now() + 86_400_000 * 3)).toBe(false);
			expect(helpers.isYesterday(helpers.addDays(new Date(), -1))).toBe(true);
			expect(helpers.isTomorrow(helpers.addDays(new Date(), 1))).toBe(true);
		});

		it('isSameWeek honours weekStartsOn', function () {
			expect(helpers.isSameWeek(new Date(2024, 4, 12), new Date(2024, 4, 18, 23))).toBe(true);
			expect(helpers.isSameWeek(new Date(2024, 4, 12), new Date(2024, 4, 18), 1)).toBe(false);
			expect(helpers.isSameWeek(new Date(2024, 4, 13), new Date(2024, 4, 19), 1)).toBe(true);
			expect(helpers.isSameWeek(new Date(2024, 11, 30), new Date(2025, 0, 4))).toBe(true);
			expect(helpers.isSameWeek(new Date(2024, 4, 12), new Date(2024, 4, 11))).toBe(false);
			expect(function () {
				helpers.isSameWeek(0, 0, -1 as any);
			}).toThrow(new RangeError('isSameWeek: `weekStartsOn` must be an integer between 0 and 6, got -1'));
		});

		it('isSameQuarter', function () {
			expect(helpers.isSameQuarter(new Date(2024, 0, 1), new Date(2024, 2, 31))).toBe(true);
			expect(helpers.isSameQuarter(new Date(2024, 2, 31), new Date(2024, 3, 1))).toBe(false);
			expect(helpers.isSameQuarter(new Date(2024, 0, 1), new Date(2023, 0, 1))).toBe(false);
		});
	});

	describe('skipped calendar days and repeated fractions of an hour', function () {
		it('keeps the day when the repeated hour after midnight belongs to the new day', function () {
			withTimeZone('America/Havana', function () {
				// On 2024-11-03 the clock went back from 01:00 to 00:00: midnight happened twice, both times on November 3rd.
				expect(helpers.toISOStringLocal(helpers.endOfDay(new Date('2024-11-02T12:00-04:00')))).toBe('2024-11-02T23:59:59.999-04:00');
			});
		});

		it('measures and enumerates up to the edges of the representable range', function () {
			withTimeZone('UTC', function () {
				const max = 8.64e15;
				const min = -8.64e15;
				expect(helpers.diffInMonths(max, max - 20 * 864e5)).toBe(0);
				expect(helpers.diffInWeeks(max, max - 6.9 * 864e5)).toBe(0);
				expect(helpers.getRelativeTime(max, max - 20 * 864e5)).toBe('in 2 weeks');
				expect(helpers.intervalToDuration(max - 3_600_000, max).hours).toBe(1);
				expect(helpers.intervalToDuration(min + 20 * 864e5, min).days).toBe(-20);
				expect(helpers.eachDayOfInterval(max, max)).toHaveLength(1);
				const pattern = 'YYYY-MM-DD HH:mm:ss.SSS';
				expect(helpers.parseDate(helpers.formatDate(max, pattern), pattern)?.getTime()).toBe(max);
			});
			withTimeZone('America/Los_Angeles', function () {
				const pattern = 'YYYY-MM-DD HH:mm:ss.SSS';
				expect(helpers.parseDate(helpers.formatDate(-8.64e15, pattern), pattern)?.getTime()).toBe(-8.64e15);
			});
		});

		it('endOfWeek ends the week whose first day was skipped on its last day', function () {
			withTimeZone('Pacific/Apia', function () {
				// With weeks starting on Friday, the week of Saturday 2011-12-31 began on the skipped Friday 30th.
				const saturday = new Date(2011, 11, 31, 12);
				const end = helpers.endOfWeek(saturday, 5);
				expect(helpers.toISOStringLocal(end)).toBe('2012-01-05T23:59:59.999+14:00');
				expect(helpers.isSameWeek(end, saturday, 5)).toBe(true);
			});
		});

		it('ends a day after its last instant when the clock was set back just after midnight', function () {
			withTimeZone('America/St_Johns', function () {
				// On 2010-11-07 at 00:01 the clock went back to 23:01 of November 6th: midnight happened twice.
				const late = new Date('2010-11-07T03:00:00Z');
				expect(helpers.toISOStringLocal(late)).toBe('2010-11-06T23:30:00.000-03:30');
				expect(helpers.toISOStringLocal(helpers.endOfDay(late))).toBe('2010-11-06T23:59:59.999-03:30');
				expect(helpers.toISOStringLocal(helpers.endOfMonth(new Date('2009-11-01T03:00:00Z')))).toBe('2009-10-31T23:59:59.999-03:30');
				expect(helpers.toISOStringLocal(helpers.endOfDay(new Date(2010, 5, 1)))).toBe('2010-06-01T23:59:59.999-02:30');
			});
			withTimeZone('America/New_York', function () {
				// The clock goes back at 02:00, not just after midnight: the day before still ends at its only midnight.
				expect(helpers.toISOStringLocal(helpers.endOfDay(new Date(2024, 10, 2, 12)))).toBe('2024-11-02T23:59:59.999-04:00');
			});
		});

		it('endOfYear ends on the last local day of the year when December 31st was skipped', function () {
			withTimeZone('Pacific/Kiritimati', function () {
				// Kiritimati skipped December 31st, 1994 (UTC-10 to UTC+14).
				expect(helpers.endOfYear(new Date(1994, 5, 1, 12)).getTime()).toBe(helpers.endOfMonth(new Date(1994, 11, 15, 12)).getTime());
				expect(helpers.toISOStringLocal(helpers.endOfYear(new Date(1994, 5, 1, 12)))).toBe('1994-12-30T23:59:59.999-10:00');
			});
		});

		it('count the complete units that end in a day that came back after the clocks were set back across midnight', function () {
			withTimeZone('America/St_Johns', function () {
				// 2009-11-01 00:01 NDT became 2009-10-31 23:01 NST: the first minute of November came before the second 23:31 of October 31st.
				const end = new Date('2009-11-01T03:01:00.000Z');
				expect(helpers.toISOStringLocal(end)).toBe('2009-10-31T23:31:00.000-03:30');
				expect(helpers.addWeeks(new Date(2009, 9, 25, 0, 0, 30), 1).getTime()).toBeLessThan(end.getTime());
				expect(helpers.diffInWeeks(end, new Date(2009, 9, 25, 0, 0, 30))).toBe(1);
				expect(helpers.diffInMonths(end, new Date(2009, 9, 1, 0, 0, 30))).toBe(1);
				expect(helpers.diffInYears(end, new Date(2008, 10, 1, 0, 0, 30))).toBe(1);
				expect(helpers.diffInWeeks(new Date(2009, 9, 25, 0, 0, 30), end)).toBe(-1);
				expect(helpers.intervalToDuration(new Date(2008, 10, 1, 0, 0, 30), end)).toEqual({
					years: 1,
					months: 0,
					days: 0,
					hours: 0,
					minutes: 30,
					seconds: 30,
					milliseconds: 0
				});
				expect(helpers.intervalToDuration(new Date(2009, 9, 25, 0, 0, 30), end)).toMatchObject({ months: 0, days: 7, hours: 0, minutes: 30 });
				// Backwards, to the first minute of November: 30 minutes and 30 seconds earlier.
				const first = new Date(2009, 10, 1, 0, 0, 30);
				expect(helpers.intervalToDuration(end, first)).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: -30, seconds: -30, milliseconds: 0 });
				// The later date is 30 minutes earlier on the timeline, though in the next month: no complete unit either way.
				expect(helpers.diffInMonths(first, end)).toBe(0);
				expect(helpers.diffInWeeks(first, end)).toBe(0);
				expect(helpers.diffInMonths(end, first)).toBe(0);
				// In the last 2 minutes of a day, the check is made whatever the offsets (they hide changes shorter than that).
				expect(helpers.diffInWeeks(new Date(2009, 6, 8, 23, 59), new Date(2009, 6, 1, 23, 59, 30))).toBe(0);
			});
			withTimeZone('America/Sitka', function () {
				// 1867-10-19 15:30 (+14:58:47) became 1867-10-18 15:30 (-09:01:13) when Alaska was sold: October 18th came back for a day.
				const end = new Date(Date.UTC(1867, 9, 19, 2, 31, 13));
				const start = new Date(1867, 9, 12, 10);
				expect(helpers.diffInWeeks(end, start)).toBe(1);
				expect(helpers.intervalToDuration(start, end)).toMatchObject({ months: 0, days: 7, hours: 7, minutes: 30 });
			});
		});

		it('business days and weekdays skip a day that does not exist', function () {
			withTimeZone('Pacific/Apia', function () {
				// Samoa skipped Friday, December 30th, 2011.
				const thursday = new Date(2011, 11, 29, 10);
				expect(parts(helpers.addBusinessDays(thursday, 1))).toEqual([2012, 0, 2, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2011, 11, 31, 10), -1))).toEqual([2011, 11, 29, 10, 0, 0, 0]);
				expect(parts(helpers.nextWeekday(thursday, 5))).toEqual([2012, 0, 6, 10, 0, 0, 0]);
				expect(parts(helpers.previousWeekday(new Date(2012, 0, 1, 10), 5))).toEqual([2011, 11, 23, 10, 0, 0, 0]);
			});
		});

		it('a skipped calendar day is not a business day, for addBusinessDays and diffInBusinessDays alike', function () {
			withTimeZone('Pacific/Apia', function () {
				// Saturday, December 31st, 2011 at 00:00 (+14:00): the clock went from Thursday 29th 23:59:59 (-10:00) straight to it.
				const saturday = new Date('2011-12-30T10:00:00.000Z');
				const thursday = new Date(2011, 11, 29, 10);
				expect(parts(saturday)).toEqual([2011, 11, 31, 0, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(saturday, -1))).toEqual([2011, 11, 29, 0, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(saturday, -2))).toEqual([2011, 11, 28, 0, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(saturday, -3))).toEqual([2011, 11, 27, 0, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(saturday, 1))).toEqual([2012, 0, 2, 0, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 2, 10), -1))).toEqual([2011, 11, 29, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 2, 10), -2))).toEqual([2011, 11, 28, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2011, 11, 28, 10), 2))).toEqual([2012, 0, 2, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2011, 11, 20, 10), 10))).toEqual([2012, 0, 4, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 4, 10), -10))).toEqual([2011, 11, 20, 10, 0, 0, 0]);
				// Holidays and other weekends combine with the skipped day.
				const options: helpers.BusinessDayOptions = { holidays: [new Date(2011, 11, 29)], weekend: [0] };
				expect(parts(helpers.addBusinessDays(new Date(2011, 11, 28, 10), 1, options))).toEqual([2011, 11, 31, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(saturday, -1, options))).toEqual([2011, 11, 28, 0, 0, 0, 0]);
				expect(helpers.diffInBusinessDays(saturday, new Date(2011, 11, 28), options)).toBe(1);
				// A business day right after the skipped one is not skipped over going back.
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 2, 10), -1, { weekend: [0] }))).toEqual([2011, 11, 31, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 2, 10), -2, { weekend: [0] }))).toEqual([2011, 11, 29, 10, 0, 0, 0]);
				expect(parts(helpers.addBusinessDays(new Date(2012, 0, 1, 10), -1, { weekend: [0] }))).toEqual([2011, 11, 31, 10, 0, 0, 0]);
				// Friday the 30th is not counted.
				expect(helpers.diffInBusinessDays(saturday, thursday)).toBe(0);
				expect(helpers.diffInBusinessDays(thursday, saturday)).toBe(0);
				expect(helpers.diffInBusinessDays(new Date(2012, 0, 2), thursday)).toBe(1);
				expect(helpers.diffInBusinessDays(thursday, new Date(2012, 0, 2))).toBe(-1);
				expect(helpers.diffInBusinessDays(new Date(2012, 0, 31), new Date(2011, 11, 1))).toBe(42);
				expect(helpers.diffInBusinessDays(new Date(2012, 0, 31), new Date(2011, 11, 1), { weekend: [0, 5, 6] })).toBe(34);
				// Far from the skipped day, nothing changes.
				expect(helpers.diffInBusinessDays(new Date(2011, 11, 29), new Date(2011, 11, 1))).toBe(20);
				expect(helpers.isBusinessDay(saturday)).toBe(false);
				expect(helpers.isBusinessDay(thursday)).toBe(true);
			});
			// Looking for a skipped day costs two offset reads when there is none (no bisection).
			const reads = jest.spyOn(Date.prototype, 'getTimezoneOffset');
			try {
				helpers.diffInBusinessDays(new Date(2024, 11, 31), new Date(2024, 0, 1));
				expect(reads).toHaveBeenCalledTimes(2);
			} finally {
				reads.mockRestore();
			}
			withTimeZone('Pacific/Kiritimati', function () {
				// Kiritimati skipped Saturday, December 31st, 1994: no business day was lost.
				expect(parts(helpers.addBusinessDays(new Date(1994, 11, 30, 9), 1))).toEqual([1995, 0, 2, 9, 0, 0, 0]);
				expect(helpers.diffInBusinessDays(new Date(1995, 0, 2), new Date(1994, 11, 30))).toBe(1);
			});
		});

		it('eachDayOfInterval lists each existing local day once', function () {
			withTimeZone('Pacific/Apia', function () {
				const days = helpers.eachDayOfInterval(new Date(2011, 11, 29), new Date(2012, 0, 1)).map(function (date) {
					return parts(date).slice(0, 3);
				});
				expect(days).toEqual([
					[2011, 11, 29],
					[2011, 11, 31],
					[2012, 0, 1]
				]);
			});
		});

		it('parseISODate rejects a skipped calendar day, like parseDate', function () {
			withTimeZone('Pacific/Apia', function () {
				expect(helpers.parseISODate('2011-12-30')).toBeUndefined();
				expect(helpers.parseDate('2011-12-30', 'YYYY-MM-DD')).toBeUndefined();
				expect(parts(helpers.parseISODate('2011-12-31') as Date)).toEqual([2011, 11, 31, 0, 0, 0, 0]);
			});
		});

		it('endOfHour ends where the next hour starts, past a repeated half hour', function () {
			withTimeZone('Australia/Lord_Howe', function () {
				// 2024-04-07 02:00 (+11:00) became 01:30 (+10:30): the wall clock shows 01:30-02:00 twice.
				const early = new Date('2024-04-06T14:02:00Z');
				const late = new Date('2024-04-06T15:15:00Z');
				expect(helpers.startOfHour(early).getTime()).toBe(helpers.startOfHour(late).getTime());
				expect(helpers.toISOStringLocal(helpers.endOfHour(early))).toBe('2024-04-07T01:59:59.999+10:30');
				expect(helpers.endOfHour(late).getTime()).toBe(helpers.endOfHour(early).getTime());
			});
		});
	});

	describe('regressions', function () {
		it('isLeapYear accepts Dates from another realm', function () {
			expect(helpers.isLeapYear(vm.runInNewContext('new Date(2024, 5, 1)'))).toBe(true);
		});

		it('parseDate reads YYYY as 4 digits when an empty literal separates it from a number', function () {
			const pattern = 'YYYY[]MMDD[T]HHmmss.SSS';
			const date = new Date(2024, 1, 29, 13, 7, 9, 3);
			expect(helpers.parseDate(helpers.formatDate(date, pattern), pattern)?.getTime()).toBe(date.getTime());
		});

		it('isValidDate does not narrow an invalid Date away from Date', function () {
			/**
			 * Returns the time of a date, NaN included.
			 */
			function timeOf(date: Date): number {
				if (!helpers.isValidDate(date)) return date.getTime();
				return date.getTime();
			}
			/**
			 * Describes a date or a string.
			 */
			function describeValue(value: Date | string): string {
				if (!helpers.isValidDate(value)) return typeof value === 'string' ? value : 'invalid date';
				const valid: helpers.ValidDate = value;
				return valid.toISOString();
			}
			expect(timeOf(new Date(NaN))).toBeNaN();
			expect(describeValue(new Date(NaN))).toBe('invalid date');
			expect(describeValue('text')).toBe('text');
		});
	});
});

/**
 * Writes an instant as an RFC 3339 timestamp on the wall clock of a time zone.
 */
function inZone(date: Date | number, timeZone: string): string {
	return helpers.formatInTimeZone(date, timeZone, 'YYYY-MM-DD[T]HH:mm:ss.SSSZ');
}

describe('Time zones', function () {
	describe('isValidTimeZone', function () {
		it('accepts IANA names known to Intl and UTC offsets', function () {
			['UTC', 'utc', 'America/New_York', 'america/new_york', 'US/Eastern', 'Etc/GMT+12', 'Asia/Kathmandu'].forEach(function (zone) {
				expect(helpers.isValidTimeZone(zone)).toBe(true);
			});
			['+05:30', '-0800', '+05', '-00:00', '+23:59', '-23'].forEach(function (zone) {
				expect(helpers.isValidTimeZone(zone)).toBe(true);
			});
		});

		it('rejects anything else without throwing', function () {
			['Mars/Olympus_Mons', '', ' UTC', 'UTC ', '+5:30', '+24:00', '+05:60', '+05:30:00', '+05:', '05:30', '−05:00', 'x'.repeat(5000)].forEach(function (zone) {
				expect(helpers.isValidTimeZone(zone)).toBe(false);
			});
			[42, null, undefined, {}, ['UTC'], new String('UTC')].forEach(function (zone) {
				expect(helpers.isValidTimeZone(zone)).toBe(false);
			});
		});
	});

	describe('getTimeZoneOffset', function () {
		it('returns minutes east of UTC at the given instant', function () {
			expect(helpers.getTimeZoneOffset('America/New_York', Date.UTC(2024, 0, 15))).toBe(-300);
			expect(helpers.getTimeZoneOffset('America/New_York', new Date(Date.UTC(2024, 6, 15)))).toBe(-240);
			expect(helpers.getTimeZoneOffset('Asia/Kathmandu', 0)).toBe(330);
			expect(helpers.getTimeZoneOffset('Asia/Kathmandu', Date.UTC(2024, 0, 1))).toBe(345);
			expect(helpers.getTimeZoneOffset('Australia/Lord_Howe', Date.UTC(2024, 6, 1))).toBe(630);
			expect(helpers.getTimeZoneOffset('Australia/Lord_Howe', Date.UTC(2024, 0, 1))).toBe(660);
			expect(helpers.getTimeZoneOffset('Pacific/Kiritimati', Date.UTC(2024, 0, 1))).toBe(840);
			expect(helpers.getTimeZoneOffset('UTC', Date.UTC(2024, 0, 1))).toBe(0);
		});

		it('switches exactly at the transition instant', function () {
			// New York sprang forward at 2024-03-10 07:00 UTC.
			expect(helpers.getTimeZoneOffset('America/New_York', Date.UTC(2024, 2, 10, 7) - 1)).toBe(-300);
			expect(helpers.getTimeZoneOffset('America/New_York', Date.UTC(2024, 2, 10, 7))).toBe(-240);
		});

		it('defaults to now', function () {
			expect(helpers.getTimeZoneOffset('Asia/Kolkata')).toBe(330);
			expect(helpers.getTimeZoneOffset('-08:00')).toBe(-480);
		});

		it('returns local mean time offsets exactly, as fractional minutes', function () {
			const paris = helpers.getTimeZoneOffset('Europe/Paris', Date.UTC(1900, 0, 1));
			expect(paris).toBe(561 / 60);
			expect(Math.round(paris * 60_000)).toBe(561_000);
			expect(Math.round(helpers.getTimeZoneOffset('America/New_York', -8.64e15) * 60_000)).toBe(-(4 * 3600 + 56 * 60 + 2) * 1000);
		});

		it('parses fixed offsets, never returning -0', function () {
			expect(helpers.getTimeZoneOffset('+05:30', 0)).toBe(330);
			expect(helpers.getTimeZoneOffset('+0530', 0)).toBe(330);
			expect(helpers.getTimeZoneOffset('-03', 0)).toBe(-180);
			expect(Object.is(helpers.getTimeZoneOffset('-00:00', 0), 0)).toBe(true);
			expect(Object.is(helpers.getTimeZoneOffset('-00', 0), 0)).toBe(true);
		});

		it('works at the ends of the Date range and with Dates from another realm', function () {
			expect(helpers.getTimeZoneOffset('Pacific/Kiritimati', 8.64e15)).toBe(840);
			expect(helpers.getTimeZoneOffset('America/New_York', vm.runInNewContext('new Date(Date.UTC(2024, 0, 1))'))).toBe(-300);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.getTimeZoneOffset(5 as any, 0);
			}).toThrow(new TypeError('getTimeZoneOffset: `timeZone` must be a string, got number'));
			expect(function () {
				helpers.getTimeZoneOffset('Mars/Base', 0);
			}).toThrow(new RangeError('getTimeZoneOffset: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got "Mars/Base"'));
			expect(function () {
				helpers.getTimeZoneOffset('x'.repeat(60), 0);
			}).toThrow(new RangeError(`getTimeZoneOffset: \`timeZone\` must be an IANA time zone or a UTC offset (±HH:MM), got "${'x'.repeat(50)}…"`));
			expect(function () {
				helpers.getTimeZoneOffset('+25:00', 0);
			}).toThrow(RangeError);
			expect(function () {
				helpers.getTimeZoneOffset('UTC', '2024-01-01' as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.getTimeZoneOffset('UTC', INVALID);
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				helpers.getTimeZoneOffset('UTC', 8.64e15 + 1);
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('getZonedParts', function () {
		it('returns the wall-clock fields, month from 1 and weekday from 0', function () {
			expect(helpers.getZonedParts(Date.UTC(2024, 2, 10, 7, 30, 15, 250), 'America/New_York')).toEqual({
				year: 2024,
				month: 3,
				day: 10,
				hour: 3,
				minute: 30,
				second: 15,
				millisecond: 250,
				weekday: 0,
				offset: -240
			});
			expect(helpers.getZonedParts(Date.UTC(2024, 11, 31, 20), 'Asia/Tokyo')).toMatchObject({ year: 2025, month: 1, day: 1, hour: 5, weekday: 3 });
			expect(helpers.getZonedParts(Date.UTC(2024, 0, 1, 0, 30), 'America/Los_Angeles')).toMatchObject({ year: 2023, month: 12, day: 31, hour: 16 });
			expect(helpers.getZonedParts(Date.UTC(2024, 1, 29, 23), '+05:45')).toMatchObject({ month: 3, day: 1, hour: 4, minute: 45, offset: 345 });
		});

		it('keeps the seconds of local mean time offsets', function () {
			expect(helpers.getZonedParts(Date.UTC(1900, 0, 1), 'Europe/Paris')).toMatchObject({ hour: 0, minute: 9, second: 21, offset: 561 / 60 });
		});

		it('tells the two occurrences of a repeated hour apart by their offset', function () {
			const first = helpers.getZonedParts(Date.UTC(2024, 10, 3, 5, 30), 'America/New_York');
			const second = helpers.getZonedParts(Date.UTC(2024, 10, 3, 6, 30), 'America/New_York');
			expect({ ...first, offset: 0 }).toEqual({ ...second, offset: 0 });
			expect([first.offset, second.offset]).toEqual([-240, -300]);
		});

		it('handles years before 1, after 9999 and the ends of the Date range', function () {
			expect(helpers.getZonedParts(new Date('0000-03-01T00:30:00Z'), 'America/New_York')).toMatchObject({ year: 0, month: 2, day: 29 });
			expect(helpers.getZonedParts(new Date('-000044-03-15T12:00:00Z'), 'UTC')).toMatchObject({ year: -44, month: 3, day: 15, weekday: 4 });
			expect(helpers.getZonedParts(new Date('+012345-06-07T08:09:10Z'), 'Asia/Kolkata')).toMatchObject({ year: 12345, hour: 13, minute: 39 });
			expect(helpers.getZonedParts(8.64e15, 'Pacific/Kiritimati')).toEqual({
				year: 275760,
				month: 9,
				day: 13,
				hour: 14,
				minute: 0,
				second: 0,
				millisecond: 0,
				weekday: 6,
				offset: 840
			});
			// Paris's local mean time (+00:09:21), unchanged across tzdata releases (Manila's changed in 2024b).
			expect(helpers.getZonedParts(-8.64e15, 'Europe/Paris')).toMatchObject({ year: -271821, month: 4, day: 20, hour: 0, minute: 9, second: 21, weekday: 2 });
			expect(helpers.getZonedParts(-8.64e15, '+14:00')).toMatchObject({ year: -271821, month: 4, day: 20, hour: 14 });
		});

		it('does not depend on the runtime time zone', function () {
			const instants = [Date.UTC(2024, 2, 10, 7, 30), Date.UTC(2011, 11, 30, 12), Date.UTC(1900, 0, 1), -8.64e15];
			const reference = instants.map(function (time) {
				return helpers.getZonedParts(time, 'America/Havana');
			});
			['UTC', 'Pacific/Apia', 'Australia/Lord_Howe', 'America/Havana'].forEach(function (zone) {
				withTimeZone(zone, function () {
					expect(
						instants.map(function (time) {
							return helpers.getZonedParts(time, 'America/Havana');
						})
					).toEqual(reference);
				});
			});
		});

		it('accepts Dates from another realm and returns a new object every time', function () {
			const foreign = vm.runInNewContext('new Date(Date.UTC(2024, 0, 1, 12))');
			expect(helpers.getZonedParts(foreign, 'UTC').hour).toBe(12);
			expect(helpers.getZonedParts(0, 'UTC')).not.toBe(helpers.getZonedParts(0, 'UTC'));
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.getZonedParts(0, null as any);
			}).toThrow(new TypeError('getZonedParts: `timeZone` must be a string, got null'));
			expect(function () {
				helpers.getZonedParts(0, 'Nowhere');
			}).toThrow(new RangeError('getZonedParts: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got "Nowhere"'));
			expect(function () {
				helpers.getZonedParts({} as any, 'UTC');
			}).toThrow(TypeError);
			expect(function () {
				helpers.getZonedParts(NaN, 'UTC');
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('fromZonedTime', function () {
		const NY = 'America/New_York';

		it('returns the instant of a wall-clock time', function () {
			expect(helpers.fromZonedTime({ year: 2024, month: 1, day: 15, hour: 9 }, NY).getTime()).toBe(Date.UTC(2024, 0, 15, 14));
			expect(helpers.fromZonedTime({ year: 2024, month: 7, day: 4, hour: 12, minute: 30, second: 15, millisecond: 999 }, NY).getTime()).toBe(
				Date.UTC(2024, 6, 4, 16, 30, 15, 999)
			);
			expect(helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, 'Asia/Kathmandu').getTime()).toBe(Date.UTC(2023, 11, 31, 18, 15));
			expect(helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, '-03:30').getTime()).toBe(Date.UTC(2024, 0, 1, 3, 30));
		});

		it('resolves a skipped time like Temporal', function () {
			const skipped = { year: 2024, month: 3, day: 10, hour: 2, minute: 30 };
			expect(inZone(helpers.fromZonedTime(skipped, NY), NY)).toBe('2024-03-10T03:30:00.000-04:00');
			expect(inZone(helpers.fromZonedTime(skipped, NY, { disambiguation: 'compatible' }), NY)).toBe('2024-03-10T03:30:00.000-04:00');
			expect(inZone(helpers.fromZonedTime(skipped, NY, { disambiguation: 'later' }), NY)).toBe('2024-03-10T03:30:00.000-04:00');
			expect(inZone(helpers.fromZonedTime(skipped, NY, { disambiguation: 'earlier' }), NY)).toBe('2024-03-10T01:30:00.000-05:00');
			expect(function () {
				helpers.fromZonedTime(skipped, NY, { disambiguation: 'reject' });
			}).toThrow(
				new RangeError('fromZonedTime: 2024-03-10T02:30:00.000 does not exist in America/New_York (the clocks were set forward); use another `disambiguation`')
			);
		});

		it('resolves a repeated time like Temporal', function () {
			const repeated = { year: 2024, month: 11, day: 3, hour: 1, minute: 30 };
			expect(helpers.fromZonedTime(repeated, NY).getTime()).toBe(Date.UTC(2024, 10, 3, 5, 30));
			expect(helpers.fromZonedTime(repeated, NY, { disambiguation: 'earlier' }).getTime()).toBe(Date.UTC(2024, 10, 3, 5, 30));
			expect(helpers.fromZonedTime(repeated, NY, { disambiguation: 'later' }).getTime()).toBe(Date.UTC(2024, 10, 3, 6, 30));
			expect(function () {
				helpers.fromZonedTime(repeated, NY, { disambiguation: 'reject' });
			}).toThrow(new RangeError('fromZonedTime: 2024-11-03T01:30:00.000 occurs twice in America/New_York (the clocks were set back); use another `disambiguation`'));
			expect(helpers.fromZonedTime({ year: 2024, month: 11, day: 3, hour: 2 }, NY, { disambiguation: 'reject' }).getTime()).toBe(Date.UTC(2024, 10, 3, 7));
		});

		it('picks the occurrence with the given offset, whatever the disambiguation', function () {
			const repeated = { year: 2024, month: 11, day: 3, hour: 1, minute: 30 };
			expect(helpers.fromZonedTime({ ...repeated, offset: -300 }, NY).getTime()).toBe(Date.UTC(2024, 10, 3, 6, 30));
			expect(helpers.fromZonedTime({ ...repeated, offset: -300 }, NY, { disambiguation: 'reject' }).getTime()).toBe(Date.UTC(2024, 10, 3, 6, 30));
			expect(helpers.fromZonedTime({ ...repeated, offset: -240 }, NY, { disambiguation: 'later' }).getTime()).toBe(Date.UTC(2024, 10, 3, 5, 30));
			// An offset that no occurrence has is ignored.
			expect(helpers.fromZonedTime({ ...repeated, offset: 60 }, NY, { disambiguation: 'later' }).getTime()).toBe(Date.UTC(2024, 10, 3, 6, 30));
			expect(helpers.fromZonedTime({ year: 2024, month: 1, day: 15, hour: 9, offset: -240 }, NY).getTime()).toBe(Date.UTC(2024, 0, 15, 14));
			expect(function () {
				helpers.fromZonedTime({ year: 2024, month: 3, day: 10, hour: 2, minute: 30, offset: -300 }, NY, { disambiguation: 'reject' });
			}).toThrow(RangeError);
		});

		it('turns getZonedParts back into the same instant, repeated hours and local mean time included', function () {
			[
				[Date.UTC(2024, 10, 3, 5, 30), NY],
				[Date.UTC(2024, 10, 3, 6, 30), NY],
				[Date.parse('2010-11-07T03:00:00Z'), 'America/St_Johns'],
				[Date.parse('2024-04-06T15:15:00Z'), 'Australia/Lord_Howe'],
				[Date.UTC(1900, 0, 1, 0, 0, 0, 7), 'Europe/Paris'],
				[-8.64e15, 'America/New_York'],
				[8.64e15, 'Pacific/Kiritimati'],
				[-8.64e15, '+14:00']
			].forEach(function ([time, zone]) {
				expect(helpers.fromZonedTime(helpers.getZonedParts(time as number, zone as string), zone as string).getTime()).toBe(time);
			});
		});

		it('handles a 30-minute DST shift (Lord Howe Island)', function () {
			const zone = 'Australia/Lord_Howe';
			expect(inZone(helpers.fromZonedTime({ year: 2024, month: 10, day: 6, hour: 2, minute: 15 }, zone), zone)).toBe('2024-10-06T02:45:00.000+11:00');
			expect(inZone(helpers.fromZonedTime({ year: 2024, month: 4, day: 7, hour: 1, minute: 45 }, zone), zone)).toBe('2024-04-07T01:45:00.000+11:00');
			expect(inZone(helpers.fromZonedTime({ year: 2024, month: 4, day: 7, hour: 1, minute: 45 }, zone, { disambiguation: 'later' }), zone)).toBe(
				'2024-04-07T01:45:00.000+10:30'
			);
		});

		it('moves a time of a skipped calendar day to the next day (Samoa, 2011-12-30)', function () {
			const zone = 'Pacific/Apia';
			const friday = { year: 2011, month: 12, day: 30, hour: 12 };
			expect(inZone(helpers.fromZonedTime(friday, zone), zone)).toBe('2011-12-31T12:00:00.000+14:00');
			expect(inZone(helpers.fromZonedTime(friday, zone, { disambiguation: 'earlier' }), zone)).toBe('2011-12-29T12:00:00.000-10:00');
		});

		it('does not remap years 0-99 and handles negative years', function () {
			expect(helpers.fromZonedTime({ year: 99, month: 1, day: 1 }, 'UTC').getUTCFullYear()).toBe(99);
			expect(helpers.fromZonedTime({ year: 0, month: 2, day: 29 }, 'UTC').toISOString()).toBe('0000-02-29T00:00:00.000Z');
			expect(helpers.fromZonedTime({ year: -44, month: 3, day: 15, hour: 12 }, 'UTC').toISOString()).toBe('-000044-03-15T12:00:00.000Z');
		});

		it('reaches the ends of the Date range exactly and rejects anything past them', function () {
			expect(helpers.fromZonedTime({ year: 275760, month: 9, day: 13 }, 'UTC').getTime()).toBe(8.64e15);
			expect(helpers.fromZonedTime({ year: 275760, month: 9, day: 12, hour: 20 }, NY).getTime()).toBe(8.64e15);
			expect(helpers.fromZonedTime({ year: -271821, month: 4, day: 20 }, 'UTC').getTime()).toBe(-8.64e15);
			expect(helpers.fromZonedTime({ year: -271821, month: 4, day: 20, hour: 14 }, '+14:00').getTime()).toBe(-8.64e15);
			[
				[{ year: 275760, month: 9, day: 13, millisecond: 1 }, 'UTC'],
				[{ year: 275760, month: 9, day: 12, hour: 20, millisecond: 1 }, NY],
				[{ year: -271821, month: 4, day: 19, hour: 23, minute: 59, second: 59, millisecond: 999 }, 'UTC'],
				[{ year: 275761, month: 1, day: 1 }, 'UTC'],
				[{ year: 1e20, month: 1, day: 1 }, 'UTC'],
				[{ year: -1e20, month: 1, day: 1 }, NY],
				[{ year: Number.MAX_VALUE, month: 1, day: 1 }, NY]
			].forEach(function ([fields, zone]) {
				expect(function () {
					helpers.fromZonedTime(fields as helpers.WallClockTime, zone as string, { disambiguation: 'reject' });
				}).toThrow(new RangeError('Resulting date is out of range'));
			});
		});

		it('validates every field instead of rolling it over', function () {
			const cases: Array<[unknown, Error]> = [
				[null, new TypeError('fromZonedTime: `fields` must be an object, got null')],
				['2024-01-01', new TypeError('fromZonedTime: `fields` must be an object, got string')],
				[{ month: 1, day: 1 }, new TypeError('fromZonedTime: `fields.year` must be an integer, got undefined')],
				[{ year: 2024.5, month: 1, day: 1 }, new RangeError('fromZonedTime: `fields.year` must be an integer, got 2024.5')],
				[{ year: 2024, day: 1 }, new TypeError('fromZonedTime: `fields.month` must be an integer between 1 and 12, got undefined')],
				[{ year: 2024, month: 0, day: 1 }, new RangeError('fromZonedTime: `fields.month` must be an integer between 1 and 12, got 0')],
				[{ year: 2024, month: 13, day: 1 }, new RangeError('fromZonedTime: `fields.month` must be an integer between 1 and 12, got 13')],
				[{ year: 2024, month: '1', day: 1 }, new TypeError('fromZonedTime: `fields.month` must be an integer between 1 and 12, got string')],
				[{ year: 2023, month: 2, day: 29 }, new RangeError('fromZonedTime: `fields.day` must be an integer between 1 and 28, got 29')],
				[{ year: 2024, month: 4, day: 0 }, new RangeError('fromZonedTime: `fields.day` must be an integer between 1 and 30, got 0')],
				[{ year: 2024, month: 1, day: 1, hour: 24 }, new RangeError('fromZonedTime: `fields.hour` must be an integer between 0 and 23, got 24')],
				[{ year: 2024, month: 1, day: 1, hour: -1 }, new RangeError('fromZonedTime: `fields.hour` must be an integer between 0 and 23, got -1')],
				[{ year: 2024, month: 1, day: 1, minute: 60 }, new RangeError('fromZonedTime: `fields.minute` must be an integer between 0 and 59, got 60')],
				[{ year: 2024, month: 1, day: 1, second: 60 }, new RangeError('fromZonedTime: `fields.second` must be an integer between 0 and 59, got 60')],
				[{ year: 2024, month: 1, day: 1, second: 1.5 }, new RangeError('fromZonedTime: `fields.second` must be an integer between 0 and 59, got 1.5')],
				[{ year: 2024, month: 1, day: 1, millisecond: 1000 }, new RangeError('fromZonedTime: `fields.millisecond` must be an integer between 0 and 999, got 1000')],
				[{ year: 2024, month: 1, day: 1, hour: null }, new TypeError('fromZonedTime: `fields.hour` must be an integer between 0 and 23, got null')],
				[{ year: 2024, month: 1, day: 1, offset: NaN }, new RangeError('fromZonedTime: `fields.offset` must be a finite number, got NaN')],
				[{ year: 2024, month: 1, day: 1, offset: '60' }, new TypeError('fromZonedTime: `fields.offset` must be a finite number, got string')]
			];
			cases.forEach(function ([fields, error]) {
				expect(function () {
					helpers.fromZonedTime(fields as helpers.WallClockTime, 'UTC');
				}).toThrow(error);
			});
			expect(function () {
				helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, 'UTC', { disambiguation: 'first' as any });
			}).toThrow(new RangeError('fromZonedTime: `disambiguation` must be one of compatible, earlier, later, reject, got first'));
			expect(function () {
				helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, 'Atlantis');
			}).toThrow(RangeError);
			expect(function () {
				helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, undefined as any);
			}).toThrow(new TypeError('fromZonedTime: `timeZone` must be a string, got undefined'));
		});

		it('ignores extra fields and reads each field once', function () {
			const reads: string[] = [];
			const fields = new Proxy(
				{ year: 2024, month: 1, day: 15, hour: 9, weekday: 3 },
				{
					get: function (target: Record<string, number>, key: string) {
						reads.push(key);
						return target[key];
					}
				}
			);
			expect(helpers.fromZonedTime(fields as unknown as helpers.WallClockTime, NY).getTime()).toBe(Date.UTC(2024, 0, 15, 14));
			expect(reads.sort()).toEqual(['day', 'hour', 'month', 'year']);
		});
	});

	describe('formatInTimeZone', function () {
		it('formats the wall clock of the zone with formatDate tokens', function () {
			const instant = Date.UTC(2024, 0, 5, 14, 7, 9, 3);
			expect(helpers.formatInTimeZone(instant, 'Asia/Kolkata', 'YYYY-MM-DD HH:mm:ss.SSS')).toBe('2024-01-05 19:37:09.003');
			expect(helpers.formatInTimeZone(instant, 'America/Los_Angeles', 'D/M/YY h:mm a [in LA]')).toBe('5/1/24 6:07 am in LA');
			expect(helpers.formatInTimeZone(instant, 'Pacific/Kiritimati', 'dddd YYYY-MM-DD hh A')).toBe('dddd 2024-01-06 04 AM');
		});

		it('writes the offset with Z and ZZ', function () {
			const instant = Date.UTC(2024, 6, 4, 16);
			expect(helpers.formatInTimeZone(instant, 'America/New_York', 'HH:mm Z ZZ')).toBe('12:00 -04:00 -0400');
			expect(helpers.formatInTimeZone(instant, 'Asia/Kathmandu', 'Z|ZZ')).toBe('+05:45|+0545');
			expect(helpers.formatInTimeZone(instant, 'UTC', 'Z|ZZ')).toBe('+00:00|+0000');
			expect(helpers.formatInTimeZone(instant, '-00:00', 'Z')).toBe('+00:00');
			expect(helpers.formatInTimeZone(instant, 'America/St_Johns', 'Z')).toBe('-02:30');
			expect(helpers.formatInTimeZone(instant, 'UTC', 'HH:mm[Z]')).toBe('16:00Z');
			expect(helpers.formatInTimeZone(instant, 'UTC', 'ZZZ')).toBe('+0000+00:00');
			expect(helpers.formatDate(new Date(2024, 0, 5), 'D Z')).toBe('5 Z');
		});

		it('writes the seconds of local mean time offsets, so the text is the exact instant', function () {
			expect(inZone(Date.UTC(1900, 0, 1), 'Europe/Paris')).toBe('1900-01-01T00:09:21.000+00:09:21');
			expect(helpers.formatInTimeZone(Date.UTC(1900, 0, 1), 'Europe/Paris', 'ZZ')).toBe('+000921');
			expect(inZone(-8.64e15, 'America/New_York')).toBe('-271821-04-19T19:03:58.000-04:56:02');
		});

		it('gives an RFC 3339 timestamp of the same instant', function () {
			[Date.UTC(2024, 2, 10, 7, 30), Date.UTC(2024, 10, 3, 6, 30, 0, 5), 0].forEach(function (time) {
				['America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC', '+05:45'].forEach(function (zone) {
					expect(Date.parse(inZone(time, zone))).toBe(time);
				});
			});
			expect(inZone(Date.UTC(2024, 10, 3, 5, 30), 'America/New_York')).toBe('2024-11-03T01:30:00.000-04:00');
			expect(inZone(Date.UTC(2024, 10, 3, 6, 30), 'America/New_York')).toBe('2024-11-03T01:30:00.000-05:00');
		});

		it('writes years outside 0-9999 like formatDate', function () {
			expect(helpers.formatInTimeZone(new Date('-000001-06-01T00:00:00Z'), 'UTC', 'YYYY YY')).toBe('-0001 01');
			expect(helpers.formatInTimeZone(8.64e15, 'UTC', 'YYYY-MM-DD')).toBe('275760-09-13');
		});

		it('does not depend on the runtime time zone', function () {
			const results = ['UTC', 'Pacific/Apia', 'America/Havana'].map(function (zone) {
				let result = '';
				withTimeZone(zone, function () {
					result = inZone(Date.UTC(2024, 2, 10, 5), 'Europe/Paris');
				});
				return result;
			});
			expect(results).toEqual(['2024-03-10T06:00:00.000+01:00', '2024-03-10T06:00:00.000+01:00', '2024-03-10T06:00:00.000+01:00']);
		});

		it('tokenizes in linear time and only caches short patterns', function () {
			const pattern = '['.repeat(200_000);
			const start = performance.now();
			expect(helpers.formatInTimeZone(0, 'UTC', pattern)).toBe(pattern);
			expect(helpers.formatInTimeZone(0, 'UTC', `${pattern}Z`)).toBe(`${pattern}+00:00`);
			expect(performance.now() - start).toBeLessThan(1000);
			// Cached patterns give the same output.
			expect(helpers.formatInTimeZone(0, 'UTC', 'YYYY Z')).toBe(helpers.formatInTimeZone(0, 'UTC', 'YYYY Z'));
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.formatInTimeZone(0, 'UTC', 5 as any);
			}).toThrow(new TypeError('formatInTimeZone: `pattern` must be a string, got number'));
			expect(function () {
				helpers.formatInTimeZone(0, 'Narnia', 'YYYY');
			}).toThrow(new RangeError('formatInTimeZone: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got "Narnia"'));
			expect(function () {
				helpers.formatInTimeZone(INVALID, 'UTC', 'YYYY');
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('startOfDayInTimeZone / endOfDayInTimeZone', function () {
		it('returns the first and last instants of the zone day', function () {
			const time = Date.UTC(2024, 0, 5, 3);
			expect(inZone(helpers.startOfDayInTimeZone(time, 'America/New_York'), 'America/New_York')).toBe('2024-01-04T00:00:00.000-05:00');
			expect(inZone(helpers.endOfDayInTimeZone(time, 'America/New_York'), 'America/New_York')).toBe('2024-01-04T23:59:59.999-05:00');
			expect(inZone(helpers.startOfDayInTimeZone(time, 'Asia/Tokyo'), 'Asia/Tokyo')).toBe('2024-01-05T00:00:00.000+09:00');
			expect(inZone(helpers.endOfDayInTimeZone(time, '+05:30'), '+05:30')).toBe('2024-01-05T23:59:59.999+05:30');
		});

		it('lasts 23 or 25 hours on DST days', function () {
			const spring = Date.UTC(2024, 2, 10, 12);
			const fall = Date.UTC(2024, 10, 3, 12);
			expect(helpers.endOfDayInTimeZone(spring, 'America/New_York').getTime() + 1 - helpers.startOfDayInTimeZone(spring, 'America/New_York').getTime()).toBe(
				23 * 3_600_000
			);
			expect(helpers.endOfDayInTimeZone(fall, 'America/New_York').getTime() + 1 - helpers.startOfDayInTimeZone(fall, 'America/New_York').getTime()).toBe(25 * 3_600_000);
		});

		it('starts a day at the end of the gap when midnight was skipped', function () {
			expect(inZone(helpers.startOfDayInTimeZone(Date.UTC(2024, 2, 10, 12), 'America/Havana'), 'America/Havana')).toBe('2024-03-10T01:00:00.000-04:00');
			expect(inZone(helpers.endOfDayInTimeZone(Date.UTC(2024, 2, 9, 12), 'America/Havana'), 'America/Havana')).toBe('2024-03-09T23:59:59.999-05:00');
			expect(inZone(helpers.startOfDayInTimeZone(Date.UTC(2018, 10, 4, 12), 'America/Sao_Paulo'), 'America/Sao_Paulo')).toBe('2018-11-04T01:00:00.000-02:00');
			expect(inZone(helpers.startOfDayInTimeZone(Date.UTC(2024, 2, 31, 12), 'Asia/Beirut'), 'Asia/Beirut')).toBe('2024-03-31T01:00:00.000+03:00');
		});

		it('handles a repeated midnight that belongs to the new day (Havana)', function () {
			// On 2024-11-03 the clock went back from 01:00 to 00:00.
			expect(inZone(helpers.endOfDayInTimeZone(Date.UTC(2024, 10, 2, 16), 'America/Havana'), 'America/Havana')).toBe('2024-11-02T23:59:59.999-04:00');
			expect(inZone(helpers.startOfDayInTimeZone(Date.UTC(2024, 10, 3, 16), 'America/Havana'), 'America/Havana')).toBe('2024-11-03T00:00:00.000-04:00');
		});

		it('ends a day at its second midnight when the day came back (St. John’s, 2010-11-07 at 00:01)', function () {
			const zone = 'America/St_Johns';
			const late = Date.parse('2010-11-07T03:00:00Z');
			expect(inZone(late, zone)).toBe('2010-11-06T23:30:00.000-03:30');
			expect(inZone(helpers.endOfDayInTimeZone(late, zone), zone)).toBe('2010-11-06T23:59:59.999-03:30');
			expect(inZone(helpers.endOfDayInTimeZone(Date.parse('2010-11-06T12:00:00Z'), zone), zone)).toBe('2010-11-06T23:59:59.999-03:30');
			expect(inZone(helpers.startOfDayInTimeZone(late, zone), zone)).toBe('2010-11-06T00:00:00.000-02:30');
			expect(inZone(helpers.startOfDayInTimeZone(Date.parse('2010-11-07T12:00:00Z'), zone), zone)).toBe('2010-11-07T00:00:00.000-02:30');
		});

		it('ends the day before a skipped calendar day at its midnight (Samoa)', function () {
			const zone = 'Pacific/Apia';
			expect(inZone(helpers.endOfDayInTimeZone(Date.parse('2011-12-29T22:00:00Z'), zone), zone)).toBe('2011-12-29T23:59:59.999-10:00');
			expect(inZone(helpers.startOfDayInTimeZone(Date.parse('2011-12-31T12:00:00Z'), zone), zone)).toBe('2012-01-01T00:00:00.000+14:00');
			expect(helpers.endOfDayInTimeZone(Date.parse('2011-12-29T22:00:00Z'), zone).getTime() + 1).toBe(
				helpers.startOfDayInTimeZone(Date.parse('2011-12-30T12:00:00Z'), zone).getTime()
			);
		});

		it('starts a day at the end of a gap that began the day before (Toronto, 1919-03-30 23:30 → 00:30)', function () {
			const zone = 'America/Toronto';
			const transition = Date.parse('1919-03-31T04:30:00Z');
			expect(inZone(helpers.startOfDayInTimeZone(Date.parse('1919-03-31T16:00:00Z'), zone), zone)).toBe('1919-03-31T00:30:00.000-04:00');
			expect(helpers.startOfDayInTimeZone(transition, zone).getTime()).toBe(transition);
			expect(inZone(helpers.endOfDayInTimeZone(Date.parse('1919-03-30T16:00:00Z'), zone), zone)).toBe('1919-03-30T23:29:59.999-05:00');
			expect(helpers.endOfDayInTimeZone(transition - 1, zone).getTime()).toBe(transition - 1);
			// Temporal's 'compatible' midnight is an hour later, 30 minutes after the day started.
			expect(inZone(helpers.fromZonedTime({ year: 1919, month: 3, day: 31 }, zone), zone)).toBe('1919-03-31T01:00:00.000-04:00');
		});

		it('agrees with startOfDay / endOfDay in the runtime time zone', function () {
			const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
			[new Date(2024, 2, 10, 12), new Date(2024, 10, 3, 12), new Date(2011, 11, 31, 12), new Date(2024, 3, 7, 1)].forEach(function (date) {
				expect(helpers.startOfDayInTimeZone(date, local).getTime()).toBe(helpers.startOfDay(date).getTime());
				expect(helpers.endOfDayInTimeZone(date, local).getTime()).toBe(helpers.endOfDay(date).getTime());
			});
		});

		it('throws when the result is outside the Date range', function () {
			expect(helpers.startOfDayInTimeZone(8.64e15, 'UTC').getTime()).toBe(8.64e15);
			expect(helpers.endOfDayInTimeZone(-8.64e15, 'UTC').getTime()).toBe(-8.64e15 + 86_400_000 - 1);
			expect(function () {
				helpers.endOfDayInTimeZone(8.64e15, 'UTC');
			}).toThrow(new RangeError('Resulting date is out of range'));
			expect(function () {
				helpers.startOfDayInTimeZone(-8.64e15, 'America/New_York');
			}).toThrow(new RangeError('Resulting date is out of range'));
			expect(function () {
				helpers.endOfDayInTimeZone(8.64e15, 'Pacific/Kiritimati');
			}).toThrow(new RangeError('Resulting date is out of range'));
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.startOfDayInTimeZone(0, 1 as any);
			}).toThrow(new TypeError('startOfDayInTimeZone: `timeZone` must be a string, got number'));
			expect(function () {
				helpers.endOfDayInTimeZone(0, 'Moon/Tranquility');
			}).toThrow(new RangeError('endOfDayInTimeZone: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got "Moon/Tranquility"'));
			expect(function () {
				helpers.endOfDayInTimeZone(INVALID, 'UTC');
			}).toThrow(new RangeError('Invalid date'));
		});
	});
});

describe('getCalendarMonth', function () {
	it('returns the weeks of a month, padded with the neighbouring months', function () {
		const weeks = helpers.getCalendarMonth(2024, 1);
		expect(
			weeks.map(function (week) {
				return week.map(function (date) {
					return helpers.formatDate(date, 'MM-DD HH:mm');
				});
			})
		).toEqual([
			['01-28 00:00', '01-29 00:00', '01-30 00:00', '01-31 00:00', '02-01 00:00', '02-02 00:00', '02-03 00:00'],
			['02-04 00:00', '02-05 00:00', '02-06 00:00', '02-07 00:00', '02-08 00:00', '02-09 00:00', '02-10 00:00'],
			['02-11 00:00', '02-12 00:00', '02-13 00:00', '02-14 00:00', '02-15 00:00', '02-16 00:00', '02-17 00:00'],
			['02-18 00:00', '02-19 00:00', '02-20 00:00', '02-21 00:00', '02-22 00:00', '02-23 00:00', '02-24 00:00'],
			['02-25 00:00', '02-26 00:00', '02-27 00:00', '02-28 00:00', '02-29 00:00', '03-01 00:00', '03-02 00:00']
		]);
	});

	it('starts weeks on weekStartsOn and has 4 to 6 weeks, or always 6 with fixedWeeks', function () {
		// February 2026 starts on a Sunday and has 28 days; March 2025 starts on a Saturday and has 31.
		expect(helpers.getCalendarMonth(2026, 1)).toHaveLength(4);
		expect(helpers.getCalendarMonth(2026, 1, { weekStartsOn: 1 })).toHaveLength(5);
		expect(helpers.getCalendarMonth(2025, 2)).toHaveLength(6);
		expect(helpers.getCalendarMonth(2025, 2, { weekStartsOn: 6 })).toHaveLength(5);
		expect(helpers.getCalendarMonth(2026, 1, { fixedWeeks: true })).toHaveLength(6);
		expect(ymd(helpers.getCalendarMonth(2026, 1, { fixedWeeks: true })[5][6])).toEqual([2026, 2, 14]);
		expect(ymd(helpers.getCalendarMonth(2024, 1, { weekStartsOn: 1 })[0][0])).toEqual([2024, 0, 29]);
		expect(ymd(helpers.getCalendarMonth(2024, 1, { weekStartsOn: 4 })[0][0])).toEqual([2024, 1, 1]);
		expect(ymd(helpers.getCalendarMonth(2024, 1, { weekStartsOn: 5 })[0][0])).toEqual([2024, 0, 26]);
	});

	it('lists every day of every month once, in order, each at the start of its local day', function () {
		for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
			for (let weekStartsOn = 0; weekStartsOn < 7; weekStartsOn++) {
				const weeks = helpers.getCalendarMonth(2023, monthIndex, { weekStartsOn: weekStartsOn as helpers.WeekdayIndex });
				const cells = weeks.flat();
				const inMonth = cells.filter(function (date) {
					return date.getMonth() === monthIndex;
				});
				expect(
					inMonth.map(function (date) {
						return date.getDate();
					})
				).toEqual(
					Array.from({ length: helpers.daysInMonth(2023, monthIndex) }, function (_, i) {
						return i + 1;
					})
				);
				expect(cells[0].getDay()).toBe(weekStartsOn);
				expect(weeks[0]).toContainEqual(inMonth[0]);
				expect(weeks[weeks.length - 1]).toContainEqual(inMonth[inMonth.length - 1]);
				cells.forEach(function (date, i) {
					expect(date.getTime()).toBe(helpers.startOfDay(date).getTime());
					if (i > 0) expect(helpers.diffInDays(date, cells[i - 1])).toBe(1);
				});
			}
		}
	});

	it('starts a cell at the end of the gap when midnight was skipped', function () {
		withTimeZone('America/Havana', function () {
			const cell = helpers.getCalendarMonth(2024, 2)[2][0];
			expect(helpers.toISOStringLocal(cell)).toBe('2024-03-10T01:00:00.000-04:00');
		});
		withTimeZone('Asia/Beirut', function () {
			const cell = helpers.getCalendarMonth(2024, 2, { weekStartsOn: 1 })[4][6];
			expect(helpers.toISOStringLocal(cell)).toBe('2024-03-31T01:00:00.000+03:00');
		});
	});

	it('starts every local day at its first instant, even when the gap began the day before (Toronto, 1919-03-31)', function () {
		withTimeZone('America/Toronto', function () {
			const sunday = new Date(1919, 2, 31, 12);
			expect(helpers.toISOStringLocal(helpers.getCalendarMonth(1919, 2)[5][1])).toBe('1919-03-31T00:30:00.000-04:00');
			expect(helpers.toISOStringLocal(helpers.startOfDay(sunday))).toBe('1919-03-31T00:30:00.000-04:00');
			expect(helpers.toISOStringLocal(helpers.startOfWeek(new Date(1919, 3, 2), 1))).toBe('1919-03-31T00:30:00.000-04:00');
			expect(helpers.toISOStringLocal(helpers.endOfDay(new Date(1919, 2, 30, 12)))).toBe('1919-03-30T23:29:59.999-05:00');
			expect(helpers.toISOStringLocal(helpers.endOfWeek(new Date(1919, 2, 29, 12)))).toBe('1919-03-29T23:59:59.999-05:00');
			expect(helpers.toISOStringLocal(helpers.endOfWeek(new Date(1919, 2, 27, 12), 1))).toBe('1919-03-30T23:29:59.999-05:00');
			expect(helpers.toISOStringLocal(helpers.parseISODate('1919-03-31') as Date)).toBe('1919-03-31T00:30:00.000-04:00');
			expect(helpers.isSameDay(helpers.endOfDay(new Date(1919, 2, 30, 12)), new Date(1919, 2, 30, 12))).toBe(true);
			// Months, years and quarters start at midnight, which exists on their first day.
			expect(helpers.toISOStringLocal(helpers.startOfMonth(sunday))).toBe('1919-03-01T00:00:00.000-05:00');
			expect(helpers.toISOStringLocal(helpers.startOfYear(sunday))).toBe('1919-01-01T00:00:00.000-05:00');
		});
		withTimeZone('America/Havana', function () {
			// A day that starts with a gap: 2024-03-10 begins at 01:00 (00:00-00:59 were skipped).
			expect(helpers.toISOStringLocal(helpers.startOfDay(new Date(2024, 2, 10, 12)))).toBe('2024-03-10T01:00:00.000-04:00');
			expect(helpers.toISOStringLocal(helpers.endOfDay(new Date(2024, 2, 9, 12)))).toBe('2024-03-09T23:59:59.999-05:00');
		});
	});

	it('gives a skipped calendar day the start of the next day (Samoa, 2011-12-30)', function () {
		withTimeZone('Pacific/Apia', function () {
			const week = helpers.getCalendarMonth(2011, 11)[4];
			expect(
				week.map(function (date) {
					return helpers.toISOStringLocal(date, { milliseconds: false });
				})
			).toEqual([
				'2011-12-25T00:00:00-10:00',
				'2011-12-26T00:00:00-10:00',
				'2011-12-27T00:00:00-10:00',
				'2011-12-28T00:00:00-10:00',
				'2011-12-29T00:00:00-10:00',
				'2011-12-31T00:00:00+14:00',
				'2011-12-31T00:00:00+14:00'
			]);
			expect(week[5].getTime()).toBe(week[6].getTime());
			expect(week[5]).not.toBe(week[6]);
		});
	});

	it('does not remap years 0-99 and throws past the Date range', function () {
		expect(helpers.getCalendarMonth(5, 0)[1][0].getFullYear()).toBe(5);
		expect(helpers.getCalendarMonth(0, 1).flat().length).toBeGreaterThanOrEqual(28);
		expect(function () {
			helpers.getCalendarMonth(275760, 8);
		}).toThrow(new RangeError('Resulting date is out of range'));
		expect(function () {
			helpers.getCalendarMonth(-271821, 3);
		}).toThrow(new RangeError('Resulting date is out of range'));
		// Too large for the arithmetic: still an error, not an empty grid.
		[1e300, -1e300, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE].forEach(function (year) {
			expect(function () {
				helpers.getCalendarMonth(year, 0);
			}).toThrow(new RangeError('Resulting date is out of range'));
		});
	});

	it('validates its arguments', function () {
		const cases: Array<[() => unknown, Error]> = [
			[
				function () {
					return helpers.getCalendarMonth('2024' as any, 0);
				},
				new TypeError('getCalendarMonth: `year` must be an integer, got string')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024.5, 0);
				},
				new RangeError('getCalendarMonth: `year` must be an integer, got 2024.5')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, 12);
				},
				new RangeError('getCalendarMonth: `monthIndex` must be an integer between 0 and 11, got 12')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, -1);
				},
				new RangeError('getCalendarMonth: `monthIndex` must be an integer between 0 and 11, got -1')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, undefined as any);
				},
				new TypeError('getCalendarMonth: `monthIndex` must be an integer between 0 and 11, got undefined')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, 0, { weekStartsOn: 7 as any });
				},
				new RangeError('getCalendarMonth: `weekStartsOn` must be an integer between 0 and 6, got 7')
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, 0, { weekStartsOn: '1' as any });
				},
				new TypeError('getCalendarMonth: `weekStartsOn` must be an integer between 0 and 6, got string')
			]
		];
		cases.forEach(function ([fn, error]) {
			expect(fn).toThrow(error);
		});
		// Only `true` turns fixedWeeks on.
		expect(helpers.getCalendarMonth(2026, 1, { fixedWeeks: 1 as any })).toHaveLength(4);
		expect(helpers.getCalendarMonth(2026, 1, { weekStartsOn: undefined })).toHaveLength(4);
	});
});

describe('Date helpers (review round)', function () {
	it('rejects options that are not objects, and non-string patterns and locales, with tinkit TypeErrors', function () {
		const cases: Array<[() => unknown, string]> = [
			[
				function () {
					return helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, 'UTC', null as any);
				},
				'fromZonedTime: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, 1, null as any);
				},
				'getCalendarMonth: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.getCalendarMonth(2024, 1, 'fixed' as any);
				},
				'getCalendarMonth: `options` must be an object, got string'
			],
			[
				function () {
					return helpers.eachDayOfInterval(0, 0, null as any);
				},
				'eachDayOfInterval: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.formatDuration(0, null as any);
				},
				'formatDuration: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.toISOStringLocal(0, null as any);
				},
				'toISOStringLocal: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.intervalsOverlap({ start: 0, end: 1 }, { start: 0, end: 1 }, null as any);
				},
				'intervalsOverlap: `options` must be an object, got null'
			],
			[
				function () {
					return helpers.formatDate(0, 5 as any);
				},
				'formatDate: `pattern` must be a string, got number'
			],
			[
				function () {
					return helpers.getRelativeTime(0, 0, 5 as any);
				},
				'getRelativeTime: `locale` must be a string, got number'
			]
		];
		cases.forEach(function ([fn, message]) {
			expect(fn).toThrow(new TypeError(message));
		});
	});

	it('isValidTimeZone narrows to the TimeZone brand, which every zone parameter accepts like a string', function () {
		const input: unknown = 'Asia/Tokyo';
		if (!helpers.isValidTimeZone(input)) throw new Error('unreachable');
		const zone: helpers.TimeZone = input;
		const text: string = zone;
		expect(helpers.getZonedParts(0, zone).hour).toBe(9);
		expect(text).toBe('Asia/Tokyo');
		const plain = 'Nowhere';
		if (!helpers.isValidTimeZone(plain)) {
			// A failed check keeps the string a string.
			const still: string = plain;
			expect(still).toBe('Nowhere');
		}
	});

	it('endOfDay ends a day that comes back more than 3 hours after midnight at its second midnight (Alaska, 1867)', function () {
		// On 1867-10-19 at 00:31:13 UTC, Alaska moved from Asian to American time: the clocks went back 24 hours, so October 18th
		// came back in the afternoon of October 19th.
		const transition = Date.parse('1867-10-19T00:31:13Z');
		['America/Adak', 'America/Sitka'].forEach(function (zone) {
			withTimeZone(zone, function () {
				[transition, transition - 30 * 3_600_000, transition + 3_600_000].forEach(function (time) {
					const end = helpers.endOfDay(time);
					expect(end.getTime()).toBeGreaterThanOrEqual(time);
					expect(helpers.isSameDay(end, time)).toBe(true);
					expect(helpers.isSameDay(end.getTime() + 1, time)).toBe(false);
					expect(end.getTime()).toBe(helpers.endOfDayInTimeZone(time, zone).getTime());
				});
			});
		});
	});

	it('intervalToDuration and diffInMonths count across a skipped calendar day (Samoa 2011, Kiritimati 1994)', function () {
		/**
		 * Checks a duration and that it adds back to the end.
		 */
		function check(start: Date, end: Date, expected: helpers.IntervalDuration, months: number): void {
			const duration = helpers.intervalToDuration(start, end);
			expect(duration).toEqual(expected);
			expect(helpers.addDuration(start, duration).getTime()).toBe(end.getTime());
			expect(helpers.diffInMonths(end, start)).toBe(months);
		}
		withTimeZone('Pacific/Apia', function () {
			// One month after November 30th is the skipped December 30th, which the clock shows as the 31st.
			check(new Date(2011, 10, 30, 7, 25), new Date(2012, 0, 6, 20, 57), { years: 0, months: 1, days: 7, hours: 13, minutes: 32, seconds: 0, milliseconds: 0 }, 1);
			check(new Date(2011, 9, 30, 19, 52), new Date(2012, 0, 20, 22, 20), { years: 0, months: 2, days: 21, hours: 2, minutes: 28, seconds: 0, milliseconds: 0 }, 2);
			// Backwards: one month before January 30th is the skipped December 30th, shown as the 31st, the end's own day.
			check(new Date(2012, 0, 30, 16, 17), new Date(2011, 11, 31, 6, 48), { years: 0, months: -1, days: 0, hours: -9, minutes: -29, seconds: 0, milliseconds: 0 }, 0);
		});
		withTimeZone('Pacific/Kiritimati', function () {
			// Two months after October 31st is the skipped December 31st, shown as January 1st at 19:52: after the end.
			check(new Date(1994, 9, 31, 19, 52), new Date(1995, 0, 1, 8, 2), { years: 0, months: 1, days: 30, hours: 12, minutes: 10, seconds: 0, milliseconds: 0 }, 1);
			expect(helpers.diffInMonths(new Date(1994, 9, 31, 19, 52), new Date(1995, 0, 1, 8, 2))).toBe(-1);
		});
	});

	it('diffInDays spans the whole Date range in any time zone', function () {
		withTimeZone('UTC', function () {
			expect(helpers.diffInDays(8.64e15, -8.64e15)).toBe(200_000_000);
		});
		withTimeZone('Europe/London', function () {
			// London's local mean time (-00:01:15) puts the earliest instant on April 19th.
			expect(helpers.diffInDays(8.64e15, -8.64e15)).toBe(200_000_001);
		});
		const days = helpers.diffInDays(8.64e15, -8.64e15);
		expect(days).toBe(helpers.diffInDays(8.64e15, 0) - helpers.diffInDays(-8.64e15, 0));
		expect(Math.abs(days - 200_000_000)).toBeLessThanOrEqual(1);
	});
});

describe('Date helpers under prototype pollution', function () {
	function polluted(key: string, value: unknown, fn: () => void): void {
		(Object.prototype as Record<string, unknown>)[key] = value;
		try {
			fn();
		} finally {
			delete (Object.prototype as Record<string, unknown>)[key];
		}
	}

	it('parseDate and addDuration ignore inherited fields', function () {
		polluted('S', 7, function () {
			expect(helpers.parseDate('2024-01-05', 'YYYY-MM-DD')?.getMilliseconds()).toBe(0);
		});
		polluted('Y', 1999, function () {
			expect(helpers.parseDate('05', 'MM')?.getFullYear()).toBe(2000);
		});
		polluted('days', 5, function () {
			expect(helpers.addDuration(0, {}).getTime()).toBe(0);
		});
	});

	it('mergeIntervals, subtractIntervals and findGaps do not read a last merged interval from an inherited "-1"', function () {
		const everything = [0, 8.64e15];

		function at(hour: number): Date {
			return new Date(Date.UTC(2024, 0, 1, hour));
		}

		polluted('-1', everything, function () {
			expect(helpers.mergeIntervals([{ start: at(9), end: at(11) }])).toHaveLength(1);
			expect(helpers.findGaps({ start: at(9), end: at(17) }, [{ start: at(10), end: at(11) }])).toHaveLength(2);
			expect(helpers.subtractIntervals({ start: at(9), end: at(17) }, [{ start: at(10), end: at(11) }])).toHaveLength(2);
		});
		expect(everything).toEqual([0, 8.64e15]);
	});

	it('eachDayOfInterval, formatDuration and toISOStringLocal ignore inherited options', function () {
		polluted('step', 3, function () {
			expect(helpers.eachDayOfInterval(new Date(2024, 0, 1), new Date(2024, 0, 10))).toHaveLength(10);
		});
		polluted('largest', 1, function () {
			expect(helpers.formatDuration(93_784_005)).toBe('1d 2h 3m 4s 5ms');
		});
		polluted('units', ['h'], function () {
			expect(helpers.formatDuration(93_784_005)).toBe('1d 2h 3m 4s 5ms');
		});
		polluted('milliseconds', false, function () {
			expect(helpers.toISOStringLocal(new Date(2024, 0, 1, 1, 2, 3, 4))).toMatch(/^2024-01-01T01:02:03\.004/);
		});
	});

	it('fromZonedTime and getCalendarMonth ignore inherited fields and options', function () {
		polluted('hour', 5, function () {
			expect(helpers.fromZonedTime({ year: 2024, month: 1, day: 1 }, 'UTC').getTime()).toBe(Date.UTC(2024, 0, 1));
		});
		polluted('offset', -300, function () {
			expect(helpers.fromZonedTime({ year: 2024, month: 11, day: 3, hour: 1, minute: 30 }, 'America/New_York').getTime()).toBe(Date.UTC(2024, 10, 3, 5, 30));
		});
		polluted('year', 2000, function () {
			expect(function () {
				helpers.fromZonedTime({ month: 1, day: 1 } as helpers.WallClockTime, 'UTC');
			}).toThrow(TypeError);
		});
		polluted('disambiguation', 'reject', function () {
			expect(helpers.fromZonedTime({ year: 2024, month: 3, day: 10, hour: 2, minute: 30 }, 'America/New_York').getTime()).toBe(Date.UTC(2024, 2, 10, 7, 30));
		});
		polluted('fixedWeeks', true, function () {
			expect(helpers.getCalendarMonth(2026, 1)).toHaveLength(4);
		});
		polluted('weekStartsOn', 1, function () {
			expect(helpers.getCalendarMonth(2026, 1)[0][0].getDay()).toBe(0);
		});
	});

	it('formatInTimeZone ignores inherited formatters', function () {
		polluted('MM', 'polluted', function () {
			expect(helpers.formatInTimeZone(Date.UTC(2024, 0, 5), 'UTC', '[x]MM-DD Z')).toBe('x01-05 +00:00');
		});
	});

	it('formats every token, never a literal read from an inherited "1"', function () {
		const date = new Date(2024, 0, 5, 9, 7, 3, 4);

		polluted('1', 'polluted', function () {
			expect(helpers.formatDate(date, 'YYYY-MM-DD')).toBe('2024-01-05');
			expect(helpers.formatDate(date, '[at] HH:mm')).toBe('at 09:07');
			expect(helpers.toISODateString(date)).toBe('2024-01-05');
			expect(helpers.toISOStringLocal(date)).toMatch(/^2024-01-05T09:07:03\.004/);
			expect(helpers.formatInTimeZone(Date.UTC(2024, 0, 5), 'UTC', 'YYYY-MM-DD Z')).toBe('2024-01-05 +00:00');
			expect(helpers.parseDate('2024-01-05', 'YYYY-MM-DD')?.getTime()).toBe(new Date(2024, 0, 5).getTime());
		});
	});

	it('reads a hole of an array as undefined, never as a value planted on Object.prototype', function () {
		/**
		 * A sparse array: `items`, with a hole at `index`.
		 */
		function holed<T>(items: T[], index: number): T[] {
			const array = items.slice();

			delete array[index];

			return array;
		}

		polluted('1', 'd', function () {
			expect(function () {
				helpers.formatDuration(93_784_005, { units: holed(['h', 'h'], 1) as helpers.DurationUnit[] });
			}).toThrow(new RangeError('formatDuration: `units` must only contain d, h, m, s, ms, got undefined'));
		});
		polluted('1', 3, function () {
			expect(function () {
				helpers.isBusinessDay(new Date(2024, 0, 3), { weekend: holed([0, 0, 6], 1) as helpers.WeekdayIndex[] });
			}).toThrow(new TypeError('isBusinessDay: `weekend[1]` must be an integer between 0 and 6, got undefined'));
		});
		polluted('0', new Date(2024, 0, 3).getTime(), function () {
			const hole = holed([0], 0);

			expect(function () {
				helpers.isBusinessDay(new Date(2024, 0, 3), { holidays: hole });
			}).toThrow(new TypeError('Expected a Date or a timestamp number'));
			for (const call of [helpers.minDate, helpers.maxDate, helpers.closestTo.bind(null, 0)] as Array<(dates: number[]) => unknown>) {
				expect(function () {
					call(holed([5, 6], 0));
				}).toThrow(new TypeError('Expected a Date or a timestamp number'));
			}
		});
		polluted('0', { start: 0, end: 8.64e15 }, function () {
			const busy = holed([{ start: 10, end: 20 }], 0);

			expect(function () {
				helpers.findGaps({ start: 0, end: 100 }, busy);
			}).toThrow(new TypeError('findGaps: `busy[0]` must be an interval object, got undefined'));
			expect(function () {
				helpers.mergeIntervals(busy);
			}).toThrow(new TypeError('mergeIntervals: `intervals[0]` must be an interval object, got undefined'));
		});
		// Other iterables are read as they iterate.
		expect(helpers.minDate(new Set([5, 3]))?.getTime()).toBe(3);
		expect(helpers.mergeIntervals(new Set([{ start: 1, end: 2 }]))).toEqual([{ start: new Date(1), end: new Date(2) }]);
	});

	it('iterates an array whose Symbol.iterator is overridden, own or by a subclass, instead of reading its indices', function () {
		/**
		 * An array of `stored` that iterates `yielded` instead.
		 */
		function overridden<T>(stored: T[], yielded: T[]): T[] {
			return Object.assign(stored.slice(), {
				[Symbol.iterator]: function (): Iterator<T> {
					return yielded[Symbol.iterator]();
				}
			});
		}

		/**
		 * An array that iterates its elements doubled.
		 */
		class Doubled extends Array<number> {
			/**
			 * Yields each element times two.
			 */
			override [Symbol.iterator](): ArrayIterator<number> {
				const values: number[] = [];

				for (let i = 0; i < this.length; i++) values.push(this[i] * 2);

				return values.values();
			}
		}

		const doubled = Doubled.from([5, 7]);

		expect(helpers.minDate(overridden([1, 2], [30, 40]))?.getTime()).toBe(30);
		expect(helpers.maxDate(overridden([1, 2], [30, 40]))?.getTime()).toBe(40);
		expect(helpers.closestTo(0, overridden([1, 2], [30, 40]))?.getTime()).toBe(30);
		expect(helpers.minDate(doubled)?.getTime()).toBe(10);
		expect(helpers.maxDate(doubled)?.getTime()).toBe(14);
		expect(helpers.mergeIntervals(overridden([{ start: 1, end: 2 }], []))).toEqual([]);
		expect(helpers.findGaps({ start: 0, end: 10 }, overridden([], [{ start: 2, end: 4 }]))).toEqual([
			{ start: new Date(0), end: new Date(2) },
			{ start: new Date(4), end: new Date(10) }
		]);

		const wednesday = new Date(2024, 0, 3);

		expect(helpers.isBusinessDay(wednesday, { holidays: overridden([wednesday], []) })).toBe(true);
		expect(helpers.isBusinessDay(wednesday, { holidays: overridden([], [wednesday]) })).toBe(false);
		// An array proxy iterates by default, so it is read by index.
		expect(helpers.minDate(new Proxy([8, 6], {}))?.getTime()).toBe(6);
	});

	it('time zone clocks and relative time formatters ignore inherited Intl options, and are not cached corrupted', function () {
		const time = Date.UTC(2024, 0, 15, 12, 30);
		const base = new Date(2024, 0, 10, 12);
		const inherited: Record<string, unknown> = {
			hour12: true,
			calendar: 'islamic',
			numberingSystem: 'arab',
			era: 'long',
			weekday: 'long',
			timeZoneName: 'long',
			year: 'numeric',
			month: 'long',
			style: 'narrow',
			localeMatcher: 'lookup'
		};
		/**
		 * Reads zones and a locale used nowhere else in this file, so that they are first cached under pollution.
		 */
		function read(): unknown[] {
			return [
				helpers.getZonedParts(time, 'Asia/Ulaanbaatar'),
				helpers.formatInTimeZone(time, 'Africa/Nairobi', 'YYYY-MM-DD HH:mm:ss Z'),
				helpers.getTimeZoneOffset('Asia/Dhaka', time),
				helpers.startOfDayInTimeZone(time, 'America/Lima').getTime(),
				helpers.getRelativeTime(new Date(2024, 0, 10, 9), base, 'en-GB')
			];
		}
		const expected = [
			{ year: 2024, month: 1, day: 15, hour: 20, minute: 30, second: 0, millisecond: 0, weekday: 1, offset: 480 },
			'2024-01-15 15:30:00 +03:00',
			360,
			Date.UTC(2024, 0, 15, 5),
			'3 hours ago'
		];
		Object.keys(inherited).forEach(function (key) {
			(Object.prototype as Record<string, unknown>)[key] = inherited[key];
		});
		let underPollution: unknown[];
		try {
			underPollution = read();
		} finally {
			Object.keys(inherited).forEach(function (key) {
				delete (Object.prototype as Record<string, unknown>)[key];
			});
		}
		expect(underPollution).toEqual(expected);
		expect(read()).toEqual(expected);
	});
});

describe('Date helpers (scheduling round)', function () {
	/**
	 * A date on 2024-01-01 at `hour` (fractional hours allowed).
	 */
	function at(hour: number): Date {
		return new Date(2024, 0, 1, 0, hour * 60);
	}

	/**
	 * An interval from `start` to `end` o'clock on 2024-01-01.
	 */
	function span(start: number, end: number): helpers.Interval<Date> {
		return { start: at(start), end: at(end) };
	}

	/**
	 * The hours of intervals returned on 2024-01-01, for compact assertions.
	 */
	function hours(intervals: Array<helpers.Interval<Date>>): number[][] {
		return intervals.map(function (interval) {
			return [interval.start, interval.end].map(function (date) {
				return (date.getTime() - at(0).getTime()) / 3_600_000;
			});
		});
	}

	/**
	 * Runs `fn` with `key` set on `Object.prototype`.
	 */
	function polluted(key: string, value: unknown, fn: () => void): void {
		(Object.prototype as Record<string, unknown>)[key] = value;
		try {
			fn();
		} finally {
			delete (Object.prototype as Record<string, unknown>)[key];
		}
	}

	describe('intersectIntervals', function () {
		it('returns the shared part, or undefined', function () {
			expect(hours([helpers.intersectIntervals(span(9, 12), span(11, 14)) as helpers.Interval<Date>])).toEqual([[11, 12]]);
			expect(hours([helpers.intersectIntervals(span(11, 14), span(9, 12)) as helpers.Interval<Date>])).toEqual([[11, 12]]);
			expect(hours([helpers.intersectIntervals(span(9, 17), span(11, 12)) as helpers.Interval<Date>])).toEqual([[11, 12]]);
			expect(helpers.intersectIntervals(span(9, 12), span(12, 14))).toBeUndefined();
			expect(helpers.intersectIntervals(span(9, 10), span(11, 12))).toBeUndefined();
			expect(helpers.intersectIntervals(span(10, 10), span(9, 12))).toBeUndefined();
		});

		it('treats intervals as closed with `inclusive`', function () {
			const options = { inclusive: true };
			expect(hours([helpers.intersectIntervals(span(9, 12), span(12, 14), options) as helpers.Interval<Date>])).toEqual([[12, 12]]);
			expect(hours([helpers.intersectIntervals(span(10, 10), span(9, 12), options) as helpers.Interval<Date>])).toEqual([[10, 10]]);
			expect(helpers.intersectIntervals(span(9, 10), span(11, 12), options)).toBeUndefined();
		});

		it('returns new dates, accepts timestamps and validates its arguments', function () {
			const a = span(9, 12);
			const result = helpers.intersectIntervals(a, a) as helpers.Interval<Date>;
			expect(result.start).not.toBe(a.start);
			expect(result.start.getTime()).toBe(a.start.getTime());
			expect(helpers.intersectIntervals({ start: 0, end: 10 }, { start: 5, end: 20 })).toEqual({ start: new Date(5), end: new Date(10) });
			expect(function () {
				helpers.intersectIntervals({ start: 2, end: 1 }, { start: 1, end: 2 });
			}).toThrow(new RangeError('intersectIntervals: `a.start` must not be after `a.end`'));
			expect(function () {
				helpers.intersectIntervals({ start: 1, end: 2 }, 5 as any);
			}).toThrow(new TypeError('intersectIntervals: `b` must be an interval object, got number'));
			expect(function () {
				helpers.intersectIntervals({ start: 1, end: 2 }, { start: 1, end: 2 }, null as any);
			}).toThrow(new TypeError('intersectIntervals: `options` must be an object, got null'));
			expect(function () {
				helpers.intersectIntervals({ start: 1, end: INVALID }, { start: 1, end: 2 });
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('mergeIntervals', function () {
		it('sorts and merges overlapping intervals, keeping touching ones apart by default', function () {
			expect(hours(helpers.mergeIntervals([span(13, 15), span(9, 11), span(10, 12)]))).toEqual([
				[9, 12],
				[13, 15]
			]);
			expect(hours(helpers.mergeIntervals([span(9, 17), span(10, 11), span(12, 13)]))).toEqual([[9, 17]]);
			expect(hours(helpers.mergeIntervals([span(9, 10), span(9.5, 11), span(10.5, 12), span(12, 13)]))).toEqual([
				[9, 12],
				[12, 13]
			]);
			expect(hours(helpers.mergeIntervals([span(14, 15), span(9, 10)]))).toEqual([
				[9, 10],
				[14, 15]
			]);
			expect(helpers.mergeIntervals([])).toEqual([]);
		});

		it('drops empty intervals by default, and keeps them (merged into what they touch) with `inclusive`', function () {
			expect(hours(helpers.mergeIntervals([span(10, 10), span(9, 9), span(11, 12)]))).toEqual([[11, 12]]);
			expect(hours(helpers.mergeIntervals([span(12, 12), span(9, 12), span(12, 14), span(16, 16)], { inclusive: true }))).toEqual([
				[9, 14],
				[16, 16]
			]);
			expect(hours(helpers.mergeIntervals([span(9, 12), span(12, 14)], { inclusive: true }))).toEqual([[9, 14]]);
			expect(hours(helpers.mergeIntervals([span(9, 9), span(9, 9)], { inclusive: true }))).toEqual([[9, 9]]);
		});

		it('accepts any iterable, returns new dates and does not mutate its input', function () {
			const input = [span(9, 12), span(10, 13)];
			const snapshot = hours(input);
			const result = helpers.mergeIntervals(new Set(input));
			expect(hours(result)).toEqual([[9, 13]]);
			expect(result[0].start).not.toBe(input[0].start);
			expect(hours(input)).toEqual(snapshot);
			expect(
				hours(
					helpers.mergeIntervals(
						(function* () {
							yield span(1, 2);
						})()
					)
				)
			).toEqual([[1, 2]]);
		});

		it('validates the intervals and the options', function () {
			expect(function () {
				helpers.mergeIntervals(null as any);
			}).toThrow(new TypeError('mergeIntervals: `intervals` must be an iterable of intervals, got null'));
			expect(function () {
				helpers.mergeIntervals('ab' as any);
			}).toThrow(new TypeError('mergeIntervals: `intervals` must be an iterable of intervals, got string'));
			expect(function () {
				helpers.mergeIntervals({} as any);
			}).toThrow(new TypeError('mergeIntervals: `intervals` must be an iterable of intervals, got object'));
			expect(function () {
				helpers.mergeIntervals([span(1, 2), null as any]);
			}).toThrow(new TypeError('mergeIntervals: `intervals[1]` must be an interval object, got null'));
			expect(function () {
				helpers.mergeIntervals([span(1, 2), span(3, 4), span(6, 5)]);
			}).toThrow(new RangeError('mergeIntervals: `intervals[2].start` must not be after `intervals[2].end`'));
			expect(function () {
				helpers.mergeIntervals([{ start: '2024' as any, end: 1 }]);
			}).toThrow(TypeError);
			expect(function () {
				helpers.mergeIntervals([], 'inclusive' as any);
			}).toThrow(new TypeError('mergeIntervals: `options` must be an object, got string'));
		});
	});

	describe('subtractIntervals / findGaps', function () {
		it('subtractIntervals removes every part covered by an interval', function () {
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(12, 13)]))).toEqual([
				[9, 12],
				[13, 17]
			]);
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(8, 10), span(16, 18)]))).toEqual([[10, 16]]);
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(8, 18)]))).toEqual([]);
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(14, 15), span(10, 12), span(11, 13), span(13, 14)]))).toEqual([
				[9, 10],
				[15, 17]
			]);
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(1, 2), span(18, 19), span(17, 20), span(5, 9)]))).toEqual([[9, 17]]);
			expect(hours(helpers.subtractIntervals(span(9, 17), []))).toEqual([[9, 17]]);
			expect(hours(helpers.subtractIntervals(span(9, 17), [span(12, 12)]))).toEqual([[9, 17]]);
			expect(hours(helpers.subtractIntervals(span(9, 9), [span(1, 2)]))).toEqual([]);
		});

		it('findGaps returns the free slots, optionally only the long enough ones', function () {
			const busy = [span(10, 11), span(11.5, 12), span(12, 12.5), span(15, 16)];
			expect(hours(helpers.findGaps(span(9, 17), busy))).toEqual([
				[9, 10],
				[11, 11.5],
				[12.5, 15],
				[16, 17]
			]);
			expect(hours(helpers.findGaps(span(9, 17), busy, { minDuration: 3_600_000 }))).toEqual([
				[9, 10],
				[12.5, 15],
				[16, 17]
			]);
			expect(hours(helpers.findGaps(span(9, 17), busy, { minDuration: 3_600_001 }))).toEqual([[12.5, 15]]);
			expect(hours(helpers.findGaps(span(9, 17), busy, { minDuration: 0 }))).toHaveLength(4);
			expect(helpers.findGaps(span(9, 17), busy, { minDuration: Infinity })).toEqual([]);
			expect(helpers.findGaps({ start: 0, end: 10 }, [{ start: 1, end: 9 }])).toEqual([
				{ start: new Date(0), end: new Date(1) },
				{ start: new Date(9), end: new Date(10) }
			]);
		});

		it('validates the intervals and the options', function () {
			expect(function () {
				helpers.subtractIntervals(null as any, []);
			}).toThrow(new TypeError('subtractIntervals: `from` must be an interval object, got null'));
			expect(function () {
				helpers.subtractIntervals(span(1, 2), [span(3, 2)]);
			}).toThrow(new RangeError('subtractIntervals: `remove[0].start` must not be after `remove[0].end`'));
			expect(function () {
				helpers.subtractIntervals(span(1, 2), 5 as any);
			}).toThrow(new TypeError('subtractIntervals: `remove` must be an iterable of intervals, got number'));
			expect(function () {
				helpers.findGaps(span(2, 1), []);
			}).toThrow(new RangeError('findGaps: `within.start` must not be after `within.end`'));
			expect(function () {
				helpers.findGaps(span(1, 2), [undefined as any]);
			}).toThrow(new TypeError('findGaps: `busy[0]` must be an interval object, got undefined'));
			expect(function () {
				helpers.findGaps(span(1, 2), [], { minDuration: -1 });
			}).toThrow(new RangeError('findGaps: `minDuration` must be a number >= 0, got -1'));
			expect(function () {
				helpers.findGaps(span(1, 2), [], { minDuration: NaN });
			}).toThrow(new RangeError('findGaps: `minDuration` must be a number >= 0, got NaN'));
			expect(function () {
				helpers.findGaps(span(1, 2), [], { minDuration: '5' as any });
			}).toThrow(new TypeError('findGaps: `minDuration` must be a number >= 0, got string'));
			expect(function () {
				helpers.findGaps(span(1, 2), [], null as any);
			}).toThrow(new TypeError('findGaps: `options` must be an object, got null'));
		});
	});

	describe('addBusinessDays / diffInBusinessDays / isBusinessDay with options', function () {
		// 2024-12-23 is a Monday; Christmas is on Wednesday the 25th, Boxing Day on Thursday the 26th.
		const christmas = [new Date(2024, 11, 25), new Date(2024, 11, 26, 18)];

		it('skips holidays, compared by local calendar day', function () {
			expect(parts(helpers.addBusinessDays(new Date(2024, 11, 24, 9), 1, { holidays: christmas }))).toEqual([2024, 11, 27, 9, 0, 0, 0]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 24), 2, { holidays: christmas }))).toEqual([2024, 11, 30]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 27), -1, { holidays: christmas }))).toEqual([2024, 11, 24]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 30), -4, { holidays: christmas }))).toEqual([2024, 11, 20]);
			// Starting on a holiday: the next business day in the direction of travel is the first step.
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 25), 1, { holidays: christmas }))).toEqual([2024, 11, 27]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 25), -1, { holidays: christmas }))).toEqual([2024, 11, 24]);
			expect(parts(helpers.addBusinessDays(new Date(2024, 11, 25, 7), 0, { holidays: christmas }))).toEqual([2024, 11, 25, 7, 0, 0, 0]);
			// A holiday on a weekend day changes nothing.
			expect(ymd(helpers.addBusinessDays(new Date(2024, 11, 27), 1, { holidays: [new Date(2024, 11, 28), new Date(2024, 11, 29)] }))).toEqual([2024, 11, 30]);
		});

		it('crosses long runs of holidays and repeated ones', function () {
			const holidays: number[] = [];
			for (let day = 1; day <= 60; day++) holidays.push(new Date(2024, 0, day, 12).getTime(), new Date(2024, 0, day).getTime());
			expect(ymd(helpers.addBusinessDays(new Date(2023, 11, 29), 1, { holidays }))).toEqual([2024, 2, 1]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 2, 1), -1, { holidays }))).toEqual([2023, 11, 29]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 2, 1), -2, { holidays: new Set(holidays) }))).toEqual([2023, 11, 28]);
			expect(helpers.diffInBusinessDays(new Date(2024, 2, 1), new Date(2023, 11, 29), { holidays })).toBe(1);
			expect(helpers.diffInBusinessDays(new Date(2023, 11, 29), new Date(2024, 2, 1), { holidays })).toBe(-1);
		});

		it('supports other weekends', function () {
			// 2024-05-16 is a Thursday.
			const fridaySaturday = { weekend: [5, 6] as helpers.WeekdayIndex[] };
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 16), 1, fridaySaturday))).toEqual([2024, 4, 19]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 19), -1, fridaySaturday))).toEqual([2024, 4, 16]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 17), 1, fridaySaturday))).toEqual([2024, 4, 19]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 16), 5, fridaySaturday))).toEqual([2024, 4, 23]);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 19), new Date(2024, 4, 16), fridaySaturday)).toBe(1);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 16), 3, { weekend: [] }))).toEqual([2024, 4, 19]);
			expect(helpers.diffInBusinessDays(new Date(2024, 4, 31), new Date(2024, 4, 1), { weekend: [] })).toBe(30);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 18), 1, { weekend: [0, 0] }))).toEqual([2024, 4, 20]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 18), 13, { weekend: [0, 1, 2, 3, 4, 5] }))).toEqual([2024, 7, 17]);
			expect(helpers.diffInBusinessDays(new Date(2024, 7, 17), new Date(2024, 4, 18), { weekend: [0, 1, 2, 3, 4, 5] })).toBe(13);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 16), 2, { weekend: [5, 6], holidays: [new Date(2024, 4, 19), new Date(2024, 4, 17)] }))).toEqual([
				2024, 4, 21
			]);
		});

		it('isBusinessDay', function () {
			expect(helpers.isBusinessDay(new Date(2024, 4, 17))).toBe(true);
			expect(helpers.isBusinessDay(new Date(2024, 4, 18))).toBe(false);
			expect(helpers.isBusinessDay(new Date(2024, 4, 19).getTime())).toBe(false);
			expect(helpers.isBusinessDay(new Date(2024, 4, 17), { weekend: [5, 6] })).toBe(false);
			expect(helpers.isBusinessDay(new Date(2024, 4, 19), { weekend: [5, 6] })).toBe(true);
			expect(helpers.isBusinessDay(new Date(2024, 11, 26, 1), { holidays: christmas })).toBe(false);
			expect(helpers.isBusinessDay(new Date(2024, 11, 27, 1), { holidays: christmas })).toBe(true);
			expect(helpers.isBusinessDay(new Date(2024, 11, 24, 23, 59), { holidays: christmas })).toBe(true);
			expect(helpers.isBusinessDay(new Date(2024, 11, 24), {})).toBe(true);
			// A weekend day behind a getter is read once: the day that is validated is the one that is used.
			let reads = 0;
			const shifty = [] as helpers.WeekdayIndex[];
			Object.defineProperty(shifty, 0, {
				get: function () {
					return reads++ === 0 ? 0 : 3;
				},
				enumerable: true
			});
			expect(helpers.isBusinessDay(new Date(2024, 4, 15), { weekend: shifty })).toBe(true);
			expect(function () {
				helpers.isBusinessDay(INVALID);
			}).toThrow(new RangeError('Invalid date'));
		});

		it('keeps the default calendar for empty options and inherited ones', function () {
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 17), 1, {}))).toEqual([2024, 4, 20]);
			expect(ymd(helpers.addBusinessDays(new Date(2024, 4, 17), 1, { holidays: undefined, weekend: undefined }))).toEqual([2024, 4, 20]);
			polluted('weekend', [5, 6], function () {
				expect(helpers.isBusinessDay(new Date(2024, 4, 17), {})).toBe(true);
			});
			polluted('holidays', [new Date(2024, 4, 17)], function () {
				expect(helpers.isBusinessDay(new Date(2024, 4, 17), {})).toBe(true);
				expect(helpers.diffInBusinessDays(new Date(2024, 4, 20), new Date(2024, 4, 16), {})).toBe(2);
			});
		});

		it('validates the options', function () {
			const monday = new Date(2024, 4, 13);
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.addBusinessDays(monday, 1, null as any);
					},
					new TypeError('addBusinessDays: `options` must be an object, got null')
				],
				[
					function () {
						return helpers.diffInBusinessDays(monday, monday, { weekend: 6 as any });
					},
					new TypeError('diffInBusinessDays: `weekend` must be an array of weekday indices, got number')
				],
				[
					function () {
						return helpers.isBusinessDay(monday, { weekend: [7 as any] });
					},
					new RangeError('isBusinessDay: `weekend[0]` must be an integer between 0 and 6, got 7')
				],
				[
					function () {
						return helpers.isBusinessDay(monday, { weekend: [0, '6' as any] });
					},
					new TypeError('isBusinessDay: `weekend[1]` must be an integer between 0 and 6, got string')
				],
				[
					function () {
						const sparse: helpers.WeekdayIndex[] = [0];
						sparse[2] = 6;
						return helpers.isBusinessDay(monday, { weekend: sparse });
					},
					new TypeError('isBusinessDay: `weekend[1]` must be an integer between 0 and 6, got undefined')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { weekend: [0, 1, 2, 3, 4, 5, 6, 6] });
					},
					new RangeError('addBusinessDays: `weekend` must leave at least one business day in the week')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: 5 as any });
					},
					new TypeError('addBusinessDays: `holidays` must be an iterable of dates, got number')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: '2024-05-14' as any });
					},
					new TypeError('addBusinessDays: `holidays` must be an iterable of dates, got string')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: null as any });
					},
					new TypeError('addBusinessDays: `holidays` must be an iterable of dates, got null')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: {} as any });
					},
					new TypeError('addBusinessDays: `holidays` must be an iterable of dates, got object')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: [INVALID] });
					},
					new RangeError('Invalid date')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1, { holidays: ['2024-05-14' as any] });
					},
					new TypeError('Expected a Date or a timestamp number')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, 1e15, { holidays: [monday] });
					},
					new RangeError('Resulting date is out of range')
				],
				[
					function () {
						return helpers.addBusinessDays(monday, -1e15, { weekend: [5, 6] });
					},
					new RangeError('Resulting date is out of range')
				]
			];
			cases.forEach(function ([fn, error]) {
				expect(fn).toThrow(error);
			});
		});
	});

	describe('setParts', function () {
		it('replaces the given local fields and keeps the others', function () {
			const date = new Date(2024, 4, 15, 9, 30, 45, 123);
			expect(parts(helpers.setParts(date, { hour: 14, minute: 0 }))).toEqual([2024, 4, 15, 14, 0, 45, 123]);
			expect(parts(helpers.setParts(date, { year: 2020, month: 1, day: 2 }))).toEqual([2020, 0, 2, 9, 30, 45, 123]);
			expect(parts(helpers.setParts(date, { second: 0, millisecond: 999 }))).toEqual([2024, 4, 15, 9, 30, 0, 999]);
			expect(parts(helpers.setParts(date.getTime(), { month: 12, day: 31, hour: 23, minute: 59 }))).toEqual([2024, 11, 31, 23, 59, 45, 123]);
			expect(parts(date)).toEqual([2024, 4, 15, 9, 30, 45, 123]);
			expect(helpers.setParts(date, {})).not.toBe(date);
			expect(helpers.setParts(date, {}).getTime()).toBe(date.getTime());
			expect(helpers.setParts(date, { hour: 9, unknown: 1 } as helpers.DateParts).getTime()).toBe(date.getTime());
		});

		it('clamps the kept day of the month to the new month, and rejects a day the month does not have', function () {
			expect(parts(helpers.setParts(new Date(2024, 0, 31, 9), { month: 2 }))).toEqual([2024, 1, 29, 9, 0, 0, 0]);
			expect(parts(helpers.setParts(new Date(2023, 0, 31, 9), { month: 4 }))).toEqual([2023, 3, 30, 9, 0, 0, 0]);
			expect(ymd(helpers.setParts(new Date(2024, 1, 29), { year: 2023 }))).toEqual([2023, 1, 28]);
			expect(ymd(helpers.setParts(new Date(2024, 1, 29), { year: 2028 }))).toEqual([2028, 1, 29]);
			expect(ymd(helpers.setParts(new Date(2024, 0, 31), { month: 2, day: 29 }))).toEqual([2024, 1, 29]);
			expect(function () {
				helpers.setParts(new Date(2024, 0, 31), { month: 2, day: 30 });
			}).toThrow(new RangeError('setParts: `parts.day` must be an integer between 1 and 29, got 30'));
			expect(function () {
				helpers.setParts(new Date(2023, 1, 1), { day: 29 });
			}).toThrow(new RangeError('setParts: `parts.day` must be an integer between 1 and 28, got 29'));
		});

		it('does not remap the years 0-99, and rejects out-of-range results', function () {
			expect(helpers.setParts(new Date(2024, 4, 15), { year: 50 }).getFullYear()).toBe(50);
			expect(helpers.setParts(new Date(2024, 4, 15), { year: -1 }).getFullYear()).toBe(-1);
			expect(function () {
				helpers.setParts(new Date(2024, 4, 15), { year: 300_000 });
			}).toThrow(new RangeError('Resulting date is out of range'));
			expect(function () {
				helpers.setParts(new Date(2024, 4, 15), { year: 1e300 });
			}).toThrow(new RangeError('Resulting date is out of range'));
		});

		it('validates every field', function () {
			const date = new Date(2024, 4, 15);
			const cases: Array<[helpers.DateParts, Error]> = [
				[{ year: 2024.5 }, new RangeError('setParts: `parts.year` must be an integer, got 2024.5')],
				[{ year: '2024' as any }, new TypeError('setParts: `parts.year` must be an integer, got string')],
				[{ month: 0 }, new RangeError('setParts: `parts.month` must be an integer between 1 and 12, got 0')],
				[{ month: 13 }, new RangeError('setParts: `parts.month` must be an integer between 1 and 12, got 13')],
				[{ day: 0 }, new RangeError('setParts: `parts.day` must be an integer between 1 and 31, got 0')],
				[{ hour: 24 }, new RangeError('setParts: `parts.hour` must be an integer between 0 and 23, got 24')],
				[{ hour: -1 }, new RangeError('setParts: `parts.hour` must be an integer between 0 and 23, got -1')],
				[{ minute: 60 }, new RangeError('setParts: `parts.minute` must be an integer between 0 and 59, got 60')],
				[{ second: 1.5 }, new RangeError('setParts: `parts.second` must be an integer between 0 and 59, got 1.5')],
				[{ millisecond: 1000 }, new RangeError('setParts: `parts.millisecond` must be an integer between 0 and 999, got 1000')],
				[{ hour: null as any }, new TypeError('setParts: `parts.hour` must be an integer between 0 and 23, got null')]
			];
			cases.forEach(function ([fields, error]) {
				expect(function () {
					helpers.setParts(date, fields);
				}).toThrow(error);
			});
			expect(function () {
				helpers.setParts(date, null as any);
			}).toThrow(new TypeError('setParts: `parts` must be an object, got null'));
			expect(function () {
				helpers.setParts(INVALID, {});
			}).toThrow(new RangeError('Invalid date'));
		});

		it('ignores inherited fields', function () {
			polluted('hour', 5, function () {
				expect(parts(helpers.setParts(new Date(2024, 4, 15, 9), { minute: 1 }))).toEqual([2024, 4, 15, 9, 1, 0, 0]);
			});
		});

		it('moves a skipped time forward, and keeps the instant when nothing changes in a repeated hour', function () {
			withTimeZone('America/New_York', function () {
				// 2024-03-10 02:00 → 03:00; 2024-11-03 02:00 → 01:00.
				expect(helpers.setParts(new Date(2024, 2, 10, 9), { hour: 2, minute: 30 }).getTime()).toBe(Date.UTC(2024, 2, 10, 7, 30));
				const second = Date.UTC(2024, 10, 3, 6, 30);
				expect(helpers.setParts(second, {}).getTime()).toBe(second);
				expect(helpers.setParts(second, { hour: 1, minute: 30 }).getTime()).toBe(second);
				expect(helpers.setParts(second, { minute: 45 }).getTime()).toBe(Date.UTC(2024, 10, 3, 5, 45));
				// From a day with a different offset, in a single conversion.
				expect(helpers.setParts(new Date(2024, 6, 4, 23, 30), { month: 3, day: 10, hour: 0 }).getTime()).toBe(Date.UTC(2024, 2, 10, 5, 30));
			});
			withTimeZone('Pacific/Apia', function () {
				// Samoa skipped December 30th, 2011.
				expect(parts(helpers.setParts(new Date(2011, 11, 29, 10), { day: 30 }))).toEqual([2011, 11, 31, 10, 0, 0, 0]);
			});
		});
	});

	describe('closestTo', function () {
		it('returns a copy of the closest date, the first one on a tie', function () {
			const target = new Date(2024, 0, 10);
			const candidates = [new Date(2024, 0, 1), new Date(2024, 0, 12), new Date(2024, 0, 9), new Date(2024, 0, 11)];
			const result = helpers.closestTo(target, candidates) as Date;
			expect(ymd(result)).toEqual([2024, 0, 9]);
			expect(result).not.toBe(candidates[2]);
			expect(helpers.closestTo(target, [new Date(2024, 0, 11), new Date(2024, 0, 9)])).toEqual(new Date(2024, 0, 11));
			expect(helpers.closestTo(10, new Set([3, 25, 12]))).toEqual(new Date(12));
			expect(helpers.closestTo(10, [10])).toEqual(new Date(10));
			expect(helpers.closestTo(target, [])).toBeUndefined();
		});

		it('validates the dates', function () {
			expect(function () {
				helpers.closestTo(0, [1, INVALID]);
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				helpers.closestTo(INVALID, []);
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	describe('fromUnixTime / getUnixTime', function () {
		it('converts seconds since the epoch', function () {
			expect(helpers.fromUnixTime(0).getTime()).toBe(0);
			expect(helpers.fromUnixTime(-1.5).getTime()).toBe(-1500);
			expect(helpers.fromUnixTime(0.0015).getTime()).toBe(1);
			expect(helpers.fromUnixTime(8.64e12).getTime()).toBe(8.64e15);
			expect(helpers.getUnixTime(new Date(1999))).toBe(1);
		});

		it('keeps the milliseconds as written, although the decimal fraction is rounded below them', function () {
			// `1.001 * 1000` is `1000.9999999999999`: truncating it would lose a millisecond.
			expect(helpers.fromUnixTime(1.001).getTime()).toBe(1001);
			expect(helpers.fromUnixTime(-1.001).getTime()).toBe(-1001);
			for (const base of [0, 1, 59, 1_700_000_000, -86_400]) {
				for (let ms = 0; ms < 1000; ms++) {
					const written = Number(`${base}.${String(ms).padStart(3, '0')}`);
					expect(helpers.fromUnixTime(written).getTime()).toBe(base * 1000 + (base < 0 ? -ms : ms));
				}
			}
			// Microsecond timestamps (Python, Postgres): the sub-millisecond digits are dropped, never rounded up.
			expect(helpers.fromUnixTime(1700000000.000999).getTime()).toBe(1700000000000);
			expect(helpers.fromUnixTime(-1700000000.000999).getTime()).toBe(-1700000000000);
			expect(helpers.fromUnixTime(100000000000.00095).getTime()).toBe(100000000000000);
			expect(helpers.fromUnixTime(-0.5).getTime()).toBe(-500);
			expect(helpers.fromUnixTime(-0.0015).getTime()).toBe(-1);
			// Exponent notation: tiny magnitudes are 0 ms, huge ones out of range.
			expect(helpers.fromUnixTime(1e-7).getTime()).toBe(0);
			expect(function () {
				return helpers.fromUnixTime(1e21);
			}).toThrow(RangeError);
			// A real fraction of a millisecond is still truncated toward zero.
			expect(helpers.fromUnixTime(1.0019).getTime()).toBe(1001);
			expect(helpers.fromUnixTime(1.0009999).getTime()).toBe(1000);
			expect(helpers.fromUnixTime(-1.0019).getTime()).toBe(-1001);
			expect(helpers.getUnixTime(2000)).toBe(2);
			expect(Object.is(helpers.getUnixTime(999), 0)).toBe(true);
			expect(Object.is(helpers.getUnixTime(-0), 0)).toBe(true);
			expect(helpers.getUnixTime(-1)).toBe(-1);
			expect(helpers.getUnixTime(-1000)).toBe(-1);
			expect(helpers.getUnixTime(-1001)).toBe(-2);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.fromUnixTime('1' as any);
			}).toThrow(new TypeError('fromUnixTime: `seconds` must be a finite number, got string'));
			expect(function () {
				helpers.fromUnixTime(NaN);
			}).toThrow(new RangeError('fromUnixTime: `seconds` must be a finite number, got NaN'));
			expect(function () {
				helpers.fromUnixTime(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.fromUnixTime(8.64e12 + 1);
			}).toThrow(new RangeError('Resulting date is out of range'));
			expect(function () {
				helpers.getUnixTime(INVALID);
			}).toThrow(new RangeError('Invalid date'));
		});
	});

	it('intervalsOverlap and the interval helpers ignore inherited bounds and options', function () {
		polluted('inclusive', true, function () {
			expect(helpers.intervalsOverlap(span(9, 12), span(12, 14), {})).toBe(false);
			expect(helpers.intersectIntervals(span(9, 12), span(12, 14))).toBeUndefined();
			expect(helpers.mergeIntervals([span(9, 12), span(12, 14)])).toHaveLength(2);
		});
		polluted('minDuration', 1e12, function () {
			expect(helpers.findGaps(span(9, 17), [span(10, 11)])).toHaveLength(2);
		});
		polluted('start', 0, function () {
			expect(function () {
				helpers.mergeIntervals([{ end: 5 } as any]);
			}).toThrow(new TypeError('Expected a Date or a timestamp number'));
		});
		class Slot {
			get start(): number {
				return 1;
			}
			get end(): number {
				return 3;
			}
		}
		expect(helpers.mergeIntervals([new Slot(), { start: 2, end: 4 }])).toEqual([{ start: new Date(1), end: new Date(4) }]);
	});
});

describe('Cron', function () {
	const MINUTE = 60_000;
	const HOUR = 3_600_000;
	const DAY = 86_400_000;

	/**
	 * The successive dates of a cron expression, formatted on the wall clock of `timeZone` with its offset.
	 */
	function walls(cron: string, from: number, limit: number, timeZone = 'UTC'): string[] {
		return Array.from(helpers.eachCronDate(cron, { from, limit, timeZone }), function (date) {
			return helpers.formatInTimeZone(date, timeZone, 'YYYY-MM-DD HH:mm:ss Z');
		});
	}

	/**
	 * The date before `from`, formatted like {@link walls}.
	 */
	function previousWall(cron: string, from: number, timeZone = 'UTC', inclusive = false): string | undefined {
		const date = helpers.previousCronDate(cron, { from, timeZone, inclusive });

		return date && helpers.formatInTimeZone(date, timeZone, 'YYYY-MM-DD HH:mm:ss Z');
	}

	/**
	 * The time of the next date, or `undefined`.
	 */
	function next(cron: string | helpers.Cron, from: number, timeZone = 'UTC'): number | undefined {
		return helpers.nextCronDate(cron, { from, timeZone })?.getTime();
	}

	describe('parseCron', function () {
		it('returns a frozen null-prototype handle holding the trimmed expression', function () {
			const cron = helpers.parseCron(' \t*/5 * * * *\n');

			expect(cron.expression).toBe('*/5 * * * *');
			expect(Object.isFrozen(cron)).toBe(true);
			expect(Object.getPrototypeOf(cron)).toBeNull();
			expect(Object.keys(cron)).toEqual(['expression']);
			expect(helpers.parseCron('*/5 * * * *')).not.toBe(cron);
			expect(next(cron, 0)).toBe(5 * MINUTE);
		});

		it('reads lists, ranges, steps and names', function () {
			expect(walls('5,10-12,50/4 * * * *', Date.UTC(2024, 0, 1), 8)).toEqual([
				'2024-01-01 00:05:00 +00:00',
				'2024-01-01 00:10:00 +00:00',
				'2024-01-01 00:11:00 +00:00',
				'2024-01-01 00:12:00 +00:00',
				'2024-01-01 00:50:00 +00:00',
				'2024-01-01 00:54:00 +00:00',
				'2024-01-01 00:58:00 +00:00',
				'2024-01-01 01:05:00 +00:00'
			]);
			expect(walls('0 0-23/7 * * *', Date.UTC(2024, 0, 1), 5)).toEqual([
				'2024-01-01 07:00:00 +00:00',
				'2024-01-01 14:00:00 +00:00',
				'2024-01-01 21:00:00 +00:00',
				'2024-01-02 00:00:00 +00:00',
				'2024-01-02 07:00:00 +00:00'
			]);
			expect(walls('0 0 1 jan,Jul *', Date.UTC(2024, 0, 2), 3)).toEqual(['2024-07-01 00:00:00 +00:00', '2025-01-01 00:00:00 +00:00', '2025-07-01 00:00:00 +00:00']);
		});

		it('rejects a reversed name range', function () {
			expect(function () {
				helpers.parseCron('0 0 * * SAT-SUN');
			}).toThrow(new RangeError('parseCron: the day-of-week field ranges must not be reversed, got "SAT-SUN"'));
			expect(walls('0 0 * * 6-7', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-06 00:00:00 +00:00', '2024-01-07 00:00:00 +00:00', '2024-01-13 00:00:00 +00:00']);
		});

		it('reads zero-padded values, and 7 as Sunday', function () {
			expect(walls('07 09 * * 7', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-07 09:07:00 +00:00', '2024-01-14 09:07:00 +00:00']);
			expect(walls('0 0 * * 5-7', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-05 00:00:00 +00:00', '2024-01-06 00:00:00 +00:00', '2024-01-07 00:00:00 +00:00']);
			expect(walls('0 0 * * 3/3', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-03 00:00:00 +00:00', '2024-01-06 00:00:00 +00:00', '2024-01-10 00:00:00 +00:00']);
			// `*` covers 0-7, which gives the same set as 0-6 for every step.
			expect(walls('0 0 * * */7', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-07 00:00:00 +00:00', '2024-01-14 00:00:00 +00:00']);
			expect(walls('0 0 * * 1/7', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-08 00:00:00 +00:00', '2024-01-15 00:00:00 +00:00']);
		});

		it('takes a leading seconds field when there are 6 fields', function () {
			expect(walls('*/20 0 0 * * *', Date.UTC(2024, 0, 1), 4)).toEqual([
				'2024-01-01 00:00:20 +00:00',
				'2024-01-01 00:00:40 +00:00',
				'2024-01-02 00:00:00 +00:00',
				'2024-01-02 00:00:20 +00:00'
			]);
			expect(walls('59 59 23 31 12 *', Date.UTC(2024, 0, 1), 1)).toEqual(['2024-12-31 23:59:59 +00:00']);
			expect(walls('30 29,30,59 * * * *', Date.UTC(2024, 0, 1), 4)).toEqual([
				'2024-01-01 00:29:30 +00:00',
				'2024-01-01 00:30:30 +00:00',
				'2024-01-01 00:59:30 +00:00',
				'2024-01-01 01:29:30 +00:00'
			]);
		});

		it('expands the macros', function () {
			const from = Date.UTC(2024, 4, 15, 10, 30);
			const pairs: Array<[string, string]> = [
				['@yearly', '0 0 1 1 *'],
				['@annually', '0 0 1 1 *'],
				['@monthly', '0 0 1 * *'],
				['@weekly', '0 0 * * 0'],
				['@daily', '0 0 * * *'],
				['@midnight', '0 0 * * *'],
				['@hourly', '0 * * * *'],
				['@HOURLY', '0 * * * *']
			];

			for (const [macro, expression] of pairs) {
				expect(walls(macro, from, 3)).toEqual(walls(expression, from, 3));
				expect(helpers.parseCron(` ${macro} `).expression).toBe(macro);
			}
		});

		it('combines the day of the month and the day of the week like Vixie cron', function () {
			// Both restricted: either one matches (the 13th, or a Friday).
			expect(walls('0 0 13 * 5', Date.UTC(2024, 8, 1), 4)).toEqual([
				'2024-09-06 00:00:00 +00:00',
				'2024-09-13 00:00:00 +00:00',
				'2024-09-20 00:00:00 +00:00',
				'2024-09-27 00:00:00 +00:00'
			]);
			expect(walls('0 0 1,15 * MON', Date.UTC(2024, 0, 9), 3)).toEqual(['2024-01-15 00:00:00 +00:00', '2024-01-22 00:00:00 +00:00', '2024-01-29 00:00:00 +00:00']);
			// A field starting with `*` (even `*\/2`) is unrestricted: both must match.
			expect(walls('0 0 */2 * 1', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-15 00:00:00 +00:00', '2024-01-29 00:00:00 +00:00', '2024-02-05 00:00:00 +00:00']);
			expect(walls('0 0 13 * */1', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-13 00:00:00 +00:00', '2024-02-13 00:00:00 +00:00']);
			// Only the first character counts, as in cronie.
			expect(walls('0 0 13,* * 5', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-02 00:00:00 +00:00', '2024-01-03 00:00:00 +00:00']);
		});

		it('reads L, wL and w#k', function () {
			expect(walls('0 0 L * *', Date.UTC(2023, 0, 1), 3)).toEqual(['2023-01-31 00:00:00 +00:00', '2023-02-28 00:00:00 +00:00', '2023-03-31 00:00:00 +00:00']);
			expect(walls('0 0 L 2 *', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-02-29 00:00:00 +00:00', '2025-02-28 00:00:00 +00:00']);
			expect(walls('0 0 1,15,l * *', Date.UTC(2024, 3, 2), 3)).toEqual(['2024-04-15 00:00:00 +00:00', '2024-04-30 00:00:00 +00:00', '2024-05-01 00:00:00 +00:00']);
			expect(walls('0 0 * * 5L', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-26 00:00:00 +00:00', '2024-02-23 00:00:00 +00:00', '2024-03-29 00:00:00 +00:00']);
			expect(walls('0 0 * * FriL,0l', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-26 00:00:00 +00:00', '2024-01-28 00:00:00 +00:00', '2024-02-23 00:00:00 +00:00']);
			expect(walls('0 0 * * 7L', Date.UTC(2024, 0, 1), 1)).toEqual(['2024-01-28 00:00:00 +00:00']);
			// January 24th is a Wednesday 7 days before the end, not the last one.
			expect(walls('0 0 * * 3L', Date.UTC(2024, 0, 1), 1)).toEqual(['2024-01-31 00:00:00 +00:00']);
			expect(walls('0 0 * * MON#1,1#3', Date.UTC(2024, 0, 2), 3)).toEqual(['2024-01-15 00:00:00 +00:00', '2024-02-05 00:00:00 +00:00', '2024-02-19 00:00:00 +00:00']);
			expect(walls('0 0 * * 2#4,3#2', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-01-10 00:00:00 +00:00', '2024-01-23 00:00:00 +00:00']);
			// The fifth Thursday: only in months with five.
			expect(walls('0 0 * * 4#5', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-02-29 00:00:00 +00:00', '2024-05-30 00:00:00 +00:00', '2024-08-29 00:00:00 +00:00']);
			// With a restricted day of the month: either.
			expect(walls('0 0 10 * 5L', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-10 00:00:00 +00:00', '2024-01-26 00:00:00 +00:00', '2024-02-10 00:00:00 +00:00']);
		});

		it('accepts expressions that never fire, which then have no dates', function () {
			for (const expression of ['0 0 30 2 *', '0 0 31 2,4,6,9,11 *', '0 0 30,31 feb *']) {
				const cron = helpers.parseCron(expression);

				expect(helpers.nextCronDate(cron, { from: 0, timeZone: 'UTC' })).toBeUndefined();
				expect(helpers.previousCronDate(cron, { from: 0, timeZone: 'UTC' })).toBeUndefined();
				expect([...helpers.eachCronDate(cron, { from: 0, timeZone: 'UTC' })]).toEqual([]);
				expect(helpers.isCronMatch(cron, 0)).toBe(false);
			}
			// Rare but possible: odd days AND the fifth Monday of February, so a Monday February 29th (2016, then 2044).
			expect(walls('0 0 */2 2 1#5', Date.UTC(2017, 0, 1), 2)).toEqual(['2044-02-29 00:00:00 +00:00', '2072-02-29 00:00:00 +00:00']);
			expect(previousWall('0 0 */2 2 1#5', Date.UTC(2044, 0, 1))).toBe('2016-02-29 00:00:00 +00:00');
			expect(walls('0 0 29 2 *', Date.UTC(2096, 2, 1), 2)).toEqual(['2104-02-29 00:00:00 +00:00', '2108-02-29 00:00:00 +00:00']);
			// Days 1 and 22 that are the last Monday: only February 22nd of a common year can be, so April never matches.
			expect(walls('0 0 */21 2 1L', Date.UTC(2017, 0, 1), 2)).toEqual(['2021-02-22 00:00:00 +00:00', '2027-02-22 00:00:00 +00:00']);
			expect(helpers.nextCronDate('0 0 */21 4 1L', { from: 0, timeZone: 'UTC' })).toBeUndefined();
			expect(helpers.nextCronDate('0 0 */21 4 0L', { from: 0, timeZone: 'UTC' })).toBeUndefined();
			// Days 1 and 29 that are the last Monday: February 29th.
			expect(walls('0 0 */28 2 1L', Date.UTC(2017, 0, 1), 1)).toEqual(['2044-02-29 00:00:00 +00:00']);
		});

		it('rejects a value that is not a string', function () {
			expect(function () {
				helpers.parseCron(5 as any);
			}).toThrow(new TypeError('parseCron: `expression` must be a string, got number'));
			expect(function () {
				helpers.parseCron(null as any);
			}).toThrow(new TypeError('parseCron: `expression` must be a string, got null'));
		});

		it('rejects the wrong number of fields and unknown macros', function () {
			expect(function () {
				helpers.parseCron('');
			}).toThrow(new RangeError('parseCron: `expression` must have 5 fields, or 6 with seconds first, got 0 in ""'));
			expect(function () {
				helpers.parseCron('* * * *');
			}).toThrow(new RangeError('parseCron: `expression` must have 5 fields, or 6 with seconds first, got 4 in "* * * *"'));
			expect(function () {
				helpers.parseCron('0 0 0 1 1 * 2024');
			}).toThrow(new RangeError('parseCron: `expression` must have 5 fields, or 6 with seconds first, got 7 in "0 0 0 1 1 * 2024"'));
			const macros = '@yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly';

			expect(function () {
				helpers.parseCron('@reboot');
			}).toThrow(new RangeError(`parseCron: \`expression\` macros are ${macros}, got "@reboot"`));
			expect(function () {
				helpers.parseCron('@daily *');
			}).toThrow(new RangeError(`parseCron: \`expression\` macros are ${macros}, got "@daily *"`));
			// The expansions are not names.
			expect(function () {
				helpers.parseCron('@0 0 1 1 *');
			}).toThrow(RangeError);
		});

		it('rejects malformed items, naming the field', function () {
			const cases: Array<[string, string]> = [
				['1-, * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "1-,"'],
				['* -1 * * *', 'the hour field must be a list of *, values, ranges (a-b) and steps (/n), got "-1"'],
				['1,,2 * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "1,,2"'],
				['5, * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "5,"'],
				['*/ * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "*/"'],
				['*-5 * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "*-5"'],
				['+5 * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "+5"'],
				['1.5 * * * *', 'the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "1.5"'],
				['* * ? * *', 'the day-of-month field must be a list of *, values, ranges (a-b) and steps (/n) or L, got "?"'],
				['* * 15W * *', 'the day-of-month field values must be between 1 and 31, got "15W"'],
				['* * L-3 * *', 'the day-of-month field values must be between 1 and 31, got "L-3"'],
				['* * LW * *', 'the day-of-month field values must be between 1 and 31, got "LW"'],
				['* * L/2 * *', 'the day-of-month field values must be between 1 and 31, got "L/2"'],
				['* * * * ?', 'the day-of-week field must be a list of *, values, ranges (a-b) and steps (/n), nL or n#k, got "?"'],
				['* * * * 1-5L', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "1-5L"'],
				['* * * * L', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "L"'],
				['* * * * #2', 'the day-of-week field must be a list of *, values, ranges (a-b) and steps (/n), nL or n#k, got "#2"'],
				['* * * * 5L2', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "5L2"'],
				['* * * * 5#1x', 'the day-of-week field must be a list of *, values, ranges (a-b) and steps (/n), nL or n#k, got "5#1x"'],
				['* * * 1L *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "1L"'],
				['5L * * * *', 'the minute field values must be between 0 and 59, got "5L"'],
				['* * 1#2 * *', 'the day-of-month field must be a list of *, values, ranges (a-b) and steps (/n) or L, got "1#2"']
			];

			for (const [expression, message] of cases) {
				expect(function () {
					helpers.parseCron(expression);
				}).toThrow(new RangeError(`parseCron: ${message}`));
			}
		});

		it('rejects values out of range, unknown names, reversed ranges and bad steps', function () {
			const cases: Array<[string, string]> = [
				['60 * * * *', 'the minute field values must be between 0 and 59, got "60"'],
				['60 * * * * *', 'the second field values must be between 0 and 59, got "60"'],
				['* 24 * * *', 'the hour field values must be between 0 and 23, got "24"'],
				['* 0-24 * * *', 'the hour field values must be between 0 and 23, got "0-24"'],
				['* * 0 * *', 'the day-of-month field values must be between 1 and 31, got "0"'],
				['* * 32 * *', 'the day-of-month field values must be between 1 and 31, got "32"'],
				['* * * 0 *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "0"'],
				['* * * 13 *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "13"'],
				['* * * * 8', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "8"'],
				['* * * JANUARY *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "JANUARY"'],
				['* * * ANF *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "ANF"'],
				['* * * * MON-FRY', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "MON-FRY"'],
				['MON * * * *', 'the minute field values must be between 0 and 59, got "MON"'],
				['* * JAN * *', 'the day-of-month field values must be between 1 and 31, got "JAN"'],
				['* * * MON *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "MON"'],
				['* * * * JAN', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "JAN"'],
				['00000000000000000000000000060 * * * *', 'the minute field values must be between 0 and 59, got "00000000000000000000000000060"'],
				['5-1 * * * *', 'the minute field ranges must not be reversed, got "5-1"'],
				['* * * DEC-JAN *', 'the month field ranges must not be reversed, got "DEC-JAN"'],
				['*/0 * * * *', 'the minute field steps must be between 1 and 59, got "*/0"'],
				['*/60 * * * *', 'the minute field steps must be between 1 and 59, got "*/60"'],
				['* 1-5/24 * * *', 'the hour field steps must be between 1 and 23, got "1-5/24"'],
				['* * 1/32 * *', 'the day-of-month field steps must be between 1 and 31, got "1/32"'],
				['* * * */13 *', 'the month field steps must be between 1 and 12, got "*/13"'],
				['* * * * */8', 'the day-of-week field steps must be between 1 and 7, got "*/8"'],
				['* * * * 5#0', 'the day-of-week field occurrences (#) must be between 1 and 5, got "5#0"'],
				['* * * * 5#6', 'the day-of-week field occurrences (#) must be between 1 and 5, got "5#6"'],
				['* * * * 8L', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "8L"'],
				['* * * * 8#1', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "8#1"'],
				['* * * * 5#10', 'the day-of-week field occurrences (#) must be between 1 and 5, got "5#10"'],
				['0x1 * * * *', 'the minute field values must be between 0 and 59, got "0x1"'],
				['1e1 * * * *', 'the minute field values must be between 0 and 59, got "1e1"'],
				['* * * ja *', 'the month field values must be between 1 and 12 (or JAN-DEC), got "ja"'],
				['* * MON * *', 'the day-of-month field values must be between 1 and 31, got "MON"'],
				['* * * * mo', 'the day-of-week field values must be between 0 and 7 (or SUN-SAT), got "mo"']
			];

			for (const [expression, message] of cases) {
				expect(function () {
					helpers.parseCron(expression);
				}).toThrow(new RangeError(`parseCron: ${message}`));
			}
			// The largest steps.
			expect(walls('*/59 * * * *', Date.UTC(2024, 0, 1), 3)).toEqual(['2024-01-01 00:59:00 +00:00', '2024-01-01 01:00:00 +00:00', '2024-01-01 01:59:00 +00:00']);
			expect(walls('0 0 1 */12 *', Date.UTC(2024, 0, 1), 1)).toEqual(['2025-01-01 00:00:00 +00:00']);
			expect(walls('0 0 */31 * *', Date.UTC(2024, 0, 1), 2)).toEqual(['2024-02-01 00:00:00 +00:00', '2024-03-01 00:00:00 +00:00']);
		});

		it('shortens long items in the messages', function () {
			expect(function () {
				helpers.parseCron(`${'1,'.repeat(24)}1- * * * *`);
			}).toThrow(new RangeError(`parseCron: the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "${'1,'.repeat(24)}1-"`));
			expect(function () {
				helpers.parseCron(`${'1,'.repeat(40)}x * * * *`);
			}).toThrow(new RangeError(`parseCron: the minute field values must be between 0 and 59, got "x"`));
			expect(function () {
				helpers.parseCron(`${'1,'.repeat(40)}- * * * *`);
			}).toThrow(new RangeError(`parseCron: the minute field must be a list of *, values, ranges (a-b) and steps (/n), got "${'1,'.repeat(25)}…"`));
		});

		it('parses a long expression in linear time', function () {
			const start = performance.now();

			expect(function () {
				helpers.parseCron(`${'a'.repeat(200_000)}! * * * *`);
			}).toThrow(RangeError);
			expect(function () {
				helpers.parseCron(`* * * * ${'1'.repeat(200_000)}#`);
			}).toThrow(RangeError);
			expect(helpers.nextCronDate(`${'0,'.repeat(50_000)}0 * * * *`, { from: 0, timeZone: 'UTC' })?.getTime()).toBe(HOUR);
			expect(performance.now() - start).toBeLessThan(5000);
		});
	});

	describe('nextCronDate / previousCronDate', function () {
		it('finds the next and previous dates, strictly after and before `from` unless inclusive', function () {
			const from = Date.UTC(2024, 0, 1, 10, 15);

			expect(next('*/15 * * * *', from)).toBe(from + 15 * MINUTE);
			expect(helpers.nextCronDate('*/15 * * * *', { from, timeZone: 'UTC', inclusive: true })?.getTime()).toBe(from);
			expect(helpers.nextCronDate('*/15 * * * *', { from: from + 1, timeZone: 'UTC', inclusive: true })?.getTime()).toBe(from + 15 * MINUTE);
			expect(helpers.nextCronDate('*/15 * * * *', { from: from - 1, timeZone: 'UTC' })?.getTime()).toBe(from);
			expect(helpers.previousCronDate('*/15 * * * *', { from, timeZone: 'UTC' })?.getTime()).toBe(from - 15 * MINUTE);
			expect(helpers.previousCronDate('*/15 * * * *', { from, timeZone: 'UTC', inclusive: true })?.getTime()).toBe(from);
			expect(helpers.previousCronDate('*/15 * * * *', { from: from + 1, timeZone: 'UTC' })?.getTime()).toBe(from);
			expect(helpers.previousCronDate('*/15 * * * *', { from: from - 1, timeZone: 'UTC', inclusive: true })?.getTime()).toBe(from - 15 * MINUTE);
			expect(helpers.nextCronDate('*/15 * * * *', { from: new Date(from), timeZone: 'UTC' })).toEqual(new Date(from + 15 * MINUTE));
		});

		it('searches from now by default, in local time', function () {
			const before = Date.now();
			const date = helpers.nextCronDate('* * * * * *') as Date;

			expect(date.getTime()).toBeGreaterThan(before);
			expect(date.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
			expect(date.getMilliseconds()).toBe(0);
			expect((helpers.previousCronDate('* * * * * *') as Date).getTime()).toBeLessThanOrEqual(Date.now());
			expect(helpers.nextCronDate('0 9 * * 1-5', { from: new Date(2024, 0, 6) })).toEqual(new Date(2024, 0, 8, 9));
		});

		it('jumps over the fields, from seconds to years, forward and back', function () {
			expect(walls('0 0 0 29 2 *', Date.UTC(2023, 5, 1), 1)).toEqual(['2024-02-29 00:00:00 +00:00']);
			expect(previousWall('0 0 0 29 2 *', Date.UTC(2023, 5, 1))).toBe('2020-02-29 00:00:00 +00:00');
			expect(previousWall('59 59 23 31 12 *', Date.UTC(2024, 0, 1))).toBe('2023-12-31 23:59:59 +00:00');
			expect(previousWall('0 30 9 * * MON', Date.UTC(2024, 0, 1, 9, 30))).toBe('2023-12-25 09:30:00 +00:00');
			expect(previousWall('15,45 */2 * * *', Date.UTC(2024, 0, 1, 1))).toBe('2024-01-01 00:45:00 +00:00');
			expect(previousWall('15,45 */2 * * *', Date.UTC(2024, 0, 1, 0, 15))).toBe('2023-12-31 22:45:00 +00:00');
			expect(previousWall('20-25 3 * * *', Date.UTC(2024, 0, 1, 3, 23, 30))).toBe('2024-01-01 03:23:00 +00:00');
			expect(previousWall('10,40 0 * * * *', Date.UTC(2024, 0, 1, 5, 0, 30))).toBe('2024-01-01 05:00:10 +00:00');
			expect(previousWall('10,40 0 * * * *', Date.UTC(2024, 0, 1, 5, 0, 5))).toBe('2024-01-01 04:00:40 +00:00');
			expect(previousWall('40 0,30 * * * *', Date.UTC(2024, 0, 1, 5, 0, 5))).toBe('2024-01-01 04:30:40 +00:00');
			expect(previousWall('0 0 1 * *', Date.UTC(2024, 0, 1))).toBe('2023-12-01 00:00:00 +00:00');
			expect(previousWall('0 0 * 3 *', Date.UTC(2024, 1, 1))).toBe('2023-03-31 00:00:00 +00:00');
			expect(previousWall('0 0 * 3 *', Date.UTC(2024, 4, 1))).toBe('2024-03-31 00:00:00 +00:00');
			expect(previousWall('0 0 31 * *', Date.UTC(2024, 4, 1))).toBe('2024-03-31 00:00:00 +00:00');
			expect(walls('0 0 31 * *', Date.UTC(2024, 0, 31, 1), 2)).toEqual(['2024-03-31 00:00:00 +00:00', '2024-05-31 00:00:00 +00:00']);
			expect(walls('0 12 * * *', Date.UTC(2024, 11, 31, 13), 1)).toEqual(['2025-01-01 12:00:00 +00:00']);
			expect(walls('5 4 * * *', Date.UTC(2024, 0, 1, 4, 5, 0, 1), 1)).toEqual(['2024-01-02 04:05:00 +00:00']);
		});

		it('reads the wall clock of a fixed-offset time zone', function () {
			expect(walls('0 9 * * *', Date.UTC(2024, 0, 1), 2, '+05:30')).toEqual(['2024-01-01 09:00:00 +05:30', '2024-01-02 09:00:00 +05:30']);
			expect(next('0 0 1 1 *', Date.UTC(2024, 0, 1), '-03:00')).toBe(Date.UTC(2024, 0, 1, 3));
			expect(next('0 0 1 1 *', Date.UTC(2024, 0, 1, 3), '-03:00')).toBe(Date.UTC(2025, 0, 1, 3));
		});

		it('runs a fixed-time job skipped by the spring-forward gap once at its end, and a repeated one once (New York)', function () {
			const zone = 'America/New_York';

			expect(walls('30 2 * * *', Date.UTC(2024, 2, 9), 3, zone)).toEqual(['2024-03-09 02:30:00 -05:00', '2024-03-10 03:00:00 -04:00', '2024-03-11 02:30:00 -04:00']);
			// Several times in the gap: still one date.
			expect(walls('0,15,30 2 * * *', Date.UTC(2024, 2, 10, 6), 3, zone)).toEqual([
				'2024-03-10 03:00:00 -04:00',
				'2024-03-11 02:00:00 -04:00',
				'2024-03-11 02:15:00 -04:00'
			]);
			expect(walls('0 2-3 * * *', Date.UTC(2024, 2, 10, 6), 3, zone)).toEqual([
				'2024-03-10 03:00:00 -04:00',
				'2024-03-11 02:00:00 -04:00',
				'2024-03-11 03:00:00 -04:00'
			]);
			expect(walls('30 1 * * *', Date.UTC(2024, 10, 2), 3, zone)).toEqual(['2024-11-02 01:30:00 -04:00', '2024-11-03 01:30:00 -04:00', '2024-11-04 01:30:00 -05:00']);
			expect(walls('0-59/20 1 * * *', Date.UTC(2024, 10, 3, 5, 30), 4, zone)).toEqual([
				'2024-11-03 01:40:00 -04:00',
				'2024-11-04 01:00:00 -05:00',
				'2024-11-04 01:20:00 -05:00',
				'2024-11-04 01:40:00 -05:00'
			]);
			// From the second occurrence: the first one has passed.
			expect(walls('30 1 * * *', Date.UTC(2024, 10, 3, 6, 10), 1, zone)).toEqual(['2024-11-04 01:30:00 -05:00']);
			expect(walls('45 1 * * *', Date.UTC(2024, 10, 3, 6, 10), 1, zone)).toEqual(['2024-11-04 01:45:00 -05:00']);
			expect(walls('5 2 * * *', Date.UTC(2024, 10, 3, 6, 10), 1, zone)).toEqual(['2024-11-03 02:05:00 -05:00']);
			// The same, backward.
			expect(previousWall('30 2 * * *', Date.UTC(2024, 2, 10, 8), zone)).toBe('2024-03-10 03:00:00 -04:00');
			expect(previousWall('30 2 * * *', Date.UTC(2024, 2, 10, 7), zone)).toBe('2024-03-09 02:30:00 -05:00');
			expect(previousWall('30 2 * * *', Date.UTC(2024, 2, 10, 7), zone, true)).toBe('2024-03-10 03:00:00 -04:00');
			expect(previousWall('30 1 * * *', Date.UTC(2024, 10, 3, 7), zone)).toBe('2024-11-03 01:30:00 -04:00');
			expect(previousWall('15 1 * * *', Date.UTC(2024, 10, 3, 6, 30), zone)).toBe('2024-11-03 01:15:00 -04:00');
			expect(previousWall('50 1 * * *', Date.UTC(2024, 10, 3, 6, 30), zone)).toBe('2024-11-03 01:50:00 -04:00');
			expect(previousWall('50 0 * * *', Date.UTC(2024, 10, 3, 6, 30), zone)).toBe('2024-11-03 00:50:00 -04:00');
		});

		it('runs a wildcard job at the times the clocks show: none in the gap, both occurrences of a repeated time (New York)', function () {
			const zone = 'America/New_York';

			expect(walls('*/30 * * * *', Date.UTC(2024, 2, 10, 6), 3, zone)).toEqual([
				'2024-03-10 01:30:00 -05:00',
				'2024-03-10 03:00:00 -04:00',
				'2024-03-10 03:30:00 -04:00'
			]);
			expect(walls('30 2 * * * *', Date.UTC(2024, 2, 10, 6), 2, zone)).toEqual(['2024-03-10 01:02:30 -05:00', '2024-03-10 03:02:30 -04:00']);
			expect(walls('* 2 * * *', Date.UTC(2024, 2, 10, 6), 1, zone)).toEqual(['2024-03-11 02:00:00 -04:00']);
			expect(walls('*/20 * * * *', Date.UTC(2024, 10, 3, 5, 30), 7, zone)).toEqual([
				'2024-11-03 01:40:00 -04:00',
				'2024-11-03 01:00:00 -05:00',
				'2024-11-03 01:20:00 -05:00',
				'2024-11-03 01:40:00 -05:00',
				'2024-11-03 02:00:00 -05:00',
				'2024-11-03 02:20:00 -05:00',
				'2024-11-03 02:40:00 -05:00'
			]);
			expect(walls('0 * * * *', Date.UTC(2024, 10, 3, 4, 30), 4, zone)).toEqual([
				'2024-11-03 01:00:00 -04:00',
				'2024-11-03 01:00:00 -05:00',
				'2024-11-03 02:00:00 -05:00',
				'2024-11-03 03:00:00 -05:00'
			]);
			expect(previousWall('*/20 * * * *', Date.UTC(2024, 10, 3, 6, 10), zone)).toBe('2024-11-03 01:00:00 -05:00');
			expect(previousWall('*/20 * * * *', Date.UTC(2024, 10, 3, 6), zone)).toBe('2024-11-03 01:40:00 -04:00');
			expect(previousWall('*/20 * * * *', Date.UTC(2024, 10, 3, 7, 10), zone)).toBe('2024-11-03 02:00:00 -05:00');
			// Long after the change, the last firing can still be a second occurrence.
			expect(previousWall('* 1 * * *', Date.UTC(2024, 10, 3, 17), zone)).toBe('2024-11-03 01:59:00 -05:00');
			expect(previousWall('* 1 3 11 *', Date.UTC(2025, 0, 1), zone)).toBe('2024-11-03 01:59:00 -05:00');
			// A fixed-time job: the first occurrence.
			expect(previousWall('0 1 * * 0', Date.UTC(2024, 10, 3, 6, 30), zone)).toBe('2024-11-03 01:00:00 -04:00');
		});

		it('handles the 30-minute changes of Lord Howe Island and the hour of London and Havana', function () {
			expect(walls('0 2 * * *', Date.UTC(2024, 9, 4), 3, 'Australia/Lord_Howe')).toEqual([
				'2024-10-05 02:00:00 +10:30',
				'2024-10-06 02:30:00 +11:00',
				'2024-10-07 02:00:00 +11:00'
			]);
			expect(walls('*/15 * * * *', Date.UTC(2024, 3, 6, 14), 8, 'Australia/Lord_Howe')).toEqual([
				'2024-04-07 01:15:00 +11:00',
				'2024-04-07 01:30:00 +11:00',
				'2024-04-07 01:45:00 +11:00',
				'2024-04-07 01:30:00 +10:30',
				'2024-04-07 01:45:00 +10:30',
				'2024-04-07 02:00:00 +10:30',
				'2024-04-07 02:15:00 +10:30',
				'2024-04-07 02:30:00 +10:30'
			]);
			expect(walls('30 1 * * *', Date.UTC(2024, 3, 6), 2, 'Australia/Lord_Howe')).toEqual(['2024-04-07 01:30:00 +11:00', '2024-04-08 01:30:00 +10:30']);
			// From 01:50 in the repeated half hour: a fixed-time job's last firing is the first 01:40, a wildcard job's the second.
			expect(previousWall('40 1 * * *', Date.UTC(2024, 3, 6, 15, 20), 'Australia/Lord_Howe')).toBe('2024-04-07 01:40:00 +11:00');
			expect(previousWall('40 * * * *', Date.UTC(2024, 3, 6, 15, 20), 'Australia/Lord_Howe')).toBe('2024-04-07 01:40:00 +10:30');
			expect(walls('30 1 * * *', Date.UTC(2024, 2, 30), 2, 'Europe/London')).toEqual(['2024-03-30 01:30:00 +00:00', '2024-03-31 02:00:00 +01:00']);
			expect(walls('30 1 * * *', Date.UTC(2024, 9, 26, 12), 2, 'Europe/London')).toEqual(['2024-10-27 01:30:00 +01:00', '2024-10-28 01:30:00 +00:00']);
			// Havana skips midnight, then repeats it.
			expect(walls('0 0 * * *', Date.UTC(2024, 2, 9, 12), 2, 'America/Havana')).toEqual(['2024-03-10 01:00:00 -04:00', '2024-03-11 00:00:00 -04:00']);
			expect(walls('0 0 * * *', Date.UTC(2024, 10, 2, 12), 2, 'America/Havana')).toEqual(['2024-11-03 00:00:00 -04:00', '2024-11-04 00:00:00 -05:00']);
			expect(walls('0 * * * *', Date.UTC(2024, 10, 3, 3), 3, 'America/Havana')).toEqual([
				'2024-11-03 00:00:00 -04:00',
				'2024-11-03 00:00:00 -05:00',
				'2024-11-03 01:00:00 -05:00'
			]);
		});

		it('fires at the end of a gap that crosses midnight (Toronto, 1919)', function () {
			expect(walls('45 23 * * *', Date.UTC(1919, 2, 30, 12), 2, 'America/Toronto')).toEqual(['1919-03-31 00:30:00 -04:00', '1919-03-31 23:45:00 -04:00']);
			expect(previousWall('45 23 * * *', Date.UTC(1919, 2, 31, 12), 'America/Toronto')).toBe('1919-03-31 00:30:00 -04:00');
			// St. John's, 2010: 00:01 back to 23:01 the day before.
			expect(walls('30 23 * * *', Date.UTC(2010, 10, 6, 12), 2, 'America/St_Johns')).toEqual(['2010-11-06 23:30:00 -02:30', '2010-11-07 23:30:00 -03:30']);
			expect(walls('*/30 * * * *', Date.UTC(2010, 10, 7, 2), 4, 'America/St_Johns')).toEqual([
				'2010-11-07 00:00:00 -02:30',
				'2010-11-06 23:30:00 -03:30',
				'2010-11-07 00:00:00 -03:30',
				'2010-11-07 00:30:00 -03:30'
			]);
		});

		it('treats jumps of 3 hours or more as the clock being reset, like cronie', function () {
			// Samoa skipped Friday, December 30th, 2011: nothing catches up.
			expect(walls('0 12 * * *', Date.UTC(2011, 11, 28), 3, 'Pacific/Apia')).toEqual([
				'2011-12-28 12:00:00 -10:00',
				'2011-12-29 12:00:00 -10:00',
				'2011-12-31 12:00:00 +14:00'
			]);
			expect(walls('0 0 30 12 *', Date.UTC(2011, 0, 1), 2, 'Pacific/Apia')).toEqual(['2012-12-30 00:00:00 +14:00', '2013-12-30 00:00:00 +14:00']);
			expect(previousWall('0 12 * * *', Date.UTC(2011, 11, 30, 12), 'Pacific/Apia')).toBe('2011-12-29 12:00:00 -10:00');
			// Casey, 2018: 04:00 to 07:00, 3 hours: no catch-up; 2019: 03:00 back to 00:00, 3 hours: no repeat.
			expect(walls('30 5 * * *', Date.UTC(2018, 9, 6), 2, 'Antarctica/Casey')).toEqual(['2018-10-08 05:30:00 +11:00', '2018-10-09 05:30:00 +11:00']);
			expect(walls('30 1 * * *', Date.UTC(2019, 2, 16), 2, 'Antarctica/Casey')).toEqual(['2019-03-17 01:30:00 +11:00', '2019-03-18 01:30:00 +08:00']);
			// Troll: a 2-hour gap is still a daylight-saving change.
			expect(walls('30 1 * * *', Date.UTC(2024, 2, 30), 2, 'Antarctica/Troll')).toEqual(['2024-03-30 01:30:00 +00:00', '2024-03-31 03:00:00 +02:00']);
			expect(walls('30 1 * * *', Date.UTC(2024, 9, 26), 2, 'Antarctica/Troll')).toEqual(['2024-10-27 01:30:00 +02:00', '2024-10-28 01:30:00 +00:00']);
			// Kwajalein, 1969: back 23 hours, so even fixed-time jobs fire again on the repeated day; 1993: August 21st skipped.
			expect(walls('0 12 * * *', Date.UTC(1969, 8, 29, 2), 3, 'Pacific/Kwajalein')).toEqual([
				'1969-09-30 12:00:00 +11:00',
				'1969-09-30 12:00:00 -12:00',
				'1969-10-01 12:00:00 -12:00'
			]);
			expect(previousWall('0 12 * * *', Date.UTC(1969, 9, 1, 1), 'Pacific/Kwajalein')).toBe('1969-09-30 12:00:00 -12:00');
			expect(previousWall('0 12 * * *', Date.UTC(1969, 8, 30, 20), 'Pacific/Kwajalein')).toBe('1969-09-30 12:00:00 +11:00');
			expect(previousWall('0 0 * * *', Date.UTC(1969, 8, 30, 13, 30), 'Pacific/Kwajalein')).toBe('1969-09-30 00:00:00 +11:00');
			expect(walls('0 12 * * *', Date.UTC(1993, 7, 19), 3, 'Pacific/Kwajalein')).toEqual([
				'1993-08-19 12:00:00 -12:00',
				'1993-08-20 12:00:00 -12:00',
				'1993-08-22 12:00:00 +12:00'
			]);
		});

		it('catches up every job after a forward jump of less than 5 minutes (Bahia Banderas, 1922)', function () {
			// 23:59:00 to 00:00:00: the 60 seconds of 23:59 were skipped.
			expect(walls('30 59 * * * *', Date.UTC(1922, 0, 1, 6, 59), 2, 'America/Bahia_Banderas')).toEqual(['1922-01-01 00:00:00 -07:00', '1922-01-01 00:59:30 -07:00']);
			expect(walls('30 59 23 * * *', Date.UTC(1922, 0, 1, 6, 59), 1, 'America/Bahia_Banderas')).toEqual(['1922-01-01 00:00:00 -07:00']);
			expect(previousWall('30 59 * * * *', Date.UTC(1922, 0, 1, 7, 30), 'America/Bahia_Banderas')).toBe('1922-01-01 00:00:00 -07:00');
		});

		it('gives up after 400 years of matches all lost in gaps', function () {
			// Every minute from 02:00 on the second Sunday of March: always skipped in New York since 2007.
			const start = performance.now();

			expect(helpers.nextCronDate('* 2 * 3 0#2', { from: Date.UTC(2010, 0, 1), timeZone: 'America/New_York' })).toBeUndefined();
			expect(helpers.previousCronDate('* 2 * 3 0#2', { from: Date.UTC(2400, 0, 1), timeZone: 'America/New_York' })?.getTime()).toBe(Date.UTC(2006, 2, 12, 7, 59));
			expect(helpers.previousCronDate('* 2 * 3 0#2', { from: Date.UTC(2410, 0, 1), timeZone: 'America/New_York' })).toBeUndefined();
			expect(performance.now() - start).toBeLessThan(5000);
			// A fixed-time job still fires at the end of each gap.
			expect(next('0 2 * 3 0#2', Date.UTC(2010, 0, 1), 'America/New_York')).toBe(Date.UTC(2010, 2, 14, 7));
		});

		it('stops at the ends of the Date range', function () {
			const max = 8.64e15;

			expect(next('0 0 13 9 *', max - 1)).toBe(max);
			expect(next('0 0 13 9 *', max)).toBeUndefined();
			expect(next('* * * * *', max)).toBeUndefined();
			expect(next('* * * * *', max - 1, 'America/New_York')).toBe(max);
			expect(next('0 0 * * *', max - 5 * HOUR, '+05:00')).toBeUndefined();
			expect(next('0 0 * * *', max - 5 * HOUR - 1, '+05:00')).toBe(max - 5 * HOUR);
			expect(helpers.nextCronDate('0 0 20 4 *', { from: -max, inclusive: true, timeZone: 'UTC' })?.getTime()).toBe(-max);
			expect(helpers.previousCronDate('0 0 20 4 *', { from: -max + 1, timeZone: 'UTC' })?.getTime()).toBe(-max);
			expect(helpers.previousCronDate('* * * * *', { from: -max, timeZone: 'UTC' })).toBeUndefined();
			// Paris was at +00:09:21: its minutes start 21 seconds past the UTC ones.
			expect(helpers.previousCronDate('* * * * *', { from: -max + MINUTE, timeZone: 'Europe/Paris' })?.getTime()).toBe(-max + 39_000);
			expect(helpers.previousCronDate('* * * * *', { from: -max + 39_000, timeZone: 'Europe/Paris' })).toBeUndefined();
			expect(helpers.previousCronDate('0 0 13 9 *', { from: max, inclusive: true, timeZone: 'UTC' })?.getTime()).toBe(max);
			expect(helpers.nextCronDate('0 0 20 4 *', { from: max, timeZone: 'UTC' })).toBeUndefined();
			expect([...helpers.eachCronDate('0 0 * 9 *', { from: max - 3 * DAY, timeZone: 'UTC' })].length).toBe(3);
			// The same, from further away.
			expect(next('0 0 13 9 *', max - 30 * DAY)).toBe(max);
			expect(next('0 0 13 9 *', max - 30 * DAY, 'America/New_York')).toBeUndefined();
			expect(next('0 20 12 9 *', max - 30 * DAY, 'America/New_York')).toBe(max);
			expect(helpers.previousCronDate('0 0 20 4 *', { from: -max + 30 * DAY, timeZone: 'UTC' })?.getTime()).toBe(-max);
		});

		it('validates its arguments', function () {
			for (const fn of [helpers.nextCronDate, helpers.previousCronDate]) {
				const name = fn.name;

				expect(function () {
					fn(5 as any);
				}).toThrow(new TypeError(`${name}: \`cron\` must be a cron expression or a Cron returned by parseCron, got number`));
				expect(function () {
					fn({ expression: '* * * * *' } as any);
				}).toThrow(new TypeError(`${name}: \`cron\` must be a cron expression or a Cron returned by parseCron, got object`));
				expect(function () {
					fn({ ...helpers.parseCron('* * * * *') });
				}).toThrow(TypeError);
				expect(function () {
					fn('* * * *');
				}).toThrow(new RangeError(`${name}: \`expression\` must have 5 fields, or 6 with seconds first, got 4 in "* * * *"`));
				expect(function () {
					fn('* * * * *', null as any);
				}).toThrow(new TypeError(`${name}: \`options\` must be an object, got null`));
				expect(function () {
					fn('* * * * *', { from: '2024' as any });
				}).toThrow(new TypeError('Expected a Date or a timestamp number'));
				expect(function () {
					fn('* * * * *', { from: NaN });
				}).toThrow(new RangeError('Invalid date'));
				expect(function () {
					fn('* * * * *', { timeZone: 5 as any });
				}).toThrow(new TypeError(`${name}: \`timeZone\` must be a string, got number`));
				expect(function () {
					fn('* * * * *', { timeZone: 'Mars/Olympus' });
				}).toThrow(new RangeError(`${name}: \`timeZone\` must be an IANA time zone or a UTC offset (±HH:MM), got "Mars/Olympus"`));
			}
		});

		it('caches parsed expressions without keeping their errors', function () {
			expect(function () {
				helpers.nextCronDate('61 * * * *');
			}).toThrow(new RangeError('nextCronDate: the minute field values must be between 0 and 59, got "61"'));
			expect(function () {
				helpers.previousCronDate('61 * * * *');
			}).toThrow(new RangeError('previousCronDate: the minute field values must be between 0 and 59, got "61"'));
			for (let i = 0; i < 200; i++) expect(next(`${i % 60} * * * *`, 0)).toBe((i % 60 || 60) * MINUTE);
			expect(next(`${' '.repeat(2000)}5 * * * *`, 0)).toBe(5 * MINUTE);
		});
	});

	describe('eachCronDate', function () {
		it('yields the successive dates lazily, up to `to` and `limit`', function () {
			const from = Date.UTC(2024, 0, 1);
			const all = helpers.eachCronDate('0 */6 * * *', { from, to: from + DAY, timeZone: 'UTC' });

			expect(all[Symbol.iterator]()).toBe(all);
			expect(times(all)).toEqual(
				[6 * HOUR, 12 * HOUR, 18 * HOUR, 24 * HOUR].map(function (ms) {
					return from + ms;
				})
			);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, to: from + DAY, inclusive: true, timeZone: 'UTC' }))).toHaveLength(5);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, to: from + DAY - 1, timeZone: 'UTC' }))).toHaveLength(3);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, to: from - DAY, timeZone: 'UTC' }))).toEqual([]);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, limit: 0, timeZone: 'UTC' }))).toEqual([]);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, limit: 2, timeZone: 'UTC' }))).toEqual([from + 6 * HOUR, from + 12 * HOUR]);
			expect(times(helpers.eachCronDate('0 */6 * * *', { from, to: new Date(from + 12 * HOUR), limit: Infinity, timeZone: 'UTC' }))).toHaveLength(2);

			// Unbounded: read as much as needed.
			const unbounded = helpers.eachCronDate(helpers.parseCron('* * * * * *'), { from, timeZone: 'UTC' });
			let count = 0;

			for (const date of unbounded) {
				expect(date.getTime()).toBe(from + ++count * 1000);
				if (count === 100_000) break;
			}
			expect(count).toBe(100_000);
		});

		it('keeps independent iterators apart', function () {
			const a = helpers.eachCronDate('0 * * * *', { from: 0, timeZone: 'America/New_York' });
			const b = helpers.eachCronDate('30 * * * *', { from: Date.UTC(2024, 0, 1), timeZone: 'America/New_York' });

			expect(a.next().value).toEqual(new Date(HOUR));
			expect(b.next().value).toEqual(new Date(Date.UTC(2024, 0, 1, 0, 30)));
			expect(a.next().value).toEqual(new Date(2 * HOUR));
			expect(b.next().value).toEqual(new Date(Date.UTC(2024, 0, 1, 1, 30)));
		});

		it('validates its arguments at once', function () {
			expect(function () {
				helpers.eachCronDate(5 as any);
			}).toThrow(new TypeError('eachCronDate: `cron` must be a cron expression or a Cron returned by parseCron, got number'));
			expect(function () {
				helpers.eachCronDate('* * * * *', 5 as any);
			}).toThrow(new TypeError('eachCronDate: `options` must be an object, got number'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { to: 'x' as any });
			}).toThrow(new TypeError('Expected a Date or a timestamp number'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { from: new Date(NaN) });
			}).toThrow(new RangeError('Invalid date'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { limit: -1 });
			}).toThrow(new RangeError('eachCronDate: `limit` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { limit: 1.5 });
			}).toThrow(new RangeError('eachCronDate: `limit` must be an integer >= 0 or Infinity, got 1.5'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { limit: '3' as any });
			}).toThrow(new TypeError('eachCronDate: `limit` must be an integer >= 0 or Infinity, got string'));
			expect(function () {
				helpers.eachCronDate('* * * * *', { timeZone: '' });
			}).toThrow(new RangeError('eachCronDate: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got ""'));
		});
	});

	describe('isCronMatch', function () {
		it('checks the minute (or second) that a date falls in', function () {
			expect(helpers.isCronMatch('0/15 9-17 * * MON-FRI', new Date(2024, 0, 8, 9, 30, 42))).toBe(true);
			expect(helpers.isCronMatch('0/15 9-17 * * MON-FRI', new Date(2024, 0, 8, 9, 31))).toBe(false);
			expect(helpers.isCronMatch('0/15 9-17 * * MON-FRI', new Date(2024, 0, 7, 9, 30))).toBe(false);
			expect(helpers.isCronMatch('30 * * * * *', new Date(2024, 0, 8, 9, 31, 30, 999))).toBe(true);
			expect(helpers.isCronMatch('30 * * * * *', new Date(2024, 0, 8, 9, 31, 31))).toBe(false);
			expect(helpers.isCronMatch('0 0 * * *', Date.UTC(2024, 0, 1, 0, 0, 59, 999), { timeZone: 'UTC' })).toBe(true);
			expect(helpers.isCronMatch('0 0 * * *', Date.UTC(2024, 0, 1, 0, 1), { timeZone: 'UTC' })).toBe(false);
			expect(helpers.isCronMatch('0 0 * * *', Date.UTC(2023, 11, 31, 18, 30, 5), { timeZone: '+05:30' })).toBe(true);
			expect(helpers.isCronMatch(helpers.parseCron('@daily'), Date.UTC(2023, 11, 31, 18, 29, 59), { timeZone: '+05:30' })).toBe(false);
		});

		it('follows the daylight-saving rules of nextCronDate', function () {
			const zone = 'America/New_York';

			expect(helpers.isCronMatch('30 1 * * *', Date.UTC(2024, 10, 3, 5, 30, 10), { timeZone: zone })).toBe(true);
			expect(helpers.isCronMatch('30 1 * * *', Date.UTC(2024, 10, 3, 6, 30, 10), { timeZone: zone })).toBe(false);
			expect(helpers.isCronMatch('30 * * * *', Date.UTC(2024, 10, 3, 6, 30, 10), { timeZone: zone })).toBe(true);
			expect(helpers.isCronMatch('30 2 * * *', Date.UTC(2024, 2, 10, 7, 0, 30), { timeZone: zone })).toBe(true);
			expect(helpers.isCronMatch('30 * * * *', Date.UTC(2024, 2, 10, 7, 0, 30), { timeZone: zone })).toBe(false);
			expect(helpers.isCronMatch('0 3 * * *', Date.UTC(2024, 2, 10, 7), { timeZone: zone })).toBe(true);
			// Local mean time offsets have seconds: the minute starts on the wall clock.
			expect(helpers.isCronMatch('0 0 1 1 *', Date.UTC(1900, 0, 1) - 561_000 + 59_000, { timeZone: 'Europe/Paris' })).toBe(true);
			expect(helpers.isCronMatch('0 0 1 1 *', Date.UTC(1900, 0, 1) - 561_000 + 60_000, { timeZone: 'Europe/Paris' })).toBe(false);
			expect(helpers.isCronMatch('0 0 1 1 *', Date.UTC(1900, 0, 1) - 561_000 - 1, { timeZone: 'Europe/Paris' })).toBe(false);
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.isCronMatch(undefined as any, 0);
			}).toThrow(new TypeError('isCronMatch: `cron` must be a cron expression or a Cron returned by parseCron, got undefined'));
			expect(function () {
				helpers.isCronMatch('* * * * *', 'now' as any);
			}).toThrow(new TypeError('Expected a Date or a timestamp number'));
			expect(function () {
				helpers.isCronMatch('* * * * *', 0, [] as any);
			}).not.toThrow();
			expect(function () {
				helpers.isCronMatch('* * * * *', 0, 'UTC' as any);
			}).toThrow(new TypeError('isCronMatch: `options` must be an object, got string'));
			expect(function () {
				helpers.isCronMatch('* * * * *', 0, { timeZone: '+25:00' });
			}).toThrow(new RangeError('isCronMatch: `timeZone` must be an IANA time zone or a UTC offset (±HH:MM), got "+25:00"'));
		});
	});

	it('asks for the UTC offset about once a day, not once a date', function () {
		// The local offset is read from the local fields of a Date: count the `getHours` calls.
		const spy = jest.spyOn(Date.prototype, 'getHours');
		const from = Date.UTC(2024, 0, 1);
		let count = 0;

		for (const date of helpers.eachCronDate('* * * * *', { from, limit: 1440 })) count += Number(date.getTime() > from);
		expect(count).toBe(1440);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
		spy.mockClear();
		helpers.nextCronDate('*/5 * * * *', { from });
		expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
		spy.mockClear();
		helpers.previousCronDate('*/5 * * * *', { from });
		expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
		spy.mockClear();
		helpers.nextCronDate('0 0 1 1 *', { from });
		expect(spy.mock.calls.length).toBeLessThanOrEqual(9);
	});

	it('ignores inherited options', function () {
		const keys: Array<[string, unknown]> = [
			['from', 0],
			['timeZone', 'Asia/Tokyo'],
			['inclusive', true],
			['to', 0],
			['limit', 0]
		];
		const from = Date.UTC(2024, 0, 1, 12);

		for (const [key, value] of keys) {
			(Object.prototype as Record<string, unknown>)[key] = value;
			try {
				expect(helpers.nextCronDate('0 * * * *', { from, timeZone: 'UTC' })?.getTime()).toBe(from + HOUR);
				expect(times(helpers.eachCronDate('0 * * * *', { from, limit: 1, timeZone: 'UTC' }))).toEqual([from + HOUR]);
				expect(helpers.isCronMatch('0 12 * * *', from, { timeZone: 'UTC' })).toBe(true);
			} finally {
				delete (Object.prototype as Record<string, unknown>)[key];
			}
		}
	});

	it('does not read the first character of an empty expression or time zone from a polluted Object.prototype', function () {
		(Object.prototype as Record<string, unknown>)[0] = '@';
		try {
			// `''[0]` is looked up on the prototypes: it read as a macro.
			expect(function () {
				helpers.parseCron('  ');
			}).toThrow('must have 5 fields');
		} finally {
			delete (Object.prototype as Record<string, unknown>)[0];
		}
		(Object.prototype as Record<string, unknown>)[0] = '+';
		try {
			expect(helpers.isValidTimeZone('')).toBe(false);
		} finally {
			delete (Object.prototype as Record<string, unknown>)[0];
		}
	});

	it('works in the local time zone', function () {
		withTimeZone('America/New_York', function () {
			expect(helpers.nextCronDate('30 2 * * *', { from: Date.UTC(2024, 2, 10, 5) })).toEqual(new Date(Date.UTC(2024, 2, 10, 7)));
			expect(times(helpers.eachCronDate('*/30 * * * *', { from: Date.UTC(2024, 10, 3, 5), limit: 4 }))).toEqual([
				Date.UTC(2024, 10, 3, 5, 30),
				Date.UTC(2024, 10, 3, 6),
				Date.UTC(2024, 10, 3, 6, 30),
				Date.UTC(2024, 10, 3, 7)
			]);
			expect(helpers.isCronMatch('30 1 * * *', Date.UTC(2024, 10, 3, 6, 30))).toBe(false);
		});
		withTimeZone('Pacific/Apia', function () {
			expect(helpers.previousCronDate('0 12 * * *', { from: Date.UTC(2011, 11, 30, 12) })).toEqual(new Date(Date.UTC(2011, 11, 29, 22)));
		});
	});

	/**
	 * The times of dates.
	 */
	function times(dates: Iterable<Date>): number[] {
		return Array.from(dates, function (date) {
			return date.getTime();
		});
	}
});
