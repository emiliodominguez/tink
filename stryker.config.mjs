// Mutation testing: Stryker changes the source in small ways (flips operators, removes conditions, ...)
// and checks that at least one test fails for every change. Surviving mutants point at untested behaviour.
// Usage: yarn test:mutation [--mutate "src/math/index.ts"]
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'jest',
	jest: { configFile: 'jest.config.cjs', enableFindRelatedTests: true },
	mutate: ['src/**/index.ts', 'src/utils/assert.ts'],
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html', 'json'],
	jsonReporter: { fileName: 'reports/mutation/mutation.json' },
	htmlReporter: { fileName: 'reports/mutation/index.html' },
	thresholds: { high: 90, low: 80, break: null },
	concurrency: 2,
	timeoutMS: 5000,
	// The instrumented initial run of the whole suite takes about 3.5 minutes on 8 cores: the default 5-minute limit fails under load.
	dryRunTimeoutMinutes: 15,
	tempDirName: '.stryker-tmp',
	ignorePatterns: ['dist', 'coverage', 'docs', 'reports', 'bench', '.stryker-tmp*']
};
