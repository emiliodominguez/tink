import { daysInMonth } from '../date/index.js';
import {
	explain,
	isDate,
	isMap,
	isPlainObject,
	ValidationError,
	type Guard,
	type JsonValue,
	type SchemaIssue,
	type StandardSchemaResult,
	type StandardSchemaV1
} from '../guards/index.js';
import { describe, readOption, show } from '../utils/assert.js';
import type { AnyFunction } from '../utils/index.js';
import { generate } from '../utils/jit.js';
import { hold, isTooDeep, PENDING, release, scope } from '../utils/memo.js';
import { guardScore } from '../utils/score.js';

/**
 * Options accepted by {@link isUrl}. A polluted `Object.prototype` cannot set one.
 */
export interface IsUrlOptions {
	/** Allowed schemes, compared case-insensitively, with or without the trailing `:` (e.g. `'https'` or `'https:'`). Defaults to `['http', 'https']`. */
	readonly protocols?: ReadonlyArray<string>;
	/** Require the host to be a domain name ending in a top-level domain (`example.com`, not `localhost` or an IP address). Defaults to `false`. */
	readonly requireTld?: boolean;
}

/**
 * A UUID version accepted by {@link isUuid}: `1`–`8` (RFC 9562 versions), `'nil'` (all zeros) or `'max'` (all `f`).
 */
export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'nil' | 'max';

/**
 * Options accepted by {@link isHexColor}. A polluted `Object.prototype` cannot set one.
 */
export interface IsHexColorOptions {
	/** Accept the 4 and 8 digit forms with an alpha channel (`#rgba`, `#rrggbbaa`). Defaults to `true`. */
	readonly alpha?: boolean;
}

/**
 * A semantic version split into its parts, as returned by {@link parseSemver}.
 */
export interface SemVer {
	/** The major version. */
	major: number;
	/** The minor version. */
	minor: number;
	/** The patch version. */
	patch: number;
	/** Pre-release identifiers: numeric identifiers are numbers (strings when above `Number.MAX_SAFE_INTEGER`), the others strings. Empty for releases. */
	prerelease: (string | number)[];
	/** Build metadata identifiers (empty when there is none). */
	build: string[];
}

/**
 * Options accepted by {@link satisfiesSemver}, {@link compileSemverRange}, {@link isSemverRange}, {@link maxSatisfyingSemver} and
 * {@link minSatisfyingSemver}.
 */
export interface SemverRangeOptions {
	/**
	 * Let a pre-release version satisfy a range like any other version. By default (as in npm and node-semver) a pre-release only
	 * satisfies a comparator set that names a pre-release of the same `major.minor.patch`: `1.3.0-beta` does not satisfy `^1.2.0`, while
	 * `1.2.0-rc.2` satisfies `^1.2.0-rc.1`. Defaults to `false`.
	 */
	readonly includePrerelease?: boolean;
}

/** The kinds of increment applied by {@link incrementSemver} (node-semver's `ReleaseType`). */
export type SemverRelease = 'major' | 'minor' | 'patch' | 'premajor' | 'preminor' | 'prepatch' | 'prerelease' | 'release';

/**
 * Options accepted by {@link incrementSemver}.
 */
export interface IncrementSemverOptions {
	/** The pre-release identifier(s) to use, such as `'beta'` or `'rc.dev'` (dot-separated pre-release identifiers). An empty string counts as none. */
	readonly identifier?: string;
	/** The number a new pre-release counter starts at: `'0'` (the default) or `'1'`; `false` appends no counter to `identifier`. */
	readonly identifierBase?: '0' | '1' | false;
}

/**
 * How {@link isBase64} treats `=` padding: allowed but not needed, mandatory, or not allowed.
 */
export type Base64Padding = 'optional' | 'required' | 'forbidden';

/**
 * Options accepted by {@link isBase64}.
 */
export interface IsBase64Options {
	/** Use the URL-safe alphabet (`-` and `_` instead of `+` and `/`, RFC 4648 §5). Defaults to `false`. */
	readonly urlSafe?: boolean;
	/** How `=` padding is treated. Defaults to `'optional'`. */
	readonly padding?: Base64Padding;
}

/** The part of a parsed URL that {@link isUrl} reads. */
interface UrlRecord {
	readonly hostname: string;
}

/** The `URL` constructor, typed structurally so that no DOM types are needed. */
type UrlConstructor = (new (input: string) => UrlRecord) & { readonly canParse?: (input: string) => boolean };

/** WHATWG HTML "valid email address" grammar (the one behind `<input type=email>`). Each label is limited to 63 characters. */
const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * Any control character or white space (which the URL parser silently strips or percent-encodes), format character (`\p{Cf}`: soft hyphen,
 * zero-width space, bidi controls...) or other default-ignorable code point (combining grapheme joiner, variation selectors...): IDNA
 * deletes these from host names, and they are invisible elsewhere.
 */
const URL_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\s]/u;

/** The authority of a `scheme://` URL, read from the `//` the way RFC 3986 parsers do: up to the first `/`, `?` or `#`. */
const AUTHORITY_PATTERN = /[^/?#]*/y;

/** An empty label (a leading dot or two consecutive dots), `%` (the URL parser percent-decodes hosts), or a full stop that IDNA maps to `.`. */
const INVALID_HOST_PATTERN = /^\.|\.\.|[%\u3002\uff0e\uff61]/;

/** Any non-ASCII character. */
const NON_ASCII_PATTERN = /[^\0-\x7f]/;

/** A host whose last label (before an optional trailing dot) makes the WHATWG parser read it as an IPv4 address (decimal or `0x` hex). */
const NUMERIC_HOST_PATTERN = /(?:^|\.)(?:[0-9]+|0x[0-9a-f]*)\.?$/i;

/** Schemes the URL parser treats as "special": it accepts them without `//` (`http:example.com`) and with extra slashes. */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);

/** A top-level domain: ASCII letters, or an IDNA (punycode) label. Case-insensitive: the URL parser only lower-cases the hosts of special schemes. */
const TLD_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

/** An RFC 9562 UUID of versions 1–8 with the RFC variant (`10xx`); the version digit is at index 14. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The nil UUID (RFC 9562 §5.9). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The max UUID (RFC 9562 §5.10), lower-cased. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** A dotted-decimal IPv4 address: four decimal octets in `[0, 255]`, without leading zeros. */
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;

/** CSS hex colour with an optional alpha channel. */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** CSS hex colour without an alpha channel. */
const OPAQUE_HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The official semver.org 2.0.0 regular expression (numbered groups: major, minor, patch, pre-release, build), with the identifiers
 * checked apart (see {@link matchSemver}): its repeated group of identifiers overflowed the regular expression backtracking stack on
 * a few million of them, so that a long string made {@link isSemver} throw. A literal, not `new RegExp(...)`: bundlers keep a
 * module-level constructor call, even in bundles that never read a version.
 */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** An empty identifier (a leading, trailing or doubled dot), or, with `0\d+` matched, a numeric pre-release identifier with a leading zero. */
const BAD_IDENTIFIER = /(?:^|\.)(?:0\d+)?(?:\.|$)/;

/** An empty identifier: a leading, trailing or doubled dot. */
const EMPTY_IDENTIFIER = /(?:^|\.)(?:\.|$)/;

/** A string of ASCII digits. */
const DIGITS_PATTERN = /^[0-9]+$/;

/** RFC 3339 `full-date`; captures the year, month and day. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** RFC 3339 `date-time` (seconds required) with hours `00`–`23` and minutes/seconds `00`–`59` (offset included); captures the year, month and day. */
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Card digits, optionally separated by single spaces or dashes. */
const CARD_PATTERN = /^[0-9](?:[ -]?[0-9])*$/;

/** Base64 (RFC 4648 §4) body and padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base64url (RFC 4648 §5) body and padding. */
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

/**
 * A lowercase ASCII slug, as produced by `toSlug` from the strings module: no leading, trailing or doubled hyphen. Without a repeated
 * group (`[a-z0-9]+(?:-[a-z0-9]+)*`), which overflowed the regular expression backtracking stack on a few million hyphens.
 */
const SLUG_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]+(?<!-)$/;

/** Decimal number syntax: optional sign, digits with an optional fraction (or a bare fraction), optional exponent. */
const NUMERIC_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/**
 * Checks whether a value is an email address, using the WHATWG HTML "valid email address" grammar
 * (the one browsers apply to `<input type="email">`) plus the usual length limits: at most 64 characters before the `@`,
 * 254 characters in total and 63 characters per domain label.
 *
 * This is a pragmatic check, not RFC 5322: quoted local parts (`"a b"@x.com`), comments, IP-literal domains (`a@[127.0.0.1]`)
 * and non-ASCII addresses are rejected, while dotless domains (`user@localhost`) and dots anywhere in the local part are accepted.
 *
 * A valid address is not a safe string: the local part may contain shell, SQL, HTML-attribute and template metacharacters
 * (`` ` ``, `|`, `'`, `$`, `{`, `}`, `&`, `=`, `#`, `%`...), e.g. `'{{7*7}}@x.com'` and ``"`id`@x.com"`` are valid. Escape or parameterize it
 * for its destination (never interpolate it into a shell command, query or template).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a valid email address
 * @example
 * isEmail('jane.doe+news@example.co.uk'); // => true
 * isEmail('user@localhost'); // => true
 * isEmail('not an email'); // => false
 * isEmail('a@b@c.com'); // => false
 * isEmail(42); // => false
 * isEmail("a'||'1'='1@x.com"); // => true
 */
export function isEmail(value: unknown): value is string {
	// The length check runs first, so the pattern never sees more than 254 characters.
	return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value) && value.indexOf('@') <= 64;
}

/**
 * Returns `globalThis.URL`.
 * @returns {UrlConstructor} The URL constructor
 * @throws {Error} when `globalThis.URL` is not available
 */
function getUrlConstructor(): UrlConstructor {
	const candidate = (globalThis as unknown as { URL?: unknown }).URL;
	if (typeof candidate !== 'function') throw new Error('isUrl: globalThis.URL is not available in this environment');
	return candidate as UrlConstructor;
}

/**
 * Checks whether a host name ends in a top-level domain (a single trailing dot is allowed) and has no empty label.
 * @param {string} hostname - The host name, as returned by the URL parser (lowercase and punycode for special schemes, as written otherwise)
 * @returns {boolean} `true` when there is at least one label before an alphabetic or punycode TLD
 */
function hasTld(hostname: string): boolean {
	const labels = (hostname.endsWith('.') ? hostname.slice(0, -1) : hostname).split('.');
	return labels.length > 1 && TLD_PATTERN.test(labels[labels.length - 1]);
}

/**
 * Reads the host written in a URL authority, checking that the URL parser will use that host (up to letter case and IDNA encoding).
 * @param {string} authority - The text between `//` and the first `/`, `?` or `#`
 * @returns {string | undefined} The host name (after the last `@`, before the port; `''` for IP literals such as `[::1]`, which the parser
 * validates, and for empty hosts), or `undefined` when the authority holds a backslash (a delimiter for the WHATWG parser, but not for
 * RFC 3986 ones), or the host name has an empty label, a `%`, a character that NFKC normalization changes (fullwidth and circled letters,
 * ...) or an ideographic full stop, or is numeric but not dotted-decimal IPv4 (`0x7f.1`, `2130706433`)
 */
function writtenHost(authority: string): string | undefined {
	if (authority.includes('\\')) return undefined;

	const start = authority.lastIndexOf('@') + 1;
	if (authority[start] === '[') return '';
	const portStart = authority.indexOf(':', start);
	const host = authority.slice(start, portStart < 0 ? authority.length : portStart);
	// Empty hosts are allowed by some schemes (`file:///path`); the parser rejects them for the others. One trailing dot is allowed.
	if (INVALID_HOST_PATTERN.test(host) || (NUMERIC_HOST_PATTERN.test(host) && !isIPv4(host))) return undefined;

	return NON_ASCII_PATTERN.test(host) && host.normalize('NFKC') !== host ? undefined : host;
}

/**
 * Checks that every label of an internationalized host name stays one after IDNA processing: the ASCII labels are only lower-cased, and the
 * others become punycode (`xn--`) labels, not ASCII ones (before UTS #46 15.1, IDNA case folding maps `ẞ` to `ss`).
 * @param {string} host - The host as written
 * @param {string} hostname - The host as parsed
 * @returns {boolean} `true` when the labels correspond one to one
 */
function isEncodingOf(host: string, hostname: string): boolean {
	// The labels are walked in place: splitting both names costs more than the checks.
	let start = 0;
	let parsedStart = 0;

	for (;;) {
		const dot = host.indexOf('.', start);
		const parsedDot = hostname.indexOf('.', parsedStart);
		const end = dot < 0 ? host.length : dot;
		const parsedEnd = parsedDot < 0 ? hostname.length : parsedDot;
		const label = host.slice(start, end);

		if (NON_ASCII_PATTERN.test(label) ? !hostname.startsWith('xn--', parsedStart) : hostname.slice(parsedStart, parsedEnd) !== label.toLowerCase()) return false;
		if (dot < 0 || parsedDot < 0) return dot < 0 && parsedDot < 0;
		start = dot + 1;
		parsedStart = parsedDot + 1;
	}
}

/** A host label that the URL parser reads as a number (decimal, or `0x` hex), making the host an IPv4 address. */
const NUMERIC_LABEL_PATTERN = /^(?:[0-9]+|0x[0-9a-f]*)$/i;

/** The `URL` constructor of the runtime when this module loaded: {@link isPlainWebUrl} assumes its WHATWG behaviour. */
const NATIVE_URL: unknown = (globalThis as unknown as { URL?: unknown }).URL;

/**
 * Whether the character code is an ASCII letter, digit or hyphen: the characters of a plain host label.
 * @param {number} code - A UTF-16 code unit (`NaN` past the end of a string)
 * @returns {boolean} Whether it is `[A-Za-z0-9-]`
 */
function isLabelCharacter(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45;
}

/**
 * Recognises the plainest web URLs without the URL parser (about three times faster): `http://` or `https://` in any case, a host of
 * non-empty dot-separated labels of ASCII letters, digits and hyphens, none starting with `xn--` (decoded as punycode) and the last
 * not a number (which the parser reads as IPv4: `127.1`, `0x7f`), no credentials, an optional port of up to 5 digits and at most
 * 65535, then nothing or a path, query or fragment of printable ASCII. Every such string is a URL the full check of {@link isUrl}
 * accepts, with the host as written; `false` only means "not this plain", and the full check decides.
 * @param {string} value - The candidate URL
 * @param {boolean} requireTld - Whether the host must end in a top-level domain (`isUrl`'s `requireTld`)
 * @returns {boolean} `true` when `value` is a plain web URL meeting `requireTld`
 */
function isPlainWebUrl(value: string, requireTld: boolean): boolean {
	// `| 32` lower-cases ASCII letters, and maps no other character onto `h`, `t`, `p`, `s` or `x`, `n`.
	if ((value.charCodeAt(0) | 32) !== 104 || (value.charCodeAt(1) | 32) !== 116 || (value.charCodeAt(2) | 32) !== 116 || (value.charCodeAt(3) | 32) !== 112) {
		return false;
	}

	let index = (value.charCodeAt(4) | 32) === 115 ? 5 : 4;

	if (value.charCodeAt(index) !== 58 || value.charCodeAt(index + 1) !== 47 || value.charCodeAt(index + 2) !== 47) return false;
	index += 3;

	let labels = 0;
	let labelStart = index;

	for (;;) {
		const code = value.charCodeAt(index);

		if (isLabelCharacter(code)) {
			index++;
			continue;
		}
		if (index === labelStart) return false;
		if (
			(value.charCodeAt(labelStart) | 32) === 120 &&
			(value.charCodeAt(labelStart + 1) | 32) === 110 &&
			value.charCodeAt(labelStart + 2) === 45 &&
			value.charCodeAt(labelStart + 3) === 45
		) {
			return false;
		}
		labels++;
		if (code !== 46) break;
		labelStart = ++index;
	}

	// The last label, which must not be a number: all digits, or `0x` followed by hex digits.
	const last = value.slice(labelStart, index);

	if (NUMERIC_LABEL_PATTERN.test(last)) return false;
	if (requireTld && (labels < 2 || !TLD_PATTERN.test(last))) return false;
	if (value.charCodeAt(index) === 58) {
		const portStart = ++index;
		let port = 0;

		for (let code = value.charCodeAt(index); code >= 48 && code <= 57; code = value.charCodeAt(++index)) port = port * 10 + code - 48;
		if (index === portStart || index - portStart > 5 || port > 65535) return false;
	}
	if (index === value.length) return true;

	const delimiter = value.charCodeAt(index);

	if (delimiter !== 47 && delimiter !== 63 && delimiter !== 35) return false;
	// The path, query and fragment: the parser percent-encodes whatever needs it, and never fails on printable ASCII.
	for (index++; index < value.length; index++) {
		const code = value.charCodeAt(index);

		if (code <= 32 || code >= 127) return false;
	}

	return true;
}

/**
 * Checks whether a value is an absolute URL with an allowed scheme, parsing it with the WHATWG `URL` parser (`globalThis.URL`).
 *
 * On top of what the parser accepts, the string must not contain white space or control characters (which the parser
 * silently strips), "special" schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`) must be followed by `//`
 * (`http:example.com` is rejected), and `http(s)` URLs must have a non-empty host.
 *
 * The host is also checked against the text, so that for an accepted URL the host a client connects to is the one a reader (or a
 * string-based allow/deny list) sees (except for bracketed IPv6 literals, which the parser writes in canonical form: `[0::1]` becomes
 * `[::1]`, so compare those after parsing): for `http(s)` and the other special schemes, `new URL(value).hostname` is the written host,
 * lower-cased, or its punycode form for internationalized names (`münchen.de`, `例え.jp`; each non-ASCII label must stay a punycode label,
 * so `https://ẞa.com`, which older IDNA case folding turns into `ssa.com`, is rejected there; the parser percent-encodes the non-ASCII
 * hosts of other schemes, `foo://例え.jp`, instead). So the following are also rejected: invisible characters anywhere (format characters
 * such as U+00AD soft hyphen, U+200B zero-width space or bidi controls, and other default-ignorable code points such as U+034F or
 * variation selectors), a backslash in the authority (`http://evil.com\@good.com`, which parsers disagree on), and host names with
 * a `%` (percent-decoded by the parser), an empty label (`https://a..b`, `https://.`; one trailing dot is allowed), characters that
 * NFKC normalization changes (fullwidth `ｅ`, circled `ⓔ`, ...), ideographic full stops (`。`), or a numeric form other than
 * dotted-decimal IPv4 (`http://0x7f.1`, `http://2130706433`, `http://127.1` all mean `127.0.0.1`).
 * Credentials are allowed: in `https://good.com@evil.com` the host is `evil.com`, as for every parser.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @param {IsUrlOptions} [options] - `protocols` (default `['http', 'https']`): allowed schemes;
 * `requireTld` (default `false`): require a host ending in a top-level domain, which rejects `localhost`, IP addresses and host-less URLs
 * @returns {boolean} `true` when `value` is a string holding a URL that satisfies the options
 * @throws {TypeError} when `options.protocols` is not an array
 * @throws {Error} when `globalThis.URL` is not available
 * @example
 * isUrl('https://example.com/path?q=1#top'); // => true
 * isUrl('http://localhost:3000'); // => true
 * isUrl('http://localhost:3000', { requireTld: true }); // => false
 * isUrl('ftp://files.example.com'); // => false
 * isUrl('ftp://files.example.com', { protocols: ['ftp'] }); // => true
 * isUrl('example.com'); // => false
 * isUrl(' https://example.com'); // => false
 * isUrl('https://ｅvil.com'); // => false
 * isUrl('https://例え.jp'); // => true
 */
export function isUrl(value: unknown, options?: IsUrlOptions): value is string {
	// Not read from a polluted `Object.prototype`, where a planted `protocols` would allow `javascript:` URLs.
	const protocols = options === undefined ? undefined : readOption(options, 'protocols');
	const requireTld = options !== undefined && Boolean(readOption(options, 'requireTld'));
	if (protocols !== undefined && !Array.isArray(protocols)) throw new TypeError(`isUrl: \`protocols\` must be an array of strings, got ${typeof protocols}`);
	if (typeof value !== 'string') return false;

	const UrlParser = getUrlConstructor();

	// The common case, decided without the (much more expensive) parser; anything less plain takes the full check below.
	if (protocols === undefined && UrlParser === NATIVE_URL && isPlainWebUrl(value, requireTld)) return true;
	if (URL_FORBIDDEN_CHARACTER.test(value)) return false;
	// A successful parse reads the scheme up to the first `:` and lower-cases it, so the scheme checks can run before the (much more
	// expensive) parse. Without any `:` the parse fails, whatever these checks conclude.
	const schemeEnd = value.indexOf(':');
	const scheme = value.slice(0, schemeEnd).toLowerCase();
	const allowed =
		protocols === undefined
			? scheme === 'http' || scheme === 'https'
			: protocols.some(function (protocol: unknown): boolean {
					return typeof protocol === 'string' && protocol.toLowerCase().replace(/:$/, '') === scheme;
				});
	if (!allowed) return false;

	const hasAuthority = value.startsWith('//', schemeEnd + 1);
	// The WHATWG parser reads `http:///host` as `http://host`; it also treats `\\` as `/`, so backslashes in the authority are rejected below.
	if (SPECIAL_SCHEMES.has(scheme) && (!hasAuthority || (scheme !== 'file' && value[schemeEnd + 3] === '/'))) return false;
	let host: string | undefined = '';
	if (hasAuthority) {
		AUTHORITY_PATTERN.lastIndex = schemeEnd + 3;
		host = writtenHost((AUTHORITY_PATTERN.exec(value) as RegExpExecArray)[0]);
		if (host === undefined) return false;
	}
	// Special schemes encode international host names with IDNA, whose result must be compared with the written host.
	const international = SPECIAL_SCHEMES.has(scheme) && NON_ASCII_PATTERN.test(host);

	// Runtimes with `URL.canParse` implement the WHATWG parser, which never yields an empty http(s) host: unless the host must be
	// inspected, validate without building a URL object (about twice as fast).
	if (!requireTld && !international && typeof UrlParser.canParse === 'function') return UrlParser.canParse(value);

	let url: UrlRecord;
	try {
		url = new UrlParser(value);
	} catch {
		return false;
	}

	// A conforming parser never yields an empty http(s) host, but not every `globalThis.URL` implementation conforms.
	const hostname = url.hostname;
	if ((scheme === 'http' || scheme === 'https') && hostname === '') return false;
	if (international && !isEncodingOf(host, hostname)) return false;

	return !requireTld || hasTld(hostname);
}

/**
 * Checks whether a value is a UUID as defined by RFC 9562 (which obsoletes RFC 4122), in the hyphenated 8-4-4-4-12 form,
 * case-insensitively. Versions 1–8 must carry the RFC variant (`10xx`, i.e. the first digit of the 4th group is `8`, `9`, `a` or `b`);
 * the special nil (`00000000-…`) and max (`ffffffff-…`) UUIDs are accepted too. Braces and `urn:uuid:` prefixes are not.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @param {UuidVersion} [version] - Only accept this version (`1`–`8`, `'nil'` or `'max'`); any of them when omitted
 * @returns {boolean} `true` when `value` is a string holding a matching UUID
 * @throws {RangeError} when `version` is not one of the accepted values
 * @example
 * isUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479'); // => true
 * isUuid('F47AC10B-58CC-4372-A567-0E02B2C3D479', 4); // => true
 * isUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479', 7); // => false
 * isUuid('00000000-0000-0000-0000-000000000000'); // => true
 * isUuid('00000000-0000-0000-0000-000000000000', 4); // => false
 * isUuid('f47ac10b58cc4372a5670e02b2c3d479'); // => false
 */
export function isUuid(value: unknown, version?: UuidVersion): value is string {
	if (version !== undefined && version !== 'nil' && version !== 'max' && !(Number.isInteger(version) && version >= 1 && version <= 8)) {
		throw new RangeError(`isUuid: \`version\` must be 1-8, 'nil' or 'max', got ${show(version)}`);
	}
	if (typeof value !== 'string') return false;
	if (version === 'nil' || version === 'max') return value.toLowerCase() === (version === 'nil' ? NIL_UUID : MAX_UUID);
	// A single regex test covers the common case; the nil and max UUIDs have no RFC variant, so they are only checked when it fails.
	if (UUID_PATTERN.test(value)) return version === undefined || value.charCodeAt(14) === 48 + version;
	if (version !== undefined) return false;

	const lower = value.toLowerCase();
	return lower === NIL_UUID || lower === MAX_UUID;
}

/**
 * Checks whether a value is an IPv4 address in dotted-decimal form: exactly four decimal octets in `[0, 255]`.
 * Leading zeros (`01.2.3.4`, ambiguous with octal), shorthand forms (`127.1`), hex and surrounding white space are rejected.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding an IPv4 address
 * @example
 * isIPv4('192.168.0.1'); // => true
 * isIPv4('255.255.255.255'); // => true
 * isIPv4('256.0.0.1'); // => false
 * isIPv4('192.168.01.1'); // => false
 * isIPv4('127.1'); // => false
 */
export function isIPv4(value: unknown): value is string {
	return typeof value === 'string' && IPV4_PATTERN.test(value);
}

/**
 * Checks whether a value is an IPv6 address (RFC 4291 §2.2): eight groups of 1–4 hex digits, optionally compressed once
 * with `::` (which stands for one or more zero groups), and optionally ending in an embedded IPv4 address (`::ffff:192.0.2.1`).
 * Letter case is ignored and leading zeros within a group are allowed.
 *
 * Zone ids (`fe80::1%eth0`) are rejected: they are only meaningful on the local host and are not part of the address itself.
 * Brackets (`[::1]`) are rejected as well.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding an IPv6 address
 * @example
 * isIPv6('2001:0db8:0000:0000:0000:ff00:0042:8329'); // => true
 * isIPv6('2001:db8::ff00:42:8329'); // => true
 * isIPv6('::1'); // => true
 * isIPv6('::ffff:192.0.2.128'); // => true
 * isIPv6('1::2::3'); // => false
 * isIPv6('fe80::1%eth0'); // => false
 */
export function isIPv6(value: unknown): value is string {
	if (typeof value !== 'string') return false;

	// A single left-to-right scan over the char codes (no splitting): `index` is at the start of a group on every iteration.
	const length = value.length;
	let compressed = value.startsWith('::');
	let index = compressed ? 2 : 0;
	let groups = 0;

	while (index < length) {
		const start = index;

		while (isHexDigit(value.charCodeAt(index))) index++;

		// An embedded IPv4 address (two groups' worth) must end the address, so it can only follow a `::`, never precede one.
		if (value.charCodeAt(index) === 46) return isIPv4(value.slice(start)) && (compressed ? groups + 2 < 8 : groups + 2 === 8);

		if (index === start || index - start > 4) return false;

		groups++;

		if (index === length) break;

		if (value.charCodeAt(index) !== 58) return false;

		index++;

		if (value.charCodeAt(index) === 58) {
			// A second `::`; a `::` may end the address.
			if (compressed) return false;

			compressed = true;
			index++;
		} else if (index === length) {
			// A trailing single `:`.
			return false;
		}
	}

	return compressed ? groups < 8 : groups === 8;
}

/**
 * Tells whether a UTF-16 code unit is an ASCII hex digit.
 * @param {number} code - The code unit (`NaN` past the end of a string)
 * @returns {boolean} `true` for `0`–`9`, `a`–`f` and `A`–`F`
 */
