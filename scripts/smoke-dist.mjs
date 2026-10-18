// Smoke-tests the BUILT package through its public `exports` map (unit tests run against `src`),
// catching packaging or minification regressions. Run after `yarn build`.
import assert from 'node:assert/strict';
import * as root from '@emiliodominguez/tink';
import { chunk } from '@emiliodominguez/tink/arrays';
import { TimeoutError, AbortError, withTimeout, retry } from '@emiliodominguez/tink/async';
import { addMonths, formatDate } from '@emiliodominguez/tink/date';
import { memoize as memoizeMethod } from '@emiliodominguez/tink/decorators';
import { debounce, curry } from '@emiliodominguez/tink/functions';
import { isPlainObject } from '@emiliodominguez/tink/guards';
import { round, sum } from '@emiliodominguez/tink/math';
import { deepClone, deepMerge, isEqual } from '@emiliodominguez/tink/objects';
import { toKebabCase, reverse } from '@emiliodominguez/tink/strings';

assert.deepEqual(Object.keys(root).sort(), [
	'arrays',
	'async',
	'cache',
	'color',
	'date',
	'decorators',
	'easing',
	'emitter',
	'format',
	'functions',
	'guards',
	'iterables',
	'math',
	'objects',
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

console.log('dist smoke test passed');
