![tinkit: Small utilities. Solid foundations. A smiling pastel building block next to the wordmark tinkit, an npm i tinkit command and four facts: strictly typed, 0 dependencies, tree-shakeable, property-tested.](https://raw.githubusercontent.com/emiliodominguez/tinkit/main/docs/assets/tinkit-banner.png)

[![CI](https://img.shields.io/github/actions/workflow/status/emiliodominguez/tinkit/tests.yml?branch=main&style=for-the-badge&label=CI&labelColor=161b22&logo=githubactions&logoColor=white)](https://github.com/emiliodominguez/tinkit/actions/workflows/tests.yml)
[![TypeScript: strict](https://img.shields.io/badge/TS-strict-3178c6?style=for-the-badge&labelColor=161b22&logo=typescript&logoColor=white)](./tsconfig.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/deps-0-2ea44f?style=for-the-badge&labelColor=161b22&logo=npm&logoColor=white)](./package.json)
[![Property tests: fast-check](https://img.shields.io/badge/tests-fast--check-8250df?style=for-the-badge&labelColor=161b22&logo=jest&logoColor=white)](#how-its-tested)
[![License: MIT](https://img.shields.io/badge/license-MIT-3da639?style=for-the-badge&labelColor=161b22&logo=opensourceinitiative&logoColor=white)](./LICENSE)

**Strictly typed utilities for everyday JavaScript, with the edge cases handled.**

~885 tree-shakeable helpers · 23 modules · zero dependencies · a median of 555 B per import

```bash
npm install tinkit
```

```ts
import { orderBy } from 'tinkit/arrays';
import { isShape, isInteger, isString } from 'tinkit/guards';
import { retry } from 'tinkit/async';
```

ESM, fully typed (TypeScript 5.7+), Node 20.19+ and modern browsers. Each module is a deep import, so your bundle only contains the helpers you call.

> Node 20 reached end of life in April 2026. Its `Intl.Segmenter` takes quadratic time on long runs of combining marks, so the grapheme-aware string helpers (`stringWidth`, `truncateMiddle`, `reverse`, `padStart`, …) are slow on such untrusted text there; Node 22+ and current browsers segment in linear time.

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

Type guards narrow, compose into schemas, report every issue with its path, and plug into anything that speaks [Standard Schema](https://standardschema.dev) (tRPC, TanStack Form, React Hook Form, Hono…). No second validation library, and `isShape` checks objects about 3× faster than zod 4 parses them.

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

When the input needs converting as well as checking, `parse` takes a plain object of guards and parsers. Coercion is strict where `z.coerce` is not, and object schemas compile to specialized code: 1.4–2.5× faster than zod 4 on every bundled parse benchmark (`yarn build && yarn bench validate`):

```ts
import { isIntegerInRange, isOneOf } from 'tinkit/guards';
import { asBoolean, asInteger, chain, isUrl, parse, withDefault } from 'tinkit/validate';

const env = parse(
	{
		PORT: withDefault(chain(asInteger, isIntegerInRange(1, 65535)), 3000),
		DEBUG: withDefault(asBoolean, false), // 'false' is false, 'on' is true; z.coerce.boolean() turns 'false' into true
		MODE: isOneOf(['dev', 'prod']),
		DATABASE_URL: isUrl
	},
	process.env
); // { PORT: number; DEBUG: boolean; MODE: 'dev' | 'prod'; DATABASE_URL: string }, every other variable stripped
```

`asNumber('')` fails instead of returning `0`, `asInteger` rejects integers that would lose precision, and `asDate` rejects `'2023-02-29'` and offset-less local times. Every parser is a Standard Schema validator, and zod schemas can be nested inside. `union`, `discriminatedUnion`, `recordOf`, `tuple`, `lazy`, `exact` and `partial` cover the rest of zod's shapes; `asArray`, `asList`, `blankAsUndefined` and `asJson` handle repeated query parameters, comma-separated lists, empty form fields and JSON in environment variables; `check` adds rules across fields, `withError` words the message a form shows, `withFallback` replaces a bad value instead of failing, `asBigInt` reads 64-bit ids, and `issuesByPath` turns issues into per-field messages.

## Hostile input is a non-event

```ts
import { deepMerge, getPath } from 'tinkit/objects';
import { isAbsoluteUrl, sanitizeUrl } from 'tinkit/url';

deepMerge(defaults, JSON.parse('{"__proto__": {"isAdmin": true}}')); // key dropped, Object.prototype untouched
getPath(permissions, 'viewer.constructor', false); // false: inherited Object members never resolve
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

| Module                                        | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`arrays`](./docs/API.md#arrays)              | `orderBy`, `groupBy`, `partition`, `chunk`, top-N `takeFirstBy`, `sampleSize`, combinatorics, Myers `diffSequences`, set algebra (`…By`/`…With`), `toTree`/`flattenTree`, `compareBy`, `paginate`, `upsert`                                                                                                                                                                                                                     |
| [`objects`](./docs/API.md#objects)            | `deepClone`, `deepMerge`/`defaults`, `isEqual`/`isMatch`, immutable `updatePath`, `toCamelCaseKeys`, `stableStringify`/`hash`, `diff`, JSON Patch `createPatch`/`applyPatch`, `replaceEqualDeep`, never-throwing `safeStringify`                                                                                                                                                                                                |
| [`guards`](./docs/API.md#guards)              | 50+ predicates, `isShape`/`isUnion`/`isDiscriminatedUnion`/`isLazy`/`refine` schemas, `isStringOfLength`, `isMatching`, `explain`/`ensure`, `toStandardSchema`, `getType`, `isBrowser`/`isNode`/`isDeno`/`isBun`                                                                                                                                                                                                                |
| [`strings`](./docs/API.md#strings)            | every case style, grapheme-aware `padStart`/`trimChars`/`truncate`/`truncateMiddle`, `compareNatural`, terminal `stringWidth`, `stripAnsi`, `stripHtml`, `toSafeFilename`, `toSlug`, `dedent`/`indent`, `splitOnce`, `wordWrap`, `levenshtein`, `mask`                                                                                                                                                                          |
| [`math`](./docs/API.md#math)                  | precise `sum`/`round`/`ceil`/`floor`, `roundHalfEven`, exact `sumPrecise`, lossless `allocate`, `toFraction`, `quantile`, `variance`, `skewness`/`kurtosis`, `summarize`, `linearRegression`/`correlation`, `histogram`, `movingAverage`/`exponentialMovingAverage`, d3-style `ticks`/`niceDomain`, `primeFactors`, `modPow`, `binomial`, `findRoot`, `dot`/`cosineSimilarity`, `smoothstep`/`damp`, `formatBytes`/`parseBytes` |
| [`functions`](./docs/API.md#functions)        | `debounce`/`throttle` with `cancel`/`flush`, `memoize`, exhaustive `match`, `curry`, `pipe`/`pipeAsync`, F#-style `matchWith`/`matcher` (exhaustive, `when` guards, captures, active patterns), `allPass`/`anyPass`, `attempt` with `ok`/`err`/`mapResult`/`unwrap`, Ramda-style `when`/`unless`/`cond`                                                                                                                         |
| [`errors`](./docs/API.md#errors)              | `toError`/`getErrorMessage` for anything thrown, `serializeError`/`deserializeError` that round-trip through JSON (causes, `AggregateError`, cycles), typed `defineError` classes with cross-bundle guards, `getErrorChain`, readable `formatError` reports                                                                                                                                                                     |
| [`async`](./docs/API.md#async)                | `retry`, `withTimeout`, DataLoader-style `createBatcher`, priority `createQueue`, `createRateLimiter`, `memoizeAsync`, `createSemaphore`/`createMutex`/`createKeyedMutex`, `waitForEvent`, `fromEvent` async iteration, abortable `mapWithConcurrency`, `pollUntil`, `createCircuitBreaker`, AWS-jitter `backoff`, drift-free `interval`, `createStopwatch`                                                                     |
| [`date`](./docs/API.md#date)                  | DST-safe `addDuration`/`addMonths`, IANA time zones (`formatInTimeZone`, `fromZonedTime`, `getZonedParts`), `getCalendarMonth`, strict `parseDate`/`formatDate`, ISO weeks, `eachOfInterval`, `mergeIntervals`/`findGaps`, business days with holidays, cron schedules (`nextCronDate`, `eachCronDate`) with cronie's DST rules in any time zone                                                                                |
| [`format`](./docs/API.md#format)              | deterministic, cached Intl formatting: `formatCurrency`, `formatCompact`, `formatPercent`, `formatList`, `formatOrdinal`, …, and the strict, locale-aware inverse `parseNumber`                                                                                                                                                                                                                                                 |
| [`validate`](./docs/API.md#validate)          | ReDoS-safe predicates (`isEmail`, look-alike safe `isUrl`, `isUuid`, `isIP`, `isSemver`…), safe `parseJson`, zod-like `parse` with strict `asInteger`/`asBoolean`/`asDate`, `withDefault`, `parseEnv` that never leaks a value, and node-semver-exact `satisfiesSemver`/`compileSemverRange`/`maxSatisfyingSemver`/`incrementSemver`                                                                                            |
| [`color`](./docs/API.md#color)                | CSS `parseColor` (hex, `rgb()`, `hsl()`, `oklch()`, `oklab()`), OKLCH conversions with CSS gamut mapping, perceptual `mix` and `colorScale`, `lighten`/`darken`/`saturate`/`rotateHue`, opt-in named colours, WCAG `contrastRatio`, `getReadableTextColor`, `deltaE` (OK, CIEDE2000), stable `colorFromString` with guaranteed contrast, `simulateColorVisionDeficiency`                                                        |
| [`search`](./docs/API.md#search)              | `fuzzyMatch`/`fuzzySearch` with optimal scoring and highlight ranges and optional accent folding, `highlight` segments for rendering matches, a BM25 full-text `createSearchIndex` (field boosts, prefix, AND/OR, exact removal) and a Unicode `tokenize`                                                                                                                                                                       |
| [`easing`](./docs/API.md#easing)              | 33 tree-shakeable easings, tunable `power`/`back`/`elastic`/`bounce`, CSS-accurate `cubicBezier`/`steps`/`linear()`, any easing to CSS with `toCssLinear`, analytic `spring` with `velocity`, `interpolate`                                                                                                                                                                                                                     |
| [`encoding`](./docs/API.md#encoding)          | strict base64/base64url, base32, hex and UTF-8 without `Buffer`, RFC 4180 `parseCsv`/`toCsv`, `decodeJwt` and HS256 `signJwt`/`verifyJwt`, `timingSafeEqual`, synchronous `sha256`/`hmacSha256`, `crc32`                                                                                                                                                                                                                        |
| [`url`](./docs/API.md#url)                    | typed route patterns `matchPath`/`compilePath`, `buildQueryString`/`parseQueryString` (pollution-safe), `parseFormData`, `isSafeUrl`/`sanitizeUrl`, `normalizeUrl`, `parseCookie`/`serializeCookie`, `withQuery`, `joinUrl`, slash helpers                                                                                                                                                                                      |
| [`path`](./docs/API.md#path)                  | POSIX `normalizePath`, `joinPath`, `resolvePath`, `relativePath`, `parsePath`/`formatPath`, `basename`/`dirname`/`extname` for every runtime: byte for byte `node:path` posix, in linear time                                                                                                                                                                                                                                   |
| [`iterables`](./docs/API.md#iterables)        | lazy `map`/`filter`/`take`/`chunk`/`zip` over any (async) iterable, bounded `mapConcurrent` with backpressure, stream readers for `fetch` bodies and Node streams (`readLines`, spec-exact `parseSSE`, `parseNdjson`, `streamToText`/`streamToBytes`), `mergeAsync`, `bufferTime`                                                                                                                                               |
| [`cache`](./docs/API.md#cache)                | O(1) `createLRUCache` with TTL, size budgets (`maxSize`/`sizeOf`), eviction reasons and `getOrSet`, ring-buffer `createDeque` and `createRingBuffer`, stable binary-heap `createPriorityQueue`, radix-tree `createTrie` (prefix search, longest prefix), `createBloomFilter`, `createBiMap`, `createMultiMap`, `createDefaultMap`                                                                                               |
| [`emitter`](./docs/API.md#emitter)            | typed `createEmitter` with wildcard listeners, `once`, `waitFor` (timeout/abort) and error isolation                                                                                                                                                                                                                                                                                                                            |
| [`store`](./docs/API.md#store)                | `createStore` for `useSyncExternalStore` with cached `select()` stores, glitch-free `computed`, cross-store `batch`, `persistStore` (with cross-tab sync), typed state machines (`createMachine`), undo/redo `createHistory`                                                                                                                                                                                                    |
| [`random`](./docs/API.md#random)              | seeded `createRandom` (cross-platform deterministic), time-ordered `uuidv7`/`ulid`, secure `secureRandom`/`randomId`/`randomUUID`/`randomBytes`, `weightedRandom`                                                                                                                                                                                                                                                               |
| [`decorators`](./docs/API.md#decorators)      | `@memoize`/`@once` (per instance), `@bound`, `@debounced`, `@throttled`, `@retryable`, `@timeout`, `@readonly`, `@deprecated`, `@lazy` getters, `@measure`                                                                                                                                                                                                                                                                      |
| [types](./docs/API.md#types) (`tinkit/utils`) | type-fest style `PartialDeep`, `SetOptional`/`SetRequired`, `LiteralUnion`, branded `Tagged`, `RequireExactlyOne`, `Jsonify`, `IsEqual` …                                                                                                                                                                                                                                                                                       |

## Numbers

- **Size:** a median of 555 B per import, 5.7 kB at most, 158 kB gzipped for all 23 modules. The cost of every export is in [docs/SIZES.md](./docs/SIZES.md).
- **Speed:** benchmarked at 10, 1k and 100k items against the popular libraries with the same helpers. Results are in [docs/PERFORMANCE.md](./docs/PERFORMANCE.md) (`yarn bench`).

## How it's tested

5,400+ tests, run in six time zones before every push, with 100% statement and branch coverage. They include [fast-check](https://fast-check.dev) property tests for the laws behind each helper, every JSDoc example (2,000+ assertions) run against the build, and [mutation testing](./docs/mutation/README.md).

## Docs

[API reference](./docs/API.md) · [Recipes](./docs/RECIPES.md) · [Import sizes](./docs/SIZES.md) · [Performance](./docs/PERFORMANCE.md) · [Migrating from lodash](./docs/MIGRATING-FROM-LODASH.md) · [Security](./SECURITY.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [llms.txt](./llms.txt)

Every export also carries its full JSDoc, with examples, in your editor.

## License

[MIT](./LICENSE) © Emilio Dominguez
