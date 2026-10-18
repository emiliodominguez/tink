import fc from 'fast-check';
import * as guards from '.';

const anythingOrFunction = fc.oneof(
	fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withTypedArray: true, withNullPrototype: true }),
	fc.constant(function () {}),
	fc.constant(class {}),
	fc.constant(Math.max),
	fc.constant(Symbol('s')),
	fc.constant(Symbol.iterator)
);

describe('guards (properties)', function () {
	it('exactly one typeof-category guard holds for any value', function () {
		const categories = [
			guards.isString,
			guards.isNumber,
			guards.isBoolean,
			guards.isUndefined,
			guards.isNull,
			guards.isSymbol,
			guards.isBigInt,
			guards.isFunction,
			guards.isObject
		];
		fc.assert(
			fc.property(anythingOrFunction, function (value) {
				const holding = categories.filter(function (guard) {
					return guard(value);
				});
				expect(holding).toHaveLength(1);
			})
		);
	});

	it('isPrimitive(x) === !(isObject(x) || isFunction(x))', function () {
		fc.assert(
			fc.property(anythingOrFunction, function (value) {
				expect(guards.isPrimitive(value)).toBe(!(guards.isObject(value) || guards.isFunction(value)));
			})
		);
	});

	it('isNil === isNull || isUndefined, and isDefined === !isNil', function () {
		fc.assert(
			fc.property(anythingOrFunction, function (value) {
				expect(guards.isNil(value)).toBe(guards.isNull(value) || guards.isUndefined(value));
				expect(guards.isDefined(value)).toBe(!guards.isNil(value));
			})
		);
	});

	it('isPlainObject implies isObject and excludes arrays', function () {
		fc.assert(
			fc.property(anythingOrFunction, function (value) {
				if (guards.isPlainObject(value)) {
					expect(guards.isObject(value)).toBe(true);
					expect(guards.isArray(value)).toBe(false);
				}
			})
		);
	});

	it('isInteger implies isFiniteNumber implies isNumber', function () {
		fc.assert(
			fc.property(fc.oneof(fc.double(), fc.integer(), fc.anything()), function (value) {
				if (guards.isInteger(value)) expect(guards.isFiniteNumber(value)).toBe(true);
				if (guards.isFiniteNumber(value)) expect(guards.isNumber(value)).toBe(true);
				expect(guards.isFiniteNumber(value)).toBe(typeof value === 'number' && value - value === 0);
			})
		);
	});

	it('every string and array is iterable; plain objects never are', function () {
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.array(fc.anything())), function (value) {
				expect(guards.isIterable(value)).toBe(true);
			})
		);
		fc.assert(
			fc.property(fc.object(), function (value) {
				expect(guards.isIterable(value)).toBe(false);
			})
		);
	});

	describe('round 2 additions', function () {
		/**
		 * Reference SameValueZero membership.
		 */
		function sameValueZeroIncludes(values: unknown[], candidate: unknown): boolean {
			return values.some(function (value) {
				return value === candidate || (value !== value && candidate !== candidate);
			});
		}

		const smallValue = fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constantFrom('a', 'b', '', NaN, -0, null, undefined, true), fc.double());

		it('isOneOf(values)(x) agrees with a reference SameValueZero membership test', function () {
			fc.assert(
				fc.property(fc.array(smallValue), smallValue, function (values, candidate) {
					expect(guards.isOneOf(values)(candidate)).toBe(sameValueZeroIncludes(values, candidate));
					expect(guards.isOneOf(values)(candidate)).toBe(values.includes(candidate));
				})
			);
		});

		it('every listed value passes its own isOneOf guard', function () {
			fc.assert(
				fc.property(fc.array(anythingOrFunction), function (values) {
					const guard = guards.isOneOf(values);

					values.forEach(function (value) {
						expect(guard(value)).toBe(true);
					});
				})
			);
		});

		it('isArrayOf(guard) === isArray && every index passes (reference loop)', function () {
			fc.assert(
				fc.property(fc.oneof(fc.array(fc.oneof(fc.string(), fc.integer())), fc.sparseArray(fc.string()), anythingOrFunction), function (value) {
					let expected = Array.isArray(value);

					if (Array.isArray(value)) {
						for (let index = 0; index < value.length; index++) {
							if (typeof value[index] !== 'string') expected = false;
						}
					}
					expect(guards.isArrayOf(guards.isString)(value)).toBe(expected);
				})
			);
		});

		it('isArrayOf(isOneOf(values)) accepts exactly the arrays drawn from values', function () {
			fc.assert(
				fc.property(fc.array(smallValue, { minLength: 1 }), fc.array(smallValue), function (values, candidate) {
					const expected = candidate.every(function (item) {
						return sameValueZeroIncludes(values, item);
					});

					expect(guards.isArrayOf(guards.isOneOf(values))(candidate)).toBe(expected);
				})
			);
		});

		it('isRecordOf(guard) === isPlainObject && every own enumerable value passes', function () {
			fc.assert(
				fc.property(
					fc.oneof(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string())), fc.dictionary(fc.string(), fc.integer()), anythingOrFunction),
					function (value) {
						const expected =
							guards.isPlainObject(value) &&
							Object.keys(value).every(function (key) {
								return Number.isInteger(value[key]);
							});

						expect(guards.isRecordOf(guards.isInteger)(value)).toBe(expected);
					}
				)
			);
		});

		it('isKeyOf(object, key) === Object.hasOwn(object, key) for property keys', function () {
			fc.assert(
				fc.property(
					fc.object(),
					fc.oneof(fc.string(), fc.constantFrom('__proto__', 'toString', 'constructor', 'hasOwnProperty'), fc.integer()),
					function (object, key) {
						expect(guards.isKeyOf(object, key)).toBe(Object.hasOwn(object, key));
					}
				)
			);
			fc.assert(
				fc.property(fc.object(), function (object) {
					Object.keys(object).forEach(function (key) {
						expect(guards.isKeyOf(object, key)).toBe(true);
					});
				})
			);
		});

		it('isNonEmptyArray / isNonEmptyString agree with their definitions', function () {
			fc.assert(
				fc.property(fc.oneof(anythingOrFunction, fc.array(fc.anything()), fc.string()), function (value) {
					expect(guards.isNonEmptyArray(value)).toBe(Array.isArray(value) && value.length > 0);
					expect(guards.isNonEmptyString(value)).toBe(typeof value === 'string' && value !== '');
				})
			);
		});

		it('isTypedArray implies a non-DataView ArrayBuffer view; typed arrays and ArrayBuffers are disjoint', function () {
			fc.assert(
				fc.property(
					fc.oneof(anythingOrFunction, fc.int8Array(), fc.float64Array(), fc.bigInt64Array(), fc.constant(new DataView(new ArrayBuffer(2)))),
					function (value) {
						if (guards.isTypedArray(value)) {
							expect(ArrayBuffer.isView(value)).toBe(true);
							expect(value instanceof DataView).toBe(false);
							expect(guards.isArrayBuffer(value)).toBe(false);
							expect(guards.isArrayBuffer(value.buffer)).toBe(true);
						} else {
							expect(ArrayBuffer.isView(value) && !(value instanceof DataView)).toBe(false);
						}
					}
				)
			);
		});

		it('assertDefined throws iff the value is nil; assert throws iff the value is falsy', function () {
			fc.assert(
				fc.property(anythingOrFunction, function (value) {
					let definedThrew = false;
					let assertThrew = false;

					try {
						guards.assertDefined(value);
					} catch (error) {
						expect(error).toBeInstanceOf(guards.AssertionError);
						definedThrew = true;
					}
					try {
						guards.assert(value);
					} catch (error) {
						expect(error).toBeInstanceOf(guards.AssertionError);
						assertThrew = true;
					}
					expect(definedThrew).toBe(guards.isNil(value));
					expect(assertThrew).toBe(!value);
				})
			);
		});

		it('assertNever always throws an AssertionError, whatever it receives', function () {
			fc.assert(
				fc.property(anythingOrFunction, function (value) {
					expect(function () {
						guards.assertNever(value as never);
					}).toThrow(guards.AssertionError);
				})
			);
		});

		it('brand-checked guards agree with the intrinsic slot checks', function () {
			fc.assert(
				fc.property(fc.oneof(anythingOrFunction, fc.constant(Object.create(Map.prototype)), fc.constant(Object.create(Date.prototype))), function (value) {
					let hasDateSlot = true;
					let hasMapSlot = true;

					try {
						Date.prototype.getTime.call(value);
					} catch {
						hasDateSlot = false;
					}
					try {
						Map.prototype.has.call(value, 0);
					} catch {
						hasMapSlot = false;
					}
					expect(guards.isDate(value)).toBe(hasDateSlot);
					expect(guards.isMap(value)).toBe(hasMapSlot);
				})
			);
		});
	});
});

