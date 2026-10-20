# date — equivalent mutants

## Equivalent only in the UTC sandbox (killed in a DST zone)

Stryker runs in the container's time zone (UTC), where no hour repeats. A targeted run with `TZ=America/New_York` on lines 465, 506 and 1228 killed all 16 mutants (score 100%), so these are pinned by the existing DST tests in `date.spec.ts` ("DST transitions (assertions hold in every time zone)"):

- 465: `if (amount === 0) return result` → `false` (`addDays`) — killed under New York: re-setting the date moves an instant in the repeated fall-back hour to its first occurrence.
- 506: same in `addMonths` — killed under New York.
- 1228: `|| days === 0` → `|| false` (`getRelativeTime`) — killed under New York (a 24h+ delta inside the 25-hour fall-back day).

## Genuinely equivalent

- 1106: `value === undefined` → `true` (`cached`) — recomputes on every call (cache off); `create` is pure, so the result is the same.
- 1108: `cache.size >= MAX_CACHE_ENTRIES` → `false` — the cache is never cleared: unbounded memory, but the same results.
- 1108: `>= MAX` → `true` — clears on every insert; the results are still the same.
- 1108: `>=` → `>` — the bound moves by one entry.
- 1108: `>=` → `<` — clears while the cache is small; same results.
- 1108: `cache.clear()` → removed — same as `false` above.
- 1109: `cache.set(key, value)` → removed — nothing is cached; same results.
- 1409: `sign > 0` → `sign >= 0` (`addBusinessDays`) — `sign` is ±1: `amount === 0` returned earlier.
- 1411: same as 1409.
- 1574: `ms < 0` → `ms <= 0` (`formatDuration`) — `ms = ±0` gives no parts and returned earlier.

(The `localMidnight` survivor `setHours(12, …)` → `setMinutes(12, …)` is gone: the intermediate noon is now built directly as `new Date(2000, 0, 1, 12)`, which is 2 bytes smaller with no measurable speed change.)

## Cron (`parseCron`, `nextCronDate`, `previousCronDate`, `eachCronDate`, `isCronMatch`)

A run on the new code (lines 3638 and 4096-5028) kills 797 of 822 mutants (96.96%, 196 of them by timeout: a wrong satisfiability flag or seek makes a search loop). The 25 survivors are equivalent:

- 4445, 4505, 4550, 4845: `step > 0` → `step >= 0` — `step` is always 1 or -1.
- 4446: `value < 30` → `value <= 30` (`seekCron`) — at 30 the low word's mask keeps only bit 30 and up, which is never set, so the search goes on to the high word either way.
- 4510: `if (h < 0) return -1` → removed (`seekCronTime`) — the hour becomes -1 and the minute and second are then found, giving a negative time of day, which the caller treats like -1.
- 4575, 4576: `found < 0` → `found <= 0` (`seekCronWall`) — `seekCron` on the months returns -1 or 1-12, never 0.
- 4611 (×2), 4613: `>=`/`<=`/`>` → strict or loose (`spanOffset`) — at the exact ends of the span the offset is the span's either way; the other branch only asks `Intl` again.
- 4629: `if (near && offset === span[2]) span[side] = time` → `if (false)` — the span restarts at `time` instead of growing to it: one more `Intl` call later, same offsets.
- 4683: `gap < CRON_SHORT_JUMP` → `<=` — no time zone has a forward jump of exactly 5 minutes.
- 4706, 4758: `<= MS_PER_DAY` → `< MS_PER_DAY` (the fast paths) — a candidate exactly a day away takes the general path, which gives the same date.
- 4709, 4761: `from + offset ± CRON_HORIZON` → `from - offset ± CRON_HORIZON` — moves the 400-year horizon by less than two days.
- 4713: `offsetNear(zone, from + offset - ahead) === ahead` → `true` (`cronNext`) — that probe only avoids a bisection: when the clocks go back later than `from + offset - ahead`, the bisection ends there and the time found from it is no earlier than the first occurrence the main loop finds.
- 4720, 4777: `wall <= limit` / `wall >= limit` → strict — a match exactly at the horizon.
- 4724: `earlier > from` → `earlier >= from` — the first occurrence of a time after `from`'s wall-clock time is never `from` itself.
- 4724, 4783: `best < earlier` / `best > earlier` → `<=` / `>=` — ties return the same instant.
- 4843, 5027: `new Float64Array([NaN, NaN, NaN])` → `new Float64Array([])` — an empty array reads `undefined` (comparisons false) and ignores writes, so a single search asks `Intl` the same 3 times; only `eachCronDate`'s shared span (4958) matters, and it is pinned by the test counting offset lookups.
- 4225: `text.length > 50` → `>= 50` was killed by a 50-character field; 4487 (`wL` on day `length - 7`) and 4577 (a backward jump into a 31-day month of a leap year) by dedicated tests.
