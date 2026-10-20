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

## tokenize and createSearchIndex

732: `if (nonAscii) prepared = prepared.normalize('NFC')` → `if (true)` — ASCII text is already in NFC; the guard only skips the pass.
734: `if (minLength === 1 && stopWords === undefined) return tokens` → `if (false)` — fast path (20–40% of a call on short texts); the filter loop keeps every token when there is nothing to drop.
736: `minLength === 1 || …` → `false || …` — shortcut that skips counting code points; every token has at least one.
952: `slots[i] < slots[j]` → `<=` — the candidates' slots are distinct, so they are never equal.
980: `child + 1 < limit` → `true`, `child + 1 <= limit` or `child - 1 < limit` — `heap[limit]` is `undefined`, for which `before` is `false`: the child is not switched.
1001: `4 * matched.size <= list.length` → `true`, `false`, `<`, `>` or `4 / matched.size` — chooses between a binary search in the matched postings and a scan of the document's terms; both give the same terms in the same order.
1138, 1139: `sorted`/`fresh` initialized to `["Stryker was here"]` — a term that is not in the index is dropped by the first merge (`isIndexed`) and skipped by `complete` before it.
1174: `f < fieldCount` → `f <= fieldCount` — decrements `df[fieldCount]`, which is never read.
1175: `if (--posting.live === 0) postings.delete(…)` → `if (false)` or `++posting.live`, or the delete removed — keeps an empty posting list in memory: it has no live entry, so it adds nothing to any score, match or `terms`.
1177: `f < fieldCount` → `f <= fieldCount` — reads past the document's lengths and updates `docCount[fieldCount]`/`totalLength[fieldCount]`, never read.
1188, 1314: `version++` → `version--` — any change of `version` is detected by the `filter` check.
1189: `if (docs.length > 2 * live) vacuum()` → `true`, `false`, `>=`, `<=` or `2 / live`, or the call removed — when to vacuum is a memory policy; a vacuum preserves every result.
1196: the body of `vacuum` removed — the vacuum only reclaims memory (removed entries are skipped by `docs[slot] === undefined`), results are unchanged.
1199: `slot < docs.length` → `<=` — `docs[docs.length]` is `undefined`, skipped like a removed document.
1205, 1218: `f < fieldCount` → `f <= fieldCount` — copies one value too many into the next slot/entry, which is then overwritten by its own copy or truncated.
1225, 1226: `sorted.filter(isIndexed)`/`fresh.filter(isIndexed)` → unfiltered — memory only: removed terms are dropped by the next merge and skipped by `complete`.
1271: `g < fieldCount` → `g <= fieldCount` — pushes an unused trailing count per term; `counts` is indexed the same way when written and read.
1309: `posting.live++` → `posting.live--` — `live` never reaches 0, so an empty posting list stays in memory (see 1175).
1324: `if (fresh.length > 0)` → `true` or `>= 0` — merging nothing rebuilds the same sorted list.
1328: `i < sorted.length` → `i <= sorted.length` — `sorted[sorted.length]` is `undefined`, dropped by `isIndexed`.
1329: `sorted[i] < fresh[j]` → `<=`; `i < sorted.length` → `<=` or `true` — the order of equal terms is irrelevant (duplicates are dropped), and `undefined < term` is `false`.
1330: `term !== merged[merged.length - 1] && isIndexed(term)` → `true`, `||` or `true && …`, or `merged.length + 1` — keeps duplicates or removed terms in the sorted list: `complete` skips removed terms, and a duplicate posting list is counted once (`matched`, maximum per document).
1333: `fresh = []` → `["Stryker was here"]` — a term not in the index, dropped by the next merge.
1351: `total.length < docs.length` → `<=` — scratch-space growth policy only.
1365, 1368: `weights`/`touched` initialized to `["Stryker was here"]` — `weights` is overwritten before use; a slot that is a string has no `hits` and is never a candidate.
1366, 1381: `f < fieldCount` → `f <= fieldCount` — computes a scale/weight for a field index that is never read.
1369: `q < queryTerms.length` → `<=` — the extra query term is `undefined`, which has no postings.
1382: `entry < slots.length` → `<=` — `slots[slots.length]` is `undefined`, and `docs[undefined]` is skipped like a removed document.
