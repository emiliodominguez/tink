# Mutation testing: known equivalent mutants

`yarn test:mutation` runs [Stryker](https://stryker-mutator.io) over the library. Stryker changes the source in small ways and reports every change, or "mutant", that no test catches.

Every module has been taken through a full run. Each surviving mutant was then handled in one of three ways:

- **Missing test:** a test was added that checks the real behaviour.
- **Redundant code:** the code was simplified so the mutant disappears.
- **Equivalent mutant:** the change cannot alter observable behaviour. Most are fast paths, caches, preallocation or unreachable boundaries. These are listed in the files below, one line per mutant, with the reason.

When a new run reports a survivor that is not in its module's list, treat it as a real gap: add a test, or document why it is equivalent.

| Module                        |   Score | Equivalent mutants |
| ----------------------------- | ------: | -----------------: |
| [`arrays`](./arrays.md)       |  94.22% |                 56 |
| [`async`](./async.md)         |  98.66% |                  6 |
| [`cache`](./cache.md)         | 100.00% |                  0 |
| [`color`](./color.md)         |  97.86% |                 11 |
| [`date`](./date.md)           |  98.26% |                 13 |
| `decorators`                  | 100.00% |                  0 |
| [`easing`](./easing.md)       |  96.07% |                 19 |
| [`emitter`](./emitter.md)     |  94.39% |                 11 |
| [`format`](./format.md)       |  94.61% |                 13 |
| [`functions`](./functions.md) |  96.39% |                 16 |
| [`guards`](./guards.md)       |  97.79% |                  8 |
| [`iterables`](./iterables.md) |  98.94% |                  4 |
| [`math`](./math.md)           |  96.32% |                 29 |
| [`objects`](./objects.md)     |  93.86% |                 49 |
| [`random`](./random.md)       |  97.32% |                 11 |
| [`search`](./search.md)       |  97.05% |                 13 |
| [`store`](./store.md)         |  97.81% |                  3 |
| [`strings`](./strings.md)     |  95.46% |                 32 |
| [`url`](./url.md)             |  99.27% |                  2 |
| [`validate`](./validate.md)   |  99.74% |                  2 |

The date module's list includes 3 mutants that survive only because Stryker runs in UTC. The DST tests kill them under `TZ=America/New_York`.
