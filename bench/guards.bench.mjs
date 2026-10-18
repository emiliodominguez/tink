import {
	isArrayOf,
	isDate,
	isError,
	isFiniteNumber,
	isFunction,
	isMap,
	isNil,
	isPlainObject,
	isPrimitive,
	isPromise,
	isRegExp,
	isSet,
	isString,
	isTypedArray,
	isInteger,
	isIntersection,
	isJsonObject,
	isJsonValue,
	isLazy,
	isLiteral,
	isMatching,
	isNumberInRange,
	isOptional,
	isPositiveNumber,
	isSafeInteger,
	isShape,
	isTruthy,
	refine
} from 'tinkjs/guards';
import is from '@sindresorhus/is';
import * as esToolkit from 'es-toolkit';
import * as esToolkitCompat from 'es-toolkit/compat';
import * as lodash from 'lodash-es';
import * as remeda from 'remeda';
import { z } from 'zod';

// A mixed bag of values, like the nodes a deep clone / deep equality walk sees.
const values = [];
for (let i = 0; i < 100; i++) {
	values.push({ id: i }, [i], `s${i}`, i, new Date(i), new Map(), null);
}
// Values a guard is mostly called with in hot loops: the matching type ("hits") and everything else ("misses").
const dates = Array.from({ length: 100 }, function (_, index) {
	return new Date(index);
});
const maps = Array.from({ length: 100 }, function () {
	return new Map();
});
const objects = values.filter(function (value) {
	return typeof value === 'object' && value !== null;
});
const typed = Array.from({ length: 100 }, function (_, index) {
	return index % 2 === 0 ? new Uint8Array(4) : new Float64Array(4);
});
const errors = Array.from({ length: 100 }, function (_, index) {
	return index % 2 === 0 ? new Error('x') : new TypeError('y');
});
const promises = Array.from({ length: 100 }, function () {
	return Promise.resolve(1);
});
const isStrings = isArrayOf(isString);
const strings = Array.from({ length: 100 }, function (_, index) {
	return `s${index}`;
});

// Schema-style inputs: API records, a recursive tree, JSON documents.
const users = Array.from({ length: 100 }, function (_, index) {
	return { id: index, name: `user${index}`, role: index % 10 === 0 ? 'admin' : 'member', tags: ['a', 'b'], profile: { age: 20 + (index % 50), city: 'x' } };
});
const isUser = isShape({ id: isInteger, name: isString, email: isOptional(isString), tags: isArrayOf(isString) });
const zodUser = z.object({ id: z.number().int(), name: z.string(), email: z.string().optional(), tags: z.array(z.string()) });
const adminPattern = { role: 'admin', profile: { city: 'x' } };
const isAdmin = isMatching(adminPattern);
const isNamed = isShape({ name: isString });
const isAged = isShape({ id: isInteger });
const isPerson = isIntersection(isNamed, isAged);
const zodPerson = z.intersection(z.object({ name: z.string() }), z.object({ id: z.number().int() }));
const isEven = refine(isInteger, function (value) {
	return value % 2 === 0;
});
const zodEven = z
	.number()
	.int()
	.refine(function (value) {
		return value % 2 === 0;
	});
const isMember = isLiteral('member');
const zodMember = z.literal('member');
const roles = users.map(function (user) {
	return user.role;
});
const numbers = Array.from({ length: 1000 }, function (_, index) {
	return index % 7 === 0 ? -index : index % 11 === 0 ? NaN : index * 1.5;
});
const isPercent = isNumberInRange(0, 1000);
const zodPercent = z.number().min(0).max(1000);
const adminRole = { role: 'admin' };
const isAdminRole = isMatching(adminRole);
const mixed = values.concat(['', 0, false, undefined, NaN, 0n]);
/** @type {(value: unknown) => value is { value: number; children: unknown[] }} */
const isTree = isShape({
	value: isInteger,
	children: isArrayOf(
		isLazy(function () {
			return isTree;
		})
	)
});
/** @type {import('zod').ZodType} */
const zodTree = z.lazy(function () {
	return z.object({ value: z.number().int(), children: z.array(zodTree) });
});
/**
 * Builds a complete tree.
 * @param {number} depth - Remaining depth
 * @param {number} width - Children per node
 * @returns {{ value: number; children: unknown[] }} The tree
 */
