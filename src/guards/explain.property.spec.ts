import fc from 'fast-check';
import { arrayOf, lazy, optional, safeParse } from '../validate/index.js';
import {
	explain,
	type Guard,
	isArrayOf,
	isDiscriminatedUnion,
	isInteger,
	isIntersection,
	isJsonArray,
	isJsonObject,
	isJsonValue,
	isLazy,
	isLiteral,
	isMatching,
	isNullable,
	isNumberInRange,
	isOneOf,
	isOptional,
	isPlainObject,
	isRecordOf,
	isShape,
	isString,
	isStringOfLength,
	isTuple,
	isUnion,
	refine,
	type SchemaIssue,
	withMessage
} from '.';

// The tree oracle of `explain` on values sharing objects: the value is expanded into a tree (no object held twice), whose report is the
// reference. The report of the shared value must hold the same issues, except that an object met again by a lazy guard (or a JSON
// guard's walk) gives one pointer issue instead of its issues, and each pointer must name an object whose issues are in the same report.

const POINTER = 'Invalid value (same object as reported at another path)';

type Ast =
	| { t: 'int' | 'str' | 'range' | 'oneOf' | 'len' | 'black' | 'json' }
	| { t: 'lit'; v: number | string | null }
	| { t: 'shape' | 'match'; fields: Record<string, Ast>; exact: boolean }
	| { t: 'array' | 'record' | 'opt' | 'null' | 'msg'; of: Ast }
	| { t: 'tuple'; items: Ast[] }
	| { t: 'union' | 'inter'; members: Ast[] }
	| { t: 'disc'; variants: Record<string, Ast> }
	| { t: 'refine'; of: Ast; pred: 'self' | 'child' | 'parse' | 'simple'; j: number }
	| { t: 'lazy'; j: number };

/**
 * A xorshift generator of numbers in [0, 1).
 * @param {number} seed - The seed
 * @returns {() => number} The generator
 */
function random(seed: number): () => number {
	let state = seed >>> 0 || 1;

	return function (): number {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;

		return state / 4294967296;
	};
}

/**
 * Copies a value without sharing: every plain object and array is copied at each place it is held.
 * @param {unknown} value - The value
 * @returns {unknown} The tree
 */
function expand(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	if (Array.isArray(value)) {
		const copy = new Array<unknown>(value.length);

		for (let index = 0; index < value.length; index++) if (Object.hasOwn(value, index)) copy[index] = expand(value[index]);
		for (const key of Object.keys(value)) if (!/^\d+$/.test(key)) (copy as unknown as Record<string, unknown>)[key] = (value as unknown as Record<string, unknown>)[key];

		return copy;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;

	const copy: Record<string, unknown> = {};

	for (const key of Object.keys(value)) copy[key] = expand((value as Record<string, unknown>)[key]);

	return copy;
}

/**
 * The value at `path` in `value`.
 * @param {unknown} value - The root
 * @param {ReadonlyArray<PropertyKey>} path - The path
 * @returns {unknown} The value there
 */
function at(value: unknown, path: ReadonlyArray<PropertyKey>): unknown {
	let current = value;

	for (const key of path) current = typeof current === 'object' && current !== null ? (current as Record<PropertyKey, unknown>)[key] : undefined;

	return current;
}

/**
 * An issue as a string, for comparisons.
 * @param {SchemaIssue} issue - The issue
 * @returns {string} Its path and message
 */
function idOf(issue: SchemaIssue): string {
	return `${JSON.stringify(issue.path.map(String))}|${issue.message}`;
}

/**
 * Whether `path` starts with `prefix`.
 * @param {ReadonlyArray<PropertyKey>} path - A path
 * @param {ReadonlyArray<PropertyKey>} prefix - Another one
 * @returns {boolean} `true` when `prefix` is a prefix of `path`
 */
function startsWith(path: ReadonlyArray<PropertyKey>, prefix: ReadonlyArray<PropertyKey>): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every(function (key: PropertyKey, index: number): boolean {
			return Object.is(path[index], key);
		})
	);
}

