import * as vm from 'vm';
import {
	explain,
	isArrayOf,
	isBoolean,
	isDiscriminatedUnion,
	isFunction,
	isIntegerInRange,
	isOptional,
	isShape,
	isString,
	isTuple,
	type Infer,
	type SchemaIssue
} from '../guards/index.js';
import {
	arrayOf,
	asInteger,
	asJson,
	blankAsUndefined,
	chain,
	discriminatedUnion,
	incrementSemver,
	lazy,
	nullable,
	optional,
	recordOf,
	parse,
	parseJson,
	safeParse,
	transform,
	tuple,
	union,
	withDefault,
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
 * Runs `fn` with `target[key]` set to `value`, restoring the property afterwards (assertions belong after the call, not inside `fn`).
 * @template T - What `fn` returns
 * @param {object} target - The object to pollute
 * @param {PropertyKey} key - The key
 * @param {unknown} value - The value
 * @param {() => T} fn - The code to run
 * @returns {T} What `fn` returned
 */
function polluted<T>(target: object, key: PropertyKey, value: unknown, fn: () => T): T {
	(target as Record<PropertyKey, unknown>)[key] = value;
	try {
		return fn();
	} finally {
		delete (target as Record<PropertyKey, unknown>)[key];
	}
}

/**
 * Runs `fn` and returns what it returns, or the error it throws.
 * @param {() => unknown} fn - The code to run
 * @returns {unknown} The result or the error
 */
function attempt(fn: () => unknown): unknown {
	try {
		return fn();
	} catch (error) {
		return error;
	}
}

describe('callable Standard Schema validators', function () {
	// ArkType's types are functions that return the data or an (always truthy) errors object, and carry `~standard`.
	const ark = Object.assign(
		function (data: unknown): unknown {
			return typeof data === 'number' ? data : { summary: 'must be a number' };
		},
		{
			'~standard': {
				version: 1 as const,
				vendor: 'arktype',
				validate: function (value: unknown) {
					return typeof value === 'number' ? { value } : { issues: [{ message: 'must be a number' }] };
				}
			}
		}
	);

	it('should be validated through ~standard, not called as guards', function () {
		expect(parse(ark, 1)).toBe(1);
		expect(issuesOf(ark, 'x')).toEqual([{ message: 'must be a number', path: [] }]);
		expect(issuesOf({ n: ark }, { n: 'x' })).toEqual([{ message: 'must be a number', path: ['n'] }]);
	});

	it('should accept a ~standard inherited from an ordinary prototype', function () {
		const validator = Object.create({ '~standard': ark['~standard'] }) as Schema;

		expect(parse({ n: validator }, { n: 2 })).toEqual({ n: 2 });
		expect(issuesOf({ n: validator }, { n: 'x' })).toEqual([{ message: 'must be a number', path: ['n'] }]);
	});
});

describe('two copies of the module', function () {
	let other: typeof import('.');

	beforeAll(function () {
		jest.isolateModules(function () {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			other = require('.') as typeof import('.');
		});
	});

	it('should agree on failures when the parsers of one are nested in the schemas of the other', function () {
		expect(other.asInteger).not.toBe(asInteger);
		expect(issuesOf(other.asInteger, 'abc')).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: [] }]);
		expect(issuesOf({ a: other.asInteger }, { a: 'abc' })).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: ['a'] }]);
		expect(issuesOf(arrayOf(other.optional(asInteger)), ['x'])).toEqual([{ message: 'Expected an integer or an integer string (got string)', path: [0] }]);
		expect(parse({ a: other.asInteger, b: arrayOf(other.asInteger) }, { a: '1', b: ['2'] })).toEqual({ a: 1, b: [2] });
		expect(other.parse({ a: asInteger }, { a: '3' })).toEqual({ a: 3 });
	});
});

