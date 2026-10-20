import fc from 'fast-check';
import * as helpers from '.';

const byte = fc.integer({ min: 0, max: 255 });
const rgb = fc.record({ r: byte, g: byte, b: byte });
const rgba = fc.record({
	r: byte,
	g: byte,
	b: byte,
	a: byte.map(function (value) {
		return value / 255;
	})
});
const weight = fc.double({ min: 0, max: 1, noNaN: true });
const amount = fc.double({ min: 0, max: 100, noNaN: true });
const channelName = fc.constantFrom<'r' | 'g' | 'b'>('r', 'g', 'b');
/** Colours with 8-bit channels and an alpha in 0.01 steps. */
const cssRgba = fc.record({
	r: byte,
	g: byte,
	b: byte,
	a: fc.integer({ min: 0, max: 100 }).map(function (value) {
		return value / 100;
	})
});
/** Optional CSS whitespace. */
const space = fc.constantFrom('', ' ', '  ', '\t', '\n');

/**
 * Checks that a value is a normalized Rgba colour: integer channels in [0, 255] and an alpha in [0, 1].
 */
function expectNormalized(color: helpers.Rgba): void {
	for (const channel of [color.r, color.g, color.b]) {
		expect(Number.isInteger(channel) && channel >= 0 && channel <= 255).toBe(true);
	}
	expect(color.a >= 0 && color.a <= 1).toBe(true);
}

