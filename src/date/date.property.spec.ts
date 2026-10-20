import fc from 'fast-check';
import * as util from 'util';
import * as helpers from '.';
import { clamp } from '../math/index.js';

const dateArb = fc.date({ min: new Date(1900, 0, 1), max: new Date(2200, 0, 1), noInvalidDate: true });
const weekdayArb = fc.integer({ min: 0, max: 6 }) as fc.Arbitrary<helpers.WeekdayIndex>;

/**
 * Local time-of-day components.
 */
function timeOfDay(date: Date): number[] {
	return [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
}

/**
 * Local calendar components.
 */
function ymd(date: Date): number[] {
	return [date.getFullYear(), date.getMonth(), date.getDate()];
}

/**
 * `addDays(date, offset)` when its local calendar day exists, else `undefined`: where a time zone skipped a whole day (Samoa,
 * 2011-12-30), `addDays` lands on the next day, which the naive day-by-day references must not visit twice.
 */
function existingDay(date: Date, offset: number): Date | undefined {
	const moved = helpers.addDays(date, offset);
	const expected = new Date(0);

	expected.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate() + offset);

	return ymd(moved).join() === [expected.getUTCFullYear(), expected.getUTCMonth(), expected.getUTCDate()].join() ? moved : undefined;
}

/**
 * Zero-pads a number to two digits.
 */
function p2(n: number): string {
	return String(n).padStart(2, '0');
}

