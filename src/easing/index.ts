import { lerp } from '../math/index.js';
import { assertFunction, assertInteger, assertNumber, readOption, describe as typeName } from '../utils/assert.js';

/**
 * An easing function: maps animation progress `t` (`0` at the start, `1` at the end) to eased progress.
 *
 * Every easing of this module returns exactly `0` (never `-0`) for `t = 0` and exactly `1` for `t = 1`, except the CSS `steps()` curves
 * that jump at the start (`steps(4, 'jump-start')(0) === 0.25`, as in CSS) and {@link cssLinear} curves, which return the stops they are
 * given. Outside `[0, 1]` the formula easings extrapolate their formula (e.g. `easeInQuad(2) === 4`; the circular easings return `NaN`
 * where their square root is undefined: `easeInCirc` beyond `±1`, `easeOutCirc` below `0` or above `2`, and so does {@link power} for
 * `t < 0` with a fractional exponent), `cubicBezier` and `cssLinear` extrapolate linearly and `spring().easing` stays at `0` or `1`.
 * `NaN` gives `NaN`.
 */
export type EasingFunction = (t: number) => number;

/**
 * A stop of {@link cssLinear}, like a stop of CSS `linear()` with its input positions written as fractions instead of percentages:
 * an output alone (`0.5`, its input is spread evenly between its neighbours), an output with its input (`[0.5, 0.25]` for CSS
 * `0.5 25%`), or an output held between two inputs (`[0.5, 0.25, 0.75]` for CSS `0.5 25% 75%`).
 */
export type LinearStop = number | readonly [output: number, input: number] | readonly [output: number, start: number, end: number];

/**
 * Options accepted by {@link toCssLinear}.
 */
export interface CssLinearOptions {
	/**
	 * Largest distance allowed between the easing and the generated `linear()` curve at the sampled points, in output units, in `(0, 1)`.
	 * @default 0.001
	 */
	tolerance?: number;
	/**
	 * Number of evenly spaced intervals the easing is sampled at (it is called `samples + 1` times), an integer >= 2.
	 * @default 1000
	 */
	samples?: number;
}

/**
 * A CSS `steps()` jump position; `'start'` and `'end'` are the CSS aliases of `'jump-start'` and `'jump-end'`.
 */
export type StepPosition = 'jump-start' | 'jump-end' | 'jump-none' | 'jump-both' | 'start' | 'end';

/**
 * Options accepted by {@link spring}.
 */
export interface SpringOptions {
	/**
	 * Spring stiffness `k` (N/m), a finite number > 0.
	 * @default 100
	 */
	stiffness?: number;
	/**
	 * Damping coefficient `c` (N·s/m), a finite number > 0.
	 * @default 10
	 */
	damping?: number;
	/**
	 * Mass `m` (kg), a finite number > 0.
	 * @default 1
	 */
	mass?: number;
	/**
	 * Initial velocity, in distance units per second (the distance from start to target is `1`; positive means towards the target).
	 * @default 0
	 */
	velocity?: number;
	/**
	 * Distance from the target below which the spring counts as settled (see {@link Spring.duration}), in `(0, 1)`.
	 * @default 0.001
	 */
	restDelta?: number;
}

/**
 * A solved spring, returned by {@link spring}.
 */
export interface Spring {
	/**
	 * Exact position of the spring at `time` seconds after release, moving from `0` towards the target `1` (it may overshoot).
	 * Returns `0` for `time <= 0` and `1` for `time === Infinity`.
	 * @param {number} time - Seconds since the start
	 * @returns {number} The position
	 */
	position(time: number): number;
	/** Settle time in seconds: from then on the spring stays within `restDelta` of the target (its energy is below that of a `restDelta` displacement). */
	duration: number;
	/** `position(t * duration)` as an easing function of normalized time; returns exactly `1` for `t >= 1`. */
	easing: EasingFunction;
	/**
	 * Exact velocity of the spring at `time` seconds after release, in distance units per second (the distance from start to target
	 * is `1`). Returns the initial `velocity` for `time === 0`, `0` for `time < 0` (the spring is held before release) and for
	 * `time === Infinity`. Use it to hand a moving spring over to a new target without a jump in speed.
	 * @param {number} time - Seconds since the start
	 * @returns {number} The velocity
	 */
	velocity(time: number): number;
}

/** Overshoot constant of the "back" easings (overshoots by about 10%). */
const BACK = 1.70158;
/**
 * Relative Halley step (`|step| / s`) below which {@link cubicBezier} applies it and stops solving `x(s) = t`: Halley's method converges
 * cubically, so what the step leaves is of the order of its cube (times the curvature terms of `x`), below double precision.
 */
const BEZIER_STEP = 1e-6;
/**
 * The same for the safeguarded solver, which also meets the roots where Newton–Raphson only converges linearly (next to a vertical
 * tangent, `x' = 0`), so that the step it stops on is not the error left: it stops on a smaller one.
 */
const BEZIER_EPSILON = 1e-12;
/** Value of a `steps()` position: `[added to the current step, added to the number of steps to get the number of jumps]`. */
const STEP_POSITIONS: Record<StepPosition, readonly [number, number]> = {
	'jump-start': [1, 0],
	start: [1, 0],
	'jump-end': [0, 0],
	end: [0, 0],
	'jump-none': [0, -1],
	'jump-both': [1, 1]
};

/**
 * The base (ease-out) bounce curve: four parabolic arcs of decreasing height (Robert Penner's constants, written with exact binary fractions).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 */
function bounceOut(t: number): number {
	const x = 2.75 * t;
	if (x < 1) return x * x;
	// Arcs of half-width 1/2, 1/4 and 1/8 centered at 1.5, 2.25 and 2.625 (= 3 - 3 · halfWidth).
	const halfWidth = x < 2 ? 0.5 : x < 2.5 ? 0.25 : 0.125;
	const d = x - (3 - 3 * halfWidth);
	return d * d + 1 - halfWidth * halfWidth;
}

/**
 * Turns an ease-in function into its ease-out counterpart by point reflection: `t => 1 - easing(1 - t)`.
 * Applying it twice gives back the original curve (so it also turns an ease-out into an ease-in).
 * @param {EasingFunction} easing - The ease-in function
 * @returns {EasingFunction} The reflected (ease-out) function
 * @throws {TypeError} when `easing` is not a function
 * @example
 * const easeOutSquare = easeOut(function (t) { return t * t; });
 * easeOutSquare(0.5); // => 0.75
 * easeOutSquare(1); // => 1
 */
export function easeOut(easing: EasingFunction): EasingFunction {
	assertFunction('easeOut', 'easing', easing);
	return function (t) {
		return 1 - easing(1 - t);
	};
}

