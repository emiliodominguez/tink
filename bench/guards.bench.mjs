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
	isTypedArray
} from '@emiliodominguez/tink/guards';
import * as esToolkit from 'es-toolkit';
import * as lodash from 'lodash-es';

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
	}
];
