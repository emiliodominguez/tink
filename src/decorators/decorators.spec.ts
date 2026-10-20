import * as util from 'util';
import * as vm from 'vm';
import * as decorators from '.';
import { sleep } from '../async/index.js';
import { createLRUCache, type LRUCache } from '../cache/index.js';
import { constant, noop, type DebounceOptions } from '../functions/index.js';

class Test {
	@decorators.readonly
	testProp: string = 'test';

	@decorators.readonly
	static staticProp = 'static';

	count: number = 0;

	id: number;

	constructor(id = 1) {
		this.id = id;
	}

	@decorators.log
	testLogMethod(arg: string): string {
		return `test ${arg}`;
	}

	@decorators.log
	async testAsyncLogMethod(fail: boolean): Promise<number> {
		if (fail) throw new Error('async failure');
		return this.id;
	}

	@decorators.log
	testThrowingLogMethod(): never {
		throw new Error('sync failure');
	}

	@decorators.memoize
	testMemoizeMethod(arg: string): string {
		this.count += 1;
		return `test ${arg} ${this.id}`;
	}

	@decorators.memoize
	falsy(value: number): number {
		this.count += 1;
		return value * 0;
	}

	@decorators.bound
	getId(): number {
		return this.id;
	}

	@decorators.debounced(100)
	debouncedMethod(value: number): void {
		calls.push(['debounced', this.id, value]);
	}

	@decorators.throttled(100)
	throttledMethod(value: number): void {
		calls.push(['throttled', this.id, value]);
	}

	@decorators.deprecated()
	oldMethod(): number {
		return this.id;
	}

	@decorators.deprecated('Use something else.')
	otherOldMethod(): string {
		return 'other';
	}

	@decorators.memoize
	static staticSquare(n: number): number {
		staticCalls += 1;
		return n * n;
	}

	@decorators.bound
	static staticName(): string {
		return (this as unknown as { name: string }).name;
	}
}

const calls: Array<[string, number, number]> = [];
let staticCalls = 0;

/**
 * Builds a fake TC39 standard decorator context and collects its initializers.
 */
function fakeContext(kind: string, name: string | symbol, extra: Record<string, unknown> = {}) {
	const initializers: Array<(this: unknown) => void> = [];
	const context = {
		kind,
		name,
		static: false,
		private: false,
		addInitializer: function (initializer: (this: unknown) => void) {
			initializers.push(initializer);
		},
		...extra
	};

	return {
		context: context as any,
		initializers,
		runInitializers: function (instance: unknown) {
			initializers.forEach(function (initializer) {
				initializer.call(instance);
			});
		}
	};
}