/**
 * Builds a symmetric ease-in-out function from an ease-in function: the first half runs `easing` at double speed, the second
 * half its reflection, so that `g(1 - t) = 1 - g(t)` (up to floating-point rounding) and, when `easing(1) === 1`, `g(0.5) === 0.5`.
 * @param {EasingFunction} easing - The ease-in function
 * @returns {EasingFunction} `t => t < 0.5 ? easing(2t) / 2 : 1 - easing(2 - 2t) / 2`
 * @throws {TypeError} when `easing` is not a function
 * @example
 * const easeInOutSquare = easeInOut(function (t) { return t * t; });
 * easeInOutSquare(0.25); // => 0.125
 * easeInOutSquare(0.5); // => 0.5
 * easeInOutSquare(0.75); // => 0.875
 */
export function easeInOut(easing: EasingFunction): EasingFunction {
	assertFunction('easeInOut', 'easing', easing);
	return function (t) {
		return t < 0.5 ? easing(2 * t) / 2 : 1 - easing(2 - 2 * t) / 2;
	};
}

/**
 * Builds an out-in function from an ease-in function: the first half runs its reflection (the ease-out) at double speed, the second
 * half `easing` itself, so the motion starts and ends fast and slows down in the middle. When `easing(0) === 0` and `easing(1) === 1`,
 * `g(0) === 0`, `g(0.5) === 0.5` and `g(1) === 1`.
 * @param {EasingFunction} easing - The ease-in function
 * @returns {EasingFunction} `t => t < 0.5 ? (1 - easing(1 - 2t)) / 2 : (1 + easing(2t - 1)) / 2`
 * @throws {TypeError} when `easing` is not a function
 * @example
 * const easeOutInSquare = easeOutIn(function (t) { return t * t; });
 * easeOutInSquare(0.25); // => 0.375
 * easeOutInSquare(0.5); // => 0.5
 * easeOutInSquare(0.75); // => 0.625
 */
export function easeOutIn(easing: EasingFunction): EasingFunction {
	assertFunction('easeOutIn', 'easing', easing);
	return function (t) {
		return t < 0.5 ? (1 - easing(1 - 2 * t)) / 2 : (1 + easing(2 * t - 1)) / 2;
	};
}

/**
 * No easing: `t => t`.
 * @param {number} t - Progress
 * @returns {number} `t`
 * @example
 * linear(0.3); // => 0.3
 */
export function linear(t: number): number {
	// `+ 0` turns -0 into 0.
	return t + 0;
}

/**
 * Quadratic ease-in: `t²`. The `Out` / `InOut` variants are built with {@link easeOut} / {@link easeInOut}, like all named easings.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInQuad(0.5); // => 0.25
 */
export function easeInQuad(t: number): number {
	return t * t;
}
/**
 * Quadratic ease-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutQuad(0.5); // => 0.75
 */
export function easeOutQuad(t: number): number {
	return 1 - easeInQuad(1 - t);
}
/**
 * Quadratic ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutQuad(0.25); // => 0.125
 */
export function easeInOutQuad(t: number): number {
	return t < 0.5 ? easeInQuad(2 * t) / 2 : 1 - easeInQuad(2 - 2 * t) / 2;
}

/**
 * Cubic ease-in: `t³` (computed with multiplications, like the other power easings: much faster than `**`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInCubic(0.5); // => 0.125
 */
export function easeInCubic(t: number): number {
	// `+ 0` turns -0 into 0.
	return t * t * t + 0;
}
/**
 * Cubic ease-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutCubic(0.5); // => 0.875
 */
export function easeOutCubic(t: number): number {
	return 1 - easeInCubic(1 - t);
}
/**
 * Cubic ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutCubic(0.25); // => 0.0625
 */
export function easeInOutCubic(t: number): number {
	return t < 0.5 ? easeInCubic(2 * t) / 2 : 1 - easeInCubic(2 - 2 * t) / 2;
}

/**
 * Quartic ease-in: `t⁴`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInQuart(0.5); // => 0.0625
 */
export function easeInQuart(t: number): number {
	const square = t * t;
	return square * square;
}
/**
 * Quartic ease-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutQuart(0.5); // => 0.9375
 */
export function easeOutQuart(t: number): number {
	return 1 - easeInQuart(1 - t);
}
/**
 * Quartic ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutQuart(0.25); // => 0.03125
 */
export function easeInOutQuart(t: number): number {
	return t < 0.5 ? easeInQuart(2 * t) / 2 : 1 - easeInQuart(2 - 2 * t) / 2;
}

/**
 * Quintic ease-in: `t⁵`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInQuint(0.5); // => 0.03125
 */
export function easeInQuint(t: number): number {
	const square = t * t;
	// `+ 0` turns -0 into 0.
	return square * square * t + 0;
}
/**
 * Quintic ease-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutQuint(0.5); // => 0.96875
 */
export function easeOutQuint(t: number): number {
	return 1 - easeInQuint(1 - t);
}
/**
 * Quintic ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutQuint(0.25); // => 0.015625
 */
export function easeInOutQuint(t: number): number {
	return t < 0.5 ? easeInQuint(2 * t) / 2 : 1 - easeInQuint(2 - 2 * t) / 2;
}

/**
 * Sinusoidal ease-in: `1 - cos(t·π/2)`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInSine(0); // => 0
 * easeInSine(1); // => 1
 * Math.abs(easeInSine(0.5) - 0.2928932188134524) < 1e-15; // => true
 */
export function easeInSine(t: number): number {
	return t === 1 ? 1 : 1 - Math.cos((t * Math.PI) / 2);
}
/**
 * Sinusoidal ease-out (`sin(t·π/2)`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(easeOutSine(0.5) - Math.SQRT1_2) < 1e-15; // => true
 */
export function easeOutSine(t: number): number {
	return 1 - easeInSine(1 - t);
}
/**
 * Sinusoidal ease-in-out (`(1 - cos(t·π)) / 2`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutSine(0.5); // => 0.5
 */
export function easeInOutSine(t: number): number {
	return t < 0.5 ? easeInSine(2 * t) / 2 : 1 - easeInSine(2 - 2 * t) / 2;
}

/**
 * Exponential ease-in: `2^(10t - 10)`, pinned to `0` at `t = 0`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInExpo(0); // => 0
 * easeInExpo(0.5); // => 0.03125
 */
export function easeInExpo(t: number): number {
	return t === 0 ? 0 : 2 ** (10 * t - 10);
}
/**
 * Exponential ease-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutExpo(0.5); // => 0.96875
 */
export function easeOutExpo(t: number): number {
	return 1 - easeInExpo(1 - t);
}
/**
 * Exponential ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutExpo(0.25); // => 0.015625
 */
export function easeInOutExpo(t: number): number {
	return t < 0.5 ? easeInExpo(2 * t) / 2 : 1 - easeInExpo(2 - 2 * t) / 2;
}

