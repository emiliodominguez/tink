import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as helpers from '.';

describe('Color helpers', function () {
	describe('parseHex', function () {
		it('should parse 6 and 8 digit forms', function () {
			expect(helpers.parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.parseHex('#00000080')).toEqual({ r: 0, g: 0, b: 0, a: 128 / 255 });
			expect(helpers.parseHex('#123456ff')).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 1 });
			expect(helpers.parseHex('#12345600')).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 0 });
		});

		it('should expand 3 and 4 digit forms', function () {
			expect(helpers.parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
			expect(helpers.parseHex('#abc8')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0x88 / 255 });
		});

		it('should accept a missing # and any letter case', function () {
			expect(helpers.parseHex('0F0')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
			expect(helpers.parseHex('FfA07A')).toEqual({ r: 255, g: 160, b: 122, a: 1 });
		});

		it('should throw a TypeError for invalid strings', function () {
			for (const value of [
				'',
				'#',
				'#ff',
				'#fffff',
				'#fffffff',
				'#fffffffff',
				'#ggg',
				' #fff',
				'#fff ',
				'##fff',
				'rgb(0,0,0)',
				'#ff 00 00',
				'#@@@',
				'#```',
				'#:::',
				'#/00'
			]) {
				expect(function () {
					helpers.parseHex(value);
				}).toThrow(TypeError);
			}
		});

		it('should throw a TypeError for non-strings', function () {
			expect(function () {
				helpers.parseHex(123 as any);
			}).toThrow(TypeError);
		});
	});

	describe('toRgba', function () {
		it('should parse hex strings', function () {
			expect(helpers.toRgba('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
		});

		it('should clamp and round object channels and default alpha to 1', function () {
			expect(helpers.toRgba({ r: 300, g: 12.4, b: -5 })).toEqual({ r: 255, g: 12, b: 0, a: 1 });
			expect(helpers.toRgba({ r: 0.5, g: 254.5, b: Infinity, a: 2 })).toEqual({ r: 1, g: 255, b: 255, a: 1 });
			expect(helpers.toRgba({ r: -0.4, g: 0, b: 0, a: -1 })).toEqual({ r: 0, g: 0, b: 0, a: 0 });
			expect(Object.is(helpers.toRgba({ r: -0.4, g: 0, b: 0, a: -0 }).r, 0)).toBe(true);
			expect(Object.is(helpers.toRgba({ r: 0, g: 0, b: 0, a: -0 }).a, 0)).toBe(true);
			expect(helpers.toRgba({ r: 1, g: 2, b: 3, a: undefined } as any)).toEqual({ r: 1, g: 2, b: 3, a: 1 });
		});

		it('should return a fresh object without mutating the input', function () {
			const input = Object.freeze({ r: 1, g: 2, b: 3, a: 0.5 });
			const result = helpers.toRgba(input);
			expect(result).toEqual(input);
			expect(result).not.toBe(input);
		});

		it('should throw a TypeError for invalid inputs', function () {
			for (const value of [null, undefined, 42, true, { r: '1', g: 0, b: 0 }, { r: 0, g: 0 }, { r: 0, g: 0, b: 0, a: '1' }]) {
				expect(function () {
					helpers.toRgba(value as any);
				}).toThrow(TypeError);
			}
		});

		it('should throw a RangeError for NaN channels', function () {
			expect(function () {
				helpers.toRgba({ r: NaN, g: 0, b: 0 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.toRgba({ r: 0, g: 0, b: 0, a: NaN });
			}).toThrow(RangeError);
		});
	});

	describe('toHex', function () {
		it('should format opaque colours as #rrggbb', function () {
			expect(helpers.toHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
			expect(helpers.toHex({ r: 0, g: 10, b: 1, a: 1 })).toBe('#000a01');
			expect(helpers.toHex('#ABC')).toBe('#aabbcc');
		});

		it('should include alpha automatically for translucent colours', function () {
			expect(helpers.toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
			expect(helpers.toHex({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000');
		});

		it('should honour the alpha option', function () {
			expect(helpers.toHex('#ABC', { alpha: true })).toBe('#aabbccff');
			expect(helpers.toHex({ r: 0, g: 0, b: 0, a: 0.5 }, { alpha: false })).toBe('#000000');
		});

		it('should clamp and round channels', function () {
			expect(helpers.toHex({ r: 300, g: -20, b: 127.5 })).toBe('#ff0080');
			expect(helpers.toHex({ r: 0, g: 0, b: 0, a: 1.5 })).toBe('#000000');
		});

		it('should throw for invalid colours', function () {
			expect(function () {
				helpers.toHex('nope');
			}).toThrow(TypeError);
		});
	});

	describe('rgbToHsl', function () {
		it('should convert primary and secondary colours', function () {
			expect(helpers.rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
			expect(helpers.rgbToHsl({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, l: 50 });
			expect(helpers.rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 });
			expect(helpers.rgbToHsl('#ffff00')).toEqual({ h: 60, s: 100, l: 50 });
			expect(helpers.rgbToHsl('#00ffff')).toEqual({ h: 180, s: 100, l: 50 });
			expect(helpers.rgbToHsl('#ff00ff')).toEqual({ h: 300, s: 100, l: 50 });
		});

		it('should keep the hue in [0, 360) for hues just below red', function () {
			const { h } = helpers.rgbToHsl('#ff0001');
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(360);
			expect(h).toBeCloseTo(359.76, 2);
		});

		it('should give greys hue 0 and saturation 0', function () {
			expect(helpers.rgbToHsl('#000000')).toEqual({ h: 0, s: 0, l: 0 });
			expect(helpers.rgbToHsl('#ffffff')).toEqual({ h: 0, s: 0, l: 100 });
			expect(helpers.rgbToHsl('#808080')).toEqual({ h: 0, s: 0, l: (128 / 255) * 100 });
		});

		it('should compute saturation for light and dark colours', function () {
			const dark = helpers.rgbToHsl({ r: 0, g: 128, b: 0 });
			expect(dark.h).toBe(120);
			expect(dark.s).toBe(100);
			expect(dark.l).toBeCloseTo(25.1, 1);
			const pastel = helpers.rgbToHsl('#ffa07a');
			expect(pastel.h).toBeCloseTo(17.14, 2);
			expect(pastel.s).toBe(100);
			expect(pastel.l).toBeCloseTo(73.92, 2);
		});
	});

	describe('hslToRgb', function () {
		it('should convert standard colours', function () {
			expect(helpers.hslToRgb({ h: 0, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
			expect(helpers.hslToRgb({ h: 120, s: 100, l: 25 })).toEqual({ r: 0, g: 128, b: 0 });
			expect(helpers.hslToRgb({ h: 240, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 255 });
			expect(helpers.hslToRgb({ h: 0, s: 0, l: 50 })).toEqual({ r: 128, g: 128, b: 128 });
			expect(helpers.hslToRgb({ h: 200, s: 50, l: 100 })).toEqual({ r: 255, g: 255, b: 255 });
			expect(helpers.hslToRgb({ h: 200, s: 50, l: 0 })).toEqual({ r: 0, g: 0, b: 0 });
		});

		it('should normalize the hue and clamp saturation and lightness', function () {
			expect(helpers.hslToRgb({ h: -120, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 255 });
			expect(helpers.hslToRgb({ h: 600, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 255 });
			expect(helpers.hslToRgb({ h: 360, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
			expect(helpers.hslToRgb({ h: 0, s: 150, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
			expect(helpers.hslToRgb({ h: 0, s: 100, l: -10 })).toEqual({ r: 0, g: 0, b: 0 });
		});

		it('should throw for invalid input', function () {
			expect(function () {
				helpers.hslToRgb(null as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.hslToRgb('#fff' as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.hslToRgb({ h: '0', s: 0, l: 0 } as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.hslToRgb({ h: Infinity, s: 0, l: 0 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.hslToRgb({ h: 0, s: NaN, l: 0 });
			}).toThrow(RangeError);
		});
	});

	describe('mix', function () {
		it('should interpolate sRGB channels, default to the midpoint', function () {
			expect(helpers.mix('#000000', '#ffffff')).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.mix('#ff0000', '#0000ff', 0.25)).toEqual({ r: 191, g: 0, b: 64, a: 1 });
		});

		it('should return the endpoints for weights 0 and 1', function () {
			expect(helpers.mix('#ff0000', '#0000ff', 0)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.mix('#ff0000', '#0000ff', 1)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
		});

		it('should interpolate alpha', function () {
			expect(helpers.mix({ r: 0, g: 0, b: 0, a: 0 }, '#000', 0.5)).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
			// Plain `(1 - w) * x + w * y` overshoots here (0.41960784313725497).
			expect(helpers.mix({ r: 0, g: 0, b: 0, a: 107 / 255 }, { r: 0, g: 0, b: 0, a: 106 / 255 }, 6.009343965836637e-16).a).toBe(107 / 255);
		});

		it('should throw a RangeError for weights outside [0, 1]', function () {
			for (const weight of [-0.1, 1.1, NaN]) {
				expect(function () {
					helpers.mix('#000', '#fff', weight);
				}).toThrow(RangeError);
			}
		});
	});

	describe('lighten / darken', function () {
		it('should adjust HSL lightness', function () {
			expect(helpers.lighten('#000000', 50)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.lighten('#ff0000', 20)).toEqual({ r: 255, g: 102, b: 102, a: 1 });
			expect(helpers.darken('#ffffff', 50)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.darken('#ff0000', 20)).toEqual({ r: 153, g: 0, b: 0, a: 1 });
		});

		it('should clamp the lightness at white and black', function () {
			expect(helpers.lighten('#ffffff', 10)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.lighten('#336699', 100)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.darken('#336699', 100)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
		});

		it('should keep alpha and return the normalized colour for amount 0', function () {
			expect(helpers.lighten({ r: 10, g: 20, b: 30, a: 0.25 }, 0)).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
			expect(helpers.darken('#33669980', 10).a).toBe(0x80 / 255);
		});

		it('should throw a RangeError for amounts outside [0, 100]', function () {
			for (const amount of [-1, 101, NaN]) {
				expect(function () {
					helpers.lighten('#000', amount);
				}).toThrow(RangeError);
				expect(function () {
					helpers.darken('#000', amount);
				}).toThrow(RangeError);
			}
		});
	});

	describe('withAlpha', function () {
		it('should replace the alpha channel', function () {
			expect(helpers.withAlpha('#ff0000', 0.5)).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
			expect(helpers.withAlpha({ r: 1, g: 2, b: 3, a: 0.1 }, 1)).toEqual({ r: 1, g: 2, b: 3, a: 1 });
			expect(Object.is(helpers.withAlpha('#000', -0).a, 0)).toBe(true);
		});

		it('should throw a RangeError for alpha outside [0, 1]', function () {
			for (const alpha of [-0.1, 1.1, NaN]) {
				expect(function () {
					helpers.withAlpha('#000', alpha);
				}).toThrow(RangeError);
			}
		});
	});

	describe('relativeLuminance', function () {
		it('should follow the WCAG 2.x definition', function () {
			expect(helpers.relativeLuminance('#ffffff')).toBe(1);
			expect(helpers.relativeLuminance('#000000')).toBe(0);
			expect(helpers.relativeLuminance('#ff0000')).toBeCloseTo(0.2126, 12);
			expect(helpers.relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 12);
			expect(helpers.relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 12);
			expect(helpers.relativeLuminance('#808080')).toBeCloseTo(0.2158605, 6);
			expect(helpers.relativeLuminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 12);
		});

		it('should ignore alpha', function () {
			expect(helpers.relativeLuminance('#80808000')).toBe(helpers.relativeLuminance('#808080'));
		});
	});

	describe('contrastRatio', function () {
		it('should compute WCAG contrast ratios', function () {
			expect(helpers.contrastRatio('#000', '#fff')).toBe(21);
			expect(helpers.contrastRatio('#fff', '#000')).toBe(21);
			expect(helpers.contrastRatio('#777', '#fff')).toBeCloseTo(4.478, 3);
			expect(helpers.contrastRatio('#767676', '#fff')).toBeCloseTo(4.542, 3);
			expect(helpers.contrastRatio('#abc', '#abc')).toBe(1);
		});
	});

	describe('getReadableTextColor', function () {
		it('should pick the default candidate with more contrast', function () {
			expect(helpers.getReadableTextColor('#1e3a8a')).toBe('#ffffff');
			expect(helpers.getReadableTextColor('#fde68a')).toBe('#000000');
			expect(helpers.getReadableTextColor('#000')).toBe('#ffffff');
			expect(helpers.getReadableTextColor('#fff')).toBe('#000000');
		});

		it('should return custom candidates as given', function () {
			const light = { r: 238, g: 238, b: 238 };
			expect(helpers.getReadableTextColor('#222', { light, dark: '#333' })).toBe(light);
			expect(helpers.getReadableTextColor('#eee', { light: '#fff', dark: { r: 10, g: 10, b: 10 } })).toEqual({ r: 10, g: 10, b: 10 });
		});

		it('should type the result with the defaults unless both candidates are given', function () {
			const both: '#eee' | '#333' = helpers.getReadableTextColor('#222', { light: '#eee', dark: '#333' });
			const optional: helpers.ReadableTextColorOptions<'#eee', '#333'> = {};
			// @ts-expect-error a missing candidate falls back to its default, which is neither '#eee' nor '#333'
			const narrowed: '#eee' | '#333' = helpers.getReadableTextColor('#222', optional);
			const widened: '#eee' | '#333' | '#ffffff' | '#000000' = helpers.getReadableTextColor('#222', optional);
			const defaults: '#ffffff' | '#000000' = helpers.getReadableTextColor('#222');
			expect([both, narrowed, widened, defaults]).toEqual(['#eee', '#ffffff', '#ffffff', '#ffffff']);
		});

		it('should prefer the dark candidate on ties', function () {
			expect(helpers.getReadableTextColor('#777', { light: '#123', dark: '#123' })).toBe('#123');
			expect(helpers.getReadableTextColor('#777', { light: '#000', dark: '#000000' })).toBe('#000000');
		});
	});

	describe('meetsContrast', function () {
		it('should check WCAG AA by default', function () {
			expect(helpers.meetsContrast('#767676', '#ffffff')).toBe(true);
			expect(helpers.meetsContrast('#777777', '#ffffff')).toBe(false);
		});

		it('should use the large-text thresholds', function () {
			expect(helpers.meetsContrast('#777777', '#ffffff', { largeText: true })).toBe(true);
			expect(helpers.meetsContrast('#959595', '#ffffff', { largeText: true })).toBe(false);
		});

		it('should check AAA', function () {
			expect(helpers.meetsContrast('#767676', '#ffffff', { level: 'AAA' })).toBe(false);
			expect(helpers.meetsContrast('#595959', '#ffffff', { level: 'AAA' })).toBe(true);
			expect(helpers.meetsContrast('#767676', '#ffffff', { level: 'AAA', largeText: true })).toBe(true);
		});

		it('should throw a RangeError for an unknown level', function () {
			expect(function () {
				helpers.meetsContrast('#000', '#fff', { level: 'A' as any });
			}).toThrow(RangeError);
		});

		it('should reject a largeText that is not a boolean, which counted as its truthiness (regression)', function () {
			// Regression: `largeText: 'false'` (from a query string, a data attribute) applied the large-text threshold: 4.48:1 passed AA.
			for (const [value, got] of [
				['false', 'string'],
				[0, 'number'],
				[{}, 'object']
			] as const) {
				expect(function () {
					helpers.meetsContrast('#777777', '#ffffff', { largeText: value as never });
				}).toThrow(new TypeError(`meetsContrast: \`options.largeText\` must be a boolean, got ${got}`));
			}
			// `undefined` and `null` mean the default (`false`), as before.
			expect(helpers.meetsContrast('#777777', '#ffffff', { largeText: undefined })).toBe(false);
			expect(helpers.meetsContrast('#777777', '#ffffff', { largeText: null as never })).toBe(false);
		});

		it('should reject the other boolean options when they are not booleans (regression)', function () {
			expect(function () {
				helpers.toColorName('#ff0001', { nearest: 'false' as never });
			}).toThrow(new TypeError('toColorName: `options.nearest` must be a boolean, got string'));
			expect(function () {
				helpers.toHex('#ff0000', { alpha: 'false' as never });
			}).toThrow(new TypeError('toHex: `options.alpha` must be a boolean, got string'));
			expect(helpers.toColorName('#ff0001', { nearest: null as never })).toBeUndefined();
			expect(helpers.toHex('#ff000080', { alpha: null as never })).toBe('#ff000080');
		});
	});

	describe('parseColor', function () {
		it('should parse hex colours exactly like parseHex', function () {
			for (const value of ['#abc', 'abc8', '#FF8000', '00000080']) {
				expect(helpers.parseColor(value)).toEqual(helpers.parseHex(value));
			}
		});

		it('should ignore surrounding whitespace and letter case', function () {
			expect(helpers.parseColor('  #FFF\n')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.parseColor(' TRANSPARENT ')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
			expect(helpers.parseColor('RGBA( 1 , 2 , 3 , 50% )')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
			expect(helpers.parseColor('HSL(0.5TURN 100% 50%)')).toEqual({ r: 0, g: 255, b: 255, a: 1 });
		});

		it('security: only accepts CSS white space (space, tab, LF, CR, FF), around the string and between arguments', function () {
			expect(helpers.parseColor('\t\r\f #FFF \n')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.parseColor('rgb(\f1\r2\n3\t/\t1)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
			expect(helpers.parseColor('hsl(0,\n100%,\r50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			for (const space of ['\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff', '\u1680', '\u2003', '\v']) {
				for (const input of [
					`rgb(1${space}2 3)`,
					`rgb(1,${space}2,3)`,
					`rgb(${space}1 2 3)`,
					`rgb(1 2 3${space})`,
					`${space}#fff`,
					`#fff${space}`,
					`transparent${space}`
				]) {
					expect(function () {
						helpers.parseColor(input);
					}).toThrow(TypeError);
					expect(function () {
						helpers.toRgba(input);
					}).toThrow(TypeError);
				}
			}
		});

		it('accepts hex colours without `#` (documented), unlike isHexColor and CSS', function () {
			expect(helpers.parseColor('add')).toEqual({ r: 170, g: 221, b: 221, a: 1 });
			expect(helpers.parseColor('facade')).toEqual({ r: 250, g: 202, b: 222, a: 1 });
		});

		it('should parse the legacy comma syntax of rgb() and rgba()', function () {
			expect(helpers.parseColor('rgb(255, 128, 0)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('rgba(255,128,0,0.25)')).toEqual({ r: 255, g: 128, b: 0, a: 0.25 });
			expect(helpers.parseColor('rgb(1, 2, 3, 40%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.4 });
			expect(helpers.parseColor('rgba(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
			expect(helpers.parseColor('rgb(100%, 50%, 0%)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
		});

		it('should parse the modern space syntax of rgb() with an optional alpha', function () {
			expect(helpers.parseColor('rgb(255 128 0)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('rgb(255 128 0 / 0.5)')).toEqual({ r: 255, g: 128, b: 0, a: 0.5 });
			expect(helpers.parseColor('rgba(1 2 3/50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
			expect(helpers.parseColor('rgb(100% 128 0%)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('rgb(none 2 3 / none)')).toEqual({ r: 0, g: 2, b: 3, a: 0 });
		});

		it('should accept every CSS number form', function () {
			expect(helpers.parseColor('rgb(+1 .5e1 3E1)')).toEqual({ r: 1, g: 5, b: 30, a: 1 });
			expect(helpers.parseColor('rgb(1.4 1.5 254.5 / .5)')).toEqual({ r: 1, g: 2, b: 255, a: 0.5 });
			expect(helpers.parseColor('rgb(0 0 0 / .25)')).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
			expect(helpers.parseColor('rgb(1  2\t\t3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
		});

		it('should only accept a colour function at the start of the string', function () {
			expect(function () {
				helpers.parseColor('xrgb(1 2 3)');
			}).toThrow(TypeError);
		});

		it('should clamp out-of-range values like CSS', function () {
			expect(helpers.parseColor('rgb(300 -20 0 / 2)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('rgb(150%, -5%, 0%, -1)')).toEqual({ r: 255, g: 0, b: 0, a: 0 });
			expect(helpers.parseColor('rgb(1e300 0 0 / 1e300%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('hsl(0 200% -10%)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(Object.is(helpers.parseColor('rgb(0 0 0 / -0)').a, 0)).toBe(true);
			expect(helpers.parseColor('rgb(-0 -0.2 -0% / -0%)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
			const negativeZeros = helpers.toRgba({ r: -0, g: -0.2, b: -0, a: -0 });
			for (const channel of [negativeZeros.r, negativeZeros.g, negativeZeros.b, negativeZeros.a]) expect(Object.is(channel, 0)).toBe(true);
		});

		it('should parse hsl() and hsla() in both syntaxes', function () {
			expect(helpers.parseColor('hsl(120, 100%, 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('hsla(120, 100%, 25%, 0.5)')).toEqual({ r: 0, g: 128, b: 0, a: 0.5 });
			expect(helpers.parseColor('hsl(120 100% 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('hsl(120 100 25 / 25%)')).toEqual({ r: 0, g: 128, b: 0, a: 0.25 });
			expect(helpers.parseColor('hsl(none none none)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
		});

		it('should support every hue unit and wrap the hue', function () {
			const blue = { r: 0, g: 0, b: 255, a: 1 };
			for (const hue of ['240', '240deg', '266.6667grad', '4.18879rad', '0.6667turn', '-120deg', '600', '-0.3333turn', '1e300turn']) {
				const color = helpers.parseColor(`hsl(${hue} 100% 50%)`);
				if (hue === '1e300turn') expect(color).toEqual({ r: 255, g: 0, b: 0, a: 1 });
				else expect(color).toEqual(blue);
			}
			expect(helpers.parseColor('hsl(100grad, 100%, 50%)')).toEqual(helpers.parseColor('hsl(90 100% 50%)'));
		});

		it('should parse transparent', function () {
			expect(helpers.parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
		});

		it('should return a fresh object each time', function () {
			expect(helpers.parseColor('transparent')).not.toBe(helpers.parseColor('transparent'));
		});

		it('should throw a TypeError for unsupported or malformed strings', function () {
			const invalid = [
				'',
				'red',
				'currentcolor',
				'#ff',
				'hwb(0 0% 0%)',
				'rgb()',
				'rgb(1 2)',
				'rgb(1, 2)',
				'rgb(1 2 3 4)',
				'rgb(1, 2, 3, 4, 5)',
				'rgb(1 2 3 / 0.5 0.1)',
				'rgb(1 2 3 / 1 / 2)',
				'rgb(1 2 3 /)',
				'rgb(1, 2, 3,)',
				'rgb(1, 2, 3 / 0.5)',
				'rgb(1 2, 3, 4)',
				'rgb(1, 2%, 3)',
				'rgb(none, 2, 3)',
				'rgb(1deg 2 3)',
				'rgb(1 2 3 / 1deg)',
				'rgb(1. 2 3)',
				'rgb(1e999 0 0)',
				'rgb(1 2 3) x',
				'rgb((1 2 3))',
				'rgb 1 2 3',
				'hsl(120, 100, 25)',
				'hsl(10% 100% 50%)',
				'hsl(10 100deg 50%)',
				'hsl(10, 100%, 50)',
				'hsl(10 100% 50deg)',
				'hsl(none, 100%, 50%)',
				'hsla(1 2% 3% 4)'
			];
			for (const value of invalid) {
				expect(function () {
					helpers.parseColor(value);
				}).toThrow(TypeError);
			}
		});

		it('should throw a TypeError for non-strings', function () {
			for (const value of [null, undefined, 42, { r: 0, g: 0, b: 0 }]) {
				expect(function () {
					helpers.parseColor(value as any);
				}).toThrow(new TypeError(`parseColor: \`input\` must be a string, got ${value === null ? 'null' : typeof value}`));
			}
		});
	});

	describe('toRgba with CSS strings', function () {
		it('should accept every syntax of parseColor', function () {
			expect(helpers.toRgba('rgb(255 0 0 / 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
			expect(helpers.toRgba('hsl(240, 100%, 50%)')).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(helpers.toHex('transparent')).toBe('#00000000');
			expect(helpers.contrastRatio('rgb(0 0 0)', 'hsl(0 0% 100%)')).toBe(21);
		});

		it('should report errors under its own name', function () {
			expect(function () {
				helpers.toRgba('nope');
			}).toThrow(new TypeError('toRgba: `input` must be a CSS colour (hex, rgb(), hsl(), oklab(), oklch() or \'transparent\'), got "nope"'));
			expect(function () {
				helpers.toRgba(42 as any);
			}).toThrow(new TypeError('toRgba: `input` must be a colour string or an { r, g, b } object, got number'));
		});
	});

	describe('toCssRgb', function () {
		it('should format opaque colours without alpha', function () {
			expect(helpers.toCssRgb('#ff8000')).toBe('rgb(255 128 0)');
			expect(helpers.toCssRgb({ r: 0, g: 0, b: 0 })).toBe('rgb(0 0 0)');
			expect(helpers.toCssRgb({ r: 300, g: 1.4, b: -2, a: 2 })).toBe('rgb(255 1 0)');
		});

		it('should append the alpha, rounded to 3 decimals, for translucent colours', function () {
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgb(1 2 3 / 0.5)');
			// Alphas that round (to 3 decimals) to 1 are omitted; the largest one that does not is kept.
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0.9995 })).toBe('rgb(1 2 3)');
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0.9994999999999999 })).toBe('rgb(1 2 3 / 0.999)');
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0 })).toBe('rgb(1 2 3 / 0)');
			expect(helpers.toCssRgb('#00000080')).toBe('rgb(0 0 0 / 0.502)');
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0.12345 })).toBe('rgb(1 2 3 / 0.123)');
		});

		it('should omit an alpha that rounds to 1', function () {
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3, a: 0.9996 })).toBe('rgb(1 2 3)');
		});

		it('should throw for invalid colours', function () {
			expect(function () {
				helpers.toCssRgb('nope');
			}).toThrow(TypeError);
			expect(function () {
				helpers.toCssRgb({ r: NaN, g: 0, b: 0 });
			}).toThrow(RangeError);
		});
	});

	describe('toCssHsl', function () {
		it('should format colours in the modern hsl() syntax', function () {
			expect(helpers.toCssHsl('#ff0000')).toBe('hsl(0 100% 50%)');
			expect(helpers.toCssHsl('#00ff00')).toBe('hsl(120 100% 50%)');
			expect(helpers.toCssHsl('#000')).toBe('hsl(0 0% 0%)');
			expect(helpers.toCssHsl('#fff')).toBe('hsl(0 0% 100%)');
		});

		it('should round hue, saturation and lightness to 1 decimal', function () {
			expect(helpers.toCssHsl('#808080')).toBe('hsl(0 0% 50.2%)');
			expect(helpers.toCssHsl('#123456')).toBe('hsl(210 65.4% 20.4%)');
		});

		it('should keep the largest possible hue below 360', function () {
			expect(helpers.toCssHsl({ r: 255, g: 0, b: 1 })).toBe('hsl(359.8 100% 50%)');
		});

		it('should append the alpha for translucent colours', function () {
			expect(helpers.toCssHsl({ r: 51, g: 102, b: 153, a: 0.25 })).toBe('hsl(210 50% 40% / 0.25)');
		});

		it('should throw for invalid colours', function () {
			expect(function () {
				helpers.toCssHsl('nope');
			}).toThrow(TypeError);
		});
	});

	describe('argument validation', function () {
		it('uses the library-wide message format', function () {
			expect(function () {
				helpers.parseHex('#zz');
			}).toThrow(new TypeError('parseHex: `hex` must be a valid hex colour, got "#zz"'));
			// Security: at most 50 characters of a rejected string are quoted.
			const long = `#${'g'.repeat(10_000)}`;
			expect(function () {
				helpers.parseHex(long);
			}).toThrow(new TypeError(`parseHex: \`hex\` must be a valid hex colour, got "${long.slice(0, 50)}…"`));
			expect(function () {
				helpers.parseColor(long);
			}).toThrow(new TypeError(`parseColor: \`input\` must be a CSS colour (hex, rgb(), hsl(), oklab(), oklch() or 'transparent'), got "${long.slice(0, 50)}…"`));
			expect(function () {
				helpers.parseHex(long.slice(0, 50));
			}).toThrow(new TypeError(`parseHex: \`hex\` must be a valid hex colour, got "${long.slice(0, 50)}"`));
			expect(function () {
				helpers.toRgba({ r: 0, g: 'x' as any, b: 0 });
			}).toThrow(new TypeError('toRgba: `input.g` must be a number other than NaN, got string'));
			expect(function () {
				helpers.toRgba({ r: NaN, g: 0, b: 0 });
			}).toThrow(new RangeError('toRgba: `input.r` must be a number other than NaN, got NaN'));
			expect(function () {
				helpers.lighten('#000', 101);
			}).toThrow(new RangeError('lighten: `amount` must be a number in [0, 100], got 101'));
			expect(function () {
				helpers.mix('#000', '#fff', '0.5' as any);
			}).toThrow(new TypeError('mix: `weight` must be a number in [0, 1], got string'));
		});

		it('names the right function and parameter for every validated argument', function () {
			function cssError(caller: string, input: string): TypeError {
				return new TypeError(`${caller}: \`input\` must be a CSS colour (hex, rgb(), hsl(), oklab(), oklch() or 'transparent'), got ${JSON.stringify(input)}`);
			}
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.parseHex(5 as any);
					},
					new TypeError('parseHex: `hex` must be a string, got number')
				],
				[
					function () {
						return helpers.parseColor('rgb(1 2 x)');
					},
					cssError('parseColor', 'rgb(1 2 x)')
				],
				[
					function () {
						return helpers.parseColor('rgb(1, 2)');
					},
					cssError('parseColor', 'rgb(1, 2)')
				],
				[
					function () {
						return helpers.parseColor('rgb(1 2)');
					},
					cssError('parseColor', 'rgb(1 2)')
				],
				[
					function () {
						return helpers.toRgba(null as any);
					},
					new TypeError('toRgba: `input` must be a colour string or an { r, g, b } object, got null')
				],
				[
					function () {
						return helpers.toRgba({ r: 0, g: 0, b: 'x' as any });
					},
					new TypeError('toRgba: `input.b` must be a number other than NaN, got string')
				],
				[
					function () {
						return helpers.toRgba({ r: 0, g: 0, b: 0, a: NaN });
					},
					new RangeError('toRgba: `input.a` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.hslToRgb(null as any);
					},
					new TypeError('hslToRgb: `hsl` must be an { h, s, l } object, got null')
				],
				[
					function () {
						return helpers.hslToRgb(5 as any);
					},
					new TypeError('hslToRgb: `hsl` must be an { h, s, l } object, got number')
				],
				[
					function () {
						return helpers.hslToRgb({ h: 'x' as any, s: 0, l: 0 });
					},
					new TypeError('hslToRgb: `hsl.h` must be a number other than NaN, got string')
				],
				[
					function () {
						return helpers.hslToRgb({ h: Infinity, s: 0, l: 0 });
					},
					new RangeError('hslToRgb: `hsl.h` must be finite, got Infinity')
				],
				[
					function () {
						return helpers.hslToRgb({ h: 0, s: NaN, l: 0 });
					},
					new RangeError('hslToRgb: `hsl.s` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.hslToRgb({ h: 0, s: 0, l: NaN });
					},
					new RangeError('hslToRgb: `hsl.l` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.darken('#000', -1);
					},
					new RangeError('darken: `amount` must be a number in [0, 100], got -1')
				],
				[
					function () {
						return helpers.withAlpha('#000', 2);
					},
					new RangeError('withAlpha: `alpha` must be a number in [0, 1], got 2')
				],
				[
					function () {
						return helpers.meetsContrast('#000', '#fff', { level: 'A' as any });
					},
					new RangeError("meetsContrast: `level` must be 'AA' or 'AAA', got A")
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
		});
	});
});

describe('Color helpers under prototype pollution', function () {
	it('ignores inherited array indexes and object keys in their lookup tables', function () {
		const indexes = Array.prototype as unknown as Record<number, unknown>;
		const keys = Object.prototype as Record<string, unknown>;
		indexes[0] = 'x';
		indexes[255] = 0.5;
		keys['%'] = 360;
		try {
			expect(helpers.contrastRatio('#000', '#fff')).toBe(21);
			expect(function () {
				helpers.parseColor('hsl(50% 100% 50%)');
			}).toThrow(TypeError);
		} finally {
			delete indexes[0];
			delete indexes[255];
			delete keys['%'];
		}
	});

	it('reads the options of mix, lighten, darken and meetsContrast as own properties only', function () {
		const clean = [helpers.mix('#f00', '#00f'), helpers.lighten('#336699', 10), helpers.meetsContrast('#777', '#fff')];
		const keys = Object.prototype as Record<string, unknown>;
		Object.assign(keys, { space: 'oklch', hue: 'longer', level: 'AAA', largeText: true });
		try {
			expect([helpers.mix('#f00', '#00f'), helpers.lighten('#336699', 10), helpers.meetsContrast('#777', '#fff')]).toEqual(clean);
		} finally {
			for (const key of ['space', 'hue', 'level', 'largeText']) delete keys[key];
		}
	});

	it('still reads components and options from class getters, proxies and custom prototypes', function () {
		class Lch {
			constructor(private readonly coords: [number, number, number]) {}
			get l(): number {
				return this.coords[0];
			}
			get c(): number {
				return this.coords[1];
			}
			get h(): number {
				return this.coords[2];
			}
		}
		const red = { r: 255, g: 0, b: 0, a: 1 };
		expect(helpers.oklchToRgb(new Lch([0.627955, 0.257683, 29.2339]))).toEqual(red);
		const proxy = new Proxy(
			{},
			{
				get(_target, key) {
					return ({ l: 0.627955, c: 0.257683, h: 29.2339 } as Record<PropertyKey, number>)[key];
				}
			}
		);
		expect(helpers.oklchToRgb(proxy as helpers.Oklch)).toEqual(red);
		const inherited = Object.assign(Object.create({ h: 120 }), { l: 0.7, c: 0.1 }) as helpers.Oklch;
		expect(helpers.oklchToRgb(inherited)).toEqual(helpers.oklchToRgb({ l: 0.7, c: 0.1, h: 120 }));
		class MixOptions {
			get space(): 'oklch' {
				return 'oklch';
			}
		}
		expect(helpers.mix('#00f', '#ff0', 0.5, new MixOptions())).toEqual(helpers.mix('#00f', '#ff0', 0.5, { space: 'oklch' }));
		expect(function () {
			helpers.mix('#00f', '#ff0', 0.5, null as unknown as helpers.MixOptions);
		}).toThrow(TypeError);
		// Even when a polluted Object.prototype holds the same key.
		const keys = Object.prototype as Record<string, unknown>;
		keys.space = 'oklab';
		try {
			expect(helpers.mix('#00f', '#ff0', 0.5, new MixOptions())).toEqual(helpers.mix('#00f', '#ff0', 0.5, { space: 'oklch' }));
			expect(helpers.mix('#00f', '#ff0', 0.5, {})).toEqual(helpers.mix('#00f', '#ff0', 0.5, { space: 'srgb' }));
		} finally {
			delete keys.space;
		}
	});

	it('never reads a missing OKLab / OKLCH component from Object.prototype', function () {
		const keys = Object.prototype as Record<string, unknown>;
		keys.h = 250;
		keys.alpha = 0;
		keys.l = 0.5;
		try {
			expect(helpers.oklchToRgb({ l: 0.6, c: 0.1 })).toEqual(helpers.oklchToRgb({ l: 0.6, c: 0.1, h: NaN, alpha: 1 }));
			expect(helpers.oklabToRgb({ l: 0.6, a: 0.1, b: 0 }).a).toBe(1);
			expect(helpers.inGamut({ l: 0.6, c: 0.1 })).toBe(helpers.inGamut({ l: 0.6, c: 0.1, h: 0 }));
			expect(function () {
				helpers.oklchToRgb({ c: 0.1 } as unknown as helpers.Oklch);
			}).toThrow(TypeError);
		} finally {
			delete keys.h;
			delete keys.alpha;
			delete keys.l;
		}
	});

	it('never reads a missing alpha of an { r, g, b } colour from Object.prototype', function () {
		class Translucent {
			r = 255;
			g = 0;
			b = 0;
			get a(): number {
				return 0.25;
			}
		}
		const keys = Object.prototype as Record<string, unknown>;
		keys.a = 0;
		try {
			expect(helpers.toRgba({ r: 255, g: 0, b: 0 })).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.toHex({ r: 255, g: 0, b: 0 })).toBe('#ff0000');
			expect(helpers.toCssRgb({ r: 1, g: 2, b: 3 })).toBe('rgb(1 2 3)');
			expect(helpers.mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }).a).toBe(1);
			// Own and class-inherited alphas are still read, even when they hold the polluted value.
			expect(helpers.toRgba({ r: 255, g: 0, b: 0, a: 0 }).a).toBe(0);
			expect(helpers.toRgba(new Translucent()).a).toBe(0.25);
		} finally {
			delete keys.a;
		}
	});

	it('reads colour stops, domain positions and colorFromString pairs as own elements only (regression)', function () {
		// oxlint-disable-next-line no-sparse-arrays
		const stops = ['#000', , '#fff'] as string[];
		// oxlint-disable-next-line no-sparse-arrays
		const domain = [0, , 1] as number[];
		// oxlint-disable-next-line no-sparse-arrays
		const pair = [, 40] as unknown as [number, number];
		const indexes = Object.prototype as Record<number, unknown>;
		indexes[0] = 0;
		indexes[1] = '#f00';
		try {
			// Regression: a hole was read from the polluted prototype, so a planted colour or position was used instead of an error.
			expect(function () {
				helpers.colorScale(stops);
			}).toThrow(new TypeError('toRgba: `input` must be a colour string or an { r, g, b } object, got undefined'));
			expect(function () {
				helpers.colorSteps(stops, 3);
			}).toThrow(TypeError);
			indexes[1] = 0.9;
			expect(function () {
				helpers.colorScale(['#000', '#888', '#fff'], { domain });
			}).toThrow(new TypeError('colorScale: `options.domain[1]` must be a finite number > options.domain[0], got undefined'));
			indexes[1] = 40;
			expect(function () {
				helpers.colorFromString('x', { hueRange: pair });
			}).toThrow(
				new RangeError('colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got [undefined, 40]')
			);
			indexes[1] = 0.5;
			expect(function () {
				// oxlint-disable-next-line no-sparse-arrays
				helpers.colorFromString('x', { lightness: [, 0.5] as unknown as [number, number] });
			}).toThrow(new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got [undefined, 0.5]'));
		} finally {
			delete indexes[0];
			delete indexes[1];
		}
	});

	it('never reads a missing alpha planted as NaN on Object.prototype (regression)', function () {
		const keys = Object.prototype as Record<string, unknown>;
		keys.a = NaN;
		try {
			expect(helpers.toRgba({ r: 255, g: 0, b: 0 })).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBe(21);
			// An own NaN alpha is still rejected.
			expect(function () {
				helpers.toRgba({ r: 0, g: 0, b: 0, a: NaN });
			}).toThrow(RangeError);
		} finally {
			delete keys.a;
		}
	});
});

/**
 * Asserts that `actual` is within `tolerance` of `expected`, component by component.
 */
function expectClose(actual: Record<string, number>, expected: Record<string, number>, tolerance: number): void {
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
	for (const key of Object.keys(expected)) {
		if (Number.isNaN(expected[key])) expect(actual[key]).toBeNaN();
		else expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(tolerance);
	}
}

describe('OKLab / OKLCH', function () {
	describe('toOklab / toOklch', function () {
		it('match the CSS Color 4 / colorjs.io reference values', function () {
			// Chrome serializes `color-mix(in oklch, red, red)` as oklch(0.627955 0.257683 29.2339).
			expectClose(helpers.toOklch('#ff0000'), { l: 0.627955, c: 0.257683, h: 29.2339, alpha: 1 }, 1e-4);
			expectClose(helpers.toOklch('#00ff00'), { l: 0.86644, c: 0.294827, h: 142.4953, alpha: 1 }, 1e-4);
			expectClose(helpers.toOklch('#0000ff'), { l: 0.452014, c: 0.313214, h: 264.052, alpha: 1 }, 1e-4);
			// colorjs.io 0.5.2 values.
			expectClose(helpers.toOklch('#ff8000'), { l: 0.7318948471988332, c: 0.18580319653171307, h: 52.98467392023383, alpha: 1 }, 1e-12);
			expectClose(helpers.toOklab('#bada55'), { l: 0.8391183354000673, a: -0.0846062257249029, b: 0.1383463556628748, alpha: 1 }, 1e-12);
			expectClose(helpers.toOklab('#ff0000'), { l: 0.627955, a: 0.224863, b: 0.125846, alpha: 1 }, 1e-4);
		});

		it('report greys exactly on the neutral axis, with a powerless hue', function () {
			expect(helpers.toOklab('#ffffff')).toEqual({ l: 1, a: 0, b: 0, alpha: 1 });
			expect(helpers.toOklab('#000000')).toEqual({ l: 0, a: 0, b: 0, alpha: 1 });
			expect(helpers.toOklch('#000000')).toEqual({ l: 0, c: 0, h: NaN, alpha: 1 });
			let previous = -1;
			for (let value = 0; value < 256; value++) {
				const grey = { r: value, g: value, b: value };
				const lab = helpers.toOklab(grey);
				const lch = helpers.toOklch(grey);
				expect([lab.a, lab.b, lch.c, lch.h]).toEqual([0, 0, 0, NaN]);
				expect(lab.l).toBeGreaterThan(previous);
				expect(lch.l).toBe(lab.l);
				previous = lab.l;
			}
			expect(helpers.toOklch('#808080').l).toBeCloseTo(0.5998708056221469, 15);
		});

		it('keep the alpha and normalize inputs like toRgba', function () {
			expect(helpers.toOklch({ r: 0, g: 0, b: 0, a: 0.25 }).alpha).toBe(0.25);
			expect(helpers.toOklab('rgb(0 0 0 / 0)').alpha).toBe(0);
			expect(helpers.toOklch({ r: 300, g: -5, b: 0 })).toEqual(helpers.toOklch('#ff0000'));
			expect(helpers.toOklch('#300115').h).toBeGreaterThan(359.99);
			expect(helpers.toOklch('#300115').h).toBeLessThan(360);
			expect(function () {
				helpers.toOklch('nope');
			}).toThrow(TypeError);
			expect(function () {
				helpers.toOklab({ r: NaN, g: 0, b: 0 });
			}).toThrow(RangeError);
		});
	});

	describe('oklchToRgb / oklabToRgb', function () {
		it('convert in-gamut colours back exactly', function () {
			expect(helpers.oklchToRgb(helpers.toOklch('#ff8000'))).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.oklabToRgb(helpers.toOklab('rgb(1 2 3 / 0.5)'))).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
			expect(helpers.oklchToRgb({ l: 0.5, c: 0, h: NaN })).toEqual({ r: 99, g: 99, b: 99, a: 1 });
		});

		it('gamut map out-of-sRGB colours like CSS Color 4 (colorjs.io toGamut({ method: "css" }) values)', function () {
			const cases: Array<[number, number, number, [number, number, number]]> = [
				[0.9, 0.4, 145, [83, 255, 105]],
				[0.7, 0.3, 145, [0, 195, 0]],
				[0.5, 0.4, 264, [0, 51, 255]],
				[0.6, 0.35, 30, [247, 0, 0]],
				[0.4, 0.3, 300, [96, 0, 175]],
				[0.95, 0.2, 100, [255, 240, 40]],
				[0.05, 0.3, 200, [0, 1, 1]],
				[0.8, 0.37, 80, [251, 173, 0]]
			];
			for (const [l, c, h, [r, g, b]] of cases) {
				expect(helpers.oklchToRgb({ l, c, h })).toEqual({ r, g, b, a: 1 });
			}
			expect(helpers.oklabToRgb({ l: 0.5, a: -0.1, b: 0.05 })).toEqual({ r: 32, g: 117, b: 68, a: 1 });
			expect(helpers.oklabToRgb({ l: 0.7, a: 0.3, b: 0.3 })).toEqual({ r: 255, g: 97, b: 0, a: 1 });
			expect(helpers.oklabToRgb({ l: 0.3, a: -0.2, b: -0.3 })).toEqual({ r: 0, g: 50, b: 84, a: 1 });
		});

		it('clips a colour slightly out of gamut as is when clipping moves it by less than one JND (no chroma search)', function () {
			// Out of sRGB (blue above 1), but clipping it moves it by less than deltaEOK 0.02: searching the chroma would give 89, 144, 255.
			const color = { l: 0.6775777763687074, c: 0.19213904778007418, h: 263.9088823646307 };
			expect(helpers.inGamut(color)).toBe(false);
			expect(helpers.oklchToRgb(color)).toEqual({ r: 88, g: 144, b: 255, a: 1 });
		});

		it('keep the lightness and hue where plain clipping would not', function () {
			const mapped = helpers.toOklch(helpers.oklchToRgb({ l: 0.9, c: 0.4, h: 145 }));
			expect(Math.abs(mapped.l - 0.9)).toBeLessThan(0.02);
			expect(Math.abs(mapped.h - 145)).toBeLessThan(1);
			// Clipping the same colour gives #00ff00: lightness 0.866, hue 142.5.
		});

		it('map lightness >= 1 to white and <= 0 to black, whatever the chroma', function () {
			expect(helpers.oklchToRgb({ l: 1, c: 0.3, h: 30 })).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.oklchToRgb({ l: Infinity, c: 0, h: 0, alpha: 0.5 })).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
			expect(helpers.oklchToRgb({ l: 0, c: 0.3, h: 30 })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(helpers.oklchToRgb({ l: -Infinity, c: 0.3, h: 30 })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
		});

		it('handles extreme components: negative chroma counts as 0, huge chroma and hues stay finite', function () {
			expect(helpers.oklchToRgb({ l: 0.5, c: -0.1, h: 0 })).toEqual({ r: 99, g: 99, b: 99, a: 1 });
			expect(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: 1e300 })).toEqual({ r: 144, g: 73, b: 97, a: 1 });
			expect(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: -330 })).toEqual(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: 30 }));
			expect(helpers.oklchToRgb({ l: 0.5, c: Infinity, h: 30 })).toEqual({ r: 195, g: 0, b: 0, a: 1 });
			expect(helpers.oklchToRgb({ l: 0.5, c: 1e300, h: 30 })).toEqual({ r: 195, g: 0, b: 0, a: 1 });
			expect(helpers.oklabToRgb({ l: 0.5, a: Infinity, b: -Infinity })).toEqual({ r: 153, g: 0, b: 200, a: 1 });
		});

		it('read a null or missing hue as powerless, so that greys survive JSON', function () {
			const grey = JSON.parse(JSON.stringify(helpers.toOklch('#808080'))) as helpers.OklchInput;
			expect(grey.h).toBeNull();
			expect(helpers.oklchToRgb(grey)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.inGamut(grey)).toBe(true);
			expect(helpers.oklchToRgb({ l: 0.5, c: 0.1 })).toEqual(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: 0 }));
			expect(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: undefined })).toEqual(helpers.oklchToRgb({ l: 0.5, c: 0.1, h: NaN }));
			const red = JSON.parse(JSON.stringify(helpers.toOklch('#ff0000'))) as helpers.OklchInput;
			expect(helpers.oklchToRgb(red)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		});

		it('default the alpha to 1 and clamp it', function () {
			expect(helpers.oklchToRgb({ l: 1, c: 0, h: 0, alpha: 2 }).a).toBe(1);
			expect(helpers.oklabToRgb({ l: 1, a: 0, b: 0, alpha: -0 }).a).toBe(0);
			expect(Object.is(helpers.oklabToRgb({ l: 1, a: 0, b: 0, alpha: -0 }).a, 0)).toBe(true);
		});

		it('validate their argument', function () {
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.oklchToRgb(null as never);
					},
					new TypeError('oklchToRgb: `oklch` must be an { l, c, h } object, got null')
				],
				[
					function () {
						return helpers.oklchToRgb({ l: '0.5', c: 0, h: 0 } as never);
					},
					new TypeError('oklchToRgb: `oklch.l` must be a number other than NaN, got string')
				],
				[
					function () {
						return helpers.oklchToRgb({ l: 0.5, c: NaN, h: 0 });
					},
					new RangeError('oklchToRgb: `oklch.c` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.oklchToRgb({ l: 0.5, c: 0, h: Infinity });
					},
					new RangeError('oklchToRgb: `oklch.h` must be a finite number, NaN, null or undefined, got Infinity')
				],
				[
					function () {
						return helpers.oklchToRgb({ l: 0.5, c: 0, h: Symbol('h') } as never);
					},
					new TypeError('oklchToRgb: `oklch.h` must be a finite number, NaN, null or undefined, got symbol')
				],
				[
					function () {
						return helpers.oklchToRgb({ l: 0.5, c: 0, h: 0, alpha: NaN });
					},
					new RangeError('oklchToRgb: `oklch.alpha` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.oklabToRgb(5 as never);
					},
					new TypeError('oklabToRgb: `oklab` must be an { l, a, b } object, got number')
				],
				[
					function () {
						return helpers.oklabToRgb({ l: 0.5, a: 0, b: NaN });
					},
					new RangeError('oklabToRgb: `oklab.b` must be a number other than NaN, got NaN')
				],
				[
					function () {
						return helpers.oklabToRgb({ l: 0.5, a: 0, b: 0, alpha: '1' } as never);
					},
					new TypeError('oklabToRgb: `oklab.alpha` must be a number other than NaN, got string')
				],
				[
					function () {
						return helpers.inGamut({ l: 0.5, c: 0, h: -Infinity });
					},
					new RangeError('inGamut: `oklch.h` must be a finite number, NaN, null or undefined, got -Infinity')
				],
				[
					function () {
						return helpers.inGamut(undefined as never);
					},
					new TypeError('inGamut: `oklch` must be an { l, c, h } object, got undefined')
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
		});
	});

	describe('inGamut', function () {
		it('tells whether an OKLCH colour is inside sRGB, with a small tolerance', function () {
			expect(helpers.inGamut({ l: 0.627955, c: 0.257683, h: 29.2339 })).toBe(true);
			expect(helpers.inGamut({ l: 0.627955, c: 0.26, h: 29.2339 })).toBe(false);
			expect(helpers.inGamut({ l: 0.7, c: 0.3, h: 145 })).toBe(false);
			expect(helpers.inGamut({ l: 1, c: 0, h: NaN })).toBe(true);
			expect(helpers.inGamut({ l: 0, c: 0, h: 0, alpha: 0 })).toBe(true);
			expect(helpers.inGamut({ l: 1.001, c: 0, h: 0 })).toBe(false);
			expect(helpers.inGamut({ l: -0.01, c: 0, h: 0 })).toBe(true); // within the tolerance
			expect(helpers.inGamut({ l: -0.05, c: 0, h: 0 })).toBe(false);
			expect(helpers.inGamut({ l: 0.5, c: -1, h: 0 })).toBe(true);
			expect(helpers.inGamut({ l: 0.5, c: Infinity, h: 0 })).toBe(false);
			expect(helpers.inGamut({ l: Infinity, c: 0.1, h: 0 })).toBe(false);
			expect(helpers.inGamut({ l: -Infinity, c: 0, h: 0 })).toBe(false);
			expect(helpers.inGamut(helpers.toOklch('#00ff00'))).toBe(true);
		});
	});

	describe('toCssOklch', function () {
		it('formats colours, greys with a `none` hue, and translucent colours with an alpha', function () {
			expect(helpers.toCssOklch('#ff0000')).toBe('oklch(0.628 0.25768 29.23)');
			expect(helpers.toCssOklch('#ff8000')).toBe('oklch(0.7319 0.1858 52.98)');
			expect(helpers.toCssOklch('#ffffff')).toBe('oklch(1 0 none)');
			expect(helpers.toCssOklch('#000000')).toBe('oklch(0 0 none)');
			expect(helpers.toCssOklch('#00000080')).toBe('oklch(0 0 none / 0.502)');
		});

		it('writes a hue that rounds to 360 as 0', function () {
			expect(helpers.toCssOklch('#300115')).toBe('oklch(0.2021 0.07918 0)');
			expect(helpers.parseColor(helpers.toCssOklch('#300115'))).toEqual({ r: 48, g: 1, b: 21, a: 1 });
		});
	});

	describe('parseColor with oklab() and oklch()', function () {
		it('parses numbers, percentages, angles, none and alpha', function () {
			expect(helpers.parseColor('oklch(62.8% 0.2577 29.23)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('oklch(0.7319 0.1858 52.98)')).toEqual({ r: 255, g: 128, b: 0, a: 1 });
			expect(helpers.parseColor('oklch(50% 50% 0.25turn)')).toEqual(helpers.parseColor('oklch(0.5 0.2 90)'));
			expect(helpers.parseColor('oklch(0.5 0.2 100grad)')).toEqual(helpers.parseColor('oklch(0.5 0.2 90deg)'));
			expect(helpers.parseColor('OKLCH( 0.5 0.2 1.5RAD / .5 )')).toEqual({ ...helpers.oklchToRgb({ l: 0.5, c: 0.2, h: (1.5 * 180) / Math.PI }), a: 0.5 });
			expect(helpers.parseColor('oklab(50% 25% -25%)')).toEqual(helpers.parseColor('oklab(0.5 0.1 -0.1)'));
			expect(helpers.parseColor('oklab(0.5 -0.1 0.05 / 50%)')).toEqual({ r: 32, g: 117, b: 68, a: 0.5 });
			expect(helpers.parseColor('oklch(none none none)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('oklch(0.6 none 30 / none)')).toEqual({ r: 128, g: 128, b: 128, a: 0 });
			expect(helpers.parseColor('oklab(1 0 0)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.parseColor('\n oklch(1e-1 1E-1 -3.6e2)\t')).toEqual(helpers.oklchToRgb({ l: 0.1, c: 0.1, h: 0 }));
		});

		it('clamps the lightness and a negative chroma, and gamut maps', function () {
			expect(helpers.parseColor('oklch(150% 0.2 30)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.parseColor('oklab(-1 0.2 0.2)')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('oklch(0.6 -0.2 30)')).toEqual(helpers.parseColor('oklch(0.6 0 30)'));
			expect(helpers.parseColor('oklch(0.9 0.4 145)')).toEqual({ r: 83, g: 255, b: 105, a: 1 });
			expect(helpers.parseColor('oklch(0.5 1e300 30)')).toEqual({ r: 195, g: 0, b: 0, a: 1 });
			expect(helpers.parseColor('oklab(0.5 1e300 -1e300)')).toEqual({ r: 153, g: 0, b: 200, a: 1 });
		});

		it('rejects invalid syntax', function () {
			for (const input of [
				'oklch(0.5, 0.2, 30)',
				'oklab(0.5, 0, 0)',
				'oklch(0.5 0.2)',
				'oklch(0.5 0.2 30 40)',
				'oklch(0.5 0.2 30%)',
				'oklch(0.5deg 0.2 30)',
				'oklch(0.5 0.2deg 30)',
				'oklab(0.5 0 0deg)',
				'oklab(0.5 0deg 0)',
				'oklch(0.5 0.2 30 / 1deg)',
				'oklcha(0.5 0.2 30)',
				'oklch (0.5 0.2 30)',
				'oklch(0.5 0.2 1e999)',
				'lab(50 20 20)',
				'lch(50 20 20)'
			]) {
				expect(function () {
					helpers.parseColor(input);
				}).toThrow(TypeError);
			}
		});

		it('ignores inherited hue units', function () {
			const keys = Object.prototype as Record<string, unknown>;
			keys['%'] = 360;
			try {
				expect(function () {
					helpers.parseColor('oklch(0.5 0.1 50%)');
				}).toThrow(TypeError);
			} finally {
				delete keys['%'];
			}
		});
	});

	describe('mix in OKLab / OKLCH', function () {
		it('matches colorjs.io (premultiplied, gamut mapped) for opaque colours', function () {
			const cases: Array<[string, string, number, helpers.MixOptions, [number, number, number]]> = [
				['#0000ff', '#ffff00', 0.5, { space: 'oklab' }, [108, 171, 199]],
				['#0000ff', '#ffff00', 0.5, { space: 'oklch' }, [0, 189, 176]],
				['#0000ff', '#ffff00', 0.5, { space: 'oklch', hue: 'shorter' }, [0, 189, 176]],
				['#0000ff', '#ffff00', 0.5, { space: 'oklch', hue: 'longer' }, [255, 85, 138]],
				['#ff0000', '#00ff00', 0.3, { space: 'oklch', hue: 'increasing' }, [233, 127, 0]],
				['#ff0000', '#00ff00', 0.3, { space: 'oklch', hue: 'decreasing' }, [218, 84, 255]],
				['#ff0000', '#00ff00', 0.3, { space: 'oklch', hue: 'longer' }, [218, 84, 255]],
				['#00ff00', '#ff0000', 0.3, { space: 'oklch', hue: 'shorter' }, [200, 196, 0]],
				['#00ff00', '#ff0000', 0.3, { space: 'oklch', hue: 'increasing' }, [0, 212, 255]],
				['#0000ff', '#ff0000', 0.4, { space: 'oklch' }, [161, 0, 213]],
				['#ff0000', '#808080', 0.5, { space: 'oklch' }, [198, 99, 86]],
				['#ffffff', '#0000ff', 0.25, { space: 'oklch' }, [184, 210, 255]],
				['#000000', '#ffffff', 0.5, { space: 'oklab' }, [99, 99, 99]]
			];
			for (const [a, b, weight, options, [r, g, blue]] of cases) {
				expect(helpers.mix(a, b, weight, options)).toEqual({ r, g, b: blue, a: 1 });
			}
		});

		it('keeps the defaults and the endpoints', function () {
			expect(helpers.mix('#0000ff', '#ffff00', 0.5, {})).toEqual(helpers.mix('#0000ff', '#ffff00'));
			expect(helpers.mix('#0000ff', '#ffff00', 0.5, { space: 'srgb', hue: 'longer' })).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			for (const space of ['oklab', 'oklch'] as const) {
				expect(helpers.mix('#123456', '#fedcba', 0, { space })).toEqual(helpers.toRgba('#123456'));
				expect(helpers.mix('#123456', '#fedcba', 1, { space })).toEqual(helpers.toRgba('#fedcba'));
			}
		});

		it('uses the other hue for greys (powerless hue), in every hue method', function () {
			const blue = helpers.toOklch('#0000ff').h;
			for (const hue of ['shorter', 'increasing', 'decreasing'] as const) {
				expect(Math.abs(helpers.toOklch(helpers.mix('#808080', '#0000ff', 0.5, { space: 'oklch', hue })).h - blue)).toBeLessThan(1);
				// (8-bit rounding of a light colour moves its hue a little.)
				expect(Math.abs(helpers.toOklch(helpers.mix('#0000ff', '#ffffff', 0.5, { space: 'oklch', hue })).h - blue)).toBeLessThan(2);
			}
			// Equal hues are a full turn apart along the longer arc (CSS Color 4): the midpoint has the opposite hue.
			// (Same result as colorjs.io.)
			expect(helpers.mix('#808080', '#0000ff', 0.5, { space: 'oklch', hue: 'longer' })).toEqual({ r: 141, g: 98, b: 0, a: 1 });
			expect(helpers.mix('#000000', '#ffffff', 0.5, { space: 'oklch' })).toEqual({ r: 99, g: 99, b: 99, a: 1 });
		});

		it('premultiplies alpha: mixing with transparent keeps the colour', function () {
			expect(helpers.mix('#ff0000', 'transparent', 0.5, { space: 'oklch' })).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
			expect(helpers.mix('transparent', '#0000ff', 0.25, { space: 'oklab' })).toEqual({ r: 0, g: 0, b: 255, a: 0.25 });
			expect(helpers.mix({ r: 255, g: 0, b: 0, a: 0.2 }, { r: 0, g: 0, b: 255, a: 1 }, 0.5, { space: 'oklab' })).toEqual({ r: 59, g: 61, b: 225, a: 0.6 });
			// The hue is not premultiplied (CSS Color 4): it moves with the weight.
			expect(helpers.toOklch(helpers.mix({ r: 255, g: 0, b: 0, a: 0.2 }, '#0000ff', 0.5, { space: 'oklch' })).h).toBeGreaterThan(300);
		});

		it('interpolates straight when both colours are fully transparent', function () {
			const red = { r: 255, g: 0, b: 0, a: 0 };
			const blue = { r: 0, g: 0, b: 255, a: 0 };
			expect(helpers.mix(red, blue, 0.5, { space: 'oklab' })).toEqual({ r: 140, g: 83, b: 162, a: 0 });
			expect(helpers.mix(red, blue, 0.5, { space: 'oklch' })).toEqual({ ...helpers.mix('#ff0000', '#0000ff', 0.5, { space: 'oklch' }), a: 0 });
		});

		it('validates the options', function () {
			expect(function () {
				helpers.mix('#000', '#fff', 0.5, { space: 'lab' as never });
			}).toThrow(new RangeError("mix: `options.space` must be 'srgb', 'oklab' or 'oklch', got lab"));
			expect(function () {
				helpers.mix('#000', '#fff', 0.5, { hue: {} as never });
			}).toThrow(new RangeError("mix: `options.hue` must be 'shorter', 'longer', 'increasing' or 'decreasing', got object"));
		});
	});

	describe('lighten / darken in OKLCH', function () {
		it('changes the OKLCH lightness, keeping chroma and hue (gamut mapped) and alpha', function () {
			expect(helpers.lighten('#000000', 50, { space: 'oklch' })).toEqual({ r: 99, g: 99, b: 99, a: 1 });
			expect(helpers.lighten('#ff0000', 10, { space: 'oklch' })).toEqual({ r: 255, g: 109, b: 91, a: 1 });
			expect(helpers.darken('#ff0000', 30, { space: 'oklch' })).toEqual({ r: 112, g: 0, b: 0, a: 1 });
			expect(helpers.darken('#3366cc80', 10, { space: 'oklch' })).toEqual({ r: 23, g: 71, b: 171, a: 128 / 255 });
			expect(helpers.lighten('#3366cc', 100, { space: 'oklch' })).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.darken('#3366cc', 100, { space: 'oklch' })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			const darker = helpers.toOklch(helpers.darken('#3366cc', 10, { space: 'oklch' }));
			expect(Math.abs(darker.h - helpers.toOklch('#3366cc').h)).toBeLessThan(1);
			expect(Math.abs(darker.l - (helpers.toOklch('#3366cc').l - 0.1))).toBeLessThan(0.005);
		});

		it('keeps the HSL default and validates the space', function () {
			expect(helpers.lighten('#ff0000', 20, { space: 'hsl' })).toEqual(helpers.lighten('#ff0000', 20));
			expect(helpers.darken('#ff0000', 20, {})).toEqual({ r: 153, g: 0, b: 0, a: 1 });
			expect(function () {
				helpers.lighten('#000', 10, { space: 'lab' as never });
			}).toThrow(new RangeError("lighten: `options.space` must be 'hsl' or 'oklch', got lab"));
			expect(function () {
				helpers.darken('#000', 10, { space: 'oklab' as never });
			}).toThrow(new RangeError("darken: `options.space` must be 'hsl' or 'oklch', got oklab"));
		});
	});
});

describe('Color scales, names, adjustments and HSV', function () {
	describe('colorScale', function () {
		it('interpolates between the stops spread evenly over [0, 1], clamping outside', function () {
			const scale = helpers.colorScale(['#0000ff', '#ffffff', '#ff0000']);
			expect(scale(0)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(scale(0.25)).toEqual({ r: 128, g: 128, b: 255, a: 1 });
			expect(scale(0.5)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(scale(0.75)).toEqual({ r: 255, g: 128, b: 128, a: 1 });
			expect(scale(1)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(scale(-1)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(scale(-Infinity)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(scale(Infinity)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		});

		it('returns a new object on every call, and is not affected by later changes to its arguments', function () {
			const first = { r: 10, g: 20, b: 30 };
			const stops: helpers.ColorInput[] = [first, '#fff'];
			const domain = [0, 10];
			const scale = helpers.colorScale(stops, { domain });
			const middleDomain = [0, 5, 10];
			const middle = helpers.colorScale(['#000', '#888', '#fff'], { domain: middleDomain });
			middleDomain[1] = 9;
			expect(middle(5)).toEqual({ r: 0x88, g: 0x88, b: 0x88, a: 1 });
			const a = scale(0);
			a.r = 99;
			first.r = 50;
			stops[0] = '#000';
			domain[1] = 1;
			expect(scale(0)).toEqual({ r: 10, g: 20, b: 30, a: 1 });
			expect(scale(10)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(scale(0)).not.toBe(scale(0));
			expect(scale(10)).not.toBe(scale(10));
		});

		it('places the stops at the domain positions (one per stop, or the two ends)', function () {
			const scale = helpers.colorScale(['#000000', '#808080', '#ffffff'], { domain: [0, 0.2, 1] });
			expect(scale(0.1)).toEqual({ r: 64, g: 64, b: 64, a: 1 });
			expect(scale(0.2)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(scale(0.6)).toEqual({ r: 192, g: 192, b: 192, a: 1 });
			const spread = helpers.colorScale(['#000000', '#808080', '#ffffff'], { domain: [100, 200] });
			expect(spread(150)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(spread(125)).toEqual({ r: 64, g: 64, b: 64, a: 1 });
			expect(spread(50)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			expect(helpers.colorScale(['#000', '#fff'], { domain: [-1e308, 1e308] })(0)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			// Subnormal positions (regression: halving them lost their differences).
			expect(helpers.colorScale(['#000', '#888', '#fff'], { domain: [-1.5e-323, -1e-323, -5e-324] })(-1e-323)).toEqual({ r: 136, g: 136, b: 136, a: 1 });
			expect(helpers.colorScale(['#000', '#fff'], { domain: [5e-324, 1.5e-323] })(1e-323)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.colorScale(['#000', '#fff'], { domain: [0, 1.5e-323] })(5e-324)).toEqual({ r: 85, g: 85, b: 85, a: 1 });
			expect(helpers.colorScale(['#000', '#fff'], { domain: [-Number.MAX_VALUE, Number.MAX_VALUE] })(Number.MAX_VALUE / 2)).toEqual({
				r: 191,
				g: 191,
				b: 191,
				a: 1
			});
		});

		it('finds the right segment among many stops', function () {
			const stops = Array.from({ length: 11 }, function (_, i) {
				return { r: i * 25, g: 0, b: 0 };
			});
			const scale = helpers.colorScale(stops);
			for (let i = 0; i < 10; i++) {
				expect(scale((i + 0.4) / 10)).toEqual({ r: i * 25 + 10, g: 0, b: 0, a: 1 });
			}
		});

		it('makes a constant scale from a single stop', function () {
			const scale = helpers.colorScale(['#123456']);
			for (const t of [-1, 0, 0.5, 1, 2]) expect(scale(t)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 1 });
			expect(helpers.colorScale(['#123456'], { domain: [0, 10] })(5)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 1 });
			expect(helpers.colorScale(['#123456'], { domain: [3] })(5)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 1 });
		});

		it('interpolates in the requested space, with alpha', function () {
			expect(helpers.colorScale(['#0000ff', '#ffff00'], { space: 'oklch' })(0.5)).toEqual(helpers.mix('#0000ff', '#ffff00', 0.5, { space: 'oklch' }));
			expect(helpers.colorScale(['#ff0000', '#00ff00'], { space: 'oklch', hue: 'longer' })(0.5)).toEqual(
				helpers.mix('#ff0000', '#00ff00', 0.5, { space: 'oklch', hue: 'longer' })
			);
			expect(helpers.colorScale(['#000', '#fff'], { space: 'oklab' })(0.5)).toEqual({ r: 99, g: 99, b: 99, a: 1 });
			expect(helpers.colorScale(['transparent', '#ff0000'], { space: 'oklab' })(0.5)).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
		});

		it('validates its arguments when created, and t when called', function () {
			expect(function () {
				helpers.colorScale('#fff' as never);
			}).toThrow(new TypeError('colorScale: `stops` must be an array of colours, got string'));
			expect(function () {
				helpers.colorScale([]);
			}).toThrow(new RangeError('colorScale: `stops` must hold at least one colour, got an empty array'));
			expect(function () {
				helpers.colorScale(['#fff', 'nope']);
			}).toThrow(TypeError);
			expect(function () {
				helpers.colorScale(new Array(2));
			}).toThrow(TypeError);
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { space: 'lab' as never });
			}).toThrow(new RangeError("colorScale: `options.space` must be 'srgb', 'oklab' or 'oklch', got lab"));
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { hue: 'up' as never });
			}).toThrow(RangeError);
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { domain: '0,1' as never });
			}).toThrow(new TypeError('colorScale: `options.domain` must be an array of numbers, got string'));
			expect(function () {
				helpers.colorScale(['#000', '#888', '#fff'], { domain: [0, 0.5, 0.7, 1] });
			}).toThrow(new RangeError('colorScale: `options.domain` must hold 2 or 3 positions (one per stop), got 4'));
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { domain: [1, 1] });
			}).toThrow(new RangeError('colorScale: `options.domain[1]` must be a finite number > options.domain[0], got 1'));
			expect(function () {
				helpers.colorScale(['#000', '#888', '#fff'], { domain: [0, 2, 1] });
			}).toThrow(new RangeError('colorScale: `options.domain[2]` must be a finite number > options.domain[1], got 1'));
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { domain: [NaN, 1] });
			}).toThrow(new RangeError('colorScale: `options.domain[0]` must be a finite number, got NaN'));
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { domain: [0, Infinity] });
			}).toThrow(RangeError);
			expect(function () {
				helpers.colorScale(['#000', '#fff'], { domain: [0, '1'] as never });
			}).toThrow(new TypeError('colorScale: `options.domain[1]` must be a finite number > options.domain[0], got string'));
			const scale = helpers.colorScale(['#000', '#fff']);
			expect(function () {
				scale(NaN);
			}).toThrow(new RangeError('colorScale: `t` must be a number other than NaN, got NaN'));
			expect(function () {
				scale('0.5' as never);
			}).toThrow(new TypeError('colorScale: `t` must be a number other than NaN, got string'));
		});

		it('ignores options inherited from a polluted Object.prototype', function () {
			const proto = Object.prototype as Record<string, unknown>;
			proto.domain = [0, 100];
			proto.space = 'oklab';
			try {
				expect(helpers.colorScale(['#000', '#fff'])(0.5)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			} finally {
				delete proto.domain;
				delete proto.space;
			}
		});
	});

	describe('colorSteps', function () {
		it('samples evenly, both ends included', function () {
			expect(
				helpers.colorSteps(['#000000', '#ffffff'], 5).map(function (color) {
					return helpers.toHex(color);
				})
			).toEqual(['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff']);
			expect(helpers.colorSteps(['#ff0000', '#0000ff'], 2)).toEqual([
				{ r: 255, g: 0, b: 0, a: 1 },
				{ r: 0, g: 0, b: 255, a: 1 }
			]);
			expect(helpers.colorSteps(['#ff0000', '#0000ff'], 1)).toEqual([{ r: 255, g: 0, b: 0, a: 1 }]);
			expect(helpers.colorSteps(['#ff0000', '#0000ff'], 0)).toEqual([]);
		});

		it('samples over the domain, so uneven stops shape the palette', function () {
			expect(helpers.colorSteps(['#000000', '#808080', '#ffffff'], 3, { domain: [0, 0.25, 1] })).toEqual([
				{ r: 0, g: 0, b: 0, a: 1 },
				{ r: 170, g: 170, b: 170, a: 1 },
				{ r: 255, g: 255, b: 255, a: 1 }
			]);
			expect(helpers.colorSteps(['#000000', '#ffffff'], 3, { domain: [-1e308, 1e308] })[2]).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			expect(helpers.colorSteps(['#abcdef'], 3)).toEqual([
				{ r: 0xab, g: 0xcd, b: 0xef, a: 1 },
				{ r: 0xab, g: 0xcd, b: 0xef, a: 1 },
				{ r: 0xab, g: 0xcd, b: 0xef, a: 1 }
			]);
		});

		it('validates count and the scale arguments', function () {
			expect(function () {
				helpers.colorSteps(['#000'], 2.5);
			}).toThrow(new RangeError('colorSteps: `count` must be an integer >= 0, got 2.5'));
			expect(function () {
				helpers.colorSteps(['#000'], -1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.colorSteps(['#000'], '3' as never);
			}).toThrow(TypeError);
			expect(function () {
				helpers.colorSteps([], 3);
			}).toThrow(new RangeError('colorSteps: `stops` must hold at least one colour, got an empty array'));
		});
	});

	describe('isCssColor', function () {
		it('accepts exactly what parseColor accepts', function () {
			for (const value of ['#fff', 'fff', '#ff000080', 'rgb(1 2 3)', 'rgba(1, 2, 3, 0.5)', 'hsl(0 0% 0%)', 'oklch(0.5 0.1 30)', 'oklab(0.5 0 0)', ' TRANSPARENT ']) {
				expect(helpers.isCssColor(value)).toBe(true);
			}
			for (const value of ['', 'red', '#ff', 'rgb(1, 2)', 'rgb(1 2 3', 'hsl(1, 2, 3)', 'rgb(1e999 0 0)', ' #fff']) {
				expect(helpers.isCssColor(value)).toBe(false);
			}
		});

		it('returns false for non-strings without throwing', function () {
			for (const value of [undefined, null, 0, 0xffffff, {}, { r: 0, g: 0, b: 0 }, ['#fff'], Symbol('x')]) {
				expect(helpers.isCssColor(value)).toBe(false);
			}
		});

		it('narrows the type', function () {
			const value: unknown = '#fff';
			if (helpers.isCssColor(value)) expect(value.length).toBe(4);
		});
	});

	describe('parseNamedColor', function () {
		it('parses the CSS named colours, case-insensitively and ignoring CSS white space', function () {
			expect(helpers.parseNamedColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.parseNamedColor('RebeccaPurple')).toEqual({ r: 102, g: 51, b: 153, a: 1 });
			expect(helpers.parseNamedColor('\t lightgoldenrodyellow \n')).toEqual({ r: 250, g: 250, b: 210, a: 1 });
			expect(helpers.parseNamedColor('aliceblue')).toEqual({ r: 240, g: 248, b: 255, a: 1 });
			expect(helpers.parseNamedColor('yellowgreen')).toEqual({ r: 154, g: 205, b: 50, a: 1 });
			expect(helpers.parseNamedColor('grey')).toEqual(helpers.parseNamedColor('gray'));
			expect(helpers.parseNamedColor('TRANSPARENT')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
		});

		it('returns a new object each time', function () {
			const a = helpers.parseNamedColor('red') as helpers.Rgba;
			a.r = 0;
			expect(helpers.parseNamedColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		});

		it('returns undefined for anything else', function () {
			for (const value of [
				'',
				'#ff0000',
				'rgb(255 0 0)',
				'redd',
				're d',
				'currentcolor',
				'\u212Ahaki',
				'pin\u212A',
				' red',
				'red ',
				'__proto__',
				'constructor',
				'toString',
				'hasOwnProperty',
				'a'.repeat(21),
				'lightgoldenrodyellowx'
			]) {
				expect(helpers.parseNamedColor(value)).toBeUndefined();
			}
		});

		it('throws a TypeError for non-strings', function () {
			expect(function () {
				helpers.parseNamedColor(1 as never);
			}).toThrow(new TypeError('parseNamedColor: `name` must be a string, got number'));
		});
	});

	describe('toColorName', function () {
		it('names exact matches, the first name alphabetically for duplicates', function () {
			expect(helpers.toColorName('#ff0000')).toBe('red');
			expect(helpers.toColorName({ r: 0, g: 255, b: 255 })).toBe('aqua');
			expect(helpers.toColorName('#ff00ff')).toBe('fuchsia');
			expect(helpers.toColorName('#a9a9a9')).toBe('darkgray');
			expect(helpers.toColorName('#2f4f4f')).toBe('darkslategray');
			expect(helpers.toColorName('#9acd32')).toBe('yellowgreen');
			expect(helpers.toColorName('#f0f8ff')).toBe('aliceblue');
			expect(helpers.toColorName('#ff0000ff')).toBe('red');
		});

		it('requires an opaque exact match, and names only transparent black transparent', function () {
			expect(helpers.toColorName('#ff0001')).toBeUndefined();
			expect(helpers.toColorName('#ff0000fe')).toBeUndefined();
			expect(helpers.toColorName({ r: 0, g: 0, b: 0, a: 0 })).toBe('transparent');
			expect(helpers.toColorName({ r: 255, g: 0, b: 0, a: 0 })).toBeUndefined();
			expect(helpers.toColorName({ r: 0, g: 0, b: 0, a: 0.5 })).toBeUndefined();
		});

		it('finds the nearest name in OKLab, ignoring alpha', function () {
			expect(helpers.toColorName('#ff0001', { nearest: true })).toBe('red');
			expect(helpers.toColorName('#00ffff', { nearest: true })).toBe('aqua');
			expect(helpers.toColorName('#010101', { nearest: true })).toBe('black');
			expect(helpers.toColorName('#fefefe', { nearest: true })).toBe('white');
			expect(helpers.toColorName({ r: 102, g: 51, b: 150, a: 0.2 }, { nearest: true })).toBe('rebeccapurple');
			expect(helpers.toColorName('transparent', { nearest: true })).toBe('black');
			expect(helpers.toColorName('#ff0001', { nearest: false })).toBeUndefined();
		});

		it('validates the colour and ignores a polluted Object.prototype', function () {
			expect(function () {
				helpers.toColorName('red');
			}).toThrow(TypeError);
			const proto = Object.prototype as Record<string, unknown>;
			proto.nearest = true;
			try {
				expect(helpers.toColorName('#ff0001')).toBeUndefined();
			} finally {
				delete proto.nearest;
			}
		});
	});

	describe('saturate / desaturate / grayscale', function () {
		it('changes the HSL saturation, clamped to [0, 100], keeping alpha', function () {
			expect(helpers.saturate('#996666', 20)).toEqual({ r: 179, g: 77, b: 77, a: 1 });
			expect(helpers.saturate('#ff0000', 50)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
			expect(helpers.saturate('#80808080', 100)).toEqual({ r: 255, g: 1, b: 1, a: 128 / 255 });
			expect(helpers.desaturate('#ff0000', 50)).toEqual({ r: 191, g: 64, b: 64, a: 1 });
			expect(helpers.desaturate('#ff0000', 100)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.grayscale('#ff0000')).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.grayscale('#0000ff80')).toEqual({ r: 128, g: 128, b: 128, a: 128 / 255 });
			expect(helpers.saturate({ r: 10, g: 20, b: 30, a: 0.5 }, 0)).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
			expect(helpers.desaturate({ r: 10, g: 20, b: 30, a: 0.5 }, 0)).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
		});

		it('changes the OKLCH chroma (100 points = 0.4), keeping lightness and hue', function () {
			const base = helpers.toOklch('#996666');
			const more = helpers.toOklch(helpers.saturate('#996666', 5, { space: 'oklch' }));
			expect(Math.abs(more.c - (base.c + 0.02))).toBeLessThan(0.003);
			expect(Math.abs(more.l - base.l)).toBeLessThan(0.005);
			expect(Math.abs(more.h - base.h)).toBeLessThan(1);
			expect(helpers.grayscale('#ffff00', { space: 'oklch' })).toEqual({ r: 244, g: 244, b: 244, a: 1 });
			expect(helpers.grayscale('#0000ff', { space: 'oklch' })).toEqual({ r: 86, g: 86, b: 86, a: 1 });
			expect(helpers.desaturate('#0000ff', 100, { space: 'oklch' })).toEqual(helpers.grayscale('#0000ff', { space: 'oklch' }));
			expect(helpers.saturate('#ff0000', 100, { space: 'oklch' })).toEqual({ r: 255, g: 0, b: 0, a: 1 });
		});

		it('validates amount and space', function () {
			for (const amount of [-1, 101, NaN]) {
				expect(function () {
					helpers.saturate('#000', amount);
				}).toThrow(RangeError);
				expect(function () {
					helpers.desaturate('#000', amount);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.saturate('#000', '1' as never);
			}).toThrow(new TypeError('saturate: `amount` must be a number in [0, 100], got string'));
			expect(function () {
				helpers.desaturate('#000', 101);
			}).toThrow(new RangeError('desaturate: `amount` must be a number in [0, 100], got 101'));
			expect(function () {
				helpers.saturate('#000', 1, { space: 'lab' as never });
			}).toThrow(new RangeError("saturate: `options.space` must be 'hsl' or 'oklch', got lab"));
			expect(function () {
				helpers.desaturate('#000', 1, { space: 'lab' as never });
			}).toThrow(new RangeError("desaturate: `options.space` must be 'hsl' or 'oklch', got lab"));
			expect(function () {
				helpers.grayscale('#000', { space: 'lab' as never });
			}).toThrow(new RangeError("grayscale: `options.space` must be 'hsl' or 'oklch', got lab"));
			expect(function () {
				helpers.grayscale('nope');
			}).toThrow(TypeError);
		});
	});

	describe('rotateHue / complement', function () {
		it('rotates the HSL hue, wrapping around, keeping alpha', function () {
			expect(helpers.rotateHue('#ff0000', 120)).toEqual({ r: 0, g: 255, b: 0, a: 1 });
			expect(helpers.rotateHue('#ff0000', -120)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(helpers.rotateHue('#ff0000', 360 * 1e6 + 240)).toEqual({ r: 0, g: 0, b: 255, a: 1 });
			expect(helpers.rotateHue('#ff000080', 360)).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
			expect(helpers.rotateHue('#808080', 90)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.complement('#ff0000')).toEqual({ r: 0, g: 255, b: 255, a: 1 });
			expect(helpers.complement('#336699')).toEqual({ r: 153, g: 102, b: 51, a: 1 });
		});

		it('rotates the OKLCH hue, keeping lightness, and leaves greys alone', function () {
			const rotated = helpers.toOklch(helpers.rotateHue('#3366cc', 90, { space: 'oklch' }));
			const base = helpers.toOklch('#3366cc');
			expect(Math.abs(rotated.l - base.l)).toBeLessThan(0.01);
			expect(Math.abs((((rotated.h - base.h) % 360) + 360) % 360) - 90).toBeLessThan(1);
			expect(helpers.rotateHue('#808080', 90, { space: 'oklch' })).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.complement('#808080', { space: 'oklch' })).toEqual({ r: 128, g: 128, b: 128, a: 1 });
			expect(helpers.complement({ r: 255, g: 0, b: 0, a: 0.5 }, { space: 'oklch' })).toEqual({ r: 0, g: 156, b: 178, a: 0.5 });
		});

		it('validates degrees and space', function () {
			for (const degrees of [NaN, Infinity, -Infinity]) {
				expect(function () {
					helpers.rotateHue('#000', degrees);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.rotateHue('#000', '90' as never);
			}).toThrow(new TypeError('rotateHue: `degrees` must be a finite number, got string'));
			expect(function () {
				helpers.rotateHue('#000', 1, { space: 'oklab' as never });
			}).toThrow(new RangeError("rotateHue: `options.space` must be 'hsl' or 'oklch', got oklab"));
			expect(function () {
				helpers.complement('#000', { space: 'oklab' as never });
			}).toThrow(new RangeError("complement: `options.space` must be 'hsl' or 'oklch', got oklab"));
		});
	});

	describe('rgbToHsv / hsvToRgb', function () {
		it('converts to HSV', function () {
			expect(helpers.rgbToHsv('#ff0000')).toEqual({ h: 0, s: 100, v: 100 });
			expect(helpers.rgbToHsv('#00ff00')).toEqual({ h: 120, s: 100, v: 100 });
			expect(helpers.rgbToHsv('#0000ff')).toEqual({ h: 240, s: 100, v: 100 });
			expect(helpers.rgbToHsv('#ff00ff')).toEqual({ h: 300, s: 100, v: 100 });
			expect(helpers.rgbToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
			expect(helpers.rgbToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 100 });
			expect(helpers.rgbToHsv('#808080')).toEqual({ h: 0, s: 0, v: (128 / 255) * 100 });
			expect(helpers.rgbToHsv({ r: 300, g: -1, b: 0, a: 0.5 })).toEqual({ h: 0, s: 100, v: 100 });
		});

		it('converts from HSV, normalizing the hue and clamping saturation and value', function () {
			expect(helpers.hsvToRgb({ h: 0, s: 100, v: 100 })).toEqual({ r: 255, g: 0, b: 0 });
			expect(helpers.hsvToRgb({ h: 60, s: 100, v: 100 })).toEqual({ r: 255, g: 255, b: 0 });
			expect(helpers.hsvToRgb({ h: 180, s: 100, v: 50 })).toEqual({ r: 0, g: 128, b: 128 });
			expect(helpers.hsvToRgb({ h: 300, s: 50, v: 100 })).toEqual({ r: 255, g: 128, b: 255 });
			expect(helpers.hsvToRgb({ h: 720 + 240, s: 100, v: 100 })).toEqual({ r: 0, g: 0, b: 255 });
			expect(helpers.hsvToRgb({ h: -60, s: 150, v: 200 })).toEqual({ r: 255, g: 0, b: 255 });
			expect(helpers.hsvToRgb({ h: 0, s: -5, v: -5 })).toEqual({ r: 0, g: 0, b: 0 });
			expect(Object.is(helpers.hsvToRgb({ h: -0, s: -0, v: -0 }).r, 0)).toBe(true);
		});

		it('validates the HSV object', function () {
			expect(function () {
				helpers.hsvToRgb(null as never);
			}).toThrow(new TypeError('hsvToRgb: `hsv` must be an { h, s, v } object, got null'));
			expect(function () {
				helpers.hsvToRgb({ h: Infinity, s: 0, v: 0 });
			}).toThrow(new RangeError('hsvToRgb: `hsv.h` must be finite, got Infinity'));
			expect(function () {
				helpers.hsvToRgb({ h: 0, s: NaN, v: 0 });
			}).toThrow(new RangeError('hsvToRgb: `hsv.s` must be a number other than NaN, got NaN'));
			expect(function () {
				helpers.hsvToRgb({ h: 0, s: 0, v: '1' as never });
			}).toThrow(new TypeError('hsvToRgb: `hsv.v` must be a number other than NaN, got string'));
			expect(function () {
				helpers.rgbToHsv(5 as never);
			}).toThrow(TypeError);
			expect(function () {
				helpers.hsvToRgb(5 as never);
			}).toThrow(new TypeError('hsvToRgb: `hsv` must be an { h, s, v } object, got number'));
			expect(function () {
				helpers.hsvToRgb({ h: '0', s: 0, v: 0 } as never);
			}).toThrow(new TypeError('hsvToRgb: `hsv.h` must be a number other than NaN, got string'));
		});
	});
});

/** Sharma, Wu & Dalal (2005), Table 1: the 34 CIEDE2000 test pairs (L1 a1 b1 L2 a2 b2 ΔE00), from ciede2000testdata.txt. */
const SHARMA_PAIRS = [
	'50.0000 2.6772 -79.7751 50.0000 0.0000 -82.7485 2.0425',
	'50.0000 3.1571 -77.2803 50.0000 0.0000 -82.7485 2.8615',
	'50.0000 2.8361 -74.0200 50.0000 0.0000 -82.7485 3.4412',
	'50.0000 -1.3802 -84.2814 50.0000 0.0000 -82.7485 1.0000',
	'50.0000 -1.1848 -84.8006 50.0000 0.0000 -82.7485 1.0000',
	'50.0000 -0.9009 -85.5211 50.0000 0.0000 -82.7485 1.0000',
	'50.0000 0.0000 0.0000 50.0000 -1.0000 2.0000 2.3669',
	'50.0000 -1.0000 2.0000 50.0000 0.0000 0.0000 2.3669',
	'50.0000 2.4900 -0.0010 50.0000 -2.4900 0.0009 7.1792',
	'50.0000 2.4900 -0.0010 50.0000 -2.4900 0.0010 7.1792',
	'50.0000 2.4900 -0.0010 50.0000 -2.4900 0.0011 7.2195',
	'50.0000 2.4900 -0.0010 50.0000 -2.4900 0.0012 7.2195',
	'50.0000 -0.0010 2.4900 50.0000 0.0009 -2.4900 4.8045',
	'50.0000 -0.0010 2.4900 50.0000 0.0010 -2.4900 4.8045',
	'50.0000 -0.0010 2.4900 50.0000 0.0011 -2.4900 4.7461',
	'50.0000 2.5000 0.0000 50.0000 0.0000 -2.5000 4.3065',
	'50.0000 2.5000 0.0000 73.0000 25.0000 -18.0000 27.1492',
	'50.0000 2.5000 0.0000 61.0000 -5.0000 29.0000 22.8977',
	'50.0000 2.5000 0.0000 56.0000 -27.0000 -3.0000 31.9030',
	'50.0000 2.5000 0.0000 58.0000 24.0000 15.0000 19.4535',
	'50.0000 2.5000 0.0000 50.0000 3.1736 0.5854 1.0000',
	'50.0000 2.5000 0.0000 50.0000 3.2972 0.0000 1.0000',
	'50.0000 2.5000 0.0000 50.0000 1.8634 0.5757 1.0000',
	'50.0000 2.5000 0.0000 50.0000 3.2592 0.3350 1.0000',
	'60.2574 -34.0099 36.2677 60.4626 -34.1751 39.4387 1.2644',
	'63.0109 -31.0961 -5.8663 62.8187 -29.7946 -4.0864 1.2630',
	'61.2901 3.7196 -5.3901 61.4292 2.2480 -4.9620 1.8731',
	'35.0831 -44.1164 3.7933 35.0232 -40.0716 1.5901 1.8645',
	'22.7233 20.0904 -46.6940 23.0331 14.9730 -42.5619 2.0373',
	'36.4612 47.8580 18.3852 36.2715 50.5065 21.2231 1.4146',
	'90.8027 -2.0831 1.4410 91.1528 -1.6435 0.0447 1.4441',
	'90.9257 -0.5406 -0.9208 88.6381 -0.8985 -0.7239 1.5381',
	'6.7747 -0.2908 -2.4247 5.8714 -0.0985 -2.2286 0.6377',
	'2.0776 0.0795 -1.1350 0.9033 -0.0636 -0.5514 0.9082'
].map(function (line) {
	return line.split(' ').map(Number);
});

/** Machado, Oliveira & Fernandes (2009), the published simulation matrices for severities 0, 0.1, … 1 (row-major, 6 decimals). */
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
 * The published Machado et al. matrix for a tabulated severity (0 to 10 tenths).
 */
function machado(type: 'protanopia' | 'deuteranopia' | 'tritanopia', tenths: number): number[] {
	return MACHADO[type][tenths].split(' ').map(Number);
}

/**
 * Applies a row-major 3×3 matrix to a colour in linear sRGB, as the CVD simulation must: linearize, multiply, clip, encode, round.
 */
function applyLinear(matrix: readonly number[], color: helpers.Rgb): number[] {
	function linear(channel: number): number {
		const unit = channel / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	}
	function encode(value: number): number {
		const clipped = Math.min(Math.max(value, 0), 1);
		return Math.round((clipped <= 0.0031308 ? clipped * 12.92 : 1.055 * clipped ** (1 / 2.4) - 0.055) * 255);
	}
	const rgb = [linear(color.r), linear(color.g), linear(color.b)];
	return [0, 1, 2].map(function (row) {
		return encode(matrix[row * 3] * rgb[0] + matrix[row * 3 + 1] * rgb[1] + matrix[row * 3 + 2] * rgb[2]);
	});
}

describe('Colour difference, colours from strings and colour vision deficiencies', function () {
	describe('toLab', function () {
		it('matches the CSS Color 4 / colorjs.io CIELAB (D50, Bradford) reference values', function () {
			expectClose(helpers.toLab('#ff0000'), { l: 54.2905, a: 80.8049, b: 69.891, alpha: 1 }, 0.0001);
			expectClose(helpers.toLab('#00ff00'), { l: 87.8185, a: -79.2711, b: 80.9946, alpha: 1 }, 0.0001);
			expectClose(helpers.toLab('#0000ff'), { l: 29.5683, a: 68.2874, b: -112.0297, alpha: 1 }, 0.0001);
			expect(helpers.toLab('#ffffff')).toEqual({ l: 100, a: 0, b: 0, alpha: 1 });
			expect(helpers.toLab('#000000')).toEqual({ l: 0, a: 0, b: 0, alpha: 1 });
		});

		it('gives greys exactly a = b = 0, keeps alpha, and is monotonic in the grey level', function () {
			let previous = -1;
			for (let level = 0; level <= 255; level++) {
				const lab = helpers.toLab({ r: level, g: level, b: level, a: 0.25 });
				expect([lab.a, lab.b, lab.alpha]).toEqual([0, 0, 0.25]);
				expect(lab.l).toBeGreaterThan(previous);
				expect(lab.l).toBeLessThanOrEqual(100);
				previous = lab.l;
			}
			// The linear segment of the CIELAB companding (Y <= 216/24389): #010101 has L = 903.3 * Y.
			expect(helpers.toLab('#010101').l).toBeCloseTo((24389 / 27) * (1 / 255 / 12.92), 12);
			expect(helpers.toLab('#000000').l).toBe(0);
		});

		it('handles colours whose a or b component falls in the linear segment', function () {
			// Nearly-black blue: X and Y below ε, Z above it.
			const lab = helpers.toLab({ r: 0, g: 0, b: 40 });
			expect(lab.l).toBeGreaterThan(0);
			expect(lab.b).toBeLessThan(0);
			expect(lab.a).toBeGreaterThan(0);
		});
	});

	describe('ciede2000', function () {
		it('matches all 34 test pairs of Sharma, Wu & Dalal (2005) to 4 decimals, in both orders', function () {
			for (const [l1, a1, b1, l2, a2, b2, expected] of SHARMA_PAIRS) {
				const forward = helpers.ciede2000({ l: l1, a: a1, b: b1 }, { l: l2, a: a2, b: b2 });
				expect(forward.toFixed(4)).toBe(expected.toFixed(4));
				expect(helpers.ciede2000({ l: l2, a: a2, b: b2 }, { l: l1, a: a1, b: b1 })).toBe(forward);
			}
		});

		it('is 0 for identical colours, ignores alpha, and handles greys and opposite hues', function () {
			expect(helpers.ciede2000({ l: 50, a: 0, b: 0 }, { l: 50, a: 0, b: 0 })).toBe(0);
			expect(helpers.ciede2000({ l: 50, a: 10, b: -3, alpha: 0 }, { l: 50, a: 10, b: -3 })).toBe(0);
			expect(helpers.ciede2000({ l: 0, a: 0, b: 0 }, { l: 100, a: 0, b: 0 })).toBe(100);
			// -0 components: the hue of a grey is 0, not atan2(0, -0) = 180°.
			expect(helpers.ciede2000({ l: 50, a: -0, b: 0 }, { l: 50, a: 10, b: 0 })).toBe(helpers.ciede2000({ l: 50, a: 0, b: 0 }, { l: 50, a: 10, b: 0 }));
			// Hues exactly 180° apart, either way round, and a hue just below 360°.
			const opposite = helpers.ciede2000({ l: 50, a: 10, b: 0 }, { l: 50, a: -10, b: 0 });
			expect(opposite).toBe(helpers.ciede2000({ l: 50, a: -10, b: 0 }, { l: 50, a: 10, b: 0 }));
			expect(opposite.toFixed(4)).toBe('26.0273');
			expect(helpers.ciede2000({ l: 50, a: 10, b: -1e-300 }, { l: 50, a: 10, b: 0 })).toBeCloseTo(0, 12);
			// Far outside any gamut, the chroma weights do not overflow.
			expect(Number.isFinite(helpers.ciede2000({ l: 0, a: 1e100, b: 0 }, { l: 0, a: 0, b: 0 }))).toBe(true);
			expect(helpers.ciede2000({ l: 0, a: 1e-300, b: 0 }, { l: 0, a: 0, b: 0 })).toBeCloseTo(0, 12);
		});

		it('rejects non-objects and non-finite components', function () {
			const lab = { l: 50, a: 0, b: 0 };
			expect(function () {
				helpers.ciede2000(null as unknown as helpers.Lab, lab);
			}).toThrow(new TypeError('ciede2000: `first` must be an { l, a, b } object, got null'));
			expect(function () {
				helpers.ciede2000(lab, '#fff' as unknown as helpers.Lab);
			}).toThrow(new TypeError('ciede2000: `second` must be an { l, a, b } object, got string'));
			expect(function () {
				helpers.ciede2000({ l: '50', a: 0, b: 0 } as unknown as helpers.Lab, lab);
			}).toThrow(new TypeError('ciede2000: `first.l` must be a finite number, got string'));
			expect(function () {
				helpers.ciede2000(lab, { l: 50, a: NaN, b: 0 });
			}).toThrow(new RangeError('ciede2000: `second.a` must be a finite number, got NaN'));
			expect(function () {
				helpers.ciede2000(lab, { l: 50, a: 0, b: -Infinity });
			}).toThrow(new RangeError('ciede2000: `second.b` must be a finite number, got -Infinity'));
			expect(function () {
				helpers.ciede2000({ l: 50, a: 0 } as helpers.Lab, lab);
			}).toThrow(new TypeError('ciede2000: `first.b` must be a finite number, got undefined'));
		});
	});

	describe('deltaE', function () {
		it('defaults to deltaEOK, unscaled (black to white is 1)', function () {
			expect(helpers.deltaE('#000', '#fff')).toBe(1);
			expect(helpers.deltaE('#000', '#fff', {})).toBe(1);
			expect(helpers.deltaE('#f00', '#f00')).toBe(0);
			const red = helpers.toOklab('#ff0000');
			const blue = helpers.toOklab('#0000ff');
			expect(helpers.deltaE('#ff0000', '#0000ff', { method: 'ok' })).toBeCloseTo(Math.hypot(red.l - blue.l, red.a - blue.a, red.b - blue.b), 14);
			expect(helpers.deltaE('#ff0000', '#0000ff').toFixed(4)).toBe('0.5371');
		});

		it('computes CIE76 and CIEDE2000 on CIELAB D50 coordinates', function () {
			const red = helpers.toLab('#ff0000');
			const blue = helpers.toLab('#0000ff');
			expect(helpers.deltaE('#ff0000', '#0000ff', { method: '76' })).toBeCloseTo(Math.hypot(red.l - blue.l, red.a - blue.a, red.b - blue.b), 12);
			expect(helpers.deltaE('#ff0000', '#0000ff', { method: '2000' })).toBe(helpers.ciede2000(red, blue));
			expect(helpers.deltaE('#000', '#fff', { method: '76' })).toBe(100);
			expect(helpers.deltaE('#000', '#fff', { method: '2000' })).toBe(100);
			expect(helpers.deltaE('#123456', { r: 0x12, g: 0x34, b: 0x56, a: 0 }, { method: '2000' })).toBe(0);
			// The formulas disagree on saturated colours: CIE76 overstates their differences.
			expect(helpers.deltaE('#ff0000', '#0000ff', { method: '76' })).toBeGreaterThan(3 * helpers.deltaE('#ff0000', '#0000ff', { method: '2000' }));
		});

		it('rejects unknown methods and invalid colours', function () {
			expect(function () {
				helpers.deltaE('#000', '#fff', { method: 'cmc' as helpers.DeltaEMethod });
			}).toThrow(new RangeError("deltaE: `options.method` must be 'ok', '2000' or '76', got cmc"));
			expect(function () {
				helpers.deltaE('#000', '#fff', { method: 2000 as unknown as helpers.DeltaEMethod });
			}).toThrow(new RangeError("deltaE: `options.method` must be 'ok', '2000' or '76', got 2000"));
			expect(function () {
				helpers.deltaE('#000', 'red');
			}).toThrow(TypeError);
			expect(function () {
				helpers.deltaE({ r: NaN, g: 0, b: 0 }, '#fff', { method: '76' });
			}).toThrow(RangeError);
		});
	});

	describe('colorFromString', function () {
		it('pins reference outputs (any change of hash or mapping breaks stored colours)', function () {
			const reference: Array<[string, string, string, string, string]> = [
				['', '#2aa8f2', '#60839d', '#007cc2', '#39b3fd'],
				['a', '#eb7957', '#00b1a9', '#c35433', '#fe8a67'],
				['A', '#a7a507', '#0093a4', '#7d7a00', '#b1af21'],
				['user1', '#948ff8', '#71a5dd', '#716acf', '#a3a0ff'],
				['user2', '#d478c6', '#7d93be', '#ae55a2', '#e78ad8'],
				['user3', '#aba300', '#6cc0cb', '#807900', '#b5ae1c'],
				['Ada Lovelace', '#7cb145', '#20525c', '#528409', '#83b94d'],
				['ñandú', '#9f8cf4', '#4da7ff', '#7c67cb', '#af9cff'],
				['日本語', '#d179cb', '#3058a8', '#ab57a6', '#e48bdd'],
				['😀', '#d78c01', '#699ea0', '#aa6600', '#e69a24'],
				['x'.repeat(1000), '#3db973', '#66c6e2', '#008846', '#45c079']
			];
			for (const [text, plain, ranged, readable, light] of reference) {
				expect(helpers.colorFromString(text)).toBe(plain);
				expect(helpers.colorFromString(text, { lightness: [0.4, 0.8], chroma: [0.05, 0.2], hueRange: [180, 270] })).toBe(ranged);
				expect(helpers.colorFromString(text, { contrastWith: '#ffffff' })).toBe(readable);
				expect(helpers.colorFromString(text, { contrastWith: '#000', minContrast: 9 })).toBe(light);
			}
		});

		it('returns an opaque Rgba object with format rgb, and the same colour as the hex string', function () {
			const color = helpers.colorFromString('Ada Lovelace', { format: 'rgb' });
			expect(color).toEqual({ r: 124, g: 177, b: 69, a: 1 });
			expect(helpers.toHex(color)).toBe(helpers.colorFromString('Ada Lovelace', { format: 'hex' }));
			expect(helpers.colorFromString('Ada Lovelace', { format: 'rgb' })).not.toBe(color);
		});

		it('uses fixed values and ends of ranges as given', function () {
			const fixed = helpers.toOklch(helpers.colorFromString('tag', { lightness: 0.5, chroma: 0, hueRange: [10, 10] }));
			expect(fixed.c).toBe(0);
			expect(helpers.colorFromString('tag', { lightness: 0, chroma: 0.4 })).toBe('#000000');
			expect(helpers.colorFromString('tag', { lightness: 1 })).toBe('#ffffff');
			expect(helpers.colorFromString('tag', { lightness: [0.6, 0.6] })).toBe(helpers.colorFromString('tag', { lightness: 0.6 }));
			expect(helpers.colorFromString('tag', { chroma: [0.1, 0.1] })).toBe(helpers.colorFromString('tag', { chroma: 0.1 }));
			expect(helpers.colorFromString('tag', { hueRange: [0, 360] })).toBe(helpers.colorFromString('tag'));
			expect(helpers.colorFromString('tag', { hueRange: [-360, 0] })).toBe(helpers.colorFromString('tag'));
			expect(helpers.colorFromString('tag', { hueRange: [720, 1080] })).toBe(helpers.colorFromString('tag'));
			// A zero-width hue range gives that hue.
			const hue = helpers.toOklch(helpers.colorFromString('tag', { hueRange: [145, 145], chroma: 0.1 })).h;
			expect(Math.abs(hue - 145)).toBeLessThan(1);
		});

		it('spreads hues evenly, and similar strings far apart', function () {
			const buckets = new Array<number>(12).fill(0);
			let gaps = 0;
			let previous = NaN;
			for (let i = 0; i < 6000; i++) {
				const hue = helpers.toOklch(helpers.colorFromString(`user${i}`, { chroma: 0.05 })).h;
				buckets[Math.floor(hue / 30) % 12]++;
				if (i > 0) gaps += 180 - Math.abs(180 - Math.abs(hue - previous));
				previous = hue;
			}
			for (const count of buckets) expect(Math.abs(count - 500)).toBeLessThan(90);
			// Independent hues are 90° apart on average.
			expect(gaps / 5999).toBeGreaterThan(80);
		});

		it('encodes the string as UTF-8, with lone surrogates as U+FFFD', function () {
			expect(helpers.colorFromString('\ud800')).toBe(helpers.colorFromString('�'));
			expect(helpers.colorFromString('a\udc00b')).toBe(helpers.colorFromString('a�b'));
			expect(helpers.colorFromString('\ud83d')).toBe(helpers.colorFromString('�'));
			expect(helpers.colorFromString('\ud83d\ud83d')).toBe(helpers.colorFromString('��'));
			expect(helpers.colorFromString('😀')).not.toBe(helpers.colorFromString('��'));
		});

		it('guarantees the contrast against contrastWith, moving lightness the better way', function () {
			for (const [background, ratio] of [
				['#ffffff', 4.5],
				['#000000', 7],
				['#777777', 4.6],
				['#1e3a8a', 3],
				['#fde68a', 21 / 2]
			] as const) {
				for (let i = 0; i < 50; i++) {
					const color = helpers.colorFromString(`name ${i}`, { contrastWith: background, minContrast: ratio });
					expect(helpers.contrastRatio(color, background)).toBeGreaterThanOrEqual(ratio);
				}
			}
			// Against #777, black reaches more contrast than white: colours get darker.
			const plain = helpers.colorFromString('Ada Lovelace', { lightness: 0.6 });
			const darker = helpers.colorFromString('Ada Lovelace', { lightness: 0.6, contrastWith: '#777', minContrast: 4.6 });
			expect(helpers.relativeLuminance(darker)).toBeLessThan(helpers.relativeLuminance(plain));
			// Against a dark background, lighter.
			const lighter = helpers.colorFromString('Ada Lovelace', { lightness: 0.3, contrastWith: '#000' });
			expect(helpers.relativeLuminance(lighter)).toBeGreaterThan(helpers.relativeLuminance(helpers.colorFromString('Ada Lovelace', { lightness: 0.3 })));
			// Already readable: unchanged.
			expect(helpers.colorFromString('Ada Lovelace', { lightness: 0.2, contrastWith: '#fff' })).toBe(helpers.colorFromString('Ada Lovelace', { lightness: 0.2 }));
			// minContrast 1 always holds; the extremes are reachable exactly.
			expect(helpers.colorFromString('Ada Lovelace', { contrastWith: '#fff', minContrast: 1 })).toBe(helpers.colorFromString('Ada Lovelace'));
			expect(helpers.colorFromString('Ada Lovelace', { contrastWith: '#fff', minContrast: 21 })).toBe('#000000');
			expect(helpers.colorFromString('Ada Lovelace', { contrastWith: '#000', minContrast: 21 })).toBe('#ffffff');
			expect(helpers.colorFromString('Ada Lovelace', { contrastWith: '#fff', minContrast: 21, format: 'rgb' })).toEqual({ r: 0, g: 0, b: 0, a: 1 });
			// A translucent background counts as opaque.
			expect(helpers.colorFromString('x', { contrastWith: 'rgb(255 255 255 / 0)' })).toBe(helpers.colorFromString('x', { contrastWith: '#fff' }));
		});

		it('rejects invalid arguments with clear messages', function () {
			const cases: Array<[() => unknown, Error]> = [
				[
					function () {
						return helpers.colorFromString(42 as unknown as string);
					},
					new TypeError('colorFromString: `text` must be a string, got number')
				],
				[
					function () {
						return helpers.colorFromString('x', { format: 'hsl' as 'hex' });
					},
					new RangeError("colorFromString: `options.format` must be 'hex' or 'rgb', got hsl")
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: 1.5 });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them, got 1.5')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: -0.1 });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them, got -0.1')
				],
				[
					function () {
						return helpers.colorFromString('x', { chroma: NaN });
					},
					new RangeError('colorFromString: `options.chroma` must be a number in [0, 0.4] or a [min, max] pair of them, got NaN')
				],
				[
					function () {
						return helpers.colorFromString('x', { chroma: '0.1' as unknown as number });
					},
					new TypeError('colorFromString: `options.chroma` must be a number in [0, 0.4] or a [min, max] pair of them, got string')
				],
				[
					function () {
						return helpers.colorFromString('x', { chroma: [0.2, 0.1] });
					},
					new RangeError('colorFromString: `options.chroma` must be a number in [0, 0.4] or a [min, max] pair of them with min <= max, got [0.2, 0.1]')
				],
				[
					function () {
						return helpers.colorFromString('x', { chroma: [0.1, 0.5] });
					},
					new RangeError('colorFromString: `options.chroma` must be a number in [0, 0.4] or a [min, max] pair of them with min <= max, got [0.1, 0.5]')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: [-0.1, 0.5] });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got [-0.1, 0.5]')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: [0.1, 0.5, 0.7] as unknown as [number, number] });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got an array of length 3')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: [0.1, '0.5'] as unknown as [number, number] });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got [0.1, 0.5]')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: ['0.1', 0.5] as unknown as [number, number] });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got [0.1, 0.5]')
				],
				[
					function () {
						return helpers.colorFromString('x', { lightness: [0.5] as unknown as [number, number] });
					},
					new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got an array of length 1')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: 90 as unknown as [number, number] });
					},
					new TypeError('colorFromString: `options.hueRange` must be a [start, end] pair of degrees, got number')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: [90, 30] });
					},
					new RangeError('colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got [90, 30]')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: [0, 361] });
					},
					new RangeError('colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got [0, 361]')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: [0, Infinity] });
					},
					new RangeError('colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got [0, Infinity]')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: [NaN, 10] });
					},
					new RangeError('colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got [NaN, 10]')
				],
				[
					function () {
						return helpers.colorFromString('x', { hueRange: [0, 10, 20] as unknown as [number, number] });
					},
					new RangeError(
						'colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got an array of length 3'
					)
				],
				[
					function () {
						return helpers.colorFromString('x', { minContrast: 3 });
					},
					new TypeError('colorFromString: `options.contrastWith` must be a colour when `options.minContrast` is set, got undefined')
				],
				[
					function () {
						return helpers.colorFromString('x', { contrastWith: '#fff', minContrast: 0.5 });
					},
					new RangeError('colorFromString: `options.minContrast` must be a number in [1, 21], got 0.5')
				],
				[
					function () {
						return helpers.colorFromString('x', { contrastWith: '#fff', minContrast: 22 });
					},
					new RangeError('colorFromString: `options.minContrast` must be a number in [1, 21], got 22')
				],
				[
					function () {
						return helpers.colorFromString('x', { contrastWith: '#777', minContrast: 7 });
					},
					new RangeError(`colorFromString: \`options.minContrast\` must be at most ${helpers.contrastRatio('#777', '#000')} against \`options.contrastWith\`, got 7`)
				],
				[
					function () {
						return helpers.colorFromString('x', { contrastWith: '#888', minContrast: 6 });
					},
					new RangeError(`colorFromString: \`options.minContrast\` must be at most ${helpers.contrastRatio('#888', '#000')} against \`options.contrastWith\`, got 6`)
				]
			];
			for (const [fn, error] of cases) expect(fn).toThrow(error);
			expect(function () {
				helpers.colorFromString('x', { contrastWith: 'red' });
			}).toThrow(TypeError);
			// Security: an attacker-sized array is described by its length, not written out.
			expect(function () {
				helpers.colorFromString('x', { chroma: new Array(100_000).fill(0) as unknown as [number, number] });
			}).toThrow(
				new RangeError('colorFromString: `options.chroma` must be a number in [0, 0.4] or a [min, max] pair of them with min <= max, got an array of length 100000')
			);
			expect(function () {
				helpers.colorFromString('x', { hueRange: new Array(100_000).fill(0) as unknown as [number, number] });
			}).toThrow(
				new RangeError(
					'colorFromString: `options.hueRange` must be a [start, end] pair of finite degrees with start <= end <= start + 360, got an array of length 100000'
				)
			);
			// eslint-disable-next-line no-sparse-arrays
			const sparse = [, 0.5] as unknown as [number, number];
			expect(function () {
				helpers.colorFromString('x', { lightness: sparse });
			}).toThrow(new RangeError('colorFromString: `options.lightness` must be a number in [0, 1] or a [min, max] pair of them with min <= max, got [undefined, 0.5]'));
		});
	});

	describe('simulateColorVisionDeficiency', function () {
		it('stores the published Machado, Oliveira & Fernandes (2009) matrices digit for digit', function () {
			// The source keeps the matrices in millionths: parse them back and compare with the published 6-decimal table.
			const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
			// A static check of the real file: Stryker's instrumented copy wraps every negative literal in a mutant switch.
			if (source.includes('stryMutAct_')) return;
			for (const [name, type] of [
				['PROTAN', 'protanopia'],
				['DEUTAN', 'deuteranopia'],
				['TRITAN', 'tritanopia']
			] as const) {
				const literal = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
				expect(literal).not.toBeNull();
				const values = (literal as RegExpExecArray)[1].split(',').map(Number);
				expect(values).toHaveLength(90);
				for (let tenths = 1; tenths <= 10; tenths++) {
					expect(
						values.slice((tenths - 1) * 9, tenths * 9).map(function (value) {
							return value / 1e6;
						})
					).toEqual(machado(type, tenths));
				}
			}
		});

		it('the published matrices keep white white (every row sums to 1 within their rounding)', function () {
			for (const type of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
				for (let tenths = 0; tenths <= 10; tenths++) {
					const matrix = machado(type, tenths);
					for (let row = 0; row < 3; row++) expect(Math.abs(matrix[row * 3] + matrix[row * 3 + 1] + matrix[row * 3 + 2] - 1)).toBeLessThanOrEqual(1.5e-6);
					expect(helpers.simulateColorVisionDeficiency('#ffffff', type, tenths / 10)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
					expect(helpers.simulateColorVisionDeficiency('#000000', type, tenths / 10)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
				}
			}
		});

		it('applies the published matrices in linear sRGB at every tabulated severity', function () {
			const colors = ['#ff0000', '#00ff00', '#0000ff', '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999'];
			for (const type of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
				for (let tenths = 0; tenths <= 10; tenths++) {
					for (const color of colors) {
						const { r, g, b } = helpers.simulateColorVisionDeficiency(color, type, tenths / 10);
						const expected = applyLinear(machado(type, tenths), helpers.toRgba(color));
						for (const [index, channel] of [r, g, b].entries()) expect(Math.abs(channel - expected[index])).toBeLessThanOrEqual(1);
					}
				}
			}
			expect(helpers.simulateColorVisionDeficiency('#ff0000', 'protanopia')).toEqual({ r: 109, g: 95, b: 0, a: 1 });
			expect(helpers.simulateColorVisionDeficiency('#ff0000', 'deuteranopia')).toEqual({ r: 163, g: 144, b: 0, a: 1 });
			expect(helpers.simulateColorVisionDeficiency('#ff0000', 'tritanopia')).toEqual({ r: 255, g: 0, b: 15, a: 1 });
			expect(helpers.simulateColorVisionDeficiency('#0000ff', 'tritanopia', 1)).toEqual({ r: 0, g: 107, b: 150, a: 1 });
		});

		it('interpolates linearly between tabulated severities', function () {
			const between = helpers.simulateColorVisionDeficiency('#4daf4a', 'deuteranopia', 0.35);
			const low = machado('deuteranopia', 3);
			const high = machado('deuteranopia', 4);
			const expected = applyLinear(
				low.map(function (value, index) {
					return (value + high[index]) / 2;
				}),
				helpers.toRgba('#4daf4a')
			);
			for (const [index, channel] of [between.r, between.g, between.b].entries()) expect(Math.abs(channel - expected[index])).toBeLessThanOrEqual(1);
			// Below 0.1: between the identity and the 0.1 matrix.
			const slight = helpers.simulateColorVisionDeficiency('#ff0000', 'protanopia', 0.05);
			expect(slight.r).toBeLessThan(255);
			expect(slight.r).toBeGreaterThan(helpers.simulateColorVisionDeficiency('#ff0000', 'protanopia', 0.1).r);
		});

		it('turns colours into the grey of the same luminance for achromatopsia', function () {
			expect(helpers.simulateColorVisionDeficiency('#ff0000', 'achromatopsia')).toEqual({ r: 127, g: 127, b: 127, a: 1 });
			expect(helpers.simulateColorVisionDeficiency('#ffffff', 'achromatopsia')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
			const half = helpers.simulateColorVisionDeficiency('#ff0000', 'achromatopsia', 0.5);
			expect(half.r).toBeGreaterThan(127);
			expect(half.g).toBeGreaterThan(0);
			expect(half.g).toBeLessThan(127);
			expect(half.g).toBe(half.b);
		});

		it('returns the colour unchanged at severity 0, keeps alpha, and defaults to severity 1', function () {
			for (const type of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'] as const) {
				expect(helpers.simulateColorVisionDeficiency({ r: 12, g: 200, b: 99, a: 0.3 }, type, 0)).toEqual({ r: 12, g: 200, b: 99, a: 0.3 });
				expect(helpers.simulateColorVisionDeficiency('#4daf4a80', type).a).toBe(128 / 255);
				expect(helpers.simulateColorVisionDeficiency('#4daf4a', type)).toEqual(helpers.simulateColorVisionDeficiency('#4daf4a', type, 1));
			}
		});

		it('rejects unknown types and invalid severities', function () {
			expect(function () {
				helpers.simulateColorVisionDeficiency('#fff', 'colorblind' as helpers.ColorVisionDeficiency);
			}).toThrow(new RangeError("simulateColorVisionDeficiency: `type` must be 'protanopia', 'deuteranopia', 'tritanopia' or 'achromatopsia', got colorblind"));
			expect(function () {
				helpers.simulateColorVisionDeficiency('#fff', 'protanopia', 1.1);
			}).toThrow(new RangeError('simulateColorVisionDeficiency: `severity` must be a number in [0, 1], got 1.1'));
			expect(function () {
				helpers.simulateColorVisionDeficiency('#fff', 'achromatopsia', -0.1);
			}).toThrow(new RangeError('simulateColorVisionDeficiency: `severity` must be a number in [0, 1], got -0.1'));
			expect(function () {
				helpers.simulateColorVisionDeficiency('#fff', 'tritanopia', NaN);
			}).toThrow(RangeError);
			expect(function () {
				helpers.simulateColorVisionDeficiency('#fff', 'tritanopia', '1' as unknown as number);
			}).toThrow(new TypeError('simulateColorVisionDeficiency: `severity` must be a number in [0, 1], got string'));
			expect(function () {
				helpers.simulateColorVisionDeficiency('nope', 'deuteranopia');
			}).toThrow(TypeError);
		});
	});

	describe('under prototype pollution', function () {
		it('reads the options and Lab components as own properties only', function () {
			const clean = [helpers.deltaE('#f00', '#00f'), helpers.colorFromString('Ada'), helpers.ciede2000({ l: 50, a: 1, b: 2 }, { l: 60, a: 3, b: 4 })];
			const keys = Object.prototype as Record<string, unknown>;
			Object.assign(keys, { method: '76', format: 'rgb', lightness: 0.1, chroma: 0.4, hueRange: [0, 10], contrastWith: '#fff', minContrast: 21 });
			try {
				expect([helpers.deltaE('#f00', '#00f'), helpers.colorFromString('Ada'), helpers.ciede2000({ l: 50, a: 1, b: 2 }, { l: 60, a: 3, b: 4 })]).toEqual(clean);
				keys.l = 50;
				expect(function () {
					helpers.ciede2000({ a: 0, b: 0 } as helpers.Lab, { l: 50, a: 0, b: 0 });
				}).toThrow(TypeError);
			} finally {
				for (const key of ['method', 'format', 'lightness', 'chroma', 'hueRange', 'contrastWith', 'minContrast', 'l']) delete keys[key];
			}
		});

		it('still reads options and components from class getters', function () {
			class Options {
				get method(): '2000' {
					return '2000';
				}
				get format(): 'rgb' {
					return 'rgb';
				}
			}
			class Point {
				get l(): number {
					return 50;
				}
				get a(): number {
					return 2.5;
				}
				get b(): number {
					return 0;
				}
			}
			expect(helpers.deltaE('#f00', '#00f', new Options())).toBe(helpers.deltaE('#f00', '#00f', { method: '2000' }));
			expect(helpers.colorFromString('Ada', new Options())).toEqual(helpers.colorFromString('Ada', { format: 'rgb' }));
			expect(helpers.ciede2000(new Point(), { l: 50, a: 0, b: -2.5 }).toFixed(4)).toBe('4.3065');
		});
	});
});

describe('Colour difference and colours from strings: edge cases', function () {
	it('ciede2000 takes the mean hue the short way round when hues straddle 0° (Sharma, Wu & Dalal, eq. 14)', function () {
		// Conjugate colours: hues θ and 360° - θ, whose sum is exactly 360°: the mean hue is 0°, not 360°.
		expect(helpers.ciede2000({ l: 50, a: 20, b: 5 }, { l: 60, a: 40, b: -10 })).toBeCloseTo(15.527956416660242, 11);
		expect(helpers.ciede2000({ l: 50, a: 20, b: 0.5 }, { l: 50, a: 30, b: -1 })).toBeCloseTo(5.091413242701706, 11);
		// Hues more than 180° apart with a sum below and above 360°.
		expect(helpers.ciede2000({ l: 40, a: -20, b: 30 }, { l: 45, a: 15, b: -30 })).toBeCloseTo(42.69230806853317, 11);
		expect(helpers.ciede2000({ l: 60, a: 1, b: 30 }, { l: 55, a: -2, b: -31 })).toBeCloseTo(42.01146551297721, 11);
	});

	it('ciede2000 names the right argument and component in its errors', function () {
		const lab = { l: 50, a: 0, b: 0 };
		expect(function () {
			helpers.ciede2000(42 as unknown as helpers.Lab, lab);
		}).toThrow(new TypeError('ciede2000: `first` must be an { l, a, b } object, got number'));
		expect(function () {
			helpers.ciede2000(lab, null as unknown as helpers.Lab);
		}).toThrow(new TypeError('ciede2000: `second` must be an { l, a, b } object, got null'));
		expect(function () {
			helpers.ciede2000({ l: 50, a: Infinity, b: 0 }, lab);
		}).toThrow(new RangeError('ciede2000: `first.a` must be a finite number, got Infinity'));
		expect(function () {
			helpers.ciede2000(lab, { l: -Infinity, a: 0, b: 0 });
		}).toThrow(new RangeError('ciede2000: `second.l` must be a finite number, got -Infinity'));
	});

	it('colorFromString hashes the UTF-8 encoding exactly at every encoding boundary', function () {
		/** The documented hash, over `TextEncoder` bytes. */
		function hash(text: string): number {
			let value = 0x811c9dc5;
			for (const octet of new TextEncoder().encode(text)) value = Math.imul(value ^ octet, 16777619);
			value ^= value >>> 16;
			value = Math.imul(value, 0x85ebca6b);
			value ^= value >>> 13;
			value = Math.imul(value, 0xc2b2ae35);
			return (value ^ (value >>> 16)) >>> 0;
		}
		const samples = [
			'\u007f',
			'\u0080',
			'߿',
			'ࠀ',
			'퟿',
			'\ud800',
			'\udbff',
			'\udc00',
			'\udfff',
			'',
			'￿',
			'𐀀',
			'􏿿',
			'\ud800\udbff',
			'\udc00\udc00',
			'\udbff',
			'\ud800\udbffx',
			'a\ud800'
		];
		for (const text of samples) {
			const expected = helpers.toHex(helpers.oklchToRgb({ l: 0.7, c: 0.15, h: ((hash(text) >>> 16) / 65536) * 360 }));
			expect([text, helpers.colorFromString(text)]).toEqual([text, expected]);
		}
	});

	it('colorFromString accepts the ends of the lightness and chroma ranges', function () {
		expect(helpers.colorFromString('tag', { lightness: [0.5, 1], chroma: [0, 0.4] })).toMatch(/^#[0-9a-f]{6}$/);
		expect(helpers.colorFromString('tag', { lightness: [1, 1] })).toBe('#ffffff');
	});

	it('colorFromString keeps a colour whose contrast equals minContrast exactly, and stops at the exact threshold', function () {
		const plain = helpers.colorFromString('Ada Lovelace');
		const exact = helpers.contrastRatio(plain, '#123456');
		expect(helpers.colorFromString('Ada Lovelace', { contrastWith: '#123456', minContrast: exact })).toBe(plain);
		// Even at the very edge of its 8-bit level (lightness 0.56412 is the boundary between #757575 and #767676).
		const edge = { chroma: 0, lightness: 0.56413 };
		expect(helpers.colorFromString('x', edge)).toBe('#767676');
		expect(helpers.colorFromString('x', { ...edge, contrastWith: '#fff', minContrast: helpers.contrastRatio('#767676', '#fff') })).toBe('#767676');
		// Greys: every lightness that rounds to #767676 has exactly its contrast with white, so the search ends on it (not on #757575).
		const threshold = helpers.contrastRatio('#767676', '#fff');
		expect(helpers.colorFromString('x', { chroma: 0, contrastWith: '#fff', minContrast: threshold })).toBe('#767676');
		expect(helpers.colorFromString('x', { chroma: 0, contrastWith: '#000', minContrast: helpers.contrastRatio('#767676', '#000') })).toBe('#9e9e9e');
		expect(helpers.colorFromString('x', { chroma: 0, lightness: 0.3, contrastWith: '#000', minContrast: helpers.contrastRatio('#767676', '#000') })).toBe('#767676');
	});
});
