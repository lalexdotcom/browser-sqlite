---
phase: 2
phase_name: Unit Tests
created: "2026-03-24"
status: ready_to_plan
---

# Phase 2 Context: Unit Tests

## Phase Goal

Every pure function and the `WorkerOrchestrator` state machine are covered by fast, Node-mode tests.

## Decisions

### D1 — Test file naming convention

**Decision:** `*.test.ts` files inside `tests/unit/` directory.

Files: `tests/unit/utils.test.ts`, `tests/unit/debug.test.ts`, `tests/unit/orchestrator.test.ts`

The existing rstest `include` pattern (`tests/**/*.test.ts`) already covers this. No change to `rstest.config.ts` needed for the include pattern. Plan 1 description in ROADMAP (which mentioned `**/*.unit.test.ts`) is superseded by this decision.

### D2 — WorkerOrchestrator lock/unlock testing strategy

**Decision:** Test the non-blocking case only in Node unit tests; defer blocking behavior to Phase 3 browser integration tests.

**Rationale:** The library targets a browser/Web Worker environment where `Atomics.wait` is valid. In Node.js, `Atomics.wait` is only allowed inside `worker_threads`, not the main thread. Introducing worker_threads plumbing in unit tests adds complexity without matching the real execution environment.

**What to test in Phase 2 (Node-safe):**
- `lock()` when the lock is already free → acquires immediately (no `Atomics.wait` called, CAS succeeds on first try)
- `unlock()` after acquiring → releases the lock (state returns to FREE, notify is called)
- `setStatus()` unconditional exchange — sets new status, returns true if value changed
- `setStatus()` CAS variant — only updates when `from` matches current status
- `getStatus()` — reads correct status for each worker index
- SAB sharing — two `WorkerOrchestrator` instances sharing the same `SharedArrayBuffer` observe each other's status changes

**What is deferred to Phase 3:**
- `lock()` blocking behavior when lock is already held (requires two concurrent threads)

### D3 — `isWriteQuery` regex extension

**Decision:** Extend the regex to include `PRAGMA` and `ATTACH`/`DETACH`.

**Rationale:** `PRAGMA x = y` modifies database settings (journal_mode, user_version, etc.) and should be routed to the writer worker. `ATTACH`/`DETACH` modify the database connection state. Both are semantically write operations in the context of routing queries to the writer pool.

**New regex target:**
```
/(INSERT|REPLACE|UPDATE|DELETE|CREATE|DROP|PRAGMA|ATTACH|DETACH)\s/gim
```

**Tests validate the extended behavior:**
- Standard DML: INSERT, UPDATE, DELETE, REPLACE → true
- DDL: CREATE TABLE, DROP TABLE → true
- Extended: PRAGMA journal_mode = WAL → true; ATTACH 'x' AS y → true; DETACH y → true
- Read-only: SELECT, WITH...SELECT → false
- CTE write: WITH cte AS (...) INSERT INTO... → true (INSERT present)
- PRAGMA read: `PRAGMA table_info(foo)` → true (conservative — all PRAGMAs treated as writes)
- Lowercase variants: `insert`, `create`, `pragma` → true (regex flag `i`)

**Note on PRAGMA read-only variants:** Distinguishing read vs write pragmas requires parsing pragma names — out of scope. All PRAGMAs are treated as writes for safe routing to the writer worker.

## Codebase Notes (for researcher/planner)

- `src/utils.ts` — `isWriteQuery(sql)` and `sqlParams()` factory (deduplication via Map, positional `?001` format)
- `src/debug.ts` — `debugSQLQuery(sql, params?)` interpolates `?001` positional params and bare `?` params, skips string literals, handles Date/Buffer/null/undefined
- `src/orchestrator.ts` — `WorkerOrchestrator` class: constructor(size|SAB), lock(), unlock(), setStatus(index, status, from?), getStatus(index)
- `tests/` directory is currently empty (placeholder test was deleted in Phase 1)
- rstest config: `include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts']`, `passWithNoTests: true`
- `debug.ts` uses `Buffer.isBuffer()` and `Buffer.from()` — Node.js built-in, available in rstest Node environment

## Deferred Ideas

None captured during this discussion.
