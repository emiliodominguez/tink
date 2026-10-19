import {
	ensure,
	explain,
	isArrayOf,
	isFiniteNumber,
	isInteger,
	isNullable,
	isOneOf,
	isOptional,
	isRecordOf,
	isShape,
	isString,
	isTuple,
	isUnion,
	toStandardSchema,
	ValidationError,
	withMessage,
	AssertionError,
	type Infer,
	type StandardSchemaV1
} from '.';

describe('isShape', function () {
	const isUser = isShape({ id: isInteger, name: isString, email: isOptional(isString) });

	it('should check own enumerable symbol keys, which the inferred type includes', function () {
		const tag = Symbol('tag');
		const isTagged = isShape({ [tag]: isString, a: isInteger });
		expect([isTagged({ a: 1 }), isTagged({ a: 1, [tag]: 42 }), isTagged({ a: 1, [tag]: 'x' })]).toEqual([false, false, true]);
		expect(explain(isTagged, { a: 1, [tag]: 42 })).toHaveLength(1);
		expect(function () {
			isShape({ [tag]: 1 as any });
		}).toThrow(new TypeError('isShape: `shape.Symbol(tag)` must be a function, got number'));
	});

	it('should check own properties against their guards', function () {
		expect(isUser({ id: 1, name: 'Ada' })).toBe(true);
		expect(isUser({ id: 1, name: 'Ada', email: 'a@b.c', extra: true })).toBe(true);
		expect(isUser({ id: 1, name: 'Ada', email: 3 })).toBe(false);
		expect(isUser({ id: '1', name: 'Ada' })).toBe(false);
		expect(isUser({ name: 'Ada' })).toBe(false);
	});

	it('should reject non-objects, arrays and null', function () {
		for (const value of [null, undefined, 1, 'x', [], [1, 'Ada'], function () {}]) expect(isUser(value)).toBe(false);
	});

	it('should accept class instances and null-prototype objects', function () {
		class User {
			id = 1;
			name = 'Ada';
		}
		const bare = Object.assign(Object.create(null), { id: 2, name: 'Bob' });

		expect(isUser(new User())).toBe(true);
		expect(isUser(bare)).toBe(true);
	});

	it('should never read inherited properties (prototype pollution cannot satisfy a shape)', function () {
		expect(isUser(Object.create({ id: 1, name: 'Ada' }))).toBe(false);
		expect(isShape({ toString: isOptional(isString) })({})).toBe(true);
		expect(isShape({ toString: isString })({})).toBe(false);

		(Object.prototype as Record<string, unknown>).polluted = 'yes';

		try {
			expect(isShape({ polluted: isString })({})).toBe(false);
			expect(isShape({ a: isInteger }, { exact: true })({ a: 1 })).toBe(true);
			expect(explain(isShape({ polluted: isString }), {})).toEqual([{ message: 'Missing required property', path: ['polluted'] }]);
			expect(explain(isShape({ a: isInteger }, { exact: true }), { a: 1 })).toEqual([]);
		} finally {
			delete (Object.prototype as Record<string, unknown>).polluted;
		}
	});

	it('should reject unknown keys in exact mode', function () {
		const isPoint = isShape({ x: isFiniteNumber }, { exact: true });

		expect(isPoint({ x: 1 })).toBe(true);
		expect(isPoint({ x: 1, y: 2 })).toBe(false);
		expect(isShape({ x: isFiniteNumber }, { exact: false })({ x: 1, y: 2 })).toBe(true);
		expect(isPoint(Object.defineProperty({ x: 1 }, 'hidden', { value: 1, enumerable: false }))).toBe(true);
	});

	it('should copy the shape', function () {
		const shape: Record<string, (value: unknown) => value is unknown> = { a: isInteger };
		const guard = isShape(shape);

		shape.a = isString;
		shape.b = isString;
		expect(guard({ a: 1 })).toBe(true);
	});

	it('should validate its arguments', function () {
		expect(function () {
			isShape(null as never);
		}).toThrow(new TypeError('isShape: `shape` must be a plain object, got null'));
		expect(function () {
			isShape([] as never);
		}).toThrow(TypeError);
		expect(function () {
			isShape({ a: 1 } as never);
		}).toThrow(new TypeError('isShape: `shape.a` must be a function, got number'));
	});

	it('should infer optional properties', function () {
		type User = Infer<typeof isUser>;
		const user: User = { id: 1, name: 'Ada' };

		expect(isUser(user)).toBe(true);
	});
});

