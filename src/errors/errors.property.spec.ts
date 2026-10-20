import fc from 'fast-check';
import { defineError, deserializeError, formatError, getErrorChain, getErrorMessage, serializeError, toError, type DefinedErrorClass } from '.';

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

/** Whether a value is printed and walked as an error (the rule of `serializeError`), for the oracles below. */
function isErrorShaped(value: unknown): value is { name?: unknown; message: unknown } {
	try {
		return value instanceof Error || (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string');
	} catch {
		return false;
	}
}

/**
 * Naive recursive oracle of `getErrorChain`: pre-order, each object once, own `cause` (not `undefined`) and, with `aggregate`, own `errors`
 * arrays before it.
 */
function naiveChain(value: unknown, aggregate: boolean): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<object>();
	/**
	 * Visits a value and everything below it.
	 * @param {unknown} current - The value
	 * @returns {void}
	 */
	function visit(current: unknown): void {
		if (typeof current === 'object' && current !== null) {
			if (seen.has(current)) return;
			seen.add(current);
		}
		chain.push(current);
		if (typeof current !== 'object' || current === null) return;
		const record = current as { cause?: unknown; errors?: unknown };
		let errors: unknown[] = [];
		let cause: unknown;
		try {
			if (aggregate && Object.hasOwn(record, 'errors') && Array.isArray(record.errors)) errors = record.errors;
			if (Object.hasOwn(record, 'cause')) cause = record.cause;
		} catch {
			// A revoked proxy: nothing below it.
		}
		errors.forEach(visit);
		if (cause !== undefined) visit(cause);
	}
	visit(value);
	return chain;
}

/** The header `formatError` prints for a value, written independently. */
function naiveHeader(value: unknown): string {
	if (!isErrorShaped(value)) return getErrorMessage(value);
	let name = 'Error';
	let message = '';
	try {
		if (typeof value.name === 'string') name = value.name;
		if (typeof value.message === 'string') message = value.message;
	} catch {
		// A throwing getter: the defaults.
	}
	return [name, message].filter(Boolean).join(': ');
}

/** A field name `defineError` accepts. */
const fieldName = fc.string({ minLength: 1 }).filter(function (key) {
	return !['code', 'stack', 'cause', 'errors', 'is'].includes(key) && !(key in Error) && !(key in Function.prototype) && !(key in Error.prototype);
});

describe('errors (1.4 properties)', function () {
	it('getErrorChain matches a naive recursive walk, with and without aggregated errors', function () {
		fc.assert(
			fc.property(fc.oneof(caught, error), fc.boolean(), function (value, aggregate) {
				const chain = getErrorChain(value, { aggregate });
				const expected = naiveChain(value, aggregate);
				expect(chain.length).toBe(expected.length);
				chain.forEach(function (item, index) {
					expect(Object.is(item, expected[index])).toBe(true);
				});
				expect(chain[0]).toBe(value);
			})
		);
	});

	it('formatError never throws, and without stacks prints one header per value of the chain', function () {
		fc.assert(
			fc.property(fc.oneof(caught, error), function (value) {
				const text = formatError(value, { stack: false });
				expect(typeof text).toBe('string');
				const chain = getErrorChain(value, { aggregate: true });
				const headers = chain.map(naiveHeader);
				// Generated values are trees: every value of the chain is printed once, on as many lines as its header has.
				expect(text.split('\n').length).toBe(
					headers.reduce(function (total, header) {
						return total + header.split('\n').length;
					}, 0)
				);
				expect(text.startsWith(headers[0].split('\n')[0])).toBe(true);
				expect(formatError(value).length).toBeGreaterThanOrEqual(text.length);
			})
		);
	});

	it('defineError classes round-trip through JSON with their code and fields, rebuilt as the class on opt-in', function () {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter(function (name) {
					return name !== 'AggregateError';
				}),
				fc.option(fc.string(), { nil: undefined }),
				fc.dictionary(fieldName, fc.jsonValue({ maxDepth: 1 }), { maxKeys: 4 }),
				fc.string(),
				function (name, code, fields, message) {
					// Typed as a class without fields: the generated field names are not known statically.
					const Defined = defineError(name, code === undefined ? fields : { ...fields, code }) as unknown as DefinedErrorClass<string>;
					const original = new Defined(message, { cause: new TypeError('inner') });
					expect(Defined.is(original)).toBe(true);
					expect(original.name).toBe(name);
					const data = JSON.parse(JSON.stringify(serializeError(original)));
					const copy = deserializeError(data, { classes: { [name]: Defined } });
					expect(copy).toBeInstanceOf(Defined);
					expect(Defined.is(copy)).toBe(true);
					expect(copy.cause).toBeInstanceOf(TypeError);
					expect(serializeError(copy)).toEqual(serializeError(original));
					// Field values went through JSON (`-0` comes back as `0`).
					for (const key of Object.keys(original))
						expect((copy as unknown as Record<string, unknown>)[key]).toEqual(viaJson((original as unknown as Record<string, unknown>)[key]));
				}
			)
		);
	});
});
