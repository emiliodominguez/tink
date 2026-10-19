import fc from 'fast-check';
import { isMatching } from '../guards/index.js';
import {
	_,
	allPass,
	anyOf,
	anyPass,
	attempt,
	capture,
	captureAs,
	compose,
	composeAsync,
	cons,
	curry,
	debounce,
	defaultMemoizeKey,
	flip,
	match,
	matcher,
	matchWith,
	memoize,
	memoizeLast,
	negate,
	once,
	partial,
	partialRight,
	pipe,
	pipeAsync,
	times
} from '.';

type IntFn = (x: number) => number;

function add1(x: number): number {
	return x + 1;
}

function double(x: number): number {
	return x * 2;
}

function neg(x: number): number {
	return -x;
}

function square(x: number): number {
	return x * x;
}

function sub3(x: number): number {
	return x - 3;
}

const intFn = fc.constantFrom<IntFn>(add1, double, neg, square, sub3);
const smallInt = fc.integer({ min: -1000, max: 1000 });

describe('Functions helpers (properties)', function () {
	describe('compose / pipe', function () {
		it('compose is associative', function () {
			fc.assert(
				fc.property(intFn, intFn, intFn, smallInt, function (f, g, h, x) {
					expect(compose(compose(f, g), h)(x)).toBe(compose(f, compose(g, h))(x));
				})
			);
		});

		it('pipe is associative', function () {
			fc.assert(
				fc.property(intFn, intFn, intFn, smallInt, function (f, g, h, x) {
					expect(pipe(pipe(f, g), h)(x)).toBe(pipe(f, pipe(g, h))(x));
				})
			);
		});

		it('the empty composition is a two-sided identity', function () {
			fc.assert(
				fc.property(intFn, smallInt, function (f, x) {
					// Typed: a generic identity applied first leaves the input type open, which the typed overloads reject.
					const identity: (value: number) => number = compose();
					expect(compose(identity, f)(x)).toBe(f(x));
					expect(compose(f, identity)(x)).toBe(f(x));
					expect(pipe(identity, f)(x)).toBe(f(x));
					expect(pipe(f, pipe())(x)).toBe(f(x));
					expect(compose()(x)).toBe(x);
				})
			);
		});

		it('compose(...fs) equals pipe(...fs.reverse()) and the naive right fold', function () {
			fc.assert(
				fc.property(fc.array(intFn, { maxLength: 8 }), smallInt, function (fs, x) {
					const expected = fs.reduceRight(function (acc, f) {
						return f(acc);
					}, x);
					expect(compose<number>(...fs)(x)).toBe(expected);
					expect(pipe<number>(...fs.slice().reverse())(x)).toBe(expected);
				})
			);
		});
	});

	describe('curry', function () {
		function f(a: number, b: number, c: number): number {
			return a * 100 + b * 10 - c;
		}

		it('any split of the arguments gives the same result as calling f', function () {
			fc.assert(
				fc.property(smallInt, smallInt, smallInt, fc.integer({ min: 1, max: 3 }), function (a, b, c, split) {
					const curried = curry(f);
					const expected = f(a, b, c);
					expect(curried(a)(b)(c)).toBe(expected);
					expect(curried(a, b)(c)).toBe(expected);
					expect(curried(a)(b, c)).toBe(expected);

					const args = [a, b, c];
					const first = args.slice(0, split);
					const rest = args.slice(split);
					const step = (curried as any)(...first);
					expect(rest.length === 0 ? step : step(...rest)).toBe(expected);
				})
			);
		});
	});

	describe('partial', function () {
		it('partial(f, ...a)(...b) equals f(...a, ...b)', function () {
			function f(...xs: number[]): string {
				return xs.join(',');
			}

			fc.assert(
				fc.property(fc.array(smallInt, { maxLength: 5 }), fc.array(smallInt, { maxLength: 5 }), function (a, b) {
					expect(partial(f, ...a)(...b)).toBe(f(...a, ...b));
				})
			);
		});
	});

	describe('memoize', function () {
		it('returns the same results as f and calls f once per distinct key', function () {
			fc.assert(
				fc.property(fc.array(fc.oneof(smallInt, fc.string({ maxLength: 3 }), fc.constantFrom(null, undefined, NaN, true)), { maxLength: 40 }), function (inputs) {
					const calls: unknown[] = [];
					function f(x: unknown): string {
						calls.push(x);
						return `${typeof x}:${String(x)}`;
					}

					const memoized = memoize(f);
					inputs.forEach(function (x) {
						expect(memoized(x)).toBe(f(x));
						calls.pop();
					});
					expect(calls.length).toBe(new Set(inputs).size);
				})
			);
		});

		it('caches multi-argument calls by structural key', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })), { maxLength: 30 }), function (pairs) {
					const spy = jest.fn(function (a: number, b: number) {
						return a - b;
					});
					const memoized = memoize(spy);
					pairs.forEach(function ([a, b]) {
						expect(memoized(a, b)).toBe(a - b);
					});
					const distinct = new Set(
						pairs.map(function ([a, b]) {
							return `${a}|${b}`;
						})
					);
					expect(spy).toHaveBeenCalledTimes(distinct.size);
				})
			);
		});
	});

	describe('once', function () {
		it('calls f exactly once and always returns the first result', function () {
			fc.assert(
				fc.property(fc.array(smallInt, { minLength: 1, maxLength: 20 }), function (args) {
					const spy = jest.fn(square);
					const onced = once(spy);
					const results = args.map(function (x) {
						return onced(x);
					});
					expect(spy).toHaveBeenCalledTimes(1);
					expect(new Set(results)).toEqual(new Set([square(args[0])]));
				})
			);
		});
	});

	describe('negate', function () {
		it('negate(negate(p))(x) equals Boolean(p(x))', function () {
			const predicates = fc.constantFrom(
				function (x: number) {
					return x > 0;
				},
				function (x: number) {
					return x % 2 === 0;
				},
				function (x: number) {
					return x % 3;
				}
			);

			fc.assert(
				fc.property(predicates, smallInt, function (p, x) {
					expect(negate(negate(p))(x)).toBe(Boolean(p(x)));
					expect(negate(p)(x)).toBe(!p(x));
				})
			);
		});
	});

	describe('debounce', function () {
		afterEach(function () {
			jest.clearAllTimers();
			jest.useRealTimers();
		});

		it('calls fn once per quiet period, with the last args of each burst', function () {
			const wait = 100;

			fc.assert(
				fc.property(fc.array(fc.integer({ min: 0, max: 250 }), { minLength: 1, maxLength: 25 }), function (gaps) {
					jest.useFakeTimers();

					const spy = jest.fn();
					const debounced = debounce(spy, wait);
					const expected: number[] = [];

					gaps.forEach(function (gap, i) {
						if (i > 0) {
							jest.advanceTimersByTime(gap);
							// The previous call ended a burst if the gap was a full quiet period.
							if (gap >= wait) expected.push(i - 1);
						}
						debounced(i);
					});
					jest.advanceTimersByTime(wait);
					expected.push(gaps.length - 1);

					expect(
						spy.mock.calls.map(function (call) {
							return call[0];
						})
					).toEqual(expected);

					jest.useRealTimers();
				}),
				{ numRuns: 50 }
			);
		});
	});
	describe('defaultMemoizeKey', function () {
		it('maps distinct argument lists of primitives to distinct keys', function () {
			const primitive = fc.oneof(
				fc.integer({ min: -3, max: 3 }),
				fc.constantFrom(NaN, Infinity, -Infinity, -0, null, undefined, true, 'NaN', '-0', 'undefined', '1n', '\\1n', 'Infinity', '[1]'),
				fc.bigInt({ min: -3n, max: 3n }),
				fc.string({ maxLength: 3 })
			);

			fc.assert(
				fc.property(fc.array(primitive, { maxLength: 3 }), fc.array(primitive, { maxLength: 3 }), function (a, b) {
					const same =
						a.length === b.length &&
						a.every(function (value, i) {
							return Object.is(value, b[i]);
						});
					expect(Object.is(defaultMemoizeKey(...a), defaultMemoizeKey(...b))).toBe(same);
				})
			);
		});

		it('serialises argument lists like JSON.stringify with the documented markers (reference implementation)', function () {
			const special = /^\\*(?:-?\d+n|NaN|-?Infinity|-0|undefined|#\d+|Date\((?:-?\d+|NaN)\))$/;
			function referenceKey(args: unknown[]): string {
				return JSON.stringify(args, function (this: any, key: string): unknown {
					const value = this[key];
					if (typeof value === 'bigint') return `${value}n`;
					if (typeof value === 'number') return Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value);
					if (typeof value === 'string') return special.test(value) ? `\\${value}` : value;
					if (value === undefined) return 'undefined';
					if (value instanceof Date) return `Date(${value.getTime()})`;
					if (typeof value === 'symbol' || typeof value === 'function') return 'identity';
					return value;
				});
			}
			const value = fc.oneof(
				fc.double(),
				fc.integer(),
				fc.string({ unit: 'binary', maxLength: 4 }),
				fc.constantFrom(
					NaN,
					-0,
					Infinity,
					-Infinity,
					null,
					undefined,
					true,
					false,
					'NaN',
					'\\-0',
					'12n',
					'"',
					'\\',
					'\u2028',
					Symbol.iterator,
					add1,
					'#1',
					'Date(0)',
					'\\Date(NaN)'
				),
				fc.bigInt(),
				fc.date({ noInvalidDate: false }),
				fc.array(fc.oneof(fc.integer(), fc.constantFrom(undefined, -0, 'NaN')), { maxLength: 2 }),
				fc.dictionary(fc.string({ maxLength: 2 }), fc.oneof(fc.integer(), fc.constantFrom(undefined, NaN)), { maxKeys: 2 })
			);

			fc.assert(
				fc.property(fc.array(value, { minLength: 2, maxLength: 4 }), function (args) {
					// Only identity markers in value position are normalised: a dictionary KEY such as "#0" stays as is.
					expect((defaultMemoizeKey(...args) as string).replace(/"#\d+"(?!:)/g, '"identity"')).toBe(referenceKey(args));
				})
			);
		});

		it('never gives values of different kinds, or distinct non-plain values, the same key (security)', function () {
			class Point {
				constructor(readonly x: number) {}
			}
			const sharedSymbol = Symbol('shared');
			const sharedInstance = new Point(1);
			// Each arbitrary yields [kind, value]; values of the same kind are equal iff their `id` is equal.
			const tagged = fc.oneof(
				fc.integer({ min: -2, max: 2 }).map(function (n) {
					return ['number', n, String(n)] as const;
				}),
				fc.constantFrom('', 'a', 'null', 'undefined', '#1', 'Date(0)', '1970-01-01T00:00:00.000Z', '[1]').map(function (text) {
					return ['string', text, text] as const;
				}),
				fc.constantFrom(null, undefined, true).map(function (value) {
					return ['atom', value, String(value)] as const;
				}),
				fc.integer({ min: 0, max: 2 }).map(function (time) {
					return ['date', new Date(time), String(time)] as const;
				}),
				fc.constantFrom(0, 1).map(function (n) {
					return ['plain', { n: n }, String(n)] as const;
				}),
				fc.constantFrom(0, 1).map(function (n) {
					return ['array', [n], String(n)] as const;
				}),
				fc.constant(['symbol', sharedSymbol, 'shared'] as const),
				fc.constant(['fresh symbol', Symbol('shared'), Math.random()] as const),
				fc.constant(['instance', sharedInstance, 'shared'] as const),
				fc.constant(['fresh instance', new Point(1), Math.random()] as const),
				fc.constant(['error', new Error('x'), Math.random()] as const),
				fc.constant(['map', new Map(), Math.random()] as const),
				fc.constant(['function', add1, 'add1'] as const)
			);

			fc.assert(
				fc.property(fc.array(tagged, { minLength: 1, maxLength: 3 }), fc.array(tagged, { minLength: 1, maxLength: 3 }), fc.boolean(), function (a, b, nest) {
					const same =
						a.length === b.length &&
						a.every(function (entry, i) {
							return entry[0] === b[i][0] && Object.is(entry[2], b[i][2]);
						});
					const argsA = a.map(function (entry) {
						return nest ? { v: entry[1] } : entry[1];
					});
					const argsB = b.map(function (entry) {
						return nest ? { v: entry[1] } : entry[1];
					});
					expect(Object.is(defaultMemoizeKey(...argsA), defaultMemoizeKey(...argsB))).toBe(same);
				}),
				{ numRuns: 1000 }
			);
		});
	});

	describe('attempt', function () {
		it('never throws and matches a try/catch reference', function () {
			function risky(x: number): number {
				if (x % 3 === 0) throw new Error(`bad ${x}`);
				if (x % 5 === 0) throw x;
				return x * 2;
			}

			fc.assert(
				fc.property(smallInt, function (x) {
					let expected: unknown[];
					try {
						expected = [undefined, risky(x)];
					} catch (error) {
						expected = [error, undefined];
					}
					expect(attempt(risky, x)).toEqual(expected);
				})
			);
		});
	});

	describe('times', function () {
		it('returns n results, calling fn with 0..n-1 in order', function () {
			fc.assert(
				fc.property(fc.nat({ max: 200 }), function (n) {
					const seen: number[] = [];
					const result = times(n, function (i) {
						seen.push(i);
						return i * 3;
					});
					expect(result).toHaveLength(n);
					expect(seen).toEqual(
						Array.from({ length: n }, function (_unused, i) {
							return i;
						})
					);
					expect(result).toEqual(
						seen.map(function (i) {
							return i * 3;
						})
					);
				})
			);
		});
	});

	describe('flip', function () {
		it('flip(flip(f)) behaves like f, and flip(f) reverses the arguments', function () {
			function f(...xs: number[]): string {
				return xs.join(',');
			}

			fc.assert(
				fc.property(fc.array(smallInt, { maxLength: 6 }), function (args) {
					expect(flip(flip(f))(...args)).toBe(f(...args));
					expect(flip(f)(...args)).toBe(f(...args.slice().reverse()));
				})
			);
		});
	});

	describe('memoizeLast', function () {
		it('calls fn exactly when the arguments differ from the previous call', function () {
			fc.assert(
				fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.constantFrom(NaN, 0, 1)), { maxLength: 40 }), function (calls) {
					const spy = jest.fn(function (a: number, b: number) {
						return a + b;
					});
					const memoized = memoizeLast(spy);
					let expectedCalls = 0;
					let previous: [number, number] | undefined;

					calls.forEach(function (pair) {
						if (previous === undefined || !(Object.is(previous[0], pair[0]) && Object.is(previous[1], pair[1]))) expectedCalls++;
						previous = pair;
						expect(memoized(pair[0], pair[1])).toBe(pair[0] + pair[1]);
					});
					expect(spy).toHaveBeenCalledTimes(expectedCalls);
				})
			);
		});
	});
});

