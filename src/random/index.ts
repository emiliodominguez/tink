import { sample, shuffle } from '../arrays/index.js';
import { randomBetween } from '../math/index.js';
import { assertFunction, assertNumber, describe, draw } from '../utils/assert.js';
import type { RandomGenerator } from '../utils/index.js';

/**
 * Snapshot of a {@link SeededRandom}'s internal 128-bit state: four unsigned 32-bit integers.
 * Obtain it with {@link SeededRandom.state} and pass it to {@link SeededRandom.restore} to replay a stream.
 */
export type SeededRandomState = readonly [number, number, number, number];

/**
 * A deterministic pseudo-random generator created by {@link createRandom}.
 *
 * It is callable like `Math.random` (returns floats in `[0, 1)`), so it can be passed anywhere a {@link RandomGenerator}
 * is accepted, and it also exposes convenience methods that all draw from the same stream.
 *
 * **Not cryptographically secure** — use {@link randomBytes}, {@link randomId}, {@link randomUUID} or {@link secureRandom} for secrets.
 */
export interface SeededRandom {
	/** Returns the next float in `[0, 1)` (32 bits of precision) and advances the stream. */
	(): number;
	/**
	 * Returns an unbiased random integer in `[ceil(min), floor(max)]` (both inclusive).
	 * @throws {TypeError} when a bound is not a number
	 * @throws {RangeError} when a bound is not finite, no integer lies in the range, a bound is not a safe integer, or the range spans more than `2 ** 53` values
	 */
	int(min: number, max: number): number;
	/**
	 * Returns a random float in `[min, max)` (`min` when both bounds are equal).
	 * @throws {TypeError} when a bound is not a number
	 * @throws {RangeError} when a bound is not finite or `min > max`
	 */
	float(min: number, max: number): number;
	/**
	 * Returns `true` with the given probability.
	 * @throws {TypeError} when `probability` is not a number
	 * @throws {RangeError} when `probability` is outside `[0, 1]` or NaN
	 */
	bool(probability?: number): boolean;
	/** Returns a random item of `array`, or `undefined` when it is empty (the stream is then not advanced). */
	pick<T>(array: ReadonlyArray<T>): T | undefined;
	/** Returns a shuffled copy of `array` (Fisher–Yates); the input is not mutated. */
	shuffle<T>(array: ReadonlyArray<T>): T[];
	/** Creates an independent child generator seeded from this stream (advances this stream by four draws). */
	fork(): SeededRandom;
	/** Returns a snapshot of the current internal state. */
	state(): SeededRandomState;
	/**
	 * Replaces the internal state (mutates this generator) so the stream continues from `snapshot`.
	 * @throws {TypeError} when `snapshot` is not an array of four unsigned 32-bit integers
	 */
	restore(snapshot: SeededRandomState): void;
}

/**
 * Structural subset of the WebCrypto `Crypto` object, so the module does not depend on the DOM or Node type libraries.
 */
interface CryptoLike {
	getRandomValues(array: Uint8Array): Uint8Array;
	randomUUID?(): string;
}

/**
 * The URL-safe 64-character alphabet used by default by {@link randomId} (`A-Z`, `a-z`, `0-9`, `_` and `-`).
 */
export const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** `2 ** 32`, the number of distinct 32-bit outputs. */
const UINT32_RANGE = 4294967296;

/** Largest byte count a single `crypto.getRandomValues` call accepts (WebCrypto quota). */
const MAX_RANDOM_VALUES_BYTES = 65536;

/**
 * Hashes a string into 128 bits of state (cyrb128 by bryc), using only 32-bit integer math so results are identical on every platform.
 * @param {string} text - The text to hash
 * @returns {number[]} Four unsigned 32-bit integers
 */
function cyrb128(text: string): [number, number, number, number] {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < text.length; i++) {
		const k = text.charCodeAt(i);
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
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * Builds a seeded generator around a mutable sfc32 state.
 * @param {number[]} seedState - Four 32-bit integers used as the initial state (copied)
 * @returns {SeededRandom} The generator
 */
function fromState(seedState: SeededRandomState): SeededRandom {
	let a = seedState[0] | 0;
	let b = seedState[1] | 0;
	let c = seedState[2] | 0;
	let d = seedState[3] | 0;

	/**
	 * Advances the sfc32 state (Small Fast Chaotic, 32-bit) and returns the next unsigned 32-bit output.
	 * @returns {number} An integer in `[0, 2 ** 32)`
	 */
	function nextUint32(): number {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return t >>> 0;
	}

	// Discard the first outputs to decorrelate the stream from the (possibly similar) seeds.
	for (let i = 0; i < 15; i++) nextUint32();

	/**
	 * Draws an unbiased integer in `[0, range)` by rejection sampling, for `1 <= range <= 2 ** 53`.
	 * @param {number} range - The number of possible outcomes
	 * @returns {number} An integer in `[0, range)`
	 */
	function below(range: number): number {
		if (range <= UINT32_RANGE) {
			const limit = UINT32_RANGE - (UINT32_RANGE % range);
			let value = nextUint32();
			while (value >= limit) value = nextUint32();
			return value % range;
		}
		const space = 2 ** 53;
		const limit = space - (space % range);
		let value: number;
		do {
			value = (nextUint32() >>> 11) * UINT32_RANGE + nextUint32();
		} while (value >= limit);
		return value % range;
	}

	/**
	 * Returns the next float in `[0, 1)`.
	 * @returns {number} The next output divided by `2 ** 32`
	 */
	function generator(): number {
		return nextUint32() / UINT32_RANGE;
	}

	// Plain assignments: much cheaper than `Object.assign` with an object literal. The methods are per-instance closures
	// (not prototype methods) so that they keep working when detached (`const { int } = rng`).
	const rng = generator as SeededRandom;
	rng.int = function int(min: number, max: number): number {
		assertNumber('SeededRandom.int', 'min', min, Number.isFinite(min), 'a finite number');
		assertNumber('SeededRandom.int', 'max', max, Number.isFinite(max), 'a finite number');
		const low = Math.ceil(min);
		const high = Math.floor(max);
		if (low > high) throw new RangeError(`SeededRandom.int: no integer exists in [${min}, ${max}]`);
		if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high - low > Number.MAX_SAFE_INTEGER) {
			throw new RangeError(`SeededRandom.int: [${min}, ${max}] must lie within safe integers and span at most 2 ** 53 values`);
		}
		return low + below(high - low + 1);
	};
	rng.float = function float(min: number, max: number): number {
		assertNumber('SeededRandom.float', 'min', min, Number.isFinite(min), 'a finite number');
		assertNumber('SeededRandom.float', 'max', max, Number.isFinite(max), 'a finite number');
		return randomBetween(min, max, generator);
	};
	rng.bool = function bool(probability: number = 0.5): boolean {
		assertNumber('SeededRandom.bool', 'probability', probability, probability >= 0 && probability <= 1, 'a number in [0, 1]');
		return randomBoolean(probability, generator);
	};
	rng.pick = function pick<T>(array: ReadonlyArray<T>): T | undefined {
		return sample(array, generator);
	};
	rng.shuffle = function shuffleCopy<T>(array: ReadonlyArray<T>): T[] {
		return shuffle(array, generator);
	};
	rng.fork = function fork(): SeededRandom {
		// Mix the parent's outputs with distinct constants so the child state never mirrors the parent's.
		return fromState([nextUint32() ^ 0x9e3779b9, nextUint32() ^ 0x243f6a88, nextUint32() ^ 0xb7e15162, nextUint32()]);
	};
	rng.state = function state(): SeededRandomState {
		return Object.freeze([a >>> 0, b >>> 0, c >>> 0, d >>> 0] as const);
	};
	rng.restore = function restore(snapshot: SeededRandomState): void {
		// An index loop (not `every`, which skips holes) so sparse arrays are rejected too. Each word is read once: what is validated is
		// what is installed, and a getter that throws leaves the state unchanged.
		const words: number[] = [];
		let valid = Array.isArray(snapshot) && snapshot.length === 4;
		for (let i = 0; valid && i < 4; i++) {
			const word: unknown = snapshot[i];
			valid = Number.isInteger(word) && (word as number) >= 0 && (word as number) < UINT32_RANGE;
			words.push(word as number);
		}
		if (!valid) {
			throw new TypeError('SeededRandom.restore: `snapshot` must be an array of four unsigned 32-bit integers');
		}
		a = words[0] | 0;
		b = words[1] | 0;
		c = words[2] | 0;
		d = words[3] | 0;
	};
	return Object.freeze(rng);
}

