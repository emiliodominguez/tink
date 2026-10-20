// Generates docs/API.md (one table per module listing every exported function/class with its JSDoc summary) and the llms.txt /
// llms-full.txt indexes for AI coding assistants (https://llmstxt.org), which ship in the package.
// Usage: yarn docs:api
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import ts from 'typescript';

const MODULES = [
	['arrays', 'Collection helpers: set algebra, grouping, chunking, sorting and comparators, sampling, pagination and id/parentId trees.'],
	['objects', 'Shallow/deep cloning, merging, equality, path access, object reshaping, structural sharing and JSON Patch (RFC 6902).'],
	['guards', 'Runtime type predicates that narrow `unknown` values, composable into path-aware, Standard Schema-compatible validators, plus runtime detection.'],
	['strings', 'Unicode-aware transformations, case conversion, escaping, templating, natural sorting, terminal text width, ANSI/HTML stripping and safe file names.'],
	['url', 'Typed route patterns (match and build), query-string building and parsing, URL joining, normalization and cookies.'],
	[
		'path',
		'POSIX path helpers (normalize, join, resolve, relative, parse/format, basename/dirname/extname) for every runtime, byte for byte like node:path, in linear time.'
	],
	[
		'math',
		'Precise arithmetic and rounding (exact sums, half-even rounding, lossless allocation, fractions), statistics, regression, histograms, number theory (factorization, modular arithmetic), interpolation, axis ticks, vectors, root finding and random numbers.'
	],
	['functions', 'Function composition, currying, memoization, rate limiting, pattern matching, Result tuples (ok/err/unwrap) and when/unless/cond.'],
	[
		'async',
		'Promise utilities: retries and backoff, timeouts, polling, limiters, semaphores and mutexes, circuit breakers, request batching, event waiting and async event iteration, drift-free intervals, stopwatches, keyed Promise.all and async debounce.'
	],
	[
		'color',
		'Hex/RGB/HSL/HSV, OKLab/OKLCH and CIELAB conversion with CSS gamut mapping, perceptual mixing and scales, colour difference (deltaE, CIEDE2000), stable colours from strings, colour-blindness simulation, opt-in named colours and WCAG contrast checks.'
	],
	[
		'search',
		'Fuzzy matching and ranking with highlight ranges and optional accent folding, for command palettes and filter-as-you-type UIs, plus a BM25 full-text index and a Unicode tokenizer.'
	],
	['easing', 'Animation easing curves, CSS-accurate cubic-bezier() and steps(), and an analytic spring.'],
	[
		'encoding',
		'Buffer-free base64/base64url, base32, hex and UTF-8 conversions with strict decoding, RFC 4180 CSV, JWT decoding and HS256 signing/verification, constant-time comparison, a synchronous SHA-256 and HMAC-SHA256, and CRC-32.'
	],
	[
		'errors',
		'Never-throwing error normalization (toError, getErrorMessage), cycle-safe error serialization that round-trips through JSON, typed error classes (defineError), cause chains and readable reports.'
	],
	['format', 'Deterministic, cached Intl formatting (numbers, currency, percent, compact, units, lists, dates, ordinals) and strict locale-aware number parsing.'],
	[
		'validate',
		'Linear-time string validators (email, URL, UUID, IP, semver, ISO dates, Luhn, base64, ...) as type predicates, zod-like parsing with coercion, defaults and transforms, typed environment variables, and node-semver-exact ranges.'
	],
	[
		'date',
		'DST-safe, non-mutating date arithmetic, formatting and parsing, IANA time zones, calendar grids, interval sets, business days with holidays and cron schedules.'
	],
	[
		'iterables',
		'Lazy, generator-based pipelines over any (async) iterable, with exact pull counts and early-exit cleanup, plus stream readers (lines, Server-Sent Events, NDJSON) and async merging and batching.'
	],
	[
		'cache',
		'O(1) LRU cache with optional TTL, eviction callbacks and an injectable clock (plugs into memoize), a ring-buffer deque, a ring buffer, a priority queue, a radix trie, a Bloom filter, and bidirectional, multi-value and default maps.'
	],
	['emitter', 'Typed event emitter with wildcard listeners, waitFor and error isolation.'],
	['store', 'Tiny state store compatible with React useSyncExternalStore, with derived and computed stores, persistence, typed state machines and undo/redo.'],
	['random', 'Seeded deterministic PRNG plus cryptographically secure ids, UUIDs (v4, v7), ULIDs and bytes.'],
	['decorators', 'Class decorators for TypeScript (legacy and TC39 standard) and Babel, including lazy getters and method timing.']
];

