import { setFlagsFromString } from 'node:v8';
import * as vm from 'vm';
import { AssertionError, isArrayOf, isInstanceOf, isMatching, isOptional } from '../guards/index.js';
import { _, active, allPass, anyOf, anyPass, capture, captureAs, cons, match, matcher, matchWith, partialRight, type NonExhaustiveError } from '.';
import * as helpers from '.';

describe('Functions helpers', function () {
	afterEach(function () {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	describe('bind', function () {
		it('should bind a function to a specified this value', function () {
			const testObject = { name: 'John Doe' };

			function fn(this: { name: string }, suffix = ''): string {
				return this.name + suffix;
			}

			const boundFn = helpers.bind(fn, testObject);

			expect(boundFn()).toBe('John Doe');
			expect(boundFn('!')).toBe('John Doe!');
		});

		it('should ignore the call-site this', function () {
			const target = { v: 1 };
			const other = {
				v: 2,
				get: helpers.bind(function (this: { v: number }) {
					return this.v;
				}, target)
			};
			expect(other.get()).toBe(1);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.bind(42 as any, {});
			}).toThrow(new TypeError('bind: `fn` must be a function, got number'));
		});
	});

	describe('partial', function () {
		it('should partially apply arguments to a function', function () {
			function add(a: number, b: number): number {
				return a + b;
			}

			const partiallyAppliedAdd = helpers.partial(add, 1);
			expect(partiallyAppliedAdd(2)).toEqual(3);
		});

		it('should partially apply a function multiple times', function () {
			function add(a: number, b: number, c: number): number {
				return a + b + c;
			}

			const partiallyAppliedAdd1 = helpers.partial(add, 1);
			const partiallyAppliedAdd2 = helpers.partial(partiallyAppliedAdd1, 2);
			expect(partiallyAppliedAdd2(3)).toEqual(6);
		});

		it('should work with no pre-applied arguments and preserve this', function () {
			const obj = {
				base: 10,
				add: helpers.partial(
					function (this: { base: number }, a: number, b: number): number {
						return this.base + a + b;
					} as (a: number, b: number) => number,
					1
				)
			};
			expect(obj.add(2)).toBe(13);
			expect(helpers.partial(Math.max)(1, 3, 2)).toBe(3);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.partial(null as any);
			}).toThrow(new TypeError('partial: `fn` must be a function, got null'));
		});
	});

	describe('curry', function () {
		function add3(a: number, b: number, c: number): number {
			return a + b + c;
		}

		it('should curry a function', function () {
			const curriedFn = helpers.curry(add3);
			expect(curriedFn(1)(2)(3)).toBe(6);
			expect(curriedFn(1, 2)(3)).toBe(6);
			expect(curriedFn(1)(2, 3)).toBe(6);
			expect(curriedFn(1, 2, 3)).toBe(6);
		});

		it('should allow reusing intermediate steps', function () {
			const add1 = helpers.curry(add3)(1);
			expect(add1(2)(3)).toBe(6);
			expect(add1(10, 20)).toBe(31);
		});

		it('should invoke a zero-arity function on the first call', function () {
			const fn = jest.fn(function () {
				return 'done';
			});
			expect(helpers.curry(fn as () => string)()).toBe('done');
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should return the same step when called with no arguments', function () {
			const curried: any = helpers.curry(add3);
			expect(curried()(1)()(2, 3)).toBe(6);
		});

		it('should honour an explicit arity for rest and default parameters', function () {
			function sum(...nums: number[]): number {
				return nums.reduce(function (a, b) {
					return a + b;
				}, 0);
			}

			expect(sum.length).toBe(0);
			expect(helpers.curry<[number, number, number], number>(sum, 3)(1)(2)(3)).toBe(6);

			function withDefault(a: number, b = 5): number {
				return a + b;
			}

			expect(helpers.curry(withDefault)(1)).toBe(6);
			expect(helpers.curry<[number, number], number>(withDefault, 2)(1)(2)).toBe(3);
		});

		it('should forward extra arguments of the final call', function () {
			const fn = jest.fn(function (a: number, b: number) {
				return a + b;
			});
			(helpers.curry(fn) as any)(1)(2, 3);
			expect(fn).toHaveBeenCalledWith(1, 2, 3);
		});

		it('should preserve this of the final call', function () {
			const obj = {
				factor: 3,
				mul: helpers.curry(function (this: { factor: number }, a: number, b: number): number {
					return this.factor * a * b;
				} as (a: number, b: number) => number)
			};
			expect(obj.mul(2, 5)).toBe(30);
		});

		it('should throw a RangeError for invalid arity', function () {
			expect(function () {
				helpers.curry(add3, -1);
			}).toThrow(new RangeError('curry: `arity` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.curry(add3, 1.5);
			}).toThrow(new RangeError('curry: `arity` must be an integer >= 0, got 1.5'));
			expect(function () {
				helpers.curry(add3, NaN);
			}).toThrow(new RangeError('curry: `arity` must be an integer >= 0, got NaN'));
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.curry('nope' as any);
			}).toThrow(new TypeError('curry: `fn` must be a function, got string'));
			// Previously "Cannot read properties of null (reading 'length')": the default arity was read before `fn` was validated.
			expect(function () {
				helpers.curry(null as any);
			}).toThrow(new TypeError('curry: `fn` must be a function, got null'));
			expect(function () {
				helpers.curry(undefined as any);
			}).toThrow(new TypeError('curry: `fn` must be a function, got undefined'));
			expect(function () {
				helpers.curry(add3, null as any);
			}).toThrow(new TypeError('curry: `arity` must be an integer >= 0, got null'));
		});
	});

	describe('compose', function () {
		function add(a: number, b: number): number {
			return a + b;
		}

		function square(x: number): number {
			return x * x;
		}

		function toStr(x: number): string {
			return `#${x}`;
		}

		it('should compose multiple functions into a single function', function () {
			const composedFn = helpers.compose(square, add);
			expect(composedFn(1, 2)).toBe(9);
		});

		it('should apply functions from right to left', function () {
			const fn = helpers.compose(toStr, square, add);
			const result: string = fn(1, 2);
			expect(result).toBe('#9');
		});

		it('should return the identity for zero functions (previously threw a TypeError)', function () {
			expect(helpers.compose()(5)).toBe(5);
			const obj = { a: 1 };
			expect(helpers.compose()(obj)).toBe(obj);
		});

		it('should return an equivalent function for a single function', function () {
			expect(helpers.compose(add)(2, 3)).toBe(5);
		});

		it('should support many functions via the generic overload', function () {
			function inc(x: number): number {
				return x + 1;
			}

			const fns = [inc, inc, inc, inc, inc, inc, inc, inc];
			expect(helpers.compose<number>(...fns)(0)).toBe(8);
			expect(helpers.compose(inc, inc, inc, inc, inc, inc)(0)).toBe(6);
			expect(helpers.compose(inc, inc, inc, inc, inc)(0)).toBe(5);
			expect(helpers.compose(inc, inc, inc, inc)(0)).toBe(4);
		});

		it('should forward this to every function', function () {
			const seen: unknown[] = [];

			function record(this: unknown, x: number): number {
				seen.push(this);
				return x;
			}

			const obj = { run: helpers.compose(record, record) };
			obj.run(1);
			expect(seen).toEqual([obj, obj]);
		});

		it('should throw a TypeError for non-function arguments', function () {
			expect(function () {
				helpers.compose(square, 1 as any);
			}).toThrow(new TypeError('compose: `fns[1]` must be a function, got number'));
		});
	});

	describe('pipe', function () {
		it('rejects a step whose input does not match the previous output, and still accepts spread arrays', function () {
			function length(text: string): number {
				return text.length;
			}
			function increment(n: number): number {
				return n + 1;
			}
			// @ts-expect-error `increment` returns a number, `length` takes a string
			helpers.pipe(increment, length);
			// @ts-expect-error same, right to left
			helpers.compose(length, increment);
			const steps = [increment, increment];
			expect(helpers.pipe(...steps)(0)).toBe(2);
			expect(helpers.compose(...steps)(0)).toBe(2);
			expect(helpers.pipe(increment, increment, increment, increment, increment, increment, increment, increment)(0)).toBe(8);
		});

		function inc(x: number): number {
			return x + 1;
		}

		function double(x: number): number {
			return x * 2;
		}

		it('should apply functions from left to right', function () {
			expect(helpers.pipe(double, inc)(3)).toBe(7);
			expect(helpers.compose(double, inc)(3)).toBe(8);
		});

		it('should support all typed arities', function () {
			expect(helpers.pipe(inc)(0)).toBe(1);
			expect(helpers.pipe(inc, inc, inc)(0)).toBe(3);
			expect(helpers.pipe(inc, inc, inc, inc)(0)).toBe(4);
			expect(helpers.pipe(inc, inc, inc, inc, inc)(0)).toBe(5);
			expect(helpers.pipe(inc, inc, inc, inc, inc, inc)(0)).toBe(6);
			expect(helpers.pipe<number>(inc, inc, inc, inc, inc, inc, inc)(0)).toBe(7);
			expect(helpers.compose(inc, inc, inc)(0)).toBe(3);
		});

		it('should be the identity for zero functions', function () {
			expect(helpers.pipe()('x')).toBe('x');
		});

		it('should pass every argument to the first function', function () {
			expect(
				helpers.pipe(
					function (a: string, b: string) {
						return a + b;
					},
					String.prototype.toUpperCase.call.bind(String.prototype.toUpperCase) as (s: string) => string
				)('a', 'b')
			).toBe('AB');
		});
	});

	describe('memoize', function () {
		it('should ignore options inherited from a polluted Object.prototype', function () {
			const proto = Object.prototype as Record<string, unknown>;
			const shared = new Map<unknown, unknown>();
			proto.resolver = function (): string {
				return 'same key';
			};
			proto.cache = shared;
			try {
				const double = helpers.memoize(function (n: number): number {
					return n * 2;
				});
				// Previously both calls hit the planted resolver's single key, in the planted (shared) cache: 2, 2.
				expect([double(1), double(2)]).toEqual([2, 4]);
				expect(double.cache).not.toBe(shared);
				expect(shared.size).toBe(0);
			} finally {
				delete proto.resolver;
				delete proto.cache;
			}
			// Options inherited from another prototype still count.
			const byParity = helpers.memoize(
				function (n: number): number {
					return n * 2;
				},
				Object.create({
					resolver: function (n: number): number {
						return n % 2;
					}
				}) as helpers.MemoizeOptions<(n: number) => number>
			);
			expect([byParity(1), byParity(3), byParity(2)]).toEqual([2, 2, 4]);
		});

		it('should use the value read with get without asking has (an expiring cache may drop it in between)', function () {
			const store = new Map<unknown, unknown>();
			const forgetfulHas = {
				has: function (): boolean {
					return false;
				},
				get: function (key: unknown): unknown {
					return store.get(key);
				},
				set: function (key: unknown, value: unknown): void {
					store.set(key, value);
				},
				delete: function (key: unknown): boolean {
					return store.delete(key);
				},
				clear: function (): void {
					store.clear();
				}
			};
			const square = jest.fn(function (n: number): number {
				return n * n;
			});
			const memo = helpers.memoize(square, { cache: forgetfulHas });
			expect([memo(3), memo(3)]).toEqual([9, 9]);
			expect(square).toHaveBeenCalledTimes(1);
		});

		it('should expose its cache as an enumerable property and clear() as a hidden one', function () {
			const memo = helpers.memoize(helpers.identity);
			expect(Object.keys(memo)).toEqual(['cache']);
			expect(typeof memo.clear).toBe('function');
		});

		it('should recompute instead of returning undefined when a cache entry expires between lookups', function () {
			// A cache whose entry is still visible to `has` but already gone for `get` (as an expiring cache can be).
			const store = new Map<unknown, unknown>([[2, 4]]);
			const expiringCache = {
				has: function (key: unknown): boolean {
					return store.has(key);
				},
				get: function (key: unknown): unknown {
					store.delete(key);
					return undefined;
				},
				set: function (key: unknown, value: unknown): void {
					store.set(key, value);
				},
				delete: function (key: unknown): boolean {
					return store.delete(key);
				},
				clear: function (): void {
					store.clear();
				}
			};
			const square = jest.fn(function (n: number): number {
				return n * n;
			});
			const memo = helpers.memoize(square, { cache: expiringCache });

			expect(memo(2)).toBe(4);
			expect(square).toHaveBeenCalledTimes(1);
		});

		it('should still serve a cached undefined result', function () {
			const fn = jest.fn(function (): undefined {
				return undefined;
			});
			const memo = helpers.memoize(fn);

			expect(memo()).toBeUndefined();
			expect(memo()).toBeUndefined();
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should memoize a function', function () {
			const fn = jest.fn(function (a: number, b: number): number {
				return a + b;
			});
			const memoizedFn = helpers.memoize(fn);
			expect(memoizedFn(1, 2)).toBe(3);
			expect(memoizedFn(1, 2)).toBe(3);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(memoizedFn(2, 1)).toBe(3);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it.each([0, '', false, null, undefined, NaN])('should cache the falsy result %p (previously recomputed)', function (value) {
			const fn = jest.fn(function () {
				return value;
			});
			const memoized = helpers.memoize(fn as (x: number) => unknown);
			expect(memoized(1)).toBe(value);
			expect(memoized(1)).toBe(value);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should distinguish 1 and "1", undefined and null, and handle NaN', function () {
			const fn = jest.fn(function (x: unknown) {
				return typeof x;
			});
			const memoized = helpers.memoize(fn);
			expect(memoized(1)).toBe('number');
			expect(memoized('1')).toBe('string');
			expect(memoized(undefined)).toBe('undefined');
			expect(memoized(null)).toBe('object');
			expect(memoized(NaN)).toBe('number');
			expect(memoized(NaN)).toBe('number');
			expect(fn).toHaveBeenCalledTimes(5);
			expect(memoized.cache.size).toBe(5);
		});

		it('should not confuse a single "[...]" string argument with an argument list', function () {
			const fn = jest.fn(function (...args: unknown[]) {
				return args.length;
			});
			const memoized = helpers.memoize(fn);
			expect(memoized('a', 'b')).toBe(2);
			expect(memoized('["a","b"]')).toBe(1);
		});

		it('should serialise object arguments structurally', function () {
			const fn = jest.fn(function (o: { a: number }) {
				return o.a;
			});
			const memoized = helpers.memoize(fn);
			expect(memoized({ a: 1 })).toBe(1);
			expect(memoized({ a: 1 })).toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should expose the cache and clear()', function () {
			const fn = jest.fn(function (x: number) {
				return x * 2;
			});
			const memoized = helpers.memoize(fn);
			memoized(2);
			expect(memoized.cache.get(2)).toBe(4);
			memoized.clear();
			expect(memoized.cache.size).toBe(0);
			memoized(2);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should use a custom resolver and cache', function () {
			const cache = new Map<unknown, number>();
			const fn = jest.fn(function (a: number, _b: number) {
				return a;
			});
			const memoized = helpers.memoize(fn, {
				cache,
				resolver: function (a: number) {
					return a;
				}
			});
			expect(memoized(1, 2)).toBe(1);
			expect(memoized(1, 3)).toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(memoized.cache).toBe(cache);
		});

		it('should preserve this', function () {
			const obj = {
				base: 5,
				get: helpers.memoize(function (this: { base: number }, x: number): number {
					return this.base + x;
				})
			};
			expect(obj.get(1)).toBe(6);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.memoize({} as any);
			}).toThrow(new TypeError('memoize: `fn` must be a function, got object'));
			expect(function () {
				helpers.memoize(helpers.identity, { resolver: 1 as any });
			}).toThrow(new TypeError('memoize: `options.resolver` must be a function, got number'));
		});
	});

	describe('memoize key collisions (regressions)', function () {
		it('should not confuse NaN, Infinity, -Infinity and null in multi-argument calls (previously all serialised to null)', function () {
			const fn = jest.fn(function (a: unknown, b: number) {
				return `${String(a)}:${b}`;
			});
			const memoized = helpers.memoize(fn);
			expect([memoized(NaN, 1), memoized(Infinity, 1), memoized(-Infinity, 1), memoized(null, 1)]).toEqual(['NaN:1', 'Infinity:1', '-Infinity:1', 'null:1']);
			expect(fn).toHaveBeenCalledTimes(4);
		});

		it('should not confuse undefined and null arguments in multi-argument calls', function () {
			const fn = jest.fn(function (a: unknown, b: number) {
				return `${String(a)}:${b}`;
			});
			const memoized = helpers.memoize(fn);
			expect(memoized(undefined, 1)).toBe('undefined:1');
			expect(memoized(null, 1)).toBe('null:1');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should not confuse bigints with strings that look like their serialised form', function () {
			const fn = jest.fn(function (a: unknown, b: number) {
				return `${typeof a}:${b}`;
			});
			const memoized = helpers.memoize(fn);
			expect([memoized(1n, 2), memoized('1n', 2), memoized('\\1n', 2), memoized('NaN', 2), memoized(NaN, 2)]).toEqual([
				'bigint:2',
				'string:2',
				'string:2',
				'string:2',
				'number:2'
			]);
			expect(fn).toHaveBeenCalledTimes(5);
		});

		it('should distinguish -0 from 0', function () {
			const inverse = helpers.memoize(function (x: number): number {
				return 1 / x;
			});
			expect(inverse(0)).toBe(Infinity);
			expect(inverse(-0)).toBe(-Infinity);

			const pair = helpers.memoize(function (x: number, y: number): number {
				return 1 / x + y;
			});
			expect(pair(0, 1)).toBe(Infinity);
			expect(pair(-0, 1)).toBe(-Infinity);
		});
	});

	describe('defaultMemoizeKey', function () {
		it('should use a single primitive as is', function () {
			const sym = Symbol('s');
			expect(helpers.defaultMemoizeKey(1)).toBe(1);
			expect(helpers.defaultMemoizeKey('a')).toBe('a');
			expect(helpers.defaultMemoizeKey(sym)).toBe(sym);
			expect(helpers.defaultMemoizeKey(undefined)).toBeUndefined();
			expect(helpers.defaultMemoizeKey(null)).toBeNull();
			expect(helpers.defaultMemoizeKey(10n)).toBe(10n);
		});

		it('should serialise everything else', function () {
			expect(helpers.defaultMemoizeKey()).toBe('[]');
			expect(helpers.defaultMemoizeKey('a', 2)).toBe('["a",2]');
			expect(helpers.defaultMemoizeKey({ a: 1 })).toBe('[{"a":1}]');
			expect(helpers.defaultMemoizeKey('[x')).toBe('["[x"]');
			expect(helpers.defaultMemoizeKey(1n, 2)).toBe('["1n",2]');
			// A lone function is its own key (identity), like a lone class instance.
			expect(helpers.defaultMemoizeKey(helpers.noop)).toBe(helpers.noop);
			// Only whole strings shaped like a marker are escaped.
			expect(helpers.defaultMemoizeKey('aNaN', 'NaNa', '1n2', 1)).toBe('["aNaN","NaNa","1n2",1]');
			// `undefined` gets a marker at every level, so `{ b: undefined }` differs from `{}`.
			expect(helpers.defaultMemoizeKey(undefined, { a: 1, b: undefined })).toBe('["undefined",{"a":1,"b":"undefined"}]');
		});

		it('should throw a TypeError on circular structures', function () {
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			expect(function () {
				helpers.defaultMemoizeKey(circular);
			}).toThrow(TypeError);
		});
	});

	describe('throttle', function () {
		it('should throttle a function', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const throttledFn = helpers.throttle(fn, 1000);

			throttledFn();
			throttledFn();
			throttledFn();

			expect(fn).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(1000);

			throttledFn();
			throttledFn();

			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should work when the clock reads 0 (previously every call went through)', function () {
			jest.useFakeTimers({ now: 0 });

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100);
			throttled();
			throttled();
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should return the latest result and preserve this', function () {
			jest.useFakeTimers();

			const obj = {
				n: 0,
				tick: helpers.throttle(function (this: { n: number }, by: number): number {
					this.n += by;
					return this.n;
				}, 50)
			};
			expect(obj.tick(2)).toBe(2);
			expect(obj.tick(5)).toBe(2);
			expect(obj.n).toBe(2);
		});

		it('should invoke on the trailing edge with the latest args', function () {
			jest.useFakeTimers();

			const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { trailing: true });

			throttled(1);
			jest.advanceTimersByTime(30);
			throttled(2);
			throttled(3);
			expect(fn.mock.calls).toEqual([[1]]);

			jest.advanceTimersByTime(69);
			expect(fn.mock.calls).toEqual([[1]]);
			jest.advanceTimersByTime(1);
			expect(fn.mock.calls).toEqual([[1], [3]]);
			// One timer for the whole window: no early wake-ups.
			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

			// A new window started with the trailing call.
			throttled(4);
			expect(fn).toHaveBeenCalledTimes(2);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1], [3], [4]]);

			jest.advanceTimersByTime(500);
			throttled(5);
			expect(fn.mock.calls).toEqual([[1], [3], [4], [5]]);
		});

		it('should support trailing-only mode', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { leading: false, trailing: true });
			const ctx = { throttled };

			ctx.throttled(1);
			ctx.throttled(2);
			expect(fn).not.toHaveBeenCalled();

			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[2]]);
			expect(fn.mock.contexts[0]).toBe(ctx);
		});

		it('should drop a late pending call when a new window starts', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { trailing: true });
			throttled(1);
			throttled(2);
			// Simulate a delayed timer: move the clock without running timers.
			jest.setSystemTime(Date.now() + 150);
			throttled(3);
			expect(fn.mock.calls).toEqual([[1], [3]]);
			jest.runAllTimers();
			expect(fn.mock.calls).toEqual([[1], [3]]);
		});

		it('should keep invoking once per window without a leading edge while the timer cannot fire (previously never invoked)', function () {
			jest.useFakeTimers({ now: 0 });

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { leading: false, trailing: true });
			const ctx = { throttled };
			// A synchronous loop: the clock moves, the timers never get a chance to run.
			for (let now = 0; now < 500; now += 10) {
				jest.setSystemTime(now);
				ctx.throttled(now);
			}
			// Each window's latest call, performed by the first call after the window.
			expect(fn.mock.calls).toEqual([[90], [190], [290], [390]]);
			expect(fn.mock.contexts[0]).toBe(ctx);
			// The last window's call is still due, once the timers run.
			jest.runAllTimers();
			expect(fn.mock.calls).toEqual([[90], [190], [290], [390], [490]]);
		});

		it('should let a call made by the overdue invocation supersede the call that performed it', function () {
			jest.useFakeTimers({ now: 0 });

			const calls: number[] = [];
			const throttled = helpers.throttle(
				function (n: number): number {
					calls.push(n);
					if (n === 1) throttled(3);
					return n * 10;
				},
				100,
				{ leading: false, trailing: true }
			);
			throttled(1);
			jest.setSystemTime(150);
			// Performs the overdue call (1), whose own call (3) is newer than this one.
			expect(throttled(2)).toBe(10);
			expect(calls).toEqual([1]);
			jest.advanceTimersByTime(100);
			expect(calls).toEqual([1, 3]);
			jest.runAllTimers();
			expect(calls).toEqual([1, 3]);
		});

		it('should ignore options inherited from a polluted Object.prototype', function () {
			jest.useFakeTimers();

			const proto = Object.prototype as Record<string, unknown>;
			proto.leading = false;
			proto.trailing = true;
			try {
				const fn = jest.fn();
				const throttled = helpers.throttle(fn, 100);
				throttled(1);
				throttled(2);
				jest.advanceTimersByTime(100);
				// The defaults: leading edge only.
				expect(fn.mock.calls).toEqual([[1]]);
				expect(function () {
					helpers.throttle(helpers.noop, 100, { leading: false });
				}).toThrow(new RangeError('throttle: at least one of `leading` or `trailing` must be true'));
			} finally {
				delete proto.leading;
				delete proto.trailing;
			}
			// Options inherited from another prototype still count.
			const fn = jest.fn();
			const inherited = helpers.throttle(fn, 100, Object.create({ leading: false, trailing: true }) as helpers.ThrottleOptions);
			inherited(3);
			expect(fn).not.toHaveBeenCalled();
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[3]]);
		});

		it('should cancel pending calls and reset the window', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { trailing: true });
			throttled(1);
			throttled(2);
			throttled.cancel();
			jest.advanceTimersByTime(200);
			expect(fn.mock.calls).toEqual([[1]]);

			throttled(3);
			throttled.cancel();
			throttled(4);
			expect(fn.mock.calls).toEqual([[1], [3], [4]]);
			throttled.cancel();
		});

		it('should not fire the trailing call early for waits longer than 2^31 - 1 ms (previously fired after ~1 ms)', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const wait = 2 ** 31 + 1000;
			const throttled = helpers.throttle(fn, wait, { trailing: true });
			throttled(1);
			throttled(2);
			jest.advanceTimersByTime(10);
			expect(fn.mock.calls).toEqual([[1]]);
			jest.advanceTimersByTime(2 ** 31 - 1);
			expect(fn.mock.calls).toEqual([[1]]);
			// The window ends exactly `wait` ms after the first call.
			jest.advanceTimersByTime(wait - 10 - (2 ** 31 - 1) - 1);
			expect(fn.mock.calls).toEqual([[1]]);
			jest.advanceTimersByTime(1);
			expect(fn.mock.calls).toEqual([[1], [2]]);
		});

		it('should perform an overdue trailing call when the clock went backwards', function () {
			jest.useFakeTimers({ now: 10_000 });

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100, { trailing: true });
			throttled(1);
			throttled(2);
			jest.setSystemTime(0);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1], [2]]);
		});

		it('should start a new window when a call comes before the window start (clock went backwards)', function () {
			jest.useFakeTimers({ now: 10_000 });

			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 100);
			throttled(1);
			jest.setSystemTime(5_000);
			throttled(2);
			expect(fn.mock.calls).toEqual([[1], [2]]);
		});

		it('should always invoke with a zero wait', function () {
			const fn = jest.fn();
			const throttled = helpers.throttle(fn, 0);
			throttled();
			throttled();
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.throttle(helpers.noop, -1);
			}).toThrow(new RangeError('throttle: `wait` must be a finite number >= 0, got -1'));
			expect(function () {
				helpers.throttle(helpers.noop, NaN);
			}).toThrow(new RangeError('throttle: `wait` must be a finite number >= 0, got NaN'));
			expect(function () {
				helpers.throttle(helpers.noop, Infinity);
			}).toThrow(new RangeError('throttle: `wait` must be a finite number >= 0, got Infinity'));
			expect(function () {
				helpers.throttle(helpers.noop, 10, { leading: false });
			}).toThrow(new RangeError('throttle: at least one of `leading` or `trailing` must be true'));
			expect(function () {
				helpers.throttle(undefined as any, 10);
			}).toThrow(new TypeError('throttle: `fn` must be a function, got undefined'));
		});
	});

	describe('debounce', function () {
		it('should debounce a function', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debouncedFn = helpers.debounce(fn, 1000);

			debouncedFn();
			debouncedFn();
			debouncedFn();

			expect(fn).toHaveBeenCalledTimes(0);

			jest.advanceTimersByTime(900);
			expect(fn).toHaveBeenCalledTimes(0);

			jest.advanceTimersByTime(200);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should call the latest invocation of the debounced function', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debouncedFn = helpers.debounce(fn, 1000);

			debouncedFn(1);
			debouncedFn(2);
			debouncedFn(3);

			jest.advanceTimersByTime(1000);
			expect(fn).toHaveBeenCalledWith(3);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should restart the quiet period on every call', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100);
			debounced(1);
			jest.advanceTimersByTime(60);
			debounced(2);
			jest.advanceTimersByTime(60);
			expect(fn).not.toHaveBeenCalled();
			jest.advanceTimersByTime(40);
			expect(fn.mock.calls).toEqual([[2]]);
		});

		it('should preserve this of the latest call', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 10);
			const a = { debounced };
			const b = { debounced };
			a.debounced();
			b.debounced();
			jest.advanceTimersByTime(10);
			expect(fn.mock.contexts).toEqual([b]);
		});

		it('should support leading invocation', function () {
			jest.useFakeTimers();

			const fn = jest.fn(function (x: number) {
				return x * 10;
			});
			const debounced = helpers.debounce(fn, 100, { leading: true });
			expect(debounced(1)).toBe(10);
			expect(debounced(2)).toBe(10);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1], [2]]);

			jest.advanceTimersByTime(100);
			expect(debounced(3)).toBe(30);
		});

		it('should not invoke on the trailing edge after a single leading call', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { leading: true });
			debounced(1);
			expect(debounced.pending()).toBe(false);
			jest.advanceTimersByTime(200);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should support leading-only mode', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { leading: true, trailing: false });
			debounced(1);
			debounced(2);
			expect(debounced.pending()).toBe(false);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1]]);
		});

		it('should count maxWait from a flush', function () {
			jest.useFakeTimers({ now: 1000 });

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 250 });

			debounced('a');
			jest.advanceTimersByTime(1);
			debounced.flush();
			expect(fn.mock.calls).toEqual([['a']]);

			// The burst goes on (calls every 20 ms from 1099): the flush at 1001 started the maxWait period, which ends at 1251.
			jest.advanceTimersByTime(98);
			for (let t = 1099; t < 1400; t += 20) {
				debounced(t);
				jest.advanceTimersByTime(20);
			}

			expect(fn.mock.calls.slice(0, 2)).toEqual([['a'], [1239]]);
		});

		it('should honour maxWait during continuous calls', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 250 });

			for (let t = 0; t < 600; t += 50) {
				debounced(t);
				jest.advanceTimersByTime(50);
			}

			expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls[fn.mock.calls.length - 1]).toEqual([550]);
		});

		it('should invoke at maxWait when calls keep coming exactly at that boundary', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 100 });
			debounced(1);
			jest.advanceTimersByTime(99);
			debounced(2);
			jest.setSystemTime(Date.now() + 1);
			debounced(3);
			expect(fn.mock.calls).toEqual([[3]]);
		});

		it('should clamp maxWait to at least wait', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 10 });
			debounced(1);
			jest.advanceTimersByTime(50);
			expect(fn).not.toHaveBeenCalled();
			jest.advanceTimersByTime(50);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should cancel a pending call', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100);
			debounced();
			expect(debounced.pending()).toBe(true);
			debounced.cancel();
			expect(debounced.pending()).toBe(false);
			jest.advanceTimersByTime(200);
			expect(fn).not.toHaveBeenCalled();
			debounced.cancel();
		});

		it('should flush a pending call immediately and return its result', function () {
			jest.useFakeTimers();

			const fn = jest.fn(function (x: number) {
				return x + 1;
			});
			const debounced = helpers.debounce(fn, 100);
			expect(debounced.flush()).toBeUndefined();
			debounced(1);
			expect(debounced.flush()).toBe(2);
			expect(debounced.pending()).toBe(false);
			expect(debounced.flush()).toBe(2);
			jest.advanceTimersByTime(200);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should not invoke on flush when only the leading call happened', function () {
			jest.useFakeTimers();

			const fn = jest.fn(function () {
				return 'r';
			});
			const debounced = helpers.debounce(fn, 100, { leading: true });
			debounced();
			expect(debounced.flush()).toBe('r');
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should treat a clock going backwards as a new burst', function () {
			jest.useFakeTimers({ now: 1000 });

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { leading: true });
			debounced(1);
			jest.setSystemTime(500);
			debounced(2);
			expect(fn.mock.calls).toEqual([[1]]);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1], [2]]);
		});

		it('should not busy-poll for waits longer than 2^31 - 1 ms (previously re-armed a 1 ms timer over and over)', function () {
			jest.useFakeTimers();

			const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
			const fn = jest.fn();
			const wait = 2 ** 31 + 1000;
			const debounced = helpers.debounce(fn, wait);
			debounced(1);
			jest.advanceTimersByTime(10);
			expect(fn).not.toHaveBeenCalled();
			expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(2 ** 31 - 1);
			expect(fn).not.toHaveBeenCalled();
			jest.advanceTimersByTime(wait);
			expect(fn.mock.calls).toEqual([[1]]);
		});

		it('should re-arm for the remaining quiet period when called again before the timer fires', function () {
			jest.useFakeTimers();

			const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100);
			debounced(1);
			jest.advanceTimersByTime(50);
			debounced(2);
			jest.advanceTimersByTime(99);
			expect(fn).not.toHaveBeenCalled();
			expect(jest.getTimerCount()).toBe(1);
			jest.advanceTimersByTime(1);
			expect(fn.mock.calls).toEqual([[2]]);
			expect(jest.getTimerCount()).toBe(0);
			// The initial timer and a single re-arm for the remaining 50 ms (no busy polling).
			expect(
				setTimeoutSpy.mock.calls.map(function (call) {
					return call[1];
				})
			).toEqual([100, 50]);
		});

		it('should invoke exactly maxWait ms after the first call of a continuous burst', function () {
			jest.useFakeTimers();

			const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 150 });
			debounced(1);
			jest.advanceTimersByTime(90);
			debounced(2);
			jest.advanceTimersByTime(59);
			expect(fn).not.toHaveBeenCalled();
			jest.advanceTimersByTime(1);
			expect(fn.mock.calls).toEqual([[2]]);
			// Re-armed once, for the 50 ms left before maxWait.
			expect(
				setTimeoutSpy.mock.calls.map(function (call) {
					return call[1];
				})
			).toEqual([100, 50]);
		});

		it('should not let calls made within the same millisecond trigger maxWait', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 100 });
			debounced(1);
			debounced(2);
			debounced(3);
			expect(fn).not.toHaveBeenCalled();
			expect(jest.getTimerCount()).toBe(1);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[3]]);
		});

		it('should restart (not duplicate) its timer when a call is forced by maxWait', function () {
			jest.useFakeTimers({ now: 0 });

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 150 });
			debounced(1);
			// The clock moves on without the timer firing (e.g. a busy event loop): the next call is overdue.
			jest.setSystemTime(150);
			debounced(2);
			expect(fn.mock.calls).toEqual([[2]]);
			expect(jest.getTimerCount()).toBe(1);
			debounced.cancel();
			expect(jest.getTimerCount()).toBe(0);
			jest.advanceTimersByTime(1000);
			expect(fn.mock.calls).toEqual([[2]]);
		});

		it('should not postpone the trailing call when the clock went backwards', function () {
			jest.useFakeTimers({ now: 10_000 });

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100);
			debounced(1);
			jest.setSystemTime(0);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[1]]);
		});

		it('should clear its timer on flush', function () {
			jest.useFakeTimers();

			const fn = jest.fn(function (n: number) {
				return n * 2;
			});
			const debounced = helpers.debounce(fn, 100);
			expect(debounced.flush()).toBeUndefined();
			debounced(1);
			expect(debounced.flush()).toBe(2);
			expect(jest.getTimerCount()).toBe(0);
			expect(debounced.flush()).toBe(2);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should honour a maxWait longer than 2^31 - 1 ms', function () {
			jest.useFakeTimers();

			const fn = jest.fn();
			const debounced = helpers.debounce(fn, 100, { maxWait: 2 ** 32 });
			debounced(1);
			jest.advanceTimersByTime(50);
			debounced(2);
			jest.advanceTimersByTime(100);
			expect(fn.mock.calls).toEqual([[2]]);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.debounce(helpers.noop, -5);
			}).toThrow(new RangeError('debounce: `wait` must be a finite number >= 0, got -5'));
			expect(function () {
				helpers.debounce(helpers.noop, 5, { maxWait: NaN });
			}).toThrow(new RangeError('debounce: `maxWait` must be a finite number >= 0, got NaN'));
			expect(function () {
				helpers.debounce(helpers.noop, 5, { trailing: false });
			}).toThrow(new RangeError('debounce: at least one of `leading` or `trailing` must be true'));
			expect(function () {
				helpers.debounce('x' as any, 5);
			}).toThrow(new TypeError('debounce: `fn` must be a function, got string'));
		});

		it('should ignore options inherited from a polluted Object.prototype', function () {
			jest.useFakeTimers();

			const proto = Object.prototype as Record<string, unknown>;
			proto.leading = true;
			proto.trailing = false;
			proto.maxWait = 150;
			try {
				const fn = jest.fn();
				const debounced = helpers.debounce(fn, 100);
				debounced(1);
				expect(fn).not.toHaveBeenCalled();
				// No maxWait: a continuous burst only invokes once it ends, on the trailing edge.
				for (let i = 0; i < 10; i++) {
					jest.advanceTimersByTime(50);
					debounced(i + 2);
				}
				expect(fn).not.toHaveBeenCalled();
				expect(debounced.pending()).toBe(true);
				jest.advanceTimersByTime(100);
				expect(fn.mock.calls).toEqual([[11]]);
			} finally {
				delete proto.leading;
				delete proto.trailing;
				delete proto.maxWait;
			}
			// Options inherited from another prototype still count.
			const fn = jest.fn();
			const inherited = helpers.debounce(fn, 100, Object.create({ leading: true }) as helpers.DebounceOptions);
			inherited(12);
			expect(fn.mock.calls).toEqual([[12]]);
			inherited.cancel();
		});
	});

	describe('once', function () {
		it('should invoke the function only once and cache the result', function () {
			const fn = jest.fn(function (x: number) {
				return x * 2;
			});
			const onced = helpers.once(fn);
			expect(onced(2)).toBe(4);
			expect(onced(5)).toBe(4);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should preserve this', function () {
			const obj = {
				v: 7,
				get: helpers.once(function (this: { v: number }) {
					return this.v;
				})
			};
			expect(obj.get()).toBe(7);
		});

		it('should not invoke fn again on a re-entrant call (previously invoked it twice)', function () {
			const inner: unknown[] = [];
			const fn = jest.fn(function (): number {
				inner.push(onced());
				return 1;
			});
			const onced = helpers.once(fn);
			expect(onced()).toBe(1);
			expect(onced()).toBe(1);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(inner).toEqual([undefined]);
		});

		it('should rethrow the first error on later calls', function () {
			const error = new Error('boom');
			const fn = jest.fn(function () {
				throw error;
			});
			const onced = helpers.once(fn);
			expect(onced).toThrow(error);
			expect(onced).toThrow(error);
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.once(1 as any);
			}).toThrow(new TypeError('once: `fn` must be a function, got number'));
		});

		it('should release fn once it has been called (previously kept alive with the wrapper)', async function () {
			const refs: Array<WeakRef<object>> = [];
			const wrappers = (function () {
				const kept = { id: 1 };
				const failing = { id: 2 };
				refs.push(new WeakRef(kept), new WeakRef(failing));
				const succeeded = helpers.once(function (): number {
					return kept.id;
				});
				const failed = helpers.once(function (): never {
					throw new Error(String(failing.id));
				});
				succeeded();
				expect(failed).toThrow('2');
				return [succeeded, failed];
			})();
			await collectGarbage();
			expect(
				refs.map(function (ref) {
					return ref.deref();
				})
			).toEqual([undefined, undefined]);
			expect(wrappers[0]()).toBe(1);
			expect(wrappers[1]).toThrow('2');
		});
	});

	describe('before', function () {
		it('should invoke the function while called fewer than n times', function () {
			const fn = jest.fn(function (x: number) {
				return x * 2;
			});
			const limited = helpers.before(3, fn);
			expect([limited(1), limited(2), limited(3), limited(4)]).toEqual([2, 4, 4, 4]);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should never invoke for n <= 1', function () {
			const fn = jest.fn();
			helpers.before(0, fn)();
			helpers.before(1, fn)();
			expect(fn).not.toHaveBeenCalled();
		});

		it('should release fn after its last invocation (previously kept alive with the wrapper)', async function () {
			const refs: Array<WeakRef<{ id: number }>> = [];
			/**
			 * Restricts a function reading a new object (in a scope of its own: closures of one scope share what they hold).
			 * @param {number} id - The object's id
			 * @param {number} n - The `before` count
			 * @returns {(by: number) => number | undefined} The restricted function
			 */
			function limit(id: number, n: number): (by: number) => number | undefined {
				const value = { id };
				refs.push(new WeakRef(value));
				return helpers.before(n, function (by: number): number {
					return value.id + by;
				});
			}
			const exhausted = limit(1, 3);
			const never = limit(2, 1);
			const pending = limit(3, 3);
			expect([exhausted(1), exhausted(2), exhausted(3), never(0), pending(0)]).toEqual([2, 3, 3, undefined, 3]);
			await collectGarbage();
			expect(
				refs.map(function (ref) {
					return ref.deref()?.id;
				})
			).toEqual([undefined, undefined, 3]);
			expect([exhausted(4), never(0), pending(1)]).toEqual([3, undefined, 4]);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.before(-1, helpers.noop);
			}).toThrow(new RangeError('before: `n` must be an integer >= 0, got -1'));
			expect(function () {
				helpers.before(1, null as any);
			}).toThrow(new TypeError('before: `fn` must be a function, got null'));
		});
	});

	describe('after', function () {
		it('should invoke the function from the n-th call on', function () {
			const fn = jest.fn(function () {
				return 'ok';
			});
			const done = helpers.after(2, fn);
			expect(done()).toBeUndefined();
			expect(done()).toBe('ok');
			expect(done()).toBe('ok');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should invoke immediately for n = 0 and preserve this', function () {
			const obj = {
				v: 1,
				f: helpers.after(0, function (this: { v: number }) {
					return this.v;
				})
			};
			expect(obj.f()).toBe(1);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.after(1.5, helpers.noop);
			}).toThrow(new RangeError('after: `n` must be an integer >= 0, got 1.5'));
			expect(function () {
				helpers.after(1, {} as any);
			}).toThrow(new TypeError('after: `fn` must be a function, got object'));
		});
	});

	describe('negate', function () {
		it('should negate a predicate', function () {
			const isOdd = helpers.negate(function (n: number) {
				return n % 2 === 0;
			});
			expect([1, 2, 3, 4].filter(isOdd)).toEqual([1, 3]);
		});

		it('should coerce truthy/falsy results to booleans and preserve this', function () {
			const obj = {
				items: ['a'],
				isMissing: helpers.negate(function (this: { items: string[] }, x: string) {
					return this.items.indexOf(x) + 1;
				})
			};
			expect(obj.isMissing('a')).toBe(false);
			expect(obj.isMissing('b')).toBe(true);
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.negate(true as any);
			}).toThrow(new TypeError('negate: `predicate` must be a function, got boolean'));
		});
	});

	describe('identity', function () {
		it('should return its argument', function () {
			const obj = {};
			expect(helpers.identity(obj)).toBe(obj);
			expect(helpers.identity(NaN)).toBeNaN();
			expect([1, 0, 2, '', 3].filter(helpers.identity)).toEqual([1, 2, 3]);
		});
	});

	describe('noop', function () {
		it('should return undefined', function () {
			expect(helpers.noop()).toBeUndefined();
			expect(helpers.noop(1, 2, 3)).toBeUndefined();
		});
	});
});

