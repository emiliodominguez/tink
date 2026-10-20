// Result helpers, when / unless and cond, compiled from the published declarations.
import { attempt, cond, constant, err, isErr, isOk, mapResult, ok, unless, unwrap, when } from 'tinkit/functions';
import type { Result } from 'tinkit/functions';

const success: [error: undefined, result: number] = ok(1);
const failure: [error: RangeError, result: undefined] = err(new RangeError('x'));
const result: Result<number> = attempt(Math.sqrt, 16);
if (isOk(result)) {
	const value: number = result[1];
	void value;
}
if (isErr(result)) {
	const error: unknown = result[0];
	const nothing: undefined = result[1];
	void [error, nothing];
}
const mapped: Result<string> = mapResult(result, String);
const unwrapped: number = unwrap(result);
const fromOk: Result<number> = success;
const fromErr: Result<number> = failure;

declare function isString(value: unknown): value is string;
const trim = when(isString, function (text) {
	return text.trim();
});
const trimmed: string | number = trim('x' as string | number);
const positive = when(
	function (n: number) {
		return n < 0;
	},
	function (n) {
		return -n;
	}
);
const absolute: number = positive(-1);
// @ts-expect-error the predicate takes numbers
positive('x');
const stringify = unless(isString, function (value) {
	return JSON.stringify(value);
});
const text: string = stringify(1 as string | number);

const sign = cond([
	[
		function (n: number) {
			return n < 0;
		},
		constant('negative' as const)
	],
	[
		function (n: number) {
			return n === 0;
		},
		function () {
			return 0 as const;
		}
	],
	[
		constant(true),
		function (n) {
			return n > 1 ? n : null;
		}
	]
]);
const signed: 'negative' | 0 | number | null | undefined = sign(5);
// @ts-expect-error the result may be undefined (no pair matched)
const defined: 'negative' | 0 | number | null = sign(5);
// @ts-expect-error the predicates take numbers
sign('x');
const pair = cond([
	[
		function (a: string, b: number) {
			return a.length > b;
		},
		function (a, b) {
			return a.repeat(b);
		}
	]
]);
const repeated: string | undefined = pair('ab', 1);
const none: undefined = cond([])();

export { success, failure, mapped, unwrapped, fromOk, fromErr, trimmed, absolute, text, signed, defined, repeated, none };
