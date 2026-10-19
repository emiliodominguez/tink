import { isNumber, isOneOf, isShape, isString, type SchemaIssue } from '../guards/index.js';
import {
	arrayOf,
	asBigInt,
	asInteger,
	asList,
	blankAsUndefined,
	check,
	isEmail,
	isSlug,
	isUrl,
	optional,
	parse,
	safeParse,
	union,
	withDefault,
	withError,
	withFallback,
	type Parser,
	type Schema
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

describe('withFallback', function () {
	it('should return the output of valid values, and the fallback for rejected and missing ones', function () {
		const query = { page: withFallback(asInteger, 1), sort: withFallback(isOneOf(['new', 'top']), 'new') };

		expect(parse(query, { page: '3', sort: 'top' })).toEqual({ page: 3, sort: 'top' });
		expect(parse(query, { page: 'last', sort: 'random' })).toEqual({ page: 1, sort: 'new' });
		expect(parse(query, {})).toEqual({ page: 1, sort: 'new' });
		expect(issuesOf(query, { page: [] })).toEqual([]);
	});

	it('should call a function fallback for every rejected value', function () {
		const tags = withFallback(arrayOf(isString), function (): string[] {
			return [];
		});
		const first = parse(tags, 1);

		expect(first).toEqual([]);
		expect(parse(tags, 1)).not.toBe(first);
		expect(parse(tags, ['a'])).toEqual(['a']);
	});

	it('should win a union, since it accepts everything', function () {
		expect(parse(union(withFallback(asInteger, 0), isString), 'x')).toBe(0);
	});

	it('should reject what is not a schema', function () {
		expect(function () {
			withFallback(1 as unknown as Schema, 0);
		}).toThrow(TypeError);
	});
});

describe('check', function () {
	const signUp = check(
		{ password: isString, confirm: isString },
		function (form: { password: string; confirm: string }): boolean {
			return form.password === form.confirm;
		},
		'Passwords do not match',
		['confirm']
	);

	it('should return the output when the predicate accepts it', function () {
		expect(parse(signUp, { password: 'a', confirm: 'a', extra: 1 })).toEqual({ password: 'a', confirm: 'a' });
	});

	it('should report the message at the path when the predicate rejects the output', function () {
		expect(issuesOf(signUp, { password: 'a', confirm: 'b' })).toEqual([{ message: 'Passwords do not match', path: ['confirm'] }]);
		expect(issuesOf({ form: signUp }, { form: { password: 'a', confirm: 'b' } })).toEqual([{ message: 'Passwords do not match', path: ['form', 'confirm'] }]);
	});

	it('should report the issues of the schema instead when it rejects the value', function () {
		expect(issuesOf(signUp, { password: 'a' })).toEqual([{ message: 'Missing required property', path: ['confirm'] }]);
	});

	it('should check outputs, with a default message at the value itself', function () {
		const even = check(asInteger, function (value: number): boolean {
			return value % 2 === 0;
		});

		expect(parse(even, '42')).toBe(42);
		expect(issuesOf(even, '41')).toEqual([{ message: 'Invalid value', path: [] }]);
	});

	it('should forward missing values to the schema', function () {
		const nickname = check(optional(blankAsUndefined(isString)), function (value: string | undefined): boolean {
			return value === undefined || value.length > 1;
		});

		expect(parse({ nickname }, {})).toEqual({});
		expect(parse({ nickname }, { nickname: ' ' })).toEqual({});
		expect(issuesOf({ nickname }, { nickname: 'a' })).toEqual([{ message: 'Invalid value', path: ['nickname'] }]);
	});

	it('should count a value that only fails the predicate as the closest member of a union', function () {
		const positive = check({ n: isNumber }, function (value: { n: number }): boolean {
			return value.n > 0;
		});
		const named = isShape({ name: isString, n: isString });

		expect(issuesOf(union(named, positive), { n: -1 })).toEqual([{ message: 'Invalid value', path: [] }]);
		expect(issuesOf(union(positive, named), { n: 'x' })).toEqual([{ message: 'Missing required property', path: ['name'] }]);
	});

	it('should reject a predicate, message or path of the wrong type', function () {
		expect(function () {
			check(isString, 1 as unknown as () => boolean);
		}).toThrow('check: `predicate` must be a function, got number');
		expect(function () {
			check(isString, Boolean, 1 as unknown as string);
		}).toThrow('check: `message` must be a string, got number');
		expect(function () {
			check(isString, Boolean, 'x', 'a' as unknown as string[]);
		}).toThrow('check: `path` must be an array, got string');
	});
});

describe('asList', function () {
	it('should split, trim and parse every item, dropping empty items', function () {
		expect(parse(asList(isUrl), 'https://a.com, https://b.com')).toEqual(['https://a.com', 'https://b.com']);
		expect(parse(asList(asInteger), ' 80 ,443,, ')).toEqual([80, 443]);
		expect(parse(asList(asInteger), '')).toEqual([]);
		expect(parse(asList(isSlug, ' '), 'ts  js')).toEqual(['ts', 'js']);
	});

	it('should parse an array element by element, without splitting', function () {
		expect(parse(asList(asInteger), ['1', 2])).toEqual([1, 2]);
		expect(issuesOf(asList(isSlug), ['a,b'])).toEqual([{ message: 'Invalid value (got string)', path: [0] }]);
	});

	it('should report items at their index, and other values at the list', function () {
		expect(issuesOf(asList(asInteger), '1,two')).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: [1] }]);
		expect(issuesOf({ ports: asList(asInteger) }, {})).toEqual([{ message: 'Missing required property', path: ['ports'] }]);
		expect(issuesOf(asList(asInteger), 80)).toEqual([{ message: 'Expected a list string or an array (got number)', path: [] }]);
		expect(
			parse(
				withDefault(asList(asInteger), function (): number[] {
					return [];
				}),
				undefined
			)
		).toEqual([]);
	});

	it('should reject a separator that is not a non-empty string', function () {
		expect(function () {
			asList(isString, '');
		}).toThrow('asList: `separator` must be a non-empty string, got empty string');
		expect(function () {
			asList(isString, 1 as unknown as string);
		}).toThrow('asList: `separator` must be a non-empty string, got number');
	});
});