/**
 * Circular ease-in: `1 - √(1 - t²)` (`NaN` for `|t| > 1`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(easeInCirc(0.6) - 0.2) < 1e-15; // => true
 * easeInCirc(2); // => NaN
 */
export function easeInCirc(t: number): number {
	return 1 - Math.sqrt(1 - t * t);
}
/**
 * Circular ease-out (`√(1 - (1 - t)²)`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(easeOutCirc(0.4) - 0.8) < 1e-15; // => true
 */
export function easeOutCirc(t: number): number {
	return 1 - easeInCirc(1 - t);
}
/**
 * Circular ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(easeInOutCirc(0.3) - 0.1) < 1e-15; // => true
 */
export function easeInOutCirc(t: number): number {
	return t < 0.5 ? easeInCirc(2 * t) / 2 : 1 - easeInCirc(2 - 2 * t) / 2;
}

/**
 * "Back" ease-in: pulls back slightly (about 10%) before moving forward: `t²·((c + 1)t - c)` with `c = 1.70158`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInBack(0.5) < 0; // => true
 * easeInBack(1); // => 1
 */
export function easeInBack(t: number): number {
	return t * t * (t + BACK * (t - 1)) + 0; // `+ 0` turns -0 into 0
}
/**
 * "Back" ease-out: overshoots the target slightly before settling.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutBack(0.5) > 1; // => true
 */
export function easeOutBack(t: number): number {
	return 1 - easeInBack(1 - t);
}
/**
 * "Back" ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutBack(0.5); // => 0.5
 */
export function easeInOutBack(t: number): number {
	return t < 0.5 ? easeInBack(2 * t) / 2 : 1 - easeInBack(2 - 2 * t) / 2;
}

/**
 * Elastic ease-in: a growing oscillation, `-2^(10t - 10)·sin((10t - 10.75)·2π/3)`, pinned to `0` and `1` at the ends.
 *
 * Note: as for all named easings, the `Out` and `InOut` variants are exact reflections (see {@link easeOut}), which differ slightly
 * from the hand-tuned elastic out / in-out curves of easings.net.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInElastic(0); // => 0
 * easeInElastic(1); // => 1
 */
export function easeInElastic(t: number): number {
	// Pinned at t = 0 (the formula gives 2^-10 · sin(...) there, and -0 must give 0); at t = 1 the formula is exactly 1.
	return t === 0 ? 0 : -(2 ** (10 * t - 10)) * Math.sin((10 * t - 10.75) * ((2 * Math.PI) / 3));
}
/**
 * Elastic ease-out: overshoots and oscillates around the target.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutElastic(1); // => 1
 */
export function easeOutElastic(t: number): number {
	return 1 - easeInElastic(1 - t);
}
/**
 * Elastic ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutElastic(0.5); // => 0.5
 */
export function easeInOutElastic(t: number): number {
	return t < 0.5 ? easeInElastic(2 * t) / 2 : 1 - easeInElastic(2 - 2 * t) / 2;
}

/**
 * Bounce ease-out: falls to the target and bounces three times (base curve of the bounce family).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeOutBounce(1); // => 1
 * easeOutBounce(0.5); // => 0.765625
 */
export function easeOutBounce(t: number): number {
	return bounceOut(t);
}
/**
 * Bounce ease-in (reflection of {@link easeOutBounce}).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInBounce(0.5); // => 0.234375
 */
export function easeInBounce(t: number): number {
	return 1 - bounceOut(1 - t);
}
/**
 * Bounce ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutBounce(0.5); // => 0.5
 */
export function easeInOutBounce(t: number): number {
	return t < 0.5 ? easeInBounce(2 * t) / 2 : 1 - easeInBounce(2 - 2 * t) / 2;
}

/**
 * Smoothstep: the cubic Hermite curve `3t² - 2t³` of shaders (GLSL `smoothstep(0, 1, t)`, without its clamping): an ease-in-out with zero
 * slope at both ends, gentler than {@link easeInOutCubic}. It is its own reflection (`1 - smoothstep(1 - t) = smoothstep(t)`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * smoothstep(0.25); // => 0.15625
 * smoothstep(0.5); // => 0.5
 */
export function smoothstep(t: number): number {
	return t * t * (3 - 2 * t);
}

/**
 * Smootherstep: Ken Perlin's quintic `6t⁵ - 15t⁴ + 10t³`, an ease-in-out with zero slope and zero curvature at both ends (no jerk when
 * the motion starts or stops). It is its own reflection, like {@link smoothstep}.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * smootherstep(0.25); // => 0.103515625
 * smootherstep(0.5); // => 0.5
 */
export function smootherstep(t: number): number {
	// `+ 0` turns -0 into 0.
	return t * t * t * (t * (6 * t - 15) + 10) + 0;
}

/**
 * Creates a power ease-in `t^exponent` for any exponent, fractional ones included (`2` is {@link easeInQuad}, `3` {@link easeInCubic},
 * ...; below `1` the curve starts fast). Build the other variants with {@link easeOut}, {@link easeInOut} and {@link easeOutIn}.
 * Returns `NaN` for `t < 0` when the exponent is fractional.
 * @param {number} exponent - The exponent, a finite number > 0
 * @returns {EasingFunction} The ease-in function
 * @throws {TypeError} when `exponent` is not a number
 * @throws {RangeError} when `exponent` is not a finite number > 0
 * @example
 * power(2.5)(0.25); // => 0.03125
 * easeOut(power(3))(0.5); // => 0.875
 * power(0); // throws RangeError
 */
export function power(exponent: number): EasingFunction {
	assertNumber('power', 'exponent', exponent, exponent > 0 && exponent < Infinity, 'a finite number > 0');
	return function (t) {
		// `+ 0` turns -0 (odd exponents of -0) into 0.
		return t ** exponent + 0;
	};
}

/**
 * Creates a "back" ease-in with a custom overshoot: `t²·((c + 1)t - c)` with `c = overshoot`. It pulls back before moving forward (the
 * ease-out, built with {@link easeOut}, overshoots the target instead): `1.70158` (the default, {@link easeInBack}) pulls back by about
 * 10%, `2.5949` by about 20%, `0` gives the plain cubic {@link easeInCubic}.
 * @param {number} [overshoot=1.70158] - The overshoot constant, a finite number >= 0
 * @returns {EasingFunction} The ease-in function
 * @throws {TypeError} when `overshoot` is not a number
 * @throws {RangeError} when `overshoot` is not a finite number >= 0
 * @example
 * back()(0.5) === easeInBack(0.5); // => true
 * back(0)(0.5); // => 0.125
 * easeOut(back(2.5949))(0.5) > 1; // => true
 */
export function back(overshoot: number = BACK): EasingFunction {
	assertNumber('back', 'overshoot', overshoot, overshoot >= 0 && overshoot < Infinity, 'a finite number >= 0');
	return function (t) {
		// `+ 0` turns -0 into 0.
		return t * t * (t + overshoot * (t - 1)) + 0;
	};
}

