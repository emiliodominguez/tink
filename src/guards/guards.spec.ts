import * as vm from 'vm';
import * as guards from '.';

const foreign = vm.runInNewContext(`({
	date: new Date(0),
	regexp: /a/g,
	error: new TypeError('x'),
	map: new Map([[1, 2]]),
	set: new Set([1]),
	weakMap: new WeakMap(),
	weakSet: new WeakSet(),
	array: [1, 2],
	object: { a: 1 },
	promise: Promise.resolve(1)
})`);

function noop(): void {}

describe('guards', function () {
	describe('isObject', function () {
		it('accepts non-null objects (incl. arrays, dates, boxed values)', function () {
			expect(guards.isObject({ a: 1 })).toBe(true);
			expect(guards.isObject([])).toBe(true);
			expect(guards.isObject(new Date())).toBe(true);
			expect(guards.isObject(Object.create(null))).toBe(true);
			expect(guards.isObject(new Number(1))).toBe(true);
		});

		it('rejects functions, primitives and null', function () {
			expect(guards.isObject(noop)).toBe(false);
			expect(guards.isObject(class {})).toBe(false);
			expect(guards.isObject(1)).toBe(false);
			expect(guards.isObject('string')).toBe(false);
			expect(guards.isObject(null)).toBe(false);
			expect(guards.isObject(undefined)).toBe(false);
		});

		it('narrows unknown to object', function () {
			const value: unknown = { a: 1 };
			if (guards.isObject(value)) {
				const narrowed: object = value;
				expect(Object.keys(narrowed)).toEqual(['a']);
			}
		});
	});

	describe('isArray', function () {
		it('accepts arrays, including cross-realm ones', function () {
			expect(guards.isArray([1, 2, 3])).toBe(true);
			expect(guards.isArray([])).toBe(true);
			expect(guards.isArray(foreign.array)).toBe(true);
		});

		it('rejects array-likes and other values', function () {
			expect(guards.isArray({ length: 0 })).toBe(false);
			expect(guards.isArray('string')).toBe(false);
			expect(guards.isArray(new Uint8Array(1))).toBe(false);
			expect(guards.isArray(null)).toBe(false);
			expect(guards.isArray(undefined)).toBe(false);
		});

		it('narrows to unknown[]', function () {
			const value: unknown = [1, 2];
			expect(guards.isArray(value) ? value.length : -1).toBe(2);
		});
	});

	describe('isFunction', function () {
		it('accepts every kind of function', function () {
			expect(guards.isFunction(noop)).toBe(true);
			expect(guards.isFunction(class {})).toBe(true);
			expect(guards.isFunction(async function () {})).toBe(true);
			expect(guards.isFunction(function* () {})).toBe(true);
		});

		it('rejects non-functions', function () {
			expect(guards.isFunction({ a: 1 })).toBe(false);
			expect(guards.isFunction(1)).toBe(false);
			expect(guards.isFunction(null)).toBe(false);
			expect(guards.isFunction(undefined)).toBe(false);
		});
	});

	describe('isString', function () {
		it('accepts primitive strings incl. empty and unicode', function () {
			expect(guards.isString('hello')).toBe(true);
			expect(guards.isString('')).toBe(true);
			expect(guards.isString('😀')).toBe(true);
		});

		it('rejects everything else, including boxed strings', function () {
			expect(guards.isString(new String('a'))).toBe(false);
			expect(guards.isString(123)).toBe(false);
			expect(guards.isString([])).toBe(false);
			expect(guards.isString(null)).toBe(false);
		});

		it('narrows to string', function () {
			const value: unknown = 'abc';
			expect(guards.isString(value) ? value.toUpperCase() : '').toBe('ABC');
		});
	});

	describe('isNumber', function () {
		it('accepts all numbers, NaN and Infinity included', function () {
			expect(guards.isNumber(123)).toBe(true);
			expect(guards.isNumber(-0)).toBe(true);
			expect(guards.isNumber(NaN)).toBe(true);
			expect(guards.isNumber(-Infinity)).toBe(true);
		});

		it('rejects non-numbers', function () {
			expect(guards.isNumber('1')).toBe(false);
			expect(guards.isNumber(1n)).toBe(false);
			expect(guards.isNumber(new Number(1))).toBe(false);
			expect(guards.isNumber(null)).toBe(false);
		});
	});

	describe('isBoolean', function () {
		it('accepts true and false only', function () {
			expect(guards.isBoolean(true)).toBe(true);
			expect(guards.isBoolean(false)).toBe(true);
			expect(guards.isBoolean(0)).toBe(false);
			expect(guards.isBoolean('true')).toBe(false);
			expect(guards.isBoolean(new Boolean(true))).toBe(false);
		});
	});

	describe('isUndefined / isNull / isNil / isDefined', function () {
		it('isUndefined', function () {
			expect(guards.isUndefined(undefined)).toBe(true);
			expect(guards.isUndefined(void 0)).toBe(true);
			expect(guards.isUndefined(null)).toBe(false);
			expect(guards.isUndefined(0)).toBe(false);
		});

		it('isNull', function () {
			expect(guards.isNull(null)).toBe(true);
			expect(guards.isNull(undefined)).toBe(false);
			expect(guards.isNull(0)).toBe(false);
			expect(guards.isNull('')).toBe(false);
		});

		it('isNil', function () {
			expect(guards.isNil(null)).toBe(true);
			expect(guards.isNil(undefined)).toBe(true);
			expect(guards.isNil(0)).toBe(false);
			expect(guards.isNil('')).toBe(false);
			expect(guards.isNil(false)).toBe(false);
		});

		it('isDefined filters nullish values and narrows the element type', function () {
			const list: Array<number | null | undefined> = [1, null, 0, undefined, 2];
			const defined: number[] = list.filter(guards.isDefined);
			expect(defined).toEqual([1, 0, 2]);
			expect(guards.isDefined(NaN)).toBe(true);
			expect(guards.isDefined(null)).toBe(false);
		});
	});

	describe('isSymbol / isBigInt', function () {
		it('isSymbol', function () {
			expect(guards.isSymbol(Symbol('test'))).toBe(true);
			expect(guards.isSymbol(Symbol.iterator)).toBe(true);
			expect(guards.isSymbol('symbol')).toBe(false);
			expect(guards.isSymbol(Object(Symbol('x')))).toBe(false);
		});

		it('isBigInt', function () {
			expect(guards.isBigInt(0n)).toBe(true);
			expect(guards.isBigInt(BigInt(10))).toBe(true);
			expect(guards.isBigInt(10)).toBe(false);
			expect(guards.isBigInt('10')).toBe(false);
		});
	});

	describe('isPromise', function () {
		it('accepts native promises (incl. cross-realm) and thenables', function () {
			expect(guards.isPromise(Promise.resolve())).toBe(true);
			// Any native promise counts, even one whose `then` was shadowed.
			expect(guards.isPromise(Object.defineProperty(Promise.resolve(), 'then', { value: undefined }))).toBe(true);
			expect(guards.isPromise(foreign.promise)).toBe(true);
			expect(guards.isPromise({ then: noop })).toBe(true);
			const thenableFunction = Object.assign(function () {}, { then: noop });
			expect(guards.isPromise(thenableFunction)).toBe(true);
		});

		it('rejects non-thenables', function () {
			expect(guards.isPromise(undefined)).toBe(false);
			expect(guards.isPromise(0)).toBe(false);
			expect(guards.isPromise('')).toBe(false);
			expect(guards.isPromise({})).toBe(false);
			expect(guards.isPromise({ then: 1 })).toBe(false);
			expect(guards.isPromise(noop)).toBe(false);
		});

		it('narrows to PromiseLike', async function () {
			const value: unknown = Promise.resolve(3);
			if (guards.isPromise(value)) await expect(value).resolves.toBe(3);
		});
	});

	describe('isRegExp', function () {
		it('accepts regexps, including cross-realm ones', function () {
			expect(guards.isRegExp(/regex/)).toBe(true);
			expect(guards.isRegExp(new RegExp('a', 'g'))).toBe(true);
			expect(guards.isRegExp(foreign.regexp)).toBe(true);
		});

		it('rejects non-regexps and fakes', function () {
			expect(guards.isRegExp('/a/')).toBe(false);
			expect(guards.isRegExp({})).toBe(false);
			expect(guards.isRegExp({ [Symbol.toStringTag]: 'RegExp' })).toBe(false);
			expect(guards.isRegExp(undefined)).toBe(false);
		});
	});

	describe('isError', function () {
		it('accepts errors and subclasses, including cross-realm ones', function () {
			expect(guards.isError(new Error('error'))).toBe(true);
			expect(guards.isError(new RangeError('error'))).toBe(true);
			expect(guards.isError(foreign.error)).toBe(true);
		});

		it('rejects error-like objects', function () {
			expect(guards.isError({ name: 'Error', message: 'x' })).toBe(false);
			expect(guards.isError('Error')).toBe(false);
			expect(guards.isError(undefined)).toBe(false);
		});

		it('only falls back to the brand check for cross-realm and null-prototype objects', function () {
			// Same-realm objects are decided by `instanceof`, like the built-in guards: fake tags and re-parented errors are rejected...
			expect(guards.isError({ [Symbol.toStringTag]: 'Error' })).toBe(false);
			expect(guards.isError(Object.setPrototypeOf(new Error('x'), Object.prototype))).toBe(false);
			// ...while null-prototype and cross-realm objects get the brand check, `Error.isError`, which a fake tag cannot pass.
			expect(typeof (Error as { isError?: unknown }).isError).toBe('function');
			expect(guards.isError(Object.setPrototypeOf(new Error('x'), null))).toBe(true);
			expect(guards.isError(Object.setPrototypeOf({}, null))).toBe(false);
			expect(guards.isError(vm.runInNewContext('({ [Symbol.toStringTag]: "Error" })'))).toBe(false);
			expect(guards.isError(Object.setPrototypeOf({ [Symbol.toStringTag]: 'Error' }, null))).toBe(false);
			expect(guards.getType(vm.runInNewContext('({ [Symbol.toStringTag]: "Error" })'))).toBe('object');
		});

		it('falls back to the toString tag in runtimes without Error.isError', function () {
			const descriptor = Object.getOwnPropertyDescriptor(Error, 'isError') as PropertyDescriptor;
			delete (Error as { isError?: unknown }).isError;
			try {
				expect(guards.isError(Object.setPrototypeOf(new Error('x'), null))).toBe(true);
				expect(guards.isError(Object.setPrototypeOf({}, null))).toBe(false);
				expect(guards.isError(foreign.error)).toBe(true);
				// The tag is all there is to go by then.
				expect(guards.isError(vm.runInNewContext('({ [Symbol.toStringTag]: "Error" })'))).toBe(true);
			} finally {
				Object.defineProperty(Error, 'isError', descriptor);
			}
		});
	});

	describe('isDate', function () {
		it('accepts dates (valid or not), including cross-realm ones', function () {
			expect(guards.isDate(new Date())).toBe(true);
			expect(guards.isDate(new Date('invalid'))).toBe(true);
			expect(guards.isDate(foreign.date)).toBe(true);
		});

		it('rejects timestamps, strings and fakes', function () {
			expect(guards.isDate(Date.now())).toBe(false);
			expect(guards.isDate('2020-01-01')).toBe(false);
			expect(guards.isDate({ [Symbol.toStringTag]: 'Date' })).toBe(false);
			expect(guards.isDate(null)).toBe(false);
		});
	});

	describe('isMap / isSet / isWeakMap / isWeakSet', function () {
		it('isMap', function () {
			expect(guards.isMap(new Map())).toBe(true);
			expect(guards.isMap(foreign.map)).toBe(true);
			expect(guards.isMap(new WeakMap())).toBe(false);
			expect(guards.isMap({ [Symbol.toStringTag]: 'Map' })).toBe(false);
			expect(guards.isMap({})).toBe(false);
			expect(guards.isMap(undefined)).toBe(false);
		});

		it('isSet', function () {
			expect(guards.isSet(new Set())).toBe(true);
			expect(guards.isSet(foreign.set)).toBe(true);
			expect(guards.isSet(new WeakSet())).toBe(false);
			expect(guards.isSet({ [Symbol.toStringTag]: 'Set' })).toBe(false);
			expect(guards.isSet([])).toBe(false);
		});

		it('isWeakMap', function () {
			expect(guards.isWeakMap(new WeakMap())).toBe(true);
			expect(guards.isWeakMap(foreign.weakMap)).toBe(true);
			expect(guards.isWeakMap(new Map())).toBe(false);
			expect(guards.isWeakMap({ [Symbol.toStringTag]: 'WeakMap' })).toBe(false);
			expect(guards.isWeakMap('')).toBe(false);
		});

		it('isWeakSet', function () {
			expect(guards.isWeakSet(new WeakSet())).toBe(true);
			expect(guards.isWeakSet(foreign.weakSet)).toBe(true);
			expect(guards.isWeakSet(new Set())).toBe(false);
			expect(guards.isWeakSet({ [Symbol.toStringTag]: 'WeakSet' })).toBe(false);
			expect(guards.isWeakSet(0)).toBe(false);
		});

		it('reject objects of this realm outside the prototype chain without a brand check, but check null-prototype objects', function () {
			const brands: Array<[(value: unknown) => boolean, () => object]> = [
				[
					guards.isDate,
					function () {
						return new Date(0);
					}
				],
				[
					guards.isRegExp,
					function () {
						return /a/;
					}
				],
				[
					guards.isMap,
					function () {
						return new Map();
					}
				],
				[
					guards.isSet,
					function () {
						return new Set();
					}
				],
				[
					guards.isWeakMap,
					function () {
						return new WeakMap();
					}
				],
				[
					guards.isWeakSet,
					function () {
						return new WeakSet();
					}
				]
			];
			const revoked = Proxy.revocable({}, {});
			revoked.revoke();

			brands.forEach(function ([guard, create]) {
				// A genuine instance re-parented to an unrelated prototype of this realm is rejected by the `instanceof` fast path...
				expect(guard(Object.setPrototypeOf(create(), Object.prototype))).toBe(false);
				// ...while one with a null prototype still gets the brand check.
				expect(guard(Object.setPrototypeOf(create(), null))).toBe(true);
				expect(guard(revoked.proxy)).toBe(false);
				expect(guard(Object.create(Object.getPrototypeOf(create())))).toBe(false);
			});
			expect(guards.isArrayBuffer(revoked.proxy)).toBe(false);
			expect(guards.isArrayBuffer(Object.setPrototypeOf(new ArrayBuffer(1), Object.prototype))).toBe(true);
		});
	});

	describe('isPlainObject', function () {
		it('accepts literals, null-prototype objects and JSON output', function () {
			expect(guards.isPlainObject({})).toBe(true);
			expect(guards.isPlainObject({ a: { b: 1 } })).toBe(true);
			expect(guards.isPlainObject(Object.create(null))).toBe(true);
			expect(guards.isPlainObject(JSON.parse('{"a":1}'))).toBe(true);
		});

		it('rejects arrays, class instances, built-ins, cross-realm objects and primitives', function () {
			class Point {
				x = 1;
			}
			expect(guards.isPlainObject([])).toBe(false);
			expect(guards.isPlainObject(new Point())).toBe(false);
			expect(guards.isPlainObject(Object.create({}))).toBe(false);
			expect(guards.isPlainObject(new Date())).toBe(false);
			expect(guards.isPlainObject(new Map())).toBe(false);
			expect(guards.isPlainObject(foreign.object)).toBe(false);
			expect(guards.isPlainObject(noop)).toBe(false);
			expect(guards.isPlainObject(null)).toBe(false);
			expect(guards.isPlainObject('a')).toBe(false);
		});

		it('narrows to a record', function () {
			const value: unknown = { a: 1 };
			expect(guards.isPlainObject(value) ? value.a : undefined).toBe(1);
		});
	});

	describe('isPrimitive', function () {
		it('accepts every primitive', function () {
			for (const value of ['a', 1, NaN, 1n, true, Symbol('s'), null, undefined]) {
				expect(guards.isPrimitive(value)).toBe(true);
			}
		});

		it('rejects objects and functions', function () {
			expect(guards.isPrimitive({})).toBe(false);
			expect(guards.isPrimitive([])).toBe(false);
			expect(guards.isPrimitive(new String('a'))).toBe(false);
			expect(guards.isPrimitive(noop)).toBe(false);
		});
	});

	describe('isIterable / isAsyncIterable', function () {
		it('returns false instead of throwing for revoked proxies and throwing getters', function () {
			const { proxy, revoke } = Proxy.revocable({}, {});
			revoke();
			const throwing = Object.defineProperties(
				{},
				{
					[Symbol.iterator]: {
						get: function () {
							throw new Error('no');
						}
					},
					[Symbol.asyncIterator]: {
						get: function () {
							throw new Error('no');
						}
					}
				}
			);
			expect([guards.isIterable(proxy), guards.isAsyncIterable(proxy), guards.isIterable(throwing), guards.isAsyncIterable(throwing)]).toEqual([
				false,
				false,
				false,
				false
			]);
		});

		it('isIterable accepts strings, arrays, maps, sets, generators and custom iterables', function () {
			expect(guards.isIterable('abc')).toBe(true);
			expect(guards.isIterable('')).toBe(true);
			expect(guards.isIterable([1])).toBe(true);
			expect(guards.isIterable(new Map())).toBe(true);
			expect(guards.isIterable(new Set())).toBe(true);
			expect(guards.isIterable((function* () {})())).toBe(true);
			expect(guards.isIterable({ [Symbol.iterator]: noop })).toBe(true);
		});

		it('isIterable rejects non-iterables', function () {
			expect(guards.isIterable({})).toBe(false);
			expect(guards.isIterable({ [Symbol.iterator]: 1 })).toBe(false);
			expect(guards.isIterable(1)).toBe(false);
			expect(guards.isIterable(null)).toBe(false);
			expect(guards.isIterable(undefined)).toBe(false);
		});

		it('isAsyncIterable', function () {
			expect(guards.isAsyncIterable((async function* () {})())).toBe(true);
			expect(guards.isAsyncIterable({ [Symbol.asyncIterator]: noop })).toBe(true);
			expect(guards.isAsyncIterable([1])).toBe(false);
			expect(guards.isAsyncIterable('abc')).toBe(false);
			expect(guards.isAsyncIterable(null)).toBe(false);
			expect(guards.isAsyncIterable(undefined)).toBe(false);
		});
	});

	describe('isFiniteNumber / isInteger', function () {
		it('isFiniteNumber', function () {
			expect(guards.isFiniteNumber(0)).toBe(true);
			expect(guards.isFiniteNumber(-1.5)).toBe(true);
			expect(guards.isFiniteNumber(NaN)).toBe(false);
			expect(guards.isFiniteNumber(Infinity)).toBe(false);
			expect(guards.isFiniteNumber('1')).toBe(false);
		});

		it('isInteger', function () {
			expect(guards.isInteger(3)).toBe(true);
			expect(guards.isInteger(-0)).toBe(true);
			expect(guards.isInteger(1e21)).toBe(true);
			expect(guards.isInteger(3.5)).toBe(false);
			expect(guards.isInteger(NaN)).toBe(false);
			expect(guards.isInteger(Infinity)).toBe(false);
			expect(guards.isInteger(3n)).toBe(false);
			expect(guards.isInteger('3')).toBe(false);
		});
	});

	describe('regressions (round 2)', function () {
		it('built-in guards reject objects that only inherit from the built-in prototype (no internal slots)', function () {
			expect(guards.isDate(Object.create(Date.prototype))).toBe(false);
			expect(guards.isRegExp(Object.create(RegExp.prototype))).toBe(false);
			expect(guards.isMap(Object.create(Map.prototype))).toBe(false);
			expect(guards.isSet(Object.create(Set.prototype))).toBe(false);
			expect(guards.isWeakMap(Object.create(WeakMap.prototype))).toBe(false);
			expect(guards.isWeakSet(Object.create(WeakSet.prototype))).toBe(false);
			expect(guards.isRegExp(RegExp.prototype)).toBe(false);
			expect(guards.isDate(Date.prototype)).toBe(false);
		});

		it('built-in guards reject proxies, whose methods would throw on use', function () {
			expect(guards.isMap(new Proxy(new Map(), {}))).toBe(false);
			expect(guards.isSet(new Proxy(new Set(), {}))).toBe(false);
			expect(guards.isDate(new Proxy(new Date(), {}))).toBe(false);
		});

		it('still accepts subclasses, cross-realm instances and instances with a custom toStringTag', function () {
			class MyMap extends Map<unknown, unknown> {}
			class MyDate extends Date {}
			const tagged = new Date(0);

			Object.defineProperty(tagged, Symbol.toStringTag, { value: 'Other' });
			expect(guards.isMap(new MyMap())).toBe(true);
			expect(guards.isDate(new MyDate())).toBe(true);
			expect(guards.isDate(tagged)).toBe(true);
			expect(guards.isDate(foreign.date)).toBe(true);
			expect(guards.isRegExp(foreign.regexp)).toBe(true);
			expect(guards.isMap(foreign.map)).toBe(true);
		});
	});

	describe('isNonEmptyString', function () {
		it('accepts primitive strings with at least one code unit', function () {
			expect(guards.isNonEmptyString('a')).toBe(true);
			expect(guards.isNonEmptyString(' ')).toBe(true);
			expect(guards.isNonEmptyString('😀')).toBe(true);
			expect(guards.isNonEmptyString('')).toBe(false);
			expect(guards.isNonEmptyString(new String('a'))).toBe(false);
			expect(guards.isNonEmptyString(['a'])).toBe(false);
			expect(guards.isNonEmptyString(null)).toBe(false);
		});
	});

	describe('isNonEmptyArray', function () {
		it('accepts arrays with at least one slot', function () {
			expect(guards.isNonEmptyArray([1])).toBe(true);
			expect(guards.isNonEmptyArray([undefined])).toBe(true);
			expect(guards.isNonEmptyArray(new Array(3))).toBe(true);
			expect(guards.isNonEmptyArray(foreign.array)).toBe(true);
			expect(guards.isNonEmptyArray([])).toBe(false);
			expect(guards.isNonEmptyArray('ab')).toBe(false);
			expect(guards.isNonEmptyArray({ length: 1, 0: 'a' })).toBe(false);
			expect(guards.isNonEmptyArray(null)).toBe(false);
			expect(guards.isNonEmptyArray(undefined)).toBe(false);
		});

		it('narrows to a non-empty tuple, keeping the element type and readonly-ness', function () {
			const mutable: number[] | undefined = [1, 2];
			const frozen: ReadonlyArray<string> = ['a'];
			const unknownValue: unknown = [true];

			if (guards.isNonEmptyArray(mutable)) {
				const first: number = mutable[0];
				const tuple: [number, ...number[]] = mutable;

				expect([first, tuple.length]).toEqual([1, 2]);
			}
			if (guards.isNonEmptyArray(frozen)) {
				const first: string = frozen[0];
				const tuple: readonly [string, ...string[]] = frozen;

				expect([first, tuple.length]).toEqual(['a', 1]);
			}
			if (guards.isNonEmptyArray(unknownValue)) {
				const tuple: [unknown, ...unknown[]] = unknownValue;

				expect(tuple[0]).toBe(true);
			}
		});
	});

	describe('isKeyOf', function () {
		const colors = { red: '#f00', blue: '#00f' };

		it('accepts own keys only', function () {
			expect(guards.isKeyOf(colors, 'red')).toBe(true);
			expect(guards.isKeyOf(colors, 'green')).toBe(false);
			expect(guards.isKeyOf(colors, 'toString')).toBe(false);
			expect(guards.isKeyOf(colors, '__proto__')).toBe(false);
			expect(guards.isKeyOf(colors, 'constructor')).toBe(false);
		});

		it('handles numeric, symbol and non-enumerable keys, and null-prototype objects', function () {
			const symbol = Symbol('s');
			const target = Object.create(null) as Record<PropertyKey, unknown>;

			target[symbol] = 1;
			target[0] = 'zero';
			Object.defineProperty(target, 'hidden', { value: true, enumerable: false });
			expect(guards.isKeyOf(target, symbol)).toBe(true);
			expect(guards.isKeyOf(target, 0)).toBe(true);
			expect(guards.isKeyOf(target, '0')).toBe(true);
			expect(guards.isKeyOf(target, 'hidden')).toBe(true);
			expect(guards.isKeyOf(target, Symbol('s'))).toBe(false);
			expect(guards.isKeyOf(['a'], 'length')).toBe(true);
			expect(guards.isKeyOf(['a'], 0)).toBe(true);
			expect(guards.isKeyOf(['a'], 1)).toBe(false);
		});

		it('rejects values that are not property keys', function () {
			expect(guards.isKeyOf(colors, null)).toBe(false);
			expect(guards.isKeyOf(colors, undefined)).toBe(false);
			expect(
				guards.isKeyOf(colors, {
					toString: function () {
						return 'red';
					}
				})
			).toBe(false);
			expect(guards.isKeyOf(colors, true)).toBe(false);
		});

		it('narrows the key to keyof T', function () {
			const key: string = 'blue';

			if (guards.isKeyOf(colors, key)) {
				const narrowed: 'red' | 'blue' = key;

				expect(colors[narrowed]).toBe('#00f');
			}
		});

		it('throws TypeError for a nullish object', function () {
			expect(function () {
				guards.isKeyOf(null as any, 'a');
			}).toThrow(new TypeError('isKeyOf: `object` must not be null or undefined, got null'));
			expect(function () {
				guards.isKeyOf(undefined as any, 'a');
			}).toThrow(new TypeError('isKeyOf: `object` must not be null or undefined, got undefined'));
		});
	});

	describe('isOneOf', function () {
		it('checks membership with SameValueZero and narrows to the literal union', function () {
			const isDirection = guards.isOneOf(['up', 'down']);
			const value: unknown = 'up';

			expect(isDirection('up')).toBe(true);
			expect(isDirection('left')).toBe(false);
			expect(isDirection(new String('up'))).toBe(false);
			if (isDirection(value)) {
				const narrowed: 'up' | 'down' = value;

				expect(narrowed).toBe('up');
			}
			expect(guards.isOneOf([NaN])(NaN)).toBe(true);
			expect(guards.isOneOf([0])(-0)).toBe(true);
			expect(guards.isOneOf([])(undefined)).toBe(false);
			expect(guards.isOneOf([undefined, null])(undefined)).toBe(true);
		});

		it('copies the list, so later mutations do not affect the guard', function () {
			const list = [1, 2];
			const isAllowed = guards.isOneOf(list);

			list.push(3);
			expect(isAllowed(3)).toBe(false);
		});

		it('throws TypeError for non-array lists', function () {
			expect(function () {
				guards.isOneOf('abc' as any);
			}).toThrow(new TypeError('isOneOf: `values` must be an array, got string'));
			expect(function () {
				guards.isOneOf(new Set([1]) as any);
			}).toThrow(TypeError);
		});
	});

	describe('isInstanceOf', function () {
		class Animal {}
		class Dog extends Animal {}

		it('checks instanceof and narrows', function () {
			const isAnimal = guards.isInstanceOf(Animal);
			const value: unknown = new Dog();

			expect(isAnimal(new Animal())).toBe(true);
			expect(isAnimal(value)).toBe(true);
			expect(guards.isInstanceOf(Dog)(new Animal())).toBe(false);
			expect(isAnimal({})).toBe(false);
			expect(isAnimal(null)).toBe(false);
			expect(isAnimal(1)).toBe(false);
			if (isAnimal(value)) {
				const narrowed: Animal = value;

				expect(narrowed).toBeInstanceOf(Dog);
			}
		});

		it('honours Symbol.hasInstance, built-ins and bound functions', function () {
			class Even {
				static [Symbol.hasInstance](value: unknown): boolean {
					return typeof value === 'number' && value % 2 === 0;
				}
			}
			const BoundAnimal = Animal.bind(null);

			expect(guards.isInstanceOf(Even)(4)).toBe(true);
			expect(guards.isInstanceOf(Even)(3)).toBe(false);
			expect(guards.isInstanceOf(Error)(new TypeError('x'))).toBe(true);
			expect(guards.isInstanceOf(BoundAnimal)(new Animal())).toBe(true);
		});

		it('throws TypeError for invalid constructors', function () {
			expect(function () {
				guards.isInstanceOf({} as any);
			}).toThrow(new TypeError('isInstanceOf: `constructor` must be a function, got object'));
			expect(function () {
				guards.isInstanceOf(
					function () {
						return 1;
					}.bind(null) as any
				);
			}).not.toThrow();
			const arrowLike = { method() {} }.method;

			expect(function () {
				guards.isInstanceOf(arrowLike as any);
			}).toThrow(new TypeError('isInstanceOf: `constructor` must be a valid instanceof target, got a function without a prototype'));
		});
	});

	describe('isArrayOf', function () {
		it('checks every element, including the holes of sparse arrays', function () {
			const isStrings = guards.isArrayOf(guards.isString);

			expect(isStrings(['a', 'b'])).toBe(true);
			expect(isStrings([])).toBe(true);
			expect(isStrings(['a', 1])).toBe(false);
			expect(isStrings(new Array(2))).toBe(false);
			expect(guards.isArrayOf(guards.isUndefined)(new Array(2))).toBe(true);
			expect(isStrings('ab')).toBe(false);
			expect(isStrings({ 0: 'a', length: 1 })).toBe(false);
			expect(guards.isArrayOf(guards.isNumber)(foreign.array)).toBe(true);
		});

		it('calls the guard with the element only and narrows to T[]', function () {
			const calls: unknown[][] = [];
			const spy = function (...args: unknown[]): boolean {
				calls.push(args);
				return true;
			} as unknown as (value: unknown) => value is string;
			const value: unknown = ['x'];

			expect(guards.isArrayOf(spy)(['x', 'y'])).toBe(true);
			expect(calls).toEqual([['x'], ['y']]);
			if (guards.isArrayOf(guards.isString)(value)) {
				const narrowed: string[] = value;

				expect(narrowed[0].toUpperCase()).toBe('X');
			}
		});

		it('composes for nested arrays and throws for non-function guards', function () {
			expect(guards.isArrayOf(guards.isArrayOf(guards.isInteger))([[1], [2, 3], []])).toBe(true);
			expect(guards.isArrayOf(guards.isArrayOf(guards.isInteger))([[1], [2.5]])).toBe(false);
			expect(function () {
				guards.isArrayOf('isString' as any);
			}).toThrow(new TypeError('isArrayOf: `guard` must be a function, got string'));
		});
	});

	describe('isRecordOf', function () {
		const isScores = guards.isRecordOf(guards.isFiniteNumber);

		it('accepts plain objects whose own enumerable values all pass', function () {
			const nullProto = Object.create(null);

			nullProto.a = 1;
			expect(isScores({ alice: 3, bob: 5 })).toBe(true);
			expect(isScores({})).toBe(true);
			expect(isScores(nullProto)).toBe(true);
			expect(isScores({ alice: '3' })).toBe(false);
			expect(isScores({ alice: 3, bob: NaN })).toBe(false);
		});

		it('checks symbol keys and ignores non-enumerable properties', function () {
			const withSymbol = { a: 1, [Symbol('s')]: 'x' };
			const withHidden = { a: 1 };

			Object.defineProperty(withHidden, 'hidden', { value: 'x', enumerable: false });
			expect(isScores(withSymbol)).toBe(false);
			expect(isScores(withHidden)).toBe(true);
			// Enumerable symbols are checked, hidden ones are not.
			const symbols = Object.defineProperty({ a: 1, [Symbol('shown')]: 2 }, Symbol('hidden'), { value: 'x', enumerable: false });
			expect(isScores(symbols)).toBe(true);
			expect(guards.explain(isScores, symbols)).toEqual([]);
			expect(guards.explain(isScores, { ...symbols, [Symbol.iterator]: 'x' })).toEqual([{ message: 'Invalid value (got string)', path: [Symbol.iterator] }]);
		});

		it('checks the keys the object had when the check started, once each', function () {
			const seen: unknown[] = [];
			const record = {
				get a(): number {
					// Keys added by a getter are not visited.
					(record as Record<string, unknown>).c = 3;
					(record as Record<PropertyKey, unknown>)[Symbol.for('d')] = 4;
					return 1;
				},
				b: 2
			};
			const isLogged = guards.isRecordOf(function (value: unknown): value is number {
				seen.push(value);
				return typeof value === 'number';
			});
			expect(isLogged(record)).toBe(true);
			expect(seen).toEqual([1, 2]);
		});

		it('rejects non-plain objects', function () {
			expect(isScores([1, 2])).toBe(false);
			expect(isScores(new Map([['a', 1]]))).toBe(false);
			expect(
				isScores(
					new (class {
						a = 1;
					})()
				)
			).toBe(false);
			expect(isScores(null)).toBe(false);
			expect(isScores(1)).toBe(false);
		});

		it('narrows and validates the guard', function () {
			const value: unknown = { a: 'x' };

			if (guards.isRecordOf(guards.isString)(value)) {
				const narrowed: Record<PropertyKey, string> = value;

				expect(narrowed.a.toUpperCase()).toBe('X');
			}
			expect(function () {
				guards.isRecordOf(null as any);
			}).toThrow(new TypeError('isRecordOf: `guard` must be a function, got null'));
		});
	});

	describe('isTypedArray / isArrayBuffer', function () {
		const typedArrays = [
			new Int8Array(1),
			new Uint8Array(1),
			new Uint8ClampedArray(1),
			new Int16Array(1),
			new Uint16Array(1),
			new Int32Array(1),
			new Uint32Array(1),
			new Float32Array(1),
			new Float64Array(1),
			new BigInt64Array(1),
			new BigUint64Array(1)
		];

		it('isTypedArray accepts every typed array (incl. subclasses such as Buffer and other realms)', function () {
			typedArrays.forEach(function (array) {
				expect(guards.isTypedArray(array)).toBe(true);
			});
			expect(guards.isTypedArray(Buffer.from('a'))).toBe(true);
			expect(guards.isTypedArray(vm.runInNewContext('new Uint16Array(2)'))).toBe(true);
		});

		it('isTypedArray rejects DataView, buffers, arrays, fakes and primitives', function () {
			expect(guards.isTypedArray(new DataView(new ArrayBuffer(1)))).toBe(false);
			expect(guards.isTypedArray(new ArrayBuffer(1))).toBe(false);
			expect(guards.isTypedArray([1])).toBe(false);
			expect(guards.isTypedArray(Object.create(Uint8Array.prototype))).toBe(false);
			expect(guards.isTypedArray({ [Symbol.toStringTag]: 'Uint8Array' })).toBe(false);
			expect(guards.isTypedArray(null)).toBe(false);
			expect(guards.isTypedArray('Uint8Array')).toBe(false);
		});

		it('isArrayBuffer accepts real (incl. cross-realm and detached) ArrayBuffers only', function () {
			const detached = new ArrayBuffer(8);

			structuredClone(detached, { transfer: [detached] });
			expect(detached.byteLength).toBe(0);
			expect(guards.isArrayBuffer(new ArrayBuffer(8))).toBe(true);
			expect(guards.isArrayBuffer(new Uint8Array(8).buffer)).toBe(true);
			expect(guards.isArrayBuffer(detached)).toBe(true);
			expect(guards.isArrayBuffer(vm.runInNewContext('new ArrayBuffer(1)'))).toBe(true);
			expect(guards.isArrayBuffer(new SharedArrayBuffer(8))).toBe(false);
			expect(guards.isArrayBuffer(new Uint8Array(8))).toBe(false);
			expect(guards.isArrayBuffer(Object.create(ArrayBuffer.prototype))).toBe(false);
			expect(guards.isArrayBuffer(ArrayBuffer.prototype)).toBe(false);
			expect(guards.isArrayBuffer({ byteLength: 8 })).toBe(false);
			expect(guards.isArrayBuffer(null)).toBe(false);
		});
	});

	describe('assertions', function () {
		it('AssertionError is an Error with its own name', function () {
			const error = new guards.AssertionError();

			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(guards.AssertionError);
			expect(error.name).toBe('AssertionError');
			expect(error.message).toBe('Assertion failed');
			expect(new guards.AssertionError('custom').message).toBe('custom');
		});

		it('assert throws iff the condition is falsy, and narrows', function () {
			[false, 0, -0, '', NaN, null, undefined, 0n].forEach(function (value) {
				expect(function () {
					guards.assert(value);
				}).toThrow(guards.AssertionError);
			});
			[true, 1, 'a', {}, [], -1n].forEach(function (value) {
				expect(function () {
					guards.assert(value);
				}).not.toThrow();
			});
			expect(function () {
				guards.assert(false, 'boom');
			}).toThrow(new guards.AssertionError('boom'));

			const value: string | number = 'abc' as string | number;

			guards.assert(typeof value === 'string');
			expect(value.toUpperCase()).toBe('ABC');
		});

		it('assertDefined throws iff the value is nullish, and narrows', function () {
			expect(function () {
				guards.assertDefined(null);
			}).toThrow('Expected value to be defined, received null');
			expect(function () {
				guards.assertDefined(undefined, 'missing');
			}).toThrow(new guards.AssertionError('missing'));
			[0, '', false, NaN].forEach(function (value) {
				expect(function () {
					guards.assertDefined(value);
				}).not.toThrow();
			});

			const maybe = [1, 2].find(function (n) {
				return n === 2;
			});

			guards.assertDefined(maybe);
			expect(maybe.toFixed(1)).toBe('2.0');
		});

		it('assertNever enforces exhaustiveness at compile time and always throws at runtime', function () {
			type Shape = { kind: 'circle'; r: number } | { kind: 'square'; size: number };

			function area(shape: Shape): number {
				switch (shape.kind) {
					case 'circle':
						return shape.r;
					case 'square':
						return shape.size;
					default:
						return guards.assertNever(shape);
				}
			}

			expect(area({ kind: 'square', size: 2 })).toBe(2);
			expect(function () {
				area({ kind: 'triangle' } as any);
			}).toThrow(new guards.AssertionError('Unexpected value: [object Object]'));
			expect(function () {
				guards.assertNever('x' as never, 'custom');
			}).toThrow(new guards.AssertionError('custom'));
		});

		it('assertNever describes any value without throwing a different error', function () {
			const circular: Record<string, unknown> = {};

			circular.self = circular;

			const cases: Array<[unknown, string]> = [
				['a', 'Unexpected value: "a"'],
				[1, 'Unexpected value: 1'],
				[10n, 'Unexpected value: 10n'],
				[Symbol('s'), 'Unexpected value: Symbol(s)'],
				[undefined, 'Unexpected value: undefined'],
				[null, 'Unexpected value: null'],
				[Object.create(null), 'Unexpected value: [object Object]'],
				[circular, 'Unexpected value: [object Object]'],
				[
					{
						toJSON: function () {
							return undefined;
						}
					},
					'Unexpected value: [object Object]'
				],
				[[1, 'a'], 'Unexpected value: [object Array]'],
				[new Date(0), 'Unexpected value: [object Date]'],
				['line\nbreak', 'Unexpected value: "line\\nbreak"']
			];

			cases.forEach(function ([value, message]) {
				expect(function () {
					guards.assertNever(value as never);
				}).toThrow(new guards.AssertionError(message));
			});
			expect(function () {
				guards.assertNever(noop as never);
			}).toThrow(new guards.AssertionError(`Unexpected value: ${String(noop)}`));
		});

		describe('security: assertNever keeps payloads out of its message', function () {
			function messageOf(value: unknown): string {
				try {
					guards.assertNever(value as never);
				} catch (error) {
					return (error as Error).message;
				}
				throw new Error('assertNever did not throw');
			}

			it('does not copy object contents (secrets of a request body) into the message', function () {
				const body = JSON.parse('{"kind":"triangle","password":"hunter2","card":"4111111111111111"}');
				const message = messageOf(body);
				expect(message).toBe('Unexpected value: [object Object]');
				expect(message).not.toContain('hunter2');
			});

			it('caps the description at 100 characters, whatever the size of the value', function () {
				expect(messageOf({ kind: 'x', pad: 'A'.repeat(20_000_000) })).toBe('Unexpected value: [object Object]');
				const longString = messageOf('A'.repeat(20_000_000));
				expect(longString).toBe(`Unexpected value: "${'A'.repeat(98)}…`);
				expect(longString.length).toBe('Unexpected value: '.length + 100);
				expect(messageOf(10n ** 200n)).toBe(`Unexpected value: 1${'0'.repeat(98)}…`);
				expect(messageOf(Symbol('s'.repeat(500))).length).toBe('Unexpected value: '.length + 100);
				// A cut never leaves half of a surrogate pair behind.
				expect(messageOf(Symbol(`${'s'.repeat(91)}😀😀`))).toBe(`Unexpected value: Symbol(${'s'.repeat(91)}…`);
			});

			it('never runs toJSON, and survives values whose inspection throws', function () {
				const toJSON = jest.fn(function () {
					return 'attacker-controlled message text';
				});
				expect(messageOf({ toJSON })).toBe('Unexpected value: [object Object]');
				expect(toJSON).not.toHaveBeenCalled();
				const { proxy, revoke } = Proxy.revocable({}, {});
				revoke();
				expect(messageOf(proxy)).toBe('Unexpected value: object');
				const hostile = Object.defineProperty({}, Symbol.toStringTag, {
					get: function () {
						throw new Error('boom');
					}
				});
				expect(messageOf(hostile)).toBe('Unexpected value: object');
			});
		});
	});
});