describe('isUnion / isOptional / isNullable / isTuple', function () {
	it('should combine guards', function () {
		const isId = isUnion(isString, isInteger);

		expect(isId('a')).toBe(true);
		expect(isId(2)).toBe(true);
		expect(isId(2.5)).toBe(false);
		expect(isOptional(isString)(undefined)).toBe(true);
		expect(isOptional(isString)(null)).toBe(false);
		expect(isNullable(isString)(null)).toBe(true);
		expect(isNullable(isString)(undefined)).toBe(false);
		expect(isNullable(isString)('x')).toBe(true);

		const isEntry = isTuple(isString, isFiniteNumber);

		expect(isEntry(['a', 1])).toBe(true);
		expect(isEntry(['a'])).toBe(false);
		expect(isEntry(['a', 1, 2])).toBe(false);
		expect(isEntry([1, 'a'])).toBe(false);
		expect(isEntry({ 0: 'a', 1: 1, length: 2 })).toBe(false);
		expect(isTuple()([])).toBe(true);
	});

	it('should validate their arguments', function () {
		expect(function () {
			isUnion();
		}).toThrow(new RangeError('isUnion: expected at least one guard, got 0'));
		expect(function () {
			isUnion(isString, 1 as never);
		}).toThrow(new TypeError('isUnion: `guards[1]` must be a function, got number'));
		expect(function () {
			isTuple(null as never);
		}).toThrow(TypeError);
		expect(function () {
			isOptional(null as never);
		}).toThrow(TypeError);
		expect(function () {
			isNullable(null as never);
		}).toThrow(TypeError);
	});
});

