import * as root from '.';
import { chunk, diffSequences } from './arrays/index.js';
import { createLRUCache } from './cache/index.js';
import { retry, withTimeout, mapWithConcurrency } from './async/index.js';
import { getReadableTextColor, parseColor } from './color/index.js';
import { addMonths, formatDate } from './date/index.js';
import { cssEase, interpolate } from './easing/index.js';
import { formatCompact, formatCurrency } from './format/index.js';
import { bound, memoize, readonly } from './decorators/index.js';
import { createEmitter } from './emitter/index.js';
import { debounce, memoize as memoizeFn } from './functions/index.js';
import { isDefined } from './guards/index.js';
import { count, filter, map, take, toArray } from './iterables/index.js';
import { deepMerge, getFromObjectByKeys } from './objects/index.js';
import { createRandom } from './random/index.js';
import { fuzzySearch, highlight } from './search/index.js';
import { createStore } from './store/index.js';
import { toKebabCase, toSlug } from './strings/index.js';
import { withQuery } from './url/index.js';
import { compareSemver, isEmail } from './validate/index.js';

describe('root entry', function () {
	it('should expose every module as a namespace', function () {
		expect(Object.keys(root).sort()).toEqual([
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
		expect(root.strings.isEmpty).not.toBe(root.objects.isEmpty);
		expect(root.objects.isString).toBe(root.guards.isString);
	});
});

describe('README examples', function () {
	afterEach(function () {
		jest.useRealTimers();
	});

	it('should match the quick tour', async function () {
		const isUser = root.guards.isShape({ id: root.guards.isInteger, email: root.guards.isString, roles: root.guards.isArrayOf(root.guards.isOneOf(['admin', 'editor'])) });

		expect(root.guards.explain(isUser, { id: '7', roles: ['admin', 'root'] })).toEqual([
			{ path: ['id'], message: 'Invalid value (got string)' },
			{ path: ['email'], message: 'Missing required property' },
			{ path: ['roles', 1], message: 'Expected one of 2 allowed values (got string)' }
		]);
		expect(root.validate.parseJson('{"id":7,"email":"a@b.co","roles":["admin"]}', isUser)).toEqual([undefined, { id: 7, email: 'a@b.co', roles: ['admin'] }]);
		const [protoError, protoValue] = root.validate.parseJson('{"__proto__": {"isAdmin": true}}');
		expect(protoError).toBeInstanceOf(SyntaxError);
		expect((protoError as Error).message).toContain('JSON contains a forbidden "__proto__" key');
		expect(protoValue).toBeUndefined();
		expect(root.guards.toStandardSchema(isUser)['~standard'].validate({ id: 1, email: 'x', roles: [] })).toEqual({ value: { id: 1, email: 'x', roles: [] } });

		expect(Object.keys(deepMerge({ theme: 'light' }, JSON.parse('{"__proto__": {"isAdmin": true}}')))).toEqual(['theme']);
		expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
		expect(getFromObjectByKeys({ viewer: { read: true } }, 'viewer.constructor' as never, false)).toBe(false);
		expect(root.url.sanitizeUrl(' JAVASCRIPT:alert(1)')).toBe('about:blank');
		expect(root.url.isAbsoluteUrl('/\\evil.com')).toBe(true);

		expect(formatDate(root.date.addDuration(new Date(2024, 0, 31), { months: 1, days: 1 }), 'YYYY-MM-DD')).toBe('2024-03-01');
		expect(root.date.intervalToDuration(new Date(2024, 0, 31), new Date(2024, 2, 1, 12))).toEqual({
			years: 0,
			months: 1,
			days: 1,
			hours: 12,
			minutes: 0,
			seconds: 0,
			milliseconds: 0
		});
		expect(root.date.parseDate('2023-02-29', 'YYYY-MM-DD')).toBeUndefined();

		expect(root.strings.reverse('a👍🏽b')).toBe('b👍🏽a');
		expect(root.strings.padStart('🇦🇷', 3, '·')).toBe('··🇦🇷');
		expect(root.objects.toCamelCaseKeys({ user_id: 1, created_at: '2024-01-01' })).toEqual({ userId: 1, createdAt: '2024-01-01' });

		const people = [
			{ name: 'b', age: 30 },
			{ name: 'a', age: NaN },
			{ name: 'c', age: 25 }
		];
		const ordered = root.arrays.orderBy(
			people,
			[
				function (person: { name: string; age: number }): number {
					return person.age;
				},
				function (person: { name: string; age: number }): string {
					return person.name;
				}
			],
			['desc', 'asc']
		);
		expect(
			ordered.map(function (person) {
				return person.name;
			})
		).toEqual(['b', 'c', 'a']);

		type Shape = { kind: 'circle'; r: number } | { kind: 'square'; size: number };
		const square: Shape = { kind: 'square', size: 3 };
		expect(
			root.functions.match(square as Shape, 'kind', {
				circle: function (circle) {
					return Math.PI * circle.r ** 2;
				},
				square: function (shape) {
					return shape.size ** 2;
				}
			})
		).toBe(9);

		let calls = 0;
		const getUser = root.async.memoizeAsync(async function (id: number) {
			calls++;
			return { id };
		});
		await Promise.all([getUser(1), getUser(1), getUser(1)]);
		expect(calls).toBe(1);
	});

	it('should match the usage section', function () {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(toKebabCase('XMLHttpRequest')).toBe('xml-http-request');
		expect(toSlug('Café Society!')).toBe('cafe-society');
		expect(root.math.round(1.005, 2)).toBe(1.01);
		expect(Math.round(1.005 * 100) / 100).toBe(1);
		expect(root.objects.isEqual(new Map([[1, { a: [1] }]]), new Map([[1, { a: [1] }]]))).toBe(true);
	});

	it('should match the "A taste" section', async function () {
		const user: { address: { city?: string } } = { address: {} };
		const city: string = getFromObjectByKeys(user, 'address.city', 'Unknown');
		const ids: number[] = [1, null, 2, undefined].filter(isDefined);
		const config = deepMerge({ theme: 'light', retries: 1 }, JSON.parse('{"__proto__": {"polluted": true}, "retries": 3}'));

		expect(city).toBe('Unknown');
		expect(ids).toEqual([1, 2]);
		expect(config).toEqual({ theme: 'light', retries: 3 });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();

		let attempts = 0;
		const data = await retry(
			function () {
				attempts += 1;
				return withTimeout(attempts < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok'), 5_000);
			},
			{ retries: 3, delay: 0, jitter: true }
		);
		expect(data).toBe('ok');

		const pages = await mapWithConcurrency(
			['a', 'b', 'c'],
			async function (url) {
				return url.toUpperCase();
			},
			2
		);
		expect(pages).toEqual(['A', 'B', 'C']);

		const persist = jest.fn();
		const save = debounce(persist, 300, { maxWait: 2_000 });
		save('draft');
		save.flush();
		expect(persist).toHaveBeenCalledWith('draft');

		expect(formatDate(addMonths(new Date(2024, 0, 31), 1), 'YYYY-MM-DD')).toBe('2024-02-29');
		expect(getReadableTextColor('#1e3a8a')).toBe('#ffffff');
		expect(formatCurrency(1234.5, 'EUR')).toBe('€1,234.50');
		expect(formatCompact(1_250_000)).toBe('1.3M');
		expect(isEmail('ada@example.com')).toBe(true);
		expect(['1.0.0', '1.0.0-rc.1', '0.9.9'].sort(compareSemver)).toEqual(['0.9.9', '1.0.0-rc.1', '1.0.0']);
		expect(withQuery('/search?page=2#results', { q: 'café', page: 3 })).toBe('/search?q=caf%C3%A9&page=3#results');
	});

	it('should match the "Building blocks" section', function () {
		const fetchUser = jest.fn(function (id: number) {
			return { id, name: `user-${id}` };
		});
		const getUser = memoizeFn(fetchUser, { cache: createLRUCache({ max: 500, ttl: 60_000 }) });
		getUser(1);
		getUser(1);
		expect(fetchUser).toHaveBeenCalledTimes(1);

		const counter = createStore({ count: 0 });
		const seen: number[] = [];
		counter.subscribe(function () {
			seen.push(counter.getState().count);
		});
		counter.setState(function (state) {
			return { count: state.count + 1 };
		});
		expect(seen).toEqual([1]);

		const events = createEmitter<{ login: { userId: string }; logout: void }>();
		const log: string[] = [];
		events.on('login', function (payload) {
			log.push(payload.userId);
		});
		events.emit('login', { userId: 'ada' });
		events.emit('logout');
		expect(log).toEqual(['ada']);

		const squares = map(count(1), function (n) {
			return n * n;
		});
		const evens = filter(squares, function (n) {
			return n % 2 === 0;
		});
		expect(toArray(take(evens, 3))).toEqual([4, 16, 36]);

		const rng = createRandom('docs');
		expect([rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)]).toEqual([3, 3, 5]);
	});

	it('should match the "UI helpers" section', function () {
		const [best] = fuzzySearch(['Open File', 'Save File', 'Toggle Sidebar'], 'of');
		expect(highlight(best.key, best.ranges)).toEqual([
			{ text: 'O', match: true },
			{ text: 'pen ', match: false },
			{ text: 'F', match: true },
			{ text: 'ile', match: false }
		]);
		expect(interpolate(0, 200, 0.5, cssEase)).toBeCloseTo(160.48, 2);
		expect(parseColor('hsl(210 50% 40% / 0.5)')).toEqual({ r: 51, g: 102, b: 153, a: 0.5 });
		expect(
			diffSequences('kitten', 'sitting').filter(function (op) {
				return op.type !== 'equal';
			})
		).toHaveLength(5);
	});

	it('should match the decorators section', function () {
		class SearchBox {
			@readonly id = 'box-1';

			calls = 0;

			@bound
			getId(): string {
				return this.id;
			}

			@memoize
			score(term: string): number {
				this.calls += 1;
				return term.length;
			}
		}

		const box = new SearchBox();
		const { getId } = box;

		expect(function () {
			box.id = 'other';
		}).toThrow(TypeError);
		expect(getId()).toBe('box-1');
		expect(box.score('abc') + box.score('abc')).toBe(6);
		expect(box.calls).toBe(1);
		expect(new SearchBox().score('abc')).toBe(3);
	});
});
