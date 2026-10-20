// defineError, getErrorChain and formatError, compiled from the published declarations.
import { defineError, deserializeError, formatError, getErrorChain, serializeError } from 'tinkit/errors';
import type { DefinedError, DefinedErrorClass, ErrorChainOptions, FormatErrorOptions } from 'tinkit/errors';

const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404, url: undefined as string | undefined });
const error = new NotFound('No user', { cause: new Error('inner'), status: 410, url: '/users/42' });
const name: 'NotFoundError' = error.name;
const code: 'E_NOT_FOUND' = error.code;
const status: number = error.status;
const url: string | undefined = error.url;
const staticCode: 'E_NOT_FOUND' = NotFound.code;
const staticStatus: 404 = NotFound.status;
const className: 'NotFoundError' = NotFound.name;
const asError: Error = error;
new NotFound();
// @ts-expect-error the code is fixed per class
new NotFound('x', { code: 'E_OTHER' });
// @ts-expect-error fields keep their (widened) type
new NotFound('x', { status: '404' });
// @ts-expect-error only declared fields
new NotFound('x', { other: 1 });
// @ts-expect-error the code is a string
defineError('BadError', { code: 404 });

// Array and object defaults are widened deeply, as without `const`; functions and class instances keep their type.
const Detailed = defineError('DetailedError', { tags: ['a'], retry: { max: 3 }, when: new Date(0), format: String });
const detailed = new Detailed('x', { tags: ['b', 'c'], retry: { max: 5 }, when: new Date(), format: String });
const tags: string[] = detailed.tags;
const max: number = detailed.retry.max;
const when: Date = detailed.when;
const formatted: string = detailed.format(1);
const staticTags: readonly ['a'] = Detailed.tags;
// @ts-expect-error widened, not erased
new Detailed('x', { tags: [1] });

const caught: unknown = error;
if (NotFound.is(caught)) {
	const narrowed: DefinedError<'NotFoundError', { code: 'E_NOT_FOUND'; status: 404; url: string | undefined }> = caught;
	const narrowedStatus: number = caught.status;
	void [narrowed, narrowedStatus];
}

class Gone extends NotFound {
	retryable(): boolean {
		return false;
	}
}
const gone = new Gone('Gone', { status: 410 });
const goneCode: 'E_NOT_FOUND' = gone.code;
const retryable: boolean = gone.retryable();

const Plain = defineError('PlainError');
const plain: DefinedErrorClass<'PlainError'> = Plain;
// @ts-expect-error no fields
new Plain('x', { status: 1 });

const rebuilt: Error = deserializeError(serializeError(error), { classes: { NotFoundError: NotFound, Gone } });
// @ts-expect-error classes are constructors
deserializeError({}, { classes: { X: 'NotFoundError' } });

const chainOptions: ErrorChainOptions = { aggregate: true, maxDepth: 10 };
const chain: unknown[] = getErrorChain(caught, chainOptions);
const formatOptions: FormatErrorOptions = { stack: false, maxDepth: 3 };
const report: string = formatError(caught, formatOptions);
// @ts-expect-error `stack` is a boolean
formatError(caught, { stack: 'no' });

export { tags, max, when, formatted, staticTags, name, code, status, url, staticCode, staticStatus, className, asError, goneCode, retryable, plain, rebuilt, chain, report };
