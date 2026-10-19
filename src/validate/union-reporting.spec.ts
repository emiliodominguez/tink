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
import { asInteger, blankAsUndefined, discriminatedUnion, exact, lazy, optional, parse, partial, safeParse, transform, union, withDefault, type Parser, type Schema } from '.';

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

describe('missing values in unions', function () {
	it('should parse a valid value once, transforms included', function () {
		let runs = 0;
		const doubled = transform(isNumber, function (value: number): number {
			runs++;

			return value * 2;
		});

		expect(parse(withDefault(union(doubled, blankAsUndefined(isString)), 0), 5)).toBe(10);
		expect(parse(optional(union(doubled, blankAsUndefined(isString))), 5)).toBe(10);
		expect(runs).toBe(2);
		expect(parse(withDefault(union(doubled, blankAsUndefined(isString)), 0), ' ')).toBe(0);
		expect(parse(optional(union(isString, blankAsUndefined(asInteger))), '')).toBe('');
	});

	it('should parse an optional recursive union in linear time', function () {
		let runs = 0;
		const tagOf = transform(isLiteral('b'), function (tag: 'b'): 'b' {
			runs++;

			return tag;
		});
		type Link = { tag: 'a' | 'b'; next?: Link };
		const link: Parser<Link> = union(
			lazy<Link>(function () {
				return { tag: isLiteral('a'), next: optional(link) };
			}),
			lazy<Link>(function () {
				return { tag: tagOf, next: withDefault(link, { tag: 'a' }) };
			})
		);
		let value: Link = { tag: 'a' };

		for (let level = 0; level < 300; level++) value = { tag: 'b', next: value };

		expect(parse(link, value)).toEqual(value);
		expect(runs).toBe(300);
	});
});

describe('scores of nested unions and wrong tags', function () {
	it('should report the closest member of a nested guard union', function () {
		const isEvent = isUnion(
			isShape({ kind: isLiteral('x'), n: isNumber }),
			isUnion(isShape({ type: isLiteral('a'), x: isNumber, y: isNumber }), isShape({ type: isLiteral('b'), s: isString }))
		);

		expect(explain(isEvent, { type: 'b', s: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['s'] }]);
		expect(issuesOf(union(isNumber, isEvent), { type: 'b', s: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['s'] }]);
	});

	it('should report the allowed tags of a wrong tag before a member that rejects objects', function () {
		const isTagged = isDiscriminatedUnion('type', { a: isShape({ n: isNumber }) });
		const tagged = discriminatedUnion('type', { a: { n: isNumber } });
		const tags = [{ message: 'Expected "a" (got string)', path: ['type'] }];

		expect(explain(isUnion(isTagged, isString), { type: 'z' })).toEqual(tags);
		expect(issuesOf(union(tagged, isString), { type: 'z' })).toEqual(tags);
		expect(explain(isUnion(isString, isTagged), 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(issuesOf(union(isString, tagged), 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
	});
});

describe('object schemas with a ~tink.1 key', function () {
	it('should stay object schemas', function () {
		const schema = { '~tink.1': { fast: isNumber, run: isNumber } };

		expect(parse(schema, { '~tink.1': { fast: 1, run: 2 } })).toEqual({ '~tink.1': { fast: 1, run: 2 } });
		expect(issuesOf(schema, false)).toEqual([{ message: 'Expected an object (got boolean)', path: [] }]);
	});
});
