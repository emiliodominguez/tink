# Changelog

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