describe('Functions helpers (round 2)', function () {
	describe('defaultMemoizeKey markers', function () {
		it('should serialise non-JSON values with distinct markers and escape look-alike strings', function () {
			expect(helpers.defaultMemoizeKey(NaN, Infinity, -Infinity, -0, undefined)).toBe('["NaN","Infinity","-Infinity","-0","undefined"]');
			expect(helpers.defaultMemoizeKey('NaN', 'Infinity', '-0', 'undefined', '12n', '\\12n')).toBe(
				'["\\\\NaN","\\\\Infinity","\\\\-0","\\\\undefined","\\\\12n","\\\\\\\\12n"]'
			);
			expect(helpers.defaultMemoizeKey(-0)).toBe('["-0"]');
			expect(helpers.defaultMemoizeKey(0)).toBe(0);
			expect(helpers.defaultMemoizeKey('plain', 1.5)).toBe('["plain",1.5]');
		});

		it('should mark nested undefined values too (holes count as undefined)', function () {
			expect(helpers.defaultMemoizeKey({ a: undefined, b: 1 }, [undefined])).toBe('[{"a":"undefined","b":1},["undefined"]]');
			// eslint-disable-next-line no-sparse-arrays -- a hole on purpose
			expect(helpers.defaultMemoizeKey([1, , 2])).toBe('[[1,"undefined",2]]');
			expect(helpers.defaultMemoizeKey({ a: -0, b: NaN })).toBe('[{"a":"-0","b":"NaN"}]');
		});
	});

	describe('attempt', function () {
		it('should return [undefined, result] on success', function () {
			expect(helpers.attempt(JSON.parse, '{"a":1}')).toEqual([undefined, { a: 1 }]);
			expect(
				helpers.attempt(
					function (a: number, b: number) {
						return a + b;
					},
					1,
					2
				)
			).toEqual([undefined, 3]);
		});

		it('should return [error, undefined] when fn throws, including non-Error values', function () {
			const [error, result] = helpers.attempt(JSON.parse, '{');
			expect(error).toBeInstanceOf(SyntaxError);
			expect(result).toBeUndefined();
			expect(
				helpers.attempt(function () {
					throw 'plain';
				})
			).toEqual(['plain', undefined]);
		});

		it('should return a TypeError instead of throwing for non-functions', function () {
			const [error] = helpers.attempt(42 as any);
			expect(error).toEqual(new TypeError('attempt: `fn` must be a function, got number'));
		});

		it('should return promises as plain success values', function () {
			const promise = Promise.resolve(1);
			expect(
				helpers.attempt(function () {
					return promise;
				})
			).toEqual([undefined, promise]);
		});
	});

	describe('times', function () {
		it('should call fn with each index and collect the results', function () {
			expect(
				helpers.times(4, function (i) {
					return i * i;
				})
			).toEqual([0, 1, 4, 9]);
			expect(helpers.times(0, helpers.identity)).toEqual([]);
		});

		it.each([-1, 1.5, NaN, Infinity, 2 ** 32])('should throw a RangeError for n = %p', function (n) {
			expect(function () {
				helpers.times(n, helpers.identity);
			}).toThrow(new RangeError(`times: \`n\` must be an integer between 0 and 4294967295, got ${n}`));
		});

		it('should throw a TypeError for non-functions', function () {
			expect(function () {
				helpers.times(1, 'x' as any);
			}).toThrow(new TypeError('times: `fn` must be a function, got string'));
		});

		it('should accept the largest array length, 2^32 - 1', function () {
			expect(function () {
				helpers.times(2 ** 32 - 1, function (): never {
					throw new Error('called');
				});
			}).toThrow('called');
		});
	});

	describe('flip', function () {
		it('should reverse the arguments', function () {
			function divide(a: number, b: number): number {
				return a / b;
			}

			expect(helpers.flip(divide)(2, 10)).toBe(5);
			const join = helpers.flip(function (...parts: string[]) {
				return parts.join('');
			});
			expect(join('a', 'b', 'c')).toBe('cba');
			expect(join()).toBe('');
		});

		it('should preserve this and validate fn', function () {
			const obj = {
				prefix: '>',
				show: helpers.flip(function (this: { prefix: string }, a: string, b: string) {
					return this.prefix + a + b;
				})
			};
			expect(obj.show('1', '2')).toBe('>21');
			expect(function () {
				helpers.flip(null as any);
			}).toThrow(new TypeError('flip: `fn` must be a function, got null'));
		});
	});

	describe('unary', function () {
		it('should forward only the first argument', function () {
			expect(['1', '2', '3'].map(helpers.unary(parseInt))).toEqual([1, 2, 3]);
			const spy = jest.fn();
			(helpers.unary(spy) as any)(1, 2, 3);
			expect(spy).toHaveBeenCalledWith(1);
		});

		it('should preserve this and validate fn', function () {
			const obj = {
				n: 2,
				mul: helpers.unary(function (this: { n: number }, x: number) {
					return this.n * x;
				})
			};
			expect(obj.mul(4)).toBe(8);
			expect(function () {
				helpers.unary({} as any);
			}).toThrow(new TypeError('unary: `fn` must be a function, got object'));
		});
	});

	describe('constant', function () {
		it('should always return the same value, ignoring arguments', function () {
			const obj = {};
			const always = helpers.constant(obj);
			expect(always()).toBe(obj);
			expect(always(1, 2)).toBe(obj);
			expect([1, 2].map(helpers.constant(0))).toEqual([0, 0]);
		});
	});

	describe('shallowEqualArgs', function () {
		it('should compare element-wise with SameValueZero', function () {
			const o = {};
			expect(helpers.shallowEqualArgs([1, NaN, o], [1, NaN, o])).toBe(true);
			expect(helpers.shallowEqualArgs([0], [-0])).toBe(true);
			expect(helpers.shallowEqualArgs([{}], [{}])).toBe(false);
			expect(helpers.shallowEqualArgs([1], [1, 2])).toBe(false);
			expect(helpers.shallowEqualArgs([], [])).toBe(true);
		});
	});

	describe('memoizeLast', function () {
		it('should cache only the latest call', function () {
			const fn = jest.fn(function (a: number, b: number) {
				return a * b;
			});
			const area = helpers.memoizeLast(fn);
			expect(area(2, 3)).toBe(6);
			expect(area(2, 3)).toBe(6);
			expect(fn).toHaveBeenCalledTimes(1);
			expect(area(3, 3)).toBe(9);
			expect(area(2, 3)).toBe(6);
			expect(fn).toHaveBeenCalledTimes(3);
		});

		it('should treat NaN as equal, objects by identity and different lengths as different', function () {
			const fn = jest.fn(function (...args: unknown[]) {
				return args.length;
			});
			const memoized = helpers.memoizeLast(fn);
			const o = {};
			memoized(NaN, o);
			memoized(NaN, o);
			expect(fn).toHaveBeenCalledTimes(1);
			memoized(NaN, {});
			expect(fn).toHaveBeenCalledTimes(2);
			memoized(NaN);
			expect(fn).toHaveBeenCalledTimes(3);
		});

		it('should recompute when this changes', function () {
			const fn = jest.fn(function (this: { v: number }) {
				return this.v;
			});
			const get = helpers.memoizeLast(fn);
			const a = { v: 1, get };
			const b = { v: 2, get };
			expect([a.get(), a.get(), b.get(), a.get()]).toEqual([1, 1, 2, 1]);
			expect(fn).toHaveBeenCalledTimes(3);
		});

		it('should use a custom isEqual', function () {
			const fn = jest.fn(function (o: { id: number; label: string }) {
				return o.label;
			});
			const memoized = helpers.memoizeLast(fn, function (next, previous) {
				return next[0].id === previous[0].id;
			});
			expect(memoized({ id: 1, label: 'a' })).toBe('a');
			expect(memoized({ id: 1, label: 'b' })).toBe('a');
			expect(memoized({ id: 2, label: 'c' })).toBe('c');
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should not cache throws and keep the previous entry', function () {
			const fn = jest.fn(function (x: number) {
				if (x < 0) throw new RangeError('negative');
				return x * 2;
			});
			const memoized = helpers.memoizeLast(fn);
			expect(memoized(1)).toBe(2);
			expect(function () {
				memoized(-1);
			}).toThrow(RangeError);
			expect(memoized(1)).toBe(2);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should forget the cache on clear()', function () {
			const fn = jest.fn(helpers.identity);
			const memoized = helpers.memoizeLast(fn);
			memoized(1);
			memoized.clear();
			memoized(1);
			expect(fn).toHaveBeenCalledTimes(2);
		});

		it('should validate its arguments', function () {
			expect(function () {
				helpers.memoizeLast(1 as any);
			}).toThrow(new TypeError('memoizeLast: `fn` must be a function, got number'));
			expect(function () {
				helpers.memoizeLast(helpers.identity, 'x' as any);
			}).toThrow(new TypeError('memoizeLast: `isEqual` must be a function, got string'));
		});
	});

	describe('argument validation', function () {
		it('names the offending parameter in TypeErrors', function () {
			expect(function () {
				helpers.pipe(helpers.identity, 1 as any);
			}).toThrow(new TypeError('pipe: `fns[1]` must be a function, got number'));
			expect(function () {
				helpers.compose(null as any, helpers.identity);
			}).toThrow(new TypeError('compose: `fns[0]` must be a function, got null'));
			expect(function () {
				helpers.memoize(helpers.identity, { resolver: 'x' as any });
			}).toThrow(new TypeError('memoize: `options.resolver` must be a function, got string'));
		});

		it('throws a TypeError for non-number counts and waits, and a RangeError for invalid numbers', function () {
			expect(function () {
				helpers.debounce(helpers.noop, '5' as any);
			}).toThrow(new TypeError('debounce: `wait` must be a finite number >= 0, got string'));
			expect(function () {
				helpers.before('2' as any, helpers.noop);
			}).toThrow(new TypeError('before: `n` must be an integer >= 0, got string'));
			expect(function () {
				helpers.times(2 ** 32, helpers.identity);
			}).toThrow(new RangeError('times: `n` must be an integer between 0 and 4294967295, got 4294967296'));
		});
	});
});

