import { setFlagsFromString } from 'node:v8';
import * as vm from 'vm';
import { AbortError, TimeoutError } from '../async/index.js';
import type { AbortSignalLike } from '../utils/index.js';
import { createEmitter, type EmitArgs, type Emitter, type EventHandler, type Unsubscribe, type WildcardHandler } from '.';

interface TestEvents {
	ready: void;
	done: undefined;
	maybe: number | undefined;
	message: { text: string };
	count: number;
	[key: symbol]: string;
}

/**
 * A promise state probe that does not depend on timers.
 */
async function stateOf(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
	const marker = {};
	try {
		const winner = await Promise.race([promise, Promise.resolve(marker)]);
		return winner === marker ? 'pending' : 'fulfilled';
	} catch {
		return 'rejected';
	}
}

/**
 * A manually controlled abort signal that counts its listeners.
 */
function createSignal(): AbortSignalLike & { abort(reason?: unknown): void; listeners: number } {
	const listeners = new Set<() => void>();
	const signal = {
		aborted: false,
		reason: undefined as unknown,
		get listeners() {
			return listeners.size;
		},
		addEventListener(type: 'abort', listener: () => void) {
			if (type === 'abort') listeners.add(listener);
		},
		removeEventListener(type: 'abort', listener: () => void) {
			if (type === 'abort') listeners.delete(listener);
		},
		abort(reason?: unknown) {
			signal.aborted = true;
			signal.reason = reason;
			for (const listener of [...listeners]) listener();
			listeners.clear();
		}
	};
	return signal;
}

