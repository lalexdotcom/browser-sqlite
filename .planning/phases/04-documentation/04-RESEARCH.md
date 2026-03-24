# Phase 4: Documentation - Research

**Researched:** 2026-03-24
**Domain:** TypeScript JSDoc authoring + consumer-facing README writing
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** JSDoc covers ALL methods exported on the `SQLiteDB` object: `read`, `write`, `stream`, `one`, `close`, `transaction`, `bulkWrite`, `output`. Not just the 5 listed in DOC-02 — all 8.
- **D-02:** `createSQLiteClient` JSDoc must include `@param`, `@returns`, COOP/COEP browser requirements, worker pool side-effect note, `@throws` (AccessHandlePoolVFS + poolSize > 1), and `@example`.
- **D-03:** `CreateSQLiteClientOptions` fields each get a JSDoc comment: type, default value, and consequence of omission.
- **D-04:** Enrich existing stubs in-place — surgical edits adding `@param`, `@returns`, `@throws`, `@example` where missing. Do not delete existing comments; extend them.
- **D-05:** `orchestrator.ts` already has solid inline comments — audit and complete rather than rewrite. Worker state machine (EMPTY → NEW → INITIALIZING → INITIALIZED → READY → RUNNING → ABORTING/DONE) must be explicitly documented.
- **D-06:** README leads with COOP/COEP requirements (SharedArrayBuffer prerequisites) before anything else.
- **D-07:** VFS section: explain each available VFS with name + storage type + constraint + when to use. Clearly call out the default (`OPFSPermutedVFS`). End with a link to wa-sqlite's VFS comparison page: https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison
- **D-08:** README includes at minimum: install, COOP/COEP server config, VFS selection, basic usage examples (`read`, `write`, `stream`, `one`), known limitations.
- **D-09:** README does NOT document `transaction`, `bulkWrite`, `output` in detail — brief mention only.

### Claude's Discretion

- Exact wording and prose style in JSDoc
- Whether to use `@remarks` vs inline text for implementation notes
- Order of `@param` tags
- README example code: actual SQL content (table names, column names)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DOC-01 | JSDoc on `createSQLiteClient` — parameters, side effects (worker pool spawn), browser requirements (COOP/COEP), `@throws`, `@example` | D-02 locked; stub at `client.ts` lines 97-103 needs `@param`, `@throws`, `@example`, COOP/COEP note |
| DOC-02 | JSDoc on `SQLiteDB` interface methods — `read`, `write`, `stream`, `one`, `close` — concurrency semantics, streaming memory implications, AbortSignal behavior | D-01 expands to all 8 methods; `SQLiteDB` type at `client.ts` lines 54-93; each property needs a JSDoc block above it |
| DOC-03 | JSDoc on `CreateSQLiteClientOptions` — each field, its default, what happens if omitted | Type at `client.ts` lines 26-32; 5 fields: `name`, `poolSize`, `vfs`, `pragmas`, `logLevel` |
| DOC-04 | Inline comments on `WorkerOrchestrator` and worker lifecycle state machine | `orchestrator.ts` is mostly documented; state machine transitions need explicit narrative; `worker.ts` open/query lifecycle needs inline commentary |
| DOC-05 | `README.md` for library consumers — browser requirements (COOP/COEP) first, then install, VFS selection guide, usage examples, limitations | Current README.md is an Rslib scaffold placeholder — must be completely rewritten |
</phase_requirements>

---

## Summary

Phase 4 is a pure documentation phase: no new code, no new dependencies, no architectural changes. The deliverables are JSDoc enrichment on four source files (`client.ts`, `orchestrator.ts`, `worker.ts`, `types.ts`) and a complete rewrite of `README.md` from its current Rslib scaffold stub.

