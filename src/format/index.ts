/**
 * Locale-aware formatting helpers built on the `Intl` APIs.
 *
 * Conventions shared by every function in this module:
 * - **Deterministic default locale.** Every function takes an optional `locale` (a BCP 47 tag or a priority list of tags) that defaults
 *   to `'en-US'`, NOT to the runtime's default locale. The host default depends on `LANG`, the browser UI language or the server image,
 *   so relying on it makes output differ between machines, test runs and server/client renders (hydration mismatches). For the same
 *   reason `'en-US'` is always appended as the last fallback of the list you pass: when none of your locales is supported, the result is
 *   `en-US` formatting rather than the host default. An empty list means `'en-US'`. A malformed tag (e.g. `'en_US'`) throws the
 *   `RangeError` raised by `Intl`.
 * - **Deterministic default time zone.** {@link formatDateTime} formats in `'UTC'` unless you pass `timeZone` (the `date` module, in
 *   contrast, works in local time).
 * - **Cached formatters.** Constructing an `Intl` formatter is far more expensive than calling `format` on it, so formatters are cached
 *   per `(kind, locales, options)` in a small least-recently-used cache (50 entries) shared by the whole module. Formatters are
 *   immutable, so a cached one always produces exactly what a freshly constructed one would. (Options whose value is an object, and
 *   `Intl.Locale` objects in a locale list, bypass the cache.) On top of it, every function remembers the formatter of its previous
 *   call: a call with the same locale string and option values (the usual case when formatting many values) reuses it without even
 *   building the cache key, which brings the cost close to that of calling a prebuilt formatter.
 * - **Validation.** Where a number is required, a non-number throws `TypeError`, and `NaN` / `±Infinity` throw `RangeError` instead of
 *   being rendered as `'NaN'` / `'∞'`, which is never what a UI wants to show. Errors raised by `Intl` itself (an invalid currency code,
 *   unit, time zone or option combination) propagate unchanged: they are already `RangeError`/`TypeError` with a clear message.
 * - **Whitespace.** Some locales and ICU versions use non-breaking spaces (U+00A0, U+202F) inside formatted output (e.g. `'USD 1.00'`
 *   with U+00A0, or before `AM`/`PM`). Output is returned exactly as `Intl` produces it; compare loosely in tests.
 */

import { createLRUCache, type LRUCache } from '../cache/index.js';
import type { DateInput } from '../date/index.js';
import { isDate, isIterable, isString } from '../guards/index.js';
import { describe } from '../utils/assert.js';

/**
 * A BCP 47 language tag (`'de-DE'`) or a priority list of tags (`['fr-CA', 'fr']`).
 */
export type LocaleInput = string | readonly string[];

/**
 * The `Intl.NumberFormatOptions` that the number helpers pass through to `Intl.NumberFormat` (everything except the options that
 * select the style, which each helper sets itself).
 */
export type NumberFormatPassThroughOptions = Omit<Intl.NumberFormatOptions, 'style' | 'currency' | 'currencyDisplay' | 'unit' | 'unitDisplay'>;

/**
 * Options accepted by {@link formatNumber}.
 */
export interface FormatNumberOptions extends NumberFormatPassThroughOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
}

/**
 * Options accepted by {@link formatCurrency}.
 */
export interface FormatCurrencyOptions extends NumberFormatPassThroughOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** How to display the currency: `'symbol'` (`$`, the default), `'narrowSymbol'`, `'code'` (`USD`) or `'name'` (`US dollars`). */
	display?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
}

/**
 * Options accepted by {@link formatPercent}.
 */
export interface FormatPercentOptions extends NumberFormatPassThroughOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/**
	 * Exact number of fraction digits (an integer from 0 to 20, the range every supported runtime's `Intl` accepts). Overrides
	 * `minimumFractionDigits`/`maximumFractionDigits`; like them, it is ignored by `Intl` when significant-digit options are also given
	 * (unless `roundingPriority` says otherwise).
	 */
	decimals?: number;
}

/**
 * Options accepted by {@link formatCompact}.
 */
export interface FormatCompactOptions extends Omit<NumberFormatPassThroughOptions, 'notation' | 'compactDisplay'> {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** `'short'` (`1.2K`, the default) or `'long'` (`1.2 thousand`). */
	display?: 'short' | 'long';
}

/**
 * Options accepted by {@link formatUnit}.
 */
