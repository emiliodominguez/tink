// Executes every JSDoc `@example` of the exported API against the current sources (no `yarn build` needed).
// Usage: yarn test:docs [module...]
//
// Inside an @example block:
//   expr; // => expected        asserts that `expr` deep-equals the JS expression `expected` (`// => value // note` adds prose)
//   const x = expr; // => value  asserts the value bound to `x`
//   expr; // throws RangeError   asserts that `expr` throws (or, with `await`, rejects) an error with that name
//   // doctest: skip             as the first line: the block is not run
// Any other comment is prose. All exports of the documented module are in scope; `import ... from 'tinkjs/<module>'`
// lines are resolved against `src/` too. Each block runs on its own inside an async function, in strict mode.
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import { build, transformSync } from 'esbuild';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const PACKAGE = 'tinkjs';
const ROOT_ENTRY = '__root__';
const BLOCK_TIMEOUT = 10_000;
const SKIP_MARKER = /^\s*\/\/\s*doctest:\s*skip\b/;
const BLOCK_TAG =
	/^@(?:param|arg|argument|returns?|template|typeParam|throws|exception|see|since|deprecated|remarks|example|default|defaultValue|internal|category|type|property|prop)\b/;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'];
const LITERAL_KINDS = new Set([
	ts.SyntaxKind.TrueKeyword,
	ts.SyntaxKind.FalseKeyword,
	ts.SyntaxKind.NullKeyword,
	ts.SyntaxKind.ArrayLiteralExpression,
	ts.SyntaxKind.ObjectLiteralExpression
]);

/**
 * @typedef {{ text: string; line: number }} SourceLine A line of example code and its 1-based line number in the source file
 * @typedef {{ module: string; name: string; file: string; line: number; lines: SourceLine[]; skip: boolean }} Example An @example block
 * @typedef {{ id: number; kind: 'equal' | 'throws'; line: number; source: string; expected: string; runs: number }} Assertion An assertion site
 * @typedef {{ module: string; name: string; location: string; message: string }} Failure A reported failure
 */

/**
 * Lists the library modules: every directory of `src/` that has an `index.ts`, except `utils`.
 * @returns {string[]} Module names, sorted
 */
function discoverModules() {
	return readdirSync(SRC, { withFileTypes: true })
		.filter(function (entry) {
			return entry.isDirectory() && entry.name !== 'utils' && existsSync(join(SRC, entry.name, 'index.ts'));
		})
		.map(function (entry) {
			return entry.name;
		})
		.sort();
}

/**
 * Whether a statement carries an `export` modifier.
 * @param {ts.Node} node - A top-level statement
 * @returns {boolean} `true` when exported
 */
function isExported(node) {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some(function (modifier) {
			return modifier.kind === ts.SyntaxKind.ExportKeyword;
		})
	);
}

/**
 * The display name of a declaration.
 * @param {ts.Node} node - A declaration
 * @param {ts.SourceFile} sourceFile - The file it belongs to
 * @returns {string} Its name, or a placeholder for anonymous members
 */
function nameOf(node, sourceFile) {
	if (ts.isVariableStatement(node)) {
		return node.declarationList.declarations
			.map(function (declaration) {
				return declaration.name.getText(sourceFile);
			})
			.join(', ');
	}
	if (ts.isConstructorDeclaration(node)) return 'constructor';
	if (ts.isCallSignatureDeclaration(node)) return '(call)';
	return node.name ? node.name.getText(sourceFile) : '(anonymous)';
}

/**
 * Finds the JSDoc comments attached to the exported declarations of a file (and to their class/interface members).
 * @param {ts.SourceFile} sourceFile - The parsed module
 * @returns {Array<{ name: string; doc: ts.JSDoc }>} Each JSDoc comment with the name of what it documents
 */