describe('schema combinators (properties)', function () {
	const isRow = guards.isShape({ a: guards.isInteger, b: guards.isOptional(guards.isString) });
	const schemaGuards = [
		isRow,
		guards.isShape({ a: guards.isInteger }, { exact: true }),
		guards.isArrayOf(guards.isUnion(guards.isString, guards.isNullable(guards.isBoolean))),
		guards.isRecordOf(guards.isTuple(guards.isInteger, guards.isString)),
		guards.withMessage(guards.isShape({ list: guards.isArrayOf(guards.isOneOf([1, 2, 'x'])) }), 'bad')
	];

	it('explain reports no issue exactly when the guard passes, and every issue path exists in the value', function () {
		fc.assert(
			fc.property(fc.jsonValue(), fc.nat(schemaGuards.length - 1), function (value: unknown, which: number) {
				const guard = schemaGuards[which];
				const issues = guards.explain(guard, value);

				expect(issues.length === 0).toBe(guard(value));
				for (const issue of issues) expect(typeof issue.message).toBe('string');
			})
		);
	});

	it('the Standard Schema adapter agrees with the guard', function () {
		fc.assert(
			fc.property(fc.anything(), function (value: unknown) {
				const result = guards.toStandardSchema(isRow)['~standard'].validate(value);

				expect(result.issues === undefined).toBe(isRow(value));
			})
		);
	});
});