/**
 * Creates an elastic ease-in with a custom amplitude and period (as GSAP's `elastic.config`): a growing oscillation
 * `-a·2^(10t - 10)·sin((t - 1 - s)·2π/p)`, phase-shifted by `s = p·asin(1 / a) / 2π` so that it ends at exactly `1`. The defaults give
 * {@link easeInElastic} (up to rounding). Build the other variants with {@link easeOut} (the usual "elastic" overshoot) and {@link easeInOut}.
 * @param {number} [amplitude=1] - How far the oscillation swings, a finite number >= 1 (higher swings further)
 * @param {number} [period=0.3] - Duration of one oscillation, as a fraction of the whole easing, a finite number > 0 (lower oscillates faster)
 * @returns {EasingFunction} The ease-in function (pinned to exactly `0` and `1` at the ends)
 * @throws {TypeError} when an argument is not a number
 * @throws {RangeError} when `amplitude` is not a finite number >= 1 or `period` is not a finite number > 0
 * @example
 * Math.abs(elastic()(0.7) - easeInElastic(0.7)) < 1e-15; // => true
 * elastic(1.5, 0.45)(1); // => 1
 * easeOut(elastic(1, 0.2))(0.1) > 1; // => true
 */
export function elastic(amplitude = 1, period = 0.3): EasingFunction {
	assertNumber('elastic', 'amplitude', amplitude, amplitude >= 1 && amplitude < Infinity, 'a finite number >= 1');
	assertNumber('elastic', 'period', period, period > 0 && period < Infinity, 'a finite number > 0');
	const frequency = (2 * Math.PI) / period;
	const shift = 1 + Math.asin(1 / amplitude) / frequency;
	return function (t) {
		// Pinned at both ends: the formula gives a·2^-10·sin(...) at t = 0, and only 1 up to rounding at t = 1.
		return t === 0 ? 0 : t === 1 ? 1 : -amplitude * 2 ** (10 * t - 10) * Math.sin((t - shift) * frequency);
	};
}

/**
 * Creates a bounce ease-in with a custom number of bounces and bounciness, following the physics of a ball: its ease-out (built with
 * {@link easeOut}) falls to the target under constant gravity and rebounds `bounces` times, each rebound leaving at `restitution` times
 * the speed of the impact (so each arc is `restitution` times as long and `restitution²` times as high as the previous one). The
 * defaults give {@link easeInBounce}: Robert Penner's bounce is exactly 3 bounces with a restitution of `0.5`.
 *
 * Evaluating it takes `O(bounces)` time in the worst case (the arcs are scanned in order).
 * @param {number} [bounces=3] - Number of rebounds, an integer >= 1
 * @param {number} [restitution=0.5] - Coefficient of restitution (rebound speed / impact speed), in `(0, 1)`
 * @returns {EasingFunction} The ease-in function (exactly `0` at `0` and `1` at `1`)
 * @throws {TypeError} when an argument is not a number
 * @throws {RangeError} when `bounces` is not an integer >= 1 or `restitution` is not in `(0, 1)`
 * @example
 * bounce()(0.5) === easeInBounce(0.5); // => true
 * const bouncy = easeOut(bounce(5, 0.6)); // more, livelier bounces
 * bouncy(1); // => 1
 */
export function bounce(bounces = 3, restitution = 0.5): EasingFunction {
	assertInteger('bounce', 'bounces', bounces, 1);
	assertNumber('bounce', 'restitution', restitution, restitution > 0 && restitution < 1, 'a number between 0 and 1 (exclusive)');
	// In units of the first fall's duration: the fall takes 1, the rebound k (k >= 1) takes 2·restitution^k.
	let total = 1;
	let width = 1;
	for (let k = 0; k < bounces; k++) {
		width *= restitution;
		total += 2 * width;
	}
	return function (t) {
		if (t === 0) return 0;
		// Time along the ease-out at 1 - t; the ease-in is its reflection: 1 - out(1 - t).
		const x = (1 - t) * total;
		if (x < 1) return 1 - x * x;
		let halfWidth = 1;
		let start = 1;
		for (let k = 1; ; k++) {
			halfWidth *= restitution;
			const end = start + 2 * halfWidth;
			// On the arc [start, end] the ease-out is the parabola 1 - (x - start)·(end - x): exactly 1 at both ends (the ball touches the
			// ground) and never above it. The last arc ends at exactly `total` (same sums) and also extrapolates t < 0.
			if (x < end || k === bounces) return (x - start) * (end - x);
			start = end;
		}
	};
}

/**
 * Solves `x(s) = t` for `s` in `[0, 1]`, where `x(s) = ((a·s + b)·s + c)·s` is increasing with `x(0) = 0` and `x(1) = 1`.
 *
 * Halley's method (cubic convergence), from `s = t·scale`: `scale` is `1 / x'(0)` where the curve starts steeper than the diagonal
 * (the start tangent then gives a closer first guess) and `1` otherwise. It takes 2 to 3 steps for usual curves. Once a step is below
 * `BEZIER_STEP` (relative to `s`) it is applied and the result returned: what that last step leaves is of the order of its cube, at
 * the limit of double precision (|x(s) - t| of a few ulps). A step that leaves `(0, 1)` (or is infinite or NaN, where x is flat), or
 * no convergence within 8 steps, hands over to {@link solveBezierSafely}.
 * @param {number} a - Cubic coefficient
 * @param {number} b - Quadratic coefficient
 * @param {number} c - Linear coefficient
 * @param {number} t - Target value, in `(0, 1)`
 * @param {number} scale - Factor from `t` to the first guess of `s`, in `(0, 1]`
 * @returns {number} The curve parameter `s`
 */
function solveBezier(a: number, b: number, c: number, t: number, scale: number): number {
	let s = t * scale;
	for (let i = 0; i < 8; i++) {
		const error = ((a * s + b) * s + c) * s - t;
		const slope = (3 * a * s + 2 * b) * s + c;
		const step = (2 * error * slope) / (2 * slope * slope - error * (6 * a * s + 2 * b));
		const next = s - step;
		if (!(next > 0 && next < 1)) break;
		if (!(Math.abs(step) >= BEZIER_STEP * next)) return next;
		s = next;
	}
	return solveBezierSafely(a, b, c, t);
}

/**
 * Solves `x(s) = t` like {@link solveBezier}, for the curves where Halley's method leaves `(0, 1)` or converges slowly.
 *
 * Newton–Raphson from `s = t`, safeguarded by the bracket `[low, high]` of the root: a step that leaves it (or is infinite, where x
 * is flat) bisects instead. Stops once the step is below `BEZIER_EPSILON` (applying it when it stays in the bracket), or is NaN
 * (0 / 0: exact root where x is flat). The bound only matters for t < ~1e-19 at a vertical tangent.
 * @param {number} a - Cubic coefficient
 * @param {number} b - Quadratic coefficient
 * @param {number} c - Linear coefficient
 * @param {number} t - Target value, in `(0, 1)`
 * @returns {number} The curve parameter `s`
 */
