import {
	compareSemver,
	compileSemverRange,
	incrementSemver,
	maxSatisfyingSemver,
	satisfiesSemver,
	isBase64,
	isCreditCardNumber,
	isEmail,
	isHexColor,
	isIPv4,
	isIPv6,
	isIsoDateTimeString,
	isNumericString,
	isSemver,
	isSlug,
	isUrl,
	isUuid,
	parseJson,
	arrayOf,
	asBoolean,
	asDate,
	asInteger,
	asNumber,
	chain,
	discriminatedUnion,
	lazy,
	nullable,
	safeParse,
	withDefault
} from 'tinkit/validate';
import { isArrayOf, isInteger, isIntegerInRange, isOneOf, isShape, isString } from 'tinkit/guards';
import { z } from 'zod';
// node-semver (a development dependency): the reference implementation of the semver range helpers.
import semver from 'semver';

// No validation library is installed: the competitors are the snippets people usually paste (a typical regex, `URL.canParse`, ...).
// Most of them are looser than our validators (they accept inputs we reject on purpose), so a ratio below 1 can be the price of correctness.
const emails = ['jane.doe+news@example.co.uk', 'user@localhost', 'not an email', 'a@b@c.com', 'very.long.local.part.with.dots@sub.domain.example.org'];
const urls = ['https://example.com/path?q=1#top', 'http://localhost:3000', 'ftp://files.example.com', 'example.com', 'https://sub.example.co.uk/a/b/c'];
const uuids = [
	'f47ac10b-58cc-4372-a567-0e02b2c3d479',
	'F47AC10B-58CC-4372-A567-0E02B2C3D479',
	'00000000-0000-0000-0000-000000000000',
	'f47ac10b58cc4372a5670e02b2c3d479',
	'not-a-uuid'
];
const ipv6 = ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329', '::1', '::ffff:192.0.2.128', '1::2::3', 'fe80::1%eth0'];
const ipv4 = ['192.168.0.1', '255.255.255.255', '256.0.0.1', '10.0.0.1'];
const versions = ['1.0.0', '1.0.0-beta', '0.9.0', '1.0.0-alpha.10', '1.0.0-alpha.2', '2.1.3+build', '1.10.0', '1.2.3'];
const dateTimes = ['2024-02-29T13:45:00Z', '2024-02-29T13:45:00.123+05:30', '2023-02-29T13:45:00Z', '2024-01-01T12:00:00'];
const cards = ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111112'];
const colors = ['#ff8000', '#FFF', '#ff800080', 'ff8000', '#ff800', 'red'];
const slugs = ['hello-world-2', 'Hello-World', 'hello--world', '-hello', 'a-very-long-slug-made-of-many-words-for-the-benchmark'];
const numerics = ['-12.5e3', '.5', '42', ' 1', '0x1f', 'Infinity', '1e400', '', '3.14159'];
const base64 = ['aGVsbG8=', 'aGVsbG8', 'aGVsbG8===', 'SGVsbG8sIFdvcmxkIQ==', 'not base64!'];
const longBase64 = 'SGVsbG8sIFdvcmxkIQ=='.repeat(50).replace(/=/g, 'A') + 'AA==';

const TYPICAL_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WHATWG_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const TYPICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPICAL_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const TYPICAL_IPV6 =
	/^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?:(?::[0-9a-f]{1,4}){1,7}|:)|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?\d)?\d)\.){3}(?:25[0-5]|(?:2[0-4]|1?\d)?\d)|(?:[0-9a-f]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1?\d)?\d)\.){3}(?:25[0-5]|(?:2[0-4]|1?\d)?\d))$/i;
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Semver ranges: the common shapes (caret, comparators, hyphen, tilde, unions, white space after an operator, pre-releases), each
// tested against releases, a pre-release and a `v`-prefixed version. node-semver caches the parsing of up to 1000 ranges, so the
// "distinct ranges" case (5000 ranges, cycled) shows its cost without the cache.
const semverRanges = ['^1.2.0', '>=1.2.3 <2.0.0', '1.2.3 - 2.3.4', '~1.2', '^0.0.3', '1.x || >=2.5.0 || 5.0.0 - 7.2.3', '>= 1.2.3 < 2', '^1.2.3-beta.1'];
const semverVersions = ['1.3.0', '2.0.0', '1.2.3-beta.2', '0.0.3', '6.1.0', 'v1.4.0'];
const compiledRange = compileSemverRange('^1.2.0 || ~2.4');
const semverRange = new semver.Range('^1.2.0 || ~2.4');
const distinctRanges = Array.from({ length: 5000 }, function (_, index) {
	return `^${index % 7}.${index % 13}.${index} || >=${index}.0.0 <${index + 1}.0.0`;
});
let distinctIndex = 0;
const candidateVersions = Array.from({ length: 100 }, function (_, index) {
	return `${index % 4}.${index % 10}.${index}`;
});

