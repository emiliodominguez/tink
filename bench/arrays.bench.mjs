import {
	chunk,
	compact,
	countBy,
	difference,
	differenceBy,
	drop,
	flatten,
	flattenDeep,
	groupBy,
	intersection,
	intersectionBy,
	isSubset,
	keyBy,
	maxBy,
	minBy,
	partition,
	range,
	removeDuplicates,
	sample,
	shuffle,
	sortBy,
	sumBy,
	symmetricDifference,
	take,
	union,
	uniqueBy,
	unzip,
	windowed,
	zip
} from '@emiliodominguez/tink/arrays';
import * as toolkit from 'es-toolkit';
import * as lodash from 'lodash-es';

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
	})
];
