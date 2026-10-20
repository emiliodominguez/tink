import { backoff, CircuitOpenError, createCircuitBreaker, createStopwatch, fromEvent, interval, isAbortError, isTimeoutError } from 'tinkit/async';
import type {
	BackoffJitter,
	BackoffOptions,
	CircuitBreaker,
	CircuitBreakerOptions,
	CircuitBreakerStats,
	CircuitState,
	FromEventOptions,
	FromEventOverflow,
	IntervalOptions,
	Stopwatch,
	StopwatchOptions
} from 'tinkit/async';

declare function fetchUser(id: string, retries?: number): Promise<{ id: string; name: string }>;
declare const emitter: { on(type: string, listener: (value: unknown) => void): void; off(type: string, listener: (value: unknown) => void): void };
declare const target: {
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
};

async function circuitBreakerTypes(): Promise<void> {
	const options: CircuitBreakerOptions = {
		failureThreshold: 3,
		resetTimeout: 10_000,
		halfOpenMaxCalls: 2,
		isFailure: function (error: unknown): boolean {
			return !(error instanceof RangeError);
		},
		onStateChange: function (state: CircuitState, previous: CircuitState): void {
			void [state, previous];
		},
		now: Date.now
	};
	const guarded = createCircuitBreaker(fetchUser, options);
	const typed: CircuitBreaker<typeof fetchUser> = guarded;
	const user: { id: string; name: string } = await guarded('42');
	await guarded('42', 3);
	// @ts-expect-error -- the parameters of the operation
	guarded(42);
	// @ts-expect-error -- missing argument
	guarded();
	const state: CircuitState = guarded.state;
	// @ts-expect-error -- read-only
	guarded.state = 'open';
	const stats: CircuitBreakerStats = guarded.stats;
	const counts: number = stats.successes + stats.failures + stats.shortCircuited + stats.consecutiveFailures;
	guarded.open();
	guarded.reset();
	const sync = createCircuitBreaker(function (a: number, b: number): number {
		return a + b;
	});
	const sum: number = await sync(1, 2);
	const withThis = createCircuitBreaker(function (this: { base: number }, n: number): number {
		return this.base + n;
	});
	const bound: number = await withThis.call({ base: 1 }, 2);
	// @ts-expect-error -- not a function
	createCircuitBreaker('nope');
	// @ts-expect-error -- unknown state
	const wrong: CircuitState = 'broken';
	const error = new CircuitOpenError('down', 1000);
	const retryAfter: number = error.retryAfter;
	const plain: Error = new CircuitOpenError();
	void [typed, user, state, counts, sum, bound, wrong, retryAfter, plain];
}

function backoffTypes(): void {
	const jitter: BackoffJitter = 'decorrelated';
	const options: BackoffOptions = {
		delay: 50,
		factor: 3,
		maxDelay: 5000,
		jitter,
		retries: 5,
		random: function (): number {
			return 0.5;
		}
	};
	const delays: Iterable<number> = backoff(options);
	const list: number[] = [...backoff()];
	for (const delay of delays) {
		const ms: number = delay;
		void ms;
	}
	// @ts-expect-error -- not a jitter name
	backoff({ jitter: 'random' });
	// @ts-expect-error -- delays are numbers
	const text: string[] = [...backoff()];
	void [list, text];
}

function errorGuardTypes(caught: unknown): void {
	if (isAbortError(caught)) {
		const name: 'AbortError' = caught.name;
		const message: string = caught.message;
		void [name, message];
	}
	if (isTimeoutError(caught)) {
		const name: 'TimeoutError' = caught.name;
		void name;
	}
}

async function fromEventTypes(): Promise<void> {
	const overflow: FromEventOverflow = 'drop-oldest';
	const options: FromEventOptions<string> = {
		bufferSize: 100,
		overflow,
		rejectOn: ['error', Symbol('close')],
		filter: function (message: string): boolean {
			return message.length > 0;
		},
		signal: null
	};
	for await (const message of fromEvent<string>(emitter, 'message', options)) {
		const text: string = message;
		void text;
	}
	const events: AsyncIterableIterator<unknown> = fromEvent(target, 'click');
	const symbolEvents = fromEvent<number>(emitter, Symbol('tick'));
	const tick: IteratorResult<number> = await symbolEvents.next();
	// @ts-expect-error -- an EventTarget's event types are strings
	fromEvent(target, Symbol('click'));
	// @ts-expect-error -- not an event target
	fromEvent({}, 'x');
	// @ts-expect-error -- not an overflow policy
	fromEvent(emitter, 'x', { overflow: 'drop' });
	void [events, tick];
}

function intervalTypes(): void {
	const options: IntervalOptions = { immediate: true, signal: undefined };
	const stop: () => void = interval(
		function (tick: number): void {
			void tick;
		},
		1000,
		options
	);
	interval(async function (): Promise<void> {}, 50);
	// @ts-expect-error -- the period is a number
	interval(function (): void {}, '10');
	stop();
}

function stopwatchTypes(): void {
	const options: StopwatchOptions = {
		now: function (): number {
			return 0;
		}
	};
	const watch: Stopwatch = createStopwatch(options).start();
	const elapsed: number = watch.elapsed;
	const running: boolean = watch.running;
	const lap: number = watch.lap();
	const stopped: number = watch.stop();
	const again: Stopwatch = watch.reset().start();
	// @ts-expect-error -- read-only
	watch.elapsed = 0;
	void [elapsed, running, lap, stopped, again, createStopwatch()];
}

void circuitBreakerTypes;
void backoffTypes;
void errorGuardTypes;
void fromEventTypes;
void intervalTypes;
void stopwatchTypes;
