import {
	averageBy,
	chunk,
	chunkBy,
	combinations,
	compact,
	countBy,
	difference,
	differenceBy,
	differenceWith,
	drop,
	dropLast,
	dropLastWhile,
	flatten,
	flattenDeep,
	groupBy,
	intersection,
	intersectionBy,
	intersectionWith,
	isSubset,
	keyBy,
	maxBy,
	medianBy,
	minBy,
	nthBy,
	orderBy,
	partition,
	permutations,
	powerSet,
	range,
	removeDuplicates,
	rotate,
	sample,
	sampleSize,
	shuffle,
	sortBy,
	sortedIndexBy,
	sortedLastIndex,
	splitWhen,
	sumBy,
	swap,
	symmetricDifference,
	symmetricDifferenceBy,
	take,
	takeFirstBy,
	takeLast,
	takeLastWhile,
	toArray,
	toggle,
	union,
	unionBy,
	unionWith,
	uniqueBy,
	uniqueWith,
	unzip,
	windowed,
	zip,
	zipObject,
	zipWith
} from '@emiliodominguez/tink/arrays';
import * as toolkit from 'es-toolkit';
import * as lodash from 'lodash-es';
import * as radash from 'radash';
import * as remeda from 'remeda';

// Realistic inputs at three sizes: small (10), medium (1k) and large (100k) items.
const SIZES = [10, 1_000, 100_000];

/**
 * Formats an input size for case names.
 * @param {number} n - The number of items
 * @returns {string} e.g. `'10'`, `'1k'`, `'100k'`
 */
function label(n) {
	return n >= 1000 ? `${n / 1000}k` : String(n);
}

/**
 * Pseudo-random integers in `[0, modulo)` (deterministic, so every run sees the same data).
 * @param {number} n - How many numbers
 * @param {number} modulo - Exclusive upper bound
 * @param {number} [seed=0] - Offset making different arrays differ
 * @returns {number[]} The numbers
 */
function integers(n, modulo, seed = 0) {
	return Array.from({ length: n }, function (_, index) {
		return ((index + seed) * 7919 + seed * 104_729) % modulo;
	});
}

/**
 * Builds user-like records.
 * @param {number} n - How many records
 * @returns {Array<{ id: number, team: string, name: string, age: number, score: number }>} The records
 */
function people(n) {
	return integers(n, 1_000_003).map(function (id, index) {
		return { id, team: `team-${index % 20}`, name: `user-${id}`, age: 18 + (id % 60), score: (id % 1000) / 10 };
	});
}

/**
 * Builds one bench case per size.
 * @param {string} name - The helper being measured
 * @param {number[]} sizes - The input sizes
 * @param {(n: number) => { fn: () => unknown, baseline?: () => unknown, competitors?: Record<string, () => unknown> }} build - Creates the inputs (outside the timed calls) and the measured functions
 * @returns {object[]} The cases
 */
function sized(name, sizes, build) {
	return sizes.map(function (n) {
		return Object.assign({ name: `${name} (${label(n)})` }, build(n));
	});
}

// Key selectors shared by the cases (the same function objects are given to every library).
/**
 * @param {{ team: string }} user - A record
 * @returns {string} Its team
 */
function byTeam(user) {
	return user.team;
}
/**
 * @param {{ id: number }} user - A record
 * @returns {number} Its id
 */
function byId(user) {
	return user.id;
}
/**
 * @param {{ name: string }} user - A record
 * @returns {string} Its name
 */
function byName(user) {
	return user.name;
}
/**
 * @param {{ score: number }} user - A record
 * @returns {number} Its score
 */
function byScore(user) {
	return user.score;
}
/**
 * @param {{ age: number }} user - A record
 * @returns {boolean} Whether the user is an adult over 40
 */
function isSenior(user) {
	return user.age >= 40;
}
/**
 * @param {number} n - A number
 * @returns {number} `n` rounded down to a multiple of 10
 */