describe('Date helpers (properties)', function () {
	it('addDays(addDays(d, n), -n) restores the calendar day and time of day', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -100_000, max: 100_000 }), function (date, n) {
				const moved = helpers.addDays(date, n);

				// Skip the rare case where the wall-clock time does not exist on the target day (DST gap).
				fc.pre(timeOfDay(moved).join() === timeOfDay(date).join());

				const back = helpers.addDays(moved, -n);

				expect(ymd(back)).toEqual(ymd(date));
				expect(timeOfDay(back)).toEqual(timeOfDay(date));
			})
		);
	});

	it('diffInDays(addDays(d, n), d) === n', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -100_000, max: 100_000 }), function (date, n) {
				expect(helpers.diffInDays(helpers.addDays(date, n), date)).toBe(n);
				expect(helpers.diffInDays(date, helpers.addDays(date, n))).toBe(0 - n);
			})
		);
	});

	it('diffInDays is consistent with addWeeks', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -10_000, max: 10_000 }), function (date, n) {
				expect(helpers.diffInDays(helpers.addWeeks(date, n), date)).toBe(7 * n);
			})
		);
	});

	it('addMonths lands in the expected month, clamping the day', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -2400, max: 2400 }), function (date, n) {
				const result = helpers.addMonths(date, n);
				const total = date.getMonth() + n;
				const expectedYear = date.getFullYear() + Math.floor(total / 12);
				const expectedMonth = ((total % 12) + 12) % 12;

				expect(result.getFullYear()).toBe(expectedYear);
				expect(result.getMonth()).toBe(expectedMonth);
				expect(result.getDate()).toBeLessThanOrEqual(date.getDate());
				expect(result.getDate()).toBe(Math.min(date.getDate(), helpers.daysInMonth(expectedYear, expectedMonth)));
			})
		);
	});

	it('addYears(d, n) equals addMonths(d, 12n)', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -200, max: 200 }), function (date, n) {
				expect(helpers.addYears(date, n).getTime()).toBe(helpers.addMonths(date, 12 * n).getTime());
			})
		);
	});

	it('diffInMonths counts complete months: addMonths(e, k) <= l < addMonths(e, k + 1)', function () {
		fc.assert(
			fc.property(dateArb, dateArb, function (a, b) {
				const later = a.getTime() >= b.getTime() ? a : b;
				const earlier = later === a ? b : a;
				const k = helpers.diffInMonths(later, earlier);

				expect(k).toBeGreaterThanOrEqual(0);
				expect(helpers.addMonths(earlier, k).getTime()).toBeLessThanOrEqual(later.getTime());
				expect(helpers.addMonths(earlier, k + 1).getTime()).toBeGreaterThan(later.getTime());
				expect(helpers.diffInMonths(earlier, later) + k).toBe(0);
			})
		);
	});

	it('absolute arithmetic round-trips through the diff functions', function () {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: -1_000_000, max: 1_000_000 }), function (date, n) {
				expect(helpers.diffInSeconds(helpers.addSeconds(date, n), date)).toBe(n);
				expect(helpers.diffInMinutes(helpers.addMinutes(date, n), date)).toBe(n);
				expect(helpers.diffInHours(helpers.addHours(date, n), date)).toBe(n);
				expect(helpers.addMilliseconds(date, n).getTime() - date.getTime()).toBe(n);
			})
		);
	});

	it('diffInSeconds/Minutes/Hours truncate the millisecond delta toward zero', function () {
		fc.assert(
			fc.property(dateArb, dateArb, function (a, b) {
				const delta = a.getTime() - b.getTime();

				expect(helpers.diffInSeconds(a, b)).toBe(Math.trunc(delta / 1000) + 0);
				expect(helpers.diffInMinutes(a, b)).toBe(Math.trunc(delta / 60_000) + 0);
				expect(helpers.diffInHours(a, b)).toBe(Math.trunc(delta / 3_600_000) + 0);
			})
		);
	});

	it('startOfDay <= d <= endOfDay, both on the same day, startOfDay idempotent', function () {
		fc.assert(
			fc.property(dateArb, function (date) {
				const start = helpers.startOfDay(date);
				const end = helpers.endOfDay(date);

				expect(start.getTime()).toBeLessThanOrEqual(date.getTime());
				expect(end.getTime()).toBeGreaterThanOrEqual(date.getTime());
				expect(helpers.isSameDay(start, date)).toBe(true);
				expect(helpers.isSameDay(end, date)).toBe(true);
				expect(helpers.startOfDay(start).getTime()).toBe(start.getTime());
				expect(helpers.endOfDay(end).getTime()).toBe(end.getTime());
			})
		);
	});

	it('startOfMonth / endOfMonth / startOfYear / endOfYear bracket the date', function () {
		fc.assert(
			fc.property(dateArb, function (date) {
				const time = date.getTime();
				const sm = helpers.startOfMonth(date);
				const em = helpers.endOfMonth(date);
				const sy = helpers.startOfYear(date);
				const ey = helpers.endOfYear(date);

				expect(sm.getTime()).toBeLessThanOrEqual(time);
				expect(em.getTime()).toBeGreaterThanOrEqual(time);
				expect(sm.getDate()).toBe(1);
				// The last day of the month or year can have been skipped (Kiritimati skipped 1994-12-31): the next instant is in the next one.
				expect(helpers.isSameMonth(em.getTime() + 1, date)).toBe(false);
				expect(helpers.isSameMonth(sm, date) && helpers.isSameMonth(em, date)).toBe(true);
				expect(sy.getTime()).toBeLessThanOrEqual(sm.getTime());
				expect(ey.getTime()).toBeGreaterThanOrEqual(em.getTime());
				expect(ymd(sy)).toEqual([date.getFullYear(), 0, 1]);
				expect(ymd(ey).slice(0, 2)).toEqual([date.getFullYear(), 11]);
				expect(helpers.isSameYear(ey.getTime() + 1, date)).toBe(false);
			})
		);
	});

	it('startOfWeek is the right weekday, <= d and less than 7 days before; endOfWeek is 6 days later', function () {
		fc.assert(
			fc.property(dateArb, weekdayArb, function (date, weekStartsOn) {
				const start = helpers.startOfWeek(date, weekStartsOn);
				const end = helpers.endOfWeek(date, weekStartsOn);
				const diff = helpers.diffInDays(date, start);

				expect(start.getDay()).toBe(weekStartsOn);
				expect(start.getTime()).toBeLessThanOrEqual(date.getTime());
				expect(diff).toBeGreaterThanOrEqual(0);
				expect(diff).toBeLessThan(7);
				expect(helpers.diffInDays(end, start)).toBe(6);
				expect(end.getTime()).toBeGreaterThanOrEqual(date.getTime());
			})
		);
	});

	it('formatDate(d, "YYYY-MM-DD") === toISODateString(d) and parseISODate round-trips', function () {
		fc.assert(
			fc.property(dateArb, function (date) {
				const iso = helpers.toISODateString(date);

				expect(helpers.formatDate(date, 'YYYY-MM-DD')).toBe(iso);
				expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);

				const parsed = helpers.parseISODate(iso);

				expect(parsed).toBeDefined();
				expect(helpers.isSameDay(parsed as Date, date)).toBe(true);
				expect(helpers.toISODateString(parsed as Date)).toBe(iso);
			})
		);
	});

	it('formatDate agrees with a naive reference for every numeric token', function () {
		fc.assert(
			fc.property(dateArb, function (date) {
				const h12 = date.getHours() % 12 === 0 ? 12 : date.getHours() % 12;
				const expected = [
					String(date.getFullYear()),
					p2(date.getMonth() + 1),
					p2(date.getDate()),
					p2(date.getHours()),
					p2(h12),
					p2(date.getMinutes()),
					p2(date.getSeconds()),
					String(date.getMilliseconds()).padStart(3, '0'),
					date.getHours() < 12 ? 'AM' : 'PM'
				].join('|');

				expect(helpers.formatDate(date, 'YYYY|MM|DD|HH|hh|mm|ss|SSS|A')).toBe(expected);
			})
		);
	});

	it('bracketed text is output verbatim', function () {
		fc.assert(
			fc.property(dateArb, fc.string({ unit: 'grapheme' }), function (date, text) {
				fc.pre(!text.includes(']'));
				expect(helpers.formatDate(date, `[${text}]`)).toBe(text);
			})
		);
	});

	it('parseISODate accepts exactly the valid calendar dates', function () {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }), function (year, month, day) {
				const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
				const valid = month >= 1 && month <= 12 && day >= 1 && day <= helpers.daysInMonth(year, month - 1);
				const parsed = helpers.parseISODate(text);

				expect(parsed !== undefined).toBe(valid);
				if (parsed !== undefined) expect(ymd(parsed)).toEqual([year, month - 1, day]);
			})
		);
	});

	it('compareAsc is antisymmetric, consistent with getTime, and sorts', function () {
		fc.assert(
			fc.property(dateArb, dateArb, fc.array(dateArb), function (a, b, list) {
				const result = helpers.compareAsc(a, b);

				expect(result + helpers.compareAsc(b, a)).toBe(0);
				expect(result).toBe(Math.sign(a.getTime() - b.getTime()) + 0);
				expect(helpers.compareDesc(a, b)).toBe(helpers.compareAsc(b, a));

				const sorted = list.slice().sort(helpers.compareAsc);

				for (let i = 1; i < sorted.length; i++) {
					expect(sorted[i - 1].getTime()).toBeLessThanOrEqual(sorted[i].getTime());
				}
			})
		);
	});

	it('minDate / maxDate match Math.min / Math.max over timestamps', function () {
		fc.assert(
			fc.property(fc.array(dateArb, { minLength: 1 }), function (list) {
				const times = list.map(function (d) {
					return d.getTime();
				});

				expect(helpers.minDate(list)?.getTime()).toBe(Math.min(...times));
				expect(helpers.maxDate(list)?.getTime()).toBe(Math.max(...times));
			})
		);
	});

	it('isBetween("[]") matches !isBefore(start) && !isAfter(end); exclusive variants are subsets', function () {
		fc.assert(
			fc.property(dateArb, dateArb, dateArb, function (date, x, y) {
				const start = x.getTime() <= y.getTime() ? x : y;
				const end = start === x ? y : x;
				const inclusive = helpers.isBetween(date, start, end);

				expect(inclusive).toBe(!helpers.isBefore(date, start) && !helpers.isAfter(date, end));
				(['()', '[)', '(]'] as const).forEach(function (inclusivity) {
					if (helpers.isBetween(date, start, end, inclusivity)) expect(inclusive).toBe(true);
				});
			})
		);
	});

	it('isLeapYear agrees with daysInMonth and the native Date', function () {
		fc.assert(
			fc.property(fc.integer({ min: 100, max: 100_000 }), function (year) {
				expect(helpers.isLeapYear(year)).toBe(helpers.daysInMonth(year, 1) === 29);
				expect(helpers.isLeapYear(year)).toBe(new Date(year, 1, 29).getMonth() === 1);
			})
		);
	});

	it('daysInMonth agrees with the native Date', function () {
		fc.assert(
			fc.property(fc.integer({ min: 100, max: 100_000 }), fc.integer({ min: 0, max: 11 }), function (year, month) {
				expect(helpers.daysInMonth(year, month)).toBe(new Date(year, month + 1, 0).getDate());
			})
		);
	});

	it('never mutates its inputs', function () {
		fc.assert(
			fc.property(dateArb, dateArb, fc.integer({ min: -1000, max: 1000 }), weekdayArb, function (a, b, n, w) {
				const timeA = a.getTime();
				const timeB = b.getTime();

				helpers.addDays(a, n);
				helpers.addWeeks(a, n);
				helpers.addMonths(a, n);
				helpers.addYears(a, n);
				helpers.addHours(a, n);
				helpers.addMinutes(a, n);
				helpers.addSeconds(a, n);
				helpers.addMilliseconds(a, n);
				helpers.diffInDays(a, b);
				helpers.diffInMonths(a, b);
				helpers.diffInMonths(b, a);
				helpers.diffInHours(a, b);
				helpers.startOfDay(a);
				helpers.endOfDay(a);
				helpers.startOfMonth(a);
				helpers.endOfMonth(a);
				helpers.startOfWeek(a, w);
				helpers.endOfWeek(a, w);
				helpers.startOfYear(a);
				helpers.endOfYear(a);
				helpers.isSameDay(a, b);
				helpers.compareAsc(a, b);
				helpers.minDate([a, b]);
				helpers.maxDate([a, b]);
				helpers.formatDate(a, 'YYYY-MM-DD HH:mm:ss.SSS A');
				helpers.getRelativeTime(a, b);

				expect(a.getTime()).toBe(timeA);
				expect(b.getTime()).toBe(timeB);
			})
		);
	});

	describe('round 2 additions', function () {
		const amountArb = fc.integer({ min: -1_000, max: 1_000 });

		/**
		 * Reference ISO week computation (the classic "Thursday rule"), done on a UTC date built from the local fields.
		 */
		function referenceISOWeek(date: Date): [number, number] {
			const utc = new Date(0);

			utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());

			const weekday = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();

			utc.setUTCDate(utc.getUTCDate() + 4 - weekday);

			const yearStart = new Date(0);

			yearStart.setUTCFullYear(utc.getUTCFullYear(), 0, 1);

			return [utc.getUTCFullYear(), Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)];
		}

		/**
		 * Naive reference: walks one calendar day at a time, always measuring the offset from the original date (chaining
		 * addDays would permanently shift the wall-clock time after passing through a DST gap), over the days that exist.
		 */
		function naiveAddBusinessDays(date: Date, amount: number): Date {
			const sign = amount < 0 ? -1 : 1;
			let remaining = Math.abs(amount);
			let offset = 0;

			while (remaining > 0) {
				offset += sign;

				const day = existingDay(date, offset);

				if (day !== undefined && !helpers.isWeekend(day)) remaining--;
			}

			return helpers.addDays(date, offset);
		}

		it('adding zero calendar units is the identity on the instant', function () {
			fc.assert(
				fc.property(dateArb, function (date) {
					expect(helpers.addDays(date, 0).getTime()).toBe(date.getTime());
					expect(helpers.addMonths(date, 0).getTime()).toBe(date.getTime());
					expect(helpers.addBusinessDays(date, 0).getTime()).toBe(date.getTime());
				})
			);
		});

		it('eachDayOfInterval: length = floor(diffInDays / step) + 1, consecutive local midnights `step` days apart', function () {
			fc.assert(
				fc.property(dateArb, fc.integer({ min: 0, max: 400 }), fc.integer({ min: 1, max: 10 }), function (start, span, step) {
					const end = helpers.addDays(start, span);
					const days = helpers.eachDayOfInterval(start, end, { step });
					// A skipped calendar day (Samoa 2011-12-30) is listed once with the next one: covered by an example test instead.
					fc.pre(helpers.eachDayOfInterval(start, end).length === helpers.diffInDays(end, start) + 1);

					expect(days).toHaveLength(Math.floor(helpers.diffInDays(end, start) / step) + 1);
					expect(helpers.isSameDay(days[0], start)).toBe(true);
					expect(helpers.diffInDays(end, days[days.length - 1])).toBeLessThan(step);
					days.forEach(function (day, index) {
						expect(day.getTime()).toBe(helpers.startOfDay(day).getTime());
						if (index > 0) expect(helpers.diffInDays(day, days[index - 1])).toBe(step);
					});
				})
			);
		});

		it('getISOWeek / getISOWeekYear match the reference Thursday-rule algorithm (1900-2200)', function () {
			fc.assert(
				fc.property(dateArb, function (date) {
					expect([helpers.getISOWeekYear(date), helpers.getISOWeek(date)]).toEqual(referenceISOWeek(date));
				}),
				{ numRuns: 1000 }
			);
		});

		it('January 4th is always in week 1 and December 28th always in the last ISO week of its year', function () {
			fc.assert(
				fc.property(fc.integer({ min: 1900, max: 2200 }), function (year) {
					const jan4 = new Date(year, 0, 4, 12);
					const dec28 = new Date(year, 11, 28, 12);
					const jan1Weekday = new Date(year, 0, 1, 12).getDay();
					const weeksInYear = jan1Weekday === 4 || (jan1Weekday === 3 && helpers.isLeapYear(year)) ? 53 : 52;

					expect(helpers.getISOWeek(jan4)).toBe(1);
					expect(helpers.getISOWeekYear(jan4)).toBe(year);
					expect(helpers.getISOWeek(dec28)).toBe(weeksInYear);
					expect(helpers.getISOWeekYear(dec28)).toBe(year);
					expect(helpers.getISOWeek(helpers.addDays(dec28, 7))).toBe(1);
				})
			);
		});

		it('getQuarter = floor(month / 3) + 1 and startOfQuarter <= d <= endOfQuarter within the same quarter', function () {
			fc.assert(
				fc.property(dateArb, function (date) {
					const quarter = helpers.getQuarter(date);
					const start = helpers.startOfQuarter(date);
					const end = helpers.endOfQuarter(date);

					expect(quarter).toBe(Math.floor(date.getMonth() / 3) + 1);
					expect(start.getTime()).toBeLessThanOrEqual(date.getTime());
					expect(end.getTime()).toBeGreaterThanOrEqual(date.getTime());
					expect([start.getMonth() % 3, start.getDate()]).toEqual([0, 1]);
					expect(helpers.getQuarter(start)).toBe(quarter);
					expect(helpers.getQuarter(end)).toBe(quarter);
					expect(helpers.getQuarter(helpers.addMilliseconds(end, 1))).toBe((quarter % 4) + 1);
					expect(helpers.startOfQuarter(start).getTime()).toBe(start.getTime());
				})
			);
		});

		it('getAge(d, addYears(d, n)) === n, the day before is n - 1, and getAge is monotonic in now', function () {
			fc.assert(
				fc.property(dateArb, fc.integer({ min: 0, max: 120 }), dateArb, function (birth, n, other) {
					const anniversary = helpers.addYears(birth, n);

					expect(helpers.getAge(birth, anniversary)).toBe(n);
					const dayBefore = helpers.addDays(anniversary, -1);
					// Unless that day was skipped (Samoa skipped 2011-12-30: `addDays` then lands on the anniversary itself).
					if (n > 0 && helpers.diffInDays(anniversary, dayBefore) === 1) expect(helpers.getAge(birth, dayBefore)).toBe(n - 1);

					fc.pre(helpers.diffInDays(other, birth) >= 0);

					const later = helpers.addDays(other, 1);

					expect(helpers.getAge(birth, later)).toBeGreaterThanOrEqual(helpers.getAge(birth, other));
					expect(helpers.getAge(birth, other)).toBeGreaterThanOrEqual(0);
				})
			);
		});

		it('addBusinessDays never lands on a weekend (n != 0) and matches a naive day-by-day walk', function () {
			fc.assert(
				fc.property(dateArb, fc.integer({ min: -60, max: 60 }), function (date, n) {
					const result = helpers.addBusinessDays(date, n);

					expect(result.getTime()).toBe(naiveAddBusinessDays(date, n).getTime());
					if (n !== 0) expect(helpers.isWeekend(result)).toBe(false);
				})
			);
		});

		it('diffInBusinessDays(addBusinessDays(d, n), d) === n for weekdays d, and diffInBusinessDays is antisymmetric', function () {
			fc.assert(
				fc.property(dateArb, amountArb, dateArb, function (date, n, other) {
					expect(helpers.diffInBusinessDays(date, other)).toBe(0 - helpers.diffInBusinessDays(other, date));

					fc.pre(!helpers.isWeekend(date));
					expect(helpers.diffInBusinessDays(helpers.addBusinessDays(date, n), date)).toBe(n);
				})
			);
		});

		it('diffInBusinessDays matches a naive count of weekdays in (earlier, later]', function () {
			fc.assert(
				fc.property(dateArb, fc.integer({ min: 0, max: 60 }), function (earlier, span) {
					const later = helpers.addDays(earlier, span);
					let count = 0;

					for (let offset = 1; offset <= span; offset++) {
						const day = existingDay(earlier, offset);

						if (day !== undefined && !helpers.isWeekend(day)) count++;
					}

					expect(helpers.diffInBusinessDays(later, earlier)).toBe(count);
				})
			);
		});

		it('isPast / isFuture / equality form a trichotomy consistent with compareAsc', function () {
			fc.assert(
				fc.property(dateArb, dateArb, function (date, now) {
					const order = helpers.compareAsc(date, now);

					expect(helpers.isPast(date, now)).toBe(order === -1);
					expect(helpers.isFuture(date, now)).toBe(order === 1);
					expect(helpers.isToday(date, now)).toBe(helpers.diffInDays(date, now) === 0);
				})
			);
		});

		it('clampDate stays within the bounds, is idempotent and is the identity inside the range', function () {
			fc.assert(
				fc.property(dateArb, dateArb, dateArb, function (date, a, b) {
					const min = a.getTime() <= b.getTime() ? a : b;
					const max = min === a ? b : a;
					const clamped = helpers.clampDate(date, min, max);

					expect(clamped.getTime()).toBeGreaterThanOrEqual(min.getTime());
					expect(clamped.getTime()).toBeLessThanOrEqual(max.getTime());
					expect(helpers.clampDate(clamped, min, max).getTime()).toBe(clamped.getTime());
					if (helpers.isBetween(date, min, max)) expect(clamped.getTime()).toBe(date.getTime());
				})
			);
		});

		it('clampDate agrees with clamp (math) on the timestamps, crossed bounds included', function () {
			fc.assert(
				fc.property(dateArb, dateArb, dateArb, function (date, min, max) {
					expect(helpers.clampDate(date, min, max).getTime()).toBe(clamp(date.getTime(), min.getTime(), max.getTime()) + 0);
				})
			);
		});

		it('parseDuration(formatDuration(ms)) === ms for every safe integer', function () {
			fc.assert(
				fc.property(fc.oneof(fc.integer(), fc.integer({ min: -100_000_000, max: 100_000_000 }), fc.maxSafeInteger(), fc.maxSafeNat()), function (ms) {
					expect(helpers.parseDuration(helpers.formatDuration(ms))).toBe(ms + 0);
				})
			);
		});

		it('parseDuration reads a decimal amount exactly when it is a whole number of milliseconds', function () {
			// The unit, the decimal places that keep its milliseconds whole, and the milliseconds per unit of the last place.
			const units: Array<[helpers.DurationUnit, number, number]> = [
				['d', 5, 864],
				['h', 5, 36],
				['m', 4, 6],
				['s', 3, 1],
				['ms', 0, 1]
			];

			fc.assert(
				fc.property(fc.constantFrom(...units), fc.integer({ min: 0, max: 1e13 }), fc.boolean(), function ([unit, places, factor], scaled, negative) {
					// `scaled` units of the last decimal place, written as a decimal (`'1.00100'` for 100100 with 5 places).
					const digits = String(scaled).padStart(places + 1, '0');
					const amount = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;

					expect(helpers.parseDuration(`${negative ? '-' : ''}${amount}${unit}`)).toBe((negative ? -1 : 1) * scaled * factor + 0);
				})
			);
		});

		it('formatDuration with restricted units / largest truncates toward zero by less than the dropped part', function () {
			const unitsArb = fc.subarray(['d', 'h', 'm', 's', 'ms'] as helpers.DurationUnit[], { minLength: 1 });

			fc.assert(
				fc.property(fc.integer({ min: 0, max: 10 * 86_400_000 }), unitsArb, fc.integer({ min: 1, max: 5 }), function (ms, units, largest) {
					const text = helpers.formatDuration(ms, { units, largest });
					const parsed = helpers.parseDuration(text);
					const tokens = text === '0s' || /^0[a-z]+$/.test(text) ? [] : text.split(' ');

					expect(tokens.length).toBeLessThanOrEqual(largest);
					expect(parsed).toBeLessThanOrEqual(ms);
					tokens.forEach(function (token) {
						expect(units).toContain(token.replace(/^\d+/, ''));
					});
					if (largest === 5) {
						const smallest = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }[units[units.length - 1]];

						expect(ms - parsed).toBeLessThan(smallest);
					}
					expect(helpers.formatDuration(0 - ms, { units, largest })).toBe(parsed === 0 ? text : `-${text}`);
				})
			);
		});
	});

	it('formatDate tokenizes exactly like the original single-regex tokenizer', function () {
		const original = /\[([^\]]*)]|YYYY|YY|SSS|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a/g;
		const piece = fc.constantFrom('YYYY', 'YY', 'Y', 'SSS', 'S', 'MM', 'M', 'DD', 'D', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's', 'A', 'a', '[', ']', 'x', 'é', ' ', '-');
		fc.assert(
			fc.property(fc.array(piece, { maxLength: 30 }), fc.integer({ min: 0, max: 4_102_444_800_000 }), function (pieces, time) {
				const pattern = pieces.join('');
				const date = new Date(time);
				const expected = pattern.replace(original, function (token: string, literal: string | undefined): string {
					return literal ?? helpers.formatDate(date, token);
				});
				expect(helpers.formatDate(date, pattern)).toBe(expected);
			}),
			{ numRuns: 500 }
		);
	});

	describe('round 11', function () {
		const durationArb = fc.record(
			{
				years: fc.integer({ min: -50, max: 50 }),
				months: fc.integer({ min: -30, max: 30 }),
				weeks: fc.integer({ min: -10, max: 10 }),
				days: fc.integer({ min: -400, max: 400 }),
				hours: fc.integer({ min: -100, max: 100 }),
				minutes: fc.integer({ min: -1000, max: 1000 }),
				seconds: fc.integer({ min: -1000, max: 1000 }),
				milliseconds: fc.integer({ min: -5000, max: 5000 })
			},
			{ requiredKeys: [] }
		);

		it('addDuration(start, intervalToDuration(start, end)) is exactly end, in both directions', function () {
			fc.assert(
				fc.property(dateArb, dateArb, function (start, end) {
					const duration = helpers.intervalToDuration(start, end);
					expect(helpers.addDuration(start, duration).getTime()).toBe(end.getTime());
				}),
				{ numRuns: 1000 }
			);
		});

		it('intervalToDuration is largest-first: every component has the sign of the interval and is below its limit', function () {
			fc.assert(
				fc.property(dateArb, dateArb, function (start, end) {
					const duration = helpers.intervalToDuration(start, end);
					const sign = end.getTime() < start.getTime() ? -1 : 1;
					const { years, months, days, hours, minutes, seconds, milliseconds } = duration;
					for (const value of [years, months, days, hours, minutes, seconds, milliseconds]) {
						expect(Number.isInteger(value)).toBe(true);
						expect(sign * value).toBeGreaterThanOrEqual(0);
						expect(Object.is(value, -0)).toBe(false);
					}
					expect(Math.abs(months)).toBeLessThan(12);
					expect(Math.abs(days)).toBeLessThan(31);
					expect(Math.abs(hours)).toBeLessThanOrEqual(24);
					expect(Math.abs(minutes)).toBeLessThan(60);
					expect(Math.abs(seconds)).toBeLessThan(60);
					expect(Math.abs(milliseconds)).toBeLessThan(1000);
					// The months are complete months, as counted by diffInMonths when going forward.
					if (sign > 0) expect(years * 12 + months).toBe(helpers.diffInMonths(end, start));
				}),
				{ numRuns: 1000 }
			);
		});

		it('addDuration applies months, then days, then time; subDuration negates every field', function () {
			fc.assert(
				fc.property(dateArb, durationArb, function (date, duration) {
					const { years = 0, months = 0, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0, milliseconds = 0 } = duration;
					const time = ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
					const calendar = helpers.addMonths(date, years * 12 + months);
					const result = helpers.addDuration(date, duration);
					// Same calendar day as month-then-day stepping, and the absolute time on top.
					const expected = helpers.addDays(calendar, weeks * 7 + days);
					// Skip a DST gap at the target time, and an intermediate day that was skipped (Kiritimati skipped 1994-12-31): stepping in two
					// conversions then differs from the single one of `addDuration`.
					fc.pre(timeOfDay(expected).join() === timeOfDay(date).join() && calendar.getDate() === Math.min(date.getDate(), helpers.getDaysInMonth(calendar)));
					expect(result.getTime()).toBe(expected.getTime() + time);
					const negated = Object.fromEntries(
						Object.entries(duration).map(function ([key, value]) {
							return [key, 0 - (value as number)];
						})
					);
					expect(helpers.subDuration(date, duration).getTime()).toBe(helpers.addDuration(date, negated).getTime());
				})
			);
		});

		it('toISOStringLocal denotes the same instant and matches the local fields', function () {
			fc.assert(
				fc.property(fc.date({ min: new Date(-50_000, 0, 1), max: new Date(50_000, 0, 1), noInvalidDate: true }), fc.boolean(), function (date, milliseconds) {
					const iso = helpers.toISOStringLocal(date, { milliseconds });
					expect(iso).toMatch(/^(?:\d{4}|[+-]\d{6})-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/);
					expect(new Date(iso).getTime()).toBe(milliseconds ? date.getTime() : date.getTime() - date.getMilliseconds());
					// Since 1980 every zone has whole-minute offsets: the string shows the wall clock.
					if (date.getFullYear() >= 1980 && date.getFullYear() <= 9999) {
						expect(iso.slice(0, 19)).toBe(helpers.formatDate(date, 'YYYY-MM-DD[T]HH:mm:ss'));
					}
					if (iso.endsWith('Z') && milliseconds) expect(iso).toBe(date.toISOString());
				}),
				{ numRuns: 500 }
			);
		});

		it('diffInWeeks counts complete weeks like addWeeks; diffInYears is diffInMonths / 12', function () {
			fc.assert(
				fc.property(dateArb, dateArb, function (later, earlier) {
					const weeks = helpers.diffInWeeks(later, earlier);
					const [from, to, sign] = later.getTime() >= earlier.getTime() ? [earlier, later, 1] : [later, earlier, -1];
					const n = sign * weeks;
					expect(helpers.addWeeks(from, n).getTime()).toBeLessThanOrEqual(to.getTime());
					expect(helpers.addWeeks(from, n + 1).getTime()).toBeGreaterThan(to.getTime());
					expect(helpers.diffInYears(later, earlier)).toBe(Math.trunc(helpers.diffInMonths(later, earlier) / 12) + 0);
					expect(helpers.diffInCalendarYears(later, earlier)).toBe(
						Math.floor(helpers.diffInCalendarMonths(later, earlier) / 12) + (later.getMonth() < earlier.getMonth() ? 1 : 0)
					);
				})
			);
		});

		it('startOf/endOf hour and minute bracket the date on wall-clock boundaries', function () {
			fc.assert(
				fc.property(dateArb, function (date) {
					const time = date.getTime();
					const hourStart = helpers.startOfHour(date);
					const hourEnd = helpers.endOfHour(date);
					const minuteStart = helpers.startOfMinute(date);
					const minuteEnd = helpers.endOfMinute(date);
					expect(hourStart.getTime()).toBeLessThanOrEqual(minuteStart.getTime());
					expect(minuteStart.getTime()).toBeLessThanOrEqual(time);
					expect(time).toBeLessThanOrEqual(minuteEnd.getTime());
					expect(minuteEnd.getTime()).toBeLessThanOrEqual(hourEnd.getTime());
					expect([minuteStart.getSeconds(), minuteStart.getMilliseconds(), minuteEnd.getSeconds(), minuteEnd.getMilliseconds()]).toEqual([0, 0, 59, 999]);
					expect([hourEnd.getMinutes(), hourEnd.getSeconds(), hourEnd.getMilliseconds()]).toEqual([59, 59, 999]);
					expect(hourStart.getSeconds() + hourStart.getMilliseconds()).toBe(0);
					expect(minuteEnd.getTime() - minuteStart.getTime()).toBe(59_999);
					// Idempotent.
					expect(helpers.startOfHour(hourStart).getTime()).toBe(hourStart.getTime());
				}),
				{ numRuns: 500 }
			);
		});

		it('roundToNearestMinutes: floor <= date <= ceil, both on the grid, and round picks the nearer one', function () {
			const stepArb = fc.constantFrom(1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60);
			fc.assert(
				fc.property(dateArb, stepArb, function (date, step) {
					const down = helpers.roundToNearestMinutes(date, step, 'floor');
					const up = helpers.roundToNearestMinutes(date, step, 'ceil');
					const nearest = helpers.roundToNearestMinutes(date, step);
					expect(down.getTime()).toBeLessThanOrEqual(date.getTime());
					expect(up.getTime()).toBeGreaterThanOrEqual(date.getTime());
					for (const value of [down, up]) {
						expect(value.getSeconds() + value.getMilliseconds()).toBe(0);
						expect(value.getMinutes() % step).toBe(0);
					}
					expect([down.getTime(), up.getTime()]).toContain(nearest.getTime());
					// Outside DST changes, the grid is 60000 * step milliseconds wide.
					if (up.getTimezoneOffset() === down.getTimezoneOffset()) {
						expect(up.getTime() - down.getTime()).toBe(date.getTime() === down.getTime() ? 0 : step * 60_000);
						const nearer = date.getTime() - down.getTime() < up.getTime() - date.getTime() ? down : up;
						expect(nearest.getTime()).toBe(nearer.getTime());
					}
				}),
				{ numRuns: 500 }
			);
		});

		it('eachOfInterval: ascending unit starts, from the unit of start to the unit of end', function () {
			const unitArb = fc.constantFrom<helpers.IntervalUnit>('year', 'quarter', 'month', 'week', 'day', 'hour', 'minute');
			const spans = { year: 2e11, quarter: 5e10, month: 2e10, week: 5e9, day: 1e9, hour: 3e8, minute: 5e6 };
			fc.assert(
				fc.property(
					dateArb,
					fc.double({ min: 0, max: 1, noNaN: true }),
					unitArb,
					fc.integer({ min: 1, max: 5 }),
					weekdayArb,
					function (start, fraction, unit, step, weekStartsOn) {
						const end = new Date(start.getTime() + Math.floor(fraction * spans[unit]));
						const dates = helpers.eachOfInterval(start, end, unit, step, weekStartsOn);
						expect(dates.length).toBeGreaterThan(0);
						expect(dates[0].getTime()).toBeLessThanOrEqual(start.getTime());
						expect(dates[dates.length - 1].getTime()).toBeLessThanOrEqual(end.getTime());
						for (let i = 1; i < dates.length; i++) expect(dates[i].getTime()).toBeGreaterThan(dates[i - 1].getTime());
						const startOf: Record<string, (date: Date) => Date> = {
							year: helpers.startOfYear,
							quarter: helpers.startOfQuarter,
							month: helpers.startOfMonth,
							week: function (date: Date): Date {
								return helpers.startOfWeek(date, weekStartsOn);
							},
							day: helpers.startOfDay,
							hour: helpers.startOfHour,
							minute: helpers.startOfMinute
						};
						expect(dates[0].getTime()).toBe(startOf[unit](start).getTime());
						for (const date of dates) expect(startOf[unit](date).getTime()).toBe(date.getTime());
						if (step === 1) expect(startOf[unit](end).getTime()).toBe(dates[dates.length - 1].getTime());
					}
				),
				{ numRuns: 300 }
			);
		});

		it('nextWeekday / previousWeekday land on the weekday 1 to 7 days away', function () {
			fc.assert(
				fc.property(dateArb, weekdayArb, function (date, weekday) {
					const next = helpers.nextWeekday(date, weekday);
					const previous = helpers.previousWeekday(date, weekday);
					expect(next.getDay()).toBe(weekday);
					expect(previous.getDay()).toBe(weekday);
					expect(helpers.diffInDays(next, date)).toBeGreaterThanOrEqual(1);
					expect(helpers.diffInDays(next, date)).toBeLessThanOrEqual(7);
					expect(helpers.diffInDays(date, previous)).toBeGreaterThanOrEqual(1);
					expect(helpers.diffInDays(date, previous)).toBeLessThanOrEqual(7);
				})
			);
		});

		it('intervalsOverlap is the intersection of half-open (or closed) integer intervals', function () {
			const intervalArb = fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 })).map(function ([x, y]) {
				return { start: Math.min(x, y), end: Math.max(x, y) };
			});
			fc.assert(
				fc.property(intervalArb, intervalArb, fc.boolean(), function (a, b, inclusive) {
					let shared = false;
					for (let t = 0; t <= 20; t += 0.5) {
						const inA = inclusive ? t >= a.start && t <= a.end : t >= a.start && t < a.end;
						const inB = inclusive ? t >= b.start && t <= b.end : t >= b.start && t < b.end;
						shared ||= inA && inB;
					}
					expect(helpers.intervalsOverlap(a, b, { inclusive })).toBe(shared);
					expect(helpers.intervalsOverlap(b, a, { inclusive })).toBe(shared);
				})
			);
		});

		it('parseDate inverts formatDate for patterns with every field', function () {
			const patternArb = fc.constantFrom(
				'YYYY-MM-DD HH:mm:ss.SSS',
				'YYYYMMDDHHmmssSSS',
				'D/M/YYYY h:m:s.SSS a',
				'[at] hh:mm:ss.SSS A [on] DD.MM.YYYY',
				'SSS ss mm HH DD MM YYYY',
				'YYYY-M-D H:mm:ss.SSS'
			);
			const wideDateArb = fc.date({ min: new Date(0, 0, 1), max: new Date(9999, 11, 31), noInvalidDate: true });
			fc.assert(
				fc.property(wideDateArb, patternArb, function (date, pattern) {
					const text = helpers.formatDate(date, pattern);
					const parsed = helpers.parseDate(text, pattern);
					expect(parsed).toBeInstanceOf(Date);
					expect(helpers.formatDate(parsed as Date, pattern)).toBe(text);
					// A repeated wall-clock time (clocks set back) resolves to its first occurrence.
					if (parsed?.getTime() !== date.getTime()) {
						expect(parsed?.getTime()).toBeLessThan(date.getTime());
						expect(parsed?.getTimezoneOffset()).not.toBe(date.getTimezoneOffset());
					}
				}),
				{ numRuns: 1000 }
			);
		});

		it('parseDate accepts exactly what formatDate produces (never throws, never half-parses)', function () {
			const pieceArb = fc.constantFrom('YYYY', 'YY', 'MM', 'M', 'DD', 'D', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's', 'SSS', 'A', 'a', '-', ':', ' ', '[T]');
			const textArb = fc.stringMatching(/^[-0-9: APMapmT]{0,20}$/);
			fc.assert(
				fc.property(fc.array(pieceArb, { maxLength: 8 }), textArb, function (pieces, text) {
					const pattern = pieces.join('');
					const parsed = helpers.parseDate(text, pattern);
					if (parsed !== undefined) expect(helpers.formatDate(parsed, pattern)).toBe(text);
				}),
				{ numRuns: 1000 }
			);
		});

		it('getDayOfYear, isTomorrow, isYesterday, isSameWeek and isSameQuarter agree with the calendar helpers', function () {
			fc.assert(
				fc.property(dateArb, dateArb, weekdayArb, function (a, b, weekStartsOn) {
					expect(helpers.getDayOfYear(a)).toBe(helpers.diffInDays(a, helpers.startOfYear(a)) + 1);
					expect(helpers.isTomorrow(a, b)).toBe(helpers.diffInDays(a, b) === 1);
					expect(helpers.isYesterday(a, b)).toBe(helpers.diffInDays(b, a) === 1);
					expect(helpers.isSameWeek(a, b, weekStartsOn)).toBe(helpers.startOfWeek(a, weekStartsOn).getTime() === helpers.startOfWeek(b, weekStartsOn).getTime());
					expect(helpers.isSameQuarter(a, b)).toBe(helpers.startOfQuarter(a).getTime() === helpers.startOfQuarter(b).getTime());
					const tomorrow = helpers.addDays(a, 1);
					expect(helpers.isTomorrow(tomorrow, a)).toBe(true);
					expect(helpers.isYesterday(a, tomorrow)).toBe(true);
				})
			);
		});
	});
});