/**
 * The text a `{@link}` tag displays: its `| label` when there is one, otherwise the target without its `module!` prefix.
 * @param {ts.JSDocLink | ts.JSDocLinkCode | ts.JSDocLinkPlain} part - The link tag
 * @returns {string} The label, without backticks
 */
function linkLabel(part) {
	const target = (part.name ? part.name.getText() : '') + part.text;
	const pipe = target.indexOf('|');
	return (pipe === -1 ? target.slice(target.indexOf('!') + 1) : target.slice(pipe + 1)).replace(/`/g, '').trim();
}

/**
 * Extracts the first sentence of a JSDoc comment (within its first paragraph), rendering `{@link X}` as inline code.
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
						return part.kind === ts.SyntaxKind.JSDocText ? part.text : '`' + linkLabel(part) + '`';
					})
					.join('');
	// The summary never runs past the first paragraph (a table or a list may follow it).
	const flat = text
		.split(/\n\s*\n/)[0]
		.replace(/\s*\n\s*/g, ' ')
		.trim()
		.replace(/:\s+-\s.*$/, '.')
		.replace(/:$/, '.');
	const codeSpans = [];
	const masked = flat.replace(/`[^`]*`/g, function (code) {
		codeSpans.push(code);
		return `\uE000${codeSpans.length - 1}\uE000`;
	});
	const match = /^(.+?(?<!\b(?:i\.e|e\.g|etc))\.)(\s|$)/.exec(masked);
	const sentence = (match ? match[1] : masked).replace(/\uE000(\d+)\uE000/g, function (_placeholder, index) {
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

/**
 * Lists the exported type aliases and interfaces of `src/utils/types.ts` (the `tinkit/utils` entry point), in source order.
 * @returns {Array<{ name: string; summary: string }>} The types
 */
function listTypes() {
	const file = 'src/utils/types.ts';
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
	return source.statements
		.filter(function (statement) {
			return (
				(ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
				(ts.getModifiers(statement) || []).some(function (modifier) {
					return modifier.kind === ts.SyntaxKind.ExportKeyword;
				})
			);
		})
		.map(function (statement) {
			return { name: statement.name.text, summary: summarize(statement.jsDoc && statement.jsDoc[0]) };
		});
}

const TYPES = listTypes();
const TYPES_DESCRIPTION =
	'Type-only utilities (type-fest style, no runtime code): deep partial/required/writable, key reshaping, branded types, exclusive-key constraints, type predicates and `Jsonify`. Also importable from the package root.';

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

const typesSection = `## types\n\n${TYPES_DESCRIPTION}\n\n\`\`\`ts\nimport type { … } from 'tinkit/utils';\n\`\`\`\n\n| Type | Description |\n| --- | --- |\n${TYPES.map(
	function (row) {
		return `| \`${row.name}\` | ${row.summary} |`;
	}
).join('\n')}\n`;

const toc =
	MODULES.map(function ([name]) {
		return `[\`${name}\`](#${name})`;
	}).join(' · ') + ' · [`types`](#types)';

const output = `# API reference\n\n> Generated from the JSDoc in \`src/*/index.ts\` by \`yarn docs:api\` — do not edit by hand.\n> Every function documents its parameters, return value, thrown errors and examples in its JSDoc, so your editor shows the full details on hover.\n> For a browsable HTML version run \`yarn docs\` (TypeDoc, output in \`docs/reference\`).\n\n${toc}\n\n${sections.join('\n')}\n${typesSection}`;

mkdirSync('docs', { recursive: true });
writeFileSync('docs/API.md', output);

const REPO = 'https://github.com/emiliodominguez/tinkit/blob/main';
const PRINCIPLES = `Key facts for code generation:
- ESM only, zero dependencies, Node >= 20.19 or any modern browser/runtime. TypeScript types ship in the package.
- Import from module entry points: \`import { debounce } from 'tinkit/functions'\` (the root entry exposes namespaces: \`import { functions } from 'tinkit'\`).
- Helpers never mutate their inputs unless the name or docs say so (\`setPath\`, \`deletePath\`).
- Invalid arguments throw \`TypeError\` (wrong type) or \`RangeError\` (invalid value) whose message names the function and the parameter (\`fn: param must be …, got …\`); decoders of malformed text (base64, hex, UUIDv7/ULID timestamps) throw \`SyntaxError\`.
- Randomised helpers take an optional \`random\` generator last; the default is \`Math.random\`. Pass \`secureRandom\` (random module) for tokens, OTPs and lotteries.
- Type guards compose into validators: \`isShape\`, \`isArrayOf\`, \`isUnion\`, \`isOptional\`…; \`explain\` lists issues with paths, \`ensure\` throws a \`ValidationError\`, \`toStandardSchema\` adapts any guard for tRPC, TanStack Form, Hono and other Standard Schema consumers.
- To convert as well as check (environment variables, query strings, forms, API payloads), use \`parse\`/\`safeParse\` from \`tinkit/validate\` with a plain object of guards and parsers: \`parse({ PORT: withDefault(asInteger, 3000), DEBUG: withDefault(asBoolean, false), DATABASE_URL: isUrl }, process.env)\`. Unknown keys are stripped; \`asNumber\`, \`asInteger\`, \`asBoolean\` and \`asDate\` coerce strictly (\`''\` and \`'false'\` are not \`0\` and \`true\`); \`optional\`, \`withDefault\`, \`nullable\`, \`transform\`, \`chain\`, \`arrayOf\`, \`tuple\`, \`recordOf\`, \`union\`, \`discriminatedUnion\`, \`lazy\`, \`exact\` and \`partial\` compose; \`asArray\` (repeated query parameters), \`blankAsUndefined\` (empty form fields) and \`asJson\` (JSON strings) handle raw input; \`issuesByPath\` (guards) maps issues to form fields; every parser is a Standard Schema validator, and zod schemas can be nested.`;

const llms = `# tink (tinkit)

> Strictly-typed, zero-dependency, tree-shakeable TypeScript utilities (${MODULES.length} modules, ${[...EXPORTS.values()].reduce(function (total, rows) {
	return total + rows.length;
}, 0)} exports): arrays, objects, strings, math, functions, async, dates, type guards and Standard Schema validators, colors, easing, encoding, error serialization, fuzzy and full-text search, caches, emitters, stores, POSIX paths, cron and semver. Property-tested and mutation-tested.

${PRINCIPLES}

## Modules

${MODULES.map(function ([name, description]) {
	return `- [${name}](${REPO}/docs/API.md#${name}): ${description} Import from \`tinkit/${name}\`.`;
}).join('\n')}
- [types](${REPO}/docs/API.md#types): ${TYPES_DESCRIPTION} Import from \`tinkit/utils\`.

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

## types

${TYPES_DESCRIPTION}
Import: \`import type { … } from 'tinkit/utils';\`

${TYPES.map(function (row) {
	return `- \`${row.name}\`${row.summary ? ` — ${row.summary}` : ''}`;
}).join('\n')}
`;

writeFileSync('llms.txt', llms);
writeFileSync('llms-full.txt', full);
