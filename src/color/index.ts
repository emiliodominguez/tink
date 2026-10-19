import { clamp, lerp, modulo, round } from '../math/index.js';
import { assertInteger, assertNumber, describe, readOption, show } from '../utils/assert.js';

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
 * A colour in the OKLab perceptual colour space (Björn Ottosson, 2020; CSS Color 4 `oklab()`): equal distances look like roughly
 * equal differences, so interpolating in it avoids the dull, darkened midpoints of sRGB mixing.
 */
export interface Oklab {
	/** Perceived lightness, `0` (black) – `1` (white). */
	l: number;
	/** Green (negative) – red (positive) axis, within about `±0.4`. */
	a: number;
	/** Blue (negative) – yellow (positive) axis, within about `±0.4`. */
	b: number;
	/** Alpha, `0` (transparent) – `1` (opaque). Optional on input (default `1`); always set on the values this module returns. */
	alpha?: number;
}

/**
 * The polar form of {@link Oklab} (CSS Color 4 `oklch()`): lightness, chroma (colourfulness) and hue. Changing only the lightness or
 * the hue keeps the other perceived attributes, which HSL does not.
 */
export interface Oklch {
	/** Perceived lightness, `0` (black) – `1` (white). */
	l: number;
	/** Chroma, `0` for greys and up to about `0.32` inside sRGB (wider gamuts reach higher values). */
	c: number;
	/** Hue angle in degrees, `[0, 360)`. `NaN` means *powerless* (CSS `none`): returned for greys. */
	h: number;
	/** Alpha, `0` (transparent) – `1` (opaque). Optional on input (default `1`); always set on the values this module returns. */
	alpha?: number;
}

/**
 * An OKLCH colour as {@link oklchToRgb} and {@link inGamut} accept it: an {@link Oklch} whose hue may also be `null` or missing.
 * A `NaN`, `null` or missing hue is *powerless* (CSS `none`) and reads as `0`, so a grey from {@link toOklch} survives a JSON round
 * trip (`JSON.stringify` writes `NaN` as `null`).
 */
export interface OklchInput {
	/** Perceived lightness, `0` (black) – `1` (white). */
	l: number;
	/** Chroma: negative values count as `0`. */
	c: number;
	/** Hue angle in degrees (any finite value, wrapped); `NaN`, `null` or missing when powerless. */
	h?: number | null;
	/** Alpha, `0` (transparent) – `1` (opaque), clamped. Default `1`. */
	alpha?: number;
}

/**
 * Any colour accepted by the higher-level helpers of this module: an {@link Rgb} / {@link Rgba} object,
 * or a CSS colour string understood by {@link parseColor}: hex (`'#rgb'`, `'#rgba'`, `'#rrggbb'`, `'#rrggbbaa'`, with or without `#`),
 * `rgb()` / `rgba()`, `hsl()` / `hsla()`, `oklab()`, `oklch()` or `'transparent'`.
 */
export type ColorInput = Rgb | Rgba | string;

/**
 * Colour space in which {@link mix} interpolates: `'srgb'` (gamma-encoded channels, the historical default), or the perceptual
 * `'oklab'` (straight line) and `'oklch'` (keeps chroma, so hues pass through saturated colours instead of grey).
 */
export type MixSpace = 'srgb' | 'oklab' | 'oklch';

/**
 * How {@link mix} interpolates hues in `'oklch'` (CSS Color 4 hue interpolation methods): along the `'shorter'` (default) or
 * `'longer'` arc of the hue circle, or always `'increasing'` / `'decreasing'` the angle. With `'longer'`, two equal hues (or a grey,
 * whose powerless hue takes the other colour's) are a full turn apart.
 */
export type HueInterpolation = 'shorter' | 'longer' | 'increasing' | 'decreasing';

/**
 * Options accepted by {@link mix}.
 */
export interface MixOptions {
	/**
	 * The interpolation space.
	 * @default 'srgb'
	 */
	space?: MixSpace;
	/**
	 * The hue interpolation method (`'oklch'` only).
	 * @default 'shorter'
	 */
	hue?: HueInterpolation;
}

/**
 * Options accepted by {@link lighten}, {@link darken}, {@link saturate}, {@link desaturate}, {@link grayscale}, {@link rotateHue} and
 * {@link complement}.
 */
export interface LightnessOptions {
	/**
	 * The model whose component changes: HSL (`'hsl'`), or OKLCH (`'oklch'`), which tracks perceived lightness, chroma and hue
	 * separately (changing one keeps the other two, as seen).
	 * @default 'hsl'
	 */
	space?: 'hsl' | 'oklch';
}

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
	String.raw`^(rgba?|hsla?|oklab|oklch)\(${SPACE}*${MODERN_COMPONENT}${SPACE}+${MODERN_COMPONENT}${SPACE}+${MODERN_COMPONENT}(?:${SPACE}*\/${SPACE}*${MODERN_COMPONENT})?${SPACE}*\)$`,
	'i'
);

/** How many of each CSS angle unit make a full turn (`''` is a unitless hue, which means degrees). */
const UNITS_PER_TURN: Readonly<Record<string, number>> = { '': 360, deg: 360, grad: 400, rad: 2 * Math.PI, turn: 1 };

/**
 * Linear-light sRGB to LMS cone responses (row-major 3×3): Ottosson's OKLab matrix M1 with the sRGB → XYZ D65 step folded in, as
 * recomputed at full double precision by CSS Color 4 (white maps to exactly `l = 1`, `a = b = 0`).
 */
const RGB_TO_LMS = [
	0.41222146947076305, 0.5363325372617348, 0.05144599326750221, 0.21190349581782522, 0.6806995506452344, 0.10739695353694056, 0.08830245919005643, 0.2817188391361215,
	0.6299787016738222
];

/** Inverse of {@link RGB_TO_LMS}. */
const LMS_TO_RGB = [
	4.076741636075958, -3.3077115392580616, 0.2309699031821043, -1.2684379732850317, 2.6097573492876887, -0.34131937600265727, -0.004196076138675564, -0.7034186179359363,
	1.7076146940746117
];

/** Cube-rooted LMS to OKLab (Ottosson's M2, CSS Color 4 precision). */
const LMS_TO_OKLAB = [
	0.210454268309314, 0.7936177747023054, -0.0040720430116193, 1.9779985324311684, -2.42859224204858, 0.450593709617411, 0.0259040424655478, 0.7827717124575296,
	-0.8086757549230774
];

/** Inverse of {@link LMS_TO_OKLAB}. */
const OKLAB_TO_LMS = [1, 0.3963377773761749, 0.2158037573099136, 1, -0.1055613458156586, -0.0638541728258133, 1, -0.0894841775298119, -1.2914855480194092];

/**
 * OKLab chroma below which a converted colour counts as grey (CSS Color 4): its `a` and `b` are rounding noise, reported as `0`,
 * and its hue is powerless. Every 8-bit grey lands far below it (about `1e-16`), every other 8-bit colour far above (`> 1e-3`).
 */
const ACHROMATIC = 0.000004;

/** Tolerance of the sRGB gamut test, per gamma-encoded channel in `[0, 1]` (as in colorjs.io): absorbs the rounding of the conversions. */
const GAMUT_EPSILON = 0.000075;

/**
 * Largest chroma the gamut mapping starts from (larger ones would overflow when converted): the binary search takes at most
 * `log2(1e100 / 0.0001)`, about 350, steps.
 */
const MAX_CHROMA = 1e100;

/** Degrees per radian. */
const DEGREES = 180 / Math.PI;

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

/**
 * Cache of {@link linearChannel} results, by channel value (filled on first use, at most 256 entries). A `Map`, not an array: a missing
 * array index would be looked up on a (possibly polluted) `Array.prototype`.
 */
const LINEAR_CHANNELS = new Map<number, number>();

/**
 * Converts one 8-bit sRGB channel to linear light, as defined by WCAG 2.x.
 * @param {number} value - Integer channel in `[0, 255]`
 * @returns {number} Linear channel in `[0, 1]`
 * @example
 * linearChannel(255); // => 1
 */
function linearChannel(value: number): number {
	let linear = LINEAR_CHANNELS.get(value);
	if (linear === undefined) {
		linear = toLinear(value / 255);
		LINEAR_CHANNELS.set(value, linear);
	}
	return linear;
}

/**
 * The sRGB transfer function: converts a gamma-encoded channel in `[0, 1]` to linear light.
 * @param {number} value - Gamma-encoded channel in `[0, 1]`
 * @returns {number} Linear channel in `[0, 1]`
 * @example
 * toLinear(1); // => 1
 */
function toLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/**
 * Inverse of {@link toLinear}, extended to values outside `[0, 1]` by symmetry (CSS Color 4), so that out-of-gamut colours stay
 * out of `[0, 1]` once encoded.
 * @param {number} value - Linear channel
 * @returns {number} Gamma-encoded channel
 * @example
 * fromLinear(1); // => 1
 */
function fromLinear(value: number): number {
	const magnitude = Math.abs(value);
	return magnitude <= 0.0031308 ? value * 12.92 : Math.sign(value) * (1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055);
}

/**
 * Multiplies a row-major 3×3 matrix by the column vector `(x, y, z)`.
 * @param {readonly number[]} matrix - Nine coefficients, row by row
 * @param {number} x - First component
 * @param {number} y - Second component
 * @param {number} z - Third component
 * @returns {number[]} The product, three components
 * @example
 * transform([1, 0, 0, 0, 2, 0, 0, 0, 3], 1, 1, 1); // => [1, 2, 3]
 */
