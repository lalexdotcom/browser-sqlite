# Phase 3: Integration Tests (Browser) - Context

**Gathered:** 2026-03-24 (discuss mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Verify the full `createSQLiteClient` → worker pool → WASM pipeline in a real Chromium browser.
All 10 requirements (INT-01 through INT-10) must pass: initialization, read/write/stream/one
queries, concurrent reads, serialized writes, AbortSignal cancellation, and SQL error handling.

New capabilities (transaction API, VFS benchmarking, Node.js support) are out of scope.
</domain>

<decisions>
## Implementation Decisions

### Browser Test Infrastructure

- **D-01:** Use **Rstest browser mode** (`@rstest/browser`) — not a standalone Playwright setup.
  Rstest browser mode handles headless Chromium installation automatically. No separate
  `playwright install` step required.
- **D-02:** Separate config file: `rstest.browser.config.ts` (distinct from the Node-mode
  `rstest.config.ts`). Browser tests run via a separate script (e.g., `pnpm test:browser`).
- **D-03:** Browser tests live in `tests/browser/` directory.

### COOP/COEP Headers

- **D-04:** Inject `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` via **Rsbuild `server.headers` config** inside
  `rstest.browser.config.ts`. No custom plugin needed — Rstest's dev server inherits Rsbuild's
  server options via `withRslibConfig()`.

### VFS for Test Database

- **D-05:** Use **`OPFSPermutedVFS`** (the default production VFS) for all integration tests.
  Tests the real default path end-to-end. Headless Chromium supports OPFS without extra flags.

### Database Isolation

- **D-06:** Each test gets a **unique database name** (UUID or timestamp prefix) so tests never
  share database state even in parallel runs.
- **D-07:** **`afterEach` cleanup** — delete the OPFS entry via
  `navigator.storage.getDirectory()` → `removeEntry(name, { recursive: true })`. Belt-and-
  suspenders: no orphaned files even if a test throws.
- **D-08:** Provide a shared helper (e.g., `tests/browser/helpers.ts`) that wraps
  `createSQLiteClient` with a unique name and registers the `afterEach` cleanup automatically.
  Tests call the helper instead of calling `createSQLiteClient` directly.

### WorkerOrchestrator Lock (deferred from Phase 2 D2)

- **D-09:** Phase 2 D2 deferred `lock()` blocking behavior to this phase. Include a browser
  test verifying that a second `lock()` call blocks until the first `unlock()` is called —
  requires two concurrent async operations in the browser environment where `Atomics.wait`
  is valid inside Web Workers.

### Claude's Discretion

- Exact UUID/timestamp format for unique DB names
- Whether to use `crypto.randomUUID()` or `Date.now()` for uniqueness
- Rstest browser provider name (`playwright` vs `webdriverio`) in config
- How to import the built worker URL in browser test context (relative path vs URL import)
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Integration Tests — INT-01 through INT-10 (full list of what must pass)
- `.planning/ROADMAP.md` §Phase 3 — success criteria and plan breakdown

### Phase 2 context (deferred item)
- `.planning/phases/02-unit-tests/02-CONTEXT.md` §D2 — WorkerOrchestrator lock blocking behavior deferred to Phase 3

### Source files to read before planning
- `src/client.ts` — `createSQLiteClient`, `SQLiteDB`, `CreateSQLiteClientOptions`
- `src/types.ts` — `SQLiteVFS` union type (OPFSPermutedVFS is default)
- `src/worker.ts` — VFS configs, WASM module loading
- `rstest.config.ts` — existing Node-mode config (browser config must extend or parallel this)

No external specs — requirements are fully captured in decisions and REQUIREMENTS.md above.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rstest.config.ts` uses `withRslibConfig()` from `@rstest/adapter-rslib` — browser config should follow the same pattern
- `tests/unit/*.test.ts` — established `describe/it/expect` pattern from `@rstest/core`
- `src/client.ts` exports `createSQLiteClient(file, options?)` — the entry point for all integration tests

### Established Patterns
- Test runner: `@rstest/core` for imports (`describe`, `it`, `expect`, `beforeEach`, `afterEach`)
- No Playwright in `package.json` yet — `@rstest/browser` and the Playwright provider must be added as devDependencies
- `CreateSQLiteClientOptions.vfs` defaults to `OPFSPermutedVFS` — tests can omit `vfs` to use the default
- `AccessHandlePoolVFS` only supports `poolSize: 1` (enforced in `createSQLiteClient`) — not relevant for tests using default VFS

### Integration Points
- `createSQLiteClient(file, options)` — pool init, returns `SQLiteDB`
- `SQLiteDB.read / write / stream / one / close` — query methods under test
- `WorkerOrchestrator` — lock/unlock behavior testable in browser via `SharedArrayBuffer` + `Atomics`
- COOP/COEP headers must be active before `new SharedArrayBuffer()` is called — dev server config must serve them for ALL test files
</code_context>

<specifics>
## Specific Ideas

- User explicitly wants **Rstest browser mode** (not a standalone `playwright test` setup) because
  it handles headless browser installation as part of the test runner, keeping the toolchain unified.
- Use `OPFSPermutedVFS` specifically — tests the real production default, not a test-only shortcut.
</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.
</deferred>

---
*Phase: 03-integration-tests-browser*
*Context gathered: 2026-03-24*
