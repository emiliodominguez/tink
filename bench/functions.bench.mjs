import {
	after,
	allPass,
	anyPass,
	attempt,
	before,
	compose,
	constant,
	curry,
	debounce,
	defaultMemoizeKey,
	flip,
	identity,
	match,
	memoize,
	memoizeLast,
	negate,
	noop,
	once,
	partial,
	partialRight,
	pipe,
	throttle,
	times,
	unary
} from 'tinkit/functions';
import { memoize as memoizeDecorator } from 'tinkit/decorators';
import * as esToolkit from 'es-toolkit';
import * as esCompat from 'es-toolkit/compat';
import * as lodash from 'lodash-es';
import * as remeda from 'remeda';

/**
 * A cheap function to wrap, so the benchmarks measure the wrapper rather than the work.
 * @param {number} a - First operand
 * @param {number} [b=0] - Second operand
 * @returns {number} The sum
 */
function add(a, b = 0) {
	return a + b;
}

/**
 * A cheap three-argument function to curry.
 * @param {number} a - First operand
 * @param {number} b - Second operand
 * @param {number} c - Third operand
 * @returns {number} The sum
 */
function add3(a, b, c) {
	return a + b + c;
}

/**
 * A cheap predicate to negate.
 * @param {number} n - A number
 * @returns {boolean} Whether `n` is even
 */
function isEven(n) {
	return n % 2 === 0;
}

/**
 * Doubles a number.
 * @param {number} n - A number
 * @returns {number} `n * 2`
 */
function double(n) {
	return n * 2;
}

/**
 * Decrements a number.
 * @param {number} n - A number
 * @returns {number} `n - 1`
 */
function dec(n) {
	return n - 1;
}

/**
 * Divides two numbers (argument order matters, for `flip`).
 * @param {number} a - Dividend
 * @param {number} b - Divisor
 * @returns {number} `a / b`
 */
function divide(a, b) {
	return a / b;
}

const keys = Array.from({ length: 100 }, function (_, index) {
	return index;
});
const words = keys.map(function (n) {
	return `word-${n}`;
});
const points = keys.map(function (n) {
	return { x: n, y: n * 2 };
});

/**
 * Sums a point's coordinates.
 * @param {{ x: number, y: number }} point - The point
 * @returns {number} `x + y`
 */
function sumPoint(point) {
	return point.x + point.y;
}

/**
 * Measures a word.
 * @param {string} word - The word
 * @returns {number} Its length
 */
function wordLength(word) {
	return word.length;
}

// memoize: ours keys a single primitive by itself (like es-toolkit/lodash) and serialises everything else by value (es-toolkit and
// lodash key objects by identity and ignore every argument but the first), so the object/multi-arg cases are not like for like.
/**
 * @param {number} n - A number
 * @returns {boolean} Whether `n` is positive
 */
function isPositive(n) {
	return n > 0;
}
/**
 * @param {number} n - A number
 * @returns {boolean} Whether `n` is a multiple of 3
 */
function isMultipleOf3(n) {
	return n % 3 === 0;
}
const evenPositive3 = allPass(isEven, isPositive, isMultipleOf3);
const remedaAll = remeda.allPass([isEven, isPositive, isMultipleOf3]);
const lodashAll = lodash.overEvery([isEven, isPositive, isMultipleOf3]);
const evenOrPositive3 = anyPass(isEven, isPositive, isMultipleOf3);
const remedaAny = remeda.anyPass([isEven, isPositive, isMultipleOf3]);
const lodashAny = lodash.overSome([isEven, isPositive, isMultipleOf3]);
const signed = keys.map(function (n) {
	return n - 50;
});
const rightAdd3 = partialRight(add3, 2, 3);
const esRightAdd3 = esToolkit.partialRight(add3, 2, 3);
const lodashRightAdd3 = lodash.partialRight(add3, 2, 3);
const shapes = keys.map(function (n) {
	return n % 3 === 0 ? { kind: 'circle', radius: n } : n % 3 === 1 ? { kind: 'square', size: n } : { kind: 'rect', width: n, height: 2 };
});
const shapeHandlers = {
	circle: function (shape) {
		return 3 * shape.radius * shape.radius;
	},
	square: function (shape) {
		return shape.size * shape.size;
	},
	rect: function (shape) {
		return shape.width * shape.height;
	}
};
/**
 * The hand-written equivalent of `match(shape, 'kind', shapeHandlers)`.
 * @param {{ kind: string }} shape - A shape
 * @returns {number} Its area
 */