describe('Decorators', function () {
	let test: Test;

	beforeEach(function () {
		test = new Test();
		calls.length = 0;
	});

	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('readonly', function () {
		it('should throw a TypeError when assigning after construction and keep the value', function () {
			expect(function () {
				test.testProp = 'new value';
			}).toThrow(TypeError);
			expect(test.testProp).toBe('test');
		});

		it('should create an enumerable, non-writable own property', function () {
			expect(Object.getOwnPropertyDescriptor(test, 'testProp')).toEqual({ value: 'test', writable: false, enumerable: true, configurable: false });
			expect(Object.keys(test)).toContain('testProp');
		});

		it('should keep each instance independent', function () {
			class Box {
				@decorators.readonly
				value: number;

				constructor(value: number) {
					this.value = value;
				}
			}

			const a = new Box(1);
			const b = new Box(2);
			expect([a.value, b.value]).toEqual([1, 2]);
			expect(function () {
				a.value = 3;
			}).toThrow(TypeError);
			expect([a.value, b.value]).toEqual([1, 2]);
		});

		it('should read undefined before initialisation', function () {
			expect((Test.prototype as any).testProp).toBeUndefined();
		});

		it('should keep its prototype accessor out of enumeration and redefinable', function () {
			class Plain {
				declare value: number;
			}
			decorators.readonly(Plain.prototype, 'value');
			const keys: string[] = [];
			for (const key in new Plain()) keys.push(key);
			expect(keys).toEqual([]);
			Object.defineProperty(Plain.prototype, 'value', { value: 0 });
			expect(new Plain().value).toBe(0);
		});

		it('should make an already initialised static field non-writable', function () {
			expect(Test.staticProp).toBe('static');
			expect(function () {
				Test.staticProp = 'changed';
			}).toThrow(TypeError);
			expect(Test.staticProp).toBe('static');
		});

		it('should return a non-writable descriptor for Babel legacy fields', function () {
			function initializer() {
				return 42;
			}

			const descriptor = { configurable: true, enumerable: true, writable: true, initializer };
			const result = decorators.readonly({}, 'field', descriptor);
			expect(result).toEqual({ configurable: true, enumerable: true, writable: false, initializer });
			expect(descriptor.writable).toBe(true);
		});

		it('should make legacy methods non-writable', function () {
			function method() {
				return 1;
			}

			const result = decorators.readonly({}, 'm', { value: method, writable: true, configurable: true, enumerable: false });
			expect(result).toEqual({ value: method, writable: false, configurable: true, enumerable: false });
		});

		it('should reject legacy accessors', function () {
			expect(function () {
				decorators.readonly({}, 'setterOnly', { set: function () {} });
			}).toThrow(new TypeError('@readonly cannot decorate the accessor setterOnly'));
			expect(function () {
				decorators.readonly({}, 'acc', {
					get: function () {
						return 1;
					}
				});
			}).toThrow(new TypeError('@readonly cannot decorate the accessor acc'));
		});

		it('should lock the field via an initializer with standard decorators', function () {
			const { context, initializers, runInitializers } = fakeContext('field', 'x');
			expect(decorators.readonly(undefined, context)).toBeUndefined();
			expect(initializers).toHaveLength(1);

			const instance: { x: number } = { x: 1 };
			runInitializers(instance);
			expect(Object.getOwnPropertyDescriptor(instance, 'x')).toEqual({ value: 1, writable: false, enumerable: true, configurable: false });
			expect(function () {
				instance.x = 2;
			}).toThrow(TypeError);

			const withoutField: Record<string, unknown> = {};
			runInitializers(withoutField);
			withoutField.x = 5;
			expect(withoutField.x).toBe(5);
		});

		it('should keep the first assignment of a standard field that has no value yet (assigned in the constructor)', function () {
			const { context, runInitializers } = fakeContext('field', 'x');
			decorators.readonly(undefined, context);
			const instance: { x: number | undefined } = { x: undefined };
			runInitializers(instance);
			expect(instance.x).toBeUndefined();
			expect(Object.keys(instance)).toEqual(['x']);
			instance.x = 1;
			expect(Object.getOwnPropertyDescriptor(instance, 'x')).toEqual({ value: 1, writable: false, enumerable: true, configurable: false });
			expect(function () {
				instance.x = 2;
			}).toThrow(TypeError);
		});

		it('should define the first assignment on the object assigned to, not on the one that holds the field', function () {
			const { context, runInitializers } = fakeContext('field', 'x');
			decorators.readonly(undefined, context);
			const base: { x: number | undefined } = { x: undefined };
			runInitializers(base);
			const derived = Object.create(base) as { x: number | undefined };
			derived.x = 5;
			expect([derived.x, Object.prototype.hasOwnProperty.call(derived, 'x'), base.x]).toEqual([5, true, undefined]);
			base.x = 1;
			expect(base.x).toBe(1);
		});

		it.each([
			['method', {}, 'methods'],
			['accessor', {}, 'accessors'],
			['field', { private: true }, 'private fields'],
			['field', { addInitializer: undefined }, 'fields']
		])('should reject standard %s contexts %p', function (kind, extra, what) {
			const { context } = fakeContext(kind, 'x', extra);
			expect(function () {
				decorators.readonly(undefined, context);
			}).toThrow(new TypeError(`@readonly can only decorate public fields when used as a standard decorator, not ${what}`));
		});
	});

	describe('log', function () {
		it('never changes the outcome of the method when logging fails, and logs promises of other realms', async function () {
			const log = jest.spyOn(console, 'log').mockImplementation(function () {});
			try {
				let ran = 0;
				const method = decorators.log(function (_value: unknown): unknown {
					ran++;
					const { proxy, revoke } = Proxy.revocable({}, {});
					revoke();
					return proxy;
				}, fakeContext('method', 'm').context);
				const unprintable = {
					[util.inspect.custom](): never {
						throw new Error('inspect');
					}
				};
				log.mockImplementation(function (_message: unknown, value: unknown) {
					util.inspect(value);
				});
				expect(function () {
					method(unprintable);
				}).not.toThrow();
				expect(ran).toBe(1);
				log.mockImplementation(function () {});
				const foreign = decorators.log(function (): unknown {
					return vm.runInNewContext('Promise.resolve(42)');
				}, fakeContext('method', 'f').context);
				await expect(foreign()).resolves.toBe(42);
				expect(
					log.mock.calls.some(function (call) {
						return call[0] === 'f method resolved:' && call[1] === 42;
					})
				).toBe(true);
				expect(function () {
					decorators.log(method, fakeContext('class', 'C').context);
				}).toThrow(new TypeError('@log can only decorate methods, not classes'));
			} finally {
				log.mockRestore();
			}
		});

		let logSpy: jest.SpyInstance;

		beforeEach(function () {
			logSpy = jest.spyOn(console, 'log').mockImplementation(function () {});
		});

		it("should log a method's call and return value", function () {
			test.testLogMethod('arg');
			expect(logSpy).toHaveBeenCalledWith('testLogMethod method called with arguments:', ['arg']);
			expect(logSpy).toHaveBeenCalledWith('testLogMethod method returned:', 'test arg');
		});

		it('should log resolved promises and return a promise settling the same way', async function () {
			const result = test.testAsyncLogMethod(false);
			expect(result).toBeInstanceOf(Promise);
			await expect(result).resolves.toBe(1);
			await Promise.resolve();
			expect(logSpy).toHaveBeenCalledWith('testAsyncLogMethod method called with arguments:', [false]);
			expect(logSpy).toHaveBeenCalledWith('testAsyncLogMethod method resolved:', 1);
			expect(logSpy).not.toHaveBeenCalledWith('testAsyncLogMethod method returned:', expect.anything());
		});

		it('should log rejected promises and still reject', async function () {
			await expect(test.testAsyncLogMethod(true)).rejects.toThrow('async failure');
			await Promise.resolve();
			expect(logSpy).toHaveBeenCalledWith('testAsyncLogMethod method rejected:', new Error('async failure'));
		});

		it('should return a promise chained on the original, so that a rejection nobody handles still surfaces', async function () {
			const { context } = fakeContext('method', 'load');
			const error = new Error('load failed');
			let original: Promise<never> | undefined;
			const wrapped = decorators.log(function () {
				original = Promise.reject(error);
				return original;
			}, context);
			const returned = wrapped();
			// The decorator attaches no handler that would mark the caller's rejection as handled: the caller gets its own promise.
			expect(returned).not.toBe(original);
			await expect(returned).rejects.toBe(error);
			expect(logSpy).toHaveBeenCalledWith('load method rejected:', error);
		});

		it('should return other thenables untouched, without calling their then', function () {
			const { context } = fakeContext('method', 'query');
			let runs = 0;
			const lazy = {
				then: function (resolve: (value: string) => void) {
					runs++;
					resolve('rows');
				}
			};
			const wrapped = decorators.log(function () {
				return lazy;
			}, context);
			expect(wrapped()).toBe(lazy);
			expect(runs).toBe(0);
			expect(logSpy).toHaveBeenCalledWith('query method returned:', lazy);
		});

		it('should log and rethrow synchronous errors', function () {
			expect(function () {
				test.testThrowingLogMethod();
			}).toThrow('sync failure');
			expect(logSpy).toHaveBeenCalledWith('testThrowingLogMethod method threw:', new Error('sync failure'));
		});

		it('should log non-thenable object results as returned values', function () {
			const { context } = fakeContext('method', 'make');
			const result = { value: 1 };
			const wrapped = decorators.log(function () {
				return result;
			}, context);
			expect(wrapped()).toBe(result);
			expect(logSpy).toHaveBeenCalledWith('make method returned:', result);
		});

		it('should work as a standard decorator and preserve this', function () {
			const { context } = fakeContext('method', 'sum');
			const wrapped = decorators.log(function (this: { base: number }, a: number) {
				return this.base + a;
			}, context);
			expect(wrapped.call({ base: 1 }, 2)).toBe(3);
			expect(logSpy).toHaveBeenCalledWith('sum method called with arguments:', [2]);
			expect(logSpy).toHaveBeenCalledWith('sum method returned:', 3);
		});

		it('should reject non-methods', function () {
			expect(function () {
				(decorators.log as any)({}, 'prop', undefined);
			}).toThrow(new TypeError('@log can only decorate methods (prop is not a method)'));
			expect(function () {
				(decorators.log as any)(undefined, fakeContext('field', 'x').context);
			}).toThrow(new TypeError('@log can only decorate methods, not fields'));
			expect(function () {
				(decorators.log as any)(function () {}, fakeContext('getter', 'x').context);
			}).toThrow(new TypeError('@log can only decorate methods, not getters'));
			expect(function () {
				(decorators.log as any)({}, undefined, undefined);
			}).toThrow(new TypeError('@log can only decorate methods (undefined is not a method)'));
			expect(function () {
				(decorators.log as any)(undefined, fakeContext('method', 'x').context);
			}).toThrow(TypeError);
		});
	});

	describe('memoize', function () {
		it("should memoize a method's results", function () {
			expect(test.testMemoizeMethod('arg')).toBe('test arg 1');
			expect(test.testMemoizeMethod('arg')).toBe('test arg 1');
			expect(test.count).toBe(1);
		});

		it('should keep a separate cache for every instance (previously shared)', function () {
			const other = new Test(2);
			expect(test.testMemoizeMethod('arg')).toBe('test arg 1');
			expect(other.testMemoizeMethod('arg')).toBe('test arg 2');
			expect([test.count, other.count]).toEqual([1, 1]);
		});

		it('should cache falsy results', function () {
			expect(test.falsy(5)).toBe(0);
			expect(test.falsy(5)).toBe(0);
			expect(test.count).toBe(1);
		});

		it('should work on static methods and with a missing this', function () {
			staticCalls = 0;
			expect(Test.staticSquare(3)).toBe(9);
			expect(Test.staticSquare(3)).toBe(9);
			expect(staticCalls).toBe(1);

			// Without an instance there is nothing to attach a cache to: detached calls are not cached (previously they all shared one).
			const detached = Test.staticSquare;
			expect(detached.call(undefined, 4)).toBe(16);
			expect(detached.call(undefined, 4)).toBe(16);
			expect(staticCalls).toBe(3);
			expect(detached.call(null as any, 4)).toBe(16);
			expect(staticCalls).toBe(4);
		});

		it('should work as a standard decorator', function () {
			const { context } = fakeContext('method', 'm');
			const spy = jest.fn(function (x: number) {
				return x + 1;
			});
			const wrapped = decorators.memoize(spy, context);
			const a = {};
			const b = {};
			expect(wrapped.call(a, 1)).toBe(2);
			expect(wrapped.call(a, 1)).toBe(2);
			expect(wrapped.call(b, 1)).toBe(2);
			expect(spy).toHaveBeenCalledTimes(2);
		});
	});

	describe('bound', function () {
		it('should bind the method to its instance', function () {
			const { getId } = new Test(7);
			expect(getId()).toBe(7);
		});

		it('should cache the bound method as a non-enumerable own property', function () {
			const first = test.getId;
			expect(test.getId).toBe(first);
			expect(Object.getOwnPropertyDescriptor(test, 'getId')).toMatchObject({ writable: true, enumerable: false, configurable: true });
			expect(Object.keys(test)).not.toContain('getId');
		});

		it('should work on frozen instances (previously threw when caching the bound method)', function () {
			const frozen = Object.freeze(new Test(5));
			const { getId } = frozen;
			expect(getId()).toBe(5);
			expect(frozen.getId()).toBe(5);
			expect(Object.prototype.hasOwnProperty.call(frozen, 'getId')).toBe(false);
		});

		it('should return the unbound method through the prototype', function () {
			const fromPrototype = Test.prototype.getId;
			expect(fromPrototype.call(new Test(3))).toBe(3);
			expect(Object.prototype.hasOwnProperty.call(Test.prototype, 'getId')).toBe(true);
			expect(Object.getOwnPropertyDescriptor(Test.prototype, 'getId')?.get).toBeDefined();
		});

		it('should allow reassignment on an instance, like a plain assignment', function () {
			function replacement(): number {
				return 99;
			}
			test.getId = replacement;
			expect(test.getId()).toBe(99);
			expect(Object.getOwnPropertyDescriptor(test, 'getId')).toEqual({ value: replacement, writable: true, enumerable: true, configurable: true });
		});

		it('should bind static methods to the class', function () {
			const { staticName } = Test;
			expect(staticName()).toBe('Test');
		});

		it('should not shadow subclass overrides accessed through super', function () {
			class Sub extends Test {
				override getId(): number {
					return super.getId() * 10;
				}
			}

			const sub = new Sub(4);
			expect(sub.getId()).toBe(40);
			expect(sub.getId()).toBe(40);
			expect(Object.prototype.hasOwnProperty.call(sub, 'getId')).toBe(false);
		});

		it('should return the method for primitive receivers', function () {
			const descriptor = Object.getOwnPropertyDescriptor(Test.prototype, 'getId') as PropertyDescriptor;
			expect((descriptor.get as () => unknown).call(undefined)).toBeInstanceOf(Function);
		});

		it('should bind without caching for unrelated receivers', function () {
			const descriptor = Object.getOwnPropertyDescriptor(Test.prototype, 'getId') as PropertyDescriptor;
			const unrelated = { id: 8 };
			const boundMethod = (descriptor.get as () => () => number).call(unrelated);
			expect(boundMethod()).toBe(8);
			expect(Object.prototype.hasOwnProperty.call(unrelated, 'getId')).toBe(false);
		});

		it('should treat objects whose own constructor does not point back to them as instances', function () {
			const instance = new Test(13);
			Object.defineProperty(instance, 'constructor', { value: Test });
			const { getId } = instance;
			expect(getId()).toBe(13);
		});

		it('should treat objects with a non-function own constructor as instances', function () {
			const descriptor = Object.getOwnPropertyDescriptor(Test.prototype, 'getId') as PropertyDescriptor;
			const fake = Object.create(Test.prototype, { constructor: { value: 'not a function' }, id: { value: 12 } });
			const boundMethod = (descriptor.get as () => () => number).call(fake);
			expect(boundMethod()).toBe(12);
		});

		it('should bind via an initializer with standard decorators', function () {
			const { context, runInitializers } = fakeContext('method', 'getValue');

			function getValue(this: { value: number }) {
				return this.value;
			}

			expect(decorators.bound(getValue, context)).toBeUndefined();

			const instance = Object.create({ getValue }, { value: { value: 5 } });
			runInitializers(instance);
			const { getValue: extracted } = instance;
			expect(extracted()).toBe(5);
			expect(Object.getOwnPropertyDescriptor(instance, 'getValue')).toMatchObject({ enumerable: false, writable: true, configurable: true });

			const overridden = Object.create(
				{
					getValue: function () {
						return 'override';
					}
				},
				{ value: { value: 6 } }
			);
			runInitializers(overridden);
			expect(Object.prototype.hasOwnProperty.call(overridden, 'getValue')).toBe(false);
		});

		it('should reject non-methods and private methods', function () {
			expect(function () {
				(decorators.bound as any)({}, 'x', { get: function () {} });
			}).toThrow(new TypeError('@bound can only decorate methods (x is not a method)'));
			expect(function () {
				(decorators.bound as any)({}, 'x');
			}).toThrow(new TypeError('@bound can only decorate methods (x is not a method)'));
			expect(function () {
				decorators.bound(function () {}, fakeContext('method', '#x', { private: true }).context);
			}).toThrow(new TypeError('@bound can only decorate public methods, not private methods'));
			expect(function () {
				(decorators.bound as any)(undefined, fakeContext('field', 'x').context);
			}).toThrow(new TypeError('@bound can only decorate public methods, not fields'));
			expect(function () {
				(decorators.bound as any)(function () {}, fakeContext('getter', 'x').context);
			}).toThrow(new TypeError('@bound can only decorate public methods, not getters'));
			expect(function () {
				(decorators.bound as any)(function () {}, fakeContext('method', 'x', { addInitializer: undefined }).context);
			}).toThrow(new TypeError('@bound can only decorate public methods, not methods'));
			expect(function () {
				(decorators.bound as any)(undefined, fakeContext('method', 'x').context);
			}).toThrow(TypeError);
		});
	});

	describe('debounced', function () {
		it('should keep inherited options, which debounce itself reads', function () {
			jest.useFakeTimers();

			const spy = jest.fn();
			const wrapped = decorators.debounced(10, Object.create({ leading: true, trailing: false }))(spy, fakeContext('method', 'm').context);
			wrapped.call(undefined, 1);
			expect(spy.mock.calls).toEqual([[1]]);
		});

		it('should ignore options inherited from a polluted Object.prototype (previously copied as own options)', async function () {
			jest.useFakeTimers();

			const prototype = Object.prototype as Record<string, unknown>;
			prototype.leading = true;
			prototype.trailing = false;
			prototype.retries = 0;
			try {
				const debouncedSpy = jest.fn();
				const throttledSpy = jest.fn();
				const debounce = decorators.debounced(10, {})(debouncedSpy, fakeContext('method', 'm').context);
				const throttle = decorators.throttled(10, { trailing: true })(throttledSpy, fakeContext('method', 'n').context);
				debounce.call(undefined, 1);
				throttle.call(undefined, 1);
				throttle.call(undefined, 2);
				// Not invoked on the leading edge; the trailing calls still run.
				expect(debouncedSpy).not.toHaveBeenCalled();
				jest.advanceTimersByTime(10);
				expect([debouncedSpy.mock.calls, throttledSpy.mock.calls]).toEqual([[[1]], [[1], [2]]]);
				// A planted value is not copied either for `retry` (which reads its options by plain property access).
				let attempts = 0;
				const flaky = decorators.retryable({ delay: 0 })(function (): Promise<string> {
					attempts++;
					return attempts < 2 ? Promise.reject(new Error('busy')) : Promise.resolve('ok');
				}, fakeContext('method', 'f').context);
				jest.useRealTimers();
				delete prototype.retries;
				await expect(flaky()).resolves.toBe('ok');
				expect(attempts).toBe(2);
			} finally {
				delete prototype.leading;
				delete prototype.trailing;
				delete prototype.retries;
			}
		});

		it('should copy a `__proto__` option as an option, not as the prototype of the copy', function () {
			jest.useFakeTimers();

			const spy = jest.fn();
			// As `JSON.parse` creates it: an own `__proto__` property, which the helpers do not read.
			const options = JSON.parse('{"__proto__": {"leading": true}, "maxWait": 50}') as DebounceOptions;
			const wrapped = decorators.debounced(10, options)(spy, fakeContext('method', 'm').context);
			wrapped.call(undefined, 1);
			// Previously the copy inherited `leading: true` from it, and invoked on the leading edge.
			expect(spy).not.toHaveBeenCalled();
			jest.advanceTimersByTime(10);
			expect(spy.mock.calls).toEqual([[1]]);
		});

		it('should use the options it validated, whatever later happens to the object', function () {
			jest.useFakeTimers();

			const options = { leading: true, trailing: true };
			const debouncedSpy = jest.fn();
			const throttledSpy = jest.fn();
			const debounce = decorators.debounced(10, options)(debouncedSpy, fakeContext('method', 'm').context);
			const throttle = decorators.throttled(10, options)(throttledSpy, fakeContext('method', 'n').context);
			options.leading = false;
			options.trailing = false;
			debounce.call(undefined, 1);
			throttle.call(undefined, 1);
			expect([debouncedSpy.mock.calls, throttledSpy.mock.calls]).toEqual([[[1]], [[1]]]);
		});

		it('should debounce per instance', function () {
			jest.useFakeTimers();

			const other = new Test(2);
			test.debouncedMethod(1);
			test.debouncedMethod(2);
			other.debouncedMethod(3);
			expect(calls).toEqual([]);

			jest.advanceTimersByTime(100);
			expect(calls).toEqual([
				['debounced', 1, 2],
				['debounced', 2, 3]
			]);
		});

		it('should validate its arguments eagerly', function () {
			expect(function () {
				decorators.debounced(-1);
			}).toThrow(new RangeError('debounce: `wait` must be a finite number >= 0, got -1'));
			expect(function () {
				decorators.debounced(10, { leading: false, trailing: false });
			}).toThrow(new RangeError('debounce: at least one of `leading` or `trailing` must be true'));
		});

		it('should work as a standard decorator', function () {
			jest.useFakeTimers();

			const spy = jest.fn();
			const wrapped = decorators.debounced(10)(spy, fakeContext('method', 'm').context);
			wrapped.call(undefined, 1);
			wrapped.call(undefined, 2);
			jest.advanceTimersByTime(10);
			expect(spy.mock.calls).toEqual([[2]]);
		});
	});

	describe('throttled', function () {
		it('should throttle per instance', function () {
			jest.useFakeTimers();

			const other = new Test(2);
			test.throttledMethod(1);
			test.throttledMethod(2);
			other.throttledMethod(3);
			other.throttledMethod(4);
			expect(calls).toEqual([
				['throttled', 1, 1],
				['throttled', 2, 3]
			]);

			jest.advanceTimersByTime(100);
			test.throttledMethod(5);
			expect(calls[calls.length - 1]).toEqual(['throttled', 1, 5]);
		});

		it('should validate its arguments eagerly', function () {
			expect(function () {
				decorators.throttled(NaN);
			}).toThrow(new RangeError('throttle: `wait` must be a finite number >= 0, got NaN'));
		});

		it('should reject non-methods', function () {
			expect(function () {
				(decorators.throttled(10) as any)({}, 'field', undefined);
			}).toThrow(new TypeError('@throttled can only decorate methods (field is not a method)'));
		});
	});

	describe('deprecated', function () {
		let warnSpy: jest.SpyInstance;

		beforeEach(function () {
			warnSpy = jest.spyOn(console, 'warn').mockImplementation(function () {});
		});

		it('should warn once per method, not per call or instance', function () {
			const other = new Test(2);
			expect(test.oldMethod()).toBe(1);
			expect(test.oldMethod()).toBe(1);
			expect(other.oldMethod()).toBe(2);
			expect(test.otherOldMethod()).toBe('other');
			expect(warnSpy.mock.calls).toEqual([['oldMethod is deprecated.'], ['Use something else.']]);
		});

		it('should work as a standard decorator', function () {
			const wrapped = decorators.deprecated()(function () {
				return 'x';
			}, fakeContext('method', 'legacyApi').context);
			expect(wrapped()).toBe('x');
			expect(wrapped()).toBe('x');
			expect(warnSpy.mock.calls).toEqual([['legacyApi is deprecated.']]);
		});
	});
});

