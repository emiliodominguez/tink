import fc from 'fast-check';
import * as helpers from '.';
import { isPlainObject } from '../guards/index.js';
import * as strings from '../strings/index.js';

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const anyValue = fc.anything({
	withBigInt: true,
	withBoxedValues: true,
	withDate: true,
	withMap: true,
	withSet: true,
	withTypedArray: true,
	withSparseArray: true,
	withNullPrototype: true
});

const safeKey = fc.string().filter(function (key) {
	return !UNSAFE.has(key);
});

// Results of merge/pick/omit/mapValues are ordinary objects, so inputs use Object.prototype too (isEqual compares prototypes).
const record = fc.dictionary(fc.string(), anyValue, { maxKeys: 8, noNullPrototype: true });

/**
 * Collects every object reachable from `root` (own data properties, Map keys/values, Set members, typed array buffers).
 */
function collectObjects(root: unknown): Set<object> {
	const seen = new Set<object>();
	const pending: unknown[] = [root];

	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value !== 'object' || value === null || seen.has(value)) continue;
		seen.add(value);

		if (value instanceof Map) {
			value.forEach(function (entryValue, entryKey) {
				pending.push(entryKey, entryValue);
			});
		} else if (value instanceof Set) {
			value.forEach(function (member) {
				pending.push(member);
			});
		} else if (ArrayBuffer.isView(value)) {
			pending.push(value.buffer);
			continue;
		}

		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
		}
	}

	return seen;
}

/**
 * Naive reference implementation of deepMerge for JSON-like data, written with spreads.
 */
function referenceDeepMerge(base: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	let result: Record<string, unknown> = {};
	for (const key of Object.keys(base)) {
		if (!UNSAFE.has(key)) result = { ...result, [key]: isPlainObject(base[key]) ? referenceDeepMerge({}, base[key] as Record<string, unknown>) : base[key] };
	}
	for (const key of Object.keys(source)) {
		if (UNSAFE.has(key)) continue;
		const value = source[key];
		const previous = result[key];
		if (isPlainObject(value)) {
			result = { ...result, [key]: referenceDeepMerge(isPlainObject(previous) ? (previous as Record<string, unknown>) : {}, value as Record<string, unknown>) };
		} else {
			result = { ...result, [key]: value };
		}
	}
	return result;
}

