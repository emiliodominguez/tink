import { createEmitter } from '@emiliodominguez/tink/emitter';
import mitt from 'mitt';

/**
 * Builds an emitter with `count` listeners on `tick` that sum the payloads they receive.
 * @param {() => { on: Function, emit: Function }} create - Emitter factory (ours or mitt)
 * @param {number} count - Number of listeners
 * @param {boolean} wildcard - Whether to add a wildcard listener too
 * @returns {{ emitter: object, totals: number[] }} The emitter and the shared accumulator
 */
function setup(create, count, wildcard) {
	const emitter = create();
	const totals = [0];
	for (let i = 0; i < count; i++) {
		emitter.on('tick', function (n) {
			totals[0] += n;
		});
	}
	if (wildcard) {
		emitter.on('*', function (_event, n) {
			totals[0] -= n;
		});
	}
	return { emitter, totals };
}

const one = setup(createEmitter, 1, false);
const ten = setup(createEmitter, 10, false);
const hundred = setup(createEmitter, 100, false);
const withWildcard = setup(createEmitter, 10, true);
const empty = setup(createEmitter, 0, false);
const mittOne = setup(mitt, 1, false);
const mittTen = setup(mitt, 10, false);
const mittHundred = setup(mitt, 100, false);
const mittWildcard = setup(mitt, 10, true);
const mittEmpty = setup(mitt, 0, false);
const churn = createEmitter();
const mittChurn = mitt();
const handlers = Array.from({ length: 20 }, function (_, index) {
	return function () {
		return index;
	};
});

export default [
	{
		name: 'emit (1 listener)',
		fn: function () {
			for (let i = 0; i < 100; i++) one.emitter.emit('tick', i);
			return one.totals[0];
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 100; i++) mittOne.emitter.emit('tick', i);
				return mittOne.totals[0];
			}
		}
	},
	{
		name: 'emit (10 listeners)',
		fn: function () {
			for (let i = 0; i < 100; i++) ten.emitter.emit('tick', i);
			return ten.totals[0];
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 100; i++) mittTen.emitter.emit('tick', i);
				return mittTen.totals[0];
			}
		}
	},
	{
		name: 'emit (100 listeners)',
		fn: function () {
			for (let i = 0; i < 100; i++) hundred.emitter.emit('tick', i);
			return hundred.totals[0];
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 100; i++) mittHundred.emitter.emit('tick', i);
				return mittHundred.totals[0];
			}
		}
	},
	{
		name: 'emit (10 listeners + wildcard)',
		fn: function () {
			for (let i = 0; i < 100; i++) withWildcard.emitter.emit('tick', i);
			return withWildcard.totals[0];
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 100; i++) mittWildcard.emitter.emit('tick', i);
				return mittWildcard.totals[0];
			}
		}
	},
	{
		name: 'emit (no listener)',
		fn: function () {
			for (let i = 0; i < 100; i++) empty.emitter.emit('tick', i);
			return empty.totals[0];
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 100; i++) mittEmpty.emitter.emit('tick', i);
				return mittEmpty.totals[0];
			}
		}
	},
	{
		name: 'on + unsubscribe (20 listeners)',
		fn: function () {
			const stops = [];
			for (let i = 0; i < 20; i++) stops.push(churn.on('tick', handlers[i]));
			for (let i = 0; i < 20; i++) stops[i]();
			return churn.listenerCount();
		}
	},
	{
		name: 'on + off (20 listeners, LIFO)',
		fn: function () {
			for (let i = 0; i < 20; i++) churn.on('tick', handlers[i]);
			for (let i = 19; i >= 0; i--) churn.off('tick', handlers[i]);
			return churn;
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 20; i++) mittChurn.on('tick', handlers[i]);
				for (let i = 19; i >= 0; i--) mittChurn.off('tick', handlers[i]);
				return mittChurn;
			}
		}
	},
	{
		name: 'on + off (20 listeners, FIFO)',
		fn: function () {
			for (let i = 0; i < 20; i++) churn.on('tick', handlers[i]);
			for (let i = 0; i < 20; i++) churn.off('tick', handlers[i]);
			return churn;
		},
		competitors: {
			mitt: function () {
				for (let i = 0; i < 20; i++) mittChurn.on('tick', handlers[i]);
				for (let i = 0; i < 20; i++) mittChurn.off('tick', handlers[i]);
				return mittChurn;
			}
		}
	}
];