The JSDoc work is surgical: existing comment blocks are in place but thin. The pattern in the codebase is `/** ... */` multi-line JSDoc. `orchestrator.ts` is the most complete; `client.ts` is the most work — it has a stub on `createSQLiteClient`, a one-liner on `CreateSQLiteClientOptions`, a one-liner on `SQLiteDB`, and thin or absent docs on the 8 method properties. `worker.ts` has no JSDoc at all at the module/function level. `types.ts` has no doc comments.

The README must be authored from scratch. The current file is three lines of Rslib boilerplate (`# Rslib project / ## Setup / pnpm install`). The audience is a TypeScript developer integrating wsqlite in a browser app with a bundler. The document must open with COOP/COEP requirements because without `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, `SharedArrayBuffer` is unavailable and the library cannot function.

**Primary recommendation:** Work left-to-right through the locked decisions. Three parallel edit streams are possible: (1) `client.ts` JSDoc, (2) `orchestrator.ts` + `worker.ts` JSDoc, (3) `README.md`. All are independent files with no merge conflicts.

---

## Standard Stack

No new libraries are introduced in this phase. Documentation is written directly in TypeScript source using the JSDoc comment syntax already present in the codebase.

### JSDoc Tag Vocabulary (TypeScript-compatible)

| Tag | Purpose | Example |
|-----|---------|---------|
| `@param name` | Document a parameter | `@param file - Database file path` |
| `@param name.field` | Document an options-bag field | `@param options.poolSize - Number of workers` |
| `@returns` | Document return value | `@returns Promise resolving to typed row array` |
| `@throws {Error}` | Document thrown errors | `@throws {Error} When AccessHandlePoolVFS is used with poolSize > 1` |
| `@example` | Inline usage example | fenced code block after the tag |
| `@remarks` | Extended implementation notes | Rendered separately by TypeDoc/IDEs |
| `@defaultValue` | Document default for optional params | `@defaultValue 'OPFSPermutedVFS'` |

All tags above are supported by TypeScript's language server and render correctly in VS Code IntelliSense without any additional tooling.

**Confidence:** HIGH — standard TypeScript JSDoc behavior, no external tooling dependency.

---

## Architecture Patterns

### Existing JSDoc Style in Codebase

The codebase already uses `/** ... */` multi-line blocks. The established pattern:

```typescript
/**
 * Short one-line description.
 *
 * Extended description paragraph (optional).
 *
 * @param paramName - Description
 * @returns Description
 * @throws {Error} When condition
 * @example
 * ```typescript
 * const result = someFunction(arg);
 * ```
 */
