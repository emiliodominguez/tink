![tink — Small utilities. Solid foundations.](./docs/assets/tink-logo.svg)

[![CI](https://img.shields.io/github/actions/workflow/status/emiliodominguez/js-helpers/tests.yml?branch=main&style=for-the-badge&label=CI&labelColor=161b22&logo=githubactions&logoColor=white)](https://github.com/emiliodominguez/js-helpers/actions/workflows/tests.yml)
[![TypeScript: strict](https://img.shields.io/badge/TS-strict-3178c6?style=for-the-badge&labelColor=161b22&logo=typescript&logoColor=white)](./tsconfig.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/deps-0-2ea44f?style=for-the-badge&labelColor=161b22&logo=npm&logoColor=white)](./package.json)
[![Property tests: fast-check](https://img.shields.io/badge/tests-fast--check-8250df?style=for-the-badge&labelColor=161b22&logo=jest&logoColor=white)](#how-its-tested)
[![License: MIT](https://img.shields.io/badge/license-MIT-3da639?style=for-the-badge&labelColor=161b22&logo=opensourceinitiative&logoColor=white)](./LICENSE)

**Strictly typed utilities for everyday JavaScript, with the edge cases handled.**

~600 tree-shakeable helpers · 20 modules · zero dependencies · a median of 450 B per import

```bash
npm install tinkit
```

```ts
import { orderBy } from 'tinkit/arrays';
import { isShape, isInteger, isString } from 'tinkit/guards';
import { retry } from 'tinkit/async';
```

ESM, fully typed, Node 20.19+ and modern browsers. Each module is a deep import, so your bundle only contains the helpers you call.

## The edge cases

Floats, `NaN`, emoji, daylight saving, `__proto__`: where utility functions usually break. What a popular implementation returns for each input, next to tink:

| Case                | Call                                                    | A popular implementation returns | tink returns        |
| ------------------- | ------------------------------------------------------- | -------------------------------- | ------------------- |
| Float sums          | `sum([0.1, 0.2, 0.3])`                                  | `0.6000000000000001`             | `0.6`               |
| Sorting with NaN    | `orderBy(rows, ['v'])  // v: 2, NaN, 1, 3`              | `[2, NaN, 1, 3]`                 | `[1, 2, 3, NaN]`    |
| Hostile keys        | `zipObject(['__proto__'], [{ isAdmin: true }]).isAdmin` | `true`                           | `undefined`         |
| Prototype pollution | `set({}, '__proto__.polluted', true); ({}).polluted`    | `true`                           | `throws RangeError` |
| Silent data loss    | `toCamelCaseKeys({ user_id: 1, userId: 2 })`            | `{"userId":2}`                   | `throws RangeError` |
| Emoji padding       | `pad('👍', 5, '*')`                                     | `"*👍**"`                        | `"**👍**"`          |
| Unit parsing        | `parse('1KiB')`                                         | `1`                              | `1024`              |
| URL editing         | `withTrailingSlash('/a?x=1')`                           | `"/a?x=1/"`                      | `"/a/?x=1"`         |
| DST (New York)      | `hours from 00:00 to 03:00 on fall-back day`            | `4`                              | `5`                 |
| Async memoization   | `memoize(fetcher) after one transient failure`          | `throws Error`                   | `"ok"`              |

None of these are hand-written: `yarn build && yarn compare` recomputes every row against the installed libraries and prints which library returned what. In tink each behaviour is a tested invariant, not a special case.

## Guards are validators

Type guards narrow, compose into schemas, report every issue with its path, and plug into anything that speaks [Standard Schema](https://standardschema.dev) (tRPC, TanStack Form, React Hook Form, Hono…). No second validation library.

```ts
import { explain, isArrayOf, isInteger, isOneOf, isShape, isString, toStandardSchema, type Infer } from 'tinkit/guards';
import { parseJson } from 'tinkit/validate';

const isUser = isShape({ id: isInteger, email: isString, roles: isArrayOf(isOneOf(['admin', 'editor'])) });
type User = Infer<typeof isUser>; // { id: number; email: string; roles: ('admin' | 'editor')[] }

explain(isUser, { id: '7', roles: ['admin', 'root'] });
// [{ path: ['id'], message: 'Invalid value (got string)' },
//  { path: ['email'], message: 'Missing required property' },
//  { path: ['roles', 1], message: 'Expected one of 2 allowed values (got string)' }]

const [error, user] = parseJson(body, isUser); // never throws: a typed User, or a SyntaxError / ValidationError
const schema = toStandardSchema(isUser); // for your form or RPC library
```

## Hostile input is a non-event

```ts
import { deepMerge, getFromObjectByKeys } from 'tinkit/objects';
import { isAbsoluteUrl, sanitizeUrl } from 'tinkit/url';

deepMerge(defaults, JSON.parse('{"__proto__": {"isAdmin": true}}')); // key dropped, Object.prototype untouched
getFromObjectByKeys(permissions, 'viewer.constructor', false); // false: inherited Object members never resolve
sanitizeUrl(' JAVASCRIPT:alert(1)'); // 'about:blank': parsed the way a browser parses it
isAbsoluteUrl('/\\evil.com'); // true: browsers send it to evil.com, so it is not a safe relative redirect
```

Every regex runs in linear time, validators reject look-alike hosts and invisible characters, and helpers whose cost grows with input size document it. See the [security policy](./SECURITY.md).

## Async that cleans up after itself

```ts
import { createQueue, createRateLimiter, mapWithConcurrency, memoizeAsync } from 'tinkit/async';

const getUser = memoizeAsync(fetchUser, { ttl: 60_000 }); // concurrent calls share one request; failures are never cached
const limiter = createRateLimiter({ limit: 10, interval: 1_000 }); // sliding window; calls queue instead of being dropped
const queue = createQueue({ concurrency: 4 }); // priorities, pause/resume, onIdle()

await mapWithConcurrency(urls, fetchPage, { concurrency: 8, signal }); // abort stops scheduling and rejects with signal.reason
```

No leaked timers or listeners, no unhandled rejections: each of these is a test.

More examples, including dates, text and decorators, are in [Recipes](./docs/RECIPES.md).

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

## Numbers

- **Size:** a median of 450 B per import, 2.7 kB at most, 57 kB gzipped for all 20 modules. The cost of every export is in [docs/SIZES.md](./docs/SIZES.md).
- **Speed:** benchmarked at 10, 1k and 100k items against the popular libraries with the same helpers. Results are in [docs/PERFORMANCE.md](./docs/PERFORMANCE.md) (`yarn bench`).

## How it's tested

3,673 tests, run in four time zones before every push, with 100% statement and branch coverage. They include [fast-check](https://fast-check.dev) property tests for the laws behind each helper, all 1,426 JSDoc example assertions run against the build, and [mutation testing](./docs/mutation/README.md).

## Docs

[API reference](./docs/API.md) · [Recipes](./docs/RECIPES.md) · [Import sizes](./docs/SIZES.md) · [Performance](./docs/PERFORMANCE.md) · [Migrating from lodash](./docs/MIGRATING-FROM-LODASH.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [llms.txt](./llms.txt)

Every export also carries its full JSDoc, with examples, in your editor.

## License

[MIT](./LICENSE) © Emilio Dominguez
