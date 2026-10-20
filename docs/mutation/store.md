# store — equivalent mutants

- 106 (`compact` emptied), 107 (its guard → `true` / `false`, `<` → `<=` / `>=`, `*` → `/`), 121 and 209 (`compact()` removed) — compaction only drops the shells of unsubscribed entries (their listeners are released at once, and rounds skip cleared entries); it keeps the list within twice the number of subscribers, which only memory shows.
- 123: `deferred.length === 0` → `false` (`settle`) — the fast path only avoids allocating an empty array.
- 205: `subscription.listener === undefined` → `false` (unsubscribe) — a second unsubscribe only counts the entry as removed twice, so compaction runs earlier and keeps the same entries; the count is only read by derived stores, whose own unsubscribe functions are idempotent.
- 216: `!held` → `true` (`notify` in a batch) — a store queued twice is released once: `release` does nothing once the store has notified.
- 231: `!deferred.includes(callback)` → `true` (`defer`) — a callback deferred twice runs twice; the history's deferred callbacks (`record`, `settle`) are idempotent. The check only keeps the list from growing over a long notification.
- 321: `version++` → `version--` — `version` is only ever compared with `!==`/`===` to `notifiedVersion`, so either direction marks a change.
- 337: `version === notifiedVersion` → `false` (`onSourceChange`) — the next check, `equals(notifiedValue, current)`, then finds the value unchanged; the version check only skips that call.
- 351: `!detach` → `true` (derived `subscribe`) — the inner check (needed because the selector may subscribe to the store itself) attaches once; the outer one only skips a `getState` call.
- 542: `!many` → `false` (`computed`) — a single store then goes through `combineStores`, which wraps its state in a one-element tuple that `compute` receives spread: the same argument, the same notifications. The direct path only avoids the tuple (and keeps `select` at its baseline speed).
- 1035: `[]` → `['Stryker was here']` (`createMachine` queue) — the extra entry is handled first as an event no state handles, and the queue is emptied when `send` ends.
- 1299, 1389, 1414, 1491, 1502: `-Infinity` → `+Infinity` (`lastChange`) — both mean "no change to merge with": the elapsed time is then `±Infinity`, never in `[0, coalesce)`.
- 1336: `start * 2 >= past.length` → `true` / `false` / `>` / `<`, `*` → `/`, block emptied (`trim`) — when the dropped steps are compacted away only changes memory: their slots are already cleared, and steps are read from `start`.
- 1381: `past.length > start` → `true` / `>=` (`record`) — unreachable: a change is only merged into a step that exists (a batch that recorded one, or a change recorded less than `coalesce` ms earlier; `clear`, `undo` and `redo` reset both).
- 1626: `catch` block emptied (`defaultStorage`) — the block only returns `undefined`, which the function also returns when the block is empty.
