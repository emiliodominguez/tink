import * as vm from 'vm';
import { z } from 'zod';
import {
	isArrayOf,
	isInteger,
	isIntegerInRange,
	isOneOf,
	isOptional,
	isShape,
	isString,
	toStandardSchema,
	ValidationError,
	type SchemaIssue,
	type StandardSchemaV1
} from '../guards/index.js';
import {
	arrayOf,
	asBoolean,
	asDate,
	asInteger,
	asNumber,
	chain,
	isUrl,
	optional,
	parse,
	safeParse,
	toParser,
	transform,
	withDefault,
	type Parser,
	type Schema,
	type SchemaOutput,
	type StandardSchemaLike
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

describe('parse', function () {
	const env = {
		PORT: withDefault(asInteger, 3000),
		DEBUG: withDefault(asBoolean, false),
		MODE: isOneOf(['dev', 'prod']),
		DATABASE_URL: isUrl
	};

	it('should coerce, fill defaults and strip unknown keys', function () {
		const parsed = parse(env, { PORT: '8080', MODE: 'prod', DATABASE_URL: 'https://db.example.com', HOME: '/root' });

		expect(parsed).toEqual({ PORT: 8080, DEBUG: false, MODE: 'prod', DATABASE_URL: 'https://db.example.com' });
		expect(Object.keys(parsed)).toEqual(['PORT', 'DEBUG', 'MODE', 'DATABASE_URL']);
	});

	it('should throw a ValidationError listing every issue with its path', function () {
		let caught: unknown;

		try {
			parse(env, { PORT: 'eighty', DEBUG: 'maybe', DATABASE_URL: 'ftp://x' });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ValidationError);
		expect((caught as ValidationError).issues).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['PORT'] },
			{ message: 'Expected a boolean or a boolean string such as "true" or "false" (got string)', path: ['DEBUG'] },
			{ message: 'Missing required property', path: ['MODE'] },
			{ message: 'Invalid value (got string)', path: ['DATABASE_URL'] }
		]);
		expect((caught as ValidationError).message).toMatch(/^PORT: Expected an integer/);
	});

	it('should parse top-level guards and parsers', function () {
		const list = ['a'];

		expect(parse(isArrayOf(isString), list)).toBe(list);
		expect(parse(asInteger, '7')).toBe(7);
		expect(function () {
			parse(isString, 1);
		}).toThrow(new ValidationError([{ message: 'Invalid value (got number)', path: [] }]));
	});

	it('should accept any non-array object as input, own properties only', function () {
		class Input {
			PORT = '1';
		}

		expect(parse({ PORT: asInteger }, new Input())).toEqual({ PORT: 1 });
		expect(parse({ PORT: asInteger }, Object.assign(Object.create(null), { PORT: '2' }))).toEqual({ PORT: 2 });
		expect(issuesOf({ PORT: asInteger }, Object.create({ PORT: '3' }))).toEqual([{ message: 'Missing required property', path: ['PORT'] }]);
	});

	it('should never read a polluted Object.prototype', function () {
		(Object.prototype as Record<string, unknown>).polluted = 'yes';

		try {
			expect(issuesOf({ polluted: isString }, {})).toEqual([{ message: 'Missing required property', path: ['polluted'] }]);
			expect(parse({ polluted: optional(isString) }, {})).toEqual({});
		} finally {
			delete (Object.prototype as Record<string, unknown>).polluted;
		}
	});

	it('should report non-object inputs of object schemas', function () {
		expect(issuesOf({ a: isString }, null)).toEqual([{ message: 'Expected an object (got null)', path: [] }]);
		expect(issuesOf({ a: isString }, ['a'])).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
		expect(issuesOf({ a: { b: isString } }, { a: 'x' })).toEqual([{ message: 'Expected an object (got string)', path: ['a'] }]);
	});

	it('should parse nested object schemas, reporting missing objects as missing properties', function () {
		const schema = { user: { id: asInteger, tags: arrayOf(isString) } };

		expect(parse(schema, { user: { id: '1', tags: ['a'], extra: 1 } })).toEqual({ user: { id: 1, tags: ['a'] } });
		expect(issuesOf(schema, {})).toEqual([{ message: 'Missing required property', path: ['user'] }]);
		expect(issuesOf(schema, { user: { tags: ['a', 2] } })).toEqual([
			{ message: 'Missing required property', path: ['user', 'id'] },
			{ message: 'Invalid value (got number)', path: ['user', 'tags', 1] }
		]);
	});

	it('should prefix the nested issues of guards with their path', function () {
		const schema = { body: isShape({ items: isArrayOf(isShape({ id: isInteger })) }) };

		expect(issuesOf(schema, { body: { items: [{ id: 1 }, { id: 'x' }] } })).toEqual([{ message: 'Invalid value (got string)', path: ['body', 'items', 1, 'id'] }]);
	});

	it('should return what guards check unchanged (no stripping inside guards)', function () {
		const body = { id: 1, extra: true };

		expect(parse({ body: isShape({ id: isInteger }) }, { body }).body).toBe(body);
	});

	it('should keep present undefined values and omit missing ones', function () {
		const schema = { a: optional(isString), b: isOptional(isString) };

		expect(Object.keys(parse(schema, {}))).toEqual([]);
		expect(Object.keys(parse(schema, { a: undefined, b: undefined }))).toEqual(['a', 'b']);
		expect(issuesOf({ ...schema, c: isString }, { c: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['c'] }]);
	});

	it('should write a `__proto__` key as an own property', function () {
		const schema = Object.defineProperty({}, '__proto__', { value: asInteger, enumerable: true }) as Record<string, Schema>;
		const parsed = parse(schema, JSON.parse('{"__proto__":"1"}')) as Record<string, unknown>;

		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')).toEqual({ value: 1, enumerable: true, writable: true, configurable: true });
	});

	it('should fail a guard that rejects a value twice but accepts it when explained', function () {
		let calls = 0;

		/**
		 * Rejects the first two calls of every three: the fast pass, then the reporting pass, before `explain` calls it again.
		 * @param {unknown} value - The value
		 * @returns {boolean} `true` on every third call
		 */
		function flaky(value: unknown): value is unknown {
			return value !== undefined && calls++ % 3 === 2;
		}

		expect(issuesOf(flaky, 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
	});

	it('should accept a value that a non-deterministic schema accepts on the reporting pass', function () {
		/**
		 * Builds a guard that rejects its first call only.
		 * @returns {(value: unknown) => boolean} The guard
		 */
		function rejectOnce(): (value: unknown) => value is unknown {
			let calls = 0;

			return function once(value: unknown): value is unknown {
				return value !== undefined && calls++ > 0;
			};
		}

		/**
		 * Builds a Standard Schema validator that fails its first call only.
		 * @returns {StandardSchemaLike} The validator
		 */
		function failOnce(): StandardSchemaLike {
			let calls = 0;

			return {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: function (value: unknown) {
						return calls++ === 0 ? { issues: [{ message: 'first call' }] } : { value };
					}
				}
			};
		}

		expect(safeParse({ a: rejectOnce() }, { a: 1 })).toEqual([undefined, { a: 1 }]);
		expect(safeParse(rejectOnce(), 1)).toEqual([undefined, 1]);
		expect(safeParse(failOnce(), 2)).toEqual([undefined, 2]);
		expect(safeParse(transform(rejectOnce(), String), 3)).toEqual([undefined, '3']);
	});

	it('should give the same results when a schema is parsed again (compiled once)', function () {
		const schema = { a: asInteger };

		expect(parse(schema, { a: '1' })).toEqual({ a: 1 });
		expect(parse(schema, { a: '2' })).toEqual({ a: 2 });
		expect(parse({ x: schema, y: schema }, { x: { a: '3' }, y: { a: '4' } })).toEqual({ x: { a: 3 }, y: { a: 4 } });
	});

	it('should reject invalid schemas with a TypeError naming them', function () {
		expect(function () {
			parse(null as never, 1);
		}).toThrow(new TypeError('parse: `schema` must be a guard, a parser or a plain object of schemas, got null'));
		expect(function () {
			parse([isString] as never, ['a']);
		}).toThrow(new TypeError('parse: `schema` must be a guard, a parser or a plain object of schemas, got array (use arrayOf for arrays)'));
		expect(function () {
			parse({ a: { b: 1 } } as never, {});
		}).toThrow(new TypeError('parse: `schema.a.b` must be a guard, a parser or a plain object of schemas, got number'));
		expect(function () {
			parse(new Map() as never, {});
		}).toThrow(TypeError);
		expect(function () {
			parse({ a: new Map() } as never, {});
		}).toThrow(new TypeError('parse: `schema.a` must be a guard, a parser or a plain object of schemas, got object'));
	});

	it('should reject circular schemas', function () {
		const schema: Record<string, unknown> = { a: isString };

		schema.self = schema;
		expect(function () {
			parse(schema as never, {});
		}).toThrow(new TypeError('parse: `schema.self` must be acyclic, got a circular reference'));
	});
});

