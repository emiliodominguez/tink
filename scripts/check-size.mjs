// Fails when the package grows past its budget. Run after `yarn build`.
// The budget that matters to consumers is `runtimeGzip`: the gzipped JavaScript of every module combined
// (bundlers only include the functions you import). Type declarations carry the full JSDoc and only affect install size.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = { runtimeGzip: 64 * 1024, packed: 280 * 1024 };
const [report] = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const javascript = Buffer.concat(
	report.files
		.filter(function (file) {
			return file.path.endsWith('.js');
		})
		.map(function (file) {
			return readFileSync(file.path);
		})
);
const runtimeGzip = gzipSync(javascript, { level: 9 }).length;

/**
 * Formats a byte count as kilobytes.
 * @param {number} bytes - The byte count
 * @returns {string} The formatted size
 */
function kb(bytes) {
	return `${(bytes / 1024).toFixed(1)} kB`;
}

console.log(`runtime JS ${kb(javascript.length)} (${kb(runtimeGzip)} gzip) · packed ${kb(report.size)} · unpacked ${kb(report.unpackedSize)} · ${report.entryCount} files`);

if (runtimeGzip > BUDGET.runtimeGzip || report.size > BUDGET.packed) {
	console.error(`Size budget exceeded (runtime gzip ≤ ${kb(BUDGET.runtimeGzip)}, packed ≤ ${kb(BUDGET.packed)}).`);
	process.exit(1);
}
