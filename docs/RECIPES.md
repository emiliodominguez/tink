# Recipes

Copy-paste examples, grouped by task. Every snippet's results are asserted by the test suite (`src/index.spec.ts`) or by the JSDoc doctests.

## Async without the usual footguns

```ts
import { createQueue, createRateLimiter, mapWithConcurrency, memoizeAsync } from 'tinkit/async';

const getUser = memoizeAsync(fetchUser, { ttl: 60_000 }); // concurrent calls share one request; failures are never cached
const limiter = createRateLimiter({ limit: 10, interval: 1_000 }); // sliding window: calls queue instead of being dropped
const queue = createQueue({ concurrency: 4 }); // priorities, pause/resume, onIdle()

await queue.add(uploadAvatar, { priority: 10, signal }); // aborting removes it from the queue
await mapWithConcurrency(urls, fetchPage, { concurrency: 8, signal }); // stops scheduling and rejects with signal.reason
```

## Dates that survive month ends and DST

```ts
import { addDuration, formatDate, intervalToDuration, parseDate } from 'tinkit/date';

formatDate(addDuration(new Date(2024, 0, 31), { months: 1, days: 1 }), 'YYYY-MM-DD'); // '2024-03-01' (Feb 29, then one day)
intervalToDuration(new Date(2024, 0, 31), new Date(2024, 2, 1, 12)); // { years: 0, months: 1, days: 1, hours: 12, … }
parseDate('2023-02-29', 'YYYY-MM-DD'); // undefined: strict inverse of formatDate, no rollover to March 1st
```

`addDuration(start, intervalToDuration(start, end))` returns `end` exactly, in every time zone: it is a property test, run in four zones.

## Text that respects emoji, and keys that keep their types

```ts
import { padStart, reverse } from 'tinkit/strings';
import { toCamelCaseKeys } from 'tinkit/objects';
import { orderBy, takeFirstBy } from 'tinkit/arrays';
import { match } from 'tinkit/functions';

reverse('a👍🏽b'); // 'b👍🏽a' (split('').reverse() breaks the skin tone)
padStart('🇦🇷', 3, '·'); // '··🇦🇷' (a flag is one character, not four code units)

const user = toCamelCaseKeys({ user_id: 1, created_at: '2024-01-01' }); // typed as { userId: number; createdAt: string }

function byAge(person: Person): number {
	return person.age;
}
orderBy(people, [byAge, byName], ['desc', 'asc']); // NaN, null and undefined ages always last
takeFirstBy(players, 3, byScore, 'desc'); // top 3 without sorting everything (heap, O(n log k))

// Exhaustive: adding a { kind: 'triangle' } member to Shape makes this a compile error until it is handled.
match(shape, 'kind', {
	circle: function (circle) {
		return Math.PI * circle.r ** 2; // circle is narrowed to { kind: 'circle'; r: number }
	},
	square: function (square) {
		return square.size ** 2;
	}
});
```

## Everyday helpers: typed data, retries, dates and formatting

These integration snippets use application-provided values such as `user`, `defaults`, `userInput`, `url`, `urls`, `input`, `fetchPage` and `persist`.

```ts
import { getPath, deepMerge } from 'tinkit/objects';
import { isDefined } from 'tinkit/guards';
import { retry, withTimeout, mapWithConcurrency } from 'tinkit/async';
import { debounce } from 'tinkit/functions';
import { addMonths, formatDate } from 'tinkit/date';
import { getReadableTextColor } from 'tinkit/color';
import { formatCompact, formatCurrency } from 'tinkit/format';
import { compareSemver, isEmail } from 'tinkit/validate';
import { withQuery } from 'tinkit/url';

// Type-safe deep access: the return type is inferred from the path.
const city = getPath(user, 'address.city', 'Unknown'); // string

// Narrowing filters.
const ids = [1, null, 2, undefined].filter(isDefined); // number[]

// Ignores __proto__ / constructor / prototype keys, so it is safe on untrusted JSON.
const config = deepMerge(defaults, JSON.parse(userInput));

// Resilient I/O.
const data = await retry(
	function () {
		return withTimeout(fetch(url), 5_000);
	},
	{ retries: 3, delay: 200, jitter: true }
);
const pages = await mapWithConcurrency(urls, fetchPage, 4); // at most 4 requests in flight, order preserved

// Rate limiting with control.
const save = debounce(persist, 300, { maxWait: 2_000 });
save.flush(); // run now, e.g. on beforeunload

// Calendar math that respects month lengths and DST.
formatDate(addMonths(new Date(2024, 0, 31), 1), 'YYYY-MM-DD'); // '2024-02-29'

// Accessible colors and clean URLs.
getReadableTextColor('#1e3a8a'); // '#ffffff'
withQuery('/search?page=2#results', { q: 'café', page: 3 }); // '/search?q=caf%C3%A9&page=3#results'

// Deterministic formatting (en-US / UTC by default, never the host locale) and safe validation.
formatCurrency(1234.5, 'EUR'); // '€1,234.50'
formatCompact(1_250_000); // '1.3M'
isEmail(input); // narrows `unknown` to `string`
['1.0.0', '1.0.0-rc.1', '0.9.9'].sort(compareSemver); // ['0.9.9', '1.0.0-rc.1', '1.0.0']
```