describe('round 11 helpers (properties)', function () {
	function collect(...args: unknown[]): unknown[] {
		return args;
	}

	it('partialRight(fn, ...tail)(...head) calls fn(...head, ...tail), and partial/partialRight compose to the full call', function () {
		fc.assert(
			fc.property(fc.array(fc.anything(), { maxLength: 5 }), fc.array(fc.anything(), { maxLength: 5 }), function (head, tail) {
				const bound = partialRight(collect as (...args: unknown[]) => unknown[], ...tail) as (...args: unknown[]) => unknown[];
				expect(bound(...head)).toEqual([...head, ...tail]);
				const both = partial(partialRight(collect as (...args: unknown[]) => unknown[], ...tail) as (...args: unknown[]) => unknown[], ...head);
				expect(both()).toEqual([...head, ...tail]);
			})
		);
	});

	it('allPass/anyPass agree with every/some, and allPass(...ps) === !anyPass(...ps.map(negate))', function () {
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 6 }), fc.integer({ min: -50, max: 50 }), function (divisors, value) {
				const predicates = divisors.map(function (d) {
					return function (n: number): boolean {
						return n % d === 0;
					};
				});
				const expectedAll = predicates.every(function (p) {
					return p(value);
				});
				const expectedAny = predicates.some(function (p) {
					return p(value);
				});
				expect(allPass(...predicates)(value)).toBe(expectedAll);
				expect(anyPass(...predicates)(value)).toBe(expectedAny);
				expect(allPass(...predicates)(value)).toBe(!anyPass(...predicates.map(negate))(value));
			})
		);
	});

	it('match calls exactly the handler named by the tag', function () {
		type Tagged = { tag: 'a'; n: number } | { tag: 'b'; n: number } | { tag: 'c'; n: number };
		fc.assert(
			fc.property(fc.constantFrom<'a' | 'b' | 'c'>('a', 'b', 'c'), fc.integer(), function (tag, n) {
				const value = { tag, n } as Tagged;
				const result = match(value, 'tag', {
					a: function (v) {
						return ['a', v] as const;
					},
					b: function (v) {
						return ['b', v] as const;
					},
					c: function (v) {
						return ['c', v] as const;
					}
				});
				expect(result[0]).toBe(tag);
				expect(result[1]).toBe(value);
			})
		);
	});
});

