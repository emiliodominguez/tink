# search — equivalent mutants

165: `if (code < 128)` → `if (false)` — ASCII fast path of `fold`; the general path (`String.fromCodePoint(code).toLowerCase()`) folds ASCII identically.
165: `code < 128` → `code <= 128` — U+0080 is a control character: both paths fold it to itself.
177: `if (code < 128)` → `if (false)` — ASCII fast path of `classify`; `WORD` (`[\p{L}\p{N}]`) and the case tests give the same flags for ASCII.
177: `code < 128` → `code <= 128` — U+0080 is neither a word character nor cased: both paths return 0.
211: `if (code > 127)` → `if (true)` — only disables the `indexOf` pre-filter (`needles`); the greedy subsequence check in `match` rejects the same targets.
211: `code > 127` → `code >= 127` — DEL (U+007F) would merely skip the `indexOf` pre-filter, same result.
235: `index < found` → `index <= found` — the alternatives of a needle are distinct characters, so two `indexOf` results can never be equal.
265: `length <= SHARED_LENGTH && …` → `false` — shared-workspace reuse is an allocation optimization; a fresh workspace gives the same result.
265: `length <= SHARED_LENGTH` → `length < SHARED_LENGTH` — threshold of the same allocation optimization.
265: `cells <= SHARED_CELLS` → `cells < SHARED_CELLS` — threshold of the same allocation optimization.
268: `query.needles === undefined ? 0 : m` → `0` — re-runs the greedy subsequence check that `contains` already passed; it passes again.
282: `j < n` → `j <= n` — writes `row[n]`, which is never read (or is out of bounds of the typed array and ignored).
292: `j < n` → `j <= n` — same: `row[n]` is never read, `back[i * n + n]` is never followed.
242: `if (codes === undefined)` → `if (true)` — the `expand` cache: recomputing the folding gives the same code points.
251: `expansions.size === 4096` → `true`, `false` or `!==`, or `expansions.clear()` removed — cache eviction policy only.
252: `expansions.set(…)` removed — cache never filled: same foldings.
309: `if (code <= 127)` → `if (true)` or `code < 127` — for a non-ASCII code point `needles` is already `undefined` (`needles?.push` does nothing); DEL only skips the `indexOf` pre-filter.
369: `diacritics && NON_ASCII.test(target)` → `diacritics || …` — only disables the `indexOf` pre-filter; the greedy subsequence check rejects the same targets.
370: `(m > length && !diacritics)` → `false` — length pre-rejection only; the greedy subsequence check rejects the same targets.
385: `if (matched < m) return undefined` → `if (false)` — early exit before allocating; the check after the second pass (418) rejects the same targets.
389: `capacity <= SHARED_LENGTH` → `false` or `<` — shared-workspace reuse is an allocation optimization.
