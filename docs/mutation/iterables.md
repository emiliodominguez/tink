# iterables — equivalent mutants

- 66: `iterable[Symbol.iterator] === ARRAY_ITERATOR` → `false` — fast path: an array is then wrapped by `awaitedItems`, which yields the same awaited items (the built-in array iterator has no `return` to call, so closing behaviour is identical); only skips a generator layer.
- 570: `new Array<unknown>(iterators.length)` → `new Array()` — preallocation only: every slot is assigned before the tuple is yielded (an incomplete tuple is discarded).
- 776: `Array.isArray(iterable)` → `true` — spread copies any iterable exactly like the `for...of` loop (holes read as `undefined` either way); the check only picks the faster copy.
- 776: `Array.isArray(iterable)` → `false` — the `for...of` loop copies arrays exactly like spread; fast path only.
- 1660: `const states: number[] = []` → `["Stryker was here"]` (`mergeAsync`) — every slot read is first written by `pull` or `arrive`; a source whose slot was never written (its iterator opened, then a later one failed to open) is idle, and a stray string is idle too.
- 1778: `const closing: Array<Promise<unknown>> = []` → `["Stryker was here"]` (`mergeAsync`) — `Promise.allSettled` reports a non-promise as fulfilled, so the extra entry never changes the outcome.
- 2182: `reader?.releaseLock()` → `reader.releaseLock()` — without a reader (an iterable source) the call throws a `TypeError`, which the surrounding `try` ignores, exactly like a `releaseLock` that throws.
- 2239: `typeof source === 'string'` → `false` / `typeof source === ""` — a whole string is then iterated by code point instead of read as one chunk; every code point is a string chunk, decoded and split identically (only slower).
- 2250: `signal === undefined` → `false` — without a signal, `interruptible` only wraps the read in another promise (nothing ever calls `interrupt`): the same result, two ticks later.
- 2269: `iterator?.return?.()` → `iterator.return?.()` — `iterator` is only `undefined` when `getReader()` threw, and then the close runs with a failure, which ignores the `TypeError`.
- 2315: `{ decoder: undefined, pending: false, started: false }` → `{}` — the missing fields read as `undefined`, which every use treats like `undefined`/`false`.
- 2425: `lf < cr` → `lf <= cr` — `lf` and `cr` are positions of different characters, never equal.
- 2443: `state.parts.length > 0` → `true` / `>= 0` — joining a single piece gives that piece: the check only skips the array round trip.
- 2681: `const pending: string[] = []` → `["Stryker was here"]` (`parseSSE`) — the stray first line has no colon and is not a field name, so it is ignored like any unknown field.