/**
 * Creates a deterministic, seedable pseudo-random generator (sfc32, seeded through the cyrb128 string hash).
 *
 * The same seed always produces the same sequence on every platform and engine (only 32-bit integer math is used).
 * Numeric seeds are hashed through `String(seed)`, so `createRandom(1)` and `createRandom('1')` are the same stream.
 *
 * **Not cryptographically secure**: the output is predictable from the seed or from a few observed values.
 * Use {@link randomBytes}, {@link randomId}, {@link randomUUID} or {@link secureRandom} for tokens, keys or anything security-sensitive.
 * @param {number | string} seed - A finite number or any string
 * @returns {SeededRandom} A callable generator returning floats in `[0, 1)` with `int`, `float`, `bool`, `pick`, `shuffle`, `fork`, `state` and `restore` methods
 * @throws {TypeError} when `seed` is neither a number nor a string
 * @throws {RangeError} when `seed` is a non-finite number (NaN or ±Infinity)
 * @example
 * const rng = createRandom('my-seed');
 * rng(); // a float in [0, 1), always the same for this seed
 * rng.int(1, 6); // a die roll
 * rng.shuffle([1, 2, 3]); // a deterministic permutation
 * randomGaussian(0, 1, rng); // usable wherever a `Math.random`-like generator is expected
 * createRandom('my-seed')() === createRandom('my-seed')(); // => true // same seed, same sequence
 */
export function createRandom(seed: number | string): SeededRandom {
	if (typeof seed === 'number') {
		if (!Number.isFinite(seed)) throw new RangeError(`createRandom: \`seed\` must be a finite number or a string, got ${seed}`);
	} else if (typeof seed !== 'string') {
		throw new TypeError(`createRandom: \`seed\` must be a finite number or a string, got ${describe(seed)}`);
	}
	return fromState(cyrb128(String(seed)));
}

/**
 * Returns the platform's WebCrypto object, or throws when no CSPRNG is available.
 * @param {string} caller - Name of the public function, used in the error message
 * @returns {CryptoLike} The `globalThis.crypto` object
 * @throws {Error} when `globalThis.crypto.getRandomValues` is not available
 */
function getCrypto(caller: string): CryptoLike {
	const candidate = (globalThis as unknown as { crypto?: Partial<CryptoLike> | null }).crypto;
	if (candidate == null || typeof candidate.getRandomValues !== 'function') {
		throw new Error(`${caller}: no cryptographically secure random source is available (globalThis.crypto.getRandomValues is missing)`);
	}
	return candidate as CryptoLike;
}

/**
 * Generates cryptographically secure random bytes using `globalThis.crypto.getRandomValues`.
 * Requests larger than 65,536 bytes (the WebCrypto per-call limit) are filled in chunks.
 * @param {number} length - Number of bytes to generate (a non-negative safe integer)
 * @returns {Uint8Array} A fresh array of `length` random bytes
 * @throws {TypeError} when `length` is not a number
 * @throws {RangeError} when `length` is not a non-negative safe integer
 * @throws {Error} when no cryptographically secure random source is available
 * @example
 * randomBytes(16); // e.g. Uint8Array(16) [ 211, 7, 92, ... ]
 * randomBytes(16).length; // => 16
 */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	assertNumber('randomBytes', 'length', length, Number.isSafeInteger(length) && length >= 0, 'a safe integer >= 0');
	return fillRandom(getCrypto('randomBytes'), new Uint8Array(length));
}

/**
 * Fills an array with cryptographically secure random bytes, in chunks of at most 65,536 bytes (the WebCrypto per-call limit).
 * @template T - The array type (kept, so that a `Uint8Array<ArrayBuffer>` stays one)
 * @param {CryptoLike} crypto - The source of random bytes
 * @param {Uint8Array} bytes - The array to fill (mutated)
 * @returns {Uint8Array} `bytes`
 * @example
 * fillRandom(globalThis.crypto, new Uint8Array(4)); // e.g. Uint8Array(4) [ 12, 250, 3, 97 ]
 */
