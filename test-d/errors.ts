import { deserializeError, getErrorMessage, isErrorLike, serializeError, toError } from 'tinkit/errors';
import type { DeserializeErrorOptions, ErrorLike, SerializedError, SerializeErrorOptions } from 'tinkit/errors';
import { getType, isArrayLike, isAsyncFunction, isBlob, isBrowser, isBun, isDeno, isGeneratorFunction, isNode, isPropertyKey, isWebWorker } from 'tinkit/guards';
import type { BlobLike, JsonValue, TypeName } from 'tinkit/guards';
import { safeStringify } from 'tinkit/objects';
import type { SafeStringifyOptions } from 'tinkit/objects';

const caught: unknown = new Error('x');
const normalized: Error = toError(caught);
const message: string = getErrorMessage(caught, 'Unknown error');
// @ts-expect-error the fallback is a string
getErrorMessage(caught, 1);
if (isErrorLike(caught)) {
	const name: string = caught.name;
	const like: ErrorLike = caught;
	void [name, like];
}
const serializeOptions: SerializeErrorOptions = { maxDepth: 3, stack: false };
const serialized: SerializedError = serializeError(caught, serializeOptions);
const serializedName: string = serialized.name;
const serializedCause: JsonValue | undefined = serialized.cause;
const code: JsonValue | undefined = serialized.code;
// @ts-expect-error `stack` is a boolean
serializeError(caught, { stack: 'no' });
const deserializeOptions: DeserializeErrorOptions = { maxDepth: Infinity };
const rebuilt: Error = deserializeError(JSON.parse('{}') as unknown, deserializeOptions);

const stringifyOptions: SafeStringifyOptions = {
	replacer: function (key: string, value: unknown): unknown {
		return key === 'secret' ? undefined : value;
	},
	space: 2,
	sortKeys: true,
	maxDepth: 10
};
const text: string | undefined = safeStringify({ a: 1n }, stringifyOptions);
safeStringify([], { replacer: ['a', 1] });
// @ts-expect-error a replacer list holds strings and numbers
safeStringify([], { replacer: [true] });

const type: TypeName = getType(caught);
// @ts-expect-error not a type name
const wrong: TypeName = 'Array';
const runtimes: boolean[] = [isNode(), isDeno(), isBun(), isBrowser(), isWebWorker()];
const value: unknown = 1;
if (isAsyncFunction(value)) {
	const result: Promise<unknown> = value();
	void result;
}
if (isGeneratorFunction(value)) {
	const iterator: Generator<unknown, unknown, unknown> = value();
	void iterator;
}
if (isPropertyKey(value)) {
	const key: PropertyKey = value;
	void key;
}
if (isArrayLike(value)) {
	const length: number = value.length;
	void length;
}
if (isBlob(value)) {
	const blob: BlobLike = value;
	const size: number = value.size;
	void [blob, size];
}

void [normalized, message, serializedName, serializedCause, code, rebuilt, text, type, wrong, runtimes];