export interface FormatUnitOptions extends NumberFormatPassThroughOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** `'short'` (`50 km/h`, the default), `'narrow'` (`50km/h`) or `'long'` (`50 kilometers per hour`). */
	display?: 'short' | 'narrow' | 'long';
}

/**
 * Options accepted by {@link formatList}.
 */
export interface FormatListOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** `'conjunction'` (`a, b, and c`, the default), `'disjunction'` (`a, b, or c`) or `'unit'` (`5 ft, 2 in`). */
	type?: Intl.ListFormatType;
	/** `'long'` (the default), `'short'` or `'narrow'`. */
	style?: Intl.ListFormatStyle;
}

/**
 * Options accepted by {@link formatDateTime}: every `Intl.DateTimeFormatOptions` option plus `locale`.
 */
export interface FormatDateTimeOptions extends Intl.DateTimeFormatOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** IANA time zone to format in (`'Europe/Madrid'`). Defaults to `'UTC'` — NOT the runtime's time zone — for deterministic output. */
	timeZone?: string;
}

/**
 * Options accepted by {@link formatRelativeTime}: every `Intl.RelativeTimeFormatOptions` option plus `locale`.
 */
export interface FormatRelativeTimeOptions extends Intl.RelativeTimeFormatOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
}

/**
 * Ordinal suffixes keyed by `Intl.PluralRules` ordinal category; `other` is required and used for any category not listed.
 */
export type OrdinalSuffixes = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * Options accepted by {@link formatOrdinal}.
 */
export interface FormatOrdinalOptions {
	/** Locale(s) to format with. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/** Suffixes per ordinal category. Defaults to the English ones for English locales and to `{ other: '.' }` otherwise. */
	suffixes?: OrdinalSuffixes;
}

/**
 * Options accepted by {@link pluralRule}: every `Intl.PluralRulesOptions` option plus `locale`.
 */
export interface PluralRuleOptions extends Intl.PluralRulesOptions {
	/** Locale(s) to use. Defaults to `'en-US'`. */
	locale?: LocaleInput;
}

/** Locale used when none is given, and appended as the last fallback of every locale list. */
const DEFAULT_LOCALE = 'en-US';

/** Largest `decimals` accepted by {@link formatPercent}: the `maximumFractionDigits` limit of pre-ES2023 engines (Node 20); newer ones allow 100. */
const MAX_PERCENT_DECIMALS = 20;

/** Maximum number of cached `Intl` formatters. */
const FORMATTER_CACHE_SIZE = 50;

/** English ordinal suffixes keyed by `Intl.PluralRules` ordinal category. */
const ENGLISH_ORDINAL_SUFFIXES: OrdinalSuffixes = { one: 'st', two: 'nd', few: 'rd', other: 'th' };

/** Suffix used for non-English locales when no `suffixes` are given (`1.`, `2.` — German, Nordic, Czech, Polish, Turkish…). */
const GENERIC_ORDINAL_SUFFIXES: OrdinalSuffixes = { other: '.' };

/** Module-wide LRU cache of `Intl` formatter instances. */
let formatterCache: LRUCache<string, unknown> | undefined;

/** The resolved language of every plural-rules formatter {@link formatOrdinal} has used (see `resolvedLanguage`). */
const resolvedLanguages = new WeakMap<Intl.PluralRules, string>();

/**
 * Normalizes a {@link LocaleInput} into the list passed to `Intl`, ending with `'en-US'` so negotiation never falls back to the host's
 * default locale.
 * @param {LocaleInput | undefined} locale - The requested locale(s)
 * @returns {string[]} A fresh list of locale tags
 * @throws {TypeError} when `locale` is neither a string nor an array
 */
function resolveLocales(locale: LocaleInput | undefined): string[] {
	if (locale === undefined) return [DEFAULT_LOCALE];
	if (typeof locale !== 'string' && !Array.isArray(locale)) throw new TypeError(`format: \`locale\` must be a string or an array of strings, got ${describe(locale)}`);

	const requested: string[] = typeof locale === 'string' ? [locale] : [...locale];

	return requested.includes(DEFAULT_LOCALE) ? requested : [...requested, DEFAULT_LOCALE];
}

/**
 * Encodes a string as a self-delimiting cache-key field: its length, `:`, then the string itself.
 * @param {string} text - The text to encode
 * @returns {string} The field
 */
