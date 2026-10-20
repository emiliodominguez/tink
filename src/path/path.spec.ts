import * as nodePath from 'node:path';
import { basename, dirname, extname, formatPath, isAbsolutePath, joinPath, normalizePath, parsePath, relativePath, resolvePath, toPosixPath, type PathObject } from '.';

const posix = nodePath.posix;

/** Values that are not strings, for the argument checks. */
const NON_STRINGS: unknown[] = [undefined, null, 1, true, 1n, Symbol('s'), {}, [], new String('a'), function () {}];

/**
 * Calls a function with arguments its signature does not allow, to check the run-time validation.
 * @param {(...args: never[]) => unknown} fn - The function
 * @param {...unknown} args - The arguments
 * @returns {unknown} The result
 */
function callLoosely(fn: (...args: never[]) => unknown, ...args: unknown[]): unknown {
	return (fn as (...args: unknown[]) => unknown)(...args);
}

describe('path', function () {
	describe('argument checks', function () {
		it.each(
			NON_STRINGS.map(function (value) {
				return [value];
			})
		)('rejects %p where a string is expected', function (value) {
			for (const fn of [basename, dirname, extname, isAbsolutePath, normalizePath, parsePath, toPosixPath]) {
				expect(function () {
					callLoosely(fn, value);
				}).toThrow(TypeError);
			}
			expect(function () {
				callLoosely(basename, 'a', value === undefined ? 1 : value);
			}).toThrow(TypeError);
			expect(function () {
				callLoosely(relativePath, value, 'a');
			}).toThrow(TypeError);
			expect(function () {
				callLoosely(relativePath, 'a', value);
			}).toThrow(TypeError);
			expect(function () {
				callLoosely(joinPath, 'a', value);
			}).toThrow(TypeError);
			expect(function () {
				callLoosely(resolvePath, 'a', value);
			}).toThrow(TypeError);
		});

		it('names the function and the parameter in the message', function () {
			expect(function () {
				callLoosely(basename, 1);
			}).toThrow(new TypeError('basename: `path` must be a string, got number'));
			expect(function () {
				callLoosely(basename, 'a', null);
			}).toThrow(new TypeError('basename: `suffix` must be a string, got null'));
			expect(function () {
				callLoosely(dirname, undefined);
			}).toThrow(new TypeError('dirname: `path` must be a string, got undefined'));
			expect(function () {
				callLoosely(extname, {});
			}).toThrow(new TypeError('extname: `path` must be a string, got object'));
			expect(function () {
				callLoosely(isAbsolutePath, 1n);
			}).toThrow(new TypeError('isAbsolutePath: `path` must be a string, got bigint'));
			expect(function () {
				callLoosely(normalizePath, true);
			}).toThrow(new TypeError('normalizePath: `path` must be a string, got boolean'));
			expect(function () {
				callLoosely(parsePath, Symbol('s'));
			}).toThrow(new TypeError('parsePath: `path` must be a string, got symbol'));
			expect(function () {
				callLoosely(toPosixPath, null);
			}).toThrow(new TypeError('toPosixPath: `path` must be a string, got null'));
			expect(function () {
				callLoosely(relativePath, 1, 'a');
			}).toThrow(new TypeError('relativePath: `from` must be a string, got number'));
			expect(function () {
				callLoosely(relativePath, 'a', 1);
			}).toThrow(new TypeError('relativePath: `to` must be a string, got number'));
			expect(function () {
				callLoosely(joinPath, 'a', 'b', 2);
			}).toThrow(new TypeError('joinPath: `segments[2]` must be a string, got number'));
			expect(function () {
				callLoosely(joinPath, null);
			}).toThrow(new TypeError('joinPath: `segments[0]` must be a string, got null'));
			expect(function () {
				callLoosely(resolvePath, 'a', 2);
			}).toThrow(new TypeError('resolvePath: `segments[1]` must be a string, got number'));
		});

		it('checks the segments of resolvePath before an absolute one, which Node skips', function () {
			expect(posix.resolve(1 as unknown as string, '/a')).toBe('/a');
			expect(function () {
				callLoosely(resolvePath, 1, '/a');
			}).toThrow(new TypeError('resolvePath: `segments[0]` must be a string, got number'));
		});

		it('does not accept String objects', function () {
			expect(function () {
				callLoosely(normalizePath, new String('/a'));
			}).toThrow(new TypeError('normalizePath: `path` must be a string, got object'));
		});
	});

	describe('basename', function () {
		// Node's test vectors (test/parallel/test-path-basename.js).
		it.each([
			['', ''],
			['/dir/basename.ext', 'basename.ext'],
			['/basename.ext', 'basename.ext'],
			['basename.ext', 'basename.ext'],
			['basename.ext/', 'basename.ext'],
			['basename.ext//', 'basename.ext'],
			['/aaa/bbb', 'bbb'],
			['/aaa/', 'aaa'],
			['/aaa/b', 'b'],
			['/a/b', 'b'],
			['//a', 'a'],
			['/', ''],
			['////', ''],
			['\\dir\\basename.ext', '\\dir\\basename.ext'],
			['\\basename.ext', '\\basename.ext'],
			['basename.ext\\', 'basename.ext\\'],
			['basename.ext\\\\', 'basename.ext\\\\'],
			['foo', 'foo'],
			['/a/b/Icon\r', 'Icon\r'],
			['/a/b/😀.txt', '😀.txt']
		])('basename(%p) is %p', function (path, expected) {
			expect(basename(path)).toBe(expected);
			expect(posix.basename(path)).toBe(expected);
		});

		it.each([
			['.js', '.js', ''],
			['js', '.js', 'js'],
			['file.js', '.ts', 'file.js'],
			['file', '.js', 'file'],
			['file.js.old', '.js.old', 'file'],
			['/home/user/file.txt', '.txt', 'file'],
			['aaa/bbb', 'bbb', 'bbb'],
			['aaa/bbb', 'a/bbb', 'bbb'],
			['aaa/bbb//', 'bbb', 'bbb'],
			['aaa/bbb', 'bb', 'b'],
			['aaa/bbb', 'b', 'bb'],
			['/aaa/bbb', '/bbb', 'bbb'],
			['/aaa/bbb', 'a/bbb', 'bbb'],
			['/aaa/bbb', 'bbb', 'bbb'],
			['/aaa/bbb//', 'bbb', 'bbb'],
			['/aaa/bbb', 'bb', 'b'],
			['/aaa/bbb', 'b', 'bb'],
			['a', 'a', ''],
			['a', '', 'a'],
			['a', 'abc', 'a'],
			['file.txt/', '.txt', 'file'],
			['dir/file.txt', 'file.txt', 'file.txt'],
			['a.txt', 'A.TXT', 'a.txt'],
			['x/.txt', '.txt', '.txt'],
			['x.txt/', 'x.txt/', ''],
			['x/', 'x/', ''],
			['ab/x', 'b/x', 'x'],
			['/', '/', ''],
			['a/', '', 'a'],
			['//', '', ''],
			// Node's quirk: a suffix longer than the segment that ends with all of it, and no longer than the path, keeps the trailing slashes.
			['/dir/', 'xdir', 'dir/'],
			['a/b/', 'xb', 'b/'],
			['b/', 'xb', 'b/'],
			['c//', 'bc', 'c//'],
			['/', 'x', '/'],
			['//', 'x/', '//'],
			['///', 'ab', '///'],
			// ...but not when the suffix is longer than the path.
			['c/', 'abc', 'c'],
			['/', 'xy', ''],
			['b/', 'xyb', 'b']
		])('basename(%p, %p) is %p', function (path, suffix, expected) {
			expect(basename(path, suffix)).toBe(expected);
			expect(posix.basename(path, suffix)).toBe(expected);
		});

		it('treats an undefined suffix as absent', function () {
			expect(basename('/a/b.txt', undefined)).toBe('b.txt');
		});
	});

	describe('dirname', function () {
		it.each([
			['/a/b/', '/a'],
			['/a/b', '/a'],
			['/a', '/'],
			['', '.'],
			['/', '/'],
			['////', '/'],
			['//a', '//'],
			['//a/', '//'],
			['///a', '//'],
			['//a/b', '//a'],
			['foo', '.'],
			['foo/', '.'],
			['foo/bar', 'foo'],
			['foo//bar', 'foo/'],
			['a/b/c//', 'a/b'],
			['.', '.'],
			['..', '.'],
			['../a', '..'],
			['\\a\\b', '.']
		])('dirname(%p) is %p', function (path, expected) {
			expect(dirname(path)).toBe(expected);
			expect(posix.dirname(path)).toBe(expected);
		});
	});

	describe('extname', function () {
		// Node's test vectors (test/parallel/test-path-extname.js), POSIX ones included.
		it.each([
			['', ''],
			['/path/to/file', ''],
			['/path/to/file.ext', '.ext'],
			['/path.to/file.ext', '.ext'],
			['/path.to/file', ''],
			['/path.to/.file', ''],
			['/path.to/.file.ext', '.ext'],
			['/path/to/f.ext', '.ext'],
			['/path/to/..ext', '.ext'],
			['/path/to/..', ''],
			['file', ''],
			['file.ext', '.ext'],
			['.file', ''],
			['.file.ext', '.ext'],
			['/file', ''],
			['/file.ext', '.ext'],
			['/.file', ''],
			['/.file.ext', '.ext'],
			['.path/file.ext', '.ext'],
			['file.ext.ext', '.ext'],
			['file.', '.'],
			['.', ''],
			['./', ''],
			['.file.', '.'],
			['.file..', '.'],
			['..', ''],
			['../', ''],
			['..file.ext', '.ext'],
			['..file', '.file'],
			['..file.', '.'],
			['..file..', '.'],
			['...', '.'],
			['...ext', '.ext'],
			['....', '.'],
			['file.ext/', '.ext'],
			['file.ext//', '.ext'],
			['file/', ''],
			['file//', ''],
			['file./', '.'],
			['file.//', '.'],
			['/..', ''],
			['a/..', ''],
			['.\\', ''],
			['..\\', '.\\'],
			['file.ext\\', '.ext\\'],
			['file.ext\\\\', '.ext\\\\'],
			['file\\', ''],
			['file\\\\', ''],
			['file.\\', '.\\'],
			['file.\\\\', '.\\\\'],
			['archive.tar.gz', '.gz'],
			['/', ''],
			['photo.JPEG', '.JPEG'],
			['😀.😀', '.😀']
		])('extname(%p) is %p', function (path, expected) {
			expect(extname(path)).toBe(expected);
			expect(posix.extname(path)).toBe(expected);
		});
	});

	describe('isAbsolutePath', function () {
		it.each([
			['/home/foo', true],
			['/home/foo/..', true],
			['/', true],
			['//server', true],
			['bar/', false],
			['./baz', false],
			['', false],
			['C:\\Users', false],
			['\\\\server', false],
			[' /a', false]
		])('isAbsolutePath(%p) is %p', function (path, expected) {
			expect(isAbsolutePath(path)).toBe(expected);
			expect(posix.isAbsolute(path)).toBe(expected);
		});
	});

	describe('normalizePath', function () {
		// Node's test vectors (test/parallel/test-path-normalize.js).
		it.each([
			['./fixtures///b/../b/c.js', 'fixtures/b/c.js'],
			['/foo/../../../bar', '/bar'],
			['a//b//../b', 'a/b'],
			['a//b//./c', 'a/b/c'],
			['a//b//.', 'a/b'],
			['/a/b/c/../../../x/y/z', '/x/y/z'],
			['///..//./foo/.//bar', '/foo/bar'],
			['bar/foo../../', 'bar/'],
			['bar/foo../..', 'bar'],
			['bar/foo../../baz', 'bar/baz'],
			['bar/foo../', 'bar/foo../'],
			['bar/foo..', 'bar/foo..'],
			['../foo../../../bar', '../../bar'],
			['../.../.././.../../../bar', '../../bar'],
			['../../../foo/../../../bar', '../../../../../bar'],
			['../../../foo/../../../bar/../../', '../../../../../../'],
			['../foobar/barfoo/foo/../../../bar/../../', '../../'],
			['../.../../foobar/../../../bar/../../baz', '../../../../baz'],
			['foo/bar\\baz', 'foo/bar\\baz'],
			['', '.'],
			['.', '.'],
			['./', './'],
			['.//', './'],
			['..', '..'],
			['../', '../'],
			['/', '/'],
			['//', '/'],
			['///', '/'],
			['/.', '/'],
			['/..', '/'],
			['/../', '/'],
			['a/..', '.'],
			['a/../', './'],
			['a/../..', '..'],
			['a', 'a'],
			['a/', 'a/'],
			['a//', 'a/'],
			['/a', '/a'],
			['/a/', '/a/'],
			['//a', '/a'],
			['/a//b', '/a/b'],
			['...', '...'],
			['.../..', '.'],
			['.a/./b.', '.a/b.'],
			['a/./b/../c', 'a/c'],
			['/x/y/../../..', '/'],
			['x/y/../../..', '..'],
			['../a/b/../../..', '../..'],
			['../a/../b', '../b'],
			['é/😀/../ü', 'é/ü'],
			['x/.a/..', 'x'],
			['.a/../b', 'b'],
			['a/.b/../..', '.'],
			['/a/../.b', '/.b']
		])('normalizePath(%p) is %p', function (path, expected) {
			expect(normalizePath(path)).toBe(expected);
			expect(posix.normalize(path)).toBe(expected);
		});

		it('returns an already normal path unchanged', function () {
			const path = '/srv/app/' + 'segment/'.repeat(10) + 'index.html';

			expect(normalizePath(path)).toBe(path);
		});

		it('is linear where Node is quadratic (a `..` after a long result)', function () {
			/**
			 * The fastest of three runs of normalizePath on the adversarial input with `count` segments, checking its result.
			 */
			function time(count: number): number {
				const path = '//' + 'abcdefgh/'.repeat(count) + 'x/../'.repeat(count);
				let best = Infinity;
				for (let run = 0; run < 3; run++) {
					const start = performance.now();
					expect(normalizePath(path)).toBe('/' + 'abcdefgh/'.repeat(count));
					best = Math.min(best, performance.now() - start);
				}
				return best;
			}

			// Node takes seconds on 80k segments. Four times the input costs about 4 times as long when linear, 16 when quadratic: a ratio
			// rather than a time limit holds on slow machines and under coverage or mutation-testing instrumentation alike.
			const small = time(20_000);
			expect(time(80_000) / Math.max(small, 1)).toBeLessThan(8);
		});

		it('handles deeply nested `..` chains of a relative path', function () {
			const count = 50_000;

			expect(normalizePath('a/'.repeat(count) + '../'.repeat(count + 2) + 'b')).toBe('../../b');
			expect(normalizePath('/' + 'a/'.repeat(count) + '../'.repeat(count + 2) + 'b')).toBe('/b');
		});
	});

	describe('joinPath', function () {
		// Node's test vectors (test/parallel/test-path-join.js).
		it.each<[string[], string]>([
			[['.', 'x/b', '..', '/b/c.js'], 'x/b/c.js'],
			[[], '.'],
			[['/.', 'x/b', '..', '/b/c.js'], '/x/b/c.js'],
			[['/foo', '../../../bar'], '/bar'],
			[['foo', '../../../bar'], '../../bar'],
			[['foo/', '../../../bar'], '../../bar'],
			[['foo/x', '../../../bar'], '../bar'],
			[['foo/x', './bar'], 'foo/x/bar'],
			[['foo/x/', './bar'], 'foo/x/bar'],
			[['foo/x/', '.', 'bar'], 'foo/x/bar'],
			[['./'], './'],
			[['.', './'], './'],
			[['.', '.', '.'], '.'],
			[['.', './', '.'], '.'],
			[['.', '/./', '.'], '.'],
			[['.', '/////./', '.'], '.'],
			[['.'], '.'],
			[['', '.'], '.'],
			[['', 'foo'], 'foo'],
			[['foo', '/bar'], 'foo/bar'],
			[['', '/foo'], '/foo'],
			[['', '', '/foo'], '/foo'],
			[['', '', 'foo'], 'foo'],
			[['foo', ''], 'foo'],
			[['foo/', ''], 'foo/'],
			[['foo', '', '/bar'], 'foo/bar'],
			[['./', '..', '/foo'], '../foo'],
			[['./', '..', '..', '/foo'], '../../foo'],
			[['.', '..', '..', '/foo'], '../../foo'],
			[['', '..', '..', '/foo'], '../../foo'],
			[['/'], '/'],
			[['/', '.'], '/'],
			[['/', '..'], '/'],
			[['/', '..', '..'], '/'],
			[[''], '.'],
			[['', ''], '.'],
			[[' /foo'], ' /foo'],
			[[' ', 'foo'], ' /foo'],
			[[' ', '.'], ' '],
			[[' ', '/'], ' /'],
			[[' ', ''], ' '],
			[['/', 'foo'], '/foo'],
			[['/', '/foo'], '/foo'],
			[['/', '//foo'], '/foo'],
			[['/', '', '/foo'], '/foo'],
			[['', '/', 'foo'], '/foo'],
			[['', '/', '/foo'], '/foo'],
			[['src', 'utils', 'index.ts'], 'src/utils/index.ts']
		])('joinPath(...%p) is %p', function (segments, expected) {
			expect(joinPath(...segments)).toBe(expected);
			expect(posix.join(...segments)).toBe(expected);
		});
	});

	describe('resolvePath', function () {
		// Node's test vectors (test/parallel/test-path-resolve.js), with the working directory being the virtual root `/`.
		it.each<[string[], string]>([
			[['/var/lib', '../', 'file/'], '/var/file'],
			[['/var/lib', '/../', 'file/'], '/file'],
			[['a/b/c/', '../../..'], '/'],
			[['.'], '/'],
			[['/some/dir', '.', '/absolute/'], '/absolute'],
			[['/foo/tmp.3/', '../tmp.3/cycles/root.js'], '/foo/tmp.3/cycles/root.js'],
			[[], '/'],
			[[''], '/'],
			[['', ''], '/'],
			[['/'], '/'],
			[['//'], '/'],
			[['a'], '/a'],
			[['a/'], '/a'],
			[['a', '', 'b'], '/a/b'],
			[['..'], '/'],
			[['/a/b', '..', '..', '..'], '/'],
			[['/foo/bar', './baz'], '/foo/bar/baz'],
			[['/foo/bar', '/tmp/file/'], '/tmp/file'],
			[['www', 'static/', '../img/logo.png'], '/www/img/logo.png'],
			[['/a', 'b', '/c', 'd'], '/c/d'],
			[['/a/b/c'], '/a/b/c']
		])('resolvePath(...%p) is %p', function (segments, expected) {
			expect(resolvePath(...segments)).toBe(expected);
			expect(posix.resolve('/', ...segments)).toBe(expected);
		});

		it('returns an already resolved absolute path unchanged', function () {
			const path = '/srv/app/' + 'segment/'.repeat(10) + 'index.html';

			expect(resolvePath(path)).toBe(path);
		});

		it('is linear in the total length of many segments', function () {
			const segments = Array.from({ length: 20_000 }, function (_, index) {
				return index % 3 === 2 ? '..' : `dir${index}`;
			});

			expect(resolvePath(...segments)).toBe(posix.resolve('/', ...segments));
		});
	});

	describe('relativePath', function () {
		// Node's test vectors (test/parallel/test-path-relative.js).
		it.each([
			['/var/lib', '/var', '..'],
			['/var/lib', '/bin', '../../bin'],
			['/var/lib', '/var/lib', ''],
			['/var/lib', '/var/apache', '../apache'],
			['/var/', '/var/lib', 'lib'],
			['/', '/var/lib', 'var/lib'],
			['/foo/test', '/foo/test/bar/package.json', 'bar/package.json'],
			['/Users/a/web/b/test/mails', '/Users/a/web/b', '../..'],
			['/foo/bar/baz-quux', '/foo/bar/baz', '../baz'],
			['/foo/bar/baz', '/foo/bar/baz-quux', '../baz-quux'],
			['/baz-quux', '/baz', '../baz'],
			['/baz', '/baz-quux', '../baz-quux'],
			['/page1/page2/foo', '/', '../../..'],
			['/a', '/', '..'],
			['/', '/a', 'a'],
			['/', '/', ''],
			['/a/b', '/a/b/', ''],
			['/a/./b', '/a/b', ''],
			['/data/orandea/test/aaa', '/data/orandea/impl/bbb', '../../impl/bbb'],
			['/a/b', '/a/b/c/d', 'c/d'],
			['/a/b/', '/a', '..'],
			['/ab', '/a', '../a'],
			['/a', '/ab', '../ab'],
			['/a/bc', '/a/b', '../b'],
			['/a//b', '/a/b/c', 'c']
		])('relativePath(%p, %p) is %p', function (from, to, expected) {
			expect(relativePath(from, to)).toBe(expected);
			expect(posix.relative(from, to)).toBe(expected);
		});

		it.each([
			['src', 'src/index.ts', 'index.ts'],
			['', 'a/b', 'a/b'],
			['a/b', '', '../..'],
			['', '', ''],
			['.', '/', ''],
			['a', 'b', '../b'],
			['../a', 'a', ''],
			['a/../b', 'c', '../c']
		])('resolves the relative paths %p and %p against the virtual root', function (from, to, expected) {
			expect(relativePath(from, to)).toBe(expected);
			expect(posix.relative(posix.join('/', from), posix.join('/', to))).toBe(expected);
		});
	});

	describe('parsePath', function () {
		// Node's test vectors (test/parallel/test-path-parse-format.js).
		it.each<[string, PathObject]>([
			['/home/user/dir/file.txt', { root: '/', dir: '/home/user/dir', base: 'file.txt', ext: '.txt', name: 'file' }],
			['/home/user/a dir/another File.zip', { root: '/', dir: '/home/user/a dir', base: 'another File.zip', ext: '.zip', name: 'another File' }],
			['/home/user/a dir//another&File.', { root: '/', dir: '/home/user/a dir/', base: 'another&File.', ext: '.', name: 'another&File' }],
			['user/dir/another File.zip', { root: '', dir: 'user/dir', base: 'another File.zip', ext: '.zip', name: 'another File' }],
			['file', { root: '', dir: '', base: 'file', ext: '', name: 'file' }],
			['.\\file', { root: '', dir: '', base: '.\\file', ext: '', name: '.\\file' }],
			['./file', { root: '', dir: '.', base: 'file', ext: '', name: 'file' }],
			['C:\\foo', { root: '', dir: '', base: 'C:\\foo', ext: '', name: 'C:\\foo' }],
			['/', { root: '/', dir: '/', base: '', ext: '', name: '' }],
			['', { root: '', dir: '', base: '', ext: '', name: '' }],
			['.', { root: '', dir: '', base: '.', ext: '', name: '.' }],
			['..', { root: '', dir: '', base: '..', ext: '', name: '..' }],
			['/foo', { root: '/', dir: '/', base: 'foo', ext: '', name: 'foo' }],
			['/foo.', { root: '/', dir: '/', base: 'foo.', ext: '.', name: 'foo' }],
			['/foo.bar', { root: '/', dir: '/', base: 'foo.bar', ext: '.bar', name: 'foo' }],
			['/.', { root: '/', dir: '/', base: '.', ext: '', name: '.' }],
			['/.foo', { root: '/', dir: '/', base: '.foo', ext: '', name: '.foo' }],
			['/.foo.bar', { root: '/', dir: '/', base: '.foo.bar', ext: '.bar', name: '.foo' }],
			['/foo/bar.baz', { root: '/', dir: '/foo', base: 'bar.baz', ext: '.baz', name: 'bar' }],
			['./', { root: '', dir: '', base: '.', ext: '', name: '.' }],
			['//', { root: '/', dir: '/', base: '', ext: '', name: '' }],
			['///', { root: '/', dir: '/', base: '', ext: '', name: '' }],
			['/foo///', { root: '/', dir: '/', base: 'foo', ext: '', name: 'foo' }],
			['/foo///bar.baz', { root: '/', dir: '/foo//', base: 'bar.baz', ext: '.baz', name: 'bar' }],
			['a/..', { root: '', dir: 'a', base: '..', ext: '', name: '..' }],
			['a/b/..', { root: '', dir: 'a/b', base: '..', ext: '', name: '..' }],
			['...', { root: '', dir: '', base: '...', ext: '.', name: '..' }],
			['..a', { root: '', dir: '', base: '..a', ext: '.a', name: '.' }],
			['archive.tar.gz', { root: '', dir: '', base: 'archive.tar.gz', ext: '.gz', name: 'archive.tar' }],
			// Node's quirk, reproduced: `extname('/..')` is `''`, but `parse('/..')` reads an extension.
			['/..', { root: '/', dir: '/', base: '..', ext: '.', name: '.' }]
		])('parsePath(%p)', function (path, expected) {
			expect(parsePath(path)).toStrictEqual(expected);
			expect(posix.parse(path)).toStrictEqual(expected);
		});

		it('returns a plain object with the keys in Node order', function () {
			const parsed = parsePath('/a/b.c');

			expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
			expect(Object.keys(parsed)).toEqual(['root', 'dir', 'base', 'ext', 'name']);
			expect(JSON.stringify(parsed)).toBe(JSON.stringify(posix.parse('/a/b.c')));
		});
	});

	describe('formatPath', function () {
		it.each<[PathObject, string]>([
			[{ dir: 'some/dir' }, 'some/dir/'],
			[{ base: 'index.html' }, 'index.html'],
			[{ root: '/' }, '/'],
			[{ name: 'index', ext: '.html' }, 'index.html'],
			[{ dir: 'some/dir', name: 'index', ext: '.html' }, 'some/dir/index.html'],
			[{ root: '/', name: 'index', ext: '.html' }, '/index.html'],
			[{}, ''],
			[{ name: 'x', ext: 'png' }, 'x.png'],
			[{ name: 'x', ext: '..png' }, 'x..png'],
			[{ name: 'x', ext: '' }, 'x'],
			[{ ext: 'png' }, '.png'],
			[{ ext: '.' }, '.'],
			[{ root: '/', dir: '/', base: 'x' }, '/x'],
			[{ root: '/', dir: '/home', base: 'x' }, '/home/x'],
			[{ root: '/root/', dir: '', base: 'x' }, '/root/x'],
			[{ root: '/ignored', dir: '/home', base: 'a', name: 'ignored' }, '/home/a'],
			[{ root: 'x', dir: 'x', base: 'y' }, 'xy'],
			[{ dir: '/home/user', base: 'file.txt' }, '/home/user/file.txt'],
			[{ dir: '', base: '' }, ''],
			[{ root: '', dir: 'a', base: '', name: 'b', ext: 'c' }, 'a/b.c'],
			[{ root: undefined, dir: undefined, base: 'a', name: undefined, ext: undefined }, 'a']
		])('formatPath(%p) is %p', function (pathObject, expected) {
			expect(formatPath(pathObject)).toBe(expected);
			expect(posix.format(pathObject)).toBe(expected);
		});

		it('rejects what is not an object', function () {
			for (const value of [null, undefined, 1, 'a/b', true, function () {}]) {
				expect(function () {
					callLoosely(formatPath, value);
				}).toThrow(TypeError);
			}
			expect(function () {
				callLoosely(formatPath, null);
			}).toThrow(new TypeError('formatPath: `pathObject` must be an object, got null'));
			expect(function () {
				callLoosely(formatPath, []);
			}).toThrow(new TypeError('formatPath: `pathObject` must be an object, got array'));
			expect(function () {
				callLoosely(formatPath, 'a/b');
			}).toThrow(new TypeError('formatPath: `pathObject` must be an object, got string'));
		});

		it.each(['root', 'dir', 'base', 'name', 'ext'])('rejects a non-string %s', function (key) {
			expect(function () {
				callLoosely(formatPath, { [key]: 1 });
			}).toThrow(new TypeError(`formatPath: \`pathObject.${key}\` must be a string, got number`));
			expect(function () {
				callLoosely(formatPath, { [key]: null });
			}).toThrow(new TypeError(`formatPath: \`pathObject.${key}\` must be a string, got null`));
		});

		it('checks every part, even one Node would not read', function () {
			expect(posix.format({ base: 'a', name: 1 } as unknown as PathObject)).toBe('a');
			expect(function () {
				callLoosely(formatPath, { base: 'a', name: 1 });
			}).toThrow(new TypeError('formatPath: `pathObject.name` must be a string, got number'));
			expect(function () {
				callLoosely(formatPath, { dir: '/a', root: false });
			}).toThrow(new TypeError('formatPath: `pathObject.root` must be a string, got boolean'));
		});

		it('ignores parts inherited from a polluted Object.prototype', function () {
			const prototype = Object.prototype as Record<string, unknown>;

			try {
				prototype.dir = '/evil';
				prototype.base = 'payload';
				prototype.root = '/';
				prototype.name = 'n';
				prototype.ext = '.e';
				expect(formatPath({ name: 'index', ext: '.html' })).toBe('index.html');
				expect(formatPath({})).toBe('');
				// Own parts equal to the polluted values are still read.
				expect(formatPath({ dir: '/evil', base: 'payload' })).toBe('/evil/payload');
				expect(formatPath({ root: '/', name: 'n', ext: '.e' })).toBe('/n.e');
			} finally {
				delete prototype.dir;
				delete prototype.base;
				delete prototype.root;
				delete prototype.name;
				delete prototype.ext;
			}
		});

		it('reads class getters, and each part once', function () {
			let reads = 0;
			class Parts {
				get dir(): string {
					reads++;
					return '/srv';
				}

				get base(): string {
					reads++;
					return 'app.js';
				}
			}

			expect(formatPath(new Parts())).toBe('/srv/app.js');
			expect(reads).toBe(2);
		});

		it('accepts a null-prototype object', function () {
			const parts = Object.assign(Object.create(null) as PathObject, { dir: '/a', base: 'b' });

			expect(formatPath(parts)).toBe('/a/b');
		});

		it('round-trips the parts of a path', function () {
			for (const path of ['/home/user/dir/file.txt', 'user/dir/another File.zip', 'file', './file', '/', '', '.', '..', '/foo.', '/.foo.bar']) {
				expect(formatPath(parsePath(path))).toBe(path);
			}
		});
	});

	describe('toPosixPath', function () {
		it.each([
			['src\\utils\\index.ts', 'src/utils/index.ts'],
			['C:\\Users\\me', 'C:/Users/me'],
			['\\\\server\\share', '//server/share'],
			['already/posix', 'already/posix'],
			['', ''],
			['mixed\\and/both', 'mixed/and/both']
		])('toPosixPath(%p) is %p', function (path, expected) {
			expect(toPosixPath(path)).toBe(expected);
		});

		it('returns a path without backslashes unchanged', function () {
			const path = '/srv/app/' + 'segment/'.repeat(10) + 'index.html';

			expect(toPosixPath(path)).toBe(path);
		});
	});
});
