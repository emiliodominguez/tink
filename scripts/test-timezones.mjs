// Runs the test suite under several time zones (cross-platform replacement for `TZ=... jest`).
// The `date` module works in local time, so DST-heavy zones catch calendar-arithmetic bugs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const TIME_ZONES = ['UTC', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata', 'Pacific/Apia', 'America/Havana'];
// Jest's `exports` map hides its bin file, so resolve it through package.json.
const jestPackage = createRequire(import.meta.url).resolve('jest/package.json');
const jestBin = JSON.parse(readFileSync(jestPackage, 'utf8')).bin;
const jest = join(dirname(jestPackage), typeof jestBin === 'string' ? jestBin : jestBin.jest);
const extraArgs = process.argv.slice(2);

for (const [index, timeZone] of TIME_ZONES.entries()) {
	console.log(`\n▶ TZ=${timeZone}`);
	// The first run of the full suite also enforces the coverage thresholds from jest.config.cjs (a filtered run can't meet them).
	// The extra arguments come first: `--coverageReporters` takes an array and would swallow a path written after it.
	const coverage = index === 0 && extraArgs.length === 0 ? ['--coverage', '--coverageReporters=text-summary'] : [];
	const result = spawnSync(process.execPath, [jest, '--silent', ...extraArgs, ...coverage], { stdio: 'inherit', env: { ...process.env, TZ: timeZone } });

	if (result.status !== 0) {
		console.error(`\nTests failed with TZ=${timeZone}.`);
		process.exit(result.status ?? 1);
	}
}
