/**
 * POSIX path helpers that run in every runtime (browsers, workers, Deno, Bun, edge functions) without importing `node:path`:
 * {@link basename}, {@link dirname}, {@link extname}, {@link joinPath}, {@link normalizePath}, {@link resolvePath},
 * {@link relativePath}, {@link isAbsolutePath}, {@link parsePath} / {@link formatPath}, and {@link toPosixPath} for Windows separators.
 *
 * Conventions shared by every function in this module:
 * - **Node's results, byte for byte.** For every string input, each function returns exactly what the matching `path.posix` function
 *   of Node.js returns (checked against `node:path` on random paths of `/`, `.`, `..`, backslashes and astral characters, and on Node's
 *   own test vectors), quirks included: `dirname('//a')` is `'//'`, `normalizePath('a/')` keeps its trailing slash.
 * - **A virtual root instead of a working directory.** There is no `process.cwd()` outside Node, so {@link resolvePath} and
 *   {@link relativePath} resolve relative paths against `/`: `resolvePath('a')` is `'/a'` where Node would give `${process.cwd()}/a`.
 *   For absolute paths, nothing differs.
 * - **Strings only, checked.** A non-string argument throws a `TypeError`, even one Node would skip (`path.posix.resolve(1, '/a')`
 *   ignores the `1`); {@link formatPath} only takes strings (or `undefined`) as parts and ignores those inherited from `Object.prototype`.
 * - **Lexical and linear.** Paths are handled as text: nothing reads the file system or follows symbolic links, `\` is an ordinary
 *   character (see {@link toPosixPath}), and `%2F` is not decoded. Every function runs in time linear in its input; Node's normalization
 *   rebuilds its result at each `..` and is quadratic on adversarial input (`'//' + 'abcdefgh/'.repeat(80_000) + 'x/../'.repeat(80_000)`
 *   takes seconds in Node, milliseconds here). Code units are compared one by one: `/` and `.` never occur inside a surrogate pair, so
 *   any Unicode text is safe.
 * @packageDocumentation
 */
import { describe } from '../utils/assert.js';

/**
 * The parts of a path, as returned by {@link parsePath} (Node's `path.parse` object). For `'/home/user/file.txt'`: `root` is `'/'`,
 * `dir` is `'/home/user'`, `base` is `'file.txt'`, `ext` is `'.txt'` and `name` is `'file'`.
 */
export interface ParsedPath {
	/** `'/'` for an absolute path, `''` otherwise. */
	readonly root: string;
	/** The directory: everything before the last segment, without the separator (the root for a top-level entry). */
	readonly dir: string;
	/** The last segment, trailing slashes removed. */
	readonly base: string;
	/** The extension of `base`, with its dot (`''` when it has none). */
	readonly ext: string;
	/** `base` without `ext`. */
	readonly name: string;
}

/**
 * The parts accepted by {@link formatPath}: any subset of {@link ParsedPath}. `dir` takes precedence over `root`, and `base` over
 * `name` + `ext`.
 */
export type PathObject = Partial<ParsedPath>;

/** `/` */
const SLASH = 47;

/** `.` */
const DOT = 46;

/**
 * Throws a `TypeError` unless `value` is a (primitive) string.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {string} name - Name of the validated parameter
 * @param {unknown} value - The value to validate
 * @param {number} [index=-1] - The position of `value` in a rest parameter (`segments[2]`), `-1` for a named parameter
 * @returns {void}
 * @throws {TypeError} when `value` is not a string
 */
function assertString(caller: string, name: string, value: unknown, index = -1): asserts value is string {
	if (typeof value !== 'string') throw new TypeError(`${caller}: \`${index < 0 ? name : `${name}[${index}]`}\` must be a string, got ${describe(value)}`);
}

/**
 * Puts a run of segments before the segments collected so far.
 * @param {string} result - The segments collected so far
 * @param {string} run - The run
 * @returns {string} Both, joined by `/`
 */
function prependRun(result: string, run: string): string {
	return result.length > 0 ? `${run}/${result}` : run;
}

