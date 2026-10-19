import {
	explain,
	isDiscriminatedUnion,
	isIntersection,
	isLiteral,
	isNullable,
	isNumber,
	isOptional,
	isShape,
	isString,
	isUnion,
	refine,
	withMessage,
	type SchemaIssue
} from '../guards/index.js';
import { asInteger, blankAsUndefined, exact, optional, parse, partial, safeParse, union, withDefault, type Schema } from '.';

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

describe('blank values in unions', function () {
	const stringOrBlankNumber = union(isString, blankAsUndefined(asInteger));

	it('should keep a blank string that an earlier member accepts', function () {
		expect(safeParse(stringOrBlankNumber, '')).toEqual([undefined, '']);
		expect(safeParse(optional(stringOrBlankNumber), '')).toEqual([undefined, '']);
		expect(safeParse(withDefault(stringOrBlankNumber, 'default'), '')).toEqual([undefined, '']);
		expect(parse({ f: optional(stringOrBlankNumber) }, { f: '' })).toEqual({ f: '' });
		expect(parse(partial({ f: stringOrBlankNumber }), { f: '' })).toEqual({ f: '' });
	});

	it('should count a blank string as missing when the winning member does', function () {
		expect(parse({ a: union(blankAsUndefined(optional(isString)), isNumber) }, { a: ' ' })).toEqual({});
		expect(parse({ a: optional(union(isNumber, blankAsUndefined(asInteger))) }, { a: ' ' })).toEqual({});
		expect(issuesOf({ a: union(isNumber, blankAsUndefined(asInteger)) }, { a: ' ' })).toEqual([{ message: 'Missing required property', path: ['a'] }]);
	});
});

describe('the closest member through wrappers', function () {
	const a = { type: isLiteral('a'), x: isNumber };
	const b = { type: isLiteral('b'), y: isString };
	const value = { type: 'b', y: 1 };
	const expected = [{ message: 'Invalid value (got number)', path: ['y'] }];

	it('should score exact object schemas and guards nested in parse schemas', function () {
		expect(issuesOf(union(exact(a), exact(b)), value)).toEqual(expected);
		expect(issuesOf(union(isShape(a), isShape(b)), value)).toEqual(expected);
	});

	it('should score the wrapper guards of the guards module', function () {
		const isA = isShape(a);
		const isB = isShape(b);
		/**
		 * Accepts everything.
		 * @returns {boolean} `true`
		 */
		function always(): boolean {
			return true;
		}

		expect(explain(isUnion(isNullable(isA), isNullable(isB)), value)).toEqual(expected);
		expect(explain(isUnion(isOptional(isA), isOptional(isB)), value)).toEqual(expected);
		expect(explain(isUnion(withMessage(isA, 'not a'), withMessage(isB, 'not b')), value)).toEqual([{ message: 'not b', path: [] }]);
		expect(explain(isUnion(refine(isA, always), refine(isB, always)), value)).toEqual(expected);
		expect(explain(isUnion(isIntersection(isA, isShape({})), isIntersection(isB, isShape({}))), value)).toEqual(expected);
		expect(explain(isUnion(isDiscriminatedUnion('type', { a: isShape({ x: isNumber }) }), isDiscriminatedUnion('type', { b: isShape({ y: isString }) })), value)).toEqual(
			expected
		);
		expect(explain(isUnion(isNumber, isDiscriminatedUnion('type', { b: isShape({ y: isString }) })), [])).toEqual([{ message: 'Invalid value (got object)', path: [] }]);
	});

	it('should prefer a refinement whose base guard accepts the value', function () {
		const isEven = refine(
			isNumber,
			function (n: number): boolean {
				return n % 2 === 0;
			},
			'Expected an even number'
		);

		expect(explain(isUnion(isString, isEven), 3)).toEqual([{ message: 'Expected an even number', path: [] }]);
		expect(explain(isUnion(isNullable(isString), isOptional(isEven)), 3)).toEqual([{ message: 'Expected an even number', path: [] }]);
	});
});

describe('parsers of other versions of this module', function () {
	it('should be used through ~standard when their node key is not this version', function () {
		const legacy = {
			'~tink': { fast: String, run: String, guard: undefined, handlesMissing: true },
			'~standard': {
				version: 1 as const,
				vendor: 'tink',
				validate: function (value: unknown) {
					return typeof value === 'number' ? { value: value * 2 } : { issues: [{ message: 'not a number' }] };
				}
			}
		};

		expect(parse({ n: legacy }, { n: 2 })).toEqual({ n: 4 });
		expect(issuesOf({ n: legacy }, { n: 'x' })).toEqual([{ message: 'not a number', path: ['n'] }]);
	});
});