function buildTree(depth, width) {
	return {
		value: depth,
		children:
			depth === 0
				? []
				: Array.from({ length: width }, function () {
						return buildTree(depth - 1, width);
					})
	};
}
const tree = buildTree(5, 4);
const smallJson = { id: 1, name: 'Ada', tags: ['x', 'y'], active: true, score: 9.5, meta: null };
const largeJson = JSON.parse(
	JSON.stringify({
		users: users,
		total: users.length,
		nested: buildTree(4, 4)
	})
);

export default [
	{
		name: 'isPlainObject (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isPlainObject(values[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (esToolkit.isPlainObject(values[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (lodash.isPlainObject(values[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isDate (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isDate(values[i])) count++;
			return count;
		},
		baseline: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (values[i] instanceof Date) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (esToolkit.isDate(values[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (lodash.isDate(values[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isDate (100 dates)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < dates.length; i++) if (isDate(dates[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < dates.length; i++) if (esToolkit.isDate(dates[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < dates.length; i++) if (lodash.isDate(dates[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isMap (100 maps)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < maps.length; i++) if (isMap(maps[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < maps.length; i++) if (esToolkit.isMap(maps[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < maps.length; i++) if (lodash.isMap(maps[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isDate/isRegExp/isMap/isSet (400 objects)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < objects.length; i++) {
				const value = objects[i];
				if (isDate(value) || isRegExp(value) || isMap(value) || isSet(value)) count++;
			}
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < objects.length; i++) {
					const value = objects[i];
					if (esToolkit.isDate(value) || esToolkit.isRegExp(value) || esToolkit.isMap(value) || esToolkit.isSet(value)) count++;
				}
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < objects.length; i++) {
					const value = objects[i];
					if (lodash.isDate(value) || lodash.isRegExp(value) || lodash.isMap(value) || lodash.isSet(value)) count++;
				}
				return count;
			}
		}
	},
	{
		name: 'isTypedArray (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isTypedArray(values[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (esToolkit.isTypedArray(values[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (lodash.isTypedArray(values[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isTypedArray (100 typed arrays)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < typed.length; i++) if (isTypedArray(typed[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < typed.length; i++) if (esToolkit.isTypedArray(typed[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < typed.length; i++) if (lodash.isTypedArray(typed[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isError (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isError(values[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (esToolkit.isError(values[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (lodash.isError(values[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isError (100 errors)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < errors.length; i++) if (isError(errors[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < errors.length; i++) if (esToolkit.isError(errors[i])) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < errors.length; i++) if (lodash.isError(errors[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isPromise (700 mixed values + 100 promises)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isPromise(values[i])) count++;
			for (let i = 0; i < promises.length; i++) if (isPromise(promises[i])) count++;
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (esToolkit.isPromise(values[i])) count++;
				for (let i = 0; i < promises.length; i++) if (esToolkit.isPromise(promises[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isPrimitive/isNil/isFunction/isString (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) {
				const value = values[i];
				if (isPrimitive(value)) count++;
				if (isNil(value)) count++;
				if (isFunction(value)) count++;
				if (isString(value)) count++;
			}
			return count;
		},
		competitors: {
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) {
					const value = values[i];
					if (esToolkit.isPrimitive(value)) count++;
					if (esToolkit.isNil(value)) count++;
					if (esToolkit.isFunction(value)) count++;
					if (esToolkit.isString(value)) count++;
				}
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) {
					const value = values[i];
					if (value == null || (typeof value !== 'object' && typeof value !== 'function')) count++;
					if (lodash.isNil(value)) count++;
					if (lodash.isFunction(value)) count++;
					if (lodash.isString(value)) count++;
				}
				return count;
			}
		}
	},
	{
		name: 'isFiniteNumber (700 mixed values)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < values.length; i++) if (isFiniteNumber(values[i])) count++;
			return count;
		},
		competitors: {
			lodash: function () {
				let count = 0;
				for (let i = 0; i < values.length; i++) if (lodash.isFinite(values[i])) count++;
				return count;
			}
		}
	},
	{
		name: 'isArrayOf(isString) (100 strings)',
		fn: function () {
			return isStrings(strings);
		}
	},
	{
		name: 'isShape (100 records, 4 keys)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < users.length; i++) if (isUser(users[i])) count++;
			return count;
		},
		competitors: {
			zod: function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (zodUser.safeParse(users[i]).success) count++;
				return count;
			}
		}
	},
	{
		name: 'isMatching (100 records, nested partial pattern)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < users.length; i++) if (isAdmin(users[i])) count++;
			return count;
		},
		competitors: {
			lodash: function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (lodash.isMatch(users[i], adminPattern)) count++;
				return count;
			},
			'es-toolkit': function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (esToolkitCompat.isMatch(users[i], adminPattern)) count++;
				return count;
			}
		}
	},
	{
		name: 'isMatching (100 records, shallow pattern)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < users.length; i++) if (isAdminRole(users[i])) count++;
			return count;
		},
		competitors: {
			remeda: function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (remeda.hasSubObject(users[i], adminRole)) count++;
				return count;
			},
			lodash: function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (lodash.isMatch(users[i], adminRole)) count++;
				return count;
			}
		}
	},
	{
		name: 'isTruthy (filter 706 mixed values)',
		fn: function () {
			return mixed.filter(isTruthy).length;
		},
		competitors: {
			remeda: function () {
				return mixed.filter(remeda.isTruthy).length;
			},
			'@sindresorhus/is': function () {
				return mixed.filter(is.truthy).length;
			}
		}
	},
	{
		name: 'isPositiveNumber / isSafeInteger (1000 numbers)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < numbers.length; i++) {
				if (isPositiveNumber(numbers[i])) count++;
				if (isSafeInteger(numbers[i])) count++;
			}
			return count;
		},
		competitors: {
			lodash: function () {
				let count = 0;
				for (let i = 0; i < numbers.length; i++) {
					if (lodash.isFinite(numbers[i]) && numbers[i] > 0) count++;
					if (lodash.isSafeInteger(numbers[i])) count++;
				}
				return count;
			},
			'@sindresorhus/is': function () {
				let count = 0;
				for (let i = 0; i < numbers.length; i++) {
					if (is.number(numbers[i]) && Number.isFinite(numbers[i]) && numbers[i] > 0) count++;
					if (is.safeInteger(numbers[i])) count++;
				}
				return count;
			}
		}
	},
	{
		name: 'isNumberInRange (1000 numbers)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < numbers.length; i++) if (isPercent(numbers[i])) count++;
			return count;
		},
		competitors: {
			'@sindresorhus/is': function () {
				let count = 0;
				for (let i = 0; i < numbers.length; i++) if (is.inRange(numbers[i], [0, 1000])) count++;
				return count;
			},
			zod: function () {
				let count = 0;
				for (let i = 0; i < numbers.length; i++) if (zodPercent.safeParse(numbers[i]).success) count++;
				return count;
			}
		}
	},
	{
		name: 'isLiteral (100 strings)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < roles.length; i++) if (isMember(roles[i])) count++;
			return count;
		},
		competitors: {
			zod: function () {
				let count = 0;
				for (let i = 0; i < roles.length; i++) if (zodMember.safeParse(roles[i]).success) count++;
				return count;
			}
		}
	},
	{
		name: 'isIntersection (100 records, 2 shapes)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < users.length; i++) if (isPerson(users[i])) count++;
			return count;
		},
		competitors: {
			zod: function () {
				let count = 0;
				for (let i = 0; i < users.length; i++) if (zodPerson.safeParse(users[i]).success) count++;
				return count;
			}
		}
	},
	{
		name: 'refine (1000 numbers)',
		fn: function () {
			let count = 0;
			for (let i = 0; i < numbers.length; i++) if (isEven(numbers[i])) count++;
			return count;
		},
		competitors: {
			zod: function () {
				let count = 0;
				for (let i = 0; i < numbers.length; i++) if (zodEven.safeParse(numbers[i]).success) count++;
				return count;
			}
		}
	},
	{
		name: 'isLazy (recursive tree, 1365 nodes)',
		fn: function () {
			return isTree(tree);
		},
		competitors: {
			zod: function () {
				return zodTree.safeParse(tree).success;
			}
		}
	},
	{
		name: 'isJsonValue (small object)',
		fn: function () {
			return isJsonValue(smallJson);
		},
		competitors: {
			'es-toolkit': function () {
				return esToolkit.isJSONValue(smallJson);
			}
		}
	},
	{
		name: 'isJsonObject (large document, ~2k nodes)',
		fn: function () {
			return isJsonObject(largeJson);
		},
		competitors: {
			'es-toolkit': function () {
				return esToolkit.isJSONObject(largeJson);
			}
		}
	}
];
