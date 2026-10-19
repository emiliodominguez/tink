// Generates docs/SIZES.md (the minified + gzipped cost of importing each helper on its own) and docs/MIGRATING-FROM-LODASH.md
// (a lodash → tink mapping, with both sides measured the same way). Run after `yarn build`: yarn docs:sizes
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lodashDir = dirname(require.resolve('lodash-es/package.json'));

// lodash name → [module, tink export, behavioural difference worth knowing (empty when it is a drop-in)].
const LODASH = [
	['chunk', 'arrays', 'chunk', ''],
	['compact', 'arrays', 'compact', ''],
	['countBy', 'arrays', 'countBy', 'Takes a key function only (no property shorthand); returns a null-prototype object.'],
	['difference', 'arrays', 'difference', 'Two arrays (`a`, `b`) instead of a variadic list.'],
	['differenceBy', 'arrays', 'differenceBy', ''],
	['drop', 'arrays', 'drop', ''],
	['flatten', 'arrays', 'flatten', ''],
	['flattenDeep', 'arrays', 'flattenDeep', 'Iterative and cycle-safe.'],
	['groupBy', 'arrays', 'groupBy', 'Takes a key function only; returns a null-prototype object (`__proto__` is a normal key).'],
	['head', 'arrays', 'first', ''],
	['includes', 'arrays', 'contains', 'Arrays only (strings: `String#includes`).'],
	['intersection', 'arrays', 'intersection', 'Two arrays instead of a variadic list.'],
	['intersectionBy', 'arrays', 'intersectionBy', ''],
	['keyBy', 'arrays', 'keyBy', 'Takes a key function only; returns a null-prototype object.'],
	['last', 'arrays', 'last', ''],
	['maxBy', 'arrays', 'maxBy', ''],
	['minBy', 'arrays', 'minBy', ''],
	['partition', 'arrays', 'partition', 'Narrows both halves when the predicate is a type guard.'],
	['range', 'arrays', 'range', ''],
	['sample', 'arrays', 'sample', 'Accepts an injectable random source (pass `secureRandom` when it matters).'],
	['shuffle', 'arrays', 'shuffle', 'Accepts an injectable random source.'],
	['sortBy', 'arrays', 'sortBy', 'One key function plus an `asc`/`desc` order; stable.'],
	['sortedIndex', 'arrays', 'sortedIndex', ''],
	['sumBy', 'arrays', 'sumBy', 'Compensated (Kahan–Neumaier) summation.'],
	['take', 'arrays', 'take', ''],
	['union', 'arrays', 'union', 'Two arrays instead of a variadic list.'],
	['uniq', 'arrays', 'unique', ''],
	['uniqBy', 'arrays', 'uniqueBy', ''],
	['unzip', 'arrays', 'unzip', ''],
	['xor', 'arrays', 'symmetricDifference', 'Two arrays instead of a variadic list.'],
	['zip', 'arrays', 'zip', ''],
	['clone', 'objects', 'clone', ''],
	['cloneDeep', 'objects', 'deepClone', 'Also clones Maps, Sets, typed arrays and class instances (prototype kept); cycle-safe.'],
	['get', 'objects', 'getPath', 'Dot paths only (`a.0.b`), typed path autocompletion; never resolves `__proto__`, `constructor` or `Object.prototype` members.'],
	['has', 'objects', 'hasPath', 'Agrees with `getPath`: never resolves `__proto__`, `constructor` or `Object.prototype` members.'],
	['invert', 'objects', 'invert', 'Throws for values that are not strings, numbers or symbols.'],
	['isEmpty', 'objects', 'isEmpty', ''],
	['isEqual', 'objects', 'isEqual', ''],
	['mapKeys', 'objects', 'mapKeys', ''],
	['mapValues', 'objects', 'mapValues', ''],
	['merge', 'objects', 'deepMerge', 'Returns a NEW object; inputs are never mutated.'],
	['omit', 'objects', 'omit', ''],
	['omitBy', 'objects', 'omitBy', ''],
	['pick', 'objects', 'pick', ''],
	['pickBy', 'objects', 'pickBy', ''],
	['set', 'objects', 'setPath', 'Mutates and returns `target`, like lodash; rejects `__proto__`/`constructor`/`prototype` segments.'],
	['unset', 'objects', 'deletePath', ''],
	['after', 'functions', 'after', ''],
	['before', 'functions', 'before', ''],
	['constant', 'functions', 'constant', ''],
	['curry', 'functions', 'curry', 'Fully typed; arity defaults to `fn.length`; no placeholders.'],
	['debounce', 'functions', 'debounce', 'Same `leading`/`trailing`/`maxWait` options and `cancel`/`flush`, plus `pending()`.'],
	['flip', 'functions', 'flip', ''],
	['flow', 'functions', 'pipe', 'Typed overloads infer every intermediate type.'],
	['flowRight', 'functions', 'compose', ''],
	['identity', 'functions', 'identity', ''],
	['memoize', 'functions', 'memoize', 'Keys on ALL arguments by default; pluggable cache (e.g. an LRU from the `cache` module).'],
	['negate', 'functions', 'negate', ''],
	['noop', 'functions', 'noop', ''],
	['once', 'functions', 'once', ''],
	['partial', 'functions', 'partial', 'No placeholders.'],
	['throttle', 'functions', 'throttle', ''],
	['times', 'functions', 'times', ''],
	['unary', 'functions', 'unary', ''],
	['attempt', 'functions', 'attempt', 'Returns a `[error, value]` tuple instead of the error or the value.'],
	['camelCase', 'strings', 'toCamelCase', ''],
	['capitalize', 'strings', 'capitalize', 'Does NOT lower-case the rest (lodash `upperFirst` semantics).'],
	['deburr', 'strings', 'removeDiacritics', ''],
	['escape', 'strings', 'escapeHtml', ''],
	['escapeRegExp', 'strings', 'escapeRegExp', 'Follows TC39 `RegExp.escape`: also safe inside character classes and with the `v` flag.'],
	['kebabCase', 'strings', 'toKebabCase', ''],
	['lowerFirst', 'strings', 'uncapitalize', ''],
	['repeat', 'strings', 'repeat', ''],
	['snakeCase', 'strings', 'toSnakeCase', ''],
	['startCase', 'strings', 'toStartCase', ''],
	['template', 'strings', 'interpolate', '`{name}` placeholders only: never evaluates code, so templates may come from users.'],
	['trim', 'strings', 'trim', ''],
	['truncate', 'strings', 'truncate', 'Counts graphemes, so emoji are never cut in half; takes the lodash `separator` option (string or RegExp).'],
	['unescape', 'strings', 'unescapeHtml', ''],
	['upperFirst', 'strings', 'capitalize', ''],
	['words', 'strings', 'getWords', ''],
	['clamp', 'math', 'clamp', ''],
	['inRange', 'math', 'inRange', ''],
	['max', 'math', 'max', ''],
	['mean', 'math', 'average', ''],
	['min', 'math', 'min', ''],
	['random', 'math', 'randomBetween', 'Use `randomIntBetween` for integers.'],
	['round', 'math', 'round', 'Decimal-correct: `round(1.005, 2)` is `1.01`.'],
	['sum', 'math', 'sum', 'Compensated summation: `sum([0.1, 0.2, 0.3])` is `0.6`.'],
	['castArray', 'arrays', 'toArray', '`null`/`undefined` become `[]`; arrays are copied.'],
	['differenceWith', 'arrays', 'differenceWith', 'Two arrays; the result is deduplicated.'],
	['dropRight', 'arrays', 'dropLast', ''],
	['dropRightWhile', 'arrays', 'dropLastWhile', ''],
	['intersectionWith', 'arrays', 'intersectionWith', 'Two arrays; the result is deduplicated.'],
	['meanBy', 'arrays', 'averageBy', 'Compensated summation.'],
	['orderBy', 'arrays', 'orderBy', 'Key functions only; `NaN`, `null` and `undefined` keys always sort last (lodash mis-sorts `NaN`).'],
	['sampleSize', 'arrays', 'sampleSize', 'Uniformly random order; injectable random source.'],
	['sortedIndexBy', 'arrays', 'sortedIndexBy', ''],
	['sortedLastIndex', 'arrays', 'sortedLastIndex', ''],
	['sortedLastIndexBy', 'arrays', 'sortedLastIndexBy', ''],
	['takeRight', 'arrays', 'takeLast', 'Throws for a negative or fractional count.'],
	['takeRightWhile', 'arrays', 'takeLastWhile', ''],
	['unionBy', 'arrays', 'unionBy', 'Two arrays.'],
	['unionWith', 'arrays', 'unionWith', 'Two arrays.'],
	['uniqWith', 'arrays', 'uniqueWith', ''],
	['xorBy', 'arrays', 'symmetricDifferenceBy', 'Two arrays.'],
	['zipObject', 'arrays', 'zipObject', 'Throws when the lengths differ; `__proto__` keys stay own data.'],
	['zipWith', 'arrays', 'zipWith', 'Function first; truncates to the shortest array.'],
	['defaults', 'objects', 'defaults', 'Returns a NEW object; drops `__proto__`/`constructor`/`prototype`.'],
	['defaultsDeep', 'objects', 'defaultsDeep', 'Returns a NEW object.'],
	['findKey', 'objects', 'findKey', ''],
	['isEqualWith', 'objects', 'isEqualWith', 'Identical values skip the customizer.'],
	['isMatch', 'objects', 'isMatch', "Arrays match exactly unless `{ arrays: 'subset' }`."],
	['mergeWith', 'objects', 'deepMergeWith', 'Options first (`arrays` strategy, `customizer`); returns a NEW object.'],
	['toPath', 'objects', 'toPath', 'Throws on malformed paths.'],
	['update', 'objects', 'updatePath', 'Immutable: returns a new root with structural sharing (lodash mutates).'],
	['overEvery', 'functions', 'allPass', 'Preserves type-guard narrowing.'],
	['overSome', 'functions', 'anyPass', 'Preserves type-guard narrowing.'],
	['partialRight', 'functions', 'partialRight', 'No placeholders.'],
	['lowerCase', 'strings', 'toNoCase', ''],
	['pad', 'strings', 'padCenter', 'Counts graphemes, so emoji pad correctly.'],
	['padEnd', 'strings', 'padEnd', 'Counts graphemes.'],
	['padStart', 'strings', 'padStart', 'Counts graphemes.'],
	['trimEnd', 'strings', 'trimEndChars', 'Character set required (whitespace: `String#trimEnd`).'],
	['trimStart', 'strings', 'trimStartChars', 'Character set required (whitespace: `String#trimStart`).'],
	['ceil', 'math', 'ceil', 'Decimal-correct with a precision.'],
	['floor', 'math', 'floor', 'Decimal-correct with a precision.'],
	['delay', 'async', 'sleep', 'Promise-based and abortable.'],
	['isArray', 'guards', 'isArray', ''],
	['isArrayLike', 'guards', 'isArrayLike', 'Functions are excluded, like lodash; the length must be a safe non-negative integer.'],
	['isArrayBuffer', 'guards', 'isArrayBuffer', ''],
	['isBoolean', 'guards', 'isBoolean', 'Primitives only.'],
	['isDate', 'guards', 'isDate', ''],
	['isError', 'guards', 'isError', ''],
	['isFinite', 'guards', 'isFiniteNumber', ''],
	['isFunction', 'guards', 'isFunction', ''],
	['isInteger', 'guards', 'isInteger', ''],
	['isMap', 'guards', 'isMap', ''],
	['isNil', 'guards', 'isNil', ''],
	['isNull', 'guards', 'isNull', ''],
	['isNumber', 'guards', 'isNumber', 'Primitives only.'],
	['isObjectLike', 'guards', 'isObject', ''],
	['isPlainObject', 'guards', 'isPlainObject', ''],
	['isRegExp', 'guards', 'isRegExp', ''],
	['isSet', 'guards', 'isSet', ''],
	['isString', 'guards', 'isString', 'Primitives only.'],
	['isSymbol', 'guards', 'isSymbol', ''],
	['isTypedArray', 'guards', 'isTypedArray', ''],
	['isUndefined', 'guards', 'isUndefined', ''],
	['isWeakMap', 'guards', 'isWeakMap', ''],
	['isWeakSet', 'guards', 'isWeakSet', '']
];