describe('Decorators (round 2)', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('once', function () {
		class Service {
			static staticRuns = 0;
			runs = 0;

			name: string;

			constructor(name: string) {
				this.name = name;
			}

			@decorators.once
			init(suffix: string): string {
				this.runs++;
				return `${this.name}${suffix}`;
			}

			@decorators.once
			fail(): never {
				this.runs++;
				throw new Error(`fail ${this.name}`);
			}

			@decorators.once
			static setup(): number {
				Service.staticRuns++;
				return Service.staticRuns;
			}
		}

		it('should run once per instance and return the first result', function () {
			const a = new Service('a');
			const b = new Service('b');
			expect([a.init('!'), a.init('?'), b.init('?')]).toEqual(['a!', 'a!', 'b?']);
			expect([a.runs, b.runs]).toEqual([1, 1]);
		});

		it('should rethrow the first error on later calls', function () {
			const a = new Service('a');
			expect(function () {
				a.fail();
			}).toThrow('fail a');
			expect(function () {
				a.fail();
			}).toThrow('fail a');
			expect(a.runs).toBe(1);
		});

		it('should run static methods once per class', function () {
			expect([Service.setup(), Service.setup()]).toEqual([1, 1]);
		});

		it('should work with subclass overrides calling super', function () {
			class Sub extends Service {
				override init(suffix: string): string {
					return `sub:${super.init(suffix)}`;
				}
			}

			const sub = new Sub('s');
			expect([sub.init('1'), sub.init('2')]).toEqual(['sub:s1', 'sub:s1']);
			expect(sub.runs).toBe(1);
		});

		it('should work as a standard decorator and reject non-methods', function () {
			const spy = jest.fn(function () {
				return 'x';
			});
			const wrapped = decorators.once(spy, fakeContext('method', 'm').context);
			const a = {};
			expect([wrapped.call(a), wrapped.call(a), wrapped.call({})]).toEqual(['x', 'x', 'x']);
			expect(spy).toHaveBeenCalledTimes(2);
			expect(function () {
				(decorators.once as any)({}, 'getter', { get: function () {} });
			}).toThrow(new TypeError('@once can only decorate methods (getter is not a method)'));
			expect(function () {
				(decorators.once as any)(undefined, fakeContext('getter', 'g').context);
			}).toThrow(new TypeError('@once can only decorate methods, not getters'));
		});
	});

	describe('retryable', function () {
		class Client {
			attempts = 0;

			private readonly failures: number;

			constructor(failures: number) {
				this.failures = failures;
			}

			@decorators.retryable({ retries: 3 })
			async fetch(id: number): Promise<string> {
				this.attempts++;
				if (this.attempts <= this.failures) throw new Error(`attempt ${this.attempts} failed`);
				return `item ${id} after ${this.attempts}`;
			}

			@decorators.retryable()
			async fetchDefault(): Promise<number> {
				this.attempts++;
				if (this.attempts < 2) throw new Error('once');
				return this.attempts;
			}
		}

		it('should retry with the same this and arguments', async function () {
			await expect(new Client(2).fetch(7)).resolves.toBe('item 7 after 3');
			await expect(new Client(0).fetch(1)).resolves.toBe('item 1 after 1');
			await expect(new Client(1).fetchDefault()).resolves.toBe(2);
		});

		it('should reject with the last error once retries are exhausted', async function () {
			const client = new Client(10);
			await expect(client.fetch(1)).rejects.toThrow('attempt 4 failed');
			expect(client.attempts).toBe(4);
		});

		it('should wait between attempts, with jitter from the random source', async function () {
			jest.useFakeTimers();

			const times: number[] = [];
			const start = Date.now();
			const method = jest.fn(async function () {
				times.push(Date.now() - start);
				if (times.length < 3) throw new Error('again');
				return 'ok';
			});
			const wrapped = decorators.retryable({ delay: 100, jitter: true }, function () {
				return 0.5;
			})(method, fakeContext('method', 'm').context);
			const promise = wrapped();
			await jest.advanceTimersByTimeAsync(1000);
			await expect(promise).resolves.toBe('ok');
			expect(times).toEqual([0, 50, 150]);
		});

		it('should snapshot the options and report invalid options on call', async function () {
			const options = { retries: 0 };
			const decorator = decorators.retryable(options);
			options.retries = 5;
			const method = jest.fn(async function () {
				throw new Error('no retry');
			});
			await expect(decorator(method, fakeContext('method', 'm').context)()).rejects.toThrow('no retry');
			expect(method).toHaveBeenCalledTimes(1);

			const invalid = decorators.retryable({ retries: -1 })(method, fakeContext('method', 'm').context);
			await expect(invalid()).rejects.toThrow(new RangeError('retry: `retries` must be an integer >= 0 or Infinity, got -1'));
		});

		it('should turn synchronous throws into rejections and reject non-methods', async function () {
			const wrapped = (decorators.retryable({ retries: 1 }) as any)(function () {
				throw new Error('sync');
			}, fakeContext('method', 'm').context);
			await expect(wrapped()).rejects.toThrow('sync');
			expect(function () {
				(decorators.retryable() as any)({}, 'field', undefined);
			}).toThrow(new TypeError('@retryable can only decorate methods (field is not a method)'));
		});
	});

	describe('timeout', function () {
		class Api {
			private readonly latency: number;

			constructor(latency: number) {
				this.latency = latency;
			}

			@decorators.timeout(100)
			async load(value: string): Promise<string> {
				await sleep(this.latency);
				return `${value}:${this.latency}`;
			}
		}

		it('should resolve when the method settles in time, preserving this, and clear the timer', async function () {
			jest.useFakeTimers();

			const promise = new Api(50).load('x');
			await jest.advanceTimersByTimeAsync(50);
			await expect(promise).resolves.toBe('x:50');
			expect(jest.getTimerCount()).toBe(0);
		});

		it('should reject with a TimeoutError when too slow', async function () {
			jest.useFakeTimers();

			const promise = new Api(500).load('x');
			const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError', message: 'Operation timed out after 100 ms' });
			await jest.advanceTimersByTimeAsync(100);
			await assertion;
		});

		it('should use a custom message and forward rejections and synchronous throws', async function () {
			jest.useFakeTimers();

			const slow = decorators.timeout(10, 'too slow')(function () {
				return new Promise(function () {});
			}, fakeContext('method', 'm').context);
			const assertion = expect(slow()).rejects.toThrow('too slow');
			await jest.advanceTimersByTimeAsync(10);
			await assertion;

			const rejecting = decorators.timeout(10)(function () {
				return Promise.reject(new Error('rejected'));
			}, fakeContext('method', 'm').context);
			await expect(rejecting()).rejects.toThrow('rejected');

			const throwing = (decorators.timeout(10) as any)(function () {
				throw new Error('thrown');
			}, fakeContext('method', 'm').context);
			await expect(throwing()).rejects.toThrow('thrown');
		});

		it.each([-1, NaN, 2 ** 31])('should throw a RangeError eagerly for ms = %p', function (ms) {
			expect(function () {
				decorators.timeout(ms);
			}).toThrow(new RangeError(`@timeout: \`ms\` must be a number between 0 and 2147483647, got ${ms}`));
		});

		it('should throw a TypeError eagerly for a non-number ms', function () {
			expect(function () {
				decorators.timeout('10' as any);
			}).toThrow(new TypeError('@timeout: `ms` must be a number between 0 and 2147483647, got string'));
		});
	});

	describe('edge cases: symbols, statics, getters, subclasses', function () {
		const key = Symbol('compute');

		class Edge {
			calls = 0;

			@decorators.memoize
			[key](n: number): number {
				this.calls++;
				return n * 2;
			}

			@decorators.bound
			static staticBound(): string {
				return (this as unknown as { name: string }).name;
			}

			@decorators.debounced(10)
			static staticDebounced(value: number): void {
				staticDebouncedCalls.push(value);
			}
		}

		const staticDebouncedCalls: number[] = [];

		it('should support symbol-keyed methods (including in log messages)', function () {
			const logSpy = jest.spyOn(console, 'log').mockImplementation(function () {});
			const edge = new Edge();
			expect([edge[key](2), edge[key](2)]).toEqual([4, 4]);
			expect(edge.calls).toBe(1);

			const descriptor = decorators.log({}, key, { value: function () {}, writable: true, configurable: true });
			(descriptor.value as () => void)();
			expect(logSpy).toHaveBeenCalledWith('Symbol(compute) method called with arguments:', []);
		});

		it('should bind static methods inherited by subclasses to the subclass', function () {
			class SubEdge extends Edge {}

			const { staticBound } = SubEdge;
			expect(staticBound()).toBe('SubEdge');
			expect(Edge.staticBound()).toBe('Edge');
		});

		it('should bind an inherited static method to the subclass even after the base class read it', function () {
			class LaterEdge extends Edge {}

			const { staticBound: baseBound } = Edge;
			expect(baseBound()).toBe('Edge');
			expect(Edge.staticBound).toBe(baseBound);
			const { staticBound } = LaterEdge;
			expect(staticBound()).toBe('LaterEdge');
		});

		it('should bind an inherited static method to each subclass at any depth (regression: a subclass of a subclass got its parent)', function () {
			class Middle extends Edge {}
			class Leaf extends Middle {}

			const { staticBound: middleBound } = Middle;
			expect(middleBound()).toBe('Middle');
			expect(Middle.staticBound).toBe(middleBound);
			expect(Object.hasOwn(Middle, 'staticBound')).toBe(false);
			// Previously `Middle` kept its bound method as an own property, which `Leaf` inherited: 'Middle'.
			const { staticBound: leafBound } = Leaf;
			expect(leafBound()).toBe('Leaf');
			expect(Leaf.staticBound).toBe(leafBound);
		});

		it('should bind standard static methods lazily, so subclasses bind them to themselves', function () {
			const { context, runInitializers } = fakeContext('method', 'who', { static: true });
			/**
			 * Returns the name of the class it is called on.
			 */
			function who(this: { name: string }): string {
				return this.name;
			}
			class Base {}
			Object.defineProperty(Base, 'who', { value: who, configurable: true, writable: true });
			class Sub extends Base {}
			decorators.bound(who, context);
			runInitializers(Base);

			const { who: baseWho } = Base as unknown as { who: () => string };
			const { who: subWho } = Sub as unknown as { who: () => string };
			expect(baseWho()).toBe('Base');
			expect(subWho()).toBe('Sub');
		});

		it('should debounce static methods', function () {
			jest.useFakeTimers();

			Edge.staticDebounced(1);
			Edge.staticDebounced(2);
			jest.advanceTimersByTime(10);
			expect(staticDebouncedCalls).toEqual([2]);
		});

		it('should reject getters for every method decorator', function () {
			const getter = {
				get: function () {
					return 1;
				},
				configurable: true
			};
			const decorated: Array<[unknown, string]> = [
				[decorators.log, 'log'],
				[decorators.memoize, 'memoize'],
				[decorators.once, 'once'],
				[decorators.bound, 'bound'],
				[decorators.debounced(1), 'debounced'],
				[decorators.throttled(1), 'throttled'],
				[decorators.deprecated(), 'deprecated'],
				[decorators.timeout(1), 'timeout']
			];
			decorated.forEach(function ([decorator, name]: [any, string]) {
				expect(function () {
					decorator({}, 'value', getter);
				}).toThrow(new TypeError(`@${name} can only decorate methods (value is not a method)`));
				expect(function () {
					decorator(undefined, fakeContext('field', 'value').context);
				}).toThrow(
					name === 'bound' ? new TypeError('@bound can only decorate public methods, not fields') : new TypeError(`@${name} can only decorate methods, not fields`)
				);
			});
		});
	});
});

