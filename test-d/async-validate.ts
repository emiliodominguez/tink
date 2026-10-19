import { createBatcher, type Batcher } from 'tinkit/async';
import { createLRUCache } from 'tinkit/cache';
import { isString } from 'tinkit/guards';
import { asBoolean, asInteger, asList, isUrl, optional, parseEnv, withDefault } from 'tinkit/validate';

type BatchUser = { id: number; name: string };
declare function fetchBatchUsers(ids: readonly number[]): Promise<Array<BatchUser | Error>>;
declare const nodeEnv: { [key: string]: string | undefined };
interface WorkerEnv {
	API_URL: string;
	DEBUG: string;
}
declare const workerEnv: WorkerEnv;

async function batcherTypes(): Promise<void> {
	const users = createBatcher(function (ids: number[]) {
		return fetchBatchUsers(ids);
	});
	const user: BatchUser = await users.load(1); // Error stripped from V
	const many: BatchUser[] = await users.loadMany([1, 2]);
	const typed: Batcher<number, BatchUser> = users;
	// @ts-expect-error -- wrong key type
	users.load('1');
	// @ts-expect-error -- prime takes a value of the value type
	users.prime(1, 'x');
	const readonlyKeys = createBatcher(fetchBatchUsers); // readonly-array parameter still infers K
	const r: BatchUser = await readonlyKeys.load(1);
	const roots = createBatcher(function (keys: number[]) {
		return Float64Array.from(keys, Math.sqrt);
	});
	const root: number = await roots.load(4);
	const byId = createBatcher(
		async function (keys: Array<{ id: number }>) {
			return keys.map(function (key) {
				return String(key.id);
			});
		},
		{
			key: function (key) {
				return key.id;
			},
			cache: createLRUCache<unknown, string>({ max: 10 }),
			maxBatchSize: 50,
			delay: 5
		}
	);
	const s: string = await byId.load({ id: 1 }, { signal: null });
	const wrongCache = { cache: createLRUCache<unknown, string>({ max: 10 }) };
	async function loadNumbers(keys: number[]): Promise<number[]> {
		return keys;
	}
	// @ts-expect-error -- a cache of the wrong value type
	createBatcher(loadNumbers, wrongCache);
	// @ts-expect-error -- not a batch function
	createBatcher(42);
	async function loadText(_ids: number[]): Promise<string> {
		return 'ab';
	}
	// @ts-expect-error -- a string is not an array of values
	createBatcher(loadText);
	// @ts-expect-error -- a string is not an array of values (synchronous)
	createBatcher(function (_ids: number[]) {
		return 'ab';
	});
	void [user, many, typed, r, root, s];
}

function parseEnvTypes(): void {
	const schema = { DATABASE_URL: isUrl, PORT: withDefault(asInteger, 3000), DEBUG: withDefault(asBoolean, false), ORIGINS: asList(isUrl), SENTRY: optional(isString) };
	const env = parseEnv(schema, nodeEnv);
	const port: number = env.PORT;
	const debug: boolean = env.DEBUG;
	const origins: string[] = env.ORIGINS;
	const sentry: string | undefined = env.SENTRY;
	// @ts-expect-error -- not declared
	void env.HOME;
	parseEnv(schema);
	parseEnv({ API_URL: isUrl }, workerEnv, { prefix: 'VITE_', strict: true, blankAsMissing: false });
	// @ts-expect-error -- not an object schema
	parseEnv(isString);
	// @ts-expect-error -- env must be an object
	parseEnv(schema, 'PORT=1');
	// @ts-expect-error -- unknown option
	parseEnv(schema, nodeEnv, { prefixes: 'X' });
	// @ts-expect-error -- flags are booleans
	parseEnv(schema, nodeEnv, { strict: 'false' });
	void [port, debug, origins, sentry];
}
void batcherTypes;
void parseEnvTypes;