describe('compiled object schemas', function () {
	it('should embed any key safely in the generated code', function () {
		const keys = ['a"b', "a'b", 'a\\b', 'line\nbreak', '  ', '</script>', '`${1}`', '"); throw new Error("injected"); ("', '\ud800', '', ' ', '0', '1e3'];
		const schema = Object.fromEntries(
			keys.map(function (key) {
				return [key, asInteger];
			})
		);
		const input = Object.fromEntries(
			keys.map(function (key, index) {
				return [key, String(index)];
			})
		);
		const output = parse(schema, input) as Record<string, number>;

		expect(Object.keys(output).sort()).toEqual([...keys].sort());
		keys.forEach(function (key, index) {
			expect(output[key]).toBe(index);
		});
	});

	it('should parse wide schemas', function () {
		const keys = Array.from({ length: 5000 }, function (_, index) {
			return `key${index}`;
		});
		const schema = Object.fromEntries(
			keys.map(function (key) {
				return [key, isString];
			})
		);
		const input = Object.fromEntries(
			keys.map(function (key) {
				return [key, key];
			})
		);

		expect(parse(schema, input)).toEqual(input);
		expect(issuesOf(schema, { ...input, key4999: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['key4999'] }]);
	});

	it('should give the same output for every kind of input object', function () {
		const schema = { id: asInteger, name: isString, note: optional(isString) };
		class Input {
			id = '1';
			name = 'Ada';
		}
		const inputs: object[] = [
			{ id: '1', name: 'Ada' },
			Object.assign(Object.create(null), { id: '1', name: 'Ada' }),
			new Input(),
			Object.assign(Object.create({ note: 'inherited' }), { id: '1', name: 'Ada' })
		];

		for (const input of inputs) expect(parse(schema, input)).toEqual({ id: 1, name: 'Ada' });
		expect(Object.keys(parse(schema, { id: '1', name: 'Ada', note: undefined }))).toEqual(['id', 'name', 'note']);
	});

	it('should read keys that also exist on Object.prototype as own properties only', function () {
		const schema = { constructor: optional(isString), toString: optional(isString) };

		expect(parse(schema, {})).toEqual({});
		expect(parse(schema, { constructor: 'x', toString: 'y' })).toEqual({ constructor: 'x', toString: 'y' });
		expect(issuesOf({ constructor: isString }, {})).toEqual([{ message: 'Missing required property', path: ['constructor'] }]);
	});

	it('should switch to the own-property loop when Object.prototype gets polluted after compilation', function () {
		const schema = { role: withDefault(isString, 'user'), admin: withDefault(asBoolean, false) };

		expect(parse(schema, {})).toEqual({ role: 'user', admin: false });
		(Object.prototype as Record<string, unknown>).admin = true;
		try {
			expect(parse(schema, {})).toEqual({ role: 'user', admin: false });
			expect(parse(schema, Object.create(null))).toEqual({ role: 'user', admin: false });
		} finally {
			delete (Object.prototype as Record<string, unknown>).admin;
		}
	});

	it('should fall back to the loop when code generation is disallowed', function () {
		const original = globalThis.Function;
		let isolated: typeof import('.') | undefined;

		jest.isolateModules(function () {
			// A fresh copy of the module, which has not compiled an object schema yet.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			isolated = require('.') as typeof import('.');
		});

		const {
			arrayOf: isolatedArrayOf,
			asBoolean: isolatedAsBoolean,
			asInteger: isolatedAsInteger,
			parse: isolatedParse,
			safeParse: isolatedSafeParse
		} = isolated as typeof import('.');

		// What a Content Security Policy without 'unsafe-eval' (or Cloudflare Workers) does to `new Function`.
		globalThis.Function = function (): never {
			throw new EvalError('Code generation from strings disallowed for this context');
		} as unknown as FunctionConstructor;
		try {
			const schema = { id: isolatedAsInteger, tags: isolatedArrayOf(isString) };

			expect(isolatedParse(schema, { id: '1', tags: ['a'], extra: 1 })).toEqual({ id: 1, tags: ['a'] });
			expect(isolatedParse({ other: isolatedAsBoolean }, { other: 'on' })).toEqual({ other: true });
			expect(isolatedSafeParse(schema, { tags: [1] })[0]?.issues).toEqual([
				{ message: 'Missing required property', path: ['id'] },
				{ message: 'Invalid value (got number)', path: ['tags', 0] }
			]);
			expect(isolatedSafeParse(schema, null)[0]?.issues).toEqual([{ message: 'Expected an object (got null)', path: [] }]);
			expect(isolatedSafeParse(schema, [])[0]?.issues).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
		} finally {
			globalThis.Function = original;
		}
	});
});

