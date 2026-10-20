# encoding — equivalent mutants

Covers the 1.4.0 additions (`hmacSha256`, `crc32`, `signJwt`, `verifyJwt`) and the `sha256Finish` helper they share with `sha256`.

- 865: `tail[end - 8] = high >>> 24` → `tail[end + 8]` — `high` is the bit count divided by 2^32, `0` for any message below 512 MiB, so the byte it writes is the zero already there; `end + 8` is out of bounds, a typed-array write that is ignored. Not testable in practice (a 512 MiB message).
- 866: `tail[end - 7] = high >>> 16` → `tail[end + 7]` — same as above.
- 867: `tail[end - 6] = high >>> 8` → `tail[end + 6]` — same as above.
- 868: `tail[end - 5] = high` → `tail[end + 5]` — same as above.
- 876: `i < 8` → `i <= 8` — the extra round reads `state[8]` (`undefined`, written as 0) into `digest[32..35]`, out of bounds of the 32-byte digest: ignored writes.
- 930: `i < 64` → `i <= 64` — `block[64]` is out of bounds of the 64-byte key block: an ignored write.
- 933: `i < 64` → `i <= 64` — same as above.
- 992: `n < 256` → `n <= 256` — also computes the bitwise CRC of 256 into `tables[256]`, which the next loop overwrites (it starts at 256) with the correct slicing entry.
- 997: `i < 2048` → `i <= 2048` — `tables[2048]` is out of bounds of the 2,048-word table: an ignored write.
- 1026: `length - (length % 8)` → `length - (length * 8)` — `full` becomes negative, so the slicing-by-8 loop is skipped and the byte-at-a-time loop checksums everything: the same result, about 4× slower (the slicing loop is the fast path).
- 1029: `i < full` → `false` — same as above (fast path skipped).