function documentedDeclarations(sourceFile) {
	const found = [];

	/**
	 * Records the JSDoc comments of a node.
	 * @param {ts.Node} node - A declaration
	 * @param {string} name - Its display name
	 * @returns {void}
	 */
	function collect(node, name) {
		for (const doc of node.jsDoc ?? []) found.push({ name, doc });
	}

	for (const statement of sourceFile.statements) {
		if (!isExported(statement)) continue;
		const name = nameOf(statement, sourceFile);
		collect(statement, name);
		if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
			for (const member of statement.members) collect(member, `${name}.${nameOf(member, sourceFile)}`);
		} else if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
			for (const member of statement.type.members) collect(member, `${name}.${nameOf(member, sourceFile)}`);
		}
	}

	return found;
}

/**
 * Splits a raw JSDoc comment into its `@example` blocks. Block boundaries are found by hand (not with the TypeScript JSDoc
 * parser) so that decorator lines such as `@memoize` inside an example don't end it. Markdown code fences are dropped.
 * @param {string} raw - The comment text, from `/**` to `*\/`
 * @param {number} firstLine - 1-based line number of the comment's first line
 * @returns {Array<{ tagLine: number; lines: SourceLine[] }>} The line of each `@example` tag and the block's code lines
 */
function splitExamples(raw, firstLine) {
	const blocks = [];
	let current = null;
	let inFence = false;

	raw.split('\n').forEach(function (rawLine, index) {
		const text = rawLine
			.replace(/^\s*\/\*\*\s?/, '')
			.replace(/\s*\*\/\s*$/, '')
			.replace(/^\s*\*(?: |\t)?/, '');
		const trimmed = text.trim();

		if (!inFence && BLOCK_TAG.test(trimmed)) {
			current = null;
			if (trimmed.startsWith('@example')) {
				current = [];
				blocks.push({ tagLine: firstLine + index, lines: current });
				const caption = trimmed.slice('@example'.length).trim();
				if (caption !== '') current.push({ text: caption, line: firstLine + index });
			}
			return;
		}
		if (current === null) return;
		if (trimmed.startsWith('```')) {
			inFence = !inFence;
			return;
		}
		current.push({ text, line: firstLine + index });
	});

	return blocks.filter(function (block) {
		const lines = block.lines;
		while (lines.length > 0 && lines[lines.length - 1].text.trim() === '') lines.pop();
		while (lines.length > 0 && lines[0].text.trim() === '') lines.shift();
		return lines.length > 0;
	});
}

/**
 * Collects the `@example` blocks of a module's exported API.
 * @param {string} moduleName - Folder name under `src/`
 * @returns {Example[]} The blocks, in source order
 */
function collectExamples(moduleName) {
	const file = join(SRC, moduleName, 'index.ts');
	const text = readFileSync(file, 'utf8');
	const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const examples = [];

	for (const { name, doc } of documentedDeclarations(sourceFile)) {
		const firstLine = sourceFile.getLineAndCharacterOfPosition(doc.getStart(sourceFile)).line + 1;
		for (const { tagLine, lines } of splitExamples(text.slice(doc.getStart(sourceFile), doc.end), firstLine)) {
			examples.push({ module: moduleName, name, file: relative(ROOT, file), line: tagLine, lines, skip: SKIP_MARKER.test(lines[0].text) });
		}
	}

	return examples;
}

/**
 * Maps an import specifier used in an example to a bundle entry name.
 * @param {string} specifier - The module specifier
 * @returns {string | undefined} `'<module>'`, the root entry, or `undefined` for non-library specifiers
 */
function libraryEntry(specifier) {
	if (specifier === PACKAGE) return ROOT_ENTRY;
	if (specifier.startsWith(`${PACKAGE}/`)) return specifier.slice(PACKAGE.length + 1);
	return undefined;
}

/**
 * Lists every comment (with its position) of a parsed example.
 * @param {ts.SourceFile} sourceFile - The parsed example
 * @returns {Map<number, ts.CommentRange>} Comments keyed by start position
 */
function allComments(sourceFile) {
	const text = sourceFile.text;
	const comments = new Map();

	/**
	 * Records the comments around a node, then recurses into its children (tokens included).
	 * @param {ts.Node} node - Any node
	 * @returns {void}
	 */
	function visit(node) {
		for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) {
			comments.set(range.pos, range);
		}
		for (const child of node.getChildren(sourceFile)) visit(child);
	}

	visit(sourceFile);
	return comments;
}