```

Maintain this style. Do not introduce single-line `/** */` for multi-param items.

### JSDoc Placement for Type Properties (SQLiteDB, CreateSQLiteClientOptions)

TypeScript types expressed as `type Foo = { field: T }` accept JSDoc above each property:

```typescript
export type CreateSQLiteClientOptions = {
  /** Database file name within the OPFS origin. Defaults to `"default"` if omitted. */
  name?: string;

  /**
   * Number of Web Workers in the pool.
   * @defaultValue 2
   * Must be `1` when using `AccessHandlePoolVFS`.
   */
  poolSize?: number;
};
```

This renders in IDE hover and TypeDoc output. Verified pattern — TypeScript language server fully supports property-level JSDoc in type aliases.

### Anti-Patterns to Avoid

- **Duplicating the type in prose:** If the type is `string`, don't write `@param {string} name`. TypeScript already knows the type — JSDoc only adds semantics, defaults, and consequences.
- **Redundant `@type` tags:** TypeScript infers these; adding `@type` is noise.
- **Vague descriptions:** "The pool size" adds nothing over the parameter name. Use: "Number of Web Workers spawned at initialization. A larger pool allows more concurrent reads but increases memory and OPFS handle usage."
- **Breaking existing comments on `orchestrator.ts`:** D-05 is explicit — audit and complete, do not rewrite. The existing method-level JSDoc on `lock()`, `unlock()`, `setStatus()`, `getStatus()` is already complete. Only the state machine narrative and any missing transitions need to be added.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSDoc rendering | Custom doc generator | IDE hover + TypeDoc (zero config) | TypeScript language server already renders `/** */` blocks; no build step needed for this phase |
| README formatting | Custom template engine | Markdown + GFM tables | GitHub/npm/JSR all render standard GFM |
| VFS comparison prose | Authoring from scratch | wa-sqlite upstream docs + code inspection done in Phase 1-3 | All VFS behavior is already understood from integration tests |

---

## Current State Audit (per source file)

### `src/client.ts`

**`createSQLiteClient` (lines 97-103):** Has a 3-line stub. Missing: `@param file` description, `@param clientOptions` (and its sub-fields), `@returns` description of the `SQLiteDB` API shape, COOP/COEP `@remarks`/note, `@throws` for AccessHandlePoolVFS+poolSize>1, `@example` block.

**`CreateSQLiteClientOptions` (lines 24-32):** Has one-liner `/** Configuration options for creating a SQLite client. */`. Individual fields (`name`, `poolSize`, `vfs`, `pragmas`, `logLevel`) have no per-field JSDoc.

**`SQLiteDB` (lines 52-93):** Has one-liner `/** Main SQLite database API. */`. None of the 8 method properties (`read`, `write`, `stream`, `one`, `transaction`, `bulkWrite`, `output`, `close`) have JSDoc. The `debug` field also has no doc.

**Internal implementation functions** (`createWorker`, `acquireWorker`, etc.): Already have brief JSDoc — these are internal and not the focus of this phase.

### `src/orchestrator.ts`

**`WorkerOrchestrator` class:** Has solid class-level JSDoc and method-level JSDoc on `constructor`, `lock`, `unlock`, `setStatus`, `getStatus`. `WorkerStatuses` enum already has inline comments on each value.

**Gap:** The state machine transition sequence (EMPTY → NEW → INITIALIZING → INITIALIZED → READY → RUNNING → ABORTING/DONE) is not documented as a narrative sequence anywhere. Needs a `@remarks` or inline block comment describing the full lifecycle.

### `src/worker.ts`

**Module-level:** No JSDoc. The `open()` function is a critical lifecycle function — needs documentation explaining: it is called once per worker thread, acquires the `orchestrator.lock()` to serialize DB initialization across the pool, posts `{ type: 'ready' }` when READY, and replaces `self.onmessage` with the query handler after open completes.

**State transitions in `worker.ts`:**
- Line 143: `setStatus(index, WorkerStatuses.READY)` — worker becomes queryable
- Line 207: `setStatus(index, WorkerStatuses.RUNNING)` — query started
- Line 172/175: `getStatus === ABORTING` — abort check inside query loop
- Line 244: `setStatus(index, WorkerStatuses.DONE)` — query finished

These transitions need inline comments tying them to the state machine documented in `orchestrator.ts`.

### `src/types.ts`

Contains `ClientMessageData`, `WorkerMessageData`, `SQLiteVFS` union — these are internal message protocol types. Per D-04 scope, they do not need consumer-facing JSDoc (they are not exported from `index.ts`). However, a brief module-level comment explaining the message protocol would aid contributors (DOC-04).

### `README.md`

Current content: 3 lines of Rslib scaffold boilerplate. Must be completely replaced. Consumer audience, not contributor audience.

---

## Common Pitfalls

### Pitfall 1: COOP/COEP omission causes invisible runtime failure

**What goes wrong:** Consumer deploys the library without COOP/COEP headers. `new SharedArrayBuffer()` throws a `SecurityError` silently — the worker pool never initializes, all queries hang forever.
**Why it happens:** Browser security policy since 2021 requires cross-origin isolation for `SharedArrayBuffer`. Many developers are unaware because Node.js and many test environments do not enforce it.
**How to avoid:** README section 1 must be COOP/COEP with concrete server config examples (Nginx, Express, Vite/Rsbuild dev server config).
**Warning signs:** `SecurityError: Failed to construct 'SharedArrayBuffer'` in browser console.

### Pitfall 2: AccessHandlePoolVFS with poolSize > 1 silently accepts the option then throws at runtime

**What goes wrong:** Consumer sets `vfs: 'AccessHandlePoolVFS'` without reading constraints and leaves default `poolSize: 2`. The error is thrown synchronously inside `createSQLiteClient`, which is synchronous — but the pool init is async, so the error surfaces inconsistently.
**Why it happens:** `createSQLiteClient` throws synchronously at line 122-126 if the constraint is violated, but consumers expect async errors.
**How to avoid:** JSDoc `@throws` on `createSQLiteClient` must call this out explicitly. README VFS table must list "poolSize must be 1" as a constraint for `AccessHandlePoolVFS`.

### Pitfall 3: `stream()` worker is held for the full generator lifetime

**What goes wrong:** Consumer calls `db.stream()` but never exhausts the generator. The worker is acquired at the start and not released until the generator is fully consumed or the caller breaks out of the loop. Unreleased workers starve other operations.
**Why it happens:** The worker is acquired in the `stream` function before the generator starts and released in `finally` after it ends — standard async generator lifecycle.
**How to avoid:** JSDoc on `stream` must note: "The worker is held for the full lifetime of the generator. Always exhaust the generator or `break` to trigger cleanup."

### Pitfall 4: `close()` does not clean up OPFS files

**What goes wrong:** Consumer calls `db.close()` expecting it to delete the database file. OPFS files persist across page loads.
**Why it happens:** `close()` only terminates worker threads (`worker.terminate()`). OPFS file management is out of scope.
**How to avoid:** JSDoc on `close` and README known limitations must state this explicitly.

### Pitfall 5: `one()` with a write query is a footgun

**What goes wrong:** Consumer uses `db.one('INSERT INTO ...')` expecting the row-returning overload. `one()` acquires a worker via `isWriteQuery()` routing (write worker), executes, returns first row or `undefined` — but the INSERT may still execute even if `undefined` is returned.
**Why it happens:** `one()` routes to write worker for write queries. The abort after first chunk still completes the INSERT.
**How to avoid:** JSDoc on `one` should note: intended for SELECT queries only; for DML use `write()`.

---

## Code Examples

Verified patterns derived from reading `client.ts` and `worker.ts` directly:

### `createSQLiteClient` with full options

```typescript
// Source: src/client.ts lines 104-127
import { createSQLiteClient } from 'wsqlite';

