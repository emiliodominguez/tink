# cache — equivalent mutants

- 376: `ttl !== defaultTTL` → `true` (`readTTL`) — the default TTL was validated when the cache was created, so validating it again on every call cannot fail; the comparison only skips that work.
- 832: `shrink` body emptied — `shrink` only halves the deque's ring buffer to release memory once it is three quarters empty; values, order and indices are the same with or without it.
- 833: `ring.length > MIN_RING && length <= ring.length >> 2` → `true` / `false`, `>` → `>=` / `<=`, `<=` → `<`, `resize(...)` removed — same as above: they change when (or whether) the ring shrinks, never what the deque holds. A test checks that a shrunk ring keeps no stale reference.