/**
 * Whether an expression contains an `await` outside nested functions.
 * @param {ts.Node} node - The expression
 * @returns {boolean} `true` when it awaits
 */
function containsAwait(node) {
	if (ts.isAwaitExpression(node)) return true;
	if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
	return ts.forEachChild(node, containsAwait) === true;
}

/**
 * Checks that an expected-value comment is a single, valid expression.
 * @param {string} expected - The text after `// =>`
 * @returns {string | undefined} An error message, or `undefined` when valid
 */
function invalidExpectation(expected) {
	if (expected.trim() === '') return 'empty expectation after `// =>`';
	try {
		transformSync(`(\n${expected}\n);`, { loader: 'ts', logLevel: 'silent' });
	} catch (error) {
		return `\`// => ${expected}\` is not a valid JS expression (${error.errors?.[0]?.text ?? error.message}); move prose to a separate comment or after a second \`//\``;
	}
	// `// => 9 (cached)` parses as the call `9(cached)`: catch that classic mistake instead of failing with a confusing error.
	const statement = ts.createSourceFile('expected.ts', `(\n${expected}\n);`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS).statements[0];
	let expression = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
	while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
	if (expression && ts.isCallExpression(expression) && (ts.isLiteralExpression(expression.expression) || LITERAL_KINDS.has(expression.expression.kind))) {
		return `\`// => ${expected}\` calls a literal: write the note after a second \`//\` (\`// => value // note\`)`;
	}
	return undefined;
}

/**
 * Rewrites an example into the body of an async function: imports become dynamic imports, assertion comments become
 * runtime checks and every top-level statement records its line (for error reports).
 * @param {Example} example - The block to instrument
 * @returns {{ code: string; assertions: Assertion[]; entries: string[]; errors: string[] }} TypeScript code and metadata
 */