function isHexDigit(code: number): boolean {
	const lower = code | 32;

	return (code >= 48 && code <= 57) || (lower >= 97 && lower <= 102);
}

/**
 * Checks whether a value is an IPv4 or an IPv6 address (see {@link isIPv4} and {@link isIPv6}).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding an IP address
 * @example
 * isIP('10.0.0.1'); // => true
 * isIP('::1'); // => true
 * isIP('example.com'); // => false
 */
export function isIP(value: unknown): value is string {
	return isIPv4(value) || isIPv6(value);
}

/**
 * Checks whether a value is a CSS hex colour: `#rgb`, `#rrggbb` and, unless `alpha` is `false`, `#rgba` and `#rrggbbaa`, in any letter case.
 * The leading `#` is required. Every accepted string is also accepted by `parseHex` from the color module (which additionally allows omitting the `#`).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @param {IsHexColorOptions} [options={}] - `alpha` (default `true`): accept the forms with an alpha channel
 * @returns {boolean} `true` when `value` is a string holding a hex colour
 * @example
 * isHexColor('#ff8000'); // => true
 * isHexColor('#FFF'); // => true
 * isHexColor('#ff800080'); // => true
 * isHexColor('#ff800080', { alpha: false }); // => false
 * isHexColor('ff8000'); // => false
 * isHexColor('#ff80'); // => true
 * isHexColor('#ff800'); // => false
 */
export function isHexColor(value: unknown, options?: IsHexColorOptions): value is string {
	// No `= {}` default: allocating an options object would cost about as much as the test itself. An `alpha: false` inherited from a
	// polluted `Object.prototype` is ignored (`readOption`, inlined: it would double the cost of the call).
	const opaque = options !== undefined && options.alpha === false && ((Object.prototype as IsHexColorOptions).alpha !== false || hasOwn.call(options, 'alpha'));

	return typeof value === 'string' && (opaque ? OPAQUE_HEX_COLOR_PATTERN : HEX_COLOR_PATTERN).test(value);
}

/**
 * Matches a value against the official semver regular expression (see {@link SEMVER_PATTERN}).
 * @param {unknown} value - The value
 * @returns {RegExpExecArray | null} The match, or `null` when `value` is not a string holding a semantic version
 */
function matchSemver(value: unknown): RegExpExecArray | null {
	const match = typeof value === 'string' ? SEMVER_PATTERN.exec(value) : null;

	return match === null || (match[4] !== undefined && BAD_IDENTIFIER.test(match[4])) || (match[5] !== undefined && EMPTY_IDENTIFIER.test(match[5])) ? null : match;
}

/**
 * Checks whether a value is a semantic version, using the official regular expression from semver.org (SemVer 2.0.0):
 * `MAJOR.MINOR.PATCH`, optional `-pre.release` identifiers and optional `+build.metadata`. No leading `v`, no leading zeros in numeric parts.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a semantic version
 * @example
 * isSemver('1.2.3'); // => true
 * isSemver('1.0.0-alpha.1+build.5'); // => true
 * isSemver('v1.2.3'); // => false
 * isSemver('1.2'); // => false
 * isSemver('01.2.3'); // => false
 */
export function isSemver(value: unknown): value is string {
	return matchSemver(value) !== null;
}

/**
 * Parses a semantic version into its parts. Numeric pre-release identifiers become numbers, unless they exceed
 * `Number.MAX_SAFE_INTEGER`, in which case they stay strings so no precision is lost.
 * @param {unknown} value - The value to parse
 * @returns {SemVer | undefined} The parts, or `undefined` when `value` is not a semantic version (see {@link isSemver})
 * or its major, minor or patch number exceeds `Number.MAX_SAFE_INTEGER`
 * @example
 * parseSemver('1.2.3'); // => { major: 1, minor: 2, patch: 3, prerelease: [], build: [] }
 * parseSemver('2.0.0-rc.1+sha.5114f85'); // => { major: 2, minor: 0, patch: 0, prerelease: ['rc', 1], build: ['sha', '5114f85'] }
 * parseSemver('1.2'); // => undefined
 */
export function parseSemver(value: unknown): SemVer | undefined {
	const match = matchSemver(value);
	if (match === null) return undefined;

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined;

	return {
		major,
		minor,
		patch,
		prerelease:
			match[4] === undefined
				? []
				: match[4].split('.').map(function (identifier: string): string | number {
						const numeric = DIGITS_PATTERN.test(identifier) ? Number(identifier) : NaN;
						return Number.isSafeInteger(numeric) ? numeric : identifier;
					}),
		build: match[5] === undefined ? [] : match[5].split('.')
	};
}

/**
 * Compares two strings of decimal digits without leading zeros numerically, at any size.
 * @param {string} a - The first number
 * @param {string} b - The second number
 * @returns {number} `-1`, `0` or `1`
 */
function compareDigits(a: string, b: string): -1 | 0 | 1 {
	return (Math.sign(a.length - b.length) || compareText(a, b)) as -1 | 0 | 1;
}

/**
 * Compares two strings by UTF-16 code units (ASCII order for semver identifiers).
 * @param {string} a - The first string
 * @param {string} b - The second string
 * @returns {number} `-1`, `0` or `1`
 */
function compareText(a: string, b: string): -1 | 0 | 1 {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two pre-release identifiers: numerically when both are numeric, numeric before alphanumeric, else in ASCII order.
 * @param {string} a - The first identifier
 * @param {string} b - The second identifier
 * @returns {number} `-1`, `0` or `1`
 */
function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
	const aNumeric = DIGITS_PATTERN.test(a);
	const bNumeric = DIGITS_PATTERN.test(b);
	if (aNumeric && bNumeric) return compareDigits(a, b);
	if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
	return compareText(a, b);
}

/**
 * Parses a version for {@link compareSemver}.
 * @param {unknown} value - The version
 * @returns {RegExpExecArray} The semver match
 * @throws {TypeError} when `value` is not a semantic version
 */
function semverOrThrow(value: unknown): RegExpExecArray {
	const match = matchSemver(value);
	if (match === null) throw new TypeError(`compareSemver: ${quoteValue(value)} is not a valid semantic version`);
	return match;
}

/**
 * Shows a rejected value in an error message: a string as JSON, cut to 50 characters so that an attacker-sized input does not end up
 * whole in logs, anything else by its type.
 * @param {unknown} value - The value
 * @returns {string} Its text for the message
 */
function quoteValue(value: unknown): string {
	return typeof value === 'string' ? JSON.stringify(value.length > 50 ? `${value.slice(0, 50)}…` : value) : describe(value);
}

/**
 * Compares two semantic versions by SemVer 2.0.0 precedence (semver.org §11): major, minor and patch numerically
 * (exactly, at any size), then a version with a pre-release is lower than the same version without one, and pre-releases
 * are compared identifier by identifier (numeric identifiers numerically and lower than alphanumeric ones, which compare
 * in ASCII order; a shorter list of equal identifiers is lower). Build metadata is ignored. Suitable as an `Array#sort` comparator.
 * @param {string} a - The first version
 * @param {string} b - The second version
 * @returns {number} `-1` when `a` has lower precedence than `b`, `1` when higher, `0` when equal
 * @throws {TypeError} when `a` or `b` is not a semantic version (see {@link isSemver})
 * @example
 * compareSemver('1.2.3', '1.10.0'); // => -1
 * compareSemver('1.0.0', '1.0.0-rc.1'); // => 1
 * compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'); // => -1
 * compareSemver('1.0.0+build.1', '1.0.0+build.2'); // => 0
 * ['1.0.0', '1.0.0-beta', '0.9.0'].sort(compareSemver); // => ['0.9.0', '1.0.0-beta', '1.0.0']
 * compareSemver('1.0', '1.0.0'); // throws TypeError
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
	const left = semverOrThrow(a);
	const right = semverOrThrow(b);

	for (let i = 1; i <= 3; i++) {
		const order = compareDigits(left[i], right[i]);
		if (order !== 0) return order;
	}

	if (left[4] === undefined || right[4] === undefined) {
		return left[4] === right[4] ? 0 : left[4] === undefined ? 1 : -1;
	}

	const leftIds = left[4].split('.');
	const rightIds = right[4].split('.');
	const shared = Math.min(leftIds.length, rightIds.length);
	for (let i = 0; i < shared; i++) {
		const order = compareIdentifiers(leftIds[i], rightIds[i]);
		if (order !== 0) return order;
	}

	return Math.sign(leftIds.length - rightIds.length) as -1 | 0 | 1;
}

/*
 * Semver ranges, written to give exactly the answers of node-semver 7.8.5 without `loose`. node-semver desugars a range with a chain of
 * regular expressions, and its quirks are part of what npm accepts (`>= 1.2.3` and `^ 1.2.3` are valid, `>  1.2.3` with two spaces is
 * not, `1.2.3 - 2` is a hyphen range, build metadata anywhere is dropped). The parser below follows the same steps on the same
 * grammar, with hand-written scanners instead of the regular expressions, so that it runs in linear time.
 */

/** Bits of a comparator's operator: a version satisfies the comparator when its order against the bound is one of the set bits. */
const LESS = 1;
/** See {@link LESS}. */
const GREATER = 2;
/** See {@link LESS}. */
const EQUAL = 4;

/** The lowest pre-release, so that an upper bound `<1.3.0-0` excludes the pre-releases of `1.3.0` and a lower bound `>=1.2.0-0` includes those of `1.2.0`. */
const LOWEST_PRERELEASE = '0';

/** The longest version node-semver parses (its `MAX_LENGTH`); longer versions satisfy nothing. */
const SEMVER_MAX_LENGTH = 256;

/** The longest number node-semver's range grammar reads (`[1-9]\d{0,256}`), and the cap on an identifier's leading digits. */
const MAX_NUMBER_DIGITS = 257;

/** The most characters node-semver's grammar reads after the first letter or hyphen of an alphanumeric identifier. */
const MAX_IDENTIFIER_TAIL = 250;

/** Build metadata, which node-semver deletes from a range wherever it appears. */
const RANGE_BUILD_PATTERN = /\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*/g;

/** A space after an operator, a tilde, a caret or another space: only then can a space be dropped before splitting a range. */
const OPERATOR_SPACE_PATTERN = /[<>=~^ ] /;

/** A version read by {@link readVersion}: identifiers below `Number.MAX_SAFE_INTEGER` are numbers, and `prerelease` is `undefined` on a release. */
interface ParsedVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: (string | number)[] | undefined;
}

/** A comparator of a compiled range: a version satisfies it when its order against the bound (see {@link orderVersions}) is in `operator`. */
interface SemverComparator extends ParsedVersion {
	readonly operator: number;
}

/** A compiled range: a version satisfies it when it satisfies every comparator of one of the sets (an empty set allows any version). */
type CompiledRange = ReadonlyArray<ReadonlyArray<SemverComparator>>;

/** The value of the number read by the last {@link readNumber} call (`-1` for a wildcard). Module state, so that scanning allocates nothing. */
let scannedNumber = 0;
/** The major part read by the last {@link readPartial} call (`-1` for a wildcard or a missing part, like the other parts). */
let partialMajor = 0;
/** The minor part read by the last {@link readPartial} call. */
let partialMinor = 0;
/** The patch part read by the last {@link readPartial} call. */
let partialPatch = 0;
/** The pre-release read by the last {@link readPartial} call, as written, or `undefined`. */
let partialPrerelease: string | undefined;

/**
 * Tells whether a character code is an ASCII digit.
 * @param {number} code - The character code
 * @returns {boolean} `true` for `0`–`9`
 */
function isDigitCode(code: number): boolean {
	return code >= 48 && code <= 57;
}

/**
 * Tells whether a character code is an ASCII letter or a hyphen.
 * @param {number} code - The character code
 * @returns {boolean} `true` for `A`–`Z`, `a`–`z` and `-`
 */
function isLetterCode(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45;
}

/**
 * Tells whether a character code can start a version or partial version: a digit, `x`, `X` or `*`.
 * @param {number} code - The character code
 * @returns {boolean} `true` when a (partial) version can start with it
 */
function isPartialStart(code: number): boolean {
	return isDigitCode(code) || code === 120 || code === 88 || code === 42;
}

/**
 * Reads a number (`0`, or up to 257 digits without a leading zero) or a wildcard (`x`, `X`, `*`) at `index` into {@link scannedNumber}.
 * Numbers above `Number.MAX_SAFE_INTEGER` are read approximately: they are rejected wherever they are used.
 * @param {string} text - The text
 * @param {number} index - Where the number starts
 * @returns {number} The index after it, or `-1` when there is none
 */
function readNumber(text: string, index: number): number {
	const code = text.charCodeAt(index);
	if (code === 120 || code === 88 || code === 42) {
		scannedNumber = -1;
		return index + 1;
	}
	if (!isDigitCode(code)) return -1;

	let value = code - 48;
	let end = index + 1;
	if (value !== 0) {
		const limit = Math.min(text.length, index + MAX_NUMBER_DIGITS);
		while (end < limit && isDigitCode(text.charCodeAt(end))) value = value * 10 + (text.charCodeAt(end++) - 48);
	}
	scannedNumber = value;
	return end;
}

/**
 * Reads a pre-release identifier at `index` as node-semver's grammar does: an alphanumeric identifier (at most 256 digits, a letter or
 * hyphen, then at most 250 letters, digits and hyphens), else a number without a leading zero.
 * @param {string} text - The text
 * @param {number} index - Where the identifier starts
 * @returns {number} The index after the longest identifier there, or `-1` when there is none
 */
function readIdentifier(text: string, index: number): number {
	let end = index;
	while (isDigitCode(text.charCodeAt(end))) end++;
	if (end - index < MAX_NUMBER_DIGITS && isLetterCode(text.charCodeAt(end))) {
		const limit = Math.min(text.length, end + 1 + MAX_IDENTIFIER_TAIL);
		end++;
		while (end < limit && (isLetterCode(text.charCodeAt(end)) || isDigitCode(text.charCodeAt(end)))) end++;
		return end;
	}
	if (end === index) return -1;
	return text.charCodeAt(index) === 48 ? index + 1 : Math.min(end, index + MAX_NUMBER_DIGITS);
}

/**
 * Reads dot-separated pre-release identifiers at `index`.
 * @param {string} text - The text
 * @param {number} index - Where the first identifier starts
 * @returns {number} The index after the longest list of identifiers there, or `-1` when there is none
 */
function readPrerelease(text: string, index: number): number {
	let end = readIdentifier(text, index);
	while (text.charCodeAt(end) === 46) {
		const next = readIdentifier(text, end + 1);
		if (next < 0) break;
		end = next;
	}
	return end;
}

/**
 * Reads the longest (partial) version at `index`, `1`, `1.x`, `1.2.*` or `1.2.3-beta`, into {@link partialMajor}, {@link partialMinor},
 * {@link partialPatch} and {@link partialPrerelease} (node-semver's `XRANGEPLAIN`, without its prefix and build metadata).
 * @param {string} text - The text
 * @param {number} index - Where the version starts
 * @returns {number} The index after it, or `-1` when no version starts there (the parts are then meaningless)
 */
function readPartial(text: string, index: number): number {
	let end = readNumber(text, index);
	partialMajor = scannedNumber;
	partialMinor = -1;
	partialPatch = -1;
	partialPrerelease = undefined;

	if (text.charCodeAt(end) !== 46) return end;
	let next = readNumber(text, end + 1);
	if (next < 0) return end;
	partialMinor = scannedNumber;
	end = next;

	if (text.charCodeAt(end) !== 46) return end;
	next = readNumber(text, end + 1);
	if (next < 0) return end;
	partialPatch = scannedNumber;
	end = next;

	if (text.charCodeAt(end) === 45) {
		next = readPrerelease(text, end + 1);
		if (next > end + 1) {
			partialPrerelease = text.slice(end + 1, next);
			end = next;
		}
	}
	return end;
}

/**
 * Splits valid pre-release identifiers, turning numeric ones below `Number.MAX_SAFE_INTEGER` into numbers (larger ones stay exact
 * strings, as in node-semver).
 * @param {string} text - The text holding the identifiers
 * @param {number} [start=0] - Where the first identifier starts
 * @param {number} [end=text.length] - Where the last one ends
 * @returns {(string | number)[]} The identifiers
 */
function splitPrerelease(text: string, start = 0, end = text.length): (string | number)[] {
	const identifiers: (string | number)[] = [];
	for (let index = start; ; index++) {
		const from = index;
		let value = 0;
		for (let code = text.charCodeAt(index); index < end && code !== 46; code = text.charCodeAt(++index)) {
			// A non-digit makes the value NaN, so that the identifier stays a string.
			value = isDigitCode(code) ? value * 10 + (code - 48) : NaN;
		}
		identifiers.push(value < Number.MAX_SAFE_INTEGER ? value : text.slice(from, index));
		if (index >= end) return identifiers;
	}
}

/**
 * Reads a version the way node-semver does without `loose`: a semantic version (see {@link isSemver}), optionally with one leading `v`
 * and surrounding white space, at most 256 characters long, with major, minor and patch numbers up to `Number.MAX_SAFE_INTEGER`.
 * @param {unknown} value - The value
 * @returns {ParsedVersion | undefined} The version, or `undefined` when `value` is not one
 */
function readVersion(value: unknown): ParsedVersion | undefined {
	if (typeof value !== 'string' || value.length > SEMVER_MAX_LENGTH) return undefined;
	const text = value.trim();

	// When a number is missing (`end` is -1), `scannedNumber` is stale but the character checks at index -1 fail.
	let end = readNumber(text, text.charCodeAt(0) === 118 ? 1 : 0);
	const major = scannedNumber;
	if (major < 0 || major > Number.MAX_SAFE_INTEGER || text.charCodeAt(end) !== 46) return undefined;
	end = readNumber(text, end + 1);
	const minor = scannedNumber;
	if (minor < 0 || minor > Number.MAX_SAFE_INTEGER || text.charCodeAt(end) !== 46) return undefined;
	end = readNumber(text, end + 1);
	const patch = scannedNumber;
	if (patch < 0 || patch > Number.MAX_SAFE_INTEGER) return undefined;

	let prerelease: (string | number)[] | undefined;
	if (text.charCodeAt(end) === 45) {
		const next = readPrerelease(text, end + 1);
		if (next < 0) return undefined;
		prerelease = splitPrerelease(text, end + 1, next);
		end = next;
	}
	return endsWithBuild(text, end) ? { major, minor, patch, prerelease } : undefined;
}

/**
 * Orders a version against another by SemVer precedence, build metadata aside. Pre-release identifiers are compared as
 * {@link compareSemver} compares them (numeric strings, beyond `Number.MAX_SAFE_INTEGER`, compare exactly).
 * @param {ParsedVersion} version - The version
 * @param {ParsedVersion} bound - The version it is compared with
 * @returns {number} {@link LESS}, {@link GREATER} or {@link EQUAL}
 */
function orderVersions(version: ParsedVersion, bound: ParsedVersion): number {
	if (version.major < bound.major) return LESS;
	if (version.major > bound.major) return GREATER;
	if (version.minor < bound.minor) return LESS;
	if (version.minor > bound.minor) return GREATER;
	if (version.patch < bound.patch) return LESS;
	if (version.patch > bound.patch) return GREATER;

	const left = version.prerelease;
	const right = bound.prerelease;
	if (left === undefined || right === undefined) return left === right ? EQUAL : left === undefined ? GREATER : LESS;
	const shared = Math.min(left.length, right.length);
	for (let i = 0; i < shared; i++) {
		const a = left[i];
		const b = right[i];
		if (a === b) continue;
		// Two numbers (the common case, about 20% faster this way) compare directly; anything else exactly, as compareSemver does.
		return (typeof a === 'number' && typeof b === 'number' ? a < b : compareIdentifiers(String(a), String(b)) === -1) ? LESS : GREATER;
	}
	return left.length < right.length ? LESS : left.length > right.length ? GREATER : EQUAL;
}

/**
 * Tests a version against a compiled range, with node-semver's pre-release rule: unless `includePrerelease` is set, a pre-release
 * only satisfies a set that has a comparator on a pre-release of the same `major.minor.patch`.
 * @param {CompiledRange} range - The range
 * @param {ParsedVersion} version - The version
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @returns {boolean} `true` when the version satisfies the range
 */
function testRange(range: CompiledRange, version: ParsedVersion, includePrerelease: boolean): boolean {
	sets: for (let s = 0; s < range.length; s++) {
		const set = range[s];
		for (let c = 0; c < set.length; c++) {
			if ((orderVersions(version, set[c]) & set[c].operator) === 0) continue sets;
		}
		if (version.prerelease === undefined || includePrerelease) return true;
		for (let c = 0; c < set.length; c++) {
			const bound = set[c];
			if (bound.prerelease !== undefined && bound.major === version.major && bound.minor === version.minor && bound.patch === version.patch) return true;
		}
	}
	return false;
}

/**
 * Adds a comparator to a set, with node-semver's checks: every number at most `Number.MAX_SAFE_INTEGER`, the version at most 256
 * characters, and `>=0.0.0` dropped when written exactly so, as it allows any release. (node-semver also drops `>=0.0.0-0` with
 * `includePrerelease`, which allows every version: dropping it or not cannot change an answer.)
 * @param {SemverComparator[]} set - The set
 * @param {number} operator - The operator bits
 * @param {number} major - The major number
 * @param {number} minor - The minor number
 * @param {number} patch - The patch number
 * @param {string | undefined} prerelease - The pre-release as written
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @param {number} [written=0] - The length of the version as written in the range (with its `v` and build metadata), or `0` when it
 * is written in the canonical form `major.minor.patch-prerelease`
 * @returns {boolean} `false` when node-semver rejects the comparator
 */
function addComparator(
	set: SemverComparator[],
	operator: number,
	major: number,
	minor: number,
	patch: number,
	prerelease: string | undefined,
	includePrerelease: boolean,
	written = 0
): boolean {
	if (major > Number.MAX_SAFE_INTEGER || minor > Number.MAX_SAFE_INTEGER || patch > Number.MAX_SAFE_INTEGER || written > SEMVER_MAX_LENGTH) return false;
	// Three safe integers and the separators take at most 51 characters, so only a long pre-release can make the version too long.
	if (prerelease !== undefined && prerelease.length > SEMVER_MAX_LENGTH - 51 && `${major}.${minor}.${patch}-`.length + prerelease.length > SEMVER_MAX_LENGTH) return false;
	if (!includePrerelease && operator === (GREATER | EQUAL) && major === 0 && minor === 0 && patch === 0 && prerelease === undefined && (written === 0 || written === 5)) {
		return true;
	}
	set.push({ operator, major, minor, patch, prerelease: prerelease === undefined ? undefined : splitPrerelease(prerelease) });
	return true;
}

/**
 * Tells whether a text ends at `index` or with build metadata (`+` then dot-separated identifiers of letters, digits and hyphens) there.
 * @param {string} text - The text
 * @param {number} index - Where the metadata may start (`-1` for none, which is never the end)
 * @returns {boolean} `true` when nothing but build metadata follows `index`
 */
function endsWithBuild(text: string, index: number): boolean {
	if (text.charCodeAt(index) !== 43) return index === text.length;
	let end = index;
	do {
		const start = ++end;
		while (isLetterCode(text.charCodeAt(end)) || isDigitCode(text.charCodeAt(end))) end++;
		if (end === start) return false;
	} while (text.charCodeAt(end) === 46);
	return end === text.length;
}

/**
 * Reads a plain comparator (`<=1.2.3`, `v1.2.3+build`, no wildcard) filling a whole string, as node-semver's `Comparator` does.
 * @param {string} text - The comparator
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @param {SemverComparator[]} set - The set to add it to
 * @returns {boolean} `false` when `text` is not a comparator
 */
function readComparator(text: string, includePrerelease: boolean, set: SemverComparator[]): boolean {
	let index = 0;
	let operator = 0;
	const code = text.charCodeAt(0);
	if (code === 60 || code === 62) {
		operator = code === 60 ? LESS : GREATER;
		index++;
	}
	if (text.charCodeAt(index) === 61) {
		operator |= EQUAL;
		index++;
	}
	const end = readPartial(text, text.charCodeAt(index) === 118 ? index + 1 : index);
	if (!endsWithBuild(text, end) || partialMajor < 0 || partialMinor < 0 || partialPatch < 0) return false;
	return addComparator(set, operator || EQUAL, partialMajor, partialMinor, partialPatch, partialPrerelease, includePrerelease, text.length - index);
}

/**
 * Adds the two comparators of a range of versions: `>=lower <upper-0`.
 * @param {SemverComparator[]} set - The set
 * @param {number} major - The lower bound's major number
 * @param {number} minor - The lower bound's minor number
 * @param {number} patch - The lower bound's patch number
 * @param {string | undefined} prerelease - The lower bound's pre-release
 * @param {number} upperMajor - The upper bound's major number
 * @param {number} upperMinor - The upper bound's minor number
 * @param {number} upperPatch - The upper bound's patch number
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @returns {boolean} `false` when node-semver rejects a comparator
 */
function addBounds(
	set: SemverComparator[],
	major: number,
	minor: number,
	patch: number,
	prerelease: string | undefined,
	upperMajor: number,
	upperMinor: number,
	upperPatch: number,
	includePrerelease: boolean
): boolean {
	return (
		addComparator(set, GREATER | EQUAL, major, minor, patch, prerelease, includePrerelease) &&
		addComparator(set, LESS, upperMajor, upperMinor, upperPatch, LOWEST_PRERELEASE, includePrerelease)
	);
}

/**
 * Reads one space-separated token of a range, as node-semver's `parseComparator`: a caret, tilde or X-range desugared into
 * comparators, or a plain comparator (where, like node-semver, the first `*` and the operator before it are dropped).
 * @param {string} text - The range
 * @param {number} start - Where the token starts
 * @param {number} end - Where it ends (a space or the end of `text`)
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @param {SemverComparator[]} set - The set to add the comparators to
 * @returns {boolean} `false` when node-semver rejects the token
 */
