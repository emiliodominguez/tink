import { basename, dirname, extname, formatPath, isAbsolutePath, joinPath, normalizePath, parsePath, relativePath, resolvePath, toPosixPath } from 'tinkit/path';
import type { ParsedPath, PathObject } from 'tinkit/path';

const base: string = basename('/a/b.txt') + basename('/a/b.txt', '.txt');
// @ts-expect-error the suffix is a string
basename('/a/b.txt', 1);
const dir: string = dirname('/a/b');
const ext: string = extname('b.txt');
const absolute: boolean = isAbsolutePath('/a');
// @ts-expect-error paths are strings
isAbsolutePath(['/a']);
const joined: string = joinPath() + joinPath('a') + joinPath('a', 'b', 'c');
// @ts-expect-error segments are strings
joinPath('a', 1);
const segments: string[] = ['a', 'b'];
const resolved: string = resolvePath(...segments) + resolvePath();
const normal: string = normalizePath('a/../b');
const relative: string = relativePath('/a', '/b');
// @ts-expect-error both paths are required
relativePath('/a');
const posixPath: string = toPosixPath('a\\b');

const parsed: ParsedPath = parsePath('/a/b.txt');
const root: string = parsed.root;
// @ts-expect-error the parsed parts are read-only
parsed.base = 'c.txt';
const formatted: string = formatPath(parsed) + formatPath({}) + formatPath({ dir: '/a', base: 'b' });
const partial: PathObject = { name: 'b', ext: '.txt' };
// @ts-expect-error parts are strings
formatPath({ dir: 1 });
// @ts-expect-error not a part of a path
formatPath({ directory: '/a' });
void [base, dir, ext, absolute, joined, resolved, normal, relative, posixPath, root, formatted, partial];