/**
 * Tests every range against every version.
 * @param {(version: string, range: string) => boolean} satisfies - The implementation
 * @returns {number} How many pairs matched
 */
function countSatisfying(satisfies) {
	let count = 0;
	for (let r = 0; r < semverRanges.length; r++) {
		for (let v = 0; v < semverVersions.length; v++) if (satisfies(semverVersions[v], semverRanges[r])) count++;
	}
	return count;
}

/**
 * Applies a predicate to every input.
 * @param {(value: string) => boolean} predicate - The validator
 * @param {string[]} inputs - The inputs
 * @returns {number} How many inputs passed
 */
function countValid(predicate, inputs) {
	let count = 0;
	for (let i = 0; i < inputs.length; i++) if (predicate(inputs[i])) count++;
	return count;
}

/**
 * Wraps a regex as a string predicate.
 * @param {RegExp} pattern - The regex
 * @returns {(value: string) => boolean} The predicate
 */
function matches(pattern) {
	return function (value) {
		return typeof value === 'string' && pattern.test(value);
	};
}

/**
 * Builds a case for a predicate over a list of inputs, with competitors over the same list.
 * @param {string} name - The case name
 * @param {(value: string) => boolean} ours - Our validator
 * @param {string[]} inputs - The inputs
 * @param {Record<string, (value: string) => boolean>} others - The competitors
 * @returns {object} The case
 */
function predicateCase(name, ours, inputs, others) {
	const competitors = {};
	for (const [label, predicate] of Object.entries(others)) {
		competitors[label] = function () {
			return countValid(predicate, inputs);
		};
	}
	return {
		name: `${name} (${inputs.length} inputs)`,
		fn: function () {
			return countValid(ours, inputs);
		},
		competitors
	};
}

// parseJson inputs: a small API payload, a ~100 KB document, and texts that trigger the prototype-key scan.
const record = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', tags: ['math', 'poetry'], active: true, score: 9.5 };
const smallText = JSON.stringify(record);
const largeText = JSON.stringify(
	Array.from({ length: 800 }, function (_, index) {
		return { ...record, id: index };
	})
);
const constructorText = JSON.stringify(
	Array.from({ length: 800 }, function (_, index) {
		return { ...record, id: index, constructor: 'Ford' };
	})
);
const isRecord = isShape({ id: isInteger, name: isString, email: isString, tags: isArrayOf(isString) });
const zodRecord = z.object({ id: z.number().int(), name: z.string(), email: z.string(), tags: z.array(z.string()) });
const isRecords = isArrayOf(isRecord);
const zodRecords = z.array(zodRecord);

// parse inputs: environment variables (strings to coerce, defaults to fill, ~30 unrelated keys to strip) and API records to strip.
const environment = { PORT: '8080', MODE: 'prod', DATABASE_URL: 'https://db.example.com/app', WORKERS: '8' };
for (let index = 0; index < 30; index++) environment[`UNRELATED_${index}`] = `value ${index}`;
const envSchema = {
	PORT: withDefault(asInteger, 3000),
	DEBUG: withDefault(asBoolean, false),
	MODE: isOneOf(['dev', 'prod']),
	DATABASE_URL: isUrl,
	WORKERS: chain(asInteger, isIntegerInRange(1, 64))
};
const zodEnv = z.object({
	PORT: z.coerce.number().int().default(3000),
	DEBUG: z.stringbool().default(false),
	MODE: z.enum(['dev', 'prod']),
	DATABASE_URL: z.url(),
	WORKERS: z.coerce.number().int().min(1).max(64)
});
const accounts = Array.from({ length: 100 }, function (_, index) {
	return {
		id: String(index),
		name: `user${index}`,
		joined: '2024-01-05T10:00:00Z',
		tags: ['a', 'b'],
		profile: { age: String(20 + (index % 50)), city: 'x' },
		secret: 'drop me'
	};
});
const accountsSchema = arrayOf({ id: asInteger, name: isString, joined: asDate, tags: arrayOf(isString), profile: { age: asInteger, city: isString } });
const zodAccounts = z.array(
	z.object({
		id: z.coerce.number().int(),
		name: z.string(),
		joined: z.coerce.date(),
		tags: z.array(z.string()),
		profile: z.object({ age: z.coerce.number().int(), city: z.string() })
	})
);
const badAccounts = accounts.map(function (account, index) {
	return index % 10 === 0 ? { ...account, id: 'x', profile: { city: 1 } } : account;
});
// A stream of tagged events: four variants, coerced fields, unknown keys to strip.
const events = Array.from({ length: 100 }, function (_, index) {
	return [
		{ type: 'click', x: String(index), y: '20', extra: 1 },
		{ type: 'key', code: 'Enter', repeat: 'false' },
		{ type: 'scroll', delta: String(index / 2) },
		{ type: 'resize', width: '800', height: '600' }
	][index % 4];
});
const eventsSchema = arrayOf(
	discriminatedUnion('type', {
		click: { x: asInteger, y: asInteger },
		key: { code: isString, repeat: asBoolean },
		scroll: { delta: asNumber },
		resize: { width: asInteger, height: asInteger }
	})
);
const zodEvents = z.array(
	z.discriminatedUnion('type', [
		z.object({ type: z.literal('click'), x: z.coerce.number().int(), y: z.coerce.number().int() }),
		z.object({ type: z.literal('key'), code: z.string(), repeat: z.stringbool() }),
		z.object({ type: z.literal('scroll'), delta: z.coerce.number() }),
		z.object({ type: z.literal('resize'), width: z.coerce.number().int(), height: z.coerce.number().int() })
	])
);