function field(text: string): string {
	return `${text.length}:${text}`;
}

/**
 * Builds the formatter cache key for `(kind, locales, options)`: the kind (letters only), a length-prefixed field per locale, then per
 * option its length-prefixed name, its `typeof` (letters only) and its length-prefixed `String()` form. Fields start with a digit and
 * `typeof` words do not, so the key can be decoded unambiguously (the field before the first word is the first option name): distinct
 * inputs never share a key. Tagging values with their type keeps apart values that stringify alike (`null` and `'null'`). `undefined`
 * options are skipped, as `Intl` treats them as absent. This runs on every call, so it only concatenates strings.
 * @param {string} kind - A key prefix identifying the formatter class
 * @param {readonly unknown[]} locales - The resolved locale list
 * @param {object} options - The options passed to the constructor
 * @returns {string | undefined} The key, or `undefined` (do not cache) when a locale is not a string or an option value is an object or
 * a function: `Intl` reads those through `toString`/`valueOf`, which a key cannot capture
 */
function cacheKey(kind: string, locales: readonly unknown[], options: object): string | undefined {
	let key = kind;

	for (const locale of locales) {
		if (!isString(locale)) return undefined;
		key += field(locale);
	}

	for (const [name, value] of Object.entries(options)) {
		if (value === undefined) continue;
		if ((typeof value === 'object' && value !== null) || typeof value === 'function') return undefined;
		key += field(name) + typeof value + field(String(value));
	}

	return key;
}

/**
 * The last formatter a call site obtained from {@link getFormatter}, with the inputs it was built from: the locale (a string or
 * `undefined`: a locale list could be mutated by the caller, so it is never memoized) and the options object (always one the module
 * built itself, so it is never mutated afterwards).
 */
interface FormatterMemo {
	formatter: unknown;
	locale: string | undefined;
	options: object;
	/** The number of keys of `options` whose value is not `undefined`. */
	size: number;
}

/**
 * Counts the options whose value is not `undefined` (`Intl` treats an `undefined` option as absent).
 * @param {object} options - The options
 * @returns {number} The count
 */
function countDefined(options: object): number {
	let count = 0;

	for (const name in options) if ((options as Record<string, unknown>)[name] !== undefined) count++;

	return count;
}

/**
 * Tells whether two options objects set the same options to the same values (`===`), `undefined` meaning absent. Only options without
 * object or function values are memoized (see {@link cacheKey}), so an object or function value never matches.
 * @param {object} a - The requested options
 * @param {object} b - The memoized options
 * @param {number} size - {@link countDefined} of `b`
 * @returns {boolean} Whether they are equal
 */
function sameOptions(a: object, b: object, size: number): boolean {
	let count = 0;

	for (const name in a) {
		const value: unknown = (a as Record<string, unknown>)[name];

		if (value === undefined) continue;
		if (value !== (b as Record<string, unknown>)[name]) return false;

		count++;
	}

	// Every defined option of `a` is set the same way in `b`, so equal counts mean equal sets.
	return count === size;
}

/**
 * Returns a cached `Intl` formatter for `(kind, locale, options)`, constructing and caching it on a miss.
 *
 * Building the cache key costs about as much as formatting, so each call site first compares its inputs with those of its previous call
 * (`memo`): repeated calls with equal arguments, the common case when formatting many values, skip the key entirely.
 * @template T - The formatter type
 * @template O - The options type
 * @param {string} kind - A key prefix identifying the formatter class
 * @param {Function} Formatter - The `Intl` constructor
 * @param {LocaleInput | undefined} locale - The requested locale(s)
 * @param {O} options - The options passed to the constructor (an object this module built)
 * @param {FormatterMemo} memo - The call site's memo
 * @returns {T} The formatter
 * @throws {RangeError} when `Intl` rejects the locale or the options
 */
function getFormatter<T, O>(kind: string, Formatter: new (locales: string[], options: O) => T, locale: LocaleInput | undefined, options: O, memo: FormatterMemo): T {
	if (memo.formatter !== undefined && locale === memo.locale && sameOptions(options as object, memo.options, memo.size)) return memo.formatter as T;

	const locales = resolveLocales(locale);
	const key = cacheKey(kind, locales, options as object);

	if (key === undefined) return new Formatter(locales, options);

	// Created on first use: a module-level call would be kept by bundlers even when no formatter is imported.
	const cache = (formatterCache ??= createLRUCache<string, unknown>({ max: FORMATTER_CACHE_SIZE }));
	let formatter = cache.get(key) as T | undefined;

	if (formatter === undefined) {
		formatter = new Formatter(locales, options);
		cache.set(key, formatter);
	}

	if (typeof locale !== 'object') {
		memo.formatter = formatter;
		memo.locale = locale;
		memo.options = options as object;
		memo.size = countDefined(options as object);
	}

	return formatter;
}