/**
 * Bundles, minifies and gzips one entry, returning its gzipped byte count.
 * @param {string} contents - The entry module source
 * @param {string} resolveDir - Directory imports resolve from
 * @returns {Promise<number>} The gzipped size in bytes
 */
async function measure(contents, resolveDir) {
	const result = await build({
		stdin: { contents, resolveDir, loader: 'js' },
		bundle: true,
		minify: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		write: false,
		legalComments: 'none',
		logLevel: 'silent'
	});
	return gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
}

/**
 * Formats a byte count for the tables.
 * @param {number} bytes - The byte count
 * @returns {string} e.g. `612 B` or `1.4 kB`
 */
function size(bytes) {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

/**
 * Measures one tink export imported on its own.
 * @param {string} module - The module name
 * @param {string} name - The export name
 * @returns {Promise<number>} The gzipped size in bytes
 */
function measureOwn(module, name) {
	return measure(`export { ${name} } from './dist/${module}/index.js';`, root);
}

const modules = {};
for (const [, module, name] of LODASH) {
	modules[module] ??= await import(resolve(root, 'dist', module, 'index.js'));
	if (!(name in modules[module])) throw new Error(`MIGRATING table: ${module}.${name} does not exist`);
}

// docs/SIZES.md: every runtime export of every module.
const MODULE_NAMES = Object.keys(await import(resolve(root, 'dist/index.js'))).sort();
const sections = [];
const sizes = [];
for (const module of MODULE_NAMES) {
	const exports = Object.keys(await import(resolve(root, 'dist', module, 'index.js'))).sort();
	const rows = [];
	for (const name of exports) {
		const bytes = await measureOwn(module, name);
		sizes.push(bytes);
		rows.push(`| \`${name}\` | ${size(bytes)} |`);
	}
	const whole = await measure(`export * from './dist/${module}/index.js';`, root);
	sections.push(`## ${module}\n\nWhole module: **${size(whole)}**\n\n| Export | min + gzip |\n| --- | ---: |\n${rows.join('\n')}`);
}
sizes.sort(function (a, b) {
	return a - b;
});
const median = sizes[Math.floor(sizes.length / 2)];
const under1k = sizes.filter(function (bytes) {
	return bytes < 1024;
}).length;

mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(
	resolve(root, 'docs/SIZES.md'),
	`# Import cost of every helper

What each export adds to a bundle when it is the only thing imported: bundled with its internal dependencies, minified and gzipped
(esbuild, gzip level 9). Several helpers together cost less than the sum, since they share internals.
Generated by \`yarn docs:sizes\`; do not edit by hand.

**${sizes.length} exports · median ${size(median)} · ${Math.round((under1k / sizes.length) * 100)}% under 1 kB · largest ${size(sizes[sizes.length - 1])}**

${sections.join('\n\n')}
`
);

// docs/MIGRATING-FROM-LODASH.md: both sides measured with the same bundler settings (lodash-es, the tree-shakeable build).
const rows = [];
let ours = 0;
let theirs = 0;
for (const [lodashName, module, name, note] of LODASH) {
	const lodashBytes = await measure(`export { default } from './${lodashName}.js';`, lodashDir);
	const ownBytes = await measureOwn(module, name);
	ours += ownBytes;
	theirs += lodashBytes;
	rows.push(`| \`_.${lodashName}\` | \`${module}.${name}\` | ${size(lodashBytes)} | ${size(ownBytes)} | ${note} |`);
}
writeFileSync(
	resolve(root, 'docs/MIGRATING-FROM-LODASH.md'),
	`# Migrating from lodash

Every helper is a named export of a module entry point, so the import changes from \`lodash/x\` to the module:

\`\`\`ts
// before
import debounce from 'lodash/debounce';
import get from 'lodash/get';
// after
import { debounce } from 'tinkit/functions';
import { getPath } from 'tinkit/objects';
\`\`\`

Sizes are what each import adds to a bundle on its own (esbuild, minified, gzip level 9, lodash measured from \`lodash-es\`).
Across the ${LODASH.length} helpers below: **lodash ${size(theirs)} vs tink ${size(ours)}** when imported one at a time.
"Notes" lists every behavioural difference worth checking; an empty cell means a drop-in replacement for the common call shapes.
lodash's iteratee shorthands (\`'name'\`, \`{ active: true }\`) are not supported: pass a function.
Generated by \`yarn docs:sizes\`; do not edit by hand. Speed comparisons live in the README's Performance section.

| lodash | tink | lodash size | tink size | Notes |
| --- | --- | ---: | ---: | --- |
${rows.join('\n')}
`
);
console.log(
	`docs/SIZES.md: ${sizes.length} exports (median ${size(median)}) · docs/MIGRATING-FROM-LODASH.md: ${LODASH.length} helpers, lodash ${size(theirs)} vs ${size(ours)}`
);
