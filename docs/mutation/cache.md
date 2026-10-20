# cache — equivalent mutants

- 376: `ttl !== defaultTTL` → `true` (`readTTL`) — the default TTL was validated when the cache was created, so validating it again on every call cannot fail; the comparison only skips that work.
- 832: `shrink` body emptied — `shrink` only halves the deque's ring buffer to release memory once it is three quarters empty; values, order and indices are the same with or without it.
- 833: `ring.length > MIN_RING && length <= ring.length >> 2` → `true` / `false`, `>` → `>=` / `<=`, `<=` → `<`, `resize(...)` removed — same as above: they change when (or whether) the ring shrinks, never what the deque holds. A test checks that a shrunk ring keeps no stale reference.
- 1022: `[]` → `['Stryker was here']` (`createRingBuffer` storage) — the first `push` writes slot 0 instead of appending it, and every read is bounded by `length`, so the initial content of a slot is never seen.
- 1720: `label.length < 13` → `false` / `<=` (`detach`) — copying a short label (which V8 already copies when slicing) changes no code unit; only the memory the label keeps alive differs, and a test checks that labels of 13 code units or more keep no longer string alive.
- 1774: `label: ''` → any string (`createTrie` root) — the root's label is never read: only the labels of the nodes below it are matched, split, merged or appended to keys.
- 1808: `rest < label.length` → `<=` (`locate`) — when the prefix ends exactly at the end of an edge, both branches return that edge's node with the prefix as its key.
- 2253, 2266: `if (step >= bits) step %= bits` → `if (true)` / `step > bits` (`BloomFilter.add`/`has`) — positions only matter modulo `bits`: `%=` changes nothing below `bits`, and a step of exactly `bits` adds `bits` to the position, which the next `position -= bits` removes. The test only keeps `step` from growing.
