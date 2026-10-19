import { endOfDayInTimeZone, formatInTimeZone, fromZonedTime, getCalendarMonth, getTimeZoneOffset, getZonedParts, isValidTimeZone, startOfDayInTimeZone } from 'tinkit/date';
import type { CalendarMonthOptions, Disambiguation, FromZonedTimeOptions, TimeZone, WallClockTime, ZonedDateTimeParts } from 'tinkit/date';

const zoneOk: boolean = isValidTimeZone('Europe/Paris');
const maybeZone: unknown = 'x';
if (isValidTimeZone(maybeZone)) {
	// isValidTimeZone narrows to the branded TimeZone, still usable as a string and as a zone argument.
	const narrowed: TimeZone = maybeZone;
	const asString: string = narrowed;
	void [asString, getZonedParts(0, narrowed)];
}
const plainZone: string = 'Nowhere';
if (!isValidTimeZone(plainZone)) {
	// A failed check leaves a string a string (not `never`).
	const stillString: string = plainZone;
	void stillString;
}
// @ts-expect-error a plain string is not a checked TimeZone
const unchecked: TimeZone = 'Europe/Paris';
void unchecked;
const offsetNow: number = getTimeZoneOffset('Asia/Kolkata');
const offsetAt: number = getTimeZoneOffset('Asia/Kolkata', new Date());
// @ts-expect-error the time zone comes first
getTimeZoneOffset(new Date(), 'UTC');
const zonedParts: ZonedDateTimeParts = getZonedParts(Date.now(), 'America/New_York');
const zonedWeekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 = zonedParts.weekday;
const roundTrip: Date = fromZonedTime(zonedParts, 'America/New_York');
const wall: WallClockTime = { year: 2024, month: 3, day: 10, hour: 2, minute: 30 };
const mode: Disambiguation = 'later';
const zoneOptions: FromZonedTimeOptions = { disambiguation: mode };
const resolved: Date = fromZonedTime(wall, '+05:30', zoneOptions);
// @ts-expect-error unknown disambiguation
fromZonedTime(wall, 'UTC', { disambiguation: 'first' });
// @ts-expect-error day is required
fromZonedTime({ year: 2024, month: 3 }, 'UTC');
const zonedText: string = formatInTimeZone(Date.now(), 'UTC', 'YYYY-MM-DD[T]HH:mm:ss.SSSZ');
// @ts-expect-error the pattern is required
formatInTimeZone(Date.now(), 'UTC');
const dayStart: Date = startOfDayInTimeZone(0, 'UTC');
const dayEnd: Date = endOfDayInTimeZone(new Date(), 'UTC');
const monthOptions: CalendarMonthOptions = { weekStartsOn: 1, fixedWeeks: true };
const grid: Date[][] = getCalendarMonth(2024, 1, monthOptions);
// @ts-expect-error weekStartsOn must be 0-6
getCalendarMonth(2024, 1, { weekStartsOn: 7 });
// @ts-expect-error no Date overload: (year, monthIndex)
getCalendarMonth(new Date());
void [zoneOk, offsetNow, offsetAt, zonedWeekday, roundTrip, resolved, zonedText, dayStart, dayEnd, grid];