/**
 * Resolves the `.` and `..` segments of `path` and drops its empty ones, returning the remaining segments joined by single slashes,
 * without a leading or trailing `/`. A `..` that would climb above the start is kept when `allowAboveRoot` is set (relative paths) and
 * dropped otherwise (absolute paths).
 *
 * The segments are read from the end: each `..` cancels the closest kept segment before it, which pairs them exactly like Node's
 * forward stack, in linear time and without rebuilding the result at every `..` (Node's is quadratic on adversarial input). Runs of
 * adjacent kept segments are copied in one slice, so a path that needs no change costs a single scan and a single slice.
 * @param {string} path - The path
 * @param {boolean} allowAboveRoot - Whether unmatched `..` segments are kept
 * @returns {string} The normalized segments (`''` when none remain)
 */
function normalizeString(path: string, allowAboveRoot: boolean): string {
	let result = '';
	// `..` segments seen and not yet matched with a segment before them.
	let pending = 0;
	let end = path.length;
	// The run of adjacent kept segments being collected is `path.slice(runStart, runEnd)`; `runEnd` is -1 when there is none.
	let runStart = 0;
	let runEnd = -1;

	for (let index = end - 1; index >= -1; index--) {
		if (index >= 0 && path.charCodeAt(index) !== SLASH) continue;

		// The segment is `path.slice(start, end)`.
		const start = index + 1;
		const size = end - start;
		// An empty segment is followed by a `/` (or by nothing), never by a dot.
		const dot = path.charCodeAt(start) === DOT;
		let kept = false;

		// `..` waits for a segment to cancel, empty and `.` segments are dropped, others are cancelled by a pending `..` or kept.
		if (dot && size === 2 && path.charCodeAt(start + 1) === DOT) pending++;
		else if (size > (dot ? 1 : 0)) {
			if (pending > 0) pending--;
			else kept = true;
		}

		if (kept) {
			if (runEnd === -1) runEnd = end;
			runStart = start;
		} else if (runEnd !== -1) {
			result = prependRun(result, path.slice(runStart, runEnd));
			runEnd = -1;
		}

		end = index;
	}

	if (runEnd !== -1) result = prependRun(result, path.slice(runStart, runEnd));

	if (pending > 0 && allowAboveRoot) {
		result = prependRun(result, `..${'/..'.repeat(pending - 1)}`);
	}

	return result;
}

/**
 * {@link normalizePath} without the argument check.
 * @param {string} path - The path
 * @returns {string} The normalized path
 */
function normalize(path: string): string {
	const absolute = path.charCodeAt(0) === SLASH;
	const trailing = path.charCodeAt(path.length - 1) === SLASH;
	const body = normalizeString(path, !absolute);

	// Also the case of `''`.
	if (body.length === 0) return absolute ? '/' : trailing ? './' : '.';

	// Normalizing only removes characters: a body as long as the input between its outer slashes is the input itself.
	if (body.length + (absolute ? 1 : 0) + (trailing ? 1 : 0) === path.length) return path;

	return `${absolute ? '/' : ''}${body}${trailing ? '/' : ''}`;
}

/**
 * Normalizes an absolute path the way `path.posix.resolve` finishes: `.`, `..` and empty segments resolved, no trailing slash.
 * @param {string} path - A path starting with `/`
 * @returns {string} The resolved path
 */
function resolveAbsolute(path: string): string {
	const body = normalizeString(path, false);

	return body.length + 1 === path.length ? path : `/${body}`;
}

/**
 * Resolves a single path against the virtual root `/`.
 * @param {string} path - The path
 * @returns {string} The absolute, normalized path
 */
function resolveFromRoot(path: string): string {
	// Prefixing an absolute path would give the same result, slower: a concatenated string is flattened by the scan.
	return resolveAbsolute(path.charCodeAt(0) === SLASH ? path : `/${path}`);
}

/**
 * Returns the last segment of a path, ignoring trailing slashes, like `path.posix.basename`. When `suffix` is given and the segment
 * ends with it without being equal to it, the suffix is removed. Node's quirks are kept: a `path` equal to `suffix` gives `''`, and a
 * `suffix` that ends with the whole segment, is longer than it and is no longer than `path` keeps the trailing slashes (see below).
 * @param {string} path - The path
 * @param {string} [suffix] - A suffix to remove, such as an extension (`'.html'`); compared exactly, case included
 * @returns {string} The last segment (`''` for `''`, and for a path made of slashes unless the suffix quirk applies)
 * @throws {TypeError} when `path` is not a string, or `suffix` is neither a string nor `undefined`
 * @example
 * basename('/home/user/file.txt'); // => 'file.txt'
 * basename('/home/user/file.txt', '.txt'); // => 'file'
 * basename('/home/user/docs/'); // => 'docs'
 * basename('/dir/file.txt', 'file.txt'); // => 'file.txt' // a suffix equal to the whole segment is kept
 * basename('/'); // => ''
 * basename('/dir/', 'xdir'); // => 'dir/' // Node's quirk: a longer suffix ending with the whole segment keeps the trailing slash
 * basename('/', 'x'); // => '/' // the same quirk, with an empty segment
 */