function fillRandom<T extends Uint8Array>(crypto: CryptoLike, bytes: T): T {
	const length = bytes.length;

	for (let offset = 0; offset < length; offset += MAX_RANDOM_VALUES_BYTES) {
		crypto.getRandomValues(bytes.subarray(offset, offset + MAX_RANDOM_VALUES_BYTES));
	}
	// A source that detached (transferred) the buffer left it empty: nothing random would be returned, or a loop would never fill.
	if (bytes.length !== length) throw new Error('crypto.getRandomValues detached the buffer it was asked to fill');
	return bytes;
}

/**
 * Generates a random RFC 4122 / RFC 9562 version 4 UUID (e.g. `'3b241101-e2bb-4255-8caf-4136c566a962'`).
 * Uses `globalThis.crypto.randomUUID` when available, otherwise builds one from `crypto.getRandomValues`.
 * Never falls back to `Math.random`.
 * @returns {string} A lowercase, hyphenated version 4 UUID
 * @throws {Error} when no cryptographically secure random source is available
 * @example
 * randomUUID(); // e.g. 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
 * /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUID()); // => true
 */
export function randomUUID(): string {
	const candidate = (globalThis as unknown as { crypto?: Partial<CryptoLike> | null }).crypto;
	if (candidate != null && typeof candidate.randomUUID === 'function') return candidate.randomUUID();

	// Use our own buffer rather than the return value, which some `getRandomValues` polyfills leave undefined.
	const bytes = fillRandom(getCrypto('randomUUID'), new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	return formatUuid(bytes);
}

/** Lazily built table of the 256 two-digit lowercase hex strings. */
let hexPairs: string[] | undefined;

/**
 * Formats 16 bytes as a lowercase, hyphenated UUID string (8-4-4-4-12 hex digits).
 * @param {Uint8Array} bytes - The 16 bytes of the UUID
 * @returns {string} The UUID string
 * @example
 * formatUuid(new Uint8Array(16)); // => '00000000-0000-0000-0000-000000000000'
 */
function formatUuid(bytes: Uint8Array): string {
	if (hexPairs === undefined) {
		hexPairs = [];
		for (let i = 0; i < 256; i++) hexPairs.push((i < 16 ? '0' : '') + i.toString(16));
	}
	let hex = '';
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) hex += '-';
		hex += hexPairs[bytes[i]];
	}
	return hex;
}

/**
 * Options accepted by {@link createUuidv7} and {@link createUlid}. They are read once, when the generator is created, and as own
 * properties only: a `now` or `random` inherited from a polluted `Object.prototype` is ignored.
 */
export interface TimeIdOptions {
	/**
	 * Clock, in milliseconds since the Unix epoch. Defaults to `Date.now` (read on every call, so fake timers apply). Fractions are
	 * floored. It must return a number in `[0, 2 ** 48)` (until the year 10889), or the call throws (`TypeError` for a non-number,
	 * `RangeError` otherwise) and the generator's state is unchanged.
	 */
	readonly now?: () => number;
	/**
	 * Source of uniform numbers in `[0, 1)` for the random bits, one call per byte (`Math.floor(random() * 256)`). Defaults to the
	 * platform CSPRNG (`crypto.getRandomValues`), never `Math.random`. Pass a seeded `createRandom(seed)` for reproducible ids in tests.
	 */
	readonly random?: RandomGenerator;
}

/** `2 ** 48`: timestamps of UUIDv7s and ULIDs are 48-bit unsigned integers (milliseconds), so they must stay below it. */
const TIME_LIMIT = 281474976710656;

/** `2 ** 30`: the low 30 bits of the UUIDv7 counter are stored in `rand_b`, the 12 bits above them in `rand_a`. */
const COUNTER_LOW = 1073741824;

/** Largest value of the 42-bit UUIDv7 counter. */
const COUNTER_MAX = 4398046511103;

/**
 * Validates and parses the current time for a time-ordered id.
 * @param {string} caller - Name of the generator, used in the error message
 * @param {(() => number) | undefined} now - The injected clock, or `undefined` for `Date.now`
 * @returns {number} The time, an integer in `[0, 2 ** 48)`
 * @throws {TypeError} when the clock does not return a number
 * @throws {RangeError} when it returns NaN or a number outside `[0, 2 ** 48)`
 */
function readTime(caller: string, now: (() => number) | undefined): number {
	const time: unknown = now === undefined ? Date.now() : now();
	// `typeof` first: a comparison would call an object's `valueOf`.
	assertNumber(caller, 'now()', time, typeof time === 'number' && time >= 0 && time < TIME_LIMIT, 'a number in [0, 2 ** 48)');
	return Math.floor(time);
}

/** Number of CSPRNG bytes drawn at once for time-ordered ids (each id takes 10). */
const ID_POOL_SIZE = 1024;

/**
 * CSPRNG bytes drawn ahead of time for time-ordered ids from `idPoolSource` (a new buffer for every refill); `idPool[idPoolOffset]` is
 * the next unused byte. A `getRandomValues` call costs far more than the few bytes an id needs, so they are drawn in batches, each byte
 * handed out once (as `uuid` and `nanoid` do).
 */
let idPool: Uint8Array;
let idPoolOffset = ID_POOL_SIZE;
let idPoolSource: CryptoLike | undefined;

/**
 * Fills the end of an array (at most {@link ID_POOL_SIZE} bytes) with random bytes, from the CSPRNG (through a pool) or from an
 * injected generator.
 * @param {string} caller - Name of the public function, used in the error message
 * @param {Uint8Array} bytes - The array to fill (mutated)
 * @param {number} start - Index of the first byte to fill
 * @param {RandomGenerator | undefined} random - The injected generator, or `undefined` for the CSPRNG
 * @returns {Uint8Array} `bytes`
 * @throws {Error} when no generator is injected and no cryptographically secure random source is available
 * @throws {RangeError} when the injected generator returns a value outside `[0, 1)`
 */
