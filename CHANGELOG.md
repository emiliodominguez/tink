# Changelog

## 1.2.0

New helpers, each reviewed adversarially against its spec or reference implementation:

- **`encoding` (new module):** strict base64/base64url (`toBase64`, `fromBase64`, accepting exactly what `isBase64` accepts), hex (`toHex`, `fromHex`), WHATWG-exact UTF-8 (`encodeUtf8`, `decodeUtf8` with `fatal` and `stripBom`) and a synchronous `sha256`/`sha256Hex`, without `Buffer`; native `toBase64`/`fromBase64`/`toHex`/`fromHex`/`TextEncoder`/`TextDecoder` are used where they give identical results.
- **`async`:** `createBatcher`, DataLoader-style batching of every `load(key)` made until the microtask queue drains (after any number of `await`s): deduplicated keys, `maxBatchSize`, `delay`, per-key `Error`s, a clear `TypeError` for malformed results, per-call `signal`s with one abort listener per signal, and no cache by default (DataLoader's unbounded default leaks and goes stale); pass `cache: true` per request or an LRU, with single-flight requests, uncached errors and `clear` / `clearAll` / `prime`.
- **`validate`:** `parseEnv(schema, env?)` reports every missing or invalid environment variable at once, one per line, and no part of a value can reach the error, by construction: fixed messages and paths, other libraries' and custom messages become `Invalid value`, and a schema that throws is reported by its error name. Blank values count as unset by default, `prefix` maps `PORT` to `APP_PORT` / `VITE_PORT`, `strict` reports undeclared prefixed variables, and the output has a `null` prototype.
- **`url`:** typed route patterns: `matchPath` and `compilePath` (`/users/:id/:tab?`, `/@:handle`, `/files/*path`, optional segments), with parameters inferred from the pattern. Matching is linear in the pathname without a regular expression, decodes segments safely, rejects dot segments and traversal through encoded separators, and folds ASCII case only; building encodes values and guarantees the path matches back to the same parameters.
- **`objects`:** `replaceEqualDeep` (structural sharing like TanStack Query, linear on shared subtrees, safe on cycles) and JSON Patch (RFC 6902/6901): `createPatch`, an immutable, all-or-nothing `applyPatch` with structural sharing and prototype-safe pointers, `JsonPatchOperation` and `JsonPatchError`.
- **`date`:** IANA time zones without a bundled database: `isValidTimeZone` (narrowing to `TimeZone`), `getTimeZoneOffset`, `getZonedParts`, `fromZonedTime` (Temporal's disambiguation, and an exact round trip through `offset`), `formatInTimeZone` (the `formatDate` tokens plus `Z`/`ZZ`), `startOfDayInTimeZone` and `endOfDayInTimeZone`; they accept IANA names or `±HH:MM` offsets, never depend on the runtime's zone, and match Temporal on every transition of every zone from 1800 to 2100. `getCalendarMonth(year, monthIndex, { weekStartsOn, fixedWeeks })` gives date-picker grids.
- **`random`:** `uuidv7`/`createUuidv7` (RFC 9562, strictly increasing), `ulid`/`createUlid` (monotonic, throwing on overflow as the spec requires), and `uuidv7Timestamp`/`ulidTimestamp`; the clock and random source can be injected, and the defaults always use the CSPRNG.
- **`strings`:** `compareNatural` (a deterministic natural-order comparator: digit runs of any length, a total order, optional `ignoreCase`), `truncateMiddle` (grapheme-aware, with a `position`) and `stringWidth` (terminal columns: Unicode 17 East Asian Width, emoji sequences, ANSI escapes stripped; matches `string-width` on every assigned code point).
- **`math`:** `sumPrecise` (TC39 `Math.sumPrecise` semantics: exactly rounded and overflow-safe), `movingAverage` (exact running sums: no drift), `toSignificant` (significant figures, rounded as written) and `histogram` (d3-style bins with exact counts and correctly rounded edges).
- **`store`:** `createMachine`, a tiny typed state machine (states, context and event payloads inferred from the config; guards, context updates, `can`/`matches`, queued events from listeners, `useSyncExternalStore` snapshots), and `createHistory`, undo/redo for any store (`batch`, `coalesce` with an injectable clock, `limit`; a `createStore` change and its listeners' reactions are one step).
- **`color`:** OKLab/OKLCH: `toOklab`, `toOklch`, `oklabToRgb`, `oklchToRgb` (CSS Color 4 gamut mapping), `inGamut`, `toCssOklch`; `parseColor` reads `oklab()`/`oklch()` (as Tailwind v4's palette is written), `mix` takes `{ space: 'oklab' | 'oklch', hue }` like CSS `color-mix`, and `lighten`/`darken` take `{ space: 'oklch' }`. Defaults are unchanged; the string-parsing helpers grow by about 1.1 kB for the new syntax.
- **Fixed (`date`):** the day boundaries (`startOfDay`, `endOfDay`, `startOfMonth`…) of a day whose midnight fell in a DST gap that began the evening before (Toronto 1919), `endOfDay` when a day comes back hours after midnight (Alaska 1867), and `intervalToDuration`/`diffInMonths` across a skipped calendar day (Samoa 2011). Cached `Intl` formatters can no longer be corrupted by a polluted `Object.prototype`.
- **Fixed (`math`):** `average([MAX_VALUE, MAX_VALUE, MAX_VALUE])` returned `Infinity`.
- **Types:** byte-returning helpers (`fromBase64`, `encodeUtf8`, `sha256`, `randomBytes`…) return `Uint8Array<ArrayBuffer>`, so their results pass to `crypto.subtle` and `Blob`; checking the declarations (`skipLibCheck: false`) now needs TypeScript 5.7+.
- **Tests** run in six time zones (Apia and Havana added, for skipped days and midnights); the size budget is 92 kB gzipped runtime and 350 kB packed.

## 1.1.0

Zod-like schemas, without the dependency:

- **`validate`: `parse` / `safeParse`** take a plain object of guards and parsers, return a typed output with unknown keys stripped, and report every issue with its path (`ValidationError`). Object schemas compile to specialized code on first use (falling back to a loop where `new Function` is blocked, e.g. by a CSP), and the bundled benchmarks parse nested records 1.6× faster than zod 4.
- **Strict coercion:** `asNumber`, `asInteger`, `asBoolean` and `asDate` reject what `z.coerce` silently converts (`''` → `0`, `'false'` → `true`, `null` → `0`, `'2023-02-29'` → March 1st, unsafe integers).
- **Combinators:** `withDefault`, `optional`, `nullable`, `transform`, `chain` (zod's `.pipe()`), `arrayOf`, `tuple`, `recordOf` (with an optional key guard), `union`, `discriminatedUnion` (direct variant lookup, tag first in the output; 1.25× faster than zod on the bundled event benchmark), cycle-safe `lazy` (recursive unions stay linear in the size of the value, and a value too deep to parse fails with an issue instead of a `RangeError`), `exact` (reject unknown keys), `partial`, `check` (zod's `.refine()`, with a message and a path for rules across fields), `withFallback` (zod's `.catch()`), `withError` (one message of your own in place of a schema's issues, for form fields), and `toParser` to hand any schema to a Standard Schema consumer. Every parser is a Standard Schema validator, and Standard Schema validators (zod, valibot, ArkType…) can be nested in a schema.
- **Real-world input:** `asArray` (a repeated query parameter is a string or an array), `asList` (a comma-separated list in an environment variable), `asBigInt` (64-bit ids beyond `Number.MAX_SAFE_INTEGER`), `blankAsUndefined` (an empty form field counts as missing) and `asJson` (JSON in an environment variable, pollution-safe); `issuesByPath` (`guards`) turns issues into per-field messages.
- **`url`: `parseFormData`** reads `FormData` (or `URLSearchParams`, or any `[key, value]` pairs) like `parseQueryString` reads a query string: a repeated field, such as a group of checkboxes, is an array instead of its last value.
- **`guards`:** `isDiscriminatedUnion` (direct variant lookup, with the tag added to each variant's type), `isIntegerInRange`, `isStringOfLength` and `isStringMatching` (stateless with `g`/`y` regexes). Their failures are explained without echoing the rejected strings.
- **Fixed:** `isArrayOf` and `isTuple` read the holes of a sparse array through a polluted `Array.prototype` or `Object.prototype`; holes are now always checked as `undefined`.
- **Faster:** `isShape` (and the object patterns of `isMatching`) compile to specialized code like `parse`, about 3.5× faster (2.9× faster than zod 4 on the bundled benchmark); `isUrl` recognises plain `http(s)` URLs without the URL parser, about 5× faster (2.4× faster than zod's `z.url()`), with every other URL going through the full check as before.
- **Fixed:** a recursive `isUnion` (through `isLazy`) whose members are told apart deep inside a value took time exponential in its depth, to check and to explain: each lazy guard now checks an object once per check, and `explain` reports the closest member only (a nested `isUnion` now scores as its closest member). A value nested too deeply to check is rejected (`Value is nested too deeply`) instead of throwing a `RangeError`.
- **Hardening (three review passes over every module, each fix with a regression test):**
    - **No hangs:** `countSubString` with a non-string needle, binary searches past 2^31 items, `parseJson` under a polluted `Object.prototype`, path readers on a `Proxy` that is its own prototype, and `mapConcurrent` on hand-written sources all terminate now.
    - **No blow-ups:** `isEqual`, `isMatch` and `diff` handle subtrees shared by many paths once (they were exponential); reporting an invalid deep `lazy` value and trimming non-Latin text are linear (they were quadratic); huge sparse arrays are walked by their elements.
    - **Hostile signals:** `async`, `emitter` and `iterables` helpers settle and clean up when an `AbortSignal`-like object's methods or `reason` getter throw, instead of crashing from a timer.
    - **Prototype pollution and frozen prototypes:** lookup tables, `Intl` options and parsed objects never read inherited values; `safeParse`, `setPath` and `unflattenObject` work under a frozen `Object.prototype`; `secureRandom` never serves bytes from a failed refill.
    - **Numbers and dates:** `roundToStep` is exact from 2^52, `averageBy([1e308, 1e308])` and `standardDeviation([-1e308, 1e308])` stay finite, springs settle at extreme ratios, and end-of-day/week helpers handle skipped and repeated midnights (Samoa, St. John's, Havana, Lord Howe).
    - **Clones:** `deepClone` keeps errors as real errors, resizable buffers resizable, and views that reach the end of one length-tracking.
    - **Types:** `pipe`/`compose` reject mismatched steps at compile time, `emitter` wrappers generic over the event map compile again, `retry` takes `PromiseLike`, and standard decorators accept methods that declare `this`.
- **Stricter inputs (may surface bugs in callers):** a few helpers now throw a `TypeError` instead of coercing nonsense: `clamp` with non-number bounds, `levenshtein`, `similarity`, `removeDiacritics`, `isPalindrome` and `countSubString` with non-strings, `mask`/`truncate`/`wordWrap` with non-string options, a `memoize` cache missing its methods, `mapKeys` returning a non-key, `typedFromEntries` and `parseFormData` given entries that are not pairs, and `createLRUCache` with a clock that does not return a number.
- **Package size:** the runtime budget of `yarn check:size` is now 72 kB gzipped (was 64 kB) for the new validation layer, and the packed budget 300 kB (was 280 kB) for the documentation the type declarations and `llms-full.txt` carry; per-helper import costs are listed in [docs/SIZES.md](./docs/SIZES.md).

## 1.0.1

API clean-up shipped right after the first release (1.0.0 is deprecated; nothing depended on it yet):

- **Renamed** the path helpers to short, consistent names: `getPath`, `setPath`, `hasPath`, `deletePath`, `updatePath` and `omitPath` (were `getFromObjectByKeys`, `setInObjectByKeys`, `hasInObjectByKeys`, `deleteFromObjectByKeys`, `updateInObjectByKeys` and `omitInObjectByKeys`), and `removeDuplicates` to `unique`, matching `uniqueBy`, `uniqueWith` and `iterables.unique`.
- **Removed** the type-guard re-exports from `objects` (import guards from `tinkit/guards`) and the unused `DeepPartial`, `UnArray` and `NestedPick` types.
- **Docs:** new README banner, rendered from `docs/assets/banner.html`.

## 1.0.0

Initial release of **tinkit** (`npm install tinkit`): strictly typed, zero-dependency, tree-shakeable utilities, published as ESM for Node 20.19+ and modern browsers.

### Modules

- **Data:** `arrays` (ordering, grouping, set algebra, combinatorics, Myers diff), `objects` (clone, merge, defaults, equality, immutable path updates, key-case transforms, stable hashing), `iterables` (lazy sync and async pipelines).
- **Validation:** `guards` (type predicates that compose into path-aware, [Standard Schema](https://standardschema.dev) validators), `validate` (linear-time string validators and a safe `parseJson`).
- **Text and URLs:** `strings` (grapheme-aware case, padding, trimming, truncation, escaping), `url` (query strings, safe URL editing and sanitising), `search` (fuzzy matching with highlight ranges).
- **Numbers, time and colour:** `math`, `date` (DST-safe arithmetic, durations, strict parsing), `format` (cached `Intl` formatting), `color` (CSS parsing, mixing, WCAG contrast), `easing` (CSS-accurate curves, springs).
- **Control flow and state:** `functions` (debounce, throttle, memoize, exhaustive `match`), `async` (retry, queues, rate limiting, single-flight memoization, cancellable concurrency), `cache` (LRU with TTL, priority queue), `emitter`, `store`, `random` (seeded and cryptographic), `decorators`.

### Guarantees

- **Hostile input:** path, merge, clone and query-string helpers never read or write through `__proto__`, `constructor` or `Object.prototype`; every regular expression runs in linear time; validators reject look-alike hosts and invisible characters; helpers whose cost grows with input size document it ([SECURITY.md](./SECURITY.md)).
- **Edge cases:** compensated sums, decimal-correct rounding, total orderings (`NaN`, `null` and `undefined` sort last), grapheme-aware text, wall-clock date arithmetic across DST changes, async helpers that leak no timers, listeners or unhandled rejections.
- **Bundles:** one ESM file per module, no code runs at import time (`yarn check:treeshaking`), a median of 450 B per imported helper ([docs/SIZES.md](./docs/SIZES.md)).

### Quality gates

Run by the pre-push hook (`yarn validate`): lint, formatting, type checking, 3,600+ tests in four time zones with 100% statement and branch coverage, fast-check property tests, every JSDoc `@example` executed against the build, a smoke test of the built package, size and tree-shaking budgets, a type check of the published declarations, and export resolution checks. Mutation testing (`yarn test:mutation`) and property stress testing (`yarn test:stress`) run on demand.
