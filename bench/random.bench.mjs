import { shuffle as esShuffle } from 'es-toolkit';
import { customAlphabet, nanoid } from 'nanoid';
import { createRandom, randomBytes, randomGaussian, randomId, randomUUID, weightedRandom } from 'tinkit/random';

const rng = createRandom('bench');
const items = Array.from({ length: 100 }, function (_, index) {
	return index;
});
const weights = items.map(function (index) {
	return (index % 7) + 1;
});
const nanoidDigits = customAlphabet('0123456789', 16);

/**
 * The theoretical best for a seeded generator: a bare sfc32 closure seeded through cyrb128, exactly the algorithms
 * `createRandom` uses, without validation, methods or a frozen object.
 * @param {string} seed - The seed string
 * @returns {() => number} A generator of floats in `[0, 1)`
 */
function plainSfc32(seed) {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < seed.length; i++) {
		const k = seed.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= h2 ^ h3 ^ h4;
	let a = h1 | 0;
	let b = (h2 ^ h1) | 0;
	let c = (h3 ^ h1) | 0;
	let d = (h4 ^ h1) | 0;
	/**
	 * One sfc32 step.
	 * @returns {number} A float in `[0, 1)`
	 */
	function next() {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	}
	for (let i = 0; i < 15; i++) next();
	return next;
}

/**
 * A bare mulberry32 generator (the other popular "fast seeded PRNG" one-liner).
 * @param {number} seed - A 32-bit seed
 * @returns {() => number} A generator of floats in `[0, 1)`
 */
function mulberry32(seed) {
	let state = seed | 0;
	return function () {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const plain = plainSfc32('bench');
const mulberry = mulberry32(42);

export default [
	{
		name: 'createRandom (seed string)',
		fn: function () {
			return createRandom('a reasonably long seed string');
		},
		competitors: {
			'plain sfc32': function () {
				return plainSfc32('a reasonably long seed string');
			}
		}
	},
	{
		name: 'rng() (1000 floats)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += rng();
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += Math.random();
			return total;
		},
		competitors: {
			'plain sfc32': function () {
				let total = 0;
				for (let i = 0; i < 1000; i++) total += plain();
				return total;
			},
			mulberry32: function () {
				let total = 0;
				for (let i = 0; i < 1000; i++) total += mulberry();
				return total;
			}
		}
	},
	{
		name: 'rng.int(1, 100) (1000 draws)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += rng.int(1, 100);
			return total;
		},
		competitors: {
			// Biased (no rejection sampling), the usual hand-written way.
			'plain sfc32 floor': function () {
				let total = 0;
				for (let i = 0; i < 1000; i++) total += 1 + Math.floor(plain() * 100);
				return total;
			}
		}
	},
	{
		name: 'rng.float(-5, 5) (1000 draws)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += rng.float(-5, 5);
			return total;
		},
		competitors: {
			'plain sfc32': function () {
				let total = 0;
				for (let i = 0; i < 1000; i++) total += -5 + plain() * 10;
				return total;
			}
		}
	},
	{
		name: 'rng.shuffle (100 items)',
		fn: function () {
			return rng.shuffle(items);
		},
		competitors: {
			// es-toolkit shuffles with Math.random (it accepts no generator).
			'es-toolkit (Math.random)': function () {
				return esShuffle(items);
			}
		}
	},
	{
		name: 'weightedRandom (100 items)',
		fn: function () {
			return weightedRandom(items, weights, rng);
		}
	},
	{
		name: 'randomGaussian (1000 draws)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 1000; i++) total += randomGaussian(0, 1, rng);
			return total;
		}
	},
	{
		name: 'randomId() (21 chars, 64-char alphabet)',
		fn: function () {
			return randomId();
		},
		competitors: {
			nanoid: function () {
				return nanoid();
			}
		}
	},
	{
		name: 'randomId(16, digits)',
		fn: function () {
			return randomId(16, '0123456789');
		},
		competitors: {
			'nanoid customAlphabet': function () {
				return nanoidDigits();
			}
		}
	},
	{
		name: 'randomId(1000)',
		fn: function () {
			return randomId(1000);
		},
		competitors: {
			nanoid: function () {
				return nanoid(1000);
			}
		}
	},
	{
		name: 'randomUUID()',
		fn: function () {
			return randomUUID();
		},
		competitors: {
			'crypto.randomUUID': function () {
				return globalThis.crypto.randomUUID();
			}
		}
	},
	{
		name: 'randomBytes(32)',
		fn: function () {
			return randomBytes(32);
		},
		competitors: {
			'crypto.getRandomValues': function () {
				return globalThis.crypto.getRandomValues(new Uint8Array(32));
			}
		}
	}
];
