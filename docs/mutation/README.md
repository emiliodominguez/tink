# Mutation testing: known equivalent mutants

`yarn test:mutation` runs [Stryker](https://stryker-mutator.io) over the library. Stryker changes the source in small ways and reports every change, or "mutant", that no test catches.

Every module has been taken through a full run (the table below is the last one, for 1.3.0), and every later addition through a run on its own lines. Each surviving mutant was then handled in one of three ways:

- **Missing test:** a test was added that checks the real behaviour.
- **Redundant code:** the code was simplified so the mutant disappears.
- **Equivalent mutant:** the change cannot alter observable behaviour. Most are fast paths, caches, preallocation or unreachable boundaries. These are listed in the files below, one line per mutant, with the reason.

When a new run reports a survivor that is not in its module's list, treat it as a real gap: add a test, or document why it is equivalent.

| Module                          |   Score | Equivalent mutants |
| ------------------------------- | ------: | -----------------: |
| [`arrays`](./arrays.md)         |  94.22% |                 56 |
| [`async`](./async.md)           |  98.66% |                  6 |
| [`cache`](./cache.md)           | 100.00% |                  0 |
| [`color`](./color.md)           |  97.86% |                 11 |
| [`date`](./date.md)             |  98.26% |                 13 |
| [`decorators`](./decorators.md) | 100.00% |                  0 |
| [`easing`](./easing.md)         |  96.07% |                 19 |
| [`emitter`](./emitter.md)       |  94.39% |                 11 |
| [`format`](./format.md)         |  94.61% |                 13 |
| [`functions`](./functions.md)   |  96.39% |                 16 |
| [`guards`](./guards.md)         |  97.79% |                  8 |
| [`iterables`](./iterables.md)   |  98.94% |                  4 |
| [`math`](./math.md)             |  96.32% |                 29 |
| [`objects`](./objects.md)       |  93.86% |                 49 |
| [`random`](./random.md)         |  97.32% |                 11 |
| [`search`](./search.md)         |  97.05% |                 13 |
| [`store`](./store.md)           |  97.81% |                  3 |
| [`strings`](./strings.md)       |  95.46% |                 32 |
| [`url`](./url.md)               |  99.27% |                  2 |
| [`validate`](./validate.md)     |  99.74% |                  2 |

The 1.4.0 additions were mutated on their own lines (a full run of all 38,000 mutants takes days on one machine), after the second review; their survivors are listed in the same files:

| Module                          | New code                                                                                                            |  Score |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -----: |
| [`async`](./async.md)           | `createCircuitBreaker`, `backoff`, `fromEvent`, `interval`, `createStopwatch`, `isAbortError`, shared listener code | 96.79% |
| [`cache`](./cache.md)           | `createTrie`, `createBloomFilter`, `createBiMap`, `createMultiMap`, `createDefaultMap`, `createRingBuffer`          | 98.44% |
| [`color`](./color.md)           | `deltaE`, `ciede2000`, `toLab`, `colorFromString`, `simulateColorVisionDeficiency`                                  | 98.80% |
| [`color`](./color.md)           | allocation-free gamut mapping (fast paths with an exact fallback)                                                   | 81.50% |
| [`date`](./date.md)             | cron helpers, skipped-day business days                                                                             | 96.96% |
| [`decorators`](./decorators.md) | `@lazy`, `@measure`                                                                                                 | 97.50% |
| [`encoding`](./encoding.md)     | `hmacSha256`, `crc32`, `signJwt`, `verifyJwt`                                                                       | 97.99% |
| [`errors`](./errors.md)         | `defineError`, `getErrorChain`, `formatError`, `classes`                                                            | 97.90% |
| [`functions`](./functions.md)   | Result helpers, `when`/`unless`/`cond`                                                                              | 97.12% |
| [`iterables`](./iterables.md)   | stream readers, `mergeAsync`, `bufferTime`, `interleave`, `pairwise`, `partition`                                   | 98.06% |
| [`path`](./path.md)             | the whole module                                                                                                    | 98.15% |
| [`search`](./search.md)         | `createSearchIndex`                                                                                                 | 93.50% |
| [`search`](./search.md)         | `tokenize`                                                                                                          | 96.40% |
| [`validate`](./validate.md)     | semver ranges and increments                                                                                        | 96.30% |

After 1.4.0, `cache` and `store` were mutated again as whole modules (2,233 mutants): `cache` scores 97.54% (32 equivalent mutants, plus 2 that only Stryker's per-test coverage misses) and `store` 96.89% (31 equivalent mutants).

The date module's list includes 3 mutants that survive only because Stryker runs in UTC. The DST tests kill them under `TZ=America/New_York`.
