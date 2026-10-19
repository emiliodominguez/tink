import * as vm from 'vm';
import {
	explain,
	ensure,
	isArrayOf,
	isDate,
	isFalsy,
	isPromise,
	isPlainObject,
	isError,
	isFiniteNumber,
	isInteger,
	isIntersection,
	isJsonArray,
	isJsonObject,
	isJsonValue,
	isLazy,
	isLiteral,
	isMatching,
	isNonNegativeInteger,
	isNonNegativeNumber,
	isNumberInRange,
	isOptional,
	isPositiveInteger,
	isPositiveNumber,
	isSafeInteger,
	isShape,
	isString,
	isTruthy,
	isUnion,
	refine,
	withMessage,
	type FalsyPart,
	type Guard,
	type Infer,
	type JsonValue,
	type PatternType
} from '.';

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

const HOSTILE = '{"__proto__":{"x":1},"constructor":{"prototype":{"x":1}}}';

function assertNotPolluted(): void {
	expect(({} as Record<string, unknown>).x).toBeUndefined();
	expect((Object.prototype as unknown as Record<string, unknown>).x).toBeUndefined();
}

describe('number refinements', function () {
	const table: Array<[unknown, boolean, boolean, boolean, boolean, boolean]> = [
		// value, positiveNumber, nonNegativeNumber, positiveInteger, nonNegativeInteger, safeInteger
		[1, true, true, true, true, true],
		[0.5, true, true, false, false, false],
		[0, false, true, false, true, true],
		[-0, false, true, false, true, true],
		[-1, false, false, false, false, true],
		[-0.5, false, false, false, false, false],
		[Number.MIN_VALUE, true, true, false, false, false],
		[2 ** 53, true, true, true, true, false],
		[2 ** 53 - 1, true, true, true, true, true],
		[-(2 ** 53), false, false, false, false, false],
		[1e21, true, true, true, true, false],
		[Infinity, false, false, false, false, false],
		[-Infinity, false, false, false, false, false],
		[NaN, false, false, false, false, false],
		['1', false, false, false, false, false],
		[1n, false, false, false, false, false],
		[new Number(1), false, false, false, false, false],
		[null, false, false, false, false, false],
		[undefined, false, false, false, false, false],
		[true, false, false, false, false, false]
	];

	it.each(table)('%p', function (value, positive, nonNegative, positiveInteger, nonNegativeInteger, safeInteger) {
		expect([isPositiveNumber(value), isNonNegativeNumber(value), isPositiveInteger(value), isNonNegativeInteger(value), isSafeInteger(value)]).toEqual([
			positive,
			nonNegative,
			positiveInteger,
			nonNegativeInteger,
			safeInteger
		]);
	});

	it('should compose with isShape and withMessage', function () {
		const isItem = isShape({ quantity: withMessage(isPositiveInteger, 'Quantity must be a positive integer'), price: isNonNegativeNumber });

		expect(isItem({ quantity: 2, price: 0 })).toBe(true);
		expect(explain(isItem, { quantity: 0, price: -1 })).toEqual([
			{ message: 'Quantity must be a positive integer', path: ['quantity'] },
			{ message: 'Invalid value (got number)', path: ['price'] }
		]);
	});
});

