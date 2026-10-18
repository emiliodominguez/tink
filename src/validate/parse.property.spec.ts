import fc from 'fast-check';
import { explain, isArrayOf, isInteger, isOptional, isShape, isString } from '../guards/index.js';
import { arrayOf, asBoolean, asDate, asInteger, asNumber, isIsoDateString, isIsoDateTimeString, isNumericString, optional, parse, safeParse, withDefault } from '.';

const anything = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withNullPrototype: true });
const whitespace = fc.constantFrom('', ' ', '\t', '\n ', ' ');

describe('parse (properties)', function () {
	it('asInteger round-trips every safe integer, as a number and as a padded string', function () {
		fc.assert(
			fc.property(fc.maxSafeInteger(), whitespace, whitespace, function (n, before, after) {
				expect(parse(asInteger, n)).toBe(n);
				expect(parse(asInteger, `${before}${n}${after}`)).toBe(n);
			})
		);
	});

	it('asNumber accepts exactly the trimmed numeric strings, and equals Number() on them', function () {
		fc.assert(
			fc.property(
				fc.oneof(fc.string(), fc.double().map(String), fc.integer().map(String), fc.stringMatching(/^ ?[+-]?[0-9]{0,3}\.?[0-9]{0,2}(?:e[+-]?[0-9]{1,3})? ?$/)),
				function (text) {
					const [error, value] = safeParse(asNumber, text);

					expect(error === undefined).toBe(isNumericString(text.trim()));
					if (error === undefined) expect(value).toBe(Number(text.trim()));
				}
			)
		);
	});

	it('asNumber returns finite numbers unchanged and rejects everything that is not a number or a string', function () {
		fc.assert(
			fc.property(fc.oneof(fc.double(), anything), function (value) {
				const [error, output] = safeParse(asNumber, value);

				if (typeof value === 'number') expect(error === undefined ? Object.is(output, value) : !Number.isFinite(value)).toBe(true);
				else if (typeof value !== 'string') expect(error).toBeDefined();
			})
		);
	});

	it('asBoolean accepts exactly the listed spellings, in any case and padding', function () {
		const truthy = ['true', 'yes', 'on', '1'];
		const falsy = ['false', 'no', 'off', '0'];

		fc.assert(
			fc.property(fc.oneof(fc.constantFrom(...truthy, ...falsy, 'tRuE', 'YES', ' oN', 'nope', ''), fc.string({ maxLength: 5 })), whitespace, function (word, padding) {
				const text = `${padding}${word}${padding}`;
				const key = text.trim().toLowerCase();
				const [error, value] = safeParse(asBoolean, text);

				if (truthy.includes(key)) expect(value).toBe(true);
				else if (falsy.includes(key)) expect(value).toBe(false);
				else expect(error).toBeDefined();
			})
		);
	});

	it('asDate accepts exactly the ISO strings of isIsoDateTimeString and isIsoDateString, with the timestamp of new Date()', function () {
		/**
		 * Pads a number with zeros.
		 * @param {number} value - The number
		 * @param {number} width - The width
		 * @returns {string} The padded number
		 */
		function pad(value: number, width: number): string {
			return String(value).padStart(width, '0');
		}

		const offset = fc.oneof(
			fc.constantFrom('Z', 'z', '', 'Zz', '+', '+0000'),
			fc.tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 25 }), fc.integer({ min: 0, max: 61 })).map(function ([sign, hours, minutes]) {
				return `${sign}${pad(hours, 2)}:${pad(minutes, 2)}`;
			})
		);
		const dateTime = fc
			.record({
				year: fc.integer({ min: 0, max: 9999 }),
				month: fc.integer({ min: 0, max: 13 }),
				day: fc.integer({ min: 0, max: 32 }),
				hours: fc.integer({ min: 0, max: 25 }),
				minutes: fc.integer({ min: 0, max: 61 }),
				seconds: fc.integer({ min: 0, max: 61 }),
				fraction: fc.option(fc.stringMatching(/^[0-9]{0,6}$/), { nil: undefined }),
				separator: fc.constantFrom('T', 't', ' '),
				offset,
				dateOnly: fc.boolean(),
				cut: fc.nat(30)
			})
			.map(function (parts) {
				const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
				const time = `${pad(parts.hours, 2)}:${pad(parts.minutes, 2)}:${pad(parts.seconds, 2)}${parts.fraction === undefined ? '' : `.${parts.fraction}`}`;
				const text = parts.dateOnly ? date : `${date}${parts.separator}${time}${parts.offset}`;

				// Sometimes truncated, to probe every length check.
				return parts.cut < 25 ? text : text.slice(0, parts.cut - 5);
			});

		fc.assert(
			fc.property(fc.oneof(dateTime, fc.string({ maxLength: 30 })), function (text) {
				const [error, date] = safeParse(asDate, text);

				expect(error === undefined).toBe(isIsoDateTimeString(text) || isIsoDateString(text));
				if (error === undefined) expect(date?.getTime()).toBe(new Date(text).getTime());
			})
		);
	});

	it('a schema of guards agrees with the equivalent isShape guard, and strips everything else', function () {
		const schema = { id: isInteger, name: isString, tags: isArrayOf(isString), note: isOptional(isString) };
		const isRecord = isShape(schema);
		const candidate = fc.oneof(
			fc.record(
				{
					id: fc.oneof(fc.integer(), anything),
					name: fc.oneof(fc.string(), anything),
					tags: fc.oneof(fc.array(fc.string()), anything),
					note: fc.oneof(fc.string(), fc.constant(undefined), anything),
					extra: anything
				},
				{ requiredKeys: [] }
			),
			anything
		);

		fc.assert(
			fc.property(candidate, function (value) {
				const [error, output] = safeParse(schema, value);

				expect(error === undefined).toBe(isRecord(value));
				if (error === undefined) {
					const input = value as Record<string, unknown>;

					for (const key of Object.keys(output as object)) {
						expect(Object.keys(schema)).toContain(key);
						expect((output as Record<string, unknown>)[key]).toBe(input[key]);
					}
					expect(Object.keys(output as object)).toEqual(
						Object.keys(schema).filter(function (key) {
							return Object.prototype.hasOwnProperty.call(input, key);
						})
					);
				} else {
					expect(error.issues).toEqual(explain(isRecord, value));
				}
			})
		);
	});

	it('parse throws exactly when safeParse fails, with the same issues', function () {
		const schema = { a: withDefault(asInteger, 0), b: optional(asBoolean), c: arrayOf({ d: asNumber }) };

		fc.assert(
			fc.property(
				fc.oneof(fc.record({ a: anything, b: anything, c: fc.array(fc.record({ d: fc.oneof(fc.double().map(String), anything) })) }, { requiredKeys: [] }), anything),
				function (value) {
					const [error, output] = safeParse(schema, value);
					let thrown: unknown;
					let parsed: unknown;

					try {
						parsed = parse(schema, value);
					} catch (caught) {
						thrown = caught;
					}
					if (error === undefined) expect(parsed).toEqual(output);
					else expect(thrown).toEqual(error);
				}
			)
		);
	});
});