describe('Decorators (security)', function () {
	describe('memoize / once without an instance', function () {
		it('@memoize should not share results between calls whose `this` is a primitive or missing', function () {
			const spy = jest.fn(function (this: unknown, n: number) {
				return `${String(this)}:${n}`;
			});
			const wrapped = decorators.memoize(spy, fakeContext('method', 'm').context);
			expect(wrapped.call('abc' as any, 1)).toBe('abc:1');
			expect(wrapped.call('xyz' as any, 1)).toBe('xyz:1');
			expect(wrapped.call(undefined, 1)).toBe('undefined:1');
			expect(wrapped.call(undefined, 1)).toBe('undefined:1');
			expect(spy).toHaveBeenCalledTimes(4);
		});

		it('@once should not let one detached call decide the result of another', function () {
			const spy = jest.fn(function (this: unknown) {
				return String(this);
			});
			const wrapped = decorators.once(spy, fakeContext('method', 'm').context);
			expect([wrapped.call('abc' as any), wrapped.call('xyz' as any), wrapped.call(undefined)]).toEqual(['abc', 'xyz', 'undefined']);
			const a = {};
			expect([wrapped.call(a), wrapped.call(a)]).toEqual(['[object Object]', '[object Object]']);
			expect(spy).toHaveBeenCalledTimes(4);
		});
	});

	describe('memoize options (bounded per-instance caches)', function () {
		it('should create one cache per instance with createCache, and let an LRU bound it', function () {
			const created: Array<LRUCache<unknown, unknown>> = [];
			class Repo {
				calls = 0;

				@decorators.memoize({
					createCache: function () {
						const cache = createLRUCache<unknown, unknown>({ max: 2 });
						created.push(cache);
						return cache;
					}
				})
				find(id: number): string {
					this.calls++;
					return `item ${id}`;
				}
			}

			const repo = new Repo();
			expect([repo.find(1), repo.find(2), repo.find(1), repo.find(3), repo.find(2)]).toEqual(['item 1', 'item 2', 'item 1', 'item 3', 'item 2']);
			// 1, 2 computed; 1 cached; 3 evicts 2; 2 recomputed.
			expect(repo.calls).toBe(4);
			expect(created).toHaveLength(1);
			expect(created[0].size).toBe(2);

			const other = new Repo();
			expect(other.find(1)).toBe('item 1');
			expect(other.calls).toBe(1);
			expect(created).toHaveLength(2);
		});

		it('should use the resolver, with the instance as `this`', function () {
			const spy = jest.fn(function (user: { id: number; name: string }) {
				return user.name;
			});
			const decorate = decorators.memoize({
				resolver: function (this: { prefix: string }, user: { id: number }): string {
					return `${this.prefix}${user.id}`;
				}
			});
			const wrapped = decorate(spy, fakeContext('method', 'm').context);
			const self = { prefix: 'u' };
			expect(wrapped.call(self, { id: 1, name: 'a' })).toBe('a');
			expect(wrapped.call(self, { id: 1, name: 'b' })).toBe('a');
			expect(spy).toHaveBeenCalledTimes(1);

			const legacy = decorate({}, 'm', { value: spy, writable: true, configurable: true, enumerable: false });
			expect((legacy.value as any).call(self, { id: 2, name: 'c' })).toBe('c');
		});

		it('should ignore options inherited from a polluted Object.prototype', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			const shared = new Map<unknown, unknown>();
			prototype.resolver = function (): string {
				return 'same key';
			};
			prototype.createCache = function (): Map<unknown, unknown> {
				return shared;
			};
			try {
				const spy = jest.fn(function (n: number): number {
					return n * 2;
				});
				const wrapped = decorators.memoize({})(spy, fakeContext('method', 'm').context);
				const self = {};
				// Previously both calls hit the planted resolver's single key, in the planted (shared) cache: 2, 2.
				expect([wrapped.call(self, 1), wrapped.call(self, 2), wrapped.call(self, 1)]).toEqual([2, 4, 2]);
				expect(spy).toHaveBeenCalledTimes(2);
				expect(shared.size).toBe(0);
			} finally {
				delete prototype.resolver;
				delete prototype.createCache;
			}
		});

		it('should ignore a resolver or cache factory planted on Object.prototype before the first bare @memoize (regression)', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			const shared = new Map<unknown, unknown>();
			prototype.resolver = function (): string {
				return 'same key';
			};
			prototype.createCache = function (): Map<unknown, unknown> {
				return shared;
			};
			try {
				let fresh!: typeof decorators;
				// A fresh module: the bare decorator's wrapper is created on its first use, which must not read the planted options.
				jest.isolateModules(function () {
					// eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh copy of the module
					fresh = require('.') as typeof decorators;
				});
				const spy = jest.fn(function (n: number): number {
					return n * 2;
				});
				const wrapped = fresh.memoize(spy, fakeContext('method', 'm').context);
				const self = {};
				// Previously both calls hit the planted resolver's single key, in the planted (shared) cache: 2, 2.
				expect([wrapped.call(self, 1), wrapped.call(self, 2), wrapped.call(self, 1)]).toEqual([2, 4, 2]);
				expect(spy).toHaveBeenCalledTimes(2);
				expect(shared.size).toBe(0);
			} finally {
				delete prototype.resolver;
				delete prototype.createCache;
			}
		});

		it('should not mistake a legacy property key for a standard context when Object.prototype has a planted kind (regression)', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.kind = 'method';
			try {
				const spy = jest.fn(function (n: number): number {
					return n * 2;
				});
				// Previously the key's inherited `kind` made it a standard context: "@memoize can only decorate methods, not methods".
				const descriptor = decorators.memoize({}, 'm', { value: spy, writable: true, configurable: true });
				const self = {};
				expect([(descriptor.value as typeof spy).call(self, 1), (descriptor.value as typeof spy).call(self, 1)]).toEqual([2, 2]);
				expect(spy).toHaveBeenCalledTimes(1);
			} finally {
				delete prototype.kind;
			}
		});

		it('should validate the options when the decorator is created', function () {
			expect(function () {
				decorators.memoize(null as any);
			}).toThrow(new TypeError('@memoize: `options` must be an object, got null'));
			expect(function () {
				decorators.memoize({ resolver: 1 as any });
			}).toThrow(new TypeError('@memoize: `options.resolver` must be a function, got number'));
			expect(function () {
				decorators.memoize({ createCache: {} as any });
			}).toThrow(new TypeError('@memoize: `options.createCache` must be a function, got object'));
			expect(function () {
				(decorators.memoize({}) as any)({}, 'getter', { get: function () {} });
			}).toThrow(new TypeError('@memoize can only decorate methods (getter is not a method)'));
		});
	});
});