const db = createSQLiteClient('myapp.sqlite', {
  poolSize: 3,
  vfs: 'OPFSPermutedVFS', // default — OPFS, supports poolSize >= 1
  pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL' },
  logLevel: 'warn',
});
```

### `createSQLiteClient` with AccessHandlePoolVFS (poolSize constraint)

```typescript
// Source: src/client.ts lines 122-126
// AccessHandlePoolVFS requires poolSize: 1 — throws otherwise
const db = createSQLiteClient('myapp.sqlite', {
  vfs: 'AccessHandlePoolVFS',
  poolSize: 1, // required — omitting this with AccessHandlePoolVFS throws
});
```

### `read` — typed SELECT

```typescript
type User = { id: number; name: string };
const users = await db.read<User>('SELECT id, name FROM users WHERE active = ?', [1]);
// returns User[]
```

### `write` — INSERT/UPDATE/DELETE

```typescript
const { affected } = await db.write(
  'INSERT INTO users (name) VALUES (?)',
  ['Alice']
);
// affected: number of rows changed
```

### `stream` — memory-efficient large result sets

```typescript
// Worker held for full generator lifetime — always exhaust or break
for await (const chunk of db.stream<User>('SELECT * FROM large_table', [], { chunkSize: 100 })) {
  process(chunk); // chunk is User[]
}
```

### `one` — first row or undefined

```typescript
const user = await db.one<User>('SELECT * FROM users WHERE id = ?', [42]);
// user: User | undefined — auto-aborts after first chunk
```

### COOP/COEP server configuration examples (for README)

```nginx
# Nginx
add_header Cross-Origin-Opener-Policy "same-origin";
add_header Cross-Origin-Embedder-Policy "require-corp";
```

```javascript
// Express
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

