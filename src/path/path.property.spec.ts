import fc from 'fast-check';
import * as nodePath from 'node:path';
import { basename, dirname, extname, formatPath, isAbsolutePath, joinPath, normalizePath, parsePath, relativePath, resolvePath, toPosixPath } from '.';

const posix = nodePath.posix;

/** The pieces paths are made of, heavy in separators and dot segments (backslashes, spaces, astral characters and lone surrogates too). */
const piece = fc.oneof(
	{ arbitrary: fc.constantFrom('/', '/', '/', '//', '.', '..', '...', 'a', 'b', 'a.b', '.a', 'a.', '\\', ' ', 'é', '😀', '\ud800'), weight: 8 },
	{ arbitrary: fc.string({ unit: 'binary', maxLength: 3 }), weight: 1 }
);
/** A path: any string, most of them path-like. */
const path = fc.oneof(
	{
		arbitrary: fc.array(piece, { maxLength: 12 }).map(function (pieces) {
			return pieces.join('');
		}),
		weight: 9
	},
	{ arbitrary: fc.string({ unit: 'binary' }), weight: 1 }
);
/** A list of paths for the variadic functions. */
const paths = fc.array(path, { maxLength: 5 });
/** A suffix for `basename`: short, often a tail of a path. */
const suffix = fc.oneof(fc.constantFrom('', '.', '..', 'a', 'b', '.b', 'a.b', '/', 'b/', '😀'), path);
/** The parts given to `formatPath` (each one possibly missing). */
const parts = fc.record({ root: path, dir: path, base: path, ext: path, name: path }, { requiredKeys: [] });

/**
 * Whether Node's `parse` reads an extension that `extname` does not: an absolute path whose last segment is `..` and the only one.
 * @param {string} value - The path
 * @returns {boolean} `true` for `/..`, `//../` and the like
 */
function isRootDotDot(value: string): boolean {
	const parsed = posix.parse(value);

	return parsed.root === '/' && parsed.dir === '/' && parsed.base === '..';
}

describe('path (properties)', function () {
	describe('equals node:path posix', function () {
		it('basename, dirname, extname, isAbsolutePath, normalizePath and toPosixPath', function () {
			fc.assert(
				fc.property(path, function (value) {
					expect(basename(value)).toBe(posix.basename(value));
					expect(dirname(value)).toBe(posix.dirname(value));
					expect(extname(value)).toBe(posix.extname(value));
					expect(isAbsolutePath(value)).toBe(posix.isAbsolute(value));
					expect(normalizePath(value)).toBe(posix.normalize(value));
					expect(toPosixPath(value)).toBe(value.replaceAll('\\', '/'));
				})
			);
		});

		it('basename with a suffix', function () {
			fc.assert(
				fc.property(path, suffix, function (value, end) {
					expect(basename(value, end)).toBe(posix.basename(value, end));
					expect(basename(value + end, end)).toBe(posix.basename(value + end, end));
					// A suffix ending with the whole segment (Node's trailing-slash quirk when it is longer than the segment).
					const longer = end + posix.basename(value);

					expect(basename(value, longer)).toBe(posix.basename(value, longer));
				})
			);
		});

		it('parsePath, with the same keys in the same order', function () {
			fc.assert(
				fc.property(path, function (value) {
					expect(JSON.stringify(parsePath(value))).toBe(JSON.stringify(posix.parse(value)));
				})
			);
		});

		it('formatPath', function () {
			fc.assert(
				fc.property(parts, function (pathObject) {
					expect(formatPath(pathObject)).toBe(posix.format(pathObject));
				})
			);
		});

		it('joinPath', function () {
			fc.assert(
				fc.property(paths, function (segments) {
					expect(joinPath(...segments)).toBe(posix.join(...segments));
				})
			);
		});

		it('resolvePath, against the root `/`', function () {
			fc.assert(
				fc.property(paths, function (segments) {
					expect(resolvePath(...segments)).toBe(posix.resolve('/', ...segments));
				})
			);
		});

		it('relativePath of absolute paths', function () {
			fc.assert(
				fc.property(path, path, function (from, to) {
					expect(relativePath(`/${from}`, `/${to}`)).toBe(posix.relative(`/${from}`, `/${to}`));
				})
			);
		});

		it('relativePath of any paths, relative ones resolved against `/`', function () {
			fc.assert(
				fc.property(path, path, function (from, to) {
					expect(relativePath(from, to)).toBe(posix.relative(posix.join('/', from), posix.join('/', to)));
				})
			);
		});

		it('normalizePath on long paths with deep `..` chains', function () {
			const segment = fc.constantFrom('a', 'bc', '..', '.', '', '...');

			fc.assert(
				fc.property(fc.array(segment, { maxLength: 200 }), fc.boolean(), function (segments, absolute) {
					const value = (absolute ? '/' : '') + segments.join('/');

					expect(normalizePath(value)).toBe(posix.normalize(value));
				})
			);
		});
	});

	describe('laws', function () {
		it('normalizePath is idempotent, and joinPath normalizes', function () {
			fc.assert(
				fc.property(path, paths, function (value, segments) {
					const normal = normalizePath(value);

					expect(normalizePath(normal)).toBe(normal);
					expect(normalizePath(joinPath(...segments))).toBe(joinPath(...segments));
				})
			);
		});

		it('resolvePath gives an absolute, normal path without a trailing slash', function () {
			fc.assert(
				fc.property(paths, function (segments) {
					const resolved = resolvePath(...segments);

					expect(isAbsolutePath(resolved)).toBe(true);
					expect(normalizePath(resolved)).toBe(resolved);
					expect(resolved === '/' || !resolved.endsWith('/')).toBe(true);
					expect(resolvePath(resolved)).toBe(resolved);
				})
			);
		});

		it('relativePath leads from `from` to `to`', function () {
			fc.assert(
				fc.property(path, path, function (from, to) {
					const relative = relativePath(from, to);

					expect(resolvePath(from, relative)).toBe(resolvePath(to));
					expect(relative === '' || (!isAbsolutePath(relative) && !relative.endsWith('/') && normalizePath(relative) === relative)).toBe(true);
					expect(relativePath(to, from) === '').toBe(relative === '');
				})
			);
		});

		it("parsePath agrees with basename and extname (except Node's `/..` quirk), and formatPath inverts it", function () {
			fc.assert(
				fc.property(path, function (value) {
					const parsed = parsePath(value);

					expect(parsed.base).toBe(basename(value));
					expect(parsed.name + parsed.ext).toBe(parsed.base);
					if (!isRootDotDot(value)) {
						expect(parsed.ext).toBe(extname(value));
						expect(parsePath(formatPath(parsed))).toStrictEqual(parsed);
					}
				})
			);
		});

		it('dirname and basename split a normal path that joinPath puts back together', function () {
			fc.assert(
				fc.property(path, function (value) {
					const normal = normalizePath(value);

					fc.pre(normal !== '/' && !normal.endsWith('/'));
					expect(joinPath(dirname(normal), basename(normal))).toBe(normal);
				})
			);
		});

		it('toPosixPath only replaces backslashes', function () {
			fc.assert(
				fc.property(path, function (value) {
					const converted = toPosixPath(value);

					expect(converted.length).toBe(value.length);
					expect(converted.includes('\\')).toBe(false);
					expect(toPosixPath(converted)).toBe(converted);
					for (let index = 0; index < value.length; index++) {
						if (value[index] !== '\\') expect(converted[index]).toBe(value[index]);
					}
				})
			);
		});
	});
});
