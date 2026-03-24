# wsqlite

## What This Is

A browser-side TypeScript library that runs SQLite inside Web Workers using WebAssembly (wa-sqlite). It manages a pool of workers — one dedicated writer, N concurrent readers — coordinated via `SharedArrayBuffer` + `Atomics`. The public API exposes `read`, `write`, `stream`, and `one` methods designed for high-volume, low-memory-footprint data operations in the browser.

## Core Value

Reliable, low-memory SQLite access in the browser with correct concurrent read / serial write isolation.

## Requirements

### Validated

<!-- Capabilities confirmed to exist in the current codebase. -->

- ✓ Worker pool with read/write separation via `SharedArrayBuffer` + `Atomics` — existing
- ✓ `createSQLiteClient()` factory with configurable VFS, pool size, pragmas — existing
- ✓ `db.read()`, `db.write()`, `db.stream()`, `db.one()` query methods — existing
- ✓ Chunked result streaming for low memory footprint — existing
- ✓ AbortSignal support for query cancellation — existing
- ✓ Worker lifecycle state machine (EMPTY → READY → RUNNING → DONE) — existing
- ✓ Multiple VFS backends (memory, OPFS, IndexedDB, JSPI) — existing
- ✓ Debug infrastructure (`createClientDebug`, `createWorkerDebugState`) — existing
- ✓ Fix pragma bug — inverted condition in `allQueryPragmas` means pragmas are never applied — v1.0
- ✓ Fix hardcoded logger levels — expose consumer-configurable verbosity instead of hardcoded `debug`/`info` — v1.0 (then removed entirely in post-phase cleanup)
- ✓ `wa-sqlite.d.ts` ambient declarations — restore type safety, remove `@ts-expect-error` directives — v1.0
- ✓ Replace placeholder test suite — remove `squared()` test, wire real API — v1.0
- ✓ Unit tests for pure functions — `isWriteQuery`, `sqlParams`, `debugSQLQuery` (no browser required) — v1.0
- ✓ Integration tests in real browser — Playwright-based tests for `createSQLiteClient`, worker pool, streaming, abort — v1.0
- ✓ JSDoc comments on public API — `createSQLiteClient`, `SQLiteDB` methods, key types — v1.0
- ✓ README for library consumers — install, configure, use, VFS selection guide — v1.0
- ✓ `@lalex/console` optional — fully removed in post-phase cleanup; native `console` methods used directly — v1.0

### Active

<!-- Goals for next milestone. -->

*(No active requirements — planning next milestone)*

### Out of Scope

- Transaction API — implied by JSDoc comments but not in scope; defer to v2
- Node.js support — browser-only by design; no polyfill planned
- `RESERVED` worker status (value 49) — defined but unused, no action needed
- OAuth / security hardening of SQL params typing — low priority for a browser-local SQLite lib
- `logLevel` option / verbose logging — removed in v1.0 post-phase cleanup; may revisit in a future milestone with a cleaner logging strategy

## Context

- **wa-sqlite**: GitHub dependency (`rhashimoto/wa-sqlite#v1.0.9`), no npm publish, no TypeScript declarations. Three WASM builds: sync (`wa-sqlite.mjs`), async/OPFS (`wa-sqlite-async.mjs`), JSPI (`wa-sqlite-jspi.mjs`).
- **SharedArrayBuffer** requires `Cross-Origin-Isolation` headers (`COOP`/`COEP`) in the browser. OPFS requires modern Chrome/Edge. JSPI is Chrome-only (experimental).
- **Build**: Rslib — ESM-only output (`dist/esm/`). CJS and UMD removed (browser-only library). **Test runner**: Rstest with `@rstest/adapter-rslib`; single `rstest.config.ts` with `projects` array (unit + browser).
- **@lalex/console**: fully removed — no logging infrastructure in the library. Workers are silent; consumers wire their own observability.
- **Test suite**: 57 unit tests + 25 browser tests = 82 total, all passing.
- **Tech debt from v1.0**: stale VALIDATION.md frontmatter (nyquist_compliant: false), 6 pending human verification items (browser test runner, IDE hover tooltips), client LL shim filtering asymmetry (now moot since logging removed).

## Constraints

- **Tech stack**: TypeScript + Rstest — no migration to Vitest or other test runners
- **Browser-only**: integration tests require a real browser environment (Playwright)
- **Dependencies**: wa-sqlite has no TypeScript declarations — must author ambient types manually
- **Compatibility**: SharedArrayBuffer + OPFS limit support to modern browsers with proper headers; no fallback in scope

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stay with Rstest for unit tests | Already configured, consistent with build pipeline | ✓ Confirmed — Phase 1 |
| Add Playwright for integration tests | Only way to test Web Workers + OPFS in a real browser | ✓ Done — Phase 3 |
| Fix bugs as part of this milestone | Bugs make tests unreliable; must fix before validating behavior | ✓ Done — Phase 1 |
| Author `wa-sqlite.d.ts` manually | No upstream declarations; needed to remove `@ts-expect-error` | ✓ Done — Phase 1 |
| Use wildcard (*) for @lalex/promises | Pre-release private package, treated as stable for this milestone | ✓ No issues |
| logLevel field optional on open variant | Existing call sites remain valid until consumers opt in | ✓ Moot — logLevel removed |
| TransactionDB narrowed to Pick<SQLiteDB> | Avoids compatibility errors when SQLiteDB is widened | ✓ Stable |
| Opaque wa-sqlite handles typed as `any` | Minimally typed ambient declarations; sufficient for type safety goals | ✓ Done |
| Only test lock() when FREE in Node | Atomics.wait hangs main thread if lock already held | ✓ Tests pass |
| PRAGMA/ATTACH/DETACH route to write worker | Conservative routing; confirmed by D3 | ✓ Tested |
| UUID-based DB name in createTestClient() | Prevents OPFS collisions in parallel browser test runs | ✓ Works |
| Use db.read('SELECT 1') as worker-READY probe | No exposed .ready property needed | ✓ Clean API |
| ESM-only build | Library is browser-only; CJS/UMD add complexity with no benefit | ✓ Done — post-v1.0 quick task |
| Single rstest.config.ts with projects array | Eliminates config duplication between unit and browser | ✓ Done — post-v1.0 quick task |
| Remove all logging infrastructure | @lalex/console optional was implemented then removed; workers are silent | ✓ Simpler codebase |
| dev.browserLogs: false in rstest browser config | Suppresses rsbuild HMR client window.location.reload() noise from worker bundles | ✓ Clean test output |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-24 after v1.0 milestone*
