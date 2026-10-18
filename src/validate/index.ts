import { daysInMonth } from '../date/index.js';

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
 * others become punycode (`xn--`) labels, not ASCII ones (IDNA case folding maps `ẞ` to `ss`).
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
 * internationalized names (`münchen.de`, `例え.jp`; each non-ASCII label must stay a punycode label, so `https://ẞa.com`, which IDNA case
 * folding turns into `ssa.com`, is rejected). So the following are also rejected: invisible characters anywhere (format characters
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