describe('createEmitter', function () {
	describe('types', function () {
		it('calls "*" listeners with (event, payload), also when an index signature makes "*" a key', function () {
			const counts = createEmitter<Record<string, number>>();
			const received: unknown[][] = [];
			// With an index signature, these payload handlers type-check (see WildcardHandler), yet receive the event name first.
			counts.on('*', function (n: number) {
				received.push([n]);
			});
			counts.once('*', function (n: number) {
				received.push([n]);
			});
			counts.on('*', function (event, payload) {
				const name: string = event;
				const value: number = payload;
				received.push([name, value]);
			});
			counts.on('count', function (n) {
				// The payload is still inferred for other events.
				received.push([n.toFixed(0)]);
			});
			counts.emit('count', 1);
			expect(received).toEqual([['1'], ['count'], ['count'], ['count', 1]]);
		});

		it('accepts wrappers generic over the event map', function () {
			class Bus<M extends Record<string, unknown>> {
				private readonly events = createEmitter<M>();
				on<K extends keyof M>(event: K, handler: EventHandler<M[K]>): Unsubscribe {
					return this.events.on(event, handler);
				}
				off<K extends keyof M>(event: K, handler: EventHandler<M[K]>): boolean {
					return this.events.off(event, handler);
				}
				emit<K extends keyof M>(event: K, payload: M[K]): void {
					(this.events.emit as (event: K, payload: M[K]) => void)(event, payload);
				}
			}
			const bus = new Bus<{ saved: number }>();
			const seen: number[] = [];
			function onSaved(id: number): void {
				seen.push(id);
			}
			bus.on('saved', onSaved);
			bus.emit('saved', 7);
			expect([seen, bus.off('saved', onSaved)]).toEqual([[7], true]);
		});

		it('types handlers of union and generic event names after their payloads', function () {
			const events = createEmitter<{ message: { text: string }; flag: boolean }>();
			const received: unknown[] = [];
			const name = 'flag' as 'message' | 'flag';
			// @ts-expect-error a union name may carry a `message` payload
			events.on(name, function (_value: boolean) {});
			events.on(name, function (payload) {
				const value: boolean | { text: string } = payload;
				received.push(value);
			});
			function subscribe<K extends 'message' | 'flag'>(event: K, handler: EventHandler<{ message: { text: string }; flag: boolean }[K]>): Unsubscribe {
				return events.on(event, handler);
			}
			function relay<M extends { count: number }>(emitter: Emitter<M>): Unsubscribe {
				return emitter.on('count', function (count) {
					received.push(count.toFixed(1));
				});
			}
			subscribe('message', function (message) {
				received.push(message.text);
			});
			const counts = createEmitter<{ count: number }>();
			relay(counts);
			events.emit('flag', true);
			events.emit('message', { text: 'hi' });
			counts.emit('count', 2);
			expect(received).toEqual([true, 'hi', '2.0']);
		});

		it('types payloads, optional payloads and wildcard handlers', function () {
			const events = createEmitter<TestEvents>();

			events.emit('ready');
			events.emit('ready', undefined);
			events.emit('done');
			events.emit('maybe');
			events.emit('maybe', 3);
			events.emit('message', { text: 'hi' });
			events.emit(Symbol.for('x'), 'symbol payload');

			// @ts-expect-error payload required
			events.emit('message');
			// @ts-expect-error wrong payload type
			events.emit('count', 'one');
			// @ts-expect-error unknown event
			events.emit('nope');
			// @ts-expect-error void events take no meaningful payload
			events.emit('ready', 1);

			events.on('message', function (msg) {
				const text: string = msg.text;
				return text;
			});
			// @ts-expect-error handler payload type mismatch
			events.on('count', function (value: string) {
				return value;
			});
			events.on('*', function (event, payload) {
				if (event === 'count') {
					const n: number = payload;
					return n;
				}
				if (event === 'message') {
					const text: string = payload.text;
					return text;
				}
				return undefined;
			});
			// @ts-expect-error wildcard handlers receive the event first
			events.on('*', function (payload: { text: string }) {
				return payload;
			});

			const waited: Promise<{ text: string }> = events.waitFor('message', {
				filter: function (msg) {
					return msg.text.length > 0;
				}
			});
			void waited.catch(function () {});
			events.clear();

			type A = EmitArgs<void>;
			type B = EmitArgs<number>;
			const a: A = [];
			const b: B = [1];
			// @ts-expect-error payload required
			const c: B = [];
			type W = Parameters<WildcardHandler<{ a: number; b: string }>>;
			const w: W = ['a', 1];
			// @ts-expect-error mismatched pair
			const w2: W = ['a', 'x'];
			expect([a, b, w]).toEqual([[], [1], ['a', 1]]);
			const e: Emitter<{ a: number }> = createEmitter<{ a: number }>();
			expect(e.listenerCount()).toBe(0);
		});

		it('types wildcard handlers of event maps with optional events', function () {
			interface Optional {
				a: number;
				b?: string;
			}
			const events = createEmitter<Optional>();
			const seen: unknown[] = [];

			events.on('*', function (event, payload) {
				if (event === 'a') {
					const n: number = payload;
					seen.push(n);
				} else {
					const text: string | undefined = payload;
					seen.push(text);
				}
			});
			events.emit('a', 1);
			events.emit('b');
			type W = Parameters<WildcardHandler<Optional>>;
			const w: W = ['b', undefined];
			// @ts-expect-error mismatched pair
			const w2: W = ['a', 'x'];

			expect(seen).toEqual([1, undefined]);
			expect([w, w2]).toEqual([
				['b', undefined],
				['a', 'x']
			]);
		});
	});

	describe('on / emit', function () {
		it('calls handlers in registration order with the payload', function () {
			const events = createEmitter<TestEvents>();
			const calls: string[] = [];

			events.on('count', function (n) {
				calls.push(`a${n}`);
			});
			events.on('count', function (n) {
				calls.push(`b${n}`);
			});
			events.emit('count', 1);
			events.emit('count', 2);

			expect(calls).toEqual(['a1', 'b1', 'a2', 'b2']);
		});

		it('passes exactly the given payload argument (none when omitted) and ignores extra arguments', function () {
			const events = createEmitter<TestEvents>();
			const handler = jest.fn();

			events.on('ready', handler);
			events.emit('ready');
			(events.emit as any)('ready', 1, 2);

			events.emit('ready', undefined);

			expect(handler.mock.calls).toEqual([[], [1], [undefined]]);
			// `toEqual` does not tell `[]` from `[undefined]`: check the argument counts too.
			expect(
				handler.mock.calls.map(function (call) {
					return call.length;
				})
			).toEqual([0, 1, 1]);
		});

		it('emitting an event without listeners is a no-op', function () {
			const events = createEmitter<TestEvents>();
			expect(function () {
				events.emit('count', 1);
			}).not.toThrow();
		});

		it('supports symbol, numeric and unicode event names', function () {
			const sym = Symbol('s');
			const events = createEmitter<{ [sym]: string; 0: number; 'café ☕': boolean }>();
			const calls: unknown[] = [];

			events.on(sym, function (v) {
				calls.push(v);
			});
			events.on(0, function (v) {
				calls.push(v);
			});
			events.on('café ☕', function (v) {
				calls.push(v);
			});
			events.emit(sym, 's');
			events.emit(0, 1);
			events.emit('café ☕', true);

			expect(calls).toEqual(['s', 1, true]);
		});

		it('calls a handler registered twice twice, and its unsubscribe removes only its own registration', function () {
			const events = createEmitter<TestEvents>();
			const handler = jest.fn();

			const first = events.on('count', handler);
			events.on('count', handler);
			events.emit('count', 1);
			expect(handler).toHaveBeenCalledTimes(2);

			first();
			first();
			expect(events.listenerCount('count')).toBe(1);
			events.emit('count', 2);
			expect(handler).toHaveBeenCalledTimes(3);
		});

		it('does not call handlers added during an emit for that emit', function () {
			const events = createEmitter<TestEvents>();
			const late = jest.fn();
			const lateWildcard = jest.fn();

			events.on('count', function () {
				events.on('count', late);
				events.on('*', lateWildcard);
			});
			events.emit('count', 1);
			expect(late).not.toHaveBeenCalled();
			expect(lateWildcard).not.toHaveBeenCalled();

			events.emit('count', 2);
			expect(late).toHaveBeenCalledWith(2);
		});

		it('snapshots existing listener lists too (no in-place mutation during an emit)', function () {
			const events = createEmitter<TestEvents>();
			const calls: string[] = [];

			events.on('*', function () {
				calls.push('wildcard');
			});
			events.on('count', function () {
				calls.push('count');
				events.on('count', function () {
					calls.push('late count');
				});
				events.on('*', function () {
					calls.push('late wildcard');
				});
			});
			events.emit('count', 1);
			expect(calls).toEqual(['count', 'wildcard']);
			expect(events.listenerCount('count')).toBe(2);
			expect(events.listenerCount('*')).toBe(2);
		});

		it('keeps an emit snapshot intact when every listener is removed and new ones are added meanwhile', function () {
			const events = createEmitter<TestEvents>();
			const calls: string[] = [];

			events.on('count', function () {
				calls.push('first');
				events.clear();
				events.on('count', function () {
					calls.push('new');
				});
			});
			events.on('count', function () {
				calls.push('second');
			});
			events.emit('count', 1);
			events.emit('count', 2);
			expect(calls).toEqual(['first', 'new']);
		});

		it('skips handlers removed during an emit that have not run yet', function () {
			const events = createEmitter<TestEvents>();
			const second = jest.fn();
			const wildcard = jest.fn();
			const handles: { stopSecond?: () => void } = {};

			events.on('count', function () {
				handles.stopSecond?.();
				events.off('*', wildcard);
			});
			handles.stopSecond = events.on('count', second);
			events.on('*', wildcard);
			events.emit('count', 1);

			expect(second).not.toHaveBeenCalled();
			expect(wildcard).not.toHaveBeenCalled();
		});

		it('skips pending handlers after clear() during an emit', function () {
			const events = createEmitter<TestEvents>();
			const second = jest.fn();

			events.on('count', function () {
				events.clear();
			});
			events.on('count', second);
			events.emit('count', 1);

			expect(second).not.toHaveBeenCalled();
			expect(events.listenerCount()).toBe(0);
		});

		it('runs nested emits depth first', function () {
			const events = createEmitter<TestEvents>();
			const calls: string[] = [];

			events.on('count', function (n) {
				calls.push(`count${n}`);
				if (n === 1) events.emit('message', { text: 'nested' });
				calls.push(`after${n}`);
			});
			events.on('message', function (msg) {
				calls.push(msg.text);
			});
			events.emit('count', 1);

			expect(calls).toEqual(['count1', 'nested', 'after1']);
		});

		it('calls every handler and rethrows a single error', function () {
			const events = createEmitter<TestEvents>();
			const boom = new Error('boom');
			const after = jest.fn();

			events.on('count', function () {
				throw boom;
			});
			events.on('count', after);
			events.on('*', after);

			expect(function () {
				events.emit('count', 1);
			}).toThrow(boom);
			expect(after).toHaveBeenCalledTimes(2);
		});

		it('throws an AggregateError holding every error in call order when several handlers throw', function () {
			const events = createEmitter<TestEvents>();
			const e1 = new Error('1');
			const e2 = new Error('2');

			events.on('count', function () {
				throw e1;
			});
			events.on('*', function () {
				throw e2;
			});

			let caught: unknown;
			try {
				events.emit('count', 1);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AggregateError);
			expect((caught as AggregateError).errors).toEqual([e1, e2]);
			expect((caught as AggregateError).message).toBe('emit: 2 listeners of count threw');
		});

		it('does not depend on `this`', function () {
			const { on, emit, listenerCount } = createEmitter<TestEvents>();
			const handler = jest.fn();

			on('count', handler);
			emit('count', 5);
			expect(handler).toHaveBeenCalledWith(5);
			expect(listenerCount()).toBe(1);
		});

		it('calls listeners without a receiver (not with an internal record they could change)', function () {
			const events = createEmitter<TestEvents>();
			const receivers: unknown[] = [];

			events.on('count', function (this: unknown) {
				receivers.push(this);
			});
			events.on('*', function (this: unknown) {
				receivers.push(this);
			});
			events.emit('count', 1);
			expect(receivers).toEqual([undefined, undefined]);
		});

		it('handles thousands of once listeners and unsubscriptions, also during an emit', function () {
			const events = createEmitter<TestEvents>();
			const calls: number[] = [];
			const stops: Array<() => void> = [];

			for (let i = 0; i < 5000; i++) {
				events.once('count', function () {
					calls.push(i);
				});
			}
			// Unsubscribes every other listener of 'maybe' while 'count' is being emitted.
			for (let i = 0; i < 5000; i++) stops.push(events.on('maybe', jest.fn()));
			events.on('*', function () {
				for (let i = 0; i < stops.length; i += 2) stops[i]();
			});
			events.emit('count', 1);
			events.emit('count', 2);

			expect(calls).toHaveLength(5000);
			expect(calls[4999]).toBe(4999);
			expect(events.listenerCount('count')).toBe(0);
			expect(events.listenerCount('maybe')).toBe(2500);
			for (const stop of stops) stop();
			expect(events.listenerCount()).toBe(1);
		});

		it('rejects non-function handlers and emitting the wildcard', function () {
			const events = createEmitter<TestEvents>();

			expect(function () {
				events.on('count', null as any);
			}).toThrow(new TypeError('on: `handler` must be a function, got null'));
			expect(function () {
				events.once('count', 'x' as any);
			}).toThrow(new TypeError('once: `handler` must be a function, got string'));
			expect(function () {
				events.off('count', 1 as any);
			}).toThrow(new TypeError('off: `handler` must be a function, got number'));
			expect(function () {
				(events.emit as any)('*');
			}).toThrow(new RangeError("emit: `event` must not be '*' (reserved for wildcard listeners), got '*'"));
		});
	});

	describe('wildcard', function () {
		it('receives every event with its name, after the specific handlers', function () {
			const events = createEmitter<TestEvents>();
			const calls: unknown[][] = [];

			events.on('*', function (event, payload) {
				calls.push(['*', event, payload]);
			});
			events.on('count', function (n) {
				calls.push(['count', n]);
			});
			events.emit('count', 1);
			events.emit('ready');

			expect(calls).toEqual([
				['count', 1],
				['*', 'count', 1],
				['*', 'ready', undefined]
			]);
		});

		it('passes undefined for an event emitted without payload, not a value planted on Object.prototype', function () {
			const events = createEmitter<TestEvents>();
			const proto = Object.prototype as Record<string, unknown>;
			const calls: unknown[][] = [];

			events.on('*', function (event, payload) {
				calls.push([event, payload]);
			});
			proto[0] = 'planted';
			try {
				events.emit('ready');
			} finally {
				delete proto[0];
			}
			expect(calls).toEqual([['ready', undefined]]);
		});

		it('supports once and off for wildcard handlers', function () {
			const events = createEmitter<TestEvents>();
			const once = jest.fn();
			const always = jest.fn();

			events.once('*', once);
			events.on('*', always);
			events.emit('count', 1);
			events.emit('count', 2);
			expect(once).toHaveBeenCalledTimes(1);
			expect(always).toHaveBeenCalledTimes(2);

			expect(events.off('*', always)).toBe(true);
			events.emit('count', 3);
			expect(always).toHaveBeenCalledTimes(2);
		});
	});

	describe('once', function () {
		it('runs at most once and can be cancelled before it runs', function () {
			const events = createEmitter<TestEvents>();
			const handler = jest.fn();
			const cancelled = jest.fn();

			events.once('count', handler);
			const cancel = events.once('count', cancelled);
			cancel();
			events.emit('count', 1);
			events.emit('count', 2);

			expect(handler.mock.calls).toEqual([[1]]);
			expect(cancelled).not.toHaveBeenCalled();
			expect(events.listenerCount('count')).toBe(0);
		});

		it('is removed before running, so a nested emit does not call it again', function () {
			const events = createEmitter<TestEvents>();
			const calls: number[] = [];

			events.once('count', function (n) {
				calls.push(n);
				events.emit('count', n + 1);
			});
			events.emit('count', 1);

			expect(calls).toEqual([1]);
		});
	});

	describe('off', function () {
		it('removes every registration of the handler for that event only', function () {
			const events = createEmitter<TestEvents>();
			const handler = jest.fn();

			events.on('count', handler);
			events.once('count', handler);
			events.on('maybe', handler);

			expect(events.off('count', handler)).toBe(true);
			expect(events.off('count', handler)).toBe(false);
			expect(events.off('ready', handler)).toBe(false);
			events.emit('count', 1);
			events.emit('maybe', 2);

			expect(handler.mock.calls).toEqual([[2]]);
		});

		it('keeps other handlers of the event', function () {
			const events = createEmitter<TestEvents>();
			const a = jest.fn();
			const b = jest.fn();

			events.on('count', a);
			events.on('count', b);
			events.off('count', a);

			expect(events.listenerCount('count')).toBe(1);
			events.emit('count', 1);
			expect(b).toHaveBeenCalledTimes(1);
			expect(a).not.toHaveBeenCalled();
		});
	});

	describe('clear / listenerCount', function () {
		it('counts per event, wildcard and total', function () {
			const events = createEmitter<TestEvents>();

			events.on('count', jest.fn());
			events.on('count', jest.fn());
			events.on('ready', jest.fn());
			events.on('*', jest.fn());

			expect(events.listenerCount('count')).toBe(2);
			expect(events.listenerCount('ready')).toBe(1);
			expect(events.listenerCount('message')).toBe(0);
			expect(events.listenerCount('*')).toBe(1);
			expect(events.listenerCount()).toBe(4);

			events.clear('count');
			expect(events.listenerCount()).toBe(2);
			events.clear('*');
			expect(events.listenerCount()).toBe(1);
			events.clear('message');
			events.clear();
			expect(events.listenerCount()).toBe(0);
		});

		it('makes previously returned unsubscribe functions harmless', function () {
			const events = createEmitter<TestEvents>();
			const handler = jest.fn();
			const stop = events.on('count', handler);

			events.clear();
			const other = events.on('count', handler);
			stop();
			expect(events.listenerCount('count')).toBe(1);
			other();
			expect(events.listenerCount('count')).toBe(0);
		});

		it('lets the removed handlers be collected while an old unsubscribe function is kept (previously kept them all alive)', async function () {
			/**
			 * Registers handlers reading new objects (in a scope of their own: closures of one scope share what they hold), removes
			 * them, and keeps only the first unsubscribe function.
			 * @param {(events: Emitter<TestEvents>, stops: Unsubscribe[]) => void} remove - Removes the registrations
			 * @returns {{ refs: Array<WeakRef<{ id: number }>>; kept: Unsubscribe; events: Emitter<TestEvents> }} What survives
			 */
			function register(remove: (events: Emitter<TestEvents>, stops: Unsubscribe[]) => void): {
				refs: Array<WeakRef<{ id: number }>>;
				kept: Unsubscribe;
				events: Emitter<TestEvents>;
			} {
				const events = createEmitter<TestEvents>();
				const refs: Array<WeakRef<{ id: number }>> = [];
				const stops = [1, 2, 3, 4].map(function (id) {
					const value = { id };
					refs.push(new WeakRef(value));
					return events.on('count', function () {
						expect(value.id).toBeGreaterThan(0);
					});
				});
				remove(events, stops);
				return { refs, kept: stops[0], events };
			}

			const scenarios = [
				register(function (events) {
					events.clear();
				}),
				register(function (events) {
					events.clear('count');
				}),
				register(function (events) {
					events.on('count', function () {
						events.clear();
					});
					events.emit('count', 1);
				}),
				register(function (_events, stops) {
					for (const stop of [...stops].reverse()) stop();
				})
			];

			await collectGarbage();
			for (const { refs, kept, events } of scenarios) {
				// The first handler stays reachable through its own unsubscribe function, as in 1.5.
				expect(
					refs.map(function (ref) {
						return ref.deref() === undefined;
					})
				).toEqual([false, true, true, true]);
				kept();
				expect(events.listenerCount()).toBe(0);
			}
		});
	});

	describe('waitFor', function () {
		/**
		 * A signal-like object whose methods or reason can throw, with a way to fire its listeners.
		 */
		function hostileSignal(overrides: { add?: boolean; remove?: boolean; reason?: boolean } = {}): AbortSignalLike & { fire(): void } {
			const listeners: Array<() => void> = [];
			const signal = {
				aborted: false,
				addEventListener(_type: string, listener: () => void): void {
					if (overrides.add) throw new Error('add');
					listeners.push(listener);
				},
				removeEventListener(): void {
					if (overrides.remove) throw new Error('remove');
					listeners.length = 0;
				},
				get reason(): unknown {
					if (overrides.reason) throw new Error('reason');
					return undefined;
				},
				fire(): void {
					signal.aborted = true;
					for (const listener of listeners.slice()) listener();
				}
			};
			return signal as unknown as AbortSignalLike & { fire(): void };
		}

		it('settles and cleans up under signals whose methods or reason throw', async function () {
			const events = createEmitter<{ x: number }>();
			await expect(events.waitFor('x', { signal: hostileSignal({ add: true }), timeout: 50 })).rejects.toThrow('add');
			expect(events.listenerCount('x')).toBe(0);
			await expect(events.waitFor('x', { signal: {} as AbortSignalLike })).rejects.toThrow(
				new TypeError('waitFor: `signal` must be an AbortSignal, null or undefined, got object')
			);
			expect(events.listenerCount('x')).toBe(0);

			const removing = events.waitFor('x', { signal: hostileSignal({ remove: true }) });
			events.emit('x', 1);
			await expect(removing).resolves.toBe(1);
			await expect(events.waitFor('x', { signal: hostileSignal({ remove: true }), timeout: 5 })).rejects.toBeInstanceOf(TimeoutError);

			const signal = hostileSignal({ reason: true });
			const aborted = events.waitFor('x', { signal });
			signal.fire();
			await expect(aborted).rejects.toThrow('reason');
			expect(events.listenerCount('x')).toBe(0);
		});

		afterEach(function () {
			jest.useRealTimers();
		});

		it('resolves with the next payload and removes its listener', async function () {
			const events = createEmitter<TestEvents>();
			const promise = events.waitFor('count');

			expect(events.listenerCount('count')).toBe(1);
			events.emit('count', 7);
			events.emit('count', 8);

			await expect(promise).resolves.toBe(7);
			expect(events.listenerCount()).toBe(0);
		});

		it('resolves void events with undefined', async function () {
			const events = createEmitter<TestEvents>();
			const promise = events.waitFor('ready');

			events.emit('ready');
			await expect(promise).resolves.toBeUndefined();
		});

		it('only resolves with payloads accepted by filter', async function () {
			const events = createEmitter<TestEvents>();
			const promise = events.waitFor('count', {
				filter: function (n) {
					return n > 2;
				}
			});

			events.emit('count', 1);
			events.emit('count', 2);
			expect(await stateOf(promise)).toBe('pending');
			events.emit('count', 3);

			await expect(promise).resolves.toBe(3);
			expect(events.listenerCount()).toBe(0);
		});

		it('rejects with the error thrown by filter without breaking the emit', async function () {
			const events = createEmitter<TestEvents>();
			const boom = new Error('filter');
			const other = jest.fn();
			const promise = events.waitFor('count', {
				filter: function () {
					throw boom;
				}
			});

			events.on('count', other);
			expect(function () {
				events.emit('count', 1);
			}).not.toThrow();

			await expect(promise).rejects.toBe(boom);
			expect(other).toHaveBeenCalled();
			expect(events.listenerCount()).toBe(1);
		});

		it('rejects with a TimeoutError and cleans up', async function () {
			jest.useFakeTimers();
			const events = createEmitter<TestEvents>();
			const signal = createSignal();
			const promise = events.waitFor('count', { timeout: 100, signal });

			jest.advanceTimersByTime(99);
			expect(await stateOf(promise)).toBe('pending');
			jest.advanceTimersByTime(1);

			await expect(promise).rejects.toBeInstanceOf(TimeoutError);
			await expect(promise).rejects.toThrow(/count/);
			expect(events.listenerCount()).toBe(0);
			expect(signal.listeners).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('clears its timer when the event arrives in time', async function () {
			jest.useFakeTimers();
			const events = createEmitter<TestEvents>();
			const promise = events.waitFor('count', { timeout: 100 });

			events.emit('count', 1);
			await expect(promise).resolves.toBe(1);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('waits indefinitely without a timeout', async function () {
			const events = createEmitter<TestEvents>();
			const promise = events.waitFor('count');

			await new Promise(function (resolve) {
				setTimeout(resolve, 20);
			});
			expect(await stateOf(promise)).toBe('pending');
			events.emit('count', 4);
			await expect(promise).resolves.toBe(4);
		});

		it('timeout 0 rejects on the next timer tick', async function () {
			const events = createEmitter<TestEvents>();
			await expect(events.waitFor('count', { timeout: 0 })).rejects.toBeInstanceOf(TimeoutError);
			expect(events.listenerCount()).toBe(0);
		});

		it('rejects with the abort reason and cleans up', async function () {
			jest.useFakeTimers();
			const events = createEmitter<TestEvents>();
			const signal = createSignal();
			const reason = new Error('stop');
			const promise = events.waitFor('count', { signal, timeout: 1000 });

			expect(signal.listeners).toBe(1);
			signal.abort(reason);

			await expect(promise).rejects.toBe(reason);
			expect(events.listenerCount()).toBe(0);
			expect(signal.listeners).toBe(0);
			expect(jest.getTimerCount()).toBe(0);
		});

		it('rejects with an AbortError when the signal has no reason', async function () {
			const events = createEmitter<TestEvents>();
			const signal = createSignal();
			const promise = events.waitFor('count', { signal });

			signal.abort();
			await expect(promise).rejects.toBeInstanceOf(AbortError);
		});

		it('rejects immediately for an already aborted signal without registering anything', async function () {
			const events = createEmitter<TestEvents>();
			const controller = new AbortController();
			controller.abort('why');

			await expect(events.waitFor('count', { signal: controller.signal })).rejects.toBe('why');
			expect(events.listenerCount()).toBe(0);

			const bare = createSignal();
			(bare as { aborted: boolean }).aborted = true;
			await expect(events.waitFor('count', { signal: bare })).rejects.toBeInstanceOf(AbortError);
		});

		it('removes the abort listener when resolved', async function () {
			const events = createEmitter<TestEvents>();
			const signal = createSignal();
			const promise = events.waitFor('count', { signal });

			events.emit('count', 1);
			await expect(promise).resolves.toBe(1);
			expect(signal.listeners).toBe(0);
		});

		it('works with a real AbortController', async function () {
			const events = createEmitter<TestEvents>();
			const controller = new AbortController();
			const promise = events.waitFor('count', { signal: controller.signal });

			controller.abort();
			await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
			expect(events.listenerCount()).toBe(0);
		});

		it('ignores options inherited from a polluted Object.prototype', async function () {
			const events = createEmitter<TestEvents>();
			const proto = Object.prototype as Record<string, unknown>;

			proto.filter = function () {
				return false;
			};
			proto.timeout = 0;
			proto.signal = { aborted: true, reason: 'polluted', addEventListener: jest.fn(), removeEventListener: jest.fn() };
			try {
				const promise = events.waitFor('count', {});
				events.emit('count', 1);
				await expect(promise).resolves.toBe(1);
			} finally {
				delete proto.filter;
				delete proto.timeout;
				delete proto.signal;
			}
		});

		it('rejects invalid arguments', async function () {
			const events = createEmitter<TestEvents>();

			for (const timeout of [-1, NaN, 2 ** 31]) {
				await expect(events.waitFor('count', { timeout })).rejects.toThrow(RangeError);
			}
			await expect(events.waitFor('count', { timeout: '5' as any })).rejects.toThrow(
				new TypeError('waitFor: `timeout` must be Infinity or a number between 0 and 2147483647, got string')
			);
			await expect(events.waitFor('count', { filter: 'x' as any })).rejects.toThrow(new TypeError('waitFor: `filter` must be a function, got string'));
			await expect((events.waitFor as any)('*')).rejects.toThrow(new RangeError("waitFor: `event` must not be '*' (reserved for wildcard listeners), got '*'"));
			expect(events.listenerCount()).toBe(0);
		});

		it('adds one abort listener per signal, however many waitFor calls share it (previously one each: quadratic)', async function () {
			const first = createEmitter<{ x: number }>();
			const second = createEmitter<{ x: number }>();
			const signal = createSignal();
			const waits = [first.waitFor('x', { signal }), first.waitFor('x', { signal }), second.waitFor('x', { signal })];
			expect(signal.listeners).toBe(1);
			first.emit('x', 1);
			await expect(Promise.all(waits.slice(0, 2))).resolves.toEqual([1, 1]);
			// Still listening for the call left.
			expect(signal.listeners).toBe(1);
			const later = first.waitFor('x', { signal });
			signal.abort('stop');
			await expect(waits[2]).rejects.toBe('stop');
			await expect(later).rejects.toBe('stop');
			expect(signal.listeners).toBe(0);
			expect(first.listenerCount() + second.listenerCount()).toBe(0);
			// And once every call has settled, none is left either.
			const other = createSignal();
			const settled = [first.waitFor('x', { signal: other }), first.waitFor('x', { signal: other, timeout: 0 })];
			first.emit('x', 2);
			await expect(settled[0]).resolves.toBe(2);
			await expect(settled[1]).resolves.toBe(2);
			expect(other.listeners).toBe(0);
		});

		it('starts and aborts many waitFor calls sharing a platform signal in linear time', async function () {
			/**
			 * Times 30,000 waitFor calls, with or without a shared signal, settled by an emit or an abort.
			 * @param {boolean} shared - Whether the calls share a signal
			 * @returns {Promise<number>} The time in ms
			 */
			async function time(shared: boolean): Promise<number> {
				const events = createEmitter<{ x: number }>();
				const controller = new AbortController();
				const options = shared ? { signal: controller.signal } : {};
				const waits: Array<Promise<unknown>> = [];
				const start = performance.now();
				for (let i = 0; i < 30_000; i++) waits.push(events.waitFor('x', options));
				if (shared) controller.abort();
				else events.emit('x', 1);
				const elapsed = performance.now() - start;
				await Promise.allSettled(waits);
				expect(events.listenerCount()).toBe(0);
				return elapsed;
			}
			const alone = await time(false);
			// Quadratic, it took hundreds of times as long (6 s).
			expect(await time(true)).toBeLessThan(alone * 20 + 100);
		});

		it('rejects with the reason when the signal calls the listener while it is being added (previously a ReferenceError)', async function () {
			const events = createEmitter<{ x: number }>();
			/**
			 * A signal that aborts as soon as a listener is added, calling it at once, then (optionally) throws.
			 * @param {boolean} thenThrow - Whether adding the listener throws after calling it
			 * @returns {AbortSignalLike} The signal
			 */
			function abortingOnAdd(thenThrow: boolean): AbortSignalLike {
				const signal = {
					aborted: false,
					reason: 'stop',
					addEventListener: function (_type: string, listener: () => void) {
						signal.aborted = true;
						listener();
						if (thenThrow) throw new Error('add');
					},
					removeEventListener: jest.fn()
				};
				return signal;
			}
			jest.useFakeTimers();
			try {
				await expect(events.waitFor('x', { signal: abortingOnAdd(false), timeout: 1000 })).rejects.toBe('stop');
				await expect(events.waitFor('x', { signal: abortingOnAdd(true), timeout: 1000 })).rejects.toBe('stop');
				expect(events.listenerCount()).toBe(0);
				expect(jest.getTimerCount()).toBe(0);
			} finally {
				jest.useRealTimers();
			}
		});

		it('keeps waiting on a signal whose removeEventListener throws, and is stopped once by its abort', async function () {
			const events = createEmitter<{ x: number }>();
			const signal = hostileSignal({ remove: true });
			const settled = events.waitFor('x', { signal });
			events.emit('x', 1);
			await expect(settled).resolves.toBe(1);
			// The first listener could not be removed: a new one is added for the next call, and the old one stops nobody.
			const waiting = events.waitFor('x', { signal });
			signal.fire();
			await expect(waiting).rejects.toBeInstanceOf(AbortError);
			expect(events.listenerCount()).toBe(0);
		});
	});
});

/**
 * Runs a full garbage collection once pending callbacks have run.
 * @returns {Promise<void>} Resolves after the collection
 */
async function collectGarbage(): Promise<void> {
	setFlagsFromString('--expose-gc');
	const gc = vm.runInNewContext('gc') as () => void;
	// `setImmediate`, not `setTimeout`: a spy restored after a test with fake timers can leave the fake `setTimeout` behind.
	await new Promise(function (resolve) {
		setImmediate(resolve);
	});
	gc();
}
