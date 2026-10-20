import nodePath from 'node:path';
import { basename, dirname, extname, formatPath, isAbsolutePath, joinPath, normalizePath, parsePath, relativePath, resolvePath, toPosixPath } from 'tinkit/path';

// Competitor: Node's own POSIX implementation (`path.posix`), which these helpers reproduce byte for byte without importing it.
const posix = nodePath.posix;
const file = '/home/user/projects/app/src/components/archive.tar.gz';
const normal = '/srv/app/node_modules/@scope/package/dist/index.js';
const dirty = '/srv/app//node_modules/./@scope/package/lib/../dist/index.js';
const windows = 'C:\\Users\\me\\projects\\app\\src\\index.ts';
const parts = { root: '/', dir: '/home/user', base: 'file.txt' };
// Node rebuilds its result at every `..`: quadratic on this input (about 0.1 s for 10k segments), linear here.
const adversarial = `//${'abcdefgh/'.repeat(10_000)}${'x/../'.repeat(10_000)}`;

export default [
	{
		name: 'basename',
		fn: function () {
			return basename(file);
		},
		competitors: {
			'path.posix': function () {
				return posix.basename(file);
			}
		}
	},
	{
		name: 'basename (suffix)',
		fn: function () {
			return basename(file, '.gz');
		},
		competitors: {
			'path.posix': function () {
				return posix.basename(file, '.gz');
			}
		}
	},
	{
		name: 'dirname',
		fn: function () {
			return dirname(file);
		},
		competitors: {
			'path.posix': function () {
				return posix.dirname(file);
			}
		}
	},
	{
		name: 'extname',
		fn: function () {
			return extname(file);
		},
		competitors: {
			'path.posix': function () {
				return posix.extname(file);
			}
		}
	},
	{
		name: 'isAbsolutePath',
		fn: function () {
			return isAbsolutePath(file);
		},
		competitors: {
			'path.posix': function () {
				return posix.isAbsolute(file);
			}
		}
	},
	{
		name: 'normalizePath (already normal)',
		fn: function () {
			return normalizePath(normal);
		},
		competitors: {
			'path.posix': function () {
				return posix.normalize(normal);
			}
		}
	},
	{
		name: 'normalizePath (`//`, `.` and `..`)',
		fn: function () {
			return normalizePath(dirty);
		},
		competitors: {
			'path.posix': function () {
				return posix.normalize(dirty);
			}
		}
	},
	{
		name: 'normalizePath (adversarial, 190 kB)',
		fn: function () {
			return normalizePath(adversarial);
		},
		competitors: {
			'path.posix': function () {
				return posix.normalize(adversarial);
			}
		}
	},
	{
		name: 'joinPath (3 clean segments)',
		fn: function () {
			return joinPath('src', 'components', 'index.ts');
		},
		competitors: {
			'path.posix': function () {
				return posix.join('src', 'components', 'index.ts');
			}
		}
	},
	{
		name: 'joinPath (5 segments, `..`)',
		fn: function () {
			return joinPath('/foo', 'bar', 'baz/asdf', 'quux', '..');
		},
		competitors: {
			'path.posix': function () {
				return posix.join('/foo', 'bar', 'baz/asdf', 'quux', '..');
			}
		}
	},
	{
		name: 'resolvePath (absolute)',
		fn: function () {
			return resolvePath(normal);
		},
		competitors: {
			'path.posix': function () {
				return posix.resolve(normal);
			}
		}
	},
	{
		name: 'resolvePath (2 segments)',
		fn: function () {
			return resolvePath('/foo/bar', './baz');
		},
		competitors: {
			'path.posix': function () {
				return posix.resolve('/foo/bar', './baz');
			}
		}
	},
	{
		name: 'relativePath',
		fn: function () {
			return relativePath('/data/orandea/test/aaa', '/data/orandea/impl/bbb');
		},
		competitors: {
			'path.posix': function () {
				return posix.relative('/data/orandea/test/aaa', '/data/orandea/impl/bbb');
			}
		}
	},
	{
		name: 'parsePath',
		fn: function () {
			return parsePath(file);
		},
		competitors: {
			'path.posix': function () {
				return posix.parse(file);
			}
		}
	},
	{
		name: 'formatPath',
		fn: function () {
			return formatPath(parts);
		},
		competitors: {
			'path.posix': function () {
				return posix.format(parts);
			}
		}
	},
	{
		name: 'toPosixPath',
		fn: function () {
			return toPosixPath(windows);
		},
		baseline: function () {
			return windows.split(nodePath.win32.sep).join(posix.sep);
		}
	}
];