describe('Color helpers (property-based)', function () {
	describe('parseHex / toHex', function () {
		it('parseHex(toHex(c)) should round-trip colours with 8-bit channels', function () {
			fc.assert(
				fc.property(rgba, function (color) {
					expect(helpers.parseHex(helpers.toHex(color, { alpha: true }))).toEqual(color);
					expect(helpers.parseHex(helpers.toHex(color))).toEqual(helpers.toHex(color).length === 7 ? { ...color, a: 1 } : color);
				})
			);
		});

		it('toHex(parseHex(s)) should give back the lowercase 8-digit form', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^[0-9a-fA-F]{8}$/), fc.boolean(), function (digits, withHash) {
					expect(helpers.toHex(helpers.parseHex(withHash ? `#${digits}` : digits), { alpha: true })).toBe(`#${digits.toLowerCase()}`);
				})
			);
		});

		it('should equal a per-channel parseInt reference for every digit count', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/), function (digits) {
					const size = digits.length <= 4 ? 1 : 2;
					function channel(index: number): number {
						return parseInt(digits.slice(index * size, (index + 1) * size).repeat(3 - size), 16);
					}
					const alpha = digits.length === 4 || digits.length === 8 ? channel(3) / 255 : 1;
					expect(helpers.parseHex(digits)).toEqual({ r: channel(0), g: channel(1), b: channel(2), a: alpha });
				})
			);
		});

		it('short forms should equal their doubled long forms', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^[0-9a-f]{3,4}$/), function (digits) {
					const doubled = digits
						.split('')
						.map(function (digit) {
							return digit + digit;
						})
						.join('');
					expect(helpers.parseHex(digits)).toEqual(helpers.parseHex(doubled));
				})
			);
		});

		it('toHex should always produce a valid lowercase hex colour, even for out-of-range channels', function () {
			fc.assert(
				fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.double({ noNaN: true }), function (r, g, b, a) {
					expect(helpers.toHex({ r, g, b, a })).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
				})
			);
		});
	});

	describe('rgbToHsl / hslToRgb', function () {
		it('hslToRgb(rgbToHsl(c)) should round-trip within ±1 per channel', function () {
			fc.assert(
				fc.property(rgb, function (color) {
					const back = helpers.hslToRgb(helpers.rgbToHsl(color));
					expect(Math.abs(back.r - color.r)).toBeLessThanOrEqual(1);
					expect(Math.abs(back.g - color.g)).toBeLessThanOrEqual(1);
					expect(Math.abs(back.b - color.b)).toBeLessThanOrEqual(1);
				})
			);
		});

		it('rgbToHsl should stay within its documented ranges', function () {
			fc.assert(
				fc.property(rgb, function (color) {
					const { h, s, l } = helpers.rgbToHsl(color);
					expect(h).toBeGreaterThanOrEqual(0);
					expect(h).toBeLessThan(360);
					expect(s).toBeGreaterThanOrEqual(0);
					expect(s).toBeLessThanOrEqual(100);
					expect(l).toBeGreaterThanOrEqual(0);
					expect(l).toBeLessThanOrEqual(100);
				})
			);
		});

		it('hslToRgb should be periodic in the hue and produce integer channels in [0, 255]', function () {
			fc.assert(
				fc.property(
					fc.double({ min: -720, max: 720, noNaN: true }),
					fc.double({ min: -10, max: 110, noNaN: true }),
					fc.double({ min: -10, max: 110, noNaN: true }),
					fc.integer({ min: -3, max: 3 }),
					function (h, s, l, turns) {
						const color = helpers.hslToRgb({ h, s, l });
						for (const value of [color.r, color.g, color.b]) {
							expect(Number.isInteger(value)).toBe(true);
							expect(value).toBeGreaterThanOrEqual(0);
							expect(value).toBeLessThanOrEqual(255);
						}
						const shifted = helpers.hslToRgb({ h: h + turns * 360, s, l });
						for (const key of ['r', 'g', 'b'] as const) expect(Math.abs(shifted[key] - color[key])).toBeLessThanOrEqual(1);
					}
				)
			);
		});
	});

	describe('relativeLuminance / contrastRatio', function () {
		it('contrastRatio should be symmetric, within [1, 21], and 1 for identical colours', function () {
			fc.assert(
				fc.property(rgb, rgb, function (a, b) {
					const ratio = helpers.contrastRatio(a, b);
					expect(ratio).toBe(helpers.contrastRatio(b, a));
					expect(ratio).toBeGreaterThanOrEqual(1);
					expect(ratio).toBeLessThanOrEqual(21);
					expect(helpers.contrastRatio(a, a)).toBe(1);
				})
			);
		});

		it('relativeLuminance should be in [0, 1] and monotonic in each channel', function () {
			fc.assert(
				fc.property(rgb, channelName, byte, function (color, channel, other) {
					const lower = { ...color, [channel]: Math.min(color[channel], other) };
					const higher = { ...color, [channel]: Math.max(color[channel], other) };
					expect(helpers.relativeLuminance(lower)).toBeLessThanOrEqual(helpers.relativeLuminance(higher));
					expect(helpers.relativeLuminance(color)).toBeGreaterThanOrEqual(0);
					expect(helpers.relativeLuminance(color)).toBeLessThanOrEqual(1);
				})
			);
		});

		it('contrast against black and white should be complementary: max(black, white) >= sqrt(21)', function () {
			fc.assert(
				fc.property(rgb, function (color) {
					expect(Math.max(helpers.contrastRatio(color, '#000'), helpers.contrastRatio(color, '#fff'))).toBeGreaterThanOrEqual(Math.sqrt(21) - 1e-9);
				})
			);
		});
	});

	describe('mix', function () {
		it('should return a at weight 0, b at weight 1, and a when mixing a with itself', function () {
			fc.assert(
				fc.property(rgba, rgba, weight, function (a, b, w) {
					expect(helpers.mix(a, b, 0)).toEqual(a);
					expect(helpers.mix(a, b, 1)).toEqual(b);
					expect(helpers.mix(a, a, w)).toEqual(a);
				})
			);
		});

		it('should keep every channel between the two inputs, and be symmetric under swapping with 1 - weight', function () {
			fc.assert(
				fc.property(rgba, rgba, weight, function (a, b, w) {
					const mixed = helpers.mix(a, b, w);
					for (const key of ['r', 'g', 'b', 'a'] as const) {
						expect(mixed[key]).toBeGreaterThanOrEqual(Math.min(a[key], b[key]));
						expect(mixed[key]).toBeLessThanOrEqual(Math.max(a[key], b[key]));
						expect(Math.abs(helpers.mix(b, a, 1 - w)[key] - mixed[key])).toBeLessThanOrEqual(key === 'a' ? 1e-9 : 1);
					}
				})
			);
		});
	});

	describe('lighten / darken', function () {
		it('lighten(c, 0) and darken(c, 0) should return c', function () {
			fc.assert(
				fc.property(rgba, function (color) {
					expect(helpers.lighten(color, 0)).toEqual(color);
					expect(helpers.darken(color, 0)).toEqual(color);
				})
			);
		});

		it('lightness should be monotonic in the amount and preserve alpha', function () {
			fc.assert(
				fc.property(rgba, amount, amount, function (color, x, y) {
					const [small, large] = x <= y ? [x, y] : [y, x];
					const lightness = helpers.rgbToHsl(color).l;
					const lighter = helpers.lighten(color, small);
					const lightest = helpers.lighten(color, large);
					const darker = helpers.darken(color, small);
					const darkest = helpers.darken(color, large);
					expect(helpers.rgbToHsl(lighter).l).toBeGreaterThanOrEqual(lightness - 1e-9);
					expect(helpers.rgbToHsl(lightest).l).toBeGreaterThanOrEqual(helpers.rgbToHsl(lighter).l - 1e-9);
					expect(helpers.rgbToHsl(darker).l).toBeLessThanOrEqual(lightness + 1e-9);
					expect(helpers.rgbToHsl(darkest).l).toBeLessThanOrEqual(helpers.rgbToHsl(darker).l + 1e-9);
					expect(lightest.a).toBe(color.a);
					expect(darkest.a).toBe(color.a);
				})
			);
		});
	});

	describe('withAlpha', function () {
		it('should only replace the alpha channel', function () {
			fc.assert(
				fc.property(rgba, weight, function (color, alpha) {
					expect(helpers.withAlpha(color, alpha)).toEqual({ ...color, a: alpha });
				})
			);
		});
	});

	describe('getReadableTextColor / meetsContrast', function () {
		it('the chosen text colour should contrast at least as much as the other option', function () {
			fc.assert(
				fc.property(rgb, rgb, rgb, function (background, light, dark) {
					const chosen = helpers.getReadableTextColor(background, { light, dark });
					const other = chosen === light ? dark : light;
					expect(helpers.contrastRatio(background, chosen)).toBeGreaterThanOrEqual(helpers.contrastRatio(background, other));
				})
			);
		});

		it('AAA should imply AA, and normal text should imply large text', function () {
			fc.assert(
				fc.property(rgb, rgb, function (foreground, background) {
					if (helpers.meetsContrast(foreground, background, { level: 'AAA' })) expect(helpers.meetsContrast(foreground, background)).toBe(true);
					if (helpers.meetsContrast(foreground, background)) expect(helpers.meetsContrast(foreground, background, { largeText: true })).toBe(true);
					expect(helpers.meetsContrast(foreground, background)).toBe(helpers.contrastRatio(foreground, background) >= 4.5);
				})
			);
		});
	});
	describe('parseColor / toCssRgb / toCssHsl', function () {
		it('parseColor(toCssRgb(c)) should round-trip 8-bit channels and alpha in 0.01 steps', function () {
			fc.assert(
				fc.property(cssRgba, function (color) {
					expect(helpers.parseColor(helpers.toCssRgb(color))).toEqual(color);
				})
			);
		});

		it('parseColor(toCssHsl(c)) should round-trip 8-bit channels and alpha in 0.01 steps', function () {
			fc.assert(
				fc.property(cssRgba, function (color) {
					expect(helpers.parseColor(helpers.toCssHsl(color))).toEqual(color);
				})
			);
		});

		it('parseColor should agree with parseHex on every hex string', function () {
			fc.assert(
				fc.property(fc.stringMatching(/^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/), function (hex) {
					expect(helpers.parseColor(hex)).toEqual(helpers.parseHex(hex));
					expect(helpers.toRgba(hex)).toEqual(helpers.parseHex(hex));
				})
			);
		});

		it('parseColor should accept everything parseHex accepts, with the same result', function () {
			fc.assert(
				fc.property(fc.string({ unit: fc.constantFrom('#', 'a', 'F', '0', '9', 'g', ' '), maxLength: 10 }), function (text) {
					let expected: helpers.Rgba | undefined;
					try {
						expected = helpers.parseHex(text);
					} catch {
						return;
					}
					expect(helpers.parseColor(text)).toEqual(expected);
				})
			);
		});

		it('the legacy and modern rgb() syntaxes should agree', function () {
			fc.assert(
				fc.property(cssRgba, space, function ({ r, g, b, a }, ws) {
					const modern = helpers.parseColor(`rgb(${ws}${r} ${g} ${b}${ws}/${ws}${a * 100}%${ws})`);
					expect(helpers.parseColor(`rgba(${r},${ws}${g}${ws},${b}, ${a})`)).toEqual(modern);
					expect(modern).toEqual({ r, g, b, a });
				})
			);
		});

		it('percentage channels should scale to 255 and be rounded', function () {
			fc.assert(
				fc.property(fc.double({ min: -50, max: 150, noNaN: true }), function (percent) {
					const text = String(percent);
					// String(percent) is a valid CSS number except for a few exotic forms; skip anything else.
					fc.pre(/^-?\d+(\.\d+)?(e[+-]\d+)?$/.test(text));
					const { r } = helpers.parseColor(`rgb(${text}% 0 0)`);
					expect(r).toBe(helpers.toRgba({ r: (percent * 255) / 100, g: 0, b: 0 }).r);
				})
			);
		});

		it('hsl() should match hslToRgb, in both syntaxes and every hue unit', function () {
			fc.assert(
				fc.property(fc.integer({ min: -720, max: 720 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), function (h, s, l) {
					const expected = { ...helpers.hslToRgb({ h, s, l }), a: 1 };
					expect(helpers.parseColor(`hsl(${h}, ${s}%, ${l}%)`)).toEqual(expected);
					expect(helpers.parseColor(`hsl(${h}deg ${s} ${l}%)`)).toEqual(expected);
					expect(helpers.parseColor(`hsla(${h + 360} ${s}% ${l} / 1)`)).toEqual(expected);
					// Hues that are exact in turns (multiples of 9 degrees = 0.025 turn) must give the same colour.
					if (h % 9 === 0) expect(helpers.parseColor(`hsl(${h / 360}turn ${s}% ${l}%)`)).toEqual(expected);
				})
			);
		});

		it('parseColor should ignore surrounding whitespace and letter case', function () {
			fc.assert(
				fc.property(cssRgba, space, space, fc.boolean(), function (color, before, after, upper) {
					const css = helpers.toCssHsl(color);
					expect(helpers.parseColor(`${before}${upper ? css.toUpperCase() : css}${after}`)).toEqual(helpers.parseColor(css));
				})
			);
		});

		it('parseColor should either throw a TypeError or return a normalized colour', function () {
			const token = fc.constantFrom('rgb(', 'rgba(', 'hsl(', 'hsla(', ')', ',', '/', ' ', '%', 'deg', 'turn', 'none', '-', '.', 'e', '1', '50', '255', '#', 'f');
			fc.assert(
				fc.property(fc.array(token, { maxLength: 14 }), function (tokens) {
					let color: helpers.Rgba;
					try {
						color = helpers.parseColor(tokens.join(''));
					} catch (error) {
						expect(error).toBeInstanceOf(TypeError);
						return;
					}
					expectNormalized(color);
				})
			);
		});
	});
});

