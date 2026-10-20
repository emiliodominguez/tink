// Fails when a built module runs code at load time that bundlers must keep. esbuild's minifier strips `/* @__PURE__ */`
// annotations, so a top-level `const x = factory()` would ship `factory` (and everything it reaches) to every consumer of the module,
// even one importing an unrelated helper. Module-level state must be literals, functions, or calls bundlers know to be pure.
// Run after `yarn build`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Calls allowed at the top level. Bundlers drop unused `Symbol`, `Map`, `Set`, `WeakMap` and `WeakSet` calls; esbuild keeps the
// `Object.*` ones, which are deliberate (they capture built-ins before any user code can replace them) and cost a few bytes. `RegExp`
// is not allowed: esbuild keeps every `RegExp(...)` and `new RegExp(...)` (they can throw), so module-level patterns are literals.
const PURE_CALLEES = new Set(['Symbol', 'Symbol.for', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Object.getOwnPropertyDescriptor', 'Object.getPrototypeOf', 'Object.freeze']);

const violations = [];

/**
 * Collects the impure calls of a top-level initializer, ignoring code inside function bodies (it only runs when called).
 * @param {ts.Node} node - The node to inspect
 * @param {ts.SourceFile} source - Its source file
 * @param {string} file - The file name, for the report
 * @returns {void}
 */
function inspect(node, source, file) {
	if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
	// `{ [key]: value }`: bundlers cannot prove that converting `key` to a property key is side-effect free, so they keep the object
	// (and everything it references) even when nothing imports it.
	if (ts.isComputedPropertyName(node)) {
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		violations.push(`${file}:${line + 1}: top-level computed property key \`${node.getText(source).slice(0, 60)}\` cannot be tree-shaken`);
	}
	if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
		const callee = node.expression.getText(source).replace(/\?\./g, '.');
		if (!PURE_CALLEES.has(callee)) {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
			violations.push(`${file}:${line + 1}: top-level call to \`${callee.slice(0, 60)}\` cannot be tree-shaken`);
		}
	}
	ts.forEachChild(node, function (child) {
		inspect(child, source, file);
	});
}

for (const entry of readdirSync('dist', { recursive: true })) {
	const file = join('dist', String(entry));
	if (!file.endsWith('.js')) continue;
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isFunctionDeclaration(statement)) continue;
		inspect(statement, source, file);
	}
}

if (violations.length > 0) {
	console.error(violations.join('\n'));
	console.error('Module-level calls and computed keys run on import and defeat tree-shaking: use literals with plain keys, function declarations or lazy initialisation.');
	process.exit(1);
}
console.log('tree-shaking OK · no impure module-level code');
