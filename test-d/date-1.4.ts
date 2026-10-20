import { eachCronDate, isCronMatch, nextCronDate, parseCron, previousCronDate } from 'tinkit/date';
import type { Cron, CronDateOptions, CronMatchOptions, EachCronDateOptions } from 'tinkit/date';

const cron: Cron = parseCron('*/15 9-17 * * MON-FRI');
const expression: string = cron.expression;
// @ts-expect-error a Cron is read-only
cron.expression = '* * * * *';
// @ts-expect-error only parseCron creates a Cron
const forged: Cron = { expression: '* * * * *' };
// @ts-expect-error the expression is a string
parseCron(5);

const options: CronDateOptions = { from: new Date(), inclusive: true, timeZone: 'America/New_York' };
const fromNumber: CronDateOptions = { from: Date.now() };
const next: Date | undefined = nextCronDate(cron, options);
const nextFromString: Date | undefined = nextCronDate('@daily');
const previous: Date | undefined = previousCronDate('0 0 L * *', fromNumber);
// @ts-expect-error the result may be undefined
const notOptional: Date = nextCronDate(cron);
// @ts-expect-error `from` is a date or a timestamp
nextCronDate(cron, { from: '2024-01-01' });
// @ts-expect-error unknown option
previousCronDate(cron, { to: new Date() });

const eachOptions: EachCronDateOptions = { from: 0, to: new Date(), limit: 10, timeZone: '+05:30' };
const dates: IterableIterator<Date> = eachCronDate(cron, eachOptions);
const first: Date[] = [...eachCronDate('0 * * * *', { limit: 3 })];
// @ts-expect-error `limit` is a number
eachCronDate(cron, { limit: '3' });

const matchOptions: CronMatchOptions = { timeZone: 'UTC' };
const matches: boolean = isCronMatch(cron, new Date(), matchOptions);
const matchesNow: boolean = isCronMatch('* * * * *', Date.now());
// @ts-expect-error the date is required
isCronMatch(cron);
// @ts-expect-error a cron is a string or a Cron
nextCronDate(42);

void [expression, forged, next, nextFromString, previous, notOptional, dates, first, matches, matchesNow];
