import { defineError, formatError, getErrorChain, serializeError } from 'tinkit/errors';

const NotFound = defineError('NotFoundError', { code: 'E_NOT_FOUND', status: 404 });

/** The hand-written equivalent of `NotFound`. */
class HandWritten extends Error {
	/**
	 * Creates the error.
	 * @param {string} message - The message
	 * @param {{ cause?: unknown, status?: number }} [init] - The cause and the status
	 */
	constructor(message, init) {
		super(message, init);
		this.code = 'E_NOT_FOUND';
		this.status = init?.status ?? 404;
	}
}
HandWritten.prototype.name = 'NotFoundError';

/**
 * A chain of errors, each the cause of the previous one.
 * @param {number} depth - The number of errors
 * @returns {Error} The outermost error
 */
function chainOf(depth) {
	let error = new Error('root');
	for (let i = 1; i < depth; i++) error = new Error(`level ${i}`, { cause: error });
	return error;
}

const chain10 = chainOf(10);
const instance = new NotFound('No user', { cause: new Error('inner') });

/**
 * The naive cause walk (no cycle check, no depth cap).
 * @param {unknown} error - The error
 * @returns {unknown[]} The chain
 */
function naiveChain(error) {
	const result = [];
	for (let current = error; current !== undefined; current = current instanceof Error ? current.cause : undefined) result.push(current);
	return result;
}

export default [
	{
		name: 'defineError: new NotFound(message, { status })',
		fn: function () {
			return new NotFound('No user', { status: 410 });
		},
		baseline: function () {
			return new HandWritten('No user', { status: 410 });
		}
	},
	{
		name: 'NotFound.is (match and miss)',
		fn: function () {
			return NotFound.is(instance) && !NotFound.is(chain10);
		},
		baseline: function () {
			return instance instanceof NotFound && !(chain10 instanceof NotFound);
		}
	},
	{
		name: 'getErrorChain (10 causes)',
		fn: function () {
			return getErrorChain(chain10);
		},
		baseline: function () {
			return naiveChain(chain10);
		}
	},
	{
		name: 'formatError (10 causes, with stacks)',
		fn: function () {
			return formatError(chain10);
		}
	},
	{
		name: 'serializeError (defined error with a cause)',
		fn: function () {
			return serializeError(instance);
		}
	}
];