describe('Functions helpers (round 8 fast paths)', function () {
	function collect(this: unknown, ...args: unknown[]): [unknown, unknown[], number] {
		return [this, args, arguments.length];
	}

	it('partial forwards `this` and exactly the combined arguments, whatever their number', function () {
		const self = { id: 1 };
		for (let pre = 0; pre <= 3; pre++) {
			for (let rest = 0; rest <= 3; rest++) {
				const preArgs = Array.from({ length: pre }, function (_unused, i) {
					return `p${i}`;
				});
				const restArgs = Array.from({ length: rest }, function (_unused, i) {
					return `r${i}`;
				});
				const applied = helpers.partial(collect as (...args: unknown[]) => [unknown, unknown[], number], ...preArgs);
				expect(applied.apply(self, restArgs)).toEqual([self, [...preArgs, ...restArgs], pre + rest]);
			}
		}
	});

	it('flip forwards `this` and the reversed arguments, whatever their number', function () {
		const self = { id: 2 };
		const flipped = helpers.flip(collect as (...args: unknown[]) => [unknown, unknown[], number]) as (...args: unknown[]) => [unknown, unknown[], number];
		for (let count = 0; count <= 5; count++) {
			const args = Array.from({ length: count }, function (_unused, i) {
				return i;
			});
			expect(flipped.apply(self, args)).toEqual([self, args.slice().reverse(), count]);
		}
	});

	it('memoize passes `this` and exactly the received arguments to fn and the resolver', function () {
		const self = { id: 3 };
		const seen: Array<[unknown, number]> = [];
		const fn = jest.fn(collect);
		const memoized = helpers.memoize(fn as (...args: unknown[]) => [unknown, unknown[], number], {
			resolver: function (this: unknown, ...args: unknown[]): unknown {
				seen.push([this, args.length]);
				return args.join('|');
			}
		});
		expect(memoized.call(self)).toEqual([self, [], 0]);
		expect(memoized.call(self, 'a')).toEqual([self, ['a'], 1]);
		expect(memoized.call(self, 'a', 'b', 'c')).toEqual([self, ['a', 'b', 'c'], 3]);
		expect(memoized.call(self, 'a')).toEqual([self, ['a'], 1]);
		expect(fn).toHaveBeenCalledTimes(3);
		expect(seen).toEqual([
			[self, 0],
			[self, 1],
			[self, 3],
			[self, 1]
		]);
	});

	it('memoize with the default key: one argument keys by value, zero or several by the serialised list', function () {
		const fn = jest.fn(collect);
		const memoized = helpers.memoize(fn as (...args: unknown[]) => [unknown, unknown[], number]);
		memoized(1);
		memoized(1);
		memoized('[1]');
		memoized(-0);
		memoized(0);
		memoized();
		memoized();
		memoized(1, 2);
		memoized(1, 2);
		expect(fn).toHaveBeenCalledTimes(6);
		expect([...memoized.cache.keys()]).toEqual([1, '["[1]"]', '["-0"]', 0, '[]', '[1,2]']);
		expect(fn.mock.calls).toEqual([[1], ['[1]'], [-0], [0], [], [1, 2]]);
	});

	it('after counts down from n, invoking from the n-th call on with `this` and the arguments', function () {
		const self = { id: 4 };
		const after3 = helpers.after(3, collect as (...args: unknown[]) => [unknown, unknown[], number]);
		expect(after3.call(self, 1)).toBeUndefined();
		expect(after3.call(self, 2)).toBeUndefined();
		expect(after3.call(self, 3, 4)).toEqual([self, [3, 4], 2]);
		expect(after3.call(self)).toEqual([self, [], 0]);
		expect(helpers.after(0, collect as (...args: unknown[]) => [unknown, unknown[], number])('x')).toEqual([undefined, ['x'], 1]);
		expect(helpers.after(1, collect as (...args: unknown[]) => [unknown, unknown[], number])('y')).toEqual([undefined, ['y'], 1]);
	});

	it('pipe and compose keep their own copy of the functions and report the original index of an invalid one', function () {
		function inc(n: number): number {
			return n + 1;
		}
		function double(n: number): number {
			return n * 2;
		}
		expect(helpers.pipe(inc, double)(1)).toBe(4);
		expect(helpers.compose(inc, double)(1)).toBe(3);
		expect(function () {
			helpers.compose(inc, 1 as unknown as typeof inc, double);
		}).toThrow(new TypeError('compose: `fns[1]` must be a function, got number'));
		expect(function () {
			helpers.pipe(inc, double, 'x' as unknown as typeof inc);
		}).toThrow(new TypeError('pipe: `fns[2]` must be a function, got string'));
	});
});