/** OKLCH colours, in and out of the sRGB gamut. */
const oklch = fc.record({
	l: fc.double({ min: 0, max: 1, noNaN: true }),
	c: fc.double({ min: 0, max: 0.5, noNaN: true }),
	h: fc.double({ min: 0, max: 360, maxExcluded: true, noNaN: true })
});
const perceptualSpace = fc.constantFrom<'oklab' | 'oklch'>('oklab', 'oklch');

/**
 * The deltaEOK distance between two OKLab colours.
 */
function deltaEOK(a: helpers.Oklab, b: helpers.Oklab): number {
	return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
}

/**
 * How far from the requested OKLCH lightness a gamut mapped 8-bit colour may land: one JND (0.02), plus half an 8-bit step, which is
 * coarse in OKLab right above black (the first grey after black, #010101, has lightness 0.067).
 */
function lightnessTolerance(l: number): number {
	return l < 0.1 ? 0.055 : 0.025;
}

/**
 * The OKLab form of an OKLCH colour.
 */
function labOf(color: { l: number; c: number; h: number }): helpers.Oklab {
	const radians = (color.h * Math.PI) / 180;
	return { l: color.l, a: color.c * Math.cos(radians), b: color.c * Math.sin(radians) };
}

describe('OKLab / OKLCH (property-based)', function () {
	it('sRGB -> OKLab / OKLCH -> sRGB should give back exactly the same 8-bit colour', function () {
		fc.assert(
			fc.property(rgba, function (color) {
				expect(helpers.oklchToRgb(helpers.toOklch(color))).toEqual(color);
				expect(helpers.oklabToRgb(helpers.toOklab(color))).toEqual(color);
				expect(helpers.inGamut(helpers.toOklch(color))).toBe(true);
			})
		);
	});

	it('parseColor(toCssOklch(c)) should round-trip every 8-bit colour', function () {
		fc.assert(
			fc.property(cssRgba, function (color) {
				expect(helpers.parseColor(helpers.toCssOklch(color))).toEqual(color);
			})
		);
	});

	it('toOklch should agree with toOklab in polar form, within its documented ranges', function () {
		fc.assert(
			fc.property(rgb, function (color) {
				const lab = helpers.toOklab(color);
				const lch = helpers.toOklch(color);
				expect(lch.l).toBe(lab.l);
				expect(lch.l).toBeGreaterThanOrEqual(0);
				expect(lch.l).toBeLessThanOrEqual(1);
				expect(lch.c).toBeCloseTo(Math.hypot(lab.a, lab.b), 15);
				if (lch.c === 0) expect(lch.h).toBeNaN();
				else {
					expect(lch.h).toBeGreaterThanOrEqual(0);
					expect(lch.h).toBeLessThan(360);
					expect(deltaEOK(labOf(lch), lab)).toBeLessThan(1e-12);
				}
			})
		);
	});

	it('gamut mapping should keep the lightness within one JND (plus 8-bit rounding), and in-gamut colours nearly unchanged', function () {
		fc.assert(
			fc.property(oklch, function (color) {
				const mapped = helpers.toOklab(helpers.oklchToRgb(color));
				expect(Math.abs(mapped.l - color.l)).toBeLessThan(lightnessTolerance(color.l));
				// (Above black, where 8-bit steps are coarse in OKLab: see `lightnessTolerance`.)
				if (color.l >= 0.1 && helpers.inGamut(color)) expect(deltaEOK(mapped, labOf(color))).toBeLessThan(0.01);
			})
		);
	});

	it('parseColor should parse oklch() and oklab() like oklchToRgb and oklabToRgb', function () {
		fc.assert(
			fc.property(oklch, fc.double({ min: -0.5, max: 0.5, noNaN: true }), function (color, b) {
				const { l, c, h } = color;
				expect(helpers.parseColor(`oklch(${l} ${c} ${h})`)).toEqual(helpers.oklchToRgb(color));
				expect(helpers.parseColor(`oklch(${l * 100}% ${c * 250}% ${h / 360}turn)`)).toEqual(
					helpers.oklchToRgb({ l: Math.min((l * 100) / 100, 1), c: (c * 250) / 250, h: (((h / 360) % 1) * 360) / 1 })
				);
				expect(helpers.parseColor(`oklab(${l} ${c} ${b} / 0.5)`)).toEqual({ ...helpers.oklabToRgb({ l, a: c, b }), a: 0.5 });
			})
		);
	});

	it('perceptual mix should return the endpoints at weights 0 and 1, and a colour mixed with itself', function () {
		fc.assert(
			fc.property(
				rgba,
				rgba,
				perceptualSpace,
				fc.constantFrom<helpers.HueInterpolation>('shorter', 'increasing', 'decreasing'),
				weight,
				function (a, b, mixSpace, hue, w) {
					expect(helpers.mix(a, b, 0, { space: mixSpace, hue })).toEqual(a);
					expect(helpers.mix(a, b, 1, { space: mixSpace, hue })).toEqual(b);
					expect(helpers.mix(a, a, w, { space: mixSpace, hue })).toEqual(a);
				}
			)
		);
	});

	it('oklab mix should be symmetric (within 8-bit rounding) and interpolate alpha linearly', function () {
		fc.assert(
			// Weights k / 1000, so that `1 - w` is exact enough: a fully transparent colour contributes nothing for any weight > 0,
			// which makes the result jump at the tiniest weights.
			fc.property(rgba, rgba, fc.integer({ min: 0, max: 1000 }), function (a, b, k) {
				const w = k / 1000;
				const forward = helpers.mix(a, b, w, { space: 'oklab' });
				const backward = helpers.mix(b, a, 1 - w, { space: 'oklab' });
				expect(Math.abs(forward.r - backward.r)).toBeLessThanOrEqual(1);
				expect(Math.abs(forward.g - backward.g)).toBeLessThanOrEqual(1);
				expect(Math.abs(forward.b - backward.b)).toBeLessThanOrEqual(1);
				expect(forward.a).toBeCloseTo(a.a + (b.a - a.a) * w, 12);
				expectNormalized(forward);
			})
		);
	});

	it('oklch lighten/darken should move the OKLCH lightness by the amount (within one JND), and not at all for 0', function () {
		fc.assert(
			fc.property(rgba, amount, function (color, by) {
				expect(helpers.lighten(color, 0, { space: 'oklch' })).toEqual(color);
				expect(helpers.darken(color, 0, { space: 'oklch' })).toEqual(color);
				const l = helpers.toOklch(color).l;
				const lighter = Math.min(1, l + by / 100);
				const darker = Math.max(0, l - by / 100);
				expect(Math.abs(helpers.toOklch(helpers.lighten(color, by, { space: 'oklch' })).l - lighter)).toBeLessThan(lightnessTolerance(lighter));
				expect(Math.abs(helpers.toOklch(helpers.darken(color, by, { space: 'oklch' })).l - darker)).toBeLessThan(lightnessTolerance(darker));
				expect(helpers.lighten(color, by, { space: 'oklch' }).a).toBe(color.a);
			})
		);
	});
});

