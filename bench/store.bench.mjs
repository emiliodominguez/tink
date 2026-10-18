import { createStore } from 'tinkjs/store';

/**
 * A minimal hand-written store (no re-entrancy queue, no error isolation, no selectors): the theoretical best for setState + notify.
 * @param {unknown} initial - The initial state
 * @returns {{ getState(): unknown, setState(next: unknown): void, subscribe(listener: () => void): () => void }} The store
 */
function minimalStore(initial) {
	let state = initial;
	const listeners = new Set();
	return {
		getState: function () {
			return state;
		},
		setState: function (next) {
			const value = typeof next === 'function' ? next(state) : next;
			if (Object.is(value, state)) return;
			state = value;
			for (const listener of listeners) listener();
		},
		subscribe: function (listener) {
			listeners.add(listener);
			return function () {
				listeners.delete(listener);
			};
		}
	};
}

/**
 * Builds a store with `count` selectors (each subscribed once) over a `{ counter, items }` state.
 * @param {number} count - Number of `select()` subscribers
 * @returns {object} The store
 */
function setup(count) {
	const store = createStore({ counter: 0, items: [] });
	let seen = 0;
	for (let i = 0; i < count; i++) {
		const selected = store.select(function (state) {
			return i % 2 === 0 ? state.counter : state.items;
		});
		selected.subscribe(function () {
			seen += 1;
		});
	}
	store.subscribe(function () {
		seen += 1;
	});
	return store;
}

let calls = 0;

/**
 * A listener that counts its calls.
 * @returns {void}
 */
function listener() {
	calls++;
}

const plain = createStore(0);
plain.subscribe(listener);
const minimal = minimalStore(0);
minimal.subscribe(listener);
const plainTen = createStore(0);
const minimalTen = minimalStore(0);
for (let i = 0; i < 10; i++) {
	plainTen.subscribe(function () {
		calls += i;
	});
	minimalTen.subscribe(function () {
		calls += i;
	});
}
const selected = setup(20);
const handlers = Array.from({ length: 20 }, function (_, index) {
	return function () {
		calls += index;
	};
});

/**
 * Increments the counter.
 * @param {{ counter: number, items: unknown[] }} state - The previous state
 * @returns {{ counter: number, items: unknown[] }} The next state
 */
function increment(state) {
	return { counter: state.counter + 1, items: state.items };
}

export default [
	{
		name: 'setState (1 listener)',
		fn: function () {
			for (let i = 0; i < 100; i++) plain.setState(i % 2);
			return plain.getState() + calls;
		},
		competitors: {
			'minimal store': function () {
				for (let i = 0; i < 100; i++) minimal.setState(i % 2);
				return minimal.getState() + calls;
			}
		}
	},
	{
		name: 'setState (10 listeners)',
		fn: function () {
			for (let i = 0; i < 100; i++) plainTen.setState(i % 2);
			return plainTen.getState() + calls;
		},
		competitors: {
			'minimal store': function () {
				for (let i = 0; i < 100; i++) minimalTen.setState(i % 2);
				return minimalTen.getState() + calls;
			}
		}
	},
	{
		name: 'setState unchanged (no notification)',
		fn: function () {
			for (let i = 0; i < 100; i++) plain.setState(1);
			return plain.getState();
		},
		competitors: {
			'minimal store': function () {
				for (let i = 0; i < 100; i++) minimal.setState(1);
				return minimal.getState();
			}
		}
	},
	{
		name: 'setState (20 select() subscribers)',
		fn: function () {
			for (let i = 0; i < 100; i++) selected.setState(increment);
			return selected.getState();
		}
	},
	{
		name: 'select().getState() (cached)',
		fn: function () {
			const counter = selected.select(function (state) {
				return state.counter;
			});
			let total = 0;
			for (let i = 0; i < 100; i++) total += counter.getState();
			return total;
		}
	},
	{
		name: 'subscribe + unsubscribe (20 listeners)',
		fn: function () {
			const stops = [];
			for (let i = 0; i < 20; i++) stops.push(plainTen.subscribe(handlers[i]));
			for (let i = 0; i < 20; i++) stops[i]();
			return stops;
		},
		competitors: {
			'minimal store': function () {
				const stops = [];
				for (let i = 0; i < 20; i++) stops.push(minimalTen.subscribe(handlers[i]));
				for (let i = 0; i < 20; i++) stops[i]();
				return stops;
			}
		}
	}
];
