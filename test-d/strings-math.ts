import { histogram, movingAverage, sumPrecise, toSignificant } from 'tinkit/math';
import type { HistogramBin, HistogramOptions } from 'tinkit/math';
import { compareNatural, stringWidth, truncateMiddle } from 'tinkit/strings';
import type { CompareNaturalOptions, TruncateMiddleOptions } from 'tinkit/strings';

const precise: number = sumPrecise(new Set([0.1, 0.2]));
sumPrecise(new Float64Array([1, 2]));
// @ts-expect-error items must be numbers
sumPrecise(['1']);
const averages: number[] = movingAverage([1, 2, 3], 2);
const significant: number = toSignificant(123456, 2);
const bins: HistogramBin[] = histogram([1, 2, 3], { bins: 2, domain: [0, 4] });
histogram([1, 2, 3], { thresholds: [2] });
const histogramOptions: HistogramOptions = { bins: 3 };
// @ts-expect-error bins and thresholds cannot be combined
histogram([1, 2, 3], { bins: 2, thresholds: [2] });
// @ts-expect-error the domain is a pair
histogram([1, 2, 3], { domain: [0, 1, 2] });
const naturallySorted: string[] = ['b', 'a10', 'a2'].sort(compareNatural);
const naturalOptions: CompareNaturalOptions = { ignoreCase: true };
// @ts-expect-error strings only
[1, 2].sort(compareNatural);
const middleOptions: TruncateMiddleOptions = { ellipsis: '...', position: 0.25 };
const middle: string = truncateMiddle('abcdef', 3, middleOptions);
// @ts-expect-error unknown option
truncateMiddle('abcdef', 3, { bias: 0.5 });
const columns: number = stringWidth('古池や');
void [precise, averages, significant, bins, histogramOptions, naturallySorted, naturalOptions, middle, columns];