describe('Scales, names, adjustments and HSV (property-based)', function () {
	const mixSpaces = fc.constantFrom<helpers.MixSpace>('srgb', 'oklab', 'oklch');
	const hues = fc.constantFrom<helpers.HueInterpolation>('shorter', 'longer', 'increasing', 'decreasing');
	/** 1 to 8 stops at strictly increasing finite positions (with a few huge or tiny magnitudes). */
	const stopsWithDomain = fc
		.array(fc.tuple(rgba, fc.double({ min: -1e300, max: 1e300, noNaN: true, noDefaultInfinity: true })), { minLength: 1, maxLength: 8 })
		.map(function (pairs) {
			const positions = [
				...new Set(
					pairs.map(function (pair) {
						return pair[1] + 0;
					})
				)
			].sort(function (a, b) {
				return a - b;
			});
			return {
				stops: pairs.slice(0, positions.length).map(function (pair) {
					return pair[0];
				}),
				domain: positions
			};
		});

	/**
	 * Reference implementation of a colour scale: linear search for the segment, then `mix`.
	 */
	function referenceScale(stops: helpers.Rgba[], domain: number[], options: helpers.MixOptions, t: number): helpers.Rgba {
		if (t <= domain[0] || stops.length === 1) return stops[0];
		if (t >= domain[domain.length - 1]) return stops[stops.length - 1];
		let i = 0;
		while (domain[i + 1] <= t) i++;
		return helpers.mix(stops[i], stops[i + 1], (t - domain[i]) / (domain[i + 1] - domain[i]), options);
	}

	it('a two-stop scale should equal mix at the same weight', function () {
		fc.assert(
			fc.property(rgba, rgba, weight, mixSpaces, hues, function (a, b, t, mixSpace, mixHue) {
				const options = { space: mixSpace, hue: mixHue };
				expect(helpers.colorScale([a, b], options)(t)).toEqual(helpers.mix(a, b, t, options));
			})
		);
	});

	it('should equal a linear-search reference, return the stops at their positions and clamp outside the domain', function () {
		fc.assert(
			fc.property(stopsWithDomain, fc.double({ noNaN: true }), mixSpaces, function ({ stops, domain }, t, mixSpace) {
				const scale = helpers.colorScale(stops, { domain, space: mixSpace });
				expect(scale(t)).toEqual(referenceScale(stops, domain, { space: mixSpace }, t));
				domain.forEach(function (position, i) {
					expect(scale(position)).toEqual(stops[i]);
				});
				expect(scale(-Infinity)).toEqual(stops[0]);
				expect(scale(Infinity)).toEqual(stops[stops.length - 1]);
			})
		);
	});

	it('colorSteps should sample the scale evenly, from the first stop to the last', function () {
		fc.assert(
			fc.property(fc.array(rgba, { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 20 }), mixSpaces, function (stops, count, mixSpace) {
				const steps = helpers.colorSteps(stops, count, { space: mixSpace });
				const scale = helpers.colorScale(stops, { space: mixSpace });
				expect(steps).toHaveLength(count);
				steps.forEach(function (color, i) {
					expect(color).toEqual(scale(count > 1 ? i / (count - 1) : 0));
				});
				if (count > 0) expect(steps[0]).toEqual(stops[0]);
				if (count > 1) expect(steps[count - 1]).toEqual(stops[stops.length - 1]);
			})
		);
	});

	it('isCssColor should agree with parseColor on arbitrary and colour-like strings', function () {
		const colorLike = fc.oneof(
			fc.string(),
			fc.stringMatching(/^#?[0-9a-fA-F]{2,9}$/),
			fc
				.tuple(
					fc.constantFrom('rgb', 'rgba', 'hsl', 'hsla', 'oklab', 'oklch', 'hwb'),
					fc.array(fc.constantFrom('1', '50%', '0.5', 'none', '1e999', '2turn', ',', '/', ' '), { maxLength: 7 })
				)
				.map(function ([name, parts]) {
					return `${name}(${parts.join(' ')})`;
				})
		);
		fc.assert(
			fc.property(colorLike, function (text) {
				let parses = true;
				try {
					helpers.parseColor(text);
				} catch {
					parses = false;
				}
				expect(helpers.isCssColor(text)).toBe(parses);
			})
		);
	});

	it('named colours should round-trip, whatever the case and surrounding CSS white space', function () {
		const names = fc.integer({ min: 0, max: 0xffffff }).map(function (value) {
			// Any colour that has a name, found by the nearest search, then looked up exactly.
			return helpers.toColorName({ r: value >> 16, g: (value >> 8) & 255, b: value & 255 }, { nearest: true }) as string;
		});
		const cssSpace = fc.constantFrom('', ' ', '\t', '\n ');
		fc.assert(
			fc.property(names, fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }), cssSpace, cssSpace, function (name, upper, before, after) {
				const color = helpers.parseNamedColor(name) as helpers.Rgba;
				const mixedCase = [...name]
					.map(function (letter, i) {
						return upper[i] ? letter.toUpperCase() : letter;
					})
					.join('');
				expect(helpers.parseNamedColor(before + mixedCase + after)).toEqual(color);
				const canonical = helpers.toColorName(color) as string;
				expect(helpers.parseNamedColor(canonical)).toEqual(color);
				expect(canonical <= name).toBe(true);
			})
		);
	});

	it('toColorName should be exact by default, and nearest should match a brute-force OKLab search', function () {
		fc.assert(
			fc.property(rgba, function (color) {
				const exact = helpers.toColorName(color);
				if (exact !== undefined && exact !== 'transparent') expect(helpers.parseNamedColor(exact)).toEqual(color);
				const nearest = helpers.toColorName(color, { nearest: true }) as string;
				const lab = helpers.toOklab(color);
				/** The OKLab distance from the colour to a named colour. */
				function distance(name: string): number {
					const other = helpers.toOklab(helpers.parseNamedColor(name) as helpers.Rgba);
					return Math.hypot(lab.l - other.l, lab.a - other.a, lab.b - other.b);
				}
				// No named colour is closer (checked against a few candidates the search could have missed).
				for (const name of ['red', 'black', 'white', 'gray', 'navy', 'teal', 'olive', 'purple', 'orange', 'pink', 'brown', 'gold']) {
					expect(distance(nearest)).toBeLessThanOrEqual(distance(name));
				}
				if (exact !== undefined && color.a === 1) expect(nearest).toBe(exact);
			})
		);
	});

	it('hsvToRgb(rgbToHsv(c)) should give back every 8-bit colour, and agree with HSL on hue', function () {
		fc.assert(
			fc.property(rgb, function (color) {
				const hsv = helpers.rgbToHsv(color);
				expect(helpers.hsvToRgb(hsv)).toEqual(color);
				expect(hsv.h).toBe(helpers.rgbToHsl(color).h);
				expect(hsv.v).toBeCloseTo((Math.max(color.r, color.g, color.b) / 255) * 100, 10);
				for (const value of [hsv.h / 3.6, hsv.s, hsv.v]) expect(value >= 0 && value < 100.0000001).toBe(true);
			})
		);
	});

	it('hsvToRgb should normalize the hue and clamp saturation and value', function () {
		fc.assert(
			fc.property(
				fc.double({ min: -1e6, max: 1e6, noNaN: true }),
				fc.double({ min: -50, max: 150, noNaN: true }),
				fc.double({ min: -50, max: 150, noNaN: true }),
				fc.integer({ min: -3, max: 3 }),
				function (h, s, v, turns) {
					const color = helpers.hsvToRgb({ h, s, v });
					expectNormalized({ ...color, a: 1 });
					const clamped = helpers.hsvToRgb({ h, s: Math.min(Math.max(s, 0), 100), v: Math.min(Math.max(v, 0), 100) });
					expect(color).toEqual(clamped);
					const wrapped = ((h % 360) + 360) % 360;
					const shifted = helpers.hsvToRgb({ h: wrapped + turns * 360, s, v });
					for (const channel of ['r', 'g', 'b'] as const) expect(Math.abs(shifted[channel] - color[channel])).toBeLessThanOrEqual(1);
				}
			)
		);
	});

	it('saturate/desaturate/rotateHue should change nothing for 0, keep alpha, and grayscale should give greys', function () {
		fc.assert(
			fc.property(rgba, fc.constantFrom<'hsl' | 'oklch'>('hsl', 'oklch'), amount, function (color, model, by) {
				const options = { space: model };
				expect(helpers.saturate(color, 0, options)).toEqual(color);
				expect(helpers.desaturate(color, 0, options)).toEqual(color);
				expect(helpers.rotateHue(color, 0, options)).toEqual(color);
				for (const result of [helpers.saturate(color, by, options), helpers.desaturate(color, by, options), helpers.rotateHue(color, by * 3.6, options)]) {
					expectNormalized(result);
					expect(result.a).toBe(color.a);
				}
				const grey = helpers.grayscale(color, options);
				expect(grey.r === grey.g && grey.g === grey.b).toBe(true);
				expect(grey).toEqual(helpers.desaturate(color, 100, options));
				expect(grey.a).toBe(color.a);
			})
		);
	});

	it('HSL adjustments should match the HSL components, and OKLCH ones keep the perceived lightness', function () {
		fc.assert(
			fc.property(rgb, amount, function (color, by) {
				const hsl = helpers.rgbToHsl(color);
				expect(helpers.saturate(color, by)).toEqual({ ...helpers.hslToRgb({ ...hsl, s: Math.min(hsl.s + by, 100) }), a: 1 });
				expect(helpers.desaturate(color, by)).toEqual({ ...helpers.hslToRgb({ ...hsl, s: Math.max(hsl.s - by, 0) }), a: 1 });
				expect(helpers.rotateHue(color, by * 3.6)).toEqual({ ...helpers.hslToRgb({ ...hsl, h: hsl.h + by * 3.6 }), a: 1 });
				expect(helpers.complement(color)).toEqual({ ...helpers.hslToRgb({ ...hsl, h: hsl.h + 180 }), a: 1 });
				// The grey of the same OKLab lightness.
				expect(helpers.grayscale(color, { space: 'oklch' })).toEqual(helpers.oklchToRgb({ l: helpers.toOklch(color).l, c: 0 }));
			})
		);
	});
});

