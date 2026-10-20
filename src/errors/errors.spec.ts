import * as util from 'util';
import * as vm from 'vm';
import { AbortError, TimeoutError } from '../async/index.js';
import { AssertionError, ValidationError } from '../guards/index.js';
import { JsonPatchError } from '../objects/index.js';
import { defineError, deserializeError, formatError, getErrorChain, getErrorMessage, isErrorLike, serializeError, toError } from '.';

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
		it('copies keys Object.prototype has when Object.prototype also holds a get', function () {
			const proto = Object.prototype as Record<string, unknown>;
			proto.get = function (): string {
				return 'polluted';
			};
			try {
				const error = Object.assign(new Error('boom'), { toString: 'own', valueOf: 1 });
				expect(serializeError(error)).toMatchObject({ name: 'Error', message: 'boom', toString: 'own', valueOf: 1 });
			} finally {
				delete proto.get;
			}
		});

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
			expect(Object.getOwnPropertyDescriptor(error, 'code')).toEqual({ value: 'E', writable: true, enumerable: true, configurable: true });
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

/** A chain of `depth` errors, each the cause of the previous one (built iteratively). */
function errorChain(depth: number): Error {
	let current = new Error(String(depth - 1));
	for (let index = depth - 2; index >= 0; index--) current = new Error(String(index), { cause: current });
	return current;
}

/** A proxy of an error whose every trap throws. */
function hostileProxy(): object {
	return new Proxy(new Error('hidden'), {
		get: function (): never {
			throw new Error('get');
		},
		getOwnPropertyDescriptor: function (): never {
			throw new Error('getOwnPropertyDescriptor');
		},
		getPrototypeOf: function (): never {
			throw new Error('getPrototypeOf');
		}
	});
}