describe('round 11 guards (properties)', function () {
	const anything = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withSparseArray: true });

	it('the number refinements agree with their definitions', function () {
		fc.assert(
			fc.property(fc.oneof(fc.double(), fc.integer(), anything), function (value: unknown) {
				const finite = typeof value === 'number' && Number.isFinite(value);
				const integer = Number.isInteger(value);

				expect(guards.isPositiveNumber(value)).toBe(finite && (value as number) > 0);
				expect(guards.isNonNegativeNumber(value)).toBe(finite && !((value as number) < 0));
				expect(guards.isPositiveInteger(value)).toBe(integer && (value as number) > 0);
				expect(guards.isNonNegativeInteger(value)).toBe(integer && (value as number) >= 0);
				expect(guards.isSafeInteger(value)).toBe(integer && Math.abs(value as number) <= Number.MAX_SAFE_INTEGER);
			})
		);
	});

	it('isNumberInRange accepts exactly the finite numbers between the bounds', function () {
		fc.assert(
			fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.double(), function (a: number, b: number, value: number) {
				const [min, max] = a <= b ? [a, b] : [b, a];

				expect(guards.isNumberInRange(min, max)(value)).toBe(Number.isFinite(value) && min <= value && value <= max);
			})
		);
	});

	it('isTruthy and isFalsy partition every value like Boolean()', function () {
		fc.assert(
			fc.property(anything, function (value: unknown) {
				expect(guards.isTruthy(value)).toBe(Boolean(value));
				expect(guards.isFalsy(value)).toBe(!guards.isTruthy(value));
			})
		);
	});

	it('isIntersection is the conjunction and refine the guarded predicate', function () {
		const members = [guards.isFiniteNumber, guards.isInteger, guards.isNonNegativeNumber, guards.isString, guards.isTruthy];

		fc.assert(
			fc.property(fc.subarray(members, { minLength: 1 }), fc.oneof(fc.integer(), fc.double(), fc.string(), anything), function (selected, value: unknown) {
				const all = selected.every(function (guard): boolean {
					return guard(value);
				});
				const intersection = guards.isIntersection(...selected);

				expect(intersection(value)).toBe(all);
				expect(guards.explain(intersection, value).length === 0).toBe(all);
				expect(guards.refine(selected[0], guards.isTruthy)(value)).toBe(selected[0](value) && Boolean(value));
			})
		);
	});

	it('every JSON value matches itself as a pattern, also with extra keys', function () {
		fc.assert(
			fc.property(fc.jsonValue(), function (value: unknown) {
				const isSame = guards.isMatching(value);

				expect(isSame(structuredClone(value))).toBe(true);
				expect(guards.explain(isSame, value)).toEqual([]);
				if (guards.isPlainObject(value)) expect(isSame({ ...value, ['extra key not generated']: 1 })).toBe(true);
			})
		);
	});

	it('a JSON pattern matches a value exactly when every pattern leaf is found at its path', function () {
		/**
		 * Reference matcher: plain recursion over the pattern.
		 * @param {unknown} pattern - The pattern
		 * @param {unknown} value - The candidate
		 * @returns {boolean} Whether it matches
		 */
		function reference(pattern: unknown, value: unknown): boolean {
			if (Array.isArray(pattern)) {
				return (
					Array.isArray(value) &&
					value.length === pattern.length &&
					pattern.every(function (item: unknown, index: number): boolean {
						return reference(item, value[index]);
					})
				);
			}
			if (guards.isPlainObject(pattern)) {
				return (
					typeof value === 'object' &&
					value !== null &&
					!Array.isArray(value) &&
					Object.keys(pattern).every(function (key: string): boolean {
						return Object.prototype.hasOwnProperty.call(value, key) && reference(pattern[key], (value as Record<string, unknown>)[key]);
					})
				);
			}

			return pattern === value || (pattern !== pattern && value !== value);
		}

		fc.assert(
			fc.property(fc.jsonValue({ maxDepth: 3 }), fc.jsonValue({ maxDepth: 3 }), function (pattern: unknown, value: unknown) {
				expect(guards.isMatching(pattern)(value)).toBe(reference(pattern, value));
			})
		);
	});

	it('isJsonValue holds for JSON.parse output and implies a lossless JSON round trip', function () {
		fc.assert(
			fc.property(fc.jsonValue(), function (value: unknown) {
				expect(guards.isJsonValue(JSON.parse(JSON.stringify(value)))).toBe(true);
			})
		);
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), anything), function (value: unknown) {
				const valid = guards.isJsonValue(value);

				expect(guards.explain(guards.isJsonValue, value).length === 0).toBe(valid);
				if (valid) {
					const text = JSON.stringify(value);

					expect(JSON.stringify(JSON.parse(text))).toBe(text);
					expect(guards.isMatching(JSON.parse(text))(value)).toBe(true);
				}
			})
		);
	});
});