export function basename(path: string, suffix?: string): string {
	assertString('basename', 'path', path);
	if (suffix !== undefined) assertString('basename', 'suffix', suffix);

	let start = 0;
	let end = -1;
	let matchedSlash = true;

	if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
		if (suffix === path) return '';

		let suffixIndex = suffix.length - 1;
		let firstNonSlashEnd = -1;

		for (let index = path.length - 1; index >= 0; index--) {
			const code = path.charCodeAt(index);

			if (code === SLASH) {
				// A separator before the segment (not among the trailing ones) ends it.
				if (!matchedSlash) {
					start = index + 1;
					break;
				}
			} else {
				if (firstNonSlashEnd === -1) {
					matchedSlash = false;
					firstNonSlashEnd = index + 1;
				}

				if (suffixIndex >= 0) {
					if (code === suffix.charCodeAt(suffixIndex)) {
						// The whole suffix matched: the segment ends before it.
						if (--suffixIndex === -1) end = index;
					} else {
						// The suffix does not match: the segment is kept whole.
						suffixIndex = -1;
						end = firstNonSlashEnd;
					}
				}
			}
		}

		if (start === end) end = firstNonSlashEnd;
		else if (end === -1) end = path.length;

		return path.slice(start, end);
	}

	for (let index = path.length - 1; index >= 0; index--) {
		if (path.charCodeAt(index) === SLASH) {
			if (!matchedSlash) {
				start = index + 1;
				break;
			}
		} else if (matchedSlash) {
			matchedSlash = false;
			end = index + 1;
		}
	}

	return end === -1 ? '' : path.slice(start, end);
}

/**
 * Returns the directory part of a path, like `path.posix.dirname`: everything before the last segment, trailing slashes ignored.
 * @param {string} path - The path
 * @returns {string} The directory (`'.'` for a bare name, `'/'` for a top-level entry)
 * @throws {TypeError} when `path` is not a string
 * @example
 * dirname('/home/user/file.txt'); // => '/home/user'
 * dirname('/home/user/docs/'); // => '/home/user'
 * dirname('file.txt'); // => '.'
 * dirname('/file.txt'); // => '/'
 * dirname('//a'); // => '//' // POSIX keeps a leading `//`, which some systems treat specially
 */
export function dirname(path: string): string {
	assertString('dirname', 'path', path);

	const hasRoot = path.charCodeAt(0) === SLASH;
	let end = -1;
	let matchedSlash = true;

	for (let index = path.length - 1; index >= 1; index--) {
		if (path.charCodeAt(index) === SLASH) {
			if (!matchedSlash) {
				end = index;
				break;
			}
		} else {
			matchedSlash = false;
		}
	}

	if (end === -1) return hasRoot ? '/' : '.';
	if (hasRoot && end === 1) return '//';

	return path.slice(0, end);
}

/**
 * Returns the extension of the last segment of a path, from its last `.`, like `path.posix.extname`. A segment that starts with its
 * only dot (`.bashrc`), and the segments `.` and `..`, have no extension.
 * @param {string} path - The path
 * @returns {string} The extension with its dot (`'.txt'`, `'.'` for `'file.'`), or `''`
 * @throws {TypeError} when `path` is not a string
 * @example
 * extname('/home/user/archive.tar.gz'); // => '.gz'
 * extname('index.'); // => '.'
 * extname('.bashrc'); // => ''
 * extname('README'); // => ''
 * extname('/home/user.d/'); // => '.d'
 */
export function extname(path: string): string {
	assertString('extname', 'path', path);

	// The last segment is `path.slice(startPart, end)`, trailing slashes excluded (`end` is -1 until a non-slash is found).
	let startPart = 0;
	let end = -1;
	let startDot = -1;

	for (let index = path.length - 1; index >= 0; index--) {
		const code = path.charCodeAt(index);

		if (code === SLASH) {
			if (end !== -1) {
				startPart = index + 1;
				break;
			}
		} else {
			if (end === -1) end = index + 1;
			if (code === DOT && startDot === -1) startDot = index;
		}
	}

	// No dot, a dot that starts the segment, or the segment `..`.
	if (startDot <= startPart || (startDot === end - 1 && startDot === startPart + 1 && path.charCodeAt(startPart) === DOT)) return '';

	return path.slice(startDot, end);
}