describe('brand properties', function () {
	it('should ignore a polluted Object.prototype["~tink"]', function () {
		const results = polluted(Object.prototype, '~tink.1', { fast: String, run: String }, function () {
			return [
				attempt(function () {
					return parse(isString, 'a');
				}),
				issuesOf({ admin: isBoolean }, { admin: 'yes', extra: 1 })
			];
		});

		expect(results).toEqual(['a', [{ message: 'Invalid value (got string)', path: ['admin'] }]]);
		expect(
			polluted(Object.prototype, '~tink.1', true, function () {
				return attempt(function () {
					return parse(isString, 'b');
				});
			})
		).toBe('b');
	});

	it('should ignore a polluted Object.prototype or Function.prototype "~standard"', function () {
		const accept = {
			version: 1,
			vendor: 'evil',
			validate: function (value: unknown) {
				return { value };
			}
		};
		const objectResult = polluted(Object.prototype, '~standard', accept, function () {
			return issuesOf({ admin: isBoolean }, { admin: 'yes' });
		});
		const functionResult = polluted(Function.prototype, '~standard', accept, function () {
			return issuesOf({ admin: isBoolean }, { admin: 'yes' });
		});

		expect(objectResult).toEqual([{ message: 'Invalid value (got string)', path: ['admin'] }]);
		expect(functionResult).toEqual([{ message: 'Invalid value (got string)', path: ['admin'] }]);
	});

	it('should treat "~tink" and "~standard" keys of object schemas as ordinary keys', function () {
		expect(parse({ '~tink.1': isString }, { '~tink.1': 'a' })).toEqual({ '~tink.1': 'a' });
		expect(parse({ '~tink.1': { fast: isFunction } }, { '~tink.1': { fast: String } })).toEqual({ '~tink.1': { fast: String } });
		expect(parse({ '~standard': { validate: isString } }, { '~standard': { validate: 'x' } })).toEqual({ '~standard': { validate: 'x' } });
		expect(parse({ '~standard': { version: isString, validate: isFunction } }, { '~standard': { version: '1', validate: String } })).toEqual({
			'~standard': { version: '1', validate: String }
		});
	});
});

describe('JSON parsing under prototype pollution', function () {
	it('should finish scanning for prototype keys when Object.prototype holds an object', function () {
		polluted(Object.prototype, 'polluted', {}, function () {
			expect(parseJson('{"a":"\\u0041"}')).toEqual([undefined, { a: 'A' }]);
			expect(parseJson('{"constructor":1}', { proto: 'remove' })).toEqual([undefined, { constructor: 1 }]);
			expect(safeParse(asJson({}), '{"a":"\\u00e9"}')).toEqual([undefined, {}]);
		});
	});
});

describe('array holes under prototype pollution', function () {
	// oxlint-disable-next-line no-sparse-arrays
	const sparse = [, 'b'];

	it('should read holes as undefined even when Array.prototype has that index', function () {
		const results = polluted(Array.prototype, 0, 'polluted', function () {
			return [
				parse(arrayOf(optional(isString)), sparse),
				parse(tuple(optional(isString), isString), sparse),
				isArrayOf(isOptional(isString))(sparse),
				isTuple(isOptional(isString), isString)(sparse),
				issuesOf(arrayOf(isString), sparse),
				issuesOf(tuple(isString, isString), sparse),
				explain(isArrayOf(isString), sparse),
				explain(isTuple(isString, isString), sparse)
			];
		});
		const hole = [{ message: 'Invalid value (got undefined)', path: [0] }];

		expect(results).toEqual([[undefined, 'b'], [undefined, 'b'], true, true, hole, hole, hole, hole]);
	});

	it('should read holes as undefined even when Object.prototype has that index', function () {
		const results = polluted(Object.prototype, 1, 'x', function () {
			return [parse(arrayOf(withDefault(isString, 'd')), new Array(2)), isArrayOf(isOptional(isBoolean))(new Array(2))];
		});

		expect(results).toEqual([['d', 'd'], true]);
	});
});

describe('code generation failures', function () {
	const original = globalThis.Function;

	/**
	 * Loads a fresh copy of the module, which has not compiled an object schema yet.
	 * @returns {typeof import('.')} The module
	 */
	function freshModule(): typeof import('.') {
		let fresh: typeof import('.') | undefined;

		jest.isolateModules(function () {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			fresh = require('.') as typeof import('.');
		});

		return fresh as typeof import('.');
	}

	afterEach(function () {
		globalThis.Function = original;
	});

	it('should keep generating code after an error other than EvalError', function () {
		const fresh = freshModule();
		let calls = 0;

		globalThis.Function = function (...args: string[]): unknown {
			if (calls++ === 0) throw new RangeError('Maximum call stack size exceeded');

			return original(...args);
		} as unknown as FunctionConstructor;

		expect(fresh.parse({ a: fresh.asInteger }, { a: '1' })).toEqual({ a: 1 });
		expect(fresh.parse({ b: fresh.asInteger }, { b: '2' })).toEqual({ b: 2 });
		expect(calls).toBe(2);
	});

	it('should stop generating code after an EvalError', function () {
		const fresh = freshModule();
		let calls = 0;

		globalThis.Function = function (): never {
			calls++;
			throw new EvalError('Code generation from strings disallowed for this context');
		} as unknown as FunctionConstructor;

		expect(fresh.parse({ a: fresh.asInteger }, { a: '1' })).toEqual({ a: 1 });
		expect(fresh.parse({ b: fresh.asInteger }, { b: '2' })).toEqual({ b: 2 });
		expect(calls).toBe(1);
	});
});

