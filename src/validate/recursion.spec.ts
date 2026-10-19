import { explain, isInteger, isLazy, isLiteral, isMatching, isNumber, isShape, isString, isUnion, issuesByPath, type Guard, type SchemaIssue } from '../guards/index.js';
import {
	arrayOf,
	asInteger,
	blankAsUndefined,
	chain,
	discriminatedUnion,
	lazy,
	nullable,
	optional,
	parse,
	recordOf,
	safeParse,
	transform,
	union,
	withDefault,
	type Parser,
	type Schema,
	type SchemaOutput
} from '.';

/**
 * Returns the issues `schema` reports for `value` (empty when it parses).
 * @param {Schema} schema - The schema
 * @param {unknown} value - The value
 * @returns {ReadonlyArray<SchemaIssue>} The issues
 */
function issuesOf(schema: Schema, value: unknown): ReadonlyArray<SchemaIssue> {
	const [error] = safeParse(schema, value);

	return error === undefined ? [] : error.issues;
}

/**
 * Builds `and` conditions nested `depth` deep around a leaf.
 * @param {number} depth - The depth
 * @param {unknown} leaf - The innermost condition
 * @returns {unknown} The condition
 */
function nested(depth: number, leaf: unknown): unknown {
	let condition = leaf;

	for (let level = 0; level < depth; level++) condition = { type: 'and', args: [condition] };

	return condition;
}

describe('recursive unions on invalid input', function () {
	let calls = 0;

	/**
	 * A string guard that counts its calls.
	 * @param {unknown} value - The value
	 * @returns {boolean} Whether `value` is a string
	 */
	function isCountedString(value: unknown): value is string {
		calls++;

		return typeof value === 'string';
	}

	beforeEach(function () {
		calls = 0;
	});

	it('should report in linear time, not exponential', function () {
		const condition: Parser<unknown> = lazy(function () {
			return union(
				{ type: isLiteral('eq'), field: isCountedString, value: isCountedString },
				{ type: isLiteral('and'), args: arrayOf(condition) },
				{ type: isLiteral('or'), args: arrayOf(condition) }
			);
		});
		const input = nested(20, { type: 'eq', field: 'a', value: 1 });

		expect(issuesOf(condition, input)).toEqual([
			{
				message: 'Invalid value (got number)',
				path: [
					...Array.from({ length: 20 }).flatMap(function () {
						return ['args', 0];
					}),
					'value'
				]
			}
		]);
		expect(calls).toBeLessThan(500);
		expect(parse(condition, nested(20, { type: 'eq', field: 'a', value: 'b' }))).toEqual(nested(20, { type: 'eq', field: 'a', value: 'b' }));
	});

	it('should explain guard unions in linear time, not exponential', function () {
		const isCondition: Guard<unknown> = isLazy(function () {
			return isUnion(
				isShape({ type: isLiteral('eq'), field: isCountedString, value: isCountedString }),
				isShape({ type: isLiteral('and'), args: arrayOfGuard(isCondition) }),
				isShape({ type: isLiteral('or'), args: arrayOfGuard(isCondition) })
			);
		});

		expect(explain(isCondition, nested(20, { type: 'eq', field: 'a', value: 1 }))).toHaveLength(1);
		expect(calls).toBeLessThan(2000);
	});

	it('should report the member with the fewest failing primitive properties', function () {
		const member = union({ kind: isLiteral('a'), x: asInteger }, { kind: isLiteral('b'), y: asInteger, z: asInteger }, isString);

		expect(issuesOf(member, { kind: 'b', y: '1', z: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['z'] }]);
		expect(issuesOf(member, 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(issuesOf(member, { kind: 'a', x: { nested: true } })).toEqual([{ message: 'Expected an integer or an integer string (got object)', path: ['x'] }]);
		expect(issuesOf(union(discriminatedUnion('t', { a: { n: asInteger } }), { u: asInteger }), { t: 'b', u: 'x' })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['u'] }
		]);
		expect(issuesOf(union({ u: asInteger }, discriminatedUnion('t', { a: { n: asInteger } })), { t: 'a', n: 'x', u: 'x' })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['n'] }
		]);
		expect(issuesOf(union(isString, discriminatedUnion('t', { a: { n: asInteger } })), [])).toEqual([{ message: 'Invalid value (got object)', path: [] }]);
		expect(issuesOf(union(isNumber, blankAsUndefined({ n: asInteger })), '  ')).toEqual([{ message: 'Invalid value (got string)', path: [] }]);
		expect(
			issuesOf(
				union(
					isNumber,
					lazy(function () {
						return { n: asInteger };
					})
				),
				{ n: 'x' }
			)
		).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['n'] }]);
	});

	it('should score nested unions, lazy guards and non-blank values', function () {
		expect(issuesOf(union(isNumber, union(isString, { n: asInteger })), { n: 'x' })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['n'] }
		]);
		expect(issuesOf(union(isNumber, blankAsUndefined({ n: asInteger })), { n: 'x' })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['n'] }
		]);
		expect(
			explain(
				isUnion(
					isNumber,
					isLazy(function () {
						return isShape({ n: isInteger });
					})
				),
				{ n: 'x' }
			)
		).toEqual([{ message: 'Invalid value (got string)', path: ['n'] }]);
	});

	it('should check shapes that keep the key-by-key loop (symbol keys, exact shapes of class instances)', function () {
		const key = Symbol('k');
		const isTagged = isMatching({ [key]: 1 });

		class Point {
			x = 1;
			y = 2;
		}

		expect(isTagged(5)).toBe(false);
		expect(isTagged({ [key]: 1 })).toBe(true);
		expect(isShape({ x: isNumber }, { exact: true })(new Point())).toBe(false);
		expect(isShape({ x: isNumber, y: isNumber }, { exact: true })(new Point())).toBe(true);
	});

	it('should report the closest guard of a guard union, after checking the valid members', function () {
		const isFigure = isUnion(isShape({ kind: isLiteral('circle'), r: isNumber }), isShape({ kind: isLiteral('square'), side: isNumber }), isString);

		expect(explain(isFigure, { kind: 'square', side: 'x' })).toEqual([{ message: 'Invalid value (got string)', path: ['side'] }]);
		expect(explain(isFigure, [1])).toEqual([{ message: 'Invalid value (got object)', path: [] }]);
		expect(explain(isShape({ id: isUnion(isString, isInteger) }), { id: 1 })).toEqual([]);
		expect(explain(isUnion(isShape({ a: isNumber }), isShape({ a: isString, b: isString })), { a: 'x' })).toEqual([{ message: 'Missing required property', path: ['b'] }]);
	});
});