function solveBezierSafely(a: number, b: number, c: number, t: number): number {
	let s = t;
	let low = 0;
	let high = 1;
	for (let i = 0; i < 64; i++) {
		const error = ((a * s + b) * s + c) * s - t;
		const step = error / ((3 * a * s + 2 * b) * s + c);
		if (!(Math.abs(step) >= BEZIER_EPSILON)) {
			const next = s - step;
			return next > low && next < high ? next : s;
		}
		if (error < 0) low = s;
		else high = s;
		s -= step;
		if (!(s > low && s < high)) s = (low + high) / 2;
	}
	return s;
}

/**
 * Creates an easing function equivalent to CSS `cubic-bezier(x1, y1, x2, y2)`: the curve from `(0, 0)` to `(1, 1)` with control
 * points `(x1, y1)` and `(x2, y2)`, evaluated by solving `x(s) = t` for the curve parameter `s` to the precision of doubles (`x(s)`
 * within a few ulps of `t`; Halley's method, which takes 2 to 3 steps, falling back to Newton–Raphson safeguarded by bisection, which
 * always converges because `x` is monotonic when `x1, x2 ∈ [0, 1]`; for `t > 0.5` on the mirrored curve, so that both ends are equally
 * precise), then returning `y(s)`.
 *
 * Like browsers, inputs outside `[0, 1]` are extrapolated linearly along the tangent at the nearest end point.
 * @param {number} x1 - x of the first control point, in `[0, 1]`
 * @param {number} y1 - y of the first control point (any finite number; outside `[0, 1]` the curve overshoots)
 * @param {number} x2 - x of the second control point, in `[0, 1]`
 * @param {number} y2 - y of the second control point (any finite number)
 * @returns {EasingFunction} The easing function (exactly `0` at `0` and `1` at `1`)
 * @throws {TypeError} when an argument is not a number
 * @throws {RangeError} when `x1` or `x2` is outside `[0, 1]`, or `y1` / `y2` is not finite
 * @example
 * const ease = cubicBezier(0.25, 0.1, 0.25, 1);
 * Math.abs(ease(0.5) - 0.8024033877399112) < 1e-9; // => true // Chrome's value for CSS `ease`
 * Math.abs(cubicBezier(0, 0, 1, 1)(0.3) - 0.3) < 1e-12; // => true // control points on the diagonal: linear
 * cubicBezier(0.42, 0, 1, 1)(-1); // => 0 // extrapolated along the (horizontal) start tangent
 * cubicBezier(0.25, 0.1, 0.25, 1)(-1); // => -0.4
 * cubicBezier(1.5, 0, 0, 1); // throws RangeError
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
	assertNumber('cubicBezier', 'x1', x1, x1 >= 0 && x1 <= 1, 'a number between 0 and 1');
	assertNumber('cubicBezier', 'y1', y1, Number.isFinite(y1), 'a finite number');
	assertNumber('cubicBezier', 'x2', x2, x2 >= 0 && x2 <= 1, 'a number between 0 and 1');
	assertNumber('cubicBezier', 'y2', y2, Number.isFinite(y2), 'a finite number');

	// Polynomial coefficients: x(s) = ((ax·s + bx)·s + cx)·s, same for y, and for x̄(u) = 1 - x(1 - u), the x of the mirrored curve.
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const polynomialY = Number.isFinite(ay) && Number.isFinite(by) && Number.isFinite(cy);
	const mirroredCx = 3 - 3 * x2;
	const mirroredBx = 3 * (x2 - x1) - mirroredCx;
	const mirroredAx = 1 - mirroredCx - mirroredBx;
	// First guess of the solver: s = t / x'(0) where the curve starts steeper than the diagonal (s = t would overshoot the root).
	const scale = cx > 1 ? 1 / cx : 1;
	const mirroredScale = mirroredCx > 1 ? 1 / mirroredCx : 1;
	// End-point tangents for extrapolation (same rules as Chromium's gfx::CubicBezier).
	const startGradient = x1 > 0 ? y1 / x1 : !y1 && x2 > 0 ? y2 / x2 : !y1 && !y2 ? 1 : 0;
	const endGradient = x2 < 1 ? (y2 - 1) / (x2 - 1) : y2 === 1 && x1 < 1 ? (y1 - 1) / (x1 - 1) : y2 === 1 && y1 === 1 ? 1 : 0;

	return function (t) {
		// `+ 0` turns -0 into 0; t = 0 and t = 1 are returned as-is (a gradient may overflow to Infinity, and Infinity · 0 is NaN).
		// A flat end stays flat, even at ±Infinity (0 · Infinity would be NaN).
		if (!(t > 0 && t < 1)) {
			if (t < 0) return startGradient === 0 ? 0 : startGradient * t + 0;
			return t > 1 ? (endGradient === 0 ? 1 : 1 + endGradient * (t - 1)) : t + 0;
		}
		// x(s) is only precise (relative to t) near s = 0, so the second half solves x̄(u) = 1 - t for u = 1 - s (1 - t is exact there).
		const s = t <= 0.5 ? solveBezier(ax, bx, cx, t, scale) : 1 - solveBezier(mirroredAx, mirroredBx, mirroredCx, 1 - t, mirroredScale);
		if (polynomialY) return ((ay * s + by) * s + cy) * s;
		// Huge `y1` / `y2` overflow the polynomial coefficients: the Bernstein form, a weighted mean of the control points, cannot.
		const u = 1 - s;
		return 3 * u * s * (u * y1 + s * y2) + s * s * s;
	};
}

let cssEaseCurve: EasingFunction | undefined;
/**
 * CSS `ease`: `cubic-bezier(0.25, 0.1, 0.25, 1)` (the default `transition-timing-function`).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(cssEase(0.5) - 0.8024033877399112) < 1e-9; // => true
 */
export function cssEase(t: number): number {
	return (cssEaseCurve ??= cubicBezier(0.25, 0.1, 0.25, 1))(t);
}
let cssEaseInCurve: EasingFunction | undefined;
/**
 * CSS `ease-in`: `cubic-bezier(0.42, 0, 1, 1)`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * cssEaseIn(1); // => 1
 */
export function cssEaseIn(t: number): number {
	return (cssEaseInCurve ??= cubicBezier(0.42, 0, 1, 1))(t);
}
let cssEaseOutCurve: EasingFunction | undefined;
/**
 * CSS `ease-out`: `cubic-bezier(0, 0, 0.58, 1)`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * cssEaseOut(0); // => 0
 */
