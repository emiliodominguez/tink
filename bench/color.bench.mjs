import { contrastRatio, hslToRgb, lighten, mix, parseColor, parseHex, rgbToHsl, toCssRgb, toHex } from 'tinkit/color';

// No colour library is installed as a competitor: the `hand-written` implementations below are the straightforward
// code one would write inline (no validation, no CSS Color 4 syntax, no alpha), i.e. a lower bound for the work.

// 1000 deterministic colours in the formats seen in real stylesheets.
const rgbs = Array.from({ length: 1000 }, function (_, index) {
	return { r: (index * 37) % 256, g: (index * 101) % 256, b: (index * 193) % 256 };
});
const hexes = rgbs.map(function ({ r, g, b }) {
	return `#${[r, g, b]
		.map(function (channel) {
			return channel.toString(16).padStart(2, '0');
		})
		.join('')}`;
});
const shortHexes = hexes.map(function (hex) {
	return `#${hex[1]}${hex[3]}${hex[5]}`;
});
const rgbStrings = rgbs.map(function ({ r, g, b }) {
	return `rgba(${r}, ${g}, ${b}, 0.5)`;
});
const functions = rgbs.map(function ({ r, g, b }, index) {
	return index % 2 === 0 ? `rgba(${r}, ${g}, ${b}, 0.5)` : `hsl(${index % 360}deg ${index % 101}% ${(index * 7) % 101}%)`;
});
const hsls = rgbs.map(function (_, index) {
	return { h: (index * 13) % 360, s: index % 101, l: (index * 7) % 101 };
});

/**
 * Hand-written `#rrggbb` parser.
 * @param {string} hex - A 7-character hex colour
 * @returns {{ r: number, g: number, b: number }} The channels
 */