/**
 * Compares the report of a value sharing objects with the report of its tree.
 * @param {unknown} shared - The value
 * @param {SchemaIssue[]} report - Its report
 * @param {SchemaIssue[]} tree - The report of its tree
 * @returns {string[]} The problems found (none when the reports agree)
 */
function compareReports(shared: unknown, report: SchemaIssue[], tree: SchemaIssue[]): string[] {
	const problems: string[] = [];
	const real = report.filter(function (issue: SchemaIssue): boolean {
		return issue.message !== POINTER;
	});
	const pointers = report.filter(function (issue: SchemaIssue): boolean {
		return issue.message === POINTER;
	});
	const left = new Map<string, number>();

	for (const issue of tree) left.set(idOf(issue), (left.get(idOf(issue)) ?? 0) + 1);
	for (const issue of real) {
		const count = left.get(idOf(issue)) ?? 0;

		if (count === 0) problems.push(`extra issue ${idOf(issue)}`);
		else left.set(idOf(issue), count - 1);
	}

	const missing: SchemaIssue[] = [];

	for (const issue of tree) {
		const count = left.get(idOf(issue)) ?? 0;

		if (count > 0) {
			left.set(idOf(issue), count - 1);
			missing.push(issue);
		}
	}

	// The paths of the report, other than under the pointer, holding the object the pointer names.
	const referents = new Map<SchemaIssue, PropertyKey[][]>();

	for (const pointer of pointers) {
		const object = at(shared, pointer.path);

		if (typeof object !== 'object' || object === null) problems.push(`pointer at a primitive ${idOf(pointer)}`);
		if (
			!tree.some(function (issue: SchemaIssue): boolean {
				return startsWith(issue.path, pointer.path);
			})
		) {
			problems.push(`pointer where the tree has no issue ${idOf(pointer)}`);
		}

		const found: PropertyKey[][] = [];

		for (const issue of report) {
			for (let length = 0; length <= issue.path.length; length++) {
				const prefix = issue.path.slice(0, length);

				if (startsWith(prefix, pointer.path) || at(shared, prefix) !== object) continue;
				if (
					!found.some(function (other: PropertyKey[]): boolean {
						return other.length === prefix.length && startsWith(other, prefix);
					})
				) {
					found.push(prefix);
				}
			}
		}
		if (found.length === 0) problems.push(`pointer without a referent ${idOf(pointer)}`);
		referents.set(pointer, found);
	}

	// Each missing issue, relative to a pointer above it, is an issue of the report at a referent of that pointer (or one justified so).
	const realIds = new Set(real.map(idOf));
	const justified = new Set<string>();
	let changed = true;

	while (changed) {
		changed = false;
		for (const issue of missing) {
			if (justified.has(idOf(issue))) continue;

			const ok = pointers.some(function (pointer: SchemaIssue): boolean {
				return (
					startsWith(issue.path, pointer.path) &&
					(referents.get(pointer) as PropertyKey[][]).some(function (referent: PropertyKey[]): boolean {
						const moved = idOf({ message: issue.message, path: [...referent, ...issue.path.slice(pointer.path.length)] });

						return realIds.has(moved) || justified.has(moved);
					})
				);
			});

			if (ok) {
				justified.add(idOf(issue));
				changed = true;
			}
		}
	}
	for (const issue of missing) if (!justified.has(idOf(issue))) problems.push(`missing issue ${idOf(issue)}`);

	return problems;
}

/**
 * Builds random recursive guards (every combinator, explains nested in predicates) and a value for them that shares objects.
 * @param {number} seed - The seed
 * @returns {{ guard: Guard<unknown>; value: unknown }} The guard and the value
 */
