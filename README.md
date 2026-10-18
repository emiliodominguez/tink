![tink — Small utilities. Solid foundations.](./docs/assets/tink-logo.svg)

[![CI](https://img.shields.io/github/actions/workflow/status/emiliodominguez/js-helpers/tests.yml?branch=main&style=for-the-badge&label=CI&labelColor=161b22&logo=githubactions&logoColor=white)](https://github.com/emiliodominguez/js-helpers/actions/workflows/tests.yml)
[![TypeScript: strict](https://img.shields.io/badge/TS-strict-3178c6?style=for-the-badge&labelColor=161b22&logo=typescript&logoColor=white)](./tsconfig.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/deps-0-2ea44f?style=for-the-badge&labelColor=161b22&logo=npm&logoColor=white)](./package.json)
[![Property tests: fast-check](https://img.shields.io/badge/tests-fast--check-8250df?style=for-the-badge&labelColor=161b22&logo=jest&logoColor=white)](#how-it-is-tested)
[![License: MIT](https://img.shields.io/badge/license-MIT-3da639?style=for-the-badge&labelColor=161b22&logo=opensourceinitiative&logoColor=white)](./LICENSE)

**Strictly typed utilities for everyday JavaScript, with the edge cases handled.**

~600 tree-shakeable helpers in 20 modules · zero dependencies · median import cost 450 B · ESM, Node 20.19+ and modern browsers

[Install](#install) · [Edge cases](#the-edge-cases) · [Tour](#a-quick-tour) · [Modules](#modules) · [Size](#what-it-costs) · [Speed](#speed) · [Testing](#how-it-is-tested) · [API](./docs/API.md) · [From lodash](./docs/MIGRATING-FROM-LODASH.md)

## Install

```bash
npm install @emiliodominguez/tink   # or: pnpm add / yarn add / bun add
```

```ts
import { orderBy } from '@emiliodominguez/tink/arrays';
import { isShape, isInteger, isString, ensure } from '@emiliodominguez/tink/guards';
```

Every module is a deep import (`@emiliodominguez/tink/<module>`), so bundlers keep only the helpers you call. A namespaced root entry exists too: `import { arrays, math } from '@emiliodominguez/tink'`.

ESM-only. On Node 20.19+ CommonJS code can still `require()` it. No DOM or Node types leak into the declarations; `Intl.Segmenter` is used when available, with a code-point fallback.

## The edge cases

Utility functions are easy to write and hard to get right at the edges: floats, `NaN`, emoji, DST, `__proto__`. The table below shows what popular libraries return for some of those inputs. It is not hand-written: `yarn build && yarn compare` recomputes every row against the installed versions.

| Case                   | Library             | Call                                                    | Library returns        | tink returns           |
| ---------------------- | ------------------- | ------------------------------------------------------- | ---------------------- | ---------------------- |
| Float sums             | `lodash@4.18.1`     | `sum([0.1, 0.2, 0.3])`                                  | `0.6000000000000001`   | `0.6`                  |
| Sorting with NaN       | `es-toolkit@1.52.0` | `orderBy(rows, ['v'])  // v: 2, NaN, 1, 3`              | `[2, NaN, 1, 3]`       | `[1, 2, 3, NaN]`       |
| Sorting with undefined | `remeda@2.52.0`     | `sortBy(rows, byV)  // v: 2, undefined, 1, 3`           | `[2, undefined, 1, 3]` | `[1, 2, 3, undefined]` |
| Hostile keys           | `es-toolkit@1.52.0` | `zipObject(['__proto__'], [{ isAdmin: true }]).isAdmin` | `true`                 | `undefined`            |
| Prototype pollution    | `radash@12.1.1`     | `set({}, '__proto__.polluted', true); ({}).polluted`    | `true`                 | `throws RangeError`    |
| Silent data loss       | `es-toolkit@1.52.0` | `toCamelCaseKeys({ user_id: 1, userId: 2 })`            | `{"userId":2}`         | `throws RangeError`    |
| Emoji padding          | `es-toolkit@1.52.0` | `pad('👍', 5, '*')`                                     | `"*👍**"`              | `"**👍**"`             |
| Emoji trimming         | `es-toolkit@1.52.0` | `trim('👍🏽x👍🏽', '👍')`                                   | `throws Error`         | `"👍🏽x👍🏽"`              |
| Unit parsing           | `bytes@3.1.2`       | `parse('1KiB')`                                         | `1`                    | `1024`                 |
| URL editing            | `ufo@1.6.4`         | `withTrailingSlash('/a?x=1')`                           | `"/a?x=1/"`            | `"/a/?x=1"`            |
| URL editing            | `ufo@1.6.4`         | `cleanDoubleSlashes('//cdn.example//a')`                | `"/cdn.example/a"`     | `"//cdn.example/a"`    |
| DST (New York)         | `date-fns@4.4.0`    | `startOfHour(01:30 EST on fall-back day)`               | `01:00:00 GMT-0400`    | `01:00:00 GMT-0500`    |
| DST (New York)         | `date-fns@4.4.0`    | `hours from 00:00 to 03:00 on fall-back day`            | `4`                    | `5`                    |
| Async memoization      | `es-toolkit@1.52.0` | `memoize(fetcher) after one transient failure`          | `throws Error`         | `"ok"`                 |

These are not special cases in tink: each behaviour is a tested invariant (total ordering for every sort, defined-not-assigned keys for every object writer, grapheme counting for every width, wall-clock arithmetic for every date helper).

## A quick tour

### Validate untrusted data without a schema library

Guards narrow types, compose into schemas, report every issue with its path, and plug into anything that speaks [Standard Schema](https://standardschema.dev) (tRPC, TanStack Form, React Hook Form, Hono…).

```ts
import { explain, isArrayOf, isInteger, isOneOf, isShape, isString, toStandardSchema, type Infer } from '@emiliodominguez/tink/guards';
import { parseJson } from '@emiliodominguez/tink/validate';

const isUser = isShape({ id: isInteger, email: isString, roles: isArrayOf(isOneOf(['admin', 'editor'])) });
type User = Infer<typeof isUser>; // { id: number; email: string; roles: ('admin' | 'editor')[] }

explain(isUser, { id: '7', roles: ['admin', 'root'] });
// [{ path: ['id'], message: 'Invalid value (got string)' },
//  { path: ['email'], message: 'Missing required property' },
//  { path: ['roles', 1], message: 'Expected one of 2 allowed values (got string)' }]

const [error, user] = parseJson(body, isUser); // never throws: a typed User, or a SyntaxError / ValidationError
parseJson('{"__proto__": {"isAdmin": true}}'); // [SyntaxError: JSON contains a forbidden "__proto__" key, undefined]

const schema = toStandardSchema(isUser); // hand it to your form or RPC library
```

### Safe on hostile input

```ts
import { deepMerge, getFromObjectByKeys } from '@emiliodominguez/tink/objects';
import { isAbsoluteUrl, sanitizeUrl } from '@emiliodominguez/tink/url';

deepMerge(defaults, JSON.parse('{"__proto__": {"isAdmin": true}}')); // the key is dropped; Object.prototype is untouched
getFromObjectByKeys(permissions, 'viewer.constructor', false); // false: never resolves inherited Object members

sanitizeUrl(' JAVASCRIPT:alert(1)'); // 'about:blank' (parsed like a browser: whitespace, tabs and case don't help)
isAbsoluteUrl('/\\evil.com'); // true: browsers resolve it to https://evil.com, so it is not a safe relative redirect
```

Every regex is linear-time, validators reject look-alike hosts and invisible characters, and inputs whose cost grows with their size say so in their docs. Details in the [security policy](./SECURITY.md).

### Async without the usual footguns

```ts
import { createQueue, createRateLimiter, mapWithConcurrency, memoizeAsync } from '@emiliodominguez/tink/async';

const getUser = memoizeAsync(fetchUser, { ttl: 60_000 }); // concurrent calls share one request; failures are never cached
const limiter = createRateLimiter({ limit: 10, interval: 1_000 }); // sliding window: calls queue instead of being dropped
const queue = createQueue({ concurrency: 4 }); // priorities, pause/resume, onIdle()

await queue.add(uploadAvatar, { priority: 10, signal }); // aborting removes it from the queue
await mapWithConcurrency(urls, fetchPage, { concurrency: 8, signal }); // stops scheduling and rejects with signal.reason
```

### Dates that survive month ends and DST

```ts
import { addDuration, formatDate, intervalToDuration, parseDate } from '@emiliodominguez/tink/date';

formatDate(addDuration(new Date(2024, 0, 31), { months: 1, days: 1 }), 'YYYY-MM-DD'); // '2024-03-01' (Feb 29, then one day)
intervalToDuration(new Date(2024, 0, 31), new Date(2024, 2, 1, 12)); // { years: 0, months: 1, days: 1, hours: 12, … }
parseDate('2023-02-29', 'YYYY-MM-DD'); // undefined: strict inverse of formatDate, no rollover to March 1st
```

`addDuration(start, intervalToDuration(start, end))` returns `end` exactly, in every time zone: it is a property test, run in four zones.

### Text that respects emoji, and keys that keep their types

```ts
import { padStart, reverse } from '@emiliodominguez/tink/strings';
import { toCamelCaseKeys } from '@emiliodominguez/tink/objects';
import { orderBy, takeFirstBy } from '@emiliodominguez/tink/arrays';
import { match } from '@emiliodominguez/tink/functions';

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

<details>
<summary>More recipes: retries, caching, state, events, lazy iterables, colors, fuzzy search, decorators</summary>

<h4>Everyday helpers: typed data, retries, dates and formatting</h4>

These integration snippets use application-provided values such as `user`, `defaults`, `userInput`, `url`, `urls`, `input`, `fetchPage` and `persist`.

```ts
import { getFromObjectByKeys, deepMerge } from '@emiliodominguez/tink/objects';
import { isDefined } from '@emiliodominguez/tink/guards';
import { retry, withTimeout, mapWithConcurrency } from '@emiliodominguez/tink/async';
import { debounce } from '@emiliodominguez/tink/functions';
import { addMonths, formatDate } from '@emiliodominguez/tink/date';
import { getReadableTextColor } from '@emiliodominguez/tink/color';
import { formatCompact, formatCurrency } from '@emiliodominguez/tink/format';
import { compareSemver, isEmail } from '@emiliodominguez/tink/validate';
import { withQuery } from '@emiliodominguez/tink/url';

// Type-safe deep access: the return type is inferred from the path.
const city = getFromObjectByKeys(user, 'address.city', 'Unknown'); // string

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

<h4>Application building blocks: caching, events, state and lazy iterables</h4>

The caching example wraps your application's `fetchUser` function. The remaining examples are self-contained.

```ts
import { createLRUCache } from '@emiliodominguez/tink/cache';
import { createEmitter } from '@emiliodominguez/tink/emitter';
import { memoize } from '@emiliodominguez/tink/functions';
import { count, filter, map, take, toArray } from '@emiliodominguez/tink/iterables';
import { createRandom } from '@emiliodominguez/tink/random';
import { createStore } from '@emiliodominguez/tink/store';

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

<h4>UI helpers: fuzzy search, easing, CSS colors and diffs</h4>

```ts
import { diffSequences } from '@emiliodominguez/tink/arrays';
import { parseColor } from '@emiliodominguez/tink/color';
import { cssEase, interpolate } from '@emiliodominguez/tink/easing';
import { fuzzySearch, highlight } from '@emiliodominguez/tink/search';

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

<h4>Decorators: memoize, debounce and bind class methods</h4>

The decorators detect at runtime which decorator style they were applied with. They work with all three:

- TypeScript `experimentalDecorators`.
- Babel's legacy plugin.
- TC39 standard decorators (TypeScript 5+ without `experimentalDecorators`).

```ts
import { memoize, bound, debounced, readonly } from '@emiliodominguez/tink/decorators';

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

</details>

## Modules

| Module                                   | Highlights                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`arrays`](./docs/API.md#arrays)         | `orderBy`, `groupBy`, `partition`, `chunk`, top-N `takeFirstBy`, `sampleSize`, combinatorics, Myers `diffSequences`, set algebra (`…By`/`…With`) |
| [`objects`](./docs/API.md#objects)       | `deepClone`, `deepMerge`/`defaults`, `isEqual`/`isMatch`, immutable `updateInObjectByKeys`, `toCamelCaseKeys`, `stableStringify`/`hash`, `diff`  |
| [`guards`](./docs/API.md#guards)         | 50+ predicates, `isShape`/`isUnion`/`isLazy`/`refine` schemas, `isMatching`, `explain`/`ensure`, `toStandardSchema`, `assertNever`               |
| [`strings`](./docs/API.md#strings)       | every case style, grapheme-aware `padStart`/`trimChars`/`truncate`, `toSlug`, `dedent`, `wordWrap`, `levenshtein`, `mask`, `escapeHtml`          |
| [`math`](./docs/API.md#math)             | precise `sum`/`round`/`ceil`/`floor`, `quantile`, `variance`, `clamp`/`lerp`, `formatBytes`/`parseBytes`, Miller–Rabin `isPrime`                 |
| [`functions`](./docs/API.md#functions)   | `debounce`/`throttle` with `cancel`/`flush`, `memoize`, exhaustive `match`, `curry`, `pipe`, `allPass`/`anyPass`, `attempt`                      |
| [`async`](./docs/API.md#async)           | `retry`, `withTimeout`, priority `createQueue`, `createRateLimiter`, `memoizeAsync`, abortable `mapWithConcurrency`, `pollUntil`                 |
| [`date`](./docs/API.md#date)             | DST-safe `addDuration`/`addMonths`, `intervalToDuration`, strict `parseDate`/`formatDate`, ISO weeks, `toISOStringLocal`, `eachOfInterval`       |
| [`format`](./docs/API.md#format)         | deterministic, cached Intl formatting: `formatCurrency`, `formatCompact`, `formatPercent`, `formatList`, `formatOrdinal`, …                      |
| [`validate`](./docs/API.md#validate)     | ReDoS-safe predicates: `isEmail`, `isUrl` (look-alike safe), `isUuid`, `isIP`, `isSemver`, Luhn, base64, and safe `parseJson(text, guard)`       |
| [`color`](./docs/API.md#color)           | CSS `parseColor` (hex, `rgb()`, `hsl()`), `mix`, `lighten`/`darken`, WCAG `contrastRatio`, `getReadableTextColor`, `meetsContrast`               |
| [`search`](./docs/API.md#search)         | `fuzzyMatch`/`fuzzySearch` with optimal scoring and highlight ranges, `highlight` segments for rendering matches                                 |
| [`easing`](./docs/API.md#easing)         | 31 tree-shakeable easings, CSS-accurate `cubicBezier`/`steps`, analytic `spring`, `interpolate`                                                  |
| [`url`](./docs/API.md#url)               | `buildQueryString`/`parseQueryString` (pollution-safe), `isSafeUrl`/`sanitizeUrl`, `withQuery`, `joinUrl`, `withBase`, slash helpers             |
| [`iterables`](./docs/API.md#iterables)   | lazy `map`/`filter`/`take`/`chunk`/`zip` over any (async) iterable, bounded `mapConcurrent` with backpressure                                    |
| [`cache`](./docs/API.md#cache)           | O(1) `createLRUCache` with TTL and eviction reasons, stable binary-heap `createPriorityQueue`                                                    |
| [`emitter`](./docs/API.md#emitter)       | typed `createEmitter` with wildcard listeners, `once`, `waitFor` (timeout/abort) and error isolation                                             |
| [`store`](./docs/API.md#store)           | `createStore` for `useSyncExternalStore`, with equality-gated updates and cached `select()` stores                                               |
| [`random`](./docs/API.md#random)         | seeded `createRandom` (cross-platform deterministic), secure `secureRandom`/`randomId`/`randomUUID`/`randomBytes`, `weightedRandom`              |
| [`decorators`](./docs/API.md#decorators) | `@memoize`/`@once` (per instance), `@bound`, `@debounced`, `@throttled`, `@retryable`, `@timeout`, `@readonly`, `@deprecated`                    |

Every export has full JSDoc (parameters, errors, executable examples) available on hover. **[Full API reference](./docs/API.md)** · [llms.txt](./llms.txt) for AI assistants.

## What it costs

Bundlers keep only the helpers you import. What one import adds to a bundle on its own (minified + gzip, measured with esbuild):

| Helper                        | lodash |   tink |
| ----------------------------- | -----: | -----: |
| `debounce`                    | 1.1 kB |  706 B |
| `get` / `getFromObjectByKeys` | 2.4 kB |  497 B |
| `groupBy`                     | 6.2 kB |  288 B |
| `orderBy`                     | 6.4 kB |  932 B |
| `camelCase` / `toCamelCase`   | 2.7 kB |  744 B |
| `cloneDeep` / `deepClone`     | 5.0 kB | 1.4 kB |
| `isEqual`                     | 4.5 kB | 1.6 kB |
| `merge` / `deepMerge`         | 4.5 kB | 1.2 kB |

Across [150 lodash equivalents](./docs/MIGRATING-FROM-LODASH.md): 373 kB for lodash vs 70 kB for tink, imported one at a time. [docs/SIZES.md](./docs/SIZES.md) lists the cost of all ~600 exports (median 450 B, largest 2.7 kB). All 20 modules together are 57 kB gzipped, with no runtime dependencies; `yarn check:size` and `yarn check:treeshaking` keep it that way.

## Speed

Each helper with an equivalent in a popular library is benchmarked against it at 10, 1k and 100k items (`yarn build && yarn bench`). Last full idle-machine run, Node 22, ratios above 1 mean tink is faster:

| Compared with | Cases | Median speed ratio | At par or faster |
| ------------- | ----: | -----------------: | ---------------: |
| lodash        |   206 |              1.66× |              90% |
| es-toolkit    |   210 |              1.01× |              71% |
| date-fns      |    21 |              2.32× |              90% |
| fuse.js       |     7 |               ~29× |             100% |
| mitt          |     7 |              1.65× |              71% |
| nanoid        |     3 |              0.84× |               0% |

Newer helpers were measured per module: `createQueue` runs 4–9× faster than p-queue, `takeFirstBy` 6–13× faster than remeda, `parseDate` about 9× faster than date-fns' `parse`.

<details>
<summary>Where tink is slower, and why</summary>

Most remaining gaps exist because tink does more work for correctness:

- **`strings.reverse`, `truncate`, `getWords`:** they keep grapheme clusters intact, so emoji such as 👍🏽 and combining marks survive.
- **`math.sum` and `math.round`:** `sum` uses compensated summation (`sum([0.1, 0.2, 0.3]) === 0.6`), and `round` is decimal-correct (`round(1.005, 2) === 1.01`).
- **`isDate`, `isMap` and the other guards:** a brand check rejects fakes such as `Object.create(Date.prototype)` and accepts instances from other realms.
- **`difference`, `flattenDeep`, `clone` of arrays:** they deduplicate, detect cycles, and keep holes and extra keys.
- **`randomId`:** it reads the live `crypto` object on every call, so mocks and the "no CSPRNG → throw" rule always apply.

Each remaining gap is tracked in the benchmark files, and the hot paths skip the extra work whenever it is provably unnecessary.

</details>

## How it is tested

- **3,672 tests**, run in four time zones (UTC, New York, Lord Howe, Kolkata) before every push, with **100% statement and branch coverage** enforced.
- **Property tests** ([fast-check](https://fast-check.dev)) for the laws behind each helper: `parseBytes(formatBytes(n)) === n`, `deepClone(x)` equals `x` and shares nothing with it, `addDuration(a, intervalToDuration(a, b))` is `b`, every sort is total and stable.
- **Executable docs:** all 1,426 assertions in the JSDoc `@example`s run against the build (`yarn test:docs`).
- **Mutation testing** with [Stryker](https://stryker-mutator.io): the tests must catch injected bugs, not just run the code. Surviving mutants are [reviewed and documented](./docs/mutation/README.md).
- **Package checks:** the built tarball is smoke-tested, its type declarations compile for a plain ES2022 consumer, its exports are checked with are-the-types-wrong, and no module runs code at import time.
- **Adversarial review:** prototype pollution, ReDoS, resource exhaustion and validator bypasses, each finding pinned by a regression test. See [SECURITY.md](./SECURITY.md).

```bash
yarn validate   # lint, types, tests in 4 time zones, doctests, build, dist smoke test, size, tree-shaking, exports
yarn compare    # recompute the edge-case table above (after yarn build)
yarn bench      # benchmarks against the competitors (after yarn build)
```

## Migrating from 1.x

Version 2 introduces ESM-only packaging, stricter types and corrected edge-case behavior. Review these changes before upgrading.

<details>
<summary>Read the 1.x to 2.x migration notes</summary>

**arrays**

- `first`/`last` are now typed `T | undefined`.
- `contains` now finds `NaN`.

**objects**

- `clone` keeps arrays as arrays (it used to turn them into objects).
- `hasProperty` only checks **own** properties. `hasProperty({}, 'toString')` is now `false`.
- `getFromObjectByKeys` no longer throws on missing paths, and accepts an optional default value. Its second generic parameter is now the path, so let TypeScript infer it instead of writing `getFromObjectByKeys<T, R>(…)`.
- The `is*` type checks moved to `guards` and are now real type predicates. They are still re-exported from `objects`.

**strings**

- `replace` and `countSubString` treat the search text literally. They no longer build a regex from it.
- `countSubString` is now case-sensitive. Pass `{ ignoreCase: true }` for the old behaviour.
- `toSnakeCase`/`toCamelCase` now split camelCase, acronyms and punctuation, not just single spaces.
- `toNumber('')` returns `NaN`, not `0`.
- `toBoolean` also accepts `'1'`, `'yes'`, `'y'` and `'on'`.

**math**

- `modulo` is now a true floored modulo: `modulo(-1, 3) === 2`. The old `%` behaviour is available as `remainder`.
- `round` rounds halves away from zero, so `round(-2.5) === -3`.
- `factorial`, `round`, `randomIntBetween` and similar functions throw `RangeError` on invalid input instead of overflowing the stack or returning `NaN`.

**functions**

- All wrappers preserve `this`.
- `memoize` now caches falsy results.
- `debounce`/`throttle` return the latest result and expose `cancel()`.

**decorators**

- `@memoize` keeps a separate cache per instance. Previously all instances shared one cache.
- `@readonly` now works.

**Imports**

- The root entry exports namespaces (`import { strings } from …`). Use deep imports to get individual functions.
- The package is ESM-only and requires Node 20.19+. CommonJS code on those versions can still `require()` it.
- `guards` checks for built-ins (`isMap`, `isDate`, …) verify internal slots, so objects built with `Object.create(Map.prototype)`, and proxies of real instances, are no longer accepted.
- `memoize` cache keys now tell `NaN`, `Infinity`, `-0` and `undefined` apart. Previously they collided.

</details>

## Contributing

Start with the [contributing guide](./CONTRIBUTING.md). Behaviour changes need a regression test and, where it applies, a property test.

[Report a bug](https://github.com/emiliodominguez/js-helpers/issues) · [Changelog](./CHANGELOG.md) · [Security policy](./SECURITY.md)

## License

[MIT](./LICENSE) © Emilio Dominguez