/** Per-call-site memos for {@link getFormatter}. */
const NUMBER_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const CURRENCY_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const PERCENT_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const COMPACT_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const UNIT_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const LIST_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const DATE_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const RELATIVE_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const ORDINAL_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };
/** @see NUMBER_MEMO */
const PLURAL_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };

/**
 * Returns the language subtag of the locale a plural-rules formatter resolved to. `resolvedOptions()` allocates and is several times
 * slower than `select()`, so the answer is remembered per (usually cached) formatter.
 * @param {Intl.PluralRules} rules - The formatter
 * @returns {string} The language subtag (`'en'` for `'en-US'`)
 */
function resolvedLanguage(rules: Intl.PluralRules): string {
	let language = resolvedLanguages.get(rules);

	if (language === undefined) {
		language = rules.resolvedOptions().locale.split('-')[0];
		resolvedLanguages.set(rules, language);
	}

	return language;
}

/**
 * Throws unless `value` is a finite number.
 * @param {string} name - The calling function's name, for the error message
 * @param {unknown} value - The value to check
 * @param {string} [label='value'] - The parameter name, for the error message
 * @returns {void}
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is `NaN` or `±Infinity`
 */
function assertFiniteNumber(name: string, value: unknown, label: string = 'value'): asserts value is number {
	if (typeof value !== 'number') throw new TypeError(`${name}: \`${label}\` must be a number, got ${describe(value)}`);
	if (!Number.isFinite(value)) throw new RangeError(`${name}: \`${label}\` must be finite, got ${value}`);
}

/**
 * Throws unless `value` is a bigint or a finite number.
 * @param {string} name - The calling function's name, for the error message
 * @param {unknown} value - The value to check
 * @returns {void}
 * @throws {TypeError} when `value` is neither a number nor a bigint
 * @throws {RangeError} when `value` is `NaN` or `±Infinity`
 */
function assertNumeric(name: string, value: unknown): asserts value is number | bigint {
	if (typeof value !== 'bigint') assertFiniteNumber(name, value);
}

/**
 * Throws a `TypeError` unless `value` is a string.
 * @param {string} name - The calling function's name, for the error message
 * @param {string} label - The parameter name, for the error message
 * @param {unknown} value - The value to check
 * @returns {void}
 * @throws {TypeError} when `value` is not a string
 */
function assertString(name: string, label: string, value: unknown): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${name}: \`${label}\` must be a string, got ${describe(value)}`);
}

/**
 * Formats a number with locale-aware grouping and decimal separators via `Intl.NumberFormat` (every non-style option passes through:
 * `minimumFractionDigits`, `maximumFractionDigits`, `signDisplay`, `useGrouping`, `notation`, …). Bigints are formatted exactly.
 * @param {number | bigint} value - A finite number or a bigint
 * @param {FormatNumberOptions} [options={}] - `locale` (default `'en-US'`) and `Intl.NumberFormat` options
 * @returns {string} The formatted number
 * @throws {TypeError} when `value` is neither a number nor a bigint
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, the locale is malformed, or `Intl` rejects an option (e.g. min > max digits)
 * @example
 * formatNumber(1234567.891); // => '1,234,567.891'
 * formatNumber(1234.5, { minimumFractionDigits: 2 }); // => '1,234.50'
 * formatNumber(3.14159, { maximumFractionDigits: 2 }); // => '3.14'
 * formatNumber(1234.5, { locale: 'de-DE' }); // => '1.234,5'
 * formatNumber(12345678901234567890n); // => '12,345,678,901,234,567,890'
 * formatNumber(NaN); // throws RangeError
 */
export function formatNumber(value: number | bigint, options: FormatNumberOptions = {}): string {
	assertNumeric('formatNumber', value);
	const { locale, ...rest } = options;

	return getFormatter('number', Intl.NumberFormat, locale, rest, NUMBER_MEMO).format(value);
}

