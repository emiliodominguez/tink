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
