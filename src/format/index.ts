/**
 * Locale-aware formatting helpers built on the `Intl` APIs, and {@link parseNumber}, which reads back the numbers they write.
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
 * - **Own options.** An option inherited from a polluted `Object.prototype` (`locale`, `display`, `suffixes`, an `Intl` option…) is
 *   ignored, so that it cannot change what every call formats.
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
import { describe, readOption, show } from '../utils/assert.js';

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

/**
 * What {@link parseNumber} reads: a plain number, a percentage, an amount of money or a number in compact notation.
 */
export type ParseNumberStyle = 'decimal' | 'percent' | 'currency' | 'compact';

/**
 * Options accepted by {@link parseNumber}. Any other option is ignored, so the options given to a `format*` helper can be passed as they are.
 */
export interface ParseNumberOptions {
	/** Locale(s) whose separators, signs, digits and symbols to read. Defaults to `'en-US'`. */
	locale?: LocaleInput;
	/**
	 * What the text holds, which decides the symbols accepted around the number (each one optional):
	 * - `'decimal'`: a plain number, as {@link formatNumber} writes it;
	 * - `'percent'`: a percentage, as {@link formatPercent} writes it, with or without the percent sign: the result is the ratio (`'25%'`
	 *   and `'25'` both give `0.25`);
	 * - `'currency'`: an amount, as {@link formatCurrency} writes it: a currency symbol or code (see `currency`);
	 * - `'compact'`: a number in compact notation, as {@link formatCompact} writes it (`'1.2K'`, `'3 Mio.'`, `'1.2万'`, `'2 thousand'`), with the
	 *   locale's short or long suffix.
	 * @default 'currency' when `currency` is given, 'decimal' otherwise
	 */
	style?: ParseNumberStyle;
	/**
	 * With the `'currency'` style, an ISO 4217 code (`'EUR'`): only that currency's symbol, narrow symbol, code and names (in every plural
	 * form) in the locale are accepted (`'€'`, `'EUR'`, `'euros'`). Without it, any currency sign (Unicode category Sc, with up to two capital
	 * letters before and after it, as in `US$`, `R$` or `$US`) or code of three capital letters is accepted, but not names, nor symbols made
	 * of letters only (`zł`, `kr`).
	 */
	currency?: string;
	/** The numbering system to read the digits of, as `Intl.NumberFormat` takes it (`'arab'`, `'deva'`, `'fullwide'`). Defaults to the locale's. */
	numberingSystem?: string;
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

	// `filter` skips the holes of a sparse list, as `Intl` does (a spread would turn them into `undefined`).
	const requested: string[] = typeof locale === 'string' ? [locale] : locale.filter(present);

	return requested.includes(DEFAULT_LOCALE) ? requested : [...requested, DEFAULT_LOCALE];
}

/**
 * Keeps every element (holes are not visited by `filter`).
 * @returns {boolean} Always `true`
 */
