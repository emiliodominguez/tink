import { clamp, lerp, modulo, round } from '../math/index.js';
import { assertNumber, describe } from '../utils/assert.js';

/**
 * An sRGB colour with 8-bit channels (`0`–`255`). Values produced by this module are always integers in that range.
 */
export interface Rgb {
	/** Red channel, `0`–`255`. */
	r: number;
	/** Green channel, `0`–`255`. */
	g: number;
	/** Blue channel, `0`–`255`. */
	b: number;
}

/**
 * An sRGB colour with 8-bit channels and an alpha (opacity) channel.
 */
export interface Rgba extends Rgb {
	/** Alpha channel, `0` (transparent) – `1` (opaque). */
	a: number;
}

/**
 * A colour in the HSL model.
 */
export interface Hsl {
	/** Hue in degrees, `[0, 360)`. */
	h: number;
	/** Saturation in percent, `0`–`100`. */
	s: number;
	/** Lightness in percent, `0`–`100`. */
	l: number;
}

/**
 * Any colour accepted by the higher-level helpers of this module: an {@link Rgb} / {@link Rgba} object,
 * or a CSS colour string understood by {@link parseColor}: hex (`'#rgb'`, `'#rgba'`, `'#rrggbb'`, `'#rrggbbaa'`, with or without `#`),
 * `rgb()` / `rgba()`, `hsl()` / `hsla()` or `'transparent'`.
 */
export type ColorInput = Rgb | Rgba | string;

/**
 * Options accepted by {@link toHex}.
 */
export interface ToHexOptions {
	/**
	 * `true` always appends the alpha byte (`#rrggbbaa`), `false` never does (`#rrggbb`).
	 * When omitted, the alpha byte is appended only for translucent colours (`a < 1`).
	 */
	alpha?: boolean;
}

/**
 * Options accepted by {@link getReadableTextColor}.
 * @template L - Type of the light option
 * @template D - Type of the dark option
 */
export interface ReadableTextColorOptions<L extends ColorInput, D extends ColorInput> {
	/**
	 * The light text colour candidate.
	 * @default '#ffffff'
	 */
	light?: L;
	/**
	 * The dark text colour candidate.
	 * @default '#000000'
	 */
	dark?: D;
}

/**
 * WCAG 2.x conformance level for {@link meetsContrast}.
 */
export type ContrastLevel = 'AA' | 'AAA';

/**
 * Options accepted by {@link meetsContrast}.
 */
export interface MeetsContrastOptions {
	/**
	 * The WCAG conformance level to check.
	 * @default 'AA'
	 */
	level?: ContrastLevel;
	/**
	 * Whether the text is "large" (at least 18pt, or 14pt bold), which lowers the required ratio.
	 * @default false
	 */
	largeText?: boolean;
}

/**
 * One argument of a CSS colour function: a CSS `<number>` and an optional `%` or angle unit (both captured).
 * Built into the two function patterns below, so a colour function is matched by a single regular expression.
 */
const COMPONENT = String.raw`([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?`;

/** CSS white space (CSS Syntax 3): space, tab and line feed, carriage return or form feed — not JavaScript's `\s` (no-break space, U+2028...). */
const SPACE = String.raw`[ \t\n\r\f]`;

/** Legacy syntax `name(a, b, c[, d])`: the function name, then a number and a unit per argument. */
const LEGACY_FUNCTION_PATTERN = new RegExp(
	String.raw`^(rgba?|hsla?)\(${SPACE}*${COMPONENT}${SPACE}*,${SPACE}*${COMPONENT}${SPACE}*,${SPACE}*${COMPONENT}(?:${SPACE}*,${SPACE}*${COMPONENT})?${SPACE}*\)$`,
	'i'
);

/** Modern syntax `name(a b c[ / d])`, where any argument may be `none`: the function name, then a number, a unit and `none` per argument. */
const MODERN_COMPONENT = `(?:${COMPONENT}|(none))`;
const MODERN_FUNCTION_PATTERN = new RegExp(
	String.raw`^(rgba?|hsla?)\(${SPACE}*${MODERN_COMPONENT}${SPACE}+${MODERN_COMPONENT}${SPACE}+${MODERN_COMPONENT}(?:${SPACE}*\/${SPACE}*${MODERN_COMPONENT})?${SPACE}*\)$`,
	'i'
);

/** How many of each CSS angle unit make a full turn (`''` is a unitless hue, which means degrees). */
const UNITS_PER_TURN: Readonly<Record<string, number>> = { '': 360, deg: 360, grad: 400, rad: 2 * Math.PI, turn: 1 };

/**
 * Reads a numeric colour channel, rejecting non-numbers and `NaN`.
 * @param {string} name - Function name for the error message
 * @param {string} channel - Channel name for the error message
 * @param {unknown} value - The channel value
 * @returns {number} The channel value
 * @throws {TypeError} when the value is not a number
 * @throws {RangeError} when the value is `NaN`
 * @example
 * readChannel('toRgba', 'input.r', 12); // => 12
 */
