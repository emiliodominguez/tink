import fc from 'fast-check';
import { deserializeError, getErrorMessage, serializeError, toError } from '.';

const BUILT_INS = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError];

/** Anything a `catch` block could receive, hostile values included. */
const caught = fc.oneof(
	fc.anything({ withBigInt: true, withBoxedValues: true, withDate: true, withMap: true, withSet: true, withTypedArray: true, withNullPrototype: true }),
	fc.string().map(function (message) {
		return new Error(message);
	}),
	fc.record({ name: fc.string(), message: fc.string() }),
	fc.constant(Symbol('thrown')),
	fc.constant(function thrown() {}),
	// fast-check itself cannot handle a revoked proxy as a generated value: it is nested in an object or an error.
	fc.boolean().map(function (inError): object {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		return inError ? new Error('revoked', { cause: proxy }) : { message: 'revoked', proxy };
	}),
	fc.constant({
		get message(): never {
			throw new Error('getter');
		}
	})
);

/** A JSON-safe property value for errors. */
const extra = fc.jsonValue({ maxDepth: 2 });

/** Errors of the built-in classes (or with another name), with properties, causes and aggregated errors. */
const error: fc.Arbitrary<Error> = fc.letrec(function (tie) {
	return {
		error: fc
			.record({
				kind: fc.oneof(
					fc.constantFrom(
						...BUILT_INS.map(function (Constructor) {
							return Constructor.name;
						}),
						'AggregateError'
					),
					fc.string()
				),
				message: fc.string(),
				code: fc.option(fc.string(), { nil: undefined }),
				extra: fc.option(extra, { nil: undefined }),
				cause: fc.option(fc.oneof({ depthSize: 'small' }, extra, tie('error')), { nil: undefined }),
				errors: fc.array(fc.oneof({ depthSize: 'small' }, extra, tie('error')), { maxLength: 2 })
			})
			.map(function ({ kind, message, code, extra: value, cause, errors }) {
				const Constructor = BUILT_INS.find(function (candidate) {
					return candidate.name === kind;
				});
				const options = cause === undefined ? undefined : { cause };
				const created =
					kind === 'AggregateError'
						? new AggregateError(errors, message, options)
						: Constructor
							? new Constructor(message, options)
							: Object.assign(new Error(message, options), { name: kind });
				if (code !== undefined) Object.assign(created, { code });
				if (value !== undefined) Object.assign(created, { value });
				return created;
			})
	};
}).error as fc.Arbitrary<Error>;

/** The class, name and message of each error of a cause chain, then what ends it (as JSON gives it back). */
function causeChain(value: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = value;
	while (current instanceof Error) {
		chain.push([Object.getPrototypeOf(current).constructor.name, current.name, current.message]);
		current = current.cause;
	}
	chain.push(current === undefined ? undefined : JSON.parse(JSON.stringify(current)));
	return chain;
}

/** A value as it comes back from JSON. */
function viaJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

describe('errors (properties)', function () {
	it('serialize → JSON → deserialize preserves the class, name, message and cause chain', function () {
		fc.assert(
			fc.property(error, function (original) {
				const copy = deserializeError(JSON.parse(JSON.stringify(serializeError(original))));
				expect(causeChain(copy)).toEqual(causeChain(original));
				expect(copy.stack).toBe(original.stack);
				expect(viaJson(serializeError(copy))).toEqual(viaJson(serializeError(original)));
			})
		);
	});

	it('serializeError never throws, gives JSON-safe data, and is idempotent', function () {
		fc.assert(
			fc.property(fc.oneof(caught, error), fc.option(fc.nat(4), { nil: undefined }), function (value, maxDepth) {
				const serialized = serializeError(value, { maxDepth });
				expect(typeof serialized.name).toBe('string');
				expect(typeof serialized.message).toBe('string');
				expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
				expect(serializeError(serialized)).toEqual(serialized);
			})
		);
	});

	it('toError never throws, keeps errors and is idempotent', function () {
		fc.assert(
			fc.property(fc.oneof(caught, error), function (value) {
				const normalized = toError(value);
				expect(normalized).toBeInstanceOf(Error);
				expect(toError(normalized)).toBe(normalized);
				if (value instanceof Error) expect(normalized).toBe(value);
				else {
					expect(normalized.cause).toBe(value);
					expect(normalized.message).toBe(getErrorMessage(value));
				}
			})
		);
	});

	it('getErrorMessage never throws and only uses the fallback when there is no message', function () {
		fc.assert(
			fc.property(fc.oneof(caught, error), fc.string(), function (value, fallback) {
				const message = getErrorMessage(value);
				expect(typeof message).toBe('string');
				const withFallback = getErrorMessage(value, fallback);
				expect(withFallback === message || withFallback === fallback).toBe(true);
				const own = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
				if (own !== '') expect(withFallback).toBe(own);
			})
		);
	});

	it('deserializeError never throws and rebuilds any data', function () {
		fc.assert(
			fc.property(fc.oneof(caught, fc.jsonValue()), function (data) {
				expect(deserializeError(data)).toBeInstanceOf(Error);
			})
		);
	});
});
