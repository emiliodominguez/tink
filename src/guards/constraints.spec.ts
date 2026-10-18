import * as vm from 'vm';
import { explain, isDiscriminatedUnion, isFiniteNumber, isInteger, isIntegerInRange, isShape, isString, isStringMatching, isStringOfLength, type Infer } from '.';

describe('isIntegerInRange', function () {
	const isPort = isIntegerInRange(1, 65535);

	it('should accept integers within the inclusive bounds', function () {
		expect(isPort(1)).toBe(true);
		expect(isPort(65535)).toBe(true);
		expect(isPort(8080)).toBe(true);
		expect(isIntegerInRange(-1, 1)(-0)).toBe(true);
		expect(isIntegerInRange(1, Infinity)(Number.MAX_SAFE_INTEGER)).toBe(true);
		expect(isIntegerInRange(-Infinity, 0)(-1e300)).toBe(true);
	});

	it('should reject fractions, out-of-range values and non-numbers', function () {
		for (const value of [0, 65536, 80.5, NaN, Infinity, -Infinity, '80', null, undefined, 80n, new Number(80)]) expect(isPort(value)).toBe(false);
	});

	it('should accept fractional bounds', function () {
		const isGuard = isIntegerInRange(0.5, 2.5);

		expect([0, 1, 2, 3].map(isGuard)).toEqual([false, true, true, false]);
	});

	it('should explain the range', function () {
		expect(explain(isPort, 70000)).toEqual([{ message: 'Expected an integer between 1 and 65535 (got 70000)', path: [] }]);
		expect(explain(isPort, '80')).toEqual([{ message: 'Expected an integer between 1 and 65535 (got string)', path: [] }]);
		expect(explain(isShape({ port: isPort }), { port: 1.5 })).toEqual([{ message: 'Expected an integer between 1 and 65535 (got 1.5)', path: ['port'] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			isIntegerInRange('1' as never, 2);
		}).toThrow(new TypeError('isIntegerInRange: `min` must be a number, got string'));
		expect(function () {
			isIntegerInRange(NaN, 2);
		}).toThrow(new RangeError('isIntegerInRange: `min` must be a number, got NaN'));
		expect(function () {
			isIntegerInRange(2, 1);
		}).toThrow(new RangeError('isIntegerInRange: `max` must be a number >= min (2), got 1'));
		expect(function () {
			isIntegerInRange(0, NaN);
		}).toThrow(RangeError);
		expect(function () {
			isIntegerInRange(0, null as never);
		}).toThrow(TypeError);
	});
});

describe('isStringOfLength', function () {
	it('should accept strings whose length is within the inclusive bounds', function () {
		const isUsername = isStringOfLength(3, 5);

		expect(['ab', 'abc', 'abcd', 'abcde', 'abcdef'].map(isUsername)).toEqual([false, true, true, true, false]);
		expect(isStringOfLength(0, 0)('')).toBe(true);
		expect(isStringOfLength(1, Infinity)('x'.repeat(10_000))).toBe(true);
		expect(isStringOfLength(1, Infinity)('')).toBe(false);
	});

	it('should count UTF-16 code units, like String#length', function () {
		expect(isStringOfLength(2, 2)('😀')).toBe(true);
		expect(isStringOfLength(1, 1)('😀')).toBe(false);
	});

	it('should reject non-strings', function () {
		for (const value of [null, undefined, 3, ['abc'], new String('abc'), { length: 3 }]) expect(isStringOfLength(0, Infinity)(value)).toBe(false);
	});

	it('should explain the expected and actual lengths, never the string', function () {
		expect(explain(isStringOfLength(3, 20), 'pw')).toEqual([{ message: 'Expected a string of 3 to 20 characters (got 2)', path: [] }]);
		expect(explain(isStringOfLength(8, 8), 'secret')).toEqual([{ message: 'Expected a string of exactly 8 characters (got 6)', path: [] }]);
		expect(explain(isStringOfLength(1, Infinity), '')).toEqual([{ message: 'Expected a string of at least 1 characters (got 0)', path: [] }]);
		expect(explain(isStringOfLength(1, 2), 42)).toEqual([{ message: 'Expected a string of 1 to 2 characters (got number)', path: [] }]);
		expect(explain(isShape({ name: isStringOfLength(1, 2) }), { name: 'abc' })).toEqual([{ message: 'Expected a string of 1 to 2 characters (got 3)', path: ['name'] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			isStringOfLength(-1, 2);
		}).toThrow(new RangeError('isStringOfLength: `min` must be an integer >= 0, got -1'));
		expect(function () {
			isStringOfLength(1.5, 2);
		}).toThrow(RangeError);
		expect(function () {
			isStringOfLength(Infinity, Infinity);
		}).toThrow(RangeError);
		expect(function () {
			isStringOfLength(3, 2);
		}).toThrow(new RangeError('isStringOfLength: `max` must be an integer >= min (3) or Infinity, got 2'));
		expect(function () {
			isStringOfLength(1, 2.5);
		}).toThrow(RangeError);
		expect(function () {
			isStringOfLength(1, NaN);
		}).toThrow(RangeError);
		expect(function () {
			isStringOfLength('1' as never, 2);
		}).toThrow(new TypeError('isStringOfLength: `min` must be an integer >= 0, got string'));
		expect(function () {
			isStringOfLength(1, undefined as never);
		}).toThrow(TypeError);
	});
});

describe('isStringMatching', function () {
	it('should accept strings matching the pattern', function () {
		const isHandle = isStringMatching(/^@[a-z0-9_]+$/);

		expect(isHandle('@ada_l')).toBe(true);
		expect(isHandle('ada')).toBe(false);
		expect(isHandle(['@ada'])).toBe(false);
		expect(isHandle(null)).toBe(false);
	});

	it('should be stateless with global and sticky patterns', function () {
		const global = /^\w+$/g;
		const sticky = /a/y;
		const isWord = isStringMatching(global);
		const hasA = isStringMatching(sticky);

		expect([isWord('abc'), isWord('abc'), isWord('abc')]).toEqual([true, true, true]);
		expect([hasA('a'), hasA('a')]).toEqual([true, true]);
		expect(global.lastIndex).toBe(0);
	});

	it('should keep the other flags and copy the pattern', function () {
		const pattern = /^ab.c$/isu;
		const guard = isStringMatching(pattern);

		pattern.lastIndex = 3;
		expect(guard('AB\nC')).toBe(true);
		expect(isStringMatching(/^\p{Lu}$/u)('É')).toBe(true);
	});

	it('should accept patterns from other realms', function () {
		expect(isStringMatching(vm.runInNewContext('/^x+$/'))('xxx')).toBe(true);
	});

	it('should explain the pattern, never the string', function () {
		expect(explain(isStringMatching(/^@\w+$/g), 'hunter2')).toEqual([{ message: 'Expected a string matching /^@\\w+$/ (got string)', path: [] }]);
		expect(explain(isStringMatching(/x/i), 1)).toEqual([{ message: 'Expected a string matching /x/i (got 1)', path: [] }]);
	});

	it('should validate its argument', function () {
		expect(function () {
			isStringMatching('^a$' as never);
		}).toThrow(new TypeError('isStringMatching: `pattern` must be a RegExp, got string'));
		expect(function () {
			isStringMatching(Object.create(RegExp.prototype));
		}).toThrow(TypeError);
	});
});

describe('isDiscriminatedUnion', function () {
	const isFigure = isDiscriminatedUnion('type', {
		circle: isShape({ radius: isFiniteNumber }),
		square: isShape({ side: isFiniteNumber })
	});

	it('should check the variant named by the discriminant', function () {
		expect(isFigure({ type: 'circle', radius: 2 })).toBe(true);
		expect(isFigure({ type: 'square', side: 2, extra: true })).toBe(true);
		expect(isFigure({ type: 'square', radius: 2 })).toBe(false);
		expect(isFigure({ type: 'hexagon', side: 2 })).toBe(false);
		expect(isFigure({ radius: 2 })).toBe(false);
	});

	it('should narrow to the tagged variants', function () {
		const value: unknown = { type: 'circle', radius: 1 };

		if (isFigure(value)) {
			const area = value.type === 'circle' ? value.radius ** 2 : value.side ** 2;

			expect(area).toBe(1);
		}

		const figure: Infer<typeof isFigure> = { type: 'square', side: 3 };

		expect(isFigure(figure)).toBe(true);
	});

	it('should reject non-objects, arrays and null', function () {
		for (const value of [null, undefined, 'circle', 1, [], ['circle'], function () {}]) expect(isFigure(value)).toBe(false);
	});

	it('should only match string tags held as own properties', function () {
		expect(isFigure(Object.create({ type: 'circle', radius: 1 }))).toBe(false);
		expect(isFigure(Object.assign(Object.create({ type: 'circle' }), { radius: 1 }))).toBe(false);
		expect(isDiscriminatedUnion('kind', { 1: isShape({}) })({ kind: 1 })).toBe(false);
		expect(isDiscriminatedUnion('kind', { 1: isShape({}) })({ kind: '1' })).toBe(true);
		for (const tag of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) expect(isFigure({ type: tag })).toBe(false);
	});

	it('should accept null-prototype objects and class instances', function () {
		class Circle {
			type = 'circle';
			radius = 1;
		}

		expect(isFigure(Object.assign(Object.create(null), { type: 'square', side: 1 }))).toBe(true);
		expect(isFigure(new Circle())).toBe(true);
	});

	it('should explain the issues of the matching variant only', function () {
		expect(explain(isFigure, { type: 'square', side: '2' })).toEqual([{ message: 'Invalid value (got string)', path: ['side'] }]);
		expect(explain(isFigure, { type: 'circle', radius: 1 })).toEqual([]);
		expect(explain(isShape({ figures: isShape({ main: isFigure }) }), { figures: { main: { type: 'circle' } } })).toEqual([
			{ message: 'Missing required property', path: ['figures', 'main', 'radius'] }
		]);
	});

	it('should explain an unknown or missing discriminant', function () {
		expect(explain(isFigure, { type: 'hexagon' })).toEqual([{ message: 'Expected "circle" or "square" (got string)', path: ['type'] }]);
		expect(explain(isFigure, { type: 3 })).toEqual([{ message: 'Expected "circle" or "square" (got number)', path: ['type'] }]);
		expect(explain(isFigure, {})).toEqual([{ message: 'Missing required property', path: ['type'] }]);
		expect(explain(isDiscriminatedUnion('kind', { a: isShape({}) }), { kind: 'b' })).toEqual([{ message: 'Expected "a" (got string)', path: ['kind'] }]);
		expect(explain(isDiscriminatedUnion('kind', { a: isShape({}), b: isShape({}), c: isShape({}) }), { kind: 'd' })).toEqual([
			{ message: 'Expected "a", "b" or "c" (got string)', path: ['kind'] }
		]);
	});

	it('should explain non-objects', function () {
		expect(explain(isFigure, null)).toEqual([{ message: 'Expected an object (got null)', path: [] }]);
		expect(explain(isFigure, [])).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
	});

	it('should accept any guard as a variant', function () {
		const isEvent = isDiscriminatedUnion('kind', {
			tick: function (value: unknown): value is { at: number } {
				return isInteger((value as { at?: unknown }).at);
			}
		});

		expect(isEvent({ kind: 'tick', at: 1 })).toBe(true);
		expect(explain(isEvent, { kind: 'tick' })).toEqual([{ message: 'Invalid value (got object)', path: [] }]);
	});

	it('should copy the variants', function () {
		const variants: Record<string, (value: unknown) => value is unknown> = { a: isShape({ x: isString }) };
		const guard = isDiscriminatedUnion('kind', variants);

		variants.a = isShape({ x: isInteger });
		variants.b = isShape({});
		expect(guard({ kind: 'a', x: 'x' })).toBe(true);
		expect(guard({ kind: 'b' })).toBe(false);
	});

	it('should validate its arguments', function () {
		expect(function () {
			isDiscriminatedUnion(1 as never, { a: isString });
		}).toThrow(new TypeError('isDiscriminatedUnion: `key` must be a string, got number'));
		expect(function () {
			isDiscriminatedUnion('type', [isString] as never);
		}).toThrow(new TypeError('isDiscriminatedUnion: `variants` must be a plain object, got object'));
		expect(function () {
			isDiscriminatedUnion('type', null as never);
		}).toThrow(TypeError);
		expect(function () {
			isDiscriminatedUnion('type', {});
		}).toThrow(new RangeError('isDiscriminatedUnion: `variants` must have at least one variant, got 0'));
		expect(function () {
			isDiscriminatedUnion('type', { a: isString, b: 'nope' as never });
		}).toThrow(new TypeError('isDiscriminatedUnion: `variants.b` must be a function, got string'));
	});
});