function readChannel(name: string, channel: string, value: unknown): number {
	// Only call into the (throwing) assertion for invalid values: the check below is all the hot path pays.
	if (typeof value !== 'number' || Number.isNaN(value)) assertNumber(name, channel, value, false, 'a number other than NaN');
	return value as number;
}

/**
 * Clamps a channel to `[0, 255]` and rounds it to the nearest integer (never `-0`).
 * @param {number} value - The channel value (not `NaN`)
 * @returns {number} An integer in `[0, 255]`
 * @example
 * toByte(255.6); // => 255
 * toByte(-0); // => 0
 */
function toByte(value: number): number {
	// Inlined clamp (about twice as fast as `Math.round(clamp(value, 0, 255))` on this hot path).
	if (value >= 255) return 255;
	return value > 0 ? Math.round(value) : 0;
}

/** Cache of {@link linearChannel} results, indexed by channel value (filled on first use, at most 256 entries). */
const LINEAR_CHANNELS: number[] = [];

/**
 * Converts one 8-bit sRGB channel to linear light, as defined by WCAG 2.x.
 * @param {number} value - Integer channel in `[0, 255]`
 * @returns {number} Linear channel in `[0, 1]`
 * @example
 * linearChannel(255); // => 1
 */
function linearChannel(value: number): number {
	let linear = LINEAR_CHANNELS[value];
	if (linear === undefined) {
		const unit = value / 255;
		linear = unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
		LINEAR_CHANNELS[value] = linear;
	}
	return linear;
}

/**
 * Parses a CSS hex colour. Accepts the 3, 4, 6 and 8 digit forms (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), with or
 * without the leading `#`, in any letter case. Surrounding whitespace and other syntaxes are rejected.
 * @param {string} hex - The hex string
 * @returns {Rgba} The colour, with alpha `1` when the string has no alpha digits
 * @throws {TypeError} when `hex` is not a string or not a valid hex colour
 * @example
 * parseHex('#ff8000'); // => { r: 255, g: 128, b: 0, a: 1 }
 * parseHex('0F0'); // => { r: 0, g: 255, b: 0, a: 1 }
 * parseHex('#00000080'); // => { r: 0, g: 0, b: 0, a: 0.5019607843137255 }
 */
export function parseHex(hex: string): Rgba {
	if (typeof hex !== 'string') throw new TypeError(`parseHex: \`hex\` must be a string, got ${describe(hex)}`);
	const color = parseHexDigits(hex);
	if (color === undefined) throw new TypeError(`parseHex: \`hex\` must be a valid hex colour, got ${quote(hex)}`);
	return color;
}

/**
 * Parses a whole string of 3, 4, 6 or 8 hex digits, optionally preceded by `#`, with a hand-written scanner (several
 * times faster than a regular expression plus `parseInt`, and allocation-free until the result).
 * @param {string} text - The candidate hex colour
 * @returns {Rgba | undefined} The colour, or `undefined` when `text` is not a hex colour
 * @example
 * parseHexDigits('#f80'); // => { r: 255, g: 136, b: 0, a: 1 }
 * parseHexDigits('#ff80 '); // => undefined
 */
function parseHexDigits(text: string): Rgba | undefined {
	const start = text.charCodeAt(0) === 35 ? 1 : 0; // '#'
	const count = text.length - start;
	if (count !== 3 && count !== 4 && count !== 6 && count !== 8) return undefined;
	// The digits as one integer (at most 32 bits, exact in a double).
	let value = 0;
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// Codes below '0' give a negative digit. `| 32` lowercases `A`-`F`; only `A`-`F` and `a`-`f` land in `a`-`f` that way.
		const letter = (code | 32) - 87;
		const digit = code <= 57 ? code - 48 : letter >= 10 && letter <= 15 ? letter : -1;
		if (digit < 0) return undefined;
		value = value * 16 + digit;
	}
	// Bits per channel: one hex digit (expanded by `* 17`, so `f` → `ff`) in the short forms, two digits otherwise.
	const width = count <= 4 ? 4 : 8;
	const end = count * 4;
	return {
		r: hexChannel(value, end - width, width),
		g: hexChannel(value, end - 2 * width, width),
		b: hexChannel(value, end - 3 * width, width),
		a: end > 3 * width ? hexChannel(value, 0, width) / 255 : 1
	};
}

/**
 * Extracts one channel of a parsed hex colour and scales it to `[0, 255]`.
 * @param {number} value - The parsed hex digits
 * @param {number} shift - Bit offset of the channel
 * @param {number} width - Bits per channel: `4` (one digit) or `8` (two digits)
 * @returns {number} The channel, an integer in `[0, 255]`
 * @example
 * hexChannel(0xf80, 8, 4); // => 255
 */
function hexChannel(value: number, shift: number, width: number): number {
	const mask = (1 << width) - 1;
	return ((value >>> shift) & mask) * (255 / mask);
}