describe('Standard Schema interop', function () {
	it('should run zod schemas inside a schema, with their output and prefixed issue paths', function () {
		const schema = {
			slug: z.string().transform(function (s) {
				return s.toUpperCase();
			}),
			meta: z.object({ n: z.number() })
		};
		const parsed: { slug: string; meta: { n: number } } = parse(schema, { slug: 'ab', meta: { n: 1 } });

		expect(parsed).toEqual({ slug: 'AB', meta: { n: 1 } });
		expect(issuesOf(schema, { slug: 'ab', meta: { n: 'x' } })).toEqual([{ message: expect.any(String), path: ['meta', 'n'] }]);
	});

	it('should reject asynchronous validators', function () {
		const schema = {
			name: z.string().refine(async function () {
				return true;
			})
		};

		expect(function () {
			parse(schema, { name: 'x' });
		}).toThrow(new TypeError('parse: Standard Schema validators must be synchronous, got one returning a promise'));
	});

	it('should flatten `{ key }` path segments and handle missing paths and empty issue lists', function () {
		/**
		 * Builds a Standard Schema validator that always fails with `issues`.
		 * @param {ReadonlyArray<object>} issues - The issues
		 * @returns {object} The validator
		 */
		function failing(issues: ReadonlyArray<object>): StandardSchemaLike {
			return {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: function () {
						return { issues };
					}
				}
			};
		}

		expect(issuesOf({ a: failing([{ message: 'bad', path: [{ key: 'x' }, 0] }]) }, { a: 1 })).toEqual([{ message: 'bad', path: ['a', 'x', 0] }]);
		expect(issuesOf({ a: failing([{ message: 'bad' }]) }, { a: 1 })).toEqual([{ message: 'bad', path: ['a'] }]);
		expect(issuesOf({ a: failing([]) }, { a: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['a'] }]);
	});

	it('should treat any falsy `issues` as a success, as the Standard Schema spec says', function () {
		/**
		 * Builds a Standard Schema validator that succeeds with `issues` set to a falsy value.
		 * @param {unknown} issues - The falsy value
		 * @returns {object} The validator
		 */
		function succeeding(issues: unknown): StandardSchemaLike {
			return {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: function (value: unknown) {
						return { value: String(value), issues };
					}
				}
			};
		}

		for (const issues of [null, false, 0, '']) {
			expect(safeParse(succeeding(issues), 1)).toEqual([undefined, '1']);
			expect(safeParse({ a: succeeding(issues), b: isInteger }, { a: 1, b: 'x' })[0]?.issues).toEqual([{ message: 'Invalid value (got string)', path: ['b'] }]);
		}

		let calls = 0;
		// Fails its first call (the fast parse), then succeeds with `issues: null` (the reporting parse).
		const late: StandardSchemaLike = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: function (value: unknown) {
					return calls++ === 0 ? { issues: [{ message: 'first call' }] } : { value, issues: null };
				}
			}
		};

		expect(safeParse(late, 2)).toEqual([undefined, 2]);
	});

	it('should accept the guards module’s Standard Schema validators', function () {
		expect(parse({ id: toStandardSchema(isInteger) }, { id: 1 })).toEqual({ id: 1 });
		expect(issuesOf({ id: toStandardSchema(isInteger) }, { id: 'x' })).toEqual([{ message: 'Invalid value (got string)', path: ['id'] }]);
	});

	it('should make every parser a Standard Schema validator', function () {
		const parser: StandardSchemaV1<unknown, number> = asInteger;

		expect(parser['~standard'].version).toBe(1);
		expect(parser['~standard'].vendor).toBe('tink');
		expect(parser['~standard'].validate('1')).toEqual({ value: 1 });
		expect(parser['~standard'].validate('x')).toEqual({ issues: [{ message: 'Expected an integer or an integer string (got string)', path: [] }] });
		for (const builtin of [asNumber, asBoolean, asDate]) expect(builtin['~standard'].validate(1)).toEqual({ value: expect.anything() });
		expect(withDefault(asInteger, 1)['~standard'].validate(undefined)).toEqual({ value: 1 });
	});

	it('should parse tinkit parsers nested in zod-style consumers that call validate detached', function () {
		const { validate } = toParser({ a: asInteger })['~standard'];

		expect(validate({ a: '1' })).toEqual({ value: { a: 1 } });
	});
});

