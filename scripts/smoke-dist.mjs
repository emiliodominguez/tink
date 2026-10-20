// Smoke-tests the BUILT package through its public `exports` map (unit tests run against `src`),
// catching packaging or minification regressions. Run after `yarn build`.
import assert from 'node:assert/strict';
import * as root from 'tinkit';
import { chunk } from 'tinkit/arrays';
import { TimeoutError, AbortError, withTimeout, retry } from 'tinkit/async';
import { addMonths, formatDate, nextCronDate } from 'tinkit/date';
import { memoize as memoizeMethod } from 'tinkit/decorators';
import { crc32, hmacSha256Hex, signJwt, verifyJwt } from 'tinkit/encoding';
import { deserializeError, serializeError } from 'tinkit/errors';
import { debounce, curry } from 'tinkit/functions';
import { isPlainObject } from 'tinkit/guards';
import { parseSSE } from 'tinkit/iterables';
import { round, sum } from 'tinkit/math';
import { deepClone, deepMerge, isEqual, safeStringify } from 'tinkit/objects';
import { normalizePath, relativePath } from 'tinkit/path';
import { toKebabCase, reverse } from 'tinkit/strings';
import { satisfiesSemver } from 'tinkit/validate';

assert.deepEqual(Object.keys(root).sort(), [
	'arrays',
	'async',
	'cache',
	'color',
	'date',
	'decorators',
	'easing',
	'emitter',
	'encoding',
	'errors',
	'format',
	'functions',
	'guards',
	'iterables',
	'math',
	'objects',
	'path',
	'random',
	'search',
	'store',
	'strings',
	'url',
	'validate'
]);
assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
assert.equal(round(1.005, 2), 1.01);
assert.equal(sum([0.1, 0.2, 0.3]), 0.6);
assert.equal(toKebabCase('XMLHttpRequest'), 'xml-http-request');
assert.equal(reverse('a👍🏽b'), 'b👍🏽a');
assert.equal(isPlainObject({}), true);
assert.equal(formatDate(addMonths(new Date(2024, 0, 31), 1), 'YYYY-MM-DD'), '2024-02-29');
assert.equal(
	curry(function (a, b) {
		return a + b;
	})(1)(2),
	3
);

const cyclic = { list: [1, 2] };
cyclic.self = cyclic;
const copy = deepClone(cyclic);
assert.ok(copy !== cyclic && copy.self === copy && isEqual(copy, cyclic));
assert.equal(deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}')).polluted, undefined);
assert.equal({}.polluted, undefined);
assert.equal(safeStringify(cyclic), '{"list":[1,2],"self":"[Circular]"}');
const rebuilt = deserializeError(JSON.parse(JSON.stringify(serializeError(new TypeError('outer', { cause: new RangeError('inner') })))));
assert.ok(rebuilt instanceof TypeError && rebuilt.cause instanceof RangeError && rebuilt.cause.message === 'inner');

assert.equal(new TimeoutError().name, 'TimeoutError');
assert.equal(new AbortError().name, 'AbortError');
await assert.rejects(withTimeout(new Promise(function () {}), 1), { name: 'TimeoutError' });

let attempts = 0;
assert.equal(
	await retry(function () {
		attempts += 1;
		if (attempts < 2) throw new Error('flaky');
		return 'ok';
	}),
	'ok'
);

const calls = [];
const debounced = debounce(function (value) {
	calls.push(value);
}, 10);
debounced('a');
debounced('b');
debounced.flush();
assert.deepEqual(calls, ['b']);

// Decorators applied manually with the TC39 standard signature (no transpiler needed).
class Counter {
	runs = 0;
	square(value) {
		this.runs += 1;
		return value * value;
	}
}
Counter.prototype.square = memoizeMethod(Counter.prototype.square, { kind: 'method', name: 'square', static: false, private: false, addInitializer() {} });
const counter = new Counter();
assert.equal(counter.square(3) + counter.square(3), 18);
assert.equal(counter.runs, 1);

assert.equal(normalizePath('/a/./b/../c//d/'), '/a/c/d/');
assert.equal(relativePath('/data/orandea/test/aaa', '/data/orandea/impl/bbb'), '../../impl/bbb');
assert.equal(satisfiesSemver('1.2.3-beta.1', '^1.2.3-alpha'), true);
assert.equal(satisfiesSemver('2.0.0', '1.x || >=2.1 <3'), false);
assert.equal(nextCronDate('30 2 * * *', { from: new Date('2024-03-10T00:00:00Z'), timeZone: 'UTC' }).toISOString(), '2024-03-10T02:30:00.000Z');
assert.equal(crc32('123456789'), 0xcbf43926);
assert.equal(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
assert.equal(verifyJwt(signJwt({ sub: 'a' }, 'secret'), 'secret').payload.sub, 'a');
const events = [];
for await (const event of parseSSE(['data: hel', 'lo\n\nevent: x\ndata: 1\n\n'])) events.push(event);
assert.deepEqual(
	events.map(function (event) {
		return [event.event, event.data];
	}),
	[
		['message', 'hello'],
		['x', '1']
	]
);

console.log('dist smoke test passed');
