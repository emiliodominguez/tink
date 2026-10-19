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