/**
 * Formats an amount of money via `Intl.NumberFormat` with `style: 'currency'`. The currency's usual number of fraction digits applies
 * unless overridden (`JPY` has none, `USD` has two).
 *
 * Currency codes are validated by `Intl`: a malformed code (not three ASCII letters) throws its `RangeError`, which propagates. A
 * well-formed but unknown code such as `'XYZ'` is accepted and rendered with the code itself.
 * @param {number | bigint} value - A finite number or a bigint
 * @param {string} currency - An ISO 4217 currency code (`'USD'`, `'eur'`; case-insensitive)
 * @param {FormatCurrencyOptions} [options={}] - `locale` (default `'en-US'`), `display` (default `'symbol'`) and other `Intl.NumberFormat`
 * options (`currencySign: 'accounting'`, `maximumFractionDigits`, …)
 * @returns {string} The formatted amount
 * @throws {TypeError} when `value` is neither a number nor a bigint, or `currency` is not a string
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, `currency` is malformed, or the locale or an option is invalid
 * @example
 * formatCurrency(1234.5, 'USD'); // => '$1,234.50'
 * formatCurrency(1234.5, 'EUR'); // => '€1,234.50'
 * formatCurrency(1234.5, 'JPY'); // => '¥1,235'
 * formatCurrency(1234.5, 'USD', { display: 'name' }); // => '1,234.50 US dollars'
 * formatCurrency(-5, 'USD', { currencySign: 'accounting' }); // => '($5.00)'
 * formatCurrency(1, 'US'); // throws RangeError
 */
export function formatCurrency(value: number | bigint, currency: string, options: FormatCurrencyOptions = {}): string {
	assertNumeric('formatCurrency', value);
	assertString('formatCurrency', 'currency', currency);
	const { locale, display = 'symbol', ...rest } = options;

	return getFormatter('number', Intl.NumberFormat, locale, { ...rest, style: 'currency', currency, currencyDisplay: display }, CURRENCY_MEMO).format(value);
}

/**
 * Formats a ratio as a percentage via `Intl.NumberFormat` with `style: 'percent'` (`0.256` is 25.6 %).
 * @param {number} value - A finite ratio (`1` is 100 %)
 * @param {FormatPercentOptions} [options={}] - `locale` (default `'en-US'`), `decimals` (exact fraction digits; when omitted, `Intl`'s
 * default of 0 applies unless `minimumFractionDigits`/`maximumFractionDigits` are given) and other `Intl.NumberFormat` options
 * @returns {string} The formatted percentage
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, `decimals` is not an integer from 0 to 20, or the locale or an option is invalid
 * @example
 * formatPercent(0.256); // => '26%'
 * formatPercent(0.256, { decimals: 1 }); // => '25.6%'
 * formatPercent(0.5, { decimals: 2 }); // => '50.00%'
 * formatPercent(1.5); // => '150%'
 * formatPercent(0.1234, { maximumFractionDigits: 2 }); // => '12.34%'
 */
export function formatPercent(value: number, options: FormatPercentOptions = {}): string {
	assertFiniteNumber('formatPercent', value);
	const { locale, decimals, ...rest } = options;

	if (decimals !== undefined) {
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_PERCENT_DECIMALS) {
			throw new RangeError(`formatPercent: \`decimals\` must be an integer from 0 to ${MAX_PERCENT_DECIMALS}, got ${decimals}`);
		}

		rest.minimumFractionDigits = decimals;
		rest.maximumFractionDigits = decimals;
	}

	return getFormatter('number', Intl.NumberFormat, locale, { ...rest, style: 'percent' }, PERCENT_MEMO).format(value);
}

/**
 * Formats a number in compact notation (`1.2K`, `3.4M`, `1.2 thousand`) via `Intl.NumberFormat` with `notation: 'compact'`.
 * @param {number | bigint} value - A finite number or a bigint
 * @param {FormatCompactOptions} [options={}] - `locale` (default `'en-US'`), `display` (`'short'`, the default, or `'long'`) and other
 * `Intl.NumberFormat` options (`maximumFractionDigits`, …)
 * @returns {string} The formatted number
 * @throws {TypeError} when `value` is neither a number nor a bigint
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, or the locale or an option is invalid
 * @example
 * formatCompact(1234); // => '1.2K'
 * formatCompact(3_400_000); // => '3.4M'
 * formatCompact(999); // => '999'
 * formatCompact(1234, { display: 'long' }); // => '1.2 thousand'
 * formatCompact(1_234_567, { maximumFractionDigits: 2 }); // => '1.23M'
 */