describe('missing properties whose schema handles undefined', function () {
	const level = chain(withDefault(asInteger, 5), isIntegerInRange(10, 20));

	it('should report the genuine issue of a default that fails a later check', function () {
		const expected = [{ message: 'Expected an integer between 10 and 20 (got 5)', path: ['level'] }];

		expect(issuesOf({ level }, {})).toEqual(expected);
		expect(issuesOf({ level: chain(transform(withDefault(asInteger, 5), Number), isIntegerInRange(10, 20)) }, {})).toEqual(expected);
		expect(issuesOf({ level: chain(union(withDefault(asInteger, 5)), isIntegerInRange(10, 20)) }, {})).toEqual(expected);
		expect(issuesOf({ level: chain(nullable(withDefault(asInteger, 5)), isIntegerInRange(10, 20)) }, {})).toEqual(expected);
		expect(issuesOf({ level: blankAsUndefined(level) }, { level: ' ' })).toEqual(expected);
		expect(
			issuesOf(
				{
					level: chain(
						lazy(function () {
							return withDefault(asInteger, 5);
						}),
						isIntegerInRange(10, 20)
					)
				},
				{}
			)
		).toEqual(expected);
	});

	it('should still sum up other missing properties as missing', function () {
		expect(issuesOf({ level: chain(asInteger, isIntegerInRange(10, 20)) }, {})).toEqual([{ message: 'Missing required property', path: ['level'] }]);
		expect(issuesOf({ level: union(asInteger, isString) }, {})).toEqual([{ message: 'Missing required property', path: ['level'] }]);
	});
});

describe('numeric discriminants', function () {
	it('should type numeric variant keys as their string tags', function () {
		const version = discriminatedUnion('v', { 1: { name: isString }, 2: { name: isString, tags: arrayOf(isString) } });
		const parsed: SchemaOutput<typeof version> = parse(version, { v: '2', name: 'a', tags: [] });
		const tag: '1' | '2' = parsed.v;

		expect(tag).toBe('2');
	});

	it('should type numeric variant keys of the guards module as their string tags', function () {
		const isVersion = isDiscriminatedUnion('v', { 1: isShape({ name: isString }) });
		const value: Infer<typeof isVersion> = { v: '1', name: 'a' };

		expect(isVersion(value)).toBe(true);
	});
});

describe('reporting recursive values', function () {
	it('reports an invalid deep lazy value in linear time', function () {
		let calls = 0;
		function isNumberCounted(value: unknown): value is number {
			calls++;
			return typeof value === 'number';
		}
		const tree: Schema = lazy(function () {
			return { v: isNumberCounted, kids: arrayOf(tree) };
		});
		let node: unknown = { v: 'bad', kids: [] };
		for (let i = 0; i < 800; i++) node = { v: 1, kids: [node] };
		expect(safeParse(tree, node)[0]?.issues).toHaveLength(1);
		expect(calls).toBeLessThan(10_000);
	});

	it('rejects a lazy schema that resolves to itself', function () {
		const self: Schema = lazy(function () {
			return self;
		});
		expect(function () {
			safeParse(self, 1);
		}).toThrow(new TypeError('lazy: `getter` must not resolve to (or parse with) this lazy schema itself'));

		const reentrant: Schema = lazy(function () {
			parse(reentrant, 1);
			return isString;
		});
		expect(function () {
			parse(reentrant, 'x');
		}).toThrow(new TypeError('lazy: `getter` must not resolve to (or parse with) this lazy schema itself'));
	});
});

