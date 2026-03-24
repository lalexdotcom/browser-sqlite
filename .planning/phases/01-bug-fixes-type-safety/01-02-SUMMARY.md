---
phase: 01-bug-fixes-type-safety
plan: "02"
subsystem: api
tags: [typescript, sqlite, web-workers, types]

requires:
  - phase: 01-01
    provides: "@lalex/promises dependency and logLevel field on ClientMessageData"

provides:
  - "CreateSQLiteClientOptions (correct spelling, no double-L typo)"
  - "SQLiteDB type with full method surface: read, write, stream, one, transaction, bulkWrite, output, close, debug"
  - "logLevel option on CreateSQLiteClientOptions controlling LL logger verbosity at runtime"
  - "logLevel forwarded to worker via open postMessage"
  - "No satisfies cast on createSQLiteClient return"
  - "Zero commented-out LL.wth debug lines in client.ts"

affects:
  - 01-03
  - 01-04
  - consumers of SQLiteDB type

tech-stack:
  added: []
  patterns:
    - "TransactionDB uses Pick<SQLiteDB, ...> to avoid extending full public surface"
    - "LL.level set dynamically from clientOptions.logLevel with 'warn' default"

key-files:
  created: []
  modified:
    - src/client.ts
    - src/debug.ts

key-decisions:
  - "TransactionDB narrowed to Pick<SQLiteDB, 'read' | 'write' | 'stream' | 'one'> to avoid TypeScript compatibility errors when SQLiteDB was widened"
  - "debug conditional block replaced with typed empty destructure (ReturnType<typeof createClientDebug>) to keep destructured names valid without debug boolean"
  - "debug.ts fixed as deviation — it still referenced CreateSQLLiteClientOptions after the rename"

patterns-established:
  - "SQLiteDB is the full public contract; internal types (TransactionDB) use Pick to restrict to what they implement"

requirements-completed:
  - BUG-02
  - BUG-03
  - BUG-05
  - TYPE-02

duration: 3min
completed: "2026-03-24"
---

# Phase 01 Plan 02: Fix client.ts type and API surface Summary

**Renamed CreateSQLLiteClientOptions typo, widened SQLiteDB with transaction/bulkWrite/output/close/debug methods, added logLevel option replacing debug boolean, removed satisfies cast and all commented LL.wth lines**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-24T10:46:55Z
- **Completed:** 2026-03-24T10:49:52Z
- **Tasks:** 2
- **Files modified:** 2 (src/client.ts, src/debug.ts)

## Accomplishments

- Fixed double-L typo: `CreateSQLLiteClientOptions` → `CreateSQLiteClientOptions` across all source files (BUG-02)
- Widened `SQLiteDB` type to include `transaction`, `bulkWrite`, `output`, `close`, `debug` so the public type matches the actual returned API (BUG-03)
- Removed `satisfies (...args: any[]) => SQLiteDB` cast so TypeScript infers the full return type without constraint (BUG-03)
- Replaced `debug?: boolean` with `logLevel?: 'debug' | 'info' | 'warn' | 'error'` and applied it to `LL.level` with `'warn'` default (BUG-05)
- Forwarded `logLevel` in the worker `open` postMessage so the worker can apply the same log level (BUG-05)
- Deleted all eight commented `// LL.wth(...)` blocks plus two commented `releaseWorker`/`for` lines (TYPE-02)
- `index.ts` requires no change — uses `export *` which automatically re-exports the renamed type

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix CreateSQLiteClientOptions type — rename, add logLevel, remove debug field** - `f5cd8d6` (feat)
2. **Task 2: Update index.ts re-export** — no code change needed; `export *` propagates rename automatically

**Plan metadata:** committed with this SUMMARY

## Files Created/Modified

- `src/client.ts` — Renamed type, widened SQLiteDB, added logLevel, removed satisfies cast and dead comments
- `src/debug.ts` — Fixed reference from CreateSQLLiteClientOptions to CreateSQLiteClientOptions (deviation fix)

## Decisions Made

- `TransactionDB` changed from `SQLiteDB & { commit; rollback }` to `Pick<SQLiteDB, 'read' | 'write' | 'stream' | 'one'> & { commit; rollback }` — widening SQLiteDB would have caused a structural compatibility error since the transaction db object doesn't implement the new methods
- `debug` conditional block replaced with `{} as ReturnType<typeof createClientDebug>` — preserves destructured names without runtime behaviour change; debug wiring is out of scope for this phase

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed CreateSQLLiteClientOptions reference in debug.ts**

- **Found during:** Task 1 (rename propagation)
- **Issue:** `src/debug.ts` imported `CreateSQLLiteClientOptions` from `./client`; after the rename the import would fail at compile time (TypeScript error TS2724)
- **Fix:** Updated the import and internal `Required<Pick<CreateSQLLiteClientOptions, ...>>` usage in debug.ts to use `CreateSQLiteClientOptions`
- **Files modified:** `src/debug.ts`
- **Verification:** `grep -r "CreateSQLLiteClientOptions" src/` returns no results; TypeScript no longer emits TS2724
- **Committed in:** `f5cd8d6` (part of Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug: rename not propagated to debug.ts)
**Impact on plan:** Necessary fix — without it the rename would cause a compile-time import error. No scope creep.

## Issues Encountered

- Pre-existing TypeScript errors for `Worker`, `self`, and `MessageEvent` globals in client.ts and worker.ts — these are expected in a browser-targeted library using tsconfig without `lib: ["DOM"]`. They are out of scope for this plan.

## Next Phase Readiness

- `SQLiteDB` public type now matches the actual `createSQLiteClient` return object — consumers get full API visibility
- `CreateSQLiteClientOptions` correctly spelled and exported via `index.ts`'s `export *`
- `logLevel` option is wired end-to-end: client logger + worker open message
- Ready for Plan 03 and 04 to address remaining type and correctness issues

## Self-Check

- [x] `src/client.ts` exists and contains `CreateSQLiteClientOptions` (2 occurrences), `logLevel` (3 occurrences), `transaction:` in SQLiteDB type
- [x] `src/debug.ts` exists and uses `CreateSQLiteClientOptions` (no old typo)
- [x] Commit `f5cd8d6` exists in git log

## Self-Check: PASSED

---
*Phase: 01-bug-fixes-type-safety*
*Completed: 2026-03-24*
