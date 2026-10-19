import fc from 'fast-check';
import { explain, isFiniteNumber, isLiteral, isShape, isString, issuesByPath } from '../guards/index.js';
import { arrayOf, asArray, asInteger, asNumber, blankAsUndefined, discriminatedUnion, exact, lazy, optional, recordOf, safeParse, union, type Parser, type Schema } from '.';

const anything = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withNullPrototype: true });
const numberish = fc.oneof(fc.integer().map(String), fc.double().map(String), fc.integer(), fc.constantFrom('', ' 7 ', 'x', '1e3', '-0'), anything);

/**
 * Parses `value` and returns `{ ok, value }`, so results compare structurally.
 * @param {Schema} schema - The schema
 * @param {unknown} value - The value
 * @returns {{ ok: boolean; value: unknown }} The outcome
 */
function outcome(schema: Schema, value: unknown): { ok: boolean; value: unknown } {
	const [error, output] = safeParse(schema, value);

	return { ok: error === undefined, value: output };
}

describe('combinators (properties)', function () {
	it('union returns the output of the first member that accepts the value', function () {
		const members: Schema[] = [asInteger, asNumber, isString];

		fc.assert(
			fc.property(numberish, function (value) {
				const first = members
					.map(function (member) {
						return outcome(member, value);
					})
					.find(function (result) {
						return result.ok;
					});

				expect(outcome(union(...members), value)).toEqual(first ?? { ok: false, value: undefined });
			})
		);
	});

	it('discriminatedUnion is equivalent to the union of its variants with the tag checked first', function () {
		const variants = { a: { x: asInteger }, b: { y: isString, z: optional(asNumber) } };
		const fast = discriminatedUnion('type', variants);
		const naive = union({ type: isLiteral('a'), ...variants.a }, { type: isLiteral('b'), ...variants.b });
		const candidate = fc.oneof(
			fc.record(
				{ type: fc.oneof(fc.constantFrom('a', 'b', 'c', 'toString'), anything), x: numberish, y: fc.oneof(fc.string(), anything), z: numberish, w: anything },
				{ requiredKeys: [] }
			),
			anything
		);

		fc.assert(
			fc.property(candidate, function (value) {
				expect(outcome(fast, value)).toEqual(outcome(naive, value));
			})
		);
	});

	it('asArray parses a defined non-array value like a one-element array', function () {
		fc.assert(
			fc.property(fc.oneof(numberish, fc.array(numberish, { maxLength: 4 })), function (value) {
				if (value === undefined) return;
				expect(outcome(asArray(asInteger), value)).toEqual(outcome(arrayOf(asInteger), Array.isArray(value) ? value : [value]));
			})
		);
	});

	it('exact accepts exactly the values its object schema accepts that have no unknown own keys', function () {
		const schema = { x: asNumber, label: optional(isString) };
		const keys = new Set(Object.keys(schema));

		fc.assert(
			fc.property(fc.oneof(fc.record({ x: numberish, label: fc.oneof(fc.string(), anything), extra: anything }, { requiredKeys: [] }), anything), function (value) {
				const unknown =
					typeof value === 'object' &&
					value !== null &&
					Object.keys(value).some(function (key) {
						return !keys.has(key);
					});
				const plain = outcome(schema, value);

				expect(outcome(exact(schema), value)).toEqual(plain.ok && !unknown ? plain : { ok: false, value: undefined });
			})
		);
	});

	it('recordOf parses every own key with the value schema, keeping the key order', function () {
		fc.assert(
			fc.property(fc.dictionary(fc.string({ maxLength: 4 }), numberish, { maxKeys: 6 }), function (dictionary) {
				const entries = Object.keys(dictionary).map(function (key) {
					return [key, outcome(asInteger, dictionary[key])] as const;
				});
				const result = outcome(recordOf(asInteger), dictionary);

				expect(result.ok).toBe(
					entries.every(function ([, entry]) {
						return entry.ok;
					})
				);
				if (result.ok) {
					expect(Object.keys(result.value as object)).toEqual(Object.keys(dictionary));
					for (const [key, entry] of entries) expect(Object.getOwnPropertyDescriptor(result.value, key)?.value).toBe(entry.value);
				}
			})
		);
	});

	it('lazy parses random finite trees into equal trees without their unknown keys', function () {
		type Tree = { value: number; children: Tree[] };
		const tree: Parser<Tree> = lazy(function () {
			return { value: asNumber, children: arrayOf(tree) };
		});
		const { node } = fc.letrec(function (arbitrary) {
			return {
				node: fc.record(
					{
						value: fc.integer(),
						// Bounded depth: the first alternative (a leaf) is taken once the depth is reached.
						children: fc.oneof({ maxDepth: 4, depthIdentifier: 'tree' }, fc.constant([]), fc.array(arbitrary('node'), { maxLength: 3 })),
						extra: fc.string()
					},
					{ requiredKeys: ['value', 'children'] }
				)
			};
		});

		/**
		 * Removes the unknown keys from a generated tree.
		 * @param {{ value: number; children: unknown[] }} input - The generated tree
		 * @returns {Tree} The tree the parser should return
		 */
		function expected(input: { value: number; children: unknown[] }): Tree {
			return { value: input.value, children: input.children.map(expected as (value: unknown) => Tree) };
		}

		fc.assert(
			fc.property(node, function (input) {
				expect(outcome(tree, input)).toEqual({ ok: true, value: expected(input as { value: number; children: unknown[] }) });
			})
		);
	});

	it('blankAsUndefined(optional(schema)) is undefined for blank strings and the schema otherwise', function () {
		fc.assert(
			fc.property(fc.oneof(fc.constantFrom('', ' ', '\t\n', ' '), numberish), function (value) {
				const blank = typeof value === 'string' && value.trim() === '';

				expect(outcome(blankAsUndefined(optional(asInteger)), value)).toEqual(blank ? { ok: true, value: undefined } : outcome(optional(asInteger), value));
			})
		);
	});

	it('issuesByPath keeps every message once, grouped by path in their original order', function () {
		const isRecord = isShape({ a: isFiniteNumber, b: isShape({ c: isString, d: isFiniteNumber }) });

		fc.assert(
			fc.property(anything, function (value) {
				const issues = explain(isRecord, value);
				const grouped = issuesByPath(issues);
				const flattened = issues.map(function (issue) {
					return issue.path.join('.');
				});

				expect(
					Object.values(grouped).reduce(function (total, messages) {
						return total + messages.length;
					}, 0)
				).toBe(issues.length);
				for (const key of Object.keys(grouped)) {
					expect(grouped[key]).toEqual(
						issues
							.filter(function (_, index) {
								return flattened[index] === key;
							})
							.map(function (issue) {
								return issue.message;
							})
					);
				}
			})
		);
	});
});