function randomInto(caller: string, bytes: Uint8Array, start: number, random: RandomGenerator | undefined): Uint8Array {
	const length = bytes.length;
	if (random === undefined) {
		const crypto = getCrypto(caller);
		if (idPoolOffset + length - start > ID_POOL_SIZE || crypto !== idPoolSource) {
			// Committed only once filled, like the buffer of `secureRandom`.
			idPool = fillRandom(crypto, new Uint8Array(ID_POOL_SIZE));
			idPoolSource = crypto;
			idPoolOffset = 0;
		}
		for (let i = start; i < length; i++) bytes[i] = idPool[idPoolOffset++];
	} else {
		for (let i = start; i < length; i++) bytes[i] = Math.floor(draw(caller, random) * 256);
	}
	return bytes;
}

/**
 * Reads the options of a time-ordered id generator: each once, as own properties only, so that a `now` or `random` inherited from a
 * polluted `Object.prototype` cannot replace the clock or the CSPRNG.
 * @param {string} caller - Name of the factory, used in the error message
 * @param {unknown} options - The options: `undefined` or an object
 * @returns {Array} The validated clock and random source (`undefined` for the defaults)
 * @throws {TypeError} when `options` is neither `undefined` nor an object, or `now` or `random` is neither `undefined` nor a function
 */
function timeIdOptions(caller: string, options: unknown): [(() => number) | undefined, RandomGenerator | undefined] {
	if (options === undefined) return [undefined, undefined];
	if (typeof options !== 'object' || options === null) throw new TypeError(`${caller}: \`options\` must be an object, got ${describe(options)}`);
	const now: unknown = Object.hasOwn(options, 'now') ? (options as TimeIdOptions).now : undefined;
	const random: unknown = Object.hasOwn(options, 'random') ? (options as TimeIdOptions).random : undefined;
	if (now !== undefined) assertFunction(caller, 'now', now);
	if (random !== undefined) assertFunction(caller, 'random', random);
	return [now as (() => number) | undefined, random as RandomGenerator | undefined];
}

/**
 * Creates a generator of RFC 9562 version 7 UUIDs: time-ordered UUIDs whose first 48 bits are the Unix time in milliseconds, so they
 * sort by creation time as strings and as bytes, and make B-tree database keys that stay local (unlike random version 4 UUIDs).
 *
 * Layout: `unix_ts_ms` (48 bits) · version `7` (4) · `rand_a` (12) · variant `10` (2) · `rand_b` (62). Ids from one generator are strictly
 * increasing, using RFC 9562 §6.2 "Method 1" (fixed-length dedicated counter): a 42-bit counter (all of `rand_a` and the top 30 bits of
 * `rand_b`) is seeded with random bits whenever the millisecond changes and incremented within one, and the last 32 bits are fresh
 * random bits in every id. So the first id of a millisecond has 74 fresh random bits, but the next ones of that millisecond differ from
 * their neighbour only by a counter step and 32 random bits: they are hard to guess, not secret. Use {@link randomId} for secret
 * tokens. Edge cases:
 * - **Counter rollover** (more than 2 ** 41 ids per millisecond on average): the timestamp is advanced by 1 ms and the counter reseeded
 *   (§6.2 allows this), so ids never repeat or go backwards.
 * - **Clock moving backwards** (NTP step, VM migration, a fake clock): the generator keeps its last timestamp and keeps counting until the
 *   clock catches up, so ordering survives; the embedded time then lags behind by the size of the step.
 * - **Range**: a clock outside `[0, 2 ** 48)` throws, and so does a rollover at the last representable millisecond.
 * @param {TimeIdOptions} [options={}] - `now` (default `Date.now`): the clock; `random` (default: the CSPRNG): the source of random bits
 * @returns {Function} A generator returning a new lowercase, hyphenated version 7 UUID on each call
 * @throws {TypeError} when `options` is not an object, or `now` or `random` is not a function (the generator then throws like
 * {@link uuidv7} does)
 * @example
 * const next = createUuidv7({ now: function () { return 1700000000000; }, random: createRandom('seed') });
 * const a = next();
 * const b = next();
 * a < b; // => true // same millisecond: the counter keeps them ordered
 * uuidv7Timestamp(a); // => 1700000000000
 */
export function createUuidv7(options?: TimeIdOptions): () => string {
	const [now, random] = timeIdOptions('createUuidv7', options);
	return uuidv7Generator(now, random);
}

/**
 * Builds a version 7 UUID generator (see {@link createUuidv7}).
 * @param {(() => number) | undefined} now - The validated clock, or `undefined` for `Date.now`
 * @param {RandomGenerator | undefined} random - The validated random source, or `undefined` for the CSPRNG
 * @returns {Function} The generator
 */
function uuidv7Generator(now: (() => number) | undefined, random: RandomGenerator | undefined): () => string {
	let last = -1;
	let counter = 0;
	// Scratch space: every byte that is read is written by the same call first (a re-entrant call from `now` or `random` may overwrite
	// some of them, but the state is read only after those callbacks, so ids stay strictly increasing).
	const bytes = new Uint8Array(16);
	return function nextUuidv7(): string {
		const time = readTime('uuidv7', now);
		randomInto('uuidv7', bytes, 6, random);
		let stamp = last;
		let count = counter + 1;
		if (time > last || count > COUNTER_MAX) {
			if (time <= last && last === TIME_LIMIT - 1) throw new RangeError('uuidv7: the counter overflowed in the last representable millisecond');
			stamp = Math.max(time, last + 1);
			// A fresh 42-bit counter from the random bytes that will hold it.
			count = (((bytes[6] & 0x0f) << 8) | bytes[7]) * COUNTER_LOW + (((bytes[8] & 0x3f) << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]);
		}
		// Committed only now: nothing below throws.
		last = stamp;
		counter = count;
		const high = Math.floor(stamp / 4294967296);
		const low = stamp >>> 0;
		const counterHigh = Math.floor(count / COUNTER_LOW);
		const counterLow = count % COUNTER_LOW;
		bytes[0] = high >> 8;
		bytes[1] = high;
		bytes[2] = low >>> 24;
		bytes[3] = low >>> 16;
		bytes[4] = low >>> 8;
		bytes[5] = low;
		bytes[6] = 0x70 | (counterHigh >> 8); // version 7
		bytes[7] = counterHigh;
		bytes[8] = 0x80 | (counterLow >>> 24); // variant 10xx
		bytes[9] = counterLow >>> 16;
		bytes[10] = counterLow >>> 8;
		bytes[11] = counterLow;
		return formatUuid(bytes);
	};
}