/**
 * Parses an `rgb()`, `rgba()`, `hsl()` or `hsla()` call (CSS Color 4 grammar, legacy and modern syntaxes) with a single
 * regular expression per syntax, then checks the units of the captured arguments.
 * @param {string} text - The trimmed CSS colour
 * @returns {Rgba | undefined} The colour, or `undefined` when `text` is not a valid colour function
 * @example
 * parseCssFunction('rgb(255 0 0 / 50%)'); // => { r: 255, g: 0, b: 0, a: 0.5 }
 */
function parseCssFunction(text: string): Rgba | undefined {
	const legacyMatch = LEGACY_FUNCTION_PATTERN.exec(text);
	const match = legacyMatch ?? MODERN_FUNCTION_PATTERN.exec(text);
	if (match === null) return undefined;
	const legacy = legacyMatch !== null;
	// Captures per argument after the function name: number and unit, plus `none` in the modern syntax.
	const stride = legacy ? 2 : 3;
	// A missing alpha is 1; `none` is 0 (and has no unit).
	const values = [0, 0, 0, 1];
	const units = ['', '', '', ''];
	for (let i = 0; i < 4; i++) {
		const number = match[2 + i * stride];
		if (number !== undefined) {
			values[i] = Number(number);
			if (!Number.isFinite(values[i])) return undefined;
			units[i] = (match[3 + i * stride] ?? '').toLowerCase();
		} else if (!legacy && match[4 + i * stride] !== undefined) {
			values[i] = 0;
		}
	}

	if (units[3] !== '' && units[3] !== '%') return undefined;
	// `+ 0` turns a clamped `-0` into `0`: colour channels never carry a signed zero.
	const a = clamp(units[3] === '%' ? values[3] / 100 : values[3], 0, 1) + 0;

	if (match[1][0] === 'r' || match[1][0] === 'R') {
		for (let i = 0; i < 3; i++) {
			// Channels are numbers or percentages; the legacy syntax does not allow mixing them.
			if ((units[i] !== '' && units[i] !== '%') || (legacy && units[i] !== units[0])) return undefined;
			values[i] = toByte(units[i] === '%' ? (values[i] * 255) / 100 : values[i]);
		}
		return { r: values[0], g: values[1], b: values[2], a };
	}

	// The hue is a number or an angle. Legacy syntax requires percentages for saturation and lightness; the modern one also accepts plain numbers.
	const perTurn = UNITS_PER_TURN[units[0]];
	if (perTurn === undefined || (units[1] !== '%' && (legacy || units[1] !== '')) || (units[2] !== '%' && (legacy || units[2] !== ''))) return undefined;
	// Reduce the hue in its own unit first, so huge values cannot overflow when converted to degrees.
	return hslValuesToRgb((modulo(values[0], perTurn) * 360) / perTurn, values[1], values[2], { r: 0, g: 0, b: 0, a });
}

/**
 * Quotes a rejected string for an error message, keeping at most its first 50 characters (so that an attacker-sized input does not
 * end up whole in logs).
 * @param {string} text - The string
 * @returns {string} Its JSON representation, truncated with `…`
 * @example
 * quote('#ggg'); // => '"#ggg"'
 */
function quote(text: string): string {
	return JSON.stringify(text.length > 50 ? `${text.slice(0, 50)}…` : text);
}

/**
 * Tells whether a UTF-16 code unit is CSS white space (see {@link SPACE}).
 * @param {number} code - The code unit
 * @returns {boolean} `true` for space, tab, line feed, form feed and carriage return
 * @example
 * isSpace(0x20); // => true
 * isSpace(0xa0); // => false
 */
function isSpace(code: number): boolean {
	return code === 32 || (code >= 9 && code <= 13 && code !== 11);
}

/**
 * Parses a CSS colour string for `caller`.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {string} input - The string to parse
 * @returns {Rgba} The colour
 * @throws {TypeError} when `input` is not a supported CSS colour
 * @example
 * parseCssColor('toRgba', 'input', 'transparent'); // => { r: 0, g: 0, b: 0, a: 0 }
 */
function parseCssColor(caller: string, name: string, input: string): Rgba {
	// Strip CSS white space only (`String.prototype.trim` also strips no-break spaces, line separators, BOMs...).
	let start = 0;
	let end = input.length;
	while (start < end && isSpace(input.charCodeAt(start))) start++;
	while (end > start && isSpace(input.charCodeAt(end - 1))) end--;
	const text = input.slice(start, end);
	const color = parseHexDigits(text) ?? (text.length === 11 && text.toLowerCase() === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : parseCssFunction(text));
	if (color === undefined) {
		throw new TypeError(`${caller}: \`${name}\` must be a CSS colour (hex, rgb(), hsl() or 'transparent'), got ${quote(input)}`);
	}
	return color;
}