// A recursive schema and an invalid value whose 16 objects are each held twice by the next one (as YAML aliases can build): 65,536
// paths lead to the invalid leaf, and each shared object is reported once rather than once per path.
const pairSchema = lazy(function () {
	return { left: nullable(pairSchema), right: nullable(pairSchema) };
});
let sharedPairs = 'invalid';
for (let level = 0; level < 16; level++) sharedPairs = { left: sharedPairs, right: sharedPairs };

/**
 * The usual "safe" JSON.parse snippet: try/catch plus a reviver dropping `__proto__` keys.
 * @param {string} text - The JSON text
 * @returns {unknown} The parsed value, or undefined
 */
function reviverParse(text) {
	try {
		return JSON.parse(text, function (key, value) {
			return key === '__proto__' ? undefined : value;
		});
	} catch {
		return undefined;
	}
}

/**
 * Plain JSON.parse in try/catch (no prototype-key protection).
 * @param {string} text - The JSON text
 * @returns {unknown} The parsed value, or undefined
 */
function tryParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export default [
	{
		name: 'parseJson (small payload)',
		fn: function () {
			return parseJson(smallText);
		},
		baseline: function () {
			return tryParse(smallText);
		},
		competitors: {
			'JSON.parse + reviver': function () {
				return reviverParse(smallText);
			}
		}
	},
	{
		name: 'parseJson (100 KB array)',
		fn: function () {
			return parseJson(largeText);
		},
		baseline: function () {
			return tryParse(largeText);
		},
		competitors: {
			'JSON.parse + reviver': function () {
				return reviverParse(largeText);
			}
		}
	},
	{
		name: 'parseJson (100 KB with "constructor" keys: full scan)',
		fn: function () {
			return parseJson(constructorText);
		},
		baseline: function () {
			return tryParse(constructorText);
		},
		competitors: {
			'JSON.parse + reviver': function () {
				return reviverParse(constructorText);
			}
		}
	},
	{
		name: 'parseJson + guard (small payload)',
		fn: function () {
			return parseJson(smallText, isRecord);
		},
		competitors: {
			zod: function () {
				return zodRecord.safeParse(tryParse(smallText));
			}
		}
	},
	{
		name: 'parseJson + guard (100 KB array)',
		fn: function () {
			return parseJson(largeText, isRecords);
		},
		competitors: {
			zod: function () {
				return zodRecords.safeParse(tryParse(largeText));
			}
		}
	},
	{
		name: 'safeParse: environment variables (coerce, defaults, strip)',
		fn: function () {
			return safeParse(envSchema, environment);
		},
		competitors: {
			zod: function () {
				return zodEnv.safeParse(environment);
			}
		}
	},
	{
		name: 'safeParse: 100 nested records (coerce, strip)',
		fn: function () {
			return safeParse(accountsSchema, accounts);
		},
		competitors: {
			zod: function () {
				return zodAccounts.safeParse(accounts);
			}
		}
	},
	{
		name: 'safeParse: 100 nested records, 10 invalid (issue reporting)',
		fn: function () {
			return safeParse(accountsSchema, badAccounts);
		},
		competitors: {
			zod: function () {
				return zodAccounts.safeParse(badAccounts);
			}
		}
	},
	{
		name: 'safeParse: 100 tagged events (discriminated union, coerce, strip)',
		fn: function () {
			return safeParse(eventsSchema, events);
		},
		competitors: {
			zod: function () {
				return zodEvents.safeParse(events);
			}
		}
	},
	{
		name: 'safeParse: lazy schema, invalid value sharing objects (16 levels, issue reporting)',
		fn: function () {
			return safeParse(pairSchema, sharedPairs);
		}
	},
	predicateCase('isEmail', isEmail, emails, { 'typical regex': matches(TYPICAL_EMAIL), 'WHATWG regex': matches(WHATWG_EMAIL) }),
	predicateCase('isUrl', isUrl, urls, {
		'URL.canParse': function (value) {
			return URL.canParse(value);
		},
		'try new URL': function (value) {
			try {
				return ['http:', 'https:'].includes(new URL(value).protocol);
			} catch {
				return false;
			}
		}
	}),
	predicateCase('isUuid', isUuid, uuids, { 'typical regex': matches(TYPICAL_UUID) }),
	predicateCase(
		'isUuid v4',
		function (value) {
			return isUuid(value, 4);
		},
		uuids,
		{ 'typical regex': matches(TYPICAL_UUID_V4) }
	),
	predicateCase('isIPv6', isIPv6, ipv6, { 'typical regex': matches(TYPICAL_IPV6) }),
	predicateCase('isIPv4', isIPv4, ipv4, { 'typical regex': matches(TYPICAL_IPV4) }),
	predicateCase('isSemver', isSemver, versions, { 'semver.org regex': matches(SEMVER) }),
	predicateCase('isHexColor', isHexColor, colors, { 'typical regex': matches(HEX_COLOR) }),
	predicateCase('isSlug', isSlug, slugs, { 'typical regex': matches(SLUG) }),
	predicateCase('isNumericString', isNumericString, numerics, {
		'!isNaN(parseFloat)': function (value) {
			return !Number.isNaN(Number.parseFloat(value)) && Number.isFinite(Number(value));
		}
	}),
	predicateCase('isBase64', isBase64, base64, { 'typical regex': matches(BASE64) }),
	predicateCase('isBase64 (1 KB)', isBase64, [longBase64], { 'typical regex': matches(BASE64) }),
	predicateCase('isIsoDateTimeString', isIsoDateTimeString, dateTimes, {
		'!isNaN(Date.parse)': function (value) {
			return !Number.isNaN(Date.parse(value));
		}
	}),
	{
		name: 'satisfiesSemver (8 ranges x 6 versions, parsed every time)',
		fn: function () {
			return countSatisfying(satisfiesSemver);
		},
		competitors: {
			'semver.satisfies': function () {
				return countSatisfying(semver.satisfies);
			}
		}
	},
	{
		name: 'compileSemverRange predicate (6 versions)',
		fn: function () {
			return semverVersions.filter(compiledRange).length;
		},
		competitors: {
			'semver Range#test': function () {
				return semverVersions.filter(function (version) {
					return semverRange.test(version);
				}).length;
			}
		}
	},
	{
		name: 'satisfiesSemver (5000 distinct ranges)',
		fn: function () {
			distinctIndex = (distinctIndex + 1) % distinctRanges.length;
			return satisfiesSemver('3.4.5', distinctRanges[distinctIndex]);
		},
		competitors: {
			'semver.satisfies': function () {
				distinctIndex = (distinctIndex + 1) % distinctRanges.length;
				return semver.satisfies('3.4.5', distinctRanges[distinctIndex]);
			}
		}
	},
	{
		name: 'maxSatisfyingSemver (100 versions)',
		fn: function () {
			return maxSatisfyingSemver(candidateVersions, '^1.2.0');
		},
		competitors: {
			'semver.maxSatisfying': function () {
				return semver.maxSatisfying(candidateVersions, '^1.2.0');
			}
		}
	},
	{
		name: 'incrementSemver (prerelease, beta)',
		fn: function () {
			return incrementSemver('1.2.4-beta.3', 'prerelease', { identifier: 'beta' });
		},
		competitors: {
			'semver.inc': function () {
				return semver.inc('1.2.4-beta.3', 'prerelease', 'beta');
			}
		}
	},
	{
		name: 'compareSemver sort (8 versions)',
		fn: function () {
			return versions.slice().sort(compareSemver);
		}
	},
	{
		name: 'isCreditCardNumber (3 inputs)',
		fn: function () {
			return countValid(isCreditCardNumber, cards);
		}
	}
];