const MAX_TIME = 8.64e15;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IANA_ZONES = Intl.supportedValuesOf('timeZone');
const OFFSET_ZONES = ['+05:30', '-08:00', '+14', '-1200', '-00:00', '+05:45'];
const zoneArb = fc.oneof({ weight: 9, arbitrary: fc.constantFrom(...IANA_ZONES) }, { weight: 1, arbitrary: fc.constantFrom(...OFFSET_ZONES) });
/** Zones with many, unusual or historical transitions. */
const TRICKY_ZONES = [
	'America/New_York',
	'Australia/Lord_Howe',
	'America/Havana',
	'America/St_Johns',
	'Pacific/Apia',
	'America/Sao_Paulo',
	'Europe/Dublin',
	'Asia/Beirut',
	'Europe/Paris',
	'Antarctica/Troll',
	'Pacific/Kiritimati',
	'America/Caracas',
	'America/Toronto'
];
/** Any valid instant, or (as often) one between 1850 and 2050, where nearly all transitions are. */
const instantArb = fc.oneof(fc.integer({ min: -MAX_TIME, max: MAX_TIME }), fc.integer({ min: Date.UTC(1850, 0, 1), max: Date.UTC(2050, 0, 1) }));

/**
 * The UTC offset of a zone at an instant, in milliseconds.
 */