describe('errors (1.4)', function () {
	describe('defineError', function () {
		const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404 });

		it('creates an Error subclass with the name on the prototype and the class', function () {
			const error = new NotFound('No user 42');
			expect(error).toBeInstanceOf(NotFound);
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe('NotFoundError');
			expect(error.message).toBe('No user 42');
			expect(String(error)).toBe('NotFoundError: No user 42');
			expect(Object.prototype.toString.call(error)).toBe('[object Error]');
			expect(util.types.isNativeError(error)).toBe(true);
			expect(Object.hasOwn(error, 'name')).toBe(false);
			expect(Object.getOwnPropertyDescriptor(NotFound.prototype, 'name')).toEqual({ value: 'NotFoundError', writable: true, enumerable: false, configurable: true });
			expect(NotFound.name).toBe('NotFoundError');
			expect(NotFound.prototype.constructor).toBe(NotFound);
			expect(Object.getPrototypeOf(NotFound)).toBe(Error);
			expect(new NotFound().message).toBe('');
			expect(Object.hasOwn(new NotFound(), 'message')).toBe(false);
		});

		it('gives every error its code and fields as own enumerable properties, defaults overridable except the code', function () {
			const error = new NotFound('x');
			expect(Object.keys(error)).toEqual(['code', 'status']);
			expect(Object.getOwnPropertyDescriptor(error, 'code')).toEqual({ value: 'E_NOT_FOUND', writable: true, enumerable: true, configurable: true });
			expect(error.status).toBe(404);
			expect(new NotFound('x', { status: 410 }).status).toBe(410);
			expect(new NotFound('x', { status: undefined }).status).toBe(404);
			expect(new NotFound('x', { code: 'E_OTHER' } as never).code).toBe('E_NOT_FOUND');
			expect(Object.keys(new NotFound('x', { other: 1 } as never))).toEqual(['code', 'status']);
			expect(new NotFound('x', Object.create({ status: 1 })).status).toBe(404);
			const Plain = defineError('PlainError');
			expect(Object.keys(new Plain('x'))).toEqual([]);
			expect(Object.keys(new (defineError('FieldError', { a: 1, b: 'two' }))('x', { b: 'three' }))).toEqual(['a', 'b']);
		});

		it('defines fields like class fields, over accessors of subclasses', function () {
			class Shadowed extends NotFound {
				override get status(): number {
					return 0;
				}
			}
			expect(new Shadowed('x').status).toBe(404);
		});

		it('exposes the defaults as read-only statics', function () {
			expect(Object.keys(NotFound)).toEqual(['code', 'status']);
			expect(NotFound.code).toBe('E_NOT_FOUND');
			expect(NotFound.status).toBe(404);
			expect(Object.getOwnPropertyDescriptor(NotFound, 'code')).toEqual({ value: 'E_NOT_FOUND', writable: false, enumerable: true, configurable: false });
			expect(Object.getOwnPropertyDescriptor(NotFound, 'is')).toEqual({ value: NotFound.is, writable: true, enumerable: false, configurable: true });
			expect(Object.getOwnPropertyDescriptor(NotFound, 'name')).toEqual({ value: 'NotFoundError', writable: false, enumerable: false, configurable: true });
		});

		it('keeps only an own cause, as the Error constructor stores it', function () {
			const inner = new Error('inner');
			expect(new NotFound('x', { cause: inner }).cause).toBe(inner);
			const undefinedCause = new NotFound('x', { cause: undefined });
			expect(Object.hasOwn(undefinedCause, 'cause')).toBe(true);
			expect(Object.getOwnPropertyDescriptor(undefinedCause, 'cause')?.enumerable).toBe(false);
			expect(Object.hasOwn(new NotFound('x', {}), 'cause')).toBe(false);
			expect(Object.hasOwn(new NotFound('x', Object.create({ cause: inner })), 'cause')).toBe(false);
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.cause = 'polluted';
			prototype.status = 'polluted';
			try {
				const error = new NotFound('x', {});
				expect(Object.hasOwn(error, 'cause')).toBe(false);
				expect(error.status).toBe(404);
			} finally {
				delete prototype.cause;
				delete prototype.status;
			}
		});

		it('ignores a second argument that is not an object, as Error does', function () {
			for (const init of [null, 5, 'cause', true, Object.assign(function () {}, { cause: 'c', status: 1 })]) {
				const error = new NotFound('x', init as never);
				expect(Object.hasOwn(error, 'cause')).toBe(false);
				expect(error.status).toBe(404);
			}
			const Indexed = defineError('IndexedError', { 0: 'default' });
			expect(new Indexed('x', 'abc' as never)[0]).toBe('default');
		});

		it('leaves the constructors out of the stack, without capturing it twice on V8', function () {
			const capture = jest.spyOn(Error, 'captureStackTrace');
			jest.isolateModules(function () {
				const isolated = jest.requireActual<typeof import('.')>('.');
				const Isolated = isolated.defineError('IsolatedError');
				class Sub extends Isolated {}
				/** Creates the errors, so that this function is the first frame. */
				function createErrors(): Error[] {
					return [new Isolated('a'), new Sub('b')];
				}
				const [first, second] = createErrors();
				expect(first.stack?.split('\n').slice(0, 2)).toEqual(['IsolatedError: a', expect.stringContaining('at createErrors')]);
				expect(second.stack?.split('\n').slice(0, 2)).toEqual(['IsolatedError: b', expect.stringContaining('at createErrors')]);
			});
			expect(capture).not.toHaveBeenCalled();
		});

		it('captures the stack where the engine keeps constructor frames', function () {
			const prepare = Error.prepareStackTrace;
			let calls = 0;
			// Different stacks for the plain and the derived probe error, as an engine that keeps constructor frames writes.
			Error.prepareStackTrace = function (error: Error): string {
				calls++;
				return `${error.name}: ${calls}`;
			};
			const capture = jest.spyOn(Error, 'captureStackTrace');
			try {
				jest.isolateModules(function () {
					const isolated = jest.requireActual<typeof import('.')>('.');
					const Captured = isolated.defineError('CapturedError');
					class Sub extends Captured {}
					const error = new Sub('x');
					expect(capture).toHaveBeenCalledWith(error, Sub);
					new Captured('y');
					expect(capture).toHaveBeenLastCalledWith(expect.any(Captured), Captured);
					expect(capture).toHaveBeenCalledTimes(2);
					// The engine is probed once (two stacks), not for every class.
					const probes = calls;
					isolated.defineError('OtherError');
					expect(calls).toBe(probes);
				});
			} finally {
				Error.prepareStackTrace = prepare;
			}
		});

		it('probes again when stacks are turned off at the first probe (regression)', function () {
			const limit = Error.stackTraceLimit;
			const prepare = Error.prepareStackTrace;
			const capture = jest.spyOn(Error, 'captureStackTrace');
			try {
				jest.isolateModules(function () {
					const isolated = jest.requireActual<typeof import('.')>('.');
					Error.stackTraceLimit = 0;
					const Early = isolated.defineError('EarlyError');
					Error.stackTraceLimit = limit;
					new Early('x');
					expect(capture).not.toHaveBeenCalled();
					// Now an engine that keeps constructor frames (different stacks for the plain and the derived probe error).
					let calls = 0;
					Error.prepareStackTrace = function (error: Error): string {
						calls++;
						return `${error.name}: ${calls}`;
					};
					const Late = isolated.defineError('LateError');
					const error = new Late('y');
					expect(capture).toHaveBeenCalledWith(error, Late);
				});
			} finally {
				Error.stackTraceLimit = limit;
				Error.prepareStackTrace = prepare;
			}
		});

		it('probes once when equal stacks have frames, as V8 writes them', function () {
			const prepare = Error.prepareStackTrace;
			let calls = 0;
			Error.prepareStackTrace = function (error: Error): string {
				calls++;
				return `${error.name}\n    at probe (file.js:1:1)`;
			};
			try {
				jest.isolateModules(function () {
					const isolated = jest.requireActual<typeof import('.')>('.');
					isolated.defineError('FirstError');
					expect(calls).toBe(2);
					isolated.defineError('SecondError');
					expect(calls).toBe(2);
				});
			} finally {
				Error.prepareStackTrace = prepare;
			}
		});

		it('survives a throwing Error.prepareStackTrace', function () {
			const prepare = Error.prepareStackTrace;
			Error.prepareStackTrace = function (): never {
				throw new Error('prepare');
			};
			const capture = jest.spyOn(Error, 'captureStackTrace');
			try {
				jest.isolateModules(function () {
					const isolated = jest.requireActual<typeof import('.')>('.');
					expect(new (isolated.defineError('PreparedError'))('x').message).toBe('x');
				});
				expect(capture).not.toHaveBeenCalled();
			} finally {
				Error.prepareStackTrace = prepare;
			}
		});

		it('does not capture without Error.captureStackTrace', function () {
			const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace') as PropertyDescriptor;
			const prepare = Error.prepareStackTrace;
			let calls = 0;
			Error.prepareStackTrace = function (): string {
				return String(++calls);
			};
			delete (Error as { captureStackTrace?: unknown }).captureStackTrace;
			try {
				jest.isolateModules(function () {
					const isolated = jest.requireActual<typeof import('.')>('.');
					expect(new (isolated.defineError('NoCaptureError'))('x').message).toBe('x');
				});
			} finally {
				Object.defineProperty(Error, 'captureStackTrace', descriptor);
				Error.prepareStackTrace = prepare;
			}
		});

		it('supports subclasses', function () {
			class Gone extends NotFound {
				readonly gone = true;
				describe(): string {
					return `${this.name} ${this.status}`;
				}
			}
			const error = new Gone('Gone', { status: 410 });
			expect(error).toBeInstanceOf(Gone);
			expect(error).toBeInstanceOf(NotFound);
			expect(error.describe()).toBe('NotFoundError 410');
			expect(error.gone).toBe(true);
			expect(error.code).toBe('E_NOT_FOUND');
			expect(Gone.code).toBe('E_NOT_FOUND');
		});

		it('recognises its errors with is(), across copies of the class with the same name and across realms', function () {
			const error = new NotFound('x');
			expect(NotFound.is(error)).toBe(true);
			expect(NotFound.is(new Error('x'))).toBe(false);
			expect(NotFound.is(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe(false);
			// Another bundle (or version) defining the same error.
			const Copy = defineError('NotFoundError');
			expect(Copy.is(error)).toBe(true);
			expect(NotFound.is(new Copy('x'))).toBe(true);
			expect(defineError('OtherError').is(error)).toBe(false);
			const foreign = vm.runInNewContext('Object.defineProperty(new Error("x"), Symbol.for("tinkit.defineError"), { value: "NotFoundError" })');
			expect(NotFound.is(foreign)).toBe(true);
			// A brand alone does not make an error.
			expect(NotFound.is({ [Symbol.for('tinkit.defineError')]: 'NotFoundError' })).toBe(false);
			for (const value of [null, undefined, 'NotFoundError', 42, NotFound]) expect(NotFound.is(value)).toBe(false);
			expect(NotFound.is(revoked())).toBe(false);
			expect(NotFound.is(hostileProxy())).toBe(false);
			const { is } = NotFound;
			expect(is(error)).toBe(true);
			expect([error, new Error('y')].filter(NotFound.is)).toEqual([error]);
		});

		it('uses instanceof when is() is called on a subclass', function () {
			class Gone extends NotFound {}
			expect(Gone.is(new Gone('x'))).toBe(true);
			expect(Gone.is(new NotFound('x'))).toBe(false);
			expect(NotFound.is(new Gone('x'))).toBe(true);
			expect(Gone.is(hostileProxy())).toBe(false);
			expect(Gone.is(null)).toBe(false);
		});

		it('serializes and deserializes, rebuilding the class only on opt-in', function () {
			const original = new NotFound('No user', { cause: new RangeError('inner'), status: 410 });
			const data = JSON.parse(JSON.stringify(serializeError(original)));
			expect(data).toEqual({ name: 'NotFoundError', message: 'No user', stack: original.stack, code: 'E_NOT_FOUND', cause: expect.anything(), status: 410 });
			const plain = deserializeError(data) as Error & Record<string, unknown>;
			expect(plain).not.toBeInstanceOf(NotFound);
			expect(NotFound.is(plain)).toBe(false);
			expect([plain.name, plain.code, plain.status]).toEqual(['NotFoundError', 'E_NOT_FOUND', 410]);
			const rebuilt = deserializeError(data, { classes: { NotFoundError: NotFound } });
			expect(rebuilt).toBeInstanceOf(NotFound);
			expect(util.types.isNativeError(rebuilt)).toBe(true);
			expect(NotFound.is(rebuilt)).toBe(true);
			expect(Object.hasOwn(rebuilt, 'name')).toBe(false);
			expect(rebuilt.cause).toBeInstanceOf(RangeError);
			expect(rebuilt.stack).toBe(original.stack);
			expect(serializeError(rebuilt)).toEqual(serializeError(original));
			expect(Object.keys(rebuilt)).toEqual(Object.keys(original));
		});

		it('rebuilds nested errors with the classes too, never shadowing what the class defines', function () {
			class Detailed extends NotFound {
				get detail(): string {
					return `detail of ${this.message}`;
				}
			}
			const data = { name: 'Outer', message: 'x', cause: { name: 'NotFoundError', message: 'inner', detail: 'hostile', status: 1 } };
			const error = deserializeError(data, { classes: { NotFoundError: Detailed, Outer: NotFound } });
			expect(error).toBeInstanceOf(NotFound);
			expect(error.name).toBe('Outer');
			const cause = error.cause as Detailed;
			expect(cause).toBeInstanceOf(Detailed);
			expect(cause.detail).toBe('detail of inner');
			expect(cause.status).toBe(1);
			expect(deserializeError({ name: 'Error', message: 'x' }, { classes: { NotFoundError: NotFound } })).not.toBeInstanceOf(NotFound);
			expect(deserializeError({ name: 'TypeError', message: 'x' }, { classes: { TypeError: NotFound } })).toBeInstanceOf(NotFound);
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.PollutedError = NotFound;
			try {
				expect(deserializeError({ name: 'PollutedError', message: 'x' }, { classes: {} })).not.toBeInstanceOf(NotFound);
			} finally {
				delete prototype.PollutedError;
			}
		});

		it('validates the classes option', function () {
			expect(function () {
				deserializeError({}, { classes: null as never });
			}).toThrow(new TypeError('deserializeError: `classes` must be an object, got null'));
			expect(function () {
				deserializeError({}, { classes: 'x' as never });
			}).toThrow(new TypeError('deserializeError: `classes` must be an object, got string'));
			expect(function () {
				deserializeError({}, { classes: { A: Math.max as never } });
			}).toThrow(new TypeError('deserializeError: `classes.A` must be a class, got a function without prototype'));
			expect(function () {
				deserializeError({}, { classes: { B: 5 as never } });
			}).toThrow(new TypeError('deserializeError: `classes.B` must be a class, got number'));
			expect(function () {
				deserializeError({}, { classes: { C: { prototype: Error.prototype } as never } });
			}).toThrow(new TypeError('deserializeError: `classes.C` must be a class, got object'));
			/** A function whose prototype was set to `null`. */
			function nullPrototype(): void {}
			nullPrototype.prototype = null;
			expect(function () {
				deserializeError({}, { classes: { D: nullPrototype as never } });
			}).toThrow(new TypeError('deserializeError: `classes.D` must be a class, got a function without prototype'));
			expect(deserializeError({}, { classes: undefined })).toBeInstanceOf(Error);
			// A class whose `prototype` cannot be read (regression: the proxy's own error escaped).
			const unreadable = new Proxy(class extends Error {}, {
				get: function (): never {
					throw new Error('get');
				}
			});
			expect(function () {
				deserializeError({}, { classes: { E: unreadable } });
			}).toThrow(new TypeError('deserializeError: `classes.E` must be a class, got a function without prototype'));
		});

		it('never throws on data that picks a hostile class (regression)', function () {
			class ThrowingName extends Error {
				override get name(): string {
					throw new Error('name');
				}
			}
			const named = deserializeError({ name: 'ThrowingName', message: 'x', code: 1 }, { classes: { ThrowingName } }) as ThrowingName & { code?: number };
			expect(named).toBeInstanceOf(ThrowingName);
			expect([named.name, named.message, named.code]).toEqual(['ThrowingName', 'x', 1]);
			/** A class whose prototype is a proxy with throwing traps. */
			function Hostile(): void {}
			Hostile.prototype = new Proxy(Object.create(Error.prototype), {
				get: function (): never {
					throw new Error('get');
				},
				has: function (): never {
					throw new Error('has');
				}
			});
			const hostile = deserializeError({ name: 'Hostile', message: 'y', code: 2 }, { classes: { Hostile: Hostile as never } });
			expect(Object.getPrototypeOf(hostile)).toBe(Hostile.prototype);
			expect(Object.getOwnPropertyDescriptor(hostile, 'name')?.value).toBe('Hostile');
			expect(Object.getOwnPropertyDescriptor(hostile, 'message')?.value).toBe('y');
			expect(Object.hasOwn(hostile, 'code')).toBe(false);
		});

		it('rejects reserved field names', function () {
			for (const key of [
				'name',
				'message',
				'stack',
				'cause',
				'errors',
				'is',
				'prototype',
				'length',
				'toString',
				'constructor',
				'captureStackTrace',
				'hasOwnProperty',
				'__proto__',
				'call'
			]) {
				expect(function () {
					defineError('X', { [key]: 1 });
				}).toThrow(new RangeError(`defineError: \`options.${key}\` is a reserved field name`));
			}
		});

		it('validates its arguments', function () {
			expect(function () {
				defineError(1 as never);
			}).toThrow(new TypeError('defineError: `name` must be a non-empty string, got number'));
			expect(function () {
				defineError('');
			}).toThrow(new RangeError('defineError: `name` must be a non-empty string, got an empty string'));
			expect(function () {
				defineError('X', null as never);
			}).toThrow(new TypeError('defineError: `options` must be an object, got null'));
			expect(function () {
				defineError('X', 'code' as never);
			}).toThrow(new TypeError('defineError: `options` must be an object, got string'));
			expect(function () {
				defineError('X', { code: 404 } as never);
			}).toThrow(new TypeError('defineError: `options.code` must be a string, got number'));
			expect(defineError('X', undefined).name).toBe('X');
		});
	});

	describe('getErrorChain', function () {
		it('lists the error and its causes, outermost first', function () {
			const root = new Error('root');
			const middle = new TypeError('middle', { cause: root });
			const error = new Error('top', { cause: middle });
			expect(getErrorChain(error)).toEqual([error, middle, root]);
			expect(getErrorChain(error)[0]).toBe(error);
			expect(getErrorChain(root)).toEqual([root]);
		});

		it('includes a cause that is not an error, and ends there', function () {
			expect(getErrorChain(new Error('x', { cause: 'disk full' }))[1]).toBe('disk full');
			expect(getErrorChain(new Error('x', { cause: null })).length).toBe(2);
			expect(getErrorChain(new Error('x', { cause: 0 }))[1]).toBe(0);
			const data = { code: 1, cause: { message: 'below' } };
			expect(getErrorChain(new Error('x', { cause: data }))).toEqual([expect.any(Error), data, data.cause]);
		});

		it('follows own causes only, ignoring undefined ones', function () {
			expect(getErrorChain(new Error('x', { cause: undefined })).length).toBe(1);
			expect(getErrorChain(Object.create({ cause: new Error('inherited') })).length).toBe(1);
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.cause = new Error('polluted');
			try {
				expect(getErrorChain(new Error('x')).length).toBe(1);
			} finally {
				delete prototype.cause;
			}
		});

		it('follows the causes of objects only, not of functions', function () {
			const fn = Object.assign(function () {}, { cause: new Error('never followed') });
			expect(getErrorChain(fn)).toEqual([fn]);
			expect(getErrorChain(new Error('x', { cause: fn }))).toEqual([expect.any(Error), fn]);
			expect(getErrorChain(new AggregateError([fn], 'g'), { aggregate: true })).toEqual([expect.any(AggregateError), fn]);
		});

		it('accepts anything as the start', function () {
			expect(getErrorChain('thrown')).toEqual(['thrown']);
			expect(getErrorChain(undefined)).toEqual([undefined]);
			const serialized = { name: 'Error', message: 'a', cause: { name: 'Error', message: 'b' } };
			expect(getErrorChain(serialized)).toEqual([serialized, serialized.cause]);
		});

		it('walks aggregated errors depth-first only when asked', function () {
			const a1 = new Error('a1');
			const a = new Error('a', { cause: a1 });
			const b = new Error('b');
			const c = new Error('c');
			const group = new AggregateError([a, 'raw', b], 'all', { cause: c });
			expect(getErrorChain(group)).toEqual([group, c]);
			expect(getErrorChain(group, { aggregate: true })).toEqual([group, a, a1, 'raw', b, c]);
			expect(getErrorChain(group, { aggregate: false })).toEqual([group, c]);
			const nested = new AggregateError([group, new AggregateError([b], 'inner')], 'outer');
			expect(getErrorChain(nested, { aggregate: true }).map(getMessage)).toEqual(['outer', 'all', 'a', 'a1', 'raw', 'b', 'c', 'inner']);
			const serialized = serializeError(nested, { stack: false });
			expect(getErrorChain(serialized, { aggregate: true }).map(getMessage)).toEqual(['outer', 'all', 'a', 'a1', 'raw', 'b', 'c', 'inner', 'b']);
			expect(getErrorChain({ errors: 'not an array' }, { aggregate: true }).length).toBe(1);
			// Primitives are listed every time they appear.
			expect(getErrorChain(new AggregateError(['raw', 'raw', null, null], 'g'), { aggregate: true }).slice(1)).toEqual(['raw', 'raw', null, null]);
		});

		it('is cycle-safe and lists shared errors once', function () {
			const loop = new Error('loop');
			loop.cause = loop;
			expect(getErrorChain(loop)).toEqual([loop]);
			const a = new Error('a');
			const b = new Error('b', { cause: a });
			a.cause = b;
			expect(getErrorChain(a)).toEqual([a, b]);
			const shared = new Error('shared');
			const group = new AggregateError([shared, shared, new Error('c', { cause: shared })], 'g', { cause: shared });
			expect(getErrorChain(group, { aggregate: true }).length).toBe(3);
			for (const length of [16, 17, 18, 40]) {
				const errors = Array.from({ length }, function (_, index) {
					return new Error(String(index));
				});
				errors.forEach(function (item, index) {
					item.cause = errors[(index + 1) % length];
				});
				expect(getErrorChain(errors[0])).toEqual(errors);
				// A cycle back to the middle of the chain.
				errors[length - 1].cause = errors[length >> 1];
				expect(getErrorChain(errors[0])).toEqual(errors);
				expect(getErrorChain(errors[0], { aggregate: true })).toEqual(errors);
			}
		});

		it('limits the depth, at most 1000 levels', function () {
			const error = errorChain(3);
			expect(getErrorChain(error, { maxDepth: 0 })).toEqual([error]);
			expect(getErrorChain(error, { maxDepth: 1 }).length).toBe(2);
			expect(getErrorChain(error, { maxDepth: 2 }).length).toBe(3);
			expect(getErrorChain(error, { maxDepth: Infinity }).length).toBe(3);
			expect(getErrorChain(errorChain(5000)).length).toBe(1001);
			expect(getErrorChain(errorChain(5000), { maxDepth: 1000 }).length).toBe(1001);
			expect(getErrorChain(errorChain(5000), { maxDepth: 999 }).length).toBe(1000);
			const group = new AggregateError([new Error('a', { cause: new Error('a1') })], 'g');
			expect(getErrorChain(group, { aggregate: true, maxDepth: 1 }).length).toBe(2);
			expect(getErrorChain(error, { aggregate: true, maxDepth: 1 }).length).toBe(2);
		});

		it('never throws on hostile objects', function () {
			const getter = Object.defineProperty(new Error('x'), 'cause', {
				get: function (): never {
					throw new Error('cause getter');
				}
			});
			expect(getErrorChain(getter)).toEqual([getter]);
			const proxy = hostileProxy();
			const chain = getErrorChain(proxy, { aggregate: true });
			expect(chain.length).toBe(1);
			expect(chain[0]).toBe(proxy);
			const revokedValue = revoked();
			expect(getErrorChain(new Error('x', { cause: revokedValue }), { aggregate: true })[1]).toBe(revokedValue);
			const first = new Error('first');
			const items = new Proxy([first, 'never read'], {
				get: function (target: unknown[], key: PropertyKey): unknown {
					if (key === '1') throw new Error('item getter');
					return Reflect.get(target, key);
				}
			});
			const group = Object.assign(new Error('g'), { errors: items });
			expect(getErrorChain(group, { aggregate: true })).toEqual([group, first]);
		});

		it('validates its options', function () {
			expect(function () {
				getErrorChain(new Error('x'), { maxDepth: -1 });
			}).toThrow(new RangeError('getErrorChain: `maxDepth` must be an integer >= 0 or Infinity, got -1'));
			expect(function () {
				getErrorChain(new Error('x'), { maxDepth: '1' as never });
			}).toThrow(new TypeError('getErrorChain: `maxDepth` must be an integer >= 0 or Infinity, got string'));
		});
	});

	describe('formatError', function () {
		it('prints the header like Error.prototype.toString', function () {
			const options = { stack: false };
			expect(formatError(new TypeError('Bad input'), options)).toBe('TypeError: Bad input');
			expect(formatError(new Error(), options)).toBe('Error');
			expect(formatError(Object.assign(new Error('only message'), { name: '' }), options)).toBe('only message');
			expect(formatError({ message: 'like' }, options)).toBe('Error: like');
			expect(formatError({ name: 'Named', message: 'x' }, options)).toBe('Named: x');
			expect(formatError(Object.assign(new RangeError('x'), { message: 5 }), options)).toBe('RangeError');
			expect(formatError(Object.assign(new RangeError('x'), { name: 5 }), options)).toBe('Error: x');
			expect(formatError('Timed out')).toBe('Timed out');
			expect(formatError(42)).toBe('42');
			expect(formatError({ code: 1 })).toBe('{"code":1}');
			expect(formatError(null)).toBe('null');
			expect(formatError(Object.assign(function named() {}, { message: 'not an error' }))).toBe('[object Function]');
		});

		it('prints the stack frames under the header, trimmed and indented', function () {
			const error = new Error('x');
			error.stack = 'Error: x\n    at a (file.js:1:1)\n\n  at b (file.js:2:2)  ';
			expect(formatError(error)).toBe('Error: x\n    at a (file.js:1:1)\n    at b (file.js:2:2)');
			expect(formatError(error, { stack: false })).toBe('Error: x');
			expect(formatError(error, { stack: true })).toBe('Error: x\n    at a (file.js:1:1)\n    at b (file.js:2:2)');
			const real = formatError(new RangeError('real')).split('\n');
			expect(real[0]).toBe('RangeError: real');
			expect(real[1]).toMatch(/^ {4}at /);
		});

		it('drops a stale V8 header and keeps frames-only stacks of other engines', function () {
			const renamed = new Error('old message');
			renamed.stack = 'Error: old message\n  spanning lines\n    at a (file.js:1:1)';
			renamed.message = 'new message';
			expect(formatError(renamed)).toBe('Error: new message\n    at a (file.js:1:1)');
			const firefox = new Error('x');
			firefox.stack = 'run@file.js:1:1\n@file.js:2:2\n';
			expect(formatError(firefox)).toBe('Error: x\n    run@file.js:1:1\n    @file.js:2:2');
			firefox.stack = 'Error: x\nrun@file.js:1:1';
			expect(formatError(firefox)).toBe('Error: x\n    run@file.js:1:1');
			const noStack = { name: 'Plain', message: 'no stack' };
			expect(formatError(noStack)).toBe('Plain: no stack');
		});

		it('stays linear on hostile stacks', function () {
			const error = new Error('x');
			error.stack = `${'\n'.repeat(200_000)}x`;
			expect(formatError(error)).toBe('Error: x\n    x');
		});

		it('indents causes and aggregated errors, recursively', function () {
			const group = new AggregateError([new TypeError('a', { cause: new SyntaxError('a1') }), new Error('b')], 'all', { cause: new Error('c') });
			expect(formatError(group, { stack: false })).toBe(
				['AggregateError: all', '  [1/2] TypeError: a', '    Caused by: SyntaxError: a1', '  [2/2] Error: b', '  Caused by: Error: c'].join('\n')
			);
			const error = new Error('top', { cause: 'disk full' });
			error.stack = 'Error: top\n    at a (file.js:1:1)';
			const cause = new Error('inner');
			cause.stack = 'Error: inner\n    at b (file.js:2:2)';
			expect(formatError(new Error('outer', { cause: Object.assign(cause, { cause: error }) }), { stack: false })).toBe(
				'Error: outer\n  Caused by: Error: inner\n    Caused by: Error: top\n      Caused by: disk full'
			);
			const outer = new Error('outer', { cause });
			outer.stack = 'Error: outer\n    at c (file.js:3:3)';
			expect(formatError(outer)).toBe(
				[
					'Error: outer',
					'    at c (file.js:3:3)',
					'  Caused by: Error: inner',
					'      at b (file.js:2:2)',
					'    Caused by: Error: top',
					'        at a (file.js:1:1)',
					'      Caused by: disk full'
				].join('\n')
			);
		});

		it('indents the lines of multi-line messages', function () {
			expect(formatError(new Error('outer', { cause: new Error('line 1\nline 2') }), { stack: false })).toBe('Error: outer\n  Caused by: Error: line 1\n  line 2');
		});

		it('prints primitives every time they appear', function () {
			expect(formatError(new AggregateError(['offline', 'offline', null, null], 'g'), { stack: false })).toBe(
				'AggregateError: g\n  [1/4] offline\n  [2/4] offline\n  [3/4] null\n  [4/4] null'
			);
		});

		it('marks cycles and shared errors, printing each error once', function () {
			const loop = new Error('loop');
			loop.cause = loop;
			expect(formatError(loop, { stack: false })).toBe('Error: loop\n  Caused by: [Circular]');
			const shared = new Error('shared', { cause: new Error('below') });
			const group = new AggregateError([shared, shared], 'g', { cause: shared });
			expect(formatError(group, { stack: false })).toBe(
				[
					'AggregateError: g',
					'  [1/2] Error: shared',
					'    Caused by: Error: below',
					'  [2/2] Error: shared [Seen above]',
					'  Caused by: Error: shared [Seen above]'
				].join('\n')
			);
			const a = new Error('a');
			const b = new Error('b', { cause: a });
			a.cause = new AggregateError([b], 'between');
			expect(formatError(a, { stack: false })).toBe('Error: a\n  Caused by: AggregateError: between\n    [1/1] Error: b\n      Caused by: [Circular]');
		});

		it('truncates below maxDepth, at most 1000 levels', function () {
			const error = errorChain(3);
			expect(formatError(error, { stack: false, maxDepth: 0 })).toBe('Error: 0\n  [Truncated]');
			expect(formatError(error, { stack: false, maxDepth: 2 })).toBe('Error: 0\n  Caused by: Error: 1\n    Caused by: Error: 2');
			expect(formatError(new AggregateError([new Error('a')], 'g'), { stack: false, maxDepth: 0 })).toBe('AggregateError: g\n  [Truncated]');
			expect(formatError(new AggregateError([new Error('a', { cause: new Error('b') })], 'g'), { stack: false, maxDepth: 1 })).toBe(
				'AggregateError: g\n  [1/1] Error: a\n    [Truncated]'
			);
			const lines = formatError(errorChain(1500), { stack: false }).split('\n');
			expect(lines.length).toBe(1002);
			expect(lines[1000]).toBe(`${'  '.repeat(10)}[depth 1000] Caused by: Error: 1000`);
			expect(lines[1001]).toBe(`${'  '.repeat(10)}[depth 1001] [Truncated]`);
			expect(formatError(errorChain(13), { stack: false, maxDepth: 10 }).split('\n').slice(-2)).toEqual([
				`${'  '.repeat(10)}Caused by: Error: 10`,
				`${'  '.repeat(10)}[depth 11] [Truncated]`
			]);
		});

		it('stops indenting 10 levels down, marking deeper lines with their depth, so the report grows linearly (regression)', function () {
			const options = { stack: false };
			const lines = formatError(errorChain(13), options).split('\n');
			expect(lines.slice(9)).toEqual([
				`${'  '.repeat(9)}Caused by: Error: 9`,
				`${'  '.repeat(10)}Caused by: Error: 10`,
				`${'  '.repeat(10)}[depth 11] Caused by: Error: 11`,
				`${'  '.repeat(10)}[depth 12] Caused by: Error: 12`
			]);
			// Frames, continuation lines, aggregated errors and cycles keep the capped indentation too.
			const item = new Error('first\nsecond');
			item.stack = 'Error: first\nsecond';
			const deepest = new AggregateError([item], 'group');
			deepest.stack = 'AggregateError: group\n    at a (file.js:1:1)';
			deepest.cause = deepest;
			let top: Error = deepest;
			for (let level = 11; level > 0; level--) {
				top = new Error(String(level), { cause: top });
				top.stack = `Error: ${level}`;
			}
			expect(formatError(top).split('\n').slice(11)).toEqual([
				`${'  '.repeat(10)}[depth 11] Caused by: AggregateError: group`,
				`${'  '.repeat(12)}at a (file.js:1:1)`,
				`${'  '.repeat(10)}[depth 12] [1/1] Error: first`,
				`${'  '.repeat(10)}second`,
				`${'  '.repeat(10)}[depth 12] Caused by: [Circular]`
			]);
			// A thousand levels of causes with stacks and multi-line messages: about as many characters per level, not a thousand times more.
			let error: Error = Object.assign(new Error('root'), { stack: 'Error: root' });
			for (let level = 0; level < 999; level++) {
				error = new Error(`level ${level}\nmore`, { cause: error });
				error.stack = `Error: level ${level}\nmore\n    at f (file.js:1:1)`;
			}
			const report = formatError(error);
			expect(report.split('\n').length).toBe(3 * 999 + 1);
			expect(report.length).toBeLessThan(1000 * 150);
		});

		it('never throws on hostile objects', function () {
			expect(formatError(hostileProxy())).toBe('object');
			expect(formatError(revoked())).toBe('object');
			expect(formatError(throwingGetters)).toBe('[object Object]');
			const error = new Error('x', { cause: revoked() });
			error.stack = 'Error: x';
			expect(formatError(error)).toBe('Error: x\n  Caused by: object');
		});

		it('validates its options', function () {
			expect(function () {
				formatError(new Error('x'), { maxDepth: NaN });
			}).toThrow(new RangeError('formatError: `maxDepth` must be an integer >= 0 or Infinity, got NaN'));
		});
	});
});

