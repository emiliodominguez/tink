import {
	clone,
	deepClone,
	deepFreeze,
	deepMerge,
	deleteFromObjectByKeys,
	flattenObject,
	getFromObjectByKeys,
	hasInObjectByKeys,
	invert,
	isEmpty,
	isEqual,
	mapKeys,
	mapValues,
	merge,
	omit,
	omitBy,
	pick,
	pickBy,
	setInObjectByKeys,
	defaults as tinkDefaults,
	defaultsDeep,
	deepMergeWith,
	evolve,
	findKey,
	hash,
	isEqualWith,
	isMatch,
	mapEntries,
	omitInObjectByKeys,
	shallowEqual,
	sortKeys,
	stableStringify,
	toCamelCaseKeys,
	toPath,
	toSnakeCaseKeys,
	updateInObjectByKeys
} from '@emiliodominguez/tink/objects';
import { defu } from 'defu';
import * as toolkit from 'es-toolkit';
import * as compat from 'es-toolkit/compat';
import fastStableStringify from 'fast-json-stable-stringify';
import * as lodash from 'lodash-es';
import * as radash from 'radash';
import * as remeda from 'remeda';

// Inputs: a small record (6 keys, a little nesting), a flat 100-key record, a nested config, and 1k (or 100k) user records.
const small = { id: 7, name: 'Ada', active: true, tags: ['a', 'b'], meta: { created: 1, owner: { id: 1 } }, score: 9.5 };
const record = Object.fromEntries(
	Array.from({ length: 100 }, function (_, index) {
		return [`key${index}`, index];
	})
);
const labels = Object.fromEntries(
	Array.from({ length: 100 }, function (_, index) {
		return [`key${index}`, `value${index}`];
	})
);
const halfOfTheKeys = Object.keys(record).filter(function (_, index) {
	return index % 2 === 0;
});

/**
 * Builds user-like records with nested objects and arrays.
 * @param {number} n - How many records
 * @returns {object[]} The records
 */
function people(n) {
	return Array.from({ length: n }, function (_, index) {
		return {
			id: index,
			name: `user-${index}`,
			email: `u${index}@example.com`,
			active: index % 3 === 0,
			tags: ['a', 'b', String(index % 7)],
			address: { city: `city-${index % 50}`, zip: String(10_000 + index), geo: { lat: index / 10, lng: -index / 10 } }
		};
	});
}

const users = people(1_000);
const manyUsers = people(100_000);
const config = {
	server: { host: 'localhost', port: 8080, tls: { cert: 'cert.pem', key: 'key.pem' } },
	flags: [1, 2, 3, 4, 5],
	db: { pool: { min: 1, max: 10 }, replicas: [{ host: 'a' }, { host: 'b' }] }
};
const copies = {
	small: JSON.parse(JSON.stringify(small)),
	config: JSON.parse(JSON.stringify(config)),
	users: JSON.parse(JSON.stringify(users)),
	manyUsers: JSON.parse(JSON.stringify(manyUsers))
};
const defaults = { a: { x: 1, y: { z: 2, w: [1, 2] } }, b: 'text', c: { d: { e: { f: 1 } } }, list: [1, 2, 3] };
const overrides = { a: { y: { z: 3 }, q: 9 }, c: { d: { e: { g: 2 } } }, list: [9], extra: true };
const left = Object.fromEntries(
	users.slice(0, 200).map(function (user) {
		return [user.name, { profile: { email: user.email, city: user.address.city }, roles: user.tags }];
	})
);
const right = Object.fromEntries(
	users.slice(100, 300).map(function (user) {
		return [user.name, { profile: { zip: user.address.zip }, active: user.active }];
	})
);

/**
 * @param {number} value - A number
 * @returns {number} Twice the number
 */
function double(value) {
	return value * 2;
}
/**
 * @param {number} value - A number
 * @returns {boolean} Whether it is even
 */