function readToken(text: string, start: number, end: number, includePrerelease: boolean, set: SemverComparator[]): boolean {
	if (start === end) return true;
	const kind = text.charCodeAt(start);
	let index = start;
	let operator = 0;
	if (kind === 94 || kind === 126) {
		index++;
		if (kind === 126 && text.charCodeAt(index) === 62) index++;
	} else {
		if (kind === 60 || kind === 62) {
			operator = kind === 60 ? LESS : GREATER;
			index++;
		}
		if (text.charCodeAt(index) === 61) {
			operator |= EQUAL;
			index++;
		}
	}
	const prefixStart = index;
	while (text.charCodeAt(index) === 118 || text.charCodeAt(index) === 61) index++;

	if (readPartial(text, index) !== end) {
		// Not a caret, tilde or X-range: without a `*`, nor a comparator (a token starting with `^` or `~` fails after one too).
		const token = text.slice(start, end);
		const star = token.indexOf('*');
		if (star < 0) return false;
		let cut = star;
		if (token.charCodeAt(cut - 1) === 61) cut--;
		if (token.charCodeAt(cut - 1) === 60 || token.charCodeAt(cut - 1) === 62) cut--;
		return readComparator(token.slice(0, cut) + token.slice(star + 1), includePrerelease, set);
	}

	// A wildcard minor makes the patch a wildcard too (in a caret or tilde; an X-range rejects a number after a wildcard).
	const major = partialMajor;
	const minor = partialMinor;
	const patch = minor < 0 ? -1 : partialPatch;
	if (kind !== 94 && kind !== 126) {
		if ((major < 0 && partialMinor >= 0) || (partialMinor < 0 && partialPatch >= 0)) return false;
		if (major < 0) return operator === LESS || operator === GREATER ? addComparator(set, LESS, 0, 0, 0, LOWEST_PRERELEASE, includePrerelease) : true;
		if (patch >= 0) {
			// No wildcard: a plain comparator, where only a single `v` may separate the operator and the version.
			const prefix = index - prefixStart;
			if (prefix > 1 || (prefix === 1 && text.charCodeAt(prefixStart) !== 118)) return false;
			return addComparator(set, operator || EQUAL, major, minor, patch, partialPrerelease, includePrerelease, end - prefixStart);
		}
		if (operator !== 0 && operator !== EQUAL) {
			let upperMajor = major;
			let upperMinor = minor < 0 ? 0 : minor;
			if (operator === GREATER || operator === (LESS | EQUAL)) {
				if (minor < 0) upperMajor++;
				else upperMinor++;
			}
			// `>1.2` is `>=1.3.0`, `<=1.2` is `<1.3.0-0`.
			const bound = operator === GREATER ? GREATER | EQUAL : operator === (LESS | EQUAL) ? LESS : operator;
			return addComparator(set, bound, upperMajor, upperMinor, 0, bound === LESS || includePrerelease ? LOWEST_PRERELEASE : undefined, includePrerelease);
		}
	}

	if (major < 0) return true;
	const lowerPrerelease = patch < 0 ? (includePrerelease ? LOWEST_PRERELEASE : undefined) : partialPrerelease;
	if (minor < 0 || (kind === 94 && major > 0))
		return addBounds(set, major, minor < 0 ? 0 : minor, patch < 0 ? 0 : patch, lowerPrerelease, major + 1, 0, 0, includePrerelease);
	if (kind === 94 && minor === 0 && patch >= 0) return addBounds(set, 0, 0, patch, lowerPrerelease, 0, 0, patch + 1, includePrerelease);
	return addBounds(set, major, minor, patch < 0 ? 0 : patch, lowerPrerelease, major, minor + 1, 0, includePrerelease);
}

/**
 * Drops the spaces node-semver drops before splitting a range into tokens: the space between an operator and its version (`>= 1.2.3`),
 * one of two spaces before a version, and the space after a tilde or caret (`~ 1.2`, `^ 1.2`). The first rule replays node-semver's
 * global `COMPARATORTRIM` expression in one linear pass: in the run of spaces, operators, `v` and `=` before a version, a match
 * starts at the run's last `<` or `>` (or at the run's start when it has none), and the search resumes after that version.
 * @param {string} text - The range, without hyphen ranges
 * @returns {string} The range with those spaces removed
 */
function joinOperators(text: string): string {
	let output = '';
	let copied = 0;
	let position = 0;
	for (;;) {
		let version = position;
		while (version < text.length && !isPartialStart(text.charCodeAt(version))) version++;
		if (version === text.length) break;

		let start = version;
		let comparison = -1;
		for (
			let code = text.charCodeAt(start - 1);
			start > position && (code === 32 || code === 60 || code === 61 || code === 62 || code === 118);
			code = text.charCodeAt(start - 1)
		) {
			start--;
			if (comparison < 0 && (code === 60 || code === 62)) comparison = start;
		}
		// The match's optional space, operator and space (the one dropped); starting at a space before `<` or `>` drops the same one.
		let index = comparison < 0 ? start : comparison;
		if (text.charCodeAt(index) === 32) index++;
		if (text.charCodeAt(index) === 60 || text.charCodeAt(index) === 62) index++;
		if (text.charCodeAt(index) === 61) index++;
		if (text.charCodeAt(index) === 32) {
			output += text.slice(copied, index);
			copied = index + 1;
		}
		position = readPartial(text, version);
	}
	return (output + text.slice(copied)).replace(/~>? /g, '~').replace(/\^ /g, '^');
}

/**
 * Desugars a hyphen range (`1.2.3 - 2.3.4`, `1.2 - 2`), as node-semver's `hyphenReplace`, into the comparators it means, written out
 * (so that, as in node-semver, they then go through {@link joinOperators} and {@link readToken}).
 * @param {string} text - The comparator set
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @returns {string | undefined} The comparators, or `undefined` when `text` is not a hyphen range
 */
function readHyphenRange(text: string, includePrerelease: boolean): string | undefined {
	const fromStart = text.charCodeAt(0) === 32 ? 1 : 0;
	let index = fromStart;
	while (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 61 || text.charCodeAt(index) === 118) index++;
	const fromEnd = readPartial(text, index);
	if (fromEnd < 0 || !text.startsWith(' - ', fromEnd)) return undefined;
	const fromMajor = partialMajor;
	const fromMinor = partialMinor;
	const fromPatch = partialPatch;
	const fromPrerelease = partialPrerelease;

	const toStart = fromEnd + 3;
	index = toStart;
	while (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 61 || text.charCodeAt(index) === 118) index++;
	const toEnd = readPartial(text, index);
	if (toEnd !== text.length && (toEnd !== text.length - 1 || text.charCodeAt(toEnd) !== 32)) return undefined;

	const zero = includePrerelease ? '-0' : '';
	const from =
		fromMajor < 0
			? ''
			: fromMinor < 0
				? `>=${fromMajor}.0.0${zero}`
				: fromPatch < 0
					? `>=${fromMajor}.${fromMinor}.0${zero}`
					: `>=${text.slice(fromStart, fromEnd)}${fromPrerelease === undefined ? zero : ''}`;
	const to =
		partialMajor < 0
			? ''
			: partialMinor < 0
				? `<${partialMajor + 1}.0.0-0`
				: partialPatch < 0
					? `<${partialMajor}.${partialMinor + 1}.0-0`
					: partialPrerelease !== undefined
						? `<=${partialMajor}.${partialMinor}.${partialPatch}-${partialPrerelease}`
						: includePrerelease
							? `<${partialMajor}.${partialMinor}.${partialPatch + 1}-0`
							: `<=${text.slice(toStart, toEnd)}`;
	return `${from} ${to}`;
}

/** {@link rangeFlags}: white space to collapse (other than single spaces, or perhaps non-ASCII white space). */
const FLAG_SPACING = 1;
/** {@link rangeFlags}: a `+` (perhaps build metadata). */
const FLAG_BUILD = 2;
/** {@link rangeFlags}: ` - ` (perhaps a hyphen range). */
const FLAG_HYPHEN = 4;
/** {@link rangeFlags}: a space after an operator, a tilde or a caret (perhaps one to drop, see {@link joinOperators}). */
const FLAG_JOIN = 8;
/** {@link rangeFlags}: a `|` (perhaps `||`). */
const FLAG_BAR = 16;

/**
 * Scans a range once for what may need rewriting, so that the common ranges skip every rewrite.
 * @param {string} text - The range
 * @returns {number} The `FLAG_*` bits found
 */
function rangeFlags(text: string): number {
	let hints = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 32) {
			const previous = text.charCodeAt(i - 1);
			if (previous === 32) hints |= FLAG_SPACING;
			else if (previous === 60 || previous === 61 || previous === 62 || previous === 94 || previous === 126) hints |= FLAG_JOIN;
			else if (previous === 45 && text.charCodeAt(i - 2) === 32) hints |= FLAG_HYPHEN;
		} else if (code === 43) hints |= FLAG_BUILD;
		else if (code === 124) hints |= FLAG_BAR;
		else if ((code >= 9 && code <= 13) || code >= 128) hints |= FLAG_SPACING;
	}
	return hints;
}

/**
 * Reads one comparator set of a range (the text between `||`): build metadata dropped, a hyphen range desugared, spaces after
 * operators dropped, then each space-separated token read.
 * @param {string} part - The comparator set, trimmed
 * @param {number} hints - The {@link rangeFlags} of the whole range
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @returns {SemverComparator[] | undefined} Its comparators (none when it allows any version), or `undefined` when it is invalid
 */
function readSet(part: string, hints: number, includePrerelease: boolean): SemverComparator[] | undefined {
	let text = part;
	// Once the text is rewritten, the hints no longer describe it.
	let rewritten = false;
	if ((hints & FLAG_BUILD) !== 0 && text.includes('+')) {
		text = text.replace(RANGE_BUILD_PATTERN, '');
		rewritten = true;
	}
	if ((rewritten || (hints & FLAG_HYPHEN) !== 0) && text.includes(' - ')) {
		const desugared = readHyphenRange(text, includePrerelease);
		if (desugared !== undefined) {
			text = desugared;
			rewritten = true;
		}
	}
	if (rewritten ? OPERATOR_SPACE_PATTERN.test(text) : (hints & FLAG_JOIN) !== 0) text = joinOperators(text);

	const set: SemverComparator[] = [];
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charCodeAt(i) === 32) {
			if (!readToken(text, start, i, includePrerelease, set)) return undefined;
			start = i + 1;
		}
	}
	return set;
}

/**
 * Compiles a range into comparator sets, as node-semver's `Range` constructor: white space collapsed, `||` alternatives read, and the
 * whole range reduced to "any version" when one alternative allows any version (which, as in node-semver, also stops the other
 * alternatives from letting pre-releases through).
 * @param {string} range - The range
 * @param {boolean} includePrerelease - Whether pre-releases are tested like releases
 * @returns {CompiledRange | undefined} The sets, or `undefined` when the range is invalid
 */
function compileRange(range: string, includePrerelease: boolean): CompiledRange | undefined {
	// Surrounding white space collapses into a single space, which each comparator set then trims (node-semver trims both).
	let text = range;
	let hints = rangeFlags(text);
	if ((hints & FLAG_SPACING) !== 0) {
		text = text.replace(/\s+/g, ' ');
		hints = rangeFlags(text);
	}

	const sets: SemverComparator[][] = [];
	let any = false;
	let start = 0;
	for (;;) {
		const bar = (hints & FLAG_BAR) === 0 ? -1 : text.indexOf('||', start);
		let end = bar < 0 ? text.length : bar;
		if (text.charCodeAt(start) === 32) start++;
		// After skipping the only character of a part (a space), `end` goes before `start`: the slice is empty either way.
		if (text.charCodeAt(end - 1) === 32) end--;
		const set = readSet(text.slice(start, end), hints, includePrerelease);
		if (set === undefined) return undefined;
		if (set.length === 0) any = true;
		sets.push(set);
		if (bar < 0) return any ? [[]] : sets;
		start = bar + 2;
	}
}

/**
 * Reads the `includePrerelease` option.
 * @param {string} caller - The public function, for error messages
 * @param {SemverRangeOptions | undefined} options - The options
 * @returns {boolean} The option's value (`false` when unset)
 * @throws {TypeError} when `options` is not an object or `includePrerelease` is not a boolean
 */
function readIncludePrerelease(caller: string, options: SemverRangeOptions | undefined): boolean {
	if (options === undefined) return false;
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);
	const value = ownOption(options, 'includePrerelease');
	if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${caller}: \`includePrerelease\` must be a boolean, got ${describe(value)}`);
	return value === true;
}

/**
 * Checks whether a version satisfies a semver range, with the semantics of npm and node-semver 7.8.5 (`semver.satisfies` without
 * `loose`), which it matches on every input of its range grammar:
 *
 * - `||` separates alternatives; within one, space-separated comparators must all hold.
 * - Comparators: `<`, `<=`, `>`, `>=`, `=` or none, before a version that may start with `v`; partial versions are X-ranges
 *   (`1.x`, `1.2.*`, `1`, `*`, `x` and `''` match any release; `>1.2` is `>=1.3.0`, `<=1.2` is `<1.3.0-0`).
 * - Hyphen ranges: `1.2.3 - 2.3.4` is `>=1.2.3 <=2.3.4`; partial ends widen (`1.2 - 2` is `>=1.2.0 <3.0.0-0`).
 * - Tilde: `~1.2.3` is `>=1.2.3 <1.3.0-0`, `~1.2` is `>=1.2.0 <1.3.0-0`, `~1` is `>=1.0.0 <2.0.0-0` (`~>` too).
 * - Caret: `^1.2.3` is `>=1.2.3 <2.0.0-0`, `^0.2.3` is `>=0.2.3 <0.3.0-0`, `^0.0.3` is `>=0.0.3 <0.0.4-0`, `^1.x` is `>=1.0.0 <2.0.0-0`.
 * - Pre-releases: unless `includePrerelease` is set, a pre-release version only satisfies an alternative that has a comparator on a
 *   pre-release of the same `major.minor.patch` (`1.2.3-beta.2` satisfies `>=1.2.3-beta.1`, `1.2.4-beta` does not).
 * - Build metadata is ignored, in the version and in the range. White space between an operator, `~` or `^` and its version is
 *   allowed, as node-semver allows it.
 *
 * The version follows node-semver's parser: a semantic version as {@link isSemver} accepts it, optionally with one leading `v` and
 * surrounding white space, at most 256 characters long, with major, minor and patch numbers up to `Number.MAX_SAFE_INTEGER`.
 * Pre-release numbers are compared exactly at any size (node-semver rounds the ones beyond `Number.MAX_SAFE_INTEGER`).
 *
 * Like node-semver, an invalid version or range (or one that is not a string) gives `false` rather than throwing: check ranges with
 * {@link isSemverRange}, or compile them with {@link compileSemverRange}, which throws, to catch mistakes. Nothing is cached: compile
 * a range that is tested repeatedly. Linear in the length of the range.
 * @param {string} version - The version to test
 * @param {string} range - The range
 * @param {SemverRangeOptions} [options] - `includePrerelease` (default `false`)
 * @returns {boolean} `true` when `version` is a valid version that satisfies the valid range `range`
 * @throws {TypeError} when `options` is not an object or `includePrerelease` is not a boolean
 * @example
 * satisfiesSemver('1.4.2', '^1.2.0'); // => true
 * satisfiesSemver('2.0.0', '^1.2.0'); // => false
 * satisfiesSemver('0.3.0', '^0.2.3'); // => false
 * satisfiesSemver('1.2.9', '~1.2'); // => true
 * satisfiesSemver('3.4.0', '1.2.3 - 3.4'); // => true
 * satisfiesSemver('1.5.0', '<1.0.0 || >=1.5.0 <2'); // => true
 * satisfiesSemver('v1.2.3', '>= 1.2.3'); // => true
 * satisfiesSemver('1.3.0-beta', '^1.2.0'); // => false
 * satisfiesSemver('1.3.0-beta', '^1.2.0', { includePrerelease: true }); // => true
 * satisfiesSemver('1.2.0-rc.2', '^1.2.0-rc.1'); // => true
 * satisfiesSemver('1.2.3', 'not a range'); // => false
 */
export function satisfiesSemver(version: string, range: string, options?: SemverRangeOptions): boolean {
	const includePrerelease = readIncludePrerelease('satisfiesSemver', options);
	const parsed = readVersion(version);
	if (parsed === undefined || typeof range !== 'string') return false;
	const compiled = compileRange(range, includePrerelease);
	return compiled !== undefined && testRange(compiled, parsed, includePrerelease);
}

/**
 * Compiles a semver range into a predicate, for testing many versions against the same range: the range is parsed once, and each
 * test only reads the version (no regular expression; a release allocates only the small object holding its numbers). The semantics are
 * those of {@link satisfiesSemver}.
 * @param {string} range - The range
 * @param {SemverRangeOptions} [options] - `includePrerelease` (default `false`)
 * @returns {(version: string) => boolean} A predicate telling whether a version satisfies the range (`false` for an invalid version)
 * @throws {TypeError} when `range` is not a valid range (see {@link isSemverRange}), `options` is not an object or `includePrerelease` is
 * not a boolean
 * @example
 * const supported = compileSemverRange('^18.18.0 || >=20.9.0');
 * supported('18.19.1'); // => true
 * supported('19.0.0'); // => false
 * ['16.20.2', '20.11.0', '22.1.0'].filter(supported); // => ['20.11.0', '22.1.0']
 * compileSemverRange('>=1.2.3.4'); // throws TypeError
 */
export function compileSemverRange(range: string, options?: SemverRangeOptions): (version: string) => boolean {
	const includePrerelease = readIncludePrerelease('compileSemverRange', options);
	if (typeof range !== 'string') throw new TypeError(`compileSemverRange: \`range\` must be a string, got ${describe(range)}`);
	const compiled = compileRange(range, includePrerelease);
	if (compiled === undefined) throw new TypeError(`compileSemverRange: ${quoteValue(range)} is not a valid semver range`);

	return function (version: string): boolean {
		const parsed = readVersion(version);
		return parsed !== undefined && testRange(compiled, parsed, includePrerelease);
	};
}

/**
 * Checks whether a value is a semver range that {@link satisfiesSemver} and node-semver accept (node-semver's `validRange` not returning `null`).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @param {SemverRangeOptions} [options] - `includePrerelease` (default `false`), which makes a few ranges at the edge of
 * `Number.MAX_SAFE_INTEGER` invalid, as in node-semver
 * @returns {boolean} `true` when `value` is a string holding a valid range
 * @throws {TypeError} when `options` is not an object or `includePrerelease` is not a boolean
 * @example
 * isSemverRange('^1.2.3 || ~2.0'); // => true
 * isSemverRange('>= 1.2.3 < 2'); // => true
 * isSemverRange(''); // => true // any version
 * isSemverRange('>=1.2.3.4'); // => false
 * isSemverRange('^1.2.3 ||| 2'); // => false
 */
export function isSemverRange(value: unknown, options?: SemverRangeOptions): value is string {
	const includePrerelease = readIncludePrerelease('isSemverRange', options);
	return typeof value === 'string' && compileRange(value, includePrerelease) !== undefined;
}

/**
 * Finds the highest or lowest version of a list that satisfies a range.
 * @param {string} caller - The public function, for error messages
 * @param {Iterable<string>} versions - The versions
 * @param {string} range - The range
 * @param {SemverRangeOptions | undefined} options - The options
 * @param {number} wanted - {@link GREATER} for the highest version, {@link LESS} for the lowest
 * @returns {string | undefined} The version as given, or `undefined`
 * @throws {TypeError} when `versions` is not an iterable or is a string, or the options are invalid
 */
function pickSatisfying(caller: string, versions: Iterable<string>, range: string, options: SemverRangeOptions | undefined, wanted: number): string | undefined {
	const includePrerelease = readIncludePrerelease(caller, options);
	if (typeof versions === 'string' || typeof (versions as Partial<Iterable<string>> | null)?.[Symbol.iterator] !== 'function') {
		throw new TypeError(`${caller}: \`versions\` must be an iterable of strings, got ${describe(versions)}`);
	}
	const compiled = typeof range === 'string' ? compileRange(range, includePrerelease) : undefined;
	if (compiled === undefined) return undefined;

	let best: string | undefined;
	let bestVersion: ParsedVersion | undefined;
	for (const version of versions) {
		const parsed = readVersion(version);
		if (parsed !== undefined && testRange(compiled, parsed, includePrerelease) && (bestVersion === undefined || orderVersions(parsed, bestVersion) === wanted)) {
			best = version;
			bestVersion = parsed;
		}
	}
	return best;
}

/**
 * Finds the highest version of a list that satisfies a range (node-semver's `maxSatisfying`): versions are tested as by
 * {@link satisfiesSemver} (invalid ones are skipped) and compared by precedence, the first of equal versions winning (`1.0.0+a` and
 * `1.0.0+b` are equal). One pass, the range compiled once.
 * @param {Iterable<string>} versions - The candidate versions
 * @param {string} range - The range
 * @param {SemverRangeOptions} [options] - `includePrerelease` (default `false`)
 * @returns {string | undefined} The highest satisfying version, as given, or `undefined` when none satisfies the range or the range is invalid
 * @throws {TypeError} when `versions` is not an iterable (or is a string), `options` is not an object or `includePrerelease` is not a boolean
 * @example
 * maxSatisfyingSemver(['1.2.3', '1.4.0', '2.0.0', '1.5.0-beta'], '^1.2.0'); // => '1.4.0'
 * maxSatisfyingSemver(['1.2.3', '1.4.0', '2.0.0', '1.5.0-beta'], '^1.2.0', { includePrerelease: true }); // => '1.5.0-beta'
 * maxSatisfyingSemver(['1.2.3'], '^2.0.0'); // => undefined
 */
export function maxSatisfyingSemver(versions: Iterable<string>, range: string, options?: SemverRangeOptions): string | undefined {
	return pickSatisfying('maxSatisfyingSemver', versions, range, options, GREATER);
}

/**
 * Finds the lowest version of a list that satisfies a range (node-semver's `minSatisfying`), like {@link maxSatisfyingSemver}.
 * @param {Iterable<string>} versions - The candidate versions
 * @param {string} range - The range
 * @param {SemverRangeOptions} [options] - `includePrerelease` (default `false`)
 * @returns {string | undefined} The lowest satisfying version, as given, or `undefined` when none satisfies the range or the range is invalid
 * @throws {TypeError} when `versions` is not an iterable (or is a string), `options` is not an object or `includePrerelease` is not a boolean
 * @example
 * minSatisfyingSemver(['1.2.3', '1.4.0', '2.0.0'], '>=1.3'); // => '1.4.0'
 * minSatisfyingSemver(new Set(['v2.1.0', 'v2.0.1']), '2.x'); // => 'v2.0.1'
 */
export function minSatisfyingSemver(versions: Iterable<string>, range: string, options?: SemverRangeOptions): string | undefined {
	return pickSatisfying('minSatisfyingSemver', versions, range, options, LESS);
}

/**
 * Applies node-semver's `pre` step: bumps the last numeric pre-release identifier (or appends a counter), then switches to
 * `identifier` unless the pre-release already continues it with a number.
 * @param {(string | number)[]} prerelease - The pre-release identifiers (modified)
 * @param {string | undefined} identifier - The wanted identifiers
 * @param {'0' | '1' | false | undefined} base - The `identifierBase` option
 * @returns {(string | number)[]} The new pre-release identifiers
 * @throws {RangeError} when `base` is `false` and the pre-release already is `identifier`
 */
function bumpPrerelease(prerelease: (string | number)[], identifier: string | undefined, base: '0' | '1' | false | undefined): (string | number)[] {
	const counter = base === '1' ? 1 : 0;
	let index = prerelease.length;
	while (--index >= 0 && typeof prerelease[index] !== 'number');
	if (index >= 0) prerelease[index] = (prerelease[index] as number) + 1;
	else if (base === false && identifier === prerelease.join('.')) {
		throw new RangeError(`incrementSemver: the pre-release is already ${quoteValue(identifier)}`);
	} else prerelease.push(counter);
	if (identifier === undefined) return prerelease;

	const wanted = identifier.split('.');
	// `Number` as node-semver's `isNaN`: past the end, or an identifier such as `beta`, is not a number (but `1e5` is). Past the end is
	// not read: a hole would be looked up on a polluted `Object.prototype`.
	let continues = wanted.length < prerelease.length && !Number.isNaN(Number(prerelease[wanted.length]));
	for (let i = 0; continues && i < wanted.length; i++) continues = String(prerelease[i]) === wanted[i];
	return continues ? prerelease : base === false ? [identifier] : [identifier, counter];
}

/**
 * Increments a version, with the semantics of node-semver 7.8.5's `inc` (`semver.inc(version, release, identifier, identifierBase)`):
 *
 * - `major`, `minor`, `patch`: the next release of that kind, except that a pre-release of it is released (`1.3.0-rc.1` → `1.3.0` for
 *   `minor`, `2.0.0-rc.1` → `2.0.0` for `major`, `1.2.4-0` → `1.2.4` for `patch`).
 * - `premajor`, `preminor`, `prepatch`: the next such release's first pre-release (`1.2.3` → `2.0.0-0`, `1.3.0-0`, `1.2.4-0`).
 * - `prerelease`: the next pre-release: the last numeric identifier is bumped (`1.2.4-beta.1` → `1.2.4-beta.2`), a counter is appended
 *   when there is none (`1.2.4-beta` → `1.2.4-beta.0`), and a release becomes the next patch's first pre-release (`1.2.3` → `1.2.4-0`).
 * - `release`: the release of a pre-release (`1.2.4-rc.1` → `1.2.4`).
 *
 * `identifier` names the pre-release (`prerelease` with `'beta'`: `1.2.4-alpha.3` → `1.2.4-beta.0`, `1.2.4-beta.3` → `1.2.4-beta.4`);
 * `identifierBase: '1'` starts counters at 1 and `false` appends none (`1.2.3` → `1.2.4-beta`). Build metadata is dropped. The version
 * is read like node-semver reads it (see {@link satisfiesSemver}): a leading `v` and surrounding white space are allowed and dropped.
 *
 * Where node-semver returns `null`, this throws, and it also throws instead of producing a number beyond `Number.MAX_SAFE_INTEGER`,
 * which node-semver cannot read (like node-semver, it does not check that the result fits in 256 characters). `identifier` is
 * validated for every release kind (node-semver ignores it for `major`, `minor`, `patch` and `release`).
 * @param {string} version - The version
 * @param {SemverRelease} releaseType - The kind of increment
 * @param {IncrementSemverOptions} [options] - `identifier` and `identifierBase` (default `'0'`)
 * @returns {string} The incremented version, without build metadata
 * @throws {TypeError} when `version` is not a valid version, `releaseType` or `identifier` is not a string, `options` is not an object or
 * `identifierBase` is not `'0'`, `'1'` or `false`
 * @throws {RangeError} when `releaseType` is not a release kind, `identifier` is not dot-separated pre-release identifiers, `releaseType` is
 * `'release'` and `version` is not a pre-release, a `pre*` release has `identifierBase: false` without `identifier` or would not change
 * the version, or a number would exceed `Number.MAX_SAFE_INTEGER`
 * @example
 * incrementSemver('1.2.3', 'minor'); // => '1.3.0'
 * incrementSemver('1.3.0-rc.1', 'minor'); // => '1.3.0'
 * incrementSemver('1.2.3', 'premajor'); // => '2.0.0-0'
 * incrementSemver('1.2.3', 'prerelease', { identifier: 'beta' }); // => '1.2.4-beta.0'
 * incrementSemver('1.2.4-beta.0', 'prerelease', { identifier: 'beta' }); // => '1.2.4-beta.1'
 * incrementSemver('1.2.4-beta.1', 'prerelease', { identifier: 'rc', identifierBase: '1' }); // => '1.2.4-rc.1'
 * incrementSemver('1.2.3', 'preminor', { identifier: 'alpha', identifierBase: false }); // => '1.3.0-alpha'
 * incrementSemver('v1.2.4-rc.1+build.5', 'release'); // => '1.2.4'
 * incrementSemver('1.2.3', 'release'); // throws RangeError
 * incrementSemver('1.2', 'patch'); // throws TypeError
 */
