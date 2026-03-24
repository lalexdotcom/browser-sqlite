# Roadmap: wsqlite

**Milestone:** v1 — Quality Baseline
**Goal:** Restore correctness, verify behavior with a two-layer test suite, and document the public API for consumers.

## Phases

- [ ] **Phase 1: Bug Fixes & Type Safety** — Eliminate known bugs and restore full TypeScript type safety
- [ ] **Phase 2: Unit Tests** — Cover all pure and Node-testable logic with fast, browser-free tests
- [ ] **Phase 3: Integration Tests** — Validate the complete worker-pool pipeline in a real browser
- [ ] **Phase 4: Documentation** — Document the public API and ship a consumer-facing README

---

## Phase Details

### Phase 1: Bug Fixes & Type Safety

**Goal:** The library behaves correctly and the TypeScript compiler reports zero errors without suppressions
**Depends on:** —
**Requirements:** BUG-01, BUG-02, BUG-03, BUG-04, BUG-05, TYPE-01, TYPE-02

**Success Criteria** (what must be TRUE):
1. Pragmas passed to `createSQLiteClient` are applied to the database on open (inverted condition fixed)
2. `CreateSQLiteClientOptions` is the canonical spelling across all public exports — the double-L variant is gone
3. Callers of `createSQLiteClient` see the full `SQLiteDB` method surface (no hidden methods from the `satisfies` cast)
4. `npm install` (or equivalent) resolves `@lalex/promises` without error
5. Logger verbosity is controlled by a consumer option, not hardcoded constants
6. `src/wa-sqlite.d.ts` provides ambient types for the entire wa-sqlite surface used in `worker.ts` — zero `@ts-expect-error` directives remain
7. No commented-out debug code or orphaned `console.log` lambdas remain in `client.ts` or `worker.ts`

**Plans:** 4 plans

Plans:
- [x] 01-01-PLAN.md — Foundation: add @lalex/promises to package.json and logLevel to ClientMessageData open type
- [x] 01-02-PLAN.md — Fix client.ts: rename CreateSQLiteClientOptions, widen SQLiteDB, apply logLevel, remove satisfies cast and commented debug blocks
- [x] 01-03-PLAN.md — Fix worker.ts: fix inverted allQueryPragmas condition, apply logLevel from open message, remove dead log lambda
- [x] 01-04-PLAN.md — Author src/wa-sqlite.d.ts ambient declarations and remove all @ts-expect-error directives from worker.ts

---

### Phase 2: Unit Tests

**Goal:** Every pure function and the `WorkerOrchestrator` state machine are covered by fast, Node-mode tests
**Depends on:** Phase 1
**Requirements:** TEST-01, TEST-02, TEST-03, TEST-04, TEST-05

**Success Criteria** (what must be TRUE):
1. The placeholder `squared()` test is gone — running `rstest` executes real library tests
2. `isWriteQuery` is tested for standard DML, DDL, edge cases (PRAGMA, WITH...INSERT, ATTACH, lowercase variants)
3. `sqlParams` deduplication behavior is tested for positional and named parameter variants
4. `debugSQLQuery` interpolation is tested including NULL, date, and embedded `?` in string literals
5. `WorkerOrchestrator` lock/unlock, `setStatus`/`getStatus`, CAS transitions, and SAB sharing are covered without a browser

**Plans:** 1/3 plans executed

Plans:
- [ ] 02-01-PLAN.md — Extend isWriteQuery regex (D3: add PRAGMA/ATTACH/DETACH) and write tests/unit/utils.test.ts (isWriteQuery, sqlParams)
- [ ] 02-02-PLAN.md — Write tests/unit/debug.test.ts (debugSQLQuery interpolation, all value types)
- [x] 02-03-PLAN.md — Write tests/unit/orchestrator.test.ts (WorkerOrchestrator lock/unlock, setStatus/getStatus, CAS, SAB sharing)

---

### Phase 3: Integration Tests (Browser)

**Goal:** The full client-to-worker-to-WASM pipeline is verified in a real Chromium browser with COOP/COEP headers
**Depends on:** Phase 2
**Requirements:** INT-01, INT-02, INT-03, INT-04, INT-05, INT-06, INT-07, INT-08, INT-09, INT-10

**Success Criteria** (what must be TRUE):
1. A dedicated browser-mode Rstest config runs tests in headless Chromium with COOP/COEP headers served automatically
2. `createSQLiteClient` initializes successfully and pool workers reach READY state
3. `db.read()`, `db.write()`, `db.stream()`, and `db.one()` all return correct results against a real SQLite database
4. Concurrent reads are dispatched to different workers; writes are serialized through one writer
5. An aborted query via `AbortSignal` does not deliver further results and the worker returns to READY
6. A SQL error (syntax error, missing table) rejects the promise with a descriptive error message

**Plans:**
1. **Browser test infrastructure** — Install Playwright (Chromium), create `rstest.browser.config.ts` with COOP/COEP header plugin, create `tests/browser/` directory with IDB/OPFS cleanup helpers
2. **Core query tests** — Write browser tests for `createSQLiteClient` init, `db.read()`, `db.write()`, `db.stream()` chunking, and `db.one()` (INT-02 through INT-06)
3. **Concurrency and error tests** — Write browser tests for parallel reads, serialized writes, `AbortSignal` cancellation, and SQL error handling (INT-07 through INT-10)

---

### Phase 4: Documentation

**Goal:** Every public API is self-describing via JSDoc and a README gives consumers everything they need to integrate wsqlite
**Depends on:** Phase 3
**Requirements:** DOC-01, DOC-02, DOC-03, DOC-04, DOC-05

**Success Criteria** (what must be TRUE):
1. `createSQLiteClient` has JSDoc covering parameters, worker-pool side effects, COOP/COEP browser requirements, `@throws`, and a working `@example`
2. All `SQLiteDB` methods (`read`, `write`, `stream`, `one`, `close`) have JSDoc describing concurrency semantics, streaming memory implications, and AbortSignal behavior
3. Every field of `CreateSQLiteClientOptions` has a JSDoc comment stating its type, default, and consequence of omission
4. `WorkerOrchestrator` and the worker lifecycle state machine have inline comments sufficient for a new contributor to understand the coordination logic
5. `README.md` leads with COOP/COEP requirements, then covers install, VFS selection, usage examples, and known limitations — sufficient for a consumer to integrate wsqlite from scratch

**Plans:**
1. **JSDoc: public API** — Add JSDoc to `createSQLiteClient`, `CreateSQLiteClientOptions` fields, and the `SQLiteDB` interface methods in `client.ts` and `types.ts`
2. **Inline comments: internals** — Add inline comments to `WorkerOrchestrator` and the worker lifecycle state machine in `orchestrator.ts` and `worker.ts`
3. **README.md** — Write consumer-facing `README.md`: COOP/COEP header setup first, then install, VFS guide (memory / IDB / OPFS / JSPI), usage examples, and limitations

### Phase 5: Avant la reaction de la documentation, rendre le package @lalex/console optionnel: s'il n'est pas présent, on utilise les methodes de `console`

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 4
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd:plan-phase 5 to break down)

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Bug Fixes & Type Safety | 0/4 | Not started | - |
| 2. Unit Tests | 1/3 | In Progress|  |
| 3. Integration Tests | 0/3 | Not started | - |
| 4. Documentation | 0/3 | Not started | - |