export function formatCompact(value: number | bigint, options: FormatCompactOptions = {}): string {
	assertNumeric('formatCompact', value);
	const { locale, display = 'short', ...rest } = options;

	return getFormatter('number', Intl.NumberFormat, locale, { ...rest, notation: 'compact', compactDisplay: display }, COMPACT_MEMO).format(value);
}

/**
 * Formats a measurement via `Intl.NumberFormat` with `style: 'unit'`. `unit` must be a sanctioned simple unit (`'kilometer'`,
 * `'celsius'`, `'megabyte'`, …) or a `'<unit>-per-<unit>'` compound (`'kilometer-per-hour'`); `Intl` throws a `RangeError` for anything
 * else, which propagates. For byte sizes with an automatically chosen unit use `formatBytes` from the `math` module instead.
 * @param {number | bigint} value - A finite number or a bigint
 * @param {string} unit - A sanctioned `Intl` unit identifier
 * @param {FormatUnitOptions} [options={}] - `locale` (default `'en-US'`), `display` (`'short'`, the default, `'narrow'` or `'long'`) and
 * other `Intl.NumberFormat` options
 * @returns {string} The formatted measurement
 * @throws {TypeError} when `value` is neither a number nor a bigint, or `unit` is not a string
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, `unit` is not supported, or the locale or an option is invalid
 * @example
 * formatUnit(50, 'kilometer-per-hour'); // => '50 km/h'
 * formatUnit(50, 'kilometer-per-hour', { display: 'long' }); // => '50 kilometers per hour'
 * formatUnit(1, 'liter', { display: 'long' }); // => '1 liter'
 * formatUnit(1, 'parsec'); // throws RangeError
 */
export function formatUnit(value: number | bigint, unit: string, options: FormatUnitOptions = {}): string {
	assertNumeric('formatUnit', value);
	assertString('formatUnit', 'unit', unit);
	const { locale, display = 'short', ...rest } = options;

	return getFormatter('number', Intl.NumberFormat, locale, { ...rest, style: 'unit', unit, unitDisplay: display }, UNIT_MEMO).format(value);
}

/**
 * Joins strings into a grammatical list via `Intl.ListFormat` (`'a, b, and c'`, `'a, b, or c'`). The items appear in the output
 * unchanged and in iteration order.
 * @param {Iterable<string>} items - The items (any iterable of strings except a bare string, which is almost always a mistake)
 * @param {FormatListOptions} [options={}] - `locale` (default `'en-US'`), `type` (default `'conjunction'`) and `style` (default `'long'`)
 * @returns {string} The formatted list (`''` for no items)
 * @throws {TypeError} when `items` is a string or not iterable, or yields a non-string
 * @throws {RangeError} when the locale or an option is invalid
 * @example
 * formatList(['a', 'b', 'c']); // => 'a, b, and c'
 * formatList(['a', 'b']); // => 'a and b'
 * formatList(['a', 'b', 'c'], { type: 'disjunction' }); // => 'a, b, or c'
 * formatList(['5 ft', '2 in'], { type: 'unit', style: 'narrow' }); // => '5 ft 2 in'
 * formatList(new Set(['x'])); // => 'x'
 * formatList([]); // => ''
 */
export function formatList<T extends Iterable<string>>(items: T extends string ? never : T, options: FormatListOptions = {}): string {
	if (typeof items === 'string' || !isIterable(items)) throw new TypeError(`formatList: \`items\` must be an iterable of strings, got ${describe(items)}`);

	const list = Array.from(items);

	for (const item of list) {
		if (typeof item !== 'string') throw new TypeError(`formatList: every item must be a string, got ${describe(item)}`);
	}

	const { locale, type = 'conjunction', style = 'long' } = options;

	return getFormatter('list', Intl.ListFormat, locale, { type, style }, LIST_MEMO).format(list);
}