/**
 * Parses a CSS colour string (CSS Color 4) into an {@link Rgba} colour. Supported forms:
 * - hex: everything {@link parseHex} accepts (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or without `#`), with the same result;
 * - `rgb()` / `rgba()` (aliases): legacy comma syntax `rgb(r, g, b[, a])` (channels all numbers or all percentages) and modern
 *   space syntax `rgb(r g b[ / a])` (numbers and percentages may be mixed, `none` means `0`);
 * - `hsl()` / `hsla()` (aliases): legacy `hsl(h, s%, l%[, a])` and modern `hsl(h s l[ / a])` (saturation and lightness as
 *   percentages or plain numbers, `none` means `0`); the hue is a number (degrees) or an angle in `deg`, `grad`, `rad` or `turn`;
 * - `transparent` (transparent black).
 *
 * Function names, units and keywords are case-insensitive, and white space around the string and the arguments is ignored. Only CSS
 * white space counts (space, tab, line feed, carriage return, form feed): like browsers, other Unicode spaces (U+00A0 no-break space,
 * U+2028 line separator, U+3000...) make the string invalid.
 *
 * Unlike CSS, hex colours may omit the `#` (as with {@link parseHex}), so bare words made of hex digits are colours: `'add'`, `'bad'`,
 * `'beef'` and `'facade'` parse, while CSS (and `isHexColor` from the validate module) require the `#`. Check with `isHexColor`, or
 * require the `#` yourself, when the string must be valid CSS (e.g. before writing it into a stylesheet).
 * The alpha is a number or a percentage. Out-of-range values are clamped as in CSS: channels to `[0, 255]`, saturation and
 * lightness to `[0%, 100%]`, alpha to `[0, 1]`; the hue wraps around. Channels are then rounded to integers (alpha is not rounded).
 * Numbers too large for a double (e.g. `1e999`) are rejected.
 * Named colours (`red`, `rebeccapurple`, ...), `currentcolor`, `calc()` and the other colour functions (`hwb()`, `lab()`,
 * `color()`, ...) are deliberately not supported, to keep the bundle small.
 * @param {string} input - The CSS colour string
 * @returns {Rgba} A new colour object with integer channels
 * @throws {TypeError} when `input` is not a string, or not one of the supported colour syntaxes
 * @example
 * parseColor('#ff8000'); // => { r: 255, g: 128, b: 0, a: 1 }
 * parseColor('rgba(255, 0, 0, 0.5)'); // => { r: 255, g: 0, b: 0, a: 0.5 }
 * parseColor('rgb(100% 50% 0% / 25%)'); // => { r: 255, g: 128, b: 0, a: 0.25 }
 * parseColor('hsl(120deg 100% 25%)'); // => { r: 0, g: 128, b: 0, a: 1 }
 * parseColor('hsla(0.5turn, 100%, 50%, .8)'); // => { r: 0, g: 255, b: 255, a: 0.8 }
 * parseColor('transparent'); // => { r: 0, g: 0, b: 0, a: 0 }
 * parseColor('rgb(300 -20 0)'); // => { r: 255, g: 0, b: 0, a: 1 }
 * parseColor('red'); // throws TypeError
 * parseColor('rgb(1\u00a02 3)'); // throws TypeError
 * parseColor('facade'); // => { r: 250, g: 202, b: 222, a: 1 }
 */
export function parseColor(input: string): Rgba {
	if (typeof input !== 'string') throw new TypeError(`parseColor: \`input\` must be a string, got ${describe(input)}`);
	return parseCssColor('parseColor', 'input', input);
}

/**
 * Normalizes any {@link ColorInput} to a fresh {@link Rgba} object: strings are parsed with {@link parseColor} (so every hex
 * string gives the same result as {@link parseHex}); for objects, `r`, `g`, `b` are clamped to `[0, 255]` and rounded to integers,
 * and `a` (default `1` when missing or `undefined`) is clamped to `[0, 1]`.
 * @param {ColorInput} input - A CSS colour string (see {@link parseColor}) or an `Rgb` / `Rgba` object
 * @returns {Rgba} A new normalized colour
 * @throws {TypeError} when `input` is neither a string nor an object, is an unsupported colour string, or has a non-numeric channel
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toRgba('#fff'); // => { r: 255, g: 255, b: 255, a: 1 }
 * toRgba({ r: 300, g: 12.4, b: -5 }); // => { r: 255, g: 12, b: 0, a: 1 }
 * toRgba({ r: 0, g: 0, b: 0, a: 0.5 }); // => { r: 0, g: 0, b: 0, a: 0.5 }
 * toRgba('hsl(0 100% 50% / 0.5)'); // => { r: 255, g: 0, b: 0, a: 0.5 }
 */
export function toRgba(input: ColorInput): Rgba {
	if (typeof input === 'string') return parseCssColor('toRgba', 'input', input);
	if (typeof input !== 'object' || input === null) throw new TypeError(`toRgba: \`input\` must be a colour string or an { r, g, b } object, got ${describe(input)}`);
	const rawAlpha = (input as Partial<Rgba>).a;
	const alpha = rawAlpha === undefined ? 1 : readChannel('toRgba', 'input.a', rawAlpha);
	return {
		r: toByte(readChannel('toRgba', 'input.r', input.r)),
		g: toByte(readChannel('toRgba', 'input.g', input.g)),
		b: toByte(readChannel('toRgba', 'input.b', input.b)),
		a: clamp(alpha, 0, 1) + 0 // no signed zero
	};
}