function offsetMs(zone: string, time: number): number {
	return Math.round(helpers.getTimeZoneOffset(zone, time) * 60_000);
}

/**
 * The wall-clock fields as the UTC timestamp of the same fields (only for times not too close to the ends of the Date range).
 */
function wallOf(fields: helpers.WallClockTime): number {
	const date = new Date(0);
	date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
	date.setUTCHours(fields.hour ?? 0, fields.minute ?? 0, fields.second ?? 0, fields.millisecond ?? 0);
	return date.getTime();
}

/**
 * The fields of the wall-clock time written as the UTC timestamp `wall`.
 */
function fieldsOf(wall: number): helpers.WallClockTime {
	const date = new Date(wall);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
		second: date.getUTCSeconds(),
		millisecond: date.getUTCMilliseconds()
	};
}

const referenceFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Reference wall-clock fields read directly from `Intl` (with eras and a localized weekday), independently of the module's arithmetic.
 */
function referenceParts(time: number, zone: string): helpers.ZonedDateTimeParts {
	let format = referenceFormats.get(zone);
	if (format === undefined) {
		format = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			era: 'short',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			weekday: 'short',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
			fractionalSecondDigits: 3,
			hourCycle: 'h23',
			timeZoneName: 'longOffset'
		});
		referenceFormats.set(zone, format);
	}
	const parts: Record<string, string> = {};
	for (const part of format.formatToParts(time)) parts[part.type] = part.value;
	const offset = /^GMT(?:([+-])(\d\d):(\d\d)(?::(\d\d))?)?$/.exec(parts.timeZoneName) as RegExpExecArray;
	const offsetSeconds = offset[1] === undefined ? 0 : (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] ?? 0));
	return {
		year: parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour),
		minute: Number(parts.minute),
		second: Number(parts.second),
		millisecond: Number(parts.fractionalSecond),
		weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) as helpers.WeekdayIndex,
		offset: offsetSeconds / 60
	};
}

/**
 * Every instant at which the offset of `zone` changes between 1890 and 2040 (found by weekly scanning, then bisection).
 */
function transitionsOf(zone: string): number[] {
	const result: number[] = [];
	const step = 7 * DAY;
	for (let time = Date.UTC(1890, 0, 1); time < Date.UTC(2040, 0, 1); time += step) {
		if (offsetMs(zone, time) === offsetMs(zone, time + step)) continue;
		let low = time;
		let high = time + step;
		while (high - low > 1) {
			const middle = Math.floor((low + high) / 2);
			if (offsetMs(zone, middle) === offsetMs(zone, low)) low = middle;
			else high = middle;
		}
		result.push(high);
	}
	return result;
}