export function incrementSemver(version: string, releaseType: SemverRelease, options?: IncrementSemverOptions): string {
	const parsed = readVersion(version);
	if (parsed === undefined) throw new TypeError(`incrementSemver: ${quoteValue(version)} is not a valid semantic version`);
	if (typeof releaseType !== 'string') throw new TypeError(`incrementSemver: \`releaseType\` must be a string, got ${describe(releaseType)}`);
	if (options !== undefined && (typeof options !== 'object' || options === null)) {
		throw new TypeError(`incrementSemver: \`options\` must be an object, got ${describe(options)}`);
	}
	const base = options === undefined ? undefined : ownOption(options, 'identifierBase');
	if (base !== undefined && base !== false && base !== '0' && base !== '1') {
		throw new (typeof base === 'string' ? RangeError : TypeError)(`incrementSemver: \`identifierBase\` must be '0', '1' or false, got ${quoteValue(base)}`);
	}
	const written = options === undefined ? undefined : ownOption(options, 'identifier');
	if (written !== undefined && typeof written !== 'string') throw new TypeError(`incrementSemver: \`identifier\` must be a string, got ${describe(written)}`);
	// As in node-semver, an empty identifier is no identifier.
	const identifier = written === '' ? undefined : written;
	if (identifier !== undefined && readPrerelease(identifier, 0) !== identifier.length) {
		throw new RangeError(`incrementSemver: \`identifier\` must be dot-separated pre-release identifiers, got ${quoteValue(identifier)}`);
	}
	if (releaseType.startsWith('pre') && identifier === undefined && base === false) {
		throw new RangeError('incrementSemver: `identifierBase: false` needs an `identifier`');
	}

	let { major, minor, patch } = parsed;
	let prerelease = parsed.prerelease ?? [];
	switch (releaseType) {
		case 'major':
			if (minor !== 0 || patch !== 0 || prerelease.length === 0) major++;
			minor = 0;
			patch = 0;
			prerelease = [];
			break;
		case 'minor':
			if (patch !== 0 || prerelease.length === 0) minor++;
			patch = 0;
			prerelease = [];
			break;
		case 'patch':
			if (prerelease.length === 0) patch++;
			prerelease = [];
			break;
		case 'release':
			if (prerelease.length === 0) throw new RangeError(`incrementSemver: ${quoteValue(version)} is not a pre-release`);
			prerelease = [];
			break;
		case 'premajor':
			major++;
			minor = 0;
			patch = 0;
			prerelease = bumpPrerelease([], identifier, base);
			break;
		case 'preminor':
			minor++;
			patch = 0;
			prerelease = bumpPrerelease([], identifier, base);
			break;
		case 'prepatch':
			patch++;
			prerelease = bumpPrerelease([], identifier, base);
			break;
		case 'prerelease':
			if (prerelease.length === 0) patch++;
			prerelease = bumpPrerelease(prerelease, identifier, base);
			break;
		default:
			throw new RangeError(
				`incrementSemver: \`releaseType\` must be 'major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease' or 'release', got ${quoteValue(releaseType)}`
			);
	}
	if (Math.max(major, minor, patch) > Number.MAX_SAFE_INTEGER) throw new RangeError(`incrementSemver: incrementing ${quoteValue(version)} exceeds Number.MAX_SAFE_INTEGER`);
	return prerelease.length === 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${prerelease.join('.')}`;
}

/**
 * Tells whether the year, month and day captured by {@link DATE_PATTERN} or {@link DATE_TIME_PATTERN} name an existing date (the same check
 * as `parseISODate` from the date module, without building a `Date`).
 * @param {RegExpExecArray | null} match - The match, or `null` when the pattern did not match
 * @returns {boolean} `true` when there is a match whose month is 1–12 and whose day exists in that month (leap years included)
 */
function isCalendarDate(match: RegExpExecArray | null): boolean {
	if (match === null) return false;

	const month = Number(match[2]);
	const day = Number(match[3]);

	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(match[1]), month - 1);
}

/**
 * Checks whether a value is an ISO 8601 / RFC 3339 calendar date in the `YYYY-MM-DD` form that is an actual date
 * (`2023-02-29` and `2024-04-31` are rejected; leap years are handled).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a valid calendar date
 * @example
 * isIsoDateString('2024-02-29'); // => true
 * isIsoDateString('2023-02-29'); // => false
 * isIsoDateString('2024-1-5'); // => false
 * isIsoDateString('2024-01-05T00:00:00Z'); // => false
 */
export function isIsoDateString(value: unknown): value is string {
	return isCalendarDate(typeof value === 'string' ? DATE_PATTERN.exec(value) : null);
}

/**
 * Checks whether a value is an RFC 3339 date-time: `YYYY-MM-DD`, `T`, `hh:mm:ss`, an optional fraction of a second,
 * then `Z` or a `±hh:mm` offset (`T` and `Z` may be lowercase, as RFC 3339 allows). The date must exist (leap days included),
 * hours are `00`–`23`, minutes and seconds `00`–`59`, and offsets up to `±23:59`.
 *
 * Leap seconds (`23:59:60`) are rejected, as JavaScript dates cannot represent them. A space instead of `T`, missing seconds
 * and missing offsets (local times) are rejected too.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a valid RFC 3339 date-time
 * @example
 * isIsoDateTimeString('2024-02-29T13:45:00Z'); // => true
 * isIsoDateTimeString('2024-02-29T13:45:00.123+05:30'); // => true
 * isIsoDateTimeString(new Date(0).toISOString()); // => true
 * isIsoDateTimeString('2023-02-29T13:45:00Z'); // => false
 * isIsoDateTimeString('2024-01-01T24:00:00Z'); // => false
 * isIsoDateTimeString('2016-12-31T23:59:60Z'); // => false
 * isIsoDateTimeString('2024-01-01T12:00:00'); // => false
 */
export function isIsoDateTimeString(value: unknown): value is string {
	return isCalendarDate(typeof value === 'string' ? DATE_TIME_PATTERN.exec(value) : null);
}

/**
 * Validates a string of digits with the Luhn (mod 10) checksum used by payment card numbers, IMEIs and similar identifiers.
 * @param {string} digits - The digits, check digit last (no spaces or other characters)
 * @returns {boolean} `true` when `digits` is a non-empty string of ASCII digits whose Luhn checksum is valid; `false` otherwise, including for any other input
 * @example
 * luhnCheck('79927398713'); // => true
 * luhnCheck('79927398710'); // => false
 * luhnCheck('7992 7398 713'); // => false
 */
export function luhnCheck(digits: string): boolean {
	if (typeof digits !== 'string' || !DIGITS_PATTERN.test(digits)) return false;

	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let digit = digits.charCodeAt(i) - 48;
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}

	return sum % 10 === 0;
}

/**
 * Checks whether a value looks like a payment card number: 12 to 19 digits, not all zeros, optionally grouped with single spaces or dashes
 * between digits, that pass the Luhn checksum (see {@link luhnCheck}). The issuer (IIN range) is not checked.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a plausible card number
 * @example
 * isCreditCardNumber('4111 1111 1111 1111'); // => true
 * isCreditCardNumber('4111-1111-1111-1111'); // => true
 * isCreditCardNumber('4111111111111112'); // => false
 * isCreditCardNumber('4111  1111 1111 1111'); // => false
 * isCreditCardNumber('0000 0000 0000 0000'); // => false
 */
export function isCreditCardNumber(value: unknown): value is string {
	// At most 19 digits with a separator between each two: longer strings (up to millions of characters, which overflowed the pattern's
	// backtracking stack) are rejected first.
	if (typeof value !== 'string' || value.length > 37 || !CARD_PATTERN.test(value)) return false;
	const digits = value.replace(/[ -]/g, '');
	return digits.length >= 12 && digits.length <= 19 && /[1-9]/.test(digits) && luhnCheck(digits);
}

/**
 * Checks whether a value is a string that `JSON.parse` accepts (any JSON text, including `'1'`, `'"text"'` and `'null'`).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding valid JSON
 * @example
 * isJsonString('{"a":[1,2]}'); // => true
 * isJsonString('null'); // => true
 * isJsonString("{a: 1}"); // => false
 * isJsonString(''); // => false
 */
export function isJsonString(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks whether a value is base64 (RFC 4648 §4) or, with `urlSafe`, base64url (§5) text. White space and line breaks are not allowed,
 * at most two `=` may end the string, and the length must be possible for encoded data (a remainder of 1 character modulo 4 never is).
 * When padded, the total length must be a multiple of 4. The empty string is valid (it encodes zero bytes).
 *
 * Only canonical encodings are accepted (RFC 4648 §3.5): the bits of the last character that encode no data must be zero, so every byte
 * sequence has a single valid (padded or unpadded) spelling — `'YQ=='` is valid, `'YR=='`, which also decodes to `'a'`, is not. Strings
 * that pass can therefore be compared as text (tokens, signatures, cache keys) without decoding them first.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @param {IsBase64Options} [options={}] - `urlSafe` (default `false`): use the `-` / `_` alphabet;
 * `padding` (default `'optional'`): whether `=` padding is `'optional'`, `'required'` or `'forbidden'`
 * @returns {boolean} `true` when `value` is a string holding base64 text that satisfies the options
 * @throws {RangeError} when `options.padding` is not `'optional'`, `'required'` or `'forbidden'`
 * @example
 * isBase64('aGVsbG8='); // => true
 * isBase64('aGVsbG8'); // => true
 * isBase64('aGVsbG8', { padding: 'required' }); // => false
 * isBase64('aGVsbG8=', { padding: 'forbidden' }); // => false
 * isBase64('a-_b', { urlSafe: true }); // => true
 * isBase64('a-_b'); // => false
 * isBase64('aGVsbG8==='); // => false
 * isBase64('YR=='); // => false
 */
export function isBase64(value: unknown, options: IsBase64Options = {}): value is string {
	// Own properties only, like `fromBase64` of the encoding module: a polluted `Object.prototype` cannot switch the alphabet or the mode.
	const urlSafe = hasOwn.call(options, 'urlSafe') ? options.urlSafe : false;
	const padding = (hasOwn.call(options, 'padding') ? options.padding : undefined) ?? 'optional';
	if (padding !== 'optional' && padding !== 'required' && padding !== 'forbidden') {
		throw new RangeError(`isBase64: \`padding\` must be 'optional', 'required' or 'forbidden', got ${show(padding)}`);
	}
	if (typeof value !== 'string' || !(urlSafe ? BASE64_URL_PATTERN : BASE64_PATTERN).test(value)) return false;

	// The pattern only allows `=` at the end. `end` is the length of the data characters; a final quantum of 2 (3) of them encodes one
	// (two) bytes, leaving the 4 (2) low bits of its last character unused.
	const end = value.length - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
	const remainder = end % 4;
	if (end < value.length ? padding === 'forbidden' || value.length % 4 !== 0 : remainder !== 0 && (remainder === 1 || padding === 'required')) return false;

	return remainder === 0 || (sextet(value.charCodeAt(end - 1)) & (remainder === 2 ? 15 : 3)) === 0;
}

/**
 * Returns the 6-bit value of a base64 or base64url character.
 * @param {number} code - The character code of an alphabet character
 * @returns {number} `0`–`63`
 */
function sextet(code: number): number {
	if (code >= 97) return code - 71;
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 48 && code <= 57) return code + 4;
	// `+` / `-` is 62 and `/` / `_` is 63: both have their 2 low bits set, which is all the caller tests.
	return 63;
}

/**
 * Checks whether a value is a URL slug: lowercase ASCII letters and digits in runs separated by single hyphens,
 * with no leading or trailing hyphen. Every non-empty result of `toSlug` from the strings module is a slug.
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a slug
 * @example
 * isSlug('hello-world-2'); // => true
 * isSlug('Hello-World'); // => false
 * isSlug('hello--world'); // => false
 * isSlug('-hello'); // => false
 * isSlug(''); // => false
 */
export function isSlug(value: unknown): value is string {
	return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/**
 * Checks whether a value is a string holding a finite decimal number: an optional sign, digits with an optional fraction
 * (`1`, `1.5`, `1.`, `.5`) and an optional exponent (`1e-7`, `2.5E+3`). `Number(value)` is then guaranteed to be finite.
 *
 * Rejected: the empty string, white space anywhere, hex/octal/binary literals (`0x1f`), numeric separators (`1_000`),
 * `Infinity`, `NaN`, and values that overflow to `±Infinity` (`1e400`).
 * Like every `value is string` predicate, the `false` branch also removes `string` from the type: when `value` may be a
 * non-matching string, test `typeof value === 'string'` there.
 * @param {unknown} value - The value to check
 * @returns {boolean} `true` when `value` is a string holding a finite decimal number
 * @example
 * isNumericString('-12.5e3'); // => true
 * isNumericString('.5'); // => true
 * isNumericString(String(0.1 + 0.2)); // => true
 * isNumericString(' 1'); // => false
 * isNumericString('0x1f'); // => false
 * isNumericString('Infinity'); // => false
 * isNumericString('1e400'); // => false
 * isNumericString(''); // => false
 */
export function isNumericString(value: unknown): value is string {
	return typeof value === 'string' && NUMERIC_PATTERN.test(value) && Number.isFinite(Number(value));
}

/**
 * What {@link parseJson} does with the keys that turn parsed JSON into a prototype-pollution payload: an own `__proto__` key, and a
 * `constructor` key whose value is an object with a `prototype` key. `'error'` fails the parse, `'remove'` deletes those keys (the whole
 * `constructor` property), `'ignore'` keeps them (plain `JSON.parse` behaviour).
 */
export type ProtoAction = 'error' | 'remove' | 'ignore';

/**
 * Options accepted by {@link parseJson}. A polluted `Object.prototype` cannot set one.
 */
export interface ParseJsonOptions {
	/** What to do with `__proto__` and `constructor.prototype` keys. Defaults to `'error'`. */
	readonly proto?: ProtoAction;
}

/**
 * The outcome of {@link parseJson}: `[undefined, value]` on success, `[error, undefined]` on failure. It is assignable to the
 * `Result` tuple of `functions.attempt`, with a precise error type.
 * @template T - The parsed (and validated) type
 */
export type ParseJsonResult<T> = [error: SyntaxError | TypeError | ValidationError, value: undefined] | [error: undefined, value: T];

/** Text that may hold a forbidden key: spelled out, or hidden behind a `\u` escape. */
const PROTO_HINT = /__proto__|constructor|\\u/;

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Finds (or, with `remove`, deletes) the forbidden keys of a parsed JSON value. Iterative, so deep values cannot overflow the stack.
 * @param {object} root - An object or array returned by `JSON.parse`
 * @param {boolean} remove - Delete the keys instead of reporting the first one
 * @returns {string | undefined} The first forbidden key found (`undefined` when there is none, or when removing)
 */
function findProtoKey(root: object, remove: boolean): string | undefined {
	const stack = [root];

	while (stack.length > 0) {
		const node = stack.pop() as Record<string, unknown>;

		if (Array.isArray(node)) {
			for (let index = 0; index < node.length; index++) pushObject(stack, node[index]);
			continue;
		}
		if (hasOwn.call(node, '__proto__')) {
			if (!remove) return '__proto__';
			delete node['__proto__'];
		}

		const constructor = hasOwn.call(node, 'constructor') ? node['constructor'] : undefined;

		if (typeof constructor === 'object' && constructor !== null && hasOwn.call(constructor, 'prototype')) {
			if (!remove) return 'constructor.prototype';
			delete node['constructor'];
		}
		// Own keys only (all `JSON.parse` creates): `for…in` would also walk an object-valued key of a polluted `Object.prototype`, which
		// holds itself through that very key, forever.
		for (const key of Object.keys(node)) pushObject(stack, node[key]);
	}

	return undefined;
}

/**
 * Pushes `value` onto `stack` when it is an object (primitives hold no keys to scan).
 * @param {object[]} stack - The stack
 * @param {unknown} value - The value
 * @returns {void}
 */
function pushObject(stack: object[], value: unknown): void {
	if (typeof value === 'object' && value !== null) stack.push(value);
}

/**
 * Parses JSON text without throwing, returning a `[error, value]` tuple (see {@link ParseJsonResult}). With a guard (any guard of the
 * guards module: `isShape`, `isArrayOf`, `isMatching`, …) the value is also validated: the result is typed by the guard, and invalid
 * data gives a `ValidationError` whose `issues` carry the path of every problem (see the guards module's `explain`).
 *
 * Unlike `JSON.parse`, the parsed value cannot carry a prototype-pollution payload. `JSON.parse('{"__proto__": {"admin": true}}')`
 * creates an OWN `__proto__` property, harmless by itself, but a later `Object.assign`, spread-into-class or naive deep merge
 * writes it through the `__proto__` setter and replaces (or pollutes) a prototype. With the default `proto: 'error'` such text fails
 * with a `SyntaxError` (like secure-json-parse): legitimate JSON never needs these keys, so their presence is a signal that should be
 * seen, not silently repaired; `'remove'` deletes them instead (for lenient ingestion), and `'ignore'` keeps them. Keys hidden behind
 * `\u` escapes are found too. Text without `__proto__`, `constructor` or a `\u` escape skips the check entirely.
 *
 * Errors are returned, not thrown: a `SyntaxError` for invalid JSON (with the engine's message) or a forbidden key, a `TypeError` when
 * `text` is not a string, a `ValidationError` when the guard rejects the value. Only programming errors throw: an invalid `guard` or
 * `options`, or a guard that throws itself.
 * @param {string} text - The JSON text
 * @param {ParseJsonOptions} [options] - `proto` (default `'error'`): what to do with `__proto__` and `constructor.prototype` keys
 * @returns {ParseJsonResult<JsonValue>} `[undefined, value]` on success, `[error, undefined]` on failure
 * @throws {TypeError} when `options` is not an object
 * @throws {RangeError} when `options.proto` is not `'error'`, `'remove'` or `'ignore'`
 * @example
 * parseJson('{"a":[1,2]}'); // => [undefined, { a: [1, 2] }]
 * const [error] = parseJson('{bad');
 * error instanceof SyntaxError; // => true
 * parseJson('{"__proto__":{"admin":true}}')[0] instanceof SyntaxError; // => true
 * parseJson('{"a":1,"__proto__":{"admin":true}}', { proto: 'remove' }); // => [undefined, { a: 1 }]
 */
export function parseJson(text: string, options?: ParseJsonOptions): ParseJsonResult<JsonValue>;
/**
 * Parses JSON text without throwing and validates the value with `guard`.
 * @template T - The type the guard narrows to
 * @param {string} text - The JSON text
 * @param {Guard<T>} guard - The guard the parsed value must pass
 * @param {ParseJsonOptions} [options] - `proto` (default `'error'`): what to do with `__proto__` and `constructor.prototype` keys
 * @returns {ParseJsonResult<T>} `[undefined, value]` on success, `[error, undefined]` on failure
 * @throws {TypeError} when `guard` is not a function or `options` is not an object
 * @throws {RangeError} when `options.proto` is not `'error'`, `'remove'` or `'ignore'`
 * @example
 * import { isShape, isInteger, ValidationError } from 'tinkit/guards';
 * const isConfig = isShape({ port: isInteger });
 * parseJson('{"port":8080}', isConfig); // => [undefined, { port: 8080 }]
 * const [error] = parseJson('{"port":"80"}', isConfig);
 * error instanceof ValidationError; // => true
 * (error as ValidationError).issues; // => [{ message: 'Invalid value (got string)', path: ['port'] }]
 */
export function parseJson<T>(text: string, guard: Guard<T>, options?: ParseJsonOptions): ParseJsonResult<T>;
/**
 * Implementation of the overloads above.
 * @param {string} text - The JSON text
 * @param {Guard<unknown> | ParseJsonOptions} [guardOrOptions] - The guard, or the options
 * @param {ParseJsonOptions} [options] - The options, after a guard
 * @returns {ParseJsonResult<unknown>} The outcome
 * @example
 * parseJson('1'); // => [undefined, 1]
 */
export function parseJson(text: string, guardOrOptions?: Guard<unknown> | ParseJsonOptions, options?: ParseJsonOptions): ParseJsonResult<unknown> {
	const guard = typeof guardOrOptions === 'function' ? guardOrOptions : undefined;

	if (guard === undefined && guardOrOptions !== undefined) options = guardOrOptions as ParseJsonOptions;
	if (options !== undefined && (typeof options !== 'object' || options === null)) {
		throw new TypeError(`parseJson: \`options\` must be an object, got ${describe(options)}`);
	}

	// Not read from a polluted `Object.prototype`, where a planted `proto: 'ignore'` would turn the check off.
	const proto = (options === undefined ? undefined : readOption(options, 'proto')) ?? 'error';

	if (proto !== 'error' && proto !== 'remove' && proto !== 'ignore') {
		throw new RangeError(`parseJson: \`proto\` must be 'error', 'remove' or 'ignore', got ${show(proto)}`);
	}
	if (typeof text !== 'string') return [new TypeError(`parseJson: \`text\` must be a string, got ${describe(text)}`), undefined];

	let value: unknown;

	try {
		value = JSON.parse(text);
	} catch (error) {
		return [error as SyntaxError, undefined];
	}
	if (proto !== 'ignore' && PROTO_HINT.test(text)) {
		const key = typeof value === 'object' && value !== null ? findProtoKey(value, proto === 'remove') : undefined;

		if (key !== undefined) return [new SyntaxError(`parseJson: JSON contains a forbidden "${key}" key`), undefined];
	}
	if (guard !== undefined) {
		const issues = explain(guard, value);

		if (issues.length > 0) return [new ValidationError(issues), undefined];
	}

	return [undefined, value];
}

/**
 * What a {@link Fast} parse returns for an invalid value. A registered symbol, so that two copies of this module (two installed
 * versions, or a duplicated bundle) agree on it when the parsers of one are nested in the schemas of the other.
 */
const FAIL = Symbol.for('tinkit.parse.fail');

/**
 * The issue list of the outermost report running (see {@link report}), `undefined` between parses: the list of the parse the caller
 * sees, as opposed to the lists of parses nested in a guard, a `check` predicate or a transform (see {@link lazy}). A parse whose
 * issues are added to the report around it (see {@link surfaced}) holds it while it reports.
 */
let rootIssues: SchemaIssue[] | undefined;

/**
 * What a foreign Standard Schema validator is called for (see {@link standardNode}), until a parse starts (see {@link execute}), so that
 * a parser of this module handed over as a plain Standard Schema knows: `1` while it reports, to a list whose issues the report around
 * it takes (that list must hold the issues its pointers refer to, like the report the caller sees), `2` during a fast parse, which
 * only needs to know whether the value is valid (an invalid one gets one generic issue instead of a report, which would be redone at
 * every level of a recursive schema), `0` otherwise.
 */
let surfaced = 0;

/**
 * The issue lists of the reports that surfaced reports (see {@link surfaced}) run in: their issues reach the caller's report, like those
 * of the surfaced reports, so a pointer given there may refer to them.
 */
const outers = new Set<SchemaIssue[] | undefined>();

/**
 * `true` for the issue list of a surfaced report, and for each of its issues, where the report around it put the copy (see
 * {@link standardNode}): a {@link lazy} parser that reported an object there follows its first issue to the copy.
 */
const moved = new WeakMap<object, LazyReport | true>();

/** Where a {@link lazy} parser reported an invalid object: its first issue, at `index` in `list`. */
interface LazyReport {
	readonly index: number;
	readonly first: SchemaIssue;
	readonly list: SchemaIssue[];
}

/**
 * Parses `value` without reporting anything: returns the output, or {@link FAIL} at the first problem. Valid values (the common case)
 * only take this path; invalid ones are parsed again by the schema's {@link Run}, which builds the issues and their paths.
 */
type Fast = (value: unknown) => unknown;

/**
 * Parses `value` in reporting mode: returns the output, pushing an issue (with the path of the offending value) for every problem
 * found. When issues were added, the output is meaningless. Only called after the {@link Fast} parse of the same schema failed for
 * `value` (see {@link rerun}); it may still succeed when the schema is not deterministic.
 */
type Run = (value: unknown, path: PropertyKey[], issues: SchemaIssue[]) => unknown;

/** A compiled schema. */
interface Node {
	/** The non-reporting parse. */
	readonly fast: Fast;
	/** The reporting parse. */
	readonly run: Run;
	/** The guard, when the schema is a guard (its output is then its input). */
	readonly guard: Guard<unknown> | undefined;
	/**
	 * Whether a present property value counts as missing for this schema (see {@link blankAsUndefined}): an object then reports
	 * `Missing required property` for it, and leaves the key out when the output is `undefined`.
	 */
	readonly missing?: ((value: unknown) => boolean) | undefined;
	/**
	 * Whether the schema gives `undefined` a meaning of its own (a default, an optional value), so that its issues for a missing
	 * property are genuine (a default that fails a later check) instead of being summed up as `Missing required property`. A function,
	 * asked during a parse only, so that wrapping a {@link lazy} parser never resolves it early.
	 */
	readonly handlesMissing?: (() => boolean) | undefined;
	/**
	 * How far an invalid value is from matching, for {@link union} to report the closest member only: for an object schema, the share of
	 * its properties with a primitive value that fail (below 1; nested objects are not parsed, which keeps scoring cheap), and 2 for a
	 * value that is not an object. Lower is closer; schemas without a score count as 1, so an object member that fits the type wins.
	 */
	readonly score?: ((value: unknown) => number) | undefined;
}

/**
 * Always `true`: the {@link Node.handlesMissing} of the schemas that handle `undefined` themselves.
 * @returns {boolean} `true`
 */
function always(): boolean {
	return true;
}

/**
 * Whether a schema gives `undefined` a meaning of its own (see {@link Node.handlesMissing}).
 * @param {Node} node - The compiled schema
 * @returns {boolean} Whether it handles missing values
 */
function handlesMissing(node: Node): boolean {
	return typeof node.handlesMissing === 'function' && node.handlesMissing();
}

/**
 * Whether `value` is missing for `node`: `undefined`, or a value the schema counts as missing (a blank string, see {@link blankAsUndefined}).
 * @param {Node} node - The compiled schema
 * @param {unknown} value - The value
 * @returns {boolean} Whether the value is missing
 */
function isAbsent(node: Node, value: unknown): boolean {
	return value === undefined || flags(node, value);
}

/**
 * Whether `node` counts the present value `value` as missing (see {@link Node.missing}).
 * @param {Node} node - The compiled schema
 * @param {unknown} value - The value
 * @returns {boolean} `true` when the schema flags it
 */
function flags(node: Node, value: unknown): boolean {
	return typeof node.missing === 'function' && node.missing(value);
}

/**
 * How far `value` is from matching `node` (see {@link Node.score}).
 * @param {Node} node - The compiled schema
 * @param {unknown} value - A value the schema rejects
 * @returns {number} The score, lower being closer
 */
function scoreOf(node: Node, value: unknown): number {
	return typeof node.score === 'function' ? node.score(value) : 1;
}

/**
 * Whether the property `key` of an object counts as present for `child`: an own property whose value `child` does not treat as missing.
 * @param {Node} child - The property's compiled schema
 * @param {object} value - The object
 * @param {string} key - The key
 * @param {unknown} raw - The property value (`undefined` when it is not own)
 * @returns {boolean} Whether the property is present
 */
function isPresent(child: Node, value: object, key: string, raw: unknown): boolean {
	return hasOwn.call(value, key) && !flags(child, raw);
}

/** A parser created by this module. */
interface CompiledParser<T> extends StandardSchemaV1<unknown, T> {
	/**
	 * The compiled schema, so that nesting a parser skips the Standard Schema adapter. A plain string key (like `'~standard'`), not a
	 * symbol: a computed key would keep the exported parser constants, and everything they reference, in every bundle of the module.
	 * Copies of this module read each other's nodes, so the key carries the version of the {@link Node} protocol: change it with any
	 * incompatible change to `Node`, and parsers of other versions are then used through `~standard` instead.
	 */
	readonly '~tink.1': Node;
}

/** Guards, foreign Standard Schema validators and object schemas, compiled on first use, and the `~standard` props of parsers. */
const compiled = new WeakMap<object, Node>();

/**
 * A parser: a [Standard Schema](https://standardschema.dev) validator whose output may differ from its input (a number parsed from a
 * string, a default filled in, a transformed value). Built by {@link asNumber}, {@link withDefault}, {@link toParser} and the other
 * parser helpers of this module; run it with {@link parse} or {@link safeParse}, or hand it to tRPC, TanStack Form, Hono and every other
 * Standard Schema consumer.
 * @template T - The output type
 */
export type Parser<T> = StandardSchemaV1<unknown, T>;

/**
 * Any [Standard Schema](https://standardschema.dev) v1 validator: the parsers of this module, the guards module's `toStandardSchema`,
 * zod, valibot, ArkType… Only synchronous validators can be used in a {@link Schema}.
 */
export interface StandardSchemaLike {
	/** The Standard Schema properties. */
	readonly '~standard': {
		/** The Standard Schema version (always `1`). */
		readonly version: 1;
		/** The library that created the validator. */
		readonly vendor: string;
		/** Validates an unknown value. */
		readonly validate: (value: unknown) => unknown;
		/** Type-only carrier of the output type. */
		readonly types?: { readonly output: unknown } | undefined;
	};
}

/**
 * A plain object of schemas: parses an object whose properties match, and returns a NEW object with only these keys (unknown keys
 * are stripped, like `z.object()`).
 */
export interface ObjectSchema {
	readonly [key: string]: Schema;
}

/**
 * What {@link parse} accepts:
 * - a guard (`isString`, `isUrl`, `isShape(…)`…): the value must pass it and is returned unchanged;
 * - a parser ({@link asInteger}, {@link withDefault}, {@link arrayOf}…) or any synchronous Standard Schema validator (zod included):
 *   its output is returned;
 * - a plain object of schemas ({@link ObjectSchema}), nested as deep as needed.
 */
export type Schema = Guard<unknown> | StandardSchemaLike | ObjectSchema;

/**
 * The output type of a {@link Schema}: the guarded type of a guard, the output of a parser or Standard Schema validator, and for object
 * schemas an object type whose properties are optional when their output can be `undefined`.
 * @template S - The schema
 * @example
 * const schema = { port: withDefault(asInteger, 3000), host: isUrl };
 * type Config = SchemaOutput<typeof schema>; // { port: number; host: string }
 */
export type SchemaOutput<S> = S extends ((value: unknown) => value is infer T)
	? T
	: S extends { readonly '~standard': { readonly types?: infer Types } }
		? NonNullable<Types> extends { readonly output: infer O }
			? O
			: unknown
		: S extends ObjectSchema
			? // An index signature (the `ObjectSchema` type itself) has no known keys: stop there instead of recursing forever.
				string extends keyof S
				? Record<string, unknown>
				: ObjectOutput<S>
			: never;

/**
 * The output type of an {@link ObjectSchema}.
 * @template S - The object schema
 */
type ObjectOutput<S extends ObjectSchema> = {
	-readonly [K in keyof S as undefined extends SchemaOutput<S[K]> ? never : K]: SchemaOutput<S[K]>;
} & {
	-readonly [K in keyof S as undefined extends SchemaOutput<S[K]> ? K : never]?: SchemaOutput<S[K]>;
} extends infer O
	? { [K in keyof O]: O[K] }
	: never;

/**
 * The outcome of {@link safeParse}: `[undefined, value]` on success, `[error, undefined]` on failure, like {@link parseJson}.
 * @template T - The parsed type
 */
export type ParseResult<T> = [error: ValidationError, value: undefined] | [error: undefined, value: T];

/**
 * Builds the `TypeError` thrown for something that is not a {@link Schema}.
 * @param {string} caller - The public function name
 * @param {string} name - The schema's name in the message, e.g. `schema.user.tags`
 * @param {unknown} schema - The offending value
 * @returns {TypeError} The error
 */
function invalidSchema(caller: string, name: string, schema: unknown): TypeError {
	return new TypeError(
		Array.isArray(schema)
			? `${caller}: \`${name}\` must be a guard, a parser or a plain object of schemas, got array (use arrayOf for arrays)`
			: `${caller}: \`${name}\` must be a guard, a parser or a plain object of schemas, got ${describe(schema)}`
	);
}

/**
 * Compiles a schema, caching guards, Standard Schema validators and object schemas.
 * @param {string} caller - The public function name, for errors
 * @param {string} name - The schema's name, for errors
 * @param {unknown} schema - The schema
 * @param {object[]} ancestors - The object schemas being compiled around this one (to detect cycles)
 * @returns {Node} The compiled schema
 * @throws {TypeError} when `schema` is not a {@link Schema}, or contains itself
 */
function compile(caller: string, name: string, schema: unknown, ancestors: object[]): Node {
	if ((typeof schema !== 'function' && typeof schema !== 'object') || schema === null) throw invalidSchema(caller, name, schema);

	const own = nodeOf(schema);

	if (own !== undefined) return own;

	let node = compiled.get(schema);

	if (node !== undefined) return node;
	// Standard Schema first: some validators are callable (ArkType's types), and calling them as guards would accept anything.
	if (isStandardSchema(schema)) node = compiled.get(schema['~standard']) ?? standardNode(schema);
	else if (typeof schema === 'function') node = guardNode(schema as Guard<unknown>);
	else if (isPlainObject(schema)) node = objectNode(caller, name, schema as ObjectSchema, ancestors);
	else throw invalidSchema(caller, name, schema);
	compiled.set(schema, node);

	return node;
}

/**
 * Returns the compiled schema of a parser created by this module (or by another copy of it): an OWN `'~tink.1'` property holding a
 * node, so neither a polluted `Object.prototype` nor an object schema with a `'~tink.1'` key passes for a parser.
 * @param {object} schema - A function or a non-null object
 * @returns {Node | undefined} The node, or `undefined` for anything else
 */
function nodeOf(schema: object): Node | undefined {
	if (!hasOwn.call(schema, '~tink.1')) return undefined;

	const node = (schema as Partial<CompiledParser<unknown>>)['~tink.1'];
	const props = (schema as Partial<StandardSchemaLike>)['~standard'];

	// A parser also carries this module's `~standard` props: an object schema with a `~tink.1` key of guards stays an object schema.
	return typeof node === 'object' &&
		node !== null &&
		typeof node.fast === 'function' &&
		typeof node.run === 'function' &&
		typeof props === 'object' &&
		props !== null &&
		props.vendor === 'tink'
		? node
		: undefined;
}

/**
 * Whether `value` is a Standard Schema validator: a `'~standard'` object of version 1 with a `validate` function. The property may
 * be inherited (some libraries define it on a prototype), but not from a polluted `Object.prototype` or `Function.prototype`.
 * @param {object} value - A function or a non-null object
 * @returns {boolean} Whether `value` is a Standard Schema validator
 */
function isStandardSchema(value: object): value is StandardSchemaLike {
	const props = (value as Partial<StandardSchemaLike>)['~standard'];

	if (typeof props !== 'object' || props === null || props.version !== 1 || typeof props.validate !== 'function') return false;

	return hasOwn.call(value, '~standard') || (!hasOwn.call(Object.prototype, '~standard') && !hasOwn.call(Function.prototype, '~standard'));
}

/**
 * Explains why `guard` rejects `value`, for a report to `issues`: in the report the caller sees, as a root `explain` call (whose issues
 * all reach it), elsewhere nested in the lazy checks running.
 * @param {Guard<unknown>} guard - The guard
 * @param {unknown} value - The rejected value
 * @param {SchemaIssue[]} issues - The report
 * @returns {SchemaIssue[]} The issues
 */
function explainTo(guard: Guard<unknown>, value: unknown, issues: SchemaIssue[]): SchemaIssue[] {
	if (issues !== rootIssues) return explain(guard, value);

	const { checks, checkRoot } = scope;

	scope.checks = 0;
	try {
		return explain(guard, value);
	} finally {
		scope.checks = checks;
		scope.checkRoot = checkRoot;
	}
}

/**
 * Compiles a guard: valid values are returned as they are, invalid ones are explained (see the guards module's `explain`).
 * @param {Guard<unknown>} guard - The guard
 * @returns {Node} The compiled guard
 */
function guardNode(guard: Guard<unknown>): Node {
	return {
		fast: function fastGuard(value: unknown): unknown {
			return guard(value) ? value : FAIL;
		},
		run: function runGuard(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (guard(value)) return value;

			const found = explainTo(guard, value, issues);

			// A guard that rejected the value but accepts it when explained (it is not deterministic) still fails.
			if (found.length === 0) issues.push({ message: `Invalid value (got ${describe(value)})`, path: path.slice() });
			for (const issue of found) issues.push({ message: issue.message, path: [...path, ...issue.path] });

			return value;
		},
		guard,
		score: function scoreGuard(value: unknown): number {
			return guardScore(guard, value);
		}
	};
}

/**
 * Compiles a foreign Standard Schema validator (zod, valibot…). Its issue paths, which may hold `{ key }` segments, are flattened to keys.
 * @param {StandardSchemaLike} schema - The validator
 * @returns {Node} The compiled validator
 */
function standardNode(schema: StandardSchemaLike): Node {
	const props = schema['~standard'];

	/**
	 * Calls the validator.
	 * @param {unknown} value - The value
	 * @returns {StandardSchemaResult<unknown>} Its result
	 * @throws {TypeError} when the validator returns a promise
	 */
	function callValidator(value: unknown): StandardSchemaResult<unknown> {
		const result = props.validate(value) as StandardSchemaResult<unknown> | PromiseLike<unknown>;

		if (typeof (result as PromiseLike<unknown>).then === 'function') {
			throw new TypeError('parse: Standard Schema validators must be synchronous, got one returning a promise');
		}

		return result as StandardSchemaResult<unknown>;
	}

	return {
		fast: function fastStandard(value: unknown): unknown {
			let result: StandardSchemaResult<unknown>;

			// Reset even when the validator throws: the next parse would take the flag, and give its caller no report.
			surfaced = 2;
			try {
				result = callValidator(value);
			} finally {
				surfaced = 0;
			}

			// As the Standard Schema spec says, any falsy `issues` (not only `undefined`) means success; a success result has no `issues`
			// of its own, so a polluted `Object.prototype.issues` is not read (it would fail every valid value).
			return readOption(result, 'issues') ? FAIL : (result as { readonly value: unknown }).value;
		},
		run: function runStandard(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			// Its issues join this report: a parser of this module reporting through it must not point at issues it does not hold (a
			// validator that throws leaves the flag set, which only changes how the next parse reports).
			surfaced = 1;

			const result = callValidator(value);
			const found = readOption(result, 'issues');

			surfaced = 0;

			if (!found) return (result as { readonly value: unknown }).value;
			if (found.length === 0) issues.push({ message: `Invalid value (got ${describe(value)})`, path: path.slice() });

			// The issues of a parser of this module, given back as they are: their copies take their place (see `moved`).
			const own = moved.get(found) === true;

			for (const issue of found as ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }>) {
				// An issue at the root may have no `path`: a polluted `Object.prototype.path` is not read (a string there threw).
				const segments = readOption(issue, 'path', []).map(function (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
					return typeof segment === 'object' ? segment.key : segment;
				});
				const copy = { message: issue.message, path: [...path, ...segments] };

				if (own) moved.set(issue, { index: issues.length, first: copy, list: issues });
				issues.push(copy);
			}

			return undefined;
		},
		guard: undefined
	};
}

