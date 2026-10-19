# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub Security Advisories](https://github.com/emiliodominguez/tinkit/security/advisories/new) ("Report a vulnerability").

Include the affected function, the input that triggers the problem and what you expected. You will get an acknowledgement within
7 days; fixes are released as a patch version and credited in the advisory unless you prefer otherwise. Please give us a reasonable
window to ship a fix before disclosing publicly.

## What counts as a vulnerability

The helpers are designed to be safe on untrusted input (query strings, JSON bodies, user-typed text). In scope, for example:

- prototype pollution or reads of `Object.prototype` members through path, merge, clone, flatten or query-string helpers, or through
  the decoders of untrusted text and data (`parseCsv`, `parseCookie`, `decodeJwt`, `deserializeError`, `persistStore` hydration);
- super-linear time (ReDoS) or unbounded memory on attacker-controlled input where the documentation does not state the cost;
- a crash that cannot be caught (stack or heap exhaustion) on input of moderate size, where the documentation promises a result
  (`safeStringify`, `serializeError`);
- validators (`validate`, `guards`, `url`) that accept input that is dangerous for the documented use;
- escaping and sanitizing helpers whose output is not safe in the documented context: `escapeHtml`, `escapeRegExp`, `serializeCookie`
  (header injection), `toCsv` with `formulaEscape` (CSV/formula injection), `toSafeFilename` (path traversal, reserved names),
  `stripAnsi` (terminal escape sequences left in the output), `sanitizeUrl`/`isSafeUrl`;
- anything in the published package or release pipeline that could let a third party ship code under this package's name.

`parse` (`validate` module), `isShape` and `isMatching` (`guards` module, also behind `matcher` in `functions`) compile each object schema
or pattern once with `new Function`, like zod 4: only the schema's keys reach the generated
source, as `JSON.stringify` string literals, and no input value is ever evaluated. Where code generation is disallowed (a Content Security
Policy without `'unsafe-eval'`, Cloudflare Workers) it falls back to a loop; the first attempt may still log a CSP violation report.

Some helpers are deliberately NOT security boundaries, and say so in their documentation: `decodeJwt`, `getJwtExpiration` and
`isJwtExpired` read a token without verifying its signature (verify it with a JWT library before trusting any claim); `stripHtml`
extracts text and is not an HTML sanitizer (its output must never be inserted as HTML); `timingSafeEqual` does not hide the length of
its inputs. Reports that only restate these documented limits are not vulnerabilities.

Documented costs (for example the O(n·m) of `levenshtein` or `fuzzyMatch`, or the quadratic `Intl.Segmenter` of Node 20 behind the grapheme-aware
string helpers) and `Math.random` defaults (pass `secureRandom` from the
`random` module where unpredictability matters) are not vulnerabilities, but unclear documentation about them is a welcome report.

## Supply chain

- Zero runtime dependencies.
- Releases are published by the maintainer after `yarn validate` passes (`prepublishOnly` runs it). The `release.yml` workflow can
  publish instead, with npm trusted publishing (OIDC, no long-lived token) and
  [provenance](https://docs.npmjs.com/generating-provenance-statements); `npm audit signatures` verifies the releases it published.
- Workflow actions are pinned to commit SHAs and kept current by Dependabot.
