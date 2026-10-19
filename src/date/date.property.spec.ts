import fc from 'fast-check';
import * as helpers from '.';

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
		 * addDays would permanently shift the wall-clock time after passing through a DST gap).
		 */
		function naiveAddBusinessDays(date: Date, amount: number): Date {
			const sign = amount < 0 ? -1 : 1;
			let remaining = Math.abs(amount);
			let offset = 0;

			while (remaining > 0) {
				offset += sign;
				if (!helpers.isWeekend(helpers.addDays(date, offset))) remaining--;
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
						if (!helpers.isWeekend(helpers.addDays(earlier, offset))) count++;
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

		it('parseDuration(formatDuration(ms)) === ms for every safe integer', function () {
			fc.assert(
				fc.property(fc.oneof(fc.integer(), fc.integer({ min: -100_000_000, max: 100_000_000 }), fc.maxSafeInteger(), fc.maxSafeNat()), function (ms) {
					expect(helpers.parseDuration(helpers.formatDuration(ms))).toBe(ms + 0);
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
		 * Naive reference: walks one calendar day at a time with `isBusinessDay`.
		 */
		function naiveAdd(date: Date, amount: number, options: helpers.BusinessDayOptions): Date {
			const sign = amount < 0 ? -1 : 1;
			let remaining = Math.abs(amount);
			let offset = 0;

			while (remaining > 0) {
				offset += sign;
				if (helpers.isBusinessDay(helpers.addDays(date, offset), options)) remaining--;
			}

			return helpers.addDays(date, offset);
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
					let count = 0;

					for (let offset = 1; offset <= span; offset++) {
						if (helpers.isBusinessDay(helpers.addDays(earlier, offset), options)) count++;
					}

					expect(helpers.diffInBusinessDays(later, earlier, options)).toBe(count);
					expect(helpers.diffInBusinessDays(earlier, later, options)).toBe(0 - count);
				})
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