/** The generator behind {@link uuidv7}, created on first use. */
let defaultUuidv7: (() => string) | undefined;

/**
 * Generates an RFC 9562 version 7 UUID: time-ordered (the first 48 bits are the current Unix time in milliseconds), strictly
 * increasing across calls in this module instance, its random bits drawn from the CSPRNG (see {@link createUuidv7} for the layout and
 * the handling of counter rollover and clocks that move backwards). Use {@link createUuidv7} to inject a clock or a seeded random source.
 *
 * Ids are hard to guess but not secret: the creation time is readable by anyone who sees the id ({@link uuidv7Timestamp}), and ids
 * created in the same millisecond differ from their neighbour by a counter step and 32 random bits. Prefer {@link randomUUID} when the
 * time must not leak, and {@link randomId} for secret tokens.
 * @returns {string} A lowercase, hyphenated version 7 UUID, e.g. `'018f3f5e-1c2a-7b3c-9d4e-5f6a7b8c9d0e'`
 * @throws {Error} when no cryptographically secure random source is available
 * @throws {RangeError} when `Date.now()` is outside `[0, 2 ** 48)`
 * @example
 * uuidv7(); // e.g. '0192e4a1-7c3b-7d2e-8f41-6a5b4c3d2e1f'
 * uuidv7() < uuidv7(); // => true
 * /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidv7()); // => true
 */
export function uuidv7(): string {
	return (defaultUuidv7 ??= uuidv7Generator(undefined, undefined))();
}

/** A version 7 UUID in canonical (hyphenated) form, in either letter case. */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Quotes a rejected string for an error message, keeping at most its first 50 characters (so that an attacker-sized input does not
 * end up whole in logs).
 * @param {string} text - The string
 * @returns {string} Its JSON representation, truncated with `…`
 * @example
 * quote('abc'); // => '"abc"'
 */
function quote(text: string): string {
	return JSON.stringify(text.length > 50 ? `${text.slice(0, 50)}…` : text);
}

/**
 * Reads the creation time back from a version 7 UUID (its first 48 bits).
 * @param {string} id - A version 7 UUID in canonical hyphenated form (either letter case)
 * @returns {number} The embedded Unix time in milliseconds (pass it to `new Date()` for a date)
 * @throws {TypeError} when `id` is not a string
 * @throws {SyntaxError} when `id` is not a version 7, RFC 9562 variant UUID
 * @example
 * uuidv7Timestamp('018bcfe5-6800-7000-8000-000000000000'); // => 1700000000000
 * uuidv7Timestamp('018BCFE5-6800-7ABC-BDEF-0123456789AB'); // => 1700000000000
 * uuidv7Timestamp('f47ac10b-58cc-4372-a567-0e02b2c3d479'); // throws SyntaxError // version 4
 */