/**
 * Formats a colour as a lowercase CSS hex string. Channels are clamped and rounded (see {@link toRgba}).
 * @param {ColorInput} color - The colour
 * @param {ToHexOptions} [options={}] - `alpha`: `true` to always emit `#rrggbbaa`, `false` to always emit `#rrggbb`;
 * by default the alpha byte is emitted only when the colour is translucent
 * @returns {string} `'#rrggbb'` or `'#rrggbbaa'`
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toHex({ r: 255, g: 128, b: 0 }); // => '#ff8000'
 * toHex({ r: 0, g: 0, b: 0, a: 0.5 }); // => '#00000080'
 * toHex('#ABC', { alpha: true }); // => '#aabbccff'
 * toHex({ r: 0, g: 0, b: 0, a: 0.5 }, { alpha: false }); // => '#000000'
 */
export function toHex(color: ColorInput, options: ToHexOptions = {}): string {
	const { r, g, b, a } = toRgba(color);
	const alphaByte =
		(options.alpha ?? a < 1)
			? Math.round(a * 255)
					.toString(16)
					.padStart(2, '0')
			: '';
	return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}${alphaByte}`;
}

/**
 * Formats an alpha value as the ` / a` suffix of a modern CSS colour function, rounded to 3 decimals (enough to keep every
 * 8-bit alpha byte distinct). Returns `''` for (rounded) opaque colours.
 * @param {number} alpha - Alpha in `[0, 1]`
 * @returns {string} `' / a'` or `''`
 * @example
 * cssAlpha(0.5); // => ' / 0.5'
 */
function cssAlpha(alpha: number): string {
	// Exactly the alphas that round (decimally) to `1`, without calling `round` for opaque colours.
	return alpha < 0.9995 ? ` / ${round(alpha, 3)}` : '';
}

/**
 * Formats a colour as a CSS `rgb()` string in the modern space-separated syntax: `'rgb(r g b)'`, or `'rgb(r g b / a)'` for
 * translucent colours. Channels are clamped and rounded (see {@link toRgba}); alpha is rounded to 3 decimals and omitted when it
 * rounds to `1`. The result is understood by {@link parseColor} and by all current browsers.
 * @param {ColorInput} color - The colour
 * @returns {string} The CSS colour string
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toCssRgb('#ff8000'); // => 'rgb(255 128 0)'
 * toCssRgb({ r: 0, g: 0, b: 0, a: 0.5 }); // => 'rgb(0 0 0 / 0.5)'
 * toCssRgb('#00000080'); // => 'rgb(0 0 0 / 0.502)'
 */
export function toCssRgb(color: ColorInput): string {
	const { r, g, b, a } = toRgba(color);
	return `rgb(${r} ${g} ${b}${cssAlpha(a)})`;
}

/**
 * Formats a colour as a CSS `hsl()` string in the modern space-separated syntax: `'hsl(h s% l%)'`, or `'hsl(h s% l% / a)'` for
 * translucent colours. Hue (degrees, at most `359.8` for 8-bit channels), saturation and lightness are rounded to 1 decimal, which is enough for every
 * 8-bit colour to convert back to exactly the same channels (`parseColor(toCssHsl(c))` round-trips); alpha is rounded to 3 decimals
 * and omitted when it rounds to `1`.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {string} The CSS colour string
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toCssHsl('#ff0000'); // => 'hsl(0 100% 50%)'
 * toCssHsl('#808080'); // => 'hsl(0 0% 50.2%)'
 * toCssHsl({ r: 51, g: 102, b: 153, a: 0.25 }); // => 'hsl(210 50% 40% / 0.25)'
 */
export function toCssHsl(color: ColorInput): string {
	const rgba = toRgba(color);
	const { h, s, l } = hslOf(rgba);
	return `hsl(${round(h, 1)} ${round(s, 1)}% ${round(l, 1)}%${cssAlpha(rgba.a)})`;
}

/**
 * Converts an RGB colour to HSL using the standard (CSS Color 4) formulas. The result is not rounded.
 * Achromatic colours (greys) get hue `0` and saturation `0`. Alpha is ignored.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {Hsl} Hue in `[0, 360)`, saturation and lightness in `[0, 100]`
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * rgbToHsl({ r: 255, g: 0, b: 0 }); // => { h: 0, s: 100, l: 50 }
 * rgbToHsl('#808080'); // => { h: 0, s: 0, l: 50.19607843137255 }
 */
export function rgbToHsl(color: ColorInput): Hsl {
	return hslOf(toRgba(color));
}

/**
 * Converts a normalized colour (integer channels in `[0, 255]`) to HSL, as {@link rgbToHsl} does.
 * @param {Rgb} rgb - The colour, already normalized by {@link toRgba}
 * @returns {Hsl} Hue in `[0, 360)`, saturation and lightness in `[0, 100]`
 * @example
 * hslOf({ r: 255, g: 0, b: 0 }); // => { h: 0, s: 100, l: 50 }
 */
function hslOf(rgb: Rgb): Hsl {
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;
	const high = Math.max(r, g, b);
	const low = Math.min(r, g, b);
	const lightness = (high + low) / 2;
	const delta = high - low;
	if (delta === 0) return { h: 0, s: 0, l: lightness * 100 };

	const saturation = delta / (1 - Math.abs(2 * lightness - 1));
	let hue: number;
	if (high === r) hue = (g - b) / delta;
	else if (high === g) hue = (b - r) / delta + 2;
	else hue = (r - g) / delta + 4;
	// `hue * 60` lies in `(-60, 300]` (and is never within rounding distance of `-0` or `-360`), so wrapping it into `[0, 360)`
	// takes one addition; the saturation is positive, so it only needs capping.
	return { h: hue < 0 ? hue * 60 + 360 : hue * 60, s: Math.min(saturation * 100, 100), l: lightness * 100 };
}

/**
 * Converts an HSL colour to RGB using the standard (CSS Color 4) formulas, rounding channels to integers.
 * The hue is normalized into `[0, 360)` (so `-120` and `600` both mean `240`); saturation and lightness are clamped to `[0, 100]`.
 * @param {Hsl} hsl - The colour in HSL
 * @returns {Rgb} The colour in RGB with integer channels in `[0, 255]`
 * @throws {TypeError} when `hsl` is not an object or a component is not a number
 * @throws {RangeError} when a component is `NaN` or the hue is infinite
 * @example
 * hslToRgb({ h: 0, s: 100, l: 50 }); // => { r: 255, g: 0, b: 0 }
 * hslToRgb({ h: 120, s: 100, l: 25 }); // => { r: 0, g: 128, b: 0 }
 * hslToRgb({ h: -120, s: 100, l: 50 }); // => { r: 0, g: 0, b: 255 }
 */
export function hslToRgb(hsl: Hsl): Rgb {
	if (typeof hsl !== 'object' || hsl === null) throw new TypeError(`hslToRgb: \`hsl\` must be an { h, s, l } object, got ${describe(hsl)}`);
	const hue = readChannel('hslToRgb', 'hsl.h', hsl.h);
	if (!Number.isFinite(hue)) throw new RangeError(`hslToRgb: \`hsl.h\` must be finite, got ${hue}`);
	return hslValuesToRgb(hue, readChannel('hslToRgb', 'hsl.s', hsl.s), readChannel('hslToRgb', 'hsl.l', hsl.l), { r: 0, g: 0, b: 0 });
}