describe('Functions helpers (security)', function () {
	describe('defaultMemoizeKey collisions', function () {
		it('should not confuse a Date with its ISO string, nor two Dates with each other', function () {
			const iso = new Date(0).toISOString();
			expect(helpers.defaultMemoizeKey(new Date(0), 1)).not.toBe(helpers.defaultMemoizeKey(iso, 1));
			expect(helpers.defaultMemoizeKey(new Date(0))).not.toBe(helpers.defaultMemoizeKey(iso));
			expect(helpers.defaultMemoizeKey({ at: new Date(0) })).not.toBe(helpers.defaultMemoizeKey({ at: iso }));
			expect(helpers.defaultMemoizeKey(new Date(0))).not.toBe(helpers.defaultMemoizeKey(new Date(1)));
			// Dates are compared by time value, not identity.
			expect(helpers.defaultMemoizeKey(new Date(5), 'x')).toBe(helpers.defaultMemoizeKey(new Date(5), 'x'));
			expect(helpers.defaultMemoizeKey(new Date(5))).toBe('["Date(5)"]');
			expect(helpers.defaultMemoizeKey(new Date(NaN))).toBe('["Date(NaN)"]');
			expect(helpers.defaultMemoizeKey('Date(5)')).toBe('Date(5)');
			expect(helpers.defaultMemoizeKey('Date(5)', 1)).toBe('["\\\\Date(5)",1]');
		});

		it('should not confuse errors, class instances with private state, maps or sets', function () {
			class User {
				readonly #id: number;
				constructor(id: number) {
					this.#id = id;
				}
				get id(): number {
					return this.#id;
				}
			}
			const message = helpers.memoize(function (error: Error): string {
				return error.message;
			});
			expect([message(new Error('a')), message(new Error('b'))]).toEqual(['a', 'b']);
			const id = helpers.memoize(function (user: User, n: number): number {
				return user.id + n;
			});
			expect([id(new User(1), 0), id(new User(2), 0)]).toEqual([1, 2]);
			const size = helpers.memoize(function (map: Map<number, number>): number {
				return map.size;
			});
			expect([size(new Map()), size(new Map([[1, 1]]))]).toEqual([0, 1]);
			expect(helpers.defaultMemoizeKey({ s: new Set([1]) })).not.toBe(helpers.defaultMemoizeKey({ s: new Set([2]) }));
		});

		it('should key functions, symbols and non-plain objects by identity', function () {
			const user = new (class Box {
				value = 1;
			})();
			const error = new Error('x');
			const sym = Symbol('x');
			// A lone one is its own key.
			expect(helpers.defaultMemoizeKey(user)).toBe(user);
			expect(helpers.defaultMemoizeKey(error)).toBe(error);
			expect(helpers.defaultMemoizeKey(helpers.noop)).toBe(helpers.noop);
			expect(helpers.defaultMemoizeKey(sym)).toBe(sym);
			// In a list, they get a stable identity marker.
			expect(helpers.defaultMemoizeKey(user, 1)).toBe(helpers.defaultMemoizeKey(user, 1));
			expect(helpers.defaultMemoizeKey(user, 1)).toMatch(/^\["#\d+",1\]$/);
			expect(helpers.defaultMemoizeKey(user, 1)).not.toBe(helpers.defaultMemoizeKey(new (class Box {})(), 1));
			expect(helpers.defaultMemoizeKey([helpers.noop])).not.toBe(helpers.defaultMemoizeKey([helpers.identity]));
			expect(helpers.defaultMemoizeKey(Symbol.for('a'), 1)).toBe(helpers.defaultMemoizeKey(Symbol.for('a'), 1));
			expect(helpers.defaultMemoizeKey(Symbol.for('a'), 1)).not.toBe(helpers.defaultMemoizeKey(Symbol.for('b'), 1));
			expect(helpers.defaultMemoizeKey(Symbol('a'), 1)).not.toBe(helpers.defaultMemoizeKey(Symbol('a'), 1));
			// Strings shaped like an identity marker are escaped.
			const marker = JSON.parse(helpers.defaultMemoizeKey(user, 1) as string)[0] as string;
			expect(helpers.defaultMemoizeKey(marker, 1)).not.toBe(helpers.defaultMemoizeKey(user, 1));
			expect(helpers.defaultMemoizeKey('#12', 1)).toBe('["\\\\#12",1]');
		});

		it('should not confuse symbols, functions, undefined and null (previously all null)', function () {
			const keys = [
				helpers.defaultMemoizeKey(Symbol('x'), 1),
				helpers.defaultMemoizeKey(null, 1),
				helpers.defaultMemoizeKey(undefined, 1),
				helpers.defaultMemoizeKey(helpers.noop, 1),
				helpers.defaultMemoizeKey([null]),
				helpers.defaultMemoizeKey([undefined]),
				helpers.defaultMemoizeKey([helpers.noop]),
				helpers.defaultMemoizeKey({ a: undefined }),
				helpers.defaultMemoizeKey({}),
				helpers.defaultMemoizeKey({ a: helpers.noop }),
				helpers.defaultMemoizeKey({ a: null })
			];
			expect(new Set(keys).size).toBe(keys.length);
		});

		it('should keep value-based keys for plain objects and arrays (also with a null prototype), ignoring toJSON', function () {
			expect(helpers.defaultMemoizeKey({ a: [1, { b: 2 }] })).toBe(helpers.defaultMemoizeKey({ a: [1, { b: 2 }] }));
			expect(helpers.defaultMemoizeKey(Object.assign(Object.create(null), { a: 1 }))).toBe('[{"a":1}]');
			expect(helpers.defaultMemoizeKey({ toJSON: helpers.constant(1) }, 2)).not.toBe(helpers.defaultMemoizeKey(1, 2));
			expect(helpers.defaultMemoizeKey({ toJSON: helpers.constant(1) })).toMatch(/^\[\{"toJSON":"#\d+"\}\]$/);
		});

		it('should not throw on cycles through non-plain objects', function () {
			class Node {
				self: Node = this;
			}
			expect(helpers.defaultMemoizeKey({ node: new Node() })).toMatch(/^\[\{"node":"#\d+"\}\]$/);
		});
	});
});