/**
 * Sets `output[key]` as an own property. A key the output inherits is defined rather than assigned: `__proto__` would replace the
 * prototype, an inherited setter (a polluted prototype) would run, and an inherited read-only property (a frozen `Object.prototype`
 * keeps `toString` read-only) would make the assignment throw. A descriptor that inherits a `get` or `set` from a polluted
 * `Object.prototype` (an accessor with a value, which `Object.defineProperty` rejects) is given again without a prototype.
 * @param {Record<string, unknown>} output - The object being built
 * @param {string} key - The key
 * @param {unknown} value - The value
 * @returns {void}
 */
function assign(output: Record<string, unknown>, key: string, value: unknown): void {
	if (!(key in output)) {
		output[key] = value;

		return;
	}

	const descriptor: PropertyDescriptor = { value, enumerable: true, writable: true, configurable: true };

	try {
		Object.defineProperty(output, key, descriptor);
	} catch {
		Object.defineProperty(output, key, Object.setPrototypeOf(descriptor, null) as PropertyDescriptor);
	}
}

/**
 * Compiles an object schema. Its fast parse is generated code when `new Function` is available (see {@link generateObject}),
 * and {@link objectLoop} otherwise.
 * @param {string} caller - The public function name, for errors
 * @param {string} name - The schema's name, for errors
 * @param {ObjectSchema} schema - The object schema
 * @param {object[]} ancestors - The object schemas being compiled around this one
 * @returns {Node} The compiled schema
 * @throws {TypeError} when a property is not a {@link Schema}, or the schema contains itself
 */
function objectNode(caller: string, name: string, schema: ObjectSchema, ancestors: object[]): Node {
	if (ancestors.includes(schema)) throw new TypeError(`${caller}: \`${name}\` must be acyclic, got a circular reference`);
	ancestors.push(schema);

	const keys = Object.keys(schema);
	const children = keys.map(function (key: string): Node {
		return compile(caller, `${name}.${key}`, schema[key], ancestors);
	});

	ancestors.pop();

	const loop = objectLoop(keys, children);

	return { fast: generateObject(keys, children, loop) ?? loop, run: objectRun(keys, children), guard: undefined, score: objectScore(keys, children) };
}

/**
 * Builds the {@link Node.score} of an object schema: the share of its properties with a primitive (or missing) value that fail their
 * schema, always below 1 (`failing / (keys + 1)`), or 2 for a value that is not an object. Object values are skipped: parsing them would cost a
 * walk of their whole subtree, and nested unions would make scoring exponential.
 * @param {ReadonlyArray<string>} keys - The keys
 * @param {ReadonlyArray<Node>} children - The compiled schema of each key
 * @returns {(value: unknown) => number} The score
 */
function objectScore(keys: ReadonlyArray<string>, children: ReadonlyArray<Node>): (value: unknown) => number {
	return function scoreObject(value: unknown): number {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return 2;

		let failing = 0;

		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			const child = children[index];
			const raw = hasOwn.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;

			if (typeof raw === 'object' && raw !== null) continue;
			if (child.guard === undefined ? child.fast(raw) === FAIL : !child.guard(raw)) failing++;
		}

		return failing / (keys.length + 1);
	};
}

/**
 * Builds the fast parse of an object schema as a loop over its keys: the fallback when code generation is unavailable, and the path
 * taken by generated code for objects whose properties might be inherited.
 * @param {ReadonlyArray<string>} keys - The keys
 * @param {ReadonlyArray<Node>} children - The compiled schema of each key
 * @returns {Fast} The fast parse
 */
function objectLoop(keys: ReadonlyArray<string>, children: ReadonlyArray<Node>): Fast {
	return function fastObjectLoop(value: unknown): unknown {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return FAIL;

		const output: Record<string, unknown> = {};

		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			const child = children[index];
			// Inherited properties never count, so a polluted `Object.prototype` cannot fill in a missing key.
			const raw = hasOwn.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
			let result = raw;

			if (child.guard !== undefined) {
				if (!child.guard(result)) return FAIL;
			} else if ((result = child.fast(result)) === FAIL) {
				return FAIL;
			}
			if (result !== undefined || isPresent(child, value, key, raw)) assign(output, key, result);
		}

		return output;
	};
}

/**
 * Generates the fast parse of an object schema: one named property access and one direct call per key, which V8 optimises far better
 * than a loop over keys (zod 4 does the same). Only the keys reach the generated source, as JSON string literals; guards and parsers
 * are passed in as arguments. Objects that inherit from `Object.prototype` (or nothing) are read directly once `Object.prototype` is known
 * to hold none of the keys, since every defined value is then an own property; other objects, and a polluted `Object.prototype`, take `loop`.
 * @param {ReadonlyArray<string>} keys - The keys
 * @param {ReadonlyArray<Node>} children - The compiled schema of each key
 * @param {Fast} loop - The loop to fall back to
 * @returns {Fast | undefined} The generated parse, or `undefined` when code generation is disabled (CSP, Cloudflare Workers…)
 */
function generateObject(keys: ReadonlyArray<string>, children: ReadonlyArray<Node>, loop: Fast): Fast | undefined {
	// The generated code ships as written, so its names are short: `v` the value, `o` the output, `r` a property's result, `i` its
	// input, `c0`… the child parsers (or guards), `m0`… their `missing` hooks; the parameters are listed in the `generate` call below.
	const literals = keys.map(function (key: string): string {
		return JSON.stringify(key);
	});
	// A node without the hook reads it from `Object.prototype`, which pollution may give a value that is not one (see `flags`).
	const hooks = children.map(function (child: Node): Node['missing'] {
		return typeof child.missing === 'function' ? child.missing : undefined;
	});
	const lines = children.map(function (child: Node, index: number): string {
		const key = literals[index];
		const store = `if (r !== undefined || H.call(v, ${key})${hooks[index] === undefined ? '' : ` && !m${index}(i)`}) o[${key}] = r;`;

		if (child.guard !== undefined) return `r = v[${key}]; if (!c${index}(r)) return F; ${store}`;
		if (hooks[index] !== undefined) return `i = v[${key}]; r = c${index}(i); if (r === F) return F; ${store}`;

		return `r = c${index}(v[${key}]); if (r === F) return F; ${store}`;
	});
	const source = [
		...hooks.map(function (hook: Node['missing'], index: number): string {
			return `const c${index} = C[${index}]${hook === undefined ? '' : `, m${index} = M[${index}]`};`;
		}),
		'return function fastObject(v) {',
		"if (typeof v !== 'object' || v === null || A(v)) return F;",
		'const p = P(v);',
		`if ((p !== O && p !== null)${literals
			.map(function (key: string): string {
				return ` || ${key} in O`;
			})
			.join('')}) return L(v);`,
		'const o = {};',
		'let r, i;',
		...lines,
		'return o;',
		'};'
	].join('\n');

	return generate(['F', 'O', 'A', 'P', 'H', 'L', 'C', 'M'], source, [
		FAIL,
		Object.prototype,
		Array.isArray,
		Object.getPrototypeOf,
		hasOwn,
		loop,
		children.map(function (child: Node): AnyFunction {
			return child.guard ?? child.fast;
		}),
		hooks
	]) as Fast | undefined;
}

/**
 * Builds the reporting parse of an object schema.
 * @param {ReadonlyArray<string>} keys - The keys
 * @param {ReadonlyArray<Node>} children - The compiled schema of each key
 * @returns {Run} The reporting parse
 */
function objectRun(keys: ReadonlyArray<string>, children: ReadonlyArray<Node>): Run {
	return function runObject(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			issues.push({ message: `Expected an object (got ${Array.isArray(value) ? 'array' : describe(value)})`, path: path.slice() });

			return undefined;
		}

		const output: Record<string, unknown> = {};

		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			const raw = hasOwn.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
			const present = isPresent(children[index], value, key, raw);
			const before = issues.length;

			path.push(key);

			const result = rerun(children[index], raw, path, issues);

			path.pop();
			if (issues.length > before) {
				// A missing property fails as such, unless its schema handles `undefined` (then a default can genuinely fail a later check).
				if (!present && !handlesMissing(children[index])) {
					issues.length = before;
					issues.push({ message: 'Missing required property', path: [...path, key] });
				}
			} else if (result !== undefined || present) {
				assign(output, key, result);
			}
		}

		return output;
	};
}

/**
 * Parses a child of an invalid object or array in reporting mode: valid children (usually most of them) take the fast parse, and only
 * the invalid ones the slower reporting parse.
 * @param {Node} node - The child's compiled schema
 * @param {unknown} value - The child value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} The output
 */
function rerun(node: Node, value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	const output = node.fast(value);

	return output === FAIL ? node.run(value, path, issues) : output;
}

/**
 * Parses `value`: the fast parse first, then, for invalid values only, the reporting parse.
 * @param {Fast} fast - The fast parse
 * @param {Run} run - The reporting parse
 * @param {unknown} value - The value to parse
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} The output (meaningless when issues were added)
 */
function execute(fast: Fast, run: Run, value: unknown, issues: SchemaIssue[]): unknown {
	// The fast parse needs no scope of its own: each outermost lazy parser keeps its memo (see `utils/memo.ts`) for its own call, and
	// fails a value too deep to parse. Read first: a parse nested in the fast parse must not take the flag.
	const mode = surfaced;

	surfaced = 0;

	const output = fast(value);

	if (output !== FAIL) return output;
	if (mode !== 2) return report(run, value, issues, mode === 1);
	issues.push({ message: 'Invalid value', path: [] });

	return undefined;
}

/**
 * Runs the reporting parse of an invalid value, in a memo scope of its own (see `utils/memo.ts`). A value nested so deeply that parsing
 * it overflows the stack fails with one issue at the root. Kept out of {@link execute}, which stays small enough to inline.
 * @param {Run} run - The reporting parse
 * @param {unknown} value - The value to parse
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @param {boolean} root - Whether the report around this one takes its issues (see {@link surfaced})
 * @returns {unknown} The output (meaningless when issues were added)
 */
function report(run: Run, value: unknown, issues: SchemaIssue[], root: boolean): unknown {
	const outer = rootIssues;

	// Nothing that can throw (near the stack limit, any call can overflow) runs between a change of the scope and the `try` that undoes
	// it, nor before the undoing in `finally`: a depth left above 0 would keep every memo, and its stale outputs, for every later parse.
	// The outermost parse starts from empty memos, in case the `release` of an earlier one overflowed.
	if (scope.depth === 0) release();
	if (root) {
		moved.set(issues, true);
		outers.add(outer);
	}
	if (scope.depth++ === 0 || root) rootIssues = issues;
	try {
		return run(value, [], issues);
	} catch (error) {
		// Only the outermost parse turns it into an issue: a parse nested in a transform lets it reach the parse around it.
		if (scope.depth !== 1 || !isTooDeep(error)) throw error;
		issues.length = 0;
		issues.push({ message: 'Value is nested too deeply', path: [] });

		return undefined;
	} finally {
		rootIssues = outer;
		scope.depth--;
		if (root) outers.delete(outer);
		if (scope.depth === 0) release();
	}
}

/**
 * Parses `value` as a Standard Schema `validate` call.
 * @param {Fast} fast - The fast parse
 * @param {Run} run - The reporting parse
 * @param {unknown} value - The value to parse
 * @returns {StandardSchemaResult<unknown>} The output, or the issues
 */
function validateWith(fast: Fast, run: Run, value: unknown): StandardSchemaResult<unknown> {
	const issues: SchemaIssue[] = [];
	const output = execute(fast, run, value, issues);

	return issues.length === 0 ? { value: output } : { issues };
}

/**
 * Wraps a compiled schema into a parser.
 * @template T - The output type
 * @param {Node} node - The compiled schema
 * @returns {Parser<T>} The parser
 */
function toCompiledParser<T>(node: Node): Parser<T> {
	const props = {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<T> {
			return validateWith(node.fast, node.run, value) as StandardSchemaResult<T>;
		}
	};

	// Its props handed over alone (`{ '~standard': parser['~standard'] }`) compile to the node itself (see `compile`).
	compiled.set(props, node);

	return { '~tink.1': node, '~standard': props } as CompiledParser<T>;
}

/**
 * Parses `value` with `schema` and returns the output, or throws a {@link ValidationError} listing every problem with its path. The
 * zod-like, zero-dependency way to read environment variables, query strings, form data and API payloads: guards check, parsers
 * ({@link asInteger}, {@link withDefault}…) convert, and plain objects nest and strip unknown keys.
 *
 * Object schemas are compiled on first use and cached, so define schemas once (at module level) and do not mutate them. Where
 * `new Function` is allowed, an object schema compiles to specialised code (like zod 4's), which makes parsing faster than zod;
 * under a Content Security Policy without `'unsafe-eval'`, or on Cloudflare Workers, a slower loop is used instead (the first attempt
 * may log a CSP violation report). Missing and inherited properties are parsed as `undefined` (so a missing key fails with `Missing
 * required property`, unless its schema accepts `undefined`), and keys whose output is `undefined` are left out when the input lacked
 * them. Valid input is parsed once; invalid input is parsed a second time to collect every issue with its path.
 * @template S - The schema
 * @param {S} schema - A guard, a parser, a Standard Schema validator or a plain object of those (see {@link Schema})
 * @param {unknown} value - The value to parse
 * @returns {SchemaOutput<S>} The parsed value
 * @throws {ValidationError} when `value` does not match `schema`
 * @throws {TypeError} when `schema` is not a {@link Schema}, or a Standard Schema validator in it is asynchronous
 * @example
 * import { isOneOf } from 'tinkit/guards';
 * const env = parse(
 *   { PORT: withDefault(asInteger, 3000), DEBUG: withDefault(asBoolean, false), MODE: isOneOf(['dev', 'prod']), DATABASE_URL: isUrl },
 *   { PORT: '8080', MODE: 'prod', DATABASE_URL: 'https://db.example.com', HOME: '/root' }
 * );
 * env; // => { PORT: 8080, DEBUG: false, MODE: 'prod', DATABASE_URL: 'https://db.example.com' } // typed, HOME stripped
 * parse({ PORT: asInteger }, { PORT: '80.5' }); // throws ValidationError
 * parse([isUrl], ['https://example.com']); // throws TypeError // arrays take arrayOf(isUrl)
 */
export function parse<S extends Schema>(schema: S, value: unknown): SchemaOutput<S> {
	const node = compile('parse', 'schema', schema, []);
	const issues: SchemaIssue[] = [];
	const output = execute(node.fast, node.run, value, issues);

	if (issues.length > 0) throw new ValidationError(issues);

	return output as SchemaOutput<S>;
}

/**
 * Parses `value` with `schema` like {@link parse}, but returns a `[error, value]` tuple instead of throwing for invalid data (zod's
 * `safeParse`, shaped like {@link parseJson}'s result). Invalid schemas still throw.
 * @template S - The schema
 * @param {S} schema - A guard, a parser, a Standard Schema validator or a plain object of those (see {@link Schema})
 * @param {unknown} value - The value to parse
 * @returns {ParseResult<SchemaOutput<S>>} `[undefined, output]` on success, `[ValidationError, undefined]` on failure
 * @throws {TypeError} when `schema` is not a {@link Schema}, or a Standard Schema validator in it is asynchronous
 * @example
 * import { isString } from 'tinkit/guards';
 * const query = { page: withDefault(asInteger, 1), q: optional(isString) };
 * safeParse(query, { page: '2' }); // => [undefined, { page: 2 }]
 * const [error] = safeParse(query, { page: 'two', q: 3 });
 * error?.issues; // => [{ message: 'Expected an integer or an integer string (got string)', path: ['page'] }, { message: 'Invalid value (got number)', path: ['q'] }]
 */
export function safeParse<S extends Schema>(schema: S, value: unknown): ParseResult<SchemaOutput<S>> {
	const node = compile('safeParse', 'schema', schema, []);
	const issues: SchemaIssue[] = [];
	const output = execute(node.fast, node.run, value, issues);
	const result: ParseResult<unknown> = issues.length === 0 ? [undefined, output] : [new ValidationError(issues), undefined];

	return result as ParseResult<SchemaOutput<S>>;
}