/**
 * Tells whether a path is absolute, i.e. starts with `/`, like `path.posix.isAbsolute`.
 * @param {string} path - The path
 * @returns {boolean} `true` when `path` starts with `/`
 * @throws {TypeError} when `path` is not a string
 * @example
 * isAbsolutePath('/home/user'); // => true
 * isAbsolutePath('home/user'); // => false
 * isAbsolutePath('C:\\Users'); // => false // a POSIX check: use `toPosixPath` first and test the drive yourself
 */
export function isAbsolutePath(path: string): boolean {
	assertString('isAbsolutePath', 'path', path);

	return path.charCodeAt(0) === SLASH;
}

/**
 * Normalizes a path like `path.posix.normalize`: runs of slashes become one, `.` segments are removed and `..` segments remove the
 * segment before them. A `..` above the root of an absolute path is dropped; leading `..` segments of a relative path are kept. A
 * trailing slash is kept. Already normal paths are returned as is, without copying.
 * @param {string} path - The path
 * @returns {string} The normalized path (`'.'` for `''`)
 * @throws {TypeError} when `path` is not a string
 * @example
 * normalizePath('/foo/bar//baz/asdf/quux/..'); // => '/foo/bar/baz/asdf'
 * normalizePath('./a/../../b/'); // => '../b/'
 * normalizePath('/../a'); // => '/a'
 * normalizePath(''); // => '.'
 */
export function normalizePath(path: string): string {
	assertString('normalizePath', 'path', path);

	return normalize(path);
}

/**
 * Joins path segments with `/` and normalizes the result, like `path.posix.join`. Empty segments are skipped; an absolute segment
 * does not reset the path (that is {@link resolvePath}).
 * @param {...string} segments - The segments
 * @returns {string} The joined, normalized path (`'.'` when nothing remains)
 * @throws {TypeError} when a segment is not a string
 * @example
 * joinPath('/foo', 'bar', 'baz/asdf', 'quux', '..'); // => '/foo/bar/baz/asdf'
 * joinPath('a', '/b', '', 'c/'); // => 'a/b/c/'
 * joinPath('..', 'a', '../..'); // => '../..'
 * joinPath(); // => '.'
 */
export function joinPath(...segments: string[]): string {
	let joined = '';

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];

		assertString('joinPath', 'segments', segment, index);
		if (segment.length > 0) joined = joined.length > 0 ? `${joined}/${segment}` : segment;
	}

	return normalize(joined);
}

/**
 * Resolves a sequence of paths into an absolute path, like `path.posix.resolve`: segments are applied from right to left until an
 * absolute one is found, and the result is normalized, without a trailing slash. When no segment is absolute, the path is resolved
 * against the virtual root `/` (Node uses `process.cwd()`, which other runtimes do not have).
 * @param {...string} segments - The paths
 * @returns {string} The absolute path (`'/'` when there are no segments)
 * @throws {TypeError} when a segment is not a string (all of them are checked, including those before an absolute one)
 * @example
 * resolvePath('/foo/bar', './baz'); // => '/foo/bar/baz'
 * resolvePath('/foo/bar', '/tmp/file/'); // => '/tmp/file'
 * resolvePath('www', 'static/', '../img/logo.png'); // => '/www/img/logo.png'
 * resolvePath('..'); // => '/'
 */
export function resolvePath(...segments: string[]): string {
	let resolved = '';
	let absolute = false;

	for (let index = segments.length - 1; index >= 0; index--) {
		const segment = segments[index];

		assertString('resolvePath', 'segments', segment, index);
		if (absolute || segment.length === 0) continue;

		resolved = resolved.length > 0 ? `${segment}/${resolved}` : segment;
		absolute = segment.charCodeAt(0) === SLASH;
	}

	return resolveAbsolute(absolute ? resolved : `/${resolved}`);
}

