import { colorFromString, contrastRatio, deltaE, hslToRgb, lighten, mix, parseColor, parseHex, rgbToHsl, simulateColorVisionDeficiency, toCssRgb, toHex } from 'tinkit/color';

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

// Hand-written baselines for deltaE, colorFromString and simulateColorVisionDeficiency: the textbook code (arrays per step,
// `Math.pow`, `TextEncoder`), without validation, gamut mapping or CSS parsing beyond `#rrggbb`.
const names = Array.from({ length: 1000 }, function (_, index) {
	return `user-${index}@example.com`;
});

/**
 * Multiplies a 3×3 matrix (array of rows) by a vector.
 * @param {number[][]} matrix - The matrix
 * @param {number[]} vector - The vector
 * @returns {number[]} The product
 */
function naiveMultiply(matrix, vector) {
	return matrix.map(function (row) {
		return row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2];
	});
}

/**
 * Hand-written `#rrggbb` to linear-light sRGB.
 * @param {string} hex - The colour
 * @returns {number[]} The linear channels
 */
function naiveLinearRgb(hex) {
	const { r, g, b } = naiveParseHex(hex);
	return [r, g, b].map(naiveLinear);
}

const NAIVE_LMS = [
	[0.4122214708, 0.5363325363, 0.0514459929],
	[0.2119034982, 0.6806995451, 0.1073969566],
	[0.0883024619, 0.2817188376, 0.6299787005]
];
const NAIVE_OKLAB = [
	[0.2104542553, 0.793617785, -0.0040720468],
	[1.9779984951, -2.428592205, 0.4505937099],
	[0.0259040371, 0.7827717662, -0.808675766]
];

/**
 * Hand-written hex to OKLab (Ottosson's reference code).
 * @param {string} hex - The colour
 * @returns {number[]} `[l, a, b]`
 */
function naiveOklab(hex) {
	return naiveMultiply(NAIVE_OKLAB, naiveMultiply(NAIVE_LMS, naiveLinearRgb(hex)).map(Math.cbrt));
}