function isEven(value) {
	return value % 2 === 0;
}
/**
 * @param {unknown} _value - Ignored
 * @param {string} key - A key
 * @returns {string} The key in upper case
 */
function upperKey(_value, key) {
	return key.toUpperCase();
}

/**
 * Builds a bench case comparing a helper with es-toolkit and lodash equivalents.
 * @param {string} name - The case name
 * @param {() => unknown} fn - Our implementation
 * @param {Record<string, () => unknown>} competitors - The equivalent calls of other libraries
 * @param {() => unknown} [baseline] - A native reference, when there is one
 * @returns {object} The case
 */
function compare(name, fn, competitors, baseline) {
	return baseline === undefined ? { name, fn, competitors } : { name, fn, baseline, competitors };
}

// Round 11 helpers: defaults, immutable path updates, matching, key transforms, serialization.
const appDefaults = { server: { host: 'localhost', port: 80, tls: { enabled: false, cert: null } }, log: { level: 'info', pretty: true }, retries: 3, name: 'app' };
const appConfig = { server: { port: 8080, tls: { enabled: true } }, log: { level: undefined }, name: 'mine' };
const snakeUsers = JSON.parse(
	JSON.stringify(users)
		.replace(/"name"/g, '"user_name"')
		.replace(/"email"/g, '"email_address"')
		.replace(/"zip"/g, '"zip_code"')
);
const camelUsers = toCamelCaseKeys(snakeUsers);
const smallCopy = JSON.parse(JSON.stringify(small));
const recordCopy = { ...record };
const pattern = { address: { city: 'city-5' }, active: false };
const mapEntry = function (value, key) {
	return [key.toUpperCase(), value];
};
const caseless = function (a, b) {
	return typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : undefined;
};
const shuffled = Object.fromEntries(Object.entries(record).reverse());
const appState = { user: { profile: { name: 'Ada', visits: 1 }, settings: { theme: 'dark' } }, todos: users.slice(0, 50), flags: { a: true } };
const increment = function (value) {
	return value + 1;
};

