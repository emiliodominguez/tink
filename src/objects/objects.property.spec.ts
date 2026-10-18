import fc from 'fast-check';
import * as helpers from '.';
import { isPlainObject } from '../guards/index.js';

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

	describe('setInObjectByKeys / getFromObjectByKeys', function () {
		const segment = fc.oneof(fc.stringMatching(/^[a-z]{1,5}$/), fc.nat(4).map(String));
		const path = fc.array(segment, { minLength: 1, maxLength: 5 }).map(function (segments) {
			return segments.join('.');
		});

		it('get after set returns the stored value', function () {
			fc.assert(
				fc.property(path, anyValue, function (keys, value) {
					const target: Record<string, unknown> = {};
					expect(helpers.setInObjectByKeys(target, keys, value)).toBe(target);
					expect(Object.is(helpers.getFromObjectByKeys(target, keys as any), value)).toBe(true);
				})
			);
		});

		it('setting a second, non-overlapping path keeps the first value', function () {
			fc.assert(
				fc.property(path, path, fc.integer(), fc.integer(), function (first, second, a, b) {
					fc.pre(!first.startsWith(second) && !second.startsWith(first));
					const target: Record<string, unknown> = {};
					helpers.setInObjectByKeys(target, first, a);
					helpers.setInObjectByKeys(target, second, b);
					expect(helpers.getFromObjectByKeys(target, first as any)).toBe(a);
					expect(helpers.getFromObjectByKeys(target, second as any)).toBe(b);
				})
			);
		});

		it('hasInObjectByKeys agrees with getFromObjectByKeys, and unsafe or Object.prototype names never resolve', function () {
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
					const resolved = helpers.getFromObjectByKeys(root, fullPath as any, missing);
					const has = helpers.hasInObjectByKeys(root, fullPath);
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

		it('getFromObjectByKeys never throws and falls back to the default on missing paths', function () {
			fc.assert(
				fc.property(fc.jsonValue(), path, function (value, keys) {
					const result = helpers.getFromObjectByKeys({ root: value } as Record<string, unknown>, `root.${keys}` as any, 'fallback');
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

		it('flattenObject maps every path to a leaf readable with getFromObjectByKeys', function () {
			fc.assert(
				fc.property(jsonTree(roundTripKey), function (tree) {
					for (const [path, value] of Object.entries(helpers.flattenObject(tree))) {
						expect(helpers.getFromObjectByKeys(tree, path as any)).toBe(value);
						expect(helpers.hasInObjectByKeys(tree, path)).toBe(true);
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
						expect(helpers.getFromObjectByKeys(result, k as any)).toBe(i);
					});
				})
			);
		});

		it('hasInObjectByKeys / deleteFromObjectByKeys agree with setInObjectByKeys', function () {
			const path = fc.array(fc.oneof(fc.stringMatching(/^[a-z]{1,3}$/), fc.nat(3).map(String)), { minLength: 1, maxLength: 4 }).map(function (segments) {
				return segments.join('.');
			});
			fc.assert(
				fc.property(path, fc.anything(), function (keys, value) {
					const target: Record<string, unknown> = {};
					expect(helpers.hasInObjectByKeys(target, keys)).toBe(false);
					helpers.setInObjectByKeys(target, keys, value);
					expect(helpers.hasInObjectByKeys(target, keys)).toBe(true);
					expect(helpers.deleteFromObjectByKeys(target, keys)).toBe(true);
					expect(helpers.hasInObjectByKeys(target, keys)).toBe(false);
					expect(helpers.deleteFromObjectByKeys(target, keys)).toBe(false);
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

		it('diff paths are consistent with hasInObjectByKeys and the trees are equal iff the diff is empty', function () {
			fc.assert(
				fc.property(overlappingTree, overlappingTree, function (a, b) {
					const { added, removed, changed } = helpers.diff(a, b);
					for (const path of added) expect([helpers.hasInObjectByKeys(a, path), helpers.hasInObjectByKeys(b, path)]).toStrictEqual([false, true]);
					for (const path of removed) expect([helpers.hasInObjectByKeys(a, path), helpers.hasInObjectByKeys(b, path)]).toStrictEqual([true, false]);
					for (const path of changed) {
						expect(helpers.isEqual(helpers.getFromObjectByKeys(a, path as any), helpers.getFromObjectByKeys(b, path as any))).toBe(false);
					}
					expect(added.length + removed.length + changed.length === 0).toBe(helpers.isEqual(a, b));
				})
			);
		});
	});
});
