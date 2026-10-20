import * as helpers from '.';

const families = ['Quad', 'Cubic', 'Quart', 'Quint', 'Sine', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'] as const;
const named: Array<[string, helpers.EasingFunction]> = [
	['linear', helpers.linear],
	['cssEase', helpers.cssEase],
	['cssEaseIn', helpers.cssEaseIn],
	['cssEaseOut', helpers.cssEaseOut],
	['cssEaseInOut', helpers.cssEaseInOut],
	['smoothstep', helpers.smoothstep],
	['smootherstep', helpers.smootherstep],
	['power(2.5)', helpers.power(2.5)],
	['power(3)', helpers.power(3)],
	['back()', helpers.back()],
	['back(0)', helpers.back(0)],
	['elastic()', helpers.elastic()],
	['elastic(1.5, 0.45)', helpers.elastic(1.5, 0.45)],
	['bounce()', helpers.bounce()],
	['bounce(1, 0.9)', helpers.bounce(1, 0.9)],
	['bounce(7, 0.3)', helpers.bounce(7, 0.3)],
	['easeOut(bounce(5, 0.6))', helpers.easeOut(helpers.bounce(5, 0.6))],
	['easeOutIn(easeInCubic)', helpers.easeOutIn(helpers.easeInCubic)],
	['easeOutIn(easeInExpo)', helpers.easeOutIn(helpers.easeInExpo)]
];
for (const family of families) {
	for (const kind of ['easeIn', 'easeOut', 'easeInOut']) {
		const name = `${kind}${family}`;
		named.push([name, (helpers as unknown as Record<string, helpers.EasingFunction>)[name]]);
	}
}

describe('Easing helpers', function () {
	describe('named easings', function () {
		it.each(named)('%s should map -0 to 0, never -0', function (_name, easing) {
			expect(Object.is(easing(-0), -0)).toBe(false);
		});

		it.each(named)('%s should map 0 to exactly 0 and 1 to exactly 1, and NaN to NaN', function (_name, easing) {
			expect(easing).toBeInstanceOf(Function);
			expect(easing(0)).toBe(0);
			expect(easing(1)).toBe(1);
			expect(easing(NaN)).toBeNaN();
		});

		it('should have the reference values of the standard formulas', function () {
			expect(helpers.linear(0.3)).toBe(0.3);
			expect(helpers.easeInQuad(0.5)).toBe(0.25);
			expect(helpers.easeOutQuad(0.5)).toBe(0.75);
			expect(helpers.easeInOutQuad(0.25)).toBe(0.125);
			expect(helpers.easeInOutQuad(0.75)).toBe(0.875);
			expect(helpers.easeInCubic(0.5)).toBe(0.125);
			expect(helpers.easeInQuart(0.5)).toBe(0.0625);
			expect(helpers.easeInQuint(0.5)).toBe(0.03125);
			expect(helpers.easeInSine(0.5)).toBeCloseTo(1 - Math.cos(Math.PI / 4), 15);
			expect(helpers.easeOutSine(0.3)).toBeCloseTo(Math.sin((0.3 * Math.PI) / 2), 15);
			expect(helpers.easeInOutSine(0.3)).toBeCloseTo((1 - Math.cos(0.3 * Math.PI)) / 2, 15);
			expect(helpers.easeInExpo(0.5)).toBe(2 ** -5);
			expect(helpers.easeOutExpo(0.3)).toBeCloseTo(1 - 2 ** (-10 * 0.3), 15);
			expect(helpers.easeInCirc(0.5)).toBeCloseTo(1 - Math.sqrt(0.75), 15);
			// easings.net back: c3·t³ - c1·t²
			expect(helpers.easeInBack(0.3)).toBeCloseTo(2.70158 * 0.027 - 1.70158 * 0.09, 15);
			expect(helpers.easeOutBack(0.3)).toBeCloseTo(1 + 2.70158 * (0.3 - 1) ** 3 + 1.70158 * (0.3 - 1) ** 2, 15);
			// easings.net elastic in
			expect(helpers.easeInElastic(0.3)).toBeCloseTo(-(2 ** (10 * 0.3 - 10)) * Math.sin((0.3 * 10 - 10.75) * ((2 * Math.PI) / 3)), 15);
			// easings.net bounce out (n1 = 7.5625, d1 = 2.75)
			function penner(t: number): number {
				const n1 = 7.5625;
				const d1 = 2.75;
				if (t < 1 / d1) return n1 * t * t;
				if (t < 2 / d1) return n1 * (t - 1.5 / d1) ** 2 + 0.75;
				if (t < 2.5 / d1) return n1 * (t - 2.25 / d1) ** 2 + 0.9375;
				return n1 * (t - 2.625 / d1) ** 2 + 0.984375;
			}
			for (const t of [0.1, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99]) {
				expect(helpers.easeOutBounce(t)).toBeCloseTo(penner(t), 14);
				expect(helpers.easeInBounce(t)).toBeCloseTo(1 - penner(1 - t), 14);
			}
		});

		it('should extrapolate outside [0, 1]', function () {
			expect(helpers.easeInQuad(2)).toBe(4);
			expect(helpers.easeInQuad(-1)).toBe(1);
			expect(helpers.easeOutQuad(2)).toBe(0);
			expect(helpers.easeInOutQuad(-0.5)).toBe(0.5);
			expect(helpers.linear(-3)).toBe(-3);
			expect(helpers.easeInCirc(2)).toBeNaN();
		});

		it('should overshoot for back and elastic', function () {
			expect(helpers.easeInBack(0.3)).toBeLessThan(0);
			expect(helpers.easeOutBack(0.7)).toBeGreaterThan(1);
			expect(helpers.easeOutElastic(0.2)).toBeGreaterThan(1);
		});
	});

	describe('easeOut / easeInOut', function () {
		it('should reflect and mirror an ease-in curve', function () {
			function square(t: number): number {
				return t * t;
			}
			expect(helpers.easeOut(square)(0.25)).toBe(1 - 0.75 * 0.75);
			expect(helpers.easeOut(helpers.easeOut(square))(0.25)).toBe(0.0625);
			const inOut = helpers.easeInOut(square);
			expect([0, 0.25, 0.5, 0.75, 1].map(inOut)).toEqual([0, 0.125, 0.5, 0.875, 1]);
			// t = 0.5 belongs to the second half: 1 - easing(1) / 2 (visible when easing(1) is not 1).
			expect(
				helpers.easeInOut(function (t) {
					return t / 2;
				})(0.5)
			).toBe(0.75);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.easeOut(1 as any);
			}).toThrow(new TypeError('easeOut: `easing` must be a function, got number'));
			expect(function () {
				helpers.easeInOut(null as any);
			}).toThrow(new TypeError('easeInOut: `easing` must be a function, got null'));
		});
	});

	describe('smoothstep / smootherstep', function () {
		it('should be the Hermite polynomials, symmetric around 1/2', function () {
			for (const t of [0.1, 0.25, 0.3, 0.5, 0.7, 0.9]) {
				expect(helpers.smoothstep(t)).toBeCloseTo(3 * t * t - 2 * t ** 3, 15);
				expect(helpers.smootherstep(t)).toBeCloseTo(6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3, 14);
				expect(helpers.smoothstep(1 - t)).toBeCloseTo(1 - helpers.smoothstep(t), 15);
				expect(helpers.smootherstep(1 - t)).toBeCloseTo(1 - helpers.smootherstep(t), 15);
			}
			expect(helpers.smoothstep(0.5)).toBe(0.5);
			expect(helpers.smootherstep(0.5)).toBe(0.5);
			// Not clamped, like the other formula easings.
			expect(helpers.smoothstep(2)).toBe(-4);
			expect(helpers.smootherstep(-1)).toBe(-31);
		});
	});

	describe('easeOutIn', function () {
		it('should run the reflection, then the ease-in, each at double speed', function () {
			const g = helpers.easeOutIn(helpers.easeInQuad);
			expect([0, 0.25, 0.5, 0.75, 1].map(g)).toEqual([0, 0.375, 0.5, 0.625, 1]);
			for (const t of [0.1, 0.3, 0.45]) {
				expect(g(t)).toBeCloseTo(helpers.easeOutQuad(2 * t) / 2, 15);
				expect(g(1 - t)).toBeCloseTo(1 - g(t), 15);
			}
			expect(g(NaN)).toBeNaN();
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.easeOutIn('linear' as any);
			}).toThrow(new TypeError('easeOutIn: `easing` must be a function, got string'));
		});
	});

	describe('power', function () {
		it('should raise t to any positive exponent', function () {
			const square = helpers.power(2);
			const cube = helpers.power(3);
			for (const t of [0.1, 0.3, 0.5, 0.9]) {
				expect(square(t)).toBeCloseTo(helpers.easeInQuad(t), 15);
				expect(cube(t)).toBeCloseTo(helpers.easeInCubic(t), 15);
			}
			expect(helpers.power(2.5)(0.25)).toBe(0.03125);
			expect(helpers.power(0.5)(0.25)).toBe(0.5);
			expect(helpers.power(2)(-3)).toBe(9);
			expect(helpers.power(0.5)(-1)).toBeNaN();
			expect(Object.is(helpers.power(3)(-0), 0)).toBe(true);
		});

		it('should validate the exponent', function () {
			for (const invalid of [0, -1, Infinity, NaN]) {
				expect(function () {
					helpers.power(invalid);
				}).toThrow(new RangeError(`power: \`exponent\` must be a finite number > 0, got ${invalid}`));
			}
			expect(function () {
				helpers.power('2' as any);
			}).toThrow(new TypeError('power: `exponent` must be a finite number > 0, got string'));
		});
	});

	describe('back', function () {
		it('should default to easeInBack and give the cubic for overshoot 0', function () {
			const custom = helpers.back();
			for (let k = 0; k <= 64; k++) expect(custom(k / 64)).toBe(helpers.easeInBack(k / 64));
			expect(helpers.back(0)(0.5)).toBe(0.125);
		});

		it('should pull back further with a larger overshoot', function () {
			// The minimum of t²·((c + 1)t - c) is at t = 2c / (3(c + 1)).
			function dip(c: number): number {
				return helpers.back(c)((2 * c) / (3 * (c + 1)));
			}
			expect(dip(1.70158)).toBeCloseTo(-0.1, 2);
			expect(dip(2.5949)).toBeCloseTo(-0.2, 2);
			expect(dip(4)).toBeLessThan(dip(2));
		});

		it('should validate the overshoot', function () {
			expect(function () {
				helpers.back(-1);
			}).toThrow(new RangeError('back: `overshoot` must be a finite number >= 0, got -1'));
			expect(function () {
				helpers.back(Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.back(null as any);
			}).toThrow(new TypeError('back: `overshoot` must be a finite number >= 0, got null'));
		});
	});

	describe('elastic', function () {
		it('should default to easeInElastic', function () {
			const custom = helpers.elastic();
			for (let k = 0; k <= 1000; k++) expect(custom(k / 1000)).toBeCloseTo(helpers.easeInElastic(k / 1000), 14);
		});

		it('should follow the GSAP formula for a custom amplitude and period', function () {
			const amplitude = 1.5;
			const period = 0.45;
			const custom = helpers.elastic(amplitude, period);
			const shift = (period / (2 * Math.PI)) * Math.asin(1 / amplitude);
			for (const t of [0.1, 0.5, 0.8, 0.95]) {
				expect(custom(t)).toBeCloseTo(-(amplitude * 2 ** (10 * (t - 1)) * Math.sin(((t - 1 - shift) * (2 * Math.PI)) / period)), 14);
			}
		});

		it('should swing further with a larger amplitude and oscillate more often with a shorter period', function () {
			function overshoot(easing: helpers.EasingFunction): number {
				let max = 0;
				for (let k = 0; k <= 1000; k++) max = Math.max(max, easing(k / 1000) - 1);
				return max;
			}
			function crossings(easing: helpers.EasingFunction): number {
				let count = 0;
				for (let k = 1; k < 1000; k++) if (Math.sign(easing(k / 1000) - 1) !== Math.sign(easing((k - 1) / 1000) - 1)) count++;
				return count;
			}
			expect(overshoot(helpers.easeOut(helpers.elastic(2)))).toBeGreaterThan(overshoot(helpers.easeOut(helpers.elastic(1))));
			expect(crossings(helpers.easeOut(helpers.elastic(1, 0.1)))).toBeGreaterThan(crossings(helpers.easeOut(helpers.elastic(1, 0.3))));
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.elastic(0.5);
			}).toThrow(new RangeError('elastic: `amplitude` must be a finite number >= 1, got 0.5'));
			expect(function () {
				helpers.elastic(1, 0);
			}).toThrow(new RangeError('elastic: `period` must be a finite number > 0, got 0'));
			expect(function () {
				helpers.elastic(1, Infinity);
			}).toThrow(RangeError);
			expect(function () {
				helpers.elastic('1' as any);
			}).toThrow(new TypeError('elastic: `amplitude` must be a finite number >= 1, got string'));
		});
	});

	describe('bounce', function () {
		it("should default to Penner's bounce (3 bounces, restitution 0.5)", function () {
			const custom = helpers.bounce();
			const out = helpers.easeOut(custom);
			for (let k = 0; k <= 1000; k++) {
				expect(custom(k / 1000)).toBeCloseTo(helpers.easeInBounce(k / 1000), 15);
				expect(out(k / 1000)).toBeCloseTo(helpers.easeOutBounce(k / 1000), 15);
			}
		});

		it('should follow a ball rebounding with the given restitution', function () {
			const restitution = 0.6;
			const out = helpers.easeOut(helpers.bounce(4, restitution));
			// The first fall takes 1 unit and rebound k takes 2·e^k, rising e^2k: the arcs touch 1 at their ends and dip to 1 - e^2k.
			let total = 1;
			for (let k = 1; k <= 4; k++) total += 2 * restitution ** k;
			let end = 1;
			expect(out(0.5 / total)).toBeCloseTo(0.25, 14);
			expect(out(end / total)).toBeCloseTo(1, 14);
			for (let k = 1; k <= 4; k++) {
				const halfWidth = restitution ** k;
				expect(out((end + halfWidth) / total)).toBeCloseTo(1 - halfWidth * halfWidth, 14);
				end += 2 * halfWidth;
				expect(out(end / total)).toBeCloseTo(1, 14);
			}
		});

		it('should extrapolate its last arc before the start and propagate NaN', function () {
			// One rebound with restitution 0.5: total 2, the ease-in at t is 0.25 - (2(1 - t) - 1.5)².
			const single = helpers.bounce(1, 0.5);
			expect(single(0.25)).toBe(0.25);
			expect(single(-0.25)).toBe(0.25 - 1);
			expect(helpers.bounce()(NaN)).toBeNaN();
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.bounce(0);
			}).toThrow(new RangeError('bounce: `bounces` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.bounce(2.5);
			}).toThrow(RangeError);
			for (const invalid of [0, 1, -0.5, NaN]) {
				expect(function () {
					helpers.bounce(3, invalid);
				}).toThrow(new RangeError(`bounce: \`restitution\` must be a number between 0 and 1 (exclusive), got ${invalid}`));
			}
			expect(function () {
				helpers.bounce(3, '0.5' as any);
			}).toThrow(new TypeError('bounce: `restitution` must be a number between 0 and 1 (exclusive), got string'));
		});
	});

	describe('cubicBezier', function () {
		it('should solve steep, overshooting and flat-ended curves to the precision of doubles', function () {
			const curves = [
				[0.9, 0, 0.1, 1],
				[0.68, -0.6, 0.32, 1.6],
				[0.05, 0.7, 0.1, 1],
				[0.7, 0, 0.84, 0],
				[0.42, 0, 1, 1]
			];
			for (const [x1, y1, x2, y2] of curves) {
				const easing = helpers.cubicBezier(x1, y1, x2, y2);
				for (let k = 1; k < 1000; k++) {
					// Reference: 200 bisection steps of the Bernstein form.
					const t = k / 1000;
					let low = 0;
					let high = 1;
					for (let i = 0; i < 200; i++) {
						const middle = (low + high) / 2;
						if (3 * (1 - middle) ** 2 * middle * x1 + 3 * (1 - middle) * middle ** 2 * x2 + middle ** 3 < t) low = middle;
						else high = middle;
					}
					const s = (low + high) / 2;
					const slope = 3 * (1 - s) ** 2 * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
					const ySlope = 3 * (1 - s) ** 2 * y1 + 6 * (1 - s) * s * (y2 - y1) + 3 * s * s * (1 - y2);
					// x(s) is solved to a few ulps of t; y moves by y'(s) / x'(s) times that.
					const tolerance = 1e-15 * (1 + Math.abs(ySlope / slope));
					expect(Math.abs(easing(t) - (3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3))).toBeLessThanOrEqual(tolerance);
				}
			}
		});

		it('should stay finite for huge but finite y control points', function () {
			expect(helpers.cubicBezier(0.5, 6e307, 0.5, 0)(0.5)).toBeCloseTo(2.25e307, -295);
			expect(Number.isFinite(helpers.cubicBezier(0.5, -1e308, 0.5, 1e308)(0.25))).toBe(true);
			expect(helpers.cubicBezier(0.5, 6e307, 0.5, 0)(1)).toBe(1);
		});

		it('should keep a flat end flat when extrapolating to ±Infinity', function () {
			expect(helpers.cssEase(Infinity)).toBe(1);
			expect(helpers.cssEaseOut(Infinity)).toBe(1);
			expect(helpers.cssEaseIn(-Infinity)).toBe(0);
			expect(helpers.cubicBezier(0.42, 0, 1, 1)(-Infinity)).toBe(0);
			// A sloped end still extrapolates along its tangent.
			expect(helpers.cubicBezier(0.1, 0.6, 0.7, 1.4)(-1)).toBeCloseTo(-6, 10);
		});

		it('should match browser reference values for the CSS presets', function () {
			// Values from Chromium's gfx::CubicBezier (which solves to ~1e-7).
			expect(helpers.cssEase(0.5)).toBeCloseTo(0.8024033877399112, 8);
			expect(helpers.cssEase(0.25)).toBeCloseTo(0.4085106, 6);
			expect(helpers.cssEaseIn(0.5)).toBeCloseTo(0.3153568, 6);
			expect(helpers.cssEaseOut(0.5)).toBeCloseTo(0.6846432, 6);
			expect(helpers.cssEaseInOut(0.5)).toBeCloseTo(0.5, 12);
			expect(helpers.cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBe(helpers.cssEase(0.5));
		});

		it('should be linear for control points on the diagonal', function () {
			const easing = helpers.cubicBezier(0, 0, 1, 1);
			for (const t of [1e-10, 0.001, 0.1, 0.3, 0.5, 0.7, 0.999, 1 - 1e-10]) expect(easing(t)).toBeCloseTo(t, 12);
		});

		it('should converge where Newton–Raphson alone is slow or leaves [0, 1]', function () {
			// x(s) = 3s² - 2s³ has a zero derivative at s = 0: Newton converges linearly near 0.
			expect(helpers.cubicBezier(0, 0.5, 1, 0.5)(1e-9)).toBeCloseTo(3 * 0.5 * Math.sqrt(1e-9 / 3), 6);
			// x(s) = 3s(1 - s)² + s³ has a zero derivative at s = 0.5.
			const flat = helpers.cubicBezier(1, 0, 0, 1);
			for (const t of [0.4999, 0.5, 0.5001, 0.3, 0.7]) {
				const y = flat(t);
				expect(y).toBeGreaterThanOrEqual(0);
				expect(y).toBeLessThanOrEqual(1);
			}
			expect(flat(0.5)).toBeCloseTo(0.5, 12);
		});

		it('should solve x(s) = t to ~1e-12 for every curve of a grid of control points (diagonal: the identity)', function () {
			const grid: number[] = [];
			for (let k = 0; k <= 20; k++) grid.push(k / 20);
			for (const a of grid) {
				for (const b of grid) {
					const identity = helpers.cubicBezier(a, a, b, b);
					for (let k = 1; k < 128; k++) expect(Math.abs(identity(k / 128) - k / 128)).toBeLessThanOrEqual(1e-11);
				}
			}
		});

		it('should solve x(s) = t to a few ulps, applying the last Newton step', function () {
			// Diagonal control points give the identity, so the result is x(s) itself: it used to stop up to ~1e-12 away from t.
			const grid: number[] = [];
			for (let k = 0; k <= 20; k++) grid.push(k / 20);
			for (const a of grid) {
				for (const b of grid) {
					const identity = helpers.cubicBezier(a, a, b, b);
					for (let k = 1; k < 128; k++) expect(Math.abs(identity(k / 128) - k / 128)).toBeLessThanOrEqual(2e-15);
				}
			}
			// CSS `ease` against its value solved with 200 bisection steps of the Bernstein form.
			const ease = helpers.cubicBezier(0.25, 0.1, 0.25, 1);
			for (let k = 1; k < 1000; k++) {
				const t = k / 1000;
				let low = 0;
				let high = 1;
				for (let i = 0; i < 200; i++) {
					const middle = (low + high) / 2;
					if (3 * (1 - middle) ** 2 * middle * 0.25 + 3 * (1 - middle) * middle ** 2 * 0.25 + middle ** 3 < t) low = middle;
					else high = middle;
				}
				const s = (low + high) / 2;
				expect(Math.abs(ease(t) - (3 * (1 - s) ** 2 * s * 0.1 + 3 * (1 - s) * s * s + s ** 3))).toBeLessThanOrEqual(2e-15);
			}
		});

		it('should fall back to bisection where a Newton step leaves the bracket of the root (nearly flat middle)', function () {
			const identity = helpers.cubicBezier(0.95, 0.95, 0, 0);
			for (let k = 1; k < 1000; k++) expect(Math.abs(identity(k / 1000) - k / 1000)).toBeLessThanOrEqual(1e-11);
		});

		it('should stay accurate next to an end with a vertical tangent', function () {
			// x1 = x2 = 0, y1 = y2 = 1: x(s) = s³ and y(s) = 3s - 3s² + s³.
			const start = helpers.cubicBezier(0, 1, 0, 1);
			for (const t of [1e-13, 2 ** -41, 1e-10, 1e-6]) {
				const s = Math.cbrt(t);
				expect(start(t)).toBeCloseTo(s * (3 - 3 * s + s * s), 10);
			}
			// x1 = x2 = 1, y1 = y2 = 0: x(s) = 1 - (1 - s)³ and y(s) = s³ (as precise: t > 0.5 is solved on the mirrored curve).
			const end = helpers.cubicBezier(1, 0, 1, 0);
			for (const k of [44, 40, 30, 20]) expect(end(1 - 2 ** -k)).toBeCloseTo((1 - Math.cbrt(2 ** -k)) ** 3, 10);
		});

		it('should support overshooting y control points', function () {
			const back = helpers.cubicBezier(0.68, -0.6, 0.32, 1.6);
			expect(back(0.1)).toBeLessThan(0);
			expect(back(0.9)).toBeGreaterThan(1);
			expect(back(0)).toBe(0);
			expect(back(1)).toBe(1);
		});

		it('should extrapolate along the end-point tangents like Chromium', function () {
			// start gradient: y1 / x1
			expect(helpers.cubicBezier(0.25, 0.1, 0.25, 1)(-1)).toBeCloseTo(-0.4, 15);
			// x1 = 0, y1 = 0: y2 / x2
			expect(helpers.cubicBezier(0, 0, 0.5, 1)(-1)).toBe(-2);
			// all zero: 1
			expect(helpers.cubicBezier(0, 0, 0, 0)(-1)).toBe(-1);
			// otherwise 0
			expect(helpers.cubicBezier(0, 0.5, 1, 1)(-1)).toBe(0);
			expect(helpers.cubicBezier(0, 0, 0, 1)(-1)).toBe(0);
			// end gradient: (y2 - 1) / (x2 - 1)
			expect(helpers.cubicBezier(0.25, 0.1, 0.25, 0)(2)).toBeCloseTo(1 + 1 / 0.75, 15);
			// x2 = 1, y2 = 1: (y1 - 1) / (x1 - 1)
			expect(helpers.cubicBezier(0.5, 0, 1, 1)(2)).toBe(3);
			// all one: 1
			expect(helpers.cubicBezier(1, 1, 1, 1)(2)).toBe(2);
			// otherwise 0
			expect(helpers.cubicBezier(0, 0, 1, 0.5)(2)).toBe(1);
			expect(helpers.cubicBezier(1, 0, 1, 1)(2)).toBe(1);
			expect(helpers.cubicBezier(0.5, 1, 1, 0.5)(2)).toBe(1);
			// never -0, and exact end points even when a tangent overflows
			expect(helpers.cssEaseIn(-1)).toBe(0);
			expect(helpers.cssEaseIn(-0)).toBe(0);
			const steep = helpers.cubicBezier(Number.MIN_VALUE, 1e-15, 1 - 2 ** -53, 1e-15);
			expect(steep(0)).toBe(0);
			expect(steep(1)).toBe(1);
			expect(steep(-1)).toBe(-Infinity);
			const steepEnd = helpers.cubicBezier(0, 0, 1 - 2 ** -53, 1e300);
			expect(steepEnd(1)).toBe(1);
			expect(steepEnd(2)).toBe(-Infinity);
			expect(helpers.cssEase(NaN)).toBeNaN();
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.cubicBezier(-0.1, 0, 1, 1);
			}).toThrow(new RangeError('cubicBezier: `x1` must be a number between 0 and 1, got -0.1'));
			expect(function () {
				helpers.cubicBezier(0, 0, 1.1, 1);
			}).toThrow(new RangeError('cubicBezier: `x2` must be a number between 0 and 1, got 1.1'));
			expect(function () {
				helpers.cubicBezier(1.5, 0, 1, 1);
			}).toThrow(new RangeError('cubicBezier: `x1` must be a number between 0 and 1, got 1.5'));
			expect(function () {
				helpers.cubicBezier(0, 0, -0.1, 1);
			}).toThrow(new RangeError('cubicBezier: `x2` must be a number between 0 and 1, got -0.1'));
			expect(function () {
				helpers.cubicBezier(NaN, 0, 1, 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.cubicBezier(0, Infinity, 1, 1);
			}).toThrow(new RangeError('cubicBezier: `y1` must be a finite number, got Infinity'));
			expect(function () {
				helpers.cubicBezier(0, 0, 1, NaN);
			}).toThrow(new RangeError('cubicBezier: `y2` must be a finite number, got NaN'));
			expect(function () {
				helpers.cubicBezier('0' as any, 0, 1, 1);
			}).toThrow(new TypeError('cubicBezier: `x1` must be a number between 0 and 1, got string'));
		});
	});

	describe('cssLinear', function () {
		it('should place missing inputs like CSS linear()', function () {
			// linear(0, 0.25, 1): the middle stop sits at 50%.
			const easing = helpers.cssLinear([0, 0.25, 1]);
			expect([0, 0.25, 0.5, 0.75, 1].map(easing)).toEqual([0, 0.125, 0.25, 0.625, 1]);
			// linear(0, 0.1, 0.2 40%, 0.3, 0.9, 1): 0.1 at 20%, 0.3 at 60% and 0.9 at 80%.
			const spread = helpers.cssLinear([0, 0.1, [0.2, 0.4], 0.3, 0.9, 1]);
			expect(spread(0.2)).toBe(0.1);
			expect(spread(0.6)).toBeCloseTo(0.3, 15);
			expect(spread(0.8)).toBeCloseTo(0.9, 15);
			expect(spread(0.9)).toBeCloseTo(0.95, 15);
			// A last stop without input goes to 1, or to the largest input before it (here a jump from 0.5 to 1 at 150%).
			expect(helpers.cssLinear([0, [0.5, 1.5], 1])(0.75)).toBe(0.25);
			expect(helpers.cssLinear([0, [0.5, 1.5], 1])(1.5)).toBe(1);
			expect(helpers.cssLinear([0, [0.5, 1.5], 1])(2)).toBe(1);
		});

		it('should raise inputs smaller than an earlier one (making a jump) and hold two-input stops', function () {
			// linear(0, 0.5 80%, 0.7 30%, 1): 0.7 is raised to 80%, a jump from 0.5 to 0.7.
			const jump = helpers.cssLinear([0, [0.5, 0.8], [0.7, 0.3], 1]);
			expect(jump(0.4)).toBe(0.25);
			expect(jump(0.8 - 1e-9)).toBeCloseTo(0.5, 8);
			expect(jump(0.8)).toBe(0.7);
			expect(jump(0.9)).toBeCloseTo(0.85, 15);
			const hold = helpers.cssLinear([0, [0.5, 0.25, 0.75], 1]);
			expect([0.125, 0.25, 0.5, 0.75, 0.875].map(hold)).toEqual([0.25, 0.5, 0.5, 0.5, 0.75]);
			// Steps written as linear(): linear(0 0% 50%, 1 50% 100%).
			const step = helpers.cssLinear([
				[0, 0, 0.5],
				[1, 0.5, 1]
			]);
			expect([0, 0.25, 0.4999, 0.5, 0.75, 1].map(step)).toEqual([0, 0, 0, 1, 1, 1]);
		});

		it('should extrapolate the first and last segments, follow the spec on equal inputs and propagate NaN', function () {
			const easing = helpers.cssLinear([0, [0.6, 0.5], 1]);
			expect(easing(-1)).toBeCloseTo(-1.2, 15);
			expect(easing(2)).toBeCloseTo(1.8, 15);
			// Starting after 0: linear(0.2 50%, 1) extrapolates to 0.2 - 0.8 at t = 0.
			expect(helpers.cssLinear([[0.2, 0.5], 1])(0)).toBeCloseTo(-0.6, 15);
			// Equal inputs on both sides: the output of the second point.
			expect(
				helpers.cssLinear([
					[0, 0.5],
					[1, 0.5]
				])(0.2)
			).toBe(1);
			expect(helpers.cssLinear([0, [1, 1], [0.5, 1]])(2)).toBe(0.5);
			expect(easing(NaN)).toBeNaN();
			expect(helpers.cssLinear([[0.5, 0.25, 0.75], 1])(NaN)).toBeNaN();
			// A flat segment stays flat where the progress overflows.
			expect(helpers.cssLinear([0, [0, 5e-324]])(-1)).toBe(0);
			expect(helpers.cssLinear([0, [0.5, 0.5], [0.5, 1]])(Infinity)).toBe(0.5);
		});

		it('should give the same results in any call order (the cached segment is only a shortcut)', function () {
			const stops: helpers.LinearStop[] = [0, 0.3, [0.2, 0.3], 0.8, [0.9, 0.7], [1, 0.7], 1];
			const sequential = helpers.cssLinear(stops);
			const forward: number[] = [];
			for (let k = -10; k <= 110; k++) forward.push(sequential(k / 100));
			const shuffled = helpers.cssLinear(stops);
			for (let k = 110; k >= -10; k -= 7) expect(shuffled(k / 100)).toBe(forward[k + 10]);
			for (let k = -10; k <= 110; k += 3) expect(shuffled(k / 100)).toBe(forward[k + 10]);
		});

		it('should validate the stops', function () {
			expect(function () {
				helpers.cssLinear('0, 1' as any);
			}).toThrow(new TypeError('cssLinear: `stops` must be an array of linear stops, got string'));
			expect(function () {
				helpers.cssLinear([0]);
			}).toThrow(new RangeError('cssLinear: `stops` must hold at least 2 stops, got 1'));
			for (const invalid of ['1', [1], [1, 2, 3, 4], ['a', 1], [0, '50%'], null]) {
				expect(function () {
					helpers.cssLinear([0, invalid as any, 1]);
				}).toThrow(TypeError);
			}
			expect(function () {
				helpers.cssLinear([0, null as any]);
			}).toThrow(new TypeError('cssLinear: `stops[1]` must be a number or an array [output, input] or [output, start, end], got null'));
			expect(function () {
				helpers.cssLinear([0, NaN]);
			}).toThrow(new RangeError('cssLinear: `stops[1]` must hold finite numbers, got NaN'));
			expect(function () {
				helpers.cssLinear([0, [1, Infinity]]);
			}).toThrow(new RangeError('cssLinear: `stops[1]` must hold finite numbers, got 1,Infinity'));
		});
	});

	describe('toCssLinear', function () {
		/** Parses a `linear()` string back into stops. */
		function parse(css: string): helpers.LinearStop[] {
			return css
				.slice('linear('.length, -1)
				.split(', ')
				.map(function (stop): helpers.LinearStop {
					const [output, input] = stop.split(' ');
					return input === undefined ? Number(output) : [Number(output), Number(input.slice(0, -1)) / 100];
				});
		}

		it('should keep only the stops needed, and print short numbers', function () {
			expect(helpers.toCssLinear(helpers.linear)).toBe('linear(0, 1)');
			expect(helpers.toCssLinear(helpers.cssLinear([0, [1, 0.3], [0.5, 0.6], 1]))).toBe('linear(0, 1 30%, 0.5 60%, 1)');
			expect(helpers.toCssLinear(helpers.easeInQuad, { tolerance: 0.1 })).toBe('linear(0, 0.25 50%, 1)');
			expect(helpers.toCssLinear(helpers.steps(2), { samples: 4 })).toBe('linear(0, 0 25%, 0.5 50%, 0.5 75%, 1)');
			expect(helpers.toCssLinear(helpers.easeInQuad, { tolerance: 0.1, samples: 3 })).toBe('linear(0, 0.11 33.33%, 0.44 66.67%, 1)');
		});

		it('should stay within the tolerance of every sample, rounding included', function () {
			const bouncy = helpers.spring({ stiffness: 170, damping: 12 });
			for (const easing of [bouncy.easing, helpers.easeOutBounce, helpers.easeOutElastic, helpers.easeInOutBack, helpers.cssEase]) {
				for (const tolerance of [0.05, 0.001, 1e-5]) {
					const approximation = helpers.cssLinear(parse(helpers.toCssLinear(easing, { tolerance })));
					for (let k = 0; k <= 1000; k++) expect(Math.abs(approximation(k / 1000) - easing(k / 1000))).toBeLessThanOrEqual(tolerance * (1 + 1e-9));
				}
			}
			// Fewer stops for a looser tolerance.
			expect(helpers.toCssLinear(bouncy.easing, { tolerance: 0.01 }).length).toBeLessThan(helpers.toCssLinear(bouncy.easing).length);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.toCssLinear(null as any);
			}).toThrow(new TypeError('toCssLinear: `easing` must be a function, got null'));
			for (const tolerance of [0, 1, -0.1, NaN]) {
				expect(function () {
					helpers.toCssLinear(helpers.linear, { tolerance });
				}).toThrow(new RangeError(`toCssLinear: \`tolerance\` must be a number between 0 and 1 (exclusive), got ${tolerance}`));
			}
			expect(function () {
				helpers.toCssLinear(helpers.linear, { samples: 1 });
			}).toThrow(new RangeError('toCssLinear: `samples` must be an integer >= 2, got 1'));
			expect(function () {
				helpers.toCssLinear(helpers.linear, { samples: 10.5 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.toCssLinear(
					function (t) {
						return 1 / (t - 0.5);
					},
					{ samples: 4 }
				);
			}).toThrow(new RangeError('toCssLinear: `easing` must return finite numbers, got Infinity at t = 0.5'));
		});
	});

	describe('steps', function () {
		const inputs = [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1];

		it('should match CSS steps() for every position', function () {
			expect(inputs.map(helpers.steps(4))).toEqual([0, 0, 0.25, 0.5, 0.75, 0.75, 1]);
			expect(inputs.map(helpers.steps(4, 'jump-end'))).toEqual(inputs.map(helpers.steps(4, 'end')));
			expect(inputs.map(helpers.steps(4, 'jump-start'))).toEqual([0.25, 0.25, 0.5, 0.75, 1, 1, 1]);
			expect(inputs.map(helpers.steps(4, 'jump-start'))).toEqual(inputs.map(helpers.steps(4, 'start')));
			expect(inputs.map(helpers.steps(5, 'jump-none'))).toEqual([0, 0, 0.25, 0.5, 0.75, 1, 1]);
			expect(inputs.map(helpers.steps(3, 'jump-both'))).toEqual([0.25, 0.25, 0.25, 0.5, 0.75, 0.75, 1]);
			expect(inputs.map(helpers.steps(1))).toEqual([0, 0, 0, 0, 0, 0, 1]);
			expect(inputs.map(helpers.steps(1, 'jump-start'))).toEqual([1, 1, 1, 1, 1, 1, 1]);
			expect(inputs.map(helpers.steps(2, 'jump-none'))).toEqual([0, 0, 0, 1, 1, 1, 1]);
		});

		it('should follow the CSS algorithm outside [0, 1] and propagate NaN', function () {
			expect(helpers.steps(4)(-0.1)).toBe(-0.25);
			expect(helpers.steps(4)(1.3)).toBe(1.25);
			expect(helpers.steps(4, 'jump-start')(-0.3)).toBe(-0.25);
			expect(helpers.steps(4, 'jump-start')(-0)).toBe(0.25);
			expect(helpers.steps(4)(-0)).toBe(0);
			expect(helpers.steps(4)(NaN)).toBeNaN();
		});

		it('should validate count and position', function () {
			expect(function () {
				helpers.steps(0);
			}).toThrow(new RangeError('steps: `count` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.steps(1.5);
			}).toThrow(RangeError);
			expect(function () {
				helpers.steps(1, 'jump-none');
			}).toThrow(new RangeError('steps: `count` must be an integer >= 2, got 1'));
			expect(function () {
				helpers.steps(0, 'jump-both');
			}).toThrow(new RangeError('steps: `count` must be an integer >= 1, got 0'));
			expect(function () {
				helpers.steps('4' as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.steps(4, 'middle' as any);
			}).toThrow(new RangeError("steps: `position` must be one of jump-start, start, jump-end, end, jump-none, jump-both, got 'middle'"));
			expect(function () {
				helpers.steps(4, 'toString' as any);
			}).toThrow(RangeError);
			// No coercion of String objects or objects with a matching toString.
			expect(function () {
				helpers.steps(4, new String('end') as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.steps(4, {
					toString: function () {
						return 'end';
					}
				} as any);
			}).toThrow(TypeError);
			expect(function () {
				helpers.steps(4, null as any);
			}).toThrow(new TypeError('steps: `position` must be one of jump-start, start, jump-end, end, jump-none, jump-both, got null'));
		});
	});

	describe('spring', function () {
		it('should settle heavily over-damped springs whose ζ² overflows', function () {
			const duration = helpers.spring({ damping: 1e160 }).duration;
			expect(Number.isFinite(duration)).toBe(true);
			expect(duration / helpers.spring({ damping: 1e154 }).duration).toBeCloseTo(1e6, 0);
		});

		it('should start at 0 and settle at 1 (under-damped, default options)', function () {
			const { position, duration, easing } = helpers.spring();
			expect(position(0)).toBe(0);
			expect(position(-1)).toBe(0);
			expect(position(Infinity)).toBe(1);
			expect(position(NaN)).toBeNaN();
			expect(position(0.3)).toBeGreaterThan(1); // overshoot
			expect(duration).toBeGreaterThan(1);
			expect(duration).toBeLessThan(2);
			expect(Math.abs(position(duration) - 1)).toBeLessThanOrEqual(0.001);
			expect(easing(0)).toBe(0);
			expect(easing(1)).toBe(1);
			expect(easing(2)).toBe(1);
			expect(easing(0.5)).toBe(position(duration / 2));
			expect(easing(NaN)).toBeNaN();
		});

		it('should match the analytic under-damped solution', function () {
			// k = 100, c = 10, m = 1: ω = 10, ζ = 0.5, ωd = 10·√0.75
			const omegaD = 10 * Math.sqrt(0.75);
			const { position } = helpers.spring({ stiffness: 100, damping: 10, mass: 1 });
			for (const t of [0.05, 0.2, 0.7]) {
				expect(position(t)).toBeCloseTo(1 - Math.exp(-5 * t) * (Math.cos(omegaD * t) + (5 / omegaD) * Math.sin(omegaD * t)), 12);
			}
		});

		it('should handle critically damped springs without overshoot', function () {
			const { position, duration } = helpers.spring({ stiffness: 100, damping: 20 });
			for (const t of [0.05, 0.2, 0.7]) expect(position(t)).toBeCloseTo(1 - Math.exp(-10 * t) * (1 + 10 * t), 12);
			for (let t = 0; t < 3; t += 0.01) expect(position(t)).toBeLessThanOrEqual(1);
			expect(Math.abs(position(duration) - 1)).toBeLessThanOrEqual(0.001);
		});

		it('should handle over-damped springs', function () {
			// k = 100, c = 50, m = 1: characteristic roots r = -25 ± √(625 - 100)
			const s = Math.sqrt(525);
			const r1 = -25 + s;
			const r2 = -25 - s;
			const c2 = r1 / (r2 - r1);
			const c1 = -1 - c2;
			const { position, duration } = helpers.spring({ stiffness: 100, damping: 50 });
			for (const t of [0.05, 0.2, 0.7]) expect(position(t)).toBeCloseTo(1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t), 12);
			expect(Math.abs(position(duration) - 1)).toBeLessThanOrEqual(0.001);
			expect(duration).toBeGreaterThan(helpers.spring({ stiffness: 100, damping: 20 }).duration);
		});

		it('should stay accurate for heavily over-damped springs (no cancellation in the slow root)', function () {
			// k = 1, c = 2e8, m = 1: ζ = 1e8, slow root r = -1 / (ζ + √(ζ² - 1)) ≈ -5e-9, fast root ≈ -2e8.
			const { position, duration } = helpers.spring({ stiffness: 1, damping: 2e8 });
			const slow = -1 / (1e8 + Math.sqrt(1e16 - 1));
			for (const t of [1e7, 1e8, 5e8]) expect(position(t)).toBeCloseTo(1 - Math.exp(slow * t), 9);
			expect(duration).toBeGreaterThan(1e9);
			expect(duration).toBeLessThan(2e9);
		});

		it('should settle exactly when the energy (k·x² + m·v²) / 2 drops to that of a restDelta displacement', function () {
			const specs = [
				{},
				{ velocity: 5 },
				{ stiffness: 100, damping: 20, velocity: -3 },
				{ stiffness: 50, damping: 40, mass: 2, velocity: 8 },
				{ restDelta: 0.01 },
				{ stiffness: 100, damping: 50, velocity: 30, restDelta: 0.5 }
			];
			for (const spec of specs) {
				const { stiffness = 100, mass = 1, restDelta = 0.001 } = spec as helpers.SpringOptions;
				const { position, duration } = helpers.spring(spec);
				const h = duration * 1e-6;
				const x = position(duration) - 1;
				const v = (position(duration + h) - position(duration - h)) / (2 * h);
				expect((stiffness * x * x + mass * v * v) / (stiffness * restDelta * restDelta)).toBeCloseTo(1, 4);
			}
		});

		it('should scale its duration with 1 / ω (stiff and soft springs are as precise as usual ones)', function () {
			// Multiplying the stiffness by s² and the damping by s keeps ζ and speeds the motion up by s: position_s(t) = position(s · t).
			for (const zeta of [0.5, 1, 2]) {
				const base = helpers.spring({ stiffness: 1, damping: 2 * zeta });
				for (const scale of [1e-6, 1e2, 1e6, 1e8]) {
					const scaled = helpers.spring({ stiffness: scale * scale, damping: 2 * zeta * scale });
					expect(Math.abs(scaled.duration * scale - base.duration)).toBeLessThanOrEqual(1e-12 * base.duration);
					expect(scaled.position(0.5 / scale)).toBeCloseTo(base.position(0.5), 12);
				}
			}
		});

		it('should honour the initial velocity, mass and restDelta', function () {
			expect(helpers.spring({ velocity: 10 }).position(0.05)).toBeGreaterThan(helpers.spring().position(0.05));
			expect(helpers.spring({ velocity: -10 }).position(0.02)).toBeLessThan(0);
			expect(helpers.spring({ mass: 4 }).duration).toBeGreaterThan(helpers.spring().duration);
			expect(helpers.spring({ restDelta: 0.01 }).duration).toBeLessThan(helpers.spring().duration);
		});

		it('should validate its options', function () {
			expect(function () {
				helpers.spring({ damping: 0 });
			}).toThrow(new RangeError('spring: `damping` must be a finite number > 0, got 0'));
			expect(function () {
				helpers.spring({ stiffness: -1 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.spring({ mass: Infinity });
			}).toThrow(new RangeError('spring: `mass` must be a finite number > 0, got Infinity'));
			for (const invalid of [0, -1, Infinity]) {
				for (const name of ['stiffness', 'damping', 'mass']) {
					expect(function () {
						helpers.spring({ [name]: invalid });
					}).toThrow(new RangeError(`spring: \`${name}\` must be a finite number > 0, got ${invalid}`));
				}
			}
			for (const invalid of [0, -0.5, 1.5]) {
				expect(function () {
					helpers.spring({ restDelta: invalid });
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.spring({ velocity: NaN });
			}).toThrow(new RangeError('spring: `velocity` must be a finite number, got NaN'));
			expect(function () {
				helpers.spring({ restDelta: 1 });
			}).toThrow(new RangeError('spring: `restDelta` must be a number between 0 and 1 (exclusive), got 1'));
			expect(function () {
				helpers.spring({ stiffness: '100' as any });
			}).toThrow(new TypeError('spring: `stiffness` must be a finite number > 0, got string'));
		});

		it('should settle springs whose stiffness / mass ratio is not representable, and stay at 1 for huge times', function () {
			const stiff = helpers.spring({ stiffness: 1e300, mass: 1e-300 });
			expect(stiff.duration).toBeGreaterThan(0);
			expect(Math.abs(stiff.position(stiff.duration) - 1)).toBeLessThanOrEqual(0.001);
			expect(helpers.spring({ stiffness: 1e-200, mass: 1e200 }).duration).toBeCloseTo(6.853152157597972e201, -190);
			expect(helpers.spring().position(1e308)).toBe(1);
			expect(helpers.spring({ damping: 20 }).position(Number.MAX_VALUE / 9)).toBe(1);
			expect(helpers.spring({ damping: 20, velocity: 1e300 }).position(1e9)).toBe(1);
		});

		it('should throw instead of looping forever when the spring cannot settle', function () {
			expect(function () {
				helpers.spring({ damping: 1e-310 });
			}).toThrow(/does not settle/);
			expect(function () {
				helpers.spring({ stiffness: 1e-300, mass: 1e300, damping: 1e-300 });
			}).toThrow(/does not settle/);
		});

		it('should ignore options inherited from a polluted Object.prototype', function () {
			const reference = helpers.spring();
			const proto = Object.prototype as Record<string, unknown>;
			const planted = { stiffness: 1e6, damping: 1, mass: 50, velocity: 50, restDelta: 0.5 };
			Object.assign(proto, planted);
			try {
				const polluted = helpers.spring();
				expect(polluted.duration).toBe(reference.duration);
				expect(polluted.position(0.1)).toBe(reference.position(0.1));
				// Own options still apply, and so do options inherited from another prototype.
				expect(helpers.spring({ damping: 20 }).position(0.1)).toBe(helpers.spring(Object.create({ damping: 20 })).position(0.1));
				expect(helpers.spring({ damping: 20 }).position(0.1)).not.toBe(reference.position(0.1));
			} finally {
				for (const key of Object.keys(planted)) delete proto[key];
			}
		});
	});

	describe('spring velocity', function () {
		it('should be the derivative of the position', function () {
			for (const options of [{}, { damping: 20 }, { damping: 50, velocity: 4 }, { stiffness: 300, damping: 8, mass: 2, velocity: -6 }]) {
				const { position, velocity } = helpers.spring(options);
				for (const time of [0.01, 0.1, 0.3, 0.8]) {
					const h = 1e-6;
					expect(velocity(time)).toBeCloseTo((position(time + h) - position(time - h)) / (2 * h), 5);
				}
			}
		});

		it('should start at the initial velocity, be 0 before release and once settled for good', function () {
			const { velocity, duration } = helpers.spring({ velocity: 7 });
			expect(velocity(0)).toBe(7);
			expect(velocity(1e-9)).toBeCloseTo(7, 5);
			expect(velocity(-1)).toBe(0);
			expect(velocity(Infinity)).toBe(0);
			expect(velocity(NaN)).toBeNaN();
			expect(helpers.spring().velocity(0)).toBe(0);
			// Settled: the energy bound limits the speed to restDelta·ω (ω = 10 for the defaults).
			expect(Math.abs(velocity(duration))).toBeLessThanOrEqual(0.001 * 10 * (1 + 1e-9));
			expect(helpers.spring({ damping: 20 }).velocity(1e6)).toBe(0);
		});
	});

	describe('interpolate', function () {
		it('should lerp with an easing', function () {
			expect(helpers.interpolate(0, 100, 0.5)).toBe(50);
			expect(helpers.interpolate(0, 100, 0.5, helpers.easeInQuad)).toBe(25);
			expect(helpers.interpolate(10, 20, 0, helpers.easeOutBack)).toBe(10);
			expect(helpers.interpolate(10, 20, 1, helpers.easeOutBack)).toBe(20);
			expect(helpers.interpolate(0, 10, 2)).toBe(20);
			expect(helpers.interpolate(0, 10, NaN)).toBeNaN();
		});

		it('should throw a TypeError for a non-function easing', function () {
			expect(function () {
				helpers.interpolate(0, 1, 0.5, 'ease' as any);
			}).toThrow(new TypeError('interpolate: `easing` must be a function, got string'));
		});
	});
});
