# strings — equivalent mutants

61: `isSimpleText` body removed (returns undefined) — disables the "no complex code unit" fast path everywhere; the region-by-region segmentation gives the same graphemes/lengths.
72: `code >= 0x300` → `code > 0x300` — only affects `firstGrapheme` when U+0300 follows the first code unit; its callers (capitalize/uncapitalize) case-map the grapheme, and U+0300 has no case mapping (Unicode upper/lower mappings are context-free apart from final sigma, which cannot occur at index 0), so the output is identical.
72: `code === 13` → `false` — same: `'\r\n'` case-maps like `'\r'` + `'\n'`.
91: `if (isSimpleText(string))` → `if (false)` — fast path of splitGraphemes: the region scan returns the same graphemes for simple text.
103: `graphemes.length <= limit` → `true` — the limit is an early exit: more graphemes than `limit + 1` are allowed by contract, callers only read the first `limit + 1`.
105: `|| graphemes.length > limit` → `|| false` — same early exit (continues scanning; the extra graphemes are ignored).
111: `if (graphemes.length > limit) break` → `if (false)` — same early exit inside a segmented region.
143: `letter.charCodeAt(0) < 0x80` → `false` — ASCII fast path of titleCaseLetter; the general path gives the same upper-case letter.
143: `< 0x80` → `<= 0x80` — U+0080 is an uncased control character: both paths return it unchanged.
162: `lower.charCodeAt(0) < 0x80` → `false` — ASCII fast path of upperFirstLowerRest (words are never empty); the code-point path gives the same result.
162: `< 0x80` → `<= 0x80` — U+0080 is uncased: same result.
230: `if (!NON_ASCII.test(text))` → `if (false)` — ASCII fast path of splitWords; ASCII_WORD implements the same rules as the Unicode path (pinned by the property tests).
357: `if (isSimpleText(…))` → `if (false)` — truncate fast path; the grapheme path cuts at the same place.
357: `string.slice(0, length + 1)` → `string` — narrower fast path (only fully simple strings); the slow path gives the same cut.
417: `string.includes('﻿')` → `string.includes("")` — always lower-cases word by word, which equals whole-string lower-casing except across U+FEFF (the reason for the fast path).
733: `if (!string.includes('&')) return string` → `if (false)` — unescapeHtml fast path: a string without `&` has no entity to replace.
733: `includes('&')` → `includes("")` — disables the same fast path.
798: `if (parts === undefined)` → `if (true)` — template parse cache: re-parsing gives the same parts.
800: `if (parsedTemplates.size === 16)` → `if (true)` — cache eviction policy only.
800: `=== 16` → `false` — unbounded cache: same results (memory only).
800: `=== 16` → `!== 16` — eviction policy only.
800: `parsedTemplates.clear()` removed — unbounded cache: same results.
802: `parsedTemplates.set(…)` removed — cache never filled: re-parsed every call, same parts.
835: `shorter.length > longer.length` → `>=` — swapping two equal-length sequences is a no-op for the (symmetric) edit distance.
842: common-prefix skip → `while (false)` — the prefix skip is an optimization: the DP over the full strings gives the same distance.
844: common-suffix skip → `while (false)` — same, for the suffix.
844: `shorter[shorterEnd + 1]` — always `undefined` (past the end) so the suffix loop never runs: same as no suffix skip.
844: `longer[longerEnd + 1]` — always `undefined`: same as no suffix skip.
852: `i <= rowLength` → `i < rowLength` — leaves `row[rowLength] = 0` (D(n, 0)); any path from that cell only goes through insertions and reaches the last row with cost m ≥ the true distance (m = longer remaining length), so the minimum is unchanged.
957: `length < common.length` → `<=` — at `length === common.length`, `common[length]` is undefined; matching `indentation[length]` (also undefined) adds 1 but `common.slice(0, length)` is still the whole of `common`.
1097: `wordLength > width` → `>=` — a word of exactly `width` graphemes is placed on its own line by either branch (it never fits after other words).
1165: `hidden <= 0` → `hidden < 0` — with `hidden === 0`, the masked form `start + '' + end` is the original string.
416: `found > 0` → `found >= 0` — position 0 is always in `boundaries`, so the loop stops there either way.
474: `string.slice(0, length + 1)` → `string`, or the test → `true` — truncate fast path (every position a grapheme boundary); the grapheme path gives the same cut and boundaries.
747: `if (NON_ASCII.test(text))` → `if (true)` — toSlug ASCII fast path: NFKD, the diacritic and transliteration replacements leave ASCII unchanged.
2564: `index < length` → `index <= length` — past the end `charCodeAt` gives `NaN`, and the next check returns the length either way.
2570: `index >= length` → `index > length` — at the end the code is `NaN`: one more iteration reaches the same `return length`.
2588: `index < length` → `index <= length` — same as 2564, for an unquoted attribute value.
2748: `if (prefix === '') return string` → `if (false)` — indent fast path: prepending `''` changes nothing.
2754: `index < parts.length` → `<=` — `parts.length` is odd and `index` even, so `index` never equals it.
2834: `index < string.length` → `<=` — `charCodeAt` past the end is `NaN`, which adds no bytes.
2838: `code >= 0x80` → `code > 0x80` — U+0080 is a C1 control, replaced before any UTF-8 length is measured.
2851: `utf8Length(string) <= budget` → `false` or `<` — fitBytes fast path: the grapheme loop keeps the whole string when it fits.
2875: `end > 0` → `true` or `end >= 0` — `string[-1]` is `undefined`, which ends the loop.
2924: `dot > 0` → `dot >= 0` — a leading dot gives an empty stem, which takes the same whole-name path as no extension.