/**
 * Turns any {@link Schema} into a {@link Parser}: a Standard Schema validator to hand to tRPC, TanStack Form, Hono and the rest of the
 * ecosystem, with the coercions, defaults and transforms of the schema applied to its output.
 * @template S - The schema
 * @param {S} schema - A guard, a parser, a Standard Schema validator or a plain object of those
 * @returns {Parser<SchemaOutput<S>>} The parser (`schema` itself when it is already a parser of this module)
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * const form = toParser({ age: asInteger, newsletter: withDefault(asBoolean, false) });
 * form['~standard'].validate({ age: '36' }); // => { value: { age: 36, newsletter: false } }
 * form['~standard'].validate({}); // => { issues: [{ message: 'Missing required property', path: ['age'] }] }
 */
export function toParser<S extends Schema>(schema: S): Parser<SchemaOutput<S>> {
	const node = compile('toParser', 'schema', schema, []);

	return (schema as Partial<CompiledParser<unknown>>)['~tink.1'] === node ? (schema as Parser<SchemaOutput<S>>) : toCompiledParser(node);
}

/**
 * Creates a parser that returns `fallback` when the value is `undefined` (missing), and parses it with `schema` otherwise (`.default()`
 * in zod). `null` is not missing: it goes to `schema`. When `fallback` is a function it is called for every missing value, so mutable
 * defaults are never shared between results (wrap a function default in another function: `withDefault(isFunction, () => noop)`);
 * keep it free of side effects, since an invalid input is parsed again to report it (more than twice inside a union). The fallback itself
 * is not validated.
 * @template S - The schema
 * @param {S} schema - The schema for present values
 * @param {SchemaOutput<S> | (() => SchemaOutput<S>)} fallback - The default, or a function returning it
 * @returns {Parser<Exclude<SchemaOutput<S>, undefined>>} The parser; in an object schema the key becomes required in the output type
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * import { isString } from 'tinkit/guards';
 * parse({ port: withDefault(asInteger, 3000) }, {}); // => { port: 3000 }
 * parse({ port: withDefault(asInteger, 3000) }, { port: '80' }); // => { port: 80 }
 * const tags = withDefault(arrayOf(isString), function () { return []; });
 * parse(tags, undefined) !== parse(tags, undefined); // => true // a fresh array on every parse
 */
export function withDefault<S extends Schema>(
	schema: S,
	fallback: Exclude<SchemaOutput<S>, undefined> | (() => Exclude<SchemaOutput<S>, undefined>)
): Parser<Exclude<SchemaOutput<S>, undefined>> {
	const node = compile('withDefault', 'schema', schema, []);

	/**
	 * Returns the default.
	 * @returns {unknown} `fallback`, or what it returns when it is a function
	 */
	function fill(): unknown {
		return typeof fallback === 'function' ? (fallback as () => unknown)() : fallback;
	}

	return toCompiledParser({
		fast: function fastWithDefault(value: unknown): unknown {
			return isAbsent(node, value) ? fill() : node.fast(value);
		},
		// Only reached when the fast parse failed, so never for a missing value.
		run: node.run,
		guard: undefined,
		missing: node.missing,
		handlesMissing: always,
		score: node.score
	});
}

/**
 * Creates a parser that returns `fallback` for any value `schema` rejects, missing ones included, instead of failing (`.catch()` in zod):
 * for inputs where a bad value should fall back to a sensible one rather than fail the whole parse, such as a page number in a query
 * string or a stored user preference. The rejected value is dropped without a trace, so prefer {@link withDefault} where a typo should
 * be reported. When `fallback` is a function it is called for every rejected value; the fallback itself is not validated.
 * @template S - The schema
 * @param {S} schema - The schema for the value
 * @param {SchemaOutput<S> | (() => SchemaOutput<S>)} fallback - The value for rejected inputs, or a function returning it
 * @returns {Parser<SchemaOutput<S>>} The parser, which never fails
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * import { isOneOf } from 'tinkit/guards';
 * import { parseQueryString } from 'tinkit/url';
 * const query = { page: withFallback(asInteger, 1), sort: withFallback(isOneOf(['new', 'top']), 'new') };
 * parse(query, parseQueryString('?page=3&sort=top')); // => { page: 3, sort: 'top' }
 * parse(query, parseQueryString('?page=last&sort=random')); // => { page: 1, sort: 'new' }
 * parse(query, {}); // => { page: 1, sort: 'new' }
 */
export function withFallback<S extends Schema>(schema: S, fallback: SchemaOutput<S> | (() => SchemaOutput<S>)): Parser<SchemaOutput<S>> {
	const node = compile('withFallback', 'schema', schema, []);

	/**
	 * Parses the value, or returns the fallback when `schema` rejects it.
	 * @param {unknown} value - The value
	 * @returns {unknown} The output, or the fallback
	 */
	function fastWithFallback(value: unknown): unknown {
		const output = node.fast(value);

		if (output !== FAIL) return output;

		return typeof fallback === 'function' ? (fallback as () => unknown)() : fallback;
	}

	// The fast parse never fails, so the reporting parse is never needed: it is the same function.
	return toCompiledParser({ fast: fastWithFallback, run: fastWithFallback, guard: undefined, handlesMissing: always });
}

/**
 * Creates a parser that accepts `undefined` (returned as is) and parses any other value with `schema`: in an object schema the key
 * becomes optional (`.optional()` in zod). For guards, the guards module's `isOptional` does the same.
 * @template S - The schema
 * @param {S} schema - The schema for defined values
 * @returns {Parser<SchemaOutput<S> | undefined>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * parse({ limit: optional(asInteger) }, {}); // => {}
 * parse({ limit: optional(asInteger) }, { limit: '10' }); // => { limit: 10 }
 */
export function optional<S extends Schema>(schema: S): Parser<SchemaOutput<S> | undefined> {
	return toCompiledParser(optionalNode(compile('optional', 'schema', schema, [])));
}

/**
 * Creates a parser that parses the value with `schema`, then maps the output with `fn` (`.transform()` in zod). `fn` only runs when
 * `schema` succeeded; keep it free of side effects, since an invalid input is parsed again to report it (more than twice inside a union).
 * To validate the transformed value, {@link chain} a schema after it.
 * @template S - The schema
 * @template U - The transformed type
 * @param {S} schema - The schema applied first
 * @param {(value: SchemaOutput<S>) => U} fn - Maps the parsed value
 * @returns {Parser<U>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema} or `fn` is not a function
 * @example
 * import { isString } from 'tinkit/guards';
 * const email = transform(isString, function (s) { return s.trim().toLowerCase(); });
 * parse(email, '  Ada@Example.COM '); // => 'ada@example.com'
 * parse(transform(arrayOf(asInteger), function (ids) { return new Set(ids); }), ['1', '2', '2']); // => new Set([1, 2])
 */
export function transform<S extends Schema, U>(schema: S, fn: (value: SchemaOutput<S>) => U): Parser<U> {
	const node = compile('transform', 'schema', schema, []);

	if (typeof fn !== 'function') throw new TypeError(`transform: \`fn\` must be a function, got ${describe(fn)}`);

	return toCompiledParser({
		fast: function fastTransform(value: unknown): unknown {
			const output = node.fast(value);

			return output === FAIL ? FAIL : fn(output as SchemaOutput<S>);
		},
		run: function runTransform(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			const before = issues.length;
			const output = node.run(value, path, issues);

			return issues.length > before ? undefined : fn(output as SchemaOutput<S>);
		},
		guard: undefined,
		missing: node.missing,
		handlesMissing: node.handlesMissing,
		score: node.score
	});
}

/**
 * Creates a parser that parses the value with `first`, then parses its output with `second` (`.pipe()` in zod): coerce, then check.
 * @template A - The first schema
 * @template B - The second schema
 * @param {A} first - The schema applied to the input
 * @param {B} second - The schema applied to the output of `first`
 * @returns {Parser<SchemaOutput<B>>} The parser
 * @throws {TypeError} when `first` or `second` is not a {@link Schema}
 * @example
 * import { isIntegerInRange } from 'tinkit/guards';
 * const port = chain(asInteger, isIntegerInRange(1, 65535));
 * parse(port, '8080'); // => 8080
 * safeParse(port, '70000')[0]?.issues; // => [{ message: 'Expected an integer between 1 and 65535 (got 70000)', path: [] }]
 */
export function chain<A extends Schema, B extends Schema>(first: A, second: B): Parser<SchemaOutput<B>> {
	const head = compile('chain', 'first', first, []);
	const tail = compile('chain', 'second', second, []);

	return toCompiledParser({
		fast: function fastChain(value: unknown): unknown {
			const output = head.fast(value);

			return output === FAIL ? FAIL : tail.fast(output);
		},
		run: function runChain(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			const before = issues.length;
			const output = rerun(head, value, path, issues);

			return issues.length > before ? undefined : rerun(tail, output, path, issues);
		},
		guard: undefined,
		missing: head.missing,
		handlesMissing: head.handlesMissing,
		score: head.score
	});
}

/**
 * Creates a parser that parses the value with `schema`, then requires `predicate` to accept the output (`.refine()` in zod), reporting
 * `message` otherwise: the place for rules a single guard cannot express, across fields included. `path` (relative to the value) puts
 * the issue on the field a form should highlight. `predicate` only sees outputs `schema` accepted, so coercions and defaults are applied.
 * @template S - The schema
 * @param {S} schema - The schema for the value
 * @param {(value: SchemaOutput<S>) => boolean} predicate - The rule the output must satisfy
 * @param {string} [message='Invalid value'] - The message of the issue
 * @param {ReadonlyArray<PropertyKey>} [path=[]] - Where the issue goes, relative to the value
 * @returns {Parser<SchemaOutput<S>>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}, `predicate` is not a function, `message` is not a string or `path` is not an array
 * @example
 * import { isString } from 'tinkit/guards';
 * const signUp = check(
 *   { password: isString, confirm: isString },
 *   function (form) { return form.password === form.confirm; },
 *   'Passwords do not match',
 *   ['confirm']
 * );
 * parse(signUp, { password: 'hunter2', confirm: 'hunter2' }); // => { password: 'hunter2', confirm: 'hunter2' }
 * safeParse(signUp, { password: 'hunter2', confirm: 'hunter3' })[0]?.issues; // => [{ message: 'Passwords do not match', path: ['confirm'] }]
 * parse(check(asInteger, function (n) { return n % 2 === 0; }, 'Expected an even number'), '42'); // => 42
 */
export function check<S extends Schema>(
	schema: S,
	predicate: (value: SchemaOutput<S>) => boolean,
	message = 'Invalid value',
	path: ReadonlyArray<PropertyKey> = []
): Parser<SchemaOutput<S>> {
	const node = compile('check', 'schema', schema, []);

	if (typeof predicate !== 'function') throw new TypeError(`check: \`predicate\` must be a function, got ${describe(predicate)}`);
	if (typeof message !== 'string') throw new TypeError(`check: \`message\` must be a string, got ${describe(message)}`);
	if (!Array.isArray(path)) throw new TypeError(`check: \`path\` must be an array, got ${describe(path)}`);

	const relative = path.slice();

	return toCompiledParser({
		fast: function fastCheck(value: unknown): unknown {
			const output = node.fast(value);

			return output !== FAIL && predicate(output as SchemaOutput<S>) ? output : FAIL;
		},
		run: function runCheck(value: unknown, at: PropertyKey[], issues: SchemaIssue[]): unknown {
			// The fast parse failed: either `schema` rejected the value, or `predicate` rejected its output.
			if (node.fast(value) === FAIL) return node.run(value, at, issues);
			issues.push({ message, path: [...at, ...relative] });

			return undefined;
		},
		guard: undefined,
		missing: node.missing,
		handlesMissing: node.handlesMissing,
		score: function scoreCheck(value: unknown): number {
			// A value `schema` accepts only failed the predicate: as close as a rejected value gets.
			return node.fast(value) === FAIL ? scoreOf(node, value) : 0;
		}
	});
}

/**
 * Creates a parser that parses the value with `schema`, and reports one issue with `message` at the value when it fails, in place of
 * the issues of `schema` (the `error` option of zod's schemas): the wording a form shows next to its field. A missing property gets
 * `message` as well, instead of `Missing required property`. `message` may be a function of the rejected value.
 * @template S - The schema
 * @param {S} schema - The schema for the value
 * @param {string | ((value: unknown) => string)} message - The message, or a function returning it
 * @returns {Parser<SchemaOutput<S>>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}, or `message` is not a string or a function
 * @example
 * const signUp = { email: withError(isEmail, 'Enter a valid email'), age: withError(asInteger, 'Enter your age in years') };
 * safeParse(signUp, { age: '3.5' })[0]?.issues; // => [{ message: 'Enter a valid email', path: ['email'] }, { message: 'Enter your age in years', path: ['age'] }]
 * parse(signUp, { email: 'ada@example.com', age: '36' }); // => { email: 'ada@example.com', age: 36 }
 */
export function withError<S extends Schema>(schema: S, message: string | ((value: unknown) => string)): Parser<SchemaOutput<S>> {
	const node = compile('withError', 'schema', schema, []);

	if (typeof message !== 'string' && typeof message !== 'function') {
		throw new TypeError(`withError: \`message\` must be a string or a function, got ${describe(message)}`);
	}

	return toCompiledParser({
		fast: node.fast,
		// Only reached when the fast parse failed: the issues of `schema` are not even collected.
		run: function runWithError(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			issues.push({ message: typeof message === 'string' ? message : String(message(value)), path: path.slice() });

			return undefined;
		},
		guard: undefined,
		missing: node.missing,
		// Reported as is when the property is missing, rather than as `Missing required property`.
		handlesMissing: always,
		score: node.score
	});
}

/**
 * Creates a parser for arrays whose elements are parsed with `schema`, returning a new array of the outputs (`z.array()`). Every
 * index from `0` to `length - 1` is parsed, so holes are parsed as `undefined`; more than 65,536 holes in a row (only a sparse array
 * has them) fail with `Expected at most 65536 holes in a row` at the first, since parsing them would cost the array's length rather
 * than what it holds (4 billion checks for `length = 2 ** 32 - 1`). The same goes for {@link asArray} and {@link asList}. For
 * elements that only need checking, the guards module's `isArrayOf` works too (and returns the array itself).
 * @template S - The element schema
 * @param {S} schema - The schema of each element
 * @returns {Parser<SchemaOutput<S>[]>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * parse(arrayOf(asInteger), ['1', '2', 3]); // => [1, 2, 3]
 * safeParse(arrayOf(asInteger), ['1', 'x'])[0]?.issues; // => [{ message: 'Expected an integer or an integer string (got string)', path: [1] }]
 * safeParse(arrayOf(optional(asInteger)), Array(20))[0]?.issues; // => undefined
 * const sparse = ['1'];
 * sparse.length = 2 ** 32 - 1;
 * safeParse(arrayOf(optional(asInteger)), sparse)[0]?.issues; // => [{ message: 'Expected at most 65536 holes in a row', path: [1] }]
 */
export function arrayOf<S extends Schema>(schema: S): Parser<SchemaOutput<S>[]> {
	const node = compile('arrayOf', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastArray(value: unknown): unknown {
			return Array.isArray(value) ? parseElements(node, value) : FAIL;
		},
		run: function runArray(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (Array.isArray(value)) return reportElements(node, value, path, issues);
			issues.push({ message: `Expected an array (got ${describe(value)})`, path: path.slice() });

			return undefined;
		},
		guard: undefined
	});
}

/**
 * Parses every element of an array with the same schema (the fast parse of {@link arrayOf} and {@link asArray}).
 * @param {Node} node - The element schema
 * @param {ReadonlyArray<unknown>} elements - The elements (holes are read as `undefined`)
 * @returns {unknown} The new array of outputs, or {@link FAIL}
 */
function parseElements(node: Node, elements: ReadonlyArray<unknown>): unknown {
	const { guard, fast } = node;
	const output: unknown[] = [];
	const direct = readsHolesAsUndefined(elements);
	// The index from which a hole may start a long run (see `holesEnd`).
	let checked = 0;

	for (let index = 0; index < elements.length; index++) {
		let element = direct || hasOwn.call(elements, index) ? elements[index] : undefined;

		if (element === undefined && index >= checked && (checked = holesEnd(elements, index)) < 0) return FAIL;
		if (guard !== undefined) {
			if (!guard(element)) return FAIL;
		} else if ((element = fast(element)) === FAIL) {
			return FAIL;
		}
		output.push(element);
	}

	return output;
}

/**
 * Parses every element of an array with the same schema, reporting the issues of each with its index.
 * @param {Node} node - The element schema
 * @param {ReadonlyArray<unknown>} elements - The elements
 * @param {PropertyKey[]} path - The path of the array
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown[]} The new array of outputs
 */
function reportElements(node: Node, elements: ReadonlyArray<unknown>, path: PropertyKey[], issues: SchemaIssue[]): unknown[] {
	const output: unknown[] = [];
	const direct = readsHolesAsUndefined(elements);
	// The index from which a hole may start a long run (see `holesEnd`).
	let checked = 0;

	for (let index = 0; index < elements.length; index++) {
		const element = direct || hasOwn.call(elements, index) ? elements[index] : undefined;

		if (element === undefined && index >= checked && (checked = holesEnd(elements, index)) < 0) {
			// The elements after the run are not reported: finding the next one would cost a walk of the holes.
			issues.push({ message: `Expected at most ${MAX_HOLES} holes in a row`, path: [...path, index] });
			break;
		}
		path.push(index);
		output.push(rerun(node, element, path, issues));
		path.pop();
	}

	return output;
}

/** The most holes in a row that {@link arrayOf}, {@link asArray} and {@link asList} parse (see {@link holesEnd}). */
const MAX_HOLES = 65536;

/**
 * Where a run of holes from `index` ends, unless it holds more than {@link MAX_HOLES} holes, which {@link arrayOf}, {@link asArray} and
 * {@link asList} reject: only a sparse array has one, and parsing it would cost its length rather than what it holds (`[]` with
 * `length = 2 ** 32 - 1` would take 4 billion checks, and give as many issues: an out-of-memory abort). The parsers check again only
 * past the end returned, so that each index is checked once.
 * @param {ReadonlyArray<unknown>} elements - The array
 * @param {number} index - An index whose element reads `undefined`
 * @returns {number} The index after the first own element from `index` (or after the end), or `-1` for too long a run
 */
function holesEnd(elements: ReadonlyArray<unknown>, index: number): number {
	for (let at = index; at <= index + MAX_HOLES; at++) if (at >= elements.length || hasOwn.call(elements, at)) return at + 1;

	return -1;
}

/**
 * Whether `Array.prototype` (or `Object.prototype`, which it inherits from) has an enumerable property: what prototype pollution adds,
 * and what the holes of a sparse array would then read. Arrays are read element by element without an own-property check otherwise,
 * which keeps that check (2.5 times the cost of reading an element) off the common path.
 * @returns {boolean} Whether array elements must be read as own properties
 */
function isArrayPrototypePolluted(): boolean {
	for (const key in Array.prototype) return typeof key === 'string';

	return false;
}

/**
 * Whether the elements of `elements` can be read directly (a hole then reads `undefined`): it inherits from this realm's unpolluted
 * `Array.prototype`. Arrays of other realms, or with another prototype, are read as own properties, since what their holes read is
 * not known.
 * @param {ReadonlyArray<unknown>} elements - An array
 * @returns {boolean} Whether a direct read is safe
 */
function readsHolesAsUndefined(elements: ReadonlyArray<unknown>): boolean {
	return Object.getPrototypeOf(elements) === Array.prototype && !isArrayPrototypePolluted();
}

/**
 * Creates a parser like {@link arrayOf} that also accepts a single value, parsed as a one-element array: the shape of repeated query
 * parameters (`?tag=a` gives `'a'`, `?tag=a&tag=b` gives `['a', 'b']`) and of multi-value form fields. `undefined` is not wrapped, so
 * a missing key still fails: pair with {@link withDefault} for an empty default. An issue of a single value is reported at the
 * value's own path, without an index.
 * @template S - The element schema
 * @param {S} schema - The schema of each element
 * @returns {Parser<SchemaOutput<S>[]>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * import { parseQueryString } from 'tinkit/url';
 * const query = { tag: withDefault(asArray(isSlug), function () { return []; }), page: withDefault(asInteger, 1) };
 * parse(query, parseQueryString('?tag=ts&page=2')); // => { tag: ['ts'], page: 2 }
 * parse(query, parseQueryString('?tag=ts&tag=js')); // => { tag: ['ts', 'js'], page: 1 }
 * parse(query, parseQueryString('')); // => { tag: [], page: 1 }
 */
export function asArray<S extends Schema>(schema: S): Parser<SchemaOutput<S>[]> {
	const node = compile('asArray', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastAsArray(value: unknown): unknown {
			if (Array.isArray(value)) return parseElements(node, value);
			if (value === undefined) return FAIL;

			const element = node.fast(value);

			return element === FAIL ? FAIL : [element];
		},
		run: function runAsArray(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (Array.isArray(value)) return reportElements(node, value, path, issues);
			if (value === undefined) {
				issues.push({ message: 'Expected a value or an array (got undefined)', path: path.slice() });

				return undefined;
			}

			return [node.run(value, path, issues)];
		},
		guard: undefined
	});
}

/**
 * Splits a list written as one string.
 * @param {string} text - The list
 * @param {string} separator - The separator
 * @returns {string[]} The items, trimmed, without empty ones
 */
function splitList(text: string, separator: string): string[] {
	const items: string[] = [];

	for (const part of text.split(separator)) {
		const item = part.trim();

		if (item !== '') items.push(item);
	}

	return items;
}

/**
 * Creates a parser for lists written as one string, the way environment variables and query parameters carry them
 * (`ALLOWED_ORIGINS=https://a.com, https://b.com`): the string is split on `separator`, each item is trimmed (as `String#trim`
 * does), empty items are dropped, and every item is parsed with `schema`. An array is parsed element by element as it is, like
 * {@link arrayOf}. A missing value still fails: pair with {@link withDefault} for an empty default.
 * @template S - The item schema
 * @param {S} schema - The schema of each item
 * @param {string} [separator=','] - The string between items
 * @returns {Parser<SchemaOutput<S>[]>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}, or `separator` is not a non-empty string
 * @example
 * const env = { ORIGINS: asList(isUrl), PORTS: asList(asInteger), TAGS: withDefault(asList(isSlug, ' '), function () { return []; }) };
 * parse(env, { ORIGINS: 'https://a.com, https://b.com', PORTS: '80,443,' }); // => { ORIGINS: ['https://a.com', 'https://b.com'], PORTS: [80, 443], TAGS: [] }
 * safeParse(asList(asInteger), '1,two')[0]?.issues; // => [{ message: 'Expected an integer or an integer string (got string)', path: [1] }]
 */
export function asList<S extends Schema>(schema: S, separator = ','): Parser<SchemaOutput<S>[]> {
	const node = compile('asList', 'schema', schema, []);

	if (typeof separator !== 'string' || separator === '') {
		throw new TypeError(`asList: \`separator\` must be a non-empty string, got ${separator === '' ? 'empty string' : describe(separator)}`);
	}

	return toCompiledParser({
		fast: function fastAsList(value: unknown): unknown {
			if (typeof value === 'string') return parseElements(node, splitList(value, separator));

			return Array.isArray(value) ? parseElements(node, value) : FAIL;
		},
		run: function runAsList(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (typeof value === 'string') return reportElements(node, splitList(value, separator), path, issues);
			if (Array.isArray(value)) return reportElements(node, value, path, issues);
			issues.push({ message: `Expected a list string or an array (got ${describe(value)})`, path: path.slice() });

			return undefined;
		},
		guard: undefined
	});
}

/**
 * Creates a parser for arrays of exactly `schemas.length` elements, each parsed with the schema at the same index (`z.tuple()`).
 * @template S - The element schemas
 * @param {...S} schemas - One schema per position
 * @returns {Parser<{ -readonly [I in keyof S]: SchemaOutput<S[I]> }>} The parser, returning a new array
 * @throws {TypeError} when a schema is not a {@link Schema}
 * @example
 * const point = tuple(asNumber, asNumber);
 * parse(point, ['1.5', 2]); // => [1.5, 2]
 * safeParse(point, [1])[0]?.issues; // => [{ message: 'Expected a tuple of 2 elements (got 1 elements)', path: [] }]
 */
export function tuple<const S extends ReadonlyArray<Schema>>(...schemas: S): Parser<{ -readonly [I in keyof S]: SchemaOutput<S[I]> }> {
	const nodes = schemas.map(function (schema: Schema, index: number): Node {
		return compile('tuple', `schemas[${index}]`, schema, []);
	});

	return toCompiledParser({
		fast: function fastTuple(value: unknown): unknown {
			if (!Array.isArray(value) || value.length !== nodes.length) return FAIL;

			const output: unknown[] = [];
			const direct = readsHolesAsUndefined(value);

			for (let index = 0; index < nodes.length; index++) {
				const element = nodes[index].fast(direct || hasOwn.call(value, index) ? value[index] : undefined);

				if (element === FAIL) return FAIL;
				output.push(element);
			}

			return output;
		},
		run: function runTuple(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (!Array.isArray(value) || value.length !== nodes.length) {
				const got = Array.isArray(value) ? `${value.length} elements` : describe(value);

				issues.push({ message: `Expected a tuple of ${nodes.length} elements (got ${got})`, path: path.slice() });

				return undefined;
			}

			const output: unknown[] = [];
			const direct = readsHolesAsUndefined(value);

			for (let index = 0; index < nodes.length; index++) {
				path.push(index);
				output.push(rerun(nodes[index], direct || hasOwn.call(value, index) ? value[index] : undefined, path, issues));
				path.pop();
			}

			return output;
		},
		guard: undefined
	});
}

/**
 * Creates a parser that accepts `null` (returned as is) and parses any other value with `schema` (`.nullable()` in zod). For guards,
 * the guards module's `isNullable` does the same.
 * @template S - The schema
 * @param {S} schema - The schema for non-null values
 * @returns {Parser<SchemaOutput<S> | null>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * parse({ deletedAt: nullable(asDate) }, { deletedAt: null }); // => { deletedAt: null }
 * parse({ deletedAt: nullable(asDate) }, { deletedAt: 0 }); // => { deletedAt: new Date(0) }
 */
export function nullable<S extends Schema>(schema: S): Parser<SchemaOutput<S> | null> {
	const node = compile('nullable', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastNullable(value: unknown): unknown {
			return value === null ? null : node.fast(value);
		},
		// Only reached when the fast parse failed, so never for `null`.
		run: node.run,
		guard: undefined,
		missing: node.missing,
		handlesMissing: node.handlesMissing,
		score: node.score
	});
}

/**
 * Wraps a compiled schema so that `undefined` is accepted and returned as is (see {@link optional} and {@link partial}).
 * @param {Node} node - The schema for defined values
 * @returns {Node} The optional schema
 */
function optionalNode(node: Node): Node {
	// A value the inner schema treats as missing (a blank string, for `blankAsUndefined`) is absent too, so `partial` and
	// `optional(blankAsUndefined(...))` leave blank fields out instead of failing on them.
	return {
		fast: function fastOptional(value: unknown): unknown {
			return isAbsent(node, value) ? undefined : node.fast(value);
		},
		// Only reached when the fast parse failed, so never for a missing value.
		run: node.run,
		guard: undefined,
		missing: node.missing,
		handlesMissing: always,
		score: node.score
	};
}

/**
 * Throws a `TypeError` unless `schema` is a plain object of schemas (not a guard, a parser or another Standard Schema validator).
 * @param {string} caller - The public function name
 * @param {string} name - The parameter name
 * @param {unknown} schema - The value to check
 * @returns {void}
 * @throws {TypeError} when `schema` is not a plain object, or is a Standard Schema validator
 */
