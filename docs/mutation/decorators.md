# decorators — equivalent mutants

## lazy

- 952: `resolveDescriptor(…)?.get` → `resolveDescriptor(…).get` — `resolveDescriptor` finds nothing only for a receiver with a `null` prototype; reading `.get` of `undefined` then throws, which the `catch` around `cacheOnInstance` turns into the same outcome (the value goes to the `WeakMap`).
- 972: `cached !== undefined || values.has(this)` → `false || …` — the `WeakMap` lookup alone gives the same answer; reading the value first only saves the `has` lookup when the cached value is not `undefined`.
- 977: `key !== undefined && …` → `true && …` — for a private getter, `cacheOnInstance` is then asked to cache under the key `"undefined"`: no prototype can hold this `@lazy` getter under that key, so it refuses and the value goes to the `WeakMap`, as before.