/** CIELAB values, as finite doubles over and beyond the sRGB range, plus exact small integers (greys, axes). */
const labComponent = fc.oneof(fc.double({ min: -160, max: 160, noNaN: true }), fc.integer({ min: -3, max: 3 }));
const lab = fc.record({ l: fc.oneof(fc.double({ min: 0, max: 100, noNaN: true }), fc.constantFrom(0, 50, 100)), a: labComponent, b: labComponent });

/**
 * CIEDE2000 transcribed from Sharma, Wu & Dalal's reference MATLAB code (radians, `Math.pow`, `Math.hypot`): an independent oracle.
 * Returns `NaN` at the discontinuity (hues 180° apart), where either side is correct.
 */
function naiveCiede2000(first: helpers.Lab, second: helpers.Lab): number {
	const c1 = Math.hypot(first.a, first.b);
	const c2 = Math.hypot(second.a, second.b);
	const mean = (c1 + c2) / 2;
	const g = 0.5 * (1 - Math.sqrt(Math.pow(mean, 7) / (Math.pow(mean, 7) + Math.pow(25, 7))));
	const a1 = (1 + g) * first.a;
	const a2 = (1 + g) * second.a;
	const cp1 = Math.hypot(a1, first.b);
	const cp2 = Math.hypot(a2, second.b);
	const product = cp1 * cp2;
	function hue(a: number, b: number): number {
		if (Math.abs(a) + Math.abs(b) === 0) return 0;
		const angle = Math.atan2(b, a);
		return angle < 0 ? angle + 2 * Math.PI : angle;
	}
	const h1 = hue(a1, first.b);
	const h2 = hue(a2, second.b);
	// The formula is discontinuous at hues exactly 180° apart, where degrees and radians may round to different sides.
	if (product !== 0 && Math.abs(Math.abs(h2 - h1) - Math.PI) < 1e-9) return NaN;
	let dh = h2 - h1;
	if (dh > Math.PI) dh -= 2 * Math.PI;
	if (dh < -Math.PI) dh += 2 * Math.PI;
	if (product === 0) dh = 0;
	const dH = 2 * Math.sqrt(product) * Math.sin(dh / 2);
	const lp = (first.l + second.l) / 2;
	const cp = (cp1 + cp2) / 2;
	let hp = (h1 + h2) / 2;
	if (Math.abs(h1 - h2) > Math.PI) hp -= Math.PI;
	if (hp < 0) hp += 2 * Math.PI;
	if (product === 0) hp = h1 + h2;
	const lp50 = Math.pow(lp - 50, 2);
	const sl = 1 + (0.015 * lp50) / Math.sqrt(20 + lp50);
	const sc = 1 + 0.045 * cp;
	const t = 1 - 0.17 * Math.cos(hp - Math.PI / 6) + 0.24 * Math.cos(2 * hp) + 0.32 * Math.cos(3 * hp + Math.PI / 30) - 0.2 * Math.cos(4 * hp - (63 * Math.PI) / 180);
	const sh = 1 + 0.015 * cp * t;
	const rotation = ((30 * Math.PI) / 180) * Math.exp(-Math.pow(((180 / Math.PI) * hp - 275) / 25, 2));
	const rc = 2 * Math.sqrt(Math.pow(cp, 7) / (Math.pow(cp, 7) + Math.pow(25, 7)));
	const rt = -Math.sin(2 * rotation) * rc;
	const dl = (second.l - first.l) / sl;
	const dc = (cp2 - cp1) / sc;
	const dhs = dH / sh;
	return Math.sqrt(dl * dl + dc * dc + dhs * dhs + rt * dc * dhs);
}

/**
 * CIELAB D50 as the CSS Color 4 sample code computes it, step by step: linear sRGB → XYZ D65 → Bradford → XYZ D50 → Lab.
 */