export function cssEaseOut(t: number): number {
	return (cssEaseOutCurve ??= cubicBezier(0, 0, 0.58, 1))(t);
}
let cssEaseInOutCurve: EasingFunction | undefined;
/**
 * CSS `ease-in-out`: `cubic-bezier(0.42, 0, 0.58, 1)`.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * Math.abs(cssEaseInOut(0.5) - 0.5) < 1e-12; // => true
 */
export function cssEaseInOut(t: number): number {
	return (cssEaseInOutCurve ??= cubicBezier(0.42, 0, 0.58, 1))(t);
}

/**
 * Creates an easing function equivalent to CSS `linear(...)`: a piecewise linear curve through the given stops, built and evaluated
 * with the algorithm of the CSS Easing Level 2 specification. A stop is an output alone, `[output, input]` or `[output, start, end]`
 * (inputs as fractions: `[0.5, 0.25]` is CSS `0.5 25%`). A first stop without an input is placed at `0`, a last one at `1`, the others
 * are spread evenly between their neighbours, and an input smaller than an earlier one is raised to it (two stops at the same input
 * make a jump). Inputs outside the stops extrapolate the first or last segment.
 *
 * Evaluation is `O(1)` when successive calls stay in the same segment (as in an animation) and `O(log stops)` otherwise.
 * @param {readonly LinearStop[]} stops - At least 2 stops, of finite numbers
 * @returns {EasingFunction} The piecewise linear easing (it returns the outputs of the stops exactly at their inputs)
 * @throws {TypeError} when `stops` is not an array, or a stop is not a number or an array of 2 or 3 numbers
 * @throws {RangeError} when there are fewer than 2 stops, or a stop holds a non-finite number
 * @example
 * const ease = cssLinear([0, 0.6, 1]); // CSS `linear(0, 0.6, 1)`
 * ease(0.25); // => 0.3
 * ease(0.75); // => 0.8
 * cssLinear([0, [0.25, 0.75], 1])(0.375); // => 0.125 // CSS `linear(0, 0.25 75%, 1)`
 * cssLinear([0, [0.5, 0.25, 0.75], 1])(0.5); // => 0.5 // held at 0.5 from 25% to 75%
 * cssLinear([0, [0, 0.5], [1, 0.5], 1])(0.5); // => 1 // a jump at 50%
 * cssLinear([0]); // throws RangeError
 */
export function cssLinear(stops: readonly LinearStop[]): EasingFunction {
	if (!Array.isArray(stops)) throw new TypeError(`cssLinear: \`stops\` must be an array of linear stops, got ${typeName(stops)}`);
	if (stops.length < 2) throw new RangeError(`cssLinear: \`stops\` must hold at least 2 stops, got ${stops.length}`);
	const inputs: number[] = [];
	const outputs: number[] = [];
	let largest = -Infinity;
	for (let i = 0; i < stops.length; i++) {
		const stop: unknown = stops[i];
		const values: unknown[] = typeof stop === 'number' ? [stop] : Array.isArray(stop) && (stop.length === 2 || stop.length === 3) ? stop : [];
		if (values.length === 0 || values.some(isNotNumber)) {
			throw new TypeError(`cssLinear: \`stops[${i}]\` must be a number or an array [output, input] or [output, start, end], got ${typeName(stop)}`);
		}
		if (!values.every(Number.isFinite)) throw new RangeError(`cssLinear: \`stops[${i}]\` must hold finite numbers, got ${String(stop)}`);
		const output = values[0] as number;
		// NaN marks a missing input, spread evenly below.
		if (values.length === 1) {
			outputs.push(output);
			inputs.push(i === 0 ? (largest = 0) : i === stops.length - 1 ? Math.max(1, largest) : NaN);
		}
		for (let j = 1; j < values.length; j++) {
			largest = Math.max(values[j] as number, largest);
			outputs.push(output);
			inputs.push(largest);
		}
	}
	// The first and last inputs are always known.
	for (let i = 1; i < inputs.length - 1; i++) {
		if (!Number.isNaN(inputs[i])) continue;
		let next = i + 1;
		while (Number.isNaN(inputs[next])) next++;
		const start = inputs[i - 1];
		const gap = next - i + 1;
		for (let k = i; k < next; k++) inputs[k] = start + ((inputs[next] - start) * (k - i + 1)) / gap;
		i = next;
	}

	const lastSegment = inputs.length - 2;
	/** Index of the first point of the segment of the previous call. */
	let segment = 0;
	return function (t) {
		if (Number.isNaN(t)) return t;
		// The segment starts at the last point whose input is <= t (the first point if none), and is not the last point.
		if (!(inputs[segment] <= t && (segment === lastSegment || t < inputs[segment + 1]))) {
			let low = 0;
			let high = lastSegment;
			while (low < high) {
				const middle = (low + high + 1) >> 1;
				if (inputs[middle] <= t) low = middle;
				else high = middle - 1;
			}
			segment = low;
		}
		const start = inputs[segment];
		const end = inputs[segment + 1];
		const from = outputs[segment];
		const to = outputs[segment + 1];
		// A flat segment stays flat even where the progress overflows (a subnormal segment width, t = ±Infinity).
		return start === end || from === to ? to : lerp(from, to, (t - start) / (end - start));
	};
}

/**
 * Whether a value is not a number (a callback of {@link cssLinear}'s validation).
 * @param {unknown} value - The value
 * @returns {boolean} `true` unless `value` is a number
 */
function isNotNumber(value: unknown): boolean {
	return typeof value !== 'number';
}

/**
 * Formats a number with at most `decimals` decimals, without trailing zeros or a minus sign on zero.
 * @param {number} value - The number
 * @param {number} decimals - Number of decimals, an integer in `[0, 100]`
 * @returns {string} The formatted number
 */
function formatDecimal(value: number, decimals: number): string {
	return String(Number(value.toFixed(decimals)) + 0);
}

/**
 * Approximates any easing with a CSS `linear(...)` function, to animate it natively with CSS transitions and animations or the Web
 * Animations API (springs, bounces, elastic curves: everything `cubic-bezier()` cannot express). The easing is sampled at `samples + 1`
 * evenly spaced points and simplified with the Ramer–Douglas–Peucker algorithm on the vertical distance, keeping only the stops needed to
 * stay within `tolerance` of every sample (rounding of the printed numbers included). Straight stretches cost nothing: `linear` gives
 * `'linear(0, 1)'`.
 * @param {EasingFunction} easing - The easing to approximate; it must return finite numbers on `[0, 1]`
 * @param {CssLinearOptions} [options={}] - `tolerance` (default `0.001`), `samples` (`1000`)
 * @returns {string} The CSS easing, e.g. `'linear(0, 0.25 50%, 1)'`
 * @throws {TypeError} when `easing` is not a function, or an option is not a number
 * @throws {RangeError} when `tolerance` is not in `(0, 1)`, `samples` is not an integer >= 2, or `easing` returns a non-finite number
 * @example
 * toCssLinear(linear); // => 'linear(0, 1)'
 * toCssLinear(easeInQuad, { tolerance: 0.1 }); // => 'linear(0, 0.25 50%, 1)'
 * toCssLinear(steps(2), { samples: 4 }); // => 'linear(0, 0 25%, 0.5 50%, 0.5 75%, 1)'
 * @example
 * // doctest: skip
 * const bouncy = spring({ stiffness: 170, damping: 12 });
 * element.animate(keyframes, { duration: bouncy.duration * 1000, easing: toCssLinear(bouncy.easing) });
 */
