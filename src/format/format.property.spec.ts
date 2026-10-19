import fc from 'fast-check';
import * as helpers from '.';
import type { ParseNumberStyle } from '.';

const LOCALES = ['en-US', 'en-GB', 'de-DE', 'es-ES', 'fr-FR', 'ja-JP', 'ar-EG', 'hi-IN', 'pt-BR'];

const finiteDouble = fc.double({ min: -1e15, max: 1e15, noNaN: true, noDefaultInfinity: true });
const locale = fc.constantFrom(...LOCALES);

/** Random valid fraction-digit options (min <= max). */
const fractionDigits = fc.tuple(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 })).map(function ([a, b]) {
	return { minimumFractionDigits: Math.min(a, b), maximumFractionDigits: Math.max(a, b) };
});

const numberOptions = fc.record(
	{
		fraction: fractionDigits,
		useGrouping: fc.boolean(),
		signDisplay: fc.constantFrom('auto', 'always', 'never', 'exceptZero') as fc.Arbitrary<Intl.NumberFormatOptions['signDisplay']>,
		notation: fc.constantFrom('standard', 'scientific', 'engineering', 'compact') as fc.Arbitrary<Intl.NumberFormatOptions['notation']>
	},
	{ requiredKeys: ['fraction'] }
);

describe('Format helpers (property-based)', function () {
	describe('formatNumber', function () {
		it('should match a freshly constructed Intl.NumberFormat for random numbers, locales and options', function () {
			fc.assert(
				fc.property(finiteDouble, locale, numberOptions, function (value, tag, { fraction, ...rest }) {
					const options: Intl.NumberFormatOptions = { ...fraction, ...rest };
					expect(helpers.formatNumber(value, { ...options, locale: tag })).toBe(new Intl.NumberFormat([tag, 'en-US'], options).format(value));
				})
			);
		});

		it('should format bigints like Intl.NumberFormat', function () {
			fc.assert(
				fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), locale, function (value, tag) {
					expect(helpers.formatNumber(value, { locale: tag })).toBe(new Intl.NumberFormat(tag).format(value));
				})
			);
		});
	});

	describe('formatter cache', function () {
		it('should return the same output on repeated (cached) calls as an uncached formatter', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(finiteDouble, fractionDigits), { minLength: 1, maxLength: 80 }), function (calls) {
					// Many distinct option sets force evictions; every result must still equal the uncached reference.
					for (const [value, fraction] of calls) {
						const reference = new Intl.NumberFormat('en-US', fraction).format(value);
						expect(helpers.formatNumber(value, fraction)).toBe(reference);
						expect(helpers.formatNumber(value, fraction)).toBe(reference);
					}
				})
			);
		});

		it('should never hand out a formatter built for another (locale list, options) pair', function () {
			const tag = fc.constantFrom('en', 'en-US', 'de', 'de-DE', 'fr', 'fr-CH', 'ar-EG', 'hi-IN', 'ja');
			const options = fc.record(
				{
					useGrouping: fc.constantFrom(true, false, 'always', 'min2'),
					signDisplay: fc.constantFrom('auto', 'always', 'never', 'exceptZero'),
					maximumFractionDigits: fc.integer({ min: 0, max: 3 }),
					notation: fc.constantFrom('standard', 'scientific', 'compact')
				},
				{ requiredKeys: [] }
			);
			fc.assert(
				fc.property(fc.array(fc.tuple(fc.array(tag, { minLength: 1, maxLength: 3 }), options), { minLength: 1, maxLength: 30 }), function (calls) {
					for (const [locales, rest] of calls) {
						const reference = new Intl.NumberFormat([...locales, 'en-US'], rest as Intl.NumberFormatOptions).format(-1234.5678);
						expect(helpers.formatNumber(-1234.5678, { ...(rest as Intl.NumberFormatOptions), locale: locales })).toBe(reference);
					}
				})
			);
		});

		it('should match uncached Intl output for currencies, units, compact numbers and dates', function () {
			fc.assert(
				fc.property(
					finiteDouble,
					fc.constantFrom('USD', 'EUR', 'JPY', 'GBP'),
					fc.constantFrom('meter', 'kilometer-per-hour', 'celsius', 'megabyte'),
					fc.integer({ min: -8.64e15, max: 8.64e15 }),
					function (value, currency, unit, time) {
						expect(helpers.formatCurrency(value, currency)).toBe(new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value));
						expect(helpers.formatUnit(value, unit)).toBe(new Intl.NumberFormat('en-US', { style: 'unit', unit }).format(value));
						expect(helpers.formatCompact(value)).toBe(new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value));
						expect(helpers.formatDateTime(time, { dateStyle: 'full', timeStyle: 'long' })).toBe(
							new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(time)
						);
					}
				)
			);
		});
	});

	describe('formatPercent', function () {
		it('should parse back to the original ratio within the rounding tolerance', function () {
			fc.assert(
				fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.integer({ min: 0, max: 6 }), function (ratio, decimals) {
					const text = helpers.formatPercent(ratio, { decimals, useGrouping: false });
					expect(text.endsWith('%')).toBe(true);
					const parsed = Number(text.slice(0, -1)) / 100;
					// Half a unit in the last displayed digit, plus a little slack for binary floating point.
					expect(Math.abs(parsed - ratio)).toBeLessThanOrEqual(0.5 * 10 ** -(decimals + 2) * (1 + 1e-9) + Math.abs(ratio) * 1e-12);
				})
			);
		});

		it('should always show exactly `decimals` fraction digits', function () {
			fc.assert(
				fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.integer({ min: 1, max: 6 }), function (ratio, decimals) {
					const text = helpers.formatPercent(ratio, { decimals });
					expect(text).toMatch(new RegExp(`\\.\\d{${decimals}}%$`));
				})
			);
		});
	});

	describe('formatList', function () {
		it('should contain every item, in order', function () {
			fc.assert(
				fc.property(
					fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 10 }),
					locale,
					fc.constantFrom('conjunction', 'disjunction', 'unit') as fc.Arbitrary<Intl.ListFormatType>,
					fc.constantFrom('long', 'short', 'narrow') as fc.Arbitrary<Intl.ListFormatStyle>,
					function (items, tag, type, style) {
						const text = helpers.formatList(items, { locale: tag, type, style });
						let position = 0;
						for (const item of items) {
							const index = text.indexOf(item, position);
							expect(index).toBeGreaterThanOrEqual(position);
							position = index + item.length;
						}
					}
				)
			);
		});

		it('should return the single item unchanged', function () {
			fc.assert(
				fc.property(fc.string(), locale, function (item, tag) {
					expect(helpers.formatList([item], { locale: tag })).toBe(item);
				})
			);
		});
	});

	describe('formatOrdinal', function () {
		it('should agree with an English ordinal reference implementation', function () {
			fc.assert(
				fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), function (n) {
					const lastTwo = Math.abs(n) % 100;
					const last = lastTwo % 10;
					const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
					expect(helpers.formatOrdinal(n)).toBe(`${n.toLocaleString('en-US')}${suffix}`);
				})
			);
		});

		it('should be the formatted number followed by the suffix of its ordinal category', function () {
			const suffixes = { zero: 'Z', one: 'O', two: 'T', few: 'F', many: 'M', other: 'X' };
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 100_000 }), locale, function (n, tag) {
					const category = new Intl.PluralRules([tag, 'en-US'], { type: 'ordinal' }).select(n);
					expect(helpers.formatOrdinal(n, { locale: tag, suffixes })).toBe(`${helpers.formatNumber(n, { locale: tag })}${suffixes[category]}`);
				})
			);
		});
	});

	describe('pluralRule', function () {
		it('should match Intl.PluralRules', function () {
			fc.assert(
				fc.property(finiteDouble, locale, fc.constantFrom('cardinal', 'ordinal') as fc.Arbitrary<Intl.PluralRuleType>, function (count, tag, type) {
					expect(helpers.pluralRule(count, { locale: tag, type })).toBe(new Intl.PluralRules(tag, { type }).select(count));
				})
			);
		});

		it('should be consistent with formatRelativeTime pluralization in English', function () {
			fc.assert(
				fc.property(fc.integer({ min: 2, max: 1_000_000 }), function (n) {
					expect(helpers.pluralRule(n)).toBe('other');
					expect(helpers.formatRelativeTime(n, 'day')).toBe(`in ${helpers.formatNumber(n)} days`);
				})
			);
		});
	});
});

