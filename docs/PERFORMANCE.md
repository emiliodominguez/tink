# Performance

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

## Where tink is slower, and why

Most remaining gaps exist because tink does more work for correctness:

- **`strings.reverse`, `truncate`, `getWords`:** they keep grapheme clusters intact, so emoji such as 👍🏽 and combining marks survive.
- **`math.sum` and `math.round`:** `sum` uses compensated summation (`sum([0.1, 0.2, 0.3]) === 0.6`), and `round` is decimal-correct (`round(1.005, 2) === 1.01`).
- **`isDate`, `isMap` and the other guards:** a brand check rejects fakes such as `Object.create(Date.prototype)` and accepts instances from other realms.
- **`difference`, `flattenDeep`, `clone` of arrays:** they deduplicate, detect cycles, and keep holes and extra keys.
- **`randomId`:** it reads the live `crypto` object on every call, so mocks and the "no CSPRNG → throw" rule always apply.

Each remaining gap is tracked in the benchmark files, and the hot paths skip the extra work whenever it is provably unnecessary.

## Running the benchmarks

```bash
yarn build
yarn bench              # every module
yarn bench arrays       # one module
yarn bench --json       # machine-readable results
```

Each case is compiled into its own loop, async cases are awaited, and competitors are imported from the same `node_modules`, so results compare like with like. Run on an idle machine: background load moves ratios by ±15–30%.

The edge-case table of the README is computed by `yarn compare` (`bench/edge-cases.mjs`), which prints the library behind each row.