/**
 * Reads the message of an error, or describes another value.
 * @param {unknown} value - The value
 * @returns {string} Its message
 */
function getMessage(value: unknown): string {
	return getErrorMessage(value);
}

describe('errors under a polluted Object.prototype', function () {
	const prototype = Object.prototype as Record<string, unknown>;

	/**
	 * Runs `test` while `Object.prototype` holds `values`.
	 * @param {Record<string, unknown>} values - The polluted keys and their values
	 * @param {() => void} test - The test
	 */
	function polluted(values: Record<string, unknown>, test: () => void): void {
		Object.assign(prototype, values);
		try {
			test();
		} finally {
			for (const key of Object.keys(values)) delete prototype[key];
		}
	}

	it('still defines properties when an inherited `get` or `set` would make every descriptor invalid', function () {
		for (const values of [{ get: 'polluted' }, { set: 'polluted' }, { get: Math.random, set: Math.random }]) {
			polluted(values, function () {
				const error = deserializeError({ name: 'AbortError', message: 'x', stack: 'at x', cause: { name: 'TypeError', message: 'y' }, code: 'E' });
				expect([error.name, error.stack, (error as Error & { code?: string }).code]).toEqual(['AbortError', 'at x', 'E']);
				expect(error.cause).toBeInstanceOf(TypeError);
				expect(Object.getOwnPropertyDescriptor(error, 'name')).toEqual({ value: 'AbortError', writable: true, enumerable: false, configurable: true });
				expect(toError({ name: 'AbortError', message: 'x' }).name).toBe('AbortError');
				const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404 });
				const instance = new NotFound('No user', { status: 410 });
				expect([instance.name, instance.code, instance.status, NotFound.code]).toEqual(['NotFoundError', 'E_NOT_FOUND', 410, 'E_NOT_FOUND']);
				expect(NotFound.is(instance)).toBe(true);
			});
		}
	});

	it('gives defineError classes and errors the same property attributes', function () {
		polluted({ writable: true, enumerable: true, configurable: true }, function () {
			const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND' });
			expect(Object.getOwnPropertyDescriptor(NotFound, 'code')).toEqual({ value: 'E_NOT_FOUND', writable: false, enumerable: true, configurable: false });
			expect(Object.getOwnPropertyDescriptor(NotFound, 'name')).toEqual({ value: 'NotFoundError', writable: false, enumerable: false, configurable: true });
			expect(Object.getOwnPropertyDescriptor(NotFound.prototype, 'name')).toEqual({ value: 'NotFoundError', writable: true, enumerable: false, configurable: true });
			const brand = Object.getOwnPropertySymbols(NotFound.prototype)[0];
			expect(Object.getOwnPropertyDescriptor(NotFound.prototype, brand)).toEqual({ value: 'NotFoundError', writable: false, enumerable: false, configurable: false });
		});
	});
});
