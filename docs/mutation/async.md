# async — equivalent mutants

- 354: `concurrency >= list.length && signal == null && stopOnError` → `false` — fast path. When every item can start at once and nothing but a failure can stop the run, mapping them directly is the same as running one worker per item: same start order, same results, same "stop at the first synchronous throw".
- 354: `>=` → `>` — when concurrency equals the length, the worker path runs instead, with the same behaviour.
- 354: fast-path block emptied — same as `false`.
- 388: `if (done) return` → `if (false)` (`finish` of the worker path) — settling an already settled promise does nothing, and removing the abort listener a second time is harmless.
- 2195: `typeof task !== 'function'` → `true` — `assertFunction` repeats the check. The guard only avoids formatting the `tasks[i]` name for valid tasks.
- 2195: `'function'` → `""` — same as above.
- 3330: `const added = []` → `["Stryker was here"]` (`waitForEvent`) — `removeListeners` applies `remove` to each entry with `Reflect.apply`; a string entry is not an argument list, so that call throws and is swallowed by the `catch` that keeps the other removals going. The real listeners are removed as before.
- 3602: `value === null` → `false` (`isErrorNamed`, behind `isAbortError` / `isTimeoutError`) — reading `name` from `null` then throws inside the `try`, whose `catch` returns `false` as well. The check only spares `null` the cost of an exception.
- 4310: `const added = []` → `["Stryker was here"]` (`fromEvent`) — same as line 3330.
- 4378: `if (first === undefined) last = undefined` → `if (false)` (`fromEvent`) — clearing `last` once the queue has drained only lets the last event be garbage collected; `last` is never followed while `first` is unset (the next event becomes `first`).