```typescript
// Rsbuild / Vite dev server
// rslib.config.ts or rsbuild.config.ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  }
}
```

### Worker state machine — narrative for `orchestrator.ts` `@remarks`

```
State machine (per worker slot):

  EMPTY (-3)         — slot allocated but Worker object not yet created
     │
  NEW (-2)           — Worker thread started, 'open' message not yet sent
     │
  INITIALIZING (-1)  — 'open' message sent; worker acquiring orchestrator.lock()
     │                  to serialize VFS + DB initialization across the pool
  INITIALIZED (0)    — DB opened; orchestrator.unlock() called; transitioning to READY
     │
  READY (10)         — worker available for queries; pool is queryable
     │
  RUNNING (50)       — worker executing a query (set by worker thread via Atomics)
     │
  ABORTING (99)      — AbortSignal fired; worker.ts checks this flag in query loop
     │                  and exits early; transitions to DONE after current step
  DONE (100)         — query finished (normal or aborted); client calls releaseWorker()
                        which sets status back to READY

Note: RESERVED (49) is defined but intentionally unused in v1.
```

---

## README Structure Plan

The README must be authored as a library consumer document. Recommended structure:

```
1. [No badge clutter] — One-line description: "Browser SQLite with concurrent read / serial write isolation."
2. ## Requirements (COOP/COEP — FIRST section)
   - What SharedArrayBuffer requires
   - Server config examples (Nginx / Express / Rsbuild)
3. ## Install
   - npm/pnpm install command
   - bundler note (Rsbuild/webpack/Vite with Worker support)
4. ## VFS Selection
   - Table: VFS name | Storage | Constraint | When to use
   - Default callout: OPFSPermutedVFS
   - Link to wa-sqlite VFS comparison
5. ## Usage
   - createSQLiteClient (with options table)
   - read / write / stream / one examples
   - Brief mention of transaction / bulkWrite / output (advanced, no deep examples)
6. ## Known Limitations
   - OPFS files not cleaned up by close()
   - Browser-only (no Node.js)
   - AccessHandlePoolVFS poolSize constraint
   - SharedArrayBuffer requires cross-origin isolation
```

---

## VFS Reference Table (for README)

Derived from `src/worker.ts` `VFSConfigs` and `src/types.ts` `SQLiteVFS` union:

| VFS | Storage | Constraint | When to use |
|-----|---------|-----------|-------------|
| `OPFSPermutedVFS` **(default)** | OPFS (Origin Private File System) | None — supports `poolSize >= 1` | General purpose. Best choice for most applications. |
| `OPFSAdaptiveVFS` | OPFS | Requires JSPI (JavaScript Promise Integration) — Chromium 123+ | When JSPI is available and you want adaptive sync strategy |
| `OPFSCoopSyncVFS` | OPFS | Uses cooperative sync (no JSPI needed) | Broader browser compat fallback when JSPI unavailable |
| `AccessHandlePoolVFS` | OPFS | **`poolSize` MUST be `1`** — throws otherwise | Single-connection scenarios needing access handle pool semantics |
| `IDBBatchAtomicVFS` | IndexedDB | None — does not require OPFS support | OPFS unavailable (older browsers, some mobile) |

---

## Environment Availability