describe('Time zone helpers (properties)', function () {
	const transitions: Array<[string, number]> = [];

	beforeAll(function () {
		TRICKY_ZONES.forEach(function (zone) {
			transitionsOf(zone).forEach(function (time) {
				transitions.push([zone, time]);
			});
		});
	});

	/**
	 * A zone and an instant within a few hours of one of its transitions.
	 */
	function nearTransitionArb(): fc.Arbitrary<[string, number]> {
		return fc.tuple(fc.nat({ max: 1_000_000 }), fc.integer({ min: -3 * HOUR, max: 3 * HOUR })).map(function ([index, delta]): [string, number] {
			const [zone, time] = transitions[index % transitions.length];
			return [zone, time + delta];
		});
	}

	it('finds transitions in the tricky zones', function () {
		expect(transitions.length).toBeGreaterThan(1000);
	});

	it('getZonedParts and getTimeZoneOffset agree with the fields that Intl writes', function () {
		fc.assert(
			fc.property(fc.constantFrom(...IANA_ZONES), instantArb, function (zone, time) {
				const parts = helpers.getZonedParts(time, zone);
				expect(parts).toEqual(referenceParts(time, zone));
				expect(helpers.getTimeZoneOffset(zone, time)).toBe(parts.offset);
			}),
			{ numRuns: 500 }
		);
	});

	it('the wall clock is the instant plus the offset, in every zone', function () {
		fc.assert(
			fc.property(zoneArb, fc.integer({ min: -8.6e15, max: 8.6e15 }), function (zone, time) {
				const parts = helpers.getZonedParts(time, zone);
				expect(wallOf(parts) - time).toBe(Math.round(parts.offset * 60_000));
				expect(parts.weekday).toBe(new Date(wallOf(parts)).getUTCDay());
			}),
			{ numRuns: 500 }
		);
	});

	it('fromZonedTime(getZonedParts(t, zone), zone) is t', function () {
		fc.assert(
			fc.property(fc.oneof(fc.tuple(zoneArb, instantArb), nearTransitionArb()), function ([zone, time]) {
				expect(helpers.fromZonedTime(helpers.getZonedParts(time, zone), zone).getTime()).toBe(time);
			}),
			{ numRuns: 500 }
		);
	});

	it('fromZonedTime finds every occurrence of a wall-clock time and resolves gaps like Temporal (naive reference)', function () {
		const wallArb = fc.oneof(
			fc.tuple(zoneArb, fc.integer({ min: Date.UTC(1850, 0, 1), max: Date.UTC(2050, 0, 1) })),
			// Wall-clock times around a transition, as read before it: inside the gaps and the repeated hours.
			nearTransitionArb().map(function ([zone, time]): [string, number] {
				return [zone, time + offsetMs(zone, time - 3 * HOUR)];
			})
		);
		fc.assert(
			fc.property(wallArb, function ([zone, wall]) {
				const fields = fieldsOf(wall);
				// Naive reference: try every offset in force within two days.
				const offsets = new Set<number>();
				for (let time = wall - 2 * DAY; time <= wall + 2 * DAY; time += HOUR / 4) offsets.add(offsetMs(zone, time));
				const occurrences = [...offsets]
					.map(function (offset) {
						return wall - offset;
					})
					.filter(function (time) {
						return wallOf(helpers.getZonedParts(time, zone)) === wall;
					})
					.sort(function (a, b) {
						return a - b;
					});
				const earlier = helpers.fromZonedTime(fields, zone, { disambiguation: 'earlier' }).getTime();
				const later = helpers.fromZonedTime(fields, zone, { disambiguation: 'later' }).getTime();
				const compatible = helpers.fromZonedTime(fields, zone).getTime();
				/**
				 * Resolves the wall-clock time with `'reject'`.
				 */
				function reject(): number {
					return helpers.fromZonedTime(fields, zone, { disambiguation: 'reject' }).getTime();
				}
				if (occurrences.length > 0) {
					expect([earlier, later]).toEqual([occurrences[0], occurrences[occurrences.length - 1]]);
					expect(compatible).toBe(earlier);
					if (occurrences.length === 1) expect(reject()).toBe(earlier);
					else expect(reject).toThrow(RangeError);
				} else {
					// A gap: 'later' (and 'compatible') moves forward by its length, 'earlier' back by it.
					const gap = later - earlier;
					expect(gap).toBeGreaterThan(0);
					expect(compatible).toBe(later);
					expect(wallOf(helpers.getZonedParts(later, zone)) - wall).toBe(gap);
					expect(wall - wallOf(helpers.getZonedParts(earlier, zone))).toBe(gap);
					expect(reject).toThrow(RangeError);
				}
			}),
			{ numRuns: 300 }
		);
	});

	it('startOfDayInTimeZone / endOfDayInTimeZone bound exactly the instants of the zone day', function () {
		/**
		 * The epoch day of the wall clock of `zone` at `time`.
		 */
		function dayOf(zone: string, time: number): number {
			return Math.floor(wallOf(helpers.getZonedParts(time, zone)) / DAY);
		}
		fc.assert(
			fc.property(fc.oneof(fc.tuple(zoneArb, fc.integer({ min: -8.6e15, max: 8.6e15 })), nearTransitionArb()), function ([zone, time]) {
				const start = helpers.startOfDayInTimeZone(time, zone).getTime();
				const end = helpers.endOfDayInTimeZone(time, zone).getTime();
				const day = dayOf(zone, time);
				expect(start).toBeLessThanOrEqual(time);
				expect(end).toBeGreaterThanOrEqual(time);
				expect([dayOf(zone, start), dayOf(zone, end)]).toEqual([day, day]);
				expect(dayOf(zone, start - 1)).toBeLessThan(day);
				expect(dayOf(zone, end + 1)).toBeGreaterThan(day);
			}),
			{ numRuns: 500 }
		);
	});

	it('agree with the local-time helpers in the runtime time zone', function () {
		const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const pieceArb = fc.constantFrom('YYYY', 'YY', 'MM', 'M', 'DD', 'D', 'HH', 'H', 'hh', 'h', 'mm', 'm', 'ss', 's', 'SSS', 'A', 'a', '-', ':', ' ', '[T]', '[Z]');
		fc.assert(
			fc.property(dateArb, fc.array(pieceArb, { maxLength: 8 }), function (date, pieces) {
				const parts = helpers.getZonedParts(date, local);
				expect([parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond, parts.weekday]).toEqual([
					...ymd(date),
					...timeOfDay(date),
					date.getDay()
				]);
				expect(helpers.startOfDayInTimeZone(date, local).getTime()).toBe(helpers.startOfDay(date).getTime());
				expect(helpers.endOfDayInTimeZone(date, local).getTime()).toBe(helpers.endOfDay(date).getTime());
				const pattern = pieces.join('');
				expect(helpers.formatInTimeZone(date, local, pattern)).toBe(helpers.formatDate(date, pattern));
			}),
			{ numRuns: 300 }
		);
	});

	it('formatInTimeZone writes RFC 3339 timestamps that parse back to the same instant', function () {
		fc.assert(
			fc.property(zoneArb, fc.integer({ min: Date.parse('0001-01-02T00:00:00Z'), max: Date.UTC(9999, 11, 30) }), function (zone, time) {
				// Offsets with seconds (local mean time) cannot be parsed by Date.
				fc.pre(offsetMs(zone, time) % 60_000 === 0);
				expect(Date.parse(helpers.formatInTimeZone(time, zone, 'YYYY-MM-DD[T]HH:mm:ss.SSSZ'))).toBe(time);
			}),
			{ numRuns: 500 }
		);
	});

	it('getCalendarMonth matches a naive grid built with Date setters', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 0, max: 11 }), weekdayArb, fc.boolean(), function (year, monthIndex, weekStartsOn, fixedWeeks) {
				const weeks = helpers.getCalendarMonth(year, monthIndex, { weekStartsOn, fixedWeeks });
				const first = new Date(2000, 0, 1, 12);
				first.setFullYear(year, monthIndex, 1);
				const lead = (first.getDay() - weekStartsOn + 7) % 7;
				const length = helpers.daysInMonth(year, monthIndex);
				expect(weeks).toHaveLength(fixedWeeks ? 6 : Math.ceil((lead + length) / 7));
				weeks.flat().forEach(function (cell, i) {
					const expected = new Date(2000, 0, 1, 12);
					expected.setFullYear(year, monthIndex, 1 - lead + i);
					expected.setHours(0, 0, 0, 0);
					expect(cell.getTime()).toBe(expected.getTime());
				});
				weeks.forEach(function (week) {
					expect(week).toHaveLength(7);
				});
			}),
			{ numRuns: 300 }
		);
	});
});