describe('safeParse', function () {
	it('should return a tuple instead of throwing', function () {
		expect(safeParse({ page: withDefault(asInteger, 1) }, {})).toEqual([undefined, { page: 1 }]);

		const [error, value] = safeParse({ page: asInteger }, { page: 'x' });

		expect(error).toBeInstanceOf(ValidationError);
		expect(error?.issues).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['page'] }]);
		expect(value).toBeUndefined();
	});

	it('should still throw for invalid schemas', function () {
		expect(function () {
			safeParse(1 as never, 1);
		}).toThrow(new TypeError('safeParse: `schema` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('toParser', function () {
	it('should turn any schema into a Standard Schema parser', function () {
		const form = toParser({ age: asInteger, newsletter: withDefault(asBoolean, false) });

		expect(form['~standard'].validate({ age: '36' })).toEqual({ value: { age: 36, newsletter: false } });
		expect(form['~standard'].validate({})).toEqual({ issues: [{ message: 'Missing required property', path: ['age'] }] });
		expect(toParser(isString)['~standard'].validate('a')).toEqual({ value: 'a' });
		expect(parse(toParser({ a: asInteger }), { a: '1' })).toEqual({ a: 1 });
	});

	it('should return the parsers of this module as they are', function () {
		const parser = withDefault(asInteger, 1);

		expect(toParser(parser)).toBe(parser);
		expect(toParser(asInteger)).toBe(asInteger);
	});

	it('should reject invalid schemas', function () {
		expect(function () {
			toParser('x' as never);
		}).toThrow(new TypeError('toParser: `schema` must be a guard, a parser or a plain object of schemas, got string'));
	});
});

describe('withDefault', function () {
	it('should use the fallback for undefined only', function () {
		const port = withDefault(asInteger, 3000);

		expect(parse({ port }, {})).toEqual({ port: 3000 });
		expect(parse({ port }, { port: undefined })).toEqual({ port: 3000 });
		expect(parse({ port }, { port: '80' })).toEqual({ port: 80 });
		expect(issuesOf({ port }, { port: null })).toEqual([{ message: 'Expected an integer or an integer string (got null)', path: ['port'] }]);
	});

	it('should call a function fallback for every missing value', function () {
		const make = jest.fn(function (): string[] {
			return [];
		});
		const tags = withDefault(arrayOf(isString), make);
		const first = parse(tags, undefined);
		const second = parse(tags, undefined);

		expect(first).toEqual([]);
		expect(first).not.toBe(second);
		expect(make).toHaveBeenCalledTimes(2);
		parse(tags, ['a']);
		expect(make).toHaveBeenCalledTimes(2);
	});

	it('should not validate the fallback', function () {
		expect(parse(withDefault(isIntegerInRange(1, 10), 99), undefined)).toBe(99);
	});

	it('should reject invalid schemas', function () {
		expect(function () {
			withDefault(undefined as never, 1 as never);
		}).toThrow(new TypeError('withDefault: `schema` must be a guard, a parser or a plain object of schemas, got undefined'));
	});
});

describe('optional', function () {
	it('should pass undefined through and parse anything else', function () {
		expect(parse(optional(asInteger), undefined)).toBeUndefined();
		expect(parse({ limit: optional(asInteger) }, { limit: '10' })).toEqual({ limit: 10 });
		expect(issuesOf({ limit: optional(asInteger) }, { limit: null })).toEqual([{ message: 'Expected an integer or an integer string (got null)', path: ['limit'] }]);
	});

	it('should reject invalid schemas', function () {
		expect(function () {
			optional(1 as never);
		}).toThrow(TypeError);
	});
});

describe('transform', function () {
	it('should map the output of a successful parse', function () {
		const email = transform(isString, function (s) {
			return s.trim().toLowerCase();
		});

		expect(parse(email, '  Ada@Example.COM ')).toBe('ada@example.com');
		expect(
			parse(
				{
					ids: transform(arrayOf(asInteger), function (ids) {
						return new Set(ids);
					})
				},
				{ ids: ['1', '2', '2'] }
			)
		).toEqual({ ids: new Set([1, 2]) });
	});

	it('should not run the function when the schema fails', function () {
		const fn = jest.fn();

		expect(issuesOf({ a: transform(asInteger, fn) }, { a: 'x' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['a'] }]);
		expect(fn).not.toHaveBeenCalled();
	});

	it('should run again while the issues of an invalid input are collected', function () {
		const fn = jest.fn(String);

		expect(issuesOf({ a: transform(asInteger, fn), b: isString }, { a: '1', b: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['b'] }]);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('should validate its arguments', function () {
		expect(function () {
			transform(isString, 'trim' as never);
		}).toThrow(new TypeError('transform: `fn` must be a function, got string'));
		expect(function () {
			transform(null as never, String);
		}).toThrow(TypeError);
	});
});

describe('chain', function () {
	const port = chain(asInteger, isIntegerInRange(1, 65535));

	it('should parse the output of the first schema with the second', function () {
		expect(parse(port, '8080')).toBe(8080);
		expect(
			parse(
				chain(
					asInteger,
					transform(asInteger, function (n) {
						return n * 2;
					})
				),
				'2'
			)
		).toBe(4);
		expect(issuesOf({ port }, { port: '70000' })).toEqual([{ message: 'Expected an integer between 1 and 65535 (got 70000)', path: ['port'] }]);
	});

	it('should stop at the first failure', function () {
		let calls = 0;

		/**
		 * Counts its calls.
		 * @param {unknown} value - The value
		 * @returns {boolean} Whether `value` is defined
		 */
		function second(value: unknown): value is unknown {
			calls++;

			return value !== undefined;
		}

		expect(issuesOf(chain(asInteger, second), 'x')).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: [] }]);
		expect(calls).toBe(0);
	});

	it('should validate its arguments', function () {
		expect(function () {
			chain(asInteger, 'x' as never);
		}).toThrow(new TypeError('chain: `second` must be a guard, a parser or a plain object of schemas, got string'));
		expect(function () {
			chain(1 as never, asInteger);
		}).toThrow(new TypeError('chain: `first` must be a guard, a parser or a plain object of schemas, got number'));
	});
});

describe('arrayOf', function () {
	it('should parse every element into a new array', function () {
		const input = ['1', '2', 3];
		const output = parse(arrayOf(asInteger), input);

		expect(output).toEqual([1, 2, 3]);
		expect(output).not.toBe(input);
		expect(parse(arrayOf({ id: asInteger }), [{ id: '1', x: 1 }])).toEqual([{ id: 1 }]);
		expect(parse(arrayOf(asInteger), [])).toEqual([]);
	});

	it('should parse holes as undefined', function () {
		// oxlint-disable-next-line no-sparse-arrays
		expect(parse(arrayOf(optional(asInteger)), [1, , 3])).toEqual([1, undefined, 3]);
	});

	it('should report every invalid element with its index', function () {
		expect(issuesOf({ ids: arrayOf(asInteger) }, { ids: ['1', 'x', 'y'] })).toEqual([
			{ message: 'Expected an integer or an integer string (got string)', path: ['ids', 1] },
			{ message: 'Expected an integer or an integer string (got string)', path: ['ids', 2] }
		]);
		expect(issuesOf(arrayOf(asInteger), { 0: '1', length: 1 })).toEqual([{ message: 'Expected an array (got object)', path: [] }]);
		expect(issuesOf(arrayOf(isString), ['a', 1])).toEqual([{ message: 'Invalid value (got number)', path: [1] }]);
	});

	it('should reject invalid schemas', function () {
		expect(function () {
			arrayOf([] as never);
		}).toThrow(new TypeError('arrayOf: `schema` must be a guard, a parser or a plain object of schemas, got array (use arrayOf for arrays)'));
	});
});

describe('asNumber', function () {
	it('should accept finite numbers and numeric strings', function () {
		expect(parse(asNumber, '42.5')).toBe(42.5);
		expect(parse(asNumber, ' -1e3 ')).toBe(-1000);
		expect(parse(asNumber, '.5')).toBe(0.5);
		expect(parse(asNumber, '+7')).toBe(7);
		expect(parse(asNumber, '\t3\n')).toBe(3);
		expect(parse(asNumber, 7)).toBe(7);
		expect(Object.is(parse(asNumber, '-0'), -0)).toBe(true);
		expect(Object.is(parse(asNumber, -0), -0)).toBe(true);
	});

	it('should reject what z.coerce.number() silently turns into 0, 1, NaN or a timestamp', function () {
		for (const value of [
			'',
			' ',
			'abc',
			'1,5',
			'0x1f',
			'0b1',
			'Infinity',
			'1e400',
			NaN,
			Infinity,
			-Infinity,
			null,
			undefined,
			true,
			false,
			new Date(0),
			1n,
			[],
			[1],
			{}
		]) {
			expect(issuesOf(asNumber, value)).toEqual([{ message: expect.stringMatching(/^Expected a number or a numeric string \(got \w+\)$/), path: [] }]);
		}
	});
});

describe('asInteger', function () {
	it('should accept safe integers and integer strings', function () {
		expect(parse(asInteger, '8080')).toBe(8080);
		expect(parse(asInteger, ' -3 ')).toBe(-3);
		expect(parse(asInteger, '+7')).toBe(7);
		expect(parse(asInteger, '007')).toBe(7);
		expect(parse(asInteger, String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
		expect(parse(asInteger, Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
	});

	it('should reject fractions, exponents, unsafe integers and non-numbers', function () {
		for (const value of ['1.5', '1.0', 1.5, '1e3', '', '-', 'abc', '0x10', '9007199254740992', 2 ** 53, NaN, Infinity, null, undefined, true, 1n, '١٢']) {
			expect(issuesOf(asInteger, value)).toEqual([{ message: expect.stringMatching(/^Expected an integer or an integer string \(got \w+\)$/), path: [] }]);
		}
	});
});

describe('asBoolean', function () {
	it('should map the usual spellings, ignoring case and surrounding whitespace', function () {
		for (const value of [true, 'true', 'TRUE', ' yes ', 'Yes', 'on', 'ON', '1', 1]) expect(parse(asBoolean, value)).toBe(true);
		for (const value of [false, 'false', 'False', 'no', ' NO ', 'off', '0', 0]) expect(parse(asBoolean, value)).toBe(false);
	});

	it('should reject anything else', function () {
		for (const value of ['', ' ', 'maybe', 'y', 'n', 't', 'f', '2', 2, -1, -0.5, NaN, null, undefined, new Boolean(true), [], {}, 1n]) {
			expect(issuesOf(asBoolean, value)).toHaveLength(1);
		}
	});
});

describe('asDate', function () {
	it('should return valid dates as they are, including dates of other realms', function () {
		const date = new Date(0);
		const foreign = vm.runInNewContext('new Date(5)');

		expect(parse(asDate, date)).toBe(date);
		expect(parse(asDate, foreign)).toBe(foreign);
	});

	it('should parse timestamps and ISO 8601 strings with an offset, or date-only (UTC)', function () {
		expect(parse(asDate, 0)).toEqual(new Date(0));
		expect(parse(asDate, 8.64e15)).toEqual(new Date(8.64e15));
		expect(parse(asDate, '2024-02-29T12:00:00Z')).toEqual(new Date(Date.UTC(2024, 1, 29, 12)));
		expect(parse(asDate, '2024-02-29T13:45:00.5+05:30')).toEqual(new Date(Date.UTC(2024, 1, 29, 8, 15, 0, 500)));
		expect(parse(asDate, '2024-01-01t00:00:00z')).toEqual(new Date(Date.UTC(2024, 0, 1)));
		expect(parse(asDate, ' 2024-01-05 ')).toEqual(new Date(Date.UTC(2024, 0, 5)));
	});

	it('should give the timestamp of new Date() for every ISO form', function () {
		for (const text of [
			'2024-02-29T13:45:00.1Z',
			'2024-02-29T13:45:00.12Z',
			'2024-02-29T13:45:00.123Z',
			'2024-02-29T13:45:00.123999Z',
			'2024-02-29T13:45:00+00:00',
			'2024-02-29T13:45:00-23:59',
			'2024-02-29T13:45:00+23:59',
			'0000-01-01T00:00:00Z',
			'0000-02-29',
			'0050-06-15',
			'1969-12-31T23:59:59.999Z',
			'1970-01-01',
			'1900-03-01',
			'2000-02-29T00:00:00z',
			'9999-12-31T23:59:59.999-23:59'
		]) {
			expect(parse(asDate, text).getTime()).toBe(new Date(text).getTime());
		}
	});

	it('should reject every malformed ISO string', function () {
		for (const text of [
			'2024/01/05',
			'2024-01/05',
			'2a24-01-05',
			'2024-0a-05',
			'2024-01-0a',
			'2024-00-05',
			'2024-13-05',
			'2024-01-00',
			'2024-04-31',
			'1900-02-29',
			'2024-01-05T',
			'2024-01-05X10:00:00Z',
			'2024-01-05T10-00:00Z',
			'2024-01-05T10:00-00Z',
			'2024-01-05T1a:00:00Z',
			'2024-01-05T24:00:00Z',
			'2024-01-05T10:60:00Z',
			'2024-01-05T10:00:60Z',
			'2024-01-05T10:00Z',
			'2024-01-05T10:00:00.Z',
			'2024-01-05T10:00:00',
			'2024-01-05T10:00:00ZZ',
			'2024-01-05T10:00:00X',
			'2024-01-05T10:00:00+0100',
			'2024-01-05T10:00:00+01:00:00',
			'2024-01-05T10:00:00+01-00',
			'2024-01-05T10:00:00+24:00',
			'2024-01-05T10:00:00+01:60',
			'2024-01-05T10:00:00+0a:00',
			'2024-01-05T10:00:00.5',
			'2024-01-05 10:00:00Z',
			'+002024-01-05'
		]) {
			expect(issuesOf(asDate, text)).toHaveLength(1);
		}
	});

	it('should reject invalid dates, impossible days, local times and loose formats', function () {
		for (const value of [
			new Date(NaN),
			vm.runInNewContext('new Date(NaN)'),
			8.64e15 + 1,
			NaN,
			Infinity,
			'2023-02-29',
			'2024-01-05T12:00:00',
			'01/05/2024',
			'',
			'now',
			null,
			undefined,
			true,
			1n,
			{}
		]) {
			expect(issuesOf(asDate, value)).toEqual([{ message: expect.stringMatching(/^Expected a valid date, an ISO 8601 string or a timestamp \(got \w+\)$/), path: [] }]);
		}
	});
});

describe('types', function () {
	it('should infer the output of nested schemas', function () {
		const schema = { a: withDefault(asInteger, 1), b: optional(asDate), c: { d: arrayOf(isString) } };
		const parsed: SchemaOutput<typeof schema> = parse(schema, { c: { d: [] } });
		const exact: { a: number; b?: Date | undefined; c: { d: string[] } } = parsed;
		const parser: Parser<number> = asInteger;

		expect(exact).toEqual({ a: 1, c: { d: [] } });
		expect(parser).toBe(asInteger);
	});
});