function transform(matrix: readonly number[], x: number, y: number, z: number): number[] {
	return [matrix[0] * x + matrix[1] * y + matrix[2] * z, matrix[3] * x + matrix[4] * y + matrix[5] * z, matrix[6] * x + matrix[7] * y + matrix[8] * z];
}

/**
 * Converts gamma-encoded sRGB channels in `[0, 1]` to OKLab.
 * @param {number} r - Red, `[0, 1]`
 * @param {number} g - Green, `[0, 1]`
 * @param {number} b - Blue, `[0, 1]`
 * @returns {number[]} `[l, a, b]`
 * @example
 * srgbToOklab(0, 0, 0); // => [0, 0, 0]
 */
function srgbToOklab(r: number, g: number, b: number): number[] {
	const lms = transform(RGB_TO_LMS, toLinear(r), toLinear(g), toLinear(b));
	return transform(LMS_TO_OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));
}

/**
 * Converts OKLab to gamma-encoded sRGB channels, without any clamping (out-of-gamut colours give channels outside `[0, 1]`).
 * @param {number} l - Lightness
 * @param {number} a - Green–red axis
 * @param {number} b - Blue–yellow axis
 * @returns {number[]} `[r, g, b]`
 * @example
 * oklabToSrgb(0, 0, 0); // => [0, 0, 0]
 */
function oklabToSrgb(l: number, a: number, b: number): number[] {
	const lms = transform(OKLAB_TO_LMS, l, a, b);
	const rgb = transform(LMS_TO_RGB, lms[0] ** 3, lms[1] ** 3, lms[2] ** 3);
	return [fromLinear(rgb[0]), fromLinear(rgb[1]), fromLinear(rgb[2])];
}

/**
 * Converts a normalized colour (integer channels) to OKLab, reporting greys (chroma below {@link ACHROMATIC}) with `a = b = 0`
 * and clamping the lightness to `[0, 1]` (white's is `1` within one ulp).
 * @param {Rgb} rgb - The colour, already normalized by {@link toRgba}
 * @returns {number[]} `[l, a, b]`
 * @example
 * oklabOf({ r: 255, g: 255, b: 255 }); // => [1, 0, 0]
 */
function oklabOf(rgb: Rgb): number[] {
	const lms = transform(RGB_TO_LMS, linearChannel(rgb.r), linearChannel(rgb.g), linearChannel(rgb.b));
	const lab = transform(LMS_TO_OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));
	const grey = Math.hypot(lab[1], lab[2]) < ACHROMATIC;
	return [Math.min(Math.max(lab[0], 0), 1), grey ? 0 : lab[1], grey ? 0 : lab[2]];
}

/**
 * Tells whether gamma-encoded sRGB channels are inside the gamut (within {@link GAMUT_EPSILON}).
 * @param {number[]} rgb - `[r, g, b]`
 * @returns {boolean} `true` when every channel is in `[0, 1]`
 * @example
 * isInside([1, 0.5, 0]); // => true
 */
function isInside(rgb: number[]): boolean {
	return rgb.every(function (channel) {
		return channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON;
	});
}

/**
 * Converts OKLCH to 8-bit sRGB, bringing out-of-gamut colours into sRGB with the CSS Color 4 gamut mapping algorithm: lightness
 * `>= 1` gives white and `<= 0` black; otherwise the chroma is reduced (binary search, keeping lightness and hue) until clipping the
 * colour changes it by less than one just noticeable difference (deltaEOK `0.02`), and that clipped colour is used. Unlike plain
 * clipping, this keeps the hue and lightness of vivid colours. The channels are written into `target` (any other property is kept).
 * @template T - Type of the target object
 * @param {number} l - Lightness (not `NaN`)
 * @param {number} c - Chroma (not `NaN`): negative values count as `0`, values above {@link MAX_CHROMA} as `MAX_CHROMA`
 * @param {number} h - Finite hue in degrees
 * @param {T} target - The object receiving the `r`, `g` and `b` channels (mutated)
 * @returns {T} `target`, with integer channels in `[0, 255]`
 * @example
 * oklchToBytes(0.5, 0, 0, { r: 0, g: 0, b: 0 }); // => { r: 99, g: 99, b: 99 }
 */
function oklchToBytes<T extends Rgb>(l: number, c: number, h: number, target: T): T {
	const radians = (h % 360) / DEGREES;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	let rgb = [1, 1, 1];

	/**
	 * The sRGB channels of the colour at this chroma (same lightness and hue).
	 * @param {number} chroma - The chroma
	 * @returns {number[]} `[r, g, b]`, possibly out of `[0, 1]`
	 */
	function at(chroma: number): number[] {
		return oklabToSrgb(l, chroma * cos, chroma * sin);
	}

	/**
	 * Clips the colour at this chroma into the gamut, keeping the result in `rgb`, and measures how far clipping moved it.
	 * @param {number} chroma - The chroma
	 * @returns {number} The deltaEOK between the clipped and the unclipped colour
	 */
	function clip(chroma: number): number {
		rgb = at(chroma).map(function (channel) {
			return Math.min(Math.max(channel, 0), 1);
		});
		const lab = srgbToOklab(rgb[0], rgb[1], rgb[2]);
		return Math.hypot(lab[0] - l, lab[1] - chroma * cos, lab[2] - chroma * sin);
	}

	if (l <= 0) rgb = [0, 0, 0];
	else if (l < 1) {
		let max = c > 0 ? Math.min(c, MAX_CHROMA) : 0;
		rgb = at(max);
		// CSS Color 4 gamut mapping: done when in gamut, or when clipping is unnoticeable (deltaEOK < JND = 0.02); otherwise binary
		// search the chroma (to within 0.0001) for the most colourful clipped colour that stays within one JND of its unclipped self.
		if (!isInside(rgb) && clip(max) >= 0.02) {
			let min = 0;
			let minInGamut = true;
			while (max - min > 0.0001) {
				const chroma = (min + max) / 2;
				if (minInGamut && isInside(at(chroma))) {
					min = chroma;
					continue;
				}
				const delta = clip(chroma);
				if (delta >= 0.02) max = chroma;
				else if (0.02 - delta < 0.0001) break;
				else {
					minInGamut = false;
					min = chroma;
				}
			}
		}
	}
	target.r = toByte(rgb[0] * 255);
	target.g = toByte(rgb[1] * 255);
	target.b = toByte(rgb[2] * 255);
	return target;
}

/**
 * Converts OKLab to 8-bit sRGB through {@link oklchToBytes} (same gamut mapping).
 * @template T - Type of the target object
 * @param {number} l - Lightness (not `NaN`)
 * @param {number} a - Green–red axis (not `NaN`)
 * @param {number} b - Blue–yellow axis (not `NaN`)
 * @param {T} target - The object receiving the `r`, `g` and `b` channels (mutated)
 * @returns {T} `target`, with integer channels in `[0, 255]`
 * @example
 * oklabToBytes(1, 0, 0, { r: 0, g: 0, b: 0 }); // => { r: 255, g: 255, b: 255 }
 */
