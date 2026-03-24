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

### Active

<!-- Goals for this milestone. All are hypotheses until shipped and validated. -->

- [x] Fix pragma bug — inverted condition in `allQueryPragmas` means pragmas are never applied (Validated in Phase 1: Bug Fixes & Type Safety)
- [x] Fix hardcoded logger levels — expose consumer-configurable verbosity instead of hardcoded `debug`/`info` (Validated in Phase 1: Bug Fixes & Type Safety)
- [x] `wa-sqlite.d.ts` ambient declarations — restore type safety, remove `@ts-expect-error` directives (Validated in Phase 1: Bug Fixes & Type Safety)
- [x] Replace placeholder test suite — remove `squared()` test, wire real API (Validated in Phase 1: Bug Fixes & Type Safety)
- [x] Unit tests for pure functions — `isWriteQuery`, `sqlParams`, `debugSQLQuery` (no browser required) (Validated in Phase 2: Unit Tests)
- [ ] Integration tests in real browser — Playwright-based tests for `createSQLiteClient`, worker pool, streaming, abort
- [ ] JSDoc comments on public API — `createSQLiteClient`, `SQLiteDB` methods, key types
- [ ] README for library consumers — install, configure, use, VFS selection guide

### Out of Scope

- Transaction API — implied by JSDoc comments but not in scope for this milestone; defer to v2
- Node.js support — browser-only by design; no polyfill planned
- `RESERVED` worker status (value 49) — defined but unused, no action needed
- OAuth / security hardening of SQL params typing — low priority for a browser-local SQLite lib

## Context

- **wa-sqlite**: GitHub dependency (`rhashimoto/wa-sqlite#v1.0.9`), no npm publish, no TypeScript declarations. Three WASM builds: sync (`wa-sqlite.mjs`), async/OPFS (`wa-sqlite-async.mjs`), JSPI (`wa-sqlite-jspi.mjs`).
- **SharedArrayBuffer** requires `Cross-Origin-Isolation` headers (`COOP`/`COEP`) in the browser. OPFS requires modern Chrome/Edge. JSPI is Chrome-only (experimental).
- **Build**: Rslib (outputs ESM/CJS/UMD). **Test runner**: Rstest with `@rstest/adapter-rslib`.
- **Known bugs** at project start: pragma condition inverted, logger levels hardcoded, test suite imports non-existent function.
- **@lalex/console** and **@lalex/promises** are private/pre-release packages — treat as stable for this milestone.

## Constraints

- **Tech stack**: TypeScript + Rstest — no migration to Vitest or other test runners
- **Browser-only**: integration tests require a real browser environment (Playwright)
- **Dependencies**: wa-sqlite has no TypeScript declarations — must author ambient types manually
- **Compatibility**: SharedArrayBuffer + OPFS limit support to modern browsers with proper headers; no fallback in scope

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stay with Rstest for unit tests | Already configured, consistent with build pipeline | Confirmed — Phase 1 |
| Add Playwright for integration tests | Only way to test Web Workers + OPFS in a real browser | — Pending Phase 3 |
| Fix bugs as part of this milestone | Bugs make tests unreliable; must fix before validating behavior | Done — Phase 1 |
| Author `wa-sqlite.d.ts` manually | No upstream declarations; needed to remove `@ts-expect-error` | Done — Phase 1 |

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
*Last updated: 2026-03-24 after Phase 2 completion*