Step 2.6: SKIPPED — Phase 4 is pure documentation (JSDoc edits + README rewrite). No external tools, runtimes, databases, or CLI utilities are introduced. All work is TypeScript source file edits.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rstest 0.9.x (Node mode for unit, browser mode for integration) |
| Config file | `rstest.config.ts` (unit), `rstest.browser.config.ts` (browser) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test && pnpm test:browser` |

### Phase Requirements → Test Map

Documentation phases have no automated test coverage — correctness is verified by human review. The following are **manual verification items**, not automated tests:

| Req ID | Behavior | Test Type | Verification Method |
|--------|----------|-----------|---------------------|
| DOC-01 | `createSQLiteClient` has JSDoc with all required tags | manual | Hover in VS Code; review source diff |
| DOC-02 | All 8 `SQLiteDB` methods have JSDoc | manual | Hover in VS Code; grep for `@param` on each method |
| DOC-03 | Each `CreateSQLiteClientOptions` field has JSDoc | manual | Hover in VS Code on each field |
| DOC-04 | `WorkerOrchestrator` + worker lifecycle state machine documented | manual | Source review; state machine sequence visible in comments |
| DOC-05 | README covers all required sections | manual | Read README.md; verify section checklist |

### Sampling Rate

- **Per task commit:** No automated test required (docs-only changes don't break tests)
- **Per wave merge:** `pnpm test` (ensure no regressions from accidental source edits)
- **Phase gate:** Full test suite green + human review of JSDoc hover output

### Wave 0 Gaps

None — existing test infrastructure covers all phase requirements. Documentation changes do not require new test files. The planner should add a "type-check" step (`pnpm exec tsc --noEmit`) to each wave to catch any accidental breakage from JSDoc edits.

---

## Open Questions

1. **`debug` field on `SQLiteDB`**
   - What we know: `debug` is typed as `unknown` and is the `state` property from a destructured `ReturnType<typeof createClientDebug>` that resolves to an empty object `{}` (line 133 of `client.ts`). It is included in the returned API object.
   - What's unclear: Is `debug` intentionally public? It appears to be an internal diagnostic surface. Should it have JSDoc or be noted as "internal, subject to change"?
   - Recommendation: Add a brief JSDoc noting it as an internal diagnostic handle, not part of the stable public API. `@internal` tag is recognized by TypeDoc and IDEs.

2. **`VFSConfigs.OPFSAdaptiveVFS` uses JSPI module — browser compat note**
   - What we know: `OPFSAdaptiveVFS` loads `wa-sqlite-jspi.mjs` which requires JavaScript Promise Integration (JSPI). As of 2025, JSPI is available in Chromium 123+ behind an origin trial / flag, and Chrome 126+ without flags.
   - What's unclear: Current JSPI availability across Firefox/Safari for the README.
   - Recommendation: Note in VFS table that `OPFSAdaptiveVFS` requires modern Chromium (126+). Do not block the phase on this — a best-effort note is sufficient.

---

## Sources

### Primary (HIGH confidence)

- `src/client.ts` — direct source inspection; all JSDoc gaps catalogued line by line
- `src/orchestrator.ts` — direct source inspection; state machine values read from `WorkerStatuses` enum
- `src/worker.ts` — direct source inspection; state transitions identified at lines 143, 207, 172, 175, 244
- `src/types.ts` — direct source inspection; message protocol types
- `.planning/phases/04-documentation/04-CONTEXT.md` — locked decisions D-01 through D-09

### Secondary (MEDIUM confidence)

- TypeScript JSDoc reference (tag vocabulary) — standard TypeScript behavior, HIGH confidence from training + confirmed by language server behavior in project

### Tertiary (LOW confidence)

- JSPI browser availability for `OPFSAdaptiveVFS` — flagged as Open Question #2; planner should note this as a best-effort README annotation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — documentation-only phase, no new libraries
- Architecture: HIGH — JSDoc patterns read directly from existing source; no speculation
- Pitfalls: HIGH — derived from direct code reading (AccessHandlePoolVFS constraint at client.ts:122, close() at client.ts:814, stream hold at client.ts:474-485)
- README structure: HIGH — all content derived from locked decisions D-06 through D-09

**Research date:** 2026-03-24
**Valid until:** Indefinite — source files are stable after Phase 3 completion; no upstream dependency changes anticipated
