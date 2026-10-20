import { compileSemverRange, incrementSemver, isSemverRange, maxSatisfyingSemver, minSatisfyingSemver, satisfiesSemver } from 'tinkit/validate';
import type { IncrementSemverOptions, SemverRangeOptions, SemverRelease } from 'tinkit/validate';

const rangeOptions: SemverRangeOptions = { includePrerelease: true };
const satisfied: boolean = satisfiesSemver('1.2.3', '^1.0.0', rangeOptions);
// @ts-expect-error includePrerelease is a boolean
satisfiesSemver('1.2.3', '^1.0.0', { includePrerelease: 'yes' });
// @ts-expect-error unknown option
satisfiesSemver('1.2.3', '^1.0.0', { loose: true });

const test: (version: string) => boolean = compileSemverRange('>=1.2.3 <2');
const kept: string[] = ['1.2.3', '2.0.0'].filter(test);
// @ts-expect-error the predicate takes a version string
test(123);

declare const input: unknown;
if (isSemverRange(input)) {
	const range: string = input;
	void range;
}

const highest: string | undefined = maxSatisfyingSemver(['1.0.0', '1.1.0'], '^1.0.0');
const lowest: string | undefined = minSatisfyingSemver(new Set(['1.0.0', '1.1.0']), '^1.0.0', rangeOptions);
// @ts-expect-error the result may be undefined
const definitely: string = maxSatisfyingSemver(['1.0.0'], '*');
// @ts-expect-error versions are strings
maxSatisfyingSemver([1, 2], '*');

const release: SemverRelease = 'prerelease';
const incrementOptions: IncrementSemverOptions = { identifier: 'beta', identifierBase: '1' };
const next: string = incrementSemver('1.2.3', release, incrementOptions);
incrementSemver('1.2.3', 'preminor', { identifier: 'alpha', identifierBase: false });
// @ts-expect-error not a release kind (node-semver's internal `pre` included)
incrementSemver('1.2.3', 'pre');
// @ts-expect-error identifierBase is '0', '1' or false
incrementSemver('1.2.3', 'prerelease', { identifierBase: 1 });
// @ts-expect-error identifierBase true is not a base
incrementSemver('1.2.3', 'prerelease', { identifierBase: true });

void [satisfied, kept, highest, lowest, definitely, next];