describe('objects (properties)', function () {
	describe('deepClone', function () {
		it('produces an equal value that shares no object reference with the original', function () {
			fc.assert(
				fc.property(anyValue, function (value) {
					const copy = helpers.deepClone(value);
					expect(helpers.isEqual(copy, value)).toBe(true);

					const originals = collectObjects(value);
					for (const object of collectObjects(copy)) {
						expect(originals.has(object)).toBe(false);
					}
				})
			);
		});

		it('is idempotent: cloning a clone gives an equal value', function () {
			fc.assert(
				fc.property(anyValue, function (value) {
					const once = helpers.deepClone(value);
					expect(helpers.isEqual(helpers.deepClone(once), once)).toBe(true);
				})
			);
		});

		it('preserves the reference graph of shared and circular structures', function () {
			fc.assert(
				fc.property(fc.array(fc.nat(9), { minLength: 1, maxLength: 20 }), function (links) {
					const nodes = links.map(function () {
						return {} as Record<string, unknown>;
					});
					links.forEach(function (target, index) {
						nodes[index].next = nodes[target % nodes.length];
					});
					const copies = helpers.deepClone(nodes);
					links.forEach(function (target, index) {
						expect(copies[index].next).toBe(copies[target % nodes.length]);
					});
					expect(helpers.isEqual(copies, nodes)).toBe(true);
				})
			);
		});
	});

	describe('clone', function () {
		it('is equal to the original and shallow (same child references)', function () {
			fc.assert(
				fc.property(anyValue, function (value) {
					const copy = helpers.clone(value);
					expect(helpers.isEqual(copy, value)).toBe(true);
					if (Array.isArray(value) || isPlainObject(value)) {
						expect(copy).not.toBe(value);
						for (const key of Object.keys(value)) {
							expect((copy as Record<string, unknown>)[key]).toBe((value as Record<string, unknown>)[key]);
						}
					}
				})
			);
		});
	});

	describe('isEqual', function () {
		it('is reflexive', function () {
			fc.assert(
				fc.property(anyValue, function (value) {
					expect(helpers.isEqual(value, value)).toBe(true);
				})
			);
		});

		it('is symmetric (random pairs and equal-by-construction pairs)', function () {
			const pairs = fc.oneof(
				fc.tuple(anyValue, anyValue),
				anyValue.map(function (value) {
					return [value, helpers.deepClone(value)] as [unknown, unknown];
				}),
				fc.tuple(fc.object(), fc.object())
			);
			fc.assert(
				fc.property(pairs, function ([a, b]) {
					expect(helpers.isEqual(a, b)).toBe(helpers.isEqual(b, a));
				})
			);
		});

		it('considers a JSON value equal to its JSON round trip', function () {
			fc.assert(
				fc.property(fc.jsonValue(), function (value) {
					expect(helpers.isEqual(JSON.parse(JSON.stringify(value)), value)).toBe(true);
				})
			);
		});

		it('detects any changed leaf in a JSON object', function () {
			fc.assert(
				fc.property(fc.dictionary(safeKey, fc.jsonValue(), { minKeys: 1 }), fc.nat(), function (value, seed) {
					const keys = Object.keys(value);
					const key = keys[seed % keys.length];
					const changed = { ...value, [key]: { changed: value[key] } };
					expect(helpers.isEqual(changed, value)).toBe(false);
				})
			);
		});
	});

	describe('merge', function () {
		it('follows last-wins key semantics and does not mutate inputs', function () {
			fc.assert(
				fc.property(fc.array(record, { minLength: 1, maxLength: 4 }), function (objects) {
					const snapshot = helpers.deepClone(objects);
					const [first, ...rest] = objects;
					const result = helpers.merge(first, ...rest) as Record<string, unknown>;

					const expected = new Map<string, unknown>();
					for (const object of objects) {
						for (const key of Object.keys(object)) expected.set(key, object[key]);
					}

					expect(Object.keys(result).sort()).toStrictEqual(Array.from(expected.keys()).sort());
					expected.forEach(function (value, key) {
						expect(Object.is(result[key], value)).toBe(true);
					});
					expect(helpers.isEqual(objects, snapshot)).toBe(true);
				})
			);
		});
	});

	describe('deepMerge', function () {
		const jsonRecord = fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 6, noNullPrototype: true }) as fc.Arbitrary<Record<string, unknown>>;

		it('matches a naive reference implementation and does not mutate inputs', function () {
			fc.assert(
				fc.property(fc.array(jsonRecord, { minLength: 1, maxLength: 4 }), function (objects) {
					const snapshot = helpers.deepClone(objects);
					const [first, ...rest] = objects;
					const result = helpers.deepMerge(first, ...rest);
					const expected = rest.reduce(referenceDeepMerge, referenceDeepMerge({}, first));

					expect(helpers.isEqual(result, expected)).toBe(true);
					expect(helpers.isEqual(objects, snapshot)).toBe(true);
				})
			);
		});

		it('equals merge when no key holds plain objects on both sides', function () {
			const flat = fc.dictionary(safeKey, fc.oneof(fc.integer(), fc.string(), fc.array(fc.integer())), { maxKeys: 6, noNullPrototype: true });
			fc.assert(
				fc.property(flat, flat, function (a, b) {
					expect(helpers.isEqual(helpers.deepMerge(a, b), helpers.merge(a, b))).toBe(true);
				})
			);
		});

		it('is idempotent: merging an object with itself yields an equal object', function () {
			fc.assert(
				fc.property(fc.dictionary(safeKey, fc.jsonValue({ maxDepth: 3 })), function (value) {
					const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
					expect(helpers.isEqual(helpers.deepMerge(json, json), helpers.deepMerge(json))).toBe(true);
				})
			);
		});
	});

	describe('pick / omit', function () {
		it('pick ∪ omit reconstructs the object, and their keys are disjoint', function () {
			const safeRecord = fc.dictionary(safeKey, anyValue, { maxKeys: 8, noNullPrototype: true });
			const objectWithKeys = safeRecord.chain(function (object) {
				return fc.tuple(fc.constant(object), fc.subarray(Object.keys(object)));
			});
			fc.assert(
				fc.property(objectWithKeys, function ([object, keys]) {
					const picked = helpers.pick(object, keys);
					const omitted = helpers.omit(object, keys);
					const pickedKeys = Object.keys(picked);
					for (const key of Object.keys(omitted)) expect(pickedKeys).not.toContain(key);
					expect(helpers.isEqual(helpers.merge(picked, omitted), object)).toBe(true);
				})
			);
		});
	});

	describe('pick (security)', function () {
		it('never copies __proto__, constructor or prototype, nor an Object.prototype member the object does not own', function () {
			const names = fc.constantFrom('a', 'constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty');
			fc.assert(
				fc.property(fc.dictionary(names, fc.jsonValue(), { noNullPrototype: true }), fc.array(names), function (object, keys) {
					const picked = helpers.pick(object, keys as any[]);
					const expected = keys.filter(function (key, index) {
						return !UNSAFE.has(key) && Object.prototype.hasOwnProperty.call(object, key) && keys.indexOf(key) === index;
					});
					expect(Object.keys(picked).sort()).toStrictEqual(expected.sort());
					expect(Object.getPrototypeOf(picked)).toBe(Object.prototype);
				})
			);
		});
	});

	describe('mapValues / mapKeys', function () {
		it('mapValues with identity is an equal copy and composes', function () {
			fc.assert(
				fc.property(fc.dictionary(fc.string(), fc.integer(), { noNullPrototype: true }), function (object) {
					const identity = helpers.mapValues(object, function (value) {
						return value;
					});
					expect(helpers.isEqual(identity, object)).toBe(true);

					const twice = helpers.mapValues(
						helpers.mapValues(object, function (value) {
							return value + 1;
						}),
						function (value) {
							return value * 2;
						}
					);
					const composed = helpers.mapValues(object, function (value) {
						return (value + 1) * 2;
					});
					expect(helpers.isEqual(twice, composed)).toBe(true);
				})
			);
		});

		it('mapKeys with identity is an equal copy', function () {
			fc.assert(
				fc.property(fc.dictionary(fc.string(), fc.integer(), { noNullPrototype: true }), function (object) {
					const copy = helpers.mapKeys(object, function (_value, key) {
						return key;
					});
					expect(helpers.isEqual(copy, object)).toBe(true);
				})
			);
		});
	});

	describe('invert', function () {
		it('invert ∘ invert is the identity for injective string-valued records', function () {
			const injective = fc.uniqueArray(fc.string(), { maxLength: 10 }).chain(function (keys) {
				return fc.uniqueArray(fc.string(), { minLength: keys.length, maxLength: keys.length }).map(function (values) {
					return Object.fromEntries(
						keys.map(function (key, index) {
							return [key, values[index]];
						})
					) as Record<string, string>;
				});
			});
			fc.assert(
				fc.property(injective, function (object) {
					expect(helpers.isEqual(helpers.invert(helpers.invert(object)), object)).toBe(true);
				})
			);
		});
	});

	describe('setPath / getPath', function () {
		const segment = fc.oneof(fc.stringMatching(/^[a-z]{1,5}$/), fc.nat(4).map(String));
		const path = fc.array(segment, { minLength: 1, maxLength: 5 }).map(function (segments) {
			return segments.join('.');
		});

		it('get after set returns the stored value', function () {
			fc.assert(
				fc.property(path, anyValue, function (keys, value) {
					const target: Record<string, unknown> = {};
					expect(helpers.setPath(target, keys, value)).toBe(target);
					expect(Object.is(helpers.getPath(target, keys as any), value)).toBe(true);
				})
			);
		});

		it('setting a second, non-overlapping path keeps the first value', function () {
			fc.assert(
				fc.property(path, path, fc.integer(), fc.integer(), function (first, second, a, b) {
					fc.pre(!first.startsWith(second) && !second.startsWith(first));
					const target: Record<string, unknown> = {};
					helpers.setPath(target, first, a);
					helpers.setPath(target, second, b);
					expect(helpers.getPath(target, first as any)).toBe(a);
					expect(helpers.getPath(target, second as any)).toBe(b);
				})
			);
		});

		it('hasPath agrees with getPath, and unsafe or Object.prototype names never resolve', function () {
			const names = fc.constantFrom('a', 'b', '0', '1', 'length', 'constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty');
			const tree = fc.dictionary(names, fc.jsonValue(), { maxKeys: 4, noNullPrototype: true });
			const jsonish = fc.oneof(tree, fc.jsonValue(), fc.dictionary(names, tree, { maxKeys: 3, noNullPrototype: true }));
			const anyPath = fc.array(names, { minLength: 1, maxLength: 4 }).map(function (segments) {
				return segments.join('.');
			});
			const missing = Symbol('missing');
			fc.assert(
				fc.property(jsonish, anyPath, function (value, keys) {
					const root = { root: value } as Record<string, unknown>;
					const fullPath = `root.${keys}`;
					const resolved = helpers.getPath(root, fullPath as any, missing);
					const has = helpers.hasPath(root, fullPath);
					if (resolved !== missing) expect(has).toBe(true);
					// JSON values hold no `undefined`, so a path that exists never falls back to the default.
					else expect(has).toBe(false);
					if (
						keys.split('.').some(function (name) {
							return UNSAFE.has(name);
						})
					)
						expect(has).toBe(false);
					if (resolved !== missing && resolved !== null && typeof resolved !== 'string' && typeof resolved !== 'number' && typeof resolved !== 'boolean') {
						// Only JSON data (own values) or methods of Array/String/Number.prototype can be reached, never Object.prototype or its members.
						expect(
							resolved === Object.prototype ||
								resolved === Object ||
								resolved === Function ||
								Object.values(Object.getOwnPropertyDescriptors(Object.prototype)).some(function (descriptor) {
									return descriptor.value === resolved;
								})
						).toBe(false);
					}
				})
			);
		});

		it('getPath never throws and falls back to the default on missing paths', function () {
			fc.assert(
				fc.property(fc.jsonValue(), path, function (value, keys) {
					const result = helpers.getPath({ root: value } as Record<string, unknown>, `root.${keys}` as any, 'fallback');
					expect(result).not.toBeUndefined();
				})
			);
		});
	});

	describe('deepFreeze', function () {
		it('freezes every reachable object except binary views', function () {
			fc.assert(
				fc.property(anyValue, function (value) {
					const frozen = helpers.deepFreeze(helpers.deepClone(value));
					for (const object of collectObjects(frozen)) {
						if (!ArrayBuffer.isView(object) && Object.prototype.toString.call(object) !== '[object ArrayBuffer]') expect(Object.isFrozen(object)).toBe(true);
					}
				})
			);
		});
	});

	describe('round 2 helpers', function () {
		/**
		 * JSON-like trees whose keys survive a flatten/unflatten round-trip: no separator, not numeric-looking (they would come back as
		 * arrays), not empty, not unsafe (`__proto__`...). Arrays are dense. Empty objects/arrays are allowed (they are kept as leaves).
		 */
		function jsonTree(key: fc.Arbitrary<string>): fc.Arbitrary<Record<string, unknown>> {
			const { node } = fc.letrec<{ node: unknown }>(function (tie) {
				return {
					node: fc.oneof(
						{ depthSize: 'small', withCrossShrink: true },
						fc.integer({ min: -3, max: 3 }),
						fc.string({ maxLength: 3 }),
						fc.boolean(),
						fc.constant(null),
						fc.array(tie('node'), { maxLength: 3 }),
						fc.dictionary(key, tie('node'), { maxKeys: 3, noNullPrototype: true })
					)
				};
			});
			return fc.dictionary(key, node, { maxKeys: 4, noNullPrototype: true });
		}
		const roundTripKey = fc.stringMatching(/^[a-z_][a-z0-9_]{0,3}$/);
		/** Few distinct keys, so that two generated trees overlap a lot. */
		const overlappingTree = jsonTree(fc.constantFrom('a', 'b', 'c'));

		it('unflattenObject(flattenObject(x)) is equal to x', function () {
			fc.assert(
				fc.property(jsonTree(roundTripKey), fc.constantFrom('.', '/', '::'), function (tree, separator) {
					const flat = helpers.flattenObject(tree, { separator });
					expect(helpers.isEqual(helpers.unflattenObject(flat, { separator }), tree)).toBe(true);
				})
			);
		});

		it('flattenObject maps every path to a leaf readable with getPath', function () {
			fc.assert(
				fc.property(jsonTree(roundTripKey), function (tree) {
					for (const [path, value] of Object.entries(helpers.flattenObject(tree))) {
						expect(helpers.getPath(tree, path as any)).toBe(value);
						expect(helpers.hasPath(tree, path)).toBe(true);
						const isNonEmptyContainer = typeof value === 'object' && value !== null && Object.keys(value).length > 0;
						expect(isNonEmptyContainer).toBe(false);
					}
				})
			);
		});

		it('pickBy and omitBy partition the own enumerable properties', function () {
			fc.assert(
				fc.property(record, fc.func(fc.boolean()), function (object, decide) {
					function predicate(value: unknown, key: PropertyKey): boolean {
						return decide(value, key);
					}
					const picked = helpers.pickBy(object, predicate);
					const omitted = helpers.omitBy(object, predicate);
					const pickedKeys = new Set(Object.keys(picked));
					for (const key of Object.keys(omitted)) expect(pickedKeys.has(key)).toBe(false);
					expect(helpers.isEqual(helpers.merge(picked, omitted), object)).toBe(true);
				})
			);
		});

		it('compactObject keeps exactly the defined values', function () {
			fc.assert(
				fc.property(fc.dictionary(fc.string(), fc.oneof(fc.constant(undefined), anyValue), { noNullPrototype: true }), function (object) {
					const compacted = helpers.compactObject(object);
					const expected = Object.keys(object).filter(function (key) {
						return object[key] !== undefined;
					});
					expect(Object.keys(compacted)).toStrictEqual(expected);
					for (const key of expected) expect((compacted as Record<string, unknown>)[key]).toBe(object[key]);
				})
			);
		});

		it('typedFromEntries(typedEntries(x)) is equal to x', function () {
			fc.assert(
				fc.property(record, function (object) {
					expect(helpers.isEqual(helpers.typedFromEntries(helpers.typedEntries(object)), object)).toBe(true);
					expect(helpers.typedKeys(object)).toStrictEqual(Object.keys(object));
				})
			);
		});

		it('omit removes numeric keys like their string form', function () {
			fc.assert(
				fc.property(fc.dictionary(fc.nat(20).map(String), fc.integer(), { noNullPrototype: true }), fc.array(fc.nat(20)), function (object, keys) {
					const omitted = helpers.omit(object as Record<number, number>, keys);
					const expected = Object.keys(object).filter(function (key) {
						return !keys.includes(Number(key));
					});
					expect(Object.keys(omitted)).toStrictEqual(expected);
				})
			);
		});

		it('unflattenObject never creates an array longer than arrayLimit + 1', function () {
			const index = fc.oneof(fc.nat(30), fc.integer({ min: 0, max: 2 ** 32 }));
			const key = fc.array(fc.oneof(index.map(String), fc.constantFrom('a', 'b')), { minLength: 1, maxLength: 3 }).map(function (segments) {
				return segments.join('.');
			});
			fc.assert(
				fc.property(fc.uniqueArray(key, { maxLength: 6 }), fc.nat(20), function (keys, arrayLimit) {
					let result: Record<string, unknown>;
					try {
						result = helpers.unflattenObject(
							Object.fromEntries(
								keys.map(function (k, i) {
									return [k, i];
								})
							),
							{ arrayLimit }
						);
					} catch (error) {
						// Conflicting keys (`'a'` and `'a.b'`) are rejected; nothing else may throw.
						expect(error).toBeInstanceOf(TypeError);
						return;
					}
					for (const object of collectObjects(result)) if (Array.isArray(object)) expect(object.length).toBeLessThanOrEqual(arrayLimit + 1);
					// Every key is still readable at its path.
					keys.forEach(function (k, i) {
						expect(helpers.getPath(result, k as any)).toBe(i);
					});
				})
			);
		});

		it('hasPath / deletePath agree with setPath', function () {
			const path = fc.array(fc.oneof(fc.stringMatching(/^[a-z]{1,3}$/), fc.nat(3).map(String)), { minLength: 1, maxLength: 4 }).map(function (segments) {
				return segments.join('.');
			});
			fc.assert(
				fc.property(path, fc.anything(), function (keys, value) {
					const target: Record<string, unknown> = {};
					expect(helpers.hasPath(target, keys)).toBe(false);
					helpers.setPath(target, keys, value);
					expect(helpers.hasPath(target, keys)).toBe(true);
					expect(helpers.deletePath(target, keys)).toBe(true);
					expect(helpers.hasPath(target, keys)).toBe(false);
					expect(helpers.deletePath(target, keys)).toBe(false);
				})
			);
		});

		it('diff(a, a) and diff(a, deepClone(a)) are empty', function () {
			fc.assert(
				fc.property(overlappingTree, function (tree) {
					const empty = { added: [], removed: [], changed: [] };
					expect(helpers.diff(tree, tree)).toStrictEqual(empty);
					expect(helpers.diff(tree, helpers.deepClone(tree))).toStrictEqual(empty);
				})
			);
		});

		it('diff is symmetric: added(a, b) = removed(b, a) and changed agree', function () {
			fc.assert(
				fc.property(overlappingTree, overlappingTree, function (a, b) {
					const forward = helpers.diff(a, b);
					const backward = helpers.diff(b, a);
					expect(forward.added).toStrictEqual(backward.removed);
					expect(forward.removed).toStrictEqual(backward.added);
					expect([...forward.changed].sort()).toStrictEqual([...backward.changed].sort());
				})
			);
		});

		it('diff paths are consistent with hasPath and the trees are equal iff the diff is empty', function () {
			fc.assert(
				fc.property(overlappingTree, overlappingTree, function (a, b) {
					const { added, removed, changed } = helpers.diff(a, b);
					for (const path of added) expect([helpers.hasPath(a, path), helpers.hasPath(b, path)]).toStrictEqual([false, true]);
					for (const path of removed) expect([helpers.hasPath(a, path), helpers.hasPath(b, path)]).toStrictEqual([true, false]);
					for (const path of changed) {
						expect(helpers.isEqual(helpers.getPath(a, path as any), helpers.getPath(b, path as any))).toBe(false);
					}
					expect(added.length + removed.length + changed.length === 0).toBe(helpers.isEqual(a, b));
				})
			);
		});
	});
});

