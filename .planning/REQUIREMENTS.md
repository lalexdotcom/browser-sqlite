# Requirements: wsqlite

**Defined:** 2026-03-24
**Core Value:** Reliable, low-memory SQLite access in the browser with correct concurrent read / serial write isolation.

## v1 Requirements

Requirements for the initial quality milestone. Each maps to a roadmap phase.

### Bug Fixes

- [ ] **BUG-01**: The `allQueryPragmas` condition is inverted — pragmas must be applied when the pragmas object is non-empty
- [x] **BUG-02**: `CreateSQLLiteClientOptions` has a double-L typo — rename to `CreateSQLiteClientOptions` across the public API
- [x] **BUG-03**: The `satisfies (...args: any[]) => SQLiteDB` constraint on `createSQLiteClient` hides methods from the documented return type — widen or remove the constraint
- [x] **BUG-04**: `@lalex/promises` is used in `client.ts` but missing from `package.json` dependencies
- [x] **BUG-05**: Logger levels are hardcoded (`LL.level = 'debug'` in worker, `'info'` in client) — expose a consumer-configurable option

### Type Safety

- [ ] **TYPE-01**: Author `src/wa-sqlite.d.ts` ambient declarations covering `SQLiteAPI`, VFS classes, and WASM factory functions — removes all `@ts-expect-error` directives in `worker.ts`
- [x] **TYPE-02**: Clean up commented-out debug code and orphaned `console.log` lambdas in `client.ts` and `worker.ts`

### Unit Tests

- [ ] **TEST-01**: Remove placeholder `squared()` test — replace `tests/index.test.ts` with real test infrastructure
- [ ] **TEST-02**: Unit tests for `isWriteQuery()` — covers standard DML, DDL, edge cases (PRAGMA, CTEs, WITH...INSERT, ATTACH)
- [ ] **TEST-03**: Unit tests for `sqlParams()` — parameter deduplication logic, positional and named variants
- [ ] **TEST-04**: Unit tests for `debugSQLQuery()` — parameter interpolation correctness
- [ ] **TEST-05**: Unit tests for `WorkerOrchestrator` — lock/unlock, `setStatus`/`getStatus`, `compareExchangeStatus`, state transitions (testable in Node via native `SharedArrayBuffer`)

### Integration Tests

- [ ] **INT-01**: Configure Rstest browser mode with Playwright (Chromium) — add COOP/COEP headers to the test server
- [ ] **INT-02**: Integration test — `createSQLiteClient` initializes and pool workers reach READY state
- [ ] **INT-03**: Integration test — `db.read()` executes a SELECT and returns typed rows
- [ ] **INT-04**: Integration test — `db.write()` executes INSERT/UPDATE/DELETE and returns affected row count
- [ ] **INT-05**: Integration test — `db.stream()` yields rows in chunks and respects chunk size option
- [ ] **INT-06**: Integration test — `db.one()` returns a single row or `undefined` for no result
- [ ] **INT-07**: Integration test — concurrent reads are served by different workers in parallel
- [ ] **INT-08**: Integration test — write operations are serialized through the single writer worker
- [ ] **INT-09**: Integration test — AbortSignal cancels an in-flight query
- [ ] **INT-10**: Integration test — error in SQL (syntax error, missing table) rejects the promise with a meaningful error

### Documentation

- [ ] **DOC-01**: JSDoc on `createSQLiteClient` — parameters, side effects (worker pool spawn), browser requirements (COOP/COEP), `@throws`, `@example`
- [ ] **DOC-02**: JSDoc on `SQLiteDB` interface methods — `read`, `write`, `stream`, `one`, `close` — concurrency semantics, streaming memory implications, AbortSignal behavior
- [ ] **DOC-03**: JSDoc on `CreateSQLiteClientOptions` — each field, its default, what happens if omitted
- [ ] **DOC-04**: Inline comments on `WorkerOrchestrator` and worker lifecycle state machine
- [ ] **DOC-05**: `README.md` for library consumers — browser requirements (COOP/COEP) first, then install, VFS selection guide, usage examples, limitations

## v2 Requirements

Deferred to a future milestone. Tracked but not in current roadmap.

### Transactions

- **TXN-01**: `db.transaction(fn)` — wraps multiple write operations in a SQLite transaction

### DX

- **DX-01**: `MemoryVFS` exposed in `SQLiteVFS` type (useful for tests and ephemeral DBs)
- **DX-02**: `PRAGMA` and `ATTACH DATABASE` routed correctly (treated as write ops)
- **DX-03**: TypeScript types for SQL parameters narrowed from `any[]` to `SQLiteValue[]`

## Out of Scope

| Feature | Reason |
|---------|--------|
| Node.js support | Browser-only by design; no polyfill planned |
| `RESERVED` worker status | Defined but intentionally unused |
| OAuth / SQL injection hardening | Browser-local SQLite, parameterized queries already used |
| Migration to Vitest | Rstest is the established test runner for this stack |
| Mobile / React Native support | Out of browser scope |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BUG-01 | Phase 1 | Pending |
| BUG-02 | Phase 1 | Complete |
| BUG-03 | Phase 1 | Complete |
| BUG-04 | Phase 1 | Complete |
| BUG-05 | Phase 1 | Complete |
| TYPE-01 | Phase 1 | Pending |
| TYPE-02 | Phase 1 | Complete |
| TEST-01 | Phase 2 | Pending |
| TEST-02 | Phase 2 | Pending |
| TEST-03 | Phase 2 | Pending |
| TEST-04 | Phase 2 | Pending |
| TEST-05 | Phase 2 | Pending |
| INT-01 | Phase 3 | Pending |
| INT-02 | Phase 3 | Pending |
| INT-03 | Phase 3 | Pending |
| INT-04 | Phase 3 | Pending |
| INT-05 | Phase 3 | Pending |
| INT-06 | Phase 3 | Pending |
| INT-07 | Phase 3 | Pending |
| INT-08 | Phase 3 | Pending |
| INT-09 | Phase 3 | Pending |
| INT-10 | Phase 3 | Pending |
| DOC-01 | Phase 4 | Pending |
| DOC-02 | Phase 4 | Pending |
| DOC-03 | Phase 4 | Pending |
| DOC-04 | Phase 4 | Pending |
| DOC-05 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 25 total
- Mapped to phases: 25
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-24*
*Last updated: 2026-03-24 after initialization*