function naiveLab(color: helpers.Rgb): number[] {
	const toXyz = [
		[0.41239079926595934, 0.357584339383878, 0.1804807884018343],
		[0.21263900587151027, 0.715168678767756, 0.07219231536073371],
		[0.01933081871559182, 0.11919477979462598, 0.9505321522496607]
	];
	const bradford = [
		[1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
		[0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
		[-0.009243040646204504, 0.015055191490298152, 0.7518742814281371]
	];
	const white = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
	function multiply(matrix: number[][], vector: number[]): number[] {
		return matrix.map(function (row) {
			return row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2];
		});
	}
	const linear = [color.r, color.g, color.b].map(function (channel) {
		const unit = channel / 255;
		return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
	});
	const f = multiply(bradford, multiply(toXyz, linear)).map(function (value, index) {
		const relative = value / white[index];
		return relative > 216 / 24389 ? Math.cbrt(relative) : ((24389 / 27) * relative + 16) / 116;
	});
	return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

/**
 * 32-bit FNV-1a over the `TextEncoder` UTF-8 bytes, then MurmurHash3's fmix32: the documented hash of `colorFromString`.
 */
function naiveHash(text: string): number {
	let hash = 0x811c9dc5;
	for (const octet of new TextEncoder().encode(text)) hash = Math.imul(hash ^ octet, 16777619);
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35);
	return (hash ^ (hash >>> 16)) >>> 0;
}

/** Machado, Oliveira & Fernandes (2009), the published matrices for severities 0, 0.1, … 1 (row-major, 6 decimals). */
const MACHADO: Record<'protanopia' | 'deuteranopia' | 'tritanopia', string[]> = {
	protanopia: [
		'1.000000 0.000000 0.000000 0.000000 1.000000 0.000000 0.000000 0.000000 1.000000',
		'0.856167 0.182038 -0.038205 0.029342 0.955115 0.015544 -0.002880 -0.001563 1.004443',
		'0.734766 0.334872 -0.069637 0.051840 0.919198 0.028963 -0.004928 -0.004209 1.009137',
		'0.630323 0.465641 -0.095964 0.069181 0.890046 0.040773 -0.006308 -0.007724 1.014032',
		'0.539009 0.579343 -0.118352 0.082546 0.866121 0.051332 -0.007136 -0.011959 1.019095',
		'0.458064 0.679578 -0.137642 0.092785 0.846313 0.060902 -0.007494 -0.016807 1.024301',
		'0.385450 0.769005 -0.154455 0.100526 0.829802 0.069673 -0.007442 -0.022190 1.029632',
		'0.319627 0.849633 -0.169261 0.106241 0.815969 0.077790 -0.007025 -0.028051 1.035076',
		'0.259411 0.923008 -0.182420 0.110296 0.804340 0.085364 -0.006276 -0.034346 1.040622',
		'0.203876 0.990338 -0.194214 0.112975 0.794542 0.092483 -0.005222 -0.041043 1.046265',
		'0.152286 1.052583 -0.204868 0.114503 0.786281 0.099216 -0.003882 -0.048116 1.051998'
	],
	deuteranopia: [
		'1.000000 0.000000 0.000000 0.000000 1.000000 0.000000 0.000000 0.000000 1.000000',
		'0.866435 0.177704 -0.044139 0.049567 0.939063 0.011370 -0.003453 0.007233 0.996220',
		'0.760729 0.319078 -0.079807 0.090568 0.889315 0.020117 -0.006027 0.013325 0.992702',
		'0.675425 0.433850 -0.109275 0.125303 0.847755 0.026942 -0.007950 0.018572 0.989378',
		'0.605511 0.528560 -0.134071 0.155318 0.812366 0.032316 -0.009376 0.023176 0.986200',
		'0.547494 0.607765 -0.155259 0.181692 0.781742 0.036566 -0.010410 0.027275 0.983136',
		'0.498864 0.674741 -0.173604 0.205199 0.754872 0.039929 -0.011131 0.030969 0.980162',
		'0.457771 0.731899 -0.189670 0.226409 0.731012 0.042579 -0.011595 0.034333 0.977261',
		'0.422823 0.781057 -0.203881 0.245752 0.709602 0.044646 -0.011843 0.037423 0.974421',
		'0.392952 0.823610 -0.216562 0.263559 0.690210 0.046232 -0.011910 0.040281 0.971630',
		'0.367322 0.860646 -0.227968 0.280085 0.672501 0.047413 -0.011820 0.042940 0.968881'
	],
	tritanopia: [
		'1.000000 0.000000 0.000000 0.000000 1.000000 0.000000 0.000000 0.000000 1.000000',
		'0.926670 0.092514 -0.019184 0.021191 0.964503 0.014306 0.008437 0.054813 0.936750',
		'0.895720 0.133330 -0.029050 0.029997 0.945400 0.024603 0.013027 0.104707 0.882266',
		'0.905871 0.127791 -0.033662 0.026856 0.941251 0.031893 0.013410 0.148296 0.838294',
		'0.948035 0.089490 -0.037526 0.014364 0.946792 0.038844 0.010853 0.193991 0.795156',
		'1.017277 0.027029 -0.044306 -0.006113 0.958479 0.047634 0.006379 0.248708 0.744913',
		'1.104996 -0.046633 -0.058363 -0.032137 0.971635 0.060503 0.001336 0.317922 0.680742',
		'1.193214 -0.109812 -0.083402 -0.058496 0.979410 0.079086 -0.002346 0.403492 0.598854',
		'1.257728 -0.139648 -0.118081 -0.078003 0.975409 0.102594 -0.003316 0.501214 0.502102',
		'1.278864 -0.125333 -0.153531 -0.084748 0.957674 0.127074 -0.000989 0.601151 0.399838',
		'1.255528 -0.076749 -0.178779 -0.078411 0.930809 0.147602 0.004733 0.691367 0.303900'
	]
};

/**
 * Replaces lone surrogates with U+FFFD (`String.prototype.toWellFormed`, ES2024).
 */
function wellFormed(text: string): string {
	return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

const cvdType = fc.constantFrom<helpers.ColorVisionDeficiency>('protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia');
const severity = fc.oneof(
	fc.double({ min: 0, max: 1, noNaN: true }),
	fc.integer({ min: 0, max: 10 }).map(function (tenths) {
		return tenths / 10;
	})
);

describe('Colour difference, colours from strings and CVD simulation (property-based)', function () {
	it('ciede2000 equals the transcription of the reference code, and is symmetric and non-negative', function () {
		fc.assert(
			fc.property(lab, lab, function (first, second) {
				const distance = helpers.ciede2000(first, second);
				expect(distance).toBeGreaterThanOrEqual(0);
				const expected = naiveCiede2000(first, second);
				if (!Number.isNaN(expected)) expect(Math.abs(distance - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, distance));
				expect(helpers.ciede2000(second, first)).toBe(distance);
				expect(helpers.ciede2000(first, first)).toBe(0);
			})
		);
	});

	it('toLab equals the step-by-step CSS Color 4 conversion', function () {
		fc.assert(
			fc.property(rgba, function (color) {
				const actual = helpers.toLab(color);
				const expected = naiveLab(color);
				expect(Math.abs(actual.l - expected[0])).toBeLessThan(1e-9);
				expect(Math.abs(actual.a - expected[1])).toBeLessThan(1e-9);
				expect(Math.abs(actual.b - expected[2])).toBeLessThan(1e-9);
				expect(actual.alpha).toBe(color.a);
			})
		);
	});

	it('deltaE is the distance (or CIEDE2000) of the documented coordinates, symmetric, 0 only for equal colours', function () {
		fc.assert(
			fc.property(rgba, rgba, function (first, second) {
				const okA = helpers.toOklab(first);
				const okB = helpers.toOklab(second);
				const labA = helpers.toLab(first);
				const labB = helpers.toLab(second);
				const ok = helpers.deltaE(first, second);
				const cie76 = helpers.deltaE(first, second, { method: '76' });
				const cie2000 = helpers.deltaE(first, second, { method: '2000' });
				expect(ok).toBeCloseTo(Math.hypot(okA.l - okB.l, okA.a - okB.a, okA.b - okB.b), 14);
				expect(cie76).toBeCloseTo(Math.hypot(labA.l - labB.l, labA.a - labB.a, labA.b - labB.b), 11);
				expect(cie2000).toBe(helpers.ciede2000(labA, labB));
				expect([helpers.deltaE(second, first), helpers.deltaE(second, first, { method: '76' }), helpers.deltaE(second, first, { method: '2000' })]).toEqual([
					ok,
					cie76,
					cie2000
				]);
				const same = first.r === second.r && first.g === second.g && first.b === second.b;
				for (const distance of [ok, cie76, cie2000]) expect(distance === 0).toBe(same);
			})
		);
	});

	it('deltaE ok and 76 satisfy the triangle inequality', function () {
		fc.assert(
			fc.property(rgb, rgb, rgb, fc.constantFrom<helpers.DeltaEMethod>('ok', '76'), function (a, b, c, method) {
				const options = { method };
				expect(helpers.deltaE(a, c, options)).toBeLessThanOrEqual(helpers.deltaE(a, b, options) + helpers.deltaE(b, c, options) + 1e-12);
			})
		);
	});

	it('colorFromString equals the documented hash and OKLCH mapping', function () {
		fc.assert(
			fc.property(
				fc.string({ unit: 'binary' }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 0.4, noNaN: true }),
				fc.double({ min: 0, max: 0.4, noNaN: true }),
				fc.double({ min: -720, max: 720, noNaN: true }),
				fc.double({ min: 0, max: 360, noNaN: true }),
				function (text, l1, l2, c1, c2, start, span) {
					const hash = naiveHash(text);
					const lightness = [Math.min(l1, l2), Math.max(l1, l2)] as const;
					const chroma = [Math.min(c1, c2), Math.max(c1, c2)] as const;
					function fraction(bits: number): number {
						return bits / 255;
					}
					const expected = helpers.toHex(
						helpers.oklchToRgb({
							l: lightness[0] + fraction((hash >>> 8) & 255) * (lightness[1] - lightness[0]),
							c: chroma[0] + fraction(hash & 255) * (chroma[1] - chroma[0]),
							h: start + ((hash >>> 16) / 65536) * span
						})
					);
					const actual = helpers.colorFromString(text, { lightness, chroma, hueRange: [start, start + span] });
					// The interpolations are written differently (lerp vs min + t * span): allow the last 8-bit step.
					const [a, e] = [helpers.parseHex(actual), helpers.parseHex(expected)];
					for (const channel of ['r', 'g', 'b'] as const) expect(Math.abs(a[channel] - e[channel])).toBeLessThanOrEqual(1);
					expect(actual).toMatch(/^#[0-9a-f]{6}$/);
					expect(helpers.colorFromString(text)).toBe(helpers.toHex(helpers.oklchToRgb({ l: 0.7, c: 0.15, h: ((hash >>> 16) / 65536) * 360 })));
				}
			)
		);
	});

	it('colorFromString is stable, and equal for strings with the same UTF-8 bytes', function () {
		fc.assert(
			fc.property(fc.string({ unit: 'binary' }), function (text) {
				expect(helpers.colorFromString(text)).toBe(helpers.colorFromString(text));
				expect(helpers.colorFromString(text)).toBe(helpers.colorFromString(wellFormed(text)));
				expect(helpers.colorFromString(text, { format: 'rgb' })).toEqual({ ...helpers.parseHex(helpers.colorFromString(text)), a: 1 });
			})
		);
	});

	it('colorFromString with contrastWith always reaches minContrast, and keeps colours that already do', function () {
		fc.assert(
			fc.property(fc.string(), rgb, fc.double({ min: 1, max: 21, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), function (text, background, wanted, l) {
				const best = Math.max(helpers.contrastRatio(background, '#000'), helpers.contrastRatio(background, '#fff'));
				const ratio = Math.min(wanted, best);
				const plain = helpers.colorFromString(text, { lightness: l });
				const readable = helpers.colorFromString(text, { lightness: l, contrastWith: background, minContrast: ratio });
				expect(helpers.contrastRatio(readable, background)).toBeGreaterThanOrEqual(ratio);
				if (helpers.contrastRatio(plain, background) >= ratio) expect(readable).toBe(plain);
				if (wanted > best) {
					expect(function () {
						helpers.colorFromString(text, { contrastWith: background, minContrast: wanted });
					}).toThrow(RangeError);
				}
			})
		);
	});

	it('simulateColorVisionDeficiency changes nothing at severity 0, keeps alpha, and keeps greys grey', function () {
		fc.assert(
			fc.property(rgba, cvdType, severity, byte, function (color, type, strength, level) {
				expect(helpers.simulateColorVisionDeficiency(color, type, 0)).toEqual(color);
				const simulated = helpers.simulateColorVisionDeficiency(color, type, strength);
				expectNormalized(simulated);
				expect(simulated.a).toBe(color.a);
				const grey = helpers.simulateColorVisionDeficiency({ r: level, g: level, b: level }, type, strength);
				for (const channel of [grey.r, grey.g, grey.b]) expect(Math.abs(channel - level)).toBeLessThanOrEqual(1);
			})
		);
	});

	it('simulateColorVisionDeficiency equals the published matrices, interpolated, applied in linear sRGB', function () {
		fc.assert(
			fc.property(rgb, fc.constantFrom('protanopia', 'deuteranopia', 'tritanopia' as const), severity, function (color, type, strength) {
				const level = Math.min(Math.floor(strength * 10), 9);
				const t = strength * 10 - level;
				const low = MACHADO[type][level].split(' ').map(Number);
				const high = MACHADO[type][level + 1].split(' ').map(Number);
				const matrix = low.map(function (value, index) {
					return (1 - t) * value + t * high[index];
				});
				const linear = [color.r, color.g, color.b].map(function (channel) {
					const unit = channel / 255;
					return unit <= 0.04045 ? unit / 12.92 : Math.pow((unit + 0.055) / 1.055, 2.4);
				});
				const simulated = helpers.simulateColorVisionDeficiency(color, type, strength);
				for (const [row, channel] of (['r', 'g', 'b'] as const).entries()) {
					const value = Math.min(Math.max(matrix[row * 3] * linear[0] + matrix[row * 3 + 1] * linear[1] + matrix[row * 3 + 2] * linear[2], 0), 1);
					const encoded = Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055) * 255);
					expect(Math.abs(simulated[channel] - encoded)).toBeLessThanOrEqual(1);
				}
			})
		);
	});

	it('achromatopsia gives the grey of the same luminance', function () {
		fc.assert(
			fc.property(rgb, function (color) {
				const grey = helpers.simulateColorVisionDeficiency(color, 'achromatopsia');
				expect(grey.r === grey.g && grey.g === grey.b).toBe(true);
				const target = helpers.relativeLuminance(color);
				const below = helpers.relativeLuminance({ r: grey.r - 1, g: grey.r - 1, b: grey.r - 1 });
				const above = helpers.relativeLuminance({ r: grey.r + 1, g: grey.r + 1, b: grey.r + 1 });
				expect(target).toBeGreaterThanOrEqual(grey.r === 0 ? 0 : below);
				expect(target).toBeLessThanOrEqual(grey.r === 255 ? 1 : above);
			})
		);
	});
});

/**
 * The gamut mapping of `oklchToBytes` as it was before it was made allocation-free (one closure and several arrays per binary-search
 * step), kept verbatim as the oracle: the rewrite must give exactly the same bytes, and `inGamut` the same answers.
 */
const OLD_RGB_TO_LMS = [
	0.41222146947076305, 0.5363325372617348, 0.05144599326750221, 0.21190349581782522, 0.6806995506452344, 0.10739695353694056, 0.08830245919005643, 0.2817188391361215,
	0.6299787016738222
];
const OLD_LMS_TO_RGB = [
	4.076741636075958, -3.3077115392580616, 0.2309699031821043, -1.2684379732850317, 2.6097573492876887, -0.34131937600265727, -0.004196076138675564, -0.7034186179359363,
	1.7076146940746117
];
const OLD_LMS_TO_OKLAB = [
	0.210454268309314, 0.7936177747023054, -0.0040720430116193, 1.9779985324311684, -2.42859224204858, 0.450593709617411, 0.0259040424655478, 0.7827717124575296,
	-0.8086757549230774
];
const OLD_OKLAB_TO_LMS = [1, 0.3963377773761749, 0.2158037573099136, 1, -0.1055613458156586, -0.0638541728258133, 1, -0.0894841775298119, -1.2914855480194092];

/** The old `toLinear`. */
function oldToLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** The old `fromLinear`. */
function oldFromLinear(value: number): number {
	const magnitude = Math.abs(value);
	return magnitude <= 0.0031308 ? value * 12.92 : Math.sign(value) * (1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055);
}

/** The old `transform`. */
function oldTransform(matrix: readonly number[], x: number, y: number, z: number): number[] {
	return [matrix[0] * x + matrix[1] * y + matrix[2] * z, matrix[3] * x + matrix[4] * y + matrix[5] * z, matrix[6] * x + matrix[7] * y + matrix[8] * z];
}

/** The old `srgbToOklab`. */
function oldSrgbToOklab(r: number, g: number, b: number): number[] {
	const lms = oldTransform(OLD_RGB_TO_LMS, oldToLinear(r), oldToLinear(g), oldToLinear(b));
	return oldTransform(OLD_LMS_TO_OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));
}