function makeCase(seed: number): { guard: Guard<unknown>; value: unknown } {
	const next = random(seed);
	const count = 1 + Math.floor(next() * 3);
	const keys = ['a', 'b', 'c', 'd'];
	const lazies: Array<Guard<unknown>> = [];
	const definitions: Ast[] = [];

	/**
	 * Picks an element.
	 * @template T - The element type
	 * @param {ReadonlyArray<T>} list - The elements
	 * @returns {T} One of them
	 */
	function pick<T>(list: ReadonlyArray<T>): T {
		return list[Math.floor(next() * list.length)];
	}

	/**
	 * A reference to a lazy guard; one checking the same value (not a child) goes to a later definition, so there is no left recursion.
	 * @param {number} self - The definition being built
	 * @param {boolean} child - Whether the reference checks a child
	 * @returns {Ast} The reference
	 */
	function reference(self: number, child: boolean): Ast {
		if (child) return { t: 'lazy', j: Math.floor(next() * count) };

		return self + 1 >= count ? { t: 'int' } : { t: 'lazy', j: self + 1 + Math.floor(next() * (count - self - 1)) };
	}

	/**
	 * Generates a schema.
	 * @param {number} depth - The remaining depth
	 * @param {number} self - The definition being built
	 * @param {boolean} child - Whether it checks a child of the value of the definition
	 * @returns {Ast} The schema
	 */
	function schema(depth: number, self: number, child: boolean): Ast {
		if (depth <= 0 || next() < 0.25) {
			if (next() < (child ? 0.8 : 0.3)) return reference(self, child);

			return pick<Ast>([{ t: 'int' }, { t: 'str' }, { t: 'lit', v: pick([1, 'a', null]) }, { t: 'range' }, { t: 'oneOf' }, { t: 'len' }, { t: 'black' }, { t: 'json' }]);
		}

		const kind = pick(['shape', 'shape', 'match', 'array', 'record', 'tuple', 'union', 'disc', 'inter', 'opt', 'null', 'refine', 'refine', 'msg', 'lazy']);

		switch (kind) {
			case 'shape':
			case 'match': {
				const fields: Record<string, Ast> = {};

				for (let index = 1 + Math.floor(next() * 3); index > 0; index--) fields[pick(keys)] = schema(depth - 1, self, true);

				return { t: kind, fields, exact: kind === 'shape' && next() < 0.2 };
			}
			case 'array':
			case 'record':
				return { t: kind, of: schema(depth - 1, self, true) };
			case 'opt':
			case 'null':
			case 'msg':
				return { t: kind, of: schema(depth - 1, self, child) };
			case 'tuple':
				return {
					t: 'tuple',
					items: Array.from({ length: 1 + Math.floor(next() * 2) }, function (): Ast {
						return schema(depth - 1, self, true);
					})
				};
			case 'union':
			case 'inter':
				return { t: kind, members: [schema(depth - 1, self, child), schema(depth - 1, self, child)] };
			case 'disc':
				return {
					t: 'disc',
					variants: {
						x: { t: 'shape', fields: { [pick(keys)]: schema(depth - 1, self, true) }, exact: next() < 0.3 },
						y: { t: 'shape', fields: { [pick(keys)]: schema(depth - 1, self, true) }, exact: next() < 0.3 }
					}
				};
			case 'refine':
				return {
					t: 'refine',
					of: schema(depth - 1, self, child),
					pred: pick(['self', 'child', 'parse', 'simple', 'self', 'child'] as const),
					j: Math.floor(next() * count)
				};
			default:
				return reference(self, child);
		}
	}

	/**
	 * The first object property of a value.
	 * @param {unknown} value - The value
	 * @returns {unknown} Its first object property
	 */
	function firstChild(value: unknown): unknown {
		if (typeof value !== 'object' || value === null) return undefined;
		for (const key of Object.keys(value)) {
			const child = (value as Record<string, unknown>)[key];

			if (typeof child === 'object' && child !== null) return child;
		}

		return undefined;
	}

	/**
	 * Builds the guard of a schema.
	 * @param {Ast} node - The schema
	 * @returns {Guard<unknown>} The guard
	 */
	function build(node: Ast): Guard<unknown> {
		switch (node.t) {
			case 'int':
				return isInteger;
			case 'str':
				return isString;
			case 'lit':
				return isLiteral(node.v);
			case 'range':
				return isNumberInRange(0, 2);
			case 'oneOf':
				return isOneOf(['a', 'b', 3]);
			case 'len':
				return isStringOfLength(1, 1);
			case 'black':
				return function isBit(value: unknown): value is number {
					return value === 0 || value === 1;
				};
			case 'json':
				return isJsonValue;
			case 'shape':
			case 'match': {
				const fields: Record<string, unknown> = {};

				for (const key of Object.keys(node.fields)) {
					const field = node.fields[key];

					fields[key] = node.t === 'match' && field.t === 'lit' ? field.v : build(field);
				}

				return node.t === 'shape' ? isShape(fields as Record<string, Guard<unknown>>, { exact: node.exact }) : isMatching(fields);
			}
			case 'array':
				return isArrayOf(build(node.of));
			case 'record':
				return isRecordOf(build(node.of));
			case 'tuple':
				return isTuple(...node.items.map(build));
			case 'union':
				return isUnion(...node.members.map(build));
			case 'inter':
				return isIntersection(...node.members.map(build));
			case 'disc':
				return isDiscriminatedUnion('type', { x: build(node.variants.x), y: build(node.variants.y) });
			case 'opt':
				return isOptional(build(node.of));
			case 'null':
				return isNullable(build(node.of));
			case 'msg':
				return withMessage(build(node.of), 'labelled');
			case 'refine': {
				const { j, pred } = node;

				return refine(
					build(node.of),
					function (value: unknown): boolean {
						if (pred === 'simple') return !(typeof value === 'object' && value !== null && Object.keys(value).length === 3);

						const target = pred === 'self' ? value : firstChild(value);

						if (typeof target !== 'object' || target === null) return true;

						return pred === 'parse' ? safeParse(lazies[j], target)[0] === undefined : explain(lazies[j], target).length === 0;
					},
					pred === 'simple' ? undefined : 'nested failed'
				);
			}
			case 'lazy':
				return lazies[node.j];
		}
	}

	for (let index = 0; index < count; index++) definitions.push(schema(2 + Math.floor(next() * 2), index, false));
	for (let index = 0; index < count; index++) {
		let built: Guard<unknown> | undefined;

		lazies.push(
			isLazy(function () {
				return (built ??= build(definitions[index]));
			})
		);
	}

	// A value for the schema, mostly valid, reusing earlier objects of the same schema.
	const pools = new Map<Ast, object[]>();

	/**
	 * A value no schema expects.
	 * @returns {unknown} The value
	 */
	function junk(): unknown {
		return pick([1.5, 'zz', null, undefined, {}, [], { type: 'q' }, NaN, 7]);
	}

	/**
	 * Generates a value, possibly an earlier one.
	 * @param {Ast} node - The schema
	 * @param {number} depth - The remaining depth
	 * @returns {unknown} The value
	 */
	function generate(node: Ast, depth: number): unknown {
		if (next() < 0.06) return junk();

		const pool = pools.get(node);

		if (pool !== undefined && next() < 0.35) return pick(pool);

		const value = fresh(node, depth);

		if (typeof value === 'object' && value !== null) {
			if (pool === undefined) pools.set(node, [value]);
			else pool.push(value);
		}

		return value;
	}

	/**
	 * Generates a new value.
	 * @param {Ast} node - The schema
	 * @param {number} depth - The remaining depth
	 * @returns {unknown} The value
	 */
	function fresh(node: Ast, depth: number): unknown {
		switch (node.t) {
			case 'int':
			case 'range':
				return pick([0, 1, 2]);
			case 'str':
			case 'len':
				return pick(['a', 'b']);
			case 'lit':
				return node.v;
			case 'oneOf':
				return pick(['a', 'b', 3]);
			case 'black':
				return pick([0, 1]);
			case 'json':
				return next() < 0.5 ? [1, 'a'] : { j: [null] };
			case 'shape':
			case 'match': {
				const object: Record<string, unknown> = {};

				for (const key of Object.keys(node.fields)) if (next() >= 0.1) object[key] = generate(node.fields[key], depth - 1);
				if (next() < 0.1) object.extra = 1;

				return object;
			}
			case 'array':
				return Array.from({ length: depth <= 0 ? 0 : Math.floor(next() * 3) }, function (): unknown {
					return generate(node.of, depth - 1);
				});
			case 'record': {
				const object: Record<string, unknown> = {};

				for (let index = depth <= 0 ? 0 : Math.floor(next() * 3); index > 0; index--) object[pick(keys)] = generate(node.of, depth - 1);

				return object;
			}
			case 'tuple':
				return node.items.map(function (item: Ast): unknown {
					return generate(item, depth - 1);
				});
			case 'union':
				return generate(pick(node.members), depth);
			case 'inter': {
				const parts = node.members.map(function (member: Ast): unknown {
					return generate(member, depth);
				});

				return parts.every(isPlainObject) ? Object.assign({}, ...parts) : parts[0];
			}
			case 'disc': {
				const tag = pick(['x', 'y']);
				const object = generate(node.variants[tag], depth);

				return typeof object === 'object' && object !== null ? { type: next() < 0.05 ? 'z' : tag, ...object } : object;
			}
			case 'opt':
				return next() < 0.2 ? undefined : generate(node.of, depth);
			case 'null':
				return next() < 0.2 ? null : generate(node.of, depth);
			case 'msg':
			case 'refine':
				return generate(node.of, depth);
			case 'lazy':
				return depth <= 0 ? junk() : generate(definitions[node.j], depth - 1);
		}
	}

	const root = Math.floor(next() * count);
	const value = generate(definitions[root], 4 + Math.floor(next() * 4));

	// More sharing: random places point at objects held elsewhere (never at an ancestor: no cycles).
	const slots: Array<{ parent: Record<string, unknown>; key: string; value: unknown }> = [];
	const seen = new Set<unknown>();

	/**
	 * Lists the places of a value.
	 * @param {unknown} node - A value
	 * @returns {void}
	 */
	function collectSlots(node: unknown): void {
		if (typeof node !== 'object' || node === null || seen.has(node)) return;
		seen.add(node);
		for (const key of Object.keys(node)) {
			slots.push({ parent: node as Record<string, unknown>, key, value: (node as Record<string, unknown>)[key] });
			collectSlots((node as Record<string, unknown>)[key]);
		}
	}

	/**
	 * Whether `target` is reachable from `from`.
	 * @param {unknown} from - A value
	 * @param {unknown} target - An object
	 * @param {Set<unknown>} visited - The objects visited
	 * @returns {boolean} `true` when it is
	 */
	function reaches(from: unknown, target: unknown, visited: Set<unknown>): boolean {
		if (from === target) return true;
		if (typeof from !== 'object' || from === null || visited.has(from)) return false;
		visited.add(from);

		return Object.keys(from).some(function (key: string): boolean {
			return reaches((from as Record<string, unknown>)[key], target, visited);
		});
	}

	collectSlots(value);

	const objects = slots.filter(function (slot): boolean {
		return typeof slot.value === 'object' && slot.value !== null;
	});

	for (let merges = objects.length === 0 ? 0 : Math.floor(next() * 8); merges > 0; merges--) {
		const from = pick(objects);
		const to = pick(slots);

		if (!reaches(from.value, to.parent, new Set())) to.parent[to.key] = from.value;
	}

	return { guard: lazies[root], value };
}

