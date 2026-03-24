# Phase 4: Documentation - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Add JSDoc to the public API (`createSQLiteClient`, `CreateSQLiteClientOptions`, `SQLiteDB` methods, `WorkerOrchestrator`/worker state machine), and write a consumer-facing `README.md`. No new features, no API changes — documentation only.
</domain>

<decisions>
## Implementation Decisions

### JSDoc method coverage
- **D-01:** JSDoc covers ALL methods exported on the `SQLiteDB` object: `read`, `write`, `stream`, `one`, `close`, `transaction`, `bulkWrite`, `output`. Not just the 5 listed in DOC-02 — all 8.
- **D-02:** `createSQLiteClient` JSDoc must include `@param`, `@returns`, COOP/COEP browser requirements, worker pool side-effect note, `@throws` (AccessHandlePoolVFS + poolSize > 1), and `@example`.
- **D-03:** `CreateSQLiteClientOptions` fields each get a JSDoc comment: type, default value, and consequence of omission.

### JSDoc enrichment strategy
- **D-04:** Enrich existing stubs in-place — surgical edits adding `@param`, `@returns`, `@throws`, `@example` where missing. Do not delete existing comments; extend them.
- **D-05:** `orchestrator.ts` already has solid inline comments — audit and complete rather than rewrite. Worker state machine (EMPTY → NEW → INITIALIZING → INITIALIZED → READY → RUNNING → ABORTING/DONE) must be explicitly documented.

### README structure
- **D-06:** README leads with COOP/COEP requirements (SharedArrayBuffer prerequisites) before anything else.
- **D-07:** VFS section: explain each available VFS with name + storage type + constraint + when to use. Clearly call out the default (`OPFSPermutedVFS`). End with a link to wa-sqlite's VFS comparison page for deeper detail: https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison
- **D-08:** README includes at minimum: install, COOP/COEP server config, VFS selection, basic usage examples (`read`, `write`, `stream`, `one`), known limitations.
- **D-09:** README does NOT document `transaction`, `bulkWrite`, `output` in detail — those are secondary/advanced. A brief mention is fine; deep examples are out of scope for v1 README.

### Claude's Discretion
- Exact wording and prose style in JSDoc
- Whether to use `@remarks` vs inline text for implementation notes
- Order of `@param` tags
- README example code: actual SQL content (table names, column names)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Documentation — DOC-01 through DOC-05 acceptance criteria
- `.planning/ROADMAP.md` §Phase 4 — Success criteria (5 items)

### Source files to document
- `src/client.ts` — `createSQLiteClient`, `CreateSQLiteClientOptions`, `SQLiteDB` type + all 8 methods
- `src/orchestrator.ts` — `WorkerOrchestrator` class, `WorkerStatuses` enum
- `src/worker.ts` — worker lifecycle state machine
- `src/types.ts` — `SQLiteVFS` type, `ClientMessageData`, `WorkerMessageData`

### VFS reference
- https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison — upstream VFS comparison (link to include in README)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `client.ts` lines 11-19: Existing class-level JSDoc comment block (thin — extend it)
- `client.ts` lines 98-103: Existing `createSQLiteClient` JSDoc stub — needs `@param`, `@throws`, `@example`, COOP/COEP note
- `orchestrator.ts`: Already has method-level JSDoc on `lock()`, `unlock()`, `setStatus()`, `getStatus()`, and class-level description — mostly complete, minor gaps

### Established Patterns
- JSDoc style: `/** ... */` multi-line blocks already used throughout — maintain this style
- `WorkerStatuses` enum already has inline comments for each status value (`// Worker slot not yet created`, etc.) — state machine values are already annotated
- No `@module` or namespace-level JSDoc currently used

### Integration Points
- `src/index.ts` re-exports from `client.ts` — JSDoc on `client.ts` symbols will be the consumer-facing docs
- `CreateSQLiteClientOptions` is defined inside `client.ts` as an exported type — add field-level JSDoc there
- `SQLiteDB` type is defined in `client.ts` — method signatures already typed, add JSDoc above each property

### Methods on SQLiteDB requiring JSDoc (D-01 coverage)
| Method | Key doc points |
|--------|---------------|
| `read` | SELECT only, acquires any available reader, returns all rows |
| `write` | DML/DDL, acquires dedicated writer worker, returns `{result, affected}` |
| `stream` | AsyncGenerator, yields chunks, memory-efficient for large sets, chunkSize option |
| `one` | Returns first row or `undefined`, auto-aborts after first chunk |
| `transaction` | Acquires worker for lifetime of callback, commit/rollback semantics, autoCommit default |
| `bulkWrite` | Batches inserts within SQLITE_MAX_VARS (32766) limit, enqueue/close pattern |
| `output` | DROP + CREATE + bulkWrite + indexes, schema-driven table creation |
| `close` | Terminates all workers, no cleanup of OPFS files |

### VFS types available (SQLiteVFS)
- `OPFSPermutedVFS` (default) — OPFS, supports poolSize ≥ 1
- `OPFSAdaptiveVFS` — OPFS adaptive
- `OPFSCoopSyncVFS` — OPFS cooperative sync
- `AccessHandlePoolVFS` — OPFS, poolSize MUST be 1 (throws otherwise)
- `IDBBatchAtomicVFS` — IndexedDB, OPFS fallback option
- No VFS / `undefined` → defaults to `OPFSPermutedVFS`
</code_context>

<specifics>
## Specific Ideas

- VFS section in README: list each VFS with storage type and constraints + link to https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison — user explicitly wants this link included
- README audience: library consumer integrating wsqlite from scratch — assume TypeScript + bundler (Rsbuild/webpack/Vite), assume they need COOP/COEP config help
- `AccessHandlePoolVFS` constraint (poolSize must be 1) must appear in both JSDoc `@throws` and README VFS table
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.
</deferred>

---
*Phase: 04-documentation*
*Context gathered: 2026-03-24*