/**
 * Converts (validated) HSL components to RGB, as {@link hslToRgb} does: the hue is normalized into `[0, 360)` and
 * saturation and lightness are clamped to `[0, 100]`. The channels are written into `target` (any other property, such
 * as an alpha, is kept), which saves an allocation and keeps the shape of the callers' result objects.
 * @template T - Type of the target object
 * @param {number} hue - A finite hue in degrees
 * @param {number} saturation - Saturation in percent (not `NaN`)
 * @param {number} lightness - Lightness in percent (not `NaN`)
 * @param {T} target - The object receiving the `r`, `g` and `b` channels (mutated)
 * @returns {T} `target`, with integer channels in `[0, 255]`
 * @example
 * hslValuesToRgb(120, 100, 25, { r: 0, g: 0, b: 0 }); // => { r: 0, g: 128, b: 0 }
 */
function hslValuesToRgb<T extends Rgb>(hue: number, saturation: number, lightness: number, target: T): T {
	// The floating-point `%` inside `modulo` is slow: skip it for hues already in range.
	const h = hue >= 0 && hue < 360 ? hue : modulo(hue, 360);
	const l = (clamp(lightness, 0, 100) + 0) / 100;
	const chroma = ((clamp(saturation, 0, 100) + 0) / 100) * Math.min(l, 1 - l);
	target.r = hslChannel(0, h, l, chroma);
	target.g = hslChannel(8, h, l, chroma);
	target.b = hslChannel(4, h, l, chroma);
	return target;
}

/**
 * Computes one RGB channel with the CSS Color 4 `hslToRgb` formula.
 * @param {number} offset - `0` for red, `8` for green, `4` for blue
 * @param {number} h - The hue in `[0, 360)`
 * @param {number} l - The lightness in `[0, 1]`
 * @param {number} chroma - The chroma, `s * min(l, 1 - l)`
 * @returns {number} The channel as an integer in `[0, 255]`
 * @example
 * hslChannel(0, 0, 0.5, 0.5); // => 255
 */
