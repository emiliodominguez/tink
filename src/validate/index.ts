import { daysInMonth } from '../date/index.js';
import {
	explain,
	isDate,
	isPlainObject,
	ValidationError,
	type Guard,
	type JsonValue,
	type SchemaIssue,
	type StandardSchemaResult,
	type StandardSchemaV1
} from '../guards/index.js';
import { describe } from '../utils/assert.js';
import type { AnyFunction } from '../utils/index.js';

/**
 * Options accepted by {@link isUrl}.
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
 * Options accepted by {@link isHexColor}.
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

/** The official semver.org 2.0.0 regular expression (numbered groups: major, minor, patch, pre-release, build). */
const SEMVER_PATTERN = new RegExp(
	String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`
);

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

/** A lowercase ASCII slug, as produced by `toSlug` from the strings module. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
	const written = host.split('.');
	const parsed = hostname.split('.');
	return (
		written.length === parsed.length &&
		written.every(function (label: string, index: number): boolean {
			return NON_ASCII_PATTERN.test(label) ? parsed[index].startsWith('xn--') : parsed[index] === label.toLowerCase();
		})
	);
}

/**
 * Checks whether a value is an absolute URL with an allowed scheme, parsing it with the WHATWG `URL` parser (`globalThis.URL`).
 *
 * On top of what the parser accepts, the string must not contain white space or control characters (which the parser
 * silently strips), "special" schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`) must be followed by `//`
 * (`http:example.com` is rejected), and `http(s)` URLs must have a non-empty host.
 *
 * The host is also checked against the text, so that for an accepted URL the host a client connects to is the one a reader (or a
 * string-based allow/deny list) sees: `new URL(value).hostname` is the written host, lower-cased, or its punycode form for
 * internationalized names (`münchen.de`, `例え.jp`; each non-ASCII label must stay a punycode label, so `https://ẞa.com`, which older IDNA case
 * folding turns into `ssa.com`, is rejected there). So the following are also rejected: invisible characters anywhere (format characters
 * such as U+00AD soft hyphen, U+200B zero-width space or bidi controls, and other default-ignorable code points such as U+034F or
 * variation selectors), a backslash in the authority (`http://evil.com\@good.com`, which parsers disagree on), and host names with
 * a `%` (percent-decoded by the parser), an empty label (`https://a..b`, `https://.`; one trailing dot is allowed), characters that
 * NFKC normalization changes (fullwidth `ｅ`, circled `ⓔ`, ...), ideographic full stops (`。`), or a numeric form other than
 * dotted-decimal IPv4 (`http://0x7f.1`, `http://2130706433`, `http://127.1` all mean `127.0.0.1`).
 * Credentials are allowed: in `https://good.com@evil.com` the host is `evil.com`, as for every parser.
 * @param {unknown} value - The value to check
 * @param {IsUrlOptions} [options={}] - `protocols` (default `['http', 'https']`): allowed schemes;
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
export function isUrl(value: unknown, options: IsUrlOptions = {}): value is string {
	const { protocols, requireTld = false } = options;
	if (protocols !== undefined && !Array.isArray(protocols)) throw new TypeError(`isUrl: \`protocols\` must be an array of strings, got ${typeof protocols}`);
	if (typeof value !== 'string' || URL_FORBIDDEN_CHARACTER.test(value)) return false;

	const UrlParser = getUrlConstructor();
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
	if ((scheme === 'http' || scheme === 'https') && url.hostname === '') return false;
	if (international && !isEncodingOf(host, url.hostname)) return false;

	return !requireTld || hasTld(url.hostname);
}

/**
 * Checks whether a value is a UUID as defined by RFC 9562 (which obsoletes RFC 4122), in the hyphenated 8-4-4-4-12 form,
 * case-insensitively. Versions 1–8 must carry the RFC variant (`10xx`, i.e. the first digit of the 4th group is `8`, `9`, `a` or `b`);
 * the special nil (`00000000-…`) and max (`ffffffff-…`) UUIDs are accepted too. Braces and `urn:uuid:` prefixes are not.
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
		throw new RangeError(`isUuid: \`version\` must be 1-8, 'nil' or 'max', got ${String(version)}`);
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
	// No `= {}` default: allocating an options object would cost about as much as the test itself.
	return typeof value === 'string' && (options?.alpha === false ? OPAQUE_HEX_COLOR_PATTERN : HEX_COLOR_PATTERN).test(value);
}

/**
 * Matches a value against the official semver regular expression.
 * @param {unknown} value - The value
 * @returns {RegExpExecArray | null} The match, or `null` when `value` is not a string holding a semantic version
 */
function matchSemver(value: unknown): RegExpExecArray | null {
	return typeof value === 'string' ? SEMVER_PATTERN.exec(value) : null;
}