const NAIVE_XYZ = [
	[0.41239079926595934, 0.357584339383878, 0.1804807884018343],
	[0.21263900587151027, 0.715168678767756, 0.07219231536073371],
	[0.01933081871559182, 0.11919477979462598, 0.9505321522496607]
];
const NAIVE_BRADFORD = [
	[1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
	[0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
	[-0.009243040646204504, 0.015055191490298152, 0.7518742814281371]
];
const NAIVE_D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

/**
 * Hand-written hex to CIELAB D50 (the CSS Color 4 sample code).
 * @param {string} hex - The colour
 * @returns {number[]} `[l, a, b]`
 */
function naiveLab(hex) {
	const f = naiveMultiply(NAIVE_BRADFORD, naiveMultiply(NAIVE_XYZ, naiveLinearRgb(hex))).map(function (value, index) {
		const relative = value / NAIVE_D50[index];
		return relative > 216 / 24389 ? Math.cbrt(relative) : ((24389 / 27) * relative + 16) / 116;
	});
	return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/**
 * Hand-written CIEDE2000 (Sharma et al.'s reference code, in degrees).
 * @param {number[]} first - `[l, a, b]`
 * @param {number[]} second - `[l, a, b]`
 * @returns {number} ΔE00
 */
function naiveCiede2000(first, second) {
	const rad = Math.PI / 180;
	const mean = (Math.hypot(first[1], first[2]) + Math.hypot(second[1], second[2])) / 2;
	const g = 0.5 * (1 - Math.sqrt(Math.pow(mean, 7) / (Math.pow(mean, 7) + Math.pow(25, 7))));
	const a1 = (1 + g) * first[1];
	const a2 = (1 + g) * second[1];
	const c1 = Math.hypot(a1, first[2]);
	const c2 = Math.hypot(a2, second[2]);
	const h1 = (Math.atan2(first[2], a1) / rad + 360) % 360;
	const h2 = (Math.atan2(second[2], a2) / rad + 360) % 360;
	let dh = h2 - h1;
	if (dh > 180) dh -= 360;
	else if (dh < -180) dh += 360;
	const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
	const lp = (first[0] + second[0]) / 2;
	const cp = (c1 + c2) / 2;
	let hp = (h1 + h2) / 2;
	if (Math.abs(h1 - h2) > 180) hp += hp < 180 ? 180 : -180;
	const t = 1 - 0.17 * Math.cos((hp - 30) * rad) + 0.24 * Math.cos(2 * hp * rad) + 0.32 * Math.cos((3 * hp + 6) * rad) - 0.2 * Math.cos((4 * hp - 63) * rad);
	const sl = 1 + (0.015 * Math.pow(lp - 50, 2)) / Math.sqrt(20 + Math.pow(lp - 50, 2));
	const sc = 1 + 0.045 * cp;
	const sh = 1 + 0.015 * cp * t;
	const rt = -2 * Math.sqrt(Math.pow(cp, 7) / (Math.pow(cp, 7) + Math.pow(25, 7))) * Math.sin(60 * Math.exp(-Math.pow((hp - 275) / 25, 2)) * rad);
	const dl = (second[0] - first[0]) / sl;
	const dc = (c2 - c1) / sc;
	const dhs = dH / sh;
	return Math.sqrt(dl * dl + dc * dc + dhs * dhs + rt * dc * dhs);
}

/**
 * Hand-written string colour: FNV-1a over `TextEncoder` bytes, the hue into `hsl(h 65% 55%)` (what most avatar snippets do).
 * @param {string} text - The string
 * @returns {string} A `#rrggbb` colour
 */
function naiveColorFromString(text) {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 16777619);
	return naiveToHex(naiveHslToRgb({ h: (hash >>> 0) % 360, s: 65, l: 55 }));
}

const NAIVE_DEUTERANOPIA = [
	[0.367322, 0.860646, -0.227968],
	[0.280085, 0.672501, 0.047413],
	[-0.01182, 0.04294, 0.968881]
];

/**
 * Hand-written deuteranopia simulation: Machado's matrix in linear sRGB, clipped and encoded back.
 * @param {string} hex - The colour
 * @returns {{ r: number, g: number, b: number }} The simulated colour
 */
function naiveDeuteranopia(hex) {
	const [r, g, b] = naiveMultiply(NAIVE_DEUTERANOPIA, naiveLinearRgb(hex)).map(function (value) {
		const clipped = Math.min(Math.max(value, 0), 1);
		return Math.round((clipped <= 0.0031308 ? clipped * 12.92 : 1.055 * Math.pow(clipped, 1 / 2.4) - 0.055) * 255);
	});
	return { r, g, b };
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
	},
	{
		name: 'deltaE ok (1000 hex pairs)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += deltaE(hexes[i], hexes[(i + 1) % hexes.length]);
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) {
					const a = naiveOklab(hexes[i]);
					const b = naiveOklab(hexes[(i + 1) % hexes.length]);
					total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
				}
				return total;
			}
		}
	},
	{
		name: 'deltaE 2000 (1000 hex pairs)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += deltaE(hexes[i], hexes[(i + 1) % hexes.length], { method: '2000' });
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) total += naiveCiede2000(naiveLab(hexes[i]), naiveLab(hexes[(i + 1) % hexes.length]));
				return total;
			}
		}
	},
	{
		name: 'colorFromString (1000 e-mails)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < names.length; i++) length += colorFromString(names[i]).length;
			return length;
		},
		competitors: {
			'hand-written (HSL, no gamut mapping)': function () {
				let length = 0;
				for (let i = 0; i < names.length; i++) length += naiveColorFromString(names[i]).length;
				return length;
			}
		}
	},
	{
		name: 'colorFromString with contrastWith (1000 e-mails)',
		fn: function () {
			let length = 0;
			for (let i = 0; i < names.length; i++) length += colorFromString(names[i], { contrastWith: '#ffffff' }).length;
			return length;
		}
	},
	{
		name: 'simulateColorVisionDeficiency deuteranopia (1000 hexes)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < hexes.length; i++) total += simulateColorVisionDeficiency(hexes[i], 'deuteranopia').r;
			return total;
		},
		competitors: {
			'hand-written': function () {
				let total = 0;
				for (let i = 0; i < hexes.length; i++) total += naiveDeuteranopia(hexes[i]).r;
				return total;
			}
		}
	}
];