function instrument(example) {
	const text = example.lines
		.map(function (line) {
			return line.text;
		})
		.join('\n');
	const sourceFile = ts.createSourceFile('example.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const comments = allComments(sourceFile);
	const consumed = new Set();
	const edits = [];
	const assertions = [];
	const entries = [];
	const errors = [];

	/**
	 * Source line number of a position in the example.
	 * @param {number} pos - Offset in the example text
	 * @returns {number} 1-based line number in the module file
	 */
	function lineAt(pos) {
		return example.lines[sourceFile.getLineAndCharacterOfPosition(pos).line].line;
	}

	/**
	 * Rewrites a top-level import declaration into a dynamic import.
	 * @param {ts.ImportDeclaration} node - The declaration
	 * @returns {string} Replacement code
	 */
	function rewriteImport(node) {
		const specifier = node.moduleSpecifier.text;
		const clause = node.importClause;
		const entry = libraryEntry(specifier);
		if (entry !== undefined) entries.push(entry);
		const source = `await __rt.import(${JSON.stringify(specifier)})`;
		if (!clause) return `${source};`;
		if (clause.isTypeOnly) return '';
		const parts = [];
		if (clause.name) parts.push(`const ${clause.name.text} = (${source}).default;`);
		if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
			parts.push(`const ${clause.namedBindings.name.text} = ${source};`);
		} else if (clause.namedBindings) {
			const names = clause.namedBindings.elements
				.filter(function (element) {
					return !element.isTypeOnly;
				})
				.map(function (element) {
					return element.propertyName ? `${element.propertyName.getText(sourceFile)}: ${element.name.text}` : element.name.text;
				});
			if (names.length > 0) parts.push(`const { ${names.join(', ')} } = ${source};`);
		}
		return parts.join(' ');
	}

	/**
	 * Turns a statement followed by an assertion comment into a runtime check.
	 * @param {ts.Statement} node - The statement
	 * @param {boolean} topLevel - Whether it is a top-level statement of the block
	 * @returns {boolean} `true` when the statement was rewritten (its children must not be visited again)
	 */
	function rewriteAssertion(node, topLevel) {
		const range = (ts.getTrailingCommentRanges(text, node.end) ?? [])[0];
		if (!range || range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return false;
		const comment = text.slice(range.pos + 2, range.end).trim();
		const equal = /^=>(.*)$/.exec(comment);
		const throws = /^throws(?:\s+([A-Z][\w$]*))?(?:\s.*)?$/.exec(comment);
		if (!equal && !throws) return false;
		consumed.add(range.pos);

		const line = lineAt(range.pos);
		const prefix = topLevel ? `__rt.at(${line}); ` : '';
		const id = assertions.length;
		const statement = text.slice(node.getStart(sourceFile), node.end);
		let replacement;

		if (equal) {
			const expected = equal[1].trim();
			const problem = invalidExpectation(expected);
			if (problem) {
				errors.push(`line ${line}: ${problem}`);
				return true;
			}
			assertions.push({ id, kind: 'equal', line, source: `${statement} // => ${expected}`, expected, runs: 0 });
			if (ts.isExpressionStatement(node)) {
				replacement = `__rt.equal(${id}, ${node.expression.getText(sourceFile)}, (\n${expected}\n));`;
			} else if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 && ts.isIdentifier(node.declarationList.declarations[0].name)) {
				replacement = `${statement}\n__rt.equal(${id}, ${node.declarationList.declarations[0].name.text}, (\n${expected}\n));`;
			} else {
				errors.push(`line ${line}: \`// =>\` must follow an expression statement or a single \`const name = ...\` declaration`);
				return true;
			}
		} else {
			assertions.push({ id, kind: 'throws', line, source: `${statement} // throws ${throws[1] ?? ''}`.trim(), expected: throws[1] ?? '', runs: 0 });
			if (!ts.isExpressionStatement(node)) {
				errors.push(`line ${line}: \`// throws\` must follow an expression statement`);
				return true;
			}
			const expression = node.expression.getText(sourceFile);
			const name = JSON.stringify(throws[1] ?? null);
			replacement = containsAwait(node.expression)
				? `await __rt.rejects(${id}, ${name}, async function () { return (${expression}); });`
				: `__rt.throws(${id}, ${name}, function () { return (${expression}); });`;
		}

		edits.push({ start: node.getStart(sourceFile), end: range.end, text: prefix + replacement });
		return true;
	}

	/**
	 * Walks the statements of the example, rewriting imports and assertions.
	 * @param {ts.Node} node - Current node
	 * @returns {void}
	 */
	function visit(node) {
		const topLevel = node.parent === sourceFile;
		if (topLevel && ts.isImportDeclaration(node)) {
			edits.push({ start: node.getStart(sourceFile), end: node.end, text: rewriteImport(node) });
			return;
		}
		if (topLevel && ts.isImportEqualsDeclaration(node)) {
			errors.push(`line ${lineAt(node.getStart(sourceFile))}: \`import x = require()\` is not supported`);
			return;
		}
		if (ts.isStatement(node) && rewriteAssertion(node, topLevel)) return;
		if (topLevel) edits.push({ start: node.getStart(sourceFile), end: node.getStart(sourceFile), text: `__rt.at(${lineAt(node.getStart(sourceFile))}); ` });
		ts.forEachChild(node, visit);
	}

	ts.forEachChild(sourceFile, visit);

	for (const range of comments.values()) {
		const comment = text.slice(range.pos + 2, range.end).trim();
		if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia && !consumed.has(range.pos) && (/^=>/.test(comment) || /^throws\s+[A-Z]/.test(comment))) {
			errors.push(`line ${lineAt(range.pos)}: \`// ${comment}\` is not attached to a statement (put it right after \`expr;\` on the same line)`);
		}
	}

	let code = text;
	edits
		.sort(function (a, b) {
			return b.start - a.start || b.end - a.end;
		})
		.forEach(function (edit) {
			code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
		});

	return { code, assertions, entries, errors };
}