const round11 = [
	compare(
		'defaults (flat record)',
		function () {
			return tinkDefaults({ id: 1, name: undefined }, small);
		},
		{
			'es-toolkit': function () {
				return compat.defaults({}, { id: 1, name: undefined }, small);
			},
			lodash: function () {
				return lodash.defaults({}, { id: 1, name: undefined }, small);
			}
		}
	),
	compare(
		'defaultsDeep (config over defaults)',
		function () {
			return defaultsDeep(appConfig, appDefaults);
		},
		{
			defu: function () {
				return defu(appConfig, appDefaults);
			},
			'es-toolkit': function () {
				return compat.defaultsDeep({}, appConfig, appDefaults);
			},
			lodash: function () {
				return lodash.defaultsDeep({}, appConfig, appDefaults);
			}
		}
	),
	compare(
		'deepMergeWith arrays: concat (nested)',
		function () {
			return deepMergeWith({ arrays: 'concat' }, defaults, overrides);
		},
		{
			'es-toolkit': function () {
				return toolkit.mergeWith(toolkit.cloneDeep(defaults), overrides, function (a, b) {
					return Array.isArray(a) && Array.isArray(b) ? a.concat(b) : undefined;
				});
			},
			lodash: function () {
				return lodash.mergeWith({}, defaults, overrides, function (a, b) {
					return Array.isArray(a) && Array.isArray(b) ? a.concat(b) : undefined;
				});
			}
		}
	),
	compare(
		'updateInObjectByKeys (depth 3, immutable)',
		function () {
			return updateInObjectByKeys(appState, 'user.profile.visits', increment);
		},
		{
			remeda: function () {
				return remeda.setPath(appState, ['user', 'profile', 'visits'], appState.user.profile.visits + 1);
			},
			'es-toolkit': function () {
				return compat.update(compat.cloneDeep(appState), 'user.profile.visits', increment);
			}
		}
	),
	{
		name: 'omitInObjectByKeys (depth 3, immutable)',
		fn: function () {
			return omitInObjectByKeys(appState, 'user.settings.theme');
		}
	},
	compare(
		'toPath (bracket path)',
		function () {
			return toPath("users[12]['first.name'].address.zip");
		},
		{
			'es-toolkit': function () {
				return compat.toPath("users[12]['first.name'].address.zip");
			},
			lodash: function () {
				return lodash.toPath("users[12]['first.name'].address.zip");
			},
			remeda: function () {
				return remeda.stringToPath("users[12]['first.name'].address.zip");
			}
		}
	),
	compare(
		'isMatch (filter 1k users by nested pattern)',
		function () {
			return users.filter(function (user) {
				return isMatch(user, pattern);
			});
		},
		{
			'es-toolkit': function () {
				return users.filter(function (user) {
					return compat.isMatch(user, pattern);
				});
			},
			lodash: function () {
				return users.filter(function (user) {
					return lodash.isMatch(user, pattern);
				});
			}
		}
	),
	compare(
		'shallowEqual (100-key record, equal)',
		function () {
			return shallowEqual(record, recordCopy);
		},
		{
			remeda: function () {
				return remeda.isShallowEqual(record, recordCopy);
			}
		}
	),
	compare(
		'shallowEqual (small record, different)',
		function () {
			return shallowEqual(small, smallCopy);
		},
		{
			remeda: function () {
				return remeda.isShallowEqual(small, smallCopy);
			}
		}
	),
	compare(
		'isEqualWith (1k users, caseless strings)',
		function () {
			return isEqualWith(users, copies.users, caseless);
		},
		{
			'es-toolkit': function () {
				return toolkit.isEqualWith(users, copies.users, caseless);
			},
			lodash: function () {
				return lodash.isEqualWith(users, copies.users, caseless);
			}
		}
	),
	compare(
		'findKey (100-key record, last key)',
		function () {
			return findKey(record, function (value) {
				return value === 99;
			});
		},
		{
			'es-toolkit': function () {
				return toolkit.findKey(record, function (value) {
					return value === 99;
				});
			},
			lodash: function () {
				return lodash.findKey(record, function (value) {
					return value === 99;
				});
			}
		}
	),
	compare(
		'mapEntries (100-key record)',
		function () {
			return mapEntries(record, mapEntry);
		},
		{
			radash: function () {
				return radash.mapEntries(record, function (key, value) {
					return [key.toUpperCase(), value];
				});
			}
		}
	),
	compare(
		'sortKeys (100-key record)',
		function () {
			return sortKeys(shuffled);
		},
		{
			'es-toolkit': function () {
				return toolkit.sortKeys(shuffled);
			}
		}
	),
	compare(
		'evolve (nested transforms)',
		function () {
			return evolve(appState, { user: { profile: { visits: increment } }, flags: { a: lodash.negate(Boolean) } });
		},
		{
			remeda: function () {
				return remeda.evolve(appState, { user: { profile: { visits: increment } }, flags: { a: lodash.negate(Boolean) } });
			}
		}
	),
	compare(
		'toCamelCaseKeys (1k snake_case users)',
		function () {
			return toCamelCaseKeys(snakeUsers);
		},
		{
			'es-toolkit': function () {
				return toolkit.toCamelCaseKeys(snakeUsers);
			}
		}
	),
	compare(
		'toSnakeCaseKeys (1k camelCase users)',
		function () {
			return toSnakeCaseKeys(camelUsers);
		},
		{
			'es-toolkit': function () {
				return toolkit.toSnakeCaseKeys(camelUsers);
			}
		}
	),
	compare(
		'stableStringify (small record)',
		function () {
			return stableStringify(small);
		},
		{
			'fast-json-stable-stringify': function () {
				return fastStableStringify(small);
			}
		},
		function () {
			return JSON.stringify(small);
		}
	),
	compare(
		'stableStringify (1k users)',
		function () {
			return stableStringify(users);
		},
		{
			'fast-json-stable-stringify': function () {
				return fastStableStringify(users);
			}
		},
		function () {
			return JSON.stringify(users);
		}
	),
	{
		name: 'hash (small record)',
		fn: function () {
			return hash(small);
		}
	}
];

