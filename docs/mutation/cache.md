# cache — equivalent mutants

- 434: `removed === undefined && !overflows()` → `false` (`fit`) — the single-eviction fast path only avoids allocating an array: reporting through `notifyAll` with one entry calls `onEvict` the same way and rethrows its error as is.
- 536: `ttl !== defaultTTL` → `true` (`readTTL`) — the default TTL was validated when the cache was created, so validating it again on every call cannot fail; the comparison only skips that work.
- 606: `overflows()` → `true` (`LRUCache.set`) — `fit` with nothing to evict reports just the replaced value, as the direct `notify` does.
- 750, 753, 883: `[]` → `['Stryker was here']` (`order`, `path`, and `order` in `clear`) — slot 0 of `order` is written by the first `push` before it is read, and `path` is emptied before each use.
- 767: `rankA < rankB` → `<=` (`precedes`) — insertion numbers are unique, and no slot is ever compared with itself, so the ranks are never equal.
- 875: `order[i] < order[found]` → `<=` (`PriorityQueue.delete`) — insertion numbers are unique: two occurrences never have the same one.
- 1019: `shrink` body emptied — `shrink` only halves the deque's ring buffer to release memory once it is three quarters empty; values, order and indices are the same with or without it.
- 1020: `ring.length > MIN_RING && length <= ring.length >> 2` → `true` / `false`, `>` → `>=` / `<=`, `<=` → `<`, `resize(...)` removed — same as above: they change when (or whether) the ring shrinks, never what the deque holds. A test checks that a shrunk ring keeps no stale reference.
- 1059, 1068: `shrink()` removed (`popBack`/`popFront`) — same as above.
- 1081: `offset < length` → `<=` (`Deque.at`) — the slot just past the back value is always cleared, and every masked index lies inside the filled ring.
- 1225, 1282: `[]` → `['Stryker was here']` (`createRingBuffer` storage, and `clear`) — the first `push` writes slot 0 instead of appending it, and every read is bounded by `length`, so the initial content of a slot is never seen.
- 1253: `tail === ring.length` → `false` (`RingBuffer.push`) — assigning the index just past the end appends, as `push` does: the storage stays packed.
- 1384: `stored !== undefined` → `false` (`DefaultMap.get`) — a fast path: `map.has` gives the same answer for a defined value.
- 1950: `label.length < 13` → `false` / `<=` (`detach`) — copying a short label (which V8 already copies when slicing) changes no code unit; only the memory the label keeps alive differs, and a test checks that labels of 13 code units or more keep no longer string alive.
- 2004: `label: ''` → any string (`createTrie` root) — the root's label is never read: only the labels of the nodes below it are matched, split, merged or appended to keys.
- 2038: `rest < label.length` → `<=` (`locate`) — when the prefix ends exactly at the end of an edge, both branches return that edge's node with the prefix as its key.
- 2218: `i < text.length` → `<=` (`longestPrefixOf`) — past the end of the text `charCodeAt` returns `NaN`, which is the first code unit of no child.
- 2231: `''` → any string (`Trie.values`) — the keys `collect` builds are not used for values.
- 2480, 2493: `if (step >= bits) step %= bits` → `if (true)` / `step > bits` (`BloomFilter.add`/`has`) — positions only matter modulo `bits`: `%=` changes nothing below `bits`, and a step of exactly `bits` adds `bits` to the position, which the next `position -= bits` removes. The test only keeps `step` from growing.

Killed by the full suite, but reported as survivors by Stryker's per-test coverage analysis:

- 149: `configurable: true` → `false` (`withGetters`) and 2185: `siblings.size === 0` → `false` (`Trie.delete`) — a prototype is created by the first test that needs it and then reused, so Stryker counts only that test as covering the line and skips the tests that check the getter descriptors and the pruned nodes. Both mutants fail the suite when applied by hand.