function areaSwitch(shape) {
	switch (shape.kind) {
		case 'circle':
			return 3 * shape.radius * shape.radius;
		case 'square':
			return shape.size * shape.size;
		case 'rect':
			return shape.width * shape.height;
		default:
			throw new Error('unreachable');
	}
}
const memoAdd = memoize(add);
const esMemoAdd = esToolkit.memoize(add);
const lodashMemoAdd = lodash.memoize(add);
const memoWord = memoize(wordLength);
const esMemoWord = esToolkit.memoize(wordLength);
const lodashMemoWord = lodash.memoize(wordLength);
const memoPoint = memoize(sumPoint);
const memoPointById = memoize(sumPoint, {
	resolver: function (point) {
		return point;
	}
});
const esMemoPoint = esToolkit.memoize(sumPoint);
const lodashMemoPoint = lodash.memoize(sumPoint);
const lastAdd = memoizeLast(add);

const piped = pipe(add, double, dec);
const esFlow = esToolkit.flow(add, double, dec);
const lodashFlow = lodash.flow(add, double, dec);
const composed = compose(dec, double, add);
const esFlowRight = esToolkit.flowRight(dec, double, add);
const lodashFlowRight = lodash.flowRight(dec, double, add);

const debounced = debounce(add, 1000);
const esDebounced = esToolkit.debounce(add, 1000);
const lodashDebounced = lodash.debounce(add, 1000);
const throttled = throttle(add, 1000);
const esThrottled = esToolkit.throttle(add, 1000);
const lodashThrottled = lodash.throttle(add, 1000);

// Flush cost: a fresh pending call is flushed each time (the trailing invocation runs synchronously).
const flushDebounced = debounce(add, 1000);
const lodashFlushDebounced = lodash.debounce(add, 1000);
const esFlushDebounced = esToolkit.debounce(add, 1000);

const onceAdd = once(add);
const esOnceAdd = esToolkit.once(add);
const lodashOnceAdd = lodash.once(add);

const curried = curry(add3);
const esCurried = esToolkit.curry(add3);
const lodashCurried = lodash.curry(add3);

const partialAdd = partial(add, 1);
const esPartialAdd = esToolkit.partial(add, 1);
const lodashPartialAdd = lodash.partial(add, 1);

const isOdd = negate(isEven);
const esIsOdd = esToolkit.negate(isEven);
const lodashIsOdd = lodash.negate(isEven);

const unaryAdd = unary(add);
const esUnaryAdd = esToolkit.unary(add);
const lodashUnaryAdd = lodash.unary(add);

const flipped = flip(divide);
const esFlipped = esCompat.flip(divide);
const lodashFlipped = lodash.flip(divide);

const beforeAdd = before(1e15, add);
const esBeforeAdd = esToolkit.before(1e15, add);
const lodashBeforeAdd = lodash.before(1e15, add);
const afterAdd = after(0, add);
const esAfterAdd = esToolkit.after(0, add);
const lodashAfterAdd = lodash.after(0, add);

const zero = constant(0);
const lodashZero = lodash.constant(0);

// Standard (TC39) decorator call shape: `memoize(method, context)` returns the replacement method.
const memoMethod = memoizeDecorator(add, { kind: 'method', name: 'add' });
const instance = {};