export default [
	compare(
		'deepClone (small record)',
		function () {
			return deepClone(small);
		},
		{
			'es-toolkit': function () {
				return toolkit.cloneDeep(small);
			},
			lodash: function () {
				return lodash.cloneDeep(small);
			}
		},
		function () {
			return globalThis.structuredClone(small);
		}
	),
	compare(
		'deepClone (nested config)',
		function () {
			return deepClone(config);
		},
		{
			'es-toolkit': function () {
				return toolkit.cloneDeep(config);
			},
			lodash: function () {
				return lodash.cloneDeep(config);
			}
		}
	),
	compare(
		'deepClone (1k users)',
		function () {
			return deepClone(users);
		},
		{
			'es-toolkit': function () {
				return toolkit.cloneDeep(users);
			},
			lodash: function () {
				return lodash.cloneDeep(users);
			}
		},
		function () {
			return globalThis.structuredClone(users);
		}
	),
	compare(
		'deepClone (100k users)',
		function () {
			return deepClone(manyUsers);
		},
		{
			'es-toolkit': function () {
				return toolkit.cloneDeep(manyUsers);
			},
			lodash: function () {
				return lodash.cloneDeep(manyUsers);
			}
		}
	),
	compare(
		'clone (small record)',
		function () {
			return clone(small);
		},
		{
			'es-toolkit': function () {
				return toolkit.clone(small);
			},
			lodash: function () {
				return lodash.clone(small);
			}
		},
		function () {
			return { ...small };
		}
	),
	compare(
		'clone (100 keys)',
		function () {
			return clone(record);
		},
		{
			'es-toolkit': function () {
				return toolkit.clone(record);
			},
			lodash: function () {
				return lodash.clone(record);
			}
		}
	),
	compare(
		'clone (array of 1k)',
		function () {
			return clone(users);
		},
		{
			'es-toolkit': function () {
				return toolkit.clone(users);
			},
			lodash: function () {
				return lodash.clone(users);
			}
		},
		function () {
			return users.slice();
		}
	),
	compare(
		'isEqual (small record, equal)',
		function () {
			return isEqual(small, copies.small);
		},
		{
			'es-toolkit': function () {
				return toolkit.isEqual(small, copies.small);
			},
			lodash: function () {
				return lodash.isEqual(small, copies.small);
			}
		}
	),
	compare(
		'isEqual (nested config, equal)',
		function () {
			return isEqual(config, copies.config);
		},
		{
			'es-toolkit': function () {
				return toolkit.isEqual(config, copies.config);
			},
			lodash: function () {
				return lodash.isEqual(config, copies.config);
			}
		}
	),
	compare(
		'isEqual (1k users, equal)',
		function () {
			return isEqual(users, copies.users);
		},
		{
			'es-toolkit': function () {
				return toolkit.isEqual(users, copies.users);
			},
			lodash: function () {
				return lodash.isEqual(users, copies.users);
			}
		}
	),
	compare(
		'isEqual (100k users, equal)',
		function () {
			return isEqual(manyUsers, copies.manyUsers);
		},
		{
			'es-toolkit': function () {
				return toolkit.isEqual(manyUsers, copies.manyUsers);
			},
			lodash: function () {
				return lodash.isEqual(manyUsers, copies.manyUsers);
			}
		}
	),
	compare(
		'deepMerge (2 nested objects)',
		function () {
			return deepMerge(defaults, overrides);
		},
		{
			'es-toolkit': function () {
				return toolkit.toMerged(defaults, overrides);
			},
			lodash: function () {
				return lodash.merge({}, defaults, overrides);
			}
		}
	),
	compare(
		'deepMerge (200 + 200 entries)',
		function () {
			return deepMerge(left, right);
		},
		{
			'es-toolkit': function () {
				return toolkit.toMerged(left, right);
			},
			lodash: function () {
				return lodash.merge({}, left, right);
			}
		}
	),
	compare(
		'merge (2 small objects)',
		function () {
			return merge(defaults, overrides);
		},
		{
			lodash: function () {
				return lodash.assign({}, defaults, overrides);
			}
		},
		function () {
			return { ...defaults, ...overrides };
		}
	),
	compare(
		'merge (2 × 100 keys)',
		function () {
			return merge(record, labels);
		},
		{
			lodash: function () {
				return lodash.assign({}, record, labels);
			}
		},
		function () {
			return { ...record, ...labels };
		}
	),
	compare(
		'pick (3 of 6 keys)',
		function () {
			return pick(small, ['id', 'name', 'score']);
		},
		{
			'es-toolkit': function () {
				return toolkit.pick(small, ['id', 'name', 'score']);
			},
			lodash: function () {
				return lodash.pick(small, ['id', 'name', 'score']);
			}
		}
	),
	compare(
		'pick (50 of 100 keys)',
		function () {
			return pick(record, halfOfTheKeys);
		},
		{
			'es-toolkit': function () {
				return toolkit.pick(record, halfOfTheKeys);
			},
			lodash: function () {
				return lodash.pick(record, halfOfTheKeys);
			}
		}
	),
	compare(
		'omit (2 of 6 keys)',
		function () {
			return omit(small, ['tags', 'meta']);
		},
		{
			'es-toolkit': function () {
				return toolkit.omit(small, ['tags', 'meta']);
			},
			lodash: function () {
				return lodash.omit(small, ['tags', 'meta']);
			}
		}
	),
	compare(
		'omit (50 of 100 keys)',
		function () {
			return omit(record, halfOfTheKeys);
		},
		{
			'es-toolkit': function () {
				return toolkit.omit(record, halfOfTheKeys);
			},
			lodash: function () {
				return lodash.omit(record, halfOfTheKeys);
			}
		}
	),
	compare(
		'pickBy (100 keys)',
		function () {
			return pickBy(record, isEven);
		},
		{
			'es-toolkit': function () {
				return toolkit.pickBy(record, isEven);
			},
			lodash: function () {
				return lodash.pickBy(record, isEven);
			}
		}
	),
	compare(
		'omitBy (100 keys)',
		function () {
			return omitBy(record, isEven);
		},
		{
			'es-toolkit': function () {
				return toolkit.omitBy(record, isEven);
			},
			lodash: function () {
				return lodash.omitBy(record, isEven);
			}
		}
	),
	compare(
		'mapValues (6 keys)',
		function () {
			return mapValues(small, String);
		},
		{
			'es-toolkit': function () {
				return toolkit.mapValues(small, String);
			},
			lodash: function () {
				return lodash.mapValues(small, String);
			}
		}
	),
	compare(
		'mapValues (100 keys)',
		function () {
			return mapValues(record, double);
		},
		{
			'es-toolkit': function () {
				return toolkit.mapValues(record, double);
			},
			lodash: function () {
				return lodash.mapValues(record, double);
			}
		}
	),
	compare(
		'mapKeys (100 keys)',
		function () {
			return mapKeys(record, upperKey);
		},
		{
			'es-toolkit': function () {
				return toolkit.mapKeys(record, upperKey);
			},
			lodash: function () {
				return lodash.mapKeys(record, upperKey);
			}
		}
	),
	compare(
		'invert (100 keys)',
		function () {
			return invert(labels);
		},
		{
			'es-toolkit': function () {
				return toolkit.invert(labels);
			},
			lodash: function () {
				return lodash.invert(labels);
			}
		}
	),
	compare(
		'getFromObjectByKeys (1 segment)',
		function () {
			return getFromObjectByKeys(small, 'name');
		},
		{
			'es-toolkit/compat': function () {
				return compat.get(small, 'name');
			},
			lodash: function () {
				return lodash.get(small, 'name');
			}
		}
	),
	compare(
		'getFromObjectByKeys (3 segments)',
		function () {
			return getFromObjectByKeys(config, 'server.tls.cert');
		},
		{
			'es-toolkit/compat': function () {
				return compat.get(config, 'server.tls.cert');
			},
			lodash: function () {
				return lodash.get(config, 'server.tls.cert');
			}
		}
	),
	compare(
		'getFromObjectByKeys (array index)',
		function () {
			return getFromObjectByKeys(config, 'db.replicas.1.host');
		},
		{
			'es-toolkit/compat': function () {
				return compat.get(config, 'db.replicas.1.host');
			},
			lodash: function () {
				return lodash.get(config, 'db.replicas.1.host');
			}
		}
	),
	compare(
		'setInObjectByKeys (existing path)',
		function () {
			return setInObjectByKeys(small, 'meta.owner.id', 2);
		},
		{
			'es-toolkit/compat': function () {
				return compat.set(small, 'meta.owner.id', 2);
			},
			lodash: function () {
				return lodash.set(small, 'meta.owner.id', 2);
			}
		}
	),
	compare(
		'setInObjectByKeys (new path)',
		function () {
			return setInObjectByKeys({}, 'a.b.0.c', 1);
		},
		{
			'es-toolkit/compat': function () {
				return compat.set({}, 'a.b.0.c', 1);
			},
			lodash: function () {
				return lodash.set({}, 'a.b.0.c', 1);
			}
		}
	),
	compare(
		'hasInObjectByKeys (3 segments)',
		function () {
			return hasInObjectByKeys(config, 'server.tls.cert');
		},
		{
			'es-toolkit/compat': function () {
				return compat.has(config, 'server.tls.cert');
			},
			lodash: function () {
				return lodash.has(config, 'server.tls.cert');
			}
		}
	),
	compare(
		'deleteFromObjectByKeys (fresh object)',
		function () {
			const target = { a: { b: 1, c: 2 } };
			deleteFromObjectByKeys(target, 'a.b');
			return target;
		},
		{
			'es-toolkit/compat': function () {
				const target = { a: { b: 1, c: 2 } };
				compat.unset(target, 'a.b');
				return target;
			},
			lodash: function () {
				const target = { a: { b: 1, c: 2 } };
				lodash.unset(target, 'a.b');
				return target;
			}
		}
	),
	compare(
		'isEmpty ({})',
		function () {
			return isEmpty({});
		},
		{
			'es-toolkit/compat': function () {
				return compat.isEmpty({});
			},
			lodash: function () {
				return lodash.isEmpty({});
			}
		}
	),
	compare(
		'isEmpty (100 keys)',
		function () {
			return isEmpty(record);
		},
		{
			'es-toolkit/compat': function () {
				return compat.isEmpty(record);
			},
			lodash: function () {
				return lodash.isEmpty(record);
			}
		}
	),
	compare(
		'flattenObject (nested config)',
		function () {
			return flattenObject(config);
		},
		{
			'es-toolkit': function () {
				return toolkit.flattenObject(config);
			}
		}
	),
	compare(
		'flattenObject (1k users)',
		function () {
			return flattenObject({ users });
		},
		{
			'es-toolkit': function () {
				return toolkit.flattenObject({ users });
			}
		}
	),
	{
		name: 'deepFreeze (fresh nested object)',
		fn: function () {
			return deepFreeze({ a: { b: [1, 2, { c: 3 }] }, d: { e: 1 } });
		}
	},
	...round11
];