function hslChannel(offset: number, h: number, l: number, chroma: number): number {
	// `offset + h / 30` lies in `[0, 20)`: one exact subtraction replaces the (slow, floating-point) `% 12`.
	let k = offset + h / 30;
	if (k >= 12) k -= 12;
	return toByte((l - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
}

/**
 * Mixes two colours by plain linear interpolation of their sRGB channels and alpha (no gamma-correct or premultiplied
 * blending). `weight` is the proportion of `colorB`: `0` gives `colorA`, `1` gives `colorB`, `0.5` the midpoint.
 * (Note: this is the opposite convention from Sass's `mix`, whose weight is the proportion of the first colour.)
 * @param {ColorInput} colorA - The colour at `weight = 0`
 * @param {ColorInput} colorB - The colour at `weight = 1`
 * @param {number} [weight=0.5] - Proportion of `colorB`, in `[0, 1]`
 * @returns {Rgba} The mixed colour (channels rounded to integers, alpha interpolated)
 * @throws {TypeError} when a colour is invalid (see {@link toRgba})
 * @throws {TypeError} when `weight` is not a number
 * @throws {RangeError} when `weight` is not in `[0, 1]` or a channel is `NaN`
 * @example
 * mix('#000000', '#ffffff'); // => { r: 128, g: 128, b: 128, a: 1 }
 * mix('#ff0000', '#0000ff', 0.25); // => { r: 191, g: 0, b: 64, a: 1 }
 * mix({ r: 0, g: 0, b: 0, a: 0 }, '#000', 0.5); // => { r: 0, g: 0, b: 0, a: 0.5 }
 */
export function mix(colorA: ColorInput, colorB: ColorInput, weight = 0.5): Rgba {
	assertNumber('mix', 'weight', weight, weight >= 0 && weight <= 1, 'a number in [0, 1]');
	const a = toRgba(colorA);
	const b = toRgba(colorB);
	return {
		r: toByte(lerp(a.r, b.r, weight)),
		g: toByte(lerp(a.g, b.g, weight)),
		b: toByte(lerp(a.b, b.b, weight)),
		// Clamp to the inputs: `(1 - w) * x + w * y` can overshoot max(x, y) by one ulp.
		a: clamp(lerp(a.a, b.a, weight), Math.min(a.a, b.a), Math.max(a.a, b.a)) + 0
	};
}

/**
 * Shifts the HSL lightness of a colour by `delta` percentage points (clamped to `[0, 100]`), keeping hue, saturation and alpha.
 * @param {ColorInput} color - The colour
 * @param {number} delta - Lightness change, in `[-100, 100]`
 * @returns {Rgba} The adjusted colour
 * @example
 * shiftLightness('#808080', 10); // lighter grey
 */
function shiftLightness(color: ColorInput, delta: number): Rgba {
	const rgba = toRgba(color);
	// No shortcut is needed for `delta = 0`: the HSL round trip is exact for every 8-bit colour.
	const hsl = hslOf(rgba);
	// `toRgba` returns a fresh object: overwrite its channels, keeping its alpha.
	return hslValuesToRgb(hsl.h, hsl.s, hsl.l + delta, rgba);
}

/**
 * Makes a colour lighter by adding `amount` percentage points to its HSL lightness (the result is clamped at `100`, white).
 * Hue, saturation and alpha are kept. `lighten(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Lightness points to add, in `[0, 100]`
 * @returns {Rgba} The lighter colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]` or a channel is `NaN`
 * @example
 * lighten('#000000', 50); // => { r: 128, g: 128, b: 128, a: 1 }
 * lighten('#ff0000', 20); // => { r: 255, g: 102, b: 102, a: 1 }
 * lighten('#ffffff', 10); // => { r: 255, g: 255, b: 255, a: 1 }
 */
export function lighten(color: ColorInput, amount: number): Rgba {
	assertNumber('lighten', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return shiftLightness(color, amount);
}

/**
 * Makes a colour darker by subtracting `amount` percentage points from its HSL lightness (the result is clamped at `0`, black).
 * Hue, saturation and alpha are kept. `darken(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Lightness points to subtract, in `[0, 100]`
 * @returns {Rgba} The darker colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]` or a channel is `NaN`
 * @example
 * darken('#ffffff', 50); // => { r: 128, g: 128, b: 128, a: 1 }
 * darken('#ff0000', 20); // => { r: 153, g: 0, b: 0, a: 1 }
 */
export function darken(color: ColorInput, amount: number): Rgba {
	assertNumber('darken', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return shiftLightness(color, -amount);
}

/**
 * Returns a copy of a colour with the given alpha.
 * @param {ColorInput} color - The colour
 * @param {number} alpha - The new alpha, in `[0, 1]`
 * @returns {Rgba} The colour with its alpha replaced
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `alpha` is not a number
 * @throws {RangeError} when `alpha` is not in `[0, 1]` or a channel is `NaN`
 * @example
 * withAlpha('#ff0000', 0.5); // => { r: 255, g: 0, b: 0, a: 0.5 }
 */
export function withAlpha(color: ColorInput, alpha: number): Rgba {
	assertNumber('withAlpha', 'alpha', alpha, alpha >= 0 && alpha <= 1, 'a number in [0, 1]');
	const rgba = toRgba(color);
	// `toRgba` returns a fresh object.
	rgba.a = alpha + 0;
	return rgba;
}

/**
 * Computes the WCAG 2.x relative luminance of a colour: `0.2126 R + 0.7152 G + 0.0722 B` over the linearized sRGB channels.
 * Alpha is ignored (composite translucent colours over their background first, e.g. with {@link mix}).
 * @param {ColorInput} color - The colour
 * @returns {number} The relative luminance, in `[0, 1]` (`0` for black, `1` for white)
 * @throws {TypeError} when `color` is invalid (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * relativeLuminance('#ffffff'); // => 1
 * relativeLuminance('#000000'); // => 0
 * relativeLuminance('#ff0000'); // => 0.2126
 */
export function relativeLuminance(color: ColorInput): number {
	const { r, g, b } = toRgba(color);
	return Math.min(1, 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b));
}

/**
 * Computes the WCAG 2.x contrast ratio `(L1 + 0.05) / (L2 + 0.05)` between two colours, where `L1` is the larger relative luminance.
 * The ratio is symmetric and ranges from `1` (identical luminance) to `21` (black on white). Alpha is ignored.
 * @param {ColorInput} a - First colour
 * @param {ColorInput} b - Second colour
 * @returns {number} The contrast ratio, in `[1, 21]`
 * @throws {TypeError} when a colour is invalid (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * contrastRatio('#000', '#fff'); // => 21
 * contrastRatio('#777', '#fff').toFixed(4); // => '4.4781'
 * contrastRatio('#abc', '#abc'); // => 1
 */
export function contrastRatio(a: ColorInput, b: ColorInput): number {
	const first = relativeLuminance(a);
	const second = relativeLuminance(b);
	return clamp((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05), 1, 21);
}

/**
 * Picks whichever of two text colours has the higher WCAG contrast against a background (the dark one on ties).
 * The chosen option is returned exactly as given (same string or object).
 * @template L - Type of the light option
 * @template D - Type of the dark option
 * @param {ColorInput} background - The background colour
 * @param {ReadableTextColorOptions<L, D>} [options={}] - `light` (default `'#ffffff'`) and `dark` (default `'#000000'`) candidates
 * @returns {L | D} The candidate with the better contrast (also typed as the defaults unless both candidates are given)
 * @throws {TypeError} when a colour is invalid (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * getReadableTextColor('#1e3a8a'); // => '#ffffff'
 * getReadableTextColor('#fde68a'); // => '#000000'
 * getReadableTextColor('#222', { light: '#eee', dark: '#333' }); // => '#eee'
 */
export function getReadableTextColor<L extends ColorInput, D extends ColorInput>(background: ColorInput, options: Required<ReadableTextColorOptions<L, D>>): L | D;
export function getReadableTextColor<L extends ColorInput = '#ffffff', D extends ColorInput = '#000000'>(
	background: ColorInput,
	options?: ReadableTextColorOptions<L, D>
): L | D | '#ffffff' | '#000000';
/**
 * Implementation of {@link getReadableTextColor} (see the first overload for the full documentation). A missing candidate falls back to
 * its default, so the result type includes the defaults unless both candidates are given.
 * @param {ColorInput} background - The background colour
 * @param {ReadableTextColorOptions<ColorInput, ColorInput>} [options={}] - The candidates
 * @returns {ColorInput} The candidate with the better contrast
 */
export function getReadableTextColor(background: ColorInput, options: ReadableTextColorOptions<ColorInput, ColorInput> = {}): ColorInput {
	const light = options.light ?? '#ffffff';
	const dark = options.dark ?? '#000000';
	return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

/**
 * Checks whether a foreground/background pair meets a WCAG 2.x contrast requirement:
 * AA needs `4.5:1` (`3:1` for large text), AAA needs `7:1` (`4.5:1` for large text). The ratio is not rounded before comparing.
 * @param {ColorInput} foreground - The text colour
 * @param {ColorInput} background - The background colour
 * @param {MeetsContrastOptions} [options={}] - `level` (`'AA'` (default) or `'AAA'`) and `largeText` (default `false`)
 * @returns {boolean} `true` if the contrast ratio is at least the required threshold
 * @throws {TypeError} when a colour is invalid (see {@link toRgba})
 * @throws {RangeError} when `level` is not `'AA'` or `'AAA'`, or a channel is `NaN`
 * @example
 * meetsContrast('#767676', '#ffffff'); // => true // 4.54:1
 * meetsContrast('#777777', '#ffffff'); // => false // 4.48:1
 * meetsContrast('#777777', '#ffffff', { largeText: true }); // => true
 * meetsContrast('#767676', '#ffffff', { level: 'AAA' }); // => false
 */
export function meetsContrast(foreground: ColorInput, background: ColorInput, options: MeetsContrastOptions = {}): boolean {
	const { level = 'AA', largeText = false } = options;
	if (level !== 'AA' && level !== 'AAA') throw new RangeError(`meetsContrast: \`level\` must be 'AA' or 'AAA', got ${String(level)}`);
	const threshold = level === 'AA' ? (largeText ? 3 : 4.5) : largeText ? 4.5 : 7;
	return contrastRatio(foreground, background) >= threshold;
}
