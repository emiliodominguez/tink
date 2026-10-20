# functions — equivalent mutants

- 71: `typeof fns[i] !== 'function'` → `true` — `assertFunction` repeats the check. The guard only avoids formatting the `fns[i]` name for valid elements.
- 71: `'function'` → `""` — same as above.
- 97: `args.length === 1 ? fn.call(...)` → `false ? …` — `forward` falls back to `fn.apply`, which makes the same call. The `call` form is only there because V8 optimises it better.
- 97: `args.length === 2 ? …` → `false ? …` — same as above.
- 269: `collected.length === 0 ? args : append(...)` → `false ? …` — with nothing collected yet, `append([], args)` is a copy of the fresh rest array, so the result is the same; the shortcut only saves the copy.
- 526: `i < args.length` → `i <= args.length` — the extra `undefined` argument sends `memoizeKey` to the general `JSON.stringify` serialiser, which (by design) produces the same key as the hand-written fast path.
- 526: `i++` → `i--` — `args[-1]` is `undefined`, so the general serialiser runs: same key.
- 530: `typeof value === 'string'` → `false` — strings go to the general serialiser: same key.
- 530: `'string'` → `""` — same as above.
- 531: `Number.isFinite(value) && !Object.is(value, -0)` → `false` — numbers go to the general serialiser: same key.
- 650: `resolver === defaultMemoizeKey` → `false` — the default resolver is called through `resolver.call` / `apply` instead of inline: same key.
- 676: `arguments.length === 1` → `false` — a one-argument call is copied into an array and keyed through `memoizeKey([first])`, which takes the same direct-key shortcut: same key and call.
- 681: `if (!single)` → `if (true)` — also copies the arguments for a single argument; that copy is never read.
- 687: `single && isDirectKey(first)` → `false` — `memoizeKey([first])` takes the same direct-key shortcut itself.
- 1705: `new Array<R>(n)` → `new Array()` — preallocation only (speed); every slot is assigned before the array is returned.
- 1787: `i < next.length` → `i <= next.length` — the lengths are equal, so the extra step compares `undefined` with `undefined`.

(The `let args: unknown[] = []` → `["Stryker was here"]` survivor is gone: the initial array was never read, since a single-argument call never uses `args`. It was replaced by a definite-assignment declaration, which also saves an allocation per call.)

## matchWith / matcher and the pattern helpers

- 2041, 2043: `isArrayPrototypePolluted` → always `true` — elements are then read as own properties, which gives the same value; the check only keeps that slower read off the common path (as in `isTuple`).
- 2065: the `catch` of `prototypeOf` emptied — the function returns `undefined` either way.
- 2138: `pattern === null` → `false` — `null` then goes through `prototypeOf` (which catches `Object.getPrototypeOf(null)`) and is compared by identity: `value === null`, the same answer.
- 2154: the `scan` scratch arrays of the acyclicity check filled — it runs with a junk log / ancestor, which is never compared with a pattern.
- 2158, 2166: `index < length` → `<=` — the extra step tests `undefined` against `undefined` (array) or a symbol key that is not there (`propertyIsEnumerable(undefined)` is `false`).
- 2189: `depth + 1` → `depth - 1` for a missing key — the value is `undefined`, so the recursion stops there whatever the depth.
- 2230: the `patterns[1] === _` shortcut → `false` — the tail is copied and tested against `_`, which matches it: same answer.
- 2233: `new Array(value.length - 1)` → `new Array()` — preallocation only; every slot is assigned.
- 2271, 2278, 2290: `scan` reports a helper when there is none (`known === false` → `false`/`true`, `return false` → `return true`, `found = true`) — the pattern is then interpreted instead of compiled with `isMatching`, with the same semantics.
- 2283: the alternatives' scratch log filled, or `<=` over the helper's patterns (`scan(undefined)` is a no-op).
- 2290: `if (array)` → `if (false)`, `<=` — an array is then scanned through `Object.keys` (its indices), or one step past its end (`undefined`).
- 2484: `let expected = ''` → another string — overwritten by the first alternative before it is read.
- 2490, 3238, 3286: the ancestors / log of a `scan` seeded with a junk element — never compared with a pattern, or never read.
- 3092: the one-shot log created non-empty — it is truncated before the first test.
- 3097: `log.length !== 0` → `true` — truncates an empty log too; the guard only avoids the (costly) `length` write.
- 3237: active patterns cloned by `prepare` — a clone behaves like the original (same function, no nested pattern).
- 3237, 3238, 3336, 3337: the `'matcher'` caller of `register`, `scan`, `test` and `select` emptied — those can only throw for a circular pattern or bad captures, which `with` already rejected with the same checks.
- 3250, 3251: the copied properties made read-only or non-configurable — the copy is private and never written.
- 3296: `captures: log.length > 0` → `true` / `>= 0` — a case without captures gets an empty log, whose selection is `NO_SELECTION` too.

## allPass / anyPass

- 1267, 1269, 1271: `count === 1`, `count === 3`, `count === 2` → `false` — as for `cond` below: the call goes through `apply` with `arguments` (or the next `call` form), which makes the same calls.

## cond

- 1671, 1673, 1675: `length === 1`, `length === 3`, `length === 2` → `false` — that many arguments then go through `apply` with `arguments` (or the next `call` form, for as many arguments), which makes the same calls; the `call` forms are only there because V8 optimises them better.