describe('isNumberInRange', function () {
	it('should accept finite numbers within the inclusive bounds', function () {
		const isPercent = isNumberInRange(0, 100);

		for (const value of [0, -0, 100, 42.5]) expect(isPercent(value)).toBe(true);
		for (const value of [-1, 100.0001, NaN, '50', null, 50n]) expect(isPercent(value)).toBe(false);
	});

	it('should reject NaN and infinities even with infinite bounds', function () {
		const isAny = isNumberInRange(-Infinity, Infinity);

		expect(isAny(Number.MAX_VALUE)).toBe(true);
		expect(isAny(-Number.MAX_VALUE)).toBe(true);
		expect(isAny(Infinity)).toBe(false);
		expect(isAny(-Infinity)).toBe(false);
		expect(isAny(NaN)).toBe(false);
	});

	it('should accept a single-point range', function () {
		expect(isNumberInRange(3, 3)(3)).toBe(true);
		expect(isNumberInRange(3, 3)(3.1)).toBe(false);
	});

	it('should report the range in explain', function () {
		expect(explain(isNumberInRange(1, 5), 7)).toEqual([{ message: 'Expected a number between 1 and 5 (got 7)', path: [] }]);
		expect(explain(isNumberInRange(1, 5), 'x')).toEqual([{ message: 'Expected a number between 1 and 5 (got string)', path: [] }]);
		expect(explain(isNumberInRange(1, 5), 3)).toEqual([]);
	});

	it('should validate its bounds', function () {
		expect(function () {
			isNumberInRange('0' as never, 1);
		}).toThrow(new TypeError('isNumberInRange: `min` must be a number, got string'));
		expect(function () {
			isNumberInRange(NaN, 1);
		}).toThrow(new RangeError('isNumberInRange: `min` must be a number, got NaN'));
		expect(function () {
			isNumberInRange(0, NaN);
		}).toThrow(new RangeError('isNumberInRange: `max` must be a number >= min (0), got NaN'));
		expect(function () {
			isNumberInRange(10, 0);
		}).toThrow(new RangeError('isNumberInRange: `max` must be a number >= min (10), got 0'));
		expect(function () {
			isNumberInRange(0, undefined as never);
		}).toThrow(TypeError);
	});
});

describe('isTruthy / isFalsy', function () {
	const falsy = [false, 0, -0, 0n, '', null, undefined, NaN];
	const truthy = [true, 1, -1, 1n, 'a', '0', 'false', ' ', [], {}, function () {}, Symbol('s'), new Boolean(false), Infinity];

	it('should classify every value like Boolean()', function () {
		for (const value of falsy) {
			expect(isTruthy(value)).toBe(false);
			expect(isFalsy(value)).toBe(true);
		}
		for (const value of truthy) {
			expect(isTruthy(value)).toBe(true);
			expect(isFalsy(value)).toBe(false);
		}
	});

	it('should narrow array filters', function () {
		const names: Array<string | undefined | null> = ['ada', undefined, '', null, 'bob'];
		const kept = names.filter(isTruthy);
		const typed: Equal<typeof kept, string[]> = true;

		expect(typed).toBe(true);
		expect(kept).toEqual(['ada', 'bob']);
		expect(names.filter(isFalsy)).toEqual([undefined, '', null]);
	});

	it('should compute the falsy part of a type', function () {
		const checks: [
			Equal<FalsyPart<string | undefined>, '' | undefined>,
			Equal<FalsyPart<number>, number>,
			Equal<FalsyPart<1 | 2>, never>,
			Equal<FalsyPart<0 | 1>, 0>,
			Equal<FalsyPart<boolean>, false>,
			Equal<FalsyPart<bigint | null>, 0n | null>,
			Equal<FalsyPart<{ a: 1 } | null>, null>,
			Equal<FalsyPart<unknown>, false | 0 | 0n | '' | null | undefined | number>
		] = [true, true, true, true, true, true, true, true];

		expect(checks.every(Boolean)).toBe(true);

		const value: string | number | undefined = Math.random() > 2 ? 'x' : undefined;

		if (isFalsy(value)) {
			const narrowed: '' | number | undefined = value;

			expect(narrowed).toBeUndefined();
		}
	});
});

describe('isLiteral', function () {
	it('should accept exactly the given primitive (SameValueZero)', function () {
		expect(isLiteral('a')('a')).toBe(true);
		expect(isLiteral('a')('A')).toBe(false);
		expect(isLiteral(1)(1)).toBe(true);
		expect(isLiteral(1)('1')).toBe(false);
		expect(isLiteral(NaN)(NaN)).toBe(true);
		expect(isLiteral(0)(-0)).toBe(true);
		expect(isLiteral(null)(undefined)).toBe(false);
		expect(isLiteral(undefined)(undefined)).toBe(true);
		expect(isLiteral(1n)(1n)).toBe(true);
		expect(isLiteral(1n)(1)).toBe(false);

		const symbol = Symbol('s');

		expect(isLiteral(symbol)(symbol)).toBe(true);
		expect(isLiteral(symbol)(Symbol('s'))).toBe(false);
	});

	it('should infer the literal type', function () {
		const isAdmin = isLiteral('admin');
		const typed: Equal<Infer<typeof isAdmin>, 'admin'> = true;

		expect(typed).toBe(true);
	});

	it('should describe the expected value in explain', function () {
		expect(explain(isLiteral('admin'), 'user')).toEqual([{ message: 'Expected "admin" (got string)', path: [] }]);
		expect(explain(isLiteral(3), 4)).toEqual([{ message: 'Expected 3 (got 4)', path: [] }]);
		expect(explain(isLiteral(3n), 4)).toEqual([{ message: 'Expected 3n (got 4)', path: [] }]);
		expect(explain(isLiteral(null), undefined)).toEqual([{ message: 'Expected null (got undefined)', path: [] }]);
		expect(explain(isLiteral('a'.repeat(200)), 1)[0].message.length).toBeLessThan(120);
	});

	it('should reject objects and functions', function () {
		expect(function () {
			isLiteral({} as never);
		}).toThrow(new TypeError('isLiteral: `value` must be a primitive, got object'));
		expect(function () {
			isLiteral(function () {} as never);
		}).toThrow(TypeError);
	});
});