describe('explain on values sharing objects (tree oracle)', function () {
	it('reports what the tree reports, with grounded pointers, for random recursive guards with nested explains', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), function (seed: number) {
				const { guard, value } = makeCase(seed);
				const tree = expand(value);
				const passed = guard(value);

				expect(guard(tree)).toBe(passed);

				const report = explain(guard, value);

				expect(report.length === 0).toBe(passed);
				expect(compareReports(value, report, explain(guard, tree))).toEqual([]);
				expect(explain(guard, value)).toEqual(report);

				// Through the validate module: each explain of a parse is an outermost one, so each place is reported in full.
				const [error] = safeParse(guard, value);

				expect(error?.issues ?? []).toEqual(report);

				const [pairError] = safeParse(arrayOf(guard), [value, value]);
				const twice = [0, 1].flatMap(function (index: number): SchemaIssue[] {
					return report.map(function (issue: SchemaIssue): SchemaIssue {
						return { message: issue.message, path: [index, ...issue.path] };
					});
				});

				expect(pairError?.issues ?? []).toEqual(twice);

				const [lazyError] = safeParse(
					lazy(function () {
						return { first: guard, second: optional(guard) };
					}),
					{ first: value, second: value }
				);
				const both = ['first', 'second'].flatMap(function (key: string): SchemaIssue[] {
					return key === 'second' && value === undefined
						? []
						: report.map(function (issue: SchemaIssue): SchemaIssue {
								return { message: issue.message, path: [key, ...issue.path] };
							});
				});

				expect(lazyError?.issues ?? []).toEqual(both);

				// Held twice by an outer shape: compared with the tree too.
				const outer = isShape({ p: guard, q: guard });

				expect(compareReports({ p: value, q: value }, explain(outer, { p: value, q: value }), explain(outer, { p: tree, q: expand(value) }))).toEqual([]);
			}),
			{ numRuns: 400 }
		);
	});

	it('reports what the tree reports for JSON values sharing containers, and walks a cycle to an end', function () {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), function (seed: number) {
				const next = random(seed);
				const containers: object[] = [];

				/**
				 * Picks an element.
				 * @template T - The element type
				 * @param {ReadonlyArray<T>} list - The elements
				 * @returns {T} One of them
				 */
				function pick<T>(list: ReadonlyArray<T>): T {
					return list[Math.floor(next() * list.length)];
				}

				/**
				 * Generates a value, often holding earlier containers again.
				 * @param {number} depth - The remaining depth
				 * @returns {unknown} The value
				 */
				function generate(depth: number): unknown {
					const roll = next();

					if (depth <= 0 || roll < 0.35) return pick([1, 'a', null, true, -0, 2.5, NaN, undefined, Infinity, new Date(0)]);
					if (containers.length > 0 && roll < 0.5) return pick(containers);

					let container: object;

					if (next() < 0.5) {
						const array = Array.from({ length: Math.floor(next() * 4) }, function (): unknown {
							return generate(depth - 1);
						});

						if (next() < 0.05) array.length++;
						container = array;
					} else {
						const object: Record<string, unknown> = {};

						for (let index = Math.floor(next() * 4); index > 0; index--) object[pick(['a', 'b', 'c'])] = generate(depth - 1);
						container = object;
					}
					if (next() < 0.1) {
						// A large container of primitives.
						container = Array.from({ length: 20 }, function (_: unknown, index: number): unknown {
							return index === 7 && next() < 0.5 ? NaN : index;
						});
					}
					containers.push(container);

					return container;
				}

				const value = generate(2 + Math.floor(next() * 6));

				for (const guard of [isJsonValue, isJsonObject, isJsonArray]) {
					const tree = expand(value);
					const passed = guard(value);

					expect(guard(tree)).toBe(passed);

					const report = explain(guard, value);

					expect(report.length === 0).toBe(passed);
					expect(compareReports(value, report, explain(guard, tree))).toEqual([]);

					const outer = isShape({ p: guard, q: isIntersection(guard, guard) });

					expect(compareReports({ p: value, q: value }, explain(outer, { p: value, q: value }), explain(outer, { p: tree, q: expand(value) }))).toEqual([]);
				}
				if (containers.length > 1) {
					const from = pick(containers);
					const to = pick(containers);

					if (Array.isArray(from)) from.push(to);
					else (from as Record<string, unknown>).z = to;
					// A cycle: rejected, and reported as one (or as a pointer to where it was).
					if (!isJsonValue(value)) expect(explain(isJsonValue, value).length).toBeGreaterThan(0);
				}
			}),
			{ numRuns: 400 }
		);
	});

	it('grows linearly on chains and shared values when guards explain at random levels, through every entry point', function () {
		let calls = 0;

		/**
		 * The id check, counting its calls.
		 * @param {unknown} value - The value
		 * @returns {boolean} Whether it is an integer
		 */
		function isId(value: unknown): value is number {
			calls++;

			return Number.isInteger(value);
		}

		const next = random(7);
		const marked = new Map<unknown, boolean>();

		/**
		 * Whether the guards explain at the level of `value` (about half of them).
		 * @param {unknown} value - A node
		 * @returns {boolean} `true` at a marked level
		 */
		function explainsAt(value: unknown): boolean {
			const id = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined;

			if (!marked.has(id)) marked.set(id, next() < 0.5);

			return marked.get(id) as boolean;
		}

		const isAfter: Guard<unknown> = isLazy(function () {
			return refine(isShape({ id: isId, a: isOptional(isAfter), b: isOptional(isAfter) }), function (value) {
				return !explainsAt(value) || value.a === undefined || explain(isAfter, value.a).length === 0;
			});
		});
		const isTop: Guard<unknown> = isLazy(function () {
			return refine(isShape({ id: isId, a: isOptional(isPlainObject), b: isOptional(isPlainObject) }), function (value) {
				return (value.a === undefined || (explainsAt(value) ? explain(isTop, value.a).length === 0 : isTop(value.a))) && (value.b === undefined || isTop(value.b));
			});
		});
		const isFirst: Guard<unknown> = isLazy(function () {
			return isShape({
				c: isOptional(function (value: unknown): value is object {
					return !explainsAt(value) || explain(isFirst, value).length === 0;
				}),
				id: isId,
				a: isOptional(isFirst),
				b: isOptional(isFirst)
			});
		});
		const isParsed: Guard<unknown> = isLazy(function () {
			return isShape({
				c: isOptional(function (value: unknown): value is object {
					return !explainsAt(value) || safeParse(isParsed, value)[0] === undefined;
				}),
				id: isId,
				a: isOptional(isParsed),
				b: isOptional(isParsed)
			});
		});
		const runs: Array<(guard: Guard<unknown>, value: unknown) => unknown> = [
			explain,
			function (guard: Guard<unknown>, value: unknown): unknown {
				return guard(value);
			},
			safeParse,
			function (guard: Guard<unknown>, value: unknown): unknown {
				return safeParse(arrayOf(guard), [value, value]);
			},
			function (guard: Guard<unknown>, value: unknown): unknown {
				return explain(isShape({ p: guard, q: guard }), { p: value, q: value });
			}
		];

		const superlinear: string[] = [];

		for (const [name, guard] of Object.entries({ isAfter, isTop, isFirst, isParsed })) {
			for (const shared of [false, true]) {
				for (const [index, run] of runs.entries()) {
					const counts = [200, 400].map(function (length: number): number {
						// A chain, or each level holding the next one three times (3^length paths); the last level is invalid.
						let node: Record<string, unknown> = { id: 'x' };

						for (let id = length; id > 0; id--) node = shared ? { id, a: node, b: node, c: node } : { id, a: node, c: node };
						calls = 0;
						run(guard, node);

						return calls;
					});

					if (counts[1] > 2.1 * counts[0]) superlinear.push(`${name} ${shared ? 'shared' : 'chain'} run ${index}: ${counts.join(' -> ')}`);
				}
			}
		}
		expect(superlinear).toEqual([]);
	});
});
