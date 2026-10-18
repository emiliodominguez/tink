// Generates docs/API.md (one table per module listing every exported function/class with its JSDoc summary) and the llms.txt /
// llms-full.txt indexes for AI coding assistants (https://llmstxt.org), which ship in the package.
// Usage: yarn docs:api
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import ts from 'typescript';

const MODULES = [
	['arrays', 'Collection helpers: set algebra, grouping, chunking, sorting, sampling.'],
	['objects', 'Shallow/deep cloning, merging, equality, path access and object reshaping.'],
	['guards', 'Runtime type predicates that narrow `unknown` values, composable into path-aware, Standard Schema-compatible validators.'],
	['strings', 'Unicode-aware transformations, case conversion, escaping, templating and text metrics.'],
	['url', 'Query-string building and parsing, URL joining and query merging, without URL object types.'],
	['math', 'Precise arithmetic, statistics, number theory and random numbers.'],
	['functions', 'Function composition, currying, memoization and rate limiting.'],
	['async', 'Promise utilities: retries, timeouts, polling, limiters, keyed Promise.all and async debounce.'],
	['color', 'Hex/RGB/HSL conversion, mixing, lightening and WCAG contrast checks.'],
	['search', 'Fuzzy matching and ranking with highlight ranges, for command palettes and filter-as-you-type UIs.'],
	['easing', 'Animation easing curves, CSS-accurate cubic-bezier() and steps(), and an analytic spring.'],
	['format', 'Deterministic, cached Intl formatting: numbers, currency, percent, compact, units, lists, dates, ordinals.'],
	['validate', 'Linear-time string validators (email, URL, UUID, IP, semver, ISO dates, Luhn, base64, ...) as type predicates.'],
	['date', 'DST-safe, non-mutating local-time date arithmetic, formatting and parsing.'],
	['iterables', 'Lazy, generator-based pipelines over any (async) iterable, with exact pull counts and early-exit cleanup.'],
	['cache', 'O(1) LRU cache with optional TTL, eviction callbacks and an injectable clock; plugs into memoize.'],
	['emitter', 'Typed event emitter with wildcard listeners, waitFor and error isolation.'],
	['store', 'Tiny state store compatible with React useSyncExternalStore, with derived selectors.'],
	['random', 'Seeded deterministic PRNG plus cryptographically secure ids, UUIDs and bytes.'],
	['decorators', 'Class decorators for TypeScript (legacy and TC39 standard) and Babel.']
];

/**
 * Extracts the first sentence of a JSDoc comment, rendering `{@link X}` as inline code.
 * @param {ts.JSDoc | undefined} doc - The JSDoc node
 * @returns {string} The summary sentence
 */
function summarize(doc) {
	if (!doc || !doc.comment) return '';
	const text =
		typeof doc.comment === 'string'
			? doc.comment
			: doc.comment
					.map(function (part) {
						return part.kind === ts.SyntaxKind.JSDocText ? part.text : '`' + (part.name ? part.name.getText() : part.text) + '`';
					})
					.join('');
	const flat = text
		.replace(/\s*\n\s*/g, ' ')
		.trim()
		.replace(/:\s+-\s.*$/, '.');
	const codeSpans = [];
	const masked = flat.replace(/`[^`]*`/g, function (code) {
		codeSpans.push(code);
		return `\u0000${codeSpans.length - 1}\u0000`;
	});
	const match = /^(.+?(?<!\b(?:i\.e|e\.g|etc))\.)(\s|$)/.exec(masked);
	const sentence = (match ? match[1] : masked).replace(/\u0000(\d+)\u0000/g, function (_placeholder, index) {
		return codeSpans[Number(index)];
	});
	return sentence.replace(/\|/g, '\\|');
}

/**
 * Renders a compact one-line signature: `(a: number, b?: string) => T` for functions, `new (...)` for classes.
 * @param {ts.FunctionDeclaration | ts.ClassDeclaration} statement - The declaration
 * @returns {string} The signature, whitespace-collapsed
 */
function signatureOf(statement) {
	if (ts.isClassDeclaration(statement)) {
		const constructor = statement.members.find(ts.isConstructorDeclaration);
		return `new (${constructor ? constructor.parameters.map(text).join(', ') : ''})`;
	}
	const generics = statement.typeParameters ? `<${statement.typeParameters.map(text).join(', ')}>` : '';
	return `${generics}(${statement.parameters.map(text).join(', ')}): ${statement.type ? text(statement.type) : 'void'}`;
}

/**
 * Returns the source text of a node with whitespace collapsed.
 * @param {ts.Node} node - The node
 * @returns {string} The text
 */
function text(node) {
	return node.getText().replace(/\s+/g, ' ');
}

/**
 * Lists the exported functions and classes of a module, in source order, ignoring overload duplicates.
 * @param {string} name - Module folder name
 * @returns {Array<{ name: string; kind: string; summary: string }>} The exports
 */
function listExports(name) {
	const file = `src/${name}/index.ts`;
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
	const seen = new Set();
	const rows = [];

	for (const statement of source.statements) {
		const isExported = (ts.getModifiers(statement) || []).some(function (modifier) {
			return modifier.kind === ts.SyntaxKind.ExportKeyword;
		});
		if (!isExported || !statement.name || seen.has(statement.name.text)) continue;
		if (!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) continue;
		seen.add(statement.name.text);
		rows.push({
			name: statement.name.text,
			kind: ts.isClassDeclaration(statement) ? 'class' : 'function',
			summary: summarize(statement.jsDoc && statement.jsDoc[0]),
			signature: signatureOf(statement)
		});
	}

	return rows;
}

const EXPORTS = new Map(
	MODULES.map(function ([name]) {
		return [name, listExports(name)];
	})
);

const sections = MODULES.map(function ([name, description]) {
	const rows = EXPORTS.get(name)
		.map(function (row) {
			return `| \`${row.name}\`${row.kind === 'class' ? ' _(class)_' : ''} | ${row.summary} |`;
		})
		.join('\n');
	return `## ${name}\n\n${description}\n\n\`\`\`ts\nimport { … } from 'tinkit/${name}';\n\`\`\`\n\n| Export | Description |\n| --- | --- |\n${rows}\n`;
});

