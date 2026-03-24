# Milestones

## v1.0 Initial Release (Shipped: 2026-03-24)

**Phases completed:** 5 phases, 17 plans, 25 tasks

**Key accomplishments:**

- @lalex/promises added to package.json and logLevel optional field added to ClientMessageData open variant, establishing the shared foundation for Wave 2 plans
- Renamed CreateSQLLiteClientOptions typo, widened SQLiteDB with transaction/bulkWrite/output/close/debug methods, added logLevel option replacing debug boolean, removed satisfies cast and all commented LL.wth lines
- Fixed inverted pragma condition (BUG-01), consumer-driven log level via open message logLevel field (BUG-05), and removed dead commented-out log lambda (TYPE-02) from src/worker.ts
- Authored `src/wa-sqlite.d.ts` with 10 ambient module declarations covering all wa-sqlite imports in worker.ts, removing all 10 `@ts-expect-error` suppressors and restoring full TypeScript type safety.
- isWriteQuery extended with PRAGMA|ATTACH|DETACH routing regex and 23 unit tests covering all DML/DDL/PRAGMA/CTE cases plus sqlParams deduplication
- 17-case Rstest suite for debugSQLQuery covering positional ?NNN, bare ?, all value types (string/number/boolean/null/undefined/Date/Buffer/Uint8Array), single-quote escaping, and string literal skipping
- 17 Rstest unit tests covering WorkerOrchestrator: lock/unlock (Node-safe non-blocking), setStatus unconditional exchange, CAS semantics, getStatus independence, and SAB cross-instance visibility
- Rstest browser mode with Playwright Chromium headless, COOP/COEP headers for SharedArrayBuffer, and createTestClient() helper with UUID-based OPFS isolation
- 5 browser integration test suites covering concurrent reads, serialized writes, AbortSignal stream cancellation, SQL error rejection, and lock() blocking behavior (INT-07 to INT-10, D-09)
- Complete JSDoc on all public API symbols in src/client.ts — COOP/COEP requirements, @throws, 8-method concurrency semantics, and per-field defaults wired for IDE hover tooltips
- Worker state machine (EMPTY→DONE) documented via @remarks in WorkerOrchestrator and inline comments at all 4 transition sites in worker.ts
- Complete consumer-facing README.md with COOP/COEP server configs, 5-VFS selection table, TypeScript usage examples, and known limitations replacing Rslib scaffold boilerplate
- Failing unit test stubs for shouldLog (8 tests) and makeConsoleShim (9 tests) confirm RED phase before Wave 1 creates src/logger.ts
- Optional @lalex/console with native console shim fallback — LogLevel type, WorkerMessageData log variant, src/logger.ts with shouldLog/makeConsoleShim/LL, and @lalex/console moved to optionalDependencies
- client.ts @lalex/console static import replaced with LL from logger.ts; worker log messages dispatched through unified LL with scope prefix — completing the optional @lalex/console architecture

---
