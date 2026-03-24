---
status: complete
phase: 03-integration-tests-browser
source: [03-VERIFICATION.md]
started: 2026-03-24T13:00:00.000Z
updated: 2026-03-24T13:37:00.000Z
---

## Tests

### 1. Full browser test suite passes
expected: `pnpm test:browser` exits 0 with all 24 tests green in Chromium headless
result: pass — 27/27 tests green (3 tests were added vs initial count)

### 2. COOP/COEP headers active at runtime
expected: `self.crossOriginIsolated === true` inside browser test context (SharedArrayBuffer available)
result: pass — SharedArrayBuffer available (no longer throws), WorkerOrchestrator initialises correctly

## Summary

total: 2
passed: 2
issues: 0
pending: 0
skipped: 0
blocked: 0

## Notes

Fixes required to reach green:
- `@rsbuild/plugin-node-polyfill` — polyfill node:process / util imported by @lalex/console
- `pluginCrossOriginIsolation` — inject COOP/COEP headers via modifyRsbuildConfig (server.headers
  at defineConfig root level is not forwarded to the rstest browser dev server)
- `process.env.NODE_DEBUG` define — prevent crash when rstest's source.define replaces process.env
  with globalThis[Symbol.for("rstest.env")] before util.js initialises
- Bug fix in db.one(): missing `break` after first chunk caused last row to be returned instead of first

## Gaps