const toc = MODULES.map(function ([name]) {
	return `[\`${name}\`](#${name})`;
}).join(' · ');

const output = `# API reference\n\n> Generated from the JSDoc in \`src/*/index.ts\` by \`yarn docs:api\` — do not edit by hand.\n> Every function documents its parameters, return value, thrown errors and examples in its JSDoc, so your editor shows the full details on hover.\n> For a browsable HTML version run \`yarn docs\` (TypeDoc, output in \`docs/reference\`).\n\n${toc}\n\n${sections.join('\n')}`;

mkdirSync('docs', { recursive: true });
writeFileSync('docs/API.md', output);

const REPO = 'https://github.com/emiliodominguez/js-helpers/blob/main';
const PRINCIPLES = `Key facts for code generation:
- ESM only, zero dependencies, Node >= 20.19 or any modern browser/runtime. TypeScript types ship in the package.
- Import from module entry points: \`import { debounce } from 'tinkit/functions'\` (the root entry exposes namespaces: \`import { functions } from 'tinkit'\`).
- Helpers never mutate their inputs unless the name or docs say so (\`setPath\`, \`deletePath\`).
- Invalid arguments throw \`TypeError\` (wrong type) or \`RangeError\` (invalid value) whose message names the function and the parameter (\`fn: param must be …, got …\`).
- Randomised helpers take an optional \`random\` generator last; the default is \`Math.random\`. Pass \`secureRandom\` (random module) for tokens, OTPs and lotteries.
- Type guards compose into validators: \`isShape\`, \`isArrayOf\`, \`isUnion\`, \`isOptional\`…; \`explain\` lists issues with paths, \`ensure\` throws a \`ValidationError\`, \`toStandardSchema\` adapts any guard for tRPC, TanStack Form, Hono and other Standard Schema consumers.`;

const llms = `# tink (tinkit)

> Strictly-typed, zero-dependency, tree-shakeable TypeScript utilities (${MODULES.length} modules, ${[...EXPORTS.values()].reduce(function (total, rows) {
	return total + rows.length;
}, 0)} exports): arrays, objects, strings, math, functions, async, dates, type guards and Standard Schema validators, colors, easing, fuzzy search, caches, emitters and stores. Property-tested and mutation-tested.

${PRINCIPLES}

## Modules

${MODULES.map(function ([name, description]) {
	return `- [${name}](${REPO}/docs/API.md#${name}): ${description} Import from \`tinkit/${name}\`.`;
}).join('\n')}

## Docs

- [Full API index with signatures](llms-full.txt): every export with its signature and summary.
- [API reference](${REPO}/docs/API.md)
- [Migrating from lodash](${REPO}/docs/MIGRATING-FROM-LODASH.md): lodash → tink mapping with behavioural notes and sizes.
- [Import cost of every helper](${REPO}/docs/SIZES.md)
- [Security policy](${REPO}/SECURITY.md)
`;

const full = `# tinkit — full API index

${PRINCIPLES}

${MODULES.map(function ([name, description]) {
	return `## ${name}\n\n${description}\nImport: \`import { … } from 'tinkit/${name}';\`\n\n${EXPORTS.get(name)
		.map(function (row) {
			return `- \`${row.name}${row.signature}\`${row.summary ? ` — ${row.summary}` : ''}`;
		})
		.join('\n')}`;
}).join('\n\n')}
`;

writeFileSync('llms.txt', llms);
writeFileSync('llms-full.txt', full);
