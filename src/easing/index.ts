import { lerp } from '../math/index.js';
import { assertFunction, assertInteger, assertNumber, readOption, describe as typeName } from '../utils/assert.js';

/**
 * An easing function: maps animation progress `t` (`0` at the start, `1` at the end) to eased progress.
 *
 * Every easing of this module returns exactly `0` (never `-0`) for `t = 0` and exactly `1` for `t = 1`, except the CSS `steps()` curves
 * that jump at the start (`steps(4, 'jump-start')(0) === 0.25`, as in CSS). Outside `[0, 1]` the formula easings extrapolate their
 * formula (e.g. `easeInQuad(2) === 4`; the circular easings return `NaN` where their square root is undefined: `easeInCirc` beyond
 * `±1`, `easeOutCirc` below `0` or above `2`), `cubicBezier` extrapolates linearly and `spring().easing` stays at `0` or `1`. `NaN`
 * gives `NaN`.
 */
export type EasingFunction = (t: number) => number;

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
}

/** Overshoot constant of the "back" easings (overshoots by about 10%). */
const BACK = 1.70158;
/**
 * Newton step below which {@link cubicBezier} applies it and stops solving `x(s) = t`: the next step would be of the order of its
 * square (times `x'' / 2x'`), below double precision.
 */
const BEZIER_STEP = 1e-8;
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
function bounce(t: number): number {
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
		return inOut(easing, t);
	};
}

/**
 * Evaluates the ease-in-out built from `easing` at `t` (see {@link easeInOut}).
 * @param {EasingFunction} easing - The ease-in function
 * @param {number} t - Progress
 * @returns {number} Eased progress
 */
function inOut(easing: EasingFunction, t: number): number {
	return t < 0.5 ? easing(2 * t) / 2 : 1 - easing(2 - 2 * t) / 2;
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
	return inOut(easeInQuad, t);
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
	return inOut(easeInCubic, t);
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
	return inOut(easeInQuart, t);
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
	return inOut(easeInQuint, t);
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
	return inOut(easeInSine, t);
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
	return inOut(easeInExpo, t);
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
	return inOut(easeInCirc, t);
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
	return inOut(easeInBack, t);
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
	return inOut(easeInElastic, t);
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
	return bounce(t);
}
/**
 * Bounce ease-in (reflection of {@link easeOutBounce}).
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInBounce(0.5); // => 0.234375
 */
export function easeInBounce(t: number): number {
	return 1 - bounce(1 - t);
}
/**
 * Bounce ease-in-out.
 * @param {number} t - Progress
 * @returns {number} Eased progress
 * @example
 * easeInOutBounce(0.5); // => 0.5
 */
export function easeInOutBounce(t: number): number {
	return inOut(easeInBounce, t);
}

/**
 * Solves `x(s) = t` for `s` in `[0, 1]`, where `x(s) = ((a·s + b)·s + c)·s` is increasing with `x(0) = 0` and `x(1) = 1`.
 *
 * Plain Newton–Raphson from `s = t`, which takes 3 to 5 steps for usual curves. Once a step is below `BEZIER_STEP` it is applied
 * and the result returned: Newton converges quadratically, so what that last step leaves is of the order of its square, at the limit
 * of double precision (|x(s) - t| of a few ulps). A step that leaves `(0, 1)` (or is infinite or NaN, where x is flat), or no
 * convergence within 8 steps, hands over to {@link solveBezierSafely}.
 * @param {number} a - Cubic coefficient
 * @param {number} b - Quadratic coefficient
 * @param {number} c - Linear coefficient
 * @param {number} t - Target value, in `(0, 1)`
 * @returns {number} The curve parameter `s`
 */
function solveBezier(a: number, b: number, c: number, t: number): number {
	let s = t;
	for (let i = 0; i < 8; i++) {
		const step = (((a * s + b) * s + c) * s - t) / ((3 * a * s + 2 * b) * s + c);
		const next = s - step;
		if (!(next > 0 && next < 1)) break;
		if (!(Math.abs(step) >= BEZIER_STEP)) return next;
		s = next;
	}
	return solveBezierSafely(a, b, c, t);
}

/**
 * Solves `x(s) = t` like {@link solveBezier}, for the curves where plain Newton–Raphson leaves `(0, 1)` or converges slowly.
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
 * within a few ulps of `t`; Newton–Raphson, safeguarded by bisection, which always converges because `x` is monotonic when
 * `x1, x2 ∈ [0, 1]`; for `t > 0.5` on the mirrored curve, so that both ends are equally precise), then returning `y(s)`.
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
		const s = t <= 0.5 ? solveBezier(ax, bx, cx, t) : 1 - solveBezier(mirroredAx, mirroredBx, mirroredCx, 1 - t);
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
 * @returns {Spring} The solved spring: `position(time)`, settle `duration` (seconds) and normalized `easing`
 * @throws {TypeError} when an option is not a number
 * @throws {RangeError} when `stiffness`, `damping` or `mass` is not a finite number > 0, `velocity` is not finite, `restDelta` is not
 * in `(0, 1)`, or the spring would not settle within a representable time
 * @example
 * const bouncy = spring({ stiffness: 100, damping: 10 });
 * bouncy.position(0); // => 0
 * bouncy.position(0.3) > 1; // => true // under-damped: overshoots
 * Math.abs(bouncy.position(bouncy.duration) - 1) <= 0.001; // => true
 * bouncy.easing(1); // => 1
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