export function uuidv7Timestamp(id: string): number {
	if (typeof id !== 'string') throw new TypeError(`uuidv7Timestamp: \`id\` must be a string, got ${describe(id)}`);
	if (!UUID_V7_PATTERN.test(id)) throw new SyntaxError(`uuidv7Timestamp: \`id\` must be a version 7 UUID, got ${quote(id)}`);
	return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** Crockford's base32 alphabet, as used by ULIDs (no `I`, `L`, `O` or `U`). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 26 Crockford base32 characters in either letter case, the first at most `7` (48-bit timestamp). */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

/**
 * Writes a timestamp as the 10 Crockford base32 digits of a ULID.
 * @param {number} time - An integer in `[0, 2 ** 48)`
 * @returns {string} The digits, most significant first, zero-padded
 * @example
 * base32Time(33); // => '0000000011'
 */
function base32Time(time: number): string {
	let text = '';
	for (let i = 0; i < 10; i++) {
		text = CROCKFORD[time % 32] + text;
		time = Math.floor(time / 32);
	}
	return text;
}

/**
 * Creates a generator of ULIDs (Universally Unique Lexicographically Sortable Identifiers, github.com/ulid/spec): 26 Crockford base32
 * characters, a 48-bit millisecond timestamp (10 characters) followed by 80 random bits (16 characters). They sort by creation time,
 * as strings, and are case-insensitive, URL-safe and shorter than UUIDs.
 *
 * Ids from one generator are strictly increasing, as in the spec's monotonic factory: within one millisecond (or while the clock is
 * behind the last timestamp used, which is kept), the random part of the previous id is incremented by one instead of drawn again.
 * Successive ids of one millisecond are therefore predictable from each other: use {@link randomId} for secret tokens. As the spec
 * requires, generation fails rather than wrapping when the 80-bit random part would overflow within one millisecond.
 * @param {TimeIdOptions} [options={}] - `now` (default `Date.now`): the clock; `random` (default: the CSPRNG): the source of random bits
 * @returns {Function} A generator returning a new uppercase ULID on each call
 * @throws {TypeError} when `options` is not an object, or `now` or `random` is not a function (the generator then throws like
 * {@link ulid} does)
 * @example
 * const next = createUlid({ now: function () { return 1700000000000; }, random: createRandom('seed') });
 * const a = next();
 * const b = next();
 * a < b; // => true
 * a.slice(0, 10); // => '01HF7YAT00'
 * ulidTimestamp(b); // => 1700000000000
 */
export function createUlid(options?: TimeIdOptions): () => string {
	const [now, random] = timeIdOptions('createUlid', options);
	return ulidGenerator(now, random);
}

/**
 * Builds a ULID generator (see {@link createUlid}).
 * @param {(() => number) | undefined} now - The validated clock, or `undefined` for `Date.now`
 * @param {RandomGenerator | undefined} random - The validated random source, or `undefined` for the CSPRNG
 * @returns {Function} The generator
 */
function ulidGenerator(now: (() => number) | undefined, random: RandomGenerator | undefined): () => string {
	let last = -1;
	let prefix = '';
	// The 16 base32 digits (5 bits each) of the random part of the last id.
	let digits: Uint8Array = new Uint8Array(16);
	return function nextUlid(): string {
		const time = readTime('ulid', now);
		// Drawn first, and committed only after the state is checked again: a source that throws part-way leaves the previous state in
		// place, and one that calls this generator re-entrantly cannot make it go backwards.
		const fresh = time > last ? randomInto('ulid', new Uint8Array(16), 0, random) : undefined;
		if (fresh !== undefined && time > last) {
			// 256 is a multiple of 32, so each masked byte is a uniform digit.
			for (let i = 0; i < 16; i++) fresh[i] &= 31;
			digits = fresh;
			last = time;
			prefix = base32Time(time);
		} else {
			// Increment the 80-bit random part, checking for overflow before changing anything.
			let index = 15;
			while (index >= 0 && digits[index] === 31) index--;
			if (index < 0) throw new RangeError('ulid: the random part overflowed within one millisecond');
			digits[index]++;
			digits.fill(0, index + 1);
		}
		let id = prefix;
		for (let i = 0; i < 16; i++) id += CROCKFORD[digits[i]];
		return id;
	};
}

/** The generator behind {@link ulid}, created on first use. */
let defaultUlid: (() => string) | undefined;

/**
 * Generates a ULID: 26 uppercase Crockford base32 characters, a 48-bit millisecond timestamp then 80 bits from the CSPRNG,
 * lexicographically sortable by creation time and strictly increasing across calls in this module instance (monotonic, see
 * {@link createUlid}). Use {@link createUlid} to inject a clock or a seeded random source.
 * @returns {string} A ULID, e.g. `'01ARZ3NDEKTSV4RRFFQ69G5FAV'`
 * @throws {Error} when a new millisecond needs random bits and no cryptographically secure random source is available (within a
 * millisecond that already has random bits, the next id only increments them)
 * @throws {RangeError} when `Date.now()` is outside `[0, 2 ** 48)`, or (with odds around `2 ** -80`) when the random part overflows
 * within one millisecond
 * @example
 * ulid(); // e.g. '01JAQ7Z5B3XK8M2N4P6R8T0V2W'
 * ulid() < ulid(); // => true
 * /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(ulid()); // => true
 */
export function ulid(): string {
	return (defaultUlid ??= ulidGenerator(undefined, undefined))();
}

/**
 * Reads the creation time back from a ULID (its first 10 characters). The whole id is validated: 26 Crockford base32 characters in
 * either letter case (without the `I`, `L`, `O`, `U` aliases), the first at most `7`.
 * @param {string} id - A ULID
 * @returns {number} The embedded Unix time in milliseconds (pass it to `new Date()` for a date)
 * @throws {TypeError} when `id` is not a string
 * @throws {SyntaxError} when `id` is not a valid ULID
 * @example
 * ulidTimestamp('01HF7YAT00ZZZZZZZZZZZZZZZZ'); // => 1700000000000
 * ulidTimestamp('01hf7yat00zzzzzzzzzzzzzzzz'); // => 1700000000000
 * ulidTimestamp('81HF7YAT00ZZZZZZZZZZZZZZZZ'); // throws SyntaxError // timestamp above 2 ** 48 - 1
 */
export function ulidTimestamp(id: string): number {
	if (typeof id !== 'string') throw new TypeError(`ulidTimestamp: \`id\` must be a string, got ${describe(id)}`);
	if (!ULID_PATTERN.test(id)) throw new SyntaxError(`ulidTimestamp: \`id\` must be a ULID, got ${quote(id)}`);
	let time = 0;
	for (let i = 0; i < 10; i++) time = time * 32 + CROCKFORD.indexOf(id[i].toUpperCase());
	return time;
}

/**
 * Generates a cryptographically secure random identifier (nanoid-style).
 *
 * Characters are drawn with `crypto.getRandomValues` and a bit mask plus rejection sampling, so every character of
 * `alphabet` is exactly equally likely whatever its length. The alphabet is split into Unicode code points, so it may
 * contain astral characters (emoji); `size` counts code points, not UTF-16 units.
 *
 * Like nanoid, characters are generated in batches and buffered: repeated calls with the same alphabet are served from
 * the buffer (each character is handed out once), which grows up to 32,768 characters. The buffer is discarded whenever
 * the alphabet or the `globalThis.crypto` object changes.
 * @param {number} [size=21] - Number of characters to generate (a non-negative safe integer)
 * @param {string} [alphabet=URL_ALPHABET] - Between 2 and 256 distinct characters to draw from
 * @returns {string} A random string of `size` characters from `alphabet`
 * @throws {TypeError} when `size` is not a number
 * @throws {RangeError} when `size` is not a non-negative safe integer, or `alphabet` has fewer than 2 or more than 256 characters, or
 * contains duplicates or lone surrogates (which could pair up into a different character in the result)
 * @throws {Error} when no cryptographically secure random source is available
 * @example
 * randomId(); // e.g. 'V1StGXR8_Z5jdHi6B-myT'
 * randomId(6, '0123456789'); // e.g. '409182'
 * randomId().length; // => 21
 */
export function randomId(size: number = 21, alphabet: string = URL_ALPHABET): string {
	assertNumber('randomId', 'size', size, Number.isSafeInteger(size) && size >= 0, 'a safe integer >= 0');
	const characters = alphabetCharacters(alphabet);
	const crypto = getCrypto('randomId');
	// Astral characters take two UTF-16 units, so a buffer could not be sliced by position: generate them directly.
	if (characters.length !== alphabet.length) return generateId(size, characters, crypto);

	if (alphabet !== poolAlphabet || crypto !== poolSource) {
		poolAlphabet = alphabet;
		poolSource = crypto;
		pool = '';
		poolNext = 0;
	}
	if (poolOffset + size > pool.length) {
		// Grow the batch geometrically while the same alphabet keeps being used (alternating alphabets stay cheap).
		const target = Math.max(poolNext, size);
		poolNext = Math.min(target * 16, MAX_POOL_SIZE);
		pool = generateId(target, characters, crypto);
		poolOffset = 0;
	}
	poolOffset += size;
	return pool.slice(poolOffset - size, poolOffset);
}

/** Number of 32-bit words {@link secureRandom} draws from the CSPRNG at once (two per value). */
const SECURE_WORDS = 256;

/**
 * Random words drawn ahead of time by {@link secureRandom} from `secureSource` (a new buffer for every refill), as 32-bit words;
 * `secureWords[secureOffset]` is the next unused word.
 */
let secureWords: Uint32Array;
let secureOffset = SECURE_WORDS;
let secureSource: CryptoLike | undefined;

/**
 * A cryptographically secure {@link RandomGenerator}: returns a uniformly distributed float in `[0, 1)` with the full 53 bits of
 * precision of a double (every multiple of `2 ** -53` is equally likely), drawn from `globalThis.crypto.getRandomValues`.
 * Pass it to any helper that accepts a `random` argument (`shuffle`, `sample`, `randomIntBetween`, `weightedRandom`, …) when the
 * outcome must not be predictable: tokens, one-time codes, lotteries, security-relevant sampling.
 *
 * Like {@link randomId}, words are drawn 256 at a time (one call serves 128 values) and handed out once each; the buffer is
 * discarded whenever the `globalThis.crypto` object changes. It never falls back to `Math.random`.
 * @returns {number} A random float `r` with `0 <= r < 1`
 * @throws {Error} when no cryptographically secure random source is available
 * @example
 * secureRandom(); // e.g. 0.6170838526077869
 * const r = secureRandom();
 * r >= 0 && r < 1; // => true
 * @example
 * import { randomIntBetween } from 'tinkit/math';
 * randomIntBetween(100000, 999999, secureRandom); // e.g. 482913 (a 6-digit one-time code)
 */
export function secureRandom(): number {
	const crypto = getCrypto('secureRandom');
	if (secureOffset === SECURE_WORDS || crypto !== secureSource) {
		// A new buffer, committed only once filled: a source that throws part-way (or detaches the buffer) must leave no bytes it wrote,
		// nor words already returned, to be served afterwards.
		const bytes = fillRandom(crypto, new Uint8Array(SECURE_WORDS * 4));

		secureWords = new Uint32Array(bytes.buffer);
		secureSource = crypto;
		secureOffset = 0;
	}
	// 27 + 26 random bits: an integer below 2 ** 53, scaled into [0, 1) exactly.
	const value = (secureWords[secureOffset] >>> 5) * 67108864 + (secureWords[secureOffset + 1] >>> 6);
	secureOffset += 2;
	return value / 9007199254740992;
}

/** Largest batch of characters {@link randomId} generates ahead of time. */
const MAX_POOL_SIZE = 32768;

/**
 * Characters generated ahead of time by {@link randomId}, for `poolAlphabet` from `poolSource`; `pool[poolOffset]` is the next unused one.
 * Set on the first call (whose alphabet always differs from the initial `undefined` one).
 */
let pool: string;
let poolOffset = 0;
/** Size of the next batch. */
let poolNext = 0;
let poolAlphabet: string | undefined;
let poolSource: CryptoLike | undefined;

/** Structural subset of the WHATWG `TextDecoder` (not in the ES2022 type library). */
interface TextDecoderLike {
	decode(input: Uint8Array): string;
}

/** The `TextDecoder` constructor {@link utf8Decoder} was created from, and that decoder. */
let decoderClass: unknown;
let utf8Decoder: TextDecoderLike | undefined;

/**
 * Generates `count` random characters of an alphabet with a bit mask and rejection sampling (see {@link randomId}).
 * ASCII alphabets are decoded natively in one step through `TextDecoder` when available, which is much faster than
 * concatenating characters one by one.
 * @param {number} count - Number of characters to generate
 * @param {string[]} characters - The (validated) characters of the alphabet
 * @param {CryptoLike} crypto - The source of random bytes
 * @returns {string} `count` random characters
 * @example
 * generateId(3, ['a', 'b'], globalThis.crypto); // e.g. 'aba'
 */
function generateId(count: number, characters: string[], crypto: CryptoLike): string {
	const length = characters.length;
	// Smallest all-ones bit mask covering every index; values above `length - 1` are rejected to stay unbiased.
	const mask = (2 << (31 - Math.clz32((length - 1) | 1))) - 1;
	const indexes = new Uint8Array(count);
	if (mask === length - 1) {
		// Every masked byte is a valid index: no rejection needed (the mask is applied when the bytes are mapped to characters).
		fillRandom(crypto, indexes);
	} else {
		// Over-request bytes so a single batch usually suffices (the expected acceptance rate is `length / (mask + 1)` > 1/2).
		const bytes = new Uint8Array(Math.min(Math.ceil((1.6 * mask * count) / length), MAX_RANDOM_VALUES_BYTES));
		let accepted = 0;
		while (accepted < count) {
			fillRandom(crypto, bytes);
			for (let i = 0; i < bytes.length && accepted < count; i++) {
				const index = bytes[i] & mask;
				if (index < length) indexes[accepted++] = index;
			}
		}
	}

	const Decoder = (globalThis as { TextDecoder?: new () => TextDecoderLike }).TextDecoder;
	const codes = new Uint8Array(length);
	let ascii = typeof Decoder === 'function';
	for (let i = 0; ascii && i < length; i++) {
		// Check the code before storing it: the byte array would wrap code points above 255 into the ASCII range. A first code unit
		// below 128 is a whole (one-unit) character: astral characters start with a surrogate.
		const code = characters[i].charCodeAt(0);
		codes[i] = code;
		ascii = code < 128;
	}
	if (ascii) {
		if (Decoder !== decoderClass) {
			decoderClass = Decoder;
			utf8Decoder = new (Decoder as new () => TextDecoderLike)();
		}
		// Accepted indexes are below `length`, so masking them again is a no-op.
		for (let i = 0; i < count; i++) indexes[i] = codes[indexes[i] & mask];
		return (utf8Decoder as TextDecoderLike).decode(indexes);
	}
	let id = '';
	for (let i = 0; i < count; i++) id += characters[indexes[i] & mask];
	return id;
}

/** The alphabet most recently validated by {@link alphabetCharacters}, and its characters (set together on the first call). */
let cachedAlphabet: string | undefined;
let cachedCharacters: string[];

/** A UTF-16 surrogate that is not part of a pair (with the `u` flag, paired ones form a single code point). */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Splits a {@link randomId} alphabet into its code points and validates it. The last result is cached, so repeated
 * calls with the same alphabet (the common case) skip the split and the duplicate check.
 * @param {string} alphabet - The alphabet to split
 * @returns {string[]} The characters of the alphabet
 * @throws {RangeError} when the alphabet has fewer than 2 or more than 256 characters, contains duplicates or lone surrogates
 * @example
 * alphabetCharacters('ab🍎'); // => ['a', 'b', '🍎']
 */
function alphabetCharacters(alphabet: string): string[] {
	if (alphabet === cachedAlphabet) return cachedCharacters;
	const characters = Array.from(alphabet);
	const length = characters.length;
	if (length < 2 || length > 256) {
		throw new RangeError(`randomId: \`alphabet\` must contain between 2 and 256 characters, got ${length}`);
	}
	if (new Set(characters).size !== length) {
		throw new RangeError('randomId: `alphabet` must not contain duplicate characters');
	}
	// A lone surrogate counts as one code point here, but in the result a high one followed by a low one would form a single character.
	if (LONE_SURROGATE.test(alphabet)) throw new RangeError('randomId: `alphabet` must not contain lone surrogates');
	cachedAlphabet = alphabet;
	cachedCharacters = characters;
	return characters;
}

/**
 * Picks a random item, with each item's chance proportional to its weight.
 * Items with weight `0` are never returned. Weights must be actual numbers: numeric strings are rejected rather than converted.
 * Not cryptographically secure by default: pass {@link secureRandom} for tokens, OTPs, lotteries…
 * @template T
 * @param {ReadonlyArray<T>} items - The candidates
 * @param {ReadonlyArray<number>} weights - One finite, non-negative weight per item (they need not sum to 1)
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`, injectable for deterministic results
 * @returns {T} The chosen item
 * @throws {TypeError} when `random` is not a function, or a weight is not a number
 * @throws {RangeError} when the arrays differ in length, a weight is negative, NaN or infinite, the total weight is zero or not finite, or `random()` returns a value outside `[0, 1)`
 * @example
 * weightedRandom(['common', 'rare'], [9, 1]); // 'common' ~90% of the time
 * weightedRandom(['a', 'b', 'c'], [0, 1, 0]); // => 'b' // always
 */
export function weightedRandom<T>(items: ReadonlyArray<T>, weights: ReadonlyArray<number>, random: RandomGenerator = Math.random): T {
	if (items.length !== weights.length) {
		throw new RangeError(`weightedRandom: \`items\` and \`weights\` must have the same length, got ${items.length} and ${weights.length}`);
	}
	let total = 0;
	let largest = 0;
	// Index of the last positive weight: there is one once the total weight is known to be positive.
	let lastPositive = 0;
	// Each weight is read once: the selection uses the validated values (a getter cannot turn a zero weight into a chosen one).
	const values: number[] = [];
	for (let i = 0; i < weights.length; i++) {
		const weight = weights[i];
		values.push(weight);
		if (!(typeof weight === 'number' && weight >= 0 && weight < Infinity)) assertNumber('weightedRandom', `weights[${i}]`, weight, false, 'a finite number >= 0');
		total += weight;
		if (weight > largest) largest = weight;
		if (weight > 0) lastPositive = i;
	}
	if (!(total > 0 && total < Infinity)) {
		throw new RangeError(`weightedRandom: the total weight must be positive and finite, got ${total}`);
	}

	// Weights are scaled by the largest one, so that the draw times the total keeps its precision for tiny (subnormal) weights too.
	const target = draw('weightedRandom', random) * (total / largest);
	let cumulative = 0;
	// A zero-weight item can never satisfy `target < cumulative` before an earlier positive item did, so it is never chosen.
	// The last positive item takes whatever remains, which also absorbs floating-point rounding at the top end.
	for (let i = 0; i < lastPositive; i++) {
		cumulative += values[i] / largest;
		if (target < cumulative) return items[i];
	}
	return items[lastPositive];
}

/**
 * Draws a normally distributed (Gaussian) random number using the Box–Muller transform.
 * The first uniform sample is mapped to `(0, 1]` so `Math.log` never sees `0`.
 * Not cryptographically secure by default: pass {@link secureRandom} for tokens, OTPs, lotteries…
 * @param {number} [mean=0] - Mean of the distribution (finite)
 * @param {number} [stdDev=1] - Standard deviation (finite, non-negative; `0` always returns `mean`)
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`, called twice per draw
 * @returns {number} A sample from `N(mean, stdDev²)`
 * @throws {TypeError} when `mean` or `stdDev` is not a number, or `random` is not a function
 * @throws {RangeError} when `mean` is not finite, `stdDev` is negative or not finite, or `random()` returns a value outside `[0, 1)`
 * @example
 * randomGaussian(); // e.g. -0.4271…
 * randomGaussian(100, 15); // e.g. 112.3…
 */
export function randomGaussian(mean: number = 0, stdDev: number = 1, random: RandomGenerator = Math.random): number {
	assertNumber('randomGaussian', 'mean', mean, Number.isFinite(mean), 'a finite number');
	assertNumber('randomGaussian', 'stdDev', stdDev, stdDev >= 0 && stdDev < Infinity, 'a finite number >= 0');
	const u1 = 1 - draw('randomGaussian', random);
	const u2 = draw('randomGaussian', random);
	// The standard normal sample (|z| < 8.6) is formed first, so that `stdDev * z` overflows only when the result does; `stdDev = 0`
	// returns `mean` itself (also `-0`).
	return stdDev === 0 ? mean : mean + stdDev * (Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
}

/**
 * Returns `true` with the given probability.
 * `probability = 0` never returns `true` and `probability = 1` always does.
 * Not cryptographically secure by default: pass {@link secureRandom} for tokens, OTPs, lotteries…
 * @param {number} [probability=0.5] - Chance of `true`, in `[0, 1]`
 * @param {RandomGenerator} [random=Math.random] - Source of uniform numbers in `[0, 1)`, injectable for deterministic results
 * @returns {boolean} A random boolean
 * @throws {TypeError} when `probability` is not a number, or `random` is not a function
 * @throws {RangeError} when `probability` is outside `[0, 1]` or NaN, or `random()` returns a value outside `[0, 1)`
 * @example
 * randomBoolean(); // true or false
 * randomBoolean(0.9); // true ~90% of the time
 */
export function randomBoolean(probability: number = 0.5, random: RandomGenerator = Math.random): boolean {
	assertNumber('randomBoolean', 'probability', probability, probability >= 0 && probability <= 1, 'a number in [0, 1]');
	return draw('randomBoolean', random) < probability;
}