/**
 * Formats an instant via `Intl.DateTimeFormat`. Every `Intl.DateTimeFormatOptions` option passes through (`dateStyle`, `timeStyle`,
 * `hour`, `hourCycle`, …); without any style or component option `Intl` prints a numeric date.
 *
 * The time zone defaults to `'UTC'` rather than the runtime's zone so output is the same on every machine; pass `timeZone` (for the
 * viewer's zone: `Intl.DateTimeFormat().resolvedOptions().timeZone`) to format wall-clock time elsewhere. Mixing `dateStyle`/`timeStyle`
 * with component options is rejected by `Intl` with a `TypeError`, which propagates.
 * @param {DateInput} date - A `Date` or a millisecond timestamp
 * @param {FormatDateTimeOptions} [options={}] - `locale` (default `'en-US'`), `timeZone` (default `'UTC'`) and `Intl.DateTimeFormat` options
 * @returns {string} The formatted date/time
 * @throws {TypeError} when `date` is neither a `Date` nor a number, or `Intl` rejects an option combination
 * @throws {RangeError} when `date` is invalid (`NaN`, out of range), or the locale, time zone or an option is invalid
 * @example
 * const instant = Date.UTC(2024, 0, 15, 13, 45);
 * formatDateTime(instant); // => '1/15/2024'
 * formatDateTime(instant, { dateStyle: 'medium' }); // => 'Jan 15, 2024'
 * formatDateTime(new Date(instant), { dateStyle: 'full' }); // => 'Monday, January 15, 2024'
 * formatDateTime(instant, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // => '13:45'
 * formatDateTime(instant, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }); // => '22:45'
 * formatDateTime(new Date(NaN)); // throws RangeError
 */
export function formatDateTime(date: DateInput, options: FormatDateTimeOptions = {}): string {
	const time = isDate(date) ? date.getTime() : date;

	if (typeof time !== 'number') throw new TypeError(`formatDateTime: \`date\` must be a Date or a number, got ${describe(date)}`);
	// The range of `Date` (8.64e15 ms on each side of the epoch), checked without constructing one; `NaN` fails the comparison.
	if (!(Math.abs(time) <= 8.64e15)) throw new RangeError('formatDateTime: `date` must be a valid date, got Invalid Date');

	const { locale, ...rest } = options;

	rest.timeZone ??= 'UTC';

	return getFormatter('date', Intl.DateTimeFormat, locale, rest, DATE_MEMO).format(time);
}

/**
 * Formats an explicit amount of a unit relative to now (`'in 3 days'`, `'2 hours ago'`) via `Intl.RelativeTimeFormat`. Unlike
 * `getRelativeTime` from the `date` module, which picks the unit from the distance between two dates, this formats exactly the value and
 * unit you give it, with every `Intl.RelativeTimeFormat` option available (`numeric: 'auto'` for `'yesterday'`, `style: 'short'`).
 * @param {number} value - A finite amount (negative is the past)
 * @param {Intl.RelativeTimeFormatUnit} unit - `'second'`, `'minute'`, `'hour'`, `'day'`, `'week'`, `'month'`, `'quarter'` or `'year'`
 * (plural forms accepted)
 * @param {FormatRelativeTimeOptions} [options={}] - `locale` (default `'en-US'`), `numeric` (default `'always'`) and `style` (default `'long'`)
 * @returns {string} The formatted relative time
 * @throws {TypeError} when `value` is not a number
 * @throws {RangeError} when `value` is `NaN`/`±Infinity`, `unit` is not supported, or the locale or an option is invalid
 * @example
 * formatRelativeTime(3, 'day'); // => 'in 3 days'
 * formatRelativeTime(-2, 'hours'); // => '2 hours ago'
 * formatRelativeTime(-1, 'day'); // => '1 day ago'
 * formatRelativeTime(-1, 'day', { numeric: 'auto' }); // => 'yesterday'
 * formatRelativeTime(Infinity, 'day'); // throws RangeError
 */
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options: FormatRelativeTimeOptions = {}): string {
	assertFiniteNumber('formatRelativeTime', value);
	const { locale, ...rest } = options;

	return getFormatter('relative', Intl.RelativeTimeFormat, locale, rest, RELATIVE_MEMO).format(value, unit);
}

