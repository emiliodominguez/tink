import bezier from 'bezier-easing';
import { cubicBezier, easeInOutCubic, easeInOutElastic, easeOutBounce, interpolate, spring, steps } from 'tinkit/easing';

// One animation's worth of frames: 1000 progress values in [0, 1].
const frames = Array.from({ length: 1000 }, function (_, i) {
	return i / 999;
});
const ours = cubicBezier(0.25, 0.1, 0.25, 1);
const theirs = bezier(0.25, 0.1, 0.25, 1);
const oursSteep = cubicBezier(0.9, 0, 0.1, 1);
const theirsSteep = bezier(0.9, 0, 0.1, 1);
const stepper = steps(12, 'jump-both');
const bouncy = spring({ stiffness: 170, damping: 12 });

/**
 * Sums `easing` over every frame.
 * @param {(t: number) => number} easing - The easing function
 * @returns {number} The sum
 */
function sweep(easing) {
	let total = 0;
	for (let i = 0; i < frames.length; i++) total += easing(frames[i]);
	return total;
}

export default [
	{
		name: 'cubicBezier (create)',
		fn: function () {
			return cubicBezier(0.25, 0.1, 0.25, 1);
		},
		competitors: {
			'bezier-easing': function () {
				return bezier(0.25, 0.1, 0.25, 1);
			}
		}
	},
	{
		name: 'cubicBezier (create + 60 frames)',
		fn: function () {
			const easing = cubicBezier(0.42, 0, 0.58, 1);
			let total = 0;
			for (let i = 0; i < 60; i++) total += easing(i / 59);
			return total;
		},
		competitors: {
			'bezier-easing': function () {
				const easing = bezier(0.42, 0, 0.58, 1);
				let total = 0;
				for (let i = 0; i < 60; i++) total += easing(i / 59);
				return total;
			}
		}
	},
	{
		name: 'cubicBezier ease (1000 frames)',
		fn: function () {
			return sweep(ours);
		},
		competitors: {
			'bezier-easing': function () {
				return sweep(theirs);
			}
		}
	},
	{
		name: 'cubicBezier (0.9, 0, 0.1, 1) (1000 frames)',
		fn: function () {
			return sweep(oursSteep);
		},
		competitors: {
			'bezier-easing': function () {
				return sweep(theirsSteep);
			}
		}
	},
	{
		name: 'easeInOutCubic (1000 frames)',
		fn: function () {
			return sweep(easeInOutCubic);
		},
		baseline: function () {
			return sweep(function (t) {
				return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
			});
		}
	},
	{
		name: 'easeInOutElastic (1000 frames)',
		fn: function () {
			return sweep(easeInOutElastic);
		}
	},
	{
		name: 'easeOutBounce (1000 frames)',
		fn: function () {
			return sweep(easeOutBounce);
		}
	},
	{
		name: 'steps(12, jump-both) (1000 frames)',
		fn: function () {
			return sweep(stepper);
		}
	},
	{
		name: 'spring (create)',
		fn: function () {
			return spring({ stiffness: 170, damping: 12 });
		}
	},
	{
		name: 'spring easing (1000 frames)',
		fn: function () {
			return sweep(bouncy.easing);
		}
	},
	{
		name: 'interpolate easeInOutCubic (1000 frames)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < frames.length; i++) total += interpolate(0, 300, frames[i], easeInOutCubic);
			return total;
		}
	}
];
