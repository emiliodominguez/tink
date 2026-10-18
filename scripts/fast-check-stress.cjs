// Jest setup file for jest.stress.cjs: raises the number of generated cases of every fast-check property.
// The CommonJS build is the one Jest resolves for `import fc from 'fast-check'` in the specs; it is required by path because the
// package's exports map hides it, and configuring it here applies to every spec of the run.
const { join } = require('node:path');

require(join(__dirname, '../node_modules/fast-check/lib/cjs/fast-check.js')).configureGlobal({ numRuns: Number(process.env.FC_RUNS) || 1000 });