/**
 * A clock that advances by `step` ms on every read, starting at 0.
 * @param {number} step - The step
 * @returns {() => number} The clock
 */
function steppingClock(step: number): () => number {
	let time = -step;
	return function (): number {
		time += step;
		return time;
	};
}

describe('Decorators (1.4)', function () {
	describe('lazy', function () {
		let computed = 0;

		class Lazy {
			constructor(readonly base: number) {}

			@decorators.lazy
			get value(): number {
				computed++;
				return this.base * 2;
			}

			@decorators.lazy
			get nothing(): undefined {
				computed++;
				return undefined;
			}

			@decorators.lazy
			static get shared(): string {
				computed++;
				return `shared by ${(this as unknown as { name: string }).name}`;
			}
		}

		beforeEach(function () {
			computed = 0;
		});

		it('computes once per instance, on first read, with the instance as this', function () {
			const first = new Lazy(1);
			const second = new Lazy(2);
			expect(computed).toBe(0);
			expect([first.value, first.value, first.value]).toEqual([2, 2, 2]);
			expect(computed).toBe(1);
			expect(second.value).toBe(4);
			expect(second.value).toBe(4);
			expect(computed).toBe(2);
			expect(first.nothing).toBeUndefined();
			expect(first.nothing).toBeUndefined();
			expect(computed).toBe(3);
		});

		it('caches a non-enumerable, read-only own property that deleting resets', function () {
			const instance = new Lazy(3);
			expect(instance.value).toBe(6);
			expect(Object.getOwnPropertyDescriptor(instance, 'value')).toEqual({ value: 6, writable: false, enumerable: false, configurable: true });
			expect(Object.keys(instance)).toEqual(['base']);
			expect(JSON.stringify(instance)).toBe('{"base":3}');
			expect(function () {
				(instance as { value: number }).value = 1;
			}).toThrow(TypeError);
			delete (instance as { value?: number }).value;
			expect(instance.value).toBe(6);
			expect(computed).toBe(2);
		});

		it('does not cache errors', function () {
			let attempts = 0;
			class Flaky {
				@decorators.lazy
				get value(): string {
					attempts++;
					if (attempts < 3) throw new Error(`attempt ${attempts}`);
					return 'ready';
				}
			}
			const flaky = new Flaky();
			expect(function () {
				return flaky.value;
			}).toThrow('attempt 1');
			expect(function () {
				return flaky.value;
			}).toThrow('attempt 2');
			expect(flaky.value).toBe('ready');
			expect(flaky.value).toBe('ready');
			expect(attempts).toBe(3);
		});

		it('computes once on frozen instances, keeping the value in a WeakMap', function () {
			const frozen = Object.freeze(new Lazy(5));
			expect([frozen.value, frozen.value, frozen.nothing, frozen.nothing]).toEqual([10, 10, undefined, undefined]);
			expect(computed).toBe(2);
			expect(Object.hasOwn(frozen, 'value')).toBe(false);
		});

		it('works through inheritance, and does not let super reads shadow an override', function () {
			class Child extends Lazy {}
			const child = new Child(4);
			expect([child.value, child.value]).toEqual([8, 8]);
			expect(computed).toBe(1);
			expect(Object.hasOwn(child, 'value')).toBe(true);

			class Override extends Lazy {
				override get value(): number {
					return super.value + 1;
				}
			}
			const override = new Override(1);
			expect([override.value, override.value, override.value]).toEqual([3, 3, 3]);
			expect(computed).toBe(2);
			expect(Object.hasOwn(override, 'value')).toBe(false);
		});

		it('never caches on a prototype read directly', function () {
			const prototype = Lazy.prototype as unknown as { base: number; value: number };
			expect(prototype.value).toBeNaN();
			expect(prototype.value).toBeNaN();
			expect(computed).toBe(1);
			expect(typeof Object.getOwnPropertyDescriptor(Lazy.prototype, 'value')?.get).toBe('function');
			class Child extends Lazy {}
			expect((Child.prototype as unknown as { value: number }).value).toBeNaN();
			expect(Object.hasOwn(Child.prototype, 'value')).toBe(false);
			expect(new Child(1).value).toBe(2);
		});

		it('computes static getters once per class, subclasses getting their own value', function () {
			expect([Lazy.shared, Lazy.shared]).toEqual(['shared by Lazy', 'shared by Lazy']);
			expect(typeof Object.getOwnPropertyDescriptor(Lazy, 'shared')?.get).toBe('function');
			class Sub extends Lazy {}
			expect([Sub.shared, Sub.shared]).toEqual(['shared by Sub', 'shared by Sub']);
			expect(Lazy.shared).toBe('shared by Lazy');
			expect(computed).toBe(2);
		});

		it('computes static getters once per class at any depth of subclassing (regression: a subclass of a subclass inherited its value)', function () {
			class Sub extends Lazy {}
			class SubSub extends Sub {}
			expect([Sub.shared, Sub.shared]).toEqual(['shared by Sub', 'shared by Sub']);
			// Previously `Sub` kept its value as an own property, which `SubSub` inherited: 'shared by Sub'.
			expect([SubSub.shared, SubSub.shared]).toEqual(['shared by SubSub', 'shared by SubSub']);
			expect(Object.hasOwn(Sub, 'shared')).toBe(false);
			expect(computed).toBe(2);
		});

		it('keeps the value in a WeakMap when the getter defined the property itself, or the receiver resolves elsewhere', function () {
			let runs = 0;
			class SelfDefining {
				@decorators.lazy
				get value(): number {
					runs++;
					Object.defineProperty(this, 'value', { get: constant(-1), configurable: false });
					return runs;
				}
			}
			const instance = new SelfDefining();
			expect(instance.value).toBe(1);
			expect(instance.value).toBe(-1);
			const getter = Object.getOwnPropertyDescriptor(Lazy.prototype, 'value')?.get as () => number;
			const receiver = Object.create(null) as { base: number };
			receiver.base = 7;
			expect([getter.call(receiver), getter.call(receiver)]).toEqual([14, 14]);
			const elsewhere = Object.assign(Object.create({ value: 'other' }), { base: 8 }) as { base: number };
			expect([Reflect.get(Lazy.prototype, 'value', elsewhere), Reflect.get(Lazy.prototype, 'value', elsewhere)]).toEqual([16, 16]);
			expect(computed).toBe(2);
			expect(Object.hasOwn(elsewhere, 'value')).toBe(false);
		});

		it('computes once for a proxy whose traps throw', function () {
			const proxy = new Proxy(new Lazy(6), {
				defineProperty: function (): never {
					throw new Error('defineProperty');
				}
			});
			expect([proxy.value, proxy.value]).toEqual([12, 12]);
			expect(computed).toBe(1);
		});

		it('runs the getter on every read with a primitive receiver', function () {
			const getter = Object.getOwnPropertyDescriptor(Lazy.prototype, 'value')?.get as () => number;
			// A number receiver reads `base` from `Number.prototype`: undefined.
			expect(getter.call(5 as never)).toBeNaN();
			expect(Reflect.get(Lazy.prototype, 'value', 5)).toBeNaN();
			expect(computed).toBe(2);
		});

		it('supports symbol keys and keeps the other descriptor attributes (Babel legacy)', function () {
			const key = Symbol('lazy');
			const descriptor = decorators.lazy({}, key, { get: constant(1), enumerable: true, configurable: true });
			expect(descriptor.enumerable).toBe(true);
			expect(descriptor.configurable).toBe(true);
			const target = {};
			Object.defineProperty(Object.getPrototypeOf(target), key, descriptor);
			try {
				expect((target as Record<symbol, number>)[key]).toBe(1);
				expect(Object.getOwnPropertyDescriptor(target, key)?.value).toBe(1);
			} finally {
				delete (Object.prototype as Record<symbol, unknown>)[key];
			}
		});

		it('rejects what is not a getter (legacy)', function () {
			expect(function () {
				decorators.lazy({}, 'method', { value: noop, writable: true });
			}).toThrow(new TypeError('@lazy can only decorate getters (method is not a getter)'));
			expect(function () {
				decorators.lazy({}, 'field', undefined as never);
			}).toThrow(new TypeError('@lazy can only decorate getters (field is not a getter)'));
			expect(function () {
				decorators.lazy({}, 'pair', { get: constant(1), set: noop });
			}).toThrow(new TypeError('@lazy cannot decorate pair, which has a setter'));
		});

		describe('standard decorators', function () {
			it('caches public getters on the instance', function () {
				let runs = 0;
				const getter = decorators.lazy(function (this: { base: number }): number {
					runs++;
					return this.base + 1;
				}, fakeContext('getter', 'next').context);
				class Host {
					base = 1;
				}
				Object.defineProperty(Host.prototype, 'next', { get: getter, configurable: true });
				const host = new Host() as Host & { next: number };
				expect([host.next, host.next]).toEqual([2, 2]);
				expect(runs).toBe(1);
				expect(Object.getOwnPropertyDescriptor(host, 'next')?.value).toBe(2);
			});

			it('keeps the values of private getters in a WeakMap', function () {
				let runs = 0;
				const getter = decorators.lazy(
					function (this: { base: number }): number {
						runs++;
						return this.base * 3;
					},
					fakeContext('getter', '#secret', { private: true }).context
				);
				const host = { base: 2 };
				expect([getter.call(host), getter.call(host)]).toEqual([6, 6]);
				expect(getter.call({ base: 1 })).toBe(3);
				expect(runs).toBe(2);
				expect(Object.getOwnPropertyNames(host)).toEqual(['base']);
			});

			it.each(['method', 'setter', 'field', 'accessor', 'class'])('rejects %s contexts', function (kind) {
				expect(function () {
					decorators.lazy(noop as never, fakeContext(kind, 'x').context);
				}).toThrow(new TypeError(`@lazy can only decorate getters, not ${kind === 'class' ? 'classes' : `${kind}s`}`));
			});

			it('rejects a getter context without a function', function () {
				expect(function () {
					decorators.lazy(undefined as never, fakeContext('getter', 'x').context);
				}).toThrow(new TypeError('@lazy can only decorate getters, not getters'));
			});
		});
	});

	describe('measure', function () {
		it('reports sync calls, preserving this, arguments and the result', function () {
			const measurements: Array<[unknown, decorators.Measurement]> = [];
			class Work {
				factor = 3;

				@decorators.measure({
					clock: steppingClock(5),
					onMeasure: function (this: unknown, measurement: decorators.Measurement): void {
						measurements.push([this, measurement]);
					}
				})
				scale(n: number, extra?: string): string {
					return `${n * this.factor}${extra ?? ''}`;
				}
			}
			const work = new Work();
			expect(work.scale(2, '!')).toBe('6!');
			expect(measurements).toEqual([[work, { name: 'scale', duration: 5, args: [2, '!'], failed: false, error: undefined }]]);
			expect(Object.keys(measurements[0][1])).toEqual(['name', 'duration', 'args', 'failed', 'error']);
		});

		it('reports and rethrows sync errors', function () {
			const onMeasure = jest.fn();
			const error = new RangeError('boom');
			const method = decorators.measure({ onMeasure, clock: steppingClock(2), name: 'custom' })(function (): never {
				throw error;
			}, fakeContext('method', 'm').context);
			expect(function () {
				method();
			}).toThrow(error);
			expect(onMeasure).toHaveBeenCalledWith({ name: 'custom', duration: 2, args: [], failed: true, error });
			const thrownUndefined = decorators.measure({ onMeasure, clock: steppingClock(1) })(function (): never {
				throw undefined;
			}, fakeContext('method', 'u').context);
			expect(function () {
				thrownUndefined();
			}).toThrow();
			expect(onMeasure).toHaveBeenLastCalledWith({ name: 'u', duration: 1, args: [], failed: true, error: undefined });
		});

		it('times promises until they settle, returning a promise that settles the same way', async function () {
			const onMeasure = jest.fn();
			const clock = jest.fn(steppingClock(10));
			const decorate = decorators.measure({ onMeasure, clock });
			const resolving = decorate(function (value: number): Promise<number> {
				return Promise.resolve(value * 2);
			}, fakeContext('method', 'resolving').context);
			const promise = resolving(21);
			expect(onMeasure).not.toHaveBeenCalled();
			expect(clock).toHaveBeenCalledTimes(1);
			await expect(promise).resolves.toBe(42);
			expect(onMeasure).toHaveBeenCalledWith({ name: 'resolving', duration: 10, args: [21], failed: false, error: undefined });
			const error = new Error('rejected');
			const original = Promise.reject(error);
			const rejecting = decorate(function (): Promise<never> {
				return original;
			}, fakeContext('method', 'rejecting').context);
			const returned = rejecting();
			expect(returned).not.toBe(original);
			await expect(returned).rejects.toBe(error);
			expect(onMeasure).toHaveBeenLastCalledWith({ name: 'rejecting', duration: 10, args: [], failed: true, error });
			const foreign = decorate(function (): unknown {
				return vm.runInNewContext('Promise.resolve("foreign")');
			}, fakeContext('method', 'foreign').context);
			await expect(foreign()).resolves.toBe('foreign');
			expect(onMeasure).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'foreign', failed: false }));
		});

		it('returns other thenables untouched, timed as returned', function () {
			const onMeasure = jest.fn();
			const thenable = { then: jest.fn() };
			const method = decorators.measure({ onMeasure })(function (): unknown {
				return thenable;
			}, fakeContext('method', 'lazyQuery').context);
			expect(method()).toBe(thenable);
			expect(thenable.then).not.toHaveBeenCalled();
			expect(onMeasure).toHaveBeenCalledWith(expect.objectContaining({ name: 'lazyQuery', failed: false }));
		});

		it('ignores what onMeasure throws', async function () {
			const onMeasure = jest.fn(function (): never {
				throw new Error('reporter');
			});
			const decorate = decorators.measure({ onMeasure });
			const sync = decorate(constant(1), fakeContext('method', 'sync').context);
			expect(sync()).toBe(1);
			const failing = decorate(function (): never {
				throw new TypeError('own');
			}, fakeContext('method', 'failing').context);
			expect(function () {
				failing();
			}).toThrow(new TypeError('own'));
			const async = decorate(function (): Promise<string> {
				return Promise.resolve('ok');
			}, fakeContext('method', 'async').context);
			await expect(async()).resolves.toBe('ok');
			const rejected = decorate(function (): Promise<never> {
				return Promise.reject(new RangeError('own'));
			}, fakeContext('method', 'rejected').context);
			await expect(rejected()).rejects.toThrow(new RangeError('own'));
			expect(onMeasure).toHaveBeenCalledTimes(4);
		});

		it('ignores what the clock throws, reporting a NaN duration (regression)', async function () {
			const measurements: decorators.Measurement[] = [];
			let reads = 0;
			const decorate = decorators.measure({
				clock: function (): number {
					reads++;
					if (reads % 2 === 1) throw new Error('clock');
					return 5;
				},
				onMeasure: function (measurement: decorators.Measurement): void {
					measurements.push(measurement);
				}
			});
			const received: number[] = [];
			const sync = decorate(function (n: number): number {
				received.push(n);
				return n * 2;
			}, fakeContext('method', 'sync').context);
			expect(sync(4)).toBe(8);
			expect(received).toEqual([4]);
			const async = decorate(function (): Promise<string> {
				return Promise.resolve('ok');
			}, fakeContext('method', 'async').context);
			await expect(async()).resolves.toBe('ok');
			expect(
				measurements.map(function (measurement) {
					return [measurement.name, measurement.duration, measurement.failed];
				})
			).toEqual([
				['sync', NaN, false],
				['async', NaN, false]
			]);
			// A clock that throws when the call ends: that report is skipped, the result is kept.
			reads = 1;
			expect(sync(1)).toBe(2);
			expect(measurements.length).toBe(2);
		});

		it('logs with console.debug by default, bare or as a factory', function () {
			const debug = jest.spyOn(console, 'debug').mockImplementation(function () {});
			class Parser {
				@decorators.measure
				parse(text: string): unknown {
					return JSON.parse(text);
				}

				@decorators.measure()
				fail(): never {
					throw new Error('x');
				}
			}
			const parser = new Parser();
			expect(parser.parse('[1]')).toEqual([1]);
			expect(debug).toHaveBeenCalledTimes(1);
			expect(debug.mock.calls[0][0]).toMatch(/^parse method took \d+\.\d{3} ms$/);
			expect(function () {
				parser.fail();
			}).toThrow('x');
			expect(debug.mock.calls[1][0]).toMatch(/^fail method failed after \d+\.\d{3} ms$/);
		});

		it('formats the default log from the clock', function () {
			const debug = jest.spyOn(console, 'debug').mockImplementation(function () {});
			const method = decorators.measure({ clock: steppingClock(1.23456) })(noop, fakeContext('method', 'm').context);
			method();
			expect(debug).toHaveBeenCalledWith('m method took 1.235 ms');
		});

		it('uses performance.now, or Date.now where it is missing', function () {
			const onMeasure = jest.fn();
			const now = jest.spyOn(performance, 'now');
			const method = decorators.measure({ onMeasure })(noop, fakeContext('method', 'm').context);
			method();
			expect(now).toHaveBeenCalledTimes(2);
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance') as PropertyDescriptor;
			Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true, writable: true });
			const dateNow = jest.spyOn(Date, 'now');
			try {
				method();
				expect(dateNow).toHaveBeenCalledTimes(2);
			} finally {
				Object.defineProperty(globalThis, 'performance', descriptor);
			}
			expect(onMeasure).toHaveBeenCalledTimes(2);
			expect(onMeasure.mock.calls[1][0].duration).toBeGreaterThanOrEqual(0);
		});

		it('ignores options inherited from a polluted Object.prototype', function () {
			const debug = jest.spyOn(console, 'debug').mockImplementation(function () {});
			const prototype = Object.prototype as Record<string, unknown>;
			prototype.onMeasure = 'polluted';
			prototype.name = 5;
			try {
				const method = decorators.measure({})(noop, fakeContext('method', 'm').context);
				method();
				expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^m method took/));
			} finally {
				delete prototype.onMeasure;
				delete prototype.name;
			}
		});

		it('works on static methods', function () {
			const onMeasure = jest.fn();
			class Tool {
				@decorators.measure({ onMeasure })
				static run(): string {
					return (this as unknown as { name: string }).name;
				}
			}
			expect(Tool.run()).toBe('Tool');
			expect(onMeasure.mock.contexts[0]).toBe(Tool);
		});

		it('validates its options and rejects what is not a method', function () {
			expect(function () {
				decorators.measure(null as never);
			}).toThrow(new TypeError('@measure: `options` must be an object, got null'));
			expect(function () {
				decorators.measure('x' as never);
			}).toThrow(new TypeError('@measure: `options` must be an object, got string'));
			expect(function () {
				decorators.measure({ name: 1 as never });
			}).toThrow(new TypeError('@measure: `options.name` must be a string, got number'));
			expect(function () {
				decorators.measure({ onMeasure: 'log' as never });
			}).toThrow(new TypeError('@measure: `options.onMeasure` must be a function, got string'));
			expect(function () {
				decorators.measure({ clock: 0 as never });
			}).toThrow(new TypeError('@measure: `options.clock` must be a function, got number'));
			expect(function () {
				decorators.measure({}, 'getter', { get: noop } as never);
			}).toThrow(new TypeError('@measure can only decorate methods (getter is not a method)'));
			expect(function () {
				decorators.measure(undefined as never, fakeContext('field', 'x').context);
			}).toThrow(new TypeError('@measure can only decorate methods, not fields'));
			expect(function () {
				decorators.measure({ name: 'custom' })(undefined as never, fakeContext('getter', 'x').context);
			}).toThrow(new TypeError('@measure can only decorate methods, not getters'));
		});
	});
});