/** The old `oklabToSrgb`. */
function oldOklabToSrgb(l: number, a: number, b: number): number[] {
	const lms = oldTransform(OLD_OKLAB_TO_LMS, l, a, b);
	const linear = oldTransform(OLD_LMS_TO_RGB, lms[0] ** 3, lms[1] ** 3, lms[2] ** 3);
	return [oldFromLinear(linear[0]), oldFromLinear(linear[1]), oldFromLinear(linear[2])];
}

/** The old `isInside`. */
function oldIsInside(channels: number[]): boolean {
	return channels.every(function (channel) {
		return channel >= -0.000075 && channel <= 1 + 0.000075;
	});
}

/** The old `oklchToBytes` (bytes only). */
function oldOklchToBytes(l: number, c: number, h: number): helpers.Rgb {
	const radians = (h % 360) / (180 / Math.PI);
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	let srgb = [1, 1, 1];

	/** The sRGB channels at this chroma. */
	function at(chroma: number): number[] {
		return oldOklabToSrgb(l, chroma * cos, chroma * sin);
	}

	/** Clips the colour at this chroma into `srgb`, returning the deltaEOK moved. */
	function clip(chroma: number): number {
		srgb = at(chroma).map(function (channel) {
			return Math.min(Math.max(channel, 0), 1);
		});
		const clipped = oldSrgbToOklab(srgb[0], srgb[1], srgb[2]);
		return Math.hypot(clipped[0] - l, clipped[1] - chroma * cos, clipped[2] - chroma * sin);
	}

	if (l <= 0) srgb = [0, 0, 0];
	else if (l < 1) {
		let max = c > 0 ? Math.min(c, 1e100) : 0;
		srgb = at(max);
		if (!oldIsInside(srgb) && clip(max) >= 0.02) {
			let min = 0;
			let minInGamut = true;
			while (max - min > 0.0001) {
				const chroma = (min + max) / 2;
				if (minInGamut && oldIsInside(at(chroma))) {
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
	return { r: oldByte(srgb[0] * 255), g: oldByte(srgb[1] * 255), b: oldByte(srgb[2] * 255) };
}

/** The old `toByte`. */
function oldByte(value: number): number {
	if (value >= 255) return 255;
	return value > 0 ? Math.round(value) : 0;
}

/** OKLCH inputs for the gamut-mapping oracle: everywhere, near the sRGB boundary, and out of range. */
const gamutInput = fc.oneof(
	fc.record({ l: fc.double({ min: 0, max: 1, noNaN: true }), c: fc.double({ min: 0, max: 0.5, noNaN: true }), h: fc.double({ min: 0, max: 360, noNaN: true }) }),
	fc.tuple(rgb, fc.double({ min: -0.02, max: 0.02, noNaN: true })).map(function ([color, nudge]) {
		const lch = helpers.toOklch(color);
		return { l: lch.l, c: Math.max(lch.c + nudge, 0), h: Number.isNaN(lch.h) ? 0 : lch.h };
	}),
	fc.record({
		l: fc.double({ min: -1, max: 2, noNaN: true }),
		c: fc.oneof(fc.double({ min: -1, max: 1e3, noNaN: true }), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constant(Infinity)),
		h: fc.double({ noNaN: true, noDefaultInfinity: true })
	})
);

describe('Gamut mapping (property-based)', function () {
	it('oklchToBytes gives exactly the bytes of its previous (allocating) implementation', function () {
		fc.assert(
			fc.property(gamutInput, function ({ l, c, h }) {
				const expected = oldOklchToBytes(l, c, h);
				expect(helpers.oklchToRgb({ l, c, h })).toEqual({ ...expected, a: 1 });
				const chroma = c > 0 ? Math.min(c, 1e100) : 0;
				const radians = (h % 360) / (180 / Math.PI);
				expect(helpers.inGamut({ l, c, h })).toBe(oldIsInside(oldOklabToSrgb(l, chroma * Math.cos(radians), chroma * Math.sin(radians))));
			}),
			{ numRuns: 2000 }
		);
	});

	it('inGamut and oklchToBytes agree with the previous implementation right at the gamut boundary (the exact fallback of the fast paths)', function () {
		fc.assert(
			fc.property(
				fc.double({ min: 0.01, max: 0.99, noNaN: true }),
				fc.double({ min: 0, max: 360, noNaN: true }),
				fc.integer({ min: -4, max: 4 }),
				function (l, h, step) {
					const radians = (h % 360) / (180 / Math.PI);

					/** The old gamut test at this chroma. */
					function inside(chroma: number): boolean {
						return oldIsInside(oldOklabToSrgb(l, chroma * Math.cos(radians), chroma * Math.sin(radians)));
					}

					// Bisect the old test down to adjacent doubles: some channel is then within an ulp of -GAMUT_EPSILON or 1 + GAMUT_EPSILON.
					let low = 0;
					let high = 1;
					for (let middle = 0.5; middle > low && middle < high; middle = (low + high) / 2) {
						if (inside(middle)) low = middle;
						else high = middle;
					}
					const chroma = (step < 0 ? low : high) * (1 + step * Number.EPSILON);
					expect(helpers.inGamut({ l, c: chroma, h })).toBe(inside(chroma));
					expect(helpers.oklchToRgb({ l, c: chroma, h })).toEqual({ ...oldOklchToBytes(l, chroma, h), a: 1 });
				}
			)
		);
	});
});