/**
 * Bundles the requested modules (from `src/`, with code splitting so sibling modules share class identities) into a temp dir.
 * @param {string[]} entries - Module names (and possibly the root entry)
 * @param {string} outdir - Output directory
 * @returns {Promise<Map<string, string>>} File URL of each entry's bundle
 */
async function bundle(entries, outdir) {
	const entryPoints = {};
	for (const entry of entries) entryPoints[entry] = entry === ROOT_ENTRY ? join(SRC, 'index.ts') : join(SRC, entry, 'index.ts');
	await build({
		entryPoints,
		outdir,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'node',
		target: 'es2022',
		write: true,
		logLevel: 'silent',
		alias: { [PACKAGE]: SRC }
	});
	const urls = new Map();
	for (const entry of entries) urls.set(entry, pathToFileURL(join(outdir, `${entry}.js`)).href);
	return urls;
}

/**
 * Compiles an instrumented example into a factory taking the runtime helpers and the module exports.
 * @param {string} body - Instrumented TypeScript body
 * @param {string[]} names - Names of the module exports to put in scope
 * @returns {(rt: object, exports: object) => () => Promise<void>} The factory
 */
function compile(body, names) {
	const source = [
		'globalThis.__doctestFactory = function (__rt, __exports) {',
		`\tconst { ${names.join(', ')} } = __exports;`,
		'\treturn async function () {',
		"\t\t'use strict';",
		body,
		'\t};',
		'};'
	].join('\n');
	// TC39 standard decorators are lowered by esbuild (target ES2022), so `@decorator` examples run as written.
	const { code } = transformSync(source, {
		loader: 'ts',
		target: 'es2022',
		logLevel: 'silent',
		tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } }
	});
	new Function(code)();
	const factory = globalThis.__doctestFactory;
	delete globalThis.__doctestFactory;
	return factory;
}

/**
 * Copies a value, replacing null-prototype objects (as returned by `groupBy`, `parseQueryString`, ...) with object literals,
 * so they compare equal to the `{ ... }` written in an example. Other objects keep their identity and prototype.
 * @param {unknown} value - Any value
 * @param {Map<object, unknown>} [seen] - Copies made so far (handles cycles)
 * @returns {unknown} The normalized value
 */
function normalize(value, seen = new Map()) {
	if (typeof value !== 'object' || value === null) return value;
	if (seen.has(value)) return seen.get(value);
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value)) {
		const copy = new Array(value.length);
		seen.set(value, copy);
		for (const key of Reflect.ownKeys(value)) {
			if (key !== 'length') copy[key] = normalize(value[key], seen);
		}
		return copy;
	}
	if (prototype === null || prototype === Object.prototype) {
		const copy = {};
		seen.set(value, copy);
		for (const key of Reflect.ownKeys(value)) {
			if (Object.prototype.propertyIsEnumerable.call(value, key)) copy[key] = normalize(value[key], seen);
		}
		return copy;
	}
	if (prototype === Map.prototype) {
		const copy = new Map();
		seen.set(value, copy);
		for (const [key, entry] of value) copy.set(normalize(key, seen), normalize(entry, seen));
		return copy;
	}
	if (prototype === Set.prototype) {
		const copy = new Set();
		seen.set(value, copy);
		for (const entry of value) copy.add(normalize(entry, seen));
		return copy;
	}
	return value;
}

/**
 * Deep equality used by `// =>`: `Object.is` for primitives (so `NaN` equals `NaN` and `-0` differs from `0`), structural
 * comparison (`util.isDeepStrictEqual`) for arrays, plain objects, Map, Set, Date, RegExp, typed arrays and errors.
 * Null-prototype objects compare equal to object literals with the same entries.
 * @param {unknown} actual - The value produced by the example
 * @param {unknown} expected - The documented value
 * @returns {boolean} Whether they match
 */
function deepEqual(actual, expected) {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null) return false;
	return isDeepStrictEqual(normalize(actual), normalize(expected));
}