describe('withMessage', function () {
	it('should behave like the wrapped guard and relabel its issues', function () {
		const isAge = withMessage(isInteger, 'Age must be a whole number');

		expect(isAge(3)).toBe(true);
		expect(isAge(1.5)).toBe(false);
		expect(explain(isShape({ age: isAge }), { age: 1.5 })).toEqual([{ message: 'Age must be a whole number', path: ['age'] }]);
		expect(explain(isShape({ age: isAge }), { age: 3 })).toEqual([]);
		expect(explain(isAge, 'x')).toEqual([{ message: 'Age must be a whole number', path: [] }]);
	});

	it('should build messages from the value', function () {
		const isAge = withMessage(isInteger, function (value: unknown): string {
			return `${String(value)} is not an age`;
		});

		expect(explain(isAge, 'x')).toEqual([{ message: 'x is not an age', path: [] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			withMessage(null as never, 'x');
		}).toThrow(TypeError);
		expect(function () {
			withMessage(isInteger, 3 as never);
		}).toThrow(new TypeError('withMessage: `message` must be a string or a function, got number'));
	});
});

describe('explain', function () {
	const isOrder = isShape({
		id: isInteger,
		customer: isShape({ name: isString, email: isNullable(isString) }),
		items: isArrayOf(isShape({ sku: isString, quantity: isInteger })),
		status: isOneOf(['open', 'paid']),
		totals: isRecordOf(isFiniteNumber),
		position: isTuple(isFiniteNumber, isFiniteNumber)
	});
	const valid = { id: 1, customer: { name: 'Ada', email: null }, items: [{ sku: 'a', quantity: 2 }], status: 'open', totals: { net: 1 }, position: [0, 0] };

	it('should return no issues for valid values', function () {
		expect(explain(isOrder, valid)).toEqual([]);
	});

	it('should report every nested issue with its path', function () {
		const symbol = Symbol('s');
		const value = {
			customer: { name: 1 },
			items: [{ sku: 'a', quantity: 2 }, { sku: 2, quantity: 1.5 }, null],
			status: 'closed',
			totals: { net: 'x', [symbol]: Infinity },
			position: [0, 'y'],
			extra: true
		};

		expect(explain(isOrder, value)).toEqual([
			{ message: 'Missing required property', path: ['id'] },
			{ message: 'Invalid value (got number)', path: ['customer', 'name'] },
			{ message: 'Missing required property', path: ['customer', 'email'] },
			{ message: 'Invalid value (got number)', path: ['items', 1, 'sku'] },
			{ message: 'Invalid value (got number)', path: ['items', 1, 'quantity'] },
			{ message: 'Expected an object (got null)', path: ['items', 2] },
			{ message: 'Expected one of 2 allowed values (got string)', path: ['status'] },
			{ message: 'Invalid value (got string)', path: ['totals', 'net'] },
			{ message: 'Invalid value (got number)', path: ['totals', symbol] },
			{ message: 'Invalid value (got string)', path: ['position', 1] }
		]);
	});

	it('should report container mismatches', function () {
		expect(explain(isOrder, [])).toEqual([{ message: 'Expected an object (got array)', path: [] }]);
		expect(explain(isArrayOf(isString), 'x')).toEqual([{ message: 'Expected an array (got string)', path: [] }]);
		expect(explain(isRecordOf(isString), [])).toEqual([{ message: 'Expected a plain object (got object)', path: [] }]);
		expect(explain(isTuple(isString), ['a', 'b'])).toEqual([{ message: 'Expected a tuple of 1 elements (got 2 elements)', path: [] }]);
		expect(explain(isTuple(isString), 1)).toEqual([{ message: 'Expected a tuple of 1 elements (got number)', path: [] }]);
		expect(explain(isShape({ a: isString }, { exact: true }), { a: 'x', b: 1 })).toEqual([{ message: 'Unknown property', path: ['b'] }]);
		expect(explain(isRecordOf(isString), Object.defineProperty({ a: 1, b: 'x' }, Symbol('hidden'), { value: 1, enumerable: false }))).toEqual([
			{ message: 'Invalid value (got number)', path: ['a'] }
		]);
	});

	it('should only report the failing siblings', function () {
		const isRow = isShape({
			id: isUnion(isString, isInteger),
			note: isOptional(isString),
			age: withMessage(isInteger, 'bad age'),
			name: isString
		});

		expect(explain(isRow, { id: 1, age: 3, name: 2 })).toEqual([{ message: 'Invalid value (got number)', path: ['name'] }]);
	});

	it('should report the closest union member', function () {
		const isShapeA = isShape({ kind: isOneOf(['circle']), radius: isFiniteNumber });
		const isShapeB = isShape({ kind: isOneOf(['square']), size: isFiniteNumber });
		const isFigure = isUnion(isShapeA, isShapeB);

		expect(explain(isFigure, { kind: 'square', size: 'big' })).toEqual([{ message: 'Invalid value (got string)', path: ['size'] }]);
		expect(explain(isFigure, { kind: 'circle', radius: 1 })).toEqual([]);
		expect(explain(isUnion(isString, isInteger), 1.5)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
	});

	it('should skip optional and nullable values and describe black-box guards', function () {
		expect(explain(isOptional(isString), undefined)).toEqual([]);
		expect(explain(isOptional(isString), 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(explain(isNullable(isString), null)).toEqual([]);
		expect(explain(isNullable(isString), 1)).toEqual([{ message: 'Invalid value (got number)', path: [] }]);
		expect(explain(isString, null)).toEqual([{ message: 'Invalid value (got null)', path: [] }]);
	});

	it('should validate its arguments', function () {
		expect(function () {
			explain(null as never, 1);
		}).toThrow(new TypeError('explain: `guard` must be a function, got null'));
	});
});

describe('ensure', function () {
	const isConfig = isShape({ port: isInteger, host: isString });

	it('should return the value when it passes', function () {
		const value = { port: 80, host: 'x' };

		expect(ensure(isConfig, value)).toBe(value);
	});

	it('should throw a ValidationError listing every issue', function () {
		let caught: unknown;

		try {
			ensure(isConfig, { port: '80' });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ValidationError);
		expect(caught).toBeInstanceOf(AssertionError);
		expect((caught as ValidationError).name).toBe('ValidationError');
		expect((caught as ValidationError).message).toBe('port: Invalid value (got string); host: Missing required property');
		expect((caught as ValidationError).issues).toHaveLength(2);
		expect(function () {
			ensure(isString, 1);
		}).toThrow(new ValidationError([{ message: 'Invalid value (got number)', path: [] }]));
		expect(function () {
			ensure(isString, 1);
		}).toThrow('Invalid value (got number)');
	});
});

describe('toStandardSchema', function () {
	const schema: StandardSchemaV1<unknown, { email: string }> = toStandardSchema(isShape({ email: isString }));

	it('should implement Standard Schema v1', function () {
		expect(schema['~standard'].version).toBe(1);
		expect(schema['~standard'].vendor).toBe('tink');
		expect(schema['~standard'].validate({ email: 'a' })).toEqual({ value: { email: 'a' } });
		expect(schema['~standard'].validate({})).toEqual({ issues: [{ message: 'Missing required property', path: ['email'] }] });
	});

	it('should return the input value itself', function () {
		const value = { email: 'a' };
		const result = schema['~standard'].validate(value);

		expect('value' in result && result.value).toBe(value);
	});

	it('should validate its arguments', function () {
		expect(function () {
			toStandardSchema(undefined as never);
		}).toThrow(TypeError);
	});
});