describe('Objects helpers (round 11) - properties', function () {
	const json = fc.jsonValue({ maxDepth: 3 });
	const jsonObject = fc.dictionary(fc.string({ maxLength: 4 }), json, { maxKeys: 6, noNullPrototype: true });
	const safeName = fc.string({ minLength: 1, maxLength: 4 }).filter(function (key) {
		return !UNSAFE.has(key) && !key.includes('.');
	});

	/**
	 * Copies an object tree with the keys of every plain object inserted in reverse order.
	 */
	function reverseKeys(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(reverseKeys);
		if (!isPlainObject(value)) return value;
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value).reverse())
			Object.defineProperty(copy, key, { value: reverseKeys(value[key]), enumerable: true, writable: true, configurable: true });
		return copy;
	}

	it('defaults equals a per-key reference (first value that is not undefined)', function () {
		fc.assert(
			fc.property(record, record, function (target, source) {
				const result = helpers.defaults(target, source) as Record<string, unknown>;
				const expected: Record<string, unknown> = {};
				const own = Object.prototype.hasOwnProperty;
				for (const key of [...Object.keys(target), ...Object.keys(source)]) {
					if (UNSAFE.has(key) || own.call(expected, key)) continue;
					Object.defineProperty(expected, key, {
						value: own.call(target, key) && (target[key] !== undefined || !own.call(source, key)) ? target[key] : source[key],
						enumerable: true,
						writable: true,
						configurable: true
					});
				}
				return helpers.isEqual(result, expected);
			})
		);
	});

	it('defaultsDeep(a, b) equals deepMerge(b, a) for JSON data', function () {
		fc.assert(
			fc.property(jsonObject, jsonObject, function (a, b) {
				return helpers.isEqual(helpers.defaultsDeep(a, b), helpers.deepMerge(b, a));
			})
		);
	});

	it('deepMergeWith with the default options equals deepMerge', function () {
		fc.assert(
			fc.property(jsonObject, jsonObject, jsonObject, function (a, b, c) {
				return helpers.isEqual(helpers.deepMergeWith({}, a, b, c), helpers.deepMerge(a, b, c));
			})
		);
	});

	it('deepMergeWith concat keeps every item of both arrays in order; union removes repeats', function () {
		const list = fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 6 });
		fc.assert(
			fc.property(list, list, function (left, right) {
				const concat = helpers.deepMergeWith({ arrays: 'concat' }, { a: left }, { a: right }).a;
				const union = helpers.deepMergeWith({ arrays: 'union' }, { a: left }, { a: right }).a;
				return helpers.isEqual(concat, [...left, ...right]) && helpers.isEqual(union, [...new Set([...left, ...right])]);
			})
		);
	});

	it('updatePath writes the value, leaves the input intact and shares the untouched branches', function () {
		fc.assert(
			fc.property(jsonObject, fc.array(safeName, { minLength: 1, maxLength: 4 }), json, function (object, segments, value) {
				const path = segments.join('.');
				const before = helpers.deepClone(object);
				let result: Record<string, unknown>;
				try {
					result = helpers.updatePath(object, path, function () {
						return value;
					});
				} catch (error) {
					// Only a primitive on the path can make it fail.
					return error instanceof TypeError && helpers.isEqual(object, before);
				}
				const [head] = segments;
				const sharing = Object.keys(object).every(function (key) {
					return key === head || result[key] === object[key];
				});
				return helpers.isEqual(object, before) && helpers.isEqual(helpers.getPath(result, path as never), value) && sharing;
			})
		);
	});

	it('omitPath removes the path and nothing else', function () {
		fc.assert(
			fc.property(jsonObject, fc.array(safeName, { minLength: 1, maxLength: 3 }), function (object, segments) {
				const path = segments.join('.');
				const before = helpers.deepClone(object);
				const result = helpers.omitPath(object, path as never) as object;
				const mutated = helpers.deepClone(object);
				helpers.deletePath(mutated, path);
				const unchanged = !helpers.hasPath(object, path) || !Object.prototype.hasOwnProperty.call(object, segments[0]);
				return (
					helpers.isEqual(object, before) &&
					helpers.isEqual(result, mutated) &&
					(result === object) === helpers.isEqual(mutated, before) &&
					(unchanged || result !== object)
				);
			})
		);
	});

	it('toPath round-trips quoted bracket paths and plain dot paths, and never half-parses', function () {
		const segment = fc.string({ maxLength: 5 }).filter(function (key) {
			return !UNSAFE.has(key);
		});
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), fc.constantFrom('"', "'"), function (segments, quote) {
				const path = segments
					.map(function (key) {
						return '[' + quote + key.replace(/[\\'"]/g, '\\$&') + quote + ']';
					})
					.join('');
				return helpers.isEqual(helpers.toPath(path), segments);
			})
		);
		fc.assert(
			fc.property(
				fc.array(
					safeName.filter(function (key) {
						return !/[[\]]/.test(key);
					}),
					{ minLength: 1, maxLength: 5 }
				),
				function (segments) {
					return helpers.isEqual(helpers.toPath(segments.join('.')), segments);
				}
			)
		);
		fc.assert(
			fc.property(fc.string({ maxLength: 12, unit: fc.constantFrom('a', '.', '[', ']', '0', '1', "'", '"', '\\') }), function (path) {
				let segments: string[];
				try {
					segments = helpers.toPath(path);
				} catch (error) {
					return error instanceof RangeError;
				}
				// A successful parse re-parses identically from its canonical form.
				const canonical = segments
					.map(function (key) {
						return '["' + key.replace(/[\\"]/g, '\\$&') + '"]';
					})
					.join('');
				return helpers.isEqual(helpers.toPath(canonical), segments);
			})
		);
	});

	it('isMatch accepts equal values and sub-objects, and agrees with isEqual on leaves', function () {
		fc.assert(
			fc.property(jsonObject, fc.array(fc.string({ maxLength: 4 })), function (object, keys) {
				// Built from a clone: a sub-object sharing references with `object` matches by identity, even through keys isMatch never reads.
				const sub = helpers.pick(
					helpers.deepClone(object),
					keys.filter(function (key) {
						return !UNSAFE.has(key);
					}) as never[]
				);
				return helpers.isMatch(object, helpers.deepClone(object)) === !hasUnsafeKey(object) && helpers.isMatch(object, sub) === !hasUnsafeKey(sub);
			})
		);
		fc.assert(
			fc.property(anyValue, anyValue, function (a, b) {
				// Non-plain leaves are compared with isEqual.
				return isPlainObject(b) || Array.isArray(b) || helpers.isMatch(a, b) === helpers.isEqual(a, b);
			})
		);
	});

	/**
	 * Whether a JSON tree has a key that `isMatch` never reads.
	 */
	function hasUnsafeKey(value: unknown): boolean {
		if (Array.isArray(value)) return value.some(hasUnsafeKey);
		if (!isPlainObject(value)) return false;
		return Object.keys(value).some(function (key) {
			return UNSAFE.has(key) || hasUnsafeKey(value[key]);
		});
	}

	it('shallowEqual agrees with isEqual on flat records and holds for shallow clones', function () {
		const flat = fc.dictionary(fc.string({ maxLength: 2 }), fc.oneof(fc.integer({ min: -2, max: 2 }), fc.constant(NaN), fc.boolean(), fc.constant(null)), { maxKeys: 4 });
		fc.assert(
			fc.property(flat, flat, function (a, b) {
				return helpers.shallowEqual(a, b) === helpers.isEqual(a, b) && helpers.shallowEqual(a, helpers.clone(a));
			})
		);
		fc.assert(
			fc.property(fc.oneof(record, fc.array(anyValue)), function (value) {
				return helpers.shallowEqual(value, helpers.clone(value)) && helpers.shallowEqual(helpers.clone(value), value);
			})
		);
	});

	it('transformKeysDeep with the identity copies the data; the case helpers agree with the strings module', function () {
		fc.assert(
			fc.property(json, function (value) {
				const copy = helpers.transformKeysDeep(value, function (key) {
					return key;
				});
				return helpers.isEqual(copy, value) && (!isPlainObject(value) || copy !== value);
			})
		);
		fc.assert(
			fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.integer(), { maxKeys: 5 }), function (object) {
				let result: Record<string, unknown>;
				try {
					result = helpers.toSnakeCaseKeys(object) as Record<string, unknown>;
				} catch (error) {
					// Only a collision can make it fail.
					const names = Object.keys(object).map(function (key) {
						return key === '__proto__' ? key : strings.toSnakeCase(key);
					});
					return error instanceof RangeError && new Set(names).size < names.length;
				}
				return Object.keys(object).every(function (key) {
					return result[key === '__proto__' ? key : strings.toSnakeCase(key)] === object[key];
				});
			})
		);
	});

	it('stableStringify ignores key order, round-trips JSON, and is injective on JSON data', function () {
		fc.assert(
			fc.property(json, function (value) {
				const text = helpers.stableStringify(value);
				return text === helpers.stableStringify(reverseKeys(value)) && helpers.isEqual(JSON.parse(text), value);
			})
		);
		const small = fc.jsonValue({ maxDepth: 2 }).map(function (value) {
			return JSON.parse(JSON.stringify(value).replace(/-0\b(?!\.)/g, '0'));
		});
		fc.assert(
			fc.property(small, small, function (a, b) {
				return (helpers.stableStringify(a) === helpers.stableStringify(b)) === helpers.isEqual(a, b);
			})
		);
	});

	it('stableStringify and hash give the same result for deep clones of any data', function () {
		fc.assert(
			fc.property(anyValue, function (value) {
				let text: string;
				try {
					text = helpers.stableStringify(value);
				} catch (error) {
					// fast-check's anything() may contain symbols (keys are ignored, values are not).
					return error instanceof TypeError;
				}
				const clone = helpers.deepClone(value);
				return (
					text === helpers.stableStringify(clone) &&
					helpers.hash(value) === helpers.hash(clone) &&
					Number.isSafeInteger(helpers.hash(value)) &&
					helpers.hash(value) >= 0
				);
			})
		);
	});

	it('sortKeys sorts, keeps the data and is idempotent', function () {
		fc.assert(
			fc.property(jsonObject, function (object) {
				const sorted = helpers.sortKeys(object, { deep: true });
				const keys = Object.keys(sorted);
				const integers = keys.filter(function (key) {
					return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
				});
				const others = keys.slice(integers.length);
				return (
					helpers.isEqual(sorted, object) &&
					helpers.isEqual(others, [...others].sort()) &&
					JSON.stringify(helpers.sortKeys(sorted, { deep: true })) === JSON.stringify(sorted)
				);
			})
		);
	});

	it('evolve with identity transforms copies the data; mapEntries with identity entries matches Object.entries', function () {
		fc.assert(
			fc.property(jsonObject, function (object) {
				const identity: Record<string, (value: unknown) => unknown> = {};
				for (const key of Object.keys(object)) {
					Object.defineProperty(identity, key, {
						value: function (value: unknown) {
							return value;
						},
						enumerable: true
					});
				}
				const evolved = helpers.evolve(object, identity as never);
				const mapped = helpers.mapEntries(object, function (value, key) {
					return [key, value];
				});
				return helpers.isEqual(evolved, object) && evolved !== object && helpers.isEqual(mapped, object);
			})
		);
	});

	it('findEntry matches Object.entries(...).find', function () {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.integer(), { maxKeys: 8 }), fc.integer(), function (object, threshold) {
				function above(value: number): boolean {
					return value > threshold;
				}
				const expected = Object.entries(object).find(function ([, value]) {
					return above(value);
				});
				return helpers.isEqual(helpers.findEntry(object, above), expected) && helpers.findKey(object, above) === expected?.[0];
			})
		);
	});
});

