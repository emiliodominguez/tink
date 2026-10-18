import fc from 'fast-check';
import { explain, isDiscriminatedUnion, isFiniteNumber, isInteger, isIntegerInRange, isLiteral, isShape, isString, isStringMatching, isStringOfLength, isUnion } from '.';

const anything = fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withNullPrototype: true });

describe('constraint guards (properties)', function () {
	it('isIntegerInRange(min, max) agrees with the naive definition', function () {
		fc.assert(
			fc.property(fc.integer({ min: -50, max: 50 }), fc.nat(50), fc.oneof(fc.double(), fc.integer({ min: -120, max: 120 }), anything), function (min, span, value) {
				const expected = Number.isInteger(value) && (value as number) >= min && (value as number) <= min + span;

				expect(isIntegerInRange(min, min + span)(value)).toBe(expected);
				expect(explain(isIntegerInRange(min, min + span), value)).toHaveLength(expected ? 0 : 1);
			})
		);
	});

	it('isStringOfLength(min, max) agrees with the naive definition', function () {
		fc.assert(
			fc.property(fc.nat(8), fc.nat(8), fc.oneof(fc.string({ maxLength: 20 }), anything), function (min, span, value) {
				const expected = typeof value === 'string' && value.length >= min && value.length <= min + span;

				expect(isStringOfLength(min, min + span)(value)).toBe(expected);
			})
		);
	});

	it('isStringMatching agrees with a fresh non-global copy of the pattern, call after call', function () {
		const patterns = [/^a+b*$/, /\d/, /^[a-c]{2,3}$/i, /b$/];

		fc.assert(
			fc.property(
				fc.constantFrom(...patterns),
				fc.constantFrom('g', 'y', 'gy', ''),
				fc.array(fc.stringMatching(/^[a-c0-9]{0,4}$/), { maxLength: 6 }),
				function (pattern, extra, inputs) {
					const guard = isStringMatching(new RegExp(pattern.source, pattern.flags + extra));

					for (const input of inputs) expect(guard(input)).toBe(new RegExp(pattern.source, pattern.flags).test(input));
				}
			)
		);
	});

	it('isDiscriminatedUnion is equivalent to the isUnion of the tagged shapes', function () {
		const isFast = isDiscriminatedUnion('type', { a: isShape({ x: isInteger }), b: isShape({ y: isString }), c: isShape({ x: isFiniteNumber, y: isString }) });
		const isNaive = isUnion(
			isShape({ type: isLiteral('a'), x: isInteger }),
			isShape({ type: isLiteral('b'), y: isString }),
			isShape({ type: isLiteral('c'), x: isFiniteNumber, y: isString })
		);
		const candidate = fc.oneof(
			fc.record(
				{
					type: fc.oneof(fc.constantFrom('a', 'b', 'c', 'd', 'toString', '__proto__'), anything),
					x: fc.oneof(fc.integer(), fc.double(), anything),
					y: fc.oneof(fc.string(), anything)
				},
				{ requiredKeys: [] }
			),
			anything
		);

		fc.assert(
			fc.property(candidate, function (value) {
				expect(isFast(value)).toBe(isNaive(value));
				expect(explain(isFast, value).length === 0).toBe(isNaive(value));
			})
		);
	});
});