/** Compile-time assertion that `T` is exactly `U`. */
type Equals<T, U> = (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | undefined {
	return undefined;
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number';
}

function hasLength(value: unknown): value is { length: number } {
	return (typeof value === 'object' && value !== null && 'length' in value) || typeof value === 'string';
}

describe('Functions helpers (round 11)', function () {
	describe('partialRight', function () {
		function join3(a: string, b: string, c: string): string {
			return `${a}-${b}-${c}`;
		}

		it('appends the bound arguments after the call arguments', function () {
			const withTail = partialRight(join3, 'b', 'c');
			expect(withTail('a')).toBe('a-b-c');
			const withLast = partialRight(join3, 'c');
			expect(withLast('a', 'b')).toBe('a-b-c');
			expect(partialRight(join3)('a', 'b', 'c')).toBe('a-b-c');
			expect(partialRight(join3, 'a', 'b', 'c')()).toBe('a-b-c');
		});

		it('types the returned function with the leading parameters', function () {
			const withLast = partialRight(join3, 'c');
			assertType<Equals<Parameters<typeof withLast>, [a: string, b: string]>>();
			assertType<Equals<ReturnType<typeof withLast>, string>>();
			const toHex = partialRight(Number.parseInt, 16);
			assertType<Equals<Parameters<typeof toHex>, [string: string]>>();
			expect(toHex('ff')).toBe(255);
			// @ts-expect-error the bound arguments must be a suffix of the parameters
			partialRight(join3, 1);
			function rest(first: number, ...others: string[]): string {
				return `${first}:${others.join(',')}`;
			}
			const restBound = partialRight(rest, 'z');
			assertType<Equals<Parameters<typeof restBound>, [first: number, ...others: string[]]>>();
			expect(restBound(1, 'y')).toBe('1:y,z');
		});

		it('shifts the bound arguments left when fewer call arguments are given (like lodash)', function () {
			const fn = jest.fn(function (...args: unknown[]) {
				return args;
			});
			const bound = partialRight(fn as (a?: unknown, b?: unknown, c?: unknown) => unknown[], 'c');
			expect((bound as (...args: unknown[]) => unknown[])()).toEqual(['c']);
			expect((bound as (...args: unknown[]) => unknown[])('a', 'b', 'x')).toEqual(['a', 'b', 'x', 'c']);
		});

		it('forwards this', function () {
			const target = {
				prefix: '>',
				show: partialRight(function (this: { prefix: string }, value: string, suffix: string): string {
					return `${this.prefix}${value}${suffix}`;
				}, '!')
			};
			expect(target.show('hi')).toBe('>hi!');
		});

		it('throws a TypeError when fn is not a function', function () {
			expect(function () {
				partialRight(null as any, 1);
			}).toThrow(new TypeError('partialRight: `fn` must be a function, got null'));
		});
	});

	describe('allPass / anyPass', function () {
		it('allPass is true only when every predicate passes, and stops at the first failure', function () {
			const calls: string[] = [];
			const positive = jest.fn(function (n: number) {
				calls.push('positive');
				return n > 0;
			});
			const even = jest.fn(function (n: number) {
				calls.push('even');
				return n % 2 === 0;
			});
			const both = allPass(positive, even);
			expect(both(4)).toBe(true);
			expect(both(3)).toBe(false);
			calls.length = 0;
			expect(both(-2)).toBe(false);
			expect(calls).toEqual(['positive']);
		});

		it('anyPass is true as soon as one predicate passes, and stops there', function () {
			const calls: string[] = [];
			function small(n: number): boolean {
				calls.push('small');
				return n < 10;
			}
			function big(n: number): boolean {
				calls.push('big');
				return n > 100;
			}
			const either = anyPass(small, big);
			expect(either(5)).toBe(true);
			expect(calls).toEqual(['small']);
			expect(either(500)).toBe(true);
			expect(either(50)).toBe(false);
		});

		it('returns booleans for truthy/falsy predicate results', function () {
			expect(
				allPass(function () {
					return 'yes';
				})(1)
			).toBe(true);
			expect(
				anyPass(function () {
					return 0;
				})(1)
			).toBe(false);
			expect(
				anyPass(function () {
					return {};
				})(1)
			).toBe(true);
		});

		it('handles no predicates (allPass: true, anyPass: false)', function () {
			expect(allPass()(1)).toBe(true);
			expect(anyPass()(1)).toBe(false);
		});

		it('forwards this and every argument (filter callbacks receive the index)', function () {
			const odd = allPass(function (_value: string, index: number) {
				return index % 2 === 1;
			} as (value: string, ...rest: never[]) => boolean);
			expect(['a', 'b', 'c', 'd'].filter(odd)).toEqual(['b', 'd']);
			const holder = {
				min: 3,
				check: anyPass(function (this: { min: number }, n: number) {
					return n >= this.min;
				})
			};
			expect(holder.check(4)).toBe(true);
			expect(holder.check(2)).toBe(false);
		});

		it('forwards exactly the arguments it receives, whatever their number', function () {
			const seen: unknown[][] = [];
			function record(...args: unknown[]): boolean {
				seen.push(args);
				return true;
			}
			const check = allPass(record as (value: unknown, ...rest: never[]) => boolean) as (...args: unknown[]) => boolean;
			check();
			check(1);
			check(1, 2);
			check(1, 2, 3);
			check(1, 2, 3, 4);
			expect(seen).toEqual([[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]);
		});

		it('copies the predicate list (later changes to the arguments array do not leak in)', function () {
			const predicates = [isString];
			const check = anyPass(...predicates);
			predicates.push(isNumber as any);
			expect(check(1)).toBe(false);
		});

		it('keeps type-guard narrowing', function () {
			const mixed: unknown[] = ['ab', 1, [1, 2], null];
			const strings = mixed.filter(allPass(isString, hasLength));
			assertType<Equals<typeof strings, Array<string & { length: number }>>>();
			expect(strings).toEqual(['ab']);
			const scalars = mixed.filter(anyPass(isString, isNumber));
			assertType<Equals<typeof scalars, Array<string | number>>>();
			expect(scalars).toEqual(['ab', 1]);
			// A plain predicate in anyPass removes the narrowing.
			const loose = mixed.filter(
				anyPass(isString, function (value: unknown): boolean {
					return value === null;
				})
			);
			assertType<Equals<typeof loose, unknown[]>>();
			expect(loose).toEqual(['ab', null]);
			// A plain predicate in allPass adds nothing. Its parameter type is not required when an earlier guard guarantees it (evaluation
			// stops at the first failure), so the guard can filter a wider array; first in line, it is required.
			/**
			 * Whether a string is shorter than 2 characters.
			 */
			function isShort(value: string): boolean {
				return value.length < 2;
			}
			const shortString = allPass(isString, isShort);
			assertType<Equals<Parameters<typeof shortString>[0], unknown>>();
			const shorts = ['a', 7, 'bc'].filter(shortString);
			assertType<Equals<typeof shorts, string[]>>();
			expect(shorts).toEqual(['a']);
			const shortFirst = allPass(isShort, isString);
			assertType<Equals<Parameters<typeof shortFirst>[0], string>>();
			// Requirements that no earlier guard covers still intersect.
			const both = allPass(isShort, function (value: { trim(): string }): boolean {
				return value.trim() !== '';
			});
			assertType<Equals<Parameters<typeof both>[0], string & { trim(): string }>>();
		});

		it('throws a TypeError naming the first non-function predicate', function () {
			expect(function () {
				allPass(isString, 1 as any);
			}).toThrow(new TypeError('allPass: `predicates[1]` must be a function, got number'));
			expect(function () {
				anyPass(null as any);
			}).toThrow(new TypeError('anyPass: `predicates[0]` must be a function, got null'));
		});
	});

	describe('match', function () {
		it('names the `_` fallback, not the untrusted tag, when the fallback is not a function', function () {
			expect(function () {
				helpers.match({ kind: 'x'.repeat(300) } as { kind: string }, 'kind', { _: 'oops' as any });
			}).toThrow(new TypeError('match: `handlers._` must be a function, got string'));
		});

		type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; size: number } | { kind: 'rect'; width: number; height: number };

		it('uses the `_` fallback for a member whose handler key is present but undefined', function () {
			const shape: Shape = { kind: 'circle', radius: 1 };
			expect(
				match(shape, 'kind', {
					circle: undefined,
					_: function () {
						return 0;
					}
				})
			).toBe(0);
			expect(function () {
				match(shape, 'kind', { circle: undefined } as never);
			}).toThrow('match: no handler for `kind` "circle"');
		});

		function area(shape: Shape): number {
			return match(shape, 'kind', {
				circle: function (circle) {
					return 3 * circle.radius ** 2;
				},
				square: function (square) {
					return square.size ** 2;
				},
				rect: function (rect) {
					return rect.width * rect.height;
				}
			});
		}

		it('calls the handler of the tag with the value', function () {
			expect(area({ kind: 'circle', radius: 2 })).toBe(12);
			expect(area({ kind: 'square', size: 3 })).toBe(9);
			expect(area({ kind: 'rect', width: 2, height: 5 })).toBe(10);
		});

		it('narrows handler arguments and unions the results', function () {
			const shape = { kind: 'circle', radius: 1 } as Shape;
			const result = match(shape, 'kind', {
				circle: function (circle) {
					assertType<Equals<typeof circle, { kind: 'circle'; radius: number }>>();
					return circle.radius;
				},
				square: function (square) {
					return `${square.size}`;
				},
				rect: function () {
					return null;
				}
			});
			assertType<Equals<typeof result, number | string | null>>();
			expect(result).toBe(1);
		});

		it('rejects a missing case at compile time, unless `_` handles the rest', function () {
			const shape = { kind: 'square', size: 2 } as Shape;
			expect(function () {
				match(
					shape,
					'kind',
					// @ts-expect-error the 'rect' and 'square' cases are missing
					{
						circle: function () {
							return 1;
						}
					}
				);
			}).toThrow(AssertionError);
			const fallback = match(shape, 'kind', {
				circle: function () {
					return 'round';
				},
				_: function (other) {
					assertType<Equals<typeof other, Shape>>();
					return other.kind;
				}
			});
			assertType<Equals<typeof fallback, string>>();
			expect(fallback).toBe('square');
		});

		it('prefers the exact handler over `_`', function () {
			expect(
				match({ kind: 'circle', radius: 1 } as Shape, 'kind', {
					circle: function () {
						return 'exact';
					},
					_: function () {
						return 'fallback';
					}
				})
			).toBe('exact');
		});

		it('matches boolean, number and null tags by their string form', function () {
			type Result = { ok: true; value: number } | { ok: false; error: string };
			const failure = { ok: false, error: 'offline' } as Result;
			expect(
				match(failure, 'ok', {
					true: function (success) {
						return success.value;
					},
					false: function (error) {
						return error.error;
					}
				})
			).toBe('offline');
			type Response = { status: 200; body: string } | { status: 404 } | { status: null };
			const notFound = { status: 404 } as Response;
			expect(
				match(notFound, 'status', {
					200: function (ok) {
						return ok.body;
					},
					404: function () {
						return 'missing';
					},
					null: function () {
						return 'none';
					}
				})
			).toBe('missing');
			expect(match({ status: null } as Response, 'status', { _: String })).toBe('[object Object]');
		});

		it('throws an AssertionError naming the key and tag of unexpected data', function () {
			const bad = { kind: 'hexagon' } as unknown as Shape;
			expect(function () {
				area(bad);
			}).toThrow(new AssertionError('match: no handler for `kind` "hexagon"'));
			const long = { kind: 'x'.repeat(500) } as unknown as Shape;
			expect(function () {
				area(long);
			}).toThrow(new AssertionError(`match: no handler for \`kind\` "${'x'.repeat(100)}"`));
		});

		it('ignores inherited properties of handlers (hostile tags)', function () {
			for (const tag of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
				expect(function () {
					area({ kind: tag } as unknown as Shape);
				}).toThrow(AssertionError);
			}
			const handlers = JSON.parse('{"__proto__": 1}');
			expect(function () {
				match({ kind: '__proto__' }, 'kind', handlers);
			}).toThrow(new TypeError('match: `handlers.__proto__` must be a function, got number'));
		});

		it('throws a TypeError for a non-object value', function () {
			expect(function () {
				match(null as any, 'kind', { _: String });
			}).toThrow(new TypeError('match: `value` must be an object, got null'));
			expect(function () {
				match('circle' as any, 'length', { _: String });
			}).toThrow(new TypeError('match: `value` must be an object, got string'));
		});
	});
});

describe('defaultMemoizeKey nested numbers', function () {
	it('serialises nested numbers and booleans, marking -0 and non-finite numbers', function () {
		expect(helpers.defaultMemoizeKey({ a: -0, b: NaN, c: Infinity, d: 1.5, e: true })).toBe('[{"a":"-0","b":"NaN","c":"Infinity","d":1.5,"e":true}]');
	});
});

describe('Functions helpers (hostile inputs)', function () {
	afterEach(function () {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('memoize keys proxies, revoked proxies and fake dates by identity, and dates of other realms by value', function () {
		const fn = jest.fn(function (_argument: unknown) {
			return 1;
		});
		const memo = helpers.memoize(fn);
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		for (const argument of [new Proxy(new Date(0), {}), Object.create(Date.prototype), proxy]) {
			expect(memo(argument)).toBe(1);
			expect(memo(argument)).toBe(1);
		}
		expect(fn).toHaveBeenCalledTimes(3);
		const OtherDate = vm.runInNewContext('Date') as DateConstructor;
		expect(helpers.defaultMemoizeKey([new OtherDate(0)])).toBe(helpers.defaultMemoizeKey([new Date(0)]));
	});

	it('memoize rejects a cache without the cache methods up front', function () {
		expect(function () {
			helpers.memoize(jest.fn(), { cache: 5 as any });
		}).toThrow(new TypeError('memoize: `options.cache` must have get, set, has and clear methods, got number'));
		const methods = { get: helpers.noop, set: helpers.noop, has: helpers.noop, clear: helpers.noop };
		for (const missing of ['get', 'set', 'has', 'clear']) {
			const cache = { ...methods, [missing]: 'not a function' };
			expect(function () {
				helpers.memoize(jest.fn(), { cache: cache as never });
			}).toThrow(new TypeError('memoize: `options.cache` must have get, set, has and clear methods, got object'));
		}
		// `null` gives the default cache, as `undefined` does.
		expect(helpers.memoize(helpers.identity, { cache: null as never })(1)).toBe(1);
		expect(function () {
			helpers.memoize(jest.fn(), { cache: Object.assign(helpers.noop.bind(null), methods) as never });
		}).toThrow(new TypeError('memoize: `options.cache` must have get, set, has and clear methods, got function'));
		expect(typeof helpers.memoize(jest.fn(), { cache: methods as never })).toBe('function');
	});

	it('debounce still invokes when the clock returns NaN', function () {
		jest.useFakeTimers();
		jest.spyOn(Date, 'now').mockReturnValue(NaN);
		const fn = jest.fn();
		const debounced = helpers.debounce(fn, 10);
		debounced();
		jest.advanceTimersByTime(50);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(debounced.pending()).toBe(false);
	});

	it('debounce reads maxWait once', function () {
		jest.useFakeTimers();
		let reads = 0;
		const options = {
			get maxWait(): number {
				return reads++ < 1 ? 50 : ('oops' as unknown as number);
			}
		};
		const fn = jest.fn();
		const debounced = helpers.debounce(fn, 100, options);
		for (let i = 0; i < 15; i++) {
			debounced();
			jest.advanceTimersByTime(20);
		}
		expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('match accepts a function carrying the tag', function () {
		const tagged = Object.assign(function (): void {}, { kind: 'f' as const });
		expect(
			helpers.match(tagged, 'kind', {
				f: function () {
					return 1;
				}
			})
		).toBe(1);
	});
});

describe('pipeAsync / composeAsync', function () {
	function inc(x: number): number {
		return x + 1;
	}
	async function double(x: number): Promise<number> {
		return x * 2;
	}
	function length(text: string): number {
		return text.length;
	}

	it('awaits each step and passes the value on, left to right or right to left', async function () {
		await expect(helpers.pipeAsync(double, inc)(3)).resolves.toBe(7);
		await expect(helpers.composeAsync(double, inc)(3)).resolves.toBe(8);
		const result: number = await helpers.pipeAsync(double, String, length)(50);
		expect(result).toBe(3);
	});

	it('always returns a promise, even when every step is synchronous', async function () {
		const piped = helpers.pipeAsync(inc, inc);
		const promise = piped(1);
		expect(promise).toBeInstanceOf(Promise);
		await expect(promise).resolves.toBe(3);
	});

	it('runs the steps one after the other', async function () {
		const events: string[] = [];
		function step(name: string, hops: number): (value: number) => Promise<number> {
			return async function (value: number): Promise<number> {
				events.push(`start ${name}`);
				// Settles after `hops` microtasks: a step that took longer would still finish before the next one starts.
				for (let i = 0; i < hops; i++) await Promise.resolve();
				events.push(`end ${name}`);
				return value + 1;
			};
		}
		await expect(helpers.pipeAsync(step('a', 20), step('b', 0), step('c', 5))(0)).resolves.toBe(3);
		expect(events).toStrictEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
	});

	it('rejects when a step throws or rejects, without calling the following steps', async function () {
		const after = jest.fn();
		const failure = new Error('boom');
		function throwing(): number {
			throw failure;
		}
		let call: Promise<unknown> | undefined;
		expect(function () {
			call = helpers.pipeAsync(throwing, after)();
		}).not.toThrow();
		await expect(call).rejects.toBe(failure);
		await expect(
			helpers.pipeAsync(
				inc,
				function () {
					return Promise.reject(failure);
				},
				after
			)(1)
		).rejects.toBe(failure);
		await expect(helpers.composeAsync(after, throwing)()).rejects.toBe(failure);
		expect(after).not.toHaveBeenCalled();
	});

	it('assimilates thenables and resolves promises passed to the empty pipeline', async function () {
		const thenable = {
			then(resolve: (value: number) => void): void {
				resolve(41);
			}
		};
		await expect(
			helpers.pipeAsync(function () {
				return thenable;
			}, inc)()
		).resolves.toBe(42);
		await expect(helpers.pipeAsync()(Promise.resolve('x'))).resolves.toBe('x');
		await expect(helpers.composeAsync()(5)).resolves.toBe(5);
		const resolved: string = await helpers.pipeAsync()(Promise.resolve('typed'));
		expect(resolved).toBe('typed');
	});

	it('passes every argument to the first function and forwards `this`', async function () {
		const target = {
			factor: 10,
			run: helpers.pipeAsync(
				function (this: { factor: number }, a: number, b: number) {
					return (a + b) * this.factor;
				},
				async function (this: { factor: number }, value: number) {
					return value + this.factor;
				}
			)
		};
		await expect(target.run(1, 2)).resolves.toBe(40);
	});

	it('supports every typed arity and spread arrays', async function () {
		await expect(helpers.pipeAsync(inc)(0)).resolves.toBe(1);
		await expect(helpers.pipeAsync(inc, double, inc)(0)).resolves.toBe(3);
		await expect(helpers.pipeAsync(inc, double, inc, double)(0)).resolves.toBe(6);
		await expect(helpers.pipeAsync(inc, double, inc, double, inc)(0)).resolves.toBe(7);
		await expect(helpers.pipeAsync(inc, double, inc, double, inc, double)(0)).resolves.toBe(14);
		await expect(helpers.pipeAsync<number>(inc, inc, inc, inc, inc, inc, inc)(0)).resolves.toBe(7);
		await expect(helpers.composeAsync(inc)(0)).resolves.toBe(1);
		await expect(helpers.composeAsync(inc, double, inc)(0)).resolves.toBe(3);
		await expect(helpers.composeAsync(inc, double, inc, double)(0)).resolves.toBe(3);
		await expect(helpers.composeAsync(inc, double, inc, double, inc)(0)).resolves.toBe(7);
		await expect(helpers.composeAsync(inc, double, inc, double, inc, double)(0)).resolves.toBe(7);
		const steps = [inc, double];
		await expect(helpers.pipeAsync(...steps)(1)).resolves.toBe(4);
		await expect(helpers.composeAsync(...steps)(1)).resolves.toBe(3);
	});

	it('rejects a step whose input does not match the awaited previous output', function () {
		// @ts-expect-error `double` resolves to a number, `length` takes a string
		helpers.pipeAsync(double, length);
		// @ts-expect-error same, right to left
		helpers.composeAsync(length, double);
		expect(helpers.pipeAsync(double, String, length)).toBeInstanceOf(Function);
	});

	it('keeps its own copy of the functions and reports the original index of an invalid one', async function () {
		const fns = [inc, double];
		const piped = helpers.pipeAsync(...fns);
		const composed = helpers.composeAsync(...fns);
		fns.reverse();
		await expect(piped(1)).resolves.toBe(4);
		await expect(composed(1)).resolves.toBe(3);
		expect(function () {
			helpers.pipeAsync(inc, 1 as any);
		}).toThrow(new TypeError('pipeAsync: `fns[1]` must be a function, got number'));
		expect(function () {
			helpers.composeAsync(null as any, inc, inc);
		}).toThrow(new TypeError('composeAsync: `fns[0]` must be a function, got null'));
	});
});

describe('matchWith / matcher', function () {
	type Event = { type: 'click'; x: number; button: number } | { type: 'key'; key: string };

	function label(event: Event): string {
		return matchWith(event)
			.with({ type: 'click', button: 0 }, function () {
				return 'left click';
			})
			.with(
				{ type: 'click' },
				function (click) {
					return click.x > 100;
				},
				function () {
					return 'click on the right';
				}
			)
			.with({ type: 'click' }, function (click) {
				return `click at ${click.x}`;
			})
			.with({ type: 'key', key: isString }, function (key) {
				return `key ${key.key}`;
			})
			.exhaustive();
	}

	describe('matchWith', function () {
		it('calls the handler of the first matching case, in order', function () {
			expect(label({ type: 'click', x: 10, button: 0 })).toBe('left click');
			expect(label({ type: 'click', x: 200, button: 2 })).toBe('click on the right');
			expect(label({ type: 'click', x: 10, button: 2 })).toBe('click at 10');
			expect(label({ type: 'key', key: 'Enter' })).toBe('key Enter');
		});

		it('tests eagerly, stops once a case matched, and runs the handler at the end', function () {
			const later = jest.fn(function (_value: unknown) {
				return true;
			});
			const when = jest.fn(function () {
				return true;
			});
			const handler = jest.fn(function () {
				return 1;
			});
			const getter = jest.fn(function () {
				return 1;
			});
			const builder = matchWith({ a: 1 })
				.with({ a: later }, handler)
				.with({ a: later }, function () {
					return 2;
				})
				.with(
					{
						get a() {
							return getter();
						}
					},
					when,
					function () {
						return 3;
					}
				);
			expect(later).toHaveBeenCalledTimes(1);
			expect(when).not.toHaveBeenCalled();
			expect(getter).not.toHaveBeenCalled();
			expect(handler).not.toHaveBeenCalled();
			expect(builder.otherwise(String)).toBe(1);
			expect(handler).toHaveBeenCalledWith({ a: 1 });
		});

		it('tries the next case when the `when` guard is falsy, and passes it the selection', function () {
			const when = jest.fn(function (_x: number, _point: { x: number; y: number }) {
				return 0;
			});
			const result = matchWith({ x: 1, y: 2 })
				.with({ x: capture() }, when, function () {
					return 'guarded';
				})
				.with(_, function () {
					return 'fallback';
				})
				.exhaustive();
			expect(result).toBe('fallback');
			expect(when).toHaveBeenCalledWith(1, { x: 1, y: 2 });
		});

		it('ends with `otherwise` for unmatched values', function () {
			const fallback = matchWith(5 as number)
				.with(1, function () {
					return 'one';
				})
				.otherwise(function (n) {
					return n * 2;
				});
			expect(fallback).toBe(10);
			expect(
				matchWith(1 as number)
					.with(1, function () {
						return 'one';
					})
					.otherwise(String)
			).toBe('one');
		});

		it('throws an AssertionError naming the type, never the content, when no case matched', function () {
			const secret = { type: 'scroll', token: 'hunter2' } as unknown as Event;
			let thrown: unknown;
			try {
				label(secret);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toEqual(new AssertionError('matchWith: no pattern matched the value (got object)'));
			expect(String(thrown)).not.toContain('hunter2');
			expect(function () {
				(matchWith('hunter2' as string).with('x', String) as any).exhaustive();
			}).toThrow(new AssertionError('matchWith: no pattern matched the value (got string)'));
		});

		it('forgets the captures of a case that failed', function () {
			const result = matchWith({ a: 1, b: 2 })
				.with({ a: capture(), b: 3 }, String)
				.with({ a: 1 }, function (...args: unknown[]) {
					return args.length;
				})
				.otherwise(String);
			expect(result).toBe(1);
		});

		it('validates every handler and guard, even after a match', function () {
			const matched = matchWith(1).with(1, String);
			expect(function () {
				(matched as any).with(1);
			}).toThrow(new TypeError('matchWith: `handler` must be a function, got undefined'));
			expect(function () {
				(matched as any).with(1, 'x', String);
			}).toThrow(new TypeError('matchWith: `when` must be a function, got string'));
			expect(function () {
				(matched as any).with(1, String, null);
			}).toThrow(new TypeError('matchWith: `handler` must be a function, got null'));
			expect(function () {
				matched.otherwise(5 as any);
			}).toThrow(new TypeError('matchWith: `handler` must be a function, got number'));
		});

		it('never changes a builder: one kept before a match can be branched from', function () {
			const base = matchWith(2 as 1 | 2).with(1, function () {
				return 'one';
			});
			const two = base.with(2, function () {
				return 'two';
			});
			const other = base.with(_, function () {
				return 'any';
			});
			expect(two.exhaustive()).toBe('two');
			expect(other.exhaustive()).toBe('any');
			expect(base.otherwise(String)).toBe('2');
		});

		it('supports nested matches inside guards and handlers', function () {
			function inner(value: unknown): boolean {
				return matchWith(value)
					.with({ id: capture() }, function (id) {
						return id === 1;
					})
					.otherwise(function () {
						return false;
					});
			}
			const result = matchWith({ a: { id: 1 }, b: 'x' })
				.with({ a: inner, b: captureAs('b') }, function ({ b }) {
					return matchWith(b)
						.with('x', function () {
							return 'inner x';
						})
						.otherwise(String);
				})
				.otherwise(String);
			expect(result).toBe('inner x');
		});

		it('gives a re-entrant `with` on the same builder captures of its own', function () {
			const state = matchWith({ a: 'outer', b: 1 });
			let inner: unknown;
			const result = state
				.with(
					{
						a: capture(),
						b: function (): boolean {
							inner = state
								.with({ a: captureAs('name') }, function ({ name }) {
									return `inner ${name}`;
								})
								.otherwise(String);
							return true;
						}
					},
					function (a) {
						return a;
					}
				)
				.otherwise(String);
			expect(result).toBe('outer');
			expect(inner).toBe('inner outer');
			// The builder still works (and reuses its log) afterwards.
			expect(
				state
					.with({ b: capture() }, function (b) {
						return b;
					})
					.otherwise(String)
			).toBe(1);
		});
	});

	describe('patterns (the semantics of isMatching)', function () {
		const symbol = Symbol('key');
		const marker = new Map();
		const patterns: unknown[] = [
			1,
			'a',
			NaN,
			0,
			null,
			undefined,
			true,
			10n,
			symbol,
			marker,
			new Date(5),
			{},
			[],
			{ a: 1 },
			{ a: undefined },
			{ a: isOptional(isString) },
			{ a: _ },
			{ a: { b: [1, _] } },
			{ [symbol]: 1 },
			[1, 2],
			[undefined],
			[_],
			[[1], { a: 1 }],
			isString,
			function (value: unknown) {
				return value === 2 ? 1 : 0;
			}
		];
		const values: unknown[] = [
			1,
			2,
			'a',
			NaN,
			-0,
			null,
			undefined,
			true,
			10n,
			symbol,
			marker,
			new Map(),
			new Date(5),
			new Date(6),
			{},
			[],
			{ a: 1 },
			{ a: 1, extra: 1 },
			{ a: undefined },
			{ a: 'x' },
			{ a: { b: [1, 2] } },
			{ a: { b: [1, 2, 3] } },
			Object.create({ a: 1 }),
			{ [symbol]: 1 },
			[1, 2],
			[1, 2, 3],
			// oxlint-disable-next-line no-sparse-arrays
			[,],
			[undefined],
			[[1], { a: 1 }],
			Object.assign(function () {}, { a: 1 }),
			new Proxy({ a: 1 }, {})
		];

		it('matches exactly what isMatching matches', function () {
			for (const pattern of patterns) {
				const guard = isMatching(pattern);
				const reused = matcher<unknown>()
					.with(pattern, function () {
						return true;
					})
					.otherwise(function () {
						return false;
					});
				for (const value of values) {
					const oneShot = matchWith(value)
						.with(pattern, function () {
							return true;
						})
						.otherwise(function () {
							return false;
						});
					expect([pattern, value, oneShot]).toEqual([pattern, value, Boolean(guard(value))]);
					expect([pattern, value, reused(value)]).toEqual([pattern, value, Boolean(guard(value))]);
				}
			}
		});

		it('matches dates of other realms and objects without prototype like isMatching', function () {
			const OtherDate = vm.runInNewContext('Date') as DateConstructor;
			const bare = Object.assign(Object.create(null), { a: 1 });
			for (const [pattern, value] of [
				[new Date(5), new OtherDate(5)],
				[new OtherDate(5), new Date(5)],
				[bare, { a: 1 }],
				[{ a: 1 }, bare],
				[Object.setPrototypeOf(new Date(5), null), new Date(5)]
			]) {
				const expected = isMatching(pattern)(value);
				expect(
					matchWith(value)
						.with(pattern, function () {
							return true;
						})
						.otherwise(function () {
							return false;
						})
				).toBe(expected);
			}
			expect(isMatching(bare)({ a: 1 })).toBe(true);
		});

		it('reads own properties only, with `__proto__` keys in patterns and values', function () {
			const pattern = JSON.parse('{"__proto__": {"admin": true}}');
			expect(isMatching(pattern)(JSON.parse('{"__proto__": {"admin": true}}'))).toBe(true);
			for (const run of [
				function (value: unknown): boolean {
					return matchWith(value)
						.with(pattern, function () {
							return true;
						})
						.otherwise(function () {
							return false;
						});
				},
				matcher<unknown>()
					.with(pattern, function () {
						return true;
					})
					.otherwise(function () {
						return false;
					})
			]) {
				expect(run(JSON.parse('{"__proto__": {"admin": true}}'))).toBe(true);
				expect(run({ admin: true })).toBe(false);
				expect(run(Object.create({ admin: true }))).toBe(false);
				expect(run({})).toBe(false);
			}
			const captured = matchWith(JSON.parse('{"__proto__": 1}'))
				.with({ ['__proto__']: captureAs('__proto__') }, function (selection) {
					return selection;
				})
				.otherwise(String) as Record<string, unknown>;
			expect(Object.getPrototypeOf(captured)).toBeNull();
			expect(Object.hasOwn(captured, '__proto__')).toBe(true);
			expect(captured['__proto__']).toBe(1);
		});

		it('ignores a polluted Object.prototype or Array.prototype, like isMatching', function () {
			const prototype = Object.prototype as Record<string, unknown>;
			const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
			prototype.polluted = 1;
			arrayPrototype[0] = 'polluted';
			try {
				// oxlint-disable-next-line no-sparse-arrays
				const sparse = [, 2];
				for (const [pattern, value] of [
					[{ polluted: 1 }, {}],
					[{ polluted: _ }, {}],
					[[undefined, 2], sparse],
					[['polluted', 2], sparse],
					[cons(undefined), sparse],
					// oxlint-disable-next-line no-sparse-arrays
					[cons(_, [undefined]), [1, ,]],
					[{ a: 1 }, { a: 1 }]
				]) {
					expect(
						matchWith(value)
							.with(pattern, function () {
								return true;
							})
							.otherwise(function () {
								return false;
							})
					).toBe(isMatching(pattern)(value));
				}
				expect(isMatching({ polluted: 1 })({})).toBe(false);
				expect(isMatching([undefined, 2])(sparse)).toBe(true);
				expect(isMatching(['polluted', 2])(sparse)).toBe(false);
				expect(
					matchWith(sparse)
						.with(cons(undefined, [2]), function () {
							return true;
						})
						.otherwise(function () {
							return false;
						})
				).toBe(true);
			} finally {
				delete prototype.polluted;
				delete arrayPrototype[0];
			}
		});

		it('lets errors of getters and guards propagate, and reads each property once', function () {
			const value = {
				get a(): number {
					throw new RangeError('getter');
				}
			};
			expect(function () {
				matchWith(value).with({ a: 1 }, String);
			}).toThrow(new RangeError('getter'));
			let reads = 0;
			const counted = {
				get a(): number {
					reads++;
					return 1;
				}
			};
			matchWith(counted).with({ a: 2 }, String).with({ a: 1 }, String);
			expect(reads).toBe(2);
			expect(function () {
				matchWith(1).with(function () {
					throw new SyntaxError('guard');
				}, String);
			}).toThrow(new SyntaxError('guard'));
		});

		it('matches cyclic values with acyclic patterns', function () {
			const node: { id: number; next?: unknown } = { id: 1 };
			node.next = node;
			expect(
				matchWith(node)
					.with({ id: 1, next: { id: 1, next: { id: captureAs('id') } } }, function ({ id }) {
						return id;
					})
					.otherwise(String)
			).toBe(1);
		});

		it('throws a TypeError for a circular pattern when matching follows the cycle', function () {
			const pattern: Record<string, unknown> = { id: 1 };
			pattern.next = pattern;
			const node: { id: number; next?: unknown } = { id: 1 };
			node.next = node;
			expect(function () {
				matchWith(node).with(pattern, String);
			}).toThrow(new TypeError('matchWith: `pattern` must be acyclic, got a circular reference'));
			const tuple: unknown[] = [1];
			tuple.push(tuple);
			const nested: unknown[] = [1];
			nested.push(nested);
			expect(function () {
				matchWith(nested).with(tuple, String);
			}).toThrow(new TypeError('matchWith: `pattern` must be acyclic, got a circular reference'));
			expect(function () {
				matcher().with(pattern, String);
			}).toThrow(new TypeError('matcher: `pattern` must be acyclic, got a circular reference'));
			expect(function () {
				anyOf(1, pattern);
			}).toThrow(new TypeError('anyOf: `pattern` must be acyclic, got a circular reference'));
			// Through a helper, built before the cycle closes.
			const loop: Record<string, unknown> = {};
			const through = capture(loop);
			loop.next = through;
			const deep: Record<string, unknown> = {};
			deep.next = deep;
			expect(function () {
				matchWith(deep).with(through, String);
			}).toThrow(new TypeError('matchWith: `pattern` must be acyclic, got a circular reference'));
			expect(function () {
				anyOf(1, through);
			}).toThrow(new TypeError('anyOf: `pattern` must be acyclic, got a circular reference'));
			const later: Record<string, unknown> = {};
			const alternatives = anyOf(1, later);
			later.self = alternatives;
			expect(function () {
				matcher().with({ a: alternatives }, String);
			}).toThrow(new TypeError('matcher: `pattern` must be acyclic, got a circular reference'));
			expect(function () {
				isMatching(through)(deep);
			}).toThrow(new TypeError('capture: `pattern` must be acyclic, got a circular reference'));
		});

		it('matches deep acyclic patterns', function () {
			let pattern: unknown = 1;
			let value: unknown = 1;
			for (let depth = 0; depth < 200; depth++) {
				pattern = { next: pattern };
				value = { next: value };
			}
			expect(
				matchWith(value)
					.with(pattern, function () {
						return true;
					})
					.otherwise(String)
			).toBe(true);
		});
	});

	describe('_', function () {
		it('matches anything, including a missing property', function () {
			for (const value of [undefined, null, 0, '', {}, [], Symbol('s')]) expect(_(value)).toBe(true);
			expect(
				matchWith({} as { a?: number })
					.with({ a: _ }, function () {
						return 'any';
					})
					.exhaustive()
			).toBe('any');
		});
	});

	describe('capture / captureAs', function () {
		it('passes an anonymous capture first and the value second', function () {
			const handler = jest.fn(function (_point: number, _value: { x: number }) {
				return 1;
			});
			matchWith({ x: 3 }).with({ x: capture() }, handler).exhaustive();
			expect(handler).toHaveBeenCalledWith(3, { x: 3 });
		});

		it('passes named captures as an object without prototype', function () {
			const result = matchWith({ from: 1, to: 2 })
				.with({ from: captureAs('a'), to: captureAs('b', isNumber) }, function (selection, value) {
					return [selection, value];
				})
				.exhaustive();
			expect(result).toEqual([
				{ a: 1, b: 2 },
				{ from: 1, to: 2 }
			]);
			expect(Object.getPrototypeOf(result[0])).toBeNull();
		});

		it('captures what its pattern matches, the value of an active pattern, and nested captures', function () {
			const toNumber = active(function (text: unknown) {
				return typeof text === 'string' && text !== '' && !Number.isNaN(Number(text)) ? Number(text) : undefined;
			});
			const result = matchWith({ point: { x: '4', y: 5 } })
				.with({ point: captureAs('point', { x: captureAs('x', toNumber), y: captureAs('y') }) }, function (selection) {
					return selection;
				})
				.otherwise(String);
			expect(result).toEqual({ x: 4, y: 5, point: { x: '4', y: 5 } });
			expect(
				matchWith('7')
					.with(capture(toNumber), function (n) {
						return n;
					})
					.otherwise(String)
			).toBe(7);
			expect(
				matchWith({ a: 'b' })
					.with({ a: capture('c') }, String)
					.otherwise(function () {
						return 'no';
					})
			).toBe('no');
		});

		it('tells capture() (anything) from capture(undefined) (the value undefined, or a missing key)', function () {
			expect(capture()(1)).toBe(true);
			expect(capture(undefined)(1)).toBe(false);
			expect(capture(undefined)(undefined)).toBe(true);
			expect(captureAs('a')(1)).toBe(true);
			expect(captureAs('a', undefined)(1)).toBe(false);
			expect(isMatching({ a: capture(undefined) })({})).toBe(true);
		});

		it('binds nothing inside other guards or isMatching', function () {
			expect(isMatching({ a: capture(1) })({ a: 1 })).toBe(true);
			expect(isMatching(capture(active(Number)))('1')).toBe(true);
			expect(captureAs('n', active(Number))(undefined)).toBe(true);
			expect(isMatching(capture(active(Number)))(undefined)).toBe(true);
			expect(
				matchWith({ tags: ['a', 'b'] })
					.with({ tags: isArrayOf(capture()) }, function (...args: unknown[]) {
						return args.length;
					})
					.otherwise(String)
			).toBe(1);
		});

		it('throws a TypeError for mixed, repeated or several anonymous captures', function () {
			expect(function () {
				matchWith({ a: 1, b: 2 }).with({ a: capture(), b: captureAs('b') } as any, String);
			}).toThrow(new TypeError('matchWith: `pattern` must capture either one anonymous value or named values, got both'));
			expect(function () {
				matchWith({ a: 1, b: 2 }).with({ a: captureAs('a'), b: capture() } as any, String);
			}).toThrow(new TypeError('matchWith: `pattern` must capture either one anonymous value or named values, got both'));
			expect(function () {
				matchWith({ a: 1, b: 2 }).with({ a: capture(), b: capture() }, String);
			}).toThrow(new TypeError('matchWith: `pattern` must capture at most one anonymous value, got several'));
			expect(function () {
				matchWith({ a: 1, b: 2 }).with({ a: captureAs('x'), b: captureAs('x') }, String);
			}).toThrow(new TypeError('matchWith: `pattern` must capture each name once, got "x" twice'));
			expect(function () {
				matcher().with({ a: captureAs('x'), b: captureAs('x') }, String);
			}).toThrow(new TypeError('matcher: `pattern` must capture each name once, got "x" twice'));
			expect(function () {
				matcher().with({ a: capture(), b: capture() }, String);
			}).toThrow(new TypeError('matcher: `pattern` must capture at most one anonymous value, got several'));
			// The same capture held twice captures twice.
			const shared = captureAs('x');
			expect(function () {
				matcher().with([shared, { y: shared }], String);
			}).toThrow(new TypeError('matcher: `pattern` must capture each name once, got "x" twice'));
			expect(function () {
				anyOf([shared, 1], [1, shared], [shared, shared]);
			}).toThrow(new TypeError('anyOf: `patterns[2]` must capture what `patterns[0]` captures ("x"), got "x", "x"'));
		});

		it('requires a string name', function () {
			expect(function () {
				captureAs(1 as any);
			}).toThrow(new TypeError('captureAs: `name` must be a string, got number'));
		});
	});

	describe('active', function () {
		it('matches when the function returns something other than undefined, calling it once per test', function () {
			const parse = jest.fn(function (text: string) {
				return /^\d+$/.test(text) ? Number(text) : text === 'null' ? null : undefined;
			});
			const pattern = active(parse);
			function run(text: string): unknown {
				return matchWith(text)
					.with(pattern, function (n, raw) {
						return [n, raw];
					})
					.otherwise(function () {
						return 'no';
					});
			}
			expect(run('12')).toEqual([12, '12']);
			expect(run('null')).toEqual([null, 'null']);
			expect(run('x')).toBe('no');
			expect(parse).toHaveBeenCalledTimes(3);
			expect(pattern('3')).toBe(true);
			expect(isMatching({ n: pattern })({ n: 'x' })).toBe(false);
		});

		it('requires a function', function () {
			expect(function () {
				active('x' as any);
			}).toThrow(new TypeError('active: `extract` must be a function, got string'));
		});
	});

	describe('anyOf', function () {
		it('matches any alternative, in order, and binds the captures of the one that matched', function () {
			const pattern = anyOf({ a: captureAs('v'), b: 1 }, { a: 2, c: captureAs('v') }, { v: captureAs('v') });
			function run(value: unknown): unknown {
				return matchWith(value)
					.with(pattern, function ({ v }) {
						return v;
					})
					.otherwise(function () {
						return 'no';
					});
			}
			expect(run({ a: 'first', b: 1 })).toBe('first');
			// The first alternative captured `a` before failing on `b`: forgotten.
			expect(run({ a: 2, b: 2, c: 'second' })).toBe('second');
			expect(run({ v: 'third' })).toBe('third');
			// A missing key reads `undefined`, which a capture of anything matches.
			expect(run({})).toBeUndefined();
			expect(run(1)).toBe('no');
			expect(isMatching(anyOf(1, 2))(2)).toBe(true);
			expect(isMatching(anyOf(1, 2))(3)).toBe(false);
		});

		it('requires at least one pattern, capturing the same names', function () {
			expect(function () {
				(anyOf as any)();
			}).toThrow(new RangeError('anyOf: expected at least one pattern, got 0'));
			expect(function () {
				anyOf({ a: captureAs('a') }, { b: captureAs('b') });
			}).toThrow(new TypeError('anyOf: `patterns[1]` must capture what `patterns[0]` captures ("a"), got "b"'));
			expect(function () {
				anyOf({ a: captureAs('a'), b: captureAs('b') }, { a: captureAs('a') });
			}).toThrow(new TypeError('anyOf: `patterns[1]` must capture what `patterns[0]` captures ("a", "b"), got "a"'));
			expect(function () {
				anyOf(capture(), 1);
			}).toThrow(new TypeError('anyOf: `patterns[1]` must capture what `patterns[0]` captures (an anonymous value), got nothing'));
			expect(function () {
				anyOf([captureAs('b'), captureAs('a')], [captureAs('a'), captureAs('b')], anyOf({ a: captureAs('a'), b: captureAs('b') }));
			}).not.toThrow();
		});

		it('builds and compiles patterns that share sub-patterns in time linear in their distinct parts', function () {
			// Counts how often the shared leaf's keys are listed: once per scan or compilation of it, or 2^20 times if shared parts were expanded.
			let reads = 0;
			const leaf = new Proxy(
				{ k: 1 },
				{
					ownKeys(target): (string | symbol)[] {
						reads++;
						return Reflect.ownKeys(target);
					}
				}
			);
			const start = performance.now();
			let shared: unknown = anyOf({ leaf, n: captureAs('n') }, captureAs('n', 2));
			for (let depth = 0; depth < 20; depth++) shared = anyOf([shared, 'a'], [shared, 'b']);
			const built = reads;
			const run = matcher()
				.with(shared, function (selection: unknown) {
					return (selection as { n: unknown }).n;
				})
				.otherwise(function () {
					return 'no';
				});
			expect(built).toBeLessThan(100);
			expect(reads - built).toBeLessThan(10);
			expect(performance.now() - start).toBeLessThan(1000);
			// (Matching retries the shared part for each alternative that fails after it, so these values take the first one below the top.)
			let value: unknown = 2;
			let other: unknown = { leaf: { k: 1 }, n: 'deep' };
			for (let depth = 0; depth < 20; depth++) {
				value = [value, depth === 19 ? 'b' : 'a'];
				other = [other, 'a'];
			}
			expect(run(value)).toBe(2);
			expect(run(other)).toBe('deep');
			expect(run([value, 'c'])).toBe('no');
			expect(
				matchWith(other)
					.with(shared, function (selection: unknown) {
						return (selection as { n: unknown }).n;
					})
					.otherwise(String)
			).toBe('deep');
		});
	});

	describe('cons', function () {
		const sum: (list: number[]) => number = matcher<number[]>()
			.with([], function () {
				return 0;
			})
			.with(cons(captureAs('head'), captureAs('tail')), function ({ head, tail }) {
				return head + sum(tail);
			})
			.exhaustive();

		it('splits non-empty arrays into head and tail', function () {
			expect(sum([])).toBe(0);
			expect(sum([1, 2, 3])).toBe(6);
			expect(cons(1)([1])).toBe(true);
			expect(cons(1)([1, 2])).toBe(true);
			expect(cons(1)([2])).toBe(false);
			expect(cons(_)([])).toBe(false);
			expect(cons(_)('abc')).toBe(false);
			expect(cons(1, [])([1, 2])).toBe(false);
			expect(cons(1, [2])([1, 2])).toBe(true);
			expect(cons(1, cons(2))([1, 2, 3])).toBe(true);
		});

		it('passes the tail as a new dense array', function () {
			const list = [1, 2, 3];
			const tail = matchWith(list)
				.with(cons(_, capture()), function (rest) {
					return rest;
				})
				.otherwise(String);
			expect(tail).toEqual([2, 3]);
			expect(tail).not.toBe(list);
			// oxlint-disable-next-line no-sparse-arrays
			const holes = matchWith([1, , 3])
				.with(cons(_, capture()), function (rest) {
					return rest;
				})
				.otherwise(String) as unknown[];
			expect(Object.hasOwn(holes, 0)).toBe(true);
			expect(holes).toEqual([undefined, 3]);
		});
	});

	describe('matcher', function () {
		it('returns the matching function, with the results of the handlers', function () {
			const run = matcher<Event>()
				.with({ type: 'click' }, function (click) {
					return click.x;
				})
				.with({ type: 'key' }, function (key) {
					return key.key;
				})
				.exhaustive();
			expect([{ type: 'click', x: 1, button: 0 } as Event, { type: 'key', key: 'k' } as Event].map(run)).toEqual([1, 'k']);
			expect(function () {
				run({ type: 'scroll' } as unknown as Event);
			}).toThrow(new AssertionError('matcher: no pattern matched the value (got object)'));
		});

		it('compiles the patterns once: later changes to them do not matter', function () {
			const pattern = { a: { b: 1 } };
			const withHelper = { a: { b: 1 }, c: capture() };
			const run = matcher<unknown>()
				.with(pattern, function () {
					return 'plain';
				})
				.with(withHelper, function (c) {
					return c;
				})
				.otherwise(function () {
					return 'no';
				});
			pattern.a.b = 2;
			withHelper.a.b = 2;
			expect(run({ a: { b: 1 } })).toBe('plain');
			expect(run({ a: { b: 2 } })).toBe('no');
			pattern.a = { b: 3 };
			expect(run({ a: { b: 1 } })).toBe('plain');
			const nested = { b: 1 };
			const viaAnyOf = matcher<unknown>()
				.with({ a: anyOf(nested, 5), c: capture() }, function (c) {
					return c;
				})
				.otherwise(String);
			nested.b = 2;
			expect(viaAnyOf({ a: { b: 1 }, c: 'c' })).toBe('c');
		});

		it('validates the cases as they are added', function () {
			expect(function () {
				(matcher<number>() as any).with(1);
			}).toThrow(new TypeError('matcher: `handler` must be a function, got undefined'));
			expect(function () {
				(matcher<number>() as any).with(1, 2, String);
			}).toThrow(new TypeError('matcher: `when` must be a function, got number'));
			expect(function () {
				matcher<number>().otherwise(1 as any);
			}).toThrow(new TypeError('matcher: `handler` must be a function, got number'));
		});

		it('supports guarded cases, captures and shared prefixes', function () {
			const base = matcher<{ n: number }>().with(
				{ n: capture() },
				function (n) {
					return n > 10;
				},
				function (n) {
					return `big ${n}`;
				}
			);
			const small = base
				.with({ n: captureAs('n') }, function ({ n }) {
					return `small ${n}`;
				})
				.exhaustive();
			const other = base.otherwise(function () {
				return 'other';
			});
			expect(small({ n: 20 })).toBe('big 20');
			expect(small({ n: 1 })).toBe('small 1');
			expect(other({ n: 1 })).toBe('other');
		});

		it('compiles arrays, active patterns, captures of them and symbol keys of patterns holding helpers', function () {
			const symbol = Symbol('s');
			const hidden = Symbol('hidden');
			const pattern = { [symbol]: [captureAs('first'), captureAs('n', active(Number))] };
			Object.defineProperty(pattern, hidden, { value: 'ignored', enumerable: false });
			const run = matcher<unknown>()
				.with(pattern, function (selection) {
					return selection;
				})
				.with([active(Number)], function (n) {
					return n;
				})
				.otherwise(function () {
					return 'no';
				});
			expect(run({ [symbol]: ['a', '2'] })).toEqual({ first: 'a', n: 2 });
			expect(run(['3'])).toBe(3);
			expect(run({ [symbol]: ['a'] })).toBe('no');
		});

		it('compares a proxy pattern whose prototype cannot be read by identity, and rejects a revoked one, like isMatching', function () {
			const { proxy: revoked, revoke } = Proxy.revocable({}, {});
			revoke();
			expect(function () {
				isMatching(revoked);
			}).toThrow(TypeError);
			expect(function () {
				matchWith({}).with(revoked, String);
			}).toThrow(TypeError);
			const proxy = new Proxy(
				{},
				{
					getPrototypeOf(): object {
						throw new Error('trap');
					}
				}
			);
			for (const value of [proxy, {}]) {
				expect(
					matchWith(value)
						.with(proxy, function () {
							return true;
						})
						.otherwise(function () {
							return false;
						})
				).toBe(isMatching(proxy)(value));
			}
		});

		it('keeps the semantics of each part of a pattern holding helpers (regressions)', function () {
			const date = new Date(5);
			const list = [1];
			const shared = { x: 1 };
			const run = matcher<unknown>()
				.with({ missing: undefined, d: date, list, a: shared, b: shared, c: capture() }, function (c) {
					return c;
				})
				.otherwise(function () {
					return 'no';
				});
			date.setTime(6);
			list[0] = 2;
			shared.x = 2;
			expect(run({ missing: undefined, d: new Date(5), list: [1], a: { x: 1 }, b: { x: 1 }, c: 'c' })).toBe('c');
			// A literal `undefined` still needs the key.
			expect(run({ d: new Date(5), list: [1], a: { x: 1 }, b: { x: 1 }, c: 'c' })).toBe('no');
			expect(run({ missing: undefined, d: new Date(6), list: [1], a: { x: 1 }, b: { x: 1 }, c: 'c' })).toBe('no');
		});

		it('binds the captures of every alternative, tail and nested helper', function () {
			const tail = matcher<number[]>()
				.with(cons(_, capture()), function (rest) {
					return rest;
				})
				.otherwise(function () {
					return [];
				});
			expect(tail([1, 2])).toEqual([2]);
			const either = matcher<{ a?: number; b?: number }>()
				.with(anyOf({ a: captureAs('x', isNumber) }, { b: captureAs('x', isNumber) }), function ({ x }) {
					return x;
				})
				.otherwise(function () {
					return 0;
				});
			expect(either({ b: 2 })).toBe(2);
		});

		it('names the helper that met a circular pattern', function () {
			const deep: Record<string, unknown> = {};
			deep.next = deep;
			for (const [name, make] of [
				[
					'captureAs',
					function (inner: unknown) {
						return captureAs('n', inner);
					}
				],
				[
					'cons',
					function (inner: unknown) {
						return cons(_, [inner]);
					}
				]
			] as const) {
				const loop: Record<string, unknown> = {};
				const helper = make(loop);
				loop.next = helper;
				// A value that follows the cycle: `[0, { next: <itself> }]` for cons.
				const node: Record<string, unknown> = {};
				const list = [0, node];
				node.next = list;
				expect(function () {
					isMatching(helper)(name === 'cons' ? list : deep);
				}).toThrow(new TypeError(`${name}: \`pattern\` must be acyclic, got a circular reference`));
			}
		});

		it('copies `__proto__` keys of patterns holding helpers as keys', function () {
			const pattern = JSON.parse('{"__proto__": {"admin": true}}');
			pattern.id = capture();
			const run = matcher<unknown>()
				.with(pattern, function (id) {
					return id;
				})
				.otherwise(function () {
					return 'no';
				});
			const value = JSON.parse('{"__proto__": {"admin": true}, "id": 7}');
			expect(run(value)).toBe(7);
			expect(run({ admin: true, id: 7 })).toBe('no');
		});
	});

	describe('types', function () {
		it('narrows handlers and tracks exhaustiveness', function () {
			type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; size: number };
			const shape = { kind: 'circle', radius: 1 } as Shape;
			const result = matchWith(shape)
				.with({ kind: 'circle' }, function (circle) {
					assertType<Equals<typeof circle, { kind: 'circle'; radius: number }>>();
					return circle.radius;
				})
				.with({ kind: 'square' }, function (square) {
					return String(square.size);
				})
				.exhaustive();
			assertType<Equals<typeof result, number | string>>();
			const partial = matchWith({ kind: 'square', size: 2 } as Shape).with({ kind: 'circle' }, String);
			assertType<Equals<typeof partial.exhaustive, NonExhaustiveError<{ kind: 'square'; size: number }>>>();
			expect(function () {
				// @ts-expect-error the 'square' case is missing
				partial.exhaustive();
			}).toThrow(AssertionError);
			const rest = partial.otherwise(function (other) {
				assertType<Equals<typeof other, { kind: 'square'; size: number }>>();
				return other.size;
			});
			assertType<Equals<typeof rest, string | number>>();
		});

		it('handles literal unions, booleans, null and undefined', function () {
			const value = 'b' as 'a' | 'b' | null | undefined | boolean;
			const result = matchWith(value)
				.with(anyOf('a', 'b'), function (letter) {
					assertType<Equals<typeof letter, 'a' | 'b'>>();
					return 1;
				})
				.with(null, function () {
					return 2;
				})
				.with(undefined, function () {
					return 3;
				})
				.with(true, function () {
					return 4;
				})
				.with(false, function () {
					return 5;
				})
				.exhaustive();
			expect(result).toBe(1);
			const flags = [true, false] as [boolean, boolean];
			const pair = matchWith(flags)
				.with([true, true], function () {
					return 'both';
				})
				.with([false, _], function () {
					return 'not the first';
				});
			assertType<Equals<typeof pair.exhaustive, NonExhaustiveError<[true, false]>>>();
			expect(
				pair
					.with([_, false], function (rest) {
						assertType<Equals<typeof rest, [true, false]>>();
						return 'only the first';
					})
					.exhaustive()
			).toBe('only the first');
		});

		it('handles nested discriminants, optional keys and objects split on several keys', function () {
			type Message = { kind: 'data'; payload: { type: 'text'; text: string } | { type: 'binary' } } | { kind: 'close' };
			const message = { kind: 'close' } as Message;
			matchWith(message)
				.with({ kind: 'data', payload: { type: 'text' } }, function (data) {
					return data.payload.text;
				})
				.with({ kind: 'data', payload: { type: 'binary' } }, String)
				.with({ kind: 'close' }, String)
				.exhaustive();
			const optional = {} as { a?: string };
			const missing = matchWith(optional).with({ a: isString }, String).with({ a: undefined }, String);
			assertType<Equals<typeof missing.exhaustive, NonExhaustiveError<{ a?: undefined }>>>();
			missing.with({ a: _ }, String).exhaustive();
			const ab = { a: true, b: false } as { a: boolean; b: boolean };
			expect(
				matchWith(ab)
					.with({ a: true, b: true }, function () {
						return 1;
					})
					.with({ a: true, b: false }, function () {
						return 2;
					})
					.with({ a: false }, function () {
						return 3;
					})
					.exhaustive()
			).toBe(2);
		});

		it('types captures, active patterns and cons', function () {
			const input = '12' as string;
			const doubled = matchWith(input)
				.with(
					active(function (text: string) {
						return /^\d+$/.test(text) ? Number(text) : undefined;
					}),
					function (n, text) {
						assertType<Equals<typeof n, number>>();
						assertType<Equals<typeof text, string>>();
						return n * 2;
					}
				)
				.otherwise(function (text) {
					assertType<Equals<typeof text, string>>();
					return text;
				});
			expect(doubled).toBe(24);
			const list = [1, 2] as number[];
			const head = matchWith(list)
				.with(cons(captureAs('first'), captureAs('rest')), function ({ first, rest }) {
					assertType<Equals<typeof first, number>>();
					assertType<Equals<typeof rest, number[]>>();
					return first;
				})
				.with([], function () {
					return 0;
				})
				.exhaustive();
			expect(head).toBe(1);
			// @ts-expect-error `[]` is not handled
			matchWith(list).with(cons(_), String).exhaustive();
			const nonEmpty = [1] as [number, ...number[]];
			const afterEmpty = matchWith(nonEmpty).with([], String);
			assertType<Equals<typeof afterEmpty.exhaustive, NonExhaustiveError<[number, ...number[]]>>>();
			expect(afterEmpty.with(cons(_), String).exhaustive()).toBe('1');
			expect(function () {
				matchWith({ a: 1, b: 2 }).with(
					{ a: capture(), b: captureAs('b') },
					// @ts-expect-error a pattern cannot mix anonymous and named captures
					function () {
						return 1;
					}
				);
			}).toThrow(TypeError);
		});

		it('ignores guarded cases, partial guards and wide patterns for exhaustiveness', function () {
			const letter = 'x' as 'x' | 'y';
			const variable = 'x' as string;
			const guarded = matchWith(letter).with(
				'x',
				function () {
					return true;
				},
				String
			);
			assertType<Equals<typeof guarded.exhaustive, NonExhaustiveError<'x' | 'y'>>>();
			const wide = matchWith(letter).with(variable, String);
			assertType<Equals<typeof wide.exhaustive, NonExhaustiveError<'x' | 'y'>>>();
			const predicate = matchWith(letter).with(function (value: unknown): boolean {
				return value === 'x';
			}, String);
			assertType<Equals<typeof predicate.exhaustive, NonExhaustiveError<'x' | 'y'>>>();
			const unknownInput = matchWith(letter as unknown).with(isString, function (text) {
				assertType<Equals<typeof text, string>>();
				return 1;
			});
			assertType<Equals<typeof unknownInput.exhaustive, NonExhaustiveError<unknown>>>();
			expect(unknownInput.with(_, String).exhaustive()).toBe(1);
		});

		it('types the matcher function', function () {
			const run = matcher<Event>()
				.with({ type: 'click' }, function () {
					return 1 as const;
				})
				.with({ type: 'key' }, function () {
					return 'k' as const;
				})
				.exhaustive();
			assertType<Equals<typeof run, (value: Event) => 1 | 'k'>>();
			const partial = matcher<Event>().with({ type: 'click' }, String);
			assertType<Equals<typeof partial.exhaustive, NonExhaustiveError<{ type: 'key'; key: string }>>>();
			const fallback = partial.otherwise(function (key) {
				assertType<Equals<typeof key, { type: 'key'; key: string }>>();
				return 0;
			});
			assertType<Equals<typeof fallback, (value: Event) => string | number>>();
		});

		it('only removes an `any` member with a pattern that matches anything', function () {
			const parsed = JSON.parse('"b"');
			const literal = matchWith(parsed).with('a', String);
			assertType<Equals<typeof literal.exhaustive, NonExhaustiveError<any>>>();
			expect(function () {
				// @ts-expect-error `any` may be anything, not just 'a'
				literal.exhaustive();
			}).toThrow(AssertionError);
			const guarded = matcher<any>().with(isString, String).with({ kind: 'a' }, String).with(anyOf(1, 2), String);
			assertType<Equals<typeof guarded.exhaustive, NonExhaustiveError<any>>>();
			// @ts-expect-error a guard narrowing to `string` does not handle `any`
			guarded.exhaustive();
			expect(literal.with(_, String).exhaustive()).toBe('b');
			expect(guarded.with(capture(), String).exhaustive()(5)).toBe('5');
			expect(matcher<unknown>().with(anyOf(1, _), String).exhaustive()(null)).toBe('null');
			const nested = matchWith({ a: 1 } as { a: any; b?: number }).with({ a: 'x' }, String);
			assertType<Equals<typeof nested.exhaustive, NonExhaustiveError<{ a: any; b?: number }>>>();
			expect(nested.with({ a: _ }, String).exhaustive()).toBe('[object Object]');
		});

		it('keeps object types that admit arrays, strings, numbers or functions, which object patterns never match', function () {
			const list = [1, 2] as { length: number };
			const bySize = matchWith(list).with({ length: isNumber }, String);
			assertType<Equals<typeof bySize.exhaustive, NonExhaustiveError<{ length: number }>>>();
			expect(function () {
				// @ts-expect-error an array (or a string) is a `{ length: number }`
				bySize.exhaustive();
			}).toThrow(AssertionError);
			const named = matchWith(String as { name: string }).with({ name: isString }, String);
			assertType<Equals<typeof named.exhaustive, NonExhaustiveError<{ name: string }>>>();
			expect(function () {
				// @ts-expect-error a function is a `{ name: string }`
				named.exhaustive();
			}).toThrow(AssertionError);
			const anyObject = matchWith([1] as object).with({}, String);
			assertType<Equals<typeof anyObject.exhaustive, NonExhaustiveError<object>>>();
			expect(function () {
				// @ts-expect-error an array is an `object`
				anyObject.exhaustive();
			}).toThrow(AssertionError);
			// Object types that only plain objects satisfy are still split by key.
			type Plain = { kind: 'a'; x: number } | { kind: 'b' };
			expect(
				matchWith({ kind: 'b' } as Plain)
					.with({ kind: 'a' }, String)
					.with({ kind: 'b' }, function (b) {
						return b.kind;
					})
					.exhaustive()
			).toBe('b');
		});

		it('only removes the member equal to a pattern that is a single value', function () {
			const prefixed = matchWith('id-2' as `id-${string}`).with('id-1' as `id-${string}`, String);
			assertType<Equals<typeof prefixed.exhaustive, NonExhaustiveError<`id-${string}`>>>();
			expect(function () {
				// @ts-expect-error `id-${string}` holds more values than 'id-1'
				prefixed.exhaustive();
			}).toThrow(AssertionError);
			const upper = matcher<Uppercase<string>>().with('A' as Uppercase<string>, String);
			assertType<Equals<typeof upper.exhaustive, NonExhaustiveError<Uppercase<string>>>>();
			const numeric = matcher<`${number}`>().with('1' as `${number}`, String);
			assertType<Equals<typeof numeric.exhaustive, NonExhaustiveError<`${number}`>>>();
			const big = matcher<bigint>().with(1n as bigint, String);
			assertType<Equals<typeof big.exhaustive, NonExhaustiveError<bigint>>>();
			const loose = matcher<'a'>().with('a' as unknown, String);
			assertType<Equals<typeof loose.exhaustive, NonExhaustiveError<'a'>>>();
			expect(
				matchWith(2n as 1n | 2n)
					.with(1n, String)
					.with(2n, function () {
						return 'two';
					})
					.exhaustive()
			).toBe('two');
		});

		it('removes nothing for a pattern typed object or {}, which may be a map or a class instance (compared by identity)', function () {
			const map: object = new Map();
			const byObject = matchWith({ a: 1 } as { a: number }).with(map, String);
			assertType<Equals<typeof byObject.exhaustive, NonExhaustiveError<{ a: number }>>>();
			expect(function () {
				// @ts-expect-error a map matches no other value
				byObject.exhaustive();
			}).toThrow(AssertionError);
			const byEmpty = matchWith({ a: 1 } as { a: number }).with({}, function () {
				return 'any plain object';
			});
			assertType<Equals<typeof byEmpty.exhaustive, NonExhaustiveError<{ a: number }>>>();
			expect(byEmpty.otherwise(String)).toBe('any plain object');
		});

		it('assumes plain data: a class getter is no own property, and a class-instance pattern compares by identity (use isInstanceOf)', function () {
			class Circle {
				get kind(): 'circle' {
					return 'circle';
				}
			}
			class Token {
				readonly kind = 'eof' as const;
			}
			const shape = new Circle() as Circle | { kind: 'square' };
			// Type-checks, as the types cannot tell a getter from an own property, but no case matches.
			expect(function () {
				matchWith(shape).with({ kind: 'circle' }, String).with({ kind: 'square' }, String).exhaustive();
			}).toThrow(AssertionError);
			expect(
				matchWith(shape)
					.with(isInstanceOf(Circle), function () {
						return 'circle';
					})
					.with({ kind: 'square' }, String)
					.exhaustive()
			).toBe('circle');
			const eof = new Token();
			// Typed structurally, compared by identity.
			expect(function () {
				matchWith(new Token() as Token)
					.with(eof, String)
					.exhaustive();
			}).toThrow(AssertionError);
			expect(
				matchWith(eof as Token)
					.with(eof, String)
					.exhaustive()
			).toBe('[object Object]');
		});

		it('requires the function of an active pattern to accept every value at its position, and narrows nothing', function () {
			function toFixed(n: number): string {
				return n.toFixed(1);
			}
			const mixed = 'a' as string | number;
			expect(function () {
				matchWith(mixed)
					.with(
						active(toFixed),
						// @ts-expect-error the value may be a string
						String
					)
					.otherwise(String);
			}).toThrow(TypeError);
			expect(function () {
				// @ts-expect-error the value may be a string
				matcher<string | number>().with(active(toFixed), String, String);
			}).not.toThrow();
			type Pair = { b: 'x'; a: string } | { b: 'y'; a: number };
			expect(function () {
				matchWith({ b: 'y', a: 1 } as Pair)
					.with(
						{
							a: active(function (text: string) {
								return text.trim();
							}),
							b: 'x'
						},
						// @ts-expect-error `a` is tested before `b`, so the function also receives numbers
						String
					)
					.otherwise(String);
			}).toThrow(TypeError);
			const optional = {} as { a?: string };
			function trim(text: string): string {
				return text.trim();
			}
			expect(function () {
				matchWith(optional)
					.with(
						{ a: captureAs('a', active(trim)) },
						// @ts-expect-error `a` may be missing (and the function then receives `undefined`)
						String
					)
					.otherwise(String);
			}).toThrow(TypeError);
			expect(
				matchWith(optional)
					.with(
						{
							a: captureAs(
								'a',
								active(function (text?: string) {
									return text?.trim();
								})
							)
						},
						function ({ a }) {
							return a;
						}
					)
					.otherwise(String)
			).toBe('[object Object]');
			const result = matchWith(mixed)
				.with(
					anyOf(
						capture(isNumber),
						active(function (value: string | number) {
							return typeof value === 'string' ? value.toUpperCase() : undefined;
						})
					),
					function (selection, value) {
						assertType<Equals<typeof selection, number | string>>();
						assertType<Equals<typeof value, string | number>>();
						return selection;
					}
				)
				.otherwise(String);
			expect(result).toBe('A');
			const unknownValue = matchWith({ a: '2' } as unknown)
				.with({ a: active(Number) }, function (n, value) {
					assertType<Equals<typeof n, number>>();
					assertType<Equals<typeof value, { a: unknown }>>();
					return n;
				})
				.otherwise(String);
			expect(unknownValue).toBe(2);
		});

		it('captures nothing from a part of a pattern typed any', function () {
			const loose: any = 'x';
			const partial = matchWith({ a: 'x', b: 2 } as { a: 'x' | 'y'; b: number }).with({ a: loose, b: capture() }, function (b) {
				assertType<Equals<typeof b, number>>();
				return b;
			});
			assertType<Equals<typeof partial.exhaustive, NonExhaustiveError<{ a: 'x' | 'y'; b: number }>>>();
			expect(partial.otherwise(String)).toBe(2);
		});
	});
});

describe('Functions helpers (1.4)', function () {
	describe('ok / err', function () {
		it('build the tuples attempt returns', function () {
			expect(helpers.ok(1)).toEqual([undefined, 1]);
			expect(helpers.ok(undefined)).toEqual([undefined, undefined]);
			expect(helpers.ok(1)).toHaveLength(2);
			const error = new Error('x');
			expect(helpers.err(error)).toEqual([error, undefined]);
			expect(helpers.err(error)[0]).toBe(error);
			expect(helpers.err(null)).toEqual([null, undefined]);
			expect(helpers.err(0)).toEqual([0, undefined]);
			expect(helpers.err(error)).toHaveLength(2);
			expect(helpers.ok(1)).toEqual(helpers.attempt(helpers.constant(1)));
		});

		it('err rejects an undefined error, which would read as a success', function () {
			expect(function () {
				helpers.err(undefined);
			}).toThrow(new TypeError('err: `error` must not be undefined (an undefined error reads as a success), got undefined'));
		});
	});

	describe('isOk / isErr', function () {
		it('tell successes from failures like attempt does', function () {
			expect(helpers.isOk(helpers.ok(1))).toBe(true);
			expect(helpers.isErr(helpers.ok(1))).toBe(false);
			expect(helpers.isOk(helpers.err('x'))).toBe(false);
			expect(helpers.isErr(helpers.err('x'))).toBe(true);
			expect(helpers.isErr(helpers.err(null))).toBe(true);
			expect(helpers.isOk(helpers.attempt(JSON.parse, '{'))).toBe(false);
			// `throw undefined` is captured as [undefined, undefined]: a successful `undefined`.
			const thrownUndefined = helpers.attempt(function (): never {
				throw undefined;
			});
			expect(helpers.isOk(thrownUndefined)).toBe(true);
			expect(helpers.isErr(thrownUndefined)).toBe(false);
		});

		it.each([
			['isOk', helpers.isOk],
			['isErr', helpers.isErr],
			['unwrap', helpers.unwrap]
		] as const)('%s validates the tuple', function (name, check) {
			expect(function () {
				check(null as never);
			}).toThrow(new TypeError(`${name}: \`result\` must be an [error, result] tuple, got null`));
			expect(function () {
				check([undefined] as never);
			}).toThrow(new TypeError(`${name}: \`result\` must be an [error, result] tuple, got an array of length 1`));
			expect(function () {
				check([undefined, 1, 2] as never);
			}).toThrow(new TypeError(`${name}: \`result\` must be an [error, result] tuple, got an array of length 3`));
			expect(function () {
				check({ 0: undefined, 1: 1, length: 2 } as never);
			}).toThrow(new TypeError(`${name}: \`result\` must be an [error, result] tuple, got object`));
		});
	});

	describe('mapResult', function () {
		it('transforms successes and returns failures as they are', function () {
			const double = jest.fn(function (n: number): number {
				return n * 2;
			});
			expect(helpers.mapResult(helpers.ok(21), double)).toEqual([undefined, 42]);
			expect(double).toHaveBeenCalledWith(21);
			const failed = helpers.err(new Error('x'));
			expect(helpers.mapResult(failed, double)).toBe(failed);
			expect(double).toHaveBeenCalledTimes(1);
			const success = helpers.ok(1);
			expect(helpers.mapResult(success, helpers.identity)).not.toBe(success);
		});

		it('does not capture what fn throws', function () {
			expect(function () {
				helpers.mapResult(helpers.ok(1), function (): never {
					throw new RangeError('boom');
				});
			}).toThrow(new RangeError('boom'));
		});

		it('validates its arguments', function () {
			expect(function () {
				helpers.mapResult(helpers.ok(1), 1 as never);
			}).toThrow(new TypeError('mapResult: `fn` must be a function, got number'));
			expect(function () {
				helpers.mapResult(1 as never, helpers.identity);
			}).toThrow(new TypeError('mapResult: `result` must be an [error, result] tuple, got number'));
			expect(function () {
				helpers.mapResult(helpers.err(1), 1 as never);
			}).toThrow(new TypeError('mapResult: `fn` must be a function, got number'));
		});
	});

	describe('unwrap', function () {
		it('returns the value or rethrows the very error', function () {
			expect(helpers.unwrap(helpers.ok('x'))).toBe('x');
			expect(helpers.unwrap(helpers.ok(undefined))).toBeUndefined();
			const error = { not: 'an error' };
			let caught: unknown;
			try {
				helpers.unwrap(helpers.err(error));
			} catch (thrown) {
				caught = thrown;
			}
			expect(caught).toBe(error);
			expect(function () {
				helpers.unwrap(helpers.attempt(JSON.parse, '{'));
			}).toThrow(SyntaxError);
			expect(function () {
				helpers.unwrap(helpers.err(null));
			}).toThrow();
		});
	});

	describe('when / unless', function () {
		it('apply fn only when the predicate passes (when) or fails (unless)', function () {
			const isNegative = jest.fn(function (n: number): boolean {
				return n < 0;
			});
			const negate = jest.fn(function (n: number): number {
				return -n;
			});
			const abs = helpers.when(isNegative, negate);
			expect([3, -2, 0].map(abs)).toEqual([3, 2, 0]);
			expect(isNegative).toHaveBeenCalledTimes(3);
			expect(negate).toHaveBeenCalledTimes(1);
			expect(isNegative).toHaveBeenNthCalledWith(1, 3);
			const keepNegative = helpers.unless(isNegative, helpers.constant(0));
			expect([3, -2, 0].map(keepNegative)).toEqual([0, -2, 0]);
		});

		it('pass only the first argument and forward this', function () {
			const seen: unknown[][] = [];
			const target = { factor: 3 };
			const scale = helpers.when(
				function (this: unknown, ...args: unknown[]): boolean {
					seen.push([this, ...args]);
					return true;
				},
				function (this: { factor: number }, n: number, ...rest: unknown[]): number {
					seen.push([this, n, ...rest]);
					return n * this.factor;
				}
			);
			expect((scale as (this: unknown, ...args: unknown[]) => unknown).call(target, 2, 'extra')).toBe(6);
			expect(seen).toEqual([
				[target, 2],
				[target, 2]
			]);
			const kept = helpers.unless(
				function (this: unknown): boolean {
					seen.push([this]);
					return false;
				},
				function (this: unknown, value: unknown): unknown[] {
					return [this, value];
				}
			);
			expect(kept.call(target, 'v')).toEqual([target, 'v']);
		});

		it('treat the predicate result as truthy or falsy', function () {
			const tag = helpers.when(helpers.identity, function (value: unknown): string {
				return `tagged ${String(value)}`;
			});
			expect([0, '', null, 1, 'a'].map(tag)).toEqual([0, '', null, 'tagged 1', 'tagged a']);
			const fill = helpers.unless(helpers.identity, helpers.constant('default'));
			expect([0, '', null, 1, 'a'].map(fill)).toEqual(['default', 'default', 'default', 1, 'a']);
		});

		it('narrow with type guards', function () {
			const trim = helpers.when(isString, function (text: string): string {
				return text.trim();
			});
			const trimmed: string | number = trim(' a ' as string | number);
			expect(trimmed).toBe('a');
			const wrap = helpers.unless(isString, function (value: unknown): string {
				return String(value);
			});
			const wrapped: string = wrap(5 as string | number);
			expect(wrapped).toBe('5');
		});

		it.each([
			['when', helpers.when],
			['unless', helpers.unless]
		] as const)('%s validates its arguments', function (name, create) {
			expect(function () {
				create(1 as never, helpers.identity);
			}).toThrow(new TypeError(`${name}: \`predicate\` must be a function, got number`));
			expect(function () {
				create(helpers.identity, null as never);
			}).toThrow(new TypeError(`${name}: \`fn\` must be a function, got null`));
		});
	});

	describe('cond', function () {
		it('returns the transform of the first matching pair, or undefined', function () {
			const calls: string[] = [];
			const classify = helpers.cond([
				[
					function (n: number): boolean {
						calls.push(`neg ${n}`);
						return n < 0;
					},
					function (n: number): string {
						return `negative ${n}`;
					}
				],
				[
					function (n: number): boolean {
						calls.push(`zero ${n}`);
						return n === 0;
					},
					helpers.constant('zero')
				],
				[
					function (n: number): boolean {
						calls.push(`even ${n}`);
						return n % 2 === 0;
					},
					helpers.constant('even')
				]
			]);
			expect(classify(-1)).toBe('negative -1');
			expect(calls).toEqual(['neg -1']);
			expect(classify(0)).toBe('zero');
			expect(classify(4)).toBe('even');
			expect(classify(3)).toBeUndefined();
			expect(calls).toEqual(['neg -1', 'neg 0', 'zero 0', 'neg 4', 'zero 4', 'even 4', 'neg 3', 'zero 3', 'even 3']);
			expect(helpers.cond([])(1)).toBeUndefined();
			expect(helpers.cond([])()).toBeUndefined();
		});

		it('passes every argument and this to both functions', function () {
			const target = { name: 'target' };
			const record: unknown[][] = [];
			/**
			 * Records its call and passes.
			 */
			function pass(this: unknown, ...args: unknown[]): boolean {
				record.push(['predicate', this, ...args]);
				return true;
			}
			/**
			 * Records its call.
			 */
			function transform(this: unknown, ...args: unknown[]): string {
				record.push(['transform', this, ...args]);
				return 'done';
			}
			const both = helpers.cond([[pass, transform]]);
			expect(both.call(target, 1, 2, 3)).toBe('done');
			expect(both.call(target)).toBe('done');
			expect(both.call(target, 'one')).toBe('done');
			expect(both.call(target, 'a', 'b')).toBe('done');
			expect(both.call(target, 1, 2, 3, 4)).toBe('done');
			expect(record).toEqual([
				['predicate', target, 1, 2, 3],
				['transform', target, 1, 2, 3],
				['predicate', target],
				['transform', target],
				['predicate', target, 'one'],
				['transform', target, 'one'],
				['predicate', target, 'a', 'b'],
				['transform', target, 'a', 'b'],
				['predicate', target, 1, 2, 3, 4],
				['transform', target, 1, 2, 3, 4]
			]);
			const later = helpers.cond([
				[helpers.constant(false), transform],
				[pass, transform]
			]);
			record.length = 0;
			for (const args of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) expect(later.apply(target, args)).toBe('done');
			expect(record.length).toBe(10);
			const none = helpers.cond([[helpers.constant(false), transform]]);
			expect(none(1, 2)).toBeUndefined();
			expect(none()).toBeUndefined();
			const second = helpers.cond([
				[helpers.constant(false), transform],
				[
					function (a: number, b: number): boolean {
						return a < b;
					},
					function (a: number, b: number): number {
						return b - a;
					}
				]
			]);
			expect(second(1, 3)).toBe(2);
			expect((second as (...args: unknown[]) => unknown)(1)).toBeUndefined();
		});

		it('copies the pairs when created', function () {
			const pairs: Array<[(n: number) => boolean, (n: number) => string]> = [[helpers.constant(true), helpers.constant('first')]];
			const pick = helpers.cond(pairs);
			pairs[0] = [helpers.constant(true), helpers.constant('changed')];
			pairs.unshift([helpers.constant(true), helpers.constant('added')]);
			expect(pick(1)).toBe('first');
		});

		it('reads each function of a pair once, storing the one it validated (regression)', function () {
			const reads: string[] = [];
			const pair = [helpers.constant(true), helpers.constant('kept')] as unknown as [() => boolean, () => string];
			for (const index of [0, 1]) {
				const valid = pair[index];
				Object.defineProperty(pair, index, {
					get: function (): unknown {
						reads.push(String(index));
						return reads.filter(function (read) {
							return read === String(index);
						}).length === 1
							? valid
							: 'not a function';
					}
				});
			}
			const pick = helpers.cond([pair]);
			expect(reads).toEqual(['0', '1']);
			expect(pick()).toBe('kept');
		});

		it('validates the pairs', function () {
			expect(function () {
				helpers.cond(null as never);
			}).toThrow(new TypeError('cond: `pairs` must be an array, got null'));
			expect(function () {
				helpers.cond([helpers.identity] as never);
			}).toThrow(new TypeError('cond: `pairs[0]` must be a [predicate, transform] pair, got function'));
			expect(function () {
				helpers.cond([
					[helpers.identity, helpers.identity],
					[1, helpers.identity]
				] as never);
			}).toThrow(new TypeError('cond: `pairs[1][0]` must be a function, got number'));
			expect(function () {
				helpers.cond([[helpers.identity]] as never);
			}).toThrow(new TypeError('cond: `pairs[0][1]` must be a function, got undefined'));
		});
	});
});

/** Runs a garbage collection, once the values a test released are no longer referenced by its stack. */
async function collectGarbage(): Promise<void> {
	setFlagsFromString('--expose-gc');
	const gc = vm.runInNewContext('gc') as () => void;
	// `setImmediate`, not `setTimeout`: a spy restored after a test with fake timers can leave the fake `setTimeout` behind.
	await new Promise(function (resolve) {
		setImmediate(resolve);
	});
	gc();
}