/**
 * Pretty-prints a value for failure reports.
 * @param {unknown} value - Any value
 * @returns {string} A one-line representation
 */
function show(value) {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	return inspect(value, { depth: 8, breakLength: Infinity, maxArrayLength: 50, maxStringLength: 500 });
}

/**
 * Explains why two values that print alike are not equal, when the cause is a common pitfall.
 * @param {unknown} actual - The produced value
 * @param {unknown} expected - The documented value
 * @returns {string} A hint, or an empty string
 */
function hint(actual, expected) {
	if (actual instanceof Promise && !(expected instanceof Promise)) return ' (the expression returned a Promise: did you forget `await`?)';
	if (typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null) {
		if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return ' (the prototypes differ)';
	}
	return '';
}

/**
 * Runs one example block.
 * @param {Example} example - The block
 * @param {object} exports - Namespace of the documented module
 * @param {Map<string, string>} urls - Bundle URL of each library entry
 * @param {(message: string) => void} fail - Records a failure of this block
 * @returns {Promise<number>} Number of assertion sites
 */
async function runExample(example, exports, urls, fail) {
	const { code, assertions, errors } = instrument(example);
	for (const error of errors) fail(error);
	if (errors.length > 0) return assertions.length;

	const state = { line: example.line };
	const logs = [];
	const failed = [];
	const runtime = {
		at: function (line) {
			state.line = line;
		},
		import: function (specifier) {
			const entry = libraryEntry(specifier);
			if (entry === undefined) return import(specifier);
			if (!urls.has(entry)) throw new Error(`unknown library module '${specifier}'`);
			return import(urls.get(entry));
		},
		equal: function (id, actual, expected) {
			const assertion = assertions[id];
			assertion.runs++;
			if (!deepEqual(actual, expected)) {
				failed.push(`line ${assertion.line}: ${assertion.source}\n    expected: ${show(expected)}\n    actual:   ${show(actual)}${hint(actual, expected)}`);
			}
		},
		throws: function (id, name, fn) {
			const assertion = assertions[id];
			assertion.runs++;
			let result;
			try {
				result = fn();
			} catch (error) {
				checkThrown(assertion, name, error);
				return;
			}
			failed.push(
				`line ${assertion.line}: ${assertion.source}\n    expected a thrown ${name ?? 'error'}, but it returned ${show(result)}${result instanceof Promise ? ' (a Promise: use `await expr; // throws ...`)' : ''}`
			);
		},
		rejects: async function (id, name, fn) {
			const assertion = assertions[id];
			assertion.runs++;
			let result;
			try {
				result = await fn();
			} catch (error) {
				checkThrown(assertion, name, error);
				return;
			}
			failed.push(`line ${assertion.line}: ${assertion.source}\n    expected a thrown ${name ?? 'error'}, but it resolved to ${show(result)}`);
		}
	};

	/**
	 * Checks the name of an error caught by a `// throws` assertion.
	 * @param {Assertion} assertion - The assertion site
	 * @param {string | null} name - Expected error name (any error when `null`)
	 * @param {unknown} error - What was thrown
	 * @returns {void}
	 */
	function checkThrown(assertion, name, error) {
		const actual = error instanceof Error ? error.name : undefined;
		if (name !== null && actual !== name) {
			failed.push(
				`line ${assertion.line}: ${assertion.source}\n    expected a thrown ${name}, got ${error instanceof Error ? `${error.name}: ${error.message}` : show(error)}`
			);
		}
	}

	let factory;
	try {
		factory = compile(code, Object.keys(exports).filter(isIdentifier));
	} catch (error) {
		fail(`does not compile: ${error.errors?.[0]?.text ?? error.message}`);
		return assertions.length;
	}

	const originals = {};
	for (const method of CONSOLE_METHODS) {
		originals[method] = console[method];
		console[method] = function (...args) {
			logs.push(`${method}: ${args.map(String).join(' ')}`);
		};
	}

	let timer;
	try {
		await Promise.race([
			factory(runtime, exports)(),
			new Promise(function (_resolve, reject) {
				timer = setTimeout(function () {
					reject(new Error(`timed out after ${BLOCK_TIMEOUT} ms`));
				}, BLOCK_TIMEOUT);
			})
		]);
		for (const assertion of assertions) {
			if (assertion.runs === 0)
				failed.push(`line ${assertion.line}: ${assertion.source}\n    this assertion never ran (inside a callback that was not called before the block ended?)`);
		}
	} catch (error) {
		const advice =
			error instanceof ReferenceError ? '\n    the example uses something it does not define: make it self-contained, or start the block with `// doctest: skip`' : '';
		failed.push(`line ${state.line}: unexpected ${error instanceof Error ? `${error.name}: ${error.message}` : `throw of ${show(error)}`}${advice}`);
	} finally {
		clearTimeout(timer);
		// Give rejections the block left unhandled a chance to be reported against it.
		await new Promise(function (resolve) {
			setImmediate(resolve);
		});
		Object.assign(console, originals);
	}

	if (logs.length > 0 && failed.length > 0) failed[failed.length - 1] += `\n    console output:\n      ${logs.join('\n      ')}`;
	for (const message of failed) fail(message);
	return assertions.length;
}