/**
 * The guards module's `isArrayOf`, imported under another name to keep the parser `arrayOf` readable above.
 * @param {Guard<unknown>} guard - The element guard
 * @returns {Guard<unknown[]>} The array guard
 */
function arrayOfGuard(guard: Guard<unknown>): Guard<unknown[]> {
	return function isArray(value: unknown): value is unknown[] {
		return Array.isArray(value) && value.every(guard);
	};
}

describe('lazy inside wrappers', function () {
	it('should not resolve the schema while it is being defined', function () {
		type Tree = { v: number; next?: Tree | null };
		const getter = jest.fn(function (): Schema {
			return tree;
		});
		const tree: Schema = { v: isNumber, next: optional(nullable(lazy(getter))) };
		const wrapped = [union(isNumber, lazy(getter)), transform(lazy(getter), String), chain(lazy(getter), isString), blankAsUndefined(lazy(getter))];

		expect(getter).not.toHaveBeenCalled();
		expect(wrapped).toHaveLength(4);

		const parsed: SchemaOutput<typeof tree> = parse(tree, { v: 1, next: { v: 2, next: null } });
		const typed: Tree = parsed as Tree;

		expect(typed).toEqual({ v: 1, next: { v: 2, next: null } });
		expect(issuesOf(tree, { v: 1, next: { v: 'x' } })).toEqual([{ message: 'Invalid value (got string)', path: ['next', 'v'] }]);
	});

	it('should forward missing values and defaults through lazy', function () {
		const field = lazy(function () {
			return blankAsUndefined(optional(isString));
		});
		const level = chain(
			lazy(function () {
				return withDefault(asInteger, 5);
			}),
			isLiteral(10)
		);

		expect(parse({ a: field }, { a: ' ' })).toEqual({});
		expect(issuesOf({ level }, {})).toEqual([{ message: 'Expected 10 (got 5)', path: ['level'] }]);
	});
});

describe('blank values through wrappers', function () {
	const blankString = blankAsUndefined(optional(isString));

	it('should count a blank value as missing whatever wraps it', function () {
		for (const field of [blankString, union(blankString, isNumber), nullable(blankString), transform(blankString, String), chain(blankString, optional(isString))]) {
			const parsed = parse({ a: field }, { a: ' ' }) as Record<string, unknown>;

			expect(Object.keys(parsed).length === 0 || parsed.a === 'undefined').toBe(true);
		}
		expect(issuesOf({ a: union(blankAsUndefined(isString), isNumber) }, { a: ' ' })).toEqual([{ message: 'Missing required property', path: ['a'] }]);
	});

	it('should let optional and withDefault wrap a blank-aware schema in either order', function () {
		expect(parse({ a: optional(blankAsUndefined(isString)) }, { a: '' })).toEqual({});
		expect(parse({ a: withDefault(blankAsUndefined(asInteger), 7) }, { a: '  ' })).toEqual({ a: 7 });
		expect(parse({ a: blankAsUndefined(withDefault(asInteger, 7)) }, { a: '  ' })).toEqual({ a: 7 });
		expect(parse(recordOf(withDefault(blankAsUndefined(asInteger), 0)), { a: '', b: '2' })).toEqual({ a: 0, b: 2 });
	});
});

describe('issuesByPath with Standard Schema issues', function () {
	it('should flatten { key } segments and group issues without a path at the root', function () {
		expect(issuesByPath([{ message: 'a', path: [{ key: 'user' }, { key: 0 }, 'name'] }, { message: 'b' }, { message: 'c', path: undefined }])).toEqual({
			'user.0.name': ['a'],
			'': ['b', 'c']
		});
	});
});

describe('discriminated variants that list the tag', function () {
	it('should type the tag as the variant name', function () {
		const event = discriminatedUnion('type', { a: { type: asInteger, x: isNumber }, b: { y: isString } });
		const a: SchemaOutput<typeof event> = { type: 'a', x: 1 };

		expect(parse(event, { type: 'a', x: 1 })).toEqual(a);
	});
});
