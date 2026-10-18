import fc from 'fast-check';

import { isArrayOf, isInteger, isShape, isString, ValidationError, type JsonValue } from '../guards/index.js';
import { attempt, type Result } from '../functions/index.js';
import { parseJson, type ParseJsonResult } from '.';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

const HOSTILE = '{"__proto__":{"x":1},"constructor":{"prototype":{"x":1}}}';

function assertNotPolluted(): void {
	expect(({} as Record<string, unknown>).x).toBeUndefined();
	expect((Object.prototype as unknown as Record<string, unknown>).x).toBeUndefined();
}

describe('parseJson', function () {
	it('should parse valid JSON into [undefined, value]', function () {
		expect(parseJson('{"a":[1,2,{"b":null}]}')).toEqual([undefined, { a: [1, 2, { b: null }] }]);
		expect(parseJson('"text"')).toEqual([undefined, 'text']);
		expect(parseJson(' 1 ')).toEqual([undefined, 1]);
		expect(parseJson('null')).toEqual([undefined, null]);
	});

	it('should return a SyntaxError for invalid JSON, never the raw text', function () {
		for (const text of ['{bad', '', "{'a':1}", 'undefined', 'NaN', '{"a":1,}', '1 2']) {
			const [error, value] = parseJson(text);

			expect(error).toBeInstanceOf(SyntaxError);
			expect(value).toBeUndefined();
		}
	});

	it('should return a TypeError for non-string text instead of coercing it', function () {
		for (const text of [null, 1, undefined, {}, ['1']]) {
			const [error, value] = parseJson(text as never);

			expect(error).toBeInstanceOf(TypeError);
			expect(value).toBeUndefined();
		}
		expect(parseJson(null as never)[0]?.message).toBe('parseJson: `text` must be a string, got null');
	});

	it('should match the Result tuple of attempt', function () {
		const result: Result<JsonValue> = parseJson('[1]');
		const typed: Equal<ParseJsonResult<number>[0], SyntaxError | TypeError | ValidationError | undefined> = true;

		expect(typed).toBe(true);
		expect(result).toEqual(attempt(JSON.parse, '[1]'));
	});

	describe('prototype keys', function () {
		it("should fail by default, like secure-json-parse ('error')", function () {
			for (const text of [
				'{"__proto__":{"admin":true}}',
				'{"a":[{"b":{"__proto__":null}}]}',
				'[{"__proto__":1}]',
				'{"\\u005f_proto__":{"admin":true}}',
				'{"__pr\\u006fto__":{}}'
			]) {
				const [error, value] = parseJson(text);

				expect(error).toBeInstanceOf(SyntaxError);
				expect(error?.message).toBe('parseJson: JSON contains a forbidden "__proto__" key');
				expect(value).toBeUndefined();
			}
			for (const text of ['{"constructor":{"prototype":{"admin":true}}}', '[[{"\\u0063onstructor":{"prototype":null}}]]']) {
				expect(parseJson(text)[0]?.message).toBe('parseJson: JSON contains a forbidden "constructor.prototype" key');
			}
		});

		it('should accept benign constructor keys and look-alike text', function () {
			expect(parseJson('{"constructor":"Ford"}')).toEqual([undefined, { constructor: 'Ford' }]);
			expect(parseJson('{"constructor":{"name":"x"}}')).toEqual([undefined, { constructor: { name: 'x' } }]);
			expect(parseJson('{"constructor":[1]}')).toEqual([undefined, { constructor: [1] }]);
			expect(parseJson('{"constructor":null}')).toEqual([undefined, { constructor: null }]);
			expect(parseJson('{"a":"__proto__"}')).toEqual([undefined, { a: '__proto__' }]);
			expect(parseJson('["constructor", {"prototype": 1}]')).toEqual([undefined, ['constructor', { prototype: 1 }]]);
			expect(parseJson('"\\u0041"')).toEqual([undefined, 'A']);
			expect(parseJson('"__proto__"')).toEqual([undefined, '__proto__']);
		});

		it("should delete the forbidden keys with 'remove'", function () {
			const [error, value] = parseJson('{"a":1,"__proto__":{"x":1},"b":{"constructor":{"prototype":{}},"c":[{"\\u005f_proto__":2}]}}', { proto: 'remove' });

			expect(error).toBeUndefined();
			expect(value).toEqual({ a: 1, b: { c: [{}] } });
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
			expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(false);
		});

		it("should keep them as own data properties with 'ignore'", function () {
			const [, value] = parseJson('{"__proto__":{"x":1}}', { proto: 'ignore' });

			expect(Object.prototype.hasOwnProperty.call(value, '__proto__')).toBe(true);
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		});

		it('should never pollute a prototype, whatever the mode', function () {
			expect(parseJson(HOSTILE)[0]).toBeInstanceOf(SyntaxError);
			expect(parseJson(HOSTILE, { proto: 'remove' })).toEqual([undefined, {}]);

			const [, kept] = parseJson(HOSTILE, { proto: 'ignore' });

			expect(Object.keys(kept as object)).toEqual(['__proto__', 'constructor']);
			assertNotPolluted();
		});

		it('should check deep values without overflowing the stack', function () {
			const depth = 50_000;
			const text = `${'{"a":'.repeat(depth)}{"__proto__":1}${'}'.repeat(depth)}`;

			expect(parseJson(text)[0]?.message).toBe('parseJson: JSON contains a forbidden "__proto__" key');
			expect(parseJson(`${'['.repeat(depth)}"constructor"${']'.repeat(depth)}`)[0]).toBeUndefined();
		});
	});

	describe('with a guard', function () {
		const isConfig = isShape({ port: isInteger, hosts: isArrayOf(isString) });

		it('should return the typed value when it passes', function () {
			const result = parseJson('{"port":8080,"hosts":["a"]}', isConfig);
			const typed: Equal<typeof result, ParseJsonResult<{ port: number; hosts: string[] }>> = true;

			expect(typed).toBe(true);
			expect(result).toEqual([undefined, { port: 8080, hosts: ['a'] }]);
		});

		it('should return a ValidationError carrying the explained issues', function () {
			const [error, value] = parseJson('{"port":"80","hosts":["a",1]}', isConfig);

			expect(value).toBeUndefined();
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).issues).toEqual([
				{ message: 'Invalid value (got string)', path: ['port'] },
				{ message: 'Invalid value (got number)', path: ['hosts', 1] }
			]);
		});

		it('should check syntax and prototype keys before the guard', function () {
			const guard = jest.fn(isConfig) as unknown as typeof isConfig;

			expect(parseJson('{', guard)[0]).toBeInstanceOf(SyntaxError);
			expect(parseJson('{"__proto__":{}}', guard)[0]).toBeInstanceOf(SyntaxError);
			expect(guard).not.toHaveBeenCalled();
		});

		it('should accept options after the guard', function () {
			expect(parseJson('{"port":1,"hosts":[],"__proto__":{}}', isConfig, { proto: 'remove' })).toEqual([undefined, { port: 1, hosts: [] }]);
			expect(parseJson('{"port":1,"hosts":[]}', undefined as never, { proto: 'remove' })).toEqual([undefined, { port: 1, hosts: [] }]);
		});
	});

	it('should throw for invalid options (programming errors)', function () {
		expect(function () {
			parseJson('1', { proto: 'drop' as never });
		}).toThrow(new RangeError("parseJson: `proto` must be 'error', 'remove' or 'ignore', got drop"));
		expect(function () {
			parseJson('1', 'x' as never);
		}).toThrow(new TypeError('parseJson: `options` must be an object, got string'));
		expect(function () {
			parseJson('1', isString, null as never);
		}).toThrow(new TypeError('parseJson: `options` must be an object, got null'));
		expect(parseJson('1', {})).toEqual([undefined, 1]);
	});
});

