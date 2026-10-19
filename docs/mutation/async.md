# async — equivalent mutants

- 273: `concurrency >= list.length` → `false` — fast path. When every item can start at once, mapping them directly is the same as running one worker per item: same start order, same results, same "stop at the first synchronous throw".
- 273: `>=` → `>` — when concurrency equals the length, the worker path runs instead, with the same behaviour.
- 273: fast-path block emptied — same as `false`.
- 289: `const results: R[] = []` → `["Stryker was here"]` — the worker path only runs for a non-empty list, where every index (0 included) is assigned before `results` is returned; on failure the promise rejects instead.
- 796: `typeof task !== 'function'` → `true` — `assertFunction` repeats the check. The guard only avoids formatting the `tasks[i]` name for valid tasks.
- 796: `'function'` → `""` — same as above.
- 3249: `const added = []` → `["Stryker was here"]` (`waitForEvent`) — `unlisten` applies `remove` to each entry with `Reflect.apply`; a string entry is not an argument list, so that call throws and is swallowed by the `catch` that keeps the other removals going. The real listeners are removed as before.
