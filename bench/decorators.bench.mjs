import { lazy, measure } from 'tinkit/decorators';

/**
 * Applies a legacy (TypeScript `experimentalDecorators`) member decorator by hand, as the compiled `__decorate` helper does.
 * @param {Function} decorator - The decorator
 * @param {object} target - The prototype (or class)
 * @param {string} key - The member name
 * @returns {void}
 */
function decorate(decorator, target, key) {
	Object.defineProperty(target, key, decorator(target, key, Object.getOwnPropertyDescriptor(target, key)));
}

/** A class with a plain field and a plain getter, the baselines. */
class Plain {
	constructor() {
		this.field = 42;
	}

	/**
	 * Computes the value on every read.
	 * @returns {number} 42
	 */
	get computed() {
		return 42;
	}

	/**
	 * A cheap method, the baseline of `@measure`.
	 * @param {number} n - A number
	 * @returns {number} `n + 1`
	 */
	work(n) {
		return n + 1;
	}
}

/** A class with a `@lazy` getter and a `@measure`d method. */
class Decorated {
	constructor() {
		this.field = 42;
	}

	/**
	 * Computed once per instance.
	 * @returns {number} 42
	 */
	get value() {
		return 42;
	}

	/**
	 * A cheap method.
	 * @param {number} n - A number
	 * @returns {number} `n + 1`
	 */
	work(n) {
		return n + 1;
	}
}
decorate(lazy, Decorated.prototype, 'value');
decorate(
	measure({
		onMeasure: function () {
			// Measured, not reported: the bench times the wrapper.
		}
	}),
	Decorated.prototype,
	'work'
);

/** A hand-written lazy getter caching in a `WeakMap` (what `@lazy` falls back to on frozen instances). */
const weakValues = new WeakMap();
/** A class with a hand-written `WeakMap`-backed lazy getter. */
class WeakMapLazy {
	/**
	 * Computed once per instance, kept in a `WeakMap`.
	 * @returns {number} 42
	 */
	get value() {
		let value = weakValues.get(this);
		if (value === undefined) {
			value = 42;
			weakValues.set(this, value);
		}
		return value;
	}
}

const plain = new Plain();
const decorated = new Decorated();
const frozen = Object.freeze(new Decorated());
const weakMapLazy = new WeakMapLazy();
// Warm the caches: the steady-state reads below never compute.
void [decorated.value, frozen.value, weakMapLazy.value];

export default [
	{
		name: '@lazy steady-state read (x100)',
		fn: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += decorated.value;
			return total;
		},
		baseline: function () {
			let total = 0;
			for (let i = 0; i < 100; i++) total += plain.field;
			return total;
		},
		competitors: {
			'plain getter': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += plain.computed;
				return total;
			},
			'WeakMap getter': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += weakMapLazy.value;
				return total;
			},
			'@lazy on a frozen instance (WeakMap)': function () {
				let total = 0;
				for (let i = 0; i < 100; i++) total += frozen.value;
				return total;
			}
		}
	},
	{
		name: '@lazy first read (new instance)',
		fn: function () {
			return new Decorated().value;
		},
		baseline: function () {
			return new Plain().computed;
		}
	},
	{
		name: '@measure sync call',
		fn: function () {
			return decorated.work(1);
		},
		baseline: function () {
			return plain.work(1);
		}
	}
];
