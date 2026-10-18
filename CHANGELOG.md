# Changelog

## 2.0.0

Full review and rewrite: every module is strictly typed, documented with complete JSDoc, and covered by example-based and property-based tests.

### Added

- **New modules:** `guards`, `async`, `date`, `color`, `url`, `iterables`, `cache`, `emitter`, `store`, `random`, `format`, `validate`, `search` and `easing`. The `date` module replaces an empty stub.
- **~350 new utilities**, including:
    - AbortSignal combinators (`anySignal`, `timeoutSignal`, `abortable`);
    - CSS color parsing (`parseColor`, `toCssRgb`, `toCssHsl`);
    - Myers sequence diff (`diffSequences`, `longestCommonSubsequence`).

    The full list is in [docs/API.md](./docs/API.md).

- **Packaging:**
    - ESM-only, minified, unbundled build (one file per module), with JSDoc kept in the declarations;
    - `exports` map with per-module deep imports;
    - namespaced root entry;
    - declaration maps.
- **Docs:**
    - API reference generated from the JSDoc (`yarn docs:api`) and a TypeDoc site (`yarn docs`);
    - every JSDoc `@example` is executed and asserted (`yarn test:docs`). This caught four examples that were wrong.
- **Local quality gate:** a pre-push hook runs `yarn validate`, which covers the tests in four time zones, the doctests and the dist checks.
- **CI:**
    - runs on Node 20–26 and in DST-heavy time zones;
    - smoke-tests the built package;
    - checks type resolution with are-the-types-wrong;
    - enforces a size budget.
- **Toolchain:** TypeScript 6, Jest 30, ESLint 10 (flat config), esbuild for the runtime build.