function decade(n) {
	return n - (n % 10);
}

/**
 * @param {{ id: number }} a - A record
 * @param {{ id: number }} b - Another record
 * @returns {boolean} Whether both have the same id
 */
function sameId(a, b) {
	return a.id === b.id;
}
/**
 * @param {number} a - A number
 * @param {number} b - A number
 * @param {number} [c=0] - An optional third number
 * @returns {number} The sum
 */
function add(a, b, c = 0) {
	return a + b + c;
}
// Small alphabet for the combinatorics cases.
const LETTERS = Array.from('abcdefghijklmnopqrst');

export default [
	...sized('chunk', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return chunk(numbers, 3);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.chunk(numbers, 3);
				},
				lodash: function () {
					return lodash.chunk(numbers, 3);
				}
			}
		};
	}),
	...sized('compact', SIZES, function (n) {
		const values = integers(n, 7).map(function (k) {
			return [0, 1, '', 'a', null, false, NaN][k];
		});
		return {
			fn: function () {
				return compact(values);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.compact(values);
				},
				lodash: function () {
					return lodash.compact(values);
				}
			}
		};
	}),
	...sized('flatten (pairs + scalars)', SIZES, function (n) {
		const nested = integers(n, 1000).map(function (k) {
			return k % 3 === 0 ? k : [k, k + 1];
		});
		return {
			fn: function () {
				return flatten(nested);
			},
			baseline: function () {
				return nested.flat();
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.flatten(nested);
				},
				lodash: function () {
					return lodash.flatten(nested);
				}
			}
		};
	}),
	...sized('flattenDeep (4 levels)', SIZES, function (n) {
		const nested = Array.from({ length: Math.ceil(n / 5) }, function (_, index) {
			return [index, [index + 1, [index + 2, [index + 3]]], index + 4];
		});
		return {
			fn: function () {
				return flattenDeep(nested);
			},
			baseline: function () {
				return nested.flat(Infinity);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.flattenDeep(nested);
				},
				lodash: function () {
					return lodash.flattenDeep(nested);
				}
			}
		};
	}),
	...sized('removeDuplicates (numbers, ~50% dupes)', SIZES, function (n) {
		const numbers = integers(n, Math.max(1, n >> 1));
		return {
			fn: function () {
				return removeDuplicates(numbers);
			},
			baseline: function () {
				return Array.from(new Set(numbers));
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.uniq(numbers);
				},
				lodash: function () {
					return lodash.uniq(numbers);
				}
			}
		};
	}),
	...sized('removeDuplicates (strings, ~50% dupes)', SIZES, function (n) {
		const words = integers(n, Math.max(1, n >> 1)).map(String);
		return {
			fn: function () {
				return removeDuplicates(words);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.uniq(words);
				},
				lodash: function () {
					return lodash.uniq(words);
				}
			}
		};
	}),
	...sized('uniqueBy (objects, 20 keys)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return uniqueBy(users, byTeam);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.uniqBy(users, byTeam);
				},
				lodash: function () {
					return lodash.uniqBy(users, byTeam);
				}
			}
		};
	}),
	...sized('union (2 × n numbers)', SIZES, function (n) {
		const a = integers(n, n * 2);
		const b = integers(n, n * 2, 3);
		return {
			fn: function () {
				return union(a, b);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.union(a, b);
				},
				lodash: function () {
					return lodash.union(a, b);
				}
			}
		};
	}),
	...sized('intersection (2 × n numbers)', SIZES, function (n) {
		const a = integers(n, n * 2);
		const b = integers(n, n * 2, 3);
		return {
			fn: function () {
				return intersection(a, b);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.intersection(a, b);
				},
				lodash: function () {
					return lodash.intersection(a, b);
				}
			}
		};
	}),
	...sized('difference (2 × n numbers)', SIZES, function (n) {
		const a = integers(n, n * 2);
		const b = integers(n, n * 2, 3);
		return {
			fn: function () {
				return difference(a, b);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.difference(a, b);
				},
				lodash: function () {
					return lodash.difference(a, b);
				}
			}
		};
	}),
	...sized('symmetricDifference (2 × n numbers)', SIZES, function (n) {
		const a = integers(n, n * 2);
		const b = integers(n, n * 2, 3);
		return {
			fn: function () {
				return symmetricDifference(a, b);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.xor(a, b);
				},
				lodash: function () {
					return lodash.xor(a, b);
				}
			}
		};
	}),
	...sized('isSubset (n of 2n numbers)', SIZES, function (n) {
		const superset = integers(2 * n, 2 * n);
		const subset = superset.slice(0, n);
		return {
			fn: function () {
				return isSubset(subset, superset);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.isSubset(superset, subset);
				}
			}
		};
	}),
	...sized('differenceBy (objects by id)', SIZES, function (n) {
		const a = people(n);
		const b = people(n).filter(function (_, index) {
			return index % 2 === 0;
		});
		return {
			fn: function () {
				return differenceBy(a, b, byId);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.differenceBy(a, b, byId);
				},
				lodash: function () {
					return lodash.differenceBy(a, b, byId);
				}
			}
		};
	}),
	...sized('intersectionBy (objects by id)', SIZES, function (n) {
		const a = people(n);
		const b = people(n).filter(function (_, index) {
			return index % 2 === 0;
		});
		return {
			fn: function () {
				return intersectionBy(a, b, byId);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.intersectionBy(a, b, byId);
				},
				lodash: function () {
					return lodash.intersectionBy(a, b, byId);
				}
			}
		};
	}),
	...sized('groupBy (objects, 20 groups)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return groupBy(users, byTeam);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.groupBy(users, byTeam);
				},
				lodash: function () {
					return lodash.groupBy(users, byTeam);
				}
			}
		};
	}),
	...sized('keyBy (objects, unique ids)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return keyBy(users, byId);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.keyBy(users, byId);
				},
				lodash: function () {
					return lodash.keyBy(users, byId);
				}
			}
		};
	}),
	...sized('countBy (objects, 20 groups)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return countBy(users, byTeam);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.countBy(users, byTeam);
				},
				lodash: function () {
					return lodash.countBy(users, byTeam);
				}
			}
		};
	}),
	...sized('partition (objects)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return partition(users, isSenior);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.partition(users, isSenior);
				},
				lodash: function () {
					return lodash.partition(users, isSenior);
				}
			}
		};
	}),
	...sized('sortBy (objects, number key)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return sortBy(users, byId);
			},
			baseline: function () {
				return users.slice().sort(function (a, b) {
					return a.id - b.id;
				});
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sortBy(users, [byId]);
				},
				lodash: function () {
					return lodash.sortBy(users, byId);
				}
			}
		};
	}),
	...sized('sortBy (objects, string key)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return sortBy(users, byName);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sortBy(users, [byName]);
				},
				lodash: function () {
					return lodash.sortBy(users, byName);
				}
			}
		};
	}),
	...sized('minBy (objects)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return minBy(users, byScore);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.minBy(users, byScore);
				},
				lodash: function () {
					return lodash.minBy(users, byScore);
				}
			}
		};
	}),
	...sized('maxBy (objects)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return maxBy(users, byScore);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.maxBy(users, byScore);
				},
				lodash: function () {
					return lodash.maxBy(users, byScore);
				}
			}
		};
	}),
	...sized('sumBy (objects, compensated)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return sumBy(users, byScore);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sumBy(users, byScore);
				},
				lodash: function () {
					return lodash.sumBy(users, byScore);
				}
			}
		};
	}),
	...sized('shuffle', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return shuffle(numbers);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.shuffle(numbers);
				},
				lodash: function () {
					return lodash.shuffle(numbers);
				}
			}
		};
	}),
	...sized('sample', [1_000], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return sample(numbers);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sample(numbers);
				},
				lodash: function () {
					return lodash.sample(numbers);
				}
			}
		};
	}),
	...sized('take (half)', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return take(numbers, n >> 1);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.take(numbers, n >> 1);
				},
				lodash: function () {
					return lodash.take(numbers, n >> 1);
				}
			}
		};
	}),
	...sized('drop (half)', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return drop(numbers, n >> 1);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.drop(numbers, n >> 1);
				},
				lodash: function () {
					return lodash.drop(numbers, n >> 1);
				}
			}
		};
	}),
	...sized('zip (2 arrays)', SIZES, function (n) {
		const numbers = integers(n, n);
		const words = numbers.map(String);
		return {
			fn: function () {
				return zip(numbers, words);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.zip(numbers, words);
				},
				lodash: function () {
					return lodash.zip(numbers, words);
				}
			}
		};
	}),
	...sized('unzip (pairs)', SIZES, function (n) {
		const pairs = integers(n, n).map(function (k) {
			return [k, String(k)];
		});
		return {
			fn: function () {
				return unzip(pairs);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.unzip(pairs);
				},
				lodash: function () {
					return lodash.unzip(pairs);
				}
			}
		};
	}),
	...sized('range', SIZES, function (n) {
		return {
			fn: function () {
				return range(n);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.range(n);
				},
				lodash: function () {
					return lodash.range(n);
				}
			}
		};
	}),
	...sized('windowed (size 3)', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return windowed(numbers, 3);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.windowed(numbers, 3);
				}
			}
		};
	}),
	...sized('differenceBy (numbers by decade)', [1_000], function (n) {
		const a = integers(n, 10 * n);
		const b = integers(n, 10 * n, 5);
		return {
			fn: function () {
				return differenceBy(a, b, decade);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.differenceBy(a, b, decade);
				},
				lodash: function () {
					return lodash.differenceBy(a, b, decade);
				}
			}
		};
	}),
	...sized('orderBy (team asc, score desc)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return orderBy(users, [byTeam, byScore], ['asc', 'desc']);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.orderBy(users, [byTeam, byScore], ['asc', 'desc']);
				},
				lodash: function () {
					return lodash.orderBy(users, [byTeam, byScore], ['asc', 'desc']);
				},
				remeda: function () {
					return remeda.sortBy(users, byTeam, [byScore, 'desc']);
				}
			}
		};
	}),
	...sized('takeFirstBy (top 10 by score)', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return takeFirstBy(users, 10, byScore, 'desc');
			},
			baseline: function () {
				return sortBy(users, byScore, 'desc').slice(0, 10);
			},
			competitors: {
				remeda: function () {
					return remeda.takeFirstBy(users, 10, [byScore, 'desc']);
				}
			}
		};
	}),
	...sized('nthBy (10th by score)', [1_000, 100_000], function (n) {
		const users = people(n);
		return {
			fn: function () {
				return nthBy(users, 9, byScore);
			},
			competitors: {
				remeda: function () {
					return remeda.nthBy(users, 9, byScore);
				}
			}
		};
	}),
	...sized('takeLast / dropLast (n = 3)', [10, 1_000], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return [takeLast(numbers, 3), dropLast(numbers, 3)];
			},
			competitors: {
				'es-toolkit': function () {
					return [toolkit.takeRight(numbers, 3), toolkit.dropRight(numbers, 3)];
				},
				lodash: function () {
					return [lodash.takeRight(numbers, 3), lodash.dropRight(numbers, 3)];
				},
				remeda: function () {
					return [remeda.takeLast(numbers, 3), remeda.dropLast(numbers, 3)];
				}
			}
		};
	}),
	...sized('takeLastWhile / dropLastWhile (seniors)', [10, 1_000], function (n) {
		const users = people(n);
		return {
			fn: function () {
				return [takeLastWhile(users, isSenior), dropLastWhile(users, isSenior)];
			},
			competitors: {
				'es-toolkit': function () {
					return [toolkit.takeRightWhile(users, isSenior), toolkit.dropRightWhile(users, isSenior)];
				},
				lodash: function () {
					return [lodash.takeRightWhile(users, isSenior), lodash.dropRightWhile(users, isSenior)];
				},
				remeda: function () {
					return [remeda.takeLastWhile(users, isSenior), remeda.dropLastWhile(users, isSenior)];
				}
			}
		};
	}),
	...sized('zipObject', [10, 1_000], function (n) {
		const keys = people(n).map(byName);
		const values = integers(n, n);
		return {
			fn: function () {
				return zipObject(keys, values);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.zipObject(keys, values);
				},
				lodash: function () {
					return lodash.zipObject(keys, values);
				},
				radash: function () {
					return radash.zipToObject(keys, values);
				}
			}
		};
	}),
	...sized('sampleSize (10 items)', SIZES, function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return sampleSize(numbers, 10);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sampleSize(numbers, Math.min(10, n));
				},
				lodash: function () {
					return lodash.sampleSize(numbers, 10);
				},
				remeda: function () {
					return remeda.sample(numbers, 10);
				}
			}
		};
	}),
	...sized('sampleSize (half)', [1_000], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return sampleSize(numbers, n / 2);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.sampleSize(numbers, n / 2);
				},
				lodash: function () {
					return lodash.sampleSize(numbers, n / 2);
				}
			}
		};
	}),
	...sized('toArray (an item, an array)', [10], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return [toArray(1), toArray(numbers)];
			},
			competitors: {
				lodash: function () {
					return [lodash.castArray(1), lodash.castArray(numbers)];
				}
			}
		};
	}),
	...sized('chunkBy (team runs)', [1_000], function (n) {
		const users = sortBy(people(n), byTeam);
		return {
			fn: function () {
				return chunkBy(users, byTeam);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.chunkBy(users, byTeam);
				}
			}
		};
	}),
	...sized('splitWhen', [10, 1_000], function (n) {
		const users = people(n);
		return {
			fn: function () {
				return splitWhen(users, isSenior);
			},
			competitors: {
				remeda: function () {
					return remeda.splitWhen(users, isSenior);
				}
			}
		};
	}),
	...sized('unionBy (records by id)', [10, 1_000], function (n) {
		const a = people(n);
		const b = people(n).slice(n / 2);
		return {
			fn: function () {
				return unionBy(a, b, byId);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.unionBy(a, b, byId);
				},
				lodash: function () {
					return lodash.unionBy(a, b, byId);
				}
			}
		};
	}),
	...sized('symmetricDifferenceBy (numbers by decade)', [10, 1_000], function (n) {
		const a = integers(n, 10 * n);
		const b = integers(n, 10 * n, 5);
		return {
			fn: function () {
				return symmetricDifferenceBy(a, b, decade);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.xorBy(a, b, decade);
				},
				lodash: function () {
					return lodash.xorBy(a, b, decade);
				}
			}
		};
	}),
	...sized('differenceWith / intersectionWith (records)', [10, 300], function (n) {
		const a = people(n);
		const b = people(n).slice(n / 2);
		return {
			fn: function () {
				return [differenceWith(a, b, sameId), intersectionWith(a, b, sameId)];
			},
			competitors: {
				'es-toolkit': function () {
					return [toolkit.differenceWith(a, b, sameId), toolkit.intersectionWith(a, b, sameId)];
				},
				lodash: function () {
					return [lodash.differenceWith(a, b, sameId), lodash.intersectionWith(a, b, sameId)];
				},
				remeda: function () {
					return [remeda.differenceWith(a, b, sameId), remeda.intersectionWith(a, b, sameId)];
				}
			}
		};
	}),
	...sized('uniqueWith / unionWith (records)', [10, 300], function (n) {
		const a = people(n).concat(people(n / 2));
		const b = people(n).slice(n / 2);
		return {
			fn: function () {
				return [uniqueWith(a, sameId), unionWith(a, b, sameId)];
			},
			competitors: {
				'es-toolkit': function () {
					return [toolkit.uniqWith(a, sameId), toolkit.unionWith(a, b, sameId)];
				},
				lodash: function () {
					return [lodash.uniqWith(a, sameId), lodash.unionWith(a, b, sameId)];
				}
			}
		};
	}),
	...sized('toggle', [10, 1_000], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return [toggle(numbers, numbers[n >> 1]), toggle(numbers, -1)];
			},
			competitors: {
				radash: function () {
					return [radash.toggle(numbers, numbers[n >> 1]), radash.toggle(numbers, -1)];
				}
			}
		};
	}),
	...sized('averageBy', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return averageBy(users, byScore);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.meanBy(users, byScore);
				},
				lodash: function () {
					return lodash.meanBy(users, byScore);
				},
				remeda: function () {
					return remeda.meanBy(users, byScore);
				}
			}
		};
	}),
	...sized('medianBy', SIZES, function (n) {
		const users = people(n);
		return {
			fn: function () {
				return medianBy(users, byScore);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.medianBy(users, byScore);
				}
			}
		};
	}),
	{
		name: 'combinations (20 choose 3)',
		fn: function () {
			return combinations(LETTERS, 3);
		},
		competitors: {
			'es-toolkit': function () {
				return toolkit.combinations(LETTERS, 3);
			}
		}
	},
	{
		name: 'permutations (7 items)',
		fn: function () {
			return permutations(LETTERS.slice(0, 7));
		}
	},
	{
		name: 'powerSet (12 items)',
		fn: function () {
			return powerSet(LETTERS.slice(0, 12));
		}
	},
	...sized('zipWith (2 arrays)', [10, 1_000], function (n) {
		const a = integers(n, n);
		const b = integers(n, n, 3);
		return {
			fn: function () {
				return zipWith(add, a, b);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.zipWith(a, b, add);
				},
				lodash: function () {
					return lodash.zipWith(a, b, add);
				},
				remeda: function () {
					return remeda.zipWith(a, b, add);
				}
			}
		};
	}),
	...sized('zipWith (3 arrays)', [1_000], function (n) {
		const a = integers(n, n);
		const b = integers(n, n, 3);
		const c = integers(n, n, 7);
		return {
			fn: function () {
				return zipWith(add, a, b, c);
			},
			competitors: {
				'es-toolkit': function () {
					return toolkit.zipWith(a, b, c, add);
				},
				lodash: function () {
					return lodash.zipWith(a, b, c, add);
				}
			}
		};
	}),
	...sized('swap / rotate', [10, 1_000], function (n) {
		const numbers = integers(n, n);
		return {
			fn: function () {
				return [swap(numbers, 1, -2), rotate(numbers, 3)];
			},
			competitors: {
				'remeda + radash': function () {
					return [remeda.swapIndices(numbers, 1, -2), radash.shift(numbers, 3)];
				}
			}
		};
	}),
	...sized('sortedLastIndex', [1_000, 100_000], function (n) {
		const sorted = range(n).map(function (value) {
			return value - (value % 4);
		});
		const value = sorted[n >> 1];
		return {
			fn: function () {
				return sortedLastIndex(sorted, value);
			},
			competitors: {
				lodash: function () {
					return lodash.sortedLastIndex(sorted, value);
				},
				remeda: function () {
					return remeda.sortedLastIndex(sorted, value);
				}
			}
		};
	}),
	...sized('sortedIndexBy (records by score)', [1_000, 100_000], function (n) {
		const sorted = sortBy(people(n), byScore);
		const value = sorted[n >> 1];
		return {
			fn: function () {
				return sortedIndexBy(sorted, value, byScore);
			},
			competitors: {
				lodash: function () {
					return lodash.sortedIndexBy(sorted, value, byScore);
				},
				remeda: function () {
					return remeda.sortedIndexBy(sorted, value, byScore);
				}
			}
		};
	})
];
