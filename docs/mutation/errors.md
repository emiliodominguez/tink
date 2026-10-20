# errors — equivalent mutants

## deserializeError

- 283: the `catch` of `readName` emptied (`return undefined` removed) — the function then returns `undefined` all the same.

## getErrorChain

- 727: `seen === undefined && chain.length > 16` → `false`, `true`, `||`, `seen !== undefined`, `true && …`, `… && true`, `>= 16`, `<= 16` — this only picks when the cycle check switches from scanning the chain to a `Set` (built from the chain, then kept in step with it): every variant finds the same cycles, by scanning for longer or by rebuilding the `Set` more often, which only costs time.
- 728: `seen === undefined ? chain.includes(cause) : seen.has(cause)` → `true ? …` — scanning the chain once the `Set` exists gives the same answer (the `Set` holds exactly the chain's values).
