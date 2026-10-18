import { AssertionError } from '../guards/index.js';
import { allPass, anyPass, match, partialRight } from '.';
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
				const preArgs = Array.from({ length: pre }, function (_, i) {
					return `p${i}`;
				});
				const restArgs = Array.from({ length: rest }, function (_, i) {
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
			const args = Array.from({ length: count }, function (_, i) {
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
			// A plain predicate in allPass adds nothing, and the input type is what every predicate accepts.
			const shortString = allPass(isString, function (value: string) {
				return value.length < 2;
			});
			assertType<Equals<Parameters<typeof shortString>[0], string>>();
			const words: string[] = ['a', 'bc'];
			expect(words.filter(shortString)).toEqual(['a']);
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
		type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; size: number } | { kind: 'rect'; width: number; height: number };

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