function assertObjectSchema(caller: string, name: string, schema: unknown): asserts schema is ObjectSchema {
	if (!isPlainObject(schema) || isStandardSchema(schema)) {
		throw new TypeError(`${caller}: \`${name}\` must be a plain object of schemas, got ${Array.isArray(schema) ? 'array' : describe(schema)}`);
	}
}

/**
 * Turns an object schema into one whose every property is optional (`.partial()` in zod): each schema is wrapped with
 * {@link optional}. The result is a plain object schema again, so it can be spread, picked (`objects.pick`) or nested. Shallow:
 * nested object schemas keep their required keys.
 * @template S - The object schema
 * @param {S} schema - The object schema
 * @returns {{ -readonly [K in keyof S]: Parser<SchemaOutput<S[K]> | undefined> }} The new object schema
 * @throws {TypeError} when `schema` is not a plain object of schemas
 * @example
 * import { isString } from 'tinkit/guards';
 * const user = { name: isString, age: asInteger };
 * const patch = partial(user);
 * parse(patch, { age: '37' }); // => { age: 37 }
 * parse(patch, {}); // => {}
 */
export function partial<S extends ObjectSchema>(schema: S): { -readonly [K in keyof S]: Parser<SchemaOutput<S[K]> | undefined> } {
	assertObjectSchema('partial', 'schema', schema);

	const output: Record<string, unknown> = {};

	for (const key of Object.keys(schema)) assign(output, key, toCompiledParser(optionalNode(compile('partial', `schema.${key}`, schema[key], []))));

	return output as { -readonly [K in keyof S]: Parser<SchemaOutput<S[K]> | undefined> };
}

/**
 * Creates a parser like an object schema that also rejects unknown keys (`z.strictObject()`), reporting each with `Unknown property`,
 * instead of stripping them. Only own enumerable string keys count.
 * @template S - The object schema
 * @param {S} schema - The object schema
 * @returns {Parser<SchemaOutput<S>>} The parser
 * @throws {TypeError} when `schema` is not a plain object of schemas
 * @example
 * const point = exact({ x: asNumber, y: asNumber });
 * parse(point, { x: '1', y: 2 }); // => { x: 1, y: 2 }
 * safeParse(point, { x: 1, y: 2, z: 3 })[0]?.issues; // => [{ message: 'Unknown property', path: ['z'] }]
 */
export function exact<S extends ObjectSchema>(schema: S): Parser<SchemaOutput<S>> {
	assertObjectSchema('exact', 'schema', schema);

	const node = compile('exact', 'schema', schema, []);
	const known = new Set(Object.keys(schema));

	return toCompiledParser({
		fast: function fastExact(value: unknown): unknown {
			const output = node.fast(value);

			if (output === FAIL) return FAIL;
			for (const key in value as object) if (hasOwn.call(value, key) && !known.has(key)) return FAIL;

			return output;
		},
		run: function runExact(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			const output = rerun(node, value, path, issues);

			if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
				for (const key in value) if (hasOwn.call(value, key) && !known.has(key)) issues.push({ message: 'Unknown property', path: [...path, key] });
			}

			return output;
		},
		guard: undefined,
		score: node.score
	});
}

/**
 * Lists strings for a message: `"a"`, `"a" or "b"`, `"a", "b" or "c"`.
 * @param {ReadonlyArray<string>} values - The strings
 * @returns {string} The list
 */
function alternatives(values: ReadonlyArray<string>): string {
	const quoted = values.map(function (value: string): string {
		return JSON.stringify(value);
	});

	return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/**
 * Returns the member closest to matching `value` (see {@link Node.score}), the first one on a tie.
 * @param {ReadonlyArray<Node>} nodes - The members (at least one)
 * @param {unknown} value - The value
 * @returns {Node} The closest member
 */
function closestOf(nodes: ReadonlyArray<Node>, value: unknown): Node {
	let closest = nodes[0];
	let best = scoreOf(closest, value);

	for (let index = 1; index < nodes.length && best > 0; index++) {
		const score = scoreOf(nodes[index], value);

		if (score < best) {
			closest = nodes[index];
			best = score;
		}
	}

	return closest;
}

/**
 * Creates a parser that returns the output of the first of `schemas` that accepts the value (`z.union()`). When none does, the issues
 * of the member that came closest are reported: for object members, the one with the fewest failing properties of a primitive value,
 * which for objects that differ by a field is the matching variant. Each member is tried in turn; for objects tagged by a field,
 * {@link discriminatedUnion} looks the variant up instead, and reports better.
 * @template S - The member schemas
 * @param {...S} schemas - The member schemas, tried in order (at least one)
 * @returns {Parser<SchemaOutput<S[number]>>} The parser
 * @throws {TypeError} when a member is not a {@link Schema}
 * @throws {RangeError} when no schema is given
 * @example
 * const id = union(asInteger, isUuid);
 * parse(id, '42'); // => 42
 * parse(id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479'); // => 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
 * parse(id, 'x'); // throws ValidationError
 */
export function union<const S extends ReadonlyArray<Schema>>(...schemas: S): Parser<SchemaOutput<S[number]>> {
	if (schemas.length === 0) throw new RangeError('union: expected at least one schema, got 0');

	const nodes = schemas.map(function (schema: Schema, index: number): Node {
		return compile('union', `schemas[${index}]`, schema, []);
	});

	return toCompiledParser({
		fast: function fastUnion(value: unknown): unknown {
			for (let index = 0; index < nodes.length; index++) {
				const output = nodes[index].fast(value);

				if (output !== FAIL) return output;
			}

			return FAIL;
		},
		run: function runUnion(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			// Only the closest member is reported (the first one on a tie): reporting every member, at every level of a recursive union,
			// would take exponential time on invalid input.
			return closestOf(nodes, value).run(value, path, issues);
		},
		guard: undefined,
		missing: nodes.some(function (node: Node): boolean {
			return node.missing !== undefined;
		})
			? function isMissing(value: unknown): boolean {
					// Missing when the member that wins (the first one to accept the value) says so, so that a blank string an earlier member
					// accepts stays a value; when none accepts it, missing if any member says so (for the `Missing required property` report).
					// Most values are flagged by no member: they are answered without parsing them, which `optional` and `withDefault` would
					// otherwise do twice at every level of a recursive union, running transforms twice.
					let flagged = false;

					for (let index = 0; index < nodes.length && !flagged; index++) flagged = flags(nodes[index], value);
					if (!flagged) return false;
					for (let index = 0; index < nodes.length; index++) if (nodes[index].fast(value) !== FAIL) return flags(nodes[index], value);

					return true;
				}
			: undefined,
		handlesMissing: function handlesMissingValues(): boolean {
			return nodes.some(handlesMissing);
		},
		score: function scoreUnion(value: unknown): number {
			return scoreOf(closestOf(nodes, value), value);
		}
	});
}

/**
 * The output type of a {@link discriminatedUnion} parser: for each variant, its output with the discriminant set to the variant name.
 * @template K - The discriminant key
 * @template V - The variant object schemas, by discriminant value
 */
export type DiscriminatedUnionOutput<K extends string, V extends { readonly [tag: string]: ObjectSchema }> = {
	[T in keyof V & (string | number)]: { [P in K]: `${T}` } & Omit<SchemaOutput<V[T]>, K> extends infer O ? { [P in keyof O]: O[P] } : never;
}[keyof V & (string | number)];

/**
 * Creates a parser for objects tagged by the OWN string property `key` (`z.discriminatedUnion()`): the variant named by the tag parses
 * the object, and the output starts with the tag. Each variant is an object schema of the other properties (it may repeat the tag,
 * whose schema is then ignored). The variant is looked up directly, so parsing stays fast with many variants, and an invalid value is
 * reported against the right variant, or with the allowed tags when the tag is wrong. Tags are strings; inherited properties
 * (`toString`, a polluted `Object.prototype`) never count.
 * @template K - The discriminant key
 * @template V - The variant object schemas, by discriminant value
 * @param {K} key - The discriminant property, e.g. `'type'`
 * @param {V} variants - A plain object mapping each discriminant value to the object schema of its variant (at least one)
 * @returns {Parser<DiscriminatedUnionOutput<K, V>>} The parser
 * @throws {TypeError} when `key` is not a string, `variants` is not a plain object, or a variant is not a plain object of schemas
 * @throws {RangeError} when `variants` is empty
 * @example
 * import { isString } from 'tinkit/guards';
 * const event = discriminatedUnion('type', {
 *   click: { x: asInteger, y: asInteger },
 *   key: { code: isString }
 * });
 * parse(event, { type: 'click', x: '10', y: '20', extra: 1 }); // => { type: 'click', x: 10, y: 20 }
 * safeParse(event, { type: 'key' })[0]?.issues; // => [{ message: 'Missing required property', path: ['code'] }]
 * safeParse(event, { type: 'scroll' })[0]?.issues; // => [{ message: 'Expected "click" or "key" (got string)', path: ['type'] }]
 */
export function discriminatedUnion<const K extends string, const V extends { readonly [tag: string]: ObjectSchema }>(
	key: K,
	variants: V
): Parser<DiscriminatedUnionOutput<K, V>> {
	if (typeof key !== 'string') throw new TypeError(`discriminatedUnion: \`key\` must be a string, got ${describe(key)}`);
	if (!isPlainObject(variants)) {
		throw new TypeError(`discriminatedUnion: \`variants\` must be a plain object, got ${Array.isArray(variants) ? 'array' : describe(variants)}`);
	}

	const tags = Object.keys(variants);

	if (tags.length === 0) throw new RangeError('discriminatedUnion: `variants` must have at least one variant, got 0');

	const lookup = new Map<unknown, Node>();

	for (const tag of tags) {
		const variant: unknown = variants[tag];

		assertObjectSchema('discriminatedUnion', `variants.${tag}`, variant);

		// The variant with the tag first: the output starts with it, and the object keeps its generated fast parse.
		const tagged: Record<string, unknown> = {};

		assign(tagged, key, function isTag(value: unknown): value is string {
			return value === tag;
		});
		for (const name of Object.keys(variant)) if (name !== key) assign(tagged, name, variant[name]);
		lookup.set(tag, compile('discriminatedUnion', `variants.${tag}`, tagged, []));
	}

	const expected = `Expected ${alternatives(tags)}`;

	return toCompiledParser({
		fast: function fastDiscriminated(value: unknown): unknown {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) return FAIL;

			const node = hasOwn.call(value, key) ? lookup.get((value as Record<string, unknown>)[key]) : undefined;

			return node === undefined ? FAIL : node.fast(value);
		},
		run: function runDiscriminated(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				issues.push({ message: `Expected an object (got ${Array.isArray(value) ? 'array' : describe(value)})`, path: path.slice() });

				return undefined;
			}
			if (!hasOwn.call(value, key)) {
				issues.push({ message: 'Missing required property', path: [...path, key] });

				return undefined;
			}

			const tag = (value as Record<string, unknown>)[key];
			const node = lookup.get(tag);

			if (node !== undefined) return node.run(value, path, issues);
			issues.push({ message: `${expected} (got ${describe(tag)})`, path: [...path, key] });

			return undefined;
		},
		guard: undefined,
		score: function scoreDiscriminated(value: unknown): number {
			const node =
				typeof value === 'object' && value !== null && !Array.isArray(value) && hasOwn.call(value, key)
					? lookup.get((value as Record<string, unknown>)[key])
					: undefined;

			if (node !== undefined) return scoreOf(node, value);

			// A wrong or missing tag: further than any failure of the right variant (below 1), closer than a value that is not an object.
			return typeof value === 'object' && value !== null && !Array.isArray(value) ? 1 : 2;
		}
	});
}

/**
 * Creates a parser for plain objects used as dictionaries (`z.record()`): every own enumerable string key is kept, its value parsed
 * with `schema`, and, when `keys` is given, the key itself checked by that guard. The output is a new object (an own `__proto__` key
 * stays an own property). Class instances, maps and arrays are rejected; symbol keys are ignored.
 * @template S - The value schema
 * @template K - The key type
 * @param {S} schema - The schema of every value
 * @param {Guard<K>} [keys] - A guard every key must pass, e.g. `isOneOf(['en', 'fr'])` or `isStringMatching(/^[a-z]{2}$/)`
 * @returns {Parser<string extends K ? Record<string, SchemaOutput<S>> : Partial<Record<K, SchemaOutput<S>>>>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}, or `keys` is neither a function nor `undefined`
 * @example
 * import { isOneOf, isString } from 'tinkit/guards';
 * parse(recordOf(asInteger), { a: '1', b: 2 }); // => { a: 1, b: 2 }
 * const translations = recordOf(isString, isOneOf(['en', 'fr']));
 * safeParse(translations, { en: 'Hi', de: 'Hallo' })[0]?.issues; // => [{ message: 'Invalid key: Expected one of 2 allowed values (got string)', path: ['de'] }]
 */
export function recordOf<S extends Schema, K extends string = string>(
	schema: S,
	keys?: Guard<K>
): Parser<string extends K ? Record<string, SchemaOutput<S>> : Partial<Record<K, SchemaOutput<S>>>> {
	const node = compile('recordOf', 'schema', schema, []);

	if (keys !== undefined && typeof keys !== 'function') throw new TypeError(`recordOf: \`keys\` must be a function, got ${describe(keys)}`);

	return toCompiledParser({
		fast: function fastRecord(value: unknown): unknown {
			if (!isPlainObject(value)) return FAIL;

			const { guard, fast } = node;
			const output: Record<string, unknown> = {};

			for (const name of Object.keys(value)) {
				if (keys !== undefined && !keys(name)) return FAIL;

				let result = value[name];

				if (guard !== undefined) {
					if (!guard(result)) return FAIL;
				} else if ((result = fast(result)) === FAIL) {
					return FAIL;
				}
				assign(output, name, result);
			}

			return output;
		},
		run: function runRecord(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (!isPlainObject(value)) {
				issues.push({ message: `Expected a plain object (got ${Array.isArray(value) ? 'array' : describe(value)})`, path: path.slice() });

				return undefined;
			}

			const output: Record<string, unknown> = {};

			for (const name of Object.keys(value)) {
				path.push(name);
				if (keys !== undefined && !keys(name)) {
					const found = explainTo(keys, name, issues);

					if (found.length === 0) issues.push({ message: 'Invalid key', path: path.slice() });
					for (const issue of found) issues.push({ message: `Invalid key: ${issue.message}`, path: path.slice() });
				}
				assign(output, name, rerun(node, value[name], path, issues));
				path.pop();
			}

			return output;
		},
		guard: undefined
	});
}

/**
 * Creates a parser for recursive schemas (`z.lazy()`): `getter` returns the schema, and is called once, on first use, so the schema
 * can refer to the parser being defined. Annotate the result (`const tree: Parser<Tree> = lazy(...)`), since TypeScript cannot infer a
 * recursive type. Cycle-safe: a value that reaches itself through the same lazy parser (`node.children = [node]`) is rejected with
 * `Circular reference`, instead of overflowing the stack, and a value nested too deeply to parse fails with `Value is nested too
 * deeply`. Inside a lazy parser, each object is parsed once by each lazy parser it reaches, which keeps a recursive {@link union}
 * linear in the size of the value however its members differ: an object the value holds in two places parses to the same output, and
 * when it is invalid its issues are reported at the first place only, the others getting one `Invalid value (same object as reported
 * at another path)` issue (so a value sharing objects, such as YAML aliases, cannot make the report grow exponentially).
 * @template T - The output type
 * @param {() => Schema} getter - Returns the schema (called once, on the first parse)
 * @returns {Parser<T>} The parser
 * @throws {TypeError} when `getter` is not a function, and on first use when it does not return a {@link Schema}
 * @example
 * import { isString } from 'tinkit/guards';
 * type Comment = { text: string; replies: Comment[] };
 * const comment: Parser<Comment> = lazy(function () {
 *   return { text: isString, replies: withDefault(arrayOf(comment), function () { return []; }) };
 * });
 * parse(comment, { text: 'a', replies: [{ text: 'b' }] }); // => { text: 'a', replies: [{ text: 'b', replies: [] }] }
 */
export function lazy<T>(getter: () => Schema): Parser<T> {
	if (typeof getter !== 'function') throw new TypeError(`lazy: \`getter\` must be a function, got ${describe(getter)}`);

	let resolved: Node | undefined;
	let resolving = false;
	// The output for each object parsed by this parser during the current parse (see `utils/memo.ts`), and the objects reported during
	// it: `PENDING` while being reported (meeting one again means a cycle), then where its issues went (a `LazyReport`), so that an object
	// reached again by another path is not reported again (once per path would be exponential in the depth of the objects a value
	// shares). The report the caller sees (`rootIssues`) always holds the issues its pointers refer to: an object reported only by a parse
	// nested in a guard, a check or a transform, whose list it does not hold, or whose issues it dropped since (a missing property sums
	// its issues up as `Missing required property`), is reported again there. A nested parse gets the pointer for an object reported
	// anywhere, so that a guard parsing with this very parser, at every level of a value, stays linear too.
	const memo = new Map<object, unknown>();
	const reported = new Map<object, unknown>();
	// The values being scored: a union that reaches this parser again on the same value (`lazy(() => union(a, nullable(self)))`) would
	// score it forever. Held like the memos, so that a `delete` that overflowed cannot leave a value scored as 1 for good.
	const scoring = new Set<object>();

	/**
	 * Returns the compiled schema, calling `getter` on first use.
	 * @returns {Node} The compiled schema
	 */
	function resolve(): Node {
		if (resolved === undefined) {
			// A getter that returns this very parser, or parses with it while it resolves, would recurse until the stack overflows.
			if (resolving) throw new TypeError('lazy: `getter` must not resolve to (or parse with) this lazy schema itself');
			resolving = true;
			try {
				resolved = compile('lazy', 'getter()', getter(), []);
			} finally {
				resolving = false;
			}
			if (resolved.fast === fastLazy) {
				resolved = undefined;
				throw new TypeError('lazy: `getter` must not resolve to (or parse with) this lazy schema itself');
			}
		}

		return resolved;
	}

	/**
	 * The fast parse of the lazy schema.
	 * @param {unknown} value - The value to parse
	 * @returns {unknown} The output, or {@link FAIL}
	 */
	function fastLazy(value: unknown): unknown {
		const node = resolve();

		if (typeof value !== 'object' || value === null) return node.fast(value);
		// An outermost parse finding outputs in its own memo follows one whose `release` overflowed: they may be stale (see `report`).
		if (scope.depth === 0 && memo.size !== 0) release();

		const known = memo.get(value);

		if (known === PENDING) {
			scope.cycles++;

			return FAIL;
		}
		if (known !== undefined || memo.has(value)) return known;
		hold(memo).set(value, PENDING);

		const cycles = scope.cycles;

		// The outermost lazy parser of a fast parse scopes the memos of the parsers it reaches to its call.
		scope.depth++;
		scope.checks++;
		try {
			const output = node.fast(value);

			// An output that met a cycle depends on the path that led here (which objects were being parsed): it is not remembered.
			if (scope.cycles === cycles) memo.set(value, output);
			else memo.delete(value);

			return output;
		} catch (error) {
			// Recorded inline, without a call, since a call can overflow again: the first lazy schema to see the error is the deepest.
			if (scope.thrown !== error) {
				scope.thrown = error;
				scope.thrownAt = scope.depth;
			}
			// A value too deep to parse fails; the reporting parse then reports it (see `execute`).
			if (scope.depth === 1 && isTooDeep(error)) return FAIL;
			memo.delete(value);
			throw error;
		} finally {
			if (--scope.checks === 0) scope.checkRoot = undefined;
			if (--scope.depth === 0) release();
		}
	}

	return toCompiledParser({
		fast: fastLazy,
		run: function runLazy(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			const node = resolve();

			if (typeof value !== 'object' || value === null) return node.run(value, path, issues);
			if (scope.depth === 0) release();

			let state = reported.get(value) as LazyReport | undefined;

			// Reported by a surfaced report: its first issue is now where the report around it copied it.
			for (let copy; state !== undefined && state !== PENDING && (copy = moved.get(state.first)) !== undefined;) reported.set(value, (state = copy as LazyReport));
			// In the caller's report, an object whose issues are not there (any longer) is reported in full; see `reported` above.
			if (
				state !== undefined &&
				(state === PENDING || issues !== rootIssues || (state.list[state.index] === state.first && (state.list === issues || outers.has(state.list))))
			) {
				issues.push({ message: state === PENDING ? 'Circular reference' : 'Invalid value (same object as reported at another path)', path: path.slice() });

				return undefined;
			}
			hold(reported).set(value, PENDING);

			const length = path.length;
			const before = issues.length;
			let failed = false;

			// A parser of another copy of tinkit may report through this one: the scope keeps `reported` until this call returns.
			if (scope.depth++ === 0) rootIssues = issues;
			scope.checks++;
			try {
				// The fast parse of this very value just failed: parsing it again first would double the cost at every level.
				const output = node.run(value, path, issues);

				// Only a value that had issues is remembered: one whose report found nothing (a schema that is not deterministic) or threw is
				// reported again when met again.
				failed = issues.length > before;

				return output;
			} catch (error) {
				// Recorded inline, without a call, since a call can overflow again: the first lazy schema to see the error is the deepest.
				if (scope.thrown !== error) {
					scope.thrown = error;
					scope.thrownAt = scope.depth;
				}
				// Reporting for another copy of tinkit: the value too deep to parse is reported here, where the depth is known.
				if (scope.depth === 1 && isTooDeep(error)) {
					// The error skipped the `pop` of every key pushed below this value.
					path.length = length;
					issues.push({ message: 'Value is nested too deeply', path: path.slice() });

					return undefined;
				}
				throw error;
			} finally {
				// The scope first: the map calls below can overflow (see `report`).
				if (--scope.checks === 0) scope.checkRoot = undefined;
				if (--scope.depth === 0) rootIssues = undefined;
				if (failed) reported.set(value, { index: before, first: issues[before], list: issues });
				else reported.delete(value);
				if (scope.depth === 0) release();
			}
		},
		guard: undefined,
		// The hooks resolve the schema when they are called, during a parse: wrapping this parser while the recursive schema is still
		// being defined (`nullable(lazy(() => Tree))` inside `Tree`) must not call `getter` yet.
		missing: function isMissing(value: unknown): boolean {
			return flags(resolve(), value);
		},
		handlesMissing: function handlesMissingValues(): boolean {
			return handlesMissing(resolve());
		},
		score: function scoreLazy(value: unknown): number {
			if (scoring.has(value as object)) return 1;
			hold(scoring).add(value as object);
			try {
				return scoreOf(resolve(), value);
			} finally {
				scoring.delete(value as object);
			}
		}
	});
}

/**
 * Whether `value` is a blank string: empty, or only whitespace (as `String#trim` defines it).
 * @param {unknown} value - The value
 * @returns {boolean} `true` for blank strings
 */
function isBlank(value: unknown): boolean {
	return typeof value === 'string' && value.trim() === '';
}

/**
 * Creates a parser that treats blank strings (empty, or only whitespace) as missing: what an empty HTML form field sends. The schema
 * receives `undefined` instead, and in an object a blank property counts as absent: a required one fails with `Missing required
 * property`, and an {@link optional} one is left out of the output. Wrap the outermost schema of the field
 * (`blankAsUndefined(withDefault(asInteger, 1))`, not the other way around).
 * @template S - The schema
 * @param {S} schema - The schema applied after the conversion
 * @returns {Parser<SchemaOutput<S>>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * import { isString } from 'tinkit/guards';
 * const form = { age: blankAsUndefined(optional(asInteger)), name: blankAsUndefined(isString) };
 * parse(form, { age: '', name: 'Ada' }); // => { name: 'Ada' }
 * safeParse(form, { age: '36', name: '  ' })[0]?.issues; // => [{ message: 'Missing required property', path: ['name'] }]
 */
export function blankAsUndefined<S extends Schema>(schema: S): Parser<SchemaOutput<S>> {
	const node = compile('blankAsUndefined', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastBlank(value: unknown): unknown {
			return node.fast(isBlank(value) ? undefined : value);
		},
		run: function runBlank(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			return node.run(isBlank(value) ? undefined : value, path, issues);
		},
		guard: undefined,
		handlesMissing: node.handlesMissing,
		missing: isBlank,
		score: function scoreBlank(value: unknown): number {
			return scoreOf(node, isBlank(value) ? undefined : value);
		}
	});
}

/**
 * Creates a parser for strings holding JSON (an environment variable, a form field, a message payload): the text is parsed with
 * {@link parseJson}, so `__proto__` and `constructor.prototype` keys are rejected, and the result is parsed with `schema`, whose issues
 * are reported below the string's path. The text never appears in issue messages (it may hold secrets).
 * @template S - The schema of the parsed JSON
 * @param {S} schema - The schema of the parsed value
 * @returns {Parser<SchemaOutput<S>>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * import { isString } from 'tinkit/guards';
 * const env = { FEATURES: asJson(arrayOf(isString)), LIMITS: asJson({ rpm: asInteger }) };
 * parse(env, { FEATURES: '["beta"]', LIMITS: '{"rpm":"60"}' }); // => { FEATURES: ['beta'], LIMITS: { rpm: 60 } }
 * safeParse(env, { FEATURES: '[beta]', LIMITS: '{}' })[0]?.issues; // => [{ message: 'Expected valid JSON (got string)', path: ['FEATURES'] }, { message: 'Missing required property', path: ['LIMITS', 'rpm'] }]
 */
export function asJson<S extends Schema>(schema: S): Parser<SchemaOutput<S>> {
	const node = compile('asJson', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastJson(value: unknown): unknown {
			if (typeof value !== 'string') return FAIL;

			const [error, parsed] = parseJson(value);

			return error === undefined ? node.fast(parsed) : FAIL;
		},
		run: function runJson(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (typeof value !== 'string') return reject(value, path, issues, 'a JSON string');

			const [error, parsed] = parseJson(value);

			if (error === undefined) return node.run(parsed, path, issues);
			// A forbidden key is reported as such; the engine's message for invalid JSON quotes the text, so it is not used.
			issues.push({
				message: error.message.startsWith('parseJson:') ? 'Expected JSON without "__proto__" or "constructor.prototype" keys' : 'Expected valid JSON (got string)',
				path: path.slice()
			});

			return undefined;
		},
		guard: undefined
	});
}

/**
 * Reports the value a leaf parser rejected. Leaf parsers are deterministic, and their reporting parse only runs after their fast parse
 * failed, so it never needs to parse again.
 * @param {unknown} value - The rejected value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where the issue is pushed
 * @param {string} expected - What the parser accepts, for the message
 * @returns {undefined} Nothing (the output of a failed parse)
 */
function reject(value: unknown, path: PropertyKey[], issues: SchemaIssue[], expected: string): undefined {
	issues.push({ message: `Expected ${expected} (got ${describe(value)})`, path: path.slice() });

	return undefined;
}

/**
 * Coerces to a finite number.
 * @param {unknown} value - The value
 * @returns {unknown} The number, or {@link FAIL}
 */
function fastNumber(value: unknown): unknown {
	if (typeof value === 'number') return Number.isFinite(value) ? value : FAIL;
	if (typeof value !== 'string') return FAIL;

	const text = value.trim();

	if (!NUMERIC_PATTERN.test(text)) return FAIL;

	const number = Number(text);

	return Number.isFinite(number) ? number : FAIL;
}