describe('Scheduling helpers (properties)', function () {
	/**
	 * Intervals with integer bounds in [0, 40] (possibly empty), as timestamps.
	 */
	const intervalArb = fc.tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 0, max: 40 })).map(function ([x, y]) {
		return { start: Math.min(x, y), end: Math.max(x, y) };
	});
	const intervalsArb = fc.array(intervalArb, { maxLength: 12 });

	/**
	 * Whether an interval contains the instant `t`, half-open or closed.
	 */
	function contains(interval: helpers.Interval, t: number, inclusive: boolean): boolean {
		const start = +interval.start;
		const end = +interval.end;
		return inclusive ? start <= t && t <= end : start <= t && t < end;
	}

	/**
	 * Whether any interval contains the instant `t`.
	 */
	function covered(intervals: helpers.Interval[], t: number, inclusive: boolean): boolean {
		return intervals.some(function (interval) {
			return contains(interval, t, inclusive);
		});
	}

	it('mergeIntervals: sorted, disjoint, covering exactly the same instants, and idempotent', function () {
		fc.assert(
			fc.property(intervalsArb, fc.boolean(), function (intervals, inclusive) {
				const merged = helpers.mergeIntervals(intervals, { inclusive });

				for (let i = 1; i < merged.length; i++) {
					// Strictly apart when closed; apart or touching when half-open (touching ones are only merged when closed).
					expect(merged[i].start.getTime()).toBeGreaterThan(merged[i - 1].end.getTime() - (inclusive ? 0 : 1));
					expect(helpers.intervalsOverlap(merged[i - 1], merged[i], { inclusive })).toBe(false);
				}
				merged.forEach(function (interval) {
					expect(interval.start.getTime()).toBeLessThanOrEqual(interval.end.getTime());
					if (!inclusive) expect(interval.start.getTime()).toBeLessThan(interval.end.getTime());
				});
				for (let t = -1; t <= 41; t++) expect(covered(merged, t, inclusive)).toBe(covered(intervals, t, inclusive));
				expect(helpers.mergeIntervals(merged, { inclusive })).toEqual(merged);
			})
		);
	});

	it('intersectIntervals: defined exactly when intervalsOverlap, holding exactly the shared instants', function () {
		fc.assert(
			fc.property(intervalArb, intervalArb, fc.boolean(), function (a, b, inclusive) {
				const shared = helpers.intersectIntervals(a, b, { inclusive });

				expect(shared !== undefined).toBe(helpers.intervalsOverlap(a, b, { inclusive }));
				expect(helpers.intersectIntervals(b, a, { inclusive })).toEqual(shared);
				for (let t = -1; t <= 41; t++) {
					expect(shared !== undefined && contains(shared, t, inclusive)).toBe(contains(a, t, inclusive) && contains(b, t, inclusive));
				}
			})
		);
	});

	it('findGaps: the gaps and the busy time inside `within` partition `within`', function () {
		fc.assert(
			fc.property(intervalArb, intervalsArb, fc.integer({ min: 0, max: 10 }), function (within, busy, minDuration) {
				const gaps = helpers.findGaps(within, busy);

				expect(helpers.subtractIntervals(within, busy)).toEqual(gaps);
				for (let i = 0; i < gaps.length; i++) {
					expect(gaps[i].start.getTime()).toBeLessThan(gaps[i].end.getTime());
					if (i > 0) expect(gaps[i].start.getTime()).toBeGreaterThan(gaps[i - 1].end.getTime());
				}
				for (let t = -1; t <= 41; t++) {
					const inGap = covered(gaps, t, false);
					const inBusy = covered(busy, t, false);

					// Every instant of `within` is either free or busy, never both; nothing outside `within` is free.
					expect(inGap).toBe(contains(within, t, false) && !inBusy);
				}
				expect(helpers.findGaps(within, busy, { minDuration })).toEqual(
					gaps.filter(function (gap) {
						return gap.end.getTime() - gap.start.getTime() >= minDuration;
					})
				);
			})
		);
	});

	describe('business days with options', function () {
		// No whole calendar day is skipped in these years in the zones the suite runs in (Samoa skipped 2011-12-30).
		const businessDateArb = fc.date({ min: new Date(1950, 0, 1), max: new Date(2010, 0, 1), noInvalidDate: true });
		const weekendArb = fc.uniqueArray(weekdayArb, { maxLength: 6 });
		const holidayOffsetsArb = fc.array(fc.integer({ min: -120, max: 120 }), { maxLength: 40 });

		/**
		 * Naive reference: walks one calendar day at a time with `isBusinessDay`, over the days that exist.
		 */
		function naiveAdd(date: Date, amount: number, options: helpers.BusinessDayOptions): Date {
			const sign = amount < 0 ? -1 : 1;
			let remaining = Math.abs(amount);
			let offset = 0;

			while (remaining > 0) {
				offset += sign;

				const day = existingDay(date, offset);

				if (day !== undefined && helpers.isBusinessDay(day, options)) remaining--;
			}

			return helpers.addDays(date, offset);
		}

		/**
		 * Naive reference: the business days among the existing days in `(earlier, earlier + span]`.
		 */
		function naiveCount(earlier: Date, span: number, options: helpers.BusinessDayOptions): number {
			let count = 0;

			for (let offset = 1; offset <= span; offset++) {
				const day = existingDay(earlier, offset);

				if (day !== undefined && helpers.isBusinessDay(day, options)) count++;
			}

			return count;
		}

		/**
		 * Holidays at the given day offsets from `date`, at various times of day.
		 */
		function holidaysAround(date: Date, offsets: number[]): Date[] {
			return offsets.map(function (offset, i) {
				return helpers.setParts(helpers.addDays(date, offset), { hour: i % 24 });
			});
		}

		it('addBusinessDays matches a naive day-by-day walk, and diffInBusinessDays inverts it', function () {
			fc.assert(
				fc.property(businessDateArb, fc.integer({ min: -60, max: 60 }), weekendArb, holidayOffsetsArb, function (date, n, weekend, offsets) {
					const options = { weekend, holidays: holidaysAround(date, offsets) };
					const result = helpers.addBusinessDays(date, n, options);

					expect(result.getTime()).toBe(naiveAdd(date, n, options).getTime());
					if (n !== 0) expect(helpers.isBusinessDay(result, options)).toBe(true);
					if (helpers.isBusinessDay(date, options)) expect(helpers.diffInBusinessDays(result, date, options)).toBe(n);
				})
			);
		});

		it('diffInBusinessDays counts the business days in (earlier, later], antisymmetrically', function () {
			fc.assert(
				fc.property(businessDateArb, fc.integer({ min: 0, max: 90 }), weekendArb, holidayOffsetsArb, function (earlier, span, weekend, offsets) {
					const options = { weekend, holidays: holidaysAround(earlier, offsets) };
					const later = helpers.addDays(earlier, span);
					const count = naiveCount(earlier, span, options);

					expect(helpers.diffInBusinessDays(later, earlier, options)).toBe(count);
					expect(helpers.diffInBusinessDays(earlier, later, options)).toBe(0 - count);
				})
			);
		});

		it('step over and do not count a skipped calendar day (Samoa, 2011-12-30), in any process time zone', function () {
			const realProcess = new (util.inspect.constructor as FunctionConstructor)('return process')() as { env: Record<string, string | undefined> };
			const around = fc.integer({ min: Date.UTC(2011, 9, 1), max: Date.UTC(2012, 2, 1) });

			fc.assert(
				fc.property(
					around,
					fc.integer({ min: -60, max: 60 }),
					fc.integer({ min: 0, max: 90 }),
					weekendArb,
					holidayOffsetsArb,
					function (time, n, span, weekend, offsets) {
						const previous = realProcess.env.TZ;

						realProcess.env.TZ = 'Pacific/Apia';
						try {
							const date = new Date(time);
							const options = { weekend, holidays: holidaysAround(date, offsets) };
							const result = helpers.addBusinessDays(date, n, options);

							expect(result.getTime()).toBe(naiveAdd(date, n, options).getTime());
							if (n !== 0) expect(helpers.isBusinessDay(result, options)).toBe(true);
							if (helpers.isBusinessDay(date, options)) expect(helpers.diffInBusinessDays(result, date, options)).toBe(n);
							// Where `date + span` was skipped, `addDays` lands a day later.
							const reach = existingDay(date, span) === undefined ? span + 1 : span;

							expect(helpers.diffInBusinessDays(helpers.addDays(date, span), date, options)).toBe(naiveCount(date, reach, options));
						} finally {
							if (previous === undefined) delete realProcess.env.TZ;
							else realProcess.env.TZ = previous;
						}
					}
				)
			);
		});
	});

	it('setParts: the given fields are set, the others kept (the day clamped), and the current fields give back the instant', function () {
		const partsArb = fc.record(
			{
				year: fc.integer({ min: 1900, max: 2200 }),
				month: fc.integer({ min: 1, max: 12 }),
				day: fc.integer({ min: 1, max: 28 }),
				hour: fc.integer({ min: 0, max: 23 }),
				minute: fc.integer({ min: 0, max: 59 }),
				second: fc.integer({ min: 0, max: 59 }),
				millisecond: fc.integer({ min: 0, max: 999 })
			},
			{ requiredKeys: [] }
		);
		fc.assert(
			fc.property(dateArb, partsArb, function (date, fields) {
				const current = {
					year: date.getFullYear(),
					month: date.getMonth() + 1,
					day: date.getDate(),
					hour: date.getHours(),
					minute: date.getMinutes(),
					second: date.getSeconds(),
					millisecond: date.getMilliseconds()
				};

				expect(helpers.setParts(date, current).getTime()).toBe(date.getTime());

				const result = helpers.setParts(date, fields);
				const expected = { ...current, ...fields };

				if (fields.day === undefined) expected.day = Math.min(current.day, helpers.daysInMonth(expected.year, expected.month - 1));

				const actual = {
					year: result.getFullYear(),
					month: result.getMonth() + 1,
					day: result.getDate(),
					hour: result.getHours(),
					minute: result.getMinutes(),
					second: result.getSeconds(),
					millisecond: result.getMilliseconds()
				};

				// Skip the rare wall-clock times that a DST change skipped.
				fc.pre(actual.hour === expected.hour && actual.minute === expected.minute && actual.day === expected.day);
				expect(actual).toEqual(expected);
				expect(helpers.setParts(result, fields).getTime()).toBe(result.getTime());
			})
		);
	});

	it('closestTo returns a candidate at the smallest distance, the first such one', function () {
		fc.assert(
			fc.property(fc.integer({ min: -1000, max: 1000 }), fc.array(fc.integer({ min: -1000, max: 1000 })), function (target, dates) {
				let best: number | undefined;

				dates.forEach(function (date) {
					if (best === undefined || Math.abs(date - target) < Math.abs(best - target)) best = date;
				});

				expect(helpers.closestTo(target, dates)).toEqual(best === undefined ? undefined : new Date(best));
			})
		);
	});

	it('getUnixTime and fromUnixTime round-trip whole seconds, and getUnixTime is the second an instant is in', function () {
		fc.assert(
			fc.property(fc.integer({ min: -8.64e12, max: 8.64e12 }), fc.integer({ min: -8.64e15, max: 8.64e15 }), function (seconds, time) {
				expect(helpers.getUnixTime(helpers.fromUnixTime(seconds))).toBe(seconds);

				const start = helpers.fromUnixTime(helpers.getUnixTime(time)).getTime();

				expect(start).toBeLessThanOrEqual(time);
				expect(time - start).toBeLessThan(1000);
			})
		);
	});
});

describe('fromUnixTime (properties)', function () {
	it('keeps the written milliseconds and drops finer digits, toward zero', function () {
		fc.assert(
			fc.property(
				// Below 2^33 s (year 2242), where a double still tells microseconds apart: from 2^33 on, `x.000999` and `x.001` are one number.
				fc.integer({ min: 0, max: 2 ** 33 - 1 }),
				fc.integer({ min: 0, max: 999 }),
				fc.integer({ min: 0, max: 999 }),
				fc.boolean(),
				function (whole, ms, micro, negative) {
					const written = Number(`${negative ? '-' : ''}${whole}.${String(ms).padStart(3, '0')}${String(micro).padStart(3, '0')}`);
					// The shortest representation of the double may drop trailing zeros or round the last digits, but never across a
					// millisecond: the result is the written millisecond, truncated toward zero.
					const expected = (negative ? -1 : 1) * (whole * 1000 + ms);
					expect(helpers.fromUnixTime(written).getTime()).toBe(expected === 0 ? 0 : expected);
				}
			),
			{ numRuns: 2000 }
		);
	});
});