describe('asBigInt', function () {
	it('should parse bigints, safe integers and integer strings of any length', function () {
		expect(parse(asBigInt, 5n)).toBe(5n);
		expect(parse(asBigInt, -42)).toBe(-42n);
		expect(parse(asBigInt, ' +9007199254740993 ')).toBe(9007199254740993n);
		expect(parse(asBigInt, '-123456789012345678901234567890')).toBe(-123456789012345678901234567890n);
	});

	it('should reject unsafe numbers, fractions, exponents, blanks and other types', function () {
		const parser: Parser<bigint> = asBigInt;

		for (const value of [2 ** 53, 1.5, '1.5', '1e3', '0x10', '', ' ', null, true, {}]) {
			expect(parser['~standard'].validate(value)).toEqual({
				issues: [{ message: expect.stringMatching(/^Expected a bigint, an integer or an integer string \(got /), path: [] }]
			});
		}
	});
});

describe('withError', function () {
	const signUp = {
		email: withError(isEmail, 'Enter a valid email'),
		age: withError(asInteger, function (value: unknown): string {
			return `Enter your age in years, not ${JSON.stringify(value)}`;
		}),
		name: withError(blankAsUndefined(isString), 'Enter your name')
	};

	it('should parse valid values like its schema', function () {
		expect(parse(signUp, { email: 'ada@example.com', age: '36', name: 'Ada' })).toEqual({ email: 'ada@example.com', age: 36, name: 'Ada' });
	});

	it('should replace the issues of its schema, a missing property and a blank value included', function () {
		expect(issuesOf(signUp, { age: '3.5', name: ' ' })).toEqual([
			{ message: 'Enter a valid email', path: ['email'] },
			{ message: 'Enter your age in years, not "3.5"', path: ['age'] },
			{ message: 'Enter your name', path: ['name'] }
		]);
		expect(issuesOf(withError({ a: isString, b: isString }, 'Invalid pair'), { a: 1, b: 2 })).toEqual([{ message: 'Invalid pair', path: [] }]);
	});

	it('should keep the missing values, defaults and score of its schema', function () {
		expect(parse({ name: optional(withError(blankAsUndefined(isString), 'Enter your name')) }, { name: '' })).toEqual({});
		expect(parse(withDefault(withError(asInteger, 'x'), 1), undefined)).toBe(1);
		expect(issuesOf(union(isNumber, withError({ n: isNumber }, 'Expected a point')), { n: 'x' })).toEqual([{ message: 'Expected a point', path: [] }]);
	});

	it('should reject a message that is not a string or a function', function () {
		expect(function () {
			withError(isString, 1 as unknown as string);
		}).toThrow('withError: `message` must be a string or a function, got number');
	});
});