## Application building blocks: caching, events, state and lazy iterables

The caching example wraps your application's `fetchUser` function. The remaining examples are self-contained.

```ts
import { createLRUCache } from 'tinkit/cache';
import { createEmitter } from 'tinkit/emitter';
import { memoize } from 'tinkit/functions';
import { count, filter, map, take, toArray } from 'tinkit/iterables';
import { createRandom } from 'tinkit/random';
import { createStore } from 'tinkit/store';

// Bounded, expiring memoization.
const getUser = memoize(fetchUser, { cache: createLRUCache({ max: 500, ttl: 60_000 }) });

// React-ready state: useSyncExternalStore(counter.subscribe, counter.getState)
const counter = createStore({ count: 0 });
counter.setState(function (state) {
	return { count: state.count + 1 };
});

// Typed events: payloads are checked, `void` events take no argument.
const events = createEmitter<{ login: { userId: string }; logout: void }>();
events.on('login', function ({ userId }) {
	console.log(userId);
});
events.emit('logout');

// Lazy pipelines over infinite sources: only 6 items are ever pulled.
const squares = map(count(1), function (n) {
	return n * n;
});
toArray(
	take(
		filter(squares, function (n) {
			return n % 2 === 0;
		}),
		3
	)
); // [4, 16, 36]

// Reproducible randomness (tests, simulations, procedural content).
const rng = createRandom('docs');
[rng.int(1, 6), rng.int(1, 6), rng.int(1, 6)]; // [3, 3, 5] on every platform
```

## UI helpers: fuzzy search, easing, CSS colors and diffs

```ts
import { diffSequences } from 'tinkit/arrays';
import { parseColor } from 'tinkit/color';
import { cssEase, interpolate } from 'tinkit/easing';
import { fuzzySearch, highlight } from 'tinkit/search';

// Command palette: rank matches, then render highlighted segments (no innerHTML needed).
const [best] = fuzzySearch(['Open File', 'Save File', 'Toggle Sidebar'], 'of');
highlight(best.key, best.ranges);
// [{ text: 'O', match: true }, { text: 'pen ', match: false }, { text: 'F', match: true }, { text: 'ile', match: false }]

// Animate with the exact CSS `ease` curve.
interpolate(0, 200, 0.5, cssEase); // 160.48…

// Parse any CSS color syntax.
parseColor('hsl(210 50% 40% / 0.5)'); // { r: 51, g: 102, b: 153, a: 0.5 }

// Minimal edit scripts (Myers' algorithm) for lists or strings.
diffSequences('kitten', 'sitting').filter(function (op) {
	return op.type !== 'equal';
}).length; // 5
```

## Decorators: memoize, debounce and bind class methods

The decorators detect at runtime which decorator style they were applied with. They work with all three:

- TypeScript `experimentalDecorators`.
- Babel's legacy plugin.
- TC39 standard decorators (TypeScript 5+ without `experimentalDecorators`).

```ts
import { memoize, bound, debounced, readonly } from 'tinkit/decorators';

class SearchBox {
	@readonly id = crypto.randomUUID(); // write-once: reassigning throws TypeError

	@debounced(250) // separate timer per instance
	search(query: string): void {}

	@bound // safe to pass as a callback
	onInput(event: Event): void {}

	@memoize // separate cache per instance
	score(term: string): number {}
}
```

> `@readonly` with `experimentalDecorators` requires `useDefineForClassFields: false`. That is the default for targets below ES2022. With define semantics the class field shadows the decorator's accessor.
