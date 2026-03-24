---
phase: 03-integration-tests-browser
plan: "02"
subsystem: integration-tests
tags: [browser, playwright, integration-tests, sqlite, workers, opfs]
dependency_graph:
  requires:
    - 03-01 (browser test infrastructure — rstest.browser.config.ts, helpers.ts)
  provides:
    - INT-02: createSQLiteClient worker pool initialization tests
    - INT-03: db.read() query tests
    - INT-04: db.write() mutation tests
    - INT-05: db.stream() streaming tests
    - INT-06: db.one() single-row tests
  affects:
    - tests/browser/init.test.ts
    - tests/browser/queries.test.ts
tech_stack:
  added: []
  patterns:
    - "createTestClient() helper from helpers.ts for UUID-based DB + OPFS cleanup"
    - "for await...of loop for AsyncGenerator stream testing"
    - "Manual OPFS cleanup in tests that bypass createTestClient"
key_files:
  created:
    - tests/browser/init.test.ts
    - tests/browser/queries.test.ts
  modified: []
decisions:
  - "Use db.read('SELECT 1') as the worker-READY probe — no exposed .ready property needed"
  - "Manual OPFS cleanup for poolSize:1 test that cannot use afterEach via createTestClient"
metrics:
  duration: "~1min"
  completed_date: "2026-03-24"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
requirements:
  - INT-02
  - INT-03
  - INT-04
  - INT-05
  - INT-06
---

# Phase 03 Plan 02: Browser Integration Tests — Init and Query Methods Summary

Browser integration tests for `createSQLiteClient` worker pool initialization (INT-02) and the four public query methods `read`, `write`, `stream`, `one` (INT-03 to INT-06) using real Chromium + OPFS via Playwright.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Écrire tests/browser/init.test.ts (INT-02) | 78458f3 | tests/browser/init.test.ts |
| 2 | Écrire tests/browser/queries.test.ts (INT-03–INT-06) | fa70fdb | tests/browser/queries.test.ts |

## What Was Built

### tests/browser/init.test.ts (INT-02)

Three tests validating that `createSQLiteClient` successfully initialises the worker pool:

1. **Worker pool reaches READY**: uses `db.read('SELECT 1 AS value')` as a probe — the request queues until a worker is READY; if the pool fails to initialize, the request rejects or times out.
2. **poolSize: 1 (minimum)**: instantiates `createSQLiteClient` directly with `{ poolSize: 1 }` and performs manual OPFS cleanup (no `afterEach` wrapper).
3. **Consecutive calls**: creates a table, inserts rows, reads back — validates stable multi-call behaviour.

### tests/browser/queries.test.ts (INT-03 to INT-06)

Ten tests across four describe blocks:

**INT-03 — db.read():**
- Returns typed row array after CREATE + INSERT
- Returns empty array when SELECT has no results
- Supports positional parameters (`?` placeholders)

**INT-04 — db.write():**
- INSERT returns `{ result: [], affected: 2 }`
- UPDATE returns correct `affected` count
- DELETE returns correct `affected` count and verifies remaining rows via `db.read()`

**INT-05 — db.stream():**
- 50-row dataset with `chunkSize: 10` — all chunks satisfy `length <= 10`, all rows recovered via `chunks.flat()`
- Single-row dataset yields at least one chunk

**INT-06 — db.one():**
- Returns first row (with correct field values) when result exists
- Returns `undefined` when SELECT has no results
- Returns only the first row even when multiple rows match

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all tests are fully wired to real API methods via `createTestClient()`.

## Self-Check: PASSED

- [x] tests/browser/init.test.ts exists
- [x] tests/browser/queries.test.ts exists
- [x] Commit 78458f3 verified in git log
- [x] Commit fa70fdb verified in git log
- [x] 3 `it(` cases in init.test.ts (>=3 required)
- [x] 4 `describe(` blocks in queries.test.ts (INT-03 to INT-06)