describe('isIntersection', function () {
	const isNamed = isShape({ name: isString });
	const isAged = isShape({ age: isInteger });
	const isPerson = isIntersection(isNamed, isAged);

	it('should pass only when every member passes', function () {
		expect(isPerson({ name: 'Ada', age: 36 })).toBe(true);
		expect(isPerson({ name: 'Ada' })).toBe(false);
		expect(isPerson({ age: 36 })).toBe(false);
		expect(isPerson(null)).toBe(false);
		expect(isIntersection(isFiniteNumber)(1)).toBe(true);
	});

	it('should infer the intersection type', function () {
		const typed: Equal<Infer<typeof isPerson>, { name: string } & { age: number }> = true;

		expect(typed).toBe(true);
	});

	it('should stop at the first failing member', function () {
		const second = jest.fn(isString);

		expect(isIntersection(isInteger, second as unknown as Guard<string>)('x')).toBe(false);
		expect(second).not.toHaveBeenCalled();
	});

	it('should report the issues of every failing member, without duplicates', function () {
		expect(explain(isPerson, {})).toEqual([
			{ message: 'Missing required property', path: ['name'] },
			{ message: 'Missing required property', path: ['age'] }
		]);
		expect(explain(isPerson, 'x')).toEqual([{ message: 'Expected an object (got string)', path: [] }]);
		expect(explain(isShape({ p: isPerson }), { p: { name: 1, age: 1 } })).toEqual([{ message: 'Invalid value (got number)', path: ['p', 'name'] }]);
		expect(explain(isPerson, { name: 'a', age: 1 })).toEqual([]);
	});

	it('should keep issues that only differ by path or message', function () {
		const isNonEmpty = refine(isString, function (value: string): boolean {
			return value.length > 0;
		});

		expect(explain(isIntersection(isNonEmpty, withMessage(isNonEmpty, 'custom')), '')).toEqual([
			{ message: 'Invalid value (got string)', path: [] },
			{ message: 'custom', path: [] }
		]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			isIntersection();
		}).toThrow(new RangeError('isIntersection: expected at least one guard, got 0'));
		expect(function () {
			isIntersection(isString, 1 as never);
		}).toThrow(new TypeError('isIntersection: `guards[1]` must be a function, got number'));
	});
});