describe('Cron (properties)', function () {
	const SECOND = 1000;
	const MINUTE = 60_000;
	const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
	const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

	/**
	 * The meaning of a generated cron expression, worked out from the generator's choices rather than by `parseCron`.
	 */
	interface CronSpec {
		expression: string;
		hasSeconds: boolean;
		seconds: Set<number>;
		minutes: Set<number>;
		hours: Set<number>;
		days: Set<number>;
		lastDay: boolean;
		months: Set<number>;
		weekdays: Set<number>;
		lastWeekdays: Set<number>;
		/** `10 * k + w` for `w#k`. */
		nthWeekdays: Set<number>;
		either: boolean;
		fixed: boolean;
	}

	/**
	 * A generated field: its text, whether it starts with `*`, and its values.
	 */
	interface FieldSpec {
		text: string;
		star: boolean;
		values: number[];
		extras: string[];
	}

	/**
	 * Writes a value of a field, as digits (sometimes zero-padded) or, when the field has names, sometimes as a name in random case.
	 */
	function valueText(value: number, min: number, names: string[] | undefined, style: number): string {
		const name = names?.[value - min];

		if (name !== undefined && style % 3 === 0) return style % 2 === 0 ? name : name.toLowerCase();

		return style % 5 === 1 ? `0${value}` : String(value);
	}

	/**
	 * Generates a list item: `*`, `*\/n`, `a`, `a-b`, `a-b/n` or `a/n`, with the values it stands for.
	 */
	function itemArb(min: number, max: number, names: string[] | undefined, valueArb: fc.Arbitrary<number>): fc.Arbitrary<FieldSpec> {
		const top = max === 7 ? 7 : max;
		const step = fc.integer({ min: 1, max: top });
		const style = fc.nat(29);

		/**
		 * The values from `low` to `high`, every `by`.
		 */
		function run(low: number, high: number, by: number): number[] {
			const values: number[] = [];

			for (let value = low; value <= high; value += by) values.push(value);

			return values;
		}

		return fc.oneof(
			{ weight: 4, arbitrary: fc.constant<FieldSpec>({ text: '*', star: true, values: run(min, top, 1), extras: [] }) },
			{
				weight: 3,
				arbitrary: step.map(function (by) {
					return { text: `*/${by}`, star: true, values: run(min, top, by), extras: [] };
				})
			},
			{
				weight: 3,
				arbitrary: fc.tuple(valueArb, style).map(function ([value, s]) {
					return { text: valueText(value, min, names, s), star: false, values: [value], extras: [] };
				})
			},
			{
				weight: 2,
				arbitrary: fc.tuple(valueArb, valueArb, style, style).map(function ([a, b, s, t]) {
					const low = Math.min(a, b);
					const high = Math.max(a, b);

					return { text: `${valueText(low, min, names, s)}-${valueText(high, min, names, t)}`, star: false, values: run(low, high, 1), extras: [] };
				})
			},
			{
				weight: 1,
				arbitrary: fc.tuple(valueArb, valueArb, step, style).map(function ([a, b, by, s]) {
					const low = Math.min(a, b);
					const high = Math.max(a, b);

					return { text: `${valueText(low, min, names, s)}-${high}/${by}`, star: false, values: run(low, high, by), extras: [] };
				})
			},
			{
				weight: 1,
				arbitrary: fc.tuple(valueArb, step).map(function ([low, by]) {
					return { text: `${low}/${by}`, star: false, values: run(low, top, by), extras: [] };
				})
			}
		);
	}

	/**
	 * Generates a field: a list of 1 to 3 items, plus the extensions of the day fields (`L`, `wL`, `w#k`).
	 */
	function fieldArb(min: number, max: number, names: string[] | undefined, valueArb: fc.Arbitrary<number>, extraArb?: fc.Arbitrary<string>): fc.Arbitrary<FieldSpec> {
		const items = fc.array(
			extraArb === undefined
				? itemArb(min, max, names, valueArb)
				: fc.oneof(
						{ weight: 5, arbitrary: itemArb(min, max, names, valueArb) },
						{
							weight: 1,
							arbitrary: extraArb.map(function (text) {
								return { text, star: false, values: [], extras: [text] };
							})
						}
					),
			{ minLength: 1, maxLength: 3 }
		);

		return items.map(function (list) {
			return {
				text: list
					.map(function (item) {
						return item.text;
					})
					.join(','),
				star: list[0].text[0] === '*',
				values: list.flatMap(function (item) {
					return item.values;
				}),
				extras: list.flatMap(function (item) {
					return item.extras;
				})
			};
		});
	}

	const cronWeekdayArb = fc.integer({ min: 0, max: 7 });

	/**
	 * A day, month or weekday field: often `*`, so that the jobs often fire on the days when the clocks change.
	 */
	function dayFieldArb(field: fc.Arbitrary<FieldSpec>, max: number): fc.Arbitrary<FieldSpec> {
		const values: number[] = [];

		for (let value = max === 7 ? 0 : 1; value <= max; value++) values.push(value);

		return fc.oneof({ weight: 3, arbitrary: fc.constant<FieldSpec>({ text: '*', star: true, values, extras: [] }) }, { weight: 2, arbitrary: field });
	}

	const cronArb: fc.Arbitrary<CronSpec> = fc
		.record({
			hasSeconds: fc.boolean(),
			second: fieldArb(0, 59, undefined, fc.integer({ min: 0, max: 59 })),
			minute: fieldArb(0, 59, undefined, fc.integer({ min: 0, max: 59 })),
			// Hours around midnight and 2-3 am, where the clocks change, come up more often.
			hour: fieldArb(0, 23, undefined, fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 23 }))),
			day: dayFieldArb(fieldArb(1, 31, undefined, fc.integer({ min: 1, max: 31 }), fc.constantFrom('L', 'l')), 31),
			month: dayFieldArb(fieldArb(1, 12, MONTH_NAMES, fc.integer({ min: 1, max: 12 })), 12),
			weekday: dayFieldArb(
				fieldArb(
					0,
					7,
					WEEKDAY_NAMES,
					cronWeekdayArb,
					fc.oneof(
						fc.tuple(cronWeekdayArb, fc.boolean()).map(function ([w, name]) {
							return `${name && w < 7 ? WEEKDAY_NAMES[w] : w}L`;
						}),
						fc.tuple(cronWeekdayArb, fc.integer({ min: 1, max: 5 })).map(function ([w, k]) {
							return `${w}#${k}`;
						})
					)
				),
				7
			),
			separator: fc.constantFrom(' ', '  ', '\t', ' \t ')
		})
		.map(function ({ hasSeconds, second, minute, hour, day, month, weekday, separator }) {
			const fields = [minute, hour, day, month, weekday];

			if (hasSeconds) fields.unshift(second);

			const nthWeekdays = new Set<number>();
			const lastWeekdays = new Set<number>();

			for (const extra of weekday.extras) {
				const nth = /^(\w+?)(L|#(\d))$/.exec(extra) as RegExpExecArray;
				const w = WEEKDAY_NAMES.includes(nth[1]) ? WEEKDAY_NAMES.indexOf(nth[1]) : Number(nth[1]) % 7;

				if (nth[2] === 'L') lastWeekdays.add(w);
				else nthWeekdays.add(10 * Number(nth[3]) + w);
			}

			return {
				expression: fields
					.map(function (field) {
						return field.text;
					})
					.join(separator),
				hasSeconds,
				seconds: new Set(hasSeconds ? second.values : [0]),
				minutes: new Set(minute.values),
				hours: new Set(hour.values),
				days: new Set(day.values),
				lastDay: day.extras.length > 0,
				months: new Set(month.values),
				weekdays: new Set(
					weekday.values.map(function (w) {
						return w % 7;
					})
				),
				lastWeekdays,
				nthWeekdays,
				either: !day.star && !weekday.star,
				fixed: !minute.star && !hour.star
			};
		});

	/**
	 * The number of days of a month (1-12) of a year.
	 */
	function monthLength(year: number, month: number): number {
		const date = new Date(0);

		date.setUTCFullYear(year, month, 0);

		return date.getUTCDate();
	}

	/**
	 * Whether a calendar day (as UTC fields of `wall`) matches the spec's day fields.
	 */
	function dayMatches(spec: CronSpec, wall: number): boolean {
		const date = new Date(wall);
		const day = date.getUTCDate();
		const length = monthLength(date.getUTCFullYear(), date.getUTCMonth() + 1);
		const weekday = date.getUTCDay();

		if (!spec.months.has(date.getUTCMonth() + 1)) return false;

		const byDate = spec.days.has(day) || (spec.lastDay && day === length);
		const byWeekday = spec.weekdays.has(weekday) || (spec.lastWeekdays.has(weekday) && day + 7 > length) || spec.nthWeekdays.has(10 * Math.ceil(day / 7) + weekday);

		return spec.either ? byDate || byWeekday : byDate && byWeekday;
	}

	/**
	 * Whether a wall-clock time (as the UTC fields of `wall`, whole seconds) matches the spec.
	 */
	function specMatches(spec: CronSpec, wall: number): boolean {
		const date = new Date(wall);

		return spec.seconds.has(date.getUTCSeconds()) && spec.minutes.has(date.getUTCMinutes()) && spec.hours.has(date.getUTCHours()) && dayMatches(spec, wall);
	}

	/**
	 * The matching times of day of the spec, in seconds since midnight, sorted.
	 */
	function timesOfDay(spec: CronSpec): number[] {
		const times: number[] = [];

		for (let h = 0; h < 24; h++) {
			if (!spec.hours.has(h)) continue;
			for (let m = 0; m < 60; m++) {
				if (!spec.minutes.has(m)) continue;
				for (let s = 0; s < 60; s++) if (spec.seconds.has(s)) times.push(h * 3600 + m * 60 + s);
			}
		}

		return times;
	}

	const offsetFormats = new Map<string, Intl.DateTimeFormat>();

	/**
	 * The UTC offset of a zone at an instant, read from `Intl`'s `longOffset` time zone name (`GMT-04:56:02`), independently of the
	 * module's own reading of the wall clock.
	 */
	function referenceOffset(zone: string, time: number): number {
		let format = offsetFormats.get(zone);

		if (format === undefined) {
			format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
			offsetFormats.set(zone, format);
		}

		const name = (
			format.formatToParts(time).find(function (part) {
				return part.type === 'timeZoneName';
			}) as Intl.DateTimeFormatPart
		).value;
		const match = /^GMT(?:([+-])(\d\d):(\d\d)(?::(\d\d))?)?$/.exec(name) as RegExpExecArray;

		return match[1] === undefined ? 0 : (match[1] === '-' ? -1 : 1) * ((Number(match[2]) * 60 + Number(match[3])) * 60 + Number(match[4] ?? 0)) * SECOND;
	}

	/**
	 * The offsets of a zone over a window: `[start, offset]` pieces, found by sampling every 6 hours (offset changes are days apart) and
	 * bisecting to the millisecond.
	 */
	function offsetPieces(zone: string, start: number, end: number): Array<[number, number]> {
		const pieces: Array<[number, number]> = [[-Infinity, referenceOffset(zone, start)]];
		let previous = pieces[0][1];

		for (let time = start; time < end;) {
			const next = Math.min(time + 6 * HOUR, end);
			const offset = referenceOffset(zone, next);

			if (offset !== previous) {
				let low = time;
				let high = next;

				while (high - low > 1) {
					const middle = Math.floor((low + high) / 2);

					if (referenceOffset(zone, middle) === previous) low = middle;
					else high = middle;
				}
				pieces.push([high, offset]);
				previous = offset;
			}
			time = next;
		}

		return pieces;
	}

	const transitionCache = new Map<string, number[]>();

	/**
	 * The instants at which a zone's offset changes during a year.
	 */
	function transitionsIn(zone: string, year: number): number[] {
		const key = `${zone} ${year}`;
		let transitions = transitionCache.get(key);

		if (transitions === undefined) {
			transitions = offsetPieces(zone, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1))
				.slice(1)
				.map(function (piece) {
					return piece[0];
				});
			transitionCache.set(key, transitions);
		}

		return transitions;
	}

	/**
	 * Brute force: simulates cronie's main loop (cron.c), which wakes up every minute (here every `tick`), compares the wall clock with
	 * its virtual time and runs the jobs: the normal step runs every job matching the wall clock; a forward jump of less than 5 minutes
	 * runs every job for each skipped tick; one of less than 3 hours runs the wildcard jobs for the current time and the fixed-time jobs
	 * for each skipped tick; a backward jump of up to 3 hours runs only the wildcard jobs until the wall clock catches up with the virtual
	 * time; any larger jump resets the virtual time and runs every job for the current time. Returns the instants in `(from, end]` at
	 * which the job runs.
	 */
	function simulate(spec: CronSpec, zone: string, from: number, end: number): number[] {
		const tick = spec.hasSeconds ? SECOND : MINUTE;
		const start = Math.floor((from - 4 * HOUR) / tick) * tick;
		const pieces = offsetPieces(zone, start - DAY, end + DAY);
		let piece = 0;

		/**
		 * The wall clock at `time` (called in increasing order).
		 */
		function wallAt(time: number): number {
			while (piece + 1 < pieces.length && pieces[piece + 1][0] <= time) piece++;

			return time + pieces[piece][1];
		}

		/**
		 * Whether some tick of `(low, high]` matches.
		 */
		function anyMatch(low: number, high: number, wildcardsToo: boolean): boolean {
			if (!wildcardsToo && !spec.fixed) return false;
			for (let wall = low + tick; wall <= high; wall += tick) if (specMatches(spec, wall)) return true;

			return false;
		}

		let virtual = wallAt(start);
		const fires: number[] = [];

		for (let time = start + tick; time <= end; time += tick) {
			const running = wallAt(time);
			const diff = running - virtual;
			let fire: boolean;

			if (diff === tick) {
				fire = specMatches(spec, running);
				virtual = running;
			} else if (diff > tick) {
				const gap = diff - tick;

				if (gap < 5 * MINUTE) fire = anyMatch(virtual, running, true);
				else if (gap < 3 * HOUR) fire = (!spec.fixed && specMatches(spec, running)) || anyMatch(virtual, running, false);
				else fire = specMatches(spec, running);
				virtual = running;
			} else if (tick - diff <= 3 * HOUR) fire = !spec.fixed && specMatches(spec, running);
			else {
				fire = specMatches(spec, running);
				virtual = running;
			}
			if (fire && time > from) fires.push(time);
		}

		return fires;
	}

	/**
	 * The times of a list of dates.
	 */
	function timesOf(dates: Iterable<Date>): number[] {
		return Array.from(dates, function (date) {
			return date.getTime();
		});
	}

	const DST_ZONES = [
		'America/New_York',
		'Europe/London',
		'Australia/Lord_Howe',
		'Pacific/Apia',
		'America/Havana',
		'Pacific/Chatham',
		'Antarctica/Troll',
		'Europe/Dublin',
		'America/St_Johns',
		'Australia/Adelaide',
		'America/Santiago',
		'Asia/Kolkata'
	];

	/**
	 * An instant to search from: within 30 hours of a change of offset of the zone in a year, or anywhere in it.
	 */
	const fromArb = fc
		.record({
			zone: fc.constantFrom(...DST_ZONES),
			year: fc.oneof(fc.integer({ min: 1996, max: 2030 }), fc.constant(2011)),
			pick: fc.nat(),
			near: fc.integer({ min: 0, max: 4 }),
			delta: fc.integer({ min: -30 * HOUR, max: 30 * HOUR }),
			anywhere: fc.integer({ min: 0, max: 365 * DAY })
		})
		.map(function ({ zone, year, pick, near, delta, anywhere }) {
			const transitions = transitionsIn(zone, year);
			const from = near > 0 && transitions.length > 0 ? transitions[pick % transitions.length] + delta : Date.UTC(year, 0, 1) + anywhere;

			return { zone, from };
		});

	/**
	 * The integers from 0 to `count - 1`.
	 */
	function upTo(count: number): number[] {
		const values: number[] = [];

		for (let value = 0; value < count; value++) values.push(value);

		return values;
	}

	/**
	 * A spec for a job firing every day at the given times (`*` day fields).
	 */
	function dailySpec(expression: string, seconds: number[], minutes: number[], hours: number[], fixed: boolean): CronSpec {
		/**
		 * The values from `min` to `max`.
		 */
		function all(min: number, max: number): Set<number> {
			return new Set(upTo(max + 1).slice(min));
		}

		return {
			expression,
			hasSeconds: expression.split(' ').length === 6,
			seconds: new Set(seconds),
			minutes: new Set(minutes),
			hours: new Set(hours),
			days: all(1, 31),
			lastDay: false,
			months: all(1, 12),
			weekdays: all(0, 6),
			lastWeekdays: new Set(),
			nthWeekdays: new Set(),
			either: false,
			fixed
		};
	}

	/**
	 * A job built around a change of offset, firing at wall-clock times next to it (skipped, repeated, or just outside the change) as a
	 * fixed-time or a wildcard job, and a search that starts shortly before the change or during it.
	 */
	const nearArb = fc
		.record({
			zone: fc.constantFrom(...DST_ZONES.slice(0, -1)),
			year: fc.oneof(fc.integer({ min: 1996, max: 2030 }), fc.constant(2011)),
			pick: fc.nat(),
			minutes: fc.integer({ min: -200, max: 200 }),
			width: fc.integer({ min: 0, max: 5 }),
			second: fc.integer({ min: 0, max: 59 }),
			kind: fc.integer({ min: 0, max: 5 }),
			lead: fc.integer({ min: 0, max: 26 * HOUR }),
			shortLead: fc.integer({ min: -HOUR, max: 2 * HOUR })
		})
		.map(function ({ zone, year, pick, minutes, width, second, kind, lead, shortLead }) {
			const transitions = transitionsIn(zone, year);
			// A year without changes (Havana or Apia in some years) gives a plain day.
			const change = transitions.length > 0 ? transitions[pick % transitions.length] : Date.UTC(year, 6, 1);
			const wall = new Date(change + referenceOffset(zone, change - 1) + minutes * MINUTE);
			const h = wall.getUTCHours();
			const m = wall.getUTCMinutes();
			const range = [m];

			for (let extra = 1; extra <= width && m + extra < 60; extra++) range.push(m + extra);

			const specs = [
				dailySpec(`${m} ${h} * * *`, [0], [m], [h], true),
				dailySpec(`${m}-${range[range.length - 1]} ${h},${(h + 1) % 24} * * *`, [0], range, [h, (h + 1) % 24], true),
				dailySpec(`${m} * * * *`, [0], [m], upTo(24), false),
				dailySpec(`* ${h} * * *`, [0], upTo(60), [h], false),
				dailySpec(`${second} ${m} ${h} * * *`, [second], [m], [h], true),
				dailySpec(
					`${second} */${width + 1} * * * *`,
					[second],
					upTo(60).filter(function (i) {
						return i % (width + 1) === 0;
					}),
					upTo(24),
					false
				)
			];
			const spec = specs[kind];

			return { spec, zone, from: spec.hasSeconds ? change - shortLead : change - lead };
		});

	/**
	 * Either a random job and start, or one built around a change of offset.
	 */
	const scenarioArb = fc.oneof(
		fc.tuple(cronArb, fromArb).map(function ([spec, { zone, from }]) {
			return { spec, zone, from };
		}),
		nearArb
	);

	it('eachCronDate, nextCronDate, previousCronDate and isCronMatch agree with a simulation of cronie around changes of UTC offset', function () {
		fc.assert(
			fc.property(scenarioArb, fc.nat(), function ({ spec, zone, from }, seed) {
				const end = from + (spec.hasSeconds ? 3 * HOUR : 2 * DAY);
				const expected = simulate(spec, zone, from, end);
				const cron = helpers.parseCron(spec.expression);

				expect(timesOf(helpers.eachCronDate(cron, { from, to: end, timeZone: zone }))).toEqual(expected);

				const next = helpers.nextCronDate(spec.expression, { from, timeZone: zone });

				if (expected.length > 0) expect(next?.getTime()).toBe(expected[0]);
				else expect(next === undefined || next.getTime() > end).toBe(true);

				const last = helpers.previousCronDate(cron, { from: end, inclusive: true, timeZone: zone });

				if (expected.length > 0) expect(last?.getTime()).toBe(expected[expected.length - 1]);
				else expect(last === undefined || last.getTime() <= from).toBe(true);

				// The previous firing of each firing, for a sample of them.
				for (let i = 1; i < expected.length; i += 1 + Math.floor(expected.length / 16)) {
					expect(helpers.previousCronDate(cron, { from: expected[i], timeZone: zone })?.getTime()).toBe(expected[i - 1]);
				}

				// isCronMatch at instants within the ticks: those of the firings, and others.
				const tick = spec.hasSeconds ? SECOND : MINUTE;
				const fired = new Set(expected);

				for (let i = 0; i < 8; i++) {
					const at = Math.floor((from + ((seed * (i + 1)) % (end - from))) / tick) * tick + tick;
					const probe = i % 2 === 0 && expected.length > 0 ? expected[(seed + i) % expected.length] : at;

					if (probe > end) continue;
					expect(helpers.isCronMatch(cron, probe + (seed % tick), { timeZone: zone })).toBe(fired.has(probe));
				}
			})
		);
	});

	it('reads the local time zone like the same IANA zone (in any process time zone)', function () {
		const realProcess = new (util.inspect.constructor as FunctionConstructor)('return process')() as { env: Record<string, string | undefined> };

		fc.assert(
			fc.property(scenarioArb, function ({ spec, zone, from }) {
				const end = from + (spec.hasSeconds ? HOUR : DAY);
				const zoned = timesOf(helpers.eachCronDate(spec.expression, { from, to: end, timeZone: zone }));
				const before = helpers.previousCronDate(spec.expression, { from, timeZone: zone });
				const previous = realProcess.env.TZ;

				realProcess.env.TZ = zone;
				try {
					expect(timesOf(helpers.eachCronDate(spec.expression, { from, to: end }))).toEqual(zoned);
					expect(helpers.previousCronDate(spec.expression, { from })).toEqual(before);
				} finally {
					if (previous === undefined) delete realProcess.env.TZ;
					else realProcess.env.TZ = previous;
				}
			})
		);
	});

	it('nextCronDate and previousCronDate find the nearest matching wall-clock time at a fixed offset, by a day-by-day scan', function () {
		fc.assert(
			fc.property(
				cronArb,
				fc.integer({ min: Date.UTC(1900, 0, 1), max: Date.UTC(2200, 0, 1) }),
				fc.constantFrom('UTC', '+05:30', '-09:45'),
				function (spec, from, timeZone) {
					const offset = timeZone === 'UTC' ? 0 : timeZone === '+05:30' ? 5.5 * HOUR : -9.75 * HOUR;
					const daily = timesOfDay(spec);
					const wall = from + offset;
					const today = Math.floor(wall / DAY) * DAY;
					let expectedNext: number | undefined;
					let expectedPrevious: number | undefined;

					for (let day = 0; day <= 3000 && expectedNext === undefined; day++) {
						const start = today + day * DAY;

						if (!dayMatches(spec, start)) continue;

						const time = daily.find(function (t) {
							return day > 0 || t * SECOND > wall - today;
						});

						if (time !== undefined) expectedNext = start + time * SECOND - offset;
					}
					for (let day = 0; day <= 3000 && expectedPrevious === undefined; day++) {
						const start = today - day * DAY;

						if (!dayMatches(spec, start)) continue;

						const earlier = daily.filter(function (t) {
							return day > 0 || t * SECOND < wall - today;
						});
						const time = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;

						if (time !== undefined) expectedPrevious = start + time * SECOND - offset;
					}

					const next = helpers.nextCronDate(spec.expression, { from, timeZone });
					const previous = helpers.previousCronDate(spec.expression, { from, timeZone });

					if (expectedNext === undefined) expect(next === undefined || next.getTime() > today + 3000 * DAY - offset).toBe(true);
					else expect(next?.getTime()).toBe(expectedNext);
					if (expectedPrevious === undefined) expect(previous === undefined || previous.getTime() < today - 3000 * DAY - offset).toBe(true);
					else expect(previous?.getTime()).toBe(expectedPrevious);
					if (next !== undefined) expect(helpers.isCronMatch(spec.expression, next, { timeZone })).toBe(true);
					expect(helpers.isCronMatch(spec.expression, from, { timeZone })).toBe(
						specMatches(spec, Math.floor(wall / (spec.hasSeconds ? SECOND : MINUTE)) * (spec.hasSeconds ? SECOND : MINUTE))
					);
				}
			)
		);
	});
});