- **Schema validation from guards** (`guards`): `isShape` (with `exact`), `isUnion`, `isTuple`, `isOptional`, `isNullable`, `withMessage` and the `Infer` type; `explain` returns every issue with its path, `ensure` throws a `ValidationError`, and `toStandardSchema` turns any guard into a [Standard Schema](https://standardschema.dev) v1 validator for tRPC, TanStack Form, Hono and the rest of the ecosystem. `isArrayOf`, `isRecordOf` and `isOneOf` report per-element issues too.
- `random.secureRandom` (a 53-bit `crypto.getRandomValues` generator for every `random` parameter), `createLimiter({ maxPending })`, `diffSequences`/`longestCommonSubsequence` `{ maxEdits }`, `unflattenObject({ arrayLimit })`, `@memoize({ resolver, createCache })`.
- **Docs:** [lodash migration guide](./docs/MIGRATING-FROM-LODASH.md) and the [import cost of every export](./docs/SIZES.md) (`yarn docs:sizes`); `llms.txt` and `llms-full.txt` for AI coding assistants, shipped in the package; [security policy](./SECURITY.md).
- **Release pipeline:** npm trusted publishing (OIDC, no token) from a job that runs no project code, actions pinned to commit SHAs, least-privilege permissions, tags must point at `main`; Dependabot and CODEOWNERS.

### Security

An adversarial review (prototype pollution, ReDoS, resource exhaustion, validator bypasses, injection) found and fixed:

- **objects:** `getFromObjectByKeys`, `getProperty`, `hasInObjectByKeys` and `pick` never resolve `__proto__`, `constructor`, `prototype` or members inherited from `Object.prototype` (`'viewer.constructor'` used to be truthy); `deleteFromObjectByKeys` and `setProperty(obj, '__proto__')` throw like the path setters; `unflattenObject`/`setInObjectByKeys` create objects instead of 4-billion-slot sparse arrays for huge indexes; stack-depth limits are documented.
- **url:** `isAbsoluteUrl` normalises like browsers (`/\evil.com`, ` //evil.com`, `https:evil.com` are absolute; `javascript://` is not); `joinUrl` can no longer produce protocol-relative or scheme-injected results; `withQuery` replaces `key[]` parameters (no parameter pollution).
- **validate:** `isUrl` rejects invisible/format characters, look-alike (NFKC-unstable) and percent-encoded hosts, ideographic dots, backslashes in the authority, empty labels and non-canonical numeric hosts; `isBase64` only accepts canonical encodings; `isCreditCardNumber` rejects all-zero numbers.
- **strings:** `escapeHtml`/`unescapeHtml` always return strings (an array query value was returned unescaped); `escapeRegExp` follows TC39 `RegExp.escape` (safe inside classes and with the `v` flag); `mask` no longer reveals secrets shorter than the visible window; `toNumber` accepts exactly what `isNumericString` accepts.
- **Denial of service:** `formatDate` tokenizes patterns in linear time (was quadratic); `fuzzyMatch` rejects impossible queries before allocating (was gigabytes); `isPrime` uses deterministic Miller–Rabin (311 ms → 0.1 ms worst case); `retry` always yields to the event loop (infinite retries of a throwing function froze the thread); `windowed`/`cartesianProduct` check output sizes before allocating; template, pattern and locale caches skip keys over 1 kB.
- **Consistency:** math aggregates coerce numeric strings once (`sum(['1','2'])` was `'012'`); `weightedRandom` rejects non-number weights; `sleep`/`retry`/`pollUntil` validate signals up front; `memoize` keys distinguish dates from strings and key class instances, errors, functions and symbols by identity; `@memoize`/`@once` no longer share state across detached calls; error messages truncate quoted input; `assertNever` never serialises the whole value.

### Fixed

**arrays**

- `contains` never found `NaN`.
- `flatten` had the wrong types and was quadratic.

**objects**

- `merge` didn't compile for objects with different keys.
- `clone` turned arrays into objects.
- `hasProperty` matched inherited keys.
- `getFromObjectByKeys` threw on missing paths.

**strings**

- `replace` and `countSubString` built a regex from the search text, which allowed regex injection.
- `reverse` and `capitalize` broke emoji and surrogate pairs.
- The case converters only split on single spaces.
- `toSlug` dropped accented letters.

**math**

- `round` returned `NaN` for numbers written in exponential notation.
- `factorial` overflowed the stack on negative input.
- `max` and `min` threw on large arrays.
- `log(1000, 10)` returned 2.9999999999999996.

**functions**

- `compose()` threw when given no functions.
- `memoize` never served cached falsy results.
- Every wrapper lost `this`.

**decorators**

- `@memoize` shared one cache across all instances.
- `@readonly` did nothing.

**Found in a second review pass**

- **arrays:** `range` could include its exclusive end through float drift.
- **objects:**
    - `omit` ignored numeric keys and `mapValues` turned arrays into objects.
    - `setInObjectByKeys` could write into inherited built-ins such as `Object.prototype.toString`.
- **strings:** `substring` swapped its indices when one of them was `NaN`.
- **math:**
    - `log(81, 3)` returned 4.000000000000001;
    - `modulo` could return the divisor itself;
    - `lerp` returned `NaN` at infinite endpoints;
    - `median` and `variance` underflowed or overflowed.
- **functions:**
    - `memoize` keys collided for `NaN`/`Infinity`/`undefined`/`-0`;
    - `debounce` and `throttle` ignored waits above 2^31−1 ms;
    - `once` ran twice on re-entrant calls.
- **async:** `retry` reported a retry after it had been aborted.
- **functions:** `memoize` could return `undefined` when an expiring cache dropped an entry between its `has` and `get` lookups.
- **arrays:** `removeDuplicates`, `union` and `symmetricDifference` turned `-0` into `0`.
- **iterables:**
    - `cycle`, `flatMap` and `concat` mishandled `throw()`;
    - the async helpers left sync sources open when a yielded promise rejected.
- **cache:** `clear`/`prune` skipped `onEvict` for the remaining entries when one callback threw.
- **store:** a derived store could get stuck on a stale value after its `equals` threw.
- **emitter:** wildcard handlers didn't type-check for event maps with optional keys.
- **random:** `restore` accepted sparse state arrays, and `randomUUID` relied on `getRandomValues`' return value.
- **decorators:** `@bound` threw on frozen instances.
- **date:**
    - a zero-amount add could shift the time by an hour during the repeated DST hour;
    - `startOf*` returned an Invalid Date at the range limit;
    - cross-realm Dates were rejected.
- **guards:** the `is*` checks for built-ins accepted fake objects built from a built-in's prototype.

- **Consistency pass across all modules:**
    - Argument errors share one message format, ``fn: `param` must be …, got value``.
    - A wrong type (for example a string where a number belongs) throws `TypeError`; a right type with an invalid value throws `RangeError`.
    - Callbacks and `random` generators are validated everywhere, even for empty input.
    - The shared assertion helpers are deduplicated, which saves about 430 B gzipped.

- **Hardening and performance pass:**
    - Mutation testing (Stryker) raised every module to a 94–100% mutation score.
    - Benchmarks (`yarn bench`) guided these speed-ups, with behaviour unchanged:
        - `round` about 130×; `reverse` and `truncate` about 100× on plain text; seeded `float()` about 30×;
        - the LRU cache stays fast on frequently read keys (about 25×), and `isDate`/`isMap`/… are about 500× faster on non-matching objects;
        - multi-argument `memoize` about 6×, `getRelativeTime` about 12×, `formatDate` about 4×;
        - object writers (`merge`, `clone`, `deepClone`, …) 2–4×;
        - case converters 2–5×, `buildQueryString` 2–5×, `sum` and `median` about 3×.
    - Fixes from this pass:
        - `median`/`quantile` returned `0` or `-0` depending on input order;
        - `retry` now validates its `random` generator;
        - `formatOrdinal` and `pluralRule` errors named the wrong parameter.

- **Competitive performance pass:**
    - Every helper with an equivalent in es-toolkit, lodash, date-fns, mitt, fuse.js, nanoid or bezier-easing is benchmarked against it.
    - Across 466 comparisons, the median ratio is 1.15× and 75% are at par or faster. Examples:
        - `fuzzySearch` is ~30× faster than fuse.js; the date helpers are a median 2.45× faster than date-fns.
        - Since the start of the performance work: `randomId` ~25×, `sumBy` 15–28×, `clone` 8–40×, the LRU cache 3–8×.
    - Fixes from this pass:
        - `cubicBezier` was off by up to 2.3e-4 next to vertical end tangents;
        - the `end*` date functions threw on the last representable day.
- **Published declarations are gated:** they must compile for a plain ES2022 consumer with `skipLibCheck` off, within a type-instantiation budget.

### Changed (breaking)

See [Migrating from 1.x](./README.md#migrating-from-1x).

- The package is renamed to `@emiliodominguez/tink`.
- **Behaviour:**
    - `isError` decides same-realm objects with `instanceof`, so a plain object faking `Symbol.toStringTag` `'Error'` is no longer an error;
        - the `isDate`/`isRegExp`/`isMap`/`isSet`/`isWeakMap`/`isWeakSet` guards reject a genuine instance whose prototype was swapped to an unrelated object from the same realm (cross-realm instances still pass);
            - non-number arguments to numeric parameters now throw `TypeError` instead of `RangeError`, and a few value errors moved from `TypeError` to `RangeError` (e.g. `sortBy` with an unknown `order`, `debounce` with both edges disabled);
                - `modulo` is now a floored modulo;
                - `countSubString` is case-sensitive;
                - `hasProperty` only checks own properties;
                - `round` rounds halves away from zero.
