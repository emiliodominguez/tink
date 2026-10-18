import * as vm from 'vm';
import * as helpers from '.';
import * as guards from '../guards/index.js';

type Equals<X, Y> = (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false;

function assertType<T extends true>(_value: T): void {}

describe('Objects helpers', function () {
	describe('merge', function () {
		it('should merge two objects correctly', function () {
			const result = helpers.merge({ a: 1, b: 2 }, { c: 3, d: 4 });
			expect(result).toStrictEqual({ a: 1, b: 2, c: 3, d: 4 });
		});

		it('should merge multiple objects correctly', function () {
			const result = helpers.merge({ a: 1, b: 2 }, { c: 3, d: 4 }, { e: 5, f: 6 });
			expect(result).toStrictEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
		});

		it('should override properties from earlier sources with properties from later sources', function () {
			const result = helpers.merge({ a: 1, b: 2 }, { a: 3, c: 4 }, { a: 5, d: 6 });
			expect(result).toStrictEqual({ a: 5, b: 2, c: 4, d: 6 });
		});

		it('should return a copy of the target if no sources are provided', function () {
			const target = { a: 1, b: 2 };
			const result = helpers.merge(target);
			expect(result).toStrictEqual({ a: 1, b: 2 });
			expect(result).not.toBe(target);
		});

		it('does not mutate any input and is shallow', function () {
			const nested = { deep: true };
			const target = { a: 1 };
			const source = { b: nested };
			const result = helpers.merge(target, source);
			expect(target).toStrictEqual({ a: 1 });
			expect(source).toStrictEqual({ b: nested });
			expect(result.b).toBe(nested);
		});

		it('copies symbol keys, lets undefined override, and skips nullish sources', function () {
			const key = Symbol('k');
			const result = helpers.merge({ a: 1, [key]: 1 }, { a: undefined }, null as any, undefined as any, { [key]: 2 });
			expect(result).toStrictEqual({ a: undefined, [key]: 2 });
			expect(Object.prototype.hasOwnProperty.call(result, 'a')).toBe(true);
		});

		it('treats a "__proto__" key as an own property instead of changing the prototype', function () {
			const result = helpers.merge({}, JSON.parse('{"__proto__":{"polluted":1}}'));
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect((result as any).polluted).toBeUndefined();
			expect(({} as any).polluted).toBeUndefined();
		});

		it('is typed left-to-right with later keys overriding (disjoint objects compile)', function () {
			const result = helpers.merge({ a: 1, b: 'x' }, { b: true, c: [1] }, { d: null });
			assertType<Equals<typeof result, { a: number; b: boolean; c: number[]; d: null }>>(true);
			const optional = helpers.merge({ a: 1 }, {} as { a?: string; z?: number });
			assertType<Equals<typeof optional, { a: number | string | undefined; z?: number }>>(true);
			const spread = helpers.merge({ a: 1 }, ...([] as Array<{ b: string }>));
			assertType<Equals<typeof spread, { a: number; b?: string | undefined }>>(true);
			expect(result.b).toBe(true);
		});
	});

	describe('clone', function () {
		it('should not trust a forged ArrayBuffer tag, and should copy typed-array subclasses with a custom tag', function () {
			const fakeBuffer = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 4 };
			const fakeShared = { [Symbol.toStringTag]: 'SharedArrayBuffer' };
			const fakeArray = Object.assign([1, 2], { [Symbol.toStringTag]: 'ArrayBuffer' });

			// (Jest's own equality trusts the tag too, so these copies are checked field by field.)
			const bufferCopy = helpers.clone(fakeBuffer);
			const sharedFakeCopy = helpers.deepClone(fakeShared);
			expect(bufferCopy).not.toBe(fakeBuffer);
			expect(Object.getPrototypeOf(bufferCopy)).toBe(Object.prototype);
			expect([bufferCopy.byteLength, bufferCopy[Symbol.toStringTag]]).toEqual([4, 'ArrayBuffer']);
			expect(sharedFakeCopy).not.toBe(fakeShared);
			expect(sharedFakeCopy[Symbol.toStringTag]).toBe('SharedArrayBuffer');
			expect(helpers.isEqual(fakeArray, Object.assign([1, 2], { [Symbol.toStringTag]: 'ArrayBuffer' }))).toBe(true);
			expect(helpers.isEqual(fakeArray, Object.assign([1, 3], { [Symbol.toStringTag]: 'ArrayBuffer' }))).toBe(false);

			class Tagged extends Uint8Array {}
			// A subclass can report any tag; the copy must still use the real typed-array constructor.
			Object.defineProperty(Tagged.prototype, Symbol.toStringTag, {
				get: function () {
					return 'Custom';
				}
			});
			const tagged = new Tagged([1, 2, 3]);
			const copy = helpers.deepClone(tagged);
			expect(copy).toBeInstanceOf(Tagged);
			expect(Array.from(copy)).toEqual([1, 2, 3]);
			expect(copy.buffer).not.toBe(tagged.buffer);

			const shared = new SharedArrayBuffer(4);
			new Uint8Array(shared)[0] = 7;
			const sharedCopy = helpers.clone(shared);
			expect(sharedCopy).not.toBe(shared);
			expect(new Uint8Array(sharedCopy)[0]).toBe(7);

			// Where SharedArrayBuffer is hidden (browser pages that are not cross-origin isolated), a forged tag is still rejected.
			const global = globalThis as any;
			const original = global.SharedArrayBuffer;
			let isolated: typeof helpers | undefined;
			try {
				delete global.SharedArrayBuffer;
				jest.isolateModules(function () {
					isolated = jest.requireActual<typeof helpers>('./index');
				});
			} finally {
				global.SharedArrayBuffer = original;
			}
			const isolatedCopy = isolated!.clone(fakeShared);
			expect(isolatedCopy).not.toBe(fakeShared);
			expect(isolatedCopy[Symbol.toStringTag]).toBe('SharedArrayBuffer');

			const view = new DataView(new ArrayBuffer(2));
			view.setUint8(1, 9);
			const viewCopy = helpers.clone(view);
			expect(viewCopy).toBeInstanceOf(DataView);
			expect(viewCopy.getUint8(1)).toBe(9);
		});

		it('should return a new object with the same properties', function () {
			const original = { name: 'John', age: 30 };
			const copy = helpers.clone(original);
			expect(copy).toStrictEqual(original);
			expect(copy).not.toBe(original);
		});

		it('is shallow: nested objects are shared', function () {
			const original = { name: 'John', address: { street: '1st Ave', city: 'New York' } };
			const copy = helpers.clone(original);
			expect(copy).toStrictEqual(original);
			expect(copy.address).toBe(original.address);
		});

		it('keeps arrays as arrays (was converted to an object before), preserving holes', function () {
			const copy = helpers.clone([1, 2]);
			expect(Array.isArray(copy)).toBe(true);
			expect(copy).toStrictEqual([1, 2]);
			// eslint-disable-next-line no-sparse-arrays
			const sparse = helpers.clone([1, , 3]);
			expect(sparse).toHaveLength(3);
			expect(1 in sparse).toBe(false);
		});

		it('keeps the extra keys of arrays (regexp matches, symbol keys, holes plus extra keys)', function () {
			const symbol = Symbol('tag');
			const match = /b(?<rest>c)/.exec('abc') as RegExpExecArray;
			// eslint-disable-next-line no-sparse-arrays
			const sparse = Object.assign([, 'x'], { label: 'two keys, like a dense array of length 2' });
			const tagged = Object.assign(['a'], { [symbol]: true });
			for (const copy of [helpers.clone(match), helpers.deepClone(match)]) {
				expect(Array.from(copy)).toStrictEqual(['bc', 'c']);
				expect(copy.index).toBe(1);
				expect(copy.input).toBe('abc');
				expect(copy.groups?.rest).toBe('c');
			}
			for (const copy of [helpers.clone(sparse), helpers.deepClone(sparse)]) {
				expect(0 in copy).toBe(false);
				expect(copy[1]).toBe('x');
				expect(copy.label).toBe(sparse.label);
			}
			for (const copy of [helpers.clone(tagged), helpers.deepClone(tagged)]) {
				expect(Array.from(copy)).toStrictEqual(['a']);
				expect(copy[symbol]).toBe(true);
			}
		});

		it('preserves class instance prototypes and symbol keys', function () {
			class Point {
				x: number;
				y: number;
				constructor(x: number, y: number) {
					this.x = x;
					this.y = y;
				}
				sum(): number {
					return this.x + this.y;
				}
			}
			const tag = Symbol('tag');
			const original = Object.assign(new Point(1, 2), { [tag]: 'p' });
			const copy = helpers.clone(original);
			expect(copy).toBeInstanceOf(Point);
			expect(copy.sum()).toBe(3);
			expect(copy[tag]).toBe('p');
			expect(copy).not.toBe(original);
		});

		it('creates new Date, Map, Set and RegExp instances', function () {
			const date = new Date(5);
			const map = new Map([['a', { v: 1 }]]);
			const set = new Set([1, 2]);
			const regexp = /a/g;
			regexp.lastIndex = 3;

			const dateCopy = helpers.clone(date);
			expect(dateCopy).not.toBe(date);
			expect(dateCopy.getTime()).toBe(5);

			const mapCopy = helpers.clone(map);
			expect(mapCopy).not.toBe(map);
			expect(mapCopy.get('a')).toBe(map.get('a'));

			const setCopy = helpers.clone(set);
			expect(setCopy).not.toBe(set);
			expect([...setCopy]).toStrictEqual([1, 2]);

			const regexpCopy = helpers.clone(regexp);
			expect(regexpCopy).not.toBe(regexp);
			expect(regexpCopy.source).toBe('a');
			expect(regexpCopy.flags).toBe('g');
			expect(regexpCopy.lastIndex).toBe(3);
		});

		it('keeps subclass prototypes of built-ins', function () {
			class MyDate extends Date {}
			const copy = helpers.clone(new MyDate(1));
			expect(copy).toBeInstanceOf(MyDate);
			expect(copy.getTime()).toBe(1);
		});

		it('copies binary data', function () {
			const bytes = new Uint8Array([1, 2, 3]);
			const copy = helpers.clone(bytes);
			expect(copy).not.toBe(bytes);
			expect(copy.buffer).not.toBe(bytes.buffer);
			expect(Array.from(copy)).toStrictEqual([1, 2, 3]);

			const buffer = new ArrayBuffer(4);
			const bufferCopy = helpers.clone(buffer);
			expect(bufferCopy).not.toBe(buffer);
			expect(bufferCopy.byteLength).toBe(4);
		});

		it('copies boxed primitives', function () {
			const boxed = new Number(5);
			const copy = helpers.clone(boxed);
			expect(copy).not.toBe(boxed);
			expect(copy.valueOf()).toBe(5);
			const deep = helpers.deepClone({ s: Object('ab') as string });
			expect(typeof deep.s).toBe('object');
			expect(deep.s.valueOf()).toBe('ab');
		});

		it('recognises boxed primitives by their internal slot, even with Object.prototype as prototype', function () {
			const five = Object.setPrototypeOf(new Number(5), Object.prototype) as object;
			for (const copy of [helpers.clone(five), helpers.deepClone(five)]) {
				expect(copy).not.toBe(five);
				expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
				expect(Number.prototype.valueOf.call(copy)).toBe(5);
			}
			expect(helpers.isEqual(five, Object.setPrototypeOf(new Number(6), Object.prototype))).toBe(false);
			expect(helpers.isEqual(five, Object.setPrototypeOf(new Number(5), Object.prototype))).toBe(true);
		});

		it('keeps error messages', function () {
			const error = new TypeError('boom');
			const copy = helpers.clone(error);
			expect(copy).not.toBe(error);
			expect(copy).toBeInstanceOf(TypeError);
			expect(copy.message).toBe('boom');
		});

		it('keeps the descriptors of error properties (message stays non-enumerable, accessors stay accessors)', function () {
			const error = new TypeError('boom');
			Object.defineProperty(error, 'code', {
				get: function (): number {
					return 7;
				},
				enumerable: true,
				configurable: true
			});
			for (const copy of [helpers.clone(error), helpers.deepClone(error)]) {
				expect(Object.getOwnPropertyDescriptor(copy, 'message')).toStrictEqual(Object.getOwnPropertyDescriptor(error, 'message'));
				expect(typeof Object.getOwnPropertyDescriptor(copy, 'code')?.get).toBe('function');
			}
		});

		it('reads own getters of class instances into plain data properties', function () {
			class Box {
				declare value: number;
			}
			const box = new Box();
			Object.defineProperty(box, 'value', {
				get: function (): number {
					return 3;
				},
				enumerable: true,
				configurable: true
			});
			for (const copy of [helpers.clone(box), helpers.deepClone(box)]) {
				expect(copy).toBeInstanceOf(Box);
				expect(Object.getOwnPropertyDescriptor(copy, 'value')).toStrictEqual({ value: 3, writable: true, enumerable: true, configurable: true });
			}
		});

		it('returns primitives, functions, weak collections and promises as-is', function () {
			function fn(): number {
				return 1;
			}
			const weakMap = new WeakMap();
			const promise = Promise.resolve();
			expect(helpers.clone(1)).toBe(1);
			expect(helpers.clone('a')).toBe('a');
			expect(helpers.clone(null)).toBe(null);
			expect(helpers.clone(undefined)).toBe(undefined);
			expect(helpers.clone(fn)).toBe(fn);
			expect(helpers.clone(weakMap)).toBe(weakMap);
			expect(helpers.clone(promise)).toBe(promise);
		});
	});

	describe('deepClone', function () {
		it('copies nested structures without sharing references', function () {
			const original = { a: [1, { b: 2 }], c: { d: { e: 'x' } }, when: new Date(10) };
			const copy = helpers.deepClone(original);
			expect(copy).toStrictEqual(original);
			expect(copy.a).not.toBe(original.a);
			expect(copy.a[1]).not.toBe(original.a[1]);
			expect(copy.c.d).not.toBe(original.c.d);
			expect(copy.when).not.toBe(original.when);
			expect(copy.when.getTime()).toBe(10);
		});

		it('returns primitives as-is and copies functions by reference', function () {
			function fn(): void {}
			expect(helpers.deepClone(1)).toBe(1);
			expect(helpers.deepClone(NaN)).toBeNaN();
			expect(helpers.deepClone(null)).toBe(null);
			expect(helpers.deepClone(fn)).toBe(fn);
			expect(helpers.deepClone({ fn }).fn).toBe(fn);
		});

		it('handles circular and shared references', function () {
			const shared = { s: 1 };
			const original: any = { left: shared, right: shared, list: [] as any[] };
			original.self = original;
			original.list.push(original.list, original);
			const copy = helpers.deepClone(original);
			expect(copy).not.toBe(original);
			expect(copy.self).toBe(copy);
			expect(copy.left).toBe(copy.right);
			expect(copy.left).not.toBe(shared);
			expect(copy.list[0]).toBe(copy.list);
			expect(copy.list[1]).toBe(copy);
		});

		it('handles circular references through null-prototype objects and class instances', function () {
			class Node {
				next: unknown = null;
			}
			const bare = Object.create(null) as { self?: unknown };
			bare.self = bare;
			const node = new Node();
			node.next = node;
			const bareCopy = helpers.deepClone(bare);
			const nodeCopy = helpers.deepClone(node);
			expect(bareCopy).not.toBe(bare);
			expect(bareCopy.self).toBe(bareCopy);
			expect(nodeCopy).toBeInstanceOf(Node);
			expect(nodeCopy.next).toBe(nodeCopy);
		});

		it('clones Map keys and values and Set members', function () {
			const key = { k: 1 };
			const value = { v: 1 };
			const member = { m: 1 };
			const original = { map: new Map<object, object>([[key, value]]), set: new Set([member]) };
			const copy = helpers.deepClone(original);
			const [[copiedKey, copiedValue]] = Array.from(copy.map);
			const [copiedMember] = Array.from(copy.set);
			expect(copiedKey).toStrictEqual(key);
			expect(copiedKey).not.toBe(key);
			expect(copiedValue).toStrictEqual(value);
			expect(copiedValue).not.toBe(value);
			expect(copiedMember).toStrictEqual(member);
			expect(copiedMember).not.toBe(member);
		});

		it('handles circular Maps and Sets', function () {
			const map = new Map<string, unknown>();
			map.set('self', map);
			const set = new Set<unknown>();
			set.add(set);
			const mapCopy = helpers.deepClone(map);
			const setCopy = helpers.deepClone(set);
			expect(mapCopy.get('self')).toBe(mapCopy);
			expect(setCopy.has(setCopy)).toBe(true);
		});

		it('copies RegExp with lastIndex, typed arrays, DataView and ArrayBuffer', function () {
			const regexp = /x/gi;
			regexp.lastIndex = 2;
			const floats = new Float64Array([1.5, NaN]);
			const view = new DataView(new ArrayBuffer(4), 1, 2);
			view.setUint8(0, 7);
			const original = { regexp, floats, view, buffer: new Uint16Array([1, 2]).buffer };
			const copy = helpers.deepClone(original);

			expect(copy.regexp).not.toBe(regexp);
			expect(copy.regexp.flags).toBe('gi');
			expect(copy.regexp.lastIndex).toBe(2);
			expect(copy.floats).toBeInstanceOf(Float64Array);
			expect(copy.floats.buffer).not.toBe(floats.buffer);
			expect(Array.from(copy.floats)).toStrictEqual([1.5, NaN]);
			expect(copy.view).toBeInstanceOf(DataView);
			expect(copy.view.byteLength).toBe(2);
			expect(copy.view.getUint8(0)).toBe(7);
			expect(copy.buffer).not.toBe(original.buffer);
			expect(new Uint16Array(copy.buffer)[1]).toBe(2);
		});

		it('preserves class prototypes, symbol keys and getters (as values)', function () {
			class Box {
				items: number[] = [1];
				get size(): number {
					return this.items.length;
				}
			}
			const sym = Symbol('s');
			const original = Object.assign(new Box(), { [sym]: { deep: true } });
			const copy = helpers.deepClone(original);
			expect(copy).toBeInstanceOf(Box);
			expect(copy.size).toBe(1);
			expect(copy.items).not.toBe(original.items);
			expect(copy[sym]).toStrictEqual({ deep: true });
			expect(copy[sym]).not.toBe(original[sym]);
		});

		it('copies errors including message and cause', function () {
			const error = new RangeError('bad', { cause: { code: 1 } });
			const copy = helpers.deepClone(error);
			expect(copy).toBeInstanceOf(RangeError);
			expect(copy.message).toBe('bad');
			expect(copy.cause).toStrictEqual({ code: 1 });
			expect(copy.cause).not.toBe(error.cause);
		});

		it('keeps null-prototype objects and array subclasses', function () {
			class List extends Array<number> {}
			const bare = Object.assign(Object.create(null), { a: 1 });
			const list = List.from([1, 2]) as List;
			expect(Object.getPrototypeOf(helpers.deepClone(bare))).toBe(null);
			const listCopy = helpers.deepClone(list);
			expect(listCopy).toBeInstanceOf(List);
			expect(Array.from(listCopy)).toStrictEqual([1, 2]);
		});

		it('returns weak collections and promises by reference', function () {
			const original = { weakSet: new WeakSet(), promise: Promise.resolve() };
			const copy = helpers.deepClone(original);
			expect(copy.weakSet).toBe(original.weakSet);
			expect(copy.promise).toBe(original.promise);
		});
	});

	describe('hasProperty', function () {
		it('should return true if the object has the specified own property', function () {
			expect(helpers.hasProperty({ name: 'John', age: 30 }, 'name')).toBe(true);
			expect(helpers.hasProperty({ value: undefined }, 'value')).toBe(true);
			expect(helpers.hasProperty([1], 0)).toBe(true);
		});

		it('should return false if the object does not have the specified property', function () {
			expect(helpers.hasProperty({ name: 'John', age: 30 }, 'email')).toBe(false);
		});

		it('ignores inherited properties (behaviour change: used to use `in`)', function () {
			expect(helpers.hasProperty({}, 'toString')).toBe(false);
			expect(helpers.hasProperty(Object.create({ inherited: 1 }), 'inherited')).toBe(false);
		});

		it('supports symbol keys and null-prototype objects', function () {
			const sym = Symbol('s');
			expect(helpers.hasProperty({ [sym]: 1 }, sym)).toBe(true);
			expect(helpers.hasProperty(Object.assign(Object.create(null), { a: 1 }), 'a')).toBe(true);
		});

		it('narrows the object type', function () {
			const value: object = { email: 'a@b.c' };
			if (helpers.hasProperty(value, 'email')) {
				const email: unknown = value.email;
				expect(email).toBe('a@b.c');
			}
		});
	});

	describe('getProperty', function () {
		it('should return the value of the specified property', function () {
			const result = helpers.getProperty({ name: 'John', age: 30 }, 'name');
			assertType<Equals<typeof result, string>>(true);
			expect(result).toBe('John');
		});

		it('returns undefined for missing properties', function () {
			expect(helpers.getProperty({ name: 'John' } as { name: string; email?: string }, 'email')).toBeUndefined();
		});
	});

	describe('setProperty', function () {
		it('should set (mutate) the specified property on the object', function () {
			const obj = {};
			helpers.setProperty(obj, 'property', 'value');
			expect(obj).toStrictEqual({ property: 'value' });
		});
	});

	describe('deleteProperty', function () {
		it('should delete (mutate) the specified property from the object', function () {
			const obj: { property?: string; other: number } = { property: 'value', other: 1 };
			helpers.deleteProperty(obj, 'property');
			expect(obj).toStrictEqual({ other: 1 });
		});
	});

	describe('getPropertyNames', function () {
		it('should return an array of all the names of properties of the object', function () {
			expect(helpers.getPropertyNames({ property1: 'value1', property2: 'value2' })).toStrictEqual(['property1', 'property2']);
		});

		it('includes non-enumerable own string keys but not symbols', function () {
			expect(helpers.getPropertyNames([1])).toStrictEqual(['0', 'length']);
			const obj = Object.defineProperty({ [Symbol('s')]: 1 }, 'hidden', { value: 1, enumerable: false });
			expect(helpers.getPropertyNames(obj)).toStrictEqual(['hidden']);
		});
	});

	describe('getFromObjectByKeys', function () {
		it('should return the correct nested value (inferred path type)', function () {
			const target = { a: { b: { c: 'hello world' } } };
			const result = helpers.getFromObjectByKeys(target, 'a.b.c');
			assertType<Equals<typeof result, string>>(true);
			expect(result).toBe('hello world');
		});

		it('should return the correct value for non-nested keys', function () {
			expect(helpers.getFromObjectByKeys({ a: 'hello world' }, 'a')).toBe('hello world');
		});

		it('should return undefined for non-existing keys', function () {
			expect(helpers.getFromObjectByKeys({ a: 'hello world' }, 'b' as any)).toBeUndefined();
		});

		it('returns the default value for a nullish target, whatever the number of segments', function () {
			expect(helpers.getFromObjectByKeys(null as any, 'a', 'fallback')).toBe('fallback');
			expect(helpers.getFromObjectByKeys(undefined as any, 'a.b', 'fallback')).toBe('fallback');
			expect(helpers.getFromObjectByKeys(null as any, 'a')).toBeUndefined();
		});

		it('does not throw on missing or null intermediates (used to throw)', function () {
			const target: { a: { x?: { y: number } | null } } = { a: {} };
			expect(helpers.getFromObjectByKeys(target, 'a.x.y')).toBeUndefined();
			target.a.x = null;
			expect(helpers.getFromObjectByKeys(target, 'a.x.y')).toBeUndefined();
			expect(helpers.getFromObjectByKeys(target, 'a.x')).toBeNull();
		});

		it('supports array index segments', function () {
			const target = { list: [{ id: 1 }, { id: 2 }] };
			const result = helpers.getFromObjectByKeys(target, 'list.1.id');
			assertType<Equals<typeof result, number | undefined>>(true);
			expect(result).toBe(2);
			expect(helpers.getFromObjectByKeys(target, 'list.5.id')).toBeUndefined();
		});

		it('returns the default value only when the resolved value is undefined', function () {
			const target: { a: { b?: number; n: null; z: number } } = { a: { n: null, z: 0 } };
			const fallback = helpers.getFromObjectByKeys(target, 'a.b', 42);
			assertType<Equals<typeof fallback, number>>(true);
			expect(fallback).toBe(42);
			expect(helpers.getFromObjectByKeys(target, 'a.z', 42)).toBe(0);
			expect(helpers.getFromObjectByKeys(target, 'a.n', 42)).toBeNull();
			expect(helpers.getFromObjectByKeys({ a: null as { b: string } | null }, 'a.b', 'def')).toBe('def');
		});
	});

	describe('setInObjectByKeys', function () {
		it('shadows an inherited accessor with a new own container instead of assigning through it', function () {
			class Settings {
				/**
				 * A read-only, inherited property.
				 * @returns {undefined} Always `undefined`
				 */
				get theme(): undefined {
					return undefined;
				}
			}
			const settings = helpers.setInObjectByKeys(new Settings() as any, 'theme.color', 'red');
			expect(Object.getOwnPropertyDescriptor(settings, 'theme')?.value).toStrictEqual({ color: 'red' });
			expect(new Settings().theme).toBeUndefined();
		});

		it('sets nested values, creating objects and arrays as needed, and returns the target', function () {
			const target: Record<string, any> = { keep: 1 };
			const result = helpers.setInObjectByKeys(target, 'a.list.0.id', 7);
			expect(result).toBe(target);
			expect(target).toStrictEqual({ keep: 1, a: { list: [{ id: 7 }] } });
			expect(Array.isArray(target.a.list)).toBe(true);
		});

		it('reuses existing intermediates and replaces null ones', function () {
			const target: Record<string, any> = { a: { b: 1 }, n: null, list: [{ x: 1 }] };
			helpers.setInObjectByKeys(target, 'a.c', 2);
			helpers.setInObjectByKeys(target, 'n.deep', true);
			helpers.setInObjectByKeys(target, 'list.0.y', 3);
			helpers.setInObjectByKeys(target, 'top', 'v');
			expect(target).toStrictEqual({ a: { b: 1, c: 2 }, n: { deep: true }, list: [{ x: 1, y: 3 }], top: 'v' });
		});

		it('throws RangeError for empty segments', function () {
			expect(function () {
				helpers.setInObjectByKeys({}, '', 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.setInObjectByKeys({}, 'a..b', 1);
			}).toThrow(RangeError);
			expect(function () {
				helpers.setInObjectByKeys({}, 'a.', 1);
			}).toThrow(RangeError);
		});

		it('throws RangeError for unsafe segments without touching the target or Object.prototype', function () {
			for (const path of ['__proto__.polluted', 'a.constructor.prototype.polluted', 'prototype', 'a.__proto__']) {
				const target = {};
				expect(function () {
					helpers.setInObjectByKeys(target, path, 1);
				}).toThrow(RangeError);
				expect(target).toStrictEqual({});
			}
			expect(({} as any).polluted).toBeUndefined();
		});

		it('throws TypeError when an intermediate is a primitive', function () {
			expect(function () {
				helpers.setInObjectByKeys({ a: 1 }, 'a.b', 2);
			}).toThrow(new TypeError('setInObjectByKeys: cannot set "a.b": "a" is a number, not an object'));
			expect(function () {
				helpers.setInObjectByKeys({}, 'a.__proto__', 2);
			}).toThrow(new RangeError('setInObjectByKeys: `path` must not contain the unsafe segment "__proto__", got "a.__proto__"'));
		});
	});

	describe('isEmpty', function () {
		it('should return true if the object is empty', function () {
			expect(helpers.isEmpty({})).toBe(true);
			expect(helpers.isEmpty(Object.create({ inherited: 1 }))).toBe(true);
			expect(helpers.isEmpty(Object.defineProperty({}, 'hidden', { value: 1 }))).toBe(true);
			expect(helpers.isEmpty(Object.defineProperty({}, Symbol('hidden'), { value: 1 }))).toBe(true);
		});

		it('ignores enumerable inherited keys but not own keys shadowing them', function () {
			const parent = { inherited: 1 };
			expect(helpers.isEmpty(Object.create(parent))).toBe(true);
			expect(helpers.isEmpty(Object.assign(Object.create(parent), { own: 1 }))).toBe(false);
		});

		it('should return false if the object is not empty', function () {
			expect(helpers.isEmpty({ a: 1, b: 2 })).toBe(false);
			expect(helpers.isEmpty({ [Symbol('s')]: 1 })).toBe(false);
		});

		it('handles arrays, strings, maps, sets and nullish values', function () {
			expect(helpers.isEmpty([])).toBe(true);
			expect(helpers.isEmpty([undefined])).toBe(false);
			expect(helpers.isEmpty('')).toBe(true);
			expect(helpers.isEmpty(' ')).toBe(false);
			expect(helpers.isEmpty(new Map())).toBe(true);
			expect(helpers.isEmpty(new Map([[1, 1]]))).toBe(false);
			expect(helpers.isEmpty(new Set())).toBe(true);
			expect(helpers.isEmpty(new Set([0]))).toBe(false);
			expect(helpers.isEmpty(null)).toBe(true);
			expect(helpers.isEmpty(undefined)).toBe(true);
		});

		it('treats other primitives as empty and functions by their own keys', function () {
			expect(helpers.isEmpty(0)).toBe(true);
			expect(helpers.isEmpty(true)).toBe(true);
			expect(helpers.isEmpty(function () {})).toBe(true);
			expect(helpers.isEmpty(Object.assign(function () {}, { a: 1 }))).toBe(false);
		});
	});

	describe('pick / omit', function () {
		it('pick keeps only the requested keys', function () {
			const result = helpers.pick({ a: 1, b: 'x', c: true }, ['a', 'c']);
			assertType<Equals<typeof result, { a: number; c: boolean }>>(true);
			expect(result).toStrictEqual({ a: 1, c: true });
		});

		it('pick skips missing keys and reads inherited getters', function () {
			class User {
				first = 'Ada';
				get upper(): string {
					return this.first.toUpperCase();
				}
			}
			expect(helpers.pick({} as { a?: number }, ['a'])).toStrictEqual({});
			expect(helpers.pick({ undefined: 1, a: 2 }, ['a'])).toStrictEqual({ a: 2 });
			expect(helpers.pick({ a: undefined, b: 1 } as { a?: number; b: number }, ['a'])).toStrictEqual({ a: undefined });
			expect(helpers.pick(new User(), ['upper'])).toStrictEqual({ upper: 'ADA' });
		});

		it('omit drops the requested keys and keeps symbol keys', function () {
			const sym = Symbol('s');
			const result = helpers.omit({ a: 1, b: 'x', [sym]: 2 }, ['b']);
			assertType<Equals<typeof result, { a: number; [sym]: number }>>(true);
			expect(result).toStrictEqual({ a: 1, [sym]: 2 });
			expect(helpers.omit({ a: 1 }, [])).toStrictEqual({ a: 1 });
		});

		it('do not mutate the input', function () {
			const input = { a: 1, b: 2 };
			helpers.pick(input, ['a']);
			helpers.omit(input, ['a']);
			expect(input).toStrictEqual({ a: 1, b: 2 });
		});
	});

	describe('mapValues / mapKeys', function () {
		it('mapValues maps every own enumerable value', function () {
			const result = helpers.mapValues({ a: 1, b: 2 }, function (value, key) {
				return `${String(key)}=${value * 10}`;
			});
			assertType<Equals<typeof result, { a: string; b: string }>>(true);
			expect(result).toStrictEqual({ a: 'a=10', b: 'b=20' });
			expect(
				helpers.mapValues({}, function () {
					return 1;
				})
			).toStrictEqual({});
		});

		it('mapValues passes the object and handles symbol keys', function () {
			const sym = Symbol('s');
			const input = { [sym]: 1 };
			const result = helpers.mapValues(input, function (value, _key, object) {
				expect(object).toBe(input);
				return value + 1;
			});
			expect(result[sym]).toBe(2);
		});

		it('mapKeys renames keys (last collision wins)', function () {
			expect(
				helpers.mapKeys({ a: 1, b: 2 }, function (_value, key) {
					return String(key).toUpperCase();
				})
			).toStrictEqual({ A: 1, B: 2 });
			expect(
				helpers.mapKeys({ a: 1, b: 2 }, function () {
					return 'same';
				})
			).toStrictEqual({ same: 2 });
		});
	});

	describe('invert', function () {
		it('swaps keys and values', function () {
			const result = helpers.invert({ a: 'x', b: 'y' } as const);
			assertType<Equals<typeof result, { x: 'a'; y: 'b' }>>(true);
			expect(result).toStrictEqual({ x: 'a', y: 'b' });
		});

		it('stringifies numeric values, supports symbols, last duplicate wins', function () {
			const sym = Symbol('s');
			expect(helpers.invert({ a: 1, b: 1, c: 2 })).toStrictEqual({ 1: 'b', 2: 'c' });
			expect(helpers.invert({ a: sym })[sym]).toBe('a');
			expect(helpers.invert({ 1: 'one' })).toStrictEqual({ one: '1' });
			expect(helpers.invert({})).toStrictEqual({});
		});

		it('handles a "__proto__" value safely', function () {
			const result = helpers.invert({ a: '__proto__' });
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
		});

		it('throws TypeError for non-key values', function () {
			expect(function () {
				helpers.invert({ a: {} } as any);
			}).toThrow(TypeError);
		});
	});

	describe('deepMerge', function () {
		it('recursively merges plain objects; later sources win', function () {
			const result = helpers.deepMerge({ a: { x: 1, y: 2 }, keep: 'k' }, { a: { y: 3 } }, { a: { z: 4 }, extra: true });
			assertType<Equals<typeof result, { a: { x: number; y: number; z: number }; keep: string; extra: boolean }>>(true);
			expect(result).toStrictEqual({ a: { x: 1, y: 3, z: 4 }, keep: 'k', extra: true });
		});

		it('replaces arrays and non-plain values by reference', function () {
			const list = [9];
			const date = new Date(1);
			const result = helpers.deepMerge({ list: [1, 2], when: new Date(0), a: { b: 1 } }, { list, when: date, a: 'scalar' });
			expect(result.list).toBe(list);
			expect(result.when).toBe(date);
			expect(result.a).toBe('scalar');
		});

		it('replaces a scalar with an object and lets undefined override', function () {
			const result = helpers.deepMerge({ a: 1 as unknown, b: 2 }, { a: { c: 1 }, b: undefined });
			expect(result).toStrictEqual({ a: { c: 1 }, b: undefined });
		});

		it('does not mutate inputs and never shares merged plain objects with them', function () {
			const target = { a: { x: 1 } };
			const source = { a: { y: 2 }, b: { z: 3 } };
			const result = helpers.deepMerge(target, source);
			expect(target).toStrictEqual({ a: { x: 1 } });
			expect(source).toStrictEqual({ a: { y: 2 }, b: { z: 3 } });
			expect(result.a).not.toBe(target.a);
			expect(result.b).not.toBe(source.b);
			result.b.z = 99;
			expect(source.b.z).toBe(3);
		});

		it('drops __proto__, constructor and prototype keys at every level without polluting', function () {
			const malicious = JSON.parse(
				'{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"prototype":{"polluted":3},"safe":{"__proto__":{"polluted":4}}}'
			);
			const result: any = helpers.deepMerge({}, malicious, malicious);
			expect(({} as any).polluted).toBeUndefined();
			expect((Object as any).prototype.polluted).toBeUndefined();
			expect(Object.keys(result)).toStrictEqual(['safe']);
			expect(Object.keys(result.safe)).toStrictEqual([]);
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(Object.getPrototypeOf(result.safe)).toBe(Object.prototype);
			expect(result.constructor).toBe(Object);
			// An own `__proto__` key of the target is dropped too.
			expect(Object.keys(helpers.deepMerge(JSON.parse('{"__proto__":{"a":1},"b":2}')))).toStrictEqual(['b']);
		});

		it('merges symbol keys and null-prototype objects, skips nullish sources', function () {
			const sym = Symbol('s');
			const bare = Object.assign(Object.create(null), { a: { b: 1 } });
			const result: any = helpers.deepMerge(bare, { [sym]: 1 }, null as any, undefined as any, { a: { c: 2 } });
			expect(Object.getPrototypeOf(result)).toBe(null);
			expect(result[sym]).toBe(1);
			expect({ ...result.a }).toStrictEqual({ b: 1, c: 2 });
		});

		it('supports shared (non-circular) references', function () {
			const shared = { v: 1 };
			expect(helpers.deepMerge({}, { a: shared, b: shared })).toStrictEqual({ a: { v: 1 }, b: { v: 1 } });
		});

		it('throws TypeError on circular references and non-plain inputs', function () {
			const circular: any = { a: {} };
			circular.a.self = circular;
			expect(function () {
				helpers.deepMerge({}, circular);
			}).toThrow(TypeError);
			expect(function () {
				helpers.deepMerge([] as object, {});
			}).toThrow(TypeError);
			expect(function () {
				helpers.deepMerge({}, new Date());
			}).toThrow(TypeError);
		});

		it('types optional overrides as unions', function () {
			const result = helpers.deepMerge({ a: { x: 1 } }, {} as { a?: { y: string } });
			assertType<Equals<typeof result, { a: { x: number } | { x: number; y: string } }>>(true);
			const spread = helpers.deepMerge({ a: 1 }, ...([] as Array<{ a: number }>));
			assertType<Equals<typeof spread, { a: number }>>(true);
			expect(result).toStrictEqual({ a: { x: 1 } });
		});
	});

	describe('isEqual', function () {
		it('compares arrays of a subclass by length and elements', function () {
			class List<T> extends Array<T> {}
			expect(helpers.isEqual(List.from([1, 2]), List.from([1, 2]))).toBe(true);
			expect(helpers.isEqual(List.from([1]), List.from([1, 2]))).toBe(false);
			expect(helpers.isEqual(new List(2), new List(3))).toBe(false);
			expect(helpers.isEqual(List.from([1, 2]), [1, 2])).toBe(false);
		});

		it('compares primitives with SameValueZero', function () {
			expect(helpers.isEqual(1, 1)).toBe(true);
			expect(helpers.isEqual('a', 'a')).toBe(true);
			expect(helpers.isEqual(NaN, NaN)).toBe(true);
			expect(helpers.isEqual(0, -0)).toBe(true);
			expect(helpers.isEqual(1, '1')).toBe(false);
			expect(helpers.isEqual(null, undefined)).toBe(false);
			expect(helpers.isEqual(1n, 1n)).toBe(true);
		});

		it('compares functions by reference', function () {
			function a(): void {}
			function b(): void {}
			expect(helpers.isEqual(a, a)).toBe(true);
			expect(helpers.isEqual(a, b)).toBe(false);
			expect(helpers.isEqual({ fn: a }, { fn: a })).toBe(true);
		});

		it('compares arrays and objects deeply', function () {
			expect(helpers.isEqual({ a: [1, { b: [2] }] }, { a: [1, { b: [2] }] })).toBe(true);
			expect(helpers.isEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
			expect(helpers.isEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
			expect(helpers.isEqual({ a: 1, c: undefined }, { a: 1, b: undefined })).toBe(false);
			expect(helpers.isEqual([1, 2], [1, 2, 3])).toBe(false);
			expect(helpers.isEqual([1, 2], [2, 1])).toBe(false);
			expect(helpers.isEqual([1], { 0: 1 })).toBe(false);
			expect(helpers.isEqual({}, null)).toBe(false);
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.isEqual([, 1], [undefined, 1])).toBe(false);
		});

		it('compares symbol keys', function () {
			const sym = Symbol('s');
			expect(helpers.isEqual({ [sym]: 1 }, { [sym]: 1 })).toBe(true);
			expect(helpers.isEqual({ [sym]: 1 }, { [sym]: 2 })).toBe(false);
			expect(helpers.isEqual({ [sym]: 1 }, { [Symbol('s')]: 1 })).toBe(false);
		});

		it('requires identical prototypes', function () {
			class A {
				v = 1;
			}
			class B {
				v = 1;
			}
			expect(helpers.isEqual(new A(), new A())).toBe(true);
			expect(helpers.isEqual(new A(), new B())).toBe(false);
			expect(helpers.isEqual({ v: 1 }, new A())).toBe(false);
			expect(helpers.isEqual({}, Object.create(null))).toBe(false);
		});

		it('compares dates, regexps and boxed primitives by value', function () {
			expect(helpers.isEqual(new Date(1), new Date(1))).toBe(true);
			expect(helpers.isEqual(new Date(1), new Date(2))).toBe(false);
			expect(helpers.isEqual(new Date('x'), new Date('y'))).toBe(true);
			expect(helpers.isEqual(/a/g, /a/g)).toBe(true);
			expect(helpers.isEqual(/a/g, /a/i)).toBe(false);
			expect(helpers.isEqual(/a/, /b/)).toBe(false);
			expect(helpers.isEqual(new Number(1), new Number(1))).toBe(true);
			expect(helpers.isEqual(new Number(1), new Number(2))).toBe(false);
			expect(helpers.isEqual(new String('ab'), new String('ab'))).toBe(true);
			expect(helpers.isEqual(new Boolean(true), new Boolean(false))).toBe(false);
			expect(helpers.isEqual(Object(1n), Object(1n))).toBe(true);
			const sym = Symbol('s');
			expect(helpers.isEqual(Object(sym), Object(sym))).toBe(true);
			expect(helpers.isEqual(Object(sym), Object(Symbol('s')))).toBe(false);
			const fakeNumber = Object.create(Number.prototype, { [Symbol.toStringTag]: { value: 'Number' } });
			expect(helpers.isEqual(new Number(1), fakeNumber)).toBe(false);
			expect(helpers.isEqual(fakeNumber, Object.create(Number.prototype, { [Symbol.toStringTag]: { value: 'Number' } }))).toBe(true);
		});

		it('rejects same-prototype objects with different tags', function () {
			const fake = Object.create(Date.prototype);
			expect(helpers.isEqual(new Date(0), fake)).toBe(false);
		});

		it('compares Maps and Sets regardless of order with deep keys and members', function () {
			expect(
				helpers.isEqual(
					new Map([
						['a', 1],
						['b', 2]
					]),
					new Map([
						['b', 2],
						['a', 1]
					])
				)
			).toBe(true);
			expect(
				helpers.isEqual(
					new Map([
						['a', 1],
						['b', 2]
					]),
					new Map([
						['a', 1],
						['b', 2]
					])
				)
			).toBe(true);
			expect(helpers.isEqual(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false);
			expect(helpers.isEqual(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(false);
			expect(helpers.isEqual(new Map([['a', 1]]), new Map())).toBe(false);
			expect(helpers.isEqual(new Map([[{ k: 1 }, { v: 1 }]]), new Map([[{ k: 1 }, { v: 1 }]]))).toBe(true);
			expect(helpers.isEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
			expect(helpers.isEqual(new Set([{ a: 1 }, { a: 2 }]), new Set([{ a: 2 }, { a: 1 }]))).toBe(true);
			expect(helpers.isEqual(new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }, { a: 2 }]))).toBe(false);
			expect(helpers.isEqual(new Set([1]), new Set([1, 2]))).toBe(false);
			const x = { v: 1 };
			const y = { v: 2 };
			expect(helpers.isEqual(new Set([x, { k: x }, y]), new Set([y, x, { k: y }]))).toBe(false);
			expect(helpers.isEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false);
			expect(helpers.isEqual(new Set([1, { a: 1 }]), new Set([{ a: 1 }, 1]))).toBe(true);
			expect(helpers.isEqual(new Map([[{ k: 1 }, 1]]), new Map([[{ k: 2 }, 1]]))).toBe(false);
			expect(
				helpers.isEqual(
					new Map<unknown, number>([
						[{ k: 1 }, 1],
						['p', 2]
					]),
					new Map<unknown, number>([
						['p', 2],
						[{ k: 1 }, 1]
					])
				)
			).toBe(true);
		});

		it('compares typed arrays, DataViews and ArrayBuffers by content', function () {
			expect(helpers.isEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
			expect(helpers.isEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
			expect(helpers.isEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
			expect(helpers.isEqual(new Float32Array([NaN]), new Float32Array([NaN]))).toBe(true);
			expect(helpers.isEqual(new Uint8Array([1]), new Int8Array([1]))).toBe(false);
			expect(helpers.isEqual(new DataView(new Uint8Array([1, 2, 3]).buffer, 1), new DataView(new Uint8Array([2, 3]).buffer))).toBe(true);
			expect(helpers.isEqual(new Uint8Array([1]).buffer, new Uint8Array([1]).buffer)).toBe(true);
			expect(helpers.isEqual(new Uint8Array([1]).buffer, new Uint8Array([2]).buffer)).toBe(false);
		});

		it('compares errors by name, message and own enumerable props', function () {
			expect(helpers.isEqual(new Error('a'), new Error('a'))).toBe(true);
			expect(helpers.isEqual(new Error('a'), new Error('b'))).toBe(false);
			expect(helpers.isEqual(Object.assign(new Error('a'), { code: 1 }), Object.assign(new Error('a'), { code: 2 }))).toBe(false);
		});

		it('treats weak collections and promises as equal only to themselves', function () {
			const weak = new WeakMap();
			expect(helpers.isEqual(weak, weak)).toBe(true);
			expect(helpers.isEqual(new WeakMap(), new WeakMap())).toBe(false);
			expect(helpers.isEqual(Promise.resolve(1), Promise.resolve(1))).toBe(false);
		});

		it('handles circular structures', function () {
			const a: any = { name: 'x' };
			a.self = a;
			const b: any = { name: 'x' };
			b.self = b;
			const c: any = { name: 'y' };
			c.self = c;
			expect(helpers.isEqual(a, b)).toBe(true);
			expect(helpers.isEqual(a, c)).toBe(false);

			const listA: any[] = [1];
			listA.push(listA);
			const listB: any[] = [1];
			listB.push(listB);
			expect(helpers.isEqual(listA, listB)).toBe(true);
		});

		it('agrees with deepClone output', function () {
			const original = { a: [1, new Date(3), new Map([[1, new Set(['x'])]])], b: { c: /re/m } };
			expect(helpers.isEqual(original, helpers.deepClone(original))).toBe(true);
		});

		it('supports cross-realm arrays only when prototypes match', function () {
			const foreignArray = vm.runInNewContext('[1, 2]');
			expect(helpers.isEqual(foreignArray, [1, 2])).toBe(false);
			expect(helpers.isEqual(foreignArray, vm.runInNewContext('[1, 2]'))).toBe(false);
		});
	});

	describe('deepFreeze', function () {
		it('freezes nested objects and arrays and returns the same reference', function () {
			const input = { a: { b: [1, { c: 2 }] } };
			const result = helpers.deepFreeze(input);
			expect(result).toBe(input);
			expect(Object.isFrozen(input)).toBe(true);
			expect(Object.isFrozen(input.a)).toBe(true);
			expect(Object.isFrozen(input.a.b)).toBe(true);
			expect(Object.isFrozen(input.a.b[1])).toBe(true);
			expect(function () {
				(result as any).a.b.push(3);
			}).toThrow(TypeError);
		});

		it('handles circular references, symbol keys, maps and sets', function () {
			const sym = Symbol('s');
			const inner = { v: 1 };
			const input: any = { [sym]: { deep: {} }, map: new Map([[{ k: 1 }, inner]]), set: new Set([{ m: 1 }]) };
			input.self = input;
			helpers.deepFreeze(input);
			expect(Object.isFrozen(input[sym].deep)).toBe(true);
			expect(Object.isFrozen(inner)).toBe(true);
			expect(Object.isFrozen(Array.from(input.map.keys())[0])).toBe(true);
			expect(Object.isFrozen(Array.from(input.set)[0])).toBe(true);
			expect(Object.isFrozen(input.map)).toBe(true);
		});

		it('skips typed arrays, functions and getters', function () {
			function fn(): void {}
			let reads = 0;
			const input = {
				bytes: new Uint8Array([1]),
				fn,
				get lazy(): object {
					reads++;
					return {};
				}
			};
			helpers.deepFreeze(input);
			expect(Object.isFrozen(input)).toBe(true);
			expect(Object.isFrozen(input.bytes)).toBe(false);
			expect(Object.isFrozen(fn)).toBe(false);
			expect(reads).toBe(0);
		});

		it('returns primitives untouched', function () {
			expect(helpers.deepFreeze(1)).toBe(1);
			expect(helpers.deepFreeze(null)).toBe(null);
		});

		it('is typed as DeepReadonly', function () {
			const frozen = helpers.deepFreeze({ a: { b: [1] } });
			assertType<Equals<typeof frozen, { readonly a: { readonly b: ReadonlyArray<number> } }>>(true);
			expect(frozen.a.b[0]).toBe(1);
		});
	});

	describe('backward-compatible guard re-exports', function () {
		it('are the same functions as in the guards module', function () {
			const names = [
				'isObject',
				'isArray',
				'isFunction',
				'isString',
				'isNumber',
				'isBoolean',
				'isUndefined',
				'isNull',
				'isSymbol',
				'isPromise',
				'isRegExp',
				'isError',
				'isMap',
				'isSet',
				'isWeakMap',
				'isWeakSet'
			] as const;
			const objectsExports: Record<string, unknown> = { ...helpers };
			const guardsExports: Record<string, unknown> = { ...guards };
			for (const name of names) {
				expect(objectsExports[name]).toBe(guardsExports[name]);
			}
		});

		it('keep their original behaviour', function () {
			expect(helpers.isObject({ a: 1 })).toBe(true);
			expect(helpers.isObject(function () {})).toBe(false);
			expect(helpers.isArray([1])).toBe(true);
			expect(helpers.isString('a')).toBe(true);
			expect(helpers.isNumber(1)).toBe(true);
			expect(helpers.isBoolean(false)).toBe(true);
			expect(helpers.isUndefined(undefined)).toBe(true);
			expect(helpers.isNull(null)).toBe(true);
			expect(helpers.isSymbol(Symbol('x'))).toBe(true);
			expect(helpers.isFunction(function () {})).toBe(true);
			expect(helpers.isPromise(Promise.resolve())).toBe(true);
			expect(helpers.isRegExp(/a/)).toBe(true);
			expect(helpers.isError(new Error('e'))).toBe(true);
			expect(helpers.isMap(new Map())).toBe(true);
			expect(helpers.isSet(new Set())).toBe(true);
			expect(helpers.isWeakMap(new WeakMap())).toBe(true);
			expect(helpers.isWeakSet(new WeakSet())).toBe(true);
		});
	});

	describe('round 2 regressions', function () {
		it('omit drops numeric keys (they are strings at runtime)', function () {
			const result = helpers.omit({ 1: 'a', 2: 'b', x: true }, [1, 'x']);
			assertType<Equals<typeof result, { 2: string }>>(true);
			expect(result).toStrictEqual({ 2: 'b' });
			expect(Object.keys(result)).toStrictEqual(['2']);
		});

		it('mapValues returns an array for an array input, as its return type says', function () {
			const input = [1, 2, 3];
			const result = helpers.mapValues(input, function (value) {
				return String(value);
			});
			assertType<Equals<typeof result, string[]>>(true);
			expect(Array.isArray(result)).toBe(true);
			expect(result).toStrictEqual(['1', '2', '3']);
			// eslint-disable-next-line no-sparse-arrays
			const sparse = helpers.mapValues([1, , 3], function (value) {
				return value;
			});
			expect(sparse).toHaveLength(3);
			expect(1 in sparse).toBe(false);
		});

		it('mapValues maps an extra array key that Array.prototype holds as a read-only property', function () {
			// `Array.prototype[Symbol.unscopables]` is not writable: an assignment to the result array would throw.
			const input = Object.defineProperty([1], Symbol.unscopables, { value: 2, enumerable: true });
			const result = helpers.mapValues(input, function (value) {
				return (value as number) * 10;
			});
			expect(Array.from(result)).toStrictEqual([10]);
			expect(Object.getOwnPropertyDescriptor(result, Symbol.unscopables)).toStrictEqual({ value: 20, writable: true, enumerable: true, configurable: true });
		});

		it('setInObjectByKeys never writes through inherited properties (built-ins stay untouched)', function () {
			const target: Record<string, any> = {};
			helpers.setInObjectByKeys(target, 'toString.polluted', 1);
			expect((Object.prototype.toString as any).polluted).toBeUndefined();
			expect(target.toString).toStrictEqual({ polluted: 1 });
			expect(Object.prototype.hasOwnProperty.call(target, 'toString')).toBe(true);

			const list: any[] = [];
			helpers.setInObjectByKeys(list, 'map.polluted', 1);
			expect((Array.prototype.map as any).polluted).toBeUndefined();

			const shared = { defaults: { a: 1 } };
			const instance = Object.create(shared) as Record<string, any>;
			helpers.setInObjectByKeys(instance, 'defaults.a', 2);
			expect(shared.defaults.a).toBe(1);
			expect(instance.defaults).toStrictEqual({ a: 2 });
		});

		it('setInObjectByKeys only creates arrays for canonical array indices', function () {
			const target: Record<string, any> = {};
			helpers.setInObjectByKeys(target, 'a.01', 1);
			helpers.setInObjectByKeys(target, 'b.4294967295', 2);
			helpers.setInObjectByKeys(target, 'c.1000', 3);
			helpers.setInObjectByKeys(target, 'd.0', 4);
			expect(Array.isArray(target.a)).toBe(false);
			expect(target.a).toStrictEqual({ '01': 1 });
			expect(Array.isArray(target.b)).toBe(false);
			expect(Array.isArray(target.c)).toBe(true);
			// Only up to the array limit (security: see the `security` tests); unflattenObject's limit can go up to the largest index.
			expect(Array.isArray(helpers.unflattenObject({ 'c.4294967294': 3 }, { arrayLimit: Infinity }).c)).toBe(true);
			expect(Array.isArray(helpers.unflattenObject({ 'c.4294967295': 3 }, { arrayLimit: Infinity }).c)).toBe(false);
			expect(helpers.unflattenObject({ 'c.0': 1, 'c.4294967295': 3 }, { arrayLimit: Infinity })).toStrictEqual({ c: { 0: 1, 4294967295: 3 } });
			expect(target.d).toStrictEqual([4]);
			expect(JSON.parse(JSON.stringify(target.a))).toStrictEqual({ '01': 1 });
		});
	});

	describe('typedKeys / typedEntries / typedFromEntries', function () {
		it('return own enumerable string keys with precise types', function () {
			const sym = Symbol('s');
			const input = { a: 1, b: 'x', 3: true, [sym]: 0 };
			const keys = helpers.typedKeys(input);
			assertType<Equals<typeof keys, Array<'a' | 'b' | '3'>>>(true);
			expect(keys).toStrictEqual(['3', 'a', 'b']);
			const entries = helpers.typedEntries(input);
			assertType<Equals<typeof entries, Array<['a', number] | ['b', string] | ['3', boolean]>>>(true);
			expect(entries).toStrictEqual([
				['3', true],
				['a', 1],
				['b', 'x']
			]);
			expect(helpers.typedKeys(Object.create({ inherited: 1 }))).toStrictEqual([]);
		});

		it('typedEntries keeps undefined in optional value types', function () {
			const input: { a?: number } = { a: undefined };
			const entries = helpers.typedEntries(input);
			assertType<Equals<typeof entries, Array<['a', number | undefined]>>>(true);
			expect(entries).toStrictEqual([['a', undefined]]);
		});

		it('typedFromEntries builds a typed object, last duplicate wins, __proto__ is a plain key', function () {
			const entries: Array<['a', number] | ['b', string]> = [
				['a', 1],
				['b', 'x'],
				['a', 2]
			];
			const result = helpers.typedFromEntries(entries);
			assertType<Equals<typeof result, { a: number; b: string }>>(true);
			expect(result).toStrictEqual({ a: 2, b: 'x' });

			const unsafe = helpers.typedFromEntries([['__proto__', { polluted: true }] as [string, unknown]]);
			expect(Object.getPrototypeOf(unsafe)).toBe(Object.prototype);
			expect(Object.prototype.hasOwnProperty.call(unsafe, '__proto__')).toBe(true);
			expect(({} as any).polluted).toBeUndefined();

			const sym = Symbol('s');
			expect(
				helpers.typedFromEntries(
					new Map<symbol | number, number>([
						[sym, 1],
						[2, 3]
					])
				)
			).toStrictEqual({ [sym]: 1, 2: 3 });
		});

		it('round-trips through typedEntries', function () {
			const input = { a: 1, b: [2] };
			expect(helpers.typedFromEntries(helpers.typedEntries(input))).toStrictEqual(input);
		});
	});

	describe('pickBy / omitBy', function () {
		it('pickBy keeps properties matching the predicate', function () {
			const sym = Symbol('s');
			const input = { a: 1, b: null, c: 3, [sym]: 4 };
			const result = helpers.pickBy(input, function (value) {
				return typeof value === 'number' && value > 1;
			});
			assertType<Equals<typeof result, Partial<typeof input>>>(true);
			expect(result).toStrictEqual({ c: 3, [sym]: 4 });
		});

		it('omitBy drops properties matching the predicate and passes key and object', function () {
			const input = { a: 1, _b: 2 };
			const seen: unknown[] = [];
			const result = helpers.omitBy(input, function (_value, key, object) {
				seen.push(object);
				return String(key).startsWith('_');
			});
			expect(result).toStrictEqual({ a: 1 });
			expect(seen).toStrictEqual([input, input]);
			expect(input).toStrictEqual({ a: 1, _b: 2 });
		});

		it('store __proto__ keys as plain own properties', function () {
			const input = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, unknown>;
			const result = helpers.pickBy(input, function () {
				return true;
			});
			expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
			expect(({} as any).polluted).toBeUndefined();
		});
	});

	describe('compactObject', function () {
		it('removes only undefined values', function () {
			const sym = Symbol('s');
			const input: { a: number; b: string | undefined; c: null; d?: boolean; e: number; [sym]: undefined } = {
				a: 0,
				b: undefined,
				c: null,
				d: false,
				e: NaN,
				[sym]: undefined
			};
			const result = helpers.compactObject(input);
			assertType<Equals<typeof result, { a: number; c: null; e: number; b?: string; d?: boolean; [sym]?: never }>>(true);
			expect(result).toStrictEqual({ a: 0, c: null, d: false, e: NaN });
			expect(Object.keys(result)).toStrictEqual(['a', 'c', 'd', 'e']);
			expect(Object.getOwnPropertySymbols(result)).toStrictEqual([]);
			expect(input.b).toBeUndefined();
			expect('b' in input).toBe(true);
		});

		it('is shallow', function () {
			const nested = { x: undefined };
			const result = helpers.compactObject({ nested });
			expect(result.nested).toBe(nested);
		});
	});

	describe('flattenObject / unflattenObject', function () {
		it('flattens nested objects and arrays into leaf paths', function () {
			const when = new Date(0);
			expect(helpers.flattenObject({ a: { b: 1, c: [2, { d: 3 }] }, e: {}, f: [], when, n: null })).toStrictEqual({
				'a.b': 1,
				'a.c.0': 2,
				'a.c.1.d': 3,
				e: {},
				f: [],
				when,
				n: null
			});
			expect(helpers.flattenObject({})).toStrictEqual({});
			expect(helpers.flattenObject([1, [2]])).toStrictEqual({ 0: 1, '1.0': 2 });
		});

		it('supports custom separators and keeps leaves by reference', function () {
			const map = new Map();
			const result = helpers.flattenObject({ a: { b: map } }, { separator: '/' });
			expect(result).toStrictEqual({ 'a/b': map });
			expect(result['a/b']).toBe(map);
			expect(helpers.flattenObject({ a: { b: 1 } }, { separator: '::' })).toStrictEqual({ 'a::b': 1 });
		});

		it('recurses into null-prototype objects, skips symbols and holes, and stores __proto__ safely', function () {
			const bare = Object.create(null) as Record<string, unknown>;
			bare.x = 1;
			// eslint-disable-next-line no-sparse-arrays
			const result = helpers.flattenObject({ bare, [Symbol('s')]: 1, list: [1, , 3] });
			expect(result).toStrictEqual({ 'bare.x': 1, 'list.0': 1, 'list.2': 3 });
			const unsafe = helpers.flattenObject(JSON.parse('{"__proto__": {"polluted": true}}'));
			expect(Object.keys(unsafe)).toStrictEqual(['__proto__.polluted']);
			expect(({} as any).polluted).toBeUndefined();
		});

		it('rejects invalid input, separators and circular structures', function () {
			const circular: Record<string, unknown> = { a: 1 };
			circular.self = { back: circular };
			expect(function () {
				helpers.flattenObject(circular);
			}).toThrow(TypeError);
			expect(function () {
				helpers.flattenObject(new Date());
			}).toThrow(TypeError);
			expect(function () {
				helpers.flattenObject({}, { separator: '' });
			}).toThrow(RangeError);
			expect(function () {
				helpers.flattenObject({}, { separator: 1 as any });
			}).toThrow(TypeError);
		});

		it('flattens shared (non-circular) references', function () {
			const shared = { v: 1 };
			expect(helpers.flattenObject({ a: shared, b: shared })).toStrictEqual({ 'a.v': 1, 'b.v': 1 });
		});

		it('unflattens paths, creating arrays for numeric segments', function () {
			expect(helpers.unflattenObject({ 'a.b': 1, 'a.c.0': 2, 'a.c.1.d': 3, e: {} })).toStrictEqual({ a: { b: 1, c: [2, { d: 3 }] }, e: {} });
			expect(helpers.unflattenObject({ 'a/b': 1 }, { separator: '/' })).toStrictEqual({ a: { b: 1 } });
			expect(helpers.unflattenObject({})).toStrictEqual({});
			const nested = helpers.unflattenObject({ 'x.01': 1, 'y.1': 2 }) as Record<string, any>;
			expect(Array.isArray(nested.x)).toBe(false);
			expect(Array.isArray(nested.y)).toBe(true);
			expect(nested.y).toHaveLength(2);
		});

		it('round-trips', function () {
			const input = { a: { b: 1, c: [2, { d: [3, []] }] }, e: {}, f: 'x' };
			expect(helpers.unflattenObject(helpers.flattenObject(input))).toStrictEqual(input);
		});

		it('rejects unsafe segments, empty segments and bad separators', function () {
			for (const key of ['__proto__.polluted', 'a.constructor', 'prototype']) {
				expect(function () {
					helpers.unflattenObject({ [key]: 1 });
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.unflattenObject(JSON.parse('{"__proto__": {"polluted": true}}'));
			}).toThrow(RangeError);
			expect(({} as any).polluted).toBeUndefined();
			expect(function () {
				helpers.unflattenObject({ 'a..b': 1 });
			}).toThrow(new RangeError('unflattenObject: `record` keys must not contain empty segments, got "a..b"'));
			expect(function () {
				helpers.unflattenObject({ '': 1 });
			}).toThrow(RangeError);
			expect(function () {
				helpers.unflattenObject({}, { separator: '' });
			}).toThrow(RangeError);
		});

		it('rejects conflicting keys in any order and never mutates the input', function () {
			const leaf = {};
			const record = { a: leaf, 'a.b': 1 };
			expect(function () {
				helpers.unflattenObject(record);
			}).toThrow(/already set/);
			expect(leaf).toStrictEqual({});
			expect(function () {
				helpers.unflattenObject({ 'a.b': 1, a: 2 });
			}).toThrow(/already holds/);
			expect(function () {
				helpers.unflattenObject({ a: null, 'a.b': 1 });
			}).toThrow(TypeError);
		});
	});

	describe('hasInObjectByKeys / deleteFromObjectByKeys', function () {
		it('hasInObjectByKeys follows own and inherited properties, except Object.prototype members (behaviour change: own only)', function () {
			const target = { a: { b: [undefined], s: 'text', n: null }, fn: Object.assign(function () {}, { x: 1 }) };
			expect(helpers.hasInObjectByKeys(target, 'a')).toBe(true);
			expect(helpers.hasInObjectByKeys(target, 'a.b.0')).toBe(true);
			expect(helpers.hasInObjectByKeys(target, 'a.n')).toBe(true);
			expect(helpers.hasInObjectByKeys(target, 'fn.x')).toBe(true);
			expect(helpers.hasInObjectByKeys({ fn: Object.assign(function () {}, { inner: { z: 1 } }) }, 'fn.inner.z')).toBe(true);
			expect(helpers.hasInObjectByKeys(target, 'a.b.1')).toBe(false);
			expect(helpers.hasInObjectByKeys(target, 'a.toString')).toBe(false);
			expect(helpers.hasInObjectByKeys(target, 'a.s.length')).toBe(true);
			expect(helpers.hasInObjectByKeys(target, 'a.n.x')).toBe(false);
			expect(helpers.hasInObjectByKeys(target, 'missing.x.y')).toBe(false);
			expect(helpers.hasInObjectByKeys(Object.create({ a: { b: 1 } }), 'a.b')).toBe(true);
		});

		it('deleteFromObjectByKeys deletes own properties and reports success', function () {
			const target: Record<string, any> = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
			expect(helpers.deleteFromObjectByKeys(target, 'a.b')).toBe(true);
			expect(target).toStrictEqual({ a: { c: 2 }, list: [1, 2, 3] });
			expect(helpers.deleteFromObjectByKeys(target, 'a.b')).toBe(false);
			expect(helpers.deleteFromObjectByKeys(target, 'list.1')).toBe(true);
			expect(target.list).toHaveLength(3);
			expect(1 in target.list).toBe(false);
			expect(helpers.deleteFromObjectByKeys(target, 'a.toString')).toBe(false);
			expect(helpers.deleteFromObjectByKeys(target, 'nope.x')).toBe(false);
			expect(helpers.deleteFromObjectByKeys(target, 'a')).toBe(true);
			expect(target).toStrictEqual({ list: [1, , 3] }); // eslint-disable-line no-sparse-arrays
		});

		it('deleteFromObjectByKeys never deletes inherited properties and returns false for non-configurable ones', function () {
			const proto = { shared: 1 };
			const child = Object.create(proto) as Record<string, unknown>;
			expect(helpers.deleteFromObjectByKeys(child, 'shared')).toBe(false);
			expect(proto.shared).toBe(1);
			const locked = Object.defineProperty({}, 'fixed', { value: 1, configurable: false });
			expect(helpers.deleteFromObjectByKeys(locked, 'fixed')).toBe(false);
			expect(helpers.deleteFromObjectByKeys([1, 2], 'length')).toBe(false);
		});

		it('deleteFromObjectByKeys follows own properties of functions', function () {
			const target = { fn: Object.assign(function () {}, { inner: { z: 1 }, x: 2 }) };
			expect(helpers.deleteFromObjectByKeys(target, 'fn.inner.z')).toBe(true);
			expect(helpers.deleteFromObjectByKeys(target, 'fn.x')).toBe(true);
			expect(helpers.deleteFromObjectByKeys(target, 'fn.name.x')).toBe(false);
			expect(target.fn.inner).toStrictEqual({});
			expect('x' in target.fn).toBe(false);
		});
	});

	describe('diff', function () {
		it('lists added paths in the order of b and removed paths in the order of a', function () {
			const a = { a: [], z: 1 };
			const b = { c: 0, a: [0] };
			expect(helpers.diff(a, b)).toStrictEqual({ added: ['c', 'a.0'], removed: ['z'], changed: [] });
			expect(helpers.diff(b, a)).toStrictEqual({ added: ['z'], removed: ['c', 'a.0'], changed: [] });
		});

		it('reports added, removed and changed dot paths', function () {
			expect(helpers.diff({ a: 1, b: { c: 2, d: [1] } }, { b: { c: 3, d: [1, 2] }, e: 0 })).toStrictEqual({
				added: ['b.d.1', 'e'],
				removed: ['a'],
				changed: ['b.c']
			});
		});

		it('compares leaves with isEqual and reports kind changes as changed', function () {
			const result = helpers.diff(
				{ date: new Date(0), same: new Date(1), nan: NaN, kind: [1], set: new Set([1]), nil: null },
				{ date: new Date(5), same: new Date(1), nan: NaN, kind: { 0: 1 }, set: new Set([1]), nil: undefined }
			);
			expect(result).toStrictEqual({ added: [], removed: [], changed: ['date', 'kind', 'nil'] });
		});

		it('handles arrays at the root, holes and identical inputs', function () {
			expect(helpers.diff([1, 2, 3], [1, 5])).toStrictEqual({ added: [], removed: ['2'], changed: ['1'] });
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.diff([1, , 3], [1, 2, 3])).toStrictEqual({ added: ['1'], removed: [], changed: [] });
			const tree = { a: { b: [1, { c: 2 }] } };
			expect(helpers.diff(tree, tree)).toStrictEqual({ added: [], removed: [], changed: [] });
			expect(helpers.diff(tree, helpers.deepClone(tree))).toStrictEqual({ added: [], removed: [], changed: [] });
			expect(helpers.diff({ a: {} }, { a: { x: { y: 1 } } })).toStrictEqual({ added: ['a.x'], removed: [], changed: [] });
		});

		it('only considers own enumerable string keys', function () {
			const hidden = Object.defineProperty({ a: 1 }, 'h', { value: 1, enumerable: false });
			expect(helpers.diff(hidden, { a: 1, h: 1 })).toStrictEqual({ added: ['h'], removed: [], changed: [] });
			expect(helpers.diff({ a: 1, h: 1 }, hidden)).toStrictEqual({ added: [], removed: ['h'], changed: [] });
			expect(helpers.diff({ [Symbol('s')]: 1 }, {})).toStrictEqual({ added: [], removed: [], changed: [] });
		});

		it('works when one tree contains the other', function () {
			const inner = { p: {} };
			// `b` is the subtree `a.p`: it must not be mistaken for a cycle; it is compared like any other pair.
			expect(helpers.diff({ p: inner }, inner)).toStrictEqual({ added: [], removed: ['p.p'], changed: [] });
			expect(helpers.diff({ p: inner }, { p: { q: 1 } })).toStrictEqual({ added: ['p.q'], removed: ['p.p'], changed: [] });
		});

		it('rejects mismatched roots and circular structures', function () {
			expect(function () {
				helpers.diff({}, []);
			}).toThrow(TypeError);
			expect(function () {
				helpers.diff(new Date(), new Date());
			}).toThrow(TypeError);
			const a: Record<string, unknown> = {};
			a.self = a;
			const b: Record<string, unknown> = {};
			b.self = b;
			expect(function () {
				helpers.diff(a, b);
			}).toThrow(TypeError);
			expect(function () {
				helpers.diff({ x: 1 }, b);
			}).not.toThrow();
		});
	});

	describe('argument validation', function () {
		it('rejects non-function callbacks with a TypeError, even for empty objects', function () {
			expect(function () {
				helpers.mapValues({}, undefined as any);
			}).toThrow(new TypeError('mapValues: `fn` must be a function, got undefined'));
			expect(function () {
				helpers.mapKeys({}, null as any);
			}).toThrow(new TypeError('mapKeys: `fn` must be a function, got null'));
			expect(function () {
				helpers.pickBy({}, 'x' as any);
			}).toThrow(new TypeError('pickBy: `predicate` must be a function, got string'));
			expect(function () {
				helpers.omitBy({}, 1 as any);
			}).toThrow(new TypeError('omitBy: `predicate` must be a function, got number'));
		});

		it('names the offending argument', function () {
			expect(function () {
				helpers.deepMerge({}, { a: 1 }, [] as any);
			}).toThrow(new TypeError('deepMerge: `sources[1]` must be a plain object, got object'));
			expect(function () {
				helpers.deepMerge(null as any);
			}).toThrow(new TypeError('deepMerge: `target` must be a plain object, got null'));
			expect(function () {
				helpers.flattenObject('x' as any);
			}).toThrow(new TypeError('flattenObject: `object` must be a plain object or an array, got string'));
			expect(function () {
				helpers.invert({ a: true } as any);
			}).toThrow(new TypeError('invert: `object.a` must be a string, number or symbol, got boolean'));
		});
	});

	describe('built-in subclasses and property writes', function () {
		it('still recognises subclasses of built-ins and objects with custom tags', function () {
			class Registry extends Map<string, object> {
				override get [Symbol.toStringTag](): string {
					return 'Registry';
				}
			}
			const registry = new Registry([['a', { deep: 1 }]]);
			const copy = helpers.deepClone(registry);
			expect(copy).toBeInstanceOf(Registry);
			expect(copy.get('a')).toStrictEqual({ deep: 1 });
			expect(copy.get('a')).not.toBe(registry.get('a'));
			expect(helpers.clone(registry).get('a')).toBe(registry.get('a'));
			expect(helpers.isEqual(registry, new Registry([['a', { deep: 1 }]]))).toBe(true);
			expect(helpers.isEqual(registry, new Registry([['a', { deep: 2 }]]))).toBe(false);
			const frozen = helpers.deepFreeze(new Registry([['a', { deep: 1 }]]));
			expect(Object.isFrozen(frozen.get('a'))).toBe(true);
			const thenable = { then: function (): void {} };
			expect(helpers.deepClone({ thenable }).thenable).toBe(thenable);
			expect(helpers.clone(thenable)).toBe(thenable);
			expect(helpers.isEqual(thenable, { then: thenable.then })).toBe(false);
			// A thenable array is promise-like too: only equal to itself, and never copied.
			const thenableArray = Object.assign([1, 2], { then: thenable.then });
			expect(helpers.isEqual(thenableArray, Object.assign([1, 2], { then: thenable.then }))).toBe(false);
			expect(helpers.isEqual(thenableArray, thenableArray)).toBe(true);
			expect(helpers.clone(thenableArray)).toBe(thenableArray);
			expect(helpers.deepClone([thenableArray])[0]).toBe(thenableArray);
		});

		it('defines copied keys as own data properties, without running inherited setters', function () {
			let calls = 0;
			class Temperature {
				set celsius(value: number) {
					calls += value;
				}
			}
			const original = Object.defineProperty(new Temperature(), 'celsius', { value: 21, enumerable: true, writable: true, configurable: true });
			for (const copy of [helpers.clone(original), helpers.deepClone(original)]) {
				expect(Object.getOwnPropertyDescriptor(copy, 'celsius')).toStrictEqual({ value: 21, enumerable: true, writable: true, configurable: true });
			}
			expect(calls).toBe(0);
			const merged = helpers.merge({ toString: 1, a: 1 }, { a: 2, hasOwnProperty: 3 });
			expect(merged).toStrictEqual({ toString: 1, a: 2, hasOwnProperty: 3 });
			expect(Object.keys(helpers.deepMerge({ a: { valueOf: 1 } }, { a: { valueOf: 2 } }).a)).toStrictEqual(['valueOf']);
		});
	});

	describe('edge cases', function () {
		it('copies SharedArrayBuffers and compares buffers and views by content', function () {
			const shared = new SharedArrayBuffer(2);
			new Uint8Array(shared).set([1, 2]);
			for (const copy of [helpers.clone(shared), helpers.deepClone(shared)]) {
				expect(copy).toBeInstanceOf(SharedArrayBuffer);
				expect(copy).not.toBe(shared);
				expect(Array.from(new Uint8Array(copy))).toStrictEqual([1, 2]);
			}
			expect(helpers.isEqual(new Uint8Array([1]).buffer, new Uint8Array([2]).buffer)).toBe(false);
			expect(helpers.isEqual(new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer)).toBe(true);
			expect(helpers.isEqual(new DataView(new Uint8Array([1]).buffer), new DataView(new Uint8Array([2]).buffer))).toBe(false);
			expect(helpers.isEqual(new DataView(new Uint8Array([1, 2]).buffer, 1), new DataView(new Uint8Array([3, 2]).buffer, 1))).toBe(true);
		});

		it('compares typed arrays element-wise with SameValueZero', function () {
			expect(helpers.isEqual(new Float64Array([1.5]), new Float64Array([1.25]))).toBe(false);
			expect(helpers.isEqual(new Int16Array([300]), new Int16Array([44]))).toBe(false);
			expect(helpers.isEqual(new Float64Array([-0, NaN]), new Float64Array([0, NaN]))).toBe(true);
			expect(helpers.isEqual(new Float64Array([NaN]), new Float64Array([1]))).toBe(false);
			expect(helpers.isEqual(new Float64Array([1]), new Float64Array([NaN]))).toBe(false);
			expect(helpers.isEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
			expect(helpers.isEqual(new Date(NaN), new Date(0))).toBe(false);
		});

		it('compares boxed primitives, arrays and errors beyond their enumerable keys', function () {
			expect(helpers.isEqual(Object(1n), Object(2n))).toBe(false);
			expect(helpers.clone(Object(1n)).valueOf()).toBe(1n);
			// eslint-disable-next-line no-sparse-arrays
			expect(helpers.isEqual([1, ,], [1])).toBe(false);
			const renamed = Object.defineProperty(new TypeError('x'), 'name', { value: 'Other' });
			expect(helpers.isEqual(renamed, new TypeError('x'))).toBe(false);
			const fake = Object.create(Number.prototype, { [Symbol.toStringTag]: { value: 'Number' }, x: { value: 1, enumerable: true } });
			expect(Object.getPrototypeOf(helpers.clone(fake))).toBe(Number.prototype);
			expect(helpers.clone(fake).x).toBe(1);
		});

		it('matches Map entries and Set members one-to-one', function () {
			expect(
				helpers.isEqual(
					new Map([[1, 1]]),
					new Map([
						[1, 1],
						[2, 2]
					])
				)
			).toBe(false);
			expect(helpers.isEqual(new Set([1]), new Set([1, 2]))).toBe(false);
			const x = { v: 1 };
			const y = { v: 2 };
			expect(helpers.isEqual(new Set([x, { k: x }, y]), new Set([y, x, { k: y }]))).toBe(false);
			const twins = new Map([
				[{ x: 1 }, 1],
				[{ x: 1 }, 1]
			]);
			const distinct = new Map([
				[{ x: 1 }, 1],
				[{ x: 2 }, 1]
			]);
			expect(helpers.isEqual(twins, distinct)).toBe(false);
			expect(helpers.isEqual(new Set([{ x: 1 }, { x: 1 }]), new Set([{ x: 1 }, { x: 2 }]))).toBe(false);
		});

		it('only assumes equality for the exact pair of objects already being compared', function () {
			const a: Record<string, unknown> = {};
			a.self = a;
			const c: Record<string, unknown> = { x: 1 };
			c.self = c;
			const b = { self: c };
			expect(helpers.isEqual(a, b)).toBe(false);
			expect(helpers.isEqual(b, a)).toBe(false);
		});

		it('deep-clones circular errors', function () {
			const error = new Error('loop') as Error & { cause?: unknown };
			error.cause = error;
			const copy = helpers.deepClone(error);
			expect(copy).not.toBe(error);
			expect(copy.cause).toBe(copy);
		});

		it('omits symbol keys', function () {
			const hidden = Symbol('hidden');
			expect(helpers.omit({ [hidden]: 1, a: 2 }, [hidden])).toStrictEqual({ a: 2 });
		});

		it('isEmpty handles every kind of value', function () {
			for (const value of [null, undefined, 0, 1, true, 1n, Symbol('s'), {}, [], '', new Map(), new Set(), function () {}]) {
				expect(helpers.isEmpty(value)).toBe(true);
			}
			for (const value of [{ a: 1 }, [0], new Array(3), 'a', new Map([[1, 1]]), new Set([1]), Object.assign(function () {}, { a: 1 })]) {
				expect(helpers.isEmpty(value)).toBe(false);
			}
		});

		it('creates path containers as ordinary own properties and overwrites existing leaves', function () {
			const target = helpers.setInObjectByKeys({ a: { b: 1 } } as Record<string, any>, 'a.b', 2);
			expect(target).toStrictEqual({ a: { b: 2 } });
			const created = helpers.setInObjectByKeys({} as Record<string, any>, 'x.y', 1);
			expect(Object.getOwnPropertyDescriptor(created, 'x')).toStrictEqual({ value: { y: 1 }, writable: true, enumerable: true, configurable: true });
		});

		it('names the offending path prefix in path errors', function () {
			expect(function () {
				helpers.setInObjectByKeys({ a: { b: 1 } }, 'a.b.c.d', 2);
			}).toThrow(new TypeError('setInObjectByKeys: cannot set "a.b.c.d": "a.b" is a number, not an object'));
			expect(function () {
				helpers.unflattenObject({ 'a.b': 1, 'a.b.c.d': 2 });
			}).toThrow(new TypeError('unflattenObject: cannot set "a.b.c.d": "a.b" is already set by another key'));
			expect(function () {
				helpers.unflattenObject({ 'a/b/c': 1, 'a/b': 2 }, { separator: '/' });
			}).toThrow(new TypeError('unflattenObject: cannot set "a/b": "a/b" already holds values set by other keys'));
		});

		it('names the function in separator and circularity errors', function () {
			expect(function () {
				helpers.flattenObject({}, { separator: 1 as any });
			}).toThrow(new TypeError('flattenObject: `separator` must be a string, got number'));
			expect(function () {
				helpers.unflattenObject({}, { separator: '' });
			}).toThrow(new RangeError('unflattenObject: `separator` must not be empty'));
			const loop: Record<string, unknown> = {};
			loop.self = loop;
			expect(function () {
				helpers.flattenObject(loop);
			}).toThrow(new TypeError('flattenObject: cannot flatten a circular structure'));
			expect(function () {
				helpers.deepMerge({}, loop);
			}).toThrow(new TypeError('deepMerge: cannot merge objects with circular references'));
			expect(function () {
				helpers.diff(loop, { self: {} });
			}).toThrow(new TypeError('diff: cannot diff circular structures'));
			expect(function () {
				helpers.diff({ self: {} }, loop);
			}).toThrow(new TypeError('diff: cannot diff circular structures'));
			expect(function () {
				helpers.diff({}, []);
			}).toThrow(new TypeError('diff: `a` and `b` must both be plain objects or both be arrays'));
		});

		it('diff walks shared subtrees once per path and skips identical references', function () {
			const shared = { n: 1 };
			expect(helpers.diff({ x: shared, y: shared }, { x: { n: 2 }, y: { n: 3 } })).toStrictEqual({ added: [], removed: [], changed: ['x.n', 'y.n'] });
			const loop: Record<string, unknown> = {};
			loop.self = loop;
			expect(helpers.diff({ a: loop }, { a: loop })).toStrictEqual({ added: [], removed: [], changed: [] });
			expect(helpers.diff(loop, loop)).toStrictEqual({ added: [], removed: [], changed: [] });
		});

		it('hasInObjectByKeys sees the own properties of primitives, like getFromObjectByKeys (behaviour change)', function () {
			expect(helpers.hasInObjectByKeys({ name: 'abc' }, 'name.length')).toBe(true);
			expect(helpers.hasInObjectByKeys({ name: 'abc' }, 'name.0')).toBe(true);
			expect(helpers.hasInObjectByKeys({ name: 'abc' }, 'name.3')).toBe(false);
			expect(helpers.hasInObjectByKeys({ n: 1 }, 'n.toFixed')).toBe(true);
			expect(helpers.deleteFromObjectByKeys({ name: 'abc' }, 'name.0')).toBe(false);
			expect(helpers.hasInObjectByKeys({ a: null }, 'a.b.c')).toBe(false);
			expect(helpers.hasInObjectByKeys({ a: undefined }, 'a.b.c')).toBe(false);
		});
	});

	describe('security', function () {
		class Person {
			first = 'Ada';
			last = 'Lovelace';
			/**
			 * An inherited getter.
			 * @returns {string} The full name
			 */
			get fullName(): string {
				return `${this.first} ${this.last}`;
			}
		}

		it('getFromObjectByKeys never resolves __proto__/constructor/prototype nor Object.prototype members', function () {
			const permissions = { viewer: { read: true } } as any;
			expect(helpers.getFromObjectByKeys(permissions, 'viewer.constructor')).toBeUndefined();
			expect(helpers.getFromObjectByKeys(permissions, 'viewer.constructor', false)).toBe(false);
			expect(helpers.getFromObjectByKeys({} as any, 'constructor.constructor')).toBeUndefined();
			expect(helpers.getFromObjectByKeys({} as any, '__proto__')).toBeUndefined();
			expect(helpers.getFromObjectByKeys({} as any, 'toString', 'x')).toBe('x');
			expect(helpers.getFromObjectByKeys({ a: {} } as any, 'a.hasOwnProperty', 'x')).toBe('x');
			expect(helpers.getFromObjectByKeys({ fn: function () {} } as any, 'fn.prototype')).toBeUndefined();
			expect(helpers.getFromObjectByKeys({ list: [1] } as any, 'list.constructor')).toBeUndefined();
			// Even own data keys with those names never resolve.
			expect(helpers.getFromObjectByKeys(JSON.parse('{"__proto__":{"x":1},"constructor":2,"prototype":3}'), '__proto__.x')).toBeUndefined();
			expect(helpers.getFromObjectByKeys(JSON.parse('{"constructor":2}'), 'constructor', 0)).toBe(0);
			expect(helpers.getFromObjectByKeys(JSON.parse('{"prototype":3}'), 'prototype', 0)).toBe(0);
		});

		it('getFromObjectByKeys keeps own shadows of Object.prototype names, other inherited properties and primitive properties', function () {
			expect(helpers.getFromObjectByKeys({ toString: 'own' } as any, 'toString')).toBe('own');
			expect(helpers.getFromObjectByKeys({ user: new Person() } as any, 'user.fullName')).toBe('Ada Lovelace');
			expect(helpers.getFromObjectByKeys({ a: Object.create({ inherited: 1 }) } as any, 'a.inherited')).toBe(1);
			expect(helpers.getFromObjectByKeys({ name: 'abc' } as any, 'name.length')).toBe(3);
			expect(helpers.getFromObjectByKeys({ name: 'abc' } as any, 'name.1')).toBe('b');
			expect(helpers.getFromObjectByKeys({ list: [1, 2] } as any, 'list.length')).toBe(2);
			// A method a class (or a built-in prototype other than Object.prototype) defines is not an Object.prototype member.
			class Custom {
				/**
				 * Overrides `Object.prototype.toString`.
				 * @returns {string} A label
				 */
				toString(): string {
					return 'custom';
				}
			}
			expect((helpers.getFromObjectByKeys({ c: new Custom() } as any, 'c.toString') as () => string).call(new Custom())).toBe('custom');
			expect(helpers.getFromObjectByKeys({ list: [] } as any, 'list.toString')).toBe(Array.prototype.toString);
			expect(helpers.getFromObjectByKeys({ name: 'abc' } as any, 'name.toString')).toBe(String.prototype.toString);
			expect(helpers.getFromObjectByKeys({ n: 1 } as any, 'n.hasOwnProperty')).toBeUndefined();
			expect(helpers.getFromObjectByKeys({ bare: Object.create(null) } as any, 'bare.toString', 'x')).toBe('x');
		});

		it('getFromObjectByKeys does not see properties added to Object.prototype (pollution gadgets)', function () {
			(Object.prototype as any).isAdmin = true;
			try {
				expect(helpers.getFromObjectByKeys({ user: {} } as any, 'user.isAdmin', false)).toBe(false);
				expect(helpers.hasInObjectByKeys({ user: {} }, 'user.isAdmin')).toBe(false);
				expect(helpers.getProperty({} as any, 'isAdmin')).toBeUndefined();
				expect(helpers.pick({} as any, ['isAdmin'])).toStrictEqual({});
				expect(helpers.getFromObjectByKeys({ user: { isAdmin: false } } as any, 'user.isAdmin')).toBe(false);
				// A property an intermediate prototype defines (even with the same value) still resolves.
				expect(helpers.getFromObjectByKeys({ user: Object.create({ isAdmin: true }) } as any, 'user.isAdmin')).toBe(true);
			} finally {
				delete (Object.prototype as any).isAdmin;
			}
		});

		it('getProperty applies the same rule', function () {
			expect(helpers.getProperty({} as any, 'constructor')).toBeUndefined();
			expect(helpers.getProperty({} as any, '__proto__')).toBeUndefined();
			expect(helpers.getProperty({} as any, 'toString')).toBeUndefined();
			expect(helpers.getProperty(function () {} as any, 'prototype')).toBeUndefined();
			expect(helpers.getProperty(new Person(), 'fullName')).toBe('Ada Lovelace');
			expect(helpers.getProperty('abc', 'length')).toBe(3);
			expect(helpers.getProperty({ toString: 1 } as any, 'toString')).toBe(1);
			const sym = Symbol('s');
			expect(helpers.getProperty({ [sym]: 1 }, sym)).toBe(1);
		});

		it('hasInObjectByKeys agrees with getFromObjectByKeys', function () {
			const target: any = { viewer: { read: true, none: undefined }, user: new Person(), name: 'abc', fn: function () {}, a: Object.create({ inherited: 1 }) };
			const paths = [
				'viewer.constructor',
				'constructor.constructor',
				'__proto__',
				'toString',
				'viewer.read',
				'viewer.none',
				'viewer.missing',
				'user.fullName',
				'user.first',
				'name.length',
				'name.1',
				'name.9',
				'name.toString',
				'name.hasOwnProperty',
				'fn.prototype',
				'fn.name',
				'a.inherited',
				'viewer.none.x'
			];
			const missing = Symbol('missing');
			for (const path of paths) {
				// `true` exactly when the path resolves: to a defined value (not the default), or to a property holding `undefined`.
				const value = helpers.getFromObjectByKeys(target, path as any, missing);
				expect([path, helpers.hasInObjectByKeys(target, path)]).toStrictEqual([path, value !== missing || path === 'viewer.none']);
			}
			expect(
				paths.map(function (path) {
					return helpers.hasInObjectByKeys(target, path);
				})
			).toStrictEqual([false, false, false, false, true, true, false, true, true, true, true, false, true, false, false, true, true, false]);
		});

		it('pick skips __proto__, constructor, prototype and Object.prototype members', function () {
			const picked = helpers.pick(JSON.parse('{"__proto__":{"isAdmin":true},"a":1}'), ['__proto__', 'a'] as any[]);
			expect(Object.prototype.hasOwnProperty.call(picked, '__proto__')).toBe(false);
			expect(picked).toStrictEqual({ a: 1 });
			expect(Object.keys(helpers.pick({} as any, ['constructor', 'toString', '__proto__']))).toStrictEqual([]);
			expect(helpers.pick({ toString: 'own' } as any, ['toString'])).toStrictEqual({ toString: 'own' });
			expect(helpers.pick(function named() {} as any, ['prototype', 'name'])).toStrictEqual({ name: 'named' });
		});

		it('deleteFromObjectByKeys rejects __proto__/constructor/prototype and empty segments', function () {
			class Service {
				/**
				 * A method every instance shares.
				 * @returns {number} 1
				 */
				run(): number {
					return 1;
				}
			}
			expect(function () {
				helpers.deleteFromObjectByKeys({ C: Service }, 'C.prototype.run');
			}).toThrow(new RangeError('deleteFromObjectByKeys: `path` must not contain the unsafe segment "prototype", got "C.prototype.run"'));
			expect(typeof Service.prototype.run).toBe('function');
			for (const path of ['__proto__.toString', 'a.constructor', 'constructor']) {
				expect(function () {
					helpers.deleteFromObjectByKeys({ a: {} }, path);
				}).toThrow(RangeError);
			}
			expect(function () {
				helpers.deleteFromObjectByKeys({ a: {} }, 'a..b');
			}).toThrow(new RangeError('deleteFromObjectByKeys: `path` must not contain empty segments, got "a..b"'));
			expect(typeof Object.prototype.toString).toBe('function');
		});

		it('hasInObjectByKeys returns false for unsafe segments', function () {
			class C {}
			expect(helpers.hasInObjectByKeys({ C }, 'C.prototype.constructor')).toBe(false);
			expect(helpers.hasInObjectByKeys({ C }, 'C.prototype')).toBe(false);
			expect(helpers.hasInObjectByKeys({}, 'constructor')).toBe(false);
			expect(helpers.hasInObjectByKeys(JSON.parse('{"__proto__":1}'), '__proto__')).toBe(false);
		});

		it('unflattenObject does not build huge sparse arrays (arrayLimit, default 1000)', function () {
			const start = Date.now();
			const result: any = helpers.unflattenObject({ 'tags.4294967294': 'x' });
			expect(Array.isArray(result.tags)).toBe(false);
			expect(result.tags).toStrictEqual({ 4294967294: 'x' });
			expect(helpers.unflattenObject({ 'a.1000': 1 })).toStrictEqual({ a: Object.assign(new Array(1000), { 1000: 1 }) });
			expect(helpers.unflattenObject({ 'a.1001': 1 })).toStrictEqual({ a: { 1001: 1 } });
			// An array created by an earlier key becomes a plain object (with the same entries) when a later key goes above the limit.
			const converted: any = helpers.unflattenObject({ 'tags.0': 'a', 'tags.1.name': 'b', 'tags.5000': 'c', 'tags.2': 'd' });
			expect(converted).toStrictEqual({ tags: { 0: 'a', 1: { name: 'b' }, 2: 'd', 5000: 'c' } });
			expect(Object.getPrototypeOf(converted.tags)).toBe(Object.prototype);
			expect(helpers.unflattenObject({ 'a.0.x': 1, 'a.9999.y': 2, 'a.0.z': 3 })).toStrictEqual({ a: { 0: { x: 1, z: 3 }, 9999: { y: 2 } } });
			// Conflicts are still detected after the conversion.
			expect(function () {
				helpers.unflattenObject({ 'a.0': 1, 'a.2000': 2, 'a.2000.b': 3 });
			}).toThrow(TypeError);
			expect(Date.now() - start).toBeLessThan(1000);
		});

		it('unflattenObject arrayLimit option', function () {
			expect(helpers.unflattenObject({ 'a.0': 1, 'a.1': 2 }, { arrayLimit: 0 })).toStrictEqual({ a: { 0: 1, 1: 2 } });
			expect(helpers.unflattenObject({ 'a.0': 1 }, { arrayLimit: 0 })).toStrictEqual({ a: [1] });
			expect(helpers.unflattenObject({ 'a.20': 1 }, { arrayLimit: 20 })).toStrictEqual({ a: Object.assign(new Array(20), { 20: 1 }) });
			expect(helpers.unflattenObject({ 'a.21': 1 }, { arrayLimit: 20 })).toStrictEqual({ a: { 21: 1 } });
			expect(helpers.unflattenObject({ 'a.5000': 1 }, { arrayLimit: Infinity }).a).toHaveLength(5001);
			for (const bad of [-1, 1.5, NaN, -Infinity]) {
				expect(function () {
					helpers.unflattenObject({}, { arrayLimit: bad });
				}).toThrow(new RangeError(`unflattenObject: \`arrayLimit\` must be an integer >= 0 or Infinity, got ${bad}`));
			}
			expect(function () {
				helpers.unflattenObject({}, { arrayLimit: '5' as any });
			}).toThrow(new TypeError('unflattenObject: `arrayLimit` must be an integer >= 0 or Infinity, got string'));
		});

		it('setInObjectByKeys creates a plain object instead of a huge array, but writes into existing arrays', function () {
			const target: any = helpers.setInObjectByKeys({}, 'a.4294967294', 1);
			expect(target).toStrictEqual({ a: { 4294967294: 1 } });
			expect(helpers.setInObjectByKeys({}, 'a.1001.b', 1)).toStrictEqual({ a: { 1001: { b: 1 } } });
			expect(Array.isArray((helpers.setInObjectByKeys({}, 'a.1000', 1) as any).a)).toBe(true);
			const existing: any = { list: [] };
			helpers.setInObjectByKeys(existing, 'list.5000', 1);
			expect(existing.list).toHaveLength(5001);
		});

		it('setProperty refuses __proto__ (prototype replacement)', function () {
			const session: any = {};
			expect(function () {
				helpers.setProperty(session, '__proto__', { isAdmin: true });
			}).toThrow(new RangeError('setProperty: `property` must not be the unsafe key "__proto__"'));
			expect(session.isAdmin).toBeUndefined();
			expect(Object.getPrototypeOf(session)).toBe(Object.prototype);
			const other: any = {};
			helpers.setProperty(other, 'constructor', 1);
			expect(Object.getOwnPropertyDescriptor(other, 'constructor')?.value).toBe(1);
		});

		it('copies keep __proto__, constructor and prototype as own data keys, while deepMerge drops them', function () {
			const input = JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"polluted":1}},"prototype":3,"safe":{"__proto__":{"x":4}}}');
			for (const result of [helpers.merge({}, input), helpers.clone(input), helpers.deepClone(input)] as any[]) {
				expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
				expect(result.isAdmin).toBeUndefined();
				expect(Object.keys(result)).toStrictEqual(['__proto__', 'constructor', 'prototype', 'safe']);
				expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toStrictEqual(JSON.parse('{"isAdmin":true}'));
				expect(Object.getPrototypeOf(result.safe)).toBe(Object.prototype);
				expect(result.safe.x).toBeUndefined();
				expect(helpers.isEqual(result, input)).toBe(true);
			}
			expect(Object.keys(helpers.deepMerge({}, input))).toStrictEqual(['safe']);
			expect(Object.keys(helpers.flattenObject(input))).toStrictEqual(['__proto__.isAdmin', 'constructor.prototype.polluted', 'prototype', 'safe.__proto__.x']);
			expect(({} as any).isAdmin).toBeUndefined();
			expect(({} as any).polluted).toBeUndefined();
		});
	});
});