/**
 * Formats an integer as an ordinal (`'1st'`, `'22nd'`, `'1,001st'`), picking the suffix from its `Intl.PluralRules` ordinal category.
 *
 * Unlike `ordinal` from the `math` module (fixed English, plain digits), the number is formatted for the locale (grouping, digits) and
 * the suffixes are configurable per locale. `Intl` has no ordinal suffix data, so: English locales use `st`/`nd`/`rd`/`th`; any other
 * locale falls back to a trailing period (`'3.'`, correct for German, the Nordic languages, Czech, Polish, Turkish…) unless you pass
 * `suffixes` keyed by that locale's ordinal categories (e.g. French `{ one: 'er', other: 'e' }`). The suffix of a negative number is that of
 * its absolute value; `-0` is formatted as `0`.
 * @param {number} n - An integer
 * @param {FormatOrdinalOptions} [options={}] - `locale` (default `'en-US'`) and `suffixes`
 * @returns {string} The formatted ordinal
 * @throws {TypeError} when `n` is not a number
 * @throws {RangeError} when `n` is not a finite integer, or the locale is invalid
 * @example
 * formatOrdinal(1); // => '1st'
 * formatOrdinal(22); // => '22nd'
 * formatOrdinal(13); // => '13th'
 * formatOrdinal(1001); // => '1,001st'
 * formatOrdinal(3, { locale: 'de-DE' }); // => '3.'
 * formatOrdinal(1, { locale: 'fr-FR', suffixes: { one: 'er', other: 'e' } }); // => '1er'
 * formatOrdinal(2, { locale: 'fr-FR', suffixes: { one: 'er', other: 'e' } }); // => '2e'
 */
export function formatOrdinal(n: number, options: FormatOrdinalOptions = {}): string {
	assertFiniteNumber('formatOrdinal', n, 'n');
	if (!Number.isInteger(n)) throw new RangeError(`formatOrdinal: \`n\` must be an integer, got ${n}`);

	const { locale, suffixes } = options;
	const value = n === 0 ? 0 : n;
	const rules = getFormatter('plural', Intl.PluralRules, locale, { type: 'ordinal' }, ORDINAL_MEMO);
	const table = suffixes ?? (resolvedLanguage(rules) === 'en' ? ENGLISH_ORDINAL_SUFFIXES : GENERIC_ORDINAL_SUFFIXES);

	return `${formatNumber(value, { locale })}${table[rules.select(pluralSubject(value))] ?? table.other}`;
}

/**
 * The number whose plural (cardinal or ordinal) category is that of `value` as PRINTED. Above `2^53` the printed digits (the shortest
 * round-trip form, `1e23` prints as `100…000`) differ from the exact double (`99999999999999991611392`) that `Intl.PluralRules` looks
 * at, so the category is taken from a safe integer with the same last six printed digits instead (and far from the small values that
 * some locales single out, such as Italian's 8, 11, 80 and 800).
 * @param {number} value - A finite number
 * @returns {number} `value`, or a safe integer ending like it when it is an integer that is not safe
 * @example
 * pluralSubject(1e23); // => 1e15
 */
function pluralSubject(value: number): number {
	if (!Number.isInteger(value) || Number.isSafeInteger(value)) return value;

	const digits = new Intl.NumberFormat('en-US', { useGrouping: false }).format(Math.abs(value));
	return 1e15 + Number(digits.slice(-6));
}

/**
 * Returns the `Intl.PluralRules` category of a count — the key to pick the right message variant (`'one'`, `'few'`, `'other'`…).
 * Above `2^53`, the category is that of the count as {@link formatNumber} prints it (like {@link formatOrdinal}).
 * @param {number} count - A finite number
 * @param {PluralRuleOptions} [options={}] - `locale` (default `'en-US'`), `type` (`'cardinal'`, the default, or `'ordinal'`) and other
 * `Intl.PluralRules` options (`minimumFractionDigits`: `1.0` is plural in English)
 * @returns {Intl.LDMLPluralRule} The plural category
 * @throws {TypeError} when `count` is not a number
 * @throws {RangeError} when `count` is `NaN`/`±Infinity`, or the locale or an option is invalid
 * @example
 * pluralRule(1); // => 'one'
 * pluralRule(2); // => 'other'
 * pluralRule(0); // => 'other'
 * pluralRule(1, { minimumFractionDigits: 1 }); // => 'other'
 * pluralRule(3, { locale: 'ar' }); // => 'few'
 * pluralRule(2, { type: 'ordinal' }); // => 'two'
 */
export function pluralRule(count: number, options: PluralRuleOptions = {}): Intl.LDMLPluralRule {
	assertFiniteNumber('pluralRule', count, 'count');
	const { locale, ...rest } = options;

	return getFormatter('plural', Intl.PluralRules, locale, rest, PLURAL_MEMO).select(pluralSubject(count));
}