// Warm the caches so the benchmarks measure hits.
for (const n of keys) {
	for (const fn of [memoAdd, esMemoAdd, lodashMemoAdd]) fn(n);
	memoAdd(n, n);
	for (const fn of [memoPoint, memoPointById, esMemoPoint, lodashMemoPoint]) fn(points[n]);
	for (const fn of [memoWord, esMemoWord, lodashMemoWord]) fn(words[n]);
	memoMethod.call(instance, n, n);
}
onceAdd(1, 2);
esOnceAdd(1, 2);
lodashOnceAdd(1, 2);

export default [
	{
		name: 'memoize hit (1 number arg, 100 keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoAdd(keys[i]);
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += add(keys[i]);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esMemoAdd(keys[i]);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashMemoAdd(keys[i]);
				return total;
			}
		}
	},
	{
		name: 'memoize hit (1 string arg, 100 keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoWord(words[i]);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esMemoWord(words[i]);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashMemoWord(words[i]);
				return total;
			}
		}
	},
	{
		name: 'memoize hit (2 number args, 100 keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoAdd(keys[i], keys[i]);
			return total;
		}
	},
	{
		name: 'memoize hit (1 object arg, by value, 100 keys)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoPoint(points[i]);
			return total;
		}
	},
	{
		name: 'memoize hit (1 object arg, identity resolver)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoPointById(points[i]);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esMemoPoint(points[i]);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashMemoPoint(points[i]);
				return total;
			}
		}
	},
	{
		name: 'defaultMemoizeKey (2 args: string, number)',
		fn: function () {
			let key;
			for (let i = 0; i < 100; i++) key = defaultMemoizeKey(words[i], i);
			return key;
		}
	},
	{
		name: '@memoize method hit (2 number args)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += memoMethod.call(instance, keys[i], keys[i]);
			return total;
		}
	},
	{
		name: 'memoizeLast hit (2 args)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += lastAdd(1, 2);
			return total;
		}
	},
	{
		name: 'pipe (3 functions)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += piped(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esFlow(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashFlow(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'compose (3 functions)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += composed(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esFlowRight(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashFlowRight(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'pipe/compose creation (3 functions)',
		fn: function () {
			return pipe(add, double, dec);
		},
		competitors: {
			'es-toolkit': function () {
				return esToolkit.flow(add, double, dec);
			},
			lodash: function () {
				return lodash.flow(add, double, dec);
			}
		}
	},
	{
		name: 'debounce call (pending burst)',
		fn: function () {
			for (let i = 0; i < 100; i++) debounced(i, 1);
			return debounced.pending();
		},
		competitors: {
			'es-toolkit': function () {
				for (let i = 0; i < 100; i++) esDebounced(i, 1);
				return esDebounced;
			},
			lodash: function () {
				for (let i = 0; i < 100; i++) lodashDebounced(i, 1);
				return lodashDebounced;
			}
		}
	},
	{
		name: 'debounce call + flush',
		fn: function () {
			let result;
			for (let i = 0; i < 100; i++) {
				flushDebounced(i, 1);
				result = flushDebounced.flush();
			}
			return result;
		},
		competitors: {
			'es-toolkit': function () {
				let result;
				for (let i = 0; i < 100; i++) {
					esFlushDebounced(i, 1);
					result = esFlushDebounced.flush();
				}
				return result;
			},
			lodash: function () {
				let result;
				for (let i = 0; i < 100; i++) {
					lodashFlushDebounced(i, 1);
					result = lodashFlushDebounced.flush();
				}
				return result;
			}
		}
	},
	{
		name: 'throttle call (inside window)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += throttled(keys[i], 1) ?? 0;
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esThrottled(keys[i], 1) ?? 0;
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashThrottled(keys[i], 1) ?? 0;
				return total;
			}
		}
	},
	{
		name: 'once (after the first call)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += onceAdd(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esOnceAdd(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashOnceAdd(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'curry (one argument at a time)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += curried(i)(1)(2);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esCurried(i)(1)(2);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashCurried(i)(1)(2);
				return total;
			}
		}
	},
	{
		name: 'curry (all arguments at once)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += curried(i, 1, 2);
			return total;
		},
		competitors: {
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashCurried(i, 1, 2);
				return total;
			}
		}
	},
	{
		name: 'partial (1 pre-applied arg)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += partialAdd(keys[i]);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esPartialAdd(keys[i]);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashPartialAdd(keys[i]);
				return total;
			}
		}
	},
	{
		name: 'negate',
		fn: function () {
			let count = 0;
			for (let i = 0; i < 100; i++) if (isOdd(keys[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < 100; i++) if (esIsOdd(keys[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < 100; i++) if (lodashIsOdd(keys[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'unary (called with 2 args)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += unaryAdd(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esUnaryAdd(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashUnaryAdd(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'flip (2 args)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += flipped(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit/compat': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esFlipped(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashFlipped(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'before (still invoking)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += beforeAdd(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esBeforeAdd(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashBeforeAdd(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'after (invoking)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += afterAdd(keys[i], 1);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esAfterAdd(keys[i], 1);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashAfterAdd(keys[i], 1);
				return total;
			}
		}
	},
	{
		name: 'attempt (success, 2 args)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += attempt(add, i, 1)[1];
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++)
					total += esToolkit.attempt(function () {
						return add(i, 1);
					})[1];
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodash.attempt(add, i, 1);
				return total;
			}
		}
	},
	{
		name: 'attempt (failure)',
		fn: function () {
			return attempt(JSON.parse, '{')[0];
		},
		competitors: {
			'es-toolkit': function () {
				return esToolkit.attempt(function () {
					return JSON.parse('{');
				})[0];
			},
			lodash: function () {
				return lodash.attempt(JSON.parse, '{');
			}
		}
	},
	{
		name: 'times (1k)',
		fn: function () {
			return times(1000, double);
		},
		competitors: {
			'es-toolkit/compat': function () {
				return esCompat.times(1000, double);
			},
			lodash: function () {
				return lodash.times(1000, double);
			}
		}
	},
	{
		name: 'times (10)',
		fn: function () {
			return times(10, double);
		},
		competitors: {
			'es-toolkit/compat': function () {
				return esCompat.times(10, double);
			},
			lodash: function () {
				return lodash.times(10, double);
			}
		}
	},
	{
		name: 'identity / noop / constant',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) {
				noop(i);
				total += identity(i) + zero(i);
			}
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) {
					esToolkit.noop(i);
					total += esToolkit.identity(i) + lodashZero(i);
				}
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) {
					lodash.noop(i);
					total += lodash.identity(i) + lodashZero(i);
				}
				return total;
			}
		}
	},
	{
		name: 'partialRight (2 bound args, x100)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += rightAdd3(keys[i]);
			return total;
		},
		competitors: {
			'es-toolkit': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += esRightAdd3(keys[i]);
				return total;
			},
			lodash: function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += lodashRightAdd3(keys[i]);
				return total;
			}
		}
	},
	{
		name: 'allPass (3 predicates, filter 100)',
		fn: function () {
			return signed.filter(evenPositive3);
		},
		competitors: {
			remeda: function () {
				return signed.filter(remedaAll);
			},
			'lodash overEvery': function () {
				return signed.filter(lodashAll);
			}
		}
	},
	{
		name: 'anyPass (3 predicates, filter 100)',
		fn: function () {
			return signed.filter(evenOrPositive3);
		},
		competitors: {
			remeda: function () {
				return signed.filter(remedaAny);
			},
			'lodash overSome': function () {
				return signed.filter(lodashAny);
			}
		}
	},
	{
		name: 'match (3 tags, x100)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += match(shapes[i], 'kind', shapeHandlers);
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += areaSwitch(shapes[i]);
			return total;
		}
	}
];