describe('parseNumber (property-based)', function () {
	/** Locales with every kind of separator, digits, sign and grouping (and a few numbering systems). */
	const PARSE_LOCALES = [
		...LOCALES,
		'en-IN',
		'mr-IN',
		'de-CH',
		'de-AT',
		'fr-CH',
		'it-CH',
		'sv-SE',
		'pl-PL',
		'ru-RU',
		'nl-NL',
		'tr-TR',
		'fa-IR',
		'he-IL',
		'ur-PK',
		'zh-CN',
		'ko-KR',
		'hi-IN-u-nu-deva',
		'ja-JP-u-nu-fullwide',
		'th-TH-u-nu-thai'
		// Not `-u-nu-mathbold` (digits beyond the BMP): ICU splits the surrogate pairs of their exponents. Plain numbers are unit-tested.
	];
	const parseLocale = fc.constantFrom(...PARSE_LOCALES);
	const number = fc.oneof(finiteDouble, fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.double({ min: -1, max: 1, noNaN: true }));
	const plainOptions = fc.record(
		{
			fraction: fractionDigits,
			useGrouping: fc.boolean(),
			signDisplay: fc.constantFrom('auto', 'always', 'never', 'exceptZero') as fc.Arbitrary<Intl.NumberFormatOptions['signDisplay']>,
			notation: fc.constantFrom('standard', 'scientific', 'engineering') as fc.Arbitrary<Intl.NumberFormatOptions['notation']>
		},
		{ requiredKeys: ['fraction'] }
	);

	/**
	 * The number `Intl` writes for `value` with these options, read by `Number` from its en-US form without grouping: the value as printed.
	 * @param {number} value - The value
	 * @param {Intl.NumberFormatOptions} options - The options
	 * @returns {number} The value rounded as printed
	 */
	function printed(value: number, options: Intl.NumberFormatOptions): number {
		const parts = new Intl.NumberFormat('en-US', { ...options, useGrouping: false }).formatToParts(value);
		return Number(
			parts
				.filter(function (part) {
					return part.type !== 'currency' && part.type !== 'literal' && part.type !== 'percentSign';
				})
				.map(function (part) {
					return part.value;
				})
				.join('')
		);
	}

	it('should parse back what formatNumber writes, in every locale, as printed', function () {
		fc.assert(
			fc.property(number, parseLocale, plainOptions, function (n, tag, { fraction, ...rest }) {
				const options = { ...fraction, ...rest, locale: tag };
				expect(helpers.parseNumber(helpers.formatNumber(n, options), options)).toBe(printed(n, { ...fraction, ...rest }));
			})
		);
	});

	it('should parse back what formatPercent writes, as the ratio printed', function () {
		fc.assert(
			fc.property(number, parseLocale, fc.integer({ min: 0, max: 6 }), function (n, tag, decimals) {
				const text = helpers.formatPercent(n, { locale: tag, decimals });
				const percent = new Intl.NumberFormat('en-US', {
					style: 'percent',
					minimumFractionDigits: decimals,
					maximumFractionDigits: decimals,
					useGrouping: false
				}).format(n);
				expect(helpers.parseNumber(text, { locale: tag, style: 'percent' })).toBe(Number(`${percent.slice(0, -1)}e-2`));
			})
		);
	});

	it('should parse back what formatCurrency writes, with the currency given or (for signs and codes) not', function () {
		const currency = fc.constantFrom('USD', 'EUR', 'JPY', 'GBP', 'INR', 'BRL', 'CHF', 'PLN', 'KWD');
		const display = fc.constantFrom('symbol', 'narrowSymbol', 'code', 'name') as fc.Arbitrary<'symbol' | 'narrowSymbol' | 'code' | 'name'>;
		const sign = fc.constantFrom('standard', 'accounting') as fc.Arbitrary<'standard' | 'accounting'>;
		fc.assert(
			fc.property(number, parseLocale, currency, display, sign, function (n, tag, code, how, currencySign) {
				// ICU writes a stray fraction digit after some Turkish currency names (`'CHF 1,5 İsviçre frangı0'`).
				fc.pre(!(tag === 'tr-TR' && how === 'name' && (code === 'CHF' || code === 'PLN' || code === 'KWD')));
				const text = helpers.formatCurrency(n, code, { locale: tag, display: how, currencySign });
				const expected = printed(n, { style: 'currency', currency: code });
				expect(helpers.parseNumber(text, { locale: tag, currency: code })).toBe(expected);
				// Without `currency`, signs and codes are read, but not names, nor symbols made of letters only.
				if (how === 'code' || (how !== 'name' && code !== 'CHF' && code !== 'PLN' && code !== 'KWD')) {
					expect(helpers.parseNumber(text, { locale: tag, style: 'currency' })).toBe(expected);
				}
			})
		);
	});

	it('should parse what formatCompact writes into a number that formats back to the same text', function () {
		fc.assert(
			fc.property(number, parseLocale, fc.constantFrom('short', 'long') as fc.Arbitrary<'short' | 'long'>, function (n, tag, display) {
				const text = helpers.formatCompact(n, { locale: tag, display });
				const parsed = helpers.parseNumber(text, { locale: tag, style: 'compact' });
				expect(helpers.formatCompact(parsed, { locale: tag, display })).toBe(text);
				// Compact notation keeps at least two significant digits.
				expect(Math.abs(parsed - n)).toBeLessThanOrEqual(Math.abs(n) * 0.05);
			})
		);
	});

	/**
	 * A naive en-US reader: an optional sign before or after, digits grouped by threes (not starting with 0) or not at all, an optional
	 * fraction, spaces around.
	 * @param {string} text - The text
	 * @returns {number} The number, or `NaN`
	 */
	function naiveEnglish(text: string): number {
		const match = /^ *([+-]?) *(?:([1-9]\d{0,2}(?:,\d{3})+)|(\d*))(?:\.(\d+))? *([+-]?) *$/.exec(text);
		if (match === null || (match[1] !== '' && match[5] !== '')) return NaN;
		const integer = (match[2] ?? match[3]).replace(/,/g, '');
		if (integer === '' && match[4] === undefined) return NaN;
		return Number(`${match[1] === '-' || match[5] === '-' ? '-' : ''}${integer || 0}.${match[4] ?? 0}`);
	}

	it('should agree with a naive reader on random en-US text', function () {
		fc.assert(
			fc.property(fc.string({ unit: fc.constantFrom('0', '1', '5', '9', ',', '.', '-', '+', ' '), maxLength: 14 }), function (text) {
				expect(helpers.parseNumber(text)).toBe(naiveEnglish(text));
			}),
			{ numRuns: 1000 }
		);
	});

	it('should read any exponent, with leading zeros, as an exact bigint exponent would', function () {
		const digits = fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 1, maxLength: 5 });
		const significant = fc.oneof(
			fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 1, maxLength: 22 }),
			fc.integer({ min: 290, max: 345 }).map(String),
			fc.constantFrom('999999999999999', '1000000000000000', '9999999999999999')
		);
		fc.assert(
			fc.property(
				fc.constantFrom('', '-'),
				digits,
				fc.option(digits, { nil: undefined }),
				fc.constantFrom('', '-', '+'),
				fc.nat({ max: 30 }),
				significant,
				fc.boolean(),
				function (sign, integer, fraction, exponentSign, zeros, exponent, percent) {
					const mantissa = `${sign}${integer}${fraction === undefined ? '' : `.${fraction}`}`;
					const written = `${exponentSign}${'0'.repeat(zeros)}${exponent}`;
					// The reference: the conversion before exponents were decided without bigints.
					const value = Number(`${mantissa}e${BigInt(written) + (percent ? -2n : 0n)}`);
					const expected = Number.isFinite(value) ? value : NaN;
					expect(helpers.parseNumber(`${mantissa}e${written}${percent ? '%' : ''}`, { style: percent ? 'percent' : 'decimal' })).toBe(expected);
				}
			)
		);
	});

	it('should never throw on a string, and give a finite number or NaN', function () {
		const style = fc.constantFrom('decimal', 'percent', 'currency', 'compact') as fc.Arbitrary<ParseNumberStyle>;
		const text = fc.oneof(
			fc.string({ unit: 'binary', maxLength: 20 }),
			fc.string({
				unit: fc.constantFrom('1', '٢', '0', ',', '.', '٫', '٬', ' ', String.fromCharCode(0xa0), '-', '(', ')', '%', '$', 'E', 'K', 'US', '万', 'Mio.'),
				maxLength: 16
			})
		);
		fc.assert(
			fc.property(text, parseLocale, style, function (input, tag, how) {
				const result = helpers.parseNumber(input, { locale: tag, style: how });
				expect(Number.isNaN(result) || Number.isFinite(result)).toBe(true);
			})
		);
	});
});
