# Changelog

## Unreleased

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