/** Small JSON trees over few keys and values, so that two of them often share parts (and keys need escaping or are unsafe names). */
const smallJson: fc.Arbitrary<unknown> = fc.letrec(function (tie) {
	return {
		value: fc.oneof(
			{ depthSize: 'small', withCrossShrink: true },
			fc.constantFrom<unknown>(0, 1, 'x', null, true),
			fc.array(tie('value'), { maxLength: 4 }),
			fc.dictionary(fc.constantFrom('a', 'b', 'c', '~', 'a/b', '__proto__', 'constructor'), tie('value'), { maxKeys: 4 })
		)
	};
}).value;

/** {@link smallJson} with `undefined` among the values (object members that JSON drops). */
const withUndefined: fc.Arbitrary<unknown> = fc.letrec(function (tie) {
	return {
		value: fc.oneof(
			{ depthSize: 'small', withCrossShrink: true },
			fc.constantFrom<unknown>(0, 1, undefined, null),
			fc.array(tie('value'), { maxLength: 3 }),
			fc.dictionary(fc.constantFrom('a', 'b', 'c'), tie('value'), { maxKeys: 3 })
		)
	};
}).value;

/**
 * Copies a value without its object members whose value is `undefined` (what `JSON.stringify` drops; array items are kept).
 */
function withoutUndefinedMembers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutUndefinedMembers);
	if (!isPlainObject(value)) return value;
	const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
	for (const key of Object.keys(value)) if (value[key] !== undefined) copy[key] = withoutUndefinedMembers(value[key]);
	return copy;
}

