// Type-checks test-d/consumer.ts against the built declarations (run after `yarn build`) and fails when the
// declarations stop compiling for a plain ES2022 consumer or when type-checking them gets expensive.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const INSTANTIATION_BUDGET = 66_000;
// The native TypeScript 7 compiler (`typescript` itself is the TypeScript 6 API package, for the tools that need one).
const tsc = join(dirname(createRequire(import.meta.url).resolve('@typescript/native/package.json')), 'bin', 'tsc');
let output;

try {
	output = execFileSync(process.execPath, [tsc, '-p', 'test-d', '--extendedDiagnostics'], { encoding: 'utf8' });
} catch (error) {
	console.error(error.stdout || error.message);
	console.error('The published declarations do not type-check for a plain ES2022 consumer.');
	process.exit(1);
}

const instantiations = Number(/Instantiations:\s+(\d+)/.exec(output)?.[1]);
const checkTime = /Check time:\s+([\d.]+s)/.exec(output)?.[1];
console.log(`declarations OK · ${instantiations} type instantiations · check time ${checkTime}`);

if (!(instantiations <= INSTANTIATION_BUDGET)) {
	console.error(`Type instantiations exceed the budget of ${INSTANTIATION_BUDGET}: a public type got more expensive to check.`);
	process.exit(1);
}
