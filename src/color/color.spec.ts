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
			}).toThrow(new TypeError('toRgba: `input` must be a CSS colour (hex, rgb(), hsl() or \'transparent\'), got "nope"'));
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
			}).toThrow(new TypeError(`parseColor: \`input\` must be a CSS colour (hex, rgb(), hsl() or 'transparent'), got "${long.slice(0, 50)}…"`));
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
				return new TypeError(`${caller}: \`input\` must be a CSS colour (hex, rgb(), hsl() or 'transparent'), got ${JSON.stringify(input)}`);
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
