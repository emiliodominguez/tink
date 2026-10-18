/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	roots: ['<rootDir>/src'],
	testMatch: ['**/*.spec.ts'],
	transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }] },
	moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
	clearMocks: true,
	restoreMocks: true,
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/types.ts'],
	coverageDirectory: 'coverage',
	coverageReporters: ['text', 'lcov'],
	coverageThreshold: {
		global: {
			branches: 100,
			functions: 100,
			lines: 100,
			statements: 100
		}
	}
};
