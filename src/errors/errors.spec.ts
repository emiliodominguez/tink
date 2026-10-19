import * as vm from 'vm';
import { AbortError, TimeoutError } from '../async/index.js';
import { AssertionError, ValidationError } from '../guards/index.js';
import { JsonPatchError } from '../objects/index.js';
import { deserializeError, getErrorMessage, isErrorLike, serializeError, toError } from '.';

/** A revoked proxy: every operation on it throws. */
function revoked(): object {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();
	return proxy;
}

/** An object whose `message` and `name` getters throw. */
const throwingGetters = {
	get message(): string {
		throw new Error('message getter');
	},
	get name(): string {
		throw new Error('name getter');
	}
};

/** A chain of `depth` plain serialized errors, each the cause of the previous one (built iteratively). */
function serializedChain(depth: number): Record<string, unknown> {
	const root: Record<string, unknown> = { name: 'Error', message: '0' };
	let current = root;
	for (let index = 1; index < depth; index++) {
		const next = { name: 'Error', message: String(index) };
		current.cause = next;
		current = next;
	}
	return root;
}

describe('errors', function () {
	describe('isErrorLike', function () {
		it('accepts errors (of any realm) and objects with a string name and message', function () {
			expect(isErrorLike(new Error('x'))).toBe(true);
			expect(isErrorLike(new TypeError())).toBe(true);
			expect(isErrorLike(vm.runInNewContext('new RangeError("x")'))).toBe(true);
			expect(isErrorLike({ name: 'HttpError', message: 'Not found' })).toBe(true);
			expect(isErrorLike(Object.assign(Object.create(null), { name: '', message: '' }))).toBe(true);
			expect(isErrorLike(Object.create({ name: 'Inherited', message: 'from a class' }))).toBe(true);
		});

		it('rejects anything else without throwing', function () {
			expect(isErrorLike({ message: 'x' })).toBe(false);
			expect(isErrorLike({ name: 'x' })).toBe(false);
			expect(isErrorLike({ name: 1, message: 'x' })).toBe(false);
			expect(isErrorLike('x')).toBe(false);
			expect(isErrorLike(null)).toBe(false);
			expect(isErrorLike(undefined)).toBe(false);
			expect(isErrorLike(Object.assign(function () {}, { message: 'x' }))).toBe(false);
			expect(isErrorLike(throwingGetters)).toBe(false);
			expect(isErrorLike(revoked())).toBe(false);
		});

		it('ignores values inherited from a polluted Object.prototype', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.name = 'Polluted';
			prototype.message = 'polluted';
			try {
				expect(isErrorLike({})).toBe(false);
				expect(isErrorLike({ name: 'Own', message: 'own' })).toBe(true);
			} finally {
				delete prototype.name;
				delete prototype.message;
			}
		});
	});

	describe('getErrorMessage', function () {
		it('reads the message of errors and error-like objects', function () {
			expect(getErrorMessage(new Error('Disk full'))).toBe('Disk full');
			expect(getErrorMessage(vm.runInNewContext('new TypeError("foreign")'))).toBe('foreign');
			expect(getErrorMessage({ message: 'Not found', status: 404 })).toBe('Not found');
			expect(getErrorMessage(Object.assign(Object.create(null), { message: 'bare' }))).toBe('bare');
		});

		it('returns a non-empty string as it is', function () {
			expect(getErrorMessage('Timed out')).toBe('Timed out');
			expect(getErrorMessage('Timed out', 'fallback')).toBe('Timed out');
		});

		it('uses the fallback when there is no message', function () {
			expect(getErrorMessage(null, 'Unknown error')).toBe('Unknown error');
			expect(getErrorMessage('', 'Unknown error')).toBe('Unknown error');
			expect(getErrorMessage(new Error(), 'Unknown error')).toBe('Unknown error');
			expect(getErrorMessage({ message: 42 }, 'Unknown error')).toBe('Unknown error');
			expect(getErrorMessage(42, '')).toBe('');
		});

		it('describes values without a message', function () {
			expect(getErrorMessage('')).toBe('');
			expect(getErrorMessage(42)).toBe('42');
			expect(getErrorMessage(null)).toBe('null');
			expect(getErrorMessage(undefined)).toBe('undefined');
			expect(getErrorMessage(true)).toBe('true');
			expect(getErrorMessage(10n)).toBe('10n');
			expect(getErrorMessage(Symbol('s'))).toBe('Symbol(s)');
			expect(getErrorMessage({ code: 'E_LOCKED' })).toBe('{"code":"E_LOCKED"}');
			expect(getErrorMessage([1, 'a'])).toBe('[1,"a"]');
			expect(getErrorMessage(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
			expect(getErrorMessage(new Error())).toBe('Error');
			expect(getErrorMessage(new TimeoutError(''))).toBe('TimeoutError');
			expect(getErrorMessage(new URL('https://example.com/'))).toBe('https://example.com/');
			expect(getErrorMessage({ toJSON: function () {} })).toBe('[object Object]');
		});

		it('describes functions by their tag, never by their source', function () {
			expect(
				getErrorMessage(function secret() {
					return 'password';
				})
			).toBe('[object Function]');
			expect(getErrorMessage(async function () {})).toBe('[object AsyncFunction]');
		});

		it('never throws for hostile values', function () {
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			expect(getErrorMessage(cyclic)).toBe('[object Object]');
			expect(getErrorMessage(throwingGetters)).toBe('[object Object]');
			expect(getErrorMessage(Object.create(null))).toBe('{}');
			const bare = Object.create(null);
			bare.self = bare;
			expect(getErrorMessage(bare)).toBe('[object Object]');
			const throwingToString = {
				toString(): string {
					throw new Error('toString');
				}
			};
			expect(getErrorMessage(Object.setPrototypeOf(throwingToString, Object.create(null)))).toBe('[object Object]');
			expect(getErrorMessage(revoked())).toBe('object');
			expect(getErrorMessage(revoked(), 'fallback')).toBe('fallback');
		});

		it('validates the fallback', function () {
			expect(function () {
				getErrorMessage('x', 1 as never);
			}).toThrow(new TypeError('getErrorMessage: `fallback` must be a string, got number'));
			expect(function () {
				getErrorMessage('x', null as never);
			}).toThrow(new TypeError('getErrorMessage: `fallback` must be a string, got null'));
		});
	});

	describe('toError', function () {
		it('returns errors as they are, including other realms, subclasses and DOMExceptions', function () {
			const errors = [
				new Error('x'),
				new TypeError('x'),
				new AggregateError([], 'x'),
				new AbortError(),
				new ValidationError([{ message: 'x', path: [] }]),
				vm.runInNewContext('new SyntaxError("x")'),
				new DOMException('x', 'AbortError')
			];
			for (const error of errors) expect(toError(error)).toBe(error);
		});

		it('wraps anything else, keeping it as the cause', function () {
			const wrapped = toError('Timed out');
			expect(wrapped).toBeInstanceOf(Error);
			expect(wrapped.message).toBe('Timed out');
			expect(wrapped.name).toBe('Error');
			expect(wrapped.cause).toBe('Timed out');
			expect(Object.keys(wrapped)).toEqual([]);

			const object = { code: 1 };
			expect(toError(object).cause).toBe(object);
			expect(toError(object).message).toBe('{"code":1}');
			expect(toError(null).message).toBe('null');
			expect(toError(null).cause).toBeNull();
			expect(Object.prototype.hasOwnProperty.call(toError(undefined), 'cause')).toBe(true);
			expect(toError(10n).message).toBe('10n');
			const symbol = Symbol('s');
			expect(toError(symbol).message).toBe('Symbol(s)');
			expect(toError(symbol).cause).toBe(symbol);
		});

		it('keeps the name of error-like objects', function () {
			const error = toError({ name: 'AbortError', message: 'Aborted' });
			expect(error.name).toBe('AbortError');
			expect(error.message).toBe('Aborted');
			expect(Object.keys(error)).toEqual([]);
			expect(Object.prototype.hasOwnProperty.call(toError({ name: 'Error', message: 'x' }), 'name')).toBe(false);
			expect(toError({ name: '', message: 'x' }).name).toBe('Error');
			expect(toError({ name: 'NotErrorLike' }).name).toBe('Error');
		});

		it('never throws, even when getters change their minds', function () {
			expect(toError(throwingGetters).message).toBe('[object Object]');
			expect(toError(revoked()).message).toBe('object');
			let reads = 0;
			const fickle = {
				message: 'x',
				get name(): string {
					reads++;
					if (reads > 1) throw new Error('second read');
					return 'First';
				}
			};
			expect(toError(fickle).name).toBe('Error');
		});
	});

	describe('serializeError', function () {
		it('serializes name, message, stack and cause', function () {
			const cause = new Error('Limit: 10');
			const error = new RangeError('Too big', { cause });
			const serialized = serializeError(error);
			expect(serialized).toEqual({
				name: 'RangeError',
				message: 'Too big',
				stack: error.stack,
				cause: { name: 'Error', message: 'Limit: 10', stack: cause.stack }
			});
			expect(Object.keys(serialized)).toEqual(['name', 'message', 'stack', 'cause']);
			expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
		});

		it('leaves stacks out with stack: false', function () {
			expect(serializeError(new Error('x', { cause: new Error('y') }), { stack: false })).toEqual({
				name: 'Error',
				message: 'x',
				cause: { name: 'Error', message: 'y' }
			});
			expect(serializeError(new Error('x'), { stack: true }).stack).toEqual(expect.any(String));
		});

		it('serializes code (even non-enumerable) and other own enumerable properties', function () {
			const error = Object.assign(new Error('Missing'), { code: 'ENOENT', errno: -2, path: '/tmp/x' });
			expect(serializeError(error, { stack: false })).toEqual({ name: 'Error', message: 'Missing', code: 'ENOENT', errno: -2, path: '/tmp/x' });
			const hidden = new Error('x');
			Object.defineProperty(hidden, 'code', { value: 'E_HIDDEN', enumerable: false });
			Object.defineProperty(hidden, 'secret', { value: 'not enumerable', enumerable: false });
			expect(serializeError(hidden, { stack: false })).toEqual({ name: 'Error', message: 'x', code: 'E_HIDDEN' });
		});

		it('serializes the errors of an AggregateError', function () {
			const error = new AggregateError([new TypeError('a'), 'b', { c: 1 }], 'Many');
			expect(serializeError(error, { stack: false })).toEqual({
				name: 'AggregateError',
				message: 'Many',
				errors: [{ name: 'TypeError', message: 'a' }, 'b', { c: 1 }]
			});
		});

		it('serializes the error classes of the other modules', function () {
			expect(serializeError(new TimeoutError(), { stack: false })).toEqual({ name: 'TimeoutError', message: 'The operation timed out.' });
			expect(serializeError(new AssertionError('boom'), { stack: false })).toEqual({ name: 'AssertionError', message: 'boom' });
			expect(serializeError(new ValidationError([{ message: 'Bad', path: ['id'] }]), { stack: false })).toEqual({
				name: 'ValidationError',
				message: 'id: Bad',
				issues: [{ message: 'Bad', path: ['id'] }]
			});
			const operation = { op: 'test', path: '/a', value: 2 } as const;
			expect(serializeError(new JsonPatchError('Test failed', 0, operation), { stack: false })).toEqual({
				name: 'JsonPatchError',
				message: 'Test failed',
				index: 0,
				operation: { op: 'test', path: '/a', value: 2 }
			});
		});

		it('recognises errors without Error.isError', function () {
			const native = Object.getOwnPropertyDescriptor(Error, 'isError');
			delete (Error as { isError?: unknown }).isError;
			try {
				expect(serializeError(new TypeError('x'), { stack: false })).toEqual({ name: 'TypeError', message: 'x' });
				expect(toError({ name: 'X', message: 'y' })).toBeInstanceOf(Error);
			} finally {
				if (native) Object.defineProperty(Error, 'isError', native);
			}
		});

		it('serializes errors of other realms and DOMExceptions', function () {
			expect(serializeError(vm.runInNewContext('new TypeError("foreign")'), { stack: false })).toEqual({ name: 'TypeError', message: 'foreign' });
			expect(serializeError(new DOMException('Stop', 'AbortError'), { stack: false })).toEqual({ name: 'AbortError', message: 'Stop' });
		});

		it('converts values as JSON.stringify would, never throwing', function () {
			const error = Object.assign(new Error('x'), {
				big: 10n,
				when: new Date(0),
				nothing: undefined,
				fn: function () {},
				symbol: Symbol('s'),
				nan: NaN,
				zero: -0,
				list: [undefined, function () {}, Infinity],
				tags: new Set(['a']),
				lookup: new Map([['k', 1]]),
				boxed: new String('s')
			});
			expect(serializeError(error, { stack: false })).toEqual({
				name: 'Error',
				message: 'x',
				big: '10',
				when: '1970-01-01T00:00:00.000Z',
				nan: null,
				zero: 0,
				list: [null, null, null],
				tags: ['a'],
				lookup: [['k', 1]],
				boxed: 's'
			});
		});

		it('marks circular references, keeping shared ones', function () {
			const loop = new Error('Loop');
			loop.cause = loop;
			expect(serializeError(loop, { stack: false })).toEqual({ name: 'Error', message: 'Loop', cause: '[Circular]' });

			const a = new Error('a');
			const b = new Error('b', { cause: a });
			a.cause = b;
			expect(serializeError(a, { stack: false })).toEqual({ name: 'Error', message: 'a', cause: { name: 'Error', message: 'b', cause: '[Circular]' } });

			const shared = { x: 1 };
			expect(serializeError(Object.assign(new Error('s'), { first: shared, second: shared }), { stack: false })).toEqual({
				name: 'Error',
				message: 's',
				first: { x: 1 },
				second: { x: 1 }
			});
		});

		it('marks throwing getters and toJSON methods', function () {
			const error = new Error('x');
			Object.defineProperty(error, 'broken', {
				enumerable: true,
				get(): never {
					throw new Error('getter');
				}
			});
			Object.defineProperty(error, 'code', {
				get(): never {
					throw 'no code';
				}
			});
			(error as unknown as Record<string, unknown>).data = {
				toJSON(): never {
					throw null;
				}
			};
			expect(serializeError(error, { stack: false })).toEqual({ name: 'Error', message: 'x', code: '[Throws: no code]', broken: '[Throws: getter]', data: '[Throws]' });
		});

		it('survives errors whose name, message and stack are unreadable', function () {
			const error = new Error('x');
			Object.defineProperty(error, 'message', {
				get(): never {
					throw new Error('message');
				}
			});
			Object.defineProperty(error, 'name', { value: 42 });
			Object.defineProperty(error, 'stack', { value: { not: 'a string' } });
			expect(serializeError(error)).toEqual({ name: 'Error', message: '' });
		});

		it('survives proxies with throwing traps', function () {
			const keysTrap = new Proxy(new Error('keys'), {
				ownKeys(): never {
					throw new Error('ownKeys');
				}
			});
			expect(serializeError(keysTrap, { stack: false })).toEqual({ name: 'Error', message: 'keys' });
			const ownTrap = new Proxy(Object.assign(new Error('own'), { code: 'E' }), {
				getOwnPropertyDescriptor(): never {
					throw new Error('getOwnPropertyDescriptor');
				}
			});
			expect(serializeError(ownTrap, { stack: false })).toEqual({ name: 'Error', message: 'own' });
			const codeTrap = new Proxy(Object.assign(new Error('code'), { extra: 1 }), {
				getOwnPropertyDescriptor(target, key): PropertyDescriptor | undefined {
					if (key === 'code') throw new Error('getOwnPropertyDescriptor');
					return Reflect.getOwnPropertyDescriptor(target, key);
				}
			});
			expect(serializeError(codeTrap, { stack: false })).toEqual({ name: 'Error', message: 'code', extra: 1 });
			expect(serializeError(Object.assign(new Error('nested'), { proxy: revoked() }), { stack: false })).toEqual({
				name: 'Error',
				message: 'nested',
				proxy: expect.stringMatching(/^\[Throws: /)
			});
		});

		it('limits the depth', function () {
			const error = new Error('root', { cause: new Error('child', { cause: new Error('grandchild') }) });
			expect(serializeError(error, { stack: false, maxDepth: 1 })).toEqual({
				name: 'Error',
				message: 'root',
				cause: { name: 'Error', message: 'child', cause: '[Object]' }
			});
			expect(serializeError(Object.assign(new Error('x'), { list: [1], object: {} }), { stack: false, maxDepth: 0 })).toEqual({
				name: 'Error',
				message: 'x',
				list: '[Array]',
				object: '[Object]'
			});
			expect(serializeError(error, { stack: false, maxDepth: Infinity }).cause).toEqual({
				name: 'Error',
				message: 'child',
				cause: { name: 'Error', message: 'grandchild' }
			});
		});

		it('caps cause chains at 1000 levels, whatever maxDepth asks for', function () {
			let error = new Error('deepest');
			for (let index = 0; index < 100_000; index++) error = new Error(String(index), { cause: error });
			for (const maxDepth of [Infinity, 1000, 5000]) {
				let depth = 0;
				let current: unknown = serializeError(error, { stack: false, maxDepth });
				while (typeof current === 'object' && current !== null) {
					current = (current as { cause?: unknown }).cause;
					depth++;
				}
				expect(depth).toBe(1001);
				expect(current).toBe('[Object]');
			}
		});

		it('gives a result JSON.stringify can always write, even once the walker is optimized (regression)', function () {
			// The walker used to build trees deeper than `JSON.stringify` could write once V8 had optimized it: the 7th call or so threw.
			let error = new Error('leaf');
			for (let index = 0; index < 8000; index++) error = new Error(`e${index}`, { cause: error });
			for (let index = 0; index < 100; index++) expect(JSON.stringify(serializeError(error))).toContain('"cause":"[Object]"');
		});

		it('serializes error-like objects the same way, so serializing twice changes nothing', function () {
			const once = serializeError(Object.assign(new TypeError('x', { cause: 'why' }), { code: 'E' }));
			expect(serializeError(once)).toEqual(once);
			expect(serializeError({ message: 'Not found', status: 404 })).toEqual({ name: 'Error', message: 'Not found', status: 404 });
			expect(serializeError({ name: 7, message: 'x' })).toEqual({ name: 'Error', message: 'x' });
		});

		it('serializes anything else as a plain error with its message', function () {
			expect(serializeError('Timed out')).toEqual({ name: 'Error', message: 'Timed out' });
			expect(serializeError(null)).toEqual({ name: 'Error', message: 'null' });
			expect(serializeError({ code: 1 })).toEqual({ name: 'Error', message: '{"code":1}' });
			expect(serializeError(revoked())).toEqual({ name: 'Error', message: 'object' });
			expect(serializeError(throwingGetters)).toEqual({ name: 'Error', message: '[object Object]' });
		});

		it('writes dangerous keys as plain own properties', function () {
			const error = new Error('x');
			Object.defineProperty(error, '__proto__', { value: { polluted: true }, enumerable: true });
			Object.defineProperty(error, 'toString', { value: 'own', enumerable: true });
			const serialized = serializeError(error, { stack: false });
			expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype);
			expect(Object.prototype.hasOwnProperty.call(serialized, '__proto__')).toBe(true);
			expect(serialized.toString).toBe('own');
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});

		it('validates its options', function () {
			expect(function () {
				serializeError(new Error(), { maxDepth: -1 });
			}).toThrow(new RangeError('serializeError: `maxDepth` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				serializeError(new Error(), { maxDepth: '1' as never });
			}).toThrow(TypeError);
			expect(function () {
				serializeError(new Error(), null as never);
			}).toThrow(TypeError);
		});
	});

	describe('deserializeError', function () {
		it('rebuilds built-in error classes by name', function () {
			for (const Constructor of [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError]) {
				const error = deserializeError({ name: Constructor.name, message: 'm' });
				expect(error).toBeInstanceOf(Constructor);
				expect(Object.getPrototypeOf(error)).toBe(Constructor.prototype);
				expect(error.message).toBe('m');
				expect(Object.prototype.hasOwnProperty.call(error, 'name')).toBe(false);
			}
		});

		it('rebuilds AggregateError with its errors', function () {
			const error = deserializeError({ name: 'AggregateError', message: 'Many', errors: [{ name: 'TypeError', message: 'a' }, 'b', { c: 1 }] }) as AggregateError;
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors).toHaveLength(3);
			expect(error.errors[0]).toBeInstanceOf(TypeError);
			expect(error.errors[1]).toBe('b');
			expect(error.errors[2]).toEqual({ c: 1 });
			expect(Object.getOwnPropertyDescriptor(error, 'errors')?.enumerable).toBe(false);
			expect((deserializeError({ name: 'AggregateError', message: 'x', errors: 'nope' }) as AggregateError).errors).toEqual([]);
		});

		it('gives an Error with the name for any other name, never calling other constructors', function () {
			const error = deserializeError({ name: 'AbortError', message: 'Aborted' });
			expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
			expect(error.name).toBe('AbortError');
			expect(Object.keys(error)).toEqual([]);
			for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'Function', 'Object', 'DOMException']) {
				expect(Object.getPrototypeOf(deserializeError({ name, message: 'x' }))).toBe(Error.prototype);
			}
			expect(deserializeError({ message: 'no name' }).name).toBe('Error');
			expect(deserializeError({ name: 42, message: 'x' }).name).toBe('Error');
			expect(deserializeError({}).message).toBe('');
		});

		it('restores the stack and the cause as hidden properties', function () {
			const error = deserializeError({ name: 'Error', message: 'x', stack: 'Error: x\n    at remote', cause: { name: 'TypeError', message: 'inner' } });
			expect(error.stack).toBe('Error: x\n    at remote');
			expect(error.cause).toBeInstanceOf(TypeError);
			expect((error.cause as Error).message).toBe('inner');
			expect(Object.keys(error)).toEqual([]);
			expect(Object.getOwnPropertyDescriptor(error, 'cause')).toEqual({ value: error.cause, writable: true, enumerable: false, configurable: true });
			expect(deserializeError({ name: 'Error', message: 'x' }).stack).toEqual(expect.any(String));
		});

		it('keeps a cause that is not error-like as data', function () {
			expect(deserializeError({ name: 'Error', message: 'x', cause: 'why' }).cause).toBe('why');
			const data = { code: 1 };
			expect(deserializeError({ name: 'Error', message: 'x', cause: data }).cause).toBe(data);
			expect(Object.prototype.hasOwnProperty.call(deserializeError({ name: 'Error', message: 'x', cause: undefined }), 'cause')).toBe(true);
			expect(Object.prototype.hasOwnProperty.call(deserializeError({ name: 'Error', message: 'x' }), 'cause')).toBe(false);
			const cause = new RangeError('live');
			expect(deserializeError({ name: 'Error', message: 'x', cause }).cause).toBe(cause);
		});

		it('copies other own enumerable properties, never dangerous keys', function () {
			const data = JSON.parse('{"name":"Error","message":"x","code":"E","status":404,"__proto__":{"polluted":true},"constructor":"c","prototype":"p"}');
			const error = deserializeError(data) as Error & Record<string, unknown>;
			expect(error.code).toBe('E');
			expect(error.status).toBe(404);
			expect(Object.keys(error)).toEqual(['code', 'status']);
			expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
			expect(error.polluted).toBeUndefined();
			expect(error.constructor).toBe(Error);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});

		it('never lets data shadow an inherited method (regression)', function () {
			// `String(error)` used to throw "Cannot convert object to primitive value", breaking the loggers that print it.
			expect(String(deserializeError(JSON.parse('{"name":"Error","message":"m","toString":"x"}')))).toBe('Error: m');
			// Every method name (`name` and `message` are the data's own text).
			const inherited = [...Object.getOwnPropertyNames(Object.prototype), ...Object.getOwnPropertyNames(Error.prototype)].filter(function (key) {
				return key !== 'name' && key !== 'message';
			});
			expect(inherited).toEqual(expect.arrayContaining(['toString', 'valueOf', 'toLocaleString', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__']));
			const data: Record<string, unknown> = { name: 'RangeError', message: 'm', code: 'E' };
			for (const key of inherited) Object.defineProperty(data, key, { value: 'x', enumerable: true, writable: true, configurable: true });
			const error = deserializeError(data) as RangeError & Record<string, unknown>;
			expect(Object.keys(error)).toEqual(['code']);
			for (const key of inherited) expect(Object.prototype.hasOwnProperty.call(error, key)).toBe(false);
			expect(String(error)).toBe('RangeError: m');
			expect(`${error}`).toBe('RangeError: m');
			expect(error.valueOf()).toBe(error);
			expect(error.toLocaleString()).toBe('RangeError: m');
			expect(error.constructor).toBe(RangeError);
		});

		it('ignores values inherited from a polluted Object.prototype', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.name = 'TypeError';
			prototype.stack = 'polluted stack';
			try {
				const error = deserializeError({ message: 'x' });
				expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
				expect(error.stack).not.toBe('polluted stack');
			} finally {
				delete prototype.name;
				delete prototype.stack;
			}
		});

		it('preserves circular and shared references', function () {
			const data: Record<string, unknown> = { name: 'Error', message: 'loop' };
			data.cause = data;
			const error = deserializeError(data);
			expect(error.cause).toBe(error);

			const shared = { name: 'TypeError', message: 'shared' };
			const aggregate = deserializeError({ name: 'AggregateError', message: 'x', errors: [shared, shared] }) as AggregateError;
			expect(aggregate.errors[0]).toBe(aggregate.errors[1]);
		});

		it('limits the depth', function () {
			const data = serializedChain(3);
			const error = deserializeError(data, { maxDepth: 1 });
			expect(error.cause).toBeInstanceOf(Error);
			expect((error.cause as Error).cause).toBe((data.cause as Record<string, unknown>).cause);
			expect(deserializeError(data, { maxDepth: 0 }).cause).toBe(data.cause);
		});

		it('survives cause chains deeper than the call stack', function () {
			const error = deserializeError(serializedChain(100_000));
			let depth = 0;
			let current: unknown = error;
			while (current instanceof Error) {
				current = current.cause;
				depth++;
			}
			// The rest of the chain is cut where the stack ran out.
			expect(depth).toBeGreaterThan(100);
		});

		it('returns errors as they are', function () {
			const error = new TypeError('x');
			expect(deserializeError(error)).toBe(error);
			const foreign = vm.runInNewContext('new Error("x")');
			expect(deserializeError(foreign)).toBe(foreign);
		});

		it('turns values that are not objects into an Error with their message', function () {
			expect(deserializeError('boom').message).toBe('boom');
			expect(deserializeError(null).message).toBe('null');
			expect(deserializeError(42)).toBeInstanceOf(Error);
			expect(deserializeError(undefined).cause).toBeUndefined();
		});

		it('never throws for hostile data', function () {
			const getter = {
				name: 'TypeError',
				message: 'x',
				ok: 1,
				get boom(): never {
					throw new Error('boom');
				}
			};
			const error = deserializeError(getter) as Error & Record<string, unknown>;
			expect(error).toBeInstanceOf(TypeError);
			expect(error.ok).toBe(1);
			expect(deserializeError(throwingGetters).message).toBe('');
			expect(deserializeError(revoked())).toBeInstanceOf(Error);
		});

		it('validates its options', function () {
			expect(function () {
				deserializeError({}, { maxDepth: 1.5 });
			}).toThrow(new RangeError('deserializeError: `maxDepth` must be an integer >= 0 or Infinity, got 1.5'));
		});

		it('round-trips through JSON', function () {
			const original = Object.assign(new TypeError('outer', { cause: new AggregateError([new RangeError('a')], 'inner') }), { code: 'E_OUTER' });
			const copy = deserializeError(JSON.parse(JSON.stringify(serializeError(original)))) as TypeError & { code?: string };
			expect(copy).toBeInstanceOf(TypeError);
			expect(copy.message).toBe('outer');
			expect(copy.stack).toBe(original.stack);
			expect(copy.code).toBe('E_OUTER');
			expect(copy.cause).toBeInstanceOf(AggregateError);
			expect(((copy.cause as AggregateError).errors[0] as Error).message).toBe('a');
			expect(serializeError(copy)).toEqual(serializeError(original));
		});
	});
});
