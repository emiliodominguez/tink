import { back, bounce, cssLinear, easeInCubic, easeOut, easeOutIn, elastic, power, smootherstep, smoothstep, spring, toCssLinear } from 'tinkit/easing';
import type { CssLinearOptions, EasingFunction, LinearStop, Spring } from 'tinkit/easing';

const custom: EasingFunction[] = [power(2.5), back(2), elastic(1.2, 0.4), bounce(4, 0.6), easeOutIn(easeInCubic), easeOut(bounce())];
const named: number = smoothstep(0.5) + smootherstep(0.5);

// Stops: an output alone, [output, input] or [output, start, end].
const stops: LinearStop[] = [0, [0.5, 0.25], [0.5, 0.25, 0.75], 1];
const linear: EasingFunction = cssLinear(stops);
const fromLiteral: EasingFunction = cssLinear([0, [1, 0.5], 1]);
// @ts-expect-error a stop holds at most two inputs
cssLinear([0, [0.5, 0.1, 0.2, 0.3], 1]);
// @ts-expect-error inputs are numbers, not CSS percentages
cssLinear([0, [0.5, '25%'], 1]);

const options: CssLinearOptions = { tolerance: 0.001, samples: 500 };
const css: string = toCssLinear(spring().easing, options);
// @ts-expect-error unknown option
toCssLinear(linear, { precision: 3 });

const solved: Spring = spring({ stiffness: 170, damping: 12 });
const speed: number = solved.velocity(0.1);
// @ts-expect-error velocity takes a time
solved.velocity();
void [custom, named, fromLiteral, css, speed];