function oklabToBytes<T extends Rgb>(l: number, a: number, b: number, target: T): T {
	return oklchToBytes(l, Math.hypot(a, b), Math.atan2(b, a) * DEGREES, target);
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
	const name = match[1].toLowerCase();

	if (name[0] === 'o') {
		const polar = name === 'oklch';
		// Lightness (100% = 1) and the a, b or chroma components (100% = 0.4) are numbers or percentages; the hue is a number or an angle.
		for (let i = polar ? 1 : 2; i >= 0; i--) {
			if (units[i] !== '' && units[i] !== '%') return undefined;
			if (units[i] === '%') values[i] /= i === 0 ? 100 : 250;
		}
		// Lightness is clamped to [0, 1] when parsed (CSS Color 4); a negative chroma counts as 0 (see `oklchToBytes`).
		const lightness = clamp(values[0], 0, 1);
		const target = { r: 0, g: 0, b: 0, a };
		if (!polar) return oklabToBytes(lightness, values[1], values[2], target);
		const hueUnits = Object.hasOwn(UNITS_PER_TURN, units[2]) ? UNITS_PER_TURN[units[2]] : undefined;
		return hueUnits === undefined ? undefined : oklchToBytes(lightness, values[1], (modulo(values[2], hueUnits) * 360) / hueUnits, target);
	}

	if (name[0] === 'r') {
		for (let i = 0; i < 3; i++) {
			// Channels are numbers or percentages; the legacy syntax does not allow mixing them.
			if ((units[i] !== '' && units[i] !== '%') || (legacy && units[i] !== units[0])) return undefined;
			values[i] = toByte(units[i] === '%' ? (values[i] * 255) / 100 : values[i]);
		}
		return { r: values[0], g: values[1], b: values[2], a };
	}

	// The hue is a number or an angle. Legacy syntax requires percentages for saturation and lightness; the modern one also accepts plain numbers.
	// Own units only: an unknown unit (`%` on a hue) must not be found on a polluted `Object.prototype`.
	const perTurn = Object.hasOwn(UNITS_PER_TURN, units[0]) ? UNITS_PER_TURN[units[0]] : undefined;
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
 * Strips CSS white space (see {@link SPACE}) from both ends of a string: `String.prototype.trim` also strips no-break spaces, line
 * separators, BOMs...
 * @param {string} input - The string
 * @returns {string} The string without leading and trailing CSS white space
 * @example
 * trimSpace('\t#fff \n'); // => '#fff'
 */
function trimSpace(input: string): string {
	let start = 0;
	let end = input.length;
	while (start < end && isSpace(input.charCodeAt(start))) start++;
	while (end > start && isSpace(input.charCodeAt(end - 1))) end--;
	return input.slice(start, end);
}

/**
 * Parses a CSS colour string as {@link parseColor} does, without throwing.
 * @param {string} input - The string to parse
 * @returns {Rgba | undefined} The colour, or `undefined` when `input` is not a supported CSS colour
 * @example
 * parseCssText(' transparent '); // => { r: 0, g: 0, b: 0, a: 0 }
 * parseCssText('red'); // => undefined
 */
function parseCssText(input: string): Rgba | undefined {
	const text = trimSpace(input);
	return parseHexDigits(text) ?? (text.length === 11 && text.toLowerCase() === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : parseCssFunction(text));
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
	const color = parseCssText(input);
	if (color === undefined) {
		throw new TypeError(`${caller}: \`${name}\` must be a CSS colour (hex, rgb(), hsl(), oklab(), oklch() or 'transparent'), got ${quote(input)}`);
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
 * - `oklab(l a b[ / alpha])` and `oklch(l c h[ / alpha])` (modern syntax only): lightness as a number or a percentage (`100%` = `1`,
 *   clamped to `[0, 1]`), `a`, `b` and chroma as numbers or percentages (`100%` = `0.4`; a negative chroma counts as `0`), the hue as
 *   for `hsl()`, `none` means `0`. Colours outside sRGB are brought into it with the CSS Color 4 gamut mapping (see {@link oklchToRgb});
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
 * Named colours (`red`, `rebeccapurple`, ...) are not accepted here, so that `parseColor` (and every helper taking a colour string)
 * does not ship their table: parse them with the opt-in {@link parseNamedColor} (`parseNamedColor(s) ?? parseColor(s)`).
 * `currentcolor`, `calc()` and the other colour functions (`hwb()`, `lab()`, `lch()`, `color()`, ...) are deliberately not supported,
 * to keep the bundle small. {@link isCssColor} tells, without throwing, whether a value is a string `parseColor` accepts.
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
 * parseColor('oklch(62.8% 0.2577 29.23)'); // => { r: 255, g: 0, b: 0, a: 1 }
 * parseColor('oklab(0.5 -0.1 0.05 / 50%)'); // => { r: 32, g: 117, b: 68, a: 0.5 }
 * parseColor('oklch(0.9 0.4 145)'); // => { r: 83, g: 255, b: 105, a: 1 } // far outside sRGB: gamut mapped
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
 * Tells whether a value is a CSS colour string that {@link parseColor} accepts (so that `parseColor(value)` will not throw): hex
 * (with or without `#`), `rgb()`, `rgba()`, `hsl()`, `hsla()`, `oklab()`, `oklch()` or `'transparent'`. Never throws. Named colours
 * are not accepted (see {@link parseNamedColor}).
 * @param {unknown} value - The value to test
 * @returns {boolean} `true` when `value` is a string `parseColor` accepts
 * @example
 * isCssColor('#ff8000'); // => true
 * isCssColor(' hsl(120deg 100% 25% / 50%) '); // => true
 * isCssColor('rgb(1, 2)'); // => false
 * isCssColor('red'); // => false // named colours: see parseNamedColor
 * isCssColor({ r: 0, g: 0, b: 0 }); // => false
 */
export function isCssColor(value: unknown): value is string {
	return typeof value === 'string' && parseCssText(value) !== undefined;
}

/**
 * The CSS named colours, decoded on first use from a packed string (so that they cost nothing to the helpers that do not use them):
 * name (lowercase) to `0xrrggbb`, in alphabetical order.
 */
let NAMED_COLORS: Map<string, number> | undefined;

/**
 * The OKLab coordinates of the named colours, in the table's order: computed on the first nearest-name lookup of {@link toColorName}.
 */
let NAMED_LABS: Array<[name: string, lab: ReturnType<typeof oklabOf>]> | undefined;

/**
 * Returns the table of the 148 CSS named colours (CSS Color 4 `<named-color>`, `transparent` excluded), decoding it on first use.
 * @returns {Map<string, number>} Lowercase name to `0xrrggbb`, in alphabetical order
 * @example
 * namedColors().get('rebeccapurple'); // => 0x663399
 */
function namedColors(): Map<string, number> {
	if (NAMED_COLORS === undefined) {
		NAMED_COLORS = new Map();
		// Each entry is a lowercase name followed by its six uppercase hex digits (disjoint alphabets, so the pattern is linear).
		const packed =
			'aliceblueF0F8FFantiquewhiteFAEBD7aqua00FFFFaquamarine7FFFD4azureF0FFFFbeigeF5F5DCbisqueFFE4C4black000000blanchedalmondFFEBCDblue0000FFblueviolet8A2BE2brownA52A2AburlywoodDEB887cadetblue5F9EA0chartreuse7FFF00chocolateD2691EcoralFF7F50cornflowerblue6495EDcornsilkFFF8DCcrimsonDC143Ccyan00FFFFdarkblue00008Bdarkcyan008B8BdarkgoldenrodB8860BdarkgrayA9A9A9darkgreen006400darkgreyA9A9A9darkkhakiBDB76Bdarkmagenta8B008Bdarkolivegreen556B2FdarkorangeFF8C00darkorchid9932CCdarkred8B0000darksalmonE9967Adarkseagreen8FBC8Fdarkslateblue483D8Bdarkslategray2F4F4Fdarkslategrey2F4F4Fdarkturquoise00CED1darkviolet9400D3deeppinkFF1493deepskyblue00BFFFdimgray696969dimgrey696969dodgerblue1E90FFfirebrickB22222floralwhiteFFFAF0forestgreen228B22fuchsiaFF00FFgainsboroDCDCDCghostwhiteF8F8FFgoldFFD700goldenrodDAA520gray808080green008000greenyellowADFF2Fgrey808080honeydewF0FFF0hotpinkFF69B4indianredCD5C5Cindigo4B0082ivoryFFFFF0khakiF0E68ClavenderE6E6FAlavenderblushFFF0F5lawngreen7CFC00lemonchiffonFFFACDlightblueADD8E6lightcoralF08080lightcyanE0FFFFlightgoldenrodyellowFAFAD2lightgrayD3D3D3lightgreen90EE90lightgreyD3D3D3lightpinkFFB6C1lightsalmonFFA07Alightseagreen20B2AAlightskyblue87CEFAlightslategray778899lightslategrey778899lightsteelblueB0C4DElightyellowFFFFE0lime00FF00limegreen32CD32linenFAF0E6magentaFF00FFmaroon800000mediumaquamarine66CDAAmediumblue0000CDmediumorchidBA55D3mediumpurple9370DBmediumseagreen3CB371mediumslateblue7B68EEmediumspringgreen00FA9Amediumturquoise48D1CCmediumvioletredC71585midnightblue191970mintcreamF5FFFAmistyroseFFE4E1moccasinFFE4B5navajowhiteFFDEADnavy000080oldlaceFDF5E6olive808000olivedrab6B8E23orangeFFA500orangeredFF4500orchidDA70D6palegoldenrodEEE8AApalegreen98FB98paleturquoiseAFEEEEpalevioletredDB7093papayawhipFFEFD5peachpuffFFDAB9peruCD853FpinkFFC0CBplumDDA0DDpowderblueB0E0E6purple800080rebeccapurple663399redFF0000rosybrownBC8F8Froyalblue4169E1saddlebrown8B4513salmonFA8072sandybrownF4A460seagreen2E8B57seashellFFF5EEsiennaA0522DsilverC0C0C0skyblue87CEEBslateblue6A5ACDslategray708090slategrey708090snowFFFAFAspringgreen00FF7Fsteelblue4682B4tanD2B48Cteal008080thistleD8BFD8tomatoFF6347turquoise40E0D0violetEE82EEwheatF5DEB3whiteFFFFFFwhitesmokeF5F5F5yellowFFFF00yellowgreen9ACD32';
		for (const match of packed.matchAll(/([a-z]+)([\dA-F]{6})/g)) NAMED_COLORS.set(match[1], parseInt(match[2], 16));
	}
	return NAMED_COLORS;
}

/**
 * Parses a CSS named colour (CSS Color 4: the 148 `<named-color>` keywords, such as `'red'` or `'rebeccapurple'`, and `'transparent'`).
 * Names are ASCII case-insensitive, and CSS white space around them is ignored (as in {@link parseColor}). Returns `undefined` for any
 * other string, so it chains with `parseColor`: `parseNamedColor(s) ?? parseColor(s)` parses every colour either one accepts.
 *
 * Opt-in on purpose: the table (about 1.1 kB gzipped) is only bundled with this function and {@link toColorName}, never with
 * `parseColor` or the other helpers, and it is decoded on first use.
 * @param {string} name - The colour name
 * @returns {Rgba | undefined} A new colour object, or `undefined` when `name` is not a CSS colour name
 * @throws {TypeError} when `name` is not a string
 * @example
 * parseNamedColor('rebeccapurple'); // => { r: 102, g: 51, b: 153, a: 1 }
 * parseNamedColor(' DarkSlateGrey '); // => { r: 47, g: 79, b: 79, a: 1 }
 * parseNamedColor('transparent'); // => { r: 0, g: 0, b: 0, a: 0 }
 * parseNamedColor('#ff0000'); // => undefined
 * const input = 'hsl(0 100% 50%)';
 * parseNamedColor(input) ?? parseColor(input); // => { r: 255, g: 0, b: 0, a: 1 }
 */
export function parseNamedColor(name: string): Rgba | undefined {
	if (typeof name !== 'string') throw new TypeError(`parseNamedColor: \`name\` must be a string, got ${describe(name)}`);
	const text = trimSpace(name);
	// ASCII letters only (without the `u` flag, `i` never matches non-ASCII letters such as the Kelvin sign with `k`).
	if (text.length > 20 || !/^[a-z]+$/i.test(text)) return undefined;
	const lower = text.toLowerCase();
	if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
	const value = namedColors().get(lower);
	return value === undefined ? undefined : { r: value >> 16, g: (value >> 8) & 255, b: value & 255, a: 1 };
}

/**
 * Options accepted by {@link toColorName}.
 */
export interface ColorNameOptions {
	/**
	 * `false` returns a name only for a colour that is exactly a named colour; `true` returns the perceptually closest named colour
	 * (smallest OKLab distance, deltaEOK) whatever the colour, ignoring its alpha.
	 * @default false
	 */
	nearest?: boolean;
}

/**
 * Names a colour with its CSS named colour (see {@link parseNamedColor}).
 *
 * - By default the match is exact: the 8-bit channels must be those of a named colour and the colour opaque (`'transparent'` names
 *   `{ r: 0, g: 0, b: 0, a: 0 }` only); any other colour gives `undefined`. So a name is only returned when it denotes the very same
 *   colour, and `parseNamedColor(toColorName(c))` gives back `c`.
 * - `{ nearest: true }` always returns a name: the closest named colour by OKLab distance, alpha ignored (`'transparent'` is never
 *   returned). Useful to label a picked colour; the name may only be a rough description (the 148 names cover the gamut unevenly).
 *
 * Colours with several names (`aqua`/`cyan`, `fuchsia`/`magenta`, the `gray`/`grey` spellings) get the first one alphabetically.
 * @param {ColorInput} color - The colour (see {@link toRgba}; colour names are not accepted as input, use `parseNamedColor` first)
 * @param {ColorNameOptions} [options={}] - `nearest` (default `false`)
 * @returns {string | undefined} The lowercase name, or `undefined` when there is no exact match
 * @throws {TypeError} when `color` is invalid (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toColorName('#663399'); // => 'rebeccapurple'
 * toColorName({ r: 0, g: 255, b: 255 }); // => 'aqua'
 * toColorName('#808080'); // => 'gray'
 * toColorName('#ff0001'); // => undefined
 * toColorName('#ff0001', { nearest: true }); // => 'red'
 * toColorName('rgb(255 0 0 / 50%)'); // => undefined // translucent
 * toColorName('transparent'); // => 'transparent'
 */
export function toColorName(color: ColorInput, options: ColorNameOptions = {}): string | undefined {
	const rgba = toRgba(color);
	const table = namedColors();
	const value = (rgba.r << 16) | (rgba.g << 8) | rgba.b;
	if (!readOption(options, 'nearest', false)) {
		if (rgba.a < 1) return rgba.a === 0 && value === 0 ? 'transparent' : undefined;
		for (const [name, packed] of table) if (packed === value) return name;
		return undefined;
	}
	if (NAMED_LABS === undefined) {
		NAMED_LABS = [];
		for (const [name, packed] of table) NAMED_LABS.push([name, oklabOf({ r: packed >> 16, g: (packed >> 8) & 255, b: packed & 255 })]);
	}
	const lab = oklabOf(rgba);
	let best = '';
	let distance = Infinity;
	for (const [name, other] of NAMED_LABS) {
		const delta = Math.hypot(lab[0] - other[0], lab[1] - other[1], lab[2] - other[2]);
		// Strictly closer: among equally close names (exact duplicates), the first alphabetically wins.
		if (delta < distance) {
			best = name;
			distance = delta;
		}
	}
	return best;
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
	const alpha = readAlpha('toRgba', 'input.a', (input as Partial<Rgba>).a);
	return {
		r: toByte(readChannel('toRgba', 'input.r', input.r)),
		g: toByte(readChannel('toRgba', 'input.g', input.g)),
		b: toByte(readChannel('toRgba', 'input.b', input.b)),
		a: alpha
	};
}

/**
 * Reads an optional alpha channel: `undefined` gives `1`, numbers are clamped to `[0, 1]`.
 * @param {string} name - Function name for the error message
 * @param {string} channel - Channel name for the error message
 * @param {unknown} value - The alpha value
 * @returns {number} The alpha, in `[0, 1]` (never `-0`)
 * @throws {TypeError} when the value is neither `undefined` nor a number
 * @throws {RangeError} when the value is `NaN`
 * @example
 * readAlpha('toRgba', 'input.a', undefined); // => 1
 * readAlpha('toRgba', 'input.a', 2); // => 1
 */
function readAlpha(name: string, channel: string, value: unknown): number {
	return value === undefined ? 1 : clamp(readChannel(name, channel, value), 0, 1) + 0;
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
		(readOption(options, 'alpha') ?? a < 1)
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
	// The saturation is positive, so it only needs capping.
	return { h: hueOf(r, g, b, high, delta), s: Math.min(saturation * 100, 100), l: lightness * 100 };
}

/**
 * Computes the hue shared by HSL and HSV (CSS Color 4 formula) from channels in `[0, 1]`.
 * @param {number} r - Red, `[0, 1]`
 * @param {number} g - Green, `[0, 1]`
 * @param {number} b - Blue, `[0, 1]`
 * @param {number} high - The largest channel
 * @param {number} delta - The largest channel minus the smallest one
 * @returns {number} The hue in `[0, 360)`; `0` for greys (`delta = 0`)
 * @example
 * hueOf(0, 0, 1, 1, 1); // => 240
 */
function hueOf(r: number, g: number, b: number, high: number, delta: number): number {
	if (delta === 0) return 0;
	const hue = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	// `hue * 60` lies in `(-60, 300]` (and is never within rounding distance of `-0` or `-360`), so wrapping it into `[0, 360)`
	// takes one addition.
	return hue < 0 ? hue * 60 + 360 : hue * 60;
}

/**
 * A colour in the HSV (also called HSB) model, as colour pickers use it.
 */
export interface Hsv {
	/** Hue in degrees, `[0, 360)`. */
	h: number;
	/** Saturation in percent, `0`–`100`. */
	s: number;
	/** Value (brightness) in percent, `0`–`100`. */
	v: number;
}

/**
 * Converts an RGB colour to HSV (HSB), the model of most colour pickers (a hue slider over a saturation/value square). The result is
 * not rounded. Achromatic colours (greys) get hue `0` and saturation `0`; black also gets saturation `0`. Alpha is ignored.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {Hsv} Hue in `[0, 360)`, saturation and value in `[0, 100]`
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * rgbToHsv({ r: 255, g: 0, b: 0 }); // => { h: 0, s: 100, v: 100 }
 * rgbToHsv('#336699'); // => { h: 210, s: 66.66666666666666, v: 60 }
 * rgbToHsv('#000000'); // => { h: 0, s: 0, v: 0 }
 */
export function rgbToHsv(color: ColorInput): Hsv {
	const rgba = toRgba(color);
	const r = rgba.r / 255;
	const g = rgba.g / 255;
	const b = rgba.b / 255;
	const high = Math.max(r, g, b);
	const delta = high - Math.min(r, g, b);
	return { h: hueOf(r, g, b, high, delta), s: high === 0 ? 0 : (delta / high) * 100, v: high * 100 };
}

/**
 * Converts an HSV (HSB) colour to RGB, rounding channels to integers. The hue is normalized into `[0, 360)` (so `-120` and `600` both
 * mean `240`); saturation and value are clamped to `[0, 100]`. Inverse of {@link rgbToHsv}: every 8-bit colour converts back exactly.
 * @param {Hsv} hsv - The colour in HSV
 * @returns {Rgb} The colour in RGB with integer channels in `[0, 255]`
 * @throws {TypeError} when `hsv` is not an object or a component is not a number
 * @throws {RangeError} when a component is `NaN` or the hue is infinite
 * @example
 * hsvToRgb({ h: 0, s: 100, v: 100 }); // => { r: 255, g: 0, b: 0 }
 * hsvToRgb({ h: 210, s: 50, v: 60 }); // => { r: 77, g: 115, b: 153 }
 * hsvToRgb({ h: -120, s: 100, v: 100 }); // => { r: 0, g: 0, b: 255 }
 * hsvToRgb({ h: 120, s: 0, v: 50 }); // => { r: 128, g: 128, b: 128 }
 */
export function hsvToRgb(hsv: Hsv): Rgb {
	if (typeof hsv !== 'object' || hsv === null) throw new TypeError(`hsvToRgb: \`hsv\` must be an { h, s, v } object, got ${describe(hsv)}`);
	const hue = readChannel('hsvToRgb', 'hsv.h', hsv.h);
	if (!Number.isFinite(hue)) throw new RangeError(`hsvToRgb: \`hsv.h\` must be finite, got ${hue}`);
	const h = hue >= 0 && hue < 360 ? hue : modulo(hue, 360);
	// A `-0` saturation or value is harmless: `toByte` never returns `-0`.
	const s = clamp(readChannel('hsvToRgb', 'hsv.s', hsv.s), 0, 100) / 100;
	const v = clamp(readChannel('hsvToRgb', 'hsv.v', hsv.v), 0, 100) / 100;
	return { r: hsvChannel(5, h, s, v), g: hsvChannel(3, h, s, v), b: hsvChannel(1, h, s, v) };
}

/**
 * Computes one RGB channel with the standard `hsvToRgb` formula.
 * @param {number} offset - `5` for red, `3` for green, `1` for blue
 * @param {number} h - The hue in `[0, 360)`
 * @param {number} s - The saturation in `[0, 1]`
 * @param {number} v - The value in `[0, 1]`
 * @returns {number} The channel as an integer in `[0, 255]`
 * @example
 * hsvChannel(5, 0, 1, 1); // => 255
 */
function hsvChannel(offset: number, h: number, s: number, v: number): number {
	// `offset + h / 60` lies in `[0, 11)`: one exact subtraction replaces the (slow, floating-point) `% 6`.
	let k = offset + h / 60;
	if (k >= 6) k -= 6;
	return toByte((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
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
 * Mixes two colours. `weight` is the proportion of `colorB`: `0` gives `colorA`, `1` gives `colorB`, `0.5` the midpoint.
 * (Note: this is the opposite convention from Sass's `mix`, whose weight is the proportion of the first colour.)
 *
 * - `space: 'srgb'` (default): plain linear interpolation of the 8-bit channels and of alpha (no gamma-correct or premultiplied
 *   blending), as in earlier versions.
 * - `space: 'oklab'` / `'oklch'`: interpolation in the perceptual OKLab space, or in its polar form OKLCH (whose hues follow the
 *   `hue` method, `'shorter'` by default), with premultiplied alpha and the result gamut mapped into sRGB: the same colour as CSS
 *   `color-mix(in oklch, colorA, colorB weight)` shows on an sRGB screen (up to 8-bit rounding). A grey's hue is powerless: the
 *   other colour's hue is used, so mixing with white, black or grey never drifts through unrelated hues (except with `hue: 'longer'`,
 *   which then goes a full turn round the hue circle, as in CSS).
 * @param {ColorInput} colorA - The colour at `weight = 0`
 * @param {ColorInput} colorB - The colour at `weight = 1`
 * @param {number} [weight=0.5] - Proportion of `colorB`, in `[0, 1]`
 * @param {MixOptions} [options={}] - `space` (`'srgb'`, `'oklab'` or `'oklch'`) and `hue` (`'shorter'`, `'longer'`, `'increasing'` or `'decreasing'`)
 * @returns {Rgba} The mixed colour (channels rounded to integers, alpha interpolated)
 * @throws {TypeError} when a colour is invalid (see {@link toRgba})
 * @throws {TypeError} when `weight` is not a number
 * @throws {RangeError} when `weight` is not in `[0, 1]`, `space` or `hue` is unknown, or a channel is `NaN`
 * @example
 * mix('#000000', '#ffffff'); // => { r: 128, g: 128, b: 128, a: 1 }
 * mix('#ff0000', '#0000ff', 0.25); // => { r: 191, g: 0, b: 64, a: 1 }
 * mix({ r: 0, g: 0, b: 0, a: 0 }, '#000', 0.5); // => { r: 0, g: 0, b: 0, a: 0.5 }
 * mix('#000000', '#ffffff', 0.5, { space: 'oklab' }); // => { r: 99, g: 99, b: 99, a: 1 } // perceptual mid-grey
 * mix('#0000ff', '#ffff00', 0.5); // => { r: 128, g: 128, b: 128, a: 1 } // sRGB: dull grey
 * mix('#0000ff', '#ffff00', 0.5, { space: 'oklab' }); // => { r: 108, g: 171, b: 199, a: 1 }
 * mix('#0000ff', '#ffff00', 0.5, { space: 'oklch' }); // => { r: 0, g: 189, b: 176, a: 1 } // keeps the chroma
 * mix('#ff0000', 'transparent', 0.5, { space: 'oklch' }); // => { r: 255, g: 0, b: 0, a: 0.5 }
 * mix('#000', '#fff', 0.5, { space: 'lab' as MixSpace }); // throws RangeError
 */
export function mix(colorA: ColorInput, colorB: ColorInput, weight = 0.5, options: MixOptions = {}): Rgba {
	assertNumber('mix', 'weight', weight, weight >= 0 && weight <= 1, 'a number in [0, 1]');
	const [space, hue] = readMixOptions('mix', options);
	return mixRgba(toRgba(colorA), toRgba(colorB), weight, space, hue);
}

/**
 * Reads and validates the {@link MixOptions} for `caller`.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {MixOptions} options - The options
 * @returns {[MixSpace, HueInterpolation]} The space and the hue interpolation method
 * @throws {RangeError} when `space` or `hue` is unknown
 * @example
 * readMixOptions('mix', {}); // => ['srgb', 'shorter']
 */
function readMixOptions(caller: string, options: MixOptions): [MixSpace, HueInterpolation] {
	const space = readOption(options, 'space', 'srgb');
	const hue = readOption(options, 'hue', 'shorter');
	if (space !== 'srgb' && space !== 'oklab' && space !== 'oklch')
		throw new RangeError(`${caller}: \`options.space\` must be 'srgb', 'oklab' or 'oklch', got ${show(space)}`);
	if (hue !== 'shorter' && hue !== 'longer' && hue !== 'increasing' && hue !== 'decreasing') {
		throw new RangeError(`${caller}: \`options.hue\` must be 'shorter', 'longer', 'increasing' or 'decreasing', got ${show(hue)}`);
	}
	return [space, hue];
}

/**
 * Mixes two normalized colours, as {@link mix} does (the arguments are already validated).
 * @param {Rgba} a - The colour at `weight = 0`, normalized by {@link toRgba}
 * @param {Rgba} b - The colour at `weight = 1`, normalized by {@link toRgba}
 * @param {number} weight - Proportion of `b`, in `[0, 1]`
 * @param {MixSpace} space - The interpolation space
 * @param {HueInterpolation} hue - The hue interpolation method
 * @returns {Rgba} A new colour
 * @example
 * mixRgba({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, 0.5, 'srgb', 'shorter'); // => { r: 128, g: 128, b: 128, a: 1 }
 */
function mixRgba(a: Rgba, b: Rgba, weight: number, space: MixSpace, hue: HueInterpolation): Rgba {
	// Clamp to the inputs: `(1 - w) * x + w * y` can overshoot max(x, y) by one ulp.
	const alpha = clamp(lerp(a.a, b.a, weight), Math.min(a.a, b.a), Math.max(a.a, b.a)) + 0;
	const target = { r: 0, g: 0, b: 0, a: alpha };
	if (space === 'srgb') {
		target.r = toByte(lerp(a.r, b.r, weight));
		target.g = toByte(lerp(a.g, b.g, weight));
		target.b = toByte(lerp(a.b, b.b, weight));
		return target;
	}
	// Premultiplied alpha: the components are weighted by each colour's alpha, then divided by the mixed alpha, which comes down to
	// interpolating them at `t` (straight interpolation when both colours are fully transparent).
	const premultipliedA = (1 - weight) * a.a;
	const premultipliedB = weight * b.a;
	const t = premultipliedA + premultipliedB > 0 ? premultipliedB / (premultipliedA + premultipliedB) : weight;
	const labA = oklabOf(a);
	const labB = oklabOf(b);
	const l = lerp(labA[0], labB[0], t);
	if (space === 'oklab') return oklabToBytes(l, lerp(labA[1], labB[1], t), lerp(labA[2], labB[2], t), target);
	const chromaA = Math.hypot(labA[1], labA[2]);
	const chromaB = Math.hypot(labB[1], labB[2]);
	// Hues in [0, 360); a grey's hue is missing and takes the other colour's (both missing: the chroma is 0, any hue will do).
	let hueA = modulo(Math.atan2(labA[2], labA[1]) * DEGREES, 360);
	let hueB = modulo(Math.atan2(labB[2], labB[1]) * DEGREES, 360);
	if (chromaA === 0) hueA = hueB;
	if (chromaB === 0) hueB = hueA;
	const arc = hueB - hueA;
	if (hue === 'shorter' ? arc > 180 : hue === 'longer' ? arc > 0 && arc < 180 : hue === 'decreasing' && arc > 0) hueA += 360;
	else if (hue === 'shorter' ? arc < -180 : hue === 'longer' ? arc <= 0 && arc > -180 : hue === 'increasing' && arc < 0) hueB += 360;
	// The hue is not premultiplied (CSS Color 4): it moves with `weight`.
	return oklchToBytes(l, lerp(chromaA, chromaB, t), lerp(hueA, hueB, weight), target);
}

/**
 * Options accepted by {@link colorScale} and {@link colorSteps}: those of {@link mix} (`space`, `hue`), which interpolates each
 * segment between two consecutive stops, plus the stop positions.
 */
export interface ColorScaleOptions extends MixOptions {
	/**
	 * Positions of the stops: one finite number per stop, strictly increasing (`[0, 0.2, 1]` puts the middle stop at `0.2`); or just
	 * the two ends, the stops being spread evenly between them (`[0, 100]`). Positions outside it clamp to its ends.
	 * @default [0, 1]
	 */
	domain?: readonly number[];
}

/**
 * Builds the interpolating function of {@link colorScale} and {@link colorSteps}.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {readonly ColorInput[]} stops - The colours
 * @param {ColorScaleOptions} options - `space`, `hue` and `domain`
 * @returns {[(t: number) => Rgba, number, number]} The function (for a `t` other than `NaN`), and the ends of the domain
 * @throws {TypeError} when `stops` or `domain` is not an array, a stop is invalid or a position is not a number
 * @throws {RangeError} when `stops` is empty, `space` or `hue` is unknown, or `domain` is not as documented
 * @example
 * scaleOf('colorScale', ['#000', '#fff'], {})[0](0.5); // => { r: 128, g: 128, b: 128, a: 1 }
 */
function scaleOf(caller: string, stops: readonly ColorInput[], options: ColorScaleOptions): [(t: number) => Rgba, number, number] {
	if (!Array.isArray(stops)) throw new TypeError(`${caller}: \`stops\` must be an array of colours, got ${describe(stops)}`);
	if (stops.length === 0) throw new RangeError(`${caller}: \`stops\` must hold at least one colour, got an empty array`);
	const [space, hue] = readMixOptions(caller, options);
	const domain = readOption(options, 'domain');
	// `Array.from`, not `map`: a hole is an invalid (`undefined`) stop, not a skipped one.
	const colors = Array.from(stops, function (stop) {
		return toRgba(stop);
	});
	const last = colors.length - 1;
	let positions: readonly number[] = [0, 1];
	if (domain !== undefined) {
		if (!Array.isArray(domain)) throw new TypeError(`${caller}: \`options.domain\` must be an array of numbers, got ${describe(domain)}`);
		if (domain.length !== 2 && domain.length !== colors.length) {
			throw new RangeError(`${caller}: \`options.domain\` must hold 2 or ${colors.length} positions (one per stop), got ${domain.length}`);
		}
		for (let i = 0; i < domain.length; i++) {
			const position: unknown = domain[i];
			const valid = Number.isFinite(position) && (i === 0 || (position as number) > domain[i - 1]);
			assertNumber(caller, `options.domain[${i}]`, position, valid, i === 0 ? 'a finite number' : `a finite number > options.domain[${i - 1}]`);
		}
		positions = domain.slice();
	}
	const start = positions[0];
	// A single stop makes a constant scale: every `t` clamps to it.
	const end = last === 0 ? start : positions[positions.length - 1];
	if (positions.length !== colors.length) {
		// Two ends for several stops (or the default): spread the stops evenly.
		positions = colors.map(function (_, i) {
			return lerp(start, end, i / last);
		});
	}

	return [
		function (t: number): Rgba {
			if (t <= start) return { ...colors[0] };
			if (t >= end) return { ...colors[last] };
			// Binary search for the segment with `positions[low] <= t < positions[high]`.
			let low = 0;
			let high = last;
			while (high - low > 1) {
				const middle = (low + high) >> 1;
				if (positions[middle] <= t) low = middle;
				else high = middle;
			}
			// Rounding is monotonic, so the weight stays in [0, 1). A span too large for a double (a domain of [-1e308, 1e308]) is halved
			// first: halving such large numbers is exact (unlike subnormal ones, which must not be halved).
			const span = positions[high] - positions[low];
			const weight = span === Infinity ? (t / 2 - positions[low] / 2) / (positions[high] / 2 - positions[low] / 2) : (t - positions[low]) / span;
			return mixRgba(colors[low], colors[high], weight, space, hue);
		},
		start,
		end
	];
}

/**
 * Creates a colour scale (a gradient as a function, like `chroma.scale` or culori's `interpolate`): `scale(t)` interpolates between
 * the two stops around position `t`, with {@link mix} and its options (`space: 'oklab'` or `'oklch'` gives perceptually even
 * gradients without the muddy midpoints of sRGB). The stops are at the `domain` positions: by default spread evenly over `[0, 1]`.
 * A `t` outside the domain clamps to its ends. The stops are parsed once, when the scale is created; every call returns a new object.
 * @param {readonly ColorInput[]} stops - The colours (at least one; a single one makes a constant scale)
 * @param {ColorScaleOptions} [options={}] - `space` (default `'srgb'`), `hue` (default `'shorter'`) and `domain` (default `[0, 1]`)
 * @returns {(t: number) => Rgba} The scale, which throws a `TypeError` when `t` is not a number and a `RangeError` when it is `NaN`
 * @throws {TypeError} when `stops` or `domain` is not an array, a stop is invalid (see {@link toRgba}) or a position is not a number
 * @throws {RangeError} when `stops` is empty, `space` or `hue` is unknown, or `domain` does not hold 2 or `stops.length` finite,
 * strictly increasing positions
 * @example
 * const heat = colorScale(['#0000ff', '#ffffff', '#ff0000']);
 * heat(0); // => { r: 0, g: 0, b: 255, a: 1 }
 * heat(0.25); // => { r: 128, g: 128, b: 255, a: 1 }
 * heat(0.5); // => { r: 255, g: 255, b: 255, a: 1 }
 * heat(2); // => { r: 255, g: 0, b: 0, a: 1 } // clamped
 * const temperature = colorScale(['#0000ff', '#ffffff', '#ff0000'], { domain: [-20, 0, 40] });
 * temperature(20); // => { r: 255, g: 128, b: 128, a: 1 }
 * colorScale(['#0000ff', '#ffff00'], { space: 'oklch' })(0.5); // => { r: 0, g: 189, b: 176, a: 1 }
 * colorScale(['#000', '#fff'], { domain: [1, 0] }); // throws RangeError
 */
export function colorScale(stops: readonly ColorInput[], options: ColorScaleOptions = {}): (t: number) => Rgba {
	const [at] = scaleOf('colorScale', stops, options);
	return function (t: number): Rgba {
		if (typeof t !== 'number' || t !== t) assertNumber('colorScale', 't', t, false, 'a number other than NaN');
		return at(t);
	};
}

/**
 * Samples `count` evenly spaced colours from a colour scale (see {@link colorScale}), both ends of the domain included: a palette
 * for a chart's series or a design system's shades. `count = 1` gives the first stop and `count = 0` an empty array.
 * @param {readonly ColorInput[]} stops - The colours (at least one)
 * @param {number} count - The number of colours, an integer `>= 0`
 * @param {ColorScaleOptions} [options={}] - `space` (default `'srgb'`), `hue` (default `'shorter'`) and `domain` (default `[0, 1]`):
 * the samples are evenly spaced over the domain, so uneven stop positions shape the palette
 * @returns {Rgba[]} The colours, from the start of the domain to its end
 * @throws {TypeError} when `stops` or `domain` is not an array, a stop is invalid (see {@link toRgba}), or `count` or a position is not
 * a number
 * @throws {RangeError} when `count` is not an integer `>= 0`, or as {@link colorScale}
 * @example
 * colorSteps(['#000000', '#ffffff'], 3); // => [{ r: 0, g: 0, b: 0, a: 1 }, { r: 128, g: 128, b: 128, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }]
 * colorSteps(['#000000', '#ffffff'], 3, { space: 'oklab' }).map(function (c) { return toHex(c); }); // => ['#000000', '#636363', '#ffffff']
 * colorSteps(['#ff0000', '#0000ff'], 1); // => [{ r: 255, g: 0, b: 0, a: 1 }]
 * colorSteps(['#ff0000'], 2.5); // throws RangeError
 */
export function colorSteps(stops: readonly ColorInput[], count: number, options: ColorScaleOptions = {}): Rgba[] {
	assertInteger('colorSteps', 'count', count);
	const [at, start, end] = scaleOf('colorSteps', stops, options);
	const colors: Rgba[] = [];
	for (let i = 0; i < count; i++) colors.push(at(lerp(start, end, count > 1 ? i / (count - 1) : 0)));
	return colors;
}

/**
 * Shifts the lightness, saturation and hue of a colour, keeping alpha. In HSL: lightness and saturation by percentage points (clamped
 * to `[0, 100]`), the hue by degrees. In OKLCH: lightness by percentage points (`1` = `100` points), chroma by percentage points of
 * CSS's `100% = 0.4` (a negative chroma counts as `0`), the hue by degrees; the result is gamut mapped.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {ColorInput} color - The colour
 * @param {LightnessOptions} options - `space`
 * @param {number} lightness - Lightness change, in `[-100, 100]`
 * @param {number} saturation - Saturation (chroma) change, in `[-100, 100]`
 * @param {number} hue - Hue rotation in degrees (finite)
 * @returns {Rgba} The adjusted colour
 * @throws {RangeError} when `options.space` is unknown
 * @example
 * adjust('lighten', '#808080', {}, 10, 0, 0); // lighter grey
 */
function adjust(caller: string, color: ColorInput, options: LightnessOptions, lightness: number, saturation: number, hue: number): Rgba {
	const space = readOption(options, 'space', 'hsl');
	if (space !== 'hsl' && space !== 'oklch') throw new RangeError(`${caller}: \`options.space\` must be 'hsl' or 'oklch', got ${show(space)}`);
	const rgba = toRgba(color);
	// `toRgba` returns a fresh object: overwrite its channels, keeping its alpha.
	if (space === 'oklch') {
		// No shortcut is needed for null changes: the OKLCH round trip is exact for every 8-bit colour. A grey has chroma 0 and hue 0.
		const lab = oklabOf(rgba);
		return oklchToBytes(lab[0] + lightness / 100, Math.hypot(lab[1], lab[2]) + saturation * 0.004, Math.atan2(lab[2], lab[1]) * DEGREES + hue, rgba);
	}
	// Nor here: the HSL round trip is exact too.
	const hsl = hslOf(rgba);
	return hslValuesToRgb(hsl.h + hue, hsl.s + saturation, hsl.l + lightness, rgba);
}

/**
 * Makes a colour lighter by adding `amount` percentage points to its lightness: HSL lightness by default (clamped at `100`, white,
 * keeping hue and saturation), or OKLCH lightness with `{ space: 'oklch' }` (`amount / 100` added to `l`, keeping chroma and hue,
 * gamut mapped): equal amounts then look like equal steps whatever the hue, which HSL does not guarantee (yellow and blue at the
 * same HSL lightness look very different). Alpha is kept. `lighten(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Lightness points to add, in `[0, 100]`
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The lighter colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]`, `options.space` is unknown, or a channel is `NaN`
 * @example
 * lighten('#000000', 50); // => { r: 128, g: 128, b: 128, a: 1 }
 * lighten('#ff0000', 20); // => { r: 255, g: 102, b: 102, a: 1 }
 * lighten('#ffffff', 10); // => { r: 255, g: 255, b: 255, a: 1 }
 * lighten('#000000', 50, { space: 'oklch' }); // => { r: 99, g: 99, b: 99, a: 1 }
 * lighten('#0000ff', 20, { space: 'oklch' }); // => { r: 76, g: 134, b: 255, a: 1 }
 */
export function lighten(color: ColorInput, amount: number, options: LightnessOptions = {}): Rgba {
	assertNumber('lighten', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return adjust('lighten', color, options, amount, 0, 0);
}

/**
 * Makes a colour darker by subtracting `amount` percentage points from its lightness: HSL lightness by default (clamped at `0`,
 * black, keeping hue and saturation), or OKLCH lightness with `{ space: 'oklch' }` (see {@link lighten}). Alpha is kept.
 * `darken(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Lightness points to subtract, in `[0, 100]`
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The darker colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]`, `options.space` is unknown, or a channel is `NaN`
 * @example
 * darken('#ffffff', 50); // => { r: 128, g: 128, b: 128, a: 1 }
 * darken('#ff0000', 20); // => { r: 153, g: 0, b: 0, a: 1 }
 * darken('#ffffff', 50, { space: 'oklch' }); // => { r: 99, g: 99, b: 99, a: 1 }
 */
export function darken(color: ColorInput, amount: number, options: LightnessOptions = {}): Rgba {
	assertNumber('darken', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return adjust('darken', color, options, -amount, 0, 0);
}

/**
 * Makes a colour more saturated by adding `amount` percentage points: to its HSL saturation by default (clamped at `100`, keeping hue
 * and lightness, like Sass's `saturate`), or with `{ space: 'oklch' }` to its OKLCH chroma, where `100` points are `0.4` as in CSS
 * percentages (keeping perceived lightness and hue, gamut mapped). Alpha is kept. A grey has no hue: it is tinted towards hue `0`
 * (red in HSL, pink in OKLCH). `saturate(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Saturation points to add, in `[0, 100]`
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The more saturated colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]`, `options.space` is unknown, or a channel is `NaN`
 * @example
 * saturate('#996666', 20); // => { r: 179, g: 77, b: 77, a: 1 }
 * saturate('#ff0000', 50); // => { r: 255, g: 0, b: 0, a: 1 } // already fully saturated
 * saturate('#996666', 5, { space: 'oklch' }); // => { r: 162, g: 96, b: 97, a: 1 }
 */
export function saturate(color: ColorInput, amount: number, options: LightnessOptions = {}): Rgba {
	assertNumber('saturate', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return adjust('saturate', color, options, 0, amount, 0);
}

/**
 * Makes a colour less saturated by subtracting `amount` percentage points: from its HSL saturation by default (clamped at `0`, grey,
 * keeping hue and lightness, like Sass's `desaturate`), or with `{ space: 'oklch' }` from its OKLCH chroma (`100` points are `0.4`,
 * clamped at `0`, keeping perceived lightness and hue). Alpha is kept. `desaturate(color, 0)` returns the (normalized) colour unchanged.
 * @param {ColorInput} color - The colour
 * @param {number} amount - Saturation points to subtract, in `[0, 100]`
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The less saturated colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `amount` is not a number
 * @throws {RangeError} when `amount` is not in `[0, 100]`, `options.space` is unknown, or a channel is `NaN`
 * @example
 * desaturate('#ff0000', 50); // => { r: 191, g: 64, b: 64, a: 1 }
 * desaturate('#ff0000', 100); // => { r: 128, g: 128, b: 128, a: 1 }
 * desaturate('#ff0000', 25, { space: 'oklch' }); // => { r: 215, g: 92, b: 77, a: 1 }
 */
export function desaturate(color: ColorInput, amount: number, options: LightnessOptions = {}): Rgba {
	assertNumber('desaturate', 'amount', amount, amount >= 0 && amount <= 100, 'a number in [0, 100]');
	return adjust('desaturate', color, options, 0, -amount, 0);
}

/**
 * Turns a colour into the grey of the same lightness (same as `desaturate(color, 100, options)`): HSL lightness by default (Sass's
 * `grayscale`: `#ff0000` and `#0000ff` both give `#808080`), or with `{ space: 'oklch' }` perceived lightness (chroma `0`, so yellow
 * gives a light grey and blue a dark one, as they look). Alpha is kept.
 * @param {ColorInput} color - The colour
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The grey
 * @throws {TypeError} when `color` is invalid (see {@link toRgba})
 * @throws {RangeError} when `options.space` is unknown, or a channel is `NaN`
 * @example
 * grayscale('#ff0000'); // => { r: 128, g: 128, b: 128, a: 1 }
 * grayscale('#ffff00', { space: 'oklch' }); // => { r: 244, g: 244, b: 244, a: 1 }
 * grayscale('#0000ff', { space: 'oklch' }); // => { r: 86, g: 86, b: 86, a: 1 }
 */
export function grayscale(color: ColorInput, options: LightnessOptions = {}): Rgba {
	return adjust('grayscale', color, options, 0, -100, 0);
}

/**
 * Rotates the hue of a colour by `degrees` (any finite angle, negative included; it wraps around): the HSL hue by default (keeping
 * saturation and lightness), or with `{ space: 'oklch' }` the OKLCH hue (keeping perceived lightness and chroma, gamut mapped, so the
 * rotated colours look equally light, which HSL does not guarantee). Greys are unchanged. Alpha is kept.
 * @param {ColorInput} color - The colour
 * @param {number} degrees - The rotation, in degrees
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The rotated colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba}), or `degrees` is not a number
 * @throws {RangeError} when `degrees` is not finite, `options.space` is unknown, or a channel is `NaN`
 * @example
 * rotateHue('#ff0000', 120); // => { r: 0, g: 255, b: 0, a: 1 }
 * rotateHue('#ff0000', -120); // => { r: 0, g: 0, b: 255, a: 1 }
 * rotateHue('#ff0000', 120, { space: 'oklch' }); // => { r: 0, g: 168, b: 54, a: 1 } // as light as the red
 * rotateHue('#808080', 90); // => { r: 128, g: 128, b: 128, a: 1 }
 */
export function rotateHue(color: ColorInput, degrees: number, options: LightnessOptions = {}): Rgba {
	assertNumber('rotateHue', 'degrees', degrees, Number.isFinite(degrees), 'a finite number');
	return adjust('rotateHue', color, options, 0, 0, degrees);
}

/**
 * Returns the complementary colour: the hue rotated by 180° (see {@link rotateHue}), in HSL by default (as Sass's `complement`) or in
 * OKLCH with `{ space: 'oklch' }` (the perceptual opposite, as light as the colour). Greys are unchanged. Alpha is kept.
 * @param {ColorInput} color - The colour
 * @param {LightnessOptions} [options={}] - `space`: `'hsl'` (default) or `'oklch'`
 * @returns {Rgba} The complementary colour
 * @throws {TypeError} when `color` is invalid (see {@link toRgba})
 * @throws {RangeError} when `options.space` is unknown, or a channel is `NaN`
 * @example
 * complement('#ff0000'); // => { r: 0, g: 255, b: 255, a: 1 }
 * complement('#336699'); // => { r: 153, g: 102, b: 51, a: 1 }
 * complement({ r: 255, g: 0, b: 0, a: 0.5 }, { space: 'oklch' }); // => { r: 0, g: 156, b: 178, a: 0.5 }
 */
export function complement(color: ColorInput, options: LightnessOptions = {}): Rgba {
	return adjust('complement', color, options, 0, 0, 180);
}

/**
 * Converts a colour to OKLab (see {@link Oklab}). Greys get exactly `a = b = 0`.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {Required<Oklab>} The colour in OKLab, with its alpha
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toOklab('#ffffff'); // => { l: 1, a: 0, b: 0, alpha: 1 }
 * toOklab('#000000'); // => { l: 0, a: 0, b: 0, alpha: 1 }
 * const red = toOklab('#ff0000');
 * [red.l.toFixed(4), red.a.toFixed(4), red.b.toFixed(4)]; // => ['0.6280', '0.2249', '0.1258']
 */
export function toOklab(color: ColorInput): Required<Oklab> {
	const rgba = toRgba(color);
	const lab = oklabOf(rgba);
	return { l: lab[0], a: lab[1], b: lab[2], alpha: rgba.a };
}

/**
 * Converts a colour to OKLCH (see {@link Oklch}). Greys get chroma `0` and a powerless hue, `NaN` (written `none` in CSS; `null`
 * once through `JSON.stringify`, which {@link oklchToRgb} accepts too). Converting back with {@link oklchToRgb} gives the same 8-bit
 * colour.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {Required<Oklch>} The colour in OKLCH, with its alpha
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * const red = toOklch('#ff0000');
 * [red.l.toFixed(4), red.c.toFixed(4), red.h.toFixed(2)]; // => ['0.6280', '0.2577', '29.23'] // CSS Color 4 reference values
 * toOklch('#808080').h; // => NaN // a grey: powerless hue
 * oklchToRgb(toOklch('#bada55')); // => { r: 186, g: 218, b: 85, a: 1 }
 */
export function toOklch(color: ColorInput): Required<Oklch> {
	const rgba = toRgba(color);
	const lab = oklabOf(rgba);
	const c = Math.hypot(lab[1], lab[2]);
	return { l: lab[0], c, h: c === 0 ? NaN : modulo(Math.atan2(lab[2], lab[1]) * DEGREES, 360), alpha: rgba.a };
}

/**
 * Reads and validates an OKLCH object for `caller`.
 * @param {string} caller - Name of the public function, used in error messages
 * @param {OklchInput} oklch - The colour
 * @returns {number[]} `[l, c, h, alpha]`, with a powerless (`NaN`, `null` or missing) hue read as `0`
 * @throws {TypeError} when `oklch` is not an object or a component is not a number
 * @throws {RangeError} when `l` or `c` is `NaN`, or the hue is infinite
 * @example
 * readOklch('inGamut', { l: 0.5, c: 0, h: NaN }); // => [0.5, 0, 0, 1]
 */
function readOklch(caller: string, oklch: OklchInput): number[] {
	if (typeof oklch !== 'object' || oklch === null) throw new TypeError(`${caller}: \`oklch\` must be an { l, c, h } object, got ${describe(oklch)}`);
	const l = readChannel(caller, 'oklch.l', readOption(oklch, 'l'));
	const c = readChannel(caller, 'oklch.c', readOption(oklch, 'c'));
	const h = (readOption(oklch, 'h') as number | null | undefined) ?? NaN;
	assertNumber(caller, 'oklch.h', h, Number.isFinite(h) || Number.isNaN(h), 'a finite number, NaN, null or undefined');
	return [l, c, Number.isNaN(h) ? 0 : h, readAlpha(caller, 'oklch.alpha', readOption(oklch, 'alpha'))];
}

/**
 * Converts an OKLCH colour to sRGB. Colours outside the sRGB gamut are mapped into it with the CSS Color 4 gamut mapping algorithm
 * (what browsers do with `oklch()` on sRGB screens): lightness `>= 1` gives white and `<= 0` black; otherwise the chroma is reduced,
 * keeping lightness and hue, until clipping changes the colour by less than a just noticeable difference (deltaEOK `0.02`). Plain
 * clipping instead shifts hue and lightness (it turns `oklch(0.9 0.4 145)` into a darker `#00ff00`, of hue `142.5`). Out-of-range components are
 * accepted: a negative chroma counts as `0` (as in CSS), and a powerless hue (`NaN`, `null` or missing) as `0`.
 * @param {OklchInput} oklch - The colour (`alpha` defaults to `1` and is clamped to `[0, 1]`)
 * @returns {Rgba} The colour in sRGB, with integer channels in `[0, 255]`
 * @throws {TypeError} when `oklch` is not an object or a component is not a number
 * @throws {RangeError} when `l` or `c` is `NaN`, or the hue is infinite
 * @example
 * oklchToRgb({ l: 0.627955, c: 0.257683, h: 29.2339 }); // => { r: 255, g: 0, b: 0, a: 1 }
 * oklchToRgb({ l: 0.5, c: 0, h: NaN, alpha: 0.5 }); // => { r: 99, g: 99, b: 99, a: 0.5 }
 * oklchToRgb(JSON.parse(JSON.stringify(toOklch('#808080')))); // => { r: 128, g: 128, b: 128, a: 1 } // h: null
 * oklchToRgb({ l: 0.5, c: 0 }); // => { r: 99, g: 99, b: 99, a: 1 }
 * oklchToRgb({ l: 0.9, c: 0.4, h: 145 }); // => { r: 83, g: 255, b: 105, a: 1 } // gamut mapped
 * oklchToRgb({ l: 1.2, c: 0.1, h: 0 }); // => { r: 255, g: 255, b: 255, a: 1 }
 */
export function oklchToRgb(oklch: OklchInput): Rgba {
	const [l, c, h, alpha] = readOklch('oklchToRgb', oklch);
	return oklchToBytes(l, c, h, { r: 0, g: 0, b: 0, a: alpha });
}

/**
 * Converts an OKLab colour to sRGB, with the same gamut mapping as {@link oklchToRgb}.
 * @param {Oklab} oklab - The colour (`alpha` defaults to `1` and is clamped to `[0, 1]`)
 * @returns {Rgba} The colour in sRGB, with integer channels in `[0, 255]`
 * @throws {TypeError} when `oklab` is not an object or a component is not a number
 * @throws {RangeError} when a component is `NaN`
 * @example
 * oklabToRgb({ l: 1, a: 0, b: 0 }); // => { r: 255, g: 255, b: 255, a: 1 }
 * oklabToRgb(toOklab('#bada55')); // => { r: 186, g: 218, b: 85, a: 1 }
 */
export function oklabToRgb(oklab: Oklab): Rgba {
	if (typeof oklab !== 'object' || oklab === null) throw new TypeError(`oklabToRgb: \`oklab\` must be an { l, a, b } object, got ${describe(oklab)}`);
	const l = readChannel('oklabToRgb', 'oklab.l', readOption(oklab, 'l'));
	const a = readChannel('oklabToRgb', 'oklab.a', readOption(oklab, 'a'));
	const b = readChannel('oklabToRgb', 'oklab.b', readOption(oklab, 'b'));
	return oklabToBytes(l, a, b, { r: 0, g: 0, b: 0, a: readAlpha('oklabToRgb', 'oklab.alpha', readOption(oklab, 'alpha')) });
}

/**
 * Tells whether an OKLCH colour lies inside the sRGB gamut (within a tolerance of `0.000075` per channel, which absorbs rounding),
 * i.e. whether {@link oklchToRgb} can show it without gamut mapping. A negative chroma counts as `0` and a powerless hue as `0`.
 * @param {OklchInput} oklch - The colour (alpha is ignored)
 * @returns {boolean} `true` when the colour is displayable in sRGB as is
 * @throws {TypeError} when `oklch` is not an object or a component is not a number
 * @throws {RangeError} when `l` or `c` is `NaN`, or the hue is infinite
 * @example
 * inGamut({ l: 0.627955, c: 0.257683, h: 29.2339 }); // => true // #ff0000
 * inGamut({ l: 0.7, c: 0.3, h: 145 }); // => false
 * inGamut(toOklch('#bada55')); // => true
 */
export function inGamut(oklch: OklchInput): boolean {
	const [l, c, h] = readOklch('inGamut', oklch);
	const radians = (h % 360) / DEGREES;
	const chroma = c > 0 ? Math.min(c, MAX_CHROMA) : 0;
	return isInside(oklabToSrgb(l, chroma * Math.cos(radians), chroma * Math.sin(radians)));
}

/**
 * Formats a colour as a CSS `oklch()` string: `'oklch(l c h)'`, or `'oklch(l c h / a)'` for translucent colours. Lightness is
 * rounded to 4 decimals, chroma to 5 and the hue to 2, which is enough for every 8-bit colour to convert back to exactly the same
 * channels (`parseColor(toCssOklch(c))` round-trips); greys get the hue `none`. Alpha is rounded to 3 decimals and omitted when it
 * rounds to `1`.
 * @param {ColorInput} color - The colour (channels are clamped and rounded first, see {@link toRgba})
 * @returns {string} The CSS colour string
 * @throws {TypeError} when `color` is not a valid colour (see {@link toRgba})
 * @throws {RangeError} when a channel is `NaN`
 * @example
 * toCssOklch('#ff0000'); // => 'oklch(0.628 0.25768 29.23)'
 * toCssOklch('#808080'); // => 'oklch(0.5999 0 none)'
 * toCssOklch({ r: 0, g: 0, b: 255, a: 0.5 }); // => 'oklch(0.452 0.31321 264.05 / 0.5)'
 */
export function toCssOklch(color: ColorInput): string {
	const { l, c, h, alpha } = toOklch(color);
	// A hue that rounds up to 360 is written 0.
	return `oklch(${round(l, 4)} ${round(c, 5)} ${Number.isNaN(h) ? 'none' : round(h, 2) % 360}${cssAlpha(alpha)})`;
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
	const light = readOption(options, 'light') ?? '#ffffff';
	const dark = readOption(options, 'dark') ?? '#000000';
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
	const level = readOption(options, 'level', 'AA');
	const largeText = readOption(options, 'largeText', false);
	if (level !== 'AA' && level !== 'AAA') throw new RangeError(`meetsContrast: \`level\` must be 'AA' or 'AAA', got ${show(level)}`);
	const threshold = level === 'AA' ? (largeText ? 3 : 4.5) : largeText ? 4.5 : 7;
	return contrastRatio(foreground, background) >= threshold;
}