export function toCssLinear(easing: EasingFunction, options: CssLinearOptions = {}): string {
	assertFunction('toCssLinear', 'easing', easing);
	const tolerance = readOption(options, 'tolerance', 0.001);
	const samples = readOption(options, 'samples', 1000);
	assertNumber('toCssLinear', 'tolerance', tolerance, tolerance > 0 && tolerance < 1, 'a number between 0 and 1 (exclusive)');
	assertInteger('toCssLinear', 'samples', samples, 2);
	// Rounding the printed numbers moves them by at most half a unit of their last decimal: a tenth of the tolerance or less, which the
	// simplification leaves free (beyond 20 decimals the rounding is below double precision for outputs around 1).
	const decimals = Math.min(20, Math.ceil(Math.log10(5 / tolerance)));
	const budget = Math.max(0, tolerance - 0.5 * 10 ** -decimals);
	const values = new Float64Array(samples + 1);
	for (let i = 0; i <= samples; i++) {
		const value = easing(i / samples);
		if (!Number.isFinite(value)) throw new RangeError(`toCssLinear: \`easing\` must return finite numbers, got ${value} at t = ${i / samples}`);
		values[i] = value;
	}

	// Ramer–Douglas–Peucker: keep the sample farthest from the chord of each range (if it is beyond the budget) and split the range there.
	const kept = new Uint8Array(samples + 1);
	kept[0] = kept[samples] = 1;
	const ranges = [0, samples];
	while (ranges.length > 0) {
		const end = ranges.pop() as number;
		const start = ranges.pop() as number;
		const slope = (values[end] - values[start]) / (end - start);
		let farthest = budget;
		let split = 0;
		for (let i = start + 1; i < end; i++) {
			const distance = Math.abs(values[i] - values[start] - slope * (i - start));
			if (distance > farthest) {
				farthest = distance;
				split = i;
			}
		}
		if (split > 0) {
			kept[split] = 1;
			ranges.push(start, split, split, end);
		}
	}

	let stops = '';
	for (let i = 0; i <= samples; i++) {
		if (kept[i] === 0) continue;
		const output = formatDecimal(values[i], decimals);
		// The first and last stops default to 0% and 100%.
		stops += i === 0 ? output : i === samples ? `, ${output}` : `, ${output} ${formatDecimal((i * 100) / samples, decimals)}%`;
	}
	return `linear(${stops})`;
}

/**
 * Creates a step easing function equivalent to CSS `steps(count, position)`: the output jumps between `jumps + 1` evenly spaced
 * levels `0, 1/jumps, ..., 1`, where `jumps` is `count` (`jump-start` / `jump-end`), `count - 1` (`jump-none`) or `count + 1` (`jump-both`).
 * Inputs outside `[0, 1]` follow the CSS algorithm (`floor(t·count)` is not clamped there).
 * @param {number} count - Number of steps: an integer >= 1 (>= 2 for `'jump-none'`)
 * @param {StepPosition} [position='jump-end'] - Where the jumps happen: `'jump-start'` (at the start of each step), `'jump-end'` (at
 * the end), `'jump-none'` (neither at `0` nor at `1`), `'jump-both'` (both); `'start'` / `'end'` are aliases
 * @returns {EasingFunction} The step function
 * @throws {TypeError} when `count` is not a number or `position` is not a string
 * @throws {RangeError} when `count` is not a valid integer or `position` is not a step position
 * @example
 * [0, 0.2, 0.25, 0.5, 0.99, 1].map(steps(4)); // => [0, 0, 0.25, 0.5, 0.75, 1]
 * [0, 0.2, 0.25, 0.5, 0.99, 1].map(steps(4, 'jump-start')); // => [0.25, 0.25, 0.5, 0.75, 1, 1]
 * [0, 0.4, 0.5, 1].map(steps(2, 'jump-none')); // => [0, 0, 1, 1]
 * [0, 0.4, 0.5, 1].map(steps(2, 'jump-both')); // => [1 / 3, 1 / 3, 2 / 3, 1]
 * steps(1, 'jump-none'); // throws RangeError
 */
export function steps(count: number, position: StepPosition = 'jump-end'): EasingFunction {
	const config = typeof position === 'string' && Object.hasOwn(STEP_POSITIONS, position) ? STEP_POSITIONS[position] : undefined;
	if (config === undefined) {
		const message = `steps: \`position\` must be one of ${Object.keys(STEP_POSITIONS).join(', ')}, got ${typeof position === 'string' ? `'${position}'` : typeName(position)}`;
		throw typeof position === 'string' ? new RangeError(message) : new TypeError(message);
	}
	const [offset, extra] = config;
	assertInteger('steps', 'count', count, extra < 0 ? 2 : 1);
	const jumps = count + extra;

	return function (t) {
		// CSS also clamps negative steps to 0 for t >= 0, which only matters with its "before flag" (not modelled here).
		const step = Math.floor(t * count) + offset;
		return (t <= 1 ? Math.min(step, jumps) : step) / jumps;
	};
}

/**
 * Solves a damped harmonic oscillator (mass `m` on a spring of stiffness `k` with damping `c`) released at position `0` with initial
 * `velocity` towards a target at `1`, in closed form (under-, critically and over-damped cases), like the physics springs of
 * SwiftUI, Framer Motion or React Spring. Use `position(seconds)` to drive a time-based animation, or `easing` together with `duration`
 * (e.g. to generate CSS `linear()` keyframes or Web Animations).
 *
 * `duration` is the exact time after which the oscillator's energy `(k·x² + m·v²) / 2` stays below that of a `restDelta` displacement
 * at rest (energy never increases in a damped oscillator, so the spring then stays within `restDelta` of the target for good).
 * @param {SpringOptions} [options={}] - `stiffness` (default `100`), `damping` (`10`), `mass` (`1`), `velocity` (`0`), `restDelta` (`0.001`)
 * @returns {Spring} The solved spring: `position(time)` and `velocity(time)`, settle `duration` (seconds) and normalized `easing`
 * @throws {TypeError} when an option is not a number
 * @throws {RangeError} when `stiffness`, `damping` or `mass` is not a finite number > 0, `velocity` is not finite, `restDelta` is not
 * in `(0, 1)`, or the spring would not settle within a representable time
 * @example
 * const bouncy = spring({ stiffness: 100, damping: 10 });
 * bouncy.position(0); // => 0
 * bouncy.position(0.3) > 1; // => true // under-damped: overshoots
 * Math.abs(bouncy.position(bouncy.duration) - 1) <= 0.001; // => true
 * bouncy.easing(1); // => 1
 * spring({ velocity: 5 }).velocity(0); // => 5
 * bouncy.velocity(0.1) > 0; // => true // still heading for the target
 * @example
 * const smooth = spring({ stiffness: 100, damping: 20 }); // critically damped: never overshoots
 * smooth.position(0.5) < 1; // => true
 * spring({ damping: 0 }); // throws RangeError
 */