describe('function kinds and small guards', function () {
	const foreignFunctions = vm.runInNewContext(`({
		plain: function () {},
		async: async function () {},
		generator: function* () {},
		asyncGenerator: async function* () {}
	})`);

	function revokedFunction(): unknown {
		const { proxy, revoke } = Proxy.revocable(function () {}, {});
		revoke();
		return proxy;
	}

	describe('isAsyncFunction', function () {
		it('accepts async functions, arrows and methods, bound or from other realms', function () {
			expect(guards.isAsyncFunction(async function () {})).toBe(true);
			expect(guards.isAsyncFunction(Function('return async () => undefined')())).toBe(true);
			expect(guards.isAsyncFunction({ async method() {} }.method)).toBe(true);
			expect(guards.isAsyncFunction(async function () {}.bind(null))).toBe(true);
			expect(guards.isAsyncFunction(foreignFunctions.async)).toBe(true);
		});

		it('rejects other functions, fakes and non-functions', function () {
			expect(
				guards.isAsyncFunction(function () {
					return Promise.resolve();
				})
			).toBe(false);
			expect(guards.isAsyncFunction(async function* () {})).toBe(false);
			expect(guards.isAsyncFunction(function* () {})).toBe(false);
			expect(guards.isAsyncFunction(class {})).toBe(false);
			expect(guards.isAsyncFunction(foreignFunctions.plain)).toBe(false);
			expect(guards.isAsyncFunction(foreignFunctions.asyncGenerator)).toBe(false);
			expect(guards.isAsyncFunction(Object.assign(function () {}, { [Symbol.toStringTag]: 'AsyncFunction' }))).toBe(false);
			expect(guards.isAsyncFunction(Object.setPrototypeOf(function () {}, null))).toBe(false);
			expect(guards.isAsyncFunction(Object.setPrototypeOf(async function () {}, Function.prototype))).toBe(false);
			expect(guards.isAsyncFunction({ [Symbol.toStringTag]: 'AsyncFunction' })).toBe(false);
			expect(guards.isAsyncFunction(Promise.resolve())).toBe(false);
			expect(guards.isAsyncFunction(revokedFunction())).toBe(false);
		});
	});

	describe('isGeneratorFunction', function () {
		it('accepts generator functions, bound or from other realms', function () {
			expect(guards.isGeneratorFunction(function* () {})).toBe(true);
			expect(guards.isGeneratorFunction({ *method() {} }.method)).toBe(true);
			expect(guards.isGeneratorFunction(function* () {}.bind(null))).toBe(true);
			expect(guards.isGeneratorFunction(foreignFunctions.generator)).toBe(true);
		});

		it('rejects other functions, fakes and non-functions', function () {
			expect(guards.isGeneratorFunction(async function* () {})).toBe(false);
			expect(guards.isGeneratorFunction(async function () {})).toBe(false);
			expect(guards.isGeneratorFunction(function () {})).toBe(false);
			expect(guards.isGeneratorFunction(foreignFunctions.async)).toBe(false);
			expect(guards.isGeneratorFunction(Object.assign(function () {}, { [Symbol.toStringTag]: 'GeneratorFunction' }))).toBe(false);
			expect(guards.isGeneratorFunction((function* () {})())).toBe(false);
			expect(guards.isGeneratorFunction(null)).toBe(false);
		});
	});

	describe('isPropertyKey', function () {
		it('accepts strings, numbers and symbols only', function () {
			for (const key of ['', 'a', 0, -1.5, NaN, Symbol('s'), Symbol.iterator]) expect(guards.isPropertyKey(key)).toBe(true);
			for (const other of [null, undefined, true, 1n, {}, [], function () {}, new String('a')]) expect(guards.isPropertyKey(other)).toBe(false);
		});
	});

	describe('isArrayLike', function () {
		it('accepts values with a valid length', function () {
			expect(guards.isArrayLike([])).toBe(true);
			expect(guards.isArrayLike('')).toBe(true);
			expect(guards.isArrayLike('abc')).toBe(true);
			expect(guards.isArrayLike(new Uint8Array(2))).toBe(true);
			expect(guards.isArrayLike({ length: 0 })).toBe(true);
			expect(guards.isArrayLike({ length: Number.MAX_SAFE_INTEGER })).toBe(true);
			expect(
				guards.isArrayLike(
					(function (..._args: unknown[]) {
						// eslint-disable-next-line prefer-rest-params
						return arguments;
					})(1, 2)
				)
			).toBe(true);
			expect(guards.isArrayLike(new String('ab'))).toBe(true);
		});

		it('rejects functions, nullish values and invalid lengths', function () {
			expect(
				guards.isArrayLike(function (a: number) {
					return a;
				})
			).toBe(false);
			expect(guards.isArrayLike(null)).toBe(false);
			expect(guards.isArrayLike(undefined)).toBe(false);
			expect(guards.isArrayLike(1)).toBe(false);
			expect(guards.isArrayLike({})).toBe(false);
			for (const length of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', 1n, null]) expect(guards.isArrayLike({ length })).toBe(false);
			expect(guards.isArrayLike(new Map())).toBe(false);
		});

		it('never throws', function () {
			const throwing = {
				get length(): number {
					throw new Error('length');
				}
			};
			expect(guards.isArrayLike(throwing)).toBe(false);
			const { proxy, revoke } = Proxy.revocable([], {});
			revoke();
			expect(guards.isArrayLike(proxy)).toBe(false);
		});
	});

	describe('isBlob', function () {
		it('accepts blobs and files', function () {
			expect(guards.isBlob(new Blob(['text']))).toBe(true);
			expect(guards.isBlob(new File(['text'], 'a.txt'))).toBe(true);
		});

		it('rejects fakes and other values', function () {
			expect(guards.isBlob({ size: 4, type: '', [Symbol.toStringTag]: 'Blob' })).toBe(false);
			expect(guards.isBlob(Object.create(Blob.prototype))).toBe(false);
			expect(guards.isBlob(Object.create(null))).toBe(false);
			expect(guards.isBlob(new Uint8Array(1))).toBe(false);
			expect(guards.isBlob(null)).toBe(false);
			expect(guards.isBlob('blob')).toBe(false);
		});

		it('is false without a Blob global', function () {
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Blob') as PropertyDescriptor;
			const blob = new Blob(['x']);
			delete (globalThis as { Blob?: unknown }).Blob;
			try {
				expect(guards.isBlob(blob)).toBe(false);
			} finally {
				Object.defineProperty(globalThis, 'Blob', descriptor);
			}
		});
	});
});

describe('getType', function () {
	const other = vm.runInNewContext(`({
		array: [1],
		date: new Date(0),
		regexp: /a/,
		error: new Error('x'),
		map: new Map(),
		set: new Set(),
		promise: Promise.resolve(),
		buffer: new ArrayBuffer(1),
		bytes: new Uint8Array(1),
		object: {},
		async: async function () {}
	})`);

	it('names primitives', function () {
		expect(guards.getType(undefined)).toBe('undefined');
		expect(guards.getType(null)).toBe('null');
		expect(guards.getType(true)).toBe('boolean');
		expect(guards.getType(NaN)).toBe('number');
		expect(guards.getType(1n)).toBe('bigint');
		expect(guards.getType('')).toBe('string');
		expect(guards.getType(Symbol('s'))).toBe('symbol');
	});

	it('names function kinds', function () {
		expect(guards.getType(function () {})).toBe('function');
		expect(guards.getType(class {})).toBe('function');
		expect(guards.getType(Math.max.bind(null))).toBe('function');
		expect(guards.getType(async function () {})).toBe('asyncfunction');
		expect(guards.getType(function* () {})).toBe('generatorfunction');
		expect(guards.getType(async function* () {})).toBe('asyncgeneratorfunction');
		expect(guards.getType(other.async)).toBe('asyncfunction');
		expect(guards.getType(vm.runInNewContext('(function* () {})'))).toBe('generatorfunction');
		expect(guards.getType(vm.runInNewContext('(async function* () {})'))).toBe('asyncgeneratorfunction');
		expect(guards.getType(vm.runInNewContext('(function () {})'))).toBe('function');
	});

	it('names built-in objects by brand, in any realm', function () {
		const cases: Array<[unknown, guards.TypeName]> = [
			[[], 'array'],
			[new Date(), 'date'],
			[/a/, 'regexp'],
			[new TypeError('x'), 'error'],
			[new Map(), 'map'],
			[new Set(), 'set'],
			[new WeakMap(), 'weakmap'],
			[new WeakSet(), 'weakset'],
			[Promise.resolve(), 'promise'],
			[new ArrayBuffer(1), 'arraybuffer'],
			[new DataView(new ArrayBuffer(1)), 'dataview'],
			[new Int8Array(1), 'int8array'],
			[new Uint8Array(1), 'uint8array'],
			[new Uint8ClampedArray(1), 'uint8clampedarray'],
			[new Int16Array(1), 'int16array'],
			[new Uint16Array(1), 'uint16array'],
			[new Int32Array(1), 'int32array'],
			[new Uint32Array(1), 'uint32array'],
			[new Float32Array(1), 'float32array'],
			[new Float64Array(1), 'float64array'],
			[new BigInt64Array(1), 'bigint64array'],
			[new BigUint64Array(1), 'biguint64array'],
			[{}, 'object'],
			[Object.create(null), 'object'],
			[new (class Point {})(), 'object'],
			[new Number(1), 'object'],
			[new SharedArrayBuffer(1), 'object'],
			[[1][Symbol.iterator](), 'object'],
			[{ then: function () {} }, 'object'],
			[other.array, 'array'],
			[other.date, 'date'],
			[other.regexp, 'regexp'],
			[other.error, 'error'],
			[other.map, 'map'],
			[other.set, 'set'],
			[other.promise, 'promise'],
			[other.buffer, 'arraybuffer'],
			[other.bytes, 'uint8array'],
			[other.object, 'object']
		];
		for (const [index, [value, name]] of cases.entries()) expect({ index, type: guards.getType(value) }).toEqual({ index, type: name });
		const Float16 = (globalThis as { Float16Array?: new (length: number) => unknown }).Float16Array;
		if (Float16) expect(guards.getType(new Float16(1))).toBe('float16array');
	});

	it('is not fooled by Symbol.toStringTag or borrowed prototypes', function () {
		for (const tag of ['Array', 'Date', 'RegExp', 'Error', 'Map', 'Set', 'Promise', 'ArrayBuffer', 'Uint8Array', 'Null']) {
			expect(guards.getType({ [Symbol.toStringTag]: tag })).toBe('object');
		}
		expect(guards.getType(Object.create(Date.prototype))).toBe('object');
		expect(guards.getType(Object.create(Map.prototype))).toBe('object');
		const fakeDate = new Date(0);
		Object.defineProperty(fakeDate, Symbol.toStringTag, { value: 'Map' });
		expect(guards.getType(fakeDate)).toBe('date');
		const fakeBytes = new Uint8Array(1);
		Object.defineProperty(fakeBytes, Symbol.toStringTag, { value: 'Float64Array' });
		expect(guards.getType(fakeBytes)).toBe('uint8array');
	});

	it('names proxies after arrays and functions, and survives revoked ones', function () {
		expect(guards.getType(new Proxy([], {}))).toBe('array');
		expect(guards.getType(new Proxy(new Map(), {}))).toBe('object');
		expect(guards.getType(new Proxy(async function () {}, {}))).toBe('asyncfunction');
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect(guards.getType(proxy)).toBe('object');
		const tagThrows = new Proxy(Object.create(null), {
			get(): never {
				throw new Error('get');
			}
		});
		expect(guards.getType(tagThrows)).toBe('object');
	});
});

describe('runtime detection', function () {
	const realm = globalThis as unknown as Record<string, unknown>;

	/**
	 * Runs `fn` with the given globals replaced (`undefined` deletes one), restoring them afterwards.
	 */
	function withGlobals<T>(globals: Record<string, unknown>, fn: () => T): T {
		const saved = new Map<string, PropertyDescriptor | undefined>();
		for (const [name, value] of Object.entries(globals)) {
			saved.set(name, Object.getOwnPropertyDescriptor(realm, name));
			if (value === undefined) delete realm[name];
			else Object.defineProperty(realm, name, { value, configurable: true, writable: true });
		}
		try {
			return fn();
		} finally {
			for (const [name, descriptor] of saved) {
				if (descriptor) Object.defineProperty(realm, name, descriptor);
				else delete realm[name];
			}
		}
	}

	function detect(): Record<string, boolean> {
		return { node: guards.isNode(), deno: guards.isDeno(), bun: guards.isBun(), browser: guards.isBrowser(), worker: guards.isWebWorker() };
	}

	const none = { node: false, deno: false, bun: false, browser: false, worker: false };
	const documentStub = { nodeType: 9 };

	it('detects Node (the test runner)', function () {
		expect(detect()).toEqual({ ...none, node: true });
	});

	it('detects Bun and Deno, which are not Node', function () {
		withGlobals({ process: { versions: { node: '22.0.0', bun: '1.2.0' } } }, function () {
			expect(detect()).toEqual({ ...none, bun: true });
		});
		withGlobals({ Deno: { version: { deno: '2.0.0' } }, process: { versions: { node: '20.11.1' } } }, function () {
			expect(detect()).toEqual({ ...none, deno: true });
		});
		withGlobals({ Deno: { version: { deno: '2.0.0' } }, process: undefined }, function () {
			expect(detect()).toEqual({ ...none, deno: true });
		});
	});

	it('detects a browser main thread, even with a bundler process shim', function () {
		withGlobals({ window: globalThis, document: documentStub, process: undefined }, function () {
			expect(detect()).toEqual({ ...none, browser: true });
		});
		withGlobals({ window: globalThis, document: documentStub, process: { browser: true, env: {}, versions: {} } }, function () {
			expect(detect()).toEqual({ ...none, browser: true });
		});
	});

	it('does not take jsdom, happy-dom or SSR stubs for a browser', function () {
		withGlobals({ window: globalThis, document: documentStub }, function () {
			expect(detect()).toEqual({ ...none, node: true });
		});
		withGlobals({ window: {}, document: documentStub, process: undefined }, function () {
			expect(detect()).toEqual(none);
		});
		withGlobals({ window: globalThis, document: null, process: undefined }, function () {
			expect(detect()).toEqual(none);
		});
		withGlobals({ window: globalThis, document: documentStub, process: undefined, Deno: { version: { deno: '1.40.0' } } }, function () {
			expect(detect()).toEqual({ ...none, deno: true });
		});
	});

	it('detects web workers', function () {
		class WorkerGlobalScope {}
		Object.setPrototypeOf(realm, WorkerGlobalScope.prototype);
		try {
			withGlobals({ WorkerGlobalScope, process: undefined }, function () {
				expect(detect()).toEqual({ ...none, worker: true });
			});
		} finally {
			Object.setPrototypeOf(realm, Object.prototype);
		}
		withGlobals({ WorkerGlobalScope: class {} }, function () {
			expect(guards.isWebWorker()).toBe(false);
		});
		withGlobals({ WorkerGlobalScope: {} }, function () {
			expect(guards.isWebWorker()).toBe(false);
		});
	});

	it('ignores fake runtime globals', function () {
		withGlobals({ process: { versions: { node: 22 } }, Deno: { version: '2' } }, function () {
			expect(detect()).toEqual(none);
		});
		withGlobals({ process: { versions: null }, Deno: null }, function () {
			expect(detect()).toEqual(none);
		});
	});

	it('never throws for hostile globals', function () {
		const hostile = {
			get version(): never {
				throw new Error('version');
			}
		};
		const scope = Object.defineProperty(function () {}, Symbol.hasInstance, {
			value: function (): never {
				throw new Error('hasInstance');
			}
		});
		// Detected first, checked after the globals are restored: the test runner itself needs a working `process`.
		const versions = {
			get versions(): never {
				throw new Error('versions');
			}
		};
		const hostileGlobals = withGlobals({ process: versions, Deno: hostile, WorkerGlobalScope: scope }, detect);
		// A global whose getter throws (defined on the global object's prototype: Node's `vm` contexts ignore accessors defined on the
		// global object itself).
		const prototype = Object.getPrototypeOf(realm);
		const throwing = {
			configurable: true,
			get: function (): never {
				throw new Error('getter');
			}
		};
		Object.setPrototypeOf(realm, Object.create(prototype, { Deno: throwing, WorkerGlobalScope: throwing, document: throwing }));
		let throwingGetter: Record<string, boolean>;
		try {
			throwingGetter = withGlobals({ Deno: undefined, process: undefined }, detect);
		} finally {
			Object.setPrototypeOf(realm, prototype);
		}
		expect(hostileGlobals).toEqual(none);
		expect(throwingGetter).toEqual(none);
	});
});