/** A pair of JSON values: independent, or the second derived from the first. */
const jsonPair = fc.oneof(
	fc.tuple(fc.jsonValue({ maxDepth: 4 }), fc.jsonValue({ maxDepth: 4 })),
	fc.tuple(smallJson, smallJson),
	smallJson.chain(function (value) {
		return fc.tuple(fc.constant(value), fc.constant(helpers.deepClone(value)));
	})
);

/**
 * A plain object or a null-prototype object (what JSON Patch walks).
 */
function isWalkable(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

/**
 * A mutable reference implementation of JSON Patch (RFC 6902), applied to a deep copy of the document: it throws on any failure.
 */
function referenceApply(document: unknown, operations: ReadonlyArray<helpers.JsonPatchOperation>): unknown {
	let root = helpers.deepClone(document);
	function parse(pointer: string): string[] {
		return pointer === ''
			? []
			: pointer
					.slice(1)
					.split('/')
					.map(function (segment) {
						return segment.replace(/~1/g, '/').replace(/~0/g, '~');
					});
	}
	function isIndex(segment: string): boolean {
		return /^(?:0|[1-9][0-9]*)$/.test(segment);
	}
	function get(segments: string[]): unknown {
		let node = root;
		for (const segment of segments) {
			if (Array.isArray(node)) {
				if (!isIndex(segment) || Number(segment) >= node.length) throw new Error('missing');
				node = node[Number(segment)];
			} else if (isWalkable(node)) {
				if (!Object.hasOwn(node, segment)) throw new Error('missing');
				node = node[segment];
			} else throw new Error('not a container');
		}
		return node;
	}
	function set(container: object, key: string, value: unknown): void {
		Object.defineProperty(container, key, { value, writable: true, enumerable: true, configurable: true });
	}
	function add(segments: string[], value: unknown): void {
		if (segments.length === 0) {
			root = value;
			return;
		}
		const parent = get(segments.slice(0, -1));
		const key = segments[segments.length - 1];
		if (Array.isArray(parent)) {
			const index = key === '-' ? parent.length : isIndex(key) ? Number(key) : NaN;
			if (!(index <= parent.length)) throw new Error('bad index');
			parent.splice(index, 0, value);
		} else if (isWalkable(parent)) set(parent, key, value);
		else throw new Error('not a container');
	}
	function remove(segments: string[]): void {
		if (segments.length === 0) throw new Error('root');
		get(segments);
		const parent = get(segments.slice(0, -1)) as Record<string, unknown> | unknown[];
		const key = segments[segments.length - 1];
		if (Array.isArray(parent)) parent.splice(Number(key), 1);
		else delete parent[key];
	}
	for (const operation of operations) {
		const path = parse(operation.path);
		switch (operation.op) {
			case 'add':
				add(path, helpers.deepClone(operation.value));
				break;
			case 'remove':
				remove(path);
				break;
			case 'replace':
				get(path);
				if (path.length === 0) root = helpers.deepClone(operation.value);
				else set(get(path.slice(0, -1)) as object, path[path.length - 1], helpers.deepClone(operation.value));
				break;
			case 'move': {
				const from = parse(operation.from);
				const value = get(from);
				const inside = from.every(function (segment, index) {
					return segment === path[index];
				});
				if (from.length < path.length && inside) throw new Error('inside itself');
				// Moving a value to where it is changes nothing (even for the whole document, which cannot be removed).
				if (from.length === path.length && inside) break;
				remove(from);
				add(path, value);
				break;
			}
			case 'copy':
				add(path, helpers.deepClone(get(parse(operation.from))));
				break;
			case 'test':
				if (!helpers.isEqual(get(path), operation.value)) throw new Error('test');
				break;
		}
	}
	return root;
}

/** JSON Pointers over the keys of {@link smallJson} (and array indices), escaped. */
const pointer = fc.array(fc.constantFrom('a', 'b', '~', 'a/b', '__proto__', '0', '1', '2', '-', '01'), { maxLength: 3 }).map(function (segments) {
	return segments
		.map(function (segment) {
			return '/' + segment.replace(/~/g, '~0').replace(/\//g, '~1');
		})
		.join('');
});

/** JSON Patch operations over {@link pointer}s. */
const operation: fc.Arbitrary<helpers.JsonPatchOperation> = fc.oneof(
	fc.record({ op: fc.constantFrom('add', 'replace', 'test'), path: pointer, value: smallJson }) as fc.Arbitrary<helpers.JsonPatchOperation>,
	fc.record({ op: fc.constant('remove'), path: pointer }) as fc.Arbitrary<helpers.JsonPatchOperation>,
	fc.record({ op: fc.constantFrom('move', 'copy'), from: pointer, path: pointer }) as fc.Arbitrary<helpers.JsonPatchOperation>
);

/**
 * Checks the sharing invariant of replaceEqualDeep: wherever `prev` and `next` hold deeply equal values, `result` holds `prev`'s.
 */
function expectShared(prev: unknown, next: unknown, result: unknown): void {
	if (helpers.isEqual(prev, next)) {
		expect(result).toBe(prev);
		return;
	}
	if (typeof next !== 'object' || next === null || typeof prev !== 'object' || prev === null) return;
	if (Array.isArray(next) && Array.isArray(prev)) {
		next.forEach(function (item, index) {
			if (index < prev.length) expectShared(prev[index], item, (result as unknown[])[index]);
		});
	} else if (isPlainObject(next) && isPlainObject(prev) && Object.getPrototypeOf(next) === Object.getPrototypeOf(prev)) {
		for (const key of Object.keys(next)) if (Object.hasOwn(prev, key)) expectShared(prev[key], next[key], (result as Record<string, unknown>)[key]);
	}
}

describe('structural sharing and JSON Patch (properties)', function () {
	it('replaceEqualDeep returns a value equal to next, sharing every part equal to prev', function () {
		fc.assert(
			fc.property(jsonPair, function ([prev, next]) {
				const prevCopy = helpers.deepClone(prev);
				const nextCopy = helpers.deepClone(next);
				const result = helpers.replaceEqualDeep(prev, next);
				expect(helpers.isEqual(result, next)).toBe(true);
				expectShared(prev, next, result);
				expect(helpers.isEqual(prev, prevCopy)).toBe(true);
				expect(helpers.isEqual(next, nextCopy)).toBe(true);
				// Sharing is idempotent: the result shares everything with itself.
				expect(helpers.replaceEqualDeep(result, helpers.deepClone(result))).toBe(result);
			})
		);
	});

	it('applyPatch(a, createPatch(a, b)) equals b, without changing a', function () {
		fc.assert(
			fc.property(jsonPair, function ([a, b]) {
				const snapshot = helpers.deepClone(a);
				const patch = helpers.createPatch(a, b);
				expect(helpers.isEqual(helpers.applyPatch(a, patch), b)).toBe(true);
				expect(helpers.isEqual(a, snapshot)).toBe(true);
				expect(patch.length === 0).toBe(helpers.isEqual(a, b));
				// The patch survives JSON serialization (when `b` does: null-prototype objects come back with `Object.prototype`).
				if (helpers.isEqual(JSON.parse(JSON.stringify(b)), b)) expect(helpers.isEqual(helpers.applyPatch(a, JSON.parse(JSON.stringify(patch))), b)).toBe(true);
			})
		);
	});

	it('applyPatch(a, createPatch(a, b)) equals b up to undefined object members', function () {
		fc.assert(
			fc.property(fc.tuple(withUndefined, withUndefined), function ([a, b]) {
				const patch = helpers.createPatch(a, b);
				expect(helpers.isEqual(withoutUndefinedMembers(helpers.applyPatch(a, patch)), withoutUndefinedMembers(b))).toBe(true);
				expect(patch.length === 0).toBe(helpers.isEqual(withoutUndefinedMembers(a), withoutUndefinedMembers(b)));
			})
		);
	});

	it('createPatch gives one operation per item for a single inserted or removed run', function () {
		fc.assert(
			fc.property(fc.array(smallJson, { maxLength: 8 }), fc.array(smallJson, { maxLength: 4 }), fc.nat(), function (items, run, at) {
				const position = at % (items.length + 1);
				const longer = [...items.slice(0, position), ...run, ...items.slice(position)];
				const inserted = helpers.createPatch(items, longer);
				expect(inserted).toHaveLength(run.length);
				for (const step of inserted) expect(step.op).toBe('add');
				const removed = helpers.createPatch(longer, items);
				expect(removed).toHaveLength(run.length);
				for (const step of removed) expect(step.op).toBe('remove');
			})
		);
	});

	it('applyPatch agrees with a mutable reference implementation, and never changes its input', function () {
		fc.assert(
			fc.property(smallJson, fc.array(operation, { maxLength: 6 }), function (document, operations) {
				const snapshot = helpers.deepClone(document);
				let expected: unknown;
				let failed = false;
				try {
					expected = referenceApply(document, operations);
				} catch {
					failed = true;
				}
				if (failed) {
					expect(function () {
						helpers.applyPatch(document, operations);
					}).toThrow(helpers.JsonPatchError);
				} else expect(helpers.isEqual(helpers.applyPatch(document, operations), expected)).toBe(true);
				expect(helpers.isEqual(document, snapshot)).toBe(true);
			}),
			// Most random sequences fail at some step: more runs make sure that many apply in full.
			{ numRuns: 300 }
		);
	});
});
