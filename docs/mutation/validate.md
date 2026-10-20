# validate — equivalent mutants

593: `if (digit > 9)` → `if (digit >= 9)` — a doubled digit is even, so it is never exactly 9.
595: `sum += digit` → `sum -= digit` — only `sum % 10 === 0` is observed, and negating the sum preserves divisibility by 10.

## Semver ranges and increments (`satisfiesSemver`, `compileSemverRange`, `incrementSemver`…)

- 790: `LOWEST_PRERELEASE = '0'` → `""` — `splitPrerelease('')` gives `[0]`, the same identifiers as `'0'` (only the 256-character check reads the text, and one character never matters there).
- 916: `if (next < 0) break` → `false`, `next <= 0` — `readPrerelease` then returns `-1` instead of the extent before a trailing `.`; every caller rejects both (a version or identifier must end there, a range body is followed by a character that fails it), and `readIdentifier` never returns `0`.
- 938, 944: `next < 0` → `next <= 0` — `readNumber` at `end + 1 >= 1` returns `-1` or more than `1`, never `0`.
- 950: `next > end + 1` → `next >= end + 1`, `next > end - 1` — `readPrerelease` returns `-1` or an index past `end + 1`.
- 1004: `next < 0` → `false`, `next <= 0` — with `next === -1`, `end` becomes `-1` and `endsWithBuild(text, -1)` rejects the version; `next` is never `0`.
- 1035 (6): the number-number fast path of the identifier comparison (`false`, `true && …`, `typeof a !== 'number' && …`, the two `'number'` literals → `""`, and `a < b` → `a <= b`) — the slow path `compareIdentifiers(String(a), String(b))` orders numeric strings exactly, a string before a number compares as `false` (a string sorts after a number), and the two identifiers are never equal there. The fast path is kept: it makes pre-release comparisons about 20% faster.
- 1090: `prerelease.length > SEMVER_MAX_LENGTH - 51` → `true`, `>=` — a guard that skips formatting the version (about 4% of a caret range's parse): three safe integers and separators take at most 51 characters, so the exact length test below gives the same answer.
- 1204: `if (star < 0) return false` → `false` — without a `*`, `cut` is `-1` and the rebuilt token is the token minus its last character followed by the whole token, which is never a comparator when the token is neither a comparator nor an X-range.
- 1226: `minor < 0 ? 0 : minor` → `minor <= 0` — `0` either way.
- 1240 (4), 1242 (2): `minor < 0 ? 0 : minor` / `patch < 0 ? 0 : patch` → `false ? 0 : …`, `<= 0` — a wildcard is `-1`, which in a lower bound `>=M.-1.0` (or `>=M.m.-1`) admits exactly the versions `>=M.0.0` (or `>=M.m.0`) admits: no version has a part below `0`, and that bound only has a pre-release (`-0`) with `includePrerelease`, which skips the pre-release rule.
- 1270: `comparison < 0` → `comparison <= 0` — the backward scan ends at index `0`, so a `comparison` of `0` is never overwritten.
- 1273: `comparison < 0 ? start : comparison` → `comparison <= 0` — `comparison === 0` means `start === 0` too.
- 1298: `fromEnd < 0` → `fromEnd <= 0` — `readPartial` returns `-1` or an index past the version's first character.
- 1352: `i < text.length` → `i <= text.length` — `charCodeAt(text.length)` is `NaN`, which sets no flag.
- 1358 (4), 1361 (5): mutants of the `FLAG_HYPHEN` and `FLAG_SPACING` tests in `rangeFlags` that set the flag more often (`true`, `||`, `code > 128`: U+0080 is not white space) — a flag only lets a range skip a rewrite that leaves it unchanged, so setting it too often changes nothing. (The mutants that set it too rarely are killed by single tabs, `\r`, no-break spaces and double spaces.)
- 1377: `rewritten = false` → `true` — the operator-space test then runs on text the flags already describe: same outcome.
- 1378 (4): the build-metadata gate → `true`, `||`, `includes("")` — stripping text without build metadata changes nothing (and marks it rewritten, which only re-runs exact tests).
- 1382 (4): the hyphen gate → `true`, `||`, `includes("")` — `readHyphenRange` returns `undefined` for anything that is not a hyphen range.
- 1389 (2): the `joinOperators` gate → `true` — it drops no space from a range without a space after an operator, a tilde, a caret or another space.
- 1414: `(hints & FLAG_SPACING) !== 0` → `true` — collapsing white space that is already single spaces is a no-op.
- 1419: `[]` → `["Stryker was here"]` — the junk set is a string: its "comparators" (characters) have no `operator` bits, so it never matches, and its `length` is not `0`.
- 1423: `(hints & FLAG_BAR) === 0 ? -1 : …` → `false ? …` — without a `|`, `indexOf('||')` is `-1` anyway.

The flag scan (`rangeFlags`) and its gates are kept because they measurably pay off: without them (native `includes`/regular-expression gates instead) parsing the common ranges is about 8–10% slower.