export function spring(options: SpringOptions = {}): Spring {
	// An option inherited from a polluted `Object.prototype` is ignored (see `readOption`): it must not change the physics.
	const stiffness = readOption(options, 'stiffness', 100);
	const damping = readOption(options, 'damping', 10);
	const mass = readOption(options, 'mass', 1);
	const velocity = readOption(options, 'velocity', 0);
	const restDelta = readOption(options, 'restDelta', 0.001);
	assertNumber('spring', 'stiffness', stiffness, stiffness > 0 && stiffness < Infinity, 'a finite number > 0');
	assertNumber('spring', 'damping', damping, damping > 0 && damping < Infinity, 'a finite number > 0');
	assertNumber('spring', 'mass', mass, mass > 0 && mass < Infinity, 'a finite number > 0');
	assertNumber('spring', 'velocity', velocity, Number.isFinite(velocity), 'a finite number');
	assertNumber('spring', 'restDelta', restDelta, restDelta > 0 && restDelta < 1, 'a number between 0 and 1 (exclusive)');

	// Two square roots: `stiffness / mass` can overflow or underflow where the natural frequency itself does not.
	const omega = Math.sqrt(stiffness) / Math.sqrt(mass);
	const zeta = damping / (2 * Math.sqrt(stiffness) * Math.sqrt(mass));
	/** `[x']`: velocity at the time of the last call of `displacement` (stored rather than returned, to avoid allocating). */
	const speed = [0];
	/** Returns the displacement from the target `x = position - 1` (`x(0) = -1`, `x'(0) = velocity`) at `time`, and stores its velocity in `speed[0]`. */
	let displacement: (time: number) => number;

	if (zeta < 1) {
		// Under-damped: x = e^(-ζωt)·(B·sin(ωd·t) - cos(ωd·t)).
		const decay = zeta * omega;
		const omegaD = omega * Math.sqrt(1 - zeta * zeta);
		const b = (velocity - decay) / omegaD;
		displacement = function (time) {
			const envelope = Math.exp(-decay * time);
			// Settled for good (and `sin(Infinity)` would be NaN for huge times).
			if (envelope === 0) return (speed[0] = 0);
			const sin = Math.sin(omegaD * time);
			const cos = Math.cos(omegaD * time);
			const x = envelope * (b * sin - cos);
			speed[0] = -decay * x + envelope * omegaD * (sin + b * cos);
			return x;
		};
	} else if (zeta === 1) {
		// Critically damped: x = e^(-ωt)·(B·t - 1).
		const b = velocity - omega;
		displacement = function (time) {
			const envelope = Math.exp(-omega * time);
			// Settled for good (and `b · time` may overflow to Infinity, which the zero envelope would turn into NaN).
			if (envelope === 0) return (speed[0] = 0);
			const x = envelope * (b * time - 1);
			speed[0] = envelope * b - omega * x;
			return x;
		};
	} else {
		// Over-damped: x = C1·e^(r1·t) + C2·e^(r2·t); r1 = ω²/r2 (= -ω/root) avoids cancellation for large ζ, and √(ζ - 1)·√(ζ + 1) the overflow of ζ².
		const root = zeta + Math.sqrt(zeta - 1) * Math.sqrt(zeta + 1);
		const r2 = -omega * root;
		// `ω² / r2`, written so that ω² cannot underflow or overflow.
		const r1 = -omega / root;
		const c2 = (velocity + r1) / (r2 - r1);
		const c1 = -1 - c2;
		displacement = function (time) {
			const e1 = c1 * Math.exp(r1 * time);
			const e2 = c2 * Math.exp(r2 * time);
			speed[0] = r1 * e1 + r2 * e2;
			return e1 + e2;
		};
	}

	/**
	 * Whether the spring has settled at `time` (its energy is below that of a `restDelta` displacement).
	 * @param {number} time - Seconds since the start
	 * @returns {boolean} `true` once settled (and forever after)
	 */
	function settled(time: number): boolean {
		const x = displacement(time);
		return stiffness * x * x + mass * speed[0] * speed[0] <= stiffness * restDelta * restDelta;
	}

	/**
	 * Position of the spring at `time` seconds.
	 * @param {number} time - Seconds since the start
	 * @returns {number} The position
	 */
	function position(time: number): number {
		return time <= 0 ? 0 : time === Infinity ? 1 : 1 + displacement(time);
	}

	let high = 1 / omega;
	while (!settled(high)) {
		high *= 2;
		// Also catches `omega` overflowing to Infinity (high === 0) or underflowing to 0.
		if (!(high > 0 && high < Infinity)) throw new RangeError('spring: the spring does not settle within a representable time; check `stiffness`, `damping` and `mass`');
	}
	let low = 0;
	for (let i = 0; i < 64; i++) {
		const middle = (low + high) / 2;
		if (settled(middle)) high = middle;
		else low = middle;
	}
	const duration = high;

	return {
		position,
		duration,
		easing: function (t) {
			return t >= 1 ? 1 : position(t * duration);
		},
		velocity: function (time) {
			if (!(time > 0)) return time === 0 ? velocity : time < 0 ? 0 : time;
			if (time === Infinity) return 0;
			displacement(time);
			return speed[0];
		}
	};
}

/**
 * Interpolates between two numbers with an easing function: `lerp(from, to, easing(t))`.
 * @param {number} from - Value at `t = 0`
 * @param {number} to - Value at `t = 1`
 * @param {number} t - Progress (usually in `[0, 1]`)
 * @param {EasingFunction} [easing=linear] - The easing applied to `t`
 * @returns {number} The eased value
 * @throws {TypeError} when `easing` is not a function
 * @example
 * interpolate(0, 100, 0.5); // => 50
 * interpolate(0, 100, 0.5, easeInQuad); // => 25
 * interpolate(10, 20, 1, easeOutBack); // => 20
 */
export function interpolate(from: number, to: number, t: number, easing: EasingFunction = linear): number {
	assertFunction('interpolate', 'easing', easing);
	return lerp(from, to, easing(t));
}