describe('pipeAsync / composeAsync (properties)', function () {
	/** A step, synchronous or returning a promise of the same result. */
	const step = fc.tuple(intFn, fc.boolean()).map(function ([fn, wrapped]): [IntFn, (x: number) => number | Promise<number>] {
		return [
			fn,
			wrapped
				? async function (x: number): Promise<number> {
						return fn(x);
					}
				: fn
		];
	});

	it('resolves to what pipe and compose return for the same steps, awaited or not', async function () {
		await fc.assert(
			fc.asyncProperty(fc.array(step, { maxLength: 8 }), smallInt, async function (steps, x) {
				const plain = steps.map(function ([fn]) {
					return fn;
				});
				const mixed = steps.map(function ([, fn]) {
					return fn;
				});
				await expect(pipeAsync(...mixed)(x)).resolves.toBe(pipe(...plain)(x));
				await expect(composeAsync(...mixed)(x)).resolves.toBe(compose(...plain)(x));
				await expect(composeAsync(...mixed)(x)).resolves.toBe(await pipeAsync(...mixed.slice().reverse())(x));
			})
		);
	});
});

describe('matchWith / matcher (properties)', function () {
	/** A small pattern language: literals, `_`, guards, objects, tuples, or-patterns and cons patterns. */
	type Pattern = unknown;

	function isText(value: unknown): value is string {
		return typeof value === 'string';
	}

	function isSmall(value: unknown): boolean {
		return typeof value === 'number' && value < 2;
	}

	const leaf = fc.constantFrom<unknown>(1, 2, 'a', null, undefined, true, NaN, 0, _, isText, isSmall);
	const { pattern } = fc.letrec<{ pattern: Pattern }>(function (tie) {
		return {
			pattern: fc.oneof(
				{ depthSize: 'small', withCrossShrink: true },
				leaf,
				fc.dictionary(fc.constantFrom('a', 'b', 'c'), tie('pattern'), { maxKeys: 3 }),
				fc.array(tie('pattern'), { maxLength: 3 }),
				fc.array(tie('pattern'), { minLength: 1, maxLength: 3 }).map(function (alternatives) {
					return { anyOf: alternatives };
				}),
				fc.tuple(tie('pattern'), fc.option(tie('pattern'), { nil: undefined })).map(function ([head, tail]) {
					return { cons: [head, tail] };
				})
			)
		};
	});
	const { value } = fc.letrec<{ value: unknown }>(function (tie) {
		return {
			value: fc.oneof(
				{ depthSize: 'small', withCrossShrink: true },
				fc.constantFrom<unknown>(1, 2, -0, 'a', 'b', null, undefined, true, false, NaN),
				fc.dictionary(fc.constantFrom('a', 'b', 'c'), tie('value'), { maxKeys: 3 }),
				fc.array(tie('value'), { maxLength: 4 })
			)
		};
	});

	/**
	 * Builds the pattern for matchWith: `{ anyOf }` and `{ cons }` markers become the helpers (only at the top of a generated node).
	 * @param {Pattern} node - The generated node
	 * @returns {unknown} The pattern
	 */
	function build(node: Pattern): unknown {
		if (Array.isArray(node)) return node.map(build);
		if (typeof node !== 'object' || node === null) return node;
		const record = node as Record<string, unknown>;
		if (Object.keys(record).length === 1 && Array.isArray(record.anyOf)) return anyOf(...record.anyOf.map(build));
		if (Object.keys(record).length === 1 && Array.isArray(record.cons)) {
			const [head, tail] = record.cons as [unknown, unknown];
			return tail === undefined ? cons(build(head)) : cons(build(head), build(tail));
		}
		return Object.fromEntries(
			Object.entries(record).map(function ([key, inner]) {
				return [key, build(inner)];
			})
		);
	}

	/**
	 * The naive reference: an isMatching guard, the helpers spelled out as plain guards.
	 * @param {Pattern} node - The generated node
	 * @returns {(value: unknown) => boolean} The guard
	 */
	function reference(node: Pattern): (value: unknown) => boolean {
		return isMatching(spell(node)) as (value: unknown) => boolean;
	}

	function spell(node: Pattern): unknown {
		if (Array.isArray(node)) return node.map(spell);
		if (typeof node !== 'object' || node === null) return node;
		const record = node as Record<string, unknown>;
		if (Object.keys(record).length === 1 && Array.isArray(record.anyOf)) {
			const alternatives = record.anyOf.map(reference);
			return function (candidate: unknown): boolean {
				return alternatives.some(function (alternative) {
					return alternative(candidate);
				});
			};
		}
		if (Object.keys(record).length === 1 && Array.isArray(record.cons)) {
			const [head, tail] = record.cons as [unknown, unknown];
			const isHead = reference(head);
			const isTail = tail === undefined ? _ : reference(tail);
			return function (candidate: unknown): boolean {
				return Array.isArray(candidate) && candidate.length > 0 && isHead(candidate[0]) && isTail(candidate.slice(1));
			};
		}
		return Object.fromEntries(
			Object.entries(record).map(function ([key, inner]) {
				return [key, spell(inner)];
			})
		);
	}

	it('runs the first case whose pattern matches, like a naive first-match over isMatching, one-shot or reused', function () {
		fc.assert(
			fc.property(fc.array(pattern, { minLength: 1, maxLength: 4 }), value, function (cases, candidate) {
				const expected = cases.findIndex(function (node) {
					return reference(node)(candidate);
				});
				let oneShot = matchWith(candidate);
				let reused = matcher<unknown>();
				cases.forEach(function (node, index) {
					oneShot = oneShot.with(build(node), function () {
						return index;
					}) as typeof oneShot;
					reused = reused.with(build(node), function () {
						return index;
					}) as typeof reused;
				});
				function none(): number {
					return -1;
				}
				expect(oneShot.otherwise(none)).toBe(expected);
				expect(reused.otherwise(none)(candidate)).toBe(expected);
			})
		);
	});

	it('anyOf matches the union of what its patterns match', function () {
		fc.assert(
			fc.property(pattern, pattern, value, function (first, second, candidate) {
				const union = isMatching(anyOf(build(first), build(second)))(candidate);
				expect(union).toBe(reference(first)(candidate) || reference(second)(candidate));
				expect(
					matchWith(candidate)
						.with(anyOf(build(first), build(second)), function () {
							return true;
						})
						.otherwise(function () {
							return false;
						})
				).toBe(union);
			})
		);
	});

	it('a capture matches what its pattern matches and passes the value it matched', function () {
		const nothing = Symbol('nothing');
		fc.assert(
			fc.property(pattern, value, function (node, candidate) {
				const selected = matchWith({ key: candidate })
					.with({ key: capture(build(node)) }, function (selection) {
						return selection;
					})
					.otherwise(function () {
						return nothing;
					});
				expect(selected).toBe(reference(node)(candidate) ? candidate : nothing);
			})
		);
	});

	it('exhaustive cases never throw for values of the declared type, and pick the case a reference picks', function () {
		type Value = { kind: 'a' } | { kind: 'b'; flags: [boolean, boolean] } | { kind: 'c'; items: number[] };
		const values = fc.oneof(
			fc.constant<Value>({ kind: 'a' }),
			fc.tuple(fc.boolean(), fc.boolean()).map(function (flags): Value {
				return { kind: 'b', flags };
			}),
			fc.array(fc.integer(), { maxLength: 3 }).map(function (items): Value {
				return { kind: 'c', items };
			})
		);
		const describeValue = matcher<Value>()
			.with({ kind: 'b', flags: [true, _] }, function () {
				return 'b first';
			})
			.with({ kind: 'c', items: [] }, function () {
				return 'c empty';
			})
			.with({ kind: 'b', flags: [false, captureAs('second')] }, function ({ second }) {
				return `b second ${second}`;
			})
			.with({ kind: 'c', items: cons(captureAs('head')) }, function ({ head }) {
				return `c head ${head}`;
			})
			.with({ kind: 'a' }, function () {
				return 'a';
			})
			.exhaustive();
		fc.assert(
			fc.property(values, function (candidate) {
				const expected =
					candidate.kind === 'a'
						? 'a'
						: candidate.kind === 'b'
							? candidate.flags[0]
								? 'b first'
								: `b second ${candidate.flags[1]}`
							: candidate.items.length === 0
								? 'c empty'
								: `c head ${candidate.items[0]}`;
				expect(describeValue(candidate)).toBe(expected);
			})
		);
	});

	it('cons matches non-empty arrays by head and tail', function () {
		fc.assert(
			fc.property(pattern, pattern, fc.array(value, { maxLength: 4 }), function (head, tail, list) {
				// An `undefined` tail means any tail (no array is `undefined`).
				const isTail = tail === undefined ? _ : reference(tail);
				expect(cons(build(head), build(tail))(list)).toBe(list.length > 0 && reference(head)(list[0]) && isTail(list.slice(1)));
			})
		);
	});
});
