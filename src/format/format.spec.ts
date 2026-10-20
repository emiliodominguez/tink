import * as helpers from '.';

/** Replaces the non-breaking spaces some ICU versions emit (U+00A0, U+202F) with plain spaces. */
function normalizeSpaces(text: string): string {
	return text.replace(/[\u00a0\u202f]/g, ' ');
}

const INSTANT = Date.UTC(2024, 0, 15, 13, 45, 30);

describe('Format helpers', function () {
	describe('locale handling', function () {
		it('should default to en-US regardless of the host locale', function () {
			expect(helpers.formatNumber(1234.5)).toBe('1,234.5');
			expect(helpers.formatNumber(1234.5, { locale: undefined })).toBe('1,234.5');
		});

		it('should request en-US explicitly instead of relying on the host default', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1, { minimumIntegerDigits: 11 });
			expect(spy).toHaveBeenCalledWith(['en-US'], { minimumIntegerDigits: 11 });
		});

		it('should accept a single locale and a priority list', function () {
			expect(helpers.formatNumber(1234.5, { locale: 'de-DE' })).toBe('1.234,5');
			expect(helpers.formatNumber(1234.5, { locale: ['de-DE', 'en-US'] })).toBe('1.234,5');
			expect(helpers.formatNumber(1234.5, { locale: Object.freeze(['en-US']) })).toBe('1,234.5');
		});

		it('should treat an empty locale list as en-US', function () {
			expect(helpers.formatNumber(1234.5, { locale: [] })).toBe('1,234.5');
		});

		it('should fall back to en-US (not the host default) for unsupported locales', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1.25, { locale: 'zz', minimumIntegerDigits: 3 });
			expect(spy).toHaveBeenCalledWith(['zz', 'en-US'], { minimumIntegerDigits: 3 });
			expect(helpers.formatNumber(1234.5, { locale: 'zz' })).toBe('1,234.5');
		});

		it('should throw the Intl RangeError for malformed locales', function () {
			expect(function () {
				helpers.formatNumber(1, { locale: 'en_US' });
			}).toThrow(RangeError);
		});

		it('should throw a TypeError when the locale is neither a string nor an array', function () {
			expect(function () {
				helpers.formatNumber(1, { locale: 42 as any });
			}).toThrow(new TypeError('format: `locale` must be a string or an array of strings, got number'));
			expect(function () {
				helpers.formatList(['a'], { locale: null as any });
			}).toThrow(TypeError);
		});
	});

	describe('formatter cache', function () {
		it('should reuse formatters for identical (locale, options)', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			expect(helpers.formatNumber(1.5, { minimumIntegerDigits: 17 })).toBe('00,000,000,000,000,001.5');
			expect(helpers.formatNumber(2.5, { minimumIntegerDigits: 17 })).toBe('00,000,000,000,000,002.5');
			expect(spy).toHaveBeenCalledTimes(1);
			// Another formatter in between: the first one now comes from the shared cache, not from the call site's memo.
			expect(helpers.formatNumber(2.5, { minimumIntegerDigits: 16 })).toBe('0,000,000,000,000,002.5');
			expect(helpers.formatNumber(3.5, { minimumIntegerDigits: 17 })).toBe('00,000,000,000,000,003.5');
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('should evict the least recently used formatter beyond 50 entries', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1, { minimumIntegerDigits: 19, maximumFractionDigits: 0 });
			expect(spy).toHaveBeenCalledTimes(1);

			// 51 distinct option sets, all within the ranges every supported engine accepts (Node 20 caps fraction digits at 20).
			for (let i = 0; i <= 50; i++) {
				helpers.formatNumber(1, { minimumIntegerDigits: 18, minimumFractionDigits: i % 17, maximumFractionDigits: 17 + Math.floor(i / 17) });
			}
			expect(spy).toHaveBeenCalledTimes(52);

			// The most recently used entry is still cached; the first one was evicted.
			helpers.formatNumber(1, { minimumIntegerDigits: 18, minimumFractionDigits: 50 % 17, maximumFractionDigits: 17 + Math.floor(50 / 17) });
			expect(spy).toHaveBeenCalledTimes(52);
			helpers.formatNumber(1, { minimumIntegerDigits: 19, maximumFractionDigits: 0 });
			expect(spy).toHaveBeenCalledTimes(53);
		});

		it('should not let option values that JSON conflates share a formatter', function () {
			// JSON.stringify maps NaN, Infinity and null to `null`, and uses `toJSON` instead of the value Intl actually reads.
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: null as any })).toBe('1');
			expect(function () {
				helpers.formatNumber(1.25, { maximumFractionDigits: NaN });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatNumber(1.25, { maximumFractionDigits: Infinity });
			}).toThrow(RangeError);
			const zero = {
				toJSON(): number {
					return 3;
				},
				valueOf(): number {
					return 0;
				}
			};
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: zero as any })).toBe('1');
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: 3 })).toBe('1.25');
		});

		it('should not let distinct locale or option objects share a formatter', function () {
			expect(helpers.formatNumber(1234.5, { locale: [new Intl.Locale('de-DE')] as any })).toBe('1.234,5');
			expect(normalizeSpaces(helpers.formatNumber(1234.5, { locale: [new Intl.Locale('fr-FR')] as any }))).toBe('1 234,5');
			function zone(name: string): any {
				return {
					toString(): string {
						return name;
					}
				};
			}
			expect(helpers.formatDateTime(0, { hour: 'numeric', hourCycle: 'h23', timeZone: zone('Asia/Tokyo') })).toBe('09');
			expect(helpers.formatDateTime(0, { hour: 'numeric', hourCycle: 'h23', timeZone: zone('Europe/Madrid') })).toBe('01');
		});

		it('should not let option objects or functions that stringify alike share a formatter', function () {
			// Intl reads numeric options through `valueOf`, which `String()` (and therefore a cache key) does not see.
			function digits(count: number): any {
				return {
					valueOf(): number {
						return count;
					}
				};
			}
			function digitsFunction(count: number): any {
				function value(): void {}
				value.valueOf = function (): number {
					return count;
				};
				return value;
			}
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digits(0) })).toBe('1');
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digits(3) })).toBe('1.25');
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digitsFunction(0) })).toBe('1');
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digitsFunction(3) })).toBe('1.25');
		});

		it('should bypass the cache for Intl.Locale objects in the locale list', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			const locales = [new Intl.Locale('de-DE')] as any;
			expect(helpers.formatNumber(1.5, { locale: locales })).toBe('1,5');
			expect(helpers.formatNumber(1.5, { locale: locales })).toBe('1,5');
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('should cache formatters for null option values', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1, { minimumIntegerDigits: 12, maximumFractionDigits: null as any });
			helpers.formatNumber(2, { minimumIntegerDigits: 12, maximumFractionDigits: null as any });
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it('should share a formatter between an absent option and an undefined one', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1, { minimumIntegerDigits: 21 });
			helpers.formatNumber(1, { minimumIntegerDigits: 21, maximumFractionDigits: undefined });
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it('should share a cached formatter between an absent option and an undefined one once the memo has moved on', function () {
			const spy = jest.spyOn(Intl, 'NumberFormat');
			helpers.formatNumber(1, { minimumIntegerDigits: 13 });
			helpers.formatNumber(1, { minimumIntegerDigits: 14 });
			// The call site's memo now holds the second formatter: the first one comes back from the shared cache.
			expect(helpers.formatNumber(1, { minimumIntegerDigits: 13, maximumFractionDigits: undefined })).toBe('0,000,000,000,001');
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it('should treat an undefined option as absent when comparing with the previous call (memo)', function () {
			helpers.formatPercent(0.5, { decimals: 4, minimumIntegerDigits: undefined });
			const entries = jest.spyOn(Object, 'entries');
			expect(helpers.formatPercent(0.25, { decimals: 4 })).toBe('25.0000%');
			expect(entries).not.toHaveBeenCalled();
			entries.mockRestore();
		});

		it('should give the right output when a call site alternates between options and locales (memo)', function () {
			for (let round = 0; round < 2; round++) {
				expect(helpers.formatNumber(1.25, { maximumFractionDigits: 0 })).toBe('1');
				expect(helpers.formatNumber(1.25, { maximumFractionDigits: 1 })).toBe('1.3');
				expect(helpers.formatNumber(1.25, {})).toBe('1.25');
				expect(helpers.formatNumber(1.25, { maximumFractionDigits: 1, minimumFractionDigits: 1 })).toBe('1.3');
				expect(helpers.formatNumber(1.25, { maximumFractionDigits: undefined })).toBe('1.25');
				expect(helpers.formatNumber(1.25, { locale: 'de-DE' })).toBe('1,25');
				expect(helpers.formatNumber(1.25)).toBe('1.25');
				expect(helpers.formatCurrency(1, 'EUR')).toBe('€1.00');
				expect(helpers.formatCurrency(1, 'USD')).toBe('$1.00');
			}
		});

		it('should not treat an undefined option as matching a set one (memo regression)', function () {
			expect(helpers.formatDateTime(0, { hour: '2-digit', hourCycle: 'h23' })).toBe('00');
			// Same number of keys as the previous call, but none of them set: `hour` and `hourCycle` are absent.
			expect(helpers.formatDateTime(0, { dateStyle: undefined, weekday: undefined })).toBe('1/1/1970');
			expect(helpers.formatNumber(1.5, { maximumFractionDigits: 0 })).toBe('2');
			expect(helpers.formatNumber(1.5, { minimumIntegerDigits: undefined })).toBe('1.5');
		});

		it('should skip the cache key for repeated identical calls', function () {
			const entries = jest.spyOn(Object, 'entries');
			helpers.formatPercent(0.5, { decimals: 3 });
			const afterFirst = entries.mock.calls.length;
			helpers.formatPercent(0.25, { decimals: 3 });
			expect(entries.mock.calls.length).toBe(afterFirst);
			entries.mockRestore();
		});

		it('should never serve a stale formatter for a mutated locale list or option object', function () {
			const locales = ['de-DE'];
			expect(helpers.formatNumber(1234.5, { locale: locales })).toBe('1.234,5');
			locales[0] = 'en-US';
			expect(helpers.formatNumber(1234.5, { locale: locales })).toBe('1,234.5');
			let count = 0;
			const digits: any = {
				valueOf(): number {
					return count;
				}
			};
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digits })).toBe('1');
			count = 2;
			expect(helpers.formatNumber(1.25, { maximumFractionDigits: digits })).toBe('1.25');
		});

		it('should never serve a stale formatter for a reused and mutated options object', function () {
			const options: any = { dateStyle: 'short' };
			expect(helpers.formatDateTime(0, options)).toBe('1/1/70');
			options.dateStyle = 'medium';
			expect(helpers.formatDateTime(0, options)).toBe('Jan 1, 1970');
			options.locale = 'de-DE';
			expect(helpers.formatDateTime(0, options)).toBe('01.01.1970');
			delete options.dateStyle;
			expect(helpers.formatDateTime(0, options)).toBe('1.1.1970');
		});

		it('should ignore inherited options, even when they equal the previous call ones', function () {
			expect(helpers.formatNumber(1, { minimumFractionDigits: 2 })).toBe('1.00');
			expect(helpers.formatNumber(1, Object.create({ minimumFractionDigits: 2 }))).toBe('1');
			// `locale` is read even when inherited.
			expect(helpers.formatNumber(1.5, { locale: 'de-DE' })).toBe('1,5');
			expect(helpers.formatNumber(1.5, Object.create({ locale: 'de-DE' }))).toBe('1,5');
			expect(helpers.formatNumber(1.5)).toBe('1.5');
			// Named options are read through the prototype chain too (here a class getter, which `for...in` does not see).
			class CodeDisplay {
				get display(): 'code' {
					return 'code';
				}
			}
			expect(helpers.formatCurrency(1, 'USD', {})).toBe('$1.00');
			expect(helpers.formatCurrency(1, 'USD', new CodeDisplay())).toBe('USD 1.00');
			expect(helpers.formatCurrency(1, 'USD', {})).toBe('$1.00');
		});

		it('should tell apart calls that only differ by the currency or the unit', function () {
			const options = { display: 'code' as const };
			expect(helpers.formatCurrency(1, 'USD', options)).toBe('USD 1.00');
			expect(helpers.formatCurrency(1, 'EUR', options)).toBe('EUR 1.00');
			expect(helpers.formatUnit(1, 'meter', { display: 'long' })).toBe('1 meter');
			expect(helpers.formatUnit(1, 'liter', { display: 'long' })).toBe('1 liter');
		});

		it('should not cache formatters whose construction failed', function () {
			expect(function () {
				helpers.formatNumber(1, { minimumFractionDigits: 5, maximumFractionDigits: 2 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatNumber(1, { minimumFractionDigits: 5, maximumFractionDigits: 2 });
			}).toThrow(RangeError);
		});
	});

	describe('error messages', function () {
		it('should name the throwing function', function () {
			expect(function () {
				helpers.formatCurrency(NaN, 'USD');
			}).toThrow(new RangeError('formatCurrency: `value` must be finite, got NaN'));
			expect(function () {
				helpers.formatPercent(Infinity);
			}).toThrow(new RangeError('formatPercent: `value` must be finite, got Infinity'));
			expect(function () {
				helpers.formatCompact('1' as any);
			}).toThrow(new TypeError('formatCompact: `value` must be a number, got string'));
			expect(function () {
				helpers.formatUnit(-Infinity, 'meter');
			}).toThrow(new RangeError('formatUnit: `value` must be finite, got -Infinity'));
			expect(function () {
				helpers.formatRelativeTime(NaN, 'day');
			}).toThrow(new RangeError('formatRelativeTime: `value` must be finite, got NaN'));
			expect(function () {
				helpers.formatOrdinal(undefined as any);
			}).toThrow(new TypeError('formatOrdinal: `n` must be a number, got undefined'));
			expect(function () {
				helpers.pluralRule(NaN);
			}).toThrow(new RangeError('pluralRule: `count` must be finite, got NaN'));
		});
	});

	describe('formatNumber', function () {
		it('should format with grouping and pass Intl options through', function () {
			expect(helpers.formatNumber(1234567.891)).toBe('1,234,567.891');
			expect(helpers.formatNumber(0)).toBe('0');
			expect(helpers.formatNumber(-1234.5)).toBe('-1,234.5');
			expect(helpers.formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1,234.50');
			expect(helpers.formatNumber(3.14159, { maximumFractionDigits: 2 })).toBe('3.14');
			expect(helpers.formatNumber(1234.5, { useGrouping: false })).toBe('1234.5');
			expect(helpers.formatNumber(5, { signDisplay: 'always' })).toBe('+5');
			expect(helpers.formatNumber(1500, { notation: 'scientific' })).toBe('1.5E3');
		});

		it('should format bigints exactly', function () {
			expect(helpers.formatNumber(12345678901234567890n)).toBe('12,345,678,901,234,567,890');
			expect(helpers.formatNumber(-5n)).toBe('-5');
		});

		it('should reject non-numbers with a TypeError', function () {
			expect(function () {
				helpers.formatNumber('12' as any);
			}).toThrow(new TypeError('formatNumber: `value` must be a number, got string'));
			expect(function () {
				helpers.formatNumber(null as any);
			}).toThrow(new TypeError('formatNumber: `value` must be a number, got null'));
			expect(function () {
				helpers.formatNumber(undefined as any);
			}).toThrow(TypeError);
		});

		it('should reject NaN and infinities with a RangeError', function () {
			expect(function () {
				helpers.formatNumber(NaN);
			}).toThrow(new RangeError('formatNumber: `value` must be finite, got NaN'));
			expect(function () {
				helpers.formatNumber(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatNumber(-Infinity);
			}).toThrow(RangeError);
		});
	});

	describe('formatCurrency', function () {
		it('should format amounts with the currency defaults', function () {
			expect(helpers.formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
			expect(helpers.formatCurrency(1234.5, 'EUR')).toBe('€1,234.50');
			expect(helpers.formatCurrency(1234.5, 'JPY')).toBe('¥1,235');
			expect(helpers.formatCurrency(1234.5, 'usd')).toBe('$1,234.50');
			expect(helpers.formatCurrency(10n, 'USD')).toBe('$10.00');
		});

		it('should support every display mode', function () {
			expect(helpers.formatCurrency(1, 'USD', { display: 'symbol' })).toBe('$1.00');
			expect(helpers.formatCurrency(1, 'USD', { display: 'narrowSymbol' })).toBe('$1.00');
			expect(normalizeSpaces(helpers.formatCurrency(1, 'USD', { display: 'code' }))).toBe('USD 1.00');
			expect(helpers.formatCurrency(1234.5, 'USD', { display: 'name' })).toBe('1,234.50 US dollars');
		});

		it('should pass other Intl options through', function () {
			expect(helpers.formatCurrency(-5, 'USD', { currencySign: 'accounting' })).toBe('($5.00)');
			expect(helpers.formatCurrency(5, 'USD', { maximumFractionDigits: 0 })).toBe('$5');
			expect(normalizeSpaces(helpers.formatCurrency(1234.5, 'EUR', { locale: 'de-DE' }))).toBe('1.234,50 €');
		});

		it('should accept well-formed unknown codes', function () {
			expect(normalizeSpaces(helpers.formatCurrency(1, 'XYZ'))).toBe('XYZ 1.00');
		});

		it('should let the Intl RangeError for malformed codes propagate', function () {
			expect(function () {
				helpers.formatCurrency(1, 'US');
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatCurrency(1, 'US$$');
			}).toThrow(RangeError);
		});

		it('should validate the value and the currency type', function () {
			expect(function () {
				helpers.formatCurrency(NaN, 'USD');
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatCurrency('1' as any, 'USD');
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatCurrency(1, 840 as any);
			}).toThrow(new TypeError('formatCurrency: `currency` must be a string, got number'));
		});
	});

	describe('formatPercent', function () {
		it('should format ratios as percentages', function () {
			expect(helpers.formatPercent(0.256)).toBe('26%');
			expect(helpers.formatPercent(0)).toBe('0%');
			expect(helpers.formatPercent(1.5)).toBe('150%');
			expect(helpers.formatPercent(-0.25)).toBe('-25%');
		});

		it('should use exactly `decimals` fraction digits', function () {
			expect(helpers.formatPercent(0.256, { decimals: 1 })).toBe('25.6%');
			expect(helpers.formatPercent(0.5, { decimals: 2 })).toBe('50.00%');
			expect(helpers.formatPercent(0.256, { decimals: 0 })).toBe('26%');
			expect(helpers.formatPercent(0.256, { decimals: 1, maximumFractionDigits: 5, minimumFractionDigits: 4 })).toBe('25.6%');
		});

		it('should pass fraction digit options through without decimals', function () {
			expect(helpers.formatPercent(0.1234, { maximumFractionDigits: 2 })).toBe('12.34%');
			expect(normalizeSpaces(helpers.formatPercent(0.256, { locale: 'de-DE', decimals: 1 }))).toBe('25,6 %');
		});

		it('should not mutate the options object', function () {
			const options = Object.freeze({ decimals: 1 });
			expect(helpers.formatPercent(0.5, options)).toBe('50.0%');
			expect(options).toEqual({ decimals: 1 });
		});

		it('should reject invalid decimals', function () {
			// Capped at 20 on every engine: Node 20's Intl rejects more, newer engines accept up to 100.
			for (const decimals of [-1, 1.5, 21, 100, NaN, Infinity]) {
				expect(function () {
					helpers.formatPercent(0.5, { decimals });
				}).toThrow(new RangeError(`formatPercent: \`decimals\` must be an integer from 0 to 20, got ${decimals}`));
			}
			expect(helpers.formatPercent(0.5, { decimals: 20 })).toMatch(/^50\.0{20}%$/);
		});

		it('should validate the value', function () {
			expect(function () {
				helpers.formatPercent(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatPercent(1n as any);
			}).toThrow(TypeError);
		});
	});

	describe('formatCompact', function () {
		it('should use short compact notation by default', function () {
			expect(helpers.formatCompact(1234)).toBe('1.2K');
			expect(helpers.formatCompact(3_400_000)).toBe('3.4M');
			expect(helpers.formatCompact(999)).toBe('999');
			expect(helpers.formatCompact(-1500)).toBe('-1.5K');
			expect(helpers.formatCompact(2_000_000_000n)).toBe('2B');
		});

		it('should support long display and fraction options', function () {
			expect(helpers.formatCompact(1234, { display: 'long' })).toBe('1.2 thousand');
			expect(helpers.formatCompact(3_400_000, { display: 'long' })).toBe('3.4 million');
			expect(helpers.formatCompact(1_234_567, { maximumFractionDigits: 2 })).toBe('1.23M');
		});

		it('should validate the value', function () {
			expect(function () {
				helpers.formatCompact(NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatCompact({} as any);
			}).toThrow(TypeError);
		});
	});

	describe('formatUnit', function () {
		it('should format simple and compound units', function () {
			expect(helpers.formatUnit(50, 'kilometer-per-hour')).toBe('50 km/h');
			expect(helpers.formatUnit(50, 'kilometer-per-hour', { display: 'long' })).toBe('50 kilometers per hour');
			expect(helpers.formatUnit(1, 'liter', { display: 'long' })).toBe('1 liter');
			expect(helpers.formatUnit(2, 'liter', { display: 'long' })).toBe('2 liters');
			expect(helpers.formatUnit(50, 'kilometer-per-hour', { display: 'narrow' })).toBe('50km/h');
			expect(helpers.formatUnit(1.234, 'megabyte', { maximumFractionDigits: 1 })).toBe('1.2 MB');
			expect(helpers.formatUnit(3n, 'second', { display: 'long' })).toBe('3 seconds');
		});

		it('should let the Intl RangeError for unsupported units propagate', function () {
			expect(function () {
				helpers.formatUnit(1, 'parsec');
			}).toThrow(RangeError);
		});

		it('should validate the value and the unit type', function () {
			expect(function () {
				helpers.formatUnit(Infinity, 'meter');
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatUnit(1, undefined as any);
			}).toThrow(new TypeError('formatUnit: `unit` must be a string, got undefined'));
		});
	});

	describe('formatList', function () {
		it('should join items with the locale conjunction', function () {
			expect(helpers.formatList(['a', 'b', 'c'])).toBe('a, b, and c');
			expect(helpers.formatList(['a', 'b'])).toBe('a and b');
			expect(helpers.formatList(['a'])).toBe('a');
			expect(helpers.formatList([])).toBe('');
		});

		it('should support types and styles', function () {
			expect(helpers.formatList(['a', 'b', 'c'], { type: 'disjunction' })).toBe('a, b, or c');
			expect(helpers.formatList(['5 ft', '2 in'], { type: 'unit' })).toBe('5 ft, 2 in');
			expect(helpers.formatList(['5 ft', '2 in'], { type: 'unit', style: 'narrow' })).toBe('5 ft 2 in');
			expect(helpers.formatList(['a', 'b', 'c'], { style: 'short' })).toBe('a, b, & c');
			expect(helpers.formatList(['a', 'b', 'c'], { locale: 'es-ES' })).toBe('a, b y c');
		});

		it('should accept any iterable and keep unicode items intact', function () {
			expect(helpers.formatList(new Set(['x', 'y']))).toBe('x and y');
			expect(
				helpers.formatList(
					(function* () {
						yield '👩‍👩‍👧';
						yield 'é';
					})()
				)
			).toBe('👩‍👩‍👧 and é');
		});

		it('should reject strings, non-iterables and non-string items', function () {
			expect(function () {
				// @ts-expect-error a bare string is rejected at compile time too
				helpers.formatList('abc');
			}).toThrow(new TypeError('formatList: `items` must be an iterable of strings, got string'));
			expect(function () {
				helpers.formatList(5 as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatList(null as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatList(['a', 1] as any);
			}).toThrow(new TypeError('formatList: every item must be a string, got number'));
		});

		it('should reject a hole of an array, also when a polluted prototype plants a string there', function () {
			// eslint-disable-next-line no-sparse-arrays
			const sparse = ['a', , 'b'] as string[];

			expect(function () {
				helpers.formatList(sparse);
			}).toThrow(new TypeError('formatList: every item must be a string, got undefined'));
			const proto = Object.prototype as unknown as Record<number, unknown>;
			proto[1] = 'planted';
			try {
				expect(function () {
					helpers.formatList(sparse);
				}).toThrow(new TypeError('formatList: every item must be a string, got undefined'));
				expect(helpers.formatList(['a', 'b'])).toBe('a and b');
			} finally {
				delete proto[1];
			}
		});

		it('should reject a huge sparse array at its first hole, without copying it (out of memory)', function () {
			const huge = ['a'];
			huge.length = 2 ** 32 - 1;

			expect(function () {
				helpers.formatList(huge);
			}).toThrow(new TypeError('formatList: every item must be a string, got undefined'));
		});
	});

	describe('formatDateTime', function () {
		it('should format in UTC by default', function () {
			expect(helpers.formatDateTime(INSTANT)).toBe('1/15/2024');
			expect(helpers.formatDateTime(INSTANT, { dateStyle: 'medium' })).toBe('Jan 15, 2024');
			expect(helpers.formatDateTime(new Date(INSTANT), { dateStyle: 'full' })).toBe('Monday, January 15, 2024');
			expect(helpers.formatDateTime(Date.UTC(2024, 0, 15, 23, 30), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).toBe('23:30');
		});

		it('should honour an explicit time zone', function () {
			const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
			expect(helpers.formatDateTime(INSTANT, { ...options, timeZone: 'Asia/Tokyo' })).toBe('22:45');
			expect(helpers.formatDateTime(Date.UTC(2024, 0, 15, 23, 30), { dateStyle: 'medium', timeZone: 'Asia/Tokyo' })).toBe('Jan 16, 2024');
		});

		it('should combine date and time styles (comparing whitespace loosely)', function () {
			expect(normalizeSpaces(helpers.formatDateTime(INSTANT, { dateStyle: 'medium', timeStyle: 'short' }))).toBe('Jan 15, 2024, 1:45 PM');
			expect(normalizeSpaces(helpers.formatDateTime(INSTANT, { timeStyle: 'medium' }))).toBe('1:45:30 PM');
		});

		it('should format other locales', function () {
			expect(helpers.formatDateTime(INSTANT, { locale: 'de-DE', year: 'numeric', month: '2-digit', day: '2-digit' })).toBe('15.01.2024');
		});

		it('should reject invalid dates and non-dates', function () {
			expect(function () {
				helpers.formatDateTime(new Date(NaN));
			}).toThrow(new RangeError('formatDateTime: `date` must be a valid date, got Invalid Date'));
			expect(function () {
				helpers.formatDateTime(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatDateTime(8.64e15 + 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatDateTime(-8.64e15 - 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatDateTime(-Infinity);
			}).toThrow(RangeError);
			// The extremes of the `Date` range are valid.
			expect(helpers.formatDateTime(8.64e15, { year: 'numeric' })).toBe('275760');
			expect(helpers.formatDateTime(-8.64e15, { year: 'numeric', era: 'short' })).toBe('271822 BC');
			expect(function () {
				helpers.formatDateTime('2024-01-15' as any);
			}).toThrow(new TypeError('formatDateTime: `date` must be a Date or a number, got string'));
		});

		it('should let Intl errors for invalid options propagate', function () {
			expect(function () {
				helpers.formatDateTime(INSTANT, { timeZone: 'Mars/Olympus' });
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatDateTime(INSTANT, { dateStyle: 'short', hour: 'numeric' });
			}).toThrow(TypeError);
		});
	});

	describe('formatRelativeTime', function () {
		it('should format explicit amounts of a unit', function () {
			expect(helpers.formatRelativeTime(3, 'day')).toBe('in 3 days');
			expect(helpers.formatRelativeTime(-2, 'hours')).toBe('2 hours ago');
			expect(helpers.formatRelativeTime(-1, 'day')).toBe('1 day ago');
			expect(helpers.formatRelativeTime(0, 'second')).toBe('in 0 seconds');
			expect(helpers.formatRelativeTime(1.5, 'year')).toBe('in 1.5 years');
		});

		it('should pass numeric and style through', function () {
			expect(helpers.formatRelativeTime(-1, 'day', { numeric: 'auto' })).toBe('yesterday');
			expect(helpers.formatRelativeTime(0, 'second', { numeric: 'auto' })).toBe('now');
			expect(helpers.formatRelativeTime(5, 'minute', { style: 'short' })).toBe('in 5 min.');
			expect(helpers.formatRelativeTime(-1, 'day', { locale: 'es-ES', numeric: 'auto' })).toBe('ayer');
		});

		it('should validate value and unit', function () {
			expect(function () {
				helpers.formatRelativeTime(Infinity, 'day');
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatRelativeTime('1' as any, 'day');
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatRelativeTime(1, 'fortnight' as any);
			}).toThrow(RangeError);
		});
	});

	describe('formatOrdinal', function () {
		it('picks the suffix of the printed digits above 2^53, not of the exact double', function () {
			// 1e23 is exactly 99999999999999991611392 but prints as 100…000; 2^57 prints as …870 but is …872.
			expect(helpers.formatOrdinal(1e23)).toBe('100,000,000,000,000,000,000,000th');
			expect(helpers.formatOrdinal(2 ** 57)).toBe('144,115,188,075,855,870th');
			expect(helpers.formatOrdinal(-(2 ** 57))).toBe('-144,115,188,075,855,870th');
			expect(helpers.formatOrdinal(2 ** 53)).toBe('9,007,199,254,740,992nd');
		});

		it('agrees with pluralRule above 2^53, which also reads the printed digits', function () {
			expect(helpers.pluralRule(1e23, { type: 'ordinal' })).toBe('other');
			expect(helpers.pluralRule(2 ** 57, { type: 'ordinal' })).toBe('other');
			expect(helpers.formatNumber(2 ** 57, { locale: 'ru' })).toMatch(/870$/);
			expect(helpers.pluralRule(2 ** 57, { locale: 'ru' })).toBe('many');
			expect(helpers.pluralRule(2 ** 53 + 2, { type: 'ordinal' })).toBe('other');
			expect(helpers.pluralRule(1.5)).toBe('other');
		});

		it('should use English suffixes for English locales', function () {
			const expected: Record<number, string> = {
				1: '1st',
				2: '2nd',
				3: '3rd',
				4: '4th',
				11: '11th',
				12: '12th',
				13: '13th',
				21: '21st',
				22: '22nd',
				23: '23rd',
				101: '101st',
				111: '111th'
			};
			for (const [n, text] of Object.entries(expected)) {
				expect(helpers.formatOrdinal(Number(n))).toBe(text);
			}
			expect(helpers.formatOrdinal(2, { locale: 'en-GB' })).toBe('2nd');
		});

		it('should localize the number', function () {
			expect(helpers.formatOrdinal(1001)).toBe('1,001st');
			expect(helpers.formatOrdinal(1e21)).toBe('1,000,000,000,000,000,000,000th');
		});

		it('should handle zero and negatives', function () {
			expect(helpers.formatOrdinal(0)).toBe('0th');
			expect(helpers.formatOrdinal(-0)).toBe('0th');
			expect(helpers.formatOrdinal(-1)).toBe('-1st');
			expect(helpers.formatOrdinal(-12)).toBe('-12th');
			expect(helpers.formatOrdinal(-23)).toBe('-23rd');
		});

		it('should fall back to a trailing period for other locales', function () {
			expect(helpers.formatOrdinal(3, { locale: 'de-DE' })).toBe('3.');
			expect(helpers.formatOrdinal(1000, { locale: 'de-DE' })).toBe('1.000.');
		});

		it('should use custom suffixes, falling back to `other`', function () {
			const french = { one: 'er', other: 'e' };
			expect(helpers.formatOrdinal(1, { locale: 'fr-FR', suffixes: french })).toBe('1er');
			expect(helpers.formatOrdinal(2, { locale: 'fr-FR', suffixes: french })).toBe('2e');
			expect(helpers.formatOrdinal(2, { suffixes: { other: 'º' } })).toBe('2º');
		});

		it('should reject suffixes without a string `other`, which would print undefined', function () {
			const lacking = { one: 'st' } as unknown as helpers.OrdinalSuffixes;

			expect(function () {
				helpers.formatOrdinal(4, { suffixes: lacking });
			}).toThrow(new TypeError('formatOrdinal: `suffixes.other` must be a string, got undefined'));
			// Also when the number's own category is listed: the table is wrong either way.
			expect(function () {
				helpers.formatOrdinal(1, { suffixes: lacking });
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatOrdinal(1, { suffixes: 'th' as unknown as helpers.OrdinalSuffixes });
			}).toThrow(TypeError);
			expect(function () {
				helpers.formatOrdinal(1, { suffixes: { other: 1 } as unknown as helpers.OrdinalSuffixes });
			}).toThrow('got number');
			// Planted on a polluted prototype, `other` does not count.
			const proto = Object.prototype as unknown as Record<string, unknown>;
			proto.other = 'th';
			try {
				expect(function () {
					helpers.formatOrdinal(4, { suffixes: lacking });
				}).toThrow(TypeError);
			} finally {
				delete proto.other;
			}
		});

		it('should treat unsupported locales as en-US', function () {
			expect(helpers.formatOrdinal(2, { locale: 'zz' })).toBe('2nd');
		});

		it('should reject non-integers and non-numbers', function () {
			expect(function () {
				helpers.formatOrdinal(1.5);
			}).toThrow(new RangeError('formatOrdinal: `n` must be an integer, got 1.5'));
			expect(function () {
				helpers.formatOrdinal(NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatOrdinal(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.formatOrdinal('1' as any);
			}).toThrow(TypeError);
		});
	});

	describe('pluralRule', function () {
		it('should return cardinal categories by default', function () {
			expect(helpers.pluralRule(1)).toBe('one');
			expect(helpers.pluralRule(2)).toBe('other');
			expect(helpers.pluralRule(0)).toBe('other');
			expect(helpers.pluralRule(-1)).toBe('one');
			expect(helpers.pluralRule(1.5)).toBe('other');
		});

		it('should honour type, locale and digit options', function () {
			expect(helpers.pluralRule(2, { type: 'ordinal' })).toBe('two');
			expect(helpers.pluralRule(3, { type: 'ordinal' })).toBe('few');
			expect(helpers.pluralRule(1, { minimumFractionDigits: 1 })).toBe('other');
			expect(helpers.pluralRule(3, { locale: 'ar' })).toBe('few');
			expect(helpers.pluralRule(0, { locale: 'ar' })).toBe('zero');
			expect(helpers.pluralRule(5, { locale: 'ru' })).toBe('many');
		});

		it('should validate the count', function () {
			expect(function () {
				helpers.pluralRule(NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.pluralRule(null as any);
			}).toThrow(TypeError);
		});
	});
});

describe('Format helpers (hostile inputs)', function () {
	it('never passes options inherited from a polluted Object.prototype to Intl, nor caches them', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.maximumFractionDigits = 0;
		proto.timeZone = 'Asia/Tokyo';
		try {
			expect(helpers.formatNumber(1.25, { minimumIntegerDigits: 1 })).toBe('1.25');
			expect(helpers.formatDateTime(0, { hour: '2-digit', hourCycle: 'h23' })).toBe('00');
		} finally {
			delete proto.maximumFractionDigits;
			delete proto.timeZone;
		}
		expect(helpers.formatNumber(1.25, { minimumIntegerDigits: 1 })).toBe('1.25');
	});

	it('does not reuse the formatter of the previous call for an option that only a polluted Object.prototype holds', function () {
		const proto = Object.prototype as Record<string, unknown>;
		proto.minimumFractionDigits = 2;
		try {
			// The previous call's own option must not be matched by the planted one, nor the other way round.
			expect(helpers.formatNumber(1, { minimumFractionDigits: 2 })).toBe('1.00');
			expect(helpers.formatNumber(1, {})).toBe('1');
			expect(helpers.formatNumber(1, { minimumFractionDigits: 2 })).toBe('1.00');
			expect(helpers.formatPercent(0.5, { minimumFractionDigits: 2 })).toBe('50.00%');
			expect(helpers.formatPercent(0.5)).toBe('50%');
		} finally {
			delete proto.minimumFractionDigits;
		}
	});

	it('ignores the locale, display, decimals, list type and style, and suffixes inherited from a polluted Object.prototype', function () {
		const proto = Object.prototype as Record<string, unknown>;
		const planted = { locale: 'de-DE', display: 'long', decimals: 5, type: 'disjunction', style: 'narrow', suffixes: { other: '<b>' }, one: '<i>' };
		Object.assign(proto, planted);
		try {
			expect(helpers.formatNumber(1234.5)).toBe('1,234.5');
			expect(helpers.formatNumber(1234.5, {})).toBe('1,234.5');
			expect(helpers.formatCurrency(1, 'USD')).toBe('$1.00');
			expect(helpers.formatPercent(0.5)).toBe('50%');
			expect(helpers.formatCompact(1234)).toBe('1.2K');
			expect(helpers.formatUnit(5, 'meter')).toBe('5 m');
			expect(helpers.formatList(['a', 'b', 'c'])).toBe('a, b, and c');
			expect(helpers.formatDateTime(0, { dateStyle: 'medium' })).toBe('Jan 1, 1970');
			expect(helpers.formatRelativeTime(1, 'day')).toBe('in 1 day');
			expect(helpers.pluralRule(1)).toBe('one');
			expect(helpers.formatOrdinal(3)).toBe('3rd');
			// A category missing from a suffix table falls back to its `other` suffix, not to a planted one.
			expect(helpers.formatOrdinal(1, { locale: 'fr-FR' })).toBe('1.');
			expect(helpers.formatOrdinal(1, { locale: 'fr-FR', suffixes: { other: 'e' } })).toBe('1e');
			expect(helpers.formatOrdinal(1, { locale: 'fr-FR', suffixes: { one: 'er', other: 'e' } })).toBe('1er');
			// Own options still apply.
			expect(helpers.formatNumber(1234.5, { locale: 'de-DE' })).toBe('1.234,5');
			expect(helpers.formatCurrency(1, 'USD', { display: 'code' })).toBe('USD 1.00');
		} finally {
			for (const key of Object.keys(planted)) delete proto[key];
		}
	});

	it('formats the time value of a Date whose getTime is overridden', function () {
		class Lying extends Date {
			override getTime(): number {
				return 0;
			}
		}
		expect(helpers.formatDateTime(new Lying(Date.UTC(2024, 0, 15)), { dateStyle: 'medium' })).toBe('Jan 15, 2024');
	});

	it('skips the holes of a sparse locale list, as Intl does', function () {
		// eslint-disable-next-line no-sparse-arrays
		expect(helpers.formatNumber(1234.5, { locale: [, 'de-DE'] as string[] })).toBe('1.234,5');
		// Without visiting every hole: a list of length 2^32 - 1 took 100 seconds. Named properties are not locales.
		const huge = ['de-DE'];
		huge[2 ** 32 - 2] = 'fr-FR';
		Object.assign(huge, { name: 'ja-JP', '01': 'ja-JP', '4294967295': 'ja-JP' });
		const started = Date.now();
		expect(helpers.formatNumber(1234.5, { locale: huge })).toBe('1.234,5');
		const last: string[] = [];
		last[2 ** 32 - 2] = 'fr-FR';
		expect(helpers.formatNumber(1234.5, { locale: last })).toBe('1\u202f234,5');
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('rejects a non-number decimals and a non-string unit with a TypeError', function () {
		expect(function () {
			helpers.formatPercent(0.5, { decimals: '2' as unknown as number });
		}).toThrow(new TypeError('formatPercent: `decimals` must be a number, got string'));
		expect(function () {
			helpers.formatRelativeTime(1, 5 as unknown as Intl.RelativeTimeFormatUnit);
		}).toThrow(new TypeError('formatRelativeTime: `unit` must be a string, got number'));
	});

	it('accepts formatList calls from generic wrappers', function () {
		function joinAll<U extends Iterable<string>>(items: U): string {
			return helpers.formatList(items);
		}
		function joinArray<U extends readonly string[]>(items: U): string {
			return helpers.formatList(items);
		}
		expect([joinAll(new Set(['a', 'b'])), joinArray(['c'] as const)]).toEqual(['a and b', 'c']);
	});
});

describe('parseNumber', function () {
	const NBSP = String.fromCharCode(0xa0);
	const NNBSP = String.fromCharCode(0x202f);
	const ALM = String.fromCharCode(0x61c);
	const RLM = String.fromCharCode(0x200f);
	const MINUS = String.fromCharCode(0x2212);
	const RIGHT_QUOTE = String.fromCharCode(0x2019);

	describe('plain numbers (en-US by default)', function () {
		it('reads digits, grouping, a decimal separator, signs and an exponent', function () {
			expect(helpers.parseNumber('1234.5')).toBe(1234.5);
			expect(helpers.parseNumber('1,234.5')).toBe(1234.5);
			expect(helpers.parseNumber('1,234,567')).toBe(1234567);
			expect(helpers.parseNumber('-1,234.5')).toBe(-1234.5);
			expect(helpers.parseNumber('+5')).toBe(5);
			expect(helpers.parseNumber(`${MINUS}5`)).toBe(-5);
			expect(helpers.parseNumber('.5')).toBe(0.5);
			expect(helpers.parseNumber('007')).toBe(7);
			expect(helpers.parseNumber('  42 ')).toBe(42);
			expect(helpers.parseNumber('1.5E3')).toBe(1500);
			expect(helpers.parseNumber('1.5e-3')).toBe(0.0015);
			expect(helpers.parseNumber('1E+3')).toBe(1000);
			expect(helpers.parseNumber(`2E${MINUS}2`)).toBe(0.02);
		});

		it('accepts a sign after the number, or separated from it by spaces', function () {
			expect(helpers.parseNumber('5-')).toBe(-5);
			expect(helpers.parseNumber('- 5')).toBe(-5);
			expect(helpers.parseNumber('5 +')).toBe(5);
		});

		it('reads an amount in parentheses as negative (accounting notation)', function () {
			expect(helpers.parseNumber('(1,234.50)')).toBe(-1234.5);
			expect(helpers.parseNumber('( 5 )')).toBe(-5);
			expect(helpers.parseNumber('(-5)')).toBeNaN();
			expect(helpers.parseNumber('(5')).toBeNaN();
			expect(helpers.parseNumber('5)')).toBeNaN();
			expect(helpers.parseNumber('()')).toBeNaN();
		});

		it('keeps the sign of zero', function () {
			expect(helpers.parseNumber('-0')).toBe(-0);
			expect(helpers.parseNumber('(0)')).toBe(-0);
			expect(helpers.parseNumber('0')).toBe(0);
			expect(helpers.parseNumber('0.000')).toBe(0);
		});

		it('converts the decimal once, to the nearest double', function () {
			expect(helpers.parseNumber('0.1')).toBe(0.1);
			expect(helpers.parseNumber('9007199254740993')).toBe(9007199254740992);
			expect(helpers.parseNumber('123,456,789,012,345,678,901,234')).toBe(1.2345678901234569e23);
			expect(helpers.parseNumber('5e-324')).toBe(5e-324);
			expect(helpers.parseNumber('1e-400')).toBe(0);
			expect(helpers.parseNumber('0E99999999999999999999999')).toBe(0);
		});

		it('decides an exponent of more than 15 significant digits without converting it', function () {
			// Regression: converting a 2-million-digit exponent to a bigint took 0.6 s (1.4 s for 4 million digits: more than linear).
			const huge = '9'.repeat(2_000_000);
			const start = performance.now();
			expect(helpers.parseNumber(`1e${huge}`)).toBeNaN();
			expect(helpers.parseNumber(`1e-${huge}`)).toBe(0);
			expect(performance.now() - start).toBeLessThan('__stryker__' in globalThis ? Infinity : 600);
			const nines = '9'.repeat(20);
			expect(helpers.parseNumber(`-1e-${nines}`)).toBe(-0);
			expect(helpers.parseNumber(`0e${nines}`)).toBe(0);
			expect(helpers.parseNumber(`-0.000e${nines}`)).toBe(-0);
			expect(helpers.parseNumber(`(0e${nines})`)).toBe(-0);
			expect(helpers.parseNumber(`(1e${nines})`)).toBeNaN();
			// At the boundary: 15 significant digits are converted (with the leading zeros dropped), 16 are decided.
			expect(helpers.parseNumber('1e000000999999999999999')).toBeNaN();
			expect(helpers.parseNumber('1e-000000999999999999999')).toBe(0);
			expect(helpers.parseNumber('1e1000000000000000')).toBeNaN();
			expect(helpers.parseNumber('-1e-1000000000000000')).toBe(-0);
			expect(helpers.parseNumber('0.0e1000000000000000')).toBe(0);
			expect(helpers.parseNumber(`1e${'0'.repeat(100_000)}308`)).toBe(1e308);
			// A long enough fraction makes up for an exponent of 7 digits.
			expect(helpers.parseNumber(`0.${'0'.repeat(1_000_000)}1e1000002`)).toBe(10);
			expect(helpers.parseNumber(`1e-${'0'.repeat(100_000)}324`)).toBe(0);
			expect(helpers.parseNumber(`${'0'.repeat(1000)}1e-${'0'.repeat(20)}323`)).toBe(1e-323);
			expect(helpers.parseNumber('1E-000000000000000000002%', { style: 'percent' })).toBe(1e-4);
		});

		it('gives NaN for misplaced grouping separators', function () {
			for (const text of ['1,23', '12,345,6', '1,2345', '1234,567', ',123', '1,,234', '1,234,', '01,234', '0,123', '1,23,456', '1,234.567,8']) {
				expect(helpers.parseNumber(text)).toBeNaN();
			}
		});

		it('gives NaN for anything but one number', function () {
			for (const text of [
				'',
				' ',
				'-',
				'+-1',
				'--1',
				'1-+',
				'1.2.3',
				'1..2',
				'1.',
				'12px',
				'px12',
				'1 2',
				'1 000',
				'0x1f',
				'1_000',
				'Infinity',
				'-Infinity',
				'NaN',
				'1e400',
				'1E',
				'E5',
				'1e5e5',
				'\n',
				'1\n000',
				'$5',
				'5%',
				'1.2K',
				'١٢٣'
			]) {
				expect(helpers.parseNumber(text)).toBeNaN();
			}
		});
	});

	describe('locales', function () {
		it('reads the separators of the locale', function () {
			expect(helpers.parseNumber('1.234,5', { locale: 'de-DE' })).toBe(1234.5);
			expect(helpers.parseNumber('1.234', { locale: 'de-DE' })).toBe(1234);
			expect(helpers.parseNumber('1,234', { locale: 'de-DE' })).toBe(1.234);
			expect(helpers.parseNumber('1.23', { locale: 'de-DE' })).toBeNaN();
			expect(helpers.parseNumber('1234,5', { locale: 'es-ES' })).toBe(1234.5);
			expect(helpers.parseNumber('12.345,5', { locale: 'es-ES' })).toBe(12345.5);
			expect(helpers.parseNumber('1.234', { locale: ['xx-invalid', 'en-US'] })).toBe(1.234);
		});

		it('takes any space for a space grouping separator (fr-FR, pl-PL), and both apostrophes in de-CH', function () {
			for (const space of [' ', NBSP, NNBSP, String.fromCharCode(0x2009)]) {
				expect(helpers.parseNumber(`1${space}234${space}567,5`, { locale: 'fr-FR' })).toBe(1234567.5);
				expect(helpers.parseNumber(`1${space}234,5`, { locale: 'pl-PL' })).toBe(1234.5);
			}
			expect(helpers.parseNumber("1'234.5", { locale: 'de-CH' })).toBe(1234.5);
			expect(helpers.parseNumber(`1${RIGHT_QUOTE}234.5`, { locale: 'de-CH' })).toBe(1234.5);
			expect(helpers.parseNumber('1 23,5', { locale: 'fr-FR' })).toBeNaN();
			expect(helpers.parseNumber('1\t234,5', { locale: 'fr-FR' })).toBe(1234.5);
		});

		it('reads Indian grouping where the locale uses it, and only there', function () {
			expect(helpers.parseNumber('12,34,567.5', { locale: 'hi-IN' })).toBe(1234567.5);
			expect(helpers.parseNumber('1,23,45,67,890', { locale: 'en-IN' })).toBe(1234567890);
			expect(helpers.parseNumber('1,234,567', { locale: 'hi-IN' })).toBeNaN();
			expect(helpers.parseNumber('123,456', { locale: 'hi-IN' })).toBeNaN();
			expect(helpers.parseNumber('12,34,567', { locale: 'en-US' })).toBeNaN();
		});

		it('reads the digits of the locale or of its numbering system, and ASCII digits, but not both in one number', function () {
			expect(helpers.parseNumber('١٬٢٣٤٫٥', { locale: 'ar-EG' })).toBe(1234.5);
			expect(helpers.parseNumber('1٬234٫5', { locale: 'ar-EG' })).toBe(1234.5);
			expect(helpers.parseNumber('١2', { locale: 'ar-EG' })).toBeNaN();
			const scientific = helpers.formatNumber(100, { locale: 'ar-EG', notation: 'scientific' });
			expect(helpers.parseNumber(scientific, { locale: 'ar-EG' })).toBe(100);
			expect(helpers.parseNumber(`${scientific.slice(0, -1)}2`, { locale: 'ar-EG' })).toBeNaN();
			expect(helpers.parseNumber('१,२३,४५६.७', { locale: 'hi-IN-u-nu-deva' })).toBe(123456.7);
			expect(helpers.parseNumber('१,२३,४५६.७', { locale: 'hi-IN', numberingSystem: 'deva' })).toBe(123456.7);
			expect(helpers.parseNumber('１，２３４', { locale: 'ja-JP-u-nu-fullwide' })).toBeNaN();
			expect(helpers.parseNumber('１,２３４．５', { locale: 'ja-JP-u-nu-fullwide' })).toBeNaN();
			expect(helpers.parseNumber('１,２３４.５', { locale: 'ja-JP-u-nu-fullwide' })).toBe(1234.5);
		});

		it('reads digits outside the Basic Multilingual Plane (mathbold)', function () {
			const text = helpers.formatNumber(-1234.5, { numberingSystem: 'mathbold' });
			expect(text.length).toBeGreaterThan(8);
			expect(helpers.parseNumber(text, { numberingSystem: 'mathbold' })).toBe(-1234.5);
		});

		it('ignores the bidirectional marks of right-to-left locales', function () {
			expect(helpers.parseNumber(`${ALM}-١٬٢٣٤٫٥`, { locale: 'ar-EG' })).toBe(-1234.5);
			expect(helpers.parseNumber(helpers.formatNumber(-1234.5, { locale: 'ar-EG' }), { locale: 'ar-EG' })).toBe(-1234.5);
			expect(helpers.parseNumber(helpers.formatNumber(-1234.5, { locale: 'fa-IR' }), { locale: 'fa-IR' })).toBe(-1234.5);
			expect(helpers.parseNumber(`${RLM}-1,234.5`, { locale: 'he-IL' })).toBe(-1234.5);
		});

		it("reads the locale's exponent separator", function () {
			expect(helpers.parseNumber(helpers.formatNumber(-1234.5, { locale: 'sv-SE', notation: 'scientific', maximumFractionDigits: 4 }), { locale: 'sv-SE' })).toBe(
				-1234.5
			);
			expect(helpers.parseNumber('1,5×10^3', { locale: 'sv-SE' })).toBe(1500);
			expect(helpers.parseNumber('1,5E3', { locale: 'sv-SE' })).toBeNaN();
			expect(helpers.parseNumber(helpers.formatNumber(0.000123, { locale: 'ar-EG', notation: 'scientific' }), { locale: 'ar-EG' })).toBe(0.000123);
		});
	});

	describe('percent style', function () {
		it('gives the ratio, with or without the percent sign', function () {
			expect(helpers.parseNumber('25%', { style: 'percent' })).toBe(0.25);
			expect(helpers.parseNumber('25', { style: 'percent' })).toBe(0.25);
			expect(helpers.parseNumber('-12.5 %', { style: 'percent' })).toBe(-0.125);
			expect(helpers.parseNumber('30%', { style: 'percent' })).toBe(0.3);
			expect(helpers.parseNumber(`25,6${NBSP}%`, { locale: 'de-DE', style: 'percent' })).toBe(0.256);
			expect(helpers.parseNumber('%25', { locale: 'tr-TR', style: 'percent' })).toBe(0.25);
			expect(helpers.parseNumber(helpers.formatPercent(-0.25, { locale: 'ar-EG' }), { locale: 'ar-EG', style: 'percent' })).toBe(-0.25);
		});

		it('rejects two percent signs, and a percent sign in another style', function () {
			expect(helpers.parseNumber('25%%', { style: 'percent' })).toBeNaN();
			expect(helpers.parseNumber('%25%', { style: 'percent' })).toBeNaN();
			expect(helpers.parseNumber('25%')).toBeNaN();
			expect(helpers.parseNumber('25%', { style: 'currency' })).toBeNaN();
		});
	});

	describe('currency style', function () {
		it('accepts any currency sign or code without `currency`', function () {
			expect(helpers.parseNumber('$1,234.50', { style: 'currency' })).toBe(1234.5);
			expect(helpers.parseNumber('-$5', { style: 'currency' })).toBe(-5);
			expect(helpers.parseNumber('$-5', { style: 'currency' })).toBe(-5);
			expect(helpers.parseNumber('($1,234.50)', { style: 'currency' })).toBe(-1234.5);
			expect(helpers.parseNumber('US$5', { style: 'currency' })).toBe(5);
			expect(helpers.parseNumber(`5,00${NBSP}$US`, { locale: 'fr-FR', style: 'currency' })).toBe(5);
			expect(helpers.parseNumber('5 USD', { style: 'currency' })).toBe(5);
			expect(helpers.parseNumber('EUR 5', { style: 'currency' })).toBe(5);
			expect(helpers.parseNumber('1EUR', { style: 'currency' })).toBe(1);
			expect(helpers.parseNumber('5', { style: 'currency' })).toBe(5);
			expect(helpers.parseNumber('₹1,23,456.50', { locale: 'en-IN', style: 'currency' })).toBe(123456.5);
		});

		it('rejects two currencies, names and lowercase codes without `currency`', function () {
			for (const text of ['$5 €', '$€5', '5 usd', '5 US dollars', '5 zł', '5 USDX', '5 EU', '5 $$']) {
				expect(helpers.parseNumber(text, { style: 'currency' })).toBeNaN();
			}
		});

		it("accepts only the given currency's symbols, code and names with `currency` (which implies the style)", function () {
			expect(helpers.parseNumber('-1.234,50 €', { locale: 'de-DE', currency: 'EUR' })).toBe(-1234.5);
			expect(helpers.parseNumber('1.234,50 EUR', { locale: 'de-DE', currency: 'EUR' })).toBe(1234.5);
			expect(helpers.parseNumber('1.234,50 Euro', { locale: 'de-DE', currency: 'EUR' })).toBe(1234.5);
			expect(helpers.parseNumber('1.234,50 $', { locale: 'de-DE', currency: 'EUR' })).toBeNaN();
			expect(helpers.parseNumber('1234,50 zł', { locale: 'pl-PL', currency: 'PLN' })).toBe(1234.5);
			expect(helpers.parseNumber('5 złotych polskich', { locale: 'pl-PL', currency: 'PLN' })).toBe(5);
			expect(helpers.parseNumber('2 złote polskie', { locale: 'pl-PL', currency: 'PLN' })).toBe(2);
			expect(helpers.parseNumber('1,5 złotego polskiego', { locale: 'pl-PL', currency: 'PLN' })).toBe(1.5);
			expect(helpers.parseNumber('1,234.50 US dollars', { currency: 'usd' })).toBe(1234.5);
			expect(helpers.parseNumber('1 US dollar', { currency: 'USD' })).toBe(1);
			expect(helpers.parseNumber('￥1,235', { locale: 'ja-JP', currency: 'JPY' })).toBe(1235);
			expect(helpers.parseNumber('1,235円', { locale: 'ja-JP', currency: 'JPY' })).toBe(1235);
			expect(helpers.parseNumber('5', { currency: 'EUR', style: 'decimal' })).toBe(5);
			expect(helpers.parseNumber('5 €', { currency: 'EUR', style: 'decimal' })).toBeNaN();
		});

		it('reads the separators and grouping of amounts, which can differ from those of numbers', function () {
			expect(helpers.parseNumber('€ 1.234,50', { locale: 'de-AT', currency: 'EUR' })).toBe(1234.5);
			expect(helpers.parseNumber(`1${NBSP}234,5`, { locale: 'de-AT' })).toBe(1234.5);
			expect(helpers.parseNumber("1'234.50 CHF", { locale: 'fr-CH', currency: 'CHF' })).toBe(1234.5);
			expect(helpers.parseNumber("1'234,5", { locale: 'fr-CH' })).toBe(1234.5);
			expect(helpers.parseNumber('-$१,२३४,५६७.००', { locale: 'mr-IN', currency: 'USD' })).toBe(-1234567);
			expect(helpers.parseNumber('-$१२,३४,५६७.००', { locale: 'mr-IN', currency: 'USD' })).toBe(-1234567);
		});

		it('reads a currency symbol and a currency name together (as tr-TR writes names)', function () {
			const text = helpers.formatCurrency(-1234.5, 'USD', { locale: 'tr-TR', display: 'name' });
			expect(helpers.parseNumber(text, { locale: 'tr-TR', currency: 'USD' })).toBe(-1234.5);
		});
	});

	describe('compact style', function () {
		it('multiplies by the power of ten of the suffix, short or long', function () {
			expect(helpers.parseNumber('1.2K', { style: 'compact' })).toBe(1200);
			expect(helpers.parseNumber('3.4M', { style: 'compact' })).toBe(3_400_000);
			expect(helpers.parseNumber('-1.5B', { style: 'compact' })).toBe(-1_500_000_000);
			expect(helpers.parseNumber('2T', { style: 'compact' })).toBe(2e12);
			expect(helpers.parseNumber('1.2 thousand', { style: 'compact' })).toBe(1200);
			expect(helpers.parseNumber('999', { style: 'compact' })).toBe(999);
			expect(helpers.parseNumber(`1,2${NBSP}Mio.`, { locale: 'de-DE', style: 'compact' })).toBe(1_200_000);
			expect(helpers.parseNumber('2 Millionen', { locale: 'de-DE', style: 'compact' })).toBe(2_000_000);
			expect(helpers.parseNumber('1.2万', { locale: 'ja-JP', style: 'compact' })).toBe(12_000);
			expect(helpers.parseNumber('12万', { locale: 'ja-JP', style: 'compact' })).toBe(120_000);
			expect(helpers.parseNumber('3億', { locale: 'ja-JP', style: 'compact' })).toBe(3e8);
			expect(helpers.parseNumber('100,000京', { locale: 'ja-JP', style: 'compact' })).toBe(1e21);
			expect(helpers.parseNumber('1.5E3K', { style: 'compact' })).toBe(1_500_000);
		});

		it('reads a word that stands for its unit without a number', function () {
			expect(helpers.formatCompact(1000, { locale: 'fr-CH', display: 'long' })).toBe('mille');
			expect(helpers.parseNumber('mille', { locale: 'fr-CH', style: 'compact' })).toBe(1000);
			expect(helpers.parseNumber('-mille', { locale: 'fr-CH', style: 'compact' })).toBe(-1000);
			expect(helpers.parseNumber('2 mille', { locale: 'fr-CH', style: 'compact' })).toBe(2000);
			expect(helpers.parseNumber('mille mille', { locale: 'fr-CH', style: 'compact' })).toBeNaN();
		});

		it('rejects unknown, repeated and misplaced suffixes', function () {
			for (const text of ['1.2k', '1.2KK', 'K', '1.2 K M', '1.2X', '1.2万']) {
				expect(helpers.parseNumber(text, { style: 'compact' })).toBeNaN();
			}
			expect(helpers.parseNumber('1.2K')).toBeNaN();
		});
	});

	describe('round trips', function () {
		it('parses back what the format helpers write', function () {
			expect(helpers.parseNumber(helpers.formatNumber(-1234567.891, { locale: 'hi-IN' }), { locale: 'hi-IN' })).toBe(-1234567.891);
			expect(helpers.parseNumber(helpers.formatCurrency(-1234.5, 'EUR', { locale: 'fr-FR', currencySign: 'accounting' }), { locale: 'fr-FR', currency: 'EUR' })).toBe(
				-1234.5
			);
			expect(helpers.parseNumber(helpers.formatCurrency(1234.5, 'USD', { locale: 'en-IN', currencySign: 'accounting' }), { locale: 'en-IN', currency: 'USD' })).toBe(
				1234.5
			);
			expect(helpers.parseNumber(helpers.formatPercent(0.256, { locale: 'fr-FR', decimals: 1 }), { locale: 'fr-FR', style: 'percent' })).toBe(0.256);
			expect(helpers.parseNumber(helpers.formatCompact(1_234_567, { locale: 'es-ES', display: 'long' }), { locale: 'es-ES', style: 'compact' })).toBe(1_200_000);
			expect(helpers.parseNumber(helpers.formatNumber(1e21), {})).toBe(1e21);
		});
	});

	describe('options and errors', function () {
		it('rejects a non-string text, an unknown style and a non-string currency', function () {
			expect(function () {
				helpers.parseNumber(5 as unknown as string);
			}).toThrow(new TypeError('parseNumber: `text` must be a string, got number'));
			expect(function () {
				helpers.parseNumber(null as unknown as string);
			}).toThrow(new TypeError('parseNumber: `text` must be a string, got null'));
			expect(function () {
				helpers.parseNumber('5', { style: 'unit' as never });
			}).toThrow(new RangeError("parseNumber: `style` must be 'decimal', 'percent', 'currency' or 'compact', got unit"));
			expect(function () {
				helpers.parseNumber('5', { style: {} as never });
			}).toThrow(new RangeError("parseNumber: `style` must be 'decimal', 'percent', 'currency' or 'compact', got object"));
			expect(function () {
				helpers.parseNumber('5', { currency: 5 as unknown as string });
			}).toThrow(new TypeError('parseNumber: `currency` must be a string, got number'));
		});

		it('lets Intl reject a malformed locale, currency code or numbering system', function () {
			expect(function () {
				helpers.parseNumber('5', { locale: 'en_US' });
			}).toThrow(RangeError);
			expect(function () {
				helpers.parseNumber('5', { currency: 'US' });
			}).toThrow(RangeError);
			expect(function () {
				helpers.parseNumber('5', { numberingSystem: 'a' });
			}).toThrow(RangeError);
		});

		it('ignores the other options, so the options of a format helper can be passed as they are', function () {
			const options = { locale: 'de-DE', maximumFractionDigits: 1, useGrouping: false } as const;
			expect(helpers.parseNumber(helpers.formatNumber(1234.56, options), options)).toBe(1234.6);
		});

		it('builds the symbols of a locale once (cached), and gives the same answers from the cache', function () {
			const first = helpers.parseNumber('1 234,5', { locale: 'fr-CA' });
			const spy = jest.spyOn(Intl, 'NumberFormat');
			expect(helpers.parseNumber('1 234,5', { locale: 'fr-CA' })).toBe(first);
			expect(helpers.parseNumber('-2', { locale: ['fr-CA'] })).toBe(-2);
			expect(helpers.parseNumber('-2', { locale: ['fr-CA'] })).toBe(-2);
			expect(spy).not.toHaveBeenCalled();
		});

		it('ignores options inherited from a polluted Object.prototype', function () {
			const proto = Object.prototype as Record<string, unknown>;
			proto.style = 'percent';
			proto.currency = 'EUR';
			proto.locale = 'de-DE';
			try {
				expect(helpers.parseNumber('1,234.5')).toBe(1234.5);
				expect(helpers.parseNumber('1,234.5', {})).toBe(1234.5);
				expect(helpers.parseNumber('$5', { style: 'currency' })).toBe(5);
			} finally {
				delete proto.style;
				delete proto.currency;
				delete proto.locale;
			}
		});

		it('runs in linear time on hostile input', function () {
			const start = performance.now();
			expect(helpers.parseNumber('1'.repeat(200_000))).toBe(NaN);
			expect(helpers.parseNumber(`1${',234'.repeat(100_000)}`)).toBe(NaN);
			expect(helpers.parseNumber(`1${' '.repeat(200_000)}x`)).toBeNaN();
			expect(helpers.parseNumber(`${'US$'.repeat(100_000)}1`, { style: 'currency' })).toBeNaN();
			expect(helpers.parseNumber(`1${' K'.repeat(100_000)}`, { style: 'compact' })).toBeNaN();
			expect(helpers.parseNumber(`${'('.repeat(100_000)}1${')'.repeat(100_000)}`)).toBeNaN();
			expect(helpers.parseNumber(`0.${'0'.repeat(200_000)}1e200000`)).toBe(0.1);
			expect(performance.now() - start).toBeLessThan('__stryker__' in globalThis ? Infinity : 1000);
		});
	});
});

describe('Format helpers (pass 5 regressions)', function () {
	it('reads the symbols of parseNumber and the digits of pluralRule without options planted on Object.prototype', function () {
		const proto = Object.prototype as unknown as Record<string, unknown>;
		const planted: Record<string, unknown> = { maximumFractionDigits: 0, minimumFractionDigits: 0, notation: 'compact', useGrouping: false, style: 'percent' };
		for (const key of Object.keys(planted)) proto[key] = planted[key];
		try {
			// First reads of these locales: their symbols are cached, so a polluted read would outlive the pollution.
			expect(helpers.parseNumber('1.234,5', { locale: 'de-DE' })).toBe(1234.5);
			expect(helpers.parseNumber('1 234,5', { locale: 'fr-CA' })).toBe(1234.5);
			expect(helpers.parseNumber("1'234.5 CHF", { locale: 'de-CH', currency: 'CHF' })).toBe(1234.5);
			expect(helpers.parseNumber('12K', { locale: 'en-IE', style: 'compact' })).toBe(12000);
			expect(helpers.pluralRule(1e21, { locale: 'en-AU' })).toBe('other');
		} finally {
			for (const key of Object.keys(planted)) delete proto[key];
		}
		expect(helpers.parseNumber('1.234,5', { locale: 'de-DE' })).toBe(1234.5);
		expect(helpers.parseNumber('1 234,5', { locale: 'fr-CA' })).toBe(1234.5);
	});
});
