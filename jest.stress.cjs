// Property tests only, with 10x the generated cases (`yarn test:stress`): finds rare counterexamples before they surface as flaky
// pushes. Raise the count further with FC_RUNS (e.g. FC_RUNS=5000 yarn test:stress).
const base = require('./jest.config.cjs');

module.exports = {
	...base,
	testMatch: ['**/*.property.spec.ts'],
	setupFiles: ['<rootDir>/scripts/fast-check-stress.cjs'],
	coverageThreshold: undefined
};