describe('outputs and arrays under hardened or foreign prototypes', function () {
	it('defines keys that the output would inherit read-only', function () {
		const proto = Object.prototype as Record<string, unknown>;
		const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toString') as PropertyDescriptor;
		Object.defineProperty(Object.prototype, 'toString', { ...original, writable: false });
		try {
			expect(safeParse(recordOf(isString), JSON.parse('{"toString":"x"}'))).toEqual([undefined, { toString: 'x' }]);
			expect(typeof proto.toString).toBe('function');
		} finally {
			Object.defineProperty(Object.prototype, 'toString', original);
		}
	});

	it('reads the holes of arrays from other realms as undefined', function () {
		const foreign = vm.runInNewContext('Array.prototype[0] = "evil"; [, "b"]') as unknown[];
		expect(safeParse(arrayOf(optional(isString)), foreign)).toEqual([undefined, [undefined, 'b']]);
		expect(safeParse(tuple(optional(isString), isString), foreign)).toEqual([undefined, [undefined, 'b']]);
	});

	it('defines inherited keys when Object.prototype holds a get or a set', function () {
		const getter = polluted(Object.prototype, 'get', String, function () {
			return [
				safeParse(recordOf(asInteger), JSON.parse('{"constructor":"1","toString":2}')),
				safeParse({ get: asInteger }, { get: '3' }),
				safeParse(discriminatedUnion('constructor', { a: { set: asInteger } }), { constructor: 'a', set: '4' })
			];
		});
		const setter = polluted(Object.prototype, 'set', String, function () {
			return safeParse(recordOf(asInteger), { constructor: 5 });
		});

		expect(getter).toEqual([
			[undefined, { constructor: 1, toString: 2 }],
			[undefined, { get: 3 }],
			[undefined, { constructor: 'a', set: 4 }]
		]);
		expect(setter).toEqual([undefined, { constructor: 5 }]);
	});
});

describe('compiled schemas under prototype pollution', function () {
	it('should ignore an Object.prototype holding the names of optional hooks', function () {
		/**
		 * Compiles and runs parses that read the optional hooks of nodes (`missing`, `handlesMissing`, `score`).
		 * @returns {unknown[]} The results
		 */
		function run(): unknown[] {
			return [
				safeParse({ a: asInteger, b: optional(isString) }, { a: '1', b: 'x' }),
				issuesOf({ a: asInteger, b: optional(isString) }, { b: 1 }),
				issuesOf(union({ a: asInteger, c: isString }, { b: isString }), { b: 1 }),
				issuesOf(union(asInteger, { b: isString }), 'x'),
				issuesOf(arrayOf(withDefault(asInteger, 0)), [undefined, 'x'])
			];
		}
		const expected = run();

		expect(expected).toEqual([
			[undefined, { a: 1, b: 'x' }],
			[
				{ message: 'Missing required property', path: ['a'] },
				{ message: 'Invalid value (got number)', path: ['b'] }
			],
			[{ message: 'Invalid value (got number)', path: ['b'] }],
			[{ message: 'Expected an integer or an integer string (got string)', path: [] }],
			[{ message: 'Expected an integer or an integer string (got string)', path: [1] }]
		]);
		// Compiled while polluted: a node without the hook read the planted value, and every parse threw a `TypeError`.
		for (const key of ['missing', 'handlesMissing', 'score']) expect(polluted(Object.prototype, key, 'planted', run)).toEqual(expected);
	});

	it('should not read the issues of a Standard Schema result from Object.prototype', function () {
		const foreign: Schema = {
			'~standard': {
				version: 1,
				vendor: 'foreign',
				validate: function validate(value: unknown) {
					return typeof value === 'number' ? { value: value * 2 } : { issues: [{ message: 'Not a number' }] };
				}
			}
		};
		// The planted string was iterated as the issues of every success: valid values failed, one issue per character.
		const results = polluted(Object.prototype, 'issues', 'planted', function () {
			return [safeParse({ a: foreign }, { a: 2 }), issuesOf({ a: foreign }, { a: 'x' })];
		});

		expect(results).toEqual([[undefined, { a: 4 }], [{ message: 'Not a number', path: ['a'] }]]);
	});
});

describe('semver under prototype pollution', function () {
	it('should not read pre-release identifiers past the end from Object.prototype', function () {
		// `beta` bumps to `beta.0`, which is shorter than the wanted `beta.0` plus a counter: index 2 is past its end.
		const result = polluted(Object.prototype, 2, 7, function () {
			return incrementSemver('1.2.4-beta', 'prerelease', { identifier: 'beta.0' });
		});

		expect(result).toBe('1.2.4-beta.0.0');
	});
});