/**
 * Reports a value {@link asNumber} rejected.
 * @param {unknown} value - The value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} Always `undefined`
 */
function runNumber(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	return reject(value, path, issues, 'a number or a numeric string');
}

/** An optional sign and decimal digits: the strings {@link asInteger} accepts (after trimming). */
const INTEGER_PATTERN = /^[+-]?[0-9]+$/;

/**
 * Coerces to a safe integer.
 * @param {unknown} value - The value
 * @returns {unknown} The integer, or {@link FAIL}
 */
function fastInteger(value: unknown): unknown {
	if (typeof value === 'number') return Number.isSafeInteger(value) ? value : FAIL;
	if (typeof value !== 'string') return FAIL;

	const text = value.trim();

	if (!INTEGER_PATTERN.test(text)) return FAIL;

	const integer = Number(text);

	return Number.isSafeInteger(integer) ? integer : FAIL;
}

/**
 * Reports a value {@link asInteger} rejected.
 * @param {unknown} value - The value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} Always `undefined`
 */
function runInteger(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	return reject(value, path, issues, 'an integer or an integer string');
}

/**
 * Coerces to a boolean.
 * @param {unknown} value - The value
 * @returns {unknown} The boolean, or {@link FAIL}
 */
function fastBoolean(value: unknown): unknown {
	if (typeof value === 'boolean') return value;
	switch (typeof value === 'string' ? value.trim().toLowerCase() : value) {
		case 'true':
		case 'yes':
		case 'on':
		case '1':
		case 1:
			return true;
		case 'false':
		case 'no':
		case 'off':
		case '0':
		case 0:
			return false;
		default:
			return FAIL;
	}
}

/**
 * Reports a value {@link asBoolean} rejected.
 * @param {unknown} value - The value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} Always `undefined`
 */
function runBoolean(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	return reject(value, path, issues, 'a boolean or a boolean string such as "true" or "false"');
}

/**
 * Coerces to a valid `Date`.
 * @param {unknown} value - The value
 * @returns {unknown} The date, or {@link FAIL}
 */
function fastDate(value: unknown): unknown {
	if (isDate(value)) return Number.isNaN(Date.prototype.getTime.call(value)) ? FAIL : value;
	if (typeof value === 'number') {
		const date = new Date(value);

		return Number.isNaN(date.getTime()) ? FAIL : date;
	}
	if (typeof value !== 'string') return FAIL;

	const time = isoTimestamp(value.trim());

	return time === time ? new Date(time) : FAIL;
}

/**
 * Reads the decimal number written from `start` to `end` (excluded) in `text`.
 * @param {string} text - The text
 * @param {number} start - The index of the first digit
 * @param {number} end - The index after the last digit
 * @returns {number} The number, or `-1` when a character is not an ASCII digit (or is past the end of `text`)
 */
function digitsAt(text: string, start: number, end: number): number {
	let number = 0;

	for (let index = start; index < end; index++) {
		const digit = text.charCodeAt(index) - 48;

		// Written so that `NaN` (past the end of `text`) fails too.
		if (!(digit >= 0 && digit <= 9)) return -1;
		number = number * 10 + digit;
	}

	return number;
}

/**
 * Parses the strings {@link isIsoDateTimeString} or {@link isIsoDateString} accept, to the timestamp `new Date(text)` gives (fractions
 * of a millisecond are truncated, `YYYY-MM-DD` is UTC midnight), in one pass over the characters: about three times faster than
 * validating with those, then letting `Date` parse the text again.
 * @param {string} text - The text
 * @returns {number} The timestamp in milliseconds, or `NaN` for any other string
 */
function isoTimestamp(text: string): number {
	const length = text.length;

	if (length < 10 || text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45) return NaN;

	const year = digitsAt(text, 0, 4);
	const month = digitsAt(text, 5, 7);
	const day = digitsAt(text, 8, 10);

	if (year < 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return NaN;

	// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's `days_from_civil`), exact for every 4-digit year.
	const shifted = month <= 2 ? year - 1 : year;
	const era = Math.floor(shifted / 400);
	const yearOfEra = shifted - era * 400;
	const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
	const days = era * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719468;

	if (length === 10) return days * 864e5;

	const separator = text.charCodeAt(10);

	// The shortest date-time is `YYYY-MM-DDThh:mm:ssZ`.
	if (length < 20 || (separator !== 84 && separator !== 116) || text.charCodeAt(13) !== 58 || text.charCodeAt(16) !== 58) return NaN;

	const hours = digitsAt(text, 11, 13);
	const minutes = digitsAt(text, 14, 16);
	const seconds = digitsAt(text, 17, 19);

	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return NaN;

	let index = 19;
	let milliseconds = 0;

	if (text.charCodeAt(index) === 46) {
		const start = ++index;

		for (let digit = text.charCodeAt(index) - 48; digit >= 0 && digit <= 9; digit = text.charCodeAt(++index) - 48) {
			if (index - start < 3) milliseconds = milliseconds * 10 + digit;
		}
		if (index === start) return NaN;
		milliseconds *= index - start === 1 ? 100 : index - start === 2 ? 10 : 1;
	}

	const sign = text.charCodeAt(index);
	let offset = 0;

	if (sign === 90 || sign === 122) {
		if (index + 1 !== length) return NaN;
	} else if ((sign === 43 || sign === 45) && index + 6 === length && text.charCodeAt(index + 3) === 58) {
		const offsetHours = digitsAt(text, index + 1, index + 3);
		const offsetMinutes = digitsAt(text, index + 4, index + 6);

		if (offsetHours < 0 || offsetHours > 23 || offsetMinutes < 0 || offsetMinutes > 59) return NaN;
		offset = (sign === 43 ? 1 : -1) * (offsetHours * 60 + offsetMinutes);
	} else {
		return NaN;
	}

	return days * 864e5 + hours * 36e5 + minutes * 6e4 + seconds * 1e3 + milliseconds - offset * 6e4;
}

/**
 * Reports a value {@link asDate} rejected.
 * @param {unknown} value - The value
 * @param {PropertyKey[]} path - Its path
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} Always `undefined`
 */
function runDate(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	return reject(value, path, issues, 'a valid date, an ISO 8601 string or a timestamp');
}

/**
 * Parses finite numbers, and numeric strings (surrounding whitespace ignored, as `String#trim` defines it) to numbers: `z.coerce.number()` without its traps.
 * The empty string, `'abc'`, `'Infinity'`, `'0x1f'`, `NaN`, `null`, booleans and dates are rejected instead of becoming `0`, `1`,
 * `NaN` or a timestamp. For integers use {@link asInteger}; to check a range, {@link chain} a guard such as `isNumberInRange`.
 * @example
 * parse(asNumber, '42.5'); // => 42.5
 * parse(asNumber, ' -1e3 '); // => -1000
 * parse(asNumber, 7); // => 7
 * parse(asNumber, ''); // throws ValidationError // z.coerce.number() gives 0
 * parse(asNumber, null); // throws ValidationError // z.coerce.number() gives 0
 */
export const asNumber: Parser<number> = {
	'~tink.1': { fast: fastNumber, run: runNumber, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<number> {
			return validateWith(fastNumber, runNumber, value) as StandardSchemaResult<number>;
		}
	}
} as CompiledParser<number>;

/**
 * Parses safe integers, and strings of decimal digits with an optional sign (surrounding whitespace ignored, as `String#trim` defines it), to numbers. Fractions
 * (`'1.5'`, `1.5`), exponents (`'1e3'`), the empty string and integers beyond `Number.MAX_SAFE_INTEGER` (which would silently lose
 * precision) are rejected.
 * @example
 * parse(asInteger, '8080'); // => 8080
 * parse(asInteger, '-3'); // => -3
 * parse(asInteger, '1.5'); // throws ValidationError
 * parse(asInteger, '9007199254740993'); // throws ValidationError // would round to 9007199254740992
 */
export const asInteger: Parser<number> = {
	'~tink.1': { fast: fastInteger, run: runInteger, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<number> {
			return validateWith(fastInteger, runInteger, value) as StandardSchemaResult<number>;
		}
	}
} as CompiledParser<number>;

/**
 * The fast parse of {@link asBigInt}.
 * @param {unknown} value - The value
 * @returns {unknown} The bigint, or `FAIL`
 */
function fastBigInt(value: unknown): unknown {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : FAIL;
	if (typeof value !== 'string') return FAIL;

	const text = value.trim();

	return INTEGER_PATTERN.test(text) ? BigInt(text) : FAIL;
}

/**
 * The reporting parse of {@link asBigInt}.
 * @param {unknown} value - The value
 * @param {PropertyKey[]} path - The path of `value`
 * @param {SchemaIssue[]} issues - Where issues are pushed
 * @returns {unknown} `undefined`
 */
function runBigInt(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
	return reject(value, path, issues, 'a bigint, an integer or an integer string');
}

/**
 * Parses bigints, safe integers and integer strings (an optional sign and decimal digits, surrounding whitespace ignored, of any
 * length) to bigints: 64-bit database ids and snowflake ids, which `asInteger` would reject beyond `Number.MAX_SAFE_INTEGER`.
 * Numbers beyond the safe range are rejected, since their digits are already rounded.
 * @example
 * parse(asBigInt, '9007199254740993'); // => 9007199254740993n
 * parse(asBigInt, 42); // => 42n
 * parse(asBigInt, 9007199254740993); // throws ValidationError
 * parse(asBigInt, '1e3'); // throws ValidationError
 */
export const asBigInt: Parser<bigint> = {
	'~tink.1': { fast: fastBigInt, run: runBigInt, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<bigint> {
			return validateWith(fastBigInt, runBigInt, value) as StandardSchemaResult<bigint>;
		}
	}
} as CompiledParser<bigint>;

/**
 * Parses booleans, the numbers `1` and `0`, and the strings `'true'`/`'false'`, `'yes'`/`'no'`, `'on'`/`'off'` and `'1'`/`'0'` (case and
 * surrounding whitespace, as `String#trim` defines it, ignored) to booleans: environment variables, query strings and checkboxes (an HTML checkbox sends `'on'`).
 * Anything else, the empty string included, is rejected: unlike `z.coerce.boolean()`, `'false'` is `false`.
 * @example
 * parse(asBoolean, 'false'); // => false // z.coerce.boolean() gives true
 * parse(asBoolean, ' YES '); // => true
 * parse(asBoolean, 'on'); // => true
 * parse(asBoolean, 0); // => false
 * parse(asBoolean, 'maybe'); // throws ValidationError
 */
export const asBoolean: Parser<boolean> = {
	'~tink.1': { fast: fastBoolean, run: runBoolean, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<boolean> {
			return validateWith(fastBoolean, runBoolean, value) as StandardSchemaResult<boolean>;
		}
	}
} as CompiledParser<boolean>;

/**
 * Parses valid dates (returned as they are, not copied), timestamps in milliseconds, and ISO 8601 strings (surrounding whitespace
 * ignored, as `String#trim` defines it): RFC 3339 date-times with an offset (see {@link isIsoDateTimeString}) and `YYYY-MM-DD` dates,
 * read as UTC midnight like `new Date('2024-01-05')`. Invalid dates,
 * impossible calendar dates (`'2023-02-29'`), local date-times without an offset and loose formats (`'01/05/2024'`, `''`) are rejected,
 * so the result never depends on the machine's time zone.
 * @example
 * parse(asDate, '2024-02-29T12:00:00Z'); // => new Date(Date.UTC(2024, 1, 29, 12))
 * parse(asDate, '2024-01-05'); // => new Date(Date.UTC(2024, 0, 5))
 * parse(asDate, 0); // => new Date(0)
 * parse(asDate, '2023-02-29'); // throws ValidationError
 * parse(asDate, '2024-01-05T12:00:00'); // throws ValidationError // no offset: the time zone would be guessed
 */
export const asDate: Parser<Date> = {
	'~tink.1': { fast: fastDate, run: runDate, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<Date> {
			return validateWith(fastDate, runDate, value) as StandardSchemaResult<Date>;
		}
	}
} as CompiledParser<Date>;

// ---------------------------------------------------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Options accepted by {@link parseEnv}. Only own properties are read, so a polluted `Object.prototype` cannot set one.
 */
export interface ParseEnvOptions {
	/**
	 * Prepended to every key of the schema to form the name of the variable read: with `'APP_'`, `{ PORT: asInteger }` reads `APP_PORT`
	 * and returns `{ PORT }`. Problems are reported under the full variable names. Defaults to `''`.
	 */
	prefix?: string;
	/**
	 * Whether a blank value (empty, or only whitespace) counts as unset: a required variable then fails as missing, and one with a
	 * default gets the default. Defaults to `true`, since `FOO=` in a `.env` file or `FOO: ${FOO}` in a compose file almost always means
	 * "not set"; pass `false` when an empty string is a meaningful value.
	 */
	blankAsMissing?: boolean;
	/**
	 * Whether to report every variable whose name starts with `prefix` but that the schema does not declare, as `Unknown variable`: a typo
	 * such as `APP_PROT` then fails at startup instead of being silently ignored. Requires a non-empty `prefix`. Defaults to `false`.
	 */
	strict?: boolean;
}

/** The type names in a `(got …)` part of an issue message that {@link parseEnv} passes on. */
const TYPE_NAME = /^(?:undefined|null|boolean|number|bigint|string|symbol|object|function|array)$/;

/** The messages (without their `(got …)` part) that {@link parseEnv} passes on as they are: fixed texts of this module and of guards. */
const FIXED_MESSAGE =
	/^(?:Invalid value|Invalid key|Missing required property|Unknown property|Circular reference|Value is nested too deeply|Expected (?:an array|an object|a plain object|a value or an array|a list string or an array|a JSON string|valid JSON|a finite number|a number or a numeric string|an integer or an integer string|a bigint, an integer or an integer string|a valid date, an ISO 8601 string or a timestamp|a boolean or a boolean string such as "true" or "false"|JSON without "__proto__" or "constructor\.prototype" keys))$/;

/** Messages of this module and of guards whose variable parts {@link parseEnv} drops, each with the fixed text it reports instead. */
const GENERIC_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^Expected a number between /, 'Expected a number in the allowed range'],
	[/^Expected an integer between /, 'Expected an integer in the allowed range'],
	[/^Expected a string of /, 'Expected a string of the allowed length'],
	[/^Expected a string matching /, 'Expected a string matching the required pattern'],
	[/^Expected (?:one of |")/, 'Expected one of the allowed values'],
	[/^Expected a tuple of /, 'Expected a tuple of the allowed length'],
	[/^Invalid key: /, 'Invalid key']
];

/** The names of the built-in errors, the only names {@link parseEnv} reports for a schema that throws. */
const ERROR_NAME = /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|AggregateError|ValidationError)$/;

/**
 * Turns an issue message into one built only from fixed texts (see {@link parseEnv}), so that no part of a value can reach it.
 * @param {unknown} message - The message of an issue
 * @returns {string} A fixed text, followed by the type of the rejected value when the message named one
 */
function envMessage(message: unknown): string {
	if (typeof message !== 'string') return 'Invalid value';

	const got = / \(got ([^()]*)\)$/.exec(message);
	const head = got === null ? message : message.slice(0, got.index);
	const suffix = got !== null && TYPE_NAME.test(got[1]) ? ` (got ${got[1]})` : '';

	if (FIXED_MESSAGE.test(head)) return head + suffix;
	for (const [pattern, text] of GENERIC_MESSAGES) if (pattern.test(head)) return text + suffix;

	return `Invalid value${suffix}`;
}

/**
 * Builds the path of an issue for {@link parseEnv}: the variable name, then the array indexes at the start of the issue's own path.
 * Object keys are dropped (with everything after them), since they may come from the value (a JSON object, a record).
 * @param {string} name - The variable name
 * @param {ReadonlyArray<unknown>} path - The issue's path below the variable
 * @returns {PropertyKey[]} The path
 */
function envPath(name: string, path: ReadonlyArray<unknown>): PropertyKey[] {
	const output: PropertyKey[] = [name];

	for (const segment of path) {
		if (!(typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0)) break;
		output.push(segment);
	}

	return output;
}

/**
 * Names what a schema threw, for {@link parseEnv}: a built-in error name, never its message.
 * @param {unknown} error - What was thrown
 * @returns {string} The error name, or `'an exception'`
 */
function thrownName(error: unknown): string {
	let name: unknown;

	try {
		name = (error as { name?: unknown } | null | undefined)?.name;
	} catch {
		// A getter that throws: an exception without a usable name.
	}

	return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'an exception';
}

/**
 * Reads an own property of the options of {@link parseEnv}.
 * @param {object} options - The options
 * @param {string} key - The option name
 * @returns {unknown} Its value, or `undefined` when it is not an own property
 */
function ownOption(options: object, key: string): unknown {
	return hasOwn.call(options, key) ? (options as Record<string, unknown>)[key] : undefined;
}

/**
 * Returns `process.env`, looked up through `globalThis` (Node, Bun and Deno have it; browsers and some edge runtimes do not).
 * @returns {object} The environment variables
 * @throws {Error} when there is no `process.env`
 */
function processEnv(): object {
	const env = (globalThis as unknown as { process?: { env?: unknown } }).process?.env;

	if (typeof env !== 'object' || env === null) {
		throw new Error('parseEnv: `env` was not given and `process.env` is not available in this environment; pass the variables, e.g. `parseEnv(schema, import.meta.env)`');
	}

	return env;
}

/**
 * Tells whether `env` is `Deno.env`, or an object like it whose variables are read through `get` and `toObject` methods: the runtime's
 * own object, or an object with such methods (not inherited from a polluted `Object.prototype`) and no string property, so that variables
 * named `get` or `toObject` do not make a real environment look like one.
 * @param {object} env - The environment
 * @returns {boolean} `true` for `Deno.env`
 */
function isDenoEnv(env: object): boolean {
	const deno = (globalThis as unknown as { Deno?: { env?: unknown } }).Deno;
	if (typeof deno === 'object' && deno !== null && env === deno.env) return true;

	// `in` first: an environment without the methods has none of its properties read here.
	if (!('get' in env && 'toObject' in env)) return false;
	const methods = env as { get?: unknown; toObject?: unknown };
	if (typeof readOption(methods, 'get') !== 'function' || typeof readOption(methods, 'toObject') !== 'function') return false;
	for (const key of Object.keys(env)) if (typeof (env as Record<string, unknown>)[key] === 'string') return false;
	return true;
}

/**
 * Throws unless `env` is an object holding the variables as properties: a `Map` or Deno's `Deno.env` (whose variables are read through
 * methods) would make every variable look unset.
 * @param {unknown} env - The environment
 * @returns {void}
 * @throws {TypeError} when `env` is not such an object
 */
function assertEnv(env: unknown): asserts env is object {
	if (typeof env !== 'object' || env === null) throw new TypeError(`parseEnv: \`env\` must be an object, got ${describe(env)}`);
	if (isMap(env)) throw new TypeError('parseEnv: `env` must be an object of variables, got Map (pass `Object.fromEntries(map)`)');

	if (isDenoEnv(env)) {
		throw new TypeError('parseEnv: `env` must be an object of variables, got an object with `get` and `toObject` methods (pass `Deno.env.toObject()`)');
	}
}

/**
 * Parses environment variables with an object schema and returns the typed result, or throws ONE {@link ValidationError} listing every
 * missing or invalid variable, one per line, so that a misconfigured deployment fails at startup with the whole list instead of one
 * variable per restart (or a crash much later, on first use):
 *
 * ```text
 * Invalid environment variables:
 *   DATABASE_URL: Missing required variable
 *   PORT: Expected an integer or an integer string (got string)
 * ```
 *
 * No part of a value can reach the error (its message, `issues`, stack or anything else), since everything in it comes from fixed
 * texts: the variable name; array indexes, but no object key (a JSON object's keys come from the value); and messages from a fixed
 * list: this module's own (its `(got …)` part kept only when it names a type), range, length, pattern and allowed-values messages
 * without their bounds (`Expected an integer in the allowed range`: a number in them may come from the value), and `Invalid value`
 * for anything else, custom `withError` and `check` messages and those of other libraries (zod, valibot…) included, since they may
 * quote the value. A schema that throws is reported as `Invalid value (the schema threw TypeError)`, without its message, and the
 * other variables are still checked.
 *
 * Each key of the schema names a variable, parsed with its schema ({@link asInteger}, {@link asBoolean}, {@link asList},
 * {@link asJson}, {@link withDefault}, {@link optional}, guards such as {@link isUrl}...). Only those variables are read, each once, as
 * own properties (a polluted `Object.prototype` cannot supply one). The output has a `null` prototype, so an optional variable left
 * unset cannot be read from a polluted `Object.prototype` either; it holds only the schema's keys. Blank values count as unset by
 * default (see {@link ParseEnvOptions.blankAsMissing}), and a `prefix` maps `PORT` to `APP_PORT` or `VITE_PORT`.
 *
 * `env` defaults to `process.env` when the runtime has one. Elsewhere pass an object of variables: `import.meta.env` (Vite),
 * `Deno.env.toObject()` (not `Deno.env` itself), the `env` bindings of a Cloudflare Worker, `Object.fromEntries(map)` for a `Map`.
 * @template S - The object schema
 * @param {S} schema - A plain object of schemas, one per variable
 * @param {object} [env=process.env] - The variables (values that are not strings, such as Vite's booleans, are parsed as they are)
 * @param {ParseEnvOptions} [options] - `prefix` (`''`), `blankAsMissing` (`true`) and `strict` (`false`)
 * @returns {SchemaOutput<S>} The parsed variables, keyed like the schema, in a `null`-prototype object
 * @throws {ValidationError} when a variable is missing or invalid (or, with `strict`, unknown), with every problem in its message and `issues`
 * @throws {TypeError} when `schema` is not a plain object of schemas, `env` is not an object of variables (a `Map`, `Deno.env`),
 * `options` is not an object, `prefix` is not a string, or `blankAsMissing` or `strict` is not a boolean
 * @throws {RangeError} when `strict` is set without a `prefix`
 * @throws {Error} when `env` is omitted and the runtime has no `process.env`
 * @example
 * import { isOneOf } from 'tinkit/guards';
 * const schema = {
 *   DATABASE_URL: isUrl,
 *   PORT: withDefault(asInteger, 3000),
 *   LOG_LEVEL: withDefault(isOneOf(['debug', 'info', 'error']), 'info'),
 *   ORIGINS: withDefault(asList(isUrl), function () { return []; })
 * };
 * parseEnv(schema, { DATABASE_URL: 'https://db.example.com', PORT: '8080', LOG_LEVEL: '', HOME: '/root' }); // => { DATABASE_URL: 'https://db.example.com', PORT: 8080, LOG_LEVEL: 'info', ORIGINS: [] }
 * @example
 * import { isString, isIntegerInRange } from 'tinkit/guards';
 * try {
 *   parseEnv({ DATABASE_URL: isUrl, PORT: chain(asInteger, isIntegerInRange(1, 65535)), API_KEY: isString }, { PORT: '70000', API_KEY: ' ' });
 * } catch (error) {
 *   (error as Error).message; // => 'Invalid environment variables:\n  DATABASE_URL: Missing required variable\n  PORT: Expected an integer in the allowed range\n  API_KEY: Missing required variable (set but blank)'
 * }
 * @example
 * const env = { VITE_API_URL: 'https://api.example.com', VITE_DEBUG: 'yes', VITE_DEBGU: 'no' };
 * parseEnv({ API_URL: isUrl, DEBUG: withDefault(asBoolean, false) }, env, { prefix: 'VITE_' }); // => { API_URL: 'https://api.example.com', DEBUG: true }
 * parseEnv({ API_URL: isUrl, DEBUG: withDefault(asBoolean, false) }, env, { prefix: 'VITE_', strict: true }); // throws ValidationError // VITE_DEBGU: Unknown variable
 * @example
 * // doctest: skip
 * export const env = parseEnv({ DATABASE_URL: isUrl, PORT: withDefault(asInteger, 3000) }); // reads process.env
 */
export function parseEnv<S extends ObjectSchema>(schema: S, env?: object, options: ParseEnvOptions = {}): SchemaOutput<S> {
	assertObjectSchema('parseEnv', 'schema', schema);
	if (typeof options !== 'object' || options === null) throw new TypeError(`parseEnv: \`options\` must be an object, got ${describe(options)}`);

	const prefix = ownOption(options, 'prefix') ?? '';
	const blankAsMissing = ownOption(options, 'blankAsMissing') ?? true;
	const strict = ownOption(options, 'strict') ?? false;

	if (typeof prefix !== 'string') throw new TypeError(`parseEnv: \`prefix\` must be a string, got ${describe(prefix)}`);
	if (typeof blankAsMissing !== 'boolean') throw new TypeError(`parseEnv: \`blankAsMissing\` must be a boolean, got ${describe(blankAsMissing)}`);
	if (typeof strict !== 'boolean') throw new TypeError(`parseEnv: \`strict\` must be a boolean, got ${describe(strict)}`);
	if (strict && prefix === '') throw new RangeError('parseEnv: `prefix` must be a non-empty string with `strict`, got empty string');

	const keys = Object.keys(schema);
	// Compiled before any variable is read, so that a mistake in the schema throws whatever the environment holds.
	const children = keys.map(function (key: string): Node {
		return compile('parseEnv', `schema.${key}`, schema[key], [schema]);
	});
	const source = env === undefined ? processEnv() : env;

	assertEnv(source);

	const output: Record<string, unknown> = Object.create(null);
	const issues: SchemaIssue[] = [];
	const reported = new Set<string>();

	/**
	 * Records a problem, once.
	 * @param {PropertyKey[]} path - Its path, the variable name first
	 * @param {string} message - Its message
	 * @returns {void}
	 */
	function record(path: PropertyKey[], message: string): void {
		const line = `${path.map(String).join('.')}: ${message}`;

		if (reported.has(line)) return;
		reported.add(line);
		issues.push({ message, path });
	}

	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		const child = children[index];
		const name = prefix + key;
		const raw = hasOwn.call(source, name) ? (source as Record<string, unknown>)[name] : undefined;
		const value = blankAsMissing && isBlank(raw) ? undefined : raw;
		const found: SchemaIssue[] = [];
		let present: boolean;
		let result: unknown;

		try {
			present = value !== undefined && !flags(child, value);
			result = execute(child.fast, child.run, value, found);
		} catch (error) {
			record([name], `Invalid value (the schema threw ${thrownName(error)})`);
			continue;
		}
		if (found.length === 0) {
			if (result !== undefined || present) assign(output, key, result);
		} else if (!present && !handlesMissing(child)) {
			// A missing variable fails as such, unless its schema handles `undefined` (then a default can genuinely fail a later check).
			record([name], raw === undefined ? 'Missing required variable' : 'Missing required variable (set but blank)');
		} else {
			for (const issue of found) record(envPath(name, issue.path), envMessage(issue.message));
		}
	}
	if (strict) {
		const declared = new Set(
			keys.map(function (key: string): string {
				return prefix + key;
			})
		);

		for (const name of Object.keys(source).sort()) {
			if (name.startsWith(prefix) && !declared.has(name)) record([name], 'Unknown variable');
		}
	}
	if (issues.length > 0) {
		const error = new ValidationError(issues);

		error.message = [
			'Invalid environment variables:',
			...issues.map(function (issue: SchemaIssue): string {
				return `  ${issue.path.map(String).join('.')}: ${issue.message}`;
			})
		].join('\n');
		throw error;
	}

	return output as SchemaOutput<S>;
}