/**
 * Whether a string is a valid JavaScript identifier (export names that aren't can't be put in scope).
 * @param {string} name - An export name
 * @returns {boolean} `true` for identifiers
 */
function isIdentifier(name) {
	return /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default';
}

/**
 * Entry point: parses CLI arguments, bundles the sources, runs every block and prints a report.
 * @returns {Promise<number>} The process exit code
 */
async function main() {
	const available = discoverModules();
	const requested = process.argv.slice(2);
	const unknown = requested.filter(function (name) {
		return !available.includes(name);
	});
	if (unknown.length > 0) {
		console.error(`doctest: unknown module(s): ${unknown.join(', ')} (available: ${available.join(', ')})`);
		return 2;
	}
	const modules = requested.length > 0 ? requested : available;
	const examples = modules.flatMap(collectExamples);

	const entries = new Set(modules);
	for (const example of examples) {
		if (!example.skip) for (const entry of instrument(example).entries) entries.add(entry);
	}

	const outdir = mkdtempSync(join(tmpdir(), 'tink-doctest-'));
	/** @type {Failure[]} */
	const failures = [];
	let current = null;

	process.on('unhandledRejection', function (reason) {
		failures.push({
			module: current?.module ?? '?',
			name: current?.name ?? '?',
			location: current ? `${current.file}:${current.line}` : '?',
			message: `unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : show(reason)}`
		});
	});

	try {
		let urls;
		try {
			urls = await bundle([...entries], outdir);
		} catch (error) {
			console.error(`doctest: could not bundle ${[...entries].join(', ')}:\n${error.message}`);
			return 1;
		}

		let assertionCount = 0;
		let skipped = 0;
		for (const moduleName of modules) {
			const exports = await import(urls.get(moduleName));
			for (const example of examples) {
				if (example.module !== moduleName) continue;
				if (example.skip) {
					skipped++;
					continue;
				}
				current = example;
				assertionCount += await runExample(example, exports, urls, function (message) {
					failures.push({ module: example.module, name: example.name, location: `${example.file}:${example.line}`, message });
				});
			}
		}
		// Let rejections scheduled by the last blocks surface.
		await new Promise(function (resolve) {
			setTimeout(resolve, 20);
		});

		for (const failure of failures) {
			console.error(`\nFAIL ${failure.module} › ${failure.name} (${failure.location})\n  ${failure.message}`);
		}
		const summary = `${examples.length} blocks, ${assertionCount} assertions, ${skipped} skipped`;
		if (failures.length > 0) {
			console.error(`\ndoctest: ${failures.length} failure(s) — ${summary} in ${modules.length} module(s)`);
			return 1;
		}
		console.log(`doctest: all examples pass — ${summary} in ${modules.length} module(s)`);
		return 0;
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
}

// Exit explicitly: examples may leave timers (intervals, pending debounces) running.
process.exit(await main());