function naiveParseHex(hex) {
	return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

/**
 * Hand-written `#rgb` parser.
 * @param {string} hex - A 4-character hex colour
 * @returns {{ r: number, g: number, b: number }} The channels
 */
function naiveParseShortHex(hex) {
	return { r: parseInt(hex[1] + hex[1], 16), g: parseInt(hex[2] + hex[2], 16), b: parseInt(hex[3] + hex[3], 16) };
}

const NAIVE_RGBA = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

/**
 * Hand-written legacy `rgba(r, g, b, a)` parser.
 * @param {string} text - The CSS colour
 * @returns {{ r: number, g: number, b: number, a: number }} The channels
 */
function naiveParseRgba(text) {
	const match = NAIVE_RGBA.exec(text);
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

/**
 * Hand-written `{ r, g, b }` to `#rrggbb`.
 * @param {{ r: number, g: number, b: number }} color - The colour
 * @returns {string} The hex string
 */
function naiveToHex(color) {
	return `#${((1 << 24) | (color.r << 16) | (color.g << 8) | color.b).toString(16).slice(1)}`;
}

/**
 * Hand-written `{ r, g, b }` to `rgb(r g b)`.
 * @param {{ r: number, g: number, b: number }} color - The colour
 * @returns {string} The CSS string
 */
function naiveCssRgb(color) {
	return `rgb(${color.r} ${color.g} ${color.b})`;
}

/**
 * Hand-written sRGB channel linearisation.
 * @param {number} channel - A channel in `0..255`
 * @returns {number} The linear value
 */
function naiveLinear(channel) {
	const unit = channel / 255;
	return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
}

/**
 * Hand-written WCAG contrast ratio of two hex colours.
 * @param {string} first - A `#rrggbb` colour
 * @param {string} second - A `#rrggbb` colour
 * @returns {number} The ratio
 */
function naiveContrast(first, second) {
	const a = naiveParseHex(first);
	const b = naiveParseHex(second);
	const la = 0.2126 * naiveLinear(a.r) + 0.7152 * naiveLinear(a.g) + 0.0722 * naiveLinear(a.b);
	const lb = 0.2126 * naiveLinear(b.r) + 0.7152 * naiveLinear(b.g) + 0.0722 * naiveLinear(b.b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Hand-written RGB to HSL.
 * @param {{ r: number, g: number, b: number }} color - The colour
 * @returns {{ h: number, s: number, l: number }} The HSL colour
 */
function naiveRgbToHsl(color) {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l: l * 100 };
	const s = d / (1 - Math.abs(2 * l - 1));
	let h;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	h *= 60;
	return { h: h < 0 ? h + 360 : h, s: s * 100, l: l * 100 };
}

/**
 * Hand-written HSL to RGB.
 * @param {{ h: number, s: number, l: number }} hsl - The colour
 * @returns {{ r: number, g: number, b: number }} The RGB colour
 */
function naiveHslToRgb(hsl) {
	const s = hsl.s / 100;
	const l = hsl.l / 100;
	const a = s * Math.min(l, 1 - l);
	/**
	 * One channel of the CSS Color 4 formula.
	 * @param {number} n - The channel offset
	 * @returns {number} The channel
	 */
	function f(n) {
		const k = (n + hsl.h / 30) % 12;
		return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
	}
	return { r: f(0), g: f(8), b: f(4) };
}

export default [
	{
		name: 'parseHex (1000 × #rrggbb)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += parseHex(hexes[i]).r;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) total += naiveParseHex(hexes[i]).r;
				return total;
			}
		}
	},
	{
		name: 'parseColor (1000 × #rgb)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < shortHexes.length; i++) total += parseColor(shortHexes[i]).g;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < shortHexes.length; i++) total += naiveParseShortHex(shortHexes[i]).g;
				return total;
			}
		}
	},
	{
		name: 'parseColor (1000 × rgba(r, g, b, a))',
		fn: function () {
			let total = 0;
			for (let i = 0; i < rgbStrings.length; i++) total += parseColor(rgbStrings[i]).b;
			return total;
		},
		competitors: {
			'hand-written regex': function () {
				let total = 0;
				for (let i = 0; i < rgbStrings.length; i++) total += naiveParseRgba(rgbStrings[i]).b;
				return total;
			}
		}
	},
	{
		name: 'parseColor (1000 × rgba()/hsl() mixed)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < functions.length; i++) total += parseColor(functions[i]).b;
			return total;
		}
	},
	{
		name: 'toHex (1000 objects)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < rgbs.length; i++) length += toHex(rgbs[i]).length;
			return length;
		},
		competitors: {
			'hand-written': function () {
				let length = 0;
				for (let i = 0; i < rgbs.length; i++) length += naiveToHex(rgbs[i]).length;
				return length;
			}
		}
	},
	{
		name: 'toCssRgb (1000 objects)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < rgbs.length; i++) length += toCssRgb(rgbs[i]).length;
			return length;
		},
		competitors: {
			'hand-written': function () {
				let length = 0;
				for (let i = 0; i < rgbs.length; i++) length += naiveCssRgb(rgbs[i]).length;
				return length;
			}
		}
	},
	{
		name: 'contrastRatio (1000 hex pairs)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += contrastRatio(hexes[i], '#ffffff');
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) total += naiveContrast(hexes[i], '#ffffff');
				return total;
			}
		}
	},
	{
		name: 'rgbToHsl (1000)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < rgbs.length; i++) total += rgbToHsl(rgbs[i]).h;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < rgbs.length; i++) total += naiveRgbToHsl(rgbs[i]).h;
				return total;
			}
		}
	},
	{
		name: 'hslToRgb (1000)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hsls.length; i++) total += hslToRgb(hsls[i]).r;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hsls.length; i++) total += naiveHslToRgb(hsls[i]).r;
				return total;
			}
		}
	},
	{
		name: 'mix (1000 hex pairs)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += mix(hexes[i], '#000000', 0.3).r;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) {
					const a = naiveParseHex(hexes[i]);
					const b = naiveParseHex('#000000');
					const mixed = { r: Math.round(a.r + (b.r - a.r) * 0.3), g: Math.round(a.g + (b.g - a.g) * 0.3), b: Math.round(a.b + (b.b - a.b) * 0.3), a: 1 };
					total += mixed.r;
				}
				return total;
			}
		}
	},
	{
		name: 'lighten (1000 hexes)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += lighten(hexes[i], 10).r;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) {
					const hsl = naiveRgbToHsl(naiveParseHex(hexes[i]));
					total += naiveHslToRgb({ h: hsl.h, s: hsl.s, l: Math.min(100, hsl.l + 10) }).r;
				}
				return total;
			}
		}
	}
];
