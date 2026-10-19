import { isFiniteNumber, isInteger, isOneOf, isShape, isString, isStringMatching, type SchemaIssue } from '../guards/index.js';
import {
	arrayOf,
	asArray,
	asBoolean,
	asInteger,
	asJson,
	asNumber,
	blankAsUndefined,
	discriminatedUnion,
	exact,
	isUuid,
	lazy,
	nullable,
	optional,
	parse,
	partial,
	recordOf,
	safeParse,
	transform,
	tuple,
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

describe('asArray', function () {
	const tags = asArray(asInteger);

	it('should parse arrays element by element and wrap single values', function () {
		expect(parse(tags, ['1', '2'])).toEqual([1, 2]);
		expect(parse(tags, '3')).toEqual([3]);
		expect(parse(tags, [])).toEqual([]);
		expect(parse(asArray(isString), 'a')).toEqual(['a']);
	});

	it('should not wrap undefined, so a missing key still fails or takes a default', function () {
		expect(issuesOf({ tags }, {})).toEqual([{ message: 'Missing required property', path: ['tags'] }]);
		expect(issuesOf(tags, undefined)).toEqual([{ message: 'Expected a value or an array (got undefined)', path: [] }]);
		expect(
			parse(
				{
					tags: withDefault(tags, function () {
						return [];
					})
				},
				{}
			)
		).toEqual({ tags: [] });
	});

	it('should report a single value at its own path, and array elements at their index', function () {
		expect(issuesOf({ tags }, { tags: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['tags'] }]);
		expect(issuesOf({ tags }, { tags: ['1', 'x'] })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['tags', 1] }]);
		expect(issuesOf(asArray(isString), ['a', 1])).toEqual([{ message: 'Invalid value (got number)', path: [1] }]);
	});

	it('should reject invalid schemas', function () {
		expect(function () {
			asArray(1 as never);
		}).toThrow(new TypeError('asArray: `schema` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('tuple', function () {
	const point = tuple(asNumber, asNumber, optional(isString));

	it('should parse each position with its schema into a new array', function () {
		const input = ['1.5', 2, undefined];

		expect(parse(point, input)).toEqual([1.5, 2, undefined]);
		expect(parse(point, input)).not.toBe(input);
		expect(parse(tuple(), [])).toEqual([]);
	});

	it('should reject wrong lengths and non-arrays', function () {
		expect(issuesOf(point, [1, 2])).toEqual([{ message: 'Expected a tuple of 3 elements (got 2 elements)', path: [] }]);
		expect(issuesOf(point, [1, 2, 'a', 4])).toEqual([{ message: 'Expected a tuple of 3 elements (got 4 elements)', path: [] }]);
		expect(issuesOf(point, 'xy')).toEqual([{ message: 'Expected a tuple of 3 elements (got string)', path: [] }]);
	});

	it('should report every invalid position', function () {
		expect(issuesOf({ at: point }, { at: ['x', 2, 3] })).toEqual([
			{ message: 'Expected a number or a numeric string (got string)', path: ['at', 0] },
			{ message: 'Invalid value (got number)', path: ['at', 2] }
		]);
	});

	it('should reject invalid schemas, naming their position', function () {
		expect(function () {
			tuple(asNumber, null as never);
		}).toThrow(new TypeError('tuple: `schemas[1]` must be a guard, a parser or a plain object of schemas, got null'));
	});
});

describe('nullable', function () {
	it('should pass null through and parse anything else', function () {
		expect(parse(nullable(asInteger), null)).toBeNull();
		expect(parse(nullable(asInteger), '4')).toBe(4);
		expect(issuesOf(nullable(asInteger), undefined)).toEqual([{ message: 'Expected an integer or an integer string (got undefined)', path: [] }]);
		expect(parse({ a: nullable(asInteger) }, { a: null })).toEqual({ a: null });
	});
});

describe('partial', function () {
	const user = { name: isString, age: asInteger, address: { city: isString } };
	const patch = partial(user);

	it('should make every key optional, shallowly', function () {
		expect(parse(patch, {})).toEqual({});
		expect(parse(patch, { age: '37' })).toEqual({ age: 37 });
		expect(issuesOf(patch, { address: {} })).toEqual([{ message: 'Missing required property', path: ['address', 'city'] }]);
		expect(issuesOf(patch, { age: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['age'] }]);
	});

	it('should return a plain object schema that can be spread', function () {
		expect(Object.keys(patch)).toEqual(['name', 'age', 'address']);
		expect(parse({ ...patch, id: asInteger }, { id: '1' })).toEqual({ id: 1 });
	});

	it('should keep a __proto__ key as an own key', function () {
		const schema = Object.defineProperty({}, '__proto__', { value: asInteger, enumerable: true }) as Record<string, Schema>;
		const optionalProto = partial(schema);

		expect(Object.getPrototypeOf(optionalProto)).toBe(Object.prototype);
		expect(Object.keys(optionalProto)).toEqual(['__proto__']);
	});

	it('should validate its argument', function () {
		expect(function () {
			partial(asInteger as never);
		}).toThrow(new TypeError('partial: `schema` must be a plain object of schemas, got object'));
		expect(function () {
			partial([] as never);
		}).toThrow(new TypeError('partial: `schema` must be a plain object of schemas, got array'));
		expect(function () {
			partial({ a: 1 } as never);
		}).toThrow(new TypeError('partial: `schema.a` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('exact', function () {
	const point = exact({ x: asNumber, y: asNumber });

	it('should parse objects without unknown keys', function () {
		expect(parse(point, { x: '1', y: 2 })).toEqual({ x: 1, y: 2 });
		expect(parse(point, Object.assign(Object.create({ z: 3 }), { x: 1, y: 2 }))).toEqual({ x: 1, y: 2 });
		expect(parse(point, Object.defineProperty({ x: 1, y: 2 }, 'hidden', { value: 1, enumerable: false }))).toEqual({ x: 1, y: 2 });
	});

	it('should report every unknown key after the other issues', function () {
		expect(issuesOf(point, { x: 1, y: 2, z: 3, w: 4 })).toEqual([
			{ message: 'Unknown property', path: ['z'] },
			{ message: 'Unknown property', path: ['w'] }
		]);
		expect(issuesOf({ p: point }, { p: { x: 'a', z: 3 } })).toEqual([
			{ message: 'Expected a number or a numeric string (got string)', path: ['p', 'x'] },
			{ message: 'Missing required property', path: ['p', 'y'] },
			{ message: 'Unknown property', path: ['p', 'z'] }
		]);
		expect(issuesOf(point, null)).toEqual([{ message: 'Expected an object (got null)', path: [] }]);
		expect(issuesOf(point, [1, 2])).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
	});

	it('should validate its argument', function () {
		expect(function () {
			exact(isString as never);
		}).toThrow(new TypeError('exact: `schema` must be a plain object of schemas, got function'));
	});
});

describe('union', function () {
	const id = union(asInteger, isUuid);

	it('should return the output of the first schema that accepts the value', function () {
		expect(parse(id, '42')).toBe(42);
		expect(parse(id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
		expect(parse(union(asNumber, asInteger), '1')).toBe(1);
		expect(parse(union(isString, asInteger), '1')).toBe('1');
	});

	it('should report the issues of the closest member', function () {
		const shapes = union({ kind: isOneOf(['a']), x: asInteger }, { kind: isOneOf(['b']), y: asInteger, z: asInteger });

		expect(issuesOf(shapes, { kind: 'b', y: '1', z: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['z'] }]);
		expect(issuesOf({ id }, { id: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['id'] }]);
	});

	it('should accept a member that accepts the value on the reporting pass', function () {
		let calls = 0;

		/**
		 * Rejects its first call only.
		 * @param {unknown} value - The value
		 * @returns {boolean} `false` on the first call
		 */
		function once(value: unknown): value is unknown {
			return value !== undefined && calls++ > 0;
		}

		expect(safeParse(union(once), 1)).toEqual([undefined, 1]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			union();
		}).toThrow(new RangeError('union: expected at least one schema, got 0'));
		expect(function () {
			union(isString, 'x' as never);
		}).toThrow(new TypeError('union: `schemas[1]` must be a guard, a parser or a plain object of schemas, got string'));
	});
});

describe('discriminatedUnion', function () {
	const event = discriminatedUnion('type', {
		click: { x: asInteger, y: asInteger },
		key: { code: isString, repeat: withDefault(asBoolean, false) }
	});

	it('should parse with the variant named by the tag, tag first, unknown keys stripped', function () {
		const click = parse(event, { extra: 1, x: '10', type: 'click', y: 20 });

		expect(click).toEqual({ type: 'click', x: 10, y: 20 });
		expect(Object.keys(click)).toEqual(['type', 'x', 'y']);
		expect(parse(event, { type: 'key', code: 'Enter' })).toEqual({ type: 'key', code: 'Enter', repeat: false });
	});

	it('should narrow to the tagged outputs', function () {
		const parsed = parse(event, { type: 'click', x: 1, y: 2 });
		const sum = parsed.type === 'click' ? parsed.x + parsed.y : parsed.code.length;

		expect(sum).toBe(3);
	});

	it('should report the matching variant only, or the allowed tags', function () {
		expect(issuesOf(event, { type: 'key' })).toEqual([{ message: 'Missing required property', path: ['code'] }]);
		expect(issuesOf(event, { type: 'scroll' })).toEqual([{ message: 'Expected "click" or "key" (got string)', path: ['type'] }]);
		expect(issuesOf(event, { type: 1 })).toEqual([{ message: 'Expected "click" or "key" (got number)', path: ['type'] }]);
		expect(issuesOf(event, {})).toEqual([{ message: 'Missing required property', path: ['type'] }]);
		expect(issuesOf({ events: arrayOf(event) }, { events: [{ type: 'click', x: 1, y: 'b' }] })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['events', 0, 'y'] }
		]);
		expect(issuesOf(event, null)).toEqual([{ message: 'Expected an object (got null)', path: [] }]);
		expect(issuesOf(event, [])).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
	});

	it('should only match own string tags, never inherited ones', function () {
		expect(issuesOf(event, Object.assign(Object.create({ type: 'click' }), { x: 1, y: 2 }))).toEqual([{ message: 'Missing required property', path: ['type'] }]);
		for (const tag of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) expect(safeParse(event, { type: tag })[0]).toBeDefined();
		expect(safeParse(discriminatedUnion('kind', { 1: {} }), { kind: 1 })[0]).toBeDefined();
		expect(parse(discriminatedUnion('kind', { 1: {} }), { kind: '1' })).toEqual({ kind: '1' });
	});

	it('should ignore a variant schema for the tag itself', function () {
		const tagged = discriminatedUnion('type', { a: { type: asInteger, n: asInteger } });

		expect(parse(tagged, { type: 'a', n: '1' })).toEqual({ type: 'a', n: 1 });
	});

	it('should accept a __proto__ discriminant as an own property', function () {
		const tagged = discriminatedUnion('__proto__', { a: { n: asInteger } });
		const parsed = parse(tagged, JSON.parse('{"__proto__":"a","n":"1"}')) as Record<string, unknown>;

		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toBe('a');
		expect(parsed.n).toBe(1);
	});

	it('should list a single allowed tag on its own', function () {
		expect(issuesOf(discriminatedUnion('t', { only: {} }), { t: 'x' })).toEqual([{ message: 'Expected "only" (got string)', path: ['t'] }]);
		expect(issuesOf(discriminatedUnion('t', { a: {}, b: {}, c: {} }), { t: 'x' })).toEqual([{ message: 'Expected "a", "b" or "c" (got string)', path: ['t'] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			discriminatedUnion(1 as never, { a: {} });
		}).toThrow(new TypeError('discriminatedUnion: `key` must be a string, got number'));
		expect(function () {
			discriminatedUnion('t', [] as never);
		}).toThrow(new TypeError('discriminatedUnion: `variants` must be a plain object, got array'));
		expect(function () {
			discriminatedUnion('t', null as never);
		}).toThrow(new TypeError('discriminatedUnion: `variants` must be a plain object, got null'));
		expect(function () {
			discriminatedUnion('t', {});
		}).toThrow(new RangeError('discriminatedUnion: `variants` must have at least one variant, got 0'));
		expect(function () {
			discriminatedUnion('t', { a: isShape({}) as never });
		}).toThrow(new TypeError('discriminatedUnion: `variants.a` must be a plain object of schemas, got function'));
		expect(function () {
			discriminatedUnion('t', { a: { n: 1 as never } });
		}).toThrow(new TypeError('discriminatedUnion: `variants.a.n` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('recordOf', function () {
	it('should parse every own enumerable string key into a new object', function () {
		const input = { a: '1', b: 2 };
		const output = parse(recordOf(asInteger), input);

		expect(output).toEqual({ a: 1, b: 2 });
		expect(output).not.toBe(input);
		expect(parse(recordOf(isString), {})).toEqual({});
		expect(parse(recordOf(isInteger), Object.assign(Object.create(null), { x: 1 }))).toEqual({ x: 1 });
		expect(parse(recordOf(isInteger), Object.defineProperty({ [Symbol('s')]: 'x' }, 'hidden', { value: 'y', enumerable: false }))).toEqual({});
	});

	it('should keep __proto__ keys as own properties', function () {
		const output = parse(recordOf(asInteger), JSON.parse('{"__proto__":"1"}')) as Record<string, unknown>;

		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toBe(1);
	});

	it('should check keys with the key guard', function () {
		const translations = recordOf(isString, isOneOf(['en', 'fr']));

		expect(parse(translations, { en: 'Hi' })).toEqual({ en: 'Hi' });
		expect(issuesOf(translations, { en: 'Hi', de: 'Hallo', fr: 1 })).toEqual([
			{ message: 'Invalid key: Expected one of 2 allowed values (got string)', path: ['de'] },
			{ message: 'Invalid value (got number)', path: ['fr'] }
		]);
		expect(issuesOf(recordOf(isString, isStringMatching(/^[a-z]{2}$/)), { EN: 'x' })).toEqual([
			{ message: 'Invalid key: Expected a string matching /^[a-z]{2}$/ (got string)', path: ['EN'] }
		]);
	});

	it('should report a key guard that rejects a key twice but accepts it when explained', function () {
		let calls = 0;

		/**
		 * Rejects the first two calls of every three.
		 * @param {unknown} key - The key
		 * @returns {boolean} `true` on every third call
		 */
		function flaky(key: unknown): key is string {
			return key !== undefined && calls++ % 3 === 2;
		}

		expect(issuesOf(recordOf(isString, flaky), { a: 'x' })).toEqual([{ message: 'Invalid key', path: ['a'] }]);
	});

	it('should report non-plain objects and every invalid value', function () {
		expect(issuesOf(recordOf(asInteger), new Map())).toEqual([{ message: 'Expected a plain object (got object)', path: [] }]);
		expect(issuesOf(recordOf(asInteger), [])).toEqual([{ message: 'Expected a plain object (got array)', path: [] }]);
		expect(issuesOf({ scores: recordOf(asInteger) }, { scores: { a: 'x', b: '1', c: 'y' } })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['scores', 'a'] },
			{ message: 'Expected an integer or an integer string (got string)', path: ['scores', 'c'] }
		]);
		expect(issuesOf(recordOf(isInteger), { a: 'x' })).toEqual([{ message: 'Invalid value (got string)', path: ['a'] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			recordOf(isString, 'en' as never);
		}).toThrow(new TypeError('recordOf: `keys` must be a function, got string'));
		expect(function () {
			recordOf(undefined as never);
		}).toThrow(TypeError);
	});
});

describe('lazy', function () {
	type Comment = { text: string; replies: Comment[] };
	const comment: Parser<Comment> = lazy(function () {
		return {
			text: isString,
			replies: withDefault(arrayOf(comment), function () {
				return [];
			})
		};
	});

	it('should parse recursive structures', function () {
		expect(parse(comment, { text: 'a', replies: [{ text: 'b', replies: [{ text: 'c' }] }], extra: 1 })).toEqual({
			text: 'a',
			replies: [{ text: 'b', replies: [{ text: 'c', replies: [] }] }]
		});
		expect(issuesOf(comment, { text: 'a', replies: [{ text: 1 }] })).toEqual([{ message: 'Invalid value (got number)', path: ['replies', 0, 'text'] }]);
	});

	it('should call the getter once, on first use', function () {
		const getter = jest.fn(function () {
			return asInteger;
		});
		const parser = lazy<number>(getter);

		expect(getter).not.toHaveBeenCalled();
		expect(parse(parser, '1')).toBe(1);
		expect(parse(parser, '2')).toBe(2);
		expect(issuesOf(parser, 'x')).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: [] }]);
		expect(getter).toHaveBeenCalledTimes(1);
	});

	it('should reject cyclic values instead of overflowing the stack', function () {
		const loop: { text: string; replies: unknown[] } = { text: 'a', replies: [] };

		loop.replies.push(loop);
		expect(issuesOf(comment, loop)).toEqual([{ message: 'Circular reference', path: ['replies', 0] }]);
	});

	it('should accept shared, non-circular sub-values', function () {
		const shared = { text: 'b', replies: [] };

		expect(parse(comment, { text: 'a', replies: [shared, shared] })).toEqual({
			text: 'a',
			replies: [
				{ text: 'b', replies: [] },
				{ text: 'b', replies: [] }
			]
		});
	});

	it('should validate its getter', function () {
		expect(function () {
			lazy('x' as never);
		}).toThrow(new TypeError('lazy: `getter` must be a function, got string'));
		expect(function () {
			parse(
				lazy(function () {
					return 1 as never;
				}),
				1
			);
		}).toThrow(new TypeError('lazy: `getter()` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('blankAsUndefined', function () {
	const form = { age: blankAsUndefined(optional(asInteger)), name: blankAsUndefined(isString), page: blankAsUndefined(withDefault(asInteger, 1)) };

	class Input {
		age = ' ';
		name = '';
		page = '';
	}

	it('should treat blank fields as missing, in generated and looped object parses alike', function () {
		expect(parse(form, { age: '', name: 'Ada', page: '\t' })).toEqual({ name: 'Ada', page: 1 });
		expect(parse(form, { age: '36', name: 'Ada', page: '2' })).toEqual({ age: 36, name: 'Ada', page: 2 });
		expect(issuesOf(form, new Input())).toEqual([{ message: 'Missing required property', path: ['name'] }]);
		expect(issuesOf(form, { age: '36', name: '  ' })).toEqual([{ message: 'Missing required property', path: ['name'] }]);
		expect(issuesOf(form, { age: 'x', name: 'Ada' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['age'] }]);
	});

	it('should keep non-string and non-blank values', function () {
		expect(parse(blankAsUndefined(optional(asInteger)), 3)).toBe(3);
		expect(parse(blankAsUndefined(isString), ' a ')).toBe(' a ');
		expect(parse(blankAsUndefined(optional(isString)), '')).toBeUndefined();
	});
});

describe('asJson', function () {
	const env = { FEATURES: asJson(arrayOf(isString)), LIMITS: asJson({ rpm: asInteger }) };

	it('should parse the JSON text, then the value', function () {
		expect(parse(env, { FEATURES: '["beta"]', LIMITS: '{"rpm":"60","x":1}' })).toEqual({ FEATURES: ['beta'], LIMITS: { rpm: 60 } });
		expect(parse(asJson(isFiniteNumber), ' 1.5 ')).toBe(1.5);
	});

	it('should report invalid JSON without quoting it, and nested issues below the string', function () {
		expect(issuesOf(env, { FEATURES: '[secret-token', LIMITS: '{}' })).toEqual([
			{ message: 'Expected valid JSON (got string)', path: ['FEATURES'] },
			{ message: 'Missing required property', path: ['LIMITS', 'rpm'] }
		]);
		expect(issuesOf(env, { FEATURES: ['beta'], LIMITS: 1 })).toEqual([
			{ message: 'Expected a JSON string (got object)', path: ['FEATURES'] },
			{ message: 'Expected a JSON string (got number)', path: ['LIMITS'] }
		]);
	});

	it('should reject prototype-pollution payloads', function () {
		expect(issuesOf(asJson(transform(isShape({}), Object)), '{"__proto__":{"admin":true}}')).toEqual([
			{ message: 'Expected JSON without "__proto__" or "constructor.prototype" keys', path: [] }
		]);
	});
});

describe('types', function () {
	it('should infer the outputs of the new parsers', function () {
		const schema = {
			a: asArray(asInteger),
			b: tuple(asNumber, isString),
			c: nullable(asBoolean),
			d: union(asInteger, isString),
			e: recordOf(asInteger, isOneOf(['x', 'y'])),
			f: recordOf(isString),
			g: exact({ h: asInteger }),
			i: asJson({ j: isString }),
			k: blankAsUndefined(optional(asInteger)),
			l: discriminatedUnion('t', { m: { n: asInteger } })
		};
		type Output = SchemaOutput<typeof schema>;
		const output: Output = {
			a: [1],
			b: [1, 'x'],
			c: null,
			d: 'x',
			e: { x: 1 },
			f: { any: 'z' },
			g: { h: 1 },
			i: { j: 'x' },
			l: { t: 'm', n: 1 }
		};
		const typed: {
			a: number[];
			b: [number, string];
			c: boolean | null;
			d: number | string;
			e: { x?: number; y?: number };
			k?: number | undefined;
			l: { t: 'm'; n: number };
		} = output;

		expect(typed.a).toEqual([1]);
	});
});