/**
 * Returns the relative path from `from` to `to`, like `path.posix.relative`: both are resolved with {@link resolvePath} (relative
 * paths against the virtual root `/`, where Node uses `process.cwd()`), then the path climbs out of `from` with `..` and descends into
 * `to`. For absolute paths, the result is Node's.
 * @param {string} from - The starting path
 * @param {string} to - The destination path
 * @returns {string} The relative path, without a trailing slash (`''` when both resolve to the same path)
 * @throws {TypeError} when `from` or `to` is not a string
 * @example
 * relativePath('/data/orandea/test/aaa', '/data/orandea/impl/bbb'); // => '../../impl/bbb'
 * relativePath('/a/b', '/a/b/c/d'); // => 'c/d'
 * relativePath('/a/b/', '/a'); // => '..'
 * relativePath('src', 'src/index.ts'); // => 'index.ts'
 */
export function relativePath(from: string, to: string): string {
	assertString('relativePath', 'from', from);
	assertString('relativePath', 'to', to);

	const source = resolveFromRoot(from);
	const target = resolveFromRoot(to);

	if (source === target) return '';

	// Both start with `/`: compare after it.
	const sourceLength = source.length - 1;
	const targetLength = target.length - 1;
	const length = Math.min(sourceLength, targetLength);
	// Index (after the leading `/`) of the last separator the two paths share.
	let lastCommonSeparator = -1;
	let index = 0;

	// Stops at the first difference, at the latest past the end of the shorter path (`charCodeAt` is `NaN` there).
	for (; ; index++) {
		const code = source.charCodeAt(index + 1);

		if (code !== target.charCodeAt(index + 1)) break;
		if (code === SLASH) lastCommonSeparator = index;
	}

	if (index === length) {
		if (targetLength > length) {
			// `source` is a directory containing `target` (`/a` and `/a/b`), or the root.
			if (target.charCodeAt(index + 1) === SLASH) return target.slice(index + 2);
			if (index === 0) return target.slice(1);
		} else {
			// `target` is a directory containing `source`, or the root (the paths differ, so one is longer).
			if (source.charCodeAt(index + 1) === SLASH) lastCommonSeparator = index;
			else if (index === 0) lastCommonSeparator = 0;
		}
	}

	// One `..` per segment of `source` after the common part.
	let up = '';

	for (index = lastCommonSeparator + 2; index <= source.length; index++) {
		if (index === source.length || source.charCodeAt(index) === SLASH) up = up.length > 0 ? `${up}/..` : '..';
	}

	return `${up}${target.slice(lastCommonSeparator + 1)}`;
}

/**
 * Splits a path into its root, directory, base name, extension and name, like `path.posix.parse` (quirks included: Node reads the
 * extension of `'/..'` as `'.'`, unlike `extname`). {@link formatPath} puts the parts back together.
 * @param {string} path - The path
 * @returns {ParsedPath} The parts, as a plain object with the keys in Node's order (`root`, `dir`, `base`, `ext`, `name`)
 * @throws {TypeError} when `path` is not a string
 * @example
 * parsePath('/home/user/file.txt'); // => { root: '/', dir: '/home/user', base: 'file.txt', ext: '.txt', name: 'file' }
 * parsePath('archive.tar.gz'); // => { root: '', dir: '', base: 'archive.tar.gz', ext: '.gz', name: 'archive.tar' }
 * parsePath('/'); // => { root: '/', dir: '/', base: '', ext: '', name: '' }
 */
export function parsePath(path: string): ParsedPath {
	assertString('parsePath', 'path', path);

	const absolute = path.charCodeAt(0) === SLASH;
	const root = absolute ? '/' : '';
	const first = absolute ? 1 : 0;
	// The last segment ends at `end` (-1 until a non-slash is found), after the slash at `startPart - 1` (`startPart` is 0 without one).
	let startPart = 0;
	let end = -1;
	let startDot = -1;
	let base = '';
	let ext = '';
	let name = '';

	for (let index = path.length - 1; index >= first; index--) {
		const code = path.charCodeAt(index);

		if (code === SLASH) {
			if (end !== -1) {
				startPart = index + 1;
				break;
			}
		} else {
			if (end === -1) end = index + 1;
			if (code === DOT && startDot === -1) startDot = index;
		}
	}

	if (end !== -1) {
		const start = startPart === 0 ? first : startPart;

		base = path.slice(start, end);
		// As in `extname`, except that Node's `..` test reads `startPart`: the top-level `..` of an absolute path splits into `.` + `.`.
		if (startDot <= start || (startDot === end - 1 && startDot === startPart + 1 && path.charCodeAt(startPart) === DOT)) {
			name = base;
		} else {
			name = path.slice(start, startDot);
			ext = path.slice(startDot, end);
		}
	}

	const dir = startPart > 0 ? path.slice(0, startPart - 1) : root;

	return { root, dir, base, ext, name };
}