describe('refine', function () {
	const isEven = refine(
		isInteger,
		function (value: number): boolean {
			return value % 2 === 0;
		},
		'Expected an even number'
	);

	it('should require both the guard and the predicate', function () {
		expect(isEven(4)).toBe(true);
		expect(isEven(3)).toBe(false);
		expect(isEven('4')).toBe(false);
	});

	it('should only call the predicate with values that passed the guard', function () {
		const predicate = jest.fn(function (value: string): boolean {
			return value.length > 1;
		});
		const isLong = refine(isString, predicate);

		expect(isLong(1)).toBe(false);
		expect(explain(isLong, 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(predicate).not.toHaveBeenCalled();
		expect(isLong('ab')).toBe(true);
		expect(predicate).toHaveBeenCalledWith('ab');
	});

	it('should narrow with a type-guard predicate', function () {
		const isAb = refine(isString, function (value: string): value is 'a' | 'b' {
			return value === 'a' || value === 'b';
		});
		const typed: Equal<Infer<typeof isAb>, 'a' | 'b'> = true;

		expect(typed).toBe(true);
		expect(isAb('a')).toBe(true);
		expect(isAb('c')).toBe(false);
	});

	it('should report the base issues, then the refinement message', function () {
		const isPoint = isShape({ x: isEven });

		expect(explain(isPoint, { x: 3 })).toEqual([{ message: 'Expected an even number', path: ['x'] }]);
		expect(explain(isPoint, { x: 1.5 })).toEqual([{ message: 'Invalid value (got number)', path: ['x'] }]);
		expect(explain(isPoint, { x: 2 })).toEqual([]);
		expect(explain(isShape({ x: isEven, y: isString }), { x: 2, y: 1 })).toEqual([{ message: 'Invalid value (got number)', path: ['y'] }]);
		expect(
			explain(
				refine(isShape({ a: isInteger }), function (value: { a: number }): boolean {
					return value.a > 0;
				}),
				{ a: 'x' }
			)
		).toEqual([{ message: 'Invalid value (got string)', path: ['a'] }]);
	});

	it('should build messages with a function', function () {
		const isShort = refine(
			isString,
			function (value: string): boolean {
				return value.length <= 2;
			},
			function (value: string): string {
				return `Too long: ${value.length}`;
			}
		);

		expect(explain(isShort, 'abcd')).toEqual([{ message: 'Too long: 4', path: [] }]);
		expect(explain(refine(isString, Boolean), '')).toEqual([{ message: 'Invalid value (got string)', path: [] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			refine(1 as never, Boolean);
		}).toThrow(new TypeError('refine: `guard` must be a function, got number'));
		expect(function () {
			refine(isString, null as never);
		}).toThrow(new TypeError('refine: `predicate` must be a function, got null'));
		expect(function () {
			refine(isString, Boolean, 3 as never);
		}).toThrow(new TypeError('refine: `message` must be a string or a function, got number'));
	});
});

describe('isLazy', function () {
	type Tree = { value: number; children: Tree[] };
	const isTree: Guard<Tree> = isShape({
		value: isFiniteNumber,
		children: isArrayOf(
			isLazy(function () {
				return isTree;
			})
		)
	});

	it('should check recursive structures', function () {
		expect(isTree({ value: 1, children: [] })).toBe(true);
		expect(isTree({ value: 1, children: [{ value: 2, children: [{ value: 3, children: [] }] }] })).toBe(true);
		expect(isTree({ value: 1, children: [{ value: 2, children: [{ value: '3', children: [] }] }] })).toBe(false);
		expect(explain(isTree, { value: 1, children: [{ value: 2, children: [{ value: '3', children: [] }] }] })).toEqual([
			{ message: 'Invalid value (got string)', path: ['children', 0, 'children', 0, 'value'] }
		]);
	});

	it('should call the getter once, on first use', function () {
		const getter = jest.fn(function (): Guard<string> {
			return isString;
		});
		const isLazyString = isLazy(getter);

		expect(getter).not.toHaveBeenCalled();
		expect(isLazyString('a')).toBe(true);
		expect(isLazyString(1)).toBe(false);
		expect(explain(isLazyString, 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(getter).toHaveBeenCalledTimes(1);
	});

	it('should reject cycles instead of overflowing the stack', function () {
		const loop: Tree = { value: 1, children: [] };

		loop.children.push({ value: 2, children: [loop] });
		expect(isTree(loop)).toBe(false);
		expect(explain(isTree, loop)).toEqual([{ message: 'Circular reference', path: ['children', 0, 'children', 0, 'children', 0] }]);
		expect(function () {
			ensure(isTree, loop);
		}).toThrow('Circular reference');
	});

	it('should accept shared (non-circular) sub-values', function () {
		const leaf: Tree = { value: 0, children: [] };
		const shared = { value: 1, children: [leaf, leaf, { value: 2, children: [leaf] }] };

		expect(isTree(shared)).toBe(true);
		expect(explain(isTree, shared)).toEqual([]);
	});

	it('should support mutual recursion', function () {
		type Expr = { op: 'neg'; arg: Expr } | { op: 'lit'; value: number };
		const isExpr: Guard<Expr> = isUnion(
			isShape({
				op: isLiteral('neg'),
				arg: isLazy(function () {
					return isExpr;
				})
			}),
			isShape({ op: isLiteral('lit'), value: isFiniteNumber })
		);

		expect(isExpr({ op: 'neg', arg: { op: 'neg', arg: { op: 'lit', value: 1 } } })).toBe(true);
		expect(isExpr({ op: 'neg', arg: { op: 'neg', arg: { op: 'lit', value: 'x' } } })).toBe(false);
	});

	it('should reject values met again by an ill-founded schema', function () {
		const isSelf: Guard<object> = isLazy(function () {
			return isSelf;
		});

		expect(isSelf({})).toBe(false);
		expect(explain(isSelf, {})).toEqual([{ message: 'Circular reference', path: [] }]);
	});

	it('should forget the values being checked when a guard throws', function () {
		let calls = 0;
		const isPicky = isLazy(function (): Guard<object> {
			return function (value: unknown): value is object {
				calls++;
				if (calls === 1 || calls === 3) throw new Error('boom');

				return calls > 5 && typeof value === 'object';
			};
		});
		const value = {};

		expect(function () {
			isPicky(value);
		}).toThrow('boom');
		// Call 2 (guard mode) fails, call 3 (reporting mode) throws.
		expect(function () {
			explain(isPicky, value);
		}).toThrow('boom');
		// Neither mode still believes `value` is being checked: no `Circular reference`.
		expect(explain(isPicky, value)).toEqual([{ message: 'Invalid value (got object)', path: [] }]);
		expect(isPicky(value)).toBe(true);
	});

	it('should validate the getter and its result', function () {
		expect(function () {
			isLazy(1 as never);
		}).toThrow(new TypeError('isLazy: `getter` must be a function, got number'));

		const isBroken = isLazy(function () {
			return 'nope' as never;
		});

		expect(function () {
			isBroken(1);
		}).toThrow(new TypeError('isLazy: `getter` must return a function, got string'));
		expect(function () {
			explain(isBroken, 1);
		}).toThrow(TypeError);
	});
});

describe('isMatching', function () {
	const isAdminEvent = isMatching({ type: 'login', user: { role: 'admin', id: isInteger } });

	it('should match deep partial structures', function () {
		expect(isAdminEvent({ type: 'login', at: 1, user: { role: 'admin', id: 7, name: 'Ada' } })).toBe(true);
		expect(isAdminEvent({ type: 'login', user: { role: 'guest', id: 7 } })).toBe(false);
		expect(isAdminEvent({ type: 'login', user: { role: 'admin', id: 7.5 } })).toBe(false);
		expect(isAdminEvent({ type: 'login' })).toBe(false);
		expect(isAdminEvent({ type: 'login', user: null })).toBe(false);
		expect(isAdminEvent(null)).toBe(false);
	});

	it('should be deep, unlike shallow matchers', function () {
		expect(isMatching({ a: { b: 1 } })({ a: { b: 1, c: 2 } })).toBe(true);
	});

	it('should infer the matched type', function () {
		const typed: Equal<Infer<typeof isAdminEvent>, { type: 'login'; user: { role: 'admin'; id: number } }> = true;
		const tuple: Equal<PatternType<readonly [1, Guard<string>]>, [1, string]> = true;
		const loose: Equal<PatternType<(value: unknown) => boolean>, unknown> = true;
		const date: Equal<PatternType<{ at: Date }>, { at: Date }> = true;

		expect([typed, tuple, loose, date]).toEqual([true, true, true, true]);
	});

	it('should compare leaves with SameValueZero', function () {
		expect(isMatching({ a: NaN })({ a: NaN })).toBe(true);
		expect(isMatching({ a: 0 })({ a: -0 })).toBe(true);
		expect(isMatching({ a: '1' })({ a: 1 })).toBe(false);
		expect(isMatching(5)(5)).toBe(true);
		expect(isMatching(null)(undefined)).toBe(false);
	});

	it('should match arrays as exact-length tuples', function () {
		const isOrigin = isMatching({ point: [0, isFiniteNumber] });

		expect(isOrigin({ point: [-0, 2] })).toBe(true);
		expect(isOrigin({ point: [0] })).toBe(false);
		expect(isOrigin({ point: [0, 2, 3] })).toBe(false);
		expect(isOrigin({ point: { 0: 0, 1: 2, length: 2 } })).toBe(false);
		expect(isMatching([])([])).toBe(true);
		expect(isMatching([{ a: 1 }])([{ a: 1, b: 2 }])).toBe(true);
		expect(isMatching([3])([1, 2, 3])).toBe(false);
	});

	it('should require own properties (inherited ones never count)', function () {
		expect(isMatching({ a: 1 })(Object.create({ a: 1 }))).toBe(false);
		expect(isMatching({ a: undefined })({})).toBe(false);
		expect(isMatching({ a: undefined })({ a: undefined })).toBe(true);
		expect(isMatching({ toString: isOptional(isString) })({})).toBe(true);
	});

	it('should call guards with the property value, or undefined when it is missing', function () {
		const guard = jest.fn(isOptional(isString));

		expect(isMatching({ a: guard, b: 1 })({ b: 1 })).toBe(true);
		expect(guard).toHaveBeenCalledWith(undefined);
		expect(isMatching({ a: guard })({ a: 'x' })).toBe(true);
		expect(isMatching({ a: guard })({ a: 1 })).toBe(false);
	});

	it('should return a function pattern itself', function () {
		expect(isMatching(isString)).toBe(isString);
	});

	it('should reject arrays and functions for object patterns, and accept class instances', function () {
		class Point {
			x = 1;
		}

		expect(isMatching({ x: 1 })(new Point())).toBe(true);
		expect(isMatching({ length: 1 })(['a'])).toBe(false);
		expect(isMatching({})(function () {})).toBe(false);
		expect(isMatching({})({})).toBe(true);
		expect(isMatching({})(Object.create(null))).toBe(true);
	});

	it('should match symbol keys, ignoring non-enumerable ones', function () {
		const key = Symbol('k');
		const hidden = Symbol('hidden');
		const pattern = { [key]: 1 };

		Object.defineProperty(pattern, hidden, { value: 2, enumerable: false });
		expect(isMatching(pattern)({ [key]: 1 })).toBe(true);
		expect(isMatching(pattern)({ [key]: 2 })).toBe(false);
	});

	it('should match dates by time and other objects by identity', function () {
		const map = new Map();

		expect(isMatching({ at: new Date(5) })({ at: new Date(5) })).toBe(true);
		expect(isMatching({ at: new Date(5) })({ at: new Date(6) })).toBe(false);
		expect(isMatching({ at: new Date(5) })({ at: 5 })).toBe(false);
		expect(isMatching({ at: new Date(NaN) })({ at: new Date(NaN) })).toBe(true);
		expect(isMatching({ m: map })({ m: map })).toBe(true);
		expect(isMatching({ m: map })({ m: new Map() })).toBe(false);
		expect(explain(isMatching({ at: new Date(5) }), { at: 1 })).toEqual([{ message: 'Expected a date with time 5 (got 1)', path: ['at'] }]);
		expect(explain(isMatching({ m: map }), { m: 1 })).toEqual([{ message: 'Expected [object Map] (got 1)', path: ['m'] }]);
		expect(isDate(new Date())).toBe(true);
	});

	it('should copy the pattern', function () {
		const pattern = { a: { b: 1 } };
		const guard = isMatching(pattern);

		pattern.a.b = 2;
		expect(guard({ a: { b: 1 } })).toBe(true);
	});

	it('should reject circular patterns and accept shared ones', function () {
		const circular: Record<string, unknown> = {};

		circular.self = circular;
		expect(function () {
			isMatching(circular);
		}).toThrow(new TypeError('isMatching: `pattern` must be acyclic, got a circular reference'));

		const array: unknown[] = [];

		array.push(array);
		expect(function () {
			isMatching(array);
		}).toThrow(TypeError);

		const shared = { b: 1 };

		expect(isMatching({ x: shared, y: shared })({ x: { b: 1 }, y: { b: 1 } })).toBe(true);
	});

	it('should not be fooled or polluted by hostile keys', function () {
		const pattern = JSON.parse(HOSTILE);
		const guard = isMatching(pattern);

		expect(guard(JSON.parse(HOSTILE))).toBe(true);
		expect(guard({})).toBe(false);
		expect(guard({ constructor: { prototype: { x: 1 } } })).toBe(false);
		expect(explain(guard, {})).toEqual([
			{ message: 'Missing required property', path: ['__proto__'] },
			{ message: 'Missing required property', path: ['constructor'] }
		]);
		assertNotPolluted();
	});

	it('should explain failures with paths', function () {
		expect(explain(isAdminEvent, { type: 'login', user: { id: 'x' } })).toEqual([
			{ message: 'Missing required property', path: ['user', 'role'] },
			{ message: 'Invalid value (got string)', path: ['user', 'id'] }
		]);
		expect(explain(isAdminEvent, { type: 'logout', user: [] })).toEqual([
			{ message: 'Expected "login" (got string)', path: ['type'] },
			{ message: 'Expected an object (got array)', path: ['user'] }
		]);
		expect(explain(isMatching({ p: [1, 2] }), { p: [1] })).toEqual([{ message: 'Expected a tuple of 2 elements (got 1 elements)', path: ['p'] }]);
		expect(explain(isMatching({ p: [1, 2] }), { p: [1, 3] })).toEqual([{ message: 'Expected 2 (got 3)', path: ['p', 1] }]);
		expect(explain(isAdminEvent, { type: 'login', user: { role: 'admin', id: 1 } })).toEqual([]);
	});
});

describe('isJsonValue / isJsonObject / isJsonArray', function () {
	it('should accept values that survive a JSON round trip', function () {
		const valid: unknown[] = [null, true, false, 0, -0, 1.5, -1e300, '', 'x\ud800', [], {}, Object.create(null), [1, ['a', [null]]], { a: { b: [{ c: 'd' }] } }];

		for (const value of valid) expect(isJsonValue(value)).toBe(true);
	});

	it('should reject what JSON loses or cannot write', function () {
		class WithToJson {
			toJSON(): string {
				return 'x';
			}
		}
		const invalid: unknown[] = [
			undefined,
			NaN,
			Infinity,
			-Infinity,
			1n,
			Symbol('s'),
			function () {},
			new Date(0),
			new Map(),
			/x/,
			new WithToJson(),
			{ toJSON: function () {} },
			new Number(1),
			{ a: undefined },
			[1, undefined],
			// eslint-disable-next-line no-sparse-arrays
			[1, , 3],
			new Array(2),
			{ a: [1, { b: NaN }] }
		];

		for (const value of invalid) expect(isJsonValue(value)).toBe(false);
	});

	it('should reject plain objects of another realm', function () {
		expect(isJsonValue(vm.runInNewContext('({ a: 1 })'))).toBe(false);
	});

	it('should ignore symbol keys, like JSON.stringify', function () {
		expect(isJsonValue({ a: 1, [Symbol('s')]: undefined })).toBe(true);
	});

	it('should reject cycles without throwing, and accept shared sub-values', function () {
		const cyclic: Record<string, unknown> = { a: 1 };

		cyclic.self = { back: cyclic };
		expect(isJsonValue(cyclic)).toBe(false);
		expect(explain(isJsonValue, cyclic)).toEqual([{ message: 'Circular reference', path: ['self', 'back'] }]);

		const array: unknown[] = [];

		array.push(array);
		expect(isJsonArray(array)).toBe(false);

		const shared = { x: [1] };

		expect(isJsonValue({ a: shared, b: [shared, shared] })).toBe(true);
		expect(explain(isJsonValue, { a: shared, b: [shared, shared] })).toEqual([]);
	});

	it('should handle very deep values without overflowing the stack', function () {
		let deep: unknown = 1;

		for (let depth = 0; depth < 200_000; depth++) deep = depth % 2 === 0 ? [deep] : { a: deep };
		expect(isJsonValue(deep)).toBe(true);
		expect(explain(isJsonValue, deep)).toEqual([]);

		let bad: unknown = NaN;

		for (let depth = 0; depth < 200_000; depth++) bad = [bad];
		expect(isJsonValue(bad)).toBe(false);
		expect(explain(isJsonValue, bad)[0].path).toHaveLength(200_000);
	});

	it('should explain every offending value, in order', function () {
		expect(explain(isJsonValue, { a: [1, Infinity, { b: undefined }], c: new Date(0), d: 1n, e: 'ok' })).toEqual([
			{ message: 'Expected a finite number (got Infinity)', path: ['a', 1] },
			{ message: 'Expected a JSON value (got undefined)', path: ['a', 2, 'b'] },
			{ message: 'Expected a JSON value (got [object Date])', path: ['c'] },
			{ message: 'Expected a JSON value (got bigint)', path: ['d'] }
		]);
		expect(explain(isJsonValue, NaN)).toEqual([{ message: 'Expected a finite number (got NaN)', path: [] }]);
		expect(explain(isJsonValue, undefined)).toEqual([{ message: 'Expected a JSON value (got undefined)', path: [] }]);
		expect(explain(isShape({ data: isJsonValue }), { data: [function () {}] })).toEqual([{ message: 'Expected a JSON value (got function)', path: ['data', 0] }]);
	});

	it('should check the root of JSON objects and arrays', function () {
		expect(isJsonObject({ a: [1] })).toBe(true);
		expect(isJsonObject([1])).toBe(false);
		expect(isJsonObject(null)).toBe(false);
		expect(isJsonObject({ a: NaN })).toBe(false);
		expect(isJsonArray([{ a: 1 }])).toBe(true);
		expect(isJsonArray({ 0: 1 })).toBe(false);
		expect(isJsonArray([NaN])).toBe(false);
		expect(explain(isJsonObject, [1])).toEqual([{ message: 'Expected a plain object (got object)', path: [] }]);
		expect(explain(isJsonArray, 'x')).toEqual([{ message: 'Expected an array (got string)', path: [] }]);
		expect(explain(isJsonArray, [1, NaN])).toEqual([{ message: 'Expected a finite number (got NaN)', path: [1] }]);
	});

	it('should narrow to the JSON types', function () {
		const value: unknown = JSON.parse('{"a":1}');

		if (isJsonObject(value)) {
			const typed: Equal<typeof value, { [key: string]: JsonValue }> = true;

			expect(typed).toBe(true);
		}
	});

	it('should accept hostile keys as plain data', function () {
		const value = JSON.parse(HOSTILE);

		expect(isJsonValue(value)).toBe(true);
		assertNotPolluted();
	});
});

describe('guards (regressions)', function () {
	it('isIntersection intersects member types even when one contains another', function () {
		const isOne = isIntersection(isFiniteNumber, isLiteral(1));
		const one: Equal<Infer<typeof isOne>, 1> = true;
		/**
		 * A guard that narrows nothing.
		 */
		function isAnything(value: unknown): value is unknown {
			return value !== Symbol.for('never');
		}
		const isNamed = isIntersection(isShape({ a: isString }), isAnything);
		const named: Equal<Infer<typeof isNamed>, { a: string }> = true;
		expect([one, named, isOne(1), isOne(2), isNamed({ a: 'x' })]).toEqual([true, true, true, false, true]);
	});

	it('PatternType keeps built-in objects compared by identity', function () {
		const re = /a/;
		const map = new Map<string, number>();
		const isConfig = isMatching({ re, map });
		const typed: Equal<PatternType<{ re: RegExp; map: Map<string, number> }>, { re: RegExp; map: Map<string, number> }> = true;
		const value: unknown = { re, map };
		expect(typed).toBe(true);
		expect(isConfig(value) && value.re.test('a') && value.map.get('a') === undefined).toBe(true);
	});

	it('isError, isPromise and isPlainObject return false for a revoked proxy', function () {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect([isError(proxy), isPromise(proxy), isPlainObject(proxy)]).toEqual([false, false, false]);
	});

	it('isJsonValue rejects objects whose toJSON the key walk would not reach', function () {
		const hidden = { a: 1 };
		Object.defineProperty(hidden, 'toJSON', {
			value: function () {
				return 5;
			}
		});
		const inherited = Object.assign(Object.create(null) as object, { a: 1 });
		Object.setPrototypeOf(inherited, {
			toJSON: function () {
				return 5;
			}
		});
		expect([isJsonValue(hidden), isJsonValue(inherited), isJsonValue([hidden])]).toEqual([false, false, false]);
		expect(explain(isJsonValue, { a: hidden })).toEqual([{ message: 'Expected a JSON value (got [object Object])', path: ['a'] }]);
	});
});