/**
 * Checks whether a value is a semantic version, using the official regular expression from semver.org (SemVer 2.0.0):
 * `MAJOR.MINOR.PATCH`, optional `-pre.release` identifiers and optional `+build.metadata`. No leading `v`, no leading zeros in numeric parts.
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
	return typeof value === 'string' && SEMVER_PATTERN.test(value);
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
	if (match === null) {
		// At most 50 characters of the value are quoted, so that an attacker-sized input does not end up whole in logs.
		const quoted = typeof value === 'string' ? JSON.stringify(value.length > 50 ? `${value.slice(0, 50)}…` : value) : typeof value;
		throw new TypeError(`compareSemver: ${quoted} is not a valid semantic version`);
	}
	return match;
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
	if (typeof value !== 'string' || !CARD_PATTERN.test(value)) return false;
	const digits = value.replace(/[ -]/g, '');
	return digits.length >= 12 && digits.length <= 19 && /[1-9]/.test(digits) && luhnCheck(digits);
}

/**
 * Checks whether a value is a string that `JSON.parse` accepts (any JSON text, including `'1'`, `'"text"'` and `'null'`).
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
	const { urlSafe = false, padding = 'optional' } = options;
	if (padding !== 'optional' && padding !== 'required' && padding !== 'forbidden') {
		throw new RangeError(`isBase64: \`padding\` must be 'optional', 'required' or 'forbidden', got ${String(padding)}`);
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
 * Options accepted by {@link parseJson}.
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
		for (const key in node) pushObject(stack, node[key]);
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

	const proto = options?.proto ?? 'error';

	if (proto !== 'error' && proto !== 'remove' && proto !== 'ignore') {
		throw new RangeError(`parseJson: \`proto\` must be 'error', 'remove' or 'ignore', got ${String(proto)}`);
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

/** What a {@link Fast} parse returns for an invalid value. */
const FAIL = Symbol('tink.fail');

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
}

/** A parser created by this module. */
interface CompiledParser<T> extends StandardSchemaV1<unknown, T> {
	/**
	 * The compiled schema, so that nesting a parser skips the Standard Schema adapter. A plain string key (like `'~standard'`), not a
	 * symbol: a computed key would keep the exported parser constants, and everything they reference, in every bundle of the module.
	 */
	readonly '~tink': Node;
}

/** Guards, foreign Standard Schema validators and object schemas, compiled on first use. */
const compiled = new WeakMap<object, Node>();

/** Whether `new Function` works here: unknown until the first object schema is compiled, `false` under a CSP without `'unsafe-eval'`. */
let jit: boolean | undefined;

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

	const own = (schema as Partial<CompiledParser<unknown>>)['~tink'];

	if (own !== undefined) return own;

	let node = compiled.get(schema);

	if (node !== undefined) return node;
	if (typeof schema === 'function') node = guardNode(schema as Guard<unknown>);
	else if (isStandardSchema(schema)) node = standardNode(schema);
	else if (isPlainObject(schema)) node = objectNode(caller, name, schema as ObjectSchema, ancestors);
	else throw invalidSchema(caller, name, schema);
	compiled.set(schema, node);

	return node;
}

/**
 * Whether `value` looks like a Standard Schema validator.
 * @param {object} value - A non-null object
 * @returns {boolean} `true` when `value['~standard'].validate` is a function
 */
function isStandardSchema(value: object): value is StandardSchemaLike {
	const props = (value as Partial<StandardSchemaLike>)['~standard'];

	return typeof props === 'object' && props !== null && typeof props.validate === 'function';
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

			const found = explain(guard, value);

			// A guard that rejected the value but accepts it when explained (it is not deterministic) still fails.
			if (found.length === 0) issues.push({ message: `Invalid value (got ${describe(value)})`, path: path.slice() });
			for (const issue of found) issues.push({ message: issue.message, path: [...path, ...issue.path] });

			return value;
		},
		guard
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
	function check(value: unknown): StandardSchemaResult<unknown> {
		const result = props.validate(value) as StandardSchemaResult<unknown> | PromiseLike<unknown>;

		if (typeof (result as PromiseLike<unknown>).then === 'function') {
			throw new TypeError('parse: Standard Schema validators must be synchronous, got one returning a promise');
		}

		return result as StandardSchemaResult<unknown>;
	}

	return {
		fast: function fastStandard(value: unknown): unknown {
			const result = check(value);

			return result.issues === undefined ? result.value : FAIL;
		},
		run: function runStandard(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			const result = check(value);
			const found = result.issues;

			if (found === undefined) return result.value;
			if (found.length === 0) issues.push({ message: `Invalid value (got ${describe(value)})`, path: path.slice() });
			for (const issue of found as ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }>) {
				const segments = (issue.path ?? []).map(function (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
					return typeof segment === 'object' ? segment.key : segment;
				});

				issues.push({ message: issue.message, path: [...path, ...segments] });
			}

			return undefined;
		},
		guard: undefined
	};
}