/** `Object.prototype`, whose values are ignored when {@link formatPath} reads an inherited part. */
const OBJECT_PROTOTYPE: PathObject = Object.prototype;

/** `Object.prototype.hasOwnProperty`. */
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Checks a part read from the object given to {@link formatPath} (the reads are written out by the caller, so that each one is a fast
 * named property access). Like `readOption`, a value inherited from a polluted `Object.prototype` is ignored.
 * @param {PathObject} pathObject - The parts
 * @param {keyof ParsedPath} key - The part
 * @param {unknown} value - `pathObject[key]`
 * @param {unknown} inherited - `Object.prototype[key]`
 * @returns {string} The part, or `''` when it is missing
 * @throws {TypeError} when the value is neither a string nor `undefined`
 */
function readPart(pathObject: PathObject, key: keyof ParsedPath, value: unknown, inherited: unknown): string {
	if (value === undefined || (value === inherited && !hasOwn.call(pathObject, key))) return '';
	if (typeof value !== 'string') throw new TypeError(`formatPath: \`pathObject.${key}\` must be a string, got ${describe(value)}`);

	return value;
}

/**
 * Builds a path from its parts, like `path.posix.format`: the inverse of {@link parsePath}. `dir` (or else `root`) is joined to `base`
 * (or else `name` + `ext`, a dot being added before an `ext` without one) with a `/`, unless `dir` is the root itself. Empty parts
 * count as missing. Only own (and class-defined) properties are read, each once, so a polluted `Object.prototype` cannot inject parts.
 * @param {PathObject} pathObject - The parts
 * @returns {string} The path
 * @throws {TypeError} when `pathObject` is not an object (arrays included), or one of its parts is neither a string nor `undefined`
 * @example
 * formatPath({ dir: '/home/user', base: 'file.txt' }); // => '/home/user/file.txt'
 * formatPath({ root: '/', name: 'file', ext: 'txt' }); // => '/file.txt'
 * formatPath({ root: '/ignored', dir: '/home', base: 'a', name: 'ignored' }); // => '/home/a'
 * formatPath(parsePath('/srv/app/index.html')); // => '/srv/app/index.html'
 */
export function formatPath(pathObject: PathObject): string {
	if (typeof pathObject !== 'object' || pathObject === null || Array.isArray(pathObject)) {
		throw new TypeError(`formatPath: \`pathObject\` must be an object, got ${Array.isArray(pathObject) ? 'array' : describe(pathObject)}`);
	}

	const root = readPart(pathObject, 'root', pathObject.root, OBJECT_PROTOTYPE.root);
	const dir = readPart(pathObject, 'dir', pathObject.dir, OBJECT_PROTOTYPE.dir) || root;
	const name = readPart(pathObject, 'name', pathObject.name, OBJECT_PROTOTYPE.name);
	const ext = readPart(pathObject, 'ext', pathObject.ext, OBJECT_PROTOTYPE.ext);
	const base = readPart(pathObject, 'base', pathObject.base, OBJECT_PROTOTYPE.base) || (ext.length > 0 && ext.charCodeAt(0) !== DOT ? `${name}.${ext}` : `${name}${ext}`);

	// An empty `dir` is the (empty) root.
	return dir === root ? `${dir}${base}` : `${dir}/${base}`;
}

/**
 * Converts Windows separators to POSIX ones: every `\` becomes `/`. Nothing else changes (drive letters and UNC prefixes stay:
 * `'C:\\Users'` becomes `'C:/Users'`), so the result can be handed to the other functions of this module. On POSIX systems `\` is a
 * legal file-name character: only convert paths known to come from Windows.
 * @param {string} path - The path
 * @returns {string} The path with forward slashes (the same string when it has no backslash)
 * @throws {TypeError} when `path` is not a string
 * @example
 * toPosixPath('src\\utils\\index.ts'); // => 'src/utils/index.ts'
 * toPosixPath('C:\\Users\\me'); // => 'C:/Users/me'
 * normalizePath(toPosixPath('a\\b\\..\\c')); // => 'a/c'
 */
export function toPosixPath(path: string): string {
	assertString('toPosixPath', 'path', path);

	// `split`/`join` beats `replaceAll` and a regular expression here (V8 has a fast path for single-character separators).
	return path.includes('\\') ? path.split('\\').join('/') : path;
}
