# path — equivalent mutants

97: `let index = end - 1` → `end + 1` — the scan starts past the end: `charCodeAt` is `NaN` there, not a `/`, so the extra iterations `continue`. (Starting at `end`, which has no mutant, puts an out-of-range `charCodeAt` in the hot loop and measured ~25% slower on clean paths.)
148: `if (body.length + … === path.length) return path` → `if (false)` — fast path: when nothing was removed, the rebuilt `'/' + body + '/'` has the same characters as the input, so the input is returned instead of a new concatenation.
148: `body.length + (absolute ? 1 : 0) + (trailing ? 1 : 0)` → `… - (trailing ? 1 : 0)` — same fast path: normalizing never adds characters, so the mutated sum only matches without a trailing slash, where it equals the original; otherwise the slow path rebuilds the same string.
148: `body.length + (absolute ? 1 : 0) + …` → `body.length - (absolute ? 1 : 0) + …` — same fast path, by the same argument for the leading slash.
161: `body.length + 1 === path.length ? path : …` → `false ? path : …` — fast path of `resolveAbsolute`: an absolute path that needs no change is returned instead of being rebuilt as `'/' + body`.
161: `body.length + 1` → `body.length - 1` — same fast path (the body is never longer than the input minus its leading slash, so the mutated test is never true).
171: `path.charCodeAt(0) === SLASH ? path : '/' + path` → `false ? …` — prefixing an absolute path with another `/` normalizes to the same result, but the concatenated string has to be flattened before the scan and misses the fast path (`relativePath` measured ~2× slower).
412: `if (absolute || segment.length === 0) continue` → `if (absolute || false)` — joining an empty segment adds a `/` that normalization removes again; skipping it keeps the joined string eligible for the fast path.
414: `resolved.length > 0 ? segment + '/' + resolved : segment` → `true ? …` — the extra trailing `/` is removed by normalization; avoiding it keeps the fast path of `resolveAbsolute`.
414: `resolved.length > 0` → `resolved.length >= 0` — same as the previous mutant.
606: `path.includes('\\') ? path.split('\\').join('/') : path` → `path.includes("")` — fast path: a path without a backslash is returned without splitting and joining (measured ~4× faster), which gives the same string.