function present(): boolean {
	return true;
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
 * A null-prototype copy of the options passed to an `Intl` constructor, which reads them with plain property access: an option inherited
 * from a polluted `Object.prototype` would otherwise change the formatter without being part of its cache key (and stay cached after the
 * pollution is removed).
 * @template O - The options type
 * @param {O} options - The options (own keys only are meant)
 * @returns {O} The copy
 */
function ownOptions<O>(options: O): O {
	return Object.assign(Object.create(null) as object, options) as O;
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
 * Whether `Object.prototype` has an enumerable property: what prototype pollution adds, and what `for…in` lists on every plain object.
 * @returns {boolean} `true` when it has one
 */
function isObjectPrototypePolluted(): boolean {
	for (const key in Object.prototype) return typeof key === 'string';

	return false;
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
	// `sameOptions` lists keys with `for…in`, which also lists those planted on a polluted `Object.prototype`: they would then match
	// whether they are own options or not, so the memo is only consulted while `Object.prototype` has no enumerable key.
	if (memo.formatter !== undefined && locale === memo.locale && !isObjectPrototypePolluted() && sameOptions(options as object, memo.options, memo.size)) {
		return memo.formatter as T;
	}

	const locales = resolveLocales(locale);
	const key = cacheKey(kind, locales, options as object);

	if (key === undefined) return new Formatter(locales, ownOptions(options));

	// Created on first use: a module-level call would be kept by bundlers even when no formatter is imported.
	const cache = (formatterCache ??= createLRUCache<string, unknown>({ max: FORMATTER_CACHE_SIZE }));
	let formatter = cache.get(key) as T | undefined;

	if (formatter === undefined) {
		formatter = new Formatter(locales, ownOptions(options));
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
/** @see NUMBER_MEMO */
const PARSE_MEMO: FormatterMemo = { formatter: undefined, locale: undefined, options: {}, size: 0 };

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
	const { locale: _locale, ...rest } = options;

	return getFormatter('number', Intl.NumberFormat, readOption(options, 'locale'), rest, NUMBER_MEMO).format(value);
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
	const { locale: _locale, display: _display, ...rest } = options;

	return getFormatter(
		'number',
		Intl.NumberFormat,
		readOption(options, 'locale'),
		{ ...rest, style: 'currency', currency, currencyDisplay: readOption(options, 'display', 'symbol') },
		CURRENCY_MEMO
	).format(value);
}

/**
 * Formats a ratio as a percentage via `Intl.NumberFormat` with `style: 'percent'` (`0.256` is 25.6 %).
 * @param {number} value - A finite ratio (`1` is 100 %)
 * @param {FormatPercentOptions} [options={}] - `locale` (default `'en-US'`), `decimals` (exact fraction digits; when omitted, `Intl`'s
 * default of 0 applies unless `minimumFractionDigits`/`maximumFractionDigits` are given) and other `Intl.NumberFormat` options
 * @returns {string} The formatted percentage
 * @throws {TypeError} when `value` or `decimals` is not a number
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
	const { locale: _locale, decimals: _decimals, ...rest } = options;
	const decimals = readOption(options, 'decimals');

	if (decimals !== undefined) {
		if (typeof decimals !== 'number') throw new TypeError(`formatPercent: \`decimals\` must be a number, got ${describe(decimals)}`);
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_PERCENT_DECIMALS) {
			throw new RangeError(`formatPercent: \`decimals\` must be an integer from 0 to ${MAX_PERCENT_DECIMALS}, got ${decimals}`);
		}

		rest.minimumFractionDigits = decimals;
		rest.maximumFractionDigits = decimals;
	}

	return getFormatter('number', Intl.NumberFormat, readOption(options, 'locale'), { ...rest, style: 'percent' }, PERCENT_MEMO).format(value);
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
	const { locale: _locale, display: _display, ...rest } = options;
	const compactDisplay = readOption(options, 'display', 'short');

	return getFormatter('number', Intl.NumberFormat, readOption(options, 'locale'), { ...rest, notation: 'compact', compactDisplay }, COMPACT_MEMO).format(value);
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
	const { locale: _locale, display: _display, ...rest } = options;
	const unitDisplay = readOption(options, 'display', 'short');

	return getFormatter('number', Intl.NumberFormat, readOption(options, 'locale'), { ...rest, style: 'unit', unit, unitDisplay }, UNIT_MEMO).format(value);
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
export function formatList(items: Iterable<string> & { readonly charAt?: never }, options: FormatListOptions = {}): string {
	if (typeof items === 'string' || !isIterable(items)) throw new TypeError(`formatList: \`items\` must be an iterable of strings, got ${describe(items)}`);

	const list = Array.from(items);

	for (const item of list) {
		if (typeof item !== 'string') throw new TypeError(`formatList: every item must be a string, got ${describe(item)}`);
	}

	const type = readOption(options, 'type', 'conjunction');
	const style = readOption(options, 'style', 'long');

	return getFormatter('list', Intl.ListFormat, readOption(options, 'locale'), { type, style }, LIST_MEMO).format(list);
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
	// The intrinsic `getTime` reads the time value itself, as `Intl` does: an overridden `getTime` must not change the date.
	const time = isDate(date) ? Date.prototype.getTime.call(date) : date;

	if (typeof time !== 'number') throw new TypeError(`formatDateTime: \`date\` must be a Date or a number, got ${describe(date)}`);
	// The range of `Date` (8.64e15 ms on each side of the epoch), checked without constructing one; `NaN` fails the comparison.
	if (!(Math.abs(time) <= 8.64e15)) throw new RangeError('formatDateTime: `date` must be a valid date, got Invalid Date');

	const { locale: _locale, ...rest } = options;

	// An own `timeZone` only (an inherited one is ignored, like every other inherited option).
	if (!Object.hasOwn(rest, 'timeZone') || rest.timeZone === undefined) rest.timeZone = 'UTC';

	return getFormatter('date', Intl.DateTimeFormat, readOption(options, 'locale'), rest, DATE_MEMO).format(time);
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
 * @throws {TypeError} when `value` is not a number or `unit` is not a string
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
	assertString('formatRelativeTime', 'unit', unit);
	const { locale: _locale, ...rest } = options;

	return getFormatter('relative', Intl.RelativeTimeFormat, readOption(options, 'locale'), rest, RELATIVE_MEMO).format(value, unit);
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

	const locale = readOption(options, 'locale');
	const value = n === 0 ? 0 : n;
	const rules = getFormatter('plural', Intl.PluralRules, locale, { type: 'ordinal' }, ORDINAL_MEMO);
	const table = readOption(options, 'suffixes') ?? (resolvedLanguage(rules) === 'en' ? ENGLISH_ORDINAL_SUFFIXES : GENERIC_ORDINAL_SUFFIXES);

	// The suffix tables are read like options: a category missing from one (`one` in `{ other: '.' }`) falls back to `other`, never to a
	// suffix planted on a polluted `Object.prototype`.
	return `${formatNumber(value, { locale })}${readOption(table, rules.select(pluralSubject(value))) ?? readOption(table, 'other')}`;
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
	const { locale: _locale, ...rest } = options;

	return getFormatter('plural', Intl.PluralRules, readOption(options, 'locale'), rest, PLURAL_MEMO).select(pluralSubject(count));
}

/** The kinds of {@link Affix}, as bits (each kind may appear once around a number): a sign. */
const SIGN = 1;
/** A percent sign. */
const PERCENT = 2;
/** A currency symbol, code or name. */
const CURRENCY = 4;
/** A compact-notation suffix. */
const COMPACT = 8;
/** A currency name (which some locales write after the symbol: `'$5,00 ABD doları'` in `tr-TR`). */
const CURRENCY_NAME = 16;

/**
 * A sign, symbol or suffix that {@link parseNumber} accepts before or after the digits.
 */
interface Affix {
	/** Its text, normalized by {@link normalizeNumberText}. */
	text: string;
	/** Its kind: `SIGN`, `PERCENT`, `CURRENCY`, `CURRENCY_NAME` or `COMPACT`. */
	kind: number;
	/** Whether it makes the number negative (a minus sign). */
	negative: boolean;
	/** The power of ten it multiplies the number by (`3` for the compact suffix `K`). */
	power: number;
	/** Whether it can stand for its unit without a number (the French compact `mille` is 1000, as `formatCompact` writes it). */
	alone: boolean;
}

/** The options a {@link NumberSymbols} is built from. */
interface NumberSymbolOptions {
	/** The numbering system, when not the locale's. */
	numberingSystem?: string;
	/** The style. */
	style: ParseNumberStyle;
	/** The currency of the `'currency'` style, when known. */
	currency?: string;
}

/** Bidirectional marks that `Intl` puts around signs and symbols in right-to-left locales: invisible, so ignored. */
const BIDI_MARKS = /[\u061c\u200e\u200f]/g;

/** Horizontal whitespace (including the no-break spaces `Intl` writes), read as a space, and the typographic apostrophe, read as `'`. */
const SPACE_OR_APOSTROPHE = /[\t \u00a0\u2000-\u200a\u202f\u205f\u3000\u2019]/g;

/**
 * A currency when no `currency` is given: a code of three capital letters, or a currency sign with at most two capital letters before
 * and after it (`US$`, `$US`, `£GB`). Linear: each part is bounded.
 */
const ANY_CURRENCY = /[A-Z]{3}|[A-Z]{0,2}\p{Sc}[A-Z]{0,2}/uy;

/** Counts whose plural forms cover those of every locale (`one`, `two`, `few`, `many`, `other`, fractions), for currency names. */
const PLURAL_SAMPLES: ReadonlyArray<number> = [0, 1, 2, 3, 5, 11, 100, 1.5];

/**
 * Normalizes text for {@link parseNumber}: removes bidirectional marks, and turns every horizontal space into U+0020 and `’` into `'`.
 * @param {string} text - The text
 * @returns {string} The normalized text
 */
function normalizeNumberText(text: string): string {
	return text.replace(BIDI_MARKS, '').replace(SPACE_OR_APOSTROPHE, function (char: string): string {
		return char === '\u2019' ? "'" : ' ';
	});
}

/**
 * The symbols of a locale that {@link parseNumber} reads, all derived from `Intl.NumberFormat`. Built once per locale and options, and
 * cached with the formatters.
 */
class NumberSymbols {
	/** The value of each digit, by code point: the locale's digits are 0 to 9, ASCII digits (when the locale has others) 10 to 19. */
	readonly digits = new Map<number, number>();
	/** The grouping separator (`''` when the locale does not group digits). */
	readonly group: string = '';
	/**
	 * The ways the style groups digits, as pairs: the size of the group next to the decimal separator (3), then the size of the others (3,
	 * or 2 in Indian grouping: `12,34,567`).
	 */
	readonly groupings: number[] = [];
	/** The decimal separator. */
	readonly decimal: string = '';
	/** The exponent separators (`E` and `e`, or the locale's, such as `×10^`). */
	readonly exponents: string[];
	/** The signs and symbols accepted around the number, longest first. */
	readonly affixes: Affix[] = [];
	/** Whether any currency sign or code is accepted (the `'currency'` style without `currency`). */
	readonly anyCurrency: boolean;
	/** The power of ten the number is multiplied by: `-2` for the `'percent'` style, `0` otherwise. */
	readonly power: number;

	/**
	 * Reads the symbols of a locale.
	 * @param {string[]} locales - The resolved locale list
	 * @param {NumberSymbolOptions} options - The numbering system, style and currency
	 */
	constructor(locales: string[], options: NumberSymbolOptions) {
		const { numberingSystem, style, currency } = options;
		// The style's own separators and grouping, which can differ from those of plain numbers (`de-AT` groups amounts with `.`, numbers
		// with a space; `mr-IN` groups amounts by threes, numbers the Indian way), and even between the ways of writing an amount.
		const main: Intl.NumberFormatOptions = { numberingSystem, minimumFractionDigits: 1, maximumFractionDigits: 1 };
		const variants = [main];
		let integers = '';
		let exponent = 'E';

		if (style === 'percent') main.style = 'percent';
		if (style === 'currency') {
			main.style = 'currency';
			main.currency = currency ?? 'USD';
			variants.push({ ...main, currencySign: 'accounting' }, { ...main, currencyDisplay: 'name' });
		}
		// Plain numbers last, whose integer digits are the digits 1 to 9, then 0.
		const plain = { numberingSystem };
		variants.push(plain);

		for (const variant of variants) {
			const sizes: number[] = [];

			for (const { type, value } of new Intl.NumberFormat(locales, variant).formatToParts(-1234567890.5)) {
				if (type === 'integer') {
					if (variant === plain) integers += value;
					sizes.push(Array.from(value).length);
				} else if (variant !== main) continue;
				else if (type === 'group') this.group = normalizeNumberText(value);
				else if (type === 'decimal') this.decimal = normalizeNumberText(value);
				else if (type === 'minusSign') this.add(value, SIGN, true);
			}

			this.groupings.push(sizes[sizes.length - 1], sizes[sizes.length - 2]);
		}

		for (const { type, value } of new Intl.NumberFormat(locales, { numberingSystem, style: 'percent', notation: 'scientific', signDisplay: 'always' }).formatToParts(1)) {
			if (type === 'plusSign') this.add(value, SIGN, false);
			else if (type === 'exponentSeparator') exponent = normalizeNumberText(value);
			else if (type === 'percentSign' && style === 'percent') this.add(value, PERCENT, false);
		}

		for (let digit = 0; digit < 10; digit++) this.digits.set(48 + digit, digit + 10);
		Array.from(integers).forEach(function (this: NumberSymbols, char: string, index: number): void {
			this.digits.set(char.codePointAt(0) as number, (index + 1) % 10);
		}, this);
		this.exponents = exponent === 'E' ? ['E', 'e'] : [exponent];
		this.add('-', SIGN, true);
		this.add('\u2212', SIGN, true);
		this.add('+', SIGN, false);
		if (style === 'percent') this.add('%', PERCENT, false);
		this.power = style === 'percent' ? -2 : 0;
		this.anyCurrency = style === 'currency' && currency === undefined;

		if (style === 'currency' && currency !== undefined) {
			for (const currencyDisplay of ['symbol', 'narrowSymbol', 'code', 'name'] as const) {
				const formatter = new Intl.NumberFormat(locales, {
					numberingSystem,
					style: 'currency',
					currency,
					currencyDisplay,
					minimumFractionDigits: 0,
					maximumFractionDigits: 1
				});
				for (const sample of PLURAL_SAMPLES) {
					for (const { type, value } of formatter.formatToParts(sample))
						if (type === 'currency') this.add(value, currencyDisplay === 'name' ? CURRENCY_NAME : CURRENCY, false);
				}
			}
		}

		if (style === 'compact') {
			for (const compactDisplay of ['short', 'long'] as const) {
				const formatter = new Intl.NumberFormat(locales, { numberingSystem, notation: 'compact', compactDisplay });
				for (let power = 3; power < 21; power++) {
					for (const sample of [1, 2, 5, 1.5]) {
						let digits = 0;
						let suffix = '';
						for (const { type, value } of formatter.formatToParts(sample * 10 ** power)) {
							if (type === 'integer') digits += Array.from(value).length;
							else if (type === 'compact') suffix = value;
						}
						// The value has `power + 1` integer digits: those not written are the suffix's power of ten (`1.5K` and `15K`: 3). A
						// suffix written without digits stands for `10 ** power` on its own (`mille` in French, for 1000 exactly).
						this.add(suffix, COMPACT, false, digits === 0 ? power : power + 1 - digits, digits === 0);
					}
				}
			}
		}

		this.affixes.sort(function (a: Affix, b: Affix): number {
			return b.text.length - a.text.length;
		});
	}

	/**
	 * Adds an affix, unless it is empty or already known.
	 * @param {string} text - Its text, as `Intl` writes it
	 * @param {number} kind - Its kind
	 * @param {boolean} negative - Whether it is a minus sign
	 * @param {number} [power=0] - The power of ten it multiplies the number by
	 * @param {boolean} [alone=false] - Whether it can stand without a number
	 * @returns {void}
	 */
	add(text: string, kind: number, negative: boolean, power: number = 0, alone: boolean = false): void {
		const normalized = normalizeNumberText(text).trim();
		const known = this.affixes.some(function (affix: Affix): boolean {
			return affix.text === normalized;
		});

		if (normalized !== '' && !known) this.affixes.push({ text: normalized, kind, negative, power, alone });
	}
}

/**
 * What {@link parseNumber} has read so far.
 */
interface NumberScan {
	/** The ASCII forms of the digits: the integer digits, then the fraction digits, then the exponent digits. */
	digits: string;
	/** Their numbering system: `-1` before the first digit, `0` the locale's, `1` ASCII, `2` both (which is invalid). */
	system: number;
	/** The kinds of the affixes read (each may appear once). */
	seen: number;
	/** Whether a minus sign (or parentheses) was read. */
	negative: boolean;
	/** The power of ten to multiply the number by. */
	power: number;
	/** Whether an affix that can stand without a number was read. */
	alone: boolean;
}

/**
 * Reads the run of digits at `index`.
 * @param {NumberSymbols} symbols - The locale's symbols
 * @param {string} text - The text
 * @param {number} index - Where the run starts
 * @param {NumberScan} scan - What was read so far; the digits of the run are appended
 * @returns {number} The index after the run
 */
function scanDigits(symbols: NumberSymbols, text: string, index: number, scan: NumberScan): number {
	for (;;) {
		const code = text.codePointAt(index);
		const value = code === undefined ? undefined : symbols.digits.get(code);

		if (value === undefined) return index;

		const system = value < 10 ? 0 : 1;

		if (scan.system !== system) scan.system = scan.system < 0 ? system : 2;
		scan.digits += value % 10;
		index += (code as number) > 0xffff ? 2 : 1;
	}
}

/**
 * Finds the affix at `index` (the longest one, when several match).
 * @param {NumberSymbols} symbols - The locale's symbols
 * @param {string} text - The text
 * @param {number} index - Where the affix would start
 * @returns {Affix | undefined} The affix, or `undefined` when none is there
 */
function matchAffix(symbols: NumberSymbols, text: string, index: number): Affix | undefined {
	for (const affix of symbols.affixes) if (text.startsWith(affix.text, index)) return affix;

	if (symbols.anyCurrency) {
		ANY_CURRENCY.lastIndex = index;
		const match = ANY_CURRENCY.exec(text);

		if (match !== null) return { text: match[0], kind: CURRENCY, negative: false, power: 0, alone: false };
	}

	return undefined;
}

/**
 * Reads the affixes (and spaces) at `index`: up to the end of the text, or, before the digits, up to the first digit or a decimal
 * separator followed by a digit.
 * @param {NumberSymbols} symbols - The locale's symbols
 * @param {string} text - The text
 * @param {number} index - Where to start
 * @param {NumberScan} scan - What was read so far, updated with the affixes
 * @returns {number} The index after the affixes, or `-1` when something else is there, or an affix of a kind already read
 */
function scanAffixes(symbols: NumberSymbols, text: string, index: number, scan: NumberScan): number {
	const leading = scan.digits === '';

	while (index < text.length) {
		if (text[index] === ' ') {
			index++;
			continue;
		}
		if (
			leading &&
			(symbols.digits.has(text.codePointAt(index) as number) ||
				(text.startsWith(symbols.decimal, index) && symbols.digits.has(text.codePointAt(index + symbols.decimal.length) as number)))
		)
			break;

		const affix = matchAffix(symbols, text, index);

		if (affix === undefined || (scan.seen & affix.kind) !== 0) return -1;
		scan.seen |= affix.kind;
		scan.negative ||= affix.negative;
		scan.power += affix.power;
		scan.alone ||= affix.alone;
		index += affix.text.length;
	}

	return index;
}

/**
 * Tells whether the digits are grouped as the locale groups them (in one of its ways): the group next to the decimal separator has the
 * primary size, the others the secondary size, except the first, which may be shorter but does not start with `0`.
 * @param {NumberSymbols} symbols - The locale's symbols
 * @param {readonly number[]} runs - The sizes of the groups, at least two
 * @param {string} digits - The integer digits
 * @returns {boolean} Whether the grouping is valid
 */
function validGroups(symbols: NumberSymbols, runs: readonly number[], digits: string): boolean {
	const groupings = symbols.groupings;
	const last = runs.length - 1;

	for (let pair = 0; pair < groupings.length; pair += 2) {
		const secondary = groupings[pair + 1];
		let valid = digits[0] !== '0' && runs[0] <= secondary && runs[last] === groupings[pair];

		for (let i = 1; i < last; i++) valid &&= runs[i] === secondary;
		if (valid) return true;
	}

	return false;
}

/**
 * Reads a number written with a locale's symbols (see {@link parseNumber}): affixes, the integer digits (in groups), the fraction digits,
 * the exponent, then affixes.
 * @param {NumberSymbols} symbols - The locale's symbols
 * @param {string} input - The normalized, trimmed text
 * @returns {number} The number, or `NaN` when the text is not one
 */
function readNumber(symbols: NumberSymbols, input: string): number {
	// Accounting notation: an amount in parentheses is negative (and has no other sign).
	const accounting = input.startsWith('(') && input.endsWith(')');
	const text = accounting ? input.slice(1, -1) : input;
	const scan: NumberScan = { digits: '', system: -1, seen: accounting ? SIGN : 0, negative: accounting, power: symbols.power, alone: false };
	let index = scanAffixes(symbols, text, 0, scan);

	if (index < 0) return NaN;

	// The integer digits, in groups. A separator not followed by a digit ends them (as the space before `€` in `fr-FR`), and so does a
	// locale without a separator (`''`), since the run before it was read whole.
	index = scanDigits(symbols, text, index, scan);
	const runs = [scan.digits.length];

	while (text.startsWith(symbols.group, index)) {
		const before = scan.digits.length;
		const next = scanDigits(symbols, text, index + symbols.group.length, scan);

		if (scan.digits.length === before) break;
		runs.push(scan.digits.length - before);
		index = next;
	}

	let integer = scan.digits.length;

	if (runs.length > 1 && !validGroups(symbols, runs, scan.digits)) return NaN;

	// The fraction digits.
	if (text.startsWith(symbols.decimal, index)) {
		const next = scanDigits(symbols, text, index + symbols.decimal.length, scan);

		if (scan.digits.length > integer) index = next;
	}

	// No digits: the text is only affixes, which is a number only when one of them stands for its unit (`'mille'`).
	if (scan.digits === '') {
		if (!scan.alone) return NaN;
		scan.digits = '1';
		integer = 1;
	}

	const fraction = scan.digits.length;
	let exponent = '';

	// The exponent, with an optional sign. A separator not followed by digits is not one (the `E` of `'1EUR'`).
	for (const separator of symbols.exponents) {
		if (!text.startsWith(separator, index)) continue;

		const sign = matchAffix(symbols, text, index + separator.length);
		const signed = sign !== undefined && sign.kind === SIGN;
		const next = scanDigits(symbols, text, index + separator.length + (signed ? sign.text.length : 0), scan);

		if (scan.digits.length > fraction) {
			exponent = (signed && sign.negative ? '-' : '') + scan.digits.slice(fraction);
			index = next;
		}
		break;
	}

	if (scanAffixes(symbols, text, index, scan) < 0 || scan.system > 1) return NaN;

	const digits = scan.digits;
	// An exponent of more than 15 significant digits is beyond what the digits of any string can make up for: the number is a zero
	// when the exponent is negative or the digits are all zeros, and out of range otherwise. Deciding it here keeps the cost linear,
	// where converting such an exponent to a bigint is not.
	const significant = exponent.replace(/^-?0*/, '');

	if (significant.length > 15) return exponent.startsWith('-') || !/[1-9]/.test(digits.slice(0, fraction)) ? (scan.negative ? -0 : 0) : NaN;

	// Otherwise the exponent and the power of the affixes add up exactly, and the decimal is converted once, so the result is the double
	// nearest to the decimal written.
	const value = Number(`${scan.negative ? '-' : ''}${digits.slice(0, integer) || 0}.${digits.slice(integer, fraction)}0e${Number(exponent) + scan.power}`);

	return Number.isFinite(value) ? value : NaN;
}

/**
 * Parses a number written for a locale: the inverse of {@link formatNumber}, {@link formatPercent}, {@link formatCurrency} and
 * {@link formatCompact}. The locale's grouping and decimal separators, signs, digits (Arabic-Indic, Devanagari, full-width…), exponent
 * separator, percent sign, currency symbols and names and compact suffixes are all read from `Intl.NumberFormat` (once per locale and
 * options: they are cached like the formatters), for the style at hand, since they can differ between plain numbers and amounts (`de-AT`
 * groups amounts with `.` and numbers with a space). So a number formatted by this module parses back, with the same options and the
 * matching `style`, to its value as printed (rounded to the digits shown): `parseNumber(formatNumber(n, options), options)`,
 * `parseNumber(formatCurrency(n, 'EUR', options), { ...options, currency: 'EUR' })`. The exceptions come from the locale data: a few
 * compact abbreviations stand for two powers of ten (Bengali, Nepali), and Burmese writes large compact numbers between two words, which are
 * not read.
 *
 * Strict, like `toNumber` from the strings module: text that is not exactly one number in the locale's notation gives `NaN` rather than a
 * guess. Grouping separators are optional, but when present they must all be in place (`'1,234,567'`, or `'12,34,567'` in `hi-IN`;
 * `'1,23'` and `'12,345,6'` are `NaN`), so that a number written for another locale is not misread; there may be one decimal separator, one
 * sign, one symbol of each kind and nothing else (`'1.2.3'` and `'12px'` are `NaN`). Within those rules, input is accepted where it is
 * unambiguous:
 * - Surrounding whitespace is ignored, and any space (U+0020, the no-break spaces U+00A0 and U+202F that `Intl` writes…) stands for a
 *   space grouping separator (`fr-FR`, `pl-PL`); `'` and `’` stand for each other (`de-CH`). The invisible bidirectional marks that `Intl`
 *   writes in right-to-left locales are ignored.
 * - ASCII digits are accepted in every locale, as are the locale's own (or `numberingSystem`'s), but not both in one number.
 * - `-`, `−` (U+2212) and the locale's minus sign, and `+` and the locale's plus sign, are signs, before or after the number and its symbols,
 *   and an amount in parentheses is negative (accounting notation: `'($1,234.50)'`).
 * - The locale's exponent separator is read (`'1.5E3'`; `e` too), as `formatNumber` writes it with `notation: 'scientific'`.
 *
 * The result is the double nearest to the decimal written, converted once (`'30%'` is `0.3`, not `30 / 100`, which is
 * `0.30000000000000004`). `'-0'` is `-0`. Text that does not hold a finite number (including `'Infinity'` and values beyond
 * `Number.MAX_VALUE`) gives `NaN`; text that is not a string, and invalid options, throw. The cost is linear in the length of the text,
 * whatever it holds.
 * @param {string} text - The text to parse
 * @param {ParseNumberOptions} [options={}] - `locale` (default `'en-US'`), `style` (default `'decimal'`, or `'currency'` with `currency`),
 * `currency` and `numberingSystem`; other options are ignored
 * @returns {number} The number, or `NaN` when `text` is not one number in the locale's notation
 * @throws {TypeError} when `text` or `currency` is not a string
 * @throws {RangeError} when `style` is not a style, or the locale, numbering system or currency code is malformed
 * @example
 * parseNumber('1,234.5'); // => 1234.5
 * parseNumber('1.234,5', { locale: 'de-DE' }); // => 1234.5
 * parseNumber('1 234,5', { locale: 'fr-FR' }); // => 1234.5
 * parseNumber("1'234.5", { locale: 'de-CH' }); // => 1234.5
 * parseNumber('12,34,567', { locale: 'hi-IN' }); // => 1234567
 * parseNumber('١٬٢٣٤٫٥', { locale: 'ar-EG' }); // => 1234.5
 * parseNumber('25.6%', { style: 'percent' }); // => 0.256
 * parseNumber('($1,234.50)', { style: 'currency' }); // => -1234.5
 * parseNumber('-1.234,50 €', { locale: 'de-DE', currency: 'EUR' }); // => -1234.5
 * parseNumber('1.2K', { style: 'compact' }); // => 1200
 * parseNumber(formatNumber(-1234.5678, { locale: 'ar-EG' }), { locale: 'ar-EG' }); // => -1234.568
 * parseNumber('1.234'); // => 1.234 // en-US: a decimal separator
 * parseNumber('1,23'); // => NaN
 * parseNumber('12px'); // => NaN
 */
export function parseNumber(text: string, options: ParseNumberOptions = {}): number {
	if (typeof text !== 'string') throw new TypeError(`parseNumber: \`text\` must be a string, got ${describe(text)}`);

	const currency = readOption(options, 'currency');
	const style = readOption(options, 'style', currency === undefined ? 'decimal' : 'currency');

	if (style !== 'decimal' && style !== 'percent' && style !== 'currency' && style !== 'compact') {
		throw new RangeError(`parseNumber: \`style\` must be 'decimal', 'percent', 'currency' or 'compact', got ${show(style)}`);
	}
	if (currency !== undefined) assertString('parseNumber', 'currency', currency);

	const symbolOptions: NumberSymbolOptions = { numberingSystem: readOption(options, 'numberingSystem'), style, currency: style === 'currency' ? currency : undefined };

	return readNumber(getFormatter('parse', NumberSymbols, readOption(options, 'locale'), symbolOptions, PARSE_MEMO), normalizeNumberText(text).trim());
}
