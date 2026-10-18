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
			expect(parts(helpers.addDays(new Date(2023, 2, 13, 0, 30), -1))).toEqual([2023, 2, 12, 0, 30, 0, 0]);
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
				expect(parts(helpers.startOfDay(date))).toEqual([...ymd(date), 0, 0, 0, 0]);
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
			expect(parts(helpers.startOfWeek(new Date(2023, 2, 15, 12)))).toEqual([2023, 2, 12, 0, 0, 0, 0]);
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
			expect(helpers.diffInDays(8.64e15, -8.64e15)).toBe(200_000_000);
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

		it('rejects min > max', function () {
			expect(function () {
				helpers.clampDate(min, max, min);
			}).toThrow(new RangeError('clampDate: `min` must not be after `max`'));
		});
	});

	describe('formatDuration', function () {
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

		it('accepts multi-digit decimals, with or without a leading digit', function () {
			expect(helpers.parseDuration('1.25h')).toBe(4_500_000);
			expect(helpers.parseDuration('.25s')).toBe(250);
			expect(helpers.parseDuration('0.125m 1.5s')).toBe(9_000);
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
});
