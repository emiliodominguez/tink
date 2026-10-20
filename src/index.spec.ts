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
import { deepMerge, getPath } from './objects/index.js';
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
		expect(root.strings.isEmpty).not.toBe(root.objects.isEmpty);
		expect('isString' in root.objects).toBe(false); // guards live in one place
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
		expect(getPath({ viewer: { read: true } }, 'viewer.constructor' as never, false)).toBe(false);
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
		const city: string = getPath(user, 'address.city', 'Unknown');
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

	it('should match the parse examples (README and the forms recipe)', function () {
		const { guards, url, validate } = root;
		const environment = { PORT: '8080', MODE: 'prod', DATABASE_URL: 'https://db.example.com', HOME: '/root' };

		expect(
			validate.parse(
				{
					PORT: validate.withDefault(validate.chain(validate.asInteger, guards.isIntegerInRange(1, 65535)), 3000),
					DEBUG: validate.withDefault(validate.asBoolean, false),
					MODE: guards.isOneOf(['dev', 'prod']),
					DATABASE_URL: validate.isUrl
				},
				environment
			)
		).toEqual({ PORT: 8080, DEBUG: false, MODE: 'prod', DATABASE_URL: 'https://db.example.com' });

		const signup = {
			email: validate.isEmail,
			name: validate.blankAsUndefined(guards.isStringOfLength(1, 50)),
			age: validate.blankAsUndefined(validate.optional(validate.asInteger)),
			newsletter: validate.withDefault(validate.asBoolean, false)
		};
		const [error] = validate.safeParse(signup, { email: 'not-an-email', name: '  ', age: '' });

		expect(guards.issuesByPath(error?.issues ?? [])).toEqual({ email: ['Invalid value (got string)'], name: ['Missing required property'] });
		expect(validate.parse(signup, { email: 'ada@example.com', name: 'Ada', age: '', newsletter: 'on' })).toEqual({
			email: 'ada@example.com',
			name: 'Ada',
			newsletter: true
		});

		const formData = new FormData();

		formData.append('email', 'ada@example.com');
		formData.append('name', 'Ada');
		formData.append('age', '');
		expect(validate.parse(signup, url.parseFormData(formData))).toEqual({ email: 'ada@example.com', name: 'Ada', newsletter: false });

		const password = validate.check(
			{ password: guards.isStringOfLength(8, 128), confirm: guards.isString },
			function (form: { password: string; confirm: string }): boolean {
				return form.password === form.confirm;
			},
			'Passwords do not match',
			['confirm']
		);

		expect(guards.issuesByPath(validate.safeParse(password, { password: 'correct horse', confirm: 'correct' })[0]?.issues ?? [])).toEqual({
			confirm: ['Passwords do not match']
		});

		const search = {
			tag: validate.withDefault(validate.asArray(validate.isSlug), function () {
				return [];
			}),
			page: validate.withFallback(validate.asInteger, 1),
			sort: validate.withFallback(guards.isOneOf(['new', 'top']), 'new')
		};

		expect(validate.parse(search, url.parseQueryString('?tag=ts&tag=js&page=2'))).toEqual({ tag: ['ts', 'js'], page: 2, sort: 'new' });
		expect(validate.parse(search, url.parseQueryString('?page=last&sort=random'))).toEqual({ tag: [], page: 1, sort: 'new' });

		const event = validate.discriminatedUnion('type', { click: { x: validate.asInteger, y: validate.asInteger }, key: { code: guards.isString } });

		expect(validate.parse(event, { type: 'click', x: '10', y: '20', target: 'button' })).toEqual({ type: 'click', x: 10, y: 20 });

		const flags = {
			ALLOWED_ORIGINS: validate.asList(validate.isUrl),
			FEATURE_FLAGS: validate.withDefault(validate.asJson(validate.recordOf(guards.isBoolean)), function () {
				return {};
			})
		};

		expect(validate.parse(flags, { ALLOWED_ORIGINS: 'https://a.com, https://b.com', FEATURE_FLAGS: '{"beta":true}' })).toEqual({
			ALLOWED_ORIGINS: ['https://a.com', 'https://b.com'],
			FEATURE_FLAGS: { beta: true }
		});
		expect(validate.parse(flags, { ALLOWED_ORIGINS: '' })).toEqual({ ALLOWED_ORIGINS: [], FEATURE_FLAGS: {} });
		expect(validate.safeParse(flags, { ALLOWED_ORIGINS: '', FEATURE_FLAGS: '{"__proto__":{"beta":true}}' })[0]).toBeInstanceOf(guards.ValidationError);
	});

	it('should match the pattern matching recipe', function () {
		const { functions } = root;
		const { _ } = functions;
		type Shape = { kind: 'circle'; radius: number } | { kind: 'rect'; width: number; height: number };
		const area = functions
			.matcher<Shape>()
			.with({ kind: 'circle' }, function (circle) {
				return Math.round(Math.PI * circle.radius ** 2);
			})
			.with({ kind: 'rect' }, function (rect) {
				return rect.width * rect.height;
			})
			.exhaustive();
		expect(area({ kind: 'rect', width: 2, height: 3 })).toBe(6);
		expect(area({ kind: 'circle', radius: 1 })).toBe(3);

		const integer = functions.active(function (text: string) {
			const n = Number.parseInt(text, 10);
			return Number.isNaN(n) ? undefined : n;
		});
		function double(input: string): number {
			return functions
				.matchWith(input)
				.with(integer, function (n) {
					return n * 2;
				})
				.otherwise(function () {
					return 0;
				});
		}
		expect(double('21')).toBe(42);
		expect(double('abc')).toBe(0);

		function cell(row: number, column: number, alive: boolean): string {
			return functions
				.matchWith([row, column])
				.with([0, _], function () {
					return 'header';
				})
				.with([_, 0], function () {
					return 'label';
				})
				.with(
					_,
					function () {
						return alive;
					},
					function () {
						return 'live';
					}
				)
				.otherwise(function () {
					return 'empty';
				});
		}
		expect([cell(0, 3, false), cell(2, 0, true), cell(2, 2, true), cell(2, 2, false)]).toEqual(['header', 'label', 'live', 'empty']);
	});

	it('should match the "Files, money and schedules" recipe', function () {
		const { arrays, date, encoding, errors, math } = root;
		expect(
			encoding.toCsv(
				[
					{ name: 'Ada', total: 12 },
					{ name: '=HYPERLINK("http://x")', total: 3 }
				],
				{ formulaEscape: true }
			)
		).toBe('"name","total"\r\n"Ada","12"\r\n"\'=HYPERLINK(""http://x"")","3"');
		expect(encoding.parseCsv('name,total\r\nAda,12\r\nGrace\r\n', { header: true })).toEqual([{ name: 'Ada', total: '12' }, { name: 'Grace' }]);
		expect(math.allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);

		const day = { start: new Date(2024, 0, 15, 9), end: new Date(2024, 0, 15, 17) };
		const busy = [
			{ start: new Date(2024, 0, 15, 10), end: new Date(2024, 0, 15, 11, 30) },
			{ start: new Date(2024, 0, 15, 11), end: new Date(2024, 0, 15, 13) },
			{ start: new Date(2024, 0, 15, 16, 45), end: new Date(2024, 0, 15, 18) }
		];
		expect(date.findGaps(day, busy, { minDuration: 30 * 60_000 })).toEqual([
			{ start: new Date(2024, 0, 15, 9), end: new Date(2024, 0, 15, 10) },
			{ start: new Date(2024, 0, 15, 13), end: new Date(2024, 0, 15, 16, 45) }
		]);

		expect(
			arrays.toTree([
				{ id: 1, parentId: null, name: 'root' },
				{ id: 2, parentId: 1, name: 'child' }
			])
		).toEqual([{ id: 1, parentId: null, name: 'root', children: [{ id: 2, parentId: 1, name: 'child', children: [] }] }]);

		expect(errors.serializeError(new Error('failed', { cause: new TypeError('bad input') }), { stack: false })).toEqual({
			name: 'Error',
			message: 'failed',
			cause: { name: 'TypeError', message: 'bad input' }
		});
	});

	it('should match the "Streams, cron, versions and resilience" recipe', async function () {
		const { async, date, iterables, path, search, validate } = root;
		const deltas: string[] = [];
		for await (const { data } of iterables.parseSSE(['data: {"delta":"Hel"}\n\ndata: {"del', 'ta":"lo"}\n\n', 'data: [DONE]\n\n'])) {
			if (data === '[DONE]') break;
			deltas.push((JSON.parse(data) as { delta: string }).delta);
		}
		expect(deltas).toEqual(['Hel', 'lo']);
		const lines: string[] = [];
		for await (const line of iterables.readLines(['a\r', '\nb\rc\n'])) lines.push(line);
		expect(lines).toEqual(['a', 'b', 'c']);

		expect(date.nextCronDate('30 2 * * *', { from: new Date('2024-03-10T05:00:00Z'), timeZone: 'America/New_York' })).toEqual(new Date('2024-03-10T07:00:00.000Z'));
		expect([...date.eachCronDate('0 9 * * 1-5', { from: new Date('2024-03-08T15:00:00Z'), timeZone: 'Europe/London', limit: 2 })]).toEqual([
			new Date('2024-03-11T09:00:00.000Z'),
			new Date('2024-03-12T09:00:00.000Z')
		]);

		expect(validate.satisfiesSemver('1.4.0-beta.2', '^1.3.0')).toBe(false);
		expect(validate.maxSatisfyingSemver(['1.2.0', '1.9.3', '2.0.0'], '~1.9 || <1.3')).toBe('1.9.3');
		expect(validate.incrementSemver('1.4.0-beta.2', 'prerelease')).toBe('1.4.0-beta.3');

		const charge = async.createCircuitBreaker(
			async function (): Promise<never> {
				throw new Error('declined');
			},
			{ failureThreshold: 1, resetTimeout: 30_000 }
		);
		await expect(charge()).rejects.toThrow('declined');
		await expect(charge()).rejects.toBeInstanceOf(async.CircuitOpenError);
		expect([...async.backoff({ retries: 4 })]).toEqual([100, 200, 400, 800]);
		expect(path.relativePath('/srv/app/src', '/srv/app/dist/index.js')).toBe('../dist/index.js');

		const index = search.createSearchIndex({ fields: { title: 2, body: 1 } });
		index.addAll([
			{ id: 1, title: 'Dark mode', body: 'Switch themes' },
			{ id: 2, title: 'Settings', body: 'Enable dark mode in settings' }
		]);
		expect(
			index.search('dark mo', { prefix: 'last' }).map(function (result) {
				return result.id;
			})
		).toEqual([1, 2]);
	});
});