describe('parseJson (properties)', function () {
	it('never throws and agrees with JSON.parse on any text', function () {
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.json()), function (text: string) {
				const [error, value] = parseJson(text, { proto: 'ignore' });
				const [expectedError, expected] = attempt(JSON.parse, text);

				if (expectedError === undefined) expect([error, value]).toEqual([undefined, expected]);
				else expect(error).toBeInstanceOf(SyntaxError);
			})
		);
	});

	it('round-trips JSON values, failing only on prototype keys', function () {
		fc.assert(
			fc.property(fc.jsonValue(), function (value: unknown) {
				const text = JSON.stringify(value);
				const [error, parsed] = parseJson(text);

				if (error === undefined) expect(JSON.stringify(parsed)).toBe(text);
				else expect(text).toMatch(/__proto__|constructor/);
			})
		);
	});

	it("'remove' leaves no forbidden key and keeps every other one", function () {
		fc.assert(
			fc.property(
				fc.jsonValue().map(function (value: unknown): string {
					const json = JSON.stringify(value);

					return `{"__proto__":${json},"constructor":{"prototype":${json}},"data":${json},"list":[{"\\u005f_proto__":${json}}]}`;
				}),
				function (text: string) {
					const [error, parsed] = parseJson(text, { proto: 'remove' });
					const reference = JSON.parse(text, function (key: string, item: unknown): unknown {
						if (key === '__proto__') return undefined;
						if (key === 'constructor' && typeof item === 'object' && item !== null && Object.prototype.hasOwnProperty.call(item, 'prototype')) return undefined;

						return item;
					});

					expect(error).toBeUndefined();
					expect(parseJson(JSON.stringify(parsed))[0]).toBeUndefined();
					expect(parsed).toEqual(reference);
				}
			)
		);
	});
});