/**
 * Sets `output[key]`, as an own property even for `__proto__` (a plain assignment would replace the prototype instead).
 * @param {Record<string, unknown>} output - The object being built
 * @param {string} key - The key
 * @param {unknown} value - The value
 * @returns {void}
 */
function assign(output: Record<string, unknown>, key: string, value: unknown): void {
	if (key === '__proto__') Object.defineProperty(output, key, { value, enumerable: true, writable: true, configurable: true });
	else output[key] = value;
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

	return { fast: generateObject(keys, children, loop) ?? loop, run: objectRun(keys, children), guard: undefined };
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
			const present = hasOwn.call(value, key);
			let result = present ? (value as Record<string, unknown>)[key] : undefined;

			if (child.guard !== undefined) {
				if (!child.guard(result)) return FAIL;
			} else if ((result = child.fast(result)) === FAIL) {
				return FAIL;
			}
			if (result !== undefined || present) assign(output, key, result);
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
	if (jit === false) return undefined;

	const literals = keys.map(function (key: string): string {
		return JSON.stringify(key);
	});
	const lines = children.map(function (child: Node, index: number): string {
		const key = literals[index];
		const read =
			child.guard === undefined
				? `result = c${index}(value[${key}]); if (result === FAIL) return FAIL;`
				: `result = value[${key}]; if (!c${index}(result)) return FAIL;`;

		return `${read} if (result !== undefined || hasOwn.call(value, ${key})) output[${key}] = result;`;
	});
	const source = [
		...children.map(function (_: Node, index: number): string {
			return `const c${index} = children[${index}];`;
		}),
		'return function fastObject(value) {',
		"if (typeof value !== 'object' || value === null || isArray(value)) return FAIL;",
		'const proto = getPrototypeOf(value);',
		`if ((proto !== OP && proto !== null)${literals
			.map(function (key: string): string {
				return ` || ${key} in OP`;
			})
			.join('')}) return loop(value);`,
		'const output = {};',
		'let result;',
		...lines,
		'return output;',
		'};'
	].join('\n');

	try {
		const factory = new Function('FAIL', 'OP', 'isArray', 'getPrototypeOf', 'hasOwn', 'loop', 'children', source) as (...args: unknown[]) => Fast;

		jit = true;

		return factory(
			FAIL,
			Object.prototype,
			Array.isArray,
			Object.getPrototypeOf,
			hasOwn,
			loop,
			children.map(function (child: Node): AnyFunction {
				return child.guard ?? child.fast;
			})
		);
	} catch {
		// Code generation from strings is disallowed (a Content Security Policy without 'unsafe-eval', Cloudflare Workers…).
		jit = false;

		return undefined;
	}
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
			const present = hasOwn.call(value, key);
			const before = issues.length;

			path.push(key);

			const result = rerun(children[index], present ? (value as Record<string, unknown>)[key] : undefined, path, issues);

			path.pop();
			if (issues.length > before) {
				if (!present) {
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
	const output = fast(value);

	return output === FAIL ? run(value, [], issues) : output;
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
	return {
		'~tink': node,
		'~standard': {
			version: 1,
			vendor: 'tink',
			validate: function validate(value: unknown): StandardSchemaResult<T> {
				return validateWith(node.fast, node.run, value) as StandardSchemaResult<T>;
			}
		}
	} as CompiledParser<T>;
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

	return (schema as Partial<CompiledParser<unknown>>)['~tink'] === node ? (schema as Parser<SchemaOutput<S>>) : toCompiledParser(node);
}

/**
 * Creates a parser that returns `fallback` when the value is `undefined` (missing), and parses it with `schema` otherwise (`.default()`
 * in zod). `null` is not missing: it goes to `schema`. When `fallback` is a function it is called for every missing value, so mutable
 * defaults are never shared between results (wrap a function default in another function: `withDefault(isFunction, () => noop)`);
 * keep it free of side effects, since an invalid input is parsed twice. The fallback itself is not validated.
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
			return value === undefined ? fill() : node.fast(value);
		},
		// Only reached when the fast parse failed, so never for `undefined`.
		run: node.run,
		guard: undefined
	});
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
	const node = compile('optional', 'schema', schema, []);

	return toCompiledParser({
		fast: function fastOptional(value: unknown): unknown {
			return value === undefined ? undefined : node.fast(value);
		},
		// Only reached when the fast parse failed, so never for `undefined`.
		run: node.run,
		guard: undefined
	});
}

/**
 * Creates a parser that parses the value with `schema`, then maps the output with `fn` (`.transform()` in zod). `fn` only runs when
 * `schema` succeeded; keep it free of side effects, since an invalid input is parsed twice. To validate the transformed value,
 * {@link chain} a schema after it.
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
		guard: undefined
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
		guard: undefined
	});
}

/**
 * Creates a parser for arrays whose elements are parsed with `schema`, returning a new array of the outputs (`z.array()`). Every
 * index from `0` to `length - 1` is parsed, so holes are parsed as `undefined`. For elements that only need checking, the guards
 * module's `isArrayOf` works too (and returns the array itself).
 * @template S - The element schema
 * @param {S} schema - The schema of each element
 * @returns {Parser<SchemaOutput<S>[]>} The parser
 * @throws {TypeError} when `schema` is not a {@link Schema}
 * @example
 * parse(arrayOf(asInteger), ['1', '2', 3]); // => [1, 2, 3]
 * safeParse(arrayOf(asInteger), ['1', 'x'])[0]?.issues; // => [{ message: 'Expected an integer or an integer string (got string)', path: [1] }]
 */
export function arrayOf<S extends Schema>(schema: S): Parser<SchemaOutput<S>[]> {
	const node = compile('arrayOf', 'schema', schema, []);
	const { guard, fast } = node;

	return toCompiledParser({
		fast: function fastArray(value: unknown): unknown {
			if (!Array.isArray(value)) return FAIL;

			const output: unknown[] = [];

			for (let index = 0; index < value.length; index++) {
				let element = value[index];

				if (guard !== undefined) {
					if (!guard(element)) return FAIL;
				} else if ((element = fast(element)) === FAIL) {
					return FAIL;
				}
				output.push(element);
			}

			return output;
		},
		run: function runArray(value: unknown, path: PropertyKey[], issues: SchemaIssue[]): unknown {
			if (!Array.isArray(value)) {
				issues.push({ message: `Expected an array (got ${describe(value)})`, path: path.slice() });

				return undefined;
			}

			const output: unknown[] = [];

			for (let index = 0; index < value.length; index++) {
				path.push(index);
				output.push(rerun(node, value[index], path, issues));
				path.pop();
			}

			return output;
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
 * Parses finite numbers, and numeric strings (surrounding whitespace ignored) to numbers: `z.coerce.number()` without its traps.
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
	'~tink': { fast: fastNumber, run: runNumber, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<number> {
			return validateWith(fastNumber, runNumber, value) as StandardSchemaResult<number>;
		}
	}
} as CompiledParser<number>;

/**
 * Parses safe integers, and strings of decimal digits with an optional sign (surrounding whitespace ignored), to numbers. Fractions
 * (`'1.5'`, `1.5`), exponents (`'1e3'`), the empty string and integers beyond `Number.MAX_SAFE_INTEGER` (which would silently lose
 * precision) are rejected.
 * @example
 * parse(asInteger, '8080'); // => 8080
 * parse(asInteger, '-3'); // => -3
 * parse(asInteger, '1.5'); // throws ValidationError
 * parse(asInteger, '9007199254740993'); // throws ValidationError // would round to 9007199254740992
 */
export const asInteger: Parser<number> = {
	'~tink': { fast: fastInteger, run: runInteger, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<number> {
			return validateWith(fastInteger, runInteger, value) as StandardSchemaResult<number>;
		}
	}
} as CompiledParser<number>;

/**
 * Parses booleans, the numbers `1` and `0`, and the strings `'true'`/`'false'`, `'yes'`/`'no'`, `'on'`/`'off'` and `'1'`/`'0'` (case and
 * surrounding whitespace ignored) to booleans: environment variables, query strings and checkboxes (an HTML checkbox sends `'on'`).
 * Anything else, the empty string included, is rejected: unlike `z.coerce.boolean()`, `'false'` is `false`.
 * @example
 * parse(asBoolean, 'false'); // => false // z.coerce.boolean() gives true
 * parse(asBoolean, ' YES '); // => true
 * parse(asBoolean, 'on'); // => true
 * parse(asBoolean, 0); // => false
 * parse(asBoolean, 'maybe'); // throws ValidationError
 */
export const asBoolean: Parser<boolean> = {
	'~tink': { fast: fastBoolean, run: runBoolean, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<boolean> {
			return validateWith(fastBoolean, runBoolean, value) as StandardSchemaResult<boolean>;
		}
	}
} as CompiledParser<boolean>;

/**
 * Parses valid dates (returned as they are), timestamps in milliseconds, and ISO 8601 strings: RFC 3339 date-times with an offset
 * (see {@link isIsoDateTimeString}) and `YYYY-MM-DD` dates, read as UTC midnight like `new Date('2024-01-05')`. Invalid dates,
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
	'~tink': { fast: fastDate, run: runDate, guard: undefined },
	'~standard': {
		version: 1,
		vendor: 'tink',
		validate: function validate(value: unknown): StandardSchemaResult<Date> {
			return validateWith(fastDate, runDate, value) as StandardSchemaResult<Date>;
		}
	}
} as CompiledParser<Date>;
